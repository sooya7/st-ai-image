/**
 * 旧版媒体库（IndexedDB，当年写失败时降级到 localStorage）。新生成的内容记在聊天元数据里（chat-store.js），
 * 这里只剩读取和删除，给升级前的老记录用。数据库名/版本/store 名与 v1 一致，老用户升级后媒体库不丢。
 */
import { DB_NAME, DB_VERSION, FALLBACK_HISTORY_KEY, STORE_NAME } from '../core/constants.js';
import { EVENTS, emit } from '../core/bus.js';
import { log, notify } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { sanitizeMediaSrc } from '../media/tags.js';

export const historyUrl = (item) => item?.type === 'audio' || item?.type === 'video' ? item.mediaUrl : item?.imageUrl;
const DISMISSED_KEY = 'st-ai-image_history_dismissed';

function entryKey(entry) {
    const item = normalizeHistoryEntry(entry);
    const url = historyUrl(item);
    if (!url) return '';
    // data:image 地址可能很长；只持久化短指纹，不占满 localStorage。
    let hash = 2166136261;
    for (let i = 0; i < url.length; i++) hash = Math.imul(hash ^ url.charCodeAt(i), 16777619) >>> 0;
    return `${item.type}:${hash.toString(36)}:${url.length}`;
}

function dismissedKeys() {
    try {
        const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    }
    catch { return []; }
}

function writeDismissed(keys) {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set(keys)].slice(-500))); }
    catch { /* 浏览器禁止写入时仍可删除当前记录 */ }
}

function dismissHistory(entries) {
    writeDismissed([...dismissedKeys(), ...entries.map(entryKey).filter(Boolean)]);
}

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** 事务包装：拿到 store 执行 run，等 oncomplete 才算成功。 */
async function withStore(mode, run) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        let result;
        const tx = db.transaction(STORE_NAME, mode);
        try { result = run(tx.objectStore(STORE_NAME), tx); }
        catch (e) { reject(e); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
    });
}

const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

export function normalizeHistoryEntry(entry, id = entry?.id) {
    const type = ['audio', 'video'].includes(entry?.type) ? entry.type : 'image';
    const mediaUrl = type === 'image' ? '' : sanitizeMediaSrc(entry?.mediaUrl);
    const item = {
        prompt: String(entry?.prompt ?? ''),
        imageUrl: type === 'image' ? sanitizeImageUrl(entry?.imageUrl) : '',
        type,
        ...(type === 'image' ? {} : { mediaUrl: mediaUrl.startsWith(`/user/files/st-ai-${type}-`) ? mediaUrl : '' }),
        timestamp: Number(entry?.timestamp || Date.now()),
        model: entry?.model,
        size: entry?.size,
    };
    if (id !== undefined && id !== null && id !== '') item.id = id;
    return item;
}

/** 按时间倒序合并去重（同一媒体地址只留最新的一条记录）。 */
export function mergeHistoryItems(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : [])
        .map((item) => normalizeHistoryEntry(item))
        .filter((item) => historyUrl(item))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .filter((item) => {
            const key = `${item.type}:${historyUrl(item)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

/* ---------- localStorage 降级通道 ---------- */

function getFallbackHistory() {
    if (typeof localStorage === 'undefined') return [];
    try { return mergeHistoryItems(JSON.parse(localStorage.getItem(FALLBACK_HISTORY_KEY) || '[]')); }
    catch { return []; }
}

/* ---------- 读 ---------- */

async function getIndexedDbHistory() {
    try {
        // await 会自动展开 withStore 透传出来的 request promise
        const list = (await withStore('readonly', (store) => request(store.getAll()))) || [];
        return list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } catch (e) {
        log.warn('读取 IndexedDB 媒体库失败:', e);
        return [];
    }
}

export async function getHistory() {
    return mergeHistoryItems([...(await getIndexedDbHistory()), ...getFallbackHistory()]);
}

export async function getHistoryItem(id) {
    const fallbackItem = getFallbackHistory().find((item) => String(item.id) === String(id));
    if (fallbackItem) return fallbackItem;
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) return null;
    try { return (await withStore('readonly', (store) => request(store.get(numericId)))) || null; }
    catch { return null; }
}

/* ---------- 删 ---------- */

export async function deleteHistoryItem(id) {
    try {
        const item = await getHistoryItem(id);
        if (!item) return false;
        if (String(id).startsWith('fallback-')) {
            localStorage.setItem(FALLBACK_HISTORY_KEY, JSON.stringify(getFallbackHistory().filter((entry) => String(entry.id) !== String(id))));
        } else {
            await withStore('readwrite', (store) => store.delete(Number(id)));
        }
        dismissHistory([item]);
        emit(EVENTS.galleryChanged);
        return true;
    } catch (e) {
        log.warn('删除媒体库条目失败:', e);
        return false;
    }
}


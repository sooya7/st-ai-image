/**
 * 媒体库索引。只存文件地址和说明，不存视频/音频本体；写失败时降级到 localStorage。
 * 数据库名/版本/store 名与 v1 一致，老用户升级后媒体库不丢。
 */
import { DB_NAME, DB_VERSION, FALLBACK_HISTORY_KEY, LIMITS, STORE_NAME } from '../core/constants.js';
import { EVENTS, emit } from '../core/bus.js';
import { log, notify } from '../core/notify.js';
import { normalizeGalleryImageUrl, sanitizeImageUrl } from '../core/text.js';
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

export function isHistoryDismissed(entry) {
    const key = entryKey(entry);
    return !!key && dismissedKeys().includes(key);
}

function dismissHistory(entries) {
    writeDismissed([...dismissedKeys(), ...entries.map(entryKey).filter(Boolean)]);
}

function restoreHistory(entry) {
    const key = entryKey(entry);
    if (key) writeDismissed(dismissedKeys().filter((item) => item !== key));
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

function saveFallbackHistoryEntry(entry) {
    if (typeof localStorage === 'undefined') return null;
    const id = entry?.id || `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = normalizeHistoryEntry(entry, id);
    if (!historyUrl(item)) return null;
    try {
        const items = mergeHistoryItems([item, ...getFallbackHistory()]).slice(0, LIMITS.maxHistoryItems);
        localStorage.setItem(FALLBACK_HISTORY_KEY, JSON.stringify(items));
        return item;
    } catch (e) {
        log.error('降级媒体库写入失败:', e);
        return null;
    }
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

/**
 * 按图片地址找记录。normalize 可替换，默认按酒馆图库地址归一化，
 * 这样同一张图的绝对/相对地址都能命中。
 */
export async function findHistoryByImageUrl(normalizedUrl, normalize = normalizeGalleryImageUrl) {
    const target = normalize(normalizedUrl);
    if (!target) return null;
    const history = await getHistory();
    return history.find((item) => item.type === 'image' && normalize(item.imageUrl) === target) || null;
}

export async function findHistoryByMediaUrl(mediaUrl, type) {
    const url = sanitizeMediaSrc(mediaUrl);
    if (!url || !['audio', 'video'].includes(type)) return null;
    return (await getHistory()).find((item) => item.type === type && item.mediaUrl === url) || null;
}

/* ---------- 写 ---------- */

async function addHistoryEntry(entry) {
    const item = normalizeHistoryEntry(entry, undefined);
    const id = await withStore('readwrite', (store) => request(store.add(item)));
    trimHistory();
    return { ...item, id };
}

/**
 * 只有 force 才真正落库：临时展示的图片不进媒体库，由用户点"存入媒体库"决定。
 * @returns 落库后的条目（含 id），失败且降级也失败时返回 null
 */
export async function saveToHistory(entry, { force = false } = {}) {
    if (!force) return null;
    if (!historyUrl(normalizeHistoryEntry(entry))) return null;
    try {
        const saved = await addHistoryEntry(entry);
        restoreHistory(entry);
        emit(EVENTS.galleryChanged);
        return saved;
    } catch (e) {
        log.error('媒体库保存失败，尝试降级:', e);
        const fallback = saveFallbackHistoryEntry(entry);
        if (fallback) {
            restoreHistory(entry);
            emit(EVENTS.galleryChanged);
            emit(EVENTS.storageDegraded);
        } else {
            // 两条通道都失败：手机端看不到 console，必须弹出真实原因
            notify.error(`媒体库保存失败: ${e?.message || e}`, 'AI 生图', { timeOut: 8000 });
        }
        return fallback;
    }
}

export async function trimHistory(retry = 0) {
    try {
        const items = await getHistory();
        if (items.length <= LIMITS.maxHistoryItems) return;
        const stale = items.slice(LIMITS.maxHistoryItems).filter((item) => Number.isInteger(Number(item.id)));
        await withStore('readwrite', (store) => {
            for (const item of stale) store.delete(Number(item.id));
        });
    } catch (e) {
        log.warn('裁剪媒体库失败:', e);
        if (retry < 1) setTimeout(() => trimHistory(retry + 1), 1000);
        else log.error('裁剪媒体库重试后仍失败，条数可能超限');
    }
}

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

/** 编辑提示词。记录不存在不算失败——正文那边的更新仍应继续。 */
export async function updateHistoryItemPrompt(id, prompt) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) return false;
    try {
        const updated = await withStore('readwrite', async (store) => {
            const item = await request(store.get(numericId));
            if (!item) return false;
            item.prompt = String(prompt ?? '');
            // store 有 keyPath，put 不能再显式传 key（会抛 DataError）
            await request(store.put(item));
            return true;
        });
        emit(EVENTS.galleryChanged);
        return updated;
    } catch (e) {
        log.warn('更新媒体库提示词失败:', e);
        return false;
    }
}

export async function clearHistory() {
    try {
        const entries = await getHistory();
        let dbCleared = false;
        try { await withStore('readwrite', (store) => store.clear()); dbCleared = true; }
        catch (e) { log.warn('清空 IndexedDB 媒体库失败，尝试清空降级记录:', e); }
        localStorage.removeItem(FALLBACK_HISTORY_KEY);
        if (!dbCleared && entries.some((item) => !String(item.id).startsWith('fallback-'))) return false;
        dismissHistory(entries);
        emit(EVENTS.galleryChanged);
        return true;
    } catch (e) {
        log.warn('清空媒体库失败:', e);
        return false;
    }
}

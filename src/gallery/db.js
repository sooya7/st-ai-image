/**
 * 图库存储。主通道 IndexedDB，写失败时降级到 localStorage 并让 UI 提示用户。
 * 数据库名/版本/store 名与 v1 一致，老用户升级后图库不丢。
 */
import { DB_NAME, DB_VERSION, FALLBACK_HISTORY_KEY, LIMITS, STORE_NAME } from '../core/constants.js';
import { EVENTS, emit } from '../core/bus.js';
import { log, notify } from '../core/notify.js';
import { normalizeGalleryImageUrl, sanitizeImageUrl } from '../core/text.js';

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
    const item = {
        prompt: String(entry?.prompt ?? ''),
        imageUrl: sanitizeImageUrl(entry?.imageUrl),
        timestamp: Number(entry?.timestamp || Date.now()),
        model: entry?.model,
        size: entry?.size,
    };
    if (id !== undefined && id !== null && id !== '') item.id = id;
    return item;
}

/** 按时间倒序合并去重（同一张图只留最新的一条记录）。 */
export function mergeHistoryItems(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : [])
        .map((item) => normalizeHistoryEntry(item))
        .filter((item) => item.imageUrl)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .filter((item) => {
            const key = item.imageUrl || `id:${item.id}`;
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
    if (!item.imageUrl) return null;
    try {
        const items = mergeHistoryItems([item, ...getFallbackHistory()]).slice(0, LIMITS.maxHistoryItems);
        localStorage.setItem(FALLBACK_HISTORY_KEY, JSON.stringify(items));
        return item;
    } catch (e) {
        log.error('降级图库写入失败:', e);
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
        log.warn('读取 IndexedDB 图库失败:', e);
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
    return history.find((item) => normalize(item.imageUrl) === target) || null;
}

/* ---------- 写 ---------- */

async function addHistoryEntry(entry) {
    const item = normalizeHistoryEntry(entry, undefined);
    const id = await withStore('readwrite', (store) => request(store.add(item)));
    trimHistory();
    return { ...item, id };
}

/**
 * 只有 force 才真正落库：临时展示的图片不进图库，由用户点"存入图库"决定。
 * @returns 落库后的条目（含 id），失败且降级也失败时返回 null
 */
export async function saveToHistory(entry, { force = false } = {}) {
    if (!force) return null;
    try {
        const saved = await addHistoryEntry(entry);
        emit(EVENTS.galleryChanged);
        return saved;
    } catch (e) {
        log.error('图库保存失败，尝试降级:', e);
        const fallback = saveFallbackHistoryEntry(entry);
        if (fallback) {
            emit(EVENTS.galleryChanged);
            emit(EVENTS.storageDegraded);
        } else {
            // 两条通道都失败：手机端看不到 console，必须弹出真实原因
            notify.error(`图库保存失败: ${e?.message || e}`, 'AI 生图', { timeOut: 8000 });
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
        log.warn('裁剪图库失败:', e);
        if (retry < 1) setTimeout(() => trimHistory(retry + 1), 1000);
        else log.error('裁剪图库重试后仍失败，条数可能超限');
    }
}

export async function deleteHistoryItem(id) {
    try {
        await withStore('readwrite', (store) => store.delete(Number.isInteger(Number(id)) ? Number(id) : id));
        emit(EVENTS.galleryChanged);
        return true;
    } catch (e) {
        log.warn('删除图库条目失败:', e);
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
        log.warn('更新图库提示词失败:', e);
        return false;
    }
}

export async function clearHistory() {
    try {
        await withStore('readwrite', (store) => store.clear());
        try { localStorage.removeItem(FALLBACK_HISTORY_KEY); } catch { /* 忽略 */ }
        emit(EVENTS.galleryChanged);
        return true;
    } catch (e) {
        log.warn('清空图库失败:', e);
        return false;
    }
}

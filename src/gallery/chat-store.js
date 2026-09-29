/** 当前聊天的媒体索引。文件本体仍存放在 SillyTavern 的 user/images、user/files。 */
import { EVENTS, emit } from '../core/bus.js';
import { log, notify } from '../core/notify.js';
import { normalizeGalleryImageUrl } from '../core/text.js';
import { sanitizeMediaSrc } from '../media/tags.js';
import { getContext, getCurrentChatId } from '../st/context.js';
import {
    getHistory as getLegacyHistory, getHistoryItem as getLegacyHistoryItem,
    deleteHistoryItem as deleteLegacyHistoryItem, historyUrl, mergeHistoryItems, normalizeHistoryEntry,
} from './db.js';

const KEY = 'st_ai_image_media_library';
const DELETED_KEY = 'st_ai_image_media_library_deleted';
const keyOf = (entry) => `${entry.type || 'image'}:${historyUrl(entry)}`;
function deletedKey(entry) {
    const key = keyOf(entry);
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
    return `${hash.toString(36)}:${key.length}`;
}
const metadata = () => getContext()?.chatMetadata;
const entries = () => Array.isArray(metadata()?.[KEY]) ? metadata()[KEY] : [];
const deleted = () => Array.isArray(metadata()?.[DELETED_KEY]) ? metadata()[DELETED_KEY] : [];
const newId = () => `media-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

function writableContext() {
    const context = getContext();
    if (!context?.chatMetadata || typeof context.saveMetadata !== 'function' || !getCurrentChatId()) {
        notify.error('请先打开聊天，媒体库才能保存到聊天文件');
        return null;
    }
    return context;
}

export async function getHistory() {
    return mergeHistoryItems(entries());
}

/** 旧版 IndexedDB ID 仍能在正文里解析；旧的全局列表单独显示为未归属记录。 */
export async function getHistoryItem(id) {
    return (await getHistory()).find((item) => String(item.id) === String(id)) || getLegacyHistoryItem(id);
}

export { getLegacyHistory };

export function isHistoryDismissed(entry) {
    const item = normalizeHistoryEntry(entry);
    return deleted().includes(deletedKey(item)) || deleted().includes(keyOf(item));
}

export async function findHistoryByImageUrl(url) {
    const normalized = normalizeGalleryImageUrl(url);
    return (await getHistory()).find((item) => item.type === 'image' && normalizeGalleryImageUrl(item.imageUrl) === normalized) || null;
}

export async function findHistoryByMediaUrl(url, type) {
    const safe = sanitizeMediaSrc(url);
    return (await getHistory()).find((item) => item.type === type && item.mediaUrl === safe) || null;
}

/** 生成或补救保存时写入；data/blob 不进入聊天文件，避免 base64 撑大聊天。 */
export async function saveToHistory(entry, { force = false } = {}) {
    if (!force) return null;
    const context = writableContext();
    if (!context) return null;
    const normalized = normalizeHistoryEntry(entry);
    const url = historyUrl(normalized);
    if (!url || /^(?:data:|blob:)/i.test(url)) return null;
    const chatId = getCurrentChatId();
    const existing = (await getHistory()).find((item) => keyOf(item) === keyOf(normalized));
    if (getCurrentChatId() !== chatId || metadata() !== context.chatMetadata) return null;
    if (existing) return existing;
    const item = normalizeHistoryEntry(normalized, entry?.id || newId());
    const prior = context.chatMetadata[KEY];
    const oldDeleted = context.chatMetadata[DELETED_KEY];
    context.chatMetadata[KEY] = [item, ...entries()];
    context.chatMetadata[DELETED_KEY] = deleted().filter((key) => key !== deletedKey(item) && key !== keyOf(item));
    try {
        await context.saveMetadata();
        if (getCurrentChatId() === chatId) emit(EVENTS.galleryChanged);
        return item;
    } catch (error) {
        if (getCurrentChatId() === chatId && metadata() === context.chatMetadata) {
            context.chatMetadata[KEY] = prior;
            context.chatMetadata[DELETED_KEY] = oldDeleted;
        }
        log.error('保存聊天媒体库失败:', error);
        notify.error('媒体库未能写入聊天文件');
        return null;
    }
}

/** 从现有聊天标签恢复索引，批量写入一次，避免每条都重存聊天。 */
export async function importChatEntries(candidates) {
    const context = writableContext();
    if (!context) return false;
    const chatId = getCurrentChatId();
    const current = await getHistory();
    if (getCurrentChatId() !== chatId || metadata() !== context.chatMetadata) return false;
    const seen = new Set(current.map(keyOf));
    const next = [];
    const dismissed = new Set(deleted());
    for (const candidate of candidates.slice().reverse()) {
        const item = normalizeHistoryEntry(candidate, candidate?.id || newId());
        const url = historyUrl(item);
        const key = keyOf(item);
        if (!url || /^(?:data:|blob:)/i.test(url) || seen.has(key) || dismissed.has(deletedKey(item)) || dismissed.has(key)) continue;
        seen.add(key);
        next.push(item);
    }
    if (!next.length) return false;
    context.chatMetadata[KEY] = mergeHistoryItems([...next, ...current]);
    await context.saveMetadata();
    if (getCurrentChatId() === chatId) emit(EVENTS.galleryChanged);
    return true;
}

/** 删除索引；物理文件与正文引用由调用方先处理。 */
export async function deleteHistoryItem(id) {
    const context = writableContext();
    if (!context) return false;
    const chatId = getCurrentChatId();
    const item = (await getHistory()).find((entry) => String(entry.id) === String(id));
    if (getCurrentChatId() !== chatId || metadata() !== context.chatMetadata) return false;
    if (!item) return deleteLegacyHistoryItem(id);
    context.chatMetadata[KEY] = entries().filter((entry) => String(entry.id) !== String(id));
    context.chatMetadata[DELETED_KEY] = [...new Set([...deleted(), deletedKey(item)])];
    await context.saveMetadata();
    if (getCurrentChatId() === chatId) emit(EVENTS.galleryChanged);
    return true;
}

export async function updateHistoryItemPrompt(id, prompt) {
    const context = writableContext();
    if (!context) return false;
    const item = entries().find((entry) => String(entry.id) === String(id));
    if (!item) return false;
    context.chatMetadata[KEY] = entries().map((entry) => String(entry.id) === String(id) ? { ...entry, prompt: String(prompt ?? '') } : entry);
    await context.saveMetadata();
    emit(EVENTS.galleryChanged);
    return true;
}

export async function clearHistory() {
    const context = writableContext();
    if (!context) return false;
    const keys = entries().map((entry) => deletedKey(normalizeHistoryEntry(entry)));
    context.chatMetadata[KEY] = [];
    context.chatMetadata[DELETED_KEY] = [...new Set([...deleted(), ...keys])];
    await context.saveMetadata();
    emit(EVENTS.galleryChanged);
    return true;
}

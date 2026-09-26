/** 与 SillyTavern 宿主的全部接触面都收在这里，方便版本变动时只改一处。 */
import { EXT_ID } from '../core/constants.js';
import { log } from '../core/notify.js';

export function getContext() {
    try { return globalThis.SillyTavern?.getContext?.() || null; }
    catch { return null; }
}

export function getChat() {
    return getContext()?.chat || null;
}

export function getMessage(messageId) {
    return Number.isInteger(messageId) ? getChat()?.[messageId] || null : null;
}

/** 取当前 swipe 的文本；没有 swipes 时退回 mes。 */
export function getMessageText(messageId) {
    const message = getMessage(messageId);
    if (!message) return '';
    const swipeId = Number(message.swipe_id ?? 0);
    if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === 'string') return message.swipes[swipeId];
    return typeof message.mes === 'string' ? message.mes : '';
}

/**
 * 用 transform 改写消息正文与当前 swipe，两者必须一起改：
 * 只改 mes 的话，切走再切回 swipe 会把改动整段丢掉。
 * @returns {boolean} 是否真的产生了变化
 */
export function rewriteMessageText(messageId, transform) {
    const message = getMessage(messageId);
    if (!message) return false;
    const current = String(message.mes ?? '');
    const next = transform(current);
    let changed = next !== current;
    if (changed) message.mes = next;

    if (Array.isArray(message.swipes)) {
        const swipeId = Number(message.swipe_id ?? 0);
        if (typeof message.swipes[swipeId] === 'string') {
            const nextSwipe = transform(message.swipes[swipeId]);
            if (nextSwipe !== message.swipes[swipeId]) {
                message.swipes[swipeId] = nextSwipe;
                changed = true;
            }
        }
    }
    return changed;
}

export function refreshMessageBlock(messageId) {
    const ctx = getContext();
    const message = getMessage(messageId);
    if (!ctx || !message) return false;
    try { ctx.updateMessageBlock?.(messageId, message); return true; }
    catch (e) { log.warn('updateMessageBlock 失败:', e); return false; }
}

export async function saveChat() {
    try { await getContext()?.saveChat?.(); return true; }
    catch (e) { log.warn('saveChat 失败:', e); return false; }
}

export function getRequestHeadersForJson() {
    const ctx = getContext();
    if (typeof ctx?.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    return { 'Content-Type': 'application/json' };
}

let csrfToken = null;

export async function getCsrfToken(force = false) {
    if (csrfToken && !force) return csrfToken;
    try {
        const res = await fetch('/csrf-token');
        if (res.ok) csrfToken = (await res.json()).token || '';
    } catch (e) {
        log.warn('获取 CSRF token 失败:', e);
    }
    return csrfToken || '';
}

export function invalidateCsrfToken() { csrfToken = null; }

export async function getRequestHeadersWithCsrf() {
    const headers = getRequestHeadersForJson();
    const token = await getCsrfToken();
    if (token) headers['x-csrf-token'] = token;
    return headers;
}

/** 上传到酒馆图库时用的文件夹：优先当前角色名。 */
export function getGalleryFolder() {
    const ctx = getContext();
    const character = Number.isInteger(ctx?.characterId) ? ctx.characters?.[ctx.characterId] : null;
    return character?.name || 'AI Image Generator';
}

/**
 * 注入/清除系统提示词。position 0=IN_PROMPT，depth 100 表示高优先级，role 0=SYSTEM。
 * 传空字符串即为清除。
 */
export function setExtensionPrompt(id, text) {
    const ctx = getContext();
    if (typeof ctx?.setExtensionPrompt !== 'function') return false;
    ctx.setExtensionPrompt(id || EXT_ID, String(text ?? ''), 0, 100, false, 0);
    return true;
}

/** 批量订阅 ST 事件；名字取不到就跳过，兼容老版本。 */
export function onStEvents(names, handler) {
    const ctx = getContext();
    const eventSource = ctx?.eventSource || globalThis.eventSource;
    const types = ctx?.event_types || globalThis.event_types || {};
    if (typeof eventSource?.on !== 'function') return 0;
    let bound = 0;
    for (const name of names) {
        const event = types[name];
        if (!event) continue;
        eventSource.on(event, handler);
        bound++;
    }
    return bound;
}

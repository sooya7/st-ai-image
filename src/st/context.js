/** 与 SillyTavern 宿主的全部接触面都收在这里，方便版本变动时只改一处。 */
import { EXT_ID } from '../core/constants.js';
import { log } from '../core/notify.js';
import { fetchWithTimeout } from '../core/net.js';

export function getContext() {
    try { return globalThis.SillyTavern?.getContext?.() || null; }
    catch { return null; }
}

export function getChat() {
    return getContext()?.chat || null;
}

/** 当前聊天的标识：异步结果回来时用它确认没有切到别的聊天。 */
export function getCurrentChatId() {
    const ctx = getContext();
    try { return String(ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? ''); }
    catch { return ''; }
}

/** 聊天文件名只在角色目录内唯一；群组和角色都纳入身份。 */
export function getChatIdentity() {
    const ctx = getContext();
    const group = ctx?.groupId;
    const owner = group !== undefined && group !== null && group !== ''
        ? ['group', String(group)]
        : ['character', String(ctx?.characters?.[ctx?.characterId]?.avatar ?? ctx?.characterId ?? '')];
    return JSON.stringify([...owner, getCurrentChatId()]);
}

export function captureMessageTarget(messageId) {
    const message = getMessage(messageId);
    return { identity: getChatIdentity(), chat: getChat(), message, messageId, swipeId: Number(message?.swipe_id ?? 0) };
}

export function isMessageTargetCurrent(target) {
    return Boolean(target?.message && target.identity === getChatIdentity()
        && target.chat === getChat() && target.message === getMessage(target.messageId)
        && target.swipeId === Number(target.message.swipe_id ?? 0));
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

/**
 * 按正文重画这条消息，再像 ST 编辑消息后那样发 MESSAGE_UPDATED。
 * updateMessageBlock 会整段替换 .mes_text 的 HTML，酒馆助手（JS-Slash-Runner）的前端界面、
 * 小白X 的渲染等都挂在这个事件上重建；不发的话，出图后这些渲染就没了，要刷新页面才回来。
 */
export function refreshMessageBlock(messageId) {
    const ctx = getContext();
    const message = getMessage(messageId);
    if (!ctx || !message) return false;
    try { ctx.updateMessageBlock?.(messageId, message); }
    catch (e) { log.warn('updateMessageBlock 失败:', e); return false; }
    emitMessageUpdated(messageId);
    return true;
}

function emitMessageUpdated(messageId) {
    const ctx = getContext();
    const eventSource = ctx?.eventSource || globalThis.eventSource;
    const name = (ctx?.event_types || globalThis.event_types || {}).MESSAGE_UPDATED;
    if (!name || typeof eventSource?.emit !== 'function') return;
    try {
        Promise.resolve(eventSource.emit(name, messageId)).catch((e) => log.warn('MESSAGE_UPDATED 监听出错:', e));
    } catch (e) { log.warn('发送 MESSAGE_UPDATED 失败:', e); }
}

export async function saveChat() {
    try {
        const save = getContext()?.saveChat;
        if (typeof save !== 'function') return false;
        return (await save()) !== false;
    }
    catch (e) { log.warn('saveChat 失败:', e); return false; }
}

/** 宿主可能吞掉保存错误，物理删除前必须读回磁盘正文确认。 */
export async function saveChatVerified({ metadataKeys = [] } = {}) {
    const ctx = getContext();
    const identity = getChatIdentity();
    const chat = ctx?.chat;
    const fileName = getCurrentChatId();
    const group = ctx?.groupId !== undefined && ctx?.groupId !== null && ctx?.groupId !== '';
    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar;
    if (!Array.isArray(chat) || !fileName || (!group && !avatar)) return false;
    const content = (message) => ({ mes: message?.mes, swipes: message?.swipes ?? null });
    const expected = JSON.stringify(chat.map(content));
    const selectedMetadata = (metadata) => metadataKeys.map((key) => metadata?.[key] ?? null);
    const expectedMetadata = JSON.stringify(selectedMetadata(ctx.chatMetadata));
    try {
        if (!(await saveChat()) || getChatIdentity() !== identity || getChat() !== chat) return false;
        const headers = await getRequestHeadersWithCsrf();
        if (getChatIdentity() !== identity || getChat() !== chat) return false;
        const response = await fetchWithTimeout(group ? '/api/chats/group/get' : '/api/chats/get', {
            method: 'POST', headers, timeout: 15000,
            body: JSON.stringify(group ? { id: fileName } : { avatar_url: avatar, file_name: fileName }),
        });
        if (!response.ok) return false;
        const stored = await response.json();
        if (!Array.isArray(stored)) return false;
        const messages = stored[0]?.chat_metadata !== undefined ? stored.slice(1) : stored;
        return getChatIdentity() === identity && getChat() === chat
            && JSON.stringify(chat.map(content)) === expected && JSON.stringify(messages.map(content)) === expected
            && JSON.stringify(selectedMetadata(getContext()?.chatMetadata)) === expectedMetadata
            && JSON.stringify(selectedMetadata(stored[0]?.chat_metadata)) === expectedMetadata;
    } catch (error) { log.warn('聊天保存读回确认失败:', error); return false; }
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
    // ST 的 getRequestHeaders 已带 X-CSRF-Token；再加一个小写键，fetch 会合并成 "t, t"，服务端校验必然失败。
    if (Object.keys(headers).some((key) => key.toLowerCase() === 'x-csrf-token')) return headers;
    const token = await getCsrfToken();
    if (token) headers['x-csrf-token'] = token;
    return headers;
}

/** 上传到酒馆图库时用的文件夹：优先当前角色名。 */
export function getGalleryFolder() {
    const ctx = getContext();
    // ST 里 characterId 是字符串（如 "0"），未选角色时为 undefined
    const id = ctx?.characterId === undefined || ctx?.characterId === null || ctx?.characterId === '' ? NaN : Number(ctx.characterId);
    const character = Number.isInteger(id) ? ctx.characters?.[id] : null;
    return character?.name || 'AI Image Generator';
}

/** 注入深度的合法范围；0 表示放在最后一条消息之后。 */
export const PROMPT_DEPTH_MAX = 50;

/** 把设置里的注入位置换成 ST 的参数：chat → IN_CHAT(1) 按深度插进聊天记录，top → IN_PROMPT(0) 放在系统提示词末尾。 */
export function extensionPromptPlacement({ position, depth } = {}) {
    if (position === 'top') return { position: 0, depth: 0 };
    const n = Math.round(Number(depth));
    return { position: 1, depth: Number.isFinite(n) ? Math.min(PROMPT_DEPTH_MAX, Math.max(0, n)) : 1 };
}

/**
 * 注入/清除系统提示词（role 0=SYSTEM）。传空字符串即为清除。
 * 默认插在聊天记录里离末尾 1 条消息的位置：放在开头的话，长对话和格式要求很重的角色卡会把它淹没，模型就不写标签了。
 */
export function setExtensionPrompt(id, text, placement = {}) {
    const ctx = getContext();
    if (typeof ctx?.setExtensionPrompt !== 'function') return false;
    const { position, depth } = extensionPromptPlacement(placement);
    ctx.setExtensionPrompt(id || EXT_ID, String(text ?? ''), position, depth, false, 0);
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

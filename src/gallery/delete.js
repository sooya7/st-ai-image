/** 删除当前聊天中的媒体引用，并在可确认是本扩展生成的文件时删除酒馆文件。 */
import { RE } from '../core/constants.js';
import { fetchWithTimeout } from '../core/net.js';
import { log } from '../core/notify.js';
import { normalizeGalleryImageUrl, parseInlineImageMarker, summarizeApiError } from '../core/text.js';
import { buildMediaTag, MEDIA_TAG_SOURCE, parseMediaTag, sanitizeMediaSrc } from '../media/tags.js';
import { getChat, getCurrentChatId, getRequestHeadersWithCsrf, invalidateCsrfToken, refreshMessageBlock, saveChat } from '../st/context.js';
import { deleteHistoryItem, getHistory, getHistoryItem } from './chat-store.js';

function ownedFile(entry) {
    if (entry?.type === 'audio' || entry?.type === 'video') {
        const src = sanitizeMediaSrc(entry.mediaUrl);
        return src.startsWith(`/user/files/st-ai-${entry.type}-`) ? { path: src, endpoint: '/api/files/delete' } : null;
    }
    const src = normalizeGalleryImageUrl(entry?.imageUrl);
    // 只允许删除本扩展上传的酒馆图片，绝不触及别人的图库文件或远程 URL。
    if (!String(entry?.imageUrl).startsWith('/user/images/') || !/^\/user\/images\/(?:[^/?#]+\/)*st-ai-image-\d+(?:-[a-z0-9]+)?\.(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(src)) return null;
    return { path: src, endpoint: '/api/images/delete' };
}

async function deleteServerFile(entry) {
    const file = ownedFile(entry);
    if (!file) return false;
    const post = async () => fetchWithTimeout(file.endpoint, {
        method: 'POST', headers: await getRequestHeadersWithCsrf(),
        body: JSON.stringify({ path: file.path }),
    });
    let response = await post();
    if (response.status === 403) { invalidateCsrfToken(); response = await post(); }
    if (response.status === 404) return true;
    if (!response.ok) throw new Error(`删除酒馆文件失败: ${summarizeApiError(await response.text())}`);
    return true;
}

function withoutMedia(text, entry) {
    let value = String(text ?? '');
    if (entry.type === 'audio' || entry.type === 'video') {
        const src = sanitizeMediaSrc(entry.mediaUrl);
        value = value.replace(new RegExp(MEDIA_TAG_SOURCE, 'gi'), (tag) => {
            const info = parseMediaTag(tag);
            return info?.kind === entry.type && info.src === src
                ? buildMediaTag(info.name, info.text, '', info) : tag;
        });
    } else {
        const url = normalizeGalleryImageUrl(entry.imageUrl);
        const replacement = `[image]${String(entry.prompt || '图片').replace(/\[\/?image\]/gi, '')}[/image]`;
        value = value.replace(new RegExp(RE.inlineMarker.source, 'g'), (marker) => {
            const info = parseInlineImageMarker(marker);
            return String(info.id) === String(entry.id) || (info.imageUrl && normalizeGalleryImageUrl(info.imageUrl) === url)
                ? replacement : marker;
        });
        value = value.replace(new RegExp(RE.markdownImage.source, 'g'), (markup, _alt, _title, quoted, unquoted) => {
            let raw = String(quoted ?? unquoted ?? '').trim();
            try { raw = decodeURI(raw); } catch { /* 保留原地址 */ }
            return normalizeGalleryImageUrl(raw) === url ? replacement : markup;
        });
    }
    return value;
}

function removeReferences(entry) {
    const changed = [];
    const chat = getChat() || [];
    for (let id = 0; id < chat.length; id++) {
        const message = chat[id];
        if (!message) continue;
        const before = { mes: message.mes, swipes: Array.isArray(message.swipes) ? [...message.swipes] : null };
        if (typeof message.mes === 'string') message.mes = withoutMedia(message.mes, entry);
        if (Array.isArray(message.swipes)) message.swipes = message.swipes.map((text) => typeof text === 'string' ? withoutMedia(text, entry) : text);
        if (message.mes !== before.mes || JSON.stringify(message.swipes ?? null) !== JSON.stringify(before.swipes)) {
            changed.push({ id, message, before });
            refreshMessageBlock(id);
        }
    }
    return changed;
}

function rollback(changed, chatId) {
    for (const { id, message, before } of changed) {
        message.mes = before.mes;
        if (before.swipes) message.swipes = before.swipes;
        if (getCurrentChatId() === chatId) refreshMessageBlock(id);
    }
}

/** 返回是否同时删除了物理文件。旧版/外部图片仅能移除索引与当前聊天引用。 */
export async function removeMediaEntry(id) {
    const item = await getHistoryItem(id);
    if (!item) return { removed: false, fileDeleted: false };
    if (!(await getHistory()).some((entry) => String(entry.id) === String(id))) {
        // 旧版全局记录不知道属于哪个聊天，安全起见只移除旧索引。
        return { removed: await deleteHistoryItem(id), fileDeleted: false };
    }
    const chatId = getCurrentChatId();
    const changed = removeReferences(item);
    if (changed.length && !(await saveChat())) {
        rollback(changed, chatId);
        throw new Error('聊天保存失败，未删除媒体文件');
    }
    if (getCurrentChatId() !== chatId) throw new Error('聊天已切换，请回到原聊天再删除');
    let fileDeleted = false;
    try { fileDeleted = await deleteServerFile(item); }
    catch (error) { log.error('删除媒体文件失败，索引保留以便重试:', error); throw error; }
    if (getCurrentChatId() !== chatId) throw new Error('聊天已切换；文件已删除，回到原聊天可清除记录');
    const removed = await deleteHistoryItem(id);
    return { removed, fileDeleted };
}

export { ownedFile, withoutMedia };

/**
 * 生成内容自动归入当前聊天媒体库；重新打开聊天时从正文引用补齐索引。
 */
import { fetchImageAsDataUrl, fetchWithTimeout } from '../core/net.js';
import { log } from '../core/notify.js';
import {
    extractMarkdownImages, isUserImagesUrl, normalizeGalleryImageUrl, parseInlineImageMarker,
    parseDataImageUrl, sanitizeImageUrl, summarizeApiError,
} from '../core/text.js';
import { RE } from '../core/constants.js';
import { getChat, getCurrentChatId, getGalleryFolder, getRequestHeadersWithCsrf, invalidateCsrfToken } from '../st/context.js';
import { MEDIA_TAG_SOURCE, parseMediaTag, sanitizeMediaSrc } from '../media/tags.js';
import { findHistoryByMediaUrl, getHistoryItem, importChatEntries, saveToHistory } from './chat-store.js';

/** 同一地址并发登记时复用同一个任务，避免重复入库。 */
const ensureTasks = new Map();
const chatSyncTasks = new Map();

/** 上传到酒馆图库，返回服务器地址；无法转成 data URL 时返回空字符串。 */
export async function uploadImageToStGallery(imageUrl) {
    let image = parseDataImageUrl(imageUrl);
    if (!image) image = parseDataImageUrl(await fetchImageAsDataUrl(sanitizeImageUrl(imageUrl)));
    if (!image) return '';

    const body = JSON.stringify({
        image: image.base64,
        format: image.format,
        ch_name: getGalleryFolder(),
        filename: `st-ai-image-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    });
    const post = async () => fetchWithTimeout('/api/images/upload', {
        method: 'POST',
        headers: await getRequestHeadersWithCsrf(),
        body,
    });

    let response = await post();
    if (response.status === 403) {
        invalidateCsrfToken(); // token 过期，取一次新的再试
        response = await post();
    }
    if (!response.ok) throw new Error(`酒馆图库保存失败: ${summarizeApiError(await response.text())}`);
    return sanitizeImageUrl((await response.json()).path);
}

/**
 * 保存一张生成的图：上传到酒馆图库，再把短地址记入当前聊天。
 */
export async function saveGeneratedImage(entry, { force = false, expectedChatId = getCurrentChatId() } = {}) {
    let imageUrl = sanitizeImageUrl(entry.imageUrl);
    if (!expectedChatId || getCurrentChatId() !== expectedChatId) return { saved: null, imageUrl, serverImageUrl: '' };
    let serverImageUrl = '';
    try {
        serverImageUrl = await uploadImageToStGallery(imageUrl);
    } catch (e) {
        log.warn('上传到酒馆图库失败，保留原地址:', e);
    }
    if (serverImageUrl) imageUrl = normalizeGalleryImageUrl(serverImageUrl);
    const saved = getCurrentChatId() === expectedChatId ? await saveToHistory({ ...entry, imageUrl }, { force }) : null;
    return { saved, imageUrl, serverImageUrl };
}

/** 生成后登记语音/视频地址，不把大文件塞进聊天文件。 */
export async function saveMediaToHistory(mediaUrl, kind, prompt = '') {
    const safeUrl = sanitizeMediaSrc(mediaUrl);
    if (!safeUrl || !['audio', 'video'].includes(kind) || !safeUrl.startsWith(`/user/files/st-ai-${kind}-`)) return null;
    const chatId = getCurrentChatId();
    const key = `${chatId}:${kind}:${safeUrl}`;
    if (ensureTasks.has(key)) return ensureTasks.get(key);
    const task = (async () => {
        const existing = await findHistoryByMediaUrl(safeUrl, kind);
        if (existing) return existing;
        if (getCurrentChatId() !== chatId) return null;
        return saveToHistory({ type: kind, mediaUrl: safeUrl, prompt, timestamp: Date.now() }, { force: true });
    })();
    ensureTasks.set(key, task);
    try { return await task; }
    finally { ensureTasks.delete(key); }
}

async function collectTextEntries(text, candidates) {
    for (const image of extractMarkdownImages(text)) {
        if (!isUserImagesUrl(image.imageUrl) || !/(?:^|\/)st-ai-image-\d+(?:-[a-z0-9]+)?\./i.test(image.imageUrl)) continue;
        candidates.push({ imageUrl: normalizeGalleryImageUrl(image.imageUrl), prompt: image.prompt });
    }
    for (const match of String(text ?? '').matchAll(new RegExp(RE.inlineMarker.source, 'g'))) {
        const info = parseInlineImageMarker(match[0]);
        const old = info.id && !info.imageUrl ? await getHistoryItem(info.id) : null;
        if (info.imageUrl || old?.imageUrl) candidates.push({ ...old, id: info.id || old?.id, imageUrl: info.imageUrl || old.imageUrl });
    }
    for (const match of String(text ?? '').matchAll(new RegExp(MEDIA_TAG_SOURCE, 'gi'))) {
        const info = parseMediaTag(match[0]);
        if (info?.src) candidates.push({ type: info.kind, mediaUrl: info.src, prompt: info.text });
    }
}

/** 扫已渲染的 DOM：覆盖那些不是 markdown 写法（比如 HTML img）的图片。 */
function renderedChatImages() {
    if (typeof document === 'undefined') return [];
    return [...document.querySelectorAll('#chat .mes_text img, #chat .mes img')]
        .map((img) => ({
            prompt: img.getAttribute('alt')
                || img.closest?.('.mes')?.querySelector?.('.name_text')?.textContent
                || 'AI Image',
            imageUrl: normalizeGalleryImageUrl(img.getAttribute('src') || img.currentSrc || img.src),
        }))
        .filter((image) => isUserImagesUrl(image.imageUrl) && /(?:^|\/)st-ai-image-\d+(?:-[a-z0-9]+)?\./i.test(image.imageUrl));
}

/**
 * 全量同步当前聊天。以聊天内容做 key 去重，
 * 同一份内容的并发调用（多个事件同时触发）只跑一次。
 */
export async function syncChatImagesToHistory() {
    const chat = getChat();
    if (!chat?.length) return false;
    const chatId = getCurrentChatId();

    const key = chatId;
    if (chatSyncTasks.has(key)) return chatSyncTasks.get(key);

    const task = (async () => {
        const candidates = [];
        for (const message of chat) {
            if (getCurrentChatId() !== chatId) return false;
            if (!message) continue;
            if (typeof message.mes === 'string') await collectTextEntries(message.mes, candidates);
            if (Array.isArray(message.swipes)) {
                for (const swipe of message.swipes) {
                    if (typeof swipe === 'string') await collectTextEntries(swipe, candidates);
                }
            }
        }
        if (getCurrentChatId() !== chatId) return false;
        candidates.push(...renderedChatImages());
        await importChatEntries(candidates);
        return true;
    })();

    chatSyncTasks.set(key, task);
    try { return await task; }
    finally { chatSyncTasks.delete(key); }
}

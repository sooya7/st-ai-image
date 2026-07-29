/**
 * 图库与聊天记录的双向同步：
 * - 生成的图先上传到酒馆自己的图库（拿到 /user/images/... 稳定地址），再入库；
 * - 聊天里已存在的图片（markdown 或已渲染的 img）补登记到图库，避免"图在楼里但图库没有"。
 */
import { EVENTS, emit } from '../core/bus.js';
import { fetchImageAsDataUrl, fetchWithTimeout } from '../core/net.js';
import { log } from '../core/notify.js';
import {
    extractMarkdownImages, isUserImagesUrl, normalizeGalleryImageUrl,
    parseDataImageUrl, sanitizeImageUrl, summarizeApiError,
} from '../core/text.js';
import { getChat, getGalleryFolder, getRequestHeadersWithCsrf, invalidateCsrfToken } from '../st/context.js';
import { findHistoryByImageUrl, saveToHistory } from './db.js';

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
        filename: `st-ai-image-${Date.now()}`,
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
 * 保存一张生成的图：先尽力上传到酒馆图库，再写本地图库。
 * 上传失败不阻断保存，只是地址仍是原始的（data: 或第三方直链）。
 */
export async function saveGeneratedImage(entry, { force = false } = {}) {
    let imageUrl = sanitizeImageUrl(entry.imageUrl);
    let serverImageUrl = '';
    try {
        serverImageUrl = await uploadImageToStGallery(imageUrl);
    } catch (e) {
        log.warn('上传到酒馆图库失败，保留原地址:', e);
    }
    if (serverImageUrl) imageUrl = normalizeGalleryImageUrl(serverImageUrl);
    const saved = await saveToHistory({ ...entry, imageUrl }, { force });
    return { saved, imageUrl, serverImageUrl };
}

/** 图库里没有这张图就补一条记录，有就直接返回。 */
export async function ensureHistoryEntryForImageUrl(imageUrl, defaults = {}) {
    const safeUrl = normalizeGalleryImageUrl(imageUrl);
    if (!safeUrl) return null;
    if (ensureTasks.has(safeUrl)) return ensureTasks.get(safeUrl);

    const task = (async () => {
        const existing = await findHistoryByImageUrl(safeUrl);
        if (existing) return existing;
        return saveToHistory({
            prompt: defaults.prompt || '',
            imageUrl: safeUrl,
            timestamp: defaults.timestamp || Date.now(),
            model: defaults.model,
            size: defaults.size,
        }, { force: true });
    })();

    ensureTasks.set(safeUrl, task);
    try { return await task; }
    finally { ensureTasks.delete(safeUrl); }
}

async function syncTextImages(text) {
    for (const image of extractMarkdownImages(text)) {
        if (!isUserImagesUrl(image.imageUrl)) continue;
        await ensureHistoryEntryForImageUrl(normalizeGalleryImageUrl(image.imageUrl), { prompt: image.prompt });
    }
}

/** 扫已渲染的 DOM：覆盖那些不是 markdown 写法（比如 HTML img）的图片。 */
export async function syncRenderedChatImages() {
    if (typeof document === 'undefined') return false;
    const images = [...document.querySelectorAll('#chat .mes_text img, #chat .mes img')]
        .map((img) => ({
            prompt: img.getAttribute('alt')
                || img.closest?.('.mes')?.querySelector?.('.name_text')?.textContent
                || 'AI Image',
            imageUrl: normalizeGalleryImageUrl(img.getAttribute('src') || img.currentSrc || img.src),
        }))
        .filter((image) => isUserImagesUrl(image.imageUrl));

    for (const image of images) {
        await ensureHistoryEntryForImageUrl(image.imageUrl, { prompt: image.prompt });
    }
    if (images.length) emit(EVENTS.galleryChanged);
    return images.length > 0;
}

/**
 * 全量同步当前聊天。以聊天内容做 key 去重，
 * 同一份内容的并发调用（多个事件同时触发）只跑一次。
 */
export async function syncChatImagesToHistory() {
    const chat = getChat();
    if (!chat?.length) return false;

    const key = chat.map((message) => `${message?.mes || ''}|${message?.swipe_id || 0}`).join('\n');
    if (chatSyncTasks.has(key)) return chatSyncTasks.get(key);

    const task = (async () => {
        for (const message of chat) {
            if (!message) continue;
            if (typeof message.mes === 'string') await syncTextImages(message.mes);
            if (Array.isArray(message.swipes)) {
                for (const swipe of message.swipes) {
                    if (typeof swipe === 'string') await syncTextImages(swipe);
                }
            }
        }
        await syncRenderedChatImages();
        emit(EVENTS.galleryChanged);
        return true;
    })();

    chatSyncTasks.set(key, task);
    try { return await task; }
    finally { chatSyncTasks.delete(key); }
}

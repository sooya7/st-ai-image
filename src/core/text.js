/**
 * 纯函数：转义、URL 白名单、标签/标记解析。
 * 这一层不碰 DOM、不碰存储，是唯一有单元测试的部分。
 */
import { LIMITS, RE, IMAGE_REQUEST_SOURCE } from './constants.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export const escapeAttr = escapeHtml;

/**
 * 图片地址白名单：只放过 data:image、blob:、http(s):。
 * 其它（javascript:、data:text/html 等）一律返回空字符串。
 */
export function sanitizeImageUrl(value) {
    const url = String(value ?? '').trim();
    if (!url) return '';
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-zA-Z0-9+/=\s]+$/i.test(url)) return url;
    if (/^blob:/i.test(url)) return url;
    try {
        const base = globalThis.location?.href || 'https://example.invalid/';
        const { protocol } = new URL(url, base);
        if (protocol === 'http:' || protocol === 'https:') return url;
    } catch { /* 非法 URL */ }
    return '';
}

export function ensureSafeImageUrl(value) {
    const safeUrl = sanitizeImageUrl(value);
    if (!safeUrl) throw new Error('API 返回了不安全或无法识别的图片地址');
    return safeUrl;
}

export function summarizeApiError(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > LIMITS.apiErrorSummary ? `${text.slice(0, LIMITS.apiErrorSummary)}...` : text;
}

export function isValidApiBaseUrl(url) {
    const trimmed = String(url ?? '').trim();
    if (!trimmed) return true; // 未配置时允许为空
    return RE.httpProtocol.test(trimmed);
}

export function parseDataImageUrl(value) {
    const match = String(value ?? '').trim().match(RE.dataImage);
    if (!match) return null;
    const subtype = match[1].toLowerCase();
    const format = subtype === 'jpeg' ? 'jpg' : subtype.split('+')[0];
    if (!/^(png|jpg|jpeg|webp|gif|bmp|avif)$/.test(format)) return null;
    return { format, base64: match[2].replace(/\s+/g, '') };
}

/** 酒馆图库地址统一成 /user/images/... 相对形式，便于跨设备/换域名后仍能匹配。 */
export function normalizeGalleryImageUrl(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) return '';
    try {
        const base = globalThis.location?.href || 'https://example.test/';
        const parsed = new URL(safeUrl, base);
        if (RE.userImages.test(decodeURI(parsed.pathname))) return decodeURI(parsed.pathname) + parsed.search + parsed.hash;
    } catch { /* 保持原样 */ }
    return safeUrl;
}

export function isUserImagesUrl(imageUrl) {
    return RE.userImages.test(normalizeGalleryImageUrl(imageUrl));
}

/** blob: 地址刷新后即失效，不能写进聊天记录。 */
export function getStableInlineImageUrl(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl || /^blob:/i.test(safeUrl)) return '';
    return safeUrl;
}

export function escapeMarkdownAlt(value) {
    return String(value ?? 'AI Image')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/\]/g, '\\]')
        .trim() || 'AI Image';
}

export function unescapeMarkdownAlt(value) {
    return String(value ?? '').replace(/\\([\]\\])/g, '$1').trim();
}

export function formatMarkdownImageUrl(value) {
    const safeUrl = sanitizeImageUrl(value);
    if (!safeUrl) return '';
    if (/^data:/i.test(safeUrl)) return safeUrl;
    return encodeURI(safeUrl).replace(/[()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function createMarkdownImageMarkup(imageUrl, prompt = '') {
    const url = formatMarkdownImageUrl(imageUrl);
    if (!url) return '';
    return `![${escapeMarkdownAlt(prompt || 'AI Image')}](${url})`;
}

export function extractMarkdownImages(text) {
    const re = new RegExp(RE.markdownImage.source, 'g');
    const images = [];
    let match;
    while ((match = re.exec(String(text ?? ''))) !== null) {
        let raw = String(match[3] ?? match[4] ?? '').trim();
        try { raw = decodeURI(raw); } catch { /* 保持原样 */ }
        const imageUrl = sanitizeImageUrl(raw);
        if (imageUrl) images.push({ prompt: unescapeMarkdownAlt(match[1]) || 'AI Image', imageUrl });
    }
    return images;
}

/**
 * 正文里的持久化标记。优先写 id（不占 AI 上下文）；
 * 没有 id 时退化成 markdown 图片，至少刷新后图还在。
 */
export function createInlineImageMarker(source) {
    const safeId = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_.:-]/g, '');
    if (source && typeof source === 'object') {
        const id = safeId(source.id);
        if (id) return `[st-ai-image id="${id}"]`;
        const url = sanitizeImageUrl(source.imageUrl);
        return url ? createMarkdownImageMarkup(url, source.prompt) : '';
    }
    const id = safeId(source);
    return id ? `[st-ai-image id="${id}"]` : '';
}

export function parseInlineImageMarker(marker) {
    const text = String(marker ?? '');
    const srcMatch = text.match(/\bsrc=(?:"([^"]*)"|'([^']*)'|([^\]\s]+))/);
    const idMatch = text.match(/\bid=(?:"([^"]*)"|'([^']*)'|([a-zA-Z0-9_.:-]+))/);
    const rawSrc = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '') : '';
    const rawId = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3] ?? '') : '';
    let imageUrl = '';
    if (rawSrc) {
        try { imageUrl = sanitizeImageUrl(decodeURIComponent(rawSrc)); }
        catch { imageUrl = sanitizeImageUrl(rawSrc); }
    }
    return { id: rawId.replace(/[^a-zA-Z0-9_.:-]/g, ''), imageUrl };
}

export function hasInlineImageMarker(text) {
    return new RegExp(RE.inlineMarker.source).test(String(text ?? ''));
}

/** 只把带 src 的旧标记转成 markdown；带 id 的标记要留着走图库渲染。 */
export function replaceInlineImageMarkersWithMarkdown(text) {
    const re = new RegExp(RE.inlineMarker.source, 'g');
    return String(text ?? '').replace(re, (marker) => {
        const info = parseInlineImageMarker(marker);
        return info.imageUrl ? createMarkdownImageMarkup(info.imageUrl) : marker;
    });
}

export function hasImageTag(text) {
    const value = String(text ?? '');
    if (!RE.imageTagQuick.test(value)) return false;
    return new RegExp(IMAGE_REQUEST_SOURCE, 'gi').test(value);
}

export function hasInlineRenderableTag(text) {
    return hasImageTag(text) || hasInlineImageMarker(text);
}

/**
 * 是否需要处理这段文本。已生成的图片（marker）永远要渲染，
 * 未生成的 [image] 标签只在开关打开时才处理。
 */
export function shouldProcessInlineText(text, settings) {
    const value = String(text ?? '');
    if (hasInlineImageMarker(value)) return true;
    if (!settings?.enabled || !settings?.autoDetect) return false;
    return hasImageTag(value);
}

export function getImageRequestPrompt(match) {
    if (!match) return '';
    return String(match[2] ?? match[4] ?? '').trim();
}

export function getPromptFromImageTagText(text) {
    return getImageRequestPrompt(new RegExp(IMAGE_REQUEST_SOURCE, 'i').exec(String(text ?? '')));
}

export function replaceFirstImageRequest(text, originalTag, markerSource) {
    const value = String(text ?? '');
    const marker = createInlineImageMarker(markerSource);
    if (!marker) return value;
    if (originalTag && value.includes(originalTag)) return value.replace(originalTag, marker);
    return value.replace(new RegExp(IMAGE_REQUEST_SOURCE, 'i'), marker);
}

/** 从楼层正文里剥掉标签/标记/图片，剩下的纯文字才适合当提示词。 */
export function stripGeneratedImageArtifacts(text) {
    return String(text ?? '')
        .replace(new RegExp(IMAGE_REQUEST_SOURCE, 'gi'), '$2$4')
        .replace(new RegExp(RE.inlineMarker.source, 'g'), '')
        .replace(new RegExp(RE.markdownImage.source, 'g'), '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

export function buildPromptFromFloorText(text) {
    const clean = stripGeneratedImageArtifacts(text);
    if (!clean) return '';
    return clean.length > LIMITS.maxPromptLength ? `${clean.slice(0, LIMITS.maxPromptLength)}...` : clean;
}

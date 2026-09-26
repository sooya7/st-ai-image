/**
 * 正文里的语音/视频标签（纯函数，不碰 DOM）。
 *
 *   [voice]台词[/voice]            → 待生成
 *   [voice src="/user/files/…"]台词[/voice] → 已生成，文件存在酒馆服务器
 *
 * 生成后只往标签里补 src，台词/描述原样保留：AI 上下文不变，刷新后也能重新渲染。
 */

const NAMES = { voice: 'audio', 语音: 'audio', 配音: 'audio', video: 'video', 视频: 'video' };
// 闭合标签用命名反向引用：这段会被拼进扫描器的大正则，写 \1 会指向别人的分组。
export const MEDIA_TAG_SOURCE = String.raw`\[\s*(?<mediaTag>voice|语音|配音|video|视频)(?:\s+src\s*=\s*"([^"\]]*)")?\s*\]([\s\S]+?)\[\s*\/\s*\k<mediaTag>\s*\]`;
const QUICK = /\[\s*\/\s*(?:voice|语音|配音|video|视频)\s*\]/i;

/** 只渲染本扩展自己写进去的文件，AI 编造的地址或外链一律不当媒体加载。 */
const SAFE_SRC = /^\/user\/files\/st-ai-(?:audio|video)-[A-Za-z0-9-]+\.(?:mp3|wav|ogg|opus|m4a|aac|webm|mp4|mov)$/i;

export function sanitizeMediaSrc(value) {
    let src = String(value ?? '').trim();
    if (src && !src.startsWith('/')) src = `/${src}`;
    return SAFE_SRC.test(src) ? src : '';
}

export function hasMediaTag(text) {
    const value = String(text ?? '');
    return QUICK.test(value) && new RegExp(MEDIA_TAG_SOURCE, 'i').test(value);
}

/** 解析一段完整标签文本；不是媒体标签返回 null。 */
export function parseMediaTag(tagText) {
    const match = new RegExp(`^${MEDIA_TAG_SOURCE}$`, 'i').exec(String(tagText ?? '').trim());
    if (!match) return null;
    const name = match[1];
    return {
        name,
        kind: NAMES[name.toLowerCase()] || NAMES[name],
        rawSrc: match[2] || '',
        src: sanitizeMediaSrc(match[2]),
        text: match[3].trim(),
    };
}

export function buildMediaTag(name, text, src = '') {
    const safe = sanitizeMediaSrc(src);
    return `[${name}${safe ? ` src="${safe}"` : ''}]${text}[/${name}]`;
}

/** 渲染后的文字会丢掉 markdown 符号，比较时只看字母和数字。 */
export const normalizeMediaText = (text) => String(text ?? '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/**
 * 在原始消息文本里找到 DOM 上第 ordinal 个「同类型 + 同文字」标签的原文和位置。
 * 渲染后的文字会丢 markdown 符号，所以按归一化文字比较；同样的标签出现多次时靠序号区分。
 * 找不到返回 null，绝不猜。
 */
export function locateMediaTag(rawText, { kind, text = '', ordinal = 0 } = {}) {
    const value = String(rawText ?? '');
    const wanted = normalizeMediaText(text);
    const re = new RegExp(MEDIA_TAG_SOURCE, 'gi');
    let seen = 0;
    let match;
    while ((match = re.exec(value)) !== null) {
        const info = parseMediaTag(match[0]);
        if (info?.kind !== kind || normalizeMediaText(info.text) !== wanted) continue;
        if (seen++ === ordinal) return { tag: match[0], index: match.index, info };
    }
    return null;
}

/** 按位置替换定位到的那一处（同样的标签可能出现多次，不能按字符串替换第一处）。 */
export function replaceMediaTag(rawText, located, nextTag) {
    const value = String(rawText ?? '');
    if (!located || value.slice(located.index, located.index + located.tag.length) !== located.tag) return value;
    return value.slice(0, located.index) + nextTag + value.slice(located.index + located.tag.length);
}

const EXTENSIONS = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

/** 文件名只用字母数字和连字符：酒馆只收 [A-Za-z0-9_.-]，下划线还会被 markdown 当斜体。 */
export function mediaFileName(kind, mimeType, now = Date.now(), random = Math.random) {
    const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
    const extension = EXTENSIONS[type] || (kind === 'video' ? 'mp4' : 'mp3');
    const suffix = Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
    return `st-ai-${kind === 'video' ? 'video' : 'audio'}-${now}-${suffix}.${extension}`;
}

/** 断线续查用的任务键：同一条消息里同类型同文字的标签视为同一个任务。 */
export function mediaJobKey(kind, text) {
    let hash = 5381;
    for (const ch of normalizeMediaText(text)) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
    return `${kind}-${hash.toString(36)}`;
}

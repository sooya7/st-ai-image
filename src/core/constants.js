import { DEFAULT_SYSTEM_PROMPT } from './default-prompt.js';

/** 扩展标识。所有存储键都以它为前缀，与 v1 保持一致以兼容旧数据。 */
export const EXT_ID = 'st-ai-image';
export const LOG_TAG = `[${EXT_ID}]`;

/** 存储键（与 v1 一致，勿改） */
export const DB_NAME = 'st_ai_image_db';
export const DB_VERSION = 1;
export const STORE_NAME = 'history';
export const FALLBACK_HISTORY_KEY = `${EXT_ID}_history_fallback`;
export const PRESET_KEY = `${EXT_ID}_presets`;
export const LEGACY_SETTINGS_KEY = `${EXT_ID}_settings`;
export const LEGACY_HISTORY_KEY = 'st_ai_image_history';

/** 数值参数 */
export const LIMITS = {
    maxHistoryItems: 200,       // 图库最多保留条数
    fetchTimeoutMs: 60_000,     // 普通请求超时
    imageGenTimeoutMs: 120_000, // 生图请求默认超时（Imagen 等较慢）
    scanIntervalMs: 3_000,      // 内联轮询扫描间隔
    scanDurationMs: 30_000,     // 内联轮询持续时长
    scanDebounceMs: 150,        // 扫描防抖
    maxPromptLength: 1_200,     // 楼层提示词截断长度
    apiErrorSummary: 340,       // 错误摘要长度
    taskMaxAgeMs: 300_000,      // 内联任务过期时间
    timeoutRangeSec: [30, 300], // 设置面板允许的超时秒数区间
};

/** 生图标签：[image]...[/image] / <图片>...</图片> 等 */
export const TAG_NAMES = String.raw`image|图片|图像|画图|生图`;
export const IMAGE_REQUEST_SOURCE = String.raw`\[\s*(${TAG_NAMES})\s*\]([\s\S]+?)\[\s*\/\s*\1\s*\]|<\s*(${TAG_NAMES})\s*>([\s\S]+?)<\s*\/\s*\3\s*>`;
export const RE = {
    imageTagAll: new RegExp(IMAGE_REQUEST_SOURCE, 'gi'),
    imageTagFirst: new RegExp(IMAGE_REQUEST_SOURCE, 'i'),
    /** 廉价预筛，避免对每条消息跑完整正则 */
    imageTagQuick: /\[\s*\/?\s*(?:image|图片|图像|画图|生图)\s*\]|<\s*\/?\s*(?:image|图片|图像|画图|生图)\s*>/i,
    inlineMarker: /\[st-ai-image\b[^\]]*\]/g,
    /** alt 里的 \] 是我们自己转义写进去的，解析时要能吃回来 */
    markdownImage: /!\[((?:\\.|[^\]\\])*)\]\((<([^>]+)>|([^)]+))\)/g,
    httpProtocol: /^https?:\/\//i,
    dataImage: /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i,
    userImages: /^\/user\/images\//i,
};

/** 默认设置（字段与 v1 完全一致） */
export const DEFAULT_SETTINGS = {
    enabled: true,
    autoDetect: true,
    apiBase: '',
    apiKey: '',
    model: 'ai-image-2',
    size: '1024x1024',
    quality: 'auto',
    extraPrompt: '',
    negativePrompt: '',
    autoInjectPrompt: true,
    imageTimeout: LIMITS.imageGenTimeoutMs,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

export { DEFAULT_SYSTEM_PROMPT };

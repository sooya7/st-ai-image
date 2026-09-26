/** toastr / console 的薄封装：在无 toastr 的环境（测试、旧版 ST）里静默降级。 */
import { LOG_TAG } from './constants.js';

const toast = (level, message, title, options) => {
    const t = globalThis.toastr;
    if (typeof t?.[level] === 'function') t[level](String(message ?? ''), title, options);
    else console.log(`${LOG_TAG} ${level}: ${message}`);
};

export const notify = {
    success: (msg, title = 'AI 生图', options) => toast('success', msg, title, options),
    info: (msg, title = 'AI 生图', options) => toast('info', msg, title, options),
    warn: (msg, title = 'AI 生图', options) => toast('warning', msg, title, options),
    error: (msg, title = 'AI 生图', options) => toast('error', msg, title, options),
};

export const log = {
    info: (...args) => console.log(LOG_TAG, ...args),
    warn: (...args) => console.warn(LOG_TAG, ...args),
    error: (...args) => console.error(LOG_TAG, ...args),
};

/** 统一的错误文案提取：Error / 字符串 / 未知对象都能得到可读文本。 */
export const errMsg = (e, fallback = '未知错误') => String(e?.message || e || fallback);

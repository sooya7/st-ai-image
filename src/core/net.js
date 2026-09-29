/**
 * 网络层。两条通道：
 * - fetch：默认通道，带超时与外部 signal 联动。
 * - XHR：iOS WebView 的 ATS 会拦掉 fetch 发往 http:// 外部地址的请求，XHR 走另一套网络栈能过。
 */
import { LIMITS, RE } from './constants.js';

export async function fetchWithTimeout(url, options = {}) {
    const { timeout = LIMITS.fetchTimeoutMs, signal, ...rest } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeout);
    const abort = () => controller.abort(signal.reason);
    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', abort, { once: true });
    }
    try {
        const response = await fetch(url, { ...rest, signal: controller.signal });
        // 调用方会读取整个 JSON/Blob。先读完副本，既保留原 Response 的
        // URL/头/正文接口，也让截止时间和取消覆盖响应体，而不只覆盖响应头。
        if (response.body) {
            const reader = response.clone().body.getReader();
            try {
                while (!(await reader.read()).done) controller.signal.throwIfAborted();
            } finally { reader.releaseLock(); }
        }
        controller.signal.throwIfAborted();
        return response;
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

const parseHeaders = (raw) => {
    const headers = new Headers();
    for (const line of String(raw ?? '').trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(': ');
        if (idx > 0) {
            try { headers.set(line.slice(0, idx).trim(), line.slice(idx + 2).trim()); } catch { /* 非法头忽略 */ }
        }
    }
    return headers;
};

/** 用 XHR 发请求并包装成 Response，调用方无需区分通道。 */
export function xhrRequest(url, options = {}) {
    const { method = 'GET', headers = {}, body, timeout = LIMITS.fetchTimeoutMs, signal } = options;
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = timeout;
        for (const [k, v] of Object.entries(headers)) {
            try { xhr.setRequestHeader(k, v); } catch { /* 忽略受限头 */ }
        }
        const abort = () => xhr.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const done = () => signal?.removeEventListener('abort', abort);

        xhr.onload = () => {
            done();
            resolve(new Response([204, 205, 304].includes(xhr.status) ? null : xhr.response, {
                status: xhr.status || 500,
                statusText: xhr.statusText || '',
                headers: parseHeaders(xhr.getAllResponseHeaders()),
            }));
        };
        xhr.onerror = () => { done(); reject(new Error('请求失败')); };
        xhr.ontimeout = () => { done(); reject(new Error('请求超时')); };
        xhr.onabort = () => {
            done();
            const err = new Error(signal?.reason?.message || '请求已取消');
            err.name = 'AbortError';
            reject(err);
        };
        xhr.send(body ?? null);
    });
}

/** 仅「http:// + 非本机」需要 XHR 兜底；https 与本机地址 fetch 正常。 */
export function needsXhrFallback(url) {
    try {
        if (!/^http:\/\//i.test(String(url))) return false;
        const { hostname } = new URL(url);
        return hostname !== 'localhost' && hostname !== '127.0.0.1';
    } catch { return false; }
}

/** 统一请求入口。 */
export function apiFetch(url, options = {}) {
    if (typeof XMLHttpRequest === 'function' && needsXhrFallback(url)) return xhrRequest(url, options);
    return fetchWithTimeout(url, options);
}

export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/** 把远程图片抓成 data URL（上传到酒馆图库前用）。 */
export async function fetchImageAsDataUrl(imageUrl) {
    if (!RE.httpProtocol.test(String(imageUrl ?? ''))) return '';
    const response = await apiFetch(imageUrl);
    if (!response.ok) throw new Error(`图片下载失败: ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('远程地址不是图片');
    return await blobToDataUrl(blob);
}

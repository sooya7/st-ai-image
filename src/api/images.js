/**
 * 生图 API 客户端。中转站的响应格式五花八门，所以：
 * - 提取图片时把见过的所有形状都试一遍；
 * - 请求时按模型猜最可能的端点顺序，逐个降级重试。
 */
import { LIMITS } from '../core/constants.js';
import { apiFetch } from '../core/net.js';
import { log } from '../core/notify.js';
import { ensureSafeImageUrl, summarizeApiError } from '../core/text.js';
import { getSettings } from '../settings.js';

const pick = (img) => {
    if (!img) return null;
    if (typeof img === 'string') return img;
    if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
    if (img.url) return img.url;
    return null;
};

const fromParts = (parts) => {
    for (const part of parts || []) {
        if (part?.inlineData?.data) return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
    }
    return null;
};

const fromWrapper = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return pick(value[0]);
    return pick(value);
};

/** /v1/images/generations 及各类中转变体。 */
export function extractImageFromResponse(data) {
    if (!data) return null;
    if (Array.isArray(data.data) && data.data.length) { const r = pick(data.data[0]); if (r) return r; }
    if (Array.isArray(data) && data.length) { const r = pick(data[0]); if (r) return r; }
    if (Array.isArray(data.images) && data.images.length) { const r = pick(data.images[0]); if (r) return r; }
    if (data.b64_json) return `data:image/png;base64,${data.b64_json}`;
    if (data.url) return data.url;
    return fromWrapper(data.result) || fromWrapper(data.output) || fromParts(data.candidates?.[0]?.content?.parts);
}

/** /v1/chat/completions（Gemini 生图走这条）。 */
export function extractImageFromChatResponse(data) {
    const msg = data?.choices?.[0]?.message;
    if (Array.isArray(msg?.images) && msg.images.length) { const r = pick(msg.images[0]); if (r) return r; }

    const content = msg?.content;
    if (typeof content === 'string') {
        const md = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^\s)]+)\)/);
        if (md) return md[1];
        const dataUrl = content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
        if (dataUrl) return dataUrl[1];
        const url = content.match(/(https?:\/\/\S+\.(?:png|jpe?g|webp|gif|bmp))/i);
        if (url) return url[1];
    }
    if (Array.isArray(content)) {
        for (const part of content) {
            if (part?.type === 'image_url' && part.image_url?.url) return part.image_url.url;
            if (part?.type === 'image' && part.source?.data) return `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`;
            if (part?.inlineData?.data) return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
        }
    }
    return fromParts(data?.candidates?.[0]?.content?.parts) || extractImageFromResponse(data);
}

export const extractImage = (data) => extractImageFromResponse(data) || extractImageFromChatResponse(data);

/** 去掉尾部斜杠与 /v1，后面统一自己拼 /v1/...。 */
export function normalizeApiBase(apiBase) {
    let base = String(apiBase ?? '').trim().replace(/\/+$/, '');
    if (base.endsWith('/v1')) base = base.slice(0, -3);
    return base;
}

const statusMessage = (status) => {
    if (status === 404) return '模型不存在或 API 地址错误';
    if (status === 401 || status === 403) return 'API Key 无效或无权限';
    if (status === 429) return 'API 请求频率超限，请稍后重试';
    if (status >= 500) return 'API 服务器错误';
    return `HTTP ${status}`;
};

const isNetworkError = (e) => /Failed to fetch|Network|请求超时|请求失败/i.test(String(e?.message ?? ''));

/**
 * 生成一张图，返回图片地址（data: 或 http(s):）。
 * @param {string} prompt
 * @param {{signal?: AbortSignal, onProgress?: (p: {attempt: number, total: number, method: string, errors: number}) => void}} options
 */
export async function callImageAPI(prompt, { signal, onProgress } = {}) {
    const s = await getSettings();
    const base = normalizeApiBase(s.apiBase);
    const extra = String(s.extraPrompt || '').trim();
    const fullPrompt = extra ? `${extra}, ${prompt}` : prompt;
    const negative = String(s.negativePrompt || '').trim();

    if (s.imageProvider && s.imageProvider !== 'auto') {
        const { generateMedia } = await import('../media/client.js');
        const result = await generateMedia('image', {
            provider: s.imageProvider, base: s.apiBase, key: s.apiKey, model: s.model,
            size: s.size, extra: s.imageParams || '{}', timeout: s.imageTimeout,
        }, negative ? `${fullPrompt}\n\n避免出现：${negative}` : fullPrompt, {
            signal, onProgress: () => onProgress?.({ attempt: 1, total: 1, method: s.imageProvider, errors: 0 }),
        });
        return result.url;
    }

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` };
    const timeout = Number(s.imageTimeout) || LIMITS.imageGenTimeoutMs;

    const imageBody = { model: s.model, prompt: fullPrompt, n: 1, size: s.size };
    if (s.quality && s.quality !== 'auto') imageBody.quality = s.quality;
    if (negative) imageBody.negative_prompt = negative;

    const chatBody = { model: s.model, stream: false, messages: [{ role: 'user', content: negative ? `${fullPrompt}\n\n(避免出现: ${negative})` : fullPrompt }] };
    const chatModalitiesBody = { ...chatBody, modalities: ['text', 'image'] };

    // Gemini 只在 chat 端点出图，其它模型优先标准生图端点
    const order = /gemini/i.test(String(s.model || ''))
        ? ['chat_modalities', 'images_generations', 'chat_plain']
        : ['images_generations', 'chat_modalities', 'chat_plain'];
    const errors = [];

    for (let i = 0; i < order.length; i++) {
        const method = order[i];
        onProgress?.({ attempt: i + 1, total: order.length, method, errors: errors.length });
        try {
            const isImages = method === 'images_generations';
            const url = isImages ? `${base}/v1/images/generations` : `${base}/v1/chat/completions`;
            const body = isImages ? imageBody : (method === 'chat_modalities' ? chatModalitiesBody : chatBody);
            const resp = await apiFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, timeout });

            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                const message = `${statusMessage(resp.status)}: ${summarizeApiError(text)}`;
                // Only an explicitly unsupported endpoint may fall back. Unknown execution state
                // (timeout, network error, 5xx or a successful but unrecognized response) must not resubmit.
                if ([404, 405, 501].includes(resp.status)) { errors.push(message); continue; }
                throw new Error(message);
            }
            const data = await resp.json();
            const img = extractImage(data);
            if (img) return ensureSafeImageUrl(img);
            throw new Error('API 返回成功但未找到图片；请检查服务端记录，未自动重复提交');
        } catch (e) {
            if (e?.name === 'AbortError') throw e; // 用户主动取消
            throw new Error(isNetworkError(e) ? '网络请求失败，执行状态未知；请检查服务端记录，未自动重复提交' : String(e?.message || e));
        }
    }
    throw new Error(`无法生成图片。${errors[0] || '请检查 API 配置和模型名称'}`);
}

/** 拉取模型列表（OpenAI 兼容 /v1/models）。 */
export async function fetchModelList() {
    const s = await getSettings();
    if (!s.apiKey) throw new Error('请先填写 API Key');
    if (!s.apiBase) throw new Error('请先填写 API Base URL');

    if (['fal', 'replicate'].includes(s.imageProvider)) throw new Error('此服务请从模型页面复制模型路径，不使用 OpenAI 模型列表');
    if (s.imageProvider === 'gemini') {
        const { apiRoot } = await import('../media/providers.js');
        const { requestData } = await import('../media/client.js');
        const data = await requestData(`${apiRoot(s.apiBase, 'gemini')}/models?pageSize=100`, { headers: { 'x-goog-api-key': s.apiKey } });
        return (data.models || []).map((model) => ({ id: model.name.replace(/^models\//, ''), name: model.displayName || model.name }));
    }

    const resp = await apiFetch(`${normalizeApiBase(s.apiBase)}/v1/models`, {
        headers: { Authorization: `Bearer ${s.apiKey}` },
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`${statusMessage(resp.status)}: ${summarizeApiError(text)}`);
    }
    const data = await resp.json();
    return (data.data || data.models || [])
        .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id, name: m.id }))
        .filter((m) => m.id);
}

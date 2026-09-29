/**
 * 生图 API 客户端。中转站的响应格式五花八门，所以：
 * - 提取图片时把见过的所有形状都试一遍；
 * - 请求时按模型猜最可能的端点顺序，逐个降级重试。
 */
import { LIMITS } from '../core/constants.js';
import { apiFetch } from '../core/net.js';
import { log } from '../core/notify.js';
import { ensureSafeImageUrl, summarizeApiError } from '../core/text.js';
import { needsKey } from '../media/keys.js';
import { applyImagePromptPreset, readWorkflowLibrary } from '../core/library.js';
import { getSettings } from '../settings.js';

const pick = (img) => {
    if (!img) return null;
    if (typeof img === 'string') return img;
    if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
    if (img.url) return img.url;
    if (img.image_url?.url) return img.image_url.url; // OpenRouter：message.images[].image_url.url
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
    // 只在 NovelAI / ComfyUI / SD WebUI 使用各自的画师串，其他接口保留原始描述。
    const { prompt: fullPrompt, negative } = applyImagePromptPreset(prompt, s);

    if (s.imageProvider === 'comfyui' || s.imageProvider === 'sdwebui') {
        const { generateMedia } = await import('../media/client.js');
        const result = await generateMedia('image', {
            provider: s.imageProvider, base: s.apiBase, model: s.model, size: s.size, extra: s.imageParams || '{}',
            negative, workflow: activeWorkflow(s), auth: s.sdAuth, viaTavern: s.selfHostedViaSt !== false, timeout: s.imageTimeout,
        }, fullPrompt, { signal, onProgress: () => onProgress?.({ attempt: 1, total: 1, method: s.imageProvider, errors: 0 }) });
        return result.url;
    }

    if (s.imageProvider === 'novelai') {
        const [{ generateNovelAI }, { extraParams }] = await Promise.all([import('./novelai.js'), import('../media/providers.js')]);
        onProgress?.({ attempt: 1, total: 1, method: 'novelai', errors: 0 });
        return generateNovelAI({
            base: s.apiBase, key: s.apiKey, model: s.model, size: s.size, extra: extraParams(s.imageParams || '{}'), timeout: Number(s.imageTimeout) || LIMITS.imageGenTimeoutMs,
        }, fullPrompt, negative, { signal });
    }

    // 原生接口的各家（vendors.js）：负面提示词单独给，不拼进描述
    if (VENDOR_IMAGE.has(s.imageProvider)) {
        const { generateMedia } = await import('../media/client.js');
        const result = await generateMedia('image', {
            provider: s.imageProvider, base: s.apiBase, key: s.apiKey, model: s.model, size: s.size, extra: s.imageParams || '{}', negative, timeout: s.imageTimeout,
        }, fullPrompt, { signal, onProgress: (text) => onProgress?.({ attempt: 1, total: 1, method: `${s.imageProvider} ${text || ''}`.trim(), errors: 0 }) });
        return result.url;
    }

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

    const headers = { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) };
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

/** 走 vendors.js 原生适配器的生图服务。 */
const VENDOR_IMAGE = new Set(['minimax', 'dashscope', 'stability', 'pollinations', 'horde']);

/** 没有「列模型」接口的服务给一份常用模型；Pollinations、AI Horde 有公开列表就现拉。 */
const STATIC_MODELS = {
    minimax: ['image-01', 'image-01-live'],
    dashscope: ['wan2.2-t2i-flash', 'wan2.2-t2i-plus', 'wan2.5-t2i-preview', 'qwen-image', 'qwen-image-plus', 'qwen-image-max'],
    stability: ['core', 'ultra', 'sd3.5-large', 'sd3.5-large-turbo', 'sd3.5-medium'],
};

const activeWorkflow = (s) => {
    const lib = readWorkflowLibrary(s.comfyWorkflows, s.comfyWorkflowId, s.comfyWorkflow);
    return lib.items[lib.active];
};

/** 图片接口缺 Key：自建服务和本机/局域网地址允许留空。 */
export function imageKeyMissing(s) {
    return !String(s?.apiKey || '').trim() && needsKey(s?.imageProvider, s?.apiBase || '');
}

/** 拉取模型列表（OpenAI 兼容 /v1/models；自建服务走酒馆的 /api/sd/models、/api/sd/comfy/models；NovelAI 用内置列表）。 */
export async function fetchModelList() {
    const s = await getSettings();
    if (s.imageProvider === 'comfyui' || s.imageProvider === 'sdwebui') {
        const { serviceRoot } = await import('../media/selfhosted.js');
        const { getRequestHeadersWithCsrf } = await import('../st/context.js');
        const url = serviceRoot(s.apiBase, s.imageProvider);
        const path = s.imageProvider === 'comfyui' ? '/api/sd/comfy/models' : '/api/sd/models';
        const resp = await fetch(path, { method: 'POST', headers: await getRequestHeadersWithCsrf(), body: JSON.stringify({ url, auth: s.sdAuth || '' }), cache: 'no-store' });
        if (!resp.ok) throw new Error(`经酒馆读取模型列表失败 HTTP ${resp.status}：${(await resp.text().catch(() => '')).slice(0, 200)}`);
        const list = await resp.json();
        return (Array.isArray(list) ? list : []).map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.value, name: m.text || m.value })).filter((m) => m.id);
    }
    if (s.imageProvider === 'novelai') return (await import('./novelai.js')).NAI_MODELS;
    if (STATIC_MODELS[s.imageProvider]) return STATIC_MODELS[s.imageProvider].map((id) => ({ id, name: id }));
    if (s.imageProvider === 'pollinations' || s.imageProvider === 'horde') {
        const url = s.imageProvider === 'horde' ? `${String(s.apiBase || 'https://aihorde.net').replace(/\/+$/, '')}/api/v2/status/models?type=image`
            : `${String(s.apiBase || 'https://gen.pollinations.ai').replace(/\/+$/, '').replace('image.pollinations.ai', 'gen.pollinations.ai')}/image/models`;
        const resp = await apiFetch(url, {});
        if (!resp.ok) throw new Error(`读取模型列表失败 HTTP ${resp.status}`);
        const list = await resp.json();
        // Horde 按在线 worker 数排序，人多的排前面（排队快）
        return (Array.isArray(list) ? list : [])
            .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.name || m.id, name: m.count ? `${m.name}（${m.count} 个 worker）` : (m.name || m.id), count: m.count || 0 }))
            .filter((m) => m.id).sort((a, b) => (b.count || 0) - (a.count || 0));
    }
    if (imageKeyMissing(s)) throw new Error('请先填写 API Key');
    if (!s.apiBase) throw new Error('请先填写 API Base URL');

    if (['fal', 'replicate'].includes(s.imageProvider)) throw new Error('此服务请从模型页面复制模型路径，不使用 OpenAI 模型列表');
    if (s.imageProvider === 'gemini') {
        const { apiRoot } = await import('../media/providers.js');
        const { requestData } = await import('../media/client.js');
        const data = await requestData(`${apiRoot(s.apiBase, 'gemini')}/models?pageSize=100`, { headers: { 'x-goog-api-key': s.apiKey } });
        return (data.models || []).map((model) => ({ id: model.name.replace(/^models\//, ''), name: model.displayName || model.name }));
    }

    const resp = await apiFetch(`${normalizeApiBase(s.apiBase)}/v1/models`, {
        headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
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

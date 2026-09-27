/** Protocol adapters. No SDK, timers, DOM or network at module load. */
import { needsKey } from './keys.js';

export { isLocalBase, needsKey } from './keys.js';
export const PROVIDERS = {
    image: { openai: 'OpenAI / 兼容生图', chat: 'OpenAI Chat 生图', gemini: 'Gemini 原生', fal: 'fal', replicate: 'Replicate', comfyui: 'ComfyUI（自建）', sdwebui: 'SD WebUI（A1111 / Forge，自建）' },
    audio: { openai: 'OpenAI 兼容 TTS（Fish、各中转站）', elevenlabs: 'ElevenLabs', azure: 'Azure Speech', fish: 'Fish Audio 原生接口（要开酒馆跨域代理）' },
    video: { openai: '/videos 兼容服务', agnes: 'Agnes AI', fal: 'fal（可灵、万相、Veo 等）', comfyui: 'ComfyUI（自建）', runway: 'Runway（要开酒馆跨域代理）', replicate: 'Replicate' },
};

export const DEFAULT_BASES = {
    openai: 'https://api.openai.com/v1', chat: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    fish: 'https://api.fish.audio/v1', elevenlabs: 'https://api.elevenlabs.io/v1', azure: '',
    runway: 'https://api.dev.runwayml.com/v1', agnes: 'https://apihub.agnes-ai.com/v1',
    fal: 'https://queue.fal.run', replicate: 'https://api.replicate.com/v1',
};

/** 走 OpenAI /videos 任务协议（查询 /videos/{id}、下载 /videos/{id}/content）的服务。 */
export const VIDEOS_PROTOCOL = new Set(['openai', 'agnes']);

export function safeUrl(value) {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('地址必须是无内嵌凭据的 HTTP(S) URL');
    return url.href;
}

export function apiRoot(base, provider) {
    let root = safeUrl(base || DEFAULT_BASES[provider]).replace(/\/+$/, '');
    const parsed = new URL(root);
    if (parsed.search || parsed.hash) throw new Error('API 地址不能包含查询参数或锚点');
    const suffix = provider === 'gemini' ? 'v1beta' : 'v1';
    if (!['fal', 'azure'].includes(provider) && !/\/v\d+(?:beta\d*)?$/.test(root)) root += `/${suffix}`;
    return root;
}

export function extraParams(value) {
    const data = typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
    if (Array.isArray(data) || typeof data !== 'object' || data === null) throw new Error('额外参数必须是 JSON 对象');
    for (const key of ['__proto__', 'constructor', 'prototype']) if (Object.hasOwn(data, key)) throw new Error('额外参数包含非法字段');
    return data;
}

const path = (value) => String(value).split('/').map((part) => {
    if (!part || part === '.' || part === '..') throw new Error('模型路径无效');
    return encodeURIComponent(part);
}).join('/');
const xml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));

/** Result includes polling contract, so the client never guesses endpoints. */
export function buildRequest(kind, config, prompt) {
    const { provider, model, key, voice, size, seconds } = config;
    if (!PROVIDERS[kind]?.[provider]) throw new Error('不支持的媒体类型或服务');
    if (!String(key || '').trim() && needsKey(provider, config.base)) throw new Error('请填写此服务的 API Key');
    if (!String(prompt || '').trim()) throw new Error('请输入生成内容');
    if (prompt.length > (kind === 'audio' ? 4096 : 20000)) throw new Error('输入过长，请分段生成（语音最多 4096 字符）');
    if (provider !== 'azure' && !model?.trim()) throw new Error('请填写模型名称或模型路径');
    const root = apiRoot(config.base, provider);
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const extra = extraParams(config.extra);
    let url, body, binary = false, queue = false;

    if (provider === 'fal' || provider === 'replicate') {
        queue = true;
        const input = { ...extra, prompt };
        if (provider === 'fal') {
            headers.Authorization = `Key ${key}`;
            url = `${root}/${path(model)}`;
            body = input;
        } else if (model.includes(':')) {
            url = `${root}/predictions`;
            body = { version: model.split(':').pop(), input };
        } else {
            if (model.split('/').length !== 2) throw new Error('Replicate 模型需填 owner/name 或 owner/name:version');
            url = `${root}/models/${path(model)}/predictions`;
            body = { input };
        }
    } else if (kind === 'audio') {
        binary = true;
        if (provider === 'openai') {
            url = `${root}/audio/speech`;
            body = { ...extra, model, input: prompt, voice: voice || 'alloy', response_format: 'mp3' };
        } else if (provider === 'fish') {
            // Fish 的模型必须放在 `model` 请求头：写进请求体会按付费模型计费（免费档 s2.1-pro-free 会 402）。
            url = `${root}/tts`;
            headers.model = model;
            body = { format: 'mp3', ...extra, text: prompt, ...(voice ? { reference_id: voice } : {}) };
        } else if (provider === 'elevenlabs') {
            if (!voice) throw new Error('ElevenLabs 需要 Voice ID');
            delete headers.Authorization;
            headers['xi-api-key'] = key;
            url = `${root}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
            body = { ...extra, text: prompt, model_id: model };
        } else {
            if (!voice) throw new Error('Azure 需要音色名称，例如 zh-CN-XiaoxiaoNeural');
            delete headers.Authorization;
            headers['Ocp-Apim-Subscription-Key'] = key;
            headers['Content-Type'] = 'application/ssml+xml';
            headers['X-Microsoft-OutputFormat'] = 'audio-24khz-48kbitrate-mono-mp3';
            url = `${root}/cognitiveservices/v1`;
            body = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(config.language || extra.language || 'zh-CN')}"><voice name="${xml(voice)}">${xml(prompt)}</voice></speak>`;
        }
    } else if (kind === 'video') {
        queue = true;
        if (provider === 'runway') {
            headers['X-Runway-Version'] = '2024-11-06';
            url = `${root}/text_to_video`;
            body = { ...extra, model, promptText: prompt, ratio: size || '1280:720', duration: Number(seconds || 5) };
            if (!Number.isFinite(body.duration) || body.duration <= 0) throw new Error('视频时长必须是正数');
        } else {
            // 纯文字生成用 JSON（OpenAI 与各兼容网关都接受；Agnes 只收 JSON，multipart 直接 400），也能走酒馆代理。
            url = `${root}/videos`;
            body = { ...extra, model, prompt, seconds: String(seconds || (provider === 'agnes' ? 5 : 4)) };
            if (size) body.size = size;
            else if (provider === 'openai') body.size = '1280x720';
            // Agnes 必填 mode：text 模式不能带任何图片字段；尺寸是 720P 这样的档位，不是 WxH。
            if (provider === 'agnes') body.mode ||= 'text';
        }
    } else if (provider === 'gemini') {
        delete headers.Authorization;
        headers['x-goog-api-key'] = key;
        url = `${root}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
        body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...extra } };
    } else if (provider === 'chat') {
        url = `${root}/chat/completions`;
        body = { model, messages: [{ role: 'user', content: prompt }], modalities: ['text', 'image'], ...extra, stream: false };
    } else {
        url = `${root}/images/generations`;
        body = { model, prompt, n: 1, ...(size && size !== 'auto' ? { size } : {}), ...extra };
    }
    if (!String(key || '').trim()) for (const name of ['Authorization', 'xi-api-key', 'Ocp-Apim-Subscription-Key', 'x-goog-api-key']) delete headers[name];
    return { url, root, provider, headers, binary, queue, body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body) };
}

export function trustedTaskUrl(value, root) {
    const url = safeUrl(value);
    if (new URL(url).origin !== new URL(root).origin) throw new Error('任务地址跨域，已阻止发送 API Key');
    return url;
}

export function taskLinks(data, request) {
    const { root, provider } = request;
    if (provider === 'fal') return {
        status: trustedTaskUrl(data.status_url, root), result: trustedTaskUrl(data.response_url, root),
    };
    const id = data.id;
    if (!id || !/^[\w.:-]+$/.test(id)) throw new Error('服务未返回有效任务 ID');
    const segment = provider === 'replicate' ? 'predictions' : provider === 'runway' ? 'tasks' : 'videos';
    const safeId = encodeURIComponent(id);
    return { status: `${root}/${segment}/${safeId}`, result: VIDEOS_PROTOCOL.has(provider) ? `${root}/videos/${safeId}/content` : null };
}

export function taskState(data) {
    return String(data.status || '').toLowerCase();
}

export function mediaUrl(data, kind) {
    const output = data?.output;
    const item = kind === 'image' ? data?.images?.[0] : kind === 'video' ? data?.video : data?.audio;
    const candidate = item?.url || (typeof item === 'string' ? item : null)
        || (Array.isArray(output) ? output[0] : typeof output === 'string' ? output : output?.url)
        || data?.url || data?.data?.[0]?.url;
    return candidate ? safeUrl(candidate) : null;
}

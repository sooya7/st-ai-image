/**
 * 各家原生接口的适配器（和 OpenAI 协议不一样的那些）。client.js 的 runVendorJob 负责提交、轮询、代理、超时和续查，
 * 这里每家只写：怎么提交（create）、异步任务怎么查（task）、结果在哪（result）。
 *
 * 适配器字段：
 *   create(config, prompt) → { url, method?, headers?, body?, binary? }   config.extra 已解析成对象
 *   task?: { links(data, plan) → { status, statusBody?, id }, state(data) → 'done' | 'failed' | 其他（进行中，显示出来）,
 *            error?(data), progress?(data) → 0–100, firstDelay?, maxDelay? }
 *   result(data, { http, plan, config }) → { url } | { blob } | { contentRequest: { url, headers } }
 *   check?(data)          同步响应里的业务错误（HTTP 200 但失败）直接抛出
 *   sign?(config, now)    每次请求现算的鉴权头（可灵的 JWT）
 *   keyOptional?          不填 Key 也能用（免费服务）
 *   noProxy?              请求体不是 JSON，不能走酒馆代理
 *
 * 各家接口格式来自官方文档（2026-09-28 查阅），跨域情况是同日用 http://tauri.localhost 来源实测的预检。
 */

export const DEFAULT_VENDOR_BASES = {
    image: {
        minimax: 'https://api.minimax.cn', dashscope: 'https://dashscope.aliyuncs.com', stability: 'https://api.stability.ai',
        pollinations: 'https://gen.pollinations.ai', horde: 'https://aihorde.net',
    },
    audio: {},
    video: {},
};

function root(base, fallback) {
    const raw = String(base || fallback || '').trim().replace(/\/+$/, '');
    let url;
    try { url = new URL(raw); } catch { throw new Error('API 地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('地址必须是无内嵌凭据的 HTTP(S) URL');
    if (url.search || url.hash) throw new Error('API 地址不能包含查询参数或锚点');
    return raw;
}

/** 「1024x1024」→ [1024, 1024]；认不出用 fallback。 */
export function sizeOf(size, fallback = [1024, 1024]) {
    const m = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(String(size ?? ''));
    return m ? [Number(m[1]), Number(m[2])] : fallback;
}

/** 宽高 → 列表里最接近的比例（各家只收固定比例时用）。 */
export function nearestRatio(size, ratios) {
    const [w, h] = sizeOf(size);
    const target = Math.log(w / h);
    return ratios.reduce((best, r) => {
        const [a, b] = r.split(':').map(Number);
        return Math.abs(Math.log(a / b) - target) < Math.abs(Math.log(best.split(':').map(Number).reduce((x, y) => x / y)) - target) ? r : best;
    });
}

const bearer = (key) => (String(key || '').trim() ? { Authorization: `Bearer ${String(key).trim()}` } : {});
const json = { 'Content-Type': 'application/json' };
const pickSeed = (extra) => (Number(extra.seed) > 0 ? Number(extra.seed) : undefined);
const dataUrl = (base64, type = 'image/png') => (String(base64).startsWith('data:') ? String(base64) : `data:${type};base64,${base64}`);

/** 从 base64 串前几个字节认图片格式（各家常不告诉你是 png 还是 jpeg）。 */
export function imageTypeOfBase64(base64) {
    const head = String(base64).slice(0, 16);
    if (head.startsWith('iVBOR')) return 'image/png';
    if (head.startsWith('/9j/')) return 'image/jpeg';
    if (head.startsWith('UklGR')) return 'image/webp';
    if (head.startsWith('R0lGOD')) return 'image/gif';
    return 'image/png';
}

/* ================= 图片 ================= */

const IMAGE = {
    // MiniMax image-01：同步，要 base64 省得 24 小时后链接失效。业务错误在 base_resp 里（HTTP 仍是 200）
    minimax: {
        create: ({ base, model, size, extra, negative }, prompt) => {
            const [width, height] = sizeOf(size);
            return {
                url: `${root(base, DEFAULT_VENDOR_BASES.image.minimax)}/v1/image_generation`,
                headers: json,
                body: {
                    model: model || 'image-01', prompt: negative ? `${prompt}\n\n避免：${negative}` : prompt,
                    width: Math.round(width / 8) * 8, height: Math.round(height / 8) * 8, response_format: 'base64', n: 1, prompt_optimizer: false,
                    ...(pickSeed(extra) ? { seed: pickSeed(extra) } : {}), ...extra,
                },
            };
        },
        check: minimaxCheck,
        result: (data) => {
            const b64 = data?.data?.image_base64?.[0];
            if (b64) return { url: dataUrl(b64, imageTypeOfBase64(b64)) };
            const url = data?.data?.image_urls?.[0];
            return url ? { url } : null;
        },
    },

    // 阿里云百炼：qwen-image 系列走同步 multimodal-generation；万相（wan*）走异步任务。尺寸写成 1024*1024
    dashscope: {
        create: ({ base, model, size, extra, negative }, prompt) => {
            const r = root(base, DEFAULT_VENDOR_BASES.image.dashscope);
            const m = model || 'wan2.2-t2i-flash';
            const [w, h] = sizeOf(size);
            const parameters = { size: `${w}*${h}`, n: 1, prompt_extend: false, watermark: false, ...(pickSeed(extra) ? { seed: pickSeed(extra) } : {}), ...extra };
            if (/^qwen-image/i.test(m)) {
                return {
                    url: `${r}/api/v1/services/aigc/multimodal-generation/generation`, headers: json,
                    body: { model: m, input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters: { ...(negative ? { negative_prompt: negative } : {}), ...parameters } },
                };
            }
            return {
                url: `${r}/api/v1/services/aigc/text2image/image-synthesis`, headers: { ...json, 'X-DashScope-Async': 'enable' },
                body: { model: m, input: { prompt, ...(negative ? { negative_prompt: negative } : {}) }, parameters },
            };
        },
        check: dashscopeCheck,
        task: {
            // 同步的 qwen-image 直接带结果回来，没有 task_id：links 返回 null 表示不用查
            links: (data, plan) => {
                const id = data?.output?.task_id;
                if (!id) return null;
                return { id, status: `${new URL(plan.url).origin}/api/v1/tasks/${encodeURIComponent(id)}` };
            },
            state: dashscopeState,
            error: (data) => data?.output?.message || data?.message,
        },
        result: (data) => {
            const url = data?.output?.results?.find?.((r) => r.url)?.url || data?.output?.choices?.[0]?.message?.content?.find?.((c) => c.image)?.image;
            return url ? { url } : null;
        },
    },

    // Stability：multipart 表单，要 JSON（base64）回来。模型栏填 core / ultra / sd3.5-large 等
    stability: {
        noProxy: true,
        create: ({ base, model, size, extra, negative }, prompt) => {
            const m = String(model || 'core').trim();
            const endpoint = /^sd3/i.test(m) ? 'sd3' : m === 'ultra' ? 'ultra' : 'core';
            const form = new FormData();
            form.append('prompt', prompt);
            if (negative) form.append('negative_prompt', negative);
            form.append('aspect_ratio', nearestRatio(size, ['21:9', '16:9', '3:2', '5:4', '1:1', '4:5', '2:3', '9:16', '9:21']));
            form.append('output_format', 'png');
            if (endpoint === 'sd3') form.append('model', m);
            for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            return { url: `${root(base, DEFAULT_VENDOR_BASES.image.stability)}/v2beta/stable-image/generate/${endpoint}`, headers: { Accept: 'application/json' }, body: form };
        },
        check: (data) => { if (data?.finish_reason === 'CONTENT_FILTERED') throw new Error('Stability 判定内容违规，返回的是模糊图，没有保存'); },
        result: (data) => (data?.image ? { url: dataUrl(data.image, imageTypeOfBase64(data.image)) } : null),
    },

    // Pollinations：GET 直接回图片。不填 Key 也能用（官方文档说要 Key，2026-09-28 实测匿名仍可用，不保证）
    pollinations: {
        keyOptional: true,
        create: ({ base, key, model, size, extra, negative }, prompt) => {
            const [width, height] = sizeOf(size);
            const text = negative ? `${prompt}. Avoid: ${negative}` : prompt;
            const query = new URLSearchParams({ width, height, seed: String(pickSeed(extra) ?? Math.floor(Math.random() * 2 ** 31)), nologo: 'true', ...(model ? { model } : {}) });
            for (const [k, v] of Object.entries(extra)) if (k !== 'seed') query.set(k, String(v));
            return { url: `${root(base, DEFAULT_VENDOR_BASES.image.pollinations)}/image/${encodeURIComponent(text).slice(0, 6000)}?${query}`, method: 'GET', headers: bearer(key), binary: true };
        },
        result: async (blob) => ({ url: await blobToDataUrl(blob) }),
    },

    // AI Horde：众包免费算力，匿名 Key 是 0000000000（排队慢）。异步：check 查进度，status 取结果
    horde: {
        keyOptional: true,
        auth: (key) => ({ apikey: String(key || '').trim() || '0000000000', 'Client-Agent': 'st-ai-image:2:https://github.com/sooya7/st-ai-image' }),
        create: ({ base, key, model, size, extra, negative }, prompt) => {
            const [w, h] = sizeOf(size, [512, 768]);
            const snap = (v) => Math.max(64, Math.min(3072, Math.round(v / 64) * 64));
            const { params = {}, ...top } = extra;
            return {
                url: `${root(base, DEFAULT_VENDOR_BASES.image.horde)}/api/v2/generate/async`,
                headers: json,
                body: {
                    prompt: negative ? `${prompt} ### ${negative}` : prompt,
                    params: { width: snap(w), height: snap(h), steps: 25, cfg_scale: 7, sampler_name: 'k_euler_a', n: 1, ...(pickSeed(extra) ? { seed: String(pickSeed(extra)) } : {}), ...params },
                    models: model ? [model] : [], nsfw: true, censor_nsfw: false, r2: true, ...top,
                },
            };
        },
        task: {
            firstDelay: 4000,
            links: (data, plan) => {
                if (!data?.id) throw new Error(`AI Horde 没有接下任务：${data?.message || '未知原因'}`);
                const r = new URL(plan.url).origin;
                return { id: data.id, status: `${r}/api/v2/generate/check/${encodeURIComponent(data.id)}` };
            },
            state: (d) => (d?.faulted ? 'failed' : d?.is_possible === false ? 'failed' : d?.done ? 'done' : d?.queue_position > 0 ? `排队第 ${d.queue_position} 位` : d?.wait_time ? `约 ${d.wait_time} 秒` : 'processing'),
            error: (d) => (d?.is_possible === false ? '现在没有能跑这个模型/尺寸的 worker，换个模型或调小尺寸' : d?.message),
        },
        result: async (data, { http, plan, links }) => {
            const status = await http(`${String(plan.url).replace(/\/async$/, '')}/status/${encodeURIComponent(links.id)}`);
            const img = status?.generations?.[0]?.img;
            if (status?.generations?.[0]?.censored) throw new Error('AI Horde 的 worker 屏蔽了这张图');
            if (!img) return null;
            return /^https?:/i.test(img) ? { url: img } : { url: dataUrl(img, 'image/webp') };
        },
    },
};

/* ================= 配音 ================= */

const hexToBytes = (hex) => {
    const clean = String(hex).trim();
    if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2) throw new Error('音频数据不是十六进制');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
};
const base64ToBytes = (b64) => Uint8Array.from(atob(String(b64)), (ch) => ch.charCodeAt(0));
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac' };

/** 裸 PCM（16 位小端）包成 WAV，浏览器才能直接播。 */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); text(8, 'WAVE'); text(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
    text(36, 'data'); v.setUint32(40, pcm.length, true);
    return new Blob([header, pcm], { type: 'audio/wav' });
}

/** 百炼的音频链接是 http://，在 https 页面里会被当成混合内容拦掉，换成 https。 */
const httpsOss = (url) => String(url || '').replace(/^http:\/\/([^/]+\.aliyuncs\.com)\//i, 'https://$1/');

const AUDIO = {
    // MiniMax T2A v2：同步，音频是 hex 串；业务错误在 base_resp 里
    minimax: {
        create: ({ base, model, voice, language, extra }, text) => {
            const { voice_setting = {}, audio_setting = {}, ...rest } = extra;
            return {
                url: `${root(base, 'https://api.minimax.cn')}/v1/t2a_v2`, headers: json,
                body: {
                    model: model || 'speech-2.8-hd', text, stream: false, output_format: 'hex', language_boost: language || 'auto',
                    voice_setting: { voice_id: voice || 'female-shaonv', speed: 1, vol: 1, pitch: 0, ...voice_setting },
                    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1, ...audio_setting },
                    ...rest,
                },
            };
        },
        check: minimaxCheck,
        result: (data, { plan }) => {
            const audio = data?.data?.audio;
            if (!audio) return null;
            const format = JSON.parse(plan.body)?.audio_setting?.format || 'mp3';
            return { blob: new Blob([hexToBytes(audio)], { type: AUDIO_MIME[format] || 'audio/mpeg' }) };
        },
    },

    // 阿里云百炼：Qwen-TTS 走 multimodal-generation，CosyVoice 走 SpeechSynthesizer；都给回一个 24 小时有效的音频链接
    dashscope: {
        create: ({ base, model, voice, language, extra }, text) => {
            const r = root(base, 'https://dashscope.aliyuncs.com');
            const m = model || 'qwen3-tts-flash';
            if (/^cosyvoice|^qwen-audio/i.test(m)) {
                return {
                    url: `${r}/api/v1/services/audio/tts/SpeechSynthesizer`, headers: json,
                    body: { model: m, input: { text, voice: voice || 'longanhuan_v3.6', format: 'mp3', sample_rate: 24000, ...extra } },
                };
            }
            return {
                url: `${r}/api/v1/services/aigc/multimodal-generation/generation`, headers: json,
                body: { model: m, input: { text, voice: voice || 'Cherry', ...(language ? { language_type: language } : {}), ...extra } },
            };
        },
        check: dashscopeCheck,
        result: (data) => {
            const url = data?.output?.audio?.url;
            if (url) return { url: httpsOss(url) };
            const b64 = data?.output?.audio?.data;
            return b64 ? { blob: new Blob([base64ToBytes(b64)], { type: 'audio/wav' }) } : null;
        },
    },

    // Gemini TTS：3.8 起单次请求直接回 WAV、音色字段改成 voiceConfig.voice；旧模型回裸 PCM、字段是 prebuiltVoiceConfig
    gemini: {
        auth: (key) => ({ 'x-goog-api-key': String(key || '').trim() }),
        create: ({ base, model, voice, extra }, text) => {
            const m = String(model || 'gemini-3.8-flash-tts').replace(/^models\//, '');
            const legacy = /gemini-(2\.|3\.[0-7])/i.test(m);
            const name = voice || 'Kore';
            const { generationConfig = {}, ...rest } = extra;
            const r = root(base, 'https://generativelanguage.googleapis.com').replace(/\/v1beta$/, '');
            return {
                url: `${r}/v1beta/models/${encodeURIComponent(m)}:generateContent`, headers: json,
                body: {
                    contents: [{ role: 'user', parts: [{ text }] }],
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: { voiceConfig: legacy ? { prebuiltVoiceConfig: { voiceName: name } } : { voice: name } },
                        ...generationConfig,
                    },
                    ...rest,
                },
            };
        },
        result: (data) => {
            const part = data?.candidates?.[0]?.content?.parts?.find?.((p) => p.inlineData?.data);
            if (!part) {
                const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
                if (reason) throw new Error(`Gemini 没有返回音频（${reason}）`);
                return null;
            }
            const bytes = base64ToBytes(part.inlineData.data);
            const isWav = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
            if (isWav) return { blob: new Blob([bytes], { type: 'audio/wav' }) };
            const mime = String(part.inlineData.mimeType || '');
            if (/mpeg|mp3/i.test(mime)) return { blob: new Blob([bytes], { type: 'audio/mpeg' }) };
            const rate = Number(/rate=(\d+)/i.exec(mime)?.[1]) || 24000;
            return { blob: pcmToWav(bytes, rate) };
        },
    },

    // 火山引擎豆包语音（v1 HTTP）：不允许浏览器跨域，只能开酒馆代理。Key 填「appid:token」，音色填 voice_type
    volcengine: {
        auth: (key) => ({ Authorization: `Bearer;${String(key || '').split(':').slice(1).join(':').trim()}` }),
        create: ({ base, key, model, voice, extra }, text) => {
            const [appid, ...rest] = String(key || '').split(':');
            const token = rest.join(':').trim();
            if (!appid.trim() || !token) throw new Error('豆包语音的 Key 要写成「appid:token」（控制台里的 APP ID 和 Access Token，用英文冒号连起来）');
            if (new TextEncoder().encode(text).length > 1024) throw new Error('豆包语音一次最多 1024 字节（约 340 个汉字），请分段');
            const { audio = {}, ...more } = extra;
            return {
                url: `${root(base, 'https://openspeech.bytedance.com')}/api/v1/tts`, headers: json,
                body: {
                    app: { appid: appid.trim(), token: 'access_token', cluster: model || 'volcano_tts' },
                    user: { uid: 'st-ai-image' },
                    audio: { voice_type: voice || 'zh_female_shuangkuaisisi_moon_bigtts', encoding: 'mp3', speed_ratio: 1, ...audio },
                    request: { reqid: randomId(), text, operation: 'query' },
                    ...more,
                },
            };
        },
        check: (data) => {
            if (data?.code !== undefined && data.code !== 3000) {
                const error = new Error(`豆包语音报错 ${data.code}：${data.message || ''}`);
                error.terminal = true;
                throw error;
            }
        },
        result: (data) => (data?.data ? { blob: new Blob([base64ToBytes(data.data)], { type: 'audio/mpeg' }) } : null),
    },

    // GPT-SoVITS 本地 api_v2（默认 9880）：没开跨域，要走酒馆代理。音色栏填参考音频在那台机器上的路径
    gptsovits: {
        keyOptional: true,
        create: ({ base, voice, language, extra }, text) => {
            if (!String(voice || extra.ref_audio_path || '').trim()) throw new Error('GPT-SoVITS 要在「音色」里填参考音频的路径（GPT-SoVITS 那台机器上的文件路径）');
            return {
                url: `${root(base, 'http://127.0.0.1:9880')}/tts`, headers: json, binary: true,
                body: {
                    text, text_lang: language || 'zh', ref_audio_path: voice, prompt_lang: language || 'zh', prompt_text: '',
                    media_type: 'wav', streaming_mode: false, ...extra,
                },
            };
        },
        result: (blob) => ({ blob: blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: 'audio/wav' }) }),
    },
};

/* ================= 视频 ================= */

const seconds = (value, fallback) => Number(value) > 0 ? Number(value) : fallback;
const RATIO = /^\d{1,2}:\d{1,2}$/;
const RESOLUTION = /^\d{3,4}p$/i;
/** 视频页的「尺寸」栏可以填 720p、16:9 或 1280x720：拆成分辨率和比例。 */
export function videoShape(size, { resolution = '720p', ratio = '16:9' } = {}) {
    const text = String(size || '').trim();
    if (RESOLUTION.test(text)) return { resolution: text.toLowerCase(), ratio };
    if (RATIO.test(text)) return { resolution, ratio: text };
    const m = /^(\d{3,4})\s*[x×*]\s*(\d{3,4})$/i.exec(text);
    if (m) {
        const [w, h] = [Number(m[1]), Number(m[2])];
        return { resolution: `${Math.min(w, h)}p`, ratio: nearestRatio(text, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']), width: w, height: h };
    }
    return { resolution, ratio };
}
const failedIf = (list) => (state) => list.includes(state);

const VIDEO = {
    // 火山方舟 Seedance：参数写 JSON 字段（官方的强校验写法）；链接 24 小时有效
    ark: {
        create: ({ base, model, size, seconds: secs, extra }, prompt) => {
            const shape = videoShape(size);
            return {
                url: `${root(base, 'https://ark.cn-beijing.volces.com/api/v3')}/contents/generations/tasks`, headers: json,
                body: {
                    model: model || 'doubao-seedance-2-0-fast-260128', content: [{ type: 'text', text: prompt }],
                    resolution: shape.resolution, ...(RATIO.test(String(size || '').trim()) || shape.width ? { ratio: shape.ratio } : {}),
                    duration: seconds(secs, 5), watermark: false, ...extra,
                },
            };
        },
        task: {
            links: (data, plan) => {
                if (!data?.id) throw new Error(`火山方舟没有返回任务 ID：${data?.error?.message || ''}`);
                return { id: data.id, status: `${plan.url}/${encodeURIComponent(data.id)}` };
            },
            state: (d) => { const s = String(d?.status || ''); return s === 'succeeded' ? 'done' : failedIf(['failed', 'cancelled', 'expired'])(s) ? 'failed' : s || 'queued'; },
            error: (d) => d?.error?.message,
        },
        result: (d) => (d?.content?.video_url ? { url: d.content.video_url } : null),
    },

    // MiniMax 海螺：V1（Hailuo 2.3 / 02）成功后要再用 file_id 换下载地址（1 小时有效）；H3 系列走 V2
    minimax: {
        create: ({ base, model, size, seconds: secs, extra }, prompt) => {
            const r = root(base, 'https://api.minimax.cn');
            const m = model || 'MiniMax-Hailuo-2.3';
            const res = RESOLUTION.test(String(size || '').trim()) ? String(size).toUpperCase() : '768P';
            if (/^MiniMax-H\d/i.test(m)) {
                return {
                    url: `${r}/v2/video_generation`, headers: json,
                    body: { model: m, content: [{ type: 'text', text: prompt }], resolution: res, duration: seconds(secs, 5), ratio: videoShape(size).ratio, ...extra },
                };
            }
            return { url: `${r}/v1/video_generation`, headers: json, body: { model: m, prompt, duration: seconds(secs, 6), resolution: res, prompt_optimizer: true, ...extra } };
        },
        check: minimaxCheck,
        task: {
            links: (data, plan) => {
                const id = data?.task_id || data?.task?.id || data?.id;
                if (!id) throw new Error('MiniMax 没有返回任务 ID');
                const origin = new URL(plan.url).origin;
                const v2 = /\/v2\//.test(plan.url);
                return { id, status: v2 ? `${origin}/v2/query/video_generation/${encodeURIComponent(id)}` : `${origin}/v1/query/video_generation?task_id=${encodeURIComponent(id)}` };
            },
            state: (d) => {
                const s = String(d?.task?.status || d?.status || '');
                if (/^(success|succeeded)$/i.test(s)) return 'done';
                if (/^(fail|failed|cancelled)$/i.test(s)) return 'failed';
                return s.toLowerCase() || 'queued';
            },
            error: (d) => d?.task?.error?.message || d?.base_resp?.status_msg,
        },
        result: async (d, { http, plan }) => {
            if (d?.task?.content?.url) return { url: d.task.content.url };
            if (!d?.file_id) return null;
            const file = await http(`${new URL(plan.url).origin}/v1/files/retrieve?file_id=${encodeURIComponent(d.file_id)}`);
            minimaxCheck(file);
            return file?.file?.download_url ? { url: file.file.download_url } : null;
        },
    },

    // 阿里云百炼 万相：异步任务。2.7 及以后用 resolution + ratio，2.6 及以前用 size「1280*720」
    dashscope: {
        create: ({ base, model, size, seconds: secs, extra }, prompt) => {
            const m = model || 'wan2.7-t2v';
            const shape = videoShape(size);
            const modern = !/^wanx?2\.[0-6]/i.test(m);
            const dims = shape.width ? `${shape.width}*${shape.height}` : ({ '480p': '832*480', '720p': '1280*720', '1080p': '1920*1080' }[shape.resolution] || '1280*720');
            const parameters = modern
                ? { resolution: shape.resolution.toUpperCase(), ratio: shape.ratio, duration: seconds(secs, 5), watermark: false }
                : { size: dims, duration: seconds(secs, 5), watermark: false };
            return {
                url: `${root(base, 'https://dashscope.aliyuncs.com')}/api/v1/services/aigc/video-generation/video-synthesis`,
                headers: { ...json, 'X-DashScope-Async': 'enable' },
                body: { model: m, input: { prompt }, parameters: { ...parameters, ...extra } },
            };
        },
        check: dashscopeCheck,
        task: {
            links: (data, plan) => {
                const id = data?.output?.task_id;
                if (!id) throw new Error(`百炼没有返回任务 ID：${data?.message || ''}`);
                return { id, status: `${new URL(plan.url).origin}/api/v1/tasks/${encodeURIComponent(id)}` };
            },
            state: dashscopeState,
            error: (d) => d?.output?.message || d?.message,
        },
        result: (d) => (d?.output?.video_url ? { url: httpsOss(d.output.video_url) } : null),
    },

    // Google Veo（Gemini API）：长任务 operation；结果链接下载时要带 Key
    veo: {
        auth: (key) => ({ 'x-goog-api-key': String(key || '').trim() }),
        create: ({ base, model, size, seconds: secs, extra }, prompt) => {
            const m = String(model || 'veo-3.1-fast-generate-preview').replace(/^models\//, '');
            const shape = videoShape(size);
            const { parameters = {}, ...rest } = extra;
            const r = root(base, 'https://generativelanguage.googleapis.com').replace(/\/v1beta$/, '');
            return {
                url: `${r}/v1beta/models/${encodeURIComponent(m)}:predictLongRunning`, headers: json,
                body: {
                    instances: [{ prompt }],
                    parameters: { aspectRatio: shape.ratio === '9:16' ? '9:16' : '16:9', durationSeconds: String(seconds(secs, 8)), resolution: shape.resolution, ...parameters },
                    ...rest,
                },
            };
        },
        task: {
            firstDelay: 10000,
            links: (data, plan) => {
                if (!data?.name) throw new Error(`Veo 没有返回任务：${data?.error?.message || ''}`);
                return { id: data.name, status: `${new URL(plan.url).origin}/v1beta/${data.name}` };
            },
            state: (d) => (d?.error ? 'failed' : d?.done ? 'done' : 'running'),
            error: (d) => d?.error?.message,
        },
        result: (d, { plan }) => {
            const res = d?.response?.generateVideoResponse;
            const uri = res?.generatedSamples?.[0]?.video?.uri;
            if (!uri) {
                if (res?.raiFilteredReasons?.length) throw new Error(`Veo 过滤了这条视频：${res.raiFilteredReasons[0]}`);
                return null;
            }
            // 只在链接和接口同源时才带 Key，别的地址一律不带
            const sameOrigin = new URL(uri).origin === new URL(plan.url).origin;
            return { contentRequest: { url: uri, headers: sameOrigin ? { ...plan.headers } : {} } };
        },
    },

    // 智谱 CogVideoX：异步，async-result 查结果
    zhipu: {
        create: ({ base, model, size, seconds: secs, extra }, prompt) => {
            const shape = videoShape(size, { resolution: '1080p' });
            const dims = shape.width ? `${shape.width}x${shape.height}` : ({ '720p': '1280x720', '1080p': '1920x1080' }[shape.resolution] || '1920x1080');
            return {
                url: `${root(base, 'https://open.bigmodel.cn/api/paas/v4')}/videos/generations`, headers: json,
                body: { model: model || 'cogvideox-3', prompt, quality: 'speed', with_audio: false, size: dims, fps: 30, duration: seconds(secs, 5), ...extra },
            };
        },
        task: {
            links: (data, plan) => {
                if (!data?.id) throw new Error(`智谱没有返回任务 ID：${data?.error?.message || ''}`);
                return { id: data.id, status: `${plan.url.replace(/\/videos\/generations$/, '')}/async-result/${encodeURIComponent(data.id)}` };
            },
            state: (d) => { const s = String(d?.task_status || '').toUpperCase(); return s === 'SUCCESS' ? 'done' : s === 'FAIL' ? 'failed' : s.toLowerCase() || 'processing'; },
            error: (d) => d?.error?.message,
        },
        result: (d) => (d?.video_result?.[0]?.url ? { url: d.video_result[0].url } : null),
    },

    // 硅基流动：查状态是 POST；视频链接可能 10 分钟就过期，所以生成完马上下载
    siliconflow: {
        create: ({ base, model, size, extra }, prompt) => {
            const shape = videoShape(size);
            const image_size = shape.width ? `${shape.width}x${shape.height}` : shape.ratio === '9:16' ? '720x1280' : shape.ratio === '1:1' ? '960x960' : '1280x720';
            return { url: `${root(base, 'https://api.siliconflow.cn/v1')}/video/submit`, headers: json, body: { model: model || 'Wan-AI/Wan2.2-T2V-A14B', prompt, image_size, ...extra } };
        },
        task: {
            links: (data, plan) => {
                if (!data?.requestId) throw new Error(`硅基流动没有返回任务 ID：${data?.message || ''}`);
                return { id: data.requestId, status: plan.url.replace(/\/submit$/, '/status'), statusBody: { requestId: data.requestId } };
            },
            state: (d) => { const s = String(d?.status || ''); return s === 'Succeed' ? 'done' : s === 'Failed' ? 'failed' : s || 'InQueue'; },
            error: (d) => d?.reason,
        },
        result: (d) => (d?.results?.videos?.[0]?.url ? { url: d.results.videos[0].url } : null),
    },

    // 可灵：不允许浏览器跨域，只能开酒馆代理。Key 填 API Key 走新版接口；填「AccessKey:SecretKey」走旧版（JWT）
    kling: {
        auth: () => ({}),
        sign: async ({ key }, now = Date.now) => {
            const text = String(key || '').trim();
            if (!text.includes(':')) return { Authorization: `Bearer ${text}` };
            const [ak, sk] = text.split(':');
            return { Authorization: `Bearer ${await hs256Jwt({ iss: ak.trim(), exp: Math.floor(now() / 1000) + 1800, nbf: Math.floor(now() / 1000) - 5 }, sk.trim())}` };
        },
        create: ({ base, key, model, size, seconds: secs, extra }, prompt) => {
            const r = root(base, 'https://api-beijing.klingai.com');
            const shape = videoShape(size);
            if (String(key || '').includes(':')) {
                return {
                    url: `${r}/v1/videos/text2video`, headers: json,
                    body: { model_name: model || 'kling-v2-1', prompt, duration: String(seconds(secs, 5)), aspect_ratio: shape.ratio, mode: 'std', ...extra },
                };
            }
            const { settings = {}, ...rest } = extra;
            return {
                url: `${r}/text-to-video/${encodeURIComponent(model || 'kling-2.6')}`, headers: json,
                body: { prompt, settings: { resolution: shape.resolution, aspect_ratio: shape.ratio, duration: seconds(secs, 5), audio: 'off', ...settings }, options: { watermark_info: { enabled: false } }, ...rest },
            };
        },
        task: {
            links: (data, plan) => {
                const id = data?.data?.task_id || data?.data?.id;
                if (!id) throw new Error(`可灵没有返回任务 ID：${data?.message || ''}`);
                const legacy = /\/v1\/videos\/text2video$/.test(plan.url);
                return { id, status: legacy ? `${plan.url}/${encodeURIComponent(id)}` : `${new URL(plan.url).origin}/tasks?task_ids=${encodeURIComponent(id)}` };
            },
            state: (d) => {
                const task = Array.isArray(d?.data) ? d.data[0] : d?.data;
                const s = String(task?.task_status || task?.status || '');
                return s === 'succeed' || s === 'succeeded' ? 'done' : s === 'failed' ? 'failed' : s || 'submitted';
            },
            error: (d) => (Array.isArray(d?.data) ? d.data[0]?.message : d?.data?.task_status_msg) || d?.message,
        },
        result: (d) => {
            const task = Array.isArray(d?.data) ? d.data[0] : d?.data;
            const url = task?.task_result?.videos?.[0]?.url || task?.outputs?.find?.((o) => o.type === 'video' || o.url)?.url;
            return url ? { url } : null;
        },
    },

    // Vidu：不允许浏览器跨域，只能开酒馆代理；鉴权头是「Token xxx」
    vidu: {
        auth: (key) => ({ Authorization: `Token ${String(key || '').trim()}` }),
        create: ({ base, model, size, seconds: secs, extra }, prompt) => {
            const shape = videoShape(size);
            return {
                url: `${root(base, 'https://api.vidu.cn')}/ent/v2/text2video`, headers: json,
                body: { model: model || 'viduq2', prompt, duration: seconds(secs, 5), aspect_ratio: shape.ratio, resolution: shape.resolution, ...extra },
            };
        },
        task: {
            links: (data, plan) => {
                if (!data?.task_id) throw new Error(`Vidu 没有返回任务 ID：${data?.message || ''}`);
                return { id: data.task_id, status: `${new URL(plan.url).origin}/ent/v2/tasks/${encodeURIComponent(data.task_id)}/creations` };
            },
            state: (d) => { const s = String(d?.state || ''); return s === 'success' ? 'done' : s === 'failed' ? 'failed' : s || 'queueing'; },
            error: (d) => d?.err_code,
        },
        result: (d) => (d?.creations?.[0]?.url ? { url: d.creations[0].url } : null),
    },

    // Luma（新版 agents.lumalabs.ai，允许跨域）：结果链接 1 小时过期
    luma: {
        create: ({ base, model, size, seconds: secs, extra }, prompt) => {
            const shape = videoShape(size);
            const { video = {}, ...rest } = extra;
            return {
                url: `${root(base, 'https://agents.lumalabs.ai/v1')}/generations`, headers: json,
                body: { model: model || 'ray-3.2', type: 'video', prompt, aspect_ratio: shape.ratio, video: { resolution: shape.resolution, duration: `${seconds(secs, 5)}s`, ...video }, ...rest },
            };
        },
        task: {
            links: (data, plan) => {
                if (!data?.id) throw new Error(`Luma 没有返回任务 ID：${data?.failure_reason || ''}`);
                return { id: data.id, status: `${plan.url}/${encodeURIComponent(data.id)}` };
            },
            state: (d) => { const s = String(d?.state || d?.status || ''); return s === 'completed' ? 'done' : s === 'failed' ? 'failed' : s || 'queued'; },
            error: (d) => d?.failure_reason || d?.failure_code,
        },
        result: (d) => {
            const url = d?.output?.find?.((o) => o?.url)?.url || d?.assets?.video;
            return url ? { url } : null;
        },
    },
};

/** HS256 JWT（可灵旧版鉴权）。浏览器和 Node 18+ 都有 WebCrypto。 */
export async function hs256Jwt(payload, secret) {
    const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const enc = new TextEncoder();
    const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const body = b64url(enc.encode(JSON.stringify(payload)));
    const keyObj = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', keyObj, enc.encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
}

const randomId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* ================= 共用的判定 ================= */

function minimaxCheck(data) {
    const code = data?.base_resp?.status_code;
    if (code !== undefined && code !== 0) {
        const hint = { 1002: '请求太频繁', 1004: 'Key 无效', 1008: '余额不足', 1026: '内容违规', 1027: '内容违规', 2013: '参数不对', 2049: 'Key 无效' }[code];
        const error = new Error(`MiniMax 报错 ${code}${hint ? `（${hint}）` : ''}：${data.base_resp.status_msg || ''}`);
        error.terminal = true;
        throw error;
    }
}

function dashscopeCheck(data) {
    if (data?.code && !data?.output) throw new Error(`百炼报错 ${data.code}：${data.message || ''}`);
}

function dashscopeState(data) {
    const s = String(data?.output?.task_status || '').toUpperCase();
    if (!data?.output?.task_id && (data?.output?.results || data?.output?.choices || data?.output?.video_url || data?.output?.audio)) return 'done';
    if (s === 'SUCCEEDED') return 'done';
    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(s)) return 'failed';
    return s.toLowerCase() || 'pending';
}

async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/* ================= 注册表 ================= */

const ADAPTERS = { image: IMAGE, audio: AUDIO, video: VIDEO };

export const vendorFor = (kind, provider) => ADAPTERS[kind]?.[provider] || null;

/** 生成提交计划；和 buildRequest 一样先校验，续查老任务时也用它重建请求头。 */
export function vendorPlan(kind, config, prompt) {
    const adapter = vendorFor(kind, config.provider);
    if (!adapter) throw new Error('不支持的服务');
    if (!adapter.keyOptional && !String(config.key || '').trim()) throw new Error('请填写此服务的 API Key');
    if (!String(prompt || '').trim()) throw new Error('请输入生成内容');
    if (prompt.length > (kind === 'audio' ? 4096 : 20000)) throw new Error('输入过长，请分段生成（语音最多 4096 字符）');
    let extra = config.extra ?? {};
    if (typeof extra === 'string') {
        try { extra = JSON.parse(extra || '{}'); } catch { throw new Error('额外参数必须是 JSON 对象'); }
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('额外参数必须是 JSON 对象');
    for (const key of ['__proto__', 'constructor', 'prototype']) if (Object.hasOwn(extra, key)) throw new Error('额外参数包含非法字段');
    const request = adapter.create({ ...config, extra }, prompt);
    const url = new URL(request.url);
    const body = request.body === undefined || typeof request.body === 'string' || request.body instanceof FormData ? request.body : JSON.stringify(request.body);
    // headers 是鉴权头，每次请求（提交、轮询、取结果）都带；createHeaders 只在提交时带：
    // 有的查询接口跨域只放行 Authorization，多带 Content-Type 或百炼的异步开关就会被浏览器拦下
    const auth = adapter.auth ? adapter.auth(config.key, config) : adapter.keyOptional && !String(config.key || '').trim() ? {} : bearer(config.key);
    return {
        url: url.href, method: request.method || 'POST', root: url.origin, provider: config.provider, kind,
        headers: auth, createHeaders: request.headers || {}, body, binary: !!request.binary,
    };
}

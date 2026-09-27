/**
 * NovelAI 生图（image.novelai.net/ai/generate-image）。
 * 官方接口允许跨域（ACAO: *），浏览器和 TauriTavern 都能直连，不需要酒馆转发。
 * 返回的是一个 zip，里面一张 png；有些反代直接回图片或 JSON，也一并认。
 */

export const NAI_BASE = 'https://image.novelai.net';

export const NAI_MODELS = [
    { id: 'nai-diffusion-4-5-full', name: 'NAI Diffusion V4.5 Full' },
    { id: 'nai-diffusion-4-5-curated', name: 'NAI Diffusion V4.5 Curated' },
    { id: 'nai-diffusion-4-full', name: 'NAI Diffusion V4 Full' },
    { id: 'nai-diffusion-4-curated-preview', name: 'NAI Diffusion V4 Curated' },
    { id: 'nai-diffusion-3', name: 'NAI Diffusion Anime V3' },
    { id: 'nai-diffusion-furry-3', name: 'NAI Diffusion Furry V3' },
];

const randomSeed = () => Math.floor(Math.random() * 4294967295);

function endpoint(base) {
    const raw = String(base || NAI_BASE).trim().replace(/\/+$/, '');
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('地址必须是 http(s):// 开头，不要把账号密码写进地址');
    if (url.search || url.hash) throw new Error('地址不能包含查询参数');
    return /\/ai\/generate-image$/.test(raw) ? raw : `${raw}/ai/generate-image`;
}

/**
 * 请求体按 NovelAI 网页版 V4/V4.5 的格式；V3 模型会忽略 v4_* 字段。
 * 额外参数（JSON 对象）合并进 parameters，可以覆盖 steps、scale、sampler、qualityToggle 等。
 */
export function buildNovelAIRequest({ base, key, model, size, extra = {} }, prompt, negative = '', { random = randomSeed } = {}) {
    if (!String(key || '').trim()) throw new Error('请填写 NovelAI 令牌（pst- 开头的 Persistent API Token）');
    if (!String(prompt || '').trim()) throw new Error('请输入生成内容');
    const m = /^\s*(\d{2,5})\s*[x×*:]\s*(\d{2,5})\s*$/i.exec(String(size ?? ''));
    const [width, height] = m ? [Number(m[1]), Number(m[2])] : [832, 1216];
    const seed = Number(extra.seed);
    const parameters = {
        params_version: 3, width, height, scale: 5, sampler: 'k_euler_ancestral', steps: 28, n_samples: 1,
        ucPreset: 0, qualityToggle: true, noise_schedule: 'karras', cfg_rescale: 0,
        dynamic_thresholding: false, prefer_brownian: true, deliberate_euler_ancestral_bug: false,
        legacy: false, legacy_v3_extend: false, legacy_uc: false, add_original_image: false,
        skip_cfg_above_sigma: null, use_coords: false, characterPrompts: [],
        negative_prompt: negative,
        v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
        v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false },
        ...extra,
    };
    parameters.seed = Number.isFinite(seed) && seed > 0 ? seed : random();
    return {
        url: endpoint(base),
        headers: { Authorization: `Bearer ${String(key).trim()}`, 'Content-Type': 'application/json' },
        body: { input: prompt, model: String(model || '').trim() || 'nai-diffusion-4-5-full', action: 'generate', parameters },
    };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function sniff(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
    return null;
}

const inflateRaw = async (data) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());

/** 从 zip 里取第一张图片。只认 NovelAI 用到的两种压缩方式：不压缩（0）和 deflate（8）。 */
export async function unzipFirstImage(bytes, inflate = inflateRaw) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = [];
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (view.getUint32(i, true) !== 0x06054b50) continue;
        const count = view.getUint16(i + 10, true);
        let p = view.getUint32(i + 16, true);
        for (let n = 0; n < count && p + 46 <= bytes.length && view.getUint32(p, true) === 0x02014b50; n++) {
            const nameLen = view.getUint16(p + 28, true);
            entries.push({
                method: view.getUint16(p + 10, true), size: view.getUint32(p + 20, true), offset: view.getUint32(p + 42, true),
                name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)),
            });
            p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
        }
        break;
    }
    const entry = entries.find((e) => /\.(png|jpe?g|webp)$/i.test(e.name)) || entries[0];
    if (!entry || view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error('NovelAI 返回的压缩包里没有图片');
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    const data = bytes.subarray(start, start + entry.size);
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`NovelAI 压缩包用了不认识的压缩方式 ${entry.method}`);
    const out = entry.method === 0 ? data : await inflate(data);
    return new Blob([out], { type: sniff(out) || MIME[entry.name.split('.').pop().toLowerCase()] || 'image/png' });
}

/** 响应 → 图片（Blob 或 http 地址）。 */
export async function readNovelAIImage(response) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return unzipFirstImage(bytes);
    const mime = sniff(bytes);
    if (mime) return new Blob([bytes], { type: mime });
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('NovelAI 返回的既不是图片也不是压缩包'); }
    const item = data?.images?.[0] ?? data?.image ?? data?.data?.[0]?.b64_json ?? data?.data?.[0]?.url ?? data?.b64_json ?? data?.url;
    if (typeof item !== 'string' || !item) throw new Error('NovelAI 返回成功但没有图片');
    if (/^https?:\/\//i.test(item) || item.startsWith('data:image/')) return item;
    const bin = atob(item);
    const raw = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new Blob([raw], { type: sniff(raw) || 'image/png' });
}

export async function novelAIError(response) {
    const text = await response.text().catch(() => '');
    let message = text.slice(0, 300);
    try { message = JSON.parse(text).message || message; } catch { /* 不是 JSON 就用原文 */ }
    const hint = {
        401: 'NovelAI 令牌无效，要填 pst- 开头的 Persistent API Token',
        402: '需要 NovelAI 订阅，或者 Anlas 不够（Opus 在 1024×1024 以内、28 步以内不扣）',
        429: 'NovelAI 同一时间只能生成一张，等上一张出来再试',
    }[response.status];
    return new Error(hint ? `${hint}（${message || response.status}）` : `NovelAI HTTP ${response.status}：${message || response.statusText}`);
}

async function toDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/** 生成一张，返回 data: 或 http(s): 地址。 */
export async function generateNovelAI(config, prompt, negative, { signal, fetch: fetchImpl } = {}) {
    const request = buildNovelAIRequest(config, prompt, negative);
    const { fetchWithTimeout } = fetchImpl ? { fetchWithTimeout: fetchImpl } : await import('../core/net.js');
    let response;
    try {
        response = await fetchWithTimeout(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal, timeout: config.timeout });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new Error(/Failed to fetch|NetworkError|Load failed/i.test(String(e?.message)) ? '连不上 NovelAI：检查地址；用反代的话，反代要允许跨域' : String(e?.message || e));
    }
    if (!response.ok) throw await novelAIError(response);
    const image = await readNovelAIImage(response);
    return typeof image === 'string' ? image : toDataUrl(image);
}

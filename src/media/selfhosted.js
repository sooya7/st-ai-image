/**
 * 自建服务：ComfyUI（生图 / 视频）和 SD WebUI（A1111 / Forge / SD.Next，生图）。
 *
 * 两种路线：
 *   - 酒馆后端转发（默认）：调酒馆自带的 /api/sd/generate、/api/sd/comfy/generate，
 *     由酒馆服务器去请求本地服务，没有跨域问题；原版酒馆和 TauriTavern 都有这两个接口。
 *   - 浏览器直连：ComfyUI 需要 --enable-cors-header，SD WebUI 需要 --cors-allow-origins。
 *
 * ComfyUI 工作流用「导出 (API)」格式，参数靠占位符注入；占位符名与 st-chatu8 兼容。
 */

export const SELF_HOSTED = new Set(['comfyui', 'sdwebui']);

/** 占位符别名 → 规范名。写在字符串值里：整串就是占位符时按类型替换，夹在文字里时按文字替换。 */
const ALIASES = {
    prompt: ['prompt', '提示词', '正面提示词'],
    negative_prompt: ['negative_prompt', '负面提示词'],
    seed: ['seed', '种子'],
    width: ['width', '宽度'],
    height: ['height', '高度'],
    steps: ['steps', '步数'],
    cfg_scale: ['cfg_scale', 'cfg', 'CFG'],
    sampler_name: ['sampler_name', '采样方法'],
    scheduler: ['scheduler', '调度器'],
    model: ['MODEL_NAME', 'model', '模型'],
    seconds: ['seconds', 'duration', '视频秒数'],
    fps: ['fps', '帧率'],
    frames: ['frames', '帧数'],
};
const CANONICAL = Object.fromEntries(Object.entries(ALIASES).flatMap(([name, list]) => list.map((alias) => [alias, name])));
const TOKEN = /%([A-Za-z_一-鿿][\w一-鿿]*)%/g;
const WHOLE_TOKEN = /^%([A-Za-z_一-鿿][\w一-鿿]*)%$/;

const randomSeed = () => Math.floor(Math.random() * 2 ** 32);

/** 「1024x1024」「832*480」「832:480」→ [宽, 高]；认不出按 1024x1024。 */
export function parseSize(size, fallback = [1024, 1024]) {
    const m = /^\s*(\d{2,5})\s*[x×*:]\s*(\d{2,5})\s*$/i.exec(String(size ?? ''));
    return m ? [Number(m[1]), Number(m[2])] : fallback;
}

/**
 * 占位符的值。extra 里的键可以覆盖默认值，也能提供自定义占位符（%lora_strength% 之类）。
 * seed 为 -1、空或 0 时随机。
 */
export function placeholderValues({ prompt, negative = '', size, seconds, model = '', extra = {}, random = randomSeed }) {
    const [width, height] = parseSize(size);
    const secs = Number(extra.seconds ?? seconds) || 5;
    const fps = Number(extra.fps) || 16;
    const values = {
        prompt, negative_prompt: negative, width, height, model,
        steps: 20, cfg_scale: 7, sampler_name: 'euler', scheduler: 'normal',
        seconds: secs, fps, frames: Math.round(secs * fps) + 1,
        ...extra,
    };
    const seed = Number(values.seed);
    values.seed = Number.isFinite(seed) && seed > 0 ? seed : random();
    return values;
}

/** 校验并解析 API 格式工作流。UI 格式（有 nodes 数组）直接报错，不猜转换。 */
export function parseWorkflow(text) {
    let data;
    try { data = JSON.parse(String(text ?? '')); } catch { throw new Error('ComfyUI 工作流不是有效的 JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('ComfyUI 工作流不是有效的 JSON 对象');
    if (Array.isArray(data.nodes)) throw new Error('这是 ComfyUI 的界面格式工作流，请在 ComfyUI 里用「导出 (API)」重新导出');
    const nodes = Object.values(data);
    if (!nodes.length || !nodes.every((n) => n && typeof n === 'object' && typeof n.class_type === 'string')) {
        throw new Error('ComfyUI 工作流不是 API 格式（每个节点都应有 class_type），请用「导出 (API)」');
    }
    return data;
}

/** 把占位符填进工作流，返回新对象；有占位符没给值时报错并列出名字。 */
export function fillWorkflow(workflow, values) {
    const missing = new Set();
    const lookup = (token) => {
        const name = CANONICAL[token] || token;
        return Object.hasOwn(values, name) ? values[name] : Object.hasOwn(values, token) ? values[token] : undefined;
    };
    const walk = (node) => {
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
        if (typeof node !== 'string' || !node.includes('%')) return node;
        const whole = WHOLE_TOKEN.exec(node);
        if (whole) {
            const value = lookup(whole[1]);
            if (value === undefined) missing.add(whole[1]);
            return value === undefined ? node : value;
        }
        return node.replace(TOKEN, (match, token) => {
            const value = lookup(token);
            if (value === undefined) { missing.add(token); return match; }
            return String(value);
        });
    };
    const filled = walk(workflow);
    if (missing.size) throw new Error(`工作流里的占位符没有值：${[...missing].map((t) => `%${t}%`).join('、')}（可在额外参数里提供）`);
    return filled;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif|avi)$/i;

/** 从 /history 的 outputs 里挑结果：视频优先 gifs/videos 和视频扩展名，图片优先 type=output。 */
export function pickComfyOutput(outputs, kind) {
    const all = [];
    for (const out of Object.values(outputs || {})) {
        for (const key of ['gifs', 'videos', 'images', 'video']) {
            for (const item of [].concat(out?.[key] || [])) if (item?.filename) all.push({ ...item, key });
        }
    }
    const isVideo = (i) => i.key !== 'images' || VIDEO_EXT.test(i.filename);
    const pool = kind === 'video' ? all.filter(isVideo) : all.filter((i) => !isVideo(i) || /\.gif$/i.test(i.filename));
    return pool.find((i) => i.type === 'output') || pool[0] || null;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo' };
const mimeOf = (format, kind) => MIME[String(format || '').toLowerCase()] || (kind === 'video' ? 'video/mp4' : 'image/png');

export function base64ToBlob(data, type) {
    const bin = atob(String(data));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
}

async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

export function serviceRoot(base, provider) {
    const raw = String(base || (provider === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860')).trim().replace(/\/+$/, '');
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('地址必须是 http(s)://主机:端口，不要把账号密码写进地址');
    if (url.search || url.hash) throw new Error('地址不能包含查询参数');
    return raw;
}

async function readJson(response, label) {
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}：${text.slice(0, 300) || response.statusText}`);
    try { return JSON.parse(text); } catch { throw new Error(`${label} 返回的不是 JSON：${text.slice(0, 200)}`); }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** 生成请求需要的东西；纯函数，方便测试。 */
export function buildSelfHostedPlan(kind, config, prompt, { random } = {}) {
    const { provider } = config;
    if (!SELF_HOSTED.has(provider)) throw new Error('不是自建服务');
    if (provider === 'sdwebui' && kind !== 'image') throw new Error('SD WebUI 只能生图');
    if (!String(prompt || '').trim()) throw new Error('请输入生成内容');
    const root = serviceRoot(config.base, provider);
    let extra = {};
    try { extra = typeof config.extra === 'string' ? JSON.parse(config.extra || '{}') : (config.extra || {}); } catch { throw new Error('额外参数必须是 JSON 对象'); }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('额外参数必须是 JSON 对象');
    const values = placeholderValues({ prompt, negative: config.negative || '', size: config.size, seconds: config.seconds, model: config.model || '', extra, random });

    if (provider === 'sdwebui') {
        const { width, height, steps, cfg_scale, sampler_name, seed } = values;
        const body = { prompt, negative_prompt: values.negative_prompt, width, height, steps, cfg_scale, sampler_name, seed, n_iter: 1, batch_size: 1, ...extra };
        for (const key of ['seconds', 'fps', 'frames', 'model']) delete body[key];
        if (config.model) body.override_settings = { ...(body.override_settings || {}), sd_model_checkpoint: config.model };
        return { provider, kind, root, body, auth: String(config.auth || '').trim() };
    }
    const workflow = fillWorkflow(parseWorkflow(config.workflow), values);
    return { provider, kind, root, workflow, clientId: `st-ai-image-${Math.random().toString(36).slice(2, 10)}` };
}

/**
 * 执行一次自建服务生成。返回与 generateMedia 相同的形状：图片 { url: dataURL }，视频 { blob }。
 * @param {{ viaTavern: boolean, tavernHeaders: () => Promise<object> | object, fetch?: typeof fetch, signal?: AbortSignal, onProgress?: (text: string) => void, timeout?: number }} io
 */
export async function runSelfHosted(plan, io) {
    const { viaTavern, tavernHeaders, signal, onProgress } = io;
    const request = io.fetch || fetch;
    const deadline = Date.now() + Math.min(30 * 60000, Math.max(30000, Number(io.timeout) || (plan.kind === 'video' ? 900000 : 300000)));
    const finish = async (blob) => (plan.kind === 'video' ? { blob } : { url: await blobToDataUrl(blob) });

    if (plan.provider === 'sdwebui') {
        onProgress?.(viaTavern ? '生成中（经酒馆转发）' : '生成中');
        const data = viaTavern
            ? await readJson(await request('/api/sd/generate', { method: 'POST', headers: await tavernHeaders(), body: JSON.stringify({ ...plan.body, url: plan.root, auth: plan.auth }), signal, cache: 'no-store' }), 'SD WebUI（经酒馆）')
            : await readJson(await request(`${plan.root}/sdapi/v1/txt2img`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(plan.auth ? { Authorization: `Basic ${btoa(unescape(encodeURIComponent(plan.auth)))}` } : {}) }, body: JSON.stringify(plan.body), signal, cache: 'no-store' }), 'SD WebUI');
        const image = Array.isArray(data?.images) ? data.images[0] : null;
        if (!image) throw new Error('SD WebUI 没有返回图片');
        return { url: String(image).startsWith('data:') ? image : `data:image/png;base64,${image}` };
    }

    const body = JSON.stringify({ client_id: plan.clientId, prompt: plan.workflow });
    if (viaTavern) {
        // 酒馆后端一次跑完整个任务：提交、轮询、取回第一个输出，期间没有进度可报
        onProgress?.('生成中（经酒馆转发，完成前没有进度）');
        const data = await readJson(await request('/api/sd/comfy/generate', { method: 'POST', headers: await tavernHeaders(), body: JSON.stringify({ url: plan.root, prompt: body }), signal, cache: 'no-store' }), 'ComfyUI（经酒馆）');
        if (!data?.data) throw new Error('ComfyUI 没有返回结果');
        const type = mimeOf(data.format, plan.kind);
        if (plan.kind === 'video' && !type.startsWith('video/') && type !== 'image/gif') throw new Error(`工作流输出的是 ${data.format || '图片'}，不是视频；请检查工作流的输出节点`);
        return finish(base64ToBlob(data.data, type));
    }

    // 浏览器直连：只带 Content-Type，别的头会触发预检
    const submit = await readJson(await request(`${plan.root}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal, cache: 'no-store' }), 'ComfyUI');
    if (submit?.node_errors && Object.keys(submit.node_errors).length) throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(submit.node_errors).slice(0, 300)}`);
    const id = submit?.prompt_id;
    if (!id) throw new Error('ComfyUI 没有返回任务 ID');
    const started = Date.now();
    while (true) {
        signal?.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`等待超时；任务 ${id} 可能仍在 ComfyUI 里运行`);
        const history = await readJson(await request(`${plan.root}/history/${encodeURIComponent(id)}`, { signal, cache: 'no-store' }), 'ComfyUI');
        const item = history?.[id];
        if (item?.status?.status_str === 'error') {
            const detail = (item.status.messages || []).filter((m) => m?.[0] === 'execution_error').map((m) => `${m[1]?.node_type || ''}: ${m[1]?.exception_message || ''}`).join('；');
            throw new Error(`ComfyUI 执行出错${detail ? `：${detail}` : ''}`);
        }
        if (item?.status?.completed || (item?.outputs && Object.keys(item.outputs).length && item?.status?.status_str === 'success')) {
            const output = pickComfyOutput(item.outputs, plan.kind);
            if (!output) throw new Error(plan.kind === 'video' ? '工作流没有视频输出（需要 VHS Video Combine 或 SaveVideo 这类节点）' : '工作流没有图片输出（需要 SaveImage 节点）');
            onProgress?.('下载结果…');
            const qs = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
            const res = await request(`${plan.root}/view?${qs}`, { signal, cache: 'no-store' });
            if (!res.ok) throw new Error(`下载 ComfyUI 输出失败 HTTP ${res.status}`);
            const raw = await res.blob();
            const ext = output.filename.split('.').pop();
            return finish(raw.type && raw.type !== 'application/octet-stream' ? raw : new Blob([raw], { type: mimeOf(ext, plan.kind) }));
        }
        onProgress?.(`生成中 · 已等 ${Math.round((Date.now() - started) / 1000)} 秒`);
        await sleep(plan.kind === 'video' ? 3000 : 1000, signal);
    }
}

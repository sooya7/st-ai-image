/**
 * 设置页：字段双向绑定 + API 预设 + 模型列表。
 * 所有写入都走 settings.js，这里不直接碰存储。
 */
import { fetchModelList } from '../api/images.js';
import { LIMITS } from '../core/constants.js';
import { errMsg, notify } from '../core/notify.js';
import { switchImageProvider } from '../core/image-profiles.js';
import { NEEDS_PROXY, UNAVAILABLE_NOTE, isTauriTavern } from '../media/availability.js';
import { isValidApiBaseUrl } from '../core/text.js';
import {
    getPresets, getSettings, removePreset, saveSettings, updateSetting, upsertPreset,
} from '../settings.js';
import { debounce, el, qs, replaceContent, setBusy } from './dom.js';

/** 表单字段 → 设置键。text/textarea 走防抖 input，其余走 change。 */
const FIELDS = [
    { id: 'st_gpt_image_provider', key: 'imageProvider', kind: 'select' },
    { id: 'st_gpt_image_params', key: 'imageParams', kind: 'text' },
    { id: 'st_gpt_image_sd_auth', key: 'sdAuth', kind: 'text' },
    { id: 'st_gpt_image_via_st', key: 'selfHostedViaSt', kind: 'bool' },
    { id: 'st_gpt_image_api_base', key: 'apiBase', kind: 'text' },
    { id: 'st_gpt_image_api_key', key: 'apiKey', kind: 'text' },
    { id: 'st_gpt_image_model', key: 'model', kind: 'text' },
    { id: 'st_gpt_image_enabled', key: 'enabled', kind: 'bool' },
    { id: 'st_gpt_image_auto_detect', key: 'autoDetect', kind: 'bool' },
    { id: 'st_gpt_image_size', key: 'size', kind: 'select' },
    { id: 'st_gpt_image_quality', key: 'quality', kind: 'select' },
];

const [MIN_SEC, MAX_SEC] = LIMITS.timeoutRangeSec;
const clampSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return Math.round(LIMITS.imageGenTimeoutMs / 1000);
    return Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(seconds)));
};

/** 把设置写进表单控件。 */
function fillForm(settings) {
    for (const field of FIELDS) {
        const node = qs(`#${field.id}`);
        if (!node) continue;
        if (field.kind === 'bool') node.checked = Boolean(settings[field.key]);
        else node.value = String(settings[field.key] ?? '');
    }
    const timeout = qs('#st_gpt_image_timeout');
    if (timeout) timeout.value = String(clampSeconds(Number(settings.imageTimeout || LIMITS.imageGenTimeoutMs) / 1000));
    syncProviderFields(settings.imageProvider, settings);
}

const OPENAI_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const SD_SIZES = ['832x1216', '1216x832', '1024x1024', '896x1152', '1152x896', '768x1344', '1344x768', '512x768', '768x512'];
const NAI_SIZES = ['832x1216', '1216x832', '1024x1024', '512x768', '768x512', '640x640', '1024x1536', '1536x1024', '1472x1472'];

/** 每个接口自己的说明、地址/Key/模型的叫法和提示、尺寸选项。没写的用 relay 那份。 */
const PROVIDER_UI = {
    relay: {
        base: ['API 地址', 'https://your-proxy.com/v1'], key: ['API Key（本机或局域网地址可以留空）', 'sk-...'], model: 'gpt-image-2', sizes: OPENAI_SIZES,
        params: '按模型文档填写，会合并进请求体；不要填写密钥。',
    },
    auto: { hint: '依次试 /v1/images/generations 和 /v1/chat/completions，只在端点明确不支持（404/405/501）时才换下一个。不确定中转站走哪个接口时用这个。' },
    openai: { hint: 'OpenAI 官方或兼容中转的 /v1/images/generations。' },
    chat: { hint: '走 /v1/chat/completions，适合只在聊天接口出图的中转（Gemini 图片模型等）。', model: 'gemini-2.5-flash-image', sizes: null },
    gemini: {
        hint: 'Google 官方 generateContent，Key 在 Google AI Studio 获取。', base: ['API 地址（留空用官方）', 'https://generativelanguage.googleapis.com/v1beta'],
        key: ['Gemini API Key', 'AIza...'], model: 'gemini-2.5-flash-image', sizes: null, params: '合并进 generationConfig。',
    },
    novelai: {
        hint: '需要 NovelAI 订阅。令牌在 NovelAI 网页：设置 → Account → Get Persistent API Token。Opus 会员在 1024×1024 以内、28 步以内不扣 Anlas。官方接口允许跨域，TauriTavern 也能直接连。',
        base: ['接口地址（留空用官方；用反代就填反代地址）', 'https://image.novelai.net'], key: ['NovelAI 令牌', 'pst-...'],
        model: 'nai-diffusion-4-5-full', sizes: NAI_SIZES,
        params: '合并进 parameters，例如 {"steps":28,"scale":5,"sampler":"k_euler_ancestral","qualityToggle":false}。默认 28 步、CFG 5、自动加质量词。',
    },
    comfyui: {
        hint: '本机或局域网的 ComfyUI，默认经酒馆后端转发，不用开跨域。Anima、SDXL、Flux 等本地模型都走这里，模型写在工作流里。',
        base: ['ComfyUI 地址', 'http://127.0.0.1:8188'], model: '工作流里写了 %MODEL_NAME% 才用', sizes: SD_SIZES,
        params: '填占位符的值，例如 {"steps":28} 会填进 %steps%；也能自定义占位符。',
    },
    sdwebui: {
        hint: 'A1111 / Forge / SD.Next，启动参数要加 --api。默认经酒馆后端转发，不用开跨域。',
        base: ['WebUI 地址', 'http://127.0.0.1:7860'], model: '留空用 WebUI 当前选中的模型', sizes: SD_SIZES,
        params: 'txt2img 参数，例如 {"steps":28,"cfg_scale":6,"sampler_name":"DPM++ 2M"}。',
    },
    minimax: {
        hint: 'MiniMax 开放平台的 Key，允许浏览器直连。模型 image-01（image-01-live 只有国内）；宽高 512–2048。海外账号把地址改成 https://api.minimax.io。',
        base: ['接口地址', 'https://api.minimax.cn'], key: ['MiniMax API Key', ''], model: 'image-01', sizes: ['1024x1024', '768x1344', '1344x768', '864x1152', '1152x864', '720x1280', '1280x720'],
        params: '合并进请求体，例如 {"prompt_optimizer":true} 或 {"aspect_ratio":"16:9"}（写了比例就不按尺寸）。',
    },
    dashscope: {
        hint: '阿里云百炼的 Key，允许浏览器直连。万相（wan2.2-t2i-flash 等）是异步任务；qwen-image 系列同步出图，尺寸只收 1328x1328、1664x928、928x1664、1472x1104、1104x1472。国际站把地址改成 https://dashscope-intl.aliyuncs.com，Key 分地域。',
        base: ['接口地址', 'https://dashscope.aliyuncs.com'], key: ['百炼 API Key', 'sk-...'], model: 'wan2.2-t2i-flash',
        sizes: ['1024x1024', '768x1344', '1344x768', '1328x1328', '1664x928', '928x1664', '1472x1104', '1104x1472'],
        params: '合并进 parameters，例如 {"prompt_extend":true,"seed":42}。',
    },
    stability: {
        hint: 'Stability AI 官方接口，允许浏览器直连。模型栏填 core / ultra，或 sd3.5-large / sd3.5-large-turbo / sd3.5-medium；尺寸按比例换算成最接近的 aspect_ratio。请求是表单，不能走酒馆代理。',
        base: ['接口地址', 'https://api.stability.ai'], key: ['Stability API Key', 'sk-...'], model: 'core', sizes: ['1024x1024', '1216x832', '832x1216', '1344x768', '768x1344', '1536x640', '640x1536'],
        params: '作为表单字段附加，例如 {"style_preset":"anime","seed":42}。',
    },
    pollinations: {
        hint: '免费生图，不填 Key 也能用：地址留空时，没 Key 走 image.pollinations.ai（匿名，2026-09-28 实测可用，不保证一直能用），有 Key 走 gen.pollinations.ai（更快、模型更多）。模型留空用默认，点刷新能拉模型列表。',
        base: ['接口地址（留空自动选）', '留空：没 Key 用 image.pollinations.ai，有 Key 用 gen.pollinations.ai'], key: ['Pollinations Key（可留空）', 'sk_...'], model: '留空用默认模型', sizes: SD_SIZES,
        params: '附加到链接参数里，例如 {"enhance":"true"}。',
    },
    horde: {
        hint: '众包的免费算力（aihorde.net），不填 Key 用匿名身份，排队可能很久；注册拿 Key 并贡献算力后会快很多。模型留空由 worker 决定，点刷新能按在线 worker 数拉模型列表。宽高会取整到 64 的倍数。',
        base: ['接口地址', 'https://aihorde.net'], key: ['AI Horde Key（可留空）', '留空用匿名 0000000000'], model: '留空不指定', sizes: ['512x768', '768x512', '512x512', '832x1216', '1216x832', '1024x1024'],
        params: '合并进请求体；采样参数写在 params 里，例如 {"params":{"steps":30,"sampler_name":"k_dpmpp_2m"}}。',
    },
    fal: { hint: 'fal 队列接口。', base: ['API 地址（留空用官方）', 'https://queue.fal.run'], key: ['fal Key', ''], model: 'fal-ai/flux/dev（从模型页面复制路径）', sizes: null, params: '合并进 input，尺寸等按模型文档填。' },
    replicate: { hint: 'Replicate 预测接口。只允许 localhost 打开的酒馆直连，TauriTavern 里用不了。', base: ['API 地址（留空用官方）', 'https://api.replicate.com/v1'], key: ['Replicate API Token', 'r8_...'], model: 'owner/name 或 owner/name:version', sizes: null, params: '合并进 input，尺寸等按模型文档填。' },
};

/** 兼容 OpenAI 协议的各家：点一下填好地址、模型和参数（Key 要换成这家的）。 */
const QUICK_FILL = [
    ['OpenAI 官方', { imageProvider: 'openai', apiBase: 'https://api.openai.com/v1', model: 'gpt-image-2', size: '1024x1024', imageParams: '' }],
    ['火山即梦 Seedream', { imageProvider: 'openai', apiBase: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-0-250828', size: 'auto', imageParams: '{"size":"2K","watermark":false,"response_format":"b64_json"}' }],
    ['智谱 CogView', { imageProvider: 'openai', apiBase: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4-250304', size: '1024x1024', imageParams: '' }],
    ['硅基流动', { imageProvider: 'openai', apiBase: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors', size: 'auto', imageParams: '{"image_size":"1024x1024"}' }],
    ['xAI Grok', { imageProvider: 'openai', apiBase: 'https://api.x.ai/v1', model: 'grok-imagine-image-2.0', size: 'auto', imageParams: '{"response_format":"b64_json"}' }],
    ['Together', { imageProvider: 'openai', apiBase: 'https://api.together.xyz/v1', model: 'black-forest-labs/FLUX.1-schnell', size: 'auto', imageParams: '{"width":1024,"height":1024,"steps":4,"response_format":"base64"}' }],
    ['Recraft', { imageProvider: 'openai', apiBase: 'https://external.api.recraft.ai/v1', model: 'recraftv3', size: '1024x1024', imageParams: '{"response_format":"b64_json"}' }],
    ['OpenRouter', { imageProvider: 'chat', apiBase: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash-image', size: 'auto', imageParams: '' }],
];

const uiFor = (provider) => ({ ...PROVIDER_UI.relay, ...PROVIDER_UI[provider] });

function setText(selector, text) {
    const node = qs(selector);
    if (node) node.textContent = text;
}

/** 尺寸下拉框换成这个接口的选项；当前值不在列表里也留着，免得被悄悄改掉。 */
function renderSizeOptions(sizes, current) {
    const select = qs('#st_gpt_image_size');
    if (!select || !sizes) return;
    const list = current && !sizes.includes(current) ? [current, ...sizes] : sizes;
    replaceContent(select, ...list.map((size) => el('option', { value: size, text: size === 'auto' ? 'Auto' : size })));
    select.value = current && list.includes(current) ? current : list[0];
}

/** TauriTavern 里藏起只能走酒馆代理的接口；当前选中的留着并注明。 */
function syncProviderOptions(current) {
    const tauri = isTauriTavern();
    for (const option of document.querySelectorAll('#st_gpt_image_provider option')) {
        option.dataset.label ??= option.textContent;
        const blocked = tauri && NEEDS_PROXY.image.includes(option.value);
        option.hidden = blocked && option.value !== current;
        option.textContent = option.dataset.label + (blocked ? UNAVAILABLE_NOTE : '');
    }
}

/** 按接口显示字段：data-show-for 只在这些接口下显示，data-hide-for 在这些接口下隐藏；再换上这个接口的叫法和提示。 */
function syncProviderFields(provider, settings) {
    for (const node of document.querySelectorAll('#st_ai_float_panel [data-show-for], #st_ai_float_panel [data-hide-for]')) {
        const show = node.dataset.showFor?.split(/\s+/);
        const hide = node.dataset.hideFor?.split(/\s+/);
        node.classList.toggle('st_ai_hidden', show ? !show.includes(provider) : hide.includes(provider));
    }
    syncProviderOptions(provider);
    const ui = uiFor(provider);
    setText('#st_gpt_image_provider_hint', ui.hint || '');
    setText('#st_gpt_image_api_base_label', ui.base[0]);
    setText('#st_gpt_image_api_key_label', ui.key[0]);
    setText('#st_gpt_image_params_hint', ui.params);
    qs('#st_gpt_image_api_base')?.setAttribute('placeholder', ui.base[1]);
    qs('#st_gpt_image_api_key')?.setAttribute('placeholder', ui.key[1]);
    qs('#st_gpt_image_model')?.setAttribute('placeholder', ui.model);
    renderSizeOptions(ui.sizes, settings?.size);
}

function renderPresetOptions(selected = '') {
    const select = qs('#st_gpt_preset_select');
    if (!select) return;
    const names = Object.keys(getPresets()).sort();
    replaceContent(select, el('option', { value: '', text: names.length ? '— 选择预设 —' : '— 暂无预设 —' }),
        ...names.map((name) => el('option', { value: name, text: name })));
    select.value = names.includes(selected) ? selected : '';
}

/** 拉到模型后才显示这个下拉框；选中项跟当前配置的模型对齐。 */
function renderModelOptions(models, selected = '') {
    const select = qs('#st_gpt_model_list');
    if (!select) return;
    replaceContent(select, el('option', { value: '', text: `— 选择模型（共 ${models.length} 个）—` }),
        ...models.map((m) => el('option', { value: m.id, text: m.name || m.id })));
    select.value = models.some((m) => m.id === selected) ? selected : '';
    select.classList.toggle('st_ai_hidden', models.length === 0);
}

/**
 * 绑定设置页所有交互。
 * @param {(key: string) => void} [onChange] 设置变更后的回调（index.js 用来重算提示词注入）
 */
export async function bindSettingsForm(onChange) {
    const settings = await getSettings();
    fillForm(settings);
    renderPresetOptions();
    renderModelOptions([]);

    // 一键填写：先把当前这组存成 API 预设（有地址和 Key 才存），再填上这家的地址、模型、参数，Key 清空等你填
    const quick = qs('#st_gpt_image_quick');
    if (quick && !quick.firstChild) {
        quick.append(el('span', { class: 'st_ai_speech_hint', text: '一键填写：' }), ...QUICK_FILL.map(([name, values]) => el('button', {
            type: 'button', class: 'st_ai_btn st_ai_library_btn', text: name, title: `填上 ${name} 的地址和常用模型；当前配置会先存成 API 预设`,
            onclick: async () => {
                await flushPending();
                const current = await getSettings();
                let savedAs = '';
                if (current.apiBase && current.apiKey && current.apiBase !== values.apiBase) {
                    const exists = Object.values(getPresets()).some((p) => p.apiBase === current.apiBase && p.apiKey === current.apiKey);
                    if (!exists) {
                        savedAs = `自动保存 ${(() => { try { return new URL(current.apiBase).host; } catch { return current.apiBase; } })()}`;
                        upsertPreset(savedAs, current);
                        renderPresetOptions();
                    }
                }
                const sameVendor = current.apiBase === values.apiBase;
                await saveSettings({ ...switchImageProvider(current, values.imageProvider), ...values, apiKey: sameVendor ? current.apiKey : '' });
                fillForm(await getSettings());
                onChange?.('imageProvider');
                notify.success(`已填好 ${name}，${sameVendor ? '' : '再填上这家的 Key；'}${savedAs ? `原来的配置存成了预设「${savedAs}」` : ''}`.replace(/[，；]$/, ''));
            },
        })));
    }

    const commit = async (key, value) => {
        await updateSetting(key, value);
        onChange?.(key);
    };
    // 文本框是防抖保存的；换接口、套预设前先把还没保存的立刻存进当前接口
    const pending = [];
    const flushPending = async () => {
        for (const save of pending) save.cancel();
        for (const field of FIELDS.filter((f) => f.kind === 'text')) {
            const node = qs(`#${field.id}`);
            if (!node) continue;
            const value = node.value.trim();
            if (field.key === 'apiBase' && !isValidApiBaseUrl(value)) continue;
            if (field.key === 'imageParams') {
                try { const data = JSON.parse(value || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) continue; } catch { continue; }
            }
            if ((await getSettings())[field.key] !== value) await updateSetting(field.key, value);
        }
    };

    for (const field of FIELDS) {
        const node = qs(`#${field.id}`);
        if (!node || field.key === 'imageProvider') continue;
        if (field.kind === 'bool') {
            node.addEventListener('change', () => commit(field.key, node.checked));
        } else if (field.kind === 'select') {
            node.addEventListener('change', () => commit(field.key, node.value));
        } else {
            const save = debounce(() => {
                const value = node.value.trim();
                if (field.key === 'apiBase' && !isValidApiBaseUrl(value)) {
                    notify.warn('API 地址需要以 http:// 或 https:// 开头');
                    return;
                }
                if (field.key === 'imageParams') {
                    try { const data = JSON.parse(value || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); }
                    catch { notify.warn('额外模型参数必须是 JSON 对象'); return; }
                }
                commit(field.key, value);
            }, 400);
            pending.push(save);
            node.addEventListener('input', save);
        }
    }
    // 换接口：地址、Key、模型、额外参数、尺寸换成这个接口上次的（中转类接口共用一组）
    qs('#st_gpt_image_provider')?.addEventListener('change', async (e) => {
        await flushPending();
        await saveSettings(switchImageProvider(await getSettings(), e.target.value));
        renderModelOptions([]);
        fillForm(await getSettings());
        onChange?.('imageProvider');
    });

    const timeout = qs('#st_gpt_image_timeout');
    timeout?.addEventListener('change', () => {
        const seconds = clampSeconds(timeout.value);
        timeout.value = String(seconds);
        commit('imageTimeout', seconds * 1000);
    });

    /* ---------- 预设 ---------- */

    qs('#st_gpt_preset_select')?.addEventListener('change', async (e) => {
        const name = e.target.value;
        if (!name) return;
        const preset = getPresets()[name];
        if (!preset) return renderPresetOptions();
        await flushPending();
        // 先按换接口处理（把当前接口的设置存好），再套预设的值
        const current = switchImageProvider(await getSettings(), preset.imageProvider || 'auto');
        await saveSettings({ ...current, apiBase: preset.apiBase, apiKey: preset.apiKey, model: preset.model || current.model, imageParams: preset.imageParams || '' });
        fillForm(await getSettings());
        notify.success(`已应用预设「${name}」`);
        onChange?.('preset');
    });

    qs('#st_gpt_preset_save')?.addEventListener('click', async () => {
        const current = await getSettings();
        if (!current.apiBase && !current.apiKey) return notify.warn('先填写 API 地址和 Key 再保存预设');
        const name = String(prompt('预设名称：', qs('#st_gpt_preset_select')?.value || '') ?? '').trim();
        if (!name) return;
        if (!upsertPreset(name, current)) return notify.error('保存预设失败');
        renderPresetOptions(name);
        notify.success(`预设「${name}」已保存`);
    });

    qs('#st_gpt_preset_delete')?.addEventListener('click', () => {
        const name = qs('#st_gpt_preset_select')?.value;
        if (!name) return notify.warn('先选中要删除的预设');
        if (!confirm(`删除预设「${name}」？`)) return;
        if (!removePreset(name)) return notify.error('删除预设失败');
        renderPresetOptions();
        notify.success('预设已删除');
    });

    /* ---------- 模型列表 ---------- */

    const fetchBtn = qs('#st_gpt_fetch_models');
    fetchBtn?.addEventListener('click', async () => {
        setBusy(fetchBtn, true);
        try {
            const models = await fetchModelList();
            renderModelOptions(models, (await getSettings()).model);
            notify.success(models.length ? `拉到 ${models.length} 个模型，在下方列表里选` : '接口返回空列表');
        } catch (e) {
            renderModelOptions([]);
            notify.error(`获取模型失败: ${errMsg(e)}`);
        } finally {
            setBusy(fetchBtn, false);
        }
    });

    qs('#st_gpt_model_list')?.addEventListener('change', (e) => {
        const model = e.target.value;
        if (!model) return;
        const input = qs('#st_gpt_image_model');
        if (input) input.value = model;
        commit('model', model);
    });
}

/** 外部改了设置（比如预设、图库超时）后刷新表单显示。 */
export async function refreshSettingsForm() {
    fillForm(await getSettings());
}

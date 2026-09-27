/**
 * 图片接口各记各的：地址、Key、模型、额外参数、尺寸按接口分组保存，切接口时换成那个接口上次的设置。
 * OpenAI / Chat / Gemini / 旧版兼容常常是同一个中转站、同一把 Key，所以它们共用一组。
 * 纯函数，不碰 DOM 和存储。
 */

export const PROFILE_KEYS = ['apiBase', 'apiKey', 'model', 'imageParams', 'size'];

const RELAY = new Set(['auto', 'openai', 'chat', 'gemini']);
export const profileGroup = (provider) => (!provider || RELAY.has(provider) ? 'relay' : provider);

/** 第一次切到某个接口时用的初始值。 */
const FIRST_TIME = {
    relay: { size: '1024x1024' },
    novelai: { apiBase: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full', size: '832x1216' },
    comfyui: { apiBase: 'http://127.0.0.1:8188', model: '', size: '832x1216' },
    sdwebui: { apiBase: 'http://127.0.0.1:7860', model: '', size: '832x1216' },
    minimax: { apiBase: 'https://api.minimax.cn', model: 'image-01', size: '1024x1024' },
    dashscope: { apiBase: 'https://dashscope.aliyuncs.com', model: 'wan2.2-t2i-flash', size: '1024x1024' },
    stability: { apiBase: 'https://api.stability.ai', model: 'core', size: '1024x1024' },
    pollinations: { apiBase: 'https://gen.pollinations.ai', model: '', size: '1024x1024' },
    horde: { apiBase: 'https://aihorde.net', model: '', size: '512x768' },
    fal: { apiBase: '', model: '' },
    replicate: { apiBase: '', model: '' },
};

const snapshot = (settings) => Object.fromEntries(PROFILE_KEYS.map((key) => [key, settings[key] ?? '']));

/** 换接口：先把当前这组存起来，再换上新接口那组。同组之间只改 imageProvider。 */
export function switchImageProvider(settings, next) {
    const from = profileGroup(settings.imageProvider);
    const to = profileGroup(next);
    if (from === to) return { ...settings, imageProvider: next };
    const profiles = { ...(settings.imageProfiles || {}), [from]: snapshot(settings) };
    const saved = profiles[to];
    const loaded = saved && typeof saved === 'object'
        ? snapshot({ ...settings, ...saved })
        : { apiBase: '', apiKey: '', model: '', imageParams: '', size: settings.size, ...FIRST_TIME[to] };
    return { ...settings, ...loaded, imageProvider: next, imageProfiles: profiles };
}

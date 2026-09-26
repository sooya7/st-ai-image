/**
 * 语音/视频设置。与图片设置一样存在 extensionSettings（随酒馆 settings.json 落盘），
 * 每个服务一套独立的地址/密钥/模型，切换服务不会串配置。
 */

export const DEFAULT_VOICE_PROMPT = `## 语音标签
需要配音的角色台词用 [voice]台词[/voice] 包裹：只包裹角色说出口的原话，不包含动作、心理和旁白。每条回复最多 2 处，其余正文照常输出。`;

export const DEFAULT_VIDEO_PROMPT = `## 视频标签
剧情出现关键的动态场景时，可在该段后附加一条 [video]画面描述[/video]，用一两句话写清主体、动作、镜头运动和环境光线。不要每条回复都添加。`;

export const MEDIA_DEFAULTS = {
    speech: {
        enabled: true, provider: 'openai', proxy: false, autoInject: false, prompt: DEFAULT_VOICE_PROMPT,
        profiles: {
            openai: { base: 'https://api.openai.com/v1', key: '', model: 'tts-1', voice: 'alloy', language: '', extra: '' },
            fish: { base: 'https://api.fish.audio/v1', key: '', model: 's2.1-pro-free', voice: '', language: '', extra: '' },
            elevenlabs: { base: 'https://api.elevenlabs.io/v1', key: '', model: 'eleven_multilingual_v2', voice: '', language: '', extra: '' },
            azure: { base: '', key: '', model: '', voice: 'zh-CN-XiaoxiaoNeural', language: 'zh-CN', extra: '' },
        },
    },
    video: {
        enabled: true, provider: 'runway', proxy: false, autoInject: false, prompt: DEFAULT_VIDEO_PROMPT, timeout: '600',
        profiles: {
            runway: { base: 'https://api.dev.runwayml.com/v1', key: '', model: 'gen4.5', size: '1280:720', seconds: '5', extra: '' },
            agnes: { base: 'https://apihub.agnes-ai.com/v1', key: '', model: 'agnes-video-2.5-flash', size: '720P', seconds: '5', extra: '' },
            fal: { base: 'https://queue.fal.run', key: '', model: '', size: '', seconds: '', extra: '' },
            replicate: { base: 'https://api.replicate.com/v1', key: '', model: '', size: '', seconds: '', extra: '' },
            openai: { base: '', key: '', model: 'sora-2', size: '1280x720', seconds: '4', extra: '' },
        },
    },
};

const str = (value, fallback, max = 20000) => (typeof value === 'string' ? value.slice(0, max) : fallback);

/** 读取时总是按默认值补齐，老数据缺字段、字段类型不对都不会让界面崩。 */
export function readMediaSettings(settings, section) {
    const defaults = MEDIA_DEFAULTS[section];
    const saved = settings?.[section] && typeof settings[section] === 'object' ? settings[section] : {};
    const profiles = {};
    for (const [id, fields] of Object.entries(defaults.profiles)) {
        profiles[id] = {};
        for (const [field, fallback] of Object.entries(fields)) profiles[id][field] = str(saved.profiles?.[id]?.[field], fallback, 4096);
    }
    return {
        enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
        proxy: saved.proxy === true,
        autoInject: saved.autoInject === true,
        prompt: str(saved.prompt, defaults.prompt),
        provider: Object.hasOwn(defaults.profiles, saved.provider) ? saved.provider : defaults.provider,
        ...(section === 'video' ? { timeout: str(saved.timeout, defaults.timeout, 8) } : {}),
        profiles,
    };
}

/** 当前服务的请求配置，直接交给 generateMedia。 */
export function mediaRequestConfig(media, provider = media.provider) {
    const profile = media.profiles[provider];
    return { ...profile, provider, proxy: media.proxy, ...(media.timeout ? { timeout: Number(media.timeout) * 1000 } : {}) };
}

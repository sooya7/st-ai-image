/**
 * 语音/视频设置。与图片设置一样存在 extensionSettings（随酒馆 settings.json 落盘），
 * 每个服务一套独立的地址/密钥/模型，切换服务不会串配置。
 */
import { blankPresets, fishPresets, isFishEndpoint, normalizePresets, usableTypes } from './voice-presets.js';

/** 提示词里的占位符：注入时换成当前服务音色预设表里已配音色的类型名。 */
export const VOICE_TYPES_TOKEN = '{{音色类型}}';

export const DEFAULT_VOICE_PROMPT = `## 语音标签
角色说出一句有分量的台词时，用 [voice type="音色类型"]台词[/voice] 把这句原话包起来，界面会用对应的声音为它配音。

音色类型只能从这些里选：${VOICE_TYPES_TOKEN}
按说话角色的性别、年龄和性格挑最贴合的一个，同一个角色每次都用同一个；实在没有合适的就不写 type。

什么时候加：
- 情绪强烈的话：表白、争吵、哭诉、怒吼、撒娇、道歉
- 推动剧情的关键台词：宣告、承诺、揭示秘密、做出决定
- 角色登场或换场后开口的第一句

什么时候不加：
- 旁白、动作、神态、心理活动
- 用户扮演的角色说的话
- "嗯""好的""是吗"这类附和、寒暄
- 这条回复里没有值得配音的台词时，一处都不加

写法：
- 只包裹说出口的原话，引号、说话人和动作写在标签外，例如：林晚攥紧衣角，小声说："[voice type="青涩少女"]别走，好不好？[/voice]"
- 一个标签只放一个角色的一句或一小段连续的话，不超过 60 字
- 标签里的台词就是正文，不要在标签外再写一遍
- 每条回复最多 2 处；几个角色都有关键台词时，可以各加一处`;

/** 0027222 的默认值：类型列表写死在提示词里。 */
const VOICE_PROMPT_TYPED = `## 语音标签
角色说出一句有分量的台词时，用 [voice type="音色类型"]台词[/voice] 把这句原话包起来，界面会用对应的声音为它配音。

音色类型只能从下面选，按说话角色的性别、年龄和性格挑最贴合的一个；同一个角色每次都用同一个：
- 女声：日常女声、萝莉、青涩少女、活泼少女、温柔女声、御姐、成熟女声、老年女声
- 男声：少年、青年男声、成熟男声、大叔、老年男声

什么时候加：
- 情绪强烈的话：表白、争吵、哭诉、怒吼、撒娇、道歉
- 推动剧情的关键台词：宣告、承诺、揭示秘密、做出决定
- 角色登场或换场后开口的第一句

什么时候不加：
- 旁白、动作、神态、心理活动
- 用户扮演的角色说的话
- "嗯""好的""是吗"这类附和、寒暄
- 这条回复里没有值得配音的台词时，一处都不加

写法：
- 只包裹说出口的原话，引号、说话人和动作写在标签外，例如：林晚攥紧衣角，小声说："[voice type="青涩少女"]别走，好不好？[/voice]"
- 一个标签只放一个角色的一句或一小段连续的话，不超过 60 字
- 标签里的台词就是正文，不要在标签外再写一遍
- 每条回复最多 2 处；几个角色都有关键台词时，可以各加一处`;

/** d5b76cf 的默认值：按角色名查音色表。 */
const VOICE_PROMPT_NAMED = `## 语音标签
角色说出一句有分量的台词时，用 [voice name="说话角色的名字"]台词[/voice] 把这句原话包起来，界面会用这个角色的音色为它配音。

什么时候加：
- 情绪强烈的话：表白、争吵、哭诉、怒吼、撒娇、道歉
- 推动剧情的关键台词：宣告、承诺、揭示秘密、做出决定
- 角色登场或换场后开口的第一句

什么时候不加：
- 旁白、动作、神态、心理活动
- 用户扮演的角色说的话
- "嗯""好的""是吗"这类附和、寒暄
- 这条回复里没有值得配音的台词时，一处都不加

写法：
- name 写说话角色的名字，与角色卡和设定里的写法一致，同一个角色每次都用同一个名字；不要写"她""少女"这类代称
- 只包裹说出口的原话，引号、说话人和动作写在标签外，例如：林晚攥紧衣角，小声说："[voice name="林晚"]别走，好不好？[/voice]"
- 一个标签只放一个角色的一句或一小段连续的话，不超过 60 字
- 标签里的台词就是正文，不要在标签外再写一遍
- 每条回复最多 2 处；几个角色都有关键台词时，可以各加一处`;

/** 2026-09-28 b624b98 的默认值：单音色时代，只给主要角色配音。 */
const VOICE_PROMPT_SINGLE = `## 语音标签
角色说出一句有分量的台词时，用 [voice]台词[/voice] 把这句原话包起来，界面会为它生成配音。

什么时候加：
- 情绪强烈的话：表白、争吵、哭诉、怒吼、撒娇、道歉
- 推动剧情的关键台词：宣告、承诺、揭示秘密、做出决定
- 角色登场或换场后开口的第一句

什么时候不加：
- 旁白、动作、神态、心理活动
- 用户扮演的角色说的话
- "嗯""好的""是吗"这类附和、寒暄
- 这条回复里没有值得配音的台词时，一处都不加
- 配音只有一种音色，多个角色在场时只给主要角色加

写法：
- 只包裹说出口的原话，引号、说话人和动作写在标签外，例如：她攥紧衣角，小声说："[voice]别走，好不好？[/voice]"
- 一个标签只放一句或一小段连续的话，不超过 60 字
- 标签里的台词就是正文，不要在标签外再写一遍
- 每条回复最多 2 处`;

/** 以前版本的默认提示词。存档里原样是这些文本的，读取时换成当前默认值。 */
const LEGACY_PROMPTS = {
    speech: [`## 语音标签
需要配音的角色台词用 [voice]台词[/voice] 包裹：只包裹角色说出口的原话，不包含动作、心理和旁白。每条回复最多 2 处，其余正文照常输出。`, VOICE_PROMPT_SINGLE, VOICE_PROMPT_NAMED, VOICE_PROMPT_TYPED],
    video: [],
};

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
            // 自建 ComfyUI：workflow 是「导出 (API)」的 JSON；direct='1' 表示浏览器直连，默认经酒馆后端转发
            comfyui: { base: 'http://127.0.0.1:8188', key: '', model: '', size: '832x480', seconds: '5', extra: '', workflow: '', direct: '' },
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
        for (const [field, fallback] of Object.entries(fields)) profiles[id][field] = str(saved.profiles?.[id]?.[field], fallback, field === 'workflow' ? 400000 : 4096);
        if (section === 'speech') {
            // 音色预设表：存过就用存的；没存过按服务给初始表（Fish 带推荐音色，其他只有类型名）
            profiles[id].presets = normalizePresets(saved.profiles?.[id]?.presets)
                ?? (isFishEndpoint(id, profiles[id].base) ? fishPresets() : blankPresets());
        }
    }
    return {
        enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
        proxy: saved.proxy === true,
        autoInject: saved.autoInject === true,
        prompt: LEGACY_PROMPTS[section].includes(saved.prompt) ? defaults.prompt : str(saved.prompt, defaults.prompt),
        provider: Object.hasOwn(defaults.profiles, saved.provider) ? saved.provider : defaults.provider,
        ...(section === 'video' ? { timeout: str(saved.timeout, defaults.timeout, 8) } : {}),
        profiles,
    };
}

/** 注入前把提示词里的 {{音色类型}} 换成当前服务已配音色的类型名。 */
export function renderVoicePrompt(prompt, presets) {
    const types = usableTypes(presets);
    return String(prompt ?? '').replaceAll(VOICE_TYPES_TOKEN, types.length ? types.join('、') : '（暂未配置音色类型，不要写 type）');
}

/** 当前服务的请求配置，直接交给 generateMedia。 */
export function mediaRequestConfig(media, provider = media.provider) {
    const profile = media.profiles[provider];
    return { ...profile, provider, proxy: media.proxy, ...(media.timeout ? { timeout: Number(media.timeout) * 1000 } : {}) };
}

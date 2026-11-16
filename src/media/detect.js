/**
 * 「自动识别」：用户只填地址和 Key，按地址的域名认出是哪家服务。
 * 认不出的一律当 OpenAI 兼容（各中转站、new-api、one-api 都是这种）。
 * 纯函数，页面加载就会用到，不碰网络。
 */

/** 下拉框里单独列出的：要填工作流、令牌格式或本地参数，没法和别家合并。其余都藏进「自动识别」。 */
export const STANDALONE = {
    image: ['auto', 'novelai', 'comfyui', 'sdwebui'],
    audio: ['auto', 'gptsovits'],
    video: ['auto', 'comfyui'],
};

export const AUTO_LABEL = '自动识别（填地址和 Key 就行）';

const RULES = {
    image: [
        [/(^|\.)novelai\.net$/, 'novelai'],
        [/(^|\.)minimaxi?\.(cn|com|chat)$/, 'minimax'],
        [/(^|\.)dashscope(-intl)?\.aliyuncs\.com$/, 'dashscope'],
        [/(^|\.)stability\.ai$/, 'stability'],
        [/(^|\.)pollinations\.ai$/, 'pollinations'],
        [/(^|\.)aihorde\.net$/, 'horde'],
        [/(^|\.)fal\.(run|ai)$/, 'fal'],
        [/(^|\.)replicate\.com$/, 'replicate'],
        [/(^|\.)generativelanguage\.googleapis\.com$/, 'gemini'],
        [/(^|\.)openrouter\.ai$/, 'chat'],
    ],
    audio: [
        [/(^|\.)elevenlabs\.io$/, 'elevenlabs'],
        [/(^|\.)(tts\.speech\.microsoft\.com|cognitiveservices\.azure\.com)$/, 'azure'],
        [/(^|\.)minimaxi?\.(cn|com|chat)$/, 'minimax'],
        [/(^|\.)dashscope(-intl)?\.aliyuncs\.com$/, 'dashscope'],
        [/(^|\.)generativelanguage\.googleapis\.com$/, 'gemini'],
        [/(^|\.)openspeech\.bytedance\.com$/, 'volcengine'],
    ],
    video: [
        [/(^|\.)volces\.com$/, 'ark'],
        [/(^|\.)minimaxi?\.(cn|com|chat)$/, 'minimax'],
        [/(^|\.)dashscope(-intl)?\.aliyuncs\.com$/, 'dashscope'],
        [/(^|\.)generativelanguage\.googleapis\.com$/, 'veo'],
        [/(^|\.)bigmodel\.cn$/, 'zhipu'],
        [/(^|\.)siliconflow\.(cn|com)$/, 'siliconflow'],
        [/(^|\.)lumalabs\.ai$/, 'luma'],
        [/(^|\.)fal\.(run|ai)$/, 'fal'],
        [/(^|\.)replicate\.com$/, 'replicate'],
        [/(^|\.)klingai\.com$/, 'kling'],
        [/(^|\.)vidu\.(cn|com)$/, 'vidu'],
        [/(^|\.)runwayml\.com$/, 'runway'],
    ],
};

/** 认不出时用的：图片走老的「依次试接口」，语音视频走 OpenAI 兼容。 */
const FALLBACK = { image: 'auto', audio: 'openai', video: 'openai' };

const hostOf = (base) => {
    try { return new URL(String(base || '').trim()).hostname.toLowerCase(); } catch { return ''; }
};

/** 按地址认服务。kind: image | audio | video；speech 当 audio。 */
export function detectProvider(kind, base) {
    const k = kind === 'speech' ? 'audio' : kind;
    const host = hostOf(base);
    // GPT-SoVITS 默认端口 9880，本机地址才认
    if (k === 'audio' && /:9880(\/|$)/.test(String(base || '')) && /^(localhost|127\.|10\.|192\.168\.)/.test(host)) return 'gptsovits';
    for (const [re, id] of RULES[k] || []) if (host && re.test(host)) return id;
    return FALLBACK[k];
}

/** 下拉框里要不要列出来：单独列的、或者当前正在用的老选项。 */
export const listed = (kind, value, current) => (STANDALONE[kind === 'speech' ? 'audio' : kind] || []).includes(value) || value === current;

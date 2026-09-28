/**
 * 配音的情绪：标签里的 emotion="哽咽，小声" 按各家接口能听懂的方式送过去。
 *
 * - 能听懂自然语言的（Fish S2 方括号提示、OpenAI gpt-4o-mini-tts / 百炼 instruct 的 instructions、Gemini 的提示语、
 *   硅基流动 CosyVoice 的 <|endofprompt|> 前缀）直接用原话；
 * - 只收固定枚举的（MiniMax、Azure 风格、豆包多情感音色、ElevenLabs v3 英文标签）先归到一类再换成那家的词；
 * - 归不了类或那家不支持就什么都不加，照原样合成，绝不因为情绪让请求报错。
 */

/** 归类用的关键词，按类别列出；取在描述里最先出现的那个，AI 一般把主情绪写在前面。 */
const MOODS = [
    ['sad', /苦笑|哽咽|哭|泣|啜|伤心|难过|悲|委屈|失落|心碎|低落|沮丧|落寞|凄|sad|cry|sob|tear|grie/i],
    ['angry', /愤怒|生气|怒|恼|火大|咬牙|气急|凶|吼|angry|furious|rage|mad\b/i],
    ['fearful', /害怕|恐惧|惊恐|发抖|颤抖|颤|慌|紧张|畏|fear|scared|afraid|terrif|nervous|anxious/i],
    ['surprised', /惊讶|吃惊|震惊|诧异|不敢相信|惊|surpris|shock|astonish/i],
    ['disgusted', /冷笑|厌恶|嫌弃|恶心|鄙夷|不屑|轻蔑|嘲讽|讥|disgust|contempt|sneer|sarcas/i],
    ['whisper', /耳语|低语|悄悄|小声|轻声|压低|气声|whisper|hush/i],
    ['shouting', /大喊|喊|呼喊|嚷|高声|shout|yell|scream/i],
    ['shy', /害羞|羞|腼腆|扭捏|不好意思|shy|embarrass|bashful/i],
    ['affectionate', /撒娇|娇|宠溺|甜|黏|亲昵|暧昧|affection|flirt|coy|sweet/i],
    ['excited', /激动|兴奋|雀跃|热血|excit|thrill|eager/i],
    ['happy', /开心|高兴|快乐|愉快|欢快|喜|笑|得意|轻快|happy|cheer|joy|glad|laugh|delight/i],
    ['gentle', /温柔|柔和|轻柔|柔声|安慰|哄|gentle|tender|soft|sooth|comfort/i],
    ['cold', /冷淡|冷漠|冰冷|冷冷|淡漠|漠然|cold|indifferent|aloof/i],
    ['serious', /严肃|认真|坚定|郑重|沉声|威严|serious|firm|determin|solemn|stern/i],
    ['calm', /平静|冷静|淡定|平淡|从容|calm|flat|neutral|composed/i],
];

/** 描述归到哪一类，归不了返回空串。 */
export function emotionMood(emotion) {
    const text = String(emotion ?? '');
    let best = '', at = Infinity;
    for (const [mood, re] of MOODS) {
        const m = re.exec(text);
        if (m && m.index < at) [best, at] = [mood, m.index];
    }
    return best;
}

/** 给能听懂自然语言的接口用的一句指令。 */
export const emotionInstruction = (emotion) => `用「${emotion}」的情绪和语气说这句台词，像演员演戏一样自然投入，不要播音腔。`;

/**
 * Fish：S2 系列把提示写在句首方括号里（可用自然语言），S1 只认圆括号。
 * 中文描述 S2 也认，但官方示例和标签表都是英文，能归类的额外补一个英文标签更稳。
 */
const FISH_TAG = {
    sad: 'sad', angry: 'angry', fearful: 'scared', surprised: 'surprised', disgusted: 'disdainful', whisper: 'whispering',
    shouting: 'shouting', shy: 'embarrassed', affectionate: 'soft tone', excited: 'excited', happy: 'happy', gentle: 'soft tone',
    cold: 'indifferent', serious: 'confident', calm: 'calm',
};
export function fishCue(emotion, model = '') {
    const tag = FISH_TAG[emotionMood(emotion)];
    if (/(^|[^a-z])s1\b|speech-1/i.test(model)) return tag ? `(${tag}) ` : '';
    return `[${emotion}]${tag ? `[${tag}]` : ''} `;
}

/** MiniMax voice_setting.emotion；fluent、whisper 只有 speech-2.6 系列认。 */
const MINIMAX = {
    sad: 'sad', angry: 'angry', fearful: 'fearful', surprised: 'surprised', disgusted: 'disgusted', happy: 'happy', excited: 'happy',
    affectionate: 'happy', calm: 'calm', serious: 'calm', cold: 'calm', gentle: 'calm', shouting: 'angry',
};
export function minimaxEmotion(emotion, model = '') {
    const mood = emotionMood(emotion);
    if (mood === 'whisper') return /2\.6/.test(model) ? 'whisper' : '';
    return MINIMAX[mood] || '';
}

/** Azure 神经音色的 mstts:express-as 风格；音色不支持某个风格时 Azure 按默认读，不报错。 */
const AZURE = {
    sad: 'sad', angry: 'angry', fearful: 'fearful', surprised: 'excited', disgusted: 'disgruntled', whisper: 'whispering',
    shouting: 'shouting', shy: 'embarrassed', affectionate: 'affectionate', excited: 'excited', happy: 'cheerful', gentle: 'gentle',
    cold: 'unfriendly', serious: 'serious', calm: 'calm',
};
export const azureStyle = (emotion) => AZURE[emotionMood(emotion)] || '';

/** 豆包（火山 v1）多情感音色（voice_type 里带 _emo_）的 audio.emotion；普通音色不认情绪参数。 */
const VOLC = {
    sad: 'sad', angry: 'angry', fearful: 'fear', surprised: 'surprised', disgusted: 'hate', excited: 'excited', happy: 'happy',
    affectionate: 'lovey-dovey', shy: 'shy', gentle: 'tender', cold: 'coldness', calm: 'neutral', serious: 'neutral',
};
export const volcEmotion = (emotion, voice = '') => (/_emo_/i.test(voice) && VOLC[emotionMood(emotion)]) || '';

/** ElevenLabs v3 的音频标签（英文）；v2 等旧模型没有情绪控制。 */
const ELEVEN = {
    sad: 'sad', angry: 'angry', fearful: 'nervous', surprised: 'surprised', disgusted: 'sarcastic', whisper: 'whispers',
    shouting: 'shouting', shy: 'shy', affectionate: 'softly', excited: 'excited', happy: 'happy', gentle: 'softly',
    cold: 'flatly', serious: 'serious', calm: 'calm',
};
export const elevenTag = (emotion, model = '') => (/v3/i.test(model) && ELEVEN[emotionMood(emotion)] ? `[${ELEVEN[emotionMood(emotion)]}] ` : '');

/** OpenAI 协议里认 instructions 的模型（tts-1 / tts-1-hd 不认）。 */
export const takesInstructions = (model = '') => /gpt[-_.]?4o.*tts|mini[-_.]?tts|instruct/i.test(model);

/** 硅基流动的 CosyVoice：指令写在 input 前面，用 <|endofprompt|> 隔开（官方文档的写法）。 */
export function isSiliconCosy(base = '', model = '') {
    if (!/cosyvoice/i.test(model)) return false;
    try { return /(^|\.)siliconflow\.(cn|com)$/i.test(new URL(base).hostname); } catch { return false; }
}

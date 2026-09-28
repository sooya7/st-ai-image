import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../src/media/providers.js';
import { vendorPlan } from '../src/media/vendors.js';
import { azureStyle, emotionMood, fishCue, minimaxEmotion, volcEmotion } from '../src/media/emotion.js';

const key = 'test-only-placeholder';
const body = (plan) => JSON.parse(plan.body);

test('情绪归类：取描述里最先出现的那一类，归不了返回空', () => {
    assert.equal(emotionMood('哽咽，小声'), 'sad');
    assert.equal(emotionMood('小声，哽咽'), 'whisper');
    assert.equal(emotionMood('气急败坏地大喊'), 'angry');
    assert.equal(emotionMood('惊恐'), 'fearful');
    assert.equal(emotionMood('冷笑'), 'disgusted');
    assert.equal(emotionMood('苦笑'), 'sad');
    assert.equal(emotionMood('冷静'), 'calm');
    assert.equal(emotionMood('撒娇'), 'affectionate');
    assert.equal(emotionMood('whispering softly'), 'whisper');
    assert.equal(emotionMood('若有所思'), '');
});

test('没写 emotion 时请求和以前完全一样', () => {
    const plain = { provider: 'openai', base: 'https://api.fish.audio/compat/v1', key, model: 'fish-audio/s2.1-pro-free', voice: 'v' };
    assert.equal(body(buildRequest('audio', plain, '别走')).input, '别走');
    assert.equal(body(buildRequest('audio', { ...plain, emotion: '  ' }, '别走')).input, '别走');
});

test('Fish（兼容接口和原生）：S2 句首方括号带原话和英文标签，S1 用圆括号', () => {
    const compat = buildRequest('audio', { provider: 'openai', base: 'https://api.fish.audio/compat/v1', key, model: 'fish-audio/s2.1-pro-free', voice: 'v', emotion: '哽咽，小声' }, '别走');
    assert.equal(body(compat).input, '[哽咽，小声][sad] 别走');
    assert.equal(body(compat).instructions, undefined);
    const native = buildRequest('audio', { provider: 'fish', base: 'https://api.fish.audio/v1', key, model: 's2.1-pro-free', emotion: '若有所思' }, '嗯');
    assert.equal(body(native).text, '[若有所思] 嗯');
    assert.equal(fishCue('愤怒', 's1'), '(angry) ');
    assert.equal(fishCue('若有所思', 's1'), '');
});

test('OpenAI 协议：gpt-4o-mini-tts 走 instructions，tts-1 不送，硅基流动 CosyVoice 用 <|endofprompt|>', () => {
    const base = { provider: 'openai', base: 'https://api.openai.com/v1', key, voice: 'alloy', emotion: '撒娇' };
    const mini = body(buildRequest('audio', { ...base, model: 'gpt-4o-mini-tts', extra: '{"instructions":"四川话"}' }, '好不好嘛'));
    assert.equal(mini.input, '好不好嘛');
    assert.match(mini.instructions, /^四川话\n.*撒娇/);
    const old = body(buildRequest('audio', { ...base, model: 'tts-1' }, '好不好嘛'));
    assert.deepEqual([old.input, old.instructions], ['好不好嘛', undefined]);
    const cosy = body(buildRequest('audio', { ...base, base: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B' }, '好不好嘛'));
    assert.match(cosy.input, /撒娇.*<\|endofprompt\|>好不好嘛$/);
    // 别家中转站上同名模型不加前缀，免得被读出来
    assert.equal(body(buildRequest('audio', { ...base, base: 'https://relay.example/v1', model: 'CosyVoice2' }, '好不好嘛')).input, '好不好嘛');
});

test('ElevenLabs 只有 v3 加英文音频标签；Azure 用 express-as 风格', () => {
    const eleven = { provider: 'elevenlabs', base: 'https://api.elevenlabs.io/v1', key, voice: 'vid', emotion: '小声' };
    assert.equal(body(buildRequest('audio', { ...eleven, model: 'eleven_v3' }, 'hi')).text, '[whispers] hi');
    assert.equal(body(buildRequest('audio', { ...eleven, model: 'eleven_multilingual_v2' }, 'hi')).text, 'hi');
    const azure = buildRequest('audio', { provider: 'azure', base: 'https://eastasia.tts.speech.microsoft.com', key, voice: 'zh-CN-XiaoxiaoNeural', emotion: '开心地笑' }, '你好 & 再见');
    assert.match(azure.body, /xmlns:mstts="https:\/\/www.w3.org\/2001\/mstts"/);
    assert.match(azure.body, /<mstts:express-as style="cheerful">你好 &amp; 再见<\/mstts:express-as>/);
    assert.equal(azureStyle('若有所思'), '');
    assert.doesNotMatch(buildRequest('audio', { provider: 'azure', key, base: 'https://eastasia.tts.speech.microsoft.com', voice: 'v' }, 'x').body, /express-as/);
});

test('MiniMax 枚举；whisper 只给 speech-2.6，归不了类不送', () => {
    const plan = (emotion, model) => body(vendorPlan('audio', { provider: 'minimax', key, model, emotion, extra: '' }, '你好')).voice_setting;
    assert.equal(plan('怒吼', 'speech-2.8-hd').emotion, 'angry');
    assert.equal(plan('小声', 'speech-2.8-hd').emotion, undefined);
    assert.equal(plan('小声', 'speech-2.6-hd').emotion, 'whisper');
    assert.equal(plan('若有所思', 'speech-2.8-hd').emotion, undefined);
    assert.equal(minimaxEmotion('开心'), 'happy');
});

test('百炼只给 instruct 模型送 instructions；Gemini 用提示语；豆包只给多情感音色', () => {
    const qwen = (model) => body(vendorPlan('audio', { provider: 'dashscope', key, model, emotion: '温柔地哄', extra: '' }, '乖')).input;
    assert.match(qwen('qwen3-tts-instruct-flash').instructions, /温柔地哄/);
    assert.equal(qwen('qwen3-tts-instruct-flash').optimize_instructions, true);
    assert.equal(qwen('qwen3-tts-flash').instructions, undefined);
    const gemini = body(vendorPlan('audio', { provider: 'gemini', key, emotion: '惊慌失措', extra: '' }, '快跑'));
    assert.equal(gemini.contents[0].parts[0].text, '用「惊慌失措」的语气说：快跑');
    const volc = (voice) => body(vendorPlan('audio', { provider: 'volcengine', key: 'a:b', voice, emotion: '伤心', extra: '' }, '嗯')).audio;
    assert.deepEqual([volc('zh_female_gaolengyujie_emo_v2_mars_bigtts').emotion, volc('zh_female_gaolengyujie_emo_v2_mars_bigtts').enable_emotion], ['sad', true]);
    assert.equal(volc('zh_female_shuangkuaisisi_moon_bigtts').emotion, undefined);
    assert.equal(volcEmotion('伤心', 'BV700_streaming'), '');
});

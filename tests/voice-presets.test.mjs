import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { MEDIA_TAG_SOURCE, buildMediaTag, locateMediaTag, parseMediaTag, replaceMediaTag } from '../src/media/tags.js';
import { FISH_VOICES, MAX_PRESETS, blankPresets, fishPresets, isFishEndpoint, normalizePresets, resolveVoice, usableTypes } from '../src/media/voice-presets.js';
import { DEFAULT_VOICE_PROMPT, VOICE_TYPES_TOKEN, readMediaSettings, renderVoicePrompt } from '../src/media/media-settings.js';

const SRC = '/user/files/st-ai-audio-1-abc.mp3';
const FISH_COMPAT = 'https://api.fish.audio/compat/v1';

test('标签属性：type/音色 和 name，引号可选、顺序不限；写回时保留，只补 src', () => {
    assert.equal(parseMediaTag('[voice type="御姐"]快进来[/voice]').voiceType, '御姐');
    assert.equal(parseMediaTag('[语音 音色=“少年”]嗯[/语音]').voiceType, '少年');
    assert.equal(parseMediaTag('[voice type=御姐]x[/voice]').voiceType, '御姐');
    const both = parseMediaTag(`[voice src="${SRC}" name="林晚" type="御姐"]hi[/voice]`);
    assert.deepEqual([both.voiceType, both.speaker, both.src], ['御姐', '林晚', SRC]);
    assert.equal(buildMediaTag('voice', '快进来', SRC, both), `[voice type="御姐" name="林晚" src="${SRC}"]快进来[/voice]`);
    assert.equal(buildMediaTag('voice', 'x', SRC, { voiceType: 'a"]b' }), `[voice type="ab" src="${SRC}"]x[/voice]`);
    const raw = '林晚招手：[voice type="御姐"]快进来[/voice]';
    const located = locateMediaTag(raw, { kind: 'audio', text: '快进来' });
    assert.equal(replaceMediaTag(raw, located, buildMediaTag(located.info.name, located.info.text, SRC, located.info)), `林晚招手：[voice type="御姐" src="${SRC}"]快进来[/voice]`);
    // text.js 靠第 3 组取正文，加了属性分组后序号不能变
    assert.equal(`a[voice type="御姐" src="${SRC}"]台词[/voice]b`.replace(new RegExp(MEDIA_TAG_SOURCE, 'gi'), '$3'), 'a台词b');
});

test('选音色只看当前服务的表：type 在表里且配了音色才用，否则用默认音色；不绑定 Fish', () => {
    const presets = [{ type: '御姐', voice: 'zh-CN-XiaomoNeural' }, { type: '少年', voice: '' }];
    assert.deepEqual(resolveVoice({ type: '御姐', fallback: 'def', presets }), { voice: 'zh-CN-XiaomoNeural', preset: '御姐' });
    assert.deepEqual(resolveVoice({ type: ' 御姐 ', fallback: 'def', presets }).preset, '御姐');
    assert.deepEqual(resolveVoice({ type: '少年', fallback: 'def', presets }), { voice: 'def', preset: '' }); // 音色没填
    assert.deepEqual(resolveVoice({ type: '不存在', fallback: 'def', presets }), { voice: 'def', preset: '' });
    assert.deepEqual(resolveVoice({ fallback: 'def', presets }), { voice: 'def', preset: '' });
    assert.deepEqual(resolveVoice({ type: '御姐', fallback: 'def' }), { voice: 'def', preset: '' });
    assert.deepEqual(usableTypes(presets), ['御姐']);
});

test('预设表读档：坏行丢弃、名字去重、限行数；没存过时 Fish 给推荐音色，其他服务只给类型名', () => {
    assert.equal(normalizePresets(undefined), null);
    assert.deepEqual(normalizePresets([{ type: ' 御姐 ', voice: ' v1 ' }, { type: '御姐', voice: 'dup' }, { type: '' }, null, { type: 'a"]b', voice: 3 }]),
        [{ type: '御姐', voice: 'v1' }, { type: 'ab', voice: '3' }]);
    assert.equal(normalizePresets(Array.from({ length: 60 }, (_, i) => ({ type: `t${i}`, voice: 'v' }))).length, MAX_PRESETS);

    const fresh = readMediaSettings({}, 'speech');
    assert.deepEqual(fresh.profiles.fish.presets, fishPresets());
    assert.deepEqual(fresh.profiles.openai.presets, blankPresets());
    assert.deepEqual(fresh.profiles.azure.presets.map((r) => r.type), FISH_VOICES.map((v) => v.type));
    const compat = readMediaSettings({ speech: { profiles: { openai: { base: FISH_COMPAT } } } }, 'speech');
    assert.deepEqual(compat.profiles.openai.presets, fishPresets());
    const edited = readMediaSettings({ speech: { profiles: { openai: { base: FISH_COMPAT, presets: [{ type: '冷酷剑客', voice: 'x' }] } } } }, 'speech');
    assert.deepEqual(edited.profiles.openai.presets, [{ type: '冷酷剑客', voice: 'x' }]);
    assert.equal(readMediaSettings({}, 'video').profiles.runway.presets, undefined);
    assert.ok(isFishEndpoint('openai', FISH_COMPAT) && isFishEndpoint('fish') && !isFishEndpoint('openai', 'https://fish.audio.evil.test/v1') && !isFishEndpoint('azure', FISH_COMPAT));
});

test('提示词里的 {{音色类型}} 换成当前表里配了音色的类型名；一个都没有时让 AI 不写 type', () => {
    assert.ok(DEFAULT_VOICE_PROMPT.includes(VOICE_TYPES_TOKEN));
    const text = renderVoicePrompt(DEFAULT_VOICE_PROMPT, [{ type: '御姐', voice: 'v' }, { type: '少年', voice: '' }, { type: '冷酷剑客', voice: 'w' }]);
    assert.ok(text.includes('只能从这些里选：御姐、冷酷剑客') && !text.includes(VOICE_TYPES_TOKEN), text);
    assert.match(renderVoicePrompt(DEFAULT_VOICE_PROMPT, blankPresets()), /暂未配置音色类型，不要写 type/);
    assert.equal(renderVoicePrompt('自定义提示词', fishPresets()), '自定义提示词');
});

test('Fish 推荐音色：类型和 ID 都不重复，ID 是 32 位十六进制', () => {
    assert.equal(new Set(FISH_VOICES.map((v) => v.type)).size, FISH_VOICES.length);
    assert.equal(new Set(FISH_VOICES.map((v) => v.fish)).size, FISH_VOICES.length);
    for (const v of FISH_VOICES) assert.match(v.fish, /^[0-9a-f]{32}$/, v.type);
});

test('以前每一版的默认配音提示词读档时都换成当前默认', () => {
    for (const ref of ['b624b98', 'd5b76cf', '0027222']) {
        const src = execSync(`git show ${ref}:src/media/media-settings.js`, { cwd: new URL('..', import.meta.url) }).toString();
        const literal = /export const DEFAULT_VOICE_PROMPT = `([\s\S]*?)`;/.exec(src)[1]
            // 0027222 的列表是模板插值生成的，按当时的值展开
            .replace('${typesOf(\'女声\')}', '日常女声、萝莉、青涩少女、活泼少女、温柔女声、御姐、成熟女声、老年女声')
            .replace('${typesOf(\'男声\')}', '少年、青年男声、成熟男声、大叔、老年男声');
        assert.equal(readMediaSettings({ speech: { prompt: literal } }, 'speech').prompt, DEFAULT_VOICE_PROMPT, ref);
    }
});

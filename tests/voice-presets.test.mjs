import test from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_TAG_SOURCE, buildMediaTag, locateMediaTag, parseMediaTag, replaceMediaTag } from '../src/media/tags.js';
import { PRESET_TYPES, VOICE_PRESETS, presetById, resolveVoice, supportsPresets } from '../src/media/voice-presets.js';
import { DEFAULT_VOICE_PROMPT } from '../src/media/media-settings.js';

const SRC = '/user/files/st-ai-audio-1-abc.mp3';
const FISH_COMPAT = 'https://api.fish.audio/compat/v1';

test('标签属性：type/音色 和 name，引号可选、顺序不限；写回时保留，只补 src', () => {
    assert.equal(parseMediaTag('[voice type="御姐"]快进来[/voice]').voiceType, '御姐');
    assert.equal(parseMediaTag('[语音 音色=“少年”]嗯[/语音]').voiceType, '少年');
    assert.equal(parseMediaTag('[voice type=御姐]x[/voice]').voiceType, '御姐'); // ST 把 "…" 包进 <q>，也可能不带引号
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

test('预设只在 Fish 原生接口或指向 fish.audio 的兼容接口上生效', () => {
    assert.ok(supportsPresets('fish'));
    assert.ok(supportsPresets('openai', FISH_COMPAT));
    assert.ok(!supportsPresets('openai', 'https://api.openai.com/v1'));
    assert.ok(!supportsPresets('openai', 'https://fish.audio.evil.test/v1'));
    assert.ok(!supportsPresets('openai', 'not a url'));
    assert.ok(!supportsPresets('azure', FISH_COMPAT));
});

test('选音色：type 命中预设用预设，没写、不认识或服务不支持都用默认音色', () => {
    const fish = { provider: 'openai', base: FISH_COMPAT, fallback: 'default-id' };
    assert.deepEqual(resolveVoice({ ...fish, type: '御姐' }), { voice: 'c189c7cff21c400ba67592406202a3a0', preset: '御姐' });
    assert.deepEqual(resolveVoice({ ...fish, type: ' 少年 ' }).preset, '少年');
    assert.deepEqual(resolveVoice({ ...fish, type: '不存在' }), { voice: 'default-id', preset: '' });
    assert.deepEqual(resolveVoice({ ...fish }), { voice: 'default-id', preset: '' });
    assert.deepEqual(resolveVoice({ provider: 'openai', base: 'https://api.openai.com/v1', fallback: 'alloy', type: '御姐' }), { voice: 'alloy', preset: '' });
});

test('预设表：类型和音色 ID 都不重复，按 ID 能反查；默认提示词列出全部类型', () => {
    assert.equal(new Set(PRESET_TYPES).size, VOICE_PRESETS.length);
    assert.equal(new Set(VOICE_PRESETS.map((p) => p.fish)).size, VOICE_PRESETS.length);
    for (const p of VOICE_PRESETS) {
        assert.match(p.fish, /^[0-9a-f]{32}$/, p.type);
        assert.equal(presetById(p.fish), p);
        assert.ok(DEFAULT_VOICE_PROMPT.includes(p.type), p.type);
    }
    assert.equal(presetById('custom-id'), null);
    assert.match(DEFAULT_VOICE_PROMPT, /\[voice type="青涩少女"\]/);
});

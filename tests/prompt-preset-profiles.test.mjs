import test from 'node:test';
import assert from 'node:assert/strict';
import { applyImagePromptPreset, readPromptPresets, writePromptPresets } from '../src/core/library.js';
import { callImageAPI } from '../src/api/images.js';
import { saveSettings } from '../src/settings.js';

const library = (name, prefix, random = false) => ({ items: { [name]: { prefix, suffix: 'detail', negative: 'bad' } }, active: name, random });

test('旧全局库迁移后，各接口的条目、选中项和随机开关独立保存，旧字段保留', () => {
    const legacy = { imageProvider: 'comfyui', promptPresets: library('旧库', 'legacy').items, promptPresetId: '旧库', promptPresetRandom: true };
    let s = writePromptPresets(legacy, 'comfyui', library('本地', 'comfy'));
    assert.equal(readPromptPresets(s, 'novelai').items.旧库.prefix, 'legacy');
    assert.equal(readPromptPresets(s, 'sdwebui').random, true);
    s = writePromptPresets(s, 'novelai', library('NAI', 'nai', true));
    s = writePromptPresets(s, 'sdwebui', library('WebUI', 'sd'));
    s = JSON.parse(JSON.stringify(s)); // 保存和重新加载
    assert.deepEqual(readPromptPresets(s, 'comfyui'), library('本地', 'comfy'));
    assert.deepEqual(readPromptPresets(s, 'novelai'), library('NAI', 'nai', true));
    assert.deepEqual(readPromptPresets(s, 'sdwebui'), library('WebUI', 'sd'));
    assert.deepEqual(s.promptPresets, legacy.promptPresets);
    assert.deepEqual(readPromptPresets(writePromptPresets(s, 'comfyui', library('导入', 'new')), 'novelai'), library('NAI', 'nai', true));
});

test('请求仅使用对应接口的画师串，随机池不越过接口边界，其他接口保留原始描述', () => {
    let s = {};
    for (const provider of ['novelai', 'comfyui', 'sdwebui']) s = writePromptPresets(s, provider, library(provider, provider, true));
    for (const provider of ['novelai', 'comfyui', 'sdwebui']) {
        assert.deepEqual(applyImagePromptPreset('cat', { ...s, imageProvider: provider }, { rand: () => 0 }), { prompt: `${provider}, cat, detail`, negative: 'bad' });
    }
    for (const provider of ['auto', 'openai', 'chat', 'gemini', 'minimax', 'dashscope', 'stability', 'pollinations', 'horde', 'fal', 'replicate', undefined]) {
        const settings = { ...s, imageProvider: provider, extraPrompt: 'legacy', negativePrompt: 'legacy bad' };
        assert.deepEqual(applyImagePromptPreset('cat\n , dog', settings), { prompt: 'cat\n , dog', negative: '' });
        assert.equal(readPromptPresets(settings).items.默认.prefix, '');
        assert.equal(writePromptPresets(settings, provider, library('误写', 'oops')), settings);
    }
});

test('OpenAI 和兼容中转的实际图片请求不会泄漏旧全局或其他接口的画师串', async (t) => {
    const original = globalThis.fetch;
    const storage = globalThis.localStorage;
    globalThis.localStorage = { setItem() {} };
    t.after(() => { globalThis.fetch = original; globalThis.localStorage = storage; });
    let body;
    globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return Response.json({ data: [{ url: 'https://cdn.test/image.png' }] }); };
    for (const imageProvider of ['auto', 'openai', 'chat', 'gemini']) {
        await saveSettings({ imageProvider, apiBase: 'https://mock.test/v1', apiKey: 'fixture', model: 'image', size: '1024x1024', promptPresets: library('旧库', 'legacy').items, promptPresetId: '旧库', promptPresetProfiles: { novelai: library('NAI', 'nai') } });
        await callImageAPI('cat');
        const input = imageProvider === 'chat' ? body.messages[0].content : imageProvider === 'gemini' ? body.contents[0].parts[0].text : body.prompt;
        assert.equal(input, 'cat');
        assert.equal(body.negative_prompt, undefined);
        assert.doesNotMatch(JSON.stringify(body), /legacy|nai|bad/);
    }
});

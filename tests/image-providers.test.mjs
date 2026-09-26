import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { buildRequest } from '../src/media/providers.js';
import { generateMedia } from '../src/media/client.js';
import { callImageAPI, fetchModelList } from '../src/api/images.js';
import { saveSettings, upsertPreset, getPresets } from '../src/settings.js';
import { fetchWithTimeout } from '../src/core/net.js';

const config = { provider: 'gemini', base: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-image', key: 'fixture-only', extra: '{"imageConfig":{"aspectRatio":"16:9"}}' };
test('Gemini 原生使用 generateContent、x-goog-api-key 与 generationConfig', async () => {
    const plan = buildRequest('image', config, 'a cat');
    assert.equal(plan.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
    assert.equal(plan.headers['x-goog-api-key'], config.key);
    assert.equal(plan.headers.Authorization, undefined);
    assert.equal(JSON.parse(plan.body).generationConfig.imageConfig.aspectRatio, '16:9');
    const result = await generateMedia('image', config, 'a cat', { request: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }] }) });
    assert.equal(result.url, 'data:image/png;base64,AAAA');
});
test('OpenAI Images、Chat、fal、Replicate 图片完成结果均可提取', async () => {
    for (const provider of ['openai', 'chat', 'fal', 'replicate']) {
        const cfg = { ...config, base: 'https://mock.test/v1', model: 'owner/model', extra: '{}', provider };
        const plan = buildRequest('image', cfg, 'cat');
        const body = JSON.parse(plan.body);
        if (provider === 'chat') assert.equal(body.stream, false);
        if (provider === 'openai') assert.equal(body.n, 1);
        const result = await generateMedia('image', cfg, 'cat', { request: async (_, options) => {
            if (provider === 'fal' && options.method === 'POST') return { status: 'COMPLETED', status_url: 'https://mock.test/status', response_url: 'https://mock.test/result' };
            if (provider === 'replicate') return { id: 'prediction1', status: 'succeeded', output: ['https://cdn.test/image.png'] };
            return provider === 'chat' ? { choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'https://cdn.test/image.png' } }] } }] } : { images: [{ url: 'https://cdn.test/image.png' }] };
        } });
        assert.equal(result.url, 'https://cdn.test/image.png');
    }
});
test('现有图片入口路由所选协议；Gemini 模型列表使用正确认证', async (t) => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    const calls = [];
    await saveSettings({ apiBase: config.base, apiKey: config.key, model: config.model, imageProvider: 'gemini', imageParams: config.extra });
    globalThis.fetch = async (url, options) => {
        calls.push([url, options]);
        return Response.json(url.includes('/models?') ? { models: [{ name: 'models/gemini-image', displayName: 'Image' }] } : { candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }] } }] });
    };
    assert.equal(await callImageAPI('cat'), 'data:image/png;base64,AAAA');
    assert.match(calls[0][0], /:generateContent$/);
    assert.deepEqual(await fetchModelList(), [{ id: 'gemini-image', name: 'Image' }]);
    assert.equal(calls[1][1].headers['x-goog-api-key'], config.key);
});
test('旧兼容模式仅对明确不支持的端点降级，401/429/5xx/网络/未知成功不重提', async (t) => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    await saveSettings({ apiBase: 'https://mock.test/v1', apiKey: 'fake-only', model: 'image', imageProvider: 'auto' });
    for (const status of [401, 429, 500, 200, 'network']) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; if (status === 'network') throw new TypeError('Failed to fetch'); return Response.json({}, { status }); };
        await assert.rejects(callImageAPI('cat'));
        assert.equal(calls, 1);
    }
    let calls = 0;
    globalThis.fetch = async () => { calls++; return calls === 1 ? new Response('', { status: 404 }) : Response.json({ images: [{ url: 'https://cdn.test/image.png' }] }); };
    assert.equal(await callImageAPI('cat'), 'https://cdn.test/image.png');
    assert.equal(calls, 2);
});
test('完成后清理旧图片网络层的 AbortSignal 监听器', async (t) => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => Response.json({});
    const controller = new AbortController();
    for (let i = 0; i < 20; i++) await fetchWithTimeout('https://mock.test', { signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('新图片预设保留协议与参数，旧预设保存时默认为 auto', (t) => {
    const previous = globalThis.localStorage;
    const map = new Map();
    globalThis.localStorage = { getItem: (key) => map.get(key), setItem: (key, value) => map.set(key, value) };
    t.after(() => { globalThis.localStorage = previous; });
    upsertPreset('new', { imageProvider: 'gemini', imageParams: '{"seed":1}' });
    upsertPreset('old', {});
    assert.equal(getPresets().new.imageProvider, 'gemini');
    assert.equal(getPresets().new.imageParams, '{"seed":1}');
    assert.equal(getPresets().old.imageProvider, 'auto');
});

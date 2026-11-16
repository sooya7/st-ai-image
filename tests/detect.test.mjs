import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/media/detect.js';
import { mediaRequestConfig, readMediaSettings } from '../src/media/media-settings.js';
import { resolveImageProvider } from '../src/api/images.js';

test('自动识别：按地址认服务，认不出走 OpenAI 兼容', () => {
    assert.equal(detectProvider('image', 'https://dashscope.aliyuncs.com'), 'dashscope');
    assert.equal(detectProvider('image', 'https://api.minimax.cn'), 'minimax');
    assert.equal(detectProvider('image', 'https://generativelanguage.googleapis.com/v1beta'), 'gemini');
    assert.equal(detectProvider('image', 'https://openrouter.ai/api/v1'), 'chat');
    assert.equal(detectProvider('image', 'https://api.mikoto.vip/v1'), 'auto');
    assert.equal(detectProvider('audio', 'https://api.elevenlabs.io/v1'), 'elevenlabs');
    assert.equal(detectProvider('audio', 'https://eastasia.tts.speech.microsoft.com'), 'azure');
    assert.equal(detectProvider('audio', 'https://api.fish.audio/v1'), 'openai');
    assert.equal(detectProvider('audio', 'http://127.0.0.1:9880'), 'gptsovits');
    assert.equal(detectProvider('video', 'https://ark.cn-beijing.volces.com/api/v3'), 'ark');
    assert.equal(detectProvider('video', 'https://api-beijing.klingai.com'), 'kling');
    assert.equal(detectProvider('video', 'https://my-relay.example/v1'), 'openai');
    assert.equal(detectProvider('video', ''), 'openai');
});

test('自动识别：语音视频按认出的服务补默认模型，图片只换 imageProvider', () => {
    const media = readMediaSettings({ speech: { provider: 'auto', profiles: { auto: { base: 'https://api.minimax.cn', key: 'k' } } } }, 'speech');
    const config = mediaRequestConfig(media);
    assert.deepEqual([config.provider, config.model, config.voice, config.key, config.selected], ['minimax', 'speech-2.8-hd', 'female-shaonv', 'k', 'auto']);
    const video = mediaRequestConfig(readMediaSettings({ video: { provider: 'auto', profiles: { auto: { base: 'https://dashscope.aliyuncs.com', key: 'k', model: 'wan2.6-t2v' } } } }, 'video'));
    assert.deepEqual([video.provider, video.model, video.size], ['dashscope', 'wan2.6-t2v', '720p']);
    assert.equal(resolveImageProvider({ imageProvider: 'auto', apiBase: 'https://api.stability.ai' }).imageProvider, 'stability');
    assert.equal(resolveImageProvider({ imageProvider: 'auto', apiBase: 'https://relay.example/v1' }).imageProvider, 'auto');
    assert.equal(resolveImageProvider({ imageProvider: 'novelai', apiBase: 'https://api.stability.ai' }).imageProvider, 'novelai');
});

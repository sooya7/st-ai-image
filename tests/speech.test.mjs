import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { buildRequest } from '../src/media/providers.js';
import { generateMedia, pendingMediaCount, requestData } from '../src/media/client.js';
import { mediaRequestConfig, readMediaSettings } from '../src/media/media-settings.js';

const config = { provider: 'openai', model: 'tts-1', voice: 'alloy', key: 'test-only-placeholder', base: 'https://example.test/v1' };
const blob = () => new Blob(['mock-audio'], { type: 'audio/mpeg' });

test('OpenAI TTS 使用指定输入、模型、MP3 与 Bearer 认证', () => {
    const plan = buildRequest('audio', { ...config, extra: { speed: 0.8, input: 'unexpected', response_format: 'pcm' } }, '你好');
    assert.equal(plan.url, 'https://example.test/v1/audio/speech');
    assert.equal(plan.headers.Authorization, `Bearer ${config.key}`);
    assert.deepEqual(JSON.parse(plan.body), { speed: 0.8, input: '你好', model: 'tts-1', voice: 'alloy', response_format: 'mp3' });
    assert.equal(plan.queue, false);
});

test('ElevenLabs 使用独立 Voice ID 端点与 xi-api-key', () => {
    const plan = buildRequest('audio', { ...config, provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice: 'voice-id' }, 'hello');
    assert.match(plan.url, /\/text-to-speech\/voice-id\?output_format=mp3_44100_128$/);
    assert.equal(plan.headers.Authorization, undefined);
    assert.equal(plan.headers['xi-api-key'], config.key);
    assert.deepEqual(JSON.parse(plan.body), { text: 'hello', model_id: 'eleven_multilingual_v2' });
});

test('Azure SSML 转义文字与音色，使用区域端点', () => {
    const plan = buildRequest('audio', { ...config, provider: 'azure', model: '', base: 'https://eastasia.tts.speech.microsoft.com', voice: 'a"b', extra: { language: 'zh-CN' } }, '你好 <break/> & 世界');
    assert.equal(plan.url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
    assert.equal(plan.headers['Ocp-Apim-Subscription-Key'], config.key);
    assert.match(plan.body, /xmlns="http:\/\/www.w3.org\/2001\/10\/synthesis"/);
    assert.match(plan.body, /name="a&quot;b"/);
    assert.match(plan.body, /你好 &lt;break\/&gt; &amp; 世界/);
});

test('无效地址、密钥、音色、空文本、超长文本在提交前拒绝', () => {
    for (const base of ['javascript:alert(1)', 'https://user:password@example.test', 'https://example.test?key=secret']) {
        assert.throws(() => buildRequest('audio', { ...config, base }, 'hello'));
    }
    assert.throws(() => buildRequest('audio', { ...config, key: '' }, 'hello'));
    assert.throws(() => buildRequest('audio', { ...config, provider: 'elevenlabs', voice: '' }, 'hello'));
    assert.throws(() => buildRequest('audio', config, ' '));
    assert.throws(() => buildRequest('audio', config, 'x'.repeat(4097)));
});

test('语音设置按服务隔离，缺字段/坏数据按默认补齐，未知字段丢弃', () => {
    const media = readMediaSettings({ speech: { provider: 'azure', profiles: { openai: { voice: 'nova', key: 'k1', unknown: 'x' }, azure: { voice: 42 } } } }, 'speech');
    assert.equal(media.provider, 'azure');
    assert.equal(media.profiles.openai.voice, 'nova');
    assert.equal(media.profiles.openai.key, 'k1');
    assert.equal(media.profiles.openai.unknown, undefined);
    assert.equal(media.profiles.azure.voice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(media.enabled, true);
    assert.equal(media.autoInject, false);
    assert.equal(readMediaSettings({ speech: 'broken' }, 'speech').provider, 'openai');
    assert.equal(readMediaSettings({ speech: { provider: 'nope' } }, 'speech').provider, 'openai');
    const config = mediaRequestConfig({ ...media, proxy: true }, 'openai');
    assert.deepEqual([config.provider, config.voice, config.proxy], ['openai', 'nova', true]);
});
test('Azure SSML 的 xml:lang 取设置里的语言', () => {
    const request = buildRequest('audio', { provider: 'azure', base: 'https://eastasia.tts.speech.microsoft.com', key: 'k', voice: 'ja-JP-NanamiNeural', language: 'ja-JP' }, 'こんにちは');
    assert.match(request.body, /xml:lang="ja-JP"/);
});

test('成功与失败均释放任务槽；失败不会重试 POST', async () => {
    let calls = 0;
    const request = async () => { calls++; return blob(); };
    const result = await generateMedia('audio', config, 'hello', { request });
    assert.equal(result.blob.type, 'audio/mpeg');
    assert.equal(calls, 1);
    assert.equal(pendingMediaCount(), 0);
    await assert.rejects(generateMedia('audio', config, 'hello', { request: async () => { calls++; throw new Error('HTTP 429'); } }), /429/);
    assert.equal(calls, 2);
    assert.equal(pendingMediaCount(), 0);
});

test('两个活动任务时第三个拒绝；取消后释放槽且不返回过期结果', async () => {
    const a = new AbortController();
    const b = new AbortController();
    let calls = 0;
    const request = (_, { signal }) => new Promise((resolve, reject) => {
        calls++; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const one = generateMedia('audio', config, 'one', { request, signal: a.signal });
    const two = generateMedia('audio', config, 'two', { request, signal: b.signal });
    await assert.rejects(generateMedia('audio', config, 'three', { request }), /两个/);
    assert.equal(calls, 2);
    const settled = Promise.allSettled([one, two]);
    a.abort(); b.abort();
    assert.ok((await settled).every((entry) => entry.status === 'rejected'));
    assert.equal(pendingMediaCount(), 0);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(generateMedia('audio', config, 'four', { request, signal: cancelled.signal }));
    assert.equal(calls, 2);
});

test('二进制空文件和视频响应不能冒充语音', async () => {
    for (const invalid of [new Blob([]), new Blob(['video'], { type: 'video/mp4' })]) {
        await assert.rejects(generateMedia('audio', config, 'hello', { request: async () => invalid }), /音频/);
    }
    const result = await generateMedia('audio', config, 'hello', { request: async () => new Blob(['mp3'], { type: 'application/octet-stream' }) });
    assert.equal(result.blob.type, 'audio/mpeg');
});

test('真实 HTTP 模拟服务：读取音频、限制体积、拒绝 JSON、超时与取消', async (t) => {
    const server = createServer((req, res) => {
        if (req.url === '/error') { res.writeHead(401); res.end('do-not-expose-response'); return; }
        if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.write('1234');
        if (req.url === '/slow') return;
        res.end('5678');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await requestData(base, {}, true)).size, 8);
    await assert.rejects(requestData(base, {}, true, 5), /过大/);
    await assert.rejects(requestData(`${base}/json`, {}, true), /没有返回/);
    await assert.rejects(requestData(`${base}/error`, {}, true), /401/);
    await assert.rejects(requestData(`${base}/slow`, { timeout: 30 }, true), /超时/);
    const abort = new AbortController();
    const pending = requestData(`${base}/slow`, { signal: abort.signal }, true);
    setTimeout(() => abort.abort(new Error('user-stop')), 30);
    await assert.rejects(pending, /user-stop/);
});

test('Fish Audio：/v1/tts、Bearer、模型放 model 请求头而不是请求体、reference_id 取音色', () => {
    const request = buildRequest('audio', { provider: 'fish', base: 'https://api.fish.audio', key: 'k', model: 's2.1-pro-free', voice: 'f729a1' }, '你好');
    assert.equal(request.url, 'https://api.fish.audio/v1/tts');
    assert.equal(request.headers.Authorization, 'Bearer k');
    assert.equal(request.headers.model, 's2.1-pro-free');
    const body = JSON.parse(request.body);
    assert.deepEqual(body, { format: 'mp3', text: '你好', reference_id: 'f729a1' });
    assert.equal(body.model, undefined);
    assert.equal(request.binary, true);
    const noVoice = JSON.parse(buildRequest('audio', { provider: 'fish', key: 'k', model: 's1' }, 'hi').body);
    assert.equal(noVoice.reference_id, undefined);
});
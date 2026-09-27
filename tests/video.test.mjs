import test from 'node:test';
import assert from 'node:assert/strict';
import { isTauriTavern, providerOptions } from '../src/media/availability.js';
import { PROVIDERS, buildRequest, taskLinks } from '../src/media/providers.js';
import { generateMedia, downloadVideo, pendingMediaCount, proxyUrl, sniffMediaType } from '../src/media/client.js';
import { mediaRequestConfig, readMediaSettings } from '../src/media/media-settings.js';

const cfg = { provider: 'runway', base: 'https://example.test/v1', model: 'gen4.5', key: 'test-only', seconds: 5, size: '1280:720' };
test('Runway 视频请求遵循模型、版本头、比例与时长', () => {
    const request = buildRequest('video', cfg, 'a cat');
    assert.equal(request.url, 'https://example.test/v1/text_to_video');
    assert.equal(request.headers['X-Runway-Version'], '2024-11-06');
    assert.deepEqual(JSON.parse(request.body), { model: 'gen4.5', promptText: 'a cat', ratio: '1280:720', duration: 5 });
});
test('/videos 兼容请求用 JSON（与 SOOYA 线上实现一致）', () => {
    const request = buildRequest('video', { ...cfg, provider: 'openai', seconds: 4, size: '1280x720', model: 'sora-2' }, 'cat');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { model: 'sora-2', prompt: 'cat', seconds: '4', size: '1280x720' });
    assert.equal(request.url, 'https://example.test/v1/videos');
});
test('Agnes：JSON、必填 mode=text、尺寸是 720P 档位，任务与下载走 /videos', () => {
    const request = buildRequest('video', { provider: 'agnes', base: 'https://apihub.agnes-ai.com/v1', key: 'k', model: 'agnes-video-2.5-flash', size: '720P', seconds: '5', extra: '{"aspect_ratio":"9:16"}' }, '雨夜');
    assert.equal(request.url, 'https://apihub.agnes-ai.com/v1/videos');
    assert.deepEqual(JSON.parse(request.body), { aspect_ratio: '9:16', model: 'agnes-video-2.5-flash', prompt: '雨夜', seconds: '5', size: '720P', mode: 'text' });
    assert.deepEqual(taskLinks({ id: 'task_1' }, request), { status: 'https://apihub.agnes-ai.com/v1/videos/task_1', result: 'https://apihub.agnes-ai.com/v1/videos/task_1/content' });
});
test('fal 与 Replicate 请求不猜模型参数，禁止任务认证跨域', () => {
    const fal = buildRequest('video', { ...cfg, base: 'https://queue.fal.run', provider: 'fal', model: 'fal-ai/model/text-to-video', extra: '{"duration":5}' }, 'cat');
    assert.equal(fal.headers.Authorization, 'Key test-only');
    assert.deepEqual(JSON.parse(fal.body), { duration: 5, prompt: 'cat' });
    assert.throws(() => taskLinks({ status_url: 'https://bad.test/status', response_url: 'https://bad.test/result' }, fal), /跨域/);
    const replicate = buildRequest('video', { ...cfg, provider: 'replicate', model: 'owner/model:version123' }, 'cat');
    assert.equal(replicate.url, 'https://example.test/v1/predictions');
    assert.equal(JSON.parse(replicate.body).version, 'version123');
});
test('队列顺序查询、退避封顶、不下载结果视频', async () => {
    const calls = [], delays = [];
    let gets = 0;
    const result = await generateMedia('video', cfg, 'cat', {
        request: async (url, options) => {
            calls.push([url, options.method || 'GET']);
            if (options.method === 'POST') return { id: 'task-id' };
            return ++gets < 6 ? { status: 'RUNNING' } : { status: 'SUCCEEDED', output: ['https://cdn.test/result.mp4'] };
        }, sleep: async (delay) => { delays.push(delay); },
    });
    assert.equal(result.url, 'https://cdn.test/result.mp4');
    assert.equal(calls.filter((x) => x[1] === 'POST').length, 1);
    assert.ok(calls.every(([url]) => !url.includes('cdn.test')));
    assert.deepEqual(delays, [5000, 7500, 11250, 15000, 15000, 15000]);
    assert.equal(pendingMediaCount(), 0);
});
test('停止后继续查询复用任务和原配置，不再 POST', async () => {
    const controller = new AbortController();
    let task, posts = 0;
    await assert.rejects(generateMedia('video', cfg, 'cat', {
        signal: controller.signal, onTask: (handle) => { task = handle; },
        request: async () => { posts++; return { id: 'original' }; },
        sleep: async () => { controller.abort(new Error('stop')); },
    }), /stop/);
    const output = await generateMedia('video', {}, '', {
        resume: task, request: async (url, options) => {
            assert.equal(options.method, undefined);
            assert.equal(url, 'https://example.test/v1/tasks/original');
            assert.equal(options.headers.Authorization, 'Bearer test-only');
            return { status: 'SUCCEEDED', output: ['https://cdn.test/video.mp4'] };
        },
    });
    assert.equal(posts, 1); assert.ok(output.url);
});
test('失败、过期后不继续查询；不认识的状态按进行中继续，截止时间兜底', async () => {
    for (const status of ['FAILED', 'expired']) {
        let calls = 0;
        await assert.rejects(generateMedia('video', cfg, 'cat', { request: async () => { calls++; return { id: 'id', status }; } }));
        assert.equal(calls, 1);
    }
    let polls = 0;
    const done = await generateMedia('video', cfg, 'cat', {
        sleep: async () => {},
        request: async (url, options) => (options.method === 'POST' ? { id: 'id', status: 'rendering' }
            : ++polls < 3 ? { status: 'post_processing' } : { status: 'done', output: ['https://cdn.test/v.mp4'] }),
    });
    assert.equal(done.url, 'https://cdn.test/v.mp4');
    assert.equal(polls, 3);
    let clock = 0, calls = 0;
    await assert.rejects(generateMedia('video', { ...cfg, timeout: 30000 }, 'cat', {
        now: () => clock, request: async () => { calls++; return { id: 'id', status: 'RUNNING' }; }, sleep: async () => { clock = 30001; },
    }), /超时/);
    assert.equal(calls, 1);
});
test('fal 完成后拉取结果，完成状态携带 error 也视为失败', async () => {
    const config = { ...cfg, provider: 'fal', base: 'https://queue.fal.run', model: 'fal-ai/model' };
    const urls = { status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result', request_id: 'r1' };
    const calls = [];
    const output = await generateMedia('video', config, 'cat', {
        request: async (url, options) => {
            calls.push(url);
            return options.method === 'POST' ? { ...urls, status: 'COMPLETED' } : { video: { url: 'https://cdn.test/video.mp4' } };
        },
    });
    assert.equal(output.url, 'https://cdn.test/video.mp4');
    assert.equal(calls.length, 2);
    await assert.rejects(generateMedia('video', config, 'cat', { request: async () => ({ ...urls, status: 'COMPLETED', error: 'failed' }) }), /失败/);
});
test('兼容视频完成只返回内容描述；按需下载，CDN 不带密钥', async () => {
    const result = await generateMedia('video', { ...cfg, provider: 'openai' }, 'cat', { request: async () => ({ id: 'video_1', status: 'completed' }) });
    assert.equal(result.contentRequest.url, 'https://example.test/v1/videos/video_1/content');
    const agnes = await generateMedia('video', { ...cfg, provider: 'agnes', size: '720P' }, 'cat', { request: async () => ({ id: 'a1', status: 'completed' }) });
    assert.equal(agnes.contentRequest.url, 'https://example.test/v1/videos/a1/content');
    for (const output of [result, { url: 'https://cdn.test/video.mp4' }]) {
        const blob = await downloadVideo(output, { request: async (url, options, binary, limit) => {
            assert.equal(options.redirect, 'follow'); // /content 常 302 到对象存储
            assert.equal(options.headers.Authorization, output === result ? 'Bearer test-only' : undefined);
            assert.equal(limit, 128 * 1024 * 1024); assert.equal(binary, true);
            return new Blob(['video'], { type: 'video/mp4' });
        } });
        assert.equal(blob.type, 'video/mp4');
    }
    await assert.rejects(downloadVideo(result, { request: async () => new Blob(['audio'], { type: 'audio/mpeg' }) }), /视频/);
});
test('视频设置默认 /videos 兼容服务（Runway 要开代理，TauriTavern 里用不了），等待时间换算成毫秒交给客户端', () => {
    const media = readMediaSettings({}, 'video');
    assert.equal(media.provider, 'openai');
    assert.equal(media.proxy, false);
    const config = mediaRequestConfig({ ...media, timeout: '900' });
    assert.equal(config.timeout, 900_000);
    assert.equal(config.model, 'sora-2');
    // 以前存过 Runway 的照旧
    assert.equal(readMediaSettings({ video: { provider: 'runway' } }, 'video').provider, 'runway');
});

test('服务列表：TauriTavern 里不列只能走酒馆代理的服务（当前选中的除外，并注明），不常用的放「其他」', () => {
    const tt = { hostname: 'tauri.localhost', protocol: 'http:' };
    assert.equal(isTauriTavern(tt, {}), true);
    assert.equal(isTauriTavern({ hostname: 'localhost', protocol: 'tauri:' }, {}), true);
    assert.equal(isTauriTavern({ hostname: '127.0.0.1', protocol: 'http:' }, {}), false);
    const values = (list) => list.map((o) => o.value);
    assert.deepEqual(values(providerOptions('video', PROVIDERS.video, 'agnes', { tauri: true })), ['openai', 'agnes', 'fal', 'comfyui']);
    assert.deepEqual(values(providerOptions('audio', PROVIDERS.audio, 'openai', { tauri: true })), ['openai', 'elevenlabs', 'azure']);
    const kept = providerOptions('video', PROVIDERS.video, 'runway', { tauri: true }).find((o) => o.value === 'runway');
    assert.match(kept.text, /TauriTavern 里用不了/);
    const browser = providerOptions('video', PROVIDERS.video, 'agnes', { tauri: false });
    assert.deepEqual(browser.filter((o) => o.more).map((o) => o.value), ['runway', 'replicate']);
    assert.ok(browser.every((o) => !o.text.includes('用不了')));
    assert.deepEqual(providerOptions('audio', PROVIDERS.audio, 'openai', { tauri: false }).filter((o) => o.more).map((o) => o.value), ['fish']);
});
test('酒馆代理：URL 改写到 /proxy/，任务查询和下载都走代理', async () => {
    assert.equal(proxyUrl('https://api.dev.runwayml.com/v1/tasks/x'), '/proxy/https://api.dev.runwayml.com/v1/tasks/x');
    assert.throws(() => proxyUrl('javascript:alert(1)'));
    const urls = [];
    let gets = 0;
    const result = await generateMedia('video', { ...cfg, proxy: true }, 'cat', {
        sleep: async () => {},
        request: async (url, options) => {
            urls.push(url);
            if (options.method === 'POST') return { id: 'job' };
            return ++gets < 2 ? { status: 'RUNNING' } : { status: 'SUCCEEDED', output: ['https://cdn.test/v.mp4'] };
        },
    });
    assert.ok(urls.every((url) => url.startsWith('/proxy/https://example.test/v1/')), urls.join(' '));
    let downloaded = '';
    await downloadVideo(result, { proxy: true, request: async (url) => { downloaded = url; return new Blob(['v'], { type: 'video/mp4' }); } });
    assert.equal(downloaded, '/proxy/https://cdn.test/v.mp4');
});
test('酒馆代理只转发 JSON：Azure SSML 在提交前拒绝，/videos JSON 可以走代理', async () => {
    let calls = 0;
    const request = async () => { calls++; return {}; };
    await assert.rejects(generateMedia('audio', { provider: 'azure', base: 'https://eastasia.tts.speech.microsoft.com', key: 'k', voice: 'v', proxy: true }, 'hi', { request }), /代理/);
    assert.equal(calls, 0);
    assert.equal(pendingMediaCount(), 0);
});

test('进度按服务换算：Runway 0–1，/videos 兼容 0–100', async () => {
    for (const [provider, progress, expected] of [['runway', 0.25, '25%'], ['openai', 40, '40%']]) {
        const messages = [];
        let gets = 0;
        const config = provider === 'runway' ? cfg : { ...cfg, provider, model: 'sora-2', size: '1280x720', seconds: 4 };
        await generateMedia('video', config, 'cat', {
            onProgress: (message) => messages.push(message), sleep: async () => {},
            request: async (url, options) => {
                if (options.method === 'POST') return { id: 'task-id', status: 'in_progress', progress };
                return ++gets < 2 ? { status: 'in_progress', progress } : { status: 'completed', output: ['https://cdn.test/v.mp4'] };
            },
        });
        assert.ok(messages.some((m) => m.endsWith(expected)), `${provider}: ${messages.join(' | ')}`);
    }
});
test('识别常见音视频文件头（酒馆代理不带 Content-Type 时用）', () => {
    const bytes = (...values) => [new Uint8Array(values)];
    const text = (s, pad = 0) => [new Uint8Array([...Array(pad).fill(0), ...[...s].map((c) => c.charCodeAt(0)), 0, 0, 0, 0])];
    assert.equal(sniffMediaType(bytes(0x1a, 0x45, 0xdf, 0xa3, 1)), 'video/webm');
    assert.equal(sniffMediaType([new Uint8Array([0, 0, 0, 0x18]), new TextEncoder().encode('ftypisom')]), 'video/mp4');
    assert.equal(sniffMediaType([new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ')]), 'audio/wav');
    assert.equal(sniffMediaType(text('OggS')), 'audio/ogg');
    assert.equal(sniffMediaType(text('ID3')), 'audio/mpeg');
    assert.equal(sniffMediaType(bytes(0xff, 0xfb, 0x90, 0x64)), 'audio/mpeg');
    assert.equal(sniffMediaType(text('<html>')), '');
});
test('真实 HTTP：无 Content-Type 的视频按文件头识别，无法识别的内容拒绝', async (t) => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
        res.writeHead(200); // 模拟酒馆代理：没有 Content-Type
        res.end(req.url === '/clip' ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]) : '<html>error page</html>');
    }).listen(0);
    t.after(() => server.close());
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const blob = await downloadVideo({ url: `${base}/clip` });
    assert.equal(blob.type, 'video/webm');
    await assert.rejects(downloadVideo({ url: `${base}/html` }), /可识别/);
});

test('轮询请求跳过 HTTP 缓存（有网关给状态接口发 Cache-Control: public, max-age=14400，浏览器会把首个 queued 响应缓存几小时）', async (t) => {
    const caches = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        caches.push(init?.cache);
        if (String(url).endsWith('/content')) return new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]), { status: 200, headers: { 'Content-Type': 'video/webm' } });
        return new Response(JSON.stringify({ status: 'completed' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    t.after(() => { globalThis.fetch = original; });
    const { requestData } = await import('../src/media/client.js');
    await requestData('https://example.test/v1/videos/task_1');
    await downloadVideo({ url: 'https://example.test/v1/videos/task_1/content' });
    assert.deepEqual(caches, ['no-store', 'no-store']);
});

test('/videos 兼容服务可经代理提交', async () => {
    const urls = [];
    await generateMedia('video', { ...cfg, provider: 'openai', model: 'sora-2', proxy: true }, 'cat', {
        request: async (url) => { urls.push(url); return { id: 'v1', status: 'completed' }; },
    });
    assert.deepEqual(urls, ['/proxy/https://example.test/v1/videos']);
});
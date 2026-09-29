import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, getEventListeners } from 'node:events';
import { apiFetch, fetchWithTimeout, xhrRequest } from '../src/core/net.js';
import { downloadVideo, downloadMedia, generateMedia, pendingMediaCount } from '../src/media/client.js';

async function serverFor(t, handler) {
    const server = createServer(handler).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
}

test('图片网络截止时间覆盖响应头之后未完成的正文', async (t) => {
    const base = await serverFor(t, (_, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
    });
    await assert.rejects(fetchWithTimeout(base, { timeout: 50 }), /超时/);
});

test('图片正文接收期间仍响应外部取消；成功保留 Response URL、头和可读正文', async (t) => {
    let started;
    const receiving = new Promise((resolve) => { started = resolve; });
    const base = await serverFor(t, (req, res) => {
        if (req.url === '/slow') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{');
            started();
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Fixture': 'ok' });
            res.end('{"ok":true}');
        }
    });
    const controller = new AbortController();
    const pending = fetchWithTimeout(`${base}/slow`, { signal: controller.signal });
    const rejected = assert.rejects(pending, /fixture-stop/);
    await receiving;
    controller.abort(new Error('fixture-stop'));
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const completed = new AbortController();
    const response = await fetchWithTimeout(base, { signal: completed.signal });
    assert.equal(response.url, `${base}/`);
    assert.equal(response.headers.get('X-Fixture'), 'ok');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
});

test('HTTP XHR 保留 PNG 原始字节，并继续支持 JSON 与请求前取消', async (t) => {
    const original = globalThis.XMLHttpRequest;
    t.after(() => { globalThis.XMLHttpRequest = original; });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 255, 254, 128]);
    let sent = 0;
    class BinaryXhr {
        open(_, url) { this.url = url; }
        setRequestHeader() {}
        getAllResponseHeaders() { return `Content-Type: ${this.url.endsWith('json') ? 'application/json' : 'image/png'}`; }
        get responseText() { throw new Error('二进制响应不能读取 responseText'); }
        send() {
            sent++;
            assert.equal(this.responseType, 'arraybuffer');
            this.status = 200;
            this.statusText = 'OK';
            this.response = this.url.endsWith('json') ? new TextEncoder().encode('{"ok":true}').buffer : png.buffer;
            queueMicrotask(() => this.onload());
        }
    }
    globalThis.XMLHttpRequest = BinaryXhr;
    const image = await apiFetch('http://fixture.test/png');
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(await (await xhrRequest('http://fixture.test/json')).json(), { ok: true });
    const stopped = new AbortController(); stopped.abort(new Error('before-send'));
    await assert.rejects(xhrRequest('http://fixture.test/png', { signal: stopped.signal }), /before-send/);
    assert.equal(sent, 2);
});

test('自定义 API Key 下载拒绝跳转；公开和 Bearer 内容仍能安全跟随跨源跳转', async (t) => {
    const cdnHeaders = [];
    const cdn = await serverFor(t, (req, res) => {
        cdnHeaders.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end('fixture-video');
    });
    const receivedKeys = [];
    const api = await serverFor(t, (req, res) => {
        receivedKeys.push(req.headers['x-goog-api-key']);
        res.writeHead(302, { Location: cdn }); res.end();
    });
    await assert.rejects(downloadVideo({ contentRequest: { url: api, headers: { 'x-goog-api-key': 'fake-only-key' } } }), /网络请求失败/);
    assert.deepEqual(receivedKeys, ['fake-only-key']);
    assert.equal(cdnHeaders.length, 0);
    const publicBlob = await downloadVideo({ url: api });
    const bearerBlob = await downloadVideo({ contentRequest: { url: api, headers: { Authorization: 'Bearer fake-only' } } });
    assert.equal(publicBlob.type, 'video/mp4');
    assert.equal(bearerBlob.type, 'video/mp4');
    assert.equal(cdnHeaders.length, 2);
    assert.ok(cdnHeaders.every((headers) => !headers.authorization && !headers['x-goog-api-key']));
});

test('自定义与 Bearer 鉴权头不能绕经代理下载；音频也应用相同跳转保护', async () => {
    let calls = 0;
    const result = { contentRequest: { url: 'https://fixture.test/download', headers: { 'X-Goog-Api-Key': 'fake-only' } } };
    const request = async (_, options) => {
        calls++;
        assert.equal(options.redirect, 'error');
        return new Blob(['audio'], { type: 'audio/wav' });
    };
    assert.equal((await downloadMedia(result, 'audio', { request })).type, 'audio/wav');
    await assert.rejects(downloadVideo(result, { proxy: true, request }), /不能经酒馆代理/);
    await assert.rejects(downloadVideo({ contentRequest: { url: result.contentRequest.url, headers: { Authorization: 'Bearer fake-only' } } }, { proxy: true, request }), /不能经酒馆代理/);
    assert.equal(calls, 1);
});

test('自建服务首次异步初始化前占两槽；取消和无效配置释放槽位', async () => {
    const config = { provider: 'sdwebui', viaTavern: false, base: 'http://127.0.0.1:7860' };
    const controllers = [new AbortController(), new AbortController()];
    const entered = [];
    const request = async (_, { signal }) => {
        entered.push(signal);
        return new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
    };
    const jobs = controllers.map((controller) => generateMedia('image', config, 'fixture', { signal: controller.signal, fetch: request }));
    const settled = Promise.allSettled(jobs);
    assert.equal(pendingMediaCount(), 2);
    await assert.rejects(generateMedia('image', config, 'third', { fetch: request }), /两个媒体任务/);
    controllers.forEach((controller) => controller.abort(new Error('fixture-stop')));
    assert.ok((await settled).every((result) => result.status === 'rejected'));
    assert.equal(entered.length, 0);
    assert.equal(pendingMediaCount(), 0);
    await assert.rejects(generateMedia('image', config, '', { fetch: request }), /请输入/);
    assert.equal(pendingMediaCount(), 0);
    const completed = await generateMedia('image', config, 'fixture', { fetch: async () => Response.json({ images: ['fixture-base64'] }) });
    assert.equal(completed.url, 'data:image/png;base64,fixture-base64');
    assert.equal(pendingMediaCount(), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { generateMedia } from '../src/media/client.js';
import { buildRequest } from '../src/media/providers.js';
import { hs256Jwt, nearestRatio, pcmToWav, videoShape } from '../src/media/vendors.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 假的服务端：按顺序给出响应，记下每次请求（地址、方法、头、请求体）。
 * route 是 [匹配, 响应] 的数组；响应可以是对象（当 JSON）、Blob（二进制）或函数。
 */
function fakeServer(routes) {
    const calls = [];
    const queue = routes.map(([match, reply]) => ({ match, reply }));
    const request = async (url, init = {}, binary = false) => {
        calls.push({ url, method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body, binary });
        const index = queue.findIndex((r) => (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)));
        if (index < 0) throw new Error(`没有预设的响应：${url}`);
        const [{ reply }] = queue.splice(index, 1);
        const value = typeof reply === 'function' ? reply(url, init) : reply;
        if (value instanceof Error) throw value;
        return value;
    };
    return { calls, request, sleep: async () => {} };
}

const run = (kind, config, prompt, server, extra = {}) => generateMedia(kind, { key: 'k-test', ...config }, prompt, { request: server.request, sleep: server.sleep, ...extra });
const body = (call) => (typeof call.body === 'string' ? JSON.parse(call.body) : call.body);

/* ---------- 图片 ---------- */

test('MiniMax 图片：要 base64、宽高取 8 的倍数、负面写进描述；base_resp 报错说人话', async () => {
    const server = fakeServer([['/v1/image_generation', { data: { image_base64: [PNG_B64] }, base_resp: { status_code: 0 } }]]);
    const result = await run('image', { provider: 'minimax', size: '1023x767', negative: 'blurry' }, 'cat', server);
    assert.equal(result.url, `data:image/png;base64,${PNG_B64}`);
    const [call] = server.calls;
    assert.equal(call.url, 'https://api.minimax.cn/v1/image_generation');
    assert.equal(call.headers.Authorization, 'Bearer k-test');
    assert.deepEqual([body(call).width, body(call).height, body(call).response_format, body(call).model], [1024, 768, 'base64', 'image-01']);
    assert.match(body(call).prompt, /cat[\s\S]*blurry/);
    const bad = fakeServer([['/v1/image_generation', { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }]]);
    await assert.rejects(run('image', { provider: 'minimax' }, 'cat', bad), /1008（余额不足）/);
});

test('百炼图片：万相走异步任务（提交带异步头，查询不带），qwen-image 同步直接出图', async () => {
    const server = fakeServer([
        ['/image-synthesis', { output: { task_id: 't1', task_status: 'PENDING' } }],
        ['/api/v1/tasks/t1', { output: { task_id: 't1', task_status: 'RUNNING' } }],
        ['/api/v1/tasks/t1', { output: { task_id: 't1', task_status: 'SUCCEEDED', results: [{ url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.png' }] } }],
    ]);
    const result = await run('image', { provider: 'dashscope', size: '1024x768', negative: 'bad' }, '猫', server);
    assert.equal(result.url, 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.png');
    const [create, poll] = server.calls;
    assert.equal(create.headers['X-DashScope-Async'], 'enable');
    assert.deepEqual(body(create).parameters.size, '1024*768');
    assert.equal(body(create).input.negative_prompt, 'bad');
    assert.equal(body(create).parameters.n, 1);
    assert.equal(poll.headers['X-DashScope-Async'], undefined); // 查询接口跨域只放行 Authorization
    assert.equal(poll.headers['Content-Type'], undefined);
    assert.equal(poll.headers.Authorization, 'Bearer k-test');

    const sync = fakeServer([['/multimodal-generation/generation', { output: { choices: [{ message: { content: [{ image: 'https://x.aliyuncs.com/q.png' }] } }] } }]]);
    const q = await run('image', { provider: 'dashscope', model: 'qwen-image-plus', size: '1328x1328' }, '猫', sync);
    assert.equal(q.url, 'https://x.aliyuncs.com/q.png');
    assert.equal(sync.calls.length, 1);
    assert.equal(body(sync.calls[0]).input.messages[0].content[0].text, '猫');
});

test('Stability：multipart 表单、按尺寸换成最近的比例、sd3 模型走 sd3 端点；内容被过滤时报错', async () => {
    const server = fakeServer([['/generate/sd3', { image: PNG_B64, finish_reason: 'SUCCESS' }]]);
    const result = await run('image', { provider: 'stability', model: 'sd3.5-large', size: '1344x768', extra: '{"style_preset":"anime"}' }, 'cat', server);
    assert.match(result.url, /^data:image\/png;base64,/);
    const form = server.calls[0].body;
    assert.ok(form instanceof FormData);
    assert.deepEqual([form.get('aspect_ratio'), form.get('model'), form.get('style_preset')], ['16:9', 'sd3.5-large', 'anime']);
    assert.equal(server.calls[0].headers.Accept, 'application/json');
    const filtered = fakeServer([['/generate/core', { image: PNG_B64, finish_reason: 'CONTENT_FILTERED' }]]);
    await assert.rejects(run('image', { provider: 'stability' }, 'x', filtered), /模糊图/);
    await assert.rejects(run('image', { provider: 'stability', proxy: true }, 'x', filtered), /不能走酒馆代理/);
});

test('Pollinations：不填 Key 也能用，GET 回图片二进制转成 data URL', async () => {
    const png = new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });
    const server = fakeServer([['/image/', png]]);
    const result = await run('image', { provider: 'pollinations', key: '', size: '832x1216', extra: '{"seed":7}' }, 'a cat', server);
    assert.match(result.url, /^data:image\/png;base64,iVBOR/);
    const [call] = server.calls;
    assert.equal(call.method, 'GET');
    assert.equal(call.binary, true);
    assert.equal(call.headers.Authorization, undefined);
    const url = new URL(call.url);
    assert.equal(url.pathname, '/image/a%20cat');
    assert.deepEqual([url.searchParams.get('width'), url.searchParams.get('seed')], ['832', '7']);
});

test('AI Horde：匿名 Key、Client-Agent；check 排队 → done，再从 status 取图；没有 worker 时说清楚', async () => {
    const server = fakeServer([
        ['/generate/async', { id: 'h1' }],
        ['/generate/check/h1', { done: false, queue_position: 3, is_possible: true }],
        ['/generate/check/h1', { done: true, is_possible: true }],
        ['/generate/status/h1', { generations: [{ img: 'https://r2.example/h1.webp' }] }],
    ]);
    const progress = [];
    const result = await run('image', { provider: 'horde', key: '', size: '500x700', negative: 'ugly' }, 'cat', server, { onProgress: (t) => progress.push(t) });
    assert.equal(result.url, 'https://r2.example/h1.webp');
    const [create, check] = server.calls;
    assert.equal(create.headers.apikey, '0000000000');
    assert.match(create.headers['Client-Agent'], /^st-ai-image:/);
    assert.equal(check.headers.apikey, '0000000000');
    assert.equal(body(create).prompt, 'cat ### ugly');
    assert.deepEqual([body(create).params.width, body(create).params.height], [512, 704]);
    assert.ok(progress.some((t) => t.includes('排队第 3 位')), progress);
    const impossible = fakeServer([['/generate/async', { id: 'h2' }], ['/generate/check/h2', { done: false, is_possible: false }]]);
    await assert.rejects(run('image', { provider: 'horde', key: '' }, 'cat', impossible), /没有能跑/);
});

/* ---------- 配音 ---------- */

test('MiniMax 语音：hex 音频转成 mp3；音色、语言、额外参数都放对位置', async () => {
    const server = fakeServer([['/v1/t2a_v2', { data: { audio: '494433', status: 2 }, base_resp: { status_code: 0 } }]]);
    const result = await run('audio', { provider: 'minimax', voice: 'male-qn-qingse', language: 'Chinese', extra: '{"voice_setting":{"speed":1.2}}' }, '你好', server);
    assert.equal(result.blob.type, 'audio/mpeg');
    assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [0x49, 0x44, 0x33]);
    const b = body(server.calls[0]);
    assert.deepEqual([b.voice_setting.voice_id, b.voice_setting.speed, b.language_boost, b.output_format, b.stream], ['male-qn-qingse', 1.2, 'Chinese', 'hex', false]);
});

test('百炼语音：Qwen-TTS 和 CosyVoice 两个端点，返回的 http 链接换成 https', async () => {
    const qwen = fakeServer([['/multimodal-generation/generation', { output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav' } } }]]);
    const r = await run('audio', { provider: 'dashscope', voice: 'Dylan', language: 'Chinese' }, '你好', qwen);
    assert.equal(r.url, 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav');
    assert.deepEqual(body(qwen.calls[0]).input, { text: '你好', voice: 'Dylan', language_type: 'Chinese' });
    const cosy = fakeServer([['/audio/tts/SpeechSynthesizer', { output: { audio: { url: 'https://x.aliyuncs.com/b.mp3' } } }]]);
    await run('audio', { provider: 'dashscope', model: 'cosyvoice-v3-flash', voice: 'longanhuan_v3.6' }, '你好', cosy);
    assert.equal(body(cosy.calls[0]).input.voice, 'longanhuan_v3.6');
});

test('Gemini TTS：Key 放 x-goog-api-key；3.8 直接给 WAV，旧模型给 PCM 自己包 WAV 头', async () => {
    const wav = pcmToWav(new Uint8Array([1, 0, 2, 0]), 24000);
    const wavB64 = Buffer.from(await wav.arrayBuffer()).toString('base64');
    const server = fakeServer([[':generateContent', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wavB64 } }] } }] }]]);
    const r = await run('audio', { provider: 'gemini', voice: 'Puck' }, 'hi', server);
    assert.equal(r.blob.type, 'audio/wav');
    const [call] = server.calls;
    assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
    assert.equal(call.headers['x-goog-api-key'], 'k-test');
    assert.equal(call.headers.Authorization, undefined);
    assert.deepEqual(body(call).generationConfig.speechConfig, { voiceConfig: { voice: 'Puck' } });

    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]).toString('base64');
    const old = fakeServer([[':generateContent', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=16000', data: pcm } }] } }] }]]);
    const o = await run('audio', { provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', voice: 'Kore' }, 'hi', old);
    const bytes = new Uint8Array(await o.blob.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
    assert.equal(new DataView(bytes.buffer).getUint32(24, true), 16000);
    assert.equal(bytes.length, 44 + 6);
    assert.deepEqual(body(old.calls[0]).generationConfig.speechConfig, { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } });
});

test('豆包语音：Key 拆成 appid 和 token，鉴权头是「Bearer;token」；code 不是 3000 就报错', async () => {
    const server = fakeServer([['/api/v1/tts', { code: 3000, data: Buffer.from('ID3').toString('base64') }]]);
    const r = await run('audio', { provider: 'volcengine', key: 'app123:tok456', voice: 'BV700_streaming' }, '你好', server);
    assert.equal(r.blob.type, 'audio/mpeg');
    const [call] = server.calls;
    assert.equal(call.headers.Authorization, 'Bearer;tok456');
    const b = body(call);
    assert.deepEqual([b.app.appid, b.app.cluster, b.audio.voice_type, b.request.operation], ['app123', 'volcano_tts', 'BV700_streaming', 'query']);
    await assert.rejects(run('audio', { provider: 'volcengine', key: 'onlytoken' }, '你好', server), /appid:token/);
    const bad = fakeServer([['/api/v1/tts', { code: 3050, message: 'voice not found' }]]);
    await assert.rejects(run('audio', { provider: 'volcengine', key: 'a:b' }, '你好', bad), /3050/);
});

test('GPT-SoVITS：本地不要 Key，音色栏是参考音频路径，直接回音频', async () => {
    const server = fakeServer([['/tts', new Blob(['RIFF'], { type: 'audio/wav' })]]);
    const r = await run('audio', { provider: 'gptsovits', key: '', voice: 'D:/ref/a.wav', language: 'ja', extra: '{"prompt_text":"こんにちは"}' }, 'テスト', server);
    assert.equal(r.blob.type, 'audio/wav');
    assert.deepEqual([body(server.calls[0]).ref_audio_path, body(server.calls[0]).text_lang, body(server.calls[0]).prompt_text], ['D:/ref/a.wav', 'ja', 'こんにちは']);
    assert.equal(server.calls[0].headers.Authorization, undefined);
    await assert.rejects(run('audio', { provider: 'gptsovits', key: '', voice: '' }, 'x', server), /参考音频/);
});

/* ---------- 视频 ---------- */

test('视频尺寸栏：720p / 16:9 / 1280x720 都能拆成分辨率和比例', () => {
    assert.deepEqual(videoShape('1080P'), { resolution: '1080p', ratio: '16:9' });
    assert.deepEqual(videoShape('9:16'), { resolution: '720p', ratio: '9:16' });
    assert.deepEqual(videoShape('720x1280'), { resolution: '720p', ratio: '9:16', width: 720, height: 1280 });
    assert.equal(nearestRatio('1000x1000', ['16:9', '1:1', '9:16']), '1:1');
});

test('Seedance：JSON 字段传分辨率和时长，轮询 tasks/{id}，失败原因带出来', async () => {
    const server = fakeServer([
        ['/contents/generations/tasks', { id: 'cgt-1' }],
        ['/tasks/cgt-1', { id: 'cgt-1', status: 'running' }],
        ['/tasks/cgt-1', { id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://tos.example/v.mp4' } }],
    ]);
    const tasks = [];
    const r = await run('video', { provider: 'ark', size: '1080p', seconds: '8' }, '小猫', server, { onTask: (t) => tasks.push(t) });
    assert.equal(r.url, 'https://tos.example/v.mp4');
    assert.deepEqual(body(server.calls[0]).content, [{ type: 'text', text: '小猫' }]);
    assert.deepEqual([body(server.calls[0]).resolution, body(server.calls[0]).duration, body(server.calls[0]).watermark], ['1080p', 8, false]);
    assert.equal(tasks[0].links.status, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-1');
    const failed = fakeServer([['/contents/generations/tasks', { id: 'x' }], ['/tasks/x', { status: 'failed', error: { message: 'sensitive content' } }]]);
    await assert.rejects(run('video', { provider: 'ark' }, 'x', failed), (e) => e.terminal && /sensitive content/.test(e.message));
});

test('海螺 V1：成功后用 file_id 换下载地址；H3 走 V2 接口', async () => {
    const server = fakeServer([
        ['/v1/video_generation', { task_id: 'm1', base_resp: { status_code: 0 } }],
        ['/v1/query/video_generation?task_id=m1', { status: 'Processing', base_resp: { status_code: 0 } }],
        ['/v1/query/video_generation?task_id=m1', { status: 'Success', file_id: 'f9', base_resp: { status_code: 0 } }],
        ['/v1/files/retrieve?file_id=f9', { file: { download_url: 'https://oss.example/m1.mp4' }, base_resp: { status_code: 0 } }],
    ]);
    const r = await run('video', { provider: 'minimax', size: '1080P', seconds: '6' }, '海边', server);
    assert.equal(r.url, 'https://oss.example/m1.mp4');
    assert.deepEqual([body(server.calls[0]).resolution, body(server.calls[0]).duration, body(server.calls[0]).model], ['1080P', 6, 'MiniMax-Hailuo-2.3']);
    const v2 = fakeServer([
        ['/v2/video_generation', { task_id: 'h3' }],
        ['/v2/query/video_generation/h3', { task: { status: 'succeeded', content: { url: 'https://oss.example/h3.mp4' } } }],
    ]);
    const r2 = await run('video', { provider: 'minimax', model: 'MiniMax-H3', size: '768P' }, '海边', v2);
    assert.equal(r2.url, 'https://oss.example/h3.mp4');
    assert.deepEqual(body(v2.calls[0]).content, [{ type: 'text', text: '海边' }]);
});

test('万相视频：2.7 用 resolution + ratio，2.6 及以前用像素 size；链接换 https', async () => {
    const server = fakeServer([
        ['/video-synthesis', { output: { task_id: 'w1', task_status: 'PENDING' } }],
        ['/api/v1/tasks/w1', { output: { task_id: 'w1', task_status: 'SUCCEEDED', video_url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/w.mp4' } }],
    ]);
    const r = await run('video', { provider: 'dashscope', size: '9:16', seconds: '10' }, '雨夜', server);
    assert.equal(r.url, 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/w.mp4');
    assert.deepEqual(body(server.calls[0]).parameters, { resolution: '720P', ratio: '9:16', duration: 10, watermark: false });
    const old = fakeServer([['/video-synthesis', { output: { task_id: 'w2' } }], ['/tasks/w2', { output: { task_id: 'w2', task_status: 'SUCCEEDED', video_url: 'https://a.aliyuncs.com/w2.mp4' } }]]);
    await run('video', { provider: 'dashscope', model: 'wan2.2-t2v-plus', size: '1080p' }, 'x', old);
    assert.equal(body(old.calls[0]).parameters.size, '1920*1080');
});

test('Veo：operation 轮询到 done，结果要带 Key 下载（只有同源才带）', async () => {
    const server = fakeServer([
        [':predictLongRunning', { name: 'models/veo-3.1-fast-generate-preview/operations/op1' }],
        ['/operations/op1', { done: false }],
        ['/operations/op1', { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media' } }] } } }],
    ]);
    const r = await run('video', { provider: 'veo', size: '9:16', seconds: '6' }, 'a cat', server);
    assert.deepEqual(r.contentRequest, { url: 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media', headers: { 'x-goog-api-key': 'k-test' } });
    assert.deepEqual(body(server.calls[0]).parameters, { aspectRatio: '9:16', durationSeconds: '6', resolution: '720p' });
    assert.equal(server.calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview/operations/op1');
    const foreign = fakeServer([[':predictLongRunning', { name: 'operations/x' }], ['/operations/x', { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://evil.example/v.mp4' } }] } } }]]);
    assert.deepEqual((await run('video', { provider: 'veo' }, 'x', foreign)).contentRequest.headers, {});
});

test('智谱 / 硅基流动 / Vidu / Luma：各自的查询地址和状态名', async () => {
    const zhipu = fakeServer([['/videos/generations', { id: 'z1' }], ['/async-result/z1', { task_status: 'SUCCESS', video_result: [{ url: 'https://z.example/v.mp4' }] }]]);
    assert.equal((await run('video', { provider: 'zhipu' }, 'x', zhipu)).url, 'https://z.example/v.mp4');
    assert.equal(zhipu.calls[1].url, 'https://open.bigmodel.cn/api/paas/v4/async-result/z1');

    const sf = fakeServer([['/video/submit', { requestId: 'r1' }], ['/video/status', { status: 'InProgress' }], ['/video/status', { status: 'Succeed', results: { videos: [{ url: 'https://s.example/v.mp4' }] } }]]);
    assert.equal((await run('video', { provider: 'siliconflow', size: '9:16' }, 'x', sf)).url, 'https://s.example/v.mp4');
    assert.equal(body(sf.calls[0]).image_size, '720x1280');
    assert.deepEqual([sf.calls[1].method, JSON.parse(sf.calls[1].body)], ['POST', { requestId: 'r1' }]);

    const vidu = fakeServer([['/ent/v2/text2video', { task_id: 'v1', state: 'created' }], ['/tasks/v1/creations', { state: 'success', creations: [{ url: 'https://v.example/v.mp4' }] }]]);
    assert.equal((await run('video', { provider: 'vidu' }, 'x', vidu)).url, 'https://v.example/v.mp4');
    assert.equal(vidu.calls[0].headers.Authorization, 'Token k-test');

    const luma = fakeServer([['/v1/generations', { id: 'l1', state: 'queued' }], ['/generations/l1', { state: 'completed', output: [{ type: 'video', url: 'https://l.example/v.mp4' }] }]]);
    assert.equal((await run('video', { provider: 'luma', seconds: '10' }, 'x', luma)).url, 'https://l.example/v.mp4');
    assert.deepEqual(body(luma.calls[0]).video, { resolution: '720p', duration: '10s' });
});

test('可灵：API Key 走新版接口；AccessKey:SecretKey 走旧版，每次请求现签 JWT（能被 SK 验过）', async () => {
    const modern = fakeServer([['/text-to-video/kling-2.6', { data: { id: 'k1', status: 'submitted' } }], ['/tasks?task_ids=k1', { data: [{ status: 'succeeded', outputs: [{ type: 'video', url: 'https://k.example/v.mp4' }] }] }]]);
    assert.equal((await run('video', { provider: 'kling', key: 'api-key-1', size: '9:16' }, 'x', modern)).url, 'https://k.example/v.mp4');
    assert.equal(modern.calls[0].headers.Authorization, 'Bearer api-key-1');
    assert.equal(body(modern.calls[0]).settings.aspect_ratio, '9:16');

    const now = () => 1_800_000_000_000;
    const legacy = fakeServer([['/v1/videos/text2video', { data: { task_id: 'k2' } }], ['/v1/videos/text2video/k2', { data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://k.example/old.mp4' }] } } }]]);
    const r = await run('video', { provider: 'kling', key: 'AK1:SK1' }, 'x', legacy, { now });
    assert.equal(r.url, 'https://k.example/old.mp4');
    assert.equal(body(legacy.calls[0]).model_name, 'kling-v2-1');
    const jwt = legacy.calls[1].headers.Authorization.replace(/^Bearer /, '');
    const [head, payload, sig] = jwt.split('.');
    assert.equal(createHmac('sha256', 'SK1').update(`${head}.${payload}`).digest('base64url'), sig);
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'AK1', exp: 1_800_001_800, nbf: 1_799_999_995 });
    assert.equal(await hs256Jwt({ a: 1 }, 's'), `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"a":1}').toString('base64url')}.${createHmac('sha256', 's').update(`${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"a":1}').toString('base64url')}`).digest('base64url')}`);
});

test('框架：开代理时每个请求都走 /proxy/；续查老任务不重新提交；HTTP 错误带上服务端原因', async () => {
    const proxied = fakeServer([['/proxy/https://api.vidu.cn/ent/v2/text2video', { task_id: 'p1' }], ['/proxy/https://api.vidu.cn/ent/v2/tasks/p1/creations', { state: 'success', creations: [{ url: 'https://v.example/p.mp4' }] }]]);
    await run('video', { provider: 'vidu', proxy: true }, 'x', proxied);
    assert.ok(proxied.calls.every((c) => c.url.startsWith('/proxy/')));

    // 续查：inline 用 buildRequest 重建请求头，links 来自聊天记录
    const plan = { ...buildRequest('video', { provider: 'ark', key: 'k-test', model: 'm' }, 'x'), proxy: false };
    assert.equal(plan.queue, true);
    const resumed = fakeServer([['/tasks/old', { status: 'succeeded', content: { video_url: 'https://tos.example/old.mp4' } }]]);
    const r = await run('video', { provider: 'ark' }, 'x', resumed, { resume: { plan, links: { status: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/old', id: 'old' } } });
    assert.equal(r.url, 'https://tos.example/old.mp4');
    assert.equal(resumed.calls.length, 1);
    assert.equal(resumed.calls[0].method, 'GET');

    const { errorMessageOf } = await import('../src/media/client.js');
    assert.equal(errorMessageOf('{"error":{"message":"invalid api key"}}'), 'invalid api key');
    assert.equal(errorMessageOf('{"base_resp":{"status_code":1004,"status_msg":"login fail"}}'), 'login fail');
    assert.equal(errorMessageOf('{"code":"InvalidApiKey","message":"bad"}'), 'bad');
    await assert.rejects(run('video', { provider: 'ark', key: '' }, 'x', resumed), /API Key/);
});

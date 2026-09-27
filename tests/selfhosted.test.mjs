import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSelfHostedPlan, fillWorkflow, parseSize, parseWorkflow, pickComfyOutput, placeholderValues, runSelfHosted, serviceRoot,
} from '../src/media/selfhosted.js';
import { buildRequest, isLocalBase, needsKey } from '../src/media/providers.js';
import { readMediaSettings } from '../src/media/media-settings.js';

const WORKFLOW = JSON.stringify({
    3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: '%steps%', cfg: '%cfg_scale%', model: ['4', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%MODEL_NAME%' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%宽度%', batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %提示词%' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: '100%_done', images: ['8', 0] } },
});

test('工作流：只收 API 格式，界面格式和坏 JSON 给出明确提示', () => {
    assert.equal(Object.keys(parseWorkflow(WORKFLOW)).length, 6);
    assert.throws(() => parseWorkflow('{"nodes": [], "links": []}'), /导出 \(API\)/);
    assert.throws(() => parseWorkflow('not json'), /不是有效的 JSON/);
    assert.throws(() => parseWorkflow('{"1": {"inputs": {}}}'), /API 格式/);
});

test('占位符：整串替换保留类型，夹在文字里按文字替换；中英文别名；额外参数可覆盖和新增；缺值报错', () => {
    const values = placeholderValues({ prompt: '一只 "橘猫"', negative: 'blurry', size: '832x480', model: 'sdxl.safetensors', extra: { steps: 28, lora: 'x' }, random: () => 42 });
    const filled = fillWorkflow(parseWorkflow(WORKFLOW), values);
    assert.equal(filled[3].inputs.seed, 42);
    assert.equal(filled[3].inputs.steps, 28); // 额外参数覆盖默认 20
    assert.equal(filled[3].inputs.cfg, 7);
    assert.deepEqual(filled[3].inputs.model, ['4', 0]); // 连线不动
    assert.equal(filled[4].inputs.ckpt_name, 'sdxl.safetensors');
    assert.deepEqual([filled[5].inputs.width, filled[5].inputs.height], [832, 832]); // %宽度% 是 width 的别名
    assert.equal(filled[6].inputs.text, 'masterpiece, 一只 "橘猫"');
    assert.equal(filled[7].inputs.text, 'blurry');
    assert.equal(filled[9].inputs.filename_prefix, '100%_done'); // 不是占位符的百分号不碰
    assert.throws(() => fillWorkflow({ 1: { class_type: 'X', inputs: { a: '%lora_weight%', b: 'x %不存在% y' } } }, values), /%lora_weight%、%不存在%/);
    assert.equal(fillWorkflow({ 1: { class_type: 'X', inputs: { a: '%lora%' } } }, values)[1].inputs.a, 'x');
});

test('占位符默认值：种子 -1/0/空 随机，帧数 = 秒数×帧率+1，尺寸认 x × * :', () => {
    assert.equal(placeholderValues({ prompt: 'p', extra: { seed: -1 }, random: () => 7 }).seed, 7);
    assert.equal(placeholderValues({ prompt: 'p', extra: { seed: 123 }, random: () => 7 }).seed, 123);
    const v = placeholderValues({ prompt: 'p', seconds: '5', random: () => 1 });
    assert.deepEqual([v.fps, v.frames], [16, 81]);
    assert.equal(placeholderValues({ prompt: 'p', seconds: '3', extra: { fps: 24 }, random: () => 1 }).frames, 73);
    assert.deepEqual(parseSize('832*480'), [832, 480]);
    assert.deepEqual(parseSize('720:1280'), [720, 1280]);
    assert.deepEqual(parseSize('auto'), [1024, 1024]);
});

test('挑输出：图片要 type=output 的图，视频要 gifs/videos 或视频扩展名', () => {
    const outputs = {
        10: { images: [{ filename: 'preview.png', type: 'temp' }] },
        11: { images: [{ filename: 'final.png', subfolder: 'a', type: 'output' }] },
        12: { gifs: [{ filename: 'clip.mp4', type: 'output', format: 'video/h264-mp4' }] },
    };
    assert.equal(pickComfyOutput(outputs, 'image').filename, 'final.png');
    assert.equal(pickComfyOutput(outputs, 'video').filename, 'clip.mp4');
    assert.equal(pickComfyOutput({ 1: { images: [{ filename: 'v.webm', type: 'output' }] } }, 'video').filename, 'v.webm'); // SaveVideo 输出在 images 里
    assert.equal(pickComfyOutput({ 1: { images: [{ filename: 'a.png', type: 'output' }] } }, 'video'), null);
});

test('请求计划：SD WebUI 的 txt2img 参数、认证和模型切换；ComfyUI 填好工作流；地址校验', () => {
    const sd = buildSelfHostedPlan('image', { provider: 'sdwebui', base: 'http://127.0.0.1:7860/', size: '512x768', negative: 'bad', model: 'anything-v5', auth: 'u:p', extra: '{"steps": 30, "sampler_name": "DPM++ 2M"}' }, 'cat', { random: () => 9 });
    assert.equal(sd.root, 'http://127.0.0.1:7860');
    assert.equal(sd.auth, 'u:p');
    assert.deepEqual([sd.body.prompt, sd.body.negative_prompt, sd.body.width, sd.body.height, sd.body.steps, sd.body.sampler_name, sd.body.seed], ['cat', 'bad', 512, 768, 30, 'DPM++ 2M', 9]);
    assert.equal(sd.body.override_settings.sd_model_checkpoint, 'anything-v5');
    assert.equal(sd.body.frames, undefined);
    assert.throws(() => buildSelfHostedPlan('video', { provider: 'sdwebui' }, 'x'), /只能生图/);
    const comfy = buildSelfHostedPlan('image', { provider: 'comfyui', workflow: WORKFLOW, size: '1024x1024' }, 'dog', { random: () => 5 });
    assert.equal(comfy.root, 'http://127.0.0.1:8188');
    assert.equal(comfy.workflow[6].inputs.text, 'masterpiece, dog');
    assert.throws(() => buildSelfHostedPlan('image', { provider: 'comfyui', workflow: '' }, 'dog'), /JSON/);
    assert.throws(() => serviceRoot('http://u:p@127.0.0.1:8188', 'comfyui'), /账号密码/);
    assert.throws(() => serviceRoot('ftp://127.0.0.1', 'comfyui'));
});

/** 录下请求、按路径给回应的假 fetch。 */
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url, init });
        const handler = routes.find(([pattern]) => (typeof pattern === 'string' ? url === pattern : pattern.test(url)));
        if (!handler) return new Response('not found', { status: 404 });
        return handler[1](url, init, calls);
    };
    fn.calls = calls;
    return fn;
}
const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('经酒馆转发：ComfyUI 发 {url, prompt: 字符串}，带酒馆的 CSRF 头；视频按 format 还原类型', async () => {
    const plan = buildSelfHostedPlan('video', { provider: 'comfyui', workflow: WORKFLOW }, 'dog', { random: () => 5 });
    const fetch = fakeFetch([['/api/sd/comfy/generate', () => json({ format: 'mp4', data: Buffer.from('fakevideo').toString('base64') })]]);
    const result = await runSelfHosted(plan, { viaTavern: true, tavernHeaders: async () => ({ 'X-CSRF-Token': 't', 'Content-Type': 'application/json' }), fetch });
    const sent = JSON.parse(fetch.calls[0].init.body);
    assert.equal(sent.url, 'http://127.0.0.1:8188');
    assert.equal(typeof sent.prompt, 'string');
    assert.equal(JSON.parse(sent.prompt).prompt[6].inputs.text, 'masterpiece, dog');
    assert.equal(fetch.calls[0].init.headers['X-CSRF-Token'], 't');
    assert.equal(result.blob.type, 'video/mp4');
    assert.equal(await result.blob.text(), 'fakevideo');
    const wrong = fakeFetch([['/api/sd/comfy/generate', () => json({ format: 'png', data: PNG.toString('base64') })]]);
    await assert.rejects(runSelfHosted(plan, { viaTavern: true, tavernHeaders: () => ({}), fetch: wrong }), /不是视频/);
});

test('浏览器直连 ComfyUI：/prompt → 轮询 /history → /view；只带 Content-Type；执行错误给出节点信息', async () => {
    const plan = buildSelfHostedPlan('image', { provider: 'comfyui', base: 'http://127.0.0.1:8188', workflow: WORKFLOW }, 'dog', { random: () => 5 });
    let polls = 0;
    const fetch = fakeFetch([
        ['http://127.0.0.1:8188/prompt', () => json({ prompt_id: 'abc', node_errors: {} })],
        [/\/history\/abc$/, () => (++polls < 2 ? json({}) : json({ abc: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'out.png', subfolder: 's', type: 'output' }] } } } }))],
        [/\/view\?/, () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })],
    ]);
    const progress = [];
    const result = await runSelfHosted(plan, { viaTavern: false, fetch, onProgress: (t) => progress.push(t) });
    assert.match(result.url, /^data:image\/png;base64,/);
    assert.deepEqual(Object.keys(fetch.calls[0].init.headers), ['Content-Type']);
    assert.equal(JSON.parse(fetch.calls[0].init.body).prompt[3].inputs.seed, 5);
    assert.ok(fetch.calls.some((c) => c.url === 'http://127.0.0.1:8188/view?filename=out.png&subfolder=s&type=output'));
    assert.ok(progress.some((t) => t.startsWith('生成中')));
    const failing = fakeFetch([
        ['http://127.0.0.1:8188/prompt', () => json({ prompt_id: 'x' })],
        [/\/history\/x$/, () => json({ x: { status: { status_str: 'error', messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]] } } })],
    ]);
    await assert.rejects(runSelfHosted({ ...plan }, { viaTavern: false, fetch: failing }), /KSampler: CUDA out of memory/);
});

test('SD WebUI：经酒馆发 /api/sd/generate（参数+url+auth），直连发 txt2img 并带 Basic 认证', async () => {
    const plan = buildSelfHostedPlan('image', { provider: 'sdwebui', base: 'http://127.0.0.1:7860', auth: '用户:密码', size: '512x512' }, 'cat', { random: () => 1 });
    const viaSt = fakeFetch([['/api/sd/generate', () => json({ images: [PNG.toString('base64')] })]]);
    const a = await runSelfHosted(plan, { viaTavern: true, tavernHeaders: () => ({}), fetch: viaSt });
    const body = JSON.parse(viaSt.calls[0].init.body);
    assert.deepEqual([body.url, body.auth, body.prompt, body.width], ['http://127.0.0.1:7860', '用户:密码', 'cat', 512]);
    assert.match(a.url, /^data:image\/png;base64,iVBORw0KGgo/);
    const direct = fakeFetch([['http://127.0.0.1:7860/sdapi/v1/txt2img', () => json({ images: [PNG.toString('base64')] })]]);
    await runSelfHosted(plan, { viaTavern: false, fetch: direct });
    assert.equal(direct.calls[0].init.headers.Authorization, `Basic ${Buffer.from('用户:密码').toString('base64')}`);
    const empty = fakeFetch([['/api/sd/generate', () => json({ images: [] })]]);
    await assert.rejects(runSelfHosted(plan, { viaTavern: true, tavernHeaders: () => ({}), fetch: empty }), /没有返回图片/);
});

test('Key 可以留空：自建服务和本机/局域网地址；留空时不发空的 Authorization', () => {
    for (const base of ['http://localhost:8080/v1', 'http://127.0.0.1:5000', 'http://192.168.1.20:9000', 'http://10.0.0.5', 'http://172.20.1.1', 'http://nas.local:8000', 'http://[::1]:8000']) assert.ok(isLocalBase(base), base);
    for (const base of ['https://api.openai.com/v1', 'http://172.32.0.1', 'https://192.168.1.1.evil.com', 'nonsense']) assert.ok(!isLocalBase(base), base);
    assert.ok(!needsKey('comfyui', 'https://cloud.example.com') && !needsKey('openai', 'http://127.0.0.1:5000') && needsKey('openai', 'https://api.openai.com'));
    const req = buildRequest('audio', { provider: 'openai', base: 'http://127.0.0.1:9880/v1', key: '', model: 'tts-1', voice: 'x' }, '你好');
    assert.equal(req.headers.Authorization, undefined);
    assert.throws(() => buildRequest('audio', { provider: 'openai', base: 'https://api.openai.com/v1', key: '', model: 'tts-1' }, '你好'), /API Key/);
});

test('视频设置里的 ComfyUI：默认地址、经酒馆转发，工作流不被 4096 字截断', () => {
    const big = JSON.stringify({ 1: { class_type: 'X', inputs: { text: 'a'.repeat(20000) } } });
    const media = readMediaSettings({ video: { provider: 'comfyui', profiles: { comfyui: { workflow: big } } } }, 'video');
    assert.equal(media.provider, 'comfyui');
    assert.equal(media.profiles.comfyui.workflow, big);
    assert.equal(media.profiles.comfyui.base, 'http://127.0.0.1:8188');
    assert.equal(media.profiles.comfyui.direct, '');
});

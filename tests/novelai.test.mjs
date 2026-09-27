import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { buildNovelAIRequest, generateNovelAI, novelAIError, readNovelAIImage, unzipFirstImage } from '../src/api/novelai.js';
import { profileGroup, switchImageProvider } from '../src/core/image-profiles.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

/** 手搓一个只有一个文件的 zip（和 NovelAI 返回的结构一样：本地头 + 数据 + 中央目录 + 结尾记录）。 */
function zip(name, content, method) {
    const data = method === 8 ? deflateRawSync(content) : content;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 42);
    const centralOffset = local.length + nameBytes.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(centralOffset, 16);
    return new Uint8Array(Buffer.concat([local, nameBytes, data, central, nameBytes, end]));
}

test('NovelAI 请求：V4.5 格式，画师串拼好的提示词进 input 和 v4_prompt，负面两处都给，额外参数能覆盖', () => {
    const req = buildNovelAIRequest({ key: ' pst-abc ', model: '', size: '1216x832', extra: { steps: 23, qualityToggle: false } }, '1girl, smile', 'lowres', { random: () => 42 });
    assert.equal(req.url, 'https://image.novelai.net/ai/generate-image');
    assert.equal(req.headers.Authorization, 'Bearer pst-abc');
    assert.equal(req.body.model, 'nai-diffusion-4-5-full');
    assert.equal(req.body.input, '1girl, smile');
    const p = req.body.parameters;
    assert.deepEqual([p.width, p.height, p.steps, p.scale, p.qualityToggle, p.seed, p.n_samples], [1216, 832, 23, 5, false, 42, 1]);
    assert.equal(p.v4_prompt.caption.base_caption, '1girl, smile');
    assert.deepEqual([p.negative_prompt, p.v4_negative_prompt.caption.base_caption], ['lowres', 'lowres']);
    // 反代地址、写全了路径的地址都认；种子 >0 时用给的
    assert.equal(buildNovelAIRequest({ key: 'k', base: 'https://nai.example.com/' }, 'x').url, 'https://nai.example.com/ai/generate-image');
    assert.equal(buildNovelAIRequest({ key: 'k', base: 'https://nai.example.com/ai/generate-image' }, 'x').url, 'https://nai.example.com/ai/generate-image');
    assert.equal(buildNovelAIRequest({ key: 'k', extra: { seed: 7 } }, 'x').body.parameters.seed, 7);
    assert.throws(() => buildNovelAIRequest({ key: '' }, 'x'), /令牌/);
    assert.throws(() => buildNovelAIRequest({ key: 'k', base: 'https://u:p@x.com' }, 'x'), /账号密码/);
});

test('NovelAI 返回：zip（不压缩 / deflate）、直接图片、反代的 JSON 都能取出图片', async () => {
    for (const method of [0, 8]) {
        const blob = await unzipFirstImage(zip('image_0.png', PNG, method));
        assert.equal(blob.type, 'image/png');
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), PNG, `method ${method}`);
    }
    const fromZip = await readNovelAIImage(new Response(zip('image_0.png', PNG, 8)));
    assert.equal(fromZip.type, 'image/png');
    const raw = await readNovelAIImage(new Response(PNG));
    assert.equal(raw.type, 'image/png');
    const json = await readNovelAIImage(new Response(JSON.stringify({ images: [PNG.toString('base64')] })));
    assert.deepEqual(Buffer.from(await json.arrayBuffer()), PNG);
    assert.equal(await readNovelAIImage(new Response(JSON.stringify({ url: 'https://cdn.example.com/a.png' }))), 'https://cdn.example.com/a.png');
    await assert.rejects(readNovelAIImage(new Response('oops')), /既不是图片/);
});

test('NovelAI 报错：401/402/429 说人话，其它带上原始信息', async () => {
    assert.match((await novelAIError(new Response('{"statusCode":401,"message":"Invalid token"}', { status: 401 }))).message, /pst-.*Invalid token/);
    assert.match((await novelAIError(new Response('{"message":"no"}', { status: 402 }))).message, /订阅|Anlas/);
    assert.match((await novelAIError(new Response('', { status: 429 }))).message, /同一时间只能生成一张/);
    assert.match((await novelAIError(new Response('{"message":"bad size"}', { status: 400 }))).message, /HTTP 400：bad size/);
});

test('NovelAI 生成：发出的请求和返回的 data URL', async () => {
    let sent;
    const fetch = async (url, init) => { sent = { url, init }; return new Response(zip('image_0.png', PNG, 8), { headers: { 'content-type': 'application/x-zip-compressed' } }); };
    const url = await generateNovelAI({ key: 'pst-x', size: '832x1216', timeout: 5000 }, 'cat', 'dog', { fetch });
    assert.equal(url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(sent.url, 'https://image.novelai.net/ai/generate-image');
    assert.equal(sent.init.timeout, 5000);
    assert.equal(JSON.parse(sent.init.body).parameters.negative_prompt, 'dog');
    const failing = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(generateNovelAI({ key: 'pst-x' }, 'cat', '', { fetch: failing }), /连不上 NovelAI/);
});

test('接口各记各的：中转类共用一组，NovelAI / ComfyUI 等单独一组；第一次切过去用那个接口的默认值', () => {
    assert.deepEqual(['auto', 'openai', 'chat', 'gemini', undefined].map(profileGroup), ['relay', 'relay', 'relay', 'relay', 'relay']);
    const relay = { imageProvider: 'openai', apiBase: 'https://relay/v1', apiKey: 'sk-1', model: 'gpt-image-2', imageParams: '', size: '1024x1536', quality: 'high' };
    // 同组：只换协议，地址和 Key 不动
    assert.deepEqual(switchImageProvider(relay, 'gemini'), { ...relay, imageProvider: 'gemini' });
    const nai = switchImageProvider(relay, 'novelai');
    assert.deepEqual([nai.apiBase, nai.apiKey, nai.model, nai.size, nai.quality], ['https://image.novelai.net', '', 'nai-diffusion-4-5-full', '832x1216', 'high']);
    assert.equal(nai.imageProfiles.relay.apiKey, 'sk-1');
    const naiEdited = { ...nai, apiKey: 'pst-9', size: '1216x832' };
    const back = switchImageProvider(naiEdited, 'chat');
    assert.deepEqual([back.imageProvider, back.apiBase, back.apiKey, back.size], ['chat', 'https://relay/v1', 'sk-1', '1024x1536']);
    const again = switchImageProvider(back, 'novelai');
    assert.deepEqual([again.apiKey, again.size], ['pst-9', '1216x832']);
    const comfy = switchImageProvider(again, 'comfyui');
    assert.deepEqual([comfy.apiBase, comfy.apiKey], ['http://127.0.0.1:8188', '']);
    assert.equal(comfy.imageProfiles.novelai.apiKey, 'pst-9');
});

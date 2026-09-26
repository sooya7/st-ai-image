import assert from 'node:assert/strict';
import test from 'node:test';
import { extractImage, extractImageFromChatResponse, extractImageFromResponse, normalizeApiBase } from '../src/api/images.js';
import { mergeHistoryItems, normalizeHistoryEntry } from '../src/gallery/db.js';

test('normalizeApiBase 去掉尾斜杠与 /v1', () => {
    assert.equal(normalizeApiBase('https://a.com/v1/'), 'https://a.com');
    assert.equal(normalizeApiBase('https://a.com//'), 'https://a.com');
    assert.equal(normalizeApiBase(' https://a.com/v1 '), 'https://a.com');
    assert.equal(normalizeApiBase(''), '');
});

test('extractImageFromResponse 覆盖各种中转格式', () => {
    assert.equal(extractImageFromResponse({ data: [{ url: 'https://e.com/a.png' }] }), 'https://e.com/a.png');
    assert.equal(extractImageFromResponse({ data: [{ b64_json: 'AAA' }] }), 'data:image/png;base64,AAA');
    assert.equal(extractImageFromResponse([{ url: 'https://e.com/b.png' }]), 'https://e.com/b.png');
    assert.equal(extractImageFromResponse({ images: [{ url: 'https://e.com/c.png' }] }), 'https://e.com/c.png');
    assert.equal(extractImageFromResponse({ url: 'https://e.com/d.png' }), 'https://e.com/d.png');
    assert.equal(extractImageFromResponse({ b64_json: 'BBB' }), 'data:image/png;base64,BBB');
    assert.equal(extractImageFromResponse({ result: 'https://e.com/e.png' }), 'https://e.com/e.png');
    assert.equal(extractImageFromResponse({ output: [{ url: 'https://e.com/f.png' }] }), 'https://e.com/f.png');
    assert.equal(extractImageFromResponse({ data: ['https://e.com/g.png'] }), 'https://e.com/g.png');
    assert.equal(
        extractImageFromResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'CCC' } }] } }] }),
        'data:image/webp;base64,CCC',
    );
    assert.equal(extractImageFromResponse({ data: [] }), null);
    assert.equal(extractImageFromResponse(null), null);
});

test('extractImageFromChatResponse 覆盖 chat 端点各种形状', () => {
    const chat = (message) => ({ choices: [{ message }] });
    assert.equal(extractImageFromChatResponse(chat({ images: [{ url: 'https://e.com/a.png' }] })), 'https://e.com/a.png');
    assert.equal(extractImageFromChatResponse(chat({ content: '看图 ![x](data:image/png;base64,AAA)' })), 'data:image/png;base64,AAA');
    assert.equal(extractImageFromChatResponse(chat({ content: 'data:image/png;base64,BBB' })), 'data:image/png;base64,BBB');
    assert.equal(extractImageFromChatResponse(chat({ content: '见 https://e.com/x.jpg 谢谢' })), 'https://e.com/x.jpg');
    assert.equal(extractImageFromChatResponse(chat({ content: [{ type: 'image_url', image_url: { url: 'https://e.com/y.png' } }] })), 'https://e.com/y.png');
    assert.equal(
        extractImageFromChatResponse(chat({ content: [{ type: 'image', source: { media_type: 'image/jpeg', data: 'DDD' } }] })),
        'data:image/jpeg;base64,DDD',
    );
    assert.equal(extractImageFromChatResponse(chat({ content: '没有图片' })), null);
});

test('extractImage 两条路径都试', () => {
    assert.equal(extractImage({ choices: [{ message: { content: 'data:image/png;base64,EEE' } }] }), 'data:image/png;base64,EEE');
    assert.equal(extractImage({ data: [{ url: 'https://e.com/z.png' }] }), 'https://e.com/z.png');
});

test('normalizeHistoryEntry 过滤非法地址并补默认值', () => {
    const entry = normalizeHistoryEntry({ prompt: 'p', imageUrl: 'javascript:alert(1)' });
    assert.equal(entry.imageUrl, '');
    assert.equal(entry.prompt, 'p');
    assert.equal(typeof entry.timestamp, 'number');
    assert.equal('id' in normalizeHistoryEntry({ imageUrl: 'https://e.com/a.png' }), false);
    assert.equal(normalizeHistoryEntry({ imageUrl: 'https://e.com/a.png' }, 7).id, 7);
});

test('mergeHistoryItems 按时间倒序去重且丢掉坏记录', () => {
    const merged = mergeHistoryItems([
        { id: 1, imageUrl: 'https://e.com/a.png', timestamp: 100 },
        { id: 2, imageUrl: 'https://e.com/a.png', timestamp: 300 },
        { id: 3, imageUrl: 'https://e.com/b.png', timestamp: 200 },
        { id: 4, imageUrl: 'javascript:alert(1)', timestamp: 400 },
        null,
    ]);
    assert.deepEqual(merged.map((item) => item.id), [2, 3]);
    assert.deepEqual(mergeHistoryItems(null), []);
});

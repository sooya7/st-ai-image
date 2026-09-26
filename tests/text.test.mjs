import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildPromptFromFloorText, createInlineImageMarker, createMarkdownImageMarkup,
    escapeHtml, extractMarkdownImages, hasImageTag, hasInlineImageMarker,
    isValidApiBaseUrl, normalizeGalleryImageUrl, parseDataImageUrl, parseInlineImageMarker,
    replaceFirstImageRequest, replaceInlineImageMarkersWithMarkdown, sanitizeImageUrl,
    shouldProcessInlineText, stripGeneratedImageArtifacts, summarizeApiError,
} from '../src/core/text.js';

test('escapeHtml 转义全部危险字符', () => {
    assert.equal(escapeHtml('<img alt="x">'), '&lt;img alt=&quot;x&quot;&gt;');
    assert.equal(escapeHtml("'&'"), '&#39;&amp;&#39;');
});

test('sanitizeImageUrl 只放过 data:image / blob: / http(s)', () => {
    assert.equal(sanitizeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
    assert.equal(sanitizeImageUrl('http://example.com/a.png'), 'http://example.com/a.png');
    assert.equal(sanitizeImageUrl('data:image/png;base64,abc'), 'data:image/png;base64,abc');
    assert.equal(sanitizeImageUrl('blob:https://example.com/id'), 'blob:https://example.com/id');
    assert.equal(sanitizeImageUrl('javascript:alert(1)'), '');
    assert.equal(sanitizeImageUrl('data:text/html;base64,abc'), '');
    assert.equal(sanitizeImageUrl('  '), '');
    assert.equal(sanitizeImageUrl(null), '');
});

test('summarizeApiError 压缩空白并截断', () => {
    assert.ok(summarizeApiError('x'.repeat(900)).length <= 360);
    assert.equal(summarizeApiError(' a \n b '), 'a b');
});

test('isValidApiBaseUrl 允许空值但拒绝非 http 协议', () => {
    assert.equal(isValidApiBaseUrl(''), true);
    assert.equal(isValidApiBaseUrl('https://a.com/v1'), true);
    assert.equal(isValidApiBaseUrl('a.com/v1'), false);
});

test('hasImageTag 支持中英文标签并要求闭合', () => {
    assert.equal(hasImageTag('[image]test[/image]'), true);
    assert.equal(hasImageTag('<image>test</image>'), true);
    assert.equal(hasImageTag('[图片]test[/图片]'), true);
    assert.equal(hasImageTag('[生图]test[/生图]'), true);
    assert.equal(hasImageTag('[image]unclosed'), false);
    assert.equal(hasImageTag('[image]a[/图片]'), false, '开闭标签必须同名');
    assert.equal(hasImageTag('no tag here'), false);
});

test('hasImageTag 连续调用结果稳定（正则不共享 lastIndex）', () => {
    const text = '[image]a[/image]';
    assert.equal(hasImageTag(text), true);
    assert.equal(hasImageTag(text), true);
    assert.equal(hasImageTag(text), true);
});

test('内联标记的生成与解析', () => {
    assert.equal(createInlineImageMarker('abc123'), '[st-ai-image id="abc123"]');
    assert.equal(createInlineImageMarker('a b<>'), '[st-ai-image id="ab"]', '非法字符被剥掉');
    assert.equal(createInlineImageMarker(''), '');
    assert.equal(createInlineImageMarker({ id: 'xyz', imageUrl: 'https://e.com/a.png' }), '[st-ai-image id="xyz"]');
    assert.equal(
        createInlineImageMarker({ id: '', imageUrl: 'https://e.com/a.png', prompt: 'p' }),
        '![p](https://e.com/a.png)',
        '没有 id 时退化成 markdown',
    );
    assert.equal(createInlineImageMarker({ id: '', imageUrl: 'javascript:alert(1)' }), '');

    assert.deepEqual(parseInlineImageMarker('[st-ai-image id="abc"]'), { id: 'abc', imageUrl: '' });
    assert.deepEqual(parseInlineImageMarker('[st-ai-image src="https://e.com/a.png"]'), { id: '', imageUrl: 'https://e.com/a.png' });
    assert.deepEqual(parseInlineImageMarker('[st-ai-image src="javascript:alert(1)"]'), { id: '', imageUrl: '' });
    assert.equal(hasInlineImageMarker('text [st-ai-image id="a"] end'), true);
    assert.equal(hasInlineImageMarker('no marker'), false);
});

test('replaceInlineImageMarkersWithMarkdown 只迁移带 src 的旧标记', () => {
    assert.equal(replaceInlineImageMarkersWithMarkdown('[st-ai-image src="https://e.com/a.png"]'), '![AI Image](https://e.com/a.png)');
    assert.equal(replaceInlineImageMarkersWithMarkdown('[st-ai-image id="a"]'), '[st-ai-image id="a"]');
});

test('markdown 图片的写入与解析可往返', () => {
    const markup = createMarkdownImageMarkup('https://e.com/a b.png', '一个]提示词');
    assert.deepEqual(extractMarkdownImages(markup), [{ prompt: '一个]提示词', imageUrl: 'https://e.com/a b.png' }]);
    assert.deepEqual(extractMarkdownImages('no image'), []);
    assert.equal(extractMarkdownImages('![](javascript:alert(1))').length, 0);
});

test('replaceFirstImageRequest 用标记替换第一个标签', () => {
    const out = replaceFirstImageRequest('hello [image]p[/image] world', '', 'abc');
    assert.equal(out, 'hello [st-ai-image id="abc"] world');
    assert.equal(
        replaceFirstImageRequest('a [image]x[/image] b [image]y[/image]', '[image]y[/image]', 'id2'),
        'a [image]x[/image] b [st-ai-image id="id2"]',
        '给了原标签时优先精确替换',
    );
    assert.equal(replaceFirstImageRequest('no tag', '', ''), 'no tag', '标记为空时不改动');
});

test('normalizeGalleryImageUrl 把酒馆图库地址归一成相对路径', () => {
    assert.equal(normalizeGalleryImageUrl('https://host.tld/user/images/a/b.png'), '/user/images/a/b.png');
    assert.equal(normalizeGalleryImageUrl('https://e.com/img.png'), 'https://e.com/img.png');
    assert.equal(normalizeGalleryImageUrl(''), '');
});

test('parseDataImageUrl 提取格式并拒绝非图片', () => {
    assert.deepEqual(parseDataImageUrl('data:image/jpeg;base64,QUJD'), { format: 'jpg', base64: 'QUJD' });
    assert.equal(parseDataImageUrl('data:text/html;base64,QUJD'), null);
});

test('shouldProcessInlineText 遵守开关，但已生成的图始终渲染', () => {
    const on = { enabled: true, autoDetect: true };
    assert.equal(shouldProcessInlineText('[image]t[/image]', on), true);
    assert.equal(shouldProcessInlineText('[image]t[/image]', { enabled: false, autoDetect: true }), false);
    assert.equal(shouldProcessInlineText('[image]t[/image]', { enabled: true, autoDetect: false }), false);
    assert.equal(shouldProcessInlineText('[st-ai-image id="a"]', { enabled: false, autoDetect: false }), true);
    assert.equal(shouldProcessInlineText('no tag', on), false);
});

test('楼层提示词剥掉标签/标记/图片后保留文字', () => {
    const text = '她笑了 [image]a girl[/image] [st-ai-image id="1"] ![alt](https://e.com/a.png)';
    assert.equal(stripGeneratedImageArtifacts(text), '她笑了 a girl alt');
    assert.equal(buildPromptFromFloorText('x'.repeat(2000)).length, 1203, '超长按 1200 截断并加省略号');
});

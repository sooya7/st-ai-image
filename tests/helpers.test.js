const assert = require('assert');
const helpers = require('../index.js').__stAiImageTest__;

// escapeHtml / escapeAttr
assert.strictEqual(helpers.escapeHtml('<img alt="x">'), '&lt;img alt=&quot;x&quot;&gt;');
assert.strictEqual(helpers.escapeAttr('"a&b<'), '&quot;a&amp;b&lt;');

// sanitizeImageUrl
assert.strictEqual(helpers.sanitizeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
assert.strictEqual(helpers.sanitizeImageUrl('http://example.com/a.png'), 'http://example.com/a.png');
assert.strictEqual(helpers.sanitizeImageUrl('data:image/png;base64,abc'), 'data:image/png;base64,abc');
assert.strictEqual(helpers.sanitizeImageUrl('blob:https://example.com/id'), 'blob:https://example.com/id');
assert.strictEqual(helpers.sanitizeImageUrl('javascript:alert(1)'), '');
assert.strictEqual(helpers.sanitizeImageUrl('data:text/html;base64,abc'), '');
assert.strictEqual(helpers.sanitizeImageUrl(''), '');
assert.strictEqual(helpers.sanitizeImageUrl('   '), '');

// summarizeApiError
assert.strictEqual(helpers.summarizeApiError('x'.repeat(900)).length <= 360, true);
assert.strictEqual(helpers.summarizeApiError('short error'), 'short error');

// hasImageTag
assert.strictEqual(helpers.hasImageTag('[image]test[/image]'), true);
assert.strictEqual(helpers.hasImageTag('<image>test</image>'), true);
assert.strictEqual(helpers.hasImageTag('[图片]test[/图片]'), true);
assert.strictEqual(helpers.hasImageTag('no tag here'), false);
assert.strictEqual(helpers.hasImageTag('[image]unclosed'), false);

// hasInlineImageMarker
assert.strictEqual(helpers.hasInlineImageMarker('some text [st-ai-image id="abc"] end'), true);
assert.strictEqual(helpers.hasInlineImageMarker('no marker'), false);

// createInlineImageMarker
assert.strictEqual(helpers.createInlineImageMarker('abc123'), '[st-ai-image id="abc123"]');
assert.strictEqual(helpers.createInlineImageMarker(''), '');
assert.strictEqual(helpers.createInlineImageMarker({ id: 'xyz', imageUrl: 'https://example.com/img.png' }), '[st-ai-image id="xyz"]');

// parseInlineImageMarker
assert.deepStrictEqual(helpers.parseInlineImageMarker('[st-ai-image id="abc"]'), { id: 'abc', imageUrl: '' });
assert.deepStrictEqual(helpers.parseInlineImageMarker('[st-ai-image src="https://ex.com/a.png"]'), { id: '', imageUrl: 'https://ex.com/a.png' });

// extractMarkdownImages
assert.deepStrictEqual(helpers.extractMarkdownImages('![alt](https://ex.com/img.png)'), [{ prompt: 'alt', imageUrl: 'https://ex.com/img.png' }]);
assert.deepStrictEqual(helpers.extractMarkdownImages('no image'), []);
assert.strictEqual(helpers.extractMarkdownImages('![](javascript:alert(1))').length, 0);

// replaceFirstImageRequest
const result = helpers.replaceFirstImageRequest('hello [image]prompt[/image] world', '', 'abc');
assert.ok(result.includes('[st-ai-image id="abc"]'));
assert.ok(!result.includes('[image]'));

// normalizeGalleryImageUrl
assert.ok(helpers.normalizeGalleryImageUrl('https://example.com/img.png').includes('example.com'));
assert.strictEqual(helpers.normalizeGalleryImageUrl(''), '');

// shouldProcessInlineText
assert.strictEqual(helpers.shouldProcessInlineText('[image]test[/image]', { enabled: true, autoDetect: true }), true);
assert.strictEqual(helpers.shouldProcessInlineText('[image]test[/image]', { enabled: false, autoDetect: true }), false);
assert.strictEqual(helpers.shouldProcessInlineText('no tag', { enabled: true, autoDetect: true }), false);

console.log('All helpers.test.js passed');

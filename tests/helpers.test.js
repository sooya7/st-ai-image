const assert = require('assert');

const helpers = require('../index.js').__stAiImageTest__;

assert.strictEqual(helpers.escapeHtml('<img alt="x">'), '&lt;img alt=&quot;x&quot;&gt;');
assert.strictEqual(helpers.escapeAttr('"a&b<'), '&quot;a&amp;b&lt;');

assert.strictEqual(helpers.sanitizeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
assert.strictEqual(helpers.sanitizeImageUrl('http://example.com/a.png'), 'http://example.com/a.png');
assert.strictEqual(helpers.sanitizeImageUrl('data:image/png;base64,abc'), 'data:image/png;base64,abc');
assert.strictEqual(helpers.sanitizeImageUrl('blob:https://example.com/id'), 'blob:https://example.com/id');
assert.strictEqual(helpers.sanitizeImageUrl('javascript:alert(1)'), '');
assert.strictEqual(helpers.sanitizeImageUrl('data:text/html;base64,abc'), '');

assert.strictEqual(
    helpers.summarizeApiError('x'.repeat(900)).length <= 360,
    true,
    'long API errors are summarized',
);

assert.ok(
    helpers.buildImageActionsHtml('result', 'p"rompt', 'https://example.com/a.png').includes('data-action="download-image"'),
    'result actions include download image',
);
assert.ok(
    helpers.buildImageActionsHtml('result', 'prompt', 'https://example.com/a.png').includes('data-action="save-image"'),
    'result actions include save to gallery',
);
assert.ok(
    !helpers.buildImageActionsHtml('result', 'prompt', 'javascript:alert(1)').includes('javascript:'),
    'unsafe image URLs are not rendered',
);
assert.ok(
    !helpers.buildImageActionsHtml('result', 'prompt', 'https://example.com/a.png').includes('copy-prompt'),
    'prompt copy action is not rendered',
);
assert.ok(
    !helpers.buildImageActionsHtml('result', 'prompt', 'https://example.com/a.png').includes('reuse-prompt'),
    'prompt reuse action is not rendered',
);

assert.strictEqual(helpers.hasImageTag('abc [image]提示[/image] def'), true);
assert.strictEqual(helpers.hasImageTag('abc def'), false);

assert.strictEqual(helpers.createInlineImageMarker(42), '[st-ai-image id="42"]');
assert.strictEqual(
    helpers.createInlineImageMarker({ imageUrl: 'user/images/AI Image Generator/a.png' }),
    '[st-ai-image src="user%2Fimages%2FAI%20Image%20Generator%2Fa.png"]',
);
assert.strictEqual(
    helpers.createInlineImageMarker({ id: 7, imageUrl: 'user/images/AI Image Generator/a.png' }),
    '[st-ai-image id="7" src="user%2Fimages%2FAI%20Image%20Generator%2Fa.png"]',
);
assert.strictEqual(helpers.hasInlineImageMarker('abc [st-ai-image id="42"] def'), true);
assert.strictEqual(helpers.hasInlineImageMarker('abc [st-ai-image src="user%2Fimages%2Fa.png"] def'), true);
const encodedServerMarker = '[st-ai-image src="%2Fuser%2Fimages%2FAI%20Image%20Generator%2Fst-ai-image-1780885283397.png"]';
assert.strictEqual(helpers.hasInlineImageMarker(`abc ${encodedServerMarker} def`), true);
assert.deepStrictEqual(
    helpers.parseInlineImageMarker('[st-ai-image src="user%2Fimages%2Fa.png"]'),
    { id: '', imageUrl: 'user/images/a.png' },
);
assert.deepStrictEqual(
    helpers.parseInlineImageMarker(encodedServerMarker),
    { id: '', imageUrl: '/user/images/AI Image Generator/st-ai-image-1780885283397.png' },
);
assert.deepStrictEqual(
    helpers.parseInlineImageMarker('[st-ai-image id="7" src="%2Fuser%2Fimages%2FAI%20Image%20Generator%2Fst-ai-image-1780885283397.png"]'),
    { id: '7', imageUrl: '/user/images/AI Image Generator/st-ai-image-1780885283397.png' },
);
assert.strictEqual(
    helpers.shouldProcessInlineText('abc [st-ai-image id="42"] def', { enabled: true, autoDetect: false }),
    true,
);
assert.strictEqual(
    helpers.shouldProcessInlineText(encodedServerMarker, { enabled: false, autoDetect: false }),
    true,
);
assert.strictEqual(
    helpers.shouldProcessInlineText('abc [image]prompt[/image] def', { enabled: true, autoDetect: false }),
    true,
);
assert.strictEqual(
    helpers.shouldProcessInlineText('abc [image]prompt[/image] def', { enabled: false, autoDetect: true }),
    false,
);
assert.strictEqual(
    helpers.shouldProcessInlineText('abc [image]prompt[/image] def', { enabled: true, autoDetect: true }),
    true,
);
assert.strictEqual(
    helpers.replaceFirstImageRequest('abc [image]prompt[/image] def', '[image]prompt[/image]', { imageUrl: 'user/images/a.png' }),
    'abc [st-ai-image src="user%2Fimages%2Fa.png"] def',
);
assert.strictEqual(
    helpers.replaceFirstImageRequest('abc [image]prompt[/image] def', '[image]missing[/image]', 7),
    'abc [st-ai-image id="7"] def',
);

console.log('helpers.test.js passed');

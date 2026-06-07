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

console.log('helpers.test.js passed');

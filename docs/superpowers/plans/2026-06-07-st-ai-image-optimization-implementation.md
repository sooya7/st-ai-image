# st-ai-image Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve `st-ai-image` stability, safety, UI polish, and lightweight generation/gallery workflow actions while preserving the existing SillyTavern extension loading model.

**Architecture:** Keep the extension as a single browser entry file plus static HTML/CSS. Add small pure helper functions at the top of `index.js`, expose only those helpers for Node-based tests through a guarded `module.exports`, and leave SillyTavern initialization behind a browser/jQuery guard. Use delegated events for dynamic UI actions.

**Tech Stack:** Plain JavaScript, jQuery in SillyTavern, HTML, CSS, IndexedDB, Node.js built-in `assert` for lightweight tests.

---

## File Structure

- Modify: `index.js`
  - Add escape, URL, error-summary, copy/download, prompt-template, and safe-render helpers.
  - Fix auto-detection processing and preview event binding.
  - Add delegated handlers for generated result and gallery actions.
  - Guard browser initialization so Node tests can require the file.
- Modify: `settings.html`
  - Add prompt template select and accessible button attributes.
  - Replace layout inline styles with CSS classes.
- Modify: `style.css`
  - Add CSS classes for inline rows, action bars, error states, prompt templates, accessible focus, and mobile/touch refinements.
- Create: `tests/helpers.test.js`
  - Test pure helpers without a SillyTavern runtime.
- Modify: `docs/superpowers/plans/2026-06-07-st-ai-image-optimization-implementation.md`
  - Track this implementation plan.

## Task 1: Helper Tests And Browser Guard

**Files:**
- Create: `tests/helpers.test.js`
- Modify: `index.js`

- [ ] **Step 1: Write the failing helper test**

Create `tests/helpers.test.js` with:

```javascript
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

assert.strictEqual(
    helpers.applyPromptTemplate('', 'character'),
    '单人角色立绘，清晰五官，完整服装设计，自然站姿，纯色或简洁背景，masterpiece, best quality, highly detailed',
);
assert.strictEqual(
    helpers.applyPromptTemplate('已有提示', 'scene'),
    '已有提示，场景氛围，明确地点，光影层次，环境细节，情绪氛围，masterpiece, best quality, highly detailed',
);

console.log('helpers.test.js passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/helpers.test.js`

Expected: FAIL because `index.js` does not export `__stAiImageTest__` and helper functions do not exist yet.

- [ ] **Step 3: Implement minimal helper exports and browser guard**

In `index.js`, add:

```javascript
function escapeHtml(value) {
    const text = String(value ?? '');
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML.replace(/"/g, '&quot;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
}

function sanitizeImageUrl(value) {
    const url = String(value ?? '').trim();
    if (!url) return '';
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
    if (/^blob:/i.test(url)) return url;
    try {
        const parsed = new URL(url, window.location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    } catch {}
    return '';
}

function summarizeApiError(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 340 ? `${text.slice(0, 340)}...` : text;
}

const PROMPT_TEMPLATES = {
    character: '单人角色立绘，清晰五官，完整服装设计，自然站姿，纯色或简洁背景，masterpiece, best quality, highly detailed',
    scene: '场景氛围，明确地点，光影层次，环境细节，情绪氛围，masterpiece, best quality, highly detailed',
    cg: '剧情CG插画，人物互动，电影感构图，细腻表情，丰富背景，masterpiece, best quality, highly detailed',
    item: '道具特写，主体居中，材质细节，干净背景，柔和布光，masterpiece, best quality, highly detailed',
};

function applyPromptTemplate(currentPrompt, templateKey) {
    const template = PROMPT_TEMPLATES[templateKey] || '';
    const current = String(currentPrompt ?? '').trim();
    if (!template) return current;
    return current ? `${current}，${template}` : template;
}
```

Wrap the current `jQuery(async () => { ... })` initializer in:

```javascript
if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof jQuery === 'function') {
    jQuery(async () => {
        // existing init body
    });
}
```

Add a guarded export:

```javascript
if (typeof module !== 'undefined') {
    module.exports = {
        __stAiImageTest__: {
            escapeHtml,
            escapeAttr,
            sanitizeImageUrl,
            summarizeApiError,
            applyPromptTemplate,
            PROMPT_TEMPLATES,
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/helpers.test.js`

Expected: PASS and output `helpers.test.js passed`.

- [ ] **Step 5: Run syntax check**

Run: `node --check index.js`

Expected: exit 0.

## Task 2: Safe Rendering And Actions

**Files:**
- Modify: `index.js`
- Test: `tests/helpers.test.js`

- [ ] **Step 1: Add failing behavior checks**

Extend `tests/helpers.test.js` with checks for action HTML helper behavior after adding a helper named `buildImageActionsHtml`:

```javascript
assert.ok(
    helpers.buildImageActionsHtml('result', 'p"rompt', 'https://example.com/a.png').includes('data-action="copy-prompt"'),
    'result actions include copy prompt',
);
assert.ok(
    !helpers.buildImageActionsHtml('result', 'prompt', 'javascript:alert(1)').includes('javascript:'),
    'unsafe image URLs are not rendered',
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/helpers.test.js`

Expected: FAIL because `buildImageActionsHtml` is not exported yet.

- [ ] **Step 3: Implement safe dynamic rendering**

Add `buildImageActionsHtml(context, prompt, imageUrl)` to `index.js` and export it. It should return buttons with `data-action` values:

```javascript
function buildImageActionsHtml(context, prompt, imageUrl) {
    const safePrompt = escapeAttr(prompt);
    const safeUrl = escapeAttr(sanitizeImageUrl(imageUrl));
    const disabled = safeUrl ? '' : ' disabled';
    return `
        <button type="button" class="st_gpt_image_btn" data-action="download-image" data-context="${escapeAttr(context)}" data-url="${safeUrl}" title="下载图片" aria-label="下载图片"${disabled}><i class="fa-solid fa-download"></i></button>
        <button type="button" class="st_gpt_image_btn" data-action="copy-prompt" data-prompt="${safePrompt}" title="复制提示词" aria-label="复制提示词"><i class="fa-solid fa-copy"></i></button>
        <button type="button" class="st_gpt_image_btn" data-action="reuse-prompt" data-prompt="${safePrompt}" title="复用提示词" aria-label="复用提示词"><i class="fa-solid fa-pen-to-square"></i></button>
    `;
}
```

Update generated result, preview, gallery, and inline image rendering to use escaped prompt text and sanitized image URLs. Remove the inline `onclick`.

- [ ] **Step 4: Add delegated action handlers**

Add document handlers for:

- `download-image`: create an `<a>` with safe `href` and `download`.
- `copy-prompt`: use `navigator.clipboard.writeText`, fallback to a temporary textarea.
- `reuse-prompt`: fill `#st_gpt_image_prompt`, switch to generate tab, and focus the textarea.

- [ ] **Step 5: Run tests and syntax check**

Run:

```powershell
node tests/helpers.test.js
node --check index.js
```

Expected: helper test passes and syntax check exits 0.

## Task 3: Auto-Detection And Preview Binding

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Write failing test for image-tag detection helper**

Add to `tests/helpers.test.js`:

```javascript
assert.strictEqual(helpers.hasImageTag('abc [image]提示[/image] def'), true);
assert.strictEqual(helpers.hasImageTag('abc def'), false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/helpers.test.js`

Expected: FAIL because `hasImageTag` is missing.

- [ ] **Step 3: Implement scan helper and processing guard**

Add:

```javascript
function hasImageTag(text) {
    return /\[image\](.+?)\[\/image\]/s.test(String(text ?? ''));
}
```

Export it for tests. Update `scheduleScan()` so it does not delete processed flags. Only process `.mes_text` elements when `hasImageTag(el.textContent)` is true.

- [ ] **Step 4: Fix preview event binding**

In `showPreview`, use `.off('.stAiPreview')` before binding `.on('click.stAiPreview', ...)`. Add a document-level `keydown.stAiPreview` handler that closes the preview on Escape, and remove it when the preview closes.

- [ ] **Step 5: Run tests and syntax check**

Run:

```powershell
node tests/helpers.test.js
node --check index.js
```

Expected: helper test passes and syntax check exits 0.

## Task 4: Settings HTML And CSS Polish

**Files:**
- Modify: `settings.html`
- Modify: `style.css`

- [ ] **Step 1: Update settings HTML**

Add `type="button"` to buttons. Add `title` and `aria-label` to icon-only buttons. Add a prompt template select near the textarea:

```html
<select id="st_gpt_prompt_template" class="st_ai_select st_ai_template_select" title="提示词模板" aria-label="提示词模板">
    <option value="">模板</option>
    <option value="character">角色立绘</option>
    <option value="scene">场景氛围</option>
    <option value="cg">CG插画</option>
    <option value="item">道具特写</option>
</select>
```

Replace inline layout styles with classes:

- `st_ai_inline_row`
- `st_ai_flex_fill`
- `st_ai_model_list`

- [ ] **Step 2: Add CSS classes**

Add styles for the new classes, action bars, error states, focus states, and mobile touch sizing.

- [ ] **Step 3: Bind template selection**

In `index.js`, handle `#st_gpt_prompt_template` change by applying `applyPromptTemplate` to the current textarea value and resetting the select to empty.

- [ ] **Step 4: Verify no layout inline styles remain**

Run: `rg -n "style=" settings.html`

Expected: no output.

- [ ] **Step 5: Run syntax check**

Run: `node --check index.js`

Expected: exit 0.

## Task 5: Final Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run full lightweight verification**

Run:

```powershell
node tests/helpers.test.js
node --check index.js
rg -n "onclick|style=" index.js settings.html
rg -n "aria-label" settings.html index.js
```

Expected:

- Tests pass with `helpers.test.js passed`.
- Syntax check exits 0.
- No `onclick`.
- No layout inline `style=` in `settings.html`.
- `aria-label` appears on icon buttons and generated action buttons.

- [ ] **Step 2: Review git diff**

Run: `git diff -- index.js settings.html style.css tests/helpers.test.js`

Expected: changes match the approved design and no unrelated files are edited.

- [ ] **Step 3: Commit implementation**

Run:

```powershell
git add index.js settings.html style.css tests/helpers.test.js docs/superpowers/plans/2026-06-07-st-ai-image-optimization-implementation.md
git commit -m "feat: optimize image extension safety and UX"
```

Expected: one implementation commit on branch `optimize-plugin-ux-safety`.

## Self-Review

- Spec coverage: stability helpers, safe rendering, event binding, auto-detection, settings cleanup, mobile/UI polish, prompt templates, gallery/result actions, and verification are each covered by tasks.
- Placeholder scan: no TBD/TODO/implement-later placeholders are present.
- Type consistency: helper names used in tests match helper names planned for `index.js` exports.

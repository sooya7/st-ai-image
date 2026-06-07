# st-ai-image Optimization Design

Date: 2026-06-07
Project: SillyTavern third-party extension `st-ai-image`

## Goal

Upgrade the existing AI image extension across three tracks: stability and safety, interface polish, and small practical feature additions. The work should keep the extension simple to install in SillyTavern: no build system, no new runtime dependency, and no change to the current `manifest.json` loading model.

## Current Context

The plugin is a small browser extension made of `index.js`, `settings.html`, `style.css`, and prompt/world-info resources. It loads a settings panel into SillyTavern, supports OpenAI-compatible image APIs and Gemini image responses, stores generation history in IndexedDB, and replaces `[image]...[/image]` tags inside chat messages with inline generation buttons.

The current code already works, but it has several reliability and maintainability risks:

- Dynamic HTML uses template strings in many places and needs consistent attribute and URL escaping.
- Preview controls bind click handlers every time the preview opens.
- Auto-detection rescans and reprocesses chat messages more often than necessary.
- Some UI states use mismatched class names or inline styles.
- Icon-only buttons are missing accessible names.
- The gallery has useful data but few direct actions beyond regenerate and delete.

## Recommended Approach

Use a conservative in-place upgrade. Keep the current file layout and SillyTavern integration, but tighten the internal helpers and UI behavior.

This is preferred over a module split because SillyTavern third-party extensions are easier to install and debug when the extension remains a single JavaScript entry point. It is also preferred over a large feature redesign because the current plugin first needs a steadier foundation.

## Stability And Safety

Add small shared helpers in `index.js`:

- `escapeAttr(value)` for HTML attribute values.
- `isSafeImageUrl(value)` / `sanitizeImageUrl(value)` for generated image URLs. Allow `https:`, `http:`, `data:image/...`, and local blob URLs if needed by the browser; reject or omit unsafe schemes.
- `summarizeApiError(text)` to keep API error feedback readable and avoid dumping huge responses into the panel.
- `setButtonLoading(button, loading, html)` or equivalent tiny helpers for repeated async button states.

Replace inline event handlers and risky string insertion:

- Remove the generated-result `onclick` download trigger.
- Bind download/copy/reuse actions through delegated events.
- Escape prompt text everywhere it is rendered into HTML or attributes.
- Use sanitized image URLs for `src` and download links.

Fix preview event binding:

- Render preview content fresh, but bind close/download/backdrop actions with namespaced or delegated handlers so repeated openings do not accumulate handlers.
- Add Escape support for the image preview overlay only.

Improve auto-detection:

- Do not clear `data-stGptProcessed` on every scan.
- Mark processed message elements and only revisit them when their text content still contains raw `[image]...[/image]` tags.
- Keep MutationObserver debounce, but reduce needless full-message work.
- Avoid verbose console logging during normal scans; keep errors and one init log.

History and IndexedDB behavior:

- Keep the 200-item limit.
- Await history save where needed before gallery refresh when that improves consistency.
- Make failures non-fatal but visible in console.

## Interface And Interaction

Move settings layout styles out of `settings.html` and into `style.css`:

- Replace inline flex rows with classes such as `st_ai_inline_row`, `st_ai_flex_fill`, and `st_ai_model_list`.
- Replace inline preview header layout with a CSS class.
- Replace inline error color with an error-state class.

Accessibility and touch polish:

- Add `type="button"` to all buttons.
- Add `aria-label` and `title` for icon-only buttons.
- Keep mobile touch targets comfortable, aiming for at least 40-44 px where the SillyTavern panel density allows it.
- Preserve visible focus states.

Panel and mobile behavior:

- Keep the dialog-based panel because it avoids transform and z-index conflicts in SillyTavern.
- Keep drag on desktop/tablet, but prevent awkward off-screen dragging by clamping the panel to the viewport.
- On small screens, disable or soften dragging so the native centered dialog remains predictable.

Visual cleanup:

- Reuse existing dark glass style, but reduce class-name drift between `st_ai_*` and `st_gpt_*` where practical without breaking selectors.
- Keep cards only for gallery items and the panel itself.
- Keep generated result, empty states, loading states, and errors visually consistent.

## Feature Additions

Add lightweight workflow actions without adding dependencies:

- Generated result actions:
  - Download image.
  - Copy prompt.
  - Reuse prompt in the input field.
  - Open preview by clicking the image.
- Gallery actions:
  - Preview image.
  - Download image.
  - Copy prompt.
  - Reuse prompt in the input field.
  - Regenerate image.
  - Delete image.
- Prompt templates:
  - Add a small select next to the prompt area with built-in templates such as "角色立绘", "场景氛围", "CG插画", and "道具特写".
  - Choosing a template inserts a short prompt scaffold into the textarea without overwriting existing text unless the textarea is empty.

Keep this version intentionally modest:

- No queue system.
- No bulk generation.
- No provider-specific advanced parameter matrix.
- No new storage schema beyond optional template UI state if needed.

## Data Flow

Manual generation:

1. User enters or builds a prompt in the generate tab.
2. User clicks generate or presses Enter without Shift.
3. `generateImage(prompt)` validates settings and prompt.
4. `callImageAPI(prompt)` selects OpenAI-compatible or Gemini flow.
5. The returned image URL is sanitized.
6. The result panel renders image and actions.
7. If history is enabled, the entry is saved to IndexedDB and gallery can refresh.

Inline chat generation:

1. MutationObserver schedules a scan of `.mes_text`.
2. Raw `[image]...[/image]` tags are replaced with inline generate buttons.
3. Clicking a button calls the same API path.
4. The button is replaced with a safe inline image wrapper on success.
5. Errors keep the retry button and display a short local error.

Gallery:

1. `renderGallery()` loads latest history, sorted by timestamp.
2. Items render with escaped prompts and sanitized image URLs.
3. Delegated action handlers perform preview, download, copy, reuse, regenerate, or delete.

## Error Handling

User-facing errors should be short and actionable:

- Missing API key or base URL: explain which setting is missing.
- HTTP failures: show provider/status and a summarized response.
- Missing image data: show that the model did not return an image and include a short text excerpt if present.
- Unsafe image URL: show a generic image result error and log details to console.

The extension should not crash SillyTavern if IndexedDB, clipboard, or download helpers fail. It should degrade with a toast or console message.

## Testing Strategy

Because the repository currently has no package manifest, no test runner, and no SillyTavern fixture, verification should use lightweight checks:

- Run `node --check index.js` after JavaScript edits.
- Add a small local browserless test script only if the helper logic becomes complex enough to justify it.
- Manually inspect changed selectors and generated HTML paths by reading the rendered templates.
- If a local SillyTavern instance is available later, smoke test:
  - Open panel.
  - Save/load/delete preset.
  - Generate with a mocked or real API-compatible endpoint.
  - Open preview repeatedly and confirm handlers do not duplicate.
  - Use `[image]...[/image]` inline generation in chat.
  - Check mobile viewport layout.

## Out Of Scope

- Full provider management UI.
- Image editing or variation APIs.
- Queue, cancellation, and batch generation.
- Refactoring into modules or adding a bundler.
- Rewriting world-info prompt resources unless requested separately.

## Acceptance Criteria

- Existing SillyTavern extension loading path remains unchanged.
- `node --check index.js` passes.
- No inline `onclick` remains in generated plugin UI.
- Repeated preview openings do not add duplicate active handlers.
- Chat auto-detection does not repeatedly reprocess already converted messages.
- Settings HTML has no layout inline styles.
- Icon-only buttons have accessible labels.
- Generated result and gallery expose download, copy prompt, reuse prompt, preview, and regeneration where appropriate.
- Mobile panel controls remain usable without horizontal overflow.

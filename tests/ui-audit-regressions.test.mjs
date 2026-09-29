import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueName, MAX_NAME } from '../src/core/library.js';
import { createWorkflowLibrary } from '../src/ui/workflow-library.js';
import { createVoiceControls } from '../src/ui/voice-settings.js';
import { LEGACY_SETTINGS_KEY, EXT_ID } from '../src/core/constants.js';

// A small DOM adapter drives the real controls; no provider requests leave this process.
class TestNode {
    constructor(tag = '') { this.tag = tag; this.children = []; this.dataset = {}; this.value = ''; this.textContent = ''; this.listeners = {}; this.attrs = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
    setAttribute(key, value) { this.attrs[key] = value; if (key === 'value') this.value = value; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    async emit(type) { for (const fn of this.listeners[type] || []) await fn({ currentTarget: this, target: this }); }
    focus() {}
    select() {}
}
function installDom(t) {
    const prior = { Node: globalThis.Node, document: globalThis.document };
    globalThis.Node = TestNode;
    globalThis.document = { createElement: (tag) => new TestNode(tag), createTextNode: (text) => ({ text }) };
    t.after(() => Object.assign(globalThis, prior));
}
const find = (node, predicate) => predicate(node) ? node : node.children?.map((child) => find(child, predicate)).find(Boolean);
const isPreview = (node) => String(node.attrs?.class).includes('st_ai_voice_preview');

test('40-character library names keep a unique suffix through multi-digit collisions', () => {
    const base = '画'.repeat(MAX_NAME);
    const items = { [base]: 1 };
    for (let index = 2; index <= 120; index++) {
        const candidate = uniqueName(items, base);
        assert.equal(candidate.endsWith(` ${index}`), true);
        assert.ok(candidate.length <= MAX_NAME);
        assert.ok(!Object.hasOwn(items, candidate));
        items[candidate] = index;
    }
});

test('workflow edits are flushed before another provider overwrites the textarea', async (t) => {
    installDom(t);
    let lib = { items: { A: '{"1":{"class_type":"SaveVideo"}}' }, active: 'A' };
    const textarea = new TestNode('textarea');
    const controls = createWorkflowLibrary({ id: 'workflow', textarea, status: new TestNode(), read: () => lib, write: (value) => { lib = value; }, exportName: 'test.json' });
    textarea.value = '{"1":{"class_type":"SaveVideo","inputs":{"text":"NEW"}}}';
    const edited = textarea.value;
    await textarea.emit('input');
    await controls.flush();
    textarea.value = ''; // provider form fill after the flush
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(lib.items.A, edited);
});

test('a pending workflow save uses the edited item and text instead of later DOM contents', async (t) => {
    installDom(t);
    let lib = { items: { A: 'old', B: 'untouched' }, active: 'A' };
    const textarea = new TestNode('textarea');
    createWorkflowLibrary({ id: 'workflow', textarea, status: new TestNode(), read: () => lib, write: (value) => { lib = value; }, exportName: 'test.json' });
    textarea.value = 'new workflow';
    await textarea.emit('input');
    lib.active = 'B';
    textarea.value = '';
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.deepEqual(lib, { items: { A: 'new workflow', B: 'untouched' }, active: 'B' });
});

let settingsImport = 0;
async function settingsCase(t, context, initial) {
    const values = new Map(initial);
    const prior = { localStorage: globalThis.localStorage, SillyTavern: globalThis.SillyTavern };
    globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
    globalThis.SillyTavern = { getContext: () => context };
    t.after(() => Object.assign(globalThis, prior));
    const settings = await import(`../src/settings.js?audit=${settingsImport++}`);
    return { values, settings };
}

test('legacy settings migrate with a normal empty ST settings container and retain the recovery copy', async (t) => {
    let saves = 0;
    const legacy = { apiBase: 'https://legacy.invalid/v1', apiKey: 'fake-legacy-key', model: 'legacy-model' };
    const context = { extensionSettings: {}, saveSettingsDebounced: () => saves++ };
    const { settings, values } = await settingsCase(t, context, [[LEGACY_SETTINGS_KEY, JSON.stringify(legacy)]]);
    const loaded = await settings.getSettings();
    assert.equal(loaded.apiKey, legacy.apiKey);
    assert.equal(context.extensionSettings[EXT_ID].model, legacy.model);
    assert.equal(saves, 1);
    await settings.saveSettings({ ...loaded, quality: 'high' });
    assert.equal(values.get(LEGACY_SETTINGS_KEY), JSON.stringify(legacy));
});

test('existing server settings remain authoritative and save failures keep a local recovery copy', async (t) => {
    const context = { extensionSettings: { [EXT_ID]: { apiKey: 'server-key' } }, saveSettingsDebounced: async () => { throw new Error('mock save failure'); } };
    const { settings, values } = await settingsCase(t, context, [[LEGACY_SETTINGS_KEY, '{"apiKey":"old-key"}']]);
    const loaded = await settings.getSettings();
    assert.equal(loaded.apiKey, 'server-key');
    assert.equal(await settings.saveSettings({ ...loaded, model: 'new-model' }), false);
    assert.equal(JSON.parse(values.get(LEGACY_SETTINGS_KEY)).model, 'new-model');
});

test('settings without a server save channel persist to the local fallback', async (t) => {
    const { settings, values } = await settingsCase(t, null, []);
    assert.equal(await settings.saveSettings({ apiKey: 'fallback-key' }), true);
    assert.equal(JSON.parse(values.get(LEGACY_SETTINGS_KEY)).apiKey, 'fallback-key');
});

for (const mode of ['blob', 'url', 'play-failure', 'audio-error']) test(`voice preview handles ${mode} and revokes its object URL`, async (t) => {
    installDom(t);
    const old = { fetch: globalThis.fetch, Audio: globalThis.Audio, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    t.after(() => { globalThis.fetch = old.fetch; globalThis.Audio = old.Audio; URL.createObjectURL = old.createObjectURL; URL.revokeObjectURL = old.revokeObjectURL; });
    const calls = [];
    const blobs = [];
    const revoked = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        if (mode === 'url' && calls.length === 1) return new Response(JSON.stringify({ output: { audio: { url: 'https://preview.invalid/audio.wav' } } }), { headers: { 'content-type': 'application/json' } });
        return new Response(new Uint8Array(16), { headers: { 'content-type': 'audio/wav' } });
    };
    URL.createObjectURL = (blob) => { assert.ok(blob instanceof Blob); blobs.push(blob); return 'blob:test-preview'; };
    URL.revokeObjectURL = (url) => revoked.push(url);
    globalThis.Audio = class extends EventTarget {
        play() { if (mode === 'play-failure') return Promise.reject(new Error('mock autoplay denied')); queueMicrotask(() => this.dispatchEvent(new Event(mode === 'audio-error' ? 'error' : 'ended'))); return Promise.resolve(); }
        pause() {}
    };
    const warning = new TestNode();
    const cfg = { provider: mode === 'url' ? 'dashscope' : 'openai', base: 'https://preview.invalid', key: 'fake-key', model: mode === 'url' ? 'qwen3-tts-flash' : 'tts-1', extra: '', voice: 'test' };
    const controls = createVoiceControls({ id: (name) => name, profile: () => ({ presets: [], voice: 'test' }), config: () => cfg, isFish: () => false, onChange() {}, onCommit() {}, warning });
    const field = controls.defaultField('voice', new TestNode());
    const button = find(field, isPreview);
    await button.emit('click');
    assert.equal(blobs.length, 1);
    assert.deepEqual(revoked, ['blob:test-preview']);
    assert.equal(button.disabled, false);
    if (mode === 'url') { assert.equal(calls.length, 2); assert.equal(calls[1], 'https://preview.invalid/audio.wav'); }
    if (mode === 'play-failure') assert.match(warning.textContent, /mock autoplay denied/);
    else if (mode === 'audio-error') assert.match(warning.textContent, /音频播放失败/);
    else assert.ok(!warning.textContent?.includes('试听失败'));
});

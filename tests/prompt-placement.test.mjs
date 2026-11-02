import assert from 'node:assert/strict';
import test from 'node:test';

import { extensionPromptPlacement, setExtensionPrompt } from '../src/st/context.js';

function withContext(fn) {
    const calls = [];
    globalThis.SillyTavern = { getContext: () => ({ setExtensionPrompt: (...args) => calls.push(args) }) };
    try { fn(calls); } finally { delete globalThis.SillyTavern; }
}

test('默认把提示词插进聊天记录，离末尾 1 条', () => {
    assert.deepEqual(extensionPromptPlacement(), { position: 1, depth: 1 });
    withContext((calls) => {
        setExtensionPrompt('st-ai-image', '写标签');
        assert.deepEqual(calls[0], ['st-ai-image', '写标签', 1, 1, false, 0]);
    });
});

test('深度 0 合法，超范围和乱填会被收回', () => {
    assert.deepEqual(extensionPromptPlacement({ position: 'chat', depth: 0 }), { position: 1, depth: 0 });
    assert.deepEqual(extensionPromptPlacement({ position: 'chat', depth: '3' }), { position: 1, depth: 3 });
    assert.equal(extensionPromptPlacement({ depth: -5 }).depth, 0);
    assert.equal(extensionPromptPlacement({ depth: 999 }).depth, 50);
    assert.equal(extensionPromptPlacement({ depth: 'abc' }).depth, 1);
});

test('选「系统提示词末尾」时回到旧版的 IN_PROMPT', () => {
    withContext((calls) => {
        setExtensionPrompt('st-ai-image', 'x', { position: 'top', depth: 4 });
        assert.equal(calls[0][2], 0);
    });
});

test('清除时照样传空字符串', () => {
    withContext((calls) => {
        setExtensionPrompt('st-ai-image', '');
        assert.equal(calls[0][1], '');
    });
});

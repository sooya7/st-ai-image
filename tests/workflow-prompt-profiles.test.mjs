import test from 'node:test';
import assert from 'node:assert/strict';
import { applyImagePromptPreset, profileKey, readPromptPresets, renameWorkflowProfiles, writePromptPresets } from '../src/core/library.js';
import { readSectionPrompt, writeSectionPrompt } from '../src/media/prompt-profiles.js';

const lib = (name, prefix, negative = '') => ({ items: { [name]: { prefix, suffix: '', negative } }, active: name, random: false });
const base = () => ({
    imageProvider: 'comfyui',
    comfyWorkflows: { 'MOSS-Image': '{}', 'Anima-Turbo': '{}' },
    comfyWorkflowId: 'MOSS-Image',
    systemPrompt: 'legacy',
    promptProfiles: { image: { comfyui: 'MOSS 提示词', novelai: 'NAI 提示词' } },
    promptPresetProfiles: { novelai: lib('厚涂光泽', 'nai'), comfyui: lib('默认', 'moss') },
});

test('ComfyUI 按工作流分开：没存过的工作流回落到 comfyui 键', () => {
    const s = base();
    assert.equal(profileKey(s), 'comfyui@MOSS-Image');
    assert.equal(readSectionPrompt(s, 'image'), 'MOSS 提示词');
    assert.equal(readPromptPresets(s).items.默认.prefix, 'moss');
    const a = { ...s, comfyWorkflowId: 'Anima-Turbo' };
    assert.equal(readSectionPrompt(a, 'image'), 'MOSS 提示词');
});

test('切换工作流时读到各自的提示词和画师串，写入只落到当前工作流的键', () => {
    let s = { ...base(), comfyWorkflowId: 'Anima-Turbo' };
    s = writeSectionPrompt(s, 'image', 'comfyui', 'Anima 提示词');
    s = writePromptPresets(s, 'comfyui', lib('厚涂光泽', '@anima', 'bad'));
    s = JSON.parse(JSON.stringify(s));
    assert.equal(s.promptProfiles.image['comfyui@Anima-Turbo'], 'Anima 提示词');
    assert.equal(s.promptProfiles.image.comfyui, 'MOSS 提示词');
    assert.equal(s.promptPresetProfiles.comfyui.items.默认.prefix, 'moss');
    assert.equal(readSectionPrompt(s, 'image'), 'Anima 提示词');
    assert.deepEqual(applyImagePromptPreset('girl', s), { prompt: '@anima, girl', negative: 'bad' });
    const m = { ...s, comfyWorkflowId: 'MOSS-Image' };
    assert.equal(readSectionPrompt(m, 'image'), 'MOSS 提示词');
    assert.deepEqual(applyImagePromptPreset('girl', m), { prompt: 'moss, girl', negative: '' });
    // 再写 MOSS 不会冲掉 Anima
    const m2 = writePromptPresets(m, 'comfyui', lib('默认', 'moss2'));
    assert.equal(readPromptPresets({ ...m2, comfyWorkflowId: 'Anima-Turbo' }).items.厚涂光泽.prefix, '@anima');
    assert.equal(m2.promptPresetProfiles['comfyui@MOSS-Image'].items.默认.prefix, 'moss2');
    // 显式传已解析的键（界面里攒着没存的输入）不受之后切换影响
    const k = writeSectionPrompt(m, 'image', 'comfyui@Anima-Turbo', '改过');
    assert.equal(readSectionPrompt({ ...k, comfyWorkflowId: 'Anima-Turbo' }, 'image'), '改过');
    assert.equal(readSectionPrompt(k, 'image'), 'MOSS 提示词');
});

test('NovelAI / SD WebUI 不受影响；没有工作流库时照旧用 comfyui 键', () => {
    const s = { ...base(), imageProvider: 'novelai', comfyWorkflowId: 'Anima-Turbo' };
    assert.equal(readSectionPrompt(s, 'image'), 'NAI 提示词');
    assert.equal(readPromptPresets(s).items.厚涂光泽.prefix, 'nai');
    assert.equal(profileKey(s), 'novelai');
    const w = writePromptPresets(s, 'novelai', lib('x', 'y'));
    assert.equal(w.promptPresetProfiles.novelai.items.x.prefix, 'y');
    const plain = { imageProvider: 'comfyui' };
    assert.equal(profileKey(plain), 'comfyui');
    assert.ok('comfyui' in writePromptPresets(plain, 'comfyui', lib('a', 'b')).promptPresetProfiles);
});

test('工作流改名时名下的提示词和画师串跟着搬', () => {
    let s = { ...base(), comfyWorkflowId: 'Anima-Turbo' };
    s = writeSectionPrompt(s, 'image', 'comfyui', 'A');
    s = writePromptPresets(s, 'comfyui', lib('p', 'q'));
    s = renameWorkflowProfiles({ ...s, comfyWorkflows: { 'MOSS-Image': '{}', Anima: '{}' }, comfyWorkflowId: 'Anima' }, 'Anima-Turbo', 'Anima');
    assert.equal(readSectionPrompt(s, 'image'), 'A');
    assert.equal(readPromptPresets(s).items.p.prefix, 'q');
});

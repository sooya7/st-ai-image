import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_NAME, applyPromptPreset, blankPromptPreset, deleteItem, importItems, isSingleWorkflow, normalizeLibrary,
    normalizePromptPreset, normalizeWorkflowText, pickPromptPreset, readPromptPresets, readWorkflowLibrary, renameItem, uniqueName,
} from '../src/core/library.js';
import { autoMarkWorkflow, fillWorkflow, parseWorkflow, placeholderValues } from '../src/media/selfhosted.js';
import { readMediaSettings } from '../src/media/media-settings.js';
import { WORKFLOW_TEMPLATES } from '../src/media/workflow-templates.js';

const presetOpts = { normalizeItem: normalizePromptPreset, blank: blankPromptPreset };

test('库：读档去掉坏条目、保证有「默认」、active 指向存在的条目', () => {
    const lib = normalizeLibrary({ ' 厚涂 ': { prefix: 'a' }, 坏的: 'x', '': { prefix: 'b' } }, '不存在', presetOpts);
    assert.deepEqual(Object.keys(lib.items), ['厚涂']);
    assert.equal(lib.active, '厚涂');
    assert.deepEqual(normalizeLibrary(null, '', presetOpts), { items: { [DEFAULT_NAME]: blankPromptPreset() }, active: DEFAULT_NAME });
});

test('库：重名自动加序号，改名保持顺序且拒绝重名，至少留一个', () => {
    const items = { 默认: 1, 厚涂: 2, '厚涂 2': 3 };
    assert.equal(uniqueName(items, '厚涂'), '厚涂 3');
    assert.equal(uniqueName(items, '  '), '未命名');
    assert.deepEqual(Object.keys(renameItem(items, '厚涂', '水彩')), ['默认', '水彩', '厚涂 2']);
    assert.throws(() => renameItem(items, '厚涂', '默认'), /已经有/);
    assert.throws(() => renameItem(items, '厚涂', ' '), /不能为空/);
    assert.deepEqual(deleteItem(items, '默认'), { 厚涂: 2, '厚涂 2': 3 });
    assert.throws(() => deleteItem({ 默认: 1 }, '默认'), /至少/);
});

test('导入：认「名字 → 内容」导出、单份工作流、st-chatu8 的字段名；同名不覆盖', () => {
    const presets = { 默认: blankPromptPreset() };
    const chatu8 = JSON.stringify({ 默认: { fixedPrompt: 'artist:a', fixedPrompt_end: 'end', negativePrompt: 'bad' }, 小马: { fixedPrompt: 'score_9' } });
    const { items, added } = importItems(presets, chatu8, { normalizeItem: normalizePromptPreset });
    assert.deepEqual(added, ['默认 2', '小马']);
    assert.deepEqual(items['默认 2'], { prefix: 'artist:a', suffix: 'end', negative: 'bad' });
    assert.deepEqual(items.默认, blankPromptPreset());
    const wf = JSON.stringify({ 3: { class_type: 'KSampler', inputs: {} } });
    const one = importItems({ 默认: '' }, wf, { normalizeItem: normalizeWorkflowText, single: isSingleWorkflow, fallbackName: 'my-flow' });
    assert.deepEqual(one.added, ['my-flow']);
    assert.throws(() => importItems({}, 'nope', { normalizeItem: normalizeWorkflowText }), /JSON/);
    assert.throws(() => importItems({}, '[1,2]', { normalizeItem: normalizeWorkflowText }), /没有能导入/);
});

test('画师串：拼成「前置, 描述, 后置」，换行变逗号、去掉多余逗号；负面单独给；随机只挑有内容的', () => {
    const preset = { prefix: 'artist:wlop,\nartist:ask, ', suffix: ', 8k', negative: 'lowres\nblurry' };
    assert.deepEqual(applyPromptPreset('1girl, smile', preset), { prompt: 'artist:wlop, artist:ask, 1girl, smile, 8k', negative: 'lowres, blurry' });
    assert.deepEqual(applyPromptPreset('cat', blankPromptPreset()), { prompt: 'cat', negative: '' });
    const items = { 默认: blankPromptPreset(), 甲: { prefix: 'A', suffix: '', negative: '' }, 乙: { prefix: '', suffix: 'B', negative: '' } };
    assert.equal(pickPromptPreset(items, '默认'), items.默认);
    assert.equal(pickPromptPreset(items, '默认', { random: true, rand: () => 0 }), items.甲);
    assert.equal(pickPromptPreset(items, '默认', { random: true, rand: () => 0.99 }), items.乙);
    assert.equal(pickPromptPreset({ 默认: blankPromptPreset() }, '默认', { random: true }).prefix, '');
});

test('迁移：旧的额外提示词/负面提示词搬进「默认」画师串，旧的单个工作流搬进「默认」工作流', () => {
    const lib = readPromptPresets({ imageProvider: 'novelai', extraPrompt: 'masterpiece', negativePrompt: 'ugly' });
    assert.deepEqual(lib.items.默认, { prefix: 'masterpiece', suffix: '', negative: 'ugly' });
    assert.equal(lib.random, false);
    const saved = readPromptPresets({ imageProvider: 'comfyui', extraPrompt: '旧的不再用', promptPresets: { 水彩: { prefix: 'watercolor' } }, promptPresetId: '水彩', promptPresetRandom: true });
    assert.deepEqual(Object.keys(saved.items), ['水彩']);
    assert.equal(saved.random, true);
    assert.deepEqual(readWorkflowLibrary(undefined, '', '{"1":{}}'), { items: { 默认: '{"1":{}}' }, active: '默认' });
    const video = readMediaSettings({ video: { profiles: { comfyui: { workflow: 'OLD' } } } }, 'video').profiles.comfyui;
    assert.deepEqual([video.workflows, video.workflowId, video.workflow], [{ 默认: 'OLD' }, '默认', 'OLD']);
    const chosen = readMediaSettings({ video: { profiles: { comfyui: { workflows: { A: 'a', B: 'b' }, workflowId: 'B' } } } }, 'video').profiles.comfyui;
    assert.equal(chosen.workflow, 'b');
});

// ComfyUI 默认文生图工作流（导出 API 格式）的结构
const SDXL = {
    3: { class_type: 'KSampler', inputs: { seed: 156680208700286, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'beautiful scenery', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark', clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
};

test('自动标记：顺着 positive/negative 找提示词节点，种子和尺寸换成占位符；步数/CFG/采样/模型保留工作流调好的值', () => {
    const { workflow, changes } = autoMarkWorkflow(SDXL);
    assert.equal(workflow[6].inputs.text, '%prompt%');
    assert.equal(workflow[7].inputs.text, '%negative_prompt%');
    assert.equal(workflow[3].inputs.seed, '%seed%');
    assert.deepEqual([workflow[3].inputs.steps, workflow[3].inputs.cfg, workflow[3].inputs.sampler_name, workflow[3].inputs.scheduler], [20, 8, 'euler', 'normal']);
    assert.equal(workflow[4].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors');
    assert.deepEqual([workflow[5].inputs.width, workflow[5].inputs.height, workflow[5].inputs.batch_size], ['%width%', '%height%', 1]);
    assert.deepEqual(workflow[3].inputs.positive, ['6', 0]);
    assert.equal(workflow[3].inputs.denoise, 1);
    assert.equal(changes.length, 5);
    assert.equal(SDXL[6].inputs.text, 'beautiful scenery'); // 不改原对象
    assert.equal(autoMarkWorkflow(workflow).changes.length, 0); // 标过的不重复标
    // 标完就能直接填
    const filled = fillWorkflow(parseWorkflow(JSON.stringify(workflow)), placeholderValues({ prompt: '1girl', negative: 'bad', size: '832x1216', random: () => 1 }));
    assert.deepEqual([filled[6].inputs.text, filled[7].inputs.text, filled[5].inputs.width, filled[3].inputs.seed, filled[3].inputs.cfg], ['1girl', 'bad', 832, 1, 8]);
});

test('工作流模板：SDXL 和 Anima 都是标好的 API 格式，填完没有剩下的占位符；Anima 保留 30 步 CFG 4 和默认负面', () => {
    for (const [name, template] of Object.entries(WORKFLOW_TEMPLATES)) {
        const text = JSON.stringify(template);
        assert.ok(isSingleWorkflow(template), name);
        const filled = fillWorkflow(parseWorkflow(text), placeholderValues({ prompt: '1girl', negative: 'bad', size: '832x1216', model: 'noob.safetensors', random: () => 7 }));
        assert.doesNotMatch(JSON.stringify(filled), /%\w+%/, name);
        assert.equal(autoMarkWorkflow(template).changes.length, 0, name); // 已经标好
    }
    const anima = fillWorkflow(WORKFLOW_TEMPLATES.Anima, placeholderValues({ prompt: 'cat', negative: 'dog', size: '1024x1024', random: () => 7 }));
    assert.deepEqual([anima[3].inputs.steps, anima[3].inputs.cfg, anima[3].inputs.scheduler, anima[1].inputs.unet_name], [30, 4, 'simple', 'anima-base-v1.0.safetensors']);
    assert.match(anima[7].inputs.text, /^worst quality, .*sepia, dog$/);
});

test('自动标记：提示词经过中间节点（ConditioningCombine 等）也能找到', () => {
    const wf = {
        1: { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 5, positive: ['2', 0], negative: ['4', 0] } },
        2: { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['3', 0], conditioning_2: ['3', 0] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: 'pos' } },
        4: { class_type: 'CLIPTextEncode', inputs: { text: 'neg' } },
    };
    const { workflow } = autoMarkWorkflow(wf);
    assert.deepEqual([workflow[3].inputs.text, workflow[4].inputs.text, workflow[1].inputs.noise_seed], ['%prompt%', '%negative_prompt%', '%seed%']);
});

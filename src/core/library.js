/**
 * 「名字 → 内容」的小型库：ComfyUI 工作流库、画师串（提示词预设）都用它。
 * 纯函数，不碰 DOM 和存储；调用方负责保存。
 */

export const DEFAULT_NAME = '默认';
export const MAX_NAME = 40;

export function cleanName(value) {
    return String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_NAME);
}

/** 读档：只留合法条目，保证至少有「默认」，active 指向存在的条目。 */
export function normalizeLibrary(items, active, { normalizeItem, blank }) {
    const out = {};
    if (items && typeof items === 'object' && !Array.isArray(items)) {
        for (const [name, value] of Object.entries(items)) {
            const key = cleanName(name);
            const item = normalizeItem(value);
            if (key && item !== null && !Object.hasOwn(out, key)) out[key] = item;
        }
    }
    if (!Object.keys(out).length) out[DEFAULT_NAME] = blank();
    const current = cleanName(active);
    return { items: out, active: Object.hasOwn(out, current) ? current : Object.keys(out)[0] };
}

/** 新名字已被占用时自动加序号：画师串 → 画师串 2 → 画师串 3。 */
export function uniqueName(items, wanted) {
    const base = cleanName(wanted) || '未命名';
    if (!Object.hasOwn(items, base)) return base;
    for (let i = 2; ; i++) {
        const suffix = ` ${i}`;
        const name = `${base.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}`;
        if (!Object.hasOwn(items, name)) return name;
    }
}

export function renameItem(items, from, to) {
    const name = cleanName(to);
    if (!name) throw new Error('名字不能为空');
    if (!Object.hasOwn(items, from)) throw new Error('要改名的条目不存在');
    if (name !== from && Object.hasOwn(items, name)) throw new Error(`已经有叫「${name}」的了`);
    // 保持原来的顺序
    return Object.fromEntries(Object.entries(items).map(([k, v]) => [k === from ? name : k, v]));
}

export function deleteItem(items, name) {
    if (Object.keys(items).length <= 1) throw new Error('至少要留一个');
    const next = { ...items };
    delete next[name];
    return next;
}

/**
 * 导入：接受 { 名字: 内容 } 的导出文件，或单个条目（由 single 判断，比如一份 API 格式工作流）。
 * 同名的加序号，不覆盖已有的。返回 { items, added: [新名字] }。
 */
export function importItems(items, text, { normalizeItem, single, fallbackName }) {
    let data;
    try { data = JSON.parse(String(text ?? '')); } catch { throw new Error('文件不是有效的 JSON'); }
    const entries = single?.(data) ? [[fallbackName, data]] : (data && typeof data === 'object' && !Array.isArray(data) ? Object.entries(data) : []);
    const next = { ...items };
    const added = [];
    for (const [name, value] of entries) {
        const item = normalizeItem(value);
        if (item === null) continue;
        const key = uniqueName(next, name);
        next[key] = item;
        added.push(key);
    }
    if (!added.length) throw new Error('文件里没有能导入的内容');
    return { items: next, added };
}

/* ---------- 画师串（提示词预设） ---------- */

export const blankPromptPreset = () => ({ prefix: '', suffix: '', negative: '' });

export function normalizePromptPreset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const pick = (...keys) => String(keys.map((k) => value[k]).find((v) => typeof v === 'string') ?? '').slice(0, 8000);
    // 也认 st-chatu8 的字段名，方便把它导出的预设直接导进来
    return { prefix: pick('prefix', 'fixedPrompt'), suffix: pick('suffix', 'fixedPrompt_end'), negative: pick('negative', 'negativePrompt') };
}

/** 换行当逗号，连续的逗号合成一个，去掉首尾逗号；只动分隔符，标签本身（含权重括号）不碰。 */
const cleanTags = (text) => String(text ?? '').replace(/\s*\n\s*/g, ', ').replace(/\s*,(?:\s*,)+/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
const joinTags = (...parts) => parts.map(cleanTags).filter(Boolean).join(', ');

/** 画师串套到提示词上：前置, 描述, 后置；负面单独给。 */
export function applyPromptPreset(prompt, preset) {
    const p = preset || blankPromptPreset();
    return { prompt: joinTags(p.prefix, prompt, p.suffix), negative: joinTags(p.negative) };
}

/** 有内容的画师串里随机挑一个；都空着就用当前的。 */
export function pickPromptPreset(items, active, { random = false, rand = Math.random } = {}) {
    if (!random) return items[active] || blankPromptPreset();
    const pool = Object.values(items).filter((p) => p.prefix.trim() || p.suffix.trim() || p.negative.trim());
    return pool.length ? pool[Math.floor(rand() * pool.length)] : (items[active] || blankPromptPreset());
}

/* ---------- ComfyUI 工作流库 ---------- */

/** 工作流按字符串存（和用户贴进来的一样），坏的也先收下，生成时再报错。 */
export function normalizeWorkflowText(value) {
    if (typeof value === 'string') return value.slice(0, 400000);
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2).slice(0, 400000);
    return null;
}

/** 单份 API 格式工作流（每个值都有 class_type），而不是「名字 → 工作流」的导出文件。 */
export const isSingleWorkflow = (data) => !!data && typeof data === 'object' && !Array.isArray(data)
    && Object.values(data).length > 0 && Object.values(data).every((n) => n && typeof n === 'object' && typeof n.class_type === 'string');

/* ---------- 从设置里读（带旧字段迁移） ---------- */

/** 图片设置里的画师串。没存过时把旧的「额外提示词 / 负面提示词」搬进「默认」。 */
export function readPromptPresets(s) {
    const legacy = { [DEFAULT_NAME]: { prefix: s?.extraPrompt || '', suffix: '', negative: s?.negativePrompt || '' } };
    const lib = normalizeLibrary(s?.promptPresets ?? legacy, s?.promptPresetId, { normalizeItem: normalizePromptPreset, blank: blankPromptPreset });
    return { ...lib, random: s?.promptPresetRandom === true };
}

/** 工作流库。没存过时把旧的单个工作流搬进「默认」。 */
export function readWorkflowLibrary(items, active, legacyText = '') {
    return normalizeLibrary(items ?? { [DEFAULT_NAME]: legacyText || '' }, active, { normalizeItem: normalizeWorkflowText, blank: () => '' });
}

/**
 * 图片页的「画师串」（提示词预设）：库控件 + 前置正面 / 后置正面 / 负面三栏 + 随机开关。
 * 生成时拼成「前置, 描述, 后置」，负面单独给（见 core/library.js 的 applyPromptPreset）。
 */
import {
    DEFAULT_NAME, blankPromptPreset, cleanName, deleteItem, importItems, normalizePromptPreset, readPromptPresets, renameItem, uniqueName, writePromptPresets,
} from '../core/library.js';
import { getSettings, peekSettings, saveSettings } from '../settings.js';
import { el, helpBox } from './dom.js';
import { createLibraryControl } from './library-control.js';

const FIELDS = [
    ['prefix', '前置正面（画师串、画风、质量词，放在描述前面）', 'artist:xxx, artist:yyy, masterpiece, best quality'],
    ['suffix', '后置正面（放在描述后面）', 'highly detailed, 8k'],
    ['negative', '负面提示词', 'lowres, bad anatomy, blurry'],
];

let mounted = null;
export const flushPromptPresetEdits = () => mounted?.flush();
export const refreshPromptPresets = () => mounted?.refresh();

export function mountPromptPresets(root) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    const read = () => readPromptPresets(peekSettings());
    const save = async (library, provider = peekSettings().imageProvider) => {
        await saveSettings(writePromptPresets(await getSettings(), provider, library));
    };

    const areas = Object.fromEntries(FIELDS.map(([key, , placeholder]) => [key, el('textarea', {
        id: `st_ai_prompt_preset_${key}`, class: 'st_ai_textarea', rows: 2, maxlength: 8000, placeholder,
    })]));
    const show = () => {
        const lib = read();
        for (const [key, node] of Object.entries(areas)) node.value = lib.items[lib.active]?.[key] ?? '';
        random.checked = lib.random;
    };
    // 输入先攒着；切换/新建/删除前先 flush，免得写进新选中的那个
    let timer = null;
    let pending = null;
    const flush = async () => {
        if (!pending) return;
        clearTimeout(timer);
        timer = null;
        const edit = pending;
        pending = null;
        const lib = readPromptPresets(await getSettings(), edit.provider);
        await save({ ...lib, items: { ...lib.items, [edit.active]: edit.current } }, edit.provider);
    };
    for (const node of Object.values(areas)) node.addEventListener('input', () => {
        clearTimeout(timer);
        pending = { provider: peekSettings().imageProvider, active: read().active, current: Object.fromEntries(Object.keys(areas).map((key) => [key, areas[key].value])) };
        timer = setTimeout(flush, 400);
    });

    const random = el('input', { type: 'checkbox', id: 'st_ai_prompt_preset_random' });
    random.checked = read().random;
    random.addEventListener('change', async () => {
        const checked = random.checked;
        const provider = peekSettings().imageProvider;
        await flush();
        await save({ ...readPromptPresets(await getSettings(), provider), random: checked }, provider);
    });

    const control = createLibraryControl({
        id: 'st_ai_prompt_preset', noun: '画师串',
        names: () => Object.keys(read().items),
        active: () => read().active,
        onSelect: async (name) => { await flush(); await save({ ...read(), active: name }); show(); },
        onCreate: async (name, copy) => {
            await flush();
            const lib = read();
            const key = uniqueName(lib.items, name);
            await save({ ...lib, items: { ...lib.items, [key]: copy ? { ...lib.items[lib.active] } : blankPromptPreset() }, active: key });
            show();
        },
        onRename: async (from, to) => { await flush(); const lib = read(); await save({ ...lib, items: renameItem(lib.items, from, to), active: cleanName(to) }); },
        onDelete: async (name) => {
            clearTimeout(timer);
            timer = null;
            pending = null;
            const lib = read();
            const items = deleteItem(lib.items, name);
            await save({ ...lib, items, active: Object.keys(items)[0] });
            show();
        },
        onImport: async (text) => {
            // 也收 st-chatu8 的导出（{ presets: {...} } 或裸的「名字 → 预设」）
            let source = text;
            try { const data = JSON.parse(text); if (data?.presets && typeof data.presets === 'object') source = JSON.stringify(data.presets); } catch { /* 交给 importItems 报错 */ }
            await flush();
            const lib = read();
            const { items, added } = importItems(lib.items, source, {
                normalizeItem: normalizePromptPreset,
                single: (d) => normalizePromptPreset(d) !== null && ['prefix', 'suffix', 'negative', 'fixedPrompt', 'negativePrompt'].some((k) => typeof d[k] === 'string'),
                fallbackName: DEFAULT_NAME,
            });
            await save({ ...lib, items, active: added[0] });
            show();
            return added;
        },
        onExport: () => ({ fileName: 'st-ai-image-画师串.json', data: read().items }),
    });

    root.replaceChildren(el('div', { class: 'st_ai_prompt_presets' }, [
        control.node,
        ...FIELDS.map(([key, label]) => el('div', { class: 'st_ai_field st_ai_prompt_textarea_field' }, [el('label', { for: areas[key].id, text: label }), areas[key]])),
        el('label', { class: 'st_ai_checkbox' }, [random, el('span', { text: '每张图随机用一个画师串（只从有内容的里面挑）' })]),
        helpBox('只用于当前接口：NovelAI、ComfyUI、SD WebUI 各自保存预设、选中项和随机开关。正面拼成「前置, 描述, 后置」，负面单独传。导入导出仅包含当前接口的画师串；支持 st-chatu8 的固定提示词预设。'),
    ]));
    mounted = { flush, refresh: () => { show(); control.render(); } };
    show();
}

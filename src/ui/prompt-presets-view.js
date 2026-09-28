/**
 * 图片页的「画师串」（提示词预设）：库控件 + 前置正面 / 后置正面 / 负面三栏 + 随机开关。
 * 生成时拼成「前置, 描述, 后置」，负面单独给（见 core/library.js 的 applyPromptPreset）。
 */
import {
    DEFAULT_NAME, blankPromptPreset, cleanName, deleteItem, importItems, normalizePromptPreset, readPromptPresets, renameItem, uniqueName,
} from '../core/library.js';
import { getSettings, peekSettings, saveSettings } from '../settings.js';
import { el, helpBox } from './dom.js';
import { createLibraryControl } from './library-control.js';

const FIELDS = [
    ['prefix', '前置正面（画师串、画风、质量词，放在描述前面）', 'artist:xxx, artist:yyy, masterpiece, best quality'],
    ['suffix', '后置正面（放在描述后面）', 'highly detailed, 8k'],
    ['negative', '负面提示词', 'lowres, bad anatomy, blurry'],
];

async function write(patch) {
    await saveSettings({ ...(await getSettings()), ...patch });
}

export function mountPromptPresets(root) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    const read = () => readPromptPresets(peekSettings());
    const save = ({ items, active }) => write({ promptPresets: items, promptPresetId: active });

    const areas = Object.fromEntries(FIELDS.map(([key, , placeholder]) => [key, el('textarea', {
        id: `st_ai_prompt_preset_${key}`, class: 'st_ai_textarea', rows: 2, maxlength: 8000, placeholder,
    })]));
    const show = () => { const lib = read(); for (const [key, node] of Object.entries(areas)) node.value = lib.items[lib.active]?.[key] ?? ''; };
    // 输入先攒着；切换/新建/删除前先 flush，免得写进新选中的那个
    let timer = null;
    const flush = async () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        const lib = read();
        const current = Object.fromEntries(Object.keys(areas).map((key) => [key, areas[key].value]));
        await save({ items: { ...lib.items, [lib.active]: current }, active: lib.active });
    };
    for (const node of Object.values(areas)) node.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 400); });

    const random = el('input', { type: 'checkbox', id: 'st_ai_prompt_preset_random' });
    random.checked = read().random;
    random.addEventListener('change', () => write({ promptPresetRandom: random.checked }));

    const control = createLibraryControl({
        id: 'st_ai_prompt_preset', noun: '画师串',
        names: () => Object.keys(read().items),
        active: () => read().active,
        onSelect: async (name) => { await flush(); await save({ ...read(), active: name }); show(); },
        onCreate: async (name, copy) => {
            await flush();
            const lib = read();
            const key = uniqueName(lib.items, name);
            await save({ items: { ...lib.items, [key]: copy ? { ...lib.items[lib.active] } : blankPromptPreset() }, active: key });
            show();
        },
        onRename: async (from, to) => { await flush(); const lib = read(); await save({ items: renameItem(lib.items, from, to), active: cleanName(to) }); },
        onDelete: async (name) => {
            clearTimeout(timer);
            timer = null;
            const items = deleteItem(read().items, name);
            await save({ items, active: Object.keys(items)[0] });
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
            await save({ items, active: added[0] });
            show();
            return added;
        },
        onExport: () => ({ fileName: 'st-ai-image-画师串.json', data: read().items }),
    });

    root.replaceChildren(el('div', { class: 'st_ai_prompt_presets' }, [
        el('label', { for: 'st_ai_prompt_preset_select', text: '画师串（提示词预设）' }),
        control.node,
        ...FIELDS.map(([key, label]) => el('div', { class: 'st_ai_field st_ai_prompt_textarea_field' }, [el('label', { for: areas[key].id, text: label }), areas[key]])),
        el('label', { class: 'st_ai_checkbox' }, [random, el('span', { text: '每张图随机用一个画师串（只从有内容的里面挑）' })]),
        helpBox('所有图片服务都会用：正面拼成「前置, 描述, 后置」，负面单独传（OpenAI 类接口附在描述后面）。可以导入 st-chatu8 导出的固定提示词预设。'),
    ]));
    show();
}

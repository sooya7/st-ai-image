/**
 * ComfyUI 工作流库：库控件 + 工作流文本框 + 「自动标记占位符」+ 即时校验。图片页和视频页共用。
 * 读写都通过 read()/write()，这里不关心存在哪。
 */
import { DEFAULT_NAME, cleanName, deleteItem, importItems, isSingleWorkflow, normalizeWorkflowText, renameItem, uniqueName } from '../core/library.js';
import { autoMarkWorkflow, parseWorkflow } from '../media/selfhosted.js';
import { el } from './dom.js';
import { createLibraryControl } from './library-control.js';

const TOKENS = /%[A-Za-z_一-鿿][\w一-鿿]*%/g;

/** 校验结果说成一句话：格式对了列出占位符，没占位符也提醒。 */
export function describeWorkflow(text) {
    if (!String(text || '').trim()) return { text: '还没有填工作流', bad: true };
    try {
        const nodes = Object.keys(parseWorkflow(text)).length;
        const tokens = [...new Set(String(text).match(TOKENS) || [])];
        return tokens.length
            ? { text: `✓ API 格式，${nodes} 个节点；占位符：${tokens.join(' ')}`, bad: false }
            : { text: `✓ API 格式，${nodes} 个节点，但没有占位符，提示词不会传进去；可以点「自动标记占位符」`, bad: true };
    } catch (e) {
        return { text: e.message, bad: true };
    }
}

/**
 * @param {object} o
 * @param {string} o.id
 * @param {HTMLTextAreaElement} o.textarea
 * @param {HTMLElement} o.status
 * @param {() => { items: Record<string,string>, active: string }} o.read
 * @param {(lib: { items: Record<string,string>, active: string }) => Promise<void>|void} o.write
 * @param {string} o.exportName
 * @param {Record<string, object>} [o.templates] 「从模板新建」的选项：名字 → API 格式工作流
 */
export function createWorkflowLibrary({ id, textarea, status, read, write, exportName, templates }) {
    const check = () => {
        const { text, bad } = describeWorkflow(textarea.value);
        status.textContent = text;
        status.classList.toggle('st_ai_media_warning', bad);
    };
    const show = () => { const lib = read(); textarea.value = lib.items[lib.active] ?? ''; check(); };
    // 输入先攒着，400ms 后写进当前条目；切换/新建/删除前必须先 flush，否则会写进新选中的那个
    let timer = null;
    let pending = null;
    const flush = async () => {
        if (!pending) return;
        clearTimeout(timer);
        timer = null;
        const edit = pending;
        pending = null;
        const lib = read();
        await write({ items: { ...lib.items, [edit.active]: edit.text }, active: lib.active });
    };
    textarea.addEventListener('input', () => {
        check();
        clearTimeout(timer);
        pending = { active: read().active, text: textarea.value };
        timer = setTimeout(flush, 400);
    });

    const autoMark = el('button', {
        type: 'button', id: `${id}_automark`, class: 'st_ai_btn st_ai_library_btn', text: '自动标记占位符',
        title: '顺着采样器的正/负连线找到提示词节点，并把种子、步数、尺寸、模型等换成占位符',
        onclick: async () => {
            try {
                clearTimeout(timer);
                timer = null;
                pending = null;
                const { workflow, changes } = autoMarkWorkflow(parseWorkflow(textarea.value));
                if (!changes.length) return control.say('没有找到可以标记的值（可能已经标记过了）');
                textarea.value = JSON.stringify(workflow, null, 2);
                const lib = read();
                await write({ items: { ...lib.items, [lib.active]: textarea.value }, active: lib.active });
                check();
                control.say(`标记了 ${changes.length} 处：${changes.join('；')}`);
            } catch (e) {
                control.say(e.message, true);
            }
        },
    });

    // 从内置模板新建一份（只有生图库传 templates）
    const templateSelect = templates && el('select', {
        id: `${id}_template`, class: 'st_ai_input st_ai_library_template', 'aria-label': '从模板新建工作流',
    }, [el('option', { value: '', text: '从模板新建…' }), ...Object.keys(templates).map((name) => el('option', { value: name, text: name }))]);
    templateSelect?.addEventListener('change', async () => {
        const name = templateSelect.value;
        templateSelect.value = '';
        if (!templates[name]) return;
        try {
            await flush();
            const lib = read();
            const key = uniqueName(lib.items, name);
            await write({ items: { ...lib.items, [key]: JSON.stringify(templates[name], null, 2) }, active: key });
            control.render();
            show();
            control.say(`已从模板新建「${key}」；模型文件名和本机不一样的话在框里改`);
        } catch (e) {
            control.say(e.message, true);
        }
    });

    const control = createLibraryControl({
        id, noun: '工作流',
        names: () => Object.keys(read().items),
        active: () => read().active,
        onSelect: async (name) => { await flush(); await write({ ...read(), active: name }); show(); },
        onCreate: async (name, copy) => {
            await flush();
            const lib = read();
            const key = uniqueName(lib.items, name);
            await write({ items: { ...lib.items, [key]: copy ? textarea.value : '' }, active: key });
            show();
        },
        onRename: async (from, to) => { await flush(); const lib = read(); await write({ items: renameItem(lib.items, from, to), active: cleanName(to) }); },
        onDelete: async (name) => {
            clearTimeout(timer);
            timer = null; // 要删的就是正在编辑的那个，没保存的改动一起丢掉
            pending = null;
            const items = deleteItem(read().items, name);
            await write({ items, active: Object.keys(items)[0] });
            show();
        },
        onImport: async (text, fileName) => {
            await flush();
            const lib = read();
            const { items, added } = importItems(lib.items, text, { normalizeItem: normalizeWorkflowText, single: isSingleWorkflow, fallbackName: fileName || DEFAULT_NAME });
            // 导入的是单份工作流时，存成缩进好的文本，方便在框里看
            for (const name of added) {
                try { items[name] = JSON.stringify(JSON.parse(items[name]), null, 2); } catch { /* 坏的原样留着，生成时报错 */ }
            }
            await write({ items, active: added[0] });
            show();
            return added;
        },
        onExport: () => ({ fileName: exportName, data: read().items }),
        extra: templateSelect ? [autoMark, templateSelect] : [autoMark],
    });
    show();
    return { node: control.node, flush, refresh: () => { control.render(); show(); } };
}

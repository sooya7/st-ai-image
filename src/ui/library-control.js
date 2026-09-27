/**
 * 「名字 → 内容」库的通用控件：下拉框 + 新建 / 另存为 / 重命名 / 删除 / 导入 / 导出。
 * 起名和删除确认都在控件里完成，不用 prompt()/confirm()（TauriTavern 的 WebView 里不一定可用）。
 */
import { el } from './dom.js';

/**
 * @param {object} o
 * @param {string} o.id           元素 id 前缀
 * @param {string} o.noun         「工作流」「画师串」，用在按钮提示里
 * @param {() => string[]} o.names
 * @param {() => string} o.active
 * @param {(name: string) => void | Promise<void>} o.onSelect
 * @param {(name: string, copy: boolean) => void | Promise<void>} o.onCreate  copy=true 是另存为
 * @param {(from: string, to: string) => void | Promise<void>} o.onRename
 * @param {(name: string) => void | Promise<void>} o.onDelete
 * @param {(text: string, fileName: string) => string[] | Promise<string[]>} o.onImport 返回新加的名字
 * @param {() => { fileName: string, data: object }} o.onExport
 * @param {HTMLElement[]} [o.extra] 追加到按钮行的其他按钮
 */
export function createLibraryControl(o) {
    const id = (name) => `${o.id}_${name}`;
    const select = el('select', { id: id('select'), class: 'st_ai_input st_ai_flex_fill', 'aria-label': `选择${o.noun}` });
    const status = el('p', { class: 'st_ai_speech_hint st_ai_library_status', role: 'status', 'aria-live': 'polite' });
    const nameInput = el('input', { type: 'text', id: id('name'), class: 'st_ai_input st_ai_flex_fill', maxlength: 40, placeholder: `${o.noun}名字` });
    const nameRow = el('div', { class: 'st_ai_inline_row st_ai_library_name', hidden: true });
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true, id: id('file') });
    let mode = null;
    let armedDelete = false;

    const say = (text, bad = false) => { status.textContent = text; status.classList.toggle('st_ai_media_warning', bad); };
    const run = async (fn, done) => {
        try { await fn(); if (done) say(done); render(); } catch (e) { say(e.message || String(e), true); }
    };

    function render() {
        const names = o.names();
        const active = o.active();
        select.replaceChildren(...names.map((name) => el('option', { value: name, text: name })));
        select.value = active;
        remove.textContent = '删除';
        armedDelete = false;
    }

    function askName(next, preset = '') {
        mode = next;
        nameRow.hidden = false;
        nameInput.value = preset;
        nameInput.focus();
        nameInput.select();
    }
    const closeName = () => { mode = null; nameRow.hidden = true; };
    const confirmName = () => {
        const name = nameInput.value.trim();
        const current = o.active();
        const action = mode;
        closeName();
        if (!name) return say('名字不能为空', true);
        if (action === 'rename') run(() => o.onRename(current, name), `已改名为「${name}」`);
        else run(() => o.onCreate(name, action === 'copy'), action === 'copy' ? `已另存为「${name}」` : `已新建「${name}」`);
    };

    const button = (key, text, title, onclick) => el('button', { type: 'button', id: id(key), class: 'st_ai_btn st_ai_library_btn', text, title, onclick });
    const remove = button('delete', '删除', `删除当前${o.noun}`, () => {
        if (!armedDelete) {
            armedDelete = true;
            remove.textContent = '再点确认删除';
            return;
        }
        const name = o.active();
        run(() => o.onDelete(name), `已删除「${name}」`);
    });

    select.addEventListener('change', () => run(() => o.onSelect(select.value), ''));
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmName(); }
        if (e.key === 'Escape') { e.preventDefault(); closeName(); }
    });
    file.addEventListener('change', async () => {
        const picked = file.files?.[0];
        file.value = '';
        if (!picked) return;
        const text = await picked.text();
        const base = picked.name.replace(/\.json$/i, '');
        run(async () => {
            const added = await o.onImport(text, base);
            say(`导入了 ${added.length} 个：${added.join('、')}`);
        });
    });

    nameRow.append(nameInput,
        el('button', { type: 'button', id: id('name_ok'), class: 'st_ai_btn', text: '确定', onclick: confirmName }),
        el('button', { type: 'button', class: 'st_ai_btn', text: '取消', onclick: closeName }));

    const node = el('div', { class: 'st_ai_library' }, [
        el('div', { class: 'st_ai_inline_row' }, [select]),
        el('div', { class: 'st_ai_inline_row st_ai_library_actions' }, [
            button('new', '新建', `新建空白${o.noun}`, () => askName('new')),
            button('copy', '另存为', `把当前${o.noun}复制一份`, () => askName('copy', `${o.active()} 副本`)),
            button('rename', '重命名', `重命名当前${o.noun}`, () => askName('rename', o.active())),
            remove,
            button('import', '导入', `从 JSON 文件导入${o.noun}`, () => file.click()),
            button('export', '导出', `把全部${o.noun}导出成 JSON 文件`, () => {
                const { fileName, data } = o.onExport();
                const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
                const a = el('a', { href: url, download: fileName });
                document.body.append(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                say(`已导出 ${fileName}`);
            }),
            ...(o.extra || []),
        ]),
        nameRow, file, status,
    ]);
    render();
    return { node, render, say };
}

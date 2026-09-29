/**
 * 语音设置页里的音色部分：默认音色下拉框 + 音色预设表（类型名 → 音色，每行可改、可试听）。
 * 预设表按服务分开存在 profile.presets；Fish 有推荐音色，可一键填入。
 */
import { errMsg } from '../core/notify.js';
import { FISH_VOICES, MAX_PRESETS, fishPresets } from '../media/voice-presets.js';
import { el, helpBox } from './dom.js';

const CUSTOM = '__custom__';
const PREVIEW_TEXT = '你好，很高兴认识你。今天过得怎么样？';

/**
 * @param {object} o
 * @param {(name: string) => string} o.id
 * @param {() => object} o.profile   当前服务的配置（可直接改）
 * @param {() => object} o.config    当前请求配置（试听用）
 * @param {() => boolean} o.isFish   当前配置是否 Fish
 * @param {() => void} o.onChange    文字输入后（防抖保存）
 * @param {() => void} o.onCommit    结构变化后（立即保存）
 * @param {HTMLElement} o.warning
 */
export function createVoiceControls({ id, profile, config, isFish, onChange, onCommit, warning }) {
    const datalist = el('datalist', { id: id('fish_voices') },
        FISH_VOICES.map((v) => el('option', { value: v.fish, label: `${v.type}（${v.note}）` })));
    const select = el('select', { id: id('voice_preset'), class: 'st_ai_input st_ai_flex_fill' });
    const input = { node: null };
    const rows = el('div', { class: 'st_ai_voice_rows' });
    const fishFill = el('button', { type: 'button', id: id('fish_fill'), class: 'st_ai_btn', text: '填入 Fish 推荐音色' });

    async function preview(button, voice) {
        const cfg = { ...config(), voice };
        if (!String(cfg.key || '').trim()) { warning.textContent = '先填写 API Key 再试听'; return; }
        const label = button.textContent;
        let url = null;
        let audio = null;
        button.disabled = true;
        button.textContent = '合成中…';
        try {
            const { generateMedia, downloadMedia } = await import('../media/client.js');
            const result = await generateMedia('audio', cfg, PREVIEW_TEXT);
            const blob = result.blob || await downloadMedia(result, 'audio', { proxy: cfg.proxy });
            url = URL.createObjectURL(blob);
            audio = new Audio(url);
            const done = new Promise((resolve, reject) => { audio.addEventListener('ended', resolve, { once: true }); audio.addEventListener('error', () => reject(new Error('音频播放失败')), { once: true }); });
            button.textContent = '播放中…';
            await Promise.all([audio.play(), done]);
            if (warning.textContent.startsWith('试听')) warning.textContent = '';
        } catch (error) {
            warning.textContent = `试听失败：${errMsg(error)}`;
        } finally {
            audio?.pause();
            if (url) URL.revokeObjectURL(url);
            button.disabled = false;
            button.textContent = label;
        }
    }

    const previewButton = (onClick, title) => el('button', { type: 'button', class: 'st_ai_btn st_ai_voice_preview', title: `${title}（会调用一次接口）`, 'aria-label': title, text: '试听', onclick: (e) => onClick(e.currentTarget) });

    /** 默认音色下拉框：选项来自当前预设表里配了音色的行。 */
    function syncSelect({ keepCustom = false } = {}) {
        const p = profile();
        const options = p.presets.filter((r) => r.voice);
        select.replaceChildren(
            el('option', { value: '', text: '服务自带的默认声音' }),
            ...options.map((r) => el('option', { value: r.voice, text: r.type })),
            el('option', { value: CUSTOM, text: '自定义音色 ID…' }),
        );
        const wasCustom = keepCustom && select.dataset.value === CUSTOM;
        select.value = wasCustom ? CUSTOM : !p.voice ? '' : options.some((r) => r.voice === p.voice) ? p.voice : CUSTOM;
        select.dataset.value = select.value;
        if (input.node) input.node.hidden = select.value !== CUSTOM;
    }

    function renderRows() {
        const p = profile();
        const fish = isFish();
        rows.replaceChildren(...p.presets.map((row, index) => {
            const type = el('input', { type: 'text', class: 'st_ai_input st_ai_voice_type', value: row.type, maxlength: 20, placeholder: '类型名', 'aria-label': '音色类型名', dataset: { index } });
            const voice = el('input', { type: 'text', class: 'st_ai_input st_ai_flex_fill st_ai_voice_id', value: row.voice, placeholder: fish ? '音色 ID（可从推荐里选）' : '音色 ID / 名称', 'aria-label': `${row.type || '该类型'}的音色`, autocomplete: 'off', dataset: { index } });
            if (fish) voice.setAttribute('list', datalist.id);
            type.addEventListener('input', () => { row.type = type.value.replace(/["“”[\]\r\n]/g, '').trim(); syncSelect(); onChange(); });
            voice.addEventListener('input', () => { row.voice = voice.value.trim(); syncSelect(); onChange(); });
            const remove = el('button', { type: 'button', class: 'st_ai_btn', title: '删除这一行', 'aria-label': '删除这一行', text: '×', onclick: () => { p.presets.splice(index, 1); renderRows(); syncSelect(); onCommit(); } });
            return el('div', { class: 'st_ai_inline_row st_ai_voice_row' }, [type, voice, previewButton((b) => preview(b, row.voice), `试听「${row.type}」`), remove]);
        }));
        fishFill.hidden = !fish;
    }

    const add = el('button', {
        type: 'button', id: id('preset_add'), class: 'st_ai_btn', text: '+ 添加类型',
        onclick: () => {
            const p = profile();
            if (p.presets.length >= MAX_PRESETS) { warning.textContent = `最多 ${MAX_PRESETS} 个类型`; return; }
            p.presets.push({ type: '', voice: '' });
            renderRows();
            rows.lastElementChild?.querySelector('.st_ai_voice_type')?.focus();
        },
    });
    fishFill.addEventListener('click', () => {
        // 只补空着的和同名的行，用户自己加的类型、改过的名字保留
        const p = profile();
        for (const rec of fishPresets()) {
            const row = p.presets.find((r) => r.type === rec.type);
            if (row) row.voice = rec.voice;
            else if (p.presets.length < MAX_PRESETS) p.presets.push({ ...rec });
        }
        renderRows();
        syncSelect();
        onCommit();
    });

    select.addEventListener('change', () => {
        select.dataset.value = select.value;
        if (select.value === CUSTOM) {
            input.node.hidden = false;
            input.node.focus();
            return;
        }
        profile().voice = select.value;
        input.node.value = select.value;
        input.node.hidden = true;
        onCommit();
    });

    return {
        /** 默认音色那一栏：下拉框 + 试听，下面是自定义 ID 输入框。 */
        defaultField(label, node) {
            input.node = node;
            node.placeholder = '音色 ID / 名称';
            return el('div', { class: 'st_ai_field', dataset: { field: 'voice' } }, [
                el('label', { for: select.id, text: label }),
                el('div', { class: 'st_ai_inline_row' }, [select, previewButton((b) => preview(b, profile().voice), '试听默认音色')]),
                node,
            ]);
        },
        presetsField: el('div', { class: 'st_ai_field st_ai_voice_presets', dataset: { field: 'presets' } }, [
            el('label', { text: '音色预设（AI 在标签里写类型名来选用）' }),
            helpBox('类型名和音色都可以改，也能增删。音色没填的类型不会出现在提示词里，AI 写了也按默认音色读。每个服务各存一张表。'),
            rows,
            el('div', { class: 'st_ai_inline_row' }, [add, fishFill]),
            datalist,
        ]),
        /** 换服务、改地址、改默认音色后刷新。 */
        sync({ keepCustom = false } = {}) {
            renderRows();
            syncSelect({ keepCustom });
        },
    };
}

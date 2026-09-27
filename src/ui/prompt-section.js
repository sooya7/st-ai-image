/**
 * 各功能页底部的「AI 自动标签」区块：注入开关 + 系统提示词（默认折叠）。
 * 图片、配音、视频各在自己的页里放一份，只读写自己的开关和提示词，其余设置归各页管。
 */
import { DEFAULT_SYSTEM_PROMPT } from '../core/constants.js';
import { registerSystemPrompt } from '../inline/scanner.js';
import { MEDIA_DEFAULTS, readMediaSettings } from '../media/media-settings.js';
import { getSettings, saveSettings } from '../settings.js';
import { debounce, el } from './dom.js';

/** 图片设置是扁平字段，语音/视频是分区对象，这里抹平成同一套读写。 */
const SECTIONS = {
    image: {
        title: 'AI 自动出图', tag: '[image]画面描述[/image]',
        read: (s) => ({ autoInject: Boolean(s.autoInjectPrompt), prompt: String(s.systemPrompt ?? '') }),
        write: (s, { autoInject, prompt }) => ({ ...s, autoInjectPrompt: autoInject, systemPrompt: prompt }),
        fallback: DEFAULT_SYSTEM_PROMPT,
    },
    ...Object.fromEntries([['speech', 'AI 自动配音', '[voice]台词[/voice]'], ['video', 'AI 自动视频', '[video]画面描述[/video]']].map(([id, title, tag]) => [id, {
        title, tag,
        read: (s) => { const m = readMediaSettings(s, id); return { autoInject: m.autoInject, prompt: m.prompt }; },
        write: (s, patch) => ({ ...s, [id]: { ...readMediaSettings(s, id), ...patch } }),
        fallback: MEDIA_DEFAULTS[id].prompt,
        hint: id === 'speech' ? '提示词里的 {{音色类型}} 会换成上面音色预设表里已经填了音色的类型名。' : '',
    }])),
};

async function update(section, patch) {
    const current = await getSettings();
    await saveSettings(section.write(current, { ...section.read(current), ...patch }));
    registerSystemPrompt();
}

/** @param {'image'|'speech'|'video'} id */
export function buildPromptSection(id, settings) {
    const section = SECTIONS[id];
    const eid = (name) => `st_ai_prompt_${id}_${name}`;
    const state = section.read(settings);
    const toggle = el('input', { type: 'checkbox', id: eid('auto_inject') });
    toggle.checked = state.autoInject;
    const text = el('textarea', { id: eid('text'), class: 'st_ai_textarea', rows: 8, 'aria-label': `${section.title}的系统提示词` });
    text.value = state.prompt;
    const saveText = debounce(() => update(section, { prompt: text.value }), 400);

    toggle.addEventListener('change', () => update(section, { autoInject: toggle.checked }));
    text.addEventListener('input', saveText);
    const reset = el('button', {
        type: 'button', id: eid('reset'), class: 'st_ai_btn', text: '恢复默认',
        onclick: () => { text.value = section.fallback; update(section, { prompt: section.fallback }); },
    });

    return el('section', { class: 'st_ai_prompt_section', dataset: { section: id } }, [
        el('h4', { class: 'st_ai_section_title', text: section.title }),
        el('label', { class: 'st_ai_checkbox' }, [toggle, el('span', { text: `让 AI 在回复里自己写 ${section.tag} 标签（注入系统提示词）` })]),
        el('details', { class: 'st_ai_prompt_details', id: eid('details') }, [
            el('summary', { text: '编辑提示词' }),
            el('div', { class: 'st_ai_field st_ai_prompt_textarea_field' }, [text]),
            el('div', { class: 'st_ai_inline_row st_ai_prompt_actions' }, [
                section.hint ? el('p', { class: 'st_ai_speech_hint st_ai_flex_fill', text: section.hint }) : el('span', { class: 'st_ai_flex_fill' }),
                reset,
            ]),
        ]),
    ]);
}

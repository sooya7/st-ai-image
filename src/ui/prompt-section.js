/**
 * 各功能页底部的「AI 自动标签」区块：注入开关 + 系统提示词（默认折叠）。
 * 图片、配音、视频各在自己的页里放一份，只读写自己的开关和提示词，其余设置归各页管。
 */
import { DEFAULT_SYSTEM_PROMPT } from '../core/constants.js';
import { registerSystemPrompt } from '../inline/scanner.js';
import { MEDIA_DEFAULTS, readMediaSettings } from '../media/media-settings.js';
import { getSettings, peekSettings, saveSettings } from '../settings.js';
import { promptProvider, readSectionPrompt, writeSectionPrompt } from '../media/prompt-profiles.js';
import { extensionPromptPlacement, PROMPT_DEPTH_MAX } from '../st/context.js';
import { cardHead, debounce, el } from './dom.js';

/** 图片设置是扁平字段，语音/视频是分区对象，这里抹平成同一套读写。 */
const SECTIONS = {
    image: {
        title: 'AI 自动出图', tag: '[image]画面描述[/image]',
        readToggle: (s) => Boolean(s.autoInjectPrompt),
        writeToggle: (s, on) => ({ ...s, autoInjectPrompt: on }),
        fallback: DEFAULT_SYSTEM_PROMPT,
    },
    ...Object.fromEntries([['speech', 'AI 自动配音', '[voice]台词[/voice]'], ['video', 'AI 自动视频', '[video]画面描述[/video]']].map(([id, title, tag]) => [id, {
        title, tag,
        readToggle: (s) => readMediaSettings(s, id).autoInject,
        writeToggle: (s, on) => ({ ...s, [id]: { ...readMediaSettings(s, id), autoInject: on } }),
        fallback: MEDIA_DEFAULTS[id].prompt,
        hint: id === 'speech' ? '提示词里的 {{音色类型}} 会换成上面音色预设表里已经填了音色的类型名。' : '',
    }])),
};

const mounted = {};
/** 换接口后调用：先把没存完的输入存进旧接口，再换成新接口那份提示词。 */
export const refreshPromptSection = (id) => mounted[id]?.refresh();
export const flushPromptSection = async (id) => mounted[id]?.flush();

async function saveToggle(section, on) {
    await saveSettings(section.writeToggle(await getSettings(), on));
    registerSystemPrompt();
}

async function savePrompt(id, provider, text) {
    await saveSettings(writeSectionPrompt(await getSettings(), id, provider, text));
    registerSystemPrompt();
}

/** @param {'image'|'speech'|'video'} id */
export function buildPromptSection(id, settings) {
    const section = SECTIONS[id];
    const eid = (name) => `st_ai_prompt_${id}_${name}`;
    const toggle = el('input', { type: 'checkbox', id: eid('auto_inject') });
    toggle.checked = section.readToggle(settings);
    const text = el('textarea', { id: eid('text'), class: 'st_ai_textarea', rows: 8, 'aria-label': `${section.title}的系统提示词` });
    const which = el('p', { class: 'st_ai_speech_hint', id: eid('provider_note') });
    const providerLabel = (s) => {
        const p = promptProvider(s, id);
        if (id === 'image') {
            const opt = document.querySelector(`#st_gpt_image_provider option[value="${CSS.escape(p)}"]`);
            return opt?.textContent?.trim() || p;
        }
        const opt = document.querySelector(`#st_ai_${id}_provider option[value="${CSS.escape(p)}"]`);
        return opt?.textContent?.trim() || p;
    };
    let pending = null;
    let timer = null;
    const flush = async () => {
        if (!pending) return;
        clearTimeout(timer);
        timer = null;
        const edit = pending;
        pending = null;
        await savePrompt(id, edit.provider, edit.text);
    };
    const refresh = () => {
        if (pending) return; // 还有没存的输入，先等 flush
        const s = peekSettings();
        text.value = readSectionPrompt(s, id);
        which.textContent = `当前接口：${providerLabel(s)}。提示词按接口分开保存，换接口会换成那个接口自己的一份（没改过的接口沿用原来的提示词）。`;
    };
    text.value = readSectionPrompt(settings, id);
    mounted[id] = { flush, refresh: async () => { await flush(); refresh(); registerSystemPrompt(); } };
    setTimeout(refresh, 0);
    text.addEventListener('input', () => {
        clearTimeout(timer);
        pending = { provider: promptProvider(peekSettings(), id), text: text.value };
        timer = setTimeout(flush, 400);
    });
    toggle.addEventListener('change', () => saveToggle(section, toggle.checked));
    const reset = el('button', {
        type: 'button', id: eid('reset'), class: 'st_ai_btn', text: '恢复默认',
        onclick: async () => {
            pending = null;
            clearTimeout(timer);
            text.value = section.fallback;
            await savePrompt(id, promptProvider(peekSettings(), id), section.fallback);
        },
    });

    // 注入位置三个功能共用一份设置，每页都放一份控件，改哪页都一样
    const where = el('select', { id: eid('position'), class: 'st_ai_select', 'aria-label': '提示词注入位置' }, [
        el('option', { value: 'chat', text: '聊天记录里（推荐）' }),
        el('option', { value: 'top', text: '系统提示词末尾' }),
    ]);
    where.value = settings.promptPosition === 'top' ? 'top' : 'chat';
    const depth = el('input', { type: 'number', id: eid('depth'), class: 'st_ai_input', min: 0, max: PROMPT_DEPTH_MAX, step: 1, 'aria-label': '注入深度' });
    depth.value = String(extensionPromptPlacement({ position: 'chat', depth: settings.promptDepth ?? 1 }).depth);
    const syncDepth = () => { depth.disabled = where.value === 'top'; };
    syncDepth();
    const savePlacement = async () => {
        syncDepth();
        const current = await getSettings();
        await saveSettings({ ...current, promptPosition: where.value, promptDepth: extensionPromptPlacement({ position: 'chat', depth: depth.value }).depth });
        registerSystemPrompt();
    };
    where.addEventListener('change', savePlacement);
    depth.addEventListener('change', savePlacement);

    return el('section', { class: 'st_ai_card st_ai_prompt_section', dataset: { section: id, tone: 'lemon' } }, [
        cardHead('fa-robot', section.title, '注入系统提示词，让 AI 在回复里自己写标签'),
        el('label', { class: 'st_ai_checkbox' }, [toggle, el('span', { text: `让 AI 在回复里自己写 ${section.tag} 标签（注入系统提示词）` })]),
        el('details', { class: 'st_ai_prompt_details', id: eid('details') }, [
            el('summary', { text: '编辑提示词' }),
            el('div', { class: 'st_ai_inline_row st_ai_prompt_placement' }, [
                el('span', { text: '注入位置' }), where,
                el('span', { text: '深度' }), depth,
            ]),
            el('p', { class: 'st_ai_speech_hint', text: '深度是离最后一条消息几条；AI 不写标签时把深度调小（0 = 最后）。图片、配音、视频共用这个设置。' }),
            which,
            el('div', { class: 'st_ai_field st_ai_prompt_textarea_field' }, [text]),
            el('div', { class: 'st_ai_inline_row st_ai_prompt_actions' }, [
                section.hint ? el('p', { class: 'st_ai_speech_hint st_ai_flex_fill', text: section.hint }) : el('span', { class: 'st_ai_flex_fill' }),
                reset,
            ]),
        ]),
    ]);
}

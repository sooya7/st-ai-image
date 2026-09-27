/**
 * 浮动面板的挂载：面板本体、预览层、降级横幅、魔杖菜单入口。
 * 面板只挂一次，之后只切 class——重建 DOM 会丢掉输入框里没提交的内容。
 */
import { EVENTS, on } from '../core/bus.js';
import { log } from '../core/notify.js';
import { bindDrag, resetDrag } from './drag.js';
import { el, qs } from './dom.js';
import { getSettings } from '../settings.js';
import { buildPromptSection } from './prompt-section.js';
import { bindSettingsForm } from './settings-view.js';
import { activateTab } from './tabs.js';
import { DIALOG_HTML, FALLBACK_BANNER_HTML, PANEL_HTML, PREVIEW_HTML, WAND_BUTTON_HTML, fromHtml } from './template.js';

/** 这些设置一改，注入给 AI 的系统提示词就要重算。 */
const PROMPT_KEYS = new Set(['enabled', 'preset']); // 提示词区块自己会重新注册

const panel = () => qs('#st_ai_float_panel');
const dialog = () => qs('#st_ai_dialog');

export const isPanelOpen = () => Boolean(dialog()?.open) && !panel()?.classList.contains('st_ai_hidden');

export function openPanel(tab) {
    const node = panel();
    node?.classList.remove('st_ai_hidden');
    resetDrag(node); // 上次拖到的位置不该影响这次打开
    const host = dialog();
    if (host && !host.open) {
        // showModal 在极少数宿主状态下会抛（比如已经有别的 modal），退化成普通显示
        try { host.showModal(); }
        catch (e) { log.warn('showModal 失败，退化成内联显示:', e); host.setAttribute('open', ''); }
    }
    mountImageLibraries();
    if (tab) activateTab(tab);
}

let librariesMounted = null;
/** 画师串和生图工作流库第一次打开面板时才加载（会用到工作流解析代码，不拖慢页面加载）。 */
function mountImageLibraries() {
    librariesMounted ||= (async () => {
        const [{ mountPromptPresets }, { createWorkflowLibrary }, { readWorkflowLibrary }, { getSettings, peekSettings, saveSettings }] = await Promise.all([
            import('./prompt-presets-view.js'), import('./workflow-library.js'), import('../core/library.js'), import('../settings.js'),
        ]);
        await getSettings();
        mountPromptPresets(qs('#st_ai_prompt_preset_panel'));
        const holder = qs('#st_ai_image_workflow_lib');
        if (holder && !holder.firstChild) {
            const lib = createWorkflowLibrary({
                id: 'st_ai_image_workflow',
                textarea: qs('#st_gpt_image_comfy_workflow'),
                status: qs('#st_gpt_image_comfy_status'),
                read: () => { const s = peekSettings(); return readWorkflowLibrary(s.comfyWorkflows, s.comfyWorkflowId, s.comfyWorkflow); },
                write: async ({ items, active }) => saveSettings({ ...(await getSettings()), comfyWorkflows: items, comfyWorkflowId: active }),
                exportName: 'st-ai-image-ComfyUI生图工作流.json',
            });
            holder.replaceChildren(lib.node);
        }
    })().catch((e) => { librariesMounted = null; log.warn('画师串/工作流库加载失败:', e); });
    return librariesMounted;
}

export function closePanel() {
    const host = dialog();
    if (host?.open) host.close();
    else host?.removeAttribute('open');
}

export function togglePanel() {
    if (isPanelOpen()) closePanel();
    else openPanel();
}

export function showFallbackBanner() {
    qs('#st_ai_fallback_banner')?.classList.remove('st_ai_hidden');
}

/** 优先进扩展菜单；菜单不存在（旧版/精简界面）就放一个浮动按钮兜底。 */
function mountLauncher() {
    if (qs('#st_ai_image_wand_button')) return true;
    const menu = qs('#extensionsMenu');
    if (menu) {
        const button = fromHtml(WAND_BUTTON_HTML);
        button.addEventListener('click', () => togglePanel());
        menu.append(button);
        return true;
    }
    log.warn('找不到 #extensionsMenu，改用浮动按钮');
    document.body.append(el('button', {
        type: 'button',
        id: 'st_ai_image_wand_button',
        class: 'st_ai_floating_launcher',
        title: 'AI 图片·语音·视频',
        'aria-label': 'AI 图片·语音·视频',
        onclick: () => togglePanel(),
    }, [el('i', { class: 'fa-solid fa-image' })]));
    return false;
}

/**
 * 挂载全部 UI 并绑定设置页。重复调用安全。
 * @param {{onPromptSettingChanged?: () => void}} [hooks]
 */
export async function mountPanel({ onPromptSettingChanged } = {}) {
    if (!panel()) {
        // 面板放进 dialog：top layer 渲染，不受宿主 transform / overflow 影响
        const host = fromHtml(DIALOG_HTML);
        host.append(fromHtml(PANEL_HTML));
        document.body.append(host);
    }
    if (!qs('#st_gpt_image_preview')) document.body.append(fromHtml(PREVIEW_HTML));
    if (!qs('#st_ai_fallback_banner')) document.body.append(fromHtml(FALLBACK_BANNER_HTML));

    qs('#st_ai_float_close')?.addEventListener('click', closePanel);
    // ESC 走 dialog 的 cancel：统一收口到 closePanel，别让 dialog 自己关一半
    dialog()?.addEventListener('cancel', (e) => { e.preventDefault(); closePanel(); });
    bindDrag(panel(), qs('.st_ai_float_header'));
    qs('#st_ai_fallback_banner_close')?.addEventListener('click', () => {
        qs('#st_ai_fallback_banner')?.classList.add('st_ai_hidden');
    });
    // 图库降级到 localStorage 时提示用户：手机端看不到 console
    on(EVENTS.storageDegraded, showFallbackBanner);

    mountLauncher();

    await bindSettingsForm((key) => {
        if (PROMPT_KEYS.has(key)) onPromptSettingChanged?.();
    });
    // 图片页底部的 AI 自动出图区块（配音/视频的在各自页里）
    const promptRoot = qs('#st_ai_image_prompt_panel');
    if (promptRoot && !promptRoot.firstChild) promptRoot.replaceChildren(buildPromptSection('image', await getSettings()));

    return panel();
}

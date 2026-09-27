/** 面板标签页切换。 */
import { qsa } from './dom.js';
import { refreshGalleryFromChat } from './gallery-view.js';

let mediaSettingsModule = null;
let promptsModule = null;
const MEDIA_TABS = { speech: 'st_ai_speech_panel', video: 'st_ai_video_panel' };

export async function activateTab(tab) {
    for (const btn of qsa('.st_ai_tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
    for (const panel of qsa('.st_ai_tab_content')) panel.classList.toggle('active', panel.dataset.tab === tab);
    if (tab === 'gallery') await refreshGalleryFromChat();
    if (tab === 'prompts') {
        const root = document.getElementById('st_ai_prompts_panel');
        try {
            promptsModule ||= import('./prompts-view.js');
            await (await promptsModule).mountPromptsView(root);
        } catch {
            promptsModule = null;
            if (root && !root.dataset.mounted) root.textContent = '提示词页加载失败，请切换标签页后重试。';
        }
    }
    if (MEDIA_TABS[tab]) {
        // 语音/视频设置页第一次打开才加载
        const root = document.getElementById(MEDIA_TABS[tab]);
        try {
            mediaSettingsModule ||= import('./media-settings-view.js');
            const { mountMediaSettings } = await mediaSettingsModule;
            await mountMediaSettings(root, tab);
        } catch {
            mediaSettingsModule = null;
            if (root && !root.dataset.mounted) root.textContent = '设置页加载失败，请切换标签页后重试。';
        }
    }
}

export function bindTabs() {
    for (const btn of qsa('.st_ai_tab')) {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    }
}

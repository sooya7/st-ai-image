/** 面板标签页切换。 */
import { qs, qsa } from './dom.js';
import { refreshGalleryFromChat } from './gallery-view.js';

let mediaSettingsModule = null;
const MEDIA_TABS = { speech: 'st_ai_speech_panel', video: 'st_ai_video_panel' };

/** 滑块移到选中的标签下面。面板隐藏时量不到尺寸，打开后再调一次。 */
export function syncTabIndicator() {
    const bar = qs('.st_ai_float_tabs');
    const indicator = bar?.querySelector('.st_ai_tab_indicator');
    const active = bar?.querySelector('.st_ai_tab.active');
    if (!indicator || !active || !active.offsetWidth) return;
    indicator.style.setProperty('--x', `${active.offsetLeft}px`);
    indicator.style.setProperty('--w', `${active.offsetWidth}px`);
    // 第一次定位不要从 0 滑过来；定好位的下一帧才开过渡
    if (!indicator.classList.contains('is-ready')) requestAnimationFrame(() => indicator.classList.add('is-ready'));
}

export async function activateTab(tab) {
    for (const btn of qsa('.st_ai_tab')) {
        btn.classList.toggle('active', btn.dataset.tab === tab);
        btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    }
    for (const panel of qsa('.st_ai_tab_content')) panel.classList.toggle('active', panel.dataset.tab === tab);
    syncTabIndicator();
    if (tab === 'gallery') await refreshGalleryFromChat();
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
    // 字体加载完、面板尺寸变了，标签宽度会变
    const bar = qs('.st_ai_float_tabs');
    if (bar && typeof ResizeObserver === 'function') new ResizeObserver(() => syncTabIndicator()).observe(bar);
}

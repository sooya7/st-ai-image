/** 面板标签页切换。 */
import { qsa } from './dom.js';
import { refreshGalleryFromChat } from './gallery-view.js';

export async function activateTab(tab) {
    for (const btn of qsa('.st_ai_tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
    for (const panel of qsa('.st_ai_tab_content')) panel.classList.toggle('active', panel.dataset.tab === tab);
    if (tab === 'gallery') await refreshGalleryFromChat();
}

export function bindTabs() {
    for (const btn of qsa('.st_ai_tab')) {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    }
}

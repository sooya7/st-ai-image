/** 图库列表渲染。图片走 IntersectionObserver 懒加载，200 条也不会一次性拉满带宽。 */
import { log, notify } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { clear, el, iconButton, qs, replaceContent, spinner } from './dom.js';
import { createImageActions } from './image-actions.js';
import { clearHistory, deleteHistoryItem, getHistory } from '../gallery/db.js';
import { syncChatImagesToHistory, syncRenderedChatImages } from '../gallery/sync.js';
import { showPreview } from './preview.js';

let observer = null;
let rendering = false;

function lazyImage(url, prompt) {
    const img = el('img', { alt: prompt, dataset: { src: url } });
    img.addEventListener('error', () => { img.alt = '加载失败'; });
    observer?.observe(img);
    return img;
}

function galleryItem(entry) {
    const url = sanitizeImageUrl(entry.imageUrl);
    if (!url) return null;
    const prompt = String(entry.prompt ?? '');
    const id = entry.id ?? '';
    const actions = el('div', { class: 'st_ai_gallery_actions' }, [
        ...createImageActions('gallery', { prompt, imageUrl: url, historyId: id }),
        iconButton({ iconName: 'fa-rotate', title: '重新生成', className: 'st_ai_btn st_gpt_regen', dataset: { id, prompt } }),
        iconButton({ iconName: 'fa-trash', title: '删除', className: 'st_ai_btn st_gpt_del', dataset: { id } }),
    ]);
    return el('div', { class: 'st_ai_gallery_item', dataset: { id, prompt } }, [lazyImage(url, prompt), actions]);
}

export async function renderGallery() {
    const container = qs('#st_gpt_image_history_list');
    if (!container || rendering) return;
    rendering = true;
    try {
        replaceContent(container, spinner('加载图库中...'));
        const history = await getHistory().catch((e) => { log.error('读取图库失败:', e); return []; });
        const count = qs('#st_gpt_gallery_count');
        if (count) count.textContent = `${history.length} 张图片`;

        if (!history.length) {
            replaceContent(container, el('div', { class: 'st_ai_image_empty', text: '暂无生成记录' }));
            return;
        }

        observer?.disconnect();
        observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                if (img.dataset.src && !img.src) img.src = img.dataset.src;
                observer.unobserve(img);
            }
        }, { rootMargin: '50px' });

        const items = history.map(galleryItem).filter(Boolean);
        clear(container);
        if (!items.length) {
            replaceContent(container, el('div', { class: 'st_ai_image_empty', text: '记录存在但无法渲染' }));
            log.warn(`图库 ${history.length} 条记录全部无法渲染`);
            return;
        }
        container.append(...items);
    } finally {
        rendering = false;
    }
}

/** 打开图库前先把聊天里的图补登记，再渲染。 */
export async function refreshGalleryFromChat() {
    try { await syncChatImagesToHistory(); }
    catch (e) { log.error('同步聊天图片失败:', e); }
    try { await syncRenderedChatImages(); }
    catch (e) { log.error('同步已渲染图片失败:', e); }
    await renderGallery();
}

/** 图库内的点击：看大图、删除、清空。重新生成由 index.js 处理（要跳到生图页）。 */
export function bindGalleryEvents() {
    const container = qs('#st_gpt_image_history_list');
    container?.addEventListener('click', async (e) => {
        const del = e.target.closest?.('.st_gpt_del');
        if (del) {
            e.stopPropagation();
            if (del.dataset.id) await deleteHistoryItem(del.dataset.id);
            return;
        }
        const img = e.target.closest?.('.st_ai_gallery_item img');
        if (img) showPreview(img.src || img.dataset.src, img.closest('.st_ai_gallery_item')?.dataset.prompt || '');
    });

    qs('#st_gpt_image_clear_history')?.addEventListener('click', async () => {
        if (!confirm('清空所有生成记录？')) return;
        await clearHistory();
        notify.success('图库已清空');
    });
}

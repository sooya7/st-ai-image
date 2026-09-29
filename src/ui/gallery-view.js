/** 图片、语音、视频共用的生成记录；图片懒加载，媒体文件只在播放时加载。 */
import { log, notify } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { sanitizeMediaSrc } from '../media/tags.js';
import { clear, el, icon, iconButton, qs, replaceContent, spinner } from './dom.js';
import { createImageActions } from './image-actions.js';
import { getHistory, getLegacyHistory } from '../gallery/chat-store.js';
import { removeMediaEntry } from '../gallery/delete.js';
import { syncChatImagesToHistory } from '../gallery/sync.js';
import { getCurrentChatId } from '../st/context.js';
import { showMediaPreview, showPreview } from './preview.js';

let observer = null;
let rendering = false;
let renderPending = false;
let clearing = false;
let activeKind = 'all';

function lazyImage(url, prompt) {
    const img = el('img', { alt: prompt, dataset: { src: url } });
    img.addEventListener('error', () => { img.alt = '加载失败'; });
    observer?.observe(img);
    return img;
}

function galleryItem(entry) {
    if (entry.type === 'audio' || entry.type === 'video') {
        const src = sanitizeMediaSrc(entry.mediaUrl);
        if (!src || !src.startsWith(`/user/files/st-ai-${entry.type}-`)) return null;
        const label = entry.type === 'audio' ? '语音' : '视频';
        const prompt = String(entry.prompt ?? '');
        const actions = el('div', { class: 'st_ai_gallery_actions' }, [
            el('a', { class: 'st_ai_btn', href: src, download: src.split('/').pop(), title: `下载${label}`, 'aria-label': `下载${label}` }, [icon('fa-download')]),
            iconButton({ iconName: 'fa-trash', title: '删除记录', className: 'st_ai_btn st_gpt_del', dataset: { id: entry.id ?? '' } }),
        ]);
        return el('div', { class: 'st_ai_gallery_item st_ai_gallery_media', dataset: { id: entry.id ?? '', kind: entry.type, src, prompt } }, [
            el('span', { class: 'st_ai_gallery_media_badge', text: label }),
            el('button', { type: 'button', class: 'st_ai_gallery_media_open', title: `预览${label}` }, [
                icon(entry.type === 'audio' ? 'fa-volume-high' : 'fa-circle-play'),
                el('span', { class: 'st_ai_gallery_media_title', text: prompt || label }),
            ]),
            entry.type === 'audio' ? el('audio', { controls: true, preload: 'none', src }) : null,
            actions,
        ]);
    }
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
    if (!container) return;
    if (rendering) { renderPending = true; return; }
    rendering = true;
    const chatId = getCurrentChatId();
    const kind = activeKind;
    try {
        replaceContent(container, spinner('加载媒体库中...'));
        const history = await (kind === 'legacy' ? getLegacyHistory() : getHistory()).catch((e) => { log.error('读取媒体库失败:', e); return []; });
        if (chatId !== getCurrentChatId() || kind !== activeKind) { renderPending = true; return; }
        const count = qs('#st_gpt_gallery_count');
        if (count) count.textContent = `${kind === 'legacy' ? '旧版未归属' : '当前聊天'} · ${history.length} 个媒体`;
        const clearButton = qs('#st_gpt_image_clear_history');
        if (clearButton) clearButton.disabled = kind === 'legacy' || clearing;

        const filtered = kind === 'all' || kind === 'legacy' ? history : history.filter((item) => item.type === kind);
        if (!filtered.length) {
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

        const items = filtered.map(galleryItem).filter(Boolean);
        clear(container);
        if (!items.length) {
            replaceContent(container, el('div', { class: 'st_ai_image_empty', text: '记录存在但无法渲染' }));
            log.warn(`媒体库 ${filtered.length} 条记录全部无法渲染`);
            return;
        }
        container.append(...items);
    } finally {
        rendering = false;
        if (renderPending) { renderPending = false; queueMicrotask(renderGallery); }
    }
}

/** 当前聊天正文有已生成媒体但索引缺失时，批量补齐。 */
export async function refreshGalleryFromChat() {
    try { await syncChatImagesToHistory(); }
    catch (e) { log.error('同步聊天媒体失败:', e); }
    await renderGallery();
}

/** 媒体库内的点击：看大图、删除、清空。重新生成由 index.js 处理（要跳到生图页）。 */
export function bindGalleryEvents() {
    const container = qs('#st_gpt_image_history_list');
    for (const filter of document.querySelectorAll('.st_ai_gallery_filter')) {
        filter.addEventListener('click', () => {
            activeKind = filter.dataset.kind || 'all';
            for (const button of document.querySelectorAll('.st_ai_gallery_filter')) button.classList.toggle('active', button === filter);
            renderGallery();
        });
    }
    container?.addEventListener('click', async (e) => {
        const del = e.target.closest?.('.st_gpt_del');
        if (del) {
            e.stopPropagation();
            if (!del.dataset.id) return;
            if (!confirm('删除这项媒体及本扩展上传的服务器文件？当前聊天中的引用会移除；其他聊天若引用同一文件也可能无法播放。')) return;
            del.disabled = true;
            try {
                const { removed, fileDeleted } = await removeMediaEntry(del.dataset.id);
                if (!removed) notify.error('删除失败，请重试');
                else notify.success(fileDeleted ? '媒体和服务器文件已删除' : '媒体库记录已删除（外部文件未删除）');
            } catch (error) { notify.error(`删除失败：${error?.message || error}`); }
            finally { del.disabled = false; }
            return;
        }
        const img = e.target.closest?.('.st_ai_gallery_item img');
        if (img) showPreview(img.src || img.dataset.src, img.closest('.st_ai_gallery_item')?.dataset.prompt || '');
        const open = e.target.closest?.('.st_ai_gallery_media_open');
        if (open) {
            const item = open.closest('.st_ai_gallery_media');
            showMediaPreview(item?.dataset.src, item?.dataset.kind, item?.dataset.prompt);
        }
    });

    qs('#st_gpt_image_clear_history')?.addEventListener('click', async () => {
        if (activeKind === 'legacy' || clearing) return;
        if (!confirm('清空当前聊天的媒体库并删除本扩展上传的服务器文件？其他聊天引用这些文件时也可能无法播放。')) return;
        const button = qs('#st_gpt_image_clear_history');
        clearing = true;
        button.disabled = true;
        const history = await getHistory();
        let removed = 0;
        try {
            for (const item of history) {
                button.textContent = `清理中 ${removed + 1}/${history.length}`;
                if ((await removeMediaEntry(item.id)).removed) removed++;
            }
            notify.success(`已清理 ${removed} 个媒体`);
        } catch (error) { notify.error(`已清理 ${removed} 个，后续清理失败：${error?.message || error}`); }
        finally { clearing = false; button.disabled = false; button.textContent = '清空'; await renderGallery(); }
    });
}

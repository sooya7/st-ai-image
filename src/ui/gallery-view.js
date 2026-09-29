/** 图片、语音、视频共用的生成记录；图片懒加载，媒体文件只在播放时加载。 */
import { log, notify } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { sanitizeMediaSrc } from '../media/tags.js';
import { clear, el, icon, iconButton, qs, replaceContent, spinner } from './dom.js';
import { hueOf, paintWave, waveBars } from './fx.js';
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

const KIND_LABEL = { audio: '语音', video: '视频' };

function lazyImage(url, prompt) {
    const img = el('img', { alt: prompt, decoding: 'async', dataset: { src: url } });
    img.addEventListener('error', () => { img.alt = '加载失败'; });
    observer?.observe(img);
    return img;
}

function mediaItem(entry, index) {
    const kind = entry.type;
    const src = sanitizeMediaSrc(entry.mediaUrl);
    if (!src || !src.startsWith(`/user/files/st-ai-${kind}-`)) return null;
    const label = KIND_LABEL[kind];
    const prompt = String(entry.prompt ?? '');
    const audio = kind === 'audio';
    const actions = el('div', { class: 'st_ai_gallery_actions' }, [
        el('a', { class: 'st_ai_btn', href: src, download: src.split('/').pop(), title: `下载${label}`, 'aria-label': `下载${label}` }, [icon('fa-download')]),
        iconButton({ iconName: 'fa-trash', title: '删除记录', className: 'st_ai_btn st_gpt_del', dataset: { id: entry.id ?? '' } }),
    ]);
    return el('div', {
        class: 'st_ai_gallery_item st_ai_gallery_media',
        dataset: { id: entry.id ?? '', kind, src, prompt },
        style: { '--st-ai-hue': hueOf(prompt || src), '--i': index },
    }, [
        el('span', { class: 'st_ai_gallery_media_badge' }, [icon(audio ? 'fa-microphone-lines' : 'fa-clapperboard'), label]),
        el('button', { type: 'button', class: 'st_ai_gallery_media_open', title: `预览${label}` }, [
            audio ? waveBars(prompt || src, 26, 'st_ai_gallery_wave') : el('span', { class: 'st_ai_gallery_media_glyph' }, [icon('fa-play')]),
            el('span', { class: 'st_ai_gallery_media_title', text: prompt || label }),
        ]),
        // 语音直接在卡片上播：没有 controls 的 <audio> 不显示，也不预读
        audio ? el('button', { type: 'button', class: 'st_ai_gallery_play', title: '播放', 'aria-label': '播放语音' }, [icon('fa-play')]) : null,
        audio ? el('audio', { preload: 'none', src }) : null,
        actions,
    ]);
}

function galleryItem(entry, index) {
    if (entry.type === 'audio' || entry.type === 'video') return mediaItem(entry, index);
    const url = sanitizeImageUrl(entry.imageUrl);
    if (!url) return null;
    const prompt = String(entry.prompt ?? '');
    const id = entry.id ?? '';
    const actions = el('div', { class: 'st_ai_gallery_actions' }, [
        ...createImageActions('gallery', { prompt, imageUrl: url, historyId: id }),
        iconButton({ iconName: 'fa-rotate', title: '重新生成', className: 'st_ai_btn st_gpt_regen', dataset: { id, prompt } }),
        iconButton({ iconName: 'fa-trash', title: '删除', className: 'st_ai_btn st_gpt_del', dataset: { id } }),
    ]);
    return el('div', { class: 'st_ai_gallery_item', dataset: { id, prompt }, style: { '--i': index } }, [
        lazyImage(url, prompt),
        prompt ? el('span', { class: 'st_ai_gallery_caption', text: prompt }) : null,
        actions,
    ]);
}

/** 筛选按钮上的数量（旧版未归属不算，它是另一份列表）。 */
function paintCounts(history) {
    const counts = { all: history.length, image: 0, video: 0, audio: 0 };
    for (const item of history) if (counts[item.type] !== undefined) counts[item.type]++;
    for (const filter of document.querySelectorAll('.st_ai_gallery_filter')) {
        const badge = filter.querySelector('.st_ai_filter_count');
        if (badge) badge.textContent = counts[filter.dataset.kind] ? String(counts[filter.dataset.kind]) : '';
    }
}

function emptyState(kind) {
    return el('div', { class: 'st_ai_image_empty' }, [
        kind === 'legacy' ? '没有旧版未归属的记录' : '暂无生成记录',
        kind === 'legacy' ? null : el('span', { class: 'st_ai_empty_hint', text: '在聊天里点「生成图片」「配音」「生成视频」，作品会收进这里' }),
    ]);
}

export async function renderGallery() {
    const container = qs('#st_gpt_image_history_list');
    if (!container) return;
    if (rendering) { renderPending = true; return; }
    rendering = true;
    const chatId = getCurrentChatId();
    const kind = activeKind;
    try {
        stopGalleryAudio();
        replaceContent(container, spinner('加载媒体库中...'));
        container.classList.remove('st_ai_bento');
        const history = await (kind === 'legacy' ? getLegacyHistory() : getHistory()).catch((e) => { log.error('读取媒体库失败:', e); return []; });
        if (chatId !== getCurrentChatId() || kind !== activeKind) { renderPending = true; return; }
        const count = qs('#st_gpt_gallery_count');
        if (count) count.textContent = `${kind === 'legacy' ? '旧版未归属' : '当前聊天'} · ${history.length} 个媒体`;
        if (kind !== 'legacy') paintCounts(history);
        const clearButton = qs('#st_gpt_image_clear_history');
        if (clearButton) clearButton.disabled = kind === 'legacy' || clearing;

        const filtered = kind === 'all' || kind === 'legacy' ? history : history.filter((item) => item.type === kind);
        if (!filtered.length) {
            replaceContent(container, emptyState(kind));
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
        // 三项以上、最新一项是图片或视频时，把它放大成 2×2
        container.classList.toggle('st_ai_bento', items.length >= 3 && items[0].dataset.kind !== 'audio');
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

/* ---------- 卡片上的语音播放：同一时间一条，进度点亮声波 ---------- */
let galleryPlaying = null; // { item, audio, frame }

function stopGalleryAudio() {
    if (!galleryPlaying) return;
    const { item, audio, frame } = galleryPlaying;
    galleryPlaying = null;
    cancelAnimationFrame(frame);
    audio.pause();
    item.classList.remove('is-playing');
    item.querySelector('.st_ai_gallery_play')?.replaceChildren(icon('fa-play'));
    paintWave(item.querySelector('.st_ai_gallery_wave'), 0);
}

function toggleGalleryAudio(item) {
    if (galleryPlaying?.item === item) return stopGalleryAudio();
    stopGalleryAudio();
    const audio = item.querySelector('audio');
    if (!audio) return;
    const wave = item.querySelector('.st_ai_gallery_wave');
    galleryPlaying = { item, audio, frame: 0 };
    item.classList.add('is-playing');
    item.querySelector('.st_ai_gallery_play')?.replaceChildren(icon('fa-pause'));
    const tick = () => {
        if (galleryPlaying?.audio !== audio) return;
        paintWave(wave, audio.duration ? audio.currentTime / audio.duration : 0);
        galleryPlaying.frame = requestAnimationFrame(tick);
    };
    galleryPlaying.frame = requestAnimationFrame(tick);
    audio.addEventListener('ended', () => { if (galleryPlaying?.audio === audio) { audio.currentTime = 0; stopGalleryAudio(); } }, { once: true });
    audio.play().catch((error) => {
        if (error?.name === 'AbortError') return;
        stopGalleryAudio();
        notify.error('语音文件不存在或无法播放');
    });
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
    // 面板关了，卡片上的语音也停
    qs('#st_ai_dialog')?.addEventListener('close', stopGalleryAudio);
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
        const play = e.target.closest?.('.st_ai_gallery_play');
        if (play) {
            e.stopPropagation();
            toggleGalleryAudio(play.closest('.st_ai_gallery_media'));
            return;
        }
        const img = e.target.closest?.('.st_ai_gallery_item img');
        if (img) showPreview(img.src || img.dataset.src, img.closest('.st_ai_gallery_item')?.dataset.prompt || '', { from: img });
        const open = e.target.closest?.('.st_ai_gallery_media_open');
        if (open) {
            const item = open.closest('.st_ai_gallery_media');
            stopGalleryAudio();
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
        finally { clearing = false; button.disabled = false; button.replaceChildren(icon('fa-trash'), ' 清空'); await renderGallery(); }
    });
}

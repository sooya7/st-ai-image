/** 大图预览与提示词编辑，共用同一个覆盖层 #st_gpt_image_preview。 */
import { errMsg, notify } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { sanitizeMediaSrc } from '../media/tags.js';
import { updateHistoryItemPrompt } from '../gallery/chat-store.js';
import { el, icon, iconButton, qs, replaceContent } from './dom.js';
import { hueOf, paintWave, waveBars } from './fx.js';

let closeCurrent = null;
const EASE = 'cubic-bezier(.16, 1, .3, 1)';

/** 打开覆盖层：先关掉上一个，再绑 ESC 与点击背景关闭。nodes 依次放进覆盖层。 */
function openOverlay(nodes, { onClose, onKey, isBackdrop } = {}) {
    closeCurrent?.();
    const overlay = qs('#st_gpt_image_preview');
    if (!overlay) return null;

    const close = () => {
        overlay.classList.remove('st_gpt_preview_visible');
        overlay.textContent = '';
        document.removeEventListener('keydown', onKeyDown);
        overlay.removeEventListener('click', onBackdrop);
        overlay.removeEventListener('cancel', onCancel);
        if (overlay.open) overlay.close();
        else overlay.removeAttribute('open');
        closeCurrent = null;
        onClose?.();
    };
    const onKeyDown = (e) => {
        if (e.key === 'Escape') close();
        else onKey?.(e);
    };
    const onBackdrop = (e) => { if (e.target === overlay || isBackdrop?.(e.target)) close(); };
    const onCancel = (e) => { e.preventDefault(); close(); };

    replaceContent(overlay, ...[].concat(nodes));
    // 预览层也是 dialog：后开的 modal 在 top layer 更上层，才能盖住面板
    if (typeof overlay.showModal === 'function' && !overlay.open) {
        try { overlay.showModal(); }
        catch { overlay.setAttribute('open', ''); }
    }
    // 下一帧再加可见类，淡入过渡才有起点；这一帧里已经被关掉就不加
    requestAnimationFrame(() => { if (closeCurrent === close) overlay.classList.add('st_gpt_preview_visible'); });
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', onBackdrop);
    overlay.addEventListener('cancel', onCancel);
    closeCurrent = close;
    return close;
}

const header = (title, iconName, buttons) => el('div', { class: 'st_gpt_preview_header' }, [
    el('span', { class: 'st_gpt_preview_title' }, [iconName ? icon(iconName) : null, title]),
    el('div', { class: 'st_ai_action_row' }, buttons),
]);

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // 非安全上下文（局域网 http）没有 clipboard API，退回老办法
        const area = el('textarea', { style: { position: 'fixed', opacity: '0' } });
        area.value = text;
        document.body.append(area);
        area.select();
        document.execCommand?.('copy');
        area.remove();
    }
    notify.success('提示词已复制');
}

export function downloadImage(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) return notify.error('图片地址无效，无法下载');
    const a = el('a', { href: safeUrl, download: `ai-image-${Date.now()}.png` });
    document.body.append(a);
    a.click();
    a.remove();
}

/**
 * 缩放与平移：滚轮以指针为中心缩放，双击 1× ↔ 2.2×，拖动平移，双指捏合；+ - 0 键。
 * 图片 transform-origin 是左上角，这样「指针下的那一点不动」算起来最直接。
 */
function zoomable(stage, img, badge) {
    let scale = 1;
    let x = 0;
    let y = 0;
    let badgeTimer = null;
    const apply = (animate) => {
        stage.classList.toggle('is-zoomed', scale > 1.01);
        img.style.transition = animate ? `transform .35s ${EASE}` : 'none';
        img.style.transform = scale > 1.001 ? `translate(${x}px, ${y}px) scale(${scale})` : '';
    };
    const flash = () => {
        badge.textContent = `${Math.round(scale * 100)}%`;
        badge.classList.add('is-visible');
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => badge.classList.remove('is-visible'), 700);
    };
    const zoomAt = (next, px, py, animate = false) => {
        const target = Math.min(6, Math.max(1, next));
        const rect = img.getBoundingClientRect();
        const localX = (px - rect.left) / scale;
        const localY = (py - rect.top) / scale;
        const baseLeft = rect.left - x;
        const baseTop = rect.top - y;
        scale = target;
        x = scale === 1 ? 0 : px - localX * scale - baseLeft;
        y = scale === 1 ? 0 : py - localY * scale - baseTop;
        apply(animate);
        flash();
    };
    const center = () => {
        const rect = img.getBoundingClientRect();
        return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    };

    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        zoomAt(scale * Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
    }, { passive: false });
    // 拖动用了指针捕获，双击事件落在舞台上而不是图片上，所以挂在舞台
    stage.addEventListener('dblclick', (e) => zoomAt(scale > 1.01 ? 1 : 2.2, e.clientX, e.clientY, true));

    const pointers = new Map();
    let last = null;
    let pinch = null;
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
    stage.addEventListener('pointerdown', (e) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        stage.setPointerCapture?.(e.pointerId);
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { distance: distance(a, b), scale, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        } else last = { x: e.clientX, y: e.clientY };
    });
    stage.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            zoomAt(pinch.scale * distance(a, b) / pinch.distance, pinch.cx, pinch.cy);
            return;
        }
        if (scale > 1.01 && last) {
            x += e.clientX - last.x;
            y += e.clientY - last.y;
            last = { x: e.clientX, y: e.clientY };
            stage.classList.add('is-panning');
            apply(false);
        }
    });
    const release = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (!pointers.size) { last = null; stage.classList.remove('is-panning'); }
    };
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);

    return {
        key(e) {
            if (e.key === '+' || e.key === '=') zoomAt(scale * 1.4, ...center(), true);
            else if (e.key === '-' || e.key === '_') zoomAt(scale / 1.4, ...center(), true);
            else if (e.key === '0') zoomAt(1, ...center(), true);
        },
        dispose: () => clearTimeout(badgeTimer),
    };
}

/** 从缩略图的位置放大到预览位置（FLIP），缩略图不在屏幕上就只淡入。 */
function flipFrom(from, img) {
    if (!from?.isConnected || typeof img.animate !== 'function') return;
    const run = () => {
        const a = from.getBoundingClientRect();
        const b = img.getBoundingClientRect();
        if (!a.width || !b.width || a.bottom < 0 || a.top > innerHeight) return;
        const s = Math.min(a.width / b.width, a.height / b.height);
        const dx = a.left + a.width / 2 - (b.left + b.width / 2);
        const dy = a.top + a.height / 2 - (b.top + b.height / 2);
        img.animate([
            { transformOrigin: '50% 50%', transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0.35 },
            { transformOrigin: '50% 50%', transform: 'none', opacity: 1 },
        ], { duration: 560, easing: EASE });
    };
    if (img.complete && img.naturalWidth) requestAnimationFrame(run);
    else img.addEventListener('load', () => requestAnimationFrame(run), { once: true });
}

/**
 * @param {string} imageUrl
 * @param {string} [prompt]
 * @param {{from?: Element}} [options] from：被点的缩略图，用来做放大过渡
 */
export function showPreview(imageUrl, prompt = '', { from } = {}) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) return notify.error('图片地址无效，无法预览');

    const closeBtn = iconButton({ iconName: 'fa-xmark', title: '关闭预览' });
    const downloadBtn = iconButton({ iconName: 'fa-download', title: '下载图片', dataset: { url: safeUrl } });
    const img = el('img', { src: safeUrl, class: 'st_gpt_preview_img', alt: prompt, draggable: 'false' });
    const stage = el('div', { class: 'st_ai_lightbox_stage' }, [img]);
    const badge = el('div', { class: 'st_ai_lightbox_zoom', 'aria-hidden': 'true' });
    const text = el('p', { text: prompt, title: '点一下展开 / 收起' });
    const copyBtn = iconButton({ iconName: 'fa-copy', title: '复制提示词' });
    const caption = prompt ? el('div', { class: 'st_ai_lightbox_caption' }, [text, copyBtn]) : null;
    // 打开时焦点落在预览层本身（autofocus），不在第一个按钮上画焦点框
    const content = el('div', { class: 'st_gpt_preview_content st_ai_lightbox', tabindex: '-1', autofocus: true }, [
        header('图片预览', 'fa-image', [downloadBtn, closeBtn]),
        stage,
        caption,
        badge,
    ]);
    // 氛围光：同一张图放大、重度模糊，垫在最底下，颜色随画面
    const ambient = el('img', { class: 'st_ai_lightbox_ambient', src: safeUrl, alt: '', 'aria-hidden': 'true' });
    const zoom = zoomable(stage, img, badge);
    const close = openOverlay([ambient, content], {
        onKey: (e) => zoom.key(e),
        onClose: () => zoom.dispose(),
        isBackdrop: (target) => target === content,
    });
    flipFrom(from, img);
    downloadBtn.addEventListener('click', () => downloadImage(safeUrl));
    closeBtn.addEventListener('click', () => close?.());
    text.addEventListener('click', () => caption.classList.toggle('is-open'));
    copyBtn.addEventListener('click', () => copyText(prompt));
}

export function showMediaPreview(mediaUrl, kind, prompt = '') {
    const src = sanitizeMediaSrc(mediaUrl);
    if (!['audio', 'video'].includes(kind) || !src.startsWith(`/user/files/st-ai-${kind}-`)) return notify.error('媒体地址无效，无法预览');
    const label = kind === 'audio' ? '语音' : '视频';
    const closeBtn = iconButton({ iconName: 'fa-xmark', title: '关闭预览' });
    const download = el('a', { href: src, download: src.split('/').pop(), class: 'st_ai_btn', title: `下载${label}`, 'aria-label': `下载${label}` }, [icon('fa-download')]);
    const player = el(kind === 'audio' ? 'audio' : 'video', { src, controls: true, preload: 'metadata', playsinline: true, class: 'st_ai_media_preview_player' });
    let body;
    if (kind === 'audio') {
        // 正在播放卡片：声波随进度点亮、播放时跳动
        const wave = waveBars(prompt || src, 48, 'st_ai_gallery_wave');
        body = el('div', { class: 'st_ai_now_playing', style: { '--st-ai-hue': hueOf(prompt || src) } }, [
            wave,
            prompt ? el('div', { class: 'st_ai_media_preview_text', text: prompt }) : null,
            player,
        ]);
        player.addEventListener('play', () => body.classList.add('is-playing'));
        player.addEventListener('pause', () => body.classList.remove('is-playing'));
        player.addEventListener('timeupdate', () => paintWave(wave, player.duration ? player.currentTime / player.duration : 0));
    } else {
        body = el('div', { class: 'st_ai_media_preview_stage' }, [player, prompt ? el('div', { class: 'st_ai_media_preview_text', text: prompt }) : null]);
    }
    const content = el('div', { class: 'st_gpt_preview_content st_ai_lightbox', tabindex: '-1', autofocus: true }, [header(`${label}预览`, kind === 'audio' ? 'fa-microphone-lines' : 'fa-clapperboard', [download, closeBtn]), body]);
    const close = openOverlay([content], { onClose: () => player.pause(), isBackdrop: (target) => target === content });
    closeBtn.addEventListener('click', () => close?.());
    player.play?.().catch(() => { /* 浏览器不让自动播，就等用户点 */ });
}

/**
 * 提示词编辑框。onSave 收到新提示词，负责把改动落到调用方自己的场景
 * （媒体库条目 / 正文内联图）；historyId 存在时这里顺手更新媒体库记录。
 */
export function showPromptEditor({ prompt = '', imageUrl = '', historyId = null, onSave } = {}) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    const closeBtn = iconButton({ iconName: 'fa-xmark', title: '关闭' });
    const textarea = el('textarea', {
        class: 'st_ai_textarea st_ai_edit_textarea',
        rows: 5,
        placeholder: '输入提示词...',
    });
    textarea.value = String(prompt || '');

    const saveBtn = el('button', { type: 'button', class: 'st_ai_btn_primary st_ai_edit_save', title: '保存提示词' }, [
        el('i', { class: 'fa-solid fa-floppy-disk' }), ' 保存',
    ]);

    const content = el('div', { class: 'st_gpt_preview_content st_ai_edit_content' }, [
        header('编辑提示词', 'fa-pen', [closeBtn]),
        safeUrl ? el('img', { src: safeUrl, class: 'st_ai_edit_thumb', alt: '预览' }) : null,
        textarea,
        el('div', { class: 'st_ai_edit_actions' }, [el('span', { class: 'st_ai_edit_hint', text: 'Ctrl / ⌘ + Enter 保存' }), saveBtn]),
    ]);

    const close = openOverlay([content]);
    closeBtn.addEventListener('click', () => close?.());
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const save = async () => {
        const next = textarea.value.trim();
        if (!next) return notify.warn('提示词不能为空');
        saveBtn.disabled = true;
        try {
            // 媒体库更新失败不阻断：正文/DOM 的更新才是用户看得见的部分
            if (historyId) await updateHistoryItemPrompt(historyId, next);
            await onSave?.(next);
            notify.success('提示词已保存');
            close?.();
        } catch (e) {
            saveBtn.disabled = false;
            notify.error(`保存失败: ${errMsg(e)}`);
        }
    };

    saveBtn.addEventListener('click', save);
    textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });
}

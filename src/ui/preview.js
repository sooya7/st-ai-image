/** 大图预览与提示词编辑，共用同一个覆盖层 #st_gpt_image_preview。 */
import { errMsg, notify } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { updateHistoryItemPrompt } from '../gallery/db.js';
import { el, iconButton, qs, replaceContent } from './dom.js';

let closeCurrent = null;

/** 打开覆盖层：先关掉上一个，再绑 ESC 与点击背景关闭。 */
function openOverlay(content, { onClose } = {}) {
    closeCurrent?.();
    const overlay = qs('#st_gpt_image_preview');
    if (!overlay) return null;

    const close = () => {
        overlay.classList.remove('st_gpt_preview_visible');
        overlay.textContent = '';
        document.removeEventListener('keydown', onKeyDown);
        overlay.removeEventListener('click', onBackdrop);
        closeCurrent = null;
        onClose?.();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') close(); };
    const onBackdrop = (e) => { if (e.target === overlay) close(); };

    replaceContent(overlay, content);
    overlay.classList.add('st_gpt_preview_visible');
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', onBackdrop);
    closeCurrent = close;
    return close;
}

const header = (title, buttons) => el('div', { class: 'st_gpt_preview_header' }, [
    el('span', { class: 'st_gpt_preview_title', text: title }),
    el('div', { class: 'st_ai_action_row' }, buttons),
]);

export function downloadImage(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) return notify.error('图片地址无效，无法下载');
    const a = el('a', { href: safeUrl, download: `ai-image-${Date.now()}.png` });
    document.body.append(a);
    a.click();
    a.remove();
}

export function showPreview(imageUrl, prompt = '') {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) return notify.error('图片地址无效，无法预览');

    const closeBtn = iconButton({ iconName: 'fa-xmark', title: '关闭预览' });
    const content = el('div', { class: 'st_gpt_preview_content' }, [
        header('图片预览', [
            iconButton({ iconName: 'fa-download', title: '下载图片', dataset: { url: safeUrl } }),
            closeBtn,
        ]),
        el('img', { src: safeUrl, class: 'st_gpt_preview_img', alt: prompt }),
    ]);
    const close = openOverlay(content);
    content.querySelector('[data-url]')?.addEventListener('click', () => downloadImage(safeUrl));
    closeBtn.addEventListener('click', () => close?.());
}

/**
 * 提示词编辑框。onSave 收到新提示词，负责把改动落到调用方自己的场景
 * （图库条目 / 正文内联图）；historyId 存在时这里顺手更新图库记录。
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

    const saveBtn = el('button', { type: 'button', class: 'st_gpt_image_btn st_ai_edit_save', title: '保存提示词' }, [
        el('i', { class: 'fa-solid fa-floppy-disk' }), ' 保存',
    ]);

    const content = el('div', { class: 'st_gpt_preview_content st_ai_edit_content' }, [
        header('编辑提示词', [closeBtn]),
        safeUrl ? el('img', { src: safeUrl, class: 'st_gpt_preview_img st_ai_edit_thumb', alt: '预览' }) : null,
        textarea,
        el('div', { class: 'st_ai_edit_actions' }, [saveBtn]),
    ]);

    const close = openOverlay(content);
    closeBtn.addEventListener('click', () => close?.());
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const save = async () => {
        const next = textarea.value.trim();
        if (!next) return notify.warn('提示词不能为空');
        saveBtn.disabled = true;
        try {
            // 图库更新失败不阻断：正文/DOM 的更新才是用户看得见的部分
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

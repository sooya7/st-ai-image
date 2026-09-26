/**
 * 图片操作按钮组。三处复用：生图结果、图库条目、正文内联图。
 * 按钮只写 dataset，真正的处理逻辑挂在 index.js 的全局委托上。
 */
import { sanitizeImageUrl } from '../core/text.js';
import { el, iconButton } from './dom.js';

export const ACTION = {
    download: 'download-image',
    save: 'save-image',
    view: 'view-gallery',
    edit: 'edit-prompt',
    regen: 'regen-inline',
};

/**
 * @param {'result'|'gallery'|'inline'} context 调用场景，决定显示哪些按钮
 * @returns {HTMLButtonElement[]}
 */
export function createImageActions(context, { prompt = '', imageUrl = '', historyId = '', allowSave = true } = {}) {
    const url = sanitizeImageUrl(imageUrl);
    const id = historyId ? String(historyId) : '';
    const dataset = { context, prompt, url, historyId: id };
    const buttons = [];

    buttons.push(iconButton({
        iconName: 'fa-download',
        title: '下载图片',
        dataset: { ...dataset, action: ACTION.download },
        disabled: !url,
    }));

    // 图库里的图已经在库中，不再显示"存入图库"
    if (context !== 'gallery' && allowSave) {
        buttons.push(iconButton({
            iconName: id ? 'fa-bookmark' : 'fa-folder-plus',
            title: id ? '查看图库' : '存入图库',
            dataset: { ...dataset, action: id ? ACTION.view : ACTION.save },
            disabled: !url,
        }));
    }

    // 正文内联图可以原位重新生成（结果是临时图，需再次存入图库才持久）
    if (context === 'inline') {
        buttons.push(iconButton({
            iconName: 'fa-rotate',
            title: '重新生成',
            dataset: { ...dataset, action: ACTION.regen },
        }));
    }

    buttons.push(iconButton({
        iconName: 'fa-pen',
        title: '编辑提示词',
        dataset: { ...dataset, action: ACTION.edit },
    }));

    return buttons;
}

export const actionRow = (context, options) => el('div', { class: 'st_ai_action_row' }, createImageActions(context, options));

/** 存入图库成功后原地把按钮切成"查看图库"，避免重复保存。 */
export function markButtonSaved(button, { historyId, imageUrl }) {
    if (!button) return;
    button.disabled = false;
    button.dataset.action = ACTION.view;
    button.dataset.historyId = String(historyId ?? '');
    if (imageUrl) button.dataset.url = imageUrl;
    button.title = '查看图库';
    button.setAttribute('aria-label', '查看图库');
    const iconEl = button.querySelector('i');
    if (iconEl) iconEl.className = 'fa-solid fa-bookmark';
    delete button.dataset.restoreIcon;
}

/** 提示词改了以后，容器和所有按钮的 data-prompt 要一起同步。 */
export function syncPromptDataset(root, prompt) {
    if (!root) return;
    root.dataset.prompt = prompt;
    for (const node of root.querySelectorAll('[data-prompt]')) node.dataset.prompt = prompt;
    const img = root.querySelector('img');
    if (img) img.alt = prompt;
}

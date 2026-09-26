/**
 * 内联元素的构造：生成按钮与图片容器。
 * 这里只造 DOM、只读图库，不发请求、不改聊天记录
 * （请求在 index.js 的委托里，改记录在 message.js）。
 */
import { log } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { getHistoryItem } from '../gallery/db.js';
import { getMessageIdFromElement } from '../st/chat-dom.js';
import { el } from '../ui/dom.js';
import { createImageActions } from '../ui/image-actions.js';
import { getTaskKey, isPending } from './tasks.js';

const messageIdAttr = (messageId) => (Number.isInteger(messageId) ? String(messageId) : '');

/**
 * 未生成的 [image]提示词[/image] → 一个「生成图片」按钮。
 * 正在生成中（同 key 任务已存在）时直接渲染成禁用的转圈态，
 * 避免 ST 重渲染后用户看到一个能再点一次的按钮。
 * @param {string} prompt
 * @param {string} originalTag 原始标签全文，写回正文时要按它定位
 * @param {number|null} messageId
 * @param {{pending?: boolean}} [options] 不传时按任务表判断
 */
export function createInlineGenerateButton(prompt, originalTag, messageId, options = {}) {
    const pending = options.pending ?? isPending(getTaskKey(messageId, originalTag));
    const button = el('button', {
        type: 'button',
        class: `st_gpt_inline_gen${pending ? ' st_gpt_inline_gen_pending' : ''}`,
        title: prompt,
        disabled: pending || undefined,
        dataset: { prompt, originalTag, messageId: messageIdAttr(messageId) },
    }, [
        el('i', { class: pending ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles' }),
        pending ? ' 生成中...' : ' 生成图片',
    ]);
    return button;
}

/** 图片 + 操作按钮，填进已经插入正文的容器里。 */
export function renderInlineImageContent(wrapper, { id = '', prompt = '', imageUrl = '' } = {}) {
    if (!wrapper) return null;
    const safeUrl = sanitizeImageUrl(imageUrl);
    const historyId = id ? String(id) : '';
    const text = String(prompt ?? '');

    Object.assign(wrapper.dataset, { prompt: text, historyId, url: safeUrl });
    if (!wrapper.dataset.messageId) wrapper.dataset.messageId = messageIdAttr(getMessageIdFromElement(wrapper));
    wrapper.textContent = '';

    if (!safeUrl) {
        wrapper.append(el('div', { class: 'st_gpt_inline_missing', text: '图片地址无效或已丢失' }));
        return wrapper;
    }

    const img = el('img', {
        src: safeUrl,
        alt: text || 'AI Image',
        class: 'st_gpt_inline_img',
        loading: 'lazy',
        dataset: { prompt: text },
    });
    img.addEventListener('error', () => {
        img.replaceWith(el('div', { class: 'st_gpt_inline_missing', text: '图片加载失败' }));
    });

    wrapper.append(img, el('div', { class: 'st_gpt_inline_actions' },
        createImageActions('inline', { prompt: text, imageUrl: safeUrl, historyId })));
    return wrapper;
}

/**
 * [st-ai-image id=".."] / [st-ai-image src=".."] → 图片容器。
 * 必须同步返回元素（扫描器要立刻插进 DOM），图库查询在后台补齐。
 * @param {{id?: string, imageUrl?: string}} info parseInlineImageMarker 的结果
 */
export function createInlineImageWrapper(info = {}) {
    const wrapper = el('span', {
        class: 'st_gpt_inline_img_wrap',
        dataset: { messageId: '', marker: info.id ? `id:${info.id}` : 'src' },
    }, [el('span', { class: 'st_gpt_inline_loading', text: '图片加载中...' })]);

    // 标记里直接带地址（旧格式）时先画出来，再看图库有没有更完整的记录
    if (info.imageUrl) renderInlineImageContent(wrapper, { prompt: '', imageUrl: info.imageUrl });

    if (info.id) {
        getHistoryItem(info.id)
            .then((item) => {
                if (!wrapper.isConnected && !info.imageUrl) return;
                if (item) {
                    renderInlineImageContent(wrapper, {
                        id: item.id ?? info.id,
                        prompt: item.prompt || '',
                        imageUrl: item.imageUrl || info.imageUrl,
                    });
                } else if (!info.imageUrl) {
                    wrapper.textContent = '';
                    wrapper.append(el('div', { class: 'st_gpt_inline_missing', text: '图库中已无这张图片' }));
                }
            })
            .catch((e) => {
                log.warn('读取图库条目失败:', e);
                if (info.imageUrl) return;
                wrapper.textContent = '';
                wrapper.append(el('div', { class: 'st_gpt_inline_missing', text: '读取图库失败' }));
            });
    }

    return wrapper;
}

/**
 * 内联元素的构造：生成按钮与图片容器。
 * 这里只造 DOM、只读媒体库，不发请求、不改聊天记录
 * （请求在 index.js 的委托里，改记录在 message.js）。
 */
import { log } from '../core/notify.js';
import { sanitizeImageUrl } from '../core/text.js';
import { getHistoryItem } from '../gallery/chat-store.js';
import { peekSettings } from '../settings.js';
import { getMessageIdFromElement } from '../st/chat-dom.js';
import { el, icon } from '../ui/dom.js';
import { decoText, developCard, ratioOf, setDevelopState } from '../ui/fx.js';
import { createImageActions } from '../ui/image-actions.js';
import { getTask, getTaskKey } from './tasks.js';

const messageIdAttr = (messageId) => (Number.isInteger(messageId) ? String(messageId) : '');

/**
 * 未生成的 [image]提示词[/image] → 一个「生成图片」按钮。
 * 正在生成中（同 key 任务已存在）时直接渲染成禁用的显影卡片，
 * 避免 ST 重渲染后用户看到一个能再点一次的按钮。
 * @param {string} prompt
 * @param {string} originalTag 原始标签全文，写回正文时要按它定位
 * @param {number|null} messageId
 * @param {{pending?: boolean}} [options] 不传时按任务表判断
 */
export function createInlineGenerateButton(prompt, originalTag, messageId, options = {}) {
    const task = getTask(getTaskKey(messageId, originalTag));
    const pending = options.pending ?? Boolean(task);
    const button = el('button', {
        type: 'button',
        class: 'st_gpt_inline_gen',
        title: prompt,
        dataset: { prompt, originalTag, messageId: messageIdAttr(messageId) },
    });
    return setInlineGenerateState(button, pending ? { pending: true, label: task?.label, startedAt: task?.startedAt } : {});
}

/**
 * 按钮的三种样子：待生成（胶囊）、生成中（按比例占位的显影卡片）、失败（玫红胶囊，点了重试）。
 * 生成中再调一次只改文字和进度，不重建卡片（动画不会从头放）。
 */
export function setInlineGenerateState(button, { pending = false, error = false, label = '', startedAt } = {}) {
    if (!button) return button;
    const prompt = button.dataset.prompt || '';
    button.classList.toggle('st_gpt_inline_gen_pending', pending);
    button.classList.toggle('st_gpt_inline_gen_error', error && !pending);
    button.disabled = pending;
    if (pending) {
        const text = label || '生成中…';
        const current = button.querySelector('.st_ai_develop');
        if (current) setDevelopState(current, text);
        else button.replaceChildren(developCard({ kind: 'image', ratio: ratioOf(peekSettings().size), label: text, hint: prompt, startedAt }));
        return button;
    }
    // replaceChildren 会把 null 当成文字 "null"，空的部件先滤掉
    button.replaceChildren(...[
        el('span', { class: 'st_ai_gen_icon' }, [icon(error ? 'fa-rotate-right' : 'fa-wand-magic-sparkles')]),
        el('span', { class: 'st_ai_gen_label', text: error ? '重试' : '生成图片' }),
        error ? null : decoText('st_ai_gen_hint', prompt),
    ].filter(Boolean));
    return button;
}

/** 图片 + 光晕 + 悬停工具条，填进已经插入正文的容器里。reveal：刚生成的图从模糊中显影。 */
export function renderInlineImageContent(wrapper, { id = '', prompt = '', imageUrl = '', reveal = false } = {}) {
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
        decoding: 'async',
        dataset: { prompt: text },
    });
    // 光晕是同一张图的模糊副本（浏览器复用同一份解码）；data: 地址太长，不复制
    const glow = /^data:/i.test(safeUrl) ? null : el('img', {
        src: safeUrl, class: 'st_ai_img_glow', alt: '', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async', draggable: 'false',
    });
    const actions = el('div', { class: 'st_gpt_inline_actions' }, createImageActions('inline', { prompt: text, imageUrl: safeUrl, historyId }));
    const frame = el('span', { class: 'st_ai_img_frame' }, [
        img,
        glow,
        el('span', { class: 'st_ai_img_shine', 'aria-hidden': 'true' }),
        decoText('st_ai_img_caption', text),
        actions,
    ]);
    img.addEventListener('error', () => {
        // 图没了，工具条还留着（重新生成、改提示词）
        frame.replaceWith(el('div', { class: 'st_gpt_inline_missing', text: '图片加载失败' }), actions);
    });

    if (reveal) {
        // 等图真正能画出来再显影，否则动画会播在一张空图上
        const start = () => frame.classList.add('st_ai_reveal');
        if (img.complete && img.naturalWidth) start();
        else img.addEventListener('load', start, { once: true });
    }

    wrapper.append(frame);
    return wrapper;
}

/**
 * [st-ai-image id=".."] / [st-ai-image src=".."] → 图片容器。
 * 必须同步返回元素（扫描器要立刻插进 DOM），媒体库查询在后台补齐。
 * @param {{id?: string, imageUrl?: string}} info parseInlineImageMarker 的结果
 */
export function createInlineImageWrapper(info = {}) {
    const wrapper = el('span', {
        class: 'st_gpt_inline_img_wrap',
        dataset: { messageId: '', marker: info.id ? `id:${info.id}` : 'src' },
    }, [el('span', { class: 'st_gpt_inline_loading', text: '图片加载中...' })]);

    // 标记里直接带地址（旧格式）时先画出来，再看媒体库有没有更完整的记录
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
                    wrapper.append(el('div', { class: 'st_gpt_inline_missing', text: '媒体库中已无这张图片' }));
                }
            })
            .catch((e) => {
                log.warn('读取媒体库条目失败:', e);
                if (info.imageUrl) return;
                wrapper.textContent = '';
                wrapper.append(el('div', { class: 'st_gpt_inline_missing', text: '读取媒体库失败' }));
            });
    }

    return wrapper;
}

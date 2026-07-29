/** 聊天区 DOM 相关：楼层定位、当前楼层提示词。 */
import { buildPromptFromFloorText, getPromptFromImageTagText } from '../core/text.js';
import { getMessageText } from './context.js';

let lastClickedFloor = null;

export function getMessageIdFromElement(node) {
    const id = Number(node?.closest?.('.mes')?.getAttribute('mesid'));
    return Number.isInteger(id) ? id : null;
}

export function getMessageElement(messageId) {
    if (!Number.isInteger(messageId)) return null;
    return document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`)
        || document.querySelector(`#chat .mes[mesid="${messageId}"]`);
}

/** 记住用户最后点过的楼层，它比"可视面积最大"更符合意图。 */
export function trackFloorClicks() {
    document.addEventListener('click', (e) => {
        const mes = e.target?.closest?.('#chat .mes');
        if (mes) lastClickedFloor = mes;
    });
}

export function getCurrentFloorElement() {
    const messages = [...document.querySelectorAll('#chat .mes')];
    if (!messages.length) return null;
    if (lastClickedFloor?.isConnected && lastClickedFloor.closest?.('#chat')) return lastClickedFloor;

    const marked = messages.find((mes) => mes.classList?.contains('last_mes')
        || mes.classList?.contains('selected')
        || mes.classList?.contains('highlighted'));
    if (marked) return marked;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const visible = messages
        .map((mes) => {
            const rect = mes.getBoundingClientRect();
            return { mes, area: Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top)), bottom: rect.bottom };
        })
        .filter((item) => item.area > 0)
        .sort((a, b) => b.area - a.area || b.bottom - a.bottom);

    return visible[0]?.mes || messages[messages.length - 1] || null;
}

/** 楼层里有 [image] 标签就用标签内容，否则用剥干净的正文。 */
export function getCurrentFloorPrompt() {
    const mes = getCurrentFloorElement();
    if (!mes) return { prompt: '', messageId: null };
    const messageId = getMessageIdFromElement(mes);
    const source = getMessageText(messageId) || mes.querySelector?.('.mes_text')?.textContent || mes.textContent || '';
    return { prompt: getPromptFromImageTagText(source) || buildPromptFromFloorText(source), messageId };
}

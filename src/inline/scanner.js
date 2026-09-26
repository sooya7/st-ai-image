/**
 * 聊天正文扫描器：把 [image]提示词[/image] 换成生成按钮，把 [st-ai-image id=".."] 换成图片。
 *
 * 为什么这么绕：ST 渲染 markdown 后，一个标签可能被拆到多个文本节点里，
 * 所以先把所有文本节点拼起来做匹配，再把匹配区间映射回各节点做替换。
 */
import { EXT_ID, IMAGE_REQUEST_SOURCE, LIMITS } from '../core/constants.js';
import { log } from '../core/notify.js';
import {
    getImageRequestPrompt, hasInlineRenderableTag,
    parseInlineImageMarker, shouldProcessInlineText,
} from '../core/text.js';
import { getSettings, peekSettings } from '../settings.js';
import { getMessageElement, getMessageIdFromElement } from '../st/chat-dom.js';
import { onStEvents, setExtensionPrompt } from '../st/context.js';
import { createInlineGenerateButton, createInlineImageWrapper } from './render.js';

const RENDERABLE_SOURCE = `${IMAGE_REQUEST_SOURCE}|\\[st-ai-image\\b[^\\]]*\\]`;

let observer = null;
let scanTimer = null;
let intervalId = null;
let intervalStopAt = 0;
let eventsBound = false;

/**
 * 处理一个 .mes_text 元素。
 * @param {boolean} allowImageRequests 关掉扩展时未生成的标签保持原样文本，不给按钮
 */
export function processMessageElement(node, { allowImageRequests = true } = {}) {
    const text = node.textContent;
    if (node.dataset.stGptProcessed === '1') {
        if (node.dataset.stGptText === text) return false; // 内容没变，已处理过
        delete node.dataset.stGptProcessed; // 流式输出又追加了内容，重新处理
    }
    if (!hasInlineRenderableTag(text)) return false; // 廉价预筛

    const re = new RegExp(RENDERABLE_SOURCE, 'gi');
    if (!re.test(text)) return false;
    re.lastIndex = 0;

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    if (!nodes.length) return false;

    const fullText = nodes.map((n) => n.textContent).join('');
    const messageId = getMessageIdFromElement(node);

    const ranges = [];
    let offset = 0;
    for (const textNode of nodes) {
        ranges.push({ node: textNode, start: offset, end: offset + textNode.textContent.length });
        offset += textNode.textContent.length;
    }

    const matches = [];
    let m;
    while ((m = re.exec(fullText)) !== null) {
        const prompt = getImageRequestPrompt(m);
        let replacement;
        if (prompt && allowImageRequests) replacement = createInlineGenerateButton(prompt, m[0], messageId);
        else if (prompt) replacement = document.createTextNode(m[0]);
        else replacement = createInlineImageWrapper(parseInlineImageMarker(m[0]));
        matches.push({ start: m.index, end: re.lastIndex, replacement });
    }
    if (!matches.length) return false;

    for (const { node: textNode, start: nodeStart, end: nodeEnd } of ranges) {
        const hits = matches.filter(({ start, end }) => start < nodeEnd && end > nodeStart);
        if (!hits.length) continue;

        const frag = document.createDocumentFragment();
        const local = textNode.textContent;
        let cursor = 0;

        for (const { start, end, replacement } of hits) {
            const localStart = Math.max(0, start - nodeStart);
            const localEnd = Math.min(local.length, end - nodeStart);
            if (localStart > cursor) frag.append(local.slice(cursor, localStart));
            // 跨节点的匹配只在起始节点插入替换元素，后续节点只负责吃掉剩余文本
            if (start >= nodeStart && start < nodeEnd) frag.append(replacement);
            cursor = localEnd;
        }
        if (cursor < local.length) frag.append(local.slice(cursor));
        textNode.parentNode?.replaceChild(frag, textNode);
    }

    node.dataset.stGptProcessed = '1';
    node.dataset.stGptText = text;
    return true;
}

export function processMessageById(messageId, { allowImageRequests = false } = {}) {
    const node = getMessageElement(messageId);
    if (!node) return false;
    return processMessageElement(node, { allowImageRequests });
}

/** 优先 .mes_text；只有整条 .mes 里的标签不在 .mes_text 内时才处理 .mes。 */
function getScanTargets() {
    const roots = [...document.querySelectorAll('#chat .mes_text, #chat .mes')];
    return roots.filter((node) => {
        if (!node?.textContent || !hasInlineRenderableTag(node.textContent)) return false;
        if (!node.classList?.contains('mes')) return true;
        const inner = node.querySelector('.mes_text');
        return !(inner?.textContent && hasInlineRenderableTag(inner.textContent));
    });
}

export async function scanInlineMessages() {
    const settings = await getSettings();
    for (const node of getScanTargets()) {
        if (shouldProcessInlineText(node.textContent, settings)) {
            processMessageElement(node, { allowImageRequests: !!settings.enabled });
        }
    }
}

export function scheduleScan(delay = LIMITS.scanDebounceMs) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanTimer = null; scanInlineMessages(); }, delay);
}

/**
 * ST 会在生成结束后多次重渲染消息，单次扫描经常被覆盖掉，
 * 所以事件触发时打一串扫描 + 一段时间的轮询兜底。
 */
export function scanBurst() {
    for (const delay of [0, 500, 2000, 5000]) setTimeout(scanInlineMessages, delay);
    startScanInterval();
}

export function startScanInterval(durationMs = LIMITS.scanDurationMs) {
    intervalStopAt = Math.max(intervalStopAt, Date.now() + durationMs);
    if (intervalId) return;
    intervalId = setInterval(() => {
        scanInlineMessages();
        if (Date.now() >= intervalStopAt) {
            clearInterval(intervalId);
            intervalId = null;
        }
    }, LIMITS.scanIntervalMs);
}

/** 注入（或按开关清除）让 AI 自动带 [image] 标签的系统提示词。 */
export function registerSystemPrompt() {
    const s = peekSettings();
    const instruction = String(s.systemPrompt || '').trim();
    const active = s.enabled && s.autoInjectPrompt && instruction;
    return setExtensionPrompt(EXT_ID, active ? instruction : '');
}

export function stopScanner() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    intervalStopAt = 0;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    observer?.disconnect();
    observer = null;
}

/** 挂 MutationObserver + ST 事件；重复调用会先清理旧的，避免多次加载时泄漏。 */
export function initScanner() {
    stopScanner();
    registerSystemPrompt();
    scanBurst();

    const target = document.getElementById('chat') || document.body;
    if (!target) {
        log.warn('找不到聊天容器，扫描器未启动');
        return false;
    }
    observer = new MutationObserver(() => scheduleScan(100));
    observer.observe(target, { childList: true, subtree: true, characterData: true });

    if (!eventsBound) {
        eventsBound = true;
        window.addEventListener('focus', scanBurst);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) scanBurst(); });
        onStEvents([
            'CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_EDITED',
            'MESSAGE_SWIPED', 'GENERATION_ENDED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
        ], scanBurst);
        // ST 内部可能清空扩展提示词，每次生成前重新注入
        onStEvents(['GENERATION_STARTED'], registerSystemPrompt);
    }
    log.info('内联扫描器已启动');
    return true;
}

/**
 * 把内联图的改动写回聊天记录。
 * 所有写入都通过 rewriteMessageText 同时改 mes 和当前 swipe，
 * 否则切走 swipe 再切回来改动就没了。
 */
import { IMAGE_REQUEST_SOURCE } from '../core/constants.js';
import { errMsg, log, notify } from '../core/notify.js';
import {
    createInlineImageMarker, ensureSafeImageUrl, hasInlineImageMarker,
    replaceFirstImageRequest, replaceInlineImageMarkersWithMarkdown,
} from '../core/text.js';
import { callImageAPI } from '../api/images.js';
import { saveToHistory, updateHistoryItemPrompt } from '../gallery/db.js';
import { syncChatImagesToHistory } from '../gallery/sync.js';
import { getSettings } from '../settings.js';
import { getMessageIdFromElement } from '../st/chat-dom.js';
import { getChat, refreshMessageBlock, rewriteMessageText, saveChat } from '../st/context.js';
import { syncPromptDataset } from '../ui/image-actions.js';
import { renderInlineImageContent } from './render.js';
import { processMessageById, scanBurst } from './scanner.js';

/** 改完正文后统一收尾：重渲染 → 存盘 → 补登记图库 → 再扫一轮。 */
async function commit(messageId) {
    refreshMessageBlock(messageId);
    processMessageById(messageId, { allowImageRequests: false });
    await saveChat();
    await syncChatImagesToHistory();
    scanBurst();
}

/**
 * 把正文里的 [image]标签 换成持久化标记，这样刷新后图还在。
 * @returns {Promise<boolean>} 是否成功写回
 */
export async function persistInlineImageInMessage(messageId, originalTag, markerData) {
    if (!Number.isInteger(messageId) || !markerData) return false;
    const changed = rewriteMessageText(messageId, (text) => replaceFirstImageRequest(text, originalTag, markerData));
    if (!changed) return false;
    try {
        await commit(messageId);
        return true;
    } catch (e) {
        log.error('写回聊天记录失败:', e);
        return false;
    }
}

/**
 * 只改提示词：更新图库记录与 DOM。
 * 正文里的标记只存 id，不含提示词，所以不需要动正文（动了反而会把标记显示成文本）。
 */
export async function saveInlinePrompt(wrapper, newPrompt) {
    if (!wrapper) return false;
    const historyId = wrapper.dataset.historyId || '';
    if (historyId) await updateHistoryItemPrompt(historyId, newPrompt);
    syncPromptDataset(wrapper, newPrompt);
    return true;
}

/**
 * 用新提示词重新生成并替换正文：
 * 旧标记 → [image]新提示词[/image] → 生成 → 新标记。
 * 中途失败也会把已替换的正文存下来，用户能看到自己改的提示词。
 */
export async function regenerateInlineImageInMessage(wrapper, newPrompt) {
    const s = await getSettings();
    if (!s.apiKey) { notify.error('请先在设置中填写 API Key'); return false; }
    if (!wrapper) return false;

    const messageId = getMessageIdFromElement(wrapper);
    if (!Number.isInteger(messageId) || !getChat()?.[messageId]) { notify.error('未找到对应消息'); return false; }

    const oldMarker = wrapper.dataset.historyId ? createInlineImageMarker(wrapper.dataset.historyId) : '';
    const newTag = `[image]${newPrompt}[/image]`;
    const replaced = rewriteMessageText(messageId, (text) => (oldMarker && text.includes(oldMarker)
        ? text.replace(oldMarker, newTag)
        : text.replace(new RegExp(IMAGE_REQUEST_SOURCE, 'i'), newTag)));
    if (!replaced) log.warn('未在正文中找到旧标记，正文可能未更新', { oldMarker });

    notify.info('正在用新提示词生成图片...');
    let imageUrl;
    try {
        imageUrl = ensureSafeImageUrl(await callImageAPI(newPrompt));
    } catch (e) {
        await commit(messageId).catch(() => {}); // 至少把改过的提示词存住
        notify.error(errMsg(e), '生图失败');
        return false;
    }

    const saved = await saveToHistory({
        prompt: newPrompt, imageUrl, timestamp: Date.now(), model: s.model, size: s.size,
    }, { force: true });

    const newMarker = createInlineImageMarker({ id: saved?.id ?? '', imageUrl, prompt: newPrompt });
    rewriteMessageText(messageId, (text) => (text.includes(newTag)
        ? text.replace(newTag, newMarker)
        : text.replace(new RegExp(IMAGE_REQUEST_SOURCE, 'i'), newMarker)));

    renderInlineImageContent(wrapper, { id: saved?.id, prompt: newPrompt, imageUrl });
    try {
        await commit(messageId);
        notify.success('已替换正文提示词并重新生成图片');
        return true;
    } catch (e) {
        log.error('保存消息失败:', e);
        notify.error('保存消息失败');
        return false;
    }
}

/**
 * 迁移历史遗留的 [st-ai-image src=".."] 标记：转成 markdown 图片。
 * 只带 id 的标记不动——那是当前格式。
 */
export async function migrateInlineMarkersInChat() {
    const chat = getChat();
    if (!chat?.length) return false;

    let changed = false;
    for (let messageId = 0; messageId < chat.length; messageId++) {
        const message = chat[messageId];
        if (!message) continue;
        let touched = false;

        if (typeof message.mes === 'string' && hasInlineImageMarker(message.mes)) {
            const next = replaceInlineImageMarkersWithMarkdown(message.mes);
            if (next !== message.mes) { message.mes = next; touched = true; }
        }
        // 所有 swipe 都要迁移，否则切到旧 swipe 时标记又会以文本形式冒出来
        if (Array.isArray(message.swipes)) {
            message.swipes = message.swipes.map((swipe) => {
                if (typeof swipe !== 'string' || !hasInlineImageMarker(swipe)) return swipe;
                const next = replaceInlineImageMarkersWithMarkdown(swipe);
                if (next !== swipe) touched = true;
                return next;
            });
        }

        if (touched) {
            changed = true;
            refreshMessageBlock(messageId);
        }
    }

    if (changed) {
        await saveChat();
        await syncChatImagesToHistory();
        scanBurst();
    }
    return changed;
}

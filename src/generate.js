/** 面板里的生图流程：生成后将文件和索引保存到当前聊天媒体库。 */
import { callImageAPI, imageKeyMissing } from './api/images.js';
import { errMsg, log, notify } from './core/notify.js';
import { ensureSafeImageUrl } from './core/text.js';
import { saveGeneratedImage } from './gallery/sync.js';
import { getSettings } from './settings.js';
import { getCurrentFloorPrompt } from './st/chat-dom.js';
import { getChatIdentity } from './st/context.js';
import { el, qs, replaceContent } from './ui/dom.js';
import { developCard, preloadImage, ratioOf, setDevelopState } from './ui/fx.js';
import { actionRow } from './ui/image-actions.js';
import { showPreview } from './ui/preview.js';
import { activateTab } from './ui/tabs.js';

let currentRequest = null;

const placeholder = (text, className = '') => el('div', { class: `st_ai_gen_placeholder ${className}`.trim(), text });

/**
 * 生成一张图并展示在生图页。
 * @returns {Promise<string|null>} 成功时返回图片地址
 */
export async function generateImage(prompt, { expectedIdentity = getChatIdentity() } = {}) {
    const chatId = expectedIdentity;
    const clean = String(prompt ?? '').trim();
    if (!clean) { notify.warn('请输入图片描述'); return null; }
    const s = await getSettings();
    if (getChatIdentity() !== chatId) return null;
    if (imageKeyMissing(s)) { notify.error('请先在面板的「图片」页填写 API Key'); return null; }

    if (currentRequest) { notify.warn('已有图片任务，请等待完成，避免重复提交'); return null; }
    const controller = new AbortController();
    currentRequest = controller;

    const button = qs('#st_gpt_image_generate_btn');
    const result = qs('#st_gpt_gen_result');
    if (button) button.disabled = true;
    // 结果区先放一张按尺寸比例占位的显影卡片，出图后原位显影
    const card = developCard({ kind: 'image', ratio: ratioOf(s.size), label: '正在生成…', hint: clean });
    if (result) replaceContent(result, card);

    try {
        const url = await callImageAPI(clean, {
            signal: controller.signal,
            onProgress: ({ attempt, total, errors }) => {
                let text = `正在生成 (${attempt}/${total})`;
                if (errors > 0) text += ` · ${errors} 个接口失败`;
                setDevelopState(card, text);
            },
        });
        const generatedUrl = ensureSafeImageUrl(url);
        const stored = chatId && getChatIdentity() === chatId
            ? await saveGeneratedImage({ prompt: clean, imageUrl: generatedUrl, timestamp: Date.now(), model: s.model, size: s.size }, { force: true, expectedIdentity: chatId })
            : null;
        const imageUrl = stored?.saved ? stored.imageUrl : generatedUrl;
        setDevelopState(card, '显影中…');
        await preloadImage(imageUrl);

        if (result) {
            const img = el('img', { src: imageUrl, alt: clean, class: 'st_gpt_gen_img st_ai_reveal', dataset: { prompt: clean } });
            img.addEventListener('click', () => showPreview(imageUrl, clean, { from: img }));
            replaceContent(result, img, el('div', { class: 'st_gpt_gen_result_info' }, [
                actionRow('result', { prompt: clean, imageUrl, historyId: stored?.saved?.id }),
            ]));
        }
        if (stored?.saved) notify.success('图片已生成并保存到当前聊天的媒体库');
        else notify.warn('图片已生成，但未能保存到当前聊天；可点结果旁的保存按钮重试');
        return imageUrl;
    } catch (e) {
        if (e?.name === 'AbortError') {
            if (result) replaceContent(result, placeholder('已取消'));
            return null;
        }
        log.error('生成失败:', e);
        if (result) replaceContent(result, placeholder(`生成失败: ${errMsg(e)}`, 'st_ai_error_text'));
        notify.error(errMsg(e), '生成失败');
        return null;
    } finally {
        if (currentRequest === controller) currentRequest = null;
        if (button) button.disabled = false;
    }
}

/** 读当前楼层内容当提示词，切到生图页并生成。 */
export async function generateFromCurrentFloor() {
    const identity = getChatIdentity();
    const { prompt, messageId } = getCurrentFloorPrompt();
    if (!prompt) { notify.warn('没有找到当前楼层内容'); return null; }
    const input = qs('#st_gpt_image_prompt');
    if (input) input.value = prompt;
    await activateTab('generate');
    const imageUrl = await generateImage(prompt, { expectedIdentity: identity });
    if (imageUrl && Number.isInteger(messageId)) notify.success(`已从第 ${messageId + 1} 楼生成图片`);
    return imageUrl;
}

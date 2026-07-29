/** 面板里的生图流程（结果只展示，不自动入库——由用户点"存入图库"决定）。 */
import { callImageAPI } from './api/images.js';
import { errMsg, log, notify } from './core/notify.js';
import { ensureSafeImageUrl } from './core/text.js';
import { getSettings } from './settings.js';
import { getCurrentFloorPrompt } from './st/chat-dom.js';
import { el, qs, replaceContent, spinner } from './ui/dom.js';
import { actionRow } from './ui/image-actions.js';
import { showPreview } from './ui/preview.js';
import { activateTab } from './ui/tabs.js';

let currentRequest = null;

const placeholder = (text, className = '') => el('div', { class: `st_ai_gen_placeholder ${className}`.trim(), text });

/**
 * 生成一张图并展示在生图页。
 * @returns {Promise<string|null>} 成功时返回图片地址
 */
export async function generateImage(prompt) {
    const clean = String(prompt ?? '').trim();
    if (!clean) { notify.warn('请输入图片描述'); return null; }
    const s = await getSettings();
    if (!s.apiKey) { notify.error('请先在设置中填写 API Key'); return null; }

    currentRequest?.abort(); // 新请求顶掉上一个未完成的
    const controller = new AbortController();
    currentRequest = controller;

    const button = qs('#st_gpt_image_generate_btn');
    const result = qs('#st_gpt_gen_result');
    if (button) button.disabled = true;
    const loading = spinner('正在生成...');
    if (result) replaceContent(result, loading);

    try {
        const url = await callImageAPI(clean, {
            signal: controller.signal,
            onProgress: ({ attempt, total, errors }) => {
                let text = `正在生成 (${attempt}/${total})`;
                if (errors > 0) text += ` · ${errors} 个接口失败`;
                if (loading.isConnected) replaceContent(loading, el('div', { class: 'st_ai_spinner' }), ` ${text}`);
            },
        });
        const imageUrl = ensureSafeImageUrl(url);

        if (result) {
            const img = el('img', { src: imageUrl, alt: clean, class: 'st_gpt_gen_img', dataset: { prompt: clean } });
            img.addEventListener('click', () => showPreview(imageUrl, clean));
            replaceContent(result, img, el('div', { class: 'st_gpt_gen_result_info' }, [
                actionRow('result', { prompt: clean, imageUrl }),
            ]));
        }
        notify.success('图片生成完成');
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
    const { prompt, messageId } = getCurrentFloorPrompt();
    if (!prompt) { notify.warn('没有找到当前楼层内容'); return null; }
    const input = qs('#st_gpt_image_prompt');
    if (input) input.value = prompt;
    await activateTab('generate');
    const imageUrl = await generateImage(prompt);
    if (imageUrl && Number.isInteger(messageId)) notify.success(`已从第 ${messageId + 1} 楼生成图片`);
    return imageUrl;
}

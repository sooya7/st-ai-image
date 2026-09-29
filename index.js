/**
 * AI Image Generator (SillyTavern 扩展) — 入口。
 * 这里只做三件事：挂 UI、绑事件、起扫描器。具体逻辑都在 src/ 下分模块。
 */
import { EVENTS, on } from './src/core/bus.js';
import { LEGACY_HISTORY_KEY } from './src/core/constants.js';
import { errMsg, log, notify } from './src/core/notify.js';
import { getStableInlineImageUrl, sanitizeImageUrl } from './src/core/text.js';
import { callImageAPI, imageKeyMissing } from './src/api/images.js';
import { generateFromCurrentFloor, generateImage } from './src/generate.js';
import { saveGeneratedImage } from './src/gallery/sync.js';
import { getSettings } from './src/settings.js';
import { trackFloorClicks } from './src/st/chat-dom.js';
import { captureMessageTarget, getChatIdentity, isMessageTargetCurrent, onStEvents } from './src/st/context.js';
import { migrateInlineMarkersInChat, persistInlineImageInMessage, regenerateInlineImageInMessage, saveInlinePrompt } from './src/inline/message.js';
import { bindInlineMedia, stopPlaying } from './src/inline/media.js';
import { renderInlineImageContent, setInlineGenerateState } from './src/inline/render.js';
import { initScanner, registerSystemPrompt, scanBurst } from './src/inline/scanner.js';
import { endTask, getTask, getTaskKey, isPending, startTask, startStaleCleaner, updateTask } from './src/inline/tasks.js';
import { debounce, delegate, el, qs, setBusy } from './src/ui/dom.js';
import { preloadImage } from './src/ui/fx.js';
import { bindGalleryEvents, renderGallery } from './src/ui/gallery-view.js';
import { ACTION, markButtonSaved } from './src/ui/image-actions.js';
import { mountPanel } from './src/ui/panel.js';
import { downloadImage, showPreview, showPromptEditor } from './src/ui/preview.js';
import { activateTab, bindTabs } from './src/ui/tabs.js';

const wrapperOf = (node) => node?.closest?.('.st_gpt_inline_img_wrap') || null;

/** 生图页 / 媒体库 / 正文内联图 共用的按钮委托。 */
function bindImageActions() {
    delegate('click', `[data-action="${ACTION.download}"]`, (e, btn) => {
        e.stopPropagation();
        downloadImage(btn.dataset.url);
    });

    delegate('click', `[data-action="${ACTION.view}"]`, (e) => {
        e.stopPropagation();
        activateTab('gallery');
    });

    delegate('click', `[data-action="${ACTION.save}"]`, async (e, btn) => {
        e.stopPropagation();
        const imageUrl = sanitizeImageUrl(btn.dataset.url);
        const prompt = btn.dataset.prompt || '';
        if (!imageUrl) return notify.error('图片地址无效，无法保存');
        const chatId = getChatIdentity();
        const wrapper = wrapperOf(btn);
        const targetSnapshot = wrapper ? captureMessageTarget(Number(wrapper.dataset.messageId)) : null;

        setBusy(btn, true);
        const s = await getSettings();
        const { saved, imageUrl: savedUrl, serverImageUrl } = await saveGeneratedImage(
            { prompt, imageUrl, timestamp: Date.now(), model: s.model, size: s.size },
            { force: true, expectedIdentity: chatId },
        );
        if (!saved?.id) {
            setBusy(btn, false);
            return notify.error('保存到媒体库失败');
        }
        // 正文内联图：存库后把标记写回聊天记录，刷新后图才还在
        if (getChatIdentity() !== chatId || (targetSnapshot && !isMessageTargetCurrent(targetSnapshot))) {
            setBusy(btn, false);
            return notify.warn('聊天或消息已切换，图片没有写入另一条消息');
        }
        markButtonSaved(btn, { historyId: saved.id, imageUrl: savedUrl });
        const markerUrl = getStableInlineImageUrl(serverImageUrl || savedUrl);
        if (wrapper && markerUrl) {
            wrapper.dataset.historyId = String(saved.id);
            wrapper.dataset.url = markerUrl;
            const img = wrapper.querySelector('img');
            if (img) img.src = markerUrl;
            const messageId = wrapper.dataset.messageId === '' ? null : Number(wrapper.dataset.messageId);
            const persisted = await persistInlineImageInMessage(messageId, wrapper.dataset.originalTag || '', {
                id: saved.id, imageUrl: markerUrl, prompt,
            }, targetSnapshot);
            if (!persisted) notify.warn('已存入媒体库，但当前消息未能写回聊天记录');
        }
        notify.success('已保存到媒体库');
    });

    delegate('click', `[data-action="${ACTION.edit}"]`, (e, btn) => {
        e.stopPropagation();
        const wrapper = wrapperOf(btn);
        const isInline = btn.dataset.context === 'inline';
        showPromptEditor({
            // 内联图的最新提示词在容器上（编辑过一次后按钮的 dataset 可能已旧）
            prompt: (isInline && wrapper?.dataset.prompt) || btn.dataset.prompt || '',
            imageUrl: btn.dataset.url || '',
            historyId: btn.dataset.historyId || null,
            onSave: isInline
                ? (newPrompt) => saveInlinePrompt(wrapper, newPrompt)
                : null,
        });
    });

    // 正文内联图原位重新生成，完成后自动存入当前聊天媒体库。
    delegate('click', `[data-action="${ACTION.regen}"]`, async (e, btn) => {
        e.stopPropagation();
        const wrapper = wrapperOf(btn);
        const prompt = wrapper?.dataset.prompt || btn.dataset.prompt || '';
        if (!wrapper || !prompt) return;
        const targetSnapshot = captureMessageTarget(Number(wrapper.dataset.messageId));
        const s = await getSettings();
        if (!isMessageTargetCurrent(targetSnapshot)) return;
        if (imageKeyMissing(s)) return notify.error('请先在面板的「图片」页填写 API Key');

        // 已入库的正文图：重新生成并把新标记写回聊天记录，刷新后仍然在
        const frame = wrapper.querySelector('.st_ai_img_frame');
        if (wrapper.dataset.historyId) {
            setBusy(btn, true);
            frame?.classList.add('st_ai_busy');
            try { await regenerateInlineImageInMessage(wrapper, prompt); }
            finally { setBusy(btn, false); frame?.classList.remove('st_ai_busy'); }
            return;
        }

        const chatId = getChatIdentity();
        setBusy(btn, true);
        frame?.classList.add('st_ai_busy');
        try {
            const imageUrl = await callImageAPI(prompt);
            if (getChatIdentity() !== chatId) return notify.warn('聊天已切换，图片没有写入另一段聊天');
            const { saved, imageUrl: storedUrl } = await saveGeneratedImage(
                { prompt, imageUrl, timestamp: Date.now(), model: s.model, size: s.size }, { force: true, expectedIdentity: chatId },
            );
            if (getChatIdentity() !== chatId) return notify.warn('聊天已切换，图片没有写入另一段聊天');
            await preloadImage(saved ? storedUrl : imageUrl);
            if (!isMessageTargetCurrent(targetSnapshot)) return notify.warn('聊天或消息已切换，图片没有写入另一条消息');
            renderInlineImageContent(wrapper, { id: saved?.id, prompt, imageUrl: saved ? storedUrl : imageUrl, reveal: true });
            if (saved) {
                const messageId = wrapper.dataset.messageId === '' ? null : Number(wrapper.dataset.messageId);
                const persisted = await persistInlineImageInMessage(messageId, wrapper.dataset.originalTag || '', {
                    id: saved.id, imageUrl: storedUrl, prompt,
                }, targetSnapshot);
                if (!persisted) notify.warn('图片已入媒体库，但没有写回当前消息');
            } else notify.warn('图片已生成但未能入库，可点图片旁的保存按钮重试');
        } catch (err) {
            log.error('内联重新生成失败:', err);
            notify.error(errMsg(err), '生图失败');
            setBusy(btn, false);
            frame?.classList.remove('st_ai_busy');
        }
    });

    delegate('click', '.st_gpt_inline_img', (e, img) => {
        e.stopPropagation();
        showPreview(img.src, wrapperOf(img)?.dataset.prompt || '', { from: img });
    });

    // 媒体库里的"重新生成"：切到生图页，让用户看到进度
    delegate('click', '.st_gpt_regen', async (e, btn) => {
        e.stopPropagation();
        const identity = getChatIdentity();
        const prompt = btn.dataset.prompt;
        if (!prompt) return notify.warn('提示词为空');
        await activateTab('generate');
        await generateImage(prompt, { expectedIdentity: identity });
    });
}

/** 正文里未生成的 [image] 标签按钮。 */
function bindInlineGenerate() {
    const messageIdOf = (button) => (button.dataset.messageId === '' ? null : Number(button.dataset.messageId));
    // ST 生成中途可能重渲染这条消息：进度要同步给所有对应这个任务的按钮（新旧都有）
    const buttonsOf = (taskKey) => [...document.querySelectorAll('.st_gpt_inline_gen')]
        .filter((button) => getTaskKey(Number.isInteger(messageIdOf(button)) ? messageIdOf(button) : null, button.dataset.originalTag || '') === taskKey);

    delegate('click', '.st_gpt_inline_gen', async (e, btn) => {
        const prompt = btn.dataset.prompt;
        if (!prompt) return;
        const targetSnapshot = captureMessageTarget(messageIdOf(btn));
        const s = await getSettings();
        if (imageKeyMissing(s)) return notify.error('请先在面板的「图片」页填写 API Key');

        if (!isMessageTargetCurrent(targetSnapshot)) return;
        const messageId = messageIdOf(btn);
        const originalTag = btn.dataset.originalTag || `[image]${prompt}[/image]`;
        const taskKey = getTaskKey(Number.isInteger(messageId) ? messageId : null, originalTag);
        if (isPending(taskKey)) return;
        const chatId = getChatIdentity();
        startTask(taskKey, { prompt, messageId, originalTag });

        btn.closest('.mes_text')?.querySelectorAll('.st_gpt_inline_error').forEach((node) => node.remove());
        const label = (text) => {
            updateTask(taskKey, { label: text });
            if (!isMessageTargetCurrent(targetSnapshot)) return;
            const startedAt = getTask(taskKey)?.startedAt;
            const targets = isMessageTargetCurrent(targetSnapshot) ? buttonsOf(taskKey) : [];
            for (const button of targets.includes(btn) ? targets : [btn, ...targets]) setInlineGenerateState(button, { pending: true, label: text, startedAt });
        };
        label('生成中…');

        try {
            const imageUrl = await callImageAPI(prompt, {
                onProgress: ({ attempt, total, errors }) => {
                    label(errors > 0 ? `生成中 (${attempt}/${total}) · ${errors}失败` : `生成中 (${attempt}/${total})`);
                },
            });
            if (getChatIdentity() !== chatId) return notify.warn('聊天已切换，图片没有写入另一段聊天');
            label('保存到当前聊天…');
            const { saved, imageUrl: storedUrl } = await saveGeneratedImage(
                { prompt, imageUrl, timestamp: Date.now(), model: s.model, size: s.size }, { force: true, expectedIdentity: chatId },
            );
            if (getChatIdentity() !== chatId) return notify.warn('聊天已切换，图片没有写入另一段聊天');
            const finalUrl = saved ? storedUrl : imageUrl;
            label('显影中…');
            await preloadImage(finalUrl);
            if (!isMessageTargetCurrent(targetSnapshot)) return notify.warn('聊天或消息已切换，图片没有写入另一条消息');
            const wrapper = el('span', {
                class: 'st_gpt_inline_img_wrap',
                dataset: { messageId: Number.isInteger(messageId) ? String(messageId) : '', originalTag },
            });
            renderInlineImageContent(wrapper, { id: saved?.id, prompt, imageUrl: finalUrl, reveal: true });
            const target = btn.isConnected ? btn : buttonsOf(taskKey).find((button) => button.isConnected);
            target?.replaceWith(wrapper);
            if (saved) {
                const persisted = await persistInlineImageInMessage(messageId, originalTag, {
                    id: saved.id, imageUrl: storedUrl, prompt,
                }, targetSnapshot);
                if (!persisted) notify.warn('图片已入媒体库，但没有写回当前消息');
            } else notify.warn('图片已生成但未能入库，可点图片旁的保存按钮重试');
        } catch (err) {
            log.error('内联生图失败:', err);
            for (const button of isMessageTargetCurrent(targetSnapshot) ? new Set([btn, ...buttonsOf(taskKey)]) : []) {
                setInlineGenerateState(button, { error: true });
                if (button.isConnected) button.after(el('div', { class: 'st_gpt_inline_error', text: errMsg(err, '生成失败') }));
            }
            notify.error(errMsg(err), '生图失败');
        } finally {
            endTask(taskKey);
        }
    });
}

function bindGeneratePanel() {
    qs('#st_gpt_image_generate_btn')?.addEventListener('click', () => generateImage(qs('#st_gpt_image_prompt')?.value));
    qs('#st_gpt_image_prompt')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            generateImage(e.target.value);
        }
    });

    const floorBtn = qs('#st_gpt_generate_current_floor_btn');
    floorBtn?.addEventListener('click', async () => {
        floorBtn.disabled = true;
        try { await generateFromCurrentFloor(); }
        finally { floorBtn.disabled = false; }
    });
}

let started = false;

export async function init() {
    if (started) return;
    started = true;
    try {
        await mountPanel({ onPromptSettingChanged: registerSystemPrompt });
        bindTabs();
        bindGalleryEvents();
        bindGeneratePanel();
        bindImageActions();
        bindInlineGenerate();
        bindInlineMedia();
        onStEvents(['CHAT_CHANGED'], () => { stopPlaying(); renderGallery(); });
        trackFloorClicks();
        startStaleCleaner();

        // 存储层变化后刷新媒体库（多次写入合并成一次渲染）
        on(EVENTS.galleryChanged, debounce(() => renderGallery(), 200));

        initScanner();
        for (const delay of [0, 1000, 3000]) setTimeout(() => migrateInlineMarkersInChat(), delay);
        setTimeout(scanBurst, 1500);

        try { localStorage.removeItem(LEGACY_HISTORY_KEY); } catch { /* 忽略 */ }
        renderGallery();
        log.info('扩展加载完成');
    } catch (e) {
        log.error('初始化失败:', e);
    }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
}

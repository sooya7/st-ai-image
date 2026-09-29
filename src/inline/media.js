/**
 * 正文里的语音/视频，与内联图片同一套路：
 *   标签 → 生成按钮 → 请求服务 → 文件存进酒馆 → 把 src 写回标签 → 重渲染成播放器。
 *
 * 结果写回聊天并自动登记到当前聊天的媒体库。
 * 请求客户端按需 import：聊天里没人点生成时，媒体协议代码不会加载。
 */
import { errMsg, log, notify } from '../core/notify.js';
import { EVENTS, on } from '../core/bus.js';
import { findHistoryByMediaUrl, getHistory } from '../gallery/chat-store.js';
import { saveMediaToHistory } from '../gallery/sync.js';
import { readMediaSettings, mediaRequestConfig } from '../media/media-settings.js';
import { resolveVoice } from '../media/voice-presets.js';
import { needsKey } from '../media/keys.js';
import {
    buildMediaTag, locateMediaTag, mediaJobKey, normalizeMediaText, parseMediaTag, replaceMediaTag,
} from '../media/tags.js';
import { getSettings } from '../settings.js';
import { getMessageIdFromElement } from '../st/chat-dom.js';
import { getCurrentChatId, getMessage, refreshMessageBlock, rewriteMessageText, saveChat } from '../st/context.js';
import { delegate, el, icon } from '../ui/dom.js';
import { decoText, developCard, hueOf, paintWave, setDevelopState, waveBars } from '../ui/fx.js';
import { endTask, getTask, getTaskKey, isPending, startTask, updateTask } from './tasks.js';

const LABEL = { audio: '配音', video: '视频' };
const TITLE = { audio: 'AI 配音', video: 'AI 视频' };
const SECTION = { audio: 'speech', video: 'video' };
const VIDEO_TASK_MAX_AGE = 40 * 60_000;
const idAttr = (id) => (Number.isInteger(id) ? String(id) : '');
const messageIdOf = (wrapper) => {
    const raw = wrapper.dataset.messageId;
    if (raw !== '' && raw !== undefined) return Number(raw);
    return getMessageIdFromElement(wrapper);
};
const taskKeyOf = (messageId, kind, ordinal, text) => getTaskKey(messageId, `${kind}#${ordinal}#${normalizeMediaText(text)}`);

// ---------- 断线续查：视频任务句柄存在消息的 extra 里（不含密钥） ----------

const jobsOf = (messageId) => getMessage(messageId)?.extra?.st_ai_media_jobs || null;
const jobRecord = (messageId, jobKey) => jobsOf(messageId)?.[jobKey] || null;

function saveJobRecord(messageId, chatId, jobKey, record) {
    const message = getMessage(messageId);
    if (!message || getCurrentChatId() !== chatId) return;
    message.extra ||= {};
    message.extra.st_ai_media_jobs = { ...(message.extra.st_ai_media_jobs || {}), [jobKey]: record };
    saveChat();
}

function clearJobRecord(messageId, jobKey) {
    const jobs = jobsOf(messageId);
    if (!jobs?.[jobKey]) return false;
    delete jobs[jobKey];
    if (!Object.keys(jobs).length) delete getMessage(messageId).extra.st_ai_media_jobs;
    return true;
}

// ---------- 渲染 ----------

/** 按钮里的迷你声波（配音）或场记板（视频）。 */
const genIcon = (kind) => el('span', { class: 'st_ai_gen_icon' }, [kind === 'audio'
    ? el('span', { class: 'st_ai_bars' }, [0.55, 1, 0.7, 0.9].map((h, i) => el('i', { style: { '--h': h, '--i': i } })))
    : icon('fa-clapperboard')]);

/**
 * 把生成按钮画成对应状态：待生成 / 生成中 / 可续查。
 * 视频生成中是一张 16:9 的显影卡片（带百分比和已等待时间），配音生成中是跳动的声波胶囊。
 */
function paintGenerateButton(button, { pending = false, label = '', startedAt, resumable = false, meta = '' } = {}) {
    const kind = button.dataset.kind;
    const text = button.dataset.text || '';
    button.classList.toggle('st_ai_media_gen_pending', pending);
    button.disabled = pending;
    if (pending && kind === 'video') {
        const card = button.querySelector('.st_ai_develop');
        if (card) setDevelopState(card, label);
        else button.replaceChildren(developCard({ kind: 'video', label: label || '生成中…', hint: text, startedAt }));
        return button;
    }
    const idle = resumable ? '继续查询视频任务' : kind === 'audio' ? '配音' : '生成视频';
    // replaceChildren 会把 null 当成文字 "null"，空的部件先滤掉
    button.replaceChildren(...[
        genIcon(kind),
        el('span', { class: 'st_ai_gen_label', text: pending ? label || '生成中…' : idle }),
        pending ? null : decoText('st_ai_media_meta', meta),
    ].filter(Boolean));
    return button;
}

function generateButton(kind, text, key, resumable, hint = '', meta = '') {
    const task = getTask(key);
    const button = el('button', {
        type: 'button',
        class: 'st_ai_media_gen',
        title: hint ? `${hint}：${text}` : text,
        dataset: { taskKey: key, resume: resumable ? '1' : '', kind, text },
    });
    return paintGenerateButton(button, { pending: !!task, label: task?.label, startedAt: task?.startedAt, resumable, meta });
}

function setLibraryButtonState(button, saved) {
    button.dataset.saved = saved ? '1' : '';
    button.title = saved ? '查看媒体库' : '存入媒体库';
    button.setAttribute('aria-label', button.title);
    button.querySelector('i').className = `fa-solid ${saved ? 'fa-bookmark' : 'fa-folder-plus'}`;
}

function libraryButton(kind, src) {
    const button = el('button', {
        type: 'button', class: 'st_ai_media_icon st_ai_media_library',
        title: '存入媒体库', 'aria-label': '存入媒体库',
        dataset: { kind, src },
    }, [icon('fa-folder-plus')]);
    findHistoryByMediaUrl(src, kind)
        .then((entry) => setLibraryButtonState(button, !!entry))
        .catch((error) => log.warn('读取媒体库状态失败:', error));
    return button;
}

function actionButtons(kind, src) {
    return [
        el('button', { type: 'button', class: 'st_ai_media_icon st_ai_media_regen', title: `重新生成${LABEL[kind]}`, 'aria-label': `重新生成${LABEL[kind]}` }, [icon('fa-rotate')]),
        libraryButton(kind, src),
        el('a', { class: 'st_ai_media_icon', href: src, download: src.split('/').pop(), title: '下载', 'aria-label': '下载' }, [icon('fa-download')]),
    ];
}

function missing(wrapper, text) {
    wrapper.querySelector('.st_ai_media_missing')?.remove();
    wrapper.append(el('span', { class: 'st_ai_media_missing', text }));
}

/**
 * 影院式视频卡片。不预读（preload=none，媒体文件只在播放时加载）：
 * 播放前是按描述取色的极光封面 + 大号玻璃播放键；开播后交给原生控件。
 */
function videoFrame(wrapper, info) {
    const video = el('video', { class: 'st_ai_inline_video', playsinline: true, preload: 'none', src: info.src, title: info.text });
    const play = el('button', { type: 'button', class: 'st_ai_video_play', title: '播放视频', 'aria-label': '播放视频' },
        [el('span', { class: 'st_ai_video_play_btn' }, [icon('fa-play')])]);
    const frame = el('span', { class: 'st_ai_video_frame', style: { '--st-ai-hue': hueOf(info.text) } }, [
        video,
        el('span', { class: 'st_ai_video_badge', 'aria-hidden': 'true', dataset: { text: 'AI 视频' } }, [icon('fa-clapperboard')]),
        decoText('st_ai_video_caption', info.text),
        play,
    ]);
    play.addEventListener('click', (e) => {
        e.stopPropagation();
        video.controls = true;
        video.play().catch((error) => { if (error?.name !== 'AbortError') log.warn('视频播放失败:', error); });
    });
    // 不管是点封面、原生控件还是脚本调用 play()，开播后都收起封面、露出原生控件
    video.addEventListener('play', () => { video.controls = true; frame.classList.add('is-started'); });
    video.addEventListener('ended', () => frame.classList.remove('is-started'));
    video.addEventListener('error', () => missing(wrapper, '视频文件不存在或无法播放，可重新生成'), { once: true });
    return frame;
}

/** 按 dataset 里的标签把容器画成「按钮」或「播放器」。 */
export function renderMediaWrapper(wrapper, { error = '' } = {}) {
    const info = parseMediaTag(wrapper.dataset.tag);
    if (!info) return wrapper;
    const messageId = messageIdOf(wrapper);
    const ordinal = Number(wrapper.dataset.ordinal) || 0;
    const key = taskKeyOf(messageId, info.kind, ordinal, info.text);
    const pending = isPending(key);
    const resumable = info.kind === 'video' && !info.src && !pending && !!jobRecord(messageId, mediaJobKey('video', info.text));
    wrapper.textContent = '';
    wrapper.dataset.src = info.src;

    if (info.kind === 'audio') {
        const controls = info.src && !pending
            ? [
                el('button', { type: 'button', class: 'st_ai_media_icon st_ai_media_play', title: '播放', 'aria-label': '播放配音', dataset: { src: info.src } }, [icon('fa-play')]),
                waveBars(info.text, 14),
                ...actionButtons('audio', info.src),
            ]
            : [generateButton('audio', info.text, key, false, [info.speaker, info.voiceType, info.emotion].filter(Boolean).join(' · '), info.emotion)];
        const chip = info.src && !pending ? ' st_ai_voice_chip' : '';
        wrapper.append(el('span', { class: `st_ai_media_controls${chip}` }, controls), el('span', { class: 'st_ai_voice_text', text: info.text }));
    } else if (info.src && !pending) {
        wrapper.append(videoFrame(wrapper, info), el('span', { class: 'st_ai_media_controls' }, actionButtons('video', info.src)));
    } else {
        wrapper.append(generateButton('video', info.text, key, resumable));
    }
    if (error) {
        wrapper.querySelector('.st_ai_media_gen')?.classList.add('st_ai_media_gen_error');
        wrapper.append(el('span', { class: 'st_ai_media_error', text: error }));
    }
    return wrapper;
}

/** 扫描器调用：同步返回一个容器，替换正文里的标签。 */
export function createMediaElement(tagText, messageId, ordinal = 0) {
    const wrapper = el('span', {
        class: `st_ai_media st_ai_media_${parseMediaTag(tagText)?.kind || 'audio'}`,
        dataset: { tag: tagText, ordinal: String(ordinal), messageId: idAttr(messageId) },
    });
    return renderMediaWrapper(wrapper);
}

/** 进度写进任务表，再同步到所有对应按钮（ST 重渲染后按钮可能已换成新的）。 */
function setProgress(key, label) {
    const task = updateTask(key, { label });
    for (const button of document.querySelectorAll('.st_ai_media_gen')) {
        if (button.dataset.taskKey !== key) continue;
        paintGenerateButton(button, { pending: true, label, startedAt: task?.startedAt });
    }
}

function rerenderTask(key, options) {
    for (const button of document.querySelectorAll('.st_ai_media_gen')) {
        const wrapper = button.closest('.st_ai_media');
        if (button.dataset.taskKey === key && wrapper) renderMediaWrapper(wrapper, options);
    }
}

// ---------- 生成 ----------

async function commit(messageId) {
    refreshMessageBlock(messageId);
    await saveChat();
    const { scanBurst } = await import('./scanner.js');
    scanBurst();
}

async function runMediaJob(wrapper, { resume = false } = {}) {
    const info = parseMediaTag(wrapper.dataset.tag);
    if (!info) return;
    const { kind, text } = info;
    const messageId = messageIdOf(wrapper);
    const ordinal = Number(wrapper.dataset.ordinal) || 0;
    const key = taskKeyOf(messageId, kind, ordinal, text);
    if (isPending(key)) return;
    if (!Number.isInteger(messageId) || !getMessage(messageId)) return notify.error('没有找到这条消息，无法写回结果', TITLE[kind]);
    // 先占任务表再 await：否则连点两下时第二次会在读设置的空档里通过检查，重复提交。
    startTask(key, { label: '准备中…', maxAgeMs: kind === 'video' ? VIDEO_TASK_MAX_AGE : undefined });
    const chatId = getCurrentChatId();

    const settings = await getSettings();
    const media = readMediaSettings(settings, SECTION[kind]);
    const jobKey = mediaJobKey(kind, text);
    const record = resume ? jobRecord(messageId, jobKey) : null;
    const provider = record?.provider && media.profiles[record.provider] ? record.provider : media.provider;
    const config = mediaRequestConfig(media, provider);
    if (kind === 'audio') {
        // 标签里的 type 在当前服务的音色预设表里且配了音色就用它，否则用默认音色
        config.voice = resolveVoice({ type: info.voiceType, fallback: config.voice, presets: config.presets }).voice;
        config.emotion = info.emotion;
    }
    const blocked = !settings.enabled || !media.enabled ? `${LABEL[kind]}功能已在设置中关闭`
        : !config.key.trim() && needsKey(provider, config.base) ? `请先在面板的「${kind === 'audio' ? '配音' : '视频'}」页填写 API Key` : '';
    if (blocked) {
        endTask(key);
        return notify.warn(blocked, TITLE[kind]);
    }
    setProgress(key, resume ? '查询原任务…' : '提交中…');
    let failure = '';
    try {
        const { downloadMedia, generateMedia } = await import('../media/client.js');
        let resumeHandle = null;
        if (record) {
            // 任务地址来自聊天文件，必须与当前配置的 API 同源才会带上密钥去查。
            const { buildRequest, trustedTaskUrl } = await import('../media/providers.js');
            const plan = { ...buildRequest(kind, config, text), proxy: !!config.proxy };
            resumeHandle = {
                plan, id: record.id,
                links: { status: trustedTaskUrl(record.links?.status, plan.root), result: record.links?.result ? trustedTaskUrl(record.links.result, plan.root) : null },
            };
        }
        const result = await generateMedia(kind, config, text, {
            resume: resumeHandle,
            onTask: (handle) => {
                if (kind === 'video' && !record) saveJobRecord(messageId, chatId, jobKey, { provider, id: handle.id, links: handle.links, startedAt: Date.now() });
            },
            onProgress: (message) => setProgress(key, message),
        });
        if (kind === 'video') setProgress(key, '下载视频…');
        // 自建服务（ComfyUI）直接给回文件，不用再下载
        const blob = result.blob || await downloadMedia(result, kind, { proxy: !!config.proxy });
        setProgress(key, '保存到酒馆…');
        const { uploadMediaFile } = await import('../st/files.js');
        const src = await uploadMediaFile(blob, kind);

        if (getCurrentChatId() !== chatId) {
            notify.warn(`聊天已切换，文件已保存为 ${src}，没有写入原消息`, `${LABEL[kind]}已生成`);
            return;
        }
        // mes 与当前 swipe 各自定位一次再替换，两者内容不同步时也不会改错位置。
        const changed = rewriteMessageText(messageId, (value) => {
            const located = locateMediaTag(value, { kind, text, ordinal });
            return located ? replaceMediaTag(value, located, buildMediaTag(located.info.name, located.info.text, src, located.info)) : value;
        });
        if (!changed) {
            notify.warn(`文件已保存为 ${src}，但消息里找不到原标签（可能已被编辑），没有写入`, `${LABEL[kind]}已生成`);
            return;
        }
        clearJobRecord(messageId, jobKey);
        await commit(messageId);
        const saved = getCurrentChatId() === chatId ? await saveMediaToHistory(src, kind, text) : null;
        if (saved) notify.success(`${LABEL[kind]}已生成并保存到当前聊天媒体库`, TITLE[kind]);
        else notify.warn(`${LABEL[kind]}已保存到聊天，但媒体库登记失败；可点旁边的保存按钮重试`, TITLE[kind]);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        log.error(`${LABEL[kind]}生成失败:`, error);
        // 服务端明确失败或任务已不存在时，续查记录就没用了；网络问题则保留，之后还能继续查。
        if (record && (error.terminal || /^HTTP 4/.test(String(error.message))) && clearJobRecord(messageId, jobKey)) await saveChat();
        else if (!record && error.terminal && clearJobRecord(messageId, jobKey)) await saveChat();
        failure = errMsg(error, '生成失败');
        notify.error(failure, `${LABEL[kind]}生成失败`);
    } finally {
        endTask(key);
        rerenderTask(key, { error: failure });
    }
}

// ---------- 播放 ----------

let playing = null; // { audio, button, wrapper, frame }：同一时间只放一条配音

function stopPlaying() {
    if (!playing) return;
    const { audio, button, wrapper, frame } = playing;
    playing = null;
    cancelAnimationFrame(frame);
    audio.pause();
    button.replaceChildren(icon('fa-play'));
    wrapper?.classList.remove('is-playing');
    wrapper?.style.removeProperty('--st-ai-p');
    paintWave(wrapper?.querySelector('.st_ai_wave'), 0);
}

function togglePlay(button) {
    if (playing?.button === button) return stopPlaying();
    stopPlaying();
    const audio = new Audio(button.dataset.src);
    const wrapper = button.closest('.st_ai_media');
    const wave = wrapper?.querySelector('.st_ai_wave');
    playing = { audio, button, wrapper, frame: 0 };
    button.replaceChildren(icon('fa-pause'));
    wrapper?.classList.add('is-playing');
    // 播放进度逐帧写进 --st-ai-p：进度环、声波、台词下划线都跟着走；停了就不再排下一帧
    const tick = () => {
        if (playing?.audio !== audio) return;
        const progress = audio.duration ? Math.min(1, audio.currentTime / audio.duration) : 0;
        wrapper?.style.setProperty('--st-ai-p', progress.toFixed(4));
        paintWave(wave, progress);
        playing.frame = requestAnimationFrame(tick);
    };
    playing.frame = requestAnimationFrame(tick);
    const reset = () => { if (playing?.audio === audio) stopPlaying(); };
    audio.addEventListener('ended', reset, { once: true });
    audio.addEventListener('error', () => {
        reset();
        if (wrapper) missing(wrapper, '配音文件不存在或无法播放，可重新生成');
    }, { once: true });
    audio.play().catch((error) => { if (error?.name !== 'AbortError') reset(); });
}

export function bindInlineMedia() {
    on(EVENTS.galleryChanged, () => {
        getHistory().then((history) => {
            const saved = new Set(history.filter((item) => item.type === 'audio' || item.type === 'video').map((item) => `${item.type}:${item.mediaUrl}`));
            for (const button of document.querySelectorAll('.st_ai_media_library')) {
                setLibraryButtonState(button, saved.has(`${button.dataset.kind}:${button.dataset.src}`));
            }
        }).catch((error) => log.warn('刷新媒体库按钮失败:', error));
    });
    delegate('click', '.st_ai_media_library', async (e, button) => {
        e.stopPropagation();
        if (button.disabled) return;
        const wrapper = button.closest('.st_ai_media');
        const info = parseMediaTag(wrapper?.dataset.tag);
        if (!info?.src) return notify.error('媒体文件地址无效，无法保存');
        button.disabled = true;
        try {
            const existing = await findHistoryByMediaUrl(info.src, info.kind);
            if (existing) {
                setLibraryButtonState(button, true);
                const { activateTab } = await import('../ui/tabs.js');
                await activateTab('gallery');
                return;
            }
            const saved = await saveMediaToHistory(info.src, info.kind, info.text);
            if (!saved) return notify.error('保存到媒体库失败');
            setLibraryButtonState(button, true);
            notify.success('已保存到媒体库');
        } catch (error) {
            log.error('保存到媒体库失败:', error);
            notify.error(errMsg(error, '保存到媒体库失败'));
        } finally {
            button.disabled = false;
        }
    });
    delegate('click', '.st_ai_media_gen', (e, button) => {
        e.stopPropagation();
        const wrapper = button.closest('.st_ai_media');
        if (wrapper) runMediaJob(wrapper, { resume: button.dataset.resume === '1' });
    });
    delegate('click', '.st_ai_media_regen', (e, button) => {
        e.stopPropagation();
        const wrapper = button.closest('.st_ai_media');
        if (!wrapper) return;
        if (parseMediaTag(wrapper.dataset.tag)?.kind === 'video' && !confirm('重新生成视频会再提交一次计费任务，确定继续？')) return;
        if (playing && wrapper.contains(playing.button)) stopPlaying();
        runMediaJob(wrapper);
    });
    delegate('click', '.st_ai_media_play', (e, button) => {
        e.stopPropagation();
        togglePlay(button);
    });
}

export { stopPlaying };

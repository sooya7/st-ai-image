/**
 * 语音 / 视频设置页。只负责配置：生成入口在聊天正文的 [voice] / [video] 标签上。
 * 第一次切到对应标签页才加载本模块。
 */
import { registerSystemPrompt, scanBurst } from '../inline/scanner.js';
import { mediaRequestConfig, readMediaSettings } from '../media/media-settings.js';
import { PROVIDERS, apiRoot, extraParams } from '../media/providers.js';
import { isFishEndpoint } from '../media/voice-presets.js';
import { getSettings, saveSettings } from '../settings.js';
import { debounce, el } from './dom.js';
import { createVoiceControls } from './voice-settings.js';

const SPEC = {
    speech: {
        title: '语音',
        providers: PROVIDERS.audio,
        usage: '在 AI 回复里用 [voice]台词[/voice]（也可写 [语音]、[配音]）标出要朗读的台词；写成 [voice type="御姐"] 会换成下方音色预设表里对应的音色（AI 按角色自己挑类型）。正文里会出现「配音」按钮，生成后台词旁变成播放键，文件存在酒馆的 user/files。',
        fields: [
            ['base', 'API 根地址'], ['key', 'API Key', 'password'], ['model', '模型'],
            ['voice', '默认音色（标签没写类型、或类型没配音色时用）'],
            ['language', '语言（SSML xml:lang）'], ['extra', '额外参数（JSON 对象）', 'textarea'],
        ],
        hidden: { azure: ['model'], openai: ['language'], fish: ['language'], elevenlabs: ['language'] },
        hints: {
            openai: 'OpenAI 官方允许浏览器直连；第三方兼容中转如不允许跨域，请勾选下方的酒馆代理。用 Fish：地址填 https://api.fish.audio/compat/v1、模型填 fish-audio/s2.1-pro-free，可直连，还能一键填入 Fish 推荐音色。',
            fish: 'Fish 原生接口不允许浏览器直连，必须勾选「通过酒馆代理」；没有代理（如 TauriTavern）时改选「OpenAI / 兼容 TTS」并填 Fish 的兼容接口。模型按 Fish 要求放在请求头，免费档是 s2.1-pro-free。',
            elevenlabs: '允许浏览器直连。Voice ID 在 ElevenLabs 控制台的声音详情里复制。',
            azure: 'API 根地址填资源所在区域的端点，如 https://eastasia.tts.speech.microsoft.com。请求体是 SSML，不能走酒馆代理。',
        },
    },
    video: {
        title: '视频',
        providers: PROVIDERS.video,
        usage: '在 AI 回复里用 [video]画面描述[/video]（也可写 [视频]）标出场景，正文里会出现「生成视频」按钮；生成需要几分钟，完成后原位显示播放器，文件存在酒馆的 user/files。',
        fields: [
            ['base', 'API 根地址'], ['key', 'API Key', 'password'], ['model', '模型 / 模型路径'],
            ['size', '尺寸 / 比例'], ['seconds', '时长（秒）'], ['extra', '额外参数（JSON 对象）', 'textarea'],
        ],
        hidden: { fal: ['size', 'seconds'], replicate: ['size', 'seconds'] },
        hints: {
            runway: 'Runway 不允许浏览器直连（跨域被拒），必须勾选「通过酒馆代理」。',
            replicate: 'Replicate 不允许浏览器直连，必须勾选「通过酒馆代理」。模型填 owner/name 或 owner/name:version，时长、比例等写进额外参数。',
            agnes: 'Agnes AI 允许浏览器直连。尺寸填 720P 这类分辨率档位（不是宽x高），横竖屏可在额外参数写 {"aspect_ratio":"9:16"}。',
            fal: 'fal 允许浏览器直连。模型填平台路径（如 fal-ai/xxx/text-to-video），时长、比例按模型文档写进额外参数。',
            openai: '/videos 兼容服务（官方 Sora 已计划停用），JSON 请求；服务不允许跨域时勾选酒馆代理。',
        },
    },
};

export async function mountMediaSettings(root, section) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    const spec = SPEC[section];
    const state = readMediaSettings(await getSettings(), section);
    const id = (name) => `st_ai_${section}_${name}`;
    const field = (label, node, extra = []) => el('div', { class: 'st_ai_field', dataset: { field: node.dataset.key || '' } }, [el('label', { for: node.id, text: label }), node, ...extra]);
    const checkbox = (name, text) => {
        const input = el('input', { type: 'checkbox', id: id(name) });
        return { input, node: el('div', { class: 'st_ai_field' }, [el('label', { class: 'st_ai_checkbox' }, [input, el('span', { text })])]) };
    };

    const enabled = checkbox('enabled', `启用${spec.title}标签（在正文里显示生成按钮）`);
    const provider = el('select', { id: id('provider'), class: 'st_ai_input' },
        Object.entries(spec.providers).map(([value, text]) => el('option', { value, text })));
    const hint = el('p', { class: 'st_ai_speech_hint' });
    const warning = el('p', { class: 'st_ai_speech_hint st_ai_media_warning', role: 'status', 'aria-live': 'polite' });
    const inputs = {};
    const saveSoon = debounce(() => save(), 400);
    const voice = section === 'speech' ? createVoiceControls({
        id,
        profile: () => state.profiles[state.provider],
        config: () => mediaRequestConfig(JSON.parse(JSON.stringify(state)), state.provider),
        isFish: () => isFishEndpoint(state.provider, state.profiles[state.provider].base),
        onChange: () => saveSoon(),
        onCommit: () => save(),
        warning,
    }) : null;
    const profileFields = spec.fields.map(([key, label, type]) => {
        const node = type === 'textarea'
            ? el('textarea', { id: id(key), class: 'st_ai_textarea', rows: 2, maxlength: 4096, dataset: { key }, placeholder: '例如 {"seed": 1}；不要填写密钥' })
            : el('input', { id: id(key), type: type || 'text', class: 'st_ai_input', autocomplete: 'off', dataset: { key } });
        inputs[key] = node;
        if (key === 'voice' && voice) return [voice.defaultField(label, node), voice.presetsField];
        return field(label, node);
    }).flat();
    const proxy = checkbox('proxy', '通过酒馆代理请求（需在酒馆 config.yaml 设置 enableCorsProxy: true 并重启）');
    const timeout = section === 'video'
        ? el('input', { id: id('timeout'), type: 'number', min: 60, max: 1800, step: 30, class: 'st_ai_input' }) : null;

    const form = el('form', { class: 'st_ai_speech_form', onsubmit: (e) => e.preventDefault() }, [
        el('p', { class: 'st_ai_speech_hint', text: spec.usage }),
        enabled.node,
        field('服务', provider),
        hint,
        ...profileFields,
        proxy.node,
        timeout ? field('最长等待（秒）', timeout) : null,
        el('p', { class: 'st_ai_speech_hint', text: `让 AI 自动写${spec.title}标签的系统提示词在「提示词」页。` }),
        el('p', { class: 'st_ai_speech_hint', text: '密钥与图片 API Key 一样保存在酒馆设置里。停止等待不会取消服务端任务，生成失败不会自动重试。' }),
        warning,
    ]);

    const fill = () => {
        enabled.input.checked = state.enabled;
        provider.value = state.provider;
        const profile = state.profiles[state.provider];
        const hidden = spec.hidden[state.provider] || [];
        for (const [key, node] of Object.entries(inputs)) {
            node.value = profile[key] ?? '';
            node.closest('.st_ai_field').hidden = hidden.includes(key);
        }
        hint.textContent = spec.hints[state.provider] || '';
        proxy.input.checked = state.proxy;
        if (timeout) timeout.value = state.timeout;
        voice?.sync();
    };

    /** 只提示，不拦截保存：用户可能正在输入到一半。真正请求时还会再校验一次。 */
    const validate = () => {
        const profile = state.profiles[state.provider];
        const problems = [];
        try { if (profile.base) apiRoot(profile.base, state.provider); } catch (e) { problems.push(`API 地址：${e.message}`); }
        try { extraParams(profile.extra); } catch (e) { problems.push(`额外参数：${e.message}`); }
        if (state.proxy && state.provider === 'azure') problems.push('当前服务不能走酒馆代理，请取消勾选');
        warning.textContent = problems.join('；');
    };

    const save = async ({ rescan = false } = {}) => {
        validate();
        const current = await getSettings();
        // 提示词开关和文本归提示词页管，从最新存档里取，不用本页打开时的旧副本覆盖
        const { autoInject, prompt } = readMediaSettings(current, section);
        await saveSettings({ ...current, [section]: { ...JSON.parse(JSON.stringify(state)), autoInject, prompt } });
        registerSystemPrompt();
        if (rescan) scanBurst();
    };

    enabled.input.addEventListener('change', () => { state.enabled = enabled.input.checked; save({ rescan: true }); });
    provider.addEventListener('change', () => { state.provider = provider.value; fill(); save(); });
    for (const [key, node] of Object.entries(inputs)) {
        node.addEventListener('input', () => {
            state.profiles[state.provider][key] = node.value.trim();
            if (key === 'base' || key === 'voice') voice?.sync({ keepCustom: key === 'voice' });
            saveSoon();
        });
    }
    proxy.input.addEventListener('change', () => { state.proxy = proxy.input.checked; save(); });
    timeout?.addEventListener('change', () => {
        const seconds = Math.min(1800, Math.max(60, Number(timeout.value) || 600));
        timeout.value = String(seconds);
        state.timeout = String(seconds);
        save();
    });

    fill();
    validate();
    root.replaceChildren(form);
}

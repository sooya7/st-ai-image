/**
 * 语音 / 视频设置页。只负责配置：生成入口在聊天正文的 [voice] / [video] 标签上。
 * 第一次切到对应标签页才加载本模块。
 */
import { registerSystemPrompt, scanBurst } from '../inline/scanner.js';
import { mediaRequestConfig, readMediaSettings } from '../media/media-settings.js';
import { PROVIDERS, apiRoot, extraParams } from '../media/providers.js';
import { isFishEndpoint } from '../media/voice-presets.js';
import { isTauriTavern, providerOptions } from '../media/availability.js';
import { SELF_HOSTED, serviceRoot } from '../media/selfhosted.js';
import { createWorkflowLibrary } from './workflow-library.js';
import { getSettings, saveSettings } from '../settings.js';
import { debounce, el } from './dom.js';
import { buildPromptSection } from './prompt-section.js';
import { createVoiceControls } from './voice-settings.js';

const SPEC = {
    speech: {
        title: '语音',
        kind: 'audio',
        providers: PROVIDERS.audio,
        usage: '在 AI 回复里用 [voice]台词[/voice]（也可写 [语音]、[配音]）标出要朗读的台词；写成 [voice type="御姐"] 会换成下方音色预设表里对应的音色（AI 按角色自己挑类型）。正文里会出现「配音」按钮，生成后台词旁变成播放键，文件存在酒馆的 user/files。',
        fields: [
            ['base', 'API 根地址'], ['key', 'API Key', 'password'], ['model', '模型'],
            ['voice', '默认音色（标签没写类型、或类型没配音色时用）'],
            ['language', '语言（SSML xml:lang）'], ['extra', '额外参数（JSON 对象）', 'textarea'],
        ],
        hidden: { azure: ['model'], openai: ['language'], fish: ['language'], elevenlabs: ['language'] },
        hints: {
            openai: '/audio/speech 协议：OpenAI 官方、Fish 的兼容接口和大多数中转站都走这里。用 Fish 点上面的「Fish Audio」一键填地址和免费模型，再一键填入推荐音色；直连就能用，TauriTavern 也行。',
            fish: 'Fish 原生接口不允许浏览器直连，必须勾选「通过酒馆代理」，TauriTavern 里用不了。一般直接用「OpenAI 兼容 TTS」里的 Fish 一键填写就行，效果一样。',
            elevenlabs: '允许浏览器直连。Voice ID 在 ElevenLabs 控制台的声音详情里复制。',
            azure: 'API 根地址填资源所在区域的端点，如 https://eastasia.tts.speech.microsoft.com。请求体是 SSML，不能走酒馆代理。',
        },
    },
    video: {
        title: '视频',
        kind: 'video',
        providers: PROVIDERS.video,
        usage: '在 AI 回复里用 [video]画面描述[/video]（也可写 [视频]）标出场景，正文里会出现「生成视频」按钮；生成需要几分钟，完成后原位显示播放器，文件存在酒馆的 user/files。',
        fields: [
            ['base', 'API 根地址'], ['key', 'API Key', 'password'], ['model', '模型 / 模型路径'],
            ['size', '尺寸 / 比例'], ['seconds', '时长（秒）'],
            ['workflow', 'ComfyUI 工作流（在 ComfyUI 里「导出 (API)」得到的 JSON）', 'textarea'],
            ['extra', '额外参数（JSON 对象）', 'textarea'],
        ],
        hidden: { fal: ['size', 'seconds'], replicate: ['size', 'seconds'], comfyui: ['key'] },
        only: { workflow: ['comfyui'] },
        hints: {
            runway: 'Runway 不允许浏览器直连（跨域被拒），必须勾选「通过酒馆代理」，TauriTavern 里用不了。',
            replicate: 'Replicate 只允许 localhost 打开的酒馆直连，其他地址要勾选「通过酒馆代理」，TauriTavern 里用不了。模型填 owner/name 或 owner/name:version，时长、比例等写进额外参数。',
            agnes: 'Agnes AI 允许浏览器直连。尺寸填 720P 这类分辨率档位（不是宽x高），横竖屏可在额外参数写 {"aspect_ratio":"9:16"}。',
            fal: 'fal 允许浏览器直连，一个 Key 能用可灵、万相、Veo、Seedance 等很多视频模型。模型填平台路径（如 fal-ai/kling-video/v2.1/standard/text-to-video），时长、比例按模型文档写进额外参数。',
            openai: '/videos 协议的兼容服务（中转站等），JSON 请求。OpenAI 官方不允许浏览器直连，而且 Sora 已计划停用。',
            comfyui: '自建 ComfyUI，地址默认 http://127.0.0.1:8188，不需要 Key。工作流里要变的值改成占位符：%prompt%、%negative_prompt%、%seed%（随机）、%width% %height%（按尺寸，填 832x480 这种）、%seconds%、%fps%（默认 16）、%frames%（秒数×帧率+1）、%MODEL_NAME%（模型栏）；中文 %提示词% %种子% %视频秒数% 等也认，额外参数里的键也能当占位符。输出节点用 VHS Video Combine 或 SaveVideo。默认经酒馆后端转发，完成前看不到进度。',
        },
    },
};

export async function mountMediaSettings(root, section) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    const spec = SPEC[section];
    const settings = await getSettings();
    const state = readMediaSettings(settings, section);
    const id = (name) => `st_ai_${section}_${name}`;
    const field = (label, node, extra = []) => el('div', { class: 'st_ai_field', dataset: { field: node.dataset.key || '' } }, [el('label', { for: node.id, text: label }), node, ...extra]);
    const checkbox = (name, text) => {
        const input = el('input', { type: 'checkbox', id: id(name) });
        return { input, node: el('div', { class: 'st_ai_field' }, [el('label', { class: 'st_ai_checkbox' }, [input, el('span', { text })])]) };
    };

    const enabled = checkbox('enabled', `启用${spec.title}标签（在正文里显示生成按钮）`);
    const tauri = isTauriTavern();
    const provider = el('select', { id: id('provider'), class: 'st_ai_input' });
    // 常用的在上面，不常用或要开跨域代理的放「其他」；TauriTavern 里不列只能走代理的
    const renderProviders = () => {
        const options = providerOptions(spec.kind, spec.providers, state.provider, { tauri });
        const option = (o) => el('option', { value: o.value, text: o.text });
        const more = options.filter((o) => o.more);
        provider.replaceChildren(...options.filter((o) => !o.more).map(option),
            ...(more.length ? [el('optgroup', { label: tauri ? '其他' : '其他（多数要开酒馆跨域代理）' }, more.map(option))] : []));
    };
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
            ? el('textarea', key === 'workflow'
                ? { id: id(key), class: 'st_ai_textarea', rows: 6, maxlength: 400000, spellcheck: 'false', dataset: { key }, placeholder: '{"3": {"class_type": "...", "inputs": {"text": "%prompt%"}}, ...}' }
                : { id: id(key), class: 'st_ai_textarea', rows: 2, maxlength: 4096, dataset: { key }, placeholder: '例如 {"seed": 1}；不要填写密钥' })
            : el('input', { id: id(key), type: type || 'text', class: 'st_ai_input', autocomplete: 'off', dataset: { key } });
        inputs[key] = node;
        if (key === 'voice' && voice) return [voice.defaultField(label, node), voice.presetsField];
        if (key === 'workflow') {
            // 视频工作流库：选中的那份写回 profile.workflow，生成直接用
            const status = el('p', { class: 'st_ai_speech_hint', id: id('workflow_status'), role: 'status', 'aria-live': 'polite' });
            const comfy = () => state.profiles.comfyui;
            const lib = createWorkflowLibrary({
                id: id('workflow_lib'), textarea: node, status,
                read: () => ({ items: comfy().workflows, active: comfy().workflowId }),
                write: ({ items, active }) => { Object.assign(comfy(), { workflows: items, workflowId: active, workflow: items[active] ?? '' }); return save(); },
                exportName: 'st-ai-image-ComfyUI视频工作流.json',
            });
            return el('div', { class: 'st_ai_field', dataset: { field: key } }, [el('label', { for: node.id, text: label }), lib.node, node, status]);
        }
        return field(label, node);
    }).flat();
    // 一键填写：Fish 的 OpenAI 兼容接口（直连可用，免费模型）
    const quick = section === 'speech' ? el('div', { class: 'st_ai_field st_ai_inline_row st_ai_quick_fill' }, [
        el('span', { class: 'st_ai_speech_hint', text: '一键填写：' }),
        el('button', {
            type: 'button', id: id('quick_fish'), class: 'st_ai_btn st_ai_library_btn', text: 'Fish Audio',
            title: '地址填 Fish 的兼容接口，模型填免费档；Key 还要自己填',
            onclick: () => {
                const profile = state.profiles.openai;
                profile.base = 'https://api.fish.audio/compat/v1';
                if (!profile.model || profile.model === 'tts-1') profile.model = 'fish-audio/s2.1-pro-free';
                fill();
                save();
            },
        }),
    ]) : null;
    const proxy = checkbox('proxy', '通过酒馆代理请求（需在酒馆 config.yaml 设置 enableCorsProxy: true 并重启）');
    // 自建服务不走 CORS 代理，默认经酒馆后端转发；这个开关改成浏览器直连
    const direct = section === 'video' ? checkbox('direct', '浏览器直连 ComfyUI（能看到等待时间；要给 ComfyUI 加 --enable-cors-header）') : null;
    const timeout = section === 'video'
        ? el('input', { id: id('timeout'), type: 'number', min: 60, max: 1800, step: 30, class: 'st_ai_input' }) : null;

    const form = el('form', { class: 'st_ai_speech_form', onsubmit: (e) => e.preventDefault() }, [
        el('p', { class: 'st_ai_speech_hint', text: spec.usage }),
        enabled.node,
        field('服务', provider),
        quick,
        hint,
        ...profileFields,
        proxy.node,
        direct?.node,
        timeout ? field('最长等待（秒）', timeout) : null,
        buildPromptSection(section, settings),
        el('p', { class: 'st_ai_speech_hint', text: '密钥与图片 API Key 一样保存在酒馆设置里。停止等待不会取消服务端任务，生成失败不会自动重试。' }),
        warning,
    ]);

    const fill = () => {
        enabled.input.checked = state.enabled;
        renderProviders();
        provider.value = state.provider;
        if (quick) quick.hidden = state.provider !== 'openai';
        const profile = state.profiles[state.provider];
        const hidden = spec.hidden[state.provider] || [];
        for (const [key, node] of Object.entries(inputs)) {
            node.value = profile[key] ?? '';
            const only = spec.only?.[key];
            node.closest('.st_ai_field').hidden = hidden.includes(key) || (only ? !only.includes(state.provider) : false);
        }
        const selfHosted = SELF_HOSTED.has(state.provider);
        // TauriTavern 没有酒馆代理：不显示这个开关；已经勾上的留着让人取消
        proxy.node.hidden = selfHosted || (tauri && !state.proxy);
        if (direct) {
            direct.node.hidden = !selfHosted;
            direct.input.checked = profile.direct === '1';
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
        if (SELF_HOSTED.has(state.provider)) {
            try { serviceRoot(profile.base, state.provider); } catch (e) { problems.push(`地址：${e.message}`); }
        } else try { if (profile.base) apiRoot(profile.base, state.provider); } catch (e) { problems.push(`API 地址：${e.message}`); }
        try { extraParams(profile.extra); } catch (e) { problems.push(`额外参数：${e.message}`); }
        if (state.proxy && state.provider === 'azure') problems.push('当前服务不能走酒馆代理，请取消勾选');
        if (state.proxy && tauri && !SELF_HOSTED.has(state.provider)) problems.push('TauriTavern 没有酒馆代理，请取消勾选「通过酒馆代理请求」');
        warning.textContent = problems.join('；');
    };

    const save = async ({ rescan = false } = {}) => {
        validate();
        const current = await getSettings();
        // 提示词开关和文本由本页底部的提示词区块单独保存，从最新存档里取，不用本页打开时的旧副本覆盖
        const { autoInject, prompt } = readMediaSettings(current, section);
        await saveSettings({ ...current, [section]: { ...JSON.parse(JSON.stringify(state)), autoInject, prompt } });
        registerSystemPrompt();
        if (rescan) scanBurst();
    };

    enabled.input.addEventListener('change', () => { state.enabled = enabled.input.checked; save({ rescan: true }); });
    provider.addEventListener('change', () => { state.provider = provider.value; fill(); save(); });
    for (const [key, node] of Object.entries(inputs)) {
        if (key === 'workflow') continue; // 工作流库自己保存
        node.addEventListener('input', () => {
            state.profiles[state.provider][key] = node.value.trim();
            if (key === 'base' || key === 'voice') voice?.sync({ keepCustom: key === 'voice' });
            saveSoon();
        });
    }
    proxy.input.addEventListener('change', () => { state.proxy = proxy.input.checked; fill(); save(); });
    direct?.input.addEventListener('change', () => { state.profiles[state.provider].direct = direct.input.checked ? '1' : ''; save(); });
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

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
import { card, debounce, el, helpBox } from './dom.js';
import { buildPromptSection } from './prompt-section.js';
import { createVoiceControls } from './voice-settings.js';

const SPEC = {
    speech: {
        title: '语音',
        subtitle: '台词旁出现「生成语音」按钮，点一下就生成',
        kind: 'audio',
        providers: PROVIDERS.audio,
        usage: '在 AI 回复里用 [voice]台词[/voice]（也可写 [语音]、[配音]）标出要朗读的台词；写成 [voice type="御姐"] 会换成下方音色预设表里对应的音色（AI 按角色自己挑类型）。正文里会出现「生成语音」按钮，生成后台词旁变成播放键，文件存在酒馆的 user/files。',
        fields: [
            ['base', 'API 根地址'], ['key', 'API Key', 'password'], ['model', '模型'],
            ['voice', '默认音色（标签没写类型、或类型没配音色时用）'],
            ['language', '语言'], ['extra', '额外参数（JSON 对象）', 'textarea'],
        ],
        hidden: { azure: ['model'], openai: ['language'], fish: ['language'], elevenlabs: ['language'], gemini: ['language'], volcengine: ['language'], gptsovits: ['key', 'model'] },
        hints: {
            openai: '/audio/speech 协议：OpenAI 官方、Fish 的兼容接口和大多数中转站都走这里。用 Fish 点上面的「Fish Audio」一键填地址和免费模型，再一键填入推荐音色；直连就能用，TauriTavern 也行。',
            fish: 'Fish 原生接口不允许浏览器直连，必须勾选「通过酒馆代理」，TauriTavern 里用不了。一般直接用「OpenAI 兼容 TTS」里的 Fish 一键填写就行，效果一样。',
            elevenlabs: '允许浏览器直连。Voice ID 在 ElevenLabs 控制台的声音详情里复制。',
            azure: 'API 根地址填资源所在区域的端点，如 https://eastasia.tts.speech.microsoft.com。请求体是 SSML，不能走酒馆代理。语言填 SSML 的 xml:lang，如 zh-CN。',
            minimax: 'MiniMax 开放平台的 Key，允许浏览器直连。音色填 voice_id，如 female-shaonv、male-qn-qingse、female-yujie、Chinese (Mandarin)_News_Anchor；语言填 language_boost（auto / Chinese / Chinese,Yue 等）。海外账号把地址改成 https://api.minimax.io。语速、情绪写进额外参数：{"voice_setting":{"speed":1.1,"emotion":"happy"}}。',
            dashscope: '阿里云百炼的 Key，允许浏览器直连。模型 qwen3-tts-flash 等用 Qwen-TTS（音色 Cherry、Ethan、Serena、Dylan 北京话、Jada 上海话、Sunny 四川话）；模型填 cosyvoice-v3-flash 等则走 CosyVoice（音色如 longanhuan_v3.6）。语言填 Chinese / English / Auto。国际站把地址改成 https://dashscope-intl.aliyuncs.com，Key 分地域不通用。',
            gemini: 'Google AI Studio 的 Key，允许浏览器直连。音色填 Kore、Puck、Zephyr、Charon、Aoede 等（共 30 个）。gemini-3.8 起直接回 WAV；旧的 2.5 / 3.1 预览模型也能用。',
            volcengine: '火山引擎豆包语音（v1 HTTP 接口）不允许浏览器跨域：只能在网页版酒馆勾选「通过酒馆代理」，TauriTavern 里用不了。Key 写成「APP ID:Access Token」，模型栏是 cluster（默认 volcano_tts），音色填 voice_type。一次最多约 340 个汉字。',
            gptsovits: 'GPT-SoVITS 的 api_v2（python api_v2.py，默认端口 9880）。它没开跨域，要在网页版酒馆勾选「通过酒馆代理」。音色栏填参考音频在那台机器上的路径，语言填 text_lang（zh / ja / en），参考文本写进额外参数：{"prompt_text":"参考音频说的话"}。',
        },
    },
    video: {
        title: '视频',
        subtitle: '正文出现「生成视频」按钮，几分钟后原位播放',
        kind: 'video',
        providers: PROVIDERS.video,
        usage: '在 AI 回复里用 [video]画面描述[/video]（也可写 [视频]）标出场景，正文里会出现「生成视频」按钮；生成需要几分钟，完成后原位显示播放器，文件存在酒馆的 user/files。',
        fields: [
            ['base', 'API 根地址'], ['key', 'API Key', 'password'], ['model', '模型 / 模型路径'],
            ['size', '尺寸 / 比例'], ['seconds', '时长（秒）'],
            ['workflow', 'ComfyUI 工作流（在 ComfyUI 里「导出 (API)」得到的 JSON）', 'textarea'],
            ['extra', '额外参数（JSON 对象）', 'textarea'],
        ],
        hidden: { fal: ['size', 'seconds'], replicate: ['size', 'seconds'], comfyui: ['key'], siliconflow: ['seconds'] },
        only: { workflow: ['comfyui'] },
        hints: {
            runway: 'Runway 不允许浏览器直连（跨域被拒），必须勾选「通过酒馆代理」，TauriTavern 里用不了。',
            replicate: 'Replicate 只允许 localhost 打开的酒馆直连，其他地址要勾选「通过酒馆代理」，TauriTavern 里用不了。模型填 owner/name 或 owner/name:version，时长、比例等写进额外参数。',
            agnes: 'Agnes 已并入「/videos 兼容服务」。因为那一组已经填了别的服务的 Key，这里先照旧能用；要合并，就改选「/videos 兼容服务」，点「一键填写：Agnes AI」，再填 Key。',
            fal: 'fal 允许浏览器直连，一个 Key 能用可灵、万相、Veo、Seedance 等很多视频模型。模型填平台路径（如 fal-ai/kling-video/v2.1/standard/text-to-video），时长、比例按模型文档写进额外参数。',
            openai: '/videos 协议的兼容服务（Agnes、中转站等），JSON 请求。用 Agnes 点上面的「Agnes AI」一键填写；地址是 agnes-ai.com 时自动加 mode: text，尺寸填 720P 这类档位（不是宽x高），横竖屏在额外参数写 {"aspect_ratio":"9:16"}。OpenAI 官方不允许浏览器直连，而且 Sora 已计划停用。',
            ark: '火山方舟的 API Key，允许浏览器直连。模型填 doubao-seedance-2-0-fast-260128、doubao-seedance-2-0-260128、doubao-seedance-1-0-pro-250528 等（要先在方舟控制台开通）。尺寸填 480p / 720p / 1080p，或 16:9 这类比例；时长 4–15 秒（1.0 系列 2–12）。链接 24 小时有效，生成完会马上存进酒馆。',
            minimax: 'MiniMax 开放平台的 Key，允许浏览器直连。模型 MiniMax-Hailuo-2.3 / MiniMax-Hailuo-02：尺寸填 768P 或 1080P，时长 6 或 10（10 秒只能 768P）；MiniMax-H3 系列走新接口，尺寸 768P / 2K，时长 4–15，比例写进额外参数 {"ratio":"16:9"}。海外账号把地址改成 https://api.minimax.io。',
            dashscope: '阿里云百炼的 Key，允许浏览器直连。模型 wan2.7-t2v：尺寸填 720p / 1080p 或比例，时长 2–15；wan2.6 及以前的模型尺寸按像素（填 1280x720），时长看模型。国际站把地址改成 https://dashscope-intl.aliyuncs.com。',
            veo: 'Google AI Studio 的 Key，允许浏览器直连。模型 veo-3.1-fast-generate-preview / veo-3.1-generate-preview / veo-3.1-lite-generate-preview；尺寸填 720p / 1080p（1080p 要 8 秒）或 9:16，时长 4 / 6 / 8。',
            zhipu: '智谱开放平台的 Key，允许浏览器直连。模型 cogvideox-3 / cogvideox-flash / viduq1-text；尺寸填 1920x1080 这类像素，时长 5 或 10。',
            siliconflow: '硅基流动的 Key，允许浏览器直连。模型 Wan-AI/Wan2.2-T2V-A14B 等；尺寸 1280x720 / 720x1280 / 960x960。结果链接只保留几分钟，生成完会马上存进酒馆。',
            luma: 'Luma 新版 API（agents.lumalabs.ai）的 Key，允许浏览器直连。模型 ray-3.2；尺寸填 360p–1080p 或比例，时长 5 或 10。',
            kling: '可灵不允许浏览器跨域：只能在网页版酒馆勾选「通过酒馆代理」，TauriTavern 里用不了（想在 TauriTavern 里用可灵，走 fal）。Key 填新版的 API Key；也可以填「AccessKey:SecretKey」走旧版接口（模型填 kling-v2-1 这类）。',
            vidu: 'Vidu 不允许浏览器跨域：只能在网页版酒馆勾选「通过酒馆代理」，TauriTavern 里用不了。模型 viduq3-turbo / viduq3-pro / viduq2；国际站把地址改成 https://api.vidu.com。',
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
    const voiceFields = [];
    const profileFields = spec.fields.map(([key, label, type]) => {
        const node = type === 'textarea'
            ? el('textarea', key === 'workflow'
                ? { id: id(key), class: 'st_ai_textarea', rows: 6, maxlength: 400000, spellcheck: 'false', dataset: { key }, placeholder: '{"3": {"class_type": "...", "inputs": {"text": "%prompt%"}}, ...}' }
                : { id: id(key), class: 'st_ai_textarea', rows: 2, maxlength: 4096, dataset: { key }, placeholder: '例如 {"seed": 1}；不要填写密钥' })
            : el('input', { id: id(key), type: type || 'text', class: 'st_ai_input', autocomplete: 'off', dataset: { key } });
        inputs[key] = node;
        if (key === 'voice' && voice) { voiceFields.push(voice.defaultField(label, node), voice.presetsField); return []; }
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
    // 一键填写：Fish 的 OpenAI 兼容接口（直连可用，免费模型）、Agnes 的 /videos 接口。都只填地址和默认值，Key 自己填
    const QUICK = {
        speech: [['fish', 'Fish Audio', (p) => {
            p.base = 'https://api.fish.audio/compat/v1';
            if (!p.model || p.model === 'tts-1') p.model = 'fish-audio/s2.1-pro-free';
        }]],
        video: [['agnes', 'Agnes AI', (p) => {
            Object.assign(p, { base: 'https://apihub.agnes-ai.com/v1', model: 'agnes-video-2.5-flash', size: '720P', seconds: '5' });
        }]],
    };
    const quick = QUICK[section] ? el('div', { class: 'st_ai_field st_ai_inline_row st_ai_quick_fill' }, [
        el('span', { class: 'st_ai_speech_hint', text: '一键填写：' }),
        ...QUICK[section].map(([key, text, apply]) => el('button', {
            type: 'button', id: id(`quick_${key}`), class: 'st_ai_btn st_ai_library_btn', text,
            title: '只填地址、模型等默认值，Key 还要自己填',
            onclick: () => { apply(state.profiles.openai); fill(); save(); },
        })),
    ]) : null;
    const proxy = checkbox('proxy', '通过酒馆代理请求（需在酒馆 config.yaml 设置 enableCorsProxy: true 并重启）');
    // 自建服务不走 CORS 代理，默认经酒馆后端转发；这个开关改成浏览器直连
    const direct = section === 'video' ? checkbox('direct', '浏览器直连 ComfyUI（能看到等待时间；要给 ComfyUI 加 --enable-cors-header）') : null;
    const timeout = section === 'video'
        ? el('input', { id: id('timeout'), type: 'number', min: 60, max: 1800, step: 30, class: 'st_ai_input' }) : null;

    const form = el('form', { class: 'st_ai_speech_form', onsubmit: (e) => e.preventDefault() }, [
        card({ iconName: 'fa-plug', title: `${spec.title}服务`, sub: spec.subtitle, tone: 'mint' }, [
            helpBox(`${spec.usage}\n\n密钥与图片 API Key 一样保存在酒馆设置里。停止等待不会取消服务端任务，生成失败不会自动重试。`, '用法'),
            enabled.node,
            field('服务', provider),
            quick,
            helpBox(hint, '这个服务怎么填'),
        ]),
        card({ iconName: 'fa-key', title: '连接与参数', sub: '地址、密钥、模型，每个服务各记一份', tone: 'sky' }, profileFields),
        voiceFields.length ? card({ iconName: 'fa-microphone-lines', title: '音色', sub: '默认音色，以及 AI 按角色挑选的音色类型', tone: 'rose' }, voiceFields) : null,
        card({ iconName: 'fa-globe', title: '网络', sub: '跨域代理与等待时间', tone: 'amber', autohide: true }, [
            proxy.node,
            direct?.node,
            timeout ? field('最长等待（秒）', timeout) : null,
        ]),
        warning,
        buildPromptSection(section, settings),
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

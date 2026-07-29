/**
 * 设置页：字段双向绑定 + API 预设 + 模型列表。
 * 所有写入都走 settings.js，这里不直接碰存储。
 */
import { fetchModelList } from '../api/images.js';
import { LIMITS } from '../core/constants.js';
import { errMsg, notify } from '../core/notify.js';
import { isValidApiBaseUrl } from '../core/text.js';
import {
    getPresets, getSettings, removePreset, saveSettings, updateSetting, upsertPreset,
} from '../settings.js';
import { debounce, el, qs, replaceContent, setBusy } from './dom.js';

/** 表单字段 → 设置键。text/textarea 走防抖 input，其余走 change。 */
const FIELDS = [
    { id: 'st_gpt_image_api_base', key: 'apiBase', kind: 'text' },
    { id: 'st_gpt_image_api_key', key: 'apiKey', kind: 'text' },
    { id: 'st_gpt_image_model', key: 'model', kind: 'text' },
    { id: 'st_gpt_image_system_prompt_text', key: 'systemPrompt', kind: 'text' },
    { id: 'st_gpt_image_extra_prompt', key: 'extraPrompt', kind: 'text' },
    { id: 'st_gpt_image_negative_prompt', key: 'negativePrompt', kind: 'text' },
    { id: 'st_gpt_image_enabled', key: 'enabled', kind: 'bool' },
    { id: 'st_gpt_image_auto_detect', key: 'autoDetect', kind: 'bool' },
    { id: 'st_gpt_image_auto_inject_prompt', key: 'autoInjectPrompt', kind: 'bool' },
    { id: 'st_gpt_image_size', key: 'size', kind: 'select' },
    { id: 'st_gpt_image_quality', key: 'quality', kind: 'select' },
];

const [MIN_SEC, MAX_SEC] = LIMITS.timeoutRangeSec;
const clampSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return Math.round(LIMITS.imageGenTimeoutMs / 1000);
    return Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(seconds)));
};

/** 把设置写进表单控件。 */
function fillForm(settings) {
    for (const field of FIELDS) {
        const node = qs(`#${field.id}`);
        if (!node) continue;
        if (field.kind === 'bool') node.checked = Boolean(settings[field.key]);
        else node.value = String(settings[field.key] ?? '');
    }
    const timeout = qs('#st_gpt_image_timeout');
    if (timeout) timeout.value = String(clampSeconds(Number(settings.imageTimeout || LIMITS.imageGenTimeoutMs) / 1000));
    togglePromptContainer(settings);
}

/** 关掉自动注入时，系统提示词编辑框没有意义，直接隐藏。 */
function togglePromptContainer(settings) {
    qs('#st_ai_prompt_container')?.classList.toggle('st_ai_hidden', !settings.autoInjectPrompt);
}

function renderPresetOptions(selected = '') {
    const select = qs('#st_gpt_preset_select');
    if (!select) return;
    const names = Object.keys(getPresets()).sort();
    replaceContent(select, el('option', { value: '', text: names.length ? '— 选择预设 —' : '— 暂无预设 —' }),
        ...names.map((name) => el('option', { value: name, text: name })));
    select.value = names.includes(selected) ? selected : '';
}

function renderModelOptions(models) {
    const select = qs('#st_gpt_model_list');
    if (!select) return;
    replaceContent(select, el('option', { value: '', text: `— 共 ${models.length} 个模型 —` }),
        ...models.map((m) => el('option', { value: m.id, text: m.name || m.id })));
    select.classList.toggle('st_ai_hidden', models.length === 0);
}

/**
 * 绑定设置页所有交互。
 * @param {(key: string) => void} [onChange] 设置变更后的回调（index.js 用来重算提示词注入）
 */
export async function bindSettingsForm(onChange) {
    const settings = await getSettings();
    fillForm(settings);
    renderPresetOptions();
    renderModelOptions([]);

    const commit = async (key, value) => {
        const next = await updateSetting(key, value);
        if (key === 'autoInjectPrompt') togglePromptContainer(next);
        onChange?.(key);
    };

    for (const field of FIELDS) {
        const node = qs(`#${field.id}`);
        if (!node) continue;
        if (field.kind === 'bool') {
            node.addEventListener('change', () => commit(field.key, node.checked));
        } else if (field.kind === 'select') {
            node.addEventListener('change', () => commit(field.key, node.value));
        } else {
            const save = debounce(() => {
                const value = node.value.trim();
                if (field.key === 'apiBase' && !isValidApiBaseUrl(value)) {
                    notify.warn('API 地址需要以 http:// 或 https:// 开头');
                    return;
                }
                commit(field.key, value);
            }, 400);
            node.addEventListener('input', save);
        }
    }

    const timeout = qs('#st_gpt_image_timeout');
    timeout?.addEventListener('change', () => {
        const seconds = clampSeconds(timeout.value);
        timeout.value = String(seconds);
        commit('imageTimeout', seconds * 1000);
    });

    /* ---------- 预设 ---------- */

    qs('#st_gpt_preset_select')?.addEventListener('change', async (e) => {
        const name = e.target.value;
        if (!name) return;
        const preset = getPresets()[name];
        if (!preset) return renderPresetOptions();
        const current = await getSettings();
        await saveSettings({ ...current, apiBase: preset.apiBase, apiKey: preset.apiKey, model: preset.model || current.model });
        fillForm(await getSettings());
        notify.success(`已应用预设「${name}」`);
        onChange?.('preset');
    });

    qs('#st_gpt_preset_save')?.addEventListener('click', async () => {
        const current = await getSettings();
        if (!current.apiBase && !current.apiKey) return notify.warn('先填写 API 地址和 Key 再保存预设');
        const name = String(prompt('预设名称：', qs('#st_gpt_preset_select')?.value || '') ?? '').trim();
        if (!name) return;
        if (!upsertPreset(name, current)) return notify.error('保存预设失败');
        renderPresetOptions(name);
        notify.success(`预设「${name}」已保存`);
    });

    qs('#st_gpt_preset_delete')?.addEventListener('click', () => {
        const name = qs('#st_gpt_preset_select')?.value;
        if (!name) return notify.warn('先选中要删除的预设');
        if (!confirm(`删除预设「${name}」？`)) return;
        if (!removePreset(name)) return notify.error('删除预设失败');
        renderPresetOptions();
        notify.success('预设已删除');
    });

    /* ---------- 模型列表 ---------- */

    const fetchBtn = qs('#st_gpt_fetch_models');
    fetchBtn?.addEventListener('click', async () => {
        setBusy(fetchBtn, true);
        try {
            const models = await fetchModelList();
            renderModelOptions(models);
            notify.success(models.length ? `拉到 ${models.length} 个模型` : '接口返回空列表');
        } catch (e) {
            renderModelOptions([]);
            notify.error(`获取模型失败: ${errMsg(e)}`);
        } finally {
            setBusy(fetchBtn, false);
        }
    });

    qs('#st_gpt_model_list')?.addEventListener('change', (e) => {
        const model = e.target.value;
        if (!model) return;
        const input = qs('#st_gpt_image_model');
        if (input) input.value = model;
        commit('model', model);
    });
}

/** 外部改了设置（比如预设、图库超时）后刷新表单显示。 */
export async function refreshSettingsForm() {
    fillForm(await getSettings());
}

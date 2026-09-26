/**
 * 设置存储：优先走 ST 的 extensionSettings（随账号存在服务器，跨设备同步），
 * 旧版 localStorage 数据会自动迁移一次。图库数据量大，仍留在本地 IndexedDB。
 */
import { DEFAULT_SETTINGS, EXT_ID, LEGACY_SETTINGS_KEY, PRESET_KEY } from './core/constants.js';
import { log } from './core/notify.js';
import { getContext } from './st/context.js';

let cache = null;
let inflight = null;

const withDefaults = (partial) => ({ ...DEFAULT_SETTINGS, ...(partial || {}) });

async function load() {
    const ctx = getContext();
    if (ctx?.extensionSettings) {
        const merged = withDefaults(ctx.extensionSettings[EXT_ID]);
        ctx.extensionSettings[EXT_ID] = merged; // 首次写回默认值
        return merged;
    }

    // 降级：旧版本把设置放在 localStorage，读到就迁移
    try {
        const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
        if (raw) {
            const merged = withDefaults(JSON.parse(raw));
            cache = merged;
            saveSettings(merged).catch((e) => log.warn('设置迁移失败:', e));
            return merged;
        }
    } catch (e) {
        log.warn('读取旧设置失败:', e);
    }
    return withDefaults();
}

export async function getSettings() {
    if (cache) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
        cache = await load();
        return cache;
    })();
    try { return await inflight; }
    finally { inflight = null; }
}

/** 同步取当前设置（仅在已加载后使用，如事件回调里） */
export function peekSettings() {
    return cache || withDefaults();
}

export async function saveSettings(settings) {
    cache = settings;
    try {
        const ctx = getContext();
        // 只写全局对象，交给 ST 自己落盘：主动触发保存可能用不完整的内存数据覆盖服务器
        if (ctx?.extensionSettings) ctx.extensionSettings[EXT_ID] = settings;
        try { localStorage.removeItem(LEGACY_SETTINGS_KEY); } catch { /* 忽略 */ }
        return true;
    } catch (e) {
        log.error('保存设置失败:', e);
        try { localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(settings)); }
        catch (storageErr) { log.error('回退到 localStorage 也失败:', storageErr); }
        return false;
    }
}

/** 改一个字段并保存 */
export async function updateSetting(key, value) {
    const settings = await getSettings();
    settings[key] = value;
    await saveSettings(settings);
    return settings;
}

/* ---------- API 预设（本机 localStorage） ---------- */

export function getPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || {}; }
    catch { return {}; }
}

function writePresets(presets) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); return true; }
    catch (e) { log.error('保存预设失败:', e); return false; }
}

export function upsertPreset(name, preset) {
    const presets = getPresets();
    presets[name] = { apiBase: preset.apiBase || '', apiKey: preset.apiKey || '', model: preset.model || '' };
    return writePresets(presets) ? presets : null;
}

export function removePreset(name) {
    const presets = getPresets();
    delete presets[name];
    return writePresets(presets) ? presets : null;
}

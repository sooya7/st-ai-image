/**
 * 设置存储：优先走 ST 的 extensionSettings（随账号存在服务器，跨设备同步），
 * 旧版 localStorage 设置会自动迁移一次。媒体库索引存在当前聊天元数据；旧版 IndexedDB 供旧记录读取。
 */
import { DEFAULT_SETTINGS, EXT_ID, LEGACY_SETTINGS_KEY, PRESET_KEY } from './core/constants.js';
import { log } from './core/notify.js';
import { getContext } from './st/context.js';

let cache = null;
let inflight = null;

const withDefaults = (partial) => ({ ...DEFAULT_SETTINGS, ...(partial || {}) });

async function load() {
    const ctx = getContext();
    const saved = ctx?.extensionSettings?.[EXT_ID];
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const merged = withDefaults(saved);
        ctx.extensionSettings[EXT_ID] = merged;
        return merged;
    }

    // 降级：旧版本把设置放在 localStorage，读到就迁移
    try {
        const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
        if (raw) {
            const legacy = JSON.parse(raw);
            if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('旧设置格式无效');
            const merged = withDefaults(legacy);
            cache = merged;
            await saveSettings(merged);
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
        // 写进全局对象后请 ST 防抖落盘；扩展在 ST 设置加载完之后才初始化，不会用空数据覆盖服务器。
        // 以前只改内存不落盘，要等 ST 因别的操作保存时才顺带写入，刷新前填的密钥可能丢失。
        if (ctx?.extensionSettings) {
            ctx.extensionSettings[EXT_ID] = settings;
            if (typeof ctx.saveSettingsDebounced === 'function') {
                await ctx.saveSettingsDebounced();
                // 防抖调用只代表已安排保存，不能确认服务器落盘；保留旧副本供恢复。
                return true;
            }
        }
        localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(settings));
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
    presets[name] = { apiBase: preset.apiBase || '', apiKey: preset.apiKey || '', model: preset.model || '', imageProvider: preset.imageProvider || 'auto', imageParams: preset.imageParams || '' };
    return writePresets(presets) ? presets : null;
}

export function removePreset(name) {
    const presets = getPresets();
    delete presets[name];
    return writePresets(presets) ? presets : null;
}

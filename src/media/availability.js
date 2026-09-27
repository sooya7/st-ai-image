/**
 * 哪些服务在当前宿主里能用、下拉框怎么排。页面加载就会用到，所以不放在按需加载的 providers.js 里。
 *
 * TauriTavern 没有酒馆的 /proxy/，浏览器只能直连，不允许跨域的服务在那里根本用不了（2026-09-28 实测预检）：
 * Fish 原生、Runway 不给任何来源；Replicate 只给 localhost:* 。
 */

/** 当前是不是 TauriTavern（Windows 上来源是 http://tauri.localhost，其他平台是 tauri://localhost）。 */
export function isTauriTavern(loc = globalThis.location, win = globalThis) {
    return loc?.hostname === 'tauri.localhost' || loc?.protocol === 'tauri:' || !!win?.__TAURI_INTERNALS__ || !!win?.__TAURI__;
}

/** 只能靠酒馆 /proxy/ 的服务：TauriTavern 里不显示。 */
export const NEEDS_PROXY = { image: ['replicate'], audio: ['fish'], video: ['runway', 'replicate'] };

/** 放进下拉框「其他」分组的：不常用、或要额外开酒馆跨域代理。 */
export const MORE = { image: ['fal', 'replicate'], audio: ['fish'], video: ['runway', 'replicate'] };

export const UNAVAILABLE_NOTE = '（TauriTavern 里用不了）';

/** 已经并进别的服务、只为老配置和续查老任务保留的：下拉框里不列，当前选中的除外。 */
export const MERGED = { video: { agnes: '（已并入 /videos 兼容，重新选一下即可）' } };

/**
 * 下拉框选项：[{ value, text, more }]。TauriTavern 里去掉只能走代理的服务；
 * 但当前选中的是这种服务时仍然列出来并注明，免得设置被悄悄换掉。
 */
export function providerOptions(kind, labels, current, { tauri = isTauriTavern() } = {}) {
    const blocked = new Set(tauri ? NEEDS_PROXY[kind] || [] : []);
    const merged = MERGED[kind] || {};
    const more = new Set(MORE[kind] || []);
    return Object.entries(labels)
        .filter(([value]) => (!blocked.has(value) && !Object.hasOwn(merged, value)) || value === current)
        .map(([value, text]) => ({
            value, more: more.has(value),
            text: `${text}${blocked.has(value) ? UNAVAILABLE_NOTE : ''}${Object.hasOwn(merged, value) ? merged[value] : ''}`,
        }));
}

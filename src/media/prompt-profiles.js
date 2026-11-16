/**
 * 「AI 自动出图/配音/视频」的系统提示词按接口各存一份：settings.promptProfiles[区块][接口] = 文本。
 * 某个接口还没存过时，沿用旧的全局提示词（图片 systemPrompt / 语音视频各自的 prompt），不会丢老内容。
 * 图片走 ComfyUI 时按工作流再分一层：键「comfyui@工作流名」，没存过就用「comfyui」那份。
 */
import { readMediaSettings } from './media-settings.js';
import { baseProvider, profileKey } from '../core/library.js';

export const promptProvider = (s, id) => (id === 'image' ? (s?.imageProvider || 'auto') : readMediaSettings(s, id).provider);

const legacyPrompt = (s, id) => (id === 'image' ? String(s?.systemPrompt ?? '') : readMediaSettings(s, id).prompt);

/** 实际存取用的键：图片 + ComfyUI 时带上当前工作流，其余就是接口名。 */
export const promptProfileKey = (s, id, provider = promptProvider(s, id)) => (id === 'image' ? profileKey(s, provider) : provider);

export function readSectionPrompt(s, id, provider = promptProvider(s, id)) {
    const all = s?.promptProfiles?.[id];
    const own = all?.[promptProfileKey(s, id, provider)];
    if (typeof own === 'string') return own;
    const saved = all?.[baseProvider(provider)];
    return typeof saved === 'string' ? saved : legacyPrompt(s, id);
}

export function writeSectionPrompt(s, id, provider, text) {
    const all = { ...(s?.promptProfiles || {}) };
    all[id] = { ...(all[id] || {}), [promptProfileKey(s, id, provider)]: String(text ?? '').slice(0, 200000) };
    return { ...s, promptProfiles: all };
}

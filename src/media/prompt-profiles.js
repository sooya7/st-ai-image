/**
 * 「AI 自动出图/配音/视频」的系统提示词按接口各存一份：settings.promptProfiles[区块][接口] = 文本。
 * 某个接口还没存过时，沿用旧的全局提示词（图片 systemPrompt / 语音视频各自的 prompt），不会丢老内容。
 */
import { readMediaSettings } from './media-settings.js';

export const promptProvider = (s, id) => (id === 'image' ? (s?.imageProvider || 'auto') : readMediaSettings(s, id).provider);

const legacyPrompt = (s, id) => (id === 'image' ? String(s?.systemPrompt ?? '') : readMediaSettings(s, id).prompt);

export function readSectionPrompt(s, id, provider = promptProvider(s, id)) {
    const saved = s?.promptProfiles?.[id]?.[provider];
    return typeof saved === 'string' ? saved : legacyPrompt(s, id);
}

export function writeSectionPrompt(s, id, provider, text) {
    const all = { ...(s?.promptProfiles || {}) };
    all[id] = { ...(all[id] || {}), [provider]: String(text ?? '').slice(0, 200000) };
    return { ...s, promptProfiles: all };
}

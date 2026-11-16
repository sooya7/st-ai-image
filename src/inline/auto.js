/**
 * 自动出图：AI 新回复里的 [image] 标签，生成结束后自动点它的生成按钮。
 *
 * 只认正文里的标签：思维链（<think…>、<thinking>、<cot>、<reasoning> 等）里
 * 写的示例 `[image]...[/image]` 一律不触发。判断方式是先在原文里把思维链整段剪掉
 * （包括只有结束标签的情况：结束标签之前全算思维链），剩下的才算正文。
 */
import { IMAGE_REQUEST_SOURCE } from '../core/constants.js';
import { log } from '../core/notify.js';
import { getImageRequestPrompt } from '../core/text.js';
import { getSettings } from '../settings.js';
import { getChat, getChatIdentity, getMessage, getMessageText, onStEvents } from '../st/context.js';

const COT_NAMES = String.raw`think[\w-]*|thinking|thought|cot|reasoning|analysis|scratchpad|思考|思维链`;
const COT_BLOCK = new RegExp(String.raw`<\s*(${COT_NAMES})\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>`, 'gi');
const COT_CLOSE = new RegExp(String.raw`<\s*\/\s*(?:${COT_NAMES})\s*>`, 'gi');
const MIN_PROMPT_LEN = 12;

const done = new Set();
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 去掉思维链，只留正文。 */
export function stripCot(text) {
    let body = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
    body = body.replace(COT_BLOCK, '');
    // 没有成对的开头（被正则/截断吃掉了）：最后一个结束标签之前都当思维链
    let last = -1;
    for (const m of body.matchAll(COT_CLOSE)) last = m.index + m[0].length;
    if (last >= 0) body = body.slice(last);
    // 有开头没结尾：说明还在想，开头之后都不算
    const open = body.search(new RegExp(String.raw`<\s*(?:${COT_NAMES})\b[^>]*>`, 'i'));
    if (open >= 0) body = body.slice(0, open);
    return body;
}

/** 正文里真正要画的提示词（去重、过滤 "..." 这类占位）。 */
export function bodyPrompts(text) {
    const out = [];
    const re = new RegExp(IMAGE_REQUEST_SOURCE, 'gi');
    let m;
    const body = stripCot(text);
    while ((m = re.exec(body)) !== null) {
        const p = norm(getImageRequestPrompt(m));
        if (p.length < MIN_PROMPT_LEN || /^[.。…\s]+$/.test(p) || /画面描述|提示词|prompt here/i.test(p)) continue;
        if (!out.includes(p)) out.push(p);
    }
    return out;
}

function inCot(el) {
    return !!el.closest('details, .mes_reasoning, .mes_reasoning_details, [class*="think"], [class*="cot"], [class*="reasoning"]');
}

async function autoRun(messageId) {
    const s = await getSettings();
    if (!s.enabled || !s.autoDetect || !s.autoGenerate) return;
    const msg = getMessage(messageId);
    if (!msg || msg.is_user || msg.is_system) return;
    const identity = getChatIdentity();
    const swipe = Number(msg.swipe_id ?? 0);
    const prompts = bodyPrompts(getMessageText(messageId));
    if (!prompts.length) return;

    for (const prompt of prompts) {
        const key = `${identity}|${messageId}|${swipe}|${prompt}`;
        if (done.has(key)) continue;
        // 扫描器要等 ST 渲染完才把标签换成按钮，等它最多 15 秒
        let btn = null;
        for (let i = 0; i < 30 && !btn; i++) {
            if (getChatIdentity() !== identity) return;
            const cands = [...document.querySelectorAll(`#chat .mes[mesid="${messageId}"] .st_gpt_inline_gen`)]
                .filter((b) => !inCot(b) && !b.disabled && !b.classList.contains('st_gpt_inline_gen_pending')
                    && norm(b.dataset.prompt) === prompt);
            btn = cands[cands.length - 1] || null; // 同一提示词出现多次时取最后一个（正文在思维链后面）
            if (!btn) await new Promise((r) => setTimeout(r, 500));
        }
        if (!btn) continue;
        done.add(key);
        log.info('自动出图:', prompt.slice(0, 60));
        btn.click();
        await new Promise((r) => setTimeout(r, 800));
    }
}

export function initAutoGenerate() {
    const handler = (id) => {
        const chat = getChat();
        const messageId = id !== undefined && Number.isInteger(Number(id)) ? Number(id) : (chat ? chat.length - 1 : -1);
        // 只管最新一条，避免切聊天/加载历史时把旧消息全画一遍
        if (!chat || messageId !== chat.length - 1) return;
        setTimeout(() => autoRun(messageId).catch((e) => log.warn('自动出图失败:', e)), 1200);
    };
    onStEvents(['MESSAGE_RECEIVED'], handler);
    onStEvents(['GENERATION_ENDED'], () => handler(undefined));
}

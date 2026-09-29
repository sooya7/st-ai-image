/**
 * 视觉效果的小部件：生成中的「显影」卡片、声波条、比例换算、图片预加载、等待计时。
 * 只造 DOM、改 CSS 变量；动画全交给 style.css（只动 transform / opacity，能交给合成器）。
 */
import { el, icon } from './dom.js';

/** 同一段文字永远得到同一串高度：声波只是装饰，不为画它去下载音频。 */
export function waveHeights(seed, count) {
    let h = 2166136261;
    for (const ch of String(seed ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    const out = [];
    for (let i = 0; i < count; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
        const random = ((h >>> 0) % 1000) / 1000;
        const envelope = Math.sin(Math.PI * (i + 0.5) / count);
        out.push(Math.round((0.26 + 0.74 * (0.4 * envelope + 0.6 * random)) * 100) / 100);
    }
    return out;
}

/** 声波条：<span class="st_ai_wave"><i style="--h:.6;--i:0"></i>…</span> */
export function waveBars(seed, count, className = 'st_ai_wave') {
    return el('span', { class: className, 'aria-hidden': 'true' },
        waveHeights(seed, count).map((height, index) => el('i', { style: { '--h': String(height), '--i': String(index) } })));
}

/** 播放进度（0–1）点亮前面的声波条；只在条数变化时改 class。 */
export function paintWave(wave, progress) {
    if (!wave) return;
    const bars = wave.children;
    const lit = Math.round(Math.max(0, Math.min(1, progress)) * bars.length);
    if (wave.dataset.lit === String(lit)) return;
    wave.dataset.lit = String(lit);
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('on', i < lit);
}

/** 文字 → 色相，同一句台词颜色固定；只取极光色系（青 170° → 蓝 → 紫 → 粉 330°），避开发闷的棕绿。 */
export function hueOf(text) {
    let h = 0;
    for (const ch of String(text ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return 170 + (h % 160);
}

/** "1024x1536" → { w: 1024, h: 1536 }；auto 或写错时给 null（卡片用默认比例）。 */
export function ratioOf(size) {
    const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(String(size ?? '').trim());
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** 装饰性文字（提示词摘要、说明）用 CSS attr() 画出来，不进 DOM 文本：扫描器比对消息文字、复制消息都不受影响。 */
export const decoText = (className, text) => (text ? el('span', { class: className, 'aria-hidden': 'true', dataset: { text } }) : null);

/** 等图片真正能画出来再显影；超时也放行，别让加载慢的图卡住流程。 */
export function preloadImage(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!url) return resolve(false);
        const img = new Image();
        const done = (ok) => { img.onload = img.onerror = null; resolve(ok); };
        const timer = setTimeout(() => done(false), timeoutMs);
        img.onload = () => {
            clearTimeout(timer);
            if (typeof img.decode === 'function') img.decode().then(() => done(true), () => done(true));
            else done(true);
        };
        img.onerror = () => { clearTimeout(timer); done(false); };
        img.src = url;
    });
}

const STATE_WORDS = [
    [/queue|pending|throttl|waiting|submitted|排队/i, '排队中'],
    [/running|processing|progress|generating|in_progress|渲染|生成/i, '渲染中'],
    [/succe|complete|finish|done/i, '即将完成'],
];

/** 「生成中 · RUNNING · 40%」→ { title: '渲染中', percent: 40 }；认不出状态词就原样显示。 */
export function describeProgress(label) {
    const text = String(label ?? '').trim();
    const percentMatch = /(\d{1,3})\s*%/.exec(text);
    const percent = percentMatch ? Math.max(0, Math.min(100, Number(percentMatch[1]))) : null;
    const parts = text.split('·').map((part) => part.trim()).filter(Boolean);
    const state = parts.length > 1 ? parts[1] : '';
    const word = STATE_WORDS.find(([re]) => re.test(state))?.[1];
    // 百分比单独画成大字，文字里就只留前半句
    return { text, percent, title: word || (percent === null ? text : parts[0]) || '生成中' };
}

const DEVELOP_ICON = { image: 'fa-wand-magic-sparkles', video: 'fa-clapperboard' };
const CORE_ICON = { image: 'fa-paintbrush', video: 'fa-film' };

/**
 * 生成中的显影卡片（按钮里面 / 生图结果区都用它）。
 * @param {{kind?: 'image'|'video', ratio?: {w: number, h: number}|null, label?: string, hint?: string, startedAt?: number}} o
 */
export function developCard({ kind = 'image', ratio = null, label = '生成中…', hint = '', startedAt = Date.now() } = {}) {
    const card = el('span', {
        class: `st_ai_develop st_ai_develop_${kind}`,
        dataset: { kind, started: String(startedAt) },
        style: ratio ? { '--st-ai-rw': ratio.w, '--st-ai-rh': ratio.h } : undefined,
    }, [
        el('span', { class: 'st_ai_develop_aurora', 'aria-hidden': 'true' }),
        el('span', { class: 'st_ai_develop_grain', 'aria-hidden': 'true' }),
        el('span', { class: 'st_ai_develop_sweep', 'aria-hidden': 'true' }),
        el('span', { class: 'st_ai_develop_chip' }, [icon(DEVELOP_ICON[kind] || DEVELOP_ICON.image), el('span', { class: 'st_ai_develop_chip_text', text: kind === 'video' ? 'AI 视频' : 'AI 绘制' })]),
        el('span', { class: 'st_ai_develop_core', 'aria-hidden': 'true' }, [
            el('span', { class: 'st_ai_develop_orb' }, [icon(CORE_ICON[kind] || CORE_ICON.image)]),
            el('span', { class: 'st_ai_develop_percent' }),
        ]),
        el('span', { class: 'st_ai_develop_meta' }, [
            el('span', { class: 'st_ai_develop_label' }),
            el('span', { class: 'st_ai_develop_time', 'aria-hidden': 'true' }),
            decoText('st_ai_develop_hint', hint),
        ]),
        el('span', { class: 'st_ai_develop_bar', 'aria-hidden': 'true' }, [el('i')]),
    ]);
    setDevelopState(card, label);
    watchElapsed();
    return card;
}

/** 更新显影卡片的文字与进度条；有百分比就是确定进度，没有就是来回流动的光。 */
export function setDevelopState(card, label) {
    if (!card) return;
    const { text, percent, title } = describeProgress(label);
    const labelNode = card.querySelector('.st_ai_develop_label');
    if (labelNode) labelNode.textContent = title || text;
    const percentNode = card.querySelector('.st_ai_develop_percent');
    if (percentNode) percentNode.textContent = percent === null ? '' : `${percent}%`;
    card.classList.toggle('st_ai_develop_determinate', percent !== null);
    if (percent !== null) card.style.setProperty('--st-ai-progress', String(percent / 100));
}

/* ---------- 等待计时：一个共用的 rAF，一秒改一次字；页面上没有显影卡片就停 ---------- */
let ticking = false;
const format = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(seconds / 60);
    return `${m}:${String(seconds % 60).padStart(2, '0')}`;
};

function watchElapsed() {
    if (ticking || typeof requestAnimationFrame !== 'function') return;
    ticking = true;
    let last = 0;
    const tick = (now) => {
        const cards = document.querySelectorAll('.st_ai_develop[data-started]');
        if (!cards.length) { ticking = false; return; }
        if (now - last > 500) {
            last = now;
            for (const card of cards) {
                const node = card.querySelector('.st_ai_develop_time');
                const started = Number(card.dataset.started);
                if (node && Number.isFinite(started)) {
                    const elapsed = Date.now() - started;
                    node.textContent = elapsed >= 3000 ? `已等待 ${format(elapsed)}` : '';
                }
            }
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

/**
 * 音色预设：一张「类型名 → 音色」的表，按服务分开存在各自的配置里，名字和音色都能改。
 * AI 在标签里写 type（如 [voice type="御姐"]），扩展按当前服务的表换成具体音色。
 *
 * FISH_VOICES 是给 Fish Audio 准备的推荐音色（原生接口和 OpenAI 兼容接口通用），
 * 都是公共声音库里的通用音色，不用明星、网红的克隆声音；2026-09-28 逐个实测可合成。
 * 其他服务没有推荐值，类型名照样预设好，音色由用户填。
 */

export const FISH_VOICES = [
    { type: '日常女声', fish: 'f729a143b9a34005bdae0b21697fa41a', note: '自然、放松的年轻女声' },
    { type: '萝莉', fish: 'f82e3885ac22468eb6c773b96f2c5752', note: '幼态、软萌' },
    { type: '青涩少女', fish: 'a1417155aa234890aab4a18686d12849', note: '学生气、轻柔' },
    { type: '活泼少女', fish: '5c353fdb312f4888836a9a5680099ef0', note: '明亮、有精神' },
    { type: '温柔女声', fish: 'faccba1a8ac54016bcfc02761285e67f', note: '温柔、抑扬顿挫' },
    { type: '御姐', fish: 'c189c7cff21c400ba67592406202a3a0', note: '成熟、有气场' },
    { type: '成熟女声', fish: '520314cafd9f4ee09ecb80094753bc6f', note: '知性、稳重' },
    { type: '老年女声', fish: 'b2e7d827cc8249919463a5f72b98924f', note: '慈祥的老奶奶' },
    { type: '少年', fish: '7a02aebcd8f94d8283a02842ce4ddd33', note: '清亮的少年感' },
    { type: '青年男声', fish: '54bb123f256947d08eb184541793926d', note: '年轻男性' },
    { type: '成熟男声', fish: '0fb7fd95972a416d9d5359ac89089394', note: '磁性、低沉' },
    { type: '大叔', fish: '68321400e5fa458e8388a49a27800908', note: '中年男性' },
    { type: '老年男声', fish: 'ee18d36ee7bc4ab09f0533fa1e8e1ed0', note: '老爷爷' },
];

export const MAX_PRESETS = 40;

/** 预设好名字、音色留空的一张表（非 Fish 服务的初始值）。 */
export const blankPresets = () => FISH_VOICES.map(({ type }) => ({ type, voice: '' }));

/** Fish 推荐表。 */
export const fishPresets = () => FISH_VOICES.map(({ type, fish }) => ({ type, voice: fish }));

/** 这个配置是不是 Fish：原生接口，或指向 fish.audio 的 OpenAI 兼容接口。决定默认表和「填入推荐」按钮。 */
export function isFishEndpoint(provider, base = '') {
    if (provider === 'fish') return true;
    if (provider !== 'openai') return false;
    try { return /(^|\.)fish\.audio$/i.test(new URL(base).hostname); } catch { return false; }
}

const clean = (value, max) => String(value ?? '').replace(/["“”[\]\r\n]/g, '').trim().slice(0, max);

/** 存档里读出的表：丢掉坏行，名字去重，限制行数。不是数组返回 null（表示没存过）。 */
export function normalizePresets(value) {
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    const rows = [];
    for (const row of value) {
        const type = clean(row?.type, 20);
        if (!type || seen.has(type)) continue;
        seen.add(type);
        rows.push({ type, voice: String(row?.voice ?? '').trim().slice(0, 200) });
        if (rows.length >= MAX_PRESETS) break;
    }
    return rows;
}

/** 已配音色的类型名，写进提示词给 AI 选。 */
export const usableTypes = (presets) => (presets || []).filter((p) => p.type && p.voice).map((p) => p.type);

/** 选音色：标签里的 type 在当前服务的表里且配了音色就用它，否则用默认音色。 */
export function resolveVoice({ type = '', fallback = '', presets = [] } = {}) {
    const wanted = String(type ?? '').trim();
    const row = wanted && (presets || []).find((p) => p.type === wanted && p.voice);
    return row ? { voice: row.voice, preset: row.type } : { voice: fallback, preset: '' };
}

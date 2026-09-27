/**
 * 预设音色：AI 在标签里写 type（如 [voice type="御姐"]），扩展按这里换成具体音色。
 * 目前只有 Fish Audio 的公共声音库（原生接口和 OpenAI 兼容接口通用），
 * 选的都是通用音色，不用明星、网红的克隆声音。2026-09-28 逐个实测可合成。
 */

export const VOICE_PRESETS = [
    { type: '日常女声', group: '女声', fish: 'f729a143b9a34005bdae0b21697fa41a', note: '自然、放松的年轻女声' },
    { type: '萝莉', group: '女声', fish: 'f82e3885ac22468eb6c773b96f2c5752', note: '幼态、软萌' },
    { type: '青涩少女', group: '女声', fish: 'a1417155aa234890aab4a18686d12849', note: '学生气、轻柔' },
    { type: '活泼少女', group: '女声', fish: '5c353fdb312f4888836a9a5680099ef0', note: '明亮、有精神' },
    { type: '温柔女声', group: '女声', fish: 'faccba1a8ac54016bcfc02761285e67f', note: '温柔、抑扬顿挫' },
    { type: '御姐', group: '女声', fish: 'c189c7cff21c400ba67592406202a3a0', note: '成熟、有气场' },
    { type: '成熟女声', group: '女声', fish: '520314cafd9f4ee09ecb80094753bc6f', note: '知性、稳重' },
    { type: '老年女声', group: '女声', fish: 'b2e7d827cc8249919463a5f72b98924f', note: '慈祥的老奶奶' },
    { type: '少年', group: '男声', fish: '7a02aebcd8f94d8283a02842ce4ddd33', note: '清亮的少年感' },
    { type: '青年男声', group: '男声', fish: '54bb123f256947d08eb184541793926d', note: '年轻男性' },
    { type: '成熟男声', group: '男声', fish: '0fb7fd95972a416d9d5359ac89089394', note: '磁性、低沉' },
    { type: '大叔', group: '男声', fish: '68321400e5fa458e8388a49a27800908', note: '中年男性' },
    { type: '老年男声', group: '男声', fish: 'ee18d36ee7bc4ab09f0533fa1e8e1ed0', note: '老爷爷' },
];

export const PRESET_TYPES = VOICE_PRESETS.map((p) => p.type);

/** 当前配置能不能用预设：Fish 原生接口，或指向 fish.audio 的 OpenAI 兼容接口。 */
export function supportsPresets(provider, base = '') {
    if (provider === 'fish') return true;
    if (provider !== 'openai') return false;
    try { return /(^|\.)fish\.audio$/i.test(new URL(base).hostname); } catch { return false; }
}

/** 按音色 ID 反查预设，查不到返回 null（说明是自定义 ID）。 */
export const presetById = (id) => VOICE_PRESETS.find((p) => p.fish === String(id ?? '').trim()) || null;

/**
 * 选音色：标签里的 type 命中预设就用预设，否则用默认音色。
 * 服务不支持预设时，type 一律忽略。
 */
export function resolveVoice({ type = '', fallback = '', provider = '', base = '' } = {}) {
    const wanted = String(type ?? '').trim();
    if (wanted && supportsPresets(provider, base)) {
        const preset = VOICE_PRESETS.find((p) => p.type === wanted);
        if (preset) return { voice: preset.fish, preset: preset.type };
    }
    return { voice: fallback, preset: '' };
}

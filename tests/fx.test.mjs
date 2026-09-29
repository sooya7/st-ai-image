import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress, hueOf, ratioOf, waveHeights } from '../src/ui/fx.js';

test('进度文字：状态词换成中文，百分比单独取出', () => {
    assert.deepEqual(describeProgress('生成中 · RUNNING · 40%'), { text: '生成中 · RUNNING · 40%', percent: 40, title: '渲染中' });
    assert.equal(describeProgress('生成中 · queued').title, '排队中');
    assert.equal(describeProgress('生成中 · PENDING').title, '排队中');
    assert.equal(describeProgress('生成中 · SUCCEEDED · 100%').title, '即将完成');
    assert.equal(describeProgress('生成中 · RUNNING · 250%').percent, 100);
});

test('进度文字：认不出状态就原样显示，空的给默认', () => {
    assert.deepEqual(describeProgress('正在提交'), { text: '正在提交', percent: null, title: '正在提交' });
    assert.equal(describeProgress('生成中 (1/2) · 1失败').title, '生成中 (1/2) · 1失败');
    assert.equal(describeProgress('').title, '生成中');
    assert.equal(describeProgress(undefined).title, '生成中');
});

test('尺寸 → 占位比例；auto 和写错的给 null', () => {
    assert.deepEqual(ratioOf('1024x1536'), { w: 1024, h: 1536 });
    assert.deepEqual(ratioOf(' 832 × 1216 '), { w: 832, h: 1216 });
    assert.equal(ratioOf('auto'), null);
    assert.equal(ratioOf('720P'), null);
    assert.equal(ratioOf(''), null);
});

test('色相只落在极光色系（170°–330°），同一段文字结果固定', () => {
    for (const text of ['雨夜的霓虹街道', '"别怕，跟紧我。"', 'a', '', '那是雨之都。很久以前，我也在那里等过一个人。']) {
        const hue = hueOf(text);
        assert.ok(hue >= 170 && hue < 330, `${text} → ${hue}`);
        assert.equal(hueOf(text), hue);
    }
});

test('声波高度：数量对、范围在 0.26–1 之间、同一段文字固定、不同文字不同', () => {
    const a = waveHeights('别怕，跟紧我', 14);
    assert.equal(a.length, 14);
    assert.ok(a.every((h) => h >= 0.26 && h <= 1), a);
    assert.deepEqual(waveHeights('别怕，跟紧我', 14), a);
    assert.notDeepEqual(waveHeights('那是雨之都', 14), a);
});

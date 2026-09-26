import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMediaTag, hasMediaTag, locateMediaTag, mediaFileName, mediaJobKey, parseMediaTag, replaceMediaTag, sanitizeMediaSrc,
} from '../src/media/tags.js';
import { IMAGE_REQUEST_SOURCE } from '../src/core/constants.js';
import { MEDIA_TAG_SOURCE } from '../src/media/tags.js';
import { hasInlineRenderableTag, shouldProcessInlineText, stripGeneratedImageArtifacts } from '../src/core/text.js';

test('识别中英文语音/视频标签，要求闭合且同名', () => {
    assert.ok(hasMediaTag('她说：[voice]你好[/voice]'));
    assert.ok(hasMediaTag('[语音]早上好[/语音]') && hasMediaTag('[配音]嗯[/配音]') && hasMediaTag('[视频]海边[/视频]'));
    assert.ok(hasMediaTag('[Video]sea[/VIDEO]'));
    assert.ok(!hasMediaTag('[voice]没闭合'));
    assert.ok(!hasMediaTag('[voice]错配[/video]'));
    assert.ok(hasInlineRenderableTag('[video]x[/video]'));
    assert.ok(shouldProcessInlineText('[voice]x[/voice]', { enabled: false }));
});

test('解析类型、文字与 src；只认本扩展写入的 /user/files 地址', () => {
    assert.deepEqual(parseMediaTag('[voice] 你好 [/voice]'), { name: 'voice', kind: 'audio', rawSrc: '', src: '', text: '你好' });
    const done = parseMediaTag('[视频 src="/user/files/st-ai-video-1-abc.mp4"]海边[/视频]');
    assert.equal(done.kind, 'video');
    assert.equal(done.src, '/user/files/st-ai-video-1-abc.mp4');
    for (const bad of ['https://evil.test/a.mp3', '/user/files/../secrets.json', '/user/files/other.mp3', 'javascript:alert(1)', '/user/files/st-ai-audio-1.exe']) {
        assert.equal(sanitizeMediaSrc(bad), '', bad);
    }
    assert.equal(sanitizeMediaSrc('user/files/st-ai-audio-1-x.mp3'), '/user/files/st-ai-audio-1-x.mp3');
    assert.equal(parseMediaTag('[voice src="https://evil.test/x.mp3"]嗨[/voice]').src, '');
    assert.equal(parseMediaTag('[image]x[/image]'), null);
});

test('写回：保留原标签名和文字，只补 src；替换不受 $ 影响', () => {
    const tag = buildMediaTag('配音', '价格 $& 不变', '/user/files/st-ai-audio-1-a.mp3');
    assert.equal(tag, '[配音 src="/user/files/st-ai-audio-1-a.mp3"]价格 $& 不变[/配音]');
    assert.equal(buildMediaTag('voice', '嗨', 'https://evil.test/x.mp3'), '[voice]嗨[/voice]');
    const raw = '前文 [配音]价格 $& 不变[/配音] 后文';
    const located = locateMediaTag(raw, { kind: 'audio', text: '价格 $& 不变' });
    assert.equal(replaceMediaTag(raw, located, tag), `前文 ${tag} 后文`);
    assert.equal(replaceMediaTag(raw, null, tag), raw);
    assert.equal(replaceMediaTag('已被编辑', located, tag), '已被编辑');
});

test('定位：DOM 文本丢了 markdown 符号时，按类型+文字+序号找到原文，找不到返回 null', () => {
    const raw = '[voice]"*轻声*你好"[/voice] 然后 [voice]再见[/voice] 又说 [voice]"*轻声*你好"[/voice] [video]你好[/video]';
    const first = locateMediaTag(raw, { kind: 'audio', text: '"轻声你好"', ordinal: 0 });
    assert.deepEqual([first.tag, first.index], ['[voice]"*轻声*你好"[/voice]', 0]);
    assert.equal(locateMediaTag(raw, { kind: 'audio', text: '"轻声你好"', ordinal: 1 }).index, raw.lastIndexOf('[voice]"*'));
    assert.equal(locateMediaTag(raw, { kind: 'audio', text: '再见' }).tag, '[voice]再见[/voice]');
    assert.equal(locateMediaTag(raw, { kind: 'video', text: '你好' }).tag, '[video]你好[/video]');
    assert.equal(locateMediaTag(raw, { kind: 'audio', text: '不存在' }), null);
    assert.equal(locateMediaTag(raw, { kind: 'audio', text: '再见', ordinal: 1 }), null);
});

test('同样的标签出现两次：只改点中的那一处', () => {
    const raw = '[voice]嗯[/voice] 和 [voice]嗯[/voice]';
    const second = locateMediaTag(raw, { kind: 'audio', text: '嗯', ordinal: 1 });
    const next = replaceMediaTag(raw, second, buildMediaTag('voice', '嗯', '/user/files/st-ai-audio-1-a.mp3'));
    assert.equal(next, '[voice]嗯[/voice] 和 [voice src="/user/files/st-ai-audio-1-a.mp3"]嗯[/voice]');
    // 已生成的标签仍占序号，重新生成第二个时不会错位到第一个
    assert.equal(locateMediaTag(next, { kind: 'audio', text: '嗯', ordinal: 1 }).tag, '[voice src="/user/files/st-ai-audio-1-a.mp3"]嗯[/voice]');
});

test('文件名只含酒馆允许的字符，扩展名跟随 MIME', () => {
    const name = mediaFileName('audio', 'audio/mpeg', 1700000000000, () => 0.5);
    assert.match(name, /^st-ai-audio-1700000000000-[0-9a-z]{6}\.mp3$/);
    assert.match(mediaFileName('video', 'video/webm; codecs=vp9'), /\.webm$/);
    assert.match(mediaFileName('video', ''), /^st-ai-video-.*\.mp4$/);
    assert.equal(sanitizeMediaSrc(`/user/files/${name}`), `/user/files/${name}`);
});

test('续查任务键只看类型与文字内容', () => {
    assert.equal(mediaJobKey('video', '海边*日落*'), mediaJobKey('video', '海边日落'));
    assert.notEqual(mediaJobKey('video', '海边'), mediaJobKey('audio', '海边'));
});

test('楼层生图提示词里，语音/视频标签只留文字', () => {
    assert.equal(stripGeneratedImageArtifacts('她笑了 [voice src="/user/files/st-ai-audio-1-a.mp3"]你好[/voice] [video]海边[/video]'), '她笑了 你好 海边');
});

test('拼进扫描器的大正则后仍能正确匹配（反向引用不串组）', () => {
    const re = new RegExp(`${IMAGE_REQUEST_SOURCE}|\\[st-ai-image\\b[^\\]]*\\]|${MEDIA_TAG_SOURCE}`, 'gi');
    const text = '[image]猫[/image] 她说[voice]"*轻声*你好"[/voice]，[视频 src="/user/files/st-ai-video-1-a.mp4"]海边[/视频] [voice]没闭合';
    const found = [...text.matchAll(re)].map((m) => m[0]);
    assert.deepEqual(found, ['[image]猫[/image]', '[voice]"*轻声*你好"[/voice]', '[视频 src="/user/files/st-ai-video-1-a.mp4"]海边[/视频]']);
    assert.equal(parseMediaTag(found[2]).src, '/user/files/st-ai-video-1-a.mp4');
});
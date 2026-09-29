import assert from 'node:assert/strict';
import test from 'node:test';
import { captureMessageTarget, getChatIdentity, isMessageTargetCurrent, saveChatVerified } from '../src/st/context.js';
import { removeMediaEntry } from '../src/gallery/delete.js';
import { getTaskKey } from '../src/inline/tasks.js';

const url = '/user/files/st-ai-audio-123-audit.wav';
function fixture(mode = 'success', group = false) {
    const message = { mes: `[voice src="${url}"]测试[/voice]`, swipes: [`[voice src="${url}"]测试[/voice]`], swipe_id: 0 };
    const context = {
        chat: [message], characterId: 0, characters: [{ avatar: 'A.png' }, { avatar: 'B.png' }],
        groupId: group ? 'group-A' : undefined, getCurrentChatId: () => 'same-file-name',
        chatMetadata: { st_ai_image_media_library: [{ id: 'item', type: 'audio', mediaUrl: url }] },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }),
        updateMessageBlock: () => {}, saveMetadata: async () => {},
    };
    let disk = structuredClone(context.chat), diskMetadata = structuredClone(context.chatMetadata), deleted = 0, saves = 0;
    context.saveChat = async () => {
        // 与真实宿主一致：失败被宿主捕获，仍然正常返回 void。
        saves++;
        if (mode === 'success' || mode === 'switch' || (mode === 'metadata-failure' && saves === 1)) { disk = structuredClone(context.chat); diskMetadata = structuredClone(context.chatMetadata); }
        if (mode === 'edit') message.mes = '用户新编辑';
        if (mode === 'switch') context.characterId = 1;
    };
    globalThis.SillyTavern = { getContext: () => context };
    const calls = [];
    globalThis.fetch = async (endpoint, options) => {
        calls.push({ endpoint, body: JSON.parse(options.body) });
        if (endpoint === '/api/files/delete') { deleted++; return Response.json({ ok: true }); }
        assert.equal(endpoint, group ? '/api/chats/group/get' : '/api/chats/get');
        if (mode === 'read-500') return Response.json({ error: 'failed' }, { status: 500 });
        if (mode === 'connection' || mode === 'timeout') throw mode === 'timeout' ? new DOMException('超时', 'TimeoutError') : new TypeError('connection failed');
        return Response.json([{ chat_metadata: diskMetadata }, ...disk]);
    };
    return { context, message, calls, deleted: () => deleted, clean() { delete globalThis.SillyTavern; delete globalThis.fetch; } };
}

test('角色同名聊天、swipe与楼层替换会使消息快照失效', () => {
    const f = fixture();
    try {
        const target = captureMessageTarget(0), identity = getChatIdentity();
        const taskKey = getTaskKey(0, 'same-tag');
        assert.ok(isMessageTargetCurrent(target));
        f.context.characterId = 1;
        assert.notEqual(getChatIdentity(), identity);
        assert.equal(isMessageTargetCurrent(target), false);
        f.context.characterId = 0;
        f.message.swipe_id = 1;
        assert.equal(isMessageTargetCurrent(target), false);
        f.message.swipe_id = 0;
        f.context.chat[0] = { ...f.message };
        assert.equal(isMessageTargetCurrent(target), false);
        assert.notEqual(getTaskKey(0, 'same-tag'), taskKey);
    } finally { f.clean(); }
});
for (const mode of ['swallowed-save-500', 'read-500', 'connection', 'timeout', 'switch']) {
    test(`删除遇到 ${mode} 保留物理文件、索引并回滚正文`, async () => {
        const f = fixture(mode);
        const original = f.message.mes;
        try {
            await assert.rejects(removeMediaEntry('item'), /聊天保存失败/);
            assert.equal(f.deleted(), 0);
            assert.equal(f.message.mes, original);
            assert.deepEqual(f.message.swipes, [original]);
            assert.equal(f.context.chatMetadata.st_ai_image_media_library.length, 1);
        } finally { f.clean(); }
    });
}
for (const group of [false, true]) {
    test(`${group ? '群组' : '角色'}聊天保存读回一致才删除文件`, async () => {
        const f = fixture('success', group);
        try {
            assert.deepEqual(await removeMediaEntry('item'), { removed: true, fileDeleted: true });
            assert.equal(f.deleted(), 1);
            assert.equal(f.message.mes, '[voice]测试[/voice]');
            assert.equal(f.calls[0].endpoint, group ? '/api/chats/group/get' : '/api/chats/get');
            assert.deepEqual(f.calls[0].body, group ? { id: 'same-file-name' } : { avatar_url: 'A.png', file_name: 'same-file-name' });
        } finally { f.clean(); }
    });
}

test('缺少宿主聊天定位信息时无法确认持久保存', async () => {
    const f = fixture();
    try { f.context.characters = []; assert.equal(await saveChatVerified(), false); }
    finally { f.clean(); }
});

 test('保存验证失败回滚不得覆盖等待期间用户新编辑', async () => {
    const f = fixture('edit');
    try {
        await assert.rejects(removeMediaEntry('item'), /聊天保存失败/);
        assert.equal(f.message.mes, '用户新编辑');
        assert.equal(f.deleted(), 0);
    } finally { f.clean(); }
});

test('删除索引保存失败不报告成功，原索引保留供重试', async () => {
    const f = fixture('metadata-failure');
    try {
        await assert.rejects(removeMediaEntry('item'), /删除记录未能确认保存/);
        assert.equal(f.context.chatMetadata.st_ai_image_media_library.length, 1);
        // 正文已确认落盘移除后才删除文件，失败发生在后续索引保存。
        assert.equal(f.deleted(), 1);
        assert.equal(f.message.mes, '[voice]测试[/voice]');
    } finally { f.clean(); }
});

test('批量删除的原会话身份失效时不执行新的聊天删除', async () => {
    const f = fixture();
    try {
        const identity = getChatIdentity();
        f.context.characterId = 1;
        await assert.rejects(removeMediaEntry('item', { expectedIdentity: identity }), /聊天已切换/);
        assert.equal(f.calls.length, 0);
    } finally { f.clean(); }
});

test('读取鉴权头期间重新加入引用时保留物理文件', async () => {
    const f = fixture();
    let reads = 0;
    f.context.getRequestHeaders = () => {
        if (++reads === 2) f.message.mes = `[voice src="${url}"]用户重新添加[/voice]`;
        return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' };
    };
    try {
        await assert.rejects(removeMediaEntry('item'), /引用已被重新编辑/);
        assert.equal(f.deleted(), 0);
        assert.ok(f.message.mes.includes('用户重新添加'));
        assert.equal(f.context.chatMetadata.st_ai_image_media_library.length, 1);
    } finally { f.clean(); }
});

test('索引保存失败回滚保留同时新增的媒体记录', async () => {
    const f = fixture();
    f.context.saveMetadata = async () => {
        f.context.chatMetadata.st_ai_image_media_library = [{ id: 'new-item', type: 'audio', mediaUrl: '/user/files/st-ai-audio-456-new.wav' }];
        throw new Error('模拟索引保存失败');
    };
    try {
        await assert.rejects(removeMediaEntry('item'), /模拟索引保存失败/);
        assert.deepEqual(f.context.chatMetadata.st_ai_image_media_library.map(i => i.id).sort(), ['item', 'new-item']);
    } finally { f.clean(); }
});

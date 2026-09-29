import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeHistoryItems, normalizeHistoryEntry } from '../src/gallery/db.js';
import { getHistory, deleteHistoryItem, clearHistory, importChatEntries } from '../src/gallery/chat-store.js';
import { saveMediaToHistory, syncChatImagesToHistory } from '../src/gallery/sync.js';
import { ownedFile, removeMediaEntry, withoutMedia } from '../src/gallery/delete.js';

const audio = '/user/files/st-ai-audio-123-abc.mp3';
const video = '/user/files/st-ai-video-456-def.webm';

test('旧图片记录与新的语音、视频记录共存且按类型去重', () => {
    const items = mergeHistoryItems([
        { id: 1, imageUrl: 'https://example.com/a.png', timestamp: 1 },
        { id: 2, type: 'audio', mediaUrl: audio, prompt: '你好', timestamp: 2 },
        { id: 3, type: 'audio', mediaUrl: audio, timestamp: 3 },
        { id: 4, type: 'video', mediaUrl: video, timestamp: 4 },
        { id: 5, type: 'video', mediaUrl: audio, timestamp: 5 },
        { id: 6, type: 'audio', mediaUrl: 'javascript:alert(1)', timestamp: 6 },
    ]);
    assert.deepEqual(items.map((item) => item.id), [4, 3, 1]);
    assert.equal(items[2].type, 'image');
    assert.equal(normalizeHistoryEntry({ type: 'audio', mediaUrl: video }).mediaUrl, '');
});

test('当前聊天的语音和视频自动入库，切聊天隔离；删除时清除正文引用和服务器文件', async () => {
    const data = new Map();
    globalThis.localStorage = {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
    };
    const metadataByChat = { A: {}, B: {} };
    let chatId = 'A';
    const chat = [{
        mes: `[voice src="${audio}"]你好[/voice]`,
        swipes: [`[video src="${video}"]雨夜[/video]`, '[voice src="/user/files/not-ours.mp3"]伪造[/voice]'],
    }];
    let savedChats = 0;
    let storedChat = [];
    globalThis.SillyTavern = { getContext: () => ({
        chat, chatMetadata: metadataByChat[chatId], getCurrentChatId: () => chatId,
        characterId: 0, characters: [{ avatar: 'Fixture.png' }],
        saveMetadata: async () => {}, saveChat: async () => { savedChats++; storedChat = structuredClone(chat); },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }),
    }) };
    const deleted = [];
    globalThis.fetch = async (url, options) => {
        if (url === '/api/chats/get') return Response.json([{ chat_metadata: metadataByChat[chatId] }, ...storedChat]);
        deleted.push({ url, path: JSON.parse(options.body).path });
        return new Response('', { status: 200 });
    };
    try {
        await syncChatImagesToHistory();
        let items = await getHistory();
        assert.deepEqual(items.map((item) => item.type).sort(), ['audio', 'video']);
        chatId = 'B';
        assert.deepEqual(await getHistory(), []);
        chatId = 'A';
        assert.equal(await saveMediaToHistory('/user/files/not-ours.mp3', 'audio', '伪造'), null);
        assert.equal(await saveMediaToHistory(audio, 'video', '类型不匹配'), null);
        const savedAudio = await saveMediaToHistory(audio, 'audio', '你好');
        const savedVideo = await saveMediaToHistory(video, 'video', '雨夜');
        assert.ok(savedAudio?.id && savedVideo?.id);
        items = await getHistory();
        assert.deepEqual(items.map((item) => item.type).sort(), ['audio', 'video']);
        assert.equal(items.find((item) => item.type === 'audio').prompt, '你好');
        assert.equal((await saveMediaToHistory(audio, 'audio', '你好')).id, savedAudio.id);
        assert.equal((await removeMediaEntry(savedAudio.id)).fileDeleted, true);
        assert.equal(chat[0].mes, '[voice]你好[/voice]');
        assert.deepEqual(deleted, [{ url: '/api/files/delete', path: audio }]);
        assert.equal(savedChats, 2);
        await syncChatImagesToHistory();
        items = await getHistory();
        assert.deepEqual(items.map((item) => item.type), ['video']);
        await clearHistory();
        await syncChatImagesToHistory();
        assert.deepEqual(await getHistory(), []);
        assert.ok((await saveMediaToHistory(audio, 'audio', '重新保存'))?.id);
        assert.deepEqual((await getHistory()).map((item) => item.prompt), ['重新保存']);
        const imageUrl = '/user/images/角色/st-ai-image-123-abc.png';
        chat[0].mes += ` [st-ai-image id="media-picture" src="${encodeURIComponent(imageUrl)}"]`;
        await syncChatImagesToHistory();
        const image = (await getHistory()).find((item) => item.type === 'image');
        assert.equal(image?.imageUrl, imageUrl);
        assert.equal((await removeMediaEntry(image.id)).fileDeleted, true);
        assert.equal(chat[0].mes.includes('st-ai-image'), false);
        assert.deepEqual(deleted.at(-1), { url: '/api/images/delete', path: imageUrl });
    } finally {
        delete globalThis.SillyTavern;
        delete globalThis.localStorage;
        delete globalThis.fetch;
    }
});

test('只识别本扩展文件；删除图片标记时保留可重新生成的提示词', () => {
    assert.deepEqual(ownedFile({ type: 'image', imageUrl: '/user/images/角色/st-ai-image-123-abc.png' }), { path: '/user/images/角色/st-ai-image-123-abc.png', endpoint: '/api/images/delete' });
    assert.equal(ownedFile({ type: 'image', imageUrl: '/user/images/角色/other.png' }), null);
    assert.equal(ownedFile({ type: 'image', imageUrl: 'https://other.test/user/images/st-ai-image-123.png' }), null);
    assert.equal(withoutMedia('[st-ai-image id="media-1" src="%2Fuser%2Fimages%2Fx.png"]', { id: 'media-1', type: 'image', imageUrl: '/user/images/x.png', prompt: '夕阳' }), '[image]夕阳[/image]');
    assert.equal(withoutMedia('看：![夕阳](/user/images/st-ai-image-123.png)', { id: 'media-1', type: 'image', imageUrl: '/user/images/st-ai-image-123.png', prompt: '夕阳' }), '看：[image]夕阳[/image]');
});

test('超过旧版 200 条上限的生成记录仍保留；清空后扫描聊天不会恢复已删除记录', async () => {
    const chatMetadata = {};
    globalThis.SillyTavern = { getContext: () => ({
        chatMetadata, getCurrentChatId: () => 'long-chat', saveMetadata: async () => {},
    }) };
    try {
        const candidates = Array.from({ length: 230 }, (_, i) => ({ imageUrl: `/user/images/角色/st-ai-image-${i}.png`, prompt: `第 ${i} 张` }));
        await importChatEntries(candidates);
        assert.equal((await getHistory()).length, 230);
        await clearHistory();
        await importChatEntries(candidates);
        assert.deepEqual(await getHistory(), []);
    } finally { delete globalThis.SillyTavern; }
});

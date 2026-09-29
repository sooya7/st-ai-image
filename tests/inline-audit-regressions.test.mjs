import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as tags from '../src/media/tags.js';
import * as text from '../src/core/text.js';
import * as constants from '../src/core/constants.js';
import { getTaskKey } from '../src/inline/tasks.js';
import { generateMedia } from '../src/media/client.js';
import { buildRequest } from '../src/media/providers.js';

// VM isolates only network/DOM dependencies; the asynchronous orchestration is read from production source.
if (!vm.SourceTextModule) {
    test('内联异步目标、重复标签续查与硅基续查回归', () => {
        execFileSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], {
            encoding: 'utf8', timeout: 20000,
        });
    });
} else {
    await runCases();
}

async function loadMedia(overrides, file = 'media.js') {
    const source = fs.readFileSync(new URL(`../src/inline/${file}`, import.meta.url), 'utf8')
        + (file === 'media.js' ? '\nexport { runMediaJob, jobEntry };' : '');
    const namesByImport = new Map();
    for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        namesByImport.set(m[2], m[1].split(',').map(v => v.trim()).filter(Boolean));
    }
    namesByImport.set('../media/client.js', ['downloadMedia', 'generateMedia']);
    namesByImport.set('../media/providers.js', ['buildRequest', 'trustedTaskUrl']);
    namesByImport.set('../st/files.js', ['uploadMediaFile']);
    const context = vm.createContext({ console, Map, Date, document: { querySelectorAll: () => [] } });
    const imports = new Map();
    const dependency = async specifier => {
        if (!imports.has(specifier)) {
            const names = namesByImport.get(specifier) || [];
            const module = new vm.SyntheticModule(names, function() {
                for (const name of names) this.setExport(name, overrides[name] ?? tags[name] ?? text[name] ?? constants[name] ?? (() => undefined));
            }, { context });
            imports.set(specifier, module);
            await module.link(() => {});
            await module.evaluate();
        }
        return imports.get(specifier);
    };
    const module = new vm.SourceTextModule(source, { context, importModuleDynamically: dependency });
    await module.link(dependency);
    await module.evaluate();
    return module.namespace;
}

function fixture() {
    const state = { identity: 'A', chat: [{ mes: '[video]same[/video]', swipe_id: 0 }], saves: 0, pending: new Map() };
    const capture = id => ({ identity: state.identity, chat: state.chat, message: state.chat[id], messageId: id, swipeId: Number(state.chat[id]?.swipe_id ?? 0) });
    const current = target => !!target?.message && target.identity === state.identity && target.chat === state.chat
        && target.message === state.chat[target.messageId] && target.swipeId === Number(target.message.swipe_id ?? 0);
    const overrides = {
        log: { warn() {}, error() {} }, notify: { warn() {}, error() {}, success() {}, info() {} },
        errMsg: e => e.message, getChatIdentity: () => state.identity, getMessage: id => state.chat[id],
        captureMessageTarget: capture, isMessageTargetCurrent: current,
        getTaskKey: (id, text) => JSON.stringify([state.identity, id, state.chat[id]?.swipe_id ?? 0, text]),
        isPending: key => state.pending.has(key), getTask: key => state.pending.get(key),
        startTask: (key, value) => state.pending.set(key, value), endTask: key => state.pending.delete(key), updateTask: () => {},
        getSettings: async () => ({ enabled: true }),
        readMediaSettings: () => ({ enabled: true, provider: 'fixture', profiles: { fixture: {} } }),
        mediaRequestConfig: () => ({ key: 'fake', base: 'https://fixture.invalid' }), needsKey: () => false,
        saveChat: async () => { state.saves++; return true; },
        buildRequest: () => ({ root: 'https://fixture.invalid' }), trustedTaskUrl: value => value,
        rewriteMessageText: (id, transform) => {
            const before = state.chat[id].mes;
            state.chat[id].mes = transform(before);
            return before !== state.chat[id].mes;
        },
        saveMediaToHistory: async () => ({ id: 'saved' }), uploadMediaFile: async () => '/user/files/st-ai-video-1-test.mp4',
        getMessageIdFromElement: () => 0, imageKeyMissing: () => false,
    };
    return { state, overrides };
}
function wrapper(ordinal = 0) { return { dataset: { messageId: '0', ordinal: String(ordinal), tag: '[video]same[/video]' } }; }
function tick() { return new Promise(resolve => setImmediate(resolve)); }

async function runCases() {
    {
        const { state, overrides } = fixture();
        let sequence = 0;
        overrides.generateMedia = async (_kind, _config, _text, options) => {
            options.onTask({ id: `job-${++sequence}`, links: { status: 'https://fixture.invalid/status' } });
            throw new Error('network interruption');
        };
        const mod = await loadMedia(overrides);
        await mod.runMediaJob(wrapper(0));
        await mod.runMediaJob(wrapper(1));
        const jobs = state.chat[0].extra.st_ai_media_jobs;
        assert.equal(Object.keys(jobs).length, 2);
        assert.equal(jobs[tags.mediaJobKey('video', 'same', 0)].id, 'job-1');
        assert.equal(jobs[tags.mediaJobKey('video', 'same', 1)].id, 'job-2');
        assert.equal(state.pending.size, 0);
    }
    {
        const { state, overrides } = fixture();
        const key = tags.mediaJobKey('video', 'same', 0);
        state.chat[0].extra = { st_ai_media_jobs: { [key]: { provider: 'fixture', id: 'job-A', links: {} } } };
        let reject;
        overrides.generateMedia = () => new Promise((_resolve, rejectFn) => { reject = rejectFn; });
        const mod = await loadMedia(overrides);
        const running = mod.runMediaJob(wrapper(), { resume: true });
        while (!reject) await tick();
        state.identity = 'B';
        state.chat = [{ mes: '[video]same[/video]', extra: { st_ai_media_jobs: { [key]: { id: 'job-B' } } } }];
        reject(new Error('HTTP 404 task not found'));
        await running;
        assert.equal(state.chat[0].extra.st_ai_media_jobs[key].id, 'job-B');
        assert.equal(state.saves, 0);
        assert.equal(state.pending.size, 0);
    }
    for (const change of ['identity', 'chat-object', 'swipe']) {
        const { state, overrides } = fixture();
        let resolve;
        overrides.generateMedia = () => new Promise(resolveFn => { resolve = resolveFn; });
        const mod = await loadMedia(overrides);
        const running = mod.runMediaJob(wrapper());
        while (!resolve) await tick();
        if (change === 'identity') state.identity = 'other-character-same-chat-name';
        if (change === 'chat-object') state.chat = [{ mes: '[video]same[/video]', swipe_id: 0 }];
        if (change === 'swipe') state.chat[0].swipe_id = 1;
        resolve({ blob: {} });
        await running;
        assert.equal(state.chat[0].mes, '[video]same[/video]', change);
        assert.equal(state.saves, 0, change);
    }
    {
        const { state, overrides } = fixture();
        const legacy = tags.mediaJobKey('video', 'same');
        state.chat[0].extra = { st_ai_media_jobs: { [legacy]: { provider: 'fixture', id: 'old-job', links: {} } } };
        overrides.generateMedia = async () => { throw new Error('network interruption'); };
        const mod = await loadMedia(overrides);
        assert.equal(mod.jobEntry(0, 'video', 'same', 1), null);
        await mod.runMediaJob(wrapper(), { resume: true });
        assert.equal(state.chat[0].extra.st_ai_media_jobs[legacy], undefined);
        assert.equal(state.chat[0].extra.st_ai_media_jobs[tags.mediaJobKey('video', 'same', 0)].id, 'old-job');
        const trusted = (url, root) => {
            if (new URL(url).origin !== new URL(root).origin) throw new Error('cross origin');
            return url;
        };
        const plan = { root: 'https://fixture.invalid' };
        const links = mod.restoreMediaTaskLinks({ id: 'legacy-request', links: { status: 'https://fixture.invalid/video/status' } }, 'siliconflow', plan, trusted);
        assert.equal(links.statusBody.requestId, 'legacy-request');
        assert.throws(() => mod.restoreMediaTaskLinks({ id: 'x', links: { status: 'https://evil.invalid/status' } }, 'siliconflow', plan, trusted), /cross origin/);
        const config = { provider: 'siliconflow', base: 'https://fixture.invalid/v1', key: 'fake', model: 'fixture', size: '16:9', extra: '{}' };
        const requests = [];
        const result = await generateMedia('video', config, 'same', {
            resume: { id: 'legacy-request', plan: buildRequest('video', config, 'same'), links },
            request: async (url, init) => {
                requests.push({ url, method: init.method, body: init.body });
                return { status: 'Succeed', results: { videos: [{ url: 'https://cdn.invalid/result.mp4' }] } };
            },
        });
        assert.equal(result.url, 'https://cdn.invalid/result.mp4');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, 'POST');
        assert.equal(JSON.parse(requests[0].body).requestId, 'legacy-request');
        assert.ok(requests[0].url.endsWith('/video/status'));
    }
    {
        const { state, overrides } = fixture();
        overrides.getSettings = async () => { throw new Error('settings unavailable'); };
        overrides.generateMedia = () => { assert.fail('settings failure must not submit a task'); };
        const mod = await loadMedia(overrides);
        await mod.runMediaJob(wrapper());
        assert.equal(state.pending.size, 0);
    }
    {
        const { state, overrides } = fixture();
        state.chat[0].mes = '[st-ai-image id="old" src="%2Fuser%2Fimages%2Fold.png"]';
        let reject;
        overrides.callImageAPI = () => new Promise((_resolve, rejectFn) => { reject = rejectFn; });
        const mod = await loadMedia(overrides, 'message.js');
        const running = mod.regenerateInlineImageInMessage({ dataset: { historyId: 'old' } }, 'same');
        while (!reject) await tick();
        state.identity = 'B';
        state.chat = [{ mes: '[image]same[/image]' }];
        reject(new Error('generation failed in A'));
        await running;
        assert.equal(state.saves, 0);
        assert.equal(state.chat[0].mes, '[image]same[/image]');
    }
    {
        let characterId = 'A';
        const chat = [{ swipe_id: 0 }];
        globalThis.SillyTavern = { getContext: () => ({ characterId, chat, getCurrentChatId: () => 'same-name' }) };
        try {
            const first = getTaskKey(0, 'x'.repeat(400) + 'A');
            assert.notEqual(first, getTaskKey(0, 'x'.repeat(400) + 'B'));
            characterId = 'B';
            assert.notEqual(first, getTaskKey(0, 'x'.repeat(400) + 'A'));
            const swipe0 = getTaskKey(0, 'tag');
            chat[0].swipe_id = 1;
            assert.notEqual(swipe0, getTaskKey(0, 'tag'));
        } finally { delete globalThis.SillyTavern; }
    }
    console.log('10 inline audit scenarios passed (fake clients, no paid API)');
}

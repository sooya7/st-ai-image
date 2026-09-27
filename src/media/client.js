import { VIDEOS_PROTOCOL, buildRequest, mediaUrl, safeUrl, taskLinks, taskState } from './providers.js';
import { SELF_HOSTED } from './selfhosted.js';
import { vendorFor, vendorPlan } from './vendors.js';

let active = 0;
export function pendingMediaCount() { return active; }

/** 走酒馆自带的 /proxy/（需在 config.yaml 打开 enableCorsProxy），给不允许浏览器跨域的服务用。 */
export function proxyUrl(url) {
    return `/proxy/${safeUrl(url)}`;
}

/** 按文件头识别常见音视频格式；认不出返回空串。 */
export function sniffMediaType(chunks) {
    const head = new Uint8Array(16);
    let filled = 0;
    for (const chunk of chunks) {
        const part = chunk.subarray(0, head.length - filled);
        head.set(part, filled);
        filled += part.length;
        if (filled >= head.length) break;
    }
    const ascii = (from, to) => String.fromCharCode(...head.subarray(from, to));
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
    if (ascii(4, 8) === 'ftyp') return /^M4A/.test(ascii(8, 11)) ? 'audio/mp4' : 'video/mp4';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
    if (ascii(0, 4) === 'OggS') return 'audio/ogg';
    if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
    return '';
}

const sameOrigin = (url) => {
    try { return !!globalThis.location && new URL(url, globalThis.location.href).origin === globalThis.location.origin; }
    catch { return false; }
};

export function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

/** Timeout covers response body too; reject oversized results before building a Blob. */
/** 从错误响应体里挑一句能看懂的话（各家字段不一样）。 */
export function errorMessageOf(text) {
    let data;
    try { data = JSON.parse(text); } catch { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200); }
    const pick = [data?.error?.message, data?.message, data?.msg, data?.error_msg, data?.base_resp?.status_msg, data?.detail?.message,
        typeof data?.detail === 'string' ? data.detail : null, typeof data?.error === 'string' ? data.error : null, data?.errors?.[0]?.message, data?.code];
    return String(pick.find((v) => v !== undefined && v !== null && v !== '') ?? '').slice(0, 200);
}

export async function requestData(url, options = {}, binary = false, limit = 32 * 1024 * 1024) {
    const { signal, timeout = 120000, readError = false, ...rest } = options;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    const timer = setTimeout(() => controller.abort(new Error('请求超时；请勿重复提交，先检查服务端任务')), timeout);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
        // 同源（酒馆代理）要带会话 Cookie，第三方一律不带。任务轮询必须跳过 HTTP 缓存：
        // 有的网关给状态接口发 Cache-Control: public, max-age=14400，浏览器会把首个「queued」响应缓存几小时。
        const response = await fetch(url, { redirect: 'error', cache: 'no-store', ...rest, signal: controller.signal, credentials: sameOrigin(url) ? 'same-origin' : 'omit' });
        if (!response.ok) {
            // 新接的服务把原因写在响应体里，读一小段出来；老路径保持原样（不读响应体）
            const detail = readError ? errorMessageOf((await response.text().catch(() => '')).slice(0, 2000)) : '';
            if (!readError) await response.body?.cancel();
            throw new Error(`HTTP ${response.status}：${({401:'密钥无效',403:'无权限',404:'端点或模型不存在',429:'请求受限，请稍后再试'})[response.status] || '服务请求失败'}${detail ? `（${detail}）` : ''}（未自动重试）`);
        }
        if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('媒体响应过大，请降低分辨率或时长'); }
        let type = response.headers.get('content-type') || '';
        // 酒馆 /proxy/ 只转发响应体、不带 Content-Type，所以类型为空时读完再按文件头判断。
        if (binary && type && !/^(audio\/|video\/|image\/|application\/octet-stream)/i.test(type)) {
            await response.body?.cancel(); throw new Error('服务没有返回音频或视频文件');
        }
        const chunks = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > limit) { await reader.cancel(); throw new Error('媒体响应过大，请降低分辨率或时长'); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        controller.signal.throwIfAborted();
        if (!size) throw new Error('服务返回空文件');
        if (binary && (!type || /^application\/octet-stream/i.test(type))) {
            type = sniffMediaType(chunks) || type;
            if (!type) throw new Error('服务没有返回可识别的音频或视频文件');
        }
        const blob = new Blob(chunks, { type });
        return binary ? blob : JSON.parse(await blob.text());
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof TypeError) throw new Error('网络请求失败：请检查地址、HTTPS 和服务端 CORS；没有自动重新提交');
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

/** At most two active jobs. No automatic POST retry and no idle timers. */
export async function generateMedia(kind, config, prompt, options = {}) {
    const { signal, onProgress, onTask, resume, request = requestData, sleep = wait, now = Date.now } = options;
    if (active >= 2) throw new Error('已有两个媒体任务，请等待完成或停止后重试');
    signal?.throwIfAborted();
    if (SELF_HOSTED.has(config.provider)) return runSelfHostedJob(kind, config, prompt, options);
    if (vendorFor(kind, config.provider)) return runVendorJob(kind, config, prompt, options);
    const plan = resume?.plan || { ...buildRequest(kind, config, prompt), proxy: !!config.proxy };
    // 酒馆代理只会把请求体按 JSON 重新序列化，SSML 和 multipart 过去会被改坏。
    if (plan.proxy && (typeof plan.body !== 'string' || !/json/i.test(plan.headers['Content-Type'] || ''))) {
        throw new Error('酒馆代理只支持 JSON 请求；Azure 语音和 /videos 兼容服务请关闭代理');
    }
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = Math.min(30 * 60000, Math.max(30000, Number(config.timeout) || (kind === 'video' ? 600000 : 180000)));
    const timer = setTimeout(() => controller.abort(new Error('任务等待超时；服务端可能仍在运行，请到服务商控制台查看')), timeout);
    const deadline = now() + timeout;
    const http = (url, init = {}, binary = false) => request(plan.proxy ? proxyUrl(url) : url, { headers: plan.headers, signal: controller.signal, timeout: Math.max(1, Math.min(120000, deadline - now())), ...init }, binary);
    try {
        onProgress?.(resume ? '继续查询原任务' : '正在提交');
        let data = resume ? await http(resume.links.status) : await http(plan.url, { method: 'POST', body: plan.body }, plan.binary);
        // Capture a known job even if the user stopped just as creation finished.
        const links = plan.queue ? (resume?.links || taskLinks(data, plan)) : null;
        if (links) onTask?.({ plan, links, id: data.id || data.request_id || resume?.id || '', kind });
        controller.signal.throwIfAborted();
        if (plan.binary) {
            if (!data?.size || !/^(audio\/|application\/octet-stream)/i.test(data.type)) throw new Error('服务没有返回有效音频文件');
            return { blob: data.type.startsWith('audio/') ? data : new Blob([data], { type: 'audio/mpeg' }) };
        }
        if (plan.queue) {
            let delay = 5000;
            while (true) {
                controller.signal.throwIfAborted();
                const state = taskState(data);
                if (data.error || ['failed', 'failure', 'canceled', 'cancelled', 'error', 'aborted', 'expired'].includes(state)) {
                    const error = new Error('服务端任务失败或已取消，请在服务商控制台查看详情');
                    error.terminal = true;
                    throw error;
                }
                if (['succeeded', 'completed', 'complete', 'success', 'done'].includes(state)) break;
                // 不认识的状态按「进行中」继续查（有截止时间兜底）：新状态名不该让一个快完成的计费任务被放弃。
                if (now() >= deadline) throw new Error('任务等待超时，请在服务商控制台查看');
                // Runway 等报 0–1，/videos 兼容服务多报 0–100；与 SOOYA 相同，(0,1] 按比例换算。
                const raw = Number(data.progress);
                const percent = plan.provider === 'runway' || (raw > 0 && raw <= 1) ? raw * 100 : raw;
                const progress = data.progress !== undefined && data.progress !== null && Number.isFinite(percent) ? ` · ${Math.round(Math.max(0, Math.min(100, percent)))}%` : '';
                onProgress?.(`生成中 · ${state || 'queued'}${progress}`);
                await sleep(Math.min(delay, Math.max(1, deadline - now())), controller.signal);
                controller.signal.throwIfAborted();
                if (now() >= deadline) throw new Error('任务等待超时，请继续查询原任务');
                data = await http(links.status);
                delay = Math.min(15000, delay * 1.5);
            }
            if (plan.provider === 'fal') data = await http(links.result);
            if (data.error) throw new Error('服务端结果包含错误，请在控制台查看');
            if (VIDEOS_PROTOCOL.has(plan.provider)) {
                // Authenticated video content is fetched only when the user requests playback/download.
                return { contentRequest: { url: links.result, headers: { Authorization: plan.headers.Authorization } } };
            }
        }
        controller.signal.throwIfAborted();
        if (kind === 'image') {
            const { extractImage } = await import('../api/images.js');
            const { ensureSafeImageUrl } = await import('../core/text.js');
            const image = extractImage(data) || mediaUrl(data, kind);
            if (image) return { url: ensureSafeImageUrl(image) };
        } else {
            const url = mediaUrl(data, kind);
            if (url) return { url };
        }
        throw new Error('服务响应中没有可用媒体；未自动重复提交');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active--;
    }
}

/**
 * ComfyUI / SD WebUI：默认经酒馆后端转发，浏览器直连要显式打开。
 * 图片设置传 viaTavern；视频配置里是 direct: '1'（和 CORS 代理 proxy 不是一回事）。
 */
async function runSelfHostedJob(kind, config, prompt, { signal, onProgress, fetch: fetchImpl } = {}) {
    const { buildSelfHostedPlan, runSelfHosted } = await import('./selfhosted.js');
    const plan = buildSelfHostedPlan(kind, config, prompt);
    const viaTavern = config.viaTavern !== undefined ? !!config.viaTavern : String(config.direct || '') !== '1';
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = Math.min(30 * 60000, Math.max(30000, Number(config.timeout) || (kind === 'video' ? 900000 : 300000)));
    const timer = setTimeout(() => controller.abort(new Error('等待超时；任务可能仍在自建服务里运行')), timeout);
    try {
        const { getRequestHeadersWithCsrf } = await import('../st/context.js');
        return await runSelfHosted(plan, { viaTavern, tavernHeaders: getRequestHeadersWithCsrf, signal: controller.signal, onProgress, timeout, fetch: fetchImpl });
    } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error && !signal?.aborted) throw controller.signal.reason;
        if (/Failed to fetch|Load failed|NetworkError/i.test(error?.message || '')) {
            throw new Error(viaTavern ? '连不上酒馆后端或自建服务，请检查地址和服务是否在运行'
                : `浏览器连不上 ${plan.root}：服务没运行，或没开跨域（ComfyUI 加 --enable-cors-header，SD WebUI 加 --cors-allow-origins），也可以勾选「经酒馆后端转发」`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active--;
    }
}

/**
 * 按 vendors.js 里的适配器跑：提交 →（异步任务就轮询）→ 取结果。
 * 代理、超时、停止、续查和 generateMedia 一样；各家的差异都在适配器里。
 */
async function runVendorJob(kind, config, prompt, { signal, onProgress, onTask, resume, request = requestData, sleep = wait, now = Date.now } = {}) {
    const adapter = vendorFor(kind, config.provider);
    const plan = resume?.plan || { ...vendorPlan(kind, config, prompt), proxy: !!config.proxy };
    if (plan.proxy && adapter.noProxy) throw new Error('这个服务的请求不是 JSON，不能走酒馆代理，请取消勾选');
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = Math.min(30 * 60000, Math.max(30000, Number(config.timeout) || (kind === 'video' ? 600000 : 180000)));
    const timer = setTimeout(() => controller.abort(new Error('任务等待超时；服务端可能仍在运行，请到服务商控制台查看')), timeout);
    const deadline = now() + timeout;
    // 签名类鉴权（可灵的 JWT）每次请求现算，长任务轮询时不会过期
    const http = async (url, init = {}, binary = false) => {
        const signed = adapter.sign ? await adapter.sign(config, now) : {};
        const { headers, ...rest } = init;
        const target = plan.proxy && !init.noProxy ? proxyUrl(url) : url;
        return request(target, { headers: { ...plan.headers, ...signed, ...headers }, signal: controller.signal, timeout: Math.max(1, Math.min(120000, deadline - now())), readError: true, ...rest }, binary);
    };
    const poll = (links) => http(links.status, links.statusBody ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(links.statusBody) } : {});
    try {
        onProgress?.(resume ? '继续查询原任务' : '正在提交');
        let data = resume ? await poll(resume.links)
            : await http(plan.url, { method: plan.method || 'POST', headers: plan.createHeaders, ...(plan.body !== undefined ? { body: plan.body } : {}) }, plan.binary);
        if (adapter.check) adapter.check(data);
        // 有的服务同一个接口有时直接给结果（百炼 qwen-image），有时给任务：links 为 null 就是已经有结果了
        const links = adapter.task ? (resume?.links || adapter.task.links(data, plan)) : null;
        if (links) {
            onTask?.({ plan, links, id: links.id || '', kind });
            let delay = adapter.task.firstDelay ?? 5000;
            while (true) {
                controller.signal.throwIfAborted();
                const state = adapter.task.state(data);
                if (state === 'failed') {
                    const reason = adapter.task.error?.(data);
                    const error = new Error(`服务端任务失败${reason ? `：${String(reason).slice(0, 200)}` : '，请在服务商控制台查看详情'}`);
                    error.terminal = true;
                    throw error;
                }
                if (state === 'done') break;
                if (now() >= deadline) throw new Error('任务等待超时，请继续查询原任务');
                const percent = adapter.task.progress?.(data);
                onProgress?.(`生成中 · ${state || 'queued'}${Number.isFinite(percent) ? ` · ${Math.round(Math.max(0, Math.min(100, percent)))}%` : ''}`);
                await sleep(Math.min(delay, Math.max(1, deadline - now())), controller.signal);
                controller.signal.throwIfAborted();
                data = await poll(links);
                if (adapter.check) adapter.check(data);
                delay = Math.min(adapter.task.maxDelay ?? 15000, delay * 1.5);
            }
        }
        controller.signal.throwIfAborted();
        const media = await adapter.result(data, { http, plan, config, kind, links });
        if (!media || (!media.url && !media.blob && !media.contentRequest)) throw new Error('服务响应中没有可用媒体；未自动重复提交');
        if (media.url && !media.url.startsWith('data:')) media.url = safeUrl(media.url);
        return media;
    } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error && !signal?.aborted) throw controller.signal.reason;
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active--;
    }
}

/** 视频之外，新服务的配音也可能给回一个音频地址（百炼），一样要下载下来存进酒馆。 */
export async function downloadMedia(result, kind, { signal, request = requestData, proxy = false } = {}) {
    if (kind === 'video') return downloadVideo(result, { signal, request, proxy });
    const target = safeUrl(result.contentRequest?.url || result.url);
    const blob = await request(proxy ? proxyUrl(target) : target, { signal, headers: result.contentRequest?.headers || {}, timeout: 120_000, redirect: 'follow' }, true);
    if (!blob?.size || !/^(audio\/|application\/octet-stream)/i.test(blob.type)) throw new Error('服务未返回有效音频');
    return blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: 'audio/mpeg' });
}

/** Only explicit playback/download invokes this. CDN requests never receive API keys. */
export async function downloadVideo(result, { signal, request = requestData, proxy = false } = {}) {
    const descriptor = result.contentRequest;
    const target = safeUrl(descriptor?.url || result.url);
    const url = proxy ? proxyUrl(target) : target;
    // /videos/{id}/content 通常 302 到对象存储；浏览器跨域跳转时会自动去掉 Authorization。
    const blob = await request(url, { signal, headers: descriptor?.headers || {}, timeout: 300_000, redirect: 'follow' }, true, 128 * 1024 * 1024);
    signal?.throwIfAborted();
    if (!blob?.size || !/^(video\/|application\/octet-stream)/i.test(blob.type)) throw new Error('服务未返回有效视频');
    return blob.type.startsWith('video/') ? blob : new Blob([blob], { type: 'video/mp4' });
}

// AI Image Generator - IndexedDB 版
const extensionName = 'st-ai-image';
const extensionFolder = `scripts/extensions/third-party/${extensionName}`;
const DB_NAME = 'st_ai_image_db';
const DB_VERSION = 1;
const STORE_NAME = 'history';
const FALLBACK_HISTORY_KEY = `${extensionName}_history_fallback`;
const IMAGE_TAG_NAMES_SOURCE = String.raw`image|图片|图像|画图|生图`;
const IMAGE_REQUEST_SOURCE = String.raw`\[\s*(${IMAGE_TAG_NAMES_SOURCE})\s*\]([\s\S]+?)\[\s*\/\s*\1\s*\]|<\s*(${IMAGE_TAG_NAMES_SOURCE})\s*>([\s\S]+?)<\s*\/\s*\3\s*>`;
const IMAGE_TAG_RE = new RegExp(IMAGE_REQUEST_SOURCE, 'gi');
const IMAGE_TAG_FIRST_RE = new RegExp(IMAGE_REQUEST_SOURCE, 'i');
const IMAGE_TAG_QUICK_RE = /\[\s*\/?\s*(?:image|图片|图像|画图|生图)\s*\]|<\s*\/?\s*(?:image|图片|图像|画图|生图)\s*>/i;
const INLINE_IMAGE_MARKER_RE = /\[st-ai-image\b[^\]]*\]/g;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((<([^>]+)>|([^)]+))\)/g;

// ===== 命名常量（提取魔法数字） =====
const MAX_HISTORY_ITEMS = 200;           // 历史记录最大条数
const FETCH_TIMEOUT_MS = 60000;          // fetch 请求默认超时时间（毫秒）
const IMAGE_GEN_TIMEOUT_MS = 120000;     // 生图 API 超时时间（毫秒），谷歌 Imagen 等模型生成较慢
const INLINE_SCAN_INTERVAL_MS = 3000;     // 内联扫描间隔（毫秒）
const INLINE_SCAN_DURATION_MS = 30000;   // 内联扫描持续时间（毫秒）
const SCAN_DEBOUNCE_MS = 150;            // 扫描防抖延迟（毫秒）
const ERROR_DISPLAY_DURATION_MS = 5000;  // 错误提示显示时长（毫秒）
const MAX_PROMPT_LENGTH = 1200;          // 楼层提示词最大长度
const API_ERROR_SUMMARY_LENGTH = 340;    // API 错误摘要最大长度
const VALID_URL_PROTOCOL_RE = /^https?:\/\//i; // 合法 URL 协议校验

const defaultSettings = {
    enabled: true,
    autoDetect: true,
    apiBase: '',
    apiKey: '',
    model: 'ai-image-2',
    size: '1024x1024',
    quality: 'auto',
    saveHistory: true,
    extraPrompt: '',
    negativePrompt: '',
    autoInjectPrompt: true,
    systemPrompt: "[AI绘图触发规则]当剧情推进到需要展示视觉场景、战斗、物品道具、环境变化、或角色换装等画面时，你必须在文中叙述合适位置插入出图标签。格式:[image] 画面主体的极其详尽视觉细节描述，不得有任何抽象概念词 [/image] (每次回复最多只允许出现一个标签)",
};

const inlineTasks = new Map();
const historyEnsureTasks = new Map();
const markdownGallerySyncTasks = new Map();
let inlineScanInterval = null;
let inlineScanIntervalStopAt = 0;
let currentFloorMessageElement = null;


// localStorage 存储设置（设置很小，不需要 IndexedDB）
function getSettings() {
    try {
        const raw = localStorage.getItem(`${extensionName}_settings`);
        const s = raw ? JSON.parse(raw) : {};
        for (const [k, v] of Object.entries(defaultSettings)) {
            if (s[k] === undefined) s[k] = v;
        }
        return s;
    } catch {
        return { ...defaultSettings };
    }
}

function saveSettings(s) {
    localStorage.setItem(`${extensionName}_settings`, JSON.stringify(s));
}

// ===== 带超时的 fetch 工具 =====
function fetchWithTimeout(url, options = {}) {
    const { timeout = FETCH_TIMEOUT_MS, signal, ...rest } = options;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('请求超时')), timeout);
    // 如果外部传入了 signal，监听其 abort
    if (signal) {
        signal.addEventListener('abort', () => controller.abort(signal.reason));
    }
    return fetch(url, { ...rest, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

// ===== 外部 API 请求（绕过 iOS ATS/混合内容限制）=====
// iOS WebView 中 fetch() 对外部 HTTP 请求有 ATS 限制，
// 使用 jQuery $.ajax 可以绕过此限制（走不同的网络栈）
function externalApiRequest(url, options = {}) {
    const { method = 'GET', headers = {}, body, timeout = FETCH_TIMEOUT_MS } = options;

    return new Promise((resolve, reject) => {
        const ajaxOpts = {
            url,
            method,
            headers,
            timeout,
            success: (data, textStatus, jqXHR) => {
                // 模拟 Response 对象
                const resp = new Response(
                    typeof data === 'string' ? data : JSON.stringify(data),
                    {
                        status: jqXHR.status,
                        statusText: textStatus,
                        headers: new Headers(parseResponseHeaders(jqXHR.getAllResponseHeaders())),
                    }
                );
                resolve(resp);
            },
            error: (jqXHR, textStatus, errorThrown) => {
                if (textStatus === 'timeout') {
                    reject(new Error('请求超时'));
                } else {
                    reject(new Error(errorThrown || textStatus || '请求失败'));
                }
            },
        };

        if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
            ajaxOpts.data = body;
            if (typeof body === 'string') {
                try { ajaxOpts.dataType = 'json'; } catch {}
            }
        }

        $.ajax(ajaxOpts);
    });
}

// 解析 XHR 响应头字符串为对象
function parseResponseHeaders(headerStr) {
    const headers = {};
    if (!headerStr) return headers;
    const lines = headerStr.trim().split(/[\r\n]+/);
    for (const line of lines) {
        const idx = line.indexOf(': ');
        if (idx > 0) {
            const key = line.substring(0, idx).trim().toLowerCase();
            const val = line.substring(idx + 2).trim();
            headers[key] = val;
        }
    }
    return headers;
}

// 判断是否为需要 $.ajax 的外部地址（仅 HTTP 外部地址需要，HTTPS 可正常 fetch）
function needsAjaxFallback(url) {
    try {
        if (!/^http:\/\//i.test(url)) return false; // HTTPS 或非 HTTP 不需要
        const parsed = new URL(url);
        return parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1';
    } catch { return false; }
}

// 统一请求入口：HTTP 外部地址用 $.ajax，其他用 fetch
function apiFetch(url, options = {}) {
    return needsAjaxFallback(url) ? externalApiRequest(url, options) : fetchWithTimeout(url, options);
}

// ===== API Base URL 校验 =====
function isValidApiBaseUrl(url) {
    const trimmed = String(url ?? '').trim();
    if (!trimmed) return true; // 空值允许（未配置时）
    return VALID_URL_PROTOCOL_RE.test(trimmed);
}

// ===== API 预设 =====
const PRESET_KEY = `${extensionName}_presets`;

function getPresets() {
    try {
        return JSON.parse(localStorage.getItem(PRESET_KEY)) || {};
    } catch { return {}; }
}

function savePresets(presets) {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
}

function refreshPresetList() {
    const $sel = $('#st_gpt_preset_select');
    const presets = getPresets();
    const current = $sel.val();
    $sel.empty().append('<option value="">-- 选择预设 --</option>');
    for (const name of Object.keys(presets).sort()) {
        $sel.append(`<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`);
    }
    if (current && presets[current]) $sel.val(current);
}

function loadPreset(name) {
    const presets = getPresets();
    if (!presets[name]) return;
    const p = presets[name];
    const s = getSettings();
    s.apiBase = p.apiBase || '';
    s.apiKey = p.apiKey || '';
    s.model = p.model || '';
    saveSettings(s);
    $('#st_gpt_image_api_base').val(s.apiBase);
    $('#st_gpt_image_api_key').val(s.apiKey);
    $('#st_gpt_image_model').val(s.model);
    toastr.success(`已加载预设: ${name}`);
}

function saveCurrentAsPreset() {
    const s = getSettings();
    if (!s.apiBase && !s.apiKey) return toastr.warning('请先填写 API 配置');
    const name = prompt('输入预设名称:', s.model || '新预设');
    if (!name?.trim()) return;
    const presets = getPresets();
    presets[name.trim()] = { apiBase: s.apiBase, apiKey: s.apiKey, model: s.model };
    savePresets(presets);
    refreshPresetList();
    $('#st_gpt_preset_select').val(name.trim());
    toastr.success(`预设已保存: ${name.trim()}`);
}

function deleteSelectedPreset() {
    const name = $('#st_gpt_preset_select').val();
    if (!name) return toastr.warning('请先选择一个预设');
    if (!confirm(`删除预设 "${name}"？`)) return;
    const presets = getPresets();
    delete presets[name];
    savePresets(presets);
    refreshPresetList();
    toastr.success(`已删除预设: ${name}`);
}

// ===== IndexedDB 图库 =====
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function normalizeHistoryEntry(entry, id = entry?.id) {
    const item = {
        prompt: String(entry?.prompt ?? ''),
        imageUrl: sanitizeImageUrl(entry?.imageUrl),
        timestamp: Number(entry?.timestamp || Date.now()),
        model: entry?.model,
        size: entry?.size,
    };
    if (id !== undefined && id !== null && id !== '') item.id = id;
    return item;
}

function mergeHistoryItems(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : [])
        .map((item) => normalizeHistoryEntry(item))
        .filter((item) => item.imageUrl)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .filter((item) => {
            const key = item.imageUrl || `id:${item.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function getFallbackHistory() {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(FALLBACK_HISTORY_KEY);
        return mergeHistoryItems(JSON.parse(raw || '[]'));
    } catch {
        return [];
    }
}

function saveFallbackHistoryEntry(entry) {
    if (typeof localStorage === 'undefined') return null;
    const item = normalizeHistoryEntry(entry, entry?.id || `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    if (!item.imageUrl) return null;
    try {
        const items = mergeHistoryItems([item, ...getFallbackHistory()]).slice(0, MAX_HISTORY_ITEMS);
        localStorage.setItem(FALLBACK_HISTORY_KEY, JSON.stringify(items));
        return item;
    } catch (e) {
        console.error('[st-ai-image] fallback history save error:', e);
        return null;
    }
}

async function getIndexedDbHistory() {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => {
                const items = req.result || [];
                items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                resolve(items);
            };
            req.onerror = () => resolve([]);
        });
    } catch { return []; }
}

async function getHistory() {
    const indexedDbHistory = await getIndexedDbHistory();
    return mergeHistoryItems([...indexedDbHistory, ...getFallbackHistory()]);
}

async function getHistoryItem(id) {
    const fallbackItem = getFallbackHistory().find((item) => String(item.id) === String(id));
    if (fallbackItem) return fallbackItem;
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) return null;

    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(numericId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function addHistoryEntry(entry) {
    const item = normalizeHistoryEntry(entry, undefined);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.add(item);
        let id = null;
        req.onsuccess = () => { id = req.result; };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => {
            trimHistory();
            resolve({ ...item, id });
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('History save transaction aborted'));
    });
}

async function saveToHistory(entry, { force = false } = {}) {
    const s = getSettings();
    if (!s.saveHistory && !force) return null;
    try {
        const saved = await addHistoryEntry(entry);
        renderGallery();
        return saved;
    } catch (e) {
        console.error('[st-ai-image] saveToHistory error:', e);
        const fallback = saveFallbackHistoryEntry(entry);
        if (fallback) {
            renderGallery();
        } else {
            // IndexedDB 与 localStorage 均失败：把真实原因弹出来，便于排查（手机端无 console）
            toastr.error(`图库保存失败: ${e?.message || e}`, 'st-ai-image', { timeOut: 8000 });
        }
        return fallback;
    }
}

function parseDataImageUrl(value) {
    const match = String(value ?? '').trim().match(/^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i);
    if (!match) return null;
    const mimeSubtype = match[1].toLowerCase();
    const format = mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype.split('+')[0];
    if (!/^(png|jpg|jpeg|webp|gif|bmp|avif)$/.test(format)) return null;
    return { format, base64: match[2].replace(/\s+/g, '') };
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function fetchImageAsDataUrl(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!/^https?:/i.test(safeUrl)) return '';
    const response = await apiFetch(safeUrl);
    if (!response.ok) throw new Error(`图片下载失败: ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('远程地址不是图片');
    return await blobToDataUrl(blob);
}

function getRequestHeadersForJson() {
    const ctx = getSillyTavernContext();
    if (typeof ctx?.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    return { 'Content-Type': 'application/json' };
}

let _csrfTokenCache = null;

async function getCsrfToken() {
    if (_csrfTokenCache) return _csrfTokenCache;
    try {
        const res = await fetch('/csrf-token');
        if (res.ok) {
            const data = await res.json();
            _csrfTokenCache = data.token || '';
            return _csrfTokenCache;
        }
    } catch (e) {
        console.warn('[st-ai-image] 获取CSRF token失败:', e);
    }
    return '';
}

async function getRequestHeadersWithCsrf() {
    const headers = getRequestHeadersForJson();
    const token = await getCsrfToken();
    if (token) headers['x-csrf-token'] = token;
    return headers;
}

function getSillyTavernGalleryFolder() {
    const ctx = getSillyTavernContext();
    const character = Number.isInteger(ctx?.characterId) ? ctx.characters?.[ctx.characterId] : null;
    return character?.name || 'AI Image Generator';
}

function getStableInlineImageUrl(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl || /^blob:/i.test(safeUrl)) return '';
    return safeUrl;
}

function normalizeGalleryImageUrl(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) return '';
    try {
        const base = typeof window !== 'undefined' && window.location?.href ? window.location.href : 'https://example.test/';
        const parsed = new URL(safeUrl, base);
        const decodedPath = decodeURI(parsed.pathname);
        if (/^\/user\/images\//i.test(decodedPath)) return decodedPath + parsed.search + parsed.hash;
    } catch {}
    return safeUrl;
}

function isUserImagesUrl(imageUrl) {
    return /^\/user\/images\//i.test(normalizeGalleryImageUrl(imageUrl));
}

async function uploadImageToSillyTavernGallery(imageUrl) {
    let dataImage = parseDataImageUrl(imageUrl);
    if (!dataImage) {
        const fetchedDataUrl = await fetchImageAsDataUrl(imageUrl);
        dataImage = parseDataImageUrl(fetchedDataUrl);
    }
    if (!dataImage) return '';

    const body = JSON.stringify({
        image: dataImage.base64,
        format: dataImage.format,
        ch_name: getSillyTavernGalleryFolder(),
        filename: `st-ai-image-${Date.now()}`,
    });

    let response = await fetchWithTimeout('/api/images/upload', {
        method: 'POST',
        headers: await getRequestHeadersWithCsrf(),
        body,
    });

    if (response.status === 403) {
        _csrfTokenCache = null;
        response = await fetchWithTimeout('/api/images/upload', {
            method: 'POST',
            headers: await getRequestHeadersWithCsrf(),
            body,
        });
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`酒馆图库保存失败: ${summarizeApiError(errorText)}`);
    }

    const data = await response.json();
    return sanitizeImageUrl(data.path);
}

async function saveGeneratedImage(entry, { force = false } = {}) {
    let imageUrl = sanitizeImageUrl(entry.imageUrl);
    let serverImageUrl = '';

    try {
        serverImageUrl = await uploadImageToSillyTavernGallery(imageUrl);
    } catch (e) {
        console.warn('[st-ai-image] upload to SillyTavern gallery failed:', e);
    }

    if (serverImageUrl) imageUrl = normalizeGalleryImageUrl(serverImageUrl);
    const saved = await saveToHistory({ ...entry, imageUrl }, { force });
    return { saved, imageUrl, serverImageUrl };
}

async function findHistoryByImageUrl(imageUrl) {
    const safeUrl = normalizeGalleryImageUrl(imageUrl);
    if (!safeUrl) return null;
    const history = await getHistory();
    return history.find((item) => normalizeGalleryImageUrl(item.imageUrl) === safeUrl) || null;
}

async function ensureHistoryEntryForImageUrl(imageUrl, defaults = {}) {
    const safeUrl = normalizeGalleryImageUrl(imageUrl);
    if (!safeUrl) return null;
    if (historyEnsureTasks.has(safeUrl)) return await historyEnsureTasks.get(safeUrl);

    const task = (async () => {
        const existing = await findHistoryByImageUrl(safeUrl);
        if (existing) return existing;
        return await saveToHistory({
            prompt: defaults.prompt || '',
            imageUrl: safeUrl,
            timestamp: defaults.timestamp || Date.now(),
            model: defaults.model,
            size: defaults.size,
        }, { force: true });
    })();

    historyEnsureTasks.set(safeUrl, task);
    try {
        return await task;
    } finally {
        historyEnsureTasks.delete(safeUrl);
    }
}

async function syncMarkdownImagesToHistoryFromText(text) {
    const images = extractMarkdownImages(text).filter((image) => isUserImagesUrl(image.imageUrl));
    for (const image of images) {
        await ensureHistoryEntryForImageUrl(normalizeGalleryImageUrl(image.imageUrl), { prompt: image.prompt });
    }
}

async function syncRenderedChatImagesToHistory() {
    if (typeof document === 'undefined') return false;
    const images = Array.from(document.querySelectorAll('#chat .mes_text img, #chat .mes img'))
        .map((img) => ({
            prompt: img.getAttribute('alt') || img.closest?.('.mes')?.querySelector?.('.name_text')?.textContent || 'AI Image',
            imageUrl: normalizeGalleryImageUrl(img.getAttribute('src') || img.currentSrc || img.src),
        }))
        .filter((image) => isUserImagesUrl(image.imageUrl));

    for (const image of images) {
        await ensureHistoryEntryForImageUrl(image.imageUrl, { prompt: image.prompt });
    }
    if (images.length) renderGallery();
    return images.length > 0;
}

async function syncMarkdownImagesInChatToHistory() {
    const ctx = getSillyTavernContext();
    if (!ctx?.chat?.length) return false;

    const key = ctx.chat.map((message) => `${message?.mes || ''}|${message?.swipe_id || 0}`).join('\n');
    if (markdownGallerySyncTasks.has(key)) return await markdownGallerySyncTasks.get(key);

    const task = (async () => {
        for (const message of ctx.chat) {
            if (!message) continue;
            if (typeof message.mes === 'string') await syncMarkdownImagesToHistoryFromText(message.mes);
            if (Array.isArray(message.swipes)) {
                for (const swipe of message.swipes) {
                    if (typeof swipe === 'string') await syncMarkdownImagesToHistoryFromText(swipe);
                }
            }
        }
        await syncRenderedChatImagesToHistory();
        renderGallery();
        return true;
    })();

    markdownGallerySyncTasks.set(key, task);
    try {
        return await task;
    } finally {
        markdownGallerySyncTasks.delete(key);
    }
}

async function trimHistory(retryCount = 0) {
    try {
        const items = await getHistory();
        if (items.length > MAX_HISTORY_ITEMS) {
            const db = await openDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const toDelete = items.slice(MAX_HISTORY_ITEMS);
            for (const item of toDelete) store.delete(item.id);
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('trimHistory transaction aborted'));
            });
        }
    } catch (e) {
        console.warn('[st-ai-image] trimHistory error:', e);
        // 最多重试一次
        if (retryCount < 1) {
            setTimeout(() => trimHistory(retryCount + 1), 1000);
        } else {
            console.error('[st-ai-image] trimHistory failed after retry, history may exceed limit');
        }
    }
}

async function deleteHistoryItem(id) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => renderGallery();
    } catch (e) { console.warn('[st-ai-image] deleteHistoryItem error:', e); }
}

async function clearHistory() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => renderGallery();
    } catch (e) { console.warn('[st-ai-image] clearHistory error:', e); }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function sanitizeImageUrl(value) {
    const url = String(value ?? '').trim();
    if (!url) return '';
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-zA-Z0-9+/=\s]+$/i.test(url)) return url;
    if (/^blob:/i.test(url)) return url;
    try {
        const base = typeof window !== 'undefined' && window.location?.href ? window.location.href : 'https://example.invalid/';
        const parsed = new URL(url, base);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    } catch {}
    return '';
}

function summarizeApiError(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > API_ERROR_SUMMARY_LENGTH ? `${text.slice(0, API_ERROR_SUMMARY_LENGTH)}...` : text;
}

function ensureSafeImageUrl(value) {
    const safeUrl = sanitizeImageUrl(value);
    if (!safeUrl) throw new Error('API 返回了不安全或无法识别的图片地址');
    return safeUrl;
}

function escapeMarkdownAlt(value) {
    return String(value ?? 'AI Image')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/\]/g, '\\]')
        .trim() || 'AI Image';
}

function formatMarkdownImageUrl(value) {
    const safeUrl = sanitizeImageUrl(value);
    if (!safeUrl) return '';
    if (/^data:/i.test(safeUrl)) return safeUrl;
    return encodeURI(safeUrl).replace(/[()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function createMarkdownImageMarkup(imageUrl, prompt = '') {
    const url = formatMarkdownImageUrl(imageUrl);
    if (!url) return '';
    return `![${escapeMarkdownAlt(prompt || 'AI Image')}](${url})`;
}

function unescapeMarkdownAlt(value) {
    return String(value ?? '').replace(/\\([\]\\])/g, '$1').trim();
}

function extractMarkdownImages(text) {
    MARKDOWN_IMAGE_RE.lastIndex = 0;
    const images = [];
    let match;
    while ((match = MARKDOWN_IMAGE_RE.exec(String(text ?? ''))) !== null) {
        const rawUrl = match[3] ?? match[4] ?? '';
        let decodedUrl = rawUrl.trim();
        try {
            decodedUrl = decodeURI(decodedUrl);
        } catch {}
        const imageUrl = sanitizeImageUrl(decodedUrl);
        if (imageUrl) images.push({ prompt: unescapeMarkdownAlt(match[1]) || 'AI Image', imageUrl });
    }
    return images;
}

function createInlineImageMarker(id) {
    if (id && typeof id === 'object') {
        const safeId = String(id.id ?? '').replace(/[^a-zA-Z0-9_.:-]/g, '');
        if (safeId) return `[st-ai-image id="${safeId}"]`;
        // 没有 ID 时才用 markdown 内联 URL（会占用发给 AI 的上下文）
        const safeUrl = sanitizeImageUrl(id.imageUrl);
        if (safeUrl) return createMarkdownImageMarkup(safeUrl, id.prompt);
        return '';
    }
    const safeId = String(id ?? '').replace(/[^a-zA-Z0-9_.:-]/g, '');
    return safeId ? `[st-ai-image id="${safeId}"]` : '';
}

function parseInlineImageMarker(marker) {
    const text = String(marker ?? '');
    const srcMatch = text.match(/\bsrc=(?:"([^"]*)"|'([^']*)'|([^\]\s]+))/);
    const idMatch = text.match(/\bid=(?:"([^"]*)"|'([^']*)'|([a-zA-Z0-9_.:-]+))/);
    const rawSrc = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '') : '';
    const rawId = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3] ?? '') : '';
    let imageUrl = '';
    if (rawSrc) {
        try {
            imageUrl = sanitizeImageUrl(decodeURIComponent(rawSrc));
        } catch {
            imageUrl = sanitizeImageUrl(rawSrc);
        }
    }
    return {
        id: rawId.replace(/[^a-zA-Z0-9_.:-]/g, ''),
        imageUrl,
    };
}

function replaceInlineImageMarkersWithMarkdown(text) {
    INLINE_IMAGE_MARKER_RE.lastIndex = 0;
    return String(text ?? '').replace(INLINE_IMAGE_MARKER_RE, (marker) => {
        const info = parseInlineImageMarker(marker);
        return info.imageUrl ? createMarkdownImageMarkup(info.imageUrl) : marker;
    });
}

function hasInlineImageMarker(text) {
    INLINE_IMAGE_MARKER_RE.lastIndex = 0;
    return INLINE_IMAGE_MARKER_RE.test(String(text ?? ''));
}

function hasInlineRenderableTag(text) {
    return hasImageTag(text) || hasInlineImageMarker(text);
}

function shouldProcessInlineText(text, settings = getSettings()) {
    const value = String(text ?? '');
    if (hasInlineImageMarker(value)) return true;
    if (!settings.enabled || !settings.autoDetect) return false;
    return hasImageTag(value);
}

function getImageRequestPrompt(match) {
    if (!match) return '';
    return String(match[2] ?? match[4] ?? '').trim();
}

function replaceFirstImageRequest(text, originalTag, imageId) {
    const value = String(text ?? '');
    const marker = createInlineImageMarker(imageId);
    if (!marker) return value;
    if (originalTag && value.includes(originalTag)) return value.replace(originalTag, marker);
    return value.replace(IMAGE_TAG_FIRST_RE, marker);
}

function buildImageActionsHtml(context, prompt, imageUrl, options = {}) {
    const safeUrl = escapeAttr(sanitizeImageUrl(imageUrl));
    const disabled = safeUrl ? '' : ' disabled';
    const allowSave = context !== 'gallery' && options.allowSave !== false;
    const historyId = options.historyId ? escapeAttr(options.historyId) : '';
    // 存入图库按钮：只要有 URL 就启用（已存入时切换为查看图库）
    const saveDisabled = safeUrl ? '' : ' disabled';
    const saveTitle = historyId ? '查看图库' : '存入图库';
    const saveIcon = historyId ? 'fa-bookmark' : 'fa-folder-plus';
    return `
        <button type="button" class="st_gpt_image_btn" data-action="download-image" data-context="${escapeAttr(context)}" data-url="${safeUrl}" title="下载图片" aria-label="下载图片"${disabled}><i class="fa-solid fa-download"></i></button>
        ${allowSave ? `<button type="button" class="st_gpt_image_btn" data-action="${historyId ? 'view-gallery' : 'save-image'}" data-context="${escapeAttr(context)}" data-url="${safeUrl}" data-prompt="${escapeAttr(prompt)}" data-history-id="${historyId}" title="${saveTitle}" aria-label="${saveTitle}"${saveDisabled}><i class="fa-solid ${saveIcon}"></i></button>` : ''}
    `;
}

function hasImageTag(text) {
    IMAGE_TAG_QUICK_RE.lastIndex = 0;
    if (!IMAGE_TAG_QUICK_RE.test(String(text ?? ''))) return false;
    IMAGE_TAG_RE.lastIndex = 0;
    return IMAGE_TAG_RE.test(String(text ?? ''));
}

// ===== API (根据模型自动选择端点) =====
function extractImageFromResponse(data) {
    if (!data) return null;
    const pick = (img) => {
        if (!img) return null;
        if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
        if (img.url) return img.url;
        return null;
    };
    // OpenAI 标准: data.data[0]
    if (Array.isArray(data.data) && data.data.length) {
        const r = pick(data.data[0]); if (r) return r;
    }
    // 部分中转: 顶层直接是数组（无 .data 包裹）
    if (Array.isArray(data) && data.length) {
        const r = pick(data[0]); if (r) return r;
    }
    // 部分中转: data.images[0]
    if (Array.isArray(data.images) && data.images.length) {
        const r = pick(data.images[0]); if (r) return r;
    }
    // 部分中转: 顶层 url / b64_json
    if (data.b64_json) return `data:image/png;base64,${data.b64_json}`;
    if (data.url) return data.url;
    // Gemini 格式: candidates[0].content.parts[].inlineData
    const parts = data.candidates?.[0]?.content?.parts;
    if (parts) {
        for (const part of parts) {
            if (part.inlineData?.data) {
                const mime = part.inlineData.mimeType || 'image/png';
                return `data:${mime};base64,${part.inlineData.data}`;
            }
        }
    }
    return null;
}

// 从 chat/completions 响应中提取图片（Gemini 生图走此路径）
function extractImageFromChatResponse(data) {
    const msg = data.choices?.[0]?.message;
    // 部分中转: message.images[0]
    if (Array.isArray(msg?.images) && msg.images.length) {
        const im = msg.images[0];
        if (im?.b64_json) return `data:image/png;base64,${im.b64_json}`;
        if (im?.url) return im.url;
    }
    // 1. OpenAI 格式：choices[0].message.content 中的 inline_data
    const content = msg?.content;
    if (content) {
        // content 可能是字符串，也可能包含 base64 图片
        // 部分 OpenAI 兼容中转会在 content 中直接返回 base64
        if (typeof content === 'string') {
            // 检查 markdown 图片格式 ![...](data:image/...)
            const mdMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^\s)]+)\)/);
            if (mdMatch) return mdMatch[1];
            // 检查纯 base64 data URL
            const dataUrlMatch = content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
            if (dataUrlMatch) return dataUrlMatch[1];
            // 纯 http(s) 图片 URL
            const urlMatch = content.match(/(https?:\/\/\S+\.(?:png|jpe?g|webp|gif|bmp))/i);
            if (urlMatch) return urlMatch[1];
        }
        // content 可能是数组（多模态响应）
        if (Array.isArray(content)) {
            for (const part of content) {
                if (part.type === 'image_url' && part.image_url?.url) return part.image_url.url;
                if (part.type === 'image' && part.source?.data) {
                    const mime = part.source.media_type || 'image/png';
                    return `data:${mime};base64,${part.source.data}`;
                }
                if (part.inlineData?.data) {
                    const mime = part.inlineData.mimeType || 'image/png';
                    return `data:${mime};base64,${part.inlineData.data}`;
                }
            }
        }
    }

    // 2. Gemini 原生格式：candidates[0].content.parts[]
    const parts = data.candidates?.[0]?.content?.parts;
    if (parts) {
        for (const part of parts) {
            if (part.inlineData?.data) {
                const mime = part.inlineData.mimeType || 'image/png';
                return `data:${mime};base64,${part.inlineData.data}`;
            }
        }
    }

    // 3. 尝试从 extractImageFromResponse 复用
    return extractImageFromResponse(data);
}

async function callImageAPI(prompt, { signal } = {}) {
    const s = getSettings();
    let base = s.apiBase.replace(/\/+$/, '');
    if (base.endsWith('/v1')) base = base.slice(0, -3);

    // 拼接额外提示词
    const extra = String(s.extraPrompt || '').trim();
    const negative = String(s.negativePrompt || '').trim();
    let fullPrompt = prompt;
    if (extra) fullPrompt = `${extra}, ${fullPrompt}`;

    const model = String(s.model || '');
    const isGemini = /gemini/i.test(model);
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.apiKey}` };
    const errors = [];

    const imageGenBody = { model: s.model, prompt: fullPrompt, n: 1, size: s.size };
    if (s.quality && s.quality !== 'auto') imageGenBody.quality = s.quality;
    if (negative) imageGenBody.negative_prompt = negative;

    const chatBase = { model: s.model, stream: false, messages: [{ role: 'user', content: fullPrompt }] };
    const chatModalitiesBody = { ...chatBase, modalities: ['text', 'image'] };

    // Gemini 优先 chat/completions（带 modalities）；gpt-image 等优先 images/generations
    const order = isGemini
        ? ['chat_modalities', 'images_generations', 'chat_plain']
        : ['images_generations', 'chat_modalities', 'chat_plain'];

    for (const attempt of order) {
        try {
            let resp;
            if (attempt === 'images_generations') {
                resp = await apiFetch(`${base}/v1/images/generations`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(imageGenBody),
                    signal,
                    timeout: IMAGE_GEN_TIMEOUT_MS,
                });
            } else {
                const body = attempt === 'chat_modalities' ? chatModalitiesBody : chatBase;
                resp = await apiFetch(`${base}/v1/chat/completions`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal,
                    timeout: IMAGE_GEN_TIMEOUT_MS,
                });
            }
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                errors.push(`${attempt}: HTTP ${resp.status} ${summarizeApiError(errText)}`);
                continue;
            }
            const data = await resp.json();
            const img = extractImageFromResponse(data) || extractImageFromChatResponse(data);
            if (img) return ensureSafeImageUrl(img);
            errors.push(`${attempt}: 响应中未找到图片`);
        } catch (e) {
            if (e?.name === 'AbortError') throw e;   // 用户主动取消，直接抛
            errors.push(`${attempt}: ${e.message}`);
        }
    }

    throw new Error(`生图失败 — ${errors.join(' | ')}`);
}

// ===== 获取模型列表 (自动尝试两种格式) =====
async function fetchModels() {
    const s = getSettings();
    if (!s.apiKey) return toastr.error('请先填写 API Key');
    if (!s.apiBase) return toastr.error('请先填写 API Base URL');

    const $btn = $('#st_gpt_fetch_models');
    const $list = $('#st_gpt_model_list');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');

    try {
        let models = [];
        let base = s.apiBase.replace(/\/+$/, '');
        if (base.endsWith('/v1')) base = base.slice(0, -3);

        // 使用 OpenAI 兼容格式获取模型列表
        try {
            const resp = await apiFetch(`${base}/v1/models`, {
                headers: { 'Authorization': `Bearer ${s.apiKey}` },
            });
            if (resp.ok) {
                const data = await resp.json();
                models = (data.data || []).map(m => ({ id: m.id, name: m.id }));
            } else {
                const errText = await resp.text().catch(() => '');
                console.warn('[st-ai-image] fetchModels HTTP error:', resp.status, errText);
                toastr.warning(`获取模型列表失败: HTTP ${resp.status} - ${errText.substring(0, 100)}`);
            }
        } catch (fetchErr) {
            console.warn('[st-ai-image] fetchModels network error:', fetchErr);
            toastr.warning(`获取模型列表网络错误: ${fetchErr.message}`);
        }

        if (!models.length) {
            toastr.warning('未获取到模型列表');
            return;
        }

        $list.empty().show();
        models.forEach(m => {
            $list.append(`<option value="${escapeAttr(m.id)}">${escapeHtml(m.name || m.id)}</option>`);
        });
        $list.val(s.model);

        toastr.success(`获取到 ${models.length} 个模型`);
    } catch (e) {
        console.error('[st-ai-image] fetchModels error:', e);
        toastr.error(e.message, '获取模型列表失败');
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-rotate"></i>');
    }
}

let _currentGenAbortController = null;

async function generateImage(prompt) {
    if (!prompt?.trim()) return toastr.warning('请输入图片描述');
    const s = getSettings();
    if (!s.apiKey) return toastr.error('请先在设置中填写 API Key');

    // 取消上一次进行中的请求
    _currentGenAbortController?.abort();
    _currentGenAbortController = new AbortController();

    const $btn = $('#st_gpt_image_generate_btn');
    const $result = $('#st_gpt_gen_result');
    $btn.prop('disabled', true);
    $result.html('<div class="st_ai_loading"><div class="st_ai_spinner"></div> 正在生成...</div>');

    try {
        const cleanPrompt = prompt.trim();
        const url = await callImageAPI(cleanPrompt, { signal: _currentGenAbortController.signal });
        const { saved, imageUrl } = await saveGeneratedImage({ prompt: cleanPrompt, imageUrl: url, timestamp: Date.now(), model: s.model, size: s.size });

        $result.html(`
            <img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(cleanPrompt)}" class="st_gpt_gen_img" data-prompt="${escapeAttr(cleanPrompt)}">
            <div class="st_gpt_gen_result_info">
                <div class="st_ai_action_row">
                    ${buildImageActionsHtml('result', cleanPrompt, imageUrl, { historyId: saved?.id })}
                </div>
            </div>
        `);

        $result.find('img').on('click', () => showPreview(imageUrl, cleanPrompt));
        if (!saved) toastr.warning('图片已生成，但保存到图库失败，请检查存储权限或清理空间');
        toastr.success('图片生成完成', 'GPT Image');
        return imageUrl;
    } catch (e) {
        if (e.name === 'AbortError') {
            $result.html('<div class="st_ai_gen_placeholder">已取消</div>');
            return null;
        }
        console.error('[st-ai-image]', e);
        $result.html(`<div class="st_ai_gen_placeholder st_ai_error_text">生成失败: ${escapeHtml(e.message)}</div>`);
        toastr.error(e.message, '生成失败');
        return null;
    } finally {
        _currentGenAbortController = null;
        $btn.prop('disabled', false);
    }
}

// ===== 预览 =====
function showPreview(imageUrl, prompt) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) {
        toastr.error('图片地址无效，无法预览');
        return;
    }
    const $p = $('#st_gpt_image_preview');
    const closePreview = () => {
        $p.removeClass('st_gpt_preview_visible').off('.stAiPreview');
        $(document).off('keydown.stAiPreview');
    };

    $p.off('.stAiPreview');
    $(document).off('keydown.stAiPreview');
    $p.html(`
        <div class="st_gpt_preview_content">
            <div class="st_gpt_preview_header">
                <span class="st_gpt_preview_title">图片预览</span>
                <div class="st_ai_action_row">
                    <button type="button" class="st_gpt_image_btn" id="st_gpt_pv_dl" data-url="${escapeAttr(safeUrl)}" title="下载图片" aria-label="下载图片"><i class="fa-solid fa-download"></i></button>
                    <button type="button" class="st_gpt_image_btn" id="st_gpt_pv_close" title="关闭预览" aria-label="关闭预览"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <img src="${escapeAttr(safeUrl)}" class="st_gpt_preview_img" alt="${escapeAttr(prompt)}">
        </div>
    `).addClass('st_gpt_preview_visible');

    $('#st_gpt_pv_close').off('.stAiPreview').on('click.stAiPreview', closePreview);
    $('#st_gpt_pv_dl').off('.stAiPreview').on('click.stAiPreview', () => downloadImage(safeUrl));
    $p.on('click.stAiPreview', (e) => { if (e.target === $p[0]) closePreview(); });
    $(document).on('keydown.stAiPreview', (e) => {
        if (e.key === 'Escape') closePreview();
    });
}

function downloadImage(imageUrl) {
    const safeUrl = sanitizeImageUrl(imageUrl);
    if (!safeUrl) return toastr.error('图片地址无效，无法下载');
    const a = document.createElement('a');
    a.href = safeUrl;
    a.download = `ai-image-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function refreshGalleryFromChat() {
    try {
        await syncMarkdownImagesInChatToHistory();
    } catch (e) {
        console.error('[st-ai-image] syncMarkdownImages error:', e);
    }
    try {
        await syncRenderedChatImagesToHistory();
    } catch (e) {
        console.error('[st-ai-image] syncRenderedImages error:', e);
    }
    await renderGallery();
}

async function activateTab(tab) {
    $('.st_ai_tab').removeClass('active');
    $(`.st_ai_tab[data-tab="${tab}"]`).addClass('active');
    $('.st_ai_tab_content').removeClass('active');
    $(`.st_ai_tab_content[data-tab="${tab}"]`).addClass('active');
    if (tab === 'gallery') await refreshGalleryFromChat();
}

// ===== 图库 =====
async function renderGallery() {
    const $c = $('#st_gpt_image_history_list');
    // 诊断A：函数是否被调用 + 容器是否存在
    toastr.info(`renderGallery被调用, 容器${$c.length ? '存在' : '不存在'}`, 'st-ai-image', { timeOut: 6000 });
    if (!$c.length) return;
    const history = await getHistory().catch((e) => {
        toastr.error(`getHistory失败: ${e?.message || e}`, 'st-ai-image', { timeOut: 10000 });
        return [];
    });
    // 诊断B：读到了几条
    toastr.info(`getHistory返回 ${history.length} 条`, 'st-ai-image', { timeOut: 6000 });
    $('#st_gpt_gallery_count').text(`${history.length} 张图片`);

    // 诊断C：强制写入可见标记，确认容器可写
    $c[0].innerHTML = `<div style="color:#3b82f6;padding:10px;font-size:13px;">[诊断] 容器可写，准备渲染 ${history.length} 条…</div>`;

    if (!history.length) {
        $c.html('<div class="st_ai_image_empty">暂无生成记录</div>');
        return;
    }

    // 逐个创建 DOM 元素并分批设置 img.src，避免一次性拼接超大 base64 HTML 撑爆手机 WebView
    const container = $c[0];
    container.innerHTML = '';
    let rendered = 0;
    let idx = 0;
    for (const e of history) {
        const safeUrl = sanitizeImageUrl(e.imageUrl);
        if (!safeUrl) continue;
        idx++;
        const prompt = String(e.prompt ?? '');
        const item = document.createElement('div');
        item.className = 'st_ai_gallery_item';
        item.dataset.id = e.id ?? '';
        item.dataset.prompt = prompt;
        // 可视化标记：左上角编号，便于确认结构是否渲染出来
        const badge = document.createElement('div');
        badge.textContent = String(idx);
        badge.style.cssText = 'position:absolute;top:2px;left:2px;z-index:5;background:#3b82f6;color:#fff;font-size:12px;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border-radius:4px;';
        const img = document.createElement('img');
        img.alt = prompt;
        img.loading = 'lazy';
        // 加载失败时显示红底提示，区分"结构在但图加载失败"与"完全无结构"
        img.style.background = '#7f1d1d';
        img.addEventListener('error', () => {
            img.style.background = '#7f1d1d';
            img.alt = '加载失败';
        });
        img.addEventListener('load', () => {
            img.style.background = '';
        });
        const actions = document.createElement('div');
        actions.className = 'st_ai_gallery_actions';
        actions.innerHTML = buildImageActionsHtml('gallery', prompt, safeUrl)
            + `<button type="button" class="st_ai_btn st_gpt_regen" data-id="${escapeAttr(e.id)}" data-prompt="${escapeAttr(prompt)}" title="重新生成" aria-label="重新生成"><i class="fa-solid fa-rotate"></i></button>`
            + `<button type="button" class="st_ai_btn st_gpt_del" data-id="${escapeAttr(e.id)}" title="删除" aria-label="删除"><i class="fa-solid fa-trash"></i></button>`;
        item.appendChild(img);
        item.appendChild(badge);
        item.appendChild(actions);
        container.appendChild(item);
        rendered++;
        // 分批设置 src，让主线程有机会呼吸，避免大 base64 一次性阻塞
        const src = safeUrl;
        setTimeout(() => { img.src = src; }, 0);
    }

    // 诊断提示：告诉用户结构渲染了几个（不依赖 console）
    console.log(`[st-ai-image] renderGallery: 读到 ${history.length} 条, 渲染 ${rendered} 个图项`);
    toastr.info(`图库: ${rendered} 个图项已放入DOM`, 'st-ai-image', { timeOut: 6000 });
    if (rendered === 0) {
        toastr.warning(`图库有 ${history.length} 条记录但全部无法渲染`, 'st-ai-image', { timeOut: 8000 });
    }
}

// ===== 自动检测：替换聊天中的 [image]...[/image] 或持久图片标记 =====
function getSillyTavernContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

function getMessageIdFromElement(el) {
    const mes = el?.closest?.('.mes');
    const id = Number(mes?.getAttribute('mesid'));
    return Number.isInteger(id) ? id : null;
}

function getInlineTaskKey(messageId, originalTag) {
    return `${messageId ?? 'unknown'}:${originalTag || ''}`;
}

function createInlineGenerateButton(prompt, originalTag, messageId) {
    const btn = document.createElement('button');
    const taskKey = getInlineTaskKey(messageId, originalTag);
    const isPending = inlineTasks.has(taskKey);
    btn.className = 'st_gpt_inline_gen';
    btn.dataset.prompt = prompt;
    btn.dataset.originalTag = originalTag;
    btn.dataset.messageId = messageId ?? '';
    btn.type = 'button';
    btn.disabled = isPending;
    btn.innerHTML = isPending
        ? '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...'
        : '<i class="fa-solid fa-wand-magic-sparkles"></i> 生成图片';
    return btn;
}

function getCurrentFloorMessageElement() {
    const messages = Array.from(document.querySelectorAll('#chat .mes'));
    if (!messages.length) return null;
    if (currentFloorMessageElement?.isConnected && currentFloorMessageElement.closest?.('#chat')) return currentFloorMessageElement;

    const selected = messages.find((mes) =>
        mes.classList?.contains('last_mes')
        || mes.classList?.contains('selected')
        || mes.classList?.contains('highlighted')
    );
    if (selected) return selected;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const visible = messages
        .map((mes) => {
            const rect = mes.getBoundingClientRect();
            const visibleTop = Math.max(0, rect.top);
            const visibleBottom = Math.min(viewportHeight, rect.bottom);
            return { mes, area: Math.max(0, visibleBottom - visibleTop), bottom: rect.bottom };
        })
        .filter((item) => item.area > 0)
        .sort((a, b) => b.area - a.area || b.bottom - a.bottom);
    if (visible[0]?.mes) return visible[0].mes;

    return messages[messages.length - 1] || null;
}

function stripGeneratedImageArtifacts(text) {
    return String(text ?? '')
        .replace(IMAGE_TAG_RE, '$2$4')
        .replace(INLINE_IMAGE_MARKER_RE, '')
        .replace(MARKDOWN_IMAGE_RE, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function getMessageTextFromContext(messageId) {
    const ctx = getSillyTavernContext();
    const message = Number.isInteger(messageId) ? ctx?.chat?.[messageId] : null;
    if (!message) return '';
    const swipeId = Number(message.swipe_id ?? 0);
    if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === 'string') return message.swipes[swipeId];
    return typeof message.mes === 'string' ? message.mes : '';
}

function getPromptFromImageTagText(text) {
    const re = new RegExp(IMAGE_REQUEST_SOURCE, 'i');
    const match = re.exec(String(text ?? ''));
    return getImageRequestPrompt(match);
}

function buildPromptFromFloorText(text) {
    const clean = stripGeneratedImageArtifacts(text);
    if (!clean) return '';
    return clean.length > MAX_PROMPT_LENGTH ? `${clean.slice(0, MAX_PROMPT_LENGTH)}...` : clean;
}

function getCurrentFloorPrompt() {
    const mes = getCurrentFloorMessageElement();
    if (!mes) return { prompt: '', messageId: null };
    const messageId = getMessageIdFromElement(mes);
    const contextText = getMessageTextFromContext(messageId);
    const renderedText = mes.querySelector?.('.mes_text')?.textContent || mes.textContent || '';
    const sourceText = contextText || renderedText;
    const taggedPrompt = getPromptFromImageTagText(sourceText);
    return {
        prompt: taggedPrompt || buildPromptFromFloorText(sourceText),
        messageId,
    };
}

async function generateImageFromCurrentFloor() {
    const { prompt, messageId } = getCurrentFloorPrompt();
    if (!prompt) return toastr.warning('没有找到当前楼层内容');
    $('#st_gpt_image_prompt').val(prompt);
    await activateTab('generate');
    const imageUrl = await generateImage(prompt);
    if (imageUrl && Number.isInteger(messageId)) toastr.success(`已从第 ${messageId + 1} 楼生成图片`);
    return imageUrl;
}

function renderInlineImageContent(wrapper, entry) {
    const safeUrl = sanitizeImageUrl(entry?.imageUrl);
    const prompt = String(entry?.prompt ?? '');
    if (!safeUrl) {
        wrapper.classList.add('st_gpt_inline_missing');
        wrapper.textContent = '图片记录不可用';
        return;
    }

    wrapper.classList.remove('st_gpt_inline_missing');
    wrapper.dataset.historyId = entry.id ?? '';
    wrapper.dataset.prompt = prompt;
    wrapper.dataset.url = safeUrl;
    wrapper.innerHTML = `
        <img src="${escapeAttr(safeUrl)}" class="st_gpt_inline_img" alt="${escapeAttr(prompt)}">
        <span class="st_gpt_inline_actions">
            ${buildImageActionsHtml('inline', prompt, safeUrl, { historyId: entry.id })}
        </span>
    `;
}

async function hydrateInlineImage(wrapper, markerInfo) {
    const info = markerInfo && typeof markerInfo === 'object' ? markerInfo : { id: String(markerInfo ?? ''), imageUrl: '' };
    if (info.imageUrl) {
        let entry = info.id ? await getHistoryItem(info.id) : null;
        if (!entry) entry = await ensureHistoryEntryForImageUrl(info.imageUrl);
        renderInlineImageContent(wrapper, entry || { id: info.id, imageUrl: info.imageUrl });
        return;
    }

    const entry = await getHistoryItem(info.id);
    if (!entry) {
        wrapper.classList.add('st_gpt_inline_missing');
        wrapper.textContent = '图片记录不存在';
        return;
    }
    renderInlineImageContent(wrapper, entry);
}

function createInlineImageWrapper(markerInfo) {
    const info = markerInfo && typeof markerInfo === 'object' ? markerInfo : { id: String(markerInfo ?? ''), imageUrl: '' };
    const wrapper = document.createElement('span');
    wrapper.className = 'st_gpt_inline_img_wrap st_gpt_inline_loading';
    wrapper.dataset.historyId = info.id || '';
    wrapper.dataset.url = info.imageUrl || '';
    wrapper.textContent = '图片加载中...';
    hydrateInlineImage(wrapper, info).finally(() => wrapper.classList.remove('st_gpt_inline_loading'));
    return wrapper;
}

function processMessageById(messageId, { allowImageRequests = false } = {}) {
    if (!Number.isInteger(messageId) || typeof document === 'undefined') return false;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`)
        || document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return false;
    processMessageElement(el, { allowImageRequests });
    return true;
}

async function persistInlineImageInMessage(messageId, originalTag, markerData) {
    const ctx = getSillyTavernContext();
    if (!ctx || !Number.isInteger(messageId) || !ctx.chat?.[messageId] || !markerData) return false;

    const message = ctx.chat[messageId];
    const currentMessage = String(message.mes ?? '');
    const nextMessage = replaceFirstImageRequest(currentMessage, originalTag, markerData);
    if (nextMessage === currentMessage) return false;

    message.mes = nextMessage;
    if (Array.isArray(message.swipes)) {
        const swipeId = Number(message.swipe_id ?? 0);
        if (typeof message.swipes[swipeId] === 'string') {
            message.swipes[swipeId] = replaceFirstImageRequest(message.swipes[swipeId], originalTag, markerData);
        }
    }

    try {
        ctx.updateMessageBlock?.(messageId, message);
        processMessageById(messageId, { allowImageRequests: false });
        await ctx.saveChat?.();
        await syncMarkdownImagesInChatToHistory();
        scanInlineMessagesBurst();
        return true;
    } catch (e) {
        console.error('[st-ai-image] persist inline image error:', e);
        return false;
    }
}

async function migrateInlineMarkersInChat() {
    const ctx = getSillyTavernContext();
    if (!ctx?.chat?.length) return false;

    let changed = false;
    ctx.chat.forEach((message, messageId) => {
        if (!message) return;
        let messageChanged = false;
        if (typeof message.mes === 'string' && hasInlineImageMarker(message.mes)) {
            const next = replaceInlineImageMarkersWithMarkdown(message.mes);
            if (next !== message.mes) {
                message.mes = next;
                messageChanged = true;
            }
        }
        if (Array.isArray(message.swipes)) {
            message.swipes = message.swipes.map((swipe) => {
                if (typeof swipe !== 'string' || !hasInlineImageMarker(swipe)) return swipe;
                const next = replaceInlineImageMarkersWithMarkdown(swipe);
                if (next !== swipe) messageChanged = true;
                return next;
            });
        }
        if (messageChanged) {
            changed = true;
            ctx.updateMessageBlock?.(messageId, message);
        }
    });

    if (changed) {
        await ctx.saveChat?.();
        await syncMarkdownImagesInChatToHistory();
        scanInlineMessagesBurst();
    }
    return changed;
}

function processMessageElement(el, { allowImageRequests = true } = {}) {
    const currentText = el.textContent;
    if (el.dataset.stGptProcessed === '1') {
        // 内容变化时（如流式输出新增标签），重置标记重新处理
        if (el.dataset._stGptText === currentText) return;
        delete el.dataset.stGptProcessed;
    }
    if (!hasInlineRenderableTag(currentText)) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    if (!textNodes.length) return;

    // 拼接所有文本节点内容，用于匹配跨节点的 [image]...[/image] 标签
    const fullText = textNodes.map(n => n.textContent).join('');
    const re = new RegExp(`${IMAGE_REQUEST_SOURCE}|\\[st-ai-image\\b[^\\]]*\\]`, 'gi');
    if (!re.test(fullText)) return;
    re.lastIndex = 0;

    const messageId = getMessageIdFromElement(el);

    // 计算每个文本节点在拼接字符串中的起止位置
    const nodeRanges = [];
    let offset = 0;
    for (const node of textNodes) {
        const len = node.textContent.length;
        nodeRanges.push({ node, start: offset, end: offset + len });
        offset += len;
    }

    // 收集所有匹配结果及其对应的 DOM 操作
    const allMatches = [];
    let m;
    while ((m = re.exec(fullText)) !== null) {
        const matchStart = m.index;
        const matchEnd = re.lastIndex;
        const prompt = getImageRequestPrompt(m);
        let replacement;
        if (prompt && allowImageRequests) {
            replacement = createInlineGenerateButton(prompt, m[0], messageId);
        } else if (prompt) {
            replacement = document.createTextNode(m[0]);
        } else {
            replacement = createInlineImageWrapper(parseInlineImageMarker(m[0]));
        }
        allMatches.push({ matchStart, matchEnd, replacement });
    }
    if (!allMatches.length) return;

    // 将匹配结果映射回各文本节点，逐节点做 DOM 替换
    for (const { node, start: nodeStart, end: nodeEnd } of nodeRanges) {
        const nodeMatches = allMatches.filter(
            ({ matchStart, matchEnd }) => matchStart < nodeEnd && matchEnd > nodeStart,
        );
        if (!nodeMatches.length) continue;

        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        const localText = node.textContent;

        for (const { matchStart, matchEnd, replacement } of nodeMatches) {
            const localStart = Math.max(0, matchStart - nodeStart);
            const localEnd = Math.min(localText.length, matchEnd - nodeStart);

            if (localStart > lastIdx) {
                frag.appendChild(document.createTextNode(localText.slice(lastIdx, localStart)));
            }

            // 仅在匹配起始所在的节点中插入替换元素，后续跨入的节点跳过
            if (matchStart >= nodeStart && matchStart < nodeEnd) {
                frag.appendChild(replacement);
            }

            lastIdx = localEnd;
        }

        if (lastIdx < localText.length) {
            frag.appendChild(document.createTextNode(localText.slice(lastIdx)));
        }

        node.parentNode.replaceChild(frag, node);
    }

    el.dataset.stGptProcessed = '1';
    el.dataset._stGptText = currentText;
}

function getInlineScanElements() {
    const roots = Array.from(document.querySelectorAll('#chat .mes_text, #chat .mes'));
    const seen = new Set();
    return roots.filter((el) => {
        if (!el?.textContent || !hasInlineRenderableTag(el.textContent)) return false;
        if (el.classList?.contains('mes') && el.querySelector('.mes_text')?.textContent && hasInlineRenderableTag(el.querySelector('.mes_text').textContent)) return false;
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
    });
}

function scanInlineMessages() {
    const s = getSettings();
    const allowImageRequests = !!s.enabled;
    const els = getInlineScanElements();
    els.forEach(el => {
        if (shouldProcessInlineText(el.textContent, s)) processMessageElement(el, { allowImageRequests });
    });
}

let scanTimer = null;
function scheduleScan(delay = SCAN_DEBOUNCE_MS) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
        scanTimer = null;
        scanInlineMessages();
    }, delay);
}

function scanInlineMessagesBurst() {
    [0, 500, 2000, 5000].forEach((delay) => setTimeout(scanInlineMessages, delay));
    startInlineScanInterval();
}

function startInlineScanInterval(durationMs = INLINE_SCAN_DURATION_MS) {
    inlineScanIntervalStopAt = Math.max(inlineScanIntervalStopAt, Date.now() + durationMs);
    if (inlineScanInterval) return;
    inlineScanInterval = setInterval(() => {
        scanInlineMessages();
        if (Date.now() >= inlineScanIntervalStopAt) {
            clearInterval(inlineScanInterval);
            inlineScanInterval = null;
        }
    }, INLINE_SCAN_INTERVAL_MS);
}

let inlineObserver = null;
let inlineScanEventsBound = false;

// [AI 自动图文出图] 通过 SillyTavern 内置 setExtensionPrompt 后台自动提示 AI 在文中输出 [image] 标签
// position 枚举: -1=NONE, 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT
// role 枚举: 0=SYSTEM, 1=USER, 2=ASSISTANT
function registerSystemExtensionPrompt() {
    const ctx = getSillyTavernContext();
    if (!ctx || typeof ctx.setExtensionPrompt !== "function") return;

    const s = getSettings();
    const systemInstruction = String(s.systemPrompt || "").trim();

    if (s.enabled && s.autoInjectPrompt && systemInstruction) {
        ctx.setExtensionPrompt("st-ai-image", systemInstruction, 1, 2, false, 0);
        console.log("[st-ai-image] System extension prompt successfully injected!");
    } else {
        ctx.setExtensionPrompt("st-ai-image", "", 1, 2, false, 0);
    }
}

function initAutoDetect() {
    console.log('[st-ai-image] initAutoDetect called');

    // 清理旧的定时器和 observer，防止多次加载时资源泄露
    if (inlineScanInterval) {
        clearInterval(inlineScanInterval);
        inlineScanInterval = null;
    }
    inlineScanIntervalStopAt = 0;
    if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
    }
    inlineObserver?.disconnect?.();
    inlineObserver = null;

    registerSystemExtensionPrompt();
    scanInlineMessagesBurst();
    [0, 1000, 3000].forEach((delay) => setTimeout(() => migrateInlineMarkersInChat(), delay));
    [1500, 4000].forEach((delay) => setTimeout(() => syncMarkdownImagesInChatToHistory(), delay));
    [2000, 5000, 10000].forEach((delay) => setTimeout(() => syncRenderedChatImagesToHistory(), delay));

    const target = document.getElementById('chat') || document.body;
    if (!target) {
        console.warn('[st-ai-image] scan target not found');
        return;
    }

    inlineObserver?.disconnect?.();
    inlineObserver = new MutationObserver(() => scheduleScan(100));
    inlineObserver.observe(target, { childList: true, subtree: true, characterData: true });

    if (!inlineScanEventsBound) {
        inlineScanEventsBound = true;
        window.addEventListener('focus', scanInlineMessagesBurst);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) scanInlineMessagesBurst();
        });

        const ctx = getSillyTavernContext();
        const eventSource = ctx?.eventSource || globalThis.eventSource;
        const eventTypes = ctx?.event_types || globalThis.event_types || {};
        [
            'CHAT_CHANGED',
            'MESSAGE_RECEIVED',
            'MESSAGE_SENT',
            'MESSAGE_EDITED',
            'MESSAGE_SWIPED',
            'GENERATION_ENDED',
            'CHARACTER_MESSAGE_RENDERED',
            'USER_MESSAGE_RENDERED',
        ].forEach((name) => {
            const eventName = eventTypes?.[name];
            if (eventName && typeof eventSource?.on === 'function') eventSource.on(eventName, scanInlineMessagesBurst);
        });

        // 每次生成前重新注入系统提示词，防止被 ST 内部清空
        const genStartedEvent = eventTypes?.GENERATION_STARTED;
        if (genStartedEvent && typeof eventSource?.on === 'function') {
            eventSource.on(genStartedEvent, registerSystemExtensionPrompt);
        }
    }

    console.log('[st-ai-image] inline scanner attached');
}

// ===== 初始化 =====
if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof jQuery === 'function') {
jQuery(async () => {
    try {
        const s = getSettings();

        const html = await $.get(`${extensionFolder}/settings.html`);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        // Wand 按钮 → 魔法棒菜单
        const wandBtn = tempDiv.querySelector('#st_ai_image_wand_button');
        const menu = document.getElementById('extensionsMenu');
        if (menu && wandBtn) menu.appendChild(wandBtn);

        // 用 <dialog> 承载面板（渲染在 top layer，不受任何 CSS transform 影响）
        const dialog = document.createElement('dialog');
        dialog.id = 'st_ai_dialog';

        const panel = tempDiv.querySelector('#st_ai_float_panel');
        const preview = tempDiv.querySelector('#st_gpt_image_preview');
        if (panel) dialog.appendChild(panel);
        document.body.appendChild(dialog);
        if (preview) document.body.appendChild(preview);

        // 绑定设置
        $('#st_gpt_image_api_base').val(s.apiBase);
        $('#st_gpt_image_api_key').val(s.apiKey);
        $('#st_gpt_image_model').val(s.model);
        $('#st_gpt_image_size').val(s.size);
        $('#st_gpt_image_quality').val(s.quality);
        $('#st_gpt_image_enabled').prop('checked', s.enabled);
        $('#st_gpt_image_auto_detect').prop('checked', s.autoDetect);
        $('#st_gpt_image_save_history').prop('checked', s.saveHistory);
        $('#st_gpt_image_auto_inject_prompt').prop('checked', s.autoInjectPrompt);
        $('#st_gpt_image_system_prompt_text').val(s.systemPrompt || '');
        $('#st_gpt_image_extra_prompt').val(s.extraPrompt || '');
        $('#st_gpt_image_negative_prompt').val(s.negativePrompt || '');

        const bindSetting = (id, key, type) => {
            $(id).on(type === 'check' ? 'change' : 'input', function () {
                const val = type === 'check' ? !!$(this).prop('checked') : String($(this).val()).trim();
                // API Base URL 协议校验
                if (key === 'apiBase' && val && !isValidApiBaseUrl(val)) {
                    toastr.warning('API 地址必须以 http:// 或 https:// 开头');
                    return;
                }
                s[key] = val;
                saveSettings(s);
            });
        };
        bindSetting('#st_gpt_image_api_base', 'apiBase', 'text');
        bindSetting('#st_gpt_image_api_key', 'apiKey', 'text');
        bindSetting('#st_gpt_image_model', 'model', 'text');
        bindSetting('#st_gpt_image_size', 'size', 'text');
        bindSetting('#st_gpt_image_quality', 'quality', 'text');
        bindSetting('#st_gpt_image_enabled', 'enabled', 'check');
        bindSetting('#st_gpt_image_auto_detect', 'autoDetect', 'check');
        bindSetting('#st_gpt_image_save_history', 'saveHistory', 'check');
        bindSetting('#st_gpt_image_auto_inject_prompt', 'autoInjectPrompt', 'check');
        bindSetting('#st_gpt_image_system_prompt_text', 'systemPrompt', 'text');
        bindSetting('#st_gpt_image_extra_prompt', 'extraPrompt', 'text');
        bindSetting('#st_gpt_image_negative_prompt', 'negativePrompt', 'text');
        $('#st_gpt_image_auto_inject_prompt').on('change', registerSystemExtensionPrompt);
        $('#st_gpt_image_enabled').on('change', registerSystemExtensionPrompt);
        $('#st_gpt_image_system_prompt_text').on('input', registerSystemExtensionPrompt);

        // API 预设
        refreshPresetList();
        $('#st_gpt_preset_select').on('change', function () {
            const name = String($(this).val()).trim();
            if (name) loadPreset(name);
        });
        $('#st_gpt_preset_save').on('click', saveCurrentAsPreset);
        $('#st_gpt_preset_delete').on('click', deleteSelectedPreset);

        // 获取模型列表
        $('#st_gpt_fetch_models').on('click', fetchModels);
        $('#st_gpt_model_list').on('change', function () {
            const val = String($(this).val()).trim();
            if (val) {
                s.model = val;
                $('#st_gpt_image_model').val(val);
                saveSettings(s);
            }
        });

        // Wand 按钮 → 打开悬浮窗
        $('#st_ai_image_wand_button').on('click', async function () {
            const panel = document.getElementById('st_ai_float_panel');
            const dialog = document.getElementById('st_ai_dialog');
            panel.classList.remove('st_ai_hidden');
            // 重置面板定位（清除拖拽残留），让 dialog 原生居中
            panel.style.position = '';
            panel.style.left = '';
            panel.style.top = '';
            panel.style.margin = '';
            if (!dialog.open) dialog.showModal();
            await refreshGalleryFromChat();
        });

        // 拖拽
        const dragHandle = document.querySelector('.st_ai_float_header');
        const dragPanel = document.getElementById('st_ai_float_panel');
        let dragging = false, dragStartX, dragStartY, panelStartX, panelStartY;

        if (dragHandle && dragPanel) {
            dragHandle.style.cursor = 'move';

            function startDrag(clientX, clientY) {
                if (window.matchMedia?.('(max-width: 600px)').matches) return;
                dragging = true;
                const rect = dragPanel.getBoundingClientRect();
                dragStartX = clientX;
                dragStartY = clientY;
                panelStartX = rect.left;
                panelStartY = rect.top;
                // 切换到 fixed 定位脱离 dialog 居中
                dragPanel.style.position = 'fixed';
                dragPanel.style.left = panelStartX + 'px';
                dragPanel.style.top = panelStartY + 'px';
                dragPanel.style.margin = '0';
            }

            function moveDrag(clientX, clientY) {
                if (!dragging) return;
                const maxLeft = Math.max(0, window.innerWidth - dragPanel.offsetWidth);
                const maxTop = Math.max(0, window.innerHeight - dragPanel.offsetHeight);
                const nextLeft = Math.min(Math.max(0, panelStartX + clientX - dragStartX), maxLeft);
                const nextTop = Math.min(Math.max(0, panelStartY + clientY - dragStartY), maxTop);
                dragPanel.style.left = nextLeft + 'px';
                dragPanel.style.top = nextTop + 'px';
            }

            function endDrag() { dragging = false; }

            dragHandle.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
                e.preventDefault();
                startDrag(e.clientX, e.clientY);
            });
            document.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
            document.addEventListener('mouseup', endDrag);

            dragHandle.addEventListener('touchstart', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
                const t = e.touches[0];
                startDrag(t.clientX, t.clientY);
            }, { passive: true });
            document.addEventListener('touchmove', (e) => {
                if (!dragging) return;
                const t = e.touches[0];
                moveDrag(t.clientX, t.clientY);
            }, { passive: true });
            document.addEventListener('touchend', endDrag);
        }

        // 关闭面板（只能通过 X 按钮关闭）
        function closePanel() {
            const dialog = document.getElementById('st_ai_dialog');
            if (dialog.open) dialog.close();
        }

        $('#st_ai_float_close').on('click', closePanel);
        // 阻止 ESC 关闭
        document.getElementById('st_ai_dialog').addEventListener('cancel', (e) => e.preventDefault());
        // 点击 backdrop 不关闭（不监听）

        // Tab 切换
        $('.st_ai_tab').on('click', async function () {
            const tab = $(this).data('tab');
            await activateTab(tab);
        });

        // 生成
        $('#st_gpt_image_generate_btn').on('click', async () => {
            const p = $('#st_gpt_image_prompt').val()?.trim();
            if (p) await generateImage(p);
        });
        $('#st_gpt_generate_current_floor_btn').on('click', async () => {
            const btn = document.getElementById('st_gpt_generate_current_floor_btn');
            if (!btn) return;
            btn.disabled = true;
            const oldHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 从当前楼层生成中...';
            try {
                await generateImageFromCurrentFloor();
            } finally {
                btn.disabled = false;
                btn.innerHTML = oldHtml;
            }
        });
        $('#st_gpt_image_prompt').on('keydown', async (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const p = $('#st_gpt_image_prompt').val()?.trim();
                if (p) await generateImage(p);
            }
        });
        // 图库操作
        $(document).on('click', '.st_ai_gallery_item img', function () {
            const $item = $(this).closest('.st_ai_gallery_item');
            showPreview($(this).attr('src'), $item.data('prompt') || '');
        });
        $(document).on('click', '[data-action="download-image"]', function (e) {
            e.stopPropagation();
            downloadImage($(this).data('url'));
        });
        $(document).on('click', '[data-action="save-image"]', async function (e) {
            e.stopPropagation();
            const btn = this;
            const imageUrl = $(btn).data('url');
            const prompt = String($(btn).data('prompt') || '');
            const safeUrl = sanitizeImageUrl(imageUrl);
            if (!safeUrl) return toastr.error('图片地址无效，无法保存');

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const s = getSettings();
            const { saved, imageUrl: savedUrl } = await saveGeneratedImage({ prompt, imageUrl: safeUrl, timestamp: Date.now(), model: s.model, size: s.size }, { force: true });
            if (saved?.id) {
                btn.dataset.historyId = saved.id;
                btn.dataset.url = savedUrl;
                btn.title = '已在图库';
                btn.setAttribute('aria-label', '已在图库');
                btn.innerHTML = '<i class="fa-solid fa-bookmark"></i>';
                toastr.success('已保存到图库');
            } else {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-folder-plus"></i>';
                toastr.error('保存到图库失败');
            }
        });
        $(document).on('click', '[data-action="view-gallery"]', function (e) {
            e.stopPropagation();
            // 切换到图库标签页
            activateTab('gallery');
        });
        $(document).on('click', '.st_gpt_inline_img', function (e) {
            e.stopPropagation();
            const $wrap = $(this).closest('.st_gpt_inline_img_wrap');
            showPreview($(this).attr('src'), $wrap.data('prompt') || '');
        });
        $(document).on('click', '.st_gpt_regen', async function (e) {
            e.stopPropagation();
            const prompt = $(this).data('prompt');
            if (prompt) await generateImage(prompt);
        });
        $(document).on('click', '.st_gpt_del', function (e) {
            e.stopPropagation();
            const id = $(this).data('id');
            if (id) deleteHistoryItem(id);
        });
        $('#st_gpt_image_clear_history').on('click', () => {
            if (confirm('清空所有生成记录？')) clearHistory();
        });

        $(document).on('click', '#chat .mes', function () {
            currentFloorMessageElement = this;
        });

        // 自动检测聊天中的生图指令 → 原位生成
        $(document).on('click', '.st_gpt_inline_gen', async function () {
            const btn = this;
            const prompt = btn.dataset.prompt;
            if (!prompt) return;
            const s = getSettings();
            if (!s.apiKey) return toastr.error('请先在设置中填写 API Key');
            const messageId = btn.dataset.messageId === '' ? getMessageIdFromElement(btn) : Number(btn.dataset.messageId);
            const originalTag = btn.dataset.originalTag || `[image]${prompt}[/image]`;
            const taskKey = getInlineTaskKey(Number.isInteger(messageId) ? messageId : null, originalTag);
            if (inlineTasks.has(taskKey)) return;

            // 清理旧错误提示，重置样式
            btn.closest('.mes_text')?.querySelectorAll('.st_gpt_inline_error').forEach(e => e.remove());
            btn.classList.remove('st_gpt_inline_gen_error');

            // 按钮变为加载状态
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...';
            inlineTasks.set(taskKey, { prompt, messageId, originalTag, startedAt: Date.now() });

            try {
                const url = await callImageAPI(prompt);
                const { saved, imageUrl, serverImageUrl } = await saveGeneratedImage({ prompt, imageUrl: url, timestamp: Date.now(), model: s.model, size: s.size }, { force: true });

                // 用图片替换按钮
                const wrapper = document.createElement('span');
                wrapper.className = 'st_gpt_inline_img_wrap';
                renderInlineImageContent(wrapper, saved || { prompt, imageUrl, timestamp: Date.now() });
                btn.replaceWith(wrapper);
                if (!saved) toastr.warning('图片已生成，但保存到图库失败，请检查存储权限或清理空间');
                const markerUrl = getStableInlineImageUrl(serverImageUrl || imageUrl);
                if (markerUrl) {
                    await ensureHistoryEntryForImageUrl(markerUrl, { prompt, model: s.model, size: s.size });
                    const persisted = await persistInlineImageInMessage(Number.isInteger(messageId) ? messageId : null, originalTag, { id: saved?.id, imageUrl: markerUrl, prompt });
                    if (!persisted) toastr.warning('图片已进图库，但当前消息没有写回聊天记录');
                } else {
                    toastr.warning('图片已显示，但没有可持久保存的地址，刷新后需要重新生成');
                }
            } catch (e) {
                console.error('[st-ai-image] inline gen error:', e);
                btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 重试';
                btn.classList.add('st_gpt_inline_gen_error');
                btn.disabled = false;

                // 错误提示条
                const err = document.createElement('div');
                err.className = 'st_gpt_inline_error';
                err.textContent = e.message || '生成失败';
                btn.after(err);
                setTimeout(() => err.remove(), ERROR_DISPLAY_DURATION_MS);

                toastr.error(e.message, '生图失败');
            } finally {
                inlineTasks.delete(taskKey);
            }
        });
        initAutoDetect();

        // 清理旧 localStorage 历史（已迁移到 IndexedDB）
        try { localStorage.removeItem('st_ai_image_history'); } catch {}

        // 初始图库
        renderGallery();

        console.log('[st-ai-image] loaded successfully');
    } catch (e) {
        console.error('[st-ai-image] init failed:', e);
    }
});
}

if (typeof module !== 'undefined') {
    module.exports = {
        __stAiImageTest__: {
            escapeHtml,
            escapeAttr,
            sanitizeImageUrl,
            summarizeApiError,
            buildImageActionsHtml,
            hasImageTag,
            createInlineImageMarker,
            parseInlineImageMarker,
            hasInlineImageMarker,
            shouldProcessInlineText,
            replaceFirstImageRequest,
            replaceInlineImageMarkersWithMarkdown,
            extractMarkdownImages,
            normalizeGalleryImageUrl,
        },
    };
}

// AI Image Generator - IndexedDB 版
const extensionName = 'st-ai-image';
const extensionFolder = `scripts/extensions/third-party/${extensionName}`;
const DB_NAME = 'st_ai_image_db';
const DB_VERSION = 1;
const STORE_NAME = 'history';

const defaultSettings = {
    enabled: true,
    autoDetect: true,
    apiBase: '',
    apiKey: '',
    model: 'ai-image-2',
    size: '1024x1024',
    quality: 'auto',
    saveHistory: true,
};


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

async function getHistory() {
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

async function saveToHistory(entry) {
    const s = getSettings();
    if (!s.saveHistory) return;
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.add({ prompt: entry.prompt, imageUrl: entry.imageUrl, timestamp: entry.timestamp, model: entry.model, size: entry.size });
        tx.oncomplete = () => trimHistory();
    } catch (e) {
        console.error('[st-ai-image] saveToHistory error:', e);
    }
    renderGallery();
}

async function trimHistory() {
    try {
        const items = await getHistory();
        if (items.length > 200) {
            const db = await openDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const toDelete = items.slice(200);
            for (const item of toDelete) store.delete(item.id);
        }
    } catch {}
}

async function deleteHistoryItem(id) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => renderGallery();
    } catch {}
}

async function clearHistory() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => renderGallery();
    } catch {}
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
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
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
    return text.length > 340 ? `${text.slice(0, 340)}...` : text;
}

function ensureSafeImageUrl(value) {
    const safeUrl = sanitizeImageUrl(value);
    if (!safeUrl) throw new Error('API 返回了不安全或无法识别的图片地址');
    return safeUrl;
}

function buildImageActionsHtml(context, prompt, imageUrl) {
    const safeUrl = escapeAttr(sanitizeImageUrl(imageUrl));
    const disabled = safeUrl ? '' : ' disabled';
    return `
        <button type="button" class="st_gpt_image_btn" data-action="download-image" data-context="${escapeAttr(context)}" data-url="${safeUrl}" title="下载图片" aria-label="下载图片"${disabled}><i class="fa-solid fa-download"></i></button>
    `;
}

function hasImageTag(text) {
    return /\[image\](.+?)\[\/image\]/s.test(String(text ?? ''));
}

// ===== API (根据模型自动选择端点) =====
function extractImageFromResponse(data) {
    // OpenAI 标准格式: data.data[0].b64_json / url
    if (data.data?.length) {
        const img = data.data[0];
        if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
        if (img.url) return img.url;
    }
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

function isGeminiModel(model) {
    return /gemini/i.test(model);
}

async function callImageAPI(prompt) {
    const s = getSettings();
    let base = s.apiBase.replace(/\/+$/, '');
    if (base.endsWith('/v1')) base = base.slice(0, -3);

    // Gemini 模型走原生端点（需要 responseModalities 才能出图）
    if (isGeminiModel(s.model)) {
        const url = `${base}/v1beta/models/${s.model}:generateContent?key=${s.apiKey}`;
        const body = {
            contents: [{ role: 'user', parts: [{ text: `Generate an image: ${prompt}` }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        };
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${summarizeApiError(await resp.text())}`);
        const data = await resp.json();

        const img = extractImageFromResponse(data);
        if (img) return ensureSafeImageUrl(img);

        // 给出更明确的错误信息
        const parts = data.candidates?.[0]?.content?.parts;
        const text = parts?.filter(p => p.text).map(p => p.text).join('') || '';
        throw new Error('模型未返回图片。' + (text ? '回复文本: ' + summarizeApiError(text) : summarizeApiError(JSON.stringify(data))));
    }

    // OpenAI 兼容模型走标准端点
    const body = { model: s.model, prompt, n: 1, size: s.size };
    if (s.quality && s.quality !== 'auto') body.quality = s.quality;

    const resp = await fetch(`${base}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.apiKey}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}: ${summarizeApiError(await resp.text())}`);
    const data = await resp.json();

    const img = extractImageFromResponse(data);
    if (img) return ensureSafeImageUrl(img);

    throw new Error('No image data. Response: ' + summarizeApiError(JSON.stringify(data)));
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

        // 先尝试 OpenAI 格式
        try {
            const resp = await fetch(`${base}/v1/models`, {
                headers: { 'Authorization': `Bearer ${s.apiKey}` },
            });
            if (resp.ok) {
                const data = await resp.json();
                models = (data.data || []).map(m => ({ id: m.id, name: m.id }));
            }
        } catch {}

        // 没结果再尝试 Gemini 格式
        if (!models.length) {
            const resp = await fetch(`${base}/v1beta/models?key=${s.apiKey}`);
            if (resp.ok) {
                const data = await resp.json();
                models = (data.models || []).map(m => ({
                    id: m.name.replace('models/', ''),
                    name: m.displayName,
                }));
            }
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

async function generateImage(prompt) {
    if (!prompt?.trim()) return toastr.warning('请输入图片描述');
    const s = getSettings();
    if (!s.apiKey) return toastr.error('请先在设置中填写 API Key');

    const $btn = $('#st_gpt_image_generate_btn');
    const $result = $('#st_gpt_gen_result');
    $btn.prop('disabled', true);
    $result.html('<div class="st_ai_loading"><div class="st_ai_spinner"></div> 正在生成...</div>');

    try {
        const cleanPrompt = prompt.trim();
        const url = await callImageAPI(cleanPrompt);
        await saveToHistory({ prompt: cleanPrompt, imageUrl: url, timestamp: Date.now(), model: s.model, size: s.size });

        $result.html(`
            <img src="${escapeAttr(url)}" alt="${escapeAttr(cleanPrompt)}" class="st_gpt_gen_img" data-prompt="${escapeAttr(cleanPrompt)}">
            <div class="st_gpt_gen_result_info">
                <div class="st_ai_action_row">
                    ${buildImageActionsHtml('result', cleanPrompt, url)}
                </div>
            </div>
        `);

        $result.find('img').on('click', () => showPreview(url, cleanPrompt));
        toastr.success('图片生成完成', 'GPT Image');
        return url;
    } catch (e) {
        console.error('[st-ai-image]', e);
        $result.html(`<div class="st_ai_gen_placeholder st_ai_error_text">生成失败: ${escapeHtml(e.message)}</div>`);
        toastr.error(e.message, '生成失败');
        return null;
    } finally {
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

function activateTab(tab) {
    $('.st_ai_tab').removeClass('active');
    $(`.st_ai_tab[data-tab="${tab}"]`).addClass('active');
    $('.st_ai_tab_content').removeClass('active');
    $(`.st_ai_tab_content[data-tab="${tab}"]`).addClass('active');
    if (tab === 'gallery') renderGallery();
}

// ===== 图库 =====
async function renderGallery() {
    const $c = $('#st_ai_image_history_list');
    if (!$c.length) return;
    const history = await getHistory();
    $('#st_gpt_gallery_count').text(`${history.length} 张图片`);

    if (!history.length) return $c.html('<div class="st_ai_image_empty">暂无生成记录</div>');

    $c.html(history.map((e) => {
        const safeUrl = sanitizeImageUrl(e.imageUrl);
        if (!safeUrl) return '';
        const prompt = String(e.prompt ?? '');
        return `
            <div class="st_ai_gallery_item" data-id="${escapeAttr(e.id)}" data-prompt="${escapeAttr(prompt)}" data-url="${escapeAttr(safeUrl)}">
                <img src="${escapeAttr(safeUrl)}" alt="${escapeAttr(prompt)}" loading="lazy">
                <div class="st_ai_gallery_actions">
                    ${buildImageActionsHtml('gallery', prompt, safeUrl)}
                    <button type="button" class="st_ai_btn st_gpt_regen" data-id="${escapeAttr(e.id)}" data-prompt="${escapeAttr(prompt)}" title="重新生成" aria-label="重新生成"><i class="fa-solid fa-rotate"></i></button>
                    <button type="button" class="st_ai_btn st_gpt_del" data-id="${escapeAttr(e.id)}" title="删除" aria-label="删除"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;
    }).join(''));
}

// ===== 自动检测：替换聊天中的 [image]...[/image] 为可点击按钮 =====
function processMessageElement(el) {
    if (!hasImageTag(el.textContent)) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let replaced = false;
    for (const node of textNodes) {
        const re = /\[image\](.+?)\[\/image\]/gs;
        if (!re.test(node.textContent)) continue;
        re.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let m;
        while ((m = re.exec(node.textContent)) !== null) {
            if (m.index > lastIdx) {
                frag.appendChild(document.createTextNode(node.textContent.slice(lastIdx, m.index)));
            }
            const btn = document.createElement('button');
            btn.className = 'st_gpt_inline_gen';
            btn.dataset.prompt = m[1].trim();
            btn.type = 'button';
            btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 生成图片';
            frag.appendChild(btn);
            lastIdx = re.lastIndex;
        }
        if (lastIdx < node.textContent.length) {
            frag.appendChild(document.createTextNode(node.textContent.slice(lastIdx)));
        }
        node.parentNode.replaceChild(frag, node);
        replaced = true;
    }
    if (replaced) el.dataset.stGptProcessed = '1';
}

let scanTimer = null;
function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
        const s = getSettings();
        if (!s.enabled || !s.autoDetect) return;
        const els = document.querySelectorAll('.mes_text');
        els.forEach(el => {
            if (hasImageTag(el.textContent)) processMessageElement(el);
        });
    }, 300);
}

function initAutoDetect() {
    console.log('[st-ai-image] initAutoDetect called');
    scheduleScan();

    const chat = document.getElementById('chat');
    if (!chat) {
        console.warn('[st-ai-image] #chat element not found');
        return;
    }

    const observer = new MutationObserver(scheduleScan);
    observer.observe(chat, { childList: true, subtree: true, characterData: true });
    console.log('[st-ai-image] MutationObserver attached to #chat');
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

        const bindSetting = (id, key, type) => {
            $(id).on(type === 'check' ? 'change' : 'input', function () {
                s[key] = type === 'check' ? !!$(this).prop('checked') : String($(this).val()).trim();
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
        $('#st_ai_image_wand_button').on('click', function () {
            const panel = document.getElementById('st_ai_float_panel');
            const dialog = document.getElementById('st_ai_dialog');
            panel.classList.remove('st_ai_hidden');
            // 重置面板定位（清除拖拽残留），让 dialog 原生居中
            panel.style.position = '';
            panel.style.left = '';
            panel.style.top = '';
            panel.style.margin = '';
            if (!dialog.open) dialog.showModal();
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
        $('.st_ai_tab').on('click', function () {
            const tab = $(this).data('tab');
            activateTab(tab);
        });

        // 生成
        $('#st_gpt_image_generate_btn').on('click', async () => {
            const p = $('#st_gpt_image_prompt').val()?.trim();
            if (p) await generateImage(p);
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

        // 自动检测聊天中的生图指令 → 原位生成
        $(document).on('click', '.st_gpt_inline_gen', async function () {
            const btn = this;
            const prompt = btn.dataset.prompt;
            if (!prompt) return;
            const s = getSettings();
            if (!s.apiKey) return toastr.error('请先在设置中填写 API Key');

            // 清理旧错误提示，重置样式
            btn.closest('.mes_text')?.querySelectorAll('.st_gpt_inline_error').forEach(e => e.remove());
            btn.classList.remove('st_gpt_inline_gen_error');

            // 按钮变为加载状态
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...';

            try {
                const url = await callImageAPI(prompt);
                await saveToHistory({ prompt, imageUrl: url, timestamp: Date.now(), model: s.model, size: s.size });

                // 用图片替换按钮
                const wrapper = document.createElement('span');
                wrapper.className = 'st_gpt_inline_img_wrap';
                wrapper.innerHTML = `<img src="${escapeAttr(url)}" class="st_gpt_inline_img" alt="${escapeAttr(prompt)}">`;
                btn.replaceWith(wrapper);
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
                setTimeout(() => err.remove(), 5000);

                toastr.error(e.message, '生图失败');
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
        },
    };
}

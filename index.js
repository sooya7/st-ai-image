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

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
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
        if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);
        const data = await resp.json();
        console.log('[st-ai-image] Gemini response:', JSON.stringify(data).slice(0, 1000));

        const img = extractImageFromResponse(data);
        if (img) return img;

        // 给出更明确的错误信息
        const parts = data.candidates?.[0]?.content?.parts;
        const text = parts?.filter(p => p.text).map(p => p.text).join('') || '';
        throw new Error('模型未返回图片。' + (text ? '回复文本: ' + text.slice(0, 200) : JSON.stringify(data).slice(0, 300)));
    }

    // OpenAI 兼容模型走标准端点
    const body = { model: s.model, prompt, n: 1, size: s.size };
    if (s.quality && s.quality !== 'auto') body.quality = s.quality;

    const resp = await fetch(`${base}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.apiKey}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    console.log('[st-ai-image] API response:', JSON.stringify(data).slice(0, 1000));

    const img = extractImageFromResponse(data);
    if (img) return img;

    throw new Error('No image data. Response: ' + JSON.stringify(data).slice(0, 500));
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
            $list.append(`<option value="${m.id}">${m.name || m.id}</option>`);
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
    $result.html('<div class="st_gpt_loading"><div class="st_gpt_spinner"></div> 正在生成...</div>');

    try {
        const url = await callImageAPI(prompt.trim());
        saveToHistory({ prompt: prompt.trim(), imageUrl: url, timestamp: Date.now(), model: s.model, size: s.size });

        $result.html(`
            <img src="${url}" alt="${escapeHtml(prompt)}" class="st_gpt_gen_img">
            <div class="st_gpt_gen_result_info">
                <span>${escapeHtml(prompt.trim())}</span>
                <div>
                    <button class="st_gpt_image_btn" onclick="document.getElementById('st_gpt_dl_link').click()"><i class="fa-solid fa-download"></i></button>
                    <a id="st_gpt_dl_link" href="${url}" download="ai-image-${Date.now()}.png" style="display:none"></a>
                </div>
            </div>
        `);

        $result.find('img').on('click', () => showPreview(url, prompt.trim()));
        toastr.success('图片生成完成', 'GPT Image');
        return url;
    } catch (e) {
        console.error('[st-ai-image]', e);
        $result.html(`<div class="st_gpt_gen_placeholder" style="color:#f55">生成失败: ${escapeHtml(e.message)}</div>`);
        toastr.error(e.message, '生成失败');
        return null;
    } finally {
        $btn.prop('disabled', false);
    }
}

// ===== 预览 =====
function showPreview(imageUrl, prompt) {
    const $p = $('#st_gpt_image_preview');
    $p.html(`
        <div class="st_gpt_preview_content">
            <div class="st_gpt_preview_header">
                <span class="st_gpt_preview_title">图片预览</span>
                <div style="display:flex;gap:8px">
                    <button class="st_gpt_image_btn" id="st_gpt_pv_dl"><i class="fa-solid fa-download"></i></button>
                    <button class="st_gpt_image_btn" id="st_gpt_pv_close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <img src="${imageUrl}" class="st_gpt_preview_img">
            <div class="st_gpt_preview_prompt">${escapeHtml(prompt)}</div>
        </div>
    `).addClass('st_gpt_preview_visible');

    $('#st_gpt_pv_close').on('click', () => $p.removeClass('st_gpt_preview_visible'));
    $('#st_gpt_pv_dl').on('click', () => {
        const a = document.createElement('a'); a.href = imageUrl; a.download = `ai-image-${Date.now()}.png`; a.click();
    });
    $p.on('click', (e) => { if (e.target === $p[0]) $p.removeClass('st_gpt_preview_visible'); });
}

// ===== 图库 =====
async function renderGallery() {
    const $c = $('#st_ai_image_history_list');
    if (!$c.length) return;
    const history = await getHistory();
    $('#st_gpt_gallery_count').text(`${history.length} 张图片`);

    if (!history.length) return $c.html('<div class="st_gpt_image_empty">暂无生成记录</div>');

    $c.html(history.map((e) => `
        <div class="st_gpt_gallery_item" data-id="${e.id}">
            <img src="${e.imageUrl}" loading="lazy">
            <div class="st_gpt_gallery_overlay">${escapeHtml(e.prompt)}</div>
            <div class="st_gpt_gallery_actions">
                <button class="st_gpt_image_btn st_gpt_regen" data-id="${e.id}" data-prompt="${escapeHtml(e.prompt)}" title="重新生成"><i class="fa-solid fa-rotate"></i></button>
                <button class="st_gpt_image_btn st_gpt_del" data-id="${e.id}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join(''));
}

// ===== 自动检测：替换聊天中的 [image]...[/image] 为可点击按钮 =====
function processMessageElement(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
        const re = /\[image\](.+?)\[\/image\]/gs;
        if (!re.test(node.textContent)) continue;
        console.log('[st-ai-image] found [image] tag:', node.textContent.slice(0, 100));
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
            btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 生成图片';
            frag.appendChild(btn);
            lastIdx = re.lastIndex;
        }
        if (lastIdx < node.textContent.length) {
            frag.appendChild(document.createTextNode(node.textContent.slice(lastIdx)));
        }
        node.parentNode.replaceChild(frag, node);
    }
}

let scanTimer = null;
function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
        const s = getSettings();
        if (!s.enabled || !s.autoDetect) return;
        const els = document.querySelectorAll('.mes_text');
        console.log('[st-ai-image] scanning', els.length, 'messages');
        els.forEach(el => {
            delete el.dataset.stGptProcessed;
            processMessageElement(el);
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

// ===== 拖拽 =====
function initDrag() {
    const handle = document.getElementById('st_gpt_drag_handle');
    const panel = document.getElementById('st_gpt_float_panel');
    if (!handle || !panel) return;
    let dragging = false, startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = startLeft + 'px';
        panel.style.top = startTop + 'px';
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = (startLeft + e.clientX - startX) + 'px';
        panel.style.top = (startTop + e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
}

// ===== 初始化 =====
jQuery(async () => {
    try {
        const s = getSettings();

        const html = await $.get(`${extensionFolder}/settings.html`);
        $('body').append(html);

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

        // FAB 开关
        $('#st_gpt_fab').on('click', () => $('#st_gpt_float_panel').toggleClass('st_gpt_hidden'));
        $('#st_gpt_float_close').on('click', () => $('#st_gpt_float_panel').addClass('st_gpt_hidden'));

        // Tab 切换
        $('.st_gpt_tab').on('click', function () {
            const tab = $(this).data('tab');
            $('.st_gpt_tab').removeClass('active');
            $(this).addClass('active');
            $('.st_gpt_tab_content').removeClass('active');
            $(`.st_gpt_tab_content[data-tab="${tab}"]`).addClass('active');
            if (tab === 'gallery') renderGallery();
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
        $(document).on('click', '.st_gpt_gallery_item img', function () {
            const $item = $(this).closest('.st_gpt_gallery_item');
            showPreview($(this).attr('src'), $item.find('.st_gpt_gallery_overlay').text());
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

        // 拖拽
        initDrag();

        // 自动检测聊天中的生图指令 → 原位生成
        $(document).on('click', '.st_gpt_inline_gen', async function () {
            const btn = this;
            const prompt = btn.dataset.prompt;
            if (!prompt) return;
            const s = getSettings();
            if (!s.apiKey) return toastr.error('请先在设置中填写 API Key');

            // 清理旧错误提示，重置样式
            btn.closest('.mes_text')?.querySelectorAll('.st_gpt_inline_error').forEach(e => e.remove());
            btn.style.cssText = '';

            // 按钮变为加载状态
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...';

            try {
                const url = await callImageAPI(prompt);
                saveToHistory({ prompt, imageUrl: url, timestamp: Date.now(), model: s.model, size: s.size });

                // 用图片替换按钮
                const wrapper = document.createElement('span');
                wrapper.className = 'st_gpt_inline_img_wrap';
                wrapper.innerHTML = `<img src="${url}" class="st_gpt_inline_img" alt="${escapeHtml(prompt)}">`;
                btn.replaceWith(wrapper);
            } catch (e) {
                console.error('[st-ai-image] inline gen error:', e);
                btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 重试';
                btn.style.color = '#f87171';
                btn.style.borderColor = 'rgba(248,113,113,0.4)';
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

/**
 * 静态 HTML 模板。v1 用 $.get 拉 settings.html，v2 直接内联：
 * 少一次网络请求，也不会因为扩展目录名不同而 404。
 * 这些字符串全是常量，没有任何插值。
 */

export const WAND_BUTTON_HTML = `
<div id="st_ai_image_wand_button" class="list-group-item flex-container flexGap5">
    <div class="fa-solid fa-image extensionsMenuExtensionButton"></div>
    <span>AI 图片·语音·视频</span>
</div>`;

export const FALLBACK_BANNER_HTML = `
<div id="st_ai_fallback_banner" class="st_ai_fallback_banner st_ai_hidden">
    <i class="fa-solid fa-triangle-exclamation"></i>
    <span>媒体库存储已降级到 localStorage（容量有限），请检查浏览器设置。</span>
    <button type="button" id="st_ai_fallback_banner_close" class="st_ai_banner_close" aria-label="关闭">
        <i class="fa-solid fa-xmark"></i>
    </button>
</div>`;

export const PANEL_HTML = `
<div id="st_ai_float_panel" class="st_ai_hidden" tabindex="-1" autofocus>
    <div class="st_ai_float_header">
        <span class="st_ai_brand" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
        <div class="st_ai_float_tabs" role="tablist" aria-label="功能">
            <span class="st_ai_tab_indicator" aria-hidden="true"></span>
            <button type="button" class="st_ai_tab active" data-tab="generate" role="tab"><i class="fa-solid fa-image"></i> 图片</button>
            <button type="button" class="st_ai_tab" data-tab="speech" role="tab"><i class="fa-solid fa-microphone-lines"></i> 配音</button>
            <button type="button" class="st_ai_tab" data-tab="video" role="tab"><i class="fa-solid fa-clapperboard"></i> 视频</button>
            <button type="button" class="st_ai_tab" data-tab="gallery" role="tab"><i class="fa-solid fa-images"></i> 媒体库</button>
        </div>
        <button type="button" id="st_ai_float_close" class="st_ai_btn" title="关闭面板" aria-label="关闭面板"><i class="fa-solid fa-xmark"></i></button>
    </div>

    <div class="st_ai_tab_content active" data-tab="generate">
        <div class="st_ai_stack">
            <section class="st_ai_card st_ai_gen_area st_ai_composer" data-tone="violet">
                <div class="st_ai_composer_top">
                    <span class="st_ai_composer_badge"><i class="fa-solid fa-wand-magic-sparkles"></i> 静默生图</span>
                    <span class="st_ai_composer_tip">Enter 生成 · Shift+Enter 换行</span>
                </div>
                <textarea id="st_gpt_image_prompt" class="st_ai_textarea st_ai_composer_input" rows="3" placeholder="描述你想看到的画面……"></textarea>
                <div class="st_ai_gen_controls">
                    <select id="st_gpt_image_size" class="st_ai_select" title="尺寸" data-show-for="auto openai novelai comfyui sdwebui">
                        <option value="1024x1024">1024x1024</option>
                        <option value="1536x1024">1536x1024</option>
                        <option value="1024x1536">1024x1536</option>
                        <option value="auto">Auto</option>
                    </select>
                    <select id="st_gpt_image_quality" class="st_ai_select" title="质量" data-show-for="auto openai">
                        <option value="auto">Auto</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                    </select>
                    <button type="button" id="st_gpt_image_generate_btn" class="st_ai_btn_primary">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 生成
                    </button>
                </div>
                <button type="button" id="st_gpt_generate_current_floor_btn" class="st_ai_btn st_ai_current_floor_btn" title="读取当前聊天楼层内容并生成图片">
                    <i class="fa-solid fa-layer-group"></i> 一键从当前楼层生成图片
                </button>
            </section>
            <div id="st_gpt_gen_result" class="st_ai_gen_result">
                <div class="st_ai_gen_placeholder">生成的图片将显示在这里</div>
            </div>

            <section class="st_ai_card" data-tone="mint">
                <div class="st_ai_card_head">
                    <span class="st_ai_card_icon" aria-hidden="true"><i class="fa-solid fa-plug"></i></span>
                    <div class="st_ai_card_titles"><h4 class="st_ai_card_title">生图接口</h4><p class="st_ai_card_sub">选服务、一键填写、切换 API 预设</p></div>
                </div>
                <div class="st_ai_field">
                    <label for="st_gpt_image_provider">生图接口</label>
                    <select id="st_gpt_image_provider" class="st_ai_input">
                        <option value="auto">中转站（自动试接口，旧版兼容）</option>
                        <option value="openai">OpenAI Images / 兼容中转</option>
                        <option value="chat">OpenAI Chat 生图</option>
                        <option value="gemini">Gemini 原生</option>
                        <option value="novelai">NovelAI</option>
                        <option value="minimax">MiniMax 海螺图像</option>
                        <option value="dashscope">阿里云百炼（通义万相 / Qwen-Image）</option>
                        <option value="pollinations">Pollinations（免费）</option>
                        <option value="comfyui">ComfyUI（自建）</option>
                        <option value="sdwebui">SD WebUI（A1111 / Forge，自建）</option>
                        <optgroup label="其他">
                            <option value="stability">Stability AI</option>
                            <option value="horde">AI Horde（免费，众包算力）</option>
                            <option value="fal">fal 队列</option>
                            <option value="replicate">Replicate</option>
                        </optgroup>
                    </select>
                    <details class="st_ai_help"><summary>这个接口怎么填</summary><p class="st_ai_speech_hint" id="st_gpt_image_provider_hint"></p></details>
                    <div class="st_ai_inline_row st_ai_quick_fill" id="st_gpt_image_quick" data-show-for="auto openai chat"></div>
                </div>
                <div class="st_ai_field">
                    <label for="st_gpt_preset_select">API 预设</label>
                    <div class="st_ai_inline_row">
                        <select id="st_gpt_preset_select" class="st_ai_input st_ai_flex_fill"></select>
                        <button type="button" id="st_gpt_preset_save" class="st_ai_btn st_ai_icon_btn" title="保存当前配置为预设" aria-label="保存当前配置为预设"><i class="fa-solid fa-floppy-disk"></i></button>
                        <button type="button" id="st_gpt_preset_delete" class="st_ai_btn st_ai_icon_btn" title="删除选中预设" aria-label="删除选中预设"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </section>

            <section class="st_ai_card" data-tone="sky">
                <div class="st_ai_card_head">
                    <span class="st_ai_card_icon" aria-hidden="true"><i class="fa-solid fa-key"></i></span>
                    <div class="st_ai_card_titles"><h4 class="st_ai_card_title">连接</h4><p class="st_ai_card_sub">地址、密钥和模型，每个接口各记一份</p></div>
                </div>
                <div class="st_ai_field">
                    <label for="st_gpt_image_api_base" id="st_gpt_image_api_base_label">API 地址</label>
                    <input type="text" id="st_gpt_image_api_base" class="st_ai_input" placeholder="https://your-proxy.com/v1">
                </div>
                <div class="st_ai_field" data-hide-for="comfyui sdwebui">
                    <label for="st_gpt_image_api_key" id="st_gpt_image_api_key_label">API Key</label>
                    <input type="password" id="st_gpt_image_api_key" class="st_ai_input" autocomplete="off" placeholder="sk-...">
                </div>
                <div class="st_ai_field">
                    <label for="st_gpt_image_model" id="st_gpt_image_model_label">模型</label>
                    <div class="st_ai_inline_row">
                        <input type="text" id="st_gpt_image_model" class="st_ai_input st_ai_flex_fill" placeholder="gpt-image-2">
                        <button type="button" id="st_gpt_fetch_models" class="st_ai_btn st_ai_icon_btn" title="获取模型列表" aria-label="获取模型列表"><i class="fa-solid fa-rotate"></i></button>
                    </div>
                    <select id="st_gpt_model_list" class="st_ai_input st_ai_model_list"></select>
                </div>
            </section>

            <section class="st_ai_card" data-tone="amber" data-show-for="comfyui sdwebui">
                <div class="st_ai_card_head">
                    <span class="st_ai_card_icon" aria-hidden="true"><i class="fa-solid fa-server"></i></span>
                    <div class="st_ai_card_titles"><h4 class="st_ai_card_title">自建服务</h4><p class="st_ai_card_sub">转发方式、认证和 ComfyUI 工作流</p></div>
                </div>
                <div class="st_ai_field" data-show-for="comfyui sdwebui">
                    <label class="st_ai_checkbox">
                        <input type="checkbox" id="st_gpt_image_via_st">
                        <span>经酒馆后端转发（推荐：自建服务不用开跨域，TauriTavern 也能用）</span>
                    </label>
                </div>
                <div class="st_ai_field" data-show-for="sdwebui">
                    <label for="st_gpt_image_sd_auth">WebUI 账号密码（启动参数有 --api-auth 时填 用户名:密码）</label>
                    <input type="password" id="st_gpt_image_sd_auth" class="st_ai_input" autocomplete="off" placeholder="没开认证就留空">
                </div>
                <div class="st_ai_field" data-show-for="comfyui">
                    <label for="st_gpt_image_comfy_workflow">ComfyUI 工作流（在 ComfyUI 里「导出 (API)」得到的 JSON）</label>
                    <div id="st_ai_image_workflow_lib"></div>
                    <textarea id="st_gpt_image_comfy_workflow" class="st_ai_textarea st_ai_code" rows="6" spellcheck="false" placeholder='{"3": {"class_type": "KSampler", "inputs": {"seed": "%seed%", ...}}, ...}'></textarea>
                    <p class="st_ai_speech_hint st_ai_media_warning" id="st_gpt_image_comfy_status" role="status" aria-live="polite"></p>
                    <details class="st_ai_help"><summary>占位符说明</summary><p class="st_ai_speech_hint">占位符：%prompt%（正面，含画师串）、%negative_prompt%、%seed%（随机）、%width% %height%（按上面的尺寸）、%MODEL_NAME%（模型栏）。「自动标记」只换提示词、种子和尺寸，工作流里调好的步数、CFG、采样器不动；想在这里改，就把值换成 %steps% %cfg_scale% %sampler_name% %scheduler%，再在额外参数里给，比如 {"steps": 28}（不给用 20 / 7 / euler / normal）。中文写法 %提示词% %种子% 也认。</p></details>
                </div>
            </section>

            <section class="st_ai_card" data-tone="rose">
                <div class="st_ai_card_head">
                    <span class="st_ai_card_icon" aria-hidden="true"><i class="fa-solid fa-sliders"></i></span>
                    <div class="st_ai_card_titles"><h4 class="st_ai_card_title">参数与开关</h4><p class="st_ai_card_sub">额外参数、超时和自动识别</p></div>
                </div>
                <div class="st_ai_field" data-hide-for="auto">
                    <label for="st_gpt_image_params">额外参数（JSON 对象）</label>
                    <textarea id="st_gpt_image_params" class="st_ai_textarea st_ai_code" rows="2" maxlength="4096" placeholder='{"seed":42}'></textarea>
                    <details class="st_ai_help"><summary>说明</summary><p class="st_ai_speech_hint" id="st_gpt_image_params_hint"></p></details>
                </div>
                <div class="st_ai_field">
                    <label for="st_gpt_image_timeout">生图超时时间（秒）</label>
                    <input type="number" id="st_gpt_image_timeout" class="st_ai_input" min="30" max="300" step="10" placeholder="120">
                </div>
                <div class="st_ai_field">
                    <label class="st_ai_checkbox">
                        <input type="checkbox" id="st_gpt_image_enabled">
                        <span>启用扩展</span>
                    </label>
                </div>
                <div class="st_ai_field">
                    <label class="st_ai_checkbox">
                        <input type="checkbox" id="st_gpt_image_auto_detect">
                        <span>自动识别AI回复中的生图指令</span>
                    </label>
                </div>
            </section>

            <section class="st_ai_card" data-tone="violet" data-show-for="novelai comfyui sdwebui">
                <div class="st_ai_card_head">
                    <span class="st_ai_card_icon" aria-hidden="true"><i class="fa-solid fa-palette"></i></span>
                    <div class="st_ai_card_titles"><h4 class="st_ai_card_title">画师串</h4><p class="st_ai_card_sub">每个接口单独保存，可存多份、可随机</p></div>
                </div>
                <div class="st_ai_field" id="st_ai_prompt_preset_panel"></div>
            </section>

            <div id="st_ai_image_prompt_panel" class="st_ai_card_slot"></div>
        </div>
    </div>

    <div class="st_ai_tab_content" data-tab="speech" id="st_ai_speech_panel"></div>
    <div class="st_ai_tab_content" data-tab="video" id="st_ai_video_panel"></div>

    <div class="st_ai_tab_content" data-tab="gallery">
        <div class="st_ai_gallery_header">
            <div class="st_ai_gallery_heading">
                <span class="st_ai_gallery_title">媒体库</span>
                <span id="st_gpt_gallery_count" class="st_ai_gallery_count">当前聊天 · 0 个媒体</span>
            </div>
            <button type="button" id="st_gpt_image_clear_history" class="st_ai_btn st_ai_btn_danger"><i class="fa-solid fa-trash"></i> 清空</button>
        </div>
        <div class="st_ai_gallery_filters" role="group" aria-label="媒体库筛选">
            <button type="button" class="st_ai_gallery_filter active" data-kind="all">全部<span class="st_ai_filter_count"></span></button>
            <button type="button" class="st_ai_gallery_filter" data-kind="image">图片<span class="st_ai_filter_count"></span></button>
            <button type="button" class="st_ai_gallery_filter" data-kind="video">视频<span class="st_ai_filter_count"></span></button>
            <button type="button" class="st_ai_gallery_filter" data-kind="audio">语音<span class="st_ai_filter_count"></span></button>
            <button type="button" class="st_ai_gallery_filter" data-kind="legacy">旧版未归属</button>
        </div>
        <div id="st_gpt_image_history_list" class="st_ai_gallery_grid">
            <div class="st_ai_image_empty">暂无生成记录</div>
        </div>
    </div>

</div>`;

/**
 * 面板与预览都用 <dialog>：showModal 会渲染到 top layer，
 * 不受宿主任何 transform/z-index/overflow 影响，移动端也能稳定铺满屏幕。
 */
export const DIALOG_HTML = '<dialog id="st_ai_dialog"></dialog>';

export const PREVIEW_HTML = '<dialog id="st_gpt_image_preview" class="st_ai_image_preview"></dialog>';

/** 把模板字符串变成元素。 */
export function fromHtml(html) {
    const holder = document.createElement('div');
    holder.innerHTML = String(html).trim();
    return holder.firstElementChild;
}

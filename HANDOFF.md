# 酒馆多媒体插件：项目交接

更新时间：2026-09-30（Asia/Shanghai）。接手前请重新检查 Git 与远端。

## 2026-09-30 正文按钮图标、配音按钮文字

用户嫌界面重做后配音按钮的渐变实心圆图标和灰色情绪注释丑。按用户 TT 的主题把候选（6 种图标 × 6 种情绪样式）逐个截真图做成选样页让用户挑，定下来的改动：

- 正文生成按钮的图标改成浅色七彩圆底，图形本身用主渐变上色（配音是四根彩色声波）；生图、视频按钮和播放键同款，失败时是浅粉圆底。
- 配音按钮改叫「生成语音」，和「生成图片」「生成视频」统一；按钮上不显示情绪（情绪在悬停提示里，照样送给配音接口）。
- 描边、大小、投影、播放胶囊都保持原版。用户只点名了图标和情绪注释，顺手改别处被否过两次。
- 验证：`npm test` 131 项、`inline-media-ui.py` 21 组通过；另用 Playwright `page.route` 挂出仓库，直接 import `createMediaElement`，套用户主题截图核对。
- 同一天清理了仓库里的历史堆积：删掉根目录 4 个早期生图提示词 / 世界书文件（已被内置默认提示词和自动注入取代）、`docs/superpowers/` 里 6 月的设计和计划文档、一批从没被调用的函数（包括 `gallery/db.js` 里旧版媒体库的写入和查询，现在它只负责读取和删除升级前的老记录）；`docs/verification/` 里模拟宿主和真实酒馆两组证据用当前代码重跑后替换，真实渠道那组（付费接口实测）保留。

## 0. 2026-09-29 界面重做（分支 `feat/ui-redesign`）

用户要求「用全部技术做一个好看到震撼的」。只改外观和动效，功能、设置项、数据格式、所有 id 都没动。设计与规则见 [docs/UI-DESIGN.md](docs/UI-DESIGN.md)。

- 风格：初版深色「极光玻璃」用户觉得「太抽象」，要求「七彩的做得清新一点」，定稿为**浅色马卡龙七彩**：白色磨砂面板，七彩只做点缀（下划线、进度条、声波），图形都用具体的（画布网点、画笔、胶片齿孔、照片白边）。
- **坑：酒馆 `.mes_text i` 会把正文里的 `<i>` 染成 `--SmartThemeEmColor`**，Font Awesome 图标也是 `<i>`，所以按钮里的图标会发灰；`style.css` 用 `.mes_text :where(...) i { color: inherit }` 修掉。

- 新增 `src/ui/fx.js`：显影卡片、声波、比例换算、图片预加载、共用的等待计时（rAF，不留定时器）。
- **坑：酒馆「快速 UI 模式」默认开启**，会给 body 加 `no-blur`，并用 `!important` 关掉所有 `backdrop-filter`。依赖毛玻璃的半透明层会透出背后的文字，所以 `style.css` 末尾给 `body.no-blur` 配了近乎不透明的底色。测试实例 `settings.json` 的 `power_user.fast_ui_mode` 为 true。
- **坑：酒馆的 `.mes_text img:not(.mes_img)` 优先级 (0,2,1)**，会把正文图片的 max-height 撑到整屏；新样式用 `#chat .st_ai_img_frame > img.st_gpt_inline_img` 盖过去。
- **开关是胶囊形**（`.st_ai_checkbox` 里的勾选框画成拨动开关，标签栏和滑块也是胶囊）。**坑：美化主题和别的扩展常用 `!important` 改 `input[type=checkbox]` 的圆角和尺寸**，只改圆角开关就成了长方形，连尺寸一起改就散架。所以开关决定形状的属性都加了 `!important`（选择器限定在面板内，不影响酒馆自己的勾选框）；`inline-media-ui.py` 注入一段这样的主题样式，断言开关仍是胶囊、拨钮是圆的。
- **坑：`replaceChildren(null)` 会把 null 画成文字**（`el()` 会滤掉，`replaceChildren` 不会）；`inline-media-ui.py` 加了断言。
- 装饰性文字（提示词摘要、图片说明、视频描述）走 CSS `attr(data-text)`，不进 DOM 文本：扫描器靠比对 `.mes_text` 的文字判断要不要重扫。
- 视频仍是 `preload=none`（测试断言，媒体文件只在播放时加载），封面是按描述取色的极光，不预读首帧。
- 验证：`npm test` 131 项、`inline-media-ui.py` 21 组、`real-st-check.py` 8 项（SillyTavern 1.19，独立数据目录 + `--corsProxy true`）全部通过；聊天静止、面板关闭时 `document.getAnimations()` 里扩展的运行中动画为 0。
- `real-st-check.py` 最后一步原来点「存入图库」，9f9f7ef 起图片自动入库、按钮已变成「查看媒体库」，改版前在 master 上就会失败；已改成等自动入库后核对文件。

**当前状态：2.2.0，图片 / 配音 / 视频都嵌在聊天正文里生成，面板里的语音、视频页只做设置。2026-09-30：`npm test` 131 项、模拟宿主浏览器测试 21 组、真实 SillyTavern 1.18.0（独立数据目录）8 项通过；SOOYA 三个真实渠道 2026-09-27 各完成过一次端到端生成：mikoto 生图（直连）、Fish 配音（经酒馆代理）、Agnes 视频（直连，含断线续查）。代码都在 `master`，GitHub 上只有这一个分支。** 使用说明与验证结果见 [docs/MEDIA.md](docs/MEDIA.md)，真实渠道证据在 `docs/verification/real-vendor-*.json`。

## 1. 项目入口与用户要求

- 本机项目目录：`C:\Users\iulze\Documents\Codex\2026-09-26\new-chat-2\outputs\st-ai-image`
- 仓库：<https://github.com/sooya7/st-ai-image>，主分支 `master`（没有 `main`，用户明确要求沿用 `master`）
- 分支：只有 `master`。合并完的功能分支 2026-09-30 已删除，提交都在 master 里。
- 用户需求演进：
  1. 在原生图扩展上加语音、视频生成，不拖慢酒馆，补充常见生图接口；
  2. 「先做一个」→ 上一轮先做了面板里的手动语音页，随后又做了面板视频页；
  3. **「跟原版的图片一样都嵌入聊天里，不要单独的界面，界面只用来设置」** → 本轮改成当前形态，面板里的生成界面已删除（旧文件备份在仓库外的 `work/pre-inline-backup/`）。
- 本机真实酒馆：`D:\SillyTavern\SillyTavern`（1.18.0，数据在 `data/default-user`，端口 8000）。**本扩展没有安装到这里**；验收用的是同一安装以独立数据目录另起的实例，没有动用户的数据和配置。
- 用户日常用 **TauriTavern**（`%LOCALAPPDATA%\TauriTavern\tauritavern.exe`，数据在 `%APPDATA%\com.tauritavern.client\data`）。扩展是 git 克隆，装在 `data/extensions/third-party/st-ai-image`，跟着 GitHub 的 master；推送后在扩展管理里更新，再刷新页面。TauriTavern 没有 `/proxy/`，外部请求都由 WebView 直接发。

## 2. 已合并的历史

- PR #1（`refactor/v2-modular` → `master`）已合并，merge commit `cd64311e4b628e8e5bda79a44993da64f05a9b2f`；原分支 2026-09-30 已删除。

## 3. 现在的实现

| 路径 | 职责 |
| --- | --- |
| `src/media/tags.js` | `[voice]`/`[语音]`/`[配音]`、`[video]`/`[视频]` 解析、按「类型+文字+序号」定位原文、按位置改写、只认 `/user/files/st-ai-(audio|video)-…` |
| `src/inline/media.js` | 正文按钮/播放器渲染、生成流程、上传、写回聊天、视频任务断线续查（任务句柄存 `message.extra.st_ai_media_jobs`，不含密钥） |
| `src/inline/scanner.js` | 原扫描器，大正则里加入媒体标签（闭合用命名反向引用），注入配音/视频提示词 |
| `src/st/files.js` | Blob → `/api/files/upload` |
| `src/media/media-settings.js` | 语音/视频设置默认值，按服务分 profile，存 `extension_settings["st-ai-image"].speech/.video` |
| `src/ui/media-settings-view.js` | 配音/视频页（第一次切过去才加载）；保存时不碰提示词字段 |
| `src/ui/voice-settings.js` | 配音页的默认音色下拉框和可编辑的音色预设表（按服务分开存） |
| `src/media/selfhosted.js` | 自建服务：ComfyUI 工作流占位符填充、挑输出、经酒馆 `/api/sd/comfy/generate` 或直连 `/prompt`→`/history`→`/view`；SD WebUI 经 `/api/sd/generate` 或直连 txt2img |
| `src/api/novelai.js` | NovelAI：V4.5 请求体、浏览器里解 zip、报错说明；官方接口允许跨域，直连 |
| `src/core/image-profiles.js` | 图片接口各记各的地址/Key/模型/额外参数/尺寸；中转类（auto/openai/chat/gemini）共用一组 |
| `src/media/workflow-templates.js` | 内置 ComfyUI 生图模板：SDXL、Anima |
| `src/media/vendors.js` | 各家原生接口的适配器（图片 5、配音 5、视频 9）：create / task / result；`client.js` 的 `runVendorJob` 统一跑提交、轮询、代理、超时、续查 |
| `src/media/availability.js` | 判断是不是 TauriTavern（没有 /proxy/）；只能走代理的服务（Fish 原生、Runway、Replicate）在 TT 里不列，不常用的进「其他」分组 |
| `src/media/keys.js` | `needsKey`/`isLocalBase`：本机/局域网地址和自建服务 Key 可留空（页面加载就用，所以不放 providers.js） |
| `src/core/library.js` | 「名字 → 内容」库的纯函数（改名/删除/导入/迁移），画师串拼接 `applyPromptPreset`，工作流库读取 |
| `src/ui/library-control.js` | 库控件：下拉框 + 新建/另存为/重命名/删除/导入/导出，起名和确认都在控件内（不用 prompt/confirm） |
| `src/ui/workflow-library.js` / `src/ui/prompt-presets-view.js` | ComfyUI 工作流库（图片、视频共用，含自动标记）和画师串；编辑有 400ms 缓冲，切换前先 flush |
| `src/ui/prompt-section.js` | 各功能页底部的 AI 自动标签区块（开关 + 折叠的提示词 + 恢复默认）；面板按功能分页：图片/配音/视频/图库 |
| `src/media/providers.js`、`client.js` | 各服务请求构造、轮询、下载、酒馆 `/proxy/`、文件头识别（第一次生成时才加载） |

生成后标签改写为 `[voice src="/user/files/…"]原台词[/voice]`，原文和 markdown 保留，刷新后由扫描器重新渲染成播放器。

## 4. 本轮发现并修复的问题（均已在真实酒馆验证）

- 合并正则里媒体标签用 `\1` 闭合，拼到图片正则后面指向了错误的分组，导致完全不匹配。改为命名反向引用，并加了回归测试。
- 连点两次会提交两次（任务表登记在 `await` 之后）。
- 同一消息里有两个相同标签时写错位置。改为按序号定位、按位置替换。
- 酒馆 `/proxy/` 不转发 Content-Type，经代理下载的视频/音频被判为「不是媒体」。改为按文件头识别 WebM/MP4/WAV/OGG/MP3。
- **原有问题**：`getRequestHeadersWithCsrf` 在 ST 已带 `X-CSRF-Token` 的情况下又加了一个小写键，fetch 合并成 `"t, t"` → 403，「存入图库」上传酒馆一直静默失败。
- **原有问题**：`saveSettings` 从不调用 `saveSettingsDebounced`，设置只在酒馆因别的原因保存时才顺带落盘。
- **原有问题**：图库文件夹按角色名分类失效（ST 的 `characterId` 是字符串）。
- Runway 进度是 0–1，原来显示成「0.4%」。
- Agnes 网关给任务状态接口返回 `Cache-Control: public, max-age=14400`，浏览器会把首个「queued」响应缓存 4 小时，轮询原地踏步直到超时（真实任务其实 3.8 分钟已完成）。统一给所有媒体请求加 `cache: 'no-store'`，修复后续查原任务 4.7 秒就拿回结果。

## 5. 已知边界

- Runway、Replicate 不允许浏览器跨域（2026-09-26 CORS 预检实测），必须勾选「通过酒馆代理」并在酒馆 `config.yaml` 开 `enableCorsProxy: true`。这个代理对能访问酒馆的所有人开放，用户的酒馆配置是 `listen: true`、未开白名单和登录，开代理前需要提醒。
- 酒馆代理只转发 JSON：Azure（SSML）和 /videos 兼容服务（multipart）不能走代理，设置页和客户端都会拦截。
- 停止等待不会取消服务端任务；失败不自动重试；重新生成会留下旧文件。
- 所有设置（含密钥）存在酒馆 `settings.json`，与原图片 API Key 相同。
- 原图片扫描器的事件扫描和 30 秒轮询兜底依旧存在，没有做整体性能量化。
- 没有 Safari/iOS 验证。Agnes 只测了 720P/5 秒/flash 模型这一路（SOOYA 在用配置）。

## 6. 验证方法

```powershell
Set-Location 'C:\Users\iulze\Documents\Codex\2026-09-26\new-chat-2\outputs\st-ai-image'
npm test                                                    # 131 项
python tests/inline-media-ui.py --output ./test-output      # 模拟宿主 21 组（需要 Playwright；ffmpeg 可选）
python tests/real-st-check.py --st http://127.0.0.1:8123 --data <临时数据目录> --output ./test-output
# 真实渠道（各调一次付费接口，脚本在仓库外的 work/ 下）：
python ..\..\work\real-vendor-check.py  --st http://127.0.0.1:8123 --data <临时数据目录> --output <结果目录>
python ..\..\work\real-vendor-resume.py --st http://127.0.0.1:8123 --data <临时数据目录> --output <结果目录>  # 复用已完成的任务做续查，不再计费
```

`real-st-check.py` 需要先用独立数据目录启动一个酒馆实例，启动命令见脚本开头。**不要指向 `D:\SillyTavern\SillyTavern\data`。**
两个真实渠道脚本运行时从 kaze1 `/opt/sooya/shared/config/models.json` 读密钥，密钥只在内存和临时数据目录（用完即删）。视频用 Edge 跑（Playwright 自带 Chromium 没有 H.264）。

**测试驱动酒馆的注意点（都踩过）**：全新数据目录的首轮 onboarding 必须填名字、真正点确定完成——它是 `doOnboarding` 的 await 点，跳过后 ST 的 `settingsReady` 一直是 false，界面上的一切设置都不会落盘（控制台刷 `Settings not ready`）；脚本会用过的数据目录再跑，扩展设置里残留的服务商选择会影响断言，`real-st-check.py` 已显式选 provider。

证据：`docs/verification/inline-media-result.json`、`real-st-result.json` 和截图。

## 7. 本机操作提示

- Git 访问 GitHub 需要单条命令加 `-c http.sslBackend=openssl`（默认 schannel 报 `SEC_E_NO_CREDENTIALS`）；不要改全局配置。
- `gh auth status` 登录无效，不要假设能直接推送。
- `index.js` 等少数文件是 CRLF，其余是 LF；用字符串替换改文件时注意换行符。
- 不要在文档、Git、测试夹具里写真实密钥。

## 7.5 SOOYA 渠道适配（2026-09-27，已真实验证）

- 用户要求用 SOOYA（kaze1）在用的渠道做真实测试：图片 mikoto OpenAI Images（gpt-image-2.5-flare）、语音 Fish Audio（s2.1-pro-free）、视频 Agnes（/videos 协议 agnes 方言）。配置在 kaze1 `/opt/sooya/shared/config/models.json`，密钥明文在该文件里。
- 已照 SOOYA 源码新增 Fish Audio、Agnes 两个服务；`/videos` 改为 JSON；视频下载允许跳转；未知任务状态继续轮询。
- CORS 实测：Fish 不允许浏览器直连（需酒馆代理），Agnes、mikoto 允许。
- **真实端到端结果（真实酒馆 + Edge，证据 `docs/verification/real-vendor-*.json`）**：
  - Fish 配音经酒馆代理：38 KB mp3，可解码 2.38 秒，生成 5.0 秒；标签写回正确。
  - mikoto 生图直连：1254×1254 png，23.7 秒；「存入图库」落 `user/images/Seraphina/`。
  - Agnes 视频直连：首次暴露 §4 的缓存假死（轮询原地踏步 15 分钟到超时，真实任务其实 227 秒已完成）；加 `cache: 'no-store'` 后复用原任务「继续查询」4.7 秒完成：3 MB mp4（1280×720，5.2 秒）落 `user/files`、可解码、任务记录清理、聊天文件无密钥。
- `work/real-vendor-resume.py` 续查复测复用已完成的任务，不重新计费；以后验视频链路优先用它（改脚本里的任务来源即可）。

## 8. 下一步

按用户需要再考虑：每条消息的朗读按钮、视频服务端取消接口。另外 `/videos` 兼容流程（Agnes 等）出错时 `requestData` 不读响应体，报错里只有「HTTP 503：服务请求失败」，看不到服务端给的原因（2026-09-30 遇到过一次）；需要排查时给这条路径打开 `readError`。

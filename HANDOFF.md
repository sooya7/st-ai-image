# 酒馆多媒体插件：项目交接

更新时间：2026-09-26（Asia/Shanghai）。接手前请重新检查 Git 与远端。

**当前状态：2.2.0，图片 / 配音 / 视频都嵌在聊天正文里生成，面板里的语音、视频页只做设置。62 项单元测试、15 组模拟宿主浏览器测试、8 项真实 SillyTavern 1.18.0 验收全部通过。分支已推送（未建 PR），还没有调用真实厂商服务。** 使用说明与验证结果见 [docs/MEDIA.md](docs/MEDIA.md)。

## 1. 项目入口与用户要求

- 本机项目目录：`C:\Users\iulze\Documents\Codex\2026-09-26\new-chat-2\outputs\st-ai-image`
- 仓库：<https://github.com/sooya7/st-ai-image>，主分支 `master`（没有 `main`，用户明确要求沿用 `master`）
- 当前本地分支：`feat/media-generation`，起点 `cd64311`（PR #1 合并提交），所有改动都未提交
- 用户需求演进：
  1. 在原生图扩展上加语音、视频生成，不拖慢酒馆，补充常见生图接口；
  2. 「先做一个」→ 上一轮先做了面板里的手动语音页，随后又做了面板视频页；
  3. **「跟原版的图片一样都嵌入聊天里，不要单独的界面，界面只用来设置」** → 本轮改成当前形态，面板里的生成界面已删除（旧文件备份在 `work/pre-inline-backup/`）。
- 本机真实酒馆：`D:\SillyTavern\SillyTavern`（1.18.0，数据在 `data/default-user`，端口 8000）。**本扩展没有安装到这里**；验收用的是同一安装以独立数据目录另起的实例，没有动用户的数据和配置。

## 2. 已合并的历史

- PR #1（`refactor/v2-modular` → `master`）已合并，merge commit `cd64311e4b628e8e5bda79a44993da64f05a9b2f`，未删除原分支。

## 3. 现在的实现

| 路径 | 职责 |
| --- | --- |
| `src/media/tags.js` | `[voice]`/`[语音]`/`[配音]`、`[video]`/`[视频]` 解析、按「类型+文字+序号」定位原文、按位置改写、只认 `/user/files/st-ai-(audio|video)-…` |
| `src/inline/media.js` | 正文按钮/播放器渲染、生成流程、上传、写回聊天、视频任务断线续查（任务句柄存 `message.extra.st_ai_media_jobs`，不含密钥） |
| `src/inline/scanner.js` | 原扫描器，大正则里加入媒体标签（闭合用命名反向引用），注入配音/视频提示词 |
| `src/st/files.js` | Blob → `/api/files/upload` |
| `src/media/media-settings.js` | 语音/视频设置默认值，按服务分 profile，存 `extension_settings["st-ai-image"].speech/.video` |
| `src/ui/media-settings-view.js` | 语音/视频设置页（第一次切过去才加载） |
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

## 5. 已知边界

- Runway、Replicate 不允许浏览器跨域（2026-09-26 CORS 预检实测），必须勾选「通过酒馆代理」并在酒馆 `config.yaml` 开 `enableCorsProxy: true`。这个代理对能访问酒馆的所有人开放，用户的酒馆配置是 `listen: true`、未开白名单和登录，开代理前需要提醒。
- 酒馆代理只转发 JSON：Azure（SSML）和 /videos 兼容服务（multipart）不能走代理，设置页和客户端都会拦截。
- 停止等待不会取消服务端任务；失败不自动重试；重新生成会留下旧文件。
- 所有设置（含密钥）存在酒馆 `settings.json`，与原图片 API Key 相同。
- 原图片扫描器的事件扫描和 30 秒轮询兜底依旧存在，没有做整体性能量化。
- 没有真实厂商验证（无密钥），没有 Safari/iOS 验证。

## 6. 验证方法

```powershell
Set-Location 'C:\Users\iulze\Documents\Codex\2026-09-26\new-chat-2\outputs\st-ai-image'
npm test                                                    # 62 项
python tests/inline-media-ui.py --output ./test-output      # 模拟宿主 15 组（需要 Playwright；ffmpeg 可选）
python tests/real-st-check.py --st http://127.0.0.1:8123 --data <临时数据目录> --output ./test-output
```

`real-st-check.py` 需要先用独立数据目录启动一个酒馆实例，启动命令见脚本开头。**不要指向 `D:\SillyTavern\SillyTavern\data`。**

证据：`docs/verification/inline-media-result.json`、`real-st-result.json` 和截图。

## 7. 本机操作提示

- Git 访问 GitHub 需要单条命令加 `-c http.sslBackend=openssl`（默认 schannel 报 `SEC_E_NO_CREDENTIALS`）；不要改全局配置。
- `gh auth status` 登录无效，不要假设能直接推送。
- `index.js` 等少数文件是 CRLF，其余是 LF；用字符串替换改文件时注意换行符。
- 不要在文档、Git、测试夹具里写真实密钥。

## 7.5 SOOYA 渠道适配（2026-09-27）

- 用户要求用 SOOYA（kaze1）在用的渠道做真实测试：图片 mikoto OpenAI Images（gpt-image-2.5-flare）、语音 Fish Audio（s2.1-pro-free）、视频 Agnes（/videos 协议 agnes 方言）。配置在 kaze1 `/opt/sooya/shared/config/models.json`，密钥明文在该文件里。
- 已照 SOOYA 源码新增 Fish Audio、Agnes 两个服务；`/videos` 改为 JSON；视频下载允许跳转；未知任务状态继续轮询。
- CORS 实测：Fish 不允许浏览器直连（需酒馆代理），Agnes、mikoto 允许。
- 真实生成还没跑成：脚本 `work/real-vendor-check.py`（在工作区 work/ 下，不在仓库）运行时从 kaze1 读密钥，用独立 dataRoot 酒馆 + Edge（Playwright 自带 Chromium 没有 H.264）。上一会话中断，没有产出结果，也没有生成任何文件。

## 8. 下一步

1. 跑 `work/real-vendor-check.py` 完成 Fish / mikoto / Agnes 真实生成（各一次）。
2. 用户确认后建 PR 合入 `master`（发布前先问用户）。
3. 按用户需要再考虑：每条消息的朗读按钮、旧文件清理、视频服务端取消接口。

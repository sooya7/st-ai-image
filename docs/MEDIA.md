# 聊天内配音与视频（2.2.0）

日期：2026-09-26。语音、视频与原版图片一样**嵌在聊天正文里**：AI 回复中的标签变成按钮，点一下生成，结果原位显示并写回聊天记录。插件面板里的「语音」「视频」两页只做设置。

## 标签写法

| 类型 | 写法 | 正文里的样子 |
| --- | --- | --- |
| 配音 | `[voice]台词[/voice]`，也可写 `[语音]…[/语音]`、`[配音]…[/配音]` | 台词照常显示，前面多一个「配音」按钮；生成后变成 ▶ 播放 / ↻ 重新生成 / ⤓ 下载 |
| 视频 | `[video]画面描述[/video]`，也可写 `[视频]…[/视频]` | 「生成视频」按钮（描述在悬停提示里）；生成后原位显示播放器 |

生成完成后，扩展把文件上传到酒馆的 `data/<用户>/user/files/`，再把标签改写为：

```
[voice src="/user/files/st-ai-audio-1790428890464-n5wqii.wav"]"*轻声*晚上好"[/voice]
```

- 只补 `src`，台词/描述原样保留：AI 上下文里看到的仍是台词，markdown（如 `*轻声*`）不变。
- 写回聊天记录后，ST 重渲染、刷新、换设备打开都能看到播放器，不会因按钮重新出现而重复生成、重复计费。
- 只加载本扩展写入的 `/user/files/st-ai-(audio|video)-…` 文件；AI 编造的 `src` 或外链不会被当成媒体加载。

标签可以由角色卡/预设要求 AI 输出，也可以在面板的「提示词」页勾选「让 AI 自动使用标签」，扩展会注入对应的系统提示词（配音、视频默认关闭，提示词可改、可恢复默认）。默认的配音提示词写明了什么时候加标签（情绪强烈或推动剧情的台词、登场第一句）、什么时候不加（旁白、用户角色的话、附和寒暄），每条回复最多 2 处。

## 设置（插件面板 → 语音 / 视频）

每个服务一套独立的地址、密钥、模型，切换服务不会串。设置和密钥与原有图片 API Key 一样保存在酒馆的 `settings.json`（`extension_settings["st-ai-image"]`）。

| 服务 | 浏览器能否直连 | 说明 |
| --- | --- | --- |
| OpenAI / 兼容 TTS | 官方可以 | 兼容中转不允许跨域时勾选酒馆代理 |
| Fish Audio | **不可以** | 必须勾选「通过酒馆代理」；音色填 reference_id；模型放在 model 请求头（免费档 s2.1-pro-free 写进请求体会按付费计费） |
| ElevenLabs | 可以 | Voice ID 在控制台复制 |
| Azure Speech | 视资源配置 | 根地址填区域端点；SSML 请求**不能**走酒馆代理 |
| Runway | **不可以** | 必须勾选「通过酒馆代理」 |
| Replicate | **不可以** | 必须勾选「通过酒馆代理」；模型填 `owner/name[:version]` |
| Agnes AI | 可以 | /videos 协议，JSON 请求，必填 mode: text（自动加）；尺寸填 720P 档位 |
| fal | 可以 | 模型填平台路径，时长/比例写进额外参数 |
| /videos 兼容 | 视服务而定 | JSON 请求（与 SOOYA 线上实现一致），可走酒馆代理 |

「能否直连」是 2026-09-26 用不带密钥的 CORS 预检实测的：Runway、Replicate 的预检不返回 `Access-Control-Allow-Origin`，浏览器会拦截；fal、OpenAI、Gemini、ElevenLabs 允许。

### 酒馆代理

勾选后请求走酒馆自带的 `/proxy/<地址>`，由酒馆服务器转发。需要在酒馆的 `config.yaml` 设置：

```yaml
enableCorsProxy: true
```

然后重启酒馆。注意：这个代理对所有能访问你酒馆的人开放。如果酒馆开了 `listen: true` 并对局域网或公网可见，请同时开启白名单或账号登录。

## 生成过程与限制

- 同一个标签连点只提交一次；失败显示在按钮旁，**不自动重试**（避免重复计费）。
- 视频是异步任务：按钮上显示进度，任务 ID（不含密钥）暂存在该消息的 `extra` 里。生成途中刷新页面，按钮会变成「继续查询视频任务」，点一下继续查原任务，不会重新提交。继续查询时只把密钥发给与当前 API 地址同源的任务地址。
- 生成途中切换聊天：文件仍会保存，但不会写进另一个聊天，会提示文件路径。
- 停止等待不会取消服务端任务；服务商那边可能继续运行和计费。
- 视频下载上限 128 MiB，其它响应 32 MiB。
- 同时最多两个媒体任务。
- 重新生成会留下旧文件（不自动删除，避免误删其它楼层或 swipe 引用的文件）。

## 性能

- 页面加载时只多了标签识别（几个正则）和按钮渲染；协议适配、请求客户端、上传、设置页都在第一次用到时才加载。
- 没有新增轮询或全聊天扫描，沿用原有扫描器。空闲时没有媒体计时器。
- 播放器 `preload="none"`，不自动播放；配音同一时间只播一条。
- 大文件存在酒馆服务器，不写 localStorage，不把 Base64 塞进聊天正文。

## 验证结果

本机 Node.js 24.14.1、Chromium 147.0.7727.15、SillyTavern 1.18.0。

**单元测试** `npm test`：62/62 通过（标签解析/定位/改写、合并正则、协议请求、代理改写、文件头识别、视频任务轮询等）。

**模拟宿主浏览器测试** `python tests/inline-media-ui.py --output <目录>`：15 组通过。模拟 ST 的 markdown 拆分、`updateMessageBlock`、`saveChat`、`saveSettingsDebounced`、`/api/files/upload`+CSRF，以及与真实 ST 一样不带 Content-Type 的 `/proxy/`。结果见 `docs/verification/inline-media-result.json`。

**真实 SillyTavern 1.18.0**（独立数据目录，媒体服务为本地模拟）：8 项通过，扩展报错 0：

- ST 的 markdown 把标签拆进 `<q>`/`<em>` 后，仍正确识别成按钮；
- 设置经 `saveSettingsDebounced` 写入磁盘上的 `settings.json`；
- 配音：浏览器直连 → 真实 `/api/files/upload` → `src` 写进 `.jsonl` 聊天文件 → 从 `/user/files` 播放；
- 视频：全部请求经真实 `/proxy/` 转发（带密钥和版本头），无 Content-Type 的 WebM 按文件头识别，保存并内嵌播放；
- 刷新后重新进入聊天，两个播放器从聊天记录恢复，设置从服务器恢复；
- 确认旧代码的 CSRF 头重复问题（重复 → 403，单个 → 200），修复后「存入图库」能上传到 `user/images/<角色名>/`。

结果见 `docs/verification/real-st-result.json` 和截图。

**未验证**：真实厂商接口。Fish Audio、Agnes 的协议照 SOOYA 线上实现（kaze1 `packages/server/src/providers/{tts,video}.ts`）写成，CORS 已实测（Fish 不允许浏览器直连，Agnes、mikoto 允许），但还没用真实密钥跑通一次完整生成、真实语音与视频质量、Safari/iOS。

## 这次顺带修复的原有问题

- 设置只写进内存、从不调用 `saveSettingsDebounced`，刷新前填写的密钥可能丢失。
- 上传到酒馆图库时 CSRF 头重复（`X-CSRF-Token` 与 `x-csrf-token` 被 fetch 合并成 `"t, t"`），「存入图库」一直上传失败，静默退回原始地址。
- 图库文件夹按角色名分类失效：ST 的 `characterId` 是字符串。

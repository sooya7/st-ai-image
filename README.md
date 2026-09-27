# AI Image, Voice & Video Generator — SillyTavern 扩展

在聊天正文里生成图片、配音和视频的 SillyTavern 扩展。AI 回复中的 `[image]`、`[voice]`、`[video]` 标签会变成按钮，点一下就在原位生成，结果写回聊天记录。

当前本地版本为 **2.2.0**，代码在 `feat/media-generation` 本地分支，尚未推送；从远端默认分支安装仍是原来的生图版本。

## 功能

- **内联生图** — `[image]提示词[/image]` 替换为生成按钮，点击后原位出图，可存入图库并写回正文
- **内联配音** — `[voice]台词[/voice]` 台词照常显示，旁边出现「配音」按钮；生成后变成播放键，文件存进酒馆；`[voice type="御姐"]` 按音色预设表换音色，AI 按角色自己挑类型
- **内联视频** — `[video]画面描述[/video]` 替换为「生成视频」按钮；异步任务显示进度，完成后原位嵌入播放器，刷新页面也能继续查询原任务
- **AI 自动带标签** — 可分别为图片、配音、视频注入系统提示词，让 AI 在回复里输出标签
- **手动静默生图** — 在面板「生图」页输入描述生成
- **图库管理** — 生成记录保存在 IndexedDB，支持浏览、删除、重新生成
- **多协议** — 图片：OpenAI Images、Chat 生图、Gemini 原生、fal、Replicate、旧版自动兼容；配音：OpenAI 兼容 TTS、ElevenLabs、Azure；视频：Runway、fal、Replicate、/videos 兼容
- **API 预设 / 模型列表** — 保存多组图片 API 配置，从接口拉取模型

## 安装

1. 在 SillyTavern 中选择 **Extensions 面板 → Install Extension**
2. 输入仓库 URL：
   ```
   https://github.com/sooya7/st-ai-image
   ```
3. 当前 2.2.0 尚未推送，请使用本地安装包：把压缩包里的 `st-ai-image` 目录放进 `data/<用户>/extensions/`（仅当前用户）或 `public/scripts/extensions/third-party/`（全局），然后刷新酒馆。不要放进服务端的 `plugins/` 目录；已有旧版时先把旧目录移出扩展目录，避免同时加载两份。

## 使用

1. 魔杖菜单 → **AI 图片·语音·视频** 打开面板
2. **设置** 页填写图片 API；**语音**、**视频** 页分别填写对应服务
3. AI 回复里出现标签时，点正文里的按钮生成

### 配音与视频

详见 [聊天内配音与视频](docs/MEDIA.md)。要点：

- 生成结果上传到酒馆的 `user/files`，标签改写为 `[voice src="/user/files/…"]台词[/voice]`，刷新后仍在；
- Runway、Replicate 不允许浏览器直连，需要在设置里勾选「通过酒馆代理」，并在酒馆 `config.yaml` 设置 `enableCorsProxy: true`；
- 失败不自动重试，停止等待不代表服务端停止计费。

### AI 自动出图

面板按功能分成「图片 · 配音 · 视频 · 图库」四页，一项功能的所有设置都在自己那一页。每页底部是这项功能的 AI 自动标签：勾选后注入系统提示词，引导 AI 在回复里自己写标签（图片默认开，配音、视频默认关）；提示词默认折叠，可以改写或恢复默认。

## 配置

| 字段 | 说明 |
|------|------|
| 中转 API 地址 | 图片 API 地址（如 `https://api.openai.com/v1`） |
| 生图接口协议 | 旧版兼容（按模型猜端点，仅端点不支持时降级）或指定协议 |
| API Key | 图片 API 密钥 |
| 模型 | 如 `gpt-image-2`、`gemini-2.5-flash-image`，fal / Replicate 填模型路径 |
| 额外模型参数 | 指定协议时生效的 JSON 对象 |
| 额外提示词 / 负面提示词 | 追加到每次生图描述 |
| 配音 / 视频 页 | 服务、地址、密钥、模型、默认音色与可编辑的音色预设表（配音）或尺寸时长（视频）、酒馆代理 |
| 各页底部 | 这项功能的 AI 自动标签开关和系统提示词 |

所有设置（含密钥）保存在酒馆的 `settings.json`，与酒馆其它扩展相同。

## 文件结构

```
st-ai-image/
├── index.js                # 入口：挂载 + 事件委托
├── style.css               # UI 样式
├── manifest.json           # 插件清单
├── package.json            # 只用于跑测试（npm test）
├── src/
│   ├── core/               # 纯函数层：常量、正则、文本处理、网络、事件总线、通知
│   ├── st/                 # 与 SillyTavern 宿主的接触面
│   │   ├── context.js      # getContext/消息读写/事件订阅/CSRF
│   │   ├── chat-dom.js     # 楼层定位、当前楼层提示词
│   │   └── files.js        # 媒体文件上传到 user/files
│   ├── api/images.js       # 生图 API 客户端（旧版多端点降级 + 指定协议）
│   ├── media/
│   │   ├── tags.js         # [voice]/[video] 标签解析、定位、改写（纯函数）
│   │   ├── media-settings.js  # 语音/视频设置默认值与读取
│   │   ├── providers.js    # 各服务请求构造（按需加载）
│   │   └── client.js       # 请求、任务轮询、下载、酒馆代理（按需加载）
│   ├── inline/             # 正文内联：扫描、图片渲染、配音/视频、写回聊天、任务去重
│   │   ├── scanner.js  render.js  media.js  message.js  tasks.js
│   ├── gallery/            # 图库：IndexedDB 与聊天记录同步
│   ├── ui/                 # 面板、设置页、图库视图、预览、模板、DOM 工具
│   │   ├── media-settings-view.js  # 配音/视频页（按需加载）
│   │   ├── voice-settings.js       # 配音页的默认音色与音色预设表
│   │   └── prompt-section.js       # 各页底部的 AI 自动标签区块
│   ├── generate.js         # 面板里的生图流程
│   └── settings.js         # 设置存储（extensionSettings + saveSettingsDebounced）
├── tests/                  # Node 单元测试 + Playwright 模拟宿主测试
└── docs/
```

## 开发

```powershell
npm test
# 需要 Python Playwright 与 Chromium；ffmpeg 可选（用于生成真实 WebM 验证视频播放）
python tests/inline-media-ui.py --output ./test-output
# 真实酒馆验收：先用独立数据目录启动一个酒馆实例（见脚本开头说明），绝不要指向日常使用的数据目录
python tests/real-st-check.py --st http://127.0.0.1:8123 --data <临时数据目录> --output ./test-output
```

测试使用假密钥、本地模拟服务和模拟 SillyTavern 宿主，不发起付费生成。验证记录见 [docs/MEDIA.md](docs/MEDIA.md#验证结果)。

## License

MIT

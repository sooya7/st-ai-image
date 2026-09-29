# AI Image, Voice & Video Generator — SillyTavern 扩展

在聊天正文里生成图片、配音和视频的 SillyTavern 扩展。AI 回复中的 `[image]`、`[voice]`、`[video]` 标签会变成按钮，点一下就在原位生成，结果写回聊天记录。

当前媒体库改动已合并到默认分支 `master`，可以直接从仓库地址安装。

## 功能

- **清新七彩界面** — 白色磨砂面板 + 马卡龙七彩点缀；生成中原位显示按比例占位的「画布」卡片（网点、画笔、七彩进度），出图时从模糊中显影；图片带淡淡的同色光晕和悬停工具条，配音是带进度环和七彩声波的语音胶囊，视频是带胶片齿孔的封面卡片；大图预览有氛围光、缩放和拖动。聊天静止时不跑任何动画；酒馆开着「快速 UI 模式」时自动换成不透明底色。详见 [界面设计说明](docs/UI-DESIGN.md)
- **内联生图** — `[image]提示词[/image]` 替换为生成按钮，点击后原位出图，自动存入当前聊天媒体库并写回正文
- **内联配音** — `[voice]台词[/voice]` 台词照常显示，旁边出现「生成语音」按钮；生成后变成播放键，文件存进酒馆；`[voice type="御姐"]` 按音色预设表换音色，AI 按角色自己挑类型；`emotion="哽咽，小声"` 让配音带情绪（按各家接口支持的方式送）
- **内联视频** — `[video]画面描述[/video]` 替换为「生成视频」按钮；异步任务显示进度，完成后原位嵌入播放器，刷新页面也能继续查询原任务
- **AI 自动带标签** — 可分别为图片、配音、视频注入系统提示词，让 AI 在回复里输出标签
- **手动静默生图** — 在面板「图片」页输入描述生成
- **媒体库** — 图片、配音和视频生成后自动进入当前聊天的媒体库；索引跟随聊天文件，媒体本体留在酒馆 `user/images` 和 `user/files`，聊天文件不会塞进大文件。支持分类查看、播放、下载、单项删除和清空。删除时移除当前聊天引用；本扩展上传的文件也会从酒馆删除，其他聊天若引用同一文件将无法再播放。旧版浏览器媒体库在「旧版未归属」里查看，无法确定聊天归属的旧记录只移除本地索引。
- **多协议** — 图片：OpenAI Images、Chat 生图、Gemini 原生、NovelAI（V4.5 / V4 / V3）、MiniMax、阿里云百炼（万相 / Qwen-Image）、Stability、Pollinations 和 AI Horde（免费）、fal、Replicate、旧版自动兼容，火山即梦、智谱、硅基流动、xAI、Together、Recraft、OpenRouter 一键填写；配音：OpenAI 兼容 TTS（含 Fish 一键填写）、MiniMax、阿里云百炼（Qwen-TTS / CosyVoice）、Gemini TTS、ElevenLabs、Azure、豆包语音、GPT-SoVITS；视频：/videos 兼容（含 Agnes 一键填写）、即梦 Seedance、海螺、通义万相、Veo、智谱、硅基流动、Luma、可灵、Vidu、fal、ComfyUI。完整列表和验证情况见 [docs/MEDIA.md](docs/MEDIA.md#服务一览)。只能走酒馆代理的（Fish 原生、Runway、Replicate）放在「其他」里，TauriTavern 里不显示
- **自建服务** — ComfyUI（生图、视频，工作流占位符与 st-chatu8 兼容）、SD WebUI（A1111 / Forge）；默认经酒馆后端转发，不用开跨域，TauriTavern 也能用；本机/局域网地址 Key 可留空；自带 SDXL 和 Anima 工作流模板
- **按接口显示设置** — 切到哪个接口只显示它用得上的字段、提示和尺寸；每个接口各记各的地址、Key、模型、额外参数、尺寸（OpenAI / Chat / Gemini / 旧版兼容常是同一个中转站，共用一组）
- **API 预设 / 模型列表** — 保存多组图片 API 配置，从接口拉取模型
- **画师串 / 工作流库** — 画师串（前置、后置、负面，可随机）和 ComfyUI 工作流都能存多份切换、导入导出，可导入 st-chatu8 的固定提示词预设；工作流可一键自动标记占位符

## 安装

1. 在 SillyTavern 中选择 **Extensions 面板 → Install Extension**
2. 输入仓库 URL：
   ```
   https://github.com/sooya7/st-ai-image
   ```
3. 安装或更新后刷新酒馆。手动安装时，把 `st-ai-image` 目录放进 `data/<用户>/extensions/`（仅当前用户）或 `public/scripts/extensions/third-party/`（全局）；不要放进服务端的 `plugins/` 目录，也不要同时保留两份扩展。

## 使用

1. 魔杖菜单 → **AI 图片·语音·视频** 打开面板
2. **设置** 页填写图片 API；**语音**、**视频** 页分别填写对应服务
3. AI 回复里出现标签时，点正文里的按钮生成

媒体库按当前聊天切换，生成后即可在「媒体库」页查看或删除。聊天文件里只保存媒体地址等短索引，不保存图片、音频或视频本体；浏览器打开聊天时会从正文中的扩展标签补齐缺失索引。删除当前聊天的条目会移除这段聊天中的引用；删除整个聊天文件不会自动删除酒馆里的媒体文件。

### 配音与视频

详见 [聊天内配音与视频](docs/MEDIA.md)。要点：

- 生成结果上传到酒馆的 `user/files`，标签改写为 `[voice src="/user/files/…"]台词[/voice]`，刷新后仍在；
- Fish 原生接口、Runway、Replicate 不允许浏览器直连，需要在设置里勾选「通过酒馆代理」，并在酒馆 `config.yaml` 设置 `enableCorsProxy: true`；TauriTavern 没有这个代理，所以在那里不列这几个服务，也不显示代理开关；
- 失败不自动重试，停止等待不代表服务端停止计费。

### AI 自动出图

面板按功能分成「图片 · 配音 · 视频 · 媒体库」四页，一项功能的所有设置都在自己那一页。每页底部是这项功能的 AI 自动标签：勾选后注入系统提示词，引导 AI 在回复里自己写标签（图片默认开，配音、视频默认关）；提示词默认折叠，可以改写或恢复默认。

## 配置

| 字段 | 说明 |
|------|------|
| 生图接口 | 中转站（旧版兼容，按模型猜端点，仅端点不支持时降级）或指定接口；下面的字段、提示、尺寸选项跟着接口变 |
| 地址 / Key / 模型 | 每个接口各存一份，切回来还是上次填的；NovelAI 地址留空用官方，令牌填 `pst-` 开头的 Persistent API Token |
| 额外参数 | 指定接口时生效的 JSON 对象（NovelAI 合并进 `parameters`，ComfyUI 是占位符的值） |
| 画师串 | 可切换的提示词预设：前置正面、后置正面、负面，可随机；所有图片服务都用 |
| ComfyUI 工作流库 | 图片、视频各一个；新建 / 从模板新建（SDXL、Anima）/ 导入 / 导出，自动标记占位符 |
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
│   │   ├── emotion.js      # 配音情绪：emotion 属性按各家接口能力送出
│   │   ├── media-settings.js  # 语音/视频设置默认值与读取
│   │   ├── providers.js    # 各服务请求构造（按需加载）
│   │   └── client.js       # 请求、任务轮询、下载、酒馆代理（按需加载）
│   ├── inline/             # 正文内联：扫描、图片渲染、配音/视频、写回聊天、任务去重
│   │   ├── scanner.js  render.js  media.js  message.js  tasks.js
│   ├── gallery/            # 媒体库：聊天元数据索引、旧版 IndexedDB 读取、服务器文件删除
│   ├── ui/                 # 面板、设置页、媒体库视图、预览、模板、DOM 工具
│   │   ├── fx.js                   # 显影卡片、声波、等待计时等视觉部件
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
# 图片预加载期间切聊天、切同名角色与切 swipe 的回归
python tests/chat-race-ui.py --output ./test-output
# 真实酒馆验收：先用独立数据目录启动一个酒馆实例（见脚本开头说明），绝不要指向日常使用的数据目录
python tests/real-st-check.py --st http://127.0.0.1:8123 --data <临时数据目录> --output ./test-output
```

测试使用假密钥、本地模拟服务和模拟 SillyTavern 宿主，不发起付费生成。验证记录见 [docs/MEDIA.md](docs/MEDIA.md#验证结果)。

## License

MIT

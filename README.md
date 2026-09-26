# AI Image Generator — SillyTavern 扩展

支持 OpenAI / Gemini 兼容 API 的 AI 图片生成插件，自动识别聊天中的 `[image]` 标签并原位渲染。

## 功能

- **手动静默生图** — 在悬浮窗输入描述后生成
- **内联自动生图** — AI 回复中出现 `[image]提示词[/image]` 时自动替换为生成按钮或图片
- **AI 自动出图** — 通过注入系统提示词让 AI 在每轮回复中自动携带 `[image]` 标签
- **图库管理** — 生成记录自动保存（IndexedDB），支持浏览、删除、重新生成
- **提示词编辑** — 已生成的图片可编辑 prompt 并更新到聊天记录
- **API 预设** — 保存/加载多组 API 配置
- **模型列表获取** — 从 API 拉取可用模型列表

## 安装

1. 在 SillyTavern 中选择 **Extensions 面板 → Install Extension**
2. 输入仓库 URL:
   ```
   https://github.com/sooya7/st-ai-image
   ```
3. 或手动克隆到 `plugins/extensions/` 目录

## 使用

1. 点击聊天栏 Wand 按钮打开插件面板
2. 在 **设置** tab 中填写 API 地址和 Key
3. 切换到 **生图** tab 输入描述后点生成
4. AI 回复中含 `[image]文字描述[/image]` 时自动弹出生成按钮

### 内联生图流程

AI 回复 `[image]少女坐在窗边[/image]` → 自动替换为「生成图片」按钮 → 点击后调用 API 生成 → 图片原位渲染 → 可保存到图库或重新生成

### AI 自动出图

开启「AI 自动图文出图」开关后，插件会注入系统提示词，引导 AI 在每轮回复末尾自动附带 `[image]` 标签。

## 配置

| 字段 | 说明 |
|------|------|
| 中转 API 地址 | OpenAI 兼容 API 地址（如 `https://api.openai.com/v1`） |
| API Key | API 密钥 |
| 模型 | 模型名称（如 `gpt-image-2`、`gemini-2.0-flash-exp-image-generation`） |
| 额外提示词 | 追加到每次生图描述末尾 |
| 负面提示词 | 不希望出现的内容 |
| 自定义出图提示词 | AI 自动出图时使用的系统提示词 |

## 支持模型

- OpenAI `gpt-image-2` 系列
- Gemini 图像生成模型（`gemini-2.0-flash-exp-image-generation` 等）
- 任何兼容 OpenAI `/v1/images/generations` 或 `/v1/chat/completions` 格式的 API

## 文件结构

v2 把原来 2500 行的单文件 `index.js` 拆成了分层模块：入口只负责挂 UI、绑事件、起扫描器。

```
st-ai-image/
├── index.js                # 入口：挂载 + 事件委托
├── style.css               # UI 样式
├── manifest.json           # 插件清单
├── package.json            # 只用于跑测试（node --test tests/）
├── src/
│   ├── core/               # 纯函数层：常量、正则、文本处理、网络、事件总线、通知
│   │   ├── constants.js  default-prompt.js  text.js
│   │   └── net.js  bus.js  notify.js
│   ├── st/                 # 与 SillyTavern 宿主的唯一接触面
│   │   ├── context.js      # getContext/消息读写/事件订阅/CSRF
│   │   └── chat-dom.js     # 楼层定位、当前楼层提示词
│   ├── api/images.js       # 生图 API 客户端（多端点降级 + 响应格式兼容）
│   ├── gallery/            # 图库：IndexedDB（含 localStorage 降级）与聊天记录同步
│   │   ├── db.js  sync.js
│   ├── inline/             # 正文内联：扫描、渲染、写回聊天记录、任务去重
│   │   ├── scanner.js  render.js  message.js  tasks.js
│   ├── ui/                 # 面板、图库视图、预览、按钮组、模板、DOM 工具
│   │   ├── panel.js  settings-view.js  gallery-view.js  preview.js
│   │   └── image-actions.js  tabs.js  template.js  dom.js
│   ├── generate.js         # 面板里的生图流程
│   └── settings.js         # 设置存储（extensionSettings + 旧数据迁移）
├── tests/                  # 纯函数单测：node --test tests/
│   ├── text.test.mjs  api.test.mjs
├── image_gen_prompt.txt           # AI 出图提示词模板
├── worldinfo_image_logic.json     # World Info 出图规则
├── worldinfo_female_priority.json # 女性优先 World Info
└── docs/
```

设置面板 HTML 从 `settings.html` 内联进了 `src/ui/template.js`：少一次网络请求，也不会因为扩展目录名不同而 404。

## 开发

```bash
node --test tests/     # 纯函数单测（文本处理 / API 响应解析 / 图库合并）
```

## License

MIT

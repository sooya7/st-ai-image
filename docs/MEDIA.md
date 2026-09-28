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

标签可以由角色卡/预设要求 AI 输出，也可以在对应功能页底部勾选「让 AI 在回复里自己写标签」，扩展会注入对应的系统提示词（配音、视频默认关闭，提示词可改、可恢复默认）。默认的配音提示词写明了什么时候加标签（情绪强烈或推动剧情的台词、登场第一句）、什么时候不加（旁白、用户角色的话、附和寒暄），每条回复最多 2 处。

## 音色预设（多角色配音）

配音页有一张「音色预设」表：一行是一个类型名和它的音色。默认预设好 13 个类型名：

| 女声 | 男声 |
| --- | --- |
| 日常女声、萝莉、青涩少女、活泼少女、温柔女声、御姐、成熟女声、老年女声 | 少年、青年男声、成熟男声、大叔、老年男声 |

- 类型名和音色都能改，也能增删（最多 40 行），每行可以单独试听。每个服务各存一张表，音色 ID 按那家服务的写法填（Fish 填声音模型 ID，Azure 填 `zh-CN-YunxiNeural` 这类名称，OpenAI 填 `alloy` 等）。
- 用 Fish（原生接口，或「OpenAI / 兼容 TTS」地址指向 `fish.audio`）时，表里默认填好了推荐音色；「填入 Fish 推荐音色」按钮只覆盖同名的行，自己加的类型保留。推荐音色都是 Fish 公共声音库里的通用音色（不用明星、网红克隆），2026-09-28 逐个实测可合成，列表在 `src/media/voice-presets.js`。
- AI 写 `[voice type="御姐"]快进来[/voice]`（也认 `音色=`，引号可选）。类型在当前服务的表里、并且填了音色，就用那个音色；没写类型、类型不在表里、或音色空着，就用「默认音色」。
- 默认配音提示词里的 `{{音色类型}}` 注入时换成表里填了音色的类型名，所以改名、增删行后 AI 看到的列表跟着变；一个都没填时提示 AI 不写 type。
- 「默认音色」是下拉框，选项是表里填了音色的类型，也可以选「自定义音色 ID」。
- 写回时 `type` 保留：`[voice type="御姐" src="/user/files/…"]快进来[/voice]`，重新生成还是同一个类型。

## 情绪（emotion）

以前标签里只有台词，TTS 只能对着一句孤立的话猜语气，念出来很平。现在标签可以带 `emotion`（也认 `情绪=`、`语气=`），默认配音提示词要求 AI 每个标签都写：

```text
[voice type="青涩少女" emotion="哽咽，小声"]别走，好不好？[/voice]
```

各家接口能听懂的方式不同（`src/media/emotion.js`），没写 emotion 时请求和以前完全一样：

| 服务 | 怎么送 |
| --- | --- |
| Fish（原生，或「OpenAI 兼容」地址指向 fish.audio） | S2 系列：句首方括号放原话，能归类的再补一个官方英文标签，如 `[哽咽，小声][sad] 别走…`；S1 用圆括号英文标签 |
| OpenAI 兼容：`gpt-4o-mini-tts` 等认 instructions 的模型 | `instructions`（额外参数里自己写的 instructions 保留在前面）；`tts-1` / `tts-1-hd` 不送 |
| 硅基流动 CosyVoice | 官方写法：`指令<\|endofprompt\|>台词` |
| 百炼 | 只有 `qwen3-tts-instruct-flash` 系列送 `instructions` + `optimize_instructions` |
| Gemini TTS | 提示语「用「…」的语气说：台词」 |
| MiniMax | 归类后换成 `voice_setting.emotion` 枚举；whisper 只给 speech-2.6 |
| Azure | `mstts:express-as style`，音色不支持的风格 Azure 按默认读 |
| 豆包（火山 v1） | 只有多情感音色（voice_type 里带 `_emo_`）送 `emotion` + `enable_emotion` |
| ElevenLabs | 只有 `eleven_v3` 加英文音频标签，如 `[whispers]` |
| GPT-SoVITS | 不支持（语气取决于参考音频） |

归不了类（比如「若有所思」）时，只收枚举的服务不送情绪，照常合成，不会因为情绪报错。

2026-09-28 用 Fish `fish-audio/s2.1-pro-free`（兼容接口，青涩少女音色）实测：加 `[哽咽，小声][sad]` 后时长 3.7 → 5.4 秒，Whisper 转写开头多出抽泣声、提示本身没有被读出来；`[气急败坏地大喊][angry]` 平均响度 -16.5 → -13.9 dB。

## 按接口显示设置

图片页先选「生图接口」，下面只显示这个接口用得上的东西：
- 质量下拉框只在 OpenAI 类接口出现；尺寸选项按接口换（OpenAI 是 1024x1024 / 1536x1024 / 1024x1536，NovelAI、ComfyUI、WebUI 是 832x1216 这类竖图横图），Chat / Gemini / fal / Replicate 不用尺寸就不显示。
- 地址、Key、模型的叫法和示例、额外参数的说明、接口说明都跟着换；自建服务不显示 Key，ComfyUI 显示工作流库，WebUI 显示账号密码。
- **每个接口各记各的**地址、Key、模型、额外参数、尺寸（存在 `imageProfiles` 里）。OpenAI Images / Chat 生图 / Gemini / 旧版兼容通常是同一个中转站同一把 Key，所以共用一组，互相切不换值。第一次切到 NovelAI / ComfyUI / WebUI 时填好默认地址。输入后马上切走也会先存进原来的接口。
- 套用「API 预设」时也按换接口处理，当前接口填的不会丢。

## NovelAI

- 选「NovelAI」，填令牌（NovelAI 网页：设置 → Account → Get Persistent API Token，`pst-` 开头）。地址留空用官方 `https://image.novelai.net`，用反代就填反代地址（填到域名即可，写全 `/ai/generate-image` 也认）。
- 官方接口允许跨域（`Access-Control-Allow-Origin: *`，2026-09-28 实测），浏览器和 TauriTavern 都直接连，不经酒馆转发；反代要自己允许跨域。
- 请求按网页版 V4 / V4.5 的格式：画师串拼好的提示词同时进 `input` 和 `v4_prompt`，负面同时进 `negative_prompt` 和 `v4_negative_prompt`；默认 28 步、CFG 5、`k_euler_ancestral` + `karras`、打开质量词（`qualityToggle`），种子随机。额外参数合并进 `parameters`，可以覆盖这些，比如 `{"steps": 23, "qualityToggle": false}`。V3 模型会忽略 `v4_*` 字段。
- 模型列表按钮给内置列表：`nai-diffusion-4-5-full`（默认）、`4-5-curated`、`4-full`、`4-curated-preview`、`3`、`furry-3`；新模型可以直接手填。
- 返回的 zip 在浏览器里解开（不压缩和 deflate 都认）；反代直接回图片或 JSON（`images[0]` / `image` / `data[0].b64_json`）也认。
- 报错：401 令牌不对，402 没订阅或 Anlas 不够（Opus 在 1024×1024 以内、28 步以内不扣），429 同时只能生成一张。
- 没做：角色分区提示词（`characterPrompts`）、图生图、Vibe Transfer、放大。

## Anima 等本地模型

Anima（circlestone-labs，2B 动漫模型）没有在线 API，走 ComfyUI：图片页选 ComfyUI → 工作流库「从模板新建…」→「Anima」。模板照 ComfyUI 官方模板：`UNETLoader` 加载 `anima-base-v1.0.safetensors`，`CLIPLoader`（`qwen_3_06b_base.safetensors`，type `stable_diffusion`），`VAELoader`（`qwen_image_vae.safetensors`），30 步、CFG 4、`euler` / `simple`，负面默认带官方那串质量词再接画师串的负面。本机文件名不同（比如还在用 preview3）就在框里改。另一个模板「SDXL（单个 checkpoint）」适合 Illustrious / NoobAI / Pony，模型用模型栏（`%MODEL_NAME%`，可以点刷新拉 checkpoint 列表）。

## 自建服务（ComfyUI / SD WebUI）

图片页的「生图接口协议」和视频页的「服务」里可以选：

| 服务 | 能做 | 地址默认值 | 需要填 |
| --- | --- | --- | --- |
| ComfyUI（自建） | 生图、视频 | `http://127.0.0.1:8188` | 工作流（ComfyUI 里「导出 (API)」得到的 JSON） |
| SD WebUI（A1111 / Forge，自建） | 生图 | `http://127.0.0.1:7860` | 启动参数有 `--api-auth` 时填 `用户名:密码` |

- **不需要 API Key**。另外，任何服务的地址只要是本机或局域网（`localhost`、`127.x`、`10.x`、`192.168.x`、`172.16–31.x`、`*.local`），Key 都可以留空，留空时不发 Authorization。
- **默认经酒馆后端转发**：请求发给酒馆自带的 `/api/sd/comfy/generate`、`/api/sd/generate`，由酒馆服务器去访问自建服务，所以不用给自建服务开跨域，也不用开 `enableCorsProxy`；原版酒馆和 TauriTavern 都有这两个接口。代价是 ComfyUI 任务跑完前看不到进度。
- **浏览器直连**（图片页取消勾选「经酒馆后端转发」，视频页勾选「浏览器直连 ComfyUI」）：能看到等待时间，但 ComfyUI 要加 `--enable-cors-header`，SD WebUI 要加 `--cors-allow-origins`。
- **ComfyUI 工作流占位符**（和 st-chatu8 兼容，中文写法也认）：

| 占位符 | 值 |
| --- | --- |
| `%prompt%` `%提示词%` `%正面提示词%` | 标签里的描述（图片会拼上画师串的前置、后置） |
| `%negative_prompt%` `%负面提示词%` | 画师串的负面（图片页） |
| `%seed%` `%种子%` | 随机；额外参数写 `{"seed": 123}` 可固定 |
| `%width%` `%height%` `%宽度%` `%高度%` | 按尺寸设置（`832x480`、`832*480`、`832:480` 都行） |
| `%steps%` `%cfg_scale%` `%sampler_name%` `%scheduler%` | 默认 20 / 7 / euler / normal |
| `%MODEL_NAME%` `%model%` `%模型%` | 「模型」栏 |
| `%seconds%` `%视频秒数%` `%fps%` `%frames%` | 视频：秒数、帧率（默认 16）、帧数（秒数×帧率+1，Wan 5 秒就是 81） |
| 额外参数里的任意键 | 比如 `{"lora_strength": 0.8}` 会填进 `%lora_strength%` |

  整个字符串就是占位符时按原类型替换（数字还是数字），夹在文字里时按文字替换（`"masterpiece, %prompt%"`）。工作流里有占位符没给值，生成前会直接报出名字。
- **输出节点**：生图用 SaveImage；视频用 VHS Video Combine 或 SaveVideo。经酒馆转发时，酒馆只取第一个图片输出（没有才取 gifs），所以视频工作流里不要再放 SaveImage/PreviewImage，否则拿回来的是那张图；浏览器直连时扩展会按类型挑。
- **SD WebUI**：发 `/sdapi/v1/txt2img`，额外参数里写 txt2img 的字段（如 `{"steps": 28, "sampler_name": "DPM++ 2M", "enable_hr": true}`）；「模型」栏填了会通过 `override_settings.sd_model_checkpoint` 临时切模型。模型列表按钮经酒馆读取 `/api/sd/models` 或 `/api/sd/comfy/models`。
- 自建视频不支持断线续查：刷新页面后任务还在 ComfyUI 里跑完，结果留在 ComfyUI 的 output 目录，但不会写回聊天。

### 工作流库与自动标记

- 图片页和视频页各有一个 ComfyUI 工作流库：下拉框切换，新建 / 另存为 / 重命名 / 删除（点两次确认）/ 导入 / 导出；图片库还能「从模板新建」（SDXL、Anima）。导入认单份「导出 (API)」工作流（用文件名当名字），也认本扩展或 st-chatu8 导出的「名字 → 工作流」文件；同名的自动加序号，不覆盖。
- 以前填的那一份工作流会自动变成库里的「默认」。
- 「自动标记占位符」：顺着 KSampler 的 positive / negative 连线找到两个提示词节点（中间隔着 ConditioningCombine 之类也能找到），把文字换成 `%prompt%` / `%negative_prompt%`；种子和空 Latent 的宽高也换成占位符，并列出改了哪几处。**步数、CFG、采样器、调度器、模型不动**：这些是按模型调好的（Anima 要 30 步 CFG 4，换成占位符会被默认的 20 / 7 顶掉）；想在酒馆这边改就手动换成 `%steps%` 等并在额外参数里给值。已经是连线或已含占位符的值不动。LoRA、ControlNet 等其他参数不自动改，需要的话手动写占位符并在额外参数里给值。

## 画师串（提示词预设）

图片页的「画师串」是一组可切换的提示词预设，每个有三栏：

- **前置正面**：放在描述前面，适合画师串、画风、质量词（如 `artist:wlop, artist:ask, masterpiece`）；
- **后置正面**：放在描述后面；
- **负面**：负面提示词。

生成时拼成「前置, 描述, 后置」（换行当逗号，重复的逗号合并，标签和权重括号不改），负面单独传：ComfyUI 填进 `%negative_prompt%`，SD WebUI 用 `negative_prompt`，OpenAI 类接口附在描述后面。勾选「每张图随机用一个画师串」后，每张图从有内容的画师串里随机挑一个。

- 所有图片服务都会用，不只是自建服务。
- 管理方式和工作流库一样（新建 / 另存为 / 重命名 / 删除 / 导入 / 导出）。可以导入 st-chatu8 导出的固定提示词预设（`fixedPrompt` / `fixedPrompt_end` / `negativePrompt` 会对应到三栏）。
- 以前的「额外提示词 / 负面提示词」会自动变成「默认」画师串。
- 没有做的：预设封面图、分组、卡片网格选择、按角色卡绑定、提示词替换规则。

## 服务一览

「直连」指 TauriTavern 和网页版酒馆都能直接调用。「要代理」指只能在网页版酒馆里勾选「通过酒馆代理」（`config.yaml` 里 `enableCorsProxy: true`），TauriTavern 里不显示这类服务。

2026-09-28 的验证方式：
- 在 TauriTavern 里用假 Key 请求每一家的真实接口，都返回了对方的鉴权错误，说明跨域能通、请求被对方认了。
- 要代理的几家，在网页版酒馆里经 `/proxy/` 用假 Key 测过，结果一样。
- Pollinations 在 TauriTavern 里真的生成了一张图。
- 其余服务都没有用真 Key 出过成品。

| 类别 | 服务 | 接法 | 直连 | 验证 |
| --- | --- | --- | --- | --- |
| 图片 | OpenAI Images / Chat 生图 / Gemini / 旧版兼容 | 原有 | 视服务 | 之前已验证 |
| 图片 | 火山即梦 Seedream、智谱 CogView、硅基流动、xAI、Together、Recraft、OpenRouter | 「一键填写」到 OpenAI 协议 | 是（火山见下） | 只查了跨域预检 |
| 图片 | NovelAI | 原生（解 zip） | 是 | 假 Key 401 |
| 图片 | MiniMax、阿里云百炼（万相异步 / Qwen-Image 同步）、Stability（表单） | 原生 | 是 | 假 Key 鉴权错误 |
| 图片 | Pollinations（免费） | 原生，没 Key 走 `image.pollinations.ai`，有 Key 走 `gen.pollinations.ai` | 是 | **真实出图** |
| 图片 | AI Horde（免费，众包） | 原生异步，匿名 Key `0000000000` | 是 | 只测了接口格式 |
| 配音 | OpenAI 兼容（Fish compat、硅基流动等） | 原有 | 视服务 | 之前已验证 |
| 配音 | MiniMax（hex 音频）、阿里云百炼（Qwen-TTS / CosyVoice，给链接）、Gemini TTS（WAV / PCM） | 原生 | 是 | 假 Key 鉴权错误 |
| 配音 | 豆包语音（火山 v1）、GPT-SoVITS（本地 api_v2） | 原生 | **要代理** | 豆包经代理假 Key 报错；GPT-SoVITS 没测 |
| 视频 | /videos 兼容（Agnes 等）、fal、ComfyUI | 原有 | 是 | 之前已验证 |
| 视频 | 即梦 Seedance、海螺（V1 / H3 的 V2）、通义万相（2.7 新参数 / 2.6 及以前像素尺寸）、Veo、智谱、硅基流动、Luma（新版 API） | 原生异步 | 是 | 假 Key 鉴权错误 |
| 视频 | 可灵（API Key 新版 / AK:SK 旧版 JWT）、Vidu | 原生异步 | **要代理** | 经代理假 Key 报错 |

几点说明：
- **火山方舟**：报错回包不带跨域头，所以 Key 不对时浏览器只能看到「网络请求失败」，扩展会提示「多半是 Key 不对、模型没开通或余额不足」。用真 Key 时成功的回包有没有跨域头还没验证。
- **结果文件**：多数服务返回的结果链接会过期（10 分钟到 24 小时不等），生成完会马上下载，存进酒馆。下载要结果所在的 CDN 允许跨域：百炼、MiniMax 语音、硅基流动的 OSS 允许；火山、MiniMax 视频、智谱的没测出来。下载失败时，网页版酒馆可以开代理，TauriTavern 里只能换服务。
- **一键填写**：会先把当前地址和 Key 存成「自动保存 <域名>」的 API 预设，然后清空 Key，免得把中转站的 Key 发给别家。
- 各家的请求格式按 2026-09-28 的官方文档写。代码在 `src/media/vendors.js`，框架在 `client.js` 的 `runVendorJob`。

## 设置（插件面板 → 配音 / 视频）

每个服务一套独立的地址、密钥、模型，切换服务不会串。设置和密钥与原有图片 API Key 一样保存在酒馆的 `settings.json`（`extension_settings["st-ai-image"]`）。

下拉框只把常用、能直连的放在上面；不常用或只能走酒馆代理的放在「其他」分组。**TauriTavern 没有酒馆的 `/proxy/`**，所以在那里不列只能走代理的服务（Fish 原生、Runway、Replicate），也不显示「通过酒馆代理」开关；以前已经选了这类服务的，会照旧列出并注明「TauriTavern 里用不了」，不会被悄悄换掉。

| 服务 | 浏览器能否直连 | 说明 |
| --- | --- | --- |
| OpenAI 兼容 TTS | 官方可以 | 兼容中转不允许跨域时勾选酒馆代理。**用 Fish 点「一键填写：Fish Audio」**：地址填 `https://api.fish.audio/compat/v1`、模型填免费档 `fish-audio/s2.1-pro-free`，能直连，TauriTavern 也行 |
| ElevenLabs | 可以 | Voice ID 在控制台复制 |
| Azure Speech | 可以 | 根地址填区域端点；SSML 请求**不能**走酒馆代理 |
| Fish Audio 原生（其他） | **不可以** | 必须勾选「通过酒馆代理」；音色填 reference_id；模型放在 model 请求头（免费档 s2.1-pro-free 写进请求体会按付费计费）。一般用上面的一键填写就行 |
| /videos 兼容（默认） | 视服务而定 | JSON 请求（与 SOOYA 线上实现一致），可走酒馆代理；OpenAI 官方不允许直连，Sora 已计划停用。**用 Agnes 点「一键填写：Agnes AI」**（Agnes 允许直连）：地址是 `agnes-ai.com` 时自动加必填的 `mode: text`、默认 5 秒；尺寸填 720P 档位 |
| fal | 可以 | 一个 Key 能用可灵、万相、Veo、Seedance 等；模型填平台路径，时长/比例写进额外参数 |
| ComfyUI（自建） | 经酒馆后端 | 见下文「自建服务」 |
| Runway（其他） | **不可以** | 必须勾选「通过酒馆代理」 |
| Replicate（其他） | 只允许 `localhost:*` | 其他地址要勾选「通过酒馆代理」；模型填 `owner/name[:version]` |

「能否直连」是用不带密钥的 CORS 预检实测的（2026-09-26，2026-09-28 又用 `http://tauri.localhost`、`http://localhost:8000`、`http://127.0.0.1:8000` 三个来源复测）：Fish 原生、Runway 对哪个来源都不返回 `Access-Control-Allow-Origin`；Replicate 只放行 `localhost`；fal、OpenAI、Gemini、ElevenLabs、Azure、NovelAI 允许。

视频默认服务从 Runway 改成了 /videos 兼容（Runway 只能走代理）；以前存过 Runway 的不受影响。

Agnes 原来是单独一项，协议其实就是 /videos，只多一个必填的 `mode: text`，现在并进「/videos 兼容」，按地址识别。老配置读档时自动搬：选的是 Agnes，并且 /videos 那组没填过 Key，就把 Agnes 那组（地址、Key、模型、尺寸）复制过去，改选 /videos 兼容。/videos 那组已经填了别的服务的 Key 时就不动，下拉框里照旧列出 Agnes 并注明「已并入」。Agnes 那组设置和服务 ID 都保留着，刷新前没跑完的老视频任务照样能续查。图片页的 Replicate 同理，在 TauriTavern 里不显示。

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

**单元测试** `npm test`：114/114 通过（2026-09-28）（标签解析/定位/改写、合并正则、协议请求、代理改写、文件头识别、视频任务轮询等）。

**模拟宿主浏览器测试** `python tests/inline-media-ui.py --output <目录>`：18 组通过（2026-09-28）。模拟 ST 的 markdown 拆分、`updateMessageBlock`、`saveChat`、`saveSettingsDebounced`、`/api/files/upload`+CSRF，以及与真实 ST 一样不带 Content-Type 的 `/proxy/`。结果见 `docs/verification/inline-media-result.json`。

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

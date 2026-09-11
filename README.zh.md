# dsh-tool-vision

**GitHub**: [Scorp1o117/dsh-tool-vision](https://github.com/Scorp1o117/dsh-tool-vision) · **npm**: [dsh-tool-vision](https://www.npmjs.com/package/dsh-tool-vision) · [English](README.md)

[![Enhancement Suite](https://img.shields.io/badge/part%20of-Enhancement%20Suite-3964fe)](https://github.com/Scorp1o117/dsh-enhancement-suite) [![npm](https://img.shields.io/npm/v/dsh-enhancement-suite)](https://www.npmjs.com/package/dsh-enhancement-suite)

属于 [DeepSeek Harness Enhancement Suite](https://github.com/Scorp1o117/dsh-enhancement-suite) —— Vision · Soul/Persona · 长期记忆 · 插件市场。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 外接**视觉模型**的插件。

DSH 0.1.1 已为 DeepSeek 视觉模型目录加入原生图片输入。本插件继续提供独立的 OpenAI 兼容视觉端点、像素级图片工具、截图，以及文本模型图片桥。Harness 的每次模型请求都**严格从会话日志推导**（`llm/stream` 请求必须与持久化推导一致，否则 agent-loop invariant 会报 `log-reconstruction desync`），因此图片桥仍在可持久重建的路径内完成转换：

1. **`inspect_image` 工具** —— 把图片（本地文件或 http(s) URL）发给任意支持 `image_url` 内容块的 OpenAI 兼容 `/chat/completions` 端点，把视觉模型的文字回答带回对话。
2. **图片桥（v0.2.1）** —— 粘贴的图片在**进入持久化日志之前**就被转换成 `inspect_image` 指引文本，拦截点是 `agent/pre-step` waterfall（这是 harness 唯一允许插件替换"进入某一步的消息"的缝；替换后的消息会**成为**持久化的 `user/message` 日志，所以请求重建 invariant 天然满足）。旧版本已经写进日志的图片消息，会在该会话下一次 pre-step 时用 surface `replace` 惰性修复。只有 `multimodalModels` 白名单内的模型直收图片块；**不参考模型的 `inputModalities` 声明**——因为很多配置为了通过 prompt 准入检查，会给纯文本模型声明 `input: [text, image]`（那只是声明，不代表上游真的能吃 `image_url`）。

- 除 dsh SDK 外零依赖 —— 兼容任意端点：OpenAI GPT-4o、Qwen-VL（DashScope）、GLM-4V（智谱）、Moonshot、Gemini 兼容端点、本地 Ollama 等。
- 注册在**全局工具层**：进程内所有 Agent 都能调用 `inspect_image`。
- **Web UI 设置栏（v0.3.0）**：设置 → 视觉模型 编辑 `tool-vision` 命名空间（API 地址、只写密钥、模型、桥接选项），写入 `settings.yaml`，**改动即时生效无需重启**。API 密钥存放在 `settings.yaml` 而非 profile patch；插件按包名挂载（`name: 'dsh-tool-vision'`）以便 web 端发现客户端 bundle。

## 安装

在 profile patch（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）里挂载：

```yaml
- insert:
    - id: tool-vision
      name: 'dsh-tool-vision'     # 前置：在 profile 里 pnpm add dsh-tool-vision
      config:
        baseURL: 'https://api.openai.com/v1'
        apiKeyEnv: 'VISION_API_KEY'
        model: 'gpt-4o-mini'
```

不装 npm 包、直接加载本地路径：

```yaml
    - id: tool-vision
      name: './plugins/dsh-tool-vision/index.js'
```

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | **总开关（v0.8.0）**。关闭后插件不注册任何东西：`inspect_image`、14 个 `vision_*` 工具、图片桥、预览路由、图片能力声明统统下线；设置栏本身保留，所以随时能再打开。热生效，无需重启 dsh |
| `baseURL` | `https://api.openai.com/v1` | OpenAI 兼容 API 基地址 |
| `apiKey` | `''` | API 密钥（优先于环境变量） |
| `apiKeyEnv` | `VISION_API_KEY` | 存放密钥的环境变量名 |
| `model` | `gpt-4o-mini` | 视觉模型 id |
| `maxTokens` | `1024` | 视觉调用最大输出 token |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxImageBytes` | `10MB` | 本地图片大小上限 |
| `description` | 默认描述 | 工具描述（模型可见） |
| `bridgeTextOnly` | `true` | 把粘贴图片转成文本指引（发给看不懂图片的模型时） |
| `bridgeExportDir` | 临时目录 | 桥接图片导出目录（`os.tmpdir()/dsh-vision-bridge`） |
| `multimodalModels` | `[]` | 模型名单（逗号分隔）。每项按「完整 id / 末段裸 id / `provider/id`」三种写法匹配，大小写不敏感，支持 `*` `?` 通配（如 `*vl*`、`deepseek/*`）。含义由下面的模式决定 |
| `multimodalListMode` | `whitelist` | **名单模式（v0.9.0）**：`whitelist` 名单内模型直收图片块（旧行为）；`blacklist` 名单内模型强制走桥接（用来纠正"声明支持图片但实际不支持"的模型）；`off` 忽略名单。未知值一律回退 `whitelist` |
| `autoDetectMultimodal` | `true` | **自动识别（v0.9.0）**：按当前路由自己声明的 `inputModalities` 判定，再与名单合成（白名单取并集、黑名单取差集）。默认开启＝识别到纯文本就交给桥接、识别到多模态就等同白名单成员直发图片；声明永远读"包装前"的真值，不会被 `bridgeAutoImage` 的假声明污染。设为 `false` 可退回"只认名单"的纯手工行为 |
| `bridgePreview` | `true` | 桥接图片内联预览：用户气泡内显示缩略图，点击放大 |
| `bridgePreviewScanIntervalMs` | `2000` | 预览兜底扫描间隔（毫秒）；`0` 关闭兜底 |
| `bridgePreviewHideHint` | `true` | 图片加载成功后隐藏桥接提示文本（失败时保留，安全降级） |
| `bridgeAutoImage` | `true` | 桥接开启时向宿主准入检查报告**所有**模型都支持图片输入，纯文本模型也能直接粘贴图片，无需手动改 provider 配置 |
| `sendSessionHeader` | `true` | 给视觉请求发送稳定的会话标识头。OpenCode Go 等网关要求每请求带 `x-opencode-session`（一个对话一个稳定 ID），缺失的请求在 2026-09-06 起可能报错 |
| `sessionHeaderName` | `x-opencode-session` | 承载会话 ID 的头名 |
| `sessionId` | `''` | 固定会话 ID（后台/无 dsh 会话调用时用）；留空则自动：优先取当前 dsh 会话 ID，否则用进程级稳定随机 ID |

## 图片桥配置

1. （一般不需要）只有关闭 `bridgeAutoImage` 时才需要手动给模型声明图片输入（pi-ai 风格），让 harness 放行图片消息：
   ```yaml
   llm-pi-ai:
     providers:
       your-provider:
         models:
           - id: deepseek-v4-flash
             input: [text, image]
   ```
2. 在插件配置里列出真正多模态的模型，让它们直收图片块（名单模式见下一节）：
   ```yaml
   - id: tool-vision
     name: 'dsh-tool-vision'
     config:
       multimodalListMode: whitelist   # 默认，名单内直发图片
       multimodalModels: ['mimo-v2.5', 'grok-4.5']
   ```

之后在文本模型下贴图，转录里会留下一条指引：
`[User sent an image, exported to: <path>. Inspect it with the inspect_image tool...]`
（该消息不再以像素图形式渲染），Agent 会调用视觉端点查看并把结果带回对话。

> 为什么不用 `llm/stream`？harness 会冻结每个请求，且 agent-loop invariant 会拒绝任何与会话日志推导不一致的请求；这个 cordis 版本的 waterfall `next()` 也无法替换请求参数。`agent/pre-step` 才是受支持的缝：它的决策消息**会成为**持久化日志，invariant 天然成立。

密钥解析顺序：`config.apiKey` → `process.env[apiKeyEnv]` → `process.env.OPENAI_API_KEY`。

## 桥接图片预览（v0.4.0）

纯文本模型下，被桥接的图片在对话里只显示一段 `[User sent an image...]` 文本指引。开启 `bridgePreview`（默认开）后，浏览器端会在**展示层**把指引渲染成气泡内缩略图：

- **缩略图 + 灯箱**：点击缩略图全屏放大，点击任意处或按 `Esc` 关闭；
- **即时 + 兜底**：新消息由 MutationObserver 即时处理，历史消息由周期兜底扫描补齐（间隔见 `bridgePreviewScanIntervalMs`）；
- **隐藏提示文本（P2）**：`bridgePreviewHideHint` 开启时，图片加载成功后桥接文本自动隐藏，气泡只留图片；加载失败则保留文本（安全降级，绝不出现"既无图又无字"）；
- **识别机制**：桥接文本带不可见前缀标记（`\u200b[bridge]`），客户端据此精确识别桥接块——用户正常发言中出现"exported to:"字样不会被误伤；
- **纯展示层红线**：不修改持久化消息、不修改转录、不修改模型侧文本、不碰 `inspect_image` 调用链。

预览图片由同源回环路由 `/plugins/dsh-tool-vision/image` 提供，只读桥接导出目录、仅本机 Host、仅图片扩展名、单文件 ≤ 20MB、防目录穿越。

## 工具：`inspect_image`

| 参数 | 必填 | 含义 |
|---|---|---|
| `path` | ✅ | 图片路径（绝对路径，或相对当前工作区）或 http(s) URL |
| `question` | – | 可选的具体问题 |
| `detail` | – | `auto` / `low` / `high` 分辨率提示 |

示例端点（`baseURL`）：

- **OpenAI**：`https://api.openai.com/v1` —— `gpt-4o`、`gpt-4o-mini`
- **阿里云 DashScope（Qwen-VL）**：`https://dashscope.aliyuncs.com/compatible-mode/v1` —— `qwen-vl-plus`、`qwen-vl-max`
- **智谱（GLM-4V）**：`https://open.bigmodel.cn/api/paas/v4` —— `glm-4v-flash`（免费档）、`glm-4v-plus`
- **Moonshot（Kimi）**：`https://api.moonshot.cn/v1` —— `moonshot-v1-8k-vision-preview`
- **Ollama 本地**：`http://localhost:11434/v1` —— `llama3.2-vision`（无需密钥）

## 像素级视觉工具(v0.6.0,移植自 dsh-vision-router)

14 个 `vision_*` 工具由**同一个** `inspect_image` 配置的端点驱动
(baseURL/apiKey/model)——无 provider 链、无本地模型、零新增配置:

| 工具 | 用途 |
|---|---|
| `vision_describe` | 看图问答 / 多图对比(可选结构化 JSON) |
| `vision_ground` | 定位目标,返回原图像素坐标框 |
| `vision_detect` | 枚举元素(按钮/输入框/图标…),带编号框 |
| `vision_crop` | 按像素区域裁剪出 PNG 产物 |
| `vision_pixel_diff` | 逐像素对比:差异比例、最差区域、热图、报告 |
| `vision_colors` | 主色量化,还原 UI 调色板 |
| `vision_ocr` | 逐字转写文字(只读字,不做场景识别) |
| `vision_long_screenshot_ocr` | 长截图分块转写为 Markdown |
| `vision_trace` | potrace 矢量化输出彩色 SVG(worker 线程,安全) |
| `vision_extract_foreground` | 纯色背景抠图 → 透明 PNG |
| `vision_html_screenshot` | 本地 HTML 无头渲染截图(禁网) |
| `vision_screenshot` | 桌面截屏(隐私门控:需在设置中开启 `desktopScreenshot`;Win: PowerShell / macOS: screencapture / Linux: import/scrot) |
| `vision_present` | 通过宿主附件库把生成的图片正式展示给用户 |
| `vision_materialize` | 把附件/本地图片落盘为工作区真实路径 |

质量与安全细节:

- **内容哈希缓存**按 端点+模型+图片+问题 取键(切模型不吃旧答案,失败结果
  不入缓存);
- **统一 4MP 降采样**后再调用模型;超大输入 stat 预检直接拒绝(文件与
  附件路径统一 20MB 上限);
- **限流/5xx 自动重试**(感知 Retry-After 退避);端点**内容安全拒绝**明确
  返回 `VISION_CONTENT_FILTERED`,不再误报后端不可用;
- **长截图 OCR 边界**:120s 总预算、40 块上限、取消检查、首块失败即停;
- **路径 containment**(相对输入禁止逃逸工作区);产物写入
  `<工作区>/.dsh-tool-vision/`。

依赖 `sharp` / `potrace` / `puppeteer-core`(声明为**可选依赖**:平台安装失败
不会阻断插件安装;缺失时懒加载降级并给出安装提示,不影响其他工具)。

`vision_screenshot` 属于隐私敏感能力,**默认不注册**——在 tool-vision 设置中
开启 `desktopScreenshot: true` 后才会注册桌面截屏工具。

## v0.9.0：模型名单模式与自动识别

桥接要回答一个问题：**当前这个模型能不能直接看图片？** v0.9.0 把它拆成两个相互独立的输入。

```
base = autoDetectMultimodal ? (路由声明含 image) : 空集
off        → direct = base              名单不参与
whitelist  → direct = base ∪ 名单        名单只做"加"
blacklist  → direct = base \ 名单        名单只做"减"
```

**命中名单时以名单为准**：名单是用户明确的意图，优先级高于模型自己的声明，所以永远能纠正误判。

**黑名单绝不会退化成"未列出的一律直发"**：黑名单的基准是自动识别集；没开自动识别时基准是空集，未列出的模型照样走桥接。这是刻意设计的——否则一次误配就能把图片硬塞给纯文本端点。

**匹配规则**：`mimo-v2.5`、`xiaomi/mimo-v2.5`、`commandcode/xiaomi/mimo-v2.5` 指向同一个路由；`*` / `?` 为通配符；大小写不敏感。v0.8.1 只做字符串全等，README 自己举的 `mimo-v2.5` 例子在 `xiaomi/mimo-v2.5` 这类路由上其实**静默无效**，v0.9.0 修好了（只会多放行，不会收回任何旧配置已经放行的模型）。

**面板**（设置 → 视觉模型）：

- 名单输入框带自动补全：候选项来自 dsh 已配置的模型（`llm.listProviders()` + `llm.listModels()`），每项标注它是否**声明**支持图片，也可以直接手打通配符；
- 顶部常驻**当前路由判定**：`provider / model`、直发还是桥接、依据是什么（名单命中 / 自动识别 / 默认）。

**判定依据的读取路径**（这是本版最容易做错的地方）：`autoDetectMultimodal` **必须**读 `resolveModelInfo` 被包装之前的真值，否则 `bridgeAutoImage` 给所有模型贴上的"支持图片"就成了自证。代码里由 `unwrappedResolveModelInfo()` 保证，并有专门的回归测试。

候选项由插件自己的回环路由提供：`GET /plugins/dsh-tool-vision/models`（仅本机 Host、只读、`no-store`），只返回 provider/model id 与声明能力，**不含任何密钥或端点地址**。它挂在插件主 fiber 而非总开关的子 fiber 上，所以插件关闭时面板依然可用。

> ⚠️ `inputModalities` 是**声明**，不是保证——profile 里常见"为了过准入检查而写 `input: [text, image]`"的纯文本模型。上游 `dsh-llm-pi-ai` 自己也把"未声明"一律当作纯文本，理由写在源码注释里：**两种误判的代价不对等**——少声明会在贴图前就拒绝并点名模型，多声明则会放行一张"上游中途拒收、而消息已经落盘"的图片。
>
> 所以自动识别是默认开启的，同时带三层兜底：① 某个路由**首次**因"仅凭自己的声明"被放行时，日志会打一条明确提示并点名怎么改；② 面板顶部常驻当前判定与依据；③ 把该模型写进 `multimodalModels` 并切到 `blacklist` 模式即可强制回到桥接。

## v0.8.0：总开关，以及保存修复

**总开关。** `enabled` 字段加设置栏顶部的一键按钮（`一键关闭` / `重新启用`）。
注册本身就是绑定在「发起注册的 cordis fiber」上的副作用，所以插件把所有工具、
图片桥、预览路由和图片能力声明都放进一个**子 fiber**：关掉开关就是销毁这个子
fiber，15 个工具一并从模型侧消失。设置栏留在父 fiber 上，因此关掉之后还能再打开。
无需重启 dsh。

**保存修复。** 此前表单把 18 个字段作为**并行** `scope.set()/unset()` 提交。每个
写入各自携带一个 revision 栅栏，而栅栏落后于宿主文档的写入会被 `settings/conflict`
拒绝——**且被拒绝的写入仍然 resolve**（scope 的契约是「完成写入与恢复读取后结算」，
不是「被拒就抛错」）。于是设置栏显示「已保存」，而编辑内容静默回退，看起来就是
「完全存不了」。

现在改为**一次原子 `mutate()`**，整批修改共用一个栅栏和一次持久化决策；写入结算后
再回读命名空间section做校验，只有确认生效才报「已保存」，否则弹出「写入未生效」并
重新载入表单。没有 `mutate()` 的旧宿主回退为**串行**写入（每个等前一个完成，revision
链条依然正确），绝不并行。

另外删掉了 3 处 `if (typeof scope.load === "function") scope.load()`：`SettingsScope` 接口
从来没有 `load()`（完整 seam 只有 getSnapshot / subscribe / mutate / set / unset，读走的是
共享 describe 镜像，由宿主 `settings/document-updated` 驱动刷新）。这些守卫是照臆测 API 写的
死代码，读起来像"已经刷新过了"，反而掩盖了缺失的写入校验。

## 限制

- 从 `0.6.3` 起最低支持 DSH `0.1.0-rc.7`，已针对 `0.1.0-rc.7`、
  `0.1.0-rc.8` 和 `0.1.1-rc.1` 测试。仍使用 DSH `0.1.0-rc.6` 的用户请锁定
  `dsh-tool-vision@0.6.1`；这是最后一个包含旧 settings 白名单兼容补丁的版本。
- 被桥接的图片以文本指引进入对话（转录而非像素）——文本模型无法做像素级上下文推理；视觉模型的描述通过 `inspect_image` 回传。
- 桥接是**单向门**：文本模型下贴的图会在 `agent/pre-step` 被写进持久化日志，之后切到多模态模型也不会还原成图片块（反方向——多模态切到文本模型——会由 `repairLoggedImages` 自动补上桥接）。
- 图片以 base64 传输；注意隐私与大小限制。
- 独立于 dsh-llm 的路由/重试体系；失败会向 Agent 返回明确错误。

## License

MIT —— 桥接预览与整合:xing666173。像素级视觉工具移植自
[dsh-vision-router](https://github.com/ysr666/dsh-vision-router)(© ysr666,MIT),
在此致谢。

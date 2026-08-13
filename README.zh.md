# dsh-tool-vision

给 DeepSeek Harness 外接**视觉模型**的工具插件。DeepSeek 自家模型是纯文本的，而 dsh-llm 目前还没有多模态内容块类型——本插件用一条 OpenAI 兼容接口补上这个缺口：

Agent 调用工具 `inspect_image`，把本地图片（或 http(s) 图片 URL）发给任意兼容 `image_url` 内容块的 `/chat/completions` 端点，把视觉模型的文字回答带回对话。

- 注册在**全局工具层**：进程内所有 Agent 都能调用 `inspect_image`
- 支持任意 OpenAI 兼容视觉端点：OpenAI GPT-4o / Qwen-VL (DashScope) / GLM-4V (智谱) / Moonshot / Gemini 兼容端点 / Ollama 本地等
- 本地图片自动转 base64 data URL，检查格式与大小上限

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | OpenAI 兼容 API 基地址 |
| `apiKey` | `''` | API 密钥（优先于环境变量） |
| `apiKeyEnv` | `VISION_API_KEY` | 存放密钥的环境变量名 |
| `model` | `gpt-4o-mini` | 视觉模型 id |
| `maxTokens` | `1024` | 视觉调用最大输出 token |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxImageBytes` | `10MB` | 本地图片大小上限 |
| `description` | 默认描述 | 工具描述（模型可见） |

密钥解析顺序：`config.apiKey` → `process.env[apiKeyEnv]` → `process.env.OPENAI_API_KEY`。

## 挂载

在 profile 的 `cordis.patch.yml` 里 insert：

```yaml
- insert:
    - id: tool-vision
      name: './plugins/dsh-tool-vision/index.js'
      config:
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        apiKeyEnv: 'DASHSCOPE_API_KEY'
        model: 'qwen-vl-plus'
```

## 工具：`inspect_image`

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | ✅ | 图片路径（绝对路径，或相对当前 workspace）或 http(s) URL |
| `question` | – | 针对图片的具体问题；缺省为"详细描述" |
| `detail` | – | `auto` / `low` / `high`，图片分辨率提示 |

示例端点（`baseURL` 写法）：

- **OpenAI**：`https://api.openai.com/v1`，模型 `gpt-4o` / `gpt-4o-mini`
- **阿里云百炼 (Qwen-VL)**：`https://dashscope.aliyuncs.com/compatible-mode/v1`，模型 `qwen-vl-plus` / `qwen-vl-max`
- **智谱 (GLM-4V)**：`https://open.bigmodel.cn/api/paas/v4`，模型 `glm-4v-flash`（免费档）/ `glm-4v-plus`
- **Moonshot (Kimi)**：`https://api.moonshot.cn/v1`，模型 `moonshot-v1-8k-vision-preview`
- **Ollama 本地**：`http://localhost:11434/v1`，模型 `llama3.2-vision`（无需 key）

## 局限

- 图片内容以文字描述进入对话，Agent 得到的是"转述"而非像素——精确到像素的任务（如测量）可能不够准
- 图片会在请求中 base64 传输，注意隐私与大小
- 不依赖 dsh-llm 服务，因此不走模型路由/重试体系；失败会以明确的错误信息返回给 Agent

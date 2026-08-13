# dsh-tool-vision

External vision model for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DeepSeek's own models are text-only, and dsh-llm has no multimodal content
block yet. This plugin bridges the gap with a model-facing tool that sends an
image (local file, or http(s) URL) to **any OpenAI-compatible**
`/chat/completions` endpoint that supports `image_url` content parts, and
returns the vision model's textual answer into the agent loop.

- Zero dependencies beyond the dsh SDK — works with any compatible endpoint:
  OpenAI GPT-4o, Qwen-VL (DashScope), GLM-4V (Zhipu), Moonshot, Gemini
  compatible endpoints, local Ollama, etc.
- Registered on the **global tools layer**: every agent in the process can
  call `inspect_image`.

## Install

Mount in a profile patch (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- insert:
    - id: tool-vision
      name: 'dsh-tool-vision'     # after: pnpm add dsh-tool-vision in the profile
      config:
        baseURL: 'https://api.openai.com/v1'
        apiKeyEnv: 'VISION_API_KEY'
        model: 'gpt-4o-mini'
```

Or load it from a local path without npm:

```yaml
    - id: tool-vision
      name: './plugins/dsh-tool-vision/index.js'
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL. |
| `apiKey` | `''` | API key (takes precedence over env). |
| `apiKeyEnv` | `VISION_API_KEY` | Env var holding the key. |
| `model` | `gpt-4o-mini` | Vision model id. |
| `maxTokens` | `1024` | Max output tokens. |
| `timeoutMs` | `60000` | Per-request timeout. |
| `maxImageBytes` | `10MB` | Largest accepted local image. |
| `description` | default | Tool description shown to the model. |

Key resolution order: `config.apiKey` → `process.env[apiKeyEnv]` →
`process.env.OPENAI_API_KEY`.

## Tool: `inspect_image`

| Arg | Required | Meaning |
|---|---|---|
| `path` | ✅ | Image path (absolute, or relative to the current workspace) or http(s) URL. |
| `question` | – | Optional specific question about the image. |
| `detail` | – | `auto` / `low` / `high` resolution hint. |

Example endpoints (`baseURL`):

- **OpenAI**: `https://api.openai.com/v1` — `gpt-4o`, `gpt-4o-mini`
- **Alibaba DashScope (Qwen-VL)**: `https://dashscope.aliyuncs.com/compatible-mode/v1` — `qwen-vl-plus`, `qwen-vl-max`
- **Zhipu (GLM-4V)**: `https://open.bigmodel.cn/api/paas/v4` — `glm-4v-flash` (free tier), `glm-4v-plus`
- **Moonshot (Kimi)**: `https://api.moonshot.cn/v1` — `moonshot-v1-8k-vision-preview`
- **Ollama local**: `http://localhost:11434/v1` — `llama3.2-vision` (no key)

## Limitations

- The image enters the conversation as a text description (a transcript, not
  pixels) — pixel-precise tasks may be inaccurate.
- Images are base64-transferred; mind privacy and size limits.
- Independent of the dsh-llm routing/retry system; failures return clear
  errors to the agent.

## License

MIT

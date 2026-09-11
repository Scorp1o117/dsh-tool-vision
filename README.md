# dsh-tool-vision

[![中文文档](https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-blue)](README.zh.md)

**GitHub**: [Scorp1o117/dsh-tool-vision](https://github.com/Scorp1o117/dsh-tool-vision) · **npm**: [dsh-tool-vision](https://www.npmjs.com/package/dsh-tool-vision)

[![Enhancement Suite](https://img.shields.io/badge/part%20of-Enhancement%20Suite-3964fe)](https://github.com/Scorp1o117/dsh-enhancement-suite) [![npm](https://img.shields.io/npm/v/dsh-enhancement-suite)](https://www.npmjs.com/package/dsh-enhancement-suite)

Part of the [DeepSeek Harness Enhancement Suite](https://github.com/Scorp1o117/dsh-enhancement-suite) — Vision · Soul/Persona · Long-term Memory · Plugin Marketplace.

External vision model for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DSH 0.1.1 adds native image input for DeepSeek's vision catalog. This plugin
remains useful when you want a separate OpenAI-compatible vision endpoint,
pixel-level image tools, screenshots, or a text-model bridge. The harness
derives every model request strictly from the session log (`llm/stream`
requests must equal the durable derivation — the agent-loop invariant), so the
bridge keeps its conversion inside that durable path:

1. **`inspect_image` tool** — sends an image (local file, or http(s) URL) to
   **any OpenAI-compatible** `/chat/completions` endpoint that supports
   `image_url` content parts, and returns the vision model's textual answer
   into the agent loop.
2. **Image bridge (v0.2.1)** — pasted images are turned into `inspect_image`
   hints *before they enter the durable log*, on the `agent/pre-step`
   waterfall (the one seam where the harness lets a plugin replace the
   messages of a proposed step). Images already logged by an older version
   are repaired lazily with a surface `replace` on the session's first
   pre-step. Only models listed in `multimodalModels` receive image blocks
   directly; a model's declared `inputModalities` are never consulted,
   because profiles routinely declare `input: [text, image]` on text-only
   models just to pass the harness's prompt-admission check.

- Zero dependencies beyond the dsh SDK — works with any compatible endpoint:
  OpenAI GPT-4o, Qwen-VL (DashScope), GLM-4V (Zhipu), Moonshot, Gemini
  compatible endpoints, local Ollama, etc.
- Registered on the **global tools layer**: every agent in the process can
  call `inspect_image`.
- **Web UI settings section (v0.3.0)**: Settings → 视觉模型 edits the
  `tool-vision` namespace (API endpoint, write-only key, model, bridge
  options) in `settings.yaml`; changes hot-apply without a restart. The API
  key lives in `settings.yaml`, not the profile patch. Mount by package name
  (`name: 'dsh-tool-vision'`) so the web client bundle is discovered.

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
| `enabled` | `true` | **Master switch (v0.8.0).** Off unregisters everything this plugin contributes — `inspect_image`, the 14 `vision_*` tools, the image bridge, the preview route and the image-capability declaration. The settings section stays mounted so the switch can turn it back on. Hot-applies; no dsh restart. |
| `baseURL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL. |
| `apiKey` | `''` | API key (takes precedence over env). |
| `apiKeyEnv` | `VISION_API_KEY` | Env var holding the key. |
| `model` | `gpt-4o-mini` | Vision model id. |
| `maxTokens` | `1024` | Max output tokens. |
| `timeoutMs` | `60000` | Per-request timeout. |
| `maxImageBytes` | `10MB` | Largest accepted local image. |
| `description` | default | Tool description shown to the model. |
| `bridgeTextOnly` | `true` | Bridge pasted images to text hints on models that cannot see images. |
| `bridgeExportDir` | temp | Export dir for bridged images (`os.tmpdir()/dsh-vision-bridge`). |
| `multimodalModels` | `[]` | Model list (comma-separated). Each entry is matched case-insensitively against the full id, its bare id after the last `/`, and `provider/id`, with `*` / `?` globs (`*vl*`, `deepseek/*`). What the list *means* is set by the mode below. |
| `multimodalListMode` | `whitelist` | **List mode (v0.9.0).** `whitelist`: listed models receive image blocks directly (the historical behaviour). `blacklist`: listed models are forced through the bridge — the correction layer for a model that claims image support it does not have. `off`: the list is ignored. An unknown value falls back to `whitelist`. |
| `autoDetectMultimodal` | `true` | **Auto-detect (v0.9.0).** Decide from the current route's own declared `inputModalities`, then combine with the list (whitelist unions, blacklist subtracts). On by default: a text-only route is bridged, a multimodal one is treated like a whitelist member and gets images directly. The declaration is always read *before* this plugin's admission wrap, so `bridgeAutoImage` can never feed its own claim back in as evidence. Set false for the hand-maintained "list only" behaviour. |
| `bridgePreview` | `true` | Inline preview for bridged images: thumbnail above the hint text in the user bubble (click to zoom). |
| `bridgePreviewScanIntervalMs` | `2000` | Fallback scan interval for the preview scanner (ms); `0` disables the fallback. |
| `bridgePreviewHideHint` | `true` | Hide the bridged hint text once the preview image has loaded (kept on failure — safe degradation). |
| `bridgeAutoImage` | `true` | While the bridge is on, report image input capability for **every** model to the host admission gate, so pasted images are accepted on text-only models without hand-editing provider configs. |
| `sendSessionHeader` | `true` | Send a stable session-id header on vision requests. OpenCode Go and similar gateways require `x-opencode-session` (one stable id per conversation); requests without it may error from 2026-09-06. |
| `sessionHeaderName` | `x-opencode-session` | Header name carrying the session id. |
| `sessionId` | `''` | Fixed session id for calls without a dsh session context; empty = auto (current dsh session id, else a stable per-process random id). |

## Image bridge setup

1. (Optional, usually not needed) If `bridgeAutoImage` is disabled, declare
   image input on the models you paste images onto, so the harness admits
   image messages (pi-ai style):
   ```yaml
   llm-pi-ai:
     providers:
       your-provider:
         models:
           - id: deepseek-v4-flash
             input: [text, image]
   ```
2. List genuinely multimodal models in the plugin config so they receive
   image blocks untouched (see the next section for the list modes):
   ```yaml
   - id: tool-vision
     name: 'dsh-tool-vision'
     config:
       multimodalListMode: whitelist    # default: listed models get images directly
       multimodalModels: ['mimo-v2.5', 'grok-4.5']
   ```

Then pasting an image while on a text-only model stores a hint like
`[User sent an image, exported to: <path>. Inspect it with the inspect_image tool...]`
in the transcript (the pasted image no longer renders as pixels in that
message), and the agent inspects it through the configured vision endpoint.

> Why not `llm/stream`? The harness freezes every request and the agent-loop
> invariant fails any request whose messages diverge from the session-log
> derivation (`log-reconstruction desync`), and this cordis waterfall's
> `next()` cannot replace request arguments. The `agent/pre-step` waterfall is
> the supported seam: its decision messages *become* the durable log, so the
> invariant stays satisfied.

Key resolution order: `config.apiKey` → `process.env[apiKeyEnv]` →
`process.env.OPENAI_API_KEY`.

## Bridge image preview (v0.4.0)

On text-only models, pasted images become `[User sent an image...]` hint
text in the transcript. With `bridgePreview` enabled (default), the browser
half renders those hints as inline thumbnails **in the display layer only**:

- **Thumbnail + lightbox**: click to zoom full-screen; click anywhere or
  press `Esc` to close;
- **Immediate + fallback**: new messages are handled by a MutationObserver;
  history is back-filled by a periodic scan (interval via
  `bridgePreviewScanIntervalMs`);
- **Hide the hint (P2)**: with `bridgePreviewHideHint` on, the hint text is
  hidden once the image has loaded, leaving just the image; on load failure
  the text stays (safe degradation — never "no image AND no text");
- **Precise identification**: bridged hints carry an invisible prefix marker
  (`\u200b[bridge]`), so ordinary user text that happens to contain
  "exported to:" is never misidentified;
- **Display-layer red line**: persisted messages, the transcript, the
  model-facing text and the `inspect_image` chain are untouched.

Preview images are served by the same-origin loopback route
`/plugins/dsh-tool-vision/image`: read-only access to the bridge export
directory, localhost-only Host, image extensions only, ≤ 20MB per file,
path-traversal protected.

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


> **Note for users**
> - This plugin is a standard **profile bundle** (`dsh.bundle.patch`):
>   `dsh plugin --profile web add dsh-tool-vision` installs and mounts it in
>   one step — no manual `cordis.patch.yml` edits needed.
> - Settings changes hot-apply (no restart needed).
> - Version 0.6.3 and newer require DSH `0.1.0-rc.7` or newer and are tested
>   against `0.1.0-rc.7`, `0.1.0-rc.8`, and `0.1.1-rc.1`.
> - DSH `0.1.0-rc.6` users must pin `dsh-tool-vision@0.6.1`, the last release
>   carrying the legacy settings-allowlist compatibility patch.

## Pixel-level vision tools (v0.6.0, ported from dsh-vision-router)

14 `vision_*` tools driven by the **same** configured endpoint as
`inspect_image` (baseURL/apiKey/model) — no provider chain, no local models,
no extra settings:

| Tool | Purpose |
|---|---|
| `vision_describe` | Image Q&A / multi-image comparison (optional structured JSON) |
| `vision_ground` | Locate a target and return its ORIGINAL-pixel bounding box |
| `vision_detect` | Enumerate elements (buttons, inputs, icons…) with numbered boxes |
| `vision_crop` | Crop a pixel region to a PNG artifact |
| `vision_pixel_diff` | Per-pixel comparison: ratio, worst regions, heatmap, report |
| `vision_colors` | Dominant-color quantization for palette matching |
| `vision_ocr` | Verbatim text transcription (letters only — not scene analysis) |
| `vision_long_screenshot_ocr` | Chunked long-screenshot transcription into Markdown |
| `vision_trace` | Potrace vectorization into colored SVG (worker-thread, safe) |
| `vision_extract_foreground` | Solid-background removal → transparent PNG |
| `vision_html_screenshot` | Headless render of a local .html (network blocked) |
| `vision_screenshot` | Desktop capture (privacy-gated: enable `desktopScreenshot` in settings; Win: PowerShell / macOS: screencapture / Linux: import/scrot) |
| `vision_present` | Publish a generated image to the user via the host attachment store |
| `vision_materialize` | Copy an attachment/local image into the workspace as a real path |

Quality & safety details:

- **Content-hash cache** keyed by endpoint+model+image+question (no stale
  answers across model switches, failures are never cached).
- **Uniform 4MP downscale** before every model call; oversized inputs are
  rejected with a clear error (stat pre-check, 20MB cap on both file and
  attachment paths).
- **Rate-limit / 5xx auto-retry** with Retry-After-aware backoff; endpoint
  **content-safety rejections** are surfaced as `VISION_CONTENT_FILTERED`
  instead of a generic backend error.
- **Long-OCR bounds**: 120s total budget, 40-chunk cap, cancellation checks,
  stop-on-first-backend-failure.
- **Path containment** for relative inputs; artifacts land in
  `<workspace>/.dsh-tool-vision/`.

Requires `sharp` / `potrace` / `puppeteer-core` (declared as optional
dependencies: a failed platform install never blocks the plugin; missing ones
degrade lazily with an install hint and never break other tools).

`vision_screenshot` is privacy-sensitive and therefore **not registered by
default** — set `desktopScreenshot: true` in the tool-vision settings to
enable desktop capture.

## v0.9.0: list modes, and auto-detection

The bridge answers one question: **can the current model see images directly?**
v0.9.0 splits it into two independent inputs.

```
base = autoDetectMultimodal ? (route declares image) : {}
off        → direct = base              the list takes no part
whitelist  → direct = base ∪ list       the list only adds
blacklist  → direct = base \ list       the list only subtracts
```

**A list hit always wins**: the list is explicit user intent, so it outranks the
model's own declaration — which is what makes it a usable correction layer.

**A blacklist never degrades into "everything unlisted is direct".** Its base set
is the auto-detected one; with auto-detection off that base set is empty, so an
unlisted model is still bridged. That is deliberate: the alternative lets one
typo push images at a text-only endpoint.

**Matching**: `mimo-v2.5`, `xiaomi/mimo-v2.5` and `commandcode/xiaomi/mimo-v2.5`
all address the same route; `*` / `?` are globs; matching is case-insensitive.
v0.8.1 compared ids literally, so this README's own `mimo-v2.5` example silently
did nothing on a route spelled `xiaomi/mimo-v2.5` — fixed here, and the fix only
ever *adds* models to the direct set (no entry that used to force a model direct
stops doing so).

**In the panel** (Settings → Vision Model):

- the list field is followed by a **clickable list of the models dsh actually has
  configured** (`llm.listProviders()` + `llm.listModels()`), grouped by provider
  and labelled with whether the route *declares* image input. Tick to add,
  untick to remove; the text field above still takes globs by hand. Both edit the
  *same* draft, persisted by Save — the picker head flags it as unsaved until then.
- a **current route** readout shows `provider / model`, whether images go direct
  or through the bridge, and why (list hit / auto-detect / default).

> Why not just a `<datalist>`: a native datalist stays invisible until the user
> focuses the field and types, which made v0.9.0's first cut look like a dead
> panel. The list is now always visible, with the datalist kept as a typing aid.
>
> Unticking removes **the entry that actually matched** — if `mimo-v2.5` in the
> list is what covers `xiaomi/mimo-v2.5`, unticking drops `mimo-v2.5` rather than
> inventing a full id. Which entry hit is computed server-side with the *same*
> matcher the bridge uses (`matchedEntries` in the payload), so the panel can
> never display a state that disagrees with the decision.

**Read path (the easiest thing to get wrong here)**: `autoDetectMultimodal` MUST
read the value from *before* `resolveModelInfo` was wrapped, or the "image
support" that `bridgeAutoImage` stamps onto every model becomes evidence for
itself. `unwrappedResolveModelInfo()` enforces that, with a dedicated regression
test.

Candidates come from the plugin's own loopback route:
`GET /plugins/dsh-tool-vision/models` (loopback Host only, read-only, `no-store`).
It returns provider/model ids and one declared-capability boolean — **no keys and
no endpoint addresses**. It is registered on the plugin fiber rather than the
master switch's child fiber, so the panel keeps working while the plugin is off.

> ⚠️ `inputModalities` is a **declaration**, not a guarantee — profiles commonly
> set `input: [text, image]` on text-only models just to pass the admission gate.
> Upstream `dsh-llm-pi-ai` makes the same call for undeclared models, and its
> source says why: the two wrong answers **do not cost the same**. Under-claiming
> refuses the image before it is attached and names the model; over-claiming
> admits one the provider rejects mid-turn, after the message is already durable.
>
> That is why detection is on by default *with* three backstops: (1) the first
> time a route is promoted purely by its own declaration, the log says so and
> names the fix; (2) the panel always shows the current route, the decision and
> the reason; (3) listing that model under `blacklist` mode forces the bridge
> back on.

## Tests

```bash
npm test             # server-side unit tests (no extra dependencies)
npm run test:render  # panel render test (needs devDependencies)
```

`npm run test:render` loads the **real client bundle** in jsdom, drives the
**real registration path** (`apply` → `slots.register` → the component), feeds it
from the **real server route handler**, and asserts on the real DOM and the real
settings writes.

It is a separate command and deliberately **not part of `npm test`**: it needs
`react` / `react-dom` / `jsdom`, and a DOM test that silently skips when a
dependency is missing is a false comfort. Install with
`npm i -D react@18 react-dom@18 jsdom`.

Its reason to exist is specific: v0.9.0's first cut rendered the model list only
into a native `<datalist>` — every server-side unit test passed while the panel
looked completely dead. Nothing below the DOM can catch that class of bug.

## v0.8.0: master switch, and the save-path fix

**Master switch.** `enabled`, plus a one-click button at the top of the section
(`Disable all` / `Re-enable`). Registrations are effects on the cordis fiber
that makes them, so the plugin now puts every tool, the image bridge, the
preview route and the image-capability declaration in a **child fiber**: turning
the switch off disposes it, and all 15 tools leave the model's tool list
together. The settings section stays on the parent fiber, so the switch can turn
the plugin back on. No dsh restart.

**Save-path fix.** The form used to submit its 18 fields as **parallel**
`scope.set()/unset()` calls. Each write carries its own revision fence, a fence
behind the Host document is refused with `settings/conflict`, and **a refused
write still resolves** — the scope's contract is "settle after the write and any
recovery read", not "throw on refusal". The section therefore reported "Saved"
while the edits silently reverted, which reads as "settings cannot be saved at
all".

Writes are now **one atomic `mutate()`**, so the whole batch shares one fence and
one persistence decision, and the section is inspected after the write settles:
"Saved" only when the change is really there, otherwise "Write did not take
effect" plus a reload of the form. Hosts without `mutate()` fall back to
**sequential** writes (each waits for its predecessor, keeping the revision chain
intact) — never parallel.

Also removes three `if (typeof scope.load === "function") scope.load()` guards.
The `SettingsScope` seam has never had `load()` — it is `getSnapshot` /
`subscribe` / `mutate` / `set` / `unset`, and reads ride the shared describe
mirror driven by the Host's `settings/document-updated`. Those guards were dead
code that read like a refresh which never happened, and they made the missing
write verification look intentional.

## Limitations

- A bridged image enters the conversation as a text hint (a transcript, not
  pixels) — pixel-precise in-context reasoning is not available to text-only
  models; the vision model's description comes back through `inspect_image`.
- The bridge is a **one-way door**: an image pasted on a text-only model is
  rewritten into the durable log at `agent/pre-step`, so switching to a
  multimodal model later does not turn it back into an image block. (The other
  direction — multimodal to text-only — is repaired automatically by
  `repairLoggedImages`.)
- Images are base64-transferred; mind privacy and size limits.
- Independent of the dsh-llm routing/retry system; failures return clear
  errors to the agent.

## License

MIT — bridge preview & integration: xing666173. Pixel vision tools ported
from [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)
(© ysr666, MIT) with gratitude.


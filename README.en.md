# DSH Tool Vision

[简体中文](README.md) | English

Connect a separate OpenAI-compatible vision model to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with an image bridge and image tools. A text-only conversation model can ask the vision model to inspect an image and use its description.

## Features

- **Vision calls:** `inspect_image` sends a local or HTTP(S) image to the configured endpoint, optionally with a question. The model must support compatible image input.
- **Image bridge:** for models that do not receive images directly, converts images into durable text instructions so the Agent can call a vision tool as needed; conversation thumbnails and previews are supported.
- **Detection and overrides:** combines route declarations, probe results and user lists to choose between direct image input and bridging; allowlists and blocklists can correct inaccurate declarations.
- **Image tools:** includes image Q&A, grounding, OCR, crops, pixel differences, colors, vectorization, HTML screenshots and attachment materialization. Some operations require optional dependencies; desktop screenshots are disabled until explicitly enabled.

Bridging gives a text model the vision model's description. The result depends on that model and does not turn the text model into a native multimodal model.

## Compatibility and installation

Supports DSH Web / Desktop. The repository declares compatibility with `0.2.0-rc.2`, `0.2.1-rc.1` / `rc.2` / `rc.3` and versions matching `>=0.2.0-rc.2 <0.3.0`; see [package.json](package.json) for the complete prerelease range. Node.js `>=20.18` is required.

For Desktop, install its `dsh` command through **Application → Manage dsh Command** first:

```sh
dsh plugin --profile desktop add dsh-tool-vision
```

Replace `desktop` with `web` for Web. Restart DSH and open **Plugins → Installed → dsh-tool-vision**. You can also install it through the [Enhancement Suite](https://github.com/Scorp1o117/dsh-enhancement-suite).

## Quick setup

1. Enter the vision service's **API address, key and model ID** in the plugin page. A compatible local service can also be used; supply a key if the service requires one.
2. Choose **Automatic images and previews** for bridging and previews, or **Vision tools only** for explicit calls. Existing custom combinations are preserved.
3. If image capability detection is inaccurate, adjust the model list, list mode or automatic detection under Advanced. Save to apply.
4. Send DSH an image and a question, or ask the Agent to inspect a workspace image with `inspect_image`.

The form writes edited fields only and retains an unchanged key. The interface follows the DSH language setting.

## Usage and limits

- Models with image support can receive images directly. Bridged images enter the conversation as instructions and are not automatically restored to image blocks when switching models later.
- `vision_probe_model` can test image capability. An explicit user list takes precedence over probe results, which in turn take precedence over route declarations.
- `vision_screenshot` requires enabling `desktopScreenshot`. `sharp`, `potrace` and `puppeteer-core` are optional dependencies; affected tools report missing dependencies without disabling other tools.
- Vision requests send images to the configured service. Choose a trusted local or remote endpoint for the content. Input-size and provider limits apply.

## Development, attribution and feedback

- `npm test` runs the project tests. The [historical detailed documentation](https://github.com/Scorp1o117/dsh-tool-vision/blob/00d818b47bd91c330b91207d2be0e50caf8cd87a/README.md) retains configuration fields, tool parameters and release notes; its install commands and compatibility information may be outdated.
- Pixel-level tools were ported from [dsh-vision-router](https://github.com/ysr666/dsh-vision-router) (MIT).
- [npm](https://www.npmjs.com/package/dsh-tool-vision) · [Issues](https://github.com/Scorp1o117/dsh-tool-vision/issues) · [MIT License](LICENSE)

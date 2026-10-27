# DSH Tool Vision

简体中文 | [English](README.en.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接入独立的 OpenAI 兼容视觉模型，并提供图片桥接和图像工具。即使当前对话模型只能处理文本，也可以通过视觉模型查看图片并把描述带回对话。

## 功能

- **视觉模型调用**：`inspect_image` 将本地图片或 HTTP(S) 图片发送到配置的视觉端点，可附带问题；模型需要支持兼容的图片输入。
- **图片桥**：对不直接接收图片的模型，将图片转换为可持久化的文本指引，由 Agent 按需调用视觉工具；支持对话气泡缩略图和预览。
- **模型识别与手动覆盖**：结合路由声明、实测结果和用户名单决定直发图片还是桥接；可用白名单 / 黑名单修正错误声明。
- **图像工具**：包含看图问答、目标定位、OCR、裁剪、像素差异、取色、矢量化、HTML 截图和附件落盘等。部分操作需要可选依赖；桌面截图默认关闭，需在设置中主动启用。

图片桥让文本模型获取的是视觉模型返回的描述，效果取决于所选视觉模型，不能把文本模型变成原生多模态模型。

## 兼容性与安装

支持 DSH Web / Desktop；仓库声明兼容 `0.2.0-rc.2`、`0.2.1-rc.1` / `rc.2` / `rc.3` 和符合 `>=0.2.0-rc.2 <0.3.0` 的版本，预发布版本范围见 [package.json](package.json)。要求 Node.js `>=20.18`。

Desktop 先在 **应用 → 管理 dsh 命令** 安装桌面版 `dsh`：

```sh
dsh plugin --profile desktop add dsh-tool-vision
```

Web 将 `desktop` 改为 `web`。安装后重启 DSH，打开 **插件 → 已安装 → dsh-tool-vision**。也可通过 [Enhancement Suite](https://github.com/Scorp1o117/dsh-enhancement-suite) 安装。

## 快速配置

1. 在插件页填写视觉服务的 **API 地址、密钥和模型 ID**。也可使用兼容图片输入的本地服务；密钥按服务要求填写。
2. 选择**自动图片与预览**以启用桥接等功能，或选择**仅视觉工具**进行显式调用；已有自定义组合不会自动覆盖。
3. 如模型的图片能力识别不准确，在高级设置中调整模型名单、名单模式或自动识别。保存后生效。
4. 向 DSH 发送图片并提问，或让 Agent 使用 `inspect_image` 查看工作区图片。

设置表单只写入编辑过的字段；未修改的密钥保留。语言跟随 DSH。

## 使用与限制

- 支持图片的当前模型可直接接收图片；走桥接的图片以指引进入会话，之后切换模型不会自动还原原始图片块。
- `vision_probe_model` 可实测模型图片能力；手动名单优先于实测，实测优先于路由声明。
- `vision_screenshot` 需在设置中开启 `desktopScreenshot`。`sharp`、`potrace` 和 `puppeteer-core` 是可选依赖；缺失时受影响的工具会提示，其他工具仍可使用。
- 视觉请求会将图片发送给配置的服务，请根据内容选择可信的本地或远程端点。输入大小与服务端能力均有限制。

## 开发、来源与反馈

- `npm test` 运行项目测试；[历史详细文档](https://github.com/Scorp1o117/dsh-tool-vision/blob/00d818b47bd91c330b91207d2be0e50caf8cd87a/README.zh.md)保留配置字段、工具参数和旧版本说明，其中安装命令与兼容性信息可能已过时。
- 像素级视觉工具移植自 [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)（MIT）。
- [npm](https://www.npmjs.com/package/dsh-tool-vision) · [问题反馈](https://github.com/Scorp1o117/dsh-tool-vision/issues) · [MIT License](LICENSE)

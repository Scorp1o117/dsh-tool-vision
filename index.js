/**
 * dsh-tool-vision — external vision model for DeepSeek Harness.
 *
 * Two capabilities:
 *
 * 1. `inspect_image` tool — sends an image (local file, or http(s) URL) to
 *    any OpenAI-compatible chat/completions endpoint that supports
 *    `image_url` content parts, and returns the vision model's text answer.
 *
 * 2. Image bridge — when the current model is text-only (e.g. DeepSeek),
 *    pasted images in user messages are intercepted on the `llm/stream`
 *    waterfall, exported to a local file, and replaced with a text hint
 *    pointing at that path, so the agent can hand the image to
 *    `inspect_image`. Models listed in `multimodalModels` are left
 *    untouched (they receive image blocks directly).
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name. */
const name = "tool-vision";
/** The tool registry, the llm seam (waterfall), and the attachment store. */
const inject = ["tools", "llm", "attachments"];

const DEFAULT_DESCRIPTION =
  "Analyze an image using an external vision-capable model through an OpenAI-compatible API. " +
  "Provide the path to a local image file (absolute, or relative to the current workspace) or an http(s) URL, " +
  "optionally with a specific question. Returns the vision model's textual description or answer. " +
  "Use this whenever you need to read, describe, or extract information from image content, " +
  "since the main model is text-only.";

/** Runtime schema for the tool-vision row. */
const Config = z.object({
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1 or https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseURL: z.string().default("https://api.openai.com/v1"),
  /** API key; takes precedence over apiKeyEnv. */
  apiKey: z.string().default(""),
  /** Environment variable holding the API key. */
  apiKeyEnv: z.string().default("VISION_API_KEY"),
  /** Vision model id served by the endpoint. */
  model: z.string().default("gpt-4o-mini"),
  /** Max output tokens for the vision call. */
  maxTokens: z.number().default(1024),
  /** Per-request timeout in milliseconds. */
  timeoutMs: z.number().default(60000),
  /** Largest local image accepted, in bytes. */
  maxImageBytes: z.number().default(10 * 1024 * 1024),
  /** Tool description shown to the model; overrides the default. */
  description: z.string().default(DEFAULT_DESCRIPTION),
  /** Bridge pasted images to text hints when the current model is text-only. */
  bridgeTextOnly: z.boolean().default(true),
  /** Export directory for bridged images; empty = system temp. */
  bridgeExportDir: z.string().default(""),
  /** Model ids that receive image blocks directly (never bridged). */
  multimodalModels: z.array(z.string()).default([]),
});

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const EXT_BY_MEDIA = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** True when any message carries an image content block. */
function hasImageBlock(messages) {
  return (messages ?? []).some((m) =>
    Array.isArray(m?.content) && m.content.some((b) => b?.type === "image"),
  );
}

/** Export one attachment to disk; returns the file path (cached per process). */
const exportedPaths = new Map();
async function exportImage(attachment, ctx, dir) {
  const cached = exportedPaths.get(attachment.attachmentId);
  if (cached) return cached;
  const { data } = await ctx.attachments.readImage(attachment);
  const ext = EXT_BY_MEDIA[attachment.mediaType] ?? ".img";
  const safeName = attachment.name
    ? attachment.name
        .replace(/\.[^.]+$/, "")
        .replace(/[^\w\-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40)
    : "";
  const base = (safeName ? `${safeName}_` : "") + attachment.attachmentId.slice(0, 12);
  const path = join(dir, `${base}${ext}`);
  await writeFile(path, data);
  exportedPaths.set(attachment.attachmentId, path);
  return path;
}

/**
 * Replace image content blocks with text hints pointing at exported files.
 * Exported for unit testing; `ctx` only needs `attachments`.
 */
async function bridgeMessages(messages, ctx, dir) {
  const next = [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === "image")) {
      next.push(message);
      continue;
    }
    const blocks = [];
    for (const block of content) {
      if (block?.type !== "image") {
        blocks.push(block);
        continue;
      }
      const path = await exportImage(block.attachment, ctx, dir);
      const name = block.attachment.name ? ` (${block.attachment.name})` : "";
      blocks.push({
        type: "text",
        text:
          `[User sent an image${name}, exported to: ${path}. ` +
          `Inspect it with the inspect_image tool to see its content.]`,
      });
    }
    next.push({ ...message, content: blocks });
  }
  return next;
}

function resolveApiKey(config) {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv];
    if (fromEnv) return fromEnv;
  }
  return process.env.OPENAI_API_KEY ?? "";
}

/** Turn a tool argument into an image_url payload: local file -> data URL, http(s) -> as-is. */
async function toImageUrl(target, cwd, config) {
  if (/^https?:\/\//i.test(target)) return { url: target, note: target };
  const abs = isAbsolute(target) ? target : resolvePath(cwd, target);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`image not found: ${abs}`);
  if (info.size > config.maxImageBytes) {
    throw new Error(
      `image too large: ${abs} (${info.size} bytes, limit ${config.maxImageBytes})`,
    );
  }
  const mime = MIME_BY_EXT[extname(abs).toLowerCase()];
  if (!mime) {
    throw new Error(
      `unsupported image extension: ${abs} (supported: ${Object.keys(MIME_BY_EXT).join(", ")})`,
    );
  }
  const data = await readFile(abs);
  return { url: `data:${mime};base64,${data.toString("base64")}`, note: abs };
}

/** One OpenAI-compatible chat/completions call with an image_url content part. */
async function callVision(config, imageUrl, question, detail, signal) {
  const key = resolveApiKey(config);
  if (!key) {
    throw new Error(
      `vision API key missing: set the plugin config (apiKey / apiKeyEnv) or the OPENAI_API_KEY environment variable`,
    );
  }
  const base = config.baseURL.endsWith("/") ? config.baseURL : `${config.baseURL}/`;
  const endpoint = new URL("chat/completions", base);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`vision request timed out after ${config.timeoutMs}ms`)),
    config.timeoutMs,
  );
  const onSignalAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onSignalAbort, { once: true });
  }
  const content = [
    { type: "text", text: question || "Describe this image in detail, including all key visual elements, text, and context you can see." },
    { type: "image_url", image_url: detail ? { url: imageUrl, detail } : { url: imageUrl } },
  ];
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content }],
        max_tokens: config.maxTokens,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detailText = body?.error?.message ?? response.statusText;
      throw new Error(
        `vision endpoint returned ${response.status}: ${detailText} (endpoint ${endpoint})`,
      );
    }
    const answer = body?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("vision endpoint returned an empty response");
    }
    return answer.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onSignalAbort);
  }
}

function apply(ctx, config) {
  // ── image bridge: text-only models get exported paths instead of pixels ──
  if (config.bridgeTextOnly) {
    const exportDir = config.bridgeExportDir || join(os.tmpdir(), "dsh-vision-bridge");
    mkdir(exportDir, { recursive: true }).catch(() => {});
    ctx.on("llm/stream", async function* (options, next) {
      let effective = options;
      try {
        if (options?.messages && hasImageBlock(options.messages) && !config.multimodalModels.includes(options.model)) {
          effective = { ...options, messages: await bridgeMessages(options.messages, ctx, exportDir) };
        }
      } catch (error) {
        ctx.logger.warn(`[tool-vision] image bridge failed: ${String(error)}`);
      }
      yield* next(effective);
    });
  }

  ctx.tools.register(defineTool({
    name: "inspect_image",
    description: config.description,
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the image file (absolute, or relative to the current workspace) or an http(s) URL.",
      },
      question: {
        type: "string",
        description: "Optional specific question about the image. Omit for a general detailed description.",
      },
      detail: {
        type: "string",
        enum: ["auto", "low", "high"],
        description: "Optional image resolution hint for the vision API (auto by default).",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      const { url, note } = await toImageUrl(args.path, cwd, config);
      const answer = await callVision(config, url, args.question, args.detail, exec.signal);
      return note === url ? answer : `${answer}\n\n(image: ${note})`;
    },
  }));
}

export {
  Config,
  DEFAULT_DESCRIPTION,
  EXT_BY_MEDIA,
  apply,
  bridgeMessages,
  exportImage,
  hasImageBlock,
  inject,
  name,
};

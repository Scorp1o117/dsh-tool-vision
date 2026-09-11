/**
 * dsh-tool-vision — external vision model for DeepSeek Harness.
 *
 * Two capabilities:
 *
 * 1. `inspect_image` tool — sends an image (local file, or http(s) URL) to
 *    any OpenAI-compatible chat/completions endpoint that supports
 *    `image_url` content parts, and returns the vision model's text answer.
 *
 * 2. Image bridge — pasted images are bridged to text hints before they
 *    enter a text-only model's request:
 *
 *    - New images are bridged on the `agent/pre-step` waterfall (the only
 *      seam where the harness lets a plugin replace the messages that enter
 *      a step — they become the durable `user/message` log, so the
 *      `llm/stream` request-reconstruction invariant stays satisfied).
 *    - Images already logged before the plugin was installed (or before a
 *      server restart) are repaired lazily with a surface `replace`, one
 *      event at a time, on the first pre-step of the session.
 *
 *    The bridged hint points at an exported local copy of the image, which
 *    the agent hands to `inspect_image`. Which models skip the bridge
 *    (v0.9.0) is decided by two independent inputs:
 *
 *    - `multimodalModels` — a user-owned list whose meaning is set by
 *      `multimodalListMode`: `whitelist` (listed models receive image blocks
 *      directly; the historical meaning and the default), `blacklist`
 *      (listed models are forced through the bridge), or `off` (list
 *      ignored). Entries match the full model id, its bare id after the last
 *      `/`, or `provider/id`, and may contain `*` / `?` globs.
 *    - `autoDetectMultimodal` — when on, the route's own declared
 *      `inputModalities` forms the base set that the list then adds to
 *      (whitelist) or subtracts from (blacklist). The declaration is always
 *      read from the *unwrapped* `resolveModelInfo`, because the admission
 *      wrap below rewrites it for every model.
 *
 * 3. Bridge image preview (v0.4.0, contributed by xing666173 from
 *    dsh-bridge-preview, MIT © 2026 xing666173) — the browser half renders
 *    inline thumbnails for bridged pasted images:
 *
 *    - `bridgeMessages` stamps every bridged hint with an invisible marker
 *      (`BRIDGE_MARKER`), so the client can identify bridge text blocks
 *      precisely instead of pattern-matching free text.
 *    - A loopback route (`/plugins/dsh-tool-vision/image`) serves the
 *      exported images to the same-origin page; the client inserts a
 *      thumbnail above the hint text and opens a lightbox on click.
 *    - Pure display layer: persisted messages, the transcript, the
 *      model-facing text and the `inspect_image` chain are untouched.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { registerVisionTools, CONTENT_FILTER_RE } from "./lib/vision-tools.js";
import { sessionHeaders } from "./lib/session-header.js";

/** Cordis plugin name. */
const name = "tool-vision";
/** The tool registry, the llm seam (model capability lookup), the attachment store, and the host web server. */
const inject = ["tools", "llm", "attachments", "webServer"];
/** Settings namespace owned by this plugin (Web UI settings section). */
const NS = "tool-vision";

/**
 * Invisible prefix stamped onto every bridged hint text block. The browser
 * half uses it to recognize bridge text precisely (no free-text regex over
 * user messages), and the model-facing hint stays intact otherwise.
 */
const BRIDGE_MARKER = "\u200b[bridge]";

/** Loopback route serving bridged images to the same-origin page. */
const BRIDGE_PREVIEW_ROUTE = "/plugins/dsh-tool-vision/image";
/**
 * Loopback JSON route the settings panel reads the configured model catalog
 * from (autocomplete for `multimodalModels` and the current-route readout).
 * Registered on the plugin's own fiber, so it stays up while the master
 * switch is off — a section you cannot configure until you switch it on would
 * be useless.
 */
const MODEL_CATALOG_ROUTE = "/plugins/dsh-tool-vision/models";
/** Per-provider cap on catalog entries returned to the panel. */
const MODEL_CATALOG_MAX_PER_PROVIDER = 500;
/** Hard cap for a single served image (defense in depth; export is bounded). */
const BRIDGE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** Extensions the preview route serves (svg/ico intentionally excluded). */
const BRIDGE_PREVIEW_MEDIA = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

const DEFAULT_DESCRIPTION =
  "Analyze an image using an external vision-capable model through an OpenAI-compatible API. " +
  "Provide the path to a local image file (absolute, or relative to the current workspace) or an http(s) URL, " +
  "optionally with a specific question. Returns the vision model's textual description or answer. " +
  "Use this whenever you need to read, describe, or extract information from image content, " +
  "including an image that reached you as a bridged text hint.";

/** Runtime schema for the tool-vision row. */
const Config = z.object({
  /**
   * Master switch, hot-applied. When off the plugin registers nothing at all —
   * no `inspect_image`, none of the 14 `vision_*` tools, no pre-step bridge, no
   * preview route, no llm capability wrap — while the settings section itself
   * stays mounted so the switch can turn it back on. Turning it off is the way
   * to stop every vision tool from reaching the model without uninstalling the
   * package or restarting dsh.
   */
  enabled: z.boolean().default(true),
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1 or https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseURL: z.string().default("https://api.openai.com/v1"),
  /** API key; takes precedence over apiKeyEnv. Rendered as a write-only secret in the Web UI. */
  apiKey: z.string().default("").role("secret"),
  /** Environment variable holding the API key. */
  apiKeyEnv: z.string().default("VISION_API_KEY"),
  /** Vision model id served by the endpoint. */
  model: z.string().default("gpt-4o-mini"),
  /** Max output tokens for the vision call. */
  maxTokens: z.number().default(4096),
  /** Per-request timeout in milliseconds. */
  timeoutMs: z.number().default(60000),
  /** Largest local image accepted, in bytes. */
  maxImageBytes: z.number().default(10 * 1024 * 1024),
  /** Tool description shown to the model; overrides the default. */
  description: z.string().default(DEFAULT_DESCRIPTION),
  /** Bridge pasted images to text hints on models that cannot see images. */
  bridgeTextOnly: z.boolean().default(true),
  /** Export directory for bridged images; empty = system temp. */
  bridgeExportDir: z.string().default(""),
  /**
   * Model ids the list below refers to (v0.9.0). Each entry is matched
   * case-insensitively against the full model id (`xiaomi/mimo-v2.5`), its
   * bare id after the last `/` (`mimo-v2.5`), and `provider/id`
   * (`commandcode/xiaomi/mimo-v2.5`), and may use `*` / `?` globs
   * (`*vl*`, `deepseek/*`). A bare id therefore keeps working however the
   * route happens to spell it.
   */
  multimodalModels: z.array(z.string()).default([]),
  /**
   * How `multimodalModels` is read (v0.9.0):
   *
   *  - `whitelist` (default): a listed model receives image blocks directly
   *    and is never bridged — the meaning the list always had, so an
   *    existing configuration keeps behaving exactly as before.
   *  - `blacklist`: a listed model is forced through the bridge even when its
   *    route declares image input. This is the correction layer for a model
   *    that claims image support its endpoint does not really have.
   *  - `off`: the list is ignored entirely; nothing is forced either way.
   *
   * An unknown value falls back to `whitelist`.
   */
  multimodalListMode: z.string().default("whitelist"),
  /**
   * Let the current route's own declared `inputModalities` drive the bridge
   * decision, so only the models that cannot see images get bridged (v0.9.0,
   * **on by default**). This and `multimodalModels` are one decision, not two:
   * the declaration forms the base set, and the list unions with it
   * (whitelist) or subtracts from it (blacklist).
   *
   * The declaration is only whatever the profile — or the installed catalog —
   * says, and it CAN be wrong: profiles sometimes declare
   * `input: [text, image]` just to pass the host admission gate, and a wrong
   * "yes" sends the image straight to an endpoint that may reject it. The
   * harness's own text-model projection is disabled by `bridgeAutoImage`, so
   * nothing underneath catches that. Two things bound the damage: the first
   * promotion of a route logs a notice naming the escape hatch
   * ({@link warnAutoPromotion}), and naming that route in `multimodalModels`
   * under `blacklist` mode forces the bridge back on. Set this to false to
   * bridge everything the list does not name.
   *
   * The value is always read from the *unwrapped* `resolveModelInfo`, so the
   * admission wrap can never feed its own claim back in as evidence.
   */
  autoDetectMultimodal: z.boolean().default(true),
  /** Inline preview for bridged images: thumbnail above the hint text in the user bubble (click to zoom). */
  bridgePreview: z.boolean().default(true),
  /** Fallback scan interval for the preview scanner in ms; 0 disables the periodic fallback. */
  bridgePreviewScanIntervalMs: z.number().default(2000),
  /** Hide the bridged hint text once the preview image has loaded (kept on failure — never "no image AND no text"). */
  bridgePreviewHideHint: z.boolean().default(true),
  /** Privacy gate for vision_screenshot: desktop capture is only registered when explicitly enabled. */
  desktopScreenshot: z.boolean().default(false),
  /**
   * Advertise image input capability for every model while the bridge is on.
   * The host admission gate (host-apiproxy `prompt`/`selectModel`) refuses
   * pasted images unless the current model declares `image` in its
   * `inputModalities`. The bridge handles those images anyway (they become
   * text hints the agent inspects through `inspect_image`), so this wraps the
   * llm service's `resolveModelInfo` to report image support for text-only
   * models too — users can paste images on any model without hand-editing
   * provider model configs.
   */
  bridgeAutoImage: z.boolean().default(true),
  /** Send a stable per-conversation id header (`x-opencode-session`) on vision
   * requests. OpenCode Go (and similar OpenAI-compatible gateways) require it
   * on every request; requests without the header may error. The value is the
   * current dsh session id when the call runs inside one, else `sessionId`
   * below, else a stable per-process random id. Set false to disable. */
  sendSessionHeader: z.boolean().default(true),
  /** Header name carrying the session id. */
  sessionHeaderName: z.string().default("x-opencode-session"),
  /** Fixed session id override for callers without a dsh session context.
   * Empty = auto (per-process stable id). */
  sessionId: z.string().default(""),
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

/** Deep-freeze an acyclic JSON-safe value in place (the harness freezes every durable message). */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
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
 * Non-image messages are returned as-is (same reference); bridged messages
 * are fresh, deep-frozen objects with the original identity and source.
 * Each bridged hint is stamped with the invisible {@link BRIDGE_MARKER}
 * prefix so the browser half can recognize it precisely.
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
          `${BRIDGE_MARKER}[User sent an image${name}, exported to: ${path}. ` +
          `Inspect it with the inspect_image tool to see its content.]`,
      });
    }
    next.push(deepFreeze({ ...message, content: blocks }));
  }
  return next;
}

/** Parse `?a=b&c=d` from a raw request URL (percent-decoded). */
function parseQuery(rawUrl) {
  const query = {};
  const at = rawUrl.indexOf("?");
  if (at === -1) return query;
  for (const pair of rawUrl.slice(at + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    try {
      query[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      /* skip malformed pairs */
    }
  }
  return query;
}

/**
 * Advertise `image` in the `inputModalities` reported by the llm service for
 * every model, so the host admission gate lets pasted images through on
 * text-only models. The bridge turns those images into text hints anyway, so
 * this is pure admission: it never changes what the adapter actually streams
 * (the adapter's own stream validation reads the model's real `input` from
 * the provider config, untouched here).
 *
 * The wrap is installed on the shared llm service instance, so it must be
 * idempotent across HMR re-applies and restored on dispose. `marker` is a
 * per-instance record proving this plugin already owns the wrap; the
 * `installed` flag distinguishes "we wrapped it" from "the original was
 * replaced by something else" so dispose only restores what we replaced.
 *
 * Exported for unit testing; the test passes a fake llm service.
 */
const LLM_RESOLVE_WRAP_MARK = Symbol("dsh-tool-vision.resolveModelInfo.wrapped");
function installAutoImageAdmission(llm, logger) {
  if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== "function") {
    logger?.warn?.("[tool-vision] llm service unavailable; automatic image admission not installed");
    return () => {};
  }
  if (llm[LLM_RESOLVE_WRAP_MARK]) return () => {}; // already wrapped by us (HMR re-apply)
  const original = llm.resolveModelInfo.bind(llm);
  const wrapped = async (provider, model, signal) => {
    const info = await original(provider, model, signal);
    if (!info) return info;
    const mods = info.inputModalities;
    if (Array.isArray(mods) && mods.includes("image")) return info;
    return { ...info, inputModalities: [...(mods ?? []), "image"] };
  };
  let installed = false;
  // The marker carries BOTH functions: the wrapped one proves ownership for
  // dispose, and `original` is the only honest source of a route's real
  // modalities once the wrap is in place (`unwrappedResolveModelInfo`).
  llm[LLM_RESOLVE_WRAP_MARK] = { original, wrapped };
  llm.resolveModelInfo = wrapped;
  installed = true;
  logger?.debug?.("[tool-vision] automatic image admission installed (resolveModelInfo wrapped)");
  return () => {
    if (installed) {
      if (llm.resolveModelInfo === wrapped) llm.resolveModelInfo = original;
      installed = false;
    }
    delete llm[LLM_RESOLVE_WRAP_MARK];
  };
}

/**
 * Register the loopback route that serves bridged images to the same-origin
 * page (the preview thumbnails). Read-only and tightly scoped:
 *  - only files inside the bridge export directory (no traversal);
 *  - only image extensions from {@link BRIDGE_PREVIEW_MEDIA};
 *  - Host restricted to the local machine;
 *  - hard 20MB cap per file.
 */
function registerBridgePreviewRoute(ctx, exportDir, logger) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) {
    logger?.warn?.("[tool-vision] webServer unavailable; bridge preview route not registered");
    return;
  }
  const bridgeDir = resolvePath(exportDir);
  ctx.effect(() => webServer.register({
    kind: "exact",
    path: BRIDGE_PREVIEW_ROUTE,
    async handler(req, res) {
      try {
        const raw = String(req.url ?? "");
        const query = parseQuery(raw);
        const p = query.p;
        if (typeof p !== "string" || p.length === 0) {
          res.writeHead(400);
          res.end("bad request");
          return;
        }
        const lower = p.toLowerCase();
        const mediaType = BRIDGE_PREVIEW_MEDIA[extname(lower)];
        if (mediaType === undefined) {
          res.writeHead(400);
          res.end("not an image path");
          return;
        }
        const host = String(req.headers?.host ?? "");
        if (host !== "" && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const target = resolvePath(p);
        if (target !== bridgeDir && !target.startsWith(bridgeDir + sep)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const info = await stat(target);
        if (!info.isFile() || info.size > BRIDGE_PREVIEW_MAX_BYTES) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const bytes = await readFile(target);
        res.writeHead(200, {
          "Content-Type": mediaType,
          "Cache-Control": "private, max-age=60",
        });
        res.end(bytes);
      } catch {
        try {
          res.writeHead(404);
          res.end("not found");
        } catch {
          /* response already sent */
        }
      }
    },
  }), "dsh-tool-vision: bridge preview route");
}

/**
 * Register the loopback JSON route the settings panel reads:
 *
 *   { current: {provider, model, direct, source, mode}, providers: [...] }
 *
 * `providers` comes from `llm.listProviders()` + `llm.listModels(provider)` —
 * the routes the harness actually has configured, which is exactly the set a
 * `multimodalModels` entry may name. `listModels` is a different seam from
 * `resolveModelInfo`, so these declared modalities are the profile's own and
 * are NOT contaminated by the admission wrap (a model the wrap advertises as
 * image-capable still reports its real declaration here).
 *
 * Same confinement as the image route: loopback Host only, read-only,
 * `no-store`, and no credentials or endpoints in the payload — provider ids,
 * model ids/names and one boolean each.
 */
function registerModelCatalogRoute(ctx, logger, getConfig) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) {
    logger?.warn?.("[tool-vision] webServer unavailable; model catalog route not registered");
    return;
  }
  ctx.effect(() => webServer.register({
    kind: "exact",
    path: MODEL_CATALOG_ROUTE,
    async handler(req, res) {
      const send = (status, payload) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(payload));
      };
      const host = String(req.headers?.host ?? "");
      if (host !== "" && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
        send(403, { error: "forbidden" });
        return;
      }
      const llm = ctx.get("llm");
      if (llm === undefined) {
        send(503, { error: "llm service unavailable" });
        return;
      }
      // `listed` is computed HERE, with the same matcher the bridge itself
      // uses, so the panel never reimplements the rule (and can never
      // disagree with the decision it is describing).
      const cfg = typeof getConfig === "function" ? getConfig() : undefined;
      const list = Array.isArray(cfg?.multimodalModels) ? cfg.multimodalModels : [];
      const listMode = normalizeListMode(cfg?.multimodalListMode);
      let routes = [];
      try {
        routes = llm.listProviders() ?? [];
      } catch (error) {
        logger?.debug?.(`[tool-vision] listProviders failed: ${String(error)}`);
      }
      const providers = [];
      for (const entry of routes) {
        const id = entry?.id;
        if (typeof id !== "string" || id.length === 0) continue;
        const record = {
          id,
          name: typeof entry?.name === "string" && entry.name.length > 0 ? entry.name : id,
          models: [],
        };
        try {
          const models = await llm.listModels(id);
          record.models = (models ?? []).slice(0, MODEL_CATALOG_MAX_PER_PROVIDER).map((model) => {
            const modelId = String(model.id);
            const matchedEntries = modelListMatchEntries(list, id, modelId);
            return {
              id: modelId,
              name: typeof model.name === "string" && model.name.length > 0 ? model.name : modelId,
              image: Array.isArray(model.inputModalities) && model.inputModalities.includes("image"),
              listed: matchedEntries.length > 0,
              matchedEntries,
            };
          });
        } catch (error) {
          // One broken route must never blank the whole panel: report it and
          // keep going, so the other providers still list.
          record.error = String(error?.message ?? error);
        }
        providers.push(record);
      }
      send(200, {
        current: { ...lastModelDecision },
        list,
        listMode,
        providers,
      });
    },
  }), "dsh-tool-vision: model catalog route");
}

/** Accepted `multimodalListMode` values; anything else falls back to whitelist. */
const MULTIMODAL_LIST_MODES = ["off", "whitelist", "blacklist"];
const DEFAULT_MULTIMODAL_LIST_MODE = "whitelist";

/**
 * Normalize a configured list mode. The settings section only ever writes one
 * of {@link MULTIMODAL_LIST_MODES}, but the value can also arrive from a
 * hand-edited `settings.yaml`, so an unknown string is clamped rather than
 * treated as "no mode" (which would silently bridge everything).
 */
function normalizeListMode(value) {
  return MULTIMODAL_LIST_MODES.includes(value) ? value : DEFAULT_MULTIMODAL_LIST_MODE;
}

const listEntryCache = new Map();
/**
 * Compile one list entry into an anchored, case-insensitive regexp. A literal
 * entry is just an exact match; `*` and `?` are the only metacharacters, so a
 * model id containing `.` or `+` still matches itself.
 */
function listEntryRegExp(entry) {
  const cached = listEntryCache.get(entry);
  if (cached !== undefined) return cached;
  const source = entry
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const compiled = new RegExp(`^${source}$`, "i");
  listEntryCache.set(entry, compiled);
  return compiled;
}

/**
 * Whether any entry in `patterns` names this route. Each entry is tested
 * against the full model id, its bare id after the last `/`, and
 * `provider/id` — so `mimo-v2.5`, `xiaomi/mimo-v2.5` and
 * `commandcode/xiaomi/mimo-v2.5` all address the same route, and `*vl*`
 * addresses every variant of one family. Exported for unit testing.
 */
function modelListMatches(patterns, provider, model) {
  return modelListMatchEntries(patterns, provider, model).length > 0;
}

/**
 * The list entries that address this route. The panel needs *which* entry hit
 * so that unchecking a model removes exactly the entry responsible — matching
 * `mimo-v2.5` against `xiaomi/mimo-v2.5` must not leave an orphan behind, and
 * must not delete an unrelated entry either. Exported for unit testing.
 */
function modelListMatchEntries(patterns, provider, model) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  if (typeof model !== "string" || model.length === 0) return [];
  const slash = model.lastIndexOf("/");
  const candidates = [model, slash === -1 ? model : model.slice(slash + 1)];
  if (typeof provider === "string" && provider.length > 0) candidates.push(`${provider}/${model}`);
  const hits = [];
  for (const raw of patterns) {
    if (raw === undefined || raw === null) continue;
    const entry = String(raw).trim();
    if (entry.length === 0) continue;
    const re = listEntryRegExp(entry);
    if (candidates.some((candidate) => re.test(candidate))) hits.push(String(raw));
  }
  return hits;
}

/**
 * The route the session is on: the logged request header first, then the
 * agent's own options. `provider` is optional (older logs may lack it).
 */
function currentRoute(agent) {
  const header = agent?.session?.requestHeader?.();
  return {
    provider: header?.config?.provider ?? agent?.options?.provider,
    model: header?.config?.model ?? agent?.options?.model,
  };
}

/**
 * The last decision `currentModelAcceptsImage` made, for the settings panel's
 * "current route" readout (served over {@link MODEL_CATALOG_ROUTE}). A plain
 * mutable record — the panel only ever reads it.
 */
const lastModelDecision = {
  provider: undefined,
  model: undefined,
  direct: false,
  source: "none",
  mode: DEFAULT_MULTIMODAL_LIST_MODE,
};

/**
 * `resolveModelInfo` as it was before {@link installAutoImageAdmission}
 * wrapped it. Auto-detection MUST read through this: the wrap reports image
 * support for *every* model, so reading the wrapped method would make the
 * plugin's own claim the evidence for itself.
 */
function unwrappedResolveModelInfo(llm) {
  const marker = llm?.[LLM_RESOLVE_WRAP_MARK];
  const fn = marker?.original ?? llm?.resolveModelInfo;
  return typeof fn === "function" ? fn.bind(llm) : undefined;
}

/**
 * Whether the route declares `image` input, read before the admission wrap.
 * `false` and `undefined` are the same answer to the caller ("not known to be
 * multimodal"): a route nobody could resolve is bridged, never guessed.
 */
async function routeDeclaresImage(llm, provider, model) {
  const resolve = unwrappedResolveModelInfo(llm);
  if (resolve === undefined || typeof provider !== "string" || typeof model !== "string") {
    return false;
  }
  try {
    const info = await resolve(provider, model);
    return info?.inputModalities?.includes("image") === true;
  } catch {
    return false;
  }
}

/** Routes already warned about, so the notice appears once per route. */
const autoPromotionWarned = new Set();

/**
 * One-time notice when a route receives images directly *only* because of its
 * own declaration (source `auto`). This is the one failure auto-detection
 * cannot rule out: if the declaration is wrong, the endpoint rejects the image
 * after the message is already durable, and the error alone does not say what
 * to change. Naming the escape hatch the first time it happens turns a
 * confusing 400 into a one-line fix. Read {@link lastModelDecision}; never
 * throws.
 */
function warnAutoPromotion(logger) {
  const { provider, model, direct, source } = lastModelDecision;
  if (direct !== true || source !== "auto" || typeof model !== "string" || model.length === 0) return;
  const key = `${typeof provider === "string" ? provider : ""}\u0000${model}`;
  if (autoPromotionWarned.has(key)) return;
  autoPromotionWarned.add(key);
  logger?.warn?.(
    `[tool-vision] "${model}" receives images directly because its route declares image input; ` +
    `if the endpoint rejects them, list it in multimodalModels under multimodalListMode: blacklist`,
  );
}

/**
 * Whether the session's current model may receive image blocks directly.
 *
 * Two inputs, deliberately independent:
 *
 *  - the base set — the route's own declared `inputModalities`, and only when
 *    `autoDetectMultimodal` is on. It is read through
 *    {@link unwrappedResolveModelInfo}, never through the admission wrap.
 *  - the list — `multimodalModels` under `multimodalListMode`, and the list is
 *    always explicit user intent, so it outranks the declaration: whitelist
 *    adds to the base set, blacklist subtracts from it.
 *
 * Returns true when bridging is disabled (nothing would be bridged anyway).
 */
async function currentModelAcceptsImage(agent, config, llm) {
  const mode = normalizeListMode(config.multimodalListMode);
  if (!config.bridgeTextOnly) {
    Object.assign(lastModelDecision, { ...currentRoute(agent), direct: true, source: "bridge-off", mode });
    return true;
  }
  const { provider, model } = currentRoute(agent);
  if (!model) {
    Object.assign(lastModelDecision, { provider, model, direct: false, source: "no-route", mode });
    return false;
  }
  const base = config.autoDetectMultimodal
    ? await routeDeclaresImage(llm, provider, model)
    : false;
  // `off` means the list carries no opinion at all — it is not "empty list
  // under whitelist", it is "no list semantics", so nothing is forced.
  const listed = mode !== "off" && modelListMatches(config.multimodalModels, provider, model);
  let direct = base;
  let source = base ? "auto" : "default";
  if (listed) {
    direct = mode !== "blacklist";
    source = mode === "blacklist" ? "blacklist" : "whitelist";
  }
  Object.assign(lastModelDecision, { provider, model, direct, source, mode });
  return direct;
}

/**
 * Lazily bridge image blocks that are already part of the session log
 * (pasted before the plugin was active, or before a restart). Each affected
 * event is rewritten once with a surface `replace`, which swaps the durable
 * derivation (and the transcript) to the text hint. Events that are no
 * longer on the surface (already shadowed) are skipped and remembered.
 * `repaired` tracks per-session state: a `Set` of handled seqs plus a
 * monotonic scan cursor.
 */
async function repairLoggedImages(ctx, session, exportDir, repaired) {
  const events = session.events;
  for (let index = repaired.cursor; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "user/message" || repaired.set.has(event.seq)) {
      repaired.set.add(event.seq);
      continue;
    }
    const content = event.data?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === "image")) {
      repaired.set.add(event.seq);
      continue;
    }
    const [bridged] = await bridgeMessages([event.data], ctx, exportDir);
    try {
      session.append("user/message", bridged, {
        surfaceOp: { op: "replace", start: event.seq, end: event.seq },
        sourceEventSeqs: [event.seq],
      });
      ctx.logger.info(`[tool-vision] bridged logged image at seq ${event.seq} (${session.id})`);
    } catch (error) {
      ctx.logger.debug(`[tool-vision] skip repair of seq ${event.seq}: ${String(error)}`);
    }
    repaired.set.add(event.seq);
  }
  repaired.cursor = events.length;
}

/**
 * Install the pre-step bridge at the root level. Agent-scoped waterfalls
 * admit untagged (root) listeners, so one listener serves every agent —
 * including sessions resumed after a server restart, which never re-fire
 * `session/created` for per-agent attachments. Runs before every proposed
 * step: new pasted images are bridged into the durable log, and stuck
 * logged images are repaired, before the model request is derived from it.
 */
function attachPreStepBridge(ctx, getConfig, exportDir) {
  const repairedBySession = new Map();
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (!agent?.session) return decision;
    try {
      const acceptsImage = await currentModelAcceptsImage(agent, getConfig(), ctx.get("llm"));
      warnAutoPromotion(ctx.logger);
      if (!acceptsImage) {
        let repaired = repairedBySession.get(agent.session.id);
        if (!repaired) {
          repaired = { set: new Set(), cursor: 0 };
          repairedBySession.set(agent.session.id, repaired);
        }
        await repairLoggedImages(ctx, agent.session, exportDir, repaired).catch((error) => {
          ctx.logger.warn(`[tool-vision] logged-image repair failed: ${String(error)}`);
        });
      }
      if (acceptsImage) return decision;
      const messages = await bridgeMessages(decision.messages, ctx, exportDir);
      if (messages.every((message, index) => message === decision.messages[index])) return decision;
      return { ...decision, messages };
    } catch (error) {
      ctx.logger.warn(`[tool-vision] pre-step bridge failed: ${String(error)}`);
      return decision;
    }
  });
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
async function callVision(config, imageUrl, question, detail, signal, exec) {
  const key = resolveApiKey(config);
  if (!key) {
    throw new Error(
      `vision API key missing: set the plugin config (apiKey / apiKeyEnv) or the OPENAI_API_KEY environment variable`,
    );
  }
  const base = config.baseURL.endsWith("/") ? config.baseURL : `${config.baseURL}/`;
  const endpoint = new URL("chat/completions", base);
  const sessionHeader = sessionHeaders(config, exec);
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
        ...sessionHeader,
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
    // Reasoning models (mimo-v2.5, deepseek-r1, ...) spend the token budget on
    // `reasoning_content` first; when the final `content` is empty or was cut
    // off by max_tokens, fall back to the reasoning text so the answer is
    // still useful.
    const message = body?.choices?.[0]?.message;
    let answer = message?.content ?? "";
    if (!answer.trim()) answer = message?.reasoning_content ?? "";
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
  // ── settings-backed configuration ─────────────────────────────────────────
  // The composition entry stays the `base` layer; a registered `tool-vision`
  // settings section (Web UI section, settings.yaml) overlays it live, so
  // edits hot-apply without a restart. `sourceGetter` is a GETTER
  // (`() => scope.get()`), not the config object — keep it and call it at use
  // time, or `getConfig()` would return a function and every `cfg.*` read
  // would be undefined (apiKey included).
  let current = config;
  let sourceGetter = null;
  const getConfig = () => (sourceGetter ? sourceGetter() : current);

  // ── master switch: a child fiber owns every registration ──────────────────
  // `ctx.tools.register`, `ctx.effect` and `ctx.on` are all effects on the fiber
  // that makes them, so confining the tool/bridge/route registrations to a child
  // fiber makes `enabled` real: disposing that fiber unregisters all 15 tools,
  // removes the pre-step listener and the preview route, and restores the llm
  // capability wrap. The settings registration deliberately stays on the parent
  // fiber — it has to outlive the switch, or the section that turns the plugin
  // back on would vanish with it.
  const REGISTRATION_KEYS = [
    "enabled",
    "bridgeTextOnly",
    "bridgeExportDir",
    "bridgeAutoImage",
    "bridgePreview",
  ];
  let featureFiber = null;
  let lastRegistrationKey = null;

  function registrationKey(cfg) {
    return REGISTRATION_KEYS.map((key) => String(cfg[key])).join("|");
  }

  function installFeatures() {
    if (featureFiber !== null) return;
    featureFiber = ctx.plugin({
      name: "dsh-tool-vision:features",
      apply(inner) {
        // ── image bridge: pasted images become inspect_image hints on text-only models ──
        if (getConfig().bridgeTextOnly) {
          const exportDir = getConfig().bridgeExportDir || join(os.tmpdir(), "dsh-vision-bridge");
          mkdir(exportDir, { recursive: true }).catch(() => {});
          // Root-level listener: agent-scoped waterfalls admit untagged listeners,
          // so one registration serves every agent (new and resumed alike) and the
          // agent is read from the fused payload.
          attachPreStepBridge(inner, getConfig, exportDir);

          // ── automatic image admission: let pasted images through on text-only models ──
          // The host gate refuses images unless the model declares `image` input;
          // the bridge handles them anyway, so report image support for all models.
          // The wrap is installed on the shared llm service instance (idempotent,
          // restored on dispose/HMR).
          if (getConfig().bridgeAutoImage) {
            const unwrap = installAutoImageAdmission(inner.get("llm"), inner.logger);
            inner.effect(() => unwrap, "dsh-tool-vision: automatic image admission");
          }

          // ── bridge image preview: same-origin thumbnails for bridged images ──
          if (getConfig().bridgePreview) {
            registerBridgePreviewRoute(inner, exportDir, inner.logger);
          }
        }

        inner.tools.register(defineTool({
          name: "inspect_image",
          description: getConfig().description,
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
            const cfg = getConfig();
            const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
            const { url, note } = await toImageUrl(args.path, cwd, cfg);
            try {
              const answer = await callVision(cfg, url, args.question, args.detail, exec.signal, exec);
              return note === url ? answer : `${answer}\n\n(image: ${note})`;
            } catch (error) {
              const raw = error && error.message ? String(error.message) : String(error);
              if (CONTENT_FILTER_RE.test(raw)) {
                throw new Error(
                  "inspect_image: 图片被视觉端点的内容安全策略拒绝(检测到敏感或不安全内容)。" +
                    "这不是网络或配置问题,请换一张图片或调整图片内容后再试。",
                );
              }
              throw error;
            }
          },
        }));

        // ── pixel-level vision tools (ported from dsh-vision-router) ─────────────
        // 14 vision_* tools driven by the SAME configured endpoint as inspect_image
        // (baseURL/apiKey/model). No provider chain, no local models, no extra
        // settings: everything comes from the existing tool-vision configuration.
              registerVisionTools(inner, getConfig);
      },
    });
  }

  function uninstallFeatures() {
    if (featureFiber === null) return;
    const fiber = featureFiber;
    featureFiber = null;
    // dispose() settles asynchronously and must never take the plugin down; the
    // next install starts a fresh fiber regardless of how this one ends.
    Promise.resolve(fiber.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[tool-vision] feature teardown failed: ${String(error)}`);
    });
  }

  // Re-install only when a field that gates a registration actually changed, so
  // editing, say, `model` does not tear the tools down and back up mid-session.
  function syncFeatures() {
    const cfg = getConfig();
    const key = registrationKey(cfg);
    if (featureFiber !== null && key === lastRegistrationKey) return;
    uninstallFeatures();
    lastRegistrationKey = key;
    if (cfg.enabled) installFeatures();
  }

  // Compat shim: dsh-settings 0.1.2-rc.1 removed the module-level
  // `installSettingsSection` export (the provider now lives at ctx.settings).
  // Inline the same logic via ctx.inject(["settings"]) — works on both
  // 0.1.1 (module export wrapper) and 0.1.2 (ctx.settings) hosts.
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(NS, Config, { base: config });
    sourceGetter = () => scope.get();
    sctx.effect(() => () => {
      sourceGetter = null;
    });
    // Hot-apply: `enabled` switches the child fiber, and any field that gates a
    // registration re-installs it, so none of them needs a dsh restart anymore.
    scope.watch(() => syncFeatures());
    sctx.effect(() => () => uninstallFeatures());
    // The stored value governs from here on; the composition entry was only a
    // placeholder until the provider answered.
    syncFeatures();
  });

  // ── model catalog route: settings support, so it lives on THIS fiber ───────
  // The master switch disposes the feature fiber on purpose (tools, bridge,
  // preview route), while the settings section itself deliberately stays
  // mounted — and a section whose list field cannot autocomplete is a section
  // you cannot configure before switching the plugin on. Registered here so it
  // outlives `enabled: false`; read-only and secret-free by construction.
  registerModelCatalogRoute(ctx, ctx.logger, getConfig);

  // No settings provider: the composition entry is the whole configuration.
  syncFeatures();
}

export {
  BRIDGE_MARKER,
  BRIDGE_PREVIEW_MAX_BYTES,
  BRIDGE_PREVIEW_MEDIA,
  BRIDGE_PREVIEW_ROUTE,
  Config,
  DEFAULT_DESCRIPTION,
  DEFAULT_MULTIMODAL_LIST_MODE,
  EXT_BY_MEDIA,
  MODEL_CATALOG_MAX_PER_PROVIDER,
  MODEL_CATALOG_ROUTE,
  MULTIMODAL_LIST_MODES,
  apply,
  attachPreStepBridge,
  autoPromotionWarned,
  bridgeMessages,
  currentModelAcceptsImage,
  currentRoute,
  deepFreeze,
  exportImage,
  hasImageBlock,
  inject,
  installAutoImageAdmission,
  lastModelDecision,
  modelListMatches,
  modelListMatchEntries,
  name,
  normalizeListMode,
  parseQuery,
  registerBridgePreviewRoute,
  registerModelCatalogRoute,
  repairLoggedImages,
  routeDeclaresImage,
  unwrappedResolveModelInfo,
  warnAutoPromotion,
};

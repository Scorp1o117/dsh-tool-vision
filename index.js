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
import { probeModelCapability, PROBE_MAX_TOKENS, PROBE_TIMEOUT_MS } from "./lib/model-probe.js";

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
  /**
   * Measured image capability per route (v0.9.0), keyed `"provider/model"` with
   * the value `"yes"` or `"no"`. Written by the `vision_probe_model` tool,
   * never by hand — the only entry in this schema that records what a route
   * DOES rather than what it says.
   *
   * It outranks the route's own declaration, because a probe is a real request
   * and a declaration is only a claim. It does NOT outrank `multimodalModels`:
   * that list is explicit human intent, and a person who names a model
   * deserves the last word over an automated measurement.
   */
  probeResults: z.dict(z.string()).default({}),
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
 * Admission is not dispatch, and only dispatch decides whether the pixels arrive.
 *
 * {@link installAutoImageAdmission} wraps `llm.resolveModelInfo`. That method
 * governs who may *offer* an image — the host gate that refuses a pasted image,
 * the model list, the settings readout — and it is deliberately "pure admission:
 * it never changes what the adapter actually streams".
 *
 * What the adapter actually streams is decided one layer down, by
 * `LlmService.generate`:
 *
 *     const adapterCall = await adapter.prepareCall(provider, model, signal);
 *     modelInfo = this.normalizeModelInfo(registration, model, adapterCall.model);
 *     if (modelInfo.inputModalities !== undefined
 *         && !modelInfo.inputModalities.includes("image")
 *         && projectedMessages.some((message) => contentHasImage(message.content)))
 *       projectedMessages = projectImagesForTextModel(projectedMessages);
 *
 * When that list lacks `image`, every image block is rewritten into a text
 * placeholder (`textOnlyImageText`) *before the adapter is called*. So on a
 * route the plugin had already measured as image-capable, and whose bridge
 * decision was therefore "direct, do not intercept", the image was still
 * destroyed — by a check that reads the adapter's declaration and nothing else.
 * `probeResults`, `multimodalModels` and `autoDetectMultimodal` were all
 * invisible to it.
 *
 * This wraps `llm.registration` — the accessor the core itself calls — so every
 * adapter, including one registered later, answers `prepareCall` through
 * {@link routeDirectDecision}: the same rule the bridge uses, so the two can
 * never disagree about a route.
 *
 * When the decision is "bridge", nothing changes: the bridge already turned the
 * image into an `inspect_image` hint, and the core's projection stays as the
 * correct fallback for any image that still reaches dispatch.
 *
 * Idempotent across HMR re-applies, and dispose restores every adapter it
 * touched plus the accessor itself.
 */
const LLM_REGISTRATION_WRAP_MARK = Symbol("dsh-tool-vision.registration.wrapped");
function installDispatchImageAdmission(llm, getConfig, logger) {
  if (llm === undefined || llm === null || typeof llm.registration !== "function") {
    logger?.warn?.("[tool-vision] llm service unavailable; dispatch image admission not installed");
    return () => {};
  }
  if (llm[LLM_REGISTRATION_WRAP_MARK]) return () => {}; // already wrapped by us (HMR re-apply)
  const original = llm.registration.bind(llm);
  /** adapter -> { prepareCall, modelOf } original methods, for dispose. */
  const patched = new Map();
  /** Set of arrays where we pushed "image", for cleanup on dispose. */
  const modifiedInputs = new Set();
  /** Keyed routes (probeKey) known to have direct dispatch permission. */
  const directRouteCache = new Set();

  const wrapped = (provider) => {
    const registration = original(provider);
    const adapter = registration?.adapter;
    if (adapter !== undefined && adapter !== null
        && !patched.has(adapter) && typeof adapter.prepareCall === "function") {
      const rawPrepare = adapter.prepareCall;
      const rawModelOf = typeof adapter.modelOf === "function" ? adapter.modelOf : undefined;
      const prepare = rawPrepare.bind(adapter);

      if (rawModelOf !== undefined) {
        adapter.modelOf = function (snapshot, route, model) {
          const resolved = rawModelOf.call(this, snapshot, route, model);
          if (resolved !== undefined && resolved !== null
              && Array.isArray(resolved.input) && !resolved.input.includes("image")
              && directRouteCache.has(probeKey(route, model))) {
            return { ...resolved, input: [...resolved.input, "image"] };
          }
          return resolved;
        };
      }

      adapter.prepareCall = async (route, model, signal) => {
        const call = await prepare(route, model, signal);
        if (call === undefined || call === null || call.model === undefined || call.model === null) return call;
        const mods = call.model.inputModalities;
        if (Array.isArray(mods) && mods.includes("image")) return call;
        let direct = false;
        try {
          ({ direct } = await routeDirectDecision(route, model, getConfig(), llm));
        } catch {
          // A decision that cannot be made is not a licence to send pixels a
          // route may reject: leave the core's projection in place.
          return call;
        }
        if (!direct) {
          directRouteCache.delete(probeKey(route, model));
          return call;
        }
        directRouteCache.add(probeKey(route, model));

        // In dsh-llm-pi-ai, adapter.streamWithSnapshot checks:
        // if (containsImage && !model.input.includes("image")) throw LlmError(...)
        // where model is obtained via this.modelOf(snapshot, provider, model) -> snapshot.models.getModel(route, model).
        // Ensure that the adapter snapshot's model also admits images so the adapter-level guard passes.
        try {
          const snapshot = typeof adapter.current === "function" ? adapter.current() : undefined;
          const targetModel = snapshot?.models?.getModel?.(route, model);
          if (targetModel !== undefined && targetModel !== null
              && Array.isArray(targetModel.input) && !targetModel.input.includes("image")) {
            targetModel.input.push("image");
            modifiedInputs.add(targetModel.input);
          }
        } catch {
          /* best-effort */
        }

        return { ...call, model: { ...call.model, inputModalities: [...(mods ?? []), "image"] } };
      };
      patched.set(adapter, { prepareCall: rawPrepare, modelOf: rawModelOf });
    }
    return registration;
  };
  llm[LLM_REGISTRATION_WRAP_MARK] = { original, wrapped };
  llm.registration = wrapped;
  logger?.debug?.("[tool-vision] dispatch image admission installed (llm.registration wrapped)");
  return () => {
    for (const [adapter, originalMethods] of patched) {
      if (typeof originalMethods.prepareCall === "function") adapter.prepareCall = originalMethods.prepareCall;
      if (typeof originalMethods.modelOf === "function") adapter.modelOf = originalMethods.modelOf;
    }
    patched.clear();
    for (const arr of modifiedInputs) {
      const idx = arr.indexOf("image");
      if (idx !== -1) arr.splice(idx, 1);
    }
    modifiedInputs.clear();
    directRouteCache.clear();
    if (llm.registration === wrapped) llm.registration = original;
    delete llm[LLM_REGISTRATION_WRAP_MARK];
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
              // What the route was MEASURED doing, when anyone has probed it.
              // `null` means "not probed", which the panel must render
              // differently from a probe that came back negative.
              probe: probeVerdict(cfg, id, modelId) ?? null,
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
        probeResults: typeof getConfig === "function" ? { ...(getConfig()?.probeResults ?? {}) } : {},
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

/** Registry key for one measured route. Provider-qualified: the same model id
 * can be served by two gateways with different real capabilities. */
function probeKey(provider, model) {
  return `${typeof provider === "string" ? provider : ""}/${model}`;
}

/**
 * The measured verdict for a route, or `undefined` when it was never probed.
 * Anything other than the two recorded values (a hand-edited settings.yaml, a
 * future format) reads as "not probed" rather than as a guess.
 */
function probeVerdict(config, provider, model) {
  const results = config?.probeResults;
  if (results === undefined || results === null || typeof model !== "string" || model.length === 0) {
    return undefined;
  }
  const value = results[probeKey(provider, model)];
  return value === "yes" || value === "no" ? value : undefined;
}

/**
 * Resolve the endpoint and credential a route actually sends to, so a probe
 * talks to the same place the model does instead of a copy of it.
 *
 * The pieces come from two seams that a plugin is allowed to read:
 *  - `llm.listConfigurableProviders()` names the settings namespace and the
 *    path a provider's profile lives at;
 *  - `settings.get(ns)` resolves that profile (`baseURL`, `apiKeyEnv`, `api`);
 *  - `credentials.resolve(ref)` turns `apiKeyEnv` into the secret itself
 *    (`.value`), the same way `dsh-llm-pi-ai` does it for a real call.
 *
 * Read-only, and the secret never leaves this function's caller: the probe
 * result records a verdict, never an endpoint or a key.
 *
 * @throws {Error} with a caller-facing reason when the route is unprobeable.
 */
async function resolveProbeTarget(ctx, provider, model) {
  const llm = ctx.get("llm");
  const settings = ctx.get("settings");
  const credentials = ctx.get("credentials");
  if (settings === undefined) {
    throw new Error("the settings service is unavailable, so the route's endpoint cannot be read");
  }
  let entry;
  try {
    entry = (llm?.listConfigurableProviders?.() ?? []).find((candidate) => candidate?.provider === provider);
  } catch {
    /* an adapter that cannot describe its providers simply has no entry */
  }
  const settingsNs = entry?.settingsNs;
  if (typeof settingsNs !== "string" || settingsNs.length === 0) {
    throw new Error(
      `provider "${provider}" does not publish a settings namespace, so its endpoint cannot be resolved for probing`,
    );
  }
  let profile = settings.get(settingsNs);
  const path = Array.isArray(entry.settingsPath) && entry.settingsPath.length > 0 ? entry.settingsPath : [provider];
  for (const segment of path) profile = profile?.[segment];
  if (profile === undefined || profile === null || typeof profile !== "object") {
    throw new Error(`no stored profile for provider "${provider}" under "${settingsNs}"`);
  }
  const baseURL = typeof profile.baseURL === "string" && profile.baseURL.length > 0 ? profile.baseURL : undefined;
  if (baseURL === undefined) {
    throw new Error(`provider "${provider}" has no baseURL, so its endpoint cannot be probed`);
  }
  let apiKey;
  const ref = profile.apiKeyEnv;
  if (typeof ref === "string" && ref.length > 0) {
    try {
      const record = await credentials?.resolve?.(ref);
      apiKey = typeof record?.value === "string" ? record.value : undefined;
    } catch (error) {
      throw new Error(`stored credential "${ref}" could not be read: ${String(error?.message ?? error)}`);
    }
  }
  return { baseURL, apiKey, api: profile.api, model };
}

/**
 * One-time notice when a route receives images directly *only* because of its
 * own declaration (source `auto`). This is the one failure auto-detection
 * cannot rule out: if the declaration is wrong, the endpoint rejects the image
 * after the message is already durable, and the error alone does not say what
 * to change. Naming the escape hatch the first time it happens turns a
 * confusing 400 into a one-line fix — and now names the probe too, which
 * settles the question instead of asking the user to guess.
 * Read {@link lastModelDecision}; never throws.
 */
function warnAutoPromotion(logger) {
  const { provider, model, direct, source } = lastModelDecision;
  if (direct !== true || source !== "auto" || typeof model !== "string" || model.length === 0) return;
  const key = `${typeof provider === "string" ? provider : ""}\u0000${model}`;
  if (autoPromotionWarned.has(key)) return;
  autoPromotionWarned.add(key);
  logger?.warn?.(
    `[tool-vision] "${model}" receives images directly because its route declares image input, ` +
    `which is unverified; run vision_probe_model to measure it, or list it in multimodalModels ` +
    `under multimodalListMode: blacklist to force the bridge`,
  );
}

/**
 * Whether images may be handed to this route directly, and why.
 *
 * The plugin's single precedence rule. Three inputs, deliberately independent:
 *
 *  - the base set — the route's own declared `inputModalities`, and only when
 *    `autoDetectMultimodal` is on. It is read through
 *    {@link unwrappedResolveModelInfo}, never through the admission wrap.
 *  - the measurement — `probeResults`, which outranks the declaration because a
 *    probe is a real request and a declaration is only a statement.
 *  - the list — `multimodalModels` under `multimodalListMode`. Explicit human
 *    intent, so it outranks both: whitelist adds to the base set, blacklist
 *    subtracts from it.
 *
 * Two callers need this exact answer and must never disagree:
 *  - {@link currentModelAcceptsImage} — the bridge, deciding whether to
 *    intercept an image at all;
 *  - {@link installDispatchImageAdmission} — the dispatch path, where the core
 *    independently decides whether the model may receive the image block.
 *
 * Returns `direct: true` when bridging is disabled (nothing would be bridged
 * anyway).
 */
async function routeDirectDecision(provider, model, config, llm) {
  const mode = normalizeListMode(config.multimodalListMode);
  if (!config.bridgeTextOnly) return { direct: true, source: "bridge-off", mode };
  if (typeof model !== "string" || model.length === 0) {
    return { direct: false, source: "no-route", mode };
  }
  const base = config.autoDetectMultimodal
    ? await routeDeclaresImage(llm, provider, model)
    : false;
  let direct = base;
  let source = base ? "auto" : "default";
  // A measured verdict outranks the route's own claim: a probe is a real
  // request, a declaration is only a statement. Both directions count, so a
  // route that says "image" and answered without reading the pixels goes back
  // to the bridge without anyone hunting for the right list entry.
  const probed = probeVerdict(config, provider, model);
  if (probed !== undefined) {
    direct = probed === "yes";
    source = probed === "yes" ? "probe-yes" : "probe-no";
  }
  // `off` means the list carries no opinion at all — it is not "empty list
  // under whitelist", it is "no list semantics", so nothing is forced. The
  // human list keeps the last word over both other signals.
  const listed = mode !== "off" && modelListMatches(config.multimodalModels, provider, model);
  if (listed) {
    direct = mode !== "blacklist";
    source = mode === "blacklist" ? "blacklist" : "whitelist";
  }
  return { direct, source, mode };
}

/**
 * Whether the session's current model may receive image blocks directly.
 *
 * {@link routeDirectDecision} keyed by the session's route, with the answer
 * recorded in {@link lastModelDecision} for the settings panel.
 */
async function currentModelAcceptsImage(agent, config, llm) {
  const { provider, model } = currentRoute(agent);
  const decision = await routeDirectDecision(provider, model, config, llm);
  Object.assign(lastModelDecision, { provider, model, ...decision });
  return decision.direct;
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
  // The registered settings scope, kept so tools can PERSIST what they measure.
  // Null whenever no settings provider is mounted (composition-entry-only runs),
  // in which case a probe still reports its verdict but cannot record it.
  let settingsScope = null;
  const getSettingsScope = () => settingsScope;

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

          // ── dispatch image admission: make the capability verdict actually land ──
          // `resolveModelInfo` above is pure admission — it never changes what
          // the adapter streams. The image the plugin decided to hand over
          // directly was still being projected into a text placeholder by
          // `LlmService.generate`, which reads the adapter's own declaration and
          // nothing else. This applies the same decision at that seam.
          //
          // Installed outside the `bridgeAutoImage` branch on purpose: the
          // question it answers is not "may the image be offered" but "does the
          // model receive it", and that is the plugin's own verdict either way.
          {
            const unwrapDispatch = installDispatchImageAdmission(inner.get("llm"), getConfig, inner.logger);
            inner.effect(() => unwrapDispatch, "dsh-tool-vision: dispatch image admission");
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

        // ── ground-truth capability probe (v0.9.0) ───────────────────────────
        // Everything else decides from what a route SAYS; this measures what it
        // DOES, and records the answer so the bridge decision stops guessing.
        inner.tools.register(defineTool({
          name: "vision_probe_model",
          description:
            "Measure whether a model's endpoint can actually read images, by sending it a real " +
            "solid-color image and checking the answer. Use this when a model's declared image " +
            "support is doubtful (it claims `image` but the provider may reject it, or it declares " +
            "text-only yet the endpoint may accept images). Runs a text-only control request plus " +
            "two different colors, so a model that merely guesses cannot pass. The verdict is " +
            "recorded and from then on decides whether that route's images are sent directly or " +
            "bridged. Costs a few requests against the model's own endpoint.",
          parameters: {
            model: {
              type: "string",
              required: true,
              description: "Model id to probe, e.g. xiaomi/mimo-v2.5. Use the id exactly as dsh has it configured.",
            },
            provider: {
              type: "string",
              description:
                "Provider route serving the model (e.g. commandcode). Omit to use the current " +
                "session's route, or to auto-select when exactly one provider offers the model.",
            },
          },
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          async execute(args, exec) {
            const cfg = getConfig();
            const requested = String(args.model ?? "").trim();
            if (requested.length === 0) throw new Error("vision_probe_model: model is required");
            const llm = inner.get("llm");

            // Resolve which routes offer this model, so an omitted `provider`
            // is still an exact choice rather than a guess.
            let candidates = [];
            try {
              for (const entry of llm?.listProviders?.() ?? []) {
                const id = entry?.id;
                if (typeof id !== "string") continue;
                const models = await llm.listModels(id).catch(() => []);
                if ((models ?? []).some((model) => String(model?.id) === requested)) candidates.push(id);
              }
            } catch {
              /* fall through to the route/argument fallbacks below */
            }
            let provider = typeof args.provider === "string" && args.provider.length > 0 ? args.provider : undefined;
            if (provider === undefined) {
              const here = currentRoute(exec?.agent);
              if (candidates.length === 1) provider = candidates[0];
              else if (here.model === requested && typeof here.provider === "string") provider = here.provider;
              else if (candidates.length > 1) {
                throw new Error(
                  `vision_probe_model: "${requested}" is served by ${candidates.join(", ")}; pass provider explicitly`,
                );
              } else {
                provider = here.provider;
              }
            }
            if (typeof provider !== "string" || provider.length === 0) {
              throw new Error(
                `vision_probe_model: cannot tell which provider serves "${requested}"; pass provider explicitly`,
              );
            }

            const target = await resolveProbeTarget(inner, provider, requested);
            const outcome = await probeModelCapability(
              {
                baseURL: target.baseURL,
                apiKey: target.apiKey,
                api: target.api,
                model: requested,
                maxTokens: PROBE_MAX_TOKENS,
                timeoutMs: Math.max(PROBE_TIMEOUT_MS, Number(cfg.timeoutMs) || 0),
                headers: sessionHeaders(cfg, exec),
              },
              exec.signal,
            );

            const key = probeKey(provider, requested);
            let recorded = "not recorded (no settings provider)";
            if (outcome.support === "yes" || outcome.support === "no") {
              const scope = getSettingsScope();
              if (scope !== null) {
                try {
                  await scope.update({ probeResults: { ...(cfg.probeResults ?? {}), [key]: outcome.support } });
                  recorded = `recorded as "${outcome.support}"`;
                } catch (error) {
                  recorded = `could not be recorded: ${String(error?.message ?? error)}`;
                }
              }
            }

            const verdictText = outcome.support === "yes"
              ? "SUPPORTS images"
              : outcome.support === "no"
                ? "does NOT read images"
                : "INCONCLUSIVE (the route could not be probed)";
            const effect = outcome.support === "yes"
              ? "images will be sent to it directly"
              : outcome.support === "no"
                ? "images will be bridged to inspect_image hints"
                : "the existing list/declaration rules still apply";
            const evidence = Object.entries(outcome.evidence ?? {})
              .map(([name, value]) => `  ${name}: ${value}`)
              .join("\n");
            return [
              `${provider}/${requested}: ${verdictText}`,
              `  ${outcome.detail}`,
              `  ${recorded}; ${effect}`,
              evidence ? `  evidence:\n${evidence}` : "",
            ].filter(Boolean).join("\n");
          },
        }));
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
    settingsScope = scope;
    sctx.effect(() => () => {
      sourceGetter = null;
      settingsScope = null;
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
  installDispatchImageAdmission,
  lastModelDecision,
  modelListMatches,
  modelListMatchEntries,
  name,
  normalizeListMode,
  parseQuery,
  probeKey,
  probeVerdict,
  registerBridgePreviewRoute,
  routeDirectDecision,
  registerModelCatalogRoute,
  repairLoggedImages,
  resolveProbeTarget,
  routeDeclaresImage,
  unwrappedResolveModelInfo,
  warnAutoPromotion,
};

// dsh-tool-vision — ground-truth multimodal probing.
//
// Everything else in this plugin decides whether a route can see images from
// what the route SAYS about itself (`inputModalities`, and the `multimodalModels`
// list a human maintains). A profile can claim `input: [text, image]` just to
// pass the host's admission gate, and the upstream comment in
// `dsh-llm-pi-ai` explains why that matters: over-claiming admits an image the
// provider rejects mid-turn, *after the message is already durable*.
//
// This module answers the question empirically instead: it sends a real image
// to the route's own endpoint and checks whether the model can actually read
// it. That makes it the only signal here that is not a declaration.
//
// Two design rules, both learned the hard way:
//
//   1. Never trust a single request. A model that cannot see will happily
//      answer "blue" to an orange square, and a reasoning model will return an
//      EMPTY `content` when `max_tokens` is too small to finish thinking. So
//      every probe runs a text-only CONTROL first (is this route even usable?)
//      and then TWO different colors, and only a model that gets both right is
//      reported as supporting images.
//   2. Never turn an infrastructure failure into a capability verdict. A 429,
//      a timeout or a dead gateway is `unknown`, not "cannot see images".
//
// `verdict` is therefore one of:
//   - "yes"     — the control passed and both colors were read correctly.
//   - "no"      — the endpoint rejected the image part, or answered without
//                 reading it (both colors wrong).
//   - "unknown" — the route could not be probed (network, auth, protocol).

import zlib from "node:zlib";

/** Probe image edge length; tiny on purpose — the query is one flat color. */
export const PROBE_IMAGE_SIZE = 32;
/**
 * Output budget for each probe request. Reasoning models spend this before
 * emitting any `content`, and an exhausted budget yields an empty answer that
 * would otherwise be misread as "cannot see the image".
 */
export const PROBE_MAX_TOKENS = 2048;
/** Per-request timeout for a probe (a probe is interactive; it must not hang). */
export const PROBE_TIMEOUT_MS = 60000;
/** Largest response body accepted, so a hostile endpoint cannot exhaust memory. */
export const PROBE_MAX_BODY_BYTES = 1024 * 1024;

/** The two flat colors a probe distinguishes; `accept` is matched against the answer. */
export const PROBE_COLORS = {
  orange: { rgb: [230, 120, 30], accept: /\borange\b/i },
  blue: { rgb: [30, 90, 230], accept: /\bblue\b/i },
};

/** The question asked for every image probe. One flat color, one word back. */
export const PROBE_QUESTION = "What color is this image? Answer with one word.";

/** Text-only control question; expected answer is compared case-insensitively. */
export const PROBE_CONTROL_QUESTION = "Reply with the single word: ok";
export const PROBE_CONTROL_ACCEPT = /\bok\b/i;

/**
 * Endpoint errors that mean "this model does not take image parts" rather than
 * "something went wrong just now". Only these turn into a negative verdict.
 */
const UNSUPPORTED_IMAGE_RE =
  /does not support image|image input|unsupported content|unsupported_content|invalid content type|image_url|not a vision|vision.{0,12}not support|multimodal.{0,12}not/i;

// ── a minimal PNG encoder (no dependencies) ─────────────────────────────────

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const tag = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}

/**
 * Encode a solid-color RGB PNG. Hand-rolled so the plugin keeps zero image
 * dependencies on the server half.
 *
 * @param {readonly [number, number, number]} rgb - the fill color.
 * @param {number} [size] - edge length in pixels.
 * @returns {Buffer} PNG bytes.
 */
export function makeSolidPng(rgb, size = PROBE_IMAGE_SIZE) {
  const [red, green, blue] = rgb;
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A `data:` URL for one solid color. */
export function solidColorDataUrl(rgb, size = PROBE_IMAGE_SIZE) {
  return `data:image/png;base64,${makeSolidPng(rgb, size).toString("base64")}`;
}

// ── the call itself ─────────────────────────────────────────────────────────

/** Pull the answer text out of an OpenAI-compatible response body. */
function readAnswer(body) {
  const message = body?.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (content) return content;
  // A reasoning model may leave `content` empty and put everything in
  // `reasoning_content`; either way the text is what we grade.
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  return reasoning;
}

/**
 * One `chat/completions` request against a route's own endpoint.
 *
 * @returns {Promise<{ok: true, answer: string} | {ok: false, status: number, message: string}>}
 *   `ok: false` with a status of 0 for a transport failure.
 */
async function probeRequest(target, content, fetchImpl, signal) {
  const base = target.baseURL.endsWith("/") ? target.baseURL : `${target.baseURL}/`;
  const endpoint = new URL("chat/completions", base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("probe request timed out")), target.timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        ...(target.headers ?? {}),
      },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content }],
        max_tokens: target.maxTokens,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > PROBE_MAX_BODY_BYTES) {
      return { ok: false, status: response.status, message: "probe response body too large" };
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: String(body?.error?.message ?? body?.message ?? response.statusText ?? text.slice(0, 200)),
      };
    }
    return { ok: true, answer: readAnswer(body) };
  } catch (error) {
    return { ok: false, status: 0, message: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Probe one route for real image support.
 *
 * Control first, then two colors. BOTH colors must be read correctly, so a
 * model that guesses cannot pass: the two questions are identical and only the
 * pixels differ.
 *
 * @param {object} target - `{baseURL, apiKey, model, api, timeoutMs, maxTokens, fetchImpl, headers}`.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{support: 'yes'|'no'|'unknown', detail: string, evidence: object}>}
 */
export async function probeModelCapability(target, signal) {
  const fetchImpl = target.fetchImpl ?? fetch;
  const api = target.api;
  if (api !== undefined && api !== null && api !== "openai-completions") {
    // `openai-responses` and friends speak a different wire format; probing
    // them with chat/completions would produce a confident wrong answer.
    return {
      support: "unknown",
      detail: `route protocol "${api}" is not probeable with chat/completions`,
      evidence: {},
    };
  }
  if (typeof target.baseURL !== "string" || target.baseURL.length === 0) {
    return { support: "unknown", detail: "the route has no baseURL", evidence: {} };
  }

  const control = await probeRequest(target, PROBE_CONTROL_QUESTION, fetchImpl, signal);
  const controlAnswer = control.ok ? control.answer : "";
  const controlPassed = control.ok && PROBE_CONTROL_ACCEPT.test(controlAnswer);
  if (!controlPassed) {
    // The route itself is unusable (bad key, dead gateway, empty answer at a
    // workable token budget). That says nothing about image support.
    return {
      support: "unknown",
      detail: control.ok
        ? `control request returned an unusable answer (${controlAnswer.slice(0, 60) || "empty"})`
        : `control request failed with ${control.status || "a transport error"}: ${control.message}`,
      evidence: { control: control.ok ? controlAnswer.slice(0, 120) : control.message },
    };
  }

  const answers = {};
  for (const [name, spec] of Object.entries(PROBE_COLORS)) {
    const result = await probeRequest(target, [
      { type: "text", text: PROBE_QUESTION },
      { type: "image_url", image_url: { url: solidColorDataUrl(spec.rgb) } },
    ], fetchImpl, signal);
    if (!result.ok) {
      if (UNSUPPORTED_IMAGE_RE.test(result.message)) {
        return {
          support: "no",
          detail: `the endpoint rejected the image part (${result.status}): ${result.message}`,
          evidence: { control: controlAnswer.slice(0, 120), answers },
        };
      }
      return {
        support: "unknown",
        detail: `image request failed with ${result.status || "a transport error"}: ${result.message}`,
        evidence: { control: controlAnswer.slice(0, 120), answers },
      };
    }
    answers[name] = result.answer.slice(0, 120);
  }

  const correct = Object.entries(PROBE_COLORS).filter(([name, spec]) => spec.accept.test(answers[name] ?? ""));
  if (correct.length === Object.keys(PROBE_COLORS).length) {
    return {
      support: "yes",
      detail: `read both probe colors correctly (${Object.keys(PROBE_COLORS).join(", ")})`,
      evidence: { control: controlAnswer.slice(0, 120), answers },
    };
  }
  return {
    support: "no",
    detail: correct.length === 0
      ? "the endpoint answered both image requests without identifying either color"
      : `the endpoint identified only ${correct.length}/${Object.keys(PROBE_COLORS).length} probe colors`,
    evidence: { control: controlAnswer.slice(0, 120), answers },
  };
}

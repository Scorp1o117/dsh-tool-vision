// dsh-tool-vision — x-opencode-session request header helper.
//
// OpenCode Go (and other OpenAI-compatible gateways) ask clients to tag every
// request with a stable per-conversation identifier so they can attribute and
// optimize the service. Requests without the header started erroring after
// 2026-09-06.
//
// This module centralizes how the plugin picks that identifier:
//
//   1. A real dsh session id, when the tool call runs inside one
//      (`exec.agent?.session?.id`, or the same id on the exec context).
//      This is the ideal "one stable ID per conversation".
//   2. Otherwise the configured `sessionId` (a fixed override the user can
//      set in the settings panel, useful for background/standalone callers).
//   3. Otherwise a per-process random id, generated once. Stable for the
//      lifetime of the plugin process, so every untagged background call
//      from this instance still shares one stable id.

import { randomUUID } from 'node:crypto'

export const DEFAULT_SESSION_HEADER = 'x-opencode-session'

let fallbackId = ''
function getFallbackId() {
  if (!fallbackId) fallbackId = `dsh-vision-${randomUUID()}`
  return fallbackId
}

/**
 * Pick a stable per-conversation id for the outgoing vision request.
 *
 * @param {object} cfg live tool-vision config (may carry `sessionId`).
 * @param {object|undefined} exec tool execution context, when available.
 * @returns {string|undefined} the id to send, or undefined if header disabled.
 */
export function resolveSessionId(cfg, exec) {
  if (cfg?.sendSessionHeader === false) return undefined
  // Prefer an explicit, stable configured id when the user set one.
  if (cfg?.sessionId) return String(cfg.sessionId)
  // Real conversation id from the tool execution context, when present.
  const agentSessionId =
    exec?.agent?.session?.id ??
    exec?.session?.id ??
    exec?.sessionId ??
    exec?.agent?.session?.header?.sessionId
  if (agentSessionId) return String(agentSessionId)
  // Background / untagged call: one stable id per plugin process.
  return getFallbackId()
}

/** Build the header object to merge into a vision request's headers. */
export function sessionHeaders(cfg, exec) {
  const id = resolveSessionId(cfg, exec)
  if (!id) return {}
  const headerName = cfg?.sessionHeaderName || DEFAULT_SESSION_HEADER
  return { [headerName]: id }
}

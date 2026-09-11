/**
 * dsh-tool-vision — capability probe tests (v0.9.0).
 *
 * The probe is the only signal in this plugin that is a measurement rather
 * than a declaration, so its failure modes matter more than its happy path:
 *
 *  - a model that GUESSES must not be reported as multimodal (hence two colors
 *    and a control group);
 *  - an infrastructure failure (401/429/timeout/5xx) must be `unknown`, never
 *    "cannot see images" — that verdict would silently push a working
 *    multimodal route back onto the bridge forever;
 *  - only an endpoint that actually rejects the image part may report `no`.
 *
 * Every case drives the real `probeModelCapability` against a scripted fetch.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROBE_MAX_TOKENS,
  PROBE_TIMEOUT_MS,
  makeSolidPng,
  probeModelCapability,
  solidColorDataUrl,
} from '../lib/model-probe.js'

const TARGET = { baseURL: 'https://gateway.example/v1', apiKey: 'test-key', model: 'm', api: 'openai-completions' }

/** Build a fetch stub from a list of scripted responses, recording the calls. */
function scriptedFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), body, headers: init.headers })
    const scripted = handler(body, calls.length)
    if (scripted instanceof Error) throw scripted
    const { status = 200, payload } = scripted
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }
  }
  return { fetchImpl, calls }
}

const answer = (text) => ({ payload: { choices: [{ message: { content: text } }] } })
const hasImagePart = (body) => JSON.stringify(body.messages).includes('image_url')

test('the PNG encoder emits a real, decodable image', () => {
  const png = makeSolidPng([230, 120, 30])
  assert.ok(Buffer.isBuffer(png))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR')
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND')
  // IEND carries a CRC, so a bad one would still read as "IEND" text; the
  // signature + a valid deflate stream is the stronger claim.
  const url = solidColorDataUrl([30, 90, 230])
  assert.match(url, /^data:image\/png;base64,/)
  assert.notEqual(url, solidColorDataUrl([230, 120, 30]), 'different colors must produce different bytes')
})

test('a model that really reads both colors is "yes"', async () => {
  const { fetchImpl, calls } = scriptedFetch((body) => (hasImagePart(body) ? answer('Blue') : answer('ok')))
  // The stub must answer per-color, so drive it by the payload, not a counter.
  const byColor = scriptedFetch((body) => {
    if (!hasImagePart(body)) return answer('ok')
    return answer(body.messages[0].content[1].image_url.url === solidColorDataUrl([230, 120, 30]) ? 'Orange' : 'Blue')
  })
  const result = await probeModelCapability({ ...TARGET, fetchImpl: byColor.fetchImpl })
  assert.equal(result.support, 'yes')
  assert.match(result.detail, /both probe colors/)
  assert.deepEqual(Object.keys(result.evidence.answers).sort(), ['blue', 'orange'])
  // Sanity: the naive stub above would have failed, which is the point of
  // grading per color rather than on any single answer.
  const naive = await probeModelCapability({ ...TARGET, fetchImpl })
  assert.equal(naive.support, 'no', 'answering one color for both images is not image support')
  assert.equal(calls.length > 0, true)
})

test('a guessing model that cannot pass the control is unknown, not multimodal', async () => {
  const { fetchImpl } = scriptedFetch(() => answer('Blue'))
  const result = await probeModelCapability({ ...TARGET, fetchImpl })
  assert.equal(result.support, 'unknown', 'the control never passed, so nothing was measured')
  assert.match(result.detail, /control/)
})

test('a model that answers without reading the pixels is "no", with evidence', async () => {
  const { fetchImpl } = scriptedFetch((body) => (hasImagePart(body) ? answer('I cannot see any image.') : answer('ok')))
  const result = await probeModelCapability({ ...TARGET, fetchImpl })
  assert.equal(result.support, 'no')
  assert.match(result.detail, /without identifying|identified only/)
  assert.equal(result.evidence.answers.orange, 'I cannot see any image.')
})

test('an endpoint that rejects the image part is "no" — the only real negative', async () => {
  const { fetchImpl } = scriptedFetch((body) => (hasImagePart(body)
    ? { status: 400, payload: { error: { message: 'this model does not support image input' } } }
    : answer('ok')))
  const result = await probeModelCapability({ ...TARGET, fetchImpl })
  assert.equal(result.support, 'no')
  assert.match(result.detail, /rejected the image part/)
  assert.match(result.detail, /does not support image input/)
})

test('infrastructure failures are unknown, never a capability verdict', async () => {
  const cases = [
    ['auth', 401, 'invalid api key'],
    ['rate limit', 429, 'slow down'],
    ['server error', 500, 'boom'],
    ['gateway error', 502, 'bad gateway'],
  ]
  for (const [label, status, message] of cases) {
    const { fetchImpl } = scriptedFetch((body) => (hasImagePart(body)
      ? { status, payload: { error: { message } } }
      : answer('ok')))
    const result = await probeModelCapability({ ...TARGET, fetchImpl })
    assert.equal(result.support, 'unknown', `${label} must not be read as "cannot see images"`)
    assert.match(result.detail, /image request failed/)
  }
  const thrown = scriptedFetch((body) => (hasImagePart(body) ? new Error('socket hang up') : answer('ok')))
  const result = await probeModelCapability({ ...TARGET, fetchImpl: thrown.fetchImpl })
  assert.equal(result.support, 'unknown')
  assert.match(result.detail, /socket hang up/)
})

test('reasoning models are graded on reasoning_content too', async () => {
  // A reasoning route can leave `content` empty; an empty answer must not be
  // mistaken for "cannot see", so the probe falls back to the reasoning text.
  const { fetchImpl } = scriptedFetch((body) => {
    if (!hasImagePart(body)) return { payload: { choices: [{ message: { content: '', reasoning_content: 'ok' } }] } }
    const orange = body.messages[0].content[1].image_url.url === solidColorDataUrl([230, 120, 30])
    return { payload: { choices: [{ message: { content: '', reasoning_content: orange ? 'That is orange' : 'It is blue' } }] } }
  })
  const result = await probeModelCapability({ ...TARGET, fetchImpl })
  assert.equal(result.support, 'yes')
})

test('unprobeable routes say so instead of guessing', async () => {
  const { fetchImpl, calls } = scriptedFetch(() => answer('ok'))
  const responses = await probeModelCapability({ ...TARGET, api: 'openai-responses', fetchImpl })
  assert.equal(responses.support, 'unknown')
  assert.match(responses.detail, /not probeable/)
  assert.equal(calls.length, 0, 'a mismatched protocol must not send a chat/completions request')
  const noUrl = await probeModelCapability({ ...TARGET, baseURL: '', fetchImpl })
  assert.equal(noUrl.support, 'unknown')
  assert.match(noUrl.detail, /no baseURL/)
})

test('the request carries the credential and the configured budgets', async () => {
  const { fetchImpl, calls } = scriptedFetch((body) => (hasImagePart(body) ? answer('Orange') : answer('ok')))
  await probeModelCapability({ ...TARGET, timeoutMs: 1234, maxTokens: 77, fetchImpl })
  assert.equal(calls.length, 3, 'one control plus two colors')
  for (const call of calls) {
    assert.equal(call.url, 'https://gateway.example/v1/chat/completions')
    assert.equal(call.headers.Authorization, 'Bearer test-key')
    assert.equal(call.body.model, 'm')
    assert.equal(call.body.max_tokens, 77)
  }
  // The control is text-only; the other two carry exactly one image part.
  assert.equal(hasImagePart(calls[0].body), false)
  assert.equal(hasImagePart(calls[1].body), true)
  assert.equal(hasImagePart(calls[2].body), true)
  assert.ok(PROBE_MAX_TOKENS > 1000, 'the default budget must survive a reasoning model')
  assert.ok(PROBE_TIMEOUT_MS > 0)
})

test('a trailing slash on the base URL does not double up', async () => {
  const { fetchImpl, calls } = scriptedFetch((body) => (hasImagePart(body) ? answer('Orange') : answer('ok')))
  await probeModelCapability({ ...TARGET, baseURL: 'https://gateway.example/v1/', fetchImpl })
  assert.equal(calls[0].url, 'https://gateway.example/v1/chat/completions')
})

test('the probe never sends an image without asking first', async () => {
  // Cost guard: a route that fails its control must not also pay for two
  // image requests.
  const { fetchImpl, calls } = scriptedFetch(() => ({ status: 500, payload: { error: { message: 'boom' } } }))
  const result = await probeModelCapability({ ...TARGET, fetchImpl })
  assert.equal(result.support, 'unknown')
  assert.equal(calls.length, 1, 'control failure stops the probe')
})

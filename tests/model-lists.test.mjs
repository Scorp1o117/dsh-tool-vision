/**
 * dsh-tool-vision — model lists, auto-detection and the catalog route (v0.9.0).
 *
 * Drives the REAL exports (no mirror copies): the list matcher, the bridge
 * decision under every mode × auto-detect combination, the catalog route
 * handler, and the one property that makes the whole feature safe —
 * auto-detection must never read the admission wrap's own claim.
 *
 * Also pins backwards compatibility: with `multimodalListMode: "whitelist"`
 * and `autoDetectMultimodal: false` the decision must equal v0.8.1's
 * `multimodalModels.includes(model)` for every route shape.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Config,
  MODEL_CATALOG_ROUTE,
  MULTIMODAL_LIST_MODES,
  currentModelAcceptsImage,
  installAutoImageAdmission,
  lastModelDecision,
  modelListMatches,
  normalizeListMode,
  registerModelCatalogRoute,
  unwrappedResolveModelInfo,
} from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'index.js'), 'utf8')
const client = readFileSync(join(root, 'client.js'), 'utf8')

const cfg = (over = {}) => ({ ...Config({}), ...over })
const agent = (provider, model) => ({ session: { requestHeader: () => ({ config: { provider, model } }) } })
const llmDeclaring = (modalities) => ({
  resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: modalities }),
})

// ── schema + wiring ─────────────────────────────────────────────────────────
test('Config carries the v0.9.0 fields with backwards-compatible defaults', () => {
  assert.equal(Config.dict.multimodalListMode.meta.default, 'whitelist')
  assert.equal(Config.dict.autoDetectMultimodal.meta.default, false)
  assert.deepEqual(Config.dict.multimodalModels.meta.default, [])
  // The default pair must reproduce v0.8.1 exactly: no auto-detect, whitelist.
  assert.equal(normalizeListMode(Config({}).multimodalListMode), 'whitelist')
})

test('the catalog route is registered on the plugin fiber, not the feature fiber', () => {
  // A section whose list field cannot autocomplete while the switch is off
  // would be unconfigurable — the route must outlive `enabled: false`.
  assert.ok(server.includes(`const MODEL_CATALOG_ROUTE = "${MODEL_CATALOG_ROUTE}"`))
  assert.ok(server.includes('registerModelCatalogRoute(ctx, ctx.logger)'))
  assert.ok(!server.includes('registerModelCatalogRoute(inner'), 'must not live on the disposable feature fiber')
  const exportsBlock = server.split('export {')[1] ?? ''
  for (const name of ['registerModelCatalogRoute', 'modelListMatches', 'normalizeListMode', 'lastModelDecision']) {
    assert.ok(exportsBlock.includes(name), `${name} must be exported`)
  }
  // The pre-step bridge must hand the llm service to the decision, or
  // auto-detection is silently dead.
  assert.ok(server.includes('currentModelAcceptsImage(agent, getConfig(), ctx.get("llm"))'))
})

test('client.js exposes the new fields', () => {
  for (const key of ['multimodalListMode', 'autoDetectMultimodal', 'fieldMultimodalListMode', 'modeBlacklist']) {
    assert.ok(client.includes(key), `client.js must mention ${key}`)
  }
  assert.ok(client.includes('function setField') && client.includes('function buildOps'))
})

// ── list matching ───────────────────────────────────────────────────────────
test('modelListMatches: full, bare, provider-qualified and glob entries', () => {
  const m = 'xiaomi/mimo-v2.5'
  const cases = [
    [['xiaomi/mimo-v2.5'], true, 'full id'],
    [['mimo-v2.5'], true, 'bare id (what the README example used)'],
    [['commandcode/xiaomi/mimo-v2.5'], true, 'provider-qualified id'],
    [['MIMO-V2.5'], true, 'case-insensitive'],
    [['*mimo*'], true, 'glob anywhere'],
    [['xiaomi/*'], true, 'glob suffix'],
    [['mimo-v2.?'], true, 'single-char glob'],
    [['gpt-4o'], false, 'unrelated literal'],
    [['mimo-v2X5'], false, 'dots are literals, not wildcards'],
    [['xiaomi'], false, 'provider alone is not a model'],
    [[], false, 'empty list'],
    [['', '   '], false, 'blank entries'],
  ]
  for (const [patterns, want, label] of cases) {
    assert.equal(modelListMatches(patterns, 'commandcode', m), want, label)
  }
  assert.equal(modelListMatches(['*'], undefined, m), true, 'no provider needed')
  assert.equal(modelListMatches(['deepseek/*'], 'commandcode', 'deepseek/deepseek-v4.1-flash'), true)
  assert.equal(modelListMatches([null, undefined, 42], 'p', 'm'), false, 'junk entries never match')
  assert.equal(modelListMatches(['m'], 'p', ''), false, 'no model id, no match')
})

test('normalizeListMode clamps unknown values instead of silently disabling', () => {
  for (const mode of MULTIMODAL_LIST_MODES) assert.equal(normalizeListMode(mode), mode)
  for (const junk of ['', 'WHITELIST', 'none', undefined, null, 42, {}]) {
    assert.equal(normalizeListMode(junk), 'whitelist', `junk: ${String(junk)}`)
  }
})

// ── the decision matrix ─────────────────────────────────────────────────────
test('off mode: the list carries no opinion at all', async () => {
  const config = cfg({ multimodalListMode: 'off', multimodalModels: ['m'], autoDetectMultimodal: false })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config), false, 'listed but off → still bridged')
  const configAuto = cfg({ multimodalListMode: 'off', multimodalModels: [], autoDetectMultimodal: true })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), configAuto, llmDeclaring(['text', 'image'])), true)
})

test('whitelist mode adds to the detected base set', async () => {
  const llm = llmDeclaring(['text', 'image'])
  const config = cfg({ multimodalListMode: 'whitelist', multimodalModels: ['other'], autoDetectMultimodal: true })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, llm), true, 'detected, not listed')
  assert.equal(lastModelDecision.source, 'auto')
  const listed = cfg({ multimodalListMode: 'whitelist', multimodalModels: ['m'], autoDetectMultimodal: true })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), listed, llmDeclaring(['text'])), true, 'listed wins')
  assert.equal(lastModelDecision.source, 'whitelist')
})

test('blacklist mode subtracts from the detected base set', async () => {
  const llm = llmDeclaring(['text', 'image'])
  const config = cfg({ multimodalListMode: 'blacklist', multimodalModels: ['m'], autoDetectMultimodal: true })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, llm), false, 'the liar is bridged')
  assert.equal(lastModelDecision.source, 'blacklist')
  const clean = cfg({ multimodalListMode: 'blacklist', multimodalModels: ['*other*'], autoDetectMultimodal: true })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), clean, llm), true, 'unlisted still direct')
})

test('blacklist mode never means "everything is multimodal"', async () => {
  // The footgun this design exists to avoid: with auto-detect off the base set
  // is empty, so an unlisted model is BRIDGED, never sent a raw image.
  const config = cfg({ multimodalListMode: 'blacklist', multimodalModels: ['other'], autoDetectMultimodal: false })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, llmDeclaring(['text', 'image'])), false)
})

test('unresolvable routes and disabled bridging', async () => {
  const config = cfg({ multimodalListMode: 'whitelist', autoDetectMultimodal: true })
  assert.equal(await currentModelAcceptsImage(agent('p', undefined), config, llmDeclaring(['text', 'image'])), false)
  assert.equal(lastModelDecision.source, 'no-route')
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), cfg({ bridgeTextOnly: false }), undefined), true)
  assert.equal(lastModelDecision.source, 'bridge-off')
  // A throwing resolver is "unknown", and unknown is bridged.
  const throwing = { resolveModelInfo: async () => { throw new Error('boom') } }
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, throwing), false)
})

// ── the property the whole feature rests on ─────────────────────────────────
test('auto-detection reads BEFORE the admission wrap, never its own claim', async () => {
  const llm = llmDeclaring(['text'])
  const dispose = installAutoImageAdmission(llm)
  try {
    // Sanity: the wrap really does advertise image for every model.
    const advertised = await llm.resolveModelInfo('p', 'm')
    assert.ok(advertised.inputModalities.includes('image'), 'the wrap lies, as designed')
    assert.deepEqual(await unwrappedResolveModelInfo(llm)('p', 'm'), {
      provider: 'p', id: 'm', name: 'm', inputModalities: ['text'],
    })
    const config = cfg({ multimodalListMode: 'whitelist', multimodalModels: [], autoDetectMultimodal: true })
    assert.equal(
      await currentModelAcceptsImage(agent('p', 'm'), config, llm),
      false,
      'a text-only route must stay bridged even though the plugin claims otherwise',
    )
  } finally {
    dispose()
  }
})

test('unwrappedResolveModelInfo falls back to the live method when unwrapped', () => {
  const llm = llmDeclaring(['text'])
  assert.equal(typeof unwrappedResolveModelInfo(llm), 'function')
  assert.equal(unwrappedResolveModelInfo(undefined), undefined)
  assert.equal(unwrappedResolveModelInfo({}), undefined)
})

// ── v0.8.1 compatibility ────────────────────────────────────────────────────
test('default config never un-bridges anything v0.8.1 bridged', async () => {
  // Compatibility is one-directional on purpose. The new matcher is strictly
  // more permissive (bare ids, provider-qualified ids, globs), so no entry
  // that used to force a model direct may stop doing so — and nothing that
  // used to be bridged becomes direct except through the widening below.
  const legacy = (config, model) => config.multimodalModels.includes(model)
  const models = ['mimo-v2.5', 'xiaomi/mimo-v2.5', 'deepseek/deepseek-v4.1-flash', 'meituan/LongCat-2.0:free']
  const lists = [[], ['mimo-v2.5'], ['xiaomi/mimo-v2.5'], ['other'], ['deepseek/deepseek-v4.1-flash', 'mimo-v2.5']]
  for (const model of models) {
    for (const list of lists) {
      const config = cfg({ multimodalModels: list })
      const now = await currentModelAcceptsImage(agent('commandcode', model), config)
      if (legacy(config, model)) {
        assert.equal(now, true, `listed model ${model} must stay direct with ${JSON.stringify(list)}`)
      }
    }
  }
})

test('the one deliberate widening: a bare id now addresses the qualified route', async () => {
  const legacy = (config, model) => config.multimodalModels.includes(model)
  const config = cfg({ multimodalModels: ['mimo-v2.5'] })
  // v0.8.1 compared ids literally, so the README's own example silently did
  // nothing for a route spelled `xiaomi/mimo-v2.5`.
  assert.equal(legacy(config, 'xiaomi/mimo-v2.5'), false, 'this is the bug being fixed')
  assert.equal(await currentModelAcceptsImage(agent('commandcode', 'xiaomi/mimo-v2.5'), config), true)
  // The widening is narrow: it never makes an unlisted model direct.
  assert.equal(await currentModelAcceptsImage(agent('commandcode', 'xiaomi/other-vl'), config), false)
  assert.equal(await currentModelAcceptsImage(agent('commandcode', 'mimo-v2.5'), config), true)
})

// ── the catalog route ───────────────────────────────────────────────────────
function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers ?? null },
    end(body) { this.body = body ?? '' },
  }
}

function mountRoute({ llm, webServer, logger } = {}) {
  const routes = []
  const warnings = []
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'webServer') return webServer === null ? undefined : (webServer ?? { register(route) { routes.push(route); return () => {} } })
      return undefined
    },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    logger: logger ?? { warn: (m) => warnings.push(m), debug() {}, info() {} },
  }
  registerModelCatalogRoute(ctx, ctx.logger)
  return { route: routes[0], routes, warnings }
}

const happyLlm = {
  listProviders: () => [
    { id: 'commandcode', name: 'GOAT' },
    { id: 'broken', name: 'Broken' },
  ],
  listModels: async (provider) => {
    if (provider === 'broken') throw new Error('catalog exploded')
    return [
      { provider, id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5', inputModalities: ['text', 'image'] },
      { provider, id: 'meituan/LongCat-2.0:free', name: 'LongCat', inputModalities: ['text'] },
    ]
  },
}

test('catalog route returns the configured models with declared capabilities', async () => {
  const { route } = mountRoute({ llm: happyLlm })
  assert.ok(route, 'route must be registered')
  assert.equal(route.path, MODEL_CATALOG_ROUTE)
  const res = makeRes()
  await route.handler({ headers: { host: '127.0.0.1:3080' } }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /application\/json/)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload.providers.map((p) => p.id), ['commandcode', 'broken'])
  assert.deepEqual(payload.providers[0].models.map((m) => [m.id, m.image]), [
    ['xiaomi/mimo-v2.5', true],
    ['meituan/LongCat-2.0:free', false],
  ])
  assert.equal(payload.providers[0].name, 'GOAT')
  // One broken route degrades to an error note; the rest still autocomplete.
  assert.deepEqual(payload.providers[1].models, [])
  assert.match(payload.providers[1].error, /catalog exploded/)
  assert.ok('current' in payload, 'the panel reads the last decision from here')
})

test('catalog route mirrors the last decision and is loopback-only', async () => {
  await currentModelAcceptsImage(agent('commandcode', 'xiaomi/mimo-v2.5'), cfg({ multimodalModels: ['mimo-v2.5'] }))
  const { route } = mountRoute({ llm: happyLlm })
  const ok = makeRes()
  await route.handler({ headers: { host: '127.0.0.1:3080' } }, ok)
  const current = JSON.parse(ok.body).current
  assert.equal(current.model, 'xiaomi/mimo-v2.5')
  assert.equal(current.direct, true)
  assert.equal(current.source, 'whitelist')
  assert.equal(current.mode, 'whitelist')
  const evil = makeRes()
  await route.handler({ headers: { host: 'evil.example.com' } }, evil)
  assert.equal(evil.status, 403)
})

test('catalog route degrades when a service is missing or hostile', async () => {
  const noLlm = makeRes()
  await mountRoute({ llm: undefined }).route.handler({ headers: { host: 'localhost' } }, noLlm)
  assert.equal(noLlm.status, 503)
  const missing = mountRoute({ llm: happyLlm, webServer: null })
  assert.equal(missing.route, undefined, 'no webServer → nothing registered')
  assert.ok(missing.warnings.some((w) => w.includes('model catalog route not registered')))
  // A listProviders that throws must not produce a 500.
  const angry = { listProviders: () => { throw new Error('nope') }, listModels: async () => [] }
  const res = makeRes()
  await mountRoute({ llm: angry, logger: { warn() {}, debug() {}, info() {} } }).route.handler({ headers: { host: 'localhost' } }, res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body).providers, [])
})

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
  autoPromotionWarned,
  currentModelAcceptsImage,
  installAutoImageAdmission,
  lastModelDecision,
  modelListMatches,
  modelListMatchEntries,
  normalizeListMode,
  probeKey,
  probeVerdict,
  registerModelCatalogRoute,
  unwrappedResolveModelInfo,
  warnAutoPromotion,
} from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'index.js'), 'utf8')
const client = readFileSync(join(root, 'client.js'), 'utf8')

const cfg = (over = {}) => ({ ...Config({}), ...over })
/** The exact configuration v0.8.1 behaved as: no detection, list means direct. */
const legacyCfg = (over = {}) => cfg({ autoDetectMultimodal: false, multimodalListMode: 'whitelist', ...over })
const agent = (provider, model) => ({ session: { requestHeader: () => ({ config: { provider, model } }) } })
const llmDeclaring = (modalities) => ({
  resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: modalities }),
})

// ── schema + wiring ─────────────────────────────────────────────────────────
test('Config carries the v0.9.0 fields', () => {
  assert.equal(Config.dict.multimodalListMode.meta.default, 'whitelist')
  assert.equal(Config.dict.autoDetectMultimodal.meta.default, true, 'detection drives the bridge by default')
  assert.deepEqual(Config.dict.multimodalModels.meta.default, [])
  assert.equal(normalizeListMode(Config({}).multimodalListMode), 'whitelist')
  // "Off" must remain reachable: it is the behaviour every pre-0.9 config had.
  const legacy = cfg({ autoDetectMultimodal: false, multimodalListMode: 'whitelist', multimodalModels: [] })
  assert.equal(legacy.autoDetectMultimodal, false)
})

test('the catalog route is registered on the plugin fiber, not the feature fiber', () => {
  // A section whose list field cannot autocomplete while the switch is off
  // would be unconfigurable — the route must outlive `enabled: false`.
  assert.ok(server.includes(`const MODEL_CATALOG_ROUTE = "${MODEL_CATALOG_ROUTE}"`))
  assert.ok(server.includes('registerModelCatalogRoute(ctx, ctx.logger, getConfig)'))
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

test('a route promoted only by its own declaration warns once, naming the escape hatch', async () => {
  // Auto-detection can be wrong in exactly one direction, and this notice is
  // what keeps that recoverable instead of mysterious.
  autoPromotionWarned.clear()
  const seen = []
  const logger = { warn: (message) => seen.push(String(message)) }
  const config = cfg()
  await currentModelAcceptsImage(agent('commandcode', 'xiaomi/mimo-v2.5'), config, llmDeclaring(['text', 'image']))
  warnAutoPromotion(logger)
  warnAutoPromotion(logger)
  assert.equal(seen.length, 1, 'once per route, not once per step')
  assert.match(seen[0], /blacklist/, 'the escape hatch must be named')
  assert.match(seen[0], /xiaomi\/mimo-v2\.5/, 'the offending route must be named')
  await currentModelAcceptsImage(agent('commandcode', 'other/model'), config, llmDeclaring(['text', 'image']))
  warnAutoPromotion(logger)
  assert.equal(seen.length, 2, 'each route warns on its own account')
  // Silence for decisions that are not promotions.
  autoPromotionWarned.clear()
  await currentModelAcceptsImage(agent('p', 'listed'), cfg({ multimodalModels: ['listed'] }), llmDeclaring(['text', 'image']))
  warnAutoPromotion(logger)
  assert.equal(seen.length, 2, 'a whitelist hit is not a promotion')
  await currentModelAcceptsImage(agent('p', 'plain'), config, llmDeclaring(['text']))
  warnAutoPromotion(logger)
  assert.equal(seen.length, 2, 'a bridged route is not a promotion')
  // A missing logger must never throw out of the bridge.
  assert.doesNotThrow(() => warnAutoPromotion(undefined))
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
test('v0.8.1 semantics hold: a listed model is never un-bridged', async () => {
  // Compatibility is one-directional on purpose. The new matcher is strictly
  // more permissive (bare ids, provider-qualified ids, globs), so no entry
  // that used to force a model direct may stop doing so. Under the *shipped*
  // default (detection on) a listing is still the strongest statement there is.
  const legacy = (config, model) => config.multimodalModels.includes(model)
  const models = ['mimo-v2.5', 'xiaomi/mimo-v2.5', 'deepseek/deepseek-v4.1-flash', 'meituan/LongCat-2.0:free']
  const lists = [[], ['mimo-v2.5'], ['xiaomi/mimo-v2.5'], ['other'], ['deepseek/deepseek-v4.1-flash', 'mimo-v2.5']]
  for (const model of models) {
    for (const list of lists) {
      if (!legacy(legacyCfg({ multimodalModels: list }), model)) continue
      for (const config of [legacyCfg({ multimodalModels: list }), cfg({ multimodalModels: list })]) {
        assert.equal(
          await currentModelAcceptsImage(agent('commandcode', model), config, llmDeclaring(['text'])),
          true,
          `listed model ${model} must stay direct with ${JSON.stringify(list)}`,
        )
      }
    }
  }
})

test('the shipped default treats a detected multimodal model like a listed one', async () => {
  const config = cfg()
  assert.equal(config.autoDetectMultimodal, true, 'detection is part of the default decision, not an add-on')
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, llmDeclaring(['text', 'image'])), true)
  assert.equal(lastModelDecision.source, 'auto')
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, llmDeclaring(['text'])), false)
  assert.equal(lastModelDecision.source, 'default')
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, undefined), false, 'unknown routes bridge')
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

function mountRoute({ llm, webServer, logger, config } = {}) {
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
  registerModelCatalogRoute(ctx, ctx.logger, config === undefined ? undefined : () => config)
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
  // One broken route degrades to an error note; the rest still list.
  assert.deepEqual(payload.providers[1].models, [])
  assert.match(payload.providers[1].error, /catalog exploded/)
  assert.ok('current' in payload, 'the panel reads the last decision from here')
})

test('modelListMatchEntries names the entries responsible, so unchecking is exact', () => {
  const model = 'xiaomi/mimo-v2.5'
  assert.deepEqual(modelListMatchEntries(['mimo-v2.5'], 'commandcode', model), ['mimo-v2.5'])
  assert.deepEqual(modelListMatchEntries(['*mimo*', 'mimo-v2.5'], 'commandcode', model), ['*mimo*', 'mimo-v2.5'])
  assert.deepEqual(modelListMatchEntries(['other', 'xiaomi/*'], 'commandcode', model), ['xiaomi/*'])
  assert.deepEqual(modelListMatchEntries(['MIMO-V2.5'], 'commandcode', model), ['MIMO-V2.5'])
  assert.deepEqual(modelListMatchEntries([], 'commandcode', model), [])
  assert.deepEqual(modelListMatchEntries(['other'], 'commandcode', model), [])
  // The removal key must be the entry AS STORED (a glob stays a glob); trim
  // only normalizes the comparison, never the value handed back to the editor.
  assert.deepEqual(modelListMatchEntries(['  mimo-v2.5  '], 'commandcode', model), ['  mimo-v2.5  '])
  // A bare id in the list must not be reported as a hit for a NESTED id's
  // trailing segment on an unrelated model.
  assert.deepEqual(modelListMatchEntries(['mimo-v2.5'], 'commandcode', 'xiaomi/other-vl'), [])
})

test('the route marks the models the CURRENT list addresses', async () => {
  const config = cfg({ multimodalModels: ['mimo-v2.5', 'nope'], multimodalListMode: 'blacklist' })
  const { route } = mountRoute({ llm: happyLlm, config })
  const res = makeRes()
  await route.handler({ headers: { host: 'localhost' } }, res)
  const payload = JSON.parse(res.body)
  const models = payload.providers[0].models
  // The bare entry hits the qualified route — the very fix v0.9.0 is about.
  assert.deepEqual(models[0], {
    id: 'xiaomi/mimo-v2.5',
    name: 'MiMo V2.5',
    image: true,
    listed: true,
    matchedEntries: ['mimo-v2.5'],
    probe: null,
  })
  assert.equal(models[1].listed, false, 'an unlisted model must not look ticked')
  assert.deepEqual(models[1].matchedEntries, [])
  // The panel mirrors the live list and mode so a tick can never describe a
  // different list than the one the bridge is using.
  assert.deepEqual(payload.list, ['mimo-v2.5', 'nope'])
  assert.equal(payload.listMode, 'blacklist')
})

// ── measured verdicts (v0.9.0 probe) ────────────────────────────────────────
test('probeVerdict only answers for routes that were actually measured', () => {
  const config = cfg({ probeResults: { 'commandcode/xiaomi/mimo-v2.5': 'yes', 'opencodego/deepseek-v4-flash': 'no' } })
  assert.equal(probeVerdict(config, 'commandcode', 'xiaomi/mimo-v2.5'), 'yes')
  assert.equal(probeVerdict(config, 'opencodego', 'deepseek-v4-flash'), 'no')
  assert.equal(probeVerdict(config, 'commandcode', 'other'), undefined, 'unprobed is not a verdict')
  assert.equal(probeVerdict(cfg(), 'p', 'm'), undefined, 'default config has no measurements')
  // A hand-edited settings.yaml must not be able to inject a decision.
  for (const junk of ['maybe', '', 'YES', true, 1, null]) {
    assert.equal(probeVerdict(cfg({ probeResults: { 'p/m': junk } }), 'p', 'm'), undefined, `junk: ${String(junk)}`)
  }
  // The key is provider-qualified: the same id can be served by two gateways.
  assert.equal(probeVerdict(config, 'other', 'xiaomi/mimo-v2.5'), undefined)
  assert.equal(probeKey('p', 'm'), 'p/m')
  assert.equal(probeKey(undefined, 'm'), '/m')
})

test('a measured verdict outranks the declaration, in BOTH directions', async () => {
  // Measured yes: promoted even though the route says text-only. This is the
  // blind spot the whitelist used to cover by hand.
  const yes = cfg({ probeResults: { 'p/m': 'yes' } })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), yes, llmDeclaring(['text'])), true)
  assert.equal(lastModelDecision.source, 'probe-yes')
  // Measured no: demoted even though the route claims image input.
  const no = cfg({ probeResults: { 'p/m': 'no' } })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), no, llmDeclaring(['text', 'image'])), false)
  assert.equal(lastModelDecision.source, 'probe-no')
})

test('the human list keeps the last word over a measurement', async () => {
  // A person who names a model outranks an automated measurement — that is the
  // whole point of keeping the list explicit.
  const probed = cfg({ probeResults: { 'p/m': 'no' }, multimodalModels: ['m'], multimodalListMode: 'whitelist' })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), probed, llmDeclaring(['text'])), true)
  assert.equal(lastModelDecision.source, 'whitelist')
  const blacklisted = cfg({ probeResults: { 'p/m': 'yes' }, multimodalModels: ['m'], multimodalListMode: 'blacklist' })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), blacklisted, llmDeclaring(['text', 'image'])), false)
  assert.equal(lastModelDecision.source, 'blacklist')
})

test('a measurement works with auto-detection switched off', async () => {
  // Probing is its own signal, so it must not depend on the declaration path.
  const config = cfg({ autoDetectMultimodal: false, probeResults: { 'p/m': 'yes' } })
  assert.equal(await currentModelAcceptsImage(agent('p', 'm'), config, undefined), true)
})

test('the catalog route reports each model\'s measurement', async () => {
  const config = cfg({
    probeResults: { 'commandcode/xiaomi/mimo-v2.5': 'yes', 'commandcode/meituan/LongCat-2.0:free': 'no' },
  })
  const { route } = mountRoute({ llm: happyLlm, config })
  const res = makeRes()
  await route.handler({ headers: { host: 'localhost' } }, res)
  const payload = JSON.parse(res.body)
  const [mimo, longcat] = payload.providers[0].models
  assert.equal(mimo.probe, 'yes')
  assert.equal(longcat.probe, 'no', 'a negative measurement must be visible, not hidden')
  assert.equal(payload.probeResults['commandcode/xiaomi/mimo-v2.5'], 'yes')
})

test('the route still answers without a config getter', async () => {
  const { route } = mountRoute({ llm: happyLlm })
  const res = makeRes()
  await route.handler({ headers: { host: 'localhost' } }, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.providers[0].models[0].listed, false)
  assert.deepEqual(payload.list, [])
  assert.equal(payload.listMode, 'whitelist', 'no config → the packaged default')
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

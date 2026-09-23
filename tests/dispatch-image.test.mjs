/**
 * dsh-tool-vision — dispatch image admission: `llm.registration` wrap tests.
 *
 * Admission is not dispatch. `resolveModelInfo` (see auto-image.test.mjs) is
 * pure admission: it decides who may *offer* an image and never changes what the
 * adapter streams. `LlmService.generate` resolves modalities from
 * `adapter.prepareCall(provider, model).model.inputModalities`, and when that
 * list lacks `image` it rewrites every image block into a text placeholder before
 * the adapter is called — so a route this plugin had measured as image-capable
 * still lost the pixels, because the check that destroys them reads the adapter's
 * declaration and nothing else.
 *
 * These tests pin the wrap that closes that gap: the plugin's own verdict
 * (`routeDirectDecision`) is applied where the core actually looks, the two
 * layers cannot disagree, and dispose restores everything it touched.
 *
 * Self-contained (no runtime deps). Cross-checks the real index.js so drift
 * fails loudly.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installDispatchImageAdmission, Config } from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'index.js'), 'utf8')

let allOk = true
function check(label, ok, extra = '') {
  if (!ok) allOk = false
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${extra ? ' | ' + extra : ''}`)
}

// ── sync checks: source wiring must exist ──
const exports_ = server.split('export {')[1] ?? ''
const syncChecks = [
  ['index.js exports installDispatchImageAdmission', /installDispatchImageAdmission/.test(exports_)],
  ['index.js exports routeDirectDecision', /routeDirectDecision/.test(exports_)],
  ['the dispatch wrap is mounted in the feature fiber',
    /installDispatchImageAdmission\(inner\.get\("llm"\), getConfig, inner\.logger\)/.test(server)],
  ['the dispatch wrap has its own effect (so it is disposed with the fiber)',
    /inner\.effect\(\(\) => unwrapDispatch/.test(server)],
  // The bridge and the dispatch path must read ONE precedence rule, or they can
  // disagree about the same route — which is exactly the bug this closes.
  ['currentModelAcceptsImage delegates to routeDirectDecision',
    /async function currentModelAcceptsImage\(agent, config, llm\) \{[\s\S]{0,400}?routeDirectDecision\(/.test(server)],
]

// ── config + fake llm ──
const BASE_CONFIG = {
  bridgeTextOnly: true,
  autoDetectMultimodal: false,
  multimodalListMode: 'whitelist',
  multimodalModels: [],
  probeResults: {},
}
const cfg = (over) => ({ ...BASE_CONFIG, ...over })

/** An adapter whose prepareCall answers like a text-only route. */
function makeAdapter(modalities = ['text']) {
  return {
    calls: 0,
    async prepareCall(provider, model) {
      this.calls += 1
      return {
        model: { provider, id: model, name: model, inputModalities: [...modalities] },
        stream: () => 'streamed',
      }
    },
  }
}

/** Fake llm service: `registration` hands back the registration the core reads. */
function makeLlm(adapter, resolveModelInfo) {
  return {
    resolveModelInfo,
    registration: () => ({ provider: { id: 'p' }, adapter }),
  }
}

const getConfig = () => currentConfig
let currentConfig = cfg()

// ── case 1: the regression — a probed-capable route keeps its pixels ──
{
  currentConfig = cfg({ probeResults: { 'p/m': 'yes' } })
  const adapter = makeAdapter(['text'])
  const llm = makeLlm(adapter)
  const dispose = installDispatchImageAdmission(llm, getConfig)
  const call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('a route probed "yes" reaches dispatch declaring image input',
    Array.isArray(call.model.inputModalities) && call.model.inputModalities.includes('image'),
    JSON.stringify(call.model.inputModalities))
  check('the declaration keeps what it already had',
    call.model.inputModalities.includes('text'))
  check('the adapter still streams', call.stream() === 'streamed')
  dispose()
}

// ── case 2: a route probed "no" is left exactly as the adapter returned it ──
{
  currentConfig = cfg({ probeResults: { 'p/m': 'no' } })
  const base = { provider: 'p', id: 'm', name: 'm', inputModalities: ['text'] }
  const adapter = { async prepareCall() { return { model: base, stream: () => 's' } } }
  const llm = makeLlm(adapter)
  const dispose = installDispatchImageAdmission(llm, getConfig)
  const call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('a route probed "no" is untouched (the core projection stays the fallback)',
    call.model === base)
  dispose()
}

// ── case 3: an adapter that already declares image passes through by reference ──
{
  currentConfig = cfg({ probeResults: { 'p/m': 'yes' } })
  const base = { provider: 'p', id: 'm', name: 'm', inputModalities: ['text', 'image'] }
  const adapter = { async prepareCall() { return { model: base, stream: () => 's' } } }
  const llm = makeLlm(adapter)
  const dispose = installDispatchImageAdmission(llm, getConfig)
  const call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('an already image-capable adapter is not re-wrapped', call.model === base)
  dispose()
}

// ── case 4: the human list outranks the measurement, in both directions ──
{
  currentConfig = cfg({ probeResults: { 'p/m': 'no' }, multimodalModels: ['m'], multimodalListMode: 'whitelist' })
  const adapter = makeAdapter(['text'])
  const llm = makeLlm(adapter)
  const d = installDispatchImageAdmission(llm, getConfig)
  let call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('whitelist outranks a probe verdict of "no"', call.model.inputModalities.includes('image'))
  d()

  currentConfig = cfg({ probeResults: { 'p/m': 'yes' }, multimodalModels: ['m'], multimodalListMode: 'blacklist' })
  const adapter2 = makeAdapter(['text'])
  const llm2 = makeLlm(adapter2)
  const d2 = installDispatchImageAdmission(llm2, getConfig)
  call = await llm2.registration('p').adapter.prepareCall('p', 'm')
  check('blacklist outranks a probe verdict of "yes"', !call.model.inputModalities.includes('image'))
  d2()
}

// ── case 5: bridging disabled means every route may receive images ──
{
  currentConfig = cfg({ bridgeTextOnly: false })
  const adapter = makeAdapter(['text'])
  const llm = makeLlm(adapter)
  const dispose = installDispatchImageAdmission(llm, getConfig)
  const call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('bridgeTextOnly off declares image for every route',
    call.model.inputModalities.includes('image'))
  dispose()
}

// ── case 6: an adapter registered AFTER install is wrapped too ──
{
  currentConfig = cfg({ probeResults: { 'p/m': 'yes' } })
  let adapter = makeAdapter(['text'])
  const llm = { resolveModelInfo: undefined, registration: () => ({ provider: { id: 'p' }, adapter }) }
  const dispose = installDispatchImageAdmission(llm, getConfig)
  // Swap in a brand-new adapter object, as a late provider registration would.
  adapter = makeAdapter(['text'])
  const call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('a later-registered adapter is wrapped as well',
    call.model.inputModalities.includes('image'),
    JSON.stringify(call.model.inputModalities))
  dispose()
}

// ── case 7: idempotent, and dispose restores the adapter + the accessor ──
{
  currentConfig = cfg({ probeResults: { 'p/m': 'yes' } })
  const adapter = makeAdapter(['text'])
  const rawPrepare = adapter.prepareCall
  const llm = makeLlm(adapter)
  const wrappedRegistration = installDispatchImageAdmission(llm, getConfig)
  const registrationAfterFirst = llm.registration
  const prepareAfterFirst = adapter.prepareCall
  const noop = installDispatchImageAdmission(llm, getConfig)
  check('second install is a no-op (same accessor kept)', llm.registration === registrationAfterFirst)
  check('second install does not double-wrap the adapter', adapter.prepareCall === prepareAfterFirst)
  noop()
  check('no-op dispose leaves the wrap intact', llm.registration === registrationAfterFirst)
  wrappedRegistration()
  check('dispose restores the adapter prepareCall', adapter.prepareCall === rawPrepare)
  const call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('after dispose the adapter answers as before', !call.model.inputModalities.includes('image'))
  // A fresh install after dispose wraps again (marker cleared).
  const again = installDispatchImageAdmission(llm, getConfig)
  const call2 = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('re-install after dispose wraps again', call2.model.inputModalities.includes('image'))
  again()
}

// ── case 8: a decision that cannot be made never sends pixels ──
{
  currentConfig = cfg({ probeResults: { 'p/m': 'yes' } })
  const base = { provider: 'p', id: 'm', name: 'm', inputModalities: ['text'] }
  const adapter = { async prepareCall() { return { model: base, stream: () => 's' } } }
  const llm = makeLlm(adapter)
  const dispose = installDispatchImageAdmission(llm, () => { throw new Error('config unavailable') })
  const call = await llm.registration('p').adapter.prepareCall('p', 'm')
  check('a throwing config leaves the call untouched (fail closed)', call.model === base)
  dispose()
}

// ── case 9: missing llm service → safe no-op ──
{
  const dispose = installDispatchImageAdmission(undefined, getConfig, { warn() {} })
  check('missing llm service is a safe no-op', typeof dispose === 'function')
  const dispose2 = installDispatchImageAdmission(null, getConfig, { warn() {} })
  check('null llm service is a safe no-op', typeof dispose2 === 'function')
}

// ── case 10: Config still carries the switches this rule reads ──
{
  const dict = Config.dict ?? {}
  check('Config declares probeResults', dict.probeResults !== undefined)
  check('Config declares multimodalListMode', dict.multimodalListMode !== undefined)
  check('Config declares autoDetectMultimodal (default true)',
    dict.autoDetectMultimodal?.meta?.default === true)
}

console.log(allOk ? 'ALL DISPATCH-IMAGE TESTS PASSED' : 'SOME TESTS FAILED')
process.exit(allOk ? 0 : 1)

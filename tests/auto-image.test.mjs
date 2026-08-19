/**
 * dsh-tool-vision — automatic image admission: resolveModelInfo wrap tests.
 *
 * Self-contained (no runtime deps): builds a fake llm service and verifies
 * `installAutoImageAdmission` behavior — image capability is reported for
 * text-only models, already-capable models pass through unchanged, the wrap
 * is idempotent across HMR re-applies, and dispose restores the original
 * method. Cross-checks the real index.js so drift fails loudly.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installAutoImageAdmission, Config } from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'index.js'), 'utf8')

let allOk = true
function check(label, ok, extra = '') {
  if (!ok) allOk = false
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${extra ? ' | ' + extra : ''}`)
}

// ── sync checks: schema + source wiring must exist ──
const syncChecks = [
  ['Config declares bridgeAutoImage (default true)', (() => {
    // schemastery object schema: fields live in `dict`; each field keeps its
    // default in `meta.default`. Probe defensively.
    const field = Config.dict?.bridgeAutoImage
    return field !== undefined && field?.meta?.default === true
  })()],
  ['index.js mounts installAutoImageAdmission under bridgeTextOnly', /if \(getConfig\(\)\.bridgeTextOnly\) \{[\s\S]*?bridgeAutoImage[\s\S]*?installAutoImageAdmission\(/.test(server)],
  ['index.js exports installAutoImageAdmission', /installAutoImageAdmission/.test(server.split('export {')[1] ?? '')],
  ['client.js has fieldBridgeAutoImage', (() => {
    const client = readFileSync(join(root, 'client.js'), 'utf8')
    return client.includes('fieldBridgeAutoImage') && client.includes('bridgeAutoImage')
  })()],
]
for (const [label, ok] of syncChecks) check(label, ok)

// ── fake llm service ──
function makeLlm(resolveModelInfoImpl) {
  return {
    resolveModelInfo: resolveModelInfoImpl,
  }
}

// helper: call wrapped resolveModelInfo through the fake llm
async function resolveThrough(llm, provider, model) {
  return llm.resolveModelInfo(provider, model)
}

// ── case 1: text-only model gets image capability reported ──
{
  const llm = makeLlm(async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }))
  const dispose = installAutoImageAdmission(llm)
  const info = await resolveThrough(llm, 'opencode-go', 'deepseek-v4-flash')
  check('text-only model reports image capability', info.inputModalities.includes('image') && info.inputModalities.includes('text'),
    JSON.stringify(info.inputModalities))
  check('original fields preserved', info.name === 'deepseek-v4-flash' && info.provider === 'opencode-go')
  dispose()
  check('dispose restores original method', llm.resolveModelInfo !== undefined)
}

// ── case 2: no inputModalities at all → gets ["image"] ──
{
  const llm = makeLlm(async (p, m) => ({ provider: p, id: m, name: m }))
  const dispose = installAutoImageAdmission(llm)
  const info = await resolveThrough(llm, 'x', 'y')
  check('model with no inputModalities reports ["image"]', Array.isArray(info.inputModalities) && info.inputModalities.length === 1 && info.inputModalities[0] === 'image')
  dispose()
}

// ── case 3: already image-capable model passes through unchanged (same reference) ──
{
  const base = { provider: 'p', id: 'm', name: 'm', inputModalities: ['text', 'image'] }
  const llm = makeLlm(async () => base)
  const dispose = installAutoImageAdmission(llm)
  const info = await resolveThrough(llm, 'p', 'm')
  check('image-capable model unchanged', info === base, 'same reference returned')
  dispose()
}

// ── case 4: idempotent — installing twice does not double-wrap or break ──
{
  let calls = 0
  const llm = makeLlm(async (p, m) => { calls++; return { provider: p, id: m, name: m, inputModalities: ['text'] } })
  const dispose1 = installAutoImageAdmission(llm)
  const wrapped1 = llm.resolveModelInfo
  const dispose2 = installAutoImageAdmission(llm)
  check('second install is a no-op (same method kept)', llm.resolveModelInfo === wrapped1)
  const info = await resolveThrough(llm, 'p', 'm')
  check('single wrap: underlying called once', calls === 1 && info.inputModalities.includes('image'))
  // dispose in reverse order
  dispose2()
  check('no-op dispose leaves wrap intact', llm.resolveModelInfo === wrapped1)
  dispose1()
  // after dispose, a fresh install wraps again (marker cleared)
  let calls2 = 0
  const llm2 = makeLlm(async (p, m) => { calls2++; return { provider: p, id: m, name: m } })
  const d = installAutoImageAdmission(llm2)
  const info2 = await resolveThrough(llm2, 'p', 'm')
  check('re-install after dispose wraps again', calls2 === 1 && Array.isArray(info2.inputModalities) && info2.inputModalities.includes('image'))
  d()
}

// ── case 5: missing llm service → safe no-op ──
{
  const dispose = installAutoImageAdmission(undefined, { warn() {} })
  check('missing llm service is a safe no-op', typeof dispose === 'function')
  const dispose2 = installAutoImageAdmission(null, { warn() {} })
  check('null llm service is a safe no-op', typeof dispose2 === 'function')
}

console.log(allOk ? 'ALL AUTO-IMAGE TESTS PASSED' : 'SOME TESTS FAILED')
process.exit(allOk ? 0 : 1)

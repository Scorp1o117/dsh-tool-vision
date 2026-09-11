/**
 * dsh-tool-vision — settings-panel RENDER test (v0.9.0).
 *
 * Renders the REAL client bundle (the same `window.__ModuleLoader__.load`
 * factory the browser runs) in jsdom, through the REAL plugin registration
 * path (`apply` → `slots.register` → the section component), against a fake
 * settings scope and a catalog payload shaped exactly like
 * `GET /plugins/dsh-tool-vision/models`.
 *
 * WHY THIS EXISTS: v0.9.0 first shipped its model catalog fetched correctly
 * and rendered into a native `<datalist>` only — which stays invisible until
 * the user types, so the panel looked dead while every server-side unit test
 * passed. Nothing below the DOM can catch that class of bug; only rendering.
 *
 * Deliberately NOT part of `npm test`: it needs react/react-dom/jsdom, and a
 * DOM test that silently skips when they are missing is a false comfort.
 *
 *   npm i -D react@18 react-dom@18 jsdom
 *   npm run test:render
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, currentModelAcceptsImage, registerModelCatalogRoute } from '../index.js'

let jsdom, react, reactDomClient
try {
  ({ JSDOM: jsdom } = await import('jsdom'))
  react = (await import('react')).default ?? await import('react')
  reactDomClient = await import('react-dom/client')
} catch (error) {
  console.error(
    'render test needs its dev dependencies:\n' +
    '  npm i -D react@18 react-dom@18 jsdom\n' +
    `(${String(error?.message ?? error)})`,
  )
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

let failures = 0
function check(label, ok, extra = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${extra ? ' | ' + extra : ''}`)
}

// ── jsdom + module loading ──────────────────────────────────────────────────
const dom = new jsdom('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// Node exposes some of these as getter-only globals; define over them.
for (const [key, value] of Object.entries({
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  TreeWalker: window.TreeWalker,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  MutationObserver: window.MutationObserver,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act } = react

// The bundle asks for "react" through the module loader's require, and its
// factory returns its own module.exports.
let captured = null
window.__ModuleLoader__ = {
  load(definition) {
    captured = definition.factory((name) => {
      if (name === 'react') return react
      throw new Error(`unexpected external: ${name}`)
    })
  },
}

// ── the catalog comes from the REAL route handler ───────────────────────────
// Hand-writing the fixture would let it drift away from what the server
// actually sends; driving the real handler means this test fails the moment
// the payload stops carrying what the panel needs.
const catalogLlm = {
  listProviders: () => [
    { id: 'commandcode', name: 'GOAT' },
    { id: 'broken', name: 'Broken' },
  ],
  listModels: async (provider) => {
    if (provider === 'broken') throw new Error('catalog exploded')
    return [
      { provider, id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', inputModalities: ['text', 'image'] },
      { provider, id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5', inputModalities: ['text', 'image'] },
      { provider, id: 'meituan/LongCat-2.0:free', name: 'LongCat 2.0', inputModalities: ['text'] },
    ]
  },
}
const catalogConfig = {
  ...Config({}),
  multimodalModels: ['mimo-v2.5'],
  multimodalListMode: 'whitelist',
  autoDetectMultimodal: true,
  // One measured-yes and one measured-no, so the panel must render both states
  // and distinguish them from "never probed".
  probeResults: { 'commandcode/xiaomi/mimo-v2.5': 'yes', 'commandcode/meituan/LongCat-2.0:free': 'no' },
}
// Seed the last decision the way a real step would, so the readout has
// something true to render.
const catalogLogger = { warn() {}, info() {}, debug() {}, error() {} }
await currentModelAcceptsImage(
  { session: { requestHeader: () => ({ config: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } }) } },
  catalogConfig,
  catalogLlm,
)
let catalogRoute = null
registerModelCatalogRoute({
  get(name) {
    if (name === 'llm') return catalogLlm
    if (name === 'webServer') return { register(route) { catalogRoute = route; return () => {} } }
    return undefined
  },
  effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
  logger: catalogLogger,
}, catalogLogger, () => catalogConfig)
let catalogBody = ''
await catalogRoute.handler({ headers: { host: '127.0.0.1:3080' } }, {
  writeHead() {},
  end(body) { catalogBody = body },
})
const CATALOG = JSON.parse(catalogBody)
if (!Array.isArray(CATALOG.providers) || CATALOG.providers.length !== 2) {
  console.error('the real catalog route did not answer as expected')
  process.exit(1)
}

let fetchCalls = 0
let fetchMode = 'ok'
globalThis.fetch = window.fetch = async () => {
  fetchCalls += 1
  if (fetchMode !== 'ok') throw new Error('network down')
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(CATALOG)) }
}

// ── evaluate the real bundle ────────────────────────────────────────────────
window.eval(source)
const plugin = captured
check('client bundle registers itself through __ModuleLoader__', plugin !== undefined)
check('bundle exports apply + inject', typeof plugin?.apply === 'function' && Array.isArray(plugin?.inject))

// ── fake settings scope over a real config value ────────────────────────────
const VALUE = {
  enabled: true,
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  apiKeyEnv: 'VISION_API_KEY',
  model: 'gpt-4o-mini',
  maxTokens: 4096,
  timeoutMs: 60000,
  maxImageBytes: 10485760,
  bridgeTextOnly: true,
  bridgeExportDir: '',
  multimodalModels: ['mimo-v2.5'],
  multimodalListMode: 'whitelist',
  autoDetectMultimodal: true,
  bridgePreview: true,
  bridgePreviewScanIntervalMs: 2000,
  bridgePreviewHideHint: true,
  bridgeAutoImage: true,
  desktopScreenshot: false,
  sendSessionHeader: true,
  sessionHeaderName: 'x-opencode-session',
  sessionId: '',
}
const mutations = []
const scope = {
  value: VALUE,
  getSnapshot() { return { status: 'ready', value: this.value, user: {}, writable: true } },
  subscribe() { return () => {} },
  async mutate(ops) {
    mutations.push(ops)
    for (const op of ops) {
      if (op.op === 'set') this.value = { ...this.value, [op.path[0]]: op.value }
      else if (op.op === 'unset') { const next = { ...this.value }; delete next[op.path[0]]; this.value = next }
    }
    return { ok: true }
  },
  async set(path, v) { return this.mutate([{ op: 'set', path, value: v }]) },
  async unset(path) { return this.mutate([{ op: 'unset', path }]) },
}

// ── drive the real registration path ───────────────────────────────────────
const sections = []
const ctx = {
  locale: { bind: () => (key) => key, register() {} },
  effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
  slots: {
    inject(name, cb) { cb() },
    register(spec, render) { sections.push({ spec, render }); return () => {} },
  },
  settingsScope: { bind: () => scope },
}
plugin.apply(ctx)

const section = sections[0]
check('a settings.section is registered', section !== undefined)
check('the section is the vision panel', section?.spec?.id === 'tool-vision', section?.spec?.id)

const settle = () => new Promise((r) => setTimeout(r, 20))
const root_ = reactDomClient.createRoot(document.getElementById('root'))
await act(async () => { root_.render(section.render({ t: (key) => key })) })
await act(settle)

// ── assertions on the rendered DOM ──────────────────────────────────────────
const html = document.getElementById('root').innerHTML
check('the catalog fetch was issued', fetchCalls > 0, `${fetchCalls} call(s)`)
check('the current-route readout renders the routed model', html.includes('deepseek/deepseek-v4.1-flash'))
check('the picker renders one row per configured model',
  html.includes('xiaomi/mimo-v2.5') && html.includes('meituan/LongCat-2.0:free'))
check('a VISIBLE picker list exists (not just a datalist)',
  document.querySelectorAll('.__tv_item').length === 3, `${document.querySelectorAll('.__tv_item').length} rows`)
check('the broken provider is reported instead of blanking the panel', html.includes('catalog exploded'))

const boxes = document.querySelectorAll('.__tv_pickerList input[type=checkbox]')
check('every rendered model has a checkbox', boxes.length === 3, `${boxes.length} boxes`)
check('the listed model is ticked (matched via the bare id)', boxes[1]?.checked === true, `checked=${boxes[1]?.checked}`)
check('an unlisted model is not ticked', boxes[0]?.checked === false && boxes[2]?.checked === false)

// Measured verdicts must be visible AND distinguishable from a declaration —
// the whole point of probing is that a claim and a measurement differ.
check('a measured-yes route shows the measured badge', html.includes('catalogProbeYes'))
check('a measured-no route shows the negative badge', html.includes('catalogProbeNo'))
const rows = [...document.querySelectorAll('.__tv_item')]
const badgeOf = (row) => [...row.querySelectorAll('.__tv_badge')].map((b) => b.textContent).join(',')
check('the measured-no row does NOT still advertise a declaration',
  badgeOf(rows[2]) === 'catalogProbeNo', `row="${badgeOf(rows[2])}"`)
check('an unprobed route falls back to the declaration badge',
  badgeOf(rows[0]) === 'catalogImage', `row="${badgeOf(rows[0])}"`)

// Toggling edits the ONE draft shared with the text field; Save persists it.
// Asserting a write on click would encode the wrong contract — the picker and
// the text field must not use different commit models for the same setting.
const listInput = () => [...document.querySelectorAll('input')].find((i) => i.getAttribute('list'))
check('the text field and the picker share one draft', listInput()?.value === 'mimo-v2.5', `value=${listInput()?.value}`)

// NOTE: a checkbox must be clicked with element.click() in jsdom — that fires
// the activation behavior (toggle + a real MouseEvent). A hand-built
// `new Event('click')` neither flips `checked` nor reaches React's
// ChangeEventPlugin, so a broken handler would still look "correct".
await act(async () => { boxes[0].click() })
await act(settle)
check('ticking a model updates the shared draft',
  (listInput()?.value || '').includes('deepseek/deepseek-v4.1-flash'), `value=${listInput()?.value}`)
check('ticking is flagged as unsaved in the picker head',
  document.querySelector('.__tv_pickerHead')?.textContent.includes('catalogUnsaved'))

await act(async () => { document.querySelectorAll('.__tv_pickerList input[type=checkbox]')[1].click() })
await act(settle)
const draftAfter = listInput()?.value || ''
check('unticking drops the matching bare-id entry, keeping the new tick',
  draftAfter.includes('deepseek/deepseek-v4.1-flash') && !draftAfter.includes('mimo-v2.5'),
  `value=${draftAfter}`)

const saveButton = [...document.querySelectorAll('.__tv_btn')].find((b) => b.textContent === 'save')
check('the panel still offers Save', saveButton !== undefined)
await act(async () => { saveButton.click() })
await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
const writes = mutations.flat().filter((op) => op.path[0] === 'multimodalModels')
check('Save writes multimodalModels once', writes.length === 1, JSON.stringify(mutations))
check('the written array is the ticked set',
  Array.isArray(writes[0]?.value) && writes[0].value.join() === 'deepseek/deepseek-v4.1-flash',
  JSON.stringify(writes[0]?.value))

// A failing fetch must degrade, not explode.
fetchMode = 'fail'
await act(async () => { document.querySelectorAll('.__tv_link')[0].click() })
await act(settle)
check('a failed refresh surfaces an error instead of dying',
  document.getElementById('root').innerHTML.includes('catalogFailed'))

console.log(failures === 0 ? 'ALL RENDER TESTS PASSED' : `${failures} RENDER TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

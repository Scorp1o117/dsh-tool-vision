/**
 * dsh-tool-vision — bridge preview: loopback route regression tests.
 *
 * Self-contained (no runtime deps): simulates the route handler with the
 * same checks the server implements (media type, Host, containment, size)
 * and cross-checks the real index.js constants so drift fails loudly.
 */
import { readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, stat } from 'node:fs/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'index.js'), 'utf8')

// ── sync checks: route constants must exist in index.js ──
const syncChecks = [
  ['index.js route path', server.includes('const BRIDGE_PREVIEW_ROUTE = "/plugins/dsh-tool-vision/image"')],
  ['index.js 20MB cap', server.includes('const BRIDGE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024')],
  ['index.js media map (no svg)', server.includes('const BRIDGE_PREVIEW_MEDIA') && !/BRIDGE_PREVIEW_MEDIA[\s\S]{0,400}\.svg/.test(server)],
  ['index.js Host check', server.includes('127\\.0\\.0\\.1|localhost|\\[::1\\]')],
  ['index.js containment check', server.includes('startsWith(bridgeDir + sep)')],
]
let allOk = true
for (const [label, ok] of syncChecks) {
  if (!ok) allOk = false
  console.log(`${ok ? 'PASS' : 'FAIL'} | sync | ${label}`)
}

// ── handler simulation (mirror of index.js registerBridgePreviewRoute) ──
const BRIDGE_DIR = resolve(join(tmpdir(), 'dsh-vision-bridge'))
const MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
}

function parseQuery(rawUrl) {
  const query = {}
  const at = rawUrl.indexOf('?')
  if (at === -1) return query
  for (const pair of rawUrl.slice(at + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    try { query[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')) } catch { /* skip */ }
  }
  return query
}

async function handler(req, res) {
  try {
    const query = parseQuery(String(req.url ?? ''))
    const p = query.p
    if (typeof p !== 'string' || p.length === 0) { res.writeHead(400); res.end('bad request'); return }
    const mediaType = MEDIA[extname(p.toLowerCase())]
    if (mediaType === undefined) { res.writeHead(400); res.end('not an image path'); return }
    const host = String(req.headers?.host ?? '')
    if (host !== '' && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) { res.writeHead(403); res.end('forbidden'); return }
    const target = resolve(p)
    if (target !== BRIDGE_DIR && !target.startsWith(BRIDGE_DIR + sep)) { res.writeHead(403); res.end('forbidden'); return }
    const info = await stat(target)
    if (!info.isFile() || info.size > 20 * 1024 * 1024) { res.writeHead(404); res.end('not found'); return }
    const bytes = await readFile(target)
    res.writeHead(200, { 'Content-Type': mediaType, 'Cache-Control': 'private, max-age=60' })
    res.end(bytes)
  } catch {
    try { res.writeHead(404); res.end('not found') } catch { /* ignore */ }
  }
}

function rawGet(url, hostHeader) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(url, { headers: hostHeader ? { host: hostHeader } : {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolvePromise({ status: res.statusCode, type: res.headers['content-type'], bytes: Buffer.concat(chunks).length }))
    })
    req.on('error', rejectPromise)
    req.end()
  })
}

const server2 = createServer(handler)
await new Promise((r) => server2.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server2.address().port}/plugins/dsh-tool-vision/image`

const tests = [
  ['valid png in dir (missing file)', `${base}?p=${encodeURIComponent(BRIDGE_DIR + '\\x.png')}`, 404],
  ['missing param', base, 400],
  ['non-image ext', `${base}?p=${encodeURIComponent(BRIDGE_DIR + '\\x.txt')}`, 400],
  ['outside dir (valid ext)', `${base}?p=${encodeURIComponent('C:\\Windows\\x.png')}`, 403], // ext 合法 → 目录校验拦截
]
for (const [label, url, want] of tests) {
  const r = await rawGet(url)
  const ok = r.status === want
  if (!ok) allOk = false
  console.log(`${ok ? 'PASS' : 'FAIL'} | route | ${label}: status=${r.status} (want ${want})`)
}

// Host 检查(原始 http 可带自定义 Host)
for (const [label, host, want] of [['evil host', 'evil.example.com', 403], ['localhost ok', 'localhost', 404]]) {
  const r = await rawGet(`${base}?p=${encodeURIComponent(BRIDGE_DIR + '\\x.png')}`, host)
  const ok = r.status === want
  if (!ok) allOk = false
  console.log(`${ok ? 'PASS' : 'FAIL'} | route | ${label}: status=${r.status} (want ${want})`)
}
server2.close()

console.log(allOk ? 'ALL PREVIEW-ROUTE TESTS PASSED' : 'SOME TESTS FAILED')
process.exit(allOk ? 0 : 1)

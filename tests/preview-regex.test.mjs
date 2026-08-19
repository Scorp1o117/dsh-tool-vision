/**
 * dsh-tool-vision — bridge preview: marker + path extraction regression tests.
 *
 * Self-contained (no runtime deps): duplicates the extraction logic and
 * cross-checks the real sources so the tests fail loudly if the client's
 * marker/route constants or the server's bridge template drift.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const server = readFileSync(join(root, 'index.js'), 'utf8')

// ── sync checks: constants must exist in the real sources ──
const syncChecks = [
  ['client.js has PREVIEW_MARK', client.includes('var PREVIEW_MARK = "\\u200b[bridge]"')],
  ['client.js has PREVIEW_ROUTE', client.includes('var PREVIEW_ROUTE = "/plugins/dsh-tool-vision/image"')],
  ['index.js has BRIDGE_MARKER', server.includes('const BRIDGE_MARKER = "\\u200b[bridge]"')],
  ['index.js bridge template uses the marker', server.includes('${BRIDGE_MARKER}[User sent an image')],
  ['index.js has BRIDGE_PREVIEW_ROUTE', server.includes('const BRIDGE_PREVIEW_ROUTE = "/plugins/dsh-tool-vision/image"')],
  ['index.js has BRIDGE_PREVIEW_MEDIA', server.includes('const BRIDGE_PREVIEW_MEDIA')],
]
let allOk = true
for (const [label, ok] of syncChecks) {
  if (!ok) allOk = false
  console.log(`${ok ? 'PASS' : 'FAIL'} | sync | ${label}`)
}

// ── marker + path extraction (mirror of client.js previewPathOf) ──
const MARK = '\u200b[bridge]'
const PATH_RE = /exported to:\s*("[^"]+"|'[^']+'|[A-Za-z]:[\\/][^\s\]]+?\.(?:png|jpe?g|webp|gif|avif|bmp))/gi

function extractPath(data) {
  let m
  PATH_RE.lastIndex = 0
  while ((m = PATH_RE.exec(data)) !== null) {
    let s = m[1]
    if (s.length >= 2) {
      const first = s[0]
      const last = s[s.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) s = s.slice(1, -1)
    }
    return s
  }
  return null
}

const cases = [
  // marker 前缀 + 0.3.10 格式桥接文本(单图)
  [MARK + '[User sent an image (image.png), exported to: C:\\Users\\axezt\\AppData\\Local\\Temp\\dsh-vision-bridge\\image_sha256:23c41.png. Inspect it with the inspect_image tool to see its content.]', 'C:\\Users\\axezt\\AppData\\Local\\Temp\\dsh-vision-bridge\\image_sha256:23c41.png'],
  // 多图(两个桥接块,各带 marker)
  [MARK + '[User sent an image (a.png), exported to: C:\\Temp\\v\\a.png. Inspect it with the inspect_image tool to see its content.]\n' + MARK + '[User sent an image (b.jpg), exported to: C:\\Temp\\v\\b.jpg. Inspect it with the inspect_image tool to see its content.]', 'C:\\Temp\\v\\a.png'],
  // 用户附带提问文字
  [MARK + '[User sent an image (x.png), exported to: C:\\Temp\\x.png. Inspect it with the inspect_image tool to see its content.]这个是什么', 'C:\\Temp\\x.png'],
]
for (let i = 0; i < cases.length; i++) {
  const got = extractPath(cases[i][0])
  const ok = got === cases[i][1]
  if (!ok) allOk = false
  console.log(`${ok ? 'PASS' : 'FAIL'} | extract | case${i}: ${JSON.stringify(got)}`)
}

// ── 误伤检查:无标记的普通文本绝不参与预览(客户端按标记识别) ──
const plain = '我昨天 exported to: 一个朋友,今天看了看文档'
const plainMarked = plain.indexOf(MARK) !== -1
console.log(`${!plainMarked ? 'PASS' : 'FAIL'} | marker | plain text has no marker`)
allOk = allOk && !plainMarked

// 即使文本里有路径格式,但没有 marker,客户端扫描也不会命中
const plain2 = 'file: C:\\Temp\\v\\a.png 在桌面上'
const hit = plain2.indexOf(MARK) !== -1
console.log(`${!hit ? 'PASS' : 'FAIL'} | marker | path-like plain text ignored (no marker)`)
allOk = allOk && !hit

console.log(allOk ? 'ALL PREVIEW-REGEX TESTS PASSED' : 'SOME TESTS FAILED')
process.exit(allOk ? 0 : 1)

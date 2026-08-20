import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  registerVisionTools,
  resetVisionCacheForTests,
} from '../lib/vision-tools.js'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex')

const TOOL_NAMES = [
  'vision_describe',
  'vision_materialize',
  'vision_ground',
  'vision_detect',
  'vision_crop',
  'vision_present',
  'vision_pixel_diff',
  'vision_colors',
  'vision_ocr',
  'vision_long_screenshot_ocr',
  'vision_trace',
  'vision_extract_foreground',
  'vision_html_screenshot',
  'vision_screenshot',
]

function mockEnv(tmpDir) {
  const saved = []
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      const attachmentId = 'sha256:' + createHash('sha256').update(data).digest('hex')
      const entry = { attachmentId, mediaType, name, data, bytes: data.length, width: 1, height: 1 }
      saved.push(entry)
      return { attachmentId, mediaType, name, bytes: data.length, width: 1, height: 1 }
    },
    async readImage(ref) {
      const found = saved.find((s) => s.attachmentId === ref.attachmentId)
      if (!found) throw new Error(`no such attachment ${ref.attachmentId}`)
      return { ref: found, data: found.data }
    },
  }
  const fs = {
    async resolve(p) {
      return p
    },
    processPath(p) {
      return p
    },
  }
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'attachments') return attachments
      if (name === 'fs') return fs
      return undefined
    },
    logger: { info() {}, warn() {}, debug() {} },
    tools: { register: (def) => registered.push(def) },
  }
  const getConfig = () => ({
    baseURL: 'https://vision.example.com/v1',
    apiKey: 'test-key',
    apiKeyEnv: '',
    model: 'glm-4.6v',
    maxTokens: 4096,
    timeoutMs: 60000,
    maxImageBytes: 10 * 1024 * 1024,
    desktopScreenshot: true,
  })
  const exec = { agent: { session: { header: { cwd: tmpDir } } }, signal: undefined }
  return { ctx, registered, attachments, exec, getConfig }
}

function toolByName(registered, name) {
  const def = registered.find((d) => d.name === name)
  assert.ok(def, `tool ${name} not registered`)
  return def
}

test('registerVisionTools registers exactly the 14 vision tools when desktopScreenshot is on', async () => {
  const { ctx, registered, getConfig } = mockEnv(await mkdtemp(join(tmpdir(), 'vh-tools-')))
  registerVisionTools(ctx, getConfig)
  const names = registered.map((d) => d.name)
  for (const expected of TOOL_NAMES) {
    assert.ok(names.includes(expected), `missing ${expected}`)
  }
  assert.equal(registered.length, 14)
})

test('vision_screenshot is privacy-gated and absent by default', async () => {
  const { ctx, registered, getConfig } = mockEnv(await mkdtemp(join(tmpdir(), 'vh-tools-')))
  const base = getConfig
  const gatedConfig = () => ({ ...base(), desktopScreenshot: false })
  registerVisionTools(ctx, gatedConfig)
  const names = registered.map((d) => d.name)
  assert.equal(registered.length, 13)
  assert.ok(!names.includes('vision_screenshot'), 'screenshot must be absent when desktopScreenshot is off')
  assert.ok(names.includes('vision_describe'))
})

test('every tool declares a JSON-schema parameter contract with required fields', async () => {
  const { ctx, registered, getConfig } = mockEnv(await mkdtemp(join(tmpdir(), 'vh-tools-')))
  registerVisionTools(ctx, getConfig)
  for (const def of registered) {
    assert.ok(def.parameters, `${def.name} must declare parameters`)
    assert.equal(def.parameters.type, 'object')
    assert.ok(def.output, `${def.name} must declare output`)
    assert.equal(typeof def.execute, 'function', `${def.name} must implement execute`)
  }
  assert.ok(toolByName(registered, 'vision_ground').parameters.required.includes('image'))
  assert.ok(toolByName(registered, 'vision_ground').parameters.required.includes('target'))
  assert.ok(toolByName(registered, 'vision_crop').parameters.required.includes('region'))
  assert.ok(toolByName(registered, 'vision_describe').parameters.required.includes('question'))
})

test('vision_materialize copies an image into the workspace without any model call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-tools-'))
  const src = join(dir, 'input.png')
  await writeFile(src, PNG_BYTES)
  const { ctx, registered, exec, getConfig } = mockEnv(dir)
  resetVisionCacheForTests()
  registerVisionTools(ctx, getConfig)
  const result = await toolByName(registered, 'vision_materialize').execute({ image: src }, exec)
  const parsed = JSON.parse(result)
  assert.ok(parsed.path.startsWith(join(dir, '.dsh-tool-vision')))
  assert.equal(parsed.bytes, PNG_BYTES.length)
  const written = await readFile(parsed.path)
  assert.deepEqual(written, PNG_BYTES)
})

test('vision_colors returns a quantized palette', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-tools-'))
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()
  const src = join(dir, 'red.png')
  await writeFile(src, png)
  const { ctx, registered, exec, getConfig } = mockEnv(dir)
  resetVisionCacheForTests()
  registerVisionTools(ctx, getConfig)
  const result = await toolByName(registered, 'vision_colors').execute({ image: src }, exec)
  const colors = JSON.parse(result)
  assert.ok(Array.isArray(colors) && colors.length >= 1)
  assert.match(colors[0].hex, /^#[0-9a-f]{6}$/i)
  assert.ok(colors[0].share > 0)
})

test('vision_crop extracts a region and writes a PNG artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-tools-'))
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
  const src = join(dir, 'big.png')
  await writeFile(src, png)
  const { ctx, registered, exec, getConfig } = mockEnv(dir)
  resetVisionCacheForTests()
  registerVisionTools(ctx, getConfig)
  const result = await toolByName(registered, 'vision_crop').execute({ image: src, region: '0,0,50,40' }, exec)
  const parsed = JSON.parse(result)
  assert.equal(parsed.width, 50)
  assert.equal(parsed.height, 40)
  assert.ok(parsed.path.endsWith('.png'))
  const meta = await sharp(await readFile(parsed.path)).metadata()
  assert.equal(meta.width, 50)
  assert.equal(meta.height, 40)
})

test('vision_pixel_diff reports differing pixels and writes a heatmap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-tools-'))
  const sharp = (await import('sharp')).default
  const a = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer()
  const b = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
  const pa = join(dir, 'a.png')
  const pb = join(dir, 'b.png')
  await writeFile(pa, a)
  await writeFile(pb, b)
  const { ctx, registered, exec, getConfig } = mockEnv(dir)
  resetVisionCacheForTests()
  registerVisionTools(ctx, getConfig)
  const result = await toolByName(registered, 'vision_pixel_diff').execute({ original: pa, rebuilt: pb }, exec)
  const parsed = JSON.parse(result)
  assert.ok(parsed.differingPixels > 0)
  assert.ok(parsed.differingRatio > 0.9)
  assert.ok(parsed.heatmapPath.endsWith('.png'))
  assert.ok(parsed.reportPath.endsWith('.json'))
})

test('vision_extract_foreground removes a uniform background', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-tools-'))
  const sharp = (await import('sharp')).default
  // White background with a red square in the middle.
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: Buffer.from(`<svg width="64" height="64"><rect x="20" y="20" width="24" height="24" fill="red"/></svg>`), top: 0, left: 0 }])
    .png()
    .toBuffer()
  const src = join(dir, 'logo.png')
  await writeFile(src, png)
  const { ctx, registered, exec, getConfig } = mockEnv(dir)
  resetVisionCacheForTests()
  registerVisionTools(ctx, getConfig)
  const result = await toolByName(registered, 'vision_extract_foreground').execute({ image: src, tolerance: 30 }, exec)
  const parsed = JSON.parse(result)
  assert.ok(parsed.path.endsWith('.png'))
  const cutout = await sharp(await readFile(parsed.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  // Corner pixels (background) must be transparent now.
  const corner = cutout.data.subarray(0, 4)
  assert.equal(corner[3], 0)
  // Center pixel (red square) must stay opaque.
  const center = cutout.data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)
  assert.equal(center[3], 255)
})

test('vision_describe calls the configured endpoint, caches, and honors json mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-tools-'))
  const { ctx, registered, exec, getConfig } = mockEnv(dir)
  resetVisionCacheForTests()
  registerVisionTools(ctx, getConfig)
  const src = join(dir, 'pic.png')
  await writeFile(src, PNG_BYTES)

  let fetchCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    fetchCalls += 1
    const body = JSON.parse(opts.body)
    assert.equal(body.model, 'glm-4.6v')
    assert.equal(body.messages[0].role, 'user')
    assert.ok(Array.isArray(body.messages[0].content))
    assert.ok(body.messages[0].content.some((c) => c.type === 'image_url'))
    assert.ok(body.messages[0].content.some((c) => c.type === 'text'))
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: 'a green button in the top-left corner' } }] }),
    }
  }
  try {
    const tool = toolByName(registered, 'vision_describe')
    const first = await tool.execute({ paths: [src], question: 'what is in this image?' }, exec)
    assert.equal(first, 'a green button in the top-left corner')
    assert.equal(fetchCalls, 1)
    // Cache hit: second identical call must not hit the network.
    const second = await tool.execute({ paths: [src], question: 'what is in this image?' }, exec)
    assert.equal(second, first)
    assert.equal(fetchCalls, 1)

    // json mode: mock returns non-JSON, the tool retries once then falls back.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    })
    const jsonResult = await tool.execute({ paths: [src], question: 'summarize', json: true }, exec)
    assert.match(jsonResult, /did not produce valid JSON/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('vision_describe returns a structured ok:false failure without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-tools-'))
  const { ctx, registered, exec, getConfig } = mockEnv(dir)
  resetVisionCacheForTests()
  registerVisionTools(ctx, getConfig)
  const src = join(dir, 'pic.png')
  await writeFile(src, PNG_BYTES)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ error: { message: 'invalid api key' } }),
  })
  try {
    const result = await toolByName(registered, 'vision_describe').execute(
      { paths: [src], question: 'describe' },
      exec,
    )
    const parsed = JSON.parse(result)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.code, 'VISION_BACKEND_UNAVAILABLE')
    assert.match(parsed.message, /401/)
  } finally {
    globalThis.fetch = realFetch
  }
})

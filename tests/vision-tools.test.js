import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IMAGE_EXTENSIONS,
  mediaTypeOf,
  sniffMediaType,
  isAttachmentIdInput,
  sha256Of,
  createCache,
  downscaleImage,
  parseModelJson,
  artifactStemOf,
  bytesToDataUrl,
  CONTENT_FILTER_RE,
} from '../lib/vision-tools.js'

// 1x1 PNG (89 50 4E 47 ...)
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex')

test('sniffMediaType detects png/jpeg/webp/gif by magic bytes', () => {
  assert.equal(sniffMediaType(PNG_BYTES), 'image/png')
  const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(16)])
  assert.equal(sniffMediaType(jpeg), 'image/jpeg')
  const webp = Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.alloc(4), Buffer.from('57454250', 'hex'), Buffer.alloc(4)])
  assert.equal(sniffMediaType(webp), 'image/webp')
  const gif = Buffer.concat([Buffer.from('47494638', 'hex'), Buffer.alloc(8)])
  assert.equal(sniffMediaType(gif), 'image/gif')
  assert.equal(sniffMediaType(Buffer.alloc(16)), undefined)
  assert.equal(sniffMediaType(Buffer.alloc(4)), undefined) // too short
})

test('mediaTypeOf maps extensions case-insensitively', () => {
  assert.equal(mediaTypeOf('a.PNG'), 'image/png')
  assert.equal(mediaTypeOf('a.jpeg'), 'image/jpeg')
  assert.equal(mediaTypeOf('noext'), undefined)
})

test('isAttachmentIdInput accepts durable ids only', () => {
  assert.equal(isAttachmentIdInput('sha256:' + 'a'.repeat(64)), true)
  assert.equal(isAttachmentIdInput('sha256:abc123'), false) // too short
  assert.equal(isAttachmentIdInput('C:\\x\\y.png'), false)
  assert.equal(isAttachmentIdInput(''), false)
})

test('sha256Of is stable', () => {
  const a = sha256Of(PNG_BYTES)
  const b = sha256Of(PNG_BYTES)
  assert.equal(a, b)
  assert.equal(a.length, 64)
})

test('createCache honors TTL and LRU bound', async () => {
  const cache = createCache(2, 50)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3) // evicts LRU (b)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.get('a'), 1)
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(cache.get('a'), undefined) // expired
  // TTL eviction is lazy (router semantics): the entry is gone after a get
  assert.equal(cache.get('c'), undefined)
  assert.equal(cache.size(), 0)
})

test('downscaleImage leaves small images untouched and shrinks huge ones', async () => {
  const small = PNG_BYTES
  const result = await downscaleImage(small, 4_000_000)
  assert.equal(result, small) // same reference, no resize needed
  // Build a large synthetic image via sharp (available in dev/test envs)
  const sharp = (await import('sharp')).default
  const big = await sharp({
    create: { width: 4000, height: 3000, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  }).png().toBuffer()
  const resized = await downscaleImage(big, 1_000_000)
  assert.notEqual(resized, big)
  const meta = await sharp(resized).metadata()
  assert.ok(meta.width * meta.height <= 1_000_000)
  // undefined input passes through
  assert.equal(await downscaleImage(undefined, 1000), undefined)
})

test('parseModelJson strips fences and extracts the first balanced block', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 })
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseModelJson('prefix [1,2,3] suffix'), [1, 2, 3])
  assert.deepEqual(parseModelJson('text {"nested":{"x":[1]}} tail'), { nested: { x: [1] } })
  assert.equal(parseModelJson('no json here'), undefined)
  assert.equal(parseModelJson(''), undefined)
})

test('artifactStemOf is stable and sanitized', () => {
  const a = artifactStemOf('C:\\x\\设计稿 v2.png', 'crop')
  assert.equal(a, artifactStemOf('C:\\x\\设计稿 v2.png', 'crop'))
  assert.ok(!a.includes(' '))
  assert.ok(a.endsWith('-crop'))
})

test('bytesToDataUrl embeds base64 with the right mime', () => {
  const url = bytesToDataUrl(Buffer.from([1, 2, 3]), 'image/png')
  assert.ok(url.startsWith('data:image/png;base64,'))
  const roundtrip = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
  assert.deepEqual(roundtrip, Buffer.from([1, 2, 3]))
})

test('bytesToDataUrl handles Uint8Array from the attachment service (regression)', () => {
  // attachments.readImage returns Uint8Array; toString('base64') on it is a
  // comma-joined number list, which made GLM reject every describe call.
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const url = bytesToDataUrl(bytes, 'image/png')
  assert.ok(url.startsWith('data:image/png;base64,'))
  const b64 = url.slice('data:image/png;base64,'.length)
  const decoded = Buffer.from(b64, 'base64')
  assert.deepEqual([...decoded], [...bytes])
  assert.ok(!b64.includes(','), 'base64 payload must not contain the Uint8Array comma-join artifact')
})

test('IMAGE_EXTENSIONS covers the documented set', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']) {
    assert.ok(IMAGE_EXTENSIONS[ext], `missing ${ext}`)
  }
})

test('CONTENT_FILTER_RE recognizes endpoint content-safety rejections', () => {
  assert.ok(CONTENT_FILTER_RE.test('vision endpoint returned 400: 系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语'))
  assert.ok(CONTENT_FILTER_RE.test('content_filter triggered'))
  assert.ok(CONTENT_FILTER_RE.test('The image was flagged by our safety policy'))
  assert.ok(CONTENT_FILTER_RE.test('inappropriate content detected'))
  assert.ok(!CONTENT_FILTER_RE.test('vision endpoint returned 401: invalid api key'))
  assert.ok(!CONTENT_FILTER_RE.test('vision endpoint returned 500: upstream error'))
  assert.ok(!CONTENT_FILTER_RE.test('image too large: 5000000 bytes'))
})

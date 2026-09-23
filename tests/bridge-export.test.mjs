import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { exportImage } from "../index.js";

test("bridge exports colon-bearing IDs as distinct, nonempty portable files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-vision-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "new-export-dir");
  const first = { attachmentId: `sha256:${"a".repeat(64)}`, mediaType: "image/png", name: "image.png" };
  const second = { attachmentId: `sha256:${"a".repeat(63)}b`, mediaType: "image/png", name: "image.png" };
  const bytes = new Map([
    [first.attachmentId, Buffer.from([1, 2, 3])],
    [second.attachmentId, Buffer.from([4, 5, 6, 7])],
  ]);
  let reads = 0;
  const ctx = { attachments: { async readImage(attachment) {
    reads++;
    return { data: bytes.get(attachment.attachmentId) };
  } } };

  const firstPath = await exportImage(first, ctx, dir);
  const secondPath = await exportImage(second, ctx, dir);
  assert.notEqual(firstPath, secondPath);
  for (const [path, data] of [[firstPath, bytes.get(first.attachmentId)], [secondPath, bytes.get(second.attachmentId)]]) {
    assert.match(basename(path), /^image_[a-f0-9]{24}\.png$/);
    assert.deepEqual(await readFile(path), data);
    assert.equal((await stat(path)).size, data.length);
  }
  assert.equal((await readdir(dir)).length, 2);
  assert.equal(await exportImage(first, ctx, dir), firstPath);
  assert.equal(reads, 2);

  const otherDir = join(root, "other-export-dir");
  const otherPath = await exportImage(first, ctx, otherDir);
  assert.notEqual(otherPath, firstPath);
  assert.deepEqual(await readFile(otherPath), bytes.get(first.attachmentId));
});

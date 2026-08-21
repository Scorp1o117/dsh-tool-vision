import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('settings scope refresh is compatible with DSH rc7 through 0.1.1-rc.1', () => {
  assert.doesNotMatch(clientSource, /^\s*scope\.load\(\);\s*$/m);
  assert.match(clientSource, /typeof scope\.load === ["']function["']/);

  const refresh = new Function('scope', 'if (typeof scope.load === "function") scope.load();');
  assert.doesNotThrow(() => refresh({}));

  let calls = 0;
  refresh({ load() { calls += 1; } });
  assert.equal(calls, 1);
});

test('package requires a DSH host that exposes plugin settings natively', () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    assert.equal(range, '^0.1.0-rc.7 || ^0.1.1-rc.1');
    assert.doesNotMatch(range, /rc\.6/);
  }
});


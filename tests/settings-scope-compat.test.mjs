import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('manifest records verified DSH latest and next without claiming alpha', () => {
  const compatibility = manifest.dsh.compatibility;
  assert.equal(compatibility.dshReleases['0.1.5-rc.2'], 'incompatible');
  assert.equal(compatibility.dshReleases['0.1.5-rc.3'], 'incompatible');
  assert.equal(compatibility.dshReleases['0.1.7-rc.1'], 'compatible');
  for (const version of ['0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2']) {
    assert.equal(compatibility.dshReleases[version], 'unknown');
  }
  assert.equal(compatibility.node, manifest.engines.node);
  assert.deepEqual(compatibility.profiles, ['web']);
});

test('the client calls only methods the SettingsScope seam defines', () => {
  // The full seam is getSnapshot / subscribe / mutate / set / unset
  // (packages/client/ui-settings/src/client/settings-contract.ts). It has NEVER
  // had `load()`: reads ride the shared describe mirror, which re-reads on every
  // Host `settings/document-updated`. The guarded
  // `if (typeof scope.load === "function") scope.load()` calls that used to sit
  // at every write site were therefore dead code — they read like a refresh that
  // never happened, and they made the missing write-verification look intentional.
  const allowed = new Set(['getSnapshot', 'subscribe', 'mutate', 'set', 'unset']);
  // scan code only: the rationale above legitimately names the removed call
  const codeOnly = clientSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const called = [...codeOnly.matchAll(/scope\.(\w+)\(/g)].map((m) => m[1]);
  const unknown = [...new Set(called)].filter((name) => !allowed.has(name));
  assert.deepEqual(unknown, [], `unknown scope methods: ${unknown.join(', ')}`);
});

test('section unmount must not dispose the plugin-shared settings scope', () => {
  // The settings scope is bound once in the plugin apply() and shared across
  // every mount of the section. Disposing it on a section unmount leaves a
  // `disposed` scope whose write queue no-ops on the next remount, so saves
  // silently vanish and the edited value reverts on the next describe.
  assert.doesNotMatch(clientSource, /if \(scope\.dispose\) scope\.dispose\(\)/);
  assert.doesNotMatch(clientSource, /scope\.dispose\(\)/);
});

test('package requires the DSH configForms host', () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    assert.equal(range, '^0.1.7-rc.1');
  }
});


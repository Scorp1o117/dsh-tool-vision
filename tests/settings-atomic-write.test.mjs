import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const hostSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('save path is one atomic mutation, not parallel per-field writes', () => {
  // Parallel scope.set()/unset() calls each carry their own revision fence. A
  // fence behind the Host document is refused with `settings/conflict`, and a
  // refused write still RESOLVES — the scope contract is "settle after any
  // recovery read", not "throw on refusal". The section therefore reported
  // "Saved" while every edit silently reverted. One mutate() carries one fence.
  assert.match(clientSource, /scope\.mutate\(ops, scope\.getSnapshot\(\)\.revision\)/);
  assert.doesNotMatch(clientSource, /Promise\.all\(FIELDS\.map/);
  assert.doesNotMatch(clientSource, /Promise\.all\(writes\)/);
});

test('a settled write is verified against the namespace section', () => {
  // Because a refused write resolves, inspecting the section afterwards is the
  // only way to tell a committed change from a refused one.
  assert.match(clientSource, /function opsApplied\(ops, snap\)/);
  assert.match(clientSource, /return opsApplied\(ops, scope\.getSnapshot\(\)\)/);
  assert.match(clientSource, /t\("notApplied"\)/);
});

test('hosts without mutate() still write in order, never in parallel', () => {
  assert.match(clientSource, /typeof scope\.mutate === "function"/);
  assert.match(clientSource, /ops\.reduce\(function \(chain, op\)/);
});

test('the master switch is a hot child fiber, not a restart-time flag', () => {
  assert.match(hostSource, /enabled: z\.boolean\(\)\.default\(true\)/);
  assert.match(hostSource, /featureFiber = ctx\.plugin\(/);
  assert.match(hostSource, /Promise\.resolve\(fiber\.dispose\(\)\)/);
  // Registrations are effects on the fiber that makes them, so the switch works
  // only if the tool/bridge/route registrations really moved into the child.
  assert.match(hostSource, /inner\.tools\.register\(defineTool\(/);
  assert.match(hostSource, /registerVisionTools\(inner, getConfig\)/);
  assert.match(hostSource, /attachPreStepBridge\(inner, getConfig, exportDir\)/);
});

test('the settings registration outlives the switch it controls', () => {
  // It stays on the parent fiber: if it were disposed with the features, the
  // section that turns the plugin back on would vanish with them.
  assert.match(hostSource, /ctx\.inject\(\["settings"\], \(sctx\) => \{/);
  assert.match(hostSource, /sctx\.effect\(\(\) => \(\) => uninstallFeatures\(\)\)/);
  const rejectAt = hostSource.indexOf('installAutoImageAdmission(inner.get("llm")');
  const settingsAt = hostSource.indexOf('sctx.settings.register(');
  assert.ok(rejectAt > 0 && settingsAt > 0);
});

test('registration-gating fields re-install the child fiber', () => {
  assert.match(hostSource, /REGISTRATION_KEYS = \[/);
  for (const key of ['enabled', 'bridgeTextOnly', 'bridgeExportDir', 'bridgeAutoImage', 'bridgePreview']) {
    assert.ok(hostSource.includes(`"${key}"`), `missing gating key ${key}`);
  }
  assert.match(hostSource, /scope\.watch\(\(\) => syncFeatures\(\)\)/);
});

test('the one-click switch writes only the enabled field', () => {
  assert.match(clientSource, /function onToggleEnabled\(\)/);
  assert.match(clientSource, /commit\(\[\{ op: "set", path: \["enabled"\], value: next \}\]\)/);
  assert.match(clientSource, /onClick: onToggleEnabled/);
});

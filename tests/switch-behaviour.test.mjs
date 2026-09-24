import assert from 'node:assert/strict';
import test from 'node:test';
import z from '@deepseek-ai/schemastery';

import { Config, apply } from '../index.js';

/**
 * Minimal cordis context: records tool registrations, runs child plugins on a
 * fresh child context, and provides no settings service (the composition-entry
 * path). Enough to observe which registrations `apply` makes.
 */
function harness() {
  const tools = [];
  const listeners = [];
  const make = () => ({
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    effect(fn) {
      const disposer = typeof fn === "function" ? fn() : undefined;
      return () => { if (typeof disposer === "function") disposer(); };
    },
    on(event) { listeners.push(event); return () => {}; },
    inject() { /* no settings provider on this path */ },
    get() { return undefined; },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    plugin(child) {
      child.apply(make(), undefined);
      return { dispose: async () => {} };
    },
  });
  return { ctx: make(), tools, listeners };
}

const cfg = (over = {}) => ({ ...z.resolve({}, Config)[0].get(), ...over });

test('enabled=false registers nothing at all', () => {
  const { ctx, tools, listeners } = harness();
  apply(ctx, cfg({ enabled: false }));
  assert.deepEqual(tools, [], "no tool may reach the model while the switch is off");
  assert.ok(!listeners.includes("agent/pre-step"), "no pre-step listener may stay attached");
});

test('enabled=true registers inspect_image plus the pixel-level tools', () => {
  const { ctx, tools } = harness();
  apply(ctx, cfg({ enabled: true, bridgeTextOnly: false }));
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("inspect_image"), `got ${names.join(", ")}`);
  assert.ok(names.length > 5, `expected the ported vision_* tools, got ${names.length}`);
});

test('the master switch is the only thing that decides whether tools appear', () => {
  const off = harness();
  apply(off.ctx, cfg({ enabled: false, bridgeTextOnly: true, bridgeAutoImage: true, bridgePreview: true }));
  const on = harness();
  apply(on.ctx, cfg({ enabled: true, bridgeTextOnly: true, bridgeAutoImage: true, bridgePreview: true }));
  assert.equal(off.tools.length, 0, "bridge flags must not resurrect a disabled plugin");
  assert.ok(on.tools.length > 0);
  assert.ok(!off.listeners.includes("agent/pre-step") && on.listeners.includes("agent/pre-step"), "the pre-step bridge is a listener");
});

test('bridge switches gate their own registrations', () => {
  const without = harness();
  apply(without.ctx, cfg({ enabled: true, bridgeTextOnly: false }));
  const withBridge = harness();
  apply(withBridge.ctx, cfg({ enabled: true, bridgeTextOnly: true }));
  assert.ok(!without.listeners.includes("agent/pre-step"));
  assert.ok(withBridge.listeners.includes("agent/pre-step"));
});

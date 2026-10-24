
## 2026-10-17: 0.10.2, DSH 0.2.1-rc.1

- Full npm test command passed in a fresh npm dependency tree using the published DSH 0.2.1-rc.1 packages (86 Node test-runner cases, plus any script assertions). No skipped test-runner cases.
- Packed package installed with the official DSH CLI into an isolated Web profile. Configuration composition succeeded; the Web service started and authenticated HTTP returned 200. All six plugin bundles appeared enabled in the running UI.
- engines.dsh and every DSH peer range accept 0.2.0-rc.2 and 0.2.1-rc.1; unverified 0.2.1 alpha releases remain excluded.
- Reasoning page was opened, left, reopened, edited, saved, and refreshed. The saved value persisted and automatic reasoning augmentation remained off. Backend regressions cover repeated reconciliation after native removal, explicit opt-in, preserved custom declarations, and gateway-only writes.
- New packaged Desktop 0.2.1 was not exercised; these results verify Web. Motion UI was excluded from the adaptation.

## 2026-10-17: 0.10.3, DSH 0.2.1-rc.2

- Full npm test passed in fresh dependencies using published DSH 0.2.1-rc.2 packages: 86 Node test-runner cases plus script assertions, with no failed or skipped cases.
- Official CLI installed the packed plugins in an isolated Web profile. Configuration composition, service startup and authenticated HTTP 200 passed.
- engines.dsh and DSH peer ranges accept 0.2.0-rc.2, 0.2.1-rc.1 and 0.2.1-rc.2, while unverified alpha releases remain excluded.
- Source comparison found no change to the tool, system-prompt, settings or pi-ai interfaces used by these plugins. Native reasoning settings retain the opt-in augmentation policy.
- This verification covers Web. Motion UI and the Desktop application are handled separately. No real-model generation was requested.

## 2026-10-24: 0.10.4, DSH 0.2.1-rc.3

- Full npm test passed in fresh dependencies using published DSH 0.2.1-rc.3 packages: 86 Node test-runner cases plus script assertions, with no failed or skipped cases.
- Official CLI installed the packed plugin in an isolated Web profile built from the shipped web template. Configuration composition, service startup and authenticated HTTP 200 passed.
- engines.dsh and DSH peer ranges accept 0.2.0-rc.2, 0.2.1-rc.1, 0.2.1-rc.2 and 0.2.1-rc.3, while unverified alpha releases remain excluded.
- Source comparison of dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3 found no change to the tool, settings or pi-ai interfaces used by this plugin; the removed ctx.layout.entryVisibility and agentPresetNavigation APIs were not in use.
- This verification covers Web. The Desktop application was not exercised. No real-model generation was requested.

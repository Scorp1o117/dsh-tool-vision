import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);

function load() {
  let bundle, dictionaries;
  const entries = [];
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { bundle = value; } } } });
  let active = 'en';
  const locale = {
    register(_ns, value) { dictionaries = value; return () => {}; },
    bind() { return (key, params) => {
      const template = dictionaries[active]?.[key] ?? dictionaries.en[key] ?? key;
      return params ? template.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : template;
    }; }
  };
  const scope = { getSnapshot: () => ({ status: 'ready', value: {} }) };
  const plugin = bundle.factory(() => ({ createElement: (type, props) => ({ type, props }) }));
  plugin.apply({ locale, effect: (fn, label) => label?.includes('bridge preview scanner') ? () => {} : fn(),
    configForms: { get: () => scope }, connection: {},
    slots: { inject: (_name, fn) => fn(), register: (spec, render) => { entries.push({ spec, render }); return () => {}; } }
  });
  return { entries, locale, dictionaries, setLanguage: id => { active = id; } };
}

test('all shipped DSH languages have matching copy and interpolation parameters', () => {
  const { dictionaries } = load();
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh']);
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort());
  for (const key of Object.keys(dictionaries.en)) {
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.equal(typeof dictionaries.en[key], 'string', key);
    assert.equal(typeof dictionaries.zh[key], 'string', key);
    assert.deepEqual(placeholders(dictionaries.en[key]), placeholders(dictionaries.zh[key]), key);
  }
});

test('plugin page owns its translation binding and follows the host fallback', () => {
  const ui = load();
  const page = ui.entries.find(entry => entry.spec.name === 'plugins.bundle.config');
  const node = page.render({ t: () => 'wrong namespace' });
  assert.equal(node.props.locale, ui.locale);
  assert.equal(node.props.t('save'), ui.dictionaries.en.save ?? 'save');
  ui.setLanguage('zh');
  assert.equal(node.props.t('nav'), ui.dictionaries.zh.nav ?? 'nav');
  ui.setLanguage('fr');
  assert.equal(node.props.t('nav'), ui.dictionaries.en.nav ?? 'nav');
  if (manifest.name === 'dsh-soul-md') {
    ui.setLanguage('zh');
    assert.equal(node.props.t('confirmDelete', { name: 'A' }), '删除人设卡“A”？');
  }
});

test('localized plugin titles and descriptions resolve through package exports', async () => {
  assert.ok(manifest.files.includes('locale'));
  for (const id of ['zh', 'en']) {
    const file = require.resolve(`${manifest.name}/locale/${id}.json`);
    const { meta } = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(meta.title.trim());
    assert.ok(meta.description.trim());
    if (id === 'en') assert.doesNotMatch(meta.title + meta.description, /\p{Script=Han}/u);
  }
});

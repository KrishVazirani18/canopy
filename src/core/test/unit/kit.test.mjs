// Canopy Kit (plugin.mjs, resources/canopy-kit): a second plugin beside Canopy's own. With the kit on, a Claude chat
// is handed both plugins and told the kit exists; a Codex chat is told both skills folders and the same line. Off,
// neither the kit nor the line is there. Against the scripted fakes of the SDK and of the Codex app-server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { createFake } from '../fake-query.mjs';
import { CORE, core, watch, within } from '../helpers.mjs';

const [P, S, X, F] = await Promise.all(['plugin.mjs', 'session.mjs', 'codex-session.mjs', 'facts.mjs'].map((f) => core(f)));
const missing = [P, S, X, F].find((m) => m.__missing)?.__missing ?? false;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-kit-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const open = [];
afterEach(async () => { for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } } });

const PLUGIN = path.resolve(CORE, '..', '..', 'resources', 'canopy-plugin');
const KIT = path.resolve(CORE, '..', '..', 'resources', 'canopy-kit');
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });

function claude(opts = {}) {
  const fake = createFake();
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}

function codex(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  const s = new X.CodexSession({ cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: home }, spawnFn: fake.spawnFn, log: () => {}, timeouts: { restart: 15, secondPress: 0 }, ...opts });
  open.push(s);
  return { s, fake };
}

test('the kit is its own folder, named canopy-kit, with the design skills', { skip: missing }, () => {
  assert.equal(P.kitDir(), KIT);
  assert.equal(P.kitDir('/Applications/Canopy.app/Contents/Resources/app.asar'), '/Applications/Canopy.app/Contents/Resources/app.asar.unpacked/resources/canopy-kit');
  const manifest = JSON.parse(fs.readFileSync(path.join(KIT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, P.KIT_NAME);
  assert.equal(manifest.name, 'canopy-kit');
  assert.deepEqual(P.canopyPlugin(KIT), { dir: KIT, skillsDir: path.join(KIT, 'skills'), skills: ['design', 'design-taste'] });
  for (const name of ['design', 'design-taste']) {
    const text = fs.readFileSync(path.join(KIT, 'skills', name, 'SKILL.md'), 'utf8');
    const m = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(m, `${name}: a two-line frontmatter, the description on one line`);
    assert.equal(m[1], name);
    assert.ok(!/—/.test(text), `${name}: no em dashes`);
    assert.ok(!/canopy:design/.test(text), `${name}: names its sibling under the kit's prefix`);
  }
});

test('a Claude chat with the kit is handed both plugins and told the kit is on', { skip: missing }, async () => {
  const { s, fake, w } = claude({ canopyKit: true });
  s.send('hello');
  await idle(w);
  assert.deepEqual(fake.current.options.plugins, [{ type: 'local', path: PLUGIN }, { type: 'local', path: KIT }]);
  assert.ok(fake.current.options.systemPrompt.append.startsWith(F.CANOPY_FACTS), 'the facts stay first and unchanged');
  assert.ok(fake.current.options.systemPrompt.append.includes(P.KIT_NOTE));
});

test('a Claude chat without the kit: neither the plugin nor the line', { skip: missing }, async () => {
  for (const canopyKit of [undefined, false, path.join(root, 'nowhere')]) {
    const { s, fake, w } = claude({ canopyKit });
    s.send('hello');
    await idle(w);
    assert.deepEqual(fake.current.options.plugins, [{ type: 'local', path: PLUGIN }]);
    assert.equal(fake.current.options.systemPrompt.append, F.CANOPY_FACTS);
  }
});

test('a Codex chat with the kit is told both skills folders and the same line; without it, neither', { skip: missing }, async () => {
  const on = codex({ canopyKit: true });
  await on.s.warm();
  assert.deepEqual(on.fake.sent('skills/extraRoots/set').map((m) => m.params), [{ extraRoots: [path.join(PLUGIN, 'skills'), path.join(KIT, 'skills')] }]);
  assert.equal(on.fake.sent('thread/start')[0].params.developerInstructions, `${F.CANOPY_FACTS_NEUTRAL}\n- ${P.KIT_NOTE}`);

  const off = codex({ canopyKit: false });
  await off.s.warm();
  assert.deepEqual(off.fake.sent('skills/extraRoots/set').map((m) => m.params), [{ extraRoots: [path.join(PLUGIN, 'skills')] }]);
  assert.equal(off.fake.sent('thread/start')[0].params.developerInstructions, F.CANOPY_FACTS_NEUTRAL);

  const bare = codex({ canopyPlugin: false, canopyKit: true });
  await bare.s.warm();
  assert.deepEqual(bare.fake.sent('skills/extraRoots/set').map((m) => m.params), [{ extraRoots: [path.join(KIT, 'skills')] }], 'the kit does not need Canopy\'s own plugin');
});

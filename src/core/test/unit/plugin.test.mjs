// Canopy's own plugin (plugin.mjs, resources/canopy-plugin): the folder is what both makers' programs can load, a
// Claude chat is handed it as a local plugin, and a Codex chat is told its skills folder before the thread opens.
// Against the scripted fakes of the SDK and of the Codex app-server: no Claude Code or Codex is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { createFake } from '../fake-query.mjs';
import { CORE, core, watch, within } from '../helpers.mjs';

const [P, S, X] = await Promise.all(['plugin.mjs', 'session.mjs', 'codex-session.mjs'].map((f) => core(f)));
const missing = [P, S, X].find((m) => m.__missing)?.__missing ?? false;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-plugin-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const open = [];
afterEach(async () => { for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } } });

const DIR = path.resolve(CORE, '..', '..', 'resources', 'canopy-plugin');
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });

/** A SKILL.md as { name, description, body }, read the way both makers do: a frontmatter of `key: value` lines. */
function readSkill(name) {
  const text = fs.readFileSync(path.join(DIR, 'skills', name, 'SKILL.md'), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${name}/SKILL.md starts with a frontmatter block`);
  const front = Object.fromEntries(m[1].split('\n').map((line) => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
  return { ...front, body: m[2], lines: m[1].split('\n').length };
}

function claude(opts = {}) {
  const fake = createFake();
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}

function codex(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  const logs = [];
  const s = new X.CodexSession({ cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: home }, spawnFn: fake.spawnFn, log: (level, msg, data) => logs.push({ level, msg, data }), timeouts: { restart: 15, secondPress: 0 }, ...opts });
  open.push(s);
  return { s, fake, w: watch(s), logs };
}

// ---- the folder ----

test('the plugin is one folder with a manifest named canopy and its skill', { skip: missing }, () => {
  assert.equal(P.pluginDir(), DIR, 'found from where the code is, not from the working folder');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, P.PLUGIN_NAME);
  assert.equal(manifest.name, 'canopy', 'the name both makers file the skill under: canopy:canopy');
  assert.ok(manifest.description && manifest.version);
  assert.deepEqual(P.canopyPlugin(), { dir: DIR, skillsDir: path.join(DIR, 'skills'), skills: ['canopy'] });
});

// What rides in every chat is each skill's name and description and nothing else, so these are the part with a
// budget. Both makers read the frontmatter as plain `key: value` lines: a description that wraps, or holds a ": ",
// is read differently by each.
test('each skill has a name that is its folder and a one-line description that says when to load it', { skip: missing }, () => {
  for (const name of ['canopy']) {
    const skill = readSkill(name);
    assert.equal(skill.name, name);
    assert.equal(skill.lines, 2, 'name and description, one line each');
    assert.ok(skill.description.length >= 80 && skill.description.length <= 320, `${name}: ${skill.description.length} characters`);
    assert.ok(!skill.description.includes(': '), 'no ": " inside the description: YAML would read it as a key');
    assert.match(skill.description, /\bLoad (after|when)\b/);
  }
  assert.match(readSkill('canopy').description, /Load when the user asks how Canopy works or about its settings/);
});

test('the body is short and names what the user asks about', { skip: missing }, () => {
  const canopy = readSkill('canopy');
  assert.ok(canopy.body.length < 5000, `canopy is ${canopy.body.length} characters`);
  for (const word of ['Code Mode', 'Ask Before Edits', 'Full Access', 'Multi mode', '`look`', '`read_chat`', '~/.claude/projects/', '~/.codex/sessions/', 'Settings > Accounts', 'sign in with Google', 'Application Support/Canopy', '`remember`', '`recall`', '`forget`', 'Settings > You > Memory']) {
    assert.ok(canopy.body.includes(word), `canopy names ${word}`);
  }
});

test('a missing folder is no plugin, never an error; inside a packaged app the unpacked twin is named', { skip: missing }, () => {
  assert.equal(P.canopyPlugin(path.join(root, 'nowhere')), null);
  assert.equal(P.canopyPlugin('relative/path'), null);
  assert.equal(P.canopyPlugin(null), null);
  assert.equal(P.claudePlugins(null), undefined);
  assert.deepEqual(P.codexSkillRoots(null), []);
  // A plugin with nothing for Codex (no skills folder) is still a plugin for Claude Code.
  const bare = path.join(root, 'bare');
  fs.mkdirSync(path.join(bare, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(bare, '.claude-plugin', 'plugin.json'), '{"name":"canopy"}');
  assert.deepEqual(P.canopyPlugin(bare), { dir: bare, skillsDir: path.join(bare, 'skills'), skills: [] });
  assert.deepEqual(P.claudePlugins(P.canopyPlugin(bare)), [{ type: 'local', path: bare }]);
  assert.deepEqual(P.codexSkillRoots(P.canopyPlugin(bare)), []);
  // Claude Code and Codex cannot read inside app.asar.
  assert.equal(P.pluginDir('/Applications/Canopy.app/Contents/Resources/app.asar'), '/Applications/Canopy.app/Contents/Resources/app.asar.unpacked/resources/canopy-plugin');
  assert.equal(P.pluginDir('/Users/me/canopy'), '/Users/me/canopy/resources/canopy-plugin');
});

// ---- a Claude chat ----

test('a Claude chat is handed the folder as a local plugin, at every start and in a folder that is not trusted', { skip: missing }, async () => {
  const { s, fake, w } = claude();
  s.send('hello');
  await idle(w);
  assert.deepEqual(fake.current.options.plugins, [{ type: 'local', path: DIR }]);
  await s.stop();
  const mark = w.mark();
  s.send('more');
  await idle(w, mark);
  assert.equal(fake.starts, 2);
  assert.deepEqual(fake.current.options.plugins, [{ type: 'local', path: DIR }], 'a later process of the chat is handed the same');

  // The skills are Canopy's, not the project's: an untrusted project loses its own settings and keeps them.
  const wary = claude({ trusted: false });
  wary.s.send('hello');
  await idle(wary.w);
  assert.deepEqual(wary.fake.current.options.settingSources, ['user']);
  assert.deepEqual(wary.fake.current.options.plugins, [{ type: 'local', path: DIR }]);
});

test('a Claude chat without the plugin: turned off by the host, or the folder left out of the build', { skip: missing }, async () => {
  for (const canopyPlugin of [false, path.join(root, 'nowhere')]) {
    const { s, fake, w } = claude({ canopyPlugin });
    s.send('hello');
    await idle(w);
    assert.ok(!('plugins' in fake.current.options), 'nothing is named: Claude Code would report a folder that is not there');
  }
});

// ---- a Codex chat ----

test('a Codex chat is told the skills folder before its thread opens, new or reopened, and nothing else changes', { skip: missing }, async () => {
  const fresh = codex();
  await fresh.s.warm();
  const methods = fresh.fake.received.map((m) => m.method);
  assert.deepEqual(fresh.fake.sent('skills/extraRoots/set').map((m) => m.params), [{ extraRoots: [path.join(DIR, 'skills')] }]);
  assert.ok(methods.indexOf('skills/extraRoots/set') < methods.indexOf('thread/start'), 'Codex lists the skills for the model when the thread opens');
  assert.deepEqual(fresh.fake.skillRoots, [path.join(DIR, 'skills')]);
  // The user's Codex is left as it is: no -c flag, and no call that writes their config.
  assert.deepEqual(fresh.fake.last.args, ['app-server', '--listen', 'stdio://']);
  assert.ok(!methods.some((m) => /^skills\/config|^config\/(value|batch)?write/i.test(m)));

  const CHAT = '00000000-0000-7000-8000-432d1c714b94';
  const again = codex({ resume: CHAT }, { known: [CHAT] });
  await again.s.warm();
  const order = again.fake.received.map((m) => m.method);
  assert.ok(order.indexOf('skills/extraRoots/set') !== -1 && order.indexOf('skills/extraRoots/set') < order.indexOf('thread/resume'));
});

test('a Codex that does not know the call, or never answers it, still opens the chat', { skip: missing }, async () => {
  const old = codex({}, { errors: { 'skills/extraRoots/set': { code: -32601, message: 'Method not found: skills/extraRoots/set' } } });
  assert.equal((await old.s.warm()).ok, true);
  assert.equal(old.fake.sent('thread/start').length, 1);
  assert.ok(old.logs.some((l) => l.level === 'warn' && /skills/.test(l.msg)), 'said in the log, never to the user');
  assert.equal(old.w.all((e) => e.kind === 'error' || e.kind === 'notice').length, 0);

  const mute = codex({ timeouts: { restart: 15, secondPress: 0, meta: 60 } }, { hang: new Set(['skills/extraRoots/set']) });
  assert.equal((await mute.s.warm()).ok, true);
  assert.equal(mute.fake.sent('thread/start').length, 1);
});

test('a Codex chat without the plugin never makes the call', { skip: missing }, async () => {
  for (const canopyPlugin of [false, path.join(root, 'nowhere')]) {
    const { s, fake } = codex({ canopyPlugin });
    await s.warm();
    assert.equal(fake.sent('skills/extraRoots/set').length, 0);
    assert.equal(fake.sent('thread/start').length, 1);
  }
});

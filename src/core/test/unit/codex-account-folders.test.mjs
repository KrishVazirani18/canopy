// codex-account-folders.mjs: adding a second Codex login in a folder of its own, the guard before every launch on it,
// and removing it. Everything runs in throwaway folders against the scripted Codex (fake-codex.mjs): "the user's Codex
// folder" is a made-up one under the temp folder, and nobody is signed in or out of anything real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CodexAccountFolders } from '../../../codex-account-folders.mjs';
import { folderEnv } from '../../accounts-codex-home.mjs';
import { CodexService } from '../../codex-host.mjs';
import { createFakeCodex } from '../fake-codex.mjs';
import { fakeCodexMac, put, snapshot } from '../account-world.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-account-folders-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
assert.ok(tmp.startsWith(fs.realpathSync(os.tmpdir())) && !tmp.includes('.canopy'));

const ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/test' };
const timeouts = { init: 1000, request: 2000, list: 1000, history: 1000, login: 5000 };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(); } }

// A registry with just what the folders use, holding Codex's own login first.
function registry(list = [{ engine: 'codex', id: 'codex-default', kind: 'key', email: null }]) {
  const r = {
    list: list.map((a) => ({ ...a })), removed: [],
    add(a) { if (r.list.some((x) => x.id === a.id)) return { ok: false }; r.list.push({ ...a }); return { ok: true, id: a.id }; },
    note(id, answer) { const a = r.list.find((x) => x.id === id); if (a) Object.assign(a, answer); },
    remove(engine, id) { const before = r.list.length; r.list = r.list.filter((x) => x.id !== id); r.removed.push(id); return before === r.list.length ? { ok: false } : { ok: true }; },
    get(engine, id) { const a = r.list.find((x) => x.engine === engine && x.id === id); return a ? { ...a } : null; },
    entries(engine) { return r.list.filter((x) => x.engine === engine).map((x) => ({ ...x })); },
  };
  return r;
}

let seq = 0;
function world({ list, codexHome } = {}) {
  const W = fakeCodexMac(path.join(tmp, `w${++seq}`));
  const reg = registry(list);
  const fakes = new Map(); // one scripted Codex per account folder, so each login has its own answers
  const fakeFor = (dir) => { if (!fakes.has(dir)) fakes.set(dir, createFakeCodex({ account: null, requiresAuth: true })); return fakes.get(dir); };
  const services = [];
  const opened = [];
  const own = { filed: false, filedUnder: async () => ({ ok: true, found: own.filed, complete: true }) };
  const views = [];
  const folders = new CodexAccountFolders({
    accounts: () => reg, root: () => W.root, codexHome: async () => codexHome === undefined ? W.base : codexHome,
    service: (dir) => {
      const fake = fakeFor(dir);
      const s = new CodexService({
        codexPath: '/fake/codex', env: () => ENV, spawnFn: fake.spawnFn, timeouts, lingerMs: 50, home: dir,
        launch: (base) => ({ env: folderEnv({ dir }, base, { codexHome: W.base }), config: {} }),
      });
      services.push(s);
      return s;
    },
    own, open: async (url) => { opened.push(url); return true; }, onChange: (v) => views.push(v.phase),
    newId: () => `codex-${String(seq).padStart(4, '0')}ab`, waitMs: 3000,
  });
  return { W, reg, folders, fakeFor, services, opened, own, views, dirOf: (id) => path.join(W.root, id) };
}
// The sign-in in flight: finish it the way Codex would after the browser.
async function finish(t, id, account = { type: 'chatgpt', email: 'second@example.com', planType: 'pro' }) {
  const fake = t.fakeFor(t.dirOf(id));
  await until(() => fake.children.some((c) => c.login));
  fake.children.find((c) => c.login).finishLogin({ account });
}

test('add: a folder of its own, Codex’s browser sign-in there, then Codex says who signed in', async () => {
  const t = world();
  const before = snapshot(t.W.base);
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  const added = t.folders.add();
  await finish(t, id);
  const r = await added;
  assert.deepEqual(r, { ok: true, id });
  const row = t.reg.get('codex', id);
  assert.equal(row.state, 'ok'); assert.equal(row.email, 'second@example.com'); assert.equal(row.plan, 'pro'); assert.equal(row.dir, t.dirOf(id));
  assert.ok(fs.lstatSync(path.join(t.dirOf(id), 'sessions')).isSymbolicLink(), 'the chats are the user’s own');
  assert.equal(t.opened.length, 1); assert.match(t.opened[0], /^https:\/\//);
  // The sign-in went to a process started in the account's folder, with the user's folder as the chat index.
  const fake = t.fakeFor(t.dirOf(id));
  const spawn = fake.spawns[0].options.env;
  assert.equal(spawn.CODEX_HOME, t.dirOf(id)); assert.equal(spawn.CODEX_SQLITE_HOME, t.W.base);
  assert.equal(fake.sent('account/login/start').length, 1);
  assert.deepEqual(snapshot(t.W.base), before, 'nothing in the user’s Codex folder changed');
  assert.deepEqual(t.views.slice(-1), ['done']);
});

test('the same ChatGPT account twice: not added, signed out of the new folder, and nothing left behind', async () => {
  const t = world({ list: [{ engine: 'codex', id: 'codex-default', kind: 'plan', email: 'Me@Example.com' }] });
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  const added = t.folders.add();
  await finish(t, id, { type: 'chatgpt', email: 'me@example.com', planType: 'plus' });
  const r = await added;
  assert.equal(r.ok, false); assert.equal(r.code, 'duplicate');
  assert.equal(t.reg.get('codex', id), null);
  assert.equal(fs.existsSync(t.dirOf(id)), false);
  assert.equal(t.fakeFor(t.dirOf(id)).sent('account/logout').length, 1, 'the second copy of the login was signed out');
});

test('cancel while the browser is open: Codex drops the sign-in, and no folder or row is left', async () => {
  const t = world();
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  const added = t.folders.add();
  await until(() => t.folders.phase === 'waiting');
  await t.folders.cancel();
  const r = await added;
  assert.equal(r.ok, false);
  assert.equal(t.reg.get('codex', id), null);
  assert.equal(fs.existsSync(t.dirOf(id)), false);
  assert.equal(t.fakeFor(t.dirOf(id)).sent('account/login/cancel').length, 1);
  assert.equal(t.folders.view().busy, false);
});

test('a helper that did not start in the account’s folder is asked nothing: no sign-in reaches another login', async () => {
  const t = world();
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  t.fakeFor(t.dirOf(id)).codexHome = t.W.base; // it says it is in the user's own folder
  const fake = t.fakeFor(t.dirOf(id));
  const real = fake.spawnFn;
  fake.spawnFn = (cmd, args, opts) => real(cmd, args, { ...opts, env: { ...opts.env, CODEX_HOME: '' } });
  const r = await t.folders.add();
  assert.equal(r.ok, false);
  assert.equal(fake.sent('account/login/start').length, 0);
  assert.equal(fs.existsSync(t.dirOf(id)), false);
});

test('one sign-in at a time', async () => {
  const t = world();
  const first = t.folders.add();
  const second = await t.folders.add();
  assert.equal(second.code, 'busy');
  await t.folders.cancel(); await first;
});

test('guard: no launch before the user’s Codex folder is known, nor on a folder that kept its own chat index', async () => {
  const t = world();
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  const added = t.folders.add();
  await finish(t, id);
  await added;
  const acct = t.reg.get('codex', id);
  assert.deepEqual(t.folders.guard(acct), { codexHome: t.W.base });
  // A link someone deleted is put back before the launch.
  fs.unlinkSync(path.join(acct.dir, 'sessions'));
  t.folders.guard(acct);
  assert.ok(fs.lstatSync(path.join(acct.dir, 'sessions')).isSymbolicLink());
  // A database inside the folder: refused.
  put(path.join(acct.dir, 'state_5.sqlite'), 'x');
  assert.throws(() => t.folders.guard(acct), (e) => e.code === 'account-broken');
  // A new copy of Canopy that has not heard from Codex yet: refused, and told to try again.
  const fresh = world();
  assert.throws(() => fresh.folders.guard(acct), (e) => e.code === 'no-env' && e.canopy.recoverable === true);
  // Codex's own login and pasted keys are not folder logins.
  assert.throws(() => t.folders.guard({ id: 'codex-default', kind: 'key' }), (e) => e.code === 'account-unsupported');
});

test('verify: Codex is asked about that very folder', async () => {
  const t = world();
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  const added = t.folders.add();
  await finish(t, id);
  await added;
  const v = await t.folders.verify(t.reg.get('codex', id));
  assert.equal(v.state, 'ok'); assert.equal(v.email, 'second@example.com');
  t.fakeFor(t.dirOf(id)).account = null;
  assert.equal((await t.folders.verify(t.reg.get('codex', id))).state, 'signed-out');
});

test('remove: Codex signs that folder out; the links to chats stay while a chat is filed there, then the row goes', async () => {
  const t = world();
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  const added = t.folders.add();
  await finish(t, id);
  await added;
  const dir = t.dirOf(id);
  const fake = t.fakeFor(dir);
  fake.handlers['account/logout'] = () => { fake.account = null; return {}; };
  t.own.filed = true;
  const before = snapshot(t.W.base);
  const r = await t.folders.remove(id);
  assert.equal(r.ok, true);
  assert.equal(fake.sent('account/logout').length, 1);
  assert.equal(t.reg.get('codex', id), null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['archived_sessions', 'sessions'], 'only where its chats are is kept');
  assert.ok(fs.existsSync(path.join(t.W.base, 'sessions')), 'the chats themselves are never touched');
  assert.deepEqual(snapshot(t.W.base), before);
});

test('remove with no chat filed under the folder: nothing is left', async () => {
  const t = world();
  const id = `codex-${String(seq).padStart(4, '0')}ab`;
  const added = t.folders.add();
  await finish(t, id);
  await added;
  const fake = t.fakeFor(t.dirOf(id));
  fake.handlers['account/logout'] = () => { fake.account = null; return {}; };
  t.own.filed = false;
  assert.equal((await t.folders.remove(id)).ok, true);
  assert.equal(fs.existsSync(t.dirOf(id)), false);
});

test('only a login Canopy added in a folder can be removed here', async () => {
  const t = world();
  assert.equal((await t.folders.remove('codex-default')).code, 'account-missing');
});

// The small hooks account folders need in files that are not theirs:
//   upkeep.mjs      a change noticed in Claude Code's files is listed without being announced
//   session.mjs     a chat on an account folder honours trust the user gave in their own Claude Code folder
//   customize.mjs   connectors are read as the account in use, changed in the user's own setup, and synced after
// No real claude is run and no real Claude Code folder or config file is read: the folders are throwaway ones, the
// chat's process is the scripted fake of the SDK's query(), and `claude` is a shell script that says what it was run with.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { registerCustomize } from '../../../customize.mjs';
import { json, script } from '../account-world.mjs';
import { createFake } from '../fake-query.mjs';
import { core, watch, within } from '../helpers.mjs';

const U = await core('upkeep.mjs');
const S = await core('session.mjs');
const T = await core('trust.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-account-hooks-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- upkeep: quiet drift ----

test('drift noted quietly is listed like any other, but the window is not told to announce it', { skip: U.__missing ? `upkeep.mjs: ${U.__missing}` : false }, () => {
  const notes = [], saved = [];
  const upkeep = new U.Upkeep({
    claude: () => ({ path: '/x/claude', env: {}, version: '2.1.325 (Claude Code)' }), refreshVersion: async () => null,
    onChange: (_status, note) => notes.push(note), save: (s) => saved.push(s),
  });
  assert.equal(upkeep.recordDrift('accounts: something new in Claude Code’s folder', ['rules', 'workflows'], { quiet: true }), true);
  assert.deepEqual(notes, [null], 'the status went out (the list changed), with nothing to announce');
  const [d] = upkeep.status().drift;
  assert.deepEqual([d.label, d.keys, d.version, d.count], ['accounts: something new in Claude Code’s folder', ['rules', 'workflows'], '2.1.325', 1]);
  assert.equal(saved.at(-1).drift.length, 1, 'and it is saved');
  assert.equal(upkeep.recordDrift('accounts: something new in Claude Code’s folder', ['more'], { quiet: true }), false, 'once per Claude Code version');
  // Anything but a clear `quiet: true` is announced, as before.
  upkeep.recordDrift('system/brand_new', ['type']);
  upkeep.recordDrift('system/other', [], { quiet: 'yes' });
  upkeep.recordDrift('system/third', [], {});
  assert.deepEqual(notes.slice(1), [{ kind: 'drift', label: 'system/brand_new' }, { kind: 'drift', label: 'system/other' }, { kind: 'drift', label: 'system/third' }]);
});

// ---- session: trust given in the user's own Claude Code folder ----

const noSession = S.__missing ? `session.mjs: ${S.__missing}` : T.__missing ? `trust.mjs: ${T.__missing}` : false;
const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
});
const idle = (w) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, label: 'busy:false' });

// A project whose own settings would run things, the user's Claude Code folder (which trusts it), and an account
// folder with a config of its own that has never heard of it.
function trustWorld() {
  const w = fs.mkdtempSync(path.join(tmp, 'trust-'));
  const project = path.join(w, 'project');
  json(path.join(project, '.claude', 'settings.local.json'), { permissions: { allow: ['WebSearch'] } });
  const own = path.join(w, 'home', '.claude'), account = path.join(w, 'accounts', 'claude-a1b2c3d4'), other = path.join(w, 'elsewhere');
  json(path.join(own, '.claude.json'), { projects: { [fs.realpathSync(project)]: { hasTrustDialogAccepted: true } } });
  json(path.join(account, '.claude.json'), { projects: {} });
  json(path.join(other, '.claude.json'), { projects: {} });
  const env = (dir) => ({ PATH: '/usr/bin:/bin', HOME: path.join(w, 'home'), CLAUDE_CONFIG_DIR: dir });
  return { project, own, account, other, env };
}
async function started(opts) {
  T.clearTrustCache?.();
  const fake = createFake({});
  const s = new S.Session({ claudePath: '/usr/bin/true', personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  const w = watch(s);
  s.send('hi');
  await idle(w);
  return { s, options: fake.current.options, notices: w.all((e) => e.kind === 'notice' && e.code === 'trust-required').length };
}

test('a chat on an account folder honours trust the user gave in their own Claude Code folder', { skip: noSession }, async () => {
  const W = trustWorld();
  // Claude Code keeps trust per folder of its own: by the account's folder alone, the project is not trusted.
  const alone = await started({ cwd: W.project, env: W.env(W.account) });
  assert.deepEqual([alone.s.restricted, alone.options.settingSources, alone.notices], [true, ['user'], 1]);
  // With the user's own environment to look in as well, it is: they trusted this project once already.
  const both = await started({ cwd: W.project, env: W.env(W.account), trustEnv: () => W.env(W.own) });
  assert.deepEqual([both.s.restricted, both.options.settingSources, both.notices], [false, ['user', 'project', 'local'], 0]);
  assert.equal(both.options.env.CLAUDE_CONFIG_DIR, W.account, 'the chat still runs on the account’s folder');
});

test('trust is not widened: an untrusted project stays held back, and an explicit answer stands', { skip: noSession }, async () => {
  const W = trustWorld();
  // Neither folder trusts it.
  const neither = await started({ cwd: W.project, env: W.env(W.account), trustEnv: () => W.env(W.other) });
  assert.equal(neither.s.restricted, true);
  // The host said "not trusted" outright: the user's folder is not consulted.
  const no = await started({ cwd: W.project, env: W.env(W.account), trusted: false, trustEnv: () => { throw new Error('not asked'); } });
  assert.equal(no.s.restricted, true);
  // A getter that breaks or answers junk leaves only the chat's own folder to go by.
  for (const trustEnv of [() => { throw new Error('boom'); }, () => null, () => 'env', () => []]) {
    assert.equal((await started({ cwd: W.project, env: W.env(W.account), trustEnv })).s.restricted, true);
  }
  // And a chat on the user's own folder is as it always was, with or without the getter.
  assert.equal((await started({ cwd: W.project, env: W.env(W.own) })).s.restricted, false);
  assert.equal((await started({ cwd: W.project, env: W.env(W.other), trustEnv: () => W.env(W.other) })).s.restricted, true);
});

// ---- customize: read as the account in use, change the user's own setup, sync after ----

function customized(hooks) {
  const w = fs.mkdtempSync(path.join(tmp, 'customize-'));
  const log = path.join(w, 'ran');
  // Says which login it was run as (WHO), and fails an add or remove of anything called "broken".
  const bin = script(path.join(w, 'claude'), [
    `echo "$WHO: $*" >> '${log}'`,
    `case "$1 $2" in`,
    `  "mcp list") echo "notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication"; echo "seen-as-$WHO: npx server - ✔ Connected";;`,
    `  "mcp get") echo "details as $WHO";;`,
    `  *) case "$*" in *broken*) echo "no such server" >&2; exit 1;; esac;;`,
    `esac`,
  ].join('\n'));
  const channels = new Map();
  const base = () => ({ claudePath: bin, env: { PATH: '/usr/bin:/bin', WHO: 'user' }, cwd: w });
  registerCustomize((channel, fn) => channels.set(channel, fn), base, typeof hooks === 'function' ? hooks(base) : hooks);
  const ran = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { call: (channel, ...args) => channels.get(channel)(...args), ran, channels };
}

test('connectors are read as the account in use; every change is made in the user’s own setup, then synced', { timeout: 60000 }, async () => {
  let synced = 0;
  const C = customized((base) => ({ readCtx: async () => ({ ...base(), env: { ...base().env, WHO: 'account' } }), afterWrite: async () => { synced += 1; } }));
  // The list and a connector's details: asked as the account, since that is whose sign-ins they show.
  const list = await C.call('customize:mcp:list');
  assert.deepEqual(list.servers.map((s) => [s.name, s.status]), [['notion', 'needs-auth'], ['seen-as-account', 'connected']]);
  assert.equal((await C.call('customize:mcp:get', 'notion')).text, 'details as account');
  assert.equal(synced, 0, 'reading changes nothing');
  // Adding and removing: in the user's own setup, and the account folders are brought in line straight after.
  assert.deepEqual(await C.call('customize:mcp:add', { name: 'linear', target: 'https://mcp.linear.app', scope: 'user' }), { ok: true });
  assert.equal(synced, 1);
  assert.deepEqual(await C.call('customize:mcp:remove', 'linear', 'user'), { ok: true });
  assert.equal(synced, 2);
  assert.deepEqual(C.ran().map((l) => l.split(':')[0]), ['account', 'account', 'user', 'user']);
  // A change that did not go through is not followed by a sync, and one that was refused before running is not either.
  assert.equal((await C.call('customize:mcp:remove', 'broken')).ok, false);
  assert.equal((await C.call('customize:mcp:add', { name: 'bad name!', target: 'x' })).ok, false);
  assert.equal(synced, 2);
  // Plugins, marketplaces and skills are the user's own setup, read and written there.
  await C.call('customize:plugins:list', {});
  assert.ok(C.ran().at(-1).startsWith('user: plugin list'));
});

test('without the hooks Customize is as it was, and a sync that fails does not fail the change', { timeout: 60000 }, async () => {
  const plain = customized(undefined);
  assert.deepEqual((await plain.call('customize:mcp:list')).servers.map((s) => s.name), ['notion', 'seen-as-user']);
  assert.deepEqual(await plain.call('customize:mcp:add', { name: 'linear', target: 'https://mcp.linear.app', scope: 'user' }), { ok: true });
  assert.deepEqual(plain.ran().map((l) => l.split(':')[0]), ['user', 'user']);
  assert.deepEqual([...plain.channels.keys()].sort(), [
    'customize:marketplaces:add', 'customize:marketplaces:list', 'customize:mcp:add', 'customize:mcp:get', 'customize:mcp:list', 'customize:mcp:remove',
    'customize:plugins:action', 'customize:plugins:details', 'customize:plugins:list', 'customize:skills:list', 'customize:skills:read',
  ], 'the same channels as before');
  const failing = customized({ afterWrite: async () => { throw new Error('sync broke'); } });
  assert.deepEqual(await failing.call('customize:mcp:add', { name: 'linear', target: 'https://mcp.linear.app', scope: 'user' }), { ok: true });
});

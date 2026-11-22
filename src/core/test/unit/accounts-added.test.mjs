// accounts.mjs, the accounts added in Canopy: a pasted API key is added, named, re-keyed, checked and removed.
// The engine is the real Claude one over a `claude auth status` that answers from memory, and the "key" is a
// made-up string handed over by a stand-in for the host's vault: no tool is run and nothing reaches Anthropic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const A = await core('accounts.mjs');
const C = await core('accounts-claude.mjs');
const missing = A.__missing ? `accounts.mjs: ${A.__missing}` : C.__missing ? `accounts-claude.mjs: ${C.__missing}` : false;

const KEY = 'sk-ant-api03-NOT-A-REAL-KEY-0123456789abcdefghijklmnop-4f2a';
const BASE = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/Users/someone', ANTHROPIC_API_KEY: 'sk-shell-key', ANTHROPIC_BASE_URL: 'https://proxy.example', MY_VAR: 'kept' });
const CONSOLE = { loggedIn: true, method: 'api_key', provider: 'firstParty', apiKeySource: '/login managed key', email: 'me@example.com', org: 'Acme', orgId: 'o1', configDir: '/Users/someone/.claude' };
const KEY_ACCOUNT = Object.freeze({ id: 'claude-key-1', engine: 'claude', kind: 'key', keyHint: '4f2a', state: 'ok' });

function make({ saved = null, keys = { 'claude-key-1': KEY }, checkKey, auth = () => CONSOLE, at = 5_000_000 } = {}) {
  const saves = [], changes = [], logs = [], checked = [];
  let clock = at;
  const claude = C.claudeAccounts({
    tool: () => ({ path: '/usr/bin/true', env: { ...BASE } }), ask: async () => auth(),
    ...(checkKey && { checkKey: async (a) => { checked.push(a); return checkKey(a); } }),
  });
  const reg = new A.Accounts({
    engines: { claude }, load: () => saved, save: (s) => saves.push(JSON.parse(JSON.stringify(s))),
    onChange: (v) => changes.push(v), log: (m) => logs.push(m), now: () => clock, keyFor: (a) => keys[a.id] ?? null,
  });
  return { reg, saves, changes, logs, checked, keys, tick: (ms) => { clock += ms; } };
}
const row = (reg, id) => reg.view().list.find((a) => a.id === id) ?? null;
const refused = (fn, code) => assert.throws(fn, (err) => err.code === code && err.canopy?.code === code);

test('a pasted key is added as an account of its own, and adding never changes which account is in use', { skip: missing }, async () => {
  const { reg, saves } = make();
  await reg.refresh();
  assert.deepEqual(reg.add({ ...KEY_ACCOUNT }), { ok: true, id: 'claude-key-1' });
  assert.deepEqual(row(reg, 'claude-key-1'), {
    id: 'claude-key-1', engine: 'claude', kind: 'key', label: 'API key ••••4f2a', email: null, org: null, plan: null,
    via: null, keyHint: '4f2a', state: 'ok', why: null, found: false,
  });
  assert.deepEqual(reg.view().active, { claude: null, codex: null });
  assert.equal(reg.view().inUse.claude, 'claude-default', 'still the login Claude Code found');
  assert.deepEqual(reg.envFor('claude'), BASE);
  const saved = saves.at(-1).list.find((a) => a.id === 'claude-key-1');
  assert.deepEqual([saved.addedAt, saved.lastOkAt, saved.dir, saved.label], [5_000_000, 5_000_000, null, null]);
  // Not checked yet: it is listed, but nothing says it works.
  assert.equal(reg.add({ ...KEY_ACCOUNT, id: 'claude-key-2', state: 'checking' }).ok, true);
  assert.deepEqual([row(reg, 'claude-key-2').state, saves.at(-1).list.find((a) => a.id === 'claude-key-2').lastOkAt], ['unknown', null]);
});

test('what cannot be an account of Canopy’s own is not added', { skip: missing }, async () => {
  const { reg, saves } = make();
  await reg.refresh();
  reg.add({ ...KEY_ACCOUNT });
  const n = saves.length;
  const bad = [
    { ...KEY_ACCOUNT },                                              // the id is taken
    { ...KEY_ACCOUNT, id: 'claude-default' }, { ...KEY_ACCOUNT, id: 'claude-env' },   // the ids of Claude Code's own logins
    { ...KEY_ACCOUNT, id: 'k2', keyHint: null }, { ...KEY_ACCOUNT, id: 'k2', keyHint: KEY },  // a key shows its last four characters, and only those
    { ...KEY_ACCOUNT, id: 'k2', dir: '/somewhere' },                 // a key has no folder
    { id: 'p2', engine: 'claude', kind: 'plan' }, { id: 'c2', engine: 'claude', kind: 'console' },   // a sign-in without a folder is Claude Code's own
    { id: 'e2', engine: 'claude', kind: 'external', dir: '/somewhere' },
    { ...KEY_ACCOUNT, id: '' }, { ...KEY_ACCOUNT, id: 'k2', kind: 'cookie' }, null, 'junk', {},
  ];
  for (const account of bad) assert.deepEqual([reg.add(account).ok, reg.add(account).code], [false, account?.engine === 'claude' ? 'invalid-account' : 'unknown-engine'], JSON.stringify(account));
  assert.equal(reg.add({ ...KEY_ACCOUNT, id: 'k2', engine: 'codex' }).code, 'unknown-engine', 'an engine Canopy has no accounts for');
  assert.equal(saves.length, n, 'a refusal saves nothing');
  assert.equal(reg.view().list.length, 2);
  // A sign-in in a folder of its own is the other kind of account Canopy can add.
  assert.equal(reg.add({ id: 'p2', engine: 'claude', kind: 'plan', dir: '/accounts/p2' }).ok, true);
});

test('a key account is launched with its key in place of every other login, and never without it', { skip: missing }, async () => {
  const { reg, keys } = make();
  await reg.refresh();
  reg.add({ ...KEY_ACCOUNT });
  assert.deepEqual(reg.setActive('claude', 'claude-key-1'), { ok: true });
  assert.deepEqual(reg.envFor('claude'), { PATH: '/usr/bin:/bin', HOME: '/Users/someone', MY_VAR: 'kept', ANTHROPIC_API_KEY: KEY }, 'the shell’s key and its proxy are left out');
  delete keys['claude-key-1'];   // the host cannot read it (the Keychain is locked)
  refused(() => reg.envFor('claude'), 'account-locked');
  assert.deepEqual(reg.envFor('claude', { account: null }), BASE, 'a chat on the login Claude Code found is not affected');
});

test('an account is named, and an empty name or its own name puts its own name back', { skip: missing }, async () => {
  const { reg, saves } = make();
  await reg.refresh();
  reg.add({ ...KEY_ACCOUNT });
  assert.deepEqual(reg.rename('claude', 'claude-key-1', '  Work   key\n'), { ok: true });
  assert.equal(row(reg, 'claude-key-1').label, 'Work key');
  assert.equal(saves.at(-1).list.find((a) => a.id === 'claude-key-1').label, 'Work key');
  assert.equal(reg.named('claude', 'claude-key-1').label, 'Work key');
  reg.rename('claude', 'claude-key-1', 'x'.repeat(200));
  assert.equal(row(reg, 'claude-key-1').label.length, 80);
  for (const back of ['', '   ', null, undefined, 7, 'API key ••••4f2a']) {
    reg.rename('claude', 'claude-key-1', 'Something');
    assert.deepEqual(reg.rename('claude', 'claude-key-1', back), { ok: true });
    assert.equal(row(reg, 'claude-key-1').label, 'API key ••••4f2a', String(back));
    assert.equal(saves.at(-1).list.find((a) => a.id === 'claude-key-1').label, null, 'its own name is not stored: it follows the key');
  }
  const n = saves.length;
  reg.rename('claude', 'claude-key-1', '');
  assert.equal(saves.length, n, 'no change, nothing saved');
  assert.deepEqual([reg.rename('claude', 'nope', 'x').code, reg.rename('codex', 'claude-key-1', 'x').code], ['account-missing', 'account-missing']);
});

test('the login Claude Code holds can be named too, and keeps the name while it is signed in or out', { skip: missing }, async () => {
  let signedIn = true;
  const { reg } = make({ auth: () => (signedIn ? CONSOLE : { loggedIn: false }) });
  await reg.refresh();
  assert.equal(row(reg, 'claude-default').label, 'Console');
  reg.rename('claude', 'claude-default', 'Personal');
  await reg.refresh();
  assert.deepEqual([row(reg, 'claude-default').label, row(reg, 'claude-default').email], ['Personal', 'me@example.com']);
  assert.deepEqual(reg.named('claude', null), { id: 'claude-default', label: 'Personal', kind: 'console' });
  signedIn = false;
  await reg.refresh();
  assert.deepEqual([row(reg, 'claude-default').label, row(reg, 'claude-default').state], ['Personal', 'signed-out']);
  signedIn = true;
  await reg.refresh();
  assert.deepEqual([row(reg, 'claude-default').label, row(reg, 'claude-default').state], ['Personal', 'ok']);
});

test('a replaced key shows its new last four characters and is fine again', { skip: missing }, async () => {
  const { reg, saves, tick } = make({ saved: { active: { claude: 'claude-key-1' }, list: [{ ...KEY_ACCOUNT, state: 'invalid-key', label: 'Work key', addedAt: 1, lastOkAt: 2 }] } });
  refused(() => reg.envFor('claude'), 'account-invalid-key');
  tick(1000);
  assert.deepEqual(reg.rekeyed('claude', 'claude-key-1', '9z9z'), { ok: true });
  assert.deepEqual([row(reg, 'claude-key-1').keyHint, row(reg, 'claude-key-1').state, row(reg, 'claude-key-1').label], ['9z9z', 'ok', 'Work key']);
  assert.deepEqual([saves.at(-1).list[0].lastOkAt, saves.at(-1).list[0].addedAt], [5_001_000, 1]);
  assert.equal(reg.envFor('claude').ANTHROPIC_API_KEY, KEY);
  const n = saves.length;
  for (const hint of [KEY, '', null, 'five5', 'a b']) assert.equal(reg.rekeyed('claude', 'claude-key-1', hint).code, 'invalid-account', String(hint));
  await reg.refresh();
  assert.equal(reg.rekeyed('claude', 'claude-default', '9z9z').code, 'account-missing', 'only a key has a key');
  assert.equal(reg.rekeyed('claude', 'nope', '9z9z').code, 'account-missing');
  assert.equal(row(reg, 'claude-key-1').keyHint, '9z9z');
  assert.ok(saves.length >= n);
});

test('an account added in Canopy can be removed; Claude Code’s own login cannot', { skip: missing }, async () => {
  const { reg, saves } = make();
  await reg.refresh();
  reg.add({ ...KEY_ACCOUNT });
  reg.add({ ...KEY_ACCOUNT, id: 'claude-key-2', keyHint: 'bbbb' });
  reg.setActive('claude', 'claude-key-1');
  const open = reg.pin('claude');   // a chat opened on the key

  assert.deepEqual(reg.remove('claude', 'claude-key-2'), { ok: true, wasActive: false });
  assert.equal(reg.pin('claude'), 'claude-key-1', 'removing another account changes nothing about the one in use');
  assert.deepEqual(reg.remove('claude', 'claude-key-1'), { ok: true, wasActive: true });
  assert.equal(reg.pin('claude'), null, 'new chats go back to the login Claude Code finds');
  assert.equal(reg.view().inUse.claude, 'claude-default');
  assert.deepEqual(reg.envFor('claude'), BASE);
  assert.deepEqual(saves.at(-1).list.map((a) => a.id), ['claude-default']);
  assert.deepEqual(saves.at(-1).active, { claude: null, codex: null });
  refused(() => reg.envFor('claude', { account: open }), 'account-missing');   // the chat still open on it does not move to another login

  for (const id of ['claude-default', 'claude-env']) {
    const before = reg.view().list.length;
    const r = reg.remove('claude', id);
    assert.deepEqual([r.ok, r.code], id === 'claude-default' ? [false, 'not-removable'] : [false, 'account-missing']);
    assert.equal(reg.view().list.length, before);
  }
  assert.equal(reg.remove('claude', 'claude-key-1').code, 'account-missing', 'already gone');
  assert.equal(reg.remove('codex', 'claude-default').code, 'account-missing');
});

test('a key is checked when the accounts are, by the host that keeps it, and what it finds decides whether chats start', { skip: missing }, async () => {
  let answer = { state: 'ok' };
  const { reg, checked } = make({ checkKey: () => answer });
  await reg.refresh();
  reg.add({ ...KEY_ACCOUNT });
  reg.setActive('claude', 'claude-key-1');
  await reg.refresh();
  assert.equal(checked.length, 1);
  assert.deepEqual([checked[0].id, checked[0].kind, checked[0].keyHint], ['claude-key-1', 'key', '4f2a']);
  assert.ok(!JSON.stringify(checked).includes(KEY), 'the engine is told which account, never the key');
  assert.equal(row(reg, 'claude-key-1').state, 'ok');

  answer = { state: 'invalid-key' };
  await reg.refresh();
  assert.deepEqual([row(reg, 'claude-key-1').state, row(reg, 'claude-key-1').keyHint], ['invalid-key', '4f2a']);
  refused(() => reg.envFor('claude'), 'account-invalid-key');
  answer = { state: 'unknown' };          // offline: nothing is known, so nothing changes
  await reg.refresh();
  assert.equal(row(reg, 'claude-key-1').state, 'invalid-key');
  answer = { state: 'locked' };
  await reg.refresh();
  refused(() => reg.envFor('claude'), 'account-locked');
  answer = { state: 'ok' };
  await reg.refresh();
  assert.deepEqual([row(reg, 'claude-key-1').state, row(reg, 'claude-key-1').kind, row(reg, 'claude-key-1').label], ['ok', 'key', 'API key ••••4f2a']);
  assert.equal(reg.envFor('claude').ANTHROPIC_API_KEY, KEY);
  assert.equal(row(reg, 'claude-default').state, 'ok', 'Claude Code’s own login is asked about as before');

  // No host check wired: a key is listed as it was, and nothing is asked.
  const plain = make({ saved: { active: {}, list: [{ ...KEY_ACCOUNT, state: 'invalid-key' }] } });
  await plain.reg.refresh();
  assert.equal(row(plain.reg, 'claude-key-1').state, 'invalid-key');
});

test('a chat says which account it is on by the id it was started with', { skip: missing }, async () => {
  const { reg } = make();
  assert.equal(reg.named('claude', null), null, 'nothing is known yet');
  await reg.refresh();
  reg.add({ ...KEY_ACCOUNT });
  assert.deepEqual(reg.named('claude', null), { id: 'claude-default', label: 'Console', kind: 'console' });
  assert.deepEqual(reg.named('claude', undefined), { id: 'claude-default', label: 'Console', kind: 'console' });
  assert.deepEqual(reg.named('claude', 'claude-default'), { id: 'claude-default', label: 'Console', kind: 'console' });
  assert.deepEqual(reg.named('claude', 'claude-key-1'), { id: 'claude-key-1', label: 'API key ••••4f2a', kind: 'key' });
  assert.equal(reg.named('claude', 'gone'), null);
  assert.equal(reg.named('codex', null), null);
  assert.equal(reg.named('nonsense', 'claude-key-1'), null);
});

test('through all of it, the key is in the launch and nowhere else: not the saved state, the window, or the log', { skip: missing }, async () => {
  const { reg, saves, changes, logs } = make({ checkKey: () => ({ state: 'ok' }) });
  await reg.refresh();
  reg.add({ ...KEY_ACCOUNT });
  reg.setActive('claude', 'claude-key-1');
  assert.equal(reg.envFor('claude').ANTHROPIC_API_KEY, KEY);
  reg.rename('claude', 'claude-key-1', 'Work key');
  reg.rekeyed('claude', 'claude-key-1', '9z9z');
  await reg.refresh();
  reg.named('claude', 'claude-key-1');
  reg.remove('claude', 'claude-key-1');
  assert.ok(saves.length > 4 && changes.length > 4 && logs.length > 2);
  const everything = JSON.stringify([saves, changes, reg.view()]) + logs.join('\n');
  assert.ok(!everything.includes(KEY) && !everything.includes('sk-ant'));
  assert.deepEqual(Object.keys(saves.at(-2).list.find((a) => a.kind === 'key')).sort(),
    ['addedAt', 'dir', 'email', 'engine', 'id', 'keyHint', 'kind', 'label', 'lastOkAt', 'org', 'orgId', 'plan', 'state', 'via', 'why']);
});

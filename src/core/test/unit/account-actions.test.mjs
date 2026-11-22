// account-actions.mjs: choosing the account new chats use, and the API keys pasted into Canopy, as main.mjs wires
// them. `handle` and `send` are stand-ins for main's, the registry and the vault are the real ones (the vault over
// a stand-in for Electron's safeStorage, in a throwaway folder), and Anthropic and OpenAI are functions that record
// what they were asked and answer from the test. No real key, no real login, nothing leaves this process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { registerAccounts } from '../../../accounts-ipc.mjs';
import { recheckModels, registerAccountActions } from '../../../account-actions.mjs';
import { Secrets } from '../../../secrets.mjs';
import { core } from '../helpers.mjs';

const U = await core('upkeep.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-account-actions-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

const key = (tail) => `sk-ant-api03-NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstu-${tail}`;
const KEY = key('4f2a');
const KEY2 = key('9z9z');
// OpenAI's, for Codex: as made up as the others.
const okey = (tail) => ['sk', 'proj', 'NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstu_T3BlbkFJ', tail].join('-'); // made up, and split so secret scanners do not mistake it for a key
const OKEY = okey('7Hq2');
const OKEY2 = okey('m3Xw');
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: os.homedir(), ANTHROPIC_API_KEY: 'sk-shell-key', MY_VAR: 'kept' });
const CONSOLE = { loggedIn: true, method: 'api_key', provider: 'firstParty', apiKeySource: '/login managed key', email: 'me@example.com', org: 'Acme', orgId: 'o1', configDir: '/Users/someone/.claude' };
const answer = (status) => ({ status, body: { cancel: async () => {} } });

// Shaped like Electron's safeStorage: what it hands back is not the text, and it can be locked or switched off.
function fakeSafe() {
  return {
    on: true, locked: false,
    isEncryptionAvailable() { return this.on; },
    encryptString(text) { if (this.locked) throw new Error('locked'); return Buffer.concat([Buffer.from('v10'), Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)]); },
    decryptString(data) { if (this.locked) throw new Error('locked'); return Buffer.from(data.subarray(3).map((b) => b ^ 0x5a)).toString('utf8'); },
  };
}

function wire({ codex = false, state = {} } = {}) {
  const dir = path.join(root, `w${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = {
    dir, state, channels: new Map(), sent: [], logs: [], asked: [], replies: [], switched: [], rekeyed: [],
    safe: fakeSafe(), anthropic: () => answer(200), openai: () => answer(200), clock: 1_000_000, ids: 0, tool: { path: '/usr/bin/true', env: ENV },
    outranked: () => false, askedAbout: [],
  };
  const handle = (channel, fn) => h.channels.set(channel, fn);
  h.secrets = new Secrets({ file: path.join(dir, 'secrets.json'), safe: h.safe, log: (m) => h.logs.push(`secrets: ${m}`) });
  h.accounts = registerAccounts(handle, {
    claude: () => h.tool,
    ...(codex && { codex: { installed: () => true, env: () => ENV, account: async () => ({ ok: true, signedIn: true, requiresAuth: true, account: { type: 'chatgpt', email: 'me@example.com', plan: 'plus' } }) } }),
    load: () => h.state.accounts ?? null, save: (s) => { h.state.accounts = JSON.parse(JSON.stringify(s)); },
    send: (channel, payload) => h.sent.push([channel, payload]), log: (m) => h.logs.push(m),
    keyFor: (account) => h.secrets.get(account.id), checkKey: (account) => h.actions.verifyKey(account),
  });
  h.actions = registerAccountActions(handle, {
    accounts: h.accounts, secrets: h.secrets,
    // Each maker answers for its own address, so a key sent to the wrong one would show.
    fetch: async (url, init) => { h.asked.push({ url, init }); const a = await (new URL(url).host === 'api.openai.com' ? h.openai : h.anthropic)(url, init); if (a instanceof Error) throw a; return a; },
    onSwitch: (engine) => h.switched.push(engine), onRekeyed: (engine, id) => h.rekeyed.push([engine, id]),
    outranked: (engine) => { h.askedAbout.push(engine); return h.outranked(engine); },
    log: (m) => h.logs.push(m), now: () => h.clock, newId: () => `t${++h.ids}`,
  });
  // The window's call, as main answers it. Every reply is kept, to look through later.
  h.call = async (channel, ...args) => { const r = await h.channels.get(channel)(...args); h.replies.push(r); return r; };
  h.found = () => h.accounts.refresh({ auth: { claude: CONSOLE } });   // what the environment check found: Claude Code's own login
  h.row = (id) => h.accounts.view().list.find((a) => a.id === id) ?? null;
  h.onDisk = () => { try { return fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'); } catch { return ''; } };
  h.kept = () => { try { return Object.keys(JSON.parse(h.onDisk()).keys); } catch { return []; } };
  // Everything that leaves main or is written down: replies, events, the saved state, the log and the vault's file.
  h.everything = () => JSON.stringify([h.replies, h.sent, h.state]) + h.logs.join('\n') + h.onDisk();
  return h;
}

// ---- adding a key ----

test('the window gets five more calls, and a pasted key becomes an account without switching to it', { timeout: 60000 }, async () => {
  const h = wire();
  assert.deepEqual([...h.channels.keys()].sort(), ['accounts:add-key', 'accounts:list', 'accounts:refresh', 'accounts:remove', 'accounts:rename', 'accounts:replace-key', 'accounts:use']);
  await h.found();

  assert.deepEqual(await h.call('accounts:add-key', 'claude', `  ${KEY}\n`), { ok: true, id: 'claude-key-t1' });
  assert.equal(h.asked.length, 1, 'checked with Anthropic once');
  assert.deepEqual([h.asked[0].url, h.asked[0].init.headers['x-api-key'], h.asked[0].init.redirect], ['https://api.anthropic.com/v1/models?limit=1', KEY, 'error']);
  assert.deepEqual(h.row('claude-key-t1'), {
    id: 'claude-key-t1', engine: 'claude', kind: 'key', label: 'API key ••••4f2a', email: null, org: null, plan: null,
    via: null, keyHint: '4f2a', state: 'ok', why: null, found: false,
  });
  assert.deepEqual(h.sent.at(-1), ['accounts:changed', h.accounts.view()], 'the window hears of the new row');
  assert.deepEqual(h.accounts.view().active, { claude: null, codex: null });
  assert.equal(h.accounts.view().inUse.claude, 'claude-default', 'new chats still use the login Claude Code found');
  assert.deepEqual(h.switched, []);
  assert.deepEqual(h.accounts.envFor('claude'), ENV);

  // Where the key is: in the vault, encrypted, in a file only you can read. Where it is not: anywhere else.
  assert.deepEqual(h.kept(), ['claude-key-t1']);
  assert.equal(fs.statSync(path.join(h.dir, 'secrets.json')).mode & 0o777, 0o600);
  assert.equal(h.secrets.get('claude-key-t1'), KEY);
  assert.deepEqual(h.state.accounts.list.find((a) => a.id === 'claude-key-t1').keyHint, '4f2a');
  assert.ok(!h.everything().includes(KEY) && !h.everything().includes('sk-ant-api'));
});

test('a key is in the launch of a chat on its account, and in no reply, event, saved state, log line or file', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  await h.call('accounts:use', 'claude', id);
  assert.deepEqual(h.accounts.envFor('claude'), { PATH: '/usr/bin:/bin', HOME: os.homedir(), MY_VAR: 'kept', ANTHROPIC_API_KEY: KEY }, 'the shell’s own key is left out for it');
  await h.call('accounts:rename', 'claude', id, 'Work key');
  await h.call('accounts:replace-key', 'claude', id, KEY2);
  assert.equal(h.accounts.envFor('claude').ANTHROPIC_API_KEY, KEY2);
  await h.call('accounts:add-key', 'claude', KEY2);                       // a duplicate
  await h.call('accounts:add-key', 'claude', `sk-ant-oat01-${KEY.slice(13)}`);   // a sign-in token
  h.anthropic = () => answer(401);
  await h.call('accounts:add-key', 'claude', key('rej1'));
  h.anthropic = () => new Error(`connect failed while sending ${key('thr1')}`);
  await h.call('accounts:add-key', 'claude', key('thr1'));
  h.clock += 10 * 60_000;
  await h.call('accounts:refresh', true);
  await h.call('accounts:list');
  await h.call('accounts:remove', 'claude', id);

  assert.ok(h.replies.length >= 11 && h.sent.length > 5 && h.logs.length > 3);
  const all = h.everything();
  for (const secret of [KEY, KEY2, key('rej1'), key('thr1'), 'sk-ant-api', 'sk-ant-oat', 'NOT-A-REAL-KEY']) assert.ok(!all.includes(secret), `${secret.slice(0, 14)}… is written or sent somewhere`);
  for (const file of fs.readdirSync(h.dir)) assert.ok(!fs.readFileSync(path.join(h.dir, file), 'utf8').includes('NOT-A-REAL-KEY'), file);
  assert.ok(!h.logs.join('\n').includes('me@example.com'), 'and the log names accounts by id, never by email');
  // What a reply may hold: whether it worked, which account, and a reason in words.
  for (const r of h.replies.filter((x) => 'ok' in x)) assert.deepEqual(Object.keys(r).filter((k) => !['ok', 'id', 'code', 'message', 'wasActive'].includes(k)), []);
});

test('what is not an API key is refused before it is sent anywhere or kept', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const cases = [
    [`sk-ant-oat01-${KEY.slice(13)}`, 'plan-token'], [`sk-ant-ort01-${KEY.slice(13)}`, 'plan-token'], [`sk-ant-admin01-${KEY.slice(13)}`, 'admin-key'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 'not-a-key'], ['hello', 'not-a-key'], ['', 'empty'], [null, 'empty'], [{ key: KEY }, 'empty'],
  ];
  for (const [text, code] of cases) {
    const r = await h.call('accounts:add-key', 'claude', text);
    assert.deepEqual([r.ok, r.code, typeof r.message], [false, code, 'string'], String(text));
  }
  // This registry has no accounts for Codex (it is not on this Mac): an OpenAI key is not sent anywhere or kept.
  assert.equal((await h.call('accounts:add-key', 'codex', OKEY)).code, 'unsupported');
  assert.equal((await h.call('accounts:add-key', 'codex', KEY)).code, 'wrong-maker', 'and an Anthropic key is not one for Codex');
  assert.equal(h.asked.length, 0, 'none of it reached Anthropic or OpenAI');
  assert.deepEqual([h.kept(), h.accounts.view().list.length, fs.existsSync(path.join(h.dir, 'secrets.json'))], [[], 1, false]);
});

test('a key Anthropic refuses, or that cannot be checked or kept, is not added, and nothing of it stays', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const none = () => assert.deepEqual([h.kept(), h.accounts.view().list.map((a) => a.id)], [[], ['claude-default']]);

  h.anthropic = () => answer(401);
  assert.equal((await h.call('accounts:add-key', 'claude', KEY)).code, 'rejected');
  none();
  for (const down of [() => answer(500), () => answer(429), () => new TypeError('fetch failed')]) {
    h.anthropic = down;
    const r = await h.call('accounts:add-key', 'claude', KEY);
    assert.deepEqual([r.ok, r.code], [false, 'unreachable']);
    none();
  }
  h.anthropic = () => answer(200);

  // The Keychain cannot be used: the key is not even sent to be checked.
  const before = h.asked.length;
  h.safe.on = false;
  assert.equal((await h.call('accounts:add-key', 'claude', KEY)).code, 'no-keychain');
  assert.equal(h.asked.length, before);
  h.safe.on = true;
  none();

  // It checks out, but cannot be written down.
  h.safe.locked = true;
  assert.equal((await h.call('accounts:add-key', 'claude', KEY)).code, 'not-kept');
  h.safe.locked = false;
  none();

  // Something breaks in the middle, in its own words: the reply is plain, and the log does not repeat the paste.
  h.anthropic = () => answer(200);
  const set = h.secrets.set.bind(h.secrets);
  h.secrets.set = (id, secret) => { throw new Error(`could not write ${secret}`); };
  const r = await h.call('accounts:add-key', 'claude', KEY);
  assert.deepEqual(r, { ok: false, code: 'failed', message: 'That didn’t work. Try again.' });
  h.secrets.set = set;
  none();
  assert.ok(h.logs.some((l) => l.includes('add-key failed')) && !h.everything().includes(KEY) && !h.everything().includes('NOT-A-REAL'));

  assert.equal((await h.call('accounts:add-key', 'claude', KEY)).ok, true, 'and the same key is taken once things work');
});

test('one key is one account: a second paste of it is refused, even when both are pasted at once', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  let release;
  h.anthropic = () => new Promise((resolve) => { release = () => resolve(answer(200)); });
  const first = h.call('accounts:add-key', 'claude', KEY);
  await new Promise((r) => setImmediate(r));
  const letFirst = release;
  const second = h.call('accounts:add-key', 'claude', `"${KEY}"`);
  await new Promise((r) => setImmediate(r));
  letFirst(); release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.ok, b.ok, b.code], [true, false, 'duplicate']);
  assert.match(b.message, /already in Canopy, as API key ••••4f2a/);
  assert.deepEqual(h.kept(), [a.id]);
  assert.equal(h.accounts.view().list.filter((x) => x.kind === 'key').length, 1);

  const asked = h.asked.length;
  h.anthropic = () => answer(200);
  assert.equal((await h.call('accounts:add-key', 'claude', KEY)).code, 'duplicate');
  assert.equal(h.asked.length, asked, 'a key Canopy already has is not sent again');
  assert.equal((await h.call('accounts:add-key', 'claude', KEY2)).ok, true, 'another key is another account');
  assert.deepEqual(h.kept().length, 2);
});

test('a key is never written over another account’s: an id already in use is not taken', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  await h.call('accounts:add-key', 'claude', KEY);                 // claude-key-t1
  h.ids = 0;                                                        // the id maker repeats itself
  const r = await h.call('accounts:add-key', 'claude', KEY2);
  assert.deepEqual([r.ok, r.id], [true, 'claude-key-t2']);
  assert.deepEqual([h.secrets.get('claude-key-t1'), h.secrets.get('claude-key-t2')], [KEY, KEY2]);
  // An id maker that only ever says one thing, or nothing usable: the key is not kept at all.
  const stuck = wire();
  await stuck.found();
  await stuck.call('accounts:add-key', 'claude', KEY);
  stuck.ids = 0;
  const actions = registerAccountActions(() => {}, { accounts: stuck.accounts, secrets: stuck.secrets, fetch: async () => answer(200), newId: () => 't1' });
  assert.equal((await actions.addKey('claude', KEY2)).code, 'not-kept');
  const blank = registerAccountActions(() => {}, { accounts: stuck.accounts, secrets: stuck.secrets, fetch: async () => answer(200), newId: () => '///' });
  assert.equal((await blank.addKey('claude', KEY2)).code, 'not-kept');
  assert.equal(stuck.secrets.get('claude-key-t1'), KEY);
  assert.deepEqual(stuck.kept(), ['claude-key-t1']);
});

// ---- choosing ----

test('choosing an account switches new chats to it, says so once, and never moves to one that could not start a chat', { timeout: 60000 }, async () => {
  const h = wire({ codex: true });
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);

  assert.deepEqual(await h.call('accounts:use', 'claude', id), { ok: true });
  assert.deepEqual([h.accounts.pin('claude'), h.accounts.view().inUse.claude, h.switched], [id, id, ['claude']]);
  assert.equal(h.state.accounts.active.claude, id, 'the choice is saved');
  await h.call('accounts:use', 'claude', id);
  assert.deepEqual(h.switched, ['claude'], 'choosing the one already chosen is not a switch');
  assert.deepEqual(await h.call('accounts:use', 'claude', 'claude-default'), { ok: true });
  assert.deepEqual(await h.call('accounts:use', 'claude', null), { ok: true });
  assert.deepEqual(await h.call('accounts:use', 'claude'), { ok: true }, 'nothing named is "as Claude Code finds it"');
  assert.deepEqual([h.accounts.pin('claude'), h.switched], [null, ['claude', 'claude', 'claude']]);

  for (const nope of ['gone', 7, {}, '']) assert.equal((await h.call('accounts:use', 'claude', nope)).code, 'account-missing', String(nope));
  assert.equal((await h.call('accounts:use', 'gemini', id)).code, 'account-missing');
  // An engine that is not one: nothing is chosen, renamed, added or removed, and nothing breaks.
  const saved = JSON.stringify(h.state);
  for (const engine of ['__proto__', 'constructor', 'toString', '', null, undefined, 7, {}]) {
    for (const [channel, ...args] of [['accounts:use', null], ['accounts:use', id], ['accounts:rename', id, 'x'], ['accounts:remove', id], ['accounts:replace-key', id, KEY2]]) {
      assert.equal((await h.call(channel, engine, ...args)).code, 'account-missing', `${channel} ${String(engine)}`);
    }
    assert.equal((await h.call('accounts:add-key', engine, KEY2)).code, 'unsupported', String(engine));
  }
  assert.equal(JSON.stringify(h.state), saved);
  assert.deepEqual([h.switched.length, Object.getPrototypeOf(h.accounts.view().active)], [3, Object.prototype]);
  // Codex's own login, chosen by its row, is "as Codex finds itself": nothing is chosen, and nothing switched.
  assert.deepEqual(await h.call('accounts:use', 'codex', 'codex-default'), { ok: true });
  assert.deepEqual(await h.call('accounts:use', 'codex', null), { ok: true });
  assert.deepEqual([h.accounts.pin('codex'), h.state.accounts.active.codex, h.switched.length], [null, null, 3]);

  // Its key cannot be read, or Anthropic refuses it: the switch is refused with the reason, and nothing changes.
  h.safe.locked = true;
  const locked = await h.call('accounts:use', 'claude', id);
  assert.deepEqual([locked.ok, locked.code], [false, 'account-locked']);
  assert.match(locked.message, /API key ••••4f2a could not be read from the Keychain/);
  h.safe.locked = false;
  h.anthropic = () => answer(401);
  h.clock += 10 * 60_000;
  await h.accounts.refresh();
  const refusedKey = await h.call('accounts:use', 'claude', id);
  assert.deepEqual([refusedKey.ok, refusedKey.code, refusedKey.message], [false, 'account-invalid-key', 'The key for API key ••••4f2a no longer works.']);
  assert.deepEqual([h.accounts.pin('claude'), h.switched.length], [null, 3]);

  // Before the environment check is done nothing can be said about an account, so the choice is still taken.
  h.anthropic = () => answer(200);
  h.clock += 10 * 60_000;
  await h.accounts.refresh();
  h.tool = { path: null, env: null };
  assert.deepEqual(await h.call('accounts:use', 'claude', id), { ok: true });
  assert.equal(h.accounts.pin('claude'), id);
});

test('"Use <account>" beside a login that is gone is this same call: only to an account that works, never to a sign-in that is itself gone', { timeout: 60000 }, async () => {
  // As a launch can find it: the chosen sign-in is signed out, a key in the environment works, another sign-in has expired.
  const h = wire({ state: { accounts: { v: 1, active: { claude: 'claude-default' }, list: [
    { id: 'claude-default', engine: 'claude', kind: 'plan', dir: null, state: 'signed-out', lastOkAt: 1 },
    { id: 'claude-env', engine: 'claude', kind: 'external', via: 'ANTHROPIC_API_KEY', dir: null, state: 'ok', lastOkAt: 1 },
    { id: 'other-out', engine: 'claude', kind: 'plan', dir: null, state: 'expired' },
  ] } } });
  for (const [engine, id, code] of [['claude', 'other-out', 'account-expired'], ['claude', 'claude-default', 'account-signed-out'], ['claude', 'nobody', 'account-missing'],
    ['codex', 'claude-env', 'account-missing'], [null, 'claude-env', 'account-missing'], ['claude', { id: 'claude-env' }, 'account-missing']]) {
    const r = await h.call('accounts:use', engine, id);
    assert.deepEqual([r.ok, r.code], [false, code], JSON.stringify([engine, id]));
    assert.equal(h.accounts.pin('claude'), 'claude-default');
  }
  assert.deepEqual(h.switched, [], 'a refused switch moves no chat');
  assert.deepEqual(await h.call('accounts:use', 'claude', 'claude-env'), { ok: true });
  assert.deepEqual([h.accounts.pin('claude'), h.accounts.view().inUse.claude, h.switched], ['claude-env', 'claude-env', ['claude']]);
  // What a chat started before the switch (on the chosen sign-in, or with nothing chosen) is on has not changed.
  assert.deepEqual([h.accounts.view().own.claude, h.row('claude-default').state], ['claude-env', 'signed-out']);
});

// ---- replacing, naming, removing ----

test('a key is replaced only by one that works, and the old one stays until then', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  const other = await h.call('accounts:add-key', 'claude', key('oth1'));
  await h.call('accounts:use', 'claude', id);
  await h.call('accounts:rename', 'claude', id, 'Work key');

  const stays = async (text, code, setup, undo) => {
    setup?.();
    const r = await h.call('accounts:replace-key', 'claude', id, text);
    undo?.();
    assert.deepEqual([r.ok, r.code], [false, code], code);
    assert.deepEqual([h.secrets.get(id), h.row(id).keyHint, h.rekeyed.length], [KEY, '4f2a', 0], `${code}: the old key is still the account's`);
  };
  await stays(`sk-ant-oat01-${KEY.slice(13)}`, 'plan-token');
  await stays('nonsense', 'not-a-key');
  await stays(key('oth1'), 'duplicate');
  await stays(KEY2, 'rejected', () => { h.anthropic = () => answer(403); });
  await stays(KEY2, 'unreachable', () => { h.anthropic = () => new Error('offline'); });
  h.anthropic = () => answer(200);
  await stays(KEY2, 'no-keychain', () => { h.safe.on = false; }, () => { h.safe.on = true; });
  await stays(KEY2, 'not-kept', () => { h.secrets.set = () => ({ ok: false, code: 'write-failed' }); }, () => { delete h.secrets.set; });
  assert.equal((await h.call('accounts:replace-key', 'claude', 'claude-default', KEY2)).code, 'account-missing', 'only an account added here has a key to replace');
  assert.equal((await h.call('accounts:replace-key', 'claude', 'gone', KEY2)).code, 'account-missing');
  assert.equal((await h.call('accounts:replace-key', 'codex', id, KEY2)).code, 'account-missing');

  assert.deepEqual(await h.call('accounts:replace-key', 'claude', id, ` ${KEY2} `), { ok: true, id });
  assert.deepEqual([h.secrets.get(id), h.row(id).keyHint, h.row(id).label, h.row(id).state], [KEY2, '9z9z', 'Work key', 'ok']);
  assert.deepEqual(h.rekeyed, [['claude', id]]);
  assert.equal(h.accounts.envFor('claude').ANTHROPIC_API_KEY, KEY2, 'the next launch uses the new key');
  assert.equal(h.accounts.pin('claude'), id, 'and the account in use is the same one');
  assert.deepEqual(h.kept().sort(), [id, other.id].sort());
  // The key it already has is taken again (and checked again): that is how a key that was marked bad is retried.
  assert.equal((await h.call('accounts:replace-key', 'claude', id, KEY2)).ok, true);

  // Removed while Anthropic was being asked: nothing is kept for an account that is gone.
  let release;
  h.anthropic = () => new Promise((resolve) => { release = () => resolve(answer(200)); });
  const late = h.call('accounts:replace-key', 'claude', other.id, key('lat1'));
  await new Promise((r) => setImmediate(r));
  await h.call('accounts:remove', 'claude', other.id);
  release();
  assert.equal((await late).code, 'account-missing');
  assert.deepEqual(h.kept(), [id]);
});

test('a key marked as no longer working is fine again once it is replaced', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  await h.call('accounts:use', 'claude', id);
  h.anthropic = () => answer(401);
  h.clock += 10 * 60_000;
  await h.accounts.refresh();
  assert.equal(h.row(id).state, 'invalid-key');
  assert.throws(() => h.accounts.envFor('claude'), (err) => err.code === 'account-invalid-key');
  h.anthropic = () => answer(200);
  assert.equal((await h.call('accounts:replace-key', 'claude', id, KEY2)).ok, true);
  assert.equal(h.row(id).state, 'ok');
  assert.equal(h.accounts.envFor('claude').ANTHROPIC_API_KEY, KEY2);
});

test('any account can be named from the window', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  assert.deepEqual(await h.call('accounts:rename', 'claude', id, ' Work  key '), { ok: true });
  assert.deepEqual(await h.call('accounts:rename', 'claude', 'claude-default', 'Personal'), { ok: true });
  assert.deepEqual([h.row(id).label, h.row('claude-default').label], ['Work key', 'Personal']);
  assert.deepEqual(await h.call('accounts:rename', 'claude', id, ''), { ok: true });
  assert.equal(h.row(id).label, 'API key ••••4f2a');
  assert.equal((await h.call('accounts:rename', 'claude', 'gone', 'x')).code, 'account-missing');
  assert.deepEqual(h.switched, []);
});

test('removing a key account takes its key off this Mac; Claude Code’s own login is never removed here', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const a = await h.call('accounts:add-key', 'claude', KEY);
  const b = await h.call('accounts:add-key', 'claude', KEY2);
  await h.call('accounts:use', 'claude', a.id);
  h.switched.length = 0;

  assert.deepEqual(await h.call('accounts:remove', 'claude', b.id), { ok: true });
  assert.deepEqual([h.kept(), h.row(b.id), h.switched, h.accounts.pin('claude')], [[a.id], null, [], a.id], 'another account going changes nothing about the one in use');
  assert.ok(!h.onDisk().includes(b.id));

  const own = await h.call('accounts:remove', 'claude', 'claude-default');
  assert.deepEqual([own.ok, own.code], [false, 'not-removable']);
  assert.ok(h.row('claude-default'));
  for (const nope of ['gone', null, 7]) assert.equal((await h.call('accounts:remove', 'claude', nope)).code, 'account-missing');
  assert.equal((await h.call('accounts:remove', 'codex', a.id)).code, 'account-missing');

  // The key cannot be taken off the disk: the account stays, so nothing is said to be forgotten that is not.
  const drop = h.secrets.delete.bind(h.secrets);
  h.secrets.delete = () => false;
  const stuck = await h.call('accounts:remove', 'claude', a.id);
  assert.deepEqual([stuck.ok, stuck.code], [false, 'not-removed']);
  assert.deepEqual([h.kept(), h.row(a.id)?.id, h.accounts.pin('claude')], [[a.id], a.id, a.id]);
  h.secrets.delete = drop;

  // The one in use: new chats go back to the login Claude Code finds, and a chat still open on it refuses to start.
  assert.deepEqual(await h.call('accounts:remove', 'claude', a.id), { ok: true });
  assert.deepEqual([h.kept(), h.accounts.pin('claude'), h.accounts.view().inUse.claude, h.switched], [[], null, 'claude-default', ['claude']]);
  assert.deepEqual(h.accounts.envFor('claude'), ENV);
  assert.throws(() => h.accounts.envFor('claude', { account: a.id }), (err) => err.code === 'account-missing');
  assert.equal(h.secrets.get(a.id), null);
});

test('no key stays behind for an account that is gone', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  // Left over from before (the list was lost, or a removal was cut short).
  h.secrets.set('claude-key-orphan', key('orph'));
  const a = await h.call('accounts:add-key', 'claude', KEY);
  assert.deepEqual(h.kept(), [a.id]);
  h.secrets.set('claude-key-orphan', key('orph'));
  await h.call('accounts:remove', 'claude', a.id);
  assert.deepEqual(h.kept(), []);
});

test('a key Codex holds itself is Codex’s: Canopy does not replace it, remove it or keep anything for it', { timeout: 60000 }, async () => {
  const h = wire();
  // Codex signed in with an API key of its own: a key account that Canopy found, not one it added.
  const accounts = registerAccounts(() => {}, {
    claude: () => h.tool, codex: { installed: () => true, env: () => ENV, account: async () => ({ ok: true, signedIn: true, requiresAuth: true, account: { type: 'apiKey' } }) },
    load: () => null, save: () => {}, send: () => {},
  });
  const actions = registerAccountActions(() => {}, { accounts, secrets: h.secrets, fetch: async (url, init) => { h.asked.push({ url, init }); return answer(200); } });
  await accounts.refresh({ auth: { claude: CONSOLE } });
  const own = accounts.view().list.find((a) => a.id === 'codex-default');
  assert.deepEqual([own.kind, own.found], ['key', true]);
  assert.deepEqual([(await actions.remove('codex', 'codex-default')).code, (await actions.replaceKey('codex', 'codex-default', OKEY)).code, (await actions.addKey('codex', KEY)).code],
    ['not-removable', 'account-missing', 'wrong-maker']);
  assert.ok(accounts.view().list.some((a) => a.id === 'codex-default'));
  assert.deepEqual([h.asked.length, h.kept()], [0, []]);
  // Nor is it asked about: Codex is the one to say how its own key is doing.
  await actions.keyInDoubt('codex', 'codex-default');
  assert.equal(h.asked.length, 0);
});

// ---- an OpenAI key, for Codex ----

const PROVIDER = { name: 'OpenAI', base_url: 'https://api.openai.com/v1', env_key: 'CANOPY_OPENAI_API_KEY', wire_api: 'responses', requires_openai_auth: false };
const AS_FOUND = { env: ENV, config: {}, provider: null };

test('an OpenAI key pasted for Codex becomes an account beside Codex’s login: checked with OpenAI, kept in the vault, not switched to', { timeout: 60000 }, async () => {
  const h = wire({ codex: true });
  await h.found();
  assert.deepEqual(h.accounts.launchFor('codex'), AS_FOUND);

  assert.deepEqual(await h.call('accounts:add-key', 'codex', `  ${OKEY}\n`), { ok: true, id: 'codex-key-t1' });
  assert.equal(h.asked.length, 1, 'checked once, with OpenAI and nobody else');
  assert.deepEqual([h.asked[0].url, h.asked[0].init.headers, h.asked[0].init.redirect], ['https://api.openai.com/v1/models', { authorization: `Bearer ${OKEY}`, accept: 'application/json' }, 'error']);
  assert.deepEqual(h.row('codex-key-t1'), {
    id: 'codex-key-t1', engine: 'codex', kind: 'key', label: 'API key ••••7Hq2', email: null, org: null, plan: null,
    via: null, keyHint: '7Hq2', state: 'ok', why: null, found: false,
  });
  assert.deepEqual(h.accounts.view().list.map((a) => [a.id, a.found]), [['claude-default', true], ['codex-default', true], ['codex-key-t1', false]]);
  assert.deepEqual([h.accounts.view().active.codex, h.accounts.view().inUse.codex, h.switched], [null, 'codex-default', []], 'new chats still use the login Codex holds');
  assert.deepEqual(h.accounts.launchFor('codex'), AS_FOUND, 'and Codex is still launched exactly as it finds itself');

  // Where the key is: in the vault, encrypted, in a file only you can read. Where it is not: anywhere else.
  assert.deepEqual(h.kept(), ['codex-key-t1']);
  assert.equal(fs.statSync(path.join(h.dir, 'secrets.json')).mode & 0o777, 0o600);
  assert.equal(h.secrets.get('codex-key-t1'), OKEY);
  assert.ok(!h.everything().includes(OKEY) && !h.everything().includes('sk-proj') && !h.everything().includes('NOT-A-REAL-KEY'));
  assert.deepEqual(fs.readdirSync(h.dir), ['secrets.json'], 'and nothing else was written anywhere');
});

test('a Codex key in use is in the launch of Codex’s new chats and nowhere else; choosing, replacing and removing it reach main’s listeners', { timeout: 60000 }, async () => {
  const h = wire({ codex: true });
  await h.found();
  const { id } = await h.call('accounts:add-key', 'codex', OKEY);
  assert.deepEqual(await h.call('accounts:use', 'codex', id), { ok: true });
  assert.deepEqual([h.accounts.pin('codex'), h.accounts.view().inUse.codex, h.accounts.view().own.codex, h.switched], [id, id, 'codex-default', ['codex']]);
  const onKey = (secret) => ({ env: { ...ENV, CANOPY_OPENAI_API_KEY: secret }, config: { 'model_providers.canopy-openai': PROVIDER, model_provider: 'canopy-openai' }, provider: 'canopy-openai' });
  assert.deepEqual(h.accounts.launchFor('codex'), onKey(OKEY));
  assert.ok(!JSON.stringify(h.accounts.launchFor('codex').config).includes(OKEY), 'the key is in the environment only, never in a setting');
  assert.deepEqual(h.accounts.launchFor('codex', { account: null }), AS_FOUND, 'a chat that began on Codex’s login is launched as before');
  assert.deepEqual(h.accounts.envFor('claude'), ENV, 'and nothing of it reaches Claude’s chats');

  await h.call('accounts:rename', 'codex', id, 'Work key');
  assert.deepEqual(await h.call('accounts:replace-key', 'codex', id, OKEY2), { ok: true, id });
  assert.deepEqual([h.rekeyed, h.row(id).keyHint, h.row(id).label], [[['codex', id]], 'm3Xw', 'Work key']);
  assert.deepEqual(h.accounts.launchFor('codex'), onKey(OKEY2));
  assert.equal((await h.call('accounts:add-key', 'codex', OKEY2)).code, 'duplicate');
  assert.equal((await h.call('accounts:replace-key', 'codex', id, KEY)).code, 'wrong-maker', 'an Anthropic key does not replace an OpenAI one');
  assert.equal((await h.call('accounts:replace-key', 'claude', id, KEY)).code, 'account-missing', 'and the account is Codex’s, not Claude’s');
  // The same key under the other maker's name is refused by its shape, so one text is never two accounts.
  assert.equal((await h.call('accounts:add-key', 'claude', OKEY2)).code, 'not-a-key');
  // Refused, unreachable, and thrown at: nothing of those keys stays either.
  h.openai = () => answer(401);
  assert.equal((await h.call('accounts:add-key', 'codex', okey('rej1'))).code, 'rejected');
  h.openai = () => new Error(`connect failed while sending ${okey('thr1')}`);
  assert.equal((await h.call('accounts:add-key', 'codex', okey('thr1'))).code, 'unreachable');
  assert.equal((await h.call('accounts:replace-key', 'codex', id, okey('thr2'))).code, 'unreachable');
  assert.equal(h.secrets.get(id), OKEY2, 'the key it had stays until another checks out');
  h.openai = () => answer(200);

  // Back to the login Codex holds, by its row: nothing is chosen, and main hears a switch.
  assert.deepEqual(await h.call('accounts:use', 'codex', 'codex-default'), { ok: true });
  assert.deepEqual([h.accounts.pin('codex'), h.switched], [null, ['codex', 'codex']]);
  assert.deepEqual(h.accounts.launchFor('codex'), AS_FOUND);
  await h.call('accounts:use', 'codex', id);
  h.clock += 10 * 60_000;
  await h.call('accounts:refresh', true);
  await h.call('accounts:list');

  // Removed while in use: its key leaves this Mac, and new chats are back on Codex's own login.
  assert.deepEqual(await h.call('accounts:remove', 'codex', id), { ok: true });
  assert.deepEqual([h.kept(), h.row(id), h.accounts.pin('codex'), h.switched], [[], null, null, ['codex', 'codex', 'codex', 'codex']]);
  assert.deepEqual(h.accounts.launchFor('codex'), AS_FOUND);
  assert.throws(() => h.accounts.launchFor('codex', { account: id }), (err) => err.code === 'account-missing', 'a chat still on it does not start on another login');
  assert.equal((await h.call('accounts:remove', 'codex', 'codex-default')).code, 'not-removable');

  // No reply, event, saved state, log line or file ever held a key, whole or in part.
  assert.ok(h.replies.length >= 14 && h.sent.length > 5 && h.logs.length > 3);
  const all = h.everything();
  for (const secret of [OKEY, OKEY2, okey('rej1'), okey('thr1'), okey('thr2'), 'sk-proj', 'NOT-A-REAL-KEY', 'T3BlbkFJ']) assert.ok(!all.includes(secret), `${secret.slice(0, 14)}… is written or sent somewhere`);
  for (const file of fs.readdirSync(h.dir)) assert.ok(!fs.readFileSync(path.join(h.dir, file), 'utf8').includes('NOT-A-REAL-KEY'), file);
  for (const r of h.replies.filter((x) => 'ok' in x)) assert.deepEqual(Object.keys(r).filter((k) => !['ok', 'id', 'code', 'message', 'wasActive'].includes(k)), []);
});

test('a Codex key is checked with the accounts, by OpenAI: refused means "no longer works", and a chat that doubts it has it asked at once', { timeout: 60000 }, async () => {
  const h = wire({ codex: true });
  await h.found();
  const { id } = await h.call('accounts:add-key', 'codex', OKEY);
  await h.call('accounts:use', 'codex', id);
  const state = async (setup) => { setup?.(); h.clock += 10 * 60_000; await h.accounts.refresh(); return h.row(id).state; };
  assert.equal(await state(), 'ok');
  assert.equal(await state(() => { h.openai = () => new TypeError('fetch failed'); }), 'ok', 'offline is not a refusal');
  assert.equal(await state(() => { h.openai = () => answer(403); }), 'ok', 'OpenAI knowing the key but not listing models for it says nothing against the key');
  assert.equal(await state(() => { h.openai = () => answer(401); }), 'invalid-key');
  assert.throws(() => h.accounts.launchFor('codex'), (err) => err.code === 'account-invalid-key', 'no chat starts on it, and none starts on Codex’s login in its place');
  assert.equal(h.accounts.pin('codex'), id, 'it is still the one chosen: a key that stops working is not left behind for another login');
  assert.equal(await state(() => { h.openai = () => answer(200); }), 'ok');
  assert.ok(h.asked.every((c) => new URL(c.url).host === 'api.openai.com'), 'Anthropic is never asked about an OpenAI key');
  assert.equal(h.row('codex-default').state, 'ok', 'and none of it touched what is known of Codex’s own login');

  // A chat on the key was refused by OpenAI a moment after the key checked out: it is asked about now, not in five minutes.
  const before = h.asked.length;
  h.openai = () => answer(401);
  await h.accounts.refresh();
  assert.deepEqual([h.asked.length, h.row(id).state], [before, 'ok'], 'a re-read alone does not ask again so soon');
  await h.actions.keyInDoubt('codex', id);
  assert.deepEqual([h.asked.length, h.row(id).state], [before + 1, 'invalid-key']);
  // A reply came back on it after all: asked again, and it is fine.
  h.openai = () => answer(200);
  await h.actions.keyInDoubt('codex', id);
  assert.deepEqual([h.asked.length, h.row(id).state], [before + 2, 'ok']);
  // Doubts that arrive together are answered by one asking and one more, not one each.
  h.openai = () => answer(401);
  await Promise.all([h.actions.keyInDoubt('codex', id), h.actions.keyInDoubt('codex', id), h.actions.keyInDoubt('codex', id)]);
  assert.equal(h.row(id).state, 'invalid-key');
  assert.ok(h.asked.length <= before + 4, `asked ${h.asked.length - before - 2} times for three doubts`);
  // What is not a pasted key of that maker is not asked about.
  const quiet = h.asked.length;
  for (const [engine, account] of [['codex', 'codex-default'], ['claude', id], ['codex', 'gone'], ['gemini', id], ['codex', null]]) await h.actions.keyInDoubt(engine, account);
  assert.equal(h.asked.length, quiet);
  assert.ok(!h.everything().includes(OKEY));
});

// ---- how a key is doing ----

test('a key is checked with the accounts: refused means "no longer works", unreadable means "locked", no answer changes nothing', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  await h.call('accounts:use', 'claude', id);
  const state = async (setup) => { setup?.(); h.clock += 10 * 60_000; await h.accounts.refresh(); return h.row(id).state; };

  assert.equal(await state(), 'ok');
  assert.equal(await state(() => { h.anthropic = () => new TypeError('fetch failed'); }), 'ok', 'offline is not a refusal: the key is as good as it was');
  assert.equal(await state(() => { h.anthropic = () => answer(529); }), 'ok');
  assert.equal(h.accounts.envFor('claude').ANTHROPIC_API_KEY, KEY);
  assert.equal(await state(() => { h.anthropic = () => answer(401); }), 'invalid-key');
  assert.equal(await state(() => { h.anthropic = () => new TypeError('fetch failed'); }), 'invalid-key', 'offline says nothing new');
  assert.equal(await state(() => { h.anthropic = () => answer(503); }), 'invalid-key');
  assert.equal(await state(() => { h.anthropic = () => answer(200); }), 'ok');
  assert.equal(await state(() => { h.anthropic = () => answer(403); }), 'invalid-key');

  const asked = h.asked.length;
  assert.equal(await state(() => { h.safe.locked = true; }), 'locked');
  assert.equal(h.asked.length, asked, 'a key that cannot be read is not checked');
  assert.throws(() => h.accounts.envFor('claude'), (err) => err.code === 'account-locked');
  assert.equal(await state(() => { h.safe.locked = false; h.anthropic = () => answer(200); }), 'ok');
  assert.equal(h.accounts.envFor('claude').ANTHROPIC_API_KEY, KEY);
  // The file is gone (deleted by hand): the key cannot be read, and it says so the same way.
  fs.rmSync(path.join(h.dir, 'secrets.json'));
  const fresh = new Secrets({ file: path.join(h.dir, 'secrets.json'), safe: h.safe });
  const actions = registerAccountActions(() => {}, { accounts: h.accounts, secrets: fresh, fetch: async () => answer(200) });
  assert.deepEqual(await actions.verifyKey(h.accounts.view().list.find((a) => a.id === id)), { state: 'locked' });
  assert.deepEqual(await actions.verifyKey(null), { state: 'locked' });
  assert.deepEqual(await actions.verifyKey({}), { state: 'locked' });
});

test('a key that checked out is not sent to Anthropic again for a few minutes, however often the accounts are re-read', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  assert.equal(h.asked.length, 1);
  await h.accounts.refresh();
  await h.call('accounts:refresh', true);
  await h.accounts.refresh();
  assert.equal(h.asked.length, 1, 'checked when it was added, a moment ago');
  h.clock += 5 * 60_000;
  await h.accounts.refresh();
  assert.equal(h.asked.length, 2);
  // A key that is not fine is asked about every time: someone is trying to fix it.
  h.anthropic = () => answer(401);
  h.clock += 5 * 60_000;
  await h.accounts.refresh();
  await h.accounts.refresh();
  await h.accounts.refresh();
  assert.deepEqual([h.asked.length, h.row(id).state], [5, 'invalid-key']);
  for (const call of h.asked) assert.deepEqual([call.init.method, call.init.headers['x-api-key'], call.init.body], ['GET', KEY, undefined], 'only ever the same question');
});

test('a key that works does not clear a problem the key check cannot see', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  await h.call('accounts:use', 'claude', id);
  // A chat started on the key, and Claude Code reported another login (something in its settings outranks the key).
  h.accounts.reported('claude', id, { apiKeySource: 'apiKeyHelper', provider: 'firstParty' });
  assert.equal(h.row(id).state, 'mismatch');
  h.clock += 10 * 60_000;
  await h.accounts.refresh();
  assert.equal(h.row(id).state, 'mismatch', 'Anthropic accepting the key does not make the chat run on it');
  assert.throws(() => h.accounts.envFor('claude'), (err) => err.code === 'account-mismatch');
  // What the check can see, it still says: the key is refused.
  h.anthropic = () => answer(401);
  h.clock += 10 * 60_000;
  await h.accounts.refresh();
  assert.equal(h.row(id).state, 'invalid-key');
  // And a chat that does start on the key clears it, as for any account.
  h.anthropic = () => answer(200);
  assert.equal((await h.call('accounts:replace-key', 'claude', id, KEY2)).ok, true);
  h.accounts.reported('claude', id, { apiKeySource: 'apiKeyHelper', provider: 'firstParty' });
  h.accounts.reported('claude', id, { apiKeySource: 'ANTHROPIC_API_KEY', provider: 'firstParty' });
  assert.equal(h.row(id).state, 'ok');
});

test('when Claude Code’s own settings choose the login, a pasted key is shown as not usable instead of running unseen on another', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const first = await h.call('accounts:add-key', 'claude', KEY);
  await h.call('accounts:use', 'claude', first.id);
  assert.equal(h.accounts.envFor('claude').ANTHROPIC_API_KEY, KEY);

  // A key (or a proxy, or a cloud switch) appears in the `env` block of Claude Code's settings: it would win.
  h.outranked = (engine) => engine === 'claude';
  // Before the accounts are even looked at again, the key cannot be switched to.
  await h.call('accounts:use', 'claude', null);
  const early = await h.call('accounts:use', 'claude', first.id);
  assert.deepEqual([h.row(first.id).state, early.ok, early.code], ['ok', false, 'account-blocked']);
  assert.match(early.message, /API key ••••4f2a can’t be used: your Claude Code settings choose the login\./);
  h.outranked = () => false;
  await h.call('accounts:use', 'claude', first.id);
  h.outranked = (engine) => engine === 'claude';
  const asked = h.asked.length;
  h.clock += 10 * 60_000;
  await h.accounts.refresh();
  assert.deepEqual([h.row(first.id).state, h.row(first.id).why], ['blocked', 'your Claude Code settings choose the login']);
  assert.equal(h.asked.length, asked, 'the key is not sent anywhere to find that out');
  assert.throws(() => h.accounts.envFor('claude'), (err) => err.code === 'account-blocked' && /API key ••••4f2a can’t be used: your Claude Code settings choose the login/.test(err.message));
  assert.ok(h.askedAbout.every((engine) => engine === 'claude'));

  // Another key can still be added (it is a good key), is listed the same way, and cannot be switched to.
  const second = await h.call('accounts:add-key', 'claude', KEY2);
  assert.equal(second.ok, true);
  await h.accounts.queue;   // the check the add asked for
  assert.equal(h.row(second.id).state, 'blocked');
  const refusedUse = await h.call('accounts:use', 'claude', second.id);
  assert.deepEqual([refusedUse.ok, refusedUse.code, refusedUse.message], [false, 'account-blocked', 'API key ••••9z9z can’t be used: your Claude Code settings choose the login.']);
  assert.equal(h.accounts.pin('claude'), first.id);
  // Replacing a key does not make it usable either.
  assert.equal((await h.call('accounts:replace-key', 'claude', first.id, key('rep1'))).ok, true);
  await h.accounts.queue;
  assert.deepEqual([h.row(first.id).state, h.row(first.id).keyHint], ['blocked', 'rep1']);
  // Claude Code's own login is not a pasted key: choosing it is not this check's business.
  assert.deepEqual(await h.call('accounts:use', 'claude', 'claude-default'), { ok: true });

  // The settings no longer choose: the keys are fine again at the next check.
  h.outranked = () => false;
  await h.accounts.refresh();
  assert.deepEqual([h.row(first.id).state, h.row(first.id).why, h.row(second.id).state], ['ok', null, 'ok']);
  assert.deepEqual(await h.call('accounts:use', 'claude', second.id), { ok: true });
  // A check that cannot tell is not a reason to stop a key.
  h.outranked = () => { throw new Error('settings.json could not be read'); };
  h.clock += 10 * 60_000;
  await h.accounts.refresh();
  assert.equal(h.row(second.id).state, 'ok');
  h.outranked = () => 'yes';
  await h.accounts.refresh();
  assert.equal(h.row(second.id).state, 'ok', 'only a plain yes');
});

test('offline, the check that runs with the accounts gives up soon and changes nothing', { timeout: 20000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  let signal = null;
  const never = (_url, init) => new Promise((_resolve, reject) => { signal = init.signal; init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const actions = registerAccountActions(() => {}, { accounts: h.accounts, secrets: h.secrets, fetch: never, recheckTimeoutMs: 40 });
  const started = Date.now();
  assert.deepEqual(await actions.verifyKey(h.accounts.view().list.find((a) => a.id === id)), { state: 'unknown' });
  assert.ok(signal.aborted && Date.now() - started < 5000, 'well under the fifteen seconds a paste is given');
  assert.equal(h.row(id).state, 'ok');
});

test('an answer about a key that was replaced meanwhile says nothing about the new one', { timeout: 60000 }, async () => {
  const h = wire();
  await h.found();
  const { id } = await h.call('accounts:add-key', 'claude', KEY);
  h.clock += 10 * 60_000;
  let release;
  h.anthropic = (_url, init) => (init.headers['x-api-key'] === KEY
    ? new Promise((resolve) => { release = () => resolve(answer(401)); })   // the old key: refused, but slowly
    : answer(200));
  const checking = h.accounts.refresh();
  while (!release) await new Promise((r) => setImmediate(r));
  assert.equal((await h.call('accounts:replace-key', 'claude', id, KEY2)).ok, true);
  release();
  await checking;
  assert.deepEqual([h.row(id).state, h.row(id).keyHint], ['ok', '9z9z']);
});

// ---- the model check after a switch ----

test('after a switch the model check runs again, whatever it found before, and after one already running', { skip: U.__missing ? `upkeep.mjs: ${U.__missing}` : false, timeout: 60000 }, async () => {
  const probes = [];
  let hold = null;
  const upkeep = new U.Upkeep({
    claude: () => ({ path: '/c/claude', env: {}, version: '2.1.325' }),
    probe: async () => { const n = probes.push('started'); if (hold) await hold; probes[n - 1] = 'done'; return { cliVersion: '2.1.325', models: [], resolved: {} }; },
    load: () => null, save: () => {}, schedule: false,
  });
  await upkeep.ensureModels();
  await upkeep.ensureModels();
  assert.equal(probes.length, 1, 'by itself, the check runs once per Claude Code version');
  await recheckModels(upkeep);
  assert.equal(probes.length, 2, 'the same version, but another account: asked again');

  // A check is in flight (asked on the account before): it finishes first, then the models are asked for again.
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const running = upkeep.ensureModels({ force: true });
  const again = recheckModels(upkeep);
  const twice = recheckModels(upkeep);   // and a second switch right behind it
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(probes.slice(2), ['started'], 'not two at once');
  release(); hold = null;
  await Promise.all([running, again, twice]);
  assert.deepEqual(probes.slice(2), ['done', 'done'], 'one more after the one that was running, not one per switch');

  // Nothing to check with, or a check that breaks: never an error for the switch that asked.
  assert.equal(await recheckModels(null), null);
  assert.equal(await recheckModels({}), null);
  assert.equal(await recheckModels({ probing: Promise.reject(new Error('boom')), ensureModels: async () => 'checked' }), 'checked');
  assert.equal(await recheckModels({ ensureModels: async () => { throw new Error('boom'); } }), null);
});

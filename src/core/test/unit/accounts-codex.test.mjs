// accounts-codex.mjs: reading who Codex is signed in as. The answers here are made up in the shape
// CodexService.account() gives; no Codex is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CORE, core } from '../helpers.mjs';

const X = await core('accounts-codex.mjs');
const A = await core('accounts.mjs');
const missing = X.__missing ? `accounts-codex.mjs: ${X.__missing}` : A.__missing ? `accounts.mjs: ${A.__missing}` : false;

const PLAN = { ok: true, signedIn: true, requiresAuth: true, account: { type: 'chatgpt', email: 'me@example.com', plan: 'pro' } };
const KEY = { ok: true, signedIn: true, requiresAuth: true, account: { type: 'apiKey', email: null, plan: null } };
const BASE = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/Users/someone', OPENAI_API_KEY: 'sk-shell', CODEX_HOME: '/Users/someone/.codex' });

function engine(answer, { installed = true } = {}) {
  const calls = [];
  const eng = X.codexAccounts({ account: async () => { calls.push('account'); return typeof answer === 'function' ? answer() : answer; }, installed: () => installed, env: () => BASE });
  return { eng, calls };
}

test('describeAccount: a plan, a key, signed out, and not knowing', { skip: missing }, () => {
  const d = X.describeAccount;
  assert.deepEqual(d(PLAN), { state: 'ok', kind: 'plan', via: null, email: 'me@example.com', plan: 'pro' });
  assert.deepEqual(d(KEY), { state: 'ok', kind: 'key', via: null, email: null, plan: null });
  assert.deepEqual(d({ ok: true, signedIn: false, requiresAuth: true, account: null }), { state: 'signed-out' });
  assert.deepEqual(d({ ok: true, signedIn: false, requiresAuth: false, account: null }), { state: 'none' }, 'a provider of their own needs no OpenAI sign-in');
  assert.deepEqual(d({ ok: true, signedIn: true, account: { type: 'somethingNew', email: 'a@b.c' } }), { state: 'ok', kind: 'external', via: 'somethingNew', email: 'a@b.c', plan: null });
  for (const failed of [{ ok: false, code: 'timeout', message: 'x' }, null, undefined, 'x', {}]) assert.deepEqual(d(failed), { state: 'unknown' }, 'a helper that did not answer is never "signed out"');
});

test('detect: what Codex says, nothing when Codex is not on this Mac, and no guess when it does not answer', { skip: missing }, async () => {
  assert.deepEqual(await engine(PLAN).eng.detect(), { known: true, accounts: [{ id: 'codex-default', state: 'ok', kind: 'plan', via: null, email: 'me@example.com', plan: 'pro' }] });
  assert.deepEqual(await engine({ ok: true, signedIn: false, requiresAuth: true }).eng.detect(), { known: true, accounts: [{ id: 'codex-default', state: 'signed-out' }] });
  assert.deepEqual(await engine({ ok: true, signedIn: false, requiresAuth: false }).eng.detect(), { known: true, accounts: [] });
  assert.deepEqual(await engine({ ok: false, code: 'closed' }).eng.detect(), { known: false });
  const away = engine(PLAN, { installed: false });
  assert.deepEqual(await away.eng.detect(), { known: true, accounts: [] });
  assert.deepEqual(away.calls, [], 'no Codex: no helper is started to ask');
  assert.deepEqual(await X.codexAccounts({ installed: () => { throw new Error('x'); } }).detect(), { known: true, accounts: [] });
});

test('in the registry: an OpenAI row beside Claude’s, in use, and Codex launched as it finds itself', { skip: missing }, async () => {
  const { eng } = engine(KEY);
  const claude = { ids: [], base: () => ({ PATH: '/usr/bin' }), detect: async () => ({ known: true, accounts: [] }), launchEnv: (a, base) => ({ ...base }), asFound: () => null, label: () => 'x', agrees: () => null };
  const reg = new A.Accounts({ engines: { claude, codex: eng } });
  const view = await reg.refresh();
  assert.deepEqual(view.list, [{ id: 'codex-default', engine: 'codex', kind: 'key', label: 'API key', email: null, org: null, plan: null, via: null, keyHint: null, state: 'ok', why: null, found: true }]);
  assert.deepEqual(view.inUse, { claude: null, codex: 'codex-default' });
  assert.deepEqual(reg.envFor('codex'), BASE, 'the environment Codex gets is the base, key for key');
  assert.equal(JSON.stringify(reg.envFor('codex')), JSON.stringify(BASE));
  assert.deepEqual(reg.launchFor('codex'), { env: BASE, config: {}, provider: null }, 'and no setting of Canopy’s goes with it');
  // Choosing the login Codex holds is choosing nothing: it is launched as Codex finds itself, as it always was.
  assert.deepEqual(reg.setActive('codex', 'codex-default'), { ok: true });
  assert.deepEqual([reg.pin('codex'), reg.view().active.codex, reg.view().inUse.codex], [null, null, 'codex-default']);
  assert.deepEqual(reg.launchFor('codex'), { env: BASE, config: {}, provider: null });
  assert.deepEqual(reg.launchFor('codex', { account: 'codex-default' }), { env: BASE, config: {}, provider: null }, 'named outright, it is the same launch');
  assert.throws(() => eng.launchEnv(null, null), (err) => err.code === 'no-env');
  assert.deepEqual([X.labelFor({ kind: 'plan', plan: 'plus' }), X.labelFor({ kind: 'plan' }), X.labelFor({ kind: 'key' }), X.labelFor({ kind: 'key', keyHint: '9zQx' }), X.labelFor({ kind: 'external' })],
    ['ChatGPT Plus', 'ChatGPT plan', 'API key', 'API key ••••9zQx', 'Codex login']);
});

// ---- an OpenAI API key pasted into Canopy: an account of its own, beside the login Codex holds ----

const SECRET = 'sk-proj-NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstuvwxyz-9zQx';
const PASTED = Object.freeze({ id: 'codex-key-1', engine: 'codex', kind: 'key', keyHint: '9zQx' });
const PROVIDER = { name: 'OpenAI', base_url: 'https://api.openai.com/v1', env_key: 'CANOPY_OPENAI_API_KEY', wire_api: 'responses', requires_openai_auth: false };

test('the launch recipe: nothing chosen is Codex as it finds itself, and a pasted key rides in one variable of its own process', { skip: missing }, () => {
  // Nothing chosen, and the login Codex holds (a plan, or a key of Codex's own): the base, and nothing else.
  for (const account of [null, undefined, { id: 'codex-default', engine: 'codex', kind: 'plan' }, { id: 'codex-default', engine: 'codex', kind: 'key' }]) {
    const env = X.launchEnv(account, BASE, { key: SECRET });
    assert.deepEqual(env, BASE, String(account?.kind));
    assert.notEqual(env, BASE, 'always a new object');
    assert.deepEqual(X.launchConfig(account), {}, 'no setting of Canopy’s');
    assert.equal(X.isPastedKey(account), false);
  }
  // A pasted key: the base as it is (the user's own variables too), plus the key under Canopy's own name.
  const env = X.launchEnv(PASTED, BASE, { key: SECRET, name: 'Work key' });
  assert.deepEqual(env, { ...BASE, CANOPY_OPENAI_API_KEY: SECRET });
  assert.deepEqual([X.KEY_VAR, X.KEY_PROVIDER, X.isPastedKey(PASTED)], ['CANOPY_OPENAI_API_KEY', 'canopy-openai', true]);
  assert.equal(env.OPENAI_API_KEY, 'sk-shell', 'what the shell exports is the user’s, and is left alone');
  assert.equal(env.CODEX_HOME, BASE.CODEX_HOME, 'Codex’s own folder stays the one it uses: no other is made for the key');
  // Its settings name a provider that is OpenAI's own API and reads the key from that variable. The key is not in them.
  const config = X.launchConfig(PASTED);
  assert.deepEqual(config, { 'model_providers.canopy-openai': PROVIDER, model_provider: 'canopy-openai' });
  assert.ok(!JSON.stringify(config).includes(SECRET) && !JSON.stringify(X.launchConfig({ ...PASTED, key: SECRET })).includes(SECRET));
  // A key that cannot be read never starts Codex on the login it holds instead.
  for (const key of [null, undefined, '', 7]) assert.throws(() => X.launchEnv(PASTED, BASE, { key, name: 'Work key' }), (err) => err.code === 'account-locked' && /Work key/.test(err.message));
  assert.throws(() => X.launchEnv(PASTED, null, { key: SECRET }), (err) => err.code === 'no-env');
  // Nor is anything else Canopy might one day list for Codex.
  for (const other of [{ id: 'codex-2', engine: 'codex', kind: 'plan', dir: '/x' }, { id: 'codex-3', engine: 'codex', kind: 'external' }]) {
    assert.throws(() => X.launchEnv(other, BASE, { key: SECRET }), (err) => err.code === 'account-unsupported');
    assert.deepEqual(X.launchConfig(other), {});
  }
});

test('in the registry: a pasted key is listed beside Codex’s login, is launched on its own recipe, and is checked by the host', { skip: missing }, async () => {
  const checked = [];
  const eng = X.codexAccounts({
    account: async () => PLAN, installed: () => true, env: () => BASE,
    checkKey: async (a) => { checked.push(a.id); return { state: 'ok' }; },
  });
  const claude = { ids: [], base: () => ({ PATH: '/usr/bin' }), detect: async () => ({ known: true, accounts: [] }), launchEnv: (a, base) => ({ ...base }), asFound: () => null, label: () => 'x', agrees: () => null };
  const saved = [];
  const reg = new A.Accounts({ engines: { claude, codex: eng }, keyFor: (a) => (a.id === 'codex-key-1' ? SECRET : null), save: (state) => saved.push(JSON.stringify(state)) });
  await reg.refresh();
  assert.deepEqual(reg.add({ ...PASTED, state: 'ok' }), { ok: true, id: 'codex-key-1' });
  const view = await reg.refresh();
  assert.deepEqual(view.list.map((a) => [a.id, a.kind, a.label, a.found, a.state]), [['codex-default', 'plan', 'ChatGPT Pro', true, 'ok'], ['codex-key-1', 'key', 'API key ••••9zQx', false, 'ok']]);
  assert.deepEqual(checked, ['codex-key-1'], 'only the key is the host’s to check: Codex’s own login is asked of Codex');
  assert.deepEqual([view.active.codex, view.inUse.codex, view.own.codex], [null, 'codex-default', 'codex-default'], 'adding does not switch');
  assert.deepEqual(reg.launchFor('codex'), { env: BASE, config: {}, provider: null });

  assert.deepEqual(reg.setActive('codex', 'codex-key-1'), { ok: true });
  assert.deepEqual([reg.view().inUse.codex, reg.view().own.codex], ['codex-key-1', 'codex-default']);
  assert.deepEqual(reg.launchFor('codex'), {
    env: { ...BASE, CANOPY_OPENAI_API_KEY: SECRET },
    config: { 'model_providers.canopy-openai': PROVIDER, model_provider: 'canopy-openai' }, provider: 'canopy-openai',
  });
  // A chat keeps the account it started on: one on Codex's login is launched as before, whatever is in use now.
  assert.deepEqual(reg.launchFor('codex', { account: null }), { env: BASE, config: {}, provider: null });
  // The base a caller hands in is what the key is added to (a Codex process's own environment, see codex-host.mjs).
  assert.deepEqual(reg.launchFor('codex', { base: { PATH: '/bin' } }).env, { PATH: '/bin', CANOPY_OPENAI_API_KEY: SECRET });
  // A key marked as not working is not launched, and neither is Codex's login in its place.
  reg.note('codex-key-1', { state: 'invalid-key' });
  assert.throws(() => reg.launchFor('codex'), (err) => err.code === 'account-invalid-key' && /no longer works/.test(err.message));
  reg.note('codex-key-1', { state: 'ok' });
  // Back to Codex's own login, by its row: nothing is chosen again.
  assert.deepEqual(reg.setActive('codex', 'codex-default'), { ok: true });
  assert.deepEqual([reg.pin('codex'), reg.view().inUse.codex], [null, 'codex-default']);
  // Removed while chosen: new chats are back on Codex's login, and a chat still on the key refuses its next start.
  reg.setActive('codex', 'codex-key-1');
  assert.deepEqual(reg.remove('codex', 'codex-key-1'), { ok: true, wasActive: true });
  assert.deepEqual(reg.launchFor('codex'), { env: BASE, config: {}, provider: null });
  assert.throws(() => reg.launchFor('codex', { account: 'codex-key-1' }), (err) => err.code === 'account-missing');
  assert.deepEqual(reg.remove('codex', 'codex-default').code, 'not-removable', 'Codex’s own login is never Canopy’s to remove');
  // Nothing that was saved or shown along the way holds the key.
  assert.ok(saved.length > 3);
  assert.ok(!saved.join('').includes(SECRET) && !saved.join('').includes('sk-proj') && !JSON.stringify(reg.view()).includes(SECRET));
});

test('the account a chat opens on: a new one by what is in use, a saved one by how it began', { skip: missing }, () => {
  const isKey = (id) => ['codex-key-1', 'codex-key-2'].includes(id);
  const on = (o) => X.chatAccount({ isKey, ...o });
  // A new chat takes the account in use (nothing chosen: Codex as it finds itself).
  assert.deepEqual([on({}), on({ inUse: null }), on({ inUse: 'codex-key-1' }), on({ saved: false, began: 'codex-key-2', inUse: 'codex-key-1' })], [null, null, 'codex-key-1', 'codex-key-1']);
  // A chat begun on Codex's own login opens on that login, whatever is in use: Codex opens it nowhere else.
  for (const inUse of [null, 'codex-key-1', 'codex-key-2']) assert.equal(on({ saved: true, began: null, inUse }), null, String(inUse));
  assert.equal(on({ saved: true, inUse: 'codex-key-1' }), null, 'a chat from before there were keys began on Codex’s login');
  // A chat begun on a key opens on a key: its own while that is in Canopy, whatever is in use.
  for (const inUse of [null, 'codex-key-1', 'codex-key-2']) assert.equal(on({ saved: true, began: 'codex-key-2', inUse }), 'codex-key-2', String(inUse));
  // Its key is gone: the key in use now, if one is.
  assert.equal(on({ saved: true, began: 'codex-key-gone', inUse: 'codex-key-1' }), 'codex-key-1');
  // With no key to open it on, it keeps the account it began on: the chat then says that account is gone,
  // instead of starting on Codex's login (where Codex would refuse it anyway).
  assert.equal(on({ saved: true, began: 'codex-key-gone', inUse: null }), 'codex-key-gone');
  assert.equal(X.chatAccount({ saved: true, began: 'codex-key-gone', inUse: 'codex-key-1' }), 'codex-key-gone', 'nothing to ask about keys: nothing is assumed to be one');
  assert.equal(X.chatAccount({ saved: true, began: 'codex-key-gone', inUse: 'codex-key-1', isKey: () => { throw new Error('x'); } }), 'codex-key-gone');
  assert.equal(X.chatAccount(), null);
  for (const odd of [7, {}, '', undefined]) assert.equal(on({ saved: true, began: odd, inUse: 'codex-key-1' }), null, String(odd));
  // The login Codex holds is never named as a chat's account: a chat with a name for its account is on a pasted key.
  assert.deepEqual([on({ inUse: 'codex-default' }), on({ saved: true, began: 'codex-default', inUse: 'codex-key-1' }), on({ saved: true, began: 'codex-key-gone', inUse: 'codex-default' })], [null, null, 'codex-key-gone']);
});

// ---- what Codex's answer cannot say: a login OpenAI refused, and a sign-out on purpose ----

const OUT = { ok: true, signedIn: false, requiresAuth: true, account: null };

// An engine whose answers a test can change, with a registry around it the way main builds one.
function live(first, { works } = {}) {
  const say = { account: first, works: works ?? { ok: false, code: 'rejected' } };
  const asked = { account: 0, works: 0 };
  const eng = X.codexAccounts({
    account: async () => { asked.account += 1; return say.account; }, installed: () => true, env: () => BASE,
    works: async () => { asked.works += 1; if (say.works instanceof Error) throw say.works; return say.works; },
  });
  const claude = { ids: [], base: () => ({ PATH: '/usr/bin' }), detect: async () => ({ known: true, accounts: [] }), launchEnv: (a, base) => ({ ...base }), asFound: () => null, label: () => 'x', agrees: () => null };
  const reg = new A.Accounts({ engines: { claude, codex: eng } });
  const row = async () => (await reg.refresh()).list.find((a) => a.engine === 'codex') ?? null;
  return { eng, reg, say, asked, row };
}

test('a login OpenAI refused is listed as needing a sign-in, though Codex still answers "signed in"', { skip: missing }, async () => {
  const { eng, say, asked, row } = live(PLAN);
  assert.equal((await row()).state, 'ok');
  assert.equal(asked.works, 0, 'a login nobody doubts is not put to any test');
  eng.refused();
  assert.deepEqual(eng.known(), { state: 'expired', kind: 'plan', via: null });
  const marked = await row();
  assert.deepEqual([marked.state, marked.label, marked.email], ['expired', 'ChatGPT Pro', 'me@example.com'], 'who it is stays on the row');
  assert.equal((await row()).state, 'expired', 'and asking again does not clear it: Codex has nothing new to say');
  assert.equal((await eng.read()).state, 'expired');
  // A key is not "signed out": it no longer works. No limits are read for one (a key has none).
  const key = live(KEY);
  await key.row();
  key.eng.refused();
  assert.equal((await key.row()).state, 'invalid-key');
  assert.equal(key.asked.works, 0);
  // Not knowing changes nothing: neither the row nor what is remembered.
  say.account = { ok: false, code: 'timeout' };
  assert.deepEqual([(await eng.read()).state, (await row()).state, eng.known().state], ['unknown', 'expired', 'expired']);
});

test('what shows a refused login works after all: a reply, a new sign-in, another login, its limits being read', { skip: missing }, async () => {
  // Told so (a reply came back, or a sign-in was completed).
  const a = live(PLAN);
  await a.row();
  a.eng.refused();
  a.eng.accepted();
  assert.equal((await a.row()).state, 'ok');
  // Codex holds a different login now: the refusal was about the old one.
  const b = live(PLAN);
  await b.row();
  b.eng.refused();
  b.say.account = { ...PLAN, account: { type: 'chatgpt', email: 'other@example.com', plan: 'plus' } };
  const other = await b.row();
  assert.deepEqual([other.state, other.email, other.label], ['ok', 'other@example.com', 'ChatGPT Plus']);
  // The login is gone: the refusal goes with it, and does not come back to mark the next one.
  const c = live(PLAN);
  await c.row();
  c.eng.refused();
  c.say.account = OUT;
  assert.equal((await c.row()).state, 'signed-out');
  c.say.account = PLAN;
  assert.equal((await c.row()).state, 'ok');
  // A plan's login that can read its own limits is one OpenAI takes: a refusal that passed is forgotten.
  const d = live(PLAN, { works: { ok: true } });
  await d.row();
  d.eng.refused();
  assert.equal((await d.row()).state, 'ok', 'one refused call signs nobody out');
  assert.equal(d.asked.works, 1);
  await d.row();
  assert.equal(d.asked.works, 1, 'and once cleared, it is not asked again');
  // A read that fails, or throws, says nothing either way.
  for (const works of [{ ok: false, code: 'timeout' }, new Error('helper bug'), null]) {
    const e = live(PLAN, { works });
    await e.row();
    e.eng.refused();
    assert.equal((await e.row()).state, 'expired');
  }
  // Refused before Codex had said who is signed in: it stands against the login Codex names next.
  const f = live(PLAN);
  f.eng.refused();
  assert.equal(f.eng.known(), null);
  assert.equal((await f.eng.read()).state, 'expired');
});

test('signed out on purpose: the account leaves the list, and is back the moment Codex has a login again', { skip: missing }, async () => {
  const { eng, say, row } = live(PLAN);
  assert.equal((await row()).state, 'ok');
  // Signed out behind Canopy's back (in the terminal): the account stays, as something to fix.
  say.account = OUT;
  assert.equal((await row()).state, 'signed-out');
  // Signed out here, by the user: it goes.
  eng.left();
  assert.equal(await row(), null);
  assert.deepEqual(eng.known(), { state: 'signed-out', kind: null, via: null });
  assert.deepEqual(await eng.detect(), { known: true, accounts: [] });
  say.account = KEY;
  assert.deepEqual([(await row()).state, (await row()).kind], ['ok', 'key']);
  // That was forgotten once someone signed in: a later sign-out elsewhere is a problem again.
  say.account = OUT;
  assert.equal((await row()).state, 'signed-out');
});

test('codexStatus: the registry’s account answers; with none, Codex’s last word; nothing is said before Codex has spoken', { skip: missing }, () => {
  const s = X.codexStatus;
  const ok = { state: 'ok', kind: 'plan', via: null };
  assert.deepEqual(s({ state: 'ok', kind: 'plan', via: null }, ok), { signedIn: true, method: 'chatgpt' });
  assert.deepEqual(s({ state: 'ok', kind: 'key', via: null }, { state: 'ok', kind: 'key', via: null }), { signedIn: true, method: 'apiKey' });
  assert.deepEqual(s({ state: 'ok', kind: 'external', via: 'somethingNew' }, ok), { signedIn: true, method: 'somethingNew' });
  for (const state of ['signed-out', 'expired', 'invalid-key', 'mismatch', 'missing', 'locked', 'blocked']) {
    assert.deepEqual(s({ state, kind: 'plan', via: null }, ok), { signedIn: false, method: null }, state);
  }
  // No account in the list (or one still being checked): what Codex last said.
  for (const row of [null, undefined, { state: 'unknown', kind: 'plan' }, { state: 'checking', kind: 'plan' }]) {
    assert.deepEqual(s(row, ok), { signedIn: true, method: 'chatgpt' });
    assert.deepEqual(s(row, { state: 'signed-out', kind: null, via: null }), { signedIn: false, method: null });
    assert.deepEqual(s(row, { state: 'expired', kind: 'plan', via: null }), { signedIn: false, method: null });
    assert.deepEqual(s(row, { state: 'none', kind: null, via: null }), { signedIn: true, method: null }, 'a provider of their own needs no OpenAI sign-in');
  }
  // Codex has not said anything in this run: an account saved by the last run is not a fact.
  for (const known of [null, undefined]) assert.deepEqual(s({ state: 'ok', kind: 'plan', via: null }, known), { signedIn: null, method: null });
});

// Every shipped source file: the main process, the core and the window. Tests and node_modules are not the app.
function appSources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'test' && e.name !== 'node_modules') walk(p); }
      else if (/\.(mjs|cjs|js|ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  const src = path.resolve(CORE, '..');
  walk(src);
  const renderer = path.resolve(src, '..', 'renderer', 'src');
  if (fs.existsSync(renderer)) walk(renderer);
  return out.map((file) => ({ file: path.relative(path.resolve(src, '..'), file), text: fs.readFileSync(file, 'utf8') }));
}

test('what Canopy asks Codex about an account: who is signed in, Codex’s own sign-in and sign-out, and the plan’s limits. Nothing else', { skip: missing }, async () => {
  const H = await core('codex-host.mjs');
  // The calls Canopy makes. This line is the lock: a sixth call means changing it on purpose.
  const CALLS = ['account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read'];
  assert.deepEqual([...H.ACCOUNT_CALLS].sort(), [...CALLS].sort(), 'what a Codex process may be sent (refused otherwise: codex-account.test.mjs)');
  // Lines Codex writes on its own. Canopy reads the first three; the last is Codex asking a client for a token,
  // which Canopy always refuses.
  const FROM_CODEX = ['account/updated', 'account/login/completed', 'account/rateLimits/updated', 'account/chatgptAuthTokens/refresh'];

  // Every `account/…` name written anywhere in the app is one of those. So the calls that spend a user's credits
  // or send mail in their name are not only refused when asked for: nothing in the app asks for them.
  const files = appSources();
  assert.ok(files.length > 40 && files.some((f) => f.file === path.join('src', 'core', 'codex-host.mjs')), 'the scan sees the app');
  // A name is what stands between quotes or backticks, which is how a call is written and how a comment cites one.
  const named = new Map(); // name -> the files that write it
  for (const { file, text } of files) for (const m of text.matchAll(/['"`](account\/[A-Za-z][A-Za-z/]*)['"`]/gi)) named.set(m[1], [...(named.get(m[1]) ?? []), file]);
  for (const [name, where] of named) assert.ok(CALLS.includes(name) || FROM_CODEX.includes(name), `${where[0]} names ${name}`);
  for (const call of CALLS) assert.ok(named.has(call), `${call} is made somewhere`);
  // And no name is put together at run time, where this scan could not read it. The one bare `account/` in the app
  // is the test for "is this call about the account?" that the refusal itself starts from.
  const pieced = files.filter((f) => /['"`]account\/(['"`]|\$\{)/i.test(f.text)).map((f) => f.file);
  assert.deepEqual(pieced, [path.join('src', 'core', 'codex-host.mjs')]);
  assert.equal(files.find((f) => f.file === pieced[0]).text.match(/['"`]account\/(['"`]|\$\{)/gi).length, 1);
  for (const { file, text } of files) for (const never of ['rateLimitResetCredit', 'sendAddCreditsNudgeEmail']) assert.ok(!text.includes(never), `${file} mentions ${never}`);
  // What Codex writes on its own is only ever listened for: none of it is sent (it would be refused if it were).
  for (const { file, text } of files) for (const heard of FROM_CODEX) assert.ok(!new RegExp(`(?:request|ask|call)\\(\\s*['"\`]${heard}`).test(text), `${file} sends ${heard}`);

  // The three calls that change the login are written in one file, behind the methods that guard them.
  const host = path.join('src', 'core', 'codex-host.mjs');
  for (const call of ['account/login/start', 'account/login/cancel', 'account/logout']) assert.deepEqual([...new Set(named.get(call))], [host], call);
  // And a sign-in is sent in one place, as Codex's own browser sign-in: never with a key, and never with a token
  // (the kind of sign-in that would run Codex on a login Canopy holds is not even named outside that refusal).
  const hostText = files.find((f) => f.file === host).text;
  assert.deepEqual(hostText.match(/request\(\s*'account\/login\/start'[^)]*\)/g), ["request('account/login/start', { type: 'chatgpt' })"]);
  assert.deepEqual(files.filter((f) => f.text.includes('chatgptAuthTokens')).map((f) => f.file), [path.join('src', 'core', 'codex-adapter.mjs')]);
  assert.deepEqual(files.find((f) => f.file === path.join('src', 'core', 'codex-adapter.mjs')).text.match(/[\w/]*chatgptAuthTokens[\w/]*/g), ['account/chatgptAuthTokens/refresh']);
  assert.ok(!files.some((f) => /chatgptDeviceCode|amazonBedrock/.test(f.text)), 'no other kind of sign-in is named either');

  const own = fs.readFileSync(path.join(CORE, 'accounts-codex.mjs'), 'utf8');
  assert.ok(!/\.call\(|\bask\(|request\(/.test(own), 'accounts-codex.mjs makes no app-server call of its own: only what it is handed');
  assert.ok(!/node:fs|child_process|CODEX_HOME/.test(own), 'and touches no file, process or Codex folder');
});

test('a pasted key reaches Codex one way: a variable in its own process. It is never a login, a flag or a file', { skip: missing }, () => {
  const files = appSources();
  const at = (re) => files.filter((f) => re.test(f.text)).map((f) => f.file);
  // The variable is named in one place, the recipe: nothing else sets it, reads it or passes it on.
  assert.deepEqual(at(/CANOPY_OPENAI_API_KEY/), [path.join('src', 'core', 'accounts-codex.mjs')]);
  // Codex's own ways of taking a key would write it into Codex's folder as its login: none is used. Not the
  // sign-in that takes a key (codex-account.test.mjs refuses it at the gate too), and not the `codex login` command.
  assert.deepEqual(at(/with-api-key|login',\s*'--|\['login'/), []);
  assert.deepEqual(at(/type:\s*['"`]apiKey['"`]\s*,\s*apiKey/), []);
  // Nor is a key ever a setting on a command line, where other processes could read it: the settings Canopy
  // writes there name the variable, and no setting of Codex's that holds a secret itself is written anywhere.
  assert.deepEqual(at(/experimental_bearer_token|bearer_token\s*[:=]/), []);
  const recipe = files.find((f) => f.file === path.join('src', 'core', 'accounts-codex.mjs')).text;
  assert.match(recipe, /env_key: KEY_VAR/);
  // The recipe makes no folder of Codex's own for a key and points Codex at none: the user's stays the one in use.
  assert.deepEqual(at(/CODEX_HOME\s*[:=\]]|CODEX_HOME['"`]\]?\s*=/), []);
});

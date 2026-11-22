// codex-host.mjs, the account: which calls about it are ever written to a Codex process, Codex's own browser
// sign-in, cancelling it, signing out, and hearing about the login changing.
// Driven by fake-codex.mjs: no Codex is started, and nobody is signed in or out of anything.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, within } from '../helpers.mjs';
import { ACCOUNT_CALLS, CodexProcess, CodexService, accountCallRefusal } from '../../codex-host.mjs';

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) { try { await within(x.close ? x.close({ graceMs: 0 }) : x.shutdown(0), 4000, 'clean-up'); } catch { /* the test reports its own failures */ } }
});
const rejected = async (promise) => { try { await promise; } catch (err) { return err; } assert.fail('expected a rejection'); };
const until = async (cond, ms = 2000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
const tick = () => new Promise((r) => setImmediate(r));

function service(fake, opts = {}) {
  const s = new CodexService({ codexPath: '/fake/codex', env: { PATH: '/usr/bin', HOME: '/tmp' }, spawnFn: fake.spawnFn, ...opts, timeouts: { init: 1000, request: 1000, list: 1000, history: 1000, ...opts.timeouts } });
  open.push(s);
  const heard = [];
  s.watchAccount((e) => heard.push(e));
  return Object.assign(s, { heard });
}
function proc(fake) {
  const p = new CodexProcess({ codexPath: '/fake/codex', env: { PATH: '/usr/bin' }, cwd: '/tmp', spawnFn: fake.spawnFn, initTimeoutMs: 1000, requestTimeoutMs: 1000 });
  open.push(p);
  return p;
}

// Every call under `account/` that Codex 0.153.4's app-server takes (its own generated schema), besides the five
// Canopy makes: spending a reset credit, mailing a nudge, a cloud provider's set-up, and reads nothing here needs.
const NOT_CANOPYS = [
  'account/rateLimitResetCredit/consume', 'account/sendAddCreditsNudgeEmail', 'account/bedrock/discover', 'account/bedrock/setup',
  'account/usage/read', 'account/workspaceMessages/read',
];
// The kinds of sign-in the app-server takes besides its own browser sign-in. Each would put a login Canopy chose
// into Codex's own folder, or run Codex on a token Canopy holds.
const NOT_A_BROWSER_SIGN_IN = [
  { type: 'apiKey', apiKey: 'sk-test-0000000000000000' },
  { type: 'chatgptAuthTokens', accessToken: 'eyJ.fake.token', chatgptAccountId: 'acct_1' },
  { type: 'chatgptDeviceCode' },
  { type: 'amazonBedrock', apiKey: 'k', region: 'us-east-1' },
  { type: 'amazonBedrockAccessKeys', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1' },
  { type: 'chatgpt', apiKey: 'sk-test-0000000000000000' },   // the right type with something riding along
  { type: 'chatgpt', accessToken: 'eyJ.fake.token' },
  { type: 'ChatGPT' }, { type: ['chatgpt'] }, {}, null, undefined, 'chatgpt', [{ type: 'chatgpt' }],
];

// ---- the list ----

test('the calls about the account that Canopy makes are exactly five', () => {
  assert.deepEqual([...ACCOUNT_CALLS], ['account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read']);
  assert.ok(Object.isFrozen(ACCOUNT_CALLS));
  for (const method of ACCOUNT_CALLS) assert.equal(accountCallRefusal(method, method === 'account/login/start' ? { type: 'chatgpt' } : undefined), null, method);
  for (const method of NOT_CANOPYS) assert.match(accountCallRefusal(method, {}), /does not ask Codex for/, method);
  // A name Codex adds later is refused too, and so is one dressed up to slip past a comparison.
  for (const method of ['account/somethingNew', 'account/', 'account/read/', 'account/logout ', ' account/logout', 'ACCOUNT/LOGOUT', 'Account/Read', 'account/login/start\n']) {
    assert.equal(typeof accountCallRefusal(method, { type: 'chatgpt' }), 'string', JSON.stringify(method));
  }
  // What is not about the account is not this list's business.
  for (const method of ['model/list', 'thread/start', 'accounts/read', 'mcpServer/oauth/login', '', undefined, null, 7]) assert.equal(accountCallRefusal(method, {}), null, String(method));
});

test('a sign-in can only be started as Codex’s own browser sign-in', () => {
  assert.equal(accountCallRefusal('account/login/start', { type: 'chatgpt' }), null);
  for (const params of NOT_A_BROWSER_SIGN_IN) assert.match(accountCallRefusal('account/login/start', params), /only starts Codex’s own browser sign-in/, JSON.stringify(params));
});

// ---- nothing else is ever written ----

test('a call Canopy does not make is refused before it reaches a process: a chat’s, or the helper’s', async () => {
  const fake = createFakeCodex();
  const p = proc(fake).start();
  await p.ready;
  for (const method of NOT_CANOPYS) {
    const err = await rejected(p.request(method, {}));
    assert.deepEqual([err.code, err.method], ['not-allowed', method]);
  }
  for (const params of NOT_A_BROWSER_SIGN_IN) assert.equal((await rejected(p.request('account/login/start', params))).code, 'not-allowed', JSON.stringify(params));
  // Nor does Canopy tell Codex anything about the account in a line of its own.
  for (const method of ['account/logout', 'account/login/start', 'account/sendAddCreditsNudgeEmail']) assert.equal(p.notify(method, { type: 'chatgpt' }), false, method);
  await sleep(20);
  assert.deepEqual(fake.received.map((m) => m.method), ['initialize', 'initialized'], 'nothing but the handshake was written');
  // The five do go out.
  assert.deepEqual(await p.request('account/read', { refreshToken: false }), { account: { type: 'apiKey' }, requiresOpenaiAuth: true });

  // The helper refuses before it even starts a process for the call.
  const quiet = createFakeCodex();
  const s = service(quiet);
  for (const method of NOT_CANOPYS) {
    const r = await s.call(method, {});
    assert.deepEqual([r.ok, r.code], [false, 'not-allowed'], method);
    assert.match(r.message, /does not ask Codex for/);
  }
  assert.equal(quiet.spawns.length, 0);
  assert.equal(s.active, 0);
});

test('signing in and out go through their own methods only, and no other kind of sign-in starts anything', async () => {
  const fake = createFakeCodex({ account: null });
  const s = service(fake);
  // The generic `call` is not a way in: a sign-in started there would not be held or ended by anything.
  for (const [method, params] of [['account/login/start', { type: 'chatgpt' }], ['account/login/cancel', { loginId: 'x' }], ['account/logout', undefined]]) {
    assert.equal((await s.call(method, params)).code, 'not-allowed', method);
  }
  for (const params of NOT_A_BROWSER_SIGN_IN) assert.equal((await s.call('account/login/start', params)).code, 'not-allowed', JSON.stringify(params));
  for (const opts of [{ type: 'apiKey', apiKey: 'sk-test-0000000000000000' }, { type: 'chatgptAuthTokens', accessToken: 'eyJ.fake.token' }, { type: 'chatgptDeviceCode' }, {}, undefined]) {
    const r = await s.login(opts);
    assert.deepEqual([r.ok, r.code], [false, 'not-allowed'], JSON.stringify(opts));
  }
  assert.equal(fake.spawns.length, 0, 'not one process was started');
  assert.equal(s.signIn, null);
  // What `login` writes is the browser sign-in and nothing more, whatever else it is handed.
  const r = await s.login({ type: 'chatgpt', apiKey: 'sk-test-0000000000000000', accessToken: 'eyJ.fake.token' });
  assert.equal(r.ok, true);
  assert.deepEqual(fake.sent('account/login/start').map((m) => m.params), [{ type: 'chatgpt' }]);
  assert.ok(!JSON.stringify(fake.received).includes('sk-test'), 'a key handed to login never reaches Codex');
});

test('a Codex process that asks the helper for a token is told no', async () => {
  // `account/chatgptAuthTokens/refresh` is how Codex asks a client that holds the login for a fresh token.
  // Canopy holds none, so the only answer it can give is a refusal.
  const fake = createFakeCodex();
  const s = service(fake);
  await s.account();
  const { answer } = fake.last.ask('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' });
  const said = await within(answer, 1000, 'the refusal');
  assert.equal(said.error.code, -32601);
  assert.ok(!('result' in said));
});

// ---- signing in ----

test('login starts Codex’s browser sign-in, holds the helper until it ends, and says how it ended', async () => {
  const fake = createFakeCodex({ account: null, loginIds: ['L1'] });
  const s = service(fake, { lingerMs: 30 });
  assert.deepEqual(await s.account(), { ok: true, account: null, signedIn: false, requiresAuth: true });
  const r = await s.login({ type: 'chatgpt' });
  assert.deepEqual(Object.keys(r).sort(), ['authUrl', 'loginId', 'ok']);
  assert.equal(r.loginId, 'L1');
  assert.match(r.authUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.deepEqual(fake.sent('account/login/start')[0].params, { type: 'chatgpt' });
  assert.equal(fake.spawns.length, 1);
  assert.equal(s.active, 1, 'the sign-in holds the process');
  await sleep(120); // four times the linger
  assert.equal(fake.last.exited, null, 'the process answering the browser is not let go for being idle');
  assert.deepEqual(s.heard, []);

  // A second one is not started on top of it.
  const again = await s.login({ type: 'chatgpt' });
  assert.deepEqual([again.ok, again.code], [false, 'busy']);
  assert.equal(fake.sent('account/login/start').length, 1);
  // Nor is anyone signed out while it is open.
  assert.equal((await s.logout()).code, 'busy');
  assert.equal(fake.sent('account/logout').length, 0);

  fake.last.finishLogin({ account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' } });
  await until(() => s.heard.length === 2, 1000, 'both lines about the login');
  assert.deepEqual(s.heard.find((e) => e.type === 'login'), { type: 'login', loginId: 'L1', success: true, error: null });
  assert.deepEqual(s.heard.find((e) => e.type === 'updated'), { type: 'updated', authMode: 'chatgpt' });
  assert.equal(s.signIn, null);
  assert.equal(s.active, 0);
  assert.deepEqual(await s.account(), { ok: true, account: { type: 'chatgpt', email: 'me@example.com', plan: 'pro' }, signedIn: true, requiresAuth: true });
  await until(() => fake.children[0].exited, 1000, 'the helper to go once nothing holds it');
  // And the next sign-in is a new one.
  fake.account = null;
  assert.equal((await s.login({ type: 'chatgpt' })).ok, true);
});

test('a sign-in Codex turns down, and one that ends as its start is answered', async () => {
  const fake = createFakeCodex({ account: null, loginIds: ['L1', 'L2'] });
  const s = service(fake);
  await s.login({ type: 'chatgpt' });
  fake.last.finishLogin({ success: false, error: 'access_denied' });
  await until(() => s.heard.length === 1);
  assert.deepEqual(s.heard, [{ type: 'login', loginId: 'L1', success: false, error: 'access_denied' }]);
  assert.equal((await s.account()).signedIn, false);

  // Both lines in one read of the pipe: the caller still has its answer before anyone hears the end.
  fake.loginEnds = { success: true };
  s.heard.length = 0;
  const order = [];
  s.watchAccount((e) => { if (e.type === 'login') order.push(`heard ${e.loginId}`); });
  const r = await s.login({ type: 'chatgpt' });
  order.push(`answered ${r.loginId}`);
  await until(() => order.length === 2);
  assert.deepEqual(order, ['answered L2', 'heard L2']);
  assert.equal(s.signIn, null);
  assert.equal(s.active, 0);
  // A line about some other sign-in ends nothing.
  fake.loginEnds = null;
  fake.account = null;
  const third = await s.login({ type: 'chatgpt' });
  fake.last.note('account/login/completed', { loginId: 'not-this-one', success: true, error: null });
  fake.last.note('account/login/completed', { loginId: null, success: true, error: null });
  await sleep(30);
  assert.equal(s.signIn?.loginId, third.loginId, 'still waiting for its own');
});

test('a start Codex answers with no sign-in to open is a failure, and its process goes', async () => {
  for (const answer of [{ type: 'chatgpt', loginId: 'L1' }, { type: 'chatgpt', authUrl: 'https://auth.openai.com/x' }, { type: 'apiKey' }, {}]) {
    const fake = createFakeCodex({ account: null, handlers: { 'account/login/start': () => answer } });
    const s = service(fake);
    const r = await s.login({ type: 'chatgpt' });
    assert.deepEqual([r.ok, r.code], [false, 'rejected'], JSON.stringify(answer));
    assert.equal(s.signIn, null);
    assert.equal(s.active, 0);
    await until(() => fake.children[0].exited, 1000, 'the process that may hold a sign-in nobody can name');
  }
  // Codex says no outright: reported, and nothing is held.
  const fake = createFakeCodex({ account: null, errors: { 'account/login/start': { code: -32600, message: 'login server could not start at https://auth.openai.com/oauth/authorize?state=SECRET-STATE' } } });
  const s = service(fake);
  const r = await s.login({ type: 'chatgpt' });
  assert.deepEqual([r.ok, r.code], [false, 'rejected']);
  assert.ok(!r.message.includes('SECRET-STATE'), 'an address in an error is shown without what follows its ?');
  assert.match(r.message, /auth\.openai\.com\/oauth\/authorize\?…/);
  assert.equal(s.active, 0);
});

// ---- cancelling, and the other ways a sign-in ends ----

test('cancelLogin tells Codex to drop the sign-in and stops waiting', async () => {
  const fake = createFakeCodex({ account: null, loginIds: ['L1', 'L2'] });
  const s = service(fake);
  assert.deepEqual(await s.cancelLogin(), { ok: true, status: 'notFound' }, 'nothing to cancel');
  assert.equal(fake.spawns.length, 0, 'and no process is started to say so');
  await s.login({ type: 'chatgpt' });
  assert.deepEqual(await s.cancelLogin('some-other-id'), { ok: true, status: 'notFound' });
  assert.equal(fake.sent('account/login/cancel').length, 0);
  assert.deepEqual(await s.cancelLogin('L1'), { ok: true, status: 'canceled' });
  assert.deepEqual(fake.sent('account/login/cancel').map((m) => m.params), [{ loginId: 'L1' }]);
  assert.equal(s.signIn, null);
  assert.equal(s.active, 0);
  await tick(); await tick();
  assert.deepEqual(s.heard, [{ type: 'login', loginId: 'L1', success: false, error: null, cancelled: true }], 'heard once, as cancelled');
  assert.equal((await s.account()).signedIn, false);
  // Without an id it is the one in flight.
  await s.login({ type: 'chatgpt' });
  assert.deepEqual(await s.cancelLogin(), { ok: true, status: 'canceled' });
  assert.deepEqual(fake.sent('account/login/cancel').at(-1).params, { loginId: 'L2' });
});

test('cancelled while it was starting: stopped as soon as Codex has named it', async () => {
  const fake = createFakeCodex({ account: null, hang: ['account/login/start'] });
  const s = service(fake);
  const starting = s.login({ type: 'chatgpt' });
  await until(() => fake.sent('account/login/start').length === 1);
  assert.deepEqual(await s.cancelLogin(), { ok: true, status: 'canceled' });
  assert.equal(fake.sent('account/login/cancel').length, 0, 'there is no id to cancel by yet');
  // Now Codex answers the start.
  fake.last.login = 'L9';
  fake.last.send({ id: fake.sent('account/login/start')[0].id, result: { type: 'chatgpt', loginId: 'L9', authUrl: 'https://auth.openai.com/oauth/authorize?state=S' } });
  const r = await starting;
  assert.deepEqual([r.ok, r.code], [false, 'cancelled']);
  assert.ok(!('authUrl' in r), 'the page is never handed out for a sign-in that was called off');
  assert.deepEqual(fake.sent('account/login/cancel').map((m) => m.params), [{ loginId: 'L9' }]);
  assert.equal(s.signIn, null);
  assert.equal(s.active, 0);
});

test('a Codex that will not drop a sign-in loses its process, so the page cannot sign anyone in later', async () => {
  const fake = createFakeCodex({ account: null, hang: ['account/login/cancel'] });
  const s = service(fake, { timeouts: { cancel: 40 } });
  await s.login({ type: 'chatgpt' });
  const child = fake.last;
  assert.deepEqual(await s.cancelLogin(), { ok: true, status: 'notFound' });
  await until(() => child.exited, 1000, 'the process holding the sign-in');
  assert.equal(s.signIn, null);
  await until(() => s.heard.length === 1);
  assert.equal(s.heard[0].cancelled, true);
  fake.hang.clear();
  assert.equal((await s.account()).ok, true, 'the helper comes back for the next call');
  assert.equal(fake.spawns.length, 2);
});

test('a sign-in left open too long is dropped', async () => {
  const fake = createFakeCodex({ account: null, loginIds: ['L1'] });
  const s = service(fake, { timeouts: { login: 60 } });
  await s.login({ type: 'chatgpt' });
  await until(() => s.heard.length === 1, 1000, 'the end of the wait');
  assert.deepEqual(s.heard, [{ type: 'login', loginId: 'L1', success: false, error: null, timedOut: true }]);
  assert.deepEqual(fake.sent('account/login/cancel').map((m) => m.params), [{ loginId: 'L1' }]);
  assert.equal(s.signIn, null);
  assert.equal(s.active, 0);
});

test('the helper’s process dying, or the helper closing, ends the sign-in too', async () => {
  const fake = createFakeCodex({ account: null, loginIds: ['L1', 'L2'] });
  const s = service(fake);
  await s.login({ type: 'chatgpt' });
  fake.last.die(1);
  await until(() => s.heard.length === 1, 1000, 'word that it stopped');
  assert.deepEqual(s.heard, [{ type: 'login', loginId: 'L1', success: false, error: null, stopped: true }]);
  assert.equal(s.active, 0);
  assert.equal((await s.login({ type: 'chatgpt' })).loginId, 'L2', 'and a new one can be started');
  assert.equal(fake.spawns.length, 2);
  await s.close({ graceMs: 0 });
  await until(() => s.heard.length === 2, 1000, 'word that it stopped');
  assert.equal(s.heard[1].stopped, true);
  assert.equal(s.signIn, null);
  assert.equal(fake.alive().length, 0);
  // It died while the start was still unanswered: the caller hears it, and nothing is left held.
  const hung = createFakeCodex({ account: null, hang: ['account/login/start'] });
  const t = service(hung);
  const starting = t.login({ type: 'chatgpt' });
  await until(() => hung.sent('account/login/start').length === 1);
  hung.last.die(1);
  assert.deepEqual([(await starting).ok, t.signIn, t.active], [false, null, 0]);
});

// ---- signing out, and the login changing ----

test('logout signs Codex out, written as Codex documents it, and the change is heard', async () => {
  const fake = createFakeCodex({ account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' } });
  const s = service(fake);
  assert.equal((await s.account()).signedIn, true);
  await s.models();
  assert.ok(s.modelCache);
  assert.deepEqual(await s.logout(), { ok: true });
  const sent = fake.sent('account/logout');
  assert.equal(sent.length, 1);
  assert.ok(!('params' in sent[0]), 'no params');
  await until(() => s.heard.length === 1);
  assert.deepEqual(s.heard, [{ type: 'updated', authMode: null }]);
  assert.equal(s.modelCache, null, 'the models are asked for again: another login can be offered others');
  assert.deepEqual(await s.account(), { ok: true, account: null, signedIn: false, requiresAuth: true });
  // Codex saying no is reported, never thrown.
  fake.errors['account/logout'] = { code: -32603, message: 'could not remove the login' };
  assert.deepEqual(await s.logout(), { ok: false, code: 'rejected', message: 'could not remove the login' });
});

test('watchAccount: every listener hears, one that throws is ignored, and it can stop listening', async () => {
  const fake = createFakeCodex();
  const s = service(fake);
  const other = [];
  s.watchAccount(() => { throw new Error('a listener bug'); });
  const stop = s.watchAccount((e) => other.push(e));
  assert.equal(typeof s.watchAccount('not a function'), 'function');
  await s.account();
  fake.last.note('account/updated', { authMode: 'apikey', planType: null });
  fake.last.note('account/updated', { authMode: null });
  fake.last.note('account/updated', {});
  fake.last.note('account/rateLimits/updated', { rateLimits: {} });
  await until(() => s.heard.length === 3);
  assert.deepEqual(s.heard, [{ type: 'updated', authMode: 'apikey' }, { type: 'updated', authMode: null }, { type: 'updated', authMode: null }]);
  assert.deepEqual(other, s.heard);
  stop();
  fake.last.note('account/updated', { authMode: 'chatgpt' });
  await until(() => s.heard.length === 4);
  assert.equal(other.length, 3);
  // A line that a sign-in ended, with none open, is nobody's.
  fake.last.note('account/login/completed', { loginId: 'L0', success: true, error: null });
  await sleep(20);
  assert.equal(s.heard.length, 4);
});

test('loginWorks: yes only when a call that needs the login went through', async () => {
  const fake = createFakeCodex({ handlers: { 'account/rateLimits/read': () => ({ rateLimits: { primary: { usedPercent: 12 } } }) } });
  const s = service(fake);
  assert.deepEqual(await s.loginWorks(), { ok: true }, 'the answer itself is not kept or handed on');
  const sent = fake.sent('account/rateLimits/read');
  assert.ok(sent.length === 1 && !('params' in sent[0]));
  fake.handlers = {};
  fake.errors['account/rateLimits/read'] = { code: -32600, message: 'chatgpt authentication required to read rate limits' };
  assert.equal((await s.loginWorks()).ok, false);
  fake.errors = {};
  fake.hang.add('account/rateLimits/read');
  const slow = service(fake, { timeouts: { request: 40 } });
  assert.equal((await slow.loginWorks()).code, 'timeout');
});

// ---- what is logged ----

test('the address of the sign-in page is in no log line, even when Codex prints it', async () => {
  const lines = [];
  const fake = createFakeCodex({ account: null, loginIds: ['L1'], hang: ['thread/list'] });
  const s = service(fake, { timeouts: { list: 40 }, log: (level, msg, data) => lines.push(JSON.stringify([level, msg, data])) });
  const r = await s.login({ type: 'chatgpt' });
  assert.match(r.authUrl, /state=STATE-L1/);
  // Codex's own sign-in prints the address for a terminal user. Canopy keeps the tail of stderr for failed calls.
  fake.last.stderr.write(`If your browser did not open, navigate to this URL to authenticate:\n${r.authUrl}\n`);
  await sleep(20);
  assert.equal((await s.listThreads()).code, 'timeout'); // a failed call is what logs the tail
  await s.cancelLogin();
  await tick();
  const log = lines.join('\n');
  assert.ok(lines.length > 0 && log.includes('auth.openai.com/oauth/authorize?…'), 'the tail was logged, cut at the ?');
  for (const secret of ['STATE-L1', 'CHALLENGE-L1', 'code_challenge', 'redirect_uri', 'client_id']) assert.ok(!log.includes(secret), `${secret} reached the log`);
});

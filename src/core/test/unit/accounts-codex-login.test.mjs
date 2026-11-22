// accounts-codex-login.mjs: signing in to Codex from Canopy, signing out, and noticing a login that went bad.
// The real pieces are wired the way main wires them: the registry (accounts.mjs), its Codex half
// (accounts-codex.mjs), the shared helper (CodexService) and this flow. Underneath is fake-codex.mjs: no Codex is
// started, no browser is opened, and nobody is signed in or out of anything.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, within } from '../helpers.mjs';
import { Accounts } from '../../accounts.mjs';
import { codexAccounts } from '../../accounts-codex.mjs';
import { CodexSignIn, PHASES, goodReply, refusedTurn, signInAddress } from '../../accounts-codex-login.mjs';
import { CodexService } from '../../codex-host.mjs';

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) { try { await within(x.close({ graceMs: 0 }), 4000, 'clean-up'); } catch { /* the test reports its own failures */ } }
});
const until = async (cond, ms = 2000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

const PLUS = { type: 'chatgpt', email: 'me@example.com', planType: 'plus' };
const BASE = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/Users/someone' });
const REFUSED = { kind: 'notice', level: 'warn', code: 'api-error', apiError: 'unauthorized', errorCode: 'auth', apiStatus: null, text: 'Codex could not sign in to OpenAI. Check your Codex login.' };
const REPLIED = { kind: 'turn-end', subtype: 'success', isError: false, interrupted: false, errorCode: null };

// Everything main builds for Codex's login, over a fake Codex. `account`: who Codex starts out signed in as.
function rig({ account = null, timeouts, ...script } = {}) {
  // The plan's limits cannot be read unless a test answers that call itself: reading them is how Canopy tells a login
  // that still works from one OpenAI no longer takes, and these tests are about the second kind.
  const fake = createFakeCodex({ account, rateLimits: null, ...script });
  const logs = [];
  const service = new CodexService({
    codexPath: '/fake/codex', env: BASE, spawnFn: fake.spawnFn, timeouts: { init: 1000, request: 1000, list: 1000, history: 1000, ...timeouts },
    log: (level, msg, data) => logs.push(`helper ${level}: ${msg} ${JSON.stringify(data ?? null)}`),
  });
  open.push(service);
  const world = { installed: true, opens: true };
  const engine = codexAccounts({ account: () => service.account(), installed: () => world.installed, env: () => BASE, works: () => service.loginWorks() });
  const claude = { ids: [], base: () => ({ PATH: '/usr/bin' }), detect: async () => ({ known: true, accounts: [] }), launchEnv: (a, base) => ({ ...base }), asFound: () => null, label: () => 'x', agrees: () => null };
  const saved = {};
  const registry = new Accounts({ engines: { claude, codex: engine }, load: () => saved.accounts ?? null, save: (s) => { saved.accounts = s; }, log: (m) => logs.push(`accounts: ${m}`) });
  const opened = [], views = [];
  let logins = 0;
  const signIn = new CodexSignIn({
    service, engine, registry, installed: () => world.installed,
    open: async (url) => { opened.push(url); if (world.opens instanceof Error) throw world.opens; return world.opens; },
    onChange: (view) => views.push(view), onLogin: () => { logins += 1; },
    log: (m) => logs.push(`sign-in flow: ${m}`), timings: { verifyTries: 2, verifyEvery: 10, settle: 1000 },
  });
  const row = () => registry.view().list.find((a) => a.engine === 'codex') ?? null;
  const phase = (p, label = p) => until(() => signIn.phase === p, 2000, `the sheet to say ${label}`);
  // Everything that leaves the main process or is written down: what the window is sent, and the log.
  const said = () => JSON.stringify([views, registry.view()]) + logs.join('\n');
  return { fake, service, engine, registry, signIn, world, opened, views, logs, saved, row, phase, said, logins: () => logins };
}
const sent = (fake, method) => fake.sent(method).length;

// ---- the address ----

test('only a plain https address is ever opened', () => {
  const real = 'https://auth.openai.com/oauth/authorize?response_type=code&state=abc';
  assert.equal(signInAddress(real), real);
  for (const bad of [
    'http://auth.openai.com/oauth/authorize', 'file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:com.apple.preference', 'vscode://file/etc/passwd',
    'https://user:pass@auth.openai.com/', 'https://', 'auth.openai.com/oauth', '', ' ', null, undefined, 7, {}, `https://auth.openai.com/${'a'.repeat(9000)}`,
  ]) assert.equal(signInAddress(bad), null, String(bad).slice(0, 60));
  assert.deepEqual([...PHASES], ['idle', 'starting', 'waiting', 'checking', 'done', 'failed']);
});

// ---- signing in ----

test('signed out: Codex’s own sign-in opens in the browser, and it counts once Codex says who is signed in', async () => {
  const r = rig({ account: null, loginIds: ['L1'] });
  await r.registry.refresh();
  assert.equal(r.row(), null, 'never signed in: nothing in the list to fix');
  assert.deepEqual(r.signIn.view(), { phase: 'idle', message: null, detail: null, installed: true, signedIn: false, canSignIn: true, signingOut: false });

  const started = await r.signIn.start();
  assert.deepEqual([started.ok, started.phase, started.canSignIn], [true, 'waiting', false]);
  assert.deepEqual(r.fake.sent('account/login/start').map((m) => m.params), [{ type: 'chatgpt' }]);
  assert.equal(r.opened.length, 1);
  assert.match(r.opened[0], /^https:\/\/auth\.openai\.com\/oauth\/authorize\?.*state=STATE-L1/, 'the browser gets the whole address');
  // A second click shows the sheet that is already up.
  assert.deepEqual([(await r.signIn.start()).phase, sent(r.fake, 'account/login/start'), r.opened.length], ['waiting', 1, 1]);

  const reads = sent(r.fake, 'account/read');
  r.fake.last.finishLogin({ account: PLUS });
  await r.phase('done');
  assert.ok(sent(r.fake, 'account/read') > reads, 'Codex was asked who is signed in before the sheet said so');
  assert.ok(r.views.some((v) => v.phase === 'checking'));
  assert.deepEqual([r.row().state, r.row().kind, r.row().label, r.row().email], ['ok', 'plan', 'ChatGPT Plus', 'me@example.com']);
  assert.deepEqual(r.signIn.view(), { phase: 'done', message: null, detail: null, installed: true, signedIn: true, canSignIn: false, signingOut: false });
  assert.equal(r.logins(), 1, 'main hears once that the login changed');
  assert.equal(sent(r.fake, 'account/login/cancel'), 0, 'a sign-in that ended by itself is not cancelled');
  assert.equal(r.service.signIn, null);
  assert.equal((await r.signIn.dismiss()).phase, 'idle');
  assert.equal(sent(r.fake, 'account/logout'), 0);

  // The page's address went to the browser and nowhere else: not to the window, not to the registry, not to a log.
  const said = r.said();
  for (const part of ['STATE-L1', 'CHALLENGE-L1', 'code_challenge', 'oauth/authorize', 'https://']) assert.ok(!said.includes(part), `${part} left the main process`);
  assert.ok(!r.logs.join('\n').includes('me@example.com'), 'the log never names who signed in');
});

test('nothing is started while Codex holds a login that works', async () => {
  for (const account of [PLUS, { type: 'apiKey' }]) {
    const r = rig({ account });
    await r.registry.refresh();
    assert.deepEqual([r.signIn.view().signedIn, r.signIn.view().canSignIn], [true, false]);
    const res = await r.signIn.start(); // the window does not offer it; a call that arrives anyway
    assert.deepEqual([res.ok, res.code, res.phase], [true, 'signed-in', 'done'], 'the sheet says what is true: signed in');
    assert.equal(sent(r.fake, 'account/login/start'), 0);
    assert.deepEqual(r.opened, []);
    assert.equal(r.row().state, 'ok');
    assert.equal(r.logins(), 0);
  }
  // The list still said "signed out" (the user signed in from the terminal a moment ago): Codex is asked, not the list.
  const r = rig({ account: null });
  await r.registry.refresh();
  assert.equal(r.signIn.view().canSignIn, true);
  r.fake.account = PLUS;
  const res = await r.signIn.start();
  assert.deepEqual([res.code, res.phase, sent(r.fake, 'account/login/start'), r.opened.length], ['signed-in', 'done', 0, 0]);
  assert.equal(r.row().state, 'ok', 'and the list catches up');
});

test('nothing is started when Codex needs no OpenAI sign-in, cannot say, or is not on this Mac', async () => {
  const own = rig({ account: null, requiresAuth: false }); // a provider of the user's own
  await own.registry.refresh();
  assert.deepEqual([own.signIn.view().signedIn, own.signIn.view().canSignIn], [true, false]);
  const a = await own.signIn.start();
  assert.deepEqual([a.ok, a.code, a.phase], [false, 'not-needed', 'failed']);
  assert.match(a.message, /provider of its own/);

  const mute = rig({ account: null, hang: ['account/read'], timeouts: { request: 40 } });
  const b = await mute.signIn.start();
  assert.deepEqual([b.ok, b.code, b.phase, b.message], [false, 'no-answer', 'failed', 'Codex did not answer. Try again in a moment.']);
  assert.equal(mute.signIn.dismiss().phase, 'idle');

  const none = rig({ account: null });
  none.world.installed = false;
  const c = await none.signIn.start();
  assert.deepEqual([c.ok, c.code, c.phase, c.installed, c.canSignIn], [false, 'not-installed', 'idle', false, false]);
  assert.equal(none.fake.spawns.length, 0, 'no Codex: no helper is started');

  for (const r of [own, mute, none]) assert.deepEqual([sent(r.fake, 'account/login/start'), r.opened.length], [0, 0]);
});

test('Codex saying a sign-in worked is not enough: it has to say who is signed in', async () => {
  const r = rig({ account: null });
  await r.signIn.start();
  r.fake.last.finishLogin();
  r.fake.account = null; // and yet nobody is signed in
  await r.phase('failed');
  assert.deepEqual([r.signIn.view().message, r.signIn.view().signedIn, r.row()], ['Codex did not finish signing in. Try again.', false, null]);
  assert.equal(r.logins(), 0);
  // Trying again is a new sign-in.
  assert.equal((await r.signIn.start()).phase, 'waiting');
  assert.equal(sent(r.fake, 'account/login/start'), 2);
});

test('cancel: Codex is told to drop the sign-in, the sheet goes, and a late answer does not bring it back', async () => {
  const r = rig({ account: null, loginIds: ['L1', 'L2'] });
  await r.signIn.start();
  const res = await r.signIn.cancel();
  assert.deepEqual([res.ok, res.phase, res.canSignIn], [true, 'idle', true]);
  assert.deepEqual(r.fake.sent('account/login/cancel').map((m) => m.params), [{ loginId: 'L1' }]);
  assert.equal(r.service.signIn, null);
  await sleep(30);
  assert.equal(r.signIn.phase, 'idle', 'the word that it was dropped is not shown as a failure');
  assert.equal((await r.signIn.cancel()).phase, 'idle', 'cancelling nothing is fine');
  assert.equal(sent(r.fake, 'account/login/cancel'), 1);

  // Cancelled while Codex was still starting it: dropped as soon as Codex has named it, and the browser never opens.
  r.fake.hang.add('account/login/start');
  const starting = r.signIn.start();
  await until(() => sent(r.fake, 'account/login/start') === 2);
  assert.equal(r.signIn.phase, 'starting');
  assert.equal((await r.signIn.cancel()).phase, 'idle');
  r.fake.last.login = 'L2';
  r.fake.last.send({ id: r.fake.sent('account/login/start')[1].id, result: { type: 'chatgpt', loginId: 'L2', authUrl: 'https://auth.openai.com/oauth/authorize?state=S' } });
  const late = await starting;
  assert.deepEqual([late.ok, late.code, late.phase], [false, 'cancelled', 'idle']);
  assert.deepEqual(r.fake.sent('account/login/cancel').at(-1).params, { loginId: 'L2' });
  assert.equal(r.opened.length, 1, 'only the first sign-in ever reached the browser');
  assert.equal(r.service.signIn, null);
  assert.equal(sent(r.fake, 'account/logout'), 0);
});

test('a sign-in that does not finish: Codex’s refusal, a page left open, a helper that stopped', async () => {
  const no = rig({ account: null });
  await no.signIn.start();
  no.fake.last.finishLogin({ success: false, error: 'access_denied at https://auth.openai.com/oauth/authorize?state=STATE-SECRET\n  try again' });
  await no.phase('failed');
  assert.deepEqual([no.signIn.view().message, no.signIn.view().detail], ['The sign-in was not finished.', 'access_denied at https://auth.openai.com/oauth/authorize?… try again']);
  assert.ok(!no.said().includes('STATE-SECRET'));
  assert.equal(no.signIn.view().canSignIn, true, 'and it can be tried again');

  const slow = rig({ account: null, timeouts: { login: 60 } });
  await slow.signIn.start();
  await slow.phase('failed', 'that it stopped waiting');
  assert.match(slow.signIn.view().message, /open for a long time/);
  assert.equal(sent(slow.fake, 'account/login/cancel'), 1, 'Codex was told to drop it');

  const dead = rig({ account: null });
  await dead.signIn.start();
  dead.fake.last.die(1);
  await dead.phase('failed');
  assert.equal(dead.signIn.view().message, 'Codex stopped before the sign-in was finished.');

  // Codex could not start one at all.
  const off = rig({ account: null, errors: { 'account/login/start': { code: -32603, message: 'could not bind the login server' } } });
  const res = await off.signIn.start();
  assert.deepEqual([res.ok, res.code, res.phase, res.message], [false, 'rejected', 'failed', 'Codex could not start its sign-in. Try again in a moment.']);
  for (const r of [no, slow, dead, off]) assert.deepEqual([r.row(), r.logins(), r.service.signIn], [null, 0, null]);
});

test('a browser that will not open, or an address Canopy does not open: the sign-in is dropped, not left waiting', async () => {
  for (const opens of [false, new Error('no handler for https')]) {
    const r = rig({ account: null, loginIds: ['L1'] });
    r.world.opens = opens;
    const res = await r.signIn.start();
    assert.deepEqual([res.ok, res.code, res.phase, res.message], [false, 'no-browser', 'failed', 'Canopy could not open your browser.']);
    assert.deepEqual(r.fake.sent('account/login/cancel').map((m) => m.params), [{ loginId: 'L1' }]);
    assert.equal(r.service.signIn, null);
    await sleep(20);
    assert.equal(r.signIn.view().message, 'Canopy could not open your browser.', 'its own cancel is not reported over it');
  }
  for (const authUrl of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'http://auth.openai.com/oauth/authorize?state=x', 'not an address']) {
    const r = rig({ account: null, authUrl });
    const res = await r.signIn.start();
    assert.deepEqual([res.ok, res.code, res.phase], [false, 'bad-address', 'failed'], authUrl);
    assert.deepEqual(r.opened, [], 'nothing was handed to the system');
    assert.equal(sent(r.fake, 'account/login/cancel'), 1);
  }
});

test('reopen opens the same page again, and only while the sheet is waiting for it', async () => {
  const r = rig({ account: null });
  assert.equal((await r.signIn.reopen()).ok, false);
  await r.signIn.start();
  assert.equal((await r.signIn.reopen()).ok, true);
  assert.deepEqual([r.opened.length, r.opened[1]], [2, r.opened[0]]);
  assert.equal(sent(r.fake, 'account/login/start'), 1, 'the same sign-in, not a second one');
  r.fake.last.finishLogin({ account: PLUS });
  await r.phase('done');
  assert.equal((await r.signIn.reopen()).ok, false, 'the address is not kept once the sign-in is over');
  assert.equal(r.signIn.url, null);
  assert.equal(r.opened.length, 2);
});

// ---- a login that went bad ----

test('a chat OpenAI refused: Codex is asked, and the login it still holds is listed as needing a sign-in', async () => {
  const r = rig({ account: PLUS });
  await r.registry.refresh();
  assert.deepEqual([r.row().state, r.signIn.view().signedIn], ['ok', true]);
  const reads = sent(r.fake, 'account/read');
  r.signIn.chatEvent(REFUSED);
  await until(() => r.row().state === 'expired', 2000, 'the account to be marked');
  assert.ok(sent(r.fake, 'account/read') > reads, 'on Codex’s answer, not on the chat’s error alone');
  assert.equal(sent(r.fake, 'account/rateLimits/read'), 1, 'and only after its limits could not be read either');
  await until(() => r.views.at(-1)?.canSignIn === true, 1000, 'the window to hear');
  assert.deepEqual(r.signIn.view(), { phase: 'idle', message: null, detail: null, installed: true, signedIn: false, canSignIn: true, signingOut: false });
  assert.deepEqual(r.signIn.describe({ installed: true, signedIn: true, method: 'chatgpt', version: '0.153.4' }), { installed: true, signedIn: false, method: null, version: '0.153.4' }, 'Settings > Models reads the same thing');
  assert.deepEqual([r.row().label, r.row().email], ['ChatGPT Plus', 'me@example.com']);
  // Reopening Settings asks Codex again. It still answers "signed in", and the account still needs a sign-in.
  await r.registry.refresh();
  assert.equal(r.row().state, 'expired');
  assert.equal(r.saved.accounts.list.find((a) => a.engine === 'codex').state, 'expired', 'saved like any other state');
  // A reply comes back: the login works after all.
  r.signIn.chatEvent(REPLIED);
  await until(() => r.row().state === 'ok', 2000, 'the mark to clear');
  assert.equal(r.signIn.view().canSignIn, false);
  // With nothing in doubt, a reply asks Codex nothing.
  const quiet = sent(r.fake, 'account/read');
  for (let i = 0; i < 5; i++) r.signIn.chatEvent(REPLIED);
  await sleep(30);
  assert.equal(sent(r.fake, 'account/read'), quiet);
  // Refused again a moment later, and a reply again: each reply settles the refusal it follows.
  r.signIn.chatEvent(REFUSED);
  await until(() => r.row().state === 'expired', 2000, 'the account to be marked again');
  r.signIn.chatEvent(REPLIED);
  await until(() => r.row().state === 'ok', 2000, 'the mark to clear again');
  assert.deepEqual([sent(r.fake, 'account/login/start'), sent(r.fake, 'account/logout'), r.opened.length], [0, 0, 0], 'noticing never signs anyone in or out');
});

test('what counts as a refusal, and what does not', async () => {
  const marks = async (ev) => {
    const r = rig({ account: PLUS });
    await r.registry.refresh();
    r.signIn.chatEvent(ev);
    await sleep(40);
    await r.registry.refresh();
    return r.row().state;
  };
  assert.equal(await marks(REFUSED), 'expired');
  assert.equal(await marks({ ...REFUSED, apiError: 'responseStreamConnectionFailed', apiStatus: 401 }), 'expired', 'a plain 401 says the same');
  assert.equal(await marks({ ...REFUSED, apiError: 'httpConnectionFailed', apiStatus: 403 }), 'ok', 'a 403 can be a policy or a region, not the login');
  assert.equal(await marks({ ...REFUSED, apiError: 'usageLimitExceeded', errorCode: 'rate-limit' }), 'ok');
  assert.equal(await marks({ ...REFUSED, history: true }), 'ok', 'an old chat being reopened is not news');
  assert.equal(await marks({ kind: 'turn-end', isError: true, errorCode: 'auth' }), 'ok', 'the notice is the sign: it says what the error was');
  for (const junk of [null, undefined, 'unauthorized', [], { kind: 'notice' }, { kind: 'notice', code: 'api-error' }]) assert.equal(await marks(junk), 'ok');
});

test('one refused call signs nobody out: a login that can still read its own limits is left alone', async () => {
  const r = rig({ account: PLUS, handlers: { 'account/rateLimits/read': () => ({ rateLimits: { primary: { usedPercent: 3 } } }) } });
  await r.registry.refresh();
  r.signIn.chatEvent(REFUSED);
  await until(() => sent(r.fake, 'account/rateLimits/read') === 1, 2000, 'the check');
  await r.registry.refresh();
  assert.deepEqual([r.row().state, r.signIn.view().signedIn, r.signIn.view().canSignIn], ['ok', true, false]);
  assert.equal(r.engine.known().state, 'ok');
});

test('a refused key no longer works; a refused login that is gone is signed out; not knowing changes nothing', async () => {
  const key = rig({ account: { type: 'apiKey' } });
  await key.registry.refresh();
  key.signIn.chatEvent(REFUSED);
  await until(() => key.row().state === 'invalid-key', 2000, 'the key to be marked');
  assert.equal(sent(key.fake, 'account/rateLimits/read'), 0, 'a key has no limits to read');
  assert.equal(key.signIn.view().canSignIn, true);

  const gone = rig({ account: PLUS });
  await gone.registry.refresh();
  gone.fake.account = null; // signed out in the terminal; then a chat fails
  gone.signIn.chatEvent(REFUSED);
  await until(() => gone.row().state === 'signed-out', 2000, 'the account to be marked');
  assert.equal(gone.signIn.view().canSignIn, true);

  const mute = rig({ account: PLUS });
  await mute.registry.refresh();
  mute.fake.errors['account/read'] = { code: -32603, message: 'not now' };
  const asked = sent(mute.fake, 'account/read');
  mute.signIn.chatEvent(REFUSED);
  await until(() => sent(mute.fake, 'account/read') > asked, 2000, 'Codex to be asked');
  await sleep(40);
  assert.deepEqual([mute.row().state, mute.signIn.view().signedIn], ['ok', true], 'Codex could not say: nobody is called signed out');
});

test('Sign in again: a login OpenAI refused can be replaced, though Codex still answers "signed in"', async () => {
  const r = rig({ account: PLUS, loginIds: ['L1'] });
  await r.registry.refresh();
  r.signIn.chatEvent(REFUSED);
  await until(() => r.row().state === 'expired');
  const res = await r.signIn.start();
  assert.deepEqual([res.ok, res.phase], [true, 'waiting']);
  assert.deepEqual(r.fake.sent('account/login/start').map((m) => m.params), [{ type: 'chatgpt' }]);
  // Codex's login "changing" is not this sign-in finishing: here it answers "signed in" the whole time.
  r.signIn.accountUpdated({ authMode: 'chatgpt' });
  await sleep(40);
  assert.deepEqual([r.signIn.phase, r.row().state], ['waiting', 'expired']);
  r.fake.last.finishLogin({ account: PLUS });
  await r.phase('done');
  assert.deepEqual([r.row().state, r.signIn.view().signedIn, r.engine.known().state, r.logins()], ['ok', true, 'ok', 1]);
  await r.registry.refresh();
  assert.equal(r.row().state, 'ok', 'the old refusal is gone for good');
});

test('Codex says its login changed: the list follows what Codex answers when asked, never the line itself', async () => {
  const r = rig({ account: PLUS });
  await r.registry.refresh();
  // "Nobody is signed in", but Codex still names a login when asked: nothing changes.
  let reads = sent(r.fake, 'account/read');
  r.signIn.accountUpdated({ authMode: null });
  await until(() => sent(r.fake, 'account/read') > reads, 2000, 'Codex to be asked');
  await sleep(20);
  assert.deepEqual([r.row().state, r.signIn.view().signedIn], ['ok', true]);
  // It really is signed out (in the terminal, or in Codex's own app): the account needs a sign-in.
  r.fake.account = null;
  r.signIn.accountUpdated({ authMode: null });
  await until(() => r.row().state === 'signed-out', 2000, 'the account to be marked');
  await until(() => r.views.at(-1)?.canSignIn === true, 1000, 'the window to hear');
  // The helper's own process says the same thing the same way.
  r.fake.account = { type: 'apiKey' };
  r.fake.last.note('account/updated', { authMode: 'apikey', planType: null });
  await until(() => r.row()?.state === 'ok', 2000, 'the account to be fine again');
  assert.equal(r.row().kind, 'key');
  for (const junk of [null, undefined, {}, { authMode: 7 }, 'chatgpt']) r.signIn.accountUpdated(junk);
  await sleep(40);
  assert.equal(r.row().state, 'ok');
  assert.deepEqual([sent(r.fake, 'account/login/start'), sent(r.fake, 'account/logout'), r.opened.length], [0, 0, 0]);
});

test('while the sheet waits, Codex saying it is signed in is enough to go and ask', async () => {
  // The line that a sign-in completed never arrives (or names no sign-in): the login changing is the cue instead.
  const r = rig({ account: null, loginIds: ['L1'] });
  await r.signIn.start();
  r.fake.account = PLUS;
  r.fake.last.note('account/updated', { authMode: 'chatgpt', planType: 'plus' });
  await r.phase('done');
  assert.equal(r.row().state, 'ok');
  await until(() => r.service.signIn === null, 1000, 'the helper to be let go');
  assert.deepEqual(r.fake.sent('account/login/cancel').map((m) => m.params), [{ loginId: 'L1' }], 'the sign-in Codex never closed is closed');
  await sleep(30);
  assert.equal(r.signIn.phase, 'done', 'and its end is not reported as a failure');
});

test('a chat that still replies after a sign-out does not make Canopy ask Codex after every reply', async () => {
  // Signed out (here, on purpose), but a chat opened earlier answers on the login its process has in memory.
  const r = rig({ account: PLUS });
  await r.registry.refresh();
  await r.signIn.signOut();
  const clock = { at: 1_000_000 };
  r.signIn.now = () => clock.at;
  const reads = () => sent(r.fake, 'account/read');
  let before = reads();
  r.signIn.chatEvent(REPLIED);
  await until(() => reads() > before, 2000, 'Codex to be asked once');
  await sleep(30);
  before = reads();
  for (let i = 0; i < 5; i++) r.signIn.chatEvent(REPLIED);
  await sleep(40);
  assert.equal(reads(), before, 'not again within the minute');
  assert.equal(r.row(), null, 'and the account stays gone: it was signed out on purpose');
  clock.at += 61_000;
  r.signIn.chatEvent(REPLIED);
  await until(() => reads() > before, 2000, 'Codex to be asked again after a minute');
});

// ---- signing out ----

test('a chat on a pasted key says nothing about Codex’s login: its refusals and replies put the key in doubt, and only when the list does not already say so', async () => {
  const r = rig({ account: PLUS });
  await r.registry.refresh();
  assert.equal(r.registry.add({ id: 'codex-key-1', engine: 'codex', kind: 'key', keyHint: '7Hq2', state: 'ok' }).ok, true);
  const doubted = [];
  const signIn = new CodexSignIn({ service: r.service, engine: r.engine, registry: r.registry, installed: () => true, keyInDoubt: (id) => { doubted.push(id); }, log: (m) => r.logs.push(m) });
  const asked = sent(r.fake, 'account/read');
  // A plain 401, which is how a refused key arrives (seen on a real app-server), and Codex's own word for a refusal.
  const plain401 = { kind: 'notice', level: 'warn', code: 'api-error', apiError: 'httpConnectionFailed', apiStatus: 401, text: 'Could not reach OpenAI.' };
  for (const ev of [plain401, REFUSED]) signIn.chatEvent(ev, 'codex-key-1');
  await sleep(20);
  assert.deepEqual(doubted, ['codex-key-1', 'codex-key-1'], 'the key is asked about');
  assert.deepEqual([r.engine.known().state, r.row().state, sent(r.fake, 'account/read')], ['ok', 'ok', asked], 'Codex’s login is neither marked nor asked about');
  // A reply on a key listed as working is no news.
  signIn.chatEvent(REPLIED, 'codex-key-1');
  await sleep(20);
  assert.equal(doubted.length, 2);
  // Listed as refused: a further refusal is no news, a reply is.
  r.registry.note('codex-key-1', { state: 'invalid-key' });
  signIn.chatEvent(plain401, 'codex-key-1');
  signIn.chatEvent(REPLIED, 'codex-key-1');
  await sleep(20);
  assert.deepEqual(doubted, ['codex-key-1', 'codex-key-1', 'codex-key-1']);
  // What is not a refusal or a reply, a replayed event, and a host with no way to ask: nothing happens, nothing throws.
  for (const ev of [{ ...plain401, apiStatus: 500 }, { ...plain401, history: true }, { ...REPLIED, isError: true }, { ...REPLIED, interrupted: true }, { ...REPLIED, synthetic: true }, { kind: 'busy' }, null]) signIn.chatEvent(ev, 'codex-key-1');
  new CodexSignIn({ service: r.service, engine: r.engine, registry: r.registry, installed: () => true }).chatEvent(REPLIED, 'codex-key-1');
  new CodexSignIn({ service: r.service, engine: r.engine, registry: r.registry, installed: () => true, keyInDoubt: () => { throw new Error('boom'); } }).chatEvent(REPLIED, 'codex-key-1');
  await sleep(20);
  assert.equal(doubted.length, 3);
  // With no account named, the same event is about Codex's own login, as it always was.
  signIn.chatEvent(REFUSED);
  await until(() => r.row().state === 'expired', 2000, 'Codex’s login to be marked');
  assert.deepEqual([refusedTurn(plain401), refusedTurn(REFUSED), refusedTurn(REPLIED), goodReply(REPLIED), goodReply(plain401), refusedTurn({ ...plain401, history: true }), goodReply(null)], [true, true, false, true, false, false, false]);
});

test('describe: with a pasted key in use the status is the key’s, and Codex’s own otherwise', async () => {
  const r = rig({ account: null });   // Codex has nobody signed in
  await r.registry.refresh();
  assert.deepEqual(r.signIn.describe({ installed: true, signedIn: false, method: null }), { installed: true, signedIn: false, method: null });
  r.registry.add({ id: 'codex-key-1', engine: 'codex', kind: 'key', keyHint: '7Hq2', state: 'ok' });
  assert.deepEqual(r.signIn.describe({ installed: true, signedIn: true, method: 'apiKey' }).signedIn, false, 'a key that is only listed is not what OpenAI’s chats run on');
  r.registry.setActive('codex', 'codex-key-1');
  assert.deepEqual(r.signIn.describe({ installed: true, signedIn: false, method: null, version: '0.169.0' }), { installed: true, signedIn: true, method: 'apiKey', version: '0.169.0' });
  for (const state of ['invalid-key', 'locked', 'blocked']) {
    r.registry.note('codex-key-1', { state, why: 'x' });
    assert.deepEqual(r.signIn.describe({ installed: true }), { installed: true, signedIn: false, method: 'apiKey' }, state);
  }
  r.registry.note('codex-key-1', { state: 'ok' });
  // What the sheet may offer stays about Codex's own login: signed out, so its sign-in is still there to take.
  assert.deepEqual([r.signIn.view().signedIn, r.signIn.view().canSignIn], [false, true]);
  // Without Codex on this Mac there is nothing to run a key on.
  r.world.installed = false;
  assert.deepEqual(r.signIn.describe({ installed: false }), { installed: false });
});

test('signOut signs Codex out, once, and the account leaves the list instead of becoming a problem', async () => {
  const r = rig({ account: PLUS });
  await r.registry.refresh();
  const res = await r.signIn.signOut();
  assert.deepEqual(res, { ok: true });
  assert.equal(sent(r.fake, 'account/logout'), 1);
  assert.equal(r.row(), null);
  assert.deepEqual(r.signIn.view(), { phase: 'idle', message: null, detail: null, installed: true, signedIn: false, canSignIn: true, signingOut: false });
  assert.ok(r.views.some((v) => v.signingOut === true), 'the window can show it is under way');
  assert.equal(r.logins(), 1);
  await r.registry.refresh();
  assert.equal(r.row(), null, 'still nothing to fix after another look');
  // Signing in again from there is an ordinary sign-in.
  await r.signIn.start();
  r.fake.last.finishLogin({ account: PLUS });
  await r.phase('done');
  assert.equal(r.row().state, 'ok');
});

test('signOut does nothing during a sign-in, and says so when Codex will not sign out', async () => {
  const r = rig({ account: null });
  await r.signIn.start();
  const busy = await r.signIn.signOut();
  assert.deepEqual([busy.ok, busy.code], [false, 'busy']);
  assert.equal(sent(r.fake, 'account/logout'), 0);
  await r.signIn.cancel();

  const stuck = rig({ account: PLUS, errors: { 'account/logout': { code: -32603, message: 'could not remove the login' } } });
  await stuck.registry.refresh();
  const res = await stuck.signIn.signOut();
  assert.deepEqual(res, { ok: false, code: 'rejected', message: 'Codex could not be signed out. Try again in a moment.' });
  assert.deepEqual([stuck.row().state, stuck.signIn.view().signingOut, stuck.logins()], ['ok', false, 0]);
  // And two at once is one.
  const twice = rig({ account: PLUS });
  await twice.registry.refresh();
  const [a, b] = await Promise.all([twice.signIn.signOut(), twice.signIn.signOut()]);
  assert.deepEqual([a.ok, b.ok, b.code, sent(twice.fake, 'account/logout')], [true, false, 'busy', 1]);
});

// ---- across a restart, and with pieces missing ----

test('a new run asks Codex afresh: a refusal remembered by the last run is not held against the login', async () => {
  const first = rig({ account: PLUS });
  await first.registry.refresh();
  first.signIn.chatEvent(REFUSED);
  await until(() => first.row().state === 'expired');
  const saved = JSON.parse(JSON.stringify(first.saved.accounts));
  // Canopy restarts: the registry is read back, everything else is new.
  const next = rig({ account: PLUS });
  next.saved.accounts = saved;
  assert.equal(next.row().state, 'expired', 'as saved, until Codex has been asked');
  assert.deepEqual([next.signIn.view().signedIn, next.signIn.view().canSignIn], [null, false], 'and nothing is said or offered on last run’s word');
  await next.registry.refresh();
  assert.deepEqual([next.row().state, next.signIn.view().signedIn], ['ok', true]);
});

test('nothing here throws, whatever it is built from', async () => {
  const bare = new CodexSignIn();
  assert.deepEqual(bare.view(), { phase: 'idle', message: null, detail: null, installed: false, signedIn: null, canSignIn: false, signingOut: false });
  assert.equal((await bare.start()).code, 'not-installed');
  assert.equal((await bare.cancel()).ok, true);
  assert.equal((await bare.reopen()).ok, false);
  assert.equal(bare.dismiss().ok, true);
  assert.equal((await bare.signOut()).ok, false);
  bare.chatEvent(REFUSED); bare.accountUpdated({ authMode: null });
  assert.deepEqual(bare.describe({ installed: true, signedIn: true }), { installed: true, signedIn: true });
  // Observers and helpers that throw.
  const r = rig({ account: null });
  const loud = new CodexSignIn({
    service: r.service, engine: r.engine, registry: r.registry, installed: () => { throw new Error('x'); }, open: () => { throw new Error('x'); },
    onChange: () => { throw new Error('x'); }, onLogin: () => { throw new Error('x'); }, log: () => { throw new Error('x'); }, redact: () => { throw new Error('x'); },
  });
  assert.equal((await loud.start()).code, 'not-installed');
  loud.installedFn = () => true;
  assert.deepEqual([(await loud.start()).code, loud.phase], ['no-browser', 'failed']);
  await sleep(20);
  assert.equal(r.service.signIn, null);
});

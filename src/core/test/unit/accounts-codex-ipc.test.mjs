// accounts-codex-ipc.mjs: signing in to Codex as main.mjs wires it. The registry, the shared helper, a real Codex
// chat (CodexSession) and the model list are the real ones; `handle`, `send` and the browser are stand-ins, and
// Codex is fake-codex.mjs. No Codex is started, no browser opens, nobody is signed in or out of anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, within } from '../helpers.mjs';
import { registerAccounts } from '../../../accounts-ipc.mjs';
import { registerCodexSignIn } from '../../../accounts-codex-ipc.mjs';
import { CodexChats } from '../../../codex-chats.mjs';
import { CodexService } from '../../codex-host.mjs';
import { CodexSession } from '../../codex-session.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-accounts-codex-ipc-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: root });
const PLUS = { type: 'chatgpt', email: 'me@example.com', planType: 'plus' };

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) { try { await within(x.dispose ? x.dispose({ graceMs: 50 }) : x.close({ graceMs: 0 }), 4000, 'clean-up'); } catch { /* the test reports its own failures */ } }
});
const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

// main.mjs, as far as Codex's login goes: the same calls in the same order, over a fake Codex.
function wire({ account = null, ...script } = {}) {
  // The plan's limits cannot be read unless a test answers that call itself: reading them is how Canopy tells a login
  // that still works from one OpenAI no longer takes, and these tests are about the second kind.
  const fake = createFakeCodex({ account, rateLimits: null, ...script });
  const channels = new Map(), sent = [], logs = [], opened = [];
  const handle = (channel, fn) => { assert.ok(!channels.has(channel), `${channel} is registered once`); channels.set(channel, fn); };
  const send = (channel, payload) => sent.push([channel, payload]);
  const state = {};
  const service = new CodexService({ codexPath: '/fake/codex', env: ENV, spawnFn: fake.spawnFn, timeouts: { init: 1000, request: 1000, list: 1000, history: 1000 }, log: (level, msg, data) => logs.push(`codex helper ${level}: ${msg} ${JSON.stringify(data ?? null)}`) });
  open.push(service);
  const codexChats = new CodexChats({ load: () => null, save: () => {}, service, installed: () => true, onModels: () => send('models:changed') });
  const accounts = registerAccounts(handle, {
    claude: () => ({ path: null, env: ENV }), // Claude Code plays no part here
    codex: { installed: () => true, account: () => service.account(), env: () => ENV, works: () => service.loginWorks() },
    load: () => state.accounts ?? null, save: (s) => { state.accounts = s; }, send, log: (m) => logs.push(`accounts: ${m}`),
  });
  const codexSignIn = registerCodexSignIn(handle, {
    accounts, service, installed: () => true,
    open: async (url) => { opened.push(url); },
    onLogin: () => { codexChats.forgetModels(); send('models:changed'); },
    send, log: (m) => logs.push(`accounts: codex ${m}`),
  });
  const call = (channel, ...args) => channels.get(channel)(...args);
  const row = () => accounts.view().list.find((a) => a.engine === 'codex') ?? null;
  // A Codex chat, with its events handed on the way main's ChatHost hands them.
  const chat = () => {
    const work = fs.mkdtempSync(path.join(root, 'work-'));
    const s = new CodexSession({ cwd: work, codexPath: '/fake/codex', env: ENV, spawnFn: fake.spawnFn, timeouts: { restart: 15 }, onAccountUpdated: (info) => codexSignIn.accountUpdated(info) });
    const events = [];
    s.on('event', (ev) => { events.push(ev); codexSignIn.chatEvent(ev); });
    open.push(s);
    return { s, events, child: () => fake.children.find((c) => c.threadId && !c.exited && c.options.cwd === work) };
  };
  const modelsList = async () => { const { openai, codex } = await codexChats.models(); return { openai, codex: codexSignIn.describe({ ...codex, version: '0.153.4', method: codexChats.signInMethod }) }; };
  return { fake, channels, sent, logs, opened, state, service, accounts, codexSignIn, codexChats, call, row, chat, modelsList };
}
const last = (sent, channel) => sent.filter(([c]) => c === channel).at(-1)?.[1];

test('the window gets six calls for Codex’s sign-in beside its two for the list, and one line when the sheet changes', async () => {
  const w = wire();
  assert.deepEqual([...w.channels.keys()].sort(), [
    'accounts:codex', 'accounts:codex-cancel', 'accounts:codex-dismiss', 'accounts:codex-reopen', 'accounts:codex-signin', 'accounts:codex-signout',
    'accounts:list', 'accounts:refresh',
  ]);
  assert.deepEqual(await w.call('accounts:codex'), { phase: 'idle', message: null, detail: null, installed: true, signedIn: null, canSignIn: false, signingOut: false, rev: 0 }, 'before Codex has said anything, nothing is said or offered');
  await w.call('accounts:refresh', true);
  assert.deepEqual([(await w.call('accounts:codex')).signedIn, (await w.call('accounts:codex')).canSignIn], [false, true]);
});

test('every word to the window about the sheet is numbered, so an answer that was overtaken can be told from the newest', async () => {
  const w = wire({ account: null });
  const lines = () => w.sent.filter(([c]) => c === 'accounts:codex').map(([, v]) => v);
  const started = await w.call('accounts:codex-signin');
  assert.ok(lines().length >= 2, 'starting, then waiting');
  assert.deepEqual(lines().map((v) => v.rev), lines().map((_, i) => i + 1), 'each line counts one up');
  assert.equal(started.rev, lines().at(-1).rev, 'an answer carries the count of the last line before it');
  assert.equal((await w.call('accounts:codex')).rev, started.rev, 'asking changes nothing');
  // An answer worked out now and delivered late is older than any line sent in between.
  const asked = await w.call('accounts:codex');
  w.fake.last.finishLogin({ account: PLUS });
  await until(() => lines().at(-1).phase === 'done', 3000, 'the sheet to say it is done');
  assert.ok(asked.rev < lines().at(-1).rev && asked.phase === 'waiting');
  for (const channel of ['accounts:codex-cancel', 'accounts:codex-reopen', 'accounts:codex-dismiss']) assert.equal(typeof (await w.call(channel)).rev, 'number', channel);
});

test('from the window: sign in, and the list, the sheet and the model list all follow', async () => {
  const w = wire({ account: null, loginIds: ['L1'] });
  await w.call('accounts:refresh', true);
  assert.deepEqual((await w.modelsList()), { openai: [], codex: { installed: true, signedIn: false, version: '0.153.4', method: null } });

  const started = await w.call('accounts:codex-signin');
  assert.deepEqual([started.ok, started.phase], [true, 'waiting']);
  assert.equal(last(w.sent, 'accounts:codex').phase, 'waiting');
  assert.equal(w.opened.length, 1);
  assert.equal((await w.call('accounts:codex-reopen')).ok, true);
  assert.deepEqual(w.opened[1], w.opened[0]);

  w.fake.last.finishLogin({ account: PLUS });
  await until(() => last(w.sent, 'accounts:codex').phase === 'done', 3000, 'the sheet to say it is done');
  assert.deepEqual([w.row().state, w.row().label, w.row().email], ['ok', 'ChatGPT Plus', 'me@example.com']);
  assert.deepEqual(last(w.sent, 'accounts:changed').list.map((a) => [a.engine, a.state]), [['codex', 'ok']], 'the list the window has is the new one');
  assert.ok(w.sent.some(([c]) => c === 'models:changed'), 'and it is told to read the models again');
  const models = await w.modelsList();
  assert.deepEqual(models.codex, { installed: true, signedIn: true, version: '0.153.4', method: 'chatgpt' });
  assert.ok(models.openai.length > 0, 'which are there now, without waiting out the five minutes they are kept for');
  assert.equal((await w.call('accounts:codex-dismiss')).phase, 'idle');

  // Nothing the window was sent, nothing saved and nothing logged holds the page's address.
  const out = JSON.stringify([w.sent, w.state, started]) + w.logs.join('\n');
  for (const part of ['STATE-L1', 'CHALLENGE-L1', 'oauth/authorize', 'https://']) assert.ok(!out.includes(part), `${part} left the main process`);
  assert.ok(!w.logs.join('\n').includes('me@example.com'));
  assert.equal(w.fake.sent('account/logout').length, 0);
});

test('from the window: cancel', async () => {
  const w = wire({ account: null, loginIds: ['L1'] });
  await w.call('accounts:codex-signin');
  assert.equal((await w.call('accounts:codex-cancel')).phase, 'idle');
  assert.deepEqual(w.fake.sent('account/login/cancel').map((m) => m.params), [{ loginId: 'L1' }]);
  assert.equal(w.service.signIn, null);
});

test('signing out takes the window’s confirmation: nothing else that reaches the channel signs anyone out', async () => {
  const w = wire({ account: PLUS });
  await w.call('accounts:refresh', true);
  for (const arg of [undefined, null, false, 'true', 1, {}, [true], { confirmed: true }]) {
    const r = await w.call('accounts:codex-signout', arg);
    assert.deepEqual([r.ok, r.code], [false, 'not-confirmed'], JSON.stringify(arg));
  }
  assert.equal(w.fake.sent('account/logout').length, 0);
  assert.equal(w.row().state, 'ok');

  await w.modelsList();
  assert.deepEqual(await w.call('accounts:codex-signout', true), { ok: true });
  assert.equal(w.fake.sent('account/logout').length, 1);
  assert.equal(w.row(), null, 'the account leaves the list');
  assert.deepEqual(last(w.sent, 'accounts:changed').list, []);
  assert.deepEqual([last(w.sent, 'accounts:codex').signedIn, last(w.sent, 'accounts:codex').canSignIn, last(w.sent, 'accounts:codex').signingOut], [false, true, false]);
  assert.deepEqual(await w.modelsList(), { openai: [], codex: { installed: true, signedIn: false, version: '0.153.4', method: null } }, 'and its models leave the picker');
});

test('a real chat OpenAI refuses: the turn’s own events mark the account, and a reply clears it', async () => {
  const w = wire({ account: PLUS, holdTurns: true });
  await w.call('accounts:refresh', true);
  const { s, events, child } = w.chat();
  assert.equal(s.send('hello').ok, true);
  await until(() => child()?.turn, 3000, 'the turn to start');
  // What Codex sends when OpenAI will not take the login, after its own attempt to recover: an error, then the turn failing.
  const error = { message: 'Your access token could not be refreshed. Please sign in again.', codexErrorInfo: 'unauthorized', additionalDetails: null };
  child().note('error', { error, willRetry: false, threadId: child().threadId, turnId: child().turn.id });
  child().completeTurn('failed', { error });
  await until(() => w.row().state === 'expired', 3000, 'the account to be marked');
  assert.ok(events.some((e) => e.kind === 'notice' && e.apiError === 'unauthorized'), 'the chat said so in its own words too');
  assert.deepEqual((await w.modelsList()).codex, { installed: true, signedIn: false, version: '0.153.4', method: null }, 'Settings > Models reads the same thing');
  await until(() => last(w.sent, 'accounts:codex')?.canSignIn === true, 2000, 'the window to hear it may offer a sign-in');

  // The next message is answered: the login works after all.
  w.fake.holdTurns = false;
  assert.equal(s.send('again').ok, true);
  await until(() => w.row().state === 'ok', 3000, 'the mark to clear');
  assert.deepEqual([w.fake.sent('account/login/start').length, w.fake.sent('account/logout').length, w.opened.length], [0, 0, 0]);
});

test('a chat’s process saying Codex’s login is gone: believed once Codex says so when asked', async () => {
  const w = wire({ account: PLUS, holdTurns: true });
  await w.call('accounts:refresh', true);
  const { s, child } = w.chat();
  s.send('hello');
  await until(() => child()?.turn, 3000, 'the turn to start');
  child().note('account/updated', { authMode: null, planType: null }); // but Codex still names a login when asked
  await sleep(60);
  assert.equal(w.row().state, 'ok');
  w.fake.account = null;
  child().note('account/updated', { authMode: null, planType: null });
  await until(() => w.row().state === 'signed-out', 3000, 'the account to be marked');
  child().completeTurn();
});

test('forgetModels: the next read asks Codex again, and an answer asked for before the login changed is dropped', async () => {
  const fake = createFakeCodex({ account: null });
  const service = new CodexService({ codexPath: '/fake/codex', env: ENV, spawnFn: fake.spawnFn, timeouts: { init: 1000, request: 5000, list: 1000, history: 1000 } });
  open.push(service);
  const chats = new CodexChats({ load: () => null, save: () => {}, service, installed: () => true });
  assert.deepEqual(await chats.models(), { openai: [], codex: { installed: true, signedIn: false } });
  fake.account = PLUS;
  assert.deepEqual((await chats.models()).openai, [], 'kept for five minutes, as before');
  chats.forgetModels();
  const fresh = await chats.models();
  assert.ok(fresh.openai.length > 0 && fresh.codex.signedIn === true);

  // An answer on its way while the login changes is the old login's.
  fake.hang.add('account/read');
  chats.forgetModels();
  const slow = chats.models();               // asks, and waits on a read Codex has not answered yet
  await until(() => fake.sent('account/read').length === 3, 2000, 'the read to go out');
  const held = fake.sent('account/read')[2];
  chats.forgetModels();                      // signed out meanwhile
  fake.hang.clear();
  fake.account = null;
  assert.deepEqual(await chats.models(), { openai: [], codex: { installed: true, signedIn: false } }, 'a new ask, for the login as it is now');
  // Now the old read is answered, with the login as it was.
  fake.last.send({ id: held.id, result: { account: PLUS, requiresOpenaiAuth: true } });
  await slow;
  await sleep(20);
  assert.deepEqual(await chats.models(), { openai: [], codex: { installed: true, signedIn: false } }, 'the late answer did not put the old login back');
});

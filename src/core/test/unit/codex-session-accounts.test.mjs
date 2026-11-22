// A Codex chat and the account it runs on: what its process is started with, for Codex's own login and for an
// OpenAI API key pasted into Canopy, and what keeps a chat off any login but its own.
//
// The session is the real one, and so are the registry and the Codex half of it (accounts.mjs, accounts-codex.mjs):
// the launch each chat gets is the one the app would build. Codex is fake-codex.mjs, which treats model providers
// the way a real app-server was seen to (see the top of that file). No Codex is started, every key is made up, and
// nothing under any Codex folder is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { Accounts } from '../../accounts.mjs';
import { KEY_PROVIDER, KEY_VAR, chatAccount, codexAccounts, isPastedKey } from '../../accounts-codex.mjs';
import { CodexSession } from '../../codex-session.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-session-accounts-')));
const home = path.join(root, 'home');
const codexHome = path.join(root, 'codex-home');   // stands for the user's own Codex folder: nothing may appear in it
const work = path.join(root, 'work');
for (const dir of [home, codexHome, work]) fs.mkdirSync(dir, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const KEY = 'sk-proj-NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstuvwxyz-9zQx';
const KEY2 = 'sk-proj-NOT-A-REAL-KEY-zyxwvutsrqponmlkjihgfedcba9876543210-m3Xw';
// What the user's shell hands the app: their own variables, their Codex folder, and one that only looks like Canopy's.
const SHELL = Object.freeze({ PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-shell-own', MY_VAR: 'kept', CANOPY_OPENAI_API_KEY: 'from-the-shell' });
const AS_CODEX_GETS_IT = Object.freeze({ PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-shell-own', MY_VAR: 'kept' });
const PLAIN_ARGS = ['app-server', '--listen', 'stdio://'];
const KEY_ARGS = [...PLAIN_ARGS,
  '-c', 'model_providers.canopy-openai={ name = "OpenAI", base_url = "https://api.openai.com/v1", env_key = "CANOPY_OPENAI_API_KEY", wire_api = "responses", requires_openai_auth = false }',
  '-c', 'model_provider="canopy-openai"'];
const PLAN = { ok: true, signedIn: true, requiresAuth: true, account: { type: 'chatgpt', email: 'me@example.com', plan: 'plus' } };

const open = [];
const fakes = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  assert.equal(fakes.splice(0).flatMap((f) => f.alive()).length, 0, 'every process a session started is gone once it is disposed');
  assert.deepEqual(fs.readdirSync(codexHome), [], 'nothing was written into the Codex folder');
});

// A registry the way main builds one, with the keys held beside it (the vault's part), and Codex's login found.
async function world({ keys = { 'codex-key-1': KEY } } = {}) {
  const held = new Map(Object.entries(keys));
  const saved = [];
  const reg = new Accounts({
    engines: { codex: codexAccounts({ account: async () => PLAN, installed: () => true, env: () => SHELL, checkKey: async () => ({ state: 'unknown' }) }) },
    keyFor: (a) => held.get(a.id) ?? null, save: (state) => { saved.push(JSON.stringify(state)); },
  });
  await reg.refresh();
  for (const id of held.keys()) assert.equal(reg.add({ id, engine: 'codex', kind: 'key', keyHint: held.get(id).slice(-4), state: 'ok' }).ok, true);
  return { reg, held, saved };
}

// A chat as main makes one: on the account in use (or the one a saved chat began on), launched as the registry says.
function chat(W, { resume = null, began = null, script = {}, fake = null, ...opts } = {}) {
  fake ??= createFakeCodex(script);
  if (!fakes.includes(fake)) fakes.push(fake);
  const logs = [];
  const s = new CodexSession({
    cwd: work, codexPath: '/fake/codex', env: () => SHELL, spawnFn: fake.spawnFn, resume,
    account: chatAccount({ saved: !!resume, began, inUse: W.reg.pin('codex'), isKey: (id) => isPastedKey(W.reg.get('codex', id)) }),
    launch: (base) => W.reg.launchFor('codex', { account: s.accountId, base }),
    log: (level, msg, data) => logs.push(JSON.stringify([level, msg, data])),
    ...opts, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
  });
  open.push(s);
  return { s, fake, w: watch(s), logs };
}
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });
const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
// Everything a chat said, shows or logged, and everything that was written to its Codex process.
const everything = ({ s, fake, w, logs }) => JSON.stringify([w.events, s.snapshot(), fake.received, fake.spawns.map((x) => x.args)]) + logs.join('\n');

// ---- nothing chosen ----

test('nothing chosen: a chat’s Codex is started exactly as before there were accounts, argument for argument and variable for variable', async () => {
  // As it was: a session nobody gave an account or a launch.
  const before = createFakeCodex();
  fakes.push(before);
  const old = new CodexSession({ cwd: work, codexPath: '/fake/codex', env: () => SHELL, spawnFn: before.spawnFn });
  open.push(old);
  await old.warm();

  // As it is: through the registry, with nothing chosen. And again with a key added but not chosen.
  const W = await world({ keys: {} });
  const now = chat(W);
  await now.s.warm();
  const K = await world();
  const beside = chat(K);
  await beside.s.warm();

  for (const { fake, s } of [now, beside]) {
    assert.deepEqual(fake.spawns[0], before.spawns[0], 'the whole launch is the same: command, arguments, environment, folder');
    assert.deepEqual([s.accountId, s.provider], [null, null]);
  }
  assert.deepEqual(before.spawns[0].args, PLAIN_ARGS, 'no -c flag at all');
  assert.deepEqual(before.spawns[0].options.env, AS_CODEX_GETS_IT, 'the user’s own environment, without what is the host’s');
  assert.ok(!(KEY_VAR in now.fake.spawns[0].options.env), 'a variable of Canopy’s own name in the shell never reaches Codex');
  // And what is asked of it is the same too.
  assert.deepEqual(now.fake.received, before.received);
  now.s.send('hello');
  await idle(now.w);
  assert.equal(now.w.find('turn-end').text, 'OK');
  assert.equal(now.fake.spawns.length, 1);
});

// ---- on a pasted key ----

test('a chat on a pasted key: the key is in its process’s environment, its provider is on its command line, and the key is nowhere else', async () => {
  const W = await world();
  W.reg.setActive('codex', 'codex-key-1');
  const c = chat(W, { extended: ['send-state'] });
  assert.equal(c.s.accountId, 'codex-key-1');
  c.s.send('hello');
  await idle(c.w);

  const { command, args, options } = c.fake.spawns[0];
  assert.equal(command, '/fake/codex');
  assert.deepEqual(args, KEY_ARGS);
  assert.deepEqual(options.env, { ...AS_CODEX_GETS_IT, [KEY_VAR]: KEY }, 'the same environment, plus the one variable');
  assert.equal(options.env.CODEX_HOME, codexHome, 'Codex’s folder is the user’s own: no other is made for the key');
  assert.ok(!args.join(' ').includes(KEY), 'never on the command line');
  // The chat came up on the key's provider, and ran.
  assert.deepEqual([c.s.provider, c.fake.providerOf[c.s.sessionId]], [KEY_PROVIDER, KEY_PROVIDER]);
  assert.equal(c.w.find('turn-end').text, 'OK');
  assert.deepEqual(c.fake.received.map((m) => m.method), ['initialize', 'initialized', 'model/list', 'account/read', 'config/read', 'skills/extraRoots/set', 'thread/start', 'turn/start']);
  assert.equal(c.s.account, null, 'Codex says nobody is signed in on such a process: its own login is not in play');
  assert.equal(c.s.snapshot().accountId, 'codex-key-1');
  // No event, snapshot, log line, or line written to Codex holds the key. Nor does what the registry saved.
  assert.ok(c.w.events.length > 8 && c.fake.received.length === 8);
  for (const secret of [KEY, 'sk-proj', 'NOT-A-REAL-KEY']) assert.ok(!everything(c).includes(secret) && !W.saved.join('').includes(secret), secret);
  // No call about the account was made that Canopy does not make, and none that hands Codex a key.
  assert.deepEqual(c.fake.received.map((m) => m.method).filter((m) => m.startsWith('account/')), ['account/read']);
});

test('what Codex prints about a key is cut out before a chat shows or logs it', async () => {
  const W = await world();
  W.reg.setActive('codex', 'codex-key-1');
  const c = chat(W, { script: { holdTurns: true }, autoRestart: false, timeouts: { restart: 15 } });
  c.s.send('hello');
  await c.w.waitFor('message-start', { ms: 3000 });
  c.fake.last.stderr.write(`fatal: request failed with Authorization: Bearer ${KEY} (key ${KEY})\n`);
  await sleep(20);
  c.fake.last.die(1);
  await c.w.waitFor((e) => e.kind === 'stopped', { ms: 3000 });
  await sleep(30);
  const all = everything(c);
  assert.ok(all.includes('[redacted]'), 'what Codex printed is passed on');
  assert.ok(!all.includes(KEY) && !all.includes('NOT-A-REAL-KEY'), 'without the key in it');
});

test('a replaced key reaches the chats on its account: at once when idle, after the turn when working, and never mid-turn', async () => {
  const W = await world();
  W.reg.setActive('codex', 'codex-key-1');
  const idleChat = chat(W);
  idleChat.s.send('one');
  await idle(idleChat.w);
  const busyChat = chat(W, { script: { holdTurns: true } });
  busyChat.s.send('two');
  await busyChat.w.waitFor('message-start', { ms: 3000 });

  W.held.set('codex-key-1', KEY2);
  assert.equal(await idleChat.s.recycle('account'), true);
  await until(() => idleChat.fake.spawns.length === 2 && idleChat.s.lifecycle === 'ready', 3000, 'the idle chat on its new process');
  assert.equal(idleChat.fake.spawns[1].options.env[KEY_VAR], KEY2);
  assert.deepEqual(idleChat.fake.spawns[1].args, KEY_ARGS);
  assert.equal(idleChat.fake.alive().length, 1, 'the process that held the old key is gone');
  assert.deepEqual(idleChat.w.of('stopped').map((e) => [e.reason, e.willRestart, e.why]), [['restart', true, 'account']]);
  assert.equal(idleChat.fake.sent('thread/resume').length, 1, 'the same conversation, opened again');
  idleChat.s.send('again');
  await idle(idleChat.w, idleChat.w.events.length);
  assert.equal(idleChat.fake.spawns.length, 2);

  // The one at work is left alone until its turn is over.
  assert.equal(await busyChat.s.recycle('account'), false);
  assert.deepEqual([busyChat.fake.spawns.length, busyChat.s.busy], [1, true]);
  busyChat.fake.last.playText('done');
  await until(() => busyChat.fake.spawns.length === 2 && busyChat.s.lifecycle === 'ready', 3000, 'the busy chat restarted once free');
  assert.equal(busyChat.w.find('turn-end').text, 'done', 'its turn ended as it would have');
  assert.equal(busyChat.fake.spawns[1].options.env[KEY_VAR], KEY2);
  // A chat with no process has nothing to restart: its next start is a new launch anyway.
  const cold = chat(W);
  assert.equal(await cold.s.recycle('account'), false);
  assert.equal(cold.fake.spawns.length, 0);
  for (const c of [idleChat, busyChat]) assert.ok(!everything(c).includes('NOT-A-REAL-KEY'));
});

test('a message sent while a chat’s process is being started again goes to the new one, once', async () => {
  const W = await world();
  W.reg.setActive('codex', 'codex-key-1');
  // The chat is still starting (its first process has not opened the conversation yet) when its key is replaced.
  const c = chat(W, { script: { hang: ['thread/start'] } });
  const warming = c.s.warm();
  await until(() => c.fake.sent('thread/start').length === 1, 3000, 'the first start to be under way');
  W.held.set('codex-key-1', KEY2);
  c.fake.hang.delete('thread/start');
  const restarting = c.s.recycle('account');
  const sent = c.s.send('while it restarts');
  assert.equal(sent.ok, true);
  assert.equal(await restarting, true);
  await idle(c.w);
  assert.deepEqual(c.fake.sent('turn/start').map((m) => m.params.input[0].text), ['while it restarts'], 'sent once, not lost with the start that was called off');
  assert.deepEqual(c.fake.spawns.map((x) => x.options.env[KEY_VAR]), [KEY, KEY2]);
  assert.equal(c.w.find('turn-end').text, 'OK');
  assert.equal((await warming).ok, false, 'the start that was under way on the old key was called off, quietly');
  assert.deepEqual(c.w.of('error'), []);
  assert.equal(c.fake.alive().length, 1);
});

// ---- choosing another account ----

test('choosing another account moves a chat nobody has used yet, and no other', async () => {
  const W = await world();
  const fresh = chat(W);
  await fresh.s.warm();
  assert.deepEqual([fresh.s.accountId, fresh.fake.spawns[0].args], [null, PLAIN_ARGS]);
  const used = chat(W);
  used.s.send('hello');
  await idle(used.w);

  W.reg.setActive('codex', 'codex-key-1');
  assert.equal(fresh.s.moveAccount(W.reg.pin('codex')), true);
  assert.equal(used.s.moveAccount(W.reg.pin('codex')), false, 'a chat with a conversation keeps the account it started on');
  assert.deepEqual([fresh.s.accountId, used.s.accountId], ['codex-key-1', null]);
  assert.deepEqual(fresh.w.of('meta').at(-1).accountId, 'codex-key-1', 'whoever shows the chat is told');
  await until(() => fresh.fake.spawns.length === 2 && fresh.s.lifecycle === 'ready', 3000, 'the unused chat warmed up again on the key');
  assert.deepEqual(fresh.fake.spawns[1].args, KEY_ARGS);
  assert.equal(fresh.fake.spawns[1].options.env[KEY_VAR], KEY);
  assert.equal(fresh.fake.alive().length, 1);
  assert.equal(fresh.s.moveAccount('codex-key-1'), false, 'already there');

  // And back: as Codex finds itself again, with nothing of the key left on its process.
  W.reg.setActive('codex', 'codex-default');
  assert.equal(fresh.s.moveAccount(W.reg.pin('codex')), true);
  await until(() => fresh.fake.spawns.length === 3 && fresh.s.lifecycle === 'ready', 3000, 'back on Codex’s own login');
  assert.deepEqual([fresh.fake.spawns[2].args, fresh.fake.spawns[2].options.env, fresh.s.provider], [PLAIN_ARGS, AS_CODEX_GETS_IT, null]);
  fresh.s.send('hello');
  await idle(fresh.w);
  assert.equal(fresh.s.moveAccount('codex-key-1'), false, 'used now: it stays');
  // The used chat's next start is still the launch of the account it began on.
  await used.s.stop();
  used.s.send('again');
  await idle(used.w, used.w.events.length);
  assert.deepEqual(used.fake.spawns.map((x) => x.args), [PLAIN_ARGS, PLAIN_ARGS]);
  // A chat that was never started moves without starting anything.
  const cold = chat(W);
  assert.equal(cold.s.moveAccount('codex-key-1'), true);
  assert.equal(cold.fake.spawns.length, 0);
});

test('a chat that moves to another account leaves the plan’s limits behind, and reads them again when it moves back', async () => {
  const W = await world();
  // Codex's own login is a ChatGPT plan, whose limits a chat reads for its context ring.
  const { s, fake } = chat(W, { script: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' } } });
  await s.warm();
  await until(() => s.limits().length === 2, 3000, 'the plan’s limits to be read');

  // On the key, Codex's own login is not in play: its plan's limits are not this chat's, and nothing is asked about a plan.
  W.reg.setActive('codex', 'codex-key-1');
  assert.equal(s.moveAccount(W.reg.pin('codex')), true);
  assert.deepEqual(s.limits(), [], 'gone with the move, not once the new process is up');
  await until(() => fake.spawns.length === 2 && s.lifecycle === 'ready', 3000, 'warmed up again on the key');
  await sleep(30);
  assert.deepEqual(fake.children[1].received.map((m) => m.method).filter((m) => m?.startsWith('account/')), ['account/read']);
  assert.deepEqual(s.limits(), [], 'and still none once the key’s process is up');

  // Back on Codex's own login: whether it has limits is found out again.
  W.reg.setActive('codex', 'codex-default');
  assert.equal(s.moveAccount(W.reg.pin('codex')), true);
  await until(() => s.limits().length === 2, 3000, 'the limits to be read again');
});

// ---- an account that cannot be launched ----

test('a chat whose account cannot be launched does not start: it says why, hands the message back, and never runs on another login', async () => {
  const W = await world();
  W.reg.setActive('codex', 'codex-key-1');
  const cases = [
    ['account-locked', /could not be read from the Keychain/, () => W.held.delete('codex-key-1'), () => W.held.set('codex-key-1', KEY)],
    ['account-invalid-key', /no longer works/, () => W.reg.note('codex-key-1', { state: 'invalid-key' }), () => W.reg.note('codex-key-1', { state: 'ok' })],
  ];
  for (const [code, words, breakIt, mendIt] of cases) {
    const c = chat(W);
    breakIt();
    const sent = c.s.send('hello');
    const err = await c.w.waitFor('error', { ms: 3000 });
    assert.deepEqual([err.code, err.recoverable, err.prompts], [code, false, [{ id: sent.id, text: 'hello' }]], code);
    assert.match(err.message, words);
    assert.deepEqual([c.fake.spawns.length, c.s.busy, c.s.outbox.size], [0, false, 0], 'no process at all: not on the key, and not on Codex’s login');
    // Mended: the same chat starts on its account.
    mendIt();
    c.s.send('hello again');
    await idle(c.w, c.w.events.length);
    assert.deepEqual([c.fake.spawns.length, c.fake.spawns[0].options.env[KEY_VAR]], [1, KEY]);
  }
  // Removed from Canopy while a chat was on it: its next start refuses the same way.
  const c = chat(W);
  c.s.send('one');
  await idle(c.w);
  await c.s.stop();
  W.reg.remove('codex', 'codex-key-1');
  c.s.send('two');
  const gone = await c.w.waitFor('error', { ms: 3000, from: c.w.events.length - 1 });
  assert.deepEqual([gone.code, gone.message], ['account-missing', 'The account this chat uses is no longer in Canopy.']);
  assert.equal(c.fake.spawns.length, 1, 'nothing was started for it');
  // Warming up such a chat is only a notice: there is no message to hand back.
  const warm = chat(W, { account: 'codex-key-1' });
  const r = await warm.s.warm();
  assert.deepEqual([r.ok, r.code, warm.fake.spawns.length], [false, 'account-missing', 0]);
  assert.deepEqual(warm.w.of('notice').map((e) => [e.code, e.text]), [['account-missing', 'The account this chat uses is no longer in Canopy.']]);
});

// ---- Codex keeps a chat on the provider it began on ----

test('a saved chat opens on the kind of account it began on, whatever is in use now', async () => {
  const W = await world({ keys: { 'codex-key-1': KEY, 'codex-key-2': KEY2 } });
  const fake = createFakeCodex();
  // One chat begun on Codex's own login, one on a pasted key.
  const own = chat(W, { fake });
  own.s.send('on the login');
  await idle(own.w);
  W.reg.setActive('codex', 'codex-key-1');
  const keyed = chat(W, { fake });
  keyed.s.send('on the key');
  await idle(keyed.w);
  const [ownId, keyedId] = [own.s.sessionId, keyed.s.sessionId];
  assert.deepEqual([fake.providerOf[ownId], fake.providerOf[keyedId]], ['openai', KEY_PROVIDER]);
  await own.s.dispose();
  await keyed.s.dispose();

  // Reopened with the key in use: the login's chat is still launched as Codex finds itself.
  const ownAgain = chat(W, { fake, resume: ownId, began: null });
  ownAgain.s.send('more');
  await idle(ownAgain.w);
  assert.deepEqual([ownAgain.s.accountId, fake.spawns.at(-1).args, fake.spawns.at(-1).options.env], [null, PLAIN_ARGS, AS_CODEX_GETS_IT]);
  assert.equal(ownAgain.w.find('turn-end').text, 'OK');
  await ownAgain.s.dispose();
  // Reopened with Codex's login in use: the key's chat is still launched on its key.
  W.reg.setActive('codex', 'codex-default');
  const keyedAgain = chat(W, { fake, resume: keyedId, began: 'codex-key-1' });
  keyedAgain.s.send('more');
  await idle(keyedAgain.w);
  assert.deepEqual([keyedAgain.s.accountId, fake.spawns.at(-1).args, fake.spawns.at(-1).options.env[KEY_VAR]], ['codex-key-1', KEY_ARGS, KEY]);
  await keyedAgain.s.dispose();
  // Its key gone, another key in use: it carries on there. Its key gone and no key in use: it says so, and starts nothing.
  W.reg.remove('codex', 'codex-key-1');
  W.reg.setActive('codex', 'codex-key-2');
  const onOther = chat(W, { fake, resume: keyedId, began: 'codex-key-1' });
  onOther.s.send('more');
  await idle(onOther.w);
  assert.deepEqual([onOther.s.accountId, fake.spawns.at(-1).options.env[KEY_VAR]], ['codex-key-2', KEY2]);
  await onOther.s.dispose();
  W.reg.setActive('codex', 'codex-default');
  W.reg.remove('codex', 'codex-key-2');
  const spawned = fake.spawns.length;
  const stranded = chat(W, { fake, resume: keyedId, began: 'codex-key-1' });
  stranded.s.send('more');
  assert.equal((await stranded.w.waitFor('error', { ms: 3000 })).code, 'account-missing');
  assert.equal(fake.spawns.length, spawned);
});

test('the safety net: a chat that comes up on another provider than its account’s is not run, in either direction', async () => {
  const W = await world();
  const fake = createFakeCodex({ known: ['own-chat', 'key-chat'], providerOf: { 'own-chat': 'openai', 'key-chat': KEY_PROVIDER } });

  // A chat begun on Codex's login, opened by a process started for a key (Canopy's record of it was wrong). Codex
  // would bring it up on the login, and the turn would be billed there: it is not sent.
  W.reg.setActive('codex', 'codex-key-1');
  const wrong = chat(W, { fake, resume: 'own-chat', account: 'codex-key-1' });
  const sent = wrong.s.send('hello');
  const err = await wrong.w.waitFor('error', { ms: 3000 });
  assert.deepEqual([err.code, err.prompts], ['account-kept', [{ id: sent.id, text: 'hello' }]]);
  assert.match(err.message, /began on Codex’s own login.*can’t carry on with an API key/);
  await until(() => fake.alive().length === 0, 3000, 'its process to be gone');
  assert.deepEqual([fake.sent('turn/start').length, wrong.s.busy], [0, false], 'nothing was sent on the wrong login');

  // A chat begun on a key, opened as Codex finds itself: Codex refuses it, and the chat says what would open it.
  const other = chat(W, { fake, resume: 'key-chat', account: null });
  other.s.send('hello');
  const refused = await other.w.waitFor('error', { ms: 3000 });
  assert.equal(refused.code, 'account-kept');
  assert.match(refused.message, /began on an API key added in Canopy.*Choose an API key in Settings/);
  assert.equal(fake.sent('turn/start').length, 0);
  // Opened on a key, it runs.
  const right = chat(W, { fake, resume: 'key-chat', began: 'codex-key-1' });
  right.s.send('hello');
  await idle(right.w);
  assert.equal(right.w.find('turn-end').text, 'OK');

  // A new chat that Codex starts on another provider than the key's (the user's settings forced one) is not run either.
  const forced = createFakeCodex({ handlers: { 'thread/start': () => ({ thread: { id: 'forced' }, model: 'm', modelProvider: 'their-own' }) } });
  const off = chat(W, { fake: forced });
  off.s.send('hello');
  const blocked = await off.w.waitFor('error', { ms: 3000 });
  assert.equal(blocked.code, 'account-kept');
  assert.match(blocked.message, /did not start this chat on its API key/);
  assert.equal(forced.sent('turn/start').length, 0);
  // A Codex too old to say which provider a chat is on is not held to anything it cannot say.
  const silent = createFakeCodex({ handlers: { 'thread/start': () => ({ thread: { id: 'silent', cliVersion: '0.1.0' }, model: 'm' }) } });
  const quiet = chat(W, { fake: silent, script: {} });
  await quiet.s.warm();
  assert.equal(quiet.s.lifecycle, 'ready');
});

// ---- what a chat says about its account ----

test('a chat says which account it is on when its first turn starts, in the host’s words, and only then', async () => {
  const W = await world();
  W.reg.setActive('codex', 'codex-key-1');
  const asked = [];
  const c = chat(W, { accountNotice: (reported, id) => { asked.push([reported, id]); return 'This chat uses API key ••••9zQx.'; } });
  await c.s.warm();
  assert.deepEqual([asked, c.w.of('notice').filter((e) => e.code === 'account')], [[], []], 'a chat that is opened and never used says nothing');
  c.s.send('one');
  await idle(c.w);
  c.s.send('two');
  await idle(c.w, c.w.events.length);
  assert.deepEqual(asked, [[{ provider: KEY_PROVIDER }, 'codex-key-1']], 'asked once, with the provider its process was started on');
  assert.deepEqual(c.w.of('notice').filter((e) => e.code === 'account').map((e) => e.text), ['This chat uses API key ••••9zQx.']);
  const order = c.w.events.map((e) => (e.kind === 'notice' ? e.code : e.kind));
  assert.ok(order.indexOf('account') > order.indexOf('init') && order.indexOf('account') < order.indexOf('message-start'), 'before the turn it belongs to');
  // A host with nothing to say, or one that throws, says nothing; a chat on Codex's login reports no provider.
  for (const accountNotice of [() => null, () => '', () => { throw new Error('boom'); }]) {
    const quiet = chat(await world(), { accountNotice });
    quiet.s.send('hello');
    await idle(quiet.w);
    assert.deepEqual(quiet.w.of('notice').filter((e) => e.code === 'account'), []);
  }
  const own = [];
  const plain = chat(await world(), { accountNotice: (reported, id) => { own.push([reported, id]); return null; } });
  plain.s.send('hello');
  await idle(plain.w);
  assert.deepEqual(own, [[{ provider: null }, null]]);
});

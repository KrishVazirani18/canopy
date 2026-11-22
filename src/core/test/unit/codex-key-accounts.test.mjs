// An OpenAI API key pasted into Canopy, end to end, as main.mjs wires it: the window's calls, the registry, the
// vault, the two Codex helpers, the list of Codex chats, the sign-in flow and real Codex chats in a real ChatHost.
// Only `handle`, `send`, Electron's safeStorage and OpenAI's answer are stand-ins, and Codex is fake-codex.mjs
// (which treats model providers the way a real app-server was seen to). No Codex is started, no key is real,
// nothing leaves this process, and nothing is written under any Codex folder.
//
// What this file holds the feature to:
//  - with nothing chosen, Codex is started exactly as it was before there were accounts;
//  - a key is in the environment of its own Codex processes and in the vault's ciphertext, and nowhere else: not in
//    a reply, an event, the saved state, a log line, a command line, or a line written to Codex;
//  - Codex's own login is never touched by any of it, and nothing is written into Codex's folder;
//  - a chat stays on the account it began on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, within } from '../helpers.mjs';
import { chatAccountLine, moveUnusedChats, registerAccountActions, restartChatsOn } from '../../../account-actions.mjs';
import { registerCodexSignIn } from '../../../accounts-codex-ipc.mjs';
import { registerAccounts } from '../../../accounts-ipc.mjs';
import { ChatHost, engineOf } from '../../../chats.mjs';
import { CodexChats, engineFor } from '../../../codex-chats.mjs';
import { Secrets } from '../../../secrets.mjs';
import { ACCOUNT_CALLS, CodexService } from '../../codex-host.mjs';
import { KEY_VAR, chatAccount, isPastedKey } from '../../accounts-codex.mjs';
import { CodexSession } from '../../codex-session.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-key-accounts-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

const okey = (tail) => ['sk', 'proj', 'NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstu_T3BlbkFJ', tail].join('-'); // made up, and split so secret scanners do not mistake it for a key
const KEY = okey('7Hq2');
const KEY2 = okey('m3Xw');
const PLUS = { type: 'chatgpt', email: 'me@example.com', planType: 'plus' };
const PLAIN_ARGS = ['app-server', '--listen', 'stdio://'];
const KEY_ARGS = [...PLAIN_ARGS,
  '-c', 'model_providers.canopy-openai={ name = "OpenAI", base_url = "https://api.openai.com/v1", env_key = "CANOPY_OPENAI_API_KEY", wire_api = "responses", requires_openai_auth = false }',
  '-c', 'model_provider="canopy-openai"'];
const answer = (status) => ({ status, body: { cancel: async () => {} } });

function fakeSafe() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.concat([Buffer.from('v10'), Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)]),
    decryptString: (data) => Buffer.from(data.subarray(3).map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

const wires = [];
afterEach(async () => {
  const all = wires.splice(0);
  for (const w of all) { try { await within(w.shutdown(), 6000, 'clean-up'); } catch { /* the test reports its own failures */ } }
  for (const w of all) {
    assert.equal(w.fake.alive().length, 0, 'no Codex process is left behind');
    assert.deepEqual(fs.readdirSync(w.codexHome), [], 'nothing was written into the Codex folder');
  }
});
const until = async (cond, ms = 4000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

// main.mjs, as far as Codex's accounts go: the same pieces wired the same way, over a fake Codex. `disk` is what
// outlives a restart of Canopy (state.json, the vault's file) and `fake` is Codex's own folder, which outlives it too.
function wire({ disk, fake, account = PLUS, ...script } = {}) {
  disk ??= { dir: path.join(root, `w${++seq}`), state: {} };
  const codexHome = path.join(disk.dir, 'codex-home');   // stands for the user's Codex folder: must stay empty
  const userData = path.join(disk.dir, 'user-data');
  const work = path.join(disk.dir, 'work');
  for (const dir of [codexHome, userData, work]) fs.mkdirSync(dir, { recursive: true });
  const SHELL = Object.freeze({ PATH: '/usr/bin:/bin', HOME: disk.dir, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-shell-own', CANOPY_OPENAI_API_KEY: 'from-the-shell' });
  // The plan's limits cannot be read unless a test says otherwise: reading them is how Canopy tells a login that
  // still works from one OpenAI no longer takes.
  fake ??= createFakeCodex({ account, rateLimits: null, ...script });
  const state = disk.state;
  const saveState = (patch) => { Object.assign(state, JSON.parse(JSON.stringify(patch))); };
  const channels = new Map(), sent = [], logs = [], replies = [], asked = [];
  const said = new Map();   // every event of every chat, by its sid: the window is only sent those of the chat on screen
  const w = { fake, disk, codexHome, userData, work, SHELL, state, sent, logs, replies, asked, openai: () => answer(200) };
  const handle = (channel, fn) => { assert.ok(!channels.has(channel), `${channel} is registered once`); channels.set(channel, fn); };
  const send = (channel, payload) => sent.push([channel, payload]);
  const log = (m) => logs.push(String(m));
  const timeouts = { init: 1000, request: 1000, list: 1000, history: 1000 };
  let chats = null;

  const codexService = new CodexService({ codexPath: '/fake/codex', env: () => SHELL, spawnFn: fake.spawnFn, timeouts, lingerMs: 50, log: (level, msg, data) => log(`codex helper ${level}: ${msg} ${JSON.stringify(data ?? null)}`) });
  const codexKeyService = new CodexService({
    codexPath: '/fake/codex', env: () => SHELL, spawnFn: fake.spawnFn, timeouts, lingerMs: 50,
    launch: (base) => accounts.launchFor('codex', { base }),
    log: (level, msg, data) => log(`codex key helper ${level}: ${msg} ${JSON.stringify(data ?? null)}`),
  });
  const codexKey = (id) => (typeof id === 'string' && isPastedKey(accounts.get('codex', id)) ? id : null);
  const codexChats = new CodexChats({
    load: () => state.codexChats, save: (list) => saveState({ codexChats: list }), service: codexService,
    keyService: codexKeyService, keyInUse: () => !!codexKey(accounts.pin('codex')),
    installed: () => true, onChange: () => send('sessions:changed'), onModels: () => send('models:changed'), log,
  });
  const secrets = new Secrets({ file: path.join(userData, 'secrets.json'), safe: fakeSafe(), log: (m) => log(`secrets: ${m}`) });
  const accounts = registerAccounts(handle, {
    claude: () => ({ path: null, env: SHELL }), // Claude Code plays no part here
    codex: { installed: () => true, account: () => codexService.account(), env: () => SHELL, works: () => codexService.loginWorks() },
    load: () => state.accounts ?? null, save: (s) => saveState({ accounts: s }),
    send, log: (m) => log(`accounts: ${m}`),
    keyFor: (a) => secrets.get(a.id), checkKey: (a) => accountActions.verifyKey(a),
  });
  const codexModelsChanged = () => { codexKeyService.reset().catch(() => {}); codexChats.forgetModels(); send('models:changed'); };
  const switched = (engine) => {
    if (engine !== 'codex') return;
    moveUnusedChats(chats?.manager.sessions(), accounts.pin(engine), engine);
    codexModelsChanged();
  };
  const accountActions = registerAccountActions(handle, {
    accounts, secrets, log: (m) => log(`accounts: ${m}`),
    fetch: async (url, init) => { asked.push({ url, init }); const a = await w.openai(url, init); if (a instanceof Error) throw a; return a; },
    outranked: () => false,
    onSwitch: (engine) => switched(engine),
    onRekeyed: (engine, id) => { restartChatsOn(chats?.manager.sessions(), id, engine); if (accounts.pin(engine) === id && engine === 'codex') codexModelsChanged(); },
  });
  const chatLine = chatAccountLine({ accounts, load: () => state.chatAccount, save: (last) => saveState({ chatAccount: last }) });
  const codexSignIn = registerCodexSignIn(handle, {
    accounts, service: codexService, installed: () => true, open: async () => {},
    onLogin: () => { codexChats.forgetModels(); send('models:changed'); },
    keyInDoubt: (id) => accountActions.keyInDoubt('codex', id),
    send, log: (m) => log(`accounts: codex ${m}`),
  });
  chats = new ChatHost({
    // The Codex branch of the `create` seam in src/main.mjs.
    create: (o) => {
      const codex = new CodexSession({
        cwd: o.cwd, resume: o.resume, codexPath: () => '/fake/codex', env: () => SHELL, spawnFn: fake.spawnFn, timeouts: { restart: 15 },
        account: chatAccount({ saved: !!o.resume, began: o.resume ? codexChats.accountOf(o.resume) : null, inUse: accounts.pin('codex'), isKey: (id) => !!codexKey(id) }),
        launch: (base) => accounts.launchFor('codex', { account: codex.accountId, base }),
        accountNotice: (reported, id) => chatLine('codex', id, reported),
        log: (level, msg, data) => { if (level !== 'debug') log(`codex ${level}: ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`); },
        onAccountUpdated: (info) => codexSignIn.accountUpdated(info),
      });
      return codex;
    },
    send,
    onEvent: (ev, entry) => {
      if (!said.has(ev.sid)) said.set(ev.sid, []);
      said.get(ev.sid).push(ev);
      if (entry.engine !== 'codex') return;
      codexChats.onEvent(ev, entry, chats.manager.get(ev.sid));
      codexSignIn.chatEvent(ev, codexKey(chats.manager.get(ev.sid)?.accountId));
    },
    maxIdle: 8,
  });

  Object.assign(w, {
    accounts, secrets, codexService, codexKeyService, codexChats, codexSignIn, accountActions, chats,
    // The window's call, as main answers it. Every reply is kept, to look through later.
    call: async (channel, ...args) => { const r = await channels.get(channel)(...args); replies.push(r); return r; },
    row: (id) => accounts.view().list.find((a) => a.id === id) ?? null,
    // The window opening a chat (`session:open`), and what it gets back about it.
    open: async (resume = null) => {
      const engine = engineFor({ resume, engine: 'codex', has: (id) => codexChats.has(id), codexPath: '/fake/codex', signedIn: codexChats.canStart });
      const r = await chats.open(work, resume, engine === 'codex' ? { engine } : {});
      return { ...r, reply: { ok: true, sid: r.sid, engine: engineOf(r.session), accountId: r.session.accountId ?? null } };
    },
    events: (sid) => said.get(sid) ?? [],
    turn: async (r, text = 'hello') => {
      const from = w.events(r.sid).length;
      assert.equal(r.session.send(text).ok, true);
      chats.noteSent(text);
      await until(() => w.events(r.sid).slice(from).some((e) => (e.kind === 'busy' && e.busy === false) || e.kind === 'error'), 4000, 'the turn to end');
      return w.events(r.sid).slice(from);
    },
    modelsList: async () => { const { openai, codex } = await codexChats.models(); return { openai: openai.map((m) => m.value), codex: codexSignIn.describe({ ...codex, method: codexChats.signInMethod }) }; },
    vault: () => { try { return fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8'); } catch { return ''; } },
    // Everything that leaves main or is written down, and everything written to a Codex process or put on its
    // command line. The one place a key may be is not in here: the environment of its own Codex processes.
    everything: () => JSON.stringify([replies, sent, [...said.values()], state, fake.received, fake.spawns.map((x) => [x.command, x.args, x.options.cwd])]) + logs.join('\n') + w.vault(),
    spawnsWithKey: () => fake.spawns.filter((x) => KEY_VAR in x.options.env),
    shutdown: async () => { await chats.closeAll(); await codexService.close({ graceMs: 50 }); await codexKeyService.close({ graceMs: 50 }); },
  });
  wires.push(w);
  return w;
}

// ---- the whole of it ----

test('a key pasted for Codex: added beside Codex’s login, used for new chats, and never anywhere but its own processes', { timeout: 60000 }, async () => {
  const w = wire();
  await w.call('accounts:refresh', true);
  assert.deepEqual(w.accounts.view().list.map((a) => [a.id, a.label, a.found]), [['codex-default', 'ChatGPT Plus', true]]);

  // Before anything is added: a chat on the login Codex holds, started as Codex has always been started.
  const first = await w.open();
  assert.deepEqual(first.reply, { ok: true, sid: first.sid, engine: 'codex', accountId: null });
  await w.turn(first, 'on the login');
  const asFound = w.fake.spawns.at(-1);
  assert.deepEqual(asFound.args, PLAIN_ARGS);
  assert.deepEqual(asFound.options.env, { PATH: '/usr/bin:/bin', HOME: w.disk.dir, CODEX_HOME: w.codexHome, OPENAI_API_KEY: 'sk-shell-own' });

  // The key is pasted in Settings: checked with OpenAI, kept in the vault, listed. Nothing switches.
  assert.deepEqual(await w.call('accounts:add-key', 'codex', ` ${KEY}\n`), { ok: true, id: w.accounts.view().list[1].id });
  const id = w.accounts.view().list[1].id;
  assert.match(id, /^codex-key-[\w-]+$/);
  assert.deepEqual([w.asked.length, w.asked[0].url, w.asked[0].init.headers.authorization], [1, 'https://api.openai.com/v1/models', `Bearer ${KEY}`]);
  assert.deepEqual([w.row(id).label, w.row(id).found, w.accounts.view().inUse.codex], ['API key ••••7Hq2', false, 'codex-default']);
  const beside = await w.open();
  await w.turn(beside, 'still on the login');
  assert.deepEqual([beside.reply.accountId, w.fake.spawns.at(-1).args, w.fake.spawns.at(-1).options.env], [null, PLAIN_ARGS, asFound.options.env], 'a key that is only listed changes nothing about how Codex is started');

  // "Use": new chats run on the key. The chat that was open keeps the login it began on.
  assert.deepEqual(await w.call('accounts:use', 'codex', id), { ok: true });
  assert.deepEqual([w.accounts.view().inUse.codex, w.accounts.view().own.codex], [id, 'codex-default']);
  const keyed = await w.open();
  assert.equal(keyed.reply.accountId, id);
  const said = await w.turn(keyed, 'on the key');
  const onKey = w.fake.spawns.at(-1);
  assert.deepEqual(onKey.args, KEY_ARGS);
  assert.deepEqual(onKey.options.env, { ...asFound.options.env, [KEY_VAR]: KEY }, 'the same environment, plus the key under Canopy’s own name');
  assert.deepEqual(said.filter((e) => e.kind === 'notice' && e.code === 'account').map((e) => e.text), ['This chat uses API key ••••7Hq2.'], 'said once, in the first chat that runs on it');
  assert.equal(w.codexChats.accountOf(keyed.session.sessionId), id, 'and the chat is remembered as begun on that key');
  assert.equal(w.codexChats.accountOf(first.session.sessionId), null);
  assert.deepEqual((await w.turn(first, 'more on the login')).filter((e) => e.kind === 'error'), []);
  assert.equal(first.session.accountId, null);
  // The model picker reads the key's own helper, and Settings says how OpenAI's models are signed in.
  assert.deepEqual((await w.modelsList()).codex, { installed: true, signedIn: true, method: 'apiKey' });
  const helper = w.fake.spawns.at(-1);
  assert.deepEqual([helper.args, helper.options.env[KEY_VAR], helper.options.cwd], [KEY_ARGS, KEY, os.homedir()]);

  // What Codex was asked about the account, by any process: who is signed in, and, by a chat on Codex's own plan
  // (for its context ring), how much of the plan's limits is used. A process on the key is never asked the second.
  const accountCallsOf = (received) => [...new Set(received.map((m) => m.method).filter((m) => typeof m === 'string' && m.startsWith('account/')))].sort();
  const accountCalls = accountCallsOf(w.fake.received);
  assert.deepEqual(accountCalls, ['account/rateLimits/read', 'account/read']);
  assert.ok(accountCalls.every((m) => ACCOUNT_CALLS.includes(m)));
  const onTheKey = w.fake.children.filter((_c, i) => KEY_VAR in w.fake.spawns[i].options.env);
  assert.deepEqual(onTheKey.map((c) => accountCallsOf(c.received)), [['account/read'], []], 'the chat on the key asks who is signed in, its helper nothing, and neither about a plan');
  assert.equal(w.fake.account, PLUS, 'Codex’s own login is as it was');
  assert.equal(w.row('codex-default').state, 'ok');

  // The key: in the environment of its own processes, and in the vault's ciphertext. Nowhere else.
  assert.equal(w.spawnsWithKey().length, 2, 'the chat on the key, and the helper for it');
  assert.deepEqual([w.fake.spawns.length >= 5, w.replies.length >= 3, w.sent.length > 10, w.logs.length >= 3], [true, true, true, true], `there was plenty to look through: ${[w.fake.spawns.length, w.replies.length, w.sent.length, w.logs.length]}`);
  assert.ok(w.logs.some((l) => l.includes(id)), 'the log names the account by its id');
  for (const secret of [KEY, 'sk-proj', 'NOT-A-REAL-KEY', 'T3BlbkFJ']) assert.ok(!w.everything().includes(secret), `${secret.slice(0, 12)}… is written or sent somewhere`);
  assert.deepEqual(fs.readdirSync(w.userData), ['secrets.json']);
  assert.equal(fs.statSync(path.join(w.userData, 'secrets.json')).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(w.state).sort(), ['accounts', 'chatAccount', 'codexChats']);
  assert.deepEqual(w.state.accounts.list.map((a) => [a.id, a.keyHint]), [['codex-default', null], [id, '7Hq2']], 'the saved state names the account and its last four characters');
});

test('a chat stays on the account it began on, across a restart of Canopy and whatever is in use', { timeout: 60000 }, async () => {
  const w = wire();
  await w.call('accounts:refresh', true);
  const own = await w.open();
  await w.turn(own, 'on the login');
  const { id } = await w.call('accounts:add-key', 'codex', KEY);
  await w.call('accounts:use', 'codex', id);
  const keyed = await w.open();
  await w.turn(keyed, 'on the key');
  const [ownChat, keyChat] = [own.session.sessionId, keyed.session.sessionId];
  await w.shutdown();

  // Canopy starts again: state.json and the vault's file are what it has. The key is still the account in use.
  const again = wire({ disk: w.disk, fake: w.fake });
  await again.call('accounts:refresh', true);
  assert.deepEqual([again.accounts.pin('codex'), again.codexChats.accountOf(keyChat), again.codexChats.accountOf(ownChat)], [id, id, null]);
  // The login's chat, reopened with the key in use: Codex would only open it on the login, and that is where it goes.
  const ownAgain = await again.open(ownChat);
  assert.equal(ownAgain.reply.accountId, null);
  assert.deepEqual((await again.turn(ownAgain, 'more')).filter((e) => e.kind === 'error'), []);
  assert.deepEqual([again.fake.spawns.at(-1).args, KEY_VAR in again.fake.spawns.at(-1).options.env], [PLAIN_ARGS, false]);
  // The key's chat, reopened with Codex's own login in use: on its key.
  assert.deepEqual(await again.call('accounts:use', 'codex', 'codex-default'), { ok: true });
  assert.equal(again.accounts.pin('codex'), null, 'choosing Codex’s login is choosing nothing');
  const keyAgain = await again.open(keyChat);
  assert.equal(keyAgain.reply.accountId, id);
  assert.deepEqual((await again.turn(keyAgain, 'more')).filter((e) => e.kind === 'error'), []);
  assert.deepEqual([again.fake.spawns.at(-1).args, again.fake.spawns.at(-1).options.env[KEY_VAR]], [KEY_ARGS, KEY]);
  assert.equal(again.fake.sent('thread/resume').at(-1).params.threadId, keyChat);
  // A new chat now is on Codex's login again.
  const fresh = await again.open();
  await again.turn(fresh, 'new');
  assert.deepEqual([fresh.reply.accountId, again.fake.spawns.at(-1).args], [null, PLAIN_ARGS]);

  // The key is removed: its chat does not carry on anywhere else, and says so. Nothing is started for it.
  await again.chats.manager.close(keyAgain.sid, { graceMs: 50 });
  assert.deepEqual(await again.call('accounts:remove', 'codex', id), { ok: true });
  assert.equal(again.vault().includes(id), false, 'its key is off this Mac');
  const before = again.fake.spawns.length;
  const stranded = await again.open(keyChat);
  const refused = (await again.turn(stranded, 'more')).find((e) => e.kind === 'error');
  assert.deepEqual([refused.code, refused.message, again.fake.spawns.length], ['account-missing', 'The account this chat uses is no longer in Canopy.', before]);
  // Another key, in use: the chat carries on with it.
  await again.chats.manager.close(stranded.sid, { graceMs: 50 });
  const other = (await again.call('accounts:add-key', 'codex', KEY2)).id;
  await again.call('accounts:use', 'codex', other);
  const carried = await again.open(keyChat);
  assert.equal(carried.reply.accountId, other);
  assert.deepEqual((await again.turn(carried, 'more')).filter((e) => e.kind === 'error'), []);
  assert.equal(again.fake.spawns.at(-1).options.env[KEY_VAR], KEY2);
  for (const x of [w, again]) for (const secret of [KEY, KEY2, 'NOT-A-REAL-KEY']) assert.ok(!x.everything().includes(secret));
});

test('choosing another account moves the chat nobody has used yet; a replaced key restarts the chats on it', { timeout: 60000 }, async () => {
  const w = wire();
  await w.call('accounts:refresh', true);
  const { id } = await w.call('accounts:add-key', 'codex', KEY);
  const empty = await w.open();          // on screen, never used
  await empty.session.warm();
  assert.deepEqual([empty.session.accountId, w.fake.spawns.at(-1).args], [null, PLAIN_ARGS]);
  await w.call('accounts:use', 'codex', id);
  assert.equal(empty.session.accountId, id, 'it is a new chat, so it starts on the account new chats use');
  assert.deepEqual(w.events(empty.sid).filter((e) => e.kind === 'meta' && 'accountId' in e).map((e) => e.accountId), [id], 'and the window is told');
  await until(() => w.fake.spawns.at(-1).options.env[KEY_VAR] === KEY && empty.session.lifecycle === 'ready', 4000, 'it to be warmed up again, on the key');
  await w.turn(empty, 'hello');
  const chatProcess = w.fake.alive().find((c) => c.threadId === empty.session.sessionId);
  await w.modelsList();
  const helperProcess = w.fake.alive().find((c) => c !== chatProcess && c.options.env[KEY_VAR] === KEY);
  assert.ok(chatProcess && helperProcess);

  // Replaced: neither the chat's process nor the helper goes on holding the old key.
  assert.deepEqual(await w.call('accounts:replace-key', 'codex', id, KEY2), { ok: true, id });
  await until(() => chatProcess.exited && helperProcess.exited, 4000, 'the processes that held the old key to go');
  await until(() => empty.session.lifecycle === 'ready' && !!empty.session.q, 4000, 'the chat to be back');
  assert.equal(w.fake.spawns.at(-1).options.env[KEY_VAR], KEY2);
  assert.deepEqual((await w.turn(empty, 'again')).filter((e) => e.kind === 'error'), []);
  await w.modelsList();
  assert.ok(w.fake.alive().every((c) => c.options.env[KEY_VAR] !== KEY), 'no process holds the key that was replaced');
  for (const secret of [KEY, KEY2, 'NOT-A-REAL-KEY']) assert.ok(!w.everything().includes(secret));
});

// ---- when OpenAI refuses the key ----

test('OpenAI refusing a chat on a pasted key puts the key in doubt, not Codex’s login: OpenAI’s word on the key settles it', { timeout: 60000 }, async () => {
  const w = wire({ holdTurns: true });
  await w.call('accounts:refresh', true);
  const { id } = await w.call('accounts:add-key', 'codex', KEY);
  await w.call('accounts:use', 'codex', id);
  const r = await w.open();
  const child = () => w.fake.alive().find((c) => c.turn);
  const refuse = async (text) => {
    assert.equal(r.session.send(text).ok, true);
    await until(() => child(), 3000, 'the turn to start');
    // What Codex sends when OpenAI will not take a key (seen on a real app-server): the request failing with a 401.
    const error = { message: 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-********7Hq2.', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null };
    const c = child();
    c.note('error', { error, willRetry: false, threadId: c.threadId, turnId: c.turn.id });
    c.completeTurn('failed', { error });
    await until(() => w.events(r.sid).at(-1)?.kind === 'busy' && w.events(r.sid).at(-1).busy === false, 3000, 'the turn to fail');
  };

  // OpenAI says the key is fine when asked (the refusal was about something else): nothing is marked.
  const asked = w.asked.length;
  await refuse('hello');
  await until(() => w.asked.length === asked + 1, 3000, 'OpenAI to be asked about the key');
  await sleep(30);
  assert.deepEqual([w.row(id).state, w.row('codex-default').state], ['ok', 'ok']);
  // OpenAI says it does not know the key: it is marked, and Codex's own login is not.
  w.openai = () => answer(401);
  await refuse('hello again');
  await until(() => w.row(id).state === 'invalid-key', 3000, 'the key to be marked');
  assert.equal(w.row('codex-default').state, 'ok', 'Codex’s login was never in play');
  assert.deepEqual(w.codexSignIn.view().canSignIn, false, 'and no sign-in to Codex is offered for it');
  assert.equal(w.accounts.engines.codex.known().state, 'ok');
  assert.deepEqual((await w.modelsList()).codex, { installed: true, signedIn: false, method: 'apiKey' }, 'Settings > Models says OpenAI’s models cannot start');
  assert.deepEqual([w.fake.sent('account/login/start').length, w.fake.sent('account/logout').length], [0, 0]);
  // A new chat on it does not start, and does not start on Codex's login either.
  const spawned = w.fake.spawns.length;
  const next = await w.open();
  const err = (await w.turn(next, 'hello')).find((e) => e.kind === 'error');
  assert.deepEqual([err.code, err.message, w.fake.spawns.length], ['account-invalid-key', 'The key for API key ••••7Hq2 no longer works.', spawned]);
  // A reply on the chat that is still running says the key works after all: OpenAI is asked, and the mark goes.
  w.openai = () => answer(200);
  w.fake.holdTurns = false;
  assert.deepEqual((await w.turn(r, 'once more')).filter((e) => e.kind === 'error'), []);
  await until(() => w.row(id).state === 'ok', 3000, 'the mark to clear');
  assert.ok(w.asked.every((c) => new URL(c.url).host === 'api.openai.com'));
  for (const secret of [KEY, 'NOT-A-REAL-KEY']) assert.ok(!w.everything().includes(secret));
});

test('a chat on Codex’s own login still speaks for that login, with a key listed beside it', { timeout: 60000 }, async () => {
  const w = wire({ holdTurns: true });
  await w.call('accounts:refresh', true);
  const { id } = await w.call('accounts:add-key', 'codex', KEY);
  const r = await w.open();           // nothing chosen: on the login
  assert.equal(r.session.send('hello').ok, true);
  await until(() => w.fake.alive().some((c) => c.turn), 3000, 'the turn to start');
  const c = w.fake.alive().find((x) => x.turn);
  const error = { message: 'Your access token could not be refreshed. Please sign in again.', codexErrorInfo: 'unauthorized', additionalDetails: null };
  c.note('error', { error, willRetry: false, threadId: c.threadId, turnId: c.turn.id });
  c.completeTurn('failed', { error });
  await until(() => w.row('codex-default').state === 'expired', 3000, 'Codex’s login to be marked');
  assert.equal(w.row(id).state, 'ok', 'the key was not what OpenAI refused');
  assert.equal(w.asked.length, 1, 'and nothing more was asked about it than when it was added');
});

// ---- Settings > Models ----

test('the status line for OpenAI’s models goes by the key while a key is in use, and by Codex’s login otherwise', { timeout: 60000 }, async () => {
  const w = wire({ account: null });      // Codex is here with nobody signed in
  await w.call('accounts:refresh', true);
  assert.deepEqual(await w.modelsList(), { openai: [], codex: { installed: true, signedIn: false, method: null } });
  assert.equal(w.codexSignIn.view().canSignIn, true);
  // A key is all it takes to use OpenAI's models: Codex's own login stays signed out, and still offers its sign-in.
  const { id } = await w.call('accounts:add-key', 'codex', KEY);
  assert.equal(engineFor({ engine: 'codex', codexPath: '/fake/codex', signedIn: w.codexChats.canStart }), 'claude', 'a key that is only listed starts nothing: Codex is still signed out');
  await w.call('accounts:use', 'codex', id);
  // At once, before the model list has been read again: a new chat on an OpenAI model opens as a Codex chat.
  assert.deepEqual([w.codexChats.signedIn, w.codexChats.canStart], [false, true]);
  assert.equal(engineFor({ engine: 'codex', codexPath: '/fake/codex', signedIn: w.codexChats.canStart }), 'codex');
  const list = await w.modelsList();
  assert.deepEqual(list.codex, { installed: true, signedIn: true, method: 'apiKey' });
  assert.ok(list.openai.length > 0, 'the picker has OpenAI’s models');
  assert.equal(w.codexSignIn.view().canSignIn, true, 'Codex’s own sign-in is still Codex’s, and still offered on its row');
  const r = await w.open();
  assert.equal(engineOf(r.session), 'codex');
  assert.deepEqual((await w.turn(r, 'hello')).filter((e) => e.kind === 'error'), []);
  assert.equal(w.fake.spawns.at(-1).options.env[KEY_VAR], KEY);
  // Removed: back to what Codex says of itself.
  await w.call('accounts:remove', 'codex', id);
  assert.deepEqual(await w.modelsList(), { openai: [], codex: { installed: true, signedIn: false, method: null } });
  assert.equal(w.codexChats.canStart, false);
});

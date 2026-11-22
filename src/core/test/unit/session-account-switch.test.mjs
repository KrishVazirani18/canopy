// Switching accounts, seen from the chats: a switch is for new chats, so a chat with a conversation keeps the
// account it started on and a chat nobody has used yet moves; a chat says which account it is on once, when its
// first turn starts; and a replaced key reaches the chats on its account. Driven by the scripted fake of the
// SDK's query() (fake-query.mjs) and the real registry over made-up accounts: no claude process, no login, no key
// that is a key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { chatAccountLine, moveUnusedChats, restartChatsOn } from '../../../account-actions.mjs';
import { createFake } from '../fake-query.mjs';
import { core, watch, within } from '../helpers.mjs';

const S = await core('session.mjs');
const A = await core('accounts.mjs');
const C = await core('accounts-claude.mjs');
const missing = S.__missing ? `session.mjs: ${S.__missing}` : A.__missing ? `accounts.mjs: ${A.__missing}` : C.__missing ? `accounts-claude.mjs: ${C.__missing}` : false;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-session-switch-'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SHELL = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/Users/someone', ANTHROPIC_BASE_URL: 'https://proxy.example', MY_VAR: 'kept' });
const KEY = 'sk-ant-api03-NOT-A-REAL-KEY-0123456789abcdefghijklmnop-4f2a';
const KEY2 = 'sk-ant-api03-NOT-A-REAL-KEY-0123456789abcdefghijklmnop-9z9z';
const CONSOLE = { id: 'claude-default', engine: 'claude', kind: 'console', email: 'me@example.com', state: 'ok' };
const KEYED = { id: 'claude-key-1', engine: 'claude', kind: 'key', keyHint: '4f2a', state: 'ok' };

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ }
  }
});
function make(opts = {}, script = {}) {
  const fake = createFake(script);
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: { ...SHELL }, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const turn = async ({ s, w }, text = 'hi') => { const from = w.mark(); s.send(text); await w.waitFor('turn-end', { ms: 5000, from }); await idle(w, from); };
const said = (w, from = 0) => w.all((e) => e.kind === 'notice' && (e.code === 'account' || e.code === 'api-key-billing'), from).map((e) => [e.code, e.text]);
const settle = () => new Promise((r) => setTimeout(r, 30));

// The app as main.mjs wires it: a registry with Claude Code's own login and one pasted key, chats that launch
// through it for the account they are on, and the line a chat says about its account.
function app({ active = null, keys = { 'claude-key-1': KEY }, lastChat = {} } = {}) {
  const store = { chatAccount: { ...lastChat } };
  const reg = new A.Accounts({
    engines: { claude: C.claudeAccounts({ tool: () => ({ path: '/usr/bin/true', env: SHELL }) }) },
    load: () => ({ active: { claude: active }, list: [CONSOLE, KEYED] }), keyFor: (a) => keys[a.id] ?? null,
  });
  const line = chatAccountLine({ accounts: reg, load: () => store.chatAccount, save: (v) => { store.chatAccount = v; } });
  const chats = [];
  const chat = (opts = {}, script = {}) => {
    const c = make({
      env: () => reg.envFor('claude', { account: c.s.accountId }), account: reg.pin('claude'),
      accountNotice: (reported, id) => line('claude', id, reported), ...opts,
    }, script);
    chats.push(c);
    return c;
  };
  const use = (id) => { reg.setActive('claude', id); return moveUnusedChats(chats.map((c) => c.s), reg.pin('claude')); };
  return { reg, store, keys, chats, chat, use };
}

// ---- what a chat says about its account ----

test('a chat says which account it is on once, when its first turn starts, not when it is opened', { skip: missing }, async () => {
  const asked = [];
  const c = make({ account: 'claude-key-1', accountNotice: (reported, id) => { asked.push([reported, id]); return 'This chat uses API key ••••4f2a.'; } });
  await c.s.warm();
  await c.w.waitFor('meta', { ms: 5000 });
  await settle();
  assert.deepEqual([said(c.w), asked], [[], []], 'opened and warmed up, but not used: nothing is said');

  await turn(c, 'one');
  assert.deepEqual(said(c.w), [['account', 'This chat uses API key ••••4f2a.']]);
  assert.deepEqual(asked, [[{ apiKeySource: '/login managed key' }, 'claude-key-1']], 'the host is told what Claude Code reported and which account the chat is on');
  const line = c.w.find((e) => e.kind === 'notice' && e.code === 'account');
  const reply = c.w.find((e) => e.kind === 'assistant-text' || e.kind === 'text-delta');
  assert.ok(reply && c.w.indexOf(line) < c.w.indexOf(reply), 'before the reply it is about');
  assert.ok(!('level' in line), 'a quiet line, not a warning');

  await turn(c, 'two');
  await c.s.stop();
  await turn(c, 'three');   // a new process for the same chat
  assert.equal(c.fake.starts, 2);
  assert.deepEqual([said(c.w).length, asked.length], [1, 1], 'once per chat, not once per turn or per process');
});

test('a host with nothing to say says nothing, and one that fails does not take the chat with it', { skip: missing }, async () => {
  for (const answer of [null, undefined, '', 7, { text: 'x' }]) {
    const c = make({ accountNotice: () => answer });
    await turn(c);
    assert.deepEqual(said(c.w), [], String(answer));
  }
  let calls = 0;
  const c = make({ accountNotice: () => { calls += 1; throw new Error('boom'); } });
  await turn(c);
  await turn(c);
  assert.deepEqual([said(c.w), calls, c.w.of('turn-end').length], [[], 1, 2]);
});

test('with a host that names accounts, the old "billed to an API key" line is its to say or not', { skip: missing }, async () => {
  // Claude Code reports a key from the environment, both when it starts and when a turn does.
  const onKey = {
    controls: { initializationResult() { return { account: { email: null, apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }, models: [], commands: [], capabilities: this.capabilities, current_permission_mode: this.mode }; } },
    onStart(run) { const init = run.init.bind(run); run.init = (extra) => init({ apiKeySource: 'ANTHROPIC_API_KEY', ...extra }); },
  };
  const asked = [];
  const quiet = make({ accountNotice: (reported) => { asked.push(reported); return null; } }, onKey);
  await turn(quiet);
  assert.deepEqual(said(quiet.w), []);
  assert.deepEqual(asked, [{ apiKeySource: 'ANTHROPIC_API_KEY' }]);
  // Without such a host (Session on its own), the first chat of a run on a key still says it, once.
  const first = make({}, onKey);
  await turn(first);
  assert.deepEqual(said(first.w), [['api-key-billing', 'This conversation is billed to an API key, not your Claude plan.']]);
  const second = make({}, onKey);
  await turn(second);
  assert.deepEqual(said(second.w), []);
});

// ---- the line itself ----

test('the line is said when a chat starts on another account than the chat before it, and the first chat ever says it only on a key', { skip: missing }, () => {
  const names = { 'claude-default': { id: 'claude-default', label: 'Max', kind: 'plan' }, 'claude-key-1': { id: 'claude-key-1', label: 'Work key', kind: 'key' }, 'claude-env': { id: 'claude-env', label: 'Amazon Bedrock', kind: 'external' } };
  const fresh = (last = undefined) => {
    const store = { last };
    const accounts = { asFound: 'claude-default', named(engine, account) { return engine === 'claude' ? names[account ?? this.asFound] ?? null : null; } };
    return { store, accounts, line: chatAccountLine({ accounts, load: () => store.last, save: (v) => { store.last = v; } }) };
  };

  // Nothing remembered: Claude Code's own sign-in is nothing to remark on; a key or the environment is.
  let t = fresh();
  assert.equal(t.line('claude', null), null);
  assert.deepEqual(t.store.last, { claude: 'claude-default' }, 'but it is remembered, to compare the next chat with');
  assert.equal(fresh().line('claude', 'claude-key-1'), 'This chat uses Work key.');
  t = fresh();
  t.accounts.asFound = 'claude-env';
  assert.equal(t.line('claude', null), 'This chat uses Amazon Bedrock.');

  // A switch is said once, in the first chat on the new account, and again when switching back.
  t = fresh({ claude: 'claude-default' });
  assert.equal(t.line('claude', null), null);
  assert.equal(t.line('claude', 'claude-default'), null, 'chosen or found, it is the same account');
  assert.equal(t.line('claude', 'claude-key-1'), 'This chat uses Work key.');
  assert.equal(t.line('claude', 'claude-key-1'), null);
  assert.equal(t.line('claude', 'claude-key-1'), null);
  assert.equal(t.line('claude', null), 'This chat uses Max.');
  assert.deepEqual(t.store.last, { claude: 'claude-default' });
  // Kept across restarts: the same account tomorrow says nothing.
  assert.equal(chatAccountLine({ accounts: t.accounts, load: () => t.store.last, save: () => {} })('claude', null), null);
  // Another engine's last chat is its own business.
  t = fresh({ codex: 'codex-default', other: 7 });
  assert.equal(t.line('claude', 'claude-key-1'), 'This chat uses Work key.');
  assert.deepEqual(t.store.last, { codex: 'codex-default', other: 7, claude: 'claude-key-1' });
});

test('a Codex chat says the line the same way, and its first of all only on a key pasted into Canopy', { skip: missing }, () => {
  // `reported.provider` is what a Codex chat's process was started on: Canopy's own provider for a pasted key, none
  // for the login Codex holds (which can itself be a key: Codex's session still says its older line for that one).
  const names = { 'codex-default': { id: 'codex-default', label: 'API key', kind: 'key' }, 'codex-key-1': { id: 'codex-key-1', label: 'API key ••••7Hq2', kind: 'key' } };
  const fresh = (last = undefined) => {
    const store = { last };
    const accounts = { named: (engine, account) => (engine === 'codex' ? names[account ?? 'codex-default'] ?? null : null) };
    return { store, line: chatAccountLine({ accounts, load: () => store.last, save: (v) => { store.last = v; } }) };
  };
  const OWN = { provider: null }, PASTED = { provider: 'canopy-openai' };
  // Nothing remembered, on Codex's own login: nothing is said, even though that login is a key. It is remembered.
  let t = fresh();
  assert.equal(t.line('codex', null, OWN), null);
  assert.deepEqual(t.store.last, { codex: 'codex-default' });
  assert.equal(fresh().line('codex', null), null, 'nothing reported: the same');
  // Nothing remembered, on a pasted key: said.
  assert.equal(fresh().line('codex', 'codex-key-1', PASTED), 'This chat uses API key ••••7Hq2.');
  // A switch is said once each way, as for Claude.
  t = fresh({ codex: 'codex-default', claude: 'claude-default' });
  assert.equal(t.line('codex', null, OWN), null);
  assert.equal(t.line('codex', 'codex-key-1', PASTED), 'This chat uses API key ••••7Hq2.');
  assert.equal(t.line('codex', 'codex-key-1', PASTED), null);
  assert.equal(t.line('codex', null, OWN), 'This chat uses API key.', 'back on the key Codex holds itself');
  assert.deepEqual(t.store.last, { codex: 'codex-default', claude: 'claude-default' }, 'Claude’s last chat is its own business');
  // The rule for Claude's first chat is unchanged by any of this.
  const claude = chatAccountLine({ accounts: { named: () => ({ id: 'claude-key-1', label: 'Work key', kind: 'key' }) }, load: () => null, save: () => {} });
  assert.equal(claude('claude', 'claude-key-1'), 'This chat uses Work key.');
});

test('when Canopy cannot name a chat’s login, it says what Claude Code reported, as before accounts: once per run, on a key', { skip: missing }, () => {
  const line = chatAccountLine({ accounts: { named: () => null }, load: () => null, save: () => { throw new Error('nothing to save'); } });
  assert.equal(line('claude', null, { apiKeySource: '/login managed key' }), null);
  assert.equal(line('claude', null, {}), null);
  assert.equal(line('claude', null), null);
  assert.equal(line('claude', null, { apiKeySource: 'ANTHROPIC_API_KEY' }), 'This conversation is billed to an API key, not your Claude plan.');
  assert.equal(line('claude', null, { apiKeySource: 'apiKeyHelper' }), null, 'once');
  // Storage that fails, or holds junk, never breaks a chat: at worst the line is said again.
  const names = { named: () => ({ id: 'k', label: 'Work key', kind: 'key' }) };
  for (const load of [() => { throw new Error('disk'); }, () => 'junk', () => [], () => ({ claude: 7 })]) {
    assert.equal(chatAccountLine({ accounts: names, load, save: () => { throw new Error('disk'); } })('claude', 'k'), 'This chat uses Work key.');
  }
  assert.equal(chatAccountLine({ accounts: { named: () => { throw new Error('boom'); } } })('claude', 'k'), null);
  assert.equal(chatAccountLine()('claude', 'k'), null);
});

// ---- a switch is for new chats ----

test('a chat nobody has used yet moves to the account chosen; it starts there, and says so', { skip: missing }, async () => {
  const { chat, use, store } = app({ lastChat: { claude: 'claude-default' } });
  const fresh = chat();            // opened, never warmed
  const warmed = chat();           // opened and warmed up on the login Claude Code found
  await warmed.s.warm();
  await warmed.w.waitFor('meta', { ms: 5000 });
  assert.ok(!('ANTHROPIC_API_KEY' in warmed.fake.current.options.env));

  const mark = warmed.w.mark();
  assert.deepEqual([fresh.s.snapshot().accountId, warmed.s.snapshot().accountId], [null, null], 'a chat says which account it is on to whoever shows it');
  assert.equal(use('claude-key-1'), 2);
  assert.deepEqual([fresh.s.accountId, warmed.s.accountId], ['claude-key-1', 'claude-key-1']);
  assert.equal(fresh.fake.starts, 0, 'a chat that was not running is not started by a switch');
  // Whoever shows the chat is told it moved, running or not: a window goes by the chat's account to say whether it can send.
  for (const c of [fresh, warmed]) {
    assert.deepEqual(c.w.all((e) => e.kind === 'meta' && 'accountId' in e).map((e) => e.accountId), ['claude-key-1']);
    assert.deepEqual([c.s.snapshot().accountId, c.s.snapshot().meta.accountId], ['claude-key-1', 'claude-key-1']);
  }
  // The warmed one was running on the old account: that process goes, and one on the new account takes its place.
  const stopped = await warmed.w.waitFor('stopped', { ms: 5000, from: mark });
  assert.deepEqual([stopped.reason, stopped.willRestart, stopped.why], ['restart', true, 'account']);
  const second = await warmed.fake.run(2);
  assert.equal(second.options.env.ANTHROPIC_API_KEY, KEY);
  assert.ok(!('ANTHROPIC_BASE_URL' in second.options.env), 'the key goes to Anthropic, never to the shell’s proxy');
  assert.deepEqual(said(warmed.w), [], 'still nothing said: nobody has used it');

  await turn(warmed);
  assert.deepEqual(said(warmed.w), [['account', 'This chat uses API key ••••4f2a.']]);
  assert.equal(warmed.fake.starts, 2);
  await turn(fresh);
  assert.equal(fresh.fake.current.options.env.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(said(fresh.w), [], 'the chat before it was on the same account');
  assert.deepEqual(store.chatAccount, { claude: 'claude-key-1' });
});

test('a chat with a conversation keeps the account it started on, whatever is chosen later', { skip: missing }, async () => {
  const { chat, use, reg } = app({ lastChat: { claude: 'claude-default' } });
  const used = chat();
  await turn(used);
  const resumed = chat({ resume: '11111111-2222-4333-8444-555555555555' });   // reopened from history: its conversation is on disk
  const busy = chat();
  await busy.s.warm();
  const letGo = (await busy.fake.run(1)).hold();
  busy.s.send('working on it');
  await busy.w.waitFor('text-delta', { ms: 5000 });

  assert.equal(use('claude-key-1'), 0);
  for (const c of [used, resumed, busy]) {
    assert.equal(c.s.accountId, null);
    assert.equal(c.s.snapshot().accountId, null);
    assert.deepEqual(c.w.all((e) => e.kind === 'meta' && 'accountId' in e), [], 'and nothing is said about its account: it has not changed');
  }
  assert.equal(reg.pin('claude'), 'claude-key-1');
  letGo();
  await idle(busy.w);
  await turn(used, 'again');
  await turn(busy, 'and again');
  await used.s.stop();
  await turn(used, 'after a restart');
  for (const c of [used, busy]) {
    for (const run of c.fake.runs) assert.ok(!('ANTHROPIC_API_KEY' in run.options.env), 'every process of it ran on the login it started on');
    assert.deepEqual(said(c.w), []);
  }
  assert.deepEqual([used.fake.starts, busy.fake.starts], [2, 1], 'and the switch restarted nothing');
  // A new chat is on the key, and is the one that says so.
  const next = chat();
  await turn(next);
  assert.equal(next.fake.current.options.env.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(said(next.w), [['account', 'This chat uses API key ••••4f2a.']]);
  // Switching back: the open chat on the key keeps the key, and the next new chat says where it is.
  use(null);
  await turn(next, 'still here');
  assert.equal(next.fake.current.options.env.ANTHROPIC_API_KEY, KEY);
  const back = chat();
  await turn(back);
  assert.ok(!('ANTHROPIC_API_KEY' in back.fake.current.options.env));
  assert.deepEqual(said(back.w), [['account', 'This chat uses Console.']]);
});

test('moveAccount moves only a chat with nothing in it', { skip: missing }, async () => {
  const blank = make();
  assert.equal(blank.s.moveAccount(null), false, 'already there');
  assert.equal(blank.s.moveAccount(''), false);
  assert.equal(blank.s.moveAccount('a'), true);
  assert.equal(blank.s.moveAccount('a'), false);
  assert.equal(blank.s.moveAccount(7), true, 'anything that is not a name is "as Claude Code finds it"');
  assert.deepEqual([blank.s.accountId, blank.fake.starts], [null, 0]);

  const waiting = make({}, { auto: false });   // a message sent that Claude Code has not started on yet
  waiting.s.send('first');
  await waiting.fake.run(1);
  assert.equal(waiting.s.moveAccount('a'), false);

  const parked = make();
  await parked.s.stop({ park: true });         // open in the terminal view
  assert.equal(parked.s.moveAccount('a'), false);

  const closed = make();
  closed.s.close();
  assert.equal(closed.s.moveAccount('a'), false);

  const failed = make({ env: () => { throw Object.assign(new Error('signed out'), { canopy: { code: 'account-signed-out', message: 'Max is signed out.', recoverable: false } }); } });
  assert.equal(failed.s.send('hello').ok, false);   // its account could not start it: the message came back
  assert.equal(failed.s.moveAccount('a'), true, 'a chat that never got going is still a new chat');
  for (const c of [waiting, parked, closed]) assert.equal(c.s.accountId, null);
});

test('moveUnusedChats leaves OpenAI chats and anything that is not a chat alone', { skip: missing }, () => {
  const moved = [];
  const claude = { moveAccount: (a) => { moved.push(a); return true; } };
  const settled = { moveAccount: () => false };
  const codex = { engine: 'codex', moveAccount: (a) => { moved.push(`codex:${a}`); return true; } };
  const broken = { moveAccount: () => { throw new Error('boom'); } };
  assert.equal(moveUnusedChats([claude, settled, codex, broken, null, {}, claude], 'k'), 2);
  assert.deepEqual(moved, ['k', 'k'], 'a Codex chat has no Claude account to move to');
  assert.equal(moveUnusedChats(undefined, 'k'), 0);
  assert.equal(moveUnusedChats(null, null), 0);
  // The same for a switch between Codex's accounts: only Codex's chats are looked at, and Claude's are left alone.
  moved.length = 0;
  assert.equal(moveUnusedChats([claude, settled, codex, broken, null, {}, codex, { engine: 'codex', moveAccount: () => false }], 'codex-key-1', 'codex'), 2);
  assert.deepEqual(moved, ['codex:codex-key-1', 'codex:codex-key-1']);
  assert.equal(moveUnusedChats([claude, codex], null, 'gemini'), 0);
});

// ---- a replaced key ----

test('a replaced key reaches the chats on its account: idle ones start again now, a working one after its turn', { skip: missing }, async () => {
  const { chat, keys } = app({ active: 'claude-key-1', lastChat: { claude: 'claude-key-1' } });
  const idleChat = chat();
  await turn(idleChat);
  const working = chat();
  await working.s.warm();
  const letGo = (await working.fake.run(1)).hold();
  working.s.send('long job');
  await working.w.waitFor('text-delta', { ms: 5000 });
  const never = chat();                                   // on the account, but nothing is running
  const other = chat({ account: null });                  // a chat on Claude Code's own login
  await turn(other);
  for (const c of [idleChat, working]) assert.equal(c.fake.current.options.env.ANTHROPIC_API_KEY, KEY);

  keys['claude-key-1'] = KEY2;
  const sessions = [idleChat, working, never, other].map((c) => c.s);
  assert.equal(restartChatsOn([...sessions, { engine: 'codex', accountId: 'claude-key-1', recycle() { throw new Error('not a Claude chat'); } }, null], 'claude-key-1'), 3);

  const again = await idleChat.fake.run(2);
  assert.equal(again.options.env.ANTHROPIC_API_KEY, KEY2, 'the idle chat is on the new key at once');
  assert.equal(again.options.resume, idleChat.s.sessionId, 'and it is the same conversation');
  assert.equal(idleChat.s.accountId, 'claude-key-1', 'on the same account');
  assert.equal(working.fake.starts, 1, 'a reply in flight is not cut off');
  letGo();
  await idle(working.w);
  assert.equal((await working.fake.run(2)).options.env.ANTHROPIC_API_KEY, KEY2, 'it starts again once its turn is over');
  assert.deepEqual([never.fake.starts, other.fake.starts], [0, 1], 'a chat with no process, and a chat on another account, are left alone');
  await turn(idleChat, 'carry on');
  assert.deepEqual(said(idleChat.w), [], 'the account did not change, so nothing is said');

  assert.equal(restartChatsOn(sessions, null), 0);
  assert.equal(restartChatsOn(sessions, ''), 0);
  assert.equal(restartChatsOn(undefined, 'claude-key-1'), 0);
  // A Codex key replaced: the Codex chats on that account, and nobody else's.
  const told = [];
  const codexChat = (accountId) => ({ engine: 'codex', accountId, recycle: (why) => { told.push([accountId, why]); return Promise.resolve(true); } });
  const claudeOnSameName = { accountId: 'codex-key-1', recycle() { throw new Error('not a Codex chat'); } };
  assert.equal(restartChatsOn([codexChat('codex-key-1'), codexChat(null), codexChat('codex-key-2'), claudeOnSameName, codexChat('codex-key-1'), { engine: 'codex', accountId: 'codex-key-1' }], 'codex-key-1', 'codex'), 2);
  assert.deepEqual(told, [['codex-key-1', 'account'], ['codex-key-1', 'account']]);
  assert.equal(restartChatsOn([{ engine: 'codex', accountId: 'codex-key-1', recycle: () => Promise.reject(new Error('boom')) }, { engine: 'codex', accountId: 'codex-key-1', recycle() { throw new Error('boom'); } }], 'codex-key-1', 'codex'), 2, 'one chat’s trouble is not another’s');
});

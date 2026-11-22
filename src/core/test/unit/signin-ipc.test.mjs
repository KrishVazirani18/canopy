// signin-ipc.mjs: when Canopy asks the tools about a login again, what an open chat does once a login is back, and
// the sign-in as the window drives it. `handle`, `on` and `send` are stand-ins for main's; the registry is the real
// one, asking a function instead of Claude Code; the terminal is a fake that records. No `claude` is run at all,
// so no login is touched and nothing is ever signed in or out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Accounts } from '../../accounts.mjs';
import { claudeAccounts } from '../../accounts-claude.mjs';
import { codexAccounts } from '../../accounts-codex.mjs';
import { registerSignIn } from '../../../signin-ipc.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-signin-ipc-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;
const dir = (name = `d${++seq}`) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };

const ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: os.homedir(), ANTHROPIC_API_KEY: 'sk-shell-key-0001', CLAUDE_CODE_OAUTH_TOKEN: 'shell-oauth-token-0003' });
const HOME_DIR = path.join(os.homedir(), '.claude');
const IN = Object.freeze({ loggedIn: true, method: 'claude.ai', provider: 'firstParty', subscriptionType: 'max', email: 'me@example.com', org: 'Acme', orgId: 'o1', configDir: HOME_DIR });
const OUT = Object.freeze({ loggedIn: false });
const SILENT = Object.freeze({ loggedIn: null });
const saved = (state = 'ok', more = {}) => ({ v: 1, active: { claude: null, codex: null }, list: [{ id: 'claude-default', engine: 'claude', kind: 'plan', dir: null, email: 'me@example.com', plan: 'max', addedAt: 1, lastOkAt: 1, state, ...more }] });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, label = 'condition') => { for (let i = 0; i < 400; i++) { if (ok()) return; await tick(5); } assert.fail(`timed out waiting for ${label}`); };

function fakeTerminal() {
  const made = [];
  const spawn = (file, args, opts) => {
    const p = {
      file, args, opts, wrote: [], kills: [], data: null, exit: null,
      onData(cb) { p.data = cb; }, onExit(cb) { p.exit = cb; },
      write(d) { p.wrote.push(d); }, resize() {}, kill(sig) { p.kills.push(sig ?? 'SIGHUP'); },
      says(text) { p.data?.(text); }, ends(exitCode) { p.exit?.({ exitCode }); },
    };
    made.push(p);
    return p;
  };
  return { spawn, made, get last() { return made.at(-1); } };
}

// A chat, as far as this file looks at one.
function chat(over = {}) {
  const did = [];
  return { accountId: null, q: null, working: false, closed: false, parked: false, did,
    recycle(why) { did.push(`recycle:${why}`); }, stop() { did.push('stop'); }, warm() { did.push('warm'); }, ...over };
}

function wire({ state = saved(), answer = IN, codex = null, tool: where, ...host } = {}) {
  const clock = { t: 1_000_000 };
  const box = { answer, asked: 0, state, envChecks: 0 };
  const tool = where ?? { path: '/opt/fake/claude', env: ENV };
  const channels = new Map(), listeners = new Map(), sent = [], logs = [], opened = [];
  const term = fakeTerminal();
  const accounts = new Accounts({
    engines: {
      claude: claudeAccounts({ tool: () => tool, ask: async () => { box.asked += 1; return typeof box.answer === 'function' ? box.answer() : box.answer; } }),
      ...(codex && { codex: codexAccounts(codex) }),
    },
    load: () => box.state, save: (s) => { box.state = s; }, now: () => clock.t,
    onChange: (view) => sent.push(['accounts:changed', view]),
  });
  const chats = { all: [], shown: [] };
  const signIn = registerSignIn((channel, fn) => channels.set(channel, fn), {
    accounts, claude: () => tool, spawn: term.spawn,
    on: (channel, fn) => listeners.set(channel, fn),
    send: (channel, ...args) => sent.push([channel, ...args]),
    sessions: () => chats,
    recheck: async () => { box.envChecks += 1; },
    openFile: async (file) => { opened.push({ file, text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777, dirMode: fs.statSync(path.dirname(file)).mode & 0o777 }); return host.openError ?? ''; },
    tmp: () => root,
    onFocus: (fn) => { host.hooks && (host.hooks.focus = fn); }, onPageGone: (fn) => { host.hooks && (host.hooks.gone = fn); },
    log: (m) => logs.push(m), now: () => clock.t,
    ask: async () => { box.asked += 1; return typeof box.answer === 'function' ? box.answer() : box.answer; },
    ...host.extra,
  });
  const call = (channel, ...args) => channels.get(channel)(...args);
  const states = () => sent.filter(([c]) => c === 'signin:state').map(([, s]) => s);
  const stateOf = (id = 'claude-default') => accounts.view().list.find((a) => a.id === id)?.state ?? null;
  return { signIn, accounts, channels, listeners, sent, logs, opened, term, chats, clock, box, tool, call, states, stateOf };
}

// ---- what the window can reach ----

test('the window gets a sign-in it can start, type into and close, and nothing that names a folder', async () => {
  const { channels, listeners, call, term, states } = wire({ state: saved('signed-out') });
  // Nothing here chooses an account: "Use <account>" beside a login that is gone is the accounts' own switch
  // (`accounts:use`, account-actions.test.mjs), which never moves to one that could not start a chat.
  assert.deepEqual([...channels.keys()].sort(), ['signin:attach', 'signin:begin', 'signin:cancel', 'signin:check', 'signin:start-check', 'signin:terminal']);
  assert.deepEqual([...listeners.keys()].sort(), ['signin:input', 'signin:resize']);

  // Whatever else the window sends along, the sign-in is for the listed account, in its own folder.
  const r = await call('signin:begin', { engine: 'claude', accountId: 'claude-default', dir: dir('evil'), console: true, sso: true, email: 'someone-else@example.com', label: 'Nope' });
  assert.deepEqual(Object.keys(r).sort(), ['id', 'ok']);
  assert.deepEqual([states().at(-1).phase, states().at(-1).label, states().at(-1).console], ['ready', 'Max', false]);
  assert.deepEqual(await call('signin:attach', r.id, 90, 22, { console: true, dir: '/tmp/evil' }), { ok: true });
  assert.deepEqual(term.last.args, ['auth', 'login', '--email', 'me@example.com']);
  assert.ok(!('CLAUDE_CONFIG_DIR' in term.last.opts.env), 'Claude Code’s own folder');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES']) assert.ok(!(k in term.last.opts.env), `${k} reached the sign-in`);
  await call('signin:cancel', r.id);

  for (const bad of [undefined, null, {}, { engine: 'codex', accountId: 'codex-default' }, { engine: 'Claude' }, 'claude']) {
    const no = await call('signin:begin', bad);
    assert.deepEqual([no.ok, no.code], [false, 'unsupported'], JSON.stringify(bad));
  }
  assert.equal((await call('signin:begin', { engine: 'claude', accountId: 'not-listed' })).code, 'account-missing');
  // No account named: Claude Code's own login, which may still be a plan or the Console.
  const own = await call('signin:begin', { engine: 'claude', accountId: 7 });
  assert.equal(own.ok, true);
  assert.deepEqual([states().at(-1).account, states().at(-1).canSwitch], [null, true]);
  await call('signin:attach', own.id, 80, 24, { console: true });
  assert.deepEqual(term.last.args, ['auth', 'login', '--console']);
});

test('signing in from the window: typing and output only pass through, and a confirmed sign-in clears "signed out" everywhere', async () => {
  const { accounts, call, listeners, term, sent, logs, states, stateOf, box, chats } = wire({ state: saved('signed-out'), answer: OUT });
  await accounts.refresh();
  assert.equal(stateOf(), 'signed-out');

  // Chats open while it was signed out: on screen with a process, on screen held back, in the background (idle,
  // and working), an OpenAI chat, and one on another account.
  const front = chat({ q: {} }), held = chat(), back = chat({ q: {} }), busy = chat({ q: {}, working: true });
  const openai = chat({ q: {}, engine: 'codex' }), other = chat({ q: {}, accountId: 'claude-other' }), shut = chat({ q: {}, closed: true });
  chats.all = [front, held, back, busy, openai, other, shut];
  chats.shown = [front, held];

  const r = await call('signin:begin', { engine: 'claude', accountId: 'claude-default' });
  await call('signin:attach', r.id, 80, 24);
  term.last.says('Paste code here if prompted > ');
  listeners.get('signin:input')(r.id, 'PASTED-CODE-9f8e7d6c');
  listeners.get('signin:resize')(r.id, 100, 30);
  assert.deepEqual(sent.filter(([c]) => c === 'signin:data'), [['signin:data', r.id, 'Paste code here if prompted > ']]);
  assert.deepEqual(term.last.wrote, ['PASTED-CODE-9f8e7d6c']);

  box.answer = IN; // Claude Code's sign-in worked
  const asked = box.asked;
  term.last.ends(0);
  await until(() => states().at(-1).phase === 'done', 'the sign-in to be confirmed');
  assert.equal(stateOf(), 'ok', 'the registry is updated from what Claude Code says');
  assert.deepEqual(states().at(-1).who, { label: 'Max', email: 'me@example.com' });
  assert.equal(box.envChecks, 1, 'the app’s own check runs again, so nothing goes on saying signed out');
  assert.ok(box.asked > asked);
  assert.deepEqual(sent.filter(([c]) => c === 'accounts:changed').at(-1)[1].list[0].state, 'ok', 'and the window hears it');

  assert.deepEqual(front.did, ['recycle:sign-in'], 'the chat on screen starts again on the login');
  assert.deepEqual(held.did, ['warm'], 'one that was held back starts now');
  assert.deepEqual(back.did, ['stop'], 'one in the background starts on its next message, not all at once');
  for (const c of [busy, openai, other, shut]) assert.deepEqual(c.did, [], 'left alone');

  const everything = JSON.stringify(sent.filter(([c]) => c !== 'signin:data')) + logs.join('\n');
  assert.ok(!everything.includes('PASTED-CODE') && !everything.includes('Paste code here'), 'terminal text is in no log and no other message');
  assert.ok(!logs.join('\n').includes('me@example.com'));
  assert.ok(!JSON.stringify(box.state).includes('PASTED-CODE'), 'and never saved');
});

// ---- noticing ----

test('a turn that could not sign in makes Canopy ask Claude Code first: one refused request signs nobody out', async () => {
  const { signIn, accounts, stateOf, box, clock } = wire({ answer: IN });
  await accounts.refresh();
  const asks = async (ev, entry = { engine: 'claude' }) => { const n = box.asked; signIn.chatEvent(ev, entry); await accounts.queue; return box.asked - n; };

  // Claude Code still says it is signed in: nothing flips.
  assert.equal(await asks({ kind: 'turn-end', isError: true, errorCode: 'auth' }), 1);
  assert.equal(stateOf(), 'ok');
  // The same failed turn says it three ways: asked once.
  assert.equal(await asks({ kind: 'notice', code: 'api-error', apiError: 'authentication_failed' }), 0);
  assert.equal(await asks({ kind: 'notice', code: 'auth', text: 'Sign-in problem: expired' }), 0);

  // Claude Code could not say: still nobody is signed out.
  clock.t += 11_000;
  box.answer = SILENT;
  assert.equal(await asks({ kind: 'notice', code: 'auth' }), 1);
  assert.equal(stateOf(), 'ok', 'unknown is never signed out');

  // Claude Code says so itself: now it is.
  clock.t += 11_000;
  box.answer = OUT;
  assert.equal(await asks({ kind: 'notice', code: 'api-error', apiError: 'authentication_failed' }), 1);
  assert.equal(stateOf(), 'signed-out');

  // Nothing else asks: other failures, other notices, an OpenAI chat.
  clock.t += 11_000;
  for (const ev of [{ kind: 'turn-end', isError: true, errorCode: 'rate-limit' }, { kind: 'turn-end', errorCode: null }, { kind: 'notice', code: 'api-error', apiError: 'overloaded' }, { kind: 'error', code: 'auth' }, null, undefined]) {
    assert.equal(await asks(ev), 0, JSON.stringify(ev));
  }
  assert.equal(await asks({ kind: 'turn-end', isError: true, errorCode: 'auth' }, { engine: 'codex' }), 0);
});

test('a chat whose login is known to be gone is not started ahead of its first message', async () => {
  const { signIn, accounts, box } = wire({ state: saved('ok') });
  const mine = { accountId: null };
  assert.equal(signIn.canWarm(mine), true);
  box.answer = OUT;
  await accounts.refresh();
  assert.equal(signIn.canWarm(mine), false, 'the login Claude Code finds on its own is signed out');
  assert.equal(signIn.canWarm({ accountId: null, engine: 'codex' }), true, 'an OpenAI chat is not Claude’s business');
  assert.equal(signIn.canWarm({ accountId: 'not-listed' }), true, 'not known: starting it says why');
  assert.equal(signIn.canWarm(null), true);
  box.answer = SILENT;
  await accounts.refresh();
  assert.equal(signIn.canWarm(mine), false, 'could-not-check changes nothing');

  // "Could not check" on its own never holds a chat back, and each state that needs you does.
  for (const [state, ok] of [['unknown', true], ['ok', true], ['signed-out', false], ['expired', false], ['mismatch', false], ['missing', false], ['locked', false], ['invalid-key', false], ['blocked', false]]) {
    const w = wire({ state: { v: 1, active: { claude: 'chosen' }, list: [{ id: 'chosen', engine: 'claude', kind: 'plan', dir: null, state }] } });
    assert.equal(w.signIn.canWarm({ accountId: 'chosen' }), ok, state);
  }
  // Nothing known at all (first launch): chats start as they always did, unless the launch's own check found
  // Claude Code signed out (it never worked here, so it is not listed; an OpenAI login let the app open anyway).
  assert.equal(wire({ state: null }).signIn.canWarm(mine), true);
  assert.equal(wire({ state: null, extra: { auth: () => SILENT } }).signIn.canWarm(mine), true, 'not known is not signed out');
  assert.equal(wire({ state: null, extra: { auth: () => OUT } }).signIn.canWarm(mine), false);
  assert.equal(wire({ state: null, extra: { auth: () => OUT } }).signIn.canWarm({ accountId: 'not-listed' }), true);
  assert.equal(wire({ state: null, extra: { auth: () => { throw new Error('boom'); } } }).signIn.canWarm(mine), true);
});

test('coming back to the window asks again: rarely when all is well, at once when a login needs you', async () => {
  const hooks = {};
  const { accounts, box, clock, stateOf, chats, tool } = wire({ hooks, answer: IN });
  const asks = async () => { const n = box.asked; hooks.focus(); await accounts.queue; await tick(); return box.asked - n; };
  await accounts.refresh();

  assert.equal(await asks(), 0, 'just checked');
  clock.t += 9 * 60_000;
  assert.equal(await asks(), 0, 'under ten minutes');
  clock.t += 2 * 60_000;
  assert.equal(await asks(), 1, 'over ten minutes since the last check');
  assert.equal(await asks(), 0);

  // It turns out to be signed out. From then on, coming back is likely "I fixed it": asked after a few seconds.
  clock.t += 11 * 60_000;
  box.answer = OUT;
  assert.equal(await asks(), 1);
  assert.equal(stateOf(), 'signed-out');
  clock.t += 2_000;
  assert.equal(await asks(), 0, 'not on every flick between windows');
  const front = chat();
  chats.all = [front]; chats.shown = [front];
  clock.t += 4_000;
  box.answer = IN; // signed in again in Terminal, outside Canopy
  assert.equal(await asks(), 1);
  assert.equal(stateOf(), 'ok');
  assert.deepEqual(front.did, ['warm'], 'the chat on screen picks the login up');

  // Never before Canopy knows where Claude Code is.
  clock.t += 11 * 60_000;
  tool.path = null;
  assert.equal(await asks(), 0);
});

test('closing the terminal view asks again, in case you signed in or out there', async () => {
  const { signIn, accounts, box, stateOf } = wire({ answer: IN });
  await accounts.refresh();
  const asks = async (fn) => { const n = box.asked; fn(); await accounts.queue; return box.asked - n; };
  assert.equal(await asks(() => signIn.terminalClosed()), 0, 'no terminal was open');
  box.answer = OUT; // /logout, typed in the terminal view
  assert.equal(await asks(() => { signIn.terminalOpened(); signIn.terminalClosed(); }), 1);
  assert.equal(stateOf(), 'signed-out');
  assert.equal(await asks(() => signIn.terminalClosed()), 0, 'once per terminal');
});

// ---- the first screen ----

test('whether any login ever worked is known without waiting, except on a first launch that finds Claude signed out', async () => {
  const ever = async (opts) => (await wire(opts).signIn.atInit()).everSignedIn;
  assert.equal(await ever({ state: saved('signed-out'), extra: { auth: () => OUT } }), true, 'it worked before: signed out is something to fix, not a stop');
  assert.equal(await ever({ state: null, extra: { auth: () => IN } }), false, 'nothing saved yet, and nothing to wait for');
  assert.equal(await ever({ state: null, extra: { auth: () => SILENT } }), false);
  assert.equal(await ever({ state: null, answer: OUT, extra: { auth: () => OUT } }), false, 'Claude Code is signed out and there is no other login');
  assert.equal(await ever({ state: { v: 1, active: {}, list: [{ id: 'claude-default', engine: 'claude', kind: 'plan', state: 'signed-out' }] }, answer: OUT, extra: { auth: () => OUT } }), false, 'listed, but it never worked');

  // First launch, Claude Code signed out, but Codex is signed in: the launch's check finds that, and it counts.
  const codex = { installed: () => true, env: () => ENV, account: async () => { await tick(30); return { ok: true, signedIn: true, requiresAuth: true, account: { type: 'chatgpt', email: 'me@example.com', plan: 'plus' } }; } };
  const started = Date.now();
  assert.equal(await ever({ state: null, answer: OUT, codex, extra: { auth: () => OUT } }), true);
  assert.ok(Date.now() - started < 2_000);
  // A Codex that never answers does not hold the first screen for long.
  const stuck = { installed: () => true, env: () => ENV, account: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.equal(await ever({ state: null, answer: OUT, codex: stuck, extra: { auth: () => OUT, initWaitMs: 80 } }), false);
  assert.ok(Date.now() - t0 >= 70 && Date.now() - t0 < 2_000, 'it waits, but not for long');
});

test('the window’s question at launch waits for the launch’s check and is "first" only once', async () => {
  let ready = null;
  const { call, accounts, box } = wire({ state: saved('ok'), answer: OUT, extra: { ready: () => new Promise((r) => { ready = r; }) } });
  const asking = call('signin:start-check');
  await tick(10);
  assert.equal(box.asked, 0, 'not before the environment check is in');
  ready();
  const a = await asking;
  assert.equal(a.first, true);
  assert.equal(a.accounts.list[0].state, 'signed-out', 'the answer is the settled list');
  assert.deepEqual(a.accounts, accounts.view());
  const asked = box.asked;
  ready = null;
  const again = call('signin:start-check');
  await until(() => ready, 'the second question');
  ready();
  assert.equal((await again).first, false, 'a reloaded window does not show the prompt again');
  assert.equal(box.asked, asked, 'and the tools are not asked twice in a row');
});

// ---- Terminal, the main process's own sign-ins, and endings ----

test('Open in Terminal instead: a script only this user can read, with no token in it, deleted afterwards', async () => {
  const hooks = {};
  const { signIn, call, term, opened, states, box, stateOf } = wire({ hooks, state: saved('signed-out'), answer: OUT });
  const r = await call('signin:begin', { engine: 'claude', accountId: 'claude-default' });
  await call('signin:attach', r.id, 80, 24);
  assert.deepEqual(await call('signin:terminal', r.id), { ok: true });
  assert.deepEqual(term.last.kills, ['SIGHUP']);
  assert.equal(opened.length, 1);
  const { file, text, mode, dirMode } = opened[0];
  assert.equal(path.basename(file), 'Sign in to Claude Code.command');
  assert.ok(path.dirname(file).startsWith(path.join(root, 'canopy-signin-')));
  assert.deepEqual([mode, dirMode], [0o700, 0o700]);
  assert.ok(text.startsWith('#!/bin/sh\n') && text.includes("exec '/opt/fake/claude' 'auth' 'login' '--email' 'me@example.com'"));
  assert.ok(!text.includes('sk-shell-key-0001') && !text.includes('shell-oauth-token-0003'));
  assert.equal(states().at(-1).phase, 'terminal');

  // Back in the window after signing in there: Claude Code is asked, and it counts like any other sign-in.
  box.answer = IN;
  hooks.focus();
  await until(() => states().at(-1).phase === 'done', 'the Terminal sign-in to be confirmed');
  assert.equal(stateOf(), 'ok');
  assert.ok(fs.existsSync(file), 'Terminal may still be reading it');
  signIn.stop();
  await until(() => !fs.existsSync(path.dirname(file)), 'the script to be deleted');

  // Terminal would not open: the script does not stay behind, and the sign-in in the window carries on.
  const b = wire({ state: saved('signed-out'), openError: 'No application knows how to open this file.' });
  const r2 = await b.call('signin:begin', { engine: 'claude', accountId: 'claude-default' });
  await b.call('signin:attach', r2.id, 80, 24);
  assert.deepEqual(await b.call('signin:terminal', r2.id), { ok: false, message: 'Terminal couldn’t be opened.' });
  assert.equal(b.states().at(-1).phase, 'running');
  assert.deepEqual(b.term.last.kills, []);
  b.signIn.stop();
  await until(() => !fs.existsSync(path.dirname(b.opened[0].file)), 'the unused script to be deleted');
  assert.deepEqual(b.term.last.kills, ['SIGHUP'], 'quitting stops a sign-in that is still running');
});

test('the main process can sign in to a folder that is not listed yet, and is told how it ended', async () => {
  const folder = dir();
  const { signIn, call, term, states, box, chats } = wire({ answer: () => ({ ...IN, subscriptionType: 'pro', email: 'second@example.com', configDir: folder }) });
  const front = chat({ q: {} });
  chats.all = [front]; chats.shown = [front];
  const done = signIn.signIn({ dir: folder, console: false, label: 'Second plan' });
  assert.deepEqual([states().at(-1).phase, states().at(-1).label, states().at(-1).account, states().at(-1).canSwitch], ['ready', 'Second plan', null, false], 'the window is told to show it');
  await call('signin:attach', states().at(-1).id, 80, 24);
  assert.equal(term.last.opts.env.CLAUDE_CONFIG_DIR, folder);
  assert.deepEqual(term.last.args, ['auth', 'login']);
  term.last.ends(0);
  assert.deepEqual(await done, { ok: true, accountId: null, dir: folder, who: { kind: 'plan', email: 'second@example.com', org: 'Acme', orgId: 'o1', plan: 'pro' } });
  assert.deepEqual(states().at(-1).who, { label: 'Pro', email: 'second@example.com' });
  assert.deepEqual(front.did, [], 'no chat is on an account that is not listed yet');
  assert.equal(box.envChecks, 1);

  // Refused before anything opens: the answer says why, and nothing ran.
  assert.deepEqual(await signIn.signIn({ dir: path.join(root, 'not-there') }), { ok: false, code: 'account-missing', message: 'The folder for this account is missing.' });
  const busy = signIn.signIn({ dir: folder });
  assert.equal((await signIn.signIn({ dir: folder })).code, 'busy');
  signIn.stop();
  assert.equal((await busy).code, 'cancelled');
});

test('a reload, a crashed page and quitting all stop a sign-in that is running', async () => {
  const hooks = {};
  const { call, term, states } = wire({ hooks, state: saved('signed-out') });
  const r = await call('signin:begin', { engine: 'claude', accountId: 'claude-default' });
  await call('signin:attach', r.id, 80, 24);
  hooks.gone();
  assert.deepEqual(term.last.kills, ['SIGHUP']);
  assert.equal(states().at(-1).phase, 'closed');
  hooks.gone(); // nothing open: nothing to stop
  assert.equal((await call('signin:begin', { engine: 'claude', accountId: 'claude-default' })).ok, true, 'the reloaded window can start over');
});

// ---- the registry's own answer to "which account is that?" ----

test('the registry hands the host one account, folder and all, and never its own copy', () => {
  const folder = dir();
  const { accounts } = wire({ state: { v: 1, active: { claude: null }, list: [
    { id: 'claude-default', engine: 'claude', kind: 'console', dir: null, email: 'me@example.com', state: 'ok', lastOkAt: 5 },
    { id: 'extra', engine: 'claude', kind: 'plan', dir: folder, email: 'two@example.com', state: 'signed-out' },
  ] } });
  assert.deepEqual([accounts.get('claude', 'extra').dir, accounts.get('claude', 'extra').state], [folder, 'signed-out']);
  assert.equal(accounts.get('claude').id, 'claude-default', 'no id: the one Claude Code finds on its own');
  assert.equal(accounts.get('claude', null).lastOkAt, 5);
  assert.equal(accounts.get('claude', 'nobody'), null);
  assert.equal(accounts.get('codex', 'extra'), null, 'an engine only answers for its own');
  accounts.get('claude', 'extra').state = 'ok';
  assert.equal(accounts.get('claude', 'extra').state, 'signed-out', 'a copy: changing it changes nothing');
});

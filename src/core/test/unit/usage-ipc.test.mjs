// usage-ipc.mjs: the Usage tab as main.mjs wires it. The registry is the real one over stand-in engines, the chats
// are stand-ins for what the ChatHost holds, the transcripts are real files in a throwaway folder, and the process
// that would be started to ask Claude Code is a function that records how it was called. No tool is run, no login
// is asked anything, and nothing outside the throwaway folder is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Accounts } from '../../accounts.mjs';
import { claudeAccounts } from '../../accounts-claude.mjs';
import { AFTER_TURN_MS } from '../../usage.mjs';
import { dayActivity } from '../../../day-activity.mjs';
import { registerUsage } from '../../../usage-ipc.mjs';
import { limitOffer } from '../../../../renderer/src/lib/account-rules.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-usage-ipc-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

const SHELL = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/Users/someone', ANTHROPIC_API_KEY: 'sk-shell-secret-value', ANTHROPIC_BASE_URL: 'https://proxy.example', MY_TOOL_TOKEN: 'shell-secret-token' });
const SETTINGS_ENV = Object.freeze({ ...SHELL, DISABLE_AUTOUPDATER: '1' }); // the shell's, plus what settings.json adds: what main hands the model check too
const entry = (over) => ({ id: 'claude-default', engine: 'claude', kind: 'plan', dir: null, label: null, email: 'me@example.com', org: 'Acme', orgId: 'o1', plan: 'max', via: null, keyHint: null, addedAt: 1, lastOkAt: 1, state: 'ok', why: null, ...over });
const CONSOLE = entry({ kind: 'console', plan: null });
const ENV_KEY = entry({ id: 'claude-env', kind: 'external', via: 'ANTHROPIC_API_KEY', email: null, plan: null });
const CODEX_KEY = { id: 'codex-default', engine: 'codex', kind: 'key', dir: null, label: null, email: null, plan: null, state: 'ok', addedAt: 1, lastOkAt: 1 };
const CODEX_PLAN = { ...CODEX_KEY, kind: 'plan', email: 'me@example.com', plan: 'pro' };
const MAX = { subscriptionType: 'max', rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: 34, resets_at: '2026-11-16T23:40:00.000Z' }, seven_day: { utilization: 12, resets_at: null } } };
const CODEX_LIMITS = { rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: null, credits: null, planType: 'pro', rateLimitReachedType: null }, rateLimitsByLimitId: null };

// A chat as the ChatHost holds it: enough of Session / CodexSession for what this file asks of one.
const chat = (over = {}) => ({ closed: false, q: {}, cwd: '/Users/someone/app', sessionId: null, accountId: null, usageAnswer: async () => ({ ok: true, usage: MAX }), ...over });

function wire({ list = [CONSOLE], active = {}, state = {}, at = new Date(2026, 10, 16, 12).getTime() } = {}) {
  const dir = path.join(root, `w${++seq}`);
  const proj = path.join(dir, 'projects', '-Users-someone-app');
  fs.mkdirSync(proj, { recursive: true });
  const t = { now: at, channels: new Map(), sent: [], logs: [], drift: [], probes: [], timers: [], state, chats: { current: null, live: [] }, claudePath: '/fake/claude', ready: 0, totals: [], loads: 0 };
  const codexEngine = { ids: ['codex-default'], base: () => ({ PATH: '/usr/bin' }), detect: async () => ({ known: false }), launchEnv: (a, base) => ({ ...base }), asFound: (l) => l.find((a) => a.id === 'codex-default')?.id ?? null, label: (a) => (a.kind === 'plan' ? 'ChatGPT Pro' : 'API key'), agrees: () => null };
  const accounts = new Accounts({
    engines: { claude: claudeAccounts({ tool: () => ({ path: t.claudePath, env: SHELL }), ask: async () => null }), codex: codexEngine },
    load: () => ({ active, list }), save: () => {},
  });
  const host = {
    get current() { return t.chats.current ? { session: t.chats.current, sid: 'sid-1' } : null; },
    liveOn: (engine, test) => t.chats.live.find((s) => !s.closed && s.q && (s.engine === 'codex' ? 'codex' : 'claude') === engine && test(s)) ?? null,
  };
  const wired = registerUsage((channel, fn) => t.channels.set(channel, fn), {
    accounts, chats: () => host, ready: async () => { t.ready += 1; },
    claude: {
      query: 'the-sdk-query', path: () => t.claudePath, env: () => SETTINGS_ENV, version: '3.2.1', home: () => '/Users/someone', configDir: () => dir,
      probe: async (args) => { t.probes.push(args); if (t.probeAnswer instanceof Error) throw t.probeAnswer; return t.probeAnswer ?? { supported: true, usage: MAX }; },
    },
    codex: { limits: async () => { t.helper = (t.helper ?? 0) + 1; return t.codexAnswer ?? { ok: true, limits: CODEX_LIMITS }; } },
    totals: async (sessionId, cwd) => { t.totals.push([sessionId, cwd]); return { cost: 0.31, workMs: 5 }; },
    load: () => { t.loads += 1; return t.state.usage ?? null; }, save: (s) => { t.state.usage = s; },
    loadSpend: () => { t.loads += 1; return t.state.accountSpend ?? null; }, saveSpend: (s) => { t.state.accountSpend = s; },
    send: (channel, payload) => t.sent.push([channel, payload]), log: (m) => t.logs.push(m), onDrift: (label, keys) => t.drift.push([label, keys]),
    now: () => t.now, timers: { set: (fn, ms) => { const h = { fn, at: t.now + ms }; t.timers.push(h); return h; }, clear: (h) => { t.timers = t.timers.filter((x) => x !== h); } },
  });
  // One reply of `millions` million input tokens on Opus 5.5 ($4 a million), landing `minutes` after today's midnight.
  const midnight = new Date(at); midnight.setHours(0, 0, 0, 0);
  const reply = (chatId, id, minutes, millions = 1) => {
    const file = path.join(proj, `${chatId}.jsonl`);
    const when = midnight.getTime() + minutes * 60_000;
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(when).toISOString(), message: { id, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [], usage: { input_tokens: millions * 1_000_000, output_tokens: 0 } } }) + '\n');
    fs.utimesSync(file, when / 1000, when / 1000);
  };
  const view = () => wired.usage.view();
  // A count reads real files, so "landed" is waited for rather than assumed.
  const landed = async () => { await flush(); for (let i = 0; i < 400 && view().sections.some((s) => s.loading); i++) await new Promise((r) => setTimeout(r, 5)); await flush(); };
  const call = async (channel, ...args) => { const r = await t.channels.get(channel)(...args); await landed(); return r; };
  const advance = async (by) => { t.now += by; for (const h of t.timers.filter((x) => x.at <= t.now)) { t.timers = t.timers.filter((x) => x !== h); h.fn(); } await flush(); };
  return { ...wired, t, accounts, dir, midnight: midnight.getTime(), reply, call, view, advance };
}

test('the window gets three calls, none of which chooses an account, and hears changes on one channel', async () => {
  const { t, call } = wire();
  assert.deepEqual([...t.channels.keys()].sort(), ['usage:get', 'usage:refresh', 'usage:watch']);
  assert.deepEqual([t.loads, t.ready, t.sent, t.timers], [0, 0, [], []], 'wiring it up reads nothing, asks nothing and starts nothing');
  const v = await call('usage:get', { open: true });
  assert.equal(t.ready, 1, 'the first read waits for the environment check rather than answering with nothing');
  assert.deepEqual(v.sections.map((s) => [s.engine, s.shape, s.account.label]), [['claude', 'spend', 'Console']]);
  assert.ok(t.sent.length > 0 && t.sent.every(([channel]) => channel === 'usage:changed'));
  assert.deepEqual(await call('usage:watch', false), { ok: true });
  // Anything but the two engines' names is no engine at all.
  for (const bad of ['x', null, 5, { engine: 'claude' }, '__proto__']) assert.ok(Array.isArray((await call('usage:refresh', bad)).sections));
  const everything = JSON.stringify([v, t.sent, t.state]) + t.logs.join('\n');
  for (const secret of ['sk-shell-secret-value', 'shell-secret-token', 'proxy.example']) assert.ok(!everything.includes(secret), 'what is in the launch environment stays there');
  assert.ok(!t.logs.join('\n').includes('me@example.com'), 'the log names accounts by id, never by email');
});

test('today’s Console login: spend counted from the transcripts, the same number as Home, and Claude Code is asked nothing', async () => {
  const { t, dir, midnight, reply, call, view } = wire();
  reply('chat-a', 'a1', 60, 0.25);
  reply('chat-a', 'a2', 90, 0.125);
  reply('from-the-terminal', 't1', 120, 0.0625);
  t.chats.current = chat({ sessionId: 'chat-a' });
  t.chats.live = [t.chats.current];
  await call('usage:get', { open: true });
  const s = view().sections[0];
  const home = await dayActivity({ since: midnight, now: t.now, configDir: dir });
  assert.equal(s.count.today, home.cost, 'with one account, Today is Home’s number');
  assert.deepEqual(s.count, { unit: 'usd', today: 1.75, month: 1.75, since: midnight, chat: 0.31 });
  assert.deepEqual(t.totals, [['chat-a', '/Users/someone/app']], '"This chat" is the chat on screen, as Stats counts it');
  assert.deepEqual([t.probes, s.error, s.loading], [[], null, false], 'no process is started and no chat is asked for a login that is billed per use');
  assert.deepEqual(t.state.accountSpend.days, { '2026-11-16': { 'claude-default': 1.75 } });
  // A Codex chat on screen instead: the Claude section has no "This chat".
  t.chats.current = chat({ engine: 'codex', sessionId: 'thread-1' });
  assert.equal(view().sections[0].count.chat, null);
});

test('a plan with a chat running on it: that chat is asked, and nothing is started', async () => {
  const { t, call, view } = wire({ list: [entry({})] });
  const asked = [];
  const onPlan = chat({ sessionId: 'chat-a', usageAnswer: async () => { asked.push('chat-a'); return { ok: true, usage: MAX }; } });
  const elsewhere = chat({ sessionId: 'chat-b', accountId: 'some-other-account', usageAnswer: async () => { asked.push('chat-b'); return { ok: true, usage: MAX }; } });
  t.chats.live = [elsewhere, onPlan];
  await call('usage:get', { open: true });
  assert.deepEqual(asked, ['chat-a'], 'the chat on the account in use, not one that was started on another');
  assert.deepEqual(t.probes, []);
  const s = view().sections[0];
  assert.deepEqual([s.shape, s.plan, s.windows.map((w) => [w.label, w.percent]), s.at], ['plan', 'max', [['Current session', 34], ['This week', 12]], t.now]);
});

test('a plan with no chat running: one process is started to ask, on that account’s own environment, as canopy, and never for another account', async () => {
  // Nothing chosen: Claude Code is launched as it stands, with the settings' variables the model check also gets.
  let w = wire({ list: [entry({})] });
  await w.call('usage:get', { open: true });
  assert.equal(w.t.probes.length, 1);
  assert.deepEqual(w.t.probes[0], { query: 'the-sdk-query', claudePath: '/fake/claude', env: SETTINGS_ENV, appVersion: '3.2.1', cwd: '/Users/someone' });
  assert.equal(JSON.stringify(w.t.probes[0].env), JSON.stringify(SETTINGS_ENV), 'key for key');
  assert.equal(w.view().sections[0].windows.length, 2);

  // The plan was chosen while a key sits in the shell: the process is launched without the key and without the proxy.
  w = wire({ list: [entry({}), ENV_KEY], active: { claude: 'claude-default' } });
  await w.call('usage:get', { open: true });
  assert.deepEqual(Object.keys(w.t.probes[0].env).sort(), ['DISABLE_AUTOUPDATER', 'HOME', 'MY_TOOL_TOKEN', 'PATH'], 'the plan answers for itself, not the key');

  // The chat that was asked cannot say, and by then another account is the one in use: nothing is started for the old one.
  w = wire({ list: [entry({}), ENV_KEY], active: { claude: 'claude-default' } });
  const accounts = w.accounts;
  w.t.chats.live = [chat({ accountId: 'claude-default', usageAnswer: async () => { accounts.setActive('claude', 'claude-env'); return { ok: false, code: 'timeout' }; } })];
  await w.call('usage:get', { open: true });
  assert.deepEqual(w.t.probes, [], 'a process would have come up on the other account and answered for the wrong one');
  assert.deepEqual(w.view().sections.map((s) => [s.account.id, s.shape]), [['claude-env', 'spend']]);

  // An account that cannot be launched, Claude Code missing, and a process that fails: "unavailable", and nothing else happens.
  w = wire({ list: [entry({})] });
  w.t.claudePath = null;
  await w.call('usage:get', { open: true });
  assert.deepEqual([w.t.probes, w.view().sections[0].error], [[], 'unavailable']);
  w = wire({ list: [entry({})] });
  w.t.probeAnswer = new Error('spawn failed');
  await w.call('usage:get', { open: true });
  assert.deepEqual([w.t.probes.length, w.view().sections[0].error], [1, 'unavailable']);
  // A Claude Code without the call: unavailable, and noted for whoever keeps Canopy current.
  w = wire({ list: [entry({})] });
  w.t.probeAnswer = { supported: false };
  await w.call('usage:get', { open: true });
  assert.deepEqual([w.view().sections[0].error, w.t.drift], ['unsupported', [['the usage call (missing from this Claude Code)', []]]]);
});

test('what chats report: limit updates fold in, a turn ending reads again, and both only for the account in use', async () => {
  const { t, call, view, limit, chatEvent, advance } = wire({ list: [entry({})] });
  const running = chat({ sessionId: 'chat-a' });
  t.chats.live = [running];
  await call('usage:get', { open: true });
  // As main passes it on from Session: the limit, and the account the chat was started on (none: whatever Claude Code finds).
  limit('claude', null, { status: 'allowed_warning', type: 'seven_day', utilization: 91, resetsAt: null });
  assert.deepEqual(view().sections[0].windows.map((w) => w.percent), [34, 91]);
  limit('claude', 'some-other-account', { status: 'rejected', type: 'five_hour', utilization: 100 });
  assert.deepEqual(view().sections[0].windows.map((w) => w.percent), [34, 91], 'a chat on another account says nothing here');
  // A turn ends in that chat: two seconds later it is asked again.
  let asked = 0;
  running.usageAnswer = async () => { asked += 1; return { ok: true, usage: { ...MAX, rateLimits: { ...MAX.rateLimits, five_hour: { utilization: 36, resets_at: null } } } }; };
  chatEvent({ kind: 'turn-end', sid: 'sid-1' }, { engine: 'claude', sessionId: 'chat-a' }, running);
  chatEvent({ kind: 'turn-end', sid: 'sid-9' }, { engine: 'claude', sessionId: 'chat-z' }, chat({ accountId: 'some-other-account' }));
  chatEvent({ kind: 'text-delta', sid: 'sid-1' }, { engine: 'claude' }, running);
  assert.equal(t.timers.length, 1);
  await advance(AFTER_TURN_MS);
  assert.deepEqual([asked, view().sections[0].windows[0].percent, t.probes.length], [1, 36, 0]);
  // With the tab gone, a turn ending starts nothing.
  await call('usage:watch', false);
  chatEvent({ kind: 'turn-end', sid: 'sid-1' }, { engine: 'claude', sessionId: 'chat-a' }, running);
  await advance(60_000);
  assert.equal(asked, 1);
  // Events that make no sense are survived.
  for (const bad of [[null, null, null], [{ kind: 'turn-end' }, null, null], [{ kind: 'init' }, {}, {}]]) chatEvent(...bad);
  limit('claude', null, null);
  limit('nonsense', null, {});
});

test('which account a chat ran on is written down as it starts, so its replies are counted for that account', async () => {
  const { t, reply, call, view, chatEvent, accounts } = wire({ list: [entry({ kind: 'console', plan: null }), ENV_KEY], active: { claude: 'claude-default' } });
  // With a key in the shell, "as Claude Code finds it" is the key. The Console sign-in was chosen, so new chats pin it.
  assert.equal(accounts.resolve('claude', null), 'claude-env');
  const pinned = chat({ sessionId: 'chat-console', accountId: 'claude-default' });
  const older = chat({ sessionId: 'chat-key', accountId: null }); // started before anything was chosen
  chatEvent({ kind: 'init', sessionId: 'chat-console' }, { engine: 'claude' }, pinned);
  chatEvent({ kind: 'init', sessionId: 'chat-key' }, { engine: 'claude' }, older);
  chatEvent({ kind: 'init', sessionId: 'chat-console' }, { engine: 'claude' }, pinned); // every turn says init again: written once
  assert.deepEqual(Object.keys(t.state.accountSpend.chats), ['chat-console'], 'only the chat that is not on the default login needs a note');
  // The chats were started at noon; their replies land in the half hour after, and the tab is opened at one.
  reply('chat-console', 'c1', 750, 0.5);
  reply('chat-key', 'k1', 751, 0.25);
  reply('from-the-terminal', 't1', 752, 0.125);
  t.now += 60 * 60_000;
  await call('usage:get', { open: true });
  assert.equal(view().sections[0].count.today, 2, 'the Console sign-in: only its own chat');
  assert.deepEqual(t.state.accountSpend.days['2026-11-16'], { 'claude-default': 2, 'claude-env': 1.5 });
});

test('Codex: an API key shows dollars worked out from the tokens Canopy counted; a plan shows its limits; neither asks about the other', async () => {
  // An API key (this Mac today): turns are counted as they end, priced at list prices, and Codex is asked nothing.
  let w = wire({ list: [CODEX_KEY] });
  const thread = chat({ engine: 'codex', sessionId: 'thread-1', rateLimits: async () => { throw new Error('never asked'); } });
  w.t.chats.current = thread;
  w.t.chats.live = [thread];
  const turn = (inputTokens, outputTokens, extra = {}) => ({ kind: 'turn-end', model: 'gpt-6.1-sol', turnUsage: { inputTokens, outputTokens, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0, thinkingTokens: 999, webSearchRequests: 3 }, ...extra });
  // gpt-6.1-sol: $2 a million in, $0.10 cached, $10 out. The first turn at standard speed, the second with Fast on (twice that).
  w.chatEvent(turn(2_000_000, 500_000), { engine: 'codex', sessionId: 'thread-1' }, thread);
  thread.tierFor = () => 'priority';
  w.chatEvent(turn(1_000_000, 100_000), { engine: 'codex', sessionId: 'thread-1' }, thread);
  w.chatEvent(turn(5_000_000, 5_000_000, { history: true }), { engine: 'codex', sessionId: 'thread-1' }, thread); // a replayed turn is not a new one
  w.chatEvent({ kind: 'turn-end', model: 'gpt-6.1-sol', turnUsage: null }, { engine: 'codex', sessionId: 'thread-1' }, thread);
  await w.call('usage:get', { open: true });
  let s = w.view().sections[0];
  const dollars = (c) => ({ ...c, today: +c.today.toFixed(6), month: +c.month.toFixed(6), chat: +c.chat.toFixed(6) });
  assert.deepEqual([s.engine, s.shape, dollars(s.count)], ['codex', 'spend', { unit: 'usd', today: 9.1 + 6.2, month: 9.1 + 6.2, since: w.midnight, chat: 9.1 + 6.2 }]);
  assert.equal(w.t.helper, undefined);
  // A model Canopy has no price for: its tokens are shown as tokens, and no dollars are made up for them.
  w.chatEvent(turn(200, 50, { model: 'gpt-7-nova' }), { engine: 'codex', sessionId: 'thread-1' }, thread);
  w.t.now += 11_000;
  await w.call('usage:get', {});
  s = w.view().sections[0];
  assert.deepEqual([+s.count.today.toFixed(6), s.count.unpriced], [15.3, { today: 1_000_250, month: 1_000_250, chat: 1_000_250, models: ['gpt-7-nova'] }]);
  // A ChatGPT plan: the running chat's own process is asked; with none, the shared helper.
  w = wire({ list: [CODEX_PLAN] });
  const planChat = chat({ engine: 'codex', sessionId: 'thread-2', rateLimits: async () => ({ ok: true, limits: CODEX_LIMITS }) });
  w.t.chats.live = [planChat];
  await w.call('usage:get', { open: true });
  s = w.view().sections[0];
  assert.deepEqual([s.shape, s.windows.map((x) => [x.label, x.percent]), w.t.helper], ['plan', [['Current window', 22]], undefined]);
  w.limit('codex', null, { limitId: 'codex', primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: null }, secondary: null });
  assert.equal(w.view().sections[0].windows[0].percent, 60);
  w = wire({ list: [CODEX_PLAN] });
  await w.call('usage:get', { open: true });
  assert.deepEqual([w.t.helper, w.view().sections[0].windows.length], [1, 1]);
  assert.deepEqual(w.t.probes, [], 'Claude Code is never started to answer for Codex');
});

test('Codex, a pasted key in use beside the plan’s login: each chat counts for the account it runs on, and the plan is not read meanwhile', async () => {
  const PASTED = { id: 'codex-key-1', engine: 'codex', kind: 'key', dir: null, keyHint: '9zQx', label: null, email: null, plan: null, state: 'ok', addedAt: 1, lastOkAt: 1 };
  const w = wire({ list: [CODEX_PLAN, PASTED], active: { codex: 'codex-key-1' } });
  const onKey = chat({ engine: 'codex', sessionId: 'thread-key', accountId: 'codex-key-1', rateLimits: async () => { throw new Error('a key has no limits to ask about'); } });
  // A chat that was open before the key was chosen: it keeps the plan's login.
  const onPlan = chat({ engine: 'codex', sessionId: 'thread-plan', accountId: null, rateLimits: async () => { throw new Error('not the account in use: never asked'); } });
  w.t.chats.current = onKey;
  w.t.chats.live = [onPlan, onKey];
  const turn = (inputTokens, outputTokens) => ({ kind: 'turn-end', model: 'gpt-6.1-sol', turnUsage: { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
  w.chatEvent(turn(2_000_000, 500_000), { engine: 'codex', sessionId: 'thread-key' }, onKey);
  w.chatEvent(turn(7_000_000, 0), { engine: 'codex', sessionId: 'thread-plan' }, onPlan);
  await w.call('usage:get', { open: true });
  let s = w.view().sections.find((x) => x.engine === 'codex');
  assert.deepEqual([s.account.id, s.shape, s.count], ['codex-key-1', 'spend', { unit: 'usd', today: 9, month: 9, since: w.midnight, chat: 9 }], 'the key’s own turns, without the plan chat’s');
  assert.equal(w.t.helper, undefined, 'nothing is asked of Codex about a plan that is not the account in use');
  // A limit update from the chat on the plan says nothing about the key.
  w.limit('codex', null, { limitId: 'codex', primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: null }, secondary: null });
  w.limit('codex', 'codex-key-1', { limitId: 'codex', primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: null }, secondary: null });
  assert.equal(w.view().sections.find((x) => x.engine === 'codex').shape, 'spend');
  // Back on Codex's own login: its plan's limits, read through the chat that is on it, and the tokens are the key's alone.
  w.accounts.setActive('codex', null);
  onPlan.rateLimits = async () => ({ ok: true, limits: CODEX_LIMITS });
  await w.call('usage:get', { open: true });
  s = w.view().sections.find((x) => x.engine === 'codex');
  assert.deepEqual([s.account.id, s.shape, s.windows.map((x) => x.percent), w.t.helper], ['codex-default', 'plan', [22], undefined]);
});

test('near a limit, the offer: only an account billed per use, switched to by the accounts’ own switch and never otherwise', async () => {
  const { t, accounts, call, view, limit } = wire({ list: [entry({}), ENV_KEY], active: { claude: 'claude-default' } });
  t.chats.live = [chat({ sessionId: 'chat-a', accountId: 'claude-default' })];
  // What the tab offers beside a window that is nearly full: the window's rule (account-rules.ts) over the registry's own list.
  const offered = () => { const s = view().sections[0]; const a = s.near ? limitOffer(accounts.view().list, s.engine, s.account.id) : null; return a ? { id: a.id, label: a.label } : null; };
  await call('usage:get', { open: true });
  assert.equal(offered(), null);
  limit('claude', 'claude-default', { status: 'allowed_warning', type: 'five_hour', utilization: 93, resetsAt: null });
  assert.deepEqual([view().sections[0].near.percent, offered()], [93, { id: 'claude-env', label: 'API key' }]);
  assert.ok(!('offer' in view().sections[0]), 'main names no account: it says which window is nearly full, and that is all');
  assert.equal(accounts.pin('claude'), 'claude-default', 'showing the offer switches nothing');
  // Taking it is the accounts' own switch (`accounts:use`, which ends here): nothing in Usage can choose an account.
  assert.deepEqual(accounts.setActive('claude', 'claude-env'), { ok: true });
  assert.equal(accounts.pin('claude'), 'claude-env', 'new chats use the key now');
  const after = await call('usage:get', { open: true });
  assert.deepEqual(after.sections.map((s) => [s.account.id, s.shape]), [['claude-env', 'spend']], 'and the tab shows the account in use: the key’s spend, not the plan’s limits');
  assert.equal(offered(), null);
  assert.ok(!JSON.stringify(t.state.usage).includes('Current session'), 'the plan’s numbers are not kept once it is not the account in use');
});

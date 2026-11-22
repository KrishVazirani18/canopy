// usage.mjs: what the Usage tab shows for the account in use. Reading the tools' answers (Claude Code's usage() and
// limit updates, Codex's account/rateLimits/read and its updates), the offer near a limit, how a read is made (a
// running chat first, a helper process else), and the tab's state: the cache, the timing, one read in flight.
// Every answer here is made up in the shape the tool gives; the clock, the timers and the chats are the test's.
// No tool is started and no login is asked anything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AFTER_TURN_MS, CLICK_FRESH_MS, COUNT_EVERY_MS, HOLD_MS, LIVE_EVERY_MS, NEAR_LIMIT, OPEN_FRESH_MS, PROBE_EVERY_MS, WATCH_LEASE_MS,
  Usage, claudeLimit, claudePlan, claudeSource, codexLimits, codexPlan, codexSource, nearLimit, percentOf,
} from '../../usage.mjs';
// What may be offered near a limit is the window's rule over the accounts list (plain TypeScript, run as it is).
import { limitOffer } from '../../../../renderer/src/lib/account-rules.ts';

const WEEK_END = '2026-11-22T07:00:00.000Z';
// usage() on a Max plan, as Session.usage() and probeUsage hand it on: the windows Claude Code's own screen shows,
// one per-model week, extra usage, and the code-named fields the real answer is full of.
const MAX = Object.freeze({
  subscriptionType: 'max', rateLimitsAvailable: true,
  rateLimits: {
    five_hour: { utilization: 34, resets_at: '2026-11-16T23:40:00.000Z' },
    seven_day: { utilization: 12, resets_at: WEEK_END },
    seven_day_oauth_apps: null, seven_day_opus: null,
    seven_day_sonnet: { utilization: 1, resets_at: WEEK_END },
    model_scoped: [{ display_name: 'Fable', utilization: 8, resets_at: WEEK_END }],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.68, currency: 'USD' },
    iguana_necktie: null, seven_day_cowork: { utilization: 0, resets_at: null }, seven_day_haiku: { utilization: 3.5, resets_at: WEEK_END },
    tangelo: { enabled: true }, 'Bad-Key': { utilization: 9, resets_at: null },
  },
});
const ms = (iso) => Date.parse(iso);
const win = (key, label, percent, resetsAt = ms(WEEK_END)) => ({ key, label, percent, resetsAt });

// ---- one scale ----

test('percentOf: a limit update’s 0-1 and usage()’s 0-100 come out the same, and the scale is never guessed', () => {
  assert.equal(percentOf(0.91, 'fraction'), 91);
  assert.equal(percentOf(91, 'percent'), 91);
  assert.equal(percentOf(1, 'percent'), 1, 'one percent on the 0-100 scale is one percent, not a full window');
  assert.equal(percentOf(1, 'fraction'), 100);
  assert.equal(percentOf(0.004, 'fraction'), 0.4);
  assert.deepEqual([percentOf(0, 'percent'), percentOf(0, 'fraction')], [0, 0]);
  assert.deepEqual([percentOf(104, 'percent'), percentOf(1.3, 'fraction')], [100, 100], 'over the limit is full');
  for (const bad of [null, undefined, '50', NaN, Infinity, -1, {}]) assert.equal(percentOf(bad, 'percent'), null);
});

// ---- Claude ----

test('claudePlan: a real-shaped answer becomes the windows Claude Code shows, in its order, with unknown ones drawn and noted', () => {
  const p = claudePlan(MAX);
  assert.equal(p.available, true);
  assert.equal(p.plan, 'max', 'the plan’s own name, for the label');
  assert.deepEqual(p.windows, [
    win('five_hour', 'Current session', 34, ms('2026-11-16T23:40:00.000Z')),
    win('seven_day', 'This week', 12),
    win('model:Fable', 'Fable this week', 8),
    win('seven_day_sonnet', 'Sonnet this week', 1),
    win('seven_day_haiku', 'Haiku this week', 3.5),
  ]);
  assert.deepEqual(p.unknown, ['seven_day_cowork', 'seven_day_haiku'], 'windows Canopy has no name for: noted whether or not they have been used yet');
  assert.deepEqual(p.extra, { enabled: true, percent: 24.68, used: 12.34, limit: 50, currency: 'USD' }, 'amounts arrive in cents');
  assert.ok(!JSON.stringify(p).includes('iguana') && !JSON.stringify(p).includes('tangelo') && !JSON.stringify(p).includes('Bad-Key'));
});

test('claudePlan: what is not a plan’s limits, and the edges of what is', () => {
  // A Console login, an API key and a cloud provider all answer like this; so does a plan login that may not read its profile.
  for (const none of [{ subscriptionType: null, rateLimitsAvailable: false, rateLimits: null }, { subscriptionType: 'max', rateLimitsAvailable: false, rateLimits: null },
    { subscriptionType: 'max', rateLimitsAvailable: true, rateLimits: null }, { subscriptionType: 'pro', rateLimitsAvailable: true, rateLimits: {} },
    { subscriptionType: 'pro', rateLimitsAvailable: true, rateLimits: { five_hour: null, seven_day: { utilization: null, resets_at: null } } }, null, undefined, 'x', []]) {
    assert.deepEqual(claudePlan(none), { available: false });
  }
  // A week at one percent is one percent. A window with no reset time, and one whose time cannot be read.
  const p = claudePlan({ subscriptionType: 'pro', rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 1, resets_at: 'soon' } } });
  assert.deepEqual(p.windows, [win('five_hour', 'Current session', 0, null), win('seven_day', 'This week', 1, null)]);
  assert.deepEqual([p.extra, p.unknown], [null, []]);
  // The server's per-model name wins over the older fixed window of the same model; a model without a name is skipped.
  const models = claudePlan({ subscriptionType: 'max', rateLimitsAvailable: true, rateLimits: {
    seven_day_opus: { utilization: 50, resets_at: null }, seven_day_sonnet: { utilization: 5, resets_at: null }, seven_day_oauth_apps: { utilization: 2, resets_at: null },
    model_scoped: [{ display_name: 'Opus', utilization: 51, resets_at: null }, { utilization: 9, resets_at: null }, { display_name: 'Fable', utilization: null, resets_at: null }, 'junk'],
  } });
  assert.deepEqual(models.windows.map((w) => [w.label, w.percent]), [['Opus this week', 51], ['Sonnet this week', 5], ['Connected apps this week', 2]]);
  assert.deepEqual(models.unknown, [], 'a window Claude Code’s own types list is not drift');
  // Extra usage: off, on with no limit set, another currency (yen have no cents), and a currency nobody knows.
  const extra = (e) => claudePlan({ subscriptionType: 'max', rateLimitsAvailable: true, rateLimits: { extra_usage: e } }).extra;
  assert.deepEqual(extra({ is_enabled: false, monthly_limit: null, used_credits: null, utilization: null }), { enabled: false, percent: null, used: null, limit: null, currency: 'USD' });
  assert.deepEqual(extra({ is_enabled: true, monthly_limit: null, used_credits: 250, utilization: null, currency: null }), { enabled: true, percent: null, used: 2.5, limit: null, currency: 'USD' });
  assert.deepEqual(extra({ is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24, currency: 'jpy' }), { enabled: true, percent: 24, used: 1200, limit: 5000, currency: 'JPY' });
  assert.deepEqual(extra({ is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24, currency: 'zz' }), { enabled: true, percent: 24, used: null, limit: null, currency: 'ZZ' }, 'no amount is drawn in a unit Canopy cannot be sure of');
});

test('claudeLimit: an update from a chat moves its own window, and only that', () => {
  const { available: _a, unknown: _u, ...report } = claudePlan(MAX);
  // As Session hands it on: the window by name, a percentage, times in ms.
  const next = claudeLimit(report, { status: 'allowed_warning', type: 'seven_day', utilization: 91, resetsAt: ms(WEEK_END) + 1000 });
  assert.deepEqual(next.windows[1], win('seven_day', 'This week', 91, ms(WEEK_END) + 1000));
  assert.deepEqual(next.windows.filter((_, i) => i !== 1), report.windows.filter((_, i) => i !== 1));
  assert.deepEqual(report.windows[1].percent, 12, 'the old report is not changed in place');
  assert.deepEqual([next.plan, next.extra], [report.plan, report.extra]);
  // Refused for being over the limit: full, even with no number. Seconds are read as seconds.
  const full = claudeLimit(report, { status: 'rejected', type: 'five_hour', utilization: null, resetsAt: 1900000000 });
  assert.deepEqual(full.windows[0], win('five_hour', 'Current session', 100, 1900000000000));
  // A window the report did not have yet takes its place in the order.
  const opus = claudeLimit(report, { status: 'allowed', type: 'seven_day_opus', utilization: 40, resetsAt: null });
  assert.deepEqual(opus.windows.map((w) => w.key), ['five_hour', 'seven_day', 'model:Fable', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_haiku']);
  // Nothing to say about a window the tab draws: the very same report comes back.
  for (const quiet of [{ status: 'allowed', type: 'overage', utilization: 50 }, { status: 'allowed', type: 'seven_day_overage_included', utilization: 50 }, { status: 'allowed', type: null, utilization: 50 },
    { status: 'allowed', type: 'seven_day', utilization: null, resetsAt: null }, { status: 'allowed', type: 'seven_day', utilization: 12, resetsAt: ms(WEEK_END) }, null, 'x']) {
    assert.equal(claudeLimit(report, quiet), report);
  }
  assert.equal(claudeLimit(null, { type: 'seven_day', utilization: 5 }), null);
});

// ---- Codex ----

// account/rateLimits/read on a ChatGPT plan, in the shape Codex 0.153.4's own schema gives.
const snapshot = (over = {}) => ({ limitId: 'codex', limitName: null, primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1795150800 },
  credits: { hasCredits: false, unlimited: false, balance: null }, individualLimit: null, spendControlReached: null, planType: 'pro', rateLimitReachedType: null, ...over });
const CODEX = Object.freeze({ rateLimits: snapshot(), rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null });

test('codexPlan: the two windows named by how long they are, other buckets once used, credits only when there are some', () => {
  assert.deepEqual(codexPlan(CODEX), { available: true, plan: 'pro', limitId: 'codex', credits: null, windows: [
    { key: 'primary', label: 'Current window', percent: 22, resetsAt: 1794805200000 }, { key: 'secondary', label: 'This week', percent: 9, resetsAt: 1795150800000 },
  ] });
  const label = (mins, slot = 'primary') => codexPlan({ rateLimits: snapshot({ primary: null, secondary: null, [slot]: { usedPercent: 1, windowDurationMins: mins, resetsAt: null } }) }).windows[0].label;
  assert.deepEqual([60, 300, 720, 1440, 4320, 10080, 43200, 1500, null].map((m) => label(m)), ['Current window', 'Current window', 'Current window', '1-day window', '3-day window', 'This week', 'This month', '25-hour window', 'Current window']);
  assert.equal(label(null, 'secondary'), 'Longer window');
  // A model with limits of its own is listed under its name once it has been used; the main bucket is not listed twice.
  const many = codexPlan({ rateLimits: snapshot(), rateLimitsByLimitId: {
    codex: snapshot(), codex_spark: snapshot({ limitId: 'codex_spark', limitName: 'GPT-6 Spark', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } }),
    unused: snapshot({ limitId: 'unused', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }, secondary: null }), 'bad id!': snapshot(), junk: 'x',
  } });
  assert.deepEqual(many.windows.map((w) => [w.key, w.label, w.percent]), [['primary', 'Current window', 22], ['secondary', 'This week', 9], ['codex_spark:primary', 'GPT-6 Spark · current window', 40]]);
  // Credits, as Codex words them. A balance is a string of Codex's own; no currency is put on it.
  assert.deepEqual(codexPlan({ rateLimits: snapshot({ credits: { hasCredits: true, unlimited: false, balance: '12.50' } }) }).credits, { unlimited: false, balance: '12.50' });
  assert.deepEqual(codexPlan({ rateLimits: snapshot({ primary: null, secondary: null, credits: { hasCredits: true, unlimited: true, balance: null } }) }), { available: true, plan: 'pro', limitId: 'codex', windows: [], credits: { unlimited: true, balance: null } });
  for (const none of [{ rateLimits: snapshot({ primary: null, secondary: null }) }, { rateLimits: null }, {}, null, 'x']) assert.deepEqual(codexPlan(none), { available: false });
});

test('codexLimits: updates are sparse, so what one leaves out stays as it was', () => {
  const { available: _a, ...report } = codexPlan(CODEX);
  const next = codexLimits(report, snapshot({ primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: null, credits: null, planType: null }));
  assert.deepEqual(next.windows, [{ key: 'primary', label: 'Current window', percent: 41, resetsAt: 1794805200000 }, report.windows[1]], 'the week is untouched by an update that does not mention it');
  assert.deepEqual([next.plan, next.credits], ['pro', null]);
  assert.equal(codexLimits(report, snapshot()), report, 'the same numbers again: the same report');
  assert.equal(codexLimits(report, snapshot({ limitId: null, primary: null, secondary: null })), report);
  // Another bucket’s update lands under its own name and never on the main windows; the main two stay first.
  const other = codexLimits(report, snapshot({ limitId: 'codex_spark', limitName: 'GPT-6 Spark', primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: null }, secondary: null }));
  assert.deepEqual(other.windows.map((w) => [w.key, w.percent]), [['primary', 22], ['secondary', 9], ['codex_spark:primary', 70]]);
  const late = codexLimits({ ...report, windows: [other.windows[2]] }, snapshot());
  assert.deepEqual(late.windows.map((w) => w.key), ['primary', 'secondary', 'codex_spark:primary']);
  assert.deepEqual(codexLimits(report, snapshot({ credits: { hasCredits: true, unlimited: false, balance: '3' } })).credits, { unlimited: false, balance: '3' });
  for (const bad of [null, 5, 'x', []]) assert.equal(codexLimits(report, bad), report);
});

// ---- near a limit ----

const acct = (over) => ({ id: 'claude-default', engine: 'claude', kind: 'plan', label: 'Max', email: 'me@example.com', org: null, plan: 'max', via: null, keyHint: null, state: 'ok', why: null, found: true, ...over });
const KEY = acct({ id: 'key-1', kind: 'key', label: 'API key ••••4f2a', email: null, plan: null, keyHint: '4f2a', found: false });
const CONSOLE = acct({ id: 'console-1', kind: 'console', label: 'Console', plan: null, found: false });
const OTHER_PLAN = acct({ id: 'plan-2', label: 'Pro', email: 'other@example.com', plan: 'pro', found: false });

test('nearLimit: the fullest window at 90% or more, and nothing below that', () => {
  assert.equal(NEAR_LIMIT, 90);
  const w = (percent, key = 'a') => ({ key, label: key.toUpperCase(), percent, resetsAt: null });
  assert.equal(nearLimit([w(89.9), w(12, 'b')]), null);
  assert.deepEqual(nearLimit([w(90)]), { key: 'a', label: 'A', percent: 90 });
  assert.deepEqual(nearLimit([w(91), w(100, 'b'), w(95, 'c')]), { key: 'b', label: 'B', percent: 100 });
  for (const none of [[], null, undefined, 'x', [null, {}]]) assert.equal(nearLimit(none), null);
  // A window read as nearly full whose reset time has since passed has started over: it is not "near a limit" any more.
  const now = 1_800_000_000_000;
  const reset = (percent, resetsAt, key = 'a') => ({ ...w(percent, key), resetsAt });
  assert.equal(nearLimit([reset(97, now - 1), reset(50, now + 1000, 'b')], now), null);
  assert.equal(nearLimit([reset(97, now)], now), null);
  assert.deepEqual(nearLimit([reset(97, now - 1), reset(92, now + 1000, 'b'), reset(91, null, 'c')], now), { key: 'b', label: 'B', percent: 92 });
  assert.deepEqual(nearLimit([reset(97, now - 1)]), { key: 'a', label: 'A', percent: 97 }, 'without a clock the windows are taken as read');
});

// Which account the tab may offer near a limit. The rule is the window's (account-rules.ts `limitOffer`, over the
// same accounts list main shows), so that Settings, the prompt and this tab cannot disagree about an account.
test('near a limit, the offer: only an account billed per use, never another plan, and nothing when there is none', () => {
  const offer = (...list) => limitOffer(list, 'claude', 'claude-default')?.id ?? null;
  assert.equal(offer(acct({})), null, 'only the plan itself: no offer');
  assert.equal(offer(acct({}), OTHER_PLAN), null, 'another plan account is never offered');
  assert.equal(offer(acct({}), OTHER_PLAN, CONSOLE), 'console-1');
  assert.equal(limitOffer([acct({}), OTHER_PLAN, CONSOLE], 'claude', 'claude-default').label, 'Console', 'the account itself, as the list has it');
  assert.equal(offer(acct({}), CONSOLE, KEY, OTHER_PLAN), 'key-1', 'a pasted key before a Console sign-in');
  // A key in the shell or from a key helper is a key. A token is not offered: it may be a plan’s. Nor a cloud provider.
  const env = (via) => acct({ id: 'claude-env', kind: 'external', label: 'x', via, plan: null });
  assert.equal(offer(acct({}), env('ANTHROPIC_API_KEY')), 'claude-env');
  assert.equal(offer(acct({}), env('apiKeyHelper')), 'claude-env');
  assert.equal(offer(acct({}), CONSOLE, env('ANTHROPIC_API_KEY')), 'claude-env', 'a key from the environment before a Console sign-in');
  assert.equal(offer(acct({}), env('ANTHROPIC_API_KEY'), KEY), 'key-1', 'and a pasted key before either');
  for (const via of ['token', 'bedrock', 'vertex', 'gateway', null]) assert.equal(offer(acct({}), env(via)), null, String(via));
  // Not the one in use, not one that needs attention or could not be checked, not another maker’s.
  assert.equal(limitOffer([KEY], 'claude', 'key-1'), null);
  for (const state of ['signed-out', 'invalid-key', 'locked', 'unknown', 'checking', 'mismatch', 'expired', 'missing', 'blocked']) assert.equal(offer(acct({}), { ...KEY, state }), null, state);
  assert.equal(offer(acct({}), { ...KEY, engine: 'codex' }), null);
  // Codex, the same rule: near a ChatGPT plan's limit the offer is an OpenAI key pasted into Canopy, never Claude's key.
  assert.equal(limitOffer([{ ...KEY, engine: 'codex' }], 'codex', 'codex-default').id, 'key-1');
  assert.equal(limitOffer([KEY], 'codex', 'codex-default'), null);
  assert.equal(limitOffer([{ ...KEY, engine: 'codex', state: 'invalid-key' }], 'codex', 'codex-default'), null);
  for (const none of [null, undefined, 'x', [null, 5]]) assert.equal(limitOffer(none, 'claude', 'a'), null);
});

// ---- how a read is made ----

test('Claude: a running chat is asked first; a process is started only when there is none, or it cannot say, and only if allowed', async () => {
  const calls = [];
  const t = { chat: null, live: { ok: true, usage: MAX }, probe: async () => ({ supported: true, usage: MAX }) };
  const src = claudeSource({
    chat: (id) => { calls.push(['chat?', id]); return t.chat; },
    probe: (id) => { calls.push(['probe', id]); return t.probe(); },
    dollars: async (id) => ({ unit: 'usd', today: 1.5, month: 9, since: null, for: id }), screen: () => t.screen ?? null, chatDollars: async (id) => (id === 'chat-9' ? 0.31 : null),
  });
  const session = { usageAnswer: async () => { calls.push(['live']); return t.live; } };
  const ask = (probe) => src.limits(acct({}), { probe });

  // No chat is running.
  assert.equal(src.live('claude-default'), false);
  assert.deepEqual(await ask(false), { ok: false, code: 'skipped', via: 'live' }, 'not allowed to start a process: nothing is asked');
  let r = await ask(true);
  assert.deepEqual([r.ok, r.via, r.report.plan, r.report.windows.length, r.unknown], [true, 'probe', 'max', 5, ['seven_day_cowork', 'seven_day_haiku']]);
  assert.deepEqual(Object.keys(r.report).sort(), ['extra', 'plan', 'windows']);
  // A chat is running: it answers, and no process is started even when one would be allowed.
  t.chat = session;
  calls.length = 0;
  assert.equal(src.live('claude-default'), true);
  r = await ask(true);
  assert.deepEqual([r.ok, r.via], [true, 'live']);
  assert.deepEqual(calls.map((c) => c[0]), ['chat?', 'chat?', 'live']);
  // The chat cannot say just now: a process if allowed, else the failure as it is.
  t.live = { ok: false, code: 'timeout' };
  assert.deepEqual(await ask(false), { ok: false, code: 'timeout', via: 'live' });
  assert.deepEqual([(await ask(true)).ok, (await ask(true)).via], [true, 'probe']);
  t.live = { ok: false, code: 'no-session' };
  assert.deepEqual(await ask(false), { ok: false, code: 'failed', via: 'live' });
  // This Claude Code has no such call: no process would know better.
  t.live = { ok: false, code: 'unsupported' };
  calls.length = 0;
  assert.deepEqual(await ask(true), { ok: false, code: 'unsupported', via: 'live' });
  assert.ok(!calls.some((c) => c[0] === 'probe'));
  t.chat = null;
  t.probe = async () => ({ supported: false });
  assert.deepEqual(await ask(true), { ok: false, code: 'unsupported', via: 'probe' });
  // No plan windows in the answer (a login that cannot read its profile), a failure and a hang.
  t.probe = async () => ({ supported: true, usage: { subscriptionType: 'max', rateLimitsAvailable: false, rateLimits: null } });
  assert.deepEqual(await ask(true), { ok: false, code: 'no-limits', via: 'probe' });
  t.probe = async () => { throw new Error('account-signed-out'); };
  assert.deepEqual(await ask(true), { ok: false, code: 'failed', via: 'probe' });
  t.probe = async () => { throw Object.assign(new Error('usage check timed out'), { code: 'timeout' }); };
  assert.deepEqual(await ask(true), { ok: false, code: 'timeout', via: 'probe' });
  t.chat = { usageAnswer: async () => { throw new Error('bug'); } };
  assert.deepEqual(await ask(false), { ok: false, code: 'failed', via: 'live' });

  // Billed per use: Canopy’s own count, with "this chat" only when the chat on screen runs on this account.
  assert.deepEqual(await src.count(CONSOLE), { ok: true, via: 'count', report: { unit: 'usd', today: 1.5, month: 9, since: null, for: 'console-1', chat: null } });
  t.screen = 'chat-9';
  assert.deepEqual((await src.count(CONSOLE)).report.chat, { id: 'chat-9', amount: 0.31 });
  t.screen = 'chat-new';
  assert.deepEqual((await src.count(CONSOLE)).report.chat, { id: 'chat-new', amount: 0 });
});

test('Codex: the chat’s own process first, the shared helper else; a login with no plan is an answer', async () => {
  const calls = [];
  const t = { chat: null, live: { ok: true, limits: CODEX }, helper: async () => ({ ok: true, limits: CODEX }), screen: null };
  const src = codexSource({
    chat: () => t.chat, helper: () => { calls.push('helper'); return t.helper(); },
    dollars: (id) => ({ unit: 'usd', today: 1.2, month: 5, since: null, for: id }), screen: () => t.screen, chatDollars: (id) => (id === 'thread-1' ? { amount: 0.8, unpriced: 120 } : null),
  });
  const plan = acct({ id: 'codex-default', engine: 'codex', label: 'ChatGPT Pro', plan: 'pro' });
  const ask = (probe) => src.limits(plan, { probe });
  assert.deepEqual(await ask(false), { ok: false, code: 'skipped', via: 'live' });
  let r = await ask(true);
  assert.deepEqual([r.ok, r.via, r.report.windows.map((w) => w.label), r.unknown], [true, 'probe', ['Current window', 'This week'], []]);
  t.chat = { rateLimits: async () => { calls.push('live'); return t.live; } };
  calls.length = 0;
  assert.deepEqual([(await ask(true)).via, calls], ['live', ['live']]);
  t.live = { ok: false, code: 'rejected' };
  assert.deepEqual(await ask(true), { ok: false, code: 'no-limits', via: 'live' }, 'Codex said no: the helper would say the same');
  t.live = { ok: false, code: 'timeout' };
  assert.deepEqual(await ask(false), { ok: false, code: 'timeout', via: 'live' });
  assert.equal((await ask(true)).via, 'probe');
  t.chat = null;
  for (const [answer, code] of [[{ ok: false, code: 'rejected' }, 'no-limits'], [{ ok: false, code: 'timeout' }, 'timeout'], [{ ok: false, code: 'not-installed' }, 'failed'], [{ ok: true, limits: { rateLimits: null } }, 'no-limits'], [null, 'failed']]) {
    t.helper = async () => answer;
    assert.deepEqual(await ask(true), { ok: false, code, via: 'probe' });
  }
  t.helper = async () => { throw new Error('x'); };
  assert.deepEqual(await ask(true), { ok: false, code: 'failed', via: 'probe' });
  // An API key: dollars, as Canopy counted them, and the chat on screen with any tokens it has no price for.
  const key = { ...plan, kind: 'key' };
  assert.deepEqual(await src.count(key), { ok: true, via: 'count', report: { unit: 'usd', today: 1.2, month: 5, since: null, for: 'codex-default', chat: null } });
  t.screen = 'thread-1';
  assert.deepEqual((await src.count(key)).report.chat, { id: 'thread-1', amount: 0.8, unpriced: 120 });
  t.screen = 'thread-new';
  assert.deepEqual((await src.count(key)).report.chat, { id: 'thread-new', amount: 0, unpriced: 0 }, 'a chat with nothing counted yet');
});

// ---- the tab's state ----

const T0 = 1_800_000_000_000;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const planReport = (five = 34, week = 12) => ({ plan: 'max', windows: [win('five_hour', 'Current session', five, T0 + 3_600_000), win('seven_day', 'This week', week, T0 + 5 * 86_400_000)], extra: null });

// A registry view, two scripted sources, a clock and timers the test moves by hand.
function harness({ list = [acct({})], inUse, saved = null } = {}) {
  const t = {
    now: T0, timers: [], asked: [], changes: [], drift: [], saved, saves: 0, logs: [],
    reg: { inUse: inUse ?? { claude: list.find((a) => a.engine === 'claude')?.id ?? null, codex: list.find((a) => a.engine === 'codex')?.id ?? null }, list, checking: false },
    live: { claude: false, codex: false }, screen: { claude: null, codex: null },
    // What a read answers: a function of (account, how), per engine. Tests replace these.
    limits: { claude: async (a, how) => (t.live.claude ? { ok: true, via: 'live', report: planReport(), unknown: [] } : how.probe ? { ok: true, via: 'probe', report: planReport(), unknown: [] } : { ok: false, code: 'skipped', via: 'live' }), codex: async () => ({ ok: true, via: 'probe', report: { plan: 'pro', limitId: 'codex', windows: [{ key: 'primary', label: 'Current window', percent: 22, resetsAt: null }], credits: null }, unknown: [] }) },
    count: { claude: async () => ({ ok: true, via: 'count', report: { unit: 'usd', today: 1.84, month: 27.4, since: null, chat: null } }), codex: async () => ({ ok: true, via: 'count', report: { unit: 'usd', today: 1.2, month: 5, since: null, chat: null, unpriced: { today: 0, month: 900, models: ['gpt-7-nova', 7, ''] } } }) },
  };
  const source = (engine) => ({
    live: () => t.live[engine], screen: () => t.screen[engine],
    limits: (a, how) => { t.asked.push([engine, 'limits', a.id, how.probe]); return t.limits[engine](a, how); },
    count: (a) => { t.asked.push([engine, 'count', a.id]); return t.count[engine](a); },
  });
  const usage = new Usage({
    accounts: () => t.reg, sources: { claude: source('claude'), codex: source('codex') },
    load: () => t.saved, save: (s) => { t.saved = s; t.saves += 1; },
    onChange: (view) => t.changes.push(view), onDrift: (label, keys) => t.drift.push([label, keys]), log: (m) => t.logs.push(m), now: () => t.now,
    timers: { set: (fn, ms) => { const h = { fn, at: t.now + ms }; t.timers.push(h); return h; }, clear: (h) => { t.timers = t.timers.filter((x) => x !== h); } },
  });
  // Move the clock, run the timers that came due, and let what they started land.
  t.advance = async (by) => {
    t.now += by;
    for (const h of t.timers.filter((x) => x.at <= t.now)) { t.timers = t.timers.filter((x) => x !== h); h.fn(); }
    await flush();
  };
  t.open = async () => { const v = usage.read({ open: true }); await flush(); return v; };
  t.tick = async (by) => { t.now += by; const v = usage.read(); await flush(); return v; };
  t.claude = () => usage.view().sections.find((s) => s.engine === 'claude');
  return { usage, t };
}

test('a section per maker that has an account in use, Claude first; a maker without one is not drawn', async () => {
  const codexKey = acct({ id: 'codex-default', engine: 'codex', kind: 'key', label: 'API key', email: null, plan: null });
  const { usage, t } = harness({ list: [codexKey, CONSOLE, acct({}), KEY], inUse: { claude: 'console-1', codex: 'codex-default' } });
  const first = usage.view();
  assert.deepEqual(first.sections.map((s) => [s.engine, s.account.id, s.shape, s.at, s.loading]), [['claude', 'console-1', 'spend', null, false], ['codex', 'codex-default', 'spend', null, false]], 'billed per use reads the same for either maker');
  assert.deepEqual(t.asked, [], 'looking is not asking');
  await t.open();
  assert.deepEqual(t.asked, [['claude', 'count', 'console-1'], ['codex', 'count', 'codex-default']], 'only the account in use: the plan and the pasted key are never read');
  const v = usage.view();
  assert.deepEqual(v.sections[0].count, { unit: 'usd', today: 1.84, month: 27.4, since: null, chat: null });
  assert.deepEqual(v.sections[1].count, { unit: 'usd', today: 1.2, month: 5, since: null, chat: null, unpriced: { today: 0, month: 900, chat: 0, models: ['gpt-7-nova'] } }, 'Codex in dollars, with the tokens no price is known for');
  assert.equal(v.sections[0].account.label, 'Console');
  assert.ok(!('windows' in v.sections[0]) && !('offer' in v.sections[0]));

  // Nothing known yet (the tools are still being asked), no Codex on this Mac, and an account that is not in the list.
  t.reg = { inUse: { claude: null, codex: null }, list: [], checking: true };
  assert.deepEqual(usage.view(), { sections: [], checking: true });
  t.reg = { inUse: { claude: 'claude-default', codex: 'gone' }, list: [acct({})], checking: false };
  assert.deepEqual(usage.view().sections.map((s) => s.engine), ['claude']);
  for (const broken of [null, undefined, 'x', { inUse: 5, list: 'no' }]) { t.reg = broken; assert.deepEqual(usage.view(), { sections: [], checking: false }); }
  t.reg = () => { throw new Error('registry exploded'); };
  const throwing = new Usage({ accounts: () => { throw new Error('registry exploded'); } });
  assert.deepEqual(throwing.read(), { sections: [], checking: false });
});

test('opening the tab paints what is saved, and asks again only when that is a minute old', async () => {
  const kept = { v: 1, reports: { claude: { id: 'claude-default', who: 'plan|me@example.com||', shape: 'plan', at: T0 - 30_000, report: planReport(20, 5) } } };
  let h = harness({ saved: kept });
  let v = await h.t.open();
  assert.deepEqual([v.sections[0].at, v.sections[0].loading, v.sections[0].windows.map((w) => w.percent)], [T0 - 30_000, false, [20, 5]], 'the saved numbers, with their age');
  assert.deepEqual(h.t.asked, [], 'half a minute old: fresh enough');
  // A minute old: painted first, then read again in the background. No chat is running, so a process is allowed.
  h = harness({ saved: { v: 1, reports: { claude: { ...kept.reports.claude, at: T0 - OPEN_FRESH_MS } } } });
  v = h.usage.read({ open: true });
  assert.deepEqual([v.sections[0].at, v.sections[0].loading, v.sections[0].windows.map((w) => w.percent)], [T0 - OPEN_FRESH_MS, true, [20, 5]]);
  await flush();
  assert.deepEqual(h.t.asked, [['claude', 'limits', 'claude-default', true]]);
  assert.deepEqual([h.t.claude().at, h.t.claude().loading, h.t.claude().windows.map((w) => w.percent)], [T0, false, [34, 12]]);
  assert.equal(h.t.saved.reports.claude.at, T0);
  // Nothing saved: asked at once, and until it lands there is nothing to show but that it is being read.
  h = harness();
  v = h.usage.read({ open: true });
  assert.deepEqual([v.sections[0].at, v.sections[0].loading, v.sections[0].windows, v.sections[0].error], [null, true, [], null]);
});

test('while the tab is on screen: every minute through a running chat, every five through a process, never both at once', async () => {
  const { usage, t } = harness();
  await t.open();
  assert.deepEqual(t.asked, [['claude', 'limits', 'claude-default', true]]);
  t.asked.length = 0;
  // No chat running: the tab asks main every 20 s; main reads only once five minutes have passed.
  for (let i = 0; i < 14; i++) await t.tick(20_000);
  assert.deepEqual(t.asked, [], `${14 * 20} s: not yet`);
  await t.tick(20_000);
  assert.deepEqual(t.asked, [['claude', 'limits', 'claude-default', true]], 'at five minutes, through a process');
  t.asked.length = 0;
  // A chat is running on the account now: once a minute, and no process (the last one was under five minutes ago).
  t.live.claude = true;
  await t.tick(20_000); await t.tick(20_000);
  assert.deepEqual(t.asked, []);
  await t.tick(20_000);
  assert.deepEqual(t.asked, [['claude', 'limits', 'claude-default', false]]);
  for (let i = 0; i < 6; i++) await t.tick(20_000);
  assert.deepEqual(t.asked.map((a) => a[3]), [false, false, false], 'three more minutes, three more reads, still no process');
  assert.equal(LIVE_EVERY_MS, 60_000);
  assert.equal(PROBE_EVERY_MS, 300_000);

  // One read in flight per account: asking again while it is on its way starts nothing.
  t.asked.length = 0;
  let land;
  t.limits.claude = () => new Promise((resolve) => { land = resolve; });
  await t.tick(60_000);
  await t.tick(60_000);
  usage.refresh();
  usage.refresh('claude');
  await flush();
  assert.equal(t.asked.length, 1);
  assert.equal(t.claude().loading, true);
  land({ ok: true, via: 'live', report: planReport(50, 13), unknown: [] });
  await flush();
  assert.deepEqual([t.claude().loading, t.claude().windows[0].percent], [false, 50]);
});

test('the chat that was answering goes away: the next read waits the full five minutes before a process is started', async () => {
  const { t } = harness();
  t.live.claude = true;
  await t.open();
  await t.tick(LIVE_EVERY_MS);
  assert.deepEqual(t.asked.map((a) => a[3]), [true, true], 'through the chat (a process was allowed, and not needed)');
  t.asked.length = 0;
  t.live.claude = false;
  for (let i = 0; i < 14; i++) await t.tick(20_000);
  assert.deepEqual(t.asked, [], 'what is shown is under five minutes old: no process yet');
  await t.tick(20_000);
  assert.deepEqual(t.asked, [['claude', 'limits', 'claude-default', true]]);
});

test('hidden, nothing runs: no read on a timer, none after a turn, and the window is told nothing', async () => {
  const { usage, t } = harness();
  t.live.claude = true;
  // The tab was never opened.
  usage.turnEnded('claude', 'claude-default');
  await t.advance(AFTER_TURN_MS + 10);
  await t.advance(10 * 60_000);
  assert.deepEqual([t.asked, t.timers, t.changes], [[], [], []]);
  // Opened, then closed: the read after a turn that was already waiting is called off.
  await t.open();
  t.asked.length = 0; t.changes.length = 0;
  usage.turnEnded('claude', 'claude-default');
  assert.equal(t.timers.length, 1);
  usage.watch(false);
  assert.equal(t.timers.length, 0);
  usage.turnEnded('claude', 'claude-default');
  await t.advance(60 * 60_000);
  assert.deepEqual([t.asked, t.changes], [[], []]);
  assert.equal(usage.watching, false);
  // A window that went away without saying so (a reload): the tab stops counting as on screen by itself.
  await t.open();
  assert.equal(usage.watching, true);
  t.now += WATCH_LEASE_MS;
  assert.equal(usage.watching, false);
  usage.turnEnded('claude', 'claude-default');
  assert.equal(t.timers.length, 0);
});

test('a turn ends on the account: read again two seconds later, through that chat, and quietly', async () => {
  const { usage, t } = harness();
  t.live.claude = true;
  await t.open();
  t.asked.length = 0;
  usage.turnEnded('claude', 'some-other-account');
  usage.turnEnded('codex', 'claude-default');
  assert.equal(t.timers.length, 0, 'a turn on an account the tab does not show changes nothing');
  usage.turnEnded('claude', 'claude-default');
  usage.turnEnded('claude', 'claude-default'); // two chats finishing together: one read
  assert.equal(t.timers.length, 1);
  await t.advance(AFTER_TURN_MS - 1);
  assert.deepEqual(t.asked, []);
  t.limits.claude = async () => ({ ok: true, via: 'live', report: planReport(36, 12), unknown: [] });
  await t.advance(1);
  assert.deepEqual(t.asked, [['claude', 'limits', 'claude-default', false]], 'never a new process for this');
  assert.equal(t.claude().windows[0].percent, 36);
  // The chat could not say, or is gone: what is shown stays as it is, with no error.
  for (const answer of [{ ok: false, code: 'timeout', via: 'live' }, { ok: false, code: 'skipped', via: 'live' }]) {
    t.limits.claude = async () => answer;
    usage.turnEnded('claude', 'claude-default');
    await t.advance(AFTER_TURN_MS);
    assert.deepEqual([t.claude().error, t.claude().windows[0].percent, t.claude().at], [null, 36, T0 + AFTER_TURN_MS]);
  }
});

test('limit updates from chats are folded in at once, and only for the account in use', async () => {
  const { usage, t } = harness();
  usage.limit('claude', 'claude-default', { status: 'allowed_warning', type: 'seven_day', utilization: 91, resetsAt: null });
  assert.equal(t.claude().windows.length, 0, 'nothing read yet: an update alone is not a report');
  await t.open();
  const saves = t.saves;
  t.changes.length = 0;
  usage.limit('claude', 'claude-default', { status: 'allowed_warning', type: 'seven_day', utilization: 91, resetsAt: null });
  assert.deepEqual(t.claude().windows.map((w) => w.percent), [34, 91]);
  assert.equal(t.claude().at, T0, 'the report’s age is the last whole read, not the update');
  assert.equal(t.saves, saves + 1);
  assert.equal(t.changes.length, 1, 'the window hears at once');
  assert.deepEqual(t.changes[0].sections[0].near, { key: 'seven_day', label: 'This week', percent: 91 });
  // Another account’s chat (one opened before a switch) says something: nothing is kept about it.
  usage.limit('claude', 'plan-2', { status: 'rejected', type: 'five_hour', utilization: 100 });
  usage.limit('codex', 'claude-default', { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null } });
  usage.limit('claude', 'claude-default', { status: 'allowed', type: 'overage', utilization: 50 });
  usage.limit('claude', 'claude-default', null);
  assert.deepEqual(t.claude().windows.map((w) => w.percent), [34, 91]);
  assert.equal(t.saves, saves + 1);
  assert.ok(!JSON.stringify(t.saved).includes('plan-2'));
  // With the tab hidden an update still lands in the report, silently.
  usage.watch(false);
  usage.limit('claude', 'claude-default', { status: 'rejected', type: 'five_hour', utilization: null });
  assert.equal(t.changes.length, 1);
  assert.equal(t.claude().windows[0].percent, 100);

  // Codex: its sparse update, into the plan’s windows.
  const plan = acct({ id: 'codex-default', engine: 'codex', label: 'ChatGPT Pro', plan: 'pro' });
  const c = harness({ list: [plan] });
  await c.t.open();
  c.usage.limit('codex', 'codex-default', { limitId: 'codex', primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: T0 / 1000 + 3600 }, secondary: null, credits: null });
  const section = c.usage.view().sections[0];
  assert.deepEqual([section.shape, section.windows.map((w) => w.percent), section.near?.percent], ['plan', [95], 95]);
  assert.equal(limitOffer(c.t.reg.list, 'codex', 'codex-default'), null, 'and nothing to offer: there is no choosing between OpenAI accounts');
});

test('unavailable: the last numbers stay with their age, it is tried again on the usual beat, and a click tries now', async () => {
  const { usage, t } = harness();
  await t.open();
  t.limits.claude = async () => ({ ok: false, code: 'timeout', via: 'probe' });
  await t.tick(PROBE_EVERY_MS);
  let s = t.claude();
  assert.deepEqual([s.error, s.at, s.windows.map((w) => w.percent), s.loading], ['unavailable', T0, [34, 12], false]);
  assert.match(t.logs.join('\n'), /claude: usage for claude-default is unavailable \(timeout, probe\)/);
  t.asked.length = 0;
  await t.tick(60_000);
  assert.deepEqual(t.asked, [], 'not hammered: the next try is five minutes after the last');
  // Try Again.
  t.limits.claude = async () => ({ ok: true, via: 'probe', report: planReport(40, 15), unknown: [] });
  usage.refresh('claude');
  await flush();
  s = t.claude();
  assert.deepEqual([s.error, s.at, s.windows.map((w) => w.percent)], [null, t.now, [40, 15]]);
  assert.deepEqual(t.asked, [['claude', 'limits', 'claude-default', true]]);
  // A second click on numbers a moment old starts nothing: there is nothing newer to be had, only a process to pay for.
  usage.refresh('claude');
  t.now += CLICK_FRESH_MS - 1;
  usage.refresh();
  await flush();
  assert.equal(t.asked.length, 1);
  t.now += 1;
  usage.refresh('claude');
  await flush();
  assert.equal(t.asked.length, 2);
  // A source that throws or answers nothing is the same "unavailable", never an exception.
  for (const bad of [async () => { throw new Error('boom'); }, async () => null, () => { throw new Error('sync boom'); }]) {
    t.limits.claude = bad;
    t.now += CLICK_FRESH_MS;
    usage.refresh();
    await flush();
    assert.equal(t.claude().error, 'unavailable');
    assert.deepEqual(t.claude().windows.map((w) => w.percent), [40, 15]);
  }
  // With no numbers at all it is just unavailable.
  const none = harness();
  none.t.limits.claude = async () => ({ ok: false, code: 'failed', via: 'probe' });
  await none.t.open();
  assert.deepEqual([none.t.claude().error, none.t.claude().at, none.t.claude().windows], ['unavailable', null, []]);
});

test('a Claude Code without the usage call: unavailable, noted as drift, and not asked again every minute', async () => {
  const { usage, t } = harness();
  t.limits.claude = async () => ({ ok: false, code: 'unsupported', via: 'probe' });
  await t.open();
  assert.deepEqual([t.claude().error, t.claude().windows], ['unsupported', []]);
  assert.deepEqual(t.drift, [['the usage call (missing from this Claude Code)', []]]);
  t.asked.length = 0;
  t.live.claude = true;
  for (let i = 0; i < 30; i++) await t.tick(60_000);
  assert.deepEqual(t.asked, [], 'half an hour of the tab being open: nothing started for an answer that will not change');
  await t.tick(HOLD_MS);
  assert.equal(t.asked.length, 1, 'an hour on, one more look (Claude Code may have been updated)');
  // Try Again asks whatever the hold says, and a login with no limits to read is held the same way.
  t.asked.length = 0;
  t.limits.claude = async () => ({ ok: false, code: 'no-limits', via: 'live' });
  usage.refresh();
  await flush();
  assert.deepEqual([t.asked.length, t.claude().error], [1, 'no-limits']);
  await t.tick(10 * 60_000);
  assert.equal(t.asked.length, 1);
  assert.equal(t.drift.length, 2, 'only the missing call is drift');
});

test('windows without a name are noted as drift, one entry each', async () => {
  const { t } = harness();
  t.limits.claude = async () => ({ ok: true, via: 'live', report: planReport(), unknown: ['seven_day_haiku', 'iguana_necktie'] });
  await t.open();
  assert.deepEqual(t.drift, [['a name for the usage limit seven_day_haiku', ['seven_day_haiku']], ['a name for the usage limit iguana_necktie', ['iguana_necktie']]]);
});

test('an account that needs the user: said so, and nothing is read for it', async () => {
  for (const state of ['signed-out', 'expired', 'mismatch', 'missing', 'locked', 'invalid-key', 'blocked']) {
    const { usage, t } = harness({ list: [acct({ state, why: state === 'blocked' ? 'your Claude Code settings choose the login' : null })] });
    const v = await t.open();
    assert.deepEqual(v.sections, [{ engine: 'claude', account: t.reg.list[0], shape: 'attention', at: null, loading: false, error: null }], state);
    usage.refresh();
    usage.turnEnded('claude', 'claude-default');
    await t.advance(AFTER_TURN_MS);
    for (let i = 0; i < 10; i++) await t.tick(60_000);
    assert.deepEqual([t.asked, t.timers], [[], []], state);
  }
  // "Could not check" is not signed out: it is read as usual.
  const { t } = harness({ list: [acct({ state: 'unknown' })] });
  await t.open();
  assert.deepEqual([t.asked.length, t.claude().shape], [1, 'plan']);
  // It comes back signed in as the same person: its numbers are still there, with their age.
  const back = harness();
  await back.t.open();
  back.t.reg.list[0].state = 'signed-out';
  assert.equal(back.t.claude().shape, 'attention');
  back.t.reg.list[0].state = 'ok';
  assert.deepEqual([back.t.claude().shape, back.t.claude().at, back.t.claude().windows.length], ['plan', T0, 2]);
});

test('when another account becomes the one in use, the old one’s numbers are gone: from the tab, from memory, from what is saved', async () => {
  const { usage, t } = harness({ list: [acct({}), CONSOLE] });
  await t.open();
  assert.equal(t.saved.reports.claude.id, 'claude-default');
  // A read for the plan is on its way when the switch happens.
  let land;
  t.limits.claude = () => new Promise((resolve) => { land = resolve; });
  await t.tick(PROBE_EVERY_MS);
  assert.equal(t.claude().loading, true);
  t.reg.inUse.claude = 'console-1';
  let v = await t.tick(1000);
  assert.deepEqual([v.sections[0].account.id, v.sections[0].shape], ['console-1', 'spend']);
  assert.ok(!JSON.stringify(t.saved).includes('claude-default') && !JSON.stringify(t.saved).includes('Current session'), 'state.json no longer holds the plan’s limits');
  const saves = t.saves;
  land({ ok: true, via: 'probe', report: planReport(99, 99), unknown: ['seven_day_haiku'] });
  await flush();
  assert.ok(!JSON.stringify(usage.view()).includes('99') && !JSON.stringify(t.saved).includes('99'), 'the late answer is nobody’s');
  assert.deepEqual([t.saves, t.drift], [saves, []], 'it is dropped whole: nothing saved, nothing noted');
  // Back on the plan: nothing is remembered, so it reads as new.
  t.limits.claude = async () => ({ ok: true, via: 'probe', report: planReport(), unknown: [] });
  t.reg.inUse.claude = 'claude-default';
  v = usage.read({ open: true });
  assert.deepEqual([v.sections[0].at, v.sections[0].windows, v.sections[0].loading], [null, [], true]);
  await flush();

  // The same login, signed in as someone else: also a different account.
  const kept = { v: 1, reports: { claude: { id: 'claude-default', who: 'plan|someone-else@example.com||', shape: 'plan', at: T0 - 1000, report: planReport(77, 77) } } };
  const other = harness({ saved: kept });
  const first = other.usage.view();
  assert.deepEqual([first.sections[0].at, first.sections[0].windows], [null, []]);
  assert.deepEqual(other.t.saved, { v: 1, reports: {} });
  // And a saved report of another shape (the login was a plan, and is a Console sign-in now).
  const shaped = harness({ list: [acct({ kind: 'console', label: 'Console', plan: null })], saved: { v: 1, reports: { claude: { id: 'claude-default', who: 'console|me@example.com||', shape: 'plan', at: T0, report: planReport() } } } });
  assert.deepEqual(shaped.usage.view().sections[0].count, null);
});

test('what is saved: the report field by field and nothing else, and unreadable state is simply no cache', async () => {
  const { t } = harness();
  t.limits.claude = async () => ({ ok: true, via: 'live', unknown: [], report: {
    plan: 'max', token: 'sk-ant-should-not-survive', windows: [{ ...win('five_hour', 'Current session', 34), secret: 'x' }, { key: 'no-label', percent: 5 }, { key: 'k', label: 'L', percent: 'NaN' }, null],
    extra: { enabled: true, percent: 10, used: 1, limit: 2, currency: 'USD', card: '4242' }, credits: null,
  } });
  await t.open();
  assert.deepEqual(t.saved, { v: 1, reports: { claude: { id: 'claude-default', who: 'plan|me@example.com||', shape: 'plan', at: T0, report: {
    plan: 'max', limitId: null, windows: [win('five_hour', 'Current session', 34)], extra: { enabled: true, percent: 10, used: 1, limit: 2, currency: 'USD' }, credits: null,
  } } } });
  t.saved.reports.claude.report.windows[0].percent = 1;
  assert.equal(t.claude().windows[0].percent, 34, 'the host is handed a copy');
  for (const bad of [null, 'x', 42, [], { reports: 'x' }, { reports: { claude: 'x' } }, { reports: { claude: { id: 'claude-default', who: 'plan|me@example.com||', shape: 'plan', at: 'yesterday', report: planReport() } } },
    { reports: { claude: { id: 'claude-default', who: 'plan|me@example.com||', shape: 'plan', at: T0, report: 'x' } } }]) {
    const h = harness({ saved: bad });
    assert.deepEqual([h.t.claude().at, h.t.claude().windows], [null, []]);
  }
  const unreadable = new Usage({ accounts: () => ({ inUse: { claude: 'claude-default' }, list: [acct({})] }), load: () => { throw new Error('unreadable'); }, save: () => { throw new Error('disk full'); }, sources: { claude: { live: () => false, limits: async () => ({ ok: true, via: 'probe', report: planReport(), unknown: [] }) } }, now: () => T0 });
  unreadable.read({ open: true });
  await flush();
  assert.equal(unreadable.view().sections[0].windows.length, 2, 'a host that cannot save is survived');
});

test('billed per use: Canopy’s own count, recounted as it goes, with "this chat" only for the chat it was counted for', async () => {
  const { usage, t } = harness({ list: [CONSOLE] });
  t.screen.claude = 'chat-1';
  t.count.claude = async () => ({ ok: true, via: 'count', report: { unit: 'usd', today: 1.84, month: 27.4, since: T0 - 86_400_000, chat: { id: 'chat-1', amount: 0.31 } } });
  await t.open();
  assert.deepEqual(t.claude().count, { unit: 'usd', today: 1.84, month: 27.4, since: T0 - 86_400_000, chat: 0.31 });
  t.asked.length = 0;
  await t.tick(COUNT_EVERY_MS - 1);
  assert.deepEqual(t.asked, []);
  await t.tick(1);
  assert.deepEqual(t.asked, [['claude', 'count', 'console-1']], 'a local count: every ten seconds is cheap, and nothing is asked of anyone');
  // Another chat comes on screen: the old chat’s number is not shown under "This chat" for one moment, and the count runs at once.
  t.asked.length = 0;
  t.screen.claude = 'chat-2';
  let land;
  t.count.claude = () => new Promise((resolve) => { land = resolve; });
  const v = usage.read();
  assert.deepEqual([v.sections[0].count.chat, v.sections[0].count.today], [null, 1.84]);
  assert.deepEqual(t.asked, [['claude', 'count', 'console-1']]);
  land({ ok: true, via: 'count', report: { unit: 'usd', today: 1.9, month: 27.46, since: null, chat: { id: 'chat-2', amount: 0.06 } } });
  await flush();
  assert.deepEqual(t.claude().count, { unit: 'usd', today: 1.9, month: 27.46, since: null, chat: 0.06 });
  // No chat on screen on this account (a Codex chat is open): no "This chat" row.
  t.screen.claude = null;
  assert.equal(t.claude().count.chat, null);
  // After a turn on the account the count is taken again two seconds later; a count that fails then changes nothing.
  t.asked.length = 0;
  t.count.claude = async () => { throw new Error('EIO'); };
  usage.turnEnded('claude', 'console-1');
  await t.advance(AFTER_TURN_MS);
  assert.deepEqual([t.asked.length, t.claude().error, t.claude().count.today], [1, null, 1.9]);
  // A count that fails on the tab’s own beat says so, and keeps the last numbers.
  await t.tick(COUNT_EVERY_MS);
  assert.deepEqual([t.claude().error, t.claude().count.today], ['unavailable', 1.9]);
});

test('near a limit: main says which window is nearly full; what is offered is the accounts’ own rule, and nothing here can switch', async () => {
  // What the tab would offer for a section: the window's rule over the same list main's view was made from.
  const offered = (h) => { const s = h.t.claude(); return s.near ? limitOffer(h.t.reg.list, s.engine, s.account.id)?.id ?? null : null; };
  // Only the plan: amber, and nothing offered.
  let h = harness();
  h.t.limits.claude = async () => ({ ok: true, via: 'live', report: planReport(93, 61), unknown: [] });
  await h.t.open();
  assert.deepEqual([h.t.claude().near, offered(h)], [{ key: 'five_hour', label: 'Current session', percent: 93 }, null]);
  // Another plan and a Console sign-in exist: the Console one is offered, never the plan. Below 90% nothing is.
  h = harness({ list: [acct({}), OTHER_PLAN, CONSOLE], inUse: { claude: 'claude-default', codex: null } });
  await h.t.open();
  assert.deepEqual([h.t.claude().near, offered(h)], [null, null], 'at 34% there is nothing to offer');
  h.usage.limit('claude', 'claude-default', { status: 'allowed_warning', type: 'five_hour', utilization: 90, resetsAt: null });
  assert.deepEqual([h.t.claude().near.key, offered(h)], ['five_hour', 'console-1']);
  // Main names no account and has no way to choose one from here: taking the offer is `accounts:use`, the one
  // switch there is (account-actions.test.mjs), by one click. Nothing here ever switches by itself.
  assert.ok(!('offer' in h.t.claude()));
  assert.equal(h.usage.use, undefined);
});

test('numbers read before a window reset make no offer after it: the saved report says nothing about that limit now', async () => {
  const stale = { plan: 'max', windows: [win('five_hour', 'Current session', 96, T0 - 60_000), win('seven_day', 'This week', 40, T0 + 86_400_000)], extra: null };
  const { usage, t } = harness({ list: [acct({}), CONSOLE], inUse: { claude: 'claude-default', codex: null },
    saved: { v: 1, reports: { claude: { id: 'claude-default', who: 'plan|me@example.com||', shape: 'plan', at: T0 - 9 * 3_600_000, report: stale } } } });
  t.limits.claude = async () => ({ ok: false, code: 'timeout', via: 'probe' });
  const v = usage.view();
  assert.deepEqual([v.sections[0].windows[0].percent, v.sections[0].at], [96, T0 - 9 * 3_600_000], 'what was read is still shown, with its age');
  // No window is near its limit, so the tab offers nothing (an offer is only ever made beside `near`).
  assert.equal(v.sections[0].near, null);
  await t.open();
  assert.deepEqual([t.claude().error, t.claude().near], ['unavailable', null]);
  // The week is read as nearly full and has not reset: that one still counts, and the Console sign-in is offered.
  usage.limit('claude', 'claude-default', { status: 'allowed_warning', type: 'seven_day', utilization: 95, resetsAt: T0 + 86_400_000 });
  assert.deepEqual([t.claude().near?.key, limitOffer(t.reg.list, 'claude', t.claude().account.id)?.id], ['seven_day', 'console-1']);
});

test('the window is told once per change, and only while the tab is on screen', async () => {
  const { usage, t } = harness();
  let land;
  t.limits.claude = () => new Promise((resolve) => { land = resolve; });
  usage.read({ open: true });
  assert.deepEqual(t.changes.map((v) => v.sections[0].loading), [true]);
  usage.read();
  usage.read();
  assert.equal(t.changes.length, 1, 'asking again changes nothing, so nothing is said');
  land({ ok: true, via: 'probe', report: planReport(), unknown: [] });
  await flush();
  assert.deepEqual(t.changes.map((v) => [v.sections[0].loading, v.sections[0].windows.length]), [[true, 0], [false, 2]]);
  // A read that lands after the tab went away is kept for next time, and said to nobody.
  t.limits.claude = () => new Promise((resolve) => { land = resolve; });
  await t.tick(PROBE_EVERY_MS);
  usage.watch(false);
  land({ ok: true, via: 'probe', report: planReport(60, 20), unknown: [] });
  await flush();
  assert.equal(t.changes.length, 3, 'the last thing it heard was that a read had started');
  assert.deepEqual(t.claude().windows.map((w) => w.percent), [60, 20]);
});

// account-spend.mjs: what each account spent, counted on this Mac. The transcripts are real files in a throwaway
// folder, priced by the real day-activity.mjs; the clock and the saved state are the test's. No tool is asked anything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountSpend } from '../../../account-spend.mjs';
import { dayActivity, dayKey } from '../../../day-activity.mjs';

const MIN = 60_000;
const NOV16 = new Date(2026, 10, 16).getTime(); // a local midnight, mid-month
const midnight = (day) => new Date(2026, 10, day).getTime();
const at = (day, minutes) => midnight(day) + minutes * MIN;
// One reply of `millions` million input tokens on Opus 5.5: $4 a million.
const reply = (ms, id, millions = 1) => ({ type: 'assistant', timestamp: new Date(ms).toISOString(), message: { id, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: millions * 1_000_000, output_tokens: 0 } } });
const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function setup({ saved = null, found = 'claude-default', clock = at(16, 720) } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'account-spend-'));
  const proj = path.join(dir, 'projects', '-Users-me-app');
  mkdirSync(proj, { recursive: true });
  const t = { now: clock, found, saved, saves: 0, logs: [] };
  const make = () => new AccountSpend({
    load: () => t.saved, save: (s) => { t.saved = s; t.saves += 1; }, defaultAccount: (engine) => (engine === 'codex' ? 'codex-default' : t.found),
    configDir: () => dir, now: () => t.now, log: (m) => t.logs.push(m),
  });
  // A transcript is last modified when its last row lands. The test's days are not the real clock's, so say so.
  const stamp = (file, rows) => { const last = Math.max(...rows.map((r) => Date.parse(r.timestamp))) / 1000; utimesSync(file, last, last); };
  const write = (chat, rows) => { const file = path.join(proj, `${chat}.jsonl`); writeFileSync(file, lines(rows)); stamp(file, rows); };
  const add = (chat, rows) => { const file = path.join(proj, `${chat}.jsonl`); appendFileSync(file, lines(rows)); stamp(file, rows); };
  return { dir, t, make, write, add, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- which account a chat ran on ----

test('spans: written only when a chat starts on a different account than its last, and never for the default login', () => {
  const { t, make, done } = setup();
  try {
    const spend = make();
    assert.equal(spend.started('chat-1', null, at(16, 60)), false, 'nothing chosen: it is on the login Claude Code finds, like every chat before accounts');
    assert.equal(spend.started('chat-1', 'claude-default', at(16, 61)), false, 'the default login by name is still the default login');
    assert.equal(t.saves, 0);
    assert.equal(spend.accountAt('chat-1', at(16, 62)), null);
    assert.equal(spend.attribute('chat-1', at(16, 62)), 'claude-default');

    // The chat is reopened later on a pasted key, restarted twice on it, then goes back to the default login.
    assert.equal(spend.started('chat-1', 'key-1', at(16, 120)), true);
    assert.equal(spend.started('chat-1', 'key-1', at(16, 130)), false, 'the same account again: nothing new to write');
    assert.equal(spend.started('chat-1', null, at(16, 200)), true, 'back on the default login: that is a change now');
    assert.equal(spend.started('chat-1', 'claude-default', at(16, 210)), false);
    assert.deepEqual(t.saved.chats, { 'chat-1': { seen: '2026-11-16', spans: [[at(16, 120), 'key-1'], [at(16, 200), 'claude-default']] } });
    assert.deepEqual([at(16, 119), at(16, 120), at(16, 199), at(16, 200), at(17, 0)].map((ms) => spend.attribute('chat-1', ms)),
      ['claude-default', 'key-1', 'key-1', 'claude-default', 'claude-default'], 'each reply by the span it landed in; before the first span, the default login');
    assert.equal(spend.attribute('a-chat-from-the-terminal', at(16, 300)), 'claude-default');

    // Nothing usable: no chat, no account and no default known. Nothing is written and nothing throws.
    t.found = null;
    for (const bad of [[null, 'key-1'], ['', 'key-1'], [42, 'key-1'], ['chat-2', null], ['chat-2', ''], ['x'.repeat(81), 'key-1']]) assert.equal(spend.started(...bad), false);
    assert.equal(spend.attribute('chat-2', at(16, 1)), '', 'nobody to name: counted under the unnamed login, never dropped');
    assert.equal(Object.keys(t.saved.chats).length, 1);
  } finally { done(); }
});

// ---- dollars ----

test('with one account, today is Home’s number exactly, to the last bit', async () => {
  const { dir, t, make, write, done } = setup();
  try {
    const odd = (n) => 0.001234 * n + 0.000077;
    for (const chat of ['a', 'b', 'c']) write(chat, Array.from({ length: 30 }, (_, k) => reply(at(16, 60 + k * 7), `${chat}${k}`, odd(k + chat.charCodeAt(0)))));
    write('yesterdays', [reply(at(15, 600), 'y1', 2)]);
    const spend = make();
    for (const chat of ['a', 'b', 'c']) spend.started(chat, null, at(16, 59));
    const mine = await spend.dollars('claude-default');
    const home = await dayActivity({ since: NOV16, now: t.now, configDir: dir });
    assert.equal(mine.today, home.cost);
    assert.ok(mine.today > 0);
    assert.equal(mine.unit, 'usd');
    assert.equal(mine.month, mine.today, 'counting began today: the month so far is today');
    assert.equal(mine.since, NOV16, 'and it says since when');
    assert.deepEqual(await spend.dollars('some-other-account'), { unit: 'usd', today: 0, month: 0, since: NOV16 });
    assert.deepEqual([t.saved.since, t.saved.closed], ['2026-11-16', '2026-11-15']);
  } finally { done(); }
});

test('two accounts: each reply is counted for the account its chat was on when it landed', async () => {
  const { t, make, write, done } = setup();
  try {
    // a: on the default login all day. b: starts on a pasted key. c: on the default until 10:00, then reopened on the key.
    write('a', [reply(at(16, 100), 'a1', 1)]);
    write('b', [reply(at(16, 200), 'b1', 0.5)]);
    write('c', [reply(at(16, 500), 'c1', 0.25), reply(at(16, 700), 'c2', 0.125)]);
    write('terminal', [reply(at(16, 300), 't1', 2)]);
    const spend = make();
    spend.started('a', null, at(16, 90));
    spend.started('b', 'key-1', at(16, 190));
    spend.started('c', null, at(16, 490));
    spend.started('c', 'key-1', at(16, 600));
    const plan = await spend.dollars('claude-default');
    const key = await spend.dollars('key-1');
    assert.equal(plan.today, 4 + 1 + 8, 'a, c before the switch, and the chat run in the terminal');
    assert.equal(key.today, 2 + 0.5, 'b, and c after the switch');
    assert.deepEqual(t.saved.days, { '2026-11-16': { 'claude-default': 13, 'key-1': 2.5 } });
  } finally { done(); }
});

test('a day that is over is counted once more, whole, and kept; the month is those days plus today', async () => {
  const { t, make, write, add, done } = setup({ clock: at(16, 600) });
  try {
    write('a', [reply(at(16, 100), 'a1', 1)]);
    let spend = make();
    assert.equal((await spend.dollars('claude-default')).today, 4);
    // More is spent that evening, with the Usage tab closed and then Canopy quit: what was saved for the 16th is stale.
    add('a', [reply(at(16, 1300), 'a2', 2)]);
    assert.deepEqual(t.saved.days, { '2026-11-16': { 'claude-default': 4 } });

    // Two days later, in a new run of the app. The 17th had spend too, from a chat in the terminal.
    write('terminal', [reply(at(17, 500), 't1', 0.5)]);
    add('a', [reply(at(18, 30), 'a3', 0.25)]);
    t.now = at(18, 60);
    spend = make();
    const r = await spend.dollars('claude-default');
    assert.deepEqual(r, { unit: 'usd', today: 1, month: 12 + 2 + 1, since: NOV16 });
    assert.deepEqual(t.saved.days, { '2026-11-16': { 'claude-default': 12 }, '2026-11-17': { 'claude-default': 2 }, '2026-11-18': { 'claude-default': 1 } });
    assert.equal(t.saved.closed, '2026-11-17');

    // The days already counted are not read again: only today is.
    let dayReads = 0;
    const lazy = new AccountSpend({ load: () => t.saved, save: (s) => { t.saved = s; }, defaultAccount: () => 'claude-default', now: () => t.now,
      read: { day: async () => ({ byAccount: { 'claude-default': 1.5 } }), days: async () => { dayReads += 1; return {}; } } });
    assert.equal((await lazy.dollars('claude-default')).month, 12 + 2 + 1.5);
    assert.equal(dayReads, 0);
  } finally { done(); }
});

test('the month: only this month’s days, and "since" until a whole month has been counted', async () => {
  const days = { '2026-10-30': { 'claude-default': 100 }, '2026-10-31': { 'claude-default': 50 }, '2026-11-01': { 'claude-default': 1 }, '2026-11-10': { 'claude-default': 2, 'key-1': 7 }, '2026-11-15': { '': 3 } };
  const fake = (clock, since, found = 'claude-default') => new AccountSpend({
    load: () => ({ since, closed: dayKey(clock - 24 * 60 * MIN), days }), defaultAccount: () => found, now: () => clock,
    read: { day: async () => ({ byAccount: { 'claude-default': 0.5 } }), days: async () => ({}) },
  });
  // Counting began on October 30: November is whole, so it is simply "this month".
  assert.deepEqual(await fake(at(16, 600), '2026-10-30').dollars('claude-default'), { unit: 'usd', today: 0.5, month: 1 + 2 + 3 + 0.5, since: null });
  assert.deepEqual(await fake(at(16, 600), '2026-10-30').dollars('key-1'), { unit: 'usd', today: 0, month: 7, since: null });
  // What was counted before the default login had a name belongs to whichever account is the default one.
  assert.equal((await fake(at(16, 600), '2026-10-30', 'key-1').dollars('key-1')).month, 7 + 3);
  // Counting began on the 1st: still the whole month. On the 10th: "since November 10".
  assert.equal((await fake(at(16, 600), '2026-11-01').dollars('claude-default')).since, null);
  assert.equal((await fake(at(16, 600), '2026-11-10').dollars('claude-default')).since, midnight(10));
  // On December 1 the new month starts at nothing but today.
  const dec = new Date(2026, 11, 1, 9).getTime();
  assert.deepEqual(await fake(dec, '2026-11-10').dollars('claude-default'), { unit: 'usd', today: 0.5, month: 0.5, since: null });
});

test('a read that fails: the count is refused, the day is not marked done, and the next try counts it', async () => {
  const t = { saved: { since: '2026-11-10', closed: '2026-11-13', days: {} }, fail: true, logs: [], ranges: [] };
  const spend = new AccountSpend({
    load: () => t.saved, save: (s) => { t.saved = s; }, defaultAccount: () => 'claude-default', now: () => at(16, 600), log: (m) => t.logs.push(m),
    read: {
      day: async () => { if (t.fail) throw new Error('EIO'); return { byAccount: { 'claude-default': 1 } }; },
      days: async ({ from, to }) => { t.ranges.push([dayKey(from), dayKey(to)]); if (t.fail) throw new Error('EIO'); return { '2026-11-14': { 'claude-default': 2 }, '2026-11-15': { 'claude-default': 4 }, '1999-01-01': { 'claude-default': 99 }, nonsense: 5 }; },
    },
  });
  await assert.rejects(spend.dollars('claude-default'), /EIO/);
  assert.equal(spend.state.closed, '2026-11-13');
  assert.match(t.logs.join('\n'), /could not count the days that are over \(EIO\)/);
  t.fail = false;
  // Two asks at once share one count of the days that are over.
  const [a, b] = await Promise.all([spend.dollars('claude-default'), spend.dollars('claude-default')]);
  assert.deepEqual(a, { unit: 'usd', today: 1, month: 2 + 4 + 1, since: midnight(10) });
  assert.deepEqual(b, a);
  assert.deepEqual(t.ranges, [['2026-11-14', '2026-11-16'], ['2026-11-14', '2026-11-16']], 'from the day after the last one counted, up to today; once that failed and once that worked');
  assert.deepEqual(Object.keys(t.saved.days).sort(), ['2026-11-14', '2026-11-15', '2026-11-16'], 'only days from the range asked for are kept');
});

// ---- Codex: dollars from tokens ----

// A turn's tokens as a Codex turn reports them: fresh input, cached input, input written to the cache, output.
const used = (inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens) => ({ inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens, thinkingTokens: 999, webSearchRequests: 3 });
const cents = (n) => Math.round(n * 1e6) / 1e6;

test('Codex: each turn is kept by model and speed and by kind of token, and priced at list prices when read', () => {
  const { t, make, done } = setup({ clock: at(16, 600) });
  try {
    const spend = make();
    assert.deepEqual(spend.codex('codex-default'), { unit: 'usd', today: 0, month: 0, since: null });
    assert.equal(spend.codexChat('thread-1'), null);
    // gpt-6.1-sol at standard speed: $2 a million in, $0.10 cached, $2.50 written to the cache, $10 out.
    spend.addTurn('thread-1', null, { model: 'gpt-6.1-sol', tier: null, usage: used(1e6, 1e6, 1e6, 1e6) }, at(16, 100));
    assert.equal(cents(spend.codex('codex-default').today), 14.6);
    // The same tokens with Fast on cost twice that; another chat on a cheaper model.
    spend.addTurn('thread-1', 'codex-default', { model: 'gpt-6.1-sol', tier: 'priority', usage: used(1e6, 1e6, 1e6, 1e6) }, at(16, 200));
    spend.addTurn('thread-2', null, { model: 'gpt-6-luna', tier: 'default', usage: used(2e6, 0, 0, 1e6) }, at(16, 300));
    for (const bad of [null, undefined, {}, { usage: null }, { model: 'gpt-6.1-sol', usage: used(0, -5, NaN, '100') }, { model: 'gpt-6.1-sol', usage: 'x' }]) spend.addTurn('thread-1', null, bad, at(16, 400));
    const now = spend.codex('codex-default');
    assert.deepEqual([cents(now.today), cents(now.month), now.since, 'unpriced' in now], [14.6 + 29.2 + 0.7, 14.6 + 29.2 + 0.7, NOV16, false]);
    assert.deepEqual([spend.codexChat('thread-1'), spend.codexChat('thread-2'), spend.codexChat('thread-3')].map((c) => c && [cents(c.amount), c.unpriced]), [[43.8, 0], [0.7, 0], null]);
    assert.deepEqual(spend.codex('claude-default'), { unit: 'usd', today: 0, month: 0, since: NOV16 }, 'another account’s turns are not this one’s');
    assert.deepEqual(t.saved.codexDays['2026-11-16']['codex-default'], { 'gpt-6.1-sol|': [1e6, 1e6, 1e6, 1e6], 'gpt-6.1-sol|priority': [1e6, 1e6, 1e6, 1e6], 'gpt-6-luna|': [2e6, 0, 0, 1e6] }, 'the tokens are what is kept, not the dollars: a price that changes is right from then on');
    assert.ok(!JSON.stringify(t.saved).includes('999'), 'reasoning is inside the output, and is not counted a second time');
    // The next day, after a restart.
    t.now = at(17, 60);
    const later = make();
    later.addTurn('thread-1', null, { model: 'gpt-6.1-sol', tier: null, usage: used(0, 0, 0, 1e6) });
    const next = later.codex('codex-default');
    assert.deepEqual([cents(next.today), cents(next.month)], [10, 54.5]);
    assert.equal(cents(later.codexChat('thread-1').amount), 53.8);
  } finally { done(); }
});

test('Codex: a model with no known price is never priced, and its tokens are handed back as tokens', () => {
  const { t, make, done } = setup({ clock: at(17, 600) });
  try {
    // What was counted before the tokens were kept apart: one total a day and a chat, which no price fits.
    t.saved = { v: 1, since: '2026-11-17', closed: '2026-11-16', tokenDays: { '2026-11-17': { 'codex-default': 16_000_000 } }, tokenChats: { 'thread-old': { n: 7_000_000, at: at(17, 100) } } };
    const spend = make();
    assert.deepEqual(spend.codex('codex-default'), { unit: 'usd', today: 0, month: 0, since: midnight(17), unpriced: { today: 16_000_000, month: 16_000_000, models: [] } });
    assert.deepEqual(spend.codexChat('thread-old'), { amount: 0, unpriced: 7_000_000 });
    spend.addTurn('thread-old', null, { model: 'gpt-7-nova', tier: null, usage: used(100, 200, 300, 400) });
    spend.addTurn('thread-old', null, { model: 'gpt-6-sol', tier: 'ultrafast', usage: used(0, 0, 0, 50) }); // a speed OpenAI lists no price for on this model
    spend.addTurn('thread-old', null, { model: null, tier: null, usage: used(0, 0, 0, 7) });
    spend.addTurn('thread-old', null, { model: 'gpt-6-sol', tier: null, usage: used(0, 0, 0, 1e6) });
    const now = spend.codex('codex-default');
    assert.deepEqual([cents(now.today), now.unpriced], [10, { today: 16_001_057, month: 16_001_057, models: ['gpt-6-sol', 'gpt-7-nova'] }]);
    assert.deepEqual(spend.codexChat('thread-old'), { amount: 10, unpriced: 7_001_057 });
  } finally { done(); }
});

// ---- what is kept ----

test('saved state: read back as it was, garbage dropped, and old days and long-unused chats let go', async () => {
  const { t, make, done } = setup({ clock: at(16, 600) });
  try {
    t.saved = {
      v: 1, since: '2026-09-01', closed: '2026-11-15', secret: 'sk-ant-should-not-survive',
      chats: {
        'chat-ok': { seen: '2026-11-15', spans: [[at(15, 10), 'key-1'], ['bad'], [at(15, 20)], [at(15, 30), 7]] },
        'chat-old': { seen: '2026-08-01', spans: [[1, 'key-1']] },
        'chat-empty': { seen: '2026-11-15', spans: [] }, 'chat-junk': 'nope',
      },
      days: { '2026-11-15': { 'claude-default': 3, bad: -1, worse: 'x' }, '2026-08-01': { 'claude-default': 9 }, 'not-a-day': { a: 1 }, '2026-11-14': 'x' },
      tokenDays: { '2026-11-15': { 'codex-default': 10 } }, tokenChats: { 'thread-1': { n: 10, at: at(15, 5) }, 'thread-bad': { n: 'x' } },
      codexDays: { '2026-11-15': { 'codex-default': { 'gpt-6.1-sol|': [1, 2, 3, 4, 5], 'no-bar': [1, 1, 1, 1], 'gpt-6-sol|': 'x', 'gpt-6-luna|': [0, -1, 'x'] }, bad: 7 }, nope: {} },
      codexChats: { 'thread-1': { at: at(15, 5), use: { 'gpt-6.1-sol|priority': [1, 0, 0, 2] } }, 'thread-bad': { at: 1, use: { x: 1 } } },
    };
    const spend = make();
    assert.deepEqual(spend.state.chats['chat-ok'].spans, [[at(15, 10), 'key-1']]);
    assert.deepEqual(Object.keys(spend.state.chats).sort(), ['chat-ok', 'chat-old']);
    assert.deepEqual(spend.state.days, { '2026-11-15': { 'claude-default': 3 }, '2026-08-01': { 'claude-default': 9 } });
    assert.deepEqual(spend.state.tokenChats, { 'thread-1': { n: 10, at: at(15, 5) } });
    assert.deepEqual(spend.state.codexDays, { '2026-11-15': { 'codex-default': { 'gpt-6.1-sol|': [1, 2, 3, 4] } } });
    assert.deepEqual(spend.state.codexChats, { 'thread-1': { at: at(15, 5), use: { 'gpt-6.1-sol|priority': [1, 0, 0, 2] } } });
    spend.addTurn('thread-1', null, { model: 'gpt-6.1-sol', usage: { outputTokens: 5 } });
    const out = t.saved;
    assert.deepEqual(Object.keys(out).sort(), ['chats', 'closed', 'codexChats', 'codexDays', 'days', 'since', 'tokenChats', 'tokenDays', 'v'], 'only its own fields are ever written');
    assert.ok(!JSON.stringify(out).includes('sk-ant'));
    assert.deepEqual(Object.keys(out.days), ['2026-11-15'], 'a day from three months back is gone');
    assert.deepEqual(Object.keys(out.chats), ['chat-ok'], 'and so is a chat not opened since');
    out.days['2026-11-15']['claude-default'] = 999;
    assert.equal(spend.state.days['2026-11-15']['claude-default'], 3, 'the host is handed a copy');

    // Unreadable or missing state starts from nothing, and a host whose save throws is survived.
    for (const bad of [null, undefined, 'x', 42, [], () => { throw new Error('unreadable'); }]) {
      const s = new AccountSpend({ load: typeof bad === 'function' ? bad : () => bad, save: () => { throw new Error('disk full'); }, now: () => at(16, 600), log: (m) => t.logs.push(m) });
      assert.deepEqual([s.state.since, s.state.closed, Object.keys(s.state.chats).length], [null, null, 0]);
      s.addTurn('thread-9', 'codex-default', { model: 'gpt-6.1-sol', usage: { outputTokens: 1e6 } });
      assert.equal(s.codexChat('thread-9').amount, 10);
    }
    assert.match(t.logs.join('\n'), /save failed: disk full/);
  } finally { done(); }
});

test('counting again with nothing new writes nothing', async () => {
  const { t, make, write, done } = setup();
  try {
    write('a', [reply(at(16, 100), 'a1', 1)]);
    const spend = make();
    await spend.dollars('claude-default');
    const saves = t.saves;
    await spend.dollars('claude-default');
    await spend.dollars('key-1');
    assert.equal(t.saves, saves);
  } finally { done(); }
});

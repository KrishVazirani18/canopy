// The Usage tab's words (renderer/src/lib/usage-rules.ts): how a window, an amount, a moment and an account read.
// The file is plain TypeScript with no run-time imports, so node runs it as it is: no build and no window.
// Times are pinned to en-US so the test reads the same on any Mac; the window itself uses the Mac's own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as R from '../../../../renderer/src/lib/usage-rules.ts';

const US = 'en-US';
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime(); // November 2026, local time
const acct = (over) => ({ id: 'claude-default', engine: 'claude', kind: 'plan', label: 'Max', email: 'me@example.com', org: null, plan: 'max', via: null, keyHint: null, state: 'ok', why: null, found: true, ...over });
const section = (over = {}) => ({ engine: 'claude', account: acct({}), shape: 'plan', at: null, loading: false, error: null, plan: 'max', windows: [], extra: null, credits: null, near: null, offer: null, ...over });

test('a window: its percent, its bar, and amber only at 90 and above', () => {
  assert.deepEqual([0, 0.4, 1, 33.5, 89.6, 99.4, 100, 140, -3].map(R.percentText), ['0%', '<1%', '1%', '34%', '90%', '99%', '100%', '100%', '0%']);
  assert.deepEqual([0, 0.4, 34, 100, 140].map(R.barWidth), [1.5, 1.5, 34, 100, 100], 'never too thin to see, never past the end');
  const now = at(16, 14);
  assert.deepEqual([89.9, 90, 100].map((percent) => R.isHot({ percent, resetsAt: now + 1 }, now)), [false, true, true]);
  assert.equal(R.isHot({ percent: 95, resetsAt: null }, now), true, 'no reset time known: the number stands');
  assert.deepEqual([now, now - 3_600_000].map((resetsAt) => R.isHot({ percent: 95, resetsAt }, now)), [false, false], 'a window that has started over since it was read is not shown as near its limit');
  assert.equal(R.HOT, 90);
});

test('when a window starts over: the time today, the weekday this week, the date beyond, and nothing once it has passed', () => {
  const now = at(16, 14, 5); // Monday 2:05 PM
  assert.equal(R.resetText(at(16, 15, 40), now, US), 'Resets 3:40 PM');
  assert.equal(R.resetText(at(16, 23, 59), now, US), 'Resets 11:59 PM');
  assert.equal(R.resetText(at(17, 0, 30), now, US), 'Resets Tue 12:30 AM', 'after midnight is tomorrow, and says so');
  assert.equal(R.resetText(at(21, 23, 0), now, US), 'Resets Sat 11:00 PM');
  assert.equal(R.resetText(at(23, 9, 0), now, US), 'Resets Nov 23', 'a week out, the same weekday would read as today');
  assert.equal(R.resetText(new Date(2026, 11, 14, 9).getTime(), now, US), 'Resets Dec 14');
  for (const none of [null, undefined, now, now - 1, at(15, 9), NaN, '2026-11-17']) assert.equal(R.resetText(none, now, US), '');
  assert.match(R.resetText(at(16, 15, 40), now), /^Resets /, 'with no locale given it still answers, in the Mac’s own');
});

test('how old the numbers are', () => {
  const now = at(16, 14);
  const ago = (ms) => R.ageText(now - ms, now, US);
  assert.deepEqual([0, 59_000, 60_000, 150_000, 59 * 60_000, 60 * 60_000, 5 * 3_600_000, 23.9 * 3_600_000].map(ago),
    ['Updated just now', 'Updated just now', 'Updated 1 min ago', 'Updated 2 min ago', 'Updated 59 min ago', 'Updated 1 hr ago', 'Updated 5 hr ago', 'Updated 23 hr ago']);
  assert.equal(ago(3 * 86_400_000), 'Updated Nov 13');
  assert.equal(R.ageText(now + 5000, now, US), 'Updated just now', 'a clock that moved back is not a negative age');
});

test('amounts: dollars as Home writes them, tokens as the context meter does', () => {
  // Home's strip writes `$${n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString()}`: the two must read the same.
  const home = (n) => `$${n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
  for (const n of [0, 0.004, 0.31, 1.84, 27.4, 999.994, 999.996, 1000, 12345.6]) assert.equal(R.money(n), home(n), String(n));
  assert.deepEqual([0, 0.31, 27.4].map(R.money), ['$0.00', '$0.31', '$27.40']);
  assert.deepEqual([0, 1, 950, 1000, 12_345, 99_949, 100_000, 999_499, 999_500, 1_000_000, 1_250_000, -5, 2.6].map(R.tokenText),
    ['0 tokens', '1 token', '950 tokens', '1.0k tokens', '12.3k tokens', '99.9k tokens', '100k tokens', '999k tokens', '1M tokens', '1M tokens', '1.3M tokens', '0 tokens', '3 tokens']);
});

test('billed per use: Today, This chat only when it is this account’s chat, and the month named for what was counted', () => {
  const usd = { unit: 'usd', today: 1.84, month: 27.4, since: null, chat: 0.31 };
  assert.deepEqual(R.countRows(usd, US), [['Today', '$1.84'], ['This chat', '$0.31'], ['This month', '$27.40']]);
  assert.deepEqual(R.countRows({ ...usd, chat: null }, US), [['Today', '$1.84'], ['This month', '$27.40']]);
  assert.deepEqual(R.countRows({ ...usd, chat: 0, since: at(16, 0) }, US), [['Today', '$1.84'], ['This chat', '$0.00'], ['Since Nov 16', '$27.40']], 'counting began mid-month: it says since when, not "this month"');
  assert.equal(R.countNote(section({ shape: 'spend', account: acct({ kind: 'console', label: 'Console' }) })), 'Counted from chats in Canopy.');
  assert.equal(R.countNote(section({ shape: 'spend', account: acct({ kind: 'key', label: 'API key' }) })), 'Counted from chats in Canopy.');
  assert.equal(R.countNote(section({ shape: 'spend', account: acct({ kind: 'external', via: 'bedrock', label: 'Amazon Bedrock' }) })), 'Counted from chats in Canopy. Limits are tracked by your provider.');
});

test('billed per use: no line that only repeats Today, and a chat that holds more than today says it is the whole chat', () => {
  // What was on screen on the day counting began: the month's line said the same as Today, and the chat said more.
  const day = { unit: 'usd', today: 491.42, month: 491.42, since: at(17, 0), chat: 675.13 };
  assert.deepEqual(R.countRows(day, US), [['Today', '$491.42'], ['This chat, in total', '$675.13']]);
  assert.deepEqual(R.countRows({ ...day, chat: null }, US), [['Today', '$491.42']]);
  assert.deepEqual(R.countRows({ ...day, since: null, chat: 12 }, US), [['Today', '$491.42'], ['This chat', '$12.00']], 'the first of a month: "This month" would repeat Today too');
  assert.deepEqual(R.countRows({ ...day, month: 491.424, chat: 491.423 }, US), [['Today', '$491.42'], ['This chat', '$491.42']], 'what reads the same is the same');
  assert.deepEqual(R.countRows({ ...day, month: 600, chat: 491.42 }, US), [['Today', '$491.42'], ['This chat', '$491.42'], ['Since Nov 17', '$600.00']], 'the day after, the longer line is back');
});

test('Codex reads in dollars like Claude; tokens with no known price are shown as tokens, and the line under says why', () => {
  const key = acct({ engine: 'codex', kind: 'key', label: 'API key', email: null, plan: null });
  const codex = (count) => section({ engine: 'codex', shape: 'spend', account: key, count });
  const usd = { unit: 'usd', today: 3.2, month: 41.07, since: null, chat: 1.05 };
  assert.deepEqual(R.countRows(usd, US), [['Today', '$3.20'], ['This chat', '$1.05'], ['This month', '$41.07']], 'the same rows as Claude’s');
  assert.equal(R.countNote(codex(usd)), 'Counted from chats in Canopy. Worked out from tokens at OpenAI’s list prices.');
  assert.ok(!R.countRows(usd, US).flat().join(' ').includes('≈'), 'list prices times counted tokens: not marked as a guess');
  // A model with no price in the list: its tokens, beside the dollars the others cost.
  const mixed = { ...usd, unpriced: { today: 12_345, month: 1_250_000, chat: 0, models: ['gpt-7-nova'] } };
  assert.deepEqual(R.countRows(mixed, US), [['Today', '$3.20 + 12.3k tokens'], ['This chat', '$1.05'], ['This month', '$41.07 + 1.3M tokens']]);
  assert.equal(R.countNote(codex(mixed)), 'Counted from chats in Canopy. Worked out from tokens at OpenAI’s list prices. Price not known for gpt-7-nova, so its tokens are shown instead.');
  // Nothing priced at all: tokens alone, never "$0.00" or a made-up number.
  const none = { unit: 'usd', today: 0, month: 0, since: at(17, 0), chat: 0, unpriced: { today: 16_400_000, month: 16_400_000, chat: 5_900_000, models: ['gpt-7-nova', 'gpt-7-luna'] } };
  assert.deepEqual(R.countRows(none, US), [['Today', '16.4M tokens'], ['This chat', '5.9M tokens']]);
  assert.match(R.countNote(codex(none)), /Price not known for gpt-7-nova and gpt-7-luna, so their tokens are shown instead\.$/);
  assert.match(R.countNote(codex({ ...none, unpriced: { ...none.unpriced, models: [] } })), /Some tokens have no known price, and are shown as tokens\.$/, 'tokens counted before their model was kept');
  assert.match(R.countNote(codex({ ...none, unpriced: { ...none.unpriced, models: ['a', 'b', 'c'] } })), /for a, b and c, so their/);
  assert.deepEqual(R.countRows({ ...usd, unpriced: { today: 0, month: 0, chat: 800, models: [] } }, US)[1], ['This chat, in total', '$1.05 + 800 tokens']);
});

test('extra usage and credits, in a few words', () => {
  const e = (over) => ({ enabled: true, percent: null, used: null, limit: null, currency: 'USD', ...over });
  assert.equal(R.extraText(e({ enabled: false, used: 5, limit: 50 }), US), 'Off');
  assert.equal(R.extraText(e({ used: 12.34, limit: 50, percent: 24.68 }), US), '$12.34 of $50.00');
  assert.equal(R.extraText(e({ used: 2.5 }), US), '$2.50 spent');
  assert.equal(R.extraText(e({ percent: 24.68 }), US), '25% used');
  assert.equal(R.extraText(e({}), US), 'On');
  assert.equal(R.extraText(e({ used: 1200, limit: 5000, currency: 'JPY' }), US), '¥1,200 of ¥5,000');
  assert.equal(R.extraText(e({ used: 1.5, limit: 3, currency: 'ZZ' }), US), '1.50 ZZ of 3.00 ZZ', 'a currency the Mac does not know is written out, never dropped');
  assert.deepEqual([R.creditsText({ unlimited: true, balance: '5' }), R.creditsText({ unlimited: false, balance: '12.50' }), R.creditsText({ unlimited: false, balance: null })], ['Unlimited', '12.50', null]);
});

test('the line under the maker’s name: which account, and how it is paid for or what is wrong', () => {
  assert.deepEqual(R.MAKER, { claude: 'Claude', codex: 'Codex' });
  assert.equal(R.accountLine(section()), 'Max · me@example.com');
  assert.equal(R.accountLine(section({ plan: null, account: acct({ plan: 'pro', label: 'Pro' }) })), 'Pro · me@example.com', 'before the first read, the plan as the sign-in check named it');
  assert.equal(R.accountLine(section({ plan: 'max', account: acct({ plan: 'claude ultra', label: 'Claude ultra' }) })), 'Max · me@example.com', 'usage()’s name for the plan wins');
  assert.equal(R.accountLine(section({ plan: 'something_new', account: acct({ email: null }) })), 'Something_new');
  assert.equal(R.accountLine(section({ engine: 'codex', plan: 'pro', account: acct({ engine: 'codex', label: 'ChatGPT Pro', plan: 'pro' }) })), 'ChatGPT Pro · me@example.com');
  const spend = (a) => R.accountLine(section({ shape: 'spend', account: acct(a) }));
  // Each part of the line starts with a capital, for either maker.
  assert.equal(spend({ kind: 'console', label: 'Console' }), 'Console · Billed per use');
  assert.equal(spend({ kind: 'key', label: 'API key ••••4f2a' }), 'API key ••••4f2a · Billed per use');
  assert.equal(spend({ kind: 'external', via: 'ANTHROPIC_API_KEY', label: 'API key' }), 'API key · Billed per use');
  assert.equal(spend({ kind: 'external', via: 'bedrock', label: 'Amazon Bedrock' }), 'Amazon Bedrock · Billed by your provider');
  assert.equal(R.accountLine(section({ engine: 'codex', shape: 'spend', account: acct({ engine: 'codex', kind: 'key', label: 'API key', email: null }) })), 'API key · Billed per use');
  const wrong = (state, why = null) => R.accountLine(section({ shape: 'attention', account: acct({ state, why }) }));
  assert.deepEqual(['signed-out', 'expired', 'mismatch', 'missing', 'locked', 'invalid-key'].map((s) => wrong(s)),
    ['Max · Signed out', 'Max · Signed out', 'Max · Using a different login', 'Max · Its folder is missing', 'Max · Keychain is locked', 'Max · Key no longer works']);
  assert.equal(wrong('blocked', 'your Claude Code settings choose the login'), 'Max · Your Claude Code settings choose the login');
  assert.equal(wrong('blocked'), 'Max · Your settings choose the login');
});

test('an account that needs you: what to do, in words that fit what it is', () => {
  const say = (over, engine = 'claude') => R.attentionText(section({ engine, shape: 'attention', account: acct(over) }));
  assert.equal(say({ state: 'signed-out' }), 'Sign in again to see this account’s limits.');
  assert.equal(say({ state: 'expired', kind: 'console' }), 'Sign in again to see this account’s usage.');
  assert.equal(say({ state: 'mismatch' }), 'Claude Code is signed in as someone else, so this account’s limits can’t be read.');
  assert.equal(say({ state: 'mismatch', engine: 'codex' }, 'codex'), 'Codex is signed in as someone else, so this account’s limits can’t be read.');
  assert.match(say({ state: 'missing' }), /folder is missing/);
  assert.match(say({ state: 'locked', kind: 'key' }), /Keychain, so its usage can’t be read\.$/);
  assert.match(say({ state: 'invalid-key', kind: 'key' }), /no longer works/);
  assert.match(say({ state: 'blocked' }), /can’t be used right now/);
});

test('near a limit: one plain line, and a button that names what it switches to', () => {
  const near = (key, percent, label = 'x') => R.nearText({ key, label, percent });
  assert.deepEqual([near('five_hour', 93), near('five_hour', 100), near('seven_day', 90), near('seven_day', 100)],
    ['Almost at this session’s limit.', 'This session’s limit is reached.', 'Almost at this week’s limit.', 'This week’s limit is reached.']);
  assert.deepEqual([near('model:Fable', 95, 'Fable this week'), near('primary', 100, 'Current window')], ['Fable this week is almost at its limit.', 'Current window is at its limit.']);
  assert.equal(R.offerLabel({ id: 'k', label: 'API key ••••4f2a' }), 'Use API key');
  assert.equal(R.offerLabel({ id: 'k', label: 'API key' }), 'Use API key');
  assert.equal(R.offerLabel({ id: 'c', label: 'Console' }), 'Use Console');
  assert.deepEqual(R.switchedText({ id: 'c', label: 'Console' }), { title: 'New chats use Console', description: 'Open chats stay on the account they started on.' });
  assert.equal(R.switchedText({ id: 'k', label: 'API key ••••4f2a' }).title, 'New chats use your API key');
});

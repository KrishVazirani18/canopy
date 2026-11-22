// Usage limits in one shape for both makers (src/core/limits.mjs): what Claude Code's usage answer and Codex's
// rate-limit snapshot become, how a sparse Codex update is laid over the last snapshot, and the exact words of the
// two notices and of a limit's row. Pure: no process, no window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as L from '../../limits.mjs';

const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

test('Claude: each window with a reading becomes a limit, named as Claude Code names it', () => {
  const resets = '2026-11-16T23:10:00.000Z';
  const usage = { rateLimitsAvailable: true, rateLimits: {
    five_hour: { utilization: 42.4, resets_at: resets }, seven_day: { utilization: 81, resets_at: null },
    seven_day_opus: { utilization: null, resets_at: resets }, seven_day_sonnet: null, seven_day_oauth_apps: { utilization: 3, resets_at: resets },
    model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: resets }, { display_name: '', utilization: 5, resets_at: null }],
    extra_usage: { is_enabled: true, utilization: 50 },
  } };
  assert.deepEqual(L.limitsFromClaude(usage), [
    { id: 'five_hour', name: '5-hour limit', usedPercent: 42, resetsAt: Date.parse(resets) },
    { id: 'weekly', name: 'weekly limit', usedPercent: 81, resetsAt: null },
    { id: 'weekly_fable', name: 'weekly Fable limit', usedPercent: 12, resetsAt: Date.parse(resets) },
  ]);
  // The raw answer and the windows object alone read the same.
  assert.equal(L.limitsFromClaude({ rate_limits: usage.rateLimits }).length, 3);
  assert.equal(L.limitsFromClaude(usage.rateLimits).length, 3);
});

test('Claude: an API key login, a failed read and nonsense all have no limits', () => {
  for (const v of [null, undefined, 5, 'x', [], {}, { rateLimitsAvailable: false, rateLimits: null }, { rateLimits: 7 }, { rate_limits: { five_hour: { utilization: 'lots' } } }]) {
    assert.deepEqual(L.limitsFromClaude(v), []);
  }
});

test('Codex: the primary and secondary windows are named by how long they are', () => {
  const snapshot = { limitId: 'codex', limitName: null, primary: { usedPercent: 42.2, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: null }, credits: null, rateLimitReachedType: null };
  const want = [
    { id: 'five_hour', name: '5-hour limit', usedPercent: 42, resetsAt: 1794805200000 },
    { id: 'weekly', name: 'weekly limit', usedPercent: 12, resetsAt: null },
  ];
  assert.deepEqual(L.limitsFromCodex(snapshot), want);
  assert.deepEqual(L.limitsFromCodex({ rateLimits: snapshot, rateLimitsByLimitId: null }), want, 'the answer to account/rateLimits/read');
  assert.deepEqual(L.windowName(300), { id: 'five_hour', name: '5-hour limit' });
  assert.deepEqual(L.windowName(10080), { id: 'weekly', name: 'weekly limit' });
  assert.deepEqual(L.windowName(1440), { id: '1_day', name: '1-day limit' });
  assert.deepEqual(L.windowName(43200), { id: '30_day', name: '30-day limit' });
  assert.deepEqual(L.windowName(180), { id: '3_hour', name: '3-hour limit' });
  assert.deepEqual(L.windowName(null), { id: 'usage', name: 'usage limit' });
});

test('Codex: no snapshot (an API key), an empty one and nonsense all have no limits', () => {
  for (const v of [null, undefined, 3, 'x', [], {}, { rateLimits: null }, { primary: null, secondary: null }, { primary: { usedPercent: 'x' } }]) {
    assert.deepEqual(L.limitsFromCodex(v), []);
  }
  assert.equal(L.limitsFromCodex({ primary: { usedPercent: 250, windowDurationMins: 300 } })[0].usedPercent, 100, 'never more than all of it');
});

test('a sparse Codex update is laid over the last snapshot', () => {
  const have = { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2 }, planType: 'plus', rateLimitReachedType: 'rate_limit_reached' };
  const next = L.mergeCodex(have, { limitId: null, primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1 }, secondary: null, planType: null, rateLimitReachedType: null });
  assert.equal(next.primary.usedPercent, 55);
  assert.deepEqual(next.secondary, have.secondary, 'a window the update does not mention keeps its last reading');
  assert.equal(next.planType, 'plus');
  assert.equal(next.rateLimitReachedType, null, 'reached is not sticky');
  assert.deepEqual(L.mergeCodex(null, null), {});
  assert.deepEqual(L.mergeCodex(null, { primary: { usedPercent: 1 } }), { primary: { usedPercent: 1 } });
  assert.equal(have.primary.usedPercent, 40, 'the snapshot handed in is not changed');
});

test('the reached notice: the words a Claude chat has always used, with the limit named', () => {
  const t = at(15, 10);
  assert.equal(L.reachedText({ name: '5-hour limit', resetsAt: t }), `Usage limit reached (5-hour limit). It resets at ${clock(t)}.`);
  assert.equal(L.reachedText({ name: 'weekly limit' }), 'Usage limit reached (weekly limit).');
  assert.equal(L.reachedText({ resetsAt: t }), `Usage limit reached. It resets at ${clock(t)}.`);
  assert.equal(L.reachedText(null), 'Usage limit reached.');
  const later = Date.now() + 3 * 86400000;
  assert.match(L.reachedText({ name: 'weekly limit', resetsAt: later }), /^Usage limit reached \(weekly limit\)\. It resets on \w+, \w+ \d+ at /);
});

test('the nearing notice: the limit, how much is used, when it resets', () => {
  const t = at(15, 10);
  assert.equal(L.nearingText({ name: '5-hour limit', usedPercent: 82, resetsAt: t }), `Approaching your usage limit (5-hour limit, 82% used). It resets at ${clock(t)}.`);
  assert.equal(L.nearingText({ name: 'weekly limit' }), 'Approaching your usage limit (weekly limit).');
  assert.equal(L.nearingText({ usedPercent: 91 }), 'Approaching your usage limit (91% used).');
  assert.equal(L.nearingText({}), 'Approaching your usage limit.');
  assert.equal(L.NEARING_PERCENT, 80);
});

test('a limit as a row: its name, how much is used, when it resets', () => {
  const now = at(9, 0);
  const t = at(15, 10);
  assert.equal(L.limitLine({ name: '5-hour limit', usedPercent: 42, resetsAt: t }, now), `5-hour limit · 42% used · resets ${clock(t)}`);
  assert.equal(L.limitLine({ name: 'weekly limit', usedPercent: 12, resetsAt: null }, now), 'Weekly limit · 12% used');
  const soon = t + 2 * 86400000;
  assert.match(L.limitLine({ name: 'weekly limit', usedPercent: 12, resetsAt: soon }, now), /^Weekly limit · 12% used · resets \w+ \d+:\d\d/);
  const far = t + 20 * 86400000;
  assert.match(L.limitLine({ name: 'weekly limit', usedPercent: 12, resetsAt: far }, now), /^Weekly limit · 12% used · resets \w+ \d+$/);
  for (const v of [null, 5, {}, { name: '' }]) assert.equal(L.limitLine(v), '');
});

test('what crosses to the window is only well-formed rows', () => {
  const good = { id: 'five_hour', name: '5-hour limit', usedPercent: 42, resetsAt: 5 };
  assert.deepEqual(L.cleanLimits([good, null, { id: 'x' }, { ...good, extra: 1, resetsAt: 'soon' }]), [good, { ...good, resetsAt: null }]);
  assert.deepEqual(L.cleanLimits('nope'), []);
  assert.equal(L.cleanLimits(Array.from({ length: 20 }, () => good)).length, 8);
});

test('nothing here throws on input that cannot be read', () => {
  const hostile = new Proxy({}, { get() { throw new Error('no'); }, has() { throw new Error('no'); }, ownKeys() { throw new Error('no'); } });
  assert.deepEqual(L.limitsFromClaude(hostile), []);
  assert.deepEqual(L.limitsFromCodex(hostile), []);
  assert.equal(L.when('not a time'), '');
});

// A Claude chat's usage limits (Session.contextUsage().limits): read from Claude Code's own usage answer in the one
// shape both makers share (limits.mjs), asked at most once a minute, never waited on for long, and [] for a login
// with no plan limits. Driven by the scripted fake of the SDK's query() (fake-query.mjs): no claude process starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { core, sleep, watch, within } from '../helpers.mjs';

const S = await core('session.mjs');
const missing = S.__missing ? `session.mjs: ${S.__missing}` : false;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-session-limits-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
});
function make(script = {}) {
  const fake = createFake(script);
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, queryFn: fake.queryFn });
  open.push(s);
  return { s, fake, w: watch(s) };
}
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const usageCalls = (fake) => fake.current.calls.filter((c) => c.method === 'usage');
const RESETS = '2026-11-16T23:10:00.000Z';
const plan = (five = 42) => ({ session: {}, subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: five, resets_at: RESETS }, seven_day: { utilization: 12, resets_at: null }, seven_day_opus: null } });

test('contextUsage() carries the plan\'s limits beside the context reading', { skip: missing }, async () => {
  const { s, fake } = make({ controls: { usage: () => plan() } });
  await s.warm();
  const u = await s.contextUsage();
  assert.deepEqual([u.totalTokens, u.maxTokens, u.percentage], [1200, 200000, 0.6], 'the context reading is what it always was');
  assert.deepEqual(u.limits, [
    { id: 'five_hour', name: '5-hour limit', usedPercent: 42, resetsAt: Date.parse(RESETS) },
    { id: 'weekly', name: 'weekly limit', usedPercent: 12, resetsAt: null },
  ]);
  assert.deepEqual(usageCalls(fake).map((c) => c.args[0]), [{ skipBehaviors: true }], 'asked without the slow scan of local transcripts');
  assert.deepEqual((await s.contextUsage({ detail: 'full' })).limits, u.limits, 'the full reading has them too');
});

test('the limits are asked for at most once a minute, however often the ring is read', { skip: missing }, async () => {
  const { s, fake, w } = make({ controls: { usage: () => plan() } });
  await s.warm();
  await s.contextUsage();
  for (let i = 0; i < 3; i++) { s.send('hi'); await idle(w, w.mark()); await s.contextUsage(); }
  assert.ok(fake.current.calls.filter((c) => c.method === 'getContextUsage').length >= 3, 'the context itself is read again after each turn');
  assert.equal(usageCalls(fake).length, 1);
  // A minute later it is asked again.
  s.limitsCache.at -= 61000;
  s.ctxCache = null;
  await s.contextUsage();
  assert.equal(usageCalls(fake).length, 2);
});

test('a login with no plan limits, and a Claude Code that cannot say, both give []', { skip: missing }, async () => {
  const none = make(); // the fake's own answer: rate_limits_available false, rate_limits null (an API key)
  await none.s.warm();
  assert.deepEqual((await none.s.contextUsage()).limits, []);

  const broken = make({ controls: { usage() { throw new Error('nope'); } } });
  await broken.s.warm();
  const u = await broken.s.contextUsage();
  assert.equal(u.totalTokens, 1200, 'the ring still gets its reading');
  assert.deepEqual(u.limits, []);
  assert.equal(broken.w.all((e) => e.kind === 'error' || e.kind === 'notice').length, 0, 'and nobody is told');
});

test('a slow answer is never waited on for long: the ring gets its reading, the limits follow next time', { skip: missing }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { s } = make({ controls: { usage: async () => { await gate; return plan(77); } } });
  await s.warm();
  const started = Date.now();
  const u = await s.contextUsage();
  const took = Date.now() - started;
  assert.ok(took >= 1900 && took < 4000, `waited about 2 s, not for the answer (${took} ms)`);
  assert.deepEqual(u.limits, []);
  release();
  await sleep(30);
  s.ctxCache = null;
  assert.deepEqual((await s.contextUsage()).limits.map((l) => [l.id, l.usedPercent]), [['five_hour', 77], ['weekly', 12]]);
});

test('no process, no answer, as before', { skip: missing }, async () => {
  const { s } = make({ controls: { usage: () => plan() } });
  assert.equal(await s.contextUsage(), null);
});

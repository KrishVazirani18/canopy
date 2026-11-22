// Session and the login it is launched on: where the environment comes from (a getter that cannot answer stops
// the start, it never falls back), the folder your home memory is read from, the account Claude Code reports at
// startup, and limit updates kept in full. Driven by the scripted fake of the SDK's query() (fake-query.mjs): no
// claude process is started and no login is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { core, sleep, watch, within } from '../helpers.mjs';

const S = await core('session.mjs');
const missing = S.__missing ? `session.mjs: ${S.__missing}` : false;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-session-launch-'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SHELL = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/Users/someone', LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work', MY_VAR: 'kept' });

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

// ---- reading from the folder the chat's Claude Code uses ----

test('your home memory is read from the folder in the chat’s environment, not this process’s', { skip: missing }, async () => {
  const config = path.join(root, 'shell-config');
  const slug = SHELL.HOME.replace(/[^a-zA-Z0-9]/g, '-'); // the home folder is the chat's too: its HOME names it
  fs.mkdirSync(path.join(config, 'projects', slug, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(config, 'projects', slug, 'memory', 'MEMORY.md'), '- prefers tabs over spaces\n');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'the-apps-own-empty-folder');
  try {
    const { s, fake, w } = make({ personalMemory: true, env: { ...SHELL, CLAUDE_CONFIG_DIR: config } });
    s.send('hi');
    await idle(w);
    assert.match(fake.current.options.systemPrompt.append ?? '', /prefers tabs over spaces/);
  } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
});

// ---- failing closed ----

test('an environment getter that throws stops the start: nothing is launched, and the message comes back', { skip: missing }, async () => {
  let fail = true;
  const { s, fake, w } = make({ env: () => { if (fail) throw new Error('registry exploded'); return { ...SHELL }; } });
  const r = s.send('run this on my account');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-env');
  assert.equal(fake.starts, 0, 'no process on a fallback login');
  const err = w.find('error');
  assert.equal(err.code, 'no-env');
  assert.match(err.message, /^Claude Code could not start: /);
  assert.deepEqual(err.prompts.map((p) => p.text), ['run this on my account'], 'the message is handed back, not lost');
  assert.equal(s.busy, false);
  assert.deepEqual(s.snapshot().outbox, []);

  // warm() (opening a chat) fails the same way, quietly.
  const warm = await s.warm();
  assert.deepEqual([warm.ok, warm.code, fake.starts], [false, 'no-env', 0]);

  // Once the getter can answer, the next send starts normally.
  fail = false;
  const mark = w.mark();
  assert.equal(s.send('again').ok, true);
  await idle(w, mark);
  assert.equal(fake.starts, 1);
  assert.equal(fake.current.options.env.MY_VAR, 'kept');
});

test('a getter that returns no environment stops the start too', { skip: missing }, async () => {
  for (const nothing of [null, undefined, 'env', 7, []]) {
    const { s, fake } = make({ env: () => nothing });
    assert.deepEqual([s.send('hi').code, fake.starts], ['no-env', 0], String(nothing));
  }
  // No getter at all is a host that chose this process's environment (tests, the live runner): unchanged.
  const { s, fake, w } = make({ env: undefined });
  s.send('hi');
  await idle(w);
  assert.equal(fake.starts, 1);
});

// ---- what Claude Code reports ----

test('the account Claude Code starts on is reported to the host, with the account the chat was meant to use', { skip: missing }, async () => {
  const seen = [];
  const { s, w } = make({ account: 'claude-default', onAccount: (reported, id) => { seen.push([reported, id]); throw new Error('an observer that breaks'); } });
  s.send('hi');
  await idle(w);
  assert.deepEqual(seen, [[{ email: 'tester@example.com', org: 'Test Org', plan: 'max', provider: 'firstParty', keySource: '/login managed key', apiKeySource: '/login managed key', tokenSource: 'claude.ai' }, 'claude-default']]);
  assert.equal(s.accountId, 'claude-default');
  assert.deepEqual(w.find('meta').account, { email: 'tester@example.com', org: 'Test Org', plan: 'max', provider: 'firstParty', keySource: '/login managed key' }, 'the event the window gets is unchanged');
  assert.equal(w.of('turn-end').length, 1, 'a throwing observer does not break the chat');

  // Again at every start, and null when nothing was chosen.
  const again = [];
  const b = make({ onAccount: (reported, id) => again.push(id) });
  b.s.send('one');
  await idle(b.w);
  await b.s.stop();
  const mark = b.w.mark();
  b.s.send('two');
  await idle(b.w, mark);
  assert.deepEqual(again, [null, null]);
  assert.equal(b.s.accountId, null);

  // A Claude Code that reports no account reports nothing: the host is not told a guess.
  const none = [];
  const c = make({ onAccount: (reported) => none.push(reported) }, { controls: { initializationResult() { return { commands: [], models: [], capabilities: [], current_permission_mode: 'default' }; } } });
  c.s.send('hi');
  await idle(c.w);
  assert.deepEqual(none, []);
});

test('limit updates are kept in full and passed on, with utilisation as a percentage and times in ms', { skip: missing }, async () => {
  const seen = [];
  const { s, fake, w } = make({ account: 'claude-default', onRateLimit: (limit, id) => seen.push([limit, id]) });
  s.send('hi');
  await idle(w);
  const info = {
    status: 'allowed_warning', resetsAt: 1900000000, rateLimitType: 'seven_day', utilization: 0.91, overageStatus: 'allowed', overageResetsAt: 1900003600,
    isUsingOverage: false, surpassedThreshold: 0.9, somethingNew: { kept: true },
  };
  fake.current.emit({ type: 'rate_limit_event', rate_limit_info: info });
  await sleep(30);
  assert.equal(seen.length, 1);
  const [limit, id] = seen[0];
  assert.equal(id, 'claude-default');
  assert.deepEqual(limit, {
    ...info, type: 'seven_day', resetsAt: 1900000000000, overageResetsAt: 1900003600000, utilization: 91,
  }, 'everything Claude Code sent, plus the fraction as a percentage and seconds as ms');
  assert.deepEqual(s.rateLimit, limit);
  limit.status = 'changed by the host';
  assert.equal(s.rateLimit.status, 'allowed_warning', 'the host gets a copy');

  // Already a percentage, already in ms, or missing: left as they are (0-100 is what usage() gives too).
  fake.current.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1900000000000, utilization: 37 } });
  fake.current.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
  fake.current.emit({ type: 'rate_limit_event' });
  await sleep(30);
  assert.deepEqual(seen.slice(1).map(([l]) => [l.status, l.utilization, l.resetsAt, l.type]), [['allowed', 37, 1900000000000, null], ['rejected', null, null, null], [null, null, null, null]]);
  assert.equal((await s.usage()).rateLimitsAvailable, false, 'usage() still answers as before');
});

// ---- asking how much of the plan is used ----

test('usageAnswer says why when there is no answer, and usage() answers as before', { skip: missing }, async () => {
  const WEEK = { five_hour: { utilization: 34, resets_at: '2026-11-16T23:40:00Z' }, seven_day: { utilization: 1, resets_at: null }, brand_new_window: { utilization: 5, resets_at: null } };
  const { s, fake, w } = make({}, { controls: { usage() { return { session: { total_cost_usd: 0 }, subscription_type: 'max', rate_limits_available: true, rate_limits: WEEK }; } } });
  assert.deepEqual(await s.usageAnswer(), { ok: false, code: 'no-session' }, 'no process: nothing is started just to ask');
  assert.equal(fake.starts, 0);
  s.send('hi');
  await idle(w);
  const r = await s.usageAnswer();
  assert.equal(r.ok, true);
  assert.deepEqual(r.usage, { session: { total_cost_usd: 0 }, subscriptionType: 'max', rateLimitsAvailable: true, rateLimits: WEEK }, 'the windows as Claude Code sent them, unknown ones too');
  assert.deepEqual(await s.usage(), r.usage);
  assert.deepEqual(fake.current.calls.filter((c) => c.method === 'usage').map((c) => c.args), [[{ skipBehaviors: true }], [{ skipBehaviors: true }]], 'never the scan of local transcripts');
  assert.equal(fake.current.received.length, 1, 'asking sends no message');

  // A Claude Code without the call (it is experimental), one that throws, and one that answers nothing.
  fake.current.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = undefined;
  assert.deepEqual(await s.usageAnswer(), { ok: false, code: 'unsupported' });
  assert.equal(await s.usage(), null);
  fake.current.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => { throw new Error('no'); };
  assert.deepEqual(await s.usageAnswer(), { ok: false, code: 'failed' });
  fake.current.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => null;
  assert.deepEqual(await s.usageAnswer(), { ok: false, code: 'failed' });
  assert.equal(await s.usage(), null);
});


// upkeep.mjs: keeping Claude Code current, models at their newest, drift noticed. Tested without claude:
// updates, probes, clocks and timers are all fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const U = await core('upkeep.mjs');
const missing = U.__missing ? `upkeep.mjs: ${U.__missing}` : false;

// The picker Claude Code 2.1.322 reported (supportedModels), trimmed to the fields that matter here.
const PICKER = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok', supportsEffort: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers' },
];

// ---- versions ----

test('versions are read from Claude Code output and compared numerically', { skip: missing }, () => {
  assert.deepEqual(U.parseVersion('2.1.322 (Claude Code)'), [2, 1, 322]);
  assert.equal(U.versionText('Current version: 2.1.9'), '2.1.9');
  assert.equal(U.parseVersion('no version here'), null);
  assert.equal(U.compareVersions('2.1.322', '2.1.99'), 1);
  assert.equal(U.compareVersions('2.1.322', '2.1.322 (Claude Code)'), 0);
  assert.equal(U.compareVersions('2.0.400', '2.1.0'), -1);
  assert.equal(U.compareVersions([5, 2], [5, 1]), 1);
  assert.equal(U.compareVersions('x', '2.1.0'), null);
});

// ---- models ----

test('only full model ids count as pinned, and an alias already in the picker is respected', { skip: missing }, () => {
  assert.deepEqual(U.modelFamily('claude-fable-5-1[1m]'), { family: 'fable', version: [5, 1], long: true });
  assert.deepEqual(U.modelFamily('claude-opus-5-5-20261001'), { family: 'opus', version: [5, 5], long: false });
  assert.equal(U.modelFamily('opus'), null);
  assert.equal(U.modelFamily('fable[1m]'), null);
  assert.deepEqual(U.pinnedRows(PICKER).map((p) => [p.value, p.alias]), [['claude-fable-5-1[1m]', 'fable[1m]']]);
  assert.deepEqual(U.pinnedRows([...PICKER, { value: 'fable[1m]' }]), []);
  assert.deepEqual(U.pinnedRows(null), []);
});

test('a pinned row whose alias runs a newer release is offered as the alias, described at the new version', { skip: missing }, () => {
  const fix = U.modelFixups(PICKER, { 'fable[1m]': 'claude-fable-5-2' });
  assert.equal(fix.length, 1);
  assert.equal(fix[0].from, 'claude-fable-5-1[1m]');
  assert.equal(fix[0].was, '5.1');
  assert.equal(fix[0].is, '5.2');
  assert.equal(fix[0].to.value, 'fable[1m]');
  assert.equal(fix[0].to.resolvedModel, 'claude-fable-5-2');
  assert.equal(fix[0].to.displayName, 'Fable');
  assert.equal(fix[0].to.description, 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok');
  assert.equal(fix[0].to.supportsEffort, true, 'the rest of the row is kept');
});

test('no fixup when the alias runs an older release, another family, or nothing', { skip: missing }, () => {
  assert.deepEqual(U.modelFixups(PICKER, { 'fable[1m]': 'claude-fable-4-9' }), []);
  assert.deepEqual(U.modelFixups(PICKER, { 'fable[1m]': 'claude-opus-5-5' }), []);
  assert.deepEqual(U.modelFixups(PICKER, { 'fable[1m]': null }), []);
  assert.deepEqual(U.modelFixups(PICKER, {}), []);
});

test('the same release is still swapped (was === is), so a saved alias keeps its row once Claude Code catches up', { skip: missing }, () => {
  const picker = [{ value: 'claude-fable-5-2[1m]', displayName: 'Fable', description: 'Fable 5.2 · Most capable' }];
  const [f] = U.modelFixups(picker, { 'fable[1m]': 'claude-fable-5-2' });
  assert.equal(f.to.value, 'fable[1m]');
  assert.equal(f.was, f.is);
  assert.equal(f.to.description, 'Fable 5.2 · Most capable');
});

test('major-only and dated ids are read without mistaking a date for a minor', { skip: missing }, () => {
  assert.deepEqual(U.modelFamily('claude-opus-6'), { family: 'opus', version: [6], long: false });
  assert.deepEqual(U.modelFamily('claude-opus-6-20270115'), { family: 'opus', version: [6], long: false });
  assert.deepEqual(U.modelFamily('claude-opus-5-5-20261001')?.version, [5, 5]);
  const [f] = U.modelFixups([{ value: 'claude-opus-6-20270115', displayName: 'Opus' }], { opus: 'claude-opus-6-1' });
  assert.equal(f.is, '6.1');
  assert.deepEqual(U.modelFixups([{ value: 'claude-opus-6-1' }], { opus: 'claude-opus-6-20270115' }), [], '6 is older than 6.1');
});

test('a future family gets the same treatment without any code change', { skip: missing }, () => {
  const picker = [{ value: 'claude-saga-7-0', displayName: 'Saga', description: 'Saga 7.0 · New' }];
  const fix = U.modelFixups(picker, { saga: 'claude-saga-7-1' });
  assert.equal(fix[0].to.value, 'saga');
  assert.equal(fix[0].to.description, 'Saga 7.1 · New');
});

test('probeModels asks each pinned alias once, never sends a prompt, and always closes the process', { skip: missing }, async () => {
  const calls = [];
  let closed = false, prompted = false, options = null;
  const query = ({ prompt, options: o }) => {
    options = o;
    (async () => { for await (const _ of prompt) prompted = true; })();
    let model = null;
    return {
      initializationResult: async () => ({ claude_code_version: '2.1.322', models: PICKER }),
      setModel: async (m) => { calls.push(m); model = m; },
      getContextUsage: async () => ({ model: model === 'fable[1m]' ? 'claude-fable-5-2' : null }),
      close: () => { closed = true; },
    };
  };
  const r = await U.probeModels({ query, claudePath: '/x/claude', env: { A: '1' }, cwd: '/tmp' });
  assert.deepEqual(calls, ['fable[1m]']);
  assert.deepEqual(r.resolved, { 'fable[1m]': 'claude-fable-5-2' });
  assert.equal(r.cliVersion, '2.1.322');
  assert.equal(closed, true);
  assert.equal(prompted, false);
  assert.deepEqual(options.settingSources, [], 'no hooks, plugins or MCP servers in the throwaway process');
  assert.equal(options.pathToClaudeCodeExecutable, '/x/claude');
});

test('probeModels treats an alias Claude Code rejects as unknown, and closes on timeout', { skip: missing }, async () => {
  let closed = 0;
  const base = { close: () => { closed++; }, getContextUsage: async () => ({ model: 'x' }) };
  const rejecting = () => ({ ...base, initializationResult: async () => ({ models: PICKER }), setModel: async () => { throw new Error("Model 'fable[1m]' not found"); } });
  assert.deepEqual((await U.probeModels({ query: rejecting, claudePath: '/x', env: {} })).resolved, { 'fable[1m]': null });
  const hanging = () => ({ ...base, initializationResult: () => new Promise(() => {}) });
  await assert.rejects(U.probeModels({ query: hanging, claudePath: '/x', env: {}, timeoutMs: 30 }), /timed out/);
  assert.equal(closed, 2);
});

test('probeUsage asks without a prompt or any settings, as canopy, and always closes the process', { skip: missing }, async () => {
  let closed = 0, prompted = false, options = null;
  const asked = [];
  const answer = { session: { total_cost_usd: 0 }, subscription_type: 'max', rate_limits_available: true, rate_limits: { seven_day: { utilization: 12, resets_at: '2026-11-21T23:00:00Z' } }, behaviors: null };
  const query = ({ prompt, options: o }) => {
    options = o;
    (async () => { for await (const _ of prompt) prompted = true; })();
    return {
      initializationResult: async () => ({ claude_code_version: '2.1.325' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts) => { asked.push(opts); return answer; },
      close: () => { closed++; },
    };
  };
  const env = Object.freeze({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/someone/.claude', CLAUDE_AGENT_SDK_CLIENT_APP: 'something-else/1' });
  const r = await U.probeUsage({ query, claudePath: '/x/claude', env, appVersion: '3.2.1', cwd: '/tmp' });
  assert.deepEqual(r, { supported: true, usage: { subscriptionType: 'max', rateLimitsAvailable: true, rateLimits: answer.rate_limits } });
  assert.deepEqual(asked, [{ skipBehaviors: true }], 'asked once, without the scan of local transcripts');
  assert.equal(prompted, false, 'no message is ever sent, so nothing is billed');
  assert.equal(closed, 1);
  assert.deepEqual(options.settingSources, [], 'no hooks, plugins or MCP servers in the throwaway process');
  assert.equal(options.pathToClaudeCodeExecutable, '/x/claude');
  assert.deepEqual(options.env, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/someone/.claude', CLAUDE_AGENT_SDK_CLIENT_APP: 'canopy/3.2.1' }, 'the login the caller chose, and Canopy by name');
  assert.ok(!('resume' in options) && !('model' in options));

  // Console and API keys have no plan windows: that is an answer, not a failure.
  const console_ = () => ({ initializationResult: async () => ({}), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ subscription_type: null, rate_limits_available: false, rate_limits: null }), close: () => { closed++; } });
  assert.deepEqual(await U.probeUsage({ query: console_, claudePath: '/x', env: {} }), { supported: true, usage: { subscriptionType: null, rateLimitsAvailable: false, rateLimits: null } });
});

test('probeUsage: a Claude Code without the call says so; a failure or a hang rejects; the process is closed every time', { skip: missing }, async () => {
  let closed = 0;
  const base = { close: () => { closed++; }, initializationResult: async () => ({}) };
  assert.deepEqual(await U.probeUsage({ query: () => ({ ...base }), claudePath: '/x', env: {} }), { supported: false });
  await assert.rejects(U.probeUsage({ query: () => ({ ...base, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('not signed in'); } }), claudePath: '/x', env: {} }), /not signed in/);
  await assert.rejects(U.probeUsage({ query: () => ({ ...base, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => undefined }), claudePath: '/x', env: {} }), /no usage answer/);
  await assert.rejects(U.probeUsage({ query: () => ({ ...base, initializationResult: () => new Promise(() => {}) }), claudePath: '/x', env: {}, timeoutMs: 30 }), /timed out/);
  await assert.rejects(U.probeUsage({ query: () => { throw new Error('spawn failed'); }, claudePath: '/x', env: {} }), /spawn failed/);
  assert.equal(closed, 4, 'every process that started was closed');
});

// ---- updateClaude ----

function fakeRun(versions, updateOut = { ok: true, stdout: 'Claude Code is up to date (2.1.322)' }) {
  const seen = [];
  return {
    seen,
    runFn: async (cmd, args) => {
      seen.push(args.join(' '));
      if (args[0] === '--version') { const v = versions.shift(); return v ? { ok: true, stdout: `${v} (Claude Code)\n` } : { ok: false, stdout: '' }; }
      return { stderr: '', ...updateOut };
    },
  };
}

test('updateClaude judges by the version before and after, not by the wording', { skip: missing }, async () => {
  let f = fakeRun(['2.1.321', '2.1.322'], { ok: true, stdout: 'Some brand new wording' });
  assert.deepEqual(await U.updateClaude({ claudePath: '/c', env: {}, runFn: f.runFn }), { result: 'updated', from: '2.1.321', to: '2.1.322' });
  assert.deepEqual(f.seen, ['--version', 'update', '--version']);

  f = fakeRun(['2.1.322', '2.1.322']);
  assert.deepEqual(await U.updateClaude({ claudePath: '/c', env: {}, runFn: f.runFn }), { result: 'current', version: '2.1.322' });

  f = fakeRun(['2.1.300', '2.1.300'], { ok: true, stdout: 'Installed with Homebrew.\nRun: brew upgrade claude-code' });
  const r = await U.updateClaude({ claudePath: '/c', env: {}, runFn: f.runFn });
  assert.equal(r.result, 'failed');
  assert.equal(r.detail, 'Run: brew upgrade claude-code');

  f = fakeRun(['2.1.300', '2.1.300'], { ok: false, stdout: '', timedOut: true });
  assert.match((await U.updateClaude({ claudePath: '/c', env: {}, runFn: f.runFn })).detail, /took too long/);
});

// ---- the Upkeep loop ----

function harness({ version = '2.1.322', busy = false, saved = null, update, probe, engineVersion = '2.1.322', env = {} } = {}) {
  const h = { version, busy, saved, emits: [], notes: [], logs: [], timers: [], updates: 0, probes: 0, clock: 1_000_000 };
  h.upkeep = new U.Upkeep({
    claude: () => ({ path: '/c/claude', env: h.env ?? env, version: h.version }),
    refreshVersion: async () => h.version,
    isBusy: () => h.busy,
    load: () => h.saved,
    save: (s) => { h.saved = JSON.parse(JSON.stringify(s)); },
    update: async (c) => { h.updates++; return update ? update(h, c) : { result: 'current', version: h.version }; },
    probe: async () => { h.probes++; return probe ? probe(h) : { cliVersion: h.version, models: PICKER, resolved: { 'fable[1m]': 'claude-fable-5-2' } }; },
    engineVersion,
    onChange: (s, note) => { h.emits.push(s); if (note) h.notes.push(note); },
    log: (m) => h.logs.push(m),
    now: () => h.clock,
    timers: { set: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; }, clear: (t) => { if (t) t.cleared = true; } },
  });
  h.pending = () => h.timers.filter((t) => !t.cleared);
  h.fire = async () => { const t = h.pending().at(-1); t.cleared = true; await t.fn(); };
  return h;
}

test('auto-update is on by default and a saved choice survives a restart', { skip: missing }, () => {
  assert.equal(harness().upkeep.status().autoUpdate, true);
  const h = harness();
  h.upkeep.setAutoUpdate(false);
  assert.equal(harness({ saved: h.saved }).upkeep.status().autoUpdate, false);
});

test('an update moves the version, records it, says so once, and re-checks the models', { skip: missing }, async () => {
  const h = harness({ version: '2.1.321', update: (h) => { h.version = '2.1.322'; return { result: 'updated', from: '2.1.321', to: '2.1.322' }; } });
  const r = await h.upkeep.update();
  assert.equal(r.result, 'updated');
  const s = h.upkeep.status();
  assert.equal(s.version, '2.1.322');
  assert.deepEqual(s.lastUpdate, { at: h.clock, from: '2.1.321', to: '2.1.322' });
  assert.equal(s.lastCheck.result, 'updated');
  assert.equal(s.doing, null);
  assert.deepEqual(h.notes, [{ kind: 'updated', from: '2.1.321', to: '2.1.322' }]);
  assert.equal(h.probes, 1, 'new version, new model check');
  assert.equal(h.saved.lastUpdate.to, '2.1.322');
});

test('a scheduled update waits while a chat is working and tries again later', { skip: missing }, async () => {
  const h = harness({ busy: true });
  assert.equal((await h.upkeep.update()).result, 'deferred');
  assert.equal(h.updates, 0);
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, 10 * 60_000);
  h.busy = false;
  await h.fire();
  assert.equal(h.updates, 1);
  assert.equal(h.pending()[0].ms, 6 * 60 * 60_000, 'then back to the regular rhythm');
});

test('switched off, or DISABLE_AUTOUPDATER set: nothing runs on its own, but Check now still does', { skip: missing }, async () => {
  const off = harness();
  off.upkeep.setAutoUpdate(false);
  assert.equal((await off.upkeep.update()).result, 'off');
  assert.equal(off.updates, 0);
  await off.upkeep.update({ force: true, reason: 'manual' });
  assert.equal(off.updates, 1);

  for (const k of ['DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) assert.ok(harness({ env: { [k]: '1' } }).upkeep.status().blockedBy?.includes(k));
  const env = harness({ env: { DISABLE_AUTOUPDATER: '1' } });
  assert.match(env.upkeep.status().blockedBy, /DISABLE_AUTOUPDATER/);
  assert.equal((await env.upkeep.update()).result, 'off');
  assert.equal(env.updates, 0);
  assert.equal(harness({ env: { DISABLE_AUTOUPDATER: '0' } }).upkeep.status().blockedBy, null);
});

test('concurrent updates share one run', { skip: missing }, async () => {
  let release;
  const h = harness({ update: () => new Promise((r) => { release = () => r({ result: 'current' }); }) });
  const a = h.upkeep.update(), b = h.upkeep.update({ force: true });
  assert.equal(h.upkeep.status().doing, 'updating');
  release();
  assert.equal(await a, await b);
  assert.equal(h.updates, 1);
});

test('a failed update is reported, logged, and never throws', { skip: missing }, async () => {
  const h = harness({ update: () => { throw new Error('network down'); } });
  const r = await h.upkeep.update();
  assert.equal(r.result, 'failed');
  assert.equal(h.upkeep.status().lastCheck.detail, 'network down');
  assert.ok(h.logs.some((l) => l.includes('network down')));
});

test('start checks right away when Claude Code is older than the engine, otherwise after a while', { skip: missing }, () => {
  const behind = harness({ version: '2.1.300', engineVersion: '2.1.322' });
  assert.equal(behind.upkeep.status().behind, true);
  behind.upkeep.start();
  assert.equal(behind.pending()[0].ms, 0);
  const fine = harness();
  fine.upkeep.start();
  assert.equal(fine.upkeep.status().behind, false);
  assert.equal(fine.pending()[0].ms, 30_000);
  fine.upkeep.stop();
  assert.equal(fine.pending().length, 0);
});

test('repair updates even when switched off, and only once in ten minutes', { skip: missing }, async () => {
  const h = harness({ version: '2.1.300', update: (h) => { h.version = '2.1.322'; return { result: 'updated', from: '2.1.300', to: '2.1.322' }; } });
  h.upkeep.setAutoUpdate(false);
  assert.equal((await h.upkeep.repair()).result, 'updated');
  assert.deepEqual(h.notes.at(-1), { kind: 'repaired', from: '2.1.300', to: '2.1.322' });
  assert.equal((await h.upkeep.repair()).result, 'off');
  h.clock += 10 * 60_000;
  await h.upkeep.repair();
  assert.equal(h.updates, 2);
});

test('models are checked once per Claude Code version, and a failed check keeps the last answer', { skip: missing }, async () => {
  const h = harness();
  await h.upkeep.ensureModels();
  await h.upkeep.ensureModels();
  assert.equal(h.probes, 1);
  assert.deepEqual(h.upkeep.status().fixups.map((f) => [f.from, f.to.value]), [['claude-fable-5-1[1m]', 'fable[1m]']]);
  // Restarted Canopy, same Claude Code: the saved answer is used without a new process.
  const again = harness({ saved: h.saved });
  await again.upkeep.ensureModels();
  assert.equal(again.probes, 0);
  assert.equal(again.upkeep.status().fixups.length, 1);
  // New version, and the check fails: keep the fixups we had.
  const broken = harness({ saved: h.saved, version: '2.1.323', probe: () => { throw new Error('spawn failed'); } });
  await broken.upkeep.ensureModels();
  assert.equal(broken.upkeep.status().fixups.length, 1);
  assert.ok(broken.logs.some((l) => l.includes('spawn failed')));
});

test('drift is remembered once per label and version, keys only, capped, and can be cleared', { skip: missing }, () => {
  const h = harness();
  assert.equal(h.upkeep.recordDrift('system/brand_new', ['type', 'subtype', 'payload']), true);
  assert.equal(h.upkeep.recordDrift('system/brand_new', ['type']), false);
  const [d] = h.upkeep.status().drift;
  assert.equal(d.label, 'system/brand_new');
  assert.equal(d.version, '2.1.322');
  assert.equal(d.count, 2);
  assert.deepEqual(d.keys, ['type', 'subtype', 'payload']);
  assert.deepEqual(h.notes, [{ kind: 'drift', label: 'system/brand_new' }]);
  h.version = '2.1.323';
  assert.equal(h.upkeep.recordDrift('system/brand_new'), true, 'a new Claude Code version is worth a new entry');
  for (let i = 0; i < 40; i++) h.upkeep.recordDrift(`x/${i}`);
  assert.equal(h.upkeep.status().drift.length, 30);
  assert.equal(h.upkeep.recordDrift(''), false);
  h.upkeep.clearDrift();
  assert.deepEqual(h.upkeep.status().drift, []);
  assert.deepEqual(h.saved.drift, []);
});

test('a broken observer or store never breaks upkeep', { skip: missing }, async () => {
  const u = new U.Upkeep({
    claude: () => { throw new Error('boom'); }, refreshVersion: async () => null,
    load: () => { throw new Error('bad file'); }, save: () => { throw new Error('disk full'); },
    onChange: () => { throw new Error('ui gone'); },
    timers: { set: () => null, clear: () => {} },
  });
  assert.equal(u.status().version, null);
  assert.equal((await u.update({ force: true })).result, 'failed');
  assert.equal(u.recordDrift('a/b'), true);
});

test('start announces the status once, so a window that asked too early still hears it', { skip: missing }, () => {
  const h = harness();
  h.upkeep.start();
  assert.ok(h.emits.length >= 1);
  assert.equal(h.emits[0].version, '2.1.322');
});

test('schedule: false never updates on a timer (throwaway copies), Check now still works', { skip: missing }, async () => {
  const h = harness();
  const u = new U.Upkeep({ ...h.upkeep, claude: () => ({ path: '/c', env: {}, version: '2.1.300' }), refreshVersion: async () => null,
    update: async () => { h.updates++; return { result: 'current' }; }, schedule: false, engineVersion: '2.1.322',
    timers: { set: (fn, ms) => { h.timers.push({ fn, ms }); return {}; }, clear: () => {} } });
  u.start();
  assert.equal(h.timers.length, 0);
  await u.update({ force: true });
  assert.equal(h.updates, 1);
});

test('an update made outside Canopy is noticed on the next check: version re-read, models re-checked', { skip: missing }, async () => {
  let refreshed = 0;
  const h = harness({ version: '2.1.322', update: () => ({ result: 'current', version: '2.1.330' }) });
  const orig = h.upkeep.refreshVersion;
  h.upkeep.refreshVersion = async () => { refreshed++; h.version = '2.1.330'; return orig(); };
  await h.upkeep.ensureModels();
  assert.equal(h.probes, 1);
  await h.upkeep.update();
  assert.equal(refreshed, 1);
  assert.equal(h.upkeep.status().version, '2.1.330');
  assert.equal(h.probes, 2, 'new version, new model check');
  assert.equal(h.upkeep.status().lastUpdate, null, 'not counted as our update');
  assert.deepEqual(h.notes, []);
});

test('a forced model check waits for the probe in flight and then checks the new version', { skip: missing }, async () => {
  let release;
  const h = harness({ version: '2.1.321', probe: (h) => (h.probes === 1
    ? new Promise((r) => { release = () => r({ cliVersion: '2.1.321', models: PICKER, resolved: {} }); })
    : { cliVersion: h.version, models: PICKER, resolved: { 'fable[1m]': 'claude-fable-5-2' } }) });
  const first = h.upkeep.ensureModels();
  h.version = '2.1.322';
  const forced = h.upkeep.ensureModels({ force: true });
  release();
  await first; await forced;
  assert.equal(h.probes, 2);
  assert.equal(h.saved.models.cliVersion, '2.1.322');
});

// The same class also keeps Codex current, under another name (codex-upkeep.test.mjs). Left unnamed it is Claude
// Code's, and nothing it writes or says has changed.
test('an unnamed instance is Claude Code\'s: its log lines and sentences are word for word what they were', { skip: missing }, async () => {
  const h = harness({ version: '2.1.321', update: (h) => { h.version = '2.1.322'; return { result: 'updated', from: '2.1.321', to: '2.1.322' }; } });
  await h.upkeep.update();
  h.upkeep.recordDrift('system/new_thing', ['type', 'subtype']);
  assert.deepEqual(h.logs, [
    'claude update (scheduled): updated 2.1.321 -> 2.1.322',
    'models for 2.1.322: claude-fable-5-1[1m] -> fable[1m] (5.2)',
    'drift: Claude Code 2.1.322 sent "system/new_thing" (keys: type, subtype), which Canopy skips',
  ]);
  const failed = harness({ update: () => ({ result: 'failed', version: '2.1.322', detail: 'Run: brew upgrade claude-code' }) });
  await failed.upkeep.update({ force: true, reason: 'manual' });
  assert.equal(failed.logs[0], 'claude update (manual): failed · Run: brew upgrade claude-code');

  const none = new U.Upkeep({ claude: () => ({ path: null, env: {}, version: null }), refreshVersion: async () => null });
  assert.deepEqual(await none.update({ force: true }), { result: 'failed', detail: 'Claude Code is not installed.' });
  const blocked = harness({ env: { DISABLE_AUTOUPDATER: '1' } });
  assert.equal(blocked.upkeep.status().blockedBy, 'DISABLE_AUTOUPDATER is set in your environment or Claude Code settings.');
  assert.deepEqual(Object.keys(blocked.upkeep.status()), ['autoUpdate', 'blockedBy', 'version', 'engineVersion', 'behind', 'doing', 'lastCheck', 'lastUpdate', 'fixups', 'drift'], 'the status has the shape the window knows');
});

test('another tool\'s own "do not update me" replaces Claude Code\'s switches for that instance only', { skip: missing }, () => {
  const env = { DISABLE_AUTOUPDATER: '1' };
  const make = (blocked) => new U.Upkeep({ name: 'Codex', claude: () => ({ path: '/c', env, version: '0.153.4' }), refreshVersion: async () => null, blocked });
  assert.equal(make(() => null).status().blockedBy, null);
  assert.equal(make(() => 'Updates are turned off in your Codex settings.').status().blockedBy, 'Updates are turned off in your Codex settings.');
  assert.equal(make(() => true).status().blockedBy, null, 'only a sentence counts');
  assert.equal(make(() => { throw new Error('x'); }).status().blockedBy, null, 'a broken check never blocks, and never throws');
  assert.equal(make('not a function').status().blockedBy, 'DISABLE_AUTOUPDATER is set in your environment or Claude Code settings.', 'none given: Claude Code\'s own');
});

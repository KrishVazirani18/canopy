// Keeping Codex current (src/core/codex-upkeep.mjs, and the Upkeep class of upkeep.mjs run a second time as main
// runs it), and the words Settings and the toasts use for it (renderer/src/lib/upkeep-words.ts).
// Every command goes through a stand-in: `codex update` is never run here, and no Codex is started. The one test
// that speaks the app-server's wire uses the scripted stand-in (fake-codex.mjs).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { Upkeep } from '../../upkeep.mjs';
import { CodexService } from '../../codex-host.mjs';
import * as C from '../../codex-upkeep.mjs';
import * as W from '../../../../renderer/src/lib/upkeep-words.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

// ---- the version Canopy needs ----

test('the oldest Codex Canopy works with is the one everything was recorded on', () => {
  assert.equal(C.CODEX_MIN_VERSION, '0.153.4');
  assert.equal(C.codexTooOld('0.153.3'), true);
  assert.equal(C.codexTooOld('codex-cli 0.99.0'), true);
  assert.equal(C.codexTooOld('0.153.4'), false);
  assert.equal(C.codexTooOld('0.167.2'), false);
  assert.equal(C.codexTooOld('1.0.0'), false);
  assert.equal(C.codexTooOld(null), false, 'a version that could not be read blocks nothing');
  assert.equal(C.codexTooOld('(version unknown)'), false);
  assert.equal(C.CODEX_TOO_OLD, 'Codex is too old for this version of Canopy. Canopy is updating it. Try again in a minute.');
});

// ---- updateCodex ----

function fakeRun(versions, updateOut = { ok: true, stdout: '' }) {
  const seen = [];
  return {
    seen,
    runFn: async (cmd, args, opts) => {
      seen.push({ cmd, args: args.join(' '), timeoutMs: opts?.timeoutMs, env: opts?.env });
      if (args[0] === '--version') { const v = versions.shift(); return v ? { ok: true, stdout: `codex-cli ${v}\n`, stderr: '' } : { ok: false, stdout: '', stderr: '' }; }
      return { stdout: '', stderr: '', ...updateOut };
    },
  };
}

test('updateCodex runs Codex\'s own `codex update` and judges by the version before and after, never by the wording', async () => {
  let f = fakeRun(['0.153.4', '0.167.2'], { ok: true, stdout: 'Some brand new wording' });
  assert.deepEqual(await C.updateCodex({ codexPath: '/opt/homebrew/bin/codex', env: { PATH: '/opt/homebrew/bin' }, runFn: f.runFn }), { result: 'updated', from: '0.153.4', to: '0.167.2' });
  assert.deepEqual(f.seen.map((s) => `${s.cmd} ${s.args}`), ['/opt/homebrew/bin/codex --version', '/opt/homebrew/bin/codex update', '/opt/homebrew/bin/codex --version'], '`codex update` is the only command besides `--version`: no installer is guessed');
  assert.equal(f.seen[1].timeoutMs, 10 * MIN, 'Homebrew may refresh itself first');
  assert.equal(f.seen[1].env.PATH, '/opt/homebrew/bin', 'the shell environment Canopy loaded: that is where `brew` is');

  // Homebrew is behind Codex's own newest: nothing moved, and that is "up to date", whatever was printed.
  f = fakeRun(['0.167.2', '0.167.2'], { ok: true, stdout: 'Warning: Not upgrading codex, the latest version is already installed' });
  assert.deepEqual(await C.updateCodex({ codexPath: '/c', env: {}, runFn: f.runFn }), { result: 'current', version: '0.167.2' });

  // An update that failed but did move the version still counts as an update.
  f = fakeRun(['0.153.4', '0.160.0'], { ok: false, stderr: 'cleanup failed' });
  assert.equal((await C.updateCodex({ codexPath: '/c', env: {}, runFn: f.runFn })).result, 'updated');
});

test('updateCodex: an install Codex cannot update, a timeout and a broken command all fail cleanly with a reason', async () => {
  let f = fakeRun(['0.153.4', '0.153.4'], { ok: false, stderr: 'Updating Codex...\nerror: this install is manual or unknown; update it yourself\n' });
  assert.deepEqual(await C.updateCodex({ codexPath: '/c', env: {}, runFn: f.runFn }), { result: 'failed', version: '0.153.4', detail: 'error: this install is manual or unknown; update it yourself' });

  f = fakeRun(['0.153.4', '0.153.4'], { ok: false, timedOut: true });
  assert.match((await C.updateCodex({ codexPath: '/c', env: {}, runFn: f.runFn })).detail, /took too long/);

  f = fakeRun(['0.153.4', '0.153.4'], { ok: false });
  assert.equal((await C.updateCodex({ codexPath: '/c', env: {}, runFn: f.runFn })).detail, 'Codex did not say why.');

  f = fakeRun([], { ok: false, stderr: 'no such file' });
  assert.deepEqual(await C.updateCodex({ codexPath: '/c', env: {}, runFn: f.runFn }), { result: 'failed', version: null, detail: 'no such file' });

  assert.deepEqual(await C.updateCodex({ codexPath: null, runFn: async () => assert.fail('nothing is run without Codex') }), { result: 'failed', version: null, detail: 'Codex is not installed.' });
  const thrown = await C.updateCodex({ codexPath: '/c', env: {}, runFn: async () => { throw new Error('spawn EACCES'); } });
  assert.deepEqual(thrown, { result: 'failed', version: null, detail: 'spawn EACCES' }, 'never a rejection');
  assert.equal((await C.updateCodex()).result, 'failed');
});

// ---- the loop, as main runs it for Codex ----

function harness({ version = '0.153.4', busy = false, saved = null, update, off = false, schedule } = {}) {
  const h = { version, busy, saved, off, emits: [], notes: [], logs: [], timers: [], updates: 0, clock: 1_000_000 };
  h.upkeep = new Upkeep({
    name: 'Codex',
    claude: () => ({ path: h.path === undefined ? '/opt/homebrew/bin/codex' : h.path, env: h.env ?? { PATH: '/usr/bin' }, version: h.version }),
    refreshVersion: async () => h.version,
    isBusy: () => h.busy,
    blocked: () => (h.off ? C.CODEX_UPDATES_OFF : null),
    load: () => h.saved,
    save: (s) => { h.saved = JSON.parse(JSON.stringify(s)); },
    update: async (c) => { h.updates++; return update ? update(h, c) : { result: 'current', version: h.version }; },
    engineVersion: C.CODEX_MIN_VERSION,
    onChange: (s, note) => { h.emits.push(s); if (note) h.notes.push(note); },
    log: (m) => h.logs.push(m),
    now: () => h.clock,
    timers: { set: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; }, clear: (t) => { if (t) t.cleared = true; } },
    ...(schedule !== undefined && { schedule }),
  });
  h.pending = () => h.timers.filter((t) => !t.cleared);
  h.fire = async () => { const t = h.pending().at(-1); t.cleared = true; await t.fn(); };
  return h;
}

test('Codex is kept current on its own: on by default, first check soon after start, then every six hours', async () => {
  const h = harness({ update: (h) => { if (h.version === '0.167.2') return { result: 'current', version: '0.167.2' }; h.version = '0.167.2'; return { result: 'updated', from: '0.153.4', to: '0.167.2' }; } });
  h.upkeep.start();
  assert.equal(h.upkeep.status().autoUpdate, true);
  assert.equal(h.upkeep.status().behind, false);
  assert.equal(h.pending().at(-1).ms, 30_000);
  await h.fire();
  assert.equal(h.updates, 1);
  const s = h.upkeep.status();
  assert.deepEqual([s.version, s.lastUpdate.from, s.lastUpdate.to, s.lastCheck.result], ['0.167.2', '0.153.4', '0.167.2', 'updated']);
  assert.deepEqual(h.notes, [{ kind: 'updated', from: '0.153.4', to: '0.167.2' }]);
  assert.equal(h.pending().at(-1).ms, 6 * HOUR);
  assert.deepEqual(s.fixups, [], 'Codex has no model rows to fix');
  assert.equal(h.logs.some((l) => l === 'codex update (scheduled): updated 0.153.4 -> 0.167.2'), true, h.logs.join(' | '));
  // Homebrew behind Codex's own newest: the next check says "current", and nothing loops.
  await h.fire();
  assert.equal(h.upkeep.status().lastCheck.result, 'current');
  assert.equal(h.pending().at(-1).ms, 6 * HOUR);
  assert.equal(h.notes.length, 1, 'nothing more to tell');
});

test('only while no chat is working: a scheduled update waits, and tries again in ten minutes', async () => {
  const h = harness({ busy: true });
  h.upkeep.start();
  await h.fire();
  assert.equal(h.updates, 0, 'a chat of either maker is working');
  assert.equal(h.pending().at(-1).ms, 10 * MIN);
  await h.fire();
  assert.equal(h.updates, 0);
  h.busy = false;
  await h.fire();
  assert.equal(h.updates, 1);
  assert.equal(h.pending().at(-1).ms, 6 * HOUR);
});

test('a Codex older than Canopy needs is updated at once, not in thirty seconds', async () => {
  const h = harness({ version: '0.150.0', update: (h) => { h.version = '0.167.2'; return { result: 'updated', from: '0.150.0', to: '0.167.2' }; } });
  assert.equal(h.upkeep.status().behind, true);
  assert.equal(h.upkeep.status().engineVersion, '0.153.4');
  h.upkeep.start();
  assert.equal(h.pending().at(-1).ms, 0);
  await h.fire();
  assert.equal(h.upkeep.status().behind, false);
});

test('repair (a chat could not open on a Codex that is too old): now, even while a chat works, and at most every ten minutes', async () => {
  const h = harness({ version: '0.150.0', busy: true });
  const first = await h.upkeep.repair();
  assert.equal(first.result, 'current');
  assert.equal(h.updates, 1);
  assert.equal(h.upkeep.status().lastCheck.reason, 'repair');
  assert.deepEqual(await h.upkeep.repair(), { result: 'off', detail: 'Already tried updating a moment ago.' });
  h.clock += 9 * MIN;
  await h.upkeep.repair();
  assert.equal(h.updates, 1, 'a Codex that stays too old can never loop');
  h.clock += 2 * MIN;
  await h.upkeep.repair();
  assert.equal(h.updates, 2);

  // A repair that worked says so in its own words (the toast asks you to send again).
  const ok = harness({ version: '0.150.0', update: (h) => { h.version = '0.167.2'; return { result: 'updated', from: '0.150.0', to: '0.167.2' }; } });
  await ok.upkeep.repair();
  assert.deepEqual(ok.notes, [{ kind: 'repaired', from: '0.150.0', to: '0.167.2' }]);
});

test('the user\'s own "do not check for updates" in Codex blocks the schedule, shows the switch off, and never blocks Check now', async () => {
  const h = harness({ off: true });
  assert.equal(h.upkeep.status().blockedBy, 'Updates are turned off in your Codex settings.');
  assert.equal(h.upkeep.status().autoUpdate, true, 'Canopy\'s own switch is untouched: the window shows it off because of blockedBy');
  h.upkeep.start();
  await h.fire();
  assert.equal(h.updates, 0);
  assert.equal(h.pending().at(-1).ms, 6 * HOUR, 'checked again later, in case the setting changes');
  const r = await h.upkeep.update({ force: true, reason: 'manual' });
  assert.equal(r.result, 'current');
  assert.equal(h.updates, 1, 'Check now is you asking');

  // Claude Code's own switches mean nothing to Codex's instance.
  const other = harness();
  other.env = { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' };
  assert.equal(other.upkeep.status().blockedBy, null);
  // And Canopy's own switch, off, is remembered and stops the schedule too.
  other.upkeep.setAutoUpdate(false);
  assert.deepEqual(await other.upkeep.update(), { result: 'off' });
  assert.equal(harness({ saved: other.saved }).upkeep.status().autoUpdate, false);
});

test('a failed update is one quiet status line, with nothing retried before the next six-hour check', async () => {
  const h = harness({ update: () => ({ result: 'failed', version: '0.153.4', detail: 'error: this install is manual or unknown' }) });
  h.upkeep.start();
  await h.fire();
  const s = h.upkeep.status();
  assert.deepEqual([s.lastCheck.result, s.lastCheck.detail], ['failed', 'error: this install is manual or unknown']);
  assert.deepEqual(h.notes, [], 'no toast for it');
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, 6 * HOUR);
  assert.equal(W.upkeepLine(s), 'Couldn’t update: error: this install is manual or unknown');
});

test('without Codex nothing is run, and the sentence names Codex; a throwaway copy never updates on a timer', async () => {
  const h = harness();
  h.path = null;
  assert.deepEqual(await h.upkeep.update({ force: true }), { result: 'failed', detail: 'Codex is not installed.' });
  assert.equal(h.updates, 0);
  const t = harness({ schedule: false });
  t.upkeep.start();
  assert.equal(t.pending().length, 0);
});

test('what Codex sends that Canopy does not know is kept once per label and Codex version, the newest thirty', () => {
  const h = harness();
  assert.equal(h.upkeep.recordDrift('codex/item/hologram', ['id', 'type', 'frames']), true);
  assert.equal(h.upkeep.recordDrift('codex/item/hologram', ['id', 'type', 'frames']), false, 'the second time only counts');
  assert.equal(h.upkeep.recordDrift('codex/thread/teleported', ['threadId']), true);
  assert.deepEqual(h.upkeep.status().drift.map((d) => [d.label, d.version, d.count, d.keys]), [['codex/item/hologram', '0.153.4', 2, ['id', 'type', 'frames']], ['codex/thread/teleported', '0.153.4', 1, ['threadId']]]);
  assert.deepEqual(h.notes, [{ kind: 'drift', label: 'codex/item/hologram' }, { kind: 'drift', label: 'codex/thread/teleported' }]);
  assert.equal(h.logs[0], 'drift: Codex 0.153.4 sent "codex/item/hologram" (keys: id, type, frames), which Canopy skips');
  h.version = '0.167.2';
  assert.equal(h.upkeep.recordDrift('codex/item/hologram', []), true, 'a new Codex version: noted again');
  for (let i = 0; i < 40; i++) h.upkeep.recordDrift(`codex/request/new-${i}`, []);
  assert.equal(h.upkeep.status().drift.length, 30);
  assert.equal(h.saved.drift.length, 30);
  h.upkeep.clearDrift();
  assert.deepEqual(h.upkeep.status().drift, []);
});

// ---- after an update ----

test('after an update the shared helper is let go and idle Codex chats are stopped; a chat that is working is never touched', async () => {
  const chat = (over) => { const s = { engine: 'codex', busy: false, pending: new Map(), closed: false, stops: 0, stop() { s.stops += 1; return Promise.resolve({ ok: true }); }, ...over }; return s; };
  const idle = chat();
  const working = chat({ busy: true });
  const asking = chat({ pending: new Map([['1', {}]]) });
  const closed = chat({ closed: true });
  const claude = chat({ engine: 'claude' });
  const unnamed = chat({ engine: undefined });
  const throwing = chat({ stop() { throw new Error('boom'); } });
  const lastIdle = chat();
  const service = { active: 0, retired: 0, retire() { service.retired += 1; return Promise.resolve(true); } };
  const r = await C.restartIdleCodex({ service, sessions: () => [idle, working, asking, closed, claude, unnamed, throwing, lastIdle] });
  assert.equal(service.retired, 1);
  assert.deepEqual([idle.stops, working.stops, asking.stops, closed.stops, claude.stops, unnamed.stops, lastIdle.stops], [1, 0, 0, 0, 0, 0, 1], 'a working chat, one waiting on you, and every Claude chat are left alone; one chat failing never stops the rest');
  assert.deepEqual(r, { retired: true, stopped: 2 });
});

test('after an update: a helper in the middle of a call is not cut off (it goes a minute after its last call anyway)', async () => {
  const service = { active: 1, retired: 0, retire() { service.retired += 1; } };
  assert.deepEqual(await C.restartIdleCodex({ service, sessions: () => [] }), { retired: false, stopped: 0 });
  assert.equal(service.retired, 0);
  // Nothing to act on, or a list that cannot be read: nothing thrown.
  assert.deepEqual(await C.restartIdleCodex(), { retired: false, stopped: 0 });
  assert.deepEqual(await C.restartIdleCodex({ service: { retire() { throw new Error('x'); } }, sessions: () => { throw new Error('y'); } }), { retired: false, stopped: 0 });
  assert.deepEqual(await C.restartIdleCodex({ service: { retire: () => Promise.reject(new Error('x')) }, sessions: () => null }), { retired: true, stopped: 0 });
});

// ---- the user's own switch ----

const open = [];
after(async () => { await Promise.all(open.map((s) => s.close({ graceMs: 100 }).catch(() => {}))); });

test('the user\'s "do not check for updates" is asked of Codex itself, never read from its files', async () => {
  const answer = (config) => { const calls = []; return { calls, call: async (method, params) => { calls.push([method, params]); return config; } }; };
  const off = answer({ ok: true, result: { config: { model: 'gpt-6-luna', check_for_update_on_startup: false }, origins: {} } });
  assert.equal(await C.codexUpdatesOff(off), true);
  assert.deepEqual(off.calls, [['config/read', { includeLayers: false }]]);
  assert.equal(await C.codexUpdatesOff(answer({ ok: true, result: { config: { check_for_update_on_startup: true } } })), false);
  assert.equal(await C.codexUpdatesOff(answer({ ok: true, result: { config: { model: 'gpt-6-luna' } } })), false, 'not set: Codex\'s default, which is to check');
  assert.equal(await C.codexUpdatesOff(answer({ ok: true, result: { config: { check_for_update_on_startup: 'false' } } })), false, 'only a real false');
  assert.equal(await C.codexUpdatesOff(answer({ ok: false, code: 'not-installed', message: 'Codex was not found.' })), false);
  assert.equal(await C.codexUpdatesOff({ call: async () => { throw new Error('gone'); } }), false);
  assert.equal(await C.codexUpdatesOff(null), false);

  // Through the real helper, on the scripted app-server.
  const fake = createFakeCodex({ handlers: { 'config/read': () => ({ config: { model: null, check_for_update_on_startup: false }, origins: {} }) } });
  const service = new CodexService({ codexPath: '/fake/codex', env: { PATH: '/usr/bin', HOME: '/tmp' }, spawnFn: fake.spawnFn, timeouts: { init: 1000, request: 1000 } });
  open.push(service);
  assert.equal(await C.codexUpdatesOff(service), true);
  assert.deepEqual(fake.sent('config/read')[0].params, { includeLayers: false });
  const plain = createFakeCodex();
  const second = new CodexService({ codexPath: '/fake/codex', env: { PATH: '/usr/bin', HOME: '/tmp' }, spawnFn: plain.spawnFn, timeouts: { init: 1000, request: 1000 } });
  open.push(second);
  assert.equal(await C.codexUpdatesOff(second), false);
});

// ---- the words ----

const status = (over = {}) => ({ autoUpdate: true, blockedBy: null, version: '0.153.4', engineVersion: '0.153.4', behind: false, doing: null, lastCheck: null, lastUpdate: null, fixups: [], drift: [], ...over });
const NOW = 2_000_000_000_000;

test('the status line under "Version" says the same things for Codex as for Claude Code', () => {
  assert.equal(W.upkeepLine(status(), false, NOW), 'Not checked yet');
  assert.equal(W.upkeepLine(status(), true, NOW), 'Checking for updates…');
  assert.equal(W.upkeepLine(status({ doing: 'updating' }), false, NOW), 'Checking for updates…');
  assert.equal(W.upkeepLine(status({ lastCheck: { at: NOW - 2 * HOUR, result: 'current', version: '0.153.4', detail: null, reason: 'scheduled' } }), false, NOW), 'Up to date · checked 2 h ago');
  const at = NOW - 5 * MIN;
  assert.equal(W.upkeepLine(status({ version: '0.167.2', lastUpdate: { at, from: '0.153.4', to: '0.167.2' }, lastCheck: { at, result: 'updated', version: '0.167.2', detail: null, reason: 'scheduled' } }), false, NOW), 'Updated from 0.153.4 · 5 min ago');
  assert.equal(W.upkeepLine(status({ lastCheck: { at, result: 'failed', version: '0.153.4', detail: 'brew is not on your PATH', reason: 'manual' } }), false, NOW), 'Couldn’t update: brew is not on your PATH');
  assert.equal(W.upkeepLine(status({ lastCheck: { at, result: 'failed', version: null, detail: null, reason: 'manual' } }), false, NOW), 'Couldn’t update: unknown error');
  assert.equal(W.upkeepLine(status({ version: '0.150.0', behind: true }), false, NOW), 'Older than Canopy needs (0.153.4). Updating soon.');
  assert.equal(W.upkeepLine(status({ version: '0.150.0', behind: true, autoUpdate: false }), false, NOW), 'Older than Canopy needs (0.153.4). Check now to update.');
  assert.equal(W.upkeepLine(status({ version: '0.150.0', behind: true, blockedBy: C.CODEX_UPDATES_OFF }), false, NOW), 'Older than Canopy needs (0.153.4). Check now to update.');
  // An older update followed by a later check reads as the later check.
  assert.equal(W.upkeepLine(status({ lastUpdate: { at: NOW - 30 * HOUR, from: '0.150.0', to: '0.153.4' }, lastCheck: { at: NOW - MIN, result: 'current', version: '0.153.4', detail: null, reason: 'scheduled' } }), false, NOW), 'Up to date · checked 1 min ago');
  assert.equal(W.ago(NOW - 20_000, NOW), 'just now');
});

test('the switch: on by default, shown off with the reason when the user\'s Codex settings say not to update', () => {
  assert.equal(W.switchOn(status()), true);
  assert.equal(W.switchHint(status()), 'Updates in the background, only while no chat is working.');
  assert.equal(W.switchOn(status({ autoUpdate: false })), false);
  const blocked = status({ blockedBy: C.CODEX_UPDATES_OFF });
  assert.equal(W.switchOn(blocked), false);
  assert.equal(W.switchHint(blocked), 'Updates are turned off in your Codex settings.');
});

test('each row of "Not shown yet" names the tool and version that sent it', () => {
  const d = { label: 'codex/item/hologram', keys: ['id'], version: '0.153.4', at: NOW - 2 * HOUR, count: 3 };
  assert.equal(W.driftHint('Codex', d, NOW), 'Codex 0.153.4 · first seen 2 h ago · 3 times');
  assert.equal(W.driftHint('Claude Code', { ...d, version: null, count: 1 }, NOW), 'Claude Code ? · first seen 2 h ago');
});

test('"Not shown yet" folded to one line counts what the tool sent that was skipped', () => {
  assert.equal(W.driftLine('Claude Code', 1), '1 thing Claude Code sent that this version of Canopy skips. Nothing is broken.');
  assert.equal(W.driftLine('Claude Code', 3), '3 things Claude Code sent that this version of Canopy skips. Nothing is broken.');
  assert.equal(W.driftLine('Codex', 1), '1 thing Codex sent that this version of Canopy skips. Nothing is broken.');
  assert.equal(W.driftLine('Codex', 3), '3 things Codex sent that this version of Canopy skips. Nothing is broken.');
});

test('the three toasts are the same for both tools, with the name swapped', () => {
  const updated = { kind: 'updated', from: '0.153.4', to: '0.167.2' };
  assert.deepEqual(W.upkeepToast('Codex', updated), { id: 'upkeep:codex', title: 'Codex updated to 0.167.2', description: 'New chats use it right away.', good: false });
  assert.deepEqual(W.upkeepToast('Codex', { ...updated, kind: 'repaired' }), { id: 'upkeep:codex', title: 'Codex updated to 0.167.2', description: 'It was too old for Canopy. Send your message again.', good: true });
  assert.equal(W.upkeepToast('Codex', { kind: 'drift', label: 'codex/item/hologram' }), null);
  // Claude Code's are id for id what they were, and each names the page its list is on.
  assert.deepEqual(W.upkeepToast('Claude Code', { kind: 'updated', from: '2.1.321', to: '2.1.322' }), { id: 'upkeep', title: 'Claude Code updated to 2.1.322', description: 'New chats use it right away.', good: false });
  assert.deepEqual(W.upkeepToast('Claude Code', { kind: 'repaired', from: '2.1.321', to: '2.1.322' }), { id: 'upkeep', title: 'Claude Code updated to 2.1.322', description: 'It was too old for Canopy. Send your message again.', good: true });
  assert.equal(W.upkeepToast('Claude Code', { kind: 'drift', label: 'system/new_thing' }), null);
});

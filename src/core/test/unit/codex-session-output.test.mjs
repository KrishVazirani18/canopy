// A running command's output in a Codex chat (CodexSession): `tool-output` reaches the chat's listeners as the
// command prints, in order, and stops at its result; what a reloaded window is given back is one tail per command
// still running, never the chunks; a quick command gives none; and none of it is kept once the turn is over.
// Driven by the scripted Codex (fake-codex.mjs) and by the recorded session codex-command-output.jsonl. No Codex is
// started and nothing under ~/.codex is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex, recordedIds } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import * as codexAdapter from '../../codex-adapter.mjs';
import { CodexSession } from '../../codex-session.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-output-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const open = [];
const fakes = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  const left = fakes.splice(0).flatMap((f) => f.alive());
  assert.equal(left.length, 0, 'every process a session started is gone once it is disposed');
});

// The adapter holds output back so the window gets at most one `tool-output` every 100 ms. The tests own its clock:
// `clock.tick()` before a chunk lets that chunk through on its own; without it, chunks are held and sent together.
function make(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  fakes.push(fake);
  const clock = { now: 1000, tick(ms = 200) { this.now += ms; } };
  const asked = [];
  const adapter = { ...codexAdapter, createAdapter: (o) => { asked.push(o); return codexAdapter.createAdapter({ ...o, now: () => clock.now }); } };
  const s = new CodexSession({
    cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: home }, spawnFn: fake.spawnFn, adapter,
    ...opts, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
  });
  open.push(s);
  return { s, fake, w: watch(s), clock, asked };
}

const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });
const command = (id, typed, extra = {}) => ({
  type: 'commandExecution', id, pluginId: null, scriptPath: null, command: `/bin/zsh -lc '${typed}'`, cwd: work, processId: '4242',
  source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: typed }], aggregatedOutput: null, exitCode: null, durationMs: null, ...extra,
});
const begin = (child, item) => child.note('item/started', { item, threadId: child.threadId, turnId: child.turn.id, startedAtMs: Date.now() });
const finish = (child, item, extra = {}) => child.note('item/completed', {
  item: { ...item, status: 'completed', exitCode: 0, durationMs: 12, ...extra }, threadId: child.threadId, turnId: child.turn.id, completedAtMs: Date.now(),
});
const print = (child, itemId, delta, turnId = child.turn.id) => child.note('item/commandExecution/outputDelta', { threadId: child.threadId, turnId, itemId, delta });
const outputs = (w, from = 0) => w.of('tool-output', from);
/** A held turn that has started: the test plays the rest. */
async function running(opts, script) {
  const made = make(opts, { holdTurns: true, ...script });
  made.s.send('run it');
  await made.w.waitFor('message-start', { ms: 3000 });
  return { ...made, child: made.fake.last };
}

test('the session asks its adapter for live output', () => {
  const { asked } = make();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolOutput, true);
});

test('output reaches the listeners in order, on the command\'s own row, and stops at its result', async () => {
  const { s, w, child, clock } = await running();
  const item = command('exec-1', 'npm test');
  begin(child, item);
  const row = await w.waitFor('tool-start', { ms: 2000 });
  assert.equal(row.name, 'Bash');
  for (const chunk of ['compiling\n', 'running 12 tests\n', '\x1b[32m12 passed\x1b[0m\n']) { clock.tick(); print(child, 'exec-1', chunk); }
  await until(() => outputs(w).length === 3, 3000, 'three chunks');
  assert.deepEqual(outputs(w).map((e) => [e.id, e.text]), [['exec-1', 'compiling\n'], ['exec-1', 'running 12 tests\n'], ['exec-1', '12 passed\n']], 'in order, colour codes taken out');
  for (const e of outputs(w)) assert.equal(e.replace, undefined, 'a live chunk adds to what the window has');
  const seqs = outputs(w).map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

  finish(child, item, { aggregatedOutput: 'compiling\nrunning 12 tests\n12 passed\n' });
  const result = await w.waitFor('tool-result', { ms: 2000 });
  assert.equal(result.id, row.id);
  assert.equal(result.content, 'compiling\nrunning 12 tests\n12 passed\n');
  assert.ok(outputs(w).every((e) => w.indexOf(e) > w.indexOf(row) && w.indexOf(e) < w.indexOf(result)), 'between the row opening and its result');
  child.playText('Tests pass.');
  await idle(w);
  assert.equal(outputs(w).length, 3, 'nothing after the result');
  assert.equal(s.snapshot().turn.length, 0);
});

test('chunks that come faster than the window is told are held, and the last of them goes out before the result', async () => {
  const { w, child } = await running();
  const item = command('exec-1', 'yes');
  begin(child, item);
  await w.waitFor('tool-start', { ms: 2000 });
  for (const chunk of ['a\n', 'b\n', 'c\n', 'd\n']) print(child, 'exec-1', chunk); // the clock stands still
  finish(child, item, { aggregatedOutput: 'a\nb\nc\nd\n' });
  const result = await w.waitFor('tool-result', { ms: 2000 });
  assert.deepEqual(outputs(w).map((e) => e.text), ['a\n', 'b\nc\nd\n'], 'the first at once, the rest together');
  assert.ok(w.indexOf(outputs(w).at(-1)) < w.indexOf(result));
  child.playText();
  await idle(w);
});

test('the recording: what streams is line 2 and line 3, never line 1 (Codex itself lost the first chunk)', async () => {
  const ids = recordedIds('codex-command-output');
  const { s, w } = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-command-output') });
  s.send('Run the loop');
  await idle(w);
  const row = w.find((e) => e.kind === 'tool-start' && e.name === 'Bash');
  const result = w.find((e) => e.kind === 'tool-result' && e.id === row.id);
  const out = outputs(w);
  assert.ok(out.length >= 1);
  for (const e of out) assert.equal(e.id, row.id);
  assert.equal(out.map((e) => e.text).join(''), 'line 2\nline 3\n');
  assert.equal(w.events.some((e) => typeof e.text === 'string' && e.kind === 'tool-output' && e.text.includes('line 1')), false, 'no first line is made up');
  assert.equal(result.content, 'line 2\nline 3\n', 'the result has the same gap: Canopy shows what it is given');
  assert.ok(out.every((e) => w.indexOf(e) < w.indexOf(result)));
  assert.equal(w.find('turn-end').subtype, 'success');
});

test('snapshot() during the command has one replacing tail, not the chunks; none once the command is done', async () => {
  const { s, w, child, clock } = await running();
  const item = command('exec-1', 'make');
  begin(child, item);
  await w.waitFor('tool-start', { ms: 2000 });
  assert.deepEqual(s.snapshot().turn.filter((e) => e.kind === 'tool-output'), [], 'nothing printed yet');
  for (let i = 1; i <= 100; i++) { clock.tick(); print(child, 'exec-1', `step ${i}\n`); }
  await until(() => outputs(w).length === 100, 4000, 'a hundred chunks');

  const tails = s.snapshot().turn.filter((e) => e.kind === 'tool-output');
  assert.equal(tails.length, 1, 'one event for the command, not a hundred');
  assert.equal(tails[0].id, 'exec-1');
  assert.equal(tails[0].replace, true);
  assert.equal(tails[0].text, Array.from({ length: 100 }, (_, i) => `step ${i + 1}\n`).join(''));
  assert.equal(tails[0].seq, outputs(w).at(-1).seq, 'it says which chunk it reaches up to');
  assert.equal(s.turn.some((e) => e.kind === 'tool-output'), false, 'the turn log itself holds no output');
  assert.deepEqual(s.snapshot().turn.at(-1), tails[0], 'after the rows it belongs to');
  assert.equal(s.snapshot().turn.findIndex((e) => e.kind === 'tool-start' && e.id === 'exec-1') < s.snapshot().turn.length - 1, true);

  finish(child, item, { aggregatedOutput: 'done\n' });
  await w.waitFor('tool-result', { ms: 2000 });
  assert.deepEqual(s.snapshot().turn.filter((e) => e.kind === 'tool-output'), [], 'the result is the truth from here on');
  // A chunk that comes after the result is not taken for a command still running.
  clock.tick();
  print(child, 'exec-1', 'late\n');
  await sleep(40);
  assert.deepEqual(s.snapshot().turn.filter((e) => e.kind === 'tool-output'), []);
  child.playText();
  await idle(w);
  assert.equal(s.tails.size, 0, 'nothing is kept past the turn');
});

test('two commands printing at once: a tail each, and the one that finishes loses its own', async () => {
  const { s, w, child, clock } = await running();
  const a = command('exec-a', 'npm run build');
  const b = command('exec-b', 'npm test');
  begin(child, a); begin(child, b);
  await until(() => w.of('tool-start').length === 2);
  clock.tick(); print(child, 'exec-a', 'building\n');
  clock.tick(); print(child, 'exec-b', 'testing\n');
  clock.tick(); print(child, 'exec-a', 'built\n');
  await until(() => outputs(w).length === 3);
  const tails = () => s.snapshot().turn.filter((e) => e.kind === 'tool-output').map((e) => [e.id, e.text, e.replace]);
  assert.deepEqual(tails(), [['exec-a', 'building\nbuilt\n', true], ['exec-b', 'testing\n', true]]);
  finish(child, a, { aggregatedOutput: 'building\nbuilt\n' });
  await w.waitFor('tool-result', { ms: 2000 });
  assert.deepEqual(tails(), [['exec-b', 'testing\n', true]]);
  finish(child, b, { aggregatedOutput: 'testing\n' });
  child.playText();
  await idle(w);
});

test('a quick command sends no output before its result: nothing streams and nothing is kept', async () => {
  const { s, w, child } = await running();
  const item = command('exec-1', 'pwd');
  begin(child, item);
  finish(child, item, { aggregatedOutput: `${work}\n` });
  const result = await w.waitFor('tool-result', { ms: 2000 });
  assert.equal(result.content, `${work}\n`);
  assert.deepEqual(outputs(w), []);
  assert.deepEqual(s.snapshot().turn.filter((e) => e.kind === 'tool-output'), []);
  child.playText();
  await idle(w);
  assert.deepEqual(outputs(w), []);
});

test('chunks for a turn that is already closed are dropped', async () => {
  const { s, w, child, clock } = await running();
  const item = command('exec-1', 'tail -f log');
  begin(child, item);
  await w.waitFor('tool-start', { ms: 2000 });
  clock.tick(); print(child, 'exec-1', 'one\n');
  await until(() => outputs(w).length === 1);
  const turnId = child.turn.id;
  child.completeTurn('interrupted');
  await idle(w);
  const mark = w.mark();
  clock.tick(); print(child, 'exec-1', 'two\n', turnId);
  clock.tick(); print(child, 'exec-1', 'three\n', turnId);
  await sleep(60);
  assert.deepEqual(w.events.slice(mark).filter((e) => e.kind === 'tool-output'), [], 'nothing reaches the window');
  assert.deepEqual(s.snapshot().turn, []);
  assert.equal(s.tails.size, 0);
});

test('a command that prints 10,000 chunks: every one reaches the window, the turn log stays small, the tail is capped', async () => {
  const { s, w, child, clock } = await running();
  const item = command('exec-1', 'yes');
  begin(child, item);
  await w.waitFor('tool-start', { ms: 2000 });
  const before = s.turn.length;
  for (let i = 1; i <= 10_000; i++) { clock.tick(); print(child, 'exec-1', `line ${i}\n`); }
  await until(() => outputs(w).length === 10_000, 15000, 'ten thousand chunks');
  assert.equal(s.turn.length, before, 'not one chunk went into the turn log');
  const snap = s.snapshot();
  assert.ok(snap.turn.length <= before + 1, `the snapshot's turn holds ${snap.turn.length} events`);
  const tail = snap.turn.at(-1);
  assert.equal(tail.kind, 'tool-output');
  assert.equal(tail.text.length, 8000, 'the last 8,000 characters');
  assert.ok(tail.text.endsWith('line 9999\nline 10000\n'));
  assert.equal(s.tails.size, 1);
  finish(child, item, { aggregatedOutput: 'line 10000\n' });
  child.playText();
  await idle(w);
  assert.equal(s.tails.size, 0);
});

test('history() of a chat whose command is still printing ends with that command\'s tail; a page of the past has none', async () => {
  const { s, w, child, clock } = await running();
  const item = command('exec-1', 'npm test');
  begin(child, item);
  await w.waitFor('tool-start', { ms: 2000 });
  clock.tick(); print(child, 'exec-1', 'one\n');
  clock.tick(); print(child, 'exec-1', 'two\n');
  await until(() => outputs(w).length === 2);
  const h = await s.history();
  assert.equal(h.ok, true);
  const start = h.events.findIndex((e) => e.kind === 'tool-start' && e.id === 'exec-1');
  assert.ok(start >= 0, 'the running command has its row');
  assert.deepEqual(h.events.at(-1), { kind: 'tool-output', id: 'exec-1', text: 'one\ntwo\n', replace: true, seq: outputs(w).at(-1).seq });
  assert.equal(h.events.filter((e) => e.kind === 'tool-output').length, 1);
  assert.ok(h.events.length - 1 > start, 'the tail comes after its row');

  finish(child, item, { aggregatedOutput: 'one\ntwo\n' });
  child.playText();
  await idle(w);
  assert.equal((await s.history()).events.some((e) => e.kind === 'tool-output'), false, 'a finished chat carries none');
});

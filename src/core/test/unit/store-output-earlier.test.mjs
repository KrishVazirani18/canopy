// The window's side of two things an OpenAI chat can do (renderer/src/lib/store.ts):
//   live output    `tool-output` grows a running step's output, and its result takes over
//   Show earlier   `earlier` marks that a long chat has an older part; loadEarlier() fetches a page of it and puts
//                  it in front of what is on screen, leaving everything on screen exactly as it was
// A Claude chat sends neither event, so nothing here changes what a Claude chat shows.
//
// The store is the real one. Node reads its TypeScript as it is; the few things it expects from a window (the bridge
// to main, animation frames, storage) are stood in for here, as in store-edit.test.mjs.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

// The renderer imports its own files without an extension (the bundler's way): try `.ts` when a bare path isn't found.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (err) {
      if (specifier.startsWith('.') && !path.extname(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});

// The bridge to main, as a stand-in: every call is recorded, and `earlier` answers what the test says (a value, a
// function of the call, or `hold`: a promise the test settles itself).
const bridge = { calls: [], earlier: null, paneEarlier: null };
const answer = (how, args) => Promise.resolve(typeof how === 'function' ? how(...args) : how);
const canopy = {
  send: () => Promise.resolve({ ok: true }), interrupt: () => Promise.resolve(), set: () => Promise.resolve(), respond: () => Promise.resolve(),
  context: () => Promise.resolve(null), queue: () => Promise.resolve({ ok: true, queue: [], v: 1 }), unqueue: () => Promise.resolve({ ok: true, removed: true, queue: [], v: 2 }),
  earlier: (...args) => { bridge.calls.push(['earlier', ...args]); return answer(bridge.earlier, args); },
  pane: { earlier: (...args) => { bridge.calls.push(['pane.earlier', ...args]); return answer(bridge.paneEarlier, args); } },
};
globalThis.window = { canopy, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);

const lib = (file) => import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/lib', file)).href);
const [E, S, T] = await Promise.all([lib('edit.ts'), lib('store.ts'), lib('tail.ts')]);

beforeEach(() => { bridge.calls.length = 0; bridge.earlier = null; bridge.paneEarlier = null; });

const CHAT = '019a0000-0000-7000-8000-0000000000aa';
const tool = (s, id) => { const find = (items) => { for (const it of items) { if (it.t === 'tool') { if (it.id === id) return it; const c = find(it.children); if (c) return c; } } return null; }; return find(s.items); };
const said = (s) => s.items.map((it) => (it.t === 'user' ? `you:${it.text}` : it.t === 'assistant' ? `codex:${it.text}` : it.t === 'tool' ? `step:${it.id}` : it.t)).join(' | ');

/** An OpenAI chat with a command running. */
function running() {
  const s = new S.Store();
  s.setEngine('codex');
  s.handle({ kind: 'init', engine: 'codex', sessionId: CHAT, model: 'gpt-6.1-sol' });
  s.handle({ kind: 'busy', busy: true, state: 'running' });
  s.addUser('run the tests', 0);
  s.handle({ kind: 'tool-start', id: 'exec-1', name: 'Bash', input: { command: 'npm test' } });
  return s;
}

// ---------- live output ----------

test('tool-output grows the running step\'s output, in order, and the step is redrawn each time', () => {
  const s = running();
  const t = tool(s, 'exec-1');
  assert.equal(t.output, undefined, 'a step has no output until some arrives');
  const rev = t.rev;
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'compiling\n', seq: 11 });
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'running 12 ', seq: 12 });
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'tests\n', seq: 13 });
  assert.equal(t.output, 'compiling\nrunning 12 tests\n');
  assert.equal(t.rev, rev + 3);
  assert.equal(t.status, 'running');
  assert.equal(s.items.some((it) => it.t === 'raw'), false, 'output is never a row of its own');
});

test('a progress bar is one line, and the output is capped from the end', () => {
  const s = running();
  const t = tool(s, 'exec-1');
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'Downloading\n' });
  for (let i = 1; i <= 50; i++) s.handle({ kind: 'tool-output', id: 'exec-1', text: `\r${i * 2}%` });
  assert.equal(t.output, 'Downloading\n100%');
  s.handle({ kind: 'tool-output', id: 'exec-1', text: `\n${'x'.repeat(T.OUTPUT_CAP)}\nTHE END\n` });
  assert.ok(t.output.length <= T.OUTPUT_CAP);
  assert.ok(t.output.endsWith('\nTHE END\n'));
  assert.equal(t.output.includes('Downloading'), false, 'the start is what goes');
});

test('the result takes over: the output is cleared, and nothing is added after it', () => {
  const s = running();
  const t = tool(s, 'exec-1');
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'line 2\n' });
  s.handle({ kind: 'tool-result', id: 'exec-1', content: 'line 2\nline 3\n', isError: false });
  assert.equal(t.output, undefined);
  assert.equal(t.result, 'line 2\nline 3\n');
  assert.equal(t.status, 'done');
  const rev = t.rev;
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'late\n' });
  assert.equal(t.output, undefined, 'a chunk that comes after the result is dropped');
  assert.equal(t.rev, rev);
  // A command that finished with no output at all still has a result: an empty one counts.
  s.handle({ kind: 'tool-start', id: 'exec-2', name: 'Bash', input: { command: 'true' } });
  s.handle({ kind: 'tool-result', id: 'exec-2', content: '', isError: false });
  s.handle({ kind: 'tool-output', id: 'exec-2', text: 'late\n' });
  assert.equal(tool(s, 'exec-2').output, undefined);
});

test('output for a step that is not there, or once its turn has ended, changes nothing', () => {
  const s = running();
  const before = s.items.length;
  s.handle({ kind: 'tool-output', id: 'no-such-step', text: 'hello\n' });
  s.handle({ kind: 'tool-output', id: 'exec-1' });
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 5 });
  assert.equal(s.items.length, before);
  assert.equal(tool(s, 'exec-1').output, undefined);
  // The turn was stopped while the command ran: its row is closed, and a chunk still on its way is not shown.
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'one\n' });
  s.handle({ kind: 'turn-end', interrupted: true });
  const t = tool(s, 'exec-1');
  assert.equal(t.status, 'error');
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'two\n' });
  assert.equal(t.output, 'one\n');
  // A turn that ended normally with a step that never got a result (it should not happen): the same.
  s.handle({ kind: 'tool-start', id: 'exec-3', name: 'Bash', input: { command: 'sleep 9' } });
  s.handle({ kind: 'turn-end' });
  s.handle({ kind: 'tool-output', id: 'exec-3', text: 'late\n' });
  assert.equal(tool(s, 'exec-3').output, undefined);
  assert.equal(tool(s, 'exec-3').status, 'done');
});

test('a chat reopened while a command prints: the saved tail shows the step as running, and no chunk is shown twice', () => {
  const s = new S.Store();
  s.setEngine('codex');
  // What main hands a reopened chat: its history, ending with everything kept of the running command's output.
  s.loadHistory([
    { kind: 'user-text', text: 'run the tests', images: 0 },
    { kind: 'tool-start', id: 'exec-1', name: 'Bash', input: { command: 'npm test' } },
    { kind: 'tool-start', id: 'exec-0', name: 'Bash', input: { command: 'ls' } },
    { kind: 'tool-result', id: 'exec-0', content: 'a\nb\n', isError: false },
    { kind: 'tool-output', id: 'exec-1', text: 'one\ntwo\n', replace: true, seq: 40 },
  ]);
  const t = tool(s, 'exec-1');
  assert.equal(t.output, 'one\ntwo\n');
  assert.equal(t.status, 'running', 'a step from a saved chat reads as finished, unless it is still printing');
  assert.equal(tool(s, 'exec-0').status, 'done');
  // Chunks the snapshot already covers arrive again (they were on their way while the chat opened): skipped.
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'one\n', seq: 39 });
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'two\n', seq: 40 });
  assert.equal(t.output, 'one\ntwo\n');
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'three\n', seq: 41 });
  assert.equal(t.output, 'one\ntwo\nthree\n');
  // A later tail replaces what is there (the chat reopened again).
  s.handle({ kind: 'tool-output', id: 'exec-1', text: 'two\nthree\nfour\n', replace: true, seq: 44 });
  assert.equal(t.output, 'two\nthree\nfour\n');
  s.handle({ kind: 'tool-result', id: 'exec-1', content: 'one\ntwo\nthree\nfour\n', isError: false });
  assert.deepEqual([t.status, t.output, t.result], ['done', undefined, 'one\ntwo\nthree\nfour\n']);
});

test('a Claude chat is untouched: its steps never have output, and its events are handled as before', () => {
  const s = new S.Store();
  s.handle({ kind: 'busy', busy: true, state: 'running' });
  s.addUser('run the tests', 0);
  s.handle({ kind: 'tool-start', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } });
  s.handle({ kind: 'tool-progress', id: 'toolu_1', elapsed: 4 });
  const t = tool(s, 'toolu_1');
  assert.deepEqual([t.status, t.elapsed, t.output, 'output' in t], ['running', 4, undefined, false]);
  s.handle({ kind: 'tool-result', id: 'toolu_1', content: 'ok', isError: false });
  assert.deepEqual([t.status, t.result, t.output], ['done', 'ok', undefined]);
  assert.equal(s.meta.earlier, undefined);
});

// ---------- Show earlier ----------

const turnEvents = (n, extra = []) => [
  { kind: 'user-text', text: `question ${n}`, images: 0, uuid: `u${n}`, at: 1000 + n },
  ...extra,
  { kind: 'assistant-text', text: `answer ${n}`, at: 1000 + n },
  { kind: 'turn-end', durationMs: 1000, text: `answer ${n}`, at: 1000 + n },
];
const page = (from, to, cursor) => [...(cursor ? [{ kind: 'earlier', cursor, history: true }] : []), ...Array.from({ length: to - from + 1 }, (_, i) => turnEvents(from + i)).flat()];
/** A long OpenAI chat as it opens: turns 7 to 9 on screen, the marker saying where the older ones begin. */
function long(pane = false) {
  const s = pane ? new S.Store('pane-chat', '/work', true) : new S.Store();
  s.setEngine('codex');
  s.setMeta({ sessionId: CHAT });
  s.loadHistory(page(7, 9, 'c1'));
  return s;
}
const questions = (s) => s.items.filter((it) => it.t === 'user').map((it) => it.text);

test('the marker says where the older part begins, and is not a row', () => {
  const s = long();
  assert.deepEqual(s.meta.earlier, { cursor: 'c1' });
  assert.equal(said(s), 'you:question 7 | codex:answer 7 | turn | you:question 8 | codex:answer 8 | turn | you:question 9 | codex:answer 9 | turn');
  assert.equal(s.items.some((it) => it.t === 'raw' || it.t === 'notice'), false);
  // A chat that is read whole has none, and a new chat forgets the last one's.
  s.reset();
  assert.equal(s.meta.earlier, undefined);
  s.handle({ kind: 'earlier', cursor: '' });
  assert.equal(s.meta.earlier, undefined);
});

test('loadEarlier puts a page in front, twice, and the marker goes with the last page', async () => {
  const s = long();
  const onScreen = [...s.items];
  bridge.earlier = (sessionId, cwd, cursor) => (cursor === 'c1' ? { events: page(4, 6, 'c2') } : { events: page(1, 3, null) });
  assert.equal(await s.loadEarlier(), true);
  assert.deepEqual(bridge.calls, [['earlier', CHAT, null, 'c1']]);
  assert.deepEqual(questions(s), [4, 5, 6, 7, 8, 9].map((n) => `question ${n}`));
  assert.deepEqual(s.meta.earlier, { cursor: 'c2' });
  assert.deepEqual(s.items.slice(-onScreen.length), onScreen, 'what was on screen is still there, after the page');
  for (let i = 0; i < onScreen.length; i++) assert.equal(s.items[s.items.length - onScreen.length + i], onScreen[i], 'the very same rows: nothing below the page is redrawn');

  assert.equal(await s.loadEarlier(), true);
  assert.deepEqual(bridge.calls.at(-1), ['earlier', CHAT, null, 'c2']);
  assert.deepEqual(questions(s), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `question ${n}`));
  assert.equal(s.meta.earlier, undefined, 'nothing older anywhere: the button goes');
  assert.equal(await s.loadEarlier(), null, 'and there is nothing left to ask for');
  assert.equal(bridge.calls.length, 2);
  // Every row has its own key, and the older ones read as history.
  assert.equal(new Set(s.items.map((it) => it.key)).size, s.items.length);
  assert.equal(s.items.slice(0, 18).every((it) => it.hist === true), true);
  assert.equal(s.items[0].at, 1001, 'a page keeps when things really happened');
});

test('a page is numbered below everything on screen, so the vitals and the edit wall are not moved by it', async () => {
  const s = long();
  s.handle({ kind: 'notice', code: 'compacted', text: 'Conversation compacted' });
  const wall = s.wall;
  assert.ok(wall > 0);
  const before = { ...s.meta, stats: { ...s.meta.stats } };
  bridge.earlier = { events: [{ kind: 'notice', code: 'compacted', text: 'Conversation compacted', history: true }, ...page(5, 6, null).map((e) => (e.kind === 'turn-end' ? { ...e, fastState: 'on', cost: 9 } : e))] };
  assert.equal(await s.loadEarlier(), true);
  assert.equal(s.wall, wall, 'the newest place the chat was summarized is still the one on screen');
  const numbers = s.items.map((it) => E.itemNumber(it));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'in order from the top of the chat to the end');
  assert.ok(numbers[0] < 0);
  const older = s.items.find((it) => it.t === 'user' && it.text === 'question 5');
  assert.equal(E.editBlocked(older, { wall: s.wall }), 'boundary', 'a message from an earlier page is above the wall');
  assert.equal(E.editBlocked(older, { wall: 0 }), 'boundary', 'and is never offered an edit, even in a chat that was never summarized');
  // Only the turn count and working time grow. What the page's last turn said about speed or cost is not now.
  assert.deepEqual(s.meta.stats, { ...before.stats, turns: before.stats.turns + 2, workMs: before.stats.workMs + 2000 });
  assert.deepEqual({ ...s.meta, stats: null, earlier: null }, { ...before, stats: null, earlier: null });
});

test('a page lands while the chat is working: the reply being written and its open prompt are left alone', async () => {
  const s = long();
  s.handle({ kind: 'busy', busy: true, state: 'running' });
  s.addUser('question 10', 0);
  s.handle({ kind: 'tool-start', id: 'exec-live', name: 'Bash', input: { command: 'make' } });
  s.handle({ kind: 'tool-output', id: 'exec-live', text: 'building\n' });
  s.handle({ kind: 'permission', id: 7, type: 'tool', toolName: 'Bash', toolUseId: 'exec-live', input: { command: 'make' } });
  s.handle({ kind: 'text-delta', text: 'Working on' });
  const live = s.items.at(-1);
  const step = tool(s, 'exec-live');
  const prompt = s.items.find((it) => it.t === 'permission');
  bridge.earlier = { events: page(5, 6, null).concat([{ kind: 'tool-start', id: 'exec-old', name: 'Bash', input: { command: 'ls' } }, { kind: 'tool-result', id: 'exec-old', content: 'a\n', isError: false }]) };
  assert.equal(await s.loadEarlier(), true);
  assert.equal(s.meta.busy, true);
  assert.equal(s.items.at(-1), live);
  assert.equal(live.streaming, true, 'the reply is still being written');
  s.handle({ kind: 'text-delta', text: ' it' });
  assert.equal(live.text, 'Working on it', 'and what arrives next still goes to it');
  assert.equal(step.status, 'approval');
  s.handle({ kind: 'permission-resolved', id: 7 });
  assert.equal(prompt.resolved, true);
  assert.equal(step.status, 'running');
  s.handle({ kind: 'tool-output', id: 'exec-live', text: 'built\n' });
  assert.equal(step.output, 'building\nbuilt\n');
  // The page's own step is known too: it is a row like any other.
  assert.equal(tool(s, 'exec-old').result, 'a\n');
});

test('a step that is on screen already is not drawn a second time by a page that holds it too', async () => {
  const s = new S.Store();
  s.setEngine('codex');
  s.setMeta({ sessionId: CHAT });
  // The chat opened part-way through a turn: the step's row is here, with its result.
  s.loadHistory([
    { kind: 'earlier', cursor: 'c1', history: true },
    { kind: 'tool-start', id: 'exec-split', name: 'Bash', input: { command: 'make' } },
    { kind: 'tool-result', id: 'exec-split', content: 'built\n', isError: false },
    ...turnEvents(9),
  ]);
  const row = tool(s, 'exec-split');
  bridge.earlier = { events: [
    ...turnEvents(8, [
      { kind: 'tool-start', id: 'exec-split', name: 'Bash', input: { command: 'make' } },
      { kind: 'tool-start', id: 'child-of-split', name: 'Read', input: { file_path: '/a' }, parent: 'exec-split' },
      { kind: 'tool-result', id: 'exec-split', content: 'an older answer', isError: true },
      { kind: 'tool-start', id: 'exec-only-old', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 'exec-only-old', content: 'a\n', isError: false },
    ]),
  ] };
  assert.equal(await s.loadEarlier(), true);
  const rows = [];
  const walk = (items) => { for (const it of items) if (it.t === 'tool') { rows.push(it); walk(it.children); } };
  walk(s.items);
  assert.deepEqual(rows.map((r) => r.id), ['exec-only-old', 'exec-split'], 'one row for the step, the one that was on screen');
  assert.equal(tool(s, 'exec-split'), row);
  assert.deepEqual([row.result, row.isError, row.children.length], ['built\n', false, 0], 'and the page changed nothing about it');
  assert.equal(said(s), 'you:question 8 | step:exec-only-old | codex:answer 8 | turn | step:exec-split | you:question 9 | codex:answer 9 | turn');
});

test('a page that cannot be loaded changes nothing, and can be asked for again', async () => {
  const s = long();
  const items = s.items;
  for (const reply of [{ error: 'Codex did not answer.' }, null, undefined, {}, { events: 'no' }, () => { throw new Error('the bridge broke'); }, () => Promise.reject(new Error('gone'))]) {
    bridge.earlier = reply;
    assert.equal(await s.loadEarlier(), false);
    assert.equal(s.items, items, 'the same list: nothing to redraw');
    assert.deepEqual(s.meta.earlier, { cursor: 'c1' }, 'the button is still there');
  }
  bridge.earlier = { events: page(5, 6, null) };
  assert.equal(await s.loadEarlier(), true);
  assert.deepEqual(questions(s), [5, 6, 7, 8, 9].map((n) => `question ${n}`));
});

test('a page that brings nothing, or the same place again, ends it: the button never asks forever', async () => {
  const empty = long();
  bridge.earlier = { events: [{ kind: 'earlier', cursor: 'c2', history: true }] };
  assert.equal(await empty.loadEarlier(), true);
  assert.equal(empty.meta.earlier, undefined);
  assert.deepEqual(questions(empty), ['question 7', 'question 8', 'question 9']);

  const same = long();
  bridge.earlier = { events: page(5, 6, 'c1') };
  assert.equal(await same.loadEarlier(), true);
  assert.equal(same.meta.earlier, undefined, 'the place it was asked from is not a next place');
  assert.deepEqual(questions(same), [5, 6, 7, 8, 9].map((n) => `question ${n}`));

  // A Claude chat's answer: no events. Nothing changes, nothing left to ask.
  const none = long();
  bridge.earlier = { events: [] };
  assert.equal(await none.loadEarlier(), true);
  assert.equal(none.meta.earlier, undefined);
});

test('one press asks once, and an answer for a chat that is no longer on screen is dropped', async () => {
  const s = long();
  let settle;
  bridge.earlier = () => new Promise((resolve) => { settle = resolve; });
  const first = s.loadEarlier();
  assert.equal(await s.loadEarlier(), null, 'a page is already on its way');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bridge.calls.length, 1);
  // Another chat opens in this window before the answer comes.
  s.reset();
  s.setMeta({ sessionId: 'another-chat' });
  s.loadHistory(turnEvents(1));
  settle({ events: page(5, 6, null) });
  assert.equal(await first, null);
  assert.deepEqual(questions(s), ['question 1'], 'the other chat is not given this one\'s past');
  // And that chat can page for itself straight away.
  s.handle({ kind: 'earlier', cursor: 'z9' });
  bridge.earlier = { events: [] };
  assert.equal(await s.loadEarlier(), true);
  assert.deepEqual(bridge.calls.at(-1), ['earlier', 'another-chat', null, 'z9']);
});

test('a pane asks for its own chat, by the pane\'s id and folder', async () => {
  const s = long(true);
  bridge.paneEarlier = { events: page(5, 6, null) };
  assert.equal(await s.loadEarlier(), true);
  assert.deepEqual(bridge.calls, [['pane.earlier', 'pane-chat', CHAT, '/work', 'c1']]);
  assert.deepEqual(questions(s), [5, 6, 7, 8, 9].map((n) => `question ${n}`));
  // An older main that has no such call: the page cannot be loaded, and nothing breaks.
  const old = long();
  const { earlier } = canopy;
  delete canopy.earlier;
  try { assert.equal(await old.loadEarlier(), false); } finally { canopy.earlier = earlier; }
  assert.deepEqual(old.meta.earlier, { cursor: 'c1' });
});

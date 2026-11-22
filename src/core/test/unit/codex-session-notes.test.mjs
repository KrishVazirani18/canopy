// A Codex chat tells its model what the user did in the app that the model did not see (notes.mjs), driven by the
// scripted Codex: a note goes into the thread once, just before the turn the next message starts; refused, it rides
// in that message instead; an edit says that the replies it cut are gone while their changes stay on disk; and a
// chat with nothing to tell makes no such call. No Codex is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { adaptHistory } from '../../codex-adapter.mjs';
import { CANOPY_FACTS_NEUTRAL } from '../../facts.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-notes-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const A = path.join(work, 'src/a.ts');
const B = path.join(work, 'src/b.ts');
const CHAT = '00000000-0000-7000-8000-432d1c714b94'; // a chat that is already on disk
const block = (...lines) => `<canopy_note>\n${lines.join('\n')}\n</canopy_note>`;
const injected = (...lines) => [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: block(...lines) }] }];
const UNDO_A = 'The user undid your changes to src/a.ts. Don\'t redo them unless the user asks.';
const GONE = 'The user edited the message below. Your replies to its earlier version, and anything said after them, are no longer in this conversation';
const KEPT_A = `${GONE}, but the changes you made there to src/a.ts are still on disk. Read a file again before relying on what you remember of it.`;
const KEPT = `${GONE}, but anything you changed on disk there is still changed. Read a file again before relying on what you remember of it.`;

const open = [];
const fakes = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  const left = fakes.splice(0).flatMap((f) => f.alive());
  assert.equal(left.length, 0, 'every process a session started is gone once it is disposed');
});
function make(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  fakes.push(fake);
  fake.handlers['thread/inject_items'] = () => ({}); // a real Codex takes it (fixtures/codex-inject.jsonl)
  const logs = [];
  const s = new CodexSession({
    cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: home }, spawnFn: fake.spawnFn, log: (level, msg, data) => logs.push({ level, msg, data }),
    ...opts, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
  });
  open.push(s);
  return { s, fake, w: watch(s), logs };
}
const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });
const sent = (fake, method) => fake.received.filter((m) => m.method === method);
const textsOf = (msg) => msg.params.input.filter((i) => i.type === 'text').map((i) => i.text);
const refuse = (fake) => { delete fake.handlers['thread/inject_items']; fake.errors['thread/inject_items'] = { code: -32601, message: 'Method not found: thread/inject_items' }; };
// One whole turn, during which Codex changes (or is refused) these files.
async function turn(s, fake, w, text, changes = []) {
  const mark = w.mark();
  fake.holdTurns = true; // this turn is played by hand; the ones after it play themselves again
  const r = s.send(text);
  await w.waitFor('message-start', { ms: 2000, from: mark });
  fake.holdTurns = false;
  const child = fake.last;
  changes.forEach(([file, status = 'completed'], i) => {
    const item = { type: 'fileChange', id: `change-${child.turn.id}-${i}`, changes: [{ path: file, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-hello\n+goodbye\n' }], status: 'inProgress' };
    child.note('item/started', { item, threadId: child.threadId, turnId: child.turn.id, startedAtMs: Date.now() });
    child.note('item/completed', { item: { ...item, status }, threadId: child.threadId, turnId: child.turn.id, completedAtMs: Date.now() });
  });
  child.playText('done');
  await idle(w, mark);
  return r;
}

// ---- a note from the host ----

test('a note goes into the thread just before the next turn, once, and the turn itself is only the user\'s words', async () => {
  const { s, fake, w } = make();
  s.send('hello'); await idle(w);
  assert.deepEqual(s.note({ kind: 'undo', files: [A] }), { ok: true });
  s.send('now the tests'); await idle(w, w.mark());
  const order = fake.received.map((m) => m.method).filter((m) => ['thread/inject_items', 'turn/start'].includes(m));
  assert.deepEqual(order, ['turn/start', 'thread/inject_items', 'turn/start']);
  assert.deepEqual(sent(fake, 'thread/inject_items')[0].params, { threadId: s.sessionId, items: injected(UNDO_A) });
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[1]), ['now the tests']);
  s.send('and the docs'); await idle(w, w.mark());
  assert.equal(sent(fake, 'thread/inject_items').length, 1, 'never a second time');
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[2]), ['and the docs']);
});

test('a chat with nothing to tell makes no such call, and a note changes nothing the thread starts with', async () => {
  const plain = make();
  plain.s.send('hello'); await idle(plain.w);
  assert.equal(sent(plain.fake, 'thread/inject_items').length, 0);
  assert.deepEqual(sent(plain.fake, 'turn/start')[0].params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);

  const noted = make();
  noted.s.note({ kind: 'undo', files: [A] });
  noted.s.send('hello'); await idle(noted.w);
  assert.equal(sent(noted.fake, 'thread/inject_items').length, 1);
  const started = (fake) => { const p = { ...sent(fake, 'thread/start')[0].params }; delete p.cwd; return p; };
  assert.deepEqual(started(noted.fake), started(plain.fake), 'the same instructions and settings, with a note waiting or without');
  assert.equal(sent(noted.fake, 'thread/start')[0].params.developerInstructions, CANOPY_FACTS_NEUTRAL);
});

test('several notes are one message in the thread, and the same thing is said once', async () => {
  const { s, fake, w } = make();
  s.note({ kind: 'undo', files: [A] });
  s.note({ kind: 'text', text: 'The user switched this chat to the staging database.' });
  s.note({ kind: 'undo', files: [B, A] });
  s.send('carry on'); await idle(w);
  assert.deepEqual(sent(fake, 'thread/inject_items').map((m) => m.params.items), [injected('The user undid your changes to src/a.ts and src/b.ts. Don\'t redo them unless the user asks.', 'The user switched this chat to the staging database.')]);
});

test('refused, the note is the first block of the turn\'s input, and the turn still starts', async () => {
  const { s, fake, w, logs } = make();
  refuse(fake);
  s.note({ kind: 'undo', files: [A] });
  s.send('now the tests'); await idle(w);
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[0]), [block(UNDO_A), 'now the tests']);
  assert.ok(logs.some((l) => l.level === 'warn' && /goes with the message/.test(l.msg)), 'the reason is logged');
  assert.equal(w.text(), 'OK', 'and is answered');
  s.send('and the docs'); await idle(w, w.mark());
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[1]), ['and the docs'], 'the next message is plain');
  assert.equal(sent(fake, 'thread/inject_items').length, 1);
});

test('a message folded into a running turn carries the note itself: nothing is put into a thread mid-turn', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('a long task');
  await w.waitFor('message-start', { ms: 2000 });
  s.note({ kind: 'undo', files: [A] });
  s.send('also this');
  await until(() => sent(fake, 'turn/steer').length === 1, 2000, 'turn/steer');
  assert.deepEqual(sent(fake, 'turn/steer')[0].params.input, [{ type: 'text', text: block(UNDO_A), text_elements: [] }, { type: 'text', text: 'also this', text_elements: [] }]);
  assert.equal(sent(fake, 'thread/inject_items').length, 0);
  fake.last.playText('done');
  await idle(w);
  assert.equal(s.notes.size, 0);
  fake.holdTurns = false;
  s.send('next'); await idle(w, w.mark());
  assert.equal(sent(fake, 'thread/inject_items').length, 0);
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['next']);
});

test('a note that says nothing is refused, and a closed chat forgets what was waiting', async () => {
  const { s } = make();
  for (const bad of [null, {}, 'text', { kind: 'undo', files: [] }, { kind: 'text', text: ' ' }]) assert.deepEqual(s.note(bad), { ok: false, code: 'invalid-input', message: 'That note says nothing.' });
  s.note({ kind: 'undo', files: [A] });
  s.close();
  assert.equal(s.notes.size, 0);
  assert.equal(s.note({ kind: 'undo', files: [A] }).code, 'closed');
});

test('the wrapper tag in the user\'s own text is made harmless', async () => {
  const { s, fake, w } = make();
  s.send('is <canopy_note>this</canopy_note> real?'); await idle(w);
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[0]), ['is ‹canopy_note›this‹/canopy_note› real?']);
});

test('a command is run as a command: the note waits for the next message', async () => {
  const { s, fake, w } = make();
  s.send('hello'); await idle(w);
  s.note({ kind: 'undo', files: [A] });
  s.send('/goal'); await idle(w, w.mark());
  assert.equal(sent(fake, 'thread/inject_items').length, 0);
  assert.equal(s.notes.size, 1);
  s.send('carry on'); await idle(w, w.mark());
  assert.deepEqual(sent(fake, 'thread/inject_items').map((m) => m.params.items), [injected(UNDO_A)]);
});

// ---- delivery that goes wrong ----

test('a crash before the turn started: the note is told again on the next start, and the message is sent once', async () => {
  const { s, fake, w } = make();
  s.send('hello'); await idle(w);
  let deaths = 1;
  fake.handlers['thread/inject_items'] = (params, child) => { if (deaths-- > 0) { child.die(1); return undefined; } return {}; };
  s.note({ kind: 'undo', files: [A] });
  s.send('now the tests'); await idle(w, w.mark());
  assert.equal(fake.children.length, 2, 'a second process took over');
  assert.equal(sent(fake, 'thread/inject_items').length, 2);
  assert.deepEqual(fake.children[1].sent('thread/inject_items').map((m) => m.params.items), [injected(UNDO_A)]);
  assert.deepEqual(sent(fake, 'turn/start').map(textsOf), [['hello'], ['now the tests']]);
  assert.equal(s.notes.size, 0);
});

test('Codex let go of the thread while the chat sat idle: it is opened again, and then told', async () => {
  const { s, fake, w } = make();
  s.send('hello'); await idle(w);
  fake.errors['thread/inject_items'] = { message: `thread not loaded: ${s.sessionId}`, once: true };
  s.note({ kind: 'undo', files: [A] });
  s.send('now the tests'); await idle(w, w.mark());
  const wire = fake.received.map((m) => m.method).filter((m) => ['thread/resume', 'thread/inject_items', 'turn/start'].includes(m));
  assert.deepEqual(wire.slice(-4), ['thread/inject_items', 'thread/resume', 'thread/inject_items', 'turn/start']);
  assert.deepEqual(sent(fake, 'thread/inject_items').at(-1).params, { threadId: s.sessionId, items: injected(UNDO_A) });
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['now the tests'], 'not left to ride in the message');
  assert.equal(fake.spawns.length, 1);
});

test('the thread took the note but the turn could not start: the thread has it, so it is not said twice', async () => {
  const { s, fake, w } = make();
  s.send('hello'); await idle(w);
  fake.errors['turn/start'] = { message: 'no', once: true };
  s.note({ kind: 'undo', files: [A] });
  s.send('now the tests'); await idle(w, w.mark());
  assert.ok(w.find((e) => e.kind === 'error' && e.code === 'send-failed'));
  s.send('again'); await idle(w, w.mark());
  assert.equal(sent(fake, 'thread/inject_items').length, 1);
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['again']);
});

test('riding in a message that could not be sent, the note waits for the next one', async () => {
  const { s, fake, w } = make();
  refuse(fake);
  s.send('hello'); await idle(w);
  fake.errors['turn/start'] = { message: 'no', once: true };
  s.note({ kind: 'undo', files: [A] });
  s.send('now the tests'); await idle(w, w.mark());
  assert.ok(w.find((e) => e.kind === 'error' && e.code === 'send-failed'));
  assert.equal(s.notes.size, 1);
  s.send('again'); await idle(w, w.mark());
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), [block(UNDO_A), 'again']);
  s.send('and on'); await idle(w, w.mark());
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['and on']);
});

// ---- an edited message ----

test('edit: the replies that go changed a file, so the new message says it is still on disk, by name', async () => {
  const { s, fake, w } = make();
  await turn(s, fake, w, 'one');
  const b = await turn(s, fake, w, 'change a.ts', [[A], [B, 'declined']]);
  const mark = w.mark();
  const r = await s.edit({ messageId: b.id, text: 'change it another way' });
  assert.deepEqual([r.ok, r.first], [true, false]);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', mark)));
  const wire = fake.received.map((m) => m.method).filter((m) => ['thread/revert', 'thread/inject_items', 'turn/start'].includes(m));
  assert.deepEqual(wire.slice(-3), ['thread/revert', 'thread/inject_items', 'turn/start']);
  assert.deepEqual(sent(fake, 'thread/inject_items').map((m) => m.params.items), [injected(KEPT_A)], 'the change Codex was refused is not one of them');
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['change it another way']);
  s.send('next'); await idle(w, w.mark());
  assert.equal(sent(fake, 'thread/inject_items').length, 1);
});

test('edit of an older message: every turn that goes counts', async () => {
  const { s, fake, w } = make();
  await turn(s, fake, w, 'zero');
  const a = await turn(s, fake, w, 'change a.ts', [[A]]);
  await turn(s, fake, w, 'and b.ts', [[B], [A]]);
  const mark = w.mark();
  assert.equal((await s.edit({ messageId: a.id, text: 'do neither' })).ok, true);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', mark)));
  assert.deepEqual(sent(fake, 'thread/inject_items').map((m) => m.params.items), [injected(KEPT_A.replace('src/a.ts', 'src/a.ts and src/b.ts'))]);
  assert.equal(s.work.size, 2, 'the turns that went are forgotten; the kept one and the new one are not');
});

test('edit: the replies that go changed no file, so there is nothing to tell', async () => {
  const { s, fake, w } = make();
  await turn(s, fake, w, 'one', [[A]]);
  const b = await turn(s, fake, w, 'two', [[B, 'declined']]);
  const mark = w.mark();
  assert.equal((await s.edit({ messageId: b.id, text: 'two, reworded' })).ok, true);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', mark)));
  assert.equal(sent(fake, 'thread/inject_items').length, 0);
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['two, reworded']);
});

test('edit of a turn from before this run: nobody saw what it changed, so the note names no file', async () => {
  const savedTurn = (n) => ({ id: `t${n}`, startedAt: 100 + n, completedAt: 101 + n, status: 'completed', items: [{ type: 'userMessage', id: `u${n}`, clientId: null, content: [{ type: 'text', text: `q${n}` }] }, { type: 'agentMessage', id: `a${n}`, text: `r${n}`, phase: 'final_answer' }] });
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT] });
  fake.turnsOf[CHAT] = [1, 2].map(savedTurn);
  assert.equal((await s.edit({ messageId: 'u2', text: 'q2, reworded' })).ok, true);
  await idle(w);
  assert.deepEqual(sent(fake, 'thread/inject_items').map((m) => m.params), [{ threadId: CHAT, items: injected(KEPT) }]);
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[0]), ['q2, reworded']);
});

test('edit of the first message: nothing is left to remember the replies by, so nothing is told', async () => {
  const { s, fake, w } = make();
  const a = await turn(s, fake, w, 'change a.ts', [[A]]);
  s.note({ kind: 'text', text: 'The user did something in the old conversation.' });
  const mark = w.mark();
  const r = await s.edit({ messageId: a.id, text: 'change nothing' });
  assert.deepEqual([r.ok, r.first], [true, true]);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', mark)));
  assert.equal(sent(fake, 'thread/inject_items').length, 0);
  assert.equal(s.notes.size, 0, 'and what was waiting went with the old conversation');
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['change nothing']);
});

test('a note told with a message that is then edited away is told again with the message that replaces it', async () => {
  const { s, fake, w } = make();
  await turn(s, fake, w, 'one');
  s.note({ kind: 'undo', files: [A] });
  const b = await turn(s, fake, w, 'two');
  assert.equal(sent(fake, 'thread/inject_items').length, 1);
  const mark = w.mark();
  assert.equal((await s.edit({ messageId: b.id, text: 'two, reworded' })).ok, true);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', mark)));
  assert.deepEqual(sent(fake, 'thread/inject_items').map((m) => m.params.items), [injected(UNDO_A), injected(UNDO_A)]);
});

test('a cut Codex refuses changes nothing, and tells nothing', async () => {
  const { s, fake, w } = make({}, { errors: { 'thread/revert': { message: 'the rollout is locked' } } });
  await turn(s, fake, w, 'one');
  const b = await turn(s, fake, w, 'change a.ts', [[A]]);
  const r = await s.edit({ messageId: b.id, text: 'again' });
  assert.deepEqual([r.ok, r.code], [false, 'edit-failed']);
  assert.equal(s.notes.size, 0);
  s.send('next'); await idle(w, w.mark());
  assert.equal(sent(fake, 'thread/inject_items').length, 0);
});

// ---- what the user sees ----

test('the user bubble never shows the note: live, from the live chat\'s history, and from the saved one, both ways of delivery', async () => {
  for (const refused of [false, true]) {
    const { s, fake, w } = make();
    if (refused) refuse(fake);
    s.note({ kind: 'undo', files: [A] });
    s.send('carry on with the callers');
    await idle(w);
    await sleep(10);
    const how = refused ? 'refused' : 'accepted';
    assert.ok(!w.events.some((e) => JSON.stringify(e).includes('canopy_note')), `no live event holds the block (${how})`);
    assert.ok(!JSON.stringify(s.snapshot()).includes('canopy_note'), `nor does what a reloaded window is given (${how})`);
    const h = await s.history();
    assert.equal(h.ok, true);
    assert.deepEqual(h.events.filter((e) => e.kind === 'user-text').map((e) => e.text), ['carry on with the callers']);
    // What a reopened chat is rebuilt from.
    const saved = adaptHistory(fake.turnsOf[s.sessionId], { threadId: s.sessionId });
    assert.deepEqual(saved.filter((e) => e.kind === 'user-text').map((e) => e.text), ['carry on with the callers'], how);
    assert.ok(!saved.some((e) => JSON.stringify(e).includes('canopy_note')));
  }
});

test('a saved message that is only the note and an image is a bubble of the image; words that mention the tag are the user\'s', () => {
  const saved = (content) => adaptHistory([{ id: 't1', status: 'completed', items: [{ type: 'userMessage', id: 'u1', content }], itemsView: 'full', startedAt: 1794801559 }], { threadId: 'x' });
  const note = { type: 'text', text: block(UNDO_A), text_elements: [] };
  assert.deepEqual(saved([note, { type: 'image', url: 'data:image/png;base64,AAAA' }]).filter((e) => e.kind === 'user-text').map((e) => [e.text, e.images]), [['[image]', 1]]);
  assert.deepEqual(saved([note]).filter((e) => e.kind === 'user-text'), []);
  assert.deepEqual(saved([{ type: 'text', text: 'what is <canopy_note> for?', text_elements: [] }]).filter((e) => e.kind === 'user-text').map((e) => e.text), ['what is <canopy_note> for?']);
});

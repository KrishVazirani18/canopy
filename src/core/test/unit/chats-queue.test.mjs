// ChatHost's message queue: typed while a chat works, sent one at a time when ITS turn ends, whichever chat is on screen.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { ChatHost } from '../../../chats.mjs';

class Stub extends EventEmitter {
  constructor(opts) { super(); this.cwd = opts.cwd; this.sessionId = null; this.busy = false; this.closed = false; this.pending = new Map(); this.lifecycle = 'ready'; this.sentTo = []; }
  reportedBusy() { return this.busy; }
  send(text, images) { this.sentTo.push({ text, images }); this.busy = true; return { ok: true }; }
  finish() { this.busy = false; this.emit('event', { kind: 'busy', busy: false }); }
  async dispose() {}
  close() { this.closed = true; }
}
async function host() {
  mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], sessions = [];
  const h = new ChatHost({ create: (o) => { const s = new Stub(o); sessions.push(s); return s; }, send: (c, p) => sent.push([c, p]), maxIdle: 8 });
  const a = await h.open('/p/a', null); // on screen
  const b = await h.open('/p/b', null); // now a is in the background
  const events = (sid) => sent.filter(([c, p]) => c === 'session:event' && p.kind === 'queue' && p.sid === sid).map(([, p]) => p);
  return { h, a, b, sA: sessions[0], sB: sessions[1], events };
}
const tick = () => mock.timers.tick(120);

test('a message queued in a chat goes out when that chat finishes, even though another chat is on screen', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, a, sA, events } = await host();
  sA.busy = true;
  const r = h.queueAdd(a.sid, 'then do this', []);
  assert.equal(r.queue.length, 1);
  tick();
  assert.equal(sA.sentTo.length, 0, 'still working: nothing goes out');
  sA.finish(); tick();
  assert.deepEqual(sA.sentTo.map((m) => m.text), ['then do this']);
  assert.deepEqual(h.queueOf(a.sid).queue, []);
  assert.equal(events(a.sid).length, 0, 'a chat off screen is not narrated to the window: it reads its transcript when you return');
});

test('one at a time: the next waits for the next turn to end', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB, events } = await host();
  sB.busy = true;
  h.queueAdd(b.sid, 'one', []); h.queueAdd(b.sid, 'two', []);
  sB.finish(); tick();
  assert.deepEqual(sB.sentTo.map((m) => m.text), ['one']);
  assert.deepEqual(h.queueOf(b.sid).queue.map((q) => q.text), ['two']);
  const ev = events(b.sid).at(-1); // on screen: the window is told what went out and what is left
  assert.equal(ev.sent.text, 'one');
  assert.deepEqual(ev.queue.map((q) => q.text), ['two']);
  assert.equal(ev.v, h.queueOf(b.sid).v);
  sB.finish(); tick();
  assert.deepEqual(sB.sentTo.map((m) => m.text), ['one', 'two']);
});

test('a message queued just as the chat went idle still goes out', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB } = await host();
  h.queueAdd(b.sid, 'late', []); // the window thought it was busy; it is not
  tick();
  assert.deepEqual(sB.sentTo.map((m) => m.text), ['late']);
});

test('taking a message back: removed while waiting, not once it went out; versions only move forward', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, a, sA } = await host();
  sA.busy = true;
  const { queue, v } = h.queueAdd(a.sid, 'x', []);
  const gone = h.queueRemove(a.sid, queue[0].id);
  assert.equal(gone.removed, true);
  assert.ok(gone.v > v);
  h.queueAdd(a.sid, 'y', []);
  const id = h.queueOf(a.sid).queue[0].id;
  sA.finish(); tick();
  assert.deepEqual(sA.sentTo.map((m) => m.text), ['y']);
  assert.equal(h.queueRemove(a.sid, id).removed, false);
});

test('a chat that is closed or unknown takes nothing, and a closed chat drops its queue', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, a, sA } = await host();
  assert.ok(h.queueAdd('nope', 'x', []).error);
  sA.busy = true;
  h.queueAdd(a.sid, 'x', []);
  await h.manager.close(a.sid);
  assert.deepEqual(h.queueOf(a.sid), { queue: [], v: 0 });
});

// ---- edit and resend ----

test('a queued message that goes out tells the window its id in the conversation', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB, events } = await host();
  sB.send = (text, images) => { sB.sentTo.push({ text, images }); sB.busy = true; return { ok: true, id: 'the-uuid' }; };
  h.queueAdd(b.sid, 'one', []);
  tick();
  assert.equal(events(b.sid).at(-1).sent.uuid, 'the-uuid');
});

test('an edit holds the queue: the stop in its middle sends nothing, and the queue goes out after the edited reply', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB } = await host();
  sB.emit('event', { kind: 'init', sessionId: 'S' });
  sB.busy = true; sB.emit('event', { kind: 'busy', busy: true });
  h.queueAdd(b.sid, 'after that', []);
  let answer;
  sB.edit = (opts) => { sB.edited = opts; return new Promise((r) => { answer = r; }); };
  const done = h.edit(b.sid, { messageId: 'm', text: 'new words' });
  // The engine stops the old reply on its way to the cut.
  sB.busy = false;
  sB.emit('event', { kind: 'turn-end', interrupted: true });
  sB.emit('event', { kind: 'busy', busy: false });
  tick();
  assert.equal(sB.sentTo.length, 0, 'the queued message must not slip in ahead of the edited one');
  assert.equal(h.statusList().find((s) => s.sid === b.sid).state, 'working', 'to the sidebar the chat never stopped');
  // The edited message's reply starts, the edit is answered, and only when that reply ends does the queue move.
  sB.busy = true; sB.emit('event', { kind: 'busy', busy: true });
  answer({ ok: true, id: 'n', fresh: false });
  assert.deepEqual(await done, { ok: true, id: 'n', fresh: false });
  tick();
  assert.equal(sB.sentTo.length, 0, 'the edited reply is still running');
  sB.finish(); tick();
  assert.deepEqual(sB.sentTo.map((m) => m.text), ['after that']);
  assert.deepEqual(sB.edited, { messageId: 'm', text: 'new words' });
});

test('an edit that fails leaves the chat idle, so the queue is woken', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB } = await host();
  sB.edit = async () => { h.queueAdd(b.sid, 'next', []); tick(); return { ok: false, code: 'not-found', message: 'That message is not in the saved conversation.' }; };
  const r = await h.edit(b.sid, { messageId: 'm', text: 'x' });
  assert.equal(r.code, 'not-found');
  assert.equal(sB.sentTo.length, 0, 'held while the edit was being tried');
  tick();
  assert.deepEqual(sB.sentTo.map((m) => m.text), ['next']);
  assert.equal((await h.edit('nope', {})).code, 'gone');
  // A chat whose engine has no way to cut a conversation back says so, and nothing is held for it. (Both of today's
  // engines have one: a Claude chat's Session.edit and an OpenAI chat's CodexSession.edit.)
  delete sB.edit;
  assert.equal((await h.edit(b.sid, { messageId: 'm', text: 'x' })).code, 'unsupported');
  sB.finish(); tick();
  h.queueAdd(b.sid, 'still goes', []); tick();
  assert.deepEqual(sB.sentTo.map((m) => m.text), ['next', 'still goes']);
});

test('an OpenAI chat keeps its conversation when its first message is edited: it is renamed only while it still goes by that message', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB } = await host();
  sB.engine = 'codex';
  sB.emit('event', { kind: 'init', sessionId: 'T' });
  h.noteSent('the old first message');
  // CodexSession.edit answers `first` (nothing is left before the new message) and `replaced` (the old words).
  sB.edit = async () => ({ ok: true, id: 'n', fresh: false, first: true, replaced: 'the old first message' });
  await h.edit(b.sid, { messageId: 'm', text: 'the new first message' });
  assert.equal(h.status.get(b.sid).title, 'the new first message');
  // A name it was given since is not its first message: it stays.
  h.setTitle('T', 'Header work');
  sB.edit = async () => ({ ok: true, id: 'n2', fresh: false, first: true, replaced: 'the new first message' });
  await h.edit(b.sid, { messageId: 'n', text: 'something else entirely' });
  assert.equal(h.status.get(b.sid).title, 'Header Work', 'a name is kept, in Title Case');
  // Not the first message, the old words unknown, or the edit refused: the name stays.
  h.setTitle('T', 'the first words');
  for (const answer of [{ ok: true, fresh: false, first: false, replaced: 'the first words' }, { ok: true, fresh: false, first: true }, { ok: false, code: 'steered', first: true, replaced: 'the first words' }]) {
    sB.edit = async () => answer;
    await h.edit(b.sid, { messageId: 'x', text: 'other words' });
    assert.equal(h.status.get(b.sid).title, 'The First Words', JSON.stringify(answer));
  }
});

test('an edit takes the reply the sidebar quotes with it: the line is empty until the edited message is answered', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB } = await host();
  sB.emit('event', { kind: 'init', sessionId: 'S' });
  sB.emit('event', { kind: 'turn-end', text: 'The old answer.' });
  const line = () => h.statusList().find((s) => s.sid === b.sid).line;
  assert.equal(line(), 'The old answer.');
  sB.emit('event', { kind: 'edit', id: 'n', messageId: 'm', fresh: false, text: 'asked differently' });
  assert.equal(line(), null, 'that reply is no longer in the conversation');
  sB.emit('event', { kind: 'turn-end', text: 'The new answer.' });
  assert.equal(line(), 'The new answer.');
});

test('editing the first message renames the chat after the new one; the files an edit could undo come back as a list', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB } = await host();
  sB.emit('event', { kind: 'init', sessionId: 'S' });
  h.noteSent('the old first message');
  sB.edit = async () => ({ ok: true, id: 'n', fresh: true });
  await h.edit(b.sid, { messageId: 'm', text: 'the new first message' });
  assert.equal(h.status.get(b.sid).title, 'the new first message');
  // A chat that carries on (its first message was not the one edited) keeps its name.
  sB.edit = async () => ({ ok: true, id: 'n2', fresh: false });
  await h.edit(b.sid, { messageId: 'm2', text: 'something later' });
  assert.equal(h.status.get(b.sid).title, 'the new first message');

  sB.rewindFiles = async (id, opts) => { sB.previewed = [id, opts]; return { canRewind: true, filesChanged: ['/p/b/x.ts', '/p/b/y.ts'], insertions: 4, deletions: 1 }; };
  assert.deepEqual(await h.editPreview(b.sid, 'm'), { files: ['/p/b/x.ts', '/p/b/y.ts'], insertions: 4, deletions: 1 });
  assert.deepEqual(sB.previewed, ['m', { dryRun: true }], 'a preview never touches a file');
  sB.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
  assert.equal(await h.editPreview(b.sid, 'm'), null, 'nothing changed: nothing to offer');
  sB.rewindFiles = async () => ({ canRewind: false, error: 'File checkpoints are turned off for this chat.' });
  assert.equal(await h.editPreview(b.sid, 'm'), null);
  assert.equal(await h.editPreview('nope', 'm'), null);
});

// ---- a chat whose process is up, to ask something of ----

test('liveOn: a running chat of that engine, the one on screen first, and none when there is no process to ask', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, sA, sB } = await host(); // b is on screen, a is behind it
  assert.equal(h.liveOn('claude'), null, 'neither has started a process: nothing is started to find out');
  sA.q = {}; sA.accountId = 'key-1';
  assert.equal(h.liveOn('claude'), sA);
  sB.q = {}; sB.accountId = null;
  assert.equal(h.liveOn('claude'), sB, 'both are up: the one on screen');
  assert.equal(h.liveOn('claude', (s) => s.accountId === 'key-1'), sA, 'only a chat on the account being asked about');
  assert.equal(h.liveOn('claude', (s) => s.accountId === 'plan-2'), null);
  assert.equal(h.liveOn('codex'), null, 'a Claude chat is never asked about an OpenAI account');
  sA.engine = 'codex';
  assert.equal(h.liveOn('codex'), sA);
  assert.equal(h.liveOn('claude', (s) => s.accountId === 'key-1'), null);
  sB.closed = true;
  assert.equal(h.liveOn('claude'), null, 'a closed chat has nothing to ask');
  assert.equal(h.liveOn('codex', () => { throw new Error('bad test'); }), null);
});

test('a note for a chat goes to that chat\'s own session, whichever maker runs it; a chat that is not open has nothing to tell', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, a, b, sA, sB } = await host();
  sA.note = (n) => { (sA.noted ??= []).push(n); return { ok: true }; };
  assert.deepEqual(h.note(a.sid, { kind: 'undo', files: ['/p/a/x.ts'] }), { ok: true }, 'a chat in the background is told too');
  assert.deepEqual(sA.noted, [{ kind: 'undo', files: ['/p/a/x.ts'] }]);
  assert.equal(sB.noted, undefined, 'and no other chat');
  // A session with no note() (an engine that cannot be told) and a chat that is gone both answer, and never throw.
  assert.equal(h.note(b.sid, { kind: 'undo' }).ok, false);
  assert.deepEqual(h.note('nope', { kind: 'undo' }), { ok: false, code: 'gone', message: 'This chat isn’t open anymore.' });
});

test('a waiting message can be moved: the queue goes out in the new order', async (t) => {
  t.after(() => mock.timers.reset());
  const { h, b, sB } = await host();
  sB.busy = true;
  h.queueAdd(b.sid, 'one', []); h.queueAdd(b.sid, 'two', []); h.queueAdd(b.sid, 'three', []);
  const ids = h.queueOf(b.sid).queue.map((q) => q.id);
  const v = h.queueOf(b.sid).v;
  const r = h.queueMove(b.sid, ids[2], 0);
  assert.equal(r.moved, true);
  assert.deepEqual(r.queue.map((q) => q.text), ['three', 'one', 'two']);
  assert.ok(r.v > v, 'a move is a new state: the window drops older ones');
  assert.deepEqual(h.queueMove(b.sid, ids[0], 99).queue.map((q) => q.text), ['three', 'two', 'one'], 'past the end is last');
  assert.equal(h.queueMove(b.sid, 12345, 0).moved, false, 'one that already went out is not moved');
  sB.finish(); tick();
  assert.deepEqual(sB.sentTo.map((m) => m.text), ['three']);
});

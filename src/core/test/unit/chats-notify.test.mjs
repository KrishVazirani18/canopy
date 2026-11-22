// ChatHost notifications and the completion-sound signal: a chat that needs you notifies whenever Canopy isn't the app
// in front; a chat that is done only while Canopy is hidden or minimized. The sound plays for normal finishes only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ChatHost } from '../../../chats.mjs';

class Stub extends EventEmitter {
  constructor(opts) { super(); this.cwd = opts.cwd; this.sessionId = opts.resume ?? null; this.busy = false; this.pending = new Map(); this.lifecycle = 'ready'; }
  async dispose() {}
  close() {}
}
async function host(focused, onScreen = focused) {
  const sent = [], notes = [], sessions = [];
  const state = { focused, onScreen };
  const h = new ChatHost({
    create: (o) => { const s = new Stub(o); sessions.push(s); return s; },
    send: (channel, payload) => sent.push([channel, payload]), notify: (n) => notes.push(n), isFocused: () => state.focused, isOnScreen: () => state.onScreen, maxIdle: 8,
  });
  await h.open('/p/a', null); // active chat
  await h.open('/p/b', null); // the first one is now in the background
  sessions.forEach((s, i) => s.emit('event', { kind: 'init', sessionId: `S${i}` }));
  return { h, sessions, sent, notes, state, done: () => sent.filter(([c]) => c === 'chats:done') };
}

test('focused window: no notifications for any chat, turn-end or needs-you', async () => {
  const { sessions, notes } = await host(true);
  sessions[0].emit('event', { kind: 'permission', title: 'Run ls' }); // a chat in the background
  sessions[0].emit('event', { kind: 'turn-end', text: 'done' });
  sessions[1].emit('event', { kind: 'turn-end', text: 'done' }); // the one on screen
  assert.equal(notes.length, 0);
});

test('window open behind another app: a chat that needs you notifies, a finished one does not', async () => {
  const { sessions, notes } = await host(false, true);
  sessions[0].emit('event', { kind: 'permission', title: 'Run ls' });
  sessions[0].emit('event', { kind: 'permission-resolved', id: undefined });
  sessions[0].emit('event', { kind: 'turn-end', text: 'done' });
  sessions[1].emit('event', { kind: 'turn-end', text: 'done' });
  assert.deepEqual(notes.map((n) => n.title.replace(/^.*? (is done|needs you)$/, '$1')), ['needs you']);
  assert.match(notes[0].body, /Run ls/);
});

test('window hidden or minimized: notifications (turn-end and needs-you)', async () => {
  const { sessions, notes } = await host(false);
  sessions[1].emit('event', { kind: 'permission', title: 'Run ls' });
  sessions[1].emit('event', { kind: 'permission-resolved', id: undefined });
  sessions[0].emit('event', { kind: 'turn-end', text: 'all set' });
  assert.deepEqual(notes.map((n) => n.title.replace(/^.*? (is done|needs you)$/, '$1')), ['needs you', 'is done']);
});

test('clicking a notification opens its chat and is counted as a use, by name only; a counter that fails changes nothing', async () => {
  const used = [];
  const sent = [], notes = [], sessions = [];
  const make = (onUsed) => new ChatHost({
    create: (o) => { const s = new Stub(o); sessions.push(s); return s; },
    send: (channel, payload) => sent.push([channel, payload]), notify: (n) => notes.push(n), isFocused: () => false, isOnScreen: () => false, onUsed, maxIdle: 8,
  });
  const h = make((name, ...more) => used.push([name, ...more]));
  await h.open('/p/a', null);
  sessions[0].emit('event', { kind: 'init', sessionId: 'S0' });
  sessions[0].emit('event', { kind: 'turn-end', text: 'all set' });
  sessions[0].emit('event', { kind: 'permission', title: 'Run ls' });
  assert.equal(notes.length, 2);
  assert.deepEqual(used, [], 'showing one is not a click');
  notes[0].onClick();
  notes[1].onClick();
  assert.deepEqual(used, [['notification_clicked'], ['notification_clicked']], 'the name and nothing about the chat');
  assert.deepEqual(sent.filter(([c]) => c === 'chats:focus'), [['chats:focus', { sessionId: 'S0', cwd: '/p/a' }], ['chats:focus', { sessionId: 'S0', cwd: '/p/a' }]]);

  // No counter, or one that throws: the click still opens the chat.
  for (const onUsed of [undefined, () => { throw new Error('counting failed'); }]) {
    sent.length = 0; notes.length = 0; sessions.length = 0;
    const plain = make(onUsed);
    await plain.open('/p/b', null);
    sessions[0].emit('event', { kind: 'init', sessionId: 'S1' });
    sessions[0].emit('event', { kind: 'turn-end', text: 'done' });
    notes[0].onClick();
    assert.deepEqual(sent.filter(([c]) => c === 'chats:focus'), [['chats:focus', { sessionId: 'S1', cwd: '/p/b' }]]);
  }
});

test('completion sound: a chat you are not looking at, or any chat while Canopy is not in front; never interrupted, errored or synthetic', async () => {
  // Window in the background: every normal finish plays.
  const away = await host(false);
  away.sessions[0].emit('event', { kind: 'turn-end', text: 'ok', sid: 'a' });
  away.sessions[1].emit('event', { kind: 'turn-end', text: 'ok', sid: 'b' });
  assert.equal(away.done().length, 2);
  away.sessions[0].emit('event', { kind: 'turn-end', interrupted: true });
  away.sessions[0].emit('event', { kind: 'turn-end', isError: true });
  away.sessions[0].emit('event', { kind: 'turn-end', synthetic: true });
  assert.equal(away.done().length, 2);

  // Window in front: only the chat that is off screen plays; the one on screen (sessions[1]) does not.
  const front = await host(true);
  front.sessions[1].emit('event', { kind: 'turn-end', text: 'ok', sid: 'b' });
  assert.equal(front.done().length, 0);
  front.sessions[0].emit('event', { kind: 'turn-end', text: 'ok', sid: 'a' });
  assert.equal(front.done().length, 1);
  front.sessions[0].emit('event', { kind: 'turn-end', interrupted: true });
  assert.equal(front.done().length, 1);
});

test('completion sound: a chat shown in a pane counts as on screen while Canopy is in front', async () => {
  const { h, sessions, state, done } = await host(true);
  const sid = h.manager.list().find((e) => e.cwd === '/p/a').sid;
  h.shown.add(sid);
  sessions[0].emit('event', { kind: 'turn-end', text: 'ok' });
  assert.equal(done().length, 0);
  state.focused = false; // you switched away: now it plays
  sessions[0].emit('event', { kind: 'turn-end', text: 'ok' });
  assert.equal(done().length, 1);
});

test('a waiting approval says what it is about: one file by its name, a change to several files by their number', async () => {
  const { h, sessions } = await host(true);
  const line = (i) => h.statusList().find((s) => s.sessionId === `S${i}`).line;
  sessions[0].emit('event', { kind: 'permission', id: 1, toolName: 'Edit', input: { file_path: '/p/a/one.ts' } });
  assert.equal(line(0), 'Wants your OK: /p/a/one.ts');
  // An OpenAI change to several files is one approval for all of them.
  sessions[1].emit('event', {
    kind: 'permission', id: 2, toolName: 'Edit', title: 'Change 3 files?', input: { file_path: '/p/b/a.ts', files: ['/p/b/a.ts', '/p/b/b.ts', '/p/b/.env'] },
    changes: [{ id: 'fc', name: 'Edit', input: {} }, { id: 'fc#1', name: 'Write', input: {} }, { id: 'fc#2', name: 'Edit', input: { deleted: true } }], changeCount: 3,
  });
  assert.equal(line(1), 'Wants your OK: changes to 3 files');
  assert.equal(h.home().find((s) => s.sessionId === 'S1').ask.title, 'Change 3 files?');
});

test('a chat waiting on an answer to its question says so, so the sidebar marks it with a "?"; an OK it waits on does not', async () => {
  const { h, sessions } = await host(true);
  const row = (i) => h.statusList().find((s) => s.sessionId === `S${i}`);
  sessions[0].emit('event', { kind: 'permission', id: 1, toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which picture?', options: [] }] } });
  assert.equal(row(0).line, 'Asked you: Which picture?');
  assert.equal(row(0).asking, true);
  sessions[1].emit('event', { kind: 'permission', id: 2, toolName: 'Bash', input: { command: 'npm install' } });
  assert.equal(row(1).asking, false);
});

test('liveCounts (telemetry\'s live heartbeat): chats open, working, waiting, and what runs in the background by kind', async () => {
  const { h, sessions } = await host(true);
  assert.deepEqual(h.liveCounts(), { chats_open: 2, chats_working: 0, chats_waiting: 0, agents: 0, workflows: 0, commands: 0 });
  sessions[0].emit('event', { kind: 'permission', title: 'Run ls' }); // waits on you
  sessions[1].emit('event', { kind: 'tasks', tasks: [
    { taskId: 'a', status: 'running', taskType: 'local_agent', description: 'x' },
    { taskId: 'b', status: 'pending', taskType: 'local_workflow', workflow: 'w' },
    { taskId: 'c', status: 'running', taskType: 'local_bash', description: 'y' },
    { taskId: 'd', status: 'completed', taskType: 'local_agent', description: 'z' },
  ] });
  const c = h.liveCounts();
  assert.equal(c.chats_waiting, 1);
  assert.deepEqual([c.agents, c.workflows, c.commands], [1, 1, 1]);
});

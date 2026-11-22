// Edit and resend in the window: which of your messages can be edited (renderer/src/lib/edit.ts), and what the
// transcript's store does when one is (renderer/src/lib/store.ts): the cut, what it clears, what it ignores while the
// engine closes the old reply, and how it puts the chat back when the engine says no.
//
// The store is the real one. Node reads its TypeScript as it is; the few things it expects from a window (the bridge
// to main, animation frames, storage) are stood in for here.
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

// The bridge to main, as a stand-in: every call is recorded, and `edit` answers when the test says.
const bridge = { calls: [], editReply: null, preview: null };
const canopy = {
  send: (text, images, id) => { bridge.calls.push(['send', text, images, id]); return Promise.resolve(bridge.sendReply ?? { ok: true }); },
  edit: (opts) => { bridge.calls.push(['edit', opts]); return new Promise((resolve) => { bridge.editReply = resolve; }); },
  editPreview: (id) => { bridge.calls.push(['editPreview', id]); return Promise.resolve(bridge.preview); },
  interrupt: () => Promise.resolve(), set: () => Promise.resolve(), respond: () => Promise.resolve(), context: () => Promise.resolve(null),
  queue: () => Promise.resolve({ ok: true, queue: [], v: 1 }), unqueue: () => Promise.resolve({ ok: true, removed: true, queue: [], v: 2 }),
};
globalThis.window = { canopy, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);

const lib = (file) => import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/lib', file)).href);
const [E, S] = await Promise.all([lib('edit.ts'), lib('store.ts')]);

beforeEach(() => { bridge.calls.length = 0; bridge.editReply = null; bridge.preview = null; bridge.sendReply = null; });

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tick = () => new Promise((r) => setTimeout(r, 0));

// A chat with two finished turns and a third that is still running: a step waiting on a permission, a reply being
// written, a background task's line.
function chat() {
  const s = new S.Store();
  s.loadHistory([
    { kind: 'user-text', text: 'first', uuid: U1, images: 0 },
    { kind: 'tool-start', id: 'tool-old', name: 'Read', input: { file_path: '/a' } },
    { kind: 'tool-result', id: 'tool-old', content: 'ok', isError: false },
    { kind: 'assistant-text', text: 'ONE' },
    { kind: 'user-text', text: 'second', uuid: U2, images: 0 },
    { kind: 'assistant-text', text: 'TWO' },
  ]);
  s.handle({ kind: 'turn-end', durationMs: 4000, turnCost: 0.25, cost: 0.25 });
  s.handle({ kind: 'turn-end', durationMs: 6000, turnCost: 0.5, cost: 0.75 });
  s.handle({ kind: 'queue', sent: { id: 1, text: 'third', images: [], uuid: U3 }, queue: [], v: 1 });
  s.handle({ kind: 'busy', busy: true, state: 'running' });
  s.handle({ kind: 'tool-start', id: 'tool-new', name: 'Bash', input: { command: 'make' } });
  s.handle({ kind: 'permission', id: 7, type: 'tool', toolName: 'Bash', toolUseId: 'tool-new', input: { command: 'make' } });
  s.handle({ kind: 'task', subtype: 'task_started', taskId: 'bg1', description: 'Watching the build', status: 'running' });
  s.handle({ kind: 'tasks', tasks: [{ taskId: 'bg1', status: 'running', backgrounded: true }] });
  s.handle({ kind: 'text-delta', text: 'Working on it' });
  return s;
}
const texts = (s) => s.items.map((it) => (it.t === 'user' ? `you:${it.text}` : it.t === 'assistant' ? `claude:${it.text}` : it.t)).join(' | ');

// ---- which messages can be edited ----

test('messages carry their saved id: from history, from a send, and from a queued message that went out', async () => {
  const s = chat();
  assert.deepEqual(s.items.filter((it) => it.t === 'user').map((it) => it.uuid), [U1, U2, U3]);
  s.dispatch('fourth', []);
  const sent = s.items.at(-1);
  assert.match(sent.uuid, UUID);
  assert.deepEqual(bridge.calls.at(-1), ['send', 'fourth', [], sent.uuid], 'the same id goes to the engine with the message');
  assert.equal(E.editBlocked(sent), null);
  // A send that never reached Claude Code leaves a bubble that can't be edited.
  bridge.sendReply = { error: 'No session open.' };
  s.dispatch('fifth', []);
  const lost = s.items.at(-1);
  await tick();
  assert.equal(lost.unsent, true);
  assert.equal(E.editBlocked(lost), 'unsent');
});

test('Edit is offered only where it can work', () => {
  const item = (extra) => ({ t: 'user', key: 'i5', rev: 0, at: 0, text: 'fix the header', images: 0, uuid: U1, ...extra });
  assert.equal(E.editBlocked(item()), null);
  assert.equal(E.editBlocked(item({ images: 2, text: '' })), null, 'a message with images can be edited: they are sent again as they were');
  assert.equal(E.editBlocked(item({ steered: true })), null);
  assert.equal(E.editBlocked(item({ uuid: undefined })), 'no-id');
  assert.equal(E.editBlocked(item({ unsent: true })), 'unsent');
  assert.equal(E.editBlocked(item({ parent: { t: 'tool' } })), 'nested');
  assert.equal(E.editBlocked(item({ fixed: true })), 'command');
  for (const text of ['/compact', '/model opus', '  /clear', '/my-plugin:review src', '! ls -la', '!git status']) assert.equal(E.editBlocked(item({ text })), 'command', text);
  for (const text of ['/Users/me/app/main.ts is broken', '/tmp/x.log has the error', 'use /compact when it is long', '5 / 2 = ?', 'wow!']) assert.equal(E.editBlocked(item({ text })), null, text);
  assert.equal(E.editBlocked(item(), { terminal: true }), 'terminal');
  assert.equal(E.editBlocked(item(), { engine: 'claude' }), null);
  assert.equal(E.editBlocked(item(), { engine: 'something-new' }), 'engine', 'an engine this window does not know how to cut back');
  assert.equal(E.editBlocked(item(), { loading: true }), 'loading');
  // Above the place the conversation was summarized or cleared (item 9 here): no. Below it: yes.
  assert.equal(E.editBlocked(item(), { wall: 9 }), 'boundary');
  assert.equal(E.editBlocked(item({ key: 'i12' }), { wall: 9 }), null);
});

test('in an OpenAI (Codex) chat Edit is offered too, except on a message steered into a running reply', () => {
  const item = (extra) => ({ t: 'user', key: 'i5', rev: 0, at: 0, text: 'fix the header', images: 0, uuid: U1, ...extra });
  const codex = { engine: 'codex' };
  assert.equal(E.editBlocked(item(), codex), null);
  assert.equal(E.editBlocked(item({ images: 2, text: '' }), codex), null);
  // Codex cuts a whole turn at a time: a steered message is part of the turn it went into.
  assert.equal(E.editBlocked(item({ steered: true }), codex), 'steered');
  assert.equal(E.editBlocked(item({ steered: false }), codex), null);
  assert.equal(E.editBlocked(item({ steered: true }), { engine: 'claude' }), null, 'Claude Code cuts at any message');
  // A Codex id for a message read back from the saved chat is not a UUID Canopy made: any id will do.
  assert.equal(E.editBlocked(item({ uuid: '01a1f000-0000-7000-8000-000000000021' }), codex), null);
  // "/compact" and "! ls" run something only in Claude Code. In an OpenAI chat they are words like any others.
  for (const text of ['/compact', '/model opus', '! ls -la']) assert.equal(E.editBlocked(item({ text }), codex), null, text);
  assert.equal(E.editBlocked(item({ fixed: true }), codex), 'command', 'still not for something that spoke in your place');
  // Everything else holds as in a Claude chat.
  assert.equal(E.editBlocked(item({ uuid: undefined }), codex), 'no-id');
  assert.equal(E.editBlocked(item({ unsent: true }), codex), 'unsent');
  assert.equal(E.editBlocked(item({ parent: { t: 'tool' } }), codex), 'nested');
  assert.equal(E.editBlocked(item(), { ...codex, loading: true }), 'loading');
  assert.equal(E.editBlocked(item(), { ...codex, wall: 9 }), 'boundary', 'above where the conversation was summarized');
  assert.equal(E.editBlocked(item({ steered: true }), { ...codex, loading: true }), 'steered');
});

test('an OpenAI chat\'s history says which messages were steered in, and a steer you make is marked as you make it', () => {
  const s = new S.Store();
  s.setEngine('codex');
  s.loadHistory([
    { kind: 'user-text', text: 'count to 80', uuid: 'item-1', images: 0 },
    { kind: 'assistant-text', text: '1 2 3' },
    { kind: 'user-text', text: 'and say hello after', uuid: 'item-2', images: 0, steered: true },
    { kind: 'assistant-text', text: '80 HELLO' },
    { kind: 'turn-end', durationMs: 10 },
    { kind: 'user-text', text: 'thanks', uuid: 'item-3', images: 0 },
  ]);
  const ctx = { engine: s.meta.engine, wall: s.wall };
  const [first, steered, last] = s.items.filter((it) => it.t === 'user');
  assert.deepEqual([first.steered, steered.steered, last.steered], [undefined, true, undefined]);
  assert.deepEqual([E.editBlocked(first, ctx), E.editBlocked(steered, ctx), E.editBlocked(last, ctx)], [null, 'steered', null]);
  s.handle({ kind: 'busy', busy: true });
  s.dispatch('one more thing', [], true); // sent into the running reply
  assert.equal(E.editBlocked(s.items.at(-1), ctx), 'steered');
  s.dispatch('a new turn', [], false);
  assert.equal(E.editBlocked(s.items.at(-1), ctx), null);
});

test('history marks what was not typed as a message, and where the conversation was summarized or cleared', () => {
  const s = new S.Store();
  s.loadHistory([
    { kind: 'user-text', text: 'before', uuid: U1, images: 0 },
    { kind: 'notice', text: 'Conversation compacted', code: 'compacted' },
    { kind: 'context-note', text: 'This session is being continued from a previous conversation', compact: true },
    { kind: 'user-text', text: '/review src', uuid: U2, images: 0, command: true },
    { kind: 'user-text', text: '! ls', uuid: U3, images: 0, bash: true },
    { kind: 'user-text', text: 'from a channel', uuid: 'aaaaaaaa-1111-4111-8111-111111111111', images: 0, origin: 'channel' },
    { kind: 'user-text', text: 'after', uuid: 'bbbbbbbb-1111-4111-8111-111111111111', images: 0 },
  ]);
  const [before, command, shell, other, after] = s.items.filter((it) => it.t === 'user');
  const ctx = { wall: s.wall };
  assert.ok(s.wall > 0);
  assert.equal(E.editBlocked(before, ctx), 'boundary');
  assert.equal(E.editBlocked(command, ctx), 'command');
  assert.equal(E.editBlocked(shell, ctx), 'command');
  assert.equal(E.editBlocked(other, ctx), 'command');
  assert.equal(E.editBlocked(after, ctx), null);
  // /clear while the chat is open: what is above the line belongs to the conversation that was left.
  s.handle({ kind: 'notice', code: 'conversation-reset', reset: true, text: 'Conversation cleared' });
  assert.equal(E.editBlocked(after, { wall: s.wall }), 'boundary');
  s.reset();
  assert.equal(s.wall, 0);
});

test('background work an edit would stop: counted when it outlives the reply, not when it is the reply', () => {
  const tasks = [
    { taskId: 'a', status: 'running', backgrounded: true },
    { taskId: 'b', status: 'pending', workflow: 'release' },
    { taskId: 'c', status: 'running', taskType: 'local_workflow' },
    { taskId: 'd', status: 'running' },                       // an agent Claude is waiting on, mid-reply
    { taskId: 'e', status: 'completed', backgrounded: true },
  ];
  assert.equal(E.backgroundCount(tasks, true), 3);
  assert.equal(E.backgroundCount(tasks, false), 4, 'with no reply running, everything still going is in the background');
  assert.equal(E.backgroundCount([], true), 0);
  assert.equal(E.filesLabel(['/a/b/notes.txt']), 'notes.txt');
  assert.equal(E.filesLabel(['/a/x.ts', '/a/y.ts', '/z']), '3 files');
});

// ---- the cut ----

test('editing the message in flight: it and its reply go at once, and nothing they held is left behind', async () => {
  const s = chat();
  assert.equal(s.meta.stats.turns, 2);
  assert.ok(s.items.some((it) => it.t === 'permission' && !it.resolved), 'a question is open before the edit');
  const sends = s.meta.sends;
  const done = s.editFrom(U3, 'third, reworded');
  // Right away, before the engine has answered.
  assert.equal(texts(s), 'you:first | tool | claude:ONE | you:second | claude:TWO | turn | turn | you:third, reworded');
  const edited = s.items.at(-1);
  assert.match(edited.uuid, UUID);
  assert.notEqual(edited.uuid, U3);
  assert.equal(E.editBlocked(edited, { wall: s.wall }), null, 'the new message can be edited again');
  assert.equal(s.meta.busy, true);
  assert.equal(s.meta.sends, sends + 1, 'the view jumps to it, as for any message you send');
  assert.deepEqual(s.meta.tasks, [], 'background work stops with the restart');
  assert.deepEqual(s.meta.lastPrompt, { text: 'third, reworded', images: [] });
  assert.equal(s.items.some((it) => it.t === 'permission'), false, 'the open question went with its turn');
  assert.deepEqual(bridge.calls.at(-1), ['edit', { messageId: U3, text: 'third, reworded', id: edited.uuid, restoreFiles: false }]);

  // The engine closes the old reply: none of that lands under the edited message.
  for (const ev of [
    { kind: 'text-delta', text: ' and more of the old reply' },
    { kind: 'assistant-text', text: 'Working on it and more of the old reply' },
    { kind: 'permission-resolved', id: 7 },
    { kind: 'tool-result', id: 'tool-new', content: '', isError: true },
    { kind: 'notice', code: 'send-cancelled', text: 'Stopped. 1 queued message was not sent.' },
    { kind: 'turn-end', interrupted: true, durationMs: 9000, turnCost: 0.1 },
    { kind: 'busy', busy: false, state: 'idle' },
    { kind: 'stopped', reason: 'stop' },
    { kind: 'error', code: 'x', message: 'old' },
  ]) s.handle(ev);
  assert.equal(texts(s), 'you:first | tool | claude:ONE | you:second | claude:TWO | turn | turn | you:third, reworded');
  assert.equal(s.meta.busy, true);
  assert.equal(s.meta.stats.turns, 2);
  // What says nothing about a turn still gets through.
  s.handle({ kind: 'meta', commands: [{ name: 'clear' }] });
  s.handle({ kind: 'tasks', tasks: [] });
  assert.deepEqual(s.meta.commands, [{ name: 'clear' }]);

  // The engine's mark: from here on it is the new message's turn.
  s.handle({ kind: 'edit', id: edited.uuid, messageId: U3, fresh: false, text: 'third, reworded' });
  s.handle({ kind: 'busy', busy: true, state: 'starting' });
  s.handle({ kind: 'text-delta', text: 'New ' });
  s.handle({ kind: 'text-delta', text: 'reply' });
  s.handle({ kind: 'tool-start', id: 'tool-after', name: 'Read', input: {} });
  s.handle({ kind: 'tool-result', id: 'tool-new', content: 'late', isError: false }); // a step that no longer exists
  s.handle({ kind: 'tool-result', id: 'tool-after', content: 'ok', isError: false });
  s.handle({ kind: 'turn-end', durationMs: 1000, turnCost: 0.05, cost: 0.05 });
  bridge.editReply({ ok: true, id: edited.uuid, fresh: false });
  assert.deepEqual(await done, { ok: true, id: edited.uuid, fresh: false });
  assert.match(texts(s), /you:third, reworded \| claude:New reply \| tool \| raw \| turn$/, 'a result for a step that was cut finds no step');
  assert.equal(s.meta.stats.turns, 3);
  assert.equal(s.items.filter((it) => it.t === 'tool').at(-1).status, 'done');
});

test('editing an older message: every later turn goes, the turn count follows, cost and time stay', async () => {
  const s = chat();
  const before = { ...s.meta.stats };
  const done = s.editFrom(U2, 'second, reworded', { restoreFiles: true });
  assert.equal(texts(s), 'you:first | tool | claude:ONE | you:second, reworded');
  assert.equal(s.meta.stats.turns, 0, 'both finished turns were recorded after the message, so they went with it');
  assert.deepEqual([s.meta.stats.cost, s.meta.stats.workMs], [before.cost, before.workMs], 'the work was done and paid for');
  assert.equal(bridge.calls.at(-1)[1].restoreFiles, true);
  const id = s.items.at(-1).uuid;
  // A step from before the cut is still known; one from after it is not.
  s.handle({ kind: 'edit', id, messageId: U2 });
  s.handle({ kind: 'tool-progress', id: 'tool-old', elapsed: 3 });
  assert.equal(s.items.find((it) => it.t === 'tool').elapsed, 3);
  bridge.editReply({ ok: true, id });
  await done;
});

test('an edited message keeps its pictures', async () => {
  const s = new S.Store();
  const img = { mediaType: 'image/png', data: 'AAAA' };
  s.loadHistory([{ kind: 'user-text', text: 'what is this', uuid: U1, images: 1, imageData: [img] }, { kind: 'assistant-text', text: 'A cat' }]);
  const done = s.editFrom(U1, 'what breed is this');
  const edited = s.items.at(-1);
  assert.deepEqual([edited.images, edited.thumbs], [1, [img]]);
  assert.deepEqual(s.meta.lastPrompt, { text: 'what breed is this', images: [img] });
  assert.equal('images' in bridge.calls.at(-1)[1], false, 'the engine sends the saved ones again itself');
  bridge.editReply({ ok: true });
  await done;
});

test('an edit the engine refuses: the chat is put back as it was, and what you wrote is kept for the editor', async () => {
  const s = chat();
  let reloads = 0;
  s.reload = () => { reloads++; };
  const done = s.editFrom(U3, 'third, reworded');
  const id = s.items.at(-1).uuid;
  s.handle({ kind: 'edit', id, messageId: U3 });
  s.handle({ kind: 'busy', busy: true, state: 'starting' });
  bridge.editReply({ ok: false, code: 'edit-refused', message: 'That message could not be edited.' });
  const r = await done;
  assert.deepEqual([r.ok, r.code], [false, 'edit-refused']);
  assert.equal(reloads, 1);
  assert.equal(s.meta.busy, false);
  assert.equal(s.takeLostEdit(U2), null, 'only the message that was being edited gets it back');
  assert.equal(s.takeLostEdit(U3), 'third, reworded');
  assert.equal(s.takeLostEdit(U3), null, 'once');
  // Events are shown again (the reload replays the chat from the engine).
  s.handle({ kind: 'notice', text: 'hello' });
  assert.equal(s.items.at(-1).t, 'notice');
});

// An OpenAI chat with one saved turn, then two messages sent from this window (their bubbles carry the ids Canopy
// made). Its edit of the second message is refused, and the chat is shown again as `reloaded` has it: read back
// from Codex, where every message carries Codex's own id.
async function refusedCodexEdit(reloaded, { chat = 'thread-1', chatAfter = chat } = {}) {
  const s = new S.Store();
  s.setEngine('codex');
  s.setMeta({ sessionId: chat });
  s.loadHistory([{ kind: 'user-text', text: 'first', uuid: 'item-1', images: 0 }, { kind: 'assistant-text', text: 'ONE' }, { kind: 'turn-end', durationMs: 1 }]);
  s.dispatch('second', []);
  const sent = s.items.at(-1);
  s.handle({ kind: 'assistant-text', text: 'TWO' });
  s.handle({ kind: 'turn-end', durationMs: 1 });
  s.dispatch('third', []);
  let reloads = 0;
  // What App and a Multi mode pane do for `reload`: the chat again, as the engine has it.
  s.reload = () => { reloads++; s.reset(); s.setEngine('codex'); s.setMeta({ sessionId: chatAfter }); s.loadHistory(reloaded(sent.uuid)); };
  const done = s.editFrom(sent.uuid, 'second, reworded');
  bridge.editReply({ ok: false, code: 'edit-failed', message: 'That message could not be edited: turn not found. Nothing was changed.' });
  const r = await done;
  assert.deepEqual([r.ok, r.code, reloads], [false, 'edit-failed', 1]);
  return { s, sent, users: s.items.filter((it) => it.t === 'user') };
}
const asSaved = (texts) => () => texts.flatMap((text, i) => [{ kind: 'user-text', text, uuid: `item-${i + 1}`, images: 0 }, { kind: 'assistant-text', text: `reply ${i + 1}` }, { kind: 'turn-end', durationMs: 1 }]);

test('an OpenAI chat\'s refused edit: the chat comes back under Codex\'s own ids, and the editor still opens on the same message', async () => {
  const { s, sent, users: [first, second, third] } = await refusedCodexEdit(asSaved(['first', 'second', 'third']));
  assert.deepEqual([first.uuid, second.uuid, third.uuid], ['item-1', 'item-2', 'item-3']);
  assert.notEqual(second.uuid, sent.uuid, 'no bubble carries the id the edit was made with any more');
  // Each bubble asks as it appears. Only the one in the edited message's place, saying what it said, gets the words.
  assert.equal(s.takeLostEdit(first.uuid, first), null);
  assert.equal(s.takeLostEdit(third.uuid, third), null);
  assert.equal(s.takeLostEdit(second.uuid), null, 'by id alone it is not found');
  assert.equal(s.takeLostEdit(second.uuid, second), 'second, reworded');
  assert.equal(s.takeLostEdit(second.uuid, second), null, 'once');
});

test('the place only counts when it is surely the same message: same chat, same words, and no bubble still carrying the old id', async () => {
  // The message in that place says something else (the conversation is not what it was).
  let t = await refusedCodexEdit(asSaved(['first', 'something else', 'third']));
  for (const u of t.users) assert.equal(t.s.takeLostEdit(u.uuid, u), null);
  // The same words, but one place further down.
  t = await refusedCodexEdit(asSaved(['first', 'inserted', 'second']));
  for (const u of t.users) assert.equal(t.s.takeLostEdit(u.uuid, u), null);
  // Another chat altogether is on screen, with the same words in the same place.
  t = await refusedCodexEdit(asSaved(['first', 'second', 'third']), { chatAfter: 'thread-2' });
  for (const u of t.users) assert.equal(t.s.takeLostEdit(u.uuid, u), null);
  // The old id is still there (a chat whose ids do not change): it alone decides, wherever it is.
  t = await refusedCodexEdit((old) => [
    { kind: 'user-text', text: 'second', uuid: 'item-1', images: 0 }, { kind: 'user-text', text: 'second', uuid: 'item-2', images: 0 }, { kind: 'user-text', text: 'second', uuid: old, images: 0 },
  ]);
  assert.equal(t.s.takeLostEdit(t.users[1].uuid, t.users[1]), null, 'the place does not win over the id');
  assert.equal(t.s.takeLostEdit(t.users[2].uuid, t.users[2]), 'second, reworded');
  // A chat that had no id yet when the edit was made (its first turn had not started): the place and words decide.
  t = await refusedCodexEdit(asSaved(['first', 'second', 'third']), { chat: null, chatAfter: 'thread-9' });
  assert.equal(t.s.takeLostEdit(t.users[1].uuid, t.users[1]), 'second, reworded');
});

test('a conversation cut back by something other than an edit made here is read again', () => {
  const s = chat();
  let reloads = 0;
  s.reload = () => { reloads++; };
  s.handle({ kind: 'reverted', sessionId: 'thread-1' });
  assert.equal(reloads, 1);
  assert.equal(s.items.some((it) => it.t === 'raw'), false, 'it is not shown as a row');
  // Not while replaying a saved chat, and not while this window's own edit is on its way (its `edit` event says it).
  const h = new S.Store();
  h.reload = () => { reloads++; };
  h.loadHistory([{ kind: 'user-text', text: 'a', uuid: U1, images: 0 }, { kind: 'reverted' }]);
  assert.equal(reloads, 1);
  s.editFrom(U3, 'third, reworded');
  s.handle({ kind: 'reverted', sessionId: 'thread-1' });
  assert.equal(reloads, 1);
});

test('editing in an OpenAI chat: the same cut at once, no files to put back, and the engine\'s mark opens the new turn', async () => {
  const s = new S.Store();
  s.setEngine('codex');
  s.loadHistory([{ kind: 'user-text', text: 'first', uuid: 'item-1', images: 0 }, { kind: 'assistant-text', text: 'ONE' }, { kind: 'turn-end', durationMs: 1 }]);
  s.dispatch('second', []);
  const sent = s.items.at(-1);
  s.handle({ kind: 'busy', busy: true, state: 'running' });
  s.handle({ kind: 'text-delta', text: 'Working on it' });
  const done = s.editFrom(sent.uuid, 'second, reworded');
  assert.equal(texts(s), 'you:first | claude:ONE | turn | you:second, reworded');
  const edited = s.items.at(-1);
  assert.deepEqual(bridge.calls.at(-1), ['edit', { messageId: sent.uuid, text: 'second, reworded', id: edited.uuid, restoreFiles: false }]);
  // The engine stops the old reply, cuts, and marks: nothing of the old reply shows under the new message.
  s.handle({ kind: 'assistant-text', text: 'Working on it', aborted: true });
  s.handle({ kind: 'turn-end', interrupted: true, subtype: 'interrupted' });
  s.handle({ kind: 'busy', busy: false });
  assert.equal(texts(s), 'you:first | claude:ONE | turn | you:second, reworded');
  assert.equal(s.meta.busy, true);
  s.handle({ kind: 'edit', id: edited.uuid, messageId: sent.uuid, fresh: false, text: 'second, reworded' });
  s.handle({ kind: 'busy', busy: true, state: 'starting' });
  s.handle({ kind: 'text-delta', text: 'New reply' });
  s.handle({ kind: 'turn-end', durationMs: 5 });
  bridge.editReply({ ok: true, id: edited.uuid, fresh: false, first: false, replaced: 'second' });
  assert.equal((await done).ok, true);
  assert.equal(texts(s), 'you:first | claude:ONE | turn | you:second, reworded | claude:New reply | turn');
  assert.equal(E.editBlocked(edited, { engine: 'codex', wall: s.wall }), null, 'and it can be edited again');
  assert.equal(await s.editPreview(sent.uuid), null, 'nothing to offer to undo');
});

test('one edit at a time, and an answer for a chat you have left changes nothing on screen', async () => {
  const s = chat();
  assert.equal(s.cutPending, false);
  const done = s.editFrom(U3, 'third, reworded');
  assert.equal(s.cutPending, true, 'no other message can be edited until this one has landed');
  // You open another chat while the engine is still at it; then the engine says no.
  let reloads = 0;
  s.reload = () => { reloads++; };
  s.reset();
  s.loadHistory([{ kind: 'user-text', text: 'another chat', uuid: U1, images: 0 }]);
  s.handle({ kind: 'busy', busy: true, state: 'running' });
  assert.equal(s.cutPending, false);
  bridge.editReply({ ok: false, code: 'edit-failed', message: 'no' });
  await done;
  assert.equal(reloads, 0, 'the chat on screen is not the one the answer is about');
  assert.equal(s.meta.busy, true, 'and its own state is left alone');
  assert.equal(s.takeLostEdit(U3), 'third, reworded', 'the words wait for when you come back to that chat');
});

test('an edit that fails before the engine starts, or throws: the same way back', async () => {
  const s = chat();
  let reloads = 0;
  s.reload = () => { reloads++; };
  const done = s.editFrom(U3, 'x');
  bridge.editReply({ error: 'Not allowed.' }); // main's own refusal has this shape
  assert.deepEqual(await done, { ok: false, message: 'Not allowed.' });
  assert.equal(reloads, 1);
  assert.deepEqual(await s.editFrom('99999999-9999-4999-8999-999999999999', 'x'), { ok: false, message: 'That message can’t be edited.' });
  assert.equal(reloads, 1, 'nothing was cut, so nothing to put back');
});

test('a second view of the same chat follows an edit made in the other one', () => {
  const s = chat();
  const id = '44444444-4444-4444-8444-444444444444';
  // It was not told beforehand: it sees the old reply end, then the engine's mark.
  s.handle({ kind: 'turn-end', interrupted: true });
  s.handle({ kind: 'edit', id, messageId: U3, fresh: false, text: 'third, reworded' });
  assert.equal(texts(s), 'you:first | tool | claude:ONE | you:second | claude:TWO | turn | turn | you:third, reworded');
  assert.equal(s.items.at(-1).uuid, id);
  assert.equal(s.meta.busy, true);
  // A message it cannot place: it asks for the chat again instead of guessing.
  let reloads = 0;
  s.reload = () => { reloads++; };
  s.handle({ kind: 'edit', id: '55555555-5555-4555-8555-555555555555', messageId: '66666666-6666-4666-8666-666666666666', text: 'x' });
  assert.equal(reloads, 1);
  // In a saved conversation the mark means nothing.
  const h = new S.Store();
  h.loadHistory([{ kind: 'user-text', text: 'a', uuid: U1, images: 0 }, { kind: 'edit', id, messageId: U1, text: 'b' }]);
  assert.equal(texts(h), 'you:a');
});

test('the preview of files to undo comes back as a list or nothing', async () => {
  const s = new S.Store();
  bridge.preview = { files: ['/a/x.ts'], insertions: 3, deletions: 1 };
  assert.deepEqual(await s.editPreview(U1), { files: ['/a/x.ts'], insertions: 3, deletions: 1 });
  bridge.preview = null;
  assert.equal(await s.editPreview(U1), null);
  bridge.preview = { error: 'Not allowed.' };
  assert.equal(await s.editPreview(U1), null);
});

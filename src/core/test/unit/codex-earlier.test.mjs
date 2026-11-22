// "Show earlier", engine and host side: the older part of a very long Codex chat, a page at a time.
//   readTurns / CodexService.turns     carry on from a cursor, and say where the next older page begins
//   CodexSession.history({ before })   the same through a chat's own process
//   CodexChats.history / earlier       the marker a long chat opens with, and what the window's button is answered
// A Claude chat is always read whole, so it has nothing to page. The scripted Codex (fake-codex.mjs) answers
// thread/turns/list the way the app-server does: newest first, `nextCursor` while there is more. No Codex is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { CodexService, readTurns } from '../../codex-host.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { CodexChats } from '../../../codex-chats.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-earlier-')));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const open = [];
const fakes = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose ? s.dispose({ graceMs: 50 }) : s.close(), 4000, 'close'); } catch { /* reported by the test itself */ } }
  const left = fakes.splice(0).flatMap((f) => f.alive());
  assert.equal(left.length, 0, 'every process started here is gone');
});

const CHAT = '019a0000-0000-7000-8000-0000000000aa';
const CLAUDE_CHAT = '4c7e0000-1111-4222-8333-444444444444';
/** Turn `n` of a chat: what the user asked and what Codex answered. */
const turn = (n) => ({
  id: `turn-${n}`, status: 'completed', error: null, startedAt: 1_794_800_000 + n * 60, completedAt: 1_794_800_003 + n * 60, durationMs: 3000, itemsView: 'full',
  items: [
    { type: 'userMessage', id: `u${n}`, clientId: null, content: [{ type: 'text', text: `question ${n}`, text_elements: [] }] },
    { type: 'agentMessage', id: `a${n}`, text: `answer ${n}`, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null },
  ],
});
const turns = (count) => Array.from({ length: count }, (_, i) => turn(i + 1));
const ids = (list) => list.map((t) => t.id);
const asked = (events) => events.filter((e) => e.kind === 'user-text').map((e) => e.text);

/** An `ask` over a list of turns, oldest first, the way thread/turns/list pages them: newest first, by offset. */
function pager(all, { failAt = null, bad = null } = {}) {
  const calls = [];
  const ask = async (method, params) => {
    calls.push(params);
    if (bad && params.cursor === bad) throw Object.assign(new Error('invalid cursor'), { code: 'rpc' });
    if (failAt !== null && calls.length === failAt) throw Object.assign(new Error('codex stopped answering'), { code: 'timeout' });
    const newestFirst = all.slice().reverse();
    const from = Number(params.cursor ?? 0);
    const next = from + params.limit;
    return { data: newestFirst.slice(from, next), nextCursor: next < all.length ? String(next) : null };
  };
  return { ask, calls };
}

function service(fake, opts = {}) {
  const s = new CodexService({ codexPath: '/fake/codex', env: { PATH: '/usr/bin', HOME: root }, spawnFn: fake.spawnFn, timeouts: { init: 1000, request: 1000, list: 1000, history: 1000 }, ...opts });
  open.push(s);
  return s;
}
function fakeCodex(script = {}) {
  const fake = createFakeCodex(script);
  fakes.push(fake);
  return fake;
}
/** The host's list with one Codex chat in it (CHAT), over whatever stands in for the shared helper. */
function registry(svc) {
  const state = {};
  const chats = new CodexChats({ load: () => state.codexChats, save: (list) => { state.codexChats = list; }, service: svc, onChange: () => {}, now: () => 1_800_000_000_000 });
  chats.onEvent({ kind: 'init', sessionId: CHAT, engine: 'codex', model: 'gpt-6.1-sol' }, { sessionId: CHAT, cwd: work, title: null });
  assert.equal(chats.has(CHAT), true);
  return chats;
}

// ---- readTurns ----

test('readTurns: a read that stops short says where the older turns begin', async () => {
  const p = pager(turns(10));
  const newest = await readTurns(p.ask, 'chat', { maxTurns: 4, pageSize: 4 });
  assert.deepEqual(ids(newest.turns), ['turn-7', 'turn-8', 'turn-9', 'turn-10']);
  assert.deepEqual([newest.truncated, newest.cursor], [true, '4']);
  assert.equal('cursor' in p.calls[0], false, 'the first read sends no cursor');
});

test('readTurns with a cursor returns the next older page, oldest first, and the cursor after it; the last page has none', async () => {
  const p = pager(turns(10));
  const page = await readTurns(p.ask, 'chat', { maxTurns: 4, pageSize: 4, cursor: '4' });
  assert.deepEqual(ids(page.turns), ['turn-3', 'turn-4', 'turn-5', 'turn-6']);
  assert.deepEqual([page.truncated, page.cursor], [true, '8']);
  assert.deepEqual(p.calls[0], { threadId: 'chat', itemsView: 'full', sortDirection: 'desc', limit: 4, cursor: '4' });

  const last = await readTurns(p.ask, 'chat', { maxTurns: 4, pageSize: 4, cursor: page.cursor });
  assert.deepEqual(ids(last.turns), ['turn-1', 'turn-2']);
  assert.deepEqual([last.truncated, last.cursor], [false, null], 'these reach the chat\'s first turn');
});

test('readTurns: a page is read in as many asks as it takes, and never past what was asked for', async () => {
  const p = pager(turns(30));
  const page = await readTurns(p.ask, 'chat', { maxTurns: 10, pageSize: 4, cursor: '5' });
  assert.deepEqual(ids(page.turns), turns(30).slice(15, 25).map((t) => t.id));
  assert.equal(page.cursor, '15');
  assert.deepEqual(p.calls.map((c) => [c.cursor, c.limit]), [['5', 4], ['9', 4], ['13', 2]]);
});

test('readTurns: a later page that fails keeps what was read, and the cursor is where to try again', async () => {
  const p = pager(turns(12), { failAt: 3 });
  const page = await readTurns(p.ask, 'chat', { maxTurns: 100, pageSize: 3, cursor: '3' });
  assert.deepEqual(ids(page.turns), ['turn-4', 'turn-5', 'turn-6', 'turn-7', 'turn-8', 'turn-9']);
  assert.deepEqual([page.truncated, page.cursor], [true, '9']);
  const rest = await readTurns(pager(turns(12)).ask, 'chat', { maxTurns: 100, pageSize: 3, cursor: page.cursor });
  assert.deepEqual(ids(rest.turns), ['turn-1', 'turn-2', 'turn-3']);
  assert.equal(rest.cursor, null);
});

test('readTurns: a first page that fails rejects, whether it is the newest page or one a cursor asked for', async () => {
  await assert.rejects(readTurns(pager(turns(5), { failAt: 1 }).ask, 'chat', {}), { code: 'timeout' });
  await assert.rejects(readTurns(pager(turns(5), { bad: 'nope' }).ask, 'chat', { cursor: 'nope' }), { code: 'rpc' });
});

test('readTurns: a cursor that is not a string is no cursor', async () => {
  for (const cursor of [null, undefined, '', 0, 5, {}, []]) {
    const p = pager(turns(3));
    const r = await readTurns(p.ask, 'chat', { cursor });
    assert.deepEqual(ids(r.turns), ['turn-1', 'turn-2', 'turn-3']);
    assert.equal('cursor' in p.calls[0], false);
  }
});

// ---- the shared helper ----

test('CodexService.turns({ cursor }) reads the page before a cursor, and a cursor Codex does not know is a plain failure', async () => {
  const fake = fakeCodex();
  fake.turnsOf.chat = turns(9);
  const s = service(fake);
  const newest = await s.turns('chat', { maxTurns: 4, pageSize: 4 });
  assert.deepEqual([newest.ok, ids(newest.turns), newest.truncated, newest.cursor], [true, ['turn-6', 'turn-7', 'turn-8', 'turn-9'], true, '4']);
  const older = await s.turns('chat', { maxTurns: 4, pageSize: 4, cursor: newest.cursor });
  assert.deepEqual([older.ok, ids(older.turns), older.cursor], [true, ['turn-2', 'turn-3', 'turn-4', 'turn-5'], '8']);
  const first = await s.turns('chat', { maxTurns: 4, pageSize: 4, cursor: older.cursor });
  assert.deepEqual([first.ok, ids(first.turns), first.truncated, first.cursor], [true, ['turn-1'], false, null]);
  assert.deepEqual(fake.sent('thread/turns/list').map((m) => m.params.cursor), [undefined, '4', '8']);

  fake.errors['thread/turns/list'] = (params) => (params.cursor === 'nope' ? { code: -32600, message: 'invalid cursor: nope' } : null);
  const bad = await s.turns('chat', { cursor: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /invalid cursor/);
});

// ---- a chat's own process ----

test('CodexSession.history({ before }) is a page of the past: older turns only, nothing of the turn in flight', async () => {
  const fake = fakeCodex({ known: [CHAT] });
  fake.turnsOf[CHAT] = turns(7);
  const s = new CodexSession({ cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: root }, spawnFn: fake.spawnFn, resume: CHAT, timeouts: { restart: 15, secondPress: 0 } });
  open.push(s);
  const w = watch(s);
  await s.warm();

  const newest = await s.history({ maxTurns: 3, pageSize: 3 });
  assert.deepEqual([newest.ok, asked(newest.events), newest.truncated, newest.cursor], [true, ['question 5', 'question 6', 'question 7'], true, '3']);

  // A turn is running, with a command printing: none of that belongs in a page of the past.
  fake.holdTurns = true;
  s.send('question 8');
  await w.waitFor('message-start', { ms: 3000 });
  const child = fake.last;
  child.note('item/started', { item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'make'", cwd: work, status: 'inProgress', commandActions: [{ type: 'unknown', command: 'make' }], aggregatedOutput: null, exitCode: null, durationMs: null }, threadId: child.threadId, turnId: child.turn.id, startedAtMs: Date.now() });
  child.note('item/commandExecution/outputDelta', { threadId: child.threadId, turnId: child.turn.id, itemId: 'exec-1', delta: 'building\n' });
  await w.waitFor('tool-output', { ms: 3000 });

  const page = await s.history({ before: newest.cursor, maxTurns: 3, pageSize: 3 });
  assert.deepEqual([page.ok, asked(page.events), page.truncated, page.cursor], [true, ['question 2', 'question 3', 'question 4'], true, '6']);
  assert.deepEqual([...new Set(page.events.map((e) => e.kind))], ['user-text', 'assistant-text', 'turn-end'], 'whole finished turns, and nothing else');
  assert.equal(fake.sent('thread/turns/list').at(-1).params.cursor, '3');

  const last = await s.history({ before: page.cursor, maxTurns: 3, pageSize: 3 });
  assert.deepEqual([asked(last.events), last.truncated], [['question 1'], false]);
  assert.equal('cursor' in last, false, 'no cursor once the chat\'s first turn is in hand');

  for (const before of ['', 0, 7, {}, [], true]) {
    const bad = await s.history({ before });
    assert.deepEqual([bad.ok, bad.code], [false, 'invalid-input'], `before: ${JSON.stringify(before)}`);
  }
  fake.errors['thread/turns/list'] = (params) => (params.cursor === 'nope' ? { code: -32600, message: 'invalid cursor: nope' } : null);
  assert.equal((await s.history({ before: 'nope' })).ok, false);

  const now = await s.history();
  assert.equal(now.events.at(-1).kind, 'tool-output', 'the chat as it is now still ends with what the command is printing');
  child.playText();
  await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000 });
});

// ---- the host's list ----

test('CodexChats.history leads with the marker when there is an older part, and never with the old notice', async () => {
  const fake = fakeCodex();
  fake.turnsOf[CHAT] = turns(6);
  const svc = service(fake);
  const short = { turns: (id, o) => svc.turns(id, { ...o, maxTurns: 2, pageSize: 2 }) }; // a "very long" chat, in small: two turns a read
  const chats = registry(short);
  const opened = await chats.history(CHAT);
  assert.deepEqual(opened[0], { kind: 'earlier', cursor: '2', history: true });
  assert.deepEqual(asked(opened), ['question 5', 'question 6']);
  assert.equal(opened.filter((e) => e.kind === 'earlier').length, 1);
  assert.equal(opened.some((e) => e.kind === 'notice'), false);
  assert.equal(JSON.stringify(opened).includes('earlier part is not shown'), false);

  // A chat read whole has no marker.
  const whole = await registry(svc).history(CHAT);
  assert.deepEqual(asked(whole), [1, 2, 3, 4, 5, 6].map((n) => `question ${n}`));
  assert.equal(whole.some((e) => e.kind === 'earlier'), false);

  // `before` asks for the page before a cursor, with the marker again while there is more.
  const page = await chats.history(CHAT, { before: '2' });
  assert.deepEqual(page[0], { kind: 'earlier', cursor: '4', history: true });
  assert.deepEqual(asked(page), ['question 3', 'question 4']);
});

test('CodexChats.earlier: page after page to the chat\'s first turn, through the live chat when there is one', async () => {
  const fake = fakeCodex();
  fake.turnsOf[CHAT] = turns(530);
  const svc = service(fake);
  const chats = registry(svc);
  // The chat opens with its newest 400 turns and the marker for the rest.
  const opened = await chats.history(CHAT);
  assert.equal(opened[0].kind, 'earlier');
  assert.deepEqual([asked(opened).length, asked(opened)[0], asked(opened).at(-1)], [400, 'question 131', 'question 530']);

  const one = await chats.earlier(CHAT, { cursor: opened[0].cursor });
  assert.equal(one.error, undefined);
  assert.equal(one.events[0].kind, 'earlier');
  assert.equal(asked(one.events).length, 100, 'a page is a hundred turns');
  assert.deepEqual([asked(one.events)[0], asked(one.events).at(-1)], ['question 31', 'question 130']);
  const two = await chats.earlier(CHAT, { cursor: one.events[0].cursor });
  assert.deepEqual([asked(two.events)[0], asked(two.events).at(-1)], ['question 1', 'question 30']);
  assert.equal(two.events.some((e) => e.kind === 'earlier'), false, 'the last page has no marker');
  assert.equal(two.events[0].kind, 'user-text');

  // A live chat is asked first, for the page and with the page's size; the helper is not asked at all.
  const before = fake.sent('thread/turns/list').length;
  const calls = [];
  const session = { history: async (o) => { calls.push(o); return { ok: true, events: [{ kind: 'user-text', text: 'from the live chat' }], truncated: true, cursor: 'next' }; } };
  assert.deepEqual(await chats.earlier(CHAT, { session, cursor: 'here' }), { events: [{ kind: 'earlier', cursor: 'next', history: true }, { kind: 'user-text', text: 'from the live chat' }] });
  assert.deepEqual(calls, [{ before: 'here', maxTurns: 100 }]);
  assert.equal(fake.sent('thread/turns/list').length, before);
  // A live chat that cannot answer (it stopped meanwhile) leaves the page to the helper.
  const stopped = { history: async () => ({ ok: false, code: 'not-running', message: 'This chat is not running.' }) };
  const viaHelper = await chats.earlier(CHAT, { session: stopped, cursor: opened[0].cursor });
  assert.equal(asked(viaHelper.events).length, 100);
});

test('CodexChats.earlier: a Claude chat has nothing to page, a bad cursor is an error, and nothing throws', async () => {
  const fake = fakeCodex();
  fake.turnsOf[CHAT] = turns(5);
  const svc = service(fake);
  const chats = registry(svc);
  // Not one of Codex's chats: Claude Code's are read whole. Nothing is asked of anyone.
  for (const id of [CLAUDE_CHAT, '', null, undefined, 7]) assert.deepEqual(await chats.earlier(id, { cursor: '4' }), { events: [] });
  assert.equal(fake.spawns.length, 0, 'Codex was not even started');

  for (const cursor of [undefined, null, '', 0, 12, {}, [], 'x'.repeat(5000)]) {
    assert.deepEqual(await chats.earlier(CHAT, { cursor }), { error: 'That is not a place in this chat.' });
  }
  assert.equal(fake.spawns.length, 0);

  fake.errors['thread/turns/list'] = (params) => (params.cursor === 'nope' ? { code: -32600, message: 'invalid cursor: nope' } : null);
  const refused = await chats.earlier(CHAT, { cursor: 'nope' });
  assert.equal(typeof refused.error, 'string');
  assert.match(refused.error, /invalid cursor/);
  assert.equal(refused.events, undefined);

  // The chat is gone, Codex is not there, the live chat throws: an error each, never an exception.
  const gone = registry({ turns: async () => ({ ok: false, code: 'not-found', message: 'That chat is no longer on disk.' }) });
  assert.deepEqual(await gone.earlier(CHAT, { cursor: '4' }), { error: 'That chat is no longer on disk.' });
  assert.deepEqual(await registry(null).earlier(CHAT, { cursor: '4' }), { error: 'Codex is not available.' });
  const throws = registry({ turns: async () => { throw new Error('boom'); } });
  assert.deepEqual(await throws.earlier(CHAT, { cursor: '4', session: { history: async () => { throw new Error('bang'); } } }), { error: 'boom' });
  assert.deepEqual(await chats.earlier(CHAT), { error: 'That is not a place in this chat.' });
  await sleep(0);
});

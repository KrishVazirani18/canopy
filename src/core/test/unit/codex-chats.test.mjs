// The host side of Codex chats: which engine a chat opens on, Canopy's own list of Codex chats (sidebar rows,
// history, rename, the model picker's OpenAI rows), and the ChatHost seam that holds a Claude chat and a Codex
// chat side by side. The last group runs the real CodexSession and CodexService on the scripted stand-in for
// the app-server (fake-codex.mjs), wired the way src/main.mjs wires them. No Codex is started.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex, fixtureLines, recordedIds } from '../fake-codex.mjs';
import { sleep } from '../helpers.mjs';
import { CodexChats, CODEX_CHATS_MAX, engineFor } from '../../../codex-chats.mjs';
import { ChatHost, engineOf } from '../../../chats.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { CodexService } from '../../codex-host.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-chats-')));
const work = path.join(root, 'work');
const other = path.join(root, 'other');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(other, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

// A CodexService stand-in: each method answers what the test put in `answers`, and counts its calls.
function fakeService(answers = {}) {
  const calls = { listThreads: 0, turns: 0, rename: 0, models: 0, account: 0 };
  const answer = async (name, args) => {
    calls[name] += 1;
    const a = answers[name];
    return typeof a === 'function' ? a(...args) : a;
  };
  return {
    calls, answers,
    listThreads: (...a) => answer('listThreads', a), turns: (...a) => answer('turns', a), rename: (...a) => answer('rename', a),
    models: (...a) => answer('models', a), account: (...a) => answer('account', a),
  };
}

function registry(opts = {}) {
  const state = { codexChats: opts.saved };
  const saves = [];
  let changes = 0;
  let clock = opts.at ?? 1_800_000_000_000;
  const service = opts.service ?? fakeService();
  const chats = new CodexChats({
    load: () => state.codexChats, save: (list) => { state.codexChats = JSON.parse(JSON.stringify(list)); saves.push(state.codexChats); },
    service, onChange: () => { changes += 1; }, now: () => clock, ...opts.extra,
  });
  return { chats, state, saves, service, changes: () => changes, tick: (ms) => { clock += ms; }, now: () => clock };
}

const ID = '019a0000-0000-7000-8000-000000000001';
const ID2 = '019a0000-0000-7000-8000-000000000002';
const MIN = 60_000;

// ---- which engine ----

test('a saved chat opens on the engine it was started on, whatever the window asks for', () => {
  const has = (id) => id === ID;
  assert.equal(engineFor({ resume: ID, engine: 'claude', has, codexPath: '/opt/homebrew/bin/codex' }), 'codex');
  assert.equal(engineFor({ resume: ID, has, codexPath: null }), 'codex', 'a Codex chat is never handed to Claude Code, even with Codex gone');
  assert.equal(engineFor({ resume: 'a-claude-chat', engine: 'codex', has, codexPath: '/opt/homebrew/bin/codex' }), 'claude');
});

test('a new chat follows the model row that was picked, and is a Claude chat when Codex is not on this Mac', () => {
  assert.equal(engineFor({ engine: 'codex', codexPath: '/opt/homebrew/bin/codex' }), 'codex');
  assert.equal(engineFor({ engine: 'codex', codexPath: null }), 'claude');
  assert.equal(engineFor({ engine: 'codex', codexPath: '/opt/homebrew/bin/codex', signedIn: false }), 'claude', 'signed out of Codex: a chat that could not run is not opened');
  assert.equal(engineFor({ engine: 'codex', codexPath: '/opt/homebrew/bin/codex', signedIn: true }), 'codex');
  assert.equal(engineFor({ engine: 'codex', codexPath: '/opt/homebrew/bin/codex', signedIn: null }), 'codex', 'not asked yet is not signed out');
  assert.equal(engineFor({ engine: 'claude', codexPath: '/opt/homebrew/bin/codex' }), 'claude');
  assert.equal(engineFor({ codexPath: '/opt/homebrew/bin/codex' }), 'claude');
  assert.equal(engineFor({ engine: 'gemini', codexPath: '/opt/homebrew/bin/codex' }), 'claude');
  assert.equal(engineFor(), 'claude');
  assert.equal(engineFor({ resume: ID, has: () => { throw new Error('boom'); } }), 'claude', 'never throws');
});

// ---- the list ----

test('a chat is recorded when its first turn starts, then kept in step with its turns', () => {
  const { chats, state, tick, now, changes } = registry();
  const entry = { sessionId: null, cwd: work, title: 'Tighten the spacing in the footer' };
  chats.onEvent({ kind: 'busy', busy: true }, entry);
  chats.onEvent({ kind: 'meta', engine: 'codex', sessionId: null, model: 'gpt-6.1-sol' }, entry);
  assert.equal(chats.size, 0, 'a chat with no turn yet is not on disk, so it is not listed');
  assert.deepEqual(chats.rows([work]), []);

  const created = now();
  entry.sessionId = ID;
  chats.onEvent({ kind: 'init', sessionId: ID, engine: 'codex', model: 'gpt-6.1-sol', cwd: '/private' + work }, entry);
  assert.equal(chats.has(ID), true);
  assert.deepEqual(state.codexChats[ID], { cwd: work, title: 'Tighten the spacing in the footer', preview: null, createdAt: created, lastPromptAt: null, model: 'gpt-6.1-sol' },
    'the folder is the one Canopy opened, not Codex\'s spelling of it');

  tick(1000);
  chats.onEvent({ kind: 'message-start' }, entry);
  assert.equal(state.codexChats[ID].lastPromptAt, created + 1000);
  tick(5000);
  chats.onEvent({ kind: 'turn-end', text: '\n\nDone: the gap is 8px now.\nSecond line.' }, entry, { model: 'gpt-6-luna' });
  assert.equal(state.codexChats[ID].preview, 'Done: the gap is 8px now.');
  assert.equal(state.codexChats[ID].model, 'gpt-6-luna');
  assert.equal(state.codexChats[ID].lastPromptAt, created + 1000, 'a reply does not reorder the sidebar: only your own message does');

  assert.deepEqual(chats.rows([work]), [{ id: ID, title: 'Tighten the spacing in the footer', updated: created + 1000, branch: null, cwd: work, preview: 'Done: the gap is 8px now.', engine: 'codex' }]);
  assert.equal(changes(), 3, 'each change tells the sidebar');

  // The same chat starting its process again says `init` again: nothing changes.
  chats.onEvent({ kind: 'init', sessionId: ID, engine: 'codex' }, entry);
  assert.equal(changes(), 3);
});

test('a chat begun on a pasted key is remembered as that; one begun on Codex’s login is recorded exactly as before', () => {
  const { chats, state } = registry();
  // On Codex's own login, whatever the session calls its account: the entry has the fields it always had.
  for (const [id, session] of [[ID, { model: 'gpt-6.1-sol' }], [ID2, { model: 'gpt-6.1-sol', provider: null, accountId: 'codex-default' }]]) {
    chats.onEvent({ kind: 'init', sessionId: id, engine: 'codex' }, { sessionId: id, cwd: work, title: 'on the login' }, session);
    assert.deepEqual(Object.keys(state.codexChats[id]).sort(), ['createdAt', 'cwd', 'lastPromptAt', 'model', 'preview', 'title']);
    assert.equal(chats.accountOf(id), null);
  }
  // Its process was started on the pasted key's provider: the account is kept, by its id.
  const KEYED = '019a0000-0000-7000-8000-000000000003';
  chats.onEvent({ kind: 'init', sessionId: KEYED, engine: 'codex' }, { sessionId: KEYED, cwd: work, title: 'on the key' }, { model: 'gpt-6.1-sol', provider: 'canopy-openai', accountId: 'codex-key-1' });
  assert.equal(state.codexChats[KEYED].account, 'codex-key-1');
  assert.equal(chats.accountOf(KEYED), 'codex-key-1');
  // It stays through the chat's life, and through a restart of Canopy.
  chats.onEvent({ kind: 'message-start' }, { sessionId: KEYED, cwd: work });
  chats.onEvent({ kind: 'turn-end', text: 'done' }, { sessionId: KEYED, cwd: work }, { model: 'gpt-6-luna', provider: null, accountId: null });
  chats.onEvent({ kind: 'meta', title: 'Renamed' }, { sessionId: KEYED, cwd: work });
  assert.equal(registry({ saved: state.codexChats }).chats.accountOf(KEYED), 'codex-key-1');
  // Only ever an account's id: a provider with no account named, or anything that is not a name, records nothing.
  let n = 4;
  for (const session of [{ provider: 'canopy-openai', accountId: null }, { provider: 'canopy-openai' }, { provider: 'canopy-openai', accountId: 7 }, { provider: '', accountId: 'codex-key-1' }, null, undefined]) {
    const id = `019a0000-0000-7000-8000-00000000000${n++}`;
    chats.onEvent({ kind: 'init', sessionId: id, engine: 'codex' }, { sessionId: id, cwd: work, title: 'x' }, session);
    assert.equal('account' in state.codexChats[id], false, JSON.stringify(session));
  }
  for (const unknown of ['nope', '', null, undefined, 7]) assert.equal(chats.accountOf(unknown), null);
  assert.ok(!JSON.stringify(state).includes('sk-'), 'an id, never a key');
});

test('a rename reaches the list, and a chat with no name takes the first message once there is one', () => {
  const { chats, state } = registry();
  const entry = { sessionId: ID, cwd: work, title: null };
  chats.onEvent({ kind: 'init', sessionId: ID }, entry);
  assert.equal(state.codexChats[ID].title, null);
  assert.equal(chats.rows()[0].title, 'Untitled chat');
  entry.title = 'what does this repo do';
  chats.onEvent({ kind: 'message-start' }, entry);
  assert.equal(state.codexChats[ID].title, 'what does this repo do');
  chats.onEvent({ kind: 'meta', title: 'Repo tour' }, entry);
  assert.equal(chats.titleOf(ID), 'Repo tour');
  // Reopened: Codex's own name fills in only where the list has none.
  chats.onEvent({ kind: 'init', sessionId: ID, name: 'Something else' }, entry);
  assert.equal(chats.titleOf(ID), 'Repo tour');
  chats.onEvent({ kind: 'init', sessionId: ID2, name: 'Named in Codex' }, { sessionId: ID2, cwd: work, title: null });
  assert.equal(chats.titleOf(ID2), 'Named in Codex');
});

test('an edit empties the row\'s quoted reply until the next one, and a chat still named after its first message follows the new one', () => {
  const { chats, state, changes } = registry();
  const entry = { sessionId: ID, cwd: work, title: 'Tighten the spacing in the footer' };
  chats.onEvent({ kind: 'init', sessionId: ID }, entry);
  chats.onEvent({ kind: 'turn-end', text: 'Done: the gap is 8px now.' }, entry);
  assert.equal(chats.rows()[0].preview, 'Done: the gap is 8px now.');
  chats.onEvent({ kind: 'edit', id: 'n', messageId: 'm', fresh: false, text: 'fix the header instead' }, entry);
  assert.equal(state.codexChats[ID].preview, null, 'the reply it quoted went with the edit');
  const n = changes();
  chats.onEvent({ kind: 'edit', id: 'n2', messageId: 'n', fresh: false, text: 'fix the header' }, entry);
  assert.equal(changes(), n, 'nothing to clear: nothing is saved');
  chats.onEvent({ kind: 'edit', id: 'x', messageId: 'y', text: 'z' }, { sessionId: ID2, cwd: work, title: null });
  assert.equal(chats.size, 1, 'an edit in a chat the list does not hold adds nothing');
  chats.onEvent({ kind: 'turn-end', text: 'The header is fixed.' }, entry);
  assert.equal(chats.rows()[0].preview, 'The header is fixed.');

  // The name: a chat goes by its first message until it is named, so the edited first message takes over.
  assert.equal(chats.firstMessageEdited(ID, 'Tighten the spacing in the footer', 'fix the header instead'), true);
  assert.equal(chats.titleOf(ID), 'fix the header instead');
  assert.equal(chats.firstMessageEdited(ID, 'fix the header instead', 'fix the header instead'), false, 'the same words: nothing to do');
  // A long first message is compared the way the list keeps it (its first 80 characters).
  const long = `${'a very long first message '.repeat(6)}end`;
  chats.onEvent({ kind: 'init', sessionId: ID2 }, { sessionId: ID2, cwd: work, title: long });
  assert.equal(chats.titleOf(ID2).length, 80);
  assert.equal(chats.firstMessageEdited(ID2, long, 'short now'), true);
  assert.equal(chats.titleOf(ID2), 'short now');
  // A name you gave it (or Codex has for it) is not the first message, and stays.
  chats.onEvent({ kind: 'meta', title: 'Header work' }, entry);
  assert.equal(chats.firstMessageEdited(ID, 'fix the header instead', 'something else'), false);
  assert.equal(chats.titleOf(ID), 'Header work');
  for (const args of [[ID], [ID, null, 'x'], [ID, '', 'x'], [ID, 'Header work', '   '], ['nope', 'a', 'b'], [null, 'a', 'b'], [ID, {}, []]]) assert.equal(chats.firstMessageEdited(...args), false);
  assert.equal(chats.titleOf(ID), 'Header work');
  // A name on record as given (by you, or made by Canopy: codex-titles.mjs makes that one again itself) is never
  // swapped for a first message, even when it happens to read the same.
  for (const by of ['you', 'canopy']) {
    chats.markNamed(ID2, by);
    assert.equal(chats.firstMessageEdited(ID2, 'short now', 'other words'), false, by);
    assert.equal(chats.titleOf(ID2), 'short now');
  }
});

test('a chat that was gone from disk carries on as a new one: the old row goes, the new one keeps the name', () => {
  const { chats, state } = registry({ saved: { [ID]: { cwd: work, title: 'Sidebar work', preview: 'ok', createdAt: 1, lastPromptAt: 2, model: 'gpt-6.1-sol' } } });
  const entry = { sessionId: ID, cwd: work, title: 'Sidebar work' };
  chats.onEvent({ kind: 'meta', sessionId: null, previousSessionId: ID }, entry);
  assert.equal(state.codexChats[ID].gone, true);
  assert.deepEqual(chats.rows([work]), []);
  chats.onEvent({ kind: 'meta', sessionId: ID2, previousSessionId: ID }, entry);
  assert.equal(chats.titleOf(ID2), 'Sidebar work');
  assert.deepEqual(chats.rows([work]).map((r) => r.id), [ID2]);
  assert.equal(chats.has(ID), true, 'never deleted, so the id still says "this was a Codex chat"');
});

test('rows are picked by folder, compared as Canopy spells them', () => {
  const saved = {
    a: { cwd: work, title: 'A', createdAt: 10, lastPromptAt: 30 },
    b: { cwd: other, title: 'B', createdAt: 20, lastPromptAt: null },
    c: { cwd: work + '/', title: 'C', createdAt: 5, lastPromptAt: 6, gone: true },
    d: { cwd: work + '/', title: 'D', createdAt: 5, lastPromptAt: 7 },
  };
  const { chats } = registry({ saved });
  assert.deepEqual(chats.rows([work]).map((r) => r.id), ['a', 'd']);
  assert.deepEqual(chats.rows([other, '/nowhere']).map((r) => [r.id, r.updated]), [['b', 20]]);
  assert.deepEqual(chats.rows().map((r) => r.id), ['a', 'b', 'd']);
  assert.deepEqual(chats.rows([]), []);
});

test('an unreadable saved list is an empty one, and a failing save never reaches the caller', () => {
  for (const saved of [null, 'nope', [1, 2], { x: 'not an entry', y: null }]) {
    const { chats } = registry({ saved });
    assert.equal(chats.size, 0);
    assert.deepEqual(chats.rows(), []);
  }
  const logs = [];
  const chats = new CodexChats({ load: () => { throw new Error('disk'); }, save: () => { throw new Error('full'); }, log: (m) => logs.push(m) });
  chats.onEvent({ kind: 'init', sessionId: ID }, { sessionId: ID, cwd: work });
  assert.equal(chats.has(ID), true);
  chats.onEvent(null); chats.onEvent('x'); chats.onEvent({ kind: 'turn-end' }); chats.onEvent({ kind: 'init', sessionId: 42 }, null, null);
  assert.equal(logs.length >= 2, true);
});

test(`only the newest ${CODEX_CHATS_MAX} chats are kept`, () => {
  const saved = {};
  for (let i = 0; i < CODEX_CHATS_MAX; i++) saved[`old-${i}`] = { cwd: work, title: `chat ${i}`, createdAt: 1000 + i, lastPromptAt: 1000 + i };
  const { chats, state } = registry({ saved });
  chats.onEvent({ kind: 'init', sessionId: ID }, { sessionId: ID, cwd: work, title: 'the new one' });
  assert.equal(Object.keys(state.codexChats).length, CODEX_CHATS_MAX);
  assert.equal(chats.has(ID), true);
  assert.equal(chats.has('old-0'), false, 'the one written in longest ago made room');
  assert.equal(chats.has('old-1'), true);
});

// ---- catching up with Codex ----

const thread = (id, extra = {}) => ({ id, cwd: work, title: null, preview: '', createdAt: 1, updatedAt: 2, ...extra });

// Codex's lists as the fake service answers them: the open list, the archived list, and thread/read.
const codexHas = ({ listed = [], archived = [], onDisk = null } = {}) => ({
  listThreads: (o) => ({ ok: true, threads: (o?.archived ? archived : listed).map((id) => (typeof id === 'string' ? thread(id) : id)), nextCursor: null }),
  readThread: (id) => ((onDisk ?? listed).includes(id) ? { ok: true, thread: thread(id) } : { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' }),
});
const twoSaved = () => ({ [ID]: { cwd: work, title: 'Kept', createdAt: 1, lastPromptAt: 2 }, [ID2]: { cwd: work, title: 'The other one', createdAt: 1, lastPromptAt: 2 } });

test('a chat archived in Codex is left out of the rows, and comes back if Codex lists it again', async () => {
  const service = fakeService(codexHas({ listed: [ID, 'someone-elses'], archived: [ID2, 'another-archived'] }));
  service.calls.readThread = 0;
  service.readThread = (id) => { service.calls.readThread += 1; return service.answers.readThread(id); };
  const { chats, state, changes } = registry({ saved: twoSaved(), service });
  assert.equal(await chats.refresh(), true);
  assert.equal(state.codexChats[ID2].gone, true);
  assert.deepEqual(chats.rows([work]).map((r) => r.id), [ID]);
  assert.equal(changes(), 1);
  assert.equal(service.calls.readThread, 0, 'the archived list already said so');
  Object.assign(service.answers, codexHas({ listed: [ID, ID2] }));
  assert.equal(await chats.refresh(), true);
  assert.equal('gone' in state.codexChats[ID2], false);
  assert.deepEqual(chats.rows([work]).map((r) => r.id), [ID, ID2]);
});

test('a chat deleted in Codex is left out of the rows', async () => {
  const service = fakeService(codexHas({ listed: [ID], onDisk: [ID] }));
  service.readThread = (id) => service.answers.readThread(id);
  const { chats, state } = registry({ saved: twoSaved(), service });
  assert.equal(await chats.refresh(), true);
  assert.equal(state.codexChats[ID2].gone, true);
  assert.equal(chats.has(ID2), true, 'still known as a Codex chat');
});

test('a chat Codex merely does not list is kept: its index can lack a chat that is on disk', async () => {
  // Seen on a real Mac: the quick list had 200 chats, the slow scan 201, and thread/read found the odd one out.
  const service = fakeService(codexHas({ listed: [ID], onDisk: [ID, ID2] }));
  let reads = 0;
  service.readThread = (id) => { reads += 1; return service.answers.readThread(id); };
  const { chats, state, tick } = registry({ saved: twoSaved(), service });
  assert.equal(await chats.refresh(), false);
  assert.equal(state.codexChats[ID2].gone, undefined);
  assert.deepEqual(chats.rows([work]).map((r) => r.id), [ID, ID2]);
  assert.deepEqual(chats.lastRefresh, { listed: 1, unlisted: 1 });
  tick(5 * MIN);
  await chats.refresh(); await chats.refresh();
  assert.equal(reads, 1, 'looked up once, not on every catch-up');
  // Archived later: the archived list says so, with no second lookup.
  Object.assign(service.answers, codexHas({ listed: [ID], archived: [ID2] }));
  assert.equal(await chats.refresh(), true);
  assert.equal(state.codexChats[ID2].gone, true);
  assert.equal(reads, 1);
});

test('nothing is decided when Codex cannot say, or for a chat a few minutes old', async () => {
  const at = 1_800_000_000_000;
  const saved = () => ({ [ID]: { cwd: work, title: 'Old', createdAt: 1, lastPromptAt: 2 } });
  const unreadable = { ok: false, code: 'timeout', message: 'no answer' };
  for (const [why, answers] of [
    ['the list fails', { listThreads: unreadable, readThread: () => ({ ok: false, code: 'not-found' }) }],
    ['the list is nonsense', { listThreads: null, readThread: () => ({ ok: false, code: 'not-found' }) }],
    ['the second page fails', { listThreads: ({ cursor }) => (cursor ? unreadable : { ok: true, threads: [thread('x')], nextCursor: 'p2' }), readThread: () => ({ ok: false, code: 'not-found' }) }],
    ['the archived list fails and the lookup times out', { listThreads: (o) => (o.archived ? unreadable : { ok: true, threads: [], nextCursor: null }), readThread: () => unreadable }],
    ['the list throws', { listThreads: () => { throw new Error('pipe closed'); } }],
    ['the lookup throws', { listThreads: { ok: true, threads: [thread('x')], nextCursor: null }, readThread: () => { throw new Error('pipe closed'); } }],
    ['the lookup answers nonsense', { listThreads: { ok: true, threads: [thread('x')], nextCursor: null }, readThread: () => null }],
    ['an older Codex helper has no lookup', { listThreads: { ok: true, threads: [thread('x')], nextCursor: null } }],
  ]) {
    const service = fakeService(answers);
    if (answers.readThread) service.readThread = answers.readThread;
    const { chats, state } = registry({ saved: saved(), service, at });
    assert.equal(await chats.refresh(), false, why);
    assert.equal(state.codexChats[ID].gone, undefined, why);
  }
  // An empty list (what a rebuilt index looks like) hides nothing that is still on disk.
  const empty = fakeService(codexHas({ listed: [], onDisk: [ID] }));
  empty.readThread = (id) => empty.answers.readThread(id);
  const rebuilt = registry({ saved: saved(), service: empty, at });
  assert.equal(await rebuilt.chats.refresh(), false);
  assert.deepEqual(rebuilt.chats.rows([work]).map((r) => r.id), [ID]);
  // Too new to be judged, even with Codex saying it is not there.
  const service = fakeService(codexHas({ listed: ['x'], onDisk: [] }));
  service.readThread = (id) => service.answers.readThread(id);
  const young = registry({ saved: { [ID]: { cwd: work, title: 'Just started', createdAt: at - 2 * MIN, lastPromptAt: null } }, service, at });
  assert.equal(await young.chats.refresh(), false);
  young.tick(9 * MIN);
  assert.equal(await young.chats.refresh(), true);
  assert.equal(young.state.codexChats[ID].gone, true);
});

test('Codex hands its list out a page at a time: every page is read, up to ten, and only a few chats are looked up at once', async () => {
  const saved = { [ID]: { cwd: work, title: 'On page two', createdAt: 1, lastPromptAt: 2 } };
  for (let i = 0; i < 8; i++) saved[`unlisted-${i}`] = { cwd: work, title: `Unlisted ${i}`, createdAt: 1, lastPromptAt: 2 };
  const asked = [];
  let reads = 0;
  const service = fakeService({ listThreads: (o) => {
    asked.push(o);
    if (o.archived) return { ok: true, threads: [], nextCursor: null };
    return o.cursor === 'p2' ? { ok: true, threads: [thread(ID)], nextCursor: null } : { ok: true, threads: Array.from({ length: 100 }, (_, i) => thread(`t-${i}`)), nextCursor: 'p2' };
  } });
  service.readThread = () => { reads += 1; return { ok: false, code: 'not-found', message: 'gone' }; };
  const { chats, state } = registry({ saved, service });
  assert.equal(await chats.refresh(), true);
  assert.deepEqual(asked, [{ limit: 100 }, { limit: 100, cursor: 'p2' }, { limit: 100, archived: true }]);
  assert.equal(state.codexChats[ID].gone, undefined, 'on a later page: listed');
  assert.equal(reads, 5);
  assert.equal(Object.values(state.codexChats).filter((e) => e.gone).length, 5, 'the rest wait for the next catch-up');
  await chats.refresh();
  assert.equal(Object.values(state.codexChats).filter((e) => e.gone).length, 8);

  let pages = 0;
  const endless = registry({ saved: { [ID]: { cwd: work, title: 'A', createdAt: 1 } }, service: fakeService({ listThreads: () => ({ ok: true, threads: [thread(`t-${pages++}`)], nextCursor: 'more' }) }) });
  await endless.chats.refresh();
  assert.equal(pages, 20, 'ten pages of the list, ten of the archived list, and no further');
});

test('a name given in Codex fills in a chat the list has no name for, and never replaces one it has', async () => {
  const saved = { [ID]: { cwd: work, title: null, createdAt: 1 }, [ID2]: { cwd: work, title: 'Mine', createdAt: 1 } };
  const service = fakeService({ listThreads: { ok: true, threads: [thread(ID, { title: 'From Codex' }), thread(ID2, { title: 'Other' })], nextCursor: null } });
  const { chats } = registry({ saved, service });
  await chats.refresh();
  assert.equal(chats.titleOf(ID), 'From Codex');
  assert.equal(chats.titleOf(ID2), 'Mine');
});

test('the sidebar never waits for Codex: rows come back at once, and Codex is asked at most once a minute', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const service = fakeService({ listThreads: () => held });
  const { chats, tick } = registry({ saved: { [ID]: { cwd: work, title: 'A', createdAt: 1, lastPromptAt: 2 } }, service });
  assert.deepEqual(chats.rows([work]).map((r) => r.id), [ID], 'answered while Codex is still thinking');
  assert.equal(service.calls.listThreads, 1);
  chats.rows([work]); chats.rows([work]);
  assert.equal(service.calls.listThreads, 1, 'one ask in flight');
  release({ ok: true, threads: [thread(ID)], nextCursor: null });
  await chats.refreshing;
  tick(30_000); chats.rows([work]);
  assert.equal(service.calls.listThreads, 1, 'not again within the minute');
  tick(31_000); chats.rows([work]);
  assert.equal(service.calls.listThreads, 2);
  await chats.refreshing;
});

test('Codex is never asked while there is nothing to catch up on, or while it is not installed', async () => {
  const service = fakeService({ listThreads: { ok: true, threads: [], nextCursor: null } });
  const empty = registry({ service });
  empty.chats.rows([work]);
  assert.equal(service.calls.listThreads, 0, 'no Codex chats: no helper process is ever started for the sidebar');
  const missing = registry({ saved: { [ID]: { cwd: work, title: 'A', createdAt: 1 } }, service, extra: { installed: () => false } });
  assert.deepEqual(missing.chats.rows([work]).map((r) => r.id), [ID], 'the rows are still there');
  assert.equal(service.calls.listThreads, 0);
  const broken = registry({ saved: { [ID]: { cwd: work, title: 'A', createdAt: 1 } }, service: fakeService({ listThreads: () => { throw new Error('boom'); } }) });
  assert.deepEqual(broken.chats.rows([work]).map((r) => r.id), [ID]);
  await broken.chats.refreshing;
  assert.deepEqual(broken.chats.rows([work]).map((r) => r.id), [ID], 'a helper that throws changes nothing');
});

// ---- history ----

const recordedTurns = () => {
  const lines = fixtureLines('codex-history');
  const asked = lines.find((l) => l.dir === 'out' && l.msg.method === 'thread/turns/list');
  const turns = lines.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id).msg.result.data;
  return { threadId: asked.msg.params.threadId, turns };
};

test('history: a live chat is asked first, because its process knows about a turn in flight', async () => {
  const service = fakeService({ turns: { ok: true, turns: [] } });
  const { chats } = registry({ service });
  const events = [{ kind: 'user-text', text: 'hi' }, { kind: 'assistant-text', text: 'hello' }];
  assert.deepEqual(await chats.history(ID, { session: { history: async () => ({ ok: true, events }) } }), events);
  assert.equal(service.calls.turns, 0);
});

test('history: a chat that is not open, or whose process cannot answer, is read through the shared helper', async () => {
  const { threadId, turns } = recordedTurns();
  const service = fakeService({ turns: (id) => ({ ok: true, turns: id === threadId ? turns : [] }) });
  const { chats } = registry({ service });
  const plain = await chats.history(threadId);
  assert.equal(plain[0].kind, 'user-text');
  assert.equal(plain.at(-1).kind, 'turn-end');
  assert.equal(plain.some((e) => e.kind === 'tool-start'), true, 'the recorded chat ran a tool');
  for (const session of [{ history: async () => ({ ok: false, code: 'not-running', message: 'This chat is not running.' }) }, { history: async () => { throw new Error('boom'); } }, { history: () => Promise.resolve(null) }, {}, null]) {
    assert.deepEqual(await chats.history(threadId, { session }), plain);
  }
  assert.deepEqual(await chats.history(''), []);
  assert.deepEqual(await chats.history(null), []);
});

// (No notice says "This is a long chat. Its earlier part is not shown here.": the window's "Show earlier" button
// says it, and loads that part: see codex-earlier.test.mjs.)
test('history: a chat too long to read whole opens with a marker saying where its earlier part begins', async () => {
  const { threadId, turns } = recordedTurns();
  const left = { kind: 'earlier', cursor: 'older-turns', history: true };
  const service = fakeService({ turns: () => ({ ok: true, turns, truncated: true, cursor: 'older-turns' }) });
  const { chats } = registry({ service });
  const cut = await chats.history(threadId);
  assert.deepEqual(cut[0], left);
  assert.equal(cut[1].kind, 'user-text');
  assert.equal(cut.filter((e) => e.kind === 'earlier').length, 1);
  assert.equal(cut.some((e) => e.kind === 'notice'), false);
  const events = [{ kind: 'user-text', text: 'hi' }];
  assert.deepEqual(await chats.history(ID, { session: { history: async () => ({ ok: true, events, truncated: true, cursor: 'older-turns' }) } }), [left, ...events]);
  assert.deepEqual(await chats.history(ID, { session: { history: async () => ({ ok: true, events, truncated: false }) } }), events);
});

test('history: a failure is one plain notice, never an exception', async () => {
  const notice = (text) => [{ kind: 'notice', level: 'warn', text }];
  const gone = registry({ service: fakeService({ turns: { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' } }) });
  assert.deepEqual(await gone.chats.history(ID), notice('That chat is no longer on disk.'));
  assert.deepEqual(await gone.chats.history(ID, { session: { history: async () => ({ ok: false, code: 'not-found', message: 'x' }) } }), notice('That chat is no longer on disk.'));
  assert.equal(gone.service.calls.turns, 1, 'the chat\'s own process said it is gone: the helper is not asked the same thing');
  const slow = registry({ service: fakeService({ turns: { ok: false, code: 'timeout', message: 'Codex did not answer thread/turns/list in time.' } }) });
  assert.deepEqual(await slow.chats.history(ID, { session: { history: async () => ({ ok: false, code: 'timeout' }) } }), notice('Could not load history: Codex did not answer thread/turns/list in time.'));
  const broken = registry({ service: fakeService({ turns: () => { throw new Error('pipe closed'); } }) });
  assert.deepEqual(await broken.chats.history(ID), notice('Could not load history: pipe closed'));
  const none = new CodexChats({ load: () => null, save: () => {} });
  assert.deepEqual(await none.history(ID), notice('Could not load history: Codex is not available.'));
});

// ---- rename ----

test('rename: an open chat is told through its own process, a closed one through the helper, and the list has the name either way', async () => {
  const service = fakeService({ rename: { ok: true } });
  const { chats, changes } = registry({ saved: { [ID]: { cwd: work, title: 'Old', createdAt: 1 } }, service });
  const asked = [];
  assert.deepEqual(await chats.rename(ID, '  New   name  ', { rename: async (t) => { asked.push(t); return true; } }), { ok: true, via: 'live' });
  assert.deepEqual(asked, ['New name']);
  assert.equal(service.calls.rename, 0);
  assert.equal(chats.titleOf(ID), 'New name');
  assert.equal(changes(), 1);
  // Not open (or its process has not started the thread yet): the helper does it.
  assert.deepEqual(await chats.rename(ID, 'Third', { rename: async () => false }), { ok: true, via: 'service' });
  assert.deepEqual(await chats.rename(ID, 'Fourth', null), { ok: true, via: 'service' });
  assert.equal(service.calls.rename, 2);
  assert.equal(chats.titleOf(ID), 'Fourth');
});

test('rename: Codex refusing or failing is reported, never thrown, and the list keeps the new name', async () => {
  const service = fakeService({ rename: { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' } });
  const { chats } = registry({ saved: { [ID]: { cwd: work, title: 'Old', createdAt: 1 } }, service });
  assert.deepEqual(await chats.rename(ID, 'New', { rename: async () => { throw new Error('boom'); } }), { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' });
  assert.equal(chats.titleOf(ID), 'New');
  assert.equal((await chats.rename(ID, '   ')).code, 'invalid-input');
  assert.equal((await chats.rename('', 'x')).code, 'invalid-input');
  service.answers.rename = () => { throw new Error('pipe closed'); };
  assert.deepEqual(await chats.rename(ID, 'Again'), { ok: false, code: 'internal', message: 'pipe closed' });
});

// ---- the model picker ----

const row = (value, extra = {}) => ({
  value, displayName: value.toUpperCase(), description: `${value} model`, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'],
  efforts: [{ value: 'low', description: '' }], defaultEffort: 'medium', supportsFastMode: true, serviceTiers: ['priority'], isDefault: false, hidden: false,
  maker: 'openai', engine: 'codex', ...extra,
});
const SIGNED_IN = { ok: true, account: { type: 'apiKey', email: null, plan: null }, signedIn: true, requiresAuth: true };
const SIGNED_OUT = { ok: true, account: null, signedIn: false, requiresAuth: true };

test('models: the rows the picker gets, without the hidden ones', async () => {
  const service = fakeService({ account: SIGNED_IN, models: { ok: true, models: [row('gpt-6.1-sol', { isDefault: true }), row('codex-auto-review', { hidden: true }), row('gpt-6-luna', { supportsFastMode: false, defaultEffort: null })] } });
  const { chats } = registry({ service });
  const r = await chats.models();
  assert.deepEqual(r.codex, { installed: true, signedIn: true });
  assert.equal(chats.signInMethod, 'apiKey', 'how Codex is signed in, for the status line in Settings');
  assert.deepEqual(r.openai, [
    { value: 'gpt-6.1-sol', displayName: 'GPT-6.1-SOL', description: 'gpt-6.1-sol model', engine: 'codex', maker: 'openai', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsFastMode: true, isDefault: true },
    { value: 'gpt-6-luna', displayName: 'GPT-6-LUNA', description: 'gpt-6-luna model', engine: 'codex', maker: 'openai', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], defaultEffort: null, supportsFastMode: false, isDefault: false },
  ]);
  r.openai[0].supportedEffortLevels.push('changed by the caller');
  assert.equal((await chats.models()).openai[0].supportedEffortLevels.length, 3, 'callers get copies');
});

test('models: no Codex, or signed out of it, is simply no OpenAI rows: never an error', async () => {
  const service = fakeService({ account: SIGNED_IN, models: { ok: true, models: [row('gpt-6.1-sol')] } });
  const missing = registry({ service, extra: { installed: () => false } });
  assert.deepEqual(await missing.chats.models(), { openai: [], codex: { installed: false, signedIn: null } });
  assert.equal(service.calls.models + service.calls.account, 0, 'nothing is started to find that out');

  const out = registry({ service: fakeService({ account: SIGNED_OUT, models: { ok: true, models: [row('gpt-6.1-sol')] } }) });
  assert.deepEqual(await out.chats.models(), { openai: [], codex: { installed: true, signedIn: false } });
  assert.equal(out.chats.signInMethod, null, 'signed out: no way of being signed in');
  assert.equal(missing.chats.signInMethod, null);

  // Codex with its own provider needs no OpenAI sign-in: "no account" alone is not "signed out".
  const own = registry({ service: fakeService({ account: { ok: true, account: null, signedIn: false, requiresAuth: false }, models: { ok: true, models: [row('local-model')] } }) });
  assert.deepEqual((await own.chats.models()).openai.map((m) => m.value), ['local-model']);
  assert.equal(own.chats.signInMethod, null, 'its own provider: not signed in to OpenAI at all');

  for (const answers of [
    { account: { ok: false, code: 'timeout', message: 'slow' }, models: { ok: false, code: 'timeout', message: 'slow' } },
    { account: () => { throw new Error('boom'); }, models: () => { throw new Error('boom'); } },
    { account: null, models: null },
  ]) {
    const { chats } = registry({ service: fakeService(answers) });
    assert.deepEqual((await chats.models()).openai, []);
  }
  const none = new CodexChats({ load: () => null, save: () => {} });
  assert.deepEqual((await none.models()).openai, []);
});

test('models: with a pasted key in use the key’s own helper lists them, and Codex’s login is not asked about', async () => {
  // Codex's own login is signed out, and the models its helper would list are another account's.
  const own = fakeService({ account: SIGNED_OUT, models: { ok: true, models: [row('only-on-the-login')] } });
  const key = fakeService({ models: { ok: true, models: [row('gpt-6.1-sol', { isDefault: true }), row('gpt-6-luna')] } });
  let onKey = true;
  const { chats } = registry({ service: own, extra: { keyService: key, keyInUse: () => onKey } });
  const r = await chats.models();
  assert.deepEqual(r.codex, { installed: true, signedIn: true }, 'OpenAI’s chats can start: they run on the key, whatever Codex’s login is doing');
  assert.deepEqual(r.openai.map((m) => m.value), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.deepEqual([chats.signedIn, chats.signInMethod], [true, 'apiKey']);
  assert.deepEqual([own.calls.account, own.calls.models, key.calls.models, key.calls.account], [0, 0, 1, 0]);
  // Codex's own login chosen again: what the key listed is not kept for it, and Codex is asked.
  onKey = false;
  chats.forgetModels();
  assert.deepEqual(await chats.models(), { openai: [], codex: { installed: true, signedIn: false } });
  assert.deepEqual([own.calls.account, own.calls.models, key.calls.models, chats.signInMethod], [1, 1, 1, null]);
  // And the key again.
  onKey = true;
  chats.forgetModels();
  assert.deepEqual((await chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.equal(key.calls.models, 2);

  // The key cannot be launched right now (its helper says so): no error, and no row from another account in its place.
  const broken = fakeService({ models: { ok: false, code: 'account-invalid-key', message: 'The key for API key ••••9zQx no longer works.' } });
  const stuck = registry({ service: own, extra: { keyService: broken, keyInUse: () => true } });
  assert.deepEqual(await stuck.chats.models(), { openai: [], codex: { installed: true, signedIn: true } });
  // A host that says a key is in use but gave no helper for one, or whose answer throws: Codex's own helper lists them.
  const noHelper = registry({ service: fakeService({ account: SIGNED_IN, models: { ok: true, models: [row('gpt-6.1-sol')] } }), extra: { keyInUse: () => true } });
  assert.deepEqual((await noHelper.chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol']);
  const throws = registry({ service: fakeService({ account: SIGNED_IN, models: { ok: true, models: [row('gpt-6.1-sol')] } }), extra: { keyService: broken, keyInUse: () => { throw new Error('boom'); } } });
  assert.deepEqual((await throws.chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol']);
});

test('models: answered from memory after the first ask, and refreshed in the background when over five minutes old', async () => {
  const service = fakeService({ account: SIGNED_IN, models: { ok: true, models: [row('gpt-6.1-sol')] } });
  const announced = [];
  const { chats, tick } = registry({ service, extra: { onModels: (rows) => announced.push(rows.map((m) => m.value)) } });
  assert.deepEqual((await chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol']);
  await chats.models(); await chats.models();
  assert.equal(service.calls.models, 1);
  assert.deepEqual(announced, [], 'the first list was handed to the caller: nothing to announce');

  tick(6 * MIN);
  service.answers.models = { ok: true, models: [row('gpt-6.1-sol'), row('gpt-7')] };
  assert.deepEqual((await chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol'], 'the old list at once, not a wait');
  await chats.modelsAsk;
  assert.equal(service.calls.models, 2);
  assert.deepEqual(announced, [['gpt-6.1-sol', 'gpt-7']], 'the window is told the list changed');
  assert.deepEqual((await chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol', 'gpt-7']);

  // A refresh that fails keeps the list, and one that finds nothing new says nothing.
  tick(6 * MIN);
  service.answers.models = { ok: false, code: 'timeout', message: 'slow' };
  await chats.models(); await chats.modelsAsk;
  assert.deepEqual((await chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol', 'gpt-7']);
  assert.equal(announced.length, 1);
});

test('models: a Codex slow to start does not hold the picker; the rows are announced when they arrive', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const service = fakeService({ account: SIGNED_IN, models: () => held });
  const announced = [];
  const { chats } = registry({ service, extra: { onModels: (rows) => announced.push(rows.map((m) => m.value)), timings: { modelsWait: 20 } } });
  const [a, b] = await Promise.all([chats.models(), chats.models()]);
  assert.deepEqual([a.openai, b.openai], [[], []], 'both callers stopped waiting');
  assert.equal(service.calls.models, 1, 'one ask between them');
  release({ ok: true, models: [row('gpt-6.1-sol')] });
  await until(() => announced.length === 1, 1000, 'the late list');
  assert.deepEqual(announced, [['gpt-6.1-sol']]);
  assert.deepEqual((await chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol']);
});

test('models: a Codex that fails is not asked again on every menu open', async () => {
  const service = fakeService({ account: { ok: false, code: 'launch-failed', message: 'x' }, models: { ok: false, code: 'launch-failed', message: 'x' } });
  const { chats, tick } = registry({ service });
  await chats.models(); await chats.models(); await chats.models();
  assert.equal(service.calls.models, 1);
  tick(16_000);
  service.answers.account = SIGNED_IN;
  service.answers.models = { ok: true, models: [row('gpt-6.1-sol')] };
  assert.deepEqual((await chats.models()).openai.map((m) => m.value), ['gpt-6.1-sol'], 'it is tried again a little later, and the rows appear');
});

// ---- the seam: a Claude chat and a Codex chat behind one ChatHost, wired as main wires them ----

class ClaudeStub extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.cwd = opts.cwd; this.sessionId = opts.resume ?? null; this.busy = false; this.closed = false; this.pending = new Map(); this.lifecycle = 'ready'; this.outbox = { size: 0 }; }
  reportedBusy() { return this.busy; }
  send() { this.busy = true; return { ok: true }; }
  async dispose() { this.closed = true; }
  close() { this.closed = true; }
}

const hosts = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) {
    await h.host.closeAll();
    await h.service.close({ graceMs: 50 });
    assert.equal(h.fake.alive().length, 0, 'no process is left behind');
  }
});

function wired(script = {}, { codexPath = '/fake/codex', saved } = {}) {
  const fake = createFakeCodex(script);
  const state = { codexChats: saved };
  const sent = [];
  const made = [];
  const env = { PATH: '/usr/bin:/bin', HOME: root };
  const service = new CodexService({ codexPath: () => codexPath, env, spawnFn: fake.spawnFn, lingerMs: 20 });
  const chats = new CodexChats({ load: () => state.codexChats, save: (l) => { state.codexChats = JSON.parse(JSON.stringify(l)); }, service, installed: () => !!codexPath, onChange: () => sent.push(['sessions:changed']) });
  const host = new ChatHost({
    // The same branch as the `create` seam in src/main.mjs.
    create: (o) => {
      const s = o.engine === 'codex'
        ? new CodexSession({ cwd: o.cwd, resume: o.resume, codexPath: () => codexPath, env: () => env, spawnFn: fake.spawnFn, timeouts: { restart: 15 } })
        : new ClaudeStub(o);
      made.push(s);
      return s;
    },
    send: (channel, payload) => sent.push([channel, payload]),
    onEvent: (ev, entry) => { if (entry.engine === 'codex') chats.onEvent(ev, entry, host.manager.get(ev.sid)); },
    maxIdle: 8,
  });
  const open = (cwd, resume, opts) => {
    const engine = engineFor({ resume, engine: opts?.engine, has: (id) => chats.has(id), codexPath });
    return host.open(cwd, resume, engine === 'codex' ? { engine } : {});
  };
  // The same lines as editChat in src/main.mjs: the host edits, and a Codex chat's name follows its first message.
  const edit = async (sid, o) => {
    const r = await host.edit(sid, o);
    const sessionId = host.manager.get(sid)?.sessionId;
    if (r?.ok && r.first && sessionId && chats.has(sessionId)) chats.firstMessageEdited(sessionId, r.replaced, o?.text);
    return r;
  };
  const w = { fake, state, sent, made, service, chats, host, open, edit, events: (sid) => sent.filter(([c, p]) => c === 'session:event' && p.sid === sid).map(([, p]) => p) };
  hosts.push(w);
  return w;
}

test('one host, two engines: the model row picked decides the engine of a new chat, and each chat says which it is', async () => {
  const w = wired();
  const a = await w.open(work, null);
  const b = await w.open(work, null, { engine: 'codex' });
  assert.equal(a.session instanceof ClaudeStub, true);
  assert.deepEqual(a.session.opts, { cwd: work, resume: null }, 'a Claude chat is created from exactly what it always was');
  assert.equal(b.session instanceof CodexSession, true);
  assert.deepEqual([engineOf(a.session), engineOf(b.session)], ['claude', 'codex']);
  assert.deepEqual([w.host.status.get(a.sid).engine, w.host.status.get(b.sid).engine], ['claude', 'codex']);
  assert.equal(w.fake.spawns.length, 0, 'opening starts nothing: warm() or the first message does');
});

test('Codex asked for on a Mac without it: the chat that opens is a Claude chat', async () => {
  const w = wired({}, { codexPath: null });
  const r = await w.open(work, null, { engine: 'codex' });
  assert.equal(engineOf(r.session), 'claude');
  assert.equal(w.host.status.get(r.sid).engine, 'claude');
});

test('a Codex chat\'s first turn puts it in the sidebar, and after a restart it reopens as a Codex chat with its history', async () => {
  const w = wired();
  const r = await w.open(work, null, { engine: 'codex' });
  assert.deepEqual(w.chats.rows([work]), [], 'not listed before its first turn');
  assert.deepEqual(w.host.statusList(), []);
  r.session.send('say ok');
  w.host.noteSent('say ok');
  await until(() => w.events(r.sid).some((e) => e.kind === 'busy' && e.busy === false), 4000, 'the turn to end');
  const id = r.session.sessionId;
  assert.equal(typeof id, 'string');

  const kinds = w.events(r.sid).map((e) => e.kind);
  assert.equal(kinds.indexOf('init') < kinds.indexOf('message-start'), true);
  assert.equal(kinds.indexOf('turn-end') < kinds.lastIndexOf('busy'), true, 'turn-end before busy:false, which is what flushes the queue');
  assert.deepEqual(w.chats.rows([work]).map((x) => [x.id, x.title, x.preview, x.engine]), [[id, 'say ok', 'OK', 'codex']]);
  assert.deepEqual(w.host.statusList().map((x) => [x.sessionId, x.engine, x.state]), [[id, 'codex', 'done']]);
  assert.equal(w.sent.some(([c]) => c === 'sessions:changed'), true);

  // Canopy quits and starts again: only state.json survives.
  const saved = w.state.codexChats;
  await w.host.closeAll();
  const again = wired({ known: [id], turnsOf: { [id]: recordedTurns().turns } }, { saved });
  assert.deepEqual(again.chats.rows([work]).map((x) => x.id), [id], 'the sidebar row is there before anything is asked of Codex');
  const re = await again.open(work, id, { engine: 'claude' });
  assert.equal(engineOf(re.session), 'codex', 'the saved list decides, not the hint');
  assert.equal(re.session.sessionId, id);
  // Not started yet: the transcript comes through the shared helper.
  const history = await again.chats.history(id, { session: again.host.manager.find({ sessionId: id })?.session });
  assert.equal(history[0].kind, 'user-text');
  assert.equal(history.at(-1).kind, 'turn-end');
  assert.equal(again.fake.sent('thread/turns/list').length > 0, true);
  assert.equal(again.fake.sent('thread/resume').length, 0, 'reading history did not start the chat');
  // Opening it again while it is live reuses it.
  const same = await again.open(work, id);
  assert.equal(same.reused, true);
  assert.equal(same.sid, re.sid);
});

test('history of a live Codex chat comes from its own process', async () => {
  const { threadId } = recordedIds('codex-text');
  const turns = recordedTurns().turns;
  const w = wired({ known: [threadId], turnsOf: { [threadId]: turns } }, { saved: { [threadId]: { cwd: work, title: 'Recorded', createdAt: 1, lastPromptAt: 2 } } });
  const r = await w.open(work, threadId);
  assert.equal((await r.session.warm()).ok, true);
  const before = w.fake.children.length;
  const history = await w.chats.history(threadId, { session: w.host.manager.find({ sessionId: threadId })?.session });
  assert.equal(history.at(-1).kind, 'turn-end');
  assert.equal(w.fake.children.length, before, 'no helper process was started for it');
});

test('a message queued while a Codex chat works goes out when its turn ends', async () => {
  const w = wired({ holdTurns: true });
  const r = await w.open(work, null, { engine: 'codex' });
  r.session.send('first');
  await until(() => !!w.fake.last?.turn, 3000, 'the turn to start');
  assert.equal(w.host.queueAdd(r.sid, 'second', []).queue.length, 1);
  await sleep(200);
  assert.equal(w.fake.sent('turn/start').length, 1, 'still working: it waits');
  w.fake.holdTurns = false;
  w.fake.last.playText('one');
  await until(() => w.fake.sent('turn/start').length === 2, 3000, 'the queued message');
  assert.equal(w.fake.sent('turn/start')[1].params.input[0].text, 'second');
  assert.deepEqual(w.host.queueOf(r.sid).queue, []);
  await until(() => !r.session.busy, 3000, 'the second turn to end');
});

test('editing a message in a Codex chat through the host: the reply is stopped, the conversation cut, the queue waits, and the sidebar follows', async () => {
  const w = wired({ holdTurns: true });
  const r = await w.open(work, null, { engine: 'codex' });
  const first = r.session.send('say ok');
  w.host.noteSent('say ok');
  await until(() => !!w.fake.last?.turn, 3000, 'the first turn');
  const child = w.fake.last; // the chat's own process (reading the sidebar rows starts the shared helper, another one)
  child.playText('OK');
  await until(() => !r.session.busy, 3000, 'the first turn to end');
  const id = r.session.sessionId;
  assert.deepEqual(w.chats.rows([work]).map((x) => [x.title, x.preview]), [['say ok', 'OK']]);
  assert.equal(await w.host.editPreview(r.sid, first.id), null, 'Codex keeps no file checkpoints: there is never an undo to offer');

  // A second message is still being answered, and a third waits in the queue, when the first is edited.
  r.session.send('now count');
  await until(() => !!child.turn, 3000, 'the second turn');
  assert.equal(w.host.queueAdd(r.sid, 'after that', []).queue.length, 1);
  const mark = w.events(r.sid).length;
  const res = await w.edit(r.sid, { messageId: first.id, text: 'say hello', id: '0b0b0b0b-0000-4000-8000-00000000000b' });
  assert.deepEqual(res, { ok: true, id: '0b0b0b0b-0000-4000-8000-00000000000b', fresh: false, first: true, replaced: 'say ok' });
  assert.deepEqual(w.fake.received.filter((m) => ['turn/interrupt', 'thread/revert', 'turn/start'].includes(m.method)).map((m) => m.method).slice(-3), ['turn/interrupt', 'thread/revert', 'turn/start']);
  assert.equal(w.fake.reverts.length, 1);
  assert.equal(w.fake.reverts[0].dropped.length, 2, 'both turns went');

  // To the sidebar the chat never stopped; it is named after the new first message and quotes no reply that is gone.
  assert.deepEqual(w.host.statusList().map((x) => [x.sessionId, x.state, x.line]), [[id, 'working', null]]);
  assert.equal(w.host.status.get(r.sid).title, 'say hello');
  assert.deepEqual(w.chats.rows([work]).map((x) => [x.id, x.title, x.preview]), [[id, 'say hello', null]]);
  // The window is told in order: the old reply ending, the mark, then the new message's turn.
  const seen = w.events(r.sid).slice(mark).filter((e) => ['turn-end', 'edit', 'message-start'].includes(e.kind)).map((e) => (e.kind === 'turn-end' ? `turn-end:${e.subtype}` : e.kind));
  assert.deepEqual(seen, ['turn-end:interrupted', 'edit', 'message-start']);
  const told = w.events(r.sid).find((e) => e.kind === 'edit');
  assert.deepEqual([told.id, told.messageId, told.text, told.fresh], [res.id, first.id, 'say hello', false]);

  // The queued message is still waiting: it goes out only when the edited message's reply ends.
  await sleep(200);
  assert.deepEqual(w.fake.sent('turn/start').map((m) => m.params.input[0].text), ['say ok', 'now count', 'say hello']);
  assert.equal(w.host.queueOf(r.sid).queue.length, 1);
  w.fake.holdTurns = false;
  child.playText('HELLO');
  await until(() => w.fake.sent('turn/start').length === 4, 3000, 'the queued message');
  assert.equal(w.fake.sent('turn/start')[3].params.input[0].text, 'after that');
  await until(() => !r.session.busy, 3000, 'the queued turn to end');
  assert.deepEqual(w.fake.turnsOf[id].map((t) => t.items.find((i) => i.type === 'userMessage').content[0].text), ['say hello', 'after that']);
  assert.deepEqual(w.chats.rows([work]).map((x) => [x.title, x.preview]), [['say hello', 'OK']]);

  // What a window that opens the chat now reads: the cut conversation, from the chat's own process.
  const history = await w.chats.history(id, { session: r.session });
  assert.deepEqual(history.filter((e) => e.kind === 'user-text').map((e) => e.text), ['say hello', 'after that']);
});

test('an edit Codex refuses, through the host: the answer says why, the queue is woken, and the chat\'s name and row are untouched', async () => {
  const w = wired({ errors: { 'thread/revert': { message: 'turn not found: gone' } } });
  const r = await w.open(work, null, { engine: 'codex' });
  const first = r.session.send('say ok');
  w.host.noteSent('say ok');
  await until(() => w.events(r.sid).some((e) => e.kind === 'busy' && e.busy === false), 4000, 'the turn to end');
  const res = await w.edit(r.sid, { messageId: first.id, text: 'say hello' });
  assert.deepEqual(res, { ok: false, code: 'edit-failed', message: 'That message could not be edited: turn not found: gone. Nothing was changed.' });
  assert.deepEqual(w.chats.rows([work]).map((x) => [x.title, x.preview]), [['say ok', 'OK']]);
  assert.equal(w.host.status.get(r.sid).title, 'say ok');
  assert.equal(w.events(r.sid).some((e) => e.kind === 'edit'), false);
  w.host.queueAdd(r.sid, 'next', []);
  await until(() => w.fake.sent('turn/start').length === 2, 3000, 'the queue to move');
  await until(() => !r.session.busy, 3000, 'that turn to end');
});

test('swapping an empty chat for the other engine lets the unused one go; a used one is kept', async () => {
  const w = wired();
  const a = await w.open(work, null);                       // an empty Claude chat on screen
  const b = await w.open(work, null, { engine: 'codex' });  // the user picked a GPT model
  assert.equal(w.host.discardIfUntouched(b.sid), false, 'never the chat on screen');
  assert.equal(w.host.discardIfUntouched(a.sid), true);
  await until(() => a.session.closed && !w.host.status.has(a.sid), 1000, 'the empty chat to close');
  assert.equal(w.host.manager.get(a.sid), null);
  assert.equal(w.host.discardIfUntouched(a.sid), false, 'already gone');
  assert.equal(w.host.discardIfUntouched('nope'), false);
  assert.equal(w.host.discardIfUntouched(null), false);

  // A Codex chat that was warmed but never used has a process: swapping it out ends that process.
  await b.session.warm();
  assert.equal(w.fake.alive().length, 1);
  const c = await w.open(work, null);
  assert.equal(w.host.discardIfUntouched(b.sid), true);
  await until(() => w.fake.alive().length === 0, 2000, 'its process to exit');

  // Used chats stay: one with a message sent, one with a message waiting, one that is saved.
  const used = await w.open(work, null, { engine: 'codex' });
  used.session.send('hello');
  const queued = await w.open(work, null);
  w.host.queueAdd(queued.sid, 'later', []);
  const saved = await w.open(work, 'a-saved-claude-chat');
  await w.open(work, null);
  assert.equal(w.host.discardIfUntouched(used.sid), false);
  assert.equal(w.host.discardIfUntouched(queued.sid), false);
  assert.equal(w.host.discardIfUntouched(saved.sid), false);
  assert.equal(w.host.discardIfUntouched(c.sid), true);
  await until(() => !used.session.busy, 3000, 'the turn to end');
});

test('a pane giving up its empty chat is not told to reopen it', async () => {
  const w = wired();
  await w.open(work, null);
  const p = await w.host.openPane(work, null);
  const q = await w.host.openPane(work, null, { engine: 'codex' });
  assert.equal(engineOf(q.session), 'codex');
  assert.equal(w.host.status.get(q.sid).engine, 'codex');
  assert.equal(w.host.discardIfUntouched(p.sid), false, 'shown in a pane: kept, unless it is the pane that lets go');
  assert.equal(w.host.discardIfUntouched(p.sid, { pane: true }), true);
  await until(() => !w.host.status.has(p.sid), 1000, 'the pane chat to close');
  assert.deepEqual(w.sent.filter(([c]) => c === 'pane:closed'), []);
});

test('the list remembers who named a chat: you by default, Canopy when it says so; markNamed changes only that', async () => {
  const service = fakeService({ rename: { ok: true } });
  const { chats, state } = registry({ service });
  chats.onEvent({ kind: 'init', sessionId: ID }, { sessionId: ID, cwd: work, title: 'fix the chip' });
  await chats.rename(ID, 'Remove logo from chip', null, { by: 'canopy' });
  assert.deepEqual([state.codexChats[ID].title, state.codexChats[ID].named], ['Remove logo from chip', 'canopy']);
  await chats.rename(ID, 'Chip work', null);
  assert.deepEqual([state.codexChats[ID].title, state.codexChats[ID].named], ['Chip work', 'you']);
  chats.markNamed(ID, 'canopy');
  assert.deepEqual([chats.get(ID).title, chats.get(ID).named], ['Chip work', 'canopy']);
  chats.markNamed('not-a-chat', 'you'); // nothing to mark: no error
});

test('models: Codex set to a model list file (model_catalog_json) says so, asked through Codex; a change of it is a change of the list', async () => {
  let file = '/Users/test/.codex/model-catalog.json';
  const service = fakeService({ account: SIGNED_IN, models: { ok: true, models: [row('gpt-6.1-sol')] } });
  const asked = [];
  service.call = async (method, params) => { asked.push([method, params]); return { ok: true, result: { config: file ? { model_catalog_json: file } : {} } }; };
  const told = [];
  const { chats, tick } = registry({ service, extra: { onModels: (rows) => told.push(rows), timings: { modelsFresh: 10 } } });
  assert.deepEqual((await chats.models()).codex, { installed: true, signedIn: true, fixedList: file });
  assert.deepEqual(asked[0], ['config/read', { includeLayers: false }]);

  file = null; // the setting was taken out: the rows are the same, but what Settings says is not
  tick(MIN);
  await chats.models(); // answers from memory at once, and reads again behind it
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await chats.models()).codex, { installed: true, signedIn: true });
  assert.equal(told.length, 1, 'the window is told the list changed');

  // Codex could not say: what was known is kept, and nothing else breaks.
  const quiet = fakeService({ account: SIGNED_IN, models: { ok: true, models: [row('gpt-6.1-sol')] } });
  quiet.call = async () => { throw new Error('boom'); };
  assert.deepEqual((await registry({ service: quiet }).chats.models()).codex, { installed: true, signedIn: true });
});

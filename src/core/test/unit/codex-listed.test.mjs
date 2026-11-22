// The Codex chats Canopy did not start (src/codex-listed.mjs): which of the chats Codex lists reach the sidebar, under
// which folder, with what name and second line; that the list survives a restart; and how CodexChats answers for
// them (src/codex-chats.mjs: `has`, `rows`, `folderOf`, the catch-up, a chat opened here becoming one of Canopy's
// own). The last two tests run the real CodexService on the scripted stand-in for the app-server (fake-codex.mjs).
// No Codex is started, and nothing under ~/.codex or ~/Documents is read.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep } from '../helpers.mjs';
import { CodexListed, CODEX_LISTED_MAX, LINES_PER_REFRESH, LISTED_SOURCES } from '../../../codex-listed.mjs';
import { CodexChats, engineFor } from '../../../codex-chats.mjs';
import { CodexService } from '../../codex-host.mjs';

const HOME = '/Users/sam';
const CHATS = '/Users/sam/Library/Application Support/Canopy/chats';   // Canopy's own no-project folder
const PROJECT = '/tmp/proj';                                           // a project, as Canopy spells it
const REAL = { '/tmp/proj': '/private/tmp/proj', '/tmp/other': '/private/tmp/other' };
const realpath = async (p) => {
  for (const [from, to] of Object.entries(REAL)) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length);
  return p;
};
const T0 = 1_800_000_000_000;
const id = (n) => `019b0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** One chat as CodexService.listThreads hands it out. */
const thread = (n, over = {}) => ({
  id: id(n), cwd: '/private/tmp/proj', title: null, preview: `first message of chat ${n}`, createdAt: T0 - 5000 - n, updatedAt: T0 - n * 1000,
  model: 'gpt-6-luna', effort: 'low', source: 'vscode', parentId: null, branch: 'main', engine: 'codex', ...over,
});
/** One turn as `thread/turns/list` gives it in its summary view. */
const turn = (...texts) => ({ id: 'turn', items: [{ type: 'userMessage', content: [] }, ...texts.map((t, i) => ({ type: 'agentMessage', text: t, phase: i === texts.length - 1 ? 'final_answer' : 'commentary' }))], itemsView: 'summary', status: 'completed' });

// A CodexService stand-in: `threads` is Codex's whole list (handed out 100 a page), `replies` the last turn per chat.
function fakeService({ threads = [], replies = {}, fail = {} } = {}) {
  const s = {
    threads, replies, fail, lists: [], asked: [], renames: [], reads: 0,
    async listThreads(opts = {}) {
      s.lists.push(opts);
      if (s.fail.list === true || s.fail.page === s.lists.length) return { ok: false, code: 'timeout', message: 'Codex did not answer.' };
      const pool = opts.archived ? [] : s.threads;
      const from = Number(opts.cursor ?? 0);
      const page = pool.slice(from, from + 100);
      return { ok: true, threads: page.map((t) => ({ ...t })), nextCursor: from + 100 < pool.length ? String(from + 100) : null };
    },
    async call(method, params) {
      s.asked.push({ method, params });
      if (s.fail.call === true) return { ok: false, code: 'timeout', message: 'Codex did not answer.' };
      const r = s.replies[params.threadId];
      return { ok: true, result: { data: r === undefined ? [turn(`reply in ${params.threadId.slice(-3)}`)] : r === null ? [] : [r], nextCursor: null } };
    },
    async rename(threadId, name) { s.renames.push([threadId, name]); return { ok: true }; },
    async readThread() { s.reads += 1; return { ok: true }; },
    async turns() { return { ok: true, turns: [] }; },
    async models() { return { ok: true, models: [] }; },
    async account() { return { ok: true, account: null, signedIn: false, requiresAuth: false }; },
  };
  return s;
}

function make({ service = fakeService(), saved, folders = [PROJECT], at = T0 } = {}) {
  const state = { codexListed: saved };
  const box = { folders, clock: at, changes: 0, saves: 0, logs: [] };
  const listed = new CodexListed({
    load: () => state.codexListed, save: (list) => { state.codexListed = JSON.parse(JSON.stringify(list)); box.saves += 1; },
    service, folders: () => box.folders, home: HOME, realpath, onChange: () => { box.changes += 1; }, now: () => box.clock, log: (m) => box.logs.push(m),
  });
  return { listed, state, service, box };
}

/** CodexChats with a CodexListed behind it, wired the way src/main.mjs wires them. */
function both({ service = fakeService(), savedOwn, savedListed, folders = [PROJECT], timings } = {}) {
  const state = { codexChats: savedOwn, codexListed: savedListed };
  const box = { folders, clock: T0, changes: 0 };
  const chats = new CodexChats({
    load: () => state.codexChats, save: (list) => { state.codexChats = JSON.parse(JSON.stringify(list)); }, service,
    onChange: () => { box.changes += 1; }, now: () => box.clock, timings,
  });
  const listed = new CodexListed({
    load: () => state.codexListed, save: (list) => { state.codexListed = JSON.parse(JSON.stringify(list)); }, service,
    folders: () => box.folders, home: HOME, realpath, now: () => box.clock,
  });
  chats.listFrom(listed);
  return { chats, listed, state, service, box };
}

const until = async (cond, ms = 2000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

// ---- which chats ----

test('Codex is asked for chats from its app, the terminal and other clients, and for no other kind', async () => {
  const { listed, service } = make({ service: fakeService({ threads: [thread(1)] }) });
  await listed.refresh();
  assert.deepEqual(LISTED_SOURCES, ['cli', 'vscode', 'appServer']);
  assert.equal(service.lists.length, 1);
  assert.deepEqual(service.lists[0], { limit: 100, sourceKinds: ['cli', 'vscode', 'appServer'] }, 'never one-shot runs (exec), never a sub-agent');
});

test('a one-shot run or a sub-agent\'s thread is never listed, even if Codex hands one over', async () => {
  const threads = [thread(1, { source: 'exec' }), thread(2, { source: 'subAgent' }), thread(3, { source: null }), thread(4, { source: 'cli' }), thread(5, { source: 'appServer' }), thread(6)];
  const { listed } = make({ service: fakeService({ threads }) });
  await listed.refresh();
  assert.deepEqual(listed.rows().map((r) => r.id), [id(4), id(5), id(6)]);
});

// ---- which folders ----

test('a chat in one of your projects is listed under the project, at the project\'s own path, however Codex spelled the folder', async () => {
  // Codex's quick list gave /private/tmp/proj for a project Canopy knows as /tmp/proj (seen in the recordings).
  const { listed } = make({ service: fakeService({ threads: [thread(1, { cwd: '/private/tmp/proj' }), thread(2, { cwd: '/tmp/proj' })] }) });
  assert.equal(await listed.refresh(), true);
  assert.deepEqual(listed.rows([PROJECT]).map((r) => [r.id, r.cwd, r.engine, r.loose]), [[id(1), PROJECT, 'codex', undefined], [id(2), PROJECT, 'codex', undefined]]);
  assert.deepEqual(listed.rows().map((r) => r.cwd), [PROJECT, PROJECT], 'every folder: still the project\'s own path');
  assert.deepEqual(listed.rows(['/tmp/somewhere-else']), [], 'rows are picked by folder');
  assert.equal(listed.folderOf(id(1)), null, 'it runs where it is listed');
});

test('only your project folders are looked at on disk: a listed chat\'s own folder never is', async () => {
  const looked = [];
  const threads = [thread(1, { cwd: '/private/tmp/proj' }), thread(2, { cwd: `${HOME}/Documents/Codex/x` }), thread(3, { cwd: `${HOME}/Documents/taxes` }), thread(4, { cwd: `${HOME}/Desktop/scratch` }), thread(5, { cwd: '/Volumes/Backup/site' })];
  const listed = new CodexListed({
    load: () => null, save: () => {}, service: fakeService({ threads }), folders: () => [PROJECT, '/tmp/proj/', '/Users/sam/code/site'], home: HOME,
    realpath: async (p) => { looked.push(p); return realpath(p); },
  });
  await listed.refresh();
  assert.deepEqual(looked, [PROJECT, '/tmp/proj/', '/Users/sam/code/site'], 'looking into Documents just to draw the sidebar could put a permission prompt on screen');
  assert.deepEqual(listed.rows(undefined, { chatsDir: CHATS }).map((r) => [r.id, r.cwd]), [[id(1), PROJECT]], 'a Codex-app chat with no project is not in Recents');
});

test('a project Canopy knows by its real path still gets the chats Codex spelled the short way, and a folder that cannot be looked up is taken as written', async () => {
  const threads = [thread(1, { cwd: '/tmp/proj' }), thread(2, { cwd: '/var/folders/ab/site' }), thread(3, { cwd: '/tmp/gone' })];
  const listed = new CodexListed({
    load: () => null, save: () => {}, service: fakeService({ threads }), folders: () => ['/private/tmp/proj', '/private/var/folders/ab/site', '/tmp/gone'], home: HOME,
    realpath: async (p) => { if (p === '/tmp/gone') throw new Error('ENOENT'); return p; },
  });
  await listed.refresh();
  assert.deepEqual(listed.rows().map((r) => [r.id, r.cwd]), [[id(1), '/private/tmp/proj'], [id(2), '/private/var/folders/ab/site'], [id(3), '/tmp/gone']]);
});

test('a chat the Codex app keeps with no project is not listed (Recents holds only chats started in Canopy), and still runs in its own folder', async () => {
  const own = `${HOME}/Documents/Codex/2026-11-16-plan-a-trip`;
  const { listed } = make({ service: fakeService({ threads: [thread(1, { cwd: own, branch: null })] }) });
  await listed.refresh();
  assert.deepEqual(listed.rows([PROJECT, CHATS], { chatsDir: CHATS }), [], 'not under Chats');
  assert.deepEqual(listed.rows(undefined, { chatsDir: CHATS }), [], 'nor anywhere else');
  assert.equal(listed.folderOf(id(1)), own, 'opened another way (continued in Canopy), it runs in the folder it was started in');
});

test('a chat in any other folder is not listed, and shows up once that folder is a project', async () => {
  const threads = [thread(1, { cwd: '/tmp/other' }), thread(2, { cwd: `${HOME}/Documents/notes` }), thread(3, { cwd: `${HOME}/.codex/worktrees/a1/proj` }), thread(4, { cwd: null })];
  const { listed, box } = make({ service: fakeService({ threads }) });
  assert.equal(await listed.refresh(), false);
  assert.deepEqual(listed.rows(undefined, { chatsDir: CHATS }), []);
  assert.equal(listed.has(id(1)), false, 'not remembered either');
  box.folders = [PROJECT, '/tmp/other'];
  assert.equal(await listed.refresh(), true);
  assert.deepEqual(listed.rows().map((r) => [r.id, r.cwd]), [[id(1), '/tmp/other']]);
  box.folders = [PROJECT];
  await listed.refresh();
  assert.deepEqual(listed.rows(), [], 'and leaves when the project is removed');
});

// ---- the row ----

test('the row: the chat\'s name, else its first message cut short; Codex\'s own "updated"; the first message until the last reply is known', async () => {
  const long = 'Please look at the importer and tell me why the third column comes out empty when the file has a header row\nsecond line';
  const threads = [thread(1, { title: 'Importer bug' }), thread(2, { preview: long }), thread(3, { preview: '' })];
  const service = fakeService({ threads, fail: { call: true } });
  const { listed } = make({ service });
  await listed.refresh();
  const rows = listed.rows();
  assert.deepEqual(rows.map((r) => r.title), ['Importer bug', 'Please look at the importer and tell me why the third column comes out empty wh…', 'Untitled chat']);
  assert.equal(rows[1].title.length, 80);
  assert.deepEqual(rows.map((r) => r.updated), [T0 - 1000, T0 - 2000, T0 - 3000]);
  assert.deepEqual(rows.map((r) => r.preview), ['first message of chat 1', long.split('\n')[0], null], 'better than "No reply yet"');
  assert.equal(rows[0].branch, 'main');
  assert.equal(listed.titleOf(id(1)), 'Importer bug');
  assert.equal(listed.titleOf(id(3)), null);

  // Codex answers now: the second line is the final answer, as one line.
  service.fail.call = false;
  service.replies[id(1)] = turn('Looking at the importer.', 'The header row shifts every column by one.\nFix: skip it.');
  await listed.refresh();
  assert.equal(listed.rows()[0].preview, 'The header row shifts every column by one.');

  // Its markdown comes off, as on a Claude chat's line: a heading gives way to the sentence under it.
  service.replies[id(1)] = turn('Reading.', '### Fixed\nOpened **[the report](https://example.com/report)** at page 24.');
  threads[0] = thread(1, { title: 'Importer bug', updatedAt: T0 + 60_000 });
  await listed.refresh();
  assert.equal(listed.rows()[0].preview, 'Opened the report at page 24.');
});

test('the second line is asked for behind the list: a few chats a catch-up, newest first, and not again until the chat changes', async () => {
  const threads = Array.from({ length: 25 }, (_, i) => thread(i + 1));
  const service = fakeService({ threads });
  const { listed } = make({ service });
  await listed.refresh();
  assert.equal(LINES_PER_REFRESH, 10);
  assert.equal(service.asked.length, 10, 'at most ten a catch-up');
  assert.deepEqual(service.asked[0], { method: 'thread/turns/list', params: { threadId: id(1), limit: 1, sortDirection: 'desc', itemsView: 'summary' } }, 'one turn, the newest, in its short form');
  assert.deepEqual(service.asked.map((a) => a.params.threadId), threads.slice(0, 10).map((t) => t.id), 'newest first');
  assert.equal(listed.rows()[0].preview, 'reply in 001');
  assert.equal(listed.rows()[10].preview, 'first message of chat 11', 'the rest keep the first message for now');

  await listed.refresh();
  await listed.refresh();
  assert.equal(service.asked.length, 25, 'the next catch-ups do the rest, and then nothing is left to ask');
  await listed.refresh();
  assert.equal(service.asked.length, 25, 'a chat that has not changed is not asked about again');

  // Chat 7 got a new turn in the Codex app.
  threads[6] = thread(7, { updatedAt: T0 + 60_000 });
  service.replies[id(7)] = turn('A newer answer.');
  await listed.refresh();
  assert.deepEqual(service.asked.slice(25).map((a) => a.params.threadId), [id(7)]);
  assert.equal(listed.rows().find((r) => r.id === id(7)).preview, 'A newer answer.');
});

test('a chat whose last turn has no reply keeps its first message as the second line, and a second line Codex could not give is asked for again', async () => {
  const service = fakeService({ threads: [thread(1), thread(2)], replies: { [id(1)]: null }, fail: {} });
  const { listed } = make({ service });
  await listed.refresh();
  assert.equal(listed.rows()[0].preview, 'first message of chat 1');
  assert.equal(service.asked.length, 2);
  await listed.refresh();
  assert.equal(service.asked.length, 2, 'asked once: there was simply no reply');

  const flaky = fakeService({ threads: [thread(1)], fail: { call: true } });
  const b = make({ service: flaky });
  await b.listed.refresh();
  await b.listed.refresh();
  assert.equal(flaky.asked.length, 2, 'a failed ask is tried again at the next catch-up');
});

test('the caller says which chats need no second line: Canopy\'s own rows have theirs', async () => {
  const service = fakeService({ threads: [thread(1), thread(2)] });
  const { listed } = make({ service });
  await listed.refresh({ skip: (x) => x === id(1) });
  assert.deepEqual(service.asked.map((a) => a.params.threadId), [id(2)]);
  assert.deepEqual(listed.rows(undefined, { skip: (x) => x === id(2) }).map((r) => r.id), [id(1)], 'and which rows to leave out');
});

// ---- remembering ----

test('the list is saved: straight after a restart a listed chat is known, before anything is asked of Codex', async () => {
  const first = make({ service: fakeService({ threads: [thread(1, { title: 'From the Codex app' }), thread(2, { cwd: `${HOME}/Documents/Codex/x` })] }) });
  await first.listed.refresh();
  assert.deepEqual(Object.keys(first.state.codexListed), [id(1), id(2)]);
  assert.deepEqual(Object.keys(first.state.codexListed[id(1)]).sort(), ['branch', 'createdAt', 'cwd', 'dir', 'firstLine', 'lastLine', 'lineFor', 'source', 'title', 'updatedAt']);

  const silent = fakeService();
  const again = make({ service: silent, saved: first.state.codexListed });
  assert.equal(again.listed.has(id(1)), true);
  assert.equal(again.listed.has(id(2)), true);
  assert.equal(again.listed.has('a-claude-chat'), false);
  assert.equal(again.listed.rows([PROJECT])[0].title, 'From the Codex app');
  assert.equal(again.listed.folderOf(id(2)), `${HOME}/Documents/Codex/x`);
  assert.equal(silent.lists.length, 0, 'memory only');
  // That is what opens it on Codex: a chat restored as the last one open is never handed to Claude Code.
  assert.equal(engineFor({ resume: id(1), engine: 'claude', has: (x) => again.listed.has(x), codexPath: null }), 'codex');
});

test('an unreadable saved list is an empty one, and a failing save never reaches the caller', async () => {
  for (const saved of [null, 'nope', [1, 2], { a: 'x', b: null, c: { title: 'no folder' } }]) {
    const { listed } = make({ saved });
    assert.equal(listed.size, 0);
    assert.deepEqual(listed.rows(), []);
  }
  const listed = new CodexListed({ load: () => { throw new Error('disk'); }, save: () => { throw new Error('disk'); }, service: fakeService({ threads: [thread(1)] }), folders: () => [PROJECT], home: HOME, realpath });
  assert.equal(listed.has(id(1)), false);
  assert.equal(await listed.refresh(), true);
  assert.equal(listed.rows().length, 1);
  const rejecting = new CodexListed({ load: () => null, save: async () => { throw new Error('disk'); }, service: fakeService({ threads: [thread(1)] }), folders: () => { throw new Error('no state'); }, home: () => { throw new Error('no home'); }, realpath: async () => { throw new Error('gone'); } });
  assert.equal(await rejecting.refresh(), false, 'no folders to list for, and nothing thrown');
  assert.equal(await new CodexListed().refresh(), false, 'no Codex to ask');
});

// ---- catching up ----

test('a page Codex could not give changes nothing', async () => {
  const threads = Array.from({ length: 150 }, (_, i) => thread(i + 1));
  const service = fakeService({ threads });
  const { listed, box } = make({ service });
  await listed.refresh();
  assert.equal(listed.size, 150);
  const saves = box.saves;

  service.lists.length = 0;
  service.threads = [thread(1)];
  service.fail.list = true;
  assert.equal(await listed.refresh(), false);
  assert.equal(listed.size, 150, 'the whole list failing: kept as it was');
  service.fail.list = false;
  service.threads = threads.slice(0, 120);
  service.lists.length = 0;
  service.fail.page = 2;
  assert.equal(await listed.refresh(), false);
  assert.equal(listed.size, 150, 'the second page failing: not a list of only the first hundred');
  assert.equal(box.saves, saves, 'and nothing was saved');
});

test('Codex hands its list out a page at a time: every page is read, ten at most', async () => {
  const threads = Array.from({ length: 1250 }, (_, i) => thread(i + 1, { cwd: i < 1000 ? '/tmp/elsewhere' : '/private/tmp/proj' }));
  const service = fakeService({ threads, fail: { call: true } });
  const { listed } = make({ service });
  await listed.refresh();
  assert.equal(service.lists.length, 10, 'the newest 1,000 chats');
  assert.deepEqual(service.lists.map((o) => o.cursor), [undefined, '100', '200', '300', '400', '500', '600', '700', '800', '900']);
  assert.equal(listed.size, 0, 'the project\'s chats were all older than that');
});

test(`only the newest ${CODEX_LISTED_MAX} chats in your folders are kept`, async () => {
  const threads = Array.from({ length: 700 }, (_, i) => thread(i + 1));
  const { listed, state } = make({ service: fakeService({ threads, fail: { call: true } }) });
  await listed.refresh();
  assert.equal(CODEX_LISTED_MAX, 500);
  assert.equal(listed.size, 500);
  assert.equal(Object.keys(state.codexListed).length, 500);
  assert.equal(listed.has(id(500)), true);
  assert.equal(listed.has(id(501)), false, 'Codex lists newest first: the oldest fall off');
});

test('this is Codex\'s list: a chat that leaves it leaves the rows at the next catch-up', async () => {
  const service = fakeService({ threads: [thread(1), thread(2)] });
  const { listed, box } = make({ service });
  await listed.refresh();
  const changes = box.changes;
  service.threads = [thread(2)]; // archived or deleted in the Codex app
  assert.equal(await listed.refresh(), true);
  assert.deepEqual(listed.rows().map((r) => r.id), [id(2)]);
  assert.equal(listed.has(id(1)), false);
  assert.equal(box.changes > changes, true, 'the sidebar is told');
  const quiet = box.changes;
  assert.equal(await listed.refresh(), false);
  assert.equal(box.changes, quiet, 'and not told when nothing changed');
});

// ---- together with Canopy's own chats ----

test('one question for main: a chat Codex lists is a Codex chat too', async () => {
  const b = both({ service: fakeService({ threads: [thread(1, { title: 'From the terminal', source: 'cli' })] }), savedOwn: { [id(9)]: { cwd: PROJECT, title: 'Started here', createdAt: T0 - 500, lastPromptAt: T0 - 400 } } });
  assert.equal(b.chats.has(id(1)), false);
  await b.chats.refresh();
  assert.equal(b.chats.has(id(1)), true);
  assert.equal(b.chats.has(id(9)), true);
  assert.equal(b.chats.has('a-claude-chat'), false);
  assert.equal(b.chats.titleOf(id(1)), 'From the terminal');
  assert.equal(b.chats.titleOf(id(9)), 'Started here');
  assert.equal(b.chats.get(id(1)), null, 'no entry of Canopy\'s own yet');
  assert.deepEqual(b.chats.rows([PROJECT], { chatsDir: CHATS }).map((r) => [r.id, r.title]), [[id(9), 'Started here'], [id(1), 'From the terminal']]);
});

test('a chat in both lists is shown once, as Canopy\'s own row: it knows when you last wrote', async () => {
  const savedOwn = { [id(1)]: { cwd: PROJECT, title: 'Named in Canopy', preview: 'Canopy saw this reply', createdAt: T0 - 9000, lastPromptAt: T0 - 7000 } };
  const service = fakeService({ threads: [thread(1, { title: 'Named in Codex', updatedAt: T0 - 10 }), thread(2)] });
  const b = both({ service, savedOwn });
  await b.chats.refresh();
  const rows = b.chats.rows([PROJECT], { chatsDir: CHATS });
  assert.deepEqual(rows.map((r) => r.id), [id(1), id(2)]);
  assert.deepEqual([rows[0].title, rows[0].preview, rows[0].updated], ['Named in Canopy', 'Canopy saw this reply', T0 - 7000]);
  assert.deepEqual(service.asked.map((a) => a.params.threadId), [id(2)], 'and its second line is not asked for twice');
});

test('the catch-up runs with no chat of Canopy\'s own, at most once a minute, and at once when your projects change', async () => {
  const service = fakeService({ threads: [thread(1), thread(2, { cwd: '/tmp/other' })] });
  const b = both({ service });
  assert.deepEqual(b.chats.rows([PROJECT], { chatsDir: CHATS }), [], 'the sidebar never waits');
  await until(() => !b.chats.refreshing && service.lists.length === 1, 2000, 'the first catch-up');
  assert.equal(service.lists[0].sourceKinds.length, 3, 'only Codex\'s list was read: there is nothing of Canopy\'s own to check');
  assert.equal(b.box.changes > 0, true, 'the sidebar hears about the rows');
  assert.deepEqual(b.chats.rows([PROJECT], { chatsDir: CHATS }).map((r) => r.id), [id(1)]);
  b.box.clock += 30_000;
  b.chats.rows([PROJECT], { chatsDir: CHATS });
  await sleep(20);
  assert.equal(service.lists.length, 1, 'not again within the minute');

  b.box.folders = [PROJECT, '/tmp/other']; // a project was added
  b.chats.rows([PROJECT, '/tmp/other'], { chatsDir: CHATS });
  await until(() => !b.chats.refreshing && service.lists.length === 2, 2000, 'the catch-up for the new project');
  assert.deepEqual(b.chats.rows([PROJECT, '/tmp/other'], { chatsDir: CHATS }).map((r) => r.id), [id(1), id(2)]);

  b.box.clock += 61_000;
  b.chats.rows([PROJECT, '/tmp/other'], { chatsDir: CHATS });
  await until(() => !b.chats.refreshing && service.lists.length === 3, 2000, 'the next minute\'s catch-up');
});

test('Codex is never asked while it is not installed, and Canopy\'s own chats are still checked as before', async () => {
  const service = fakeService({ threads: [thread(1)] });
  const state = {};
  const chats = new CodexChats({ load: () => state.own, save: (l) => { state.own = l; }, service, installed: () => false, now: () => T0 });
  chats.listFrom(new CodexListed({ load: () => null, save: () => {}, service, folders: () => [PROJECT], home: HOME, realpath }));
  chats.rows([PROJECT]);
  await sleep(20);
  assert.equal(service.lists.length, 0);

  const own = { [id(9)]: { cwd: PROJECT, title: 'Started here', createdAt: T0 - 3_600_000, lastPromptAt: T0 - 3_600_000 } };
  const b = both({ service: fakeService({ threads: [thread(1)] }), savedOwn: own });
  await b.chats.refresh();
  assert.deepEqual(b.service.lists.map((o) => [o.sourceKinds?.length ?? 0, o.archived === true]), [[0, false], [0, true], [3, false]], 'Canopy\'s own first (the list, then the archive for the one not in it), then Codex\'s');
  assert.equal(b.service.reads, 1, 'the chat Codex does not list is looked up, as it always was');
  assert.equal(b.chats.rows([PROJECT]).length, 2);
});

test('a listed chat opened in Canopy becomes one of its own: same name, same second line, same place in the sidebar', async () => {
  const service = fakeService({ threads: [thread(1, { title: 'Importer bug', updatedAt: T0 - 86_400_000 }), thread(2, { updatedAt: T0 - 1000 })] });
  const b = both({ service });
  await b.chats.refresh();
  const before = b.chats.rows([PROJECT], { chatsDir: CHATS });
  assert.deepEqual(before.map((r) => r.id), [id(1), id(2)]);

  // It is opened: its process resumes the thread and says `init`.
  b.box.clock = T0 + 5000;
  b.chats.onEvent({ kind: 'init', sessionId: id(1), engine: 'codex', cwd: '/private/tmp/proj', createdAt: T0 - 90_000_000, name: 'Importer bug' }, { sessionId: id(1), cwd: PROJECT, title: 'Importer bug' }, { cwd: PROJECT });
  assert.deepEqual(b.chats.get(id(1)), { cwd: PROJECT, title: 'Importer bug', preview: 'reply in 001', createdAt: T0 - 90_000_000, lastPromptAt: T0 - 86_400_000, model: null });
  const after = b.chats.rows([PROJECT], { chatsDir: CHATS });
  assert.deepEqual(after.map((r) => [r.id, r.title, r.preview, r.updated]), [[id(1), 'Importer bug', 'reply in 001', T0 - 86_400_000], [id(2), 'first message of chat 2', 'reply in 002', T0 - 1000]], 'opening a chat never moves it up the sidebar');

  // You write in it: from now on its "updated" is when you last wrote.
  b.box.clock = T0 + 9000;
  b.chats.onEvent({ kind: 'message-start', sessionId: id(1) }, { sessionId: id(1), cwd: PROJECT });
  assert.equal(b.chats.rows([PROJECT]).find((r) => r.id === id(1)).updated, T0 + 9000);
});

test('a chat with no project keeps its own folder once it is Canopy\'s own, and stays under Chats', async () => {
  const own = `${HOME}/Documents/Codex/2026-11-16-plan-a-trip`;
  const b = both({ service: fakeService({ threads: [thread(1, { cwd: own, branch: null })] }) });
  await b.chats.refresh();
  assert.equal(b.chats.folderOf(id(1)), own, 'before it is opened: from Codex\'s list');
  assert.equal(b.chats.folderOf('a-new-chat'), null);
  assert.equal(b.chats.folderOf(null), null);

  // The window opened it under Chats (that is the folder ChatHost knows); the process runs in the chat's own folder.
  b.chats.onEvent({ kind: 'init', sessionId: id(1), engine: 'codex', cwd: own }, { sessionId: id(1), cwd: CHATS, title: null }, { cwd: own });
  assert.equal(b.chats.get(id(1)).cwd, own);
  assert.equal(b.chats.get(id(1)).loose, true);
  assert.equal(b.chats.folderOf(id(1)), own, 'after: from Canopy\'s own list');
  assert.deepEqual(b.chats.rows([PROJECT, CHATS], { chatsDir: CHATS }).map((r) => [r.id, r.cwd, r.loose]), [[id(1), CHATS, true]]);
  assert.deepEqual(b.chats.rows([PROJECT], { chatsDir: CHATS }), []);

  // After a restart, with Codex's list gone quiet, it is still there and still opens in its folder.
  const again = both({ service: fakeService({ fail: { list: true } }), savedOwn: b.state.codexChats, savedListed: {} });
  assert.equal(again.chats.folderOf(id(1)), own);
  assert.deepEqual(again.chats.rows(undefined, { chatsDir: CHATS }).map((r) => [r.cwd, r.loose]), [[CHATS, true]]);
});

test('renaming a listed chat: the row has the name at once and Codex is told', async () => {
  const service = fakeService({ threads: [thread(1)] });
  const b = both({ service });
  await b.chats.refresh();
  const r = await b.chats.rename(id(1), '  Trip   plan ');
  assert.deepEqual(r, { ok: true, via: 'service' });
  assert.deepEqual(service.renames, [[id(1), 'Trip plan']]);
  assert.equal(b.chats.rows([PROJECT])[0].title, 'Trip plan');
  assert.equal(b.chats.titleOf(id(1)), 'Trip plan');
  assert.equal(b.listed.setTitle('not-listed', 'x'), false);
  assert.equal(b.listed.setTitle(id(1), '   '), false);
});

test('without a list of Codex\'s, CodexChats is what it was: only Canopy\'s own chats', () => {
  const state = { own: { [id(9)]: { cwd: PROJECT, title: 'Started here', createdAt: T0, lastPromptAt: T0 } } };
  const chats = new CodexChats({ load: () => state.own, save: () => {}, now: () => T0 });
  assert.equal(chats.listFrom(null), chats);
  assert.equal(chats.listFrom({ nope: true }), chats, 'not a list: ignored');
  assert.equal(chats.listed, null);
  assert.equal(chats.has(id(1)), false);
  assert.equal(chats.folderOf(id(9)), null);
  assert.deepEqual(chats.rows([PROJECT]), [{ id: id(9), title: 'Started here', updated: T0, branch: null, cwd: PROJECT, preview: null, engine: 'codex' }]);
  assert.deepEqual(chats.rows([PROJECT], { chatsDir: CHATS }), chats.rows([PROJECT]), 'the Chats folder changes nothing for a chat with a project');
});

// ---- on the wire ----

const open = [];
after(async () => { await Promise.all(open.map((s) => s.close({ graceMs: 100 }).catch(() => {}))); });
function realService(fake) {
  const s = new CodexService({ codexPath: '/fake/codex', env: { PATH: '/usr/bin', HOME: '/tmp' }, spawnFn: fake.spawnFn, timeouts: { init: 1000, request: 1000, list: 1000, history: 1000 } });
  open.push(s);
  return s;
}

test('on the wire: the three sources go out with the quick list, and a sub-agent\'s thread is told apart by its source', async () => {
  const fake = createFakeCodex({ threads: [
    { id: id(1), cwd: '/private/tmp/proj', name: null, preview: 'hello there', createdAt: 1794801559, updatedAt: 1794801562, source: 'cli', gitInfo: { branch: 'main' } },
    { id: id(2), cwd: '/private/tmp/proj', name: null, preview: 'a helper', createdAt: 1794801559, updatedAt: 1794801561, source: { subAgent: { thread_spawn: { parent_thread_id: id(1) } } } },
    { id: id(3), cwd: '/private/tmp/proj', name: null, preview: 'custom', createdAt: 1794801559, updatedAt: 1794801560, source: { custom: 'my-tool' } },
  ] });
  const service = realService(fake);
  const r = await service.listThreads({ sourceKinds: ['cli', 'vscode', 'appServer', '', 7] });
  // Every model provider's chats are asked for (the empty list), as for every list: left to itself Codex gives only
  // those of the provider the helper runs on.
  assert.deepEqual(fake.sent('thread/list')[0].params, { limit: 100, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true, modelProviders: [] });
  assert.deepEqual(r.threads.map((t) => t.source), ['cli', 'subAgent', 'custom']);
  await service.listThreads({ sourceKinds: [] });
  assert.equal('sourceKinds' in fake.sent('thread/list')[1].params, false, 'none given: Codex\'s own choice, as before');

  const listed = new CodexListed({ load: () => null, save: () => {}, service, folders: () => [PROJECT], home: HOME, realpath });
  await listed.refresh();
  assert.deepEqual(listed.rows().map((x) => [x.id, x.updated, x.preview]), [[id(1), 1794801562000, 'hello there']], 'only the terminal\'s chat is listed');
});

test('on the wire: the second line comes from the newest turn\'s final answer', async () => {
  const fake = createFakeCodex({
    threads: [{ id: id(1), cwd: '/private/tmp/proj', name: 'Recorded', preview: 'Reply with exactly: OK', createdAt: 1794801559, updatedAt: 1794801562, source: 'vscode' }],
    handlers: { 'thread/turns/list': (params) => (params.itemsView === 'summary' && params.limit === 1 ? { data: [turn('Thinking about it.', 'OK')], nextCursor: null } : undefined) },
  });
  const listed = new CodexListed({ load: () => null, save: () => {}, service: realService(fake), folders: () => [PROJECT], home: HOME, realpath });
  await listed.refresh();
  assert.deepEqual(fake.sent('thread/turns/list')[0].params, { threadId: id(1), limit: 1, sortDirection: 'desc', itemsView: 'summary' });
  assert.deepEqual(listed.rows().map((x) => [x.title, x.preview]), [['Recorded', 'OK']]);
});

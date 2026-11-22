// The host side of moving a chat (src/handoffs.mjs), in a temp folder: the two files, the pending record that
// becomes a saved link when the new chat gets its id, the "Continued…" lines, what a session is created with, and a
// whole move through the real ChatHost with a scripted Codex. Nothing under ~/.claude or ~/.codex is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep } from '../helpers.mjs';
import { Handoffs, HANDOFF_FOLDERS_MAX, MOVE_BUSY, MOVE_EMPTY, MOVE_FAILED, sessionTitle } from '../../../handoffs.mjs';
import { ChatHost } from '../../../chats.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { HANDOFF_OPEN, forClaude, isHandoffText, tokensOf } from '../../handoff.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-handoffs-')));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = '0f000000-0000-7000-8000-00000000abcd';
const HISTORY = [
  { kind: 'user-text', text: 'Rename the helper and update its two callers.', at: 1 },
  { kind: 'tool-start', id: 'e1', name: 'Edit', input: { file_path: `${work}/src/a.ts`, old_string: 'a', new_string: 'b' } },
  { kind: 'tool-result', id: 'e1', content: 'ok', isError: false },
  { kind: 'tool-start', id: 'b1', name: 'Bash', input: { command: 'npm test' } },
  { kind: 'tool-result', id: 'b1', content: 'ok', isError: false },
  { kind: 'assistant-text', text: 'Done. The helper is now readRows.', at: 2 },
];
const MOVE = { from: OLD, fromModel: 'Opus 5.5', toModel: 'GPT-6.1-Sol' };

let n = 0;
function make(opts = {}) {
  const dir = path.join(root, `data-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const state = { links: opts.links ?? undefined, saves: 0, renames: [], changes: 0, logs: [] };
  let clock = opts.at ?? 1794800000000;
  const h = new Handoffs({
    load: () => state.links, save: (l) => { state.links = l; state.saves += 1; },
    dir, historyOf: async () => opts.history ?? HISTORY,
    chatOf: async () => opts.chat ?? { engine: 'claude', title: 'Rename the helper' },
    gitState: async () => (opts.git === undefined ? { branch: 'main', status: ' M src/a.ts' } : opts.git),
    rename: (chat, title) => { state.renames.push([chat, title]); },
    onChange: () => { state.changes += 1; },
    log: (m) => state.logs.push(m), now: () => (clock += 1000),
    ...opts.with,
  });
  return { h, dir, state };
}
const about = (extra = {}) => ({ cwd: work, busy: false, mode: 'acceptEdits', toEngine: 'codex', ...extra });
const modeOf = (p) => fs.statSync(p).mode & 0o777;

test('a busy chat is refused, and nothing is written', async () => {
  const { h, dir } = make();
  assert.deepEqual(await h.prepare(MOVE, about({ busy: true })), { ok: false, message: MOVE_BUSY });
  assert.equal(MOVE_BUSY, 'Wait for this chat to finish, then move it.');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a chat with nothing in it, one that cannot be read, and a move that names no chat are refused', async () => {
  assert.deepEqual(await make({ history: [] }).h.prepare(MOVE, about()), { ok: false, message: MOVE_EMPTY });
  assert.deepEqual(await make({ history: [{ kind: 'notice', level: 'warn', text: 'Could not load history: gone' }] }).h.prepare(MOVE, about()), { ok: false, message: MOVE_FAILED });
  assert.deepEqual(await make().h.prepare({ fromModel: 'x' }, about()), { ok: false, message: MOVE_FAILED });
  assert.deepEqual(await make().h.prepare(null, about()), { ok: false, message: MOVE_FAILED });
  assert.deepEqual(await make().h.prepare(MOVE, {}), { ok: false, message: MOVE_FAILED });
  const thrower = make({ with: { historyOf: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await thrower.h.prepare(MOVE, about()), { ok: false, message: MOVE_FAILED }, 'never throws');
  assert.match(thrower.state.logs[0], /boom/);
});

test('the two files exist with the right modes, under a key made of the time and the old chat\'s id', async () => {
  const { h, dir } = make();
  const r = await h.prepare(MOVE, about());
  assert.equal(r.ok, true);
  assert.match(r.key, /^[0-9a-z]+-11111111$/);
  assert.equal(r.key.split('-')[0], (1794800001000).toString(36));
  const folder = path.join(dir, r.key);
  assert.equal(modeOf(folder), 0o700);
  assert.equal(modeOf(path.join(folder, 'digest.md')), 0o600);
  assert.equal(modeOf(path.join(folder, 'transcript.md')), 0o600);
  const digest = fs.readFileSync(path.join(folder, 'digest.md'), 'utf8');
  assert.ok(digest.startsWith(HANDOFF_OPEN));
  assert.match(digest, /ran on Opus 5\.5/);
  assert.ok(digest.includes(`The full transcript is at ${path.join(folder, 'transcript.md')}`));
  assert.match(digest, /## Files changed\n- src\/a\.ts \(\+1 -1\)/);
  assert.match(digest, /Folder: .*work\. Branch: main\. Uncommitted: 1 file \(M src\/a\.ts\)\.\nMode: Accept edits\./);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  assert.match(transcript, /^# Rename the helper\n/);
  assert.match(transcript, /## Turn 1/);
  assert.match(transcript, /#### Ran npm test/);
});

test('a folder that is not a repo says nothing about git, and a mode only Claude Code has is carried as Ask', async () => {
  const { h, dir } = make({ git: null });
  const r = await h.prepare(MOVE, about({ mode: 'dontAsk' }));
  const digest = fs.readFileSync(path.join(dir, r.key, 'digest.md'), 'utf8');
  assert.doesNotMatch(digest, /Branch|Uncommitted/);
  assert.match(digest, /Mode: Ask before edits\./);
});

test('sessionOpts: a chat being moved into, a moved chat reopened, and any other chat', async () => {
  const { h, dir, state } = make();
  const r = await h.prepare(MOVE, about());
  const folder = path.join(dir, r.key);
  const fresh = h.sessionOpts({ cwd: work, resume: null, engine: 'codex', handoffKey: r.key });
  assert.deepEqual(Object.keys(fresh).sort(), ['additionalDirectories', 'handoff', 'title']);
  assert.ok(isHandoffText(fresh.handoff.text));
  assert.deepEqual(fresh.additionalDirectories, [folder]);
  assert.equal(fresh.title, 'Rename the helper');
  assert.deepEqual(h.sessionOpts({ cwd: work, resume: null }), {}, 'a new chat that is not a move');
  assert.deepEqual(h.sessionOpts({ cwd: work, resume: null, handoffKey: 'nope' }), {}, 'a key nobody prepared');
  assert.deepEqual(h.sessionOpts({ cwd: work, resume: 'unrelated' }), {});
  assert.deepEqual(h.sessionOpts(null), {});
  // Once the link is saved, the reopened chat gets the folder alone: it has had its digest.
  h.bind(r.key, 'sid-1');
  h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: NEW }, { engine: 'codex' });
  assert.deepEqual(h.sessionOpts({ cwd: work, resume: NEW }), { additionalDirectories: [folder] });
  fs.rmSync(folder, { recursive: true });
  assert.deepEqual(h.sessionOpts({ cwd: work, resume: NEW }), {}, 'a folder that has been cleared away is not handed on');
  assert.equal(state.saves, 1);
});

test('the pending record becomes a saved link on init, and the new chat takes the old chat\'s name', async () => {
  const moves = [];
  const { h, state } = make({ with: { onMoved: (record, id) => moves.push([record.from.id, record.to.model, id]) } });
  const r = await h.prepare(MOVE, about());
  assert.equal(state.links, undefined, 'nothing is saved until the new chat has an id');
  assert.equal(h.bind(r.key, 'sid-1'), true);
  h.onEvent({ kind: 'init', sid: 'sid-other', sessionId: 'someone-else' }, {});
  h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: null }, {});
  h.onEvent({ kind: 'busy', sid: 'sid-1', sessionId: NEW }, {});
  assert.equal(state.links, undefined, 'only this chat\'s init with an id counts');
  h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: NEW }, { engine: 'codex' });
  assert.deepEqual(state.links, {
    [NEW]: {
      from: { id: OLD, engine: 'claude', title: 'Rename the helper', model: 'Opus 5.5' }, to: { engine: 'codex', model: 'GPT-6.1-Sol' },
      cwd: work, at: 1794800001000, key: r.key, tokens: state.links[NEW].tokens, counts: { requests: 1, files: 1, commands: 1 },
    },
  });
  assert.ok(state.links[NEW].tokens > 50);
  await sleep(5);
  assert.deepEqual(state.renames, [[{ id: NEW, engine: 'codex', cwd: work, sid: 'sid-1' }, 'Rename the helper']]);
  assert.equal(state.changes, 1);
  assert.deepEqual(moves, [[OLD, 'GPT-6.1-Sol', NEW]], 'the host hears that the move took effect');
  h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: NEW }, { engine: 'codex' });
  assert.equal(state.saves, 1, 'a later init (every turn has one) changes nothing');
  assert.equal(moves.length, 1, 'and is not told twice');
});

test('a chat let go before its first message takes its pending record with it', async () => {
  const { h, state } = make();
  const r = await h.prepare(MOVE, about());
  h.bind(r.key, 'sid-1');
  assert.equal(h.forget('sid-1'), true);
  assert.equal(h.forget('sid-1'), false);
  h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: NEW }, {});
  assert.equal(state.links, undefined);
  assert.deepEqual(await h.notes({ sessionId: null, sid: 'sid-1' }, []), []);
  assert.deepEqual(h.sessionOpts({ handoffKey: r.key }), {});
});

test('notes: "from" first and "to" last, before the first message and after a reload', async () => {
  const { h, dir, state } = make();
  const r = await h.prepare(MOVE, about());
  h.bind(r.key, 'sid-1');
  const file = path.join(dir, r.key, 'transcript.md');

  // Before the first message the new chat has no id: its line comes by the open chat's own id, again and again.
  for (let i = 0; i < 2; i++) {
    const before = await h.notes({ sessionId: null, sid: 'sid-1' }, []);
    assert.equal(before.length, 1);
    const from = before[0];
    assert.deepEqual([from.kind, from.dir, from.model, from.toModel, from.file, from.at], ['handoff', 'from', 'Opus 5.5', 'GPT-6.1-Sol', file, 1794800001000]);
    assert.deepEqual(from.chat, { id: OLD, title: 'Rename the helper', cwd: work, engine: 'claude' });
    assert.ok(isHandoffText(from.digest));
    assert.equal(from.tokens, tokensOf(from.digest));
  }
  assert.deepEqual(await h.notes({ sessionId: OLD }, HISTORY), HISTORY, 'the old chat says nothing until the new one has a message');
  assert.deepEqual(await h.notes({ sessionId: null, sid: 'another' }, []), [], 'a new chat that is not a move has no line');

  h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: NEW }, { engine: 'codex' });
  const turn = [{ kind: 'user-text', text: 'carry on' }, { kind: 'assistant-text', text: 'OK' }];
  const after = await h.notes({ sessionId: NEW, sid: 'sid-1' }, turn);
  assert.deepEqual(after.map((e) => e.kind), ['handoff', 'user-text', 'assistant-text']);
  assert.equal(after[0].dir, 'from');

  const old = await h.notes({ sessionId: OLD }, HISTORY);
  assert.equal(old.length, HISTORY.length + 1);
  assert.deepEqual(old.at(-1), { kind: 'handoff', dir: 'to', chat: { id: NEW, title: 'Rename the helper', cwd: work, engine: 'codex' }, model: 'GPT-6.1-Sol', at: 1794800001000 });
  assert.deepEqual(old.slice(0, -1), HISTORY);

  // A new Handoffs over the same saved links and folder (the app restarted): the digest is read back from its file.
  const again = new Handoffs({ load: () => state.links, save: () => {}, dir });
  const reread = await again.notes({ sessionId: NEW }, turn);
  assert.equal(reread[0].digest, after[0].digest);
  assert.equal(reread[0].file, file);
  // Its files cleared away since: the line is still there, with nothing to open.
  fs.rmSync(path.join(dir, r.key), { recursive: true });
  const bare = await new Handoffs({ load: () => state.links, save: () => {}, dir }).notes({ sessionId: NEW }, turn);
  assert.deepEqual([bare[0].dir, bare[0].digest, bare[0].file, bare[0].tokens], ['from', '', null, state.links[NEW].tokens]);
});

test('a chat moved on twice has two "Continued in" lines, oldest first; a chat can be both moved into and moved on', async () => {
  const { h } = make();
  const a = await h.prepare(MOVE, about());
  h.bind(a.key, 'sid-a'); h.onEvent({ kind: 'init', sid: 'sid-a', sessionId: 'chat-b' }, {});
  const b = await h.prepare({ ...MOVE, toModel: 'GPT-6.1-Astra' }, about());
  h.bind(b.key, 'sid-b'); h.onEvent({ kind: 'init', sid: 'sid-b', sessionId: 'chat-c' }, {});
  const c = await h.prepare({ from: 'chat-b', fromModel: 'GPT-6.1-Sol', toModel: 'Fable 5.2' }, about({ toEngine: 'claude' }));
  h.bind(c.key, 'sid-c'); h.onEvent({ kind: 'init', sid: 'sid-c', sessionId: 'chat-d' }, {});
  const old = await h.notes({ sessionId: OLD }, []);
  assert.deepEqual(old.map((e) => [e.dir, e.chat.id, e.model]), [['to', 'chat-b', 'GPT-6.1-Sol'], ['to', 'chat-c', 'GPT-6.1-Astra']]);
  const middle = await h.notes({ sessionId: 'chat-b' }, [{ kind: 'user-text', text: 'x' }]);
  assert.deepEqual(middle.map((e) => e.dir ?? e.kind), ['from', 'user-text', 'to']);
  assert.equal(middle.at(-1).chat.engine, 'claude');
});

test('moving the same old chat again from a chat that never started replaces the pending move', async () => {
  const { h } = make();
  const a = await h.prepare(MOVE, about());
  h.bind(a.key, 'sid-1');
  const b = await h.prepare({ ...MOVE, toModel: 'Fable 5.2' }, about({ toEngine: 'claude' }));
  assert.notEqual(a.key, b.key);
  h.bind(b.key, 'sid-1'); // the same screen, a chat of the other maker
  assert.deepEqual(h.sessionOpts({ handoffKey: a.key }), {}, 'the move it replaced is forgotten');
  const line = await h.notes({ sessionId: null, sid: 'sid-1' }, []);
  assert.equal(line[0].toModel, 'Fable 5.2');
});

test('a conversation that starts over under a new id keeps its link', async () => {
  const { h, state } = make();
  const r = await h.prepare(MOVE, about({ toEngine: 'claude' }));
  h.bind(r.key, 'sid-1'); h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: 'first-id' }, { engine: 'claude' });
  // /clear starts a different conversation: the moved chat is still the old id.
  h.onEvent({ kind: 'meta', sid: 'sid-1', sessionId: 'cleared-id', previousSessionId: 'first-id' }, { engine: 'claude' });
  assert.deepEqual(Object.keys(state.links), ['first-id']);
  // Editing its first message replaces it.
  h.onEvent({ kind: 'meta', sid: 'sid-1', sessionId: 'second-id', previousSessionId: 'first-id', supersedes: 'first-id' }, { engine: 'claude' });
  assert.deepEqual(Object.keys(state.links), ['second-id']);
  assert.equal((await h.notes({ sessionId: OLD }, [])).at(-1).chat.id, 'second-id');
});

test('the newest 200 folders are kept, and never one a chat is still waiting to use', async () => {
  const { h, dir } = make();
  for (let i = 0; i < HANDOFF_FOLDERS_MAX + 5; i++) fs.mkdirSync(path.join(dir, `${(1000000000000 + i).toString(36)}-old${i}`));
  const first = await h.prepare(MOVE, about());
  const names = () => fs.readdirSync(dir).sort();
  // The clearing runs after the answer, one folder at a time: wait for it to finish, however busy the Mac is.
  for (let i = 0; i < 600 && names().length !== HANDOFF_FOLDERS_MAX; i++) await sleep(5);
  assert.equal(names().length, HANDOFF_FOLDERS_MAX);
  assert.ok(names().includes(first.key));
  assert.ok(!names().includes(`${(1000000000000).toString(36)}-old0`), 'the oldest went');
  assert.ok(names().includes(`${(1000000000000 + 204).toString(36)}-old204`));
});

test('the saved links are capped at the newest 500', async () => {
  const links = {};
  for (let i = 0; i < 520; i++) links[`chat-${i}`] = { from: { id: `old-${i}`, engine: 'claude', title: 't', model: 'm' }, to: { engine: 'codex', model: 'n' }, cwd: work, at: i, key: `k${i}` };
  const { h, state } = make({ links });
  const r = await h.prepare(MOVE, about());
  h.bind(r.key, 'sid-1'); h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: NEW }, {});
  assert.equal(Object.keys(state.links).length, 500);
  assert.ok(state.links[NEW]);
  assert.ok(!state.links['chat-0'] && state.links['chat-519']);
});

test('a moved chat\'s row is titled with its name, and never with the block its first message carried', () => {
  const block = forClaude(`${HANDOFF_OPEN}\nThis chat continues an earlier one…\n</canopy_handoff>`);
  assert.equal(sessionTitle({ customTitle: 'Rename the helper', summary: block, firstPrompt: block }), 'Rename the helper');
  assert.equal(sessionTitle({ summary: `${block}\ncarry on with the callers`, firstPrompt: block }), 'carry on with the callers');
  assert.equal(sessionTitle({ firstPrompt: `${block}\ncarry on` }), 'carry on');
  assert.equal(sessionTitle({ firstPrompt: block.slice(0, 80) }), 'Untitled chat', 'a block cut short before its end is all block');
  assert.equal(sessionTitle({ summary: 'A plain summary', firstPrompt: 'hello' }), 'A plain summary');
  assert.equal(sessionTitle({ firstPrompt: 'hello there' }), 'hello there');
  assert.equal(sessionTitle({}), 'Untitled chat');
  assert.equal(sessionTitle(null), 'Untitled chat');
});

test('nothing throws on junk', async () => {
  const h = new Handoffs();
  assert.deepEqual(await h.prepare(MOVE, about()), { ok: false, message: MOVE_FAILED });
  assert.deepEqual(h.sessionOpts(undefined), {});
  assert.equal(h.bind('x', 'y'), false);
  h.onEvent(null); h.onEvent({ kind: 'init' }); h.onEvent({ kind: 'meta', sessionId: 'a', previousSessionId: 'b' });
  assert.deepEqual(await h.notes(null, null), []);
  const bad = new Handoffs({ load: () => 'not a map', save: () => { throw new Error('disk full'); }, dir: path.join(root, 'nowhere') });
  assert.deepEqual(await bad.notes({ sessionId: 'x' }, [{ kind: 'user-text' }]), [{ kind: 'user-text' }]);
});

// ---- a whole move, wired the way src/main.mjs wires it ----

const open = [];
const fakes = [];
afterEach(async () => {
  for (const host of open.splice(0)) await host.manager.closeAll({ graceMs: 50 });
  assert.equal(fakes.splice(0).flatMap((f) => f.alive()).length, 0, 'every process a chat started is gone');
});

test('a Claude chat moved to OpenAI: one open, the digest ahead of the first turn, the link, the name, both lines', async () => {
  const fake = createFakeCodex();
  fakes.push(fake);
  fake.handlers['thread/inject_items'] = () => ({});
  const { h, state } = make();
  const sent = [];
  let host;
  host = new ChatHost({
    create: (o) => new CodexSession({ cwd: o.cwd, resume: o.resume, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: root }, spawnFn: fake.spawnFn, ...h.sessionOpts(o), timeouts: { restart: 15 } }),
    send: (channel, payload) => sent.push([channel, payload]),
    notify: () => {}, badge: () => {}, isFocused: () => true, isOnScreen: () => true,
    onEvent: (ev, entry) => h.onEvent(ev, entry), onStatus: () => {},
  });
  open.push(host);
  host.manager.on('closed', ({ sid }) => h.forget(sid));

  const moved = await h.prepare(MOVE, about());
  const r = await host.open(work, null, { engine: 'codex', handoffKey: moved.key });
  h.bind(moved.key, r.sid);
  assert.equal(r.session.sessionId, null, 'nothing is sent, and nothing is saved, until the first message');
  assert.equal(fake.received.length, 0, 'the move itself starts no process and calls no model');
  assert.equal((await h.notes({ sessionId: null, sid: r.sid }, []))[0].dir, 'from');

  r.session.send('carry on with the callers');
  for (let i = 0; i < 600 && !(state.links && !r.session.busy); i++) await sleep(5);
  const id = r.session.sessionId;
  assert.ok(id);
  assert.deepEqual(Object.keys(state.links), [id]);
  const calls = fake.received.filter((m) => ['thread/start', 'thread/inject_items', 'turn/start'].includes(m.method));
  assert.deepEqual(calls.map((m) => m.method), ['thread/start', 'thread/inject_items', 'turn/start']);
  assert.ok(isHandoffText(calls[1].params.items[0].content[0].text));
  assert.deepEqual(calls[2].params.input.filter((i) => i.type === 'text').map((i) => i.text), ['carry on with the callers']);
  await sleep(5);
  assert.deepEqual(state.renames.map(([chat, title]) => [chat.id, chat.engine, title]), [[id, 'codex', 'Rename the helper']]);
  assert.equal((await h.notes({ sessionId: OLD }, [])).at(-1).chat.id, id);
});

test('the chat that was moved on from is told so with its next message, if you go back to it', async () => {
  const fake = createFakeCodex({ known: [OLD] });
  fakes.push(fake);
  fake.handlers['thread/inject_items'] = () => ({});
  let host;
  // Wired the way src/main.mjs wires it: the old chat, if it is still open, gets a note.
  const { h } = make({ with: { onMoved: (rec) => { host.note(host.manager.find({ sessionId: rec.from.id })?.sid, { kind: 'moved', model: rec.to.model }); } } });
  host = new ChatHost({
    create: (o) => new CodexSession({ cwd: o.cwd, resume: o.resume, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: root }, spawnFn: fake.spawnFn, ...h.sessionOpts(o), timeouts: { restart: 15 } }),
    send: () => {}, notify: () => {}, badge: () => {}, isFocused: () => true, isOnScreen: () => true, onEvent: (ev, entry) => h.onEvent(ev, entry), onStatus: () => {},
  });
  open.push(host);
  host.manager.on('closed', ({ sid }) => h.forget(sid));
  const old = await host.open(work, OLD, { engine: 'codex' });

  const moved = await h.prepare(MOVE, about());
  const next = await host.open(work, null, { engine: 'codex', handoffKey: moved.key });
  h.bind(moved.key, next.sid);
  assert.equal(old.session.notes.size, 0, 'a move that has not been used yet tells nobody anything');
  next.session.send('carry on with the callers');
  for (let i = 0; i < 600 && (next.session.busy || !next.session.sessionId); i++) await sleep(5);
  assert.equal(old.session.notes.size, 1);
  assert.equal(next.session.notes.size, 0, 'the new chat has the digest; it is not told about itself');

  // You go back to the old chat.
  old.session.send('how did that go?');
  for (let i = 0; i < 600 && old.session.busy; i++) await sleep(5);
  const told = fake.received.filter((m) => m.method === 'thread/inject_items' && m.params.threadId === OLD);
  assert.deepEqual(told.map((m) => m.params.items[0].content[0].text), ['<canopy_note>\nThe user carried this conversation on in another chat (GPT-6.1-Sol). Work may have been done there since your last reply here: check the files before relying on what you remember of them.\n</canopy_note>']);
  old.session.send('thanks');
  for (let i = 0; i < 600 && old.session.busy; i++) await sleep(5);
  assert.equal(fake.received.filter((m) => m.method === 'thread/inject_items' && m.params.threadId === OLD).length, 1, 'once');
});

test('a move from a chat that is no longer open tells nobody, and nothing throws', async () => {
  const noted = [];
  const host = { manager: { find: () => null }, note: (sid, note) => { noted.push([sid, note]); return { ok: false, code: 'gone' }; } };
  const { h, state } = make({ with: { onMoved: (rec) => { host.note(host.manager.find({ sessionId: rec.from.id })?.sid, { kind: 'moved', model: rec.to.model }); } } });
  const r = await h.prepare(MOVE, about());
  h.bind(r.key, 'sid-1');
  h.onEvent({ kind: 'init', sid: 'sid-1', sessionId: NEW }, { engine: 'codex' });
  assert.deepEqual(noted, [[undefined, { kind: 'moved', model: 'GPT-6.1-Sol' }]]);
  assert.deepEqual(Object.keys(state.links), [NEW]);
  // A host whose onMoved throws does not stop the link from having been saved.
  const broken = make({ with: { onMoved: () => { throw new Error('boom'); } } });
  const b = await broken.h.prepare(MOVE, about());
  broken.h.bind(b.key, 'sid-2');
  broken.h.onEvent({ kind: 'init', sid: 'sid-2', sessionId: NEW }, { engine: 'codex' });
  assert.deepEqual(Object.keys(broken.state.links), [NEW]);
  assert.ok(broken.state.logs.some((l) => /boom/.test(l)));
});

test('a moved chat closed before its first message leaves nothing behind but its files', async () => {
  const fake = createFakeCodex();
  fakes.push(fake);
  const { h, state } = make();
  const host = new ChatHost({
    create: (o) => new CodexSession({ cwd: o.cwd, resume: o.resume, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: root }, spawnFn: fake.spawnFn, ...h.sessionOpts(o) }),
    send: () => {}, notify: () => {}, badge: () => {}, isFocused: () => true, isOnScreen: () => true, onEvent: (ev, entry) => h.onEvent(ev, entry), onStatus: () => {},
  });
  open.push(host);
  host.manager.on('closed', ({ sid }) => h.forget(sid));
  const moved = await h.prepare(MOVE, about());
  const r = await host.open(work, null, { engine: 'codex', handoffKey: moved.key });
  h.bind(moved.key, r.sid);
  await host.manager.close(r.sid, { graceMs: 50 });
  assert.equal(h.pending.size, 0);
  assert.equal(state.links, undefined);
});

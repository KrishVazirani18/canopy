// The engine tracker (src/telemetry/engine.mjs): what Canopy Telemetry learns from the chats' event stream.
// Three groups of cases:
//  - sequences written by hand in the shape core emits them, with a clock the test moves;
//  - the real thing: the recorded Claude Code and Codex sessions in fixtures/ and scripted turns, run through the
//    real Session, CodexSession and ChatHost, wired the way src/main.mjs wires the tracker. Nothing is started;
//  - what must never happen: content reaching track(), a throw reaching a chat, memory that only grows.
// Every props object any case hands to track() is checked against the schema on the spot and again at the end.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { createFakeCodex, fixtureLines, recordedIds } from '../fake-codex.mjs';
import { fixture, sleep } from '../helpers.mjs';
import { ChatHost, engineOf } from '../../../chats.mjs';
import { Session } from '../../session.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { createEngineTracker } from '../../../telemetry/engine.mjs';
import { EFFORTS, EVENTS, MODES, TOOL_KINDS, clean } from '../../../telemetry/schema.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-telemetry-engine-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const loose = path.join(root, 'userData', 'chats'); // where a chat with no project runs
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(loose, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

// Generous waits: they only run out when something is wrong, and this suite shares its Mac with other work.
const until = async (cond, ms = 15000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

// ---- what may be tracked ----

// Words that stand in for what a person wrote or read. They ride on every hand-written event below, in the fields
// that hold content in real ones, so a tracker that read one of those fields would be caught carrying it.
const SECRET = 'zebra-quartz-0451';
const PRIVATE = `${SECRET} /Users/somebody/Private Project/notes.md sk-live-${SECRET}`;
// The model ids the fakes and the recordings run on. A string prop that is not one of the schema's own enum words (a
// mode and an effort level are) has to be one of these: nothing else has a way in.
const MODELS = new Set(['claude-haiku-5-5', 'claude-haiku-fake', 'claude-opus-5-5', 'claude-sonnet-5', 'gpt-6.1-sol', 'gpt-6-luna']);

// Every string in the recordings long enough to be recognised (prompts, replies, commands, paths, tool output).
const leaves = (v, out = new Set()) => {
  if (typeof v === 'string') { if (v.length >= 12 && !MODELS.has(v)) out.add(v); } else if (v && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out);
  return out;
};
const CLAUDE_FIXTURES = ['live-tool-turn', 'live-interrupt', 'live-clear', 'live-local-command'];
const CODEX_FIXTURES = ['codex-text', 'codex-command-approval', 'codex-file-change-approval', 'codex-interrupt', 'codex-read-command'];
const CONTENT = leaves([CLAUDE_FIXTURES.map((n) => fixture(n)), CODEX_FIXTURES.map((n) => fixtureLines(n).map((l) => l.msg))]);
CONTENT.add(SECRET);
const said = (text) => { CONTENT.add(text); return text; }; // a message a test sends: it must not come back out

const everything = []; // every [event, props] any case tracked

// The scripted Claude Code (fake-query.mjs) runs a model nobody publishes. The tracker hands a model's id on as the
// engine named it, and the schema is what names it or doesn't: a made-up one leaves as 'other'.
const UNPUBLISHED = 'claude-haiku-fake';

function assertSafe(event, props) {
  assert.ok(Object.hasOwn(EVENTS, event), `${event} is in the catalog`);
  const sent = props.model === UNPUBLISHED ? { ...props, model: 'other' } : props;
  assert.deepEqual(clean(event, props), sent, `${event} passes the schema exactly as it was tracked`);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'string') continue;
    for (const text of CONTENT) assert.ok(!value.includes(text), `${event}.${key} carries content: ${value}`);
    const spec = EVENTS[event][key];
    if (Array.isArray(spec)) continue; // one of the schema's own words (clean kept it, so it is one)
    if (spec === 'model') assert.ok(MODELS.has(value), `${event}.${key} is not a model these tests run: ${value}`);
    else assert.fail(`${event}.${key} is free text: ${value}`);
  }
}

// What a telemetry core would be handed. Each list is what the tracker called, in order.
function sink() {
  const s = { tracked: [], milestones: [], errors: [], notes: [] };
  s.deps = {
    track: (event, props) => { assertSafe(event, props); s.tracked.push([event, props]); everything.push([event, props]); },
    milestone: (step) => s.milestones.push(step),
    error: (where, err) => s.errors.push([where, err]),
    noteSession: (engine, id) => s.notes.push([engine, id]),
  };
  s.of = (event) => s.tracked.filter(([e]) => e === event).map(([, p]) => p);
  s.names = () => s.tracked.map(([e]) => e);
  return s;
}

// ---- hand-written sequences ----

// A tracker with a clock the test moves, and chats described the way main describes them.
function rig(over = {}) {
  const r = { ...sink(), t: 1_000_000, visible: new Set(), editing: new Set(), chats: new Map() };
  r.tracker = createEngineTracker({
    ...r.deps,
    describe: (sid) => r.chats.get(sid) ?? null,
    isVisible: (sid) => r.visible.has(sid),
    isEditing: (sid) => r.editing.has(sid),
    now: () => r.t,
    ...over,
  });
  /** A chat as main would describe it: on screen and opened new unless said otherwise. `kind: null` leaves onOpen out. */
  r.open = (sid, { engine = 'claude', kind = 'new', model = null, mode = 'default', effort = null, hasFolder = true, visible = true } = {}) => {
    r.chats.set(sid, { engine, model, mode, effort, hasFolder });
    if (visible) r.visible.add(sid);
    if (kind) r.tracker.onOpen({ sid, kind });
  };
  /** One event, with the status row src/chats.mjs passes beside it (its title and last reply are content). */
  r.ev = (sid, kind, extra = {}) => r.tracker.onEvent({ sid, kind, seq: ++seq, ...extra }, { sid, engine: r.chats.get(sid)?.engine ?? 'claude', title: PRIVATE, last: PRIVATE, cwd: PRIVATE, sessionId: null });
  r.wait = (ms) => { r.t += ms; };
  return r;
}
let seq = 0;
let toolSeq = 0;

// Events in the shape core emits them, content fields filled in.
const busyOn = { busy: true, state: 'running', queued: 0, background: 0 };
const busyOff = { busy: false, state: 'idle', queued: 0, background: 0 };
const initOf = (sessionId, model) => ({ sessionId, model, cwd: PRIVATE, permissionMode: 'default', version: '2.1.322', tools: ['Bash'], slash: [], mcp: [] });
const tool = (name, extra = {}) => ({ id: `toolu_${++toolSeq}`, name, input: { command: PRIVATE, file_path: PRIVATE, content: PRIVATE, prompt: PRIVATE }, parent: null, uuid: randomUUID(), ...extra });
const ended = (extra = {}) => ({ subtype: 'success', isError: false, interrupted: false, durationMs: 4200, cost: 0.31, turns: 2, text: PRIVATE, errors: [], denials: [], sessionId: 'c-1', ...extra });

/** One whole turn as Claude Code plays it: busy, init, the reply, its tools, the end, idle. `ms` is how long it took. */
function turn(r, sid, { tools = [], end = {}, ms = 3000, model = 'claude-opus-5-5', sessionId = `conversation-of-${sid}` } = {}) {
  r.ev(sid, 'busy', { ...busyOn, state: 'starting' });
  r.ev(sid, 'init', initOf(sessionId, model));
  r.ev(sid, 'message-start', { model, messageId: 'msg_1' });
  r.ev(sid, 'text-delta', { text: PRIVATE, index: 0 });
  for (const t of tools) { r.ev(sid, 'tool-start', typeof t === 'string' ? tool(t) : t); r.ev(sid, 'tool-result', { id: 'x', content: PRIVATE, isError: false }); }
  r.ev(sid, 'assistant-text', { text: PRIVATE, model });
  r.wait(ms);
  r.ev(sid, 'turn-end', ended(end));
  r.ev(sid, 'busy', busyOff);
}

test('a normal turn: one reply_finished with how long it took, what it ran and how it ended', () => {
  const r = rig();
  r.open('a', { mode: 'acceptEdits', effort: 'high' });
  r.tracker.onSend({ sid: 'a', text: said('please tidy the sidebar spacing'), images: [] });
  turn(r, 'a', { tools: ['Bash', 'Read', 'Read', 'Edit', 'mcp__linear__create_issue', 'WebSearch', 'Task', 'AskUserQuestion', 'TodoWrite', 'SomethingNew'], ms: 12_340 });
  assert.deepEqual(r.names(), ['chat_started', 'message_sent', 'reply_finished']);
  assert.deepEqual(r.of('chat_started')[0], { engine: 'claude', model: 'claude-opus-5-5', mode: 'acceptEdits', effort: 'high', has_folder: true, kind: 'new' });
  assert.deepEqual(r.of('message_sent')[0], { engine: 'claude', model: 'claude-opus-5-5', length: 'short', images_n: 0, queued: false });
  assert.deepEqual(r.of('reply_finished')[0], {
    engine: 'claude', model: 'claude-opus-5-5', secs: 12.3, outcome: 'done', background: false,
    tools_n: 10, tools_bash: 1, tools_read: 2, tools_edit: 1, tools_mcp: 1, tools_web: 1, tools_agent: 1, tools_question: 1, tools_plan: 1, tools_other: 1,
  });
  for (const key of Object.keys(r.of('reply_finished')[0]).filter((k) => k.startsWith('tools_') && k !== 'tools_n')) assert.ok(TOOL_KINDS.includes(key.slice(6)));
  assert.deepEqual(r.milestones, ['first_chat', 'first_message', 'first_reply']);
  assert.deepEqual(r.errors, []);
});

test('a reply with no tools says so, and a kind of tool that did not run is left out rather than sent as zero', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'hi' });
  turn(r, 'a', { ms: 800 });
  assert.deepEqual(r.of('reply_finished')[0], { engine: 'claude', model: 'claude-opus-5-5', secs: 0.8, tools_n: 0, outcome: 'done', background: false });
});

test('a reply the person stopped is "stopped", and is not the first reply', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'count to four hundred' });
  turn(r, 'a', { tools: ['Bash'], end: { subtype: 'error_during_execution', interrupted: true, isError: false }, ms: 1500 });
  assert.deepEqual(r.of('reply_finished').map((p) => [p.outcome, p.secs, p.tools_n]), [['stopped', 1.5, 1]]);
  assert.deepEqual(r.milestones, ['first_chat', 'first_message'], 'a stopped reply is not a reply that arrived');
  turn(r, 'a');
  assert.deepEqual(r.milestones, ['first_chat', 'first_message', 'first_reply']);
});

test('a reply that failed is "error"', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'go' });
  turn(r, 'a', { end: { subtype: 'error_during_execution', isError: true, errors: [PRIVATE], errorCode: 'overloaded' } });
  assert.deepEqual(r.of('reply_finished').map((p) => p.outcome), ['error']);
  assert.deepEqual(r.milestones, ['first_chat', 'first_message']);
  assert.deepEqual(r.errors, [], 'a reply that failed is an outcome, not a broken chat');
});

test('a reply cut off so an edited message can be sent is not "stopped", and not a reply: the edited message\'s reply is', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'a long task' });
  // The reply is under way when the edit starts (src/chats.mjs marks the chat as being edited around all of this).
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.ev('a', 'tool-start', tool('Bash'));
  r.wait(2000);
  r.editing.add('a');
  r.ev('a', 'turn-end', ended({ interrupted: true, subtype: 'error_during_execution' }));
  r.ev('a', 'busy', busyOff);
  r.ev('a', 'stopped', { reason: 'stop', willRestart: false });
  r.ev('a', 'edit', { id: randomUUID(), messageId: randomUUID(), fresh: false, text: PRIVATE });
  assert.deepEqual(r.of('reply_finished'), [], 'the cut-off reply is not counted');
  // The edited message goes out and is answered.
  r.ev('a', 'busy', { ...busyOn, state: 'starting' });
  r.tracker.onSend({ sid: 'a', text: 'a different task' }); // main, once the edit went through
  r.editing.delete('a');
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.ev('a', 'tool-start', tool('Read'));
  r.wait(700);
  r.ev('a', 'turn-end', ended());
  r.ev('a', 'busy', busyOff);
  assert.deepEqual(r.of('reply_finished'), [{ engine: 'claude', model: 'claude-opus-5-5', secs: 0.7, tools_n: 1, tools_read: 1, outcome: 'done', background: false }],
    'only the edited message\'s own time and tools');
  assert.equal(r.of('message_sent').length, 2);
  // The same stop with no edit going on is the person stopping it.
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'turn-end', ended({ interrupted: true }));
  assert.equal(r.of('reply_finished').at(-1).outcome, 'stopped');
});

test('a turn closed on the engine\'s behalf, and a slash command Claude Code answered itself, are not replies', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'go' });
  // The process died mid-reply: core closes the turn itself (`synthetic`) and says what happened as an error.
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.ev('a', 'tool-start', tool('Bash'));
  r.ev('a', 'turn-end', { subtype: 'crashed', isError: true, interrupted: false, synthetic: true, text: '', errors: [PRIVATE], durationMs: 900 });
  r.ev('a', 'busy', busyOff);
  // The chat was closed mid-reply.
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'turn-end', { subtype: 'stopped', isError: false, interrupted: true, synthetic: true, text: '', errors: [] });
  r.ev('a', 'busy', busyOff);
  // /context: Claude Code prints it without asking the model.
  r.tracker.onSend({ sid: 'a', text: '/context' });
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.ev('a', 'turn-end', ended({ localCommand: 'context', turns: 0 }));
  r.ev('a', 'busy', busyOff);
  assert.deepEqual(r.of('reply_finished'), []);
  assert.deepEqual(r.milestones, ['first_chat', 'first_message']);
  // The next real reply starts clean: none of the tools above are counted in it.
  r.tracker.onSend({ sid: 'a', text: 'go on' });
  turn(r, 'a', { ms: 400 });
  assert.deepEqual(r.of('reply_finished'), [{ engine: 'claude', model: 'claude-opus-5-5', secs: 0.4, tools_n: 0, outcome: 'done', background: false }]);
});

test('tools an agent ran are its own work, not the reply\'s', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'look into it' });
  const task = tool('Task');
  turn(r, 'a', { tools: [task, tool('Read', { parent: task.id }), tool('Bash', { parent: task.id }), tool('Grep', { parent: task.id, agentId: 'agent-1' }), 'Edit'] });
  assert.deepEqual(r.of('reply_finished')[0], { engine: 'claude', model: 'claude-opus-5-5', secs: 3, tools_n: 2, tools_agent: 1, tools_edit: 1, outcome: 'done', background: false });
});

test('an agent still working after the reply ended does not start a reply of its own', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'start the helper' });
  turn(r, 'a', { tools: ['Task'] });
  for (let i = 0; i < 5; i++) r.ev('a', 'tool-start', tool('Bash', { parent: 'toolu_agent' }));
  r.wait(60_000);
  r.tracker.onSend({ sid: 'a', text: 'and now this' });
  turn(r, 'a', { ms: 1000 });
  assert.deepEqual(r.of('reply_finished').map((p) => [p.secs, p.tools_n]), [[3, 1], [1, 0]]);
});

test('two chats working at once are followed apart, each with its own time, tools, model and engine', () => {
  const r = rig();
  r.open('a', { engine: 'claude' });
  r.open('b', { engine: 'codex', visible: false, hasFolder: false, effort: 'low' });
  r.tracker.onSend({ sid: 'a', text: 'first chat' });
  r.ev('a', 'busy', busyOn);
  r.wait(1000);
  r.tracker.onSend({ sid: 'b', text: 'second chat', images: [{ mediaType: 'image/png', data: PRIVATE }] });
  r.ev('b', 'busy', busyOn);
  r.ev('a', 'init', initOf('c-a', 'claude-opus-5-5'));
  r.ev('b', 'init', { ...initOf('c-b', 'gpt-6.1-sol'), engine: 'codex' });
  r.ev('b', 'message-start', { model: 'gpt-6.1-sol' });
  r.ev('a', 'tool-start', tool('Bash'));
  r.ev('b', 'tool-start', tool('Edit'));
  r.ev('a', 'tool-start', tool('Bash'));
  r.ev('b', 'permission', { id: 7, type: 'tool', toolName: 'Edit', input: { file_path: PRIVATE }, engine: 'codex' });
  r.ev('a', 'permission', { id: 7, type: 'tool', toolName: 'Bash', input: { command: PRIVATE } }); // the same id in another chat
  r.tracker.onPermissionAnswer({ sid: 'b', id: 7, answer: { action: 'always' } });
  r.tracker.onPermissionAnswer({ sid: 'a', id: 7, answer: { action: 'deny', message: PRIVATE } });
  r.wait(4000);
  r.ev('b', 'turn-end', ended());
  r.ev('b', 'busy', busyOff);
  r.wait(5000);
  r.ev('a', 'turn-end', ended({ interrupted: true }));
  r.ev('a', 'busy', busyOff);
  assert.deepEqual(r.of('chat_started'), [
    { engine: 'claude', model: 'claude-opus-5-5', mode: 'default', has_folder: true, kind: 'new' },
    { engine: 'codex', model: 'gpt-6.1-sol', mode: 'default', effort: 'low', has_folder: false, kind: 'new' },
  ]);
  assert.deepEqual(r.of('message_sent').map((p) => [p.engine, p.images_n]), [['claude', 0], ['codex', 1]]);
  assert.deepEqual(r.of('permission_answered'), [{ engine: 'codex', tool_kind: 'edit', answer: 'always' }, { engine: 'claude', tool_kind: 'bash', answer: 'deny' }]);
  assert.deepEqual(r.of('reply_finished'), [
    { engine: 'codex', model: 'gpt-6.1-sol', secs: 4, tools_n: 1, tools_edit: 1, outcome: 'done', background: true },
    { engine: 'claude', model: 'claude-opus-5-5', secs: 10, tools_n: 2, tools_bash: 2, outcome: 'stopped', background: false },
  ]);
});

test('background is where the chat was when its reply ended, not when it started', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'go' });
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.visible.delete('a'); // the person switched to another chat
  r.ev('a', 'turn-end', ended());
  assert.equal(r.of('reply_finished')[0].background, true);
  // Nobody to ask whether it is on screen: the prop is left out, not guessed.
  const blind = rig({ isVisible: undefined });
  blind.open('a');
  turn(blind, 'a');
  assert.equal('background' in blind.of('reply_finished')[0], false);
});

// ---- messages ----

test('a message is measured and counted: short, medium or long, its images and files, queued or not', () => {
  const r = rig();
  r.open('a', { model: 'claude-opus-5-5' });
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5')); // the engine has said which model it runs
  r.tracker.onSend({ sid: 'a', text: 'x'.repeat(79) });
  r.tracker.onSend({ sid: 'a', text: 'x'.repeat(80), images: [{ mediaType: 'image/png', data: PRIVATE }, { mediaType: 'image/jpeg', data: PRIVATE }] });
  r.tracker.onSend({ sid: 'a', text: 'x'.repeat(1001), images: 3, files: [PRIVATE, PRIVATE], queued: true });
  r.tracker.onSend({ sid: 'a', text: '', images: [], files: 0 });
  r.tracker.onSend({ sid: 'a' }); // nothing said about it at all
  assert.deepEqual(r.of('message_sent'), [
    { engine: 'claude', model: 'claude-opus-5-5', length: 'short', images_n: 0, queued: false },
    { engine: 'claude', model: 'claude-opus-5-5', length: 'medium', images_n: 2, queued: false },
    { engine: 'claude', model: 'claude-opus-5-5', length: 'long', images_n: 3, files_n: 2, queued: true },
    { engine: 'claude', model: 'claude-opus-5-5', length: 'short', images_n: 0, files_n: 0, queued: false },
    { engine: 'claude', model: 'claude-opus-5-5', length: 'short', images_n: 0, queued: false },
  ]);
});

test('attachments are counted, never read; and the text never comes back out, from the queue or from what is held back', () => {
  const r = rig();
  r.open('a');
  // An image list that fails the test if anything but its length is looked at.
  const touched = [];
  const images = new Proxy([{ mediaType: 'image/png', data: PRIVATE }], { get(t, k, rcv) { if (k !== 'length') touched.push(String(k)); return Reflect.get(t, k, rcv); } });
  const text = said(`a message nobody else should read ${SECRET} ${'word '.repeat(60)}`);
  r.tracker.onSend({ sid: 'a', text, images, files: [PRIVATE] });       // no model yet: held back
  r.tracker.onSend({ sid: 'a', text, images: [], queued: true });
  assert.deepEqual(r.tracked, [], 'both wait for the model');
  assert.deepEqual(touched, []);
  r.tracker.onClose('a'); // what was held goes out as it is
  assert.deepEqual(r.of('message_sent'), [
    { engine: 'claude', length: 'medium', images_n: 1, files_n: 1, queued: false },
    { engine: 'claude', length: 'medium', images_n: 0, queued: true },
  ]);
  assert.ok(!JSON.stringify(r.tracked).includes(SECRET));
});

// ---- when a chat starts ----

test('opening a chat sends no event: chat_started goes with its first message, and says how the chat came to be', () => {
  const r = rig();
  r.open('fresh', { kind: 'new' });
  r.open('old', { kind: 'resumed', model: 'claude-sonnet-5' });
  r.open('branch', { kind: 'forked' });
  r.open('peek', { kind: 'resumed' }); // opened to read, never written in
  r.ev('old', 'meta', { sessionId: 'c-old', commands: [], models: [], account: { email: PRIVATE } });
  r.ev('peek', 'meta', { sessionId: 'c-peek', commands: [], models: [] });
  assert.deepEqual(r.tracked, []);
  assert.deepEqual(r.milestones, ['first_chat'], 'getting as far as an open chat is the first step');
  for (const sid of ['fresh', 'old', 'branch']) { r.tracker.onSend({ sid, text: 'hello' }); turn(r, sid); }
  assert.deepEqual(r.of('chat_started').map((p) => p.kind), ['new', 'resumed', 'forked']);
  // More messages in the same chats, and switching back to one (main may say onOpen again): no second start.
  r.tracker.onOpen({ sid: 'old', kind: 'resumed' });
  r.tracker.onSend({ sid: 'old', text: 'more' });
  r.tracker.onSend({ sid: 'fresh', text: 'more' });
  assert.equal(r.of('chat_started').length, 3);
  assert.equal(r.of('message_sent').length, 5);
});

test('a chat nobody announced still starts: picked back up if it holds a conversation, new if it does not', () => {
  const r = rig();
  r.open('a', { kind: null });
  r.open('b', { kind: null });
  r.ev('b', 'meta', { sessionId: 'c-b' }); // a saved chat says which conversation it holds as it warms up
  r.tracker.onSend({ sid: 'a', text: 'hi' }); turn(r, 'a');
  r.tracker.onSend({ sid: 'b', text: 'hi' }); turn(r, 'b', { sessionId: 'c-b' });
  assert.deepEqual(r.of('chat_started').map((p) => p.kind), ['new', 'resumed']);
  assert.deepEqual(r.milestones, ['first_chat', 'first_message', 'first_reply'], 'first_chat is reached with the first message when no open was said');
  r.tracker.onOpen({ sid: 'a', kind: 'sideways' }); // not a way a chat comes to be
  r.tracker.onOpen({ sid: 'a' });
  r.tracker.onSend({ sid: 'a', text: 'again' });
  assert.equal(r.of('chat_started').length, 2);
});

test('/clear and a fork put a new conversation in the same window: its first message starts a new chat', () => {
  const r = rig();
  r.open('a', { kind: 'resumed' });
  r.tracker.onSend({ sid: 'a', text: 'carry on' });
  turn(r, 'a', { sessionId: 'c-1' });
  // /clear, as recorded: the conversation is reset, then the turn ends as a local command.
  r.tracker.onSend({ sid: 'a', text: '/clear' });
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'notice', { code: 'conversation-reset', reset: true, trigger: 'clear', text: 'Conversation cleared' });
  r.ev('a', 'init', initOf('c-2', 'claude-opus-5-5'));
  r.ev('a', 'meta', { sessionId: 'c-2', previousSessionId: 'c-1' });
  r.ev('a', 'turn-end', ended({ localCommand: 'clear', turns: 0, sessionId: 'c-2' }));
  r.ev('a', 'busy', busyOff);
  assert.equal(r.of('chat_started').length, 1, 'not until something is said in it');
  r.tracker.onSend({ sid: 'a', text: 'something else entirely' });
  turn(r, 'a', { sessionId: 'c-2' });
  // A fork of the chat under way.
  r.tracker.onOpen({ sid: 'a', kind: 'forked' });
  r.tracker.onSend({ sid: 'a', text: 'another way' });
  assert.deepEqual(r.of('chat_started').map((p) => p.kind), ['resumed', 'new', 'forked']);
  assert.deepEqual(r.notes, [['claude', 'c-1'], ['claude', 'c-2']]);
  assert.deepEqual(r.milestones, ['first_chat', 'first_message', 'first_reply']);
});

// ---- the model ----

test('a chat on the default model: chat_started and message_sent wait until the engine names the model', () => {
  const r = rig();
  r.open('a'); // main has no model for it yet
  r.tracker.onSend({ sid: 'a', text: 'hello' });
  r.ev('a', 'busy', { ...busyOn, state: 'starting' });
  r.ev('a', 'meta', { sessionId: null, commands: [], models: [{ value: 'default' }] });
  assert.deepEqual(r.tracked, [], 'nothing goes out without a model while one is on its way');
  assert.deepEqual(r.milestones, ['first_chat', 'first_message'], 'the milestones do not wait');
  r.ev('a', 'init', initOf('c-1', 'claude-haiku-5-5'));
  assert.deepEqual(r.names(), ['chat_started', 'message_sent']);
  assert.deepEqual(r.tracked.map(([, p]) => p.model), ['claude-haiku-5-5', 'claude-haiku-5-5']);
  r.tracker.onSend({ sid: 'a', text: 'and this', queued: true }); // the model is known now: no waiting
  assert.equal(r.of('message_sent').length, 2);
  r.wait(2000);
  r.ev('a', 'turn-end', ended());
  assert.deepEqual(r.names(), ['chat_started', 'message_sent', 'message_sent', 'reply_finished']);
});

test('what waits for a model never waits past the turn: it goes out with what main knows, or without one', () => {
  const r = rig();
  // The engine never got as far as naming a model (it could not start): the message is still counted.
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'hello' });
  r.ev('a', 'busy', { ...busyOn, state: 'starting' });
  r.ev('a', 'error', { code: 'not-installed', message: PRIVATE, recoverable: false });
  r.ev('a', 'busy', busyOff);
  assert.deepEqual(r.tracked.map(([e, p]) => [e, 'model' in p]), [['chat_started', false], ['message_sent', false]]);
  // Main had a model for this one all along (one picked in the menu).
  r.open('b', { model: 'claude-sonnet-5' });
  r.tracker.onSend({ sid: 'b', text: 'hello' });
  r.ev('b', 'busy', busyOn);
  r.ev('b', 'turn-end', ended());
  assert.deepEqual(r.tracked.slice(2).map(([e, p]) => [e, p.model]), [['chat_started', 'claude-sonnet-5'], ['message_sent', 'claude-sonnet-5'], ['reply_finished', 'claude-sonnet-5']]);
  // A message is said before the reply to it, even when the reply is what let it go.
  assert.deepEqual(r.names().slice(2), ['chat_started', 'message_sent', 'reply_finished']);
});

test('only so much waits for a model: past that, events go out as they are, and none is lost', () => {
  const r = rig();
  r.open('a');
  for (let i = 0; i < 40; i++) r.tracker.onSend({ sid: 'a', text: 'again', queued: i > 0 });
  const early = r.tracked.length;
  assert.equal(early, 41 - 16, 'sixteen wait; the rest went out at once');
  assert.ok(r.tracked.every(([, p]) => !('model' in p)));
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  assert.equal(r.of('chat_started').length, 1);
  assert.equal(r.of('message_sent').length, 40);
  assert.equal(r.tracked.slice(early).every(([, p]) => p.model === 'claude-opus-5-5'), true);
});

test('after the model is changed, the old name is not used: the next message waits for the engine to say the new one', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'one' });
  turn(r, 'a', { model: 'claude-opus-5-5' });
  r.ev('a', 'setting', { key: 'effort', value: 'high' }); // not the model: nothing changes
  r.tracker.onSend({ sid: 'a', text: 'two' });
  assert.equal(r.of('message_sent').at(-1).model, 'claude-opus-5-5');
  turn(r, 'a', { model: 'claude-opus-5-5' });
  r.ev('a', 'setting', { key: 'model', value: 'sonnet' });
  r.tracker.onSend({ sid: 'a', text: 'three' });
  assert.equal(r.of('message_sent').length, 2, 'held: the engine has not said what "sonnet" is yet');
  turn(r, 'a', { model: 'claude-sonnet-5' });
  assert.deepEqual(r.of('message_sent').map((p) => p.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5']);
  assert.deepEqual(r.of('reply_finished').map((p) => p.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5']);
});

// ---- prompts ----

test('a prompt answered: allow, always or deny, and the kind of tool it was about', () => {
  const r = rig();
  r.open('a');
  const ask = (id, toolName, type = 'tool') => r.ev('a', 'permission', { id, type, toolName, title: PRIVATE, input: { command: PRIVATE, questions: [{ question: PRIVATE }] }, suggestions: [] });
  const answer = (id, a) => r.tracker.onPermissionAnswer({ sid: 'a', id, answer: a });
  const cases = [
    ['Bash', 'tool', { action: 'allow' }, 'bash', 'allow'],
    ['Write', 'tool', { action: 'always' }, 'edit', 'always'],
    ['Read', 'tool', { action: 'deny', message: PRIVATE }, 'read', 'deny'],
    ['mcp__linear__create_issue', 'tool', { action: 'always', scope: 'session' }, 'mcp', 'always'],
    ['AskUserQuestion', 'question', { action: 'answers', answers: { [PRIVATE]: PRIVATE } }, 'question', 'allow'],
    ['AskUserQuestion', 'question', { action: 'deny', message: 'The user skipped the question.' }, 'question', 'deny'],
    ['AskUserQuestion', 'question', { action: 'question-skip', how: 'dismissed' }, 'question', 'deny'],
    ['ExitPlanMode', 'plan', { action: 'plan-approve', mode: 'acceptEdits', plan: PRIVATE }, 'plan', 'allow'],
    ['ExitPlanMode', 'plan', { action: 'plan-reject', message: PRIVATE }, 'plan', 'deny'],
    ['a-private-server', 'elicitation', { action: 'elicit-accept', content: { token: PRIVATE } }, 'mcp', 'allow'],
    ['a-private-server', 'elicitation', { action: 'elicit-decline' }, 'mcp', 'deny'],
    ['WebFetch', 'tool', { action: 'allow', input: { url: PRIVATE } }, 'web', 'allow'],
    ['Permissions', 'tool', {}, 'other', 'deny'],
    ['Bash', 'tool', null, 'bash', 'deny'],
    ['Bash', 'tool', 'allow', 'bash', 'deny'], // not an answer core understands: it is a "no" there too
  ];
  cases.forEach(([toolName, type, a], i) => { ask(100 + i, toolName, type); answer(100 + i, a); });
  assert.deepEqual(r.of('permission_answered'), cases.map(([, , , tool_kind, answer]) => ({ engine: 'claude', tool_kind, answer })));
});

test('a prompt is counted once, in whichever order main and the engine get to it, and only if it was asked', () => {
  const r = rig();
  r.open('a');
  r.ev('a', 'permission', { id: 1, type: 'tool', toolName: 'Bash' });
  // The engine resolves the prompt as part of taking the answer: main telling the tracker after that still counts.
  r.ev('a', 'permission-resolved', { id: 1 });
  r.tracker.onPermissionAnswer({ sid: 'a', id: 1, answer: { action: 'allow' } });
  r.tracker.onPermissionAnswer({ sid: 'a', id: 1, answer: { action: 'allow' } }); // a second click
  r.tracker.onPermissionAnswer({ sid: 'a', id: 2, answer: { action: 'allow' } }); // never asked
  r.tracker.onPermissionAnswer({ sid: 'nobody', id: 1, answer: { action: 'allow' } });
  assert.equal(r.of('permission_answered').length, 1);
  // A prompt outlives the turn it was asked in when an agent in the background asked it.
  r.ev('a', 'permission', { id: 3, type: 'tool', toolName: 'Edit' });
  turn(r, 'a');
  r.tracker.onPermissionAnswer({ sid: 'a', id: 3, answer: { action: 'deny' } });
  assert.deepEqual(r.of('permission_answered').at(-1), { engine: 'claude', tool_kind: 'edit', answer: 'deny' });
  // The contract's form: no id, the tool by name.
  r.tracker.onPermissionAnswer({ sid: 'a', toolName: 'mcp__github__merge', answer: { action: 'always' } });
  r.open('c', { engine: 'codex', kind: null });
  r.tracker.onPermissionAnswer({ sid: 'c', toolName: 'Bash', answer: { action: 'allow' } }); // a chat with no event seen yet
  assert.deepEqual(r.of('permission_answered').slice(-2), [{ engine: 'claude', tool_kind: 'mcp', answer: 'always' }, { engine: 'codex', tool_kind: 'bash', answer: 'allow' }]);
});

test('prompts nobody answers are not kept for ever', () => {
  const r = rig();
  r.open('a');
  for (let id = 1; id <= 500; id++) r.ev('a', 'permission', { id, type: 'tool', toolName: 'Bash' });
  r.tracker.onPermissionAnswer({ sid: 'a', id: 1, answer: { action: 'allow' } }); // long forgotten
  r.tracker.onPermissionAnswer({ sid: 'a', id: 500, answer: { action: 'allow' } });
  assert.equal(r.of('permission_answered').length, 1);
});

// ---- milestones ----

test('each milestone is handed to the core once, however many chats and replies follow', () => {
  const r = rig();
  for (const sid of ['a', 'b', 'c']) {
    r.open(sid, { engine: sid === 'c' ? 'codex' : 'claude' });
    for (let i = 0; i < 3; i++) { r.tracker.onSend({ sid, text: 'hello' }); turn(r, sid); }
  }
  assert.deepEqual(r.milestones, ['first_chat', 'first_message', 'first_reply']);
  assert.equal(r.of('reply_finished').length, 9);
});

// ---- conversations Canopy ran ----

test('a conversation is Canopy\'s once Canopy sent a message in it, not when a chat is only opened to be read', () => {
  const r = rig();
  r.open('peek', { kind: 'resumed' });
  r.ev('peek', 'meta', { sessionId: 'terminal-chat' });
  r.open('codex-peek', { kind: 'resumed', engine: 'codex' });
  r.ev('codex-peek', 'init', { ...initOf('codex-thread', 'gpt-6.1-sol'), engine: 'codex' }); // a reopened Codex chat says init as it opens
  assert.deepEqual(r.notes, [], 'reading an old chat does not make it one of Canopy\'s');
  // A message in the Claude chat: it is listed from here on, though it began in the terminal. Claude Code writes
  // down where each message was typed, so the terminal keeps its own.
  r.tracker.onSend({ sid: 'peek', text: 'carry on here' });
  assert.deepEqual(r.notes, [['claude', 'terminal-chat']]);
  turn(r, 'peek', { sessionId: 'terminal-chat' });
  turn(r, 'peek', { sessionId: 'terminal-chat' });
  assert.equal(r.notes.length, 1, 'once per conversation');
  // A new chat has no id until its first turn starts.
  r.open('new');
  r.tracker.onSend({ sid: 'new', text: 'hello' });
  assert.equal(r.notes.length, 1);
  turn(r, 'new', { sessionId: 'born-here' });
  // The conversation in a window changes (cleared, or its first message edited): the new one is listed too.
  r.ev('new', 'meta', { sessionId: 'born-again', previousSessionId: 'born-here', supersedes: 'born-here' });
  r.ev('new', 'meta', { sessionId: null, previousSessionId: 'born-again' }); // gone from disk: no id to list
  r.ev('new', 'meta', { title: PRIVATE });
  assert.deepEqual(r.notes, [['claude', 'terminal-chat'], ['claude', 'born-here'], ['claude', 'born-again']]);
  // A turn nobody sent a message for (a queued message going out, an agent reporting back) is still Canopy's work.
  r.open('quiet', { kind: 'resumed' });
  r.ev('quiet', 'meta', { sessionId: 'quiet-chat' });
  r.ev('quiet', 'busy', busyOn);
  assert.deepEqual(r.notes.at(-1), ['claude', 'quiet-chat']);
});

test('a Codex chat is Canopy\'s only if it began here: its history names one app for the whole chat', () => {
  const r = rig();
  // A chat begun in the terminal (or the Codex app), picked up here and written in: never listed, or every message
  // typed there would be counted as Canopy's.
  r.open('old', { kind: 'resumed', engine: 'codex' });
  r.ev('old', 'init', { ...initOf('terminal-thread', 'gpt-6.1-sol'), engine: 'codex' });
  r.tracker.onSend({ sid: 'old', text: 'carry on here' });
  turn(r, 'old', { sessionId: 'terminal-thread', model: 'gpt-6.1-sol' });
  turn(r, 'old', { sessionId: 'terminal-thread', model: 'gpt-6.1-sol' });
  assert.deepEqual(r.notes, []);
  // Nor one nobody announced: without knowing it began here, it is taken to have begun elsewhere.
  r.open('unannounced', { kind: null, engine: 'codex' });
  r.tracker.onSend({ sid: 'unannounced', text: 'hello' });
  turn(r, 'unannounced', { sessionId: 'who-knows', model: 'gpt-6.1-sol' });
  assert.deepEqual(r.notes, []);
  // Opened new here: listed once it has a message and an id.
  r.open('new', { kind: 'new', engine: 'codex' });
  r.ev('new', 'meta', { engine: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(r.notes, [], 'open, not written in');
  r.tracker.onSend({ sid: 'new', text: 'hello' });
  turn(r, 'new', { sessionId: 'born-here', model: 'gpt-6.1-sol' });
  assert.deepEqual(r.notes, [['codex', 'born-here']]);
  // The saved chat is gone from disk: Codex carries on in a new one, and that one began here.
  r.ev('old', 'meta', { sessionId: null, previousSessionId: 'terminal-thread' });
  r.tracker.onSend({ sid: 'old', text: 'again then' });
  assert.equal(r.notes.length, 1, 'no id yet, and never the old one');
  r.ev('old', 'meta', { sessionId: 'started-over', previousSessionId: 'terminal-thread' });
  assert.deepEqual(r.notes, [['codex', 'born-here'], ['codex', 'started-over']]);
  // A chat that says it is a fork before the engine names the fork still holds the chat it forked: not that one.
  r.open('branch', { kind: 'resumed', engine: 'codex' });
  r.ev('branch', 'init', { ...initOf('someone-elses', 'gpt-6.1-sol'), engine: 'codex' });
  r.tracker.onOpen({ sid: 'branch', kind: 'forked' });
  r.tracker.onSend({ sid: 'branch', text: 'another way' });
  assert.equal(r.notes.length, 2);
  r.ev('branch', 'meta', { sessionId: 'the-fork', previousSessionId: 'someone-elses' });
  assert.deepEqual(r.notes.at(-1), ['codex', 'the-fork']);
});

// ---- chats that broke ----

test('a chat that crashed or could not start is reported by Canopy\'s own code for it, and nothing the engine said', () => {
  const r = rig();
  r.open('a');
  r.open('c', { engine: 'codex' });
  const broken = { message: `Claude Code could not be launched: ${PRIVATE}`, stderr: PRIVATE, prompts: [{ id: 'x', text: PRIVATE }], prompt: { id: 'x', text: PRIVATE } };
  r.ev('a', 'error', { code: 'launch-failed', recoverable: false, ...broken });
  r.ev('a', 'error', { code: 'crash-loop', recoverable: true, ...broken });
  r.ev('a', 'error', { code: 'turn-lost', cause: 'crashed', recoverable: true, ...broken });
  r.ev('a', 'error', { code: 'timeout', recoverable: true, ...broken });
  r.ev('a', 'error', { code: 'something-new', fatal: true, ...broken });
  r.ev('c', 'error', { code: 'crashed', recoverable: true, ...broken });
  r.ev('c', 'error', { code: `not a code ${PRIVATE}`, recoverable: false, ...broken });
  r.ev('c', 'error', { recoverable: false, cause: PRIVATE, ...broken });
  assert.deepEqual(r.errors.map(([where, err]) => [where, err.name, err.message]), [
    ['engine', 'ClaudeChat_launch_failed', 'Claude Code chat failed: launch-failed'],
    ['engine', 'ClaudeChat_crash_loop', 'Claude Code chat failed: crash-loop'],
    ['engine', 'ClaudeChat_turn_lost', 'Claude Code chat failed: turn-lost (crashed)'],
    ['engine', 'ClaudeChat_timeout', 'Claude Code chat failed: timeout'],
    ['engine', 'ClaudeChat_something_new', 'Claude Code chat failed: something-new'],
    ['engine', 'CodexChat_crashed', 'Codex chat failed: crashed'],
    ['engine', 'CodexChat_unknown', 'Codex chat failed: unknown'],
    ['engine', 'CodexChat_unknown', 'Codex chat failed: unknown'],
  ]);
  for (const [, err] of r.errors) {
    assert.ok(err instanceof Error);
    assert.match(err.name, /^[A-Za-z_$][A-Za-z0-9_$]{0,59}$/, 'a name the schema takes as an error type');
    assert.ok(!`${err.name} ${err.message} ${err.stack}`.includes(SECRET));
    assert.ok(!/\bat \S+|file:|\.mjs/.test(err.stack), 'no frames: they would say nothing about the chat');
    assert.deepEqual(Object.keys(err), ['name'], 'nothing else rides along: no stderr, no message that was being sent');
  }
  assert.deepEqual(r.tracked, []);
});

test('a send that was refused, a setting that did not take and a warning are not a broken chat', () => {
  const r = rig();
  r.open('a');
  r.ev('a', 'error', { code: 'invalid-input', message: PRIVATE, recoverable: true });
  r.ev('a', 'error', { code: 'send-failed', message: PRIVATE, recoverable: true, prompt: { id: 'x', text: PRIVATE } });
  r.ev('a', 'error', { code: 'parked', message: PRIVATE });
  r.ev('a', 'notice', { level: 'warn', code: 'api-error', text: PRIVATE });
  r.ev('a', 'notice', { level: 'warn', code: 'rate-limit', text: PRIVATE });
  r.ev('a', 'setting-failed', { key: 'model', value: PRIVATE });
  assert.deepEqual(r.errors, []);
});

// ---- time ----

test('a reply whose start was never seen is timed by the engine\'s own count', () => {
  const r = rig();
  r.open('a', { model: 'claude-opus-5-5' });
  r.ev('a', 'turn-end', ended({ durationMs: 61_250 }));
  r.ev('a', 'turn-end', ended({ durationMs: null }));
  r.ev('a', 'turn-end', ended({ durationMs: -5 }));
  r.ev('a', 'turn-end', ended({ durationMs: Number.POSITIVE_INFINITY }));
  r.ev('a', 'turn-end', ended({ durationMs: 'soon' }));
  assert.deepEqual(r.of('reply_finished').map((p) => p.secs), [61.3, undefined, undefined, undefined, undefined]);
  assert.deepEqual(r.of('reply_finished')[1], { engine: 'claude', model: 'claude-opus-5-5', tools_n: 0, outcome: 'done', background: false }, 'no time is sent rather than a wrong one');
});

test('a message sent while a reply is under way gets a turn of its own, timed from when the engine starts on it', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'one' });
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.ev('a', 'tool-start', tool('Bash'));
  r.wait(5000);
  r.tracker.onSend({ sid: 'a', text: 'two' }); // Claude Code holds it until the reply is done
  r.wait(5000);
  r.ev('a', 'turn-end', ended());
  r.wait(200);                                  // the chat stays busy: no idle in between
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.ev('a', 'message-start', { model: 'claude-opus-5-5' });
  r.ev('a', 'tool-start', tool('Read'));
  r.wait(3000);
  r.ev('a', 'turn-end', ended());
  r.ev('a', 'busy', busyOff);
  assert.deepEqual(r.of('reply_finished').map((p) => [p.secs, p.tools_n, p.tools_bash ?? 0, p.tools_read ?? 0]), [[10, 1, 1, 0], [3, 1, 0, 1]]);
});

test('a turn that never got a reply is let go, and does not stretch the next one', () => {
  const r = rig();
  r.open('a');
  r.tracker.onSend({ sid: 'a', text: 'one' });
  r.ev('a', 'busy', { ...busyOn, state: 'starting' });
  r.ev('a', 'tool-start', tool('Bash'));
  r.ev('a', 'error', { code: 'send-failed', message: PRIVATE, recoverable: true });
  r.ev('a', 'busy', busyOn);  // core says again that work continues after every error
  r.ev('a', 'busy', busyOff); // and then it stops with no reply
  assert.deepEqual(r.of('reply_finished'), []);
  r.wait(3_600_000);
  r.tracker.onSend({ sid: 'a', text: 'two' });
  turn(r, 'a', { ms: 2000 });
  assert.deepEqual(r.of('reply_finished').map((p) => [p.secs, p.tools_n]), [[2, 0]]);
  // Work seen with no "busy" before it (a late listener) opens a turn; the next real start does not inherit it.
  r.ev('a', 'message-start', { model: 'claude-opus-5-5' });
  r.ev('a', 'tool-start', tool('Bash'));
  r.wait(3_600_000);
  turn(r, 'a', { ms: 1000 });
  assert.deepEqual(r.of('reply_finished').at(-1), { engine: 'claude', model: 'claude-opus-5-5', secs: 1, tools_n: 0, outcome: 'done', background: false });
});

test('a reply longer than the schema allows is sent without a time, not dropped', () => {
  const r = rig();
  r.open('a');
  r.ev('a', 'busy', busyOn);
  r.ev('a', 'init', initOf('c-1', 'claude-opus-5-5'));
  r.wait(1e9 + 1); // the Mac slept for eleven days
  r.ev('a', 'turn-end', ended());
  assert.deepEqual(r.of('reply_finished'), [{ engine: 'claude', model: 'claude-opus-5-5', tools_n: 0, outcome: 'done', background: false }]);
  const back = rig();
  back.open('a');
  back.ev('a', 'busy', busyOn);
  back.t -= 5000; // the clock was set back
  back.ev('a', 'turn-end', ended());
  assert.equal('secs' in back.of('reply_finished')[0], false);
});

// ---- a Codex chat, by hand ----

test('a Codex chat: init on reopening is not a turn, and its turns are followed like Claude\'s', () => {
  const r = rig();
  r.open('c', { engine: 'codex', kind: 'resumed', effort: 'medium' });
  // Reopened: Codex says what the chat runs with at once, with nothing running.
  r.ev('c', 'meta', { engine: 'codex', sessionId: 'thread-1' });
  r.ev('c', 'init', { ...initOf('thread-1', 'gpt-6.1-sol'), engine: 'codex', effort: 'medium' });
  r.wait(600_000); // ten minutes pass before anything is asked
  r.tracker.onSend({ sid: 'c', text: 'run the tests' });
  r.ev('c', 'busy', { ...busyOn, state: 'starting' });
  r.ev('c', 'busy', busyOn);
  r.ev('c', 'message-start', { model: 'gpt-6.1-sol', turnId: 'turn-1' });
  r.ev('c', 'tool-start', { ...tool('Bash'), turnId: 'turn-1' });
  r.ev('c', 'permission', { id: 1_000_000_001, type: 'tool', toolName: 'Bash', engine: 'codex', input: { command: PRIVATE } });
  r.ev('c', 'busy', { ...busyOn, state: 'requires_action' });
  r.tracker.onPermissionAnswer({ sid: 'c', id: 1_000_000_001, answer: { action: 'allow' } });
  r.ev('c', 'permission-resolved', { id: 1_000_000_001 });
  r.ev('c', 'tool-start', { ...tool('TodoWrite'), turnId: 'turn-1' });
  r.ev('c', 'tool-start', { ...tool('Edit'), id: 'patch-1' });
  r.ev('c', 'tool-start', { ...tool('Write'), id: 'patch-1#1' }); // one patch, two files: two rows
  r.wait(8000);
  r.ev('c', 'turn-end', { ...ended({ subtype: 'success', durationMs: 7900, cost: null }), turnId: 'turn-1' });
  r.ev('c', 'busy', busyOff);
  assert.deepEqual(r.tracked, [
    ['chat_started', { engine: 'codex', model: 'gpt-6.1-sol', mode: 'default', effort: 'medium', has_folder: true, kind: 'resumed' }],
    ['message_sent', { engine: 'codex', model: 'gpt-6.1-sol', length: 'short', images_n: 0, queued: false }],
    ['permission_answered', { engine: 'codex', tool_kind: 'bash', answer: 'allow' }],
    ['reply_finished', { engine: 'codex', model: 'gpt-6.1-sol', secs: 8, tools_n: 4, tools_bash: 1, tools_plan: 1, tools_edit: 2, outcome: 'done', background: false }],
  ]);
  assert.deepEqual(r.notes, [], 'a saved Codex chat picked back up may have begun in another app: it is not listed');
});

// ---- it cannot break a chat ----

test('nothing throws, whatever it is handed', () => {
  const r = rig();
  const junk = [undefined, null, 0, 1, '', 'text', true, [], {}, { kind: null }, { kind: 'busy' }, { kind: 'turn-end' }, { sid: 'a' }, { sid: 7, kind: 'busy', busy: true },
    { sid: 'a', kind: 'tool-start' }, { sid: 'a', kind: 'tool-start', name: {} }, { sid: 'a', kind: 'permission' }, { sid: 'a', kind: 'permission', id: {} },
    { sid: 'a', kind: 'turn-end', durationMs: {} }, { sid: 'a', kind: 'init', sessionId: {}, model: [] }, { sid: 'a', kind: 'error', recoverable: false, code: {} },
    { sid: 'a', kind: 'setting' }, { sid: 'a', kind: 'notice' }, { sid: 'a', kind: 'meta', model: 5 }, { sid: '', kind: 'busy', busy: true }, { sid: 'a', kind: 'toString' }, { sid: 'a', kind: '__proto__' }];
  for (const j of junk) {
    assert.doesNotThrow(() => r.tracker.onEvent(j), `onEvent(${JSON.stringify(j)})`);
    assert.doesNotThrow(() => r.tracker.onEvent(j, j));
    assert.doesNotThrow(() => r.tracker.onOpen(j));
    assert.doesNotThrow(() => r.tracker.onSend(j));
    assert.doesNotThrow(() => r.tracker.onPermissionAnswer(j));
    assert.doesNotThrow(() => r.tracker.onClose(j));
  }
  assert.doesNotThrow(() => { r.tracker.onEvent(); r.tracker.onOpen(); r.tracker.onSend(); r.tracker.onPermissionAnswer(); r.tracker.onClose(); });
  assert.doesNotThrow(() => r.tracker.onSend({ sid: 'a', text: { length: PRIVATE }, images: 'two', files: -1 }));
  assert.doesNotThrow(() => r.tracker.onPermissionAnswer({ sid: 'a', toolName: {}, answer: { action: {} } }));
  for (const [event, props] of r.tracked) assertSafe(event, props);
  assert.deepEqual(r.errors.filter(([where]) => where === 'main'), [], 'junk is handled, not caught: no bug of Canopy\'s own is reported');
});

test('an event of a saved transcript (history) is never a live turn', () => {
  const r = rig();
  r.open('h', { model: 'claude-opus-5-5' });
  r.ev('h', 'tool-start', { ...tool('Bash'), history: true });
  r.ev('h', 'permission', { id: 1, toolName: 'Bash', history: true });
  r.ev('h', 'turn-end', { ...ended(), history: true });
  r.tracker.onPermissionAnswer({ sid: 'h', id: 1, answer: { action: 'allow' } });
  assert.deepEqual(r.tracked, []);
  assert.deepEqual(r.milestones, ['first_chat']);
});

test('with nothing to call, or with a core that throws at every call, a chat is still followed and nothing is raised', () => {
  // No core at all.
  const bare = createEngineTracker();
  assert.doesNotThrow(() => { bare.onOpen({ sid: 'a', kind: 'new' }); bare.onSend({ sid: 'a', text: 'hi' }); bare.onEvent({ sid: 'a', kind: 'busy', busy: true }); bare.onEvent({ sid: 'a', kind: 'turn-end' }); bare.onPermissionAnswer({ sid: 'a', toolName: 'Bash' }); bare.onClose('a'); });
  assert.doesNotThrow(() => createEngineTracker({ track: 'no', describe: 5, isVisible: {}, now: 'later' }).onEvent({ sid: 'a', kind: 'turn-end' }));
  assert.doesNotThrow(() => createEngineTracker(null).onEvent({ sid: 'a', kind: 'turn-end' }));
  // A core in which everything throws, the error reporter included.
  const boom = (name) => () => { throw new Error(`${name} is broken`); };
  const hostile = createEngineTracker({ track: boom('track'), milestone: boom('milestone'), error: boom('error'), noteSession: boom('noteSession'), describe: boom('describe'), isVisible: boom('isVisible'), isEditing: boom('isEditing'), now: boom('now') });
  const drive = (t) => {
    t.onOpen({ sid: 'a', kind: 'new' });
    t.onSend({ sid: 'a', text: 'hi' });
    t.onEvent({ sid: 'a', kind: 'busy', busy: true }, { engine: 'claude' });
    t.onEvent({ sid: 'a', kind: 'init', sessionId: 'c-1', model: 'claude-opus-5-5' }, { engine: 'claude' });
    t.onEvent({ sid: 'a', kind: 'permission', id: 1, toolName: 'Bash' }, { engine: 'claude' });
    t.onPermissionAnswer({ sid: 'a', id: 1, answer: { action: 'allow' } });
    t.onEvent({ sid: 'a', kind: 'error', code: 'crashed', recoverable: false }, { engine: 'claude' });
    t.onEvent({ sid: 'a', kind: 'turn-end', interrupted: true }, { engine: 'claude' });
    t.onEvent({ sid: 'a', kind: 'busy', busy: false }, { engine: 'claude' });
    t.onClose('a');
  };
  assert.doesNotThrow(() => drive(hostile));
  // A core in which only track() throws: the failure is said to the error reporter as a bug of Canopy's own.
  const said = [];
  const half = createEngineTracker({ track: boom('track'), error: (where, err) => said.push([where, err.message]), describe: () => ({ engine: 'claude', model: 'claude-opus-5-5' }) });
  drive(half);
  assert.ok(said.length > 0);
  assert.ok(said.filter(([where]) => where === 'main').every(([, message]) => message === 'track is broken'));
  assert.deepEqual(said.filter(([where]) => where === 'engine'), [['engine', 'Claude Code chat failed: crashed']]);
});

// ---- memory ----

test('a chat that closes is forgotten; what it still held goes out first', () => {
  const r = rig();
  for (let i = 0; i < 50; i++) { r.open(`s${i}`); r.tracker.onSend({ sid: `s${i}`, text: 'hello' }); turn(r, `s${i}`); r.ev(`s${i}`, 'permission', { id: i, toolName: 'Bash' }); }
  assert.equal(r.tracker.size, 50);
  for (let i = 0; i < 50; i++) r.tracker.onClose(`s${i}`);
  assert.equal(r.tracker.size, 0);
  r.tracker.onClose('s1'); // twice, or a chat never seen
  r.tracker.onClose('never');
  // Closed with a message nobody answered (the app is quitting): the message is not lost.
  r.open('late');
  r.tracker.onSend({ sid: 'late', text: 'one last thing' });
  const before = r.tracked.length;
  r.tracker.onClose('late');
  assert.deepEqual(r.tracked.slice(before).map(([e]) => e), ['chat_started', 'message_sent']);
  assert.equal(r.tracker.size, 0);
  // Asking about a chat that is not followed does not start following it.
  r.tracker.onPermissionAnswer({ sid: 'ghost', id: 1, answer: { action: 'allow' } });
  assert.equal(r.tracker.size, 0);
});

test('quitting lets go of every chat at once: what any still held goes out then, not after telemetry has closed', () => {
  const r = rig();
  r.open('a');
  r.open('b', { model: 'claude-sonnet-5' });
  r.open('c');
  r.tracker.onSend({ sid: 'a', text: 'just before quitting' }); // on the default model: waiting for the engine to name it
  r.tracker.onSend({ sid: 'b', text: 'this one too' });
  turn(r, 'c');
  assert.deepEqual(r.names(), ['reply_finished'], 'the two messages are waiting for a model');
  r.tracker.onQuit();
  assert.equal(r.tracker.size, 0);
  assert.deepEqual(r.names(), ['reply_finished', 'chat_started', 'message_sent', 'chat_started', 'message_sent']);
  assert.equal(r.of('message_sent')[0].model, undefined, 'a model nobody named is left out');
  assert.equal(r.of('message_sent')[1].model, 'claude-sonnet-5', 'the one main knows stands in');
  // The chats report their close afterwards (they were still shutting down): nothing more, and nothing twice.
  r.ev('a', 'turn-end', ended({ synthetic: true }));
  r.ev('a', 'busy', busyOff);
  for (const sid of ['a', 'b', 'c']) r.tracker.onClose(sid);
  r.tracker.onQuit();
  assert.equal(r.names().length, 5);
  assert.equal(r.tracker.size, 0);
});

test('even if no close is ever reported, the records kept stay bounded, and the chats in use are the ones kept', () => {
  const r = rig();
  r.open('keeper');
  r.tracker.onSend({ sid: 'keeper', text: 'a long job' });
  r.ev('keeper', 'busy', busyOn);
  r.ev('keeper', 'init', initOf('c-keeper', 'claude-opus-5-5'));
  for (let i = 0; i < 5000; i++) {
    r.ev(`drift-${i}`, 'busy', busyOn);
    if (i % 50 === 0) r.ev('keeper', 'tool-start', tool('Bash')); // still at work
  }
  assert.ok(r.tracker.size <= 200, `kept ${r.tracker.size}`);
  r.wait(9000);
  r.ev('keeper', 'turn-end', ended());
  assert.deepEqual(r.of('reply_finished'), [{ engine: 'claude', model: 'claude-opus-5-5', secs: 9, tools_n: 100, tools_bash: 100, outcome: 'done', background: false }],
    'the chat that kept working kept its turn');
  // A record pushed out with a message still waiting sends it rather than dropping it.
  const q = rig();
  q.open('first');
  q.tracker.onSend({ sid: 'first', text: 'hello' });
  for (let i = 0; i < 250; i++) q.ev(`other-${i}`, 'busy', busyOn);
  assert.deepEqual(q.names(), ['chat_started', 'message_sent']);
});

test('streaming never costs a record: deltas and the other kinds nobody reads are passed over', () => {
  const r = rig();
  for (const kind of ['text-delta', 'thinking-delta', 'assistant-text', 'thinking', 'tool-result', 'tool-progress', 'tool-input-partial', 'status', 'tasks', 'task', 'hook', 'title', 'suggestion', 'send-state', 'stopped', 'edit', 'raw', 'user-text', 'command-output', 'permission-resolved', 'setting-failed', 'commands-changed']) {
    r.ev('a', kind, { text: PRIVATE, content: PRIVATE, title: PRIVATE });
  }
  assert.equal(r.tracker.size, 0);
  assert.deepEqual(r.tracked, []);
});

// ---- the real thing: Session, CodexSession and ChatHost, wired as src/main.mjs wires them ----

const env = { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
// The only fields of an event, and of the status row beside it, the tracker may look at.
const EVENT_FIELDS = new Set(['kind', 'sid', 'history', 'engine', 'busy', 'sessionId', 'previousSessionId', 'model', 'parent', 'name', 'id', 'type', 'toolName', 'synthetic', 'localCommand', 'interrupted', 'isError', 'durationMs', 'fatal', 'recoverable', 'code', 'cause', 'key']);
const ROW_FIELDS = new Set(['engine']);
const watched = (obj, seen) => new Proxy(obj, { get(t, k, rcv) { if (typeof k === 'string') seen.add(k); return Reflect.get(t, k, rcv); } });

const hosts = [];
afterEach(async () => {
  for (const w of hosts.splice(0)) {
    await w.host.closeAll();
    assert.equal(w.codex.alive().length, 0, 'no process is left behind');
    assert.equal(w.tracker.size, 0, 'every chat that closed was forgotten');
    assert.deepEqual([...w.read].filter((k) => !EVENT_FIELDS.has(k)), [], 'nothing of an event was read but its kind, flags, ids, tool names and model');
    assert.deepEqual([...w.readRow].filter((k) => !ROW_FIELDS.has(k)), [], 'nothing of a chat\'s status row was read but its engine');
  }
});

/**
 * One ChatHost holding Claude chats (the real Session on the scripted query()) and Codex chats (the real CodexSession
 * on the scripted app-server), with the tracker wired in exactly as the snippets for src/main.mjs say.
 */
function wired({ claude = {}, codex = {}, prefs = { defaultMode: 'default' } } = {}) {
  const w = { ...sink(), fake: createFake(claude), codex: createFakeCodex(codex), saved: { rows: () => [] }, events: [], read: new Set(), readRow: new Set() };
  // describe(sid), as main has it: read straight off the live session, never through snapshot() (that flushes
  // streamed text, which would send events from inside the event being handled).
  const describe = (sid) => {
    const s = w.host.manager.get(sid);
    if (!s) return null;
    const isCodex = engineOf(s) === 'codex';
    return {
      engine: isCodex ? 'codex' : 'claude',
      model: s.model ?? s.settings?.model ?? null,
      mode: s.mode ?? s.settings?.permissionMode ?? (isCodex ? 'default' : prefs.defaultMode ?? 'default'),
      effort: (isCodex ? s.effortNow?.() : s.settings?.effort) ?? null,
      hasFolder: typeof s.cwd === 'string' && path.resolve(s.cwd) !== loose,
    };
  };
  w.tracker = createEngineTracker({
    ...w.deps, describe,
    isVisible: (sid) => sid === w.host.activeSid || w.host.shown.has(sid),
    isEditing: (sid) => w.host.editing.has(sid),
  });
  w.host = new ChatHost({
    create: (o) => (o.engine === 'codex'
      ? new CodexSession({ cwd: o.cwd, resume: o.resume, codexPath: () => '/fake/codex', env: () => env, spawnFn: w.codex.spawnFn, timeouts: { restart: 15, secondPress: 0 } })
      : new Session({ ...o, claudePath: '/usr/bin/true', env, trusted: true, queryFn: w.fake.queryFn, extended: ['tasks', 'task-stop'], readTranscript: async () => w.saved.rows() })),
    send: () => {},
    onEvent: (ev, entry) => { w.events.push(ev); w.tracker.onEvent(watched(ev, w.read), watched(entry, w.readRow)); },
    maxIdle: 8,
  });
  w.host.manager.on('closed', ({ sid }) => w.tracker.onClose(sid));

  // What main's handlers do around the tracker: session:open / pane:open, session:send / pane:send, session:queue,
  // session:respond, session:edit.
  w.open = async (cwd, resume, opts) => {
    const r = await w.host.open(cwd, resume, opts?.engine === 'codex' ? { engine: 'codex' } : {});
    if (!r.reused) w.tracker.onOpen({ sid: r.sid, kind: resume ? 'resumed' : 'new' });
    return r;
  };
  w.send = (r, text, images = [], opts = {}) => {
    const sent = r.session.send(text, images, opts);
    if (sent?.ok !== false) w.tracker.onSend({ sid: r.sid, text, images });
    return sent;
  };
  w.queue = (r, text, images = []) => {
    const q = w.host.queueAdd(r.sid, text, images);
    if (q?.ok) w.tracker.onSend({ sid: r.sid, text, images, queued: true });
    return q;
  };
  w.respond = (r, id, answer) => {
    w.tracker.onPermissionAnswer({ sid: r.sid, id, answer });
    return r.session.respond(id, answer);
  };
  w.edit = async (r, o) => {
    const e = await w.host.edit(r.sid, o);
    if (e?.ok) w.tracker.onSend({ sid: r.sid, text: o.text, images: o.images });
    return e;
  };

  w.eventsOf = (r, from = 0) => w.events.slice(from).filter((e) => e.sid === r.sid);
  w.idle = (r, n = 1) => until(() => w.eventsOf(r).filter((e) => e.kind === 'busy' && e.busy === false).length >= n, 15000, `idle x${n}`);
  w.card = async (r, n = 1) => { await until(() => w.eventsOf(r).filter((e) => e.kind === 'permission').length >= n, 15000, 'a prompt'); return w.eventsOf(r).filter((e) => e.kind === 'permission')[n - 1]; };
  hosts.push(w);
  return w;
}

/** Play a recorded Claude Code session into a chat: the message is sent under its recorded id, then every frame arrives. */
async function replayClaude(w, r, name, text) {
  const frames = fixture(name);
  const id = frames.find((f) => f.type === 'command_lifecycle')?.command_uuid;
  const starts = w.fake.starts;
  w.send(r, said(text), [], { id });
  const run = await w.fake.run(Math.max(1, starts));
  await until(() => run.received.some((m) => m.uuid === id), 15000, 'the message to reach Claude Code');
  const idles = w.eventsOf(r).filter((e) => e.kind === 'busy' && e.busy === false).length;
  for (const f of frames) run.emit(f);
  await w.idle(r, idles + 1);
}

test('recorded: a Claude Code turn that writes a file, replayed through the real Session and ChatHost', async () => {
  const w = wired({ claude: { auto: false } });
  const r = await w.open(work, null);
  await r.session.warm();
  assert.deepEqual(w.tracked, [], 'opening and warming a chat sends no event');
  assert.deepEqual(w.milestones, ['first_chat']);
  assert.deepEqual(w.notes, []);
  await replayClaude(w, r, 'live-tool-turn', 'Use the Write tool to create the file note.txt containing exactly: hi. Then reply with exactly: OK');
  assert.deepEqual(w.names(), ['chat_started', 'message_sent', 'reply_finished']);
  assert.deepEqual(w.of('chat_started')[0], { engine: 'claude', model: 'claude-haiku-5-5', mode: 'default', has_folder: true, kind: 'new' });
  assert.deepEqual(w.of('message_sent')[0], { engine: 'claude', model: 'claude-haiku-5-5', length: 'medium', images_n: 0, queued: false });
  const reply = w.of('reply_finished')[0];
  assert.ok(reply.secs >= 0 && reply.secs < 5);
  assert.deepEqual({ ...reply, secs: 0 }, { engine: 'claude', model: 'claude-haiku-5-5', secs: 0, tools_n: 1, tools_edit: 1, outcome: 'done', background: false });
  assert.deepEqual(w.milestones, ['first_chat', 'first_message', 'first_reply']);
  assert.deepEqual(w.notes, [['claude', '00000000-0000-4000-8000-5dc4448e76a4']], 'the conversation the recording ran in');
  assert.deepEqual(w.errors, []);
});

test('recorded: a Claude Code reply stopped part-way is "stopped"', async () => {
  const w = wired({ claude: { auto: false } });
  const r = await w.open(loose, null);
  await replayClaude(w, r, 'live-interrupt', 'Count from 1 to 400, one number per line, and nothing else.');
  assert.deepEqual(w.names(), ['chat_started', 'message_sent', 'reply_finished']);
  assert.equal(w.of('chat_started')[0].has_folder, false, 'a chat in Canopy\'s own chats folder has no project');
  assert.deepEqual({ ...w.of('reply_finished')[0], secs: 0 }, { engine: 'claude', model: 'claude-haiku-5-5', secs: 0, tools_n: 0, outcome: 'stopped', background: false });
  assert.deepEqual(w.milestones, ['first_chat', 'first_message']);
});

test('recorded: /context and /clear are messages, not replies, and what is said after /clear starts a new chat', async () => {
  const w = wired({ claude: { auto: false } });
  const r = await w.open(work, null);
  await replayClaude(w, r, 'live-tool-turn', 'Use the Write tool to create the file note.txt containing exactly: hi. Then reply with exactly: OK');
  await replayClaude(w, r, 'live-local-command', '/context');
  await replayClaude(w, r, 'live-clear', '/clear');
  assert.deepEqual(w.names(), ['chat_started', 'message_sent', 'reply_finished', 'message_sent', 'message_sent']);
  assert.equal(r.session.sessionId, '00000000-0000-4000-8000-df9277d94770', 'the window holds the new conversation');
  await replayClaude(w, r, 'live-tool-turn', 'Use the Write tool to create the file note.txt containing exactly: hi. Then reply with exactly: OK');
  assert.deepEqual(w.names().slice(5), ['chat_started', 'message_sent', 'reply_finished']);
  assert.deepEqual(w.of('chat_started').map((p) => p.kind), ['new', 'new']);
  assert.deepEqual(w.milestones, ['first_chat', 'first_message', 'first_reply']);
  assert.deepEqual(w.notes.map(([, id]) => id), ['00000000-0000-4000-8000-5dc4448e76a4', '00000000-0000-4000-8000-df9277d94770', '00000000-0000-4000-8000-5dc4448e76a4'],
    'each conversation the window came to hold');
});

test('scripted: a prompt answered, a tool run, and an agent\'s own tools left out', async () => {
  const w = wired({
    claude: {
      async reply(msgs, run) {
        await run.useTool('Bash', { command: `echo ${SECRET}` });
        // An agent's tool call, as Claude Code reports it: the same frame with the call it belongs to named.
        run.emit({ type: 'assistant', parent_tool_use_id: 'toolu_agent', timestamp: new Date().toISOString(), message: { id: 'msg_sub', model: 'claude-haiku-fake', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Read', input: { file_path: PRIVATE } }] } });
        await run.useTool('Write', { file_path: `${work}/note.txt`, content: PRIVATE });
        run.say('done');
      },
    },
  });
  const r = await w.open(work, null);
  w.send(r, said('run it, then write the note'));
  const first = await w.card(r, 1);
  assert.equal(first.toolName, 'Bash');
  assert.deepEqual(w.respond(r, first.id, { action: 'always' }), { ok: true });
  const second = await w.card(r, 2);
  w.respond(r, second.id, { action: 'deny', message: PRIVATE });
  w.respond(r, second.id, { action: 'deny' }); // a second click: stale for the engine, not counted here
  await w.idle(r);
  assert.deepEqual(w.of('permission_answered'), [{ engine: 'claude', tool_kind: 'bash', answer: 'always' }, { engine: 'claude', tool_kind: 'edit', answer: 'deny' }]);
  assert.deepEqual({ ...w.of('reply_finished')[0], secs: 0 }, { engine: 'claude', model: 'claude-haiku-fake', secs: 0, tools_n: 2, tools_bash: 1, tools_edit: 1, outcome: 'done', background: false });
  assert.ok(w.events.some((e) => e.kind === 'tool-start' && e.parent === 'toolu_agent'), 'the agent\'s call did come through');
});

test('scripted: Stop is "stopped"; an edit that cuts a reply off is not, and the edited message is answered', async () => {
  const userRow = (uuid, parentUuid) => ({ type: 'user', uuid, parentUuid, origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } });
  const replyRow = (uuid, parentUuid) => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
  const w = wired();
  const r = await w.open(work, null);
  await r.session.warm();
  // A reply stopped by the person.
  let release = w.fake.current.hold();
  const first = w.send(r, said('remember this for later'));
  await until(() => w.eventsOf(r).some((e) => e.kind === 'text-delta'), 15000, 'the reply to start');
  await w.host.stop(r.sid);
  release();
  await w.idle(r, 1);
  assert.deepEqual(w.of('reply_finished').map((p) => p.outcome), ['stopped']);
  // A reply cut off by editing the message it answers.
  release = w.fake.current.hold();
  const mark = w.events.length;
  const second = w.send(r, said('a long task to be reworded'));
  await until(() => w.eventsOf(r, mark).some((e) => e.kind === 'text-delta'), 15000, 'the second reply to start');
  w.saved.rows = () => [userRow(first.id, null), replyRow('a1', first.id), { type: 'attachment', uuid: 'n1', parentUuid: 'a1' }, userRow(second.id, 'n1'), replyRow('a2', second.id)];
  const e = await w.edit(r, { messageId: second.id, text: said('a different task altogether'), id: randomUUID() });
  assert.equal(e.ok, true);
  release();
  await w.idle(r, 3);
  const cut = w.eventsOf(r, mark).filter((x) => x.kind === 'turn-end');
  assert.deepEqual(cut.map((x) => x.interrupted), [true, false], 'core did end the old reply as interrupted');
  assert.deepEqual(w.of('reply_finished').map((p) => p.outcome), ['stopped', 'done'], 'the cut-off reply is not a second stop');
  assert.equal(w.of('message_sent').length, 3, 'the first, the second, and the reworded one');
  assert.deepEqual(w.milestones, ['first_chat', 'first_message', 'first_reply']);
  // An edit that does not go through is not a message.
  const bad = await w.edit(r, { messageId: 'not-a-message', text: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(w.of('message_sent').length, 3);
});

test('scripted: a message queued behind a reply is counted when it is queued, and its reply when it comes', async () => {
  const w = wired();
  const r = await w.open(work, null);
  const release = w.fake.current?.hold() ?? null;
  w.send(r, said('the first thing to do'));
  const run = await w.fake.run(1);
  await w.idle(r, 1);
  const hold = run.hold();
  w.send(r, said('the second thing to do'));
  await until(() => w.eventsOf(r).filter((e) => e.kind === 'text-delta').length >= 2, 15000, 'the second reply to start');
  assert.equal(w.queue(r, said('and after that, a third')).ok, true);
  assert.deepEqual(w.of('message_sent').map((p) => p.queued), [false, false, true]);
  hold(); release?.();
  await until(() => w.of('reply_finished').length === 3, 15000, 'the queued message\'s reply');
  assert.deepEqual(w.of('reply_finished').map((p) => p.outcome), ['done', 'done', 'done']);
  assert.equal(w.of('chat_started').length, 1);
  assert.equal(w.of('message_sent').length, 3, 'the queue sending it later is not a second message');
});

test('scripted: Claude Code dying mid-reply is a broken chat, reported by its code, and not a reply', async () => {
  const w = wired({ claude: { reply(msgs, run) { run.say(`partial ${SECRET}`); run.die(); return false; } } });
  const r = await w.open(work, null);
  w.send(r, said('this one will not come back'));
  await until(() => w.errors.length > 0, 15000, 'the crash to be reported');
  await w.idle(r, 1);
  assert.ok(w.eventsOf(r).some((e) => e.kind === 'turn-end' && e.synthetic), 'core closed the turn itself');
  assert.deepEqual(w.of('reply_finished'), []);
  assert.deepEqual(w.errors.map(([where, err]) => [where, err.name, err.message]), [['engine', 'ClaudeChat_turn_lost', 'Claude Code chat failed: turn-lost (crashed)']]);
  assert.deepEqual(w.names(), ['chat_started', 'message_sent']);
  assert.deepEqual(w.milestones, ['first_chat', 'first_message']);
});

test('scripted: a Codex chat, start to finish', async () => {
  const w = wired();
  const r = await w.open(work, null, { engine: 'codex' });
  assert.equal(engineOf(r.session), 'codex');
  w.send(r, said('say ok, and nothing more'));
  await w.idle(r);
  assert.deepEqual(w.tracked.map(([e, p]) => [e, { ...p, ...('secs' in p && { secs: 0 }) }]), [
    ['chat_started', { engine: 'codex', model: 'gpt-6.1-sol', mode: 'default', has_folder: true, kind: 'new' }],
    ['message_sent', { engine: 'codex', model: 'gpt-6.1-sol', length: 'short', images_n: 0, queued: false }],
    ['reply_finished', { engine: 'codex', model: 'gpt-6.1-sol', secs: 0, tools_n: 0, outcome: 'done', background: false }],
  ]);
  assert.deepEqual(w.notes, [['codex', r.session.sessionId]]);
  assert.deepEqual(w.milestones, ['first_chat', 'first_message', 'first_reply']);
});

// Recorded Codex sessions (fixtures/codex-*.jsonl), each played by the scripted app-server into the real CodexSession.
const CODEX_REPLAYS = [
  ['codex-text', 'Reply with exactly: OK', null, { tools_n: 0, outcome: 'done' }],
  ['codex-command-approval', 'Run this exact shell command: touch approved.txt', ['allow', 'bash'], { tools_n: 1, tools_bash: 1, outcome: 'done' }],
  ['codex-file-change-approval', 'Change the greeting in hello.txt', ['always', 'edit'], { tools_n: 1, tools_edit: 1, outcome: 'done' }],
  ['codex-read-command', 'Read, search and list the files here', null, { tools_n: 3, tools_read: 3, outcome: 'done' }],
  ['codex-interrupt', 'Count from 1 to 300', null, { tools_n: 0, outcome: 'stopped' }],
];
for (const [name, text, prompt, reply] of CODEX_REPLAYS) {
  test(`recorded: Codex, ${name.slice(6).replaceAll('-', ' ')}`, async () => {
    const ids = recordedIds(name);
    const w = wired({ codex: { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay(name) } });
    const r = await w.open(work, null, { engine: 'codex' });
    w.send(r, said(text));
    if (prompt) { const card = await w.card(r); w.respond(r, card.id, { action: prompt[0] }); }
    await w.idle(r);
    assert.deepEqual(w.names(), ['chat_started', 'message_sent', ...(prompt ? ['permission_answered'] : []), 'reply_finished']);
    if (prompt) assert.deepEqual(w.of('permission_answered'), [{ engine: 'codex', tool_kind: prompt[1], answer: prompt[0] }]);
    // The model Codex itself named for the turn, as recorded.
    assert.deepEqual({ ...w.of('reply_finished')[0], secs: 0 }, { engine: 'codex', model: 'gpt-6-luna', secs: 0, background: false, ...reply });
    assert.deepEqual(w.notes, [['codex', ids.threadId]]);
    assert.deepEqual(w.milestones, reply.outcome === 'done' ? ['first_chat', 'first_message', 'first_reply'] : ['first_chat', 'first_message']);
    assert.deepEqual(w.errors, []);
  });
}

test('scripted: a Claude chat and a Codex chat at work together, one of them out of sight', async () => {
  const w = wired({ codex: { holdTurns: true } });
  const a = await w.open(work, null);
  await a.session.warm();
  const release = w.fake.current.hold();
  w.send(a, said('the Claude chat, started first'));
  await until(() => w.eventsOf(a).some((e) => e.kind === 'text-delta'), 15000, 'the Claude reply to start');
  const b = await w.open(loose, null, { engine: 'codex' }); // now on screen: the Claude chat works on behind it
  w.send(b, said('the Codex chat, started second'));
  await until(() => !!w.codex.last?.turn, 15000, 'the Codex turn to start');
  assert.deepEqual(w.of('reply_finished'), []);
  w.codex.last.playText('OK');
  await w.idle(b);
  release();
  await w.idle(a);
  assert.deepEqual(w.of('chat_started'), [
    { engine: 'claude', model: 'claude-haiku-fake', mode: 'default', has_folder: true, kind: 'new' },
    { engine: 'codex', model: 'gpt-6.1-sol', mode: 'default', has_folder: false, kind: 'new' },
  ]);
  assert.deepEqual(w.of('reply_finished').map((p) => [p.engine, p.model, p.outcome, p.background]), [
    ['codex', 'gpt-6.1-sol', 'done', false],
    ['claude', 'claude-haiku-fake', 'done', true],
  ]);
  assert.deepEqual(w.notes.map(([engine]) => engine).sort(), ['claude', 'codex']);
  // Switching back to a chat that is still live is not a chat starting again.
  const again = await w.open(work, a.session.sessionId);
  assert.equal(again.reused, true);
  w.send(again, said('one more for the Claude chat'));
  await w.idle(a, 2);
  assert.equal(w.of('chat_started').length, 2);
  assert.equal(w.of('reply_finished').at(-1).background, false);
});

test('scripted: a chat let go for being idle is forgotten, and picking it back up is a chat resumed', async () => {
  const w = wired();
  const a = await w.open(work, null);
  w.send(a, said('a short exchange to begin with'));
  await w.idle(a);
  const id = a.session.sessionId;
  assert.equal(w.tracker.size, 1);
  await w.host.manager.close(a.sid);
  assert.equal(w.tracker.size, 0, 'the manager said it closed');
  const b = await w.open(work, id);
  assert.notEqual(b.sid, a.sid);
  await b.session.warm();
  assert.equal(w.of('chat_started').length, 1, 'reopened, not yet written in');
  w.send(b, said('and picking it back up'));
  await w.idle(b);
  assert.deepEqual(w.of('chat_started').map((p) => p.kind), ['new', 'resumed']);
  assert.deepEqual(w.notes, [['claude', id], ['claude', id]], 'the same conversation, said again by the new chat: the core keeps a set');
});

// ---- last: everything every case above tracked ----

test('nothing content-like ever reached track(): every event passed the schema unchanged, with no free text in it', () => {
  assert.ok(everything.length > 150, `only ${everything.length} events were tracked`);
  const seen = new Set();
  for (const [event, props] of everything) { assertSafe(event, props); seen.add(event); }
  assert.deepEqual([...seen].sort(), ['chat_started', 'message_sent', 'permission_answered', 'reply_finished']);
  const strings = new Set(everything.flatMap(([, props]) => Object.values(props).filter((v) => typeof v === 'string')));
  // Every string that went out, across the whole file: enum words, model ids, modes and efforts. Nothing else.
  const words = new Set([...MODELS, ...MODES, ...EFFORTS, ...TOOL_KINDS, 'claude', 'codex', 'new', 'resumed', 'forked', 'short', 'medium', 'long', 'done', 'stopped', 'error', 'allow', 'always', 'deny']);
  assert.deepEqual([...strings].filter((s) => !words.has(s)), []);
  assert.ok(!JSON.stringify(everything).includes(SECRET));
});

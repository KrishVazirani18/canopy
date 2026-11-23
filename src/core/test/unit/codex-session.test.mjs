// CodexSession's state machine, driven by a scripted stand-in for the app-server child (fake-codex.mjs), with
// recorded sessions replayed where a real one says more: starting, sending, steering, approvals, stopping, crash
// recovery, reopening, settings on the wire. No Codex is started and nothing under ~/.codex is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex, recordedIds, recordedModels } from '../fake-codex.mjs';
import { UUID_RE, sleep, watch, within } from '../helpers.mjs';
import { CODEX_SESSION_TIMEOUTS, CodexSession } from '../../codex-session.mjs';
import { CANOPY_FACTS, CANOPY_FACTS_NEUTRAL } from '../../facts.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-session-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BYPASS_NOTICE = 'Full Access is off. Turn on bypass permissions in Claude Code settings first.';
const READ_ONLY = { type: 'readOnly', networkAccess: false };
const WORKSPACE = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const CHAT = '00000000-0000-7000-8000-432d1c714b94'; // a chat that is already on disk
const baseEnv = () => ({ PATH: '/usr/bin:/bin', HOME: home });
const NOTE = { developerInstructions: CANOPY_FACTS_NEUTRAL }; // what every thread is opened with (facts.mjs)
// And the skill list's size, for a user whose config sets none (the fake's config/read sets none): skillCap.
const CAP = { config: { 'skills.max_context_tokens': 4000 } };

const open = [];
const fakes = [];
let billingNotices = 0;
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  const left = fakes.splice(0).flatMap((f) => f.alive());
  assert.equal(left.length, 0, 'every process a session started is gone once it is disposed');
});

function make(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  fakes.push(fake);
  const logs = [];
  const s = new CodexSession({
    cwd: work, codexPath: '/fake/codex', env: baseEnv(), spawnFn: fake.spawnFn, log: (level, msg, data) => logs.push({ level, msg, data }),
    ...opts, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
  });
  s.on('event', (ev) => { if (ev.kind === 'notice' && ev.code === 'api-key-billing') billingNotices += 1; });
  open.push(s);
  return { s, fake, w: watch(s), logs };
}

const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });
const settle = (ms = 30) => sleep(ms);
const kinds = (w, from = 0) => w.events.slice(from).map((e) => e.kind);
const sendStates = (w, id) => w.all((e) => e.kind === 'send-state' && e.id === id).map((e) => e.state);
const textOf = (msg) => msg.params.input.find((i) => i.type === 'text')?.text;
const commandAsk = (child, extra = {}) => child.ask('item/commandExecution/requestApproval', {
  kind: 'command', threadId: child.threadId, turnId: child.turn.id, itemId: 'exec-1', reason: 'May I?', command: "/bin/zsh -lc 'touch a.txt'", cwd: work,
  commandActions: [{ type: 'unknown', command: 'touch a.txt' }], proposedExecpolicyAmendment: ['touch', 'a.txt'],
  availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'], ...extra,
});

// ---- a turn, end to end ----

test('one send, one turn: the order of events, rising seq, and what went over the wire', async () => {
  const { s, fake, w } = make({ extended: ['send-state'] });
  assert.equal(s.engine, 'codex');
  assert.equal(s.lifecycle, 'new');
  const r = s.send('hello');
  assert.equal(r.ok, true);
  assert.match(r.id, UUID_RE);
  assert.equal(s.busy, true, 'busy is set before send() returns');
  await idle(w);

  const order = kinds(w).filter((k) => !['send-state', 'notice'].includes(k));
  assert.deepEqual(order, ['busy', 'meta', 'init', 'busy', 'message-start', 'text-delta', 'assistant-text', 'turn-end', 'busy']);
  const busy = w.of('busy');
  assert.deepEqual(busy.map((e) => [e.busy, e.state]), [[true, 'starting'], [true, 'running'], [false, 'idle']]);
  for (let i = 1; i < w.events.length; i++) assert.ok(w.events[i].seq > w.events[i - 1].seq, 'seq rises with every event');
  assert.deepEqual(sendStates(w, r.id), ['pending', 'written', 'started', 'completed']);

  const end = w.find('turn-end');
  assert.equal(end.subtype, 'success');
  assert.equal(end.text, 'OK');
  assert.equal(end.sessionId, s.sessionId);
  assert.deepEqual(end.userUuids, [r.id]);
  assert.equal(end.userUuid, r.id);
  assert.equal(end.synthetic, undefined);
  assert.equal(end.cost, null);
  assert.equal(w.find('assistant-text').text, 'OK');
  assert.equal(w.find('assistant-text').model, 'gpt-6.1-sol', 'the model Codex reported is stamped on the reply');

  assert.deepEqual(fake.received.map((m) => m.method), ['initialize', 'initialized', 'model/list', 'account/read', 'config/read', 'skills/extraRoots/set', 'thread/start', 'turn/start']);
  assert.deepEqual(fake.sent('turn/start')[0].params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  assert.ok(fake.received.every((m) => !('jsonrpc' in m)));
  assert.equal(s.lifecycle, 'ready');
  assert.equal(s.outbox.size, 0);
  assert.equal(fake.spawns.length, 1);
});

test('a recorded text turn, replayed: start-up chatter says nothing, the reply and the end arrive', async () => {
  const ids = recordedIds('codex-text');
  const { s, w } = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-text') });
  s.send('Reply with exactly: OK');
  await idle(w);
  assert.equal(s.sessionId, ids.threadId);
  assert.equal(w.of('message-start').length, 1);
  assert.equal(w.find('assistant-text').text, 'OK');
  assert.equal(w.find('turn-end').subtype, 'success');
  assert.equal(w.find('turn-end').turnId, ids.turnId);
  assert.equal(w.of('error').length, 0);
  assert.equal(w.of('hook').length, 0, 'the plugins\' start-up hooks ran fine, so they are not shown');
  assert.equal(w.all((e) => e.kind === 'raw').length, 0);
  assert.equal(s.model, 'gpt-6-luna', 'the model Codex says it runs with, from its settings echo');
  assert.deepEqual(await s.contextUsage(), { totalTokens: 21800, maxTokens: 258400, percentage: 8, rawMaxTokens: 258400, model: 'gpt-6-luna', autoCompact: false, autoCompactThreshold: null, categories: [], limits: [] });
});

test('a new chat has no sessionId until its first turn starts', async () => {
  let child = null;
  const { s, fake, w } = make({}, { script: (c) => { child = c; } });
  const warmed = await s.warm();
  assert.equal(warmed.ok, true);
  assert.equal(typeof warmed.startupMs, 'number');
  assert.equal(s.sessionId, null, 'the thread is open, but it is not on disk yet');
  assert.equal(typeof s.threadId, 'string');
  assert.equal(w.find('meta').sessionId, null);
  assert.equal(w.of('init').length, 0);
  assert.equal(s.snapshot().sessionId, null);

  s.send('hi');
  await until(() => child, 2000, 'turn/start');
  await settle();
  assert.equal(s.sessionId, null, 'still none: Codex has not said the turn started');
  assert.equal(w.of('init').length, 0);

  child.startTurn();
  const init = await w.waitFor('init', { ms: 2000 });
  assert.equal(s.sessionId, child.threadId);
  assert.equal(init.sessionId, child.threadId);
  assert.equal(init.engine, 'codex');
  assert.equal(init.permissionMode, 'default');
  assert.ok(w.indexOf(init) < w.indexOf(await w.waitFor('message-start', { ms: 2000 })), 'init comes before the turn');
  assert.equal(s.snapshot().meta.sessionId, child.threadId);
  child.playText('done');
  await idle(w);
  assert.equal(w.of('init').length, 1);
  assert.equal(fake.sent('thread/start').length, 1);
});

test('a resumed chat has its id from the start, resumes without its turns, and says init at once', async () => {
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT], resumeUsage: 21800 });
  assert.equal(s.sessionId, CHAT);
  assert.equal((await s.warm()).ok, true);
  const resume = fake.sent('thread/resume')[0].params;
  assert.deepEqual(resume, { threadId: CHAT, cwd: work, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', serviceTier: null, ...NOTE, ...CAP, excludeTurns: true });
  assert.equal(fake.sent('thread/start').length, 0);
  const init = w.find('init');
  assert.equal(init.sessionId, CHAT);
  assert.ok(w.indexOf(init) < w.indexOf(w.find('meta')));
  assert.equal(w.find('meta').sessionId, CHAT);
  assert.ok(await s.contextUsage(), 'the usage Codex replays on resume fills the ring before any turn');
  s.send('again');
  await idle(w);
  assert.equal(w.of('init').length, 1, 'init is said once per start, not again for the turn');
  assert.equal(fake.sent('turn/start')[0].params.threadId, CHAT);
});

test('warm() then send(), and send() during warm(), use one start', async () => {
  const { s, fake, w } = make();
  const warming = s.warm();
  const again = s.warm();
  s.send('early');
  assert.equal((await warming).ok, true);
  assert.equal((await again).ok, true);
  await idle(w);
  assert.equal(fake.spawns.length, 1);
  assert.equal(fake.sent('thread/start').length, 1);
  assert.equal(w.of('meta').filter((m) => m.commands).length, 1);
  const meta = w.find('meta');
  assert.deepEqual(
    { ...meta, seq: undefined, startupMs: undefined, commands: meta.commands.map((c) => c.name) },
    { kind: 'meta', engine: 'codex', commands: ['compact', 'review', 'goal'], mode: 'default', sessionId: null, model: 'gpt-6.1-sol', effort: 'high', fastState: 'off', fastReason: null,
      version: '0.153.4', account: { type: 'apiKey', email: null, plan: null }, startupMs: undefined, restricted: false, codeBlocked: null, seq: undefined },
  );
  assert.ok(!('models' in meta), 'Claude\'s model list lives in that field in the window: a Codex chat must not overwrite it');
  assert.deepEqual(await s.warm(), { ok: true, startupMs: s.startupMs }, 'a warm chat answers at once');
  assert.equal(fake.spawns.length, 1);
});

test('warm({delayMs}) starts later, and a send first cancels nothing', async () => {
  const { s, fake } = make();
  assert.deepEqual(await s.warm({ delayMs: 40 }), { ok: true, scheduled: true });
  assert.equal(fake.spawns.length, 0);
  await until(() => fake.sent('thread/start').length === 1, 2000, 'the delayed start');
});

// ---- several sends ----

test('two sends before the thread is ready: the first starts the turn, the second is folded into it', async () => {
  const { s, fake, w } = make({ extended: ['send-state'] }, { holdTurns: true });
  const a = s.send('one');
  const b = s.send('two');
  await until(() => fake.sent('turn/steer').length === 1, 2000, 'turn/steer');
  const turn = fake.last.turn;
  assert.equal(fake.sent('turn/start').length, 1);
  assert.equal(textOf(fake.sent('turn/start')[0]), 'one');
  assert.deepEqual(fake.sent('turn/steer')[0].params, { threadId: s.threadId, input: [{ type: 'text', text: 'two', text_elements: [] }], expectedTurnId: turn.id });
  const order = fake.received.map((m) => m.method);
  assert.ok(order.indexOf('turn/steer') > order.indexOf('turn/start'));
  await settle();
  fake.last.playText('both');
  await idle(w);
  assert.deepEqual(w.find('turn-end').userUuids, [a.id, b.id]);
  assert.deepEqual(sendStates(w, b.id), ['pending', 'written', 'started', 'completed']);
  assert.equal(w.of('turn-end').length, 1);
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false).length, 1);
});

test('sending while a turn runs is turn/steer with that turn\'s id', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  const mark = w.mark();
  const r = s.send('and also');
  assert.equal(r.ok, true);
  await until(() => fake.sent('turn/steer').length === 1);
  assert.equal(fake.sent('turn/steer')[0].params.expectedTurnId, fake.last.turn.id);
  assert.deepEqual(fake.last.turn.inputs.map((i) => i[0].text), ['first', 'and also']);
  assert.equal(w.all((e) => e.kind === 'busy', mark).length, 0, 'still the same busy turn: no flapping');
  assert.equal(fake.sent('turn/start').length, 1);
  fake.last.playText();
  await idle(w);
});

test('a steer Codex refuses starts the next turn instead, with turn-end before any idle', async () => {
  const { s, fake, w } = make({ extended: ['send-state'] }, { holdTurns: true, errors: { 'turn/steer': { message: 'turn is not steerable' } } });
  const a = s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  const b = s.send('second');
  await until(() => fake.sent('turn/steer').length === 1);
  await settle();
  assert.equal(fake.sent('turn/steer').length, 1, 'it is not asked again and again');
  assert.equal(w.of('error').length, 0, 'a refused steer is not an error to the user');
  assert.equal(s.outbox.get(b.id).state, 'pending');
  fake.last.playText('one');
  await until(() => fake.sent('turn/start').length === 2, 2000, 'the second turn');
  assert.equal(textOf(fake.sent('turn/start')[1]), 'second');
  const firstEnd = w.find('turn-end');
  assert.deepEqual(firstEnd.userUuids, [a.id]);
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false).length, 0, 'the chat never said it was free between the two');
  await w.waitFor('message-start', { ms: 2000, from: w.indexOf(firstEnd) });
  fake.last.playText('two');
  await idle(w);
  assert.deepEqual(w.of('turn-end').map((e) => e.userUuids), [[a.id], [b.id]]);
  assert.deepEqual(sendStates(w, b.id), ['pending', 'written', 'pending', 'written', 'started', 'completed']);
});

test('a steer that gets no answer is handed back, never sent twice', async () => {
  const { s, fake, w } = make({ timeouts: { turn: 250 } }, { holdTurns: true, hang: ['turn/steer'] });
  s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  const b = s.send('second');
  const err = await w.waitFor('error', { ms: 2000 });
  assert.equal(err.code, 'send-failed');
  assert.deepEqual(err.prompt, { id: b.id, text: 'second' });
  assert.equal(s.busy, true, 'the turn itself carries on');
  fake.last.playText();
  await idle(w);
  assert.equal(fake.sent('turn/start').length, 1);
});

test('a steer still unanswered when the chat is force-stopped is handed back, and the chat is not left busy over it', async () => {
  const { s, fake, w } = make({ extended: ['send-state'], timeouts: { turn: 60000, interrupt: 60, stopWatch: 5000 } }, { holdTurns: true, hang: ['turn/steer', 'turn/interrupt'] });
  s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  const b = s.send('second');
  await until(() => fake.sent('turn/steer').length === 1, 2000, 'the steer');
  assert.deepEqual(s.snapshot().outbox.map((e) => [e.text, e.state]), [['first', 'started'], ['second', 'written']]);
  await s.interrupt(); // Codex answers neither: the interrupt times out and the process is ended
  await w.waitFor((e) => e.kind === 'stopped' && e.reason === 'force-stop', { ms: 3000 });
  const err = w.find((e) => e.kind === 'error' && e.code === 'send-failed');
  assert.deepEqual(err?.prompt, { id: b.id, text: 'second' }, 'the message is handed back, not lost in silence');
  assert.deepEqual(sendStates(w, b.id), ['pending', 'written', 'failed']);
  assert.deepEqual(s.snapshot().outbox, []);
  assert.equal(s.busy, false);

  // The next turn ends in a free chat, and the old message is never sent on its own later.
  fake.holdTurns = false; fake.hang.clear();
  const mark = w.mark();
  s.send('third');
  await idle(w, mark);
  assert.deepEqual([s.busy, s.state, s.snapshot().outbox.length], [false, 'idle', 0]);
  fake.last.die?.(1);
  await settle(60);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['first', 'third']);
});

test('stop() with a steer in flight hands it back too', async () => {
  const { s, fake, w } = make({ timeouts: { turn: 60000 } }, { holdTurns: true, hang: ['turn/steer'] });
  s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  const b = s.send('second');
  await until(() => fake.sent('turn/steer').length === 1, 2000, 'the steer');
  await s.stop({ graceMs: 50 });
  assert.deepEqual(w.find((e) => e.kind === 'error' && e.code === 'send-failed')?.prompt, { id: b.id, text: 'second' });
  assert.deepEqual([s.busy, s.snapshot().outbox.length], [false, 0]);
});

test('send() checks its input like a Claude chat does', async () => {
  const { s, fake, w } = make();
  const bad = [
    [5, []], ['', []], ['   ', []], ['x'.repeat(1024 * 1024 + 1), []], ['hi', 'nope'], ['hi', new Array(21).fill({ mediaType: 'image/png', data: 'AAAA' })],
    ['hi', [{ mediaType: 'image/bmp', data: 'AAAA' }]], ['hi', [{ mediaType: 'image/png', data: 'not base64!' }]], ['hi', [null]], ['hi', [], 'opts'], ['hi', [], { id: 'not-a-uuid' }],
  ];
  for (const [text, images, opts] of bad) {
    const r = s.send(text, images, opts);
    assert.deepEqual([r.ok, r.code], [false, 'invalid-input'], JSON.stringify(String(text).slice(0, 20)));
  }
  assert.equal(s.busy, false);
  assert.equal(w.of('error').length, bad.length);
  assert.equal(fake.spawns.length, 0, 'nothing was started for a message that cannot be sent');
  const id = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(s.send('hi', null, { id }), { ok: true, id });
  assert.equal(s.send('hi again', [], { id }).code, 'invalid-input', 'the same id twice');
  await idle(w);
});

test('images go as data URLs after the text; an image alone sends no empty text', async () => {
  const { s, fake, w } = make();
  s.send('look', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { mediaType: 'image/jpeg', data: '/9j/4AAQ' }]);
  await idle(w);
  assert.deepEqual(fake.sent('turn/start')[0].params.input, [
    { type: 'text', text: 'look', text_elements: [] },
    { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
    { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQ' },
  ]);
  const mark = w.mark();
  s.send('', [{ mediaType: 'image/webp', data: 'UklGRg==' }]);
  await idle(w, mark);
  assert.deepEqual(fake.sent('turn/start')[1].params.input, [{ type: 'image', url: 'data:image/webp;base64,UklGRg==' }]);
});

// ---- settings on the wire ----

const ASK_ALL = { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } };
const MODE_CASES = [
  ['default', { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' }, READ_ONLY, null],
  ['acceptEdits', { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' }, WORKSPACE, null],
  ['plan', { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' }, READ_ONLY, 'plan'],
  ['auto', { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' }, WORKSPACE, null],
  // Not 'never': under it Codex turns down every MCP server's question itself (Computer Use's "may I use this app?").
  ['bypassPermissions', { approvalPolicy: ASK_ALL, approvalsReviewer: 'user', sandbox: 'danger-full-access' }, { type: 'dangerFullAccess' }, null],
];
for (const [mode, start, policy, collab] of MODE_CASES) {
  test(`mode ${mode}: thread/start takes the sandbox as a word, turn/start as an object`, async () => {
    const { s, fake, w } = make({ permissionMode: mode, allowBypass: true });
    s.send('go');
    await idle(w);
    assert.deepEqual(fake.sent('thread/start')[0].params, { cwd: work, ...start, serviceTier: null, ...NOTE, ...CAP });
    const turn = fake.sent('turn/start')[0].params;
    const expected = {
      threadId: s.sessionId, input: [{ type: 'text', text: 'go', text_elements: [] }],
      approvalPolicy: start.approvalPolicy, approvalsReviewer: start.approvalsReviewer, sandboxPolicy: policy, serviceTier: null,
      // The effort is the user's own, as the thread opened with it: null there would clear it.
      ...(collab && { collaborationMode: { mode: collab, settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', developer_instructions: null } } }),
    };
    assert.deepEqual(turn, expected);
    assert.equal(w.find('init').permissionMode, mode);
    assert.equal(w.find('meta').mode, mode);
    assert.equal(s.snapshot().mode, mode);
  });
}

test('with no mode chosen a chat is Ask, and Full Access needs allowBypass even in the constructor', async () => {
  const { s, fake, w } = make({ permissionMode: 'bypassPermissions' });
  assert.equal(s.mode, 'default');
  s.send('go');
  await idle(w);
  assert.equal(fake.sent('thread/start')[0].params.sandbox, 'read-only');
  assert.deepEqual(fake.sent('turn/start')[0].params.sandboxPolicy, READ_ONLY);
  assert.equal(fake.sent('turn/start')[0].params.approvalPolicy, 'on-request');
});

test('the mode travels with every turn, so a change made between turns applies to the next one', async () => {
  const { s, fake, w } = make({ allowBypass: true });
  s.send('one');
  await idle(w);
  let mark = w.mark();
  assert.deepEqual(await s.set('permissionMode', 'auto'), { ok: true, applied: 'next-turn' });
  assert.deepEqual(w.find('setting', mark), { kind: 'setting', key: 'permissionMode', value: 'auto', seq: w.find('setting', mark).seq });
  await until(() => fake.sent('thread/settings/update').length === 1);
  assert.deepEqual(fake.sent('thread/settings/update')[0].params, { threadId: s.sessionId, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: WORKSPACE }, 'an open thread is told now too');
  s.send('two');
  await idle(w, mark);
  assert.equal(fake.sent('turn/start')[1].params.approvalsReviewer, 'auto_review');
  mark = w.mark();
  await s.set('permissionMode', 'default');
  s.send('three');
  await idle(w, mark);
  const third = fake.sent('turn/start')[2].params;
  assert.equal(third.approvalsReviewer, 'user', 'leaving Auto really leaves it: the reviewer is always sent');
  assert.deepEqual(third.sandboxPolicy, READ_ONLY);
  assert.equal(s.snapshot().settings.permissionMode, 'default');
});

test('plan mode on a new thread: sent when it is chosen, then only when plan-ness changes', async () => {
  const { s, fake, w } = make();
  const run = async (text) => { const mark = w.mark(); s.send(text); await idle(w, mark); return fake.sent('turn/start').at(-1).params; };
  assert.ok(!('collaborationMode' in await run('a')), 'a new thread starts in default: nothing to say');
  await s.set('permissionMode', 'plan');
  const planned = await run('b');
  assert.deepEqual(planned.collaborationMode, { mode: 'plan', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', developer_instructions: null } });
  assert.deepEqual(planned.sandboxPolicy, READ_ONLY);
  assert.ok(!fake.sent('thread/settings/update').some((m) => 'collaborationMode' in m.params), 'plan-ness goes with the turn, not with the settings update');
  assert.ok(!('collaborationMode' in await run('c')), 'still plan: switching installs a note in the chat, so it is not sent again');
  await s.set('permissionMode', 'acceptEdits');
  assert.equal((await run('d')).collaborationMode.mode, 'default', 'leaving plan says so once');
  assert.ok(!('collaborationMode' in await run('e')));
});

test('plan mode on a resumed thread: its first turn always says, because what it was left in is not reported', async () => {
  const { s, fake, w } = make({ resume: CHAT, model: 'gpt-6-luna', effort: 'low' }, { known: [CHAT] });
  const run = async (text) => { const mark = w.mark(); s.send(text); await idle(w, mark); return fake.sent('turn/start').at(-1).params; };
  assert.deepEqual((await run('a')).collaborationMode, { mode: 'default', settings: { model: 'gpt-6-luna', reasoning_effort: 'low', developer_instructions: null } });
  assert.ok(!('collaborationMode' in await run('b')));
  // Codex says the thread is in plan mode after all (changed from somewhere else): the next turn puts it back.
  fake.last.note('thread/settings/updated', { threadId: CHAT, threadSettings: { model: 'gpt-6-luna', effort: 'low', serviceTier: 'ultrafast', collaborationMode: { mode: 'plan', settings: {} } } });
  await settle();
  assert.equal((await run('c')).collaborationMode.mode, 'default');
});

test('a collaboration mode never clears the user\'s own effort: a reopened chat and Plan mode carry it, and the chip keeps telling the truth', async () => {
  // Nothing chosen in Canopy. The first turn of a reopened chat always says its collaboration mode.
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT] });
  const run = async (text) => { const mark = w.mark(); s.send(text); await idle(w, mark); return fake.sent('turn/start').at(-1).params; };
  const first = await run('a');
  assert.deepEqual(first.collaborationMode, { mode: 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', developer_instructions: null } });
  assert.ok(!('effort' in first), 'the effort itself is still not chosen for them');
  assert.equal(fake.last.settings.effort, 'high', 'Codex still runs with the user\'s own effort');
  assert.equal(s.snapshot().meta.effort, 'high');
  await s.set('permissionMode', 'plan');
  assert.equal((await run('b')).collaborationMode.settings.reasoning_effort, 'high');
  assert.equal(fake.last.settings.effort, 'high');

  // Codex says the effort is gone (cleared from somewhere else): the chip says so, and the next mode change restores it.
  fake.last.note('thread/settings/updated', { threadId: CHAT, threadSettings: { model: 'gpt-6.1-sol', effort: null, serviceTier: 'ultrafast', collaborationMode: { mode: 'plan', settings: {} } } });
  await settle();
  assert.equal(s.snapshot().meta.effort, null, 'what Codex says it runs with, even when that is nothing');
  await s.set('permissionMode', 'default');
  assert.equal((await run('c')).collaborationMode.settings.reasoning_effort, 'high');

  // A user with no effort of their own: there is nothing to keep, so nothing is made up.
  const bare = make({ permissionMode: 'plan' }, { configEffort: null });
  bare.s.send('go');
  await idle(bare.w);
  assert.equal(bare.fake.sent('turn/start')[0].params.collaborationMode.settings.reasoning_effort, null);
});

test('Accept Edits keeps the user\'s own workspace-write settings instead of switching their network access off', async () => {
  const own = { writable_roots: ['/Users/test/shared'], network_access: true, exclude_tmpdir_env_var: false, exclude_slash_tmp: true };
  const theirs = { type: 'workspaceWrite', writableRoots: ['/Users/test/shared'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: true };
  // A chat that opens in workspace-write resends what thread/start answered.
  const direct = make({ permissionMode: 'acceptEdits' }, { configSandbox: own });
  direct.s.send('go');
  await idle(direct.w);
  assert.equal(direct.fake.sent('thread/start')[0].params.sandbox, 'workspace-write', 'the thread still opens with the word');
  assert.deepEqual(direct.fake.sent('turn/start')[0].params.sandboxPolicy, theirs);

  // A chat that opens in Ask never sees that answer: the user's config says what their workspace-write is.
  const { s, fake, w } = make({}, { configSandbox: own });
  await s.warm();
  assert.deepEqual(fake.sent('config/read')[0].params, { includeLayers: false, cwd: work });
  await s.set('permissionMode', 'acceptEdits');
  await until(() => fake.sent('thread/settings/update').length === 1, 2000, 'the settings update');
  assert.deepEqual(fake.sent('thread/settings/update')[0].params.sandboxPolicy, theirs);
  s.send('go');
  await idle(w);
  assert.deepEqual(fake.sent('turn/start')[0].params.sandboxPolicy, theirs);
  await s.set('permissionMode', 'default');
  const mark = w.mark();
  s.send('again');
  await idle(w, mark);
  assert.deepEqual(fake.sent('turn/start')[1].params.sandboxPolicy, READ_ONLY, 'Ask is still read-only');

  // No answer from config/read, or no such section: the plain sandbox, and the chat starts all the same.
  const none = make({ permissionMode: 'acceptEdits' }, { hang: ['config/read'] });
  none.s.t.meta = 60;
  none.s.send('go');
  await idle(none.w);
  assert.deepEqual(none.fake.sent('turn/start')[0].params.sandboxPolicy, WORKSPACE);
});

test('every thread is told the facts about Canopy, after the user\'s own developer instructions', async () => {
  // The benchmarked wording, with no maker named: one changed character re-bills every chat.
  assert.equal(CANOPY_FACTS_NEUTRAL, [
    'You\'re running inside Canopy, a Mac app for working with AI coding agents.',
    '- The user reads your last message first; earlier steps are collapsed. Put everything they need there: the result, what\'s left, what you need from them.',
    '- The user may run several chats at once. If a message seems meant for another chat, ask.',
    '- For unrelated work, you can suggest starting a new chat.',
    '- A shell command in a ```bash block of yours has a Run button: the user can run it in a terminal inside Canopy, in this folder, and what it prints comes back to you. When a step needs a terminal you can\'t use (a sign-in that opens the browser, a command that asks questions), give it that way and say to click Run, instead of asking them to open the Terminal app.',
    '- For inline visuals in Canopy, use mcp__canopy__read_me and mcp__canopy__show_widget when available. The bundled Codex Visualize skill targets a different renderer. Link to saved files with Markdown.',
  ].join('\n'));
  assert.equal(CANOPY_FACTS_NEUTRAL.split('\n').slice(1, -1).join('\n'), CANOPY_FACTS.split('\n').slice(1).join('\n'), 'shared facts match a Claude chat\'s');

  // A new chat and a reopened one say the same thing.
  const fresh = make();
  await fresh.s.warm();
  assert.equal(fresh.fake.sent('thread/start')[0].params.developerInstructions, CANOPY_FACTS_NEUTRAL);
  const again = make({ resume: CHAT }, { known: [CHAT] });
  await again.s.warm();
  assert.equal(again.fake.sent('thread/resume')[0].params.developerInstructions, CANOPY_FACTS_NEUTRAL);

  // The thread takes one text, in place of the user's own: theirs go first, whole.
  const theirs = make({}, { configNote: 'Always answer in French.' });
  await theirs.s.warm();
  assert.equal(theirs.fake.sent('thread/start')[0].params.developerInstructions, `Always answer in French.\n\n${CANOPY_FACTS_NEUTRAL}`);

  // Their config could not be read: nothing is sent, so their own instructions stand.
  const unread = make({}, { hang: ['config/read'] });
  unread.s.t.meta = 60;
  await unread.s.warm();
  assert.ok(!('developerInstructions' in unread.fake.sent('thread/start')[0].params));
});

test('init says what the chat runs with now: a model or Fast choice made before the first message is in it', async () => {
  const { s, w } = make();
  await s.warm();
  assert.equal(w.find('meta').model, 'gpt-6.1-sol');
  assert.deepEqual(await s.set('model', 'gpt-6-luna'), { ok: true, applied: 'next-turn' });
  assert.deepEqual(await s.set('fast', false), { ok: true, applied: 'next-turn' });
  s.send('hi');
  await idle(w);
  const init = w.find('init');
  assert.deepEqual([init.model, init.fastState, init.sessionId], ['gpt-6-luna', 'off', s.sessionId]);
  assert.equal(init.effort, 'high', 'a value nobody chose stays as the thread opened with it');
});

test('unset model and effort are not on the wire: they are the user\'s own; Fast never touched is standard speed', async () => {
  const { s, fake, w } = make();
  s.send('go');
  await idle(w);
  for (const params of [fake.sent('thread/start')[0].params, fake.sent('turn/start')[0].params]) {
    for (const key of ['model', 'effort', 'serviceTierForTurn', 'summary']) assert.ok(!(key in params), `${key} is not sent`);
    assert.equal(params.serviceTier, null, 'Canopy has one speed switch, Fast: the user\'s own tier (Ultrafast here) is never used');
  }
  assert.equal(w.find('meta').fastState, 'off', 'Fast was never turned on, and the chip says so');
  assert.equal(s.snapshot().settings.fast, undefined);
});

test('chosen model, effort and Fast go with the thread and with every turn', async () => {
  const { s, fake, w } = make({ model: 'gpt-6-luna', effort: 'low', fast: true });
  s.send('one');
  await idle(w);
  assert.deepEqual(fake.sent('thread/start')[0].params, { cwd: work, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', model: 'gpt-6-luna', serviceTier: 'priority', ...NOTE, ...CAP });
  const first = fake.sent('turn/start')[0].params;
  assert.deepEqual([first.model, first.effort, first.serviceTier], ['gpt-6-luna', 'low', 'priority']);
  const mark = w.mark();
  s.send('two');
  await idle(w, mark);
  const second = fake.sent('turn/start')[1].params;
  assert.deepEqual([second.model, second.effort, second.serviceTier], ['gpt-6-luna', 'low', 'priority'], 'again on the second turn: a resumed chat reports the config effort otherwise');
  assert.equal(w.find('assistant-text').model, 'gpt-6-luna');
});

test('Fast off is serviceTier null (standard), which is not the same as unset', async () => {
  const { s, fake, w } = make({ fast: false });
  s.send('go');
  await idle(w);
  const start = fake.sent('thread/start')[0].params;
  const turn = fake.sent('turn/start')[0].params;
  assert.ok('serviceTier' in start && start.serviceTier === null);
  assert.ok('serviceTier' in turn && turn.serviceTier === null);
  assert.equal(w.find('meta').fastState, 'off');
});

test('a choice that is unset again goes back to what the thread opened with, once', async () => {
  const { s, fake, w } = make();
  const run = async (text) => { const mark = w.mark(); s.send(text); await idle(w, mark); return fake.sent('turn/start').at(-1).params; };
  await run('a');
  await s.set('effort', 'low');
  await s.set('fast', false);
  const chosen = await run('b');
  assert.deepEqual([chosen.effort, chosen.serviceTier], ['low', null]);
  await s.set('effort', '');
  await s.set('fast', null);
  const back = await run('c');
  assert.deepEqual([back.effort, back.serviceTier], ['high', null], 'Codex keeps a setting until told otherwise, so "unset" has to say the user\'s own effort; Fast unset is standard speed');
  const after = await run('d');
  assert.ok(!('effort' in after), 'and then no effort is sent');
  assert.equal(after.serviceTier, null, 'the speed is always said: standard unless Fast is on');
});

// ---- set() ----

test('set(model): checked against this process\'s own model list', async () => {
  const { s, fake, w } = make();
  assert.deepEqual(await s.set('model', 'anything-goes'), { ok: true, applied: 'next-turn' }, 'before Codex has started there is no list to check against');
  assert.equal(s.model, 'anything-goes');
  await s.set('model', '');
  await s.warm();
  let mark = w.mark();
  const r = await s.set('model', 'claude-sonnet-9');
  assert.deepEqual([r.ok, r.code], [false, 'invalid-input']);
  assert.deepEqual(w.all((e) => true, mark).map((e) => [e.kind, e.text ?? e.key, e.value]), [
    ['notice', 'Could not change model: Codex does not offer "claude-sonnet-9".', undefined],
    ['setting-failed', 'model', undefined],
  ]);
  assert.equal(s.settings.model, undefined);

  mark = w.mark();
  assert.deepEqual(await s.set('model', 'gpt-6-luna'), { ok: true, applied: 'next-turn' });
  assert.deepEqual(w.find('setting', mark).value, 'gpt-6-luna');
  assert.equal(s.model, 'gpt-6-luna');
  assert.equal(s.snapshot().meta.model, 'gpt-6-luna');
  await until(() => fake.sent('thread/settings/update').length === 1);
  assert.deepEqual(fake.sent('thread/settings/update')[0].params, { threadId: s.threadId, model: 'gpt-6-luna' });
  assert.equal((await s.set('model', 'x'.repeat(201))).ok, false);
  assert.equal((await s.set('model', { id: 'gpt-6-luna' })).ok, false);
  assert.equal(s.settings.model, 'gpt-6-luna', 'a refused change leaves the choice as it was');
  assert.equal(w.all((e) => e.kind === 'setting-failed').at(-1).value, 'gpt-6-luna');
});

test('a model chosen before the start that Codex does not offer is dropped, and said so', async () => {
  const { s, fake, w } = make({ model: 'sonnet', effort: 'low' });
  s.send('go');
  await idle(w);
  assert.ok(!('model' in fake.sent('thread/start')[0].params), 'Codex is never asked to run a model it does not have');
  assert.ok(!('model' in fake.sent('turn/start')[0].params));
  assert.equal(w.find((e) => e.kind === 'notice' && /does not offer "sonnet"/.test(e.text)).level, 'warn');
  assert.deepEqual([w.find('setting-failed').key, w.find('setting-failed').value], ['model', '']);
  assert.equal(fake.sent('turn/start')[0].params.effort, 'low', 'the other choices stand');
});

test('set(effort): only a level the model in use offers; a model change drops one it lacks', async () => {
  const { s, w } = make();
  await s.warm(); // the model in use is gpt-6.1-sol, which offers ultra
  assert.deepEqual(await s.set('effort', 'ultra'), { ok: true, applied: 'next-turn' });
  let mark = w.mark();
  const r = await s.set('effort', 'turbo');
  assert.deepEqual([r.ok, r.code], [false, 'invalid-input']);
  assert.deepEqual([w.find('setting-failed', mark).key, w.find('setting-failed', mark).value], ['effort', 'ultra']);
  assert.match(w.find('notice', mark).text, /^Could not change effort: this model does not offer "turbo"\./);
  for (const bad of [5, 'NOT A LEVEL', {}, 'x'.repeat(40)]) assert.equal((await s.set('effort', bad)).ok, false);

  mark = w.mark();
  assert.equal((await s.set('model', 'gpt-6-luna')).ok, true); // luna has no ultra
  assert.deepEqual(w.all('setting', mark).map((e) => [e.key, e.value]), [['model', 'gpt-6-luna'], ['effort', '']]);
  assert.equal(s.settings.effort, undefined);
  assert.equal((await s.set('effort', 'ultra')).ok, false);
  assert.equal((await s.set('effort', 'max')).ok, true);
  assert.equal((await s.set('effort', null)).ok, true);
  assert.equal(s.settings.effort, undefined);
});

test('set(fast): on, off, unset, and not on a model with no faster tier', async () => {
  const models = [...recordedModels(), { id: 'slow-1', model: 'slow-1', displayName: 'Slow', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], serviceTiers: [] }];
  const { s, fake, w } = make({}, { models });
  await s.warm();
  assert.deepEqual(await s.set('fast', true), { ok: true, applied: 'next-turn' });
  assert.equal(w.find('setting').value, true);
  await until(() => fake.sent('thread/settings/update').length === 1);
  assert.deepEqual(fake.sent('thread/settings/update')[0].params, { threadId: s.threadId, serviceTier: 'priority' });
  await s.set('fast', false);
  await until(() => fake.sent('thread/settings/update').length === 2);
  assert.deepEqual(fake.sent('thread/settings/update')[1].params, { threadId: s.threadId, serviceTier: null });
  assert.equal(s.snapshot().meta.fastState, 'off');
  assert.equal((await s.set('fast', 'yes')).ok, false);

  await s.set('model', 'slow-1');
  const mark = w.mark();
  const r = await s.set('fast', true);
  assert.deepEqual([r.ok, r.code], [false, 'invalid-input']);
  assert.equal(w.find('notice', mark).text, 'Could not change fast: this model has no faster tier.');
  assert.deepEqual([w.find('setting-failed', mark).key, w.find('setting-failed', mark).value], ['fast', false]);
  assert.equal((await s.set('fast', undefined)).ok, true);
  assert.equal(s.settings.fast, undefined);
});

test('Fast left on when the model changes to one without the tier runs at standard speed', async () => {
  const models = [...recordedModels(), { id: 'slow-1', model: 'slow-1', supportedReasoningEfforts: [], serviceTiers: [] }];
  const { s, fake, w } = make({ fast: true }, { models });
  await s.warm();
  await s.set('model', 'slow-1');
  s.send('go');
  await idle(w);
  const turn = fake.sent('turn/start')[0].params;
  assert.deepEqual([turn.model, turn.serviceTier], ['slow-1', null]);
});

test('set(permissionMode): the five modes, and Full Access only where it is allowed', async () => {
  const { s, w } = make();
  for (const mode of ['acceptEdits', 'plan', 'auto', 'default']) assert.deepEqual(await s.set('permissionMode', mode), { ok: true, applied: 'next-turn' });
  await s.set('permissionMode', 'plan');
  const mark = w.mark();
  const r = await s.set('permissionMode', 'bypassPermissions');
  assert.deepEqual([r.ok, r.code], [false, 'not-allowed']);
  assert.equal(w.find('notice', mark).text, BYPASS_NOTICE, 'said in its final words: the one switch for Full Access lives in Claude Code\'s settings');
  assert.deepEqual([w.find('setting-failed', mark).key, w.find('setting-failed', mark).value], ['permissionMode', 'plan'], 'the mode shown goes back to the one in use');
  assert.equal(s.mode, 'plan');
  for (const bad of ['dontAsk', 'nonsense', '', null, 5]) assert.equal((await s.set('permissionMode', bad)).code, 'invalid-input');
  assert.equal(s.mode, 'plan');

  const allowed = make({ allowBypass: true });
  assert.equal((await allowed.s.set('permissionMode', 'bypassPermissions')).ok, true);
  assert.equal(allowed.s.mode, 'bypassPermissions');
});

test('settings only Claude has are accepted in silence: not one event', async () => {
  const { s, fake, w } = make();
  await s.warm();
  const mark = w.mark();
  for (const key of ['ultracode', 'codeMode', 'outputStyle', 'agent', 'thinking', 'suggestions', 'fallbackModel', 'maxBudgetUsd', 'maxTurns', 'additionalDirectories']) {
    assert.deepEqual(await s.set(key, true), { ok: true, applied: 'ignored' }, key);
  }
  assert.deepEqual(w.all(() => true, mark), [], 'a setting-failed for codeMode would switch Code Mode off for Claude chats too');
  assert.equal(fake.sent('thread/settings/update').length, 0);
  assert.deepEqual(await s.configure({ codeMode: true, permissionMode: 'acceptEdits', effort: 'low' }), { ok: true, failed: [] });
  assert.equal(s.mode, 'acceptEdits');
});

test('an unknown setting fails with a notice, and configure() reports which keys failed', async () => {
  const { s, w } = make();
  const r = await s.set('nonsense', 1);
  assert.deepEqual([r.ok, r.code], [false, 'invalid-input']);
  assert.equal(w.find('notice').text, 'Could not change nonsense: unknown setting');
  assert.deepEqual(await s.configure({ nonsense: 1, permissionMode: 'plan', effort: 5 }), { ok: false, failed: ['nonsense', 'effort'] });
  assert.equal((await s.configure('x')).code, 'invalid-input');
});

test('a settings update Codex refuses is logged, not shown: the next turn carries the settings anyway', async () => {
  const { s, fake, w, logs } = make({}, { errors: { 'thread/settings/update': { message: 'not now' } } });
  await s.warm();
  const mark = w.mark();
  assert.equal((await s.set('permissionMode', 'acceptEdits')).ok, true);
  await until(() => logs.some((l) => l.msg === 'settings update failed'));
  assert.deepEqual(w.all((e) => true, mark).map((e) => e.kind), ['setting']);
  s.send('go');
  await idle(w);
  assert.deepEqual(fake.sent('turn/start')[0].params.sandboxPolicy, WORKSPACE);
});

test('what Codex says it really runs with reaches the chip', async () => {
  const { s, fake, w } = make();
  await s.warm();
  const mark = w.mark();
  fake.last.note('thread/settings/updated', { threadId: s.threadId, threadSettings: { model: 'gpt-6-luna', effort: 'medium', serviceTier: 'default', collaborationMode: { mode: 'default', settings: {} } } });
  const meta = await w.waitFor('meta', { ms: 2000, from: mark });
  assert.deepEqual({ ...meta, seq: undefined }, { kind: 'meta', engine: 'codex', model: 'gpt-6-luna', effort: 'medium', fastState: 'off', seq: undefined });
  assert.equal(s.model, 'gpt-6-luna');
  fake.last.note('thread/settings/updated', { threadId: s.threadId, threadSettings: { model: 'gpt-6-luna', effort: 'medium', serviceTier: 'default' } });
  await settle();
  assert.equal(w.all('meta', mark).length, 1, 'the same again says nothing');
});

// ---- approvals and questions ----

test('a recorded command approval, replayed: the card, Allow, and the turn carrying on', async () => {
  const ids = recordedIds('codex-command-approval');
  const { s, fake, w } = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-command-approval') });
  s.send('Run this exact shell command: touch approved.txt');
  const card = await w.waitFor('permission', { ms: 3000 });
  assert.ok(card.id >= 1_000_000_000, 'an id no Claude session can count to');
  assert.equal(card.type, 'tool');
  assert.equal(card.toolName, 'Bash');
  assert.equal(card.input.command, 'touch approved.txt', 'the command the model typed, not the zsh wrapper');
  assert.equal(card.input.description, 'May I create approved.txt by running the exact command you requested?');
  assert.equal(card.engine, 'codex');
  assert.equal(card.sessionId, ids.threadId);
  assert.equal(card.hasSuggestions, true);
  assert.equal(s.pending.size, 1);
  assert.equal(s.snapshot().pending[0], card);
  assert.equal(s.snapshot().state, 'requires_action');
  assert.equal(w.of('busy').at(-1).state, 'requires_action');

  assert.deepEqual(s.respond(card.id, { action: 'allow' }), { ok: true });
  assert.equal(s.pending.size, 0);
  await idle(w);
  assert.deepEqual(fake.last.received.find((m) => !m.method && m.id === 0), { id: 0, result: { decision: 'accept' } });
  assert.deepEqual(w.of('permission-resolved').map((e) => [e.id, e.stale]), [[card.id, undefined]], 'resolved once: Codex\'s own serverRequest/resolved adds nothing');
  const start = w.find((e) => e.kind === 'tool-start' && e.name === 'Bash');
  const result = w.find((e) => e.kind === 'tool-result' && e.id === start.id);
  assert.ok(w.indexOf(card) > w.indexOf(start) && w.indexOf(result) > w.indexOf(card));
  assert.equal(w.find('turn-end').subtype, 'success');
  assert.equal(w.find('turn-end').text, 'DONE');
  const states = w.of('busy').map((e) => e.state);
  assert.deepEqual(states.filter((x, i) => x !== states[i - 1]), ['starting', 'running', 'requires_action', 'running', 'idle']);
});

test('a recorded file change approval, replayed: the card carries the diff of the edit it is about', async () => {
  const ids = recordedIds('codex-file-change-approval');
  const { s, fake, w } = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-file-change-approval') });
  s.send('change it');
  const card = await w.waitFor('permission', { ms: 3000 });
  assert.equal(card.toolName, 'Edit');
  assert.match(card.input.file_path, /notes\.txt$/);
  assert.match(card.input.diff, /^@@ /, 'the request itself has no diff: it is looked up from the open item');
  s.respond(card.id, { action: 'deny' });
  await idle(w);
  assert.deepEqual(fake.last.received.find((m) => !m.method && m.id === 0), { id: 0, result: { decision: 'decline' } });
  assert.equal(w.find('turn-end').subtype, 'success');
});

test('Deny lets the turn carry on where Codex offers that, and stops it where "cancel" is the only no', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;

  const q1 = commandAsk(child);
  const c1 = await w.waitFor('permission', { ms: 2000 });
  s.respond(c1.id, { action: 'deny' });
  assert.deepEqual((await q1.answer).result, { decision: 'decline' });
  assert.equal(s.busy, true);
  assert.equal(w.of('busy').at(-1).state, 'running');

  const q2 = commandAsk(child, { itemId: 'exec-2' });
  const c2 = await w.waitFor('permission', { ms: 2000, from: w.indexOf(c1) + 1 });
  s.respond(c2.id, { action: 'always', scope: 'session' });
  assert.deepEqual((await q2.answer).result, { decision: 'acceptForSession' });

  // The shape the recording showed in Ask mode: accept, the rule, and cancel. No decline.
  const q3 = commandAsk(child, { itemId: 'exec-3', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'a.txt'] } }, 'cancel'] });
  const c3 = await w.waitFor('permission', { ms: 2000, from: w.indexOf(c2) + 1 });
  assert.deepEqual(c3.alwaysPrefix, ['touch', 'a.txt']);
  s.respond(c3.id, { action: 'deny' });
  assert.deepEqual((await q3.answer).result, { decision: 'cancel' });
  // However Codex words the end of a turn the user ended, it is theirs, not a failure.
  child.completeTurn('failed', { error: { message: 'the turn was cancelled' } });
  await idle(w);
  const end = w.find('turn-end');
  assert.deepEqual([end.interrupted, end.isError, end.subtype, end.errors], [true, false, 'interrupted', []]);
  assert.equal(w.all((e) => e.kind === 'notice' && e.code === 'api-error').length, 0);
  assert.equal(w.of('error').length, 0);
});

test('a prompt answered elsewhere goes away, and answering it afterwards is stale', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const q = commandAsk(fake.last);
  const card = await w.waitFor('permission', { ms: 2000 });
  fake.last.note('serverRequest/resolved', { threadId: s.threadId, requestId: q.id });
  const gone = await w.waitFor('permission-resolved', { ms: 2000 });
  assert.deepEqual([gone.id, gone.stale], [card.id, undefined]);
  assert.equal(s.pending.size, 0);
  assert.equal(w.of('busy').at(-1).state, 'running');
  const mark = w.mark();
  assert.deepEqual(s.respond(card.id, { action: 'allow' }), { ok: false, code: 'stale', message: 'That request is no longer waiting for an answer.' });
  assert.deepEqual(w.find('permission-resolved', mark).stale, true);
  assert.equal(fake.last.received.filter((m) => !m.method).length, 0, 'nothing was sent to Codex for a stale answer');
  assert.equal(s.respond(12345, {}).code, 'stale');
  assert.equal(s.respond(undefined).code, 'stale');
  fake.last.playText();
  await idle(w);
});

test('a prompt still open when its turn ends is closed, and Codex is told no', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const q = commandAsk(fake.last);
  const card = await w.waitFor('permission', { ms: 2000 });
  fake.last.completeTurn();
  await idle(w);
  assert.deepEqual(w.of('permission-resolved').map((e) => e.id), [card.id]);
  assert.ok(w.indexOf(w.find('permission-resolved')) > w.indexOf(w.find('turn-end')));
  assert.deepEqual((await q.answer).result, { decision: 'cancel' });
  assert.equal(s.pending.size, 0);
});

test('a question from Codex is the question card, answered by the question\'s own id', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const q = fake.last.ask('item/tool/requestUserInput', {
    threadId: s.threadId, turnId: fake.last.turn.id, itemId: 'call_1',
    questions: [{ id: 'q-word', header: 'Word', question: 'Which word?', options: [{ label: 'world', description: 'the usual' }, { label: 'there', description: '' }] }],
  });
  const card = await w.waitFor('permission', { ms: 2000 });
  assert.deepEqual([card.type, card.toolName], ['question', 'AskUserQuestion']);
  assert.equal(card.input.questions[0].question, 'Which word?');
  s.respond(card.id, { action: 'answers', answers: { 'Which word?': 'world' } });
  assert.deepEqual((await q.answer).result, { answers: { 'q-word': { answers: ['world'] } } });
  fake.last.playText();
  await idle(w);
});

test('an MCP tool that needs a yes is an ordinary approval card, whatever the host asked for: Allow, Always allow, Deny', async () => {
  const meta = { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_description: 'Send a message' };
  const ask = (child, s, extra = {}) => child.ask('mcpServer/elicitation/request', {
    threadId: s.threadId, turnId: child.turn.id, serverName: 'slack', mode: 'form', message: 'Allow the slack MCP server to run tool "send_message"?',
    requestedSchema: { type: 'object', properties: {} }, _meta: meta, ...extra,
  });
  const { s, fake, w } = make({}, { holdTurns: true }); // no `elicitation` feature: main passes none for these chats
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  child.note('item/started', { threadId: s.threadId, turnId: child.turn.id, item: { type: 'mcpToolCall', id: 'call_9', server: 'slack', tool: 'send_message', status: 'inProgress', arguments: { channel: 'general', text: 'hi' }, result: null, error: null, durationMs: null } });
  await w.waitFor('tool-start', { ms: 2000 });

  const q = ask(child, s);
  const card = await w.waitFor('permission', { ms: 2000 });
  assert.deepEqual([card.type, card.toolName, card.toolUseId, card.hasSuggestions, card.mcpServer], ['tool', 'mcp__slack__send_message', 'call_9', true, 'slack']);
  assert.deepEqual(card.input, { channel: 'general', text: 'hi' });
  assert.equal(w.of('busy').at(-1).state, 'requires_action');
  assert.deepEqual(s.respond(card.id, { action: 'allow' }), { ok: true });
  assert.deepEqual((await q.answer).result, { action: 'accept', content: {}, _meta: null });
  assert.equal(w.of('busy').at(-1).state, 'running');

  const always = ask(child, s);
  const second = await w.waitFor((e) => e.kind === 'permission' && e.id !== card.id, { ms: 2000 });
  s.respond(second.id, { action: 'always' });
  assert.deepEqual((await always.answer).result, { action: 'accept', content: {}, _meta: { persist: 'always' } });

  // Codex offers nothing to remember: "Always allow" is not on the card, and a stray one is a plain yes.
  const once = ask(child, s, { _meta: { codex_approval_kind: 'mcp_tool_call' } });
  const third = await w.waitFor((e) => e.kind === 'permission' && e.id !== card.id && e.id !== second.id, { ms: 2000 });
  assert.equal(third.hasSuggestions, false);
  s.respond(third.id, { action: 'always' });
  assert.deepEqual((await once.answer).result, { action: 'accept', content: {}, _meta: null });

  const no = ask(child, s);
  const fourth = await w.waitFor((e) => e.kind === 'permission' && ![card.id, second.id, third.id].includes(e.id), { ms: 2000 });
  s.respond(fourth.id, { action: 'deny' });
  assert.deepEqual((await no.answer).result, { action: 'decline', content: null, _meta: null }, 'no lets the turn carry on');
  assert.equal(s.busy, true);
  child.playText();
  await idle(w);
  assert.equal(w.find('turn-end').isError, false);
});

test('an MCP elicitation is answered "cancel" at once without the feature, and is a card with it', async () => {
  const ask = (child, s) => child.ask('mcpServer/elicitation/request', { threadId: s.threadId, turnId: child.turn.id, serverName: 'docs', message: 'Sign in?', mode: 'form', requestedSchema: { type: 'object' } });
  const off = make({}, { holdTurns: true });
  off.s.send('go');
  await off.w.waitFor('message-start', { ms: 2000 });
  const q = ask(off.fake.last, off.s);
  assert.deepEqual((await within(q.answer, 1000, 'the answer')).result, { action: 'cancel', content: null, _meta: null });
  assert.equal(off.w.of('permission').length, 0, 'the window has no card for it');
  assert.equal(off.w.of('busy').at(-1).state, 'running');
  off.fake.last.playText();
  await idle(off.w);

  const on = make({ extended: ['elicitation'] }, { holdTurns: true });
  on.s.send('go');
  await on.w.waitFor('message-start', { ms: 2000 });
  const q2 = ask(on.fake.last, on.s);
  const card = await on.w.waitFor('permission', { ms: 2000 });
  assert.deepEqual([card.type, card.server, card.message], ['elicitation', 'docs', 'Sign in?']);
  on.s.respond(card.id, { action: 'elicit-accept', content: { ok: true } });
  assert.deepEqual((await q2.answer).result, { action: 'accept', content: { ok: true }, _meta: null });
  on.fake.last.playText();
  await idle(on.w);
});

// Computer Use's "may I use this app?", as its own source builds it (see mcpToolRequest in codex-adapter.mjs).
const appAsk = (child, s, extra = {}) => child.ask('mcpServer/elicitation/request', {
  threadId: s.threadId, turnId: child.turn.id, serverName: 'cua_repl', mode: 'form', message: 'Allow Computer Use to use "Google Chrome"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use', persist: ['session', 'always'], riskLevel: 'low',
    tool_name: 'get_app_state', tool_params: { app: 'com.google.Chrome' }, tool_params_display: [{ name: 'app', display_name: 'App', value: 'Google Chrome' }],
  },
  ...extra,
});

test('Computer Use asking to use an app is a plain approval card: Allow, Always allow, Deny', async () => {
  const { s, fake, w } = make({ extended: ['tasks', 'elicitation'] }, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  const q = appAsk(child, s);
  const card = await w.waitFor('permission', { ms: 2000 });
  assert.deepEqual([card.type, card.plain, card.title, card.app, card.reason, card.hasSuggestions, card.alwaysForChat],
    ['tool', true, 'Computer Use wants to use Google Chrome', 'Google Chrome', 'Allow Computer Use to use "Google Chrome"?', true, undefined]);
  s.respond(card.id, { action: 'always' });
  assert.deepEqual((await q.answer).result, { action: 'accept', content: {}, _meta: { persist: 'always' } });

  const once = appAsk(child, s);
  const second = await w.waitFor((e) => e.kind === 'permission' && e.id !== card.id, { ms: 2000 });
  s.respond(second.id, { action: 'allow' });
  assert.deepEqual((await once.answer).result, { action: 'accept', content: {}, _meta: null });

  const no = appAsk(child, s);
  const third = await w.waitFor((e) => e.kind === 'permission' && ![card.id, second.id].includes(e.id), { ms: 2000 });
  s.respond(third.id, { action: 'deny' });
  assert.deepEqual((await no.answer).result, { action: 'decline', content: null, _meta: null });
  child.playText();
  await idle(w);
});

test('a form and a sign-in link from an MCP server are cards, answered in MCP\'s words', async () => {
  const { s, fake, w } = make({ extended: ['tasks', 'elicitation'] }, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  const schema = { type: 'object', required: ['title'], properties: {
    title: { type: 'string', title: 'Title' }, points: { type: 'integer', minimum: 0, default: 3 }, urgent: { type: 'boolean' },
    team: { type: 'string', oneOf: [{ const: 'eng', title: 'Engineering' }, { const: 'ops', title: 'Operations' }] },
  } };
  const form = child.ask('mcpServer/elicitation/request', { threadId: s.threadId, turnId: child.turn.id, serverName: 'linear', mode: 'form', message: 'New issue', requestedSchema: schema, _meta: null });
  const card = await w.waitFor('permission', { ms: 2000 });
  assert.deepEqual([card.type, card.ask, card.title, card.message, card.server], ['elicitation', 'form', 'Linear needs a few details', 'New issue', 'linear']);
  assert.deepEqual(card.fields.map((f) => [f.key, f.kind, f.label, f.required]), [['title', 'text', 'Title', true], ['points', 'number', 'Points', false], ['urgent', 'boolean', 'Urgent', false], ['team', 'choice', 'Team', false]]);
  assert.equal(w.of('busy').at(-1).state, 'requires_action');
  s.respond(card.id, { action: 'elicit-accept', content: { title: 'Fix it', points: '5', urgent: true, team: 'ops', extra: 'dropped' } });
  assert.deepEqual((await form.answer).result, { action: 'accept', content: { title: 'Fix it', points: 5, urgent: true, team: 'ops' }, _meta: null });

  const link = child.ask('mcpServer/elicitation/request', { threadId: s.threadId, turnId: child.turn.id, serverName: 'linear', mode: 'url', message: 'Sign in to Linear', url: 'https://linear.app/oauth', elicitationId: 'e-1', _meta: null });
  const second = await w.waitFor((e) => e.kind === 'permission' && e.id !== card.id, { ms: 2000 });
  assert.deepEqual([second.ask, second.url, second.title, second.fields], ['link', 'https://linear.app/oauth', 'Linear wants you to open a link', []]);
  s.respond(second.id, { action: 'elicit-accept' });
  assert.deepEqual((await link.answer).result, { action: 'accept', content: {}, _meta: null });

  // "Cancel" is cancel, "Deny" is decline, and a yes/no has no form.
  const confirm = child.ask('mcpServer/elicitation/request', { threadId: s.threadId, turnId: child.turn.id, serverName: 'docs', mode: 'form', message: 'Publish the page?', requestedSchema: { type: 'object', properties: {} }, _meta: null });
  const third = await w.waitFor((e) => e.kind === 'permission' && ![card.id, second.id].includes(e.id), { ms: 2000 });
  assert.deepEqual([third.ask, third.title, third.fields], ['confirm', 'Docs needs your OK', []]);
  s.respond(third.id, { action: 'elicit-decline' });
  assert.deepEqual((await confirm.answer).result, { action: 'decline', content: null, _meta: null });
  const walked = child.ask('mcpServer/elicitation/request', { threadId: s.threadId, turnId: child.turn.id, serverName: 'docs', mode: 'form', message: 'Again?', requestedSchema: schema, _meta: null });
  const fourth = await w.waitFor((e) => e.kind === 'permission' && ![card.id, second.id, third.id].includes(e.id), { ms: 2000 });
  s.respond(fourth.id, { action: 'elicit-cancel' });
  assert.deepEqual((await walked.answer).result, { action: 'cancel', content: null, _meta: null });
  child.playText();
  await idle(w);
});

test('a question that arrives while the turn is stopping is answered "cancel" and never shown', async () => {
  const { s, fake, w } = make({ extended: ['tasks', 'elicitation'] }, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  s.interrupt();
  const q = child.ask('mcpServer/elicitation/request', { threadId: s.threadId, turnId: child.turn.id, serverName: 'docs', mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }, _meta: null });
  assert.deepEqual((await within(q.answer, 1000, 'the answer')).result, { action: 'cancel', content: null, _meta: null });
  assert.equal(w.of('permission').length, 0);
});

test('Bypass says yes to what Codex asks for itself, and still shows what only the user can answer', async () => {
  const { s, fake, w } = make({ permissionMode: 'bypassPermissions', allowBypass: true, extended: ['tasks', 'elicitation'] },
    { holdTurns: true, configMcp: { slack: { tools: { send_message: { approval_mode: 'prompt' } } }, careful: { default_tools_approval_mode: 'prompt' } } });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  // A command, and one of the user's MCP tools: answered at once, no card.
  assert.deepEqual((await within(commandAsk(child).answer, 1000, 'the command')).result, { decision: 'accept' });
  const toolAsk = (server, tool) => child.ask('mcpServer/elicitation/request', {
    threadId: s.threadId, turnId: child.turn.id, serverName: server, mode: 'form', message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
  });
  assert.deepEqual((await within(toolAsk('github', 'create_issue').answer, 1000, 'the tool')).result, { action: 'accept', content: {}, _meta: null });
  assert.equal(w.of('permission').length, 0, 'nothing Bypass covers is shown');

  // Computer Use asking for an app is the user's to answer, in every mode.
  const app = appAsk(child, s);
  const card = await w.waitFor('permission', { ms: 2000 });
  assert.equal(card.title, 'Computer Use wants to use Google Chrome');
  s.respond(card.id, { action: 'allow' });
  assert.deepEqual((await app.answer).result, { action: 'accept', content: {}, _meta: null });

  // So is a tool their own Codex config says to ask about every time, by tool or for a whole server.
  for (const [server, tool] of [['slack', 'send_message'], ['careful', 'anything']]) {
    const mark = w.mark();
    const asked = toolAsk(server, tool);
    const shown = await w.waitFor('permission', { ms: 2000, from: mark });
    assert.equal(shown.toolName, `mcp__${server}__${tool}`);
    s.respond(shown.id, { action: 'deny' });
    assert.deepEqual((await asked.answer).result, { action: 'decline', content: null, _meta: null });
  }
  child.playText();
  await idle(w);
});

test('a request that is not a question for the user is refused, so its sender never hangs', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const q = fake.last.ask('some/new/request', { threadId: s.threadId });
  const answer = await within(q.answer, 1000, 'the refusal');
  assert.equal(answer.error.code, -32601);
  const other = fake.last.ask('item/commandExecution/requestApproval', { threadId: 'someone-elses-thread', itemId: 'x', command: 'ls' });
  assert.equal((await within(other.answer, 1000, 'the refusal')).error.code, -32601, 'a prompt for another thread is not this chat\'s to answer');
  assert.equal(w.of('permission').length, 0);
  fake.last.playText();
  await idle(w);
});

// ---- stopping ----

test('Stop is turn/interrupt: the streaming text is closed, the turn ends as interrupted, the process lives on', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  const sent = s.send('count');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  const turnId = child.turn.id;
  const itemId = child.streamText('', { open: true, pieces: ['1\n', '2\n', '3'] });
  await w.waitFor('text-delta', { ms: 2000 });

  const r = await s.interrupt();
  assert.deepEqual(r, { ok: true, cancelled: [], stillQueued: [] });
  await idle(w);
  assert.deepEqual(fake.sent('turn/interrupt').map((m) => m.params), [{ threadId: s.threadId, turnId }]);
  const text = w.find('assistant-text');
  assert.deepEqual([text.text, text.aborted], ['1\n2\n3', true], 'Codex never completes the item it was streaming: it is closed here');
  const end = w.find('turn-end');
  assert.deepEqual([end.interrupted, end.isError, end.synthetic], [true, false, undefined]);
  assert.deepEqual(end.userUuids, [sent.id]);
  assert.ok(w.indexOf(text) < w.indexOf(end));
  assert.equal(child.exited, null);
  assert.equal(s.q.pid, child.pid);
  assert.equal(w.of('stopped').length, 0);

  // Deltas that were already on their way must not open a new streaming row.
  const mark = w.mark();
  child.note('item/agentMessage/delta', { threadId: s.threadId, turnId, itemId, delta: '4' });
  child.note('item/completed', { threadId: s.threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '1\n2\n3\n4', phase: 'final_answer' } });
  await settle();
  assert.deepEqual(w.all(() => true, mark), []);

  assert.deepEqual(await s.interrupt(), { ok: true, idle: true, cancelled: [], stillQueued: [] }, 'nothing left to stop');
  fake.holdTurns = false;
  s.send('next');
  await idle(w, mark);
  assert.equal(fake.spawns.length, 1);
  assert.equal(w.of('turn-end').at(-1).subtype, 'success');
});

test('a recorded stop, replayed: aborted text, an interrupted end, no usage for the turn', async () => {
  const ids = recordedIds('codex-interrupt');
  const { s, w } = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-interrupt') });
  s.send('Count from 1 to 300');
  await idle(w);
  const text = w.find('assistant-text');
  assert.equal(text.aborted, true);
  assert.match(text.text, /^1\n2\n3\n/);
  const end = w.find('turn-end');
  assert.deepEqual([end.interrupted, end.subtype, end.turnUsage], [true, 'interrupted', null]);
  assert.equal(await s.contextUsage(), null);
});

test('Stop pressed before Codex has named the turn is sent the moment the id arrives', async () => {
  const { s, fake, w } = make({}, { hang: ['turn/start'] });
  s.send('go');
  await until(() => fake.sent('turn/start').length === 1);
  const stop = await s.interrupt();
  assert.equal(stop.ok, true);
  await settle();
  assert.equal(fake.sent('turn/interrupt').length, 0, 'there is no id to stop yet');
  assert.equal(s.busy, true);
  const child = fake.last;
  child.turn = { id: 'late-turn', params: fake.sent('turn/start')[0].params, inputs: [], items: [], final: null };
  child.send({ id: fake.sent('turn/start')[0].id, result: { turn: { id: 'late-turn', items: [], status: 'inProgress', error: null } } });
  await idle(w);
  assert.deepEqual(fake.sent('turn/interrupt').map((m) => m.params.turnId), ['late-turn']);
  assert.equal(w.find('turn-end').interrupted, true);
  assert.equal(s.sessionId, child.threadId, 'a turn that ended is on disk, so the chat has its id');
  assert.ok(w.indexOf(w.find('init')) < w.indexOf(w.find('turn-end')));
});

test('Stop that Codex ignores is forced: the process is replaced and the next send resumes the thread', async () => {
  const { s, fake, w } = make({ timeouts: { stopWatch: 60 } }, { holdTurns: true, ignoreInterrupt: true, ignoreEof: true });
  s.send('count');
  await w.waitFor('message-start', { ms: 2000 });
  const first = fake.last;
  const threadId = s.sessionId;
  first.streamText('', { open: true, pieces: ['so far'] });
  await w.waitFor('text-delta', { ms: 2000 });
  assert.deepEqual(await s.interrupt(), { ok: true, cancelled: [], stillQueued: [] });
  assert.equal(s.busy, true, 'Codex gets its chance first');
  const stopped = await w.waitFor('stopped', { ms: 2000 });
  assert.deepEqual([stopped.reason, stopped.willRestart, stopped.sessionId], ['force-stop', true, threadId]);
  const end = w.find('turn-end');
  assert.deepEqual([end.interrupted, end.isError, end.synthetic], [true, false, true]);
  assert.equal(w.find('assistant-text').aborted, true);
  assert.equal(w.find((e) => e.kind === 'notice' && e.code === 'force-stop').text, 'Codex did not respond to Stop, so it was restarted.');
  assert.deepEqual(kinds(w).filter((k) => ['turn-end', 'notice', 'busy', 'stopped'].includes(k)).slice(-4), ['turn-end', 'notice', 'busy', 'stopped']);
  assert.equal(s.busy, false);
  assert.equal(s.lifecycle, 'stopped');
  await until(() => first.exited, 2000, 'the stuck process to be ended');
  assert.deepEqual(first.signals, ['SIGKILL']);
  assert.equal(s.q, null);
  assert.equal(fake.spawns.length, 1, 'it is not restarted until there is something to do');

  fake.holdTurns = false;
  const mark = w.mark();
  s.send('carry on');
  await idle(w, mark);
  assert.equal(fake.spawns.length, 2);
  assert.equal(fake.sent('thread/resume').at(-1).params.threadId, threadId);
  assert.equal(s.sessionId, threadId);
  assert.equal(w.of('turn-end').at(-1).subtype, 'success');
  assert.equal(s.restarts, 1);
});

test('turn/interrupt that gets no answer at all is forced without waiting for the stop watch', async () => {
  const { s, fake, w } = make({ timeouts: { interrupt: 40, stopWatch: 60000 } }, { holdTurns: true, hang: ['turn/interrupt'] });
  s.send('count');
  await w.waitFor('message-start', { ms: 2000 });
  await s.interrupt();
  assert.equal(w.find('stopped').reason, 'force-stop');
  assert.equal(s.busy, false);
  await until(() => fake.last.exited);
});

test('a second press of Stop forces it; a double click does not; hard does at once', async () => {
  const twice = make({ timeouts: { stopWatch: 60000 } }, { holdTurns: true, ignoreInterrupt: true });
  twice.s.send('count');
  await twice.w.waitFor('message-start', { ms: 2000 });
  await twice.s.interrupt();
  assert.equal(twice.s.busy, true);
  const second = await twice.s.interrupt();
  assert.deepEqual([second.ok, second.forced], [true, true]);
  assert.equal(twice.w.find('notice').text, 'Stopped.');
  assert.equal(twice.s.busy, false);

  const double = make({ timeouts: { stopWatch: 60000, secondPress: 60000 } }, { holdTurns: true, ignoreInterrupt: true });
  double.s.send('count');
  await double.w.waitFor('message-start', { ms: 2000 });
  await double.s.interrupt();
  assert.deepEqual(await double.s.interrupt(), { ok: true, cancelled: [], stillQueued: [] });
  assert.equal(double.fake.last.exited, null, 'a double click is not "it is stuck"');
  assert.equal(double.fake.sent('turn/interrupt').length, 1);

  const hard = make({}, { holdTurns: true });
  hard.s.send('count');
  await hard.w.waitFor('message-start', { ms: 2000 });
  assert.equal((await hard.s.interrupt({ hard: true })).forced, true);
  assert.equal(hard.fake.sent('turn/interrupt').length, 0);
  assert.equal(hard.w.find('stopped').reason, 'force-stop');
});

test('Stop answers open prompts "no", cancels sends that had not started, and says so once', async () => {
  const { s, fake, w } = make({}, { holdTurns: true, errors: { 'turn/steer': { message: 'not steerable' } } });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const q = commandAsk(fake.last);
  const card = await w.waitFor('permission', { ms: 2000 });
  const waiting = s.send('later'); // refused as a steer, so it waits for the next turn
  await until(() => fake.sent('turn/steer').length === 1);
  await settle();
  const r = await s.interrupt();
  assert.deepEqual(r.cancelled, [{ id: waiting.id, text: 'later' }]);
  assert.deepEqual((await q.answer).result, { decision: 'cancel' });
  await idle(w);
  assert.deepEqual(w.of('permission-resolved').map((e) => e.id), [card.id]);
  const notice = w.find((e) => e.kind === 'notice' && e.code === 'send-cancelled');
  assert.equal(notice.text, 'Stopped. 1 queued message was not sent.');
  assert.equal(fake.sent('turn/start').length, 1, 'the cancelled message never became a turn');
  assert.equal(s.outbox.size, 0);
  // A prompt that arrives while stopping is answered no without a card.
  assert.equal(w.of('permission').length, 1);
});

test('a message sent after Stop is not folded into the turn being stopped: it starts the next one', async () => {
  const { s, fake, w } = make({ timeouts: { stopWatch: 60000 } }, { holdTurns: true, ignoreInterrupt: true });
  const a = s.send('A');
  await w.waitFor('message-start', { ms: 2000 });
  await s.interrupt();
  const b = s.send('B instead');
  await settle(40);
  assert.equal(fake.sent('turn/steer').length, 0);
  assert.equal(s.outbox.get(b.id).state, 'pending');
  fake.holdTurns = false;
  fake.last.completeTurn('interrupted'); // Codex gets round to stopping
  await idle(w);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['A', 'B instead']);
  assert.deepEqual(w.of('turn-end').map((e) => [e.interrupted, e.userUuids]), [[true, [a.id]], [false, [b.id]]]);
  assert.equal(w.all((e) => e.kind === 'notice' && e.code === 'send-cancelled').length, 0);
  assert.equal(fake.spawns.length, 1);
});

test('a message sent after a Stop that had to be forced goes to the new process', async () => {
  const { s, fake, w } = make({ timeouts: { stopWatch: 50 } }, { holdTurns: true, ignoreInterrupt: true });
  s.send('A');
  await w.waitFor('message-start', { ms: 2000 });
  const threadId = s.sessionId;
  await s.interrupt();
  const b = s.send('B instead');
  fake.holdTurns = false;
  await idle(w);
  assert.equal(w.find('stopped').reason, 'force-stop');
  assert.equal(fake.spawns.length, 2);
  assert.ok(fake.children[0].exited);
  assert.equal(fake.sent('thread/resume').at(-1).params.threadId, threadId);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['A', 'B instead']);
  assert.deepEqual(w.of('turn-end').map((e) => [e.interrupted, e.synthetic === true]), [[true, true], [false, false]]);
  assert.deepEqual(w.of('turn-end')[1].userUuids, [b.id]);
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false).length, 1, 'busy all the way through: there was always something to do');
  assert.equal(w.all((e) => e.kind === 'notice' && e.code === 'send-cancelled').length, 0);
});

test('Stop with nothing running cancels what was waiting to start', async () => {
  const { s, fake, w } = make({}, { hang: ['thread/start'] });
  const a = s.send('never sent');
  await until(() => fake.sent('thread/start').length === 1);
  const r = await s.interrupt();
  assert.deepEqual(r, { ok: true, idle: true, cancelled: [{ id: a.id, text: 'never sent' }], stillQueued: [] });
  assert.equal(s.busy, false);
  assert.equal(w.of('busy').at(-1).busy, false);
  fake.hang.clear();
  assert.deepEqual(await make().s.interrupt(), { ok: true, idle: true, cancelled: [], stillQueued: [] }, 'a chat that never started');
});

test('stop() ends the process and keeps the conversation', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  const threadId = s.sessionId;
  const r = await s.stop({ graceMs: 200 });
  assert.deepEqual(r, { ok: true, exited: true });
  assert.ok(child.exited, 'stop() resolves only once the process is gone');
  assert.equal(fake.sent('turn/interrupt').length, 1, 'the running turn was asked to stop first');
  const end = w.find('turn-end');
  assert.deepEqual([end.interrupted, end.synthetic], [true, undefined], 'Codex\'s own end of the turn arrived');
  assert.deepEqual([w.find('stopped').reason, w.find('stopped').willRestart], ['stop', false]);
  assert.equal(s.lifecycle, 'stopped');
  assert.equal(s.q, null);
  assert.equal(s.busy, false);
  assert.equal(s.closed, false);
  assert.deepEqual(await s.stop(), { ok: true, exited: true }, 'again is fine');

  fake.holdTurns = false;
  const mark = w.mark();
  s.send('back');
  await idle(w, mark);
  assert.equal(fake.sent('thread/resume').at(-1).params.threadId, threadId);
});

// ---- the process dies ----

test('the process exiting while idle is quiet, and the next send starts a new one on the same chat', async () => {
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT] });
  await s.warm();
  const mark = w.mark();
  fake.last.die(0);
  const stopped = await w.waitFor('stopped', { ms: 2000, from: mark });
  assert.deepEqual([stopped.reason, stopped.willRestart], ['exit', false]);
  assert.deepEqual(kinds(w, mark), ['stopped'], 'no error, no notice');
  assert.equal(s.lifecycle, 'stopped');
  assert.equal(s.q, null);
  assert.equal(s.pid, null);
  await settle(60);
  assert.equal(fake.spawns.length, 1, 'nothing is restarted for nobody');
  s.send('hello again');
  await idle(w, mark);
  assert.equal(fake.spawns.length, 2);
  assert.equal(fake.sent('thread/resume').length, 2);
  assert.equal(w.of('turn-end').at(-1).subtype, 'success');
});

test('a new chat whose process died before any turn simply starts a new thread', async () => {
  const { s, fake, w } = make();
  await s.warm();
  fake.last.die(1);
  await w.waitFor('stopped', { ms: 2000 });
  assert.equal(s.threadId, null, 'a thread with no turn was never on disk: there is nothing to resume');
  s.send('hi');
  await idle(w);
  assert.equal(fake.sent('thread/start').length, 2);
  assert.equal(fake.sent('thread/resume').length, 0);
});

test('a crash in the middle of a turn: the turn is reported as lost, closed properly, and never run again', async () => {
  const { s, fake, w } = make({ extended: ['send-state'] }, { holdTurns: true });
  const sent = s.send('do the thing');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  const threadId = s.sessionId;
  child.streamText('', { open: true, pieces: ['half an ans'] });
  child.note('item/started', { threadId, turnId: child.turn.id, item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'sleep 60'", cwd: work, status: 'inProgress', commandActions: [{ type: 'unknown', command: 'sleep 60' }] } });
  const q = commandAsk(child, { itemId: 'exec-2' });
  const card = await w.waitFor('permission', { ms: 2000 });
  const mark = w.mark();
  child.stderr.write('fatal: something broke\n');
  await settle(10);
  child.die(3);

  const stopped = await w.waitFor('stopped', { ms: 2000, from: mark });
  assert.deepEqual([stopped.reason, stopped.willRestart, stopped.exitCode], ['crash', false, 3]);
  const seen = w.all(() => true, mark);
  assert.deepEqual(seen.filter((e) => e.kind === 'permission-resolved').map((e) => e.id), [card.id], 'no card is left waiting');
  const text = seen.find((e) => e.kind === 'assistant-text');
  assert.deepEqual([text.text, text.aborted], ['half an ans', true]);
  const result = seen.find((e) => e.kind === 'tool-result');
  assert.deepEqual([result.id, result.interrupted, result.isError], ['exec-1', true, true], 'the row that was running is closed');
  assert.equal(seen.find((e) => e.kind === 'notice' && e.code === 'api-error').text, 'Codex stopped unexpectedly (exit code 3).');
  const end = seen.find((e) => e.kind === 'turn-end');
  assert.deepEqual([end.isError, end.interrupted, end.synthetic, end.sessionId], [true, false, true, threadId]);
  assert.deepEqual(end.errors, ['Codex stopped unexpectedly (exit code 3).']);
  assert.deepEqual(end.userUuids, [sent.id]);
  assert.equal(typeof end.durationMs, 'number');
  assert.ok(w.indexOf(end) < w.indexOf(seen.findLast((e) => e.kind === 'busy')), 'turn-end before the chat says it is free');
  assert.equal(s.busy, false);
  assert.deepEqual(sendStates(w, sent.id), ['pending', 'written', 'started', 'lost']);
  assert.equal(s.outbox.size, 0);
  assert.equal(s.turn.length, 0);
  assert.equal(await q.answer, null, 'nothing could be answered: the process was gone');

  await settle(80);
  assert.equal(fake.spawns.length, 1, 'no restart: nothing is waiting, and a lost turn is not re-run');
  fake.holdTurns = false;
  s.send('what happened?');
  await idle(w, w.mark());
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['do the thing', 'what happened?']);
  assert.equal(fake.sent('thread/resume').at(-1).params.threadId, threadId);
});

test('a send Codex never started is redelivered after a restart, without the chat ever saying it was free', async () => {
  let deaths = 1;
  const { s, fake, w } = make({ extended: ['send-state'] });
  fake.handlers['turn/start'] = (params, child) => { if (deaths-- > 0) child.die(1); };
  const sent = s.send('please arrive');
  await idle(w);
  assert.equal(fake.spawns.length, 2);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['please arrive', 'please arrive']);
  assert.deepEqual(sendStates(w, sent.id), ['pending', 'written', 'pending', 'written', 'started', 'completed']);
  assert.deepEqual([w.find('stopped').reason, w.find('stopped').willRestart], ['exit', true]);
  assert.equal(w.find((e) => e.kind === 'notice' && e.code === 'restarting').text, 'Codex stopped unexpectedly and was restarted.');
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false).length, 1);
  assert.equal(w.of('turn-end').length, 1, 'no made-up end for a turn that never started');
  assert.equal(w.of('error').length, 0);
  assert.equal(w.find('turn-end').subtype, 'success');
  assert.equal(s.restarts, 1);
  assert.equal(s.lifecycle, 'ready');
});

test('with a turn lost and another message waiting, only the waiting one is sent again', async () => {
  const { s, fake, w } = make({}, { holdTurns: true, errors: { 'turn/steer': { message: 'not steerable' } } });
  const a = s.send('A');
  await w.waitFor('message-start', { ms: 2000 });
  const threadId = s.sessionId;
  const b = s.send('B');
  await until(() => fake.sent('turn/steer').length === 1);
  await settle();
  fake.holdTurns = false;
  fake.children[0].die(9);
  await idle(w);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['A', 'B'], 'A is lost, not re-run');
  assert.deepEqual(w.of('turn-end').map((e) => [e.synthetic === true, e.isError, e.userUuids]), [[true, true, [a.id]], [false, false, [b.id]]]);
  assert.deepEqual([w.find('stopped').reason, w.find('stopped').willRestart], ['crash', true]);
  assert.equal(fake.sent('thread/resume').at(-1).params.threadId, threadId);
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false).length, 1);
});

test('a dead process is tidied up before a new one takes over, whoever notices first', async () => {
  const { s, fake, w } = make({ extended: ['send-state'] }, { hang: ['turn/start'] });
  const a = s.send('A');
  await until(() => fake.sent('turn/start').length === 1);
  const b = s.send('B');
  fake.hang.clear();
  // The exit and a new start in the same tick: the start is asked for before anything has reacted to the exit.
  fake.last.emit('exit', 9, null);
  fake.last.exited = { code: 9, signal: null };
  const opening = s.open();
  assert.equal(s.active, null, 'the turn that was being started is not left behind');
  assert.equal(s.outbox.get(a.id).state, 'pending', 'its message is back in line');
  await opening;
  await idle(w);
  assert.equal(fake.spawns.length, 2);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['A', 'A', 'B'], 'A never started the first time, so it is sent again; B follows it');
  assert.deepEqual(w.of('turn-end').map((e) => e.userUuids), [[a.id], [b.id]]);
  assert.deepEqual(sendStates(w, a.id), ['pending', 'written', 'pending', 'written', 'started', 'completed']);
  assert.equal(w.of('stopped').length, 1);
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false).length, 1);
});

test('a send that kills Codex twice is handed back instead of tried forever', async () => {
  const { s, fake, w } = make();
  fake.handlers['turn/start'] = (params, child) => { child.die(1); };
  const sent = s.send('poison');
  await idle(w);
  assert.equal(fake.sent('turn/start').length, 2);
  const err = w.find('error');
  assert.deepEqual([err.code, err.recoverable], ['send-failed', true]);
  assert.deepEqual(err.prompt, { id: sent.id, text: 'poison' });
  assert.equal(s.outbox.size, 0);
  await settle(60);
  assert.equal(fake.spawns.length, 2);
});

test('Codex that keeps dying uses up the restart budget, says so once, and the next send starts over', async () => {
  const key = 'sk-test-0123456789abcdefghijklmnopqrstuv';
  const { s, fake, w } = make({ env: { ...baseEnv(), OPENAI_API_KEY: key } });
  fake.errors['thread/start'] = (params, child) => { child.stderr.write(`cannot start with ${key}\n`); child.die(70); return null; };
  const sent = s.send('hello?');
  const err = await w.waitFor('error', { ms: 4000 });
  assert.deepEqual([err.code, err.recoverable, err.message], ['crashed', true, 'Codex keeps stopping. Send a message to try again.']);
  assert.deepEqual(err.prompts, [{ id: sent.id, text: 'hello?' }]);
  assert.ok(err.stderr.includes('cannot start with'));
  assert.ok(!err.stderr.includes(key), 'a secret in stderr never reaches the window');
  assert.equal(fake.spawns.length, 4, 'the first start and three restarts');
  assert.deepEqual(w.of('stopped').map((e) => [e.reason, e.willRestart]), [['exit', true], ['exit', true], ['exit', true], ['failed', false]]);
  await idle(w);
  assert.equal(s.lifecycle, 'failed');
  assert.equal(s.snapshot().lastError.code, 'crashed');
  await settle(60);
  assert.equal(fake.spawns.length, 4, 'and then it stops trying');

  delete fake.errors['thread/start'];
  const mark = w.mark();
  s.send('try again');
  await idle(w, mark);
  assert.equal(w.find('turn-end', mark).subtype, 'success');
  assert.equal(s.lifecycle, 'ready');
});

// ---- starting goes wrong ----

test('without Codex: a send is handed back with an error, a warm-up is only a notice', async () => {
  const { s, fake, w } = make({ codexPath: () => null });
  const warmed = await s.warm();
  assert.deepEqual([warmed.ok, warmed.code], [false, 'not-installed']);
  assert.deepEqual(w.events.map((e) => [e.kind, e.code, e.level]), [['notice', 'not-installed', 'warn']]);
  assert.match(w.events[0].text, /Codex was not found/);

  const sent = s.send('hi');
  const err = await w.waitFor('error', { ms: 2000 });
  assert.deepEqual([err.code, err.recoverable], ['not-installed', false]);
  assert.deepEqual(err.prompts, [{ id: sent.id, text: 'hi' }]);
  await idle(w);
  assert.equal(s.lifecycle, 'failed');
  assert.equal(fake.spawns.length, 0);
  assert.equal(s.outbox.size, 0);
});

test('a launch that fails, a missing binary, a missing folder', async () => {
  const missing = make({}, { spawnError: Object.assign(new Error('spawn /fake/codex ENOENT'), { code: 'ENOENT' }) });
  missing.s.send('hi');
  assert.equal((await missing.w.waitFor('error', { ms: 2000 })).code, 'not-installed');

  const denied = make({}, { spawnThrows: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) });
  denied.s.send('hi');
  const err = await denied.w.waitFor('error', { ms: 2000 });
  assert.deepEqual([err.code, err.recoverable], ['launch-failed', false]);
  assert.match(err.message, /^Codex could not start: .*EACCES/);

  const gone = make({ cwd: path.join(root, 'no-such-folder') });
  const r = await gone.s.warm();
  assert.equal(r.code, 'cwd-missing');
  assert.match(r.message, /This folder no longer exists/);
  assert.equal(gone.fake.spawns.length, 0);
});

test('initialize that is not answered: the process is ended and one more is tried', async () => {
  const { s, fake, w } = make({ timeouts: { init: 250 } }, { hang: ['initialize'] });
  s.send('hi');
  await until(() => fake.spawns.length === 1);
  fake.hang.delete('initialize'); // the second process answers
  await idle(w);
  assert.equal(fake.spawns.length, 2);
  assert.ok(fake.children[0].exited);
  assert.equal(w.find('turn-end').subtype, 'success');
  assert.equal(w.of('error').length, 0);
});

test('initialize that is never answered fails as a timeout after the second try', async () => {
  const { s, fake, w } = make({ timeouts: { init: 30 } }, { hang: ['initialize'] });
  const sent = s.send('hi');
  const err = await w.waitFor('error', { ms: 3000 });
  assert.deepEqual([err.code, err.recoverable], ['timeout', false]);
  assert.deepEqual(err.prompts, [{ id: sent.id, text: 'hi' }]);
  await idle(w);
  assert.equal(fake.spawns.length, 2);
  await until(() => fake.children.every((c) => c.exited), 2000, 'both processes to be ended');
  assert.equal(s.lifecycle, 'failed');
});

test('thread/start that is never answered fails as a timeout, and the process does not linger', async () => {
  const { s, fake } = make({ timeouts: { thread: 40 } }, { hang: ['thread/start'] });
  const r = await s.warm();
  assert.deepEqual([r.ok, r.code], [false, 'timeout']);
  await until(() => fake.last.exited);
  assert.equal(s.q, null);
});

test('turn/start that is never answered: the stuck process is replaced and the message redelivered', async () => {
  const { s, fake, w } = make({ timeouts: { turn: 250 } }, { hang: ['turn/start'] });
  s.send('are you there');
  await until(() => fake.sent('turn/start').length === 1);
  await until(() => fake.children[0].exited, 2000, 'the stuck process to be ended');
  fake.hang.clear();
  await idle(w);
  assert.equal(fake.spawns.length, 2);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['are you there', 'are you there']);
  assert.equal(w.find('turn-end').subtype, 'success');
});

test('a chat that is gone from disk: a notice, a new thread, and the host is told the id changed', async () => {
  const { s, fake, w } = make({ resume: CHAT }); // the fake knows no such chat
  assert.equal((await s.warm()).ok, true);
  assert.equal(fake.sent('thread/resume').length, 1);
  assert.equal(fake.sent('thread/start').length, 1);
  assert.equal(w.find('notice').text, 'That chat is no longer on disk, so Canopy started a new one.');
  const metas = w.of('meta');
  assert.deepEqual([metas[0].sessionId, metas[0].previousSessionId], [null, CHAT]);
  assert.equal(s.sessionId, null);
  assert.equal(w.of('init').length, 0);
  s.send('start over');
  await idle(w);
  const moved = w.find((e) => e.kind === 'meta' && e.previousSessionId === CHAT && e.sessionId);
  assert.equal(moved.sessionId, s.sessionId);
  assert.notEqual(s.sessionId, CHAT);
  assert.equal(w.find('init').sessionId, s.sessionId);
  assert.equal(fake.spawns.length, 1);
});

test('"thread not loaded" on turn/start: the thread is reopened and the turn tried once more', async () => {
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT], errors: { 'turn/start': { message: `thread not loaded: ${CHAT}`, once: true } } });
  s.send('hello');
  await idle(w);
  assert.equal(fake.sent('thread/resume').length, 2);
  assert.equal(fake.sent('turn/start').length, 2);
  assert.equal(w.of('error').length, 0);
  assert.equal(w.find('turn-end').subtype, 'success');
  assert.equal(fake.spawns.length, 1);

  const always = make({ resume: CHAT }, { known: [CHAT], errors: { 'turn/start': { message: `thread not loaded: ${CHAT}` } } });
  const sent = always.s.send('hello');
  await idle(always.w);
  assert.equal(always.fake.sent('turn/start').length, 2, 'once more, not for ever');
  assert.deepEqual([always.w.find('error').code, always.w.find('error').prompt.id], ['send-failed', sent.id]);
});

test('a message Codex refuses to start on is handed back, and the next one still goes', async () => {
  const { s, fake, w } = make({}, { errors: { 'turn/start': { message: 'input too large', once: true } } });
  const a = s.send('too big');
  s.send('fine');
  await idle(w);
  const err = w.find('error');
  assert.deepEqual([err.code, err.prompt.id], ['send-failed', a.id]);
  assert.match(err.message, /input too large/);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['too big', 'fine']);
  assert.equal(w.of('turn-end').length, 1);
});

// ---- odd output ----

test('garbage and half lines from the process do not disturb the turn', async () => {
  const { s, w, logs } = make({}, {
    script: (child) => {
      child.raw('this is not json\n');
      child.startTurn();
      child.raw('{"method":"item/agentMessage/del');
      child.raw('ta","params":null}\n[1,2]\n\n{"id":999,"result":{}}\n');
      child.note('some/future/notification', { threadId: child.threadId, anything: true });
      child.note('item/started', { threadId: child.threadId, turnId: child.turn.id, item: { type: 'someFutureItem', id: 'x1' } });
      child.raw(`${JSON.stringify({ method: 'item/completed', params: { threadId: child.threadId, turnId: child.turn.id, item: 'not an object' } })}\n`);
      child.playText('still fine');
    },
  });
  const drift = [];
  s.onDrift = (label, keys) => drift.push([label, keys]);
  s.send('go');
  await idle(w);
  assert.equal(w.find('turn-end').text, 'still fine');
  assert.equal(w.of('error').length, 0);
  assert.equal(w.all((e) => e.kind === 'raw').length, 0, 'unknown lines are not shown');
  assert.ok(logs.filter((l) => l.msg === 'codex wrote a line that is not a message').length >= 2);
  assert.ok(drift.some(([label]) => label === 'codex/some/future/notification'), 'but the host hears that Codex changed');
  assert.ok(drift.some(([label]) => label === 'codex/item/someFutureItem'));
});

test('lines for another thread, and hooks that ran fine, are not shown', async () => {
  const hook = (status, id) => ({ id, eventName: 'sessionStart', status, statusMessage: 'plugin hook', entries: [{ kind: 'error', text: 'hook said no' }] });
  const script = (child) => {
    child.startTurn();
    child.note('item/agentMessage/delta', { threadId: 'a-sub-agents-thread', turnId: 'other', itemId: 'm', delta: 'not ours' });
    child.note('turn/completed', { threadId: 'a-sub-agents-thread', turn: { id: 'other', status: 'completed', items: [] } });
    child.note('hook/started', { threadId: child.threadId, turnId: child.turn.id, run: hook('running', 'h1') });
    child.note('hook/completed', { threadId: child.threadId, turnId: child.turn.id, run: hook('completed', 'h1') });
    child.note('hook/completed', { threadId: child.threadId, turnId: child.turn.id, run: hook('failed', 'h2') });
    child.playText();
  };
  const quiet = make({}, { script });
  quiet.s.send('go');
  await idle(quiet.w);
  assert.deepEqual(quiet.w.of('hook').map((e) => [e.id, e.outcome]), [['h2', 'failed']], 'only the hook that failed');
  assert.equal(quiet.w.of('turn-end').length, 1);
  assert.ok(!quiet.w.events.some((e) => e.text === 'not ours'));

  const all = make({ extended: ['hooks'] }, { script });
  all.s.send('go');
  await idle(all.w);
  assert.equal(all.w.of('hook').length, 3);
});

// ---- closing ----

test('dispose() resolves only once the process has exited', async () => {
  const { s, fake, w } = make({}, { holdTurns: true, ignoreEof: true });
  s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const q = commandAsk(fake.last);
  await w.waitFor('permission', { ms: 2000 });
  const child = fake.last;
  const mark = w.mark();
  const t = Date.now();
  await s.dispose({ graceMs: 60 });
  assert.ok(child.exited, 'the process is gone by the time dispose() resolves');
  assert.ok(Date.now() - t >= 50, 'it waited for it');
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.deepEqual((await q.answer).result, { decision: 'cancel' }, 'the open prompt was answered no');
  assert.equal(fake.sent('turn/interrupt').length, 1, 'the running turn was asked to stop, so Codex saves it as stopped');
  assert.deepEqual(w.all(() => true, mark), [], 'a closed session says nothing more');
  assert.equal(s.closed, true);
  assert.equal(s.lifecycle, 'closed');
  assert.equal(s.busy, false);
  assert.equal(s.pending.size, 0);
  assert.equal(s.q, null);
  assert.equal(fake.received.some((m) => m.method === 'thread/archive'), false, 'a user\'s chat is never archived');
  await s.dispose(); // twice is fine
});

test('dispose() while Codex is still starting ends that process too', async () => {
  const { s, fake } = make({}, { hang: ['thread/start'] });
  const warming = s.warm();
  await until(() => fake.sent('thread/start').length === 1);
  await s.dispose({ graceMs: 20 });
  assert.ok(fake.last.exited);
  const r = await warming;
  assert.deepEqual([r.ok, r.code], [false, 'closed']);
  assert.equal(fake.spawns.length, 1);
});

test('close() twice, dispose() after close(), and every call after closing', async () => {
  const { s, fake, w } = make();
  s.send('hi');
  await idle(w);
  const child = fake.last;
  const mark = w.mark();
  assert.doesNotThrow(() => { s.close(); s.close(); });
  assert.equal(s.closed, true);
  await s.dispose();
  assert.ok(child.exited, 'dispose() after close() still waits for the process');

  assert.deepEqual([s.send('x').ok, s.send('x').code], [false, 'closed']);
  assert.equal((await s.warm()).code, 'closed');
  assert.equal((await s.set('permissionMode', 'plan')).code, 'closed');
  assert.deepEqual(await s.interrupt(), { ok: true, idle: true, cancelled: [], stillQueued: [] });
  assert.equal(s.respond(1, {}).code, 'stale');
  assert.equal((await s.history()).ok, false);
  assert.equal(await s.rename('x'), false);
  assert.equal((await s.stop()).ok, true);
  assert.equal(s.snapshot().lifecycle, 'closed');
  assert.deepEqual(w.all(() => true, mark), []);
  assert.equal(fake.spawns.length, 1);
});

test('dispose() and stop() end the process whatever grace they are given', async () => {
  for (const graceMs of ['soon', NaN, -5, null, {}, Symbol('s')]) {
    const { s, fake } = make();
    await s.warm();
    await within(s.dispose({ graceMs }), 3000, 'dispose');
    assert.ok(fake.last.exited, `graceMs ${String(graceMs)}`);
  }
  const { s, fake } = make();
  await s.warm();
  assert.equal((await within(s.stop({ graceMs: 'x' }), 3000, 'stop')).ok, true);
  assert.ok(fake.last.exited);
});

test('a chat that never had a turn leaves nothing to clean up', async () => {
  const { s, fake } = make();
  await s.warm();
  await s.dispose();
  assert.ok(fake.last.exited);
  assert.deepEqual(fake.received.map((m) => m.method), ['initialize', 'initialized', 'model/list', 'account/read', 'config/read', 'skills/extraRoots/set', 'thread/start']);
});

// ---- what the host reads ----

test('snapshot() has the keys a Session snapshot has, plus the engine', async () => {
  const { s, fake, w } = make({ permissionMode: 'acceptEdits', effort: 'low' }, { holdTurns: true });
  assert.deepEqual(Object.keys(s.snapshot()).sort(), [
    'accountId', 'backgroundTasks', 'busy', 'degraded', 'engine', 'lastError', 'lifecycle', 'meta', 'mode', 'model', 'outbox', 'pending', 'pid', 'restarts', 'restricted',
    'risky', 'seq', 'sessionId', 'settings', 'state', 'tasks', 'turn',
  ]);
  assert.deepEqual(s.snapshot(), {
    sessionId: null, busy: false, accountId: null, settings: { model: undefined, effort: 'low', fast: undefined, permissionMode: 'acceptEdits' }, pending: [], meta: null,
    state: 'idle', lifecycle: 'new', seq: 0, turn: [], outbox: [], tasks: [], backgroundTasks: [], lastError: null, restarts: 0, pid: null,
    restricted: false, risky: null, degraded: [], model: null, mode: 'acceptEdits', engine: 'codex',
  });
  const sent = s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  fake.last.streamText('', { open: true, pieces: ['wor', 'king'] });
  await w.waitFor('text-delta', { ms: 2000 });
  const snap = s.snapshot();
  assert.deepEqual([snap.busy, snap.state, snap.lifecycle, snap.pid, snap.sessionId], [true, 'running', 'ready', fake.last.pid, s.sessionId]);
  assert.deepEqual(snap.outbox, [{ id: sent.id, text: 'go', images: 0, state: 'started' }]);
  assert.deepEqual(snap.turn.map((e) => [e.kind, e.text]), [['message-start', undefined], ['text-delta', 'working']], 'the turn in flight, deltas merged');
  assert.equal(snap.seq, w.events.at(-1).seq);
  assert.equal(snap.meta.kind, 'meta');
  assert.equal(snap.model, 'gpt-6.1-sol');
  fake.last.playText();
  await idle(w);
  assert.deepEqual(s.snapshot().turn, []);
});

test('the members the manager and the host reach for are all there', async () => {
  const { s } = make();
  assert.equal(s.cwd, work);
  assert.equal(s.backgroundCount, 0);
  assert.equal(s.reportedBusy(), false);
  assert.equal(s.working, false);
  assert.equal(s.q, null);
  assert.ok(s.pending instanceof Map);
  assert.equal(typeof s.settings, 'object');
  assert.deepEqual(s.trust(), { ok: true });
  assert.equal(s.unpark(), undefined);
  assert.equal(await s.generateTitle('x'), null);
  assert.equal(await s.usage(), null);
  for (const call of [s.background('t'), s.mcp('reconnect', 'x'), s.reload('plugins'), s.branch({})]) {
    assert.ok(call instanceof Promise, 'the host calls .catch() on these');
    assert.deepEqual(await call, { ok: false, code: 'unsupported', message: 'Not available in this chat yet.' });
  }
  // Editing a message is there (the host offers it only for a chat whose session has it). Putting files back is not:
  // an edit in an OpenAI chat never has changes to offer to undo.
  assert.equal(typeof s.edit, 'function');
  assert.notEqual((await s.edit({ messageId: 'x', text: 'y' })).code, 'unsupported');
  const stop = s.stopTask('t');
  assert.ok(stop instanceof Promise, 'the host calls .catch() on this one too');
  assert.deepEqual(await stop, { ok: false, code: 'not-found', message: 'That agent is no longer running.' }, 'an agent this chat does not have');
  assert.deepEqual(await s.rewindFiles('id'), { canRewind: false, error: 'Not available in this chat yet.' });
  assert.deepEqual(await s.rewindFiles('id', { dryRun: true }), { canRewind: false, error: 'Not available in this chat yet.' });
  assert.equal(await s.contextUsage(), null, 'nothing to show until Codex has reported usage');
  assert.deepEqual(await s.mcpStatus(), []);
});

test('mcpStatus() reports the user\'s MCP servers as this process started them', async () => {
  const { s } = make({}, { mcp: [['docs', 'starting'], ['slack', 'starting'], ['docs', 'ready'], ['slack', 'failed', 'not logged in. Run `codex mcp login slack`'], ['old', 'cancelled']] });
  await s.warm();
  await until(async () => (await s.mcpStatus()).length === 3).catch(() => {});
  await settle();
  assert.deepEqual(await s.mcpStatus(), [
    { name: 'docs', status: 'connected', error: null, scope: null, source: null, server: null, url: null, transport: null, tools: [] },
    { name: 'slack', status: 'failed', error: 'not logged in. Run `codex mcp login slack`', scope: null, source: null, server: null, url: null, transport: null, tools: [] },
    { name: 'old', status: 'failed', error: null, scope: null, source: null, server: null, url: null, transport: null, tools: [] },
  ]);
});

test('rename() names the chat through its own process, and the new name reaches the host', async () => {
  const { s, fake, w } = make();
  await s.warm();
  assert.equal(await s.rename('Too early'), false, 'before its first turn the chat is not on disk');
  assert.equal(fake.sent('thread/name/set').length, 0);
  s.send('hi');
  await idle(w);
  assert.equal(await s.rename('  My   chat\n'), true);
  assert.deepEqual(fake.sent('thread/name/set')[0].params, { threadId: s.sessionId, name: 'My chat' });
  assert.equal((await w.waitFor((e) => e.kind === 'meta' && e.title, { ms: 2000 })).title, 'My chat');
  for (const bad of ['', '   ', null, 5, {}]) assert.equal(await s.rename(bad), false);
  fake.errors['thread/name/set'] = { message: 'nope' };
  assert.equal(await s.rename('Again'), false);
});

test('history(): the saved turns, plus the turn in flight when Codex does not list it yet', async () => {
  const { s, fake, w } = make();
  assert.deepEqual([(await s.history()).ok, (await s.history()).code], [false, 'not-running']);
  await s.warm();
  assert.deepEqual(await s.history(), { ok: true, events: [], truncated: false }, 'a chat with no turn is not on disk: nothing is asked');
  assert.equal(fake.sent('thread/turns/list').length, 0);

  s.send('first question');
  await idle(w);
  const saved = await s.history();
  assert.deepEqual(saved.events.map((e) => [e.kind, e.text]), [['user-text', 'first question'], ['assistant-text', 'OK'], ['turn-end', 'OK']]);
  assert.deepEqual(fake.sent('thread/turns/list')[0].params, { threadId: s.sessionId, itemsView: 'full', sortDirection: 'desc', limit: 50 });

  fake.holdTurns = true;
  const mark = w.mark();
  const second = s.send('second question');
  await w.waitFor('message-start', { ms: 2000, from: mark });
  fake.last.streamText('', { open: true, pieces: ['thinking about it'] });
  await w.waitFor('text-delta', { ms: 2000, from: mark });
  const running = await s.history();
  assert.deepEqual(running.events.map((e) => [e.kind, e.text]), [
    ['user-text', 'first question'], ['assistant-text', 'OK'], ['turn-end', 'OK'],
    ['user-text', 'second question'], ['message-start', undefined], ['text-delta', 'thinking about it'],
  ]);
  assert.equal(running.events[3].uuid, second.id);
  running.events.at(-1).text = 'scribbled';
  assert.equal(s.snapshot().turn.at(-1).text, 'thinking about it', 'a caller gets copies, not the turn log itself');

  fake.listRunning = true; // Codex lists the running turn itself: nothing is added twice
  fake.last.userItem(fake.last.turn.params.input);
  const listed = await s.history();
  assert.equal(listed.events.filter((e) => e.kind === 'user-text').length, 2);
  assert.ok(!listed.events.some((e) => e.kind === 'message-start'));
  fake.last.playText();
  await idle(w, mark);
});

test('history() pages through a long chat and reports a refusal instead of throwing', async () => {
  const { s, fake } = make({ resume: CHAT }, { known: [CHAT] });
  fake.turnsOf[CHAT] = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, startedAt: 100 + n, completedAt: 101 + n, status: 'completed', items: [{ type: 'userMessage', id: `u${n}`, content: [{ type: 'text', text: `q${n}` }] }] }));
  await s.warm();
  const all = await s.history({ pageSize: 2 });
  assert.deepEqual(all.events.filter((e) => e.kind === 'user-text').map((e) => e.text), ['q1', 'q2', 'q3', 'q4', 'q5']);
  assert.equal(fake.sent('thread/turns/list').length, 3);
  const newest = await s.history({ maxTurns: 2, pageSize: 2 });
  assert.deepEqual(newest.events.filter((e) => e.kind === 'user-text').map((e) => e.text), ['q4', 'q5']);
  fake.errors['thread/turns/list'] = { message: `no rollout found for thread id ${CHAT}` };
  assert.deepEqual(await s.history(), { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' });
  fake.errors['thread/turns/list'] = { message: 'the index is busy' };
  assert.deepEqual([(await s.history()).ok, (await s.history()).code], [false, 'internal']);
});

// ---- edit and resend ----

const NEW_ID = '0a0a0a0a-0000-4000-8000-00000000000a';
const savedTexts = (fake, id) => (fake.turnsOf[id] ?? []).map((t) => t.items.filter((i) => i.type === 'userMessage').map((i) => i.content.find((c) => c.type === 'text')?.text));
const savedTurn = (n, extra = []) => ({
  id: `t${n}`, startedAt: 100 + n, completedAt: 101 + n, status: 'completed',
  items: [{ type: 'userMessage', id: `u${n}`, clientId: null, content: [{ type: 'text', text: `q${n}` }] }, ...extra, { type: 'agentMessage', id: `a${n}`, text: `r${n}`, phase: 'final_answer' }],
});
const shown = (w, from, list = ['edit', 'busy', 'message-start', 'turn-end']) => w.all((e) => list.includes(e.kind), from).map((e) => (e.kind === 'busy' ? `busy:${e.busy}` : e.kind === 'turn-end' ? `turn-end:${e.subtype}` : e.kind));

test('edit while the chat is idle: the message\'s turn is cut off with thread/revert, the new words start the next one', async () => {
  const { s, fake, w } = make({ extended: ['send-state'] });
  s.send('first');
  await idle(w);
  let mark = w.mark();
  const b = s.send('second');
  await idle(w, mark);
  const [, t2] = fake.turnsOf[s.sessionId].map((t) => t.id);
  const threadId = s.sessionId;

  mark = w.mark();
  const lines = fake.received.length;
  const r = await s.edit({ messageId: b.id, text: 'second, reworded', id: NEW_ID });
  assert.deepEqual(r, { ok: true, id: NEW_ID, fresh: false, first: false, replaced: 'second' });
  assert.equal(s.busy, true, 'the new message is on its way before edit() answers');
  await idle(w, mark);

  assert.deepEqual(fake.received.slice(lines).map((m) => m.method), ['thread/revert', 'thread/turns/list', 'turn/start'], 'nothing to stop, nothing to look up: this run sent the message');
  assert.deepEqual(fake.sent('thread/revert')[0].params, { threadId, beforeTurnId: t2 });
  assert.deepEqual(fake.sent('turn/start').at(-1).params.input, [{ type: 'text', text: 'second, reworded', text_elements: [] }]);
  assert.deepEqual(fake.reverts, [{ threadId, beforeTurnId: t2, dropped: [t2] }]);
  assert.deepEqual(savedTexts(fake, threadId), [['first'], ['second, reworded']], 'the saved chat holds the kept turn and the new one');

  // The mark the window waits for, with the caller's id, before anything of the new turn.
  const ev = w.find('edit', mark);
  assert.deepEqual({ ...ev, seq: 0 }, { kind: 'edit', id: NEW_ID, messageId: b.id, fresh: false, text: 'second, reworded', seq: 0 });
  assert.deepEqual(shown(w, mark), ['edit', 'busy:true', 'busy:true', 'message-start', 'turn-end:success', 'busy:false']);
  assert.deepEqual(w.of('turn-end', mark).at(-1).userUuids, [NEW_ID]);
  assert.deepEqual(sendStates(w, NEW_ID), ['pending', 'written', 'started', 'completed']);
  assert.equal(w.of('error', mark).length + w.of('stopped', mark).length + w.of('reverted', mark).length, 0);

  // Same chat, same process; and what the window reads back is the cut conversation.
  assert.equal(s.sessionId, threadId);
  assert.equal(fake.spawns.length, 1);
  assert.equal(fake.sent('turn/interrupt').length, 0);
  const h = await s.history();
  assert.deepEqual(h.events.filter((e) => e.kind === 'user-text').map((e) => e.text), ['first', 'second, reworded']);
  assert.equal(s.editing, false);
});

test('which turn a message started is remembered after the turn is over: an old message is edited later, and every turn after it goes', async () => {
  const { s, fake, w } = make();
  const sent = [];
  for (const text of ['one', 'two', 'three']) { const mark = w.mark(); sent.push(s.send(text)); await idle(w, mark); }
  const turns = fake.turnsOf[s.sessionId].map((t) => t.id);
  assert.deepEqual(sent.map((m) => s.sendTurns.get(m.id)), turns.map((turnId, i) => ({ turnId, first: true, text: ['one', 'two', 'three'][i], images: 0 })));
  assert.equal(s.outbox.size, 0, 'the sends themselves are long gone');

  let mark = w.mark();
  const r = await s.edit({ messageId: sent[1].id, text: 'two, reworded' });
  assert.equal(r.ok, true);
  assert.match(r.id, UUID_RE, 'a new id is made when the caller gives none');
  await idle(w, mark);
  assert.deepEqual(fake.reverts.at(-1), { threadId: s.sessionId, beforeTurnId: turns[1], dropped: [turns[1], turns[2]] });
  assert.deepEqual(savedTexts(fake, s.sessionId), [['one'], ['two, reworded']]);
  assert.deepEqual([...s.sendTurns.keys()], [sent[0].id, r.id], 'the notes about the turns that went are gone with them');
  // A message that went with the cut is no longer anywhere.
  assert.deepEqual(await s.edit({ messageId: sent[2].id, text: 'x' }), { ok: false, code: 'not-found', message: 'That message is not in the saved conversation.' });

  // The new message can itself be edited, and so can the very first one: then nothing is left before it.
  mark = w.mark();
  assert.equal((await s.edit({ messageId: r.id, text: 'two, once more' })).first, false);
  await idle(w, mark);
  mark = w.mark();
  const first = await s.edit({ messageId: sent[0].id, text: 'one, reworded' });
  assert.deepEqual([first.ok, first.fresh, first.first, first.replaced], [true, false, true, 'one']);
  await idle(w, mark);
  assert.deepEqual(savedTexts(fake, s.sessionId), [['one, reworded']]);
  assert.equal(fake.spawns.length, 1);
  assert.equal(fake.sent('thread/start').length, 1, 'the chat keeps its thread: no new conversation is started');
});

test('edit while the reply is being written: Stop, wait until the turn is really over, cut, and only then send', async () => {
  const { s, fake, w } = make({}, { holdTurns: true, ignoreInterrupt: true });
  const a = s.send('count to a million');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  const turnId = child.turn.id;
  child.streamText('', { open: true, pieces: ['1\n', '2\n'] });
  await w.waitFor('text-delta', { ms: 2000 });

  const mark = w.mark();
  const lines = fake.received.length;
  const done = s.edit({ messageId: a.id, text: 'count to three', id: NEW_ID });
  await until(() => fake.sent('turn/interrupt').length === 1);
  assert.deepEqual(fake.sent('turn/interrupt')[0].params, { threadId: s.threadId, turnId });
  assert.deepEqual(await s.edit({ messageId: a.id, text: 'again' }), { ok: false, code: 'busy', message: 'This chat is already being edited.' });
  // You type something else while it is at it: it must not slip in ahead of the edited message.
  const late = s.send('and then say done');
  await settle(60);
  assert.equal(fake.sent('thread/revert').length, 0, 'the conversation is not cut while the reply is still ending');
  assert.equal(fake.sent('turn/start').length, 1, 'and nothing new is started');
  assert.equal(w.find('edit', mark), null);

  fake.holdTurns = false;
  child.completeTurn('interrupted'); // Codex's own word that the turn is over
  const r = await done;
  assert.deepEqual(r, { ok: true, id: NEW_ID, fresh: false, first: true, replaced: 'count to a million' });
  await idle(w, mark);

  const wire = fake.received.slice(lines).map((m) => m.method);
  assert.deepEqual(wire.slice(0, 4), ['turn/interrupt', 'thread/revert', 'thread/turns/list', 'turn/start']);
  assert.deepEqual(fake.sent('thread/revert')[0].params, { threadId: s.sessionId, beforeTurnId: turnId });
  assert.equal(textOf(fake.sent('turn/start')[1]), 'count to three');
  const after = fake.received.slice(lines).filter((m) => m.method === 'turn/start' || m.method === 'turn/steer').map((m) => m.params.input[0].text);
  assert.deepEqual(after, ['count to three', 'and then say done'], 'what was typed meanwhile goes after the edited message');
  // The old reply ends as stopped (not as an error), and only then comes the mark, before anything of the new turn.
  // With a message waiting the chat never says it is free in between.
  const seq = shown(w, mark);
  assert.deepEqual(seq.slice(0, 3), ['turn-end:interrupted', 'busy:true', 'edit']);
  assert.ok(seq.indexOf('edit') < seq.indexOf('message-start'));
  assert.equal(seq.slice(0, seq.indexOf('message-start')).includes('busy:false'), false);
  const stopped = w.find('turn-end', mark);
  assert.deepEqual([stopped.interrupted, stopped.isError, stopped.synthetic, stopped.userUuids], [true, false, undefined, [a.id]]);
  assert.equal(w.of('notice', mark).filter((e) => e.code === 'force-stop' || e.code === 'send-cancelled').length, 0);
  assert.equal(w.of('stopped', mark).length, 0, 'the process was never ended');
  assert.equal(fake.spawns.length, 1);
  assert.deepEqual(savedTexts(fake, s.sessionId).flat(), ['count to three', 'and then say done'], 'the stopped turn is gone from the saved chat');
  assert.equal(late.ok, true);
});

test('edit mid-reply when Codex stops at once: the wire order is interrupt, revert, turn/start', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  fake.last.playText('one');
  await idle(w);
  let mark = w.mark();
  const b = s.send('second');
  await w.waitFor('message-start', { ms: 2000, from: mark });
  fake.last.streamText('', { open: true, pieces: ['so far'] });
  await w.waitFor('text-delta', { ms: 2000, from: mark });
  const [t1] = fake.turnsOf[s.sessionId].map((t) => t.id);
  const t2 = fake.last.turn.id;

  mark = w.mark();
  const lines = fake.received.length;
  fake.holdTurns = false;
  const r = await s.edit({ messageId: b.id, text: 'second, reworded' });
  assert.deepEqual([r.ok, r.first], [true, false]);
  await idle(w, mark);
  assert.deepEqual(fake.received.slice(lines).map((m) => m.method), ['turn/interrupt', 'thread/revert', 'thread/turns/list', 'turn/start']);
  assert.deepEqual(fake.reverts, [{ threadId: s.sessionId, beforeTurnId: t2, dropped: [t2] }]);
  assert.deepEqual(fake.turnsOf[s.sessionId].map((t) => t.id).slice(0, 1), [t1]);
  assert.deepEqual(savedTexts(fake, s.sessionId), [['first'], ['second, reworded']]);
  assert.equal(w.find('assistant-text', mark).aborted, true, 'the text that was streaming is closed as stopped');
  assert.deepEqual(shown(w, mark), ['turn-end:interrupted', 'busy:false', 'edit', 'busy:true', 'busy:true', 'message-start', 'turn-end:success', 'busy:false']);
});

test('an edit made while a Stop is already ending the reply waits for that Stop: it is not a second press', async () => {
  const { s, fake, w } = make({ timeouts: { secondPress: 0 } }, { holdTurns: true, ignoreInterrupt: true });
  const a = s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const child = fake.last;
  await s.interrupt();
  await settle(20);
  const done = s.edit({ messageId: a.id, text: 'go, reworded' });
  await settle(40);
  assert.equal(child.exited, null, 'a second Stop would have ended the process');
  fake.holdTurns = false;
  child.completeTurn('interrupted');
  assert.equal((await done).ok, true);
  await idle(w);
  assert.equal(fake.sent('turn/interrupt').length, 1);
  assert.equal(fake.spawns.length, 1);
  assert.deepEqual(savedTexts(fake, s.sessionId), [['go, reworded']]);
});

test('edit when the Stop has to be forced: the new process opens the chat again, and the cut is made there', async () => {
  const { s, fake, w } = make({ timeouts: { stopWatch: 60 } }, { holdTurns: true, ignoreInterrupt: true, ignoreEof: true });
  const a = s.send('count');
  await w.waitFor('message-start', { ms: 2000 });
  const first = fake.last;
  const threadId = s.sessionId;
  const turnId = first.turn.id;
  // Codex writes a turn down when it starts, so the stuck one is in the saved chat for the next process to find.
  first.userItem(first.turn.params.input);
  fake.turnsOf[threadId] = [{ id: turnId, status: 'interrupted', startedAt: 1, completedAt: 2, items: first.turn.items.slice() }];

  fake.holdTurns = false;
  const mark = w.mark();
  const r = await s.edit({ messageId: a.id, text: 'count, reworded' });
  assert.deepEqual([r.ok, r.first], [true, true]);
  await idle(w, mark);
  assert.equal(fake.spawns.length, 2);
  assert.deepEqual(first.signals, ['SIGKILL']);
  assert.deepEqual(fake.last.received.map((m) => m.method).slice(-4), ['thread/resume', 'thread/revert', 'thread/turns/list', 'turn/start']);
  assert.deepEqual(fake.reverts, [{ threadId, beforeTurnId: turnId, dropped: [turnId] }]);
  assert.equal(w.find((e) => e.kind === 'turn-end', mark).synthetic, true);
  assert.deepEqual(savedTexts(fake, threadId), [['count, reworded']]);
  assert.equal(s.sessionId, threadId);
});

test('a message loaded from the saved chat is found by Codex\'s own id for it, without opening the chat first', async () => {
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT] });
  fake.turnsOf[CHAT] = [1, 2, 3].map((n) => savedTurn(n));
  fake.handlers['thread/inject_items'] = () => ({});
  assert.equal(s.q, null, 'the chat is not even running');
  const r = await s.edit({ messageId: 'u2', text: 'q2, reworded', id: NEW_ID });
  assert.deepEqual(r, { ok: true, id: NEW_ID, fresh: false, first: false, replaced: 'q2' });
  await idle(w);
  assert.deepEqual(fake.sent('thread/turns/list')[0].params, { threadId: CHAT, itemsView: 'summary', sortDirection: 'desc', limit: 50 }, 'looked up in the light view, newest first');
  assert.deepEqual(fake.reverts, [{ threadId: CHAT, beforeTurnId: 't2', dropped: ['t2', 't3'] }]);
  // (The turns that went are from before this run, so the model is told their changes may still be on disk: a note
  // goes into the thread ahead of the new turn. codex-session-notes.test.mjs has what it says.)
  assert.deepEqual(fake.received.map((m) => m.method).slice(-6), ['thread/resume', 'thread/turns/list', 'thread/revert', 'thread/turns/list', 'thread/inject_items', 'turn/start']);
  assert.deepEqual(savedTexts(fake, CHAT), [['q1'], ['q2, reworded']]);
  assert.deepEqual(w.find('edit'), { kind: 'edit', id: NEW_ID, messageId: 'u2', fresh: false, text: 'q2, reworded', seq: w.find('edit').seq });
  assert.deepEqual(w.of('turn-end').at(-1).userUuids, [NEW_ID]);

  // The first message of a saved chat: nothing is left before the new one.
  const mark = w.mark();
  const first = await s.edit({ messageId: 'u1', text: 'q1, reworded' });
  assert.deepEqual([first.ok, first.first, first.replaced], [true, true, 'q1']);
  await idle(w, mark);
  assert.deepEqual(savedTexts(fake, CHAT), [['q1, reworded']]);
  // An id that is in no turn, and a chat that is not on disk at all.
  assert.deepEqual(await s.edit({ messageId: 'u9', text: 'x' }), { ok: false, code: 'not-found', message: 'That message is not in the saved conversation.' });
  const fresh = make();
  assert.equal((await fresh.s.edit({ messageId: 'u1', text: 'x' })).code, 'not-found');
  assert.equal(fresh.fake.spawns.length, 0, 'a chat with no turn has nothing to look in');
});

test('finding a saved message reads a long chat a page at a time and stops at the page that has it', async () => {
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT] });
  fake.turnsOf[CHAT] = Array.from({ length: 120 }, (_, i) => savedTurn(i + 1));
  await s.warm();
  assert.equal((await s.edit({ messageId: 'u110', text: 'near the end' })).ok, true);
  await idle(w);
  assert.equal(fake.sent('thread/turns/list').filter((m) => m.params.limit === 50).length, 1, 'it was on the newest page');
  assert.equal(fake.turnsOf[CHAT].length, 110);
  const mark = w.mark();
  const before = fake.sent('thread/turns/list').length;
  assert.equal((await s.edit({ messageId: 'u5', text: 'near the start' })).ok, true);
  await idle(w, mark);
  const pages = fake.sent('thread/turns/list').slice(before).filter((m) => m.params.limit === 50);
  assert.deepEqual(pages.map((m) => [m.params.itemsView, m.params.cursor ?? null]), [['summary', null], ['summary', '50'], ['summary', '100']]);
  assert.deepEqual(fake.reverts.at(-1).beforeTurnId, 't5');
  assert.equal(fake.turnsOf[CHAT].length, 5);
});

test('a message steered into a running reply cannot be edited on its own: not live, not later, not read back', async () => {
  const { s, fake, w } = make({}, { holdTurns: true });
  const a = s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  const b = s.send('and also');
  await until(() => fake.sent('turn/steer').length === 1);
  await until(() => s.sendTurns.has(b.id));
  const refusal = { ok: false, code: 'steered', message: 'That message went into a reply that was already running, so it can’t be edited on its own.' };

  // While the reply runs: refused before anything is stopped.
  const mark = w.mark();
  assert.deepEqual(await s.edit({ messageId: b.id, text: 'x' }), refusal);
  assert.equal(fake.sent('turn/interrupt').length, 0, 'the reply is left running');
  assert.deepEqual(w.all(() => true, mark), [], 'and nothing is said');
  const running = await s.history();
  assert.deepEqual(running.events.filter((e) => e.kind === 'user-text').map((e) => [e.text, e.steered]), [['first', undefined], ['and also', true]]);

  fake.last.playText();
  await idle(w);
  assert.deepEqual(s.sendTurns.get(b.id).first, false);
  assert.deepEqual(await s.edit({ messageId: b.id, text: 'x' }), refusal, 'the turn is over: it is still part of it');

  // Read back from the saved chat, where it carries Codex's own id: the second message of its turn.
  const users = fake.turnsOf[s.sessionId][0].items.filter((i) => i.type === 'userMessage');
  assert.equal(users.length, 2);
  const before = fake.sent('thread/turns/list').length;
  assert.deepEqual(await s.edit({ messageId: users[1].id, text: 'x' }), refusal);
  assert.deepEqual(fake.sent('thread/turns/list').slice(before).map((m) => m.params.itemsView), ['summary', 'full'], 'the light view has only a turn\'s first message; the full one tells steered from missing');
  const saved = await s.history();
  assert.deepEqual(saved.events.filter((e) => e.kind === 'user-text').map((e) => [e.text, e.steered]), [['first', undefined], ['and also', true]]);
  assert.equal(fake.sent('thread/revert').length, 0);
  assert.equal(s.busy, false);

  // The message that started the turn can be edited: the whole turn goes, the steered message with it.
  fake.holdTurns = false;
  const mark2 = w.mark();
  assert.equal((await s.edit({ messageId: users[0].id, text: 'first, reworded' })).ok, true);
  await idle(w, mark2);
  assert.deepEqual(savedTexts(fake, s.sessionId), [['first, reworded']]);
  assert.equal(a.ok, true);
});

test('a cut Codex refuses changes nothing: its own words come back, the chat is whole, and the next thing still works', async () => {
  const { s, fake, w } = make();
  const a = s.send('first');
  await idle(w);
  const turns = fake.turnsOf[s.sessionId].map((t) => t.id);
  fake.errors['thread/revert'] = { message: `turn not found: ${turns[0]}` };
  let mark = w.mark();
  assert.deepEqual(await s.edit({ messageId: a.id, text: 'new words' }), {
    ok: false, code: 'edit-failed', message: `That message could not be edited: turn not found: ${turns[0]}. Nothing was changed.`,
  });
  assert.equal(w.find('edit', mark), null, 'no mark: nothing was cut');
  assert.deepEqual(w.all((e) => ['error', 'busy', 'notice', 'stopped'].includes(e.kind), mark), []);
  assert.deepEqual([s.busy, s.editing, s.outbox.size], [false, false, 0]);
  assert.equal(fake.sent('turn/start').length, 1, 'the new words were not sent');
  assert.deepEqual(fake.turnsOf[s.sessionId].map((t) => t.id), turns);
  assert.deepEqual(fake.reverts, []);

  // Codex that never answers: said plainly, and the chat is not left waiting.
  delete fake.errors['thread/revert'];
  fake.hang.add('thread/revert');
  s.t.revert = 80;
  assert.deepEqual(await s.edit({ messageId: a.id, text: 'new words' }), { ok: false, code: 'edit-failed', message: 'That message could not be edited: Codex did not answer. Try again.' });
  assert.deepEqual([s.busy, s.editing], [false, false]);
  fake.hang.delete('thread/revert');

  // A Codex from before thread/revert existed (this is how 0.153 words a method it does not know).
  fake.errors['thread/revert'] = { message: 'Invalid request: unknown variant `thread/revert`, expected one of `initialize`, `thread/start`' };
  assert.deepEqual(await s.edit({ messageId: a.id, text: 'new words' }), { ok: false, code: 'unsupported', message: 'This version of Codex can’t edit a message. Update Codex and try again.' });
  delete fake.errors['thread/revert'];

  // Nothing above cost the chat anything: a message still goes, and the same edit now works.
  mark = w.mark();
  s.send('second');
  await idle(w, mark);
  mark = w.mark();
  assert.equal((await s.edit({ messageId: a.id, text: 'new words' })).ok, true);
  await idle(w, mark);
  assert.deepEqual(savedTexts(fake, s.sessionId), [['new words']]);
  assert.equal(fake.spawns.length, 1);
});

test('a cut refused in the middle of a reply: the reply stays stopped, nothing is cut, and the chat is free again', async () => {
  const { s, fake, w } = make({}, { holdTurns: true, errors: { 'thread/revert': { message: 'the rollout is locked' } } });
  const a = s.send('first');
  await w.waitFor('message-start', { ms: 2000 });
  const turnId = fake.last.turn.id;
  const mark = w.mark();
  const r = await s.edit({ messageId: a.id, text: 'new words' });
  assert.deepEqual([r.ok, r.code, r.message], [false, 'edit-failed', 'That message could not be edited: the rollout is locked. Nothing was changed.']);
  assert.deepEqual(shown(w, mark), ['turn-end:interrupted', 'busy:false'], 'the reply was stopped like any Stop; no mark follows');
  assert.equal(s.busy, false);
  assert.deepEqual(fake.turnsOf[s.sessionId].map((t) => t.id), [turnId], 'the stopped turn is still in the saved chat');
  assert.equal(fake.sent('turn/start').length, 1);
});

test('Codex let go of the thread: the cut opens it again and is asked for once more', async () => {
  const { s, fake, w } = make({ resume: CHAT }, { known: [CHAT] });
  fake.turnsOf[CHAT] = [1, 2].map((n) => savedTurn(n));
  fake.handlers['thread/inject_items'] = () => ({}); // the note an edit of a turn from before this run carries
  await s.warm();
  fake.errors['thread/revert'] = { message: `thread not found: ${CHAT}`, once: true };
  const r = await s.edit({ messageId: 'u2', text: 'q2, reworded' });
  assert.equal(r.ok, true);
  await idle(w);
  assert.equal(fake.sent('thread/revert').length, 2);
  assert.equal(fake.sent('thread/resume').length, 2, 'opened again in between');
  assert.deepEqual(savedTexts(fake, CHAT), [['q1'], ['q2, reworded']]);
  assert.equal(fake.spawns.length, 1);
});

test('a message Codex has not been handed yet is swapped for the new one: there is no turn to cut', async () => {
  const { s, fake, w } = make({ extended: ['send-state'] });
  const a = s.send('helo wrold');
  const r = await s.edit({ messageId: a.id, text: 'hello world', id: NEW_ID });
  assert.deepEqual(r, { ok: true, id: NEW_ID, fresh: false, first: true, replaced: 'helo wrold' });
  assert.equal(s.busy, true);
  await idle(w, w.mark());
  assert.deepEqual(sendStates(w, a.id), ['pending', 'cancelled']);
  assert.deepEqual(fake.sent('turn/start').map(textOf), ['hello world'], 'the first wording never reached Codex');
  assert.equal(fake.sent('thread/revert').length, 0);
  assert.equal(w.of('notice').filter((e) => e.code === 'send-cancelled').length, 0, 'the one being edited is withdrawn without a word');
  assert.deepEqual(w.find('edit').messageId, a.id);
  assert.deepEqual(savedTexts(fake, s.sessionId), [['hello world']]);
});

test('a message whose turn Codex has not named yet: the edit waits for the name, then cuts that turn', async () => {
  const { s, fake, w } = make({}, { hang: ['turn/start'] });
  const a = s.send('go');
  await until(() => fake.sent('turn/start').length === 1);
  const done = s.edit({ messageId: a.id, text: 'go, reworded' });
  await settle(40);
  assert.equal(fake.sent('turn/interrupt').length + fake.sent('thread/revert').length, 0, 'there is no turn to name yet');
  const child = fake.last;
  fake.hang.delete('turn/start');
  child.turn = { id: 'late-turn', params: fake.sent('turn/start')[0].params, inputs: [], items: [], final: null };
  child.userItem(child.turn.params.input);
  child.send({ id: fake.sent('turn/start')[0].id, result: { turn: { id: 'late-turn', items: [], status: 'inProgress', error: null } } });
  const r = await done;
  assert.deepEqual([r.ok, r.first, r.replaced], [true, true, 'go']);
  await idle(w);
  assert.deepEqual(fake.sent('turn/interrupt').map((m) => m.params.turnId), ['late-turn']);
  assert.deepEqual(fake.reverts, [{ threadId: s.sessionId, beforeTurnId: 'late-turn', dropped: ['late-turn'] }]);
  assert.deepEqual(savedTexts(fake, s.sessionId), [['go, reworded']]);
});

test('an edited message keeps its pictures: this run\'s and a saved chat\'s, unless new ones are given', async () => {
  const png = { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' };
  const { s, fake, w } = make();
  const a = s.send('what is this', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
  await idle(w);
  assert.equal(s.sendTurns.get(a.id).images, 1);
  let mark = w.mark();
  const r = await s.edit({ messageId: a.id, text: 'what breed is this' });
  assert.equal(r.ok, true);
  await idle(w, mark);
  assert.deepEqual(fake.sent('turn/start').at(-1).params.input, [{ type: 'text', text: 'what breed is this', text_elements: [] }, png], 'read back from the saved turn and sent again as it was');
  // Only the picture, no words: still something to send.
  mark = w.mark();
  const bare = await s.edit({ messageId: r.id, text: '' });
  assert.equal(bare.ok, true);
  await idle(w, mark);
  assert.deepEqual(fake.sent('turn/start').at(-1).params.input, [png]);
  // New attachments replace the old ones; an empty list drops them.
  mark = w.mark();
  const swapped = await s.edit({ messageId: bare.id, text: 'and this one', images: [{ mediaType: 'image/jpeg', data: '/9j/4AAQ' }] });
  await idle(w, mark);
  assert.deepEqual(fake.sent('turn/start').at(-1).params.input, [{ type: 'text', text: 'and this one', text_elements: [] }, { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQ' }]);
  mark = w.mark();
  await s.edit({ messageId: swapped.id, text: 'no picture now', images: [] });
  await idle(w, mark);
  assert.deepEqual(fake.sent('turn/start').at(-1).params.input, [{ type: 'text', text: 'no picture now', text_elements: [] }]);

  // A saved chat's message: its parts come with the lookup.
  const old = make({ resume: CHAT }, { known: [CHAT] });
  old.fake.turnsOf[CHAT] = [{ ...savedTurn(1), items: [{ type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'look' }, png, { type: 'localImage', path: '/tmp/a.png' }] }] }];
  assert.equal((await old.s.edit({ messageId: 'u1', text: 'look again' })).ok, true);
  await idle(old.w);
  assert.deepEqual(old.fake.sent('turn/start')[0].params.input, [{ type: 'text', text: 'look again', text_elements: [] }, png, { type: 'localImage', path: '/tmp/a.png' }]);
  // Nothing to say and nothing to show: refused before anything is cut.
  const none = make();
  const b = none.s.send('words only');
  await idle(none.w);
  assert.deepEqual(await none.s.edit({ messageId: b.id, text: '   ' }), { ok: false, code: 'invalid-input', message: 'There is nothing to send.' });
  assert.equal(none.fake.sent('thread/revert').length, 0);
});

test('after a cut the next turn says its mode again: a chat in Plan mode stays in Plan mode', async () => {
  const { s, fake, w } = make({ permissionMode: 'plan' });
  const run = async (text) => { const mark = w.mark(); const r = s.send(text); await idle(w, mark); return { r, params: fake.sent('turn/start').at(-1).params }; };
  assert.equal((await run('a')).params.collaborationMode.mode, 'plan');
  const b = await run('b');
  assert.ok(!('collaborationMode' in b.params), 'unchanged: not said again');
  const mark = w.mark();
  await s.edit({ messageId: b.r.id, text: 'b, reworded' });
  await idle(w, mark);
  const after = fake.sent('turn/start').at(-1).params;
  assert.equal(after.collaborationMode.mode, 'plan', 'Codex opened the thread again from what was left, so the mode is said anew');
  assert.deepEqual(after.sandboxPolicy, READ_ONLY);
  assert.equal(after.approvalPolicy, 'on-request');
});

test('thread/reverted: this session\'s own cut says nothing more; one it did not ask for tells the window to read the chat again', async () => {
  const { s, fake, w } = make();
  const a = s.send('first');
  await idle(w);
  let mark = w.mark();
  await s.edit({ messageId: a.id, text: 'first, reworded' });
  await idle(w, mark);
  await settle();
  assert.equal(w.of('reverted').length, 0, 'the edit event already said it');
  assert.ok(!w.events.some((e) => e.kind === 'raw'), 'and Codex\'s lines around a cut are all known');
  s.revertedAt = 0; // long ago
  mark = w.mark();
  fake.last.note('thread/reverted', { threadId: s.sessionId });
  fake.last.note('thread/reverted', { threadId: 'some-other-thread' });
  await settle();
  assert.deepEqual(w.all(() => true, mark).map((e) => [e.kind, e.sessionId]), [['reverted', s.sessionId]]);
});

test('edit() checks what it is given, and answers a closed chat without throwing', async () => {
  const { s, fake, w } = make();
  const a = s.send('first');
  await idle(w);
  const invalid = async (opts) => { const r = await s.edit(opts); return [r.ok, r.code]; };
  for (const opts of [undefined, null, {}, 5, 'x', { messageId: 7, text: 'x' }, { messageId: '', text: 'x' }, { messageId: 'x'.repeat(201), text: 'x' },
    { messageId: a.id }, { messageId: a.id, text: 5 }, { messageId: a.id, text: 'x', id: 'not-a-uuid' }, { messageId: a.id, text: 'x', images: 'no' },
    { messageId: a.id, text: 'x', images: [{ mediaType: 'text/plain', data: 'AAAA' }] }]) {
    assert.deepEqual(await invalid(opts), [false, 'invalid-input'], JSON.stringify(opts));
  }
  assert.equal(fake.sent('thread/revert').length, 0);
  assert.equal(s.editing, false);
  await s.dispose({ graceMs: 50 });
  assert.deepEqual(await s.edit({ messageId: a.id, text: 'x' }), { ok: false, code: 'closed', message: 'This session was closed.' });
});

test('the chat closing in the middle of an edit: it answers closed, and nothing is left running', async () => {
  const { s, fake, w } = make({}, { holdTurns: true, ignoreInterrupt: true });
  const a = s.send('go');
  await w.waitFor('message-start', { ms: 2000 });
  const done = s.edit({ messageId: a.id, text: 'go, reworded' });
  await until(() => fake.sent('turn/interrupt').length === 1);
  await s.dispose({ graceMs: 50 });
  assert.deepEqual(await done, { ok: false, code: 'closed', message: 'This session was closed.' });
  assert.equal(fake.sent('thread/revert').length, 0);
  assert.equal(fake.alive().length, 0);
});

test('the process gets the user\'s environment without the host\'s, the chat\'s folder, and only the flags it was given', async () => {
  const env = { ...baseEnv(), OPENAI_API_KEY: 'sk-user-key-0123456789abcdef', CODEX_HOME: path.join(home, '.codex'), CLAUDECODE: '1', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', CANOPY_CODEX_PATH: '/x', CODEX_THREAD_ID: 'outer' };
  let reads = 0;
  const plain = make({ env: () => { reads += 1; return env; }, codexPath: () => '/fake/codex' });
  await plain.s.warm();
  const spawn = plain.fake.spawns[0];
  assert.equal(spawn.command, '/fake/codex');
  assert.deepEqual(spawn.args, ['app-server', '--listen', 'stdio://'], 'the app passes no -c flag: the user\'s Codex config is theirs');
  assert.equal(spawn.options.cwd, work);
  assert.deepEqual(Object.keys(spawn.options.env).sort(), ['CODEX_HOME', 'HOME', 'OPENAI_API_KEY', 'PATH']);
  assert.equal(spawn.options.env.OPENAI_API_KEY, env.OPENAI_API_KEY, 'the login is theirs and is passed on untouched');
  assert.equal(reads, 1, 'the environment is read at each start');

  const flagged = make({ config: { notify: [], model_reasoning_summary: 'auto', 'mcp_servers.docs.enabled': false, 'bad key': 1 }, flags: ['--disable', 'memories'] });
  await flagged.s.warm();
  assert.deepEqual(flagged.fake.spawns[0].args, [
    'app-server', '--listen', 'stdio://', '-c', 'notify=[]', '-c', 'model_reasoning_summary="auto"', '-c', 'mcp_servers.docs.enabled=false', '--disable', 'memories',
  ]);
});

test('the adapter is a seam: a stub can stand in, and one that throws does not take the chat down', async () => {
  const stub = {
    createAdapter: () => ({
      adapt: (msg) => (msg.method === 'turn/started' ? [{ kind: 'message-start', stub: true }] : msg.method === 'turn/completed' ? [{ kind: 'turn-end', text: 'from the stub', isError: false }] : []),
      request: () => null, usage: () => ({ contextTokens: 50, contextWindow: 200 }), reset() {},
    }),
    adaptHistory: () => [{ kind: 'user-text', text: 'stubbed' }],
    replyTo: () => ({ result: {}, stops: false }),
    initEvent: (result, extra) => ({ kind: 'init', sessionId: result.thread.id, stub: true, ...extra }),
  };
  const a = make({ adapter: stub });
  const sent = a.s.send('hi');
  await idle(a.w);
  assert.deepEqual(kinds(a.w).filter((k) => !['busy', 'meta', 'notice'].includes(k)), ['init', 'message-start', 'turn-end']);
  assert.equal(a.w.find('init').stub, true);
  const end = a.w.find('turn-end');
  assert.deepEqual([end.text, end.sessionId, end.userUuids], ['from the stub', a.s.sessionId, [sent.id]]);
  assert.equal((await a.s.contextUsage()).percentage, 25);
  assert.deepEqual((await a.s.history()).events, [{ kind: 'user-text', text: 'stubbed' }]);

  const broken = { ...stub, createAdapter: () => ({ adapt: () => { throw new Error('adapter bug'); }, request: () => { throw new Error('adapter bug'); }, usage: () => { throw new Error('adapter bug'); } }) };
  const b = make({ adapter: broken }, { holdTurns: true });
  b.s.send('hi');
  await until(() => b.fake.sent('turn/start').length === 1);
  await until(() => b.s.sessionId, 2000, 'the turn to start');
  const q = commandAsk(b.fake.last);
  assert.equal((await within(q.answer, 1000, 'the refusal')).error.code, -32601);
  b.fake.last.playText();
  await idle(b.w);
  assert.equal(await b.s.contextUsage(), null);
  assert.ok(b.logs.some((l) => l.msg === 'the codex adapter threw'));
  assert.equal(b.s.outbox.size, 0);
});

test('no public method throws, whatever it is given', async () => {
  const { s, fake, w } = make();
  const junk = [undefined, null, 0, -1, NaN, '', 'x', [], {}, () => {}, Symbol('s'), new Map(), { toString() { throw new Error('no'); } }];
  for (const v of junk) {
    assert.doesNotThrow(() => s.send(v, v, v));
    assert.doesNotThrow(() => s.respond(v, v));
    for (const call of [
      () => s.set(v, v), () => s.set('permissionMode', v), () => s.set('model', v), () => s.set('effort', v), () => s.set('fast', v), () => s.configure(v),
      () => s.warm(v), () => s.interrupt(v), () => s.history(v), () => s.contextUsage(v), () => s.rename(v), () => s.mcpStatus(v),
      () => s.stopTask(v), () => s.background(v), () => s.mcp(v, v, v), () => s.reload(v), () => s.branch(v), () => s.rewindFiles(v, v), () => s.generateTitle(v), () => s.usage(v),
      () => s.edit(v), () => s.edit({ messageId: v, text: v, images: v, id: v }),
    ]) {
      let p;
      assert.doesNotThrow(() => { p = call(); });
      await assert.doesNotReject(Promise.resolve(p));
    }
    assert.doesNotThrow(() => { s.snapshot(); s.trust(v); s.unpark(v); s.reportedBusy(); });
  }
  await s.interrupt();
  await settle();
  assert.equal(fake.sent('turn/start').length, 0, 'none of that junk was a message');
  assert.doesNotThrow(() => new CodexSession());
  assert.doesNotThrow(() => new CodexSession({ resume: 5, extended: 'x', timeouts: 'x', config: 3, flags: 'x', adapter: 7, permissionMode: {}, model: 5, effort: [], fast: 'yes' }));
  const bare = new CodexSession();
  assert.equal((await bare.warm()).ok, false);
  assert.equal(bare.send('x').ok, true, 'the failure arrives as an event, not a throw');
  await bare.dispose();
  s.send('a real one');
  await idle(w);
  assert.equal(w.of('turn-end').at(-1).subtype, 'success', 'and the session still works');
});

test('the API-key billing notice is said once per app process, not once per chat', async () => {
  const a = make();
  await a.s.warm();
  const b = make();
  await b.s.warm();
  assert.equal(billingNotices, 1);
  assert.equal(CODEX_SESSION_TIMEOUTS.init, 30000);
  assert.equal(CODEX_SESSION_TIMEOUTS.thread, 90000);
  assert.equal(CODEX_SESSION_TIMEOUTS.turn, 30000);
});

// ---- the plan's limits, for the Usage tab ----

test('limits: asked of the chat’s own process, and every update Codex sends is handed on as it came', async () => {
  // A ChatGPT plan, and its limits as Codex answers the call (the fake answers it for such a login only, as Codex does).
  const SNAPSHOT = { limitId: 'codex', limitName: null, primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: null, credits: null, planType: 'pro', rateLimitReachedType: null };
  const LIMITS = { rateLimits: SNAPSHOT, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null };
  const seen = [];
  const { s, fake, w } = make({ onRateLimits: (limits) => seen.push(limits), timeouts: { meta: 200 } }, { account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' }, rateLimits: SNAPSHOT });
  assert.deepEqual(await s.rateLimits(), { ok: false, code: 'not-running' }, 'no process: none is started just to ask');
  assert.equal(fake.spawns.length, 0);
  s.send('hello');
  await idle(w);
  const turns = fake.sent('turn/start').length;
  // The chat reads them for its own context ring too (when it opens and after each turn): this call is one more.
  await until(() => fake.sent('account/rateLimits/read').length === 2);
  assert.deepEqual(await s.rateLimits(), { ok: true, limits: LIMITS });
  assert.deepEqual(fake.sent('account/rateLimits/read').map((m) => 'params' in m), [false, false, false], 'asked once more, with no parameters');
  assert.equal(fake.sent('turn/start').length, turns, 'asking starts no turn');

  // Updates between reads: sparse, and well below any limit. The transcript says nothing; the host still hears.
  const mark = w.mark();
  const update = { limitId: 'codex', limitName: null, primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: null, credits: null, planType: null, rateLimitReachedType: null };
  fake.last.note('account/rateLimits/updated', { rateLimits: update });
  fake.last.note('account/rateLimits/updated', { rateLimits: 5 });
  fake.last.note('account/rateLimits/updated', {});
  await until(() => seen.length === 1);
  await settle();
  assert.deepEqual(seen, [update]);
  assert.notEqual(seen[0], update);
  assert.deepEqual(w.all('notice', mark), [], 'an ordinary update is not a notice');
  // A limit reached is still said in the chat, once, as before.
  fake.last.note('account/rateLimits/updated', { rateLimits: { ...update, primary: { ...update.primary, usedPercent: 100 }, rateLimitReachedType: 'rate_limit_reached' } });
  await until(() => seen.length === 2);
  assert.equal((await w.waitFor((e) => e.kind === 'notice' && e.code === 'rate-limit', { ms: 2000, from: mark })).level, 'warn');

  // A login with no plan, a call that hangs, and an observer that throws: none of them breaks the chat.
  fake.rateLimits = null;
  assert.deepEqual(await s.rateLimits(), { ok: false, code: 'rejected' });
  fake.hang.add('account/rateLimits/read');
  assert.deepEqual(await s.rateLimits(), { ok: false, code: 'timeout' });
  const loud = make({ onRateLimits: () => { throw new Error('observer bug'); } });
  loud.s.send('hello');
  await idle(loud.w);
  loud.fake.last.note('account/rateLimits/updated', { rateLimits: update });
  await settle();
  assert.equal(loud.s.lifecycle, 'ready');
  assert.ok(loud.logs.some((l) => l.msg === 'observer failed'));
});


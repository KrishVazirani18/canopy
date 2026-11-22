// What CodexSession does so an OpenAI chat behaves like a Claude chat: `/compact`, `/review` and
// `/goal` run as Codex's own calls, usage limits beside the context reading, the chat's agents nested and listed,
// the model on a turn's end, the ring moving during a long turn, the slow-start notice, and one wording for both.
// Driven by the scripted stand-in (fake-codex.mjs). None of these calls is in a recording yet, so the stand-in
// follows the 0.153.4 protocol types. No Codex is started and nothing under ~/.codex is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { CodexSession } from '../../codex-session.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-parity-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const CHAT = '00000000-0000-7000-8000-432d1c714b94'; // a chat that is already on disk
const CHILD = '0f000000-0000-7000-8000-0000000000c1';
const CHATGPT = { type: 'chatgpt', email: 'sam@example.com', planType: 'plus' };

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
  const logs = [];
  const s = new CodexSession({
    cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: home }, spawnFn: fake.spawnFn, log: (level, msg, data) => logs.push({ level, msg, data }),
    ...opts, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
  });
  open.push(s);
  return { s, fake, w: watch(s), logs };
}
/** A chat that is on disk already, so commands that need a saved chat can run from its first message. */
const saved = (opts = {}, script = {}) => make({ resume: CHAT, ...opts }, { known: [CHAT], ...script });

const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });
const notices = (w, from = 0) => w.of('notice', from).filter((e) => e.code !== 'api-key-billing').map((e) => e.text);
const kinds = (w, from = 0) => w.events.slice(from).map((e) => e.kind);
/** Send and wait for the chat to be free again. */
async function say(s, w, text) {
  const mark = w.mark();
  const r = s.send(text);
  assert.equal(r.ok, true);
  await idle(w, mark);
  return { mark, id: r.id };
}

// ---- wording ----

test('an API key is said in the words a Claude chat uses, with the plan\'s own name', async () => {
  const { s, w } = make();
  await s.warm();
  assert.equal(w.find((e) => e.code === 'api-key-billing').text, 'This conversation is billed to an API key, not your ChatGPT plan.');
});

test('a start that takes long says so after the same wait as a Claude chat, in the same words', async () => {
  const { s, w } = make({ timeouts: { slowStart: 20 } }, { hang: ['thread/start'] });
  const warming = s.warm();
  const slow = await w.waitFor((e) => e.code === 'slow-start', { ms: 3000 });
  assert.deepEqual([slow.kind, slow.level, slow.text], ['notice', 'warn', 'Codex is taking a long time to start (hooks or MCP servers?).']);
  await s.dispose({ graceMs: 50 });
  await warming;
  const quick = make({ timeouts: { slowStart: 200 } });
  await quick.s.warm();
  await sleep(260);
  assert.equal(quick.w.find((e) => e.code === 'slow-start'), null, 'a start that finished in time says nothing');
});

// ---- the `/` menu ----

test('an OpenAI chat lists its three commands, so the `/` menu shows them', async () => {
  const { s, w } = make();
  await s.warm();
  const meta = w.find((e) => e.kind === 'meta' && Array.isArray(e.commands));
  assert.deepEqual(meta.commands.map((c) => c.name), ['compact', 'review', 'goal']);
  assert.equal(meta.commands[0].description, 'Summarize earlier messages to free up context');
  assert.deepEqual(s.snapshot().meta.commands.map((c) => c.name), ['compact', 'review', 'goal'], 'a reloaded window gets them too');
});

// ---- /compact ----

test('/compact starts no turn of the model\'s: it is Codex\'s own compaction, shown as a Claude chat shows it', async () => {
  const { s, fake, w } = saved();
  const { mark, id } = await say(s, w, '/compact');
  assert.equal(fake.sent('turn/start').length, 0, 'the words never reached the model');
  assert.deepEqual(fake.sent('thread/compact/start').map((m) => m.params), [{ threadId: CHAT }]);
  const seen = kinds(w, mark).filter((k) => ['status', 'notice', 'turn-end'].includes(k));
  assert.deepEqual(seen, ['status', 'status', 'status', 'notice', 'turn-end']);
  assert.deepEqual(w.of('status', mark).map((e) => e.status), ['compacting', 'compacting', null], '"Summarizing earlier messages" while it runs');
  assert.deepEqual(notices(w, mark), ['Conversation compacted'], 'the frozen notice the window rewords');
  const end = w.find('turn-end', mark);
  assert.deepEqual([end.subtype, end.isError, end.userUuids], ['success', false, [id]], 'the command is the message this turn answers');
  assert.equal(s.busy, false);
  assert.equal(s.outbox.size, 0);
});

test('/compact that reports no turn, or nothing at all, still leaves the chat free', async () => {
  const line = saved({}, { compaction: 'line' });
  const a = await say(line.s, line.w, '/compact');
  assert.deepEqual(notices(line.w, a.mark), ['Conversation compacted']);
  assert.equal(line.w.of('turn-end', a.mark).length, 1, 'the made-up turn is closed by the line that says it is done');
  assert.equal(line.w.find('turn-end', a.mark).synthetic, true);
  assert.equal(line.s.busy, false);
  // The chat still works afterwards.
  await say(line.s, line.w, 'hello');
  assert.equal(line.fake.sent('turn/start').length, 1);

  const silent = saved({ timeouts: { compact: 40 } }, { compaction: 'silent' });
  const b = await say(silent.s, silent.w, '/compact');
  assert.equal(silent.w.of('turn-end', b.mark).length, 1, 'never left waiting on a compaction that says nothing');
  assert.ok(silent.logs.some((l) => l.msg === 'codex never said the compaction finished'));
});

test('a command Codex refuses says why in one plain line, and the chat is free', async () => {
  const { s, fake, w } = saved({}, { errors: { 'thread/compact/start': { message: 'compaction is not available for this thread' }, 'review/start': { message: 'not a git repository' } } });
  const a = await say(s, w, '/compact');
  assert.deepEqual(notices(w, a.mark), ['Couldn’t run /compact: compaction is not available for this thread']);
  assert.equal(w.find('notice', a.mark).level, 'warn');
  assert.equal(w.of('status', a.mark).at(-1).status, null, 'the status line is cleared');
  assert.equal(w.of('error', a.mark).length, 0, 'not an error row with a retry');
  const b = await say(s, w, '/review');
  assert.deepEqual(notices(w, b.mark), ['Couldn’t run /review: not a git repository']);
  assert.equal(w.of('turn-end').length, 0);
  assert.equal(s.busy, false);
  assert.equal(fake.sent('turn/start').length, 0);
});

test('before the chat\'s first message each command says "send a message first" and calls nothing', async () => {
  const { s, fake, w } = make();
  for (const name of ['compact', 'review', 'goal']) {
    const { mark } = await say(s, w, `/${name}`);
    assert.deepEqual(notices(w, mark), [`Send a message first, then use /${name}.`]);
  }
  for (const method of ['thread/compact/start', 'review/start', 'thread/goal/get', 'thread/goal/set', 'turn/start']) assert.equal(fake.sent(method).length, 0, method);
  assert.equal(s.sessionId, null, 'still not a saved chat');
  // After a real message they run.
  await say(s, w, 'hello');
  const { mark } = await say(s, w, '/compact');
  assert.equal(fake.sent('thread/compact/start').length, 1);
  assert.deepEqual(notices(w, mark), ['Conversation compacted']);
});

test('a command sent while a turn runs waits for that turn to end, and is never folded into it', async () => {
  const { s, fake, w } = saved({}, { holdTurns: true });
  s.send('do the work');
  await until(() => fake.last?.turn && s.state === 'running', 3000, 'the turn to start');
  s.send('/compact');
  s.send('and one more thing');
  await until(() => fake.sent('turn/steer').length === 1, 3000, 'the plain message to be folded in');
  assert.equal(fake.sent('thread/compact/start').length, 0, 'not while the turn runs');
  assert.deepEqual(fake.sent('turn/steer')[0].params.input.map((i) => i.text), ['and one more thing']);
  fake.holdTurns = false;
  fake.last.playText('done');
  await until(() => fake.sent('thread/compact/start').length === 1, 3000, 'the compaction to start');
  await until(() => !s.busy, 3000, 'the chat to be free');
  const ends = w.of('turn-end');
  assert.equal(ends.length, 2, 'the work, then the compaction');
  assert.ok(w.indexOf(ends[0]) < w.indexOf(w.find((e) => e.kind === 'notice' && e.code === 'compacted')));
});

test('a message that only starts like a command, or has a picture, goes to the model as it always did', async () => {
  const { s, fake, w } = saved();
  await say(s, w, '/compacted the files yet?');
  await say(s, w, 'please /review this');
  const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  const mark = w.mark();
  s.send('/review', [png]);
  await idle(w, mark);
  assert.equal(fake.sent('turn/start').length, 3);
  assert.equal(fake.sent('review/start').length + fake.sent('thread/compact/start').length, 0);
});

// ---- /review ----

test('/review is Codex\'s own review: a turn whose reply is what it found', async () => {
  const { s, fake, w } = saved({}, { review: 'One problem: `save()` drops the error.' });
  const { mark, id } = await say(s, w, '/review');
  assert.equal(fake.sent('turn/start').length, 0);
  assert.deepEqual(fake.sent('review/start')[0].params, { threadId: CHAT, target: { type: 'uncommittedChanges' }, delivery: 'inline' });
  assert.deepEqual(w.of('status', mark).map((e) => e.status), ['reviewing', 'reviewing', null]);
  const replies = w.of('assistant-text', mark);
  assert.deepEqual(replies.map((e) => e.text), ['One problem: `save()` drops the error.']);
  const end = w.find('turn-end', mark);
  assert.deepEqual([end.subtype, end.text, end.userUuids, end.synthetic], ['success', 'One problem: `save()` drops the error.', [id], undefined]);
  await say(s, w, '/review branch main');
  await say(s, w, '/review commit 1a2b3c4');
  await say(s, w, '/review only the error handling');
  assert.deepEqual(fake.sent('review/start').slice(1).map((m) => m.params.target), [{ type: 'baseBranch', branch: 'main' }, { type: 'commit', sha: '1a2b3c4', title: null }, { type: 'custom', instructions: 'only the error handling' }]);
});

test('a review can be stopped like any turn', async () => {
  const { s, fake, w } = saved({}, { holdTurns: true });
  s.send('/review');
  await until(() => fake.last?.turn && s.state === 'running', 3000, 'the review to start');
  const r = await s.interrupt();
  assert.equal(r.ok, true);
  await idle(w);
  assert.equal(fake.sent('turn/interrupt').length, 1);
  assert.deepEqual([w.find('turn-end').subtype, w.find('turn-end').isError], ['interrupted', false]);
});

// ---- /goal ----

test('/goal: set, ask, pause, resume, clear, each said once in one plain line', async () => {
  const { s, fake, w } = saved();
  const step = async (text) => { const { mark } = await say(s, w, text); return notices(w, mark); };
  assert.deepEqual(await step('/goal'), ['No goal set.']);
  assert.deepEqual(await step('/goal ship the importer'), ['Goal set: ship the importer'], 'the call\'s answer and Codex\'s own update are one notice, not two');
  assert.deepEqual(fake.sent('thread/goal/set')[0].params, { threadId: CHAT, objective: 'ship the importer', status: 'active' });
  assert.deepEqual(await step('/goal'), ['Goal: ship the importer']);
  assert.deepEqual(await step('/goal pause'), ['Goal paused.']);
  assert.deepEqual(await step('/goal'), ['Goal: ship the importer (paused)']);
  assert.deepEqual(await step('/goal pause'), ['Goal: ship the importer (paused)'], 'already paused: it says where things stand');
  assert.deepEqual(await step('/goal resume'), ['Goal resumed.']);
  assert.deepEqual(await step('/goal clear'), ['Goal cleared.']);
  assert.deepEqual(await step('/goal clear'), ['No goal set.']);
  assert.deepEqual(await step('/goal pause'), ['Couldn’t run /goal: no goal is set for this thread'], 'Codex\'s own refusal, in one line');
  assert.equal(fake.sent('turn/start').length, 0, 'none of it reached the model');
  assert.equal(w.of('turn-end').length, 0, 'and none of it is a turn');
  assert.equal(s.busy, false);
});

test('a goal\'s counts ticking up are not news; its state changing is', async () => {
  const { s, fake, w } = saved();
  await say(s, w, '/goal ship the importer');
  const goal = { ...fake.goals[CHAT] };
  const mark = w.mark();
  const child = fake.last;
  for (const tokensUsed of [1000, 2000, 3000]) child.note('thread/goal/updated', { threadId: CHAT, turnId: null, goal: { ...goal, tokensUsed, timeUsedSeconds: tokensUsed / 100, updatedAt: goal.updatedAt + tokensUsed } });
  child.note('thread/goal/updated', { threadId: CHAT, turnId: null, goal: { ...goal, status: 'complete', tokensUsed: 4000 } });
  await w.waitFor((e) => e.kind === 'notice' && e.code === 'goal', { ms: 3000, from: mark });
  assert.deepEqual(notices(w, mark), ['Goal reached.']);
  child.note('thread/goal/cleared', { threadId: CHAT });
  await w.waitFor((e) => e.text === 'Goal cleared.', { ms: 3000, from: mark });
});

test('reopening a chat says nothing about goals: not the "cleared" every reopen sends, not a goal it already had', async () => {
  const none = saved();
  await none.s.warm();
  await sleep(30);
  assert.ok(none.fake.last.received.length > 0);
  assert.deepEqual(notices(none.w), [], 'thread/goal/cleared arrives on every resume');

  const had = saved();
  await had.s.warm();
  had.fake.last.note('thread/goal/updated', { threadId: CHAT, turnId: null, goal: { threadId: CHAT, objective: 'ship the importer', status: 'paused', tokensUsed: 5, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2, tokenBudget: null } });
  await sleep(30);
  assert.deepEqual(notices(had.w), [], 'what it already had is not news');
  const { mark } = await say(had.s, had.w, '/goal');
  assert.deepEqual(notices(had.w, mark), ['No goal set.'], 'asking reads it from Codex, which is what counts');
});

test('Stop with an active goal pauses it, or Codex would start the next turn at once', async () => {
  const { s, fake, w } = saved({}, { holdTurns: true });
  fake.holdTurns = false;
  await say(s, w, '/goal ship the importer');
  fake.holdTurns = true;
  s.send('keep going');
  await until(() => fake.last?.turn && s.state === 'running', 3000, 'the turn to start');
  const mark = w.mark();
  await s.interrupt();
  await idle(w, mark);
  assert.deepEqual(fake.sent('thread/goal/set').at(-1).params, { threadId: CHAT, status: 'paused' });
  assert.equal(fake.goals[CHAT].status, 'paused');
  assert.deepEqual(notices(w, mark), ['Goal paused.'], 'and it says so, once');
  // With no goal, or a paused one, Stop is just Stop.
  const before = fake.sent('thread/goal/set').length;
  s.send('again');
  await until(() => fake.last?.turn && s.state === 'running', 3000, 'the turn to start');
  const again = w.mark();
  await s.interrupt();
  await idle(w, again);
  assert.equal(fake.sent('thread/goal/set').length, before);
});

// ---- usage limits ----

test('contextUsage() carries the plan\'s limits for a ChatGPT login', async () => {
  const { s, fake, w } = make({}, { account: CHATGPT });
  await say(s, w, 'hello');
  await until(() => fake.sent('account/rateLimits/read').length >= 2, 3000, 'the limits to be read again after the turn');
  const u = await s.contextUsage();
  assert.deepEqual([u.totalTokens, u.maxTokens, u.percentage], [21800, 258400, 8]);
  assert.deepEqual(u.limits, [
    { id: 'five_hour', name: '5-hour limit', usedPercent: 42, resetsAt: (1794801559 + 3600) * 1000 },
    { id: 'weekly', name: 'weekly limit', usedPercent: 12, resetsAt: (1794801559 + 400000) * 1000 },
  ]);
  // An update in between is laid over the snapshot: the window it names moves, the other stays.
  fake.last.note('account/rateLimits/updated', { rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1794801559 + 3600 }, secondary: null, credits: null, rateLimitReachedType: null } });
  await until(() => s.limits()[0].usedPercent === 55, 3000, 'the update to land');
  assert.deepEqual(s.limits().map((l) => [l.id, l.usedPercent]), [['five_hour', 55], ['weekly', 12]]);
});

test('an API key has no limits: nothing is asked, nothing is said', async () => {
  const { s, fake, w, logs } = make();
  await say(s, w, 'hello');
  assert.equal(fake.sent('account/rateLimits/read').length, 0, 'Codex refuses this call under an API key, so it is not made');
  assert.deepEqual((await s.contextUsage()).limits, []);
  assert.equal(logs.filter((l) => l.msg === 'codex reports no usage limits for this login').length, 1, 'said once, in the log');
});

test('a login Codex will not read limits for: [] and one line in the log, never an event', async () => {
  const { s, fake, w, logs } = make({}, { account: CHATGPT, errors: { 'account/rateLimits/read': { message: 'chatgpt authentication required to read rate limits' } } });
  await say(s, w, 'hello');
  await say(s, w, 'again');
  assert.equal(fake.sent('account/rateLimits/read').length, 1, 'refused once, not asked again');
  assert.deepEqual((await s.contextUsage()).limits, []);
  assert.equal(logs.filter((l) => l.msg === 'codex reports no usage limits for this login').length, 1);
  assert.deepEqual(w.all((e) => e.kind === 'error' || (e.kind === 'notice' && /authentication|limit/i.test(e.text))), [], 'the user is never told');
});

test('nearly reaching a limit is said once per window, in a Claude chat\'s words', async () => {
  const { s, fake, w } = make({}, { account: CHATGPT });
  await s.warm();
  const update = (usedPercent, resetsAt = 1794805200) => fake.last.note('account/rateLimits/updated', { rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent, windowDurationMins: 300, resetsAt }, secondary: null, credits: null, rateLimitReachedType: null } });
  update(82); update(88); update(95);
  await w.waitFor((e) => e.code === 'rate-limit-warning', { ms: 3000 });
  await sleep(30);
  const said = w.all((e) => e.code === 'rate-limit-warning');
  assert.equal(said.length, 1);
  assert.match(said[0].text, /^Approaching your usage limit \(5-hour limit, 82% used\)\. It resets (at|on) /);
  update(81, 1794823200);
  await until(() => w.all((e) => e.code === 'rate-limit-warning').length === 2, 3000, 'the next window to be said');
});

// ---- the ring during a turn ----

test('the ring is told about new token counts during a long turn, at most so often, and never in a quick one', async () => {
  const long = make({ timeouts: { contextEvery: 400 } }, { holdTurns: true });
  long.s.send('a long job');
  await until(() => long.fake.last?.turn && long.s.state === 'running', 3000, 'the turn to start');
  long.fake.last.usage(30000);
  await sleep(15);
  assert.equal(long.w.of('context').length, 0, 'not in the turn\'s first moments');
  await sleep(420);
  long.fake.last.usage(51680);
  long.fake.last.usage(60000);
  const first = await long.w.waitFor('context', { ms: 3000 });
  assert.deepEqual({ ...first, seq: undefined }, { kind: 'context', totalTokens: 51680, maxTokens: 258400, percentage: 20, limits: [], seq: undefined });
  await sleep(15);
  assert.equal(long.w.of('context').length, 1, 'the one right after it waits its turn');
  await sleep(420);
  long.fake.last.usage(70000);
  await until(() => long.w.of('context').length === 2, 3000, 'the next reading');
  long.fake.last.playText('done');
  await idle(long.w);

  const quick = make();
  await say(quick.s, quick.w, 'hello');
  assert.equal(quick.w.of('context').length, 0, 'a quick turn reports its numbers when it ends, as always');
});

// ---- the model on a turn's end ----

test('a turn\'s end names the model that ran it, and follows a switch', async () => {
  const { s, w } = make();
  const a = await say(s, w, 'hello');
  assert.equal(w.find('turn-end', a.mark).model, 'gpt-6.1-sol', 'the user\'s own model, as Codex reported it');
  const other = s.models.find((m) => m.value !== 'gpt-6.1-sol' && !m.hidden).value;
  await s.set('model', other);
  const b = await say(s, w, 'again');
  assert.equal(w.find('turn-end', b.mark).model, other);
});

// ---- agents ----

const spawn = (child, extra = {}) => ({ type: 'collabAgentToolCall', id: 'ag-1', tool: 'spawnAgent', status: 'inProgress', senderThreadId: child.threadId, receiverThreadIds: [CHILD], prompt: 'Run the tests\nand report', model: 'gpt-6-luna', reasoningEffort: null, agentsStates: {}, ...extra });
const exec = (extra = {}) => ({ type: 'commandExecution', id: 'exec-c1', command: "/bin/zsh -lc 'npm test'", cwd: work, processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: null, exitCode: null, durationMs: null, ...extra });
/** A turn that starts an agent and leaves both running: the test plays the rest. */
function agentTurn(child, turn) {
  child.startTurn();
  child.userItem(turn.params.input);
  child.note('item/started', { item: spawn(child), threadId: child.threadId, turnId: turn.id });
}
const fromChild = (child, method, params) => child.note(method, { threadId: CHILD, ...params });

test('an agent\'s steps are nested under its Agent row, it is listed while it runs, and its turn is not the chat\'s', async () => {
  const { s, fake, w } = make({ extended: ['tasks'] }, { script: agentTurn });
  s.send('use an agent');
  const row = await w.waitFor((e) => e.kind === 'tool-start' && e.name === 'Agent', { ms: 3000 });
  assert.deepEqual([row.id, row.parent, row.input.prompt], ['ag-1', null, 'Run the tests\nand report']);
  const listed = await w.waitFor('tasks', { ms: 3000 });
  assert.deepEqual(listed.tasks.map((t) => [t.taskId, t.status, t.description, t.toolUseId, t.agentType]), [[CHILD, 'running', 'Run the tests', 'ag-1', 'gpt-6-luna']]);
  assert.deepEqual(listed.background, []);
  assert.deepEqual(s.snapshot().tasks.map((t) => t.taskId), [CHILD], 'a reloaded window gets the list too');

  const child = fake.last;
  const mark = w.mark();
  fromChild(child, 'turn/started', { turn: { id: 'turn-c1', items: [], status: 'inProgress' } });
  fromChild(child, 'item/started', { item: exec(), turnId: 'turn-c1' });
  fromChild(child, 'item/completed', { item: exec({ status: 'completed', aggregatedOutput: '746 pass', exitCode: 0 }), turnId: 'turn-c1' });
  fromChild(child, 'item/completed', { item: { type: 'agentMessage', id: 'msg-c1', text: 'All green.', phase: 'final_answer' }, turnId: 'turn-c1' });
  fromChild(child, 'turn/completed', { turn: { id: 'turn-c1', items: [], status: 'completed' } });
  const said = await w.waitFor((e) => e.kind === 'assistant-text' && e.parent === 'ag-1', { ms: 3000, from: mark });
  assert.equal(said.text, 'All green.');
  const step = w.find((e) => e.kind === 'tool-start' && e.id === 'exec-c1');
  assert.deepEqual([step.name, step.parent, step.agentId], ['Bash', 'ag-1', CHILD]);
  assert.deepEqual([w.find((e) => e.kind === 'tool-result' && e.id === 'exec-c1').parent, w.find((e) => e.kind === 'tool-result' && e.id === 'exec-c1').content], ['ag-1', '746 pass']);
  assert.equal(w.of('turn-end').length, 0, 'the agent\'s turn ending did not end the chat\'s');
  assert.equal(w.of('message-start').length, 1, 'nor did it start one');
  assert.equal(s.busy, true);
  assert.equal(w.all((e) => e.kind === 'tasks').at(-1).tasks[0].lastTool, 'Bash', 'the drawer says what it is doing');

  // The chat's own turn carries on and ends itself; the call's last word marks the agent done.
  child.note('item/completed', { item: spawn(child, { status: 'completed', agentsStates: { [CHILD]: { status: 'completed', message: 'All green.' } } }), threadId: child.threadId, turnId: child.turn.id });
  child.playText('The agent says all green.');
  await idle(w);
  assert.deepEqual([w.find('turn-end').text, w.find('turn-end').subtype], ['The agent says all green.', 'success']);
  const last = w.all((e) => e.kind === 'tasks').at(-1).tasks[0];
  assert.deepEqual([last.status, last.summary], ['completed', 'All green.']);
  assert.equal(typeof last.endedAt, 'number');
});

test('without the host asking for tasks, none are sent (as for a Claude chat), and the steps still nest', async () => {
  const { s, fake, w } = make({}, { script: agentTurn });
  s.send('use an agent');
  await w.waitFor((e) => e.kind === 'tool-start' && e.name === 'Agent', { ms: 3000 });
  fromChild(fake.last, 'item/started', { item: exec(), turnId: 'turn-c1' });
  await w.waitFor((e) => e.kind === 'tool-start' && e.id === 'exec-c1' && e.parent === 'ag-1', { ms: 3000 });
  assert.equal(w.of('tasks').length, 0);
  fake.last.playText('done');
  await idle(w);
});

test('a line from a thread that is not one of the chat\'s agents is still not this chat', async () => {
  const { s, fake, w } = make({ extended: ['tasks'] }, { holdTurns: true });
  s.send('hello');
  await until(() => fake.last?.turn && s.state === 'running', 3000, 'the turn to start');
  const mark = w.mark();
  fromChild(fake.last, 'turn/started', { turn: { id: 'turn-x' } });
  fromChild(fake.last, 'item/started', { item: exec(), turnId: 'turn-x' });
  fromChild(fake.last, 'turn/completed', { turn: { id: 'turn-x', items: [], status: 'completed' } });
  fake.last.playText('done');
  await idle(w);
  assert.deepEqual(w.all((e) => e.kind === 'tool-start' || e.kind === 'tasks', mark), []);
  assert.equal(w.of('turn-end').length, 1);
});

test('an agent\'s approval card says who asked, and is answered to the agent', async () => {
  const { s, fake, w } = make({ extended: ['tasks'] }, { script: agentTurn });
  s.send('use an agent');
  await w.waitFor('tasks', { ms: 3000 });
  const child = fake.last;
  fromChild(child, 'turn/started', { turn: { id: 'turn-c1' } });
  fromChild(child, 'item/started', { item: exec(), turnId: 'turn-c1' });
  const asked = child.ask('item/commandExecution/requestApproval', { threadId: CHILD, turnId: 'turn-c1', itemId: 'exec-c1', kind: 'command', reason: 'May I?', command: "/bin/zsh -lc 'npm test'", commandActions: [{ type: 'unknown', command: 'npm test' }], availableDecisions: ['accept', 'decline', 'cancel'] });
  const card = await w.waitFor('permission', { ms: 3000 });
  assert.deepEqual([card.agentId, card.toolName, card.toolUseId, card.input.command], [CHILD, 'Bash', 'exec-c1', 'npm test'], '"Requested by a subagent", about the agent\'s own step');
  assert.equal(s.respond(card.id, { action: 'allow' }).ok, true);
  assert.deepEqual((await asked.answer).result, { decision: 'accept' });
  child.playText('done');
  await idle(w);
});

test('stopTask stops the agent\'s turn and leaves the chat\'s own running', async () => {
  const { s, fake, w } = make({ extended: ['tasks'] }, { script: agentTurn });
  s.send('use an agent');
  await w.waitFor('tasks', { ms: 3000 });
  const child = fake.last;
  // Before the agent's turn is named: the stop is remembered, the agent's lines are asked for, and it goes out the moment the turn is known.
  fake.known.add(CHILD);
  assert.deepEqual(await s.stopTask(CHILD), { ok: true, pending: true });
  await until(() => fake.sent('thread/resume').some((m) => m.params.threadId === CHILD), 3000, 'the agent to be followed');
  assert.equal(fake.sent('turn/interrupt').length, 0);
  fromChild(child, 'turn/started', { turn: { id: 'turn-c1' } });
  await until(() => fake.sent('turn/interrupt').length === 1, 3000, 'the stop to go out');
  assert.deepEqual(fake.sent('turn/interrupt')[0].params, { threadId: CHILD, turnId: 'turn-c1' });
  // With its turn known: at once.
  fromChild(child, 'turn/completed', { turn: { id: 'turn-c1', items: [], status: 'interrupted' } });
  await until(() => s.snapshot().tasks[0].status === 'stopped', 3000, 'the agent to be marked stopped');
  fromChild(child, 'turn/started', { turn: { id: 'turn-c2' } });
  await until(() => s.agents.turnOf(CHILD)?.turnId === 'turn-c2', 3000, 'its next turn');
  assert.deepEqual(await s.stopTask(CHILD), { ok: true });
  assert.deepEqual(fake.sent('turn/interrupt')[1].params, { threadId: CHILD, turnId: 'turn-c2' });
  assert.equal(s.busy, true, 'the chat itself was not stopped');
  assert.equal(child.turn !== null, true);
  assert.deepEqual(await s.stopTask('nobody'), { ok: false, code: 'not-found', message: 'That agent is no longer running.' });
  child.playText('done');
  await idle(w);
});

test('an agent that says nothing is asked for its lines, and let go of when it ends', async () => {
  const { s, fake, w } = make({ extended: ['tasks'], timeouts: { agentQuiet: 30 } }, { script: agentTurn });
  fake.known.add(CHILD);
  s.send('use an agent');
  await w.waitFor('tasks', { ms: 3000 });
  await until(() => fake.sent('thread/resume').some((m) => m.params.threadId === CHILD), 3000, 'the silent agent to be followed');
  assert.deepEqual(fake.sent('thread/resume').find((m) => m.params.threadId === CHILD).params, { threadId: CHILD, excludeTurns: true });
  await sleep(80);
  assert.equal(fake.sent('thread/resume').filter((m) => m.params.threadId === CHILD).length, 1, 'asked once');
  const child = fake.last;
  child.note('item/completed', { item: spawn(child, { status: 'completed', agentsStates: { [CHILD]: { status: 'completed', message: 'ok' } } }), threadId: child.threadId, turnId: child.turn.id });
  await until(() => fake.sent('thread/unsubscribe').length === 1, 3000, 'the agent to be let go of');
  assert.deepEqual(fake.sent('thread/unsubscribe')[0].params, { threadId: CHILD });
  child.playText('done');
  await idle(w);

  // One that speaks on its own is never asked for.
  const heard = make({ extended: ['tasks'], timeouts: { agentQuiet: 30 } }, { script: agentTurn });
  heard.s.send('use an agent');
  await heard.w.waitFor('tasks', { ms: 3000 });
  fromChild(heard.fake.last, 'turn/started', { turn: { id: 'turn-c1' } });
  await sleep(90);
  assert.equal(heard.fake.sent('thread/resume').length, 0);
  heard.fake.last.playText('done');
  await idle(heard.w);
});

test('when the chat\'s process dies its agents are marked stopped, not left running forever', async () => {
  const { s, fake, w } = make({ extended: ['tasks'], autoRestart: false }, { script: agentTurn });
  s.send('use an agent');
  await w.waitFor('tasks', { ms: 3000 });
  fake.last.die(1);
  await idle(w);
  assert.equal(w.all((e) => e.kind === 'tasks').at(-1).tasks[0].status, 'stopped');
});

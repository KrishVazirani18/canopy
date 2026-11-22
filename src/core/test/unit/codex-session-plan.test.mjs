// The plan card and the question card an OpenAI chat raises itself (codex-session.mjs, with the rules of
// plan-ready.mjs), driven by the scripted Codex (fake-codex.mjs) and by the recorded Plan-mode turn replayed:
// when a plan is offered, what Build it and a new message do to it, when it is withdrawn, the question Codex asks
// in passing, and how the host (chats.mjs) reads all of it. No Codex is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex, recordedIds } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { BUILD_WORDS } from '../../plan-ready.mjs';
import { ChatHost } from '../../../chats.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-plan-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const READ_ONLY = { type: 'readOnly', networkAccess: false };
const PLAN = '1. Add the flag to the parser.\n2. Thread it through to the runner.';
const TALK = 'The parser lives in src/args.ts and has one caller.';
const baseEnv = () => ({ PATH: '/usr/bin:/bin', HOME: home });

const open = [];
const fakes = [];
const hosts = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) { try { await within(h.closeAll(), 4000, 'closeAll'); } catch { /* reported by the test itself */ } }
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  const left = fakes.splice(0).flatMap((f) => f.alive());
  assert.equal(left.length, 0, 'every process a session started is gone once it is disposed');
});

const sessionOpts = (fake, opts = {}) => ({
  cwd: work, codexPath: '/fake/codex', env: baseEnv(), spawnFn: fake.spawnFn, permissionMode: 'plan',
  ...opts, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
});
// A chat in Plan mode whose every turn answers `fake.reply` (the plan, unless the test says otherwise).
function make(opts = {}, script = {}) {
  const fake = createFakeCodex({ reply: PLAN, ...script });
  fakes.push(fake);
  const s = new CodexSession(sessionOpts(fake, opts));
  open.push(s);
  return { s, fake, w: watch(s) };
}

const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });
const kinds = (w, from = 0) => w.events.slice(from).map((e) => e.kind);
const textOf = (msg) => msg.params.input.find((i) => i.type === 'text')?.text;
const plans = (w, from = 0) => w.all((e) => e.kind === 'permission' && e.type === 'plan', from);
const asks = (w, from = 0) => w.all((e) => e.kind === 'permission' && e.type === 'question', from);
const resolved = (w, id) => w.all((e) => e.kind === 'permission-resolved' && e.id === id);
// One finished Plan-mode turn, and the card it left.
async function planned(ctx, text = 'Plan the flag.') {
  const mark = ctx.w.mark();
  ctx.s.send(text);
  await idle(ctx.w, mark);
  const card = plans(ctx.w, mark).at(-1);
  assert.ok(card, 'the turn left a plan card');
  return card;
}
// A turn the test plays by hand: `child` is there once Codex has the turn.
function held(script = {}) {
  const ctx = make({}, { holdTurns: true, ...script });
  ctx.turn = async (text = 'Plan the flag.') => {
    const before = ctx.fake.sent('turn/start').length;
    ctx.s.send(text);
    await until(() => ctx.fake.sent('turn/start').length > before && ctx.fake.last?.turn, 3000, 'turn/start');
    await ctx.w.waitFor((e) => e.kind === 'busy' && e.state === 'running', { ms: 3000, label: 'running' });
    return ctx.fake.last;
  };
  return ctx;
}
// What a question asked in passing looks like on the wire (fixtures/codex-plan.jsonl): a whole reply with `questions`.
function askInPassing(child, questions = [{ title: 'Which word should the new second line say?', options: ['world', 'there'] }]) {
  const text = questions.map((q) => `${q.title}\n${q.options.map((o) => `- ${o}`).join('\n')}`).join('\n\n');
  const item = { type: 'agentMessage', id: `call_${child.pid}_${++child.turnSeq}`, text, phase: 'final_answer', memoryCitation: null, delivery: 'async', questions };
  child.note('item/started', { item, threadId: child.threadId, turnId: child.turn.id, startedAtMs: Date.now() });
  child.note('item/completed', { item, threadId: child.threadId, turnId: child.turn.id, completedAtMs: Date.now() });
}

// ---- when there is a plan ----

test('a Plan-mode turn that ends with a plan: turn-end says so, then one plan card, then the chat is free', async () => {
  const { s, w } = make();
  s.send('Plan the flag.');
  await idle(w);

  const order = kinds(w).filter((k) => ['turn-end', 'permission', 'busy'].includes(k));
  assert.deepEqual(order.slice(-3), ['turn-end', 'permission', 'busy'], 'the card is raised after the turn-end and before the chat says it is free');
  assert.equal(w.find('turn-end').plan, true);
  assert.equal(plans(w).length, 1);
  const card = plans(w)[0];
  assert.deepEqual(
    { ...card, seq: undefined },
    { kind: 'permission', id: card.id, type: 'plan', toolName: 'ExitPlanMode', input: { plan: PLAN }, toolUseId: null, engine: 'codex', passive: true, turnId: w.find('turn-end').turnId, sessionId: s.sessionId, seq: undefined },
  );
  assert.equal(typeof card.id, 'number');
  assert.equal(w.find('assistant-text').text, PLAN, 'the reply is still said as the reply');

  // It waits like any prompt: the chat counts as waiting on you and is not let go as idle.
  assert.equal(s.busy, false);
  assert.equal(s.working, true);
  assert.deepEqual(s.snapshot().pending, [card], 'a reloaded window gets the card back');
  assert.equal(resolved(w, card.id).length, 0);
});

test('the recorded Plan turn, replayed: its question becomes the question card, its last reply the plan card', async () => {
  const ids = recordedIds('codex-plan');
  const { s, w } = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-plan') });
  s.send('Plan a change to notes.txt.');
  await idle(w);

  const [question] = asks(w);
  assert.deepEqual(question.input, { questions: [{ question: 'Which word should the new second line say?', header: '', multiSelect: false, options: [{ label: 'world' }, { label: 'there' }] }] });
  assert.equal(question.toolName, 'AskUserQuestion');
  assert.equal(question.passive, true);
  assert.equal(question.turnId, ids.turnId);
  assert.ok(!w.of('assistant-text').some((e) => e.text.includes('Which word should')), 'the card says the question: it is not also text');
  assert.ok(w.indexOf(question) < w.indexOf(w.find('turn-end')), 'asked while the turn ran');

  const [plan] = plans(w);
  assert.match(plan.input.plan, /^1\. Add your chosen word/);
  assert.equal(w.find('turn-end').plan, true);
  // The turn ending does not take the question away: both wait.
  assert.deepEqual(s.snapshot().pending.map((p) => p.type), ['question', 'plan']);
  assert.equal(w.all('permission-resolved').length, 0);
  assert.equal(w.all((e) => e.kind === 'raw').length, 0);
});

test('no card in any other mode, nor for a Plan-mode reply that is talk', async () => {
  for (const mode of ['default', 'acceptEdits', 'auto']) {
    const { s, w } = make({ permissionMode: mode });
    s.send('What would you do?');
    await idle(w);
    assert.equal(w.find('turn-end').plan, undefined, mode);
    assert.equal(w.of('permission').length, 0, mode);
    assert.equal(s.working, false, mode);
  }
  const talk = make({}, { reply: TALK });
  talk.s.send('Where is the parser?');
  await idle(talk.w);
  assert.equal(talk.w.find('turn-end').plan, undefined, 'a turn-end that offers nothing does not carry the field at all');
  assert.equal(talk.w.of('permission').length, 0);
  assert.equal(talk.s.mode, 'plan', 'the chat simply stays in Plan');
});

test('a plan item is the plan, whatever the final answer says', async () => {
  const { s, w } = make({}, {
    script: (child, turn) => {
      child.startTurn();
      child.userItem(turn.params.input);
      const item = { type: 'plan', id: `plan_${child.pid}`, text: PLAN };
      child.note('item/started', { item: { ...item, text: '' }, threadId: child.threadId, turnId: turn.id, startedAtMs: Date.now() });
      child.note('item/completed', { item, threadId: child.threadId, turnId: turn.id, completedAtMs: Date.now() });
      child.streamText('That is the plan.');
      child.completeTurn();
    },
  });
  s.send('Plan the flag.');
  await idle(w);
  assert.equal(plans(w)[0].input.plan, PLAN);
});

test('a stopped or failed Plan-mode turn offers nothing, and its question goes with it', async () => {
  const stopped = held();
  const child = await stopped.turn();
  askInPassing(child);
  const [question] = await Promise.all([stopped.w.waitFor((e) => e.kind === 'permission', { ms: 2000 })]);
  child.streamText(PLAN, { open: true });
  await stopped.w.waitFor('text-delta', { ms: 2000 });
  await stopped.s.interrupt();
  await idle(stopped.w);
  assert.equal(stopped.w.find('turn-end').interrupted, true);
  assert.equal(stopped.w.find('turn-end').plan, undefined);
  assert.equal(plans(stopped.w).length, 0);
  assert.equal(resolved(stopped.w, question.id).length, 1, 'the question of a stopped turn is withdrawn');
  assert.equal(stopped.s.working, false);

  const failed = held();
  const second = await failed.turn();
  second.streamText(PLAN);
  second.completeTurn('failed', { error: { message: 'boom' } });
  await idle(failed.w);
  assert.equal(failed.w.find('turn-end').isError, true);
  assert.equal(plans(failed.w).length, 0);
});

test('a message already waiting to start the next turn: no card is offered over it', async () => {
  // Codex will not fold the message into the running turn, so it starts the next one: the user has already said more.
  const ctx = held({ errors: { 'turn/steer': { message: 'this turn cannot be steered' } } });
  const child = await ctx.turn();
  ctx.s.send('Actually, make it two flags.');
  await until(() => ctx.fake.sent('turn/steer').length === 1, 2000, 'turn/steer');
  await sleep(20);
  ctx.fake.holdTurns = false;
  child.playText(PLAN);
  await until(() => ctx.fake.sent('turn/start').length === 2, 3000, 'the next turn');
  await idle(ctx.w);
  const ends = ctx.w.of('turn-end');
  assert.equal(ends[0].plan, undefined, 'the first turn offered nothing: its follow-up was already on the way');
  assert.equal(ends[1].plan, true);
  assert.equal(plans(ctx.w).length, 1);
});

// ---- Build it ----

test('Build it: the mode is set, "Implement the plan." goes out in the default collaboration mode, the card resolves as approved', async () => {
  const ctx = make();
  const { s, fake, w } = ctx;
  const card = await planned(ctx);
  assert.equal(fake.sent('turn/start')[0].params.collaborationMode.mode, 'plan');

  const mark = w.mark();
  assert.deepEqual(s.respond(card.id, { action: 'plan-approve', mode: 'acceptEdits' }), { ok: true });
  assert.equal(s.mode, 'acceptEdits', 'the mode is set before respond() returns');
  assert.equal(s.busy, true, 'and the chat is working');
  await idle(w, mark);

  const built = fake.sent('turn/start')[1];
  assert.equal(textOf(built), BUILD_WORDS);
  assert.equal(textOf(built), 'Implement the plan.');
  assert.equal(built.params.collaborationMode.mode, 'default', 'the turn leaves Plan');
  assert.equal(built.params.sandboxPolicy.type, 'workspaceWrite', 'and runs with the mode\'s own sandbox');
  assert.equal(fake.sent('turn/start').length, 2, 'the plan is not sent again: one message');

  assert.deepEqual(w.all((e) => e.kind === 'setting' && e.key === 'permissionMode', mark).map((e) => e.value), ['acceptEdits']);
  assert.deepEqual(resolved(w, card.id).map((e) => e.outcome), ['approved']);
  assert.equal(w.of('user-text').length, 0, 'the words are not shown as something the user typed');
  // The chat says it is working before the card goes, so the host never reads the moment between as idle.
  const after = w.events.slice(mark);
  assert.ok(after.findIndex((e) => e.kind === 'busy' && e.busy) < after.findIndex((e) => e.kind === 'permission-resolved'));
  // The build turn is an ordinary one: it ends without a card.
  assert.equal(w.of('turn-end').at(-1).plan, undefined);
  assert.equal(plans(w).length, 1);
  assert.equal(s.working, false);
});

test('Build it with no mode, with Plan, or with a mode that is not allowed builds in Ask', async () => {
  for (const mode of [undefined, 'plan', 'bypassPermissions', 'nonsense']) {
    const ctx = make();
    const card = await planned(ctx);
    const mark = ctx.w.mark();
    ctx.s.respond(card.id, { action: 'plan-approve', mode });
    await idle(ctx.w, mark);
    assert.equal(ctx.s.mode, 'default', String(mode));
    const built = ctx.fake.sent('turn/start')[1];
    assert.deepEqual(built.params.sandboxPolicy, READ_ONLY, String(mode));
    assert.equal(built.params.collaborationMode.mode, 'default', String(mode));
    assert.equal(ctx.w.all((e) => e.kind === 'setting-failed', mark).length, 0, 'nothing is reported as refused');
  }
  // Full Access where it is allowed is taken as asked.
  const full = make({ allowBypass: true });
  const card = await planned(full);
  const mark = full.w.mark();
  full.s.respond(card.id, { action: 'plan-approve', mode: 'bypassPermissions' });
  await idle(full.w, mark);
  assert.equal(full.s.mode, 'bypassPermissions');
  assert.equal(full.fake.sent('turn/start')[1].params.sandboxPolicy.type, 'dangerFullAccess');
});

test('Build it withdraws a question that was still open', async () => {
  const ids = recordedIds('codex-plan');
  const ctx = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-plan') });
  ctx.s.send('Plan a change to notes.txt.');
  await idle(ctx.w);
  const [question] = asks(ctx.w);
  const [plan] = plans(ctx.w);
  ctx.fake.script = null;
  const mark = ctx.w.mark();
  ctx.s.respond(plan.id, { action: 'plan-approve', mode: 'default' });
  await idle(ctx.w, mark);
  assert.deepEqual(resolved(ctx.w, question.id).map((e) => e.outcome), [undefined]);
  assert.deepEqual(resolved(ctx.w, plan.id).map((e) => e.outcome), ['approved']);
  assert.equal(ctx.s.snapshot().pending.length, 0);
});

// ---- Keep planning, and the other ways a plan goes away ----

test('a message sent while a plan waits withdraws it as kept and goes out in Plan mode', async () => {
  const ctx = make();
  const { s, fake, w } = ctx;
  const card = await planned(ctx);
  const mark = w.mark();
  s.send('Do the runner first.');
  assert.deepEqual(resolved(w, card.id).map((e) => e.outcome), ['kept'], 'withdrawn as the message is taken, not when the turn starts');
  await idle(w, mark);

  const next = fake.sent('turn/start')[1];
  assert.equal(textOf(next), 'Do the runner first.');
  assert.ok(!('collaborationMode' in next.params), 'still Plan: it is not said again');
  assert.deepEqual(next.params.sandboxPolicy, READ_ONLY);
  assert.equal(s.mode, 'plan');
  // The chat was working before the card went.
  const after = w.events.slice(mark);
  assert.ok(after.findIndex((e) => e.kind === 'busy' && e.busy) < after.findIndex((e) => e.kind === 'permission-resolved'));
});

test('a second plan takes the place of the first: one card waits', async () => {
  const ctx = make();
  const first = await planned(ctx);
  const second = await planned(ctx, 'Smaller steps.');
  assert.notEqual(second.id, first.id);
  assert.equal(resolved(ctx.w, first.id).length, 1);
  assert.equal(resolved(ctx.w, second.id).length, 0);
  assert.deepEqual(ctx.s.snapshot().pending.map((p) => p.id), [second.id]);
  // Offered again without a message in between (nothing in the app does this): still one card.
  ctx.s.planFound = 'A newer plan.';
  ctx.s.offerPlan('turn-x');
  assert.equal(resolved(ctx.w, second.id).length, 1);
  assert.deepEqual(ctx.s.snapshot().pending.map((p) => p.input.plan), ['A newer plan.']);
});

test('Keep planning as an answer: the card goes as kept; feedback that came with it is the next message', async () => {
  const bare = make();
  const card = await planned(bare);
  assert.deepEqual(bare.s.respond(card.id, { action: 'plan-reject' }), { ok: true });
  assert.deepEqual(resolved(bare.w, card.id).map((e) => e.outcome), ['kept']);
  assert.equal(bare.s.busy, false, 'nothing was sent');
  assert.equal(bare.s.working, false);
  assert.equal(bare.fake.sent('turn/start').length, 1);

  const worded = make();
  const second = await planned(worded);
  const mark = worded.w.mark();
  worded.s.respond(second.id, { action: 'plan-reject', message: ' Tests first. ' });
  await idle(worded.w, mark);
  assert.equal(textOf(worded.fake.sent('turn/start')[1]), 'Tests first.');
  assert.deepEqual(worded.w.of('user-text').map((e) => e.text), ['Tests first.'], 'said as the user\'s message, since the window did not send it');
  assert.equal(worded.s.mode, 'plan');
});

test('leaving Plan by hand withdraws a waiting plan, and only the plan', async () => {
  const ids = recordedIds('codex-plan');
  const ctx = make({}, { threadId: ids.threadId, turnIds: [ids.turnId], script: (child) => child.replay('codex-plan') });
  ctx.s.send('Plan a change to notes.txt.');
  await idle(ctx.w);
  const [question] = asks(ctx.w);
  const [plan] = plans(ctx.w);
  await ctx.s.set('permissionMode', 'plan');
  assert.equal(resolved(ctx.w, plan.id).length, 0, 'Plan to Plan changes nothing');
  await ctx.s.set('permissionMode', 'default');
  assert.deepEqual(resolved(ctx.w, plan.id).map((e) => e.outcome), [undefined], 'withdrawn, not answered');
  assert.equal(resolved(ctx.w, question.id).length, 0, 'the question still stands');
  assert.deepEqual(ctx.s.snapshot().pending.map((p) => p.type), ['question']);
});

test('what does not withdraw a plan: Stop with nothing running, a prompt resolved elsewhere, the process going away', async () => {
  const ctx = make();
  const card = await planned(ctx);
  assert.deepEqual(await ctx.s.interrupt(), { ok: true, idle: true, cancelled: [], stillQueued: [] });
  ctx.s.resolvePending({ answer: true });
  ctx.fake.last.note('serverRequest/resolved', { threadId: ctx.fake.last.threadId, requestId: 0 });
  await sleep(20);
  assert.equal(resolved(ctx.w, card.id).length, 0);
  await ctx.s.stop({ graceMs: 50 });
  assert.equal(resolved(ctx.w, card.id).length, 0, 'the card outlives the process: Build it starts a new one');
  assert.deepEqual(ctx.s.snapshot().pending, [card]);

  // Build it after that: a new process, the same thread, the plan built.
  const mark = ctx.w.mark();
  ctx.s.respond(card.id, { action: 'plan-approve', mode: 'default' });
  await idle(ctx.w, mark);
  assert.equal(ctx.fake.spawns.length, 2);
  assert.equal(textOf(ctx.fake.sent('turn/start').at(-1)), BUILD_WORDS);
});

test('dispose() and close() leave nothing waiting', async () => {
  const ctx = make();
  await planned(ctx);
  assert.equal(ctx.s.working, true);
  await ctx.s.dispose({ graceMs: 50 });
  assert.equal(ctx.s.pending.size, 0);
  assert.equal(ctx.s.working, false);

  const other = make();
  const card = await planned(other);
  other.s.close();
  assert.equal(other.s.pending.size, 0);
  assert.equal(other.s.respond(card.id, { action: 'plan-approve', mode: 'default' }).code, 'stale');
});

// ---- the question asked in passing ----

test('a reply with questions raises the question card and no text; the answer during the turn is folded into it', async () => {
  const ctx = held();
  const child = await ctx.turn();
  askInPassing(child);
  const question = await ctx.w.waitFor((e) => e.kind === 'permission', { ms: 2000 });
  assert.equal(question.type, 'question');
  assert.equal(question.passive, true);
  assert.equal(ctx.w.of('assistant-text').length, 0);
  assert.equal(ctx.s.state, 'running', 'the turn is not held up: Codex did not wait');

  const mark = ctx.w.mark();
  assert.deepEqual(ctx.s.respond(question.id, { action: 'answers', answers: { 'Which word should the new second line say?': 'world' } }), { ok: true });
  await until(() => ctx.fake.sent('turn/steer').length === 1, 2000, 'turn/steer');
  const steer = ctx.fake.sent('turn/steer')[0];
  assert.deepEqual(steer.params.input, [{ type: 'text', text: 'world', text_elements: [] }]);
  assert.equal(steer.params.expectedTurnId, child.turn.id);
  assert.equal(ctx.fake.sent('turn/start').length, 1, 'no new turn');
  const said = ctx.w.all('user-text', mark);
  assert.deepEqual(said.map((e) => [e.text, e.images]), [['world', 0]], 'the answer shows as the user\'s message');
  assert.match(said[0].uuid, /^[0-9a-f-]{36}$/);
  assert.equal(resolved(ctx.w, question.id).length, 1);

  child.playText(PLAN);
  await idle(ctx.w, mark);
  assert.equal(plans(ctx.w).length, 1, 'the turn went on to its plan');
});

test('answered after the turn, a question starts a new turn in Plan mode and keeps planning', async () => {
  const ctx = held();
  const child = await ctx.turn();
  askInPassing(child, [{ title: 'Which word?', options: ['world', 'there'] }, { title: 'Which file?', options: [] }]);
  const question = await ctx.w.waitFor((e) => e.kind === 'permission', { ms: 2000 });
  ctx.fake.holdTurns = false;
  child.playText(PLAN);
  await idle(ctx.w);
  const [plan] = plans(ctx.w);
  assert.equal(resolved(ctx.w, question.id).length, 0, 'the turn ending leaves the question');

  const mark = ctx.w.mark();
  ctx.s.respond(question.id, { action: 'answers', answers: { 'Which word?': 'there', 'Which file?': 'notes.txt' } });
  await idle(ctx.w, mark);
  const next = ctx.fake.sent('turn/start')[1];
  assert.equal(textOf(next), 'Which word?: there\nWhich file?: notes.txt', 'several questions: a line each');
  assert.deepEqual(next.params.sandboxPolicy, READ_ONLY);
  assert.equal(ctx.s.mode, 'plan');
  assert.deepEqual(resolved(ctx.w, plan.id).map((e) => e.outcome), ['kept'], 'answering is a message: the plan it follows is kept');
  assert.equal(ctx.w.all('user-text', mark).length, 1);
});

test('Skip withdraws the question and sends nothing', async () => {
  const ctx = held();
  const child = await ctx.turn();
  askInPassing(child);
  const question = await ctx.w.waitFor((e) => e.kind === 'permission', { ms: 2000 });
  assert.deepEqual(ctx.s.respond(question.id, { action: 'deny', message: 'The user skipped the question.' }), { ok: true });
  assert.equal(resolved(ctx.w, question.id).length, 1);
  await sleep(30);
  assert.equal(ctx.fake.sent('turn/steer').length, 0);
  assert.equal(ctx.w.of('user-text').length, 0);
  // Answers that say nothing are a skip too.
  askInPassing(child);
  const again = await ctx.w.waitFor((e) => e.kind === 'permission' && e.id !== question.id, { ms: 2000 });
  ctx.s.respond(again.id, { action: 'answers', answers: {} });
  await sleep(30);
  assert.equal(ctx.fake.sent('turn/steer').length, 0);
  assert.equal(resolved(ctx.w, again.id).length, 1);
  child.playText(TALK);
  await idle(ctx.w);
});

test('respond: an unknown id is still stale, and a card answers once', async () => {
  const ctx = make();
  const card = await planned(ctx);
  assert.equal(ctx.s.respond(987654321, { action: 'plan-approve', mode: 'default' }).code, 'stale');
  assert.equal(ctx.w.all((e) => e.kind === 'permission-resolved' && e.stale).length, 1);
  assert.equal(ctx.s.respond(card.id, { action: 'plan-reject' }).ok, true);
  assert.equal(ctx.s.respond(card.id, { action: 'plan-approve', mode: 'default' }).code, 'stale');
  assert.equal(ctx.fake.sent('turn/start').length, 1, 'a card that was kept cannot be built afterwards');
});

test('a real approval is untouched: answered through Codex, resolved when the turn ends, never passive', async () => {
  const ctx = held();
  const child = await ctx.turn();
  const asked = child.ask('item/commandExecution/requestApproval', {
    kind: 'command', threadId: child.threadId, turnId: child.turn.id, itemId: 'exec-1', reason: 'May I?', command: "/bin/zsh -lc 'ls'", cwd: work,
    commandActions: [{ type: 'unknown', command: 'ls' }], availableDecisions: ['accept', 'decline', 'cancel'],
  });
  const card = await ctx.w.waitFor((e) => e.kind === 'permission', { ms: 2000 });
  assert.equal(card.passive, undefined);
  assert.equal(ctx.s.state, 'requires_action');
  ctx.s.respond(card.id, { action: 'allow' });
  assert.equal((await asked.answer).result.decision, 'accept');
  // A second one, left open: the turn ending takes it away, as before.
  child.ask('item/commandExecution/requestApproval', {
    kind: 'command', threadId: child.threadId, turnId: child.turn.id, itemId: 'exec-2', reason: 'And this?', command: "/bin/zsh -lc 'pwd'", cwd: work,
    commandActions: [{ type: 'unknown', command: 'pwd' }], availableDecisions: ['accept', 'decline', 'cancel'],
  });
  const second = await ctx.w.waitFor((e) => e.kind === 'permission' && e.id !== card.id, { ms: 2000 });
  child.playText(PLAN);
  await idle(ctx.w);
  assert.equal(resolved(ctx.w, second.id).length, 1);
  assert.deepEqual(ctx.s.snapshot().pending.map((p) => p.type), ['plan'], 'only the plan is left waiting');
});

// ---- the host ----

async function hosted({ onScreen = false } = {}) {
  const fake = createFakeCodex({ reply: PLAN });
  fakes.push(fake);
  const sent = [];
  const notes = [];
  const h = new ChatHost({
    create: (o) => new CodexSession(sessionOpts(fake, { cwd: o.cwd, resume: o.resume })),
    send: (channel, payload) => sent.push([channel, payload]), notify: (n) => notes.push(n), isFocused: () => onScreen, isOnScreen: () => onScreen,
  });
  hosts.push(h);
  const { session, sid } = await h.open(work, null);
  const w = watch(session);
  const row = () => h.statusList().find((r) => r.sid === sid);
  const home = () => h.home().find((r) => r.sid === sid);
  return { h, fake, session, sid, w, sent, notes, row, home, done: () => sent.filter(([c]) => c === 'chats:done') };
}

test('the host: a chat with a plan waiting needs you, reads "Plan ready", is notified once and plays no completion sound', async () => {
  const c = await hosted();
  c.session.send('Plan the flag.');
  await idle(c.w);
  assert.equal(c.row().state, 'needs-you');
  assert.equal(c.row().line, 'Plan ready');
  assert.equal(c.row().unread, false, 'it needs you; it is not a finished reply you have not read');
  assert.equal(c.home().ask.kind, 'plan');
  assert.deepEqual(c.notes.map((n) => [n.title.replace(/^.* (needs you|is done)$/, '$1'), n.body]), [['needs you', 'Canopy has a plan for you to look over.']]);
  assert.equal(c.done().length, 0, 'no completion sound: the plan is the news');
  assert.equal(c.h.workingCount(), 1, 'quitting now would lose a waiting plan');
  // The window was sent the turn-end and the card, in that order.
  const order = c.sent.filter(([ch, ev]) => ch === 'session:event' && ['turn-end', 'permission'].includes(ev.kind)).map(([, ev]) => ev.kind);
  assert.deepEqual(order, ['turn-end', 'permission']);
});

test('the host: Build it reads as working at once, then done; a plan that was kept leaves the chat idle', async () => {
  const c = await hosted();
  c.session.send('Plan the flag.');
  await idle(c.w);
  const [card] = plans(c.w);
  const states = [];
  const mark = c.w.mark();
  c.sent.length = 0;
  c.h.respond(c.sid, card.id, { action: 'plan-approve', mode: 'default' });
  for (const [ch, list] of c.sent) if (ch === 'chats:status') states.push(list.find((r) => r.sid === c.sid)?.state);
  assert.deepEqual([...new Set(states)], ['working'], 'never idle between the card going and the build starting');
  await idle(c.w, mark);
  assert.equal(c.row().state, 'done');
  assert.equal(c.done().length, 1, 'the build finishing is a finish like any other');
  assert.deepEqual(c.notes.map((n) => n.title.replace(/^.* (needs you|is done)$/, '$1')), ['needs you', 'is done']);

  const kept = await hosted();
  kept.session.send('Plan the flag.');
  await idle(kept.w);
  kept.h.respond(kept.sid, plans(kept.w)[0].id, { action: 'plan-reject' });
  assert.equal(kept.row().state, 'idle', 'not "working": nothing is running');
  assert.equal(kept.home().ask, null);
  assert.equal(kept.h.workingCount(), 0);
});

test('the host: a question left open when its turn ends still needs you; a second card while one waits updates the line', async () => {
  const fake = createFakeCodex({ holdTurns: true });
  fakes.push(fake);
  const sent = [];
  const notes = [];
  const h = new ChatHost({
    create: (o) => new CodexSession(sessionOpts(fake, { cwd: o.cwd, resume: o.resume })),
    send: (channel, payload) => sent.push([channel, payload]), notify: (n) => notes.push(n), isFocused: () => false, isOnScreen: () => false,
  });
  hosts.push(h);
  const { session, sid } = await h.open(work, null);
  const w = watch(session);
  const row = () => h.statusList().find((r) => r.sid === sid);
  session.send('Plan the flag.');
  await until(() => fake.last?.turn, 3000, 'turn/start');
  await w.waitFor((e) => e.kind === 'busy' && e.state === 'running', { ms: 3000 });
  askInPassing(fake.last);
  const question = await w.waitFor((e) => e.kind === 'permission', { ms: 2000 });
  assert.equal(row().state, 'needs-you');
  assert.equal(row().line, 'Asked you: Which word should the new second line say?');

  // The turn ends in talk: no plan, but the question is still there.
  fake.last.playText(TALK);
  await idle(w);
  assert.equal(row().state, 'needs-you');
  assert.equal(row().line, 'Asked you: Which word should the new second line say?');
  assert.equal(sent.filter(([c]) => c === 'chats:done').length, 0);
  assert.deepEqual(notes.map((n) => n.title.replace(/^.* (needs you|is done)$/, '$1')), ['needs you'], 'said once, when it was asked');

  // Skipped with nothing running: the chat is idle.
  h.respond(sid, question.id, { action: 'deny' });
  assert.equal(row().state, 'idle');

  // A question and then a plan: the line follows the newest card; skipping the question leaves the plan waiting.
  session.send('Plan it properly.');
  await until(() => fake.sent('turn/start').length === 2 && fake.last?.turn, 3000, 'the second turn');
  const mark = w.mark();
  askInPassing(fake.last);
  const second = await w.waitFor((e) => e.kind === 'permission', { ms: 2000, from: mark });
  fake.last.playText(PLAN);
  await idle(w, mark);
  assert.equal(row().line, 'Plan ready');
  h.respond(sid, second.id, { action: 'deny' });
  assert.equal(row().state, 'needs-you');
  assert.equal(row().line, 'Plan ready');
});

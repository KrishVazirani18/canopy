// The window's rules for the plan card (renderer/src/lib/plan.ts, and what the transcript's store does with them in
// renderer/src/lib/store.ts): the mode Build it goes back to, Build it and Keep planning for both makers, and how a
// chat's events become the one card, live and read back from a saved chat.
//
// The store is the real one. Node reads its TypeScript as it is; the few things it expects from a window (the bridge
// to main, animation frames, storage) are stood in for here. The OpenAI events are the real adapter's, from the
// recorded Plan-mode turn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FIXTURES, HERE } from '../helpers.mjs';
import { adaptHistory, createAdapter } from '../../codex-adapter.mjs';
import { BUILD_WORDS as ENGINE_WORDS } from '../../plan-ready.mjs';

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

// The bridge to main, as a stand-in: every call is recorded.
const calls = [];
const record = (name, reply) => (...args) => { calls.push([name, ...args]); return Promise.resolve(reply); };
const canopy = {
  send: record('send', { ok: true }), respond: record('respond', { ok: true }), set: record('set', { ok: true }),
  interrupt: () => Promise.resolve(), context: () => Promise.resolve(null),
  queue: () => Promise.resolve({ ok: true, queue: [], v: 1 }), unqueue: () => Promise.resolve({ ok: true, removed: true, queue: [], v: 2 }),
};
globalThis.window = { canopy, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);

const RENDERER = path.resolve(HERE, '../../../renderer/src');
const lib = (file) => import(pathToFileURL(path.join(RENDERER, 'lib', file)).href);
const [P, S] = await Promise.all([lib('plan.ts'), lib('store.ts')]);

beforeEach(() => { calls.length = 0; });
const tick = () => new Promise((r) => setTimeout(r, 0));
const of = (name) => calls.filter((c) => c[0] === name);

const PLAN = '1. Add the flag to the parser.\n2. Thread it through to the runner.';
const shape = (s) => s.items.map((it) => (
  it.t === 'user' ? `you:${it.text}` : it.t === 'assistant' ? `reply:${it.text.split('\n')[0]}` : it.t === 'tool' ? `step:${it.name}`
    : it.t === 'permission' ? `${it.ev.type}:${it.resolved ? it.outcome ?? 'answered' : 'waiting'}` : it.t));
const plansIn = (s) => s.items.filter(P.isPlan);
const claude = () => new S.Store();
const openai = () => { const s = new S.Store(); s.setEngine('codex'); return s; };

// The recorded Plan-mode turn, as the adapter gives it live and as a saved chat gives it back.
function recorded() {
  const lines = fs.readFileSync(path.join(FIXTURES, 'codex-plan.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const adapter = createAdapter({});
  const live = [];
  const items = [];
  let turn = null;
  for (const l of lines) {
    if (l.dir !== 'in' || typeof l.msg.method !== 'string' || l.msg.id != null) continue;
    live.push(...adapter.adapt(l.msg));
    if (l.msg.method === 'item/completed') items.push(l.msg.params.item);
    if (l.msg.method === 'turn/completed') turn = l.msg.params.turn;
  }
  return { live, saved: (extra = []) => adaptHistory([{ ...turn, items, itemsView: 'full' }, ...extra]) };
}
const savedTurn = (id, items) => ({ id, items, itemsView: 'full', status: 'completed', error: null, startedAt: 1794801900, completedAt: 1794801905, durationMs: 5000 });
const userItem = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] });
const agentItem = (id, text, extra = {}) => ({ type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null, ...extra });

// ---- the mode Build it goes back to ----

test('the mode before Plan is remembered per chat; none remembered is Ask', () => {
  const s = claude();
  s.setMeta({ sessionId: 'chat-a', mode: 'acceptEdits' });
  assert.equal(P.modeAfterPlan(s), 'default', 'nothing remembered: Ask');
  P.notePlanMode(s, 'acceptEdits', 'plan');
  assert.equal(P.modeAfterPlan(s), 'acceptEdits');
  // Changes that are not "into Plan" leave it alone.
  P.notePlanMode(s, 'plan', 'plan');
  P.notePlanMode(s, 'plan', 'default');
  P.notePlanMode(s, 'default', 'auto');
  assert.equal(P.modeAfterPlan(s), 'acceptEdits');
  // Entering Plan again from somewhere else is the newer answer.
  P.notePlanMode(s, 'auto', 'plan');
  assert.equal(P.modeAfterPlan(s), 'auto');

  // Another chat in the same window has its own, and so does another pane's store.
  s.setMeta({ sessionId: 'chat-b' });
  assert.equal(P.modeAfterPlan(s), 'default');
  s.setMeta({ sessionId: 'chat-a' });
  assert.equal(P.modeAfterPlan(s), 'auto');
  const pane = new S.Store('pane-1', '/p', true);
  pane.setMeta({ sessionId: 'chat-a' });
  assert.equal(P.modeAfterPlan(pane), 'default');
});

test('a mode with no name of its own counts as Ask, and a new chat\'s note follows it once it has its id', () => {
  const s = claude();
  P.notePlanMode(s, null, 'plan');
  assert.equal(P.modeAfterPlan(s), 'default');
  P.notePlanMode(s, 'something-new', 'plan');
  assert.equal(P.modeAfterPlan(s), 'default');
  P.notePlanMode(s, 'auto', 'plan'); // picked before the first message: the chat has no id yet
  assert.equal(P.modeAfterPlan(s), 'auto');
  s.setMeta({ sessionId: 'chat-new' });
  assert.equal(P.modeAfterPlan(s), 'auto', 'it is the same chat');
  s.setMeta({ sessionId: 'chat-other' });
  assert.equal(P.modeAfterPlan(s), 'default', 'and it went with that chat: another one starts from nothing');
});

test('Full Access that was refused in this chat is Ask', () => {
  const s = claude();
  s.setMeta({ sessionId: 'chat-a' });
  P.notePlanMode(s, 'bypassPermissions', 'plan');
  assert.equal(P.modeAfterPlan(s), 'bypassPermissions');
  // What either engine says when Full Access is not allowed (the same sentence from both).
  s.handle({ kind: 'notice', level: 'warn', text: 'Bypass permissions is not enabled for this session. Turn it on in your Claude Code settings first (the same as the terminal requires).' });
  assert.equal(P.modeAfterPlan(s), 'default');
});

test('the card names the mode with the chip\'s own short names', () => {
  const controls = fs.readFileSync(path.join(RENDERER, 'components/canopy/controls.tsx'), 'utf8');
  const line = controls.split('\n').find((l) => l.startsWith('const shortMode'));
  assert.ok(line, 'controls.tsx still has its shortMode line');
  for (const [mode, name] of Object.entries(P.MODE_SHORT)) assert.ok(line.includes(`${mode}: '${name}'`), `${mode} is "${name}" on the chip too`);
  assert.deepEqual(Object.keys(P.MODE_SHORT), ['default', 'acceptEdits', 'auto', 'bypassPermissions'], 'every mode but Plan itself');
});

// ---- live, a Claude chat ----

function claudeWithPlan() {
  const s = claude();
  s.setMeta({ sessionId: 'chat-a', mode: 'acceptEdits' });
  P.notePlanMode(s, 'acceptEdits', 'plan');
  s.setMeta({ mode: 'plan' });
  s.addUser('Plan the flag.', 0);
  s.handle({ kind: 'busy', busy: true });
  s.handle({ kind: 'text-delta', text: 'Here is the plan.' });
  s.handle({ kind: 'tool-start', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: PLAN } });
  s.handle({ kind: 'permission', id: 41, type: 'plan', toolName: 'ExitPlanMode', toolUseId: 'toolu_plan', input: { plan: PLAN } });
  return s;
}

test('a Claude plan, live: no step row, one waiting card, and the reply before it is closed', () => {
  const s = claudeWithPlan();
  assert.deepEqual(shape(s), ['you:Plan the flag.', 'reply:Here is the plan.', 'plan:waiting']);
  assert.equal(s.items[1].streaming, false, 'the step starting closes the reply being written');
  const card = P.waitingPlan(s.items);
  assert.equal(P.planTextOf(card), PLAN);
  // What "only a plan is waiting" means to the rest of the window: an unanswered permission item of type plan.
  const open = s.items.filter((it) => it.t === 'permission' && !it.resolved);
  assert.deepEqual(open.map((it) => it.ev.type), ['plan']);
});

test('Build it in a Claude chat: one answer that carries the mode you were in before Plan', async () => {
  const s = claudeWithPlan();
  const card = P.waitingPlan(s.items);
  assert.equal(P.buildIt(s, card), 'acceptEdits');
  assert.deepEqual(of('respond'), [['respond', 41, { action: 'plan-approve', mode: 'acceptEdits' }]]);
  assert.equal(of('send').length, 0, 'nothing is sent: Claude Code carries on in the same turn');
  assert.equal(of('set').length, 0, 'the approval carries the mode');
  assert.equal(s.meta.mode, 'acceptEdits', 'the chip follows at once');
  // Claude Code confirms, and the plan step's own result is not a row.
  s.handle({ kind: 'permission-resolved', id: 41 });
  s.handle({ kind: 'setting', key: 'permissionMode', value: 'acceptEdits', via: 'grant' });
  s.handle({ kind: 'tool-result', id: 'toolu_plan', content: 'User has approved your plan. You can now start coding.', isError: false });
  s.handle({ kind: 'tool-start', id: 'toolu_edit', name: 'Edit', input: { file_path: '/p/args.ts' } });
  assert.deepEqual(shape(s), ['you:Plan the flag.', 'reply:Here is the plan.', 'plan:approved', 'step:Edit']);
  assert.equal(P.outcomeWord(card), 'Approved');
  assert.equal(P.waitingPlan(s.items), null);
  await tick();
});

test('Build it with nothing remembered builds in Ask', () => {
  const s = claude();
  s.handle({ kind: 'permission', id: 5, type: 'plan', toolName: 'ExitPlanMode', toolUseId: 'toolu_x', input: { plan: PLAN } });
  assert.equal(P.buildIt(s, P.waitingPlan(s.items)), 'default');
  assert.deepEqual(of('respond')[0][2], { action: 'plan-approve', mode: 'default' });
});

test('a message sent while a Claude plan waits is its answer: keep planning, with those words, and your bubble', () => {
  const s = claudeWithPlan();
  const card = P.waitingPlan(s.items);
  const sends = s.meta.sends;
  assert.equal(P.keepPlanning(s, '  Do the runner first.  '), true, 'the composer has nothing more to send');
  assert.deepEqual(of('respond'), [['respond', 41, { action: 'plan-reject', message: 'Do the runner first.' }]]);
  assert.equal(of('send').length, 0);
  assert.equal(s.meta.sends, sends + 1, 'the view follows your message down');
  s.handle({ kind: 'permission-resolved', id: 41 });
  // Claude Code is told in the plan step's result; the words are already on screen, so they are not added again.
  s.handle({ kind: 'tool-result', id: 'toolu_plan', content: 'The user wants to keep planning. Feedback: Do the runner first.', isError: true });
  assert.deepEqual(shape(s), ['you:Plan the flag.', 'reply:Here is the plan.', 'plan:kept', 'you:  Do the runner first.  ']);
  assert.equal(P.outcomeWord(card), 'Kept planning');
  assert.equal(s.meta.mode, 'plan');
});

test('images cannot travel in an answer: they follow as a message folded into the same turn', () => {
  const s = claudeWithPlan();
  const image = { mediaType: 'image/png', data: 'AAAA' };
  assert.equal(P.keepPlanning(s, '', [image]), true);
  assert.deepEqual(of('respond')[0][2], { action: 'plan-reject', message: 'See the attached image.' });
  assert.equal(of('send').length, 1);
  assert.deepEqual(of('send')[0][2], [image]);
  assert.equal(s.items.filter((it) => it.t === 'user').length, 2, 'one bubble for it, drawn by the send');
});

test('with no plan waiting, a message is just a message', () => {
  const s = claude();
  s.addUser('hello', 0);
  assert.equal(P.keepPlanning(s, 'more'), false);
  const answered = claudeWithPlan();
  answered.handle({ kind: 'permission-resolved', id: 41 });
  assert.equal(P.keepPlanning(answered, 'more'), false);
  assert.equal(calls.length, 0);
});

test('a Claude plan that was allowed without asking still becomes a card, from the step\'s result', () => {
  const s = claude();
  s.addUser('Plan it.', 0);
  s.handle({ kind: 'tool-start', id: 'toolu_auto', name: 'ExitPlanMode', input: { plan: PLAN } });
  assert.deepEqual(shape(s), ['you:Plan it.']);
  s.handle({ kind: 'tool-result', id: 'toolu_auto', content: 'User has approved your plan.', isError: false });
  assert.deepEqual(shape(s), ['you:Plan it.', 'plan:approved']);
  assert.equal(P.planTextOf(plansIn(s)[0]), PLAN);
});

test('what is not a plan\'s own event is handled as it always was', () => {
  const s = claude();
  s.addUser('Run it.', 0);
  // A sub-agent's plan step keeps its row under the agent.
  s.handle({ kind: 'tool-start', id: 'agent-1', name: 'Task', input: { description: 'explore' } });
  s.handle({ kind: 'tool-start', id: 'toolu_sub', name: 'ExitPlanMode', input: { plan: PLAN }, parent: 'agent-1' });
  s.handle({ kind: 'tool-result', id: 'toolu_sub', content: 'ok', isError: false, parent: 'agent-1' });
  assert.deepEqual(s.items.find((it) => it.t === 'tool').children.map((c) => c.name), ['ExitPlanMode']);
  // An ordinary step, its result, and a result nobody has a step for.
  s.handle({ kind: 'tool-start', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } });
  s.handle({ kind: 'tool-result', id: 'toolu_bash', content: 'a\nb', isError: false });
  s.handle({ kind: 'tool-result', id: 'toolu_lost', content: 'orphan', isError: false });
  s.handle({ kind: 'assistant-text', text: `<proposed_plan>${PLAN}</proposed_plan>` });
  assert.deepEqual(shape(s), ['you:Run it.', 'step:Task', 'step:Bash', 'raw', `reply:<proposed_plan>${PLAN.split('\n')[0]}`]);
  assert.equal(plansIn(s).length, 0, 'live, a reply is a reply: the engine decides when it is a plan');
  assert.equal(s.items.find((it) => it.t === 'tool' && it.name === 'Bash').result, 'a\nb');
});

// ---- live, an OpenAI chat ----

function openaiWithPlan() {
  const s = openai();
  s.setMeta({ sessionId: 'thread-a', mode: 'auto' });
  P.notePlanMode(s, 'auto', 'plan');
  s.setMeta({ mode: 'plan' });
  s.addUser('Plan a change to notes.txt.', 0);
  s.handle({ kind: 'busy', busy: true });
  for (const ev of recorded().live) if (!(ev.kind === 'assistant-text' && ev.questions)) s.handle(ev); // the session holds the question back: its card says it
  const plan = s.items.findLast((it) => it.t === 'assistant').text;
  s.handle({ kind: 'permission', id: 1000000007, type: 'plan', toolName: 'ExitPlanMode', input: { plan }, toolUseId: null, engine: 'codex', passive: true, turnId: 't1', sessionId: 'thread-a' });
  s.handle({ kind: 'busy', busy: false });
  return s;
}

test('an OpenAI plan, live: the same waiting card, and the reply that is the plan is not drawn beside it', () => {
  const s = openaiWithPlan();
  const card = P.waitingPlan(s.items);
  assert.ok(card);
  assert.match(P.planTextOf(card), /^1\. Add your chosen word/);
  const reply = s.items.findLast((it) => it.t === 'assistant');
  assert.equal(P.hiddenBy(reply, card), true, 'the card says the plan');
  const note = s.items.find((it) => it.t === 'assistant');
  assert.equal(P.hiddenBy(note, card), false, 'what it said along the way stays');
  assert.equal(P.hiddenBy(card, card), false);
  const open = s.items.filter((it) => it.t === 'permission' && !it.resolved);
  assert.deepEqual(open.map((it) => it.ev.type), ['plan'], 'the same shape as a Claude plan waiting');
});

test('Build it in an OpenAI chat is the same one answer; the building is the plan\'s own turn carrying on', () => {
  const s = openaiWithPlan();
  const card = P.waitingPlan(s.items);
  assert.equal(P.buildIt(s, card), 'auto');
  assert.deepEqual(of('respond'), [['respond', 1000000007, { action: 'plan-approve', mode: 'auto' }]]);
  assert.equal(of('send').length, 0, 'the engine sends the words: the window never does, so there is no bubble');
  // What the engine says back.
  s.handle({ kind: 'setting', key: 'permissionMode', value: 'auto' });
  s.handle({ kind: 'busy', busy: true });
  s.handle({ kind: 'permission-resolved', id: 1000000007, outcome: 'approved' });
  s.handle({ kind: 'tool-start', id: 'exec-1', name: 'Edit', input: { file_path: '/p/notes.txt' } });
  assert.equal(card.outcome, 'approved');
  assert.equal(s.items.filter((it) => it.t === 'user').length, 1);
  const turn = s.items.slice(s.items.findIndex((it) => it.t === 'user') + 1, -1);
  assert.equal(P.buildsOn(turn, s.items.at(-1)), true, 'work after a plan, with no message between, is that plan being built');
  assert.equal(P.buildsOn([s.items[1]], s.items.at(-1)), false, 'not in a turn with no plan');
  assert.equal(P.buildsOn(turn, card), false, 'the card itself is not work');
});

test('a message sent while an OpenAI plan waits goes out as usual; the engine takes the card down as kept', () => {
  const s = openaiWithPlan();
  const card = P.waitingPlan(s.items);
  assert.equal(P.keepPlanning(s, 'Use "there".'), false, 'the composer sends it like any message');
  assert.equal(calls.length, 0, 'no answer is given for the card');
  s.dispatch('Use "there".', []);
  s.handle({ kind: 'busy', busy: true });
  s.handle({ kind: 'permission-resolved', id: 1000000007, outcome: 'kept' });
  assert.equal(card.resolved, true);
  assert.equal(P.outcomeWord(card), 'Kept planning');
  assert.equal(s.meta.mode, 'plan');
});

test('a plan withdrawn without an answer says nothing; one answered from elsewhere takes the engine\'s word', () => {
  const left = openaiWithPlan();
  left.handle({ kind: 'permission-resolved', id: 1000000007 }); // the mode left Plan by hand
  assert.equal(P.outcomeWord(P.isPlan(left.items.at(-1)) ? left.items.at(-1) : plansIn(left)[0]), '');
  const elsewhere = openaiWithPlan();
  elsewhere.handle({ kind: 'permission-resolved', id: 1000000007, outcome: 'approved' }); // built from another view of the chat
  assert.equal(P.outcomeWord(plansIn(elsewhere)[0]), 'Approved');
});

// ---- read back from a saved chat ----

test('a saved Claude chat: an approved plan and a kept one are one answered card each, the kept one with your feedback', () => {
  const s = claude();
  s.loadHistory([
    { kind: 'user-text', text: 'Plan the flag.', uuid: 'u1', images: 0 },
    { kind: 'assistant-text', text: 'Here is a first plan.' },
    { kind: 'tool-start', id: 'toolu_1', name: 'ExitPlanMode', input: { plan: 'A first plan.' } },
    { kind: 'tool-result', id: 'toolu_1', content: 'The user wants to keep planning. Feedback: smaller steps', isError: true },
    { kind: 'tool-start', id: 'toolu_2', name: 'ExitPlanMode', input: { plan: PLAN } },
    { kind: 'tool-result', id: 'toolu_2', content: 'User has approved your plan. You can now start coding.', isError: false },
    { kind: 'tool-start', id: 'toolu_3', name: 'Edit', input: { file_path: '/p/args.ts' } },
    { kind: 'tool-result', id: 'toolu_3', content: 'ok', isError: false },
    { kind: 'assistant-text', text: 'Done.' },
  ]);
  assert.deepEqual(shape(s), ['you:Plan the flag.', 'reply:Here is a first plan.', 'plan:kept', 'you:smaller steps', 'plan:approved', 'step:Edit', 'reply:Done.']);
  assert.deepEqual(plansIn(s).map(P.planTextOf), ['A first plan.', PLAN]);
  assert.ok(plansIn(s).every((p) => p.resolved && p.hist), 'answered cards, with no buttons');
  assert.equal(calls.length, 0, 'reading a chat back answers nothing');
});

test('a saved Claude chat: a plan that was never answered (the app quit, the turn was stopped) comes back answered-looking, with no word', () => {
  const s = claude();
  s.loadHistory([
    { kind: 'user-text', text: 'Plan the flag.', uuid: 'u1', images: 0 },
    { kind: 'tool-start', id: 'toolu_1', name: 'ExitPlanMode', input: { plan: PLAN } },
    { kind: 'tool-result', id: 'toolu_1', content: '', isError: true, interrupted: true, history: true },
    { kind: 'user-text', text: 'build it', uuid: 'u2', images: 0 },
  ]);
  assert.deepEqual(shape(s), ['you:Plan the flag.', 'plan:answered', 'you:build it']);
  assert.equal(P.outcomeWord(plansIn(s)[0]), '');
  // Its prompt may still be waiting in a live chat that is put back on screen: that one card is the plan.
  s.handle({ kind: 'permission', id: 9, type: 'plan', toolName: 'ExitPlanMode', toolUseId: 'toolu_1', input: { plan: PLAN } });
  const [saved, waiting] = plansIn(s);
  assert.equal(P.hiddenBy(saved, waiting), true, 'the saved copy gives way to the waiting card');
  assert.equal(P.hiddenBy(waiting, saved), false);
});

test('a saved OpenAI chat: the recorded plan, built, is one approved card and "Implement the plan." is not a bubble', () => {
  const { saved } = recorded();
  const s = openai();
  s.loadHistory(saved([savedTurn('turn-2', [userItem('u-2', ENGINE_WORDS), agentItem('msg-2', 'Added the line.')])]));
  const [card] = plansIn(s);
  assert.equal(plansIn(s).length, 1);
  assert.equal(card.resolved, true);
  assert.equal(card.outcome, 'approved');
  assert.match(P.planTextOf(card), /^1\. Add your chosen word/);
  assert.equal(s.items.filter((it) => it.t === 'user').length, 1, 'the one message that was typed: the request for a plan');
  assert.ok(!shape(s).some((x) => x.startsWith('you:Implement')), shape(s).join(' | '));
  const reply = s.items.find((it) => it.t === 'assistant' && it.text.startsWith('1. Add your chosen word'));
  assert.equal(P.hiddenBy(reply, card), true, 'the plan is drawn once: as the card');
  // The build's own reply follows the card, in the same turn: no message of yours sits between them.
  const after = s.items.slice(s.items.indexOf(card) + 1);
  assert.deepEqual(after.filter((it) => it.t !== 'turn').map((it) => it.t === 'assistant' && it.text), ['Added the line.']);
  assert.equal(P.buildsOn(s.items.slice(1, s.items.indexOf(card) + 1), after.find((it) => it.t === 'assistant')), true);
});

test('a saved OpenAI chat: a plan item and a marked plan become the same card; your next message kept planning', () => {
  const s = openai();
  s.loadHistory(adaptHistory([
    savedTurn('turn-1', [userItem('u-1', 'Plan the flag.'), { type: 'plan', id: 'plan-1', text: PLAN }]),
    savedTurn('turn-2', [userItem('u-2', 'Smaller steps.'), agentItem('msg-2', `Here you go.\n\n<proposed_plan>\n${PLAN}\n</proposed_plan>`)]),
    savedTurn('turn-3', [userItem('u-3', ENGINE_WORDS), agentItem('msg-3', 'Built.')]),
  ]));
  assert.deepEqual(shape(s).filter((x) => x !== 'turn'), ['you:Plan the flag.', 'plan:kept', 'you:Smaller steps.', 'reply:Here you go.', 'plan:approved', 'reply:Built.']);
  assert.deepEqual(plansIn(s).map(P.planTextOf), [PLAN, PLAN]);
});

test('"Implement the plan." anywhere else is your own message', () => {
  // After talk, in an OpenAI chat.
  const talk = openai();
  talk.loadHistory(adaptHistory([
    savedTurn('turn-1', [userItem('u-1', 'Where is the parser?'), agentItem('msg-1', 'It lives in src/args.ts.')]),
    savedTurn('turn-2', [userItem('u-2', ENGINE_WORDS), agentItem('msg-2', 'Which plan?')]),
  ]));
  assert.ok(shape(talk).includes(`you:${ENGINE_WORDS}`));
  assert.equal(plansIn(talk).length, 0);
  // As the first message.
  const first = openai();
  first.loadHistory(adaptHistory([savedTurn('turn-1', [userItem('u-1', ENGINE_WORDS), agentItem('msg-1', 'Which plan?')])]));
  assert.ok(shape(first).includes(`you:${ENGINE_WORDS}`));
  // After a plan that was already answered.
  const twice = openai();
  twice.loadHistory(adaptHistory([
    savedTurn('turn-1', [userItem('u-1', 'Plan the flag.'), { type: 'plan', id: 'plan-1', text: PLAN }]),
    savedTurn('turn-2', [userItem('u-2', ENGINE_WORDS)]),
    savedTurn('turn-3', [userItem('u-3', ENGINE_WORDS), agentItem('msg-3', 'Already done.')]),
  ]));
  assert.deepEqual(shape(twice).filter((x) => x.startsWith('you:')), ['you:Plan the flag.', `you:${ENGINE_WORDS}`]);
  // In a Claude chat, whatever came before it.
  const c = claude();
  c.loadHistory([
    { kind: 'user-text', text: 'What next?', uuid: 'u1', images: 0 },
    { kind: 'assistant-text', text: PLAN },
    { kind: 'user-text', text: ENGINE_WORDS, uuid: 'u2', images: 0 },
  ]);
  assert.deepEqual(shape(c), ['you:What next?', `reply:${PLAN.split('\n')[0]}`, `you:${ENGINE_WORDS}`]);
  // Typed live, in any chat: the window drew it, and it stays.
  const live = openaiWithPlan();
  live.dispatch(ENGINE_WORDS, []);
  assert.equal(live.items.at(-1).text, ENGINE_WORDS);
});

test('the window and the engine share the words Build it sends', () => {
  assert.equal(P.BUILD_WORDS, ENGINE_WORDS);
  assert.equal(P.BUILD_WORDS, 'Implement the plan.');
});

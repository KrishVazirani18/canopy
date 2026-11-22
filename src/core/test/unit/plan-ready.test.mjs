// plan-ready.mjs: when a finished turn holds a plan and what its text is, how a Claude chat's plan was answered,
// and a question asked in passing as the question card's input and back as a message. The recorded Plan-mode turn
// (fixtures/codex-plan.jsonl) goes through the real adapter; everything the recording does not hold is written by
// hand in the shape the adapter emits. Nothing starts Codex.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAdapter } from '../../codex-adapter.mjs';
import * as P from '../../plan-ready.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(HERE, '..', '..');

// One recorded session through the adapter, as a chat's session would feed it.
function recorded(name) {
  const lines = fs.readFileSync(path.join(HERE, '..', 'fixtures', `codex-${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const adapter = createAdapter({});
  const events = [];
  for (const l of lines) {
    if (l.dir !== 'in' || typeof l.msg.method !== 'string' || l.msg.id != null) continue;
    events.push(...adapter.adapt(l.msg));
  }
  return events;
}

const said = (text, extra = {}) => ({ kind: 'assistant-text', text, parent: null, aborted: false, phase: 'final_answer', ...extra });
const end = (extra = {}) => ({ kind: 'turn-end', subtype: 'success', isError: false, interrupted: false, ...extra });
const PLAN = '1. Add the flag to the parser.\n2. Thread it through to the runner.';

test('the recorded Plan turn gives its two-step plan, and not the question it asked on the way', () => {
  const events = recorded('plan');
  const plan = P.planOf(events);
  assert.match(plan, /^1\. Add your chosen word/);
  assert.match(plan, /\n2\. Leave the file unchanged until you ask me to make the edit\.$/);
  assert.ok(!plan.includes('Which word should'), 'the question is not the plan');
  // The same reply is what the turn ended with.
  assert.equal(plan, events.findLast((e) => e.kind === 'turn-end').text);
});

test('the recorded turns that were not plans give nothing', () => {
  assert.equal(P.planOf(recorded('text')), null, '"OK" is not a plan');
  assert.equal(P.planOf(recorded('interrupt')), null, 'a stopped turn offers nothing');
});

test('a plan item wins over the final answer', () => {
  const events = [said('I looked around first.', { phase: 'commentary' }), said(PLAN, { plan: true, phase: null }), said('The plan is above. Shall I go on?'), end()];
  assert.equal(P.planOf(events), PLAN);
  // Wherever it sits in the turn, and trimmed.
  assert.equal(P.planOf([said(`\n${PLAN}\n\n`, { plan: true }), said('Done planning.'), end()]), PLAN);
});

test('a marked block is taken without its marks, with or without words around it', () => {
  assert.equal(P.planOf([said(`<proposed_plan>\n${PLAN}\n</proposed_plan>`), end()]), PLAN);
  assert.equal(P.planOf([said(`Here is what I would do.\n\n<proposed_plan>\n${PLAN}\n</proposed_plan>\n\nSay the word.`), end()]), PLAN);
  assert.equal(P.taggedPlan(`<PROPOSED_PLAN>one step</PROPOSED_PLAN>`), 'one step');
  assert.equal(P.taggedPlan('<proposed_plan>   </proposed_plan>'), null, 'an empty block is no plan');
  assert.equal(P.taggedPlan('no block here'), null);
  assert.equal(P.withoutTagged(`Before.\n\n<proposed_plan>\n${PLAN}\n</proposed_plan>\n\nAfter.`), 'Before.\n\nAfter.');
  assert.equal(P.withoutTagged(`<proposed_plan>${PLAN}</proposed_plan>`), '');
});

test('an unmarked final answer is a plan when it has two list items or a heading', () => {
  assert.equal(P.planOf([said(PLAN), end()]), PLAN);
  assert.equal(P.planOf([said('- first\n- second'), end()]), '- first\n- second');
  assert.equal(P.planOf([said('## Plan\n\nRename the helper and update its callers.'), end()]), '## Plan\n\nRename the helper and update its callers.');
  assert.equal(P.planOf([said('1) one\n2) two'), end()]), '1) one\n2) two');
});

test('talk is not a plan: one paragraph, one list item, a reply that ends by asking, a comment in a code block', () => {
  assert.equal(P.planOf([said('The helper lives in src/rows.ts and has two callers.'), end()]), null);
  assert.equal(P.planOf([said('There is one thing to do:\n\n1. Rename the helper.'), end()]), null);
  assert.equal(P.planOf([said(`${PLAN}\n\nWhich of these should come first?`), end()]), null, 'it ends by asking: the chat stays in Plan');
  assert.equal(P.planOf([said('The script is:\n\n```sh\n# install\nnpm ci\n```'), end()]), null, 'a comment in a code block is not a heading');
  assert.equal(P.readsAsPlan(''), false);
  assert.equal(P.readsAsPlan(undefined), false);
});

test('a stopped, failed or unfinished turn offers nothing, whatever it said', () => {
  assert.equal(P.planOf([said(PLAN), end({ interrupted: true, subtype: 'interrupted' })]), null);
  assert.equal(P.planOf([said(PLAN), end({ isError: true, subtype: 'error' })]), null);
  assert.equal(P.planOf([said(PLAN, { plan: true }), end({ isError: true, subtype: 'error' })]), null, 'not even a plan item');
  assert.equal(P.planOf([said(PLAN)]), null, 'no turn-end: the turn has not ended');
});

test('what does not count as the final answer: a note along the way, a cut-off reply, a sub-agent, a question', () => {
  assert.equal(P.planOf([said(PLAN, { phase: 'commentary' }), said('All set.'), end()]), null, 'the plan-shaped note was not the answer');
  assert.equal(P.planOf([said(PLAN, { aborted: true }), end()]), null);
  assert.equal(P.planOf([said(PLAN, { parent: 'call-1' }), end()]), null);
  assert.equal(P.planOf([said('- world\n- there', { questions: [{ question: 'Which?', options: ['world', 'there'] }] }), end()]), null, 'a question lists choices, not steps');
  // A maker that never says which reply is final: the last thing it said is.
  assert.equal(P.planOf([said('Looking.', { phase: null }), said(PLAN, { phase: null }), end()]), PLAN);
});

test('planOf never throws on input that is simply wrong', () => {
  for (const bad of [null, undefined, 'x', 7, {}, [null, 3, 'x'], [{ kind: 'turn-end' }, { kind: 'assistant-text' }]]) assert.equal(P.planOf(bad), null);
});

test('the frozen words: what Build it sends, and the sentence Claude Code is told to keep planning with', () => {
  assert.equal(P.BUILD_WORDS, 'Implement the plan.');
  assert.equal(P.KEPT_PREFIX, 'The user wants to keep planning.');
  // session.mjs writes that sentence itself (it is not this workstream's file): the two must stay the same words.
  const session = fs.readFileSync(path.join(CORE, 'session.mjs'), 'utf8');
  assert.ok(session.includes(`\`${P.KEPT_PREFIX} Feedback: \${String(a.message)}\``), 'session.mjs says "keep planning" with feedback in these words');
  assert.ok(session.includes(`'${P.KEPT_PREFIX}'`), 'and without feedback');
});

test('planOutcome reads both of Claude\'s results, and neither from a plan that was stopped', () => {
  assert.deepEqual(P.planOutcome('User has approved your plan. You can now start coding. Start with updating your todo list if applicable', false), { outcome: 'approved', feedback: '' });
  assert.deepEqual(P.planOutcome('User has approved your plan.'), { outcome: 'approved', feedback: '' }, 'by its words, when nothing says whether it failed');
  assert.deepEqual(P.planOutcome('The user wants to keep planning. Feedback: do the tests first', true), { outcome: 'kept', feedback: 'do the tests first' });
  assert.deepEqual(P.planOutcome('The user wants to keep planning.', true), { outcome: 'kept', feedback: '' });
  assert.deepEqual(P.planOutcome('Error: The user wants to keep planning. Feedback: smaller steps\n', true), { outcome: 'kept', feedback: 'smaller steps' }, 'wherever the sentence sits in the result');
  assert.deepEqual(P.planOutcome('Cancelled.', true), { outcome: null, feedback: '' });
  assert.deepEqual(P.planOutcome("The user doesn't want to proceed with this tool use.", true), { outcome: null, feedback: '' });
  assert.deepEqual(P.planOutcome(undefined, true), { outcome: null, feedback: '' });
  assert.deepEqual(P.planOutcome([{ type: 'text', text: 'The user wants to keep planning. Feedback: x' }], true).outcome, 'kept', 'a result that is not plain text is read as its text');
});

test('a question asked in passing becomes the question card\'s input', () => {
  const ev = recorded('plan').find((e) => e.kind === 'assistant-text' && e.questions);
  assert.deepEqual(P.questionsFor(ev), { questions: [{ question: 'Which word should the new second line say?', header: '', multiSelect: false, options: [{ label: 'world' }, { label: 'there' }] }] });
  // Answers come back keyed by the question's words: no two questions, and no two choices, share them.
  const twice = P.questionsFor({ questions: [{ question: 'A?', options: ['x', 'x', '', 'y'] }, { question: 'A?', options: ['z'] }, { question: '  ', options: [] }, { question: 'B?' }] });
  assert.deepEqual(twice, { questions: [{ question: 'A?', header: '', multiSelect: false, options: [{ label: 'x' }, { label: 'y' }] }, { question: 'B?', header: '', multiSelect: false, options: [] }] });
  for (const none of [null, {}, { questions: [] }, { questions: [{ question: '' }] }, { questions: 'x' }]) assert.equal(P.questionsFor(none), null);
});

test('the card\'s answer as the message sent back: one question gives its answer, several give a line each', () => {
  const one = [{ question: 'Which word?' }];
  assert.equal(P.answerWords(one, { 'Which word?': 'world' }), 'world');
  assert.equal(P.answerWords(one, { 'Which word?': '  there ' }), 'there');
  const two = [{ question: 'Which word?' }, { question: 'Which file?' }];
  assert.equal(P.answerWords(two, { 'Which word?': 'world', 'Which file?': 'notes.txt' }), 'Which word?: world\nWhich file?: notes.txt');
  assert.equal(P.answerWords(two, { 'Which file?': 'notes.txt' }), 'Which file?: notes.txt', 'one of several still says which it answers');
  assert.equal(P.answerWords(one, {}), '');
  assert.equal(P.answerWords(one, null), '');
  assert.equal(P.answerWords(null, { a: 'b' }), '');
});

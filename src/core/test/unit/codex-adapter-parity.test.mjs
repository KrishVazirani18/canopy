// What the Codex adapter does so an OpenAI chat reads like a Claude chat: a review's result as the
// turn's reply, questions that take no free text or hide what is typed, a Deny that says when it stops the turn,
// limit notices in Claude's words, the to-do list's explanation, the model on a turn's end, and an agent's lines
// under its Agent row. None of these is in a recording (CODEX-FIXTURES.md), so the lines are made by hand from the
// 0.153.4 protocol types; the recordings are replayed at the end to show nothing they hold became unknown.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as A from '../../codex-adapter.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const T = '0f000000-0000-7000-8000-000000000001';
const CHILD = '0f000000-0000-7000-8000-0000000000c1';
const TURN = 'turn-1';

function chat(opts = {}) {
  const unknown = [];
  const a = A.createAdapter({ model: () => 'gpt-6.1-sol', unknown: (label) => unknown.push(label), ...opts });
  return { a, unknown, feed: (...msgs) => msgs.flatMap((m) => a.adapt(m, { threadId: T })), child: (row, ...msgs) => msgs.flatMap((m) => a.adapt(m, { threadId: CHILD, parent: row })) };
}
const note = (method, params) => ({ method, params: { threadId: T, ...params }, emittedAtMs: 1794801559000 });
const started = (item, extra = {}) => note('item/started', { item, turnId: TURN, startedAtMs: 1794801559000, ...extra });
const completed = (item, extra = {}) => note('item/completed', { item, turnId: TURN, completedAtMs: 1794801560000, ...extra });
const turnStarted = (id = TURN, extra = {}) => note('turn/started', { turn: { id, items: [], status: 'inProgress', error: null, startedAt: 1794801559 }, ...extra });
const turnDone = (id = TURN, status = 'completed', extra = {}) => note('turn/completed', { turn: { id, items: [], status, error: null, startedAt: 1794801559, completedAt: 1794801562, durationMs: 3000 }, ...extra });
const kinds = (events) => events.map((e) => e.kind);
const ask = (method, params, id = 0) => ({ id, method, params: { threadId: T, turnId: TURN, ...params } });

// ---- /review ----

test('a review: the status line says so while it runs, and what it found is the turn\'s reply', () => {
  const c = chat();
  c.feed(turnStarted());
  const entered = { type: 'enteredReviewMode', id: 'rv-1', review: 'current changes' };
  assert.deepEqual(c.feed(started(entered)), [{ kind: 'status', status: 'reviewing' }]);
  const exited = { type: 'exitedReviewMode', id: 'rv-2', review: 'One problem: `save()` drops the error.' };
  assert.deepEqual(c.feed(started(exited)), []);
  const out = c.feed(completed(exited));
  assert.deepEqual(kinds(out), ['status', 'assistant-text']);
  assert.equal(out[0].status, null, 'the status line is cleared');
  assert.deepEqual([out[1].text, out[1].phase, out[1].model, out[1].parent], ['One problem: `save()` drops the error.', 'final_answer', 'gpt-6.1-sol', null]);
  const end = c.feed(turnDone()).at(-1);
  assert.deepEqual([end.kind, end.text], ['turn-end', 'One problem: `save()` drops the error.'], 'the review is what the turn said');
  assert.deepEqual(c.unknown, []);
});

test('a review Codex also sends as an ordinary reply is said once', () => {
  const c = chat();
  c.feed(turnStarted());
  const text = 'No problems found.';
  const said = c.feed(completed({ type: 'agentMessage', id: 'msg-1', text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }));
  assert.deepEqual(kinds(said), ['assistant-text']);
  assert.deepEqual(kinds(c.feed(completed({ type: 'exitedReviewMode', id: 'rv-2', review: text }))), ['status'], 'the same words are not a second reply');
  assert.deepEqual(kinds(chat().feed(completed({ type: 'exitedReviewMode', id: 'rv-3', review: '  ' }))), ['status'], 'a review with nothing to say is no reply');
});

test('a reopened chat shows a review as the reply it was', () => {
  const turn = { id: TURN, status: 'completed', error: null, startedAt: 1794801559, completedAt: 1794801562, durationMs: 3000, items: [
    { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: '/review', text_elements: [] }] },
    { type: 'enteredReviewMode', id: 'rv-1', review: 'current changes' },
    { type: 'exitedReviewMode', id: 'rv-2', review: 'Looks right.' },
  ] };
  const events = A.adaptHistory([turn], { threadId: T });
  assert.deepEqual(kinds(events), ['user-text', 'assistant-text', 'turn-end']);
  assert.deepEqual([events[1].text, events[2].text], ['Looks right.', 'Looks right.']);
});

// ---- questions ----

test('a question that takes no answer of your own, and one whose answer is a secret', () => {
  const c = chat();
  const req = c.a.request(ask('item/tool/requestUserInput', { itemId: 'q-1', isBlocking: true, autoResolutionMs: null, questions: [
    { id: 'env', header: 'Where', question: 'Which environment?', isOther: false, isSecret: false, options: [{ label: 'Staging', description: 'safe' }, { label: 'Production', description: '' }] },
    { id: 'token', header: 'Token', question: 'Paste the deploy token', isOther: true, isSecret: true, options: null },
    { id: 'note', header: 'Note', question: 'Anything else?', isOther: true, isSecret: false, options: [] },
  ] }), { threadId: T });
  assert.equal(req.base.type, 'question');
  const [env, token, plain] = req.base.input.questions;
  assert.deepEqual([env.otherOff, env.secret], [true, undefined], 'isOther false: the card has no line to write your own');
  assert.deepEqual([token.otherOff, token.secret], [undefined, true], 'isSecret: the card hides what is typed');
  assert.deepEqual([plain.otherOff, plain.secret], [undefined, undefined]);
  // The answers go back keyed by Codex's own ids, the secret one like any other.
  const reply = A.replyTo(req, { action: 'answers', answers: { 'Which environment?': 'Staging', 'Paste the deploy token': 's3cret', 'Anything else?': '' } });
  assert.deepEqual(reply, { result: { answers: { env: { answers: ['Staging'] }, token: { answers: ['s3cret'] } } }, stops: false });
});

test('a question that does not block is still answered on the wire, by its id', () => {
  const req = chat().a.request(ask('item/tool/requestUserInput', { itemId: 'q-2', isBlocking: false, autoResolutionMs: 5000, questions: [{ id: 'a', header: '', question: 'Go on?', isOther: true, isSecret: false, options: [{ label: 'Yes', description: '' }] }] }, 7), { threadId: T });
  assert.deepEqual([req.rpcId, req.base.blocking, req.base.passive], [7, false, undefined], 'it has an id, so it is never one of the cards Canopy raises itself');
  assert.deepEqual(A.replyTo(req, { action: 'answers', answers: { 'Go on?': 'Yes' } }).result, { answers: { a: { answers: ['Yes'] } } });
});

// ---- Deny that stops the turn ----

test('Deny says when it stops the turn: only where Codex offers no plain "no"', () => {
  const command = (availableDecisions) => chat().a.request(ask('item/commandExecution/requestApproval', { itemId: 'exec-1', kind: 'command', command: "/bin/zsh -lc 'touch a.txt'", commandActions: [{ type: 'unknown', command: 'touch a.txt' }], reason: null, ...(availableDecisions && { availableDecisions }) }), { threadId: T });
  // What the recorded command approval offered: no `decline`.
  const noDecline = command(['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'a.txt'] } }, 'cancel']);
  assert.equal(noDecline.base.denyStops, true);
  assert.deepEqual(A.replyTo(noDecline, { action: 'deny' }), { result: { decision: 'cancel' }, stops: true }, 'and that Deny really does stop it');
  const withDecline = command(['accept', 'acceptForSession', 'decline', 'cancel']);
  assert.equal(withDecline.base.denyStops, undefined);
  assert.equal(A.replyTo(withDecline, { action: 'deny' }).stops, false);
  assert.equal(command(null).base.denyStops, undefined, 'nothing said about decisions: every one is offered');
  assert.equal(command(['accept']).base.denyStops, undefined, 'neither "no" offered: Codex is told `decline`, which stops nothing');
  // The recording itself.
  const lines = fs.readFileSync(path.join(FIXTURES, 'codex-command-approval.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const recorded = lines.find((l) => l.dir === 'in' && l.msg.method === 'item/commandExecution/requestApproval').msg;
  assert.equal(A.requestOf(recorded, null).base.denyStops, true, 'the recorded approval is one of these');
  // A file change always offers a plain "no".
  const file = chat().a.request(ask('item/fileChange/requestApproval', { itemId: 'exec-9', reason: null, grantRoot: null }), { threadId: T });
  assert.equal(file.base.denyStops, undefined);
});

// ---- limits ----

const limits = (rateLimitReachedType, primary, secondary = null) => ({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', limitName: null, primary, secondary, credits: null, rateLimitReachedType } } });
const five = (usedPercent, resetsAt = 1794805200) => ({ usedPercent, windowDurationMins: 300, resetsAt });
const week = (usedPercent, resetsAt = 1795400000) => ({ usedPercent, windowDurationMins: 10080, resetsAt });

test('a limit reached: the sentence a Claude chat says, with the limit\'s name', () => {
  const hit = chat().feed(limits('rate_limit_reached', five(100), week(40)))[0];
  assert.deepEqual([hit.kind, hit.level, hit.code, hit.resetsAt], ['notice', 'warn', 'rate-limit', 1794805200000]);
  assert.match(hit.text, /^Usage limit reached \(5-hour limit\)\. It resets (at|on) /);
  const weekly = chat().feed(limits('rate_limit_reached', five(100), week(100)))[0];
  assert.match(weekly.text, /^Usage limit reached \(weekly limit\)\. It resets (at|on) /, 'both full: the one that resets last is the one in the way');
  assert.equal(weekly.resetsAt, 1795400000000);
  const unnamed = chat().feed(limits('rate_limit_reached', five(60)))[0];
  assert.match(unnamed.text, /^Usage limit reached\. It resets (at|on) /, 'no window is marked full, so none is named');
  assert.equal(chat().feed(limits('workspace_member_credits_depleted', five(100)))[0].text, 'Your OpenAI workspace is out of credits.', 'out of credits stays its own sentence');
});

test('a limit nearly reached is said once per window, from 80%', () => {
  const c = chat();
  assert.deepEqual(c.feed(limits(null, five(79))), []);
  const near = c.feed(limits(null, five(82)));
  assert.equal(near.length, 1);
  assert.deepEqual([near[0].kind, near[0].code, near[0].level], ['notice', 'rate-limit-warning', undefined]);
  assert.match(near[0].text, /^Approaching your usage limit \(5-hour limit, 82% used\)\. It resets (at|on) /);
  assert.deepEqual(near[0].rateLimit, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1794805200000, utilization: 0.82 });
  assert.deepEqual(c.feed(limits(null, five(85)), limits(null, five(93))), [], 'the same window is not said again as it fills');
  assert.equal(c.feed(limits(null, five(84, 1794823200))).length, 1, 'a new window (a new reset time) is news again');
  const both = chat().feed(limits(null, five(90), week(81)));
  assert.deepEqual(both.map((e) => e.rateLimit.rateLimitType), ['five_hour', 'weekly'], 'each window speaks for itself');
  assert.match(both[1].text, /^Approaching your usage limit \(weekly limit, 81% used\)/);
  // Reached is the other notice, never both for one line.
  assert.deepEqual(chat().feed(limits('rate_limit_reached', five(100))).map((e) => e.code), ['rate-limit']);
});

test('the words a Claude chat would rewrite are never passed through', () => {
  const c = chat();
  const events = [...c.feed(limits('rate_limit_reached', five(100))), ...chat().feed(limits(null, five(90))),
    ...c.feed(note('error', { error: { message: 'no', codexErrorInfo: 'unauthorized', additionalDetails: null }, willRetry: false, turnId: TURN }))];
  for (const ev of events) assert.doesNotMatch(String(ev.text ?? ''), /^(Rate limited|Auth: )/);
  assert.equal(events.at(-1).text, 'Codex needs you to sign in again.', 'not signed in: the same sentence, with the tool\'s own name');
});

// ---- the to-do list ----

test('the to-do list is the same TodoWrite row, with what Codex said about the change', () => {
  const c = chat();
  c.feed(turnStarted());
  const plan = note('turn/plan/updated', { turnId: TURN, explanation: 'Splitting the migration in two.', plan: [{ step: 'Read the schema', status: 'completed' }, { step: 'Write the migration', status: 'inProgress' }, { step: 'Run the tests', status: 'pending' }] });
  const [start, result] = c.feed(plan);
  assert.deepEqual([start.kind, start.name, result.kind, result.id], ['tool-start', 'TodoWrite', 'tool-result', start.id]);
  assert.deepEqual(start.input, { explanation: 'Splitting the migration in two.', todos: [
    { content: 'Read the schema', status: 'completed', activeForm: 'Read the schema' },
    { content: 'Write the migration', status: 'in_progress', activeForm: 'Write the migration' },
    { content: 'Run the tests', status: 'pending', activeForm: 'Run the tests' },
  ] });
  assert.deepEqual(c.feed(plan), [], 'the same list again is not a second row');
  const bare = chat().feed(note('turn/plan/updated', { turnId: TURN, explanation: null, plan: [{ step: 'One thing', status: 'pending' }] }))[0];
  assert.ok(!('explanation' in bare.input), 'no explanation, no empty line');
});

// ---- the model on a turn's end ----

test('a turn\'s end names the model that ran it, live; a saved turn names none', () => {
  let model = 'gpt-6.1-sol';
  const c = chat({ model: () => model });
  c.feed(turnStarted());
  assert.equal(c.feed(turnDone()).at(-1).model, 'gpt-6.1-sol');
  model = 'gpt-6-luna';
  c.feed(turnStarted('turn-2'));
  assert.equal(c.feed(turnDone('turn-2')).at(-1).model, 'gpt-6-luna', 'a model switched in between shows on the next turn');
  const [end] = A.adaptHistory([{ id: TURN, status: 'completed', error: null, startedAt: 1794801559, completedAt: 1794801562, items: [] }], { threadId: T });
  assert.deepEqual([end.kind, end.model, end.turnId], ['turn-end', null, TURN], 'Codex keeps no model per turn: the host puts back the ones it noted');
  assert.equal(A.adapt(turnDone(), { threadId: T }).at(-1).model, null, 'with nobody to ask, none');
});

// ---- agents ----

test('an agent\'s lines come out under its Agent row and never start or end the chat\'s own turn', () => {
  const c = chat();
  c.feed(turnStarted());
  const line = (method, params) => ({ method, params: { threadId: CHILD, ...params }, emittedAtMs: 1794801559500 });
  const exec = { type: 'commandExecution', id: 'exec-c1', command: "/bin/zsh -lc 'npm test'", cwd: '/w', processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: null, exitCode: null, durationMs: null };
  assert.deepEqual(c.child('ag-1', line('turn/started', { turn: { id: 'turn-c1', items: [], status: 'inProgress' } })), [], 'no message-start for the chat');
  const [start] = c.child('ag-1', line('item/started', { item: exec, turnId: 'turn-c1' }));
  assert.deepEqual([start.kind, start.name, start.parent, start.agentId], ['tool-start', 'Bash', 'ag-1', CHILD]);
  const [result] = c.child('ag-1', line('item/completed', { item: { ...exec, status: 'completed', aggregatedOutput: '746 pass', exitCode: 0 }, turnId: 'turn-c1' }));
  assert.deepEqual([result.kind, result.id, result.parent, result.agentId, result.content], ['tool-result', 'exec-c1', 'ag-1', CHILD, '746 pass']);
  assert.deepEqual(c.child('ag-1', line('item/agentMessage/delta', { itemId: 'msg-c1', turnId: 'turn-c1', delta: 'All ' })), [], 'an agent\'s words are not streamed into the chat\'s reply');
  const [said] = c.child('ag-1', line('item/completed', { item: { type: 'agentMessage', id: 'msg-c1', text: 'All green.', phase: 'final_answer' }, turnId: 'turn-c1' }));
  assert.deepEqual([said.kind, said.text, said.parent], ['assistant-text', 'All green.', 'ag-1']);
  assert.deepEqual(c.child('ag-1', line('thread/tokenUsage/updated', { turnId: 'turn-c1', tokenUsage: { total: { totalTokens: 900000 }, last: { totalTokens: 900000 }, modelContextWindow: 1000000 } })), []);
  assert.equal(c.a.usage(), null, 'an agent\'s token counts are not the chat\'s context');
  assert.deepEqual(c.child('ag-1', line('turn/completed', { turn: { id: 'turn-c1', items: [], status: 'completed' } })), [], 'no turn-end for the chat');
  // The chat's own turn is still the one that ends it, with its own words.
  c.feed(completed({ type: 'agentMessage', id: 'msg-1', text: 'The agent says all green.', phase: 'final_answer' }));
  const end = c.feed(turnDone()).at(-1);
  assert.deepEqual([end.kind, end.text, end.turnId], ['turn-end', 'The agent says all green.', TURN]);
  assert.deepEqual(c.unknown, []);
});

test('an agent stopped mid-step: its open step is closed under its row, and nothing else is said', () => {
  const c = chat();
  const line = (method, params) => ({ method, params: { threadId: CHILD, ...params } });
  c.child('ag-1', line('turn/started', { turn: { id: 'turn-c1' } }));
  c.child('ag-1', line('item/started', { item: { type: 'commandExecution', id: 'exec-c2', command: 'sleep 60', status: 'inProgress', commandActions: [] }, turnId: 'turn-c1' }));
  const out = c.child('ag-1', line('turn/completed', { turn: { id: 'turn-c1', items: [], status: 'failed', error: { message: 'boom' } } }));
  assert.deepEqual(out.map((e) => [e.kind, e.id, e.interrupted, e.parent]), [['tool-result', 'exec-c2', true, 'ag-1']], 'no error notice and no turn-end from the agent');
});

test('an agent\'s request is described from the agent\'s own open items, and says who asked', () => {
  const c = chat();
  const line = (method, params) => ({ method, params: { threadId: CHILD, ...params } });
  const change = { type: 'fileChange', id: 'patch-c1', status: 'inProgress', changes: [{ path: '/w/a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] };
  c.child('ag-1', line('item/started', { item: change, turnId: 'turn-c1' }));
  const req = c.a.request({ id: 3, method: 'item/fileChange/requestApproval', params: { threadId: CHILD, turnId: 'turn-c1', itemId: 'patch-c1', reason: null, grantRoot: null } }, { threadId: CHILD, parent: 'ag-1' });
  assert.deepEqual([req.base.agentId, req.base.toolName, req.base.input.file_path, req.base.toolUseId], [CHILD, 'Edit', '/w/a.txt', 'patch-c1']);
  // Asked as the chat itself, the same request names another thread and is not the chat's to answer.
  assert.equal(c.a.request({ id: 3, method: 'item/fileChange/requestApproval', params: { threadId: CHILD, itemId: 'patch-c1' } }, { threadId: T }), null);
  const own = c.a.request(ask('item/fileChange/requestApproval', { itemId: 'nope', reason: null, grantRoot: null }), { threadId: T });
  assert.equal(own.base.agentId, null, 'the chat\'s own requests name no agent');
});

test('reset forgets the agents\' memory too', () => {
  const c = chat();
  const line = (method, params) => ({ method, params: { threadId: CHILD, ...params } });
  c.child('ag-1', line('item/started', { item: { type: 'commandExecution', id: 'exec-c3', command: 'ls', status: 'inProgress', commandActions: [] }, turnId: 'turn-c1' }));
  c.a.reset();
  assert.deepEqual(c.child('ag-1', line('turn/completed', { turn: { id: 'turn-c1', items: [], status: 'interrupted' } })), [], 'nothing is left open to close');
});

// ---- the recordings ----

test('every recording still replays with no line the adapter does not know', () => {
  const names = fs.readdirSync(FIXTURES).filter((f) => /^codex-.*\.jsonl$/.test(f));
  assert.ok(names.length >= 13);
  for (const name of names) {
    const c = chat();
    const lines = fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const events = [];
    for (const l of lines) {
      if (l.dir !== 'in' || !l.msg || typeof l.msg !== 'object') continue;
      events.push(...c.a.adapt(l.msg));
      if (typeof l.msg.method === 'string' && l.msg.id !== undefined) c.a.request(l.msg);
    }
    assert.deepEqual(c.unknown, [], name);
    assert.ok(!events.some((e) => e.kind === 'raw'), `${name}: nothing fell through as raw`);
    for (const end of events.filter((e) => e.kind === 'turn-end')) assert.equal(end.model, 'gpt-6.1-sol', `${name}: every live turn end names its model`);
  }
});

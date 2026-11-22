// The slash commands an OpenAI chat runs itself (src/core/codex-commands.mjs): which messages are commands, the
// Codex call each one means, and the words a goal's changes are said in. Pure: no process, no window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../../codex-commands.mjs';

const T = '0f000000-0000-7000-8000-000000000001';
const call = (text) => C.callFor(C.parseCommand(text), T);

test('the list an OpenAI chat reports: the same three names, each with a description', () => {
  assert.deepEqual(C.CODEX_COMMANDS.map((c) => c.name), ['compact', 'review', 'goal']);
  assert.deepEqual(C.CODEX_COMMANDS.map((c) => c.description), ['Summarize earlier messages to free up context', 'Review your changes', 'Set a goal to keep working toward']);
  assert.deepEqual(C.CODEX_COMMANDS.map((c) => c.argumentHint), ['', '[branch <name> | commit <sha> | what to look at]', '[goal | pause | resume | clear]']);
  assert.ok(Object.isFrozen(C.CODEX_COMMANDS) && Object.isFrozen(C.CODEX_COMMANDS[0]));
});

test('a message is a command only when the whole message is one', () => {
  assert.deepEqual(C.parseCommand('/compact'), { name: 'compact', arg: '' });
  assert.deepEqual(C.parseCommand('/Compact'), { name: 'compact', arg: '' }, 'case does not matter');
  assert.deepEqual(C.parseCommand('  /compact  '), { name: 'compact', arg: '' }, 'nor does space around it');
  assert.deepEqual(C.parseCommand('/review branch main'), { name: 'review', arg: 'branch main' });
  assert.deepEqual(C.parseCommand('/goal ship the importer\nby Friday'), { name: 'goal', arg: 'ship the importer\nby Friday' });
  for (const text of ['/compacted', 'please /compact', 'run /review now', '/model sol', '/', '/ compact', 'compact', '', '/goals', '/review-all']) {
    assert.equal(C.parseCommand(text), null, text);
  }
  for (const v of [null, undefined, 5, {}, ['/compact']]) assert.equal(C.parseCommand(v), null);
});

test('/compact is Codex\'s own compaction', () => {
  assert.deepEqual(call('/compact'), { method: 'thread/compact/start', params: { threadId: T }, starts: 'compaction', about: 'compact' });
  assert.deepEqual(call('/compact please'), { method: 'thread/compact/start', params: { threadId: T }, starts: 'compaction', about: 'compact' }, 'words after it change nothing');
});

test('/review: your changes, a branch, a commit, or what you ask for', () => {
  const review = (target) => ({ method: 'review/start', params: { threadId: T, target, delivery: 'inline' }, starts: 'turn', about: 'review' });
  assert.deepEqual(call('/review'), review({ type: 'uncommittedChanges' }));
  assert.deepEqual(call('/review branch main'), review({ type: 'baseBranch', branch: 'main' }));
  assert.deepEqual(call('/review Branch release/2.1'), review({ type: 'baseBranch', branch: 'release/2.1' }));
  assert.deepEqual(call('/review commit 1a2b3c4'), review({ type: 'commit', sha: '1a2b3c4', title: null }));
  assert.deepEqual(call('/review look at the error handling'), review({ type: 'custom', instructions: 'look at the error handling' }));
  assert.deepEqual(call('/review branch'), review({ type: 'custom', instructions: 'branch' }), 'a branch with no name is words, not a branch');
  assert.deepEqual(call('/review commit the new parser'), review({ type: 'custom', instructions: 'commit the new parser' }), 'words after "commit" that are not a sha are words');
});

test('/goal in its five forms', () => {
  const goal = (method, params, about) => ({ method, params: { threadId: T, ...params }, starts: null, about });
  assert.deepEqual(call('/goal'), goal('thread/goal/get', {}, 'goal-get'));
  assert.deepEqual(call('/goal ship the importer'), goal('thread/goal/set', { objective: 'ship the importer', status: 'active' }, 'goal-set'));
  assert.deepEqual(call('/goal pause'), goal('thread/goal/set', { status: 'paused' }, 'goal-set'));
  assert.deepEqual(call('/goal Resume'), goal('thread/goal/set', { status: 'active' }, 'goal-set'));
  assert.deepEqual(call('/goal clear'), goal('thread/goal/clear', {}, 'goal-clear'));
  assert.deepEqual(call('/goal clear the backlog'), goal('thread/goal/set', { objective: 'clear the backlog', status: 'active' }, 'goal-set'), 'only the bare word is the verb');
});

test('what is not a command has no call', () => {
  for (const v of [null, undefined, {}, { name: 'model', arg: 'x' }, 'compact']) assert.equal(C.callFor(v, T), null);
});

test('before the first message, and when Codex refuses: one plain sentence', () => {
  assert.equal(C.sendFirst('review'), 'Send a message first, then use /review.');
  assert.equal(C.failedText('review', 'not a git repository\n  at x'), 'Couldn’t run /review: not a git repository at x');
  assert.equal(C.failedText('goal', ''), 'Couldn’t run /goal.');
  assert.equal(C.failedText('compact', 'x'.repeat(900)).length, 'Couldn’t run /compact: '.length + 300);
});

test('a goal is said when its words or its state change, never as its counts tick up', () => {
  const g = (objective, status = 'active', extra = {}) => ({ threadId: T, objective, status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1, ...extra });
  assert.equal(C.goalChange(null, g('ship the importer')), 'Goal set: ship the importer');
  assert.equal(C.goalChange(g('ship the importer'), g('ship the importer', 'active', { tokensUsed: 9000, timeUsedSeconds: 40, updatedAt: 9 })), null, 'a token tick is not news');
  assert.equal(C.goalChange(g('a'), g('b')), 'Goal set: b');
  assert.equal(C.goalChange(g('a'), g('a', 'paused')), 'Goal paused.');
  assert.equal(C.goalChange(g('a', 'paused'), g('a')), 'Goal resumed.');
  assert.equal(C.goalChange(g('a'), g('a', 'complete')), 'Goal reached.');
  assert.equal(C.goalChange(g('a'), g('a', 'usageLimited')), 'Goal paused: a usage limit was reached.');
  assert.equal(C.goalChange(g('a'), g('a', 'budgetLimited')), 'Goal paused: it used up its budget.');
  assert.equal(C.goalChange(g('a'), g('a', 'blocked')), 'Goal blocked: it needs you to carry on.');
  assert.equal(C.goalChange(g('a'), g('a', 'something-new')), 'Goal paused.', 'a state this file does not know is at least not "working"');
  assert.equal(C.goalChange(g('a'), null), 'Goal cleared.');
  assert.equal(C.goalChange(null, null), null, 'no goal before and none now');
  assert.equal(C.goalChange(null, g('a', 'paused')), 'Goal set: a (paused)');
  assert.equal(C.goalChange(null, g(`one\n  two ${'x'.repeat(400)}`)).length, 'Goal set: '.length + 300, 'one line, kept short');
});

test('a bare /goal says what the goal is', () => {
  assert.equal(C.goalSaid({ objective: 'ship the importer', status: 'active' }), 'Goal: ship the importer');
  assert.equal(C.goalSaid({ objective: 'ship the importer', status: 'paused' }), 'Goal: ship the importer (paused)');
  assert.equal(C.goalSaid({ objective: 'ship the importer', status: 'complete' }), 'Goal: ship the importer (reached)');
  for (const v of [null, undefined, {}, { objective: '  ' }, 'x']) assert.equal(C.goalSaid(v), 'No goal set.');
  assert.deepEqual(C.goalKey({ objective: ' a ', status: 'paused', tokensUsed: 5 }), { objective: 'a', status: 'paused' });
  assert.equal(C.goalKey(null), null);
});

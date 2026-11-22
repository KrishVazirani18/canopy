// Sub-agents in an OpenAI chat (src/core/codex-agents.mjs): which child thread belongs to which Agent row, and the
// `tasks` list the agents drawer draws. Built from the 0.153.4 protocol types (no recording has an agent), so every
// line here is made by hand. Pure: no process, no window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgents } from '../../codex-agents.mjs';

const PARENT = '0f000000-0000-7000-8000-000000000001';
const CHILD = '0f000000-0000-7000-8000-0000000000c1';
const OTHER = '0f000000-0000-7000-8000-0000000000c2';
const call = (tool, extra = {}) => ({ type: 'collabAgentToolCall', id: `ag-${tool}`, tool, status: 'inProgress', senderThreadId: PARENT, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {}, ...extra });

function clocked() {
  let t = 1000;
  const agents = createAgents({ now: () => t });
  return { agents, tick: (ms) => { t += ms; } };
}

test('starting an agent: its thread belongs to the row that started it, and it is listed as a running task', () => {
  const { agents } = clocked();
  assert.equal(agents.noteItem(call('spawnAgent', { prompt: 'Find the flaky test\nand say why', model: 'gpt-6-luna', receiverThreadIds: [CHILD] })), true);
  assert.equal(agents.has(CHILD), true);
  assert.equal(agents.rowOf(CHILD), 'ag-spawnAgent');
  assert.equal(agents.rowOf(OTHER), null, 'a thread nobody started is not this chat\'s');
  assert.deepEqual(agents.tasks(), [{
    taskId: CHILD, status: 'running', description: 'Find the flaky test', agentType: 'gpt-6-luna', lastTool: undefined, toolUseId: 'ag-spawnAgent',
    startedAt: 1000, endedAt: undefined, summary: undefined, taskType: 'local_agent',
  }]);
  assert.equal(agents.running(), 1);
  assert.equal(agents.noteItem(call('spawnAgent', { prompt: 'Find the flaky test\nand say why', model: 'gpt-6-luna', receiverThreadIds: [CHILD] })), false, 'the same line again changes nothing');
});

test('the child is named only when the call completes: its thread is matched to the call still waiting', () => {
  const { agents } = clocked();
  agents.noteItem(call('spawnAgent', { prompt: 'Read the logs' }));
  assert.deepEqual(agents.tasks(), [], 'no thread yet, so no task yet');
  assert.equal(agents.noteThread({ id: CHILD, parentThreadId: PARENT, source: { subAgent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_role: 'explorer' } } } }), true);
  assert.equal(agents.rowOf(CHILD), 'ag-spawnAgent');
  assert.equal(agents.tasks()[0].agentType, 'explorer');
  assert.equal(agents.noteThread({ id: OTHER, parentThreadId: PARENT }), false, 'no call is waiting for a second thread');
  assert.equal(agents.has(OTHER), false);
  assert.equal(agents.noteThread({ id: 'x', parentThreadId: null }), false, 'a thread with no parent is not an agent');
  // The completed call confirms it and says how the agent is doing.
  agents.noteItem(call('spawnAgent', { prompt: 'Read the logs', status: 'completed', receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: 'running', message: null } } }));
  assert.equal(agents.tasks().length, 1);
  assert.equal(agents.tasks()[0].status, 'running');
});

test('an agent\'s lines: its turn, its last step, and how it ended', () => {
  const { agents, tick } = clocked();
  agents.noteItem(call('spawnAgent', { prompt: 'Run the tests', receiverThreadIds: [CHILD] }));
  assert.equal(agents.turnOf(CHILD), null, 'no turn named yet');
  assert.equal(agents.noteLine(CHILD, 'turn/started', { threadId: CHILD, turn: { id: 'turn-c1' } }), true);
  assert.deepEqual(agents.turnOf(CHILD), { threadId: CHILD, turnId: 'turn-c1' });
  assert.equal(agents.noteLine(CHILD, 'item/started', { item: { type: 'commandExecution', id: 'exec-1' } }), true);
  assert.equal(agents.tasks()[0].lastTool, 'Bash');
  assert.equal(agents.noteLine(CHILD, 'item/started', { item: { type: 'commandExecution', id: 'exec-2' } }), false, 'the same kind of step is no change');
  agents.noteLine(CHILD, 'item/started', { item: { type: 'mcpToolCall', id: 'm-1', server: 'linear', tool: 'list_issues' } });
  assert.equal(agents.tasks()[0].lastTool, 'mcp__linear__list_issues');
  assert.equal(agents.noteLine(CHILD, 'item/started', { item: { type: 'agentMessage', id: 'msg-1' } }), false, 'words are not a step');
  tick(4000);
  assert.equal(agents.noteLine(CHILD, 'turn/completed', { threadId: CHILD, turn: { id: 'turn-c1', status: 'completed' } }), false, 'its turn ending is not the agent ending');
  assert.equal(agents.turnOf(CHILD), null);
  assert.equal(agents.tasks()[0].status, 'running');
  // The parent's `wait` call says it finished, and with what.
  assert.equal(agents.noteItem(call('wait', { status: 'completed', receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: 'completed', message: 'All 746 pass.\nNothing flaky.' } } })), true);
  const [t] = agents.tasks();
  assert.deepEqual([t.status, t.summary, t.endedAt], ['completed', 'All 746 pass.', 5000]);
  assert.equal(agents.running(), 0);
  assert.equal(agents.noteLine(OTHER, 'turn/started', { turn: { id: 'x' } }), false, 'a line from a thread that is not an agent of this chat');
});

test('an agent that failed or was stopped says so', () => {
  const { agents } = clocked();
  agents.noteItem(call('spawnAgent', { prompt: 'A', receiverThreadIds: [CHILD] }));
  agents.noteItem({ ...call('spawnAgent', { prompt: 'B', receiverThreadIds: [OTHER] }), id: 'ag-2' });
  agents.noteLine(CHILD, 'turn/started', { turn: { id: 't1' } });
  assert.equal(agents.noteLine(CHILD, 'turn/completed', { turn: { id: 't1', status: 'failed', error: { message: 'model overloaded' } } }), true);
  assert.deepEqual([agents.tasks()[0].status, agents.tasks()[0].summary], ['failed', 'model overloaded']);
  agents.noteLine(OTHER, 'turn/started', { turn: { id: 't2' } });
  assert.equal(agents.noteLine(OTHER, 'turn/completed', { turn: { id: 't2', status: 'interrupted' } }), true);
  assert.equal(agents.tasks()[1].status, 'stopped');
  // Codex's own words for an agent's state, as the drawer's.
  for (const [said, shown] of [['pendingInit', 'running'], ['running', 'running'], ['completed', 'completed'], ['errored', 'failed'], ['interrupted', 'stopped'], ['shutdown', 'stopped'], ['notFound', 'failed']]) {
    const a = createAgents();
    a.noteItem(call('spawnAgent', { prompt: 'x', receiverThreadIds: [CHILD] }));
    a.noteItem(call('wait', { receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: said, message: null } } }));
    assert.equal(a.tasks()[0].status, shown, said);
  }
});

test('more work for an agent goes under the row that handed it over; waiting and closing have no row', () => {
  const { agents } = clocked();
  agents.noteItem(call('spawnAgent', { prompt: 'Find the bug', receiverThreadIds: [CHILD], status: 'completed', agentsStates: { [CHILD]: { status: 'completed', message: 'Found it.' } } }));
  assert.equal(agents.tasks()[0].status, 'completed');
  agents.noteItem({ ...call('sendInput', { prompt: 'Now fix it', receiverThreadIds: [CHILD] }), id: 'ag-more' });
  assert.equal(agents.rowOf(CHILD), 'ag-more', 'what it does next is drawn under the follow-up');
  assert.equal(agents.tasks()[0].status, 'running');
  assert.equal(agents.tasks()[0].description, 'Find the bug', 'it is still the agent that was started for this');
  agents.noteItem(call('wait', { receiverThreadIds: [CHILD] }));
  agents.noteItem(call('closeAgent', { receiverThreadIds: [CHILD] }));
  assert.equal(agents.rowOf(CHILD), 'ag-more');
});

test('activity lines keep an agent\'s state current, and can be all that is known of one', () => {
  const { agents } = clocked();
  agents.noteItem(call('spawnAgent', { prompt: 'A', receiverThreadIds: [CHILD] }));
  assert.equal(agents.noteItem({ type: 'subAgentActivity', id: 's1', kind: 'completed', agentThreadId: CHILD, agentPath: 'root/explorer' }), true);
  assert.equal(agents.tasks()[0].status, 'completed');
  assert.equal(agents.noteItem({ type: 'subAgentActivity', id: 's2', kind: 'started', agentThreadId: OTHER, agentPath: 'root/worker' }), true);
  assert.equal(agents.has(OTHER), true);
  assert.equal(agents.rowOf(OTHER), null, 'no row is known for it, so its steps have nowhere to go');
  assert.deepEqual([agents.tasks()[1].description, agents.tasks()[1].agentType], ['Agent', 'worker']);
});

test('a running agent that says nothing is found, and only until it speaks', () => {
  const { agents, tick } = clocked();
  agents.noteItem(call('spawnAgent', { prompt: 'A', receiverThreadIds: [CHILD] }));
  assert.deepEqual(agents.quiet(2000), []);
  assert.deepEqual(agents.quiet(0), [CHILD]);
  tick(2500);
  assert.deepEqual(agents.quiet(2000), [CHILD]);
  agents.noteLine(CHILD, 'item/started', { item: { type: 'reasoning', id: 'r' } });
  assert.deepEqual(agents.quiet(2000), [], 'it has been heard from');
});

test('when the process goes, the agents that were running are stopped; reset forgets them', () => {
  const { agents } = clocked();
  agents.noteItem(call('spawnAgent', { prompt: 'A', receiverThreadIds: [CHILD] }));
  assert.equal(agents.endAll(), true);
  assert.equal(agents.tasks()[0].status, 'stopped');
  assert.equal(agents.endAll(), false);
  agents.reset();
  assert.deepEqual(agents.tasks(), []);
  assert.equal(agents.has(CHILD), false);
});

test('it holds a bounded number of agents, and never drops one that is running', () => {
  const agents = createAgents();
  for (let i = 0; i < 64; i++) agents.noteItem({ ...call('spawnAgent', { prompt: `task ${i}`, receiverThreadIds: [`child-${i}`] }), id: `row-${i}` });
  assert.equal(agents.tasks().length, 64);
  agents.noteItem({ ...call('spawnAgent', { prompt: 'one more', receiverThreadIds: ['child-x'] }), id: 'row-x' });
  assert.equal(agents.has('child-x'), false, 'all 64 are running: there is no room');
  agents.noteItem(call('wait', { receiverThreadIds: ['child-0'], agentsStates: { 'child-0': { status: 'completed', message: null } } }));
  agents.noteItem({ ...call('spawnAgent', { prompt: 'one more', receiverThreadIds: ['child-x'] }), id: 'row-x' });
  assert.equal(agents.has('child-x'), true);
  assert.equal(agents.has('child-0'), false, 'the finished one made room');
});

test('lines that cannot be read change nothing', () => {
  const agents = createAgents();
  for (const v of [null, undefined, 5, 'x', [], {}, { type: 'collabAgentToolCall' }, { type: 'subAgentActivity' }, { type: 'commandExecution', id: 'e' }]) assert.equal(agents.noteItem(v), false);
  for (const v of [null, {}, { id: 5 }, { id: 'x' }]) assert.equal(agents.noteThread(v), false);
  assert.equal(agents.noteLine('nobody', 'turn/started', null), false);
  assert.deepEqual(agents.tasks(), []);
  assert.equal(agents.turnOf('nobody'), null);
});

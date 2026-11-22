// What the window's store (renderer/src/lib/store.ts) does so both makers' chats draw the same: the
// plan's usage limits beside the context reading, the ring moving on a chat's own word, a review's status line, the
// agents list, the model each reply was written by (also in a saved chat), and one wording for the same notice.
// The store is the real one; node reads its TypeScript as it is, with the few things it expects from a window
// stood in for here.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (err) {
      if (specifier.startsWith('.') && !path.extname(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const bridge = { context: null };
globalThis.window = {
  canopy: { context: () => Promise.resolve(bridge.context), send: () => Promise.resolve({ ok: true }), set: () => Promise.resolve(), respond: () => Promise.resolve(), interrupt: () => Promise.resolve() },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);

const S = await import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/lib/store.ts')).href);
const tick = () => new Promise((r) => setTimeout(r, 0));
const FIVE = { id: 'five_hour', name: '5-hour limit', usedPercent: 42, resetsAt: 1794805200000 };
const WEEK = { id: 'weekly', name: 'weekly limit', usedPercent: 12, resetsAt: null };

test('a context reading sets the ring and the plan\'s limits; one without limits leaves the last ones', async () => {
  const s = new S.Store();
  assert.equal(s.meta.limits, undefined, 'nothing is known until a chat says');
  bridge.context = { totalTokens: 51680, maxTokens: 258400, percentage: 20, limits: [FIVE, WEEK] };
  s.fetchContext();
  await tick();
  assert.deepEqual([s.meta.ctx, s.meta.ctxTokens, s.meta.ctxMax], [20, 51680, 258400]);
  assert.deepEqual(s.meta.limits, [FIVE, WEEK]);
  bridge.context = { totalTokens: 60000, maxTokens: 258400, percentage: 23 };
  s.fetchContext();
  await tick();
  assert.equal(s.meta.ctx, 23);
  assert.deepEqual(s.meta.limits, [FIVE, WEEK], 'an older main that sends no limits does not wipe them');
  bridge.context = { totalTokens: 60000, maxTokens: 258400, percentage: 23, limits: [] };
  s.fetchContext();
  await tick();
  assert.deepEqual(s.meta.limits, [], 'a login with none says so');
  bridge.context = null;
  s.fetchContext();
  await tick();
  assert.equal(s.meta.ctx, 23, 'no reading changes nothing');
});

test('a chat that says how full it is mid-turn moves the ring, and adds no row to the transcript', () => {
  const s = new S.Store();
  s.handle({ kind: 'context', totalTokens: 129200, maxTokens: 258400, percentage: 50, limits: [FIVE] });
  assert.deepEqual([s.meta.ctx, s.meta.ctxTokens, s.meta.ctxMax, s.meta.limits], [50, 129200, 258400, [FIVE]]);
  assert.equal(s.items.length, 0);
  s.handle({ kind: 'context', totalTokens: 'lots' });
  assert.equal(s.meta.ctx, 50, 'a reading that cannot be read is ignored');
  assert.equal(s.items.length, 0);
});

test('the status line says what a long step is: summarizing, reviewing, and nothing once it is over', () => {
  const s = new S.Store();
  s.handle({ kind: 'status', status: 'compacting' });
  assert.equal(s.meta.status, 'Making room to keep going');
  s.handle({ kind: 'status', status: 'reviewing' });
  assert.equal(s.meta.status, 'Reviewing');
  s.handle({ kind: 'status', status: null });
  assert.equal(s.meta.status, '');
});

test('the same notice reads the same whichever maker\'s chat says it', () => {
  const said = (text) => { const s = new S.Store(); s.handle({ kind: 'notice', text }); return s.items[0].text; };
  // Both engines say it in the same words, and the window shows them as they come.
  assert.equal(said('That chat is no longer on disk, so Canopy started a new one.'), 'That chat is no longer on disk, so Canopy started a new one.');
  assert.equal(said('That chat is no longer on disk.'), 'That chat is no longer on disk.');
  assert.equal(S.rewriteNotice('Claude Code could not start: no such file'), 'Claude Code couldn’t start: no such file');
  assert.equal(S.rewriteNotice('Codex could not start: no such file'), 'Codex couldn’t start: no such file');
  assert.equal(S.rewriteNotice('Conversation compacted'), 'Made room to keep going: Claude now remembers the earlier part of this chat as a short summary', 'the frozen compaction notice, from /compact in either chat');
  for (const text of [
    'Codex stopped unexpectedly and was restarted.', 'Codex keeps stopping. Send a message to try again.', 'Codex did not respond to Stop, so it was restarted.',
    'Codex is taking a long time to start (hooks or MCP servers?).', 'Codex needs you to sign in again.', 'This conversation is billed to an API key, not your ChatGPT plan.', 'This conversation is billed to an API key, not your Claude plan.',
    'Full Access is off. Turn on bypass permissions in Claude Code settings first.', 'Usage limit reached (5-hour limit). It resets at 3:10 PM.',
    'Approaching your usage limit (5-hour limit, 82% used). It resets at 3:10 PM.', 'Goal set: ship the importer', 'Send a message first, then use /review.',
  ]) assert.equal(S.rewriteNotice(text), text, 'written in its final words at the source');
  assert.equal(S.rewriteNotice('Auth: token expired'), 'Claude Code needs you to sign in again.');
  assert.equal(S.rewriteNotice('Bypass permissions is not enabled for this session. Turn it on in your Claude Code settings first (the same as the terminal requires).'),
    'Full Access is off for this chat. Turn on bypass permissions in Claude Code settings first.');
});

test('a compaction notice is a wall for editing in either chat', () => {
  const s = new S.Store();
  s.handle({ kind: 'notice', text: 'Conversation compacted', code: 'compacted' });
  assert.equal(s.items[0].boundary, true);
  assert.ok(s.wall > 0);
});

test('a reply remembers the model that wrote it, live and in a saved chat', () => {
  const s = new S.Store();
  s.loadHistory([
    { kind: 'user-text', text: 'one' }, { kind: 'assistant-text', text: 'A', model: 'claude-opus-5-5' },
    { kind: 'user-text', text: 'two' }, { kind: 'assistant-text', text: 'B', model: null },
  ]);
  s.handle({ kind: 'user-text', text: 'three' });
  s.handle({ kind: 'text-delta', text: 'C' });
  s.handle({ kind: 'assistant-text', text: 'C', model: 'claude-fable-5-2' });
  assert.deepEqual(s.items.filter((i) => i.t === 'assistant').map((i) => i.model), ['claude-opus-5-5', undefined, 'claude-fable-5-2']);
  // A turn's end keeps the model its footer names.
  s.handle({ kind: 'turn-end', durationMs: 1000, model: 'claude-fable-5-2' });
  assert.equal(s.items.at(-1).ev.model, 'claude-fable-5-2');
});

test('an OpenAI chat\'s agents are the same list and the same nested rows as a Claude chat\'s', () => {
  const s = new S.Store();
  s.setEngine('codex');
  s.handle({ kind: 'user-text', text: 'use an agent' });
  s.handle({ kind: 'tool-start', id: 'ag-1', name: 'Agent', input: { description: 'Start an agent', prompt: 'Run the tests' }, parent: null });
  const task = { taskId: 'child-1', status: 'running', description: 'Run the tests', toolUseId: 'ag-1', startedAt: 5, taskType: 'local_agent' };
  s.handle({ kind: 'tasks', tasks: [task], background: [] });
  assert.deepEqual(s.meta.tasks, [task]);
  s.handle({ kind: 'tool-start', id: 'exec-c1', name: 'Bash', input: { command: 'npm test' }, parent: 'ag-1', agentId: 'child-1' });
  s.handle({ kind: 'tool-result', id: 'exec-c1', content: '746 pass', isError: false, parent: 'ag-1' });
  s.handle({ kind: 'assistant-text', text: 'All green.', parent: 'ag-1', agentId: 'child-1' });
  const row = s.items.find((i) => i.t === 'tool' && i.id === 'ag-1');
  assert.deepEqual(row.children.map((c) => [c.t, c.name ?? c.text, c.status]), [['tool', 'Bash', 'done'], ['assistant', 'All green.', undefined]]);
  assert.equal(s.items.filter((i) => i.t === 'tool').length, 1, 'the agent\'s step is under its row, not beside it');
  s.handle({ kind: 'tasks', tasks: [{ ...task, status: 'completed', endedAt: 9, summary: 'All green.' }], background: [] });
  assert.equal(s.meta.tasks[0].status, 'completed');
});

test('an OpenAI chat\'s commands arrive with its meta and fill the `/` menu\'s list', () => {
  const s = new S.Store();
  s.setEngine('codex');
  assert.deepEqual(s.meta.commands, [], 'none of Claude Code\'s are kept from the chat before it');
  const commands = [{ name: 'compact', description: 'Summarize earlier messages to free up context', argumentHint: '' }, { name: 'review', description: 'Review your changes' }, { name: 'goal', description: 'Set a goal to keep working toward' }];
  s.handle({ kind: 'meta', engine: 'codex', commands, model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(s.meta.commands.map((c) => c.name), ['compact', 'review', 'goal']);
});

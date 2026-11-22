// codex-adapter.mjs: `codex app-server` lines in, Canopy events out. Two groups of cases:
//  - the thirteen recorded sessions in fixtures/codex-*.jsonl (real traffic from codex-cli 0.153.4), fed line
//    by line the way a chat would see them, and
//  - lines written by hand, in the shape the generated protocol types declare, for everything the recordings
//    do not hold (MCP calls, web search, the to-do list, compaction, failures, the other prompts) and for
//    input that is simply wrong.
// Nothing here starts Codex or touches the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { core, FIXTURES } from '../helpers.mjs';

const A = await core('codex-adapter.mjs');
const missing = A.__missing ? `codex-adapter.mjs: ${A.__missing}` : false;

// ---- the recordings ----

const NAMES = ['text', 'command-approval', 'file-change-approval', 'decline', 'interrupt', 'read-command', 'command-output',
  'plan', 'resume', 'meta', 'history', 'modes', 'startup'];
const recorded = new Map();
function lines(name) {
  if (!recorded.has(name)) {
    recorded.set(name, fs.readFileSync(path.join(FIXTURES, `codex-${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }
  return recorded.get(name);
}
const incoming = (name) => lines(name).filter((l) => l.dir === 'in').map((l) => l.msg);
const isRequest = (m) => typeof m?.method === 'string' && m.id !== undefined && m.id !== null;
// The result of the nth call of `method` in a recording.
function resultOf(name, method, nth = 0) {
  const sent = lines(name).filter((l) => l.dir === 'out' && l.msg.method === method)[nth];
  assert.ok(sent, `${name}: no ${method} call number ${nth}`);
  const answer = lines(name).find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === sent.msg.id);
  assert.ok(answer?.msg.result, `${name}: ${method} has no result`);
  return answer.msg.result;
}

// Feeds a recording to one adapter, as a chat's session would: notifications to adapt(), server requests to request().
function play(name, opts = {}) {
  const unknown = [];
  const adapter = A.createAdapter({ unknown: (label, keys) => unknown.push({ label, keys }), ...opts });
  const events = [];
  const requests = [];
  for (const msg of incoming(name)) {
    if (isRequest(msg)) requests.push({ msg, req: adapter.request(msg), at: events.length });
    events.push(...adapter.adapt(msg));
  }
  return { events, requests, unknown, adapter };
}

const kinds = (events) => events.map((e) => e.kind);
const of = (events, kind) => events.filter((e) => e.kind === kind);
const only = (events, kind) => {
  const found = of(events, kind);
  assert.equal(found.length, 1, `expected one ${kind}, got ${found.length} in ${kinds(events).join(', ')}`);
  return found[0];
};
// The same list with runs of streaming events folded into one entry.
function folded(events) {
  const out = [];
  for (const k of kinds(events)) if (!((k === 'text-delta' || k === 'thinking-delta') && out.at(-1) === k)) out.push(k);
  return out;
}
const errorsIn = (events) => events.filter((e) => e.kind === 'raw' && e.label === 'adapter-error');

// ---- lines written by hand ----

const T = '01a1e000-0000-7000-8000-00000000000a';
const U = '01a1e000-0000-7000-8000-0000000000b1';
const AT = 1794801600000;
const note = (method, params = {}) => ({ method, params: { threadId: T, turnId: U, ...params }, emittedAtMs: AT });
const started = (item) => note('item/started', { item, startedAtMs: AT });
const completed = (item) => note('item/completed', { item, completedAtMs: AT + 50 });
const turn = (status, extra = {}) => ({ id: U, items: [], itemsView: 'notLoaded', status, error: null, startedAt: AT / 1000, completedAt: null, durationMs: null, ...extra });
const turnStarted = (id = U) => ({ method: 'turn/started', params: { threadId: T, turn: turn('inProgress', { id }) }, emittedAtMs: AT });
const turnCompleted = (status = 'completed', extra = {}) => ({
  method: 'turn/completed', params: { threadId: T, turn: turn(status, { completedAt: AT / 1000 + 2, durationMs: 2000, ...extra }) }, emittedAtMs: AT + 2000,
});
const ask = (method, params = {}, id = 0) => ({ method, id, params: { threadId: T, turnId: U, startedAtMs: AT, ...params } });
const quoted = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const command = (id, typed, extra = {}) => ({
  type: 'commandExecution', id, pluginId: null, scriptPath: null, command: `/bin/zsh -lc ${quoted(typed)}`, cwd: '/w', processId: null,
  source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: typed }], aggregatedOutput: null, exitCode: null, durationMs: null, ...extra,
});
const done = (item, extra = {}) => ({ ...item, status: 'completed', exitCode: 0, durationMs: 12, ...extra });
const message = (id, text, extra = {}) => ({ type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null, ...extra });
const patch = (id, changes, status = 'inProgress') => ({ type: 'fileChange', id, changes, status });
const update = (file, diff, moved = null) => ({ path: file, kind: { type: 'update', move_path: moved }, diff });
const usage = (total, last, window = 258400) => note('thread/tokenUsage/updated', { tokenUsage: { total, last, modelContextWindow: window } });
const tokens = (totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens = 0) =>
  ({ totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens });

// A fresh adapter, plus what it reported as unknown.
function chat(opts = {}) {
  const unknown = [];
  const adapter = A.createAdapter({ unknown: (label, keys) => unknown.push({ label, keys }), ...opts });
  const feed = (...msgs) => msgs.flatMap((m) => adapter.adapt(m));
  return { adapter, feed, unknown };
}

// ---- every recording ----

test('every recording adapts with no adapter error, nothing unknown, and events that survive IPC', { skip: missing }, () => {
  for (const name of NAMES) {
    for (const opts of [{}, { debug: true, verbose: true, toolOutput: true }]) {
      const { events, requests, unknown } = play(name, opts);
      assert.deepEqual(errorsIn(events), [], `${name}: adapter-error`);
      assert.deepEqual(unknown, [], `${name}: the drift hook was called`);
      assert.deepEqual(of(events, 'raw'), [], `${name}: a raw event (an unknown line, with debug on)`);
      for (const ev of events) {
        assert.equal(typeof ev.kind, 'string', `${name}: an event without a kind`);
        assert.doesNotThrow(() => structuredClone(ev), `${name}: ${ev.kind} cannot be cloned`);
      }
      for (const r of requests) assert.ok(r.req, `${name}: ${r.msg.method} was not mapped to a prompt`);
    }
  }
});

test('a recording read with no memory (adapt alone) still gives no error and nothing unknown', { skip: missing }, () => {
  for (const name of NAMES) {
    const unknown = [];
    for (const msg of incoming(name)) {
      const out = A.adapt(msg, { unknown: (label) => unknown.push(label) });
      assert.ok(Array.isArray(out));
      assert.deepEqual(errorsIn(out), [], `${name}: adapter-error`);
    }
    assert.deepEqual(unknown, [], name);
  }
});

test('responses and server requests give nothing from adapt: the session owns them', { skip: missing }, () => {
  for (const name of NAMES) {
    const { adapter } = play(name);
    for (const msg of incoming(name)) {
      if (!msg.method || isRequest(msg)) assert.deepEqual(adapter.adapt(msg), [], `${name}: ${msg.method ?? `response ${msg.id}`}`);
    }
  }
});

test('opening a chat says nothing: MCP start-up, notices about the set-up and status lines stay out of the transcript', { skip: missing }, () => {
  assert.deepEqual(play('startup').events, []);
  for (const name of ['meta', 'modes', 'resume', 'history']) assert.deepEqual(play(name).events, [], name);
  // In a live chat nothing is said before the turn starts either (22 MCP lines, a deprecation notice, a warning).
  const { events } = play('text');
  assert.equal(events[0].kind, 'message-start');
  assert.deepEqual(of(events, 'notice'), []);
});

test('with verbose the set-up notices are shown, once each', { skip: missing }, () => {
  const { events } = play('text', { verbose: true });
  const notices = of(events, 'notice');
  assert.ok(notices.some((n) => n.code === 'codex-config' && /codex_hooks/.test(n.text) && /--enable hooks/.test(n.detail)));
  assert.ok(notices.some((n) => n.code === 'codex-warning' && /^Skill descriptions were shortened/.test(n.text)));
  assert.equal(new Set(notices.map((n) => n.text)).size, notices.length);
});

// ---- codex-text ----

test('text turn: one message-start, the delta, one assistant-text, one successful turn-end', { skip: missing }, () => {
  const { events, adapter } = play('text', { model: () => 'gpt-6-luna' });
  assert.deepEqual(kinds(events).filter((k) => k !== 'hook'), ['message-start', 'text-delta', 'assistant-text', 'turn-end']);
  const threadId = resultOf('text', 'thread/start').thread.id;

  const start = only(events, 'message-start');
  assert.equal(start.model, 'gpt-6-luna');
  assert.equal(typeof start.turnId, 'string');

  const delta = only(events, 'text-delta');
  const text = only(events, 'assistant-text');
  assert.equal(delta.text, 'OK');
  assert.equal(delta.messageId, text.messageId);
  assert.equal(text.text, 'OK');
  assert.equal(text.phase, 'final_answer');
  assert.equal(text.aborted, false);
  assert.equal(text.model, 'gpt-6-luna');
  assert.equal(text.parent, null);
  assert.equal(text.turnId, start.turnId);

  const end = only(events, 'turn-end');
  assert.equal(end.subtype, 'success');
  assert.equal(end.isError, false);
  assert.equal(end.interrupted, false);
  assert.equal(end.text, 'OK');
  assert.equal(end.sessionId, threadId);
  assert.equal(end.turnId, start.turnId);
  assert.equal(end.cost, null);
  assert.equal(end.durationMs, 3163);
  assert.equal(end.turns, 1);
  assert.deepEqual(end.errors, []);
  assert.equal(end.errorCode, null);
  assert.equal(end.contextTokens, 21800);
  assert.equal(end.contextWindow, 258400);
  // OpenAI counts cached and cache-written tokens inside the input; Canopy keeps the three apart.
  assert.deepEqual(end.turnUsage, { inputTokens: 3, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 21792, thinkingTokens: 0, webSearchRequests: 0 });

  const u = adapter.usage();
  assert.equal(u.contextTokens, 21800);
  assert.equal(u.contextWindow, 258400);
  assert.equal(u.total.outputTokens, 5);
});

test('text turn: the three plugin hooks are reported as started and finished, for the session to filter', { skip: missing }, () => {
  const hooks = of(play('text').events, 'hook');
  assert.deepEqual(hooks.map((h) => h.subtype), ['hook_started', 'hook_started', 'hook_started', 'hook_response', 'hook_response', 'hook_response']);
  for (const h of hooks) {
    assert.equal(h.name, 'SessionStart');
    assert.equal(typeof h.id, 'string');
  }
  assert.deepEqual(hooks.slice(3).map((h) => h.outcome), ['completed', 'completed', 'completed']);
  assert.deepEqual(hooks.slice(0, 3).map((h) => h.outcome), [null, null, null]);
});

// ---- commands ----

test('read commands: cat, grep and ls are Read, Grep and Glob rows with what the model typed', { skip: missing }, () => {
  const { events, requests } = play('read-command');
  assert.deepEqual(requests, []);
  assert.deepEqual(folded(events), ['message-start', 'text-delta', 'assistant-text',
    'tool-start', 'tool-result', 'tool-start', 'tool-result', 'tool-start', 'tool-result', 'text-delta', 'assistant-text', 'turn-end']);
  const rows = of(events, 'tool-start');
  assert.deepEqual(rows.map((r) => r.name), ['Read', 'Grep', 'Glob']);
  assert.deepEqual(rows[0].input, { file_path: '/tmp/canopy-codex-rec/work/notes.txt', command: 'cat notes.txt' });
  assert.ok(path.isAbsolute(rows[0].input.file_path));
  assert.deepEqual(rows[1].input, { pattern: 'hello', path: 'notes.txt', command: 'grep -n hello notes.txt' });
  assert.equal(rows[2].input.command, 'ls');
  const results = of(events, 'tool-result');
  assert.deepEqual(results.map((r) => r.id), rows.map((r) => r.id));
  assert.deepEqual(results.map((r) => r.content), ['hello\n', '1:hello\n', 'notes.txt\n']);
  for (const r of results) {
    assert.equal(r.isError, false);
    assert.equal(r.structured.exitCode, 0);
  }
  assert.equal(only(events, 'turn-end').text, 'DONE');
});

test('no row or card in any recording shows the login-shell wrapper', { skip: missing }, () => {
  let rows = 0;
  for (const name of NAMES) {
    const { events, requests } = play(name);
    for (const ev of of(events, 'tool-start')) { rows++; assert.ok(!JSON.stringify(ev.input).includes('zsh -lc'), `${name}: ${JSON.stringify(ev.input)}`); }
    for (const r of requests) assert.ok(!JSON.stringify(r.req.input).includes('zsh -lc'), `${name}: ${JSON.stringify(r.req.input)}`);
  }
  for (const name of ['history', 'resume']) {
    for (const l of lines(name)) {
      const turns = l.dir === 'in' && Array.isArray(l.msg.result?.data) && l.msg.result.data[0]?.items ? l.msg.result.data : null;
      if (!turns) continue;
      for (const ev of of(A.adaptHistory(turns), 'tool-start')) { rows++; assert.ok(!JSON.stringify(ev.input).includes('zsh -lc')); }
    }
  }
  assert.ok(rows >= 12, `only ${rows} rows were checked`);
});

test('command output: the result is what Codex aggregated, and nothing streams unless asked', { skip: missing }, () => {
  const { events } = play('command-output');
  assert.deepEqual(of(events, 'tool-output'), []);
  const row = only(events, 'tool-start');
  assert.equal(row.name, 'Bash');
  assert.deepEqual(row.input, { command: 'for i in 1 2 3; do echo line $i; sleep 0.5; done' });
  const result = only(events, 'tool-result');
  assert.equal(result.id, row.id);
  // The first line really is missing from the recording: Codex lost it, in the deltas and in the total alike.
  assert.equal(result.content, 'line 2\nline 3\n');
  assert.equal(result.isError, false);
  assert.equal(result.fullLength, 14);
  assert.equal(result.truncated, false);

  const live = play('command-output', { toolOutput: true }).events;
  const out = of(live, 'tool-output');
  assert.ok(out.length >= 1);
  assert.equal(out.map((o) => o.text).join(''), 'line 2\nline 3\n');
  for (const o of out) assert.equal(o.id, row.id);
  assert.ok(live.indexOf(out.at(-1)) < live.findIndex((e) => e.kind === 'tool-result'));
});

test('command approval: a Bash card with the bare command and the reason; Deny is the only "no" Codex offered', { skip: missing }, () => {
  const { events, requests } = play('command-approval');
  assert.equal(requests.length, 1);
  const { req, msg, at } = requests[0];
  const row = only(events, 'tool-start');
  // The row is on screen before the card, and its result only after.
  assert.ok(events.indexOf(row) < at);
  assert.ok(events.findIndex((e) => e.kind === 'tool-result') >= at);

  assert.equal(req.rpcId, msg.id);
  assert.equal(req.method, 'item/commandExecution/requestApproval');
  assert.equal(req.type, 'tool');
  assert.equal(req.name, 'Bash');
  assert.equal(req.name, row.name);
  assert.equal(req.input.command, 'touch approved.txt');
  assert.equal(req.input.command, row.input.command);
  assert.equal(req.input.description, 'May I create approved.txt by running the exact command you requested?');
  assert.equal(req.itemId, row.id);
  assert.equal(req.threadId, msg.params.threadId);
  assert.equal(req.turnId, msg.params.turnId);
  assert.equal(req.at, msg.params.startedAtMs);

  const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'approved.txt'] } };
  assert.deepEqual(req.offers, { session: false, rule, decline: false, cancel: true });
  assert.equal(req.base.type, 'tool');
  assert.equal(req.base.toolName, 'Bash');
  assert.deepEqual(req.base.input, req.input);
  assert.equal(req.base.toolUseId, row.id);
  assert.equal(req.base.hasSuggestions, true);
  assert.equal(req.base.engine, 'codex');
  assert.equal(req.base.reason, req.input.description);
  assert.deepEqual(req.base.alwaysPrefix, ['touch', 'approved.txt']);
  assert.ok(!('kind' in req.base) && !('id' in req.base) && !('sessionId' in req.base));
  assert.deepEqual(req.fallback, { decision: 'cancel' });

  assert.deepEqual(A.replyTo(req, { action: 'allow' }), { result: { decision: 'accept' }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'deny' }), { result: { decision: 'cancel' }, stops: true });
  assert.deepEqual(A.replyTo(req, { action: 'deny', stop: true }), { result: { decision: 'cancel' }, stops: true });
  assert.deepEqual(A.replyTo(req, { action: 'always' }), { result: { decision: rule }, stops: false });
  // "For this chat" was not offered, so the rule is the nearest thing.
  assert.deepEqual(A.replyTo(req, { action: 'always', scope: 'session' }), { result: { decision: rule }, stops: false });
  // The answer survives a trip through JSON, as it does on the way to Codex.
  assert.deepEqual(JSON.parse(JSON.stringify(A.replyTo(req, { action: 'always' }).result)), { decision: rule });

  const result = only(events, 'tool-result');
  assert.equal(result.id, row.id);
  assert.equal(result.isError, false);
  assert.equal(result.content, '');
  assert.deepEqual(folded(events), ['message-start', 'text-delta', 'assistant-text', 'tool-start', 'tool-result', 'text-delta', 'assistant-text', 'turn-end']);
  assert.equal(only(events, 'turn-end').turns, 2);
});

// ---- file changes ----

test('file change approval: the card carries the diff, looked up from the item the request names', { skip: missing }, () => {
  const { events, requests } = play('file-change-approval');
  assert.equal(requests.length, 1);
  const { req, msg, at } = requests[0];
  // The request itself has no diff, no path and no list of decisions.
  assert.deepEqual(Object.keys(msg.params).sort(), ['grantRoot', 'itemId', 'reason', 'startedAtMs', 'threadId', 'turnId']);

  const row = only(events, 'tool-start');
  assert.ok(events.indexOf(row) < at);
  assert.equal(row.name, 'Edit');
  assert.deepEqual(row.input, { file_path: '/tmp/canopy-codex-rec/work/notes.txt', old_string: 'hello', new_string: 'goodbye', diff: '@@ -1 +1 @@\n-hello\n+goodbye\n' });

  assert.equal(req.method, 'item/fileChange/requestApproval');
  assert.equal(req.name, 'Edit');
  assert.deepEqual(req.input, row.input);
  assert.equal(req.base.toolUseId, row.id);
  assert.equal(req.base.toolName, 'Edit');
  assert.equal(req.base.hasSuggestions, true);
  assert.deepEqual(req.offers, { session: true, rule: null, decline: true, cancel: true });

  assert.deepEqual(A.replyTo(req, { action: 'allow' }), { result: { decision: 'accept' }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'always' }), { result: { decision: 'acceptForSession' }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'deny' }), { result: { decision: 'decline' }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'deny', stop: true }), { result: { decision: 'cancel' }, stops: true });

  const result = only(events, 'tool-result');
  assert.equal(result.id, row.id);
  assert.equal(result.content, 'File updated');
  assert.equal(result.isError, false);
  assert.deepEqual(result.structured, { status: 'completed', change: 'update', path: '/tmp/canopy-codex-rec/work/notes.txt' });
  assert.equal(only(events, 'turn-end').subtype, 'success');
});

test('without the item (no memory) a file change card still appears, just without its diff', { skip: missing }, () => {
  const msg = incoming('file-change-approval').find(isRequest);
  const req = A.requestOf(msg, null);
  assert.equal(req.name, 'Edit');
  assert.equal(req.input.diff, undefined);
  assert.equal(req.base.toolUseId, msg.params.itemId);
  assert.deepEqual(A.replyTo(req, { action: 'deny' }), { result: { decision: 'decline' }, stops: false });
});

test('declined edit: the row says it was not approved, and the turn still ends well; the summary is thinking', { skip: missing }, () => {
  const { events, requests } = play('decline');
  assert.deepEqual(folded(events), ['message-start', 'thinking-delta', 'thinking', 'tool-start', 'tool-result', 'text-delta', 'assistant-text', 'turn-end']);
  const { req } = requests[0];
  assert.equal(req.input.diff, '@@ -1 +1 @@\n-hello\n+goodbye\n');
  assert.deepEqual(A.replyTo(req, { action: 'deny' }), { result: { decision: 'decline' }, stops: false });

  const row = only(events, 'tool-start');
  const result = only(events, 'tool-result');
  assert.equal(result.id, row.id);
  assert.equal(result.declined, true);
  assert.equal(result.isError, true);
  assert.equal(result.content, 'Not approved, so nothing was changed.');
  assert.equal(result.interrupted, undefined);

  const end = only(events, 'turn-end');
  assert.equal(end.subtype, 'success');
  assert.equal(end.isError, false);
  assert.equal(end.text, 'DECLINED');

  // The streamed summary and the finished one are the same text.
  const thinking = only(events, 'thinking');
  assert.ok(thinking.text.startsWith('**Considering tool usage**'));
  assert.equal(of(events, 'thinking-delta').map((d) => d.text).join(''), thinking.text);
  assert.equal(of(events, 'thinking-delta').length, 83);
});

test('empty reasoning items, which Codex opens on almost every step, say nothing', { skip: missing }, () => {
  for (const name of ['text', 'command-approval', 'read-command', 'command-output', 'plan', 'interrupt']) {
    assert.deepEqual(of(play(name).events, 'thinking'), [], name);
  }
});

// ---- interrupt ----

test('interrupt: the text that was streaming is closed as aborted, then the turn ends as interrupted', { skip: missing }, () => {
  const { events } = play('interrupt');
  assert.deepEqual(folded(events), ['message-start', 'text-delta', 'assistant-text', 'turn-end']);
  // Codex never sent item/completed for the message: the adapter closed it itself.
  assert.ok(!incoming('interrupt').some((m) => m.method === 'item/completed' && m.params.item.type === 'agentMessage'));
  const text = only(events, 'assistant-text');
  assert.equal(text.aborted, true);
  assert.equal(text.text, of(events, 'text-delta').map((d) => d.text).join(''));
  assert.ok(text.text.startsWith('1\n2\n3\n'));
  assert.equal(text.messageId, of(events, 'text-delta')[0].messageId);

  const end = only(events, 'turn-end');
  assert.equal(end.interrupted, true);
  assert.equal(end.subtype, 'interrupted');
  assert.equal(end.isError, false);
  assert.deepEqual(end.errors, []);
  assert.equal(end.text, '');
  // No token usage arrives for a stopped turn.
  assert.equal(end.turnUsage, null);
  assert.equal(end.usage, null);
  assert.equal(end.contextTokens, null);
  assert.equal(end.turns, 0);
  assert.deepEqual(events.at(-1), end);
});

// ---- plan mode ----

test('plan mode: the question Codex asks without waiting is plain reply text, and not the turn\'s answer', { skip: missing }, () => {
  const { events, requests } = play('plan');
  assert.deepEqual(requests, []);
  assert.deepEqual(folded(events), ['message-start', 'text-delta', 'assistant-text', 'tool-start', 'tool-result',
    'assistant-text', 'text-delta', 'assistant-text', 'turn-end']);
  const texts = of(events, 'assistant-text');
  const [narration, question, plan] = texts;
  assert.equal(narration.phase, 'commentary');
  assert.equal(narration.questions, undefined);
  assert.equal(question.text, 'Which word should the new second line say?\n- world\n- there');
  assert.deepEqual(question.questions, [{ question: 'Which word should the new second line say?', options: ['world', 'there'] }]);
  assert.equal(plan.questions, undefined);
  assert.equal(plan.phase, 'final_answer');
  const end = only(events, 'turn-end');
  assert.equal(end.text, plan.text);
  assert.notEqual(end.text, question.text);
  assert.equal(only(events, 'tool-start').name, 'Glob');
});

// ---- history ----

// Every `thread/turns/list` answer in a recording that came with full items.
function recordedTurns(name) {
  const out = [];
  for (const l of lines(name)) {
    const data = l.dir === 'in' && !l.msg.method ? l.msg.result?.data : null;
    if (Array.isArray(data) && data[0]?.itemsView === 'full') out.push(data);
  }
  return out;
}

test('history: each saved chat replays as the prompt, its rows with results, and a turn end, in order', { skip: missing }, () => {
  const chats = recordedTurns('history');
  assert.equal(chats.length, 7);
  const shapes = chats.map((turns) => kinds(A.adaptHistory(turns, { threadId: 'x' })).join(' '));
  assert.deepEqual(shapes, [
    'user-text assistant-text tool-start tool-result assistant-text turn-end',
    'user-text assistant-text tool-start tool-result assistant-text turn-end',
    'user-text thinking tool-start tool-result assistant-text turn-end',
    'user-text turn-end',
    'user-text assistant-text tool-start tool-result tool-start tool-result tool-start tool-result assistant-text turn-end',
    'user-text assistant-text tool-start tool-result assistant-text turn-end',
    'user-text assistant-text tool-start tool-result assistant-text assistant-text turn-end',
  ]);
  for (const turns of chats) {
    const events = A.adaptHistory(turns, { threadId: 'x' });
    assert.deepEqual(errorsIn(events), []);
    const end = events.at(-1);
    assert.equal(end.history, true);
    assert.equal(end.sessionId, 'x');
    assert.equal(end.turnId, turns[0].id);
    for (const start of of(events, 'tool-start')) assert.equal(of(events, 'tool-result').filter((r) => r.id === start.id).length, 1);
    for (const ev of events) if ('at' in ev) assert.equal(typeof ev.at, 'number');
  }
});

test('history says what the live turn said: the same rows, inputs, results and final text', { skip: missing }, () => {
  const live = { 'command-approval': 0, 'file-change-approval': 1, decline: 2, 'read-command': 4, 'command-output': 5, plan: 6 };
  const chats = recordedTurns('history');
  const view = (events) => ({
    rows: of(events, 'tool-start').map((e) => [e.id, e.name, e.input]),
    results: of(events, 'tool-result').map((e) => [e.id, e.content, e.isError, !!e.declined]),
    said: of(events, 'assistant-text').map((e) => [e.text, e.phase, e.questions ?? null]),
    thought: of(events, 'thinking').map((e) => e.text),
    end: of(events, 'turn-end').map((e) => [e.subtype, e.text, e.turnId, e.durationMs]),
  });
  for (const [name, index] of Object.entries(live)) {
    assert.deepEqual(view(A.adaptHistory(chats[index])), view(play(name).events), name);
  }
});

test('history: a stopped turn keeps only the prompt, and ends as interrupted', { skip: missing }, () => {
  const events = A.adaptHistory(recordedTurns('history')[3]);
  assert.deepEqual(kinds(events), ['user-text', 'turn-end']);
  assert.equal(events[0].text, 'Count from 1 to 300, one number per line, and nothing else.');
  assert.equal(events[0].images, 0);
  assert.equal(events[1].interrupted, true);
  assert.equal(events[1].subtype, 'interrupted');
  assert.equal(events[1].durationMs, 1922);
});

test('history: a message steered into a running reply is marked; the one a turn started with never is', { skip: missing }, () => {
  // The shape Codex 0.153.4 saves for a turn that was steered once (probed live): both messages in the one turn.
  const user = (id, text, clientId = null) => ({ type: 'userMessage', id, clientId, content: [{ type: 'text', text }] });
  const said = (id, text) => ({ type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null });
  const turns = [
    { id: '01a1f000-0000-7000-8000-000000000011', status: 'completed', startedAt: 1794862318, completedAt: 1794862320, items: [user('u1', 'Which words?'), said('m1', 'NONE')] },
    { id: '01a1f000-0000-7000-8000-000000000012', status: 'completed', startedAt: 1794862349, completedAt: 1794862356,
      items: [user('u2', 'Count from 1 to 80, one number per line.'), said('m2', '1\n2'), user('u3', 'When the count is done, add the word HELLO.', '99999999-2222-4333-8444-555555555555'), said('m3', '80\nHELLO'), user('u4', 'And BYE.'), said('m4', 'BYE')] },
  ];
  const users = of(A.adaptHistory(turns, { threadId: 'x' }), 'user-text');
  assert.deepEqual(users.map((e) => [e.uuid, e.steered]), [['u1', undefined], ['u2', undefined], ['u3', true], ['u4', true]]);
  assert.ok(!('steered' in users[0]) && !('steered' in users[1]), 'nothing is added to an ordinary message');
  // A first message with nothing to show (no words, no picture) still counts as the turn's first.
  const blank = [{ ...turns[1], items: [user('u2', '   '), user('u3', 'steered in')] }];
  assert.deepEqual(of(A.adaptHistory(blank), 'user-text').map((e) => [e.uuid, e.steered]), [['u3', true]]);
});

test('history: a resumed chat\'s turns, by either supported way of asking, give the same events', { skip: missing }, () => {
  const [full] = recordedTurns('resume');
  const events = A.adaptHistory(full);
  assert.deepEqual(kinds(events), ['user-text', 'assistant-text', 'turn-end']);
  assert.equal(events[0].text, 'Reply with exactly: OK');
  assert.equal(events[1].text, 'OK');
  assert.equal(events[2].text, 'OK');
  // The deprecated resume returns the same turn inside the thread.
  const inline = resultOf('resume', 'thread/resume', 1).thread.turns;
  assert.deepEqual(A.adaptHistory(inline), events);
  // The default (summary) view of the same chat happens to hold the same two items.
  const summary = resultOf('resume', 'thread/turns/list', 0).data;
  assert.equal(summary[0].itemsView, 'summary');
  assert.deepEqual(A.adaptHistory(summary), events);
});

test('history: oldest first and newest first give the same transcript', { skip: missing }, () => {
  const chats = recordedTurns('history');
  const asc = [chats[0][0], chats[3][0], chats[4][0], chats[6][0]];
  assert.ok(asc.every((t, i) => i === 0 || t.startedAt > asc[i - 1].startedAt));
  const events = A.adaptHistory(asc);
  assert.deepEqual(A.adaptHistory([...asc].reverse()), events);
  assert.deepEqual(of(events, 'turn-end').map((e) => e.turnId), asc.map((t) => t.id));
  assert.deepEqual(of(events, 'user-text').map((e) => e.at), asc.map((t) => t.startedAt * 1000));
  // Two turns inside one second: the ids (UUIDv7, so they sort by time) settle the order.
  const close = asc.slice(0, 2).map((t) => ({ ...t, startedAt: 1794801614 }));
  assert.deepEqual(A.adaptHistory([...close].reverse()), A.adaptHistory(close));
  assert.deepEqual(of(A.adaptHistory([...close].reverse()), 'turn-end').map((e) => e.turnId), close.map((t) => t.id));
  // A generator, or one turn, is fine too.
  assert.deepEqual(A.adaptHistory((function* each() { yield* asc; })()), events);
});

test('history: a row that never finished is closed as interrupted before its turn ends; a running one stays open with inFlight', { skip: missing }, () => {
  const user = { type: 'userMessage', id: 'u-1', clientId: null, content: [{ type: 'text', text: 'run it', text_elements: [] }] };
  const stopped = { ...turn('interrupted', { id: 'turn-a', durationMs: 900 }), items: [user, command('exec-a', 'sleep 60')] };
  const events = A.adaptHistory([stopped]);
  assert.deepEqual(kinds(events), ['user-text', 'tool-start', 'tool-result', 'turn-end']);
  assert.equal(events[2].id, 'exec-a');
  assert.equal(events[2].interrupted, true);
  assert.equal(events[2].isError, true);
  assert.equal(events[2].history, true);
  assert.equal(events[3].interrupted, true);

  const running = { ...turn('inProgress', { id: 'turn-b', startedAt: AT / 1000 + 60 }), items: [{ ...user, id: 'u-2' }, command('exec-b', 'npm test')] };
  const open = A.adaptHistory([stopped, running], { inFlight: true });
  assert.deepEqual(kinds(open), ['user-text', 'tool-start', 'tool-result', 'turn-end', 'user-text', 'tool-start']);
  assert.equal(open.at(-1).id, 'exec-b');
  // The same list read later, when nothing is running any more (the app was closed mid-turn).
  const closed = A.adaptHistory([stopped, running]);
  assert.deepEqual(kinds(closed), ['user-text', 'tool-start', 'tool-result', 'turn-end', 'user-text', 'tool-start', 'tool-result']);
  assert.equal(closed.at(-1).id, 'exec-b');
  assert.equal(closed.at(-1).interrupted, true);
  // inFlight protects only the last turn.
  const stale = A.adaptHistory([{ ...running, id: 'turn-0', startedAt: AT / 1000 - 60 }, stopped], { inFlight: true });
  assert.equal(of(stale, 'tool-result').length, 2);
});

test('history: a failed turn has its error notice, then the turn end; prompts with pictures keep a thumbnail', { skip: missing }, () => {
  const user = { type: 'userMessage', id: 'u-1', clientId: null, content: [
    { type: 'text', text: 'what is this?', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,AAAA' }, { type: 'localImage', path: '/tmp/x.png' },
    { type: 'image', url: 'https://example.com/x.png' }, { type: 'image', url: 'data:image/svg+xml;base64,AAAA' },
  ] };
  const failed = { ...turn('failed', { error: { message: 'stream closed', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } }, additionalDetails: null } }), items: [user] };
  const events = A.adaptHistory([failed]);
  assert.deepEqual(kinds(events), ['user-text', 'notice', 'turn-end']);
  assert.equal(events[0].text, 'what is this?');
  assert.equal(events[0].images, 4);
  // Only inline raster data is carried: nothing is fetched, read from disk, or allowed to be SVG.
  assert.deepEqual(events[0].imageData, [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.equal(events[1].history, true);
  assert.equal(events[1].text, 'The connection to OpenAI dropped. Try again.');
  assert.equal(events[2].isError, true);
  assert.equal(events[2].errorCode, 'overloaded');
  assert.equal(events[2].apiStatus, 503);

  const pictureOnly = { ...turn('completed'), items: [{ type: 'userMessage', id: 'u-2', clientId: null, content: [{ type: 'image', url: 'data:image/png;base64,AAAA' }] }] };
  assert.equal(A.adaptHistory([pictureOnly])[0].text, '[image]');
});

test('history: a host can ask for no tool-result images, and one bad item does not lose the rest', { skip: missing }, () => {
  const call = { type: 'mcpToolCall', id: 'mcp-1', server: 'shots', tool: 'take', status: 'completed', arguments: {}, appContext: null, pluginId: null, readOnlyHint: null,
    result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }], structuredContent: null, _meta: null }, error: null, durationMs: 5 };
  const bad = { type: 'commandExecution', get id() { throw new Error('boom'); } };
  const t = { ...turn('completed'), items: [call, bad, message('msg-1', 'done')] };
  const events = A.adaptHistory([t], { images: false });
  assert.deepEqual(kinds(events), ['tool-start', 'tool-result', 'raw', 'assistant-text', 'turn-end']);
  assert.deepEqual(events[1].images, []);
  assert.equal(events[1].imagesOmitted, 1);
  assert.equal(events[2].label, 'adapter-error');
  assert.equal(A.adaptHistory([t], { images: true })[1].images.length, 1);
  assert.equal(A.adaptHistory([t])[1].images.length, 1, 'left to itself, the latest few are kept (the next test)');
});

// A chat is redrawn from its saved turns every time it is switched to: without its pictures, the screenshot of a
// look Codex took while the user was in another chat would never be seen. The same rule as a Claude chat's (adapter.mjs).
test('a saved chat keeps the pictures of its latest few tool results, and the words of the rest', { skip: missing }, () => {
  const shot = (n, size = 8) => ({ type: 'image', mimeType: 'image/png', data: String(n).repeat(size) });
  const look = (id, content) => ({ type: 'mcpToolCall', id, server: 'canopy', tool: 'look', status: 'completed', arguments: { url: 'http://localhost:3000/' }, appContext: null, pluginId: null, readOnlyHint: null,
    result: { content, structuredContent: null, _meta: null }, error: null, durationMs: 5 });
  const turns = [];
  for (let i = 1; i <= 6; i += 2) turns.push({ ...turn('completed'), id: `turn-${i}`, items: [look(`look_${i}`, [shot(i), { type: 'text', text: `caption ${i}` }]), look(`look_${i + 1}`, [shot(i + 1), { type: 'text', text: `caption ${i + 1}` }])] });
  turns.push({ ...turn('completed'), id: 'turn-words', items: [look('words', [{ type: 'text', text: 'no picture here' }]), message('msg-1', 'done')] });
  const results = (events) => Object.fromEntries(events.filter((e) => e.kind === 'tool-result').map((e) => [e.id, e]));

  const got = results(A.adaptHistory(turns));
  assert.deepEqual(Object.keys(got).filter((id) => got[id].images.length), ['look_3', 'look_4', 'look_5', 'look_6'], 'the latest four that have a picture');
  assert.deepEqual(got.look_6.images, [{ mediaType: 'image/png', data: '66666666' }]);
  assert.equal(got.look_6.content, '[image]\ncaption 6');
  assert.deepEqual([got.look_1.images, got.look_1.imagesOmitted, got.look_1.content], [[], 1, '[image]\ncaption 1'], 'an older one keeps its caption');
  assert.equal(A.adaptHistory(turns).find((e) => e.kind === 'tool-start').name, 'mcp__canopy_look__look', 'named as the window draws a look');
  // Codex hands the newest turn first; the latest are still the latest.
  const reversed = results(A.adaptHistory(turns.map((t, i) => ({ ...t, startedAt: 1794801559 + i })).reverse()));
  assert.deepEqual(Object.keys(reversed).filter((id) => reversed[id].images.length).sort(), ['look_3', 'look_4', 'look_5', 'look_6']);
  // A host that wants none, or all of them, says so.
  assert.ok(Object.values(results(A.adaptHistory(turns, { images: false }))).every((e) => e.images.length === 0));
  assert.equal(Object.values(results(A.adaptHistory(turns, { images: true }))).filter((e) => e.images.length).length, 6);
  // Heavy pictures: the latest that fit together in about 5 MB, never more.
  const heavy = [{ ...turn('completed'), items: [look('h1', [shot(1, 3_000_000)]), look('h2', [shot(2, 1_500_000)]), look('h3', [shot(3, 1_500_000)])] }];
  const kept = results(A.adaptHistory(heavy));
  assert.deepEqual(Object.keys(kept).filter((id) => kept[id].images.length), ['h2', 'h3']);
});

test('adaptHistory never throws, whatever it is given', { skip: missing }, () => {
  for (const junk of [undefined, null, 0, 'text', {}, [null, 7, 'x', [], {}], [{ items: 'no' }], [{ status: 'completed', items: [null, 3, {}, { type: 'agentMessage' }] }], [{ status: 'failed' }]]) {
    let out;
    assert.doesNotThrow(() => { out = A.adaptHistory(junk); });
    assert.ok(Array.isArray(out));
    assert.deepEqual(errorsIn(out), [], JSON.stringify(junk));
  }
});

// ---- opening a chat ----

test('initEvent: a thread/start or thread/resume result becomes an init event in Claude\'s shape, plus Codex\'s own fields', { skip: missing }, () => {
  const ev = A.initEvent(resultOf('text', 'thread/start'), { permissionMode: 'default' });
  assert.equal(ev.kind, 'init');
  assert.equal(ev.engine, 'codex');
  assert.equal(ev.sessionId, '00000000-0000-7000-8000-432d1c714b94');
  assert.equal(ev.model, 'gpt-6-luna');
  assert.equal(ev.cwd, '/tmp/canopy-codex-rec/work');
  assert.equal(ev.permissionMode, 'default');
  assert.equal(ev.version, '0.153.4');
  assert.equal(ev.effort, 'high');
  assert.equal(ev.serviceTier, 'default');
  assert.equal(ev.fastState, 'off');
  assert.equal(ev.approvalPolicy, 'on-request');
  assert.equal(ev.sandbox, 'readOnly');
  assert.equal(ev.reviewer, 'user');
  assert.equal(ev.name, null);
  assert.equal(ev.createdAt, 1794801559000);
  for (const key of ['mcp', 'plugins', 'slash', 'skills', 'tools', 'agents', 'capabilities', 'terminalCommands', 'pluginErrors', 'userUuids']) assert.deepEqual(ev[key], [], key);

  const resumed = A.initEvent(resultOf('resume', 'thread/resume'));
  assert.equal(resumed.sessionId, ev.sessionId);
  assert.equal(resumed.name, 'Canopy fixture chat');
  assert.equal(resumed.permissionMode, null);

  // Ask, Accept edits, Auto, Full access, as Codex reported each one back.
  const modes = [0, 1, 2, 3].map((n) => A.initEvent(resultOf('modes', 'thread/start', n)));
  assert.deepEqual(modes.map((m) => [m.approvalPolicy, m.sandbox, m.reviewer]), [
    ['on-request', 'readOnly', 'user'], ['on-request', 'workspaceWrite', 'user'], ['on-request', 'workspaceWrite', 'auto_review'], ['never', 'dangerFullAccess', 'user'],
  ]);
  assert.equal(A.initEvent({ serviceTier: 'priority' }).fastState, 'on');
  assert.equal(A.initEvent({}).fastState, null);
  for (const junk of [undefined, null, 5, 'x', [], { thread: 7 }]) {
    let out;
    assert.doesNotThrow(() => { out = A.initEvent(junk, junk); });
    assert.equal(out.kind, 'init');
    assert.equal(out.sessionId, null);
  }
});

// ---- by hand: commands ----

test('a command row shows what the model typed, however Codex wrapped it', { skip: missing }, () => {
  const shown = (item) => {
    const [ev] = chat().feed(started(item));
    return [ev.name, ev.input.command];
  };
  const bare = (cmd, actions = []) => shown({ ...command('c', 'x'), command: cmd, commandActions: actions });
  assert.deepEqual(bare(`/bin/zsh -lc 'echo '\\''hi'\\'''`), ['Bash', "echo 'hi'"]);
  assert.deepEqual(bare('bash -c "echo \\"a b\\" $HOME"'), ['Bash', 'echo "a b" $HOME']);
  assert.deepEqual(bare('/usr/bin/env FOO=1 make'), ['Bash', '/usr/bin/env FOO=1 make']);
  assert.deepEqual(bare('git status'), ['Bash', 'git status']);
  // Not a simple wrapper after all (more than one word follows): shown as it is.
  assert.deepEqual(bare('/bin/zsh -lc ls -la'), ['Bash', '/bin/zsh -lc ls -la']);
  assert.deepEqual(bare("/bin/zsh -lc 'unterminated"), ['Bash', "/bin/zsh -lc 'unterminated"]);
  // Two actions in one command line is a command, not a read.
  assert.deepEqual(bare("/bin/zsh -lc 'cat a.txt && cat b.txt'", [{ type: 'read', command: 'cat a.txt', name: 'a.txt', path: '/w/a.txt' }, { type: 'read', command: 'cat b.txt', name: 'b.txt', path: '/w/b.txt' }]),
    ['Bash', 'cat a.txt && cat b.txt']);
  // A read with no path cannot be a Read row.
  assert.deepEqual(bare("/bin/zsh -lc 'cat'", [{ type: 'read', command: 'cat', name: '', path: '' }]), ['Bash', 'cat']);
  assert.deepEqual(bare(undefined, undefined), ['Bash', '']);

  const [grep] = chat().feed(started({ ...command('c', 'rg TODO'), commandActions: [{ type: 'search', command: 'rg TODO', query: null, path: null }] }));
  assert.deepEqual([grep.name, grep.input], ['Grep', { pattern: 'rg TODO', command: 'rg TODO' }]);
  const [ls] = chat().feed(started({ ...command('c', 'ls src'), commandActions: [{ type: 'listFiles', command: 'ls src', path: 'src' }] }));
  assert.deepEqual([ls.name, ls.input], ['Glob', { pattern: 'src', path: 'src', command: 'ls src' }]);
});

test('a command\'s result: output with colour codes removed, failures marked, quiet failures explained', { skip: missing }, () => {
  const result = (extra) => {
    const c = chat();
    c.feed(started(command('c-1', 'make')));
    return only(c.feed(completed({ ...command('c-1', 'make'), ...extra })), 'tool-result');
  };
  const ok = result({ status: 'completed', exitCode: 0, durationMs: 40, aggregatedOutput: '\x1b[32mbuilt\x1b[0m \x1b]0;title\x07fine\n' });
  assert.equal(ok.content, 'built fine\n');
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.structured, { status: 'completed', exitCode: 0, durationMs: 40 });
  assert.equal(ok.uuid, 'c-1');
  assert.equal(ok.at, AT + 50);

  const failed = result({ status: 'failed', exitCode: 2, aggregatedOutput: 'make: *** No rule\n' });
  assert.equal(failed.isError, true);
  assert.equal(failed.content, 'make: *** No rule\n');
  assert.equal(result({ status: 'failed', exitCode: 2 }).content, 'Exit code 2');
  assert.equal(result({ status: 'failed' }).content, 'The command failed.');
  assert.equal(result({ status: 'completed', exitCode: 1 }).isError, true);

  const declined = result({ status: 'declined' });
  assert.equal(declined.declined, true);
  assert.equal(declined.isError, true);
  assert.equal(declined.content, 'Not approved, so it did not run.');
});

test('a streamed command whose total comes back empty keeps what streamed', { skip: missing }, () => {
  const c = chat();
  c.feed(started(command('c-1', 'tail -f log')));
  assert.deepEqual(c.feed(note('item/commandExecution/outputDelta', { itemId: 'c-1', delta: 'one\n' }), note('item/commandExecution/outputDelta', { itemId: 'c-1', delta: '\x1b[1mtwo\x1b[0m\n' })), []);
  const r = only(c.feed(completed(done(command('c-1', 'tail -f log')))), 'tool-result');
  assert.equal(r.content, 'one\ntwo\n');
});

test('tool-output, when asked for, is throttled and never loses the tail', { skip: missing }, () => {
  let now = 1000;
  const c = chat({ toolOutput: true, now: () => now });
  c.feed(started(command('c-1', 'yes')));
  const delta = (text) => c.feed(note('item/commandExecution/outputDelta', { itemId: 'c-1', delta: text }));
  assert.deepEqual(delta('a'), [{ kind: 'tool-output', id: 'c-1', text: 'a' }]);
  now += 10;
  assert.deepEqual(delta('b'), []);
  now += 10;
  assert.deepEqual(delta('c'), []);
  now += 200;
  assert.deepEqual(delta('d'), [{ kind: 'tool-output', id: 'c-1', text: 'bcd' }]);
  now += 1;
  assert.deepEqual(delta('e'), []);
  const end = c.feed(completed(done(command('c-1', 'yes'), { aggregatedOutput: 'abcde' })));
  assert.deepEqual(kinds(end), ['tool-output', 'tool-result']);
  assert.equal(end[0].text, 'e');
  assert.equal(end[1].content, 'abcde');
});

test('Auto mode: the reviewer\'s reason for saying no is added to the row it blocked', { skip: missing }, () => {
  const c = chat();
  c.feed(started(command('c-1', 'rm -rf build')));
  assert.deepEqual(c.feed(note('item/autoApprovalReview/completed', { targetItemId: 'c-1', reviewId: 'r-1', decisionSource: 'agent', action: {},
    review: { status: 'denied', riskLevel: 'high', userAuthorization: null, rationale: 'It deletes files outside the task.' } })), []);
  const r = only(c.feed(completed({ ...command('c-1', 'rm -rf build'), status: 'declined' })), 'tool-result');
  assert.equal(r.content, 'Not approved, so it did not run. The automatic review said: It deletes files outside the task.');
  // An approval says nothing extra.
  c.feed(started(command('c-2', 'ls')), note('item/autoApprovalReview/completed', { targetItemId: 'c-2', review: { status: 'approved', rationale: 'Harmless.' } }));
  assert.equal(only(c.feed(completed(done(command('c-2', 'ls'), { aggregatedOutput: 'a\n' }))), 'tool-result').content, 'a\n');
});

// ---- by hand: file changes ----

test('a change to several files is one row per file: Edit, Write for a new file, Edit marked deleted', { skip: missing }, () => {
  const changes = [
    update('/w/a.txt', '@@ -1,2 +1,2 @@\n one\n-two\n+2\n@@ -9 +9 @@\n-nine\n+9\n'),
    { path: '/w/new.txt', kind: { type: 'add' }, diff: 'hello\nworld\n' },
    { path: '/w/old.txt', kind: { type: 'delete' }, diff: 'bye\n' },
    update('/w/b.txt', '@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file\n', '/w/c.txt'),
  ];
  const c = chat();
  const rows = c.feed(started(patch('fc-1', changes)));
  assert.deepEqual(kinds(rows), ['tool-start', 'tool-start', 'tool-start', 'tool-start']);
  assert.deepEqual(rows.map((r) => r.id), ['fc-1', 'fc-1#1', 'fc-1#2', 'fc-1#3']);
  assert.deepEqual(rows.map((r) => r.name), ['Edit', 'Write', 'Edit', 'Edit']);
  assert.deepEqual(rows[0].input, { file_path: '/w/a.txt', old_string: 'one\ntwo\nnine', new_string: 'one\n2\n9', diff: changes[0].diff });
  assert.deepEqual(rows[1].input, { file_path: '/w/new.txt', content: 'hello\nworld\n' });
  assert.deepEqual(rows[2].input, { file_path: '/w/old.txt', old_string: 'bye\n', new_string: '', deleted: true });
  assert.deepEqual(rows[3].input, { file_path: '/w/b.txt', old_string: 'x', new_string: 'y', diff: changes[3].diff, moved_to: '/w/c.txt' });

  // One answer covers the whole change, so its card is given every file: what would happen to each, and the row
  // each belongs to. It still names the first file, for anything that reads only that.
  const req = c.adapter.request(ask('item/fileChange/requestApproval', { itemId: 'fc-1', reason: 'Outside the project', grantRoot: '/w' }));
  assert.equal(req.base.title, 'Change 4 files?');
  assert.equal(req.base.changeCount, 4);
  assert.deepEqual(req.base.toolUseIds, ['fc-1', 'fc-1#1', 'fc-1#2', 'fc-1#3'], 'every row of the change waits on this one answer');
  assert.deepEqual(req.base.changes.map((r) => [r.id, r.name, r.input.file_path, r.input.deleted === true]), [
    ['fc-1', 'Edit', '/w/a.txt', false], ['fc-1#1', 'Write', '/w/new.txt', false], ['fc-1#2', 'Edit', '/w/old.txt', true], ['fc-1#3', 'Edit', '/w/b.txt', false],
  ]);
  assert.deepEqual(req.base.changes.map((r) => r.input), rows.map((r) => r.input), 'each with the same diff its row shows');
  assert.equal(req.name, 'Edit');
  assert.equal(req.input.file_path, '/w/a.txt');
  assert.equal(req.input.diff, changes[0].diff);
  assert.deepEqual(req.input.files, ['/w/a.txt', '/w/new.txt', '/w/old.txt', '/w/b.txt']);
  assert.equal(req.base.description, 'And 3 more files.');
  assert.equal(req.base.reason, 'Outside the project');
  assert.equal(req.base.blockedPath, '/w');
  assert.equal(req.base.toolUseId, 'fc-1');

  const results = c.feed(completed(patch('fc-1', changes, 'completed')));
  assert.deepEqual(kinds(results), ['tool-result', 'tool-result', 'tool-result', 'tool-result']);
  assert.deepEqual(results.map((r) => r.id), ['fc-1', 'fc-1#1', 'fc-1#2', 'fc-1#3']);
  assert.deepEqual(results.map((r) => r.content), ['File updated', 'File created', 'File deleted', 'File updated']);
});

test('a one-file change keeps its plain card, and a very large change shows its first files and counts them all', { skip: missing }, () => {
  const one = chat();
  one.feed(started(patch('fc-1', [update('/w/a.txt', '@@ -1 +1 @@\n-a\n+b\n')])));
  const single = one.adapter.request(ask('item/fileChange/requestApproval', { itemId: 'fc-1' }));
  for (const key of ['changes', 'changeCount', 'toolUseIds']) assert.ok(!(key in single.base), `${key} is only on a card for several files`);
  assert.equal(single.base.title, null);

  const many = chat();
  many.feed(started(patch('fc-2', Array.from({ length: 55 }, (_, i) => update(`/w/f${i}.txt`, '@@ -1 +1 @@\n-a\n+b\n')))));
  const big = many.adapter.request(ask('item/fileChange/requestApproval', { itemId: 'fc-2' }));
  assert.equal(big.base.title, 'Change 55 files?');
  assert.deepEqual([big.base.changes.length, big.base.changeCount, big.base.toolUseIds.length], [40, 55, 55]);
});

test('a new or removed file that arrives as a diff is read as one', { skip: missing }, () => {
  const [add, del] = chat().feed(started(patch('fc-1', [
    { path: '/w/new.txt', kind: { type: 'add' }, diff: '@@ -0,0 +1,2 @@\n+hello\n+world\n' },
    { path: '/w/old.txt', kind: { type: 'delete' }, diff: '--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n' },
  ])));
  assert.deepEqual(add.input, { file_path: '/w/new.txt', content: 'hello\nworld' });
  assert.deepEqual(del.input, { file_path: '/w/old.txt', old_string: 'bye', new_string: '', deleted: true });
});

test('a change that could not be made says so, with apply_patch\'s own words when it gave any', { skip: missing }, () => {
  const c = chat();
  const changes = [update('/w/a.txt', '@@ -1 +1 @@\n-a\n+b\n')];
  c.feed(started(patch('fc-1', changes)));
  assert.deepEqual(c.feed(note('item/fileChange/outputDelta', { itemId: 'fc-1', delta: 'context did not match' })), []);
  const r = only(c.feed(completed(patch('fc-1', changes, 'failed'))), 'tool-result');
  assert.equal(r.isError, true);
  assert.equal(r.content, 'This change could not be made.\ncontext did not match');
});

test('a change first seen when it finishes (its start had no files yet) still gets its rows', { skip: missing }, () => {
  const c = chat();
  assert.deepEqual(c.feed(started(patch('fc-1', []))), []);
  const out = c.feed(completed(patch('fc-1', [update('/w/a.txt', '@@ -1 +1 @@\n-a\n+b\n')], 'completed')));
  assert.deepEqual(kinds(out), ['tool-start', 'tool-result']);
  assert.equal(out[0].id, out[1].id);
});

test('a row that was opened is never left without a result', { skip: missing }, () => {
  // The finished item lists fewer files than the started one did.
  const c = chat();
  const two = [update('/w/a.txt', '@@ -1 +1 @@\n-a\n+b\n'), update('/w/b.txt', '@@ -1 +1 @@\n-a\n+b\n')];
  c.feed(turnStarted(), started(patch('fc-1', two)));
  const out = c.feed(completed(patch('fc-1', two.slice(0, 1), 'completed')));
  assert.deepEqual(out.map((e) => [e.kind, e.id, !!e.interrupted]), [['tool-result', 'fc-1', false], ['tool-result', 'fc-1#1', true]]);
  assert.deepEqual(kinds(c.feed(turnCompleted())), ['turn-end']);

  // "Completed" while still marked as running: the row waits for the turn's end.
  const d = chat();
  d.feed(turnStarted(), started(command('c-1', 'sleep 5')));
  assert.deepEqual(d.feed(completed(command('c-1', 'sleep 5'))), []);
  const end = d.feed(turnCompleted());
  assert.deepEqual(kinds(end), ['tool-result', 'turn-end']);
  assert.equal(end[0].id, 'c-1');
  assert.equal(end[0].interrupted, true);
});

// ---- by hand: other tools ----

test('MCP tool call: a row named mcp__server__tool, with text, pictures and structured content in its result', { skip: missing }, () => {
  const call = (extra = {}) => ({ type: 'mcpToolCall', id: 'mcp-1', server: 'github', tool: 'list_issues', status: 'inProgress', arguments: { state: 'open' },
    appContext: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null, ...extra });
  const c = chat();
  const [start] = c.feed(started(call()));
  assert.equal(start.kind, 'tool-start');
  assert.equal(start.name, 'mcp__github__list_issues');
  assert.deepEqual(start.input, { state: 'open' });
  assert.deepEqual(c.feed(note('item/mcpToolCall/progress', { itemId: 'mcp-1', message: 'working' })), []);
  const content = [
    { type: 'text', text: '3 issues' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' },
    { type: 'resource', resource: { uri: 'file:///a', text: 'inline text' } }, { type: 'resource_link', name: 'Spec', uri: 'https://example.com/spec' }, { type: 'audio', data: 'AAAA' },
    { type: 'hologram' }, 'bare string', null, 7,
  ];
  const r = only(c.feed(completed(call({ status: 'completed', durationMs: 80, result: { content, structuredContent: { count: 3 }, _meta: null } }))), 'tool-result');
  assert.equal(r.id, 'mcp-1');
  assert.equal(r.isError, false);
  assert.equal(r.content, '3 issues\n[image]\n[image]\ninline text\nSpec\nhttps://example.com/spec\n[audio]\n[hologram]\nbare string\n7');
  assert.deepEqual(r.images, [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.equal(r.imagesOmitted, 1);
  assert.deepEqual(r.structured, { count: 3 });
  assert.deepEqual(c.unknown, []);

  const failed = chat();
  failed.feed(started(call()));
  const err = only(failed.feed(completed(call({ status: 'failed', error: { message: 'not logged in' } }))), 'tool-result');
  assert.equal(err.isError, true);
  assert.equal(err.content, 'not logged in');
  assert.equal(only(chat({ images: false }).feed(completed(call({ status: 'completed', result: { content, structuredContent: null, _meta: null } }))), 'tool-result').images.length, 0);
});

test('a tool the client offered (dynamic tool call) is a row too', { skip: missing }, () => {
  const call = (extra = {}) => ({ type: 'dynamicToolCall', id: 'dyn-1', namespace: 'canopy', tool: 'run', arguments: 'plain text', status: 'inProgress', contentItems: null, success: null, durationMs: null, ...extra });
  const c = chat();
  const [start] = c.feed(started(call()));
  assert.equal(start.name, 'mcp__canopy__run');
  assert.deepEqual(start.input, { value: 'plain text' });
  const r = only(c.feed(completed(call({ status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'ok' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' }, { type: 'inputImage', imageUrl: 'https://example.com/a.png' }] }))), 'tool-result');
  assert.equal(r.content, 'ok\n[image]\n[image]');
  assert.equal(r.images.length, 1);
  assert.equal(r.imagesOmitted, 1);
  const bad = only(chat().feed(completed(call({ status: 'failed', success: false, contentItems: [] }))), 'tool-result');
  assert.equal(bad.isError, true);
  assert.equal(bad.content, 'The tool call failed.');
  assert.equal(chat().feed(started(call({ namespace: null })))[0].name, 'run');
});

test('web search: the row appears, complete, when the search finishes; opening a page is WebFetch', { skip: missing }, () => {
  const search = (action) => ({ type: 'webSearch', id: 'ws-1', query: 'canopy mac app', action, results: null });
  const c = chat();
  assert.deepEqual(c.feed(started(search(null))), []);
  const out = c.feed(completed(search({ type: 'search', query: 'canopy mac app', queries: ['canopy mac app', 'canopy electron'] })));
  assert.deepEqual(kinds(out), ['tool-start', 'tool-result']);
  assert.equal(out[0].name, 'WebSearch');
  assert.deepEqual(out[0].input, { query: 'canopy mac app', queries: ['canopy mac app', 'canopy electron'] });
  assert.equal(out[1].id, 'ws-1');
  assert.equal(out[1].isError, false);
  assert.equal(out[1].content, 'canopy mac app\ncanopy electron');

  const page = chat().feed(completed({ ...search({ type: 'openPage', url: 'https://example.com/docs' }), id: 'ws-2' }));
  assert.deepEqual([page[0].name, page[0].input], ['WebFetch', { url: 'https://example.com/docs' }]);
  const find = chat().feed(completed({ ...search({ type: 'findInPage', url: 'https://example.com/docs', pattern: 'install' }), id: 'ws-3' }));
  assert.deepEqual(find[0].input, { url: 'https://example.com/docs', prompt: 'install' });
  // With no memory the row is still whole, because it never depended on a start.
  assert.deepEqual(kinds(A.adapt(completed(search({ type: 'other' })))), ['tool-start', 'tool-result']);
  // A search that never finished leaves nothing behind.
  const stopped = chat();
  stopped.feed(turnStarted(), started(search(null)));
  assert.deepEqual(kinds(stopped.feed(turnCompleted('interrupted'))), ['turn-end']);
});

test('pictures and agents: imageView is a Read row, a generated image a row with the picture, handing an agent work an Agent row', { skip: missing }, () => {
  const view = chat().feed(started({ type: 'imageView', id: 'iv-1', path: '/w/shot.png' }), completed({ type: 'imageView', id: 'iv-1', path: '/w/shot.png' }));
  assert.deepEqual(view.map((e) => [e.kind, e.name ?? e.content]), [['tool-start', 'Read'], ['tool-result', '[image]']]);
  assert.deepEqual(view[0].input, { file_path: '/w/shot.png', image: true });

  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
  const made = chat().feed(started({ type: 'imageGeneration', id: 'ig-1', status: 'inProgress', revisedPrompt: null, result: '', failure: null }),
    completed({ type: 'imageGeneration', id: 'ig-1', status: 'completed', revisedPrompt: 'a quiet forest', result: data, failure: null, savedPath: '/w/forest.png' }));
  assert.deepEqual(kinds(made), ['tool-start', 'tool-result']);
  assert.deepEqual(made[0].input, { prompt: 'a quiet forest' });
  assert.equal(made[1].content, 'Saved to /w/forest.png');
  assert.deepEqual(made[1].images, [{ mediaType: 'image/png', data }]);

  const agent = (tool, extra = {}) => ({ type: 'collabAgentToolCall', id: `ag-${tool}`, tool, status: 'inProgress', senderThreadId: T, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {}, ...extra });
  const c = chat();
  const [spawn] = c.feed(started(agent('spawnAgent', { prompt: 'Find the flaky test', model: 'gpt-6-luna' })));
  assert.deepEqual([spawn.name, spawn.input], ['Agent', { description: 'Start an agent', prompt: 'Find the flaky test', model: 'gpt-6-luna' }]);
  assert.equal(only(c.feed(completed(agent('spawnAgent', { prompt: 'Find the flaky test', status: 'completed' }))), 'tool-result').isError, false);
  // Waiting on, listing and closing agents say nothing.
  assert.deepEqual(c.feed(started(agent('wait')), completed(agent('wait', { status: 'completed' })), started(agent('closeAgent'))), []);
  assert.deepEqual(c.feed(started({ type: 'subAgentActivity', id: 's-1', kind: 'started', agentThreadId: 'x', agentPath: 'a' }), started({ type: 'sleep', id: 'sl-1', durationMs: 5 }),
    completed({ type: 'hookPrompt', id: 'hp-1', fragments: [] })), []);
  assert.deepEqual(c.unknown, []);
});

// ---- by hand: text, thinking, plans ----

test('text streams as deltas and closes as one assistant-text; the model comes from the chat', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted(), note('thread/settings/updated', { threadSettings: { model: 'gpt-6.1-sol', effort: 'low' } }));
  assert.deepEqual(c.feed(started(message('msg-1', '', { phase: 'commentary' }))), []);
  assert.deepEqual(c.feed(note('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hel' }), note('item/agentMessage/delta', { itemId: 'msg-1', delta: 'lo' }), note('item/agentMessage/delta', { itemId: 'msg-1', delta: '' })),
    [{ kind: 'text-delta', text: 'Hel', index: 0, messageId: 'msg-1' }, { kind: 'text-delta', text: 'lo', index: 0, messageId: 'msg-1' }]);
  const text = only(c.feed(completed(message('msg-1', 'Hello', { phase: 'commentary' }))), 'assistant-text');
  assert.equal(text.text, 'Hello');
  assert.equal(text.phase, 'commentary');
  // What Codex echoed as the chat's model is used until the session names one.
  assert.equal(text.model, 'gpt-6.1-sol');
  assert.equal(text.at, AT + 50);
  assert.equal(only(chat({ model: 'chosen' }).feed(completed(message('m', 'x'))), 'assistant-text').model, 'chosen');
  assert.equal(only(chat({ model: () => { throw new Error('no'); } }).feed(completed(message('m', 'x'))), 'assistant-text').model, null);
  assert.equal(only(c.adapter.adapt(completed(message('m', 'x')), { model: 'per call' }), 'assistant-text').model, 'per call');
  // An empty message is nothing; one whose text only ever streamed is still whole.
  assert.deepEqual(c.feed(completed(message('msg-2', '  '))), []);
  c.feed(note('item/agentMessage/delta', { itemId: 'msg-3', delta: 'streamed only' }));
  assert.equal(only(c.feed(completed(message('msg-3', ''))), 'assistant-text').text, 'streamed only');
  // The user's own message is echoed back by Codex; the window already drew it.
  const user = { type: 'userMessage', id: 'u-1', clientId: null, content: [{ type: 'text', text: 'hi', text_elements: [] }] };
  assert.deepEqual(c.feed(started(user), completed(user)), []);
});

test('reasoning: summary parts become paragraphs; raw reasoning is shown only when there is no summary', { skip: missing }, () => {
  const c = chat();
  const item = (summary = [], content = []) => ({ type: 'reasoning', id: 'rs-1', summary, content });
  c.feed(started(item()));
  const out = c.feed(
    note('item/reasoning/summaryPartAdded', { itemId: 'rs-1', summaryIndex: 0 }),
    note('item/reasoning/summaryTextDelta', { itemId: 'rs-1', delta: 'First.', summaryIndex: 0 }),
    note('item/reasoning/textDelta', { itemId: 'rs-1', delta: 'raw, not for reading', contentIndex: 0 }),
    note('item/reasoning/summaryPartAdded', { itemId: 'rs-1', summaryIndex: 1 }),
    note('item/reasoning/summaryTextDelta', { itemId: 'rs-1', delta: 'Second.', summaryIndex: 1 }),
  );
  assert.deepEqual(out.map((e) => [e.kind, e.text, e.index]), [['thinking-delta', 'First.', 0], ['thinking-delta', '\n\n', 1], ['thinking-delta', 'Second.', 1]]);
  const thinking = only(c.feed(completed(item(['First.', 'Second.']))), 'thinking');
  assert.equal(thinking.text, 'First.\n\nSecond.');
  assert.equal(thinking.text, out.map((e) => e.text).join(''));

  const raw = chat();
  assert.deepEqual(kinds(raw.feed(note('item/reasoning/textDelta', { itemId: 'rs-2', delta: 'thinking aloud', contentIndex: 0 }))), ['thinking-delta']);
  assert.equal(only(raw.feed(completed({ ...item([], ['thinking aloud']), id: 'rs-2' })), 'thinking').text, 'thinking aloud');
  assert.deepEqual(raw.feed(started({ ...item(), id: 'rs-3' }), completed({ ...item(), id: 'rs-3' })), []);
});

test('the to-do list is a TodoWrite row, and the same list twice is one row', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted());
  const plan = (steps, explanation = null) => note('turn/plan/updated', { explanation, plan: steps });
  const first = c.feed(plan([{ step: 'Count slowly', status: 'inProgress' }, { step: 'Report back', status: 'pending' }], 'Starting'));
  assert.deepEqual(kinds(first), ['tool-start', 'tool-result']);
  assert.equal(first[0].name, 'TodoWrite');
  assert.deepEqual(first[0].input, { explanation: 'Starting', todos: [
    { content: 'Count slowly', status: 'in_progress', activeForm: 'Count slowly' }, { content: 'Report back', status: 'pending', activeForm: 'Report back' },
  ] });
  assert.equal(first[1].id, first[0].id);
  assert.equal(first[1].isError, false);
  assert.deepEqual(c.feed(plan([{ step: 'Count slowly', status: 'inProgress' }, { step: 'Report back', status: 'pending' }], 'Starting')), []);
  const second = c.feed(plan([{ step: 'Count slowly', status: 'completed' }, { step: 'Report back', status: 'completed' }]));
  assert.deepEqual(kinds(second), ['tool-start', 'tool-result']);
  assert.notEqual(second[0].id, first[0].id);
  assert.deepEqual(second[0].input.todos.map((t) => t.status), ['completed', 'completed']);
  assert.deepEqual(c.feed(plan([])), []);
  assert.deepEqual(c.feed(plan('nonsense')), []);
  // A new turn may show the same list again.
  c.feed(turnCompleted(), turnStarted('turn-2'));
  assert.equal(c.feed(plan([{ step: 'Count slowly', status: 'completed' }, { step: 'Report back', status: 'completed' }])).length, 2);
});

test('a plan item streams and closes as reply text marked as a plan', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted(), started({ type: 'plan', id: 'plan-1', text: '' }));
  assert.deepEqual(kinds(c.feed(note('item/plan/delta', { itemId: 'plan-1', delta: '1. Add the line' }))), ['text-delta']);
  const text = only(c.feed(completed({ type: 'plan', id: 'plan-1', text: '1. Add the line\n2. Check it' })), 'assistant-text');
  assert.equal(text.plan, true);
  assert.equal(text.text, '1. Add the line\n2. Check it');
  assert.equal(only(c.feed(turnCompleted()), 'turn-end').text, text.text);
});

// ---- by hand: compaction, notices, failures ----

test('compaction: "summarizing" while it runs, then cleared, with one notice per turn however Codex reports it', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted());
  assert.deepEqual(c.feed(started({ type: 'contextCompaction', id: 'cc-1' })), [{ kind: 'status', status: 'compacting' }]);
  const out = c.feed(completed({ type: 'contextCompaction', id: 'cc-1' }));
  assert.deepEqual(out, [{ kind: 'status', status: null }, { kind: 'notice', text: 'Conversation compacted', code: 'compacted', at: AT + 50 }]);
  // The older line for the same compaction adds nothing.
  assert.deepEqual(c.feed(note('thread/compacted')), []);
  c.feed(turnCompleted(), turnStarted('turn-2'));
  assert.deepEqual(kinds(c.feed(note('thread/compacted', { turnId: 'turn-2' }))), ['status', 'notice']);
  assert.deepEqual(c.feed(note('item/completed', { turnId: 'turn-2', item: { type: 'contextCompaction', id: 'cc-2' } })), []);

  const saved = A.adaptHistory([{ ...turn('completed'), items: [{ type: 'contextCompaction', id: 'cc-1' }, { type: 'contextCompaction', id: 'cc-9' }, message('m', 'ok')] }]);
  assert.deepEqual(kinds(saved), ['notice', 'assistant-text', 'turn-end']);
  assert.equal(saved[0].history, true);
  assert.equal(saved[0].text, 'Conversation compacted');
});

test('a failed turn: one notice in plain words, then a turn-end that carries the error', { skip: missing }, () => {
  const error = { message: 'upstream said no', codexErrorInfo: 'serverOverloaded', additionalDetails: 'request id 123', misalignment: null };
  const c = chat();
  c.feed(turnStarted());
  const out = c.feed(turnCompleted('failed', { error }));
  assert.deepEqual(kinds(out), ['notice', 'turn-end']);
  assert.equal(out[0].code, 'api-error');
  assert.equal(out[0].level, 'warn');
  assert.equal(out[0].text, 'OpenAI is overloaded right now.');
  assert.equal(out[0].detail, 'request id 123');
  assert.equal(out[0].apiError, 'serverOverloaded');
  assert.equal(out[1].isError, true);
  assert.equal(out[1].subtype, 'error');
  assert.equal(out[1].interrupted, false);
  assert.equal(out[1].errorCode, 'overloaded');
  assert.deepEqual(out[1].errors, ['upstream said no']);

  // When Codex already said it in an `error` line, it is not said twice.
  const d = chat();
  d.feed(turnStarted());
  const said = d.feed(note('error', { error, willRetry: false }));
  assert.deepEqual(kinds(said), ['notice']);
  assert.equal(said[0].text, 'OpenAI is overloaded right now.');
  assert.deepEqual(kinds(d.feed(turnCompleted('failed', { error }))), ['turn-end']);
  // …and the next turn starts clean.
  d.feed(turnStarted('turn-2'));
  assert.deepEqual(kinds(d.feed(turnCompleted('failed', { id: 'turn-2', error }))), ['notice', 'turn-end']);
});

test('error codes: Codex\'s own names and HTTP statuses become Canopy\'s; unknown ones show Codex\'s words', { skip: missing }, () => {
  const end = (error) => only(chat().feed(turnStarted(), turnCompleted('failed', { error })), 'turn-end');
  const notice = (error) => only(chat().feed(turnStarted(), turnCompleted('failed', { error })), 'notice');
  assert.equal(end({ message: 'x', codexErrorInfo: 'contextWindowExceeded' }).errorCode, 'prompt-too-long');
  assert.equal(end({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }).errorCode, 'rate-limit');
  assert.equal(end({ message: 'x', codexErrorInfo: 'unauthorized' }).errorCode, 'auth');
  const budget = end({ message: 'x', codexErrorInfo: 'sessionBudgetExceeded' });
  assert.deepEqual([budget.errorCode, budget.reason], ['budget', 'Stopped: spending limit reached.']);
  const limited = end({ message: 'x', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } });
  assert.deepEqual([limited.errorCode, limited.apiStatus], ['rate-limit', 429]);
  assert.equal(end({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).errorCode, 'auth');
  assert.equal(end({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } }).errorCode, 'api');
  assert.equal(end({ message: 'x', codexErrorInfo: 'somethingNew' }).errorCode, 'api');
  assert.equal(end({ message: 'x', codexErrorInfo: null }).errorCode, 'api');
  assert.equal(notice({ message: 'Your sandbox refused it', codexErrorInfo: 'sandboxError' }).text, 'Your sandbox refused it');
  assert.equal(notice({ message: 'A brand new failure', codexErrorInfo: 'somethingNew' }).text, 'A brand new failure');
  assert.equal(notice({}).text, 'Codex reported an error.');
  assert.equal(notice(null).text, 'Codex reported an error.');
  assert.deepEqual(end(null).errors, ['Codex reported an error.']);
  // Codex's words must not be mistaken for the two notices the window rewrites.
  assert.equal(notice({ message: 'Rate limited by upstream' }).text, 'Codex: Rate limited by upstream');
  assert.equal(notice({ message: 'Auth: token expired' }).text, 'Codex: Auth: token expired');
  assert.equal(notice({ message: `\x1b[31m${'long '.repeat(1000)}\x1b[0m` }).text.length, 2001);
});

test('an error Codex will retry is a status, not a notice, and does not fail the turn', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted());
  const out = c.feed(note('error', { error: { message: 'stream dropped\nretrying in 2s', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, additionalDetails: null }, willRetry: true }));
  assert.deepEqual(out, [{ kind: 'status', status: 'retrying', attempt: null, maxRetries: null, retryDelayMs: null, errorStatus: 502, error: 'stream dropped' }]);
  assert.deepEqual(kinds(c.feed(turnCompleted())), ['turn-end']);
});

test('the crash line a session makes up closes everything the turn left open', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted(), started(command('c-1', 'npm test')), started(patch('fc-1', [update('/w/a', '@@ -1 +1 @@\n-a\n+b\n'), update('/w/b', '@@ -1 +1 @@\n-a\n+b\n')])),
    note('item/reasoning/summaryTextDelta', { itemId: 'rs-1', delta: 'Working it out', summaryIndex: 0 }),
    started(message('msg-1', '')), note('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Half an ans' }));
  // Exactly the line section 5 of the plan tells the session to feed.
  const out = c.adapter.adapt({ method: 'turn/completed', params: { threadId: T, turn: { id: U, status: 'failed', error: { message: 'Codex stopped unexpectedly (exit code 1).' }, items: [] } } });
  assert.deepEqual(kinds(out).sort(), ['assistant-text', 'notice', 'thinking', 'tool-result', 'tool-result', 'tool-result', 'turn-end']);
  assert.deepEqual(of(out, 'tool-result').map((r) => r.id).sort(), ['c-1', 'fc-1', 'fc-1#1']);
  for (const r of of(out, 'tool-result')) assert.deepEqual([r.interrupted, r.isError, r.content], [true, true, '']);
  const text = only(out, 'assistant-text');
  assert.deepEqual([text.text, text.aborted, text.messageId], ['Half an ans', true, 'msg-1']);
  assert.equal(only(out, 'thinking').text, 'Working it out');
  assert.equal(only(out, 'notice').text, 'Codex stopped unexpectedly (exit code 1).');
  const end = out.at(-1);
  assert.equal(end.kind, 'turn-end');
  assert.deepEqual([end.isError, end.subtype, end.errorCode, end.sessionId, end.turnId], [true, 'error', 'api', T, U]);
  assert.deepEqual(end.errors, ['Codex stopped unexpectedly (exit code 1).']);
  // Nothing is left over for the next turn to close again.
  c.feed(turnStarted('turn-2'));
  assert.deepEqual(kinds(c.feed(turnCompleted('completed', { id: 'turn-2' }))), ['turn-end']);
  // The forced-stop version of the same line.
  const d = chat();
  d.feed(turnStarted(), started(command('c-1', 'npm test')));
  const stopped = d.adapter.adapt({ method: 'turn/completed', params: { threadId: T, turn: { id: U, status: 'interrupted', error: null, items: [] } } });
  assert.deepEqual(kinds(stopped), ['tool-result', 'turn-end']);
  assert.equal(stopped[1].interrupted, true);
});

test('a turn that ends well with text still streaming closes it as said, not aborted', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted(), note('item/agentMessage/delta', { itemId: 'msg-1', delta: 'All done.' }));
  const out = c.feed(turnCompleted('completed', { items: [message('msg-1', 'All done.')] }));
  assert.deepEqual(kinds(out), ['assistant-text', 'turn-end']);
  assert.equal(out[0].aborted, false);
  assert.equal(out[1].text, 'All done.');
});

test('turn-end text: the final answer, else what the turn lists, else the last thing said', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted(), completed(message('m-1', 'Looking…', { phase: 'commentary' })), completed(message('m-2', 'The answer.')), completed(message('m-3', 'A footnote.', { phase: 'commentary' })));
  assert.equal(only(c.feed(turnCompleted()), 'turn-end').text, 'The answer.');
  c.feed(turnStarted('turn-2'), completed(message('m-4', 'Only narration.', { phase: 'commentary' })));
  assert.equal(only(c.feed(turnCompleted('completed', { id: 'turn-2' })), 'turn-end').text, 'Only narration.');
  c.feed(turnStarted('turn-3'));
  assert.equal(only(c.feed(turnCompleted('completed', { id: 'turn-3', items: [message('m-5', 'Listed by the turn.')] })), 'turn-end').text, 'Listed by the turn.');
  // Nothing carries over from the turn before.
  c.feed(turnStarted('turn-4'));
  assert.equal(only(c.feed(turnCompleted('completed', { id: 'turn-4' })), 'turn-end').text, '');
  // A question asked without waiting is never the answer, even when it is the last thing said.
  const question = message('call_1', 'Which word?\n- world\n- there', { delivery: 'async', questions: [{ title: 'Which word?', options: ['world', 'there'] }] });
  c.feed(turnStarted('turn-5'), completed(message('m-6', 'The plan.')), completed(question));
  assert.equal(only(c.feed(turnCompleted('completed', { id: 'turn-5' })), 'turn-end').text, 'The plan.');
  assert.equal(A.adaptHistory([{ ...turn('completed'), items: [message('m-6', 'The plan.'), question] }]).at(-1).text, 'The plan.');
  // With no memory, the turn's own list is all there is.
  assert.equal(only(A.adapt(turnCompleted('completed', { items: [message('m', 'From the list.')] })), 'turn-end').text, 'From the list.');
});

test('token counts: a turn\'s usage is what it added, and a reopened chat\'s replayed total is where it starts from', { skip: missing }, () => {
  const c = chat();
  assert.equal(c.adapter.usage(), null);
  // thread/resume replays the last known counts, with the old turn's id, before any turn runs here.
  const before = tokens(21800, 21795, 0, 21792, 5);
  assert.deepEqual(c.feed(usage(before, before)), []);
  assert.equal(c.adapter.usage().contextTokens, 21800);
  c.feed(turnStarted());
  c.feed(usage(tokens(43705, 43690, 21792, 21892, 15, 4), tokens(21905, 21895, 21792, 100, 10, 4)));
  c.feed(usage(tokens(65720, 65700, 43684, 21997, 20, 4), tokens(22015, 22010, 21892, 105, 5)));
  const end = only(c.feed(turnCompleted()), 'turn-end');
  assert.equal(end.turns, 2);
  assert.deepEqual(end.turnUsage, { inputTokens: 16, outputTokens: 15, cacheReadInputTokens: 43684, cacheCreationInputTokens: 205, thinkingTokens: 4, webSearchRequests: 0 });
  assert.equal(end.contextTokens, 22015);
  assert.equal(end.contextWindow, 258400);
  assert.deepEqual(end.usage, { inputTokens: 13, outputTokens: 5, cacheReadInputTokens: 21892, cacheCreationInputTokens: 105, thinkingTokens: 0, webSearchRequests: 0 });
  assert.deepEqual(c.adapter.usage(), { contextTokens: 22015, contextWindow: 258400,
    total: { inputTokens: 19, outputTokens: 20, cacheReadInputTokens: 43684, cacheCreationInputTokens: 21997, thinkingTokens: 4, webSearchRequests: 0 }, last: end.usage });
  // A turn with no model call adds nothing.
  c.feed(turnStarted('turn-2'));
  const empty = only(c.feed(turnCompleted('interrupted', { id: 'turn-2' })), 'turn-end');
  assert.equal(empty.turns, 0);
  assert.deepEqual(empty.turnUsage, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, webSearchRequests: 0 });
  // The counts outlive a turn (and a process restart); reset() forgets them with everything else.
  c.adapter.reset();
  assert.equal(c.adapter.usage(), null);
  assert.deepEqual(c.feed(usage('nonsense'), usage(null, null)), []);
});

test('reset forgets the conversation: open items, what was said, the model', { skip: missing }, () => {
  const c = chat();
  c.feed(turnStarted(), note('thread/settings/updated', { threadSettings: { model: 'gpt-6.1-sol' } }), started(command('c-1', 'ls')),
    note('item/agentMessage/delta', { itemId: 'msg-1', delta: 'partial' }), note('warning', { message: 'Heads up.' }));
  c.adapter.reset();
  assert.deepEqual(kinds(c.feed(turnCompleted('interrupted'))), ['turn-end']);
  assert.equal(only(c.feed(completed(message('m', 'x'))), 'assistant-text').model, null);
  assert.deepEqual(kinds(c.feed(note('warning', { message: 'Heads up.' }))), ['notice']);
  assert.equal(c.adapter.request(ask('item/fileChange/requestApproval', { itemId: 'c-1' })).input.diff, undefined);
});

test('warnings: said once per chat; set-up notes only with verbose; the reviewer\'s warnings and a rerouted model are marked', { skip: missing }, () => {
  const c = chat();
  const first = c.feed(note('warning', { message: 'The sandbox could not start; commands will ask first.' }));
  assert.deepEqual(first.map((e) => [e.kind, e.code, e.text]), [['notice', 'codex-warning', 'The sandbox could not start; commands will ask first.']]);
  assert.deepEqual(c.feed(note('warning', { message: 'The sandbox could not start; commands will ask first.' })), []);
  assert.deepEqual(c.feed(note('warning', { message: '' }), note('warning', {})), []);
  assert.deepEqual(c.feed(note('deprecationNotice', { summary: 'Old flag.', details: 'Use the new one.' }), note('configWarning', { summary: 'Bad key.', details: null, path: '/Users/test/.codex/config.toml' })), []);
  const verbose = chat({ verbose: true }).feed(note('configWarning', { summary: 'Bad key.', details: 'line 3' }));
  assert.deepEqual(verbose.map((e) => [e.code, e.level, e.text, e.detail]), [['codex-config', 'info', 'Bad key.', 'line 3']]);
  const guard = only(c.feed(note('guardianWarning', { message: 'This command looked risky.' })), 'notice');
  assert.deepEqual([guard.code, guard.level], ['auto-review', 'warn']);
  const rerouted = only(c.feed(note('model/rerouted', { fromModel: 'gpt-6.1-sol', toModel: 'gpt-6-luna', reason: 'highRiskCyberActivity' })), 'notice');
  assert.equal(rerouted.text, 'This request was answered by gpt-6-luna instead of gpt-6.1-sol.');
  assert.deepEqual([rerouted.code, rerouted.fromModel, rerouted.toModel], ['model-rerouted', 'gpt-6.1-sol', 'gpt-6-luna']);
  assert.deepEqual(c.feed(note('model/rerouted', { fromModel: 'a', toModel: '' })), []);
});

test('rate limits: one notice when a limit is reached, none while it stays reached, none for ordinary updates', { skip: missing }, () => {
  const c = chat();
  const limits = (rateLimitReachedType, primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1794805200 }) =>
    ({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: null, limitName: 'codex', primary, secondary: null, credits: null, rateLimitReachedType } } });
  assert.deepEqual(c.feed(limits(null, { usedPercent: 40, windowDurationMins: 300, resetsAt: 1794805200 })), []);
  const hit = only(c.feed(limits('rate_limit_reached')), 'notice');
  assert.equal(hit.code, 'rate-limit');
  assert.equal(hit.level, 'warn');
  assert.equal(hit.resetsAt, 1794805200000);
  assert.match(hit.text, /^Usage limit reached \(5-hour limit\)\. It resets (at|on) /, 'the limit is named, as in a Claude chat');
  assert.deepEqual(hit.rateLimit, { status: 'rejected', rateLimitType: 'rate_limit_reached', resetsAt: 1794805200000, limitName: 'codex' });
  assert.deepEqual(c.feed(limits('rate_limit_reached')), []);
  assert.deepEqual(c.feed(limits(null)), []);
  assert.equal(c.feed(limits('rate_limit_reached')).length, 1);
  assert.equal(only(chat().feed(limits('workspace_owner_credits_depleted')), 'notice').text, 'Your OpenAI workspace is out of credits.');
  assert.deepEqual(chat().feed({ method: 'account/rateLimits/updated', params: {} }, { method: 'account/rateLimits/updated', params: { rateLimits: 5 } }), []);
});

test('hooks: a failing hook carries its own words', { skip: missing }, () => {
  const run = { id: 'stop:1:/x/hooks.json', eventName: 'stop', handlerType: 'command', status: 'failed', statusMessage: 'exited 2', entries: [{ kind: 'feedback', text: 'tests are red' }, { kind: 'error', text: 'make: failed' }] };
  const [ev] = chat().feed(note('hook/completed', { run }));
  assert.deepEqual(ev, { kind: 'hook', subtype: 'hook_response', id: run.id, event: 'Stop', name: 'Stop', output: 'tests are red\nmake: failed', stderr: 'make: failed', exitCode: undefined, outcome: 'failed' });
  const [quiet] = chat().feed(note('hook/started', { run: { ...run, status: 'running', entries: [] } }));
  assert.deepEqual([quiet.subtype, quiet.output, quiet.outcome], ['hook_started', 'exited 2', null]);
  assert.equal(chat().feed(note('hook/completed', {}))[0].name, 'hook');
});

// ---- by hand: prompts ----

test('command prompt: every decision Codex offers is honoured, and none it does not', { skip: missing }, () => {
  const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } };
  const params = { kind: 'command', itemId: 'c-1', environmentId: 'local', reason: null, command: "/bin/zsh -lc 'npm test'", cwd: '/w', commandActions: [{ type: 'unknown', command: 'npm test' }] };
  const reply = (req, answer) => A.replyTo(req, answer);

  const all = A.requestOf(ask('item/commandExecution/requestApproval', { ...params, availableDecisions: ['accept', 'acceptForSession', rule, 'decline', 'cancel'] }, 7), null);
  assert.equal(all.rpcId, 7);
  assert.deepEqual(all.input, { command: 'npm test' });
  assert.deepEqual(all.offers, { session: true, rule, decline: true, cancel: true });
  assert.equal(all.base.cwd, '/w');
  assert.equal(all.base.reason, null);
  assert.deepEqual(reply(all, { action: 'allow' }), { result: { decision: 'accept' }, stops: false });
  assert.deepEqual(reply(all, { action: 'always' }), { result: { decision: rule }, stops: false });
  assert.deepEqual(reply(all, { action: 'always', scope: 'session' }), { result: { decision: 'acceptForSession' }, stops: false });
  assert.deepEqual(reply(all, { action: 'deny' }), { result: { decision: 'decline' }, stops: false });
  assert.deepEqual(reply(all, { action: 'deny', stop: true }), { result: { decision: 'cancel' }, stops: true });
  // A plan card's answer is no answer to a command prompt; if one arrives, it is a "no".
  assert.deepEqual(reply(all, { action: 'plan-approve' }), { result: { decision: 'decline' }, stops: false });

  // Only yes or no.
  const plain = A.requestOf(ask('item/commandExecution/requestApproval', { ...params, availableDecisions: ['accept', 'decline'] }), null);
  assert.equal(plain.base.hasSuggestions, false);
  assert.deepEqual(reply(plain, { action: 'always' }), { result: { decision: 'accept' }, stops: false });
  assert.deepEqual(reply(plain, { action: 'deny', stop: true }), { result: { decision: 'decline' }, stops: false });

  // An older server that sends no list: everything is assumed, and the proposed rule is the "always".
  const old = A.requestOf(ask('item/commandExecution/requestApproval', { ...params, proposedExecpolicyAmendment: ['npm', 'test'] }), null);
  assert.deepEqual(old.offers, { session: true, rule, decline: true, cancel: true });
  assert.deepEqual(old.base.alwaysPrefix, ['npm', 'test']);
  const bare = A.requestOf(ask('item/commandExecution/requestApproval', params), null);
  assert.deepEqual(reply(bare, { action: 'always' }), { result: { decision: 'acceptForSession' }, stops: false });

  // A request to reach the network says where, and a read is a Read card.
  const net = A.requestOf(ask('item/commandExecution/requestApproval', { ...params, command: "/bin/zsh -lc 'curl example.com'", commandActions: [{ type: 'unknown', command: 'curl example.com' }], networkApprovalContext: { host: 'example.com', protocol: 'https' } }), null);
  assert.equal(net.input.description, 'Wants to reach example.com.');
  assert.deepEqual(net.base.network, { host: 'example.com', protocol: 'https' });
  const read = A.requestOf(ask('item/commandExecution/requestApproval', { ...params, reason: 'Outside the project', command: "/bin/zsh -lc 'cat /etc/hosts'", commandActions: [{ type: 'read', command: 'cat /etc/hosts', name: 'hosts', path: '/etc/hosts' }] }), null);
  assert.deepEqual([read.name, read.input, read.base.reason], ['Read', { file_path: '/etc/hosts', command: 'cat /etc/hosts' }, 'Outside the project']);
  // The command can come from the item when the request leaves it out (input to a running command).
  const c = chat();
  c.feed(started(command('c-9', 'python3 -i')));
  const stdin = c.adapter.request(ask('item/commandExecution/requestApproval', { kind: 'writeStdin', itemId: 'c-9', approvalId: 'a-1' }));
  assert.deepEqual(stdin.input, { command: 'python3 -i', stdin: true });
});

test('question prompt: AskUserQuestion input in, answers keyed by Codex\'s question ids out', { skip: missing }, () => {
  const questions = [
    { id: 'q-word', header: 'Word', question: 'Which word?', isOther: true, isSecret: false, options: [{ label: 'world', description: 'The classic' }, { label: 'there', description: '' }] },
    { id: 'q-again', header: 'Word', question: 'Which word?', isOther: false, isSecret: false, options: null },
    { id: 'q-key', header: 'Key', question: 'Paste the key', isOther: true, isSecret: true, options: [] },
  ];
  const req = A.requestOf(ask('item/tool/requestUserInput', { itemId: 'call-1', questions, isBlocking: true, autoResolutionMs: null }, 3), null);
  assert.equal(req.type, 'question');
  assert.equal(req.name, 'AskUserQuestion');
  assert.equal(req.base.type, 'question');
  assert.equal(req.base.toolName, 'AskUserQuestion');
  assert.equal(req.base.toolUseId, 'call-1');
  assert.equal(req.base.blocking, true);
  assert.deepEqual(req.input.questions, [
    { question: 'Which word?', header: 'Word', options: [{ label: 'world', description: 'The classic' }, { label: 'there', description: '' }], multiSelect: false },
    { question: 'Which word? (2)', header: 'Word', options: [], multiSelect: false, otherOff: true },
    { question: 'Paste the key', header: 'Key', options: [], multiSelect: false, secret: true },
  ]);
  assert.deepEqual(req.ids, { 'Which word?': 'q-word', 'Which word? (2)': 'q-again', 'Paste the key': 'q-key' });
  assert.deepEqual(req.fallback, { answers: {} });

  assert.deepEqual(A.replyTo(req, { action: 'answers', answers: { 'Which word?': 'world', 'Which word? (2)': [' there ', '', 'again'], 'Paste the key': '  ', 'Never asked': 'x', constructor: 'y' } }),
    { result: { answers: { 'q-word': { answers: ['world'] }, 'q-again': { answers: ['there', 'again'] } } }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'question-skip' }), { result: { answers: {} }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'deny' }), { result: { answers: {} }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'answers', answers: 'nonsense' }), { result: { answers: {} }, stops: false });
  assert.equal(A.requestOf(ask('item/tool/requestUserInput', { itemId: 'call-2', questions, isBlocking: false }), null).base.blocking, false);
  assert.deepEqual(A.requestOf(ask('item/tool/requestUserInput', { itemId: 'call-3', questions: 'no' }), null).input, { questions: [] });
});

test('permissions prompt: a card named Permissions; Allow grants exactly what was asked, for the turn or the chat', { skip: missing }, () => {
  const permissions = { network: { enabled: true }, fileSystem: { read: null, write: ['/var/cache/build'] } };
  const req = A.requestOf(ask('item/permissions/requestApproval', { itemId: 'p-1', environmentId: null, cwd: '/w', reason: 'To write the build cache', permissions }), null);
  assert.equal(req.type, 'tool');
  assert.equal(req.name, 'Permissions');
  assert.equal(req.base.toolName, 'Permissions');
  assert.equal(req.base.title, 'Allow more access?');
  assert.equal(req.base.description, 'change files outside this project, use the network');
  assert.equal(req.base.blockedPath, '/var/cache/build');
  assert.equal(req.base.hasSuggestions, true);
  assert.deepEqual(req.input, { reason: 'To write the build cache', write: ['/var/cache/build'], network: true });
  assert.deepEqual(req.grant, permissions);
  assert.deepEqual(req.fallback, { permissions: {}, scope: 'turn' });
  assert.deepEqual(A.replyTo(req, { action: 'allow' }), { result: { permissions, scope: 'turn' }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'always' }), { result: { permissions, scope: 'session' }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'deny' }), { result: { permissions: {}, scope: 'turn' }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'deny', stop: true }), { result: { permissions: {}, scope: 'turn' }, stops: false });

  // Only what was asked for is in the grant.
  const reads = A.requestOf(ask('item/permissions/requestApproval', { itemId: 'p-2', permissions: { network: null, fileSystem: { read: ['/etc/hosts'], write: null } } }), null);
  assert.deepEqual(reads.grant, { fileSystem: { read: ['/etc/hosts'], write: null } });
  assert.deepEqual(reads.input, { read: ['/etc/hosts'] });
  assert.equal(reads.base.description, 'read files outside this project');
  assert.deepEqual(A.requestOf(ask('item/permissions/requestApproval', { itemId: 'p-3' }), null).grant, {});
});

test('elicitation prompt: a form or a link from an MCP server, answered in MCP\'s words', { skip: missing }, () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
  const form = A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'github', mode: 'form', _meta: null, message: 'Your name?', requestedSchema: schema }, 4), null);
  assert.equal(form.type, 'elicitation');
  assert.equal(form.base.type, 'elicitation');
  assert.deepEqual([form.base.server, form.base.mcpServer, form.base.message, form.base.mode, form.base.url], ['github', 'github', 'Your name?', 'form', null]);
  assert.deepEqual(form.base.schema, schema);
  assert.deepEqual(form.fallback, { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(A.replyTo(form, { action: 'elicit-accept', content: { name: 'Ada' } }), { result: { action: 'accept', content: { name: 'Ada' }, _meta: null }, stops: false });
  assert.deepEqual(A.replyTo(form, { action: 'elicit-accept', content: 'nope' }).result, { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(A.replyTo(form, { action: 'elicit-decline' }).result, { action: 'decline', content: null, _meta: null });
  assert.deepEqual(A.replyTo(form, { action: 'deny' }).result, { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(A.replyTo(form, {}).result, { action: 'cancel', content: null, _meta: null });

  const link = A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'linear', mode: 'url', _meta: null, message: 'Sign in', url: 'https://linear.app/oauth', elicitationId: 'e-1', turnId: null }), null);
  assert.deepEqual([link.base.mode, link.base.url, link.base.elicitationId, link.base.schema], ['url', 'https://linear.app/oauth', 'e-1', null]);
  assert.equal(A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'x', mode: 'openai/form', message: 'm', requestedSchema: schema }), null).base.mode, 'form');
});

test('an MCP tool approval arrives as an elicitation and is a tool card: Allow, Always allow where offered, Deny', { skip: missing }, () => {
  // Written by hand from the keys the 0.153.4 binary carries (no recording holds one): `_meta.codex_approval_kind`
  // marks it, `persist` says what Codex offers to remember, and the form is empty.
  const mcpAsk = (meta, extra = {}, id = 7) => ask('mcpServer/elicitation/request', {
    serverName: 'slack', mode: 'form', message: 'Allow the slack MCP server to run tool "send_message"?', requestedSchema: { type: 'object', properties: {} }, _meta: meta, ...extra,
  }, id);
  const c = chat();
  c.feed(started({ type: 'mcpToolCall', id: 'call_1', server: 'slack', tool: 'send_message', status: 'inProgress', arguments: { channel: 'general', text: 'hi' }, result: null, error: null, durationMs: null }));
  const req = c.adapter.request(mcpAsk({ codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_title: 'Send a message', tool_description: 'Posts to a channel' }));
  assert.deepEqual([req.type, req.name, req.rpcId, req.method], ['tool', 'mcp__slack__send_message', 7, 'mcpServer/elicitation/request']);
  assert.deepEqual(req.input, { channel: 'general', text: 'hi' });
  assert.deepEqual(req.offers, { session: true, always: true });
  assert.deepEqual([req.base.type, req.base.toolName, req.base.toolUseId, req.base.hasSuggestions, req.base.mcpServer, req.base.displayName, req.base.description, req.base.engine],
    ['tool', 'mcp__slack__send_message', 'call_1', true, 'slack', 'Send a message', 'Posts to a channel', 'codex']);
  assert.equal(req.base.reason, 'Allow the slack MCP server to run tool "send_message"?');
  assert.deepEqual(req.fallback, { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(A.replyTo(req, { action: 'allow' }), { result: { action: 'accept', content: {}, _meta: null }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'always' }).result, { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(A.replyTo(req, { action: 'always', scope: 'session' }).result, { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(A.replyTo(req, { action: 'deny' }), { result: { action: 'decline', content: null, _meta: null }, stops: false });
  assert.deepEqual(A.replyTo(req, { action: 'deny', stop: true }).result, { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(A.replyTo(req, {}).result, { action: 'decline', content: null, _meta: null }, 'an answer that cannot be read is a no');
  assert.deepEqual(A.replyTo(req, { action: 'elicit-accept', content: { x: 1 } }).result.action, 'decline', 'a form\'s yes is not a tool\'s yes');

  // Only what Codex offers is ever asked for.
  const session = A.requestOf(mcpAsk({ codex_approval_kind: 'mcp_tool_call', persist: 'session' }), null);
  assert.deepEqual([session.offers, session.base.hasSuggestions], [{ session: true, always: false }, true]);
  assert.deepEqual(A.replyTo(session, { action: 'always' }).result._meta, { persist: 'session' });
  const once = A.requestOf(mcpAsk({ codex_approval_kind: 'mcp_tool_call', persist: 'forever' }), null);
  assert.deepEqual([once.offers, once.base.hasSuggestions], [{ session: false, always: false }, false]);
  assert.deepEqual(A.replyTo(once, { action: 'always' }).result, { action: 'accept', content: {}, _meta: null });

  // With no open call to look at, the name comes from the request's own words and the input from its metadata.
  const bare = A.requestOf(mcpAsk({ codex_approval_kind: 'mcp_tool_call', tool_params: { q: 'x' } }, { turnId: null }), null);
  assert.deepEqual([bare.name, bare.input, bare.base.toolUseId], ['mcp__slack__send_message', { q: 'x' }, null]);
  assert.equal(A.requestOf(mcpAsk({ codex_approval_kind: 'mcp_tool_call', tool_name: 'named' }, { message: 'Approve?' }), null).name, 'mcp__slack__named');
  assert.equal(A.requestOf(mcpAsk({ codex_approval_kind: 'mcp_tool_call' }, { message: '' }), null).name, 'mcp__slack__tool');
  // The call another server has open is not this one's.
  const other = chat();
  other.feed(started({ type: 'mcpToolCall', id: 'call_2', server: 'github', tool: 'create_issue', status: 'inProgress', arguments: {} }));
  assert.equal(other.adapter.request(mcpAsk({ codex_approval_kind: 'mcp_tool_call' })).base.toolUseId, null);
  // A call the metadata names wins over the newest one.
  const two = chat();
  two.feed(started({ type: 'mcpToolCall', id: 'call_a', server: 'slack', tool: 'first', status: 'inProgress', arguments: { n: 1 } }), started({ type: 'mcpToolCall', id: 'call_b', server: 'slack', tool: 'second', status: 'inProgress', arguments: { n: 2 } }));
  assert.equal(two.adapter.request(mcpAsk({ codex_approval_kind: 'mcp_tool_call' })).name, 'mcp__slack__second');
  assert.equal(two.adapter.request(mcpAsk({ codex_approval_kind: 'mcp_tool_call', call_id: 'call_a' })).name, 'mcp__slack__first');

  // Anything else stays what it was: a form with other metadata, a link, hostile metadata.
  assert.equal(A.requestOf(mcpAsk({ codex_approval_kind: 'something_else' }), null).type, 'elicitation');
  assert.equal(A.requestOf(mcpAsk({ codex_approval_kind: 'mcp_tool_call' }, { mode: 'url', url: 'https://x.test', elicitationId: 'e' }), null).type, 'elicitation');
  for (const meta of [null, 'mcp_tool_call', 7, [], { codex_approval_kind: { toString() { throw new Error('boom'); } } }]) assert.equal(A.requestOf(mcpAsk(meta), null).type, 'elicitation');
  assert.doesNotThrow(() => c.adapter.request(mcpAsk({ codex_approval_kind: 'mcp_tool_call', get persist() { throw new Error('boom'); } })));
});

test('Computer Use asking to use an app: a plain approval that says who wants what', { skip: missing }, () => {
  // The request as Computer Use's own source builds it (@oai/sky computer-use-policy.js, plugin 26.1111): never seen live.
  const meta = {
    codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use', persist: ['session', 'always'], riskLevel: 'high',
    subtitle: 'This app can see your passwords.', tool_call_id: 'call_cu', tool_name: 'get_app_state', tool_params: { app: 'com.google.Chrome' },
    tool_params_display: [{ name: 'app', display_name: 'App', value: 'Google Chrome' }],
  };
  const cuAsk = (m, extra = {}) => ask('mcpServer/elicitation/request', { serverName: 'cua_repl', mode: 'form', message: 'Allow Computer Use to use "Google Chrome"?', requestedSchema: { type: 'object', properties: {} }, _meta: m, ...extra }, 3);
  const c = chat();
  c.feed(started({ type: 'mcpToolCall', id: 'call_other', server: 'cua_repl', tool: 'js_reset', status: 'inProgress', arguments: {} }), started({ type: 'mcpToolCall', id: 'call_cu', server: 'cua_repl', tool: 'js', status: 'inProgress', arguments: { code: 'await cua.getApp("com.google.Chrome")' } }));
  const req = c.adapter.request(cuAsk(meta));
  assert.deepEqual([req.type, req.own, req.server, req.tool, req.offers], ['tool', true, 'cua_repl', 'js', { session: true, always: true }]);
  assert.deepEqual([req.base.type, req.base.plain, req.base.title, req.base.app, req.base.description, req.base.reason, req.base.toolUseId, req.base.hasSuggestions, req.base.alwaysForChat],
    ['tool', true, 'Computer Use wants to use Google Chrome', 'Google Chrome', 'This app can see your passwords.', 'Allow Computer Use to use "Google Chrome"?', 'call_cu', true, undefined]);
  assert.deepEqual(req.input, { app: 'com.google.Chrome' });
  assert.deepEqual(A.replyTo(req, { action: 'allow' }).result, { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(A.replyTo(req, { action: 'always' }).result, { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(A.replyTo(req, { action: 'deny' }).result, { action: 'decline', content: null, _meta: null });

  // Where it may only be remembered for the chat, the second button says so; recording audio asks the same way.
  const audio = A.requestOf(cuAsk({ ...meta, persist: ['session'], tool_name: 'start_audio_recording', tool_params: {}, tool_params_display: [], subtitle: undefined }, { message: 'Allow Computer Use to record computer audio?' }), null);
  assert.deepEqual([audio.base.title, audio.base.alwaysForChat, audio.base.app, audio.base.description], ['Computer Use wants to record computer audio', true, undefined, null]);
  assert.deepEqual(A.replyTo(audio, { action: 'always' }).result._meta, { persist: 'session' });
  assert.equal(A.requestOf(cuAsk({ ...meta, tool_params_display: null }, { message: 'Something else' }), null).base.title, 'Computer Use needs your OK');
  // An ordinary MCP tool's approval is not one of these.
  const plainTool = A.requestOf(cuAsk({ codex_approval_kind: 'mcp_tool_call', connector_id: 'connector_123', connector_name: 'Notion' }), null);
  assert.deepEqual([plainTool.own, plainTool.base.plain, plainTool.base.title], [undefined, undefined, null]);
});

test('a form from an MCP server: its fields, and the values going back as the server asked for them', { skip: missing }, () => {
  const schema = { type: 'object', required: ['title'], properties: {
    title: { type: 'string' }, points: { type: 'integer' }, urgent: { type: 'boolean', default: true },
    team: { type: 'string', enum: ['eng', 'ops'] }, labels: { type: 'array', items: { type: 'string', enum: ['bug', 'ui'] } },
  } };
  const form = A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'linear', mode: 'form', _meta: null, message: 'New issue', requestedSchema: schema }, 5), null);
  assert.deepEqual([form.base.ask, form.base.title, form.base.toolName], ['form', 'Linear needs a few details', 'linear']);
  assert.deepEqual(form.base.fields.map((f) => [f.key, f.kind, f.required]), [['title', 'text', true], ['points', 'number', false], ['urgent', 'boolean', false], ['team', 'choice', false], ['labels', 'choices', false]]);
  assert.deepEqual(A.replyTo(form, { action: 'elicit-accept', content: { title: 'T', points: '3', urgent: false, team: 'nope', labels: ['ui', 'x'], more: 1 } }).result,
    { action: 'accept', content: { title: 'T', points: 3, urgent: false, labels: ['ui'] }, _meta: null });
  assert.deepEqual(A.replyTo(form, { action: 'elicit-cancel' }).result, { action: 'cancel', content: null, _meta: null });

  const yesNo = A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'docs', mode: 'form', _meta: null, message: 'Publish?', requestedSchema: { type: 'object', properties: {} } }), null);
  assert.deepEqual([yesNo.base.ask, yesNo.base.title, yesNo.base.fields], ['confirm', 'Docs needs your OK', []]);
  assert.deepEqual(A.replyTo(yesNo, { action: 'elicit-accept' }).result, { action: 'accept', content: {}, _meta: null });
  const link = A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'linear', mode: 'url', _meta: null, message: 'Sign in', url: 'https://linear.app/oauth', elicitationId: 'e-1' }), null);
  assert.deepEqual([link.base.ask, link.base.title, link.base.url], ['link', 'Linear wants you to open a link', 'https://linear.app/oauth']);
  assert.equal(A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'x', mode: 'url', message: 'm', url: 'file:///etc/passwd', elicitationId: 'e' }), null).base.url, null, 'only a web page is opened');
  // OpenAI's own check cannot be done here: a card that can only be turned down.
  const verify = A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'bank', mode: 'openai/userVerification', _meta: null, title: 'Verify', description: 'Prove it is you', challenge: 'abc' }), null);
  assert.deepEqual([verify.base.ask, verify.base.message, verify.base.fields], ['unsupported', 'Prove it is you', []]);
  assert.doesNotThrow(() => A.requestOf(ask('mcpServer/elicitation/request', { serverName: 'x', mode: 'form', message: 'm', requestedSchema: { properties: { get a() { throw new Error('boom'); } } } }), null));
});

test('requests that are not questions for the user give null; one nobody knows is reported', { skip: missing }, () => {
  for (const method of ['item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read', 'applyPatchApproval', 'execCommandApproval']) {
    const c = chat();
    assert.equal(c.adapter.request(ask(method)), null, method);
    assert.deepEqual(c.feed(ask(method)), [], method);
    assert.deepEqual(c.unknown, [], method);
  }
  const c = chat({ debug: true });
  assert.equal(c.adapter.request(ask('item/hologram/requestApproval', { itemId: 'h-1', secret: 'not passed on' })), null);
  assert.deepEqual(c.unknown.map((u) => u.label), ['codex/request/item/hologram/requestApproval']);
  assert.ok(c.unknown[0].keys.includes('secret'));
  assert.ok(!JSON.stringify(c.unknown).includes('not passed on'));
  // A notification is not a request, and neither is a response.
  assert.equal(A.requestOf(note('item/commandExecution/requestApproval', { itemId: 'c-1' }), null), null);
  assert.equal(A.requestOf({ id: 3, result: {} }, null), null);
});

test('replyTo never throws: an answer or a request that cannot be read is a "no" or the fallback', { skip: missing }, () => {
  const cmd = A.requestOf(ask('item/commandExecution/requestApproval', { itemId: 'c-1', command: 'ls', availableDecisions: ['accept', 'decline', 'cancel'] }), null);
  const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
  for (const answer of [undefined, null, 0, 'allow', [], {}, { action: 7 }, { action: 'nonsense' }, { action: null, stop: 'yes' }]) {
    let out;
    assert.doesNotThrow(() => { out = A.replyTo(cmd, answer); });
    assert.deepEqual(out, { result: { decision: 'decline' }, stops: false }, JSON.stringify(answer));
  }
  assert.doesNotThrow(() => A.replyTo(cmd, hostile));
  for (const request of [undefined, null, 0, 'x', [], {}, { method: 'nope' }, { method: 7, fallback: 'x' }]) {
    let out;
    assert.doesNotThrow(() => { out = A.replyTo(request, { action: 'allow' }); });
    assert.deepEqual(out, { result: {}, stops: false }, JSON.stringify(request));
  }
  assert.deepEqual(A.replyTo({ method: 'something/new', fallback: { decision: 'cancel' } }, { action: 'allow' }), { result: { decision: 'cancel' }, stops: false });
  assert.deepEqual(A.replyTo(hostile, { action: 'allow' }), { result: {}, stops: false });
  // A request whose remembered parts were lost still answers safely.
  assert.deepEqual(A.replyTo({ method: 'item/commandExecution/requestApproval' }, { action: 'always' }), { result: { decision: 'acceptForSession' }, stops: false });
  assert.deepEqual(A.replyTo({ method: 'item/fileChange/requestApproval', offers: 'x' }, { action: 'deny' }), { result: { decision: 'decline' }, stops: false });
  assert.deepEqual(A.replyTo({ method: 'item/permissions/requestApproval', grant: 'x' }, { action: 'allow' }), { result: { permissions: {}, scope: 'turn' }, stops: false });
  assert.deepEqual(A.replyTo({ method: 'item/tool/requestUserInput' }, { action: 'answers', answers: { a: 'b' } }), { result: { answers: {} }, stops: false });
  // A rule that is not plain data is never sent to Codex.
  const odd = { ...cmd, offers: { session: false, rule: new Date(), decline: true, cancel: true } };
  assert.deepEqual(A.replyTo(odd, { action: 'always' }), { result: { decision: 'accept' }, stops: false });
});

// ---- by hand: other chats, unknown lines, bad input ----

test('lines for another thread are dropped, from adapt and from request', { skip: missing }, () => {
  const other = '01a1e000-0000-7000-8000-00000000ffff';
  const c = chat({ threadId: T });
  const theirs = (m) => ({ ...m, params: { ...m.params, threadId: other } });
  assert.deepEqual(c.feed(theirs(turnStarted()), theirs(started(command('c-1', 'ls'))), theirs(note('item/agentMessage/delta', { itemId: 'm', delta: 'hi' })),
    theirs(completed(message('m', 'hi'))), theirs(note('error', { error: { message: 'x' }, willRetry: false })), theirs(turnCompleted())), []);
  assert.equal(c.adapter.request(theirs(ask('item/commandExecution/requestApproval', { itemId: 'c-1', command: 'ls' }))), null);
  assert.equal(c.adapter.usage(), null);
  // The same lines for this thread are heard.
  assert.deepEqual(kinds(c.feed(turnStarted(), completed(message('m', 'hi')), turnCompleted())), ['message-start', 'assistant-text', 'turn-end']);
  assert.ok(c.adapter.request(ask('item/commandExecution/requestApproval', { itemId: 'c-1', command: 'ls' })));
  // The thread can also be named per call, once the session knows it.
  const late = chat();
  assert.deepEqual(late.adapter.adapt(theirs(turnStarted()), { threadId: T }), []);
  assert.equal(late.adapter.request(theirs(ask('item/tool/requestUserInput', { itemId: 'x', questions: [] })), { threadId: T }), null);
  assert.deepEqual(kinds(late.adapter.adapt(turnStarted(), { threadId: T })), ['message-start']);
  // Lines that name no thread (account-wide ones) are not another chat's.
  assert.equal(c.feed({ method: 'warning', params: { threadId: null, message: 'For everyone.' } }).length, 1);
  assert.deepEqual(c.unknown, []);
});

test('a line or item this file does not know reaches the drift hook with its keys, and the transcript only in debug', { skip: missing }, () => {
  const c = chat();
  assert.deepEqual(c.feed(note('thread/hologram/updated', { colour: 'blue', secret: 'not passed on' })), []);
  assert.deepEqual(c.feed(started({ type: 'hologram', id: 'h-1', beam: 1 })), []);
  assert.deepEqual(c.feed(completed({ type: 'hologram', id: 'h-1', beam: 2 })), []);
  assert.deepEqual(c.feed(ask('item/hologram/requestApproval', { itemId: 'h-1' })), []);
  assert.deepEqual(c.feed({ neither: 'request nor response' }), []);
  assert.deepEqual(c.unknown.map((u) => u.label), ['codex/thread/hologram/updated', 'codex/item/hologram', 'codex/item/hologram', 'codex/request/item/hologram/requestApproval', 'codex/unknown']);
  assert.deepEqual(c.unknown[0].keys, ['threadId', 'turnId', 'colour', 'secret']);
  assert.deepEqual(c.unknown[1].keys, ['type', 'id', 'beam']);
  assert.ok(!JSON.stringify(c.unknown).includes('not passed on'));

  const d = chat({ debug: true });
  const raw = d.feed(note('thread/hologram/updated', { colour: 'blue' }));
  assert.deepEqual(raw.map((e) => [e.kind, e.label]), [['raw', 'codex/thread/hologram/updated']]);
  assert.equal(raw[0].raw.colour, 'blue');
  // The realtime family is known and quiet, whatever comes after the prefix.
  assert.deepEqual(d.feed(note('thread/realtime/somethingNew', {})), []);
  // An observer that throws does not break the chat.
  const broken = A.createAdapter({ unknown: () => { throw new Error('observer down'); } });
  assert.deepEqual(broken.adapt(note('thread/hologram/updated')), []);
  assert.deepEqual(kinds(broken.adapt(completed(message('m', 'still fine')))), ['assistant-text']);
});

test('adapt never throws, whatever it is given, and bad input is not an adapter error', { skip: missing }, () => {
  const cyclic = { method: 'thread/hologram/updated', params: {} };
  cyclic.params.self = cyclic;
  const junk = [undefined, null, 0, 1n, '', 'text', [], {}, () => {}, Symbol('x'), new Date(), { method: null }, { method: 7, params: {} }, { method: '' }, { id: 1 }, { id: 1, result: null }, { id: 1, error: { code: -32600, message: 'no' } },
    { method: 'turn/started' }, { method: 'turn/started', params: null }, { method: 'turn/started', params: { turn: 7 } }, { method: 'turn/completed', params: 'x' }, { method: 'turn/completed', params: { turn: { status: 9, items: 'x', error: 'bad' } } },
    { method: 'item/started', params: {} }, { method: 'item/started', params: { item: null } }, { method: 'item/started', params: { item: 'x' } }, { method: 'item/completed', params: { item: [] } },
    { method: 'item/started', params: { item: {} } }, { method: 'item/completed', params: { item: { type: 'commandExecution' } } }, { method: 'item/completed', params: { item: { type: 'fileChange', id: 'f', changes: [null, 7, {}, { diff: 5, kind: 'x' }] } } },
    { method: 'item/completed', params: { item: { type: 'mcpToolCall', id: 5, result: 'x', arguments: [1, 2] } } }, { method: 'item/completed', params: { item: { type: 'agentMessage', id: {}, text: 9, questions: [null, { title: 7, options: 'x' }] } } },
    { method: 'item/completed', params: { item: { type: 'reasoning', id: 'r', summary: 'x', content: [null, 4] } } }, { method: 'item/completed', params: { item: { type: 'webSearch', id: 'w', action: 'x' } } },
    { method: 'item/agentMessage/delta', params: { delta: 5 } }, { method: 'item/agentMessage/delta', params: { itemId: {}, delta: 'x' } }, { method: 'item/commandExecution/outputDelta', params: { delta: 'x' } },
    { method: 'item/reasoning/summaryPartAdded', params: { summaryIndex: 'x' } }, { method: 'turn/plan/updated', params: { plan: [null, 7, { step: {} }] } }, { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: 'x', last: 4 } } },
    { method: 'hook/started', params: { run: 'x' } }, { method: 'error', params: { error: 'x' } }, { method: 'error', params: { error: { codexErrorInfo: { } }, willRetry: true } }, { method: 'warning', params: { message: {} } },
    { method: 'account/rateLimits/updated', params: { rateLimits: { rateLimitReachedType: 'x', primary: 'p' } } }, { method: 'item/autoApprovalReview/completed', params: { review: 'x' } }, { method: 'thread/settings/updated', params: { threadSettings: 'x' } },
    { method: 'item/commandExecution/requestApproval', id: 0 }, { method: 'item/commandExecution/requestApproval', id: 0, params: 'x' }, cyclic];
  for (const make of [() => ({ adapt: A.adapt, request: (m) => A.requestOf(m, null) }), () => A.createAdapter(), () => A.createAdapter({ debug: true, verbose: true, toolOutput: true, threadId: T, model: 5, unknown: 'not a function', now: 'x' }), () => A.createAdapter(null)]) {
    const a = make();
    for (const m of junk) {
      let out;
      assert.doesNotThrow(() => { out = a.adapt(m); }, String(m?.method ?? typeof m));
      assert.ok(Array.isArray(out));
      assert.deepEqual(errorsIn(out), [], `adapter-error for ${typeof m === 'object' ? m?.method : typeof m}`);
      for (const ev of out) assert.doesNotThrow(() => structuredClone(ev));
      assert.doesNotThrow(() => a.request(m));
      assert.doesNotThrow(() => A.requestOf(m, m, m));
    }
    // After all that, an ordinary turn still works.
    if (a.reset) a.reset();
    assert.deepEqual(kinds([turnStarted(), completed(message('m', 'ok')), turnCompleted()].flatMap((m) => a.adapt(m))), ['message-start', 'assistant-text', 'turn-end']);
  }
  assert.doesNotThrow(() => A.adapt(note('item/started'), null));
});

test('a line that blows up inside the adapter becomes one adapter-error event, never an exception', { skip: missing }, () => {
  const trap = { method: 'item/started', params: { get item() { throw new Error('boom'); } } };
  for (const out of [A.adapt(trap), A.createAdapter().adapt(trap)]) {
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'raw');
    assert.equal(out[0].label, 'adapter-error');
    assert.match(out[0].raw.error, /boom/);
    assert.doesNotThrow(() => structuredClone(out[0]));
  }
  const c = chat();
  assert.equal(c.adapter.request({ method: 'item/fileChange/requestApproval', id: 0, get params() { throw new Error('boom'); } }), null);
  // The chat carries on.
  assert.deepEqual(kinds(c.feed(turnStarted(), trap, completed(message('m', 'ok')), turnCompleted())), ['message-start', 'raw', 'assistant-text', 'turn-end']);
});

test('items without a usable id cannot be rows, and say so through the drift hook instead', { skip: missing }, () => {
  const c = chat();
  assert.deepEqual(c.feed(started({ ...command('x', 'ls'), id: undefined }), completed({ ...command('x', 'ls'), id: 7, status: 'completed' }), started({ ...command('x', 'ls'), id: '' })), []);
  assert.deepEqual(c.unknown.map((u) => u.label), ['codex/item/commandExecution', 'codex/item/commandExecution', 'codex/item/commandExecution']);
});

// ---- by hand: size ----

test('huge output is cut to its head and tail, and says how long it really was', { skip: missing }, () => {
  const big = `${'a'.repeat(600_000)}MIDDLE${'z'.repeat(600_000)}`;
  const c = chat();
  c.feed(started(command('c-1', 'cat big.log')));
  const r = only(c.feed(completed(done(command('c-1', 'cat big.log'), { aggregatedOutput: big }))), 'tool-result');
  assert.equal(r.truncated, true);
  assert.equal(r.fullLength, big.length);
  assert.ok(r.content.length < 140_000, `content is ${r.content.length} characters`);
  assert.ok(r.content.startsWith('aaaa') && r.content.endsWith('zzzz'));
  assert.match(r.content, /… \[\d+ characters not shown\] …/);
  assert.ok(!r.content.includes('MIDDLE'));

  // A surrogate pair at the cut is not split.
  const emoji = '😀'.repeat(200_000);
  const e = only(chat().feed(completed(done(command('c-2', 'emoji'), { aggregatedOutput: emoji }))), 'tool-result');
  assert.equal(e.truncated, true);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(e.content));

  // MCP results too.
  const call = { type: 'mcpToolCall', id: 'mcp-1', server: 's', tool: 't', status: 'completed', arguments: { blob: 'x'.repeat(400_000) }, error: null,
    result: { content: [{ type: 'text', text: 'y'.repeat(400_000) }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(3_000_000) }], structuredContent: { rows: Array.from({ length: 5000 }, (_, i) => ({ i, pad: 'p'.repeat(100) })) }, _meta: null } };
  const [start, result] = chat().feed(completed(call));
  assert.deepEqual(start.input, { truncated: true });
  assert.equal(result.truncated, true);
  assert.equal(result.fullLength, 400_000 + '\n[image]'.length);
  assert.deepEqual(result.images, []);
  assert.equal(result.imagesOmitted, 1);
  assert.deepEqual(result.structured, { truncated: true, type: null });
  assert.ok(JSON.stringify([start, result]).length < 200_000);
});

test('huge commands, diffs and streams stay bounded', { skip: missing }, () => {
  const long = `echo ${'x'.repeat(100_000)}`;
  const [row] = chat().feed(started(command('c-1', long)));
  assert.ok(row.input.command.length <= 32 * 1024 + 1, `command is ${row.input.command.length} characters`);
  const req = A.requestOf(ask('item/commandExecution/requestApproval', { itemId: 'c-1', command: long, reason: 'r'.repeat(10_000) }), null);
  assert.ok(req.input.command.length <= 32 * 1024 + 1);
  assert.ok(req.input.description.length <= 2001);

  const diff = `@@ -1,3000 +1,3000 @@\n${'-old line of text that goes on\n+new line of text that goes on\n'.repeat(5000)}`;
  const [edit] = chat().feed(started(patch('fc-1', [update('/w/big.txt', diff)])));
  assert.equal(edit.input.truncated, true);
  for (const key of ['diff', 'old_string', 'new_string']) assert.ok(edit.input[key].length < 140_000, `${key} is ${edit.input[key].length} characters`);
  const [write] = chat().feed(started(patch('fc-2', [{ path: '/w/big.bin', kind: { type: 'add' }, diff: 'q'.repeat(500_000) }])));
  assert.equal(write.input.truncated, true);
  assert.ok(write.input.content.length < 140_000);

  // Text that streams without end and is then stopped: what is remembered for the closing event is capped.
  const c = chat();
  c.feed(turnStarted());
  const chunk = 'n'.repeat(10_000);
  for (let i = 0; i < 40; i++) assert.equal(c.feed(note('item/agentMessage/delta', { itemId: 'msg-1', delta: chunk })).length, 1);
  for (let i = 0; i < 40; i++) c.feed(note('item/reasoning/summaryTextDelta', { itemId: 'rs-1', delta: chunk, summaryIndex: 0 }));
  for (let i = 0; i < 40; i++) c.feed(note('item/commandExecution/outputDelta', { itemId: 'c-9', delta: chunk }));
  const out = c.feed(turnCompleted('interrupted'));
  assert.deepEqual(kinds(out), ['assistant-text', 'thinking', 'turn-end']);
  assert.equal(out[0].text.length, 128 * 1024);
  assert.equal(out[1].text.length, 128 * 1024);

  // A to-do list, a question and a hook cannot be unbounded either.
  const todos = only(chat().feed(note('turn/plan/updated', { plan: Array.from({ length: 1000 }, (_, i) => ({ step: `step ${i} ${'s'.repeat(5000)}`, status: 'pending' })) })), 'tool-start').input.todos;
  assert.equal(todos.length, 200);
  assert.ok(todos[0].content.length <= 2001);
  const q = A.requestOf(ask('item/tool/requestUserInput', { itemId: 'q', questions: Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, header: 'h'.repeat(1000), question: `Question ${i}? ${'w'.repeat(5000)}`, options: Array.from({ length: 50 }, () => ({ label: 'l'.repeat(2000), description: 'd'.repeat(5000) })) })) }), null);
  assert.equal(q.input.questions.length, 12);
  assert.equal(q.input.questions[0].options.length, 12);
  assert.ok(q.input.questions[0].question.length <= 2001 && q.input.questions[0].header.length <= 201 && q.input.questions[0].options[0].label.length <= 501);
  const [hook] = chat().feed(note('hook/completed', { run: { id: 'h', eventName: 'stop', status: 'failed', entries: [{ kind: 'error', text: 'e'.repeat(100_000) }] } }));
  assert.ok(hook.output.length <= 8 * 1024 + 1 && hook.stderr.length <= 8 * 1024 + 1);
});

test('debug output for an unknown line is capped, and one that cannot be serialized is described', { skip: missing }, () => {
  const [big] = chat({ debug: true }).feed(note('thread/hologram/updated', { blob: 'x'.repeat(100_000) }));
  assert.equal(big.truncated, true);
  assert.equal(typeof big.raw, 'string');
  assert.equal(big.raw.length, 8 * 1024);
  const cyclic = { method: 'thread/hologram/updated', params: { threadId: T } };
  cyclic.params.self = cyclic.params;
  const [odd] = chat({ debug: true }).feed(cyclic);
  assert.equal(odd.kind, 'raw');
  assert.equal(odd.truncated, true);
  assert.doesNotThrow(() => JSON.stringify(odd));
});

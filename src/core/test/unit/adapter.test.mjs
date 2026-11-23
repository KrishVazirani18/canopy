// adapter.mjs: SDK frames in, Canopy events out. Two groups: the stateless `adapt` the renderer's contract rests on,
// then the stateful adapter (`createAdapter`).
// Frames come from fixtures/live-*.json (recorded from CLI 2.1.322) or are
// written inline in the shape sdk.d.ts declares.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core, fixture } from '../helpers.mjs';

const A = await core('adapter.mjs');
const missing = A.__missing ? `adapter.mjs: ${A.__missing}` : false;
const v2 = missing || (typeof A.createAdapter === 'function' ? false : 'adapter.mjs does not export createAdapter');

const adapt = (m, opts) => A.adapt(m, opts);
const one = (m, opts) => {
  const out = adapt(m, opts);
  assert.equal(out.length, 1, `expected one event, got ${out.map((e) => e.kind).join(', ') || 'none'}`);
  return out[0];
};
const sys = (subtype, extra = {}) => ({ type: 'system', subtype, uuid: 'u-1', session_id: 's-1', ...extra });
const kinds = (events) => events.map((e) => e.kind);

const toolTurn = fixture('live-tool-turn');
const interrupt = fixture('live-interrupt');
const localCommand = fixture('live-local-command');
const clear = fixture('live-clear');
const meta = fixture('live-meta');
const ALL_LIVE = [...toolTurn, ...interrupt, ...localCommand, ...clear];

// ---- the existing contract ----

test('adapt never throws, whatever it is given', { skip: missing }, () => {
  for (const junk of [undefined, null, 0, '', 'text', [], {}, { type: null }, { type: 'assistant' }, { type: 'assistant', message: null }, { type: 'user', message: { content: [null, 7, {}] } },
    { type: 'stream_event' }, { type: 'stream_event', event: { type: 'content_block_delta' } }, { type: 'result' }, { type: 'system' }, { type: 'rate_limit_event' }, { type: 'tool_progress' }]) {
    let out;
    assert.doesNotThrow(() => { out = adapt(junk); });
    assert.ok(Array.isArray(out));
    assert.ok(!out.some((e) => e.kind === 'raw' && e.label === 'adapter-error'), `adapter-error for ${JSON.stringify(junk)}`);
  }
});

test('init keeps every field the renderer reads', { skip: missing }, () => {
  const ev = one(toolTurn.find((m) => m.subtype === 'init'));
  assert.equal(ev.kind, 'init');
  assert.match(ev.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(ev.model, 'claude-haiku-5-5');
  assert.equal(ev.cwd, '/private/tmp/canopy-test-1');
  assert.equal(ev.permissionMode, 'default');
  assert.equal(ev.version, '2.1.322');
  assert.equal(typeof ev.apiKeySource, 'string');
  for (const k of ['mcp', 'plugins', 'slash', 'skills', 'tools']) assert.ok(Array.isArray(ev[k]), k);
  assert.ok('fastState' in ev && 'fastReason' in ev);
});

test('a streamed turn keeps its shape: deltas, final text, tool call, tool result, turn end', { skip: missing }, () => {
  const events = toolTurn.flatMap((m) => adapt(m));
  const start = events.find((e) => e.kind === 'tool-start');
  assert.equal(start.name, 'Write');
  assert.equal(start.input.content, 'hi');
  assert.equal(start.parent, null);
  const result = events.find((e) => e.kind === 'tool-result');
  assert.equal(result.id, start.id);
  assert.equal(result.isError, false);
  assert.match(result.content, /File created successfully/);
  const finals = events.filter((e) => e.kind === 'assistant-text');
  assert.deepEqual(finals.map((e) => e.text), ['OK']);
  assert.equal(finals[0].model, 'claude-haiku-5-5');
  assert.equal(events.filter((e) => e.kind === 'text-delta').map((e) => e.text).join(''), 'OK');
  const end = events.at(-1).kind === 'turn-end' ? events.at(-1) : events.find((e) => e.kind === 'turn-end');
  assert.equal(end.subtype, 'success');
  assert.equal(end.isError, false);
  assert.equal(typeof end.cost, 'number');
  assert.equal(typeof end.durationMs, 'number');
  assert.equal(typeof end.turns, 'number');
  assert.equal(end.text, 'OK');
  assert.ok('fastState' in end && 'fastReason' in end);
});

test('status, tool progress, suggestions and command lists keep their fields', { skip: missing }, () => {
  const status = one(sys('status', { status: 'compacting', permissionMode: 'plan', compact_result: 'success', fast_mode_state: 'on' }));
  assert.deepEqual([status.kind, status.status, status.permissionMode, status.compactResult, status.fastState], ['status', 'compacting', 'plan', 'success', 'on']);
  const progress = one({ type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', elapsed_time_seconds: 3, parent_tool_use_id: null });
  assert.deepEqual([progress.kind, progress.id, progress.name, progress.elapsed], ['tool-progress', 't1', 'Bash', 3]);
  assert.deepEqual(one({ type: 'prompt_suggestion', suggestion: 'run the tests' }), { kind: 'suggestion', text: 'run the tests' });
  const changed = one(sys('commands_changed', { commands: [{ name: 'x' }] }));
  assert.deepEqual([changed.kind, changed.commands], ['commands-changed', [{ name: 'x' }]]);
});

test('compaction is announced with the exact text the renderer matches', { skip: missing }, () => {
  const ev = one(sys('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 9000, duration_ms: 4200 } }));
  assert.equal(ev.kind, 'notice');
  assert.equal(ev.text, 'Conversation compacted');
});

test('subagent output keeps its parent, and subagent stream deltas are not forwarded', { skip: missing }, () => {
  const text = one({ type: 'assistant', parent_tool_use_id: 'toolu_p', uuid: 'u', session_id: 's', message: { model: 'm', content: [{ type: 'text', text: 'from the subagent' }] } });
  assert.equal(text.parent, 'toolu_p');
  assert.deepEqual(adapt({ type: 'stream_event', parent_tool_use_id: 'toolu_p', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } }), []);
  const result = one({ type: 'user', parent_tool_use_id: 'toolu_p', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], is_error: true }] } });
  assert.deepEqual([result.kind, result.id, result.isError, result.parent], ['tool-result', 't9', true, 'toolu_p']);
  assert.match(result.content, /a[\s\S]*b/);
});

test('replayed user frames are ignored and live context text never becomes a user bubble', { skip: missing }, () => {
  assert.deepEqual(adapt({ type: 'user', isReplay: true, message: { role: 'user', content: 'hello' } }), []);
  assert.deepEqual(adapt({ type: 'user', message: { role: 'user', content: '<system-reminder>internal</system-reminder>' } }), []);
  const live = adapt({ type: 'user', message: { role: 'user', content: 'injected by a hook' } });
  assert.ok(!live.some((e) => e.kind === 'user-text'));
});

test('empty thinking blocks produce nothing', { skip: missing }, () => {
  const out = adapt({ type: 'assistant', parent_tool_use_id: null, message: { model: 'm', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'hi' }] } });
  assert.deepEqual(kinds(out), ['assistant-text']);
});

// ---- the stateful adapter (createAdapter) ----

test('no recorded frame becomes a raw event unless debug is on', { skip: v2 }, () => {
  for (const make of [() => ({ adapt }), () => A.createAdapter({})]) {
    const a = make();
    for (const m of ALL_LIVE) {
      const raw = a.adapt(m).filter((e) => e.kind === 'raw');
      assert.deepEqual(raw.map((e) => e.label), [], `raw for ${m.type}/${m.subtype ?? m.event?.type ?? ''}`);
    }
  }
});

test('frames Session consumes itself adapt to nothing', { skip: v2 }, () => {
  const quiet = [
    sys('session_state_changed', { state: 'running' }), sys('background_tasks_changed', { tasks: [] }), sys('files_persisted', { files: [], failed: [] }),
    sys('elicitation_complete', { mcp_server_name: 'x', elicitation_id: 'e' }), sys('plugin_install', { status: 'started' }), sys('control_request_progress', {}),
    sys('mirror_error', { error: 'x' }), sys('worker_shutting_down', {}), sys('ui_invalidate', {}), sys('task_progress', { task_id: 't' }), sys('task_updated', { task_id: 't', patch: {} }),
    { type: 'command_lifecycle', command_uuid: 'c', state: 'queued' }, { type: 'active_goal', goal: 'x' }, { type: 'keep_alive' }, { type: 'tool_use_summary', summary: 'x', preceding_tool_use_ids: [] },
  ];
  for (const m of quiet) assert.deepEqual(adapt(m, { debug: true }), [], `${m.type}/${m.subtype ?? ''}`);
});

test('unknown frames are raw only with debug, and capped', { skip: v2 }, () => {
  assert.deepEqual(adapt({ type: 'from_the_future', payload: 1 }), []);
  assert.deepEqual(adapt(sys('from_the_future')), []);
  const ev = one({ type: 'from_the_future', payload: 'x'.repeat(40000) }, { debug: true });
  assert.equal(ev.kind, 'raw');
  assert.ok(JSON.stringify(ev).length < 12000, 'the payload is capped at about 8 KB');
  assert.equal(ev.truncated, true);
  assert.equal(one(sys('from_the_future'), { debug: true }).kind, 'raw');
});

test('init adds the new fields and never forwards the messaging socket', { skip: v2 }, () => {
  const frame = toolTurn.find((m) => m.subtype === 'init');
  assert.ok(frame.messaging_socket_path, 'the fixture carries the socket path');
  const ev = one(frame);
  assert.ok(Array.isArray(ev.agents) && ev.agents.length > 0);
  assert.equal(ev.outputStyle, 'default');
  assert.ok(ev.capabilities.includes('msg_lifecycle_v1'));
  assert.ok(Array.isArray(ev.terminalCommands));
  assert.ok('memoryPaths' in ev);
  assert.ok(!JSON.stringify(ev).includes(frame.messaging_socket_path));
  assert.ok(!Object.keys(ev).some((k) => /socket/i.test(k)));
  const marked = one({ ...frame, user_message_uuids: ['a', 'b'] });
  assert.deepEqual(marked.userUuids, ['a', 'b']);
});

test('status carries compact errors and the sends it belongs to', { skip: v2 }, () => {
  const ev = one(sys('status', { status: 'requesting', user_message_uuids: ['a'], compact_error: 'too long' }));
  assert.deepEqual(ev.userUuids, ['a']);
  assert.equal(ev.compactError, 'too long');
});

test('compaction notice carries its numbers', { skip: v2 }, () => {
  const ev = one(sys('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 9000, duration_ms: 4200 } }));
  assert.equal(ev.code, 'compacted');
  assert.deepEqual(ev.compact, { trigger: 'auto', preTokens: 180000, postTokens: 9000, durationMs: 4200 });
});

test('hook frames carry id, event, stderr and outcome', { skip: v2 }, () => {
  const ev = one(sys('hook_response', { hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', output: '', stdout: 'out', stderr: 'warn', exit_code: 2, outcome: 'error' }));
  assert.deepEqual([ev.kind, ev.subtype, ev.id, ev.event, ev.name, ev.output, ev.stderr, ev.exitCode, ev.outcome],
    ['hook', 'hook_response', 'h1', 'SessionStart', 'SessionStart:startup', 'out', 'warn', 2, 'error']);
  const started = one(sys('hook_started', { hook_id: 'h1', hook_event: 'Setup' }));
  assert.equal(started.name, 'Setup');
  assert.equal(started.output, '');
});

test('task frames: started and notification are events, ambient ones are not', { skip: v2 }, () => {
  const started = one(sys('task_started', { task_id: 't1', run_id: 'r1', tool_use_id: 'toolu_1', description: 'Explore the repo', subagent_type: 'Explore', task_type: 'local_agent', is_backgrounded: true }));
  assert.deepEqual([started.kind, started.subtype, started.taskId, started.runId, started.toolUseId, started.agentType, started.taskType, started.description, started.status, started.backgrounded],
    ['task', 'task_started', 't1', 'r1', 'toolu_1', 'Explore', 'local_agent', 'Explore the repo', 'running', true]);
  const done = one(sys('task_notification', { task_id: 't1', status: 'completed', summary: 'Found 3 files', output_file: '/tmp/out.txt', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 } }));
  assert.deepEqual([done.status, done.summary, done.description, done.outputFile], ['completed', 'Found 3 files', 'Found 3 files', '/tmp/out.txt']);
  assert.deepEqual(done.usage, { total_tokens: 10, tool_uses: 1, duration_ms: 5 });
  assert.deepEqual(adapt(sys('task_started', { task_id: 't2', description: 'housekeeping', ambient: true })), []);
  assert.deepEqual(adapt(sys('task_notification', { task_id: 't2', status: 'completed', summary: 'x', output_file: '', skip_transcript: true })), []);
});

test('retries, thinking progress and sign-in become status values', { skip: v2 }, () => {
  const retry = one(sys('api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' }));
  assert.deepEqual([retry.kind, retry.status, retry.attempt, retry.maxRetries, retry.retryDelayMs, retry.errorStatus, retry.error], ['status', 'retrying', 2, 10, 4000, 529, 'overloaded']);
  const thinking = one(sys('thinking_tokens', { estimated_tokens: 120, estimated_tokens_delta: 20 }));
  assert.deepEqual([thinking.kind, thinking.status, thinking.thinkingTokens], ['status', 'thinking', 120]);
  const auth = one({ type: 'auth_status', isAuthenticating: true, output: [] });
  assert.deepEqual([auth.kind, auth.status], ['status', 'authenticating']);
  assert.deepEqual(adapt({ type: 'auth_status', isAuthenticating: false, output: [] }), []);
});

test('thinking progress does not overwrite a compacting status', { skip: v2 }, () => {
  const a = A.createAdapter({});
  a.adapt(sys('status', { status: 'compacting' }));
  assert.deepEqual(a.adapt(sys('thinking_tokens', { estimated_tokens: 5, estimated_tokens_delta: 5 })), []);
  a.adapt(sys('status', { status: null }));
  assert.equal(a.adapt(sys('thinking_tokens', { estimated_tokens: 9, estimated_tokens_delta: 4 })).length, 1);
});

test('a chat being (re)named becomes a title event; a blank title is dropped', { skip: v2 }, () => {
  const ev = one(sys('session_title_changed', { title: '  Tidy   the release notes ' }));
  assert.deepEqual([ev.kind, ev.title, ev.sessionId], ['title', 'Tidy the release notes', 's-1']);
  assert.deepEqual(adapt(sys('session_title_changed', { title: '   ' })), []);
});

test('informational and notification frames become notices at the right level', { skip: v2 }, () => {
  const warn = one(sys('informational', { content: 'Hook blocked the edit', level: 'warning', tool_use_id: 'toolu_1', tag: 'hook', prevent_continuation: true }));
  assert.deepEqual([warn.kind, warn.text, warn.level, warn.tag, warn.toolUseId, warn.stops], ['notice', 'Hook blocked the edit', 'warn', 'hook', 'toolu_1', true]);
  assert.deepEqual(adapt(sys('informational', { content: 'fyi', level: 'info' })), []);
  const info = one(sys('informational', { content: 'fyi', level: 'info' }), { verbose: true });
  assert.equal(info.text, 'fyi');
  assert.notEqual(info.level, 'warn');
  const high = one(sys('notification', { key: 'k1', text: 'Update available', priority: 'high' }));
  assert.deepEqual([high.kind, high.text, high.key, high.level], ['notice', 'Update available', 'k1', 'warn']);
  assert.notEqual(one(sys('notification', { key: 'k2', text: 'tip', priority: 'medium' })).level, 'warn');
});

test('refusals, lost writes and local command output', { skip: v2 }, () => {
  const refusal = one(sys('model_refusal_no_fallback', { original_model: 'm', request_id: null, refused_user_message_uuid: 'u7', content: 'Claude declined to answer.' }));
  assert.deepEqual([refusal.kind, refusal.level, refusal.code, refusal.text, refusal.refusedUuid], ['notice', 'warn', 'model-refusal', 'Claude declined to answer.', 'u7']);
  const disk = one(sys('session_writes_lost', { error_code: 'ENOSPC', lost: ['transcript'] }));
  assert.deepEqual([disk.kind, disk.level, disk.code], ['notice', 'warn', 'disk-full']);
  assert.match(disk.text, /Disk is full/);
  assert.deepEqual(one(sys('local_command_output', { content: 'Set model to haiku' })), { kind: 'command-output', text: 'Set model to haiku', stream: 'stdout' });
});

test('permission_denied and memory_recall are silent unless verbose', { skip: v2 }, () => {
  for (const m of [sys('permission_denied', { tool_name: 'Bash', tool_use_id: 't', reason: 'rule' }), sys('memory_recall', { mode: 'select', memories: [] })]) {
    assert.deepEqual(adapt(m), []);
    const out = adapt(m, { verbose: true });
    assert.ok(out.every((e) => e.kind === 'notice'), m.subtype);
  }
});

test('stream events: message id, block index, and no ghost thinking', { skip: v2 }, () => {
  const start = one(toolTurn.find((m) => m.type === 'stream_event' && m.event.type === 'message_start'));
  assert.equal(start.kind, 'message-start');
  assert.match(start.messageId, /^msg_/);
  assert.equal(start.model, 'claude-haiku-5-5');
  const delta = one({ type: 'stream_event', parent_tool_use_id: null, api_message_id: 'msg_1', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'hi' } } });
  assert.deepEqual([delta.kind, delta.text, delta.index, delta.messageId], ['text-delta', 'hi', 2, 'msg_1']);
  assert.deepEqual(adapt({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } }), []);
  const thinking = interrupt.filter((m) => m.type === 'stream_event' && m.event.delta?.type === 'thinking_delta').flatMap((m) => adapt(m));
  assert.ok(thinking.length > 0, 'the fixture has summarized thinking');
  assert.ok(thinking.every((e) => e.kind === 'thinking-delta' && e.text.length > 0));
});

test('hitting the output limit is reported once', { skip: v2 }, () => {
  const ev = one({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} } });
  assert.deepEqual([ev.kind, ev.code], ['notice', 'max-output']);
  assert.deepEqual(adapt({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} } }), []);
});

test('tool streaming is opt-in: tool-pending on block start, throttled input deltas', { skip: v2 }, () => {
  const startFrame = toolTurn.find((m) => m.type === 'stream_event' && m.event.type === 'content_block_start' && m.event.content_block?.type === 'tool_use');
  assert.ok(startFrame, 'the fixture has a tool_use block start');
  assert.deepEqual(A.createAdapter({}).adapt(startFrame), []);
  const a = A.createAdapter({ toolStream: true });
  const pending = a.adapt(startFrame);
  assert.deepEqual(kinds(pending), ['tool-pending']);
  assert.equal(pending[0].name, 'Write');
  assert.match(pending[0].id, /^toolu_/);
  const deltas = [];
  for (let i = 0; i < 200; i++) deltas.push(...a.adapt({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: startFrame.event.index, delta: { type: 'input_json_delta', partial_json: '{"a":' } } }));
  assert.ok(deltas.every((e) => e.kind === 'tool-input-delta' && e.id === pending[0].id && Number.isFinite(e.bytes)));
  assert.ok(deltas.length < 20, `200 deltas in one tick produced ${deltas.length} events`);
});

// A show call as Claude Code streams it: the block opens, its JSON arrives in pieces, the finished call, the block closes.
const SHOW = 'mcp__canopy__show';
const showInput = { title: 'Usage', html: '<canopy-table>\nChat,Cost\nSidebar "drag",7.12\n</canopy-table>' };
function showFrames(pieces, { name = SHOW, id = 'toolu_show1', index = 1 } = {}) {
  const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
  return {
    open: ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }),
    deltas: pieces.map((partial_json) => ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
    whole: { type: 'assistant', uuid: 'u-show', parent_tool_use_id: null, message: { id: 'msg_1', model: 'claude-x', content: [{ type: 'tool_use', id, name, input: showInput }] } },
    close: ev({ type: 'content_block_stop', index }),
  };
}
const chop = (text, size) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'));

test('a followed tool streams its input as it is written: whole snapshots that only grow', { skip: v2 }, () => {
  let now = 0;
  const a = A.createAdapter({ inputStream: (name) => name === SHOW, now: () => now });
  const f = showFrames(chop(JSON.stringify(showInput), 7));
  const first = a.adapt(f.open);
  assert.deepEqual(first, [{ kind: 'tool-input-partial', id: 'toolu_show1', name: SHOW, input: {}, bytes: 0, messageId: null }], 'its place is taken before any input');
  const partials = [];
  for (const d of f.deltas) { now += 100; partials.push(...a.adapt(d)); }
  assert.equal(partials.length, f.deltas.length, 'one snapshot per piece when they arrive slowly');
  let html = '';
  for (const p of partials) {
    assert.deepEqual([p.kind, p.id, p.name], ['tool-input-partial', 'toolu_show1', SHOW]);
    if (p.input.title !== undefined) assert.ok(showInput.title.startsWith(p.input.title));
    if (p.input.html !== undefined) { assert.ok(showInput.html.startsWith(p.input.html)); assert.ok(p.input.html.length >= html.length); html = p.input.html; }
  }
  assert.deepEqual(partials.at(-1).input, showInput, 'the last snapshot is the whole input');
  assert.equal(partials.at(-1).bytes, JSON.stringify(showInput).length);
  // The finished call, then the block closing: nothing partial after the whole input.
  assert.deepEqual(kinds(a.adapt(f.whole)), ['tool-start']);
  assert.deepEqual(a.adapt(f.close), []);
});

test('streamed input is throttled, and what the throttle held back is not lost', { skip: v2 }, () => {
  let now = 0;
  const a = A.createAdapter({ inputStream: () => true, now: () => now });
  const f = showFrames(chop(JSON.stringify(showInput), 2));
  a.adapt(f.open);
  const fast = f.deltas.flatMap((d) => a.adapt(d)); // all in the same instant
  assert.equal(fast.length, 1, 'one snapshot for a burst');
  // A Claude Code that closes the block before sending the finished call: the rest is said at the close.
  const tail = a.adapt(f.close);
  assert.deepEqual(kinds(tail), ['tool-input-partial']);
  assert.deepEqual(tail[0].input, showInput);
  // When the finished call came first, the close says nothing.
  const b = A.createAdapter({ inputStream: () => true, now: () => now });
  b.adapt(f.open);
  for (const d of f.deltas) b.adapt(d);
  b.adapt(f.whole);
  assert.deepEqual(b.adapt(f.close), []);
});

test('only the tools asked for are followed, and never a subagent\'s', { skip: v2 }, () => {
  const f = showFrames(['{"file_path":"/tmp/a"}'], { name: 'Write' });
  const a = A.createAdapter({ inputStream: (name) => name === SHOW });
  assert.deepEqual([f.open, ...f.deltas, f.close].flatMap((m) => a.adapt(m)), []);
  assert.deepEqual(A.createAdapter({}).adapt(showFrames(['{}']).open), [], 'off unless asked for');
  assert.deepEqual(A.adapt(showFrames(['{}']).open, { inputStream: () => true }), [], 'needs the adapter\'s memory');
  const sub = showFrames(['{"title":"x"}']);
  const c = A.createAdapter({ inputStream: () => true });
  assert.deepEqual([sub.open, ...sub.deltas].map((m) => ({ ...m, parent_tool_use_id: 'toolu_agent' })).flatMap((m) => c.adapt(m)), []);
  // A predicate that throws follows nothing.
  assert.deepEqual(A.createAdapter({ inputStream: () => { throw new Error('boom'); } }).adapt(showFrames(['{}']).open), []);
});

test('following input and counting bytes (toolStream) work together', { skip: v2 }, () => {
  let now = 0;
  const a = A.createAdapter({ inputStream: () => true, toolStream: true, now: () => now });
  const f = showFrames(['{"title":"U', 'sage"}']);
  assert.deepEqual(kinds(a.adapt(f.open)), ['tool-pending', 'tool-input-partial']);
  now += 200;
  assert.deepEqual(kinds(a.adapt(f.deltas[0])), ['tool-input-partial', 'tool-input-delta']);
  now += 200;
  const last = a.adapt(f.deltas[1]);
  assert.deepEqual(last.find((e) => e.kind === 'tool-input-partial').input, { title: 'Usage' });
});

test('an input too large to follow stops streaming; the finished call still arrives whole', { skip: v2 }, () => {
  let now = 0;
  const a = A.createAdapter({ inputStream: () => true, now: () => now });
  const f = showFrames(['{"html":"', 'x'.repeat(600 * 1024), 'more']);
  a.adapt(f.open);
  now += 100; assert.equal(a.adapt(f.deltas[0]).length, 1);
  now += 100; assert.deepEqual(a.adapt(f.deltas[1]), [], 'past the limit');
  now += 100; assert.deepEqual(a.adapt(f.deltas[2]), []);
  assert.deepEqual(a.adapt(f.close), []);
  assert.deepEqual(kinds(a.adapt(f.whole)), ['tool-start']);
});

test('assistant events carry uuid, message id, time and the aborted flag', { skip: v2 }, () => {
  const frame = toolTurn.filter((m) => m.type === 'assistant').at(-1);
  const text = one(frame);
  assert.equal(text.uuid, frame.uuid);
  assert.equal(text.messageId, frame.message.id);
  assert.equal(text.at, Date.parse(frame.timestamp));
  const tool = adapt(toolTurn.find((m) => m.type === 'assistant')).find((e) => e.kind === 'tool-start');
  assert.match(tool.uuid, /^[0-9a-f-]{36}$/);
  const aborted = adapt(interrupt.find((m) => m.type === 'assistant' && m.aborted)).find((e) => e.kind === 'assistant-text');
  assert.equal(aborted.aborted, true);
});

test('synthetic assistant messages never leak the synthetic model name', { skip: v2 }, () => {
  const synthetic = (text, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, uuid: 'u', session_id: 's', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
  const local = adapt(localCommand.find((m) => m.type === 'assistant'));
  assert.deepEqual(kinds(local), ['command-output']);
  assert.match(local[0].text, /Context Usage/);

  const apiError = adapt(synthetic('API Error: 401 {"type":"error"}', { error: 'authentication_failed' }));
  assert.equal(apiError.length, 1, 'one notice, no bubble');
  assert.deepEqual([apiError[0].kind, apiError[0].level, apiError[0].code, apiError[0].apiError], ['notice', 'warn', 'api-error', 'authentication_failed']);
  assert.equal(apiError[0].text, 'You are signed out. Run /login or sign in again.');
  assert.equal(adapt(synthetic('boom', { error: 'rate_limit' }))[0].text, 'You hit a rate limit. Try again in a moment.');
  assert.equal(adapt(synthetic('Some unmapped failure', { error: 'unknown' }))[0].text, 'Some unmapped failure');

  assert.deepEqual(adapt(synthetic('No response requested.')), []);
  const plain = one(synthetic('Tool use was rejected.'));
  assert.deepEqual([plain.kind, plain.synthetic], ['assistant-text', true]);
  for (const ev of [...local, ...apiError, plain]) assert.ok(!JSON.stringify(ev).includes('<synthetic>'));
});

test('tool results: structured payload, time, uuid, and bounded size', { skip: v2 }, () => {
  const frame = toolTurn.find((m) => m.type === 'user');
  const ev = one(frame);
  assert.equal(ev.uuid, frame.uuid);
  assert.equal(ev.at, Date.parse(frame.timestamp));
  assert.deepEqual(ev.structured, frame.tool_use_result);
  assert.ok(!ev.truncated);

  const big = one({ type: 'user', parent_tool_use_id: null, uuid: 'u', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `HEAD${'x'.repeat(400000)}TAIL` }] } });
  assert.equal(big.truncated, true);
  assert.equal(big.fullLength, 400008);
  assert.ok(big.content.length <= 140000, `content is ${big.content.length} chars`);
  assert.ok(big.content.startsWith('HEAD') && big.content.endsWith('TAIL'), 'head and tail are kept');

  const mixed = one({ type: 'user', parent_tool_use_id: null, uuid: 'u', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [
    { type: 'text', text: 'see' }, { type: 'tool_reference', tool_name: 'Grep' }, { type: 'document', source: {} }, { type: 'mystery' },
    ...Array.from({ length: 6 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })),
  ] }] } });
  assert.match(mixed.content, /see/);
  assert.match(mixed.content, /\[tool: Grep\]/);
  assert.match(mixed.content, /\[document\]/);
  assert.match(mixed.content, /\[mystery\]/);
  assert.ok(!mixed.content.includes('AAAA'), 'image data never lands in the text');
  assert.equal(mixed.images.length, 4);
  assert.equal(mixed.imagesOmitted, 2);
});

// A chat is redrawn from its saved rows every time it is switched to: without its pictures, the screenshot of a
// look Claude took while the user was in another chat would never be seen.
test('a saved chat keeps the pictures of its latest few tool results, and the words of the rest', { skip: v2 }, () => {
  const LOOK = 'mcp__canopy_look__look';
  const shot = (n, size = 8) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: String(n).repeat(size) } });
  const call = (id) => ({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: LOOK, input: { url: 'http://localhost:3000/' } }] } });
  const result = (id, content) => ({ type: 'user', uuid: `u-${id}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const rows = [{ type: 'user', uuid: 'p', message: { role: 'user', content: 'check the page at a few sizes' } }];
  for (let i = 1; i <= 6; i++) rows.push(call(`look_${i}`), result(`look_${i}`, [shot(i), { type: 'text', text: `caption ${i}` }]));
  rows.push(call('words'), result('words', 'no picture here'));
  const results = (events) => Object.fromEntries(events.filter((e) => e.kind === 'tool-result').map((e) => [e.id, e]));

  const got = results(A.adaptHistory(rows));
  assert.deepEqual(Object.keys(got).filter((id) => got[id].images.length), ['look_3', 'look_4', 'look_5', 'look_6'], 'the latest four that have a picture');
  assert.deepEqual(got.look_6.images, [{ mediaType: 'image/png', data: '66666666' }]);
  assert.equal(got.look_6.content, '[image]\ncaption 6');
  assert.deepEqual([got.look_1.images, got.look_1.imagesOmitted, got.look_1.content], [[], 1, '[image]\ncaption 1'], 'an older one keeps its caption');
  // Any iterable of rows, as before.
  assert.equal(results(A.adaptHistory(new Set(rows))).look_6.images.length, 1);
  // A host that wants none, or all of them, says so.
  assert.ok(Object.values(results(A.adaptHistory(rows, { images: false }))).every((e) => e.images.length === 0));
  assert.equal(Object.values(results(A.adaptHistory(rows, { images: true }))).filter((e) => e.images.length).length, 6);
  // Heavy pictures: the latest that fit together in about 5 MB, never more.
  const heavy = [call('h1'), result('h1', [shot(1, 3_000_000)]), call('h2'), result('h2', [shot(2, 1_500_000)]), call('h3'), result('h3', [shot(3, 1_500_000)])];
  const kept = results(A.adaptHistory(heavy));
  assert.deepEqual(Object.keys(kept).filter((id) => kept[id].images.length), ['h2', 'h3']);
  // A live result is not touched by any of this.
  assert.equal(one(result('look_1', [shot(1)])).images.length, 1);
});

test('an oversized structured result is slimmed, and never attached to a multi-result frame', { skip: v2 }, () => {
  const huge = { type: 'update', filePath: '/tmp/a.txt', structuredPatch: [{ oldStart: 1, lines: ['+a'] }], originalFile: 'y'.repeat(300000), backgroundTaskId: 'b1' };
  const ev = one({ type: 'user', parent_tool_use_id: null, uuid: 'u', tool_use_result: huge, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
  assert.equal(ev.structured.truncated, true);
  assert.deepEqual([ev.structured.type, ev.structured.filePath, ev.structured.backgroundTaskId], ['update', '/tmp/a.txt', 'b1']);
  assert.ok(!('originalFile' in ev.structured));
  const two = adapt({ type: 'user', parent_tool_use_id: null, uuid: 'u', tool_use_result: { type: 'create' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }, { type: 'tool_result', tool_use_id: 'b', content: '2' }] } });
  assert.deepEqual(kinds(two), ['tool-result', 'tool-result']);
  assert.ok(two.every((e) => e.structured == null));
});

test('live user frames: interrupt markers and task notifications are dropped', { skip: v2 }, () => {
  assert.deepEqual(adapt(interrupt.find((m) => m.type === 'user')), []);
  assert.deepEqual(adapt({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '[Request interrupted by user for tool use]' } }), []);
  assert.deepEqual(adapt({ type: 'user', parent_tool_use_id: null, origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification><task-id>t1</task-id></task-notification>' } }), []);
  assert.deepEqual(adapt({ type: 'user', parent_tool_use_id: 'toolu_p', message: { role: 'user', content: 'the prompt handed to a subagent' } }), []);
});

test('a message from another chat shows where a prompt goes, marked as not the user\'s, once', { skip: v2 }, () => {
  const wrapped = '<cross-session-message from="uds:/tmp/claude-501/abc.sock">\nCan you rebase onto main? I just merged the sidebar fix.\n</cross-session-message>';
  const peer = (extra = {}) => ({
    type: 'user', uuid: 'p-1', session_id: 's-1', parent_tool_use_id: null, isReplay: true, timestamp: '2026-11-16T10:00:00.000Z',
    origin: { kind: 'peer', from: 'uds:/tmp/claude-501/abc.sock', name: 'Sidebar fix' }, message: { role: 'user', content: wrapped }, ...extra,
  });
  // Live, Claude Code echoes it as a replay once it is taken up. Other replays are the host's own sends: still silent.
  const a = A.createAdapter();
  const ev = a.adapt(peer());
  assert.deepEqual(ev, [{
    kind: 'user-text', text: 'Can you rebase onto main? I just merged the sidebar fix.', images: 0, documents: 0, origin: 'peer', from: 'Sidebar fix',
    fromAddr: A.chatKey('uds:/tmp/claude-501/abc.sock'), // a fingerprint, so a reply sent there can be shown with the name
    uuid: 'p-1', at: Date.parse('2026-11-16T10:00:00.000Z'),
  }]);
  assert.deepEqual(a.adapt(peer()), [], 'the same message again says nothing');
  assert.deepEqual(a.adapt(peer({ isReplay: undefined })), [], 'whichever way it comes');
  assert.equal(a.adapt(peer({ uuid: 'p-2', isReplay: undefined })).length, 1, 'a frame that is not a replay is shown as well');
  assert.deepEqual(a.adapt({ type: 'user', uuid: 'h-1', parent_tool_use_id: null, isReplay: true, origin: { kind: 'human' }, message: { role: 'user', content: 'typed here' } }), []);
  assert.deepEqual(a.adapt(peer({ uuid: 'p-3', parent_tool_use_id: 'toolu_1' })), [], 'not one handed to a subagent');

  // The text is what the model read, without the wrapper, when Claude Code gives it; the address is never shown.
  const exact = one(peer({ uuid: 'p-4', origin: { kind: 'peer', from: 'uds:/tmp/x.sock', body: 'exact body' } }));
  assert.deepEqual([exact.text, exact.from], ['exact body', '']);
  assert.ok(!JSON.stringify(exact).includes('uds:'));
  // Text that is not the one wrapper is shown as it came.
  assert.equal(one(peer({ uuid: 'p-5', message: { role: 'user', content: [{ type: 'text', text: 'plain words' }] } })).text, 'plain words');

  // Read back from the saved conversation it is the same bubble.
  const { isReplay, ...row } = peer();
  const [saved] = A.adaptHistory([row]);
  assert.deepEqual([saved.kind, saved.text, saved.origin, saved.from], ['user-text', 'Can you rebase onto main? I just merged the sidebar fix.', 'peer', 'Sidebar fix']);
  assert.deepEqual(A.adaptHistory([peer()]), [], 'a replay in a saved conversation is still not a message');
});

test('a message from another chat that is held or dropped is said in one line', { skip: v2 }, () => {
  const drift = [];
  const opts = { unknown: (label) => drift.push(label) };
  const held = one(sys('peer_message_hold', { state: 'held', lane: 'socket', from: '', from_name: 'Sidebar fix', cause: 'policy-hold', message_uuid: 'm-1' }), opts);
  assert.deepEqual([held.kind, held.level, held.code], ['notice', 'warn', 'peer-held']);
  assert.match(held.text, /^A message from another chat \(Sidebar fix\) is being held: your Claude Code settings hold /);
  // Held because the two chats are not in the same kind of mode: said as that, with what lets it through.
  for (const cause of ['mode-mismatch', 'no-mode-asserted']) {
    const parity = one(sys('peer_message_hold', { state: 'held', lane: 'socket', from: '', cause }), opts);
    assert.equal(parity.code, 'peer-held');
    assert.match(parity.text, /^A message from another chat is being held: one of the two chats asks before acting and the other runs without asking, .* Put both chats in the same mode and send it again\.$/);
  }
  const dropped = one(sys('peer_message_hold', { state: 'dropped', lane: 'socket', from: '', outcome: 'expired' }), opts);
  assert.deepEqual([dropped.code, dropped.text], ['peer-dropped', 'The held message from another chat was not delivered.']);
  // Let through: the message itself follows.
  assert.deepEqual(adapt(sys('peer_message_hold', { state: 'released', lane: 'socket', from: '' }), opts), []);
  assert.deepEqual(drift, [], 'a frame the adapter knows');
});

test('local command output: every block, stderr marked, ANSI stripped, empties skipped', { skip: v2 }, () => {
  const text = '<local-command-stdout>\u001b[1mBold\u001b[0m line</local-command-stdout><local-command-stderr>bad</local-command-stderr>';
  const out = adapt({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } });
  assert.deepEqual(out.map((e) => [e.kind, e.text, e.stream]), [['command-output', 'Bold line', 'stdout'], ['command-output', 'bad', 'stderr']]);
  assert.deepEqual(adapt({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } }), []);
  assert.deepEqual(adapt({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout>(no content)</local-command-stdout>' } }), []);
  const quoted = adapt({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Why does my log say <local-command-stdout>x</local-command-stdout>?' } }, { history: true });
  assert.deepEqual(kinds(quoted), ['user-text'], 'a prompt that merely quotes the tag is still a prompt');
  const mention = adapt({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'what does <command-name> mean in the logs?' } }, { history: true });
  assert.equal(mention[0].text, 'what does <command-name> mean in the logs?');
});

test('a saved /model and what it printed are not shown again: the chat says "Switched to" itself', { skip: v2 }, () => {
  const saved = (content) => adapt({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } }, { history: true });
  assert.deepEqual(saved('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>'), []);
  assert.deepEqual(saved('<local-command-stdout>Set model to `opus (claude-opus-5-5)`</local-command-stdout>'), []);
  assert.deepEqual(saved('<local-command-stdout>Kept model as `opus`</local-command-stdout>'), []);
  assert.deepEqual(saved('<command-name>/compact</command-name>\n<command-args></command-args>').map((e) => e.text), ['/compact'], 'other commands still show');
  assert.deepEqual(kinds(saved('<local-command-stdout>Compacted</local-command-stdout>')), ['command-output']);
});

test('turn end: interrupted turns are not errors', { skip: v2 }, () => {
  const ev = one(interrupt.find((m) => m.type === 'result'));
  assert.equal(ev.interrupted, true);
  assert.equal(ev.isError, false);
  assert.deepEqual(ev.errors, []);
  assert.equal(ev.terminalReason, 'aborted_streaming');
  const tools = one({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: ['[ede_diagnostic] x'], num_turns: 1, duration_ms: 1, total_cost_usd: 0 });
  assert.equal(tools.interrupted, true);
});

test('turn end: the new accounting fields', { skip: v2 }, () => {
  const frame = toolTurn.find((m) => m.type === 'result');
  const ev = one(frame);
  assert.equal(ev.interrupted, false);
  assert.deepEqual(ev.errors, []);
  assert.equal(ev.cost, frame.total_cost_usd);
  const turnCost = Object.values(frame.model_usage_since_last_result).reduce((n, u) => n + (u.costUSD ?? 0), 0);
  assert.ok(Math.abs(ev.turnCost - turnCost) < 1e-9);
  assert.deepEqual(ev.userUuids, frame.user_message_uuids);
  assert.equal(ev.userUuid, frame.user_message_uuid);
  assert.equal(ev.sessionId, frame.session_id);
  assert.equal(ev.stopReason, 'end_turn');
  assert.equal(ev.terminalReason, 'completed');
  assert.equal(ev.apiMs, frame.duration_api_ms);
  assert.equal(ev.queued, frame.queued_turn_count);
  assert.deepEqual(ev.modelUsage, frame.modelUsage);
  assert.deepEqual(ev.usage, frame.usage);
  assert.deepEqual(ev.denials, []);
  assert.equal(ev.errorCode ?? null, null);
  const cleared = one(clear.find((m) => m.type === 'result'));
  assert.equal(cleared.localCommand, 'clear');
  const noUsage = one({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0.2, result: 'x' });
  assert.equal(noUsage.turnCost, null, 'without per-turn usage the turn cost is unknown, not zero');
});

test('turn end: error codes and reasons', { skip: v2 }, () => {
  const result = (extra) => one({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, total_cost_usd: 0, errors: ['boom'], ...extra });
  assert.equal(result({ subtype: 'error_max_turns' }).errorCode, 'max-turns');
  assert.equal(result({ subtype: 'error_max_turns' }).reason, 'Stopped: turn limit reached.');
  assert.equal(result({ subtype: 'error_max_budget_usd' }).errorCode, 'budget');
  assert.equal(result({ subtype: 'error_max_budget_usd' }).reason, 'Stopped: spending limit reached.');
  assert.equal(result({ api_error_status: 401 }).errorCode, 'auth');
  assert.equal(result({ api_error_status: 403 }).errorCode, 'auth');
  assert.equal(result({ api_error_status: 429 }).errorCode, 'rate-limit');
  assert.equal(result({ api_error_status: 529 }).errorCode, 'overloaded');
  assert.equal(result({ api_error_status: 500 }).errorCode, 'overloaded');
  const plain = result({});
  assert.equal(plain.isError, true);
  assert.deepEqual(plain.errors, ['boom']);
  const noErrors = one({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'x' });
  assert.deepEqual(noErrors.errors, [], 'errors is always an array');
});

test('tool progress carries its parent and task', { skip: v2 }, () => {
  const ev = one({ type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', elapsed_time_seconds: 3, parent_tool_use_id: 'toolu_p', task_id: 'task-1' });
  assert.deepEqual([ev.parent, ev.taskId], ['toolu_p', 'task-1']);
});

test('rate limits: rejected, warning (once), allowed (never)', { skip: v2 }, () => {
  const info = (rate_limit_info) => ({ type: 'rate_limit_event', rate_limit_info, uuid: 'u', session_id: 's' });
  const rejected = one(info({ status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour' }));
  assert.deepEqual([rejected.kind, rejected.level, rejected.code], ['notice', 'warn', 'rate-limit']);
  assert.equal(rejected.resetsAt, 1900000000000, 'seconds are converted to milliseconds');
  assert.equal(one(info({ status: 'rejected', resetsAt: 1900000000000 })).resetsAt, 1900000000000);
  assert.equal(rejected.rateLimit.status, 'rejected');
  assert.match(rejected.text, /^Usage limit reached/);
  assert.deepEqual(adapt(info({ status: 'allowed' })), []);

  const a = A.createAdapter({});
  const warning = info({ status: 'allowed_warning', resetsAt: 1900000000, rateLimitType: 'seven_day', utilization: 0.91 });
  const first = a.adapt(warning);
  assert.deepEqual([first[0].kind, first[0].code], ['notice', 'rate-limit-warning']);
  assert.match(first[0].text, /^Approaching your usage limit/);
  assert.deepEqual(a.adapt(warning), [], 'the same warning is not repeated');
  assert.equal(a.adapt(info({ status: 'rejected', resetsAt: 1900000000, rateLimitType: 'seven_day' })).length, 1);
});

test('no notice starts with the strings the renderer rewrites', { skip: v2 }, () => {
  const frames = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
    { type: 'auth_status', isAuthenticating: false, output: ['x'], error: 'token expired' },
  ];
  for (const m of frames) for (const ev of adapt(m)) assert.doesNotMatch(String(ev.text ?? ''), /^(Rate limited|Auth: )/);
  const auth = one(frames[2]);
  assert.deepEqual([auth.kind, auth.level, auth.code], ['notice', 'warn', 'auth']);
  assert.match(auth.text, /^Sign-in problem: /);
});

test('/clear is announced as a conversation reset', { skip: v2 }, () => {
  const frame = clear.find((m) => m.type === 'conversation_reset');
  const ev = one(frame);
  assert.deepEqual([ev.kind, ev.code, ev.reset, ev.trigger, ev.text], ['notice', 'conversation-reset', true, 'clear', 'Conversation cleared']);
  assert.equal(ev.at, Date.parse(frame.timestamp));
});

test('createAdapter instances do not share state', { skip: v2 }, () => {
  const a = A.createAdapter({});
  const b = A.createAdapter({});
  const warning = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' } };
  assert.equal(a.adapt(warning).length, 1);
  assert.equal(b.adapt(warning).length, 1);
});

test('the recorded interrupt replays as one clean stopped turn', { skip: v2 }, () => {
  const a = A.createAdapter({});
  const events = interrupt.flatMap((m) => a.adapt(m));
  assert.equal(events.filter((e) => e.kind === 'turn-end').length, 1);
  assert.ok(!events.some((e) => /Request interrupted/.test(e.text ?? '')));
  assert.ok(!events.some((e) => (e.errors ?? []).some((x) => /ede_diagnostic/.test(x))));
  assert.ok(!JSON.stringify(events).includes(meta.queuedId), 'nothing is rendered for the cancelled send');
});

// ---- drift: frames this adapter does not know ----

test('unknown frames and blocks are reported to opts.unknown with keys only, and stay out of the transcript', () => {
  const seen = [];
  const unknown = (label, keys) => seen.push([label, keys]);
  assert.deepEqual(adapt(sys('brand_new_thing', { secret: 'do not keep' }), { unknown }), []);
  assert.deepEqual(adapt({ type: 'mystery_frame', subtype: 'x', body: 1 }, { unknown }), []);
  const out = adapt({ type: 'assistant', uuid: 'u', session_id: 's', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'hologram', data: 'z' }, { type: 'text', text: 'hi' }] } }, { unknown });
  assert.deepEqual(kinds(out), ['assistant-text']);
  assert.deepEqual(seen.map(([l]) => l), ['system/brand_new_thing', 'mystery_frame/x', 'assistant/hologram']);
  assert.ok(seen[0][1].includes('secret') && !JSON.stringify(seen).includes('do not keep'), 'keys, never values');
});

test('known-silent frames are not drift, debug still shows unknown ones, and a throwing observer is harmless', () => {
  const seen = [];
  adapt(sys('session_state_changed'), { unknown: (l) => seen.push(l) });
  adapt({ type: 'keep_alive' }, { unknown: (l) => seen.push(l) });
  assert.deepEqual(seen, []);
  assert.deepEqual(kinds(adapt(sys('brand_new_thing'), { debug: true, unknown: () => { throw new Error('x'); } })), ['raw']);
});

// ---- the model on a turn's end, and the limit sentences ----

test('a turn\'s end names the model of the turn\'s last reply of its own, live and in a saved chat', { skip: v2 }, () => {
  const a = A.createAdapter({});
  const live = toolTurn.flatMap((m) => a.adapt(m));
  assert.equal(live.find((e) => e.kind === 'turn-end').model, 'claude-haiku-5-5');
  assert.equal(A.adaptHistory(toolTurn).find((e) => e.kind === 'turn-end').model, 'claude-haiku-5-5');
  assert.equal(adapt(toolTurn.find((m) => m.type === 'result')).at(-1).model, null, 'one frame alone knows no reply: no model, never a guess');

  // An agent's reply is not the turn's own, a later model wins, and the next turn starts with none.
  const said = (model, text, extra = {}) => ({ type: 'assistant', uuid: `u-${text}`, session_id: 's', message: { id: `m-${text}`, model, content: [{ type: 'text', text }] }, ...extra });
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', uuid: 'r' };
  const b = A.createAdapter({});
  b.adapt(said('claude-opus-5-5', 'first'));
  b.adapt(said('claude-haiku-5-5', 'from an agent', { parent_tool_use_id: 'toolu_agent' }));
  assert.equal(b.adapt(result).at(-1).model, 'claude-opus-5-5');
  assert.equal(b.adapt(result).at(-1).model, null, 'a turn with no reply of its own names none');
  b.adapt(said('claude-opus-5-5', 'a'));
  b.adapt(said('claude-fable-5-2', 'b'));
  assert.equal(b.adapt(result).at(-1).model, 'claude-fable-5-2', 'two models in one turn: the last one');
  // A saved chat: each turn's end takes its own turn's model.
  const user = (text) => ({ type: 'user', uuid: `user-${text}`, session_id: 's', message: { role: 'user', content: text } });
  const ends = A.adaptHistory([user('one'), said('claude-opus-5-5', 'x'), result, user('two'), said('claude-fable-5-2', 'y'), result, user('three'), result]).filter((e) => e.kind === 'turn-end');
  assert.deepEqual(ends.map((e) => e.model), ['claude-opus-5-5', 'claude-fable-5-2', null]);
});

test('a plain Claude chat\'s events are what they were before Codex chats were brought level, but for the model on its turn ends', { skip: v2 }, async () => {
  const { createHash } = await import('node:crypto');
  // Digests of every event the recorded sessions give, live and as history, taken from the adapter as it was
  // before that work (with a fixed clock for the frames that carry no time of their own). Taken again, unchanged
  // but for the ids, when the recordings' ids were replaced with made-up ones.
  const before = { 'live-tool-turn': '77ae6ab43ce851fb', 'live-interrupt': 'f5214b63a2cea810', 'live-local-command': '5a68b7cd6a67cc5d', 'live-clear': '1b1c8c878e456605', 'live-history': 'deb24a4d6339709b' };
  const realNow = Date.now;
  for (const [name, digest] of Object.entries(before)) {
    const frames = fixture(name);
    let events;
    Date.now = () => 1794801559000;
    try {
      const a = A.createAdapter({});
      events = [...frames.flatMap((m) => a.adapt(m)), ...A.adaptHistory(frames)];
    } finally { Date.now = realNow; }
    for (const e of events) assert.equal('model' in e && e.kind === 'turn-end', e.kind === 'turn-end', `${name}: every turn end has the field, as its last key`);
    const plain = events.map((e) => { if (e.kind !== 'turn-end') return e; const { model, ...rest } = e; return rest; });
    assert.equal(createHash('sha256').update(JSON.stringify(plain)).digest('hex').slice(0, 16), digest, name);
  }
});

test('the two limit notices say exactly what they always said', { skip: v2 }, () => {
  const today = new Date(); today.setHours(15, 10, 0, 0);
  const at = today.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const info = (rate_limit_info) => ({ type: 'rate_limit_event', rate_limit_info, uuid: 'u', session_id: 's' });
  const resetsAt = today.getTime();
  assert.equal(one(info({ status: 'rejected', resetsAt, rateLimitType: 'five_hour' })).text, `Usage limit reached (5-hour limit). It resets at ${at}.`);
  assert.equal(one(info({ status: 'rejected', resetsAt, rateLimitType: 'seven_day_opus' })).text, `Usage limit reached (weekly Opus limit). It resets at ${at}.`);
  assert.equal(one(info({ status: 'rejected', rateLimitType: 'overage' })).text, 'Usage limit reached (extra usage limit).');
  assert.equal(one(info({ status: 'rejected', resetsAt })).text, `Usage limit reached. It resets at ${at}.`);
  assert.equal(one(info({ status: 'rejected', rateLimitType: 'a-new-kind' })).text, 'Usage limit reached.');
  assert.equal(one(info({ status: 'allowed_warning', resetsAt, rateLimitType: 'seven_day', utilization: 0.82 })).text, `Approaching your usage limit (weekly limit, 82% used). It resets at ${at}.`);
  assert.equal(one(info({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 91 })).text, 'Approaching your usage limit (5-hour limit, 91% used).', 'a value well above 1 is a percentage already');
  assert.equal(one(info({ status: 'allowed_warning', rateLimitType: 'five_hour' })).text, 'Approaching your usage limit (5-hour limit).');
  assert.equal(one(info({ status: 'allowed_warning' })).text, 'Approaching your usage limit.');
  const later = one(info({ status: 'rejected', resetsAt: resetsAt + 3 * 86400000, rateLimitType: 'seven_day' }));
  assert.match(later.text, /^Usage limit reached \(weekly limit\)\. It resets on \w+, \w+ \d+ at /);
});

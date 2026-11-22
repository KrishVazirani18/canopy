// adaptHistory: replaying a stored conversation into Canopy events.
// Rows are in the shape getSessionMessages() returns at runtime (plan V8).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core, fixture } from '../helpers.mjs';

const A = await core('adapter.mjs');
const missing = A.__missing ? `adapter.mjs: ${A.__missing}` : false;
const v2 = missing || (typeof A.createAdapter === 'function' ? false : 'adapter.mjs does not export createAdapter');

const recorded = fixture('live-history');

let n = 0;
const row = (type, content, extra = {}) => ({
  type, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, session_id: 's-1', parent_tool_use_id: null, parent_agent_id: null,
  timestamp: new Date(1760000000000 + n * 1000).toISOString(), message: { role: type, content }, ...extra,
});
const user = (content, extra) => row('user', content, extra);
const assistant = (content, extra) => row('assistant', content, extra);
const kinds = (events) => events.map((e) => e.kind);

test('a recorded conversation replays in order', { skip: missing }, () => {
  const events = A.adaptHistory(recorded);
  const first = events[0];
  assert.equal(first.kind, 'user-text');
  assert.match(first.text, /^Use the Write tool/);
  const start = events.find((e) => e.kind === 'tool-start');
  const result = events.find((e) => e.kind === 'tool-result');
  assert.equal(start.name, 'Write');
  assert.equal(result.id, start.id);
  assert.ok(events.indexOf(start) < events.indexOf(result));
  assert.ok(events.some((e) => e.kind === 'assistant-text' && e.text === 'OK'));
  assert.ok(events.some((e) => e.kind === 'user-text' && /^Count from 1 to 400/.test(e.text)));
});

test('system rows are skipped and an empty history is fine', { skip: missing }, () => {
  assert.deepEqual(A.adaptHistory([]), []);
  assert.deepEqual(A.adaptHistory([{ type: 'system', subtype: 'init', session_id: 's' }]), []);
});

test('the interrupt marker is a notice, never a user bubble', { skip: v2 }, () => {
  const events = A.adaptHistory(recorded);
  assert.ok(!events.some((e) => e.kind === 'user-text' && /Request interrupted/.test(e.text)));
  assert.ok(!events.some((e) => e.kind === 'context-note' && /Request interrupted/.test(e.text)));
  const stopped = events.find((e) => e.kind === 'notice' && e.code === 'interrupted');
  assert.ok(stopped, 'the stop is shown');
  assert.equal(stopped.text, 'Stopped');
  assert.equal(stopped.history, true);
});

test('every replayed event has the uuid and time of its row, and nothing is raw', { skip: v2 }, () => {
  const events = A.adaptHistory(recorded);
  const uuids = new Set(recorded.map((m) => m.uuid));
  for (const ev of events) {
    assert.notEqual(ev.kind, 'raw');
    assert.ok(uuids.has(ev.uuid), `${ev.kind} has uuid ${ev.uuid}`);
    assert.ok(Number.isFinite(ev.at) && ev.at > 1.7e12, `${ev.kind} has at=${ev.at}`);
  }
});

test('a slash command row replays as what the user typed', { skip: v2 }, () => {
  const events = A.adaptHistory(recorded);
  const cmd = events.filter((e) => e.kind === 'user-text').at(-1);
  assert.equal(cmd.text, '/context');
});

test('a compact summary becomes the compaction notice plus a collapsed note', { skip: v2 }, () => {
  const events = A.adaptHistory([user('This session is being continued from a previous conversation. Summary: we fixed the parser.', { isCompactSummary: true })]);
  assert.deepEqual(kinds(events), ['notice', 'context-note']);
  assert.equal(events[0].text, 'Conversation compacted');
  assert.equal(events[0].code, 'compacted');
  assert.equal(events[0].history, true);
  assert.equal(events[1].compact, true);
  assert.match(events[1].text, /we fixed the parser/);
});

test('task notifications replay as task events, by origin or by their XML', { skip: v2 }, () => {
  const xml = '<task-notification>\n<task-id>t-42</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>\n<summary>Background build finished</summary>\n</task-notification>';
  for (const m of [user(xml, { origin: { kind: 'task-notification' } }), user(xml)]) {
    const events = A.adaptHistory([m]);
    assert.deepEqual(kinds(events), ['task']);
    const ev = events[0];
    assert.deepEqual([ev.subtype, ev.taskId, ev.toolUseId, ev.status, ev.history], ['task_notification', 't-42', 'toolu_9', 'completed', true]);
    assert.match(ev.description, /Background build finished/);
  }
});

test('bash mode rows replay as the command and its output', { skip: v2 }, () => {
  const events = A.adaptHistory([
    user('<bash-input>ls -la</bash-input>'),
    user('<bash-stdout>total 0\nfile.txt</bash-stdout><bash-stderr></bash-stderr>'),
    user('<bash-stdout></bash-stdout><bash-stderr>ls: nope: No such file</bash-stderr>'),
  ]);
  assert.deepEqual(events[0].kind, 'user-text');
  assert.equal(events[0].text, '! ls -la');
  const out = events.filter((e) => e.kind === 'command-output');
  assert.ok(out.some((e) => /file\.txt/.test(e.text) && e.stream !== 'stderr'));
  assert.ok(out.some((e) => /No such file/.test(e.text) && e.stream === 'stderr'));
  assert.ok(!events.some((e) => /<bash-/.test(e.text ?? '')), 'no tag leaks into the transcript');
});

test('a message of yours replays with the id it was saved under, and says when it was not typed as a message', { skip: v2 }, () => {
  // The id is what an edit cuts the conversation back to (Session.edit), so it has to be the row's own.
  const typed = user('fix the header');
  const command = user('<command-name>/review</command-name><command-args>src</command-args>');
  const shell = user('<bash-input>ls</bash-input>');
  const channel = user('deploy finished', { origin: { kind: 'channel' } });
  const [a, b, c, d] = A.adaptHistory([typed, command, shell, channel]).filter((e) => e.kind === 'user-text');
  assert.deepEqual([a.uuid, b.uuid, c.uuid, d.uuid], [typed.uuid, command.uuid, shell.uuid, channel.uuid]);
  assert.deepEqual([a.command, a.bash, a.origin], [undefined, undefined, undefined]);
  assert.deepEqual([b.text, b.command], ['/review src', true]);
  assert.deepEqual([c.text, c.bash], ['! ls', true]);
  assert.equal(d.origin, 'channel');
});

test('one user bubble per message, with attachment counts', { skip: v2 }, () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const withText = A.adaptHistory([user([image, image, { type: 'document', source: {} }, { type: 'text', text: 'what is in these?' }])]);
  assert.deepEqual(kinds(withText), ['user-text']);
  assert.deepEqual([withText[0].text, withText[0].images, withText[0].documents], ['what is in these?', 2, 1]);
  assert.equal(A.adaptHistory([user([image])])[0].text, '[image]');
  const three = A.adaptHistory([user([image, image, image])]);
  assert.deepEqual(kinds(three), ['user-text']);
  assert.equal(three[0].text, '[3 images]');
  assert.equal(three[0].images, 3);
});

test('synthetic assistant rows replay like live ones', { skip: v2 }, () => {
  const synthetic = (text, extra = {}) => assistant([{ type: 'text', text }], { ...extra, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } });
  assert.deepEqual(A.adaptHistory([synthetic('No response requested.')]), []);
  const events = A.adaptHistory([synthetic('API Error: 529', { error: 'overloaded' })]);
  assert.deepEqual(kinds(events), ['notice']);
  assert.equal(events[0].text, 'Claude is overloaded right now.');
  assert.ok(!JSON.stringify(A.adaptHistory([synthetic('Tool use was rejected.')])).includes('<synthetic>'));
});

test('a message steered into a running turn replays as part of that turn', { skip: v2 }, () => {
  // Claude Code saves a message it took in mid-turn as a queued command (getSessionMessages: isQueuedCommand). The
  // window keeps it inside the turn instead of starting a new one, and a step still open before it stays open.
  const events = A.adaptHistory([
    user('build the onboarding'),
    assistant([{ type: 'tool_use', id: 'toolu_run', name: 'Bash', input: { command: 'sleep 99' } }]),
    user('show it in a new window when done', { isQueuedCommand: true, origin: { kind: 'human' } }),
    user('and a fresh question'),
  ], { inFlight: true });
  const users = events.filter((e) => e.kind === 'user-text');
  assert.deepEqual(users.map((e) => [e.text, e.steered]), [['build the onboarding', undefined], ['show it in a new window when done', true], ['and a fresh question', undefined]]);
  assert.ok(events.some((e) => e.kind === 'tool-result' && e.id === 'toolu_run' && e.interrupted), 'the next ordinary message ends the turn as before');
  const running = A.adaptHistory([
    user('build the onboarding'),
    assistant([{ type: 'tool_use', id: 'toolu_run', name: 'Bash', input: { command: 'sleep 99' } }]),
    user('show it in a new window when done', { isQueuedCommand: true }),
  ], { inFlight: true });
  assert.ok(!running.some((e) => e.kind === 'tool-result'), 'the steer did not end the turn its step is running in');
});

test('a turn cut off by quitting the app says so', { skip: v2 }, () => {
  const events = A.adaptHistory([user('do the thing'), assistant([{ type: 'text', text: 'Working on' }], { interruptedByShutdown: true })]);
  const notice = events.find((e) => e.kind === 'notice');
  assert.ok(notice, 'a notice is shown');
  assert.equal(notice.text, 'Interrupted when the app closed');
});

test('a tool call that never got a result is closed as interrupted', { skip: v2 }, () => {
  const events = A.adaptHistory([
    user('run both'),
    assistant([{ type: 'tool_use', id: 'toolu_done', name: 'Bash', input: { command: 'true' } }, { type: 'tool_use', id: 'toolu_lost', name: 'Bash', input: { command: 'sleep 99' } }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_done', content: 'ok' }]),
  ]);
  const results = events.filter((e) => e.kind === 'tool-result');
  assert.deepEqual(results.map((e) => e.id).sort(), ['toolu_done', 'toolu_lost']);
  const lost = results.find((e) => e.id === 'toolu_lost');
  assert.deepEqual([lost.content, lost.isError, lost.interrupted, lost.history], ['', true, true, true]);
  assert.ok(!results.find((e) => e.id === 'toolu_done').interrupted);
});

test('internal rows stay out of the transcript', { skip: v2 }, () => {
  const events = A.adaptHistory([
    user('<system-reminder>be careful</system-reminder>'),
    user('<local-command-caveat>Caveat: the messages below were generated by the user</local-command-caveat>'),
    user('<local-command-stdout>Set model to haiku</local-command-stdout>'),
    user('real question'),
  ]);
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['command-output', 'Set model to haiku'], ['user-text', 'real question']]);
});

test('adaptHistory survives rows it does not understand', { skip: missing }, () => {
  let out;
  assert.doesNotThrow(() => { out = A.adaptHistory([{ type: 'user' }, { type: 'assistant', message: {} }, { type: 'mystery' }, user('still here')]); });
  assert.ok(out.some((e) => e.kind === 'user-text' && e.text === 'still here'));
});

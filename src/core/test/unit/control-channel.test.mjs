// The control channel: Canopy's own requests on Claude Code's pipes, and the stdout filter that keeps their
// answers away from the SDK. Driven with a fake child (two in-memory streams); no process is started.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { core, sleep, within } from '../helpers.mjs';

const C = await core('control-channel.mjs');
const missing = C.__missing ? `control-channel.mjs: ${C.__missing}` : false;

// A stand-in for the claude child: what Canopy writes to stdin is recorded, and the test plays the CLI on stdout.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false; child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.killed = true; child.lastSignal = signal; return true; };
  const sent = [];
  let buf = '';
  child.stdin.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { sent.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  return { child, sent, say: (text) => child.stdout.write(text) };
}

function open() {
  const f = fakeChild();
  const ch = C.controlChannel(f.child);
  let seen = '';
  ch.process.stdout.on('data', (d) => { seen += d; });
  return { ...f, ch, seen: () => seen, lines: () => seen.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const answerTo = (id, response) => `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })}\n`;
const errorTo = (id, error) => `${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error } })}\n`;
const frame = (n) => `${JSON.stringify({ type: 'assistant', n })}\n`;
const tick = () => sleep(5);

test('with nothing of ours in flight, stdout reaches the SDK byte for byte', { skip: missing }, async () => {
  const { say, seen, ch } = open();
  const chunks = ['{"type":"sys', 'tem","n":1}\n{"type":"x"}\n', '{"type":"control_response","response":{"subtype":"success","request_id":"sdk-1"}}\n', 'no newline at the end'];
  for (const c of chunks) say(c);
  await tick();
  assert.equal(seen(), chunks.join(''));
  assert.equal(ch.inFlight, 0);
});

test('a request goes out on stdin, and its answer never reaches the SDK', { skip: missing }, async () => {
  const { say, sent, lines, ch } = open();
  const { id, answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__echo__echo', arguments: { text: 'A' } });
  await tick();
  assert.ok(id.startsWith(C.REQUEST_PREFIX));
  assert.deepEqual(sent, [{ type: 'control_request', request_id: id, request: { subtype: 'mcp_call', tool: 'mcp__echo__echo', arguments: { text: 'A' } } }]);

  say(frame(1) + answerTo(id, { content: [{ type: 'text', text: 'echo:A' }] }) + frame(2));
  assert.deepEqual(await within(answer, 1000, 'the answer'), { ok: true, response: { content: [{ type: 'text', text: 'echo:A' }] } });
  await tick();
  assert.deepEqual(lines(), [{ type: 'assistant', n: 1 }, { type: 'assistant', n: 2 }], 'the frames around it pass, in order');
  assert.equal(ch.inFlight, 0);
});

test('an error answer resolves with the words Claude Code used', { skip: missing }, async () => {
  const { say, ch } = open();
  const { id, answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' });
  say(errorTo(id, 'The tool did not run: no'));
  assert.deepEqual(await within(answer, 1000, 'the answer'), { ok: false, error: 'The tool did not run: no' });
});

test('an answer split across chunks is put back together, and the SDK never sees a piece of it', { skip: missing }, async () => {
  const { say, seen, ch } = open();
  const { id, answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' });
  const text = answerTo(id, { content: [{ type: 'text', text: 'x'.repeat(5000) }] });
  say(frame(1) + text.slice(0, 40));
  await tick();
  say(text.slice(40, 3000));
  await tick();
  say(text.slice(3000) + frame(2).slice(0, 10));
  assert.equal((await within(answer, 1000, 'the answer')).response.content[0].text.length, 5000);
  say(frame(2).slice(10));
  await tick();
  assert.equal(seen(), frame(1) + frame(2));
});

test('a line already part-way out when the request went in is finished untouched', { skip: missing }, async () => {
  const { say, seen, ch } = open();
  const long = frame(7);
  say(long.slice(0, 12)); // passes through at once: nothing is in flight yet
  await tick();
  const { id, answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' });
  say(long.slice(12) + answerTo(id, { ok: 1 }) + frame(8));
  assert.deepEqual(await within(answer, 1000, 'the answer'), { ok: true, response: { ok: 1 } });
  await tick();
  assert.equal(seen(), long + frame(8));
});

test('answers to the SDK\'s own requests, and text that only mentions one, are the SDK\'s', { skip: missing }, async () => {
  const { say, seen, ch } = open();
  const { id, answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' });
  const theirs = answerTo('k3j2h1', { commands: [] });
  const talk = `${JSON.stringify({ type: 'assistant', text: 'a "control_response" is a frame' })}\n`;
  const broken = '{"type":"control_response" not json\n';
  say(theirs + talk + broken);
  await tick();
  assert.equal(seen(), theirs + talk + broken);
  assert.equal(ch.inFlight, 1);
  say(answerTo(id, null));
  assert.deepEqual(await within(answer, 1000, 'the answer'), { ok: true, response: null });
});

test('several requests in flight are answered each by its own id, in any order', { skip: missing }, async () => {
  const { say, seen, ch } = open();
  const a = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__a' });
  const b = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__b' });
  assert.notEqual(a.id, b.id);
  say(answerTo(b.id, 'B') + answerTo(a.id, 'A'));
  assert.deepEqual(await Promise.all([a.answer, b.answer]), [{ ok: true, response: 'A' }, { ok: true, response: 'B' }]);
  await tick();
  assert.equal(seen(), '');
});

test('cancel asks Claude Code to abandon the request and still swallows its late answer', { skip: missing }, async () => {
  const { say, sent, seen, ch } = open();
  const { id, answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__slow' });
  ch.cancel(id);
  await tick();
  assert.deepEqual(sent.at(-1), { type: 'control_cancel_request', request_id: id });
  say(errorTo(id, 'mcp_call cancelled by client: x') + frame(1));
  assert.deepEqual(await within(answer, 1000, 'the answer'), { ok: false, error: 'mcp_call cancelled by client: x' });
  await tick();
  assert.equal(seen(), frame(1));
  ch.cancel(id); // already answered: nothing more is written
  await tick();
  assert.equal(sent.length, 2);
});

test('when the process ends, everything in flight is rejected and later requests fail at once', { skip: missing }, async () => {
  const { child, say, seen, ch } = open();
  const { answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' });
  say('{"type":"partial"');
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await assert.rejects(within(answer, 1000, 'the rejection'), (err) => err.code === 'closed');
  assert.equal(ch.open, false);
  await assert.rejects(ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' }).answer, (err) => err.code === 'closed');
  child.stdout.end();
  await tick();
  assert.equal(seen(), '{"type":"partial"', 'what was held back is handed over when stdout ends');
});

test('a request Claude Code never answers times out', { skip: missing }, async () => {
  const { ch } = open();
  const { answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' }, { timeoutMs: 30 });
  await assert.rejects(within(answer, 1000, 'the timeout'), (err) => err.code === 'timeout');
  assert.equal(ch.inFlight, 0);
});

test('a reader that goes away first does not break the channel', { skip: missing }, async () => {
  const { child, say, ch } = open();
  const { id, answer } = ch.request({ subtype: 'mcp_call', tool: 'mcp__x__y' });
  ch.process.stdout.destroy(); // the SDK closed its side
  await tick();
  say(frame(1) + answerTo(id, 'still answered') + frame(2));
  assert.deepEqual(await within(answer, 1000, 'the answer'), { ok: true, response: 'still answered' });
  say('x'.repeat(1 << 20)); // far past the buffer: nothing piles up, nothing throws
  child.stdout.end();
  await tick();
  assert.equal(child.stdout.isPaused(), false);
});

test('the SDK is handed the real process for everything but stdout', { skip: missing }, async () => {
  const { child, ch } = open();
  const p = ch.process;
  assert.equal(p.stdin, child.stdin);
  assert.notEqual(p.stdout, child.stdout);
  assert.deepEqual([p.killed, p.exitCode, p.signalCode], [false, null, null]);
  let exited = null;
  p.once('exit', (code, signal) => { exited = [code, signal]; });
  assert.equal(p.kill('SIGTERM'), true);
  assert.deepEqual([child.lastSignal, p.killed], ['SIGTERM', true]);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.deepEqual(exited, [0, null]);
  assert.equal(p.exitCode, 0);
});

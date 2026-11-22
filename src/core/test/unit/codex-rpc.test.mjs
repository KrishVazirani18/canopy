// RpcPeer: the line reader and request book-keeping under `codex app-server`. Driven with strings and buffers
// only: half lines, split characters, garbage, ids the two sides share, time limits, a closing pipe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcPeer, rpcError } from '../../codex-rpc.mjs';

function peer(opts = {}) {
  const out = [];
  const seen = { notes: [], requests: [], garbage: [] };
  const p = new RpcPeer({
    write: (line) => { out.push(line); return opts.write ? opts.write(line) : true; },
    onNotification: (method, params, msg) => { seen.notes.push({ method, params, msg }); opts.onNotification?.(method, params, msg); },
    onRequest: (id, method, params, msg) => { seen.requests.push({ id, method, params, msg }); opts.onRequest?.(id, method, params, msg); },
    onGarbage: (text, why) => seen.garbage.push({ text, why }),
    timeoutMs: opts.timeoutMs ?? 2000,
  });
  return { p, out, seen, sent: () => out.map((l) => JSON.parse(l)) };
}
const line = (o) => `${JSON.stringify(o)}\n`;
const rejected = async (promise) => { try { await promise; } catch (err) { return err; } assert.fail('expected a rejection'); };

test('a line that arrives in halves is delivered once, when it is whole', () => {
  const { p, seen } = peer();
  const text = line({ method: 'turn/started', params: { threadId: 't' }, emittedAtMs: 5 });
  p.feed(text.slice(0, 10));
  assert.equal(seen.notes.length, 0);
  p.feed(text.slice(10, 25));
  assert.equal(seen.notes.length, 0);
  p.feed(text.slice(25));
  assert.equal(seen.notes.length, 1);
  assert.equal(seen.notes[0].method, 'turn/started');
  assert.deepEqual(seen.notes[0].params, { threadId: 't' });
  assert.equal(seen.notes[0].msg.emittedAtMs, 5, 'the whole line is handed on, not only its params');
});

test('many lines in one chunk are delivered in order, blank lines and \\r\\n included', () => {
  const { p, seen } = peer();
  p.feed(`${JSON.stringify({ method: 'a' })}\r\n\n   \n${JSON.stringify({ method: 'b' })}\n${JSON.stringify({ method: 'c' })}\n`);
  assert.deepEqual(seen.notes.map((n) => n.method), ['a', 'b', 'c']);
  assert.equal(seen.garbage.length, 0);
});

test('a character cut across two chunks is read whole', () => {
  const { p, seen } = peer();
  const bytes = Buffer.from(line({ method: 'say', params: { text: 'héllo → 你好 🌲' } }), 'utf8');
  const cut = bytes.indexOf(Buffer.from('🌲', 'utf8')) + 2; // inside the four bytes of the tree
  p.feed(bytes.subarray(0, cut));
  p.feed(bytes.subarray(cut));
  assert.equal(seen.notes[0].params.text, 'héllo → 你好 🌲');
});

test('text that is not a message is counted and skipped; the lines around it still arrive', () => {
  const { p, seen } = peer();
  p.feed(`${JSON.stringify({ method: 'before' })}\nnot json at all\n[1,2,3]\n"a string"\nnull\n{"neither":"nor"}\n{"id":7}\n${JSON.stringify({ method: 'after' })}\n`);
  assert.deepEqual(seen.notes.map((n) => n.method), ['before', 'after']);
  assert.equal(p.garbage, 6);
  assert.deepEqual(seen.garbage.map((g) => g.why), ['not JSON', 'not a message', 'not a message', 'not a message', 'neither a request nor an answer', 'neither a request nor an answer']);
});

test('garbage is handed on clipped, never whole', () => {
  const { p, seen } = peer();
  p.feed(`${'x'.repeat(5000)}\n`);
  assert.equal(seen.garbage[0].text.length, 200);
});

test('an oversized line is dropped without being kept, and reading carries on after it', () => {
  const { p, seen } = peer();
  const big = 'y'.repeat(1024 * 1024);
  for (let i = 0; i < 65; i++) p.feed(big); // 65 MB with no newline
  assert.deepEqual([p.parts.length, p.held], [0, 0], 'the oversized line is not held in memory');
  assert.equal(seen.garbage.at(-1).why, 'a line was too long to be a message');
  p.feed(`the tail of it\n${JSON.stringify({ method: 'next' })}\n`);
  assert.deepEqual(seen.notes.map((n) => n.method), ['next']);
});

test('an answer too long to read rejects its request at once, and only that request', async () => {
  const { p, seen } = peer({ timeoutMs: 60000 });
  const big = p.request('thread/turns/list', { threadId: 't' });
  const small = p.request('model/list', {});
  const chunk = 'z'.repeat(1024 * 1024);
  p.feed('{"id":1,"result":{"data":["');
  for (let i = 0; i < 65; i++) p.feed(chunk);
  const err = await rejected(big);
  assert.equal(err.code, 'too-large');
  assert.equal(err.method, 'thread/turns/list');
  assert.equal(p.inFlight, 1, 'the other request still waits for its own answer');
  p.feed(`"]}}\n${line({ id: 2, result: { data: [] } })}`);
  assert.deepEqual(await small, { data: [] });
  assert.equal(seen.garbage.length, 1);
  // The line was whole only when its newline came, and only then too long: the same rule.
  const late = p.request('thread/turns/list', {});
  p.feed('{"id":3,"result":"');
  for (let i = 0; i < 63; i++) p.feed(chunk);
  p.feed(`${chunk}${chunk}"}\n`);
  assert.equal((await rejected(late)).code, 'too-large');
});

test('a too-long line that is a request from the server, or no answer at all, rejects nothing', async () => {
  const { p } = peer({ timeoutMs: 60000 });
  const mine = p.request('thread/start', {});
  const chunk = 'q'.repeat(1024 * 1024);
  p.feed('{"id":1,"method":"item/tool/requestUserInput","params":{"x":"');
  for (let i = 0; i < 65; i++) p.feed(chunk);
  p.feed('"}}\n');
  assert.equal(p.inFlight, 1, 'the server counts its own ids: a request with ours is not our answer');
  p.feed(line({ id: 1, result: { ok: true } }));
  assert.deepEqual(await mine, { ok: true });
});

test('a long line in many chunks is read in time that grows with its length, not its square', () => {
  const { p, seen } = peer();
  const chunk = 'a'.repeat(64 * 1024);
  const startedAt = Date.now();
  p.feed('{"method":"big","params":{"text":"');
  for (let i = 0; i < 480; i++) p.feed(chunk); // 30 MB in 64 KB pieces
  p.feed('"}}\n');
  assert.equal(seen.notes.length, 1);
  assert.equal(seen.notes[0].params.text.length, 480 * 64 * 1024);
  assert.ok(Date.now() - startedAt < 1500, `30 MB took ${Date.now() - startedAt} ms`);
});

test('lines split across chunks at every point come out whole and in order', () => {
  const { p, seen } = peer();
  const text = [1, 2, 3, 4].map((n) => line({ method: `m${n}`, params: { n, pad: 'é'.repeat(n * 3) } })).join('') + '\n\n';
  const bytes = Buffer.from(text, 'utf8');
  for (let size = 1; size <= 7; size++) {
    seen.notes.length = 0;
    for (let i = 0; i < bytes.length; i += size) p.feed(bytes.subarray(i, i + size));
    assert.deepEqual(seen.notes.map((n) => n.method), ['m1', 'm2', 'm3', 'm4'], `chunks of ${size}`);
    assert.equal(seen.notes[3].params.pad, 'é'.repeat(12));
  }
});

test('nothing fed to it makes it throw', () => {
  const { p } = peer();
  for (const v of [null, undefined, '', 0, 42, {}, [], Buffer.alloc(0), Symbol('x'), () => {}]) assert.doesNotThrow(() => p.feed(v));
});

test('a request resolves with its result, and writes no "jsonrpc" field', async () => {
  const { p, sent } = peer();
  const r = p.request('thread/start', { cwd: '/tmp' });
  assert.deepEqual(sent(), [{ id: 1, method: 'thread/start', params: { cwd: '/tmp' } }]);
  p.feed(line({ id: 1, result: { thread: { id: 't1' } } }));
  assert.deepEqual(await r, { thread: { id: 't1' } });
  assert.equal(p.inFlight, 0);
  const again = p.request('model/list');
  assert.deepEqual(sent()[1], { id: 2, method: 'model/list' }, 'ids count up; no params key when there are none');
  p.feed(line({ id: 2, result: null }));
  assert.equal(await again, null);
});

test('a request the server refuses rejects with its code and words', async () => {
  const { p } = peer();
  const r = p.request('thread/resume', { threadId: 'x' });
  p.feed(line({ error: { code: -32600, message: 'no rollout found for thread id x', data: { a: 1 } }, id: 1 }));
  const err = await rejected(r);
  assert.equal(err.code, 'rpc');
  assert.equal(err.rpcCode, -32600);
  assert.equal(err.message, 'no rollout found for thread id x');
  assert.deepEqual(err.data, { a: 1 });
  assert.equal(err.method, 'thread/resume');
});

test('a server request and our own request can share an id: `method` tells them apart', async () => {
  const { p, seen, sent } = peer();
  const mine = p.request('turn/start', { threadId: 't' }); // our id 1
  p.feed(line({ method: 'item/commandExecution/requestApproval', id: 1, params: { itemId: 'i' } })); // their id 1
  assert.equal(seen.requests.length, 1, 'a line with a method is a request, whatever its id');
  assert.equal(seen.requests[0].id, 1);
  assert.equal(seen.requests[0].msg.method, 'item/commandExecution/requestApproval');
  assert.equal(p.inFlight, 1, 'it did not settle our own request');
  p.respond(1, { decision: 'accept' });
  assert.deepEqual(sent().at(-1), { id: 1, result: { decision: 'accept' } });
  p.feed(line({ id: 1, result: { turn: { id: 'u' } } }));
  assert.deepEqual(await mine, { turn: { id: 'u' } });
  p.feed(line({ method: 'ask', id: 0, params: {} }));
  assert.equal(seen.requests[1].id, 0, 'id 0 is an id');
});

test('respond, respondError and notify write what the app-server expects', () => {
  const { p, sent } = peer();
  p.respond(3);
  p.respondError(4, -32601, 'Not here.');
  p.respondError(5, -32601);
  p.notify('initialized');
  p.notify('x', { a: 1 });
  assert.deepEqual(sent(), [
    { id: 3, result: {} },
    { id: 4, error: { code: -32601, message: 'Not here.' } },
    { id: 5, error: { code: -32601, message: 'Not supported.' } },
    { method: 'initialized' },
    { method: 'x', params: { a: 1 } },
  ]);
});

test('a request with no answer in time rejects with `timeout`; a late answer is ignored', async () => {
  const { p, seen } = peer({ timeoutMs: 30 });
  const err = await rejected(p.request('thread/list', {}));
  assert.equal(err.code, 'timeout');
  assert.equal(err.method, 'thread/list');
  assert.equal(p.inFlight, 0);
  assert.doesNotThrow(() => p.feed(line({ id: 1, result: { late: true } })));
  assert.equal(seen.garbage.length, 0, 'a late answer is not garbage, just late');
  const own = await rejected(p.request('slow', {}, { timeoutMs: 10 }));
  assert.equal(own.code, 'timeout');
  assert.match(own.message, /10 ms/);
});

test('close() rejects everything still waiting, and later calls fail at once', async () => {
  const { p, out } = peer();
  const a = p.request('one');
  const b = p.request('two');
  p.close('Codex stopped.');
  const [ea, eb] = [await rejected(a), await rejected(b)];
  assert.deepEqual([ea.code, eb.code], ['closed', 'closed']);
  assert.equal(ea.message, 'Codex stopped.');
  assert.equal(eb.method, 'two');
  const later = await rejected(p.request('three'));
  assert.equal(later.code, 'closed');
  const written = out.length;
  assert.equal(p.notify('x'), false);
  assert.equal(p.respond(1, {}), false);
  assert.equal(out.length, written, 'nothing is written after close');
  assert.doesNotThrow(() => { p.close(); p.feed(line({ method: 'ignored' })); });
});

test('a write that fails rejects the request as closed instead of leaving it waiting', async () => {
  const thrown = peer({ write: () => { throw new Error('EPIPE'); } });
  assert.equal((await rejected(thrown.p.request('x'))).code, 'closed');
  assert.equal(thrown.p.inFlight, 0);
  const refused = peer({ write: () => false });
  assert.equal((await rejected(refused.p.request('x'))).code, 'closed');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal((await rejected(peer().p.request('x', cyclic))).code, 'closed', 'params that cannot be written');
});

test('a handler that throws never stops the reader', async () => {
  const { p, seen } = peer({
    onNotification: (method) => { if (method === 'boom') throw new Error('handler bug'); },
    onRequest: () => { throw new Error('handler bug'); },
  });
  const r = p.request('still/works');
  assert.doesNotThrow(() => p.feed(`${JSON.stringify({ method: 'boom' })}\n${JSON.stringify({ method: 'ask', id: 9 })}\n${JSON.stringify({ method: 'fine' })}\n${JSON.stringify({ id: 1, result: 'ok' })}\n`));
  assert.deepEqual(seen.notes.map((n) => n.method), ['boom', 'fine']);
  assert.equal(await r, 'ok');
});

test('a handler that closes the peer stops the rest of the chunk', () => {
  let p2;
  const h = peer({ onNotification: (method) => { if (method === 'bye') p2.close(); } });
  p2 = h.p;
  h.p.feed(`${JSON.stringify({ method: 'bye' })}\n${JSON.stringify({ method: 'after' })}\n`);
  assert.deepEqual(h.seen.notes.map((n) => n.method), ['bye']);
});

test('rpcError carries its code and extras', () => {
  const e = rpcError('timeout', 'too slow', { method: 'm' });
  assert.ok(e instanceof Error);
  assert.deepEqual([e.code, e.message, e.method], ['timeout', 'too slow', 'm']);
});

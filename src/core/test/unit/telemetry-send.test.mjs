// Sending (src/telemetry/send.mjs, flush.mjs): what each answer from PostHog means for the events, the timeout,
// the growing pause after failures, splitting a batch that is too big, never more than one request at a time, that
// a refusal (400, 413) is believed only so far (something answering that way to everything can't empty the queue),
// and that a key PostHog does not take costs no events at all.
// PostHog, the clock and the timers are fakes; the queue is the real one, in a temp folder.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { BACKOFF_MS, FLUSH_AT, createFlusher } from '../../../telemetry/flush.mjs';
import { toPostHogBatch } from '../../../telemetry/posthog.mjs';
import { createQueue } from '../../../telemetry/queue.mjs';
import { EVENTS, LIMITS, clean } from '../../../telemetry/schema.mjs';
import { platformNet, postBatch, retryAfterMs } from '../../../telemetry/send.mjs';
import { TEST_KEY, TEST_URL, envelope, fakeClock, fakeServer, stopFirst, tempDir, until } from '../telemetry-fakes.mjs';

const URL_ = TEST_URL;
const MIN = 60_000;
const HEADER = { install_id: '22222222-2222-4222-8222-222222222222', name: 'Jane Doe', env: 'prod', app_version: '0.0.1', os_version: '26.1', schema: 1 };
/** A batch as Canopy posts it: these events, as PostHog wants them. */
const batchOf = (events) => JSON.stringify(toPostHogBatch(TEST_KEY, HEADER, events, '2026-11-01T08:00:00.000Z'));
const body = (n = 1) => batchOf(Array.from({ length: n }, (_, i) => envelope(i + 1)));

// ---- one POST ----

test('the request is a JSON POST of the batch to PostHog, with no cookies and no following of redirects', async () => {
  const server = fakeServer(200);
  const r = await postBatch({ endpoint: URL_, body: body(2), fetch: server.fetch });
  assert.deepEqual(r, { result: 'ok', status: 200 });
  const [sent] = server.requests;
  assert.equal(sent.url, 'https://posthog.test/batch/');
  assert.deepEqual({ ...sent.init, body: null, signal: null }, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: null, redirect: 'error', credentials: 'omit', signal: null,
  });
  assert.deepEqual(Object.keys(sent.body), ['api_key', 'batch']);
  assert.equal(sent.body.batch.length, 2);
});

test('every answer PostHog can give comes back as one of six results', async () => {
  const cases = [
    [200, 'ok'], [201, 'ok'], [204, 'ok'],
    [400, 'drop'],
    [413, 'split'],
    [429, 'wait'],
    // The key was not taken, or something in between lets nobody through: nothing is wrong with the events.
    [401, 'key'], [403, 'key'],
    [500, 'retry'], [502, 'retry'], [503, 'retry'], [504, 'retry'],
    // Not about the batch either (a host that is not PostHog, a timeout on its side, a quota answer of its newer API).
    [402, 'retry'], [404, 'retry'], [408, 'retry'], [415, 'retry'], [422, 'retry'], [301, 'retry'], [302, 'retry'],
  ];
  for (const [status, result] of cases) {
    const r = await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer(status).fetch });
    assert.equal(r.result, result, `status ${status}`);
    assert.equal(r.status, status);
  }
  // What a refusal says in its reply changes nothing: the status is the whole answer.
  for (const [status, result] of [[400, 'drop'], [401, 'key'], [200, 'ok'], [503, 'retry']]) {
    for (const reply of [{ error: 'bad_batch', schema: 0 }, { status: 1, quota_limited: ['recordings'] }, 'failed to parse request', '<html>nope</html>', '']) {
      assert.deepEqual(await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer({ status, body: reply }).fetch }), status >= 500 ? { result, status, retryAfterMs: null } : { result, status }, `${status} ${JSON.stringify(reply)}`);
    }
  }
});

test('a redirect is not followed: where it leads may say 200 to anything, and that is not PostHog having the events', async (t) => {
  // A real server on this Mac (Node's own fetch does the request): /batch/ redirects to a page that answers 200.
  let landed = 0;
  const web = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/batch/') { res.writeHead(302, { location: '/signin' }); res.end(); return; }
    landed++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>Sign in to continue</html>');
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => web.close(resolve)));
  const r = await postBatch({ endpoint: `http://127.0.0.1:${web.address().port}/batch/`, body: body(), fetch: globalThis.fetch });
  assert.equal(r.result, 'retry', 'the events are kept');
  assert.equal(landed, 0, 'and the page behind the redirect was never asked');
});

test('a reply is never read: an endless page, or one that never ends, holds nothing up', async () => {
  // Something that is not PostHog answers with a page that never stops coming.
  for (const [status, result] of [[400, 'drop'], [200, 'ok'], [401, 'key']]) {
    let pulls = 0, cancelled = false;
    const endless = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024).fill(32)); }, cancel() { cancelled = true; } });
    assert.deepEqual(await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer({ status, body: endless }).fetch }), { result, status });
    assert.ok(pulls <= 2, `read ${pulls} KB of it`);
    assert.equal(cancelled, true, 'and the rest was let go');
  }
  // Headers, then nothing: the answer is in the headers, and no timer is left waiting for the rest.
  const clock = fakeClock();
  const stalled = new ReadableStream({ pull() { /* never */ } });
  assert.deepEqual(await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer({ status: 400, body: stalled }).fetch, timers: clock.timers }), { result: 'drop', status: 400 });
  assert.equal(clock.waiting, 0);
});

test('a network failure, a fetch that throws and an answer that makes no sense are all "try later"', async () => {
  assert.equal((await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer('network').fetch })).result, 'retry');
  assert.equal((await postBatch({ endpoint: URL_, body: body(), fetch: () => { throw new Error('not ready'); } })).result, 'retry');
  assert.equal((await postBatch({ endpoint: URL_, body: body(), fetch: async () => ({}) })).result, 'retry');
  assert.equal((await postBatch({ endpoint: URL_, body: body(), fetch: async () => null })).result, 'retry');
});

test('Retry-After is read as seconds or as a date', async () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(retryAfterMs('120', now), 120_000);
  assert.equal(retryAfterMs('0.5', now), 500);
  assert.equal(retryAfterMs('Mon, 16 Nov 2026 12:05:00 GMT', now), 300_000);
  assert.equal(retryAfterMs('Mon, 16 Nov 2026 11:00:00 GMT', now), 0, 'a date already past means now');
  for (const bad of [null, undefined, '', '  ', 'soon', '-5', 42]) assert.equal(retryAfterMs(bad, now), null, String(bad));
  const r = await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer({ status: 429, headers: { 'Retry-After': '30' } }).fetch });
  assert.deepEqual(r, { result: 'wait', status: 429, retryAfterMs: 30_000 });
  assert.equal((await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer(429).fetch })).retryAfterMs, null);
});

test('a server that never answers is given up on after the timeout, and the request is cut', async () => {
  const clock = fakeClock();
  const server = fakeServer('hang');
  const sent = postBatch({ endpoint: URL_, body: body(), fetch: server.fetch, timers: clock.timers, timeoutMs: 15_000 });
  await until(() => server.requests.length === 1);
  clock.advance(14_999);
  assert.equal(server.requests[0].signal.aborted, false);
  clock.advance(1);
  assert.deepEqual(await sent, { result: 'retry', status: 0, reason: 'timeout' });
  assert.equal(server.requests[0].signal.aborted, true);
  assert.equal(clock.waiting, 0, 'no timer left behind');
});

test('the timeout holds even for a fetch that ignores being cut', async () => {
  const clock = fakeClock();
  const sent = postBatch({ endpoint: URL_, body: body(), fetch: () => new Promise(() => {}), timers: clock.timers, timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1000);
  assert.equal((await sent).reason, 'timeout');
});

test('the caller can give up at once; a request never starts on a signal already cut', async () => {
  const server = fakeServer('hang');
  const stop = new AbortController();
  const sent = postBatch({ endpoint: URL_, body: body(), fetch: server.fetch, signal: stop.signal });
  await until(() => server.requests.length === 1);
  stop.abort();
  assert.deepEqual(await sent, { result: 'retry', status: 0, reason: 'stopped' });
  assert.deepEqual(await postBatch({ endpoint: URL_, body: body(), fetch: server.fetch, signal: stop.signal }), { result: 'retry', status: 0, reason: 'stopped' });
  assert.equal(server.requests.length, 1);
});

test('a timer is never left behind after an answer', async () => {
  const clock = fakeClock();
  await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer(200).fetch, timers: clock.timers });
  await postBatch({ endpoint: URL_, body: body(), fetch: fakeServer('network').fetch, timers: clock.timers });
  assert.equal(clock.waiting, 0);
});

test('outside Electron there is no network: a test or script that forgets its stand-in can\'t reach the real PostHog', async () => {
  const net = await platformNet();
  assert.equal(net.isOnline(), true);
  await assert.rejects(net.fetch('https://us.i.posthog.com/batch/', { method: 'POST', body: body() }), /only sent from inside Canopy/);
  // Through postBatch that is one more "try later", and nothing has left.
  const r = await postBatch({ endpoint: 'https://us.i.posthog.com/batch/', body: body(), fetch: net.fetch });
  assert.deepEqual({ result: r.result, status: r.status }, { result: 'retry', status: 0 });
});

// ---- the flush loop ----

async function setup(t, { events = 0, answers = [200], online = () => true, canSend = () => true, random = () => 0.5, limits, dropsPerHour, dropLog, clock = fakeClock() } = {}) {
  const server = fakeServer(...answers);
  const queue = createQueue({ file: path.join(tempDir(t), 'queue.jsonl') });
  await queue.load();
  for (let i = 1; i <= events; i++) queue.add(envelope(i));
  const notes = [];
  const sent = [];
  const flusher = createFlusher({
    queue, canSend, isOnline: online, now: clock.now, random, note: (m) => notes.push(m), onSent: (n) => sent.push(n),
    post: (evs, signal) => postBatch({ endpoint: URL_, body: batchOf(evs), fetch: server.fetch, signal, timers: clock.timers, now: clock.now }),
    ...(limits && { limits }), ...(dropsPerHour !== undefined && { dropsPerHour }), ...(dropLog && { dropLog }),
  });
  stopFirst(t, () => queue.settled());
  return { clock, server, queue, flusher, notes, sent };
}

test('a flush sends everything queued, oldest first, in batches no bigger than the limits', async (t) => {
  const { server, queue, flusher, sent } = await setup(t, { events: 450 });
  await flusher.flush();
  assert.deepEqual(server.requests.map((r) => r.events.length), [200, 200, 50]);
  assert.equal(server.requests[0].events[0].id, envelope(1).id);
  assert.equal(server.requests[2].events.at(-1).id, envelope(450).id);
  assert.equal(queue.size, 0);
  assert.deepEqual(sent, [200, 200, 50]);
});

test('a batch is sized as the queue holds it; what is posted says who it is from on every event, and is still far under what PostHog takes', async (t) => {
  const one = Buffer.byteLength(JSON.stringify(envelope(1))) + 1;
  const limits = { batchEvents: 200, batchBytes: 1024 + one * 10 };
  const { server, flusher } = await setup(t, { events: 25, limits });
  await flusher.flush();
  assert.deepEqual(server.requests.map((r) => r.events.length), [10, 10, 5]);
  assert.ok(LIMITS.batchBytes > 1024 && LIMITS.batchEvents === 200);

  // The fullest batch there can be: as many of the largest events as the limits let through (an error whose line is
  // 200 characters of four bytes each, a day's summary with every count at its highest), under the longest name.
  const error = clean('error', { where: 'engine', fingerprint: 'f'.repeat(16), type: 'E'.repeat(60), message: '𝒳'.repeat(400), count: 1e7 });
  const day = clean('day_summary', Object.fromEntries(Object.entries(EVENTS.day_summary).map(([k, spec]) => [k, spec === 'date' ? '2026-11-15' : spec === 'bool' ? false : spec === 'minutes' ? 10080 : 1e7])));
  assert.equal(Array.from(error.message).length, 200);
  assert.equal(Object.keys(day).length, Object.keys(EVENTS.day_summary).length);
  const name = 'Ж'.repeat(LIMITS.nameChars);
  for (const props of [error, day]) {
    const big = createQueue({ file: path.join(tempDir(t), 'queue.jsonl') });
    for (let i = 1; i <= LIMITS.batchEvents; i++) big.add({ ...envelope(i), event: props === error ? 'error' : 'day_summary', props });
    const fullest = big.batch(LIMITS.batchEvents, LIMITS.batchBytes - 1024);
    assert.ok(fullest.length >= 100, `${fullest.length} of them fit a batch`);
    const posted = Buffer.byteLength(JSON.stringify(toPostHogBatch(TEST_KEY, { ...HEADER, name }, fullest, '2026-11-01T08:00:00.000Z')));
    assert.ok(posted > LIMITS.batchBytes / 2 && posted < 1024 * 1024, `${posted} bytes posted: under 1 MB, where PostHog takes 20 MB a request`);
    await big.settled();
  }
});

test('only one request is out at a time, however many ask', async (t) => {
  let out = 0;
  let most = 0;
  const { server, queue, flusher } = await setup(t, { events: 450 });
  const real = server.fetch;
  server.fetch = async (url, init) => { out++; most = Math.max(most, out); await new Promise((resolve) => setTimeout(resolve, 5)); out--; return real(url, init); };
  const all = [flusher.flush(), flusher.tick(), flusher.flush(), flusher.flush()];
  flusher.poke();
  flusher.tick();
  await Promise.all(all);
  await flusher.flush();
  assert.equal(most, 1);
  assert.equal(queue.size, 0);
  assert.equal(server.events.length, 450, 'and nothing was sent twice');
});

test('400: the batch is dropped for good, then a pause like after any failure; the batches behind it go when it is over', async (t) => {
  const { server, queue, flusher, notes, clock, sent } = await setup(t, { events: 250, answers: [400, 200] });
  await flusher.tick();
  assert.equal(server.requests.length, 1);
  assert.equal(queue.size, 50, 'the refused batch is gone, the one behind it has not been tried');
  assert.equal(server.requests[0].events[0].id, envelope(1).id);
  assert.equal(flusher.pausedUntil - clock.now(), 1 * MIN);
  assert.equal(notes.filter((n) => /PostHog refused a batch of 200 \(400\)/.test(n)).length, 1);
  assert.ok(!notes.some((n) => /could not send/.test(n)), 'said once, as what it was');
  clock.advance(MIN - 1);
  await flusher.tick();
  assert.equal(server.requests.length, 1, 'nothing is sent while the pause is on');
  clock.advance(1);
  await flusher.tick();
  assert.equal(queue.size, 0);
  assert.deepEqual(sent, [50]);
  assert.equal(server.requests[1].events[0].id, envelope(201).id, 'the dropped batch was not sent again');
  assert.ok(notes.some((n) => /works again/.test(n)));
});

test('something that answers 400 to everything costs a batch an hour at most, not the whole queue in seconds', async (t) => {
  // A proxy in the way, or a function deployed wrong: every request is "refused for good".
  const { server, queue, flusher, clock, notes } = await setup(t, { events: 3000, answers: [400] });
  assert.equal(LIMITS.batchEvents, 200);
  const left = [];
  for (let minute = 0; minute < 59; minute++) { await flusher.tick(); left.push(queue.size); clock.advance(MIN); }
  assert.equal(left[0], 2800, 'the first refusal is believed: one batch');
  assert.ok(left.every((n) => n === 2800), 'and for the rest of the hour nothing more is dropped');
  // Tried again after 1, 2, 5 and 15 minutes (the pauses of any failure), kept each time.
  assert.equal(server.requests.length, 5);
  assert.ok(server.requests.slice(1).every((r) => r.events[0].id === envelope(201).id && r.events.length === 200), 'the same batch each time: it is kept');
  assert.equal(notes.filter((n) => /refused a batch/.test(n)).length, 1);
  assert.equal(notes.filter((n) => /could not send/.test(n)).length, 0, 'the log was told once, by the drop');
  // "Send now" (as at quit) is one more try, not one more batch dropped.
  await flusher.flush();
  assert.equal(server.requests.length, 6);
  assert.equal(queue.size, 2800);
  // From then on it is a try an hour (the longest pause), and each may cost one more batch: six hours, six batches.
  for (let minute = 59; minute < 6 * 60; minute++) { await flusher.tick(); clock.advance(MIN); }
  assert.equal(notes.filter((n) => /refused a batch of 200/.test(n)).length, 6);
  assert.equal(queue.size, 3000 - 6 * 200);
  assert.equal(server.requests.length, 11, 'and eleven requests, where it used to be fifteen in a row');

  // The limit counts events, across batches of any size, in any hour.
  const small = await setup(t, { events: 50, answers: [400], dropsPerHour: 25, limits: { batchEvents: 10, batchBytes: LIMITS.batchBytes } });
  for (let minute = 0; minute < 60; minute++) { await small.flusher.flush(); small.clock.advance(MIN); }
  assert.equal(small.queue.size, 30, 'two batches of ten fit under 25; a third would not');
  await small.flusher.flush();
  assert.equal(small.queue.size, 20, 'an hour on, the first of them no longer counts');
});

test('the hour\'s limit on drops holds across a quit: the next launch remembers what this one dropped', async (t) => {
  let kept;
  const dropLog = { read: () => kept, write: (drops) => { kept = JSON.parse(JSON.stringify(drops)); } };
  const clock = fakeClock();
  const a = await setup(t, { events: 400, answers: [400], dropLog, clock });
  await a.flusher.tick();
  assert.equal(a.queue.size, 200);
  assert.deepEqual(kept, [[clock.now(), 200]], 'when, and how many: nothing about the events');
  // Quit and opened again ten minutes later, and again: each launch starts with no pause, and still drops nothing.
  for (let launch = 0; launch < 3; launch++) {
    clock.advance(10 * MIN);
    const again = await setup(t, { events: 400, answers: [400], dropLog, clock });
    await again.flusher.tick();
    await again.flusher.flush();
    assert.equal(again.queue.size, 400, 'kept: the hour\'s batch has been spent');
    assert.equal(again.server.requests.length, 2);
  }
  clock.advance(31 * MIN); // an hour and a minute after that first drop
  const later = await setup(t, { events: 400, answers: [400], dropLog, clock });
  await later.flusher.tick();
  assert.equal(later.queue.size, 200);
  assert.deepEqual(kept, [[clock.now(), 200]], 'the old drop is forgotten, the new one written down');

  // What was kept can't break sending, whatever it holds: junk is no drops, and a time after now (the clock was set back) is let go.
  for (const junk of [undefined, null, 'x', 42, {}, [[1]], [['a', 'b']], [[clock.now() + 5 * MIN, 200]], [[clock.now(), -5]], [[clock.now(), 1.5]], [null, [clock.now() - 2 * 60 * MIN, 200]]]) {
    const c = await setup(t, { events: 200, answers: [400], dropLog: { read: () => junk, write: () => {} }, clock });
    await c.flusher.tick();
    assert.equal(c.queue.size, 0, JSON.stringify(junk));
  }
  // Nor can a place to keep them that fails: the limit holds for the launch all the same.
  const broken = await setup(t, { events: 400, answers: [400], dropLog: { read: () => { throw new Error('unreadable'); }, write: () => { throw new Error('disk full'); } }, clock });
  await broken.flusher.tick();
  await broken.flusher.flush();
  assert.equal(broken.queue.size, 200);
});

test('401: the key was not taken. Every event is kept, the next try is an hour away, and "send now" does not bring it forward', async (t) => {
  const { server, queue, flusher, clock, notes, sent } = await setup(t, { events: 250, answers: [401, 401, 403, 200] });
  await flusher.tick();
  assert.equal(server.requests.length, 1);
  assert.equal(queue.size, 250, 'nothing is dropped: the events are fine');
  assert.equal(flusher.pausedUntil - clock.now(), 60 * MIN, 'the longest pause at once, not 1, 2, 5 minutes');
  assert.deepEqual(notes, ['PostHog did not take the key (401): events are kept, and the next try is in an hour']);
  // Not the minute timer, not 50 more events, not "send now" (as at quit): the key is the same until the next Canopy.
  for (let minute = 1; minute < 60; minute++) { clock.advance(MIN); await flusher.tick(); flusher.poke(); await flusher.flush(); }
  assert.equal(server.requests.length, 1);
  clock.advance(MIN);
  await flusher.tick();
  assert.equal(server.requests.length, 2, 'one try an hour');
  assert.equal(flusher.pausedUntil - clock.now(), 60 * MIN);
  clock.advance(60 * MIN);
  await flusher.tick(); // 403: something in between refusing everyone is treated the same
  assert.equal(queue.size, 250);
  assert.equal(notes.length, 1, 'said once, not once per try');
  clock.advance(60 * MIN);
  await flusher.tick(); // the key is taken now
  assert.equal(queue.size, 0);
  assert.deepEqual(sent, [200, 50]);
  assert.equal(server.requests[3].events[0].id, envelope(1).id, 'from the first event on');
  assert.ok(notes.some((n) => /works again/.test(n)));
});

test('a key that stops being taken after other trouble is said in the log as what it is', async (t) => {
  const { flusher, clock, notes, queue } = await setup(t, { events: 3, answers: [500, 401, 500] });
  await flusher.tick();
  clock.advance(MIN);
  await flusher.tick();
  assert.equal(flusher.pausedUntil - clock.now(), 60 * MIN);
  clock.advance(60 * MIN);
  await flusher.tick();
  assert.deepEqual(notes.map((n) => n.replace(/ \(.*/, '')), ['could not send', 'PostHog did not take the key', 'could not send']);
  assert.equal(queue.size, 3);
});

test('413: the batch is halved until it fits, then works back up', async (t) => {
  const tooBig = (evs) => (evs.length > 30 ? 413 : 200);
  const { server, queue, flusher } = await setup(t, { events: 200, answers: [tooBig] });
  await flusher.flush();
  const sizes = server.requests.map((r) => r.events.length);
  assert.deepEqual(sizes.slice(0, 4), [200, 100, 50, 25]);
  assert.equal(queue.size, 0);
  const accepted = server.requests.filter((r) => r.events.length <= 30).flatMap((r) => r.events.map((e) => e.id));
  assert.equal(new Set(accepted).size, 200);
  assert.equal(accepted.length, 200, 'each event accepted exactly once');
});

test('413 for a single event: it can never fit, so that one event is dropped, then a pause; the rest go when it is over', async (t) => {
  const first = envelope(1).id;
  const { server, queue, flusher, notes, clock } = await setup(t, { events: 3, answers: [(evs) => (evs.some((e) => e.id === first) ? 413 : 200)] });
  await flusher.tick();
  assert.deepEqual(server.requests.map((r) => r.events.length), [3, 2, 1], 'halved down to the one that does not fit');
  assert.equal(queue.size, 2, 'only that one is dropped');
  assert.equal(notes.filter((n) => /one event was too big/.test(n)).length, 1);
  assert.equal(flusher.pausedUntil - clock.now(), 1 * MIN);
  await flusher.tick();
  assert.equal(server.requests.length, 3, 'nothing is sent while the pause is on');
  clock.advance(MIN);
  await flusher.tick();
  assert.equal(queue.size, 0);
  const ok = server.requests.filter((r) => !r.events.some((e) => e.id === first)).flatMap((r) => r.events.map((e) => e.id));
  assert.deepEqual(ok.sort(), [envelope(2).id, envelope(3).id].sort());
});

test('something that answers 413 to everything costs one event a pause, and no more in an hour than the limit', async (t) => {
  const { server, queue, flusher, clock, notes } = await setup(t, { events: 300, answers: [413] });
  await flusher.tick();
  // 200, 100, 50, 25, 13, 7, 4, 2, 1: the last one can't be halved.
  assert.deepEqual(server.requests.map((r) => r.events.length), [200, 100, 50, 25, 13, 7, 4, 2, 1]);
  assert.equal(queue.size, 299);
  assert.equal(flusher.pausedUntil - clock.now(), 1 * MIN);
  for (let minute = 1; minute <= 59; minute++) { clock.advance(MIN); await flusher.tick(); }
  // One event at each try: at 0, 1, 3, 8 and 23 minutes.
  assert.equal(queue.size, 295);
  assert.equal(notes.filter((n) => /too big/.test(n)).length, 5);

  // Past the hour's limit even the one event is kept.
  const tight = await setup(t, { events: 4, answers: [413], dropsPerHour: 2 });
  for (let minute = 0; minute < 40; minute++) { await tight.flusher.flush(); tight.clock.advance(MIN); }
  assert.equal(tight.queue.size, 2, 'two went, the limit; the others wait');
  for (let minute = 40; minute < 70; minute++) { await tight.flusher.flush(); tight.clock.advance(MIN); }
  assert.ok(tight.queue.size < 2, 'and go once an hour has passed');
});

test('refusals of both kinds share the one limit, and a success in between does not reset it', async (t) => {
  const first = envelope(1).id;
  // Event 1 fits nowhere (413 alone); after it the server takes a batch, then refuses the rest for good.
  const script = (evs) => (evs.some((e) => e.id === first) ? 413 : evs[0].id === envelope(2).id ? 200 : 400);
  const { queue, flusher, clock, notes, sent } = await setup(t, { events: 31, answers: [script], dropsPerHour: 11, limits: { batchEvents: 10, batchBytes: LIMITS.batchBytes } });
  for (let minute = 0; minute < 30; minute++) { await flusher.flush(); clock.advance(MIN); }
  assert.deepEqual(sent, [10], 'events 2 to 11 were taken');
  assert.equal(notes.filter((n) => /too big/.test(n)).length, 1);
  assert.equal(notes.filter((n) => /refused a batch of 10/.test(n)).length, 1, '1 + 10 is the limit: the second refused batch is kept');
  assert.equal(queue.size, 10);
});

test('5xx and network failures keep the events and pause 1, 2, 5, 15 minutes, then an hour at most', async (t) => {
  const { server, queue, flusher, clock, notes } = await setup(t, { events: 3, answers: [500, 'network', 503, 502, 500, 500, 500] });
  const expected = [1, 2, 5, 15, 60, 60, 60].map((m) => m * MIN);
  assert.deepEqual(BACKOFF_MS, [1, 2, 5, 15, 60].map((m) => m * MIN));
  for (let i = 0; i < expected.length; i++) {
    await flusher.tick();
    assert.equal(server.requests.length, i + 1, `try ${i + 1}`);
    assert.equal(flusher.pausedUntil - clock.now(), expected[i], `pause after failure ${i + 1}`);
    clock.advance(expected[i] - 1);
    await flusher.tick();
    assert.equal(server.requests.length, i + 1, 'nothing is sent while the pause is on');
    clock.advance(1);
  }
  assert.equal(queue.size, 3, 'every event is still queued');
  assert.equal(notes.filter((n) => /could not send/.test(n)).length, 1, 'said once, not once per failure');
});

test('the pause is jittered a fifth either way, and never more than an hour', async (t) => {
  for (const [random, factor] of [[() => 0, 0.8], [() => 0.999999, 1.2]]) {
    const { flusher, clock } = await setup(t, { events: 1, answers: [500], random });
    await flusher.tick();
    assert.ok(Math.abs((flusher.pausedUntil - clock.now()) - MIN * factor) < 10, `factor ${factor}`);
    for (let i = 0; i < 6; i++) { clock.advance(61 * MIN); await flusher.tick(); }
    assert.ok(flusher.pausedUntil - clock.now() <= 60 * MIN);
  }
});

test('a success ends the pause sequence: the next failure starts again at one minute', async (t) => {
  const { server, queue, flusher, clock, notes } = await setup(t, { events: 2, answers: [500, 500, 200, 500] });
  await flusher.tick();
  clock.advance(1 * MIN);
  await flusher.tick();
  assert.equal(flusher.pausedUntil - clock.now(), 2 * MIN);
  clock.advance(2 * MIN);
  await flusher.tick();
  assert.equal(queue.size, 0);
  assert.ok(notes.some((n) => /works again/.test(n)));
  queue.add(envelope(10));
  await flusher.tick();
  assert.equal(server.requests.length, 4);
  assert.equal(flusher.pausedUntil - clock.now(), 1 * MIN);
});

test('429: the pause is what Retry-After says, and even "send now" waits it out', async (t) => {
  const { server, queue, flusher, clock } = await setup(t, { events: 2, answers: [{ status: 429, headers: { 'retry-after': '90' } }, 200] });
  await flusher.tick();
  assert.equal(flusher.pausedUntil - clock.now(), 90_000);
  await flusher.flush();
  await flusher.tick();
  assert.equal(server.requests.length, 1, 'the server asked for quiet');
  clock.advance(90_000);
  await flusher.tick();
  assert.equal(queue.size, 0);
});

test('429 without Retry-After falls back to the usual pause; an absurd Retry-After is capped at an hour', async (t) => {
  const a = await setup(t, { events: 1, answers: [429] });
  await a.flusher.tick();
  assert.equal(a.flusher.pausedUntil - a.clock.now(), 1 * MIN);
  const b = await setup(t, { events: 1, answers: [{ status: 429, headers: { 'retry-after': '864000' } }] });
  await b.flusher.tick();
  assert.equal(b.flusher.pausedUntil - b.clock.now(), 60 * MIN);
  const c = await setup(t, { events: 1, answers: [{ status: 503, headers: { 'retry-after': '600' } }] });
  await c.flusher.tick();
  assert.equal(c.flusher.pausedUntil - c.clock.now(), 10 * MIN, 'a 503 that says when is believed too, when it asks for longer');
});

test('"send now" skips the pause after a failure (one more try is the point), the timer does not', async (t) => {
  const { server, queue, flusher } = await setup(t, { events: 1, answers: [500, 200] });
  await flusher.tick();
  await flusher.tick();
  assert.equal(server.requests.length, 1);
  await flusher.flush();
  assert.equal(server.requests.length, 2);
  assert.equal(queue.size, 0);
});

test('offline: nothing is tried and no pause starts, so it goes as soon as the Mac is back', async (t) => {
  let online = false;
  const { server, queue, flusher, clock } = await setup(t, { events: 2, online: () => online });
  await flusher.tick();
  await flusher.flush();
  assert.equal(server.requests.length, 0);
  assert.equal(flusher.pausedUntil <= clock.now(), true);
  online = true;
  await flusher.tick();
  assert.equal(queue.size, 0);
});

test('a question about being online that throws counts as online', async (t) => {
  const { queue, flusher } = await setup(t, { events: 1, online: () => { throw new Error('not ready'); } });
  await flusher.tick();
  assert.equal(queue.size, 0);
});

test('nothing is sent while sending is not allowed, and the events stay', async (t) => {
  let allowed = false;
  const { server, queue, flusher } = await setup(t, { events: 60, canSend: () => allowed });
  await flusher.tick();
  await flusher.flush();
  flusher.poke();
  assert.equal(server.requests.length, 0);
  assert.equal(queue.size, 60);
  allowed = true;
  await flusher.flush();
  assert.equal(queue.size, 0);
});

test(`${FLUSH_AT} events waiting are sent without waiting for the minute`, async (t) => {
  const { server, queue, flusher } = await setup(t);
  for (let i = 1; i < FLUSH_AT; i++) { queue.add(envelope(i)); flusher.poke(); }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.requests.length, 0);
  queue.add(envelope(FLUSH_AT));
  flusher.poke();
  await until(() => queue.size === 0);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].events.length, FLUSH_AT);
});

test('stop cuts the request in flight and keeps its events; nothing goes until resume', async (t) => {
  const { server, queue, flusher } = await setup(t, { events: 5, answers: ['hang'] });
  const flushing = flusher.flush();
  await until(() => server.requests.length === 1);
  flusher.stop();
  await flushing;
  assert.equal(server.requests[0].signal.aborted, true);
  assert.equal(queue.size, 5);
  server.answer(200);
  await flusher.flush();
  await flusher.tick();
  assert.equal(server.requests.length, 1);
  flusher.resume();
  await flusher.flush();
  assert.equal(queue.size, 0);
});

test('an answer that arrives after the queue was emptied removes nothing that came later', async (t) => {
  const { server, queue, flusher } = await setup(t, { events: 3 });
  const real = server.fetch;
  let release = null;
  server.fetch = (url, init) => new Promise((resolve) => { release = () => resolve(real(url, init)); });
  const flushing = flusher.flush();
  await until(() => release);
  queue.clear();
  queue.add(envelope(50));
  server.fetch = real;
  release();
  await flushing;
  assert.equal(server.events.length >= 3, true);
  await flusher.flush();
  assert.equal(queue.size, 0);
  assert.ok(server.requests.some((r) => r.events.some((e) => e.id === envelope(50).id)), 'the later event was sent, not lost');
});

test('a batch the caller itself will not post is dropped like a refused one, and the log says who said no', async (t) => {
  // src/telemetry/index.mjs answers this way when its last check of a batch leaves nothing that may be sent.
  const queue = createQueue({ file: path.join(tempDir(t), 'queue.jsonl') });
  await queue.load();
  for (let i = 1; i <= 3; i++) queue.add(envelope(i));
  const clock = fakeClock();
  const notes = [];
  const flusher = createFlusher({ queue, canSend: () => true, now: clock.now, random: () => 0.5, note: (m) => notes.push(m), post: async () => ({ result: 'drop', status: 0, reason: 'nothing in it may be sent' }) });
  await flusher.tick();
  assert.equal(queue.size, 0);
  assert.deepEqual(notes, ['a batch of 3 was dropped unsent: nothing in it may be sent']);
  assert.equal(flusher.pausedUntil - clock.now(), 1 * MIN, 'and it counts toward the hour\'s limit and its pause, like any drop');
  await queue.settled();
});

test('a post that throws is a failure like any other: the loop survives and the events stay', async (t) => {
  const queue = createQueue({ file: path.join(tempDir(t), 'queue.jsonl') });
  await queue.load();
  queue.add(envelope(1));
  const clock = fakeClock();
  const flusher = createFlusher({ queue, canSend: () => true, now: clock.now, random: () => 0.5, post: async () => { throw new Error('boom'); } });
  await flusher.flush();
  assert.equal(queue.size, 1);
  assert.equal(flusher.pausedUntil - clock.now(), 1 * MIN);
  await queue.settled();
});

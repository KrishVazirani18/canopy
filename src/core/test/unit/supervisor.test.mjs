// supervisor.mjs: the pieces Session's reliability rests on, tested without claude.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const sup = await core('supervisor.mjs');
const missing = sup.__missing ? `supervisor.mjs: ${sup.__missing}` : false;
const need = (name) => missing || (typeof sup[name] === 'undefined' ? `supervisor.mjs does not export ${name} yet` : false);

const tick = () => new Promise((r) => setImmediate(r));

// ---- InputQueue ----

test('InputQueue delivers pushes in order to a waiting reader', { skip: need('InputQueue') }, async () => {
  const q = new sup.InputQueue();
  const it = q[Symbol.asyncIterator]();
  const first = it.next();
  assert.equal(q.push('a'), true);
  assert.equal(q.push('b'), true);
  assert.deepEqual(await first, { value: 'a', done: false });
  assert.deepEqual(await it.next(), { value: 'b', done: false });
});

test('InputQueue refuses a push after close', { skip: need('InputQueue') }, async () => {
  const q = new sup.InputQueue();
  q.close();
  assert.equal(q.push('late'), false);
  assert.equal(q.size, 0);
  const it = q[Symbol.asyncIterator]();
  assert.equal((await it.next()).done, true);
});

test('InputQueue close while a reader waits ends the read', { skip: need('InputQueue') }, async () => {
  const q = new sup.InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  q.close();
  assert.equal((await pending).done, true);
  assert.equal((await it.next()).done, true);
});

test('InputQueue drain returns what the reader never took', { skip: need('InputQueue') }, () => {
  const q = new sup.InputQueue();
  q.push(1); q.push(2);
  assert.equal(q.size, 2);
  assert.deepEqual(q.drain(), [1, 2]);
  assert.equal(q.size, 0);
  assert.deepEqual(q.drain(), []);
});

test('InputQueue has a single consumer', { skip: need('InputQueue') }, async () => {
  const q = new sup.InputQueue();
  const it = q[Symbol.asyncIterator]();
  assert.throws(() => q[Symbol.asyncIterator]());
  const pending = it.next();
  await assert.rejects(it.next());
  q.push('x');
  assert.equal((await pending).value, 'x');
});

test('InputQueue close is idempotent and reports why once', { skip: need('InputQueue') }, async () => {
  const seen = [];
  const q = new sup.InputQueue({ onClose: (why) => seen.push(why) });
  const it = q[Symbol.asyncIterator]();
  await it.return();
  q.close('again');
  q.close();
  assert.deepEqual(seen, ['return']);
  assert.equal(q.closed, true);
});

test('InputQueue has no stray snapshot method', { skip: need('InputQueue') }, () => {
  assert.equal(typeof new sup.InputQueue().snapshot, 'undefined');
});

test('InputQueue survives an onClose that throws', { skip: need('InputQueue') }, () => {
  const q = new sup.InputQueue({ onClose: () => { throw new Error('observer bug'); } });
  assert.doesNotThrow(() => q.close());
  assert.equal(q.push('x'), false);
});

// ---- timing primitives ----

test('withTimeout rejects with code "timeout" and passes values through', { skip: need('withTimeout') }, async () => {
  assert.equal(await sup.withTimeout(Promise.resolve(7), 50, 'fast'), 7);
  assert.equal(await sup.withTimeout(7, 50, 'plain value'), 7);
  await assert.rejects(sup.withTimeout(new Promise(() => {}), 15, 'slow'), (err) => err.code === 'timeout' && /slow/.test(err.message));
  await assert.rejects(sup.withTimeout(Promise.reject(new Error('boom')), 50, 'failing'), /boom/);
});

test('withTimeout swallows a rejection that arrives after the timeout', { skip: need('withTimeout') }, async () => {
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    let fail;
    const late = new Promise((_, reject) => { fail = reject; });
    await assert.rejects(sup.withTimeout(late, 10, 'late'), (err) => err.code === 'timeout');
    fail(new Error('too late'));
    await tick(); await tick();
    assert.equal(unhandled, null);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('backoffMs follows 500, 2000, 8000 with at most 20% jitter', { skip: need('backoffMs') }, () => {
  for (const [attempt, base] of [[1, 500], [2, 2000], [3, 8000], [9, 8000]]) {
    for (let i = 0; i < 40; i++) {
      const ms = sup.backoffMs(attempt);
      assert.ok(ms >= base * 0.8 - 1 && ms <= base * 1.2 + 1, `attempt ${attempt} gave ${ms}`);
    }
  }
});

test('RestartBudget allows max restarts per window and resets', { skip: need('RestartBudget') }, () => {
  const b = new sup.RestartBudget({ max: 3, windowMs: 60000 });
  assert.equal(b.allow(), true);
  assert.equal(b.allow(), true);
  assert.equal(b.allow(), true);
  assert.equal(b.attempt, 3);
  assert.equal(b.allow(), false);
  b.reset();
  assert.equal(b.attempt, 0);
  assert.equal(b.allow(), true);
});

test('TIMEOUTS carries every watchdog the plan names', { skip: need('TIMEOUTS') }, () => {
  for (const k of ['init', 'slowStart', 'set', 'ctx', 'mcp', 'meta', 'interrupt', 'stopInterrupt', 'stopGrace', 'stopWatch', 'ack', 'stall', 'ping']) {
    assert.ok(Number.isFinite(sup.TIMEOUTS[k]) && sup.TIMEOUTS[k] > 0, `TIMEOUTS.${k}`);
  }
  assert.ok(sup.TIMEOUTS.interrupt < sup.TIMEOUTS.stopWatch, 'the stop watchdog must outlast the interrupt call');
});

// ---- classify ----

const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const base = { stderr: '', startup: null, sawInit: true, cwdExists: true, hadSessionId: false, clean: false, wasBusy: false, turnErrorShown: false, optionalFlags: ['thinking-display'] };

const TABLE = [
  ['missing resume id in the startup result', err('Claude Code returned an error result', { errorClass: 'error_result' }),
    { sawInit: false, hadSessionId: true, startup: { reason: null, text: 'No conversation found with session ID: 1b2c' } }, { code: 'resume-missing', retry: 'fresh' }],
  ['missing resume id in stderr', err('Claude Code process exited with code 1'),
    { sawInit: false, hadSessionId: true, stderr: 'Error: No conversation found with session ID: 1b2c\n' }, { code: 'resume-missing', retry: 'fresh' }],
  ['the same text without a session id is not a resume problem', err('No conversation found with session ID: 1b2c'),
    { hadSessionId: false }, { not: 'resume-missing' }],
  ['an unknown optional flag is dropped', err('Claude Code process exited with code 1'),
    { sawInit: false, stderr: "error: unknown option '--thinking-display'\n" }, { code: 'bad-flag', retry: 'drop-flag', flag: 'thinking-display' }],
  ['an unknown flag we do not consider optional is not dropped', err('Claude Code process exited with code 1'),
    { sawInit: false, stderr: "error: unknown option '--resume'\n" }, { not: 'bad-flag' }],
  ['a deleted folder', err('spawn /usr/local/bin/claude ENOENT', { code: 'ENOENT' }),
    { sawInit: false, cwdExists: false }, { code: 'cwd-missing', retry: null, recoverable: false }],
  ['startup reason cwd_unavailable', null,
    { sawInit: false, clean: true, startup: { reason: 'cwd_unavailable', text: 'cwd is gone' } }, { code: 'cwd-missing', recoverable: false }],
  ['claude is not installed', err('Claude Code native binary not found', { errorClass: 'executable_not_found' }),
    { sawInit: false }, { code: 'not-installed', retry: 'refind' }],
  ['spawn ENOENT with the folder present', err('spawn /nope/claude ENOENT', { code: 'ENOENT' }),
    { sawInit: false }, { code: 'not-installed', retry: 'refind' }],
  ['the binary cannot be launched', err('EACCES', { errorClass: 'executable_launch_failed' }),
    { sawInit: false }, { code: 'launch-failed', retry: null }],
  ['another process holds the session', null,
    { sawInit: false, clean: true, startup: { reason: 'session_held_by_background', text: 'held' } }, { code: 'session-busy', retry: null }],
  ['the CLI is too old', null,
    { sawInit: false, clean: true, startup: { reason: 'cli_version_too_old', text: 'old' } }, { code: 'version', retry: null }],
  ['any other startup refusal', null,
    { sawInit: false, clean: true, startup: { reason: 'org_pin_mismatch', text: 'wrong org' } }, { code: 'startup-refused', retry: null }],
  ['an error result the user already saw', err('Claude Code returned an error result: boom', { errorClass: 'error_result' }),
    { turnErrorShown: true }, { code: 'turn-error', retry: 'restart' }],
  ['killed by a signal', err('Claude Code process terminated by signal SIGKILL'),
    { signal: 'SIGKILL', wasBusy: true }, { code: 'crashed', retry: 'restart', recoverable: true }],
  ['a nonzero exit', err('Claude Code process exited with code 1'),
    { exitCode: 1 }, { code: 'crashed', retry: 'restart' }],
  ['a clean exit while a turn was running', null,
    { clean: true, wasBusy: true, exitCode: 0 }, { code: 'crashed', retry: 'restart' }],
  ['a clean exit while idle', null,
    { clean: true, wasBusy: false, exitCode: 0 }, { code: 'exited', retry: 'restart' }],
  ['anything else', err('something odd'), {}, { code: 'unknown', retry: 'restart' }],
];

for (const [name, error, ctx, want] of TABLE) {
  test(`classify: ${name}`, { skip: need('classify') }, () => {
    const got = sup.classify(error, { ...base, ...ctx });
    assert.equal(typeof got.code, 'string');
    assert.equal(typeof got.message, 'string');
    assert.ok(got.message.length > 0, 'every classification explains itself');
    if (want.not) { assert.notEqual(got.code, want.not); return; }
    assert.equal(got.code, want.code);
    if ('retry' in want) assert.equal(got.retry ?? null, want.retry);
    if ('recoverable' in want) assert.equal(got.recoverable, want.recoverable);
    if ('flag' in want) assert.equal(got.flag, want.flag);
  });
}

test('classify never throws on junk', { skip: need('classify') }, () => {
  for (const e of [undefined, null, 'a string', 42, {}, { message: null }, new Error('')]) {
    for (const ctx of [undefined, {}, { stderr: null, startup: {} }]) assert.doesNotThrow(() => sup.classify(e, ctx));
  }
});

test('classify reports the exit code and signal it was given', { skip: need('classify') }, () => {
  const got = sup.classify(err('Claude Code process terminated by signal SIGKILL'), { ...base, signal: 'SIGKILL', exitCode: null });
  assert.equal(got.signal, 'SIGKILL');
  assert.equal(sup.classify(err('Claude Code process exited with code 3'), { ...base, exitCode: 3 }).exitCode, 3);
});

// ---- Outbox ----

test('Outbox moves forward only and forgets finished sends', { skip: need('Outbox') }, () => {
  const seen = [];
  const box = new sup.Outbox({ onChange: (e, state) => seen.push(`${e.id}:${state ?? e.state}`) });
  box.add('a', { type: 'user' }, 'hello', 0);
  assert.equal(box.pending().length, 1);
  box.mark('a', 'written');
  box.mark('a', 'queued');
  box.mark('a', 'written'); // a late, out-of-order ack must not move it back
  assert.equal(box.get('a').state, 'queued');
  box.mark('a', 'started');
  assert.equal(box.unstarted().length, 0);
  // Image data is not kept once the model has it: at the latest when the send finishes.
  if (typeof box.dropPayloads === 'function') { box.dropPayloads(); assert.equal(box.get('a').msg ?? null, null); }
  const done = box.mark('a', 'completed');
  assert.equal(done.msg ?? null, null, 'a finished send holds no payload');
  assert.equal(box.has('a'), false);
  assert.deepEqual(seen, ['a:pending', 'a:written', 'a:queued', 'a:started', 'a:completed']);
});

test('Outbox tolerates unknown ids and skipped states', { skip: need('Outbox') }, () => {
  const box = new sup.Outbox();
  assert.doesNotThrow(() => box.mark('ghost', 'started'));
  box.add('b', { type: 'user' }, 'x', 2);
  box.mark('b', 'started'); // init can name a send before its `queued` frame arrives
  assert.equal(box.get('b').state, 'started');
  assert.deepEqual(box.snapshot(), [{ id: 'b', text: 'x', images: 2, state: 'started' }]);
});

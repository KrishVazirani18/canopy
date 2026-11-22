// Control channel: Canopy's own control requests to Claude Code, on the same pipes the Agent SDK uses.
//
// The SDK's Query object has no method for some control requests (mcp_call, which Code Mode is built on), so
// Canopy writes those frames to the child's stdin itself and takes the matching control_response off stdout
// before the SDK reads it. Everything else reaches the SDK byte for byte:
//  - With nothing of ours in flight, stdout chunks pass through untouched.
//  - While a request is in flight, stdout is read a line at a time and only a control_response carrying one of
//    our request ids is held back.
//
//   const ch = controlChannel(child);
//   return ch.process;                         // what spawnClaudeCodeProcess hands the SDK
//   const { id, answer } = ch.request({ subtype: 'mcp_call', tool, arguments });
//   const r = await answer;                    // { ok: true, response } | { ok: false, error }
//   ch.cancel(id);                             // the answer then arrives as { ok: false, error: 'mcp_call cancelled…' }
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

// The SDK's own request ids are random strings; this prefix can never be one of them.
export const REQUEST_PREFIX = 'canopy-';
const MARK = '"control_response"';
const NEWLINE = 0x0a;
const CANCEL_GRACE_MS = 30_000;

const closedError = (why) => Object.assign(new Error(why), { code: 'closed' });

/**
 * @param {import('node:child_process').ChildProcess} child spawned with piped stdin and stdout
 * @returns {{ process: object, request: (request: object, opts?: {timeoutMs?: number}) => {id: string, answer: Promise<{ok: true, response: any} | {ok: false, error: string}>},
 *   cancel: (id: string) => void, close: (why?: string) => void, readonly open: boolean, readonly inFlight: number }}
 */
export function controlChannel(child) {
  const pending = new Map(); // request id -> { resolve, reject, timer }
  const out = new PassThrough();
  let held = [];        // the start of a line that may yet be an answer to us (never while midLine)
  let midLine = false;  // the last byte handed to the SDK was not a newline
  let closed = null;

  // The SDK may stop reading before the child stops writing (a close, a kill): what arrives after that is dropped.
  const forward = (buf) => { if (!out.destroyed && !out.writableEnded && !out.write(buf)) child.stdout.pause(); };
  out.on('drain', () => child.stdout.resume());
  out.on('close', () => child.stdout.resume());
  out.on('error', () => {}); // reaches the SDK's own listener; without one here it would be an uncaught exception

  const settle = (id, fn) => {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
    return true;
  };

  // True when the line is the answer to one of our requests (and so not the SDK's to read).
  const take = (line) => {
    if (!line.includes(MARK)) return false;
    let m;
    try { m = JSON.parse(line.toString('utf8')); } catch { return false; }
    const r = m?.type === 'control_response' ? m.response : null;
    if (!r || typeof r.request_id !== 'string') return false;
    return settle(r.request_id, (p) => p.resolve(r.subtype === 'success' ? { ok: true, response: r.response ?? null } : { ok: false, error: String(r.error ?? 'The request failed.') }));
  };

  child.stdout.on('data', (chunk) => {
    if (!chunk.length) return;
    if (!pending.size && !held.length) { midLine = chunk[chunk.length - 1] !== NEWLINE; forward(chunk); return; }
    let start = 0;
    for (let nl = chunk.indexOf(NEWLINE); nl >= 0; nl = chunk.indexOf(NEWLINE, start)) {
      let line = chunk.subarray(start, nl + 1);
      start = nl + 1;
      if (held.length) { held.push(line); line = Buffer.concat(held); held = []; }
      // A line that was already part-way out when our request went in cannot be its answer.
      if (midLine) { midLine = false; forward(line); } else if (!pending.size || !take(line)) forward(line);
    }
    if (start >= chunk.length) return;
    const tail = chunk.subarray(start);
    if (!midLine && (pending.size || held.length)) held.push(tail);
    else { midLine = true; forward(tail); }
  });
  child.stdout.once('end', () => { if (held.length) forward(Buffer.concat(held)); held = []; if (!out.destroyed) out.end(); });
  child.stdout.once('error', (err) => out.destroy(err));

  const close = (why = 'Claude Code stopped.') => {
    if (closed) return;
    closed = why;
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(closedError(why)));
  };
  child.once('exit', () => close());
  child.once('error', () => close());

  const write = (frame) => {
    try { child.stdin.write(JSON.stringify(frame) + '\n'); return true; } catch { return false; }
  };

  return {
    // What the SDK is given in place of the child: the real process for everything except stdout.
    process: {
      stdin: child.stdin, stdout: out,
      get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
      kill: (signal) => child.kill(signal), on: (e, f) => child.on(e, f), once: (e, f) => child.once(e, f), off: (e, f) => child.off(e, f),
    },
    get open() { return !closed; },
    get inFlight() { return pending.size; },

    // Rejects only when no answer can come (the process is gone, or timeoutMs passed). An error answer resolves.
    request(request, { timeoutMs = 0 } = {}) {
      const id = REQUEST_PREFIX + randomUUID();
      const answer = new Promise((resolve, reject) => {
        if (closed) return reject(closedError(closed));
        const timer = timeoutMs > 0 ? setTimeout(() => settle(id, (p) => p.reject(Object.assign(new Error('Claude Code did not answer in time.'), { code: 'timeout' }))), timeoutMs) : null;
        timer?.unref?.();
        pending.set(id, { resolve, reject, timer });
        if (!write({ type: 'control_request', request_id: id, request })) settle(id, (p) => p.reject(closedError('Claude Code stopped.')));
      });
      return { id, answer };
    },

    // Ask Claude Code to abandon a request. Its answer is still taken off stdout when it comes; if none comes, the
    // entry is dropped after a short grace so it cannot pin memory.
    cancel(id) {
      const p = pending.get(id);
      if (!p || closed) return;
      write({ type: 'control_cancel_request', request_id: id });
      clearTimeout(p.timer);
      p.timer = setTimeout(() => settle(id, (q) => q.reject(Object.assign(new Error('Cancelled.'), { code: 'cancelled' }))), CANCEL_GRACE_MS);
      p.timer.unref?.();
    },
    close,
  };
}

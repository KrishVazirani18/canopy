// Supervisor primitives for Session: timeouts, restart budget, crash
// classification, the SDK input queue and the outbox that tracks every send
// from "typed" to "answered". No SDK imports and no process access, so all of
// it is unit-testable without claude.

// How long Session waits for Claude Code, by what it is waiting for. All in milliseconds.
export const TIMEOUTS = Object.freeze({
  init: 120000,         // initialize unanswered this long: the start has timed out
  slowStart: 30000,     // a start still going after this long says so in the chat
  set: 8000,            // one live change (model, mode, a rename, stopping a task)
  ctx: 8000,            // the context reading
  ctxFull: 20000,       // the context reading with its full breakdown
  usage: 5000,          // the plan's usage limits
  mcp: 5000,            // the MCP servers' status
  meta: 8000,           // each question asked at start (the commands, the models)
  interrupt: 4000,      // Stop's interrupt call
  stopInterrupt: 2500,  // the interrupt sent before a chat's process is stopped
  stopGrace: 6000,      // how long a stopped process gets to exit by itself
  stopWatch: 8000,      // still busy this long after Stop: Claude Code is restarted
  ack: 5000,            // a message written to Claude Code that it has not picked up
  stall: 120000,        // busy but silent this long: ping it
  ping: 10000,          // the ping's own answer
});

// A process that ran this long before it ended was a working one: its end starts a fresh count of restarts.
export const STABLE_RUN_MS = 60_000;

export const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// Rejects with Error{code:'timeout'} when `p` has not settled within `ms`.
// The underlying call keeps running; callers must tolerate a late settle.
export function withTimeout(p, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { code: 'timeout', label })), ms);
    timer.unref?.();
  });
  const guarded = Promise.resolve(p);
  guarded.catch(() => {}); // a late rejection after the timeout must not become unhandled
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

const BACKOFF = [500, 2000, 8000];
export function backoffMs(attempt, random = Math.random) {
  const base = BACKOFF[Math.min(Math.max(1, attempt | 0), BACKOFF.length) - 1];
  return Math.round(base * (0.8 + random() * 0.4));
}

// At most `max` automatic restarts per sliding window.
export class RestartBudget {
  constructor({ max = 3, windowMs = 60000, now = Date.now } = {}) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.stamps = [];
  }
  get attempt() { this.prune(); return this.stamps.length; }
  prune() { const cut = this.now() - this.windowMs; while (this.stamps.length && this.stamps[0] <= cut) this.stamps.shift(); }
  allow() {
    this.prune();
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(this.now());
    return true;
  }
  reset() { this.stamps.length = 0; }
}

// ---- crash classification ----

const RESUME_MISSING = /No conversation found with session ID/i;
const UNKNOWN_FLAG = /unknown option '?--([a-z0-9-]+)/i;
const STARTUP_CODES = { session_held_by_background: 'session-busy', cli_version_too_old: 'version' };
const STARTUP_TEXT = {
  'session-busy': 'This chat is still running as a Claude Code background session. Open it there with `claude attach`, or stop it there and send again here.',
  version: 'This version of Claude Code is too old for Canopy. Update it with `claude update`.',
};

function describeExit(exitCode, signal) {
  if (signal) return `signal ${signal}`;
  if (exitCode != null) return `exit code ${exitCode}`;
  return null;
}

/**
 * Decide what a dead (or never-started) Claude Code process means.
 * ctx: { stderr, startup:{reason,text}|null, sawInit, cwd, cwdExists, hadSessionId, lastApiError, lastResult,
 *        clean, wasBusy, pendingSends, turnErrorShown, optionalFlags, exitCode, signal }
 * Returns { code, retry: 'fresh'|'drop-flag'|'refind'|'restart'|null, recoverable, message, exitCode, signal, flag, silent }.
 */
export function classify(err, ctx = {}) {
  const raw = err == null ? '' : String(err?.message ?? err);
  const stderr = String(ctx.stderr ?? '');
  const startupText = String(ctx.startup?.text ?? '');
  const reason = ctx.startup?.reason ?? err?.startupFailureReason ?? null;
  const errorClass = err?.errorClass ?? null;
  const exitCode = ctx.exitCode ?? (Number.isInteger(err?.exitCode) ? err.exitCode : null);
  const signal = ctx.signal ?? raw.match(/terminated by signal (SIG[A-Z0-9]+)/)?.[1] ?? null;
  const out = (code, retry, message, extra = {}) => ({
    code, retry, recoverable: extra.recoverable ?? true, message, exitCode, signal, flag: extra.flag ?? null, silent: !!extra.silent,
  });

  if (ctx.hadSessionId && (RESUME_MISSING.test(raw) || RESUME_MISSING.test(startupText) || RESUME_MISSING.test(stderr))) {
    return out('resume-missing', 'fresh', 'That chat is no longer on disk.');
  }
  const flag = stderr.match(UNKNOWN_FLAG)?.[1] ?? raw.match(UNKNOWN_FLAG)?.[1];
  if (flag && (ctx.optionalFlags?.has?.(flag) ?? ctx.optionalFlags?.includes?.(flag))) {
    return out('bad-flag', 'drop-flag', `This version of Claude Code does not support --${flag}.`, { flag });
  }
  if (ctx.cwdExists === false || reason === 'cwd_unavailable') {
    return out('cwd-missing', null, `This folder no longer exists${ctx.cwd ? `: ${ctx.cwd}` : '.'}`, { recoverable: false });
  }
  if (errorClass === 'executable_not_found' || (err?.code === 'ENOENT' && /spawn/i.test(raw))) {
    return out('not-installed', 'refind', 'Claude Code was not found. Install it, or check that `claude` is on your PATH.', { recoverable: false });
  }
  if (errorClass === 'executable_launch_failed') {
    return out('launch-failed', null, `Claude Code could not be launched: ${raw || 'unknown error'}`, { recoverable: false });
  }
  if (reason) {
    const code = STARTUP_CODES[reason] ?? 'startup-refused';
    return out(code, null, STARTUP_TEXT[code] ?? (startupText || raw || 'Claude Code refused to start.'), { recoverable: false });
  }
  if (errorClass === 'error_result' && ctx.turnErrorShown) {
    return out('turn-error', 'restart', raw, { silent: true });
  }
  const how = describeExit(exitCode, signal);
  const clean = ctx.clean ?? err == null;
  const detail = startupText && !ctx.sawInit ? startupText : errorClass === 'error_result' && raw ? raw : null;
  const died = !!signal || (exitCode != null && exitCode !== 0) || errorClass === 'process_exited_nonzero' || errorClass === 'process_killed_by_signal';
  if (died || (clean && (ctx.wasBusy || ctx.pendingSends > 0))) {
    return out('crashed', 'restart', detail ?? `Claude Code stopped unexpectedly${how ? ` (${how})` : ''}.`);
  }
  if (clean) return out('exited', 'restart', 'Claude Code exited.');
  return out('unknown', 'restart', detail ?? (raw || 'Claude Code stopped for an unknown reason.'));
}

// ---- SDK input queue ----

// The single-consumer async iterable handed to query() as its prompt stream.
// The SDK calls return() when a stdin write fails; `onClose` lets Session see that.
export class InputQueue {
  constructor({ onClose } = {}) {
    this.items = []; this.waiter = null; this.closed = false; this.why = null;
    this.onClose = onClose ?? null; this.iterating = false;
  }
  get size() { return this.items.length; }
  push(x) {
    if (this.closed) return false;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve({ value: x, done: false }); }
    else this.items.push(x);
    return true;
  }
  /** Items handed to push() that the consumer never took. */
  drain() { const left = this.items; this.items = []; return left; }
  close(why = 'close') {
    if (this.closed) return;
    this.closed = true; this.why = why;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve({ value: undefined, done: true }); }
    try { this.onClose?.(why); } catch { /* observers never break the queue */ }
  }
  [Symbol.asyncIterator]() {
    if (this.iterating) throw new Error('InputQueue supports a single consumer.');
    this.iterating = true;
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        if (this.waiter) return Promise.reject(new Error('InputQueue.next() called while a read is pending.'));
        return new Promise((resolve) => { this.waiter = { resolve }; });
      },
      return: () => { this.close('return'); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

// ---- outbox ----

const RANK = { pending: 0, written: 1, queued: 2, started: 3 };
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'lost']);

// Every send lives here from send() until Claude Code reports it finished.
// pending -> written -> queued -> started -> (completed | cancelled | failed | lost)
export class Outbox {
  constructor({ onChange } = {}) { this.map = new Map(); this.onChange = onChange ?? null; }
  get size() { return this.map.size; }
  has(id) { return this.map.has(id); }
  get(id) { return this.map.get(id) ?? null; }
  all() { return [...this.map.values()]; }
  pending() { return this.all().filter((e) => e.state === 'pending'); }
  unstarted() { return this.all().filter((e) => e.state !== 'started'); }
  started() { return this.all().filter((e) => e.state === 'started'); }
  unacked() { return this.all().filter((e) => e.state === 'written'); }

  add(id, msg, text = '', images = 0) {
    const e = { id, msg, text, images, state: 'pending', attempts: 0, at: Date.now() };
    this.map.set(id, e);
    this.notify(e);
    return e;
  }
  /** Move an entry forward. Backward moves are ignored; terminal states delete the entry. */
  mark(id, state) {
    const e = this.map.get(id);
    if (!e) return null;
    if (TERMINAL.has(state)) { this.map.delete(id); e.state = state; e.msg = null; this.notify(e); return e; }
    if (!(state in RANK) || RANK[state] <= RANK[e.state]) return e;
    e.state = state;
    this.notify(e);
    return e;
  }
  /** The model has the started sends now: their payloads (images) are no longer needed for redelivery. */
  dropPayloads() { for (const e of this.map.values()) if (e.state === 'started') e.msg = null; }
  /** Put a send back to pending regardless of state, for a restart that provably ran nothing. False when its payload is gone. */
  reopen(id) {
    const e = this.map.get(id);
    if (!e || !e.msg) return false;
    if (e.state !== 'pending') { e.state = 'pending'; this.notify(e); }
    return true;
  }
  /** Written/queued entries go back to pending for redelivery after a restart. Returns those that ran out of attempts. */
  requeue(maxAttempts = 2) {
    const exhausted = [];
    for (const e of this.all()) {
      if (e.state !== 'written' && e.state !== 'queued' && e.state !== 'pending') continue;
      if (e.state !== 'pending') e.attempts += 1;
      if (e.attempts >= maxAttempts || !e.msg) { exhausted.push(e); continue; }
      if (e.state !== 'pending') { e.state = 'pending'; this.notify(e); }
    }
    return exhausted;
  }
  /** Close every entry with `state`; returns the closed entries. */
  closeAll(state = 'failed', filter = null) {
    const done = [];
    for (const e of this.all()) if (!filter || filter(e)) { this.mark(e.id, state); done.push(e); }
    return done;
  }
  snapshot() { return this.all().map((e) => ({ id: e.id, text: e.text, images: e.images, state: e.state })); }
  notify(e) { try { this.onChange?.(e, e.state); } catch { /* observers never break the outbox */ } }
}

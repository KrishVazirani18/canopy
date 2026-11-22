// SessionManager: several live conversations behind one event stream.
//
// The host opens sessions through the manager and marks one of them active. Sessions that are
// neither active nor working stay warm up to `maxIdle`; beyond that the least recently used one
// is disposed (its conversation stays on disk and reopens with `resume`). A session that is busy,
// has background work or is waiting on a permission prompt is never evicted, and neither is one the
// host keeps on screen (`onScreen`, Multi mode's panes), nor one with a prompt scheduled to wake it
// later (a reminder, a loop): those live in its process and would never fire once it is gone.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Session } from './session.mjs';

const sameDir = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a) === path.resolve(b);

function isWorking(session) {
  // On a Session, `background` is a method (move a tool to the background); the count is `backgroundCount`.
  const bg = session.backgroundCount ?? (typeof session.background === 'function' ? 0 : session.background);
  return !!session.busy || (Array.isArray(bg) ? bg.length > 0 : !!bg) || (session.pending?.size ?? 0) > 0;
}

// Prompts set to wake the chat later (Session's `scheduledCount`). Not "working": the chat is idle, it just must stay.
const hasScheduled = (session) => (session.scheduledCount ?? 0) > 0;

export class SessionManager extends EventEmitter {
  /**
   * @param {{maxIdle?: number, create?: (opts: object) => import('./session.mjs').Session}} [opts]
   *   `create` builds a session from the options given to `open` (the test seam, and where a host adds defaults).
   */
  constructor({ maxIdle = 2, create } = {}) {
    super();
    this.maxIdle = Number.isInteger(maxIdle) && maxIdle >= 0 ? maxIdle : 2;
    this.create = typeof create === 'function' ? create : (opts) => new Session(opts);
    this.entries = new Map();       // sid -> { sid, session, cwd, lastUsed, onEvent }
    this.closing = new Map();       // sid -> { sessionId, done: Promise }
    this.onScreen = new Set();      // sids the host shows besides the active one (Multi mode panes): never evicted
    this.activeSid = null;
    this.clock = 0;
  }

  /**
   * Open a conversation. A live session for the same `resume` id and folder is reused, so
   * switching back to a chat never starts a second process on its transcript.
   * @param {object} opts Session options (`cwd`, `resume`, …)
   * @param {{activate?: boolean}} [how] the opened session becomes the active one unless `activate` is false
   * @returns {{session: import('./session.mjs').Session, sid: string, reused: boolean}}
   */
  open(opts = {}, { activate = true } = {}) {
    const hit = opts.resume ? this.find({ sessionId: opts.resume, cwd: opts.cwd }) : null;
    if (hit) {
      this.#touch(hit.sid);
      if (activate) this.setActive(hit.sid); else this.#evict();
      return { ...hit, reused: true };
    }
    const session = this.create(opts);
    const sid = randomUUID();
    const entry = { sid, session, cwd: opts.cwd ?? session.cwd ?? null, lastUsed: ++this.clock, onEvent: null };
    entry.onEvent = (ev) => this.#forward(entry, ev);
    session.on('event', entry.onEvent);
    this.entries.set(sid, entry);
    if (activate) this.setActive(sid); else this.#evict(sid);
    return { session, sid, reused: false };
  }

  /** The session with this manager id, or null. */
  get(sid) { return this.entries.get(sid)?.session ?? null; }

  /** The live session holding this Claude Code session id (in `cwd`, when given), or null. */
  find({ sessionId, cwd } = {}) {
    if (!sessionId) return null;
    for (const e of this.entries.values()) {
      if (e.session.closed || e.session.lifecycle === 'failed') continue;
      if (e.session.sessionId === sessionId && (cwd == null || sameDir(e.cwd, cwd))) return { session: e.session, sid: e.sid };
    }
    return null;
  }

  /** The active session, or null. */
  get active() {
    const e = this.entries.get(this.activeSid);
    return e ? { session: e.session, sid: e.sid } : null;
  }

  get size() { return this.entries.size; }

  /** Every open session, for the host to act on all of them (e.g. re-check trust after a project is opened). */
  sessions() { return [...this.entries.values()].map((e) => e.session); }

  /** What is open right now, most recently used first. */
  list() {
    return [...this.entries.values()].sort((a, b) => b.lastUsed - a.lastUsed).map((e) => ({
      sid: e.sid, sessionId: e.session.sessionId ?? null, cwd: e.cwd, active: e.sid === this.activeSid,
      busy: !!e.session.busy, working: isWorking(e.session), lifecycle: e.session.lifecycle ?? null,
    }));
  }

  /** Mark the session the user is looking at. Returns false for an unknown id. */
  setActive(sid) {
    if (sid != null && !this.entries.has(sid)) return false;
    this.activeSid = sid ?? null;
    if (sid != null) this.#touch(sid);
    this.#evict();
    return true;
  }

  /**
   * Close one session and wait until its process is gone.
   * @returns {Promise<{ok: boolean}>}
   */
  async close(sid, { graceMs } = {}) {
    const entry = this.entries.get(sid);
    if (!entry) { await this.closing.get(sid)?.done; return { ok: false }; }
    await this.#dispose(entry, 'closed', graceMs);
    return { ok: true };
  }

  /** Close everything (app quit). Resolves when every process has exited or been killed. */
  async closeAll({ graceMs } = {}) {
    const pending = [...this.entries.values()].map((e) => this.#dispose(e, 'closed', graceMs));
    await Promise.allSettled([...pending, ...[...this.closing.values()].map((c) => c.done)]);
  }

  /**
   * Resolves once no session being closed still holds this conversation. Await it before
   * reopening a chat that was just closed or evicted: one process per transcript.
   */
  async whenClosed(sessionId) {
    await Promise.allSettled([...this.closing.values()].filter((c) => !sessionId || c.sessionId === sessionId).map((c) => c.done));
  }

  #touch(sid) { const e = this.entries.get(sid); if (e) e.lastUsed = ++this.clock; }

  #forward(entry, ev) {
    if (ev?.kind === 'busy') {
      this.#touch(entry.sid);
      // Going idle is the moment a background session becomes evictable.
      if (ev.busy === false) queueMicrotask(() => this.#evict());
    }
    try { this.emit('event', { ...ev, sid: entry.sid }); }
    // A listener's bug must not unwind into the session that emitted the event. Surface it on its own tick.
    catch (err) { queueMicrotask(() => { throw err; }); }
  }

  #evict(keep) {
    for (const e of [...this.entries.values()]) if (e.session.closed) this.#dispose(e, 'gone');
    const idle = [...this.entries.values()]
      .filter((e) => e.sid !== this.activeSid && e.sid !== keep && !this.onScreen.has(e.sid) && !isWorking(e.session) && !hasScheduled(e.session))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (idle.length > this.maxIdle) this.#dispose(idle.shift(), 'evicted');
  }

  #dispose(entry, reason, graceMs) {
    const running = this.closing.get(entry.sid);
    if (running) return running.done;
    this.entries.delete(entry.sid);
    if (this.activeSid === entry.sid) this.activeSid = null;
    const { session, sid } = entry;
    const sessionId = session.sessionId ?? null;
    // The listener stays attached until the process is gone, so the final turn-end and stopped events still arrive.
    const done = (async () => {
      try {
        if (session.closed) return;
        if (typeof session.dispose === 'function') await session.dispose(Number.isFinite(graceMs) ? { graceMs } : {});
        else session.close();
      } catch { /* a session that fails to shut down cleanly is still gone from the manager */ }
    })().finally(() => {
      session.off('event', entry.onEvent);
      this.closing.delete(sid);
      this.emit('closed', { sid, sessionId: session.sessionId ?? sessionId, reason });
    });
    this.closing.set(sid, { sessionId, done });
    return done;
  }
}

// JSON-RPC over a pipe, the way `codex app-server --listen stdio://` speaks it: one JSON object per line, no
// "jsonrpc" field, requests in both directions.
//
// Contract:
//  - feed() takes whatever the pipe delivers: half a line, many lines, bytes cut in the middle of a character,
//    or text that is not JSON at all. Nothing it is given makes it throw. A line that cannot be read is counted
//    and handed to onGarbage; the lines around it are still delivered.
//  - request() always settles: with the result, or by rejecting with an Error whose `code` is 'timeout'
//    (no answer in time), 'rpc' (the server said no; `rpcCode`, `data`), 'too-large' (the answer was a line
//    longer than is read; it was dropped) or 'closed' (the pipe is gone).
//  - Reading one long line costs time in step with its length: a chunk is searched for its newline once, and the
//    pieces of an unfinished line are joined once, when the newline arrives.
//  - The server counts its own request ids from 0, so they overlap with ours. A line is a request or a
//    notification when it has a `method`, and an answer to one of ours only when it has none.
//  - A handler that throws never breaks the reader.
// No process and no file access here, so all of it is unit-testable with strings.
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_LINE = 64 * 1024 * 1024; // a line longer than this is not a message; it is dropped, not kept in memory

// An answer opens with its id (`{"id":12,"result":…`), so the request a dropped line answered can still be told.
const ANSWER_HEAD = /^\s*\{\s*"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")\s*,\s*"(?:result|error)"/;

const isId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

export function rpcError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...extra });
}

export class RpcPeer {
  /**
   * @param {{
   *   write: (line: string) => unknown,                      sends one line (with its newline); may throw or return false
   *   onNotification?: (method: string, params: any, msg: object) => void,
   *   onRequest?: (id: string | number, method: string, params: any, msg: object) => void,
   *   onGarbage?: (text: string, why: string) => void,       a line that was not a message (never its full text: 200 chars)
   *   timeoutMs?: number,                                    default time limit for request()
   * }} opts
   */
  constructor({ write, onNotification, onRequest, onGarbage, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.write = write;
    this.onNotification = onNotification ?? null;
    this.onRequest = onRequest ?? null;
    this.onGarbage = onGarbage ?? null;
    this.timeoutMs = timeoutMs;
    this.decoder = new StringDecoder('utf8');
    this.parts = [];         // the pieces of the line still arriving
    this.held = 0;           // their length together
    this.skipping = false;   // inside an oversized line: drop until its newline
    this.nextId = 1;
    this.waiting = new Map(); // id -> { resolve, reject, timer, method }
    this.closed = false;
    this.why = null;
    this.garbage = 0;
    this.lastLineAt = 0;
  }

  get inFlight() { return this.waiting.size; }

  // ---- reading ----

  feed(chunk) {
    if (this.closed || chunk == null) return;
    let text;
    try { text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk); } catch { return; }
    if (!text) return;
    let from = 0;
    for (let at; (at = text.indexOf('\n', from)) >= 0; from = at + 1) {
      if (this.skipping) { this.skipping = false; continue; }
      const piece = text.slice(from, at);
      if (!this.parts.length) { this.line(piece); if (this.closed) return; continue; }
      const head = this.parts[0];
      const tooLong = this.held + piece.length > MAX_LINE;
      const whole = tooLong ? null : (this.parts.push(piece), this.parts.join(''));
      this.parts = []; this.held = 0;
      if (tooLong) this.tooLong(head); else this.line(whole);
      if (this.closed) return;
    }
    if (from >= text.length || this.skipping) return;
    const rest = from ? text.slice(from) : text;
    this.parts.push(rest);
    this.held += rest.length;
    if (this.held > MAX_LINE) {
      const head = this.parts[0];
      this.parts = []; this.held = 0;
      this.skipping = true;
      this.tooLong(head);
    }
  }

  // A line too long to be read was dropped. If it was the answer to a request, that request is told now rather
  // than left to wait out its time limit.
  tooLong(head) {
    this.bad('', 'a line was too long to be a message');
    let id;
    try { const m = ANSWER_HEAD.exec(String(head).slice(0, 400)); if (m) id = JSON.parse(m[1]); } catch { id = undefined; }
    const w = id === undefined ? null : this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    w.reject(rpcError('too-large', `${w.method} answered with more than can be read at once`, { method: w.method }));
  }

  line(raw) {
    const text = raw.trim();
    if (!text) return;
    this.lastLineAt = Date.now();
    let msg;
    try { msg = JSON.parse(text); } catch { return this.bad(text, 'not JSON'); }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return this.bad(text, 'not a message');
    if (typeof msg.method === 'string' && msg.method) {
      if (isId(msg.id)) this.call(this.onRequest, msg.id, msg.method, msg.params, msg);
      else this.call(this.onNotification, msg.method, msg.params, msg);
      return;
    }
    if (isId(msg.id) && ('result' in msg || 'error' in msg)) return this.answer(msg);
    this.bad(text, 'neither a request nor an answer');
  }

  answer(msg) {
    const w = this.waiting.get(msg.id);
    if (!w) return; // an answer that arrived after its time limit: the caller has already moved on
    this.waiting.delete(msg.id);
    clearTimeout(w.timer);
    if (msg.error != null) {
      const e = msg.error && typeof msg.error === 'object' ? msg.error : { message: String(msg.error) };
      w.reject(rpcError('rpc', String(e.message ?? 'The request was refused.'), { rpcCode: e.code ?? null, data: e.data ?? null, method: w.method }));
    } else w.resolve(msg.result);
  }

  bad(text, why) {
    this.garbage += 1;
    this.call(this.onGarbage, String(text).slice(0, 200), why);
  }

  call(fn, ...args) {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch { /* a handler's bug never stops the reader */ }
  }

  // ---- writing ----

  send(obj) {
    if (this.closed) return false;
    let line;
    try { line = JSON.stringify(obj); } catch { return false; }
    if (line === undefined) return false;
    try { return this.write(`${line}\n`) !== false; } catch { return false; }
  }

  /** Ask the server for something. Rejects with Error{code: 'timeout' | 'rpc' | 'closed'}; never hangs. */
  request(method, params, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(rpcError('closed', this.why ?? 'The connection is closed.', { method }));
      const id = this.nextId++;
      const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs;
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        reject(rpcError('timeout', `${method} got no answer within ${ms} ms`, { method }));
      }, ms);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer, method });
      const msg = params === undefined ? { id, method } : { id, method, params };
      if (!this.send(msg)) {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(rpcError('closed', 'The request could not be written.', { method }));
      }
    });
  }

  notify(method, params) { return this.send(params === undefined ? { method } : { method, params }); }

  /** Answer a request the server made. */
  respond(id, result) { return this.send({ id, result: result ?? {} }); }

  respondError(id, code, message) { return this.send({ id, error: { code, message: String(message ?? 'Not supported.') } }); }

  /** The pipe is gone: everything still waiting for an answer is told so. */
  close(why = 'The connection was closed.') {
    if (this.closed) return;
    this.closed = true;
    this.why = why;
    this.parts = []; this.held = 0;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.reject(rpcError('closed', why, { method: w.method }));
    }
  }
}

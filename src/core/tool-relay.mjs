// The tool relay: how an agent that is not in this process calls Canopy's tools.
//
// Claude Code takes Canopy's tools in-process (the Agent SDK's MCP servers). Codex cannot: it starts its MCP servers
// as programs of its own. So a Codex chat is given one MCP server, `canopy`, which is a small helper process
// (tool-relay-helper.mjs). The helper holds no tool: it asks here which tools the chat has and passes every call back
// over a Unix socket, where the same definitions run that a Claude chat's tools are made from (tool-registry.mjs).
//
//   ToolRelay                 one for the app. It listens on a socket in a folder only this user can open, from the
//                             first chat that needs it.
//     .connect({ tools, call })   a chat's process is about to start: a token of its own for it. Resolves to a link:
//                                   server    the MCP server the agent should start: { command, args, env }
//                                   close()   the process was let go: the token stops working, its calls are stopped
//     .close()                stop listening. The socket and its folder are removed.
//   HELPER                    the helper's source, handed to node with -e
//
// The wire, one JSON object per line:
//   helper -> app   { t: 'hello', token }                    first, within `helloMs`, or the connection is dropped
//                   { t: 'call', id, name, args, meta }      meta: { callId, threadId, turnId } as the agent names them
//                   { t: 'cancel', id }                      the agent no longer wants that call's answer
//   app -> helper   { t: 'ready', tools }                    this chat's tools, as the rows of an MCP tools/list
//                   { t: 'result', id, result }              an MCP tool result: { content, isError? }
//
// Contract:
//  - A connection that does not start with a live token is closed without a word. So is one that sends a line which
//    is not a JSON object, or is longer than `maxLine`.
//  - A token belongs to one start of one chat's process. It is never written to disk and never put on a command
//    line (the agent is given it in the server's `env`), and it stops working the moment that process is let go.
//  - The token says which chat is calling, and nothing more. Whether a call needs the user's yes is decided in the
//    app, call by call (the chat's `call`), so a program that got hold of a token can do nothing with it that the
//    chat's own model could not already ask for.
//  - `call(tool, args, { signal, callId, threadId, turnId })` answers one call with an MCP tool result. `signal`
//    aborts when the agent cancels the call, when the helper goes away, and when the link is closed. A call that
//    throws is answered with a result that says so: nothing here throws to its caller, and connect() resolves to
//    null when the socket could not be opened (the chat then starts without Canopy's tools).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mcpTool } from './tool-registry.mjs';

let helper = null;
try { helper = readFileSync(new URL('./tool-relay-helper.mjs', import.meta.url), 'utf8'); } catch { /* reported by RELAY_MISSING */ }
/** The helper's source: what the agent runs as its MCP server. */
export const HELPER = helper;
/** What this build lacks to relay tools, or null. */
export const RELAY_MISSING = HELPER ? null : 'helper';

export const RELAY_LIMITS = Object.freeze({
  helloMs: 5000,               // how long a new connection has to say who it is
  maxLine: 4 * 1024 * 1024,    // of one line from a helper: a call's arguments are small
  maxPath: 103,                // bytes of socket path macOS takes
});

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const errText = (err) => String(err?.message ?? err);
const digest = (s) => createHash('sha256').update(String(s)).digest();
const failed = (text) => ({ content: [{ type: 'text', text }], isError: true });
const short = (v) => (typeof v === 'string' && v && v.length <= 200 ? v : null);

export class ToolRelay {
  /**
   * @param {{
   *   execPath?: string,            the program that runs the helper: this app's own (Electron as Node), or node
   *   tmpdir?: string,              where the socket's folder is made
   *   limits?: Partial<typeof RELAY_LIMITS>,
   *   log?: (level: string, msg: string, data?: object) => void,
   * }} [opts]
   */
  constructor({ execPath = process.execPath, tmpdir = os.tmpdir(), limits, log } = {}) {
    this.execPath = execPath;
    this.tmpdir = tmpdir;
    this.limits = { ...RELAY_LIMITS, ...(isPlain(limits) ? limits : {}) };
    this.logFn = typeof log === 'function' ? log : null;
    this.dir = null;           // the private folder the socket is in
    this.socketPath = null;
    this.server = null;
    this.listening = null;     // the start in flight, shared by everyone waiting for it
    this.links = new Set();    // one per live token
    this.sockets = new Set();  // every open connection, said hello or not
    this.closed = false;
    this.onExit = () => this.unlink();
  }

  log(level, msg, data) { try { this.logFn?.(level, msg, data); } catch { /* logging never breaks a call */ } }

  /** Listening, from the first call on. Resolves to the socket's path; rejects when it cannot be opened. */
  listen() {
    if (this.closed) return Promise.reject(new Error('The tool relay is closed.'));
    // macOS sweeps its temp folder of what has not been touched for days, and an app can stay open longer than
    // that. A socket that is gone from disk can no longer be reached by a new helper, so a new one is opened; the
    // helpers already connected carry on, and every token stays good.
    if (this.socketPath && !existsSync(this.socketPath)) {
      this.log('warn', 'the tool relay socket was removed from disk; opening a new one');
      const old = this.server;
      this.server = null; this.listening = null;
      this.unlink();
      try { old?.close(); } catch { /* it stops with its last connection either way */ }
    }
    this.listening ??= new Promise((resolve, reject) => {
      let dir = null;
      try {
        // mkdtemp makes the folder for this user alone (0700). A temp folder too deep for a socket's path gives way to /tmp.
        const base = [this.tmpdir, '/tmp'].find((d) => Buffer.byteLength(path.join(d, 'canopy-tools-XXXXXX', 's')) <= this.limits.maxPath) ?? '/tmp';
        dir = mkdtempSync(path.join(base, 'canopy-tools-'));
        chmodSync(dir, 0o700);
        const file = path.join(dir, 's');
        const server = net.createServer((socket) => this.accept(socket));
        server.once('error', (err) => { this.remove(dir); reject(err); });
        server.listen(file, () => {
          server.removeAllListeners('error');
          server.on('error', (err) => this.log('warn', 'the tool relay socket failed', { error: errText(err) }));
          try { chmodSync(file, 0o600); } catch { /* the folder already keeps everyone else out */ }
          if (this.closed) { server.close(); this.remove(dir); return reject(new Error('The tool relay is closed.')); }
          this.dir = dir; this.socketPath = file; this.server = server;
          server.unref?.(); // an app that is quitting does not wait on it
          process.removeListener('exit', this.onExit);
          process.once('exit', this.onExit);
          resolve(file);
        });
      } catch (err) { this.remove(dir); reject(err); }
    });
    // A failed start is tried again by the next chat.
    this.listening.catch(() => { this.listening = null; });
    return this.listening;
  }

  remove(dir) { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the temp folder is swept by the system */ } } }
  unlink() { const dir = this.dir; this.dir = null; this.socketPath = null; this.remove(dir); }

  /**
   * A token for one start of one chat's process. Never throws: null when the socket could not be opened.
   * @param {{ tools: object[], call: (tool: object, args: object, meta: { signal: AbortSignal, callId: string | null, threadId: string | null, turnId: string | null }) => Promise<object> }} chat
   *   `tools` are definitions (tool-registry.mjs): the chat's tools, in the order the model is told about them.
   */
  async connect({ tools, call } = {}) {
    if (!HELPER || typeof call !== 'function') return null;
    let socketPath;
    try { socketPath = await this.listen(); }
    catch (err) { this.log('warn', 'the tool relay could not start', { error: errText(err) }); return null; }
    const token = randomBytes(32).toString('hex');
    const defs = Array.isArray(tools) ? [...tools] : [];
    const link = {
      token, hash: digest(token), call, closed: false,
      tools: new Map(defs.map((t) => [t.name, t])),
      listed: defs.map(mcpTool),
      sockets: new Set(),
      server: {
        command: this.execPath,
        // The helper's source travels as an argument (it holds nothing secret), so it runs the same from a source
        // tree and from inside an app bundle, with no file of its own to find.
        args: ['--input-type=module', '-e', HELPER],
        // ELECTRON_RUN_AS_NODE: this app's own program run as plain Node. A real node ignores it.
        env: { ELECTRON_RUN_AS_NODE: '1', CANOPY_TOOLS_SOCKET: socketPath, CANOPY_TOOLS_TOKEN: token },
      },
      close: () => {
        if (link.closed) return;
        link.closed = true;
        this.links.delete(link);
        for (const s of [...link.sockets]) s.destroy();
      },
    };
    this.links.add(link);
    return link;
  }

  // The live link a token belongs to. Every live token is compared, each in constant time.
  linkOf(token) {
    if (typeof token !== 'string' || !token) return null;
    const hash = digest(token);
    let found = null;
    for (const link of this.links) if (timingSafeEqual(link.hash, hash)) found = link;
    return found;
  }

  accept(socket) {
    this.sockets.add(socket);
    let link = null;
    let parts = [];
    let size = 0;
    const calls = new Map(); // call id -> AbortController, while it runs
    const drop = () => socket.destroy();
    const hello = setTimeout(drop, this.limits.helloMs);
    hello.unref?.();
    const send = (msg) => { if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`); };

    const onLine = (line) => {
      let m = null;
      try { m = JSON.parse(line); } catch { m = null; }
      if (!isPlain(m)) return drop();
      if (!link) {
        const mine = m.t === 'hello' ? this.linkOf(m.token) : null;
        if (!mine || mine.closed) return drop();
        clearTimeout(hello);
        link = mine;
        link.sockets.add(socket);
        return send({ t: 'ready', tools: link.listed });
      }
      if (m.t === 'cancel') { calls.get(m.id)?.abort(); calls.delete(m.id); return; }
      if (m.t !== 'call' || (typeof m.id !== 'number' && typeof m.id !== 'string') || calls.has(m.id)) return drop();
      const tool = typeof m.name === 'string' ? link.tools.get(m.name) : null;
      if (!tool) return send({ t: 'result', id: m.id, result: failed(`Canopy has no tool named "${String(m.name).slice(0, 80)}" in this chat.`) });
      const stop = new AbortController();
      calls.set(m.id, stop);
      const meta = isPlain(m.meta) ? m.meta : {};
      Promise.resolve()
        .then(() => link.call(tool, isPlain(m.args) ? m.args : {}, { signal: stop.signal, callId: short(meta.callId), threadId: short(meta.threadId), turnId: short(meta.turnId) }))
        .then((r) => (isPlain(r) && Array.isArray(r.content) ? r : failed(`${tool.name} gave no answer. Try once more.`)),
          (err) => { this.log('warn', 'a relayed tool call failed', { tool: tool.name, error: errText(err) }); return failed(`${tool.name} failed: ${errText(err).slice(0, 300)}. Try once more; if it fails again, carry on without it and tell the user.`); })
        .then((result) => {
          // An answer nobody is waiting for (the call was cancelled, the helper has gone) is not sent.
          if (calls.get(m.id) !== stop) return;
          calls.delete(m.id);
          send({ t: 'result', id: m.id, result });
        });
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      let from = 0;
      for (let at = chunk.indexOf('\n'); at >= 0 && !socket.destroyed; at = chunk.indexOf('\n', from)) {
        parts.push(chunk.slice(from, at));
        const line = parts.join('');
        parts = []; size = 0;
        from = at + 1;
        if (line.trim()) onLine(line);
      }
      if (socket.destroyed || from >= chunk.length) return;
      parts.push(chunk.slice(from));
      size += chunk.length - from;
      if (size > this.limits.maxLine) drop();
    });
    socket.on('error', () => {}); // the close that follows is what counts
    socket.on('close', () => {
      clearTimeout(hello);
      this.sockets.delete(socket);
      link?.sockets.delete(socket);
      for (const stop of calls.values()) stop.abort();
      calls.clear();
    });
  }

  /** Stop listening for good: every link is closed, and the socket and its folder are removed. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    process.removeListener('exit', this.onExit);
    for (const link of [...this.links]) link.close();
    for (const s of [...this.sockets]) s.destroy();
    try { await this.listening; } catch { /* it never opened */ }
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    this.unlink();
  }
}

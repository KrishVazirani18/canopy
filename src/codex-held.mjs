// Codex chats that are open in another app right now.
//
// Codex (0.169 on) lets one process write a chat at a time. A chat that is open somewhere has a lock file,
// <Codex's folder>/thread-writer-locks/<chat id>.lock, kept open by the process that has the chat. The file can
// stay behind after the chat is closed, so the file alone says nothing: what counts is a process that has it open.
// `lsof` says which processes those are, and `ps` says whose they are: the holder's parents are followed up to the
// first app you can see (…/X.app/Contents/MacOS/…), past the helpers and bridges on the way.
//
//   heldFrom(...)        lsof's and ps's output -> Map(chat id -> { app, pid }), Canopy's own chats left out
//   appOf(...)           one process -> the app it belongs to, in words, or `own` when it is one of Canopy's
//   heldLine, heldText   what the sidebar row and the chat say about a chat that is held
//   CodexHeld            who has what, kept in memory: read again when the lock folder changes, when asked
//                        (the window came to the front, a chat is being opened) and now and then while a chat is held
//
// Contract:
//  - Nothing here throws, and nothing is waited for at startup: `start()` returns at once.
//  - Read only. The lock itself is never asked for (no flock): asking could take it. Nothing is written anywhere.
//  - One `lsof` and one `ps` a read, however many chats; neither when there is no lock file, or no Codex on this Mac.
//  - `lsof` is asked about processes called codex only (a tenth of the cost of asking about every process). When
//    Codex itself refuses a chat nobody was seen to hold, every process is asked about, from then on.
//  - A chat one of Canopy's own Codex processes has open is not "elsewhere".
import { execFile } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import { readdir } from 'node:fs/promises';

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const LOCK_RE = /\/thread-writer-locks\/([^/.][^/]*)\.lock$/;
const SHELL_RE = /^-?(zsh|bash|sh|fish|nu|login|tmux|screen|sshd)\b/;
const TIMINGS = Object.freeze({
  debounce: 150,     // ms: several changes in the lock folder are one read
  tick: 5000,        // ms between looks while a chat is held
  recheckEvery: 6,   // ticks, not ms: a full read every half minute
  tool: 4000,        // ms lsof or ps may take
});

const NOBODY = 'another app';

/** The sidebar row's second line for a chat that is open in `app`. */
export const heldLine = (app) => `Open in ${app || NOBODY}`;
/** What the chat says in place of its message box, and what a turn that ran into it says. */
export const heldText = (app) => `This chat is open in ${app || NOBODY}. Close it there to continue here.`;

/** `lsof -F pn` -> Map(chat id -> pid[]): every process that has a chat's lock file open. */
export function parseLsof(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line[0] === 'p') { const n = Number(line.slice(1)); pid = Number.isInteger(n) && n > 0 ? n : null; }
    else if (line[0] === 'n' && pid) {
      const id = LOCK_RE.exec(line)?.[1];
      if (!id) continue;
      const pids = out.get(id) ?? [];
      if (!pids.includes(pid)) pids.push(pid);
      out.set(id, pids);
    }
  }
  return out;
}

/** `ps -axo pid=,ppid=,comm=` -> Map(pid -> { ppid, comm }). A command's path may have spaces in it. */
export function parsePs(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  return out;
}

// The app a program is the visible part of: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" -> "ChatGPT".
// Null for anything deeper inside a bundle (a helper app, a bridge or a tool in its Resources) and outside one.
function visibleApp(comm) {
  const at = comm.indexOf('.app/');
  if (at < 0 || !/^Contents\/MacOS\/[^/]+$/.test(comm.slice(at + 5))) return null;
  return comm.slice(comm.lastIndexOf('/', at) + 1, at) || null;
}

// An app's name as the window says it: "Open in the Codex app", "This chat is open in Terminal."
function inWords(bundle) {
  if (/^(chatgpt|codex)\b/i.test(bundle)) return 'the Codex app';
  if (/^canopy\b/i.test(bundle)) return 'another Canopy window';
  return bundle;
}

/**
 * Whose a process is: its parents are followed up to the first app you can see. `own`: it is `ownPid` or was
 * started under it (one of Canopy's own). `app`: that app in words; "a terminal" when a shell is as far as the
 * trail goes, "another app" when nothing says.
 * @param {number} pid
 * @param {Map<number, { ppid: number, comm: string }>} procs
 * @param {{ ownPid?: number }} [opts]
 * @returns {{ own: boolean, app: string | null }}
 */
export function appOf(pid, procs, { ownPid } = {}) {
  let shell = false;
  const seen = new Set();
  for (let p = pid; Number.isInteger(p) && p > 1 && !seen.has(p);) {
    seen.add(p);
    if (p === ownPid) return { own: true, app: null };
    const row = procs.get(p);
    if (!row) break;
    const bundle = visibleApp(row.comm);
    if (bundle) return { own: false, app: inWords(bundle) };
    if (SHELL_RE.test(row.comm.split('/').pop())) shell = true;
    p = row.ppid;
  }
  return { own: false, app: shell ? 'a terminal' : NOBODY };
}

/**
 * The chats another app has open: Map(chat id -> { app, pid }). A lock file no running process has open is not a
 * chat that is held, and neither is one that a process of Canopy's own has.
 * @param {{ lsof: string, ps: string, ownPid?: number }} o
 */
export function heldFrom({ lsof, ps, ownPid } = {}) {
  const out = new Map();
  try {
    const procs = parsePs(ps);
    for (const [id, pids] of parseLsof(lsof)) {
      const whose = pids.filter((pid) => procs.has(pid)).map((pid) => ({ pid, ...appOf(pid, procs, { ownPid }) }));
      if (!whose.length || whose.some((w) => w.own)) continue;
      const one = whose.find((w) => w.app !== NOBODY) ?? whose[0];
      out.set(id, { app: one.app, pid: one.pid });
    }
  } catch { /* nothing is held as far as anyone can tell */ }
  return out;
}

/**
 * Run a tool to its end: what it printed, or null when it could not be run or was stopped for taking too long.
 * Ending with an error code is not that: `lsof` ends with 1 whenever it has nothing to list.
 */
function runTool(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => resolve(err && (err.killed || typeof err.code !== 'number') ? null : String(stdout ?? '')));
    } catch { resolve(null); }
  });
}

export class CodexHeld {
  /**
   * @param {{
   *   dir: string | (() => string | null),      Codex's lock folder (…/.codex/thread-writer-locks)
   *   installed?: () => boolean,                is Codex on this Mac right now? (default: yes)
   *   ownPid?: number,                          Canopy's own process: what it started is not "elsewhere"
   *   onChange?: (held: object) => void,        who has what changed (`all()` is handed over)
   *   log?: (msg: string) => void,
   *   run?, list?, watch?, alive?, platform?, timings?   (tests) the tools, the folder, the clock
   * }} opts
   */
  constructor({ dir, installed, ownPid = process.pid, onChange, log, run, list, watch, alive, platform = process.platform, timings } = {}) {
    this.dirOf = typeof dir === 'function' ? dir : () => dir;
    this.installedFn = typeof installed === 'function' ? installed : () => true;
    this.ownPid = ownPid;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.logFn = typeof log === 'function' ? log : () => {};
    this.run = typeof run === 'function' ? run : runTool;
    this.list = typeof list === 'function' ? list : (d) => readdir(d);
    this.watchFn = typeof watch === 'function' ? watch : fsWatch;
    this.alive = typeof alive === 'function' ? alive : (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; } };
    this.mac = platform === 'darwin';
    this.t = { ...TIMINGS, ...(timings && typeof timings === 'object' ? timings : {}) };
    this.held = new Map();     // chat id -> { app, pid }
    this.readAt = 0;           // when the last read finished
    this.reading = null;       // the read in flight
    this.again = false;        // something changed while it ran: read once more
    this.wide = false;         // ask lsof about every process, not only the ones called codex
    this.watcher = null; this.watched = null;
    this.soon = null; this.ticker = null; this.ticks = 0;
    this.stopped = false;
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a read */ } }
  #dir() { try { const d = this.dirOf(); return typeof d === 'string' && d ? d : null; } catch { return null; } }
  #installed() { try { return this.installedFn() === true; } catch { return false; } }

  /** Who has this chat open elsewhere: { app, pid }, or null. Memory only. */
  by(id) { const h = typeof id === 'string' ? this.held.get(id) : null; return h ? { ...h } : null; }

  /** Every chat that is held, as the window gets it: { [chat id]: { app, line, text } }. */
  all() { return Object.fromEntries([...this.held].map(([id, h]) => [id, { app: h.app, line: heldLine(h.app), text: heldText(h.app) }])); }

  /** Begin: watch the lock folder and read it once, behind whatever the caller does next. Safe to call again. */
  start() {
    if (this.stopped) return this;
    this.refreshSoon(0);
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.soon); clearInterval(this.ticker);
    this.soon = null; this.ticker = null;
    this.#unwatch();
  }

  /** Read again shortly: many changes in a row (a chat opening writes several) are one read. */
  refreshSoon(delayMs = this.t.debounce) {
    if (this.stopped || this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; this.refresh(); }, Math.max(0, delayMs));
    this.soon.unref?.();
  }

  /**
   * Read who has what now. One read runs at a time: a call during one waits for it, and it is run once more when
   * something changed meanwhile. `wide`: ask about every process from now on. Resolves to whether anything changed.
   */
  refresh({ wide = false } = {}) {
    if (wide) this.wide = true;
    if (this.stopped) return Promise.resolve(false);
    if (this.reading) { this.again = true; return this.reading; }
    const run = this.#read().catch((err) => { this.log(`codex held: ${err?.message ?? err}`); return false; }).finally(() => {
      if (this.reading === run) this.reading = null;
      if (this.again) { this.again = false; this.refreshSoon(); }
    });
    this.reading = run;
    return run;
  }

  /**
   * For a chat about to be opened: make sure what is known is at most `maxAgeMs` old, waiting `waitMs` at the most.
   * Never rejects.
   */
  async fresh({ maxAgeMs = 2000, waitMs = 800 } = {}) {
    if (this.readAt && Date.now() - this.readAt < maxAgeMs && !this.reading) return;
    let timer = null;
    await Promise.race([this.refresh(), new Promise((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  async #read() {
    const dir = this.mac && this.#installed() ? this.#dir() : null;
    let next = new Map();
    if (dir) {
      this.#watch(dir);
      const names = await Promise.resolve().then(() => this.list(dir)).catch(() => []);
      if ((Array.isArray(names) ? names : []).some((n) => typeof n === 'string' && n.endsWith('.lock') && !n.startsWith('.'))) {
        const lsof = await this.run(LSOF, ['-F', 'pn', ...(this.wide ? [] : ['-c', 'codex', '-a']), '+D', dir], this.t.tool);
        const ps = typeof lsof === 'string' && parseLsof(lsof).size ? await this.run(PS, ['-axo', 'pid=,ppid=,comm='], this.t.tool) : '';
        if (typeof lsof !== 'string' || typeof ps !== 'string') return false; // a tool did not answer: what was known stands
        if (ps) next = heldFrom({ lsof, ps, ownPid: this.ownPid });
      }
    } else this.#unwatch();
    this.readAt = Date.now();
    const same = next.size === this.held.size && [...next].every(([id, h]) => this.held.get(id)?.app === h.app);
    this.held = next;
    this.#tick();
    if (same || this.stopped) return false;
    this.log(`codex held: ${next.size ? [...next].map(([id, h]) => `${id} in ${h.app}`).join(', ') : 'nothing'}`);
    try { this.onChange(this.all()); } catch { /* an observer never breaks the read */ }
    return true;
  }

  // While a chat is held: a holder that is gone is noticed within seconds (no process is started to look), and
  // everything is read again every half minute, because closing a chat elsewhere need not change the lock folder.
  #tick() {
    if (!this.held.size || this.stopped) { clearInterval(this.ticker); this.ticker = null; this.ticks = 0; return; }
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.ticks += 1;
      const gone = [...this.held.values()].some((h) => !this.alive(h.pid));
      if (gone || this.ticks % this.t.recheckEvery === 0) this.refresh();
    }, this.t.tick);
    this.ticker.unref?.();
  }

  #watch(dir) {
    if (this.watcher && this.watched === dir) return;
    this.#unwatch();
    try {
      const w = this.watchFn(dir, { persistent: false }, () => this.refreshSoon());
      w?.on?.('error', () => { if (this.watcher === w) this.#unwatch(); });
      this.watcher = w ?? null; this.watched = w ? dir : null;
    } catch { /* no such folder yet: looked for again at the next read */ }
  }

  #unwatch() {
    try { this.watcher?.close?.(); } catch { /* already closed */ }
    this.watcher = null; this.watched = null;
  }
}

// Shared plumbing for the core tests: a scrubbed environment, a bounded pool of
// throwaway working folders, a run lock, an event recorder and cleanup.
//
// Nothing here imports another core file statically. Core modules load through
// `core()`, which fails the test file that asked for a module that is missing or
// does not load.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
// CANOPY_TEST_CORE points the tests at another copy of src/core (a scratch
// copy, which may hold only part of it). The copy needs node_modules beside it.
export const CORE = process.env.CANOPY_TEST_CORE ? path.resolve(process.env.CANOPY_TEST_CORE) : path.resolve(HERE, '..');
export const FIXTURES = path.join(HERE, 'fixtures');

export const POOL_SIZE = 8;
export const POOL_PREFIX = '/tmp/canopy-test-';
export const LOCK_DIR = '/tmp/canopy-test.lock';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- core module loading ----

const coreCache = new Map();

// Import a file from src/core. A file that is missing or does not load is an
// error: the test file that asked for it fails, and the run with it, so a broken
// module can never pass as a list of skipped tests. Only against a scratch copy
// (CANOPY_TEST_CORE) does it come back as `{ __missing: reason }`, which the
// tests turn into skips.
const SOFT = !!process.env.CANOPY_TEST_CORE;
export function core(file) {
  if (!coreCache.has(file)) {
    const p = path.join(CORE, file);
    const failed = (reason) => { if (SOFT) return { __missing: reason }; throw new Error(`src/core/${file} did not load: ${reason}`); };
    coreCache.set(file, fs.existsSync(p)
      ? import(pathToFileURL(p).href).catch((err) => failed(String(err?.message ?? err)))
      : Promise.resolve().then(() => failed(`${file} does not exist`)));
  }
  return coreCache.get(file);
}

export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

// ---- a fixture says nothing about the machine it was recorded on ----

// Codex names every MCP server it starts, so a recording carries the recorder's own list. Only Canopy's own servers
// and the one the product matches on (`cua_repl`, Computer Use) keep their names; any other becomes server_1,
// server_2, … in the order first seen, everywhere it appears, so the number of lines and their shape stay as recorded.
export const KNOWN_SERVERS = new Set(['canopy', 'canopy_ui', 'cua_repl']);
const NEUTRAL_SERVER = /^server_\d+$/;
const SERVER_NAMED = [
  /mcp_servers\.([A-Za-z0-9_-]+)\./g,
  /"method":"mcpServer\/startupStatus\/updated","params":\{[^{}]*?"name":"([A-Za-z0-9_-]+)"/g,
];

/** Every MCP server a fixture file names, in the order first seen. */
export function serverNames(body) {
  const found = [];
  for (const re of SERVER_NAMED) for (const m of body.matchAll(re)) if (!found.includes(m[1])) found.push(m[1]);
  return found;
}

/** The text of a fixture file with every MCP server name that is not Canopy's own replaced by a neutral one. */
export function neutralServerNames(body) {
  let out = body;
  const taken = serverNames(body).filter((name) => NEUTRAL_SERVER.test(name)).map((name) => Number(name.slice(7)));
  let next = Math.max(0, ...taken);
  for (const name of serverNames(body)) {
    if (KNOWN_SERVERS.has(name) || NEUTRAL_SERVER.test(name)) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`, 'g'), `server_${++next}`);
  }
  return out;
}

// An id in a recording names something of the recorder's: a chat or a turn on their disk, a reply or a request on
// their account. Each becomes a made-up id of the same shape. The same id always becomes the same made-up one, so
// the files still agree with each other (the chat one scenario starts is the chat another resumes).
const madeUp = (id) => createHash('sha256').update(id).digest('hex').slice(0, 12);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const PREFIXED_ID = /\b(msg|rs|call|req|resp|toolu)_([A-Za-z0-9]{16,})\b/g;

/** The text of a fixture file with every recorded id replaced by a made-up one. Ids that are already made up stay. */
export function neutralIds(body) {
  return body
    .replace(UUID, (id, version) => (id.startsWith('00000000-0000-') ? id : `00000000-0000-${version}000-8000-${madeUp(id)}`))
    .replace(PREFIXED_ID, (id, kind, rest) => (rest.startsWith('00000000') ? id : `${kind}_${'0'.repeat(rest.length - 12)}${madeUp(id)}`));
}

// What Codex says of the recorder's Mac and set-up as it starts: the macOS and terminal versions in its user agent,
// and the plugins whose hooks it runs (named by where they are cached).
const USER_AGENT = /("userAgent":"[^"\s]+) \([^)"]*\) [^"]*? (\([^)"]*\)")/g;
const PLUGIN_CACHE = /(\/plugins\/cache)\/[^/"\s]+\/[^/"\s]+\/[^/"\s]+\//g;

/** The text of a fixture file as it is committed: no server, plugin, id or version that belongs to the recorder. */
export function neutralFixture(body) {
  const out = body
    .replace(USER_AGENT, '$1 (Mac OS 26.0.0; arm64) unknown $2')
    .replace(PLUGIN_CACHE, '$1/example-marketplace/example-plugin/1.0.0/');
  return neutralIds(neutralServerNames(out));
}

// ---- environment ----

// Variables the host agent session (or Electron, or npm) sets for itself. A
// child claude that inherits them believes it is a nested session.
const HOST_VAR = new RegExp('^(?:' + [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_CODE_(?:ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|EXECPATH|SSE_PORT|MESSAGING_.*|EMIT_SESSION_STATE_EVENTS|STARTUP_FAILURE_RESULTS)',
  'ELECTRON_.*', 'NODE_OPTIONS', 'NODE_ENV', 'INIT_CWD', 'npm_.*', 'CANOPY_.*',
  '__CFBundleIdentifier', 'ORIGINAL_XDG_CURRENT_DESKTOP',
].join('|') + ')$');

export const isHostVar = (name) => HOST_VAR.test(name);

export function scrubbedEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!HOST_VAR.test(k) && typeof v === 'string') env[k] = v;
  const parts = (env.PATH || '/usr/bin:/bin').split(':').filter(Boolean);
  for (const p of [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']) if (!parts.includes(p)) parts.push(p);
  env.PATH = parts.join(':');
  return { ...env, ...extra };
}

export function findClaudeBin(env = scrubbedEnv()) {
  const names = [
    process.env.CANOPY_CLAUDE_PATH,
    ...(env.PATH ?? '').split(':').filter((d) => path.isAbsolute(d)).map((d) => path.join(d, 'claude')),
  ].filter(Boolean);
  for (const c of names) {
    try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- processes (only ever our own children, by pid) ----

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

export function signal(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, sig); return true; } catch { return false; }
}

export async function waitPidGone(pid, ms = 8000) {
  const end = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() > end) return false;
    await sleep(25);
  }
  return true;
}

// The command line of one of our own children (used to prove a flag is absent).
export function pidArgs(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return '';
  const r = spawnSync('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// ---- run lock ----

// Two harness runs would empty each other's folders, so the second one refuses.
export function acquireLock() {
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
      return { ok: true };
    } catch (err) {
      if (err?.code !== 'EEXIST') return { ok: false, message: String(err?.message ?? err) };
      let holder = NaN;
      try { holder = Number(fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8')); } catch {}
      if (pidAlive(holder) && holder !== process.pid) return { ok: false, message: `another core test run is in progress (pid ${holder})` };
      fs.rmSync(LOCK_DIR, { recursive: true, force: true }); // stale: its owner is gone
    }
  }
  return { ok: false, message: 'could not take the test lock' };
}

export function releaseLock() {
  try {
    if (Number(fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8')) === process.pid) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {}
}

// ---- working folders ----

// A fixed pool, so the CLI's per-folder bookkeeping in ~/.claude.json stays
// bounded however many times the suite runs.
export class CwdPool {
  constructor(size = POOL_SIZE) {
    this.free = Array.from({ length: size }, (_, i) => `${POOL_PREFIX}${i + 1}`);
    this.waiters = [];
  }
  async acquire() {
    if (!this.free.length) await new Promise((r) => this.waiters.push(r));
    const dir = this.free.shift();
    emptyDir(dir);
    return dir;
  }
  release(dir) {
    this.free.push(dir);
    this.waiters.shift()?.();
  }
}

export function emptyDir(dir) {
  if (!dir.startsWith(POOL_PREFIX)) throw new Error(`refusing to empty ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// ---- cleanup ----

const seenSessionIds = new Set();
const seenPlanFiles = new Set();

export const noteSessionId = (id) => { if (typeof id === 'string' && UUID_RE.test(id)) seenSessionIds.add(id); };

// Plan mode writes its plan under ~/.claude/plans; remember any path we are shown.
export function notePlanFiles(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'planFilePath' && typeof v === 'string') seenPlanFiles.add(v);
    else if (v && typeof v === 'object') notePlanFiles(v, depth + 1);
  }
}

function rmMatching(dir, test) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!test(name)) continue;
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); n++; } catch {}
  }
  return n;
}

const PROJECT_FOLDER = /^-(?:private-)?tmp-canopy-test-/;

// Removes everything a run can leave behind. Safe to call repeatedly, and from
// a signal handler (synchronous).
export function cleanup() {
  const home = os.homedir();
  const removed = { tmp: 0, projects: 0, scratch: 0, fileHistory: 0, plans: 0 };
  removed.tmp = rmMatching('/tmp', (n) => n.startsWith('canopy-test-'));
  removed.projects = rmMatching(path.join(home, '.claude', 'projects'), (n) => PROJECT_FOLDER.test(n));
  let uid = '';
  try { uid = String(os.userInfo().uid); } catch {}
  if (uid) removed.scratch = rmMatching(`/private/tmp/claude-${uid}`, (n) => PROJECT_FOLDER.test(n));
  for (const sid of seenSessionIds) {
    for (const sub of ['file-history', 'session-env', 'todos', 'tasks']) {
      const base = path.join(home, '.claude', sub);
      if (sub === 'todos') removed.fileHistory += rmMatching(base, (n) => n.startsWith(sid));
      else if (fs.existsSync(path.join(base, sid))) { fs.rmSync(path.join(base, sid), { recursive: true, force: true }); removed.fileHistory++; }
    }
  }
  seenSessionIds.clear();
  const plans = path.join(home, '.claude', 'plans') + path.sep;
  for (const f of seenPlanFiles) {
    const abs = path.resolve(f);
    if (!abs.startsWith(plans) && !abs.startsWith('/tmp/canopy-test-') && !abs.startsWith('/private/tmp/canopy-test-')) continue;
    try { fs.rmSync(abs, { force: true }); removed.plans++; } catch {}
  }
  seenPlanFiles.clear();
  return removed;
}

// ---- event recorder ----

export class Skip extends Error {
  constructor(reason) { super(reason); this.name = 'Skip'; }
}
export const skip = (reason) => { throw new Skip(reason); };

const describe = (ev) => {
  const bits = [ev.kind];
  for (const k of ['code', 'state', 'busy', 'subtype', 'status', 'errorStatus', 'key', 'reason', 'name', 'interrupted']) if (ev[k] !== undefined && ev[k] !== null) bits.push(`${k}=${JSON.stringify(ev[k])}`);
  const t = ev.text ?? ev.message;
  if (typeof t === 'string' && t && !/delta/.test(ev.kind)) bits.push(JSON.stringify(t.slice(0, 60)));
  return bits.join(' ');
};

// Records every event a Session emits and lets a test wait for one.
export function watch(session) {
  const events = [];
  const waiters = new Set();
  const onEvent = (ev) => {
    events.push(ev);
    if (ev.kind === 'init' || ev.kind === 'meta' || ev.kind === 'turn-end' || ev.kind === 'stopped') noteSessionId(ev.sessionId);
    if (ev.kind === 'permission' || ev.kind === 'tool-start') {
      notePlanFiles(ev.input);
      if (typeof ev.input?.file_path === 'string' && ev.input.file_path.includes('/.claude/plans/')) seenPlanFiles.add(ev.input.file_path);
    }
    if (ev.kind === 'tool-result') notePlanFiles(ev.structured);
    for (const w of [...waiters]) w(ev);
  };
  session.on('event', onEvent);
  const match = (what) => (typeof what === 'function' ? what : (ev) => ev.kind === what);
  return {
    events,
    mark: () => events.length,
    of: (kind, from = 0) => events.slice(from).filter((e) => e.kind === kind),
    find: (what, from = 0) => events.slice(from).find(match(what)) ?? null,
    all: (what, from = 0) => events.slice(from).filter(match(what)),
    indexOf: (ev) => events.indexOf(ev),
    // Resolves with the first event at or after `from` that matches, now or later.
    waitFor(what, { ms = 90000, from = 0, label } = {}) {
      const test = match(what);
      const hit = events.slice(from).find(test);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          const tail = events.slice(Math.max(from, events.length - 14)).filter((e) => !/delta/.test(e.kind)).map(describe).join(' | ');
          reject(new Error(`timed out after ${ms}ms waiting for ${label ?? (typeof what === 'string' ? what : 'event')}; last events: ${tail || '(none)'}`));
        }, ms);
        const check = (ev) => {
          let ok = false;
          try { ok = test(ev); } catch (err) { clearTimeout(timer); waiters.delete(check); reject(err); return; }
          if (ok) { clearTimeout(timer); waiters.delete(check); resolve(ev); }
        };
        waiters.add(check);
      });
    },
    // Text Claude produced since `from`: final assistant bubbles, else the streamed deltas.
    text(from = 0) {
      const ev = events.slice(from);
      const finals = ev.filter((e) => e.kind === 'assistant-text' && !e.parent).map((e) => e.text).join('\n');
      return finals || ev.filter((e) => e.kind === 'text-delta').map((e) => e.text).join('');
    },
    describe: (from = 0) => events.slice(from).filter((e) => !/delta/.test(e.kind)).map(describe).join('\n'),
    stop: () => session.off?.('event', onEvent),
  };
}

// ---- assertions that read well in a one-line FAIL reason ----

export function check(cond, message) {
  if (!cond) throw new Error(message);
}

export function hasKeys(obj, keys, what = 'object') {
  check(obj && typeof obj === 'object', `${what} is ${obj === null ? 'null' : typeof obj}`);
  const missing = keys.filter((k) => !(k in obj));
  check(!missing.length, `${what} is missing ${missing.join(', ')}`);
}

export async function within(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

// The Codex app-server process, and the calls Canopy makes to Codex outside a chat.
//
//   findCodex(env)        the user's own `codex` (never a copy of ours), or null
//   codexVersion(...)     what `codex --version` says, or null
//   codexEnv(base)        the environment a Codex child gets
//   configArgs(config)    Canopy's settings as `-c key=value` flags: the user's ~/.codex files are never written
//   CODEX_OVERRIDES       the settings Canopy forces on every Codex process it starts (none today)
//   codexModelInfo(m)     one row of Codex's model list, in the shape the model picker already reads
//   readTurns(ask, id)    a chat's turns, page by page, keeping what was read when a later page fails, and saying
//                         where the older ones begin so a later read can carry on from there
//   CodexProcess          one `codex app-server --listen stdio://` child: spawn, handshake, requests, exit
//   CodexService          one shared helper process for what is not a chat: the model list, the account,
//                         the list of past chats, a past chat's turns, renaming, signing in and out
//   ACCOUNT_CALLS         every call about the account that Canopy makes: the only ones a process is ever sent
//   sameFolder(a, b)      are these two paths one folder, however each is spelled?
//   SOURCE_KINDS          every place Codex says a chat can have been started
//
// Contract:
//  - Nothing exported from this file throws. CodexProcess.request() rejects with a coded Error (see codex-rpc.mjs);
//    every CodexService method resolves to { ok: true, ... } or { ok: false, code, message }.
//  - A chat owns its own CodexProcess (see codex-session.mjs), so stopping or losing one chat never touches
//    another. CodexService shares one process between its callers, counts the calls in flight, and lets the
//    process go a minute after the last one. close() resolves only once that process is gone.
//  - History is always read through the app-server (thread/turns/list), never from Codex's files on disk.
//  - The login is Codex's. Canopy asks who is signed in, starts Codex's own browser sign-in, and signs out when the
//    user says so. A call about the account that is not in ACCOUNT_CALLS is refused before it is written, from a
//    chat's process and from the helper alike, and Canopy never hands Codex a key or a token to sign in with.
//  - An API key pasted into Canopy is not a login of Codex's and is never made one. A process started for that
//    account gets what its recipe says (accounts-codex.mjs): the key in its own environment, and a model provider
//    named on its own command line. A process started with nothing chosen gets neither: no extra arguments, and
//    the environment codexEnv() builds.
//  - A second Codex login lives in a folder of its own, and a helper started for it (`home`) is asked nothing until
//    its process has said that this folder is the one it keeps its login in. So a sign-in, a sign-out or a question
//    meant for that login can never land on the login Codex holds itself.
import { execFile, spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RpcPeer, rpcError } from './codex-rpc.mjs';
import { sleep } from './supervisor.mjs';

const soft = async (f) => { try { return await import(f); } catch (err) { return { __missing: String(err?.message ?? err) }; } };
const envMod = await soft('./env.mjs');
const redactMod = await soft('./redact.mjs');

// `historyBudget`: once reading a chat's turns has taken this long, no further page is asked for.
// `login`: how long a sign-in may stay open in the browser before Canopy stops waiting for it. `cancel`: how long
// Codex gets to drop one. `title`: how long a one-off question (suggestTitle) may take.
export const CODEX_TIMEOUTS = Object.freeze({ init: 30000, request: 30000, list: 20000, history: 30000, historyBudget: 10000, linger: 60000, title: 60000, login: 10 * 60000, cancel: 5000 });
const MODELS_FRESH_MS = 5 * 60_000; // the model list is asked of Codex again at most this often

// A one-off question (suggestTitle): a throwaway thread Codex never saves, that can do nothing but answer. Codex's
// own instructions, tools, skills, plugins and MCP servers are left out, and it runs at standard speed whatever the
// user's tier: measured Nov 16 2026 on GPT-6-Luna, about 8,600 tokens a question against 26,700 with Codex's defaults.
const ONE_OFF_INSTRUCTIONS = 'You write short titles for conversations. Reply with only the title.';
const ONE_OFF_CONFIG = Object.freeze({
  mcp_servers: {}, web_search: 'disabled', tools: { web_search: false, view_image: false },
  features: { shell_tool: false, unified_exec: false, apply_patch_freeform: false, view_image_tool: false, web_search_request: false, apps: false, plugins: false, skills: false, multi_agent: false, collab: false, memories: false },
});

const STDERR_KEEP = 8000;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONFIG_WARNING = /ignoring \d+ unrecognized configuration settings?/i;
/**
 * What Codex wrote to its error output, fit to show: without the colour codes it writes for a terminal, and without
 * its warning about settings in the user's config.toml it does not know (that one is said at every start, with the
 * lines under it that name them, and is never why a chat failed).
 */
export function shownStderr(text) {
  const out = [];
  let skipping = false;
  for (const line of String(text ?? '').replace(ANSI, '').split('\n')) {
    if (CONFIG_WARNING.test(line)) { skipping = true; continue; }
    if (skipping && /^\s+\S/.test(line)) continue; // "  user (…/config.toml): `x` is ignored."
    skipping = false;
    out.push(line);
  }
  return out.join('\n');
}
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const errText = (err) => String(err?.message ?? err);
const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
// Addresses without what follows their `?` or `#`. A sign-in page's address carries one-time values that belong in
// the browser and nowhere else, so nothing here that is logged or handed back as a message keeps that part.
const bareUrls = (text) => String(text ?? '').replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1?…');
const str = (v) => (typeof v === 'string' && v ? v : null);

/** Are these two paths one folder, however each is spelled (a link on the way, /var for /private/var)? Never throws. */
export async function sameFolder(a, b) {
  if (!isAbs(a) || !isAbs(b)) return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return (await realpath(a)) === (await realpath(b)); } catch { return false; }
}

/** Which Codex a process is, from what it calls itself when it starts ("canopy/0.169.0 (Mac OS …)"), or null. */
export const versionOf = (userAgent) => String(userAgent ?? '').match(/\/(\d+\.\d+\.\d+[^\s(]*)/)?.[1] ?? null;

// ---------- the account ----------

// Every call about the account that Canopy makes. Codex's app-server has more of them: calls that spend a user's
// credits, send mail in their name, or sign Codex in with a key or a token the client supplies. This is a list of
// what is allowed, not of what is forbidden, so a call Codex adds later is refused until it is put here.
export const ACCOUNT_CALLS = Object.freeze(['account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read']);
const SIGN_IN_ONLY = 'Canopy only starts Codex’s own browser sign-in.';
const aboutAccount = (method) => typeof method === 'string' && method.trim().toLowerCase().startsWith('account/');

/**
 * Why a call may not be made, or null when it may. Only calls about the account are judged.
 * A sign-in is Codex's own browser sign-in and nothing else: `account/login/start` goes out as exactly
 * `{ type: 'chatgpt' }`, so Codex runs the sign-in and keeps the login itself.
 */
export function accountCallRefusal(method, params) {
  if (!aboutAccount(method)) return null;
  if (!ACCOUNT_CALLS.includes(method)) return `Canopy does not ask Codex for ${method.trim().slice(0, 80)}.`;
  if (method === 'account/login/start' && !(isPlain(params) && params.type === 'chatgpt' && Object.keys(params).length === 1)) return SIGN_IN_ONLY;
  return null;
}

// ---------- environment ----------

// Variables that describe a Codex session Canopy itself was launched from (a terminal inside Codex). A child that
// inherits them believes it is nested or sandboxed. The user's login (CODEX_HOME, OPENAI_API_KEY, CODEX_API_KEY)
// is theirs and is never touched.
const CODEX_SESSION_VARS = new Set([
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_PERMISSION_PROFILE',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_NON_INTERACTIVE', 'CODEX_MANAGED_PACKAGE_ROOT',
]);
// The same host variables the Claude path drops, for when env.mjs did not load.
const HOST_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|EXECPATH|SSE_PORT|MESSAGING_.*)|NODE_OPTIONS|ELECTRON_.*|npm_.*)$/;

/** The environment for a Codex child: the user's, without what the host app or a parent agent session put there. */
export function codexEnv(base) {
  const src = isPlain(base) ? base : process.env;
  let env = null;
  try { env = envMod.scrubEnv?.(src) ?? null; } catch { env = null; }
  if (!isPlain(env)) {
    env = {};
    for (const [k, v] of Object.entries(src)) if (typeof v === 'string' && k && !HOST_VARS.test(k)) env[k] = v;
  }
  for (const k of Object.keys(env)) if (CODEX_SESSION_VARS.has(k)) delete env[k];
  if (!env.HOME) env.HOME = os.homedir();
  return env;
}

// ---------- flags ----------

// The `-c` settings every Codex process Canopy starts gets, a chat's and the shared helper's alike.
//
// The rule: a Canopy chat is the user's own Codex in a window, and their config is theirs. Canopy overrides a user's
// Codex setting only when a recording or a smoke run shows a Canopy chat breaking because of it; each override is one
// line here with its reason. Nothing qualifies today, so this is empty and the app passes no `-c` flags at all.
// That includes `notify`: the user's notify program runs at the end of every turn of a Canopy chat, as it does in the
// terminal and in Codex.app. (Tests and the smoke script do switch it off, so a test turn never pokes the user's Mac.)
// One kind of process does get flags, and they are its account's, not an override of this kind: a process started
// for an API key pasted into Canopy names its model provider there (accounts-codex.mjs `launchConfig`).
export const CODEX_OVERRIDES = Object.freeze({});

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

// One value as TOML, which is what `-c key=value` parses. Strings are written as JSON strings (a TOML basic
// string reads the same escapes; DEL is the one character JSON leaves bare that TOML does not allow bare).
// Undefined, functions and other things TOML cannot hold give null.
function toml(v, depth = 0) {
  if (depth > 8) return null;
  if (typeof v === 'string') return JSON.stringify(v).replace(/\x7f/g, '\\u007f');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (Array.isArray(v)) {
    const parts = v.map((x) => toml(x, depth + 1));
    return parts.includes(null) ? null : `[${parts.join(', ')}]`;
  }
  if (isPlain(v)) {
    const parts = [];
    for (const [k, x] of Object.entries(v)) {
      const t = toml(x, depth + 1);
      if (t === null) return null;
      parts.push(`${BARE_KEY.test(k) ? k : JSON.stringify(k)} = ${t}`);
    }
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  return null;
}

/** { 'dotted.key': value } → ['-c', 'dotted.key=<toml>', …]. Keys that are not plain dotted names are left out. */
export function configArgs(config) {
  const out = [];
  if (!isPlain(config)) return out;
  for (const [key, value] of Object.entries(config)) {
    // A plain dotted name that does not start with a dash, so it can never be read as a flag of its own.
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/.test(key)) continue;
    const t = toml(value);
    if (t !== null) out.push('-c', `${key}=${t}`);
  }
  return out;
}

// ---------- models ----------

// Codex's name for the tier Canopy's Fast switch turns on.
export const FAST_TIER = 'priority';

/**
 * One row of `model/list` as the model picker reads Claude's rows (value, displayName, description,
 * supportsEffort, supportedEffortLevels, supportsFastMode), plus what only Codex says: the model's own default
 * effort, a line about each effort, and `maker: 'openai'` for the picker's heading.
 */
export function codexModelInfo(m) {
  if (!isPlain(m)) return null;
  const value = typeof m.model === 'string' && m.model ? m.model : typeof m.id === 'string' ? m.id : null;
  if (!value) return null;
  const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
    .map((e) => ({ value: typeof e === 'string' ? e : e?.reasoningEffort, description: typeof e?.description === 'string' ? e.description : '' }))
    .filter((e) => typeof e.value === 'string' && e.value);
  const tiers = (Array.isArray(m.serviceTiers) ? m.serviceTiers : []).map((t) => t?.id).filter((t) => typeof t === 'string');
  return {
    value, displayName: typeof m.displayName === 'string' && m.displayName ? m.displayName : value,
    description: typeof m.description === 'string' ? m.description : '',
    supportsEffort: efforts.length > 0, supportedEffortLevels: efforts.map((e) => e.value), efforts,
    defaultEffort: typeof m.defaultReasoningEffort === 'string' && m.defaultReasoningEffort ? m.defaultReasoningEffort : null,
    supportsFastMode: tiers.includes(FAST_TIER), serviceTiers: tiers,
    isDefault: m.isDefault === true, hidden: m.hidden === true, maker: 'openai', engine: 'codex',
  };
}

/** Every page of `model/list`, as picker rows. `ask` is (method, params) => Promise<result>. */
export async function listModels(ask, { includeHidden = false } = {}) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const r = await ask('model/list', { ...(cursor && { cursor }), ...(includeHidden && { includeHidden: true }) });
    for (const m of Array.isArray(r?.data) ? r.data : []) { const row = codexModelInfo(m); if (row) rows.push(row); }
    cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
    if (!cursor) break;
  }
  return rows;
}

// ---------- a chat's turns ----------

/**
 * A chat's turns with every item, oldest first: { turns, truncated, cursor }. `ask` is (method, params, { timeoutMs }) =>
 * Promise<result>. Codex hands them out newest first, a page at a time, and a page of a long chat can be tens of
 * megabytes and take seconds. So:
 *  - what was read is kept: when a later page fails, the newer turns are returned with `truncated: true`;
 *  - a page too large to read (see codex-rpc.mjs) is asked for again in smaller pages;
 *  - once `budgetMs` has passed no further page is asked for, so opening a chat never waits on its whole past.
 * `cursor` (an option) carries on from where an earlier read stopped: the turns returned are the ones just older
 * than that read's. `cursor` (in the answer) is where the turns older than these begin, or null when these reach
 * the chat's first turn; `truncated` is the same fact as a yes or no.
 * Rejects only when not even the first page asked for could be read (a cursor Codex does not know is one such).
 */
export async function readTurns(ask, threadId, { maxTurns = 400, pageSize = 50, cursor: from = null, timeoutMs = CODEX_TIMEOUTS.history, budgetMs = CODEX_TIMEOUTS.historyBudget } = {}) {
  const newestFirst = [];
  const startedAt = Date.now();
  let cursor = typeof from === 'string' && from ? from : null;
  let size = Math.max(1, pageSize);
  while (newestFirst.length < maxTurns) {
    if (newestFirst.length && Date.now() - startedAt > budgetMs) break;
    let r;
    try {
      r = await ask('thread/turns/list', {
        threadId: String(threadId), itemsView: 'full', sortDirection: 'desc', limit: Math.min(size, maxTurns - newestFirst.length), ...(cursor && { cursor }),
      }, { timeoutMs });
    } catch (err) {
      if (err?.code === 'too-large' && size > 1) { size = Math.max(1, Math.floor(size / 4)); continue; }
      if (!newestFirst.length) throw err;
      break;
    }
    const page = Array.isArray(r?.data) ? r.data : [];
    newestFirst.push(...page);
    cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
    if (!cursor || !page.length) break;
  }
  // Every way out of the loop but reaching the first turn leaves `cursor` at the oldest turn read: where to carry on.
  return { turns: newestFirst.reverse(), truncated: !!cursor, cursor };
}

// ---------- finding codex ----------

async function vetExecutable(p) {
  try {
    if (!isAbs(p)) return null;
    const real = await realpath(p);
    const st = await stat(real);
    if (!st.isFile() || (st.mode & 0o002)) return null;
    await access(p, FS.X_OK);
    return real;
  } catch { return null; }
}

async function worldWritable(p) { try { return ((await stat(p)).mode & 0o002) !== 0; } catch { return false; } }

/**
 * Path of the user's `codex`, or null when Codex is not installed: an explicit override (CANOPY_CODEX_PATH), then
 * PATH (absolute entries only, as the terminal would resolve it), then the usual install locations.
 */
export async function findCodex(env) {
  try {
    const e = isPlain(env) ? env : process.env;
    const tried = new Set();
    const attempt = async (p) => { if (tried.has(p)) return null; tried.add(p); return (await vetExecutable(p)) ? p : null; };
    if (isAbs(e.CANOPY_CODEX_PATH)) { const hit = await attempt(e.CANOPY_CODEX_PATH); if (hit) return hit; }
    for (const dir of String(e.PATH ?? '').split(path.delimiter)) {
      if (!isAbs(dir) || (await worldWritable(dir))) continue;
      const hit = await attempt(path.join(dir, 'codex'));
      if (hit) return hit;
    }
    const home = isAbs(e.HOME) ? e.HOME : os.homedir();
    for (const p of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local/bin/codex'), path.join(home, '.npm-global/bin/codex')]) {
      const hit = await attempt(p);
      if (hit) return hit;
    }
  } catch { /* not found */ }
  return null;
}

/** "codex-cli 0.153.4" → "0.153.4", or null when it cannot be asked. */
export function codexVersion(codexPath, env, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!isAbs(codexPath)) return resolve(null);
    try {
      const child = execFile(codexPath, ['--version'], { env: codexEnv(env), cwd: os.homedir(), timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout) => {
        const line = err ? '' : String(stdout ?? '').trim().split('\n')[0];
        resolve(line.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? (line.slice(0, 120) || null));
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    } catch { resolve(null); }
  });
}

// ---------- one app-server process ----------

export class CodexProcess {
  /**
   * @param {{
   *   codexPath: string, env?: object, cwd?: string,
   *   config?: object,              extra settings for this process, sent as -c flags (see configArgs)
   *   flags?: string[],             extra command-line flags, after the -c ones
   *   appVersion?: string,
   *   spawnFn?: typeof spawn,       the test seam
   *   initTimeoutMs?: number, requestTimeoutMs?: number,
   *   onNotification?: (method: string, params: any, msg: object) => void,
   *   onRequest?: (id: string | number, method: string, params: any) => void,
   *   onGarbage?: (text: string, why: string) => void,
   * }} opts
   */
  constructor({ codexPath, env, cwd, config, flags, appVersion = '0.0.1', spawnFn = spawn, initTimeoutMs = CODEX_TIMEOUTS.init, requestTimeoutMs = CODEX_TIMEOUTS.request, onNotification, onRequest, onGarbage } = {}) {
    this.codexPath = codexPath;
    this.env = env;
    this.cwd = cwd;
    this.args = ['app-server', '--listen', 'stdio://', ...configArgs(config), ...(Array.isArray(flags) ? flags.filter((f) => typeof f === 'string') : [])];
    this.appVersion = String(appVersion);
    this.spawnFn = spawnFn;
    this.initTimeoutMs = initTimeoutMs;
    this.child = null;
    this.pid = null;
    this.exit = null;      // { code, signal, failed?, error? } once the process is gone
    this.stderr = '';
    this.info = null;      // what initialize answered: userAgent, codexHome, platformOs
    this.startedAt = 0;
    this.rpc = new RpcPeer({
      write: (line) => this.write(line),
      onNotification, onRequest, onGarbage, timeoutMs: requestTimeoutMs,
    });
    this.gone = null;
    this.exited = new Promise((resolve) => { this.gone = resolve; });
    this.ready = null;
  }

  get alive() { return !!this.child && !this.exit; }

  /** Spawn and shake hands. Never throws: a failed spawn is an exit with `failed`, and `ready` rejects. */
  start() {
    if (this.child || this.exit) return this;
    this.startedAt = Date.now();
    let child;
    try {
      child = this.spawnFn(this.codexPath, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.finish({ code: null, signal: null, failed: true, error });
      this.ready = Promise.reject(rpcError('spawn', `Codex could not be launched: ${errText(error)}`, { cause: error }));
      this.ready.catch(() => {});
      return this;
    }
    this.child = child;
    this.pid = child.pid ?? null;
    child.once('exit', (code, signal) => this.finish({ code, signal }));
    // Only a failed spawn counts as gone here: other errors on a living child are followed by its exit.
    child.on('error', (error) => { if (child.pid == null) this.finish({ code: null, signal: null, failed: true, error }); });
    child.stdout?.on('data', (d) => this.rpc.feed(d));
    child.stdout?.on('error', () => {});
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => { this.stderr = (this.stderr + d).slice(-STDERR_KEEP); }); // must drain, or a chatty child blocks
    child.stderr?.on('error', () => {});
    child.stdin?.on('error', () => {}); // EPIPE after a crash is reported through the exit
    this.ready = this.handshake();
    this.ready.catch(() => {});
    return this;
  }

  async handshake() {
    const info = await this.rpc.request('initialize', {
      clientInfo: { name: 'canopy', title: 'Canopy', version: this.appVersion },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: this.initTimeoutMs });
    if (!this.rpc.notify('initialized')) throw rpcError('closed', 'Codex stopped while starting.');
    this.info = isPlain(info) ? info : {};
    return this.info;
  }

  write(line) {
    const stdin = this.child?.stdin;
    if (!stdin || this.exit || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(line); // a full pipe buffers; a broken one raises 'error' and the exit follows
    return true;
  }

  finish(exit) {
    if (this.exit) return;
    this.exit = exit;
    this.rpc.close(exit.failed ? 'Codex could not be launched.' : 'Codex stopped.');
    this.gone(exit);
  }

  /**
   * Ask the app-server for something once it has started. Rejects with a coded Error; never hangs.
   * A call about the account that Canopy does not make (see ACCOUNT_CALLS) is refused here, before it is written.
   */
  async request(method, params, opts) {
    const refused = accountCallRefusal(method, params);
    if (refused) throw rpcError('not-allowed', refused, { method });
    if (!this.ready) throw rpcError('closed', 'Codex is not running.', { method });
    try { await this.ready; }
    catch (err) {
      if (this.exit?.failed) throw rpcError('spawn', `Codex could not be launched: ${errText(this.exit.error ?? err)}`, { method, cause: this.exit.error ?? null });
      throw err;
    }
    return this.rpc.request(method, params, opts);
  }

  // Canopy tells Codex nothing about the account in a line of its own: what it asks goes through request().
  notify(method, params) { return aboutAccount(method) ? false : this.rpc.notify(method, params); }
  respond(id, result) { return this.rpc.respond(id, result); }
  respondError(id, code, message) { return this.rpc.respondError(id, code, message); }

  kill(signal = 'SIGKILL') {
    if (!this.child || this.exit) return;
    try { this.child.kill(signal); } catch { /* already gone */ }
  }

  /**
   * Make sure the process is gone: close its input (the app-server exits on end of input), then SIGTERM, then
   * SIGKILL. Resolves to whether it exited. `graceMs` 0 goes straight to SIGKILL.
   */
  async shutdown(graceMs = 3000) {
    if (!this.child || this.exit) return true;
    const left = (ms) => Promise.race([this.exited.then(() => true), sleep(ms).then(() => false)]);
    if (graceMs > 0) {
      try { this.child.stdin?.end(); } catch { /* closed */ }
      if (await left(graceMs)) return true;
      this.kill('SIGTERM');
      if (await left(Math.min(500, graceMs))) return true;
    }
    this.kill('SIGKILL');
    return left(2000);
  }
}

// ---------- calls outside a chat ----------

// Calls CodexService makes only through a method of their own, never through the generic `call`.
const OWN_METHOD = new Set(['account/login/start', 'account/login/cancel', 'account/logout']);
const RPC_CODES = { timeout: 'timeout', closed: 'not-running', spawn: 'launch-failed', 'not-allowed': 'not-allowed', busy: 'busy', cancelled: 'cancelled', 'wrong-home': 'wrong-home' };
/** Every place Codex says a chat can have been started (its ThreadSourceKind, 0.169.0): asked for together when no chat may be missed. */
export const SOURCE_KINDS = Object.freeze(['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']);
const FILED_PAGES = 200; // how far `filedUnder` reads: 20,000 chats of each kind, saved and archived

function failure(err, redact) {
  // The account this process was to be started for cannot be launched (accounts.mjs `refuse`): said in its own words.
  if (isPlain(err?.canopy) && typeof err.canopy.code === 'string') return { ok: false, code: err.canopy.code, message: String(err.canopy.message ?? errText(err)) };
  const text = errText(err);
  const message = bareUrls(typeof redact === 'function' ? redact(text) : text);
  if (err?.code === 'rpc' && /no rollout found|thread not loaded|not found/i.test(text)) return { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' };
  return { ok: false, code: RPC_CODES[err?.code] ?? (err?.code === 'rpc' ? 'rejected' : 'internal'), message };
}

function threadRow(t) {
  if (!isPlain(t) || typeof t.id !== 'string') return null;
  const ms = (s) => (typeof s === 'number' && s > 0 ? (s < 1e12 ? s * 1000 : s) : null);
  return {
    id: t.id, cwd: typeof t.cwd === 'string' ? t.cwd : null,
    title: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : null,
    preview: typeof t.preview === 'string' ? t.preview : '',
    createdAt: ms(t.createdAt), updatedAt: ms(t.updatedAt ?? t.recencyAt),
    model: typeof t.model === 'string' ? t.model : null, effort: typeof t.reasoningEffort === 'string' ? t.reasoningEffort : null,
    // Where the chat was started: 'cli', 'vscode' (the Codex app and every app-server client), 'exec', 'appServer'.
    // A sub-agent's thread and a custom source arrive as an object: the row carries its one key ('subAgent', 'custom').
    source: typeof t.source === 'string' ? t.source : isPlain(t.source) ? Object.keys(t.source)[0] ?? null : null, parentId: t.parentThreadId ?? null,
    branch: t.gitInfo?.branch ?? null, engine: 'codex',
  };
}

export class CodexService {
  /**
   * @param {{ codexPath: string | (() => string | null), env?: object | (() => object), config?: object,
   *   launch?: (base: object) => ({ env: object, config?: object } | null),
   *   appVersion?: string, spawnFn?: typeof spawn, lingerMs?: number, timeouts?: Partial<typeof CODEX_TIMEOUTS>,
   *   redact?: (text: string) => string, log?: (level: string, msg: string, data?: object) => void }} opts
   *   `codexPath` and `env` may be getters, read at each start: Codex can be installed while Canopy runs.
   *   `launch`: for a helper that runs on an account (accounts.mjs `launchFor`): given the environment a Codex process
   *   would get anyway, it hands back the one this helper's process gets, and its settings. Read at each start. When
   *   it throws (the account cannot be launched), no process is started and the call fails with its reason. Without
   *   it the helper is Codex as it finds itself.
   *   `home`: for a helper that runs on a login kept in a folder of its own: that folder (or a getter for it). Its
   *   process must say, when it starts, that this is the folder it keeps its login in. Until it has, and whenever
   *   it says another, nothing is asked of it: the call fails with `wrong-home` and the process goes.
   *   `before`: awaited ahead of every call, before any process is started for it (what `launch` needs may have to
   *   be found out first). When it rejects, the call fails with its reason.
   */
  constructor({ codexPath, env, config, launch, home, before, appVersion = '0.0.1', spawnFn = spawn, lingerMs, timeouts, redact, log } = {}) {
    this.codexPath = codexPath;
    this.env = env;
    this.config = config;
    this.launch = typeof launch === 'function' ? launch : null;
    this.home = home ?? null;
    this.before = typeof before === 'function' ? before : null;
    this.placed = new WeakSet(); // the processes that have said they are in `home`
    this.appVersion = appVersion;
    this.spawnFn = spawnFn;
    this.t = { ...CODEX_TIMEOUTS, ...(isPlain(timeouts) ? timeouts : {}) };
    this.lingerMs = Number.isFinite(lingerMs) ? lingerMs : this.t.linger;
    this.redact = typeof redact === 'function' ? redact : null;
    this.logFn = typeof log === 'function' ? log : null;
    this.proc = null;
    this.active = 0;
    this.timer = null;
    this.closed = false;
    this.closing = new Set();   // processes on their way out
    this.scrub = null;          // cuts what the helper's process was started with (a pasted key) out of text: see clean()
    this.modelCache = null;     // { at, hidden, models }
    this.watchers = new Set();  // told when Codex's login changes (see watchAccount)
    this.signIn = null;         // the sign-in in flight: { proc, loginId, timer, why, early, cancelAsked }
    this.oneOffs = new Map();   // threadId -> { text, done }: one-off questions waiting for their answer (suggestTitle)
  }

  log(level, msg, data) { try { this.logFn?.(level, msg, data); } catch { /* logging never breaks a call */ } }

  // What Codex wrote or said, fit to log or to hand back: without any secret its process was started with (a pasted
  // key rides in its environment), without what the host's redactor knows by shape, and without an address's tail.
  clean(text) {
    let t = String(text ?? '');
    try { if (this.scrub) t = this.scrub(t); if (this.redact) t = this.redact(t); } catch { /* what there is is still cut below */ }
    return bareUrls(t);
  }

  resolve(v) { try { return typeof v === 'function' ? v() : v; } catch { return null; } }

  acquire() {
    if (this.closed) throw rpcError('closed', 'Codex is shutting down.');
    clearTimeout(this.timer); this.timer = null;
    if (!this.proc || this.proc.exit) {
      const codexPath = this.resolve(this.codexPath);
      if (!isAbs(codexPath)) throw rpcError('not-installed', 'Codex was not found. Install it, or check that `codex` is on your PATH.');
      const base = codexEnv(this.resolve(this.env));
      const own = this.launch ? this.launch(base) : null; // throws when its account cannot be launched: nothing is started
      const env = isPlain(own?.env) ? own.env : base;
      try { this.scrub = redactMod.makeRedactor?.(env) ?? null; } catch { this.scrub = null; }
      const proc = new CodexProcess({
        codexPath, env, cwd: os.homedir(),
        config: { ...CODEX_OVERRIDES, ...(isPlain(this.config) ? this.config : {}), ...(isPlain(own?.config) ? own.config : {}) }, appVersion: this.appVersion,
        spawnFn: this.spawnFn, initTimeoutMs: this.t.init, requestTimeoutMs: this.t.request,
        // This process opens no chat, so nothing should ask it anything. An unanswered request would hang its sender.
        onRequest: (id, method) => { proc.respondError(id, -32601, `Canopy does not answer ${method} here.`); },
        // Two things it writes unasked mean something here: a word about the login (onNote), and a one-off question's
        // thread saying its answer, then the end of its turn (oneOffHeard).
        onNotification: (method, params) => { this.onNote(proc, method, params); this.oneOffHeard(method, params); },
      });
      this.proc = proc.start();
    }
    this.active += 1;
    return this.proc;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.active || this.closed || !this.proc) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; if (!this.active) this.retire(); }, this.lingerMs);
    this.timer.unref?.();
  }

  retire(graceMs = 2000) {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return Promise.resolve(true);
    const done = proc.shutdown(graceMs).catch(() => false).finally(() => this.closing.delete(done));
    this.closing.add(done);
    return done;
  }

  /**
   * What this helper is launched with changed (another account, another key): its process goes now, what was read
   * through it is forgotten, and the next call starts a new one. A call in flight is asked again on the new one.
   * Resolves once the old process is gone.
   */
  reset() {
    this.modelCache = null;
    clearTimeout(this.timer); this.timer = null;
    return this.retire();
  }

  // A helper for a login kept in a folder of its own (`home`): is this process in that folder? Codex says which
  // folder it keeps its login in when it starts, and that is what is gone by, not what it was launched with. A
  // process anywhere else is let go unasked: what was meant for one login must never reach another.
  async inPlace(proc) {
    if (this.placed.has(proc)) return;
    let info;
    try { info = await proc.ready; } catch { return; } // it did not start: the call itself says why
    if (await sameFolder(info?.codexHome, this.resolve(this.home))) { this.placed.add(proc); return; }
    this.log('warn', 'codex helper did not start in its account folder');
    if (proc === this.proc) this.retire(0); else proc.kill();
    throw rpcError('wrong-home', 'Codex did not start in this account’s folder, so nothing was asked of it.');
  }

  // One request. A process that died under it (not one that answered no) is replaced once: every call here only reads,
  // or is safe to repeat.
  async ask(method, params, { timeoutMs } = {}) {
    const refused = accountCallRefusal(method, params); // refused here too, so no process is started for a call that will never be sent
    if (refused) throw rpcError('not-allowed', refused, { method });
    if (this.before) await this.before();
    for (let attempt = 0; ; attempt++) {
      const proc = this.acquire();
      try {
        if (this.home) await this.inPlace(proc);
        return await proc.request(method, params, { timeoutMs });
      }
      catch (err) {
        if (err?.code === 'timeout' && proc === this.proc && !proc.info) this.retire(0); // it never even started: do not keep it
        if (attempt === 0 && err?.code === 'closed' && !this.closed) { if (proc === this.proc) this.proc = null; continue; }
        if (err?.code !== 'rpc') this.log('warn', 'codex call failed', { method, code: err?.code ?? null, stderr: this.clean(proc.stderr.slice(-400)) });
        throw err;
      } finally { this.release(); }
    }
  }

  async run(fn) {
    try { return { ok: true, ...(await fn()) }; }
    catch (err) {
      if (err?.code === 'not-installed') return { ok: false, code: 'not-installed', message: err.message };
      return failure(err, (text) => this.clean(text));
    }
  }

  /**
   * Any other app-server call: { ok: true, result }. For callers that know the protocol.
   * Signing in and out are not among them: those have their own methods below, which hold what they start.
   */
  call(method, params, opts) {
    return this.run(async () => {
      if (OWN_METHOD.has(method)) throw rpcError('not-allowed', 'Signing in and out of Codex go through login, cancelLogin and logout.', { method });
      return { result: await this.ask(method, params ?? {}, opts) };
    });
  }

  /** The models Codex offers, as picker rows (see codexModelInfo). Cached for five minutes; `fresh` asks again. */
  models({ fresh = false, includeHidden = false } = {}) {
    const c = this.modelCache;
    if (!fresh && c && c.hidden === includeHidden && Date.now() - c.at < MODELS_FRESH_MS) return Promise.resolve({ ok: true, models: c.models.map((m) => ({ ...m })) });
    return this.run(async () => {
      const models = await listModels((method, params) => this.ask(method, params), { includeHidden });
      this.modelCache = { at: Date.now(), hidden: includeHidden, models };
      return { models: models.map((m) => ({ ...m })) };
    });
  }

  /**
   * Who Codex is signed in as: { account: { type, email, plan } | null, signedIn }. A plan in a ChatGPT workspace
   * also says which, when Codex does: `workspace` (its name) and `workspaceId`.
   */
  account() {
    return this.run(async () => {
      const r = await this.ask('account/read', { refreshToken: false });
      const a = isPlain(r?.account) ? r.account : null;
      const workspace = str(a?.workspaceName), workspaceId = str(r?.workspaceRouting?.chatgptAccountId);
      return {
        account: a ? { type: a.type ?? null, email: a.email ?? null, plan: a.planType ?? null, ...(workspace && { workspace }), ...(workspaceId && { workspaceId }) } : null,
        signedIn: !!a, requiresAuth: r?.requiresOpenaiAuth === true,
      };
    });
  }

  /**
   * Where this helper's Codex keeps its folder, and which Codex it is, as its process said when it started:
   * { ok: true, codexHome, version }. Starting it is all that is asked of it.
   */
  info() {
    return this.run(async () => {
      if (this.before) await this.before();
      for (let attempt = 0; ; attempt++) {
        const proc = this.acquire();
        try {
          const said = await proc.ready;
          if (this.home) await this.inPlace(proc);
          return { codexHome: isAbs(said?.codexHome) ? said.codexHome : null, version: versionOf(said?.userAgent) };
        } catch (err) {
          if (err?.code === 'timeout' && proc === this.proc && !proc.info) this.retire(0); // it never even started: do not keep it
          if (attempt === 0 && err?.code === 'closed' && !this.closed && !proc.exit?.failed) { if (proc === this.proc) this.proc = null; continue; }
          if (proc.exit?.failed) throw rpcError('spawn', `Codex could not be launched: ${errText(proc.exit.error ?? err)}`, { cause: proc.exit.error ?? null });
          throw err;
        } finally { this.release(); }
      }
    });
  }

  /**
   * How much of the plan's limits is used: { limits }, Codex's answer whole (usage.mjs reads it). Only a ChatGPT
   * plan has limits to read: for any other login Codex says no, which comes back as { ok: false, code: 'rejected' }.
   * Asking only reads, and uses nothing up.
   */
  rateLimits() {
    return this.run(async () => ({ limits: await this.ask('account/rateLimits/read', undefined, { timeoutMs: this.t.list }) }));
  }

  /**
   * Hear about Codex's login as the helper's process reports it. `fn` gets
   *   { type: 'login', loginId, success, error, cancelled?, timedOut?, stopped? }   a sign-in started here has ended
   *   { type: 'updated', authMode }   Codex says how it is signed in now (`authMode` null: it is not)
   * `success` is Codex's word and nothing more: ask `account()` before believing it. The end of a sign-in is told on
   * the next turn of the event loop, so whoever called `login()` always has its answer first.
   * Returns the function that stops listening.
   */
  watchAccount(fn) {
    if (typeof fn !== 'function') return () => {};
    this.watchers.add(fn);
    return () => { this.watchers.delete(fn); };
  }

  tell(event) {
    for (const fn of [...this.watchers]) { try { fn(event); } catch { /* a listener never breaks the helper */ } }
  }

  // A line the helper's process wrote without being asked. Only the two about the login mean anything here.
  onNote(proc, method, params) {
    const p = isPlain(params) ? params : {};
    if (method === 'account/login/completed') {
      const entry = this.signIn;
      if (!entry || entry.proc !== proc) return;
      const result = { loginId: typeof p.loginId === 'string' ? p.loginId : null, success: p.success === true, error: typeof p.error === 'string' && p.error ? bareUrls(p.error) : null };
      // Its start has not been answered yet, so which sign-in this is about is not known: kept until it is.
      if (entry.loginId === null) entry.early.push(result);
      else if (result.loginId === entry.loginId) this.endLogin(entry, result);
    } else if (method === 'account/updated') {
      this.modelCache = null; // another login can be offered other models
      this.tell({ type: 'updated', authMode: typeof p.authMode === 'string' && p.authMode ? p.authMode : null });
    }
  }

  /**
   * Start Codex's own browser sign-in: { ok: true, loginId, authUrl }. The caller opens `authUrl` in the user's
   * browser; Codex runs the rest and keeps the login. No other kind of sign-in can be started (see ACCOUNT_CALLS).
   * `authUrl` is for the browser only: it is never logged here, and a caller must not log or show it either.
   *
   * One sign-in at a time. The page in the browser answers to the helper's process, so that process is held (never
   * let go for being idle) until the sign-in ends: Codex says it has (`watchAccount`), it is cancelled, it has
   * been open longer than `timeouts.login`, or the process is gone.
   */
  login({ type } = {}) {
    return this.run(async () => {
      if (type !== 'chatgpt') throw rpcError('not-allowed', SIGN_IN_ONLY);
      if (this.before) await this.before();
      if (this.signIn) throw rpcError('busy', 'A sign-in is already open.');
      const proc = this.acquire(); // let go by endLogin, not when this call returns
      const entry = { proc, loginId: null, timer: null, why: null, early: [], cancelAsked: false };
      this.signIn = entry;
      const drop = () => { if (this.signIn === entry) { this.signIn = null; this.release(); } };
      let r;
      try {
        // A sign-in for a login kept in a folder of its own is started only by a process that is in that folder:
        // started anywhere else, it would replace the login found there.
        if (this.home) await this.inPlace(proc);
        r = await proc.request('account/login/start', { type: 'chatgpt' });
      }
      catch (err) { drop(); throw err; }
      const loginId = typeof r?.loginId === 'string' && r.loginId ? r.loginId : null;
      const authUrl = typeof r?.authUrl === 'string' && r.authUrl ? r.authUrl : null;
      if (!loginId || !authUrl) {
        // Not what a browser sign-in answers. Whatever was started cannot be named, so it goes with its process.
        drop();
        if (proc === this.proc) this.retire(0); else proc.kill();
        throw rpcError('rpc', 'Codex did not start its sign-in.', { method: 'account/login/start' });
      }
      entry.loginId = loginId;
      proc.exited.then(() => this.endLogin(entry, { success: false, error: null, stopped: true }));
      if (entry.cancelAsked) { // cancelled while it was starting
        await this.stopLogin(entry, 'cancelled');
        throw rpcError('cancelled', 'The sign-in was cancelled.');
      }
      entry.timer = setTimeout(() => { this.stopLogin(entry, 'timedOut').catch(() => {}); }, this.t.login);
      entry.timer.unref?.();
      // It ended before its start was answered (the two lines arrived together).
      const early = entry.early.find((e) => e.loginId === loginId);
      if (early) this.endLogin(entry, early);
      return { loginId, authUrl };
    });
  }

  /**
   * Stop waiting for the sign-in and have Codex drop it: { ok: true, status: 'canceled' | 'notFound' }.
   * `loginId` may be left out: there is only ever one. Watchers hear the end with `cancelled`.
   */
  cancelLogin(loginId) {
    return this.run(async () => {
      const entry = this.signIn;
      if (!entry || (typeof loginId === 'string' && entry.loginId !== null && loginId !== entry.loginId)) return { status: 'notFound' };
      if (entry.loginId === null) { entry.cancelAsked = true; return { status: 'canceled' }; } // stopped as soon as it has started
      return { status: await this.stopLogin(entry, 'cancelled') };
    });
  }

  // Have Codex drop a sign-in, and stop waiting for it whatever Codex answers. If Codex cannot be told, its process
  // goes instead: a sign-in page nobody is waiting for must not be able to sign anyone in.
  async stopLogin(entry, why) {
    if (this.signIn !== entry) return 'notFound';
    entry.why ??= why;
    let status = 'notFound';
    try {
      const r = await entry.proc.request('account/login/cancel', { loginId: entry.loginId }, { timeoutMs: this.t.cancel });
      status = r?.status === 'canceled' ? 'canceled' : 'notFound';
    } catch {
      if (entry.proc.alive) { if (entry.proc === this.proc) this.retire(0); else entry.proc.kill(); }
    }
    this.endLogin(entry, { success: false, error: null });
    return status;
  }

  // The sign-in is over: the process is no longer held for it, and the watchers hear how it ended.
  endLogin(entry, result) {
    if (this.signIn !== entry) return;
    this.signIn = null;
    clearTimeout(entry.timer);
    if (result.success) this.modelCache = null;
    this.release();
    const success = result.success === true;
    const event = {
      // Why Canopy stopped waiting says more than the words Codex has for a sign-in it was told to drop.
      type: 'login', loginId: entry.loginId, success, error: success || entry.why ? null : result.error ?? null,
      ...(entry.why && { [entry.why]: true }), ...(result.stopped && { stopped: true }),
    };
    setImmediate(() => this.tell(event));
  }

  /**
   * Sign Codex out on this Mac: { ok: true }. Codex is one login for the terminal, its own app and Canopy, so this
   * is only ever called for a user who asked for exactly that.
   */
  logout() {
    return this.run(async () => {
      if (this.signIn) throw rpcError('busy', 'A sign-in is open.');
      await this.ask('account/logout'); // no params, as Codex documents the call
      this.modelCache = null;
      return {};
    });
  }

  /**
   * Does OpenAI take Codex's login right now? { ok: true } only when a call that needs the login went through
   * (reading the plan's limits: nothing is spent and nothing changes). A failure says nothing either way: an API
   * key has no limits to read, and with no network every call fails.
   */
  loginWorks() {
    return this.run(async () => { await this.ask('account/rateLimits/read'); return {}; });
  }

  /**
   * Past chats, newest first: { threads: [{ id, cwd, title, preview, createdAt, updatedAt, model, … }], nextCursor }.
   * Codex echoes `cwd` as it was given, so compare folders by real path. Reads Codex's index only (2 ms, against
   * 3 s for the scan that repairs it), unless `repair` is set. `sourceKinds` picks where the chats were started
   * (['cli', 'vscode', 'appServer'], say); left out, Codex lists its interactive ones.
   * Chats of every model provider are asked for (the empty list): left to itself Codex lists only those of the
   * provider this process runs on, and a chat begun on a pasted key is on another one than Codex's own.
   */
  listThreads({ cwd, limit = 100, cursor, archived = false, repair = false, sourceKinds } = {}) {
    return this.run(async () => {
      const kinds = Array.isArray(sourceKinds) ? sourceKinds.filter((k) => typeof k === 'string' && k) : [];
      const r = await this.ask('thread/list', {
        ...(cwd && { cwd }), limit, sortKey: 'updated_at', ...(cursor && { cursor }), ...(archived && { archived: true }),
        ...(kinds.length > 0 && { sourceKinds: kinds }),
        ...(!repair && { useStateDbOnly: true }), modelProviders: [],
      }, { timeoutMs: this.t.list });
      return { threads: (Array.isArray(r?.data) ? r.data : []).map(threadRow).filter(Boolean), nextCursor: r?.nextCursor ?? null };
    });
  }

  /**
   * Is a chat Codex has on record filed under this folder: is its file's path, as Codex's index has it, inside the
   * folder? { ok: true, found, complete }. Every chat is looked at: saved and archived, of every provider, wherever
   * it was started. `complete` false: there were more chats than were read, so "not found" is not known.
   * (A chat begun on a login kept in a folder of its own is filed under that folder: src/codex-account-home.mjs.)
   */
  filedUnder(dir) {
    return this.run(async () => {
      if (!isAbs(dir)) throw rpcError('invalid', 'A folder is named in full.');
      const roots = [...new Set([path.resolve(dir), await realpath(dir).catch(() => null)].filter(Boolean))];
      const under = (p) => typeof p === 'string' && roots.some((root) => p.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
      let complete = true;
      for (const archived of [false, true]) {
        let cursor = null;
        for (let page = 0; ; page++) {
          if (page >= FILED_PAGES) { complete = false; break; }
          const r = await this.ask('thread/list', {
            limit: 100, ...(cursor && { cursor }), ...(archived && { archived: true }),
            sourceKinds: [...SOURCE_KINDS], useStateDbOnly: true, modelProviders: [],
          }, { timeoutMs: this.t.list });
          const data = Array.isArray(r?.data) ? r.data : [];
          if (data.some((t) => under(t?.path))) return { found: true, complete: true };
          cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
          if (!cursor || !data.length) break;
        }
      }
      return { found: false, complete };
    });
  }

  /** One past chat's details (no turns): { thread }. */
  readThread(threadId) {
    return this.run(async () => {
      const r = await this.ask('thread/read', { threadId: String(threadId), includeTurns: false });
      return { thread: threadRow(r?.thread), raw: r?.thread ?? null };
    });
  }

  /**
   * A past chat's turns with every item, oldest first, for codex-adapter's adaptHistory: { turns, truncated, cursor }.
   * Works on a chat that is not open. `maxTurns` keeps the newest ones when a chat is very long, and `truncated`
   * says that older ones were left out. `cursor` (an option) reads the turns just older than an earlier read's;
   * `cursor` (in the answer) is where to carry on from, or null (see readTurns).
   */
  turns(threadId, { maxTurns = 400, pageSize = 50, cursor = null } = {}) {
    return this.run(() => readTurns((method, params, opts) => this.ask(method, params, opts), threadId, {
      maxTurns, pageSize, cursor, timeoutMs: this.t.history, budgetMs: this.t.historyBudget,
    }));
  }

  oneOffHeard(method, params) {
    const w = this.oneOffs.get(params?.threadId);
    if (!w) return;
    if (method === 'item/completed' && params?.item?.type === 'agentMessage' && typeof params.item.text === 'string') w.text = params.item.text;
    else if (method === 'turn/completed') w.done({ status: params?.turn?.status ?? null, text: w.text });
  }

  /**
   * A title for a conversation, from a throwaway thread (see ONE_OFF_CONFIG): { ok, title }. `prompt` is the whole
   * question; `model` and `effort` are what to ask with (Codex's defaults when unset). Nothing is saved in Codex.
   */
  suggestTitle(prompt, { model, effort } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) return Promise.resolve({ ok: false, code: 'invalid-input', message: 'Nothing to name.' });
    return this.run(async () => {
      if (this.before) await this.before();
      const proc = this.acquire();
      let threadId = null;
      let timer = null;
      try {
        if (this.home) await this.inPlace(proc);
        const th = await proc.request('thread/start', {
          ephemeral: true, cwd: os.tmpdir(), sandbox: 'read-only', approvalPolicy: 'never', serviceTier: null,
          baseInstructions: ONE_OFF_INSTRUCTIONS, config: ONE_OFF_CONFIG, ...(typeof model === 'string' && model && { model }),
        });
        threadId = th?.thread?.id ?? th?.threadId ?? null;
        if (!threadId) throw rpcError('protocol', 'Codex did not open a thread.');
        // Listening before the turn starts: its answer can arrive before turn/start's own reply does.
        const answered = new Promise((resolve, reject) => {
          this.oneOffs.set(threadId, { text: '', done: resolve });
          timer = setTimeout(() => reject(rpcError('timeout', 'Codex did not answer in time.')), this.t.title);
        });
        await proc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], serviceTier: null, ...(typeof effort === 'string' && effort && { effort }) });
        const r = await answered;
        if (r.status !== 'completed' || !r.text.trim()) throw rpcError('failed', `Codex did not give a title (${r.status ?? 'no answer'}).`);
        return { title: r.text };
      } finally {
        clearTimeout(timer);
        if (threadId) this.oneOffs.delete(threadId);
        this.release();
      }
    });
  }

  /** Name a chat that is not open here. (An open chat is renamed through its session.) */
  rename(threadId, name) {
    const title = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!title) return Promise.resolve({ ok: false, code: 'invalid-input', message: 'A name is required.' });
    return this.run(async () => { await this.ask('thread/name/set', { threadId: String(threadId), name: title }); return {}; });
  }

  /**
   * Put a chat away (Codex moves it out of its list; nothing is deleted). For the smoke script's own test chats:
   * the app never archives a user's chat. A chat that is not on disk, or is already archived, counts as done.
   */
  async archive(threadId) {
    const r = await this.run(async () => { await this.ask('thread/archive', { threadId: String(threadId) }); return {}; });
    return r.ok || r.code === 'not-found' ? { ok: true, archived: r.ok } : r;
  }

  /** Let the process go. Resolves once it has exited or been killed. */
  async close({ graceMs = 1500 } = {}) {
    this.closed = true;
    clearTimeout(this.timer); this.timer = null;
    this.retire(graceMs);
    await Promise.allSettled([...this.closing]);
  }
}

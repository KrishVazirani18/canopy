// Environment discovery: the user's shell environment, their real `claude`, login state,
// their saved Claude Code preferences, and the file and git lookups the UI needs.
// Everything here is defensive: nothing exported from this file throws or rejects.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as FS, accessSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { makeRedactor } from './redact.mjs';

// ---------- small process helpers ----------

/** A folder that always exists and never carries project configuration: where helper commands run. */
function neutralCwd() {
  const home = os.homedir();
  try { if (statSync(home).isDirectory()) return home; } catch { /* fall through */ }
  return os.tmpdir();
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
        resolve({
          ok: !err, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', err: err ?? null,
          timedOut: !!err && (err.killed === true || err.code === 'ETIMEDOUT'),
        });
      });
      // A command that finds a pipe on stdin may wait for it. Nothing here is ever fed input.
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    } catch (err) { resolve({ ok: false, stdout: '', stderr: '', err, timedOut: false }); }
  });
}

const isAbsString = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);

async function isDir(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** True for a Claude Code session id (a uuid). Anything else must never reach `--resume`. */
export function isSessionId(s) { return typeof s === 'string' && UUID.test(s); }

// ---------- environment hygiene ----------

// Variables that describe the agent session we were launched from. A child `claude` that inherits
// them believes it is a nested or attended session and changes behaviour.
const AGENT_EXACT = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
]);
const isAgentVar = (k) => AGENT_EXACT.has(k) || k.startsWith('CLAUDE_CODE_MESSAGING');
// Variables that belong to the host app's own runtime (Electron, npm scripts), not to the user.
const HOST_EXACT = new Set(['NODE_OPTIONS', 'NODE_ENV', 'INIT_CWD', '__CFBundleIdentifier', 'ORIGINAL_XDG_CURRENT_DESKTOP']);
const isHostVar = (k) => HOST_EXACT.has(k) || k.startsWith('ELECTRON_') || k.startsWith('npm_') || (k.startsWith('CANOPY_') && k !== 'CANOPY_CLAUDE_PATH');

/**
 * Copy of `env` without the variables the host app or a parent agent session injected.
 * User-chosen Claude Code settings (CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_*…) are kept.
 */
export function scrubEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || !k || isAgentVar(k) || isHostVar(k)) continue;
    out[k] = v;
  }
  return out;
}

const MINIMAL_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'];
/** The few variables a helper command (git) needs. Secrets in the session environment never reach it. */
export function minimalEnv(env) {
  const out = {};
  const src = env && typeof env === 'object' ? env : {};
  for (const k of MINIMAL_KEYS) if (typeof src[k] === 'string' && src[k]) out[k] = src[k];
  if (!out.PATH) out.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  if (!out.HOME) out.HOME = os.homedir();
  return out;
}

// ---------- the user's shell environment ----------

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_HELPERS = { DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false', ZSH_TMUX_AUTOSTARTED: 'true' };
// Per-shell-instance noise, and the helper variables above: never copied out of the probe shell.
const SHELL_NOISE = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', ...Object.keys(SHELL_HELPERS)]);
const INTERACTIVE_SHELLS = new Set(['zsh', 'bash', 'fish']);
const MAX_ENV_BYTES = 8 * 1024 * 1024;

function isExecutableFileSync(p) {
  try { if (!statSync(p).isFile()) return false; accessSync(p, FS.X_OK); return true; } catch { return false; }
}

function pickShell() {
  const candidates = [];
  try { candidates.push(os.userInfo().shell); } catch { /* no passwd entry */ }
  candidates.push(process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh');
  for (const c of candidates) if (isAbsString(c) && isExecutableFileSync(c)) return c;
  return '/bin/sh';
}

/** Parse `env -0` output found between two copies of `mark`. Returns null when the marks are missing. */
export function parseMarkedEnv(buf, mark) {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const a = text.indexOf(mark);
  if (a < 0) return null;
  const b = text.indexOf(mark, a + mark.length);
  if (b < 0) return null;
  const vars = {};
  for (const entry of text.slice(a + mark.length, b).split('\0')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const k = entry.slice(0, i);
    if (ENV_KEY.test(k)) vars[k] = entry.slice(i + 1);
  }
  return vars;
}

// Run the user's shell once and read the environment it ends up with. The output is framed by a
// random mark, so banners, prompts and anything else the rc files print cannot corrupt it.
function captureShellEnv(shell, flag, env, timeoutMs) {
  return new Promise((resolve) => {
    const mark = `__canopy_env_${randomBytes(8).toString('hex')}__`;
    const script = `printf '%s' '${mark}'; /usr/bin/env -0; printf '%s' '${mark}'`;
    let child, timer, grace, done = false, buf = Buffer.alloc(0);
    const finish = (vars, reason) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(grace);
      try { child?.stdout?.destroy(); } catch { /* already closed */ }
      resolve({ vars, reason: vars ? null : reason });
    };
    // detached: the shell gets its own session, so an interactive shell cannot grab our terminal,
    // and the whole group (plugins, prompts, tmux) can be killed at once.
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    try {
      child = spawn(shell, [flag, script], { env, cwd: neutralCwd(), stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
    } catch { return resolve({ vars: null, reason: 'spawn' }); }
    timer = setTimeout(() => { killGroup(); finish(parseMarkedEnv(buf, mark), 'timeout'); }, timeoutMs);
    child.on('error', () => finish(null, 'spawn'));
    child.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      if (buf.length > MAX_ENV_BYTES) { killGroup(); return finish(null, 'too-large'); }
      // Done as soon as the closing mark arrives: a daemon started by an rc file may hold the pipe open forever.
      const vars = parseMarkedEnv(buf, mark);
      if (vars) { finish(vars, null); child.unref(); }
    });
    child.stdout.on('error', () => {});
    child.on('close', () => finish(parseMarkedEnv(buf, mark), 'failed'));
    child.on('exit', () => { grace = setTimeout(() => finish(parseMarkedEnv(buf, mark), 'failed'), 250); });
  });
}

async function loadShellEnvOnce(timeoutMs, shellOverride) {
  const t0 = Date.now();
  const base = scrubEnv(process.env);
  const shell = shellOverride ?? pickShell();
  let vars = null, reason = null;
  if (process.platform === 'win32') reason = 'unsupported';
  else {
    const probeEnv = { ...base, ...SHELL_HELPERS };
    const interactive = INTERACTIVE_SHELLS.has(path.basename(shell));
    const first = await captureShellEnv(shell, interactive ? '-ilc' : '-lc', probeEnv, timeoutMs);
    vars = first.vars; reason = first.reason;
    if (!vars && interactive) {
      // An interactive shell can hang (a prompt, tmux, an `exec`). A plain login shell still has PATH and exports.
      const second = await captureShellEnv(shell, '-lc', probeEnv, Math.min(timeoutMs, 4000));
      vars = second.vars;
      reason = vars ? `interactive-${first.reason}` : second.reason;
    }
  }
  // The shell overlays the scrubbed base, so a value the rc files export on purpose (even NODE_OPTIONS) survives.
  const env = { ...base };
  if (vars) for (const [k, v] of Object.entries(vars)) if (!SHELL_NOISE.has(k) && !isAgentVar(k)) env[k] = v;

  // Fallback PATH additions, harmless if already present.
  const parts = (env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean);
  for (const p of [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']) if (!parts.includes(p)) parts.push(p);
  env.PATH = parts.join(':');
  // Claude Code looks up its login by user name: a Dock launch with a stripped environment must still have one.
  if (!env.HOME) env.HOME = os.homedir();
  if (!env.USER) { try { env.USER = os.userInfo().username; } catch { /* leave unset */ } }
  if (!env.LOGNAME && env.USER) env.LOGNAME = env.USER;
  if (!env.SHELL) env.SHELL = shell;
  // Apps started from the Dock have no locale; without one, command output with non-ASCII text is mangled.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';

  return { env, shellOk: !!vars, tookMs: Date.now() - t0, reason, shell };
}

let shellMemo = null;
// The environment the login shell gave, once it has been read: the one sessions run with (see configHome).
let shellEnvSeen = null;
/**
 * Mac apps launched from the Dock don't inherit the terminal's environment (PATH, API keys…).
 * Load it from the user's login shell so Claude's tools see what they would in Terminal.
 * Memoized: pass `force` to run the shell again.
 * @param {{force?: boolean, timeoutMs?: number, shell?: string}} [opts]
 * @returns {Promise<{env: Record<string,string>, shellOk: boolean, tookMs: number, reason: string|null, shell: string}>}
 */
export function loadShellEnv(opts) {
  const { force = false, timeoutMs = 6000, shell } = opts && typeof opts === 'object' ? opts : {};
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 6000;
  const load = (override) => loadShellEnvOnce(ms, override).catch((err) => ({
    env: scrubEnv(process.env), shellOk: false, tookMs: 0, reason: `error: ${String(err?.message ?? err).slice(0, 200)}`, shell: override ?? '',
  }));
  // Each caller gets its own copy: one consumer adding TERM must not change another's environment.
  const copy = (r) => ({ ...r, env: { ...r.env } });
  // An explicit shell is a diagnostic run (and the test seam): it never replaces the memoized result.
  if (isAbsString(shell)) return load(shell).then(copy);
  if (!shellMemo || force) {
    const p = shellMemo = load();
    p.then((r) => { if (shellMemo === p) shellEnvSeen = r.env; }); // a slower, older run never replaces a newer one
  }
  return shellMemo.then(copy);
}

/**
 * Claude Code's own folder for an environment: its CLAUDE_CONFIG_DIR, else ~/.claude.
 * With no environment given, the answer is for the one sessions run in: the login shell's once it has been read.
 * An app started from the Dock has no CLAUDE_CONFIG_DIR of its own even when the user's shell sets one, so
 * anything that reads Claude Code's files must ask here instead of looking at this process's environment.
 */
export function configHome(env) {
  const e = env && typeof env === 'object' ? env : shellEnvSeen ?? process.env;
  return str(e.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), '.claude');
}

// ---------- finding claude ----------

const defaultClaudePaths = () => [
  path.join(os.homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

// A candidate must be a regular file we may execute, and one that other users cannot replace.
async function vetExecutable(p) {
  try {
    if (!isAbsString(p)) return null;
    const realPath = await realpath(p);
    const st = await stat(realPath);
    if (!st.isFile() || (st.mode & 0o002)) return null;
    await access(p, FS.X_OK);
    return realPath;
  } catch { return null; }
}

async function isWorldWritable(p) { try { return ((await stat(p)).mode & 0o002) !== 0; } catch { return false; } }

/**
 * Locate the user's Claude Code binary: an explicit override, then PATH (absolute entries only,
 * as the terminal would resolve it), then the standard install locations.
 * @returns {Promise<{path: string, realPath: string, source: 'override'|'path'|'default'} | null>}
 */
export async function findClaudeDetailed(env) {
  try {
    const e = env && typeof env === 'object' ? env : process.env;
    const tried = new Set();
    const attempt = async (p, source) => {
      if (tried.has(p)) return null;
      tried.add(p);
      const realPath = await vetExecutable(p);
      return realPath ? { path: p, realPath, source } : null;
    };
    if (isAbsString(e.CANOPY_CLAUDE_PATH)) { const hit = await attempt(e.CANOPY_CLAUDE_PATH, 'override'); if (hit) return hit; }
    for (const dir of String(e.PATH ?? '').split(path.delimiter)) {
      if (!isAbsString(dir)) continue;          // '', '.', and relative entries resolve against whatever folder we happen to be in
      if (await isWorldWritable(dir)) continue; // anyone could have put a `claude` there
      const hit = await attempt(path.join(dir, 'claude'), 'path');
      if (hit) return hit;
    }
    for (const p of defaultClaudePaths()) { const hit = await attempt(p, 'default'); if (hit) return hit; }
  } catch { /* fall through */ }
  return null;
}

/** Path of the user's `claude`, or null when Claude Code is not installed. */
export async function findClaude(env) {
  return (await findClaudeDetailed(env))?.path ?? null;
}

export async function claudeVersion(claudePath, env, { timeoutMs = 5000 } = {}) {
  if (!isAbsString(claudePath)) return null;
  const r = await run(claudePath, ['--version'], { env, cwd: neutralCwd(), timeout: timeoutMs });
  const line = r.ok ? r.stdout.trim().split('\n')[0].trim().slice(0, 120) : '';
  return line || null;
}

// ---------- login ----------

// The JSON object in a command's output, from the first `{` to the last `}`. A banner printed
// before it may itself contain a brace, so later opening braces are tried too.
function parseJsonObject(text) {
  const end = text.lastIndexOf('}');
  let start = text.indexOf('{');
  for (let tries = 0; start >= 0 && start < end && tries < 64; tries++, start = text.indexOf('{', start + 1)) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* not this brace */ }
  }
  return null;
}

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Login state as Claude Code itself reports it.
 * `loggedIn` is tri-state: true, false, or null when it could not be determined (timeout or
 * unreadable output, after one slower retry). Null means "ask again", never "signed out".
 * `configDir` is the folder Claude Code answered for and `orgId` its organisation: together with the email they
 * say which login this is. `expiresAt` is its `loginExpiresAt`.
 * @returns {Promise<{loggedIn: boolean|null, method: string|null, org: string|null, email?: string|null, orgId?: string|null, provider?: string|null, apiKeySource?: string|null, subscriptionType?: string|null, configDir?: string|null, expiresAt?: number|string|null, error?: string}>}
 */
export async function authStatus(claudePath, env, { timeoutMs = 8000 } = {}) {
  const redact = makeRedactor(env);
  const unknown = (detail) => ({ loggedIn: null, method: null, org: null, error: redact(detail).trim().slice(0, 500) });
  if (!isAbsString(claudePath)) return unknown('Claude Code is not installed.');
  let last = null;
  // Runs in a neutral folder: a project's settings (apiKeyHelper) must never be consulted for this.
  for (const ms of [timeoutMs, 20000]) {
    const r = await run(claudePath, ['auth', 'status', '--json'], { env, cwd: neutralCwd(), timeout: ms });
    const d = parseJsonObject(r.stdout);
    if (d && typeof d.loggedIn === 'boolean') {
      return {
        loggedIn: d.loggedIn, method: str(d.authMethod), org: str(d.orgName),
        email: str(d.email), orgId: str(d.orgId), provider: str(d.apiProvider), apiKeySource: str(d.apiKeySource),
        subscriptionType: str(d.subscriptionType), configDir: str(d.configDirectory), expiresAt: d.loginExpiresAt ?? null,
      };
    }
    last = r;
    if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(r.err?.code)) break;      // waiting longer cannot help
  }
  const detail = last?.timedOut ? 'Claude Code did not answer in time.' : (last?.stderr || last?.stdout || String(last?.err?.message ?? 'No output.'));
  return unknown(detail);
}

let envMemo = null;
/**
 * Everything the app needs to know before it can open a session.
 * Memoized while healthy: a result without Claude Code or with unknown login is re-checked on the next call.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{env: Record<string,string>, shellOk: boolean, shellReason: string|null, claudePath: string|null, claudeSource: string|null, version: string|null, auth: object, tookMs: number}>}
 */
export function checkEnvironment(opts) {
  const { force = false } = opts && typeof opts === 'object' ? opts : {};
  if (!envMemo || force) {
    const p = (async () => {
      const t0 = Date.now();
      const { env, shellOk, reason } = await loadShellEnv({ force });
      const found = await findClaudeDetailed(env);
      const claudePath = found?.path ?? null;
      const [version, auth] = claudePath
        ? await Promise.all([claudeVersion(claudePath, env), authStatus(claudePath, env)])
        : [null, { loggedIn: false, method: null, org: null }];
      return { env, shellOk, shellReason: reason, claudePath, claudeSource: found?.source ?? null, version, auth, tookMs: Date.now() - t0 };
    })().catch((err) => ({
      env: scrubEnv(process.env), shellOk: false, shellReason: `error: ${String(err?.message ?? err).slice(0, 200)}`,
      claudePath: null, claudeSource: null, version: null, auth: { loggedIn: null, method: null, org: null }, tookMs: 0,
    }));
    envMemo = p;
    p.then((r) => { if (envMemo === p && (!r.claudePath || r.auth?.loggedIn == null)) envMemo = null; });
  }
  return envMemo.then((r) => ({ ...r, env: { ...r.env }, auth: { ...r.auth } }));
}

// ---------- the user's saved Claude Code preferences ----------

const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const PREF_DEFAULTS = Object.freeze({ defaultMode: 'default', allowBypass: false, fast: false, enableAllProjectMcp: false, showThinking: true, suggestions: true });

function prefsFrom(s, { bypassAccepted } = {}) {
  if (!s || typeof s !== 'object') return { ...PREF_DEFAULTS };
  const perms = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
  const bypassDisabled = perms.disableBypassPermissionsMode === 'disable';
  let defaultMode = MODES.has(perms.defaultMode) ? perms.defaultMode : 'default';      // 'manual' is an alias of 'default'
  if (defaultMode === 'bypassPermissions' && bypassDisabled) defaultMode = 'default';
  if (defaultMode === 'auto' && perms.disableAutoMode === 'disable') defaultMode = 'default';
  const accepted = bypassAccepted ?? (s.skipDangerousModePermissionPrompt === true || perms.defaultMode === 'bypassPermissions');
  return {
    defaultMode,
    // The terminal lets you use bypass mode once you've opted in; mirror that, and an admin's off switch.
    allowBypass: !bypassDisabled && accepted === true,
    fast: s.fastMode === true && s.fastModePerSessionOptIn !== true,
    enableAllProjectMcp: s.enableAllProjectMcpServers === true,
    showThinking: s.showThinkingSummaries !== false,
    suggestions: s.promptSuggestionEnabled !== false,
  };
}

const userSettingsFile = (env) => path.join(configHome(env ?? {}), 'settings.json');

/**
 * The user-tier preferences SDK sessions don't pick up on their own (~/.claude/settings.json).
 * Always returns every field; a missing or unreadable file yields the defaults.
 * @returns {{defaultMode: string, allowBypass: boolean, fast: boolean, enableAllProjectMcp: boolean, showThinking: boolean, suggestions: boolean}}
 */
export function readUserPrefsSync(env) {
  try { return prefsFrom(JSON.parse(readFileSync(userSettingsFile(env), 'utf8'))); } catch { return { ...PREF_DEFAULTS }; }
}

export async function readUserPrefs(env) {
  try { return prefsFrom(JSON.parse(await readFile(userSettingsFile(env), 'utf8'))); } catch { return { ...PREF_DEFAULTS }; }
}

/**
 * Preferences from the full settings cascade (managed policy, user, and for a trusted folder its
 * project and local tiers), merged by Claude Code's own engine. Returns {} when that is not possible.
 * Project tiers are only read when the caller says the folder is trusted, and a project can never
 * switch on an escalating default mode or accept the bypass prompt on the user's behalf.
 */
export async function resolvePrefs(cwd, env, { trusted = false } = {}) {
  try {
    // The engine runs in this process and reads this process's config dir: it cannot answer for another profile.
    if ((str(env?.CLAUDE_CONFIG_DIR) ?? '') !== (str(process.env.CLAUDE_CONFIG_DIR) ?? '')) return {};
    if (!isAbsString(cwd)) return {};
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof sdk.resolveSettings !== 'function') return {};
    const resolved = await sdk.resolveSettings({ cwd, ...(trusted ? {} : { settingSources: ['user'] }) });
    const effective = typeof sdk.filterEscalatingDefaultMode === 'function' ? sdk.filterEscalatingDefaultMode(resolved) : resolved.effective;
    const own = (resolved.sources ?? []).filter((x) => x.source !== 'project').map((x) => x.settings ?? {});
    const bypassAccepted = own.some((x) => x.skipDangerousModePermissionPrompt === true || x.permissions?.defaultMode === 'bypassPermissions');
    return prefsFrom(effective, { bypassAccepted });
  } catch { return {}; }
}

// ---------- settings someone already chose ----------

const MANAGED_SETTINGS = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
  : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json' : '/etc/claude-code/managed-settings.json';

// Whether a setting (or the variable that stands for it) is set anywhere this chat's Claude Code reads it: the chat's
// environment, the admin's file, and the user's and (by `sources`) the project's settings files, in their `env`
// blocks too. A file that cannot be read counts as not choosing. `sources` are the settings tiers this chat loads (an
// untrusted folder's own files are not among them); `managed` is the admin's file (the test seam).
function settingChosen(env, cwd, keys, envVar, { sources = ['user', 'project', 'local'], managed = MANAGED_SETTINGS } = {}) {
  if (env?.[envVar] !== undefined) return true;
  const files = [managed];
  if (sources.includes('user')) files.push(userSettingsFile(env));
  if (sources.includes('project') && isAbsString(cwd)) files.push(path.join(cwd, '.claude', 'settings.json'));
  if (sources.includes('local') && isAbsString(cwd)) files.push(path.join(cwd, '.claude', 'settings.local.json'));
  return files.some((file) => {
    try {
      const set = JSON.parse(readFileSync(file, 'utf8'));
      return keys.some((k) => set?.[k] !== undefined) || set?.env?.[envVar] !== undefined;
    } catch { return false; } // no such file, or not one Claude Code could read either
  });
}

// ---------- the skill listing's size ----------

/**
 * Claude Code's variable for how many characters the list of skills in every request may take. Left alone, the
 * list gets 1% of the model's context window (times 4 characters a token): 8,000 characters on a 200k model, but
 * 40,000 on a 1M one, where it then grows to the full descriptions of every installed skill (about 9,500 tokens in
 * every request, measured Nov 19 2026 with Vercel, Codex and a few other plugins installed).
 */
export const SKILL_BUDGET_VAR = 'SLASH_COMMAND_TOOL_CHAR_BUDGET';
/** What a 200k-context chat gets on its own: 200,000 tokens x 4 characters x 1%. Every skill is still listed. */
export const SKILL_BUDGET_CHARS = 8000;

/** Whether somebody already chose the skill listing's size (see settingChosen for where it looks). */
export function skillBudgetChosen(env, cwd, o = {}) {
  return settingChosen(env, cwd, ['skillListingBudgetFraction', 'skillListingMaxDescChars'], SKILL_BUDGET_VAR, o);
}

// ---------- git and files ----------

// Repository config is untrusted input: fsmonitor is a command git would run for us.
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotePath=false'];
const gitEnv = (env) => ({ ...minimalEnv(env ?? process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

const MAX_FILES = 20000;
const WALK_DEADLINE_MS = 1500;
const WALK_DEPTH = 6;
const FILES_TTL_MS = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__']);

function isHomeOrRoot(dir) {
  try {
    const d = realpathSync.native(dir);
    if (path.dirname(d) === d) return true;
    return d === realpathSync.native(os.homedir());
  } catch { return false; }
}

function gitLsFiles(cwd, env, cap) {
  return new Promise((resolve) => {
    const files = [];
    let child, done = false, truncated = false, tail = '', last = null;
    const decoder = new StringDecoder('utf8');
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    try {
      child = spawn('git', [...GIT_SAFE, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd, env: gitEnv(env), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { kill(); finish(files.length ? { files, truncated: true } : null); }, 8000);
    child.on('error', () => finish(null));
    child.stdout.on('data', (chunk) => {
      if (done) return;
      const parts = (tail + decoder.write(chunk)).split('\0');
      tail = parts.pop();
      for (const p of parts) {
        if (!p || p === last) continue;          // unmerged paths are listed once per stage
        if (files.length >= cap) { truncated = true; kill(); return finish({ files, truncated }); }
        files.push(p); last = p;
      }
    });
    child.stdout.on('error', () => {});
    child.on('close', (code) => finish(code === 0 ? { files, truncated } : null));
  });
}

// Breadth-first, so a capped or timed-out walk still has every shallow file.
async function walkFiles(cwd, cap, deadlineMs) {
  const files = [];
  const end = Date.now() + deadlineMs;
  const queue = [['', 0]];
  let truncated = false;
  scan: for (let i = 0; i < queue.length; i++) {
    const [rel, depth] = queue[i];
    let entries;
    try { entries = await readdir(rel ? path.join(cwd, rel) : cwd, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= cap || Date.now() > end) { truncated = true; break scan; }
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < WALK_DEPTH) queue.push([child, depth + 1]); }
      else if (e.isFile() || e.isSymbolicLink()) files.push(child);
    }
  }
  return { files, truncated };
}

async function listFilesUncached(cwd, env) {
  const none = { files: [], truncated: false, source: 'none' };
  if (!isAbsString(cwd) || !(await isDir(cwd)) || isHomeOrRoot(cwd)) return none;
  const git = await gitLsFiles(cwd, env, MAX_FILES);
  if (git?.files.length) return { ...git, source: 'git' };
  const walked = await walkFiles(cwd, MAX_FILES, WALK_DEADLINE_MS);
  return { ...walked, source: walked.files.length ? 'walk' : 'none' };
}

const filesCache = new Map();     // cwd -> { at: number|null, promise }

/**
 * Files for @-mentions, relative to `cwd`: what git tracks or would track, else a shallow walk.
 * Never lists the home folder or the filesystem root. Cached per folder for 5 s; concurrent calls share one scan.
 * @returns {Promise<{files: string[], truncated: boolean, source: 'git'|'walk'|'none'}>}
 */
export function listFilesDetailed(cwd, env, { force = false } = {}) {
  const key = typeof cwd === 'string' ? cwd : '';
  const hit = filesCache.get(key);
  if (hit && !force && (hit.at === null || Date.now() - hit.at < FILES_TTL_MS)) return hit.promise;
  const entry = { at: null, promise: null };
  entry.promise = listFilesUncached(cwd, env)
    .catch(() => ({ files: [], truncated: false, source: 'none' }))
    .then((r) => { entry.at = Date.now(); return r; });
  filesCache.delete(key);
  filesCache.set(key, entry);
  while (filesCache.size > 8) filesCache.delete(filesCache.keys().next().value);
  return entry.promise;
}

/** File list for @-mentions. See {@link listFilesDetailed}. */
export async function listFiles(cwd, env, opts) {
  return (await listFilesDetailed(cwd, env, opts && typeof opts === 'object' ? opts : {})).files;
}

async function git(cwd, env, args, timeout = 3000) {
  const r = await run('git', [...GIT_SAFE, ...args], { cwd, env: gitEnv(env), timeout, maxBuffer: 1024 * 1024 });
  const out = r.ok ? r.stdout.trim() : '';
  return out || null;
}

const stripUserinfo = (url) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');

/**
 * Branch and origin of the repository containing `cwd`. All null outside a repository.
 * A detached HEAD reports its short commit id. Credentials embedded in the remote URL are removed.
 * @returns {Promise<{branch: string|null, repo: string|null, remote: string|null}>}
 */
export async function gitInfo(cwd, env) {
  const none = { branch: null, repo: null, remote: null };
  try {
    if (!isAbsString(cwd) || !(await isDir(cwd))) return none;
    const [symbolic, origin] = await Promise.all([
      git(cwd, env, ['symbolic-ref', '--short', '-q', 'HEAD']),
      git(cwd, env, ['config', '--get', 'remote.origin.url']),
    ]);
    const branch = symbolic ?? await git(cwd, env, ['rev-parse', '--short', 'HEAD']);
    const remote = origin ? stripUserinfo(origin) : null;
    // git@github.com:Owner/repo.git or https://github.com/Owner/repo(.git) → Owner/repo
    const m = remote ? /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote) : null;
    return { branch, repo: m ? m[1] : null, remote };
  } catch { return none; }
}

/**
 * What a chat moved to the other maker is told about its folder's repository: the branch (a detached HEAD reports
 * its short commit id) and `git status --porcelain`. Null for a folder that is not a repository.
 * @returns {Promise<{branch: string, status: string}|null>}
 */
export async function gitState(cwd, env) {
  try {
    if (!isAbsString(cwd) || !(await isDir(cwd))) return null;
    const branch = await git(cwd, env, ['symbolic-ref', '--short', '-q', 'HEAD']) ?? await git(cwd, env, ['rev-parse', '--short', 'HEAD']);
    return branch ? { branch, status: (await git(cwd, env, ['status', '--porcelain'])) ?? '' } : null;
  } catch { return null; }
}

// ---------- misc ----------

let nameMemo = null;
/** The Mac account's full name (e.g. "Sam Rivera"), for the sidebar. */
export function fullName() {
  nameMemo ??= (async () => {
    let fallback = 'You';
    try { fallback = os.userInfo().username || fallback; } catch { /* no passwd entry */ }
    if (process.platform !== 'darwin') return fallback;
    const r = await run('/usr/bin/id', ['-F'], { timeout: 3000 });
    return (r.ok && r.stdout.trim()) || fallback;
  })();
  return nameMemo;
}

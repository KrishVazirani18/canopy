// Workspace trust.
//
// Headless Claude Code does not show the terminal's "Do you trust this folder?" prompt, so a
// project's hooks, MCP servers and helper commands would run the moment a session starts.
// Core therefore decides trust itself, from three sources only:
//   host   - folders the embedding app says the user trusted
//   claude - folders the user accepted in the terminal (projects[path].hasTrustDialogAccepted)
//   home   - the home folder, whose .claude directory is the user's own configuration
// This module only reads. It never writes Claude Code's config file.
import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_LEVELS = 12;            // risk walk
const MAX_TRUST_LEVELS = 64;      // trust walk (bounded by the git root or the filesystem root)
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024 * 1024;

// Project settings keys that run code, grant permissions or change where data goes.
const SENSITIVE_KEYS = [
  'hooks', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper',
  'statusLine', 'fileSuggestion', 'env', 'enableAllProjectMcpServers', 'enabledMcpjsonServers',
  'enabledPlugins', 'extraKnownMarketplaces', 'sandbox',
];
const ESCALATING_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']);
const CODE_DIRS = ['commands', 'agents', 'skills', 'hooks', 'output-styles', 'workflows'];
// What Claude Code puts in a project's .claude folder that loads nothing: the checkouts its worktree tool makes.
// A .claude folder holding only these is not a reason to ask for trust (anything else, known or not, still is).
const INERT_CLAUDE = new Set(['worktrees', '.DS_Store']);
const inertClaudeDir = (dot) => { try { const names = readdirSync(dot); return names.length > 0 && names.every((n) => INERT_CLAUDE.has(n)); } catch { return false; } };

const emptyRisk = () => ({
  any: false, claudeDir: false, projectSettings: false, localSettings: false, mcpJson: false,
  hookEvents: [], claudeMd: false, mcpServers: [], mcpAutoStart: false, sensitive: [], dirs: [],
});

const kind = (p) => { try { const s = statSync(p); return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'; } catch { return null; } };
const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const stripSlash = (p) => (p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p);
const clean = (p) => stripSlash(path.resolve(p));
const validCwd = (cwd) => typeof cwd === 'string' && cwd.length > 0 && cwd.length < 4096 && !cwd.includes('\0') && path.isAbsolute(cwd);

function homes() {
  const h = clean(os.homedir());
  const r = real(h);
  return r && r !== h ? [h, r] : [h];
}
const isRoot = (p) => path.dirname(p) === p;

/** Every spelling under which Claude Code may have recorded a path (as typed, resolved, NFC). */
function spellings(p) {
  const out = new Set();
  const a = clean(p);
  const r = real(a);
  for (const x of r ? [a, r] : [a]) { out.add(x); out.add(x.normalize('NFC')); }
  return [...out];
}

function readJsonSync(file, maxBytes) {
  try {
    if (statSync(file).size > maxBytes) return null;
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

// ---------- what a folder would load ----------

/**
 * Describe the project-level configuration a session started in `cwd` would load.
 * Looks in `cwd` and its ancestors up to the first one containing `.git`, at most
 * 12 levels, and never in the home folder or the filesystem root.
 * `any` is the security-relevant answer; the other fields explain it. `claudeMd` is informational,
 * and `mcpAutoStart` says whether a found `.mcp.json` would actually start servers unasked.
 * @param {string} cwd
 * @param {Record<string,string|undefined>} [env] used only to recognise a relocated user config dir
 */
export function projectRisk(cwd, env) {
  const risk = emptyRisk();
  try {
    if (!validCwd(cwd)) return risk;
    const home = homes();
    const userConfig = env?.CLAUDE_CONFIG_DIR ? real(env.CLAUDE_CONFIG_DIR) ?? clean(env.CLAUDE_CONFIG_DIR) : null;
    const hooks = new Set(), servers = new Set(), sensitive = new Set();
    let dir = real(cwd) ?? clean(cwd);
    for (let level = 0; level < MAX_LEVELS; level++) {
      if (isRoot(dir) || home.includes(dir)) break;
      let found = false;
      const dot = path.join(dir, '.claude');
      if (kind(dot) === 'dir' && (real(dot) ?? dot) !== userConfig && !inertClaudeDir(dot)) {
        risk.claudeDir = true; found = true;
        for (const [file, flag] of [['settings.json', 'projectSettings'], ['settings.local.json', 'localSettings']]) {
          const full = path.join(dot, file);
          if (kind(full) !== 'file') continue;
          risk[flag] = true;
          inspectSettings(readJsonSync(full, MAX_SETTINGS_BYTES), hooks, sensitive);
        }
        for (const sub of CODE_DIRS) if (kind(path.join(dot, sub)) === 'dir') sensitive.add(sub);
        if (kind(path.join(dot, 'CLAUDE.md')) === 'file') risk.claudeMd = true;
      }
      const mcp = path.join(dir, '.mcp.json');
      if (kind(mcp) === 'file') {
        risk.mcpJson = true; found = true;
        const names = Object.keys(readJsonSync(mcp, MAX_SETTINGS_BYTES)?.mcpServers ?? {});
        for (const n of names.slice(0, 50)) servers.add(String(n).slice(0, 80));
      }
      if (kind(path.join(dir, 'CLAUDE.md')) === 'file' || kind(path.join(dir, 'CLAUDE.local.md')) === 'file') risk.claudeMd = true;
      if (found) risk.dirs.push(dir);
      if (kind(path.join(dir, '.git')) !== null) break;
      dir = path.dirname(dir);
    }
    risk.any = risk.claudeDir || risk.mcpJson;
    risk.hookEvents = [...hooks].sort();
    risk.mcpServers = [...servers].sort();
    risk.sensitive = [...sensitive].sort();
    risk.mcpAutoStart = risk.mcpJson && userStartsProjectMcp(env, risk.mcpServers, sensitive);
  } catch { /* a folder we cannot read is reported as having nothing we could see */ }
  return risk;
}

// A `.mcp.json` only runs something when its servers are approved. Without a person to ask, that
// means the user's own settings approve every project server, or approve one of these by name,
// or the project approves itself through its settings.
function userStartsProjectMcp(env, servers, sensitive) {
  if (sensitive.has('enableAllProjectMcpServers') || sensitive.has('enabledMcpjsonServers')) return true;
  const dir = typeof env?.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), '.claude');
  const user = readJsonSync(path.join(dir, 'settings.json'), MAX_SETTINGS_BYTES);
  if (!user) return false;
  if (user.enableAllProjectMcpServers === true) return true;
  const named = Array.isArray(user.enabledMcpjsonServers) ? user.enabledMcpjsonServers : [];
  return named.some((n) => servers.includes(n));
}

function inspectSettings(s, hooks, sensitive) {
  if (!s) return;
  for (const k of SENSITIVE_KEYS) {
    const v = s[k];
    if (v == null || v === false || v === '') continue;
    if (typeof v === 'object' && !Object.keys(v).length) continue;
    sensitive.add(k);
  }
  if (s.hooks && typeof s.hooks === 'object') {
    for (const [event, list] of Object.entries(s.hooks)) {
      if (Array.isArray(list) ? list.length : list) hooks.add(String(event).slice(0, 48));
      if (hooks.size >= 64) break;
    }
  }
  const p = s.permissions;
  if (p && typeof p === 'object') {
    if (ESCALATING_MODES.has(p.defaultMode)) sensitive.add(`defaultMode:${p.defaultMode}`);
    if (Array.isArray(p.allow) && p.allow.length) sensitive.add('permissions.allow');
    if (Array.isArray(p.additionalDirectories) && p.additionalDirectories.length) sensitive.add('permissions.additionalDirectories');
  }
}

// ---------- who has trusted it ----------

/** Where Claude Code keeps its global config (and with it the per-folder trust records). */
export function claudeConfigFiles(env) {
  const custom = typeof env?.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : null;
  const home = os.homedir();
  // An explicit config dir is authoritative: never fall back to the default one, or an isolated
  // profile would inherit the main profile's trust.
  return [path.join(custom ?? home, '.claude.json'), path.join(custom ?? path.join(home, '.claude'), '.config.json')];
}

const cache = new Map();          // file -> { mtimeMs, size, trusted: Set<string> }

function trustedSetFrom(text) {
  const out = new Set();
  const projects = JSON.parse(text)?.projects;
  if (projects && typeof projects === 'object') {
    for (const [p, v] of Object.entries(projects)) {
      if (v?.hasTrustDialogAccepted === true && path.isAbsolute(p)) { const c = stripSlash(p); out.add(c); out.add(c.normalize('NFC')); }
    }
  }
  return out;
}

function claudeTrustedSync(env) {
  for (const file of claudeConfigFiles(env)) {
    let st;
    try { st = statSync(file); } catch { continue; }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { file, trusted: hit.trusted };
    if (st.size > MAX_CONFIG_BYTES) return { file, trusted: hit?.trusted ?? new Set() };
    // The CLI rewrites this file while it runs. A torn read is retried once, then the last
    // good copy is used rather than suddenly treating every folder as untrusted.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const trusted = trustedSetFrom(readFileSync(file, 'utf8'));
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, trusted });
        return { file, trusted };
      } catch { /* retry */ }
    }
    return { file, trusted: hit?.trusted ?? new Set() };
  }
  return { file: null, trusted: new Set() };
}

async function claudeTrusted(env) {
  for (const file of claudeConfigFiles(env)) {
    let st;
    try { st = await stat(file); } catch { continue; }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { file, trusted: hit.trusted };
    if (st.size > MAX_CONFIG_BYTES) return { file, trusted: hit?.trusted ?? new Set() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const trusted = trustedSetFrom(await readFile(file, 'utf8'));
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, trusted });
        return { file, trusted };
      } catch { /* retry */ }
    }
    return { file, trusted: hit?.trusted ?? new Set() };
  }
  return { file: null, trusted: new Set() };
}

/**
 * A linked git worktree shares the trust of its main checkout, as in the terminal. The link is
 * honoured only when the main repository points back at this folder: a stray `.git` file in a
 * downloaded archive cannot borrow another repository's trust.
 */
function mainCheckout(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    if (kind(dotGit) !== 'file') return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8').slice(0, 4096));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1]);
    const w = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitdir);
    if (!w) return null;
    const back = readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
    const a = real(path.resolve(gitdir, back)), b = real(dotGit);
    return a && b && a === b ? clean(w[1]) : null;
  } catch { return null; }
}

/**
 * Walk from `start` towards the root and return the first folder found in `set`.
 * Mirrors the terminal: inside a git repository only folders up to the repository root count,
 * so a trusted parent folder never extends trust into a repository cloned beneath it.
 * Records for the home folder and the filesystem root are never honoured.
 */
function findRecord(start, set, home) {
  if (!set.size) return null;
  let dir = start;
  for (let level = 0; level < MAX_TRUST_LEVELS; level++) {
    if (isRoot(dir) || home.includes(dir)) return null;
    if (set.has(dir) || set.has(dir.normalize('NFC'))) return dir;
    if (kind(path.join(dir, '.git')) !== null) {
      const main = mainCheckout(dir);
      if (main && !home.includes(main) && !isRoot(main)) for (const s of spellings(main)) if (set.has(s)) return s;
      return null;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function hostSet(accepted) {
  const out = new Set();
  if (!Array.isArray(accepted)) return out;
  for (const a of accepted) if (validCwd(a)) for (const s of spellings(a)) out.add(s);
  return out;
}

function decide(cwd, env, accepted, claude) {
  const base = { trusted: false, reason: null, by: null, configFile: claude.file, risky: emptyRisk() };
  if (!validCwd(cwd)) return base;
  const home = homes();
  const starts = spellings(cwd);
  base.risky = projectRisk(cwd, env);
  const host = hostSet(accepted);
  for (const s of starts) { const by = findRecord(s, host, home); if (by) return { ...base, trusted: true, reason: 'host', by }; }
  for (const s of starts) { const by = findRecord(s, claude.trusted, home); if (by) return { ...base, trusted: true, reason: 'claude', by }; }
  if (starts.some((s) => home.includes(s))) return { ...base, trusted: true, reason: 'home', by: home[0] };
  return base;
}

/**
 * Has the user trusted `cwd`?
 * @param {string} cwd absolute folder
 * @param {Record<string,string|undefined>} [env] the session environment (for CLAUDE_CONFIG_DIR)
 * @param {{accepted?: string[]}} [opts] folders the host app has recorded as trusted
 * @returns {{trusted: boolean, reason: 'host'|'claude'|'home'|null, by: string|null, configFile: string|null, risky: ReturnType<typeof projectRisk>}}
 */
export function folderTrustSync(cwd, env, { accepted = [] } = {}) {
  try { return decide(cwd, env, accepted, claudeTrustedSync(env)); }
  catch { return { trusted: false, reason: null, by: null, configFile: null, risky: safeRisk(cwd, env) }; }
}

/** Async twin of {@link folderTrustSync}: the config file is read off the main thread's tick. */
export async function folderTrust(cwd, env, { accepted = [] } = {}) {
  try { return decide(cwd, env, accepted, await claudeTrusted(env)); }
  catch { return { trusted: false, reason: null, by: null, configFile: null, risky: safeRisk(cwd, env) }; }
}

function safeRisk(cwd, env) { try { return projectRisk(cwd, env); } catch { return emptyRisk(); } }

/** Test hook: forget cached config reads. */
export function clearTrustCache() { cache.clear(); }

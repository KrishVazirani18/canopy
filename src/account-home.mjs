// Account folders: where a second Claude Code sign-in lives.
//
// Claude Code keeps one sign-in per folder (the one CLAUDE_CONFIG_DIR names). A sign-in added in Canopy gets a
// folder of its own under ~/.canopy/accounts, and that folder holds the sign-in and nothing else of the user's:
// their chats, settings, skills and the rest stay in their own Claude Code folder, and the account folder only
// points at them. An account is a second login, never a second setup.
//
//   accountsRoot(...)   where account folders are kept
//   create(...)         make an account's folder and its links
//   relink(...)         put the links back as they should be (cheap, and safe before every launch)
//   health(...)         look, change nothing: is the folder fit to launch on?
//   strangers(...)      names in the user's Claude Code folder that Canopy does not know
//   syncConfig(...)     copy the user's connectors and folder-trust answers into the account's own config file
//   remove(...)         sign the folder out, then delete it entry by entry
//
// Rules this file keeps (each has a test in account-home.test.mjs):
//   - Only the names in LINKS are ever linked. No dotfile is, and nothing Claude Code keeps per folder is: its
//     sign-in, its policy files, its session registry, its background service, its caches, its telemetry.
//   - Nothing is ever created, changed or deleted in the user's own Claude Code folder or its config file.
//   - An account folder is never moved or renamed: Claude Code files a sign-in under the folder's path.
//   - Deleting never follows a link, and never touches a path that resolves outside the accounts root.
//   - Of Claude Code's config file only connectors and folder-trust answers are read out. Who is signed in is
//     only ever learned by asking Claude Code (env.mjs's authStatus), never from a file.
//
// Everything here is synchronous except `remove`, so a caller can check "nothing is running on this account" and
// write in the same breath. Nothing exported throws: each call answers { ok, code?, ... }.
//
// A second Codex login is kept the same way, in a folder beside these (src/codex-account-home.mjs). It has its own
// names and its own rules for what makes a folder fit, and uses the mechanics of this file for the rest: `spot`,
// `misplaced`, `survey`, `linkOne` and `empty`, which take Claude Code's names unless they are handed others.
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// ---------- what is shared ----------

// What an account folder shares with the user's own Claude Code folder, by name. Two kinds:
//   files     always a link, even before the user has the file. Claude Code then reads nothing there, as it would
//             in the user's folder, and what it writes there lands in the user's own file.
//   folders   a link once the user's folder has it, which is looked at before every launch. Never a link to a
//             folder that is not there: Claude Code fails where it expects to create one.
const FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'];
const FOLDERS = ['projects', 'file-history', 'plans', 'agent-memory', 'skills', 'agents', 'commands', 'rules', 'output-styles'];
/** Every name an account folder may link. Nothing else is ever linked. */
export const LINKS = Object.freeze([...FOLDERS, ...FILES]);
const LATER = new Set(FOLDERS);
// Chats are saved in `projects`. Without that link an account's chats would be kept apart from the rest, out of
// the sidebar and out of reach of the other accounts, so a folder without it is not fit to launch on.
const HISTORY = 'projects';
// If Claude Code made its own copy of one of these while the user's folder had none, the copy stays where it is,
// unshared: moving it would take backups and memories away from the chats that made them. A copy of anything else
// (the user's setup, their chat history) is moved aside for the link: there the user's own is what must apply.
const KEEPS = new Set(['file-history', 'plans', 'agent-memory']);

// What else Claude Code keeps in its folder: per sign-in or per Mac, and so never shared. Listed only so that
// something new stands out (see `strangers`). Nothing is ever done with these names.
const LEFT = [
  'backups', 'cache', 'daemon', 'debug', 'downloads', 'feedback', 'history.jsonl', 'ide', 'jobs', 'local', 'mcp-needs-auth-cache.json',
  'paste-cache', 'plugins', 'policy-limits.json', 'remote-settings.json', 'session-env', 'sessions', 'shell-snapshots', 'spares', 'state',
  'stats-cache.json', 'statsig', 'telemetry', 'todos',
];

// Inside an account folder, Canopy's own two entries: copies Claude Code made where a link belongs, and the
// names of the connectors Canopy copied in (so one removed from the user's config is removed here too).
const KEPT = '.kept';
const NOTE = '.canopy-sync.json';
const CONFIG = '.claude.json';

const FOLDER = /^claude-[a-z0-9]{4,40}$/;
const MAX_CONFIG_BYTES = 256 * 1024 * 1024;

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
const lst = (p) => { try { return lstatSync(p); } catch { return null; } };
const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const exists = (p) => { try { statSync(p); return true; } catch { return false; } };
const isFolder = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** `a` is `b`, or inside it. */
const within = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);

/**
 * Where account folders are kept: ~/.canopy/accounts. A throwaway copy of Canopy (CANOPY_USER_DATA, for automated
 * checks) keeps its own inside its data folder, so it can never touch the real ones.
 * @param {{ home: string, userData?: string | null }} where `userData`: the throwaway copy's data folder, else null
 */
export function accountsRoot({ home, userData = null } = {}) {
  if (isAbs(userData)) return path.join(userData, 'accounts');
  return isAbs(home) ? path.join(home, '.canopy', 'accounts') : null;
}

// An account folder is `<root>/claude-<id>`, written out in full: anything else is not one, whatever it holds.
// (`pattern`: what a folder is called when it is not Claude Code's.)
export function spot(dir, root, pattern = FOLDER) {
  if (!isAbs(dir) || !isAbs(root)) return null;
  const d = path.resolve(dir), r = path.resolve(root);
  return path.dirname(d) === r && pattern.test(path.basename(d)) ? { dir: d, root: r, name: path.basename(d) } : null;
}

// The folder as it is on disk: it must be a real folder (not a link to one) that resolves to a place inside the
// accounts root, and neither inside the user's own Claude Code folder nor around it.
export function misplaced(at, baseHome) {
  const st = lst(at.dir);
  if (!st) return 'missing';
  if (st.isSymbolicLink() || !st.isDirectory()) return 'not-a-folder';
  const realRoot = real(at.root), realDir = real(at.dir);
  if (!realRoot || !realDir || realDir !== path.join(realRoot, at.name)) return 'outside';
  const realBase = isAbs(baseHome) ? real(baseHome) : null;
  if (realBase && (within(realDir, realBase) || within(realBase, realDir))) return 'outside';
  return null;
}

// ---------- links ----------

// One name, as it stands. `due`: a link belongs there now. `state`: what is there instead.
//   linked   the right link            stale   a link to somewhere else, or one that is no longer due
//   absent   nothing                   empty   an empty folder            real   a file, or a folder with something in it
// (`later`: the names that are linked only once the user's folder has them.)
export function survey(dir, baseHome, name, { later = LATER } = {}) {
  const at = path.join(dir, name), to = path.join(baseHome, name);
  const there = exists(to); // through any links of the user's own
  const due = there || !later.has(name);
  const st = lst(at);
  let state = 'absent';
  if (st?.isSymbolicLink()) {
    let target = null;
    try { target = readlinkSync(at); } catch { /* unreadable: treated as pointing elsewhere */ }
    state = target === to && due ? 'linked' : 'stale';
  } else if (st?.isDirectory()) state = readdirSync(at).length ? 'real' : 'empty';
  else if (st) state = 'real';
  return { at, to, there, due, state };
}

// A copy Claude Code made where a link belongs is moved aside inside the account folder, never deleted and never
// merged into the user's own files.
function aside(dir, name) {
  const kept = path.join(dir, KEPT);
  const st = lst(kept);
  if (!st) mkdirSync(kept, { mode: 0o700 });
  else if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${KEPT} is not a folder`);
  renameSync(path.join(dir, name), path.join(kept, `${name}.${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`));
}

// Put one name right. Returns what it is now: 'linked', 'made' (linked by this call), 'displaced' (a copy was in
// the way of a link that must be there: moved aside, link restored), 'waiting' (the user's folder does not have it
// yet), or 'own' (the account keeps a copy of its own).
// (`later` as for `survey`; `keeps`: the names whose copy stays where it is.)
export function linkOne(dir, baseHome, name, { later = LATER, keeps = KEEPS } = {}) {
  const s = survey(dir, baseHome, name, { later });
  if (s.state === 'linked') return 'linked';
  if (s.state === 'stale') unlinkSync(s.at);                      // the link itself; never what it points at
  else if (s.state === 'empty' && s.due) rmdirSync(s.at);         // only ever removes an empty folder
  else if (s.state === 'real' || s.state === 'empty') {
    if (!s.due) return 'waiting';
    if (keeps.has(name)) return 'own';
    aside(dir, name);
    symlinkSync(s.to, s.at);
    return 'displaced';
  }
  if (!s.due) return 'waiting';
  symlinkSync(s.to, s.at);
  return 'made';
}

const report = () => ({ ok: false, code: null, linked: [], made: [], waiting: [], own: [], displaced: [], wrong: [], failed: [] });
// Fit to launch on: everything the user has is linked (their setup's files always are), their chat history included.
function judge(out) {
  const linked = new Set(out.linked);
  out.ok = !out.failed.length && !out.wrong.length && LINKS.every((n) => linked.has(n) || (LATER.has(n) && n !== HISTORY));
  out.code = out.ok ? null : out.failed.length ? 'failed' : out.wrong.length ? 'unlinked' : 'no-history';
  return out;
}
function placed(dir, root, baseHome) {
  const at = spot(dir, root);
  if (!at) return { at: null, code: 'outside' };
  if (!isAbs(baseHome) || !isFolder(baseHome)) return { at, code: 'no-base' };
  return { at, code: misplaced(at, baseHome) };
}

/**
 * Put an account folder's links back as they should be. Does nothing when they already are, so it is called
 * before every launch on the account. Only ever changes entries inside the account folder.
 * @param {{ dir: string, root: string, baseHome: string }} o the account's folder, the accounts root, and the
 *   user's own Claude Code folder (which is only looked at)
 * @returns {{ ok: boolean, code: string | null, linked: string[], made: string[], waiting: string[], own: string[], displaced: string[], failed: string[] }}
 *   `ok`: fit to launch on. `code` when not: 'outside' | 'no-base' | 'missing' | 'not-a-folder' | 'no-history' | 'failed'.
 *   `linked`: in place now. `made`: linked by this call. `displaced`: a copy was in the way; it was moved aside
 *   and the link restored. `waiting`: the user's folder does not have it yet. `own`: the account keeps its own copy.
 */
export function relink({ dir, root, baseHome } = {}) {
  const out = report();
  const { at, code } = placed(dir, root, baseHome);
  if (code) return { ...out, code };
  for (const name of LINKS) {
    let is;
    try { is = linkOne(at.dir, baseHome, name); } catch { out.failed.push(name); continue; }
    if (is === 'waiting' || is === 'own') out[is].push(name);
    else { out.linked.push(name); if (is !== 'linked') out[is].push(name); }
  }
  return judge(out);
}

/**
 * The same look as `relink`, changing nothing. `wrong` lists the names `relink` would put right.
 * @param {{ dir: string, root: string, baseHome: string }} o
 * @returns {{ ok: boolean, code: string | null, linked: string[], waiting: string[], own: string[], wrong: string[] }}
 *   `ok` only when nothing needs putting right; `code` is then also 'unlinked' when something does.
 */
export function health({ dir, root, baseHome } = {}) {
  const out = report();
  const { at, code } = placed(dir, root, baseHome);
  if (code) return { ...out, code };
  for (const name of LINKS) {
    let s;
    try { s = survey(at.dir, baseHome, name); } catch { out.failed.push(name); continue; }
    if (s.state === 'linked') out.linked.push(name);
    else if (s.state === 'stale') out.wrong.push(name);                                   // a link to take away or point elsewhere
    else if (!s.due) out.waiting.push(name);
    else out[s.state === 'real' && KEEPS.has(name) ? 'own' : 'wrong'].push(name);
  }
  return judge(out);
}

/**
 * Make an account's folder (and the accounts root, the first time) and link it. Making one that is already
 * there only puts its links right. Nothing is made when the user's own folder is not there to link to.
 * @param {{ dir: string, root: string, baseHome: string }} o
 * @returns {ReturnType<typeof relink>}
 */
export function create({ dir, root, baseHome } = {}) {
  const at = spot(dir, root);
  if (!at) return { ...report(), code: 'outside' };
  if (!isAbs(baseHome) || !isFolder(baseHome)) return { ...report(), code: 'no-base' };
  if (!isFolder(path.join(baseHome, HISTORY))) return { ...report(), code: 'no-history' };
  try {
    mkdirSync(at.root, { recursive: true, mode: 0o700 });
    if (!lst(at.dir)) mkdirSync(at.dir, { mode: 0o700 });
  } catch { return { ...report(), code: 'failed' }; }
  return relink({ dir, root, baseHome });
}

/**
 * Names in the user's Claude Code folder that Canopy neither links nor knows as Claude Code's own housekeeping:
 * something a newer Claude Code keeps there, which account folders may be missing. Dotfiles are never listed.
 * Reads the folder's names and nothing else.
 * @returns {string[]} at most 24 names
 */
export function strangers(baseHome) {
  try {
    const known = [...LINKS, ...LEFT];
    return readdirSync(baseHome)
      .filter((n) => !n.startsWith('.') && !known.some((k) => n === k || n.startsWith(`${k}.`)))
      .sort().slice(0, 24).map((n) => n.slice(0, 60));
  } catch { return []; }
}

// ---------- connectors and trust ----------

// Of the user's Claude Code config, the two things an account folder needs: the connectors (its own, and each
// project's) and which folders were trusted. Nothing else in the file leaves this function.
function sharedFrom(config) {
  const servers = isPlain(config.mcpServers) ? config.mcpServers : {};
  const projects = {};
  for (const [p, v] of Object.entries(isPlain(config.projects) ? config.projects : {})) {
    if (!isPlain(v) || !path.isAbsolute(p)) continue;
    const own = isPlain(v.mcpServers) ? v.mcpServers : {};
    const trusted = v.hasTrustDialogAccepted === true;
    if (trusted || Object.keys(own).length) projects[p] = { trusted, servers: own };
  }
  return { servers, projects };
}

// A JSON file that holds an object: { found: false } when it is not there, null when it is there but cannot be
// used (not a plain file, too large, not an object, or torn twice running: Claude Code rewrites its config as it runs).
function readJson(file, { follow = false } = {}) {
  let st;
  try { st = follow ? statSync(file) : lstatSync(file); } catch (err) { return err?.code === 'ENOENT' ? { found: false } : null; }
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      return isPlain(value) ? { found: true, value, mode: st.mode & 0o777, mtimeMs: st.mtimeMs, size: st.size } : null;
    } catch { /* torn: once more */ }
  }
  return null;
}

// The user's config changes on every Claude Code launch, but only the two things read from it matter here, so
// it is read again only when the file itself has changed.
const sharedCache = new Map(); // file -> { mtimeMs, size, shared }
function userShared(files) {
  for (const file of files) {
    let st;
    try { st = statSync(file); } catch (err) { if (err?.code === 'ENOENT') continue; return { ok: false }; }
    const hit = sharedCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { ok: true, shared: hit.shared };
    const read = readJson(file, { follow: true });
    if (!read?.found) return { ok: false };
    const shared = sharedFrom(read.value);
    sharedCache.set(file, { mtimeMs: read.mtimeMs, size: read.size, shared });
    return { ok: true, shared };
  }
  return { ok: true, shared: null }; // no config file at all: nothing to copy, and nothing is taken away either
}
/** Test hook: forget what was read of the user's config. */
export function forgetConfig() { sharedCache.clear(); }

// One set of connectors, by name. `want`: the user's. `have`: the account's. `mine`: the names Canopy copied in
// before. The user's win by name; one Canopy copied and the user has since removed goes; one the account got
// some other way (added in a terminal on that account) stays.
function mergeServers(have, want, mine) {
  const next = new Map(Object.entries(isPlain(have) ? have : {}));
  for (const name of mine) if (!Object.hasOwn(want, name)) next.delete(name);
  for (const [name, config] of Object.entries(want)) next.set(name, config);
  return Object.fromEntries(next);
}
const namesOf = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string') : []);

// Work the user's connectors and trust into the account's config (`config` is changed in place). Only
// `mcpServers`, and under `projects` each folder's `mcpServers` and `hasTrustDialogAccepted`, are ever set.
function merge(config, shared, note) {
  let changed = false;
  const servers = mergeServers(config.mcpServers, shared.servers, namesOf(note.servers));
  if (!isDeepStrictEqual(servers, isPlain(config.mcpServers) ? config.mcpServers : {})) { config.mcpServers = servers; changed = true; }
  const noted = isPlain(note.projects) ? note.projects : {};
  for (const p of new Set([...Object.keys(shared.projects), ...Object.keys(noted)])) {
    const want = Object.hasOwn(shared.projects, p) ? shared.projects[p] : { trusted: false, servers: {} };
    const had = isPlain(config.projects) && isPlain(config.projects[p]) ? config.projects[p] : null;
    const own = mergeServers(had?.mcpServers, want.servers, namesOf(noted[p]));
    const trust = want.trusted && had?.hasTrustDialogAccepted !== true;   // trust is only ever added
    const swap = !isDeepStrictEqual(own, isPlain(had?.mcpServers) ? had.mcpServers : {});
    if (!trust && !swap) continue;
    if (!isPlain(config.projects)) config.projects = {};
    const entry = had ?? {};
    if (trust) entry.hasTrustDialogAccepted = true;
    if (swap) entry.mcpServers = own;
    config.projects[p] = entry;
    changed = true;
  }
  return changed;
}
// The connector names Canopy stands behind after a sync.
function noteOf(shared) {
  const projects = {};
  for (const [p, v] of Object.entries(shared.projects)) { const names = Object.keys(v.servers); if (names.length) projects[p] = names; }
  return { v: 1, servers: Object.keys(shared.servers), projects };
}
const bothNotes = (a, b) => {
  const projects = {};
  for (const p of new Set([...Object.keys(isPlain(a.projects) ? a.projects : {}), ...Object.keys(b.projects)])) projects[p] = [...new Set([...namesOf(a.projects?.[p]), ...namesOf(b.projects[p])])];
  return { v: 1, servers: [...new Set([...namesOf(a.servers), ...b.servers])], projects };
};

// A whole file or nothing: written beside the target and renamed over it. The rename replaces a link without
// following it, so nothing outside the folder is ever written through one.
function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try { writeFileSync(tmp, text, { mode, flag: 'wx' }); renameSync(tmp, file); }
  catch (err) { try { unlinkSync(tmp); } catch { /* never made */ } throw err; }
}

/**
 * Bring an account's connectors and trusted folders in line with the user's: one way, key by key, from the user's
 * Claude Code config into the account folder's own. Connector sign-ins are not copied (Claude Code keeps those
 * per sign-in); neither is anything else. The user's config is only read. Does nothing when nothing differs.
 * @param {{
 *   dir: string, root: string, baseHome?: string,
 *   baseConfig: string | string[],   the user's config file, or the places it may be (the first one there is used)
 *   idle?: () => boolean,            is nothing running on this account right now? Asked just before writing:
 *                                    Claude Code rewrites the same file while it runs.
 * }} o
 * @returns {{ ok: true, changed: boolean, pending?: true } | { ok: false, code: string }}
 *   `pending`: something differs, but a process is running on the account, so nothing was written.
 *   `code`: 'outside' | 'missing' | 'not-a-folder' | 'base-unreadable' | 'unreadable' | 'failed'.
 */
export function syncConfig({ dir, root, baseHome, baseConfig, idle = () => true } = {}) {
  try {
    const at = spot(dir, root);
    if (!at) return { ok: false, code: 'outside' };
    const bad = misplaced(at, baseHome);
    if (bad) return { ok: false, code: bad };
    const file = path.join(at.dir, CONFIG), noteFile = path.join(at.dir, NOTE);
    const from = (Array.isArray(baseConfig) ? baseConfig : [baseConfig]).filter(isAbs);
    if (from.some((f) => path.resolve(f) === file)) return { ok: true, changed: false }; // the user's config is this very file
    const user = userShared(from);
    if (!user.ok) return { ok: false, code: 'base-unreadable' }; // never taken to mean "the user has no connectors"
    if (!user.shared) return { ok: true, changed: false };
    const mine = readJson(file), noted = readJson(noteFile);
    if (!mine) return { ok: false, code: 'unreadable' };          // never rewritten from a read that failed
    const config = mine.found ? mine.value : {};
    const before = noted?.found ? noted.value : {};
    const after = noteOf(user.shared);
    const changed = merge(config, user.shared, before);
    if (changed) {
      if (idle() !== true) return { ok: true, changed: false, pending: true };
      // The names are noted before the config is written and trimmed after: whenever this stops halfway, a
      // connector Canopy put in is still known to be Canopy's.
      const both = bothNotes(before, after);
      if (!isDeepStrictEqual(before, both)) writeAtomic(noteFile, JSON.stringify(both), 0o600);
      writeAtomic(file, JSON.stringify(config, null, 2), mine.found ? mine.mode : 0o600);
    }
    const now = readJson(noteFile);
    if (!now?.found || !isDeepStrictEqual(now.value, after)) writeAtomic(noteFile, JSON.stringify(after), 0o600);
    return { ok: true, changed };
  } catch { return { ok: false, code: 'failed' }; }
}

// ---------- removing ----------

// Empty a folder entry by entry. A link is unlinked, never followed; a real folder is emptied first, and only
// after checking that it still resolves to a place inside the accounts root.
export async function empty(folder, realRoot) {
  const here = await realpath(folder);
  if (here === realRoot || !within(here, realRoot)) throw Object.assign(new Error('outside the accounts root'), { code: 'OUTSIDE' });
  for (const name of await readdir(folder)) {
    const p = path.join(folder, name);
    if ((await lstat(p)).isDirectory()) { await empty(p, realRoot); await rmdir(p); }
    else await unlink(p);
  }
}

/**
 * Remove an account folder for good: sign it out through Claude Code, then delete it. What it linked to in the
 * user's own folder is never touched.
 * @param {{
 *   dir: string, root: string, baseHome?: string,
 *   logout?: (o: { dir: string }) => Promise<{ ok: boolean } | void>,   runs `claude auth logout` for this folder
 *   stillSignedIn?: (o: { dir: string }) => Promise<boolean | null>,    asked after: true keeps the folder
 * }} o
 * @returns {Promise<{ ok: true, signedOut: boolean | null } | { ok: false, code: string }>}
 *   `signedOut`: null when Claude Code could not be asked to sign out (the folder was a link, or the run failed
 *   and it did not say afterwards). `code`: 'outside' | 'still-signed-in' | 'failed'.
 */
export async function remove({ dir, root, baseHome, logout, stillSignedIn } = {}) {
  try {
    const at = spot(dir, root);
    if (!at) return { ok: false, code: 'outside' };
    const st = lst(at.dir);
    // Something that is not a folder sits where the account's folder was. A link is unlinked, never followed, and
    // Claude Code is never pointed at it: signing out "there" would sign out wherever the link leads.
    if (st && (st.isSymbolicLink() || !st.isDirectory())) { await unlink(at.dir); return { ok: true, signedOut: null }; }
    // The folder is gone but its sign-in may not be: Claude Code keeps that by the folder's path, so an empty
    // folder is put there for it to sign out of.
    if (!st) {
      if (typeof logout !== 'function') return { ok: true, signedOut: null };
      try { await mkdir(at.dir, { recursive: true, mode: 0o700 }); } catch { return { ok: true, signedOut: null }; }
    }
    if (misplaced(at, baseHome)) return { ok: false, code: 'outside' };
    const realRoot = real(at.root);

    let ran = null;
    if (typeof logout === 'function') { try { ran = (await logout({ dir: at.dir }))?.ok === true; } catch { ran = false; } }
    let still = null;
    if (typeof stillSignedIn === 'function') { try { still = await stillSignedIn({ dir: at.dir }); } catch { still = null; } }
    if (still === true) return { ok: false, code: 'still-signed-in' };

    // Looked at again: signing out ran a process in between.
    if (misplaced(at, baseHome)) return { ok: false, code: 'outside' };
    await empty(at.dir, realRoot);
    await rmdir(at.dir);
    return { ok: true, signedOut: still === false || ran === true ? true : null };
  } catch (err) { return { ok: false, code: err?.code === 'OUTSIDE' ? 'outside' : 'failed' }; }
}

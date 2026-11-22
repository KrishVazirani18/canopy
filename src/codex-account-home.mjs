// Account folders for Codex: where a second Codex login lives.
//
// Codex keeps one login per folder (the one CODEX_HOME names). A login added in Canopy gets a folder of its own
// under ~/.canopy/accounts, beside the folders Claude's extra sign-ins have (src/account-home.mjs), and that folder
// holds the login and nothing else of the user's: their chats, settings, instructions, skills and memories stay in
// their own Codex folder, and the account folder only points at them. An account is a second login, never a second
// setup.
//
// Codex's index of chats (its databases) is not pointed at from here: a process on an account folder is told where
// the user's own index is (CODEX_SQLITE_HOME, see core/accounts-codex.mjs), so every login reads and writes the one
// index. A database inside an account folder therefore means a process ran there without being told, and kept an
// index of its own: such a folder is not launched on again (`databases`).
//
//   create(...)      make an account's folder and its links
//   relink(...)      put the links back as they should be (cheap, and safe before every launch)
//   health(...)      look, change nothing: is the folder fit to launch on?
//   databases(dir)   the databases found in an account folder (there should be none)
//   strangers(...)   names in the user's Codex folder that Canopy does not know
//   remove(...)      sign the folder out, then delete what it holds
//   isHusk, dropHusk what `remove` leaves for the chats still filed under a removed login, and taking that away
//
// Rules this file keeps (each has a test in codex-account-home.test.mjs):
//   - Only the names in LINKS are ever linked. No dotfile is, and nothing Codex keeps per login or per Mac is: its
//     login file and that file's locks, its secrets, its index of chat names, its prompt history, its installation
//     id, its caches, its logs, its plugins.
//   - Nothing is ever created, changed or deleted in the user's own Codex folder.
//   - An account folder is never moved or renamed: Codex files a chat begun there under the folder's path.
//   - Deleting never follows a link, and never touches a path that resolves outside the accounts root.
//   - A chat's file is never deleted. The two links to the user's chats stay behind, in an otherwise empty folder,
//     for as long as a chat is filed under this folder's path.
//
// The mechanics (what a link is, how one is put right, deleting entry by entry) are account-home.mjs's own, used
// here with Codex's names. Everything is synchronous except `remove` and `dropHusk`. Nothing exported throws.
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { accountsRoot, empty, linkOne, misplaced, spot as spotIn, survey } from './account-home.mjs';

export { accountsRoot };

// ---------- what is shared ----------

// What an account folder shares with the user's own Codex folder, by name. Three kinds:
//   REQUIRED    the chats, and the locks that keep two processes from writing one chat at once. A link once the
//               user's folder has them, and a folder without both is not fit to launch on: without the first an
//               account's chats would be kept apart from the rest, and without the second two logins could write
//               the same chat and lose a turn. Never a link to a folder that is not there: Codex will not open a
//               chat when one of these leads nowhere (seen on 0.169.0).
//   ALWAYS      a link even before the user has it. The two files then read as "not there", as they would in the
//               user's folder, and what Codex writes there lands in the user's own file. The link for archived
//               chats may lead nowhere too (Codex opens chats all the same), and keeps a chat that is archived on
//               this login from ever being put inside the account folder.
//   WHEN_THERE  a link once the user's folder has it, which is looked at before every launch.
const REQUIRED = ['sessions', 'thread-writer-locks'];
const ALWAYS = ['archived_sessions', 'config.toml', 'AGENTS.md'];
const WHEN_THERE = ['mcp-oauth-locks', 'skills', 'rules', 'memories', 'memories_v2', 'memories_extensions', 'memories.lock', 'memories_v2.lock'];
/** Every name an account folder may link. Nothing else is ever linked. */
export const LINKS = Object.freeze([...REQUIRED, ...ALWAYS, ...WHEN_THERE]);
/** Where chats are: what `remove` leaves in place while a chat is filed under the folder. */
export const HISTORY = Object.freeze(['sessions', 'archived_sessions']);
// A copy of these that Codex made inside the account folder stays where it is. Chats: it would be the only copy
// (and a folder holding one is not launched on: see `judge`). Memories: moving them aside would take them away
// from the chats that made them. A copy of anything else is moved aside for the link: there the user's own is
// what must apply.
const KEEPS = new Set([...HISTORY, 'memories', 'memories_v2', 'memories_extensions']);
const NAMES = Object.freeze({ later: new Set([...REQUIRED, ...WHEN_THERE]), keeps: KEEPS });

// What else is found in a Codex folder, and so never shared. Listed only so that something new stands out (see
// `strangers`). Nothing is ever done with these names. (A name also covers what is written beside it: `auth.json`
// covers `auth.json.lock`.) Three groups: what Codex keeps per login or per Mac; what the Codex app keeps there;
// and parts of the user's own setup that are not shared yet, because nobody has seen what Codex does with them
// on an account folder.
const LEFT = [
  'auth.json', 'auth.lock', 'secrets', 'session_index.jsonl', 'history.jsonl', 'installation_id', 'models_cache.json',
  'cache', 'log', 'tmp', 'shell_snapshots', 'rollout-migrations', 'plugins', 'sqlite', 'version.json',
  'ambient-suggestions', 'attachments', 'automations', 'browser', 'chrome-native-hosts.json', 'chrome-native-hosts-v2.json', 'code-review-plugin',
  'computer-use', 'dictation-history', 'external_agent_session_imports.json', 'generated_images', 'ipc', 'node_repl', 'pets', 'process_manager',
  'project-metadata-locks', 'resource_guards',
  'agents', 'hooks.json', 'keybindings.json', 'plans', 'prompts',
];

const FOLDER = /^codex-[a-z0-9]{4,40}$/;
// One of Codex's databases, or what SQLite writes beside one while it is open.
const DATABASE = /\.sqlite(?:-[a-z]+)?$/i;

const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
const lst = (p) => { try { return lstatSync(p); } catch { return null; } };
const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const isFolder = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** `a` is `b`, or inside it. */
const within = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);

// An account folder is `<root>/codex-<id>`, written out in full: anything else is not one, whatever it holds.
const spot = (dir, root) => spotIn(dir, root, FOLDER);

// ---------- links ----------

/**
 * The databases in an account folder, by name (at most 12). There should be none: Codex is told to keep its index
 * in the user's own folder. One that is here was made by a process that ran on this folder without being told, so
 * chats begun then are in an index nothing else reads.
 * @returns {string[]}
 */
export function databases(dir) {
  try { return readdirSync(dir).filter((n) => DATABASE.test(n)).sort().slice(0, 12); } catch { return []; }
}

const report = () => ({ ok: false, code: null, linked: [], made: [], waiting: [], own: [], displaced: [], wrong: [], failed: [], databases: [] });
// Fit to launch on: the user's chats and the writer locks are linked, so is everything of their setup that they
// have, and the folder keeps neither chats nor an index of its own.
function judge(out) {
  const linked = new Set(out.linked);
  const forked = out.databases.length > 0 || out.own.some((n) => HISTORY.includes(n));
  const missing = [...REQUIRED, ...ALWAYS].filter((n) => !linked.has(n));
  out.ok = !out.failed.length && !out.wrong.length && !forked && !missing.length;
  out.code = out.ok ? null : out.failed.length ? 'failed' : forked ? 'forked' : out.wrong.length ? 'unlinked'
    : missing.includes('sessions') ? 'no-history' : missing.includes('thread-writer-locks') ? 'no-locks' : 'unlinked';
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
 *   user's own Codex folder (which is only looked at)
 * @returns {{ ok: boolean, code: string | null, linked: string[], made: string[], waiting: string[], own: string[], displaced: string[], wrong: string[], failed: string[], databases: string[] }}
 *   `ok`: fit to launch on. `code` when not: 'outside' | 'no-base' | 'missing' | 'not-a-folder' | 'no-history' (the
 *   user's folder has no chats yet) | 'no-locks' (nor the writer locks) | 'forked' (the folder keeps chats or an
 *   index of its own) | 'unlinked' | 'failed'.
 *   `linked`: in place now. `made`: linked by this call. `displaced`: a copy was in the way; it was moved aside
 *   and the link restored. `waiting`: the user's folder does not have it yet. `own`: the account keeps its own copy.
 *   `databases`: the databases found in the folder.
 */
export function relink({ dir, root, baseHome } = {}) {
  const out = report();
  const { at, code } = placed(dir, root, baseHome);
  if (code) return { ...out, code };
  for (const name of LINKS) {
    let is;
    try { is = linkOne(at.dir, baseHome, name, NAMES); } catch { out.failed.push(name); continue; }
    if (is === 'waiting' || is === 'own') out[is].push(name);
    else { out.linked.push(name); if (is !== 'linked') out[is].push(name); }
  }
  out.databases = databases(at.dir);
  return judge(out);
}

/**
 * The same look as `relink`, changing nothing. `wrong` lists the names `relink` would put right.
 * @param {{ dir: string, root: string, baseHome: string }} o
 * @returns {ReturnType<typeof relink>} `ok` only when nothing needs putting right
 */
export function health({ dir, root, baseHome } = {}) {
  const out = report();
  const { at, code } = placed(dir, root, baseHome);
  if (code) return { ...out, code };
  for (const name of LINKS) {
    let s;
    try { s = survey(at.dir, baseHome, name, NAMES); } catch { out.failed.push(name); continue; }
    if (s.state === 'linked') out.linked.push(name);
    else if (s.state === 'stale') out.wrong.push(name);                                   // a link to take away or point elsewhere
    else if (!s.due) out.waiting.push(name);
    else out[s.state === 'real' && KEEPS.has(name) ? 'own' : 'wrong'].push(name);
  }
  out.databases = databases(at.dir);
  return judge(out);
}

/**
 * Make an account's folder (and the accounts root, the first time) and link it. Making one that is already
 * there only puts its links right. Nothing is made when the user's own folder is not there to link to, or has no
 * chats yet: a login with nowhere to keep its chats is not worth a folder.
 * @param {{ dir: string, root: string, baseHome: string }} o
 * @returns {ReturnType<typeof relink>}
 */
export function create({ dir, root, baseHome } = {}) {
  const at = spot(dir, root);
  if (!at) return { ...report(), code: 'outside' };
  if (!isAbs(baseHome) || !isFolder(baseHome)) return { ...report(), code: 'no-base' };
  if (!isFolder(path.join(baseHome, 'sessions'))) return { ...report(), code: 'no-history' };
  if (!isFolder(path.join(baseHome, 'thread-writer-locks'))) return { ...report(), code: 'no-locks' };
  try {
    mkdirSync(at.root, { recursive: true, mode: 0o700 });
    if (!lst(at.dir)) mkdirSync(at.dir, { mode: 0o700 });
  } catch { return { ...report(), code: 'failed' }; }
  return relink({ dir, root, baseHome });
}

/**
 * Names in the user's Codex folder that Canopy neither links nor knows as something Codex or its app keeps there:
 * something a newer Codex has started to keep, which account folders may be going without. Dotfiles and databases
 * are never listed. Reads the folder's names and nothing else.
 * @returns {string[]} at most 24 names
 */
export function strangers(baseHome) {
  try {
    const known = [...LINKS, ...LEFT];
    return readdirSync(baseHome)
      .filter((n) => !n.startsWith('.') && !n.includes('.sqlite') && !known.some((k) => n === k || n.startsWith(`${k}.`)))
      .sort().slice(0, 24).map((n) => n.slice(0, 60));
  } catch { return []; }
}

// ---------- removing ----------

const outside = () => Object.assign(new Error('outside the accounts root'), { code: 'OUTSIDE' });

// Delete what an account folder holds, entry by entry, except where its chats are: a link to the user's chats is
// left for now (see `remove`), and a real folder of chats in such a link's place is left for good. Answers what
// was left: [{ name, link }].
async function clear(dir, realRoot) {
  const here = await realpath(dir);
  if (here === realRoot || !within(here, realRoot)) throw outside();
  const left = [];
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    const st = await lstat(p);
    if (HISTORY.includes(name)) {
      if (st.isSymbolicLink()) { left.push({ name, link: true }); continue; }
      if (st.isDirectory() && (await readdir(p)).length) { left.push({ name, link: false }); continue; }
    }
    if (st.isDirectory()) { await empty(p, realRoot); await rmdir(p); }
    else await unlink(p);
  }
  return left;
}

// A folder of Canopy's that holds nothing but links to the user's chats (or nothing at all): what is left of a
// removed login while chats are still filed under it.
function huskAt(dir, root, baseHome) {
  const at = spot(dir, root);
  if (!at || misplaced(at, baseHome)) return null;
  try {
    const names = readdirSync(at.dir);
    return names.every((n) => HISTORY.includes(n) && lstatSync(path.join(at.dir, n)).isSymbolicLink()) ? { at, names } : null;
  } catch { return null; }
}

/**
 * Is this folder what `remove` leaves behind: one of Canopy's, holding only the links to the user's chats?
 * @param {{ dir: string, root: string, baseHome?: string }} o
 */
export function isHusk({ dir, root, baseHome } = {}) { return huskAt(dir, root, baseHome) !== null; }

/**
 * Take away what `remove` left behind, now that no chat is filed under it. Only ever unlinks the two links and
 * removes the empty folder: a folder that holds anything else is left exactly as it is.
 * @param {{ dir: string, root: string, baseHome?: string }} o
 * @returns {Promise<{ ok: boolean }>}
 */
export async function dropHusk({ dir, root, baseHome } = {}) {
  try {
    const husk = huskAt(dir, root, baseHome);
    if (!husk) return { ok: false };
    for (const name of husk.names) await unlink(path.join(husk.at.dir, name));
    await rmdir(husk.at.dir);
    return { ok: true };
  } catch { return { ok: false }; }
}

/**
 * Remove an account folder: have Codex sign it out, then delete what it holds. What it linked to in the user's
 * own folder is never touched.
 *
 * The two links to the user's chats are the exception. A chat begun on this login is filed in Codex's index under
 * this folder's path, and Codex goes by that path: with the links gone such a chat would drop out of Codex's list
 * and could not be opened, though its file is still in the user's own folder. So the links stay, in an otherwise
 * empty folder, until `referenced` says no chat is filed under it (the caller looks again later: `dropHusk`).
 * A real folder of chats in a link's place is never deleted: it would be the only copy of those chats.
 * @param {{
 *   dir: string, root: string, baseHome?: string,
 *   logout?: (o: { dir: string }) => Promise<{ ok: boolean } | void>,   has Codex sign this folder out
 *   stillSignedIn?: (o: { dir: string }) => Promise<boolean | null>,    asked after: true keeps the folder
 *   referenced?: (o: { dir: string }) => Promise<boolean | null>,       is a chat filed under this folder? Only a
 *                                                                       plain "no" lets the links go
 * }} o
 * @returns {Promise<{ ok: true, signedOut: boolean | null, kept: boolean } | { ok: false, code: string }>}
 *   `signedOut`: null when Codex was not asked to sign out, or could not say afterwards. `kept`: the folder is
 *   still there, holding only where its chats are. `code`: 'outside' | 'still-signed-in' | 'failed'.
 */
export async function remove({ dir, root, baseHome, logout, stillSignedIn, referenced } = {}) {
  try {
    const at = spot(dir, root);
    if (!at) return { ok: false, code: 'outside' };
    const st = lst(at.dir);
    // Something that is not a folder sits where the account's folder was. A link is unlinked, never followed, and
    // Codex is never pointed at it: signing out "there" would sign out wherever the link leads.
    if (st && (st.isSymbolicLink() || !st.isDirectory())) { await unlink(at.dir); return { ok: true, signedOut: null, kept: false }; }
    // The folder is gone, but Codex can keep a login in the Keychain, filed under the folder's path: an empty
    // folder is put there for it to sign out of.
    if (!st) {
      if (typeof logout !== 'function') return { ok: true, signedOut: null, kept: false };
      try { await mkdir(at.dir, { recursive: true, mode: 0o700 }); } catch { return { ok: true, signedOut: null, kept: false }; }
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
    const left = await clear(at.dir, realRoot);
    const signedOut = still === false || ran === true ? true : null;
    if (left.some((x) => !x.link)) return { ok: true, signedOut, kept: true };
    let filed = null;
    if (typeof referenced === 'function') { try { filed = await referenced({ dir: at.dir }); } catch { filed = null; } }
    if (filed !== false) return { ok: true, signedOut, kept: true }; // a chat is filed here, or nobody could say
    return { ok: true, signedOut, kept: !(await dropHusk({ dir: at.dir, root: at.root, baseHome })).ok };
  } catch (err) { return { ok: false, code: err?.code === 'OUTSIDE' ? 'outside' : 'failed' }; }
}

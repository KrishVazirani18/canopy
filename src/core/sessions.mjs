// Saved conversations: listing, lookup and the few mutations the UI offers.
// Nothing here throws. Lists come back empty on failure; mutations answer
// { ok: true, … } or { ok: false, code, message }.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { isSessionId } from './env.mjs';

const TTL_MS = 1500;
const MAX_TITLE = 200;
const MAX_CACHE = 64;

const isDirPath = (d) => typeof d === 'string' && d.length > 0 && d.length < 4096 && !d.includes('\0') && path.isAbsolute(d);
const fail = (code, message) => ({ ok: false, code, message });
const messageOf = (err) => String(err?.message ?? err).slice(0, 300);
const codeOf = (err) => (/not found|no such|ENOENT/i.test(messageOf(err)) ? 'not-found' : 'failed');
const dirOpt = (dir) => (isDirPath(dir) ? { dir } : {});

const oneLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '');

/** @returns {{id: string, title: string, updated: number, created: number|null, branch: string|null, cwd: string|null, tag: string|null, size: number|null, sessionCwd: string|null}} */
function toRow(s, dir) {
  return {
    id: s.sessionId,
    title: oneLine(s.customTitle) || oneLine(s.summary) || oneLine(s.firstPrompt) || 'Untitled chat',
    updated: Number.isFinite(s.lastModified) ? s.lastModified : 0,
    created: Number.isFinite(s.createdAt) ? s.createdAt : null,
    branch: s.gitBranch ?? null,
    // The folder the session is listed under (what the UI groups by). A session found through a
    // git worktree keeps where it actually ran in `sessionCwd`.
    cwd: dir ?? s.cwd ?? null,
    tag: s.tag ?? null,
    size: Number.isFinite(s.fileSize) ? s.fileSize : null,
    sessionCwd: typeof s.cwd === 'string' ? s.cwd : null,
  };
}

// Listing with worktrees makes the SDK shell out to git for every folder. Only pay for that
// when the folder is a linked worktree itself or has some.
function hasWorktrees(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    if (statSync(dotGit).isFile()) return true;
    return readdirSync(path.join(dotGit, 'worktrees')).length > 0;
  } catch { return false; }
}

const cache = new Map();          // key -> { at: number|null, promise }

function cached(key, load) {
  const hit = cache.get(key);
  if (hit && (hit.at === null || Date.now() - hit.at < TTL_MS)) return hit.promise;
  const entry = { at: null, promise: null };
  entry.promise = load().catch(() => []).then((rows) => { entry.at = Date.now(); return rows; });
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return entry.promise;
}

const clampInt = (v, min, max, dflt) => (Number.isInteger(v) && v >= min ? Math.min(v, max) : dflt);

/**
 * Sessions saved for one folder, newest first.
 * @param {string} dir
 * @param {{limit?: number, offset?: number}} [opts]
 */
export async function list(dir, { limit = 60, offset = 0 } = {}) {
  if (!isDirPath(dir) || typeof sdk.listSessions !== 'function') return [];
  const lim = clampInt(limit, 1, 1000, 60), off = clampInt(offset, 0, 1e6, 0);
  const rows = await cached(`${dir}\0${lim}\0${off}`, async () => {
    const found = await sdk.listSessions({ dir, limit: lim, offset: off, includeWorktrees: hasWorktrees(dir) });
    return (Array.isArray(found) ? found : []).filter((s) => isSessionId(s?.sessionId)).map((s) => toRow(s, dir));
  });
  return rows.map((r) => ({ ...r }));
}

/**
 * Sessions across several folders, newest first. Concurrent calls share one scan and results are
 * reused for 1.5 s, so a burst of refreshes costs one read.
 * @param {string[]} dirs
 * @param {{limit?: number}} [opts] per-folder limit
 */
export async function listAll(dirs, { limit = 60 } = {}) {
  try {
    const unique = [...new Set((Array.isArray(dirs) ? dirs : [dirs]).filter(isDirPath))];
    const lists = await Promise.all(unique.map((d) => list(d, { limit })));
    // A worktree session can be reachable from two listed folders. Keep the one listed where it ran.
    const byId = new Map();
    for (const row of lists.flat()) {
      const prev = byId.get(row.id);
      if (!prev || (prev.sessionCwd !== prev.cwd && row.sessionCwd === row.cwd)) byId.set(row.id, row);
    }
    return [...byId.values()].sort((a, b) => b.updated - a.updated);
  } catch { return []; }
}

/** Metadata for one session, or null when it does not exist (or is not a conversation of its own). */
export async function info(id, dir) {
  try {
    if (!isSessionId(id) || typeof sdk.getSessionInfo !== 'function') return null;
    const s = await sdk.getSessionInfo(id, dirOpt(dir));
    return s ? toRow(s, isDirPath(dir) ? dir : null) : null;
  } catch { return null; }
}

/**
 * Can this session be resumed from `dir`? True only when its transcript is on disk and holds a
 * conversation, which is what `--resume` needs.
 */
export async function exists(id, dir) {
  try {
    if (!isSessionId(id)) return false;
    if (await info(id, dir)) return true;
    // No summary yet (a very young session): fall back to reading the transcript itself.
    if (typeof sdk.getSessionMessages !== 'function') return false;
    const first = await sdk.getSessionMessages(id, { ...dirOpt(dir), limit: 1 });
    return Array.isArray(first) && first.length > 0;
  } catch { return false; }
}

async function mutate(id, dir, fn, call) {
  if (!isSessionId(id)) return fail('invalid-input', 'Not a session id.');
  if (dir != null && !isDirPath(dir)) return fail('invalid-input', 'The folder must be an absolute path.');
  if (typeof sdk[fn] !== 'function') return fail('unsupported', `This version of Claude Code cannot do that (${fn}).`);
  // A session can be listed under more than one folder (worktrees), so every cached list is dropped.
  try {
    const result = await call(dirOpt(dir));
    cache.clear();
    return { ok: true, ...result };
  } catch (err) {
    cache.clear();
    return fail(codeOf(err), messageOf(err));
  }
}

export function rename(id, title, dir) {
  const clean = oneLine(title);
  if (!clean) return Promise.resolve(fail('invalid-input', 'A title cannot be empty.'));
  return mutate(id, dir, 'renameSession', async (o) => { await sdk.renameSession(id, clean, o); return { title: clean }; });
}

/** Set a session's tag, or clear it with null or an empty string. */
export function tag(id, t, dir) {
  if (t != null && typeof t !== 'string') return Promise.resolve(fail('invalid-input', 'A tag must be text.'));
  const clean = oneLine(t ?? '').slice(0, 64) || null;
  return mutate(id, dir, 'tagSession', async (o) => { await sdk.tagSession(id, clean, o); return { tag: clean }; });
}

/** Delete a session's transcript from this computer. The caller must make sure it is not open. */
export async function remove(id, dir) {
  const r = await mutate(id, dir, 'deleteSession', async (o) => { await sdk.deleteSession(id, o); return {}; });
  if (r.ok || r.code === 'invalid-input' || r.code === 'unsupported') return r;
  // The SDK deletes the transcript first and can then fail on the subagent folder. The session is gone either way.
  if (r.code !== 'not-found' && !(await info(id, dir))) return { ok: true, partial: true, message: r.message };
  return r;
}

/**
 * Copy a session into a new one, optionally only up to (and including) one message.
 * @param {{upToMessageId?: string, title?: string}} [opts]
 * @returns {Promise<{ok: true, sessionId: string, from: string} | {ok: false, code: string, message: string}>}
 */
export function fork(id, dir, { upToMessageId, title } = {}) {
  if (upToMessageId != null && !isSessionId(upToMessageId)) return Promise.resolve(fail('invalid-input', 'Not a message id.'));
  return mutate(id, dir, 'forkSession', async (o) => {
    const cleanTitle = oneLine(title);
    const r = await sdk.forkSession(id, { ...o, ...(upToMessageId && { upToMessageId }), ...(cleanTitle && { title: cleanTitle }) });
    if (!isSessionId(r?.sessionId)) throw new Error('The fork did not return a session id.');
    return { sessionId: r.sessionId, from: id };
  });
}

/** Forget cached lists, for one folder or for all of them. Mutations here do it themselves. */
export function invalidate(dir) {
  if (!isDirPath(dir)) return cache.clear();
  for (const key of [...cache.keys()]) if (key.startsWith(`${dir}\0`)) cache.delete(key);
}

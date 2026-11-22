// The saved conversation as Claude Code writes it: one .jsonl per session, one row per line, each row naming the
// row it follows (parentUuid). The SDK's readers hand back the messages but not those links, and the links are what
// an edit needs: where to cut, and what the cut throws away.
//
// A conversation that was cut back keeps its old rows in the file, on a branch nothing follows any more. The rows
// that count are the ones the newest row leads back to (liveUuids).
//
// Read-only. Nothing here ever writes a transcript.
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How Claude Code names a project's folder under `projects`: the folder's full path, every character that is not a
 *  letter or a digit made a dash. (It shortens a very long one in a way this does not copy: see transcriptFile.) */
export const projectSlug = (dir) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
/** Where Claude Code keeps a project's chats, given its own folder (`configDir`, ~/.claude unless moved). */
export const projectFolder = (dir, configDir) => path.join(configDir, 'projects', projectSlug(dir));
const exists = (file) => access(file).then(() => true, () => false);
const configDir = (env) => (typeof env?.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), '.claude'));

/** Where Claude Code keeps this session, or null. The folder is tried as given and as the disk spells it (/tmp is /private/tmp). */
export async function transcriptFile(sessionId, cwd, env) {
  if (!UUID_RE.test(String(sessionId)) || typeof cwd !== 'string' || !cwd) return null;
  const projects = path.join(configDir(env), 'projects');
  const name = `${sessionId}.jsonl`;
  const dirs = new Set([projectSlug(cwd), projectSlug(await realpath(cwd).catch(() => cwd))]);
  for (const d of dirs) {
    const file = path.join(projects, d, name);
    if (await exists(file)) return file;
  }
  // A very long folder name is shortened by Claude Code in a way we don't copy: look for the session by its id.
  try {
    for (const d of await readdir(projects)) {
      const file = path.join(projects, d, name);
      if (!dirs.has(d) && await exists(file)) return file;
    }
  } catch { /* no projects folder */ }
  return null;
}

/** The rows of a transcript that are part of a conversation (they have a uuid), in the order they were written. */
export function parseRows(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line || !line.includes('"uuid"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // a line caught mid-write
    if (r && typeof r.uuid === 'string') rows.push(r);
  }
  return rows;
}

/** A session's rows, or null when it has no saved file (yet). */
export async function transcriptRows(sessionId, cwd, env) {
  const file = await transcriptFile(sessionId, cwd, env);
  if (!file) return null;
  try { return parseRows(await readFile(file, 'utf8')); } catch { return null; }
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');

/** A user row that is something said to Claude (you, or anything else that speaks in your place), as opposed to a
 *  tool's result, a note Claude Code wrote for the model, or the mark an interrupt leaves. */
function isSaid(r) {
  if (r?.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary || r.toolUseResult !== undefined) return false;
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return false;
  return !textOf(c).trimStart().startsWith('[Request interrupted');
}

const isBoundary = (r) => r?.isCompactSummary === true || (r?.type === 'system' && r.subtype === 'compact_boundary');

/**
 * Where to cut so the message `messageId` and everything after it is gone, or null when the message isn't saved.
 *   at         the last row to keep (what the message followed); null when nothing comes before it
 *   first      nothing was said before it: it is the conversation's first message
 *   alone      nothing else was said after it: what the cut drops is that one message's turn and nothing more
 *   compacted  the conversation was summarized after it, so cutting there would bring the long history back
 *   blocks     the message's own attachments (images, documents), to send again with the new text
 */
export function cutPoint(rows, messageId) {
  const i = (rows ?? []).findIndex((r) => r.uuid === messageId);
  if (i < 0) return null;
  const row = rows[i];
  const later = rows.slice(i + 1);
  const content = row.message?.content;
  return {
    at: typeof row.parentUuid === 'string' && row.parentUuid ? row.parentUuid : null,
    first: !rows.slice(0, i).some(isSaid),
    alone: !later.some(isSaid),
    compacted: later.some(isBoundary),
    blocks: Array.isArray(content) ? content.filter((b) => b?.type === 'image' || b?.type === 'document') : [],
  };
}

/**
 * The uuids of the rows the conversation consists of now: from the newest row back to the first, the way Claude Code
 * loads it. A summarized conversation keeps going past the summary (logicalParentUuid), so its earlier messages
 * still count. Null when the links can't be followed (an old transcript without them): treat every row as live.
 */
export function liveUuids(rows) {
  const by = new Map();
  let leaf = null;
  for (const r of rows ?? []) {
    by.set(r.uuid, r);
    if (!r.isSidechain) leaf = r;
  }
  if (!leaf) return null;
  const live = new Set();
  for (let r = leaf; r && !live.has(r.uuid); r = by.get(r.parentUuid ?? r.logicalParentUuid)) live.add(r.uuid);
  return live;
}

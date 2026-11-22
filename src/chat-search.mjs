// Search inside every chat: what you and Canopy actually said, not just titles.
// Reads Claude Code's transcripts (~/.claude/projects/<folder>/<session>.jsonl) for the given folders, keeps each one's
// plain text cached by modified time (so typing stays fast), and returns the best matches with a snippet around the hit.
// Read-only. Tool calls, thinking and bookkeeping rows are skipped: only the conversation itself is searched.
// So are messages that an edit took out of a conversation: they stay in the file, but nothing shows them any more.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { configHome } from './core/env.mjs';
import { liveUuids, projectFolder } from './core/transcript.mjs';
import { stripLeads } from './core/notes.mjs';

const cache = new Map(); // file -> { mtime, messages: [{ role, text, at, uuid }] }
const MAX_FILE = 40 * 1024 * 1024; // skip anything enormous

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

async function messagesOf(file) {
  let st;
  try { st = await stat(file); } catch { return []; }
  if (st.size > MAX_FILE) return [];
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.messages;
  const messages = [];
  const links = []; // every row's place in the conversation, to tell what an edit cut away
  let raw = '';
  try { raw = await readFile(file, 'utf8'); } catch { return []; }
  for (const line of raw.split('\n')) {
    if (!line || !line.includes('"uuid"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (typeof r.uuid === 'string') links.push({ uuid: r.uuid, parentUuid: r.parentUuid ?? null, logicalParentUuid: r.logicalParentUuid ?? null, isSidechain: !!r.isSidechain });
    if (r.isSidechain || r.isMeta) continue;
    const role = r.type === 'user' ? 'you' : r.type === 'assistant' ? 'canopy' : null;
    if (!role) continue;
    // What Canopy put first in a message for the model only (a note, a moved chat's digest) is not what was said.
    const text = stripLeads(textOf(r.message?.content)).trim();
    // Skip machine text that rides in user rows (tool results, reminders, command output).
    if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) continue;
    messages.push({ role, text, at: Date.parse(r.timestamp ?? '') || 0, uuid: r.uuid ?? null });
  }
  // Only what the conversation consists of now: a message you edited, and the replies to it, are no longer part of it.
  const live = liveUuids(links);
  const kept = live ? messages.filter((m) => !m.uuid || live.has(m.uuid)) : messages;
  cache.set(file, { mtime: st.mtimeMs, messages: kept });
  return kept;
}

/** A short excerpt around the first hit, cut at word boundaries. */
function snippet(text, at, len) {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(text.toLowerCase().slice(at, at + len).replace(/\s+/g, ' '));
  const pos = i >= 0 ? i : 0;
  let from = Math.max(0, pos - 60), to = Math.min(flat.length, pos + len + 90);
  if (from > 0) from = flat.indexOf(' ', from) + 1 || from;
  if (to < flat.length) { const sp = flat.lastIndexOf(' ', to); if (sp > pos + len) to = sp; }
  return { text: (from > 0 ? '…' : '') + flat.slice(from, to) + (to < flat.length ? '…' : ''), match: { from: pos - from + (from > 0 ? 1 : 0), length: len } };
}

/**
 * @param {string} query
 * @param {string[]} dirs folders whose chats to search
 * @returns {Promise<{ sessionId: string, cwd: string, role: string, at: number, uuid: string | null, snippet: string, match: { from: number, length: number } }[]>}
 */
export async function searchChats(query, dirs, { limit = 30, skip, configDir = configHome() } = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  const needle = q.toLowerCase();
  const hits = [];
  for (const dir of new Set(dirs.filter(Boolean))) {
    const folder = projectFolder(dir, configDir);
    let files = [];
    try { files = (await readdir(folder)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const sessionId = f.slice(0, -6);
      if (skip?.has(sessionId)) continue; // a conversation an edit replaced (see main.mjs `superseded`)
      const msgs = await messagesOf(path.join(folder, f));
      // Newest message first within a chat; one hit per message, at most three per chat so one chat can't flood it.
      let n = 0;
      for (let i = msgs.length - 1; i >= 0 && n < 3; i--) {
        const m = msgs[i];
        const at = m.text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const s = snippet(m.text, at, q.length);
        hits.push({ sessionId, cwd: dir, role: m.role, at: m.at, uuid: m.uuid, snippet: s.text, match: s.match });
        n++;
      }
    }
  }
  return hits.sort((a, b) => b.at - a.at).slice(0, limit);
}

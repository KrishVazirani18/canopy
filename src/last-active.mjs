// When a chat was last really used: the timestamp of its last message, not the file's modified time.
// Claude Code appends bookkeeping rows (cost, mode, last-prompt) when a chat's process starts or stops, which bumps
// the file's mtime; Canopy keeps chats alive in the background, so mtime made untouched chats jump to the top.
// Message rows carry a "timestamp"; bookkeeping rows don't. Reads only the file's tail, and caches by mtime.
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { configHome } from './core/env.mjs';
import { projectFolder } from './core/transcript.mjs';

const cache = new Map(); // file -> { mtime, at }
const TAIL = 256 * 1024;

export async function lastActive(sessionId, dir, configDir = configHome()) {
  const file = path.join(projectFolder(dir, configDir), `${sessionId}.jsonl`);
  try {
    const st = await stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.at;
    const fh = await open(file, 'r');
    try {
      const len = Math.min(TAIL, st.size);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      const text = buf.toString('utf8');
      // The last "timestamp" in the tail belongs to the last message row.
      const all = [...text.matchAll(/"timestamp":"([^"]+)"/g)];
      const at = all.length ? Date.parse(all[all.length - 1][1]) : NaN;
      const value = Number.isFinite(at) ? at : null;
      cache.set(file, { mtime: st.mtimeMs, at: value });
      return value;
    } finally { await fh.close(); }
  } catch { return null; }
}

// When you last wrote to a chat: the timestamp of your last message. The sidebar orders by this, so chats only move
// when you send something, never because Claude replied, finished, or a helper reported back while you watch another.
// Your messages are user rows with origin.kind "human"; tool results, task notifications and interrupt markers are
// user rows too, and transcripts from before Claude Code wrote "origin" fall back to plain typed text.
const CHUNK = 512 * 1024;

function isYours(line) {
  if (!line.includes('"type":"user"')) return null;
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row.type !== 'user' || row.isMeta || row.isSidechain || row.toolUseResult !== undefined) return null;
  const kind = row.origin?.kind;
  if (kind && kind !== 'human') return null;
  if (!kind) {
    const c = row.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text ?? (c.some((b) => b?.type === 'image') ? 'image' : '') : '';
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return null;
    if (!text.trim() || text.startsWith('<') || text.startsWith('[Request interrupted')) return null;
  }
  const at = Date.parse(row.timestamp);
  return Number.isFinite(at) ? at : null;
}

/** A reply's first real line as plain words, for the sidebar's second line ("Fixed: the link opens…"). */
export function previewOf(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(```|---|\|)/.test(l));
  // A heading ("## Done") says less than the sentence under it, so the first plain line wins when there is one.
  const first = (lines.find((l) => !l.startsWith('#')) ?? lines[0] ?? '').replace(/^#+\s*|^[-*>]\s+|^\d+\.\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return first ? (first.length > 160 ? first.slice(0, 159) + '…' : first) : null;
}

function replyOf(line) {
  if (!line.includes('"type":"assistant"')) return null;
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row.type !== 'assistant' || row.isSidechain || row.isApiErrorMessage) return null;
  const c = row.message?.content;
  const text = Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : typeof c === 'string' ? c : '';
  return previewOf(text);
}

/** The last line in bytes [from, to) of the file that `pick` turns into a value, reading backwards a chunk at a time. */
async function lastIn(fh, from, to, pick) {
  let end = to;
  let carry = ''; // the start of a line cut by the chunk boundary
  while (end > from) {
    const start = Math.max(from, end - CHUNK);
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = (buf.toString('utf8') + carry).split('\n');
    carry = start > from ? lines.shift() : '';
    for (let i = lines.length - 1; i >= 0; i--) { const v = pick(lines[i]); if (v != null) return v; }
    end = start;
  }
  return carry ? pick(carry) : null;
}

/** A reader for "the last row like this" in a chat's transcript. Cached by size: a growing transcript (a chat that's
 *  working) is only read from where the last read stopped; a line caught mid-write is read again once complete. */
function lastOf(pick) {
  const cache = new Map(); // file -> { size, value, scanned }
  return async (sessionId, dir, configDir = configHome()) => {
    const file = path.join(projectFolder(dir, configDir), `${sessionId}.jsonl`);
    try {
      const st = await stat(file);
      const hit = cache.get(file);
      if (hit && hit.size === st.size) return hit.value;
      const fh = await open(file, 'r');
      try {
        const value = hit && st.size > hit.size ? (await lastIn(fh, hit.scanned, st.size, pick)) ?? hit.value : await lastIn(fh, 0, st.size, pick);
        const tail = Buffer.alloc(Math.min(CHUNK, st.size));
        await fh.read(tail, 0, tail.length, st.size - tail.length);
        const nl = tail.lastIndexOf(0x0a);
        const scanned = nl === -1 ? (hit?.scanned ?? 0) : st.size - tail.length + nl + 1;
        cache.set(file, { size: st.size, value, scanned });
        return value;
      } finally { await fh.close(); }
    } catch { return null; }
  };
}

/** When you last wrote to the chat (ms), or null. */
export const lastPrompt = lastOf(isYours);
/** Claude's last reply, as one plain line for the sidebar, or null. */
export const lastReply = lastOf(replyOf);

// A chat's lifetime totals, from the "cost-state" rows Claude Code writes into its transcript: total cost, time
// spent on model calls and tools, and lines changed. They carry over when a chat is resumed, so the last row covers
// the whole chat, not just this run. Reads only the file's tail (rows land every few turns), cached by mtime.
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { configHome } from './core/env.mjs';
import { projectFolder } from './core/transcript.mjs';

const cache = new Map(); // file -> { mtime, value }
const TAILS = [512 * 1024, 8 * 1024 * 1024]; // a cheap look first, then a wider one for chats with long stretches between rows

export async function chatTotals(sessionId, dir, configDir = configHome()) {
  if (!sessionId || !dir || !/^[\w-]+$/.test(String(sessionId))) return null;
  const file = path.join(projectFolder(dir, configDir), `${sessionId}.jsonl`);
  try {
    const st = await stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.value;
    let value = null;
    const fh = await open(file, 'r');
    try {
      for (const tail of TAILS) {
        const len = Math.min(tail, st.size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        const lines = buf.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0 && !value; i--) {
          if (!lines[i].includes('"type":"cost-state"')) continue;
          try {
            const d = JSON.parse(lines[i]);
            value = {
              cost: Number(d.totalCostUSD) || 0,
              workMs: (Number(d.totalAPIDuration) || 0) + (Number(d.totalToolDuration) || 0),
              linesAdded: Number(d.totalLinesAdded) || 0, linesRemoved: Number(d.totalLinesRemoved) || 0,
            };
          } catch { /* the tail's first line can be cut off */ }
        }
        if (value || len === st.size) break;
      }
    } finally { await fh.close(); }
    cache.set(file, { mtime: st.mtimeMs, value });
    return value;
  } catch { return null; }
}

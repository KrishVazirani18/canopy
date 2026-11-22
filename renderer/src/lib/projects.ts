// The sidebar's projects: the folders you opened, each with its chats.
// A plain function of what main lists, so node tests it as it is.
import type { SessionSummary } from './api';

export type Project = { dir: string; sessions: SessionSummary[]; updated: number };

/**
 * The saved folders in the order they were saved (plus the folder of the chat on screen, if it is not saved), each
 * with its chats, newest first. `chatsDir`, the folder of chats with no project, is never one of them, and a chat in
 * a folder that was not opened in Canopy is left out.
 */
export function groupProjects(sessions: SessionSummary[], saved: string[], cwd: string | null, chatsDir: string | null): Project[] {
  const map = new Map<string, Project>();
  for (const d of saved) if (d !== chatsDir) map.set(d, { dir: d, sessions: [], updated: 0 });
  if (cwd && cwd !== chatsDir && !map.has(cwd)) map.set(cwd, { dir: cwd, sessions: [], updated: 0 });
  for (const s of sessions) {
    if (!s.cwd || !map.has(s.cwd)) continue; // only projects opened in Canopy
    const p = map.get(s.cwd)!;
    p.sessions.push(s);
    p.updated = Math.max(p.updated, s.updated);
    map.set(s.cwd, p);
  }
  for (const p of map.values()) p.sessions.sort((a, b) => b.updated - a.updated);
  // Stable order: the order projects were added. Opening a project never reshuffles the list.
  const rank = (d: string) => { const i = saved.indexOf(d); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  return [...map.values()].sort((a, b) => rank(a.dir) - rank(b.dir));
}

// Archived chats: hidden from the sidebar, nothing deleted. Claude Code's transcript stays on disk, Search still
// finds the chat, and "Archived" at the bottom of Recents lists them to bring back. Kept in localStorage.
import { useSyncExternalStore } from 'react';
import { feature } from './telemetry';

const KEY = 'canopy.archived';
let ids: Set<string> = (() => { try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]); } catch { return new Set(); } })();
const subs = new Set<() => void>();
const save = (next: Set<string>) => {
  ids = next;
  try { localStorage.setItem(KEY, JSON.stringify([...ids])); } catch { /* storage full or blocked: still hidden for this run */ }
  subs.forEach((f) => f());
};

export const archive = (id: string) => { save(new Set([...ids, id])); feature('chat_archived'); };
export const unarchive = (id: string) => { const n = new Set(ids); n.delete(id); save(n); feature('chat_unarchived'); };
export const isArchived = (id: string) => ids.has(id);
export function useArchived() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => ids);
}

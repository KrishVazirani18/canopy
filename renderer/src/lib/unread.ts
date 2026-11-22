// Chats you marked unread yourself (right-click → Mark as unread). They show the green "done" dot until you open
// them. Kept in localStorage; the main process tracks unread for chats that finished while you were elsewhere.
import { useSyncExternalStore } from 'react';

const KEY = 'canopy.markedUnread';
let ids: Set<string> = (() => { try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]); } catch { return new Set(); } })();
const subs = new Set<() => void>();
const save = (next: Set<string>) => { ids = next; try { localStorage.setItem(KEY, JSON.stringify([...ids])); } catch { /* blocked */ } subs.forEach((f) => f()); };

export const markUnread = (id: string) => { if (!ids.has(id)) save(new Set([...ids, id])); };
export const markRead = (id: string) => { if (ids.has(id)) { const n = new Set(ids); n.delete(id); save(n); } };
export function useMarkedUnread() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => ids);
}

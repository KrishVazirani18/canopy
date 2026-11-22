// Pinned chats: kept in a Pinned section at the top of the sidebar, in the order you pinned them. Kept in localStorage.
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { feature } from './telemetry';

const KEY = 'canopy.pinned';
let ids: string[] = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; } })();
const subs = new Set<() => void>();
const save = (next: string[]) => {
  ids = next;
  try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* storage full or blocked: still pinned for this run */ }
  glide(() => subs.forEach((f) => f()));
};

/** Pinning, unpinning or reordering pins animates, inside the sidebar only: each row's spot is noted, the change is
 *  made, then every row slides from where it was to where it is now (new ones, like the Pinned heading, fade in).
 *  Nothing else on screen is touched, so the window doesn't flash. Rows are found by data-glide (sidebar.tsx). */
function glide(change: () => void) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { change(); return; }
  const before = new Map<string, DOMRect>();
  for (const el of document.querySelectorAll<HTMLElement>('[data-glide]')) before.set(el.dataset.glide!, el.getBoundingClientRect());
  flushSync(change);
  for (const el of document.querySelectorAll<HTMLElement>('[data-glide]')) {
    const was = before.get(el.dataset.glide!);
    const now = el.getBoundingClientRect();
    if (!was) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' }); continue; }
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }
}

export const pin = (id: string) => { if (!ids.includes(id)) { save([...ids, id]); feature('chat_pinned'); } };
export const unpin = (id: string) => { save(ids.filter((x) => x !== id)); feature('chat_unpinned'); };
/** The chat carries on under a new id (its first message was edited): its pin stays where it is. */
export const repin = (from: string, to: string) => { if (ids.includes(from)) save(ids.map((x) => (x === from ? to : x))); };
/** Pinned chats in a new order (dragged in the sidebar). */
export const setPinnedOrder = (next: string[]) => save([...new Set(next)]);
export function usePinned(): string[] {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => ids);
}

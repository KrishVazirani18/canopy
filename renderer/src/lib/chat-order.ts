// Your own order for a sidebar list of chats (a project's chats, or Recents). A list sorts itself by your last message
// until you drag a chat in it; from then on it keeps the order you gave it, and new chats show up at the top.
// "Sort by last message" (the project's menu) hands it back to sorting itself. Kept in localStorage.
import { useSyncExternalStore } from 'react';

const KEY = 'canopy.chatOrder';
let orders: Record<string, string[]> = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; } })();
const subs = new Set<() => void>();
const save = (next: Record<string, string[]>) => {
  orders = next;
  try { localStorage.setItem(KEY, JSON.stringify(orders)); } catch { /* storage full or blocked: kept for this run */ }
  subs.forEach((f) => f());
};

/** Keep this order for the list (its chat ids, top first). */
export const setChatOrder = (list: string, ids: string[]) => save({ ...orders, [list]: [...new Set(ids)] });
/** The chat carries on under a new id (its first message was edited): it keeps its place in every list. */
export const reorderAs = (from: string, to: string) => {
  if (!Object.values(orders).some((ids) => ids.includes(from))) return;
  save(Object.fromEntries(Object.entries(orders).map(([list, ids]) => [list, ids.map((x) => (x === from ? to : x))])));
};
/** Back to sorting itself by your last message. */
export const clearChatOrder = (list: string) => { const { [list]: _, ...rest } = orders; save(rest); };

export function useChatOrders(): Record<string, string[]> {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => orders);
}

/** The list's chats in your order, if you gave it one: chats you haven't placed (new ones) first, newest first, then
 *  the rest where you put them. `sorted` is already newest first. */
export function arrange<T extends { id: string }>(sorted: T[], order: string[] | undefined): T[] {
  if (!order?.length) return sorted;
  const at = new Map(order.map((id, i) => [id, i]));
  return [...sorted.filter((x) => !at.has(x.id)), ...sorted.filter((x) => at.has(x.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!)];
}

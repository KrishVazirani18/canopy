// Codex chats that another app has open right now (src/codex-held.mjs). Codex lets one process write a chat at a
// time, so such a chat can be read here but not carried on: its row says where it is open, and so does the chat, in
// place of the message box. Main says who has what, in its own words, and says again whenever that changes; when the
// chat is let go of there, the row and the message box come back on their own.
import { useSyncExternalStore } from 'react';

/** `app`: that app in words ("the Codex app"). `line`: the sidebar row's second line. `text`: what the chat says. */
export type Held = { app: string; line: string; text: string };

let held: Record<string, Held> = {};
const subs = new Set<() => void>();

export const heldChats = {
  /** Everything that is held now, as main says it. */
  set(next: Record<string, Held> | null | undefined) {
    held = next && typeof next === 'object' ? next : {};
    subs.forEach((f) => f());
  },
  /** One chat's answer came with its opening (main's list follows by itself). */
  note(sessionId: string | null | undefined, h: Held | null | undefined) {
    if (!sessionId || !h || held[sessionId]?.text === h.text) return;
    heldChats.set({ ...held, [sessionId]: h });
  },
  get: (sessionId: string | null | undefined): Held | null => (sessionId ? held[sessionId] ?? null : null),
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

/** Where this chat is open, when another app has it; null for every other chat. Kept current. */
export function useHeld(sessionId: string | null | undefined): Held | null {
  return useSyncExternalStore(heldChats.subscribe, () => heldChats.get(sessionId));
}

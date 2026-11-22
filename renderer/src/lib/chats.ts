// Parallel chats, window side: the live status of every open chat (from main's "chats:status"), for the
// sidebar dots, and which chat is on screen (events from any other chat are ignored by the transcript).
import { useSyncExternalStore } from 'react';
import { markUnread } from './unread';

export type ChatState = 'working' | 'needs-you' | 'done' | 'idle';
/** `line`: where it stands in words (what it waits on you for, what went wrong, or its last reply), for the sidebar.
 *  `asking`: what it waits on you for is a question (its mark is a "?" instead of a dot). */
export type ChatStatus = { sid: string; sessionId: string; cwd: string | null; state: ChatState; unread: boolean; active: boolean; helpers?: number; failed?: boolean; line?: string | null; engine?: 'claude' | 'codex'; asking?: boolean };

let list: ChatStatus[] = [];

// The sidebar reads the list of saved chats again on 'canopy:sessions-changed'. Whoever has a reason to ask (a chat
// started, was named, was replaced) asks here: a burst of reasons makes one read, at most every 400 ms.
let sessionsTimer: ReturnType<typeof setTimeout> | undefined;
export const sessionsChanged = () => { if (sessionsTimer) return; sessionsTimer = setTimeout(() => { sessionsTimer = undefined; window.dispatchEvent(new Event('canopy:sessions-changed')); }, 400); };

// What survives a restart. The main process keeps "replied while you were away" only in memory, so a chat that turns
// unread is also marked here (saved, like right-click → Mark as unread) and stays marked until you open it. And a chat
// that was still working or waiting on you when Canopy restarted or quit gets marked too, so you know to look at it.
const GOING_KEY = 'canopy.goingAtExit';
let wasUnread = new Map<string, boolean>();
let checkedRestart = false;
function carryOver(next: ChatStatus[]) {
  for (const s of next) if (s.unread && !wasUnread.get(s.sessionId)) markUnread(s.sessionId);
  wasUnread = new Map(next.map((s) => [s.sessionId, !!s.unread]));
  // The first list after the window opens: a chat that was going last time and isn't live now was cut off.
  // (A window reload alone keeps the chats live, so they're still in the list and nothing is marked.)
  if (!checkedRestart) {
    checkedRestart = true;
    try { for (const id of JSON.parse(localStorage.getItem(GOING_KEY) ?? '[]') as string[]) if (!next.some((s) => s.sessionId === id)) markUnread(id); } catch { /* nothing saved */ }
  }
  const going = next.filter((s) => s.state === 'working' || s.state === 'needs-you' || (s.helpers ?? 0) > 0).map((s) => s.sessionId);
  try { localStorage.setItem(GOING_KEY, JSON.stringify(going)); } catch { /* storage blocked */ }
}
let bySession = new Map<string, ChatStatus>();
let activeSid: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const chats = {
  set(next: ChatStatus[]) {
    carryOver(next);
    list = next; bySession = new Map(next.map((s) => [s.sessionId, s]));
    const a = next.find((s) => s.active); if (a) activeSid = a.sid;
    emit();
  },
  setActive(sid: string | null) { activeSid = sid; },
  /** True when an engine event belongs to the chat on screen (events without a sid predate parallel chats). */
  isActive(ev: { sid?: string }) { return !ev.sid || !activeSid || ev.sid === activeSid; },
  all: () => list,
  get: (sessionId: string | null | undefined) => (sessionId ? bySession.get(sessionId) : undefined),
  working: () => list.filter((s) => s.state === 'working' || s.state === 'needs-you').length,
  /** Chats a restart would cut off: working, waiting on you, or with helpers still running. */
  busy: () => list.filter((s) => s.state === 'working' || s.state === 'needs-you' || (s.helpers ?? 0) > 0).length,
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

let version = 0;
chats.subscribe(() => { version++; });
/** How many chats are really working (not ones waiting for an answer), kept current: a required update waits for these. */
export function useWorkingChats(): number {
  useSyncExternalStore(chats.subscribe, () => version);
  return list.filter((s) => s.state === 'working' || (s.helpers ?? 0) > 0).length;
}
/** How many chats a restart would cut off, kept current. */
export function useBusyChats(): number {
  useSyncExternalStore(chats.subscribe, () => version);
  return chats.busy();
}
export function useChatStatus(sessionId: string | null | undefined): ChatStatus | undefined {
  useSyncExternalStore(chats.subscribe, () => version);
  return chats.get(sessionId);
}
/** Every open chat's status, kept current (the sidebar uses it for a folded project's dot). */
export function useChatList(): ChatStatus[] {
  useSyncExternalStore(chats.subscribe, () => version);
  return chats.all();
}

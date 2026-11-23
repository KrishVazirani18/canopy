// Usage, window side: what main knows about the account in use per maker (src/core/usage.mjs), kept current while
// the Usage tab is on screen, and not asked for at all while it is not. Main owns the numbers and the timing; this
// file only asks, listens, and says when the tab has gone away.
import { useSyncExternalStore } from 'react';
import { api, type Engine, type UsageView } from './api';

// How often the tab asks while it is on screen. Asking is free: main answers from what it has, and reads again
// only what has gone stale (a plan every minute through a running chat, every five through a helper process).
const ASK_EVERY_MS = 20_000;

let state: UsageView | null = null;
const subs = new Set<() => void>();

function set(next: UsageView | { error: string } | null | undefined) {
  if (!next || 'error' in next || !Array.isArray(next.sections)) return; // a failed read leaves what is shown in place
  state = next;
  for (const f of subs) f();
}

export function useUsage(): UsageView | null {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state);
}

/** Ask main what it knows now. `open`: the tab has just come on screen, so anything a minute old is read again. */
export function readUsage(open = false): Promise<void> {
  return api.usage?.get({ open }).then(set).catch(() => {}) ?? Promise.resolve();
}

/** Something that shows usage is on screen (the Usage tab, Home's Today line): ask now, keep asking, and follow what
 *  main sends. Call what it returns when it goes away. Several may watch at once; main is told to stop reading only
 *  when the last one has gone. */
let watchers = 0;
let stopWatching: (() => void) | null = null;
export function watchUsage(): () => void {
  if (watchers++ === 0) {
    const off = api.usage?.onChanged(set) ?? (() => {});
    const timer = setInterval(() => { readUsage(); }, ASK_EVERY_MS);
    stopWatching = () => { clearInterval(timer); off(); api.usage?.watch(false).catch(() => {}); };
  }
  readUsage(true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--watchers === 0) { stopWatching?.(); stopWatching = null; }
  };
}

/** "Updated…" or Try Again was clicked: read now. */
export function refreshUsage(engine?: Engine): Promise<void> {
  return api.usage?.refresh(engine).then(set).catch(() => {}) ?? Promise.resolve();
}

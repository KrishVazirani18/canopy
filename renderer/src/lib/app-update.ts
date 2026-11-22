// Canopy's own updates, window side: the status main keeps (src/core/app-update.mjs), followed live, and the quiet
// toast when an update just went in. The words are in app-update-words.ts.
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api, type AppUpdateStatus } from './api';
import { updateToast } from './app-update-words';

let status: AppUpdateStatus | null = null;
const subs = new Set<() => void>();

function set(next: AppUpdateStatus | { error: string } | null | undefined) {
  if (!next || !('supported' in next)) return; // main could not answer: what was known stands
  status = next;
  for (const f of subs) f();
  if (next.note) { const t = updateToast(next.note); toast(t.title, { id: t.id, description: t.description }); }
}

/** Null until main has answered, and in a main without an updater. */
export function useAppUpdate(): AppUpdateStatus | null {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => status);
}

/** Load the status and follow its changes. */
export function startAppUpdate(): () => void {
  // Tolerates a bridge without the updater (an older main, or the UI harness): nothing to follow then.
  if (typeof api.appUpdate?.status !== 'function') return () => {};
  api.appUpdate.status().then(set).catch(() => {});
  return typeof api.appUpdate.onStatus === 'function' ? api.appUpdate.onStatus(set) : () => {};
}

export const appUpdate = {
  check: () => api.appUpdate?.check?.().then(set).catch(() => {}) ?? Promise.resolve(),
  download: () => api.appUpdate?.download?.().then(set).catch(() => {}) ?? Promise.resolve(),
  setAuto: (on: boolean) => api.appUpdate?.setAuto?.(on).then(set).catch(() => {}) ?? Promise.resolve(),
  installRequired: () => api.appUpdate?.installRequired?.().then(set).catch(() => {}) ?? Promise.resolve(),
  cancelRequired: () => api.appUpdate?.cancelRequired?.().then(set).catch(() => {}) ?? Promise.resolve(),
};

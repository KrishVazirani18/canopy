// Home's data: every chat's live status from the main process (home:status), plus acting on any chat.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, type HomeDay } from './api';
import { feature } from './telemetry';

export type HomeAsk = { id: number; title: string | null; toolName: string | null; kind: 'tool' | 'question' | 'plan' | 'elicitation' | null; detail: string; message: string | null; since: number };
export type HomeChat = {
  sid: string; sessionId: string; cwd: string | null; title: string | null; state: 'working' | 'needs-you' | 'done' | 'idle';
  unread: boolean; active: boolean; activity: string | null; turnAt: number | null; doneAt: number | null; stopped: boolean;
  last: string | null; ask: HomeAsk | null; work: { kind: 'workflow' | 'agent' | 'command'; name: string; id?: string }[]; helpers: number;
  spans?: { from: number; to: number | null; kind: 'work' | 'wait' }[]; // today: when it worked / waited on you
  steps?: number; files?: string[]; pr?: string | null; // this reply's step count, the files it changed, a PR it opened
};

let list: HomeChat[] = [];
let ready = false;
const subs = new Set<() => void>();
const set = (next: HomeChat[]) => { list = next; ready = true; subs.forEach((f) => f()); };
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  api.onHomeStatus?.((l) => { if (Array.isArray(l)) set(l as HomeChat[]); });
}

/** null until the main process answers; [] when it doesn't know Home yet (Canopy needs a restart). */
export function useHome(): HomeChat[] | null {
  wire();
  useEffect(() => { const p = api.homeList?.(); if (!p) { set([]); return; } p.then((l) => set(Array.isArray(l) ? (l as HomeChat[]) : [])).catch(() => set([])); }, []);
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => list);
  return ready ? list : null;
}
export const homeAvailable = () => !!api.homeList;
export const homeRespond = (sid: string, id: number, answer: { action: string }) => api.homeRespond?.(sid, id, answer);
export const homeStop = (sid: string) => { feature('stop_clicked'); return api.homeStop?.(sid); };
export const homeStopTasks = (sid: string, ids: string[]) => api.homeStopTasks?.(sid, ids);

/** Today in quarter hours for Home's strip: fetched on open, then every half minute while Home is on screen.
 *  null until the first answer; false when Canopy needs a restart to know it (the window reloads with new code, but
 *  the main process that answers only updates on a restart). */
let lastDay: HomeDay | null = null; // the last answer, so Home shows it at once when it opens again
export function useHomeDay(): HomeDay | null | false {
  const [day, setDay] = useState<HomeDay | null | false>(api.homeDay ? lastDay : false);
  useEffect(() => {
    if (!api.homeDay) return;
    let live = true;
    // Only a real day is kept: a failed read answers { error }, which would break the strip that draws `slots`.
    const load = () => api.homeDay?.().then((d) => { if (!d || !Array.isArray(d.slots)) return; lastDay = d; if (live) setDay(d); })
      .catch((e) => { if (live && /No handler registered/.test(String(e))) setDay(false); });
    load();
    const id = setInterval(load, 30_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return day;
}

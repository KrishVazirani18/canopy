// Run in the chat: the commands run from replies' shell blocks, kept here and not in the block that started them.
// A reply's block remounts all the time (folds, Show earlier, a turn ending), so a run outlives it: the block finds
// its run again by chat and command, and replays what it printed so far. When a run ends by itself, what it printed
// goes to Claude as your next message (or after the turn it's on, if Claude is working); one you stop does not.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { runReport } from './run-report';
import type { Store } from './store';

export type RunStatus = 'running' | 'done' | 'stopped' | 'error';
export type Run = { key: string; id: string; code: string; status: RunStatus; exitCode: number | null; error?: string };

const KEEP = 256 * 1024; // characters of output kept for a block that remounts

type Entry = Run & { out: string; stopping: boolean; store: Store };
const runs = new Map<string, Entry>();    // key -> its latest run
const byId = new Map<string, Entry>();
const sinks = new Map<string, Set<(data: string) => void>>(); // key -> the terminals drawing it (one per mounted block)
const subs = new Set<() => void>();
let version = 0;
const changed = () => { version++; subs.forEach((f) => f()); };

/** One command in one chat. A chat that has no id yet is known by its store until it gets one. */
const ids = new WeakMap<Store, string>();
export function runKey(store: Store, code: string) {
  let chat = store.meta.sessionId ?? ids.get(store);
  if (!chat) { chat = `new-${crypto.randomUUID()}`; ids.set(store, chat); }
  return `${chat}\n${code}`;
}

let wired = false;
function wire() {
  if (wired || !api.run) return;
  wired = true;
  api.run.onData(({ id, data }) => {
    const e = byId.get(id);
    if (!e) return;
    e.out = (e.out + data).slice(-KEEP);
    sinks.get(e.key)?.forEach((f) => f(data));
  });
  api.run.onExit(({ id, exitCode }) => {
    const e = byId.get(id);
    if (!e) return;
    byId.delete(id);
    e.exitCode = exitCode;
    e.status = e.stopping ? 'stopped' : 'done';
    changed();
    if (!e.stopping) tell(e);
  });
}

/** What it printed goes to Claude, as you'd have pasted it. */
function tell(e: Entry) {
  const text = runReport(e.code, e.exitCode, e.out);
  if (e.store.meta.busy) e.store.enqueue(text, []);
  else e.store.dispatch(text, [], false);
}

export const canRun = () => !!api.run;

/** Start `code` in the chat's folder (again, if it ran before). */
export async function startRun(store: Store, code: string, size: { cols: number; rows: number }): Promise<Run | null> {
  if (!api.run) return null;
  wire();
  const key = runKey(store, code);
  const prev = runs.get(key);
  if (prev?.status === 'running') return prev;
  const e: Entry = { key, id: crypto.randomUUID(), code, status: 'running', exitCode: null, out: '', stopping: false, store };
  runs.set(key, e);
  byId.set(e.id, e);
  changed();
  const r = await api.run.start(e.id, { sid: store.sid, cwd: store.cwd, code, cols: size.cols, rows: size.rows }).catch((err) => ({ error: String(err?.message ?? err) }));
  if (r?.error) {
    byId.delete(e.id);
    e.status = 'error';
    e.error = r.error;
    changed();
  }
  return e;
}

export function stopRun(key: string) {
  const e = runs.get(key);
  if (!e || e.status !== 'running') return;
  e.stopping = true;
  void api.run?.stop(e.id);
}

export const typeInto = (key: string, data: string) => { const e = runs.get(key); if (e?.status === 'running') api.run?.input(e.id, data); };
export const resizeRun = (key: string, cols: number, rows: number) => { const e = runs.get(key); if (e?.status === 'running') api.run?.resize(e.id, cols, rows); };

/** Everything the latest run printed so far (to draw a block that mounts mid-run or after), and each new piece
 *  after that, from this run and any run of the same command started later. */
export function watchOutput(key: string, sink: (data: string) => void): { sofar: string; stop: () => void } {
  let set = sinks.get(key);
  if (!set) sinks.set(key, (set = new Set()));
  set.add(sink);
  const mine = set;
  return { sofar: runs.get(key)?.out ?? '', stop: () => { mine.delete(sink); if (!mine.size) sinks.delete(key); } };
}

/** The latest run of this command in this chat, kept up to date. */
export function useRun(key: string): Run | undefined {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
  const e = runs.get(key);
  return e ? { key: e.key, id: e.id, code: e.code, status: e.status, exitCode: e.exitCode, error: e.error } : undefined;
}

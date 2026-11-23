// Upkeep, window side: the status Canopy's main process keeps for Claude Code (src/core/upkeep.mjs) and, as
// `codex`, for the user's Codex (src/core/codex-upkeep.mjs), the model picker fixups it worked out, and the quiet
// toasts when it did something for you. The toasts' words are in upkeep-words.ts, the same for both tools.
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api, type UpkeepStatus } from './api';
import { choices } from './choices';
import { upkeepToast, type UpkeepNote } from './upkeep-words';

let status: UpkeepStatus | null = null;
const subs = new Set<() => void>();
let onFixups: (() => void) | null = null;
let fixupKey = '';
const MIGRATED = 'canopy.modelMigrations'; // fixups whose saved-choice migration already ran

function set(next: UpkeepStatus | null) {
  if (!next) return;
  status = next;
  for (const f of subs) f();
  const key = JSON.stringify(next.fixups.map((f) => [f.from, f.to.value, f.is]));
  if (key === fixupKey) return;
  fixupKey = key;
  onFixups?.();
  // A model you picked before Canopy knew better follows its family to the row it offers now: the pinned older
  // release, or the bare alias earlier Canopy builds offered for it (`fable` for `fable[1m]`). Once per fixup, ever:
  // if you then deliberately pick something else, that sticks. Through the composer, so the chip and the open chat follow.
  let done: string[] = [];
  try { done = JSON.parse(localStorage.getItem(MIGRATED) ?? '[]'); } catch { /* start fresh */ }
  for (const f of next.fixups) {
    const id = `${f.from}>${f.to.value}`;
    if (done.includes(id)) continue;
    done.push(id);
    if (choices.model !== f.from && choices.model !== f.to.value.replace(/\[1m\]$/, '')) continue;
    choices.model = f.to.value;
    window.dispatchEvent(new CustomEvent('canopy:control', { detail: { key: 'model', value: f.to.value, from: [f.from, f.to.value.replace(/\[1m\]$/, '')] } }));
  }
  try { localStorage.setItem(MIGRATED, JSON.stringify(done.slice(-50))); } catch { /* ignore */ }
}

export function useUpkeep(): UpkeepStatus | null {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => status);
}

/**
 * Claude Code's picker as Canopy offers it: a row pinned to an older release is swapped for its family's alias,
 * which runs the newest (Fable 5.1 → `fable`, running 5.2). Worked out by asking Claude Code, never hardcoded.
 */
export function applyModelFixups<T extends { value: string }>(models: T[]): T[] {
  const fixups = status?.fixups ?? [];
  if (!fixups.length) return models;
  const have = new Set(models.map((m) => m.value));
  return models.map((m) => {
    const f = fixups.find((x) => x.from === m.value);
    return f && !have.has(f.to.value) ? ({ ...m, ...f.to } as T) : m;
  });
}

function say(tool: string, n: UpkeepNote | null | undefined) {
  if (!n) return;
  const t = upkeepToast(tool, n);
  if (!t) return;
  (t.good ? toast.success : toast)(t.title, { id: t.id, description: t.description });
}

/** Load the status, follow changes, and say so (quietly) when Canopy updated or repaired Claude Code or Codex. */
export function startUpkeep(onModelsChanged: () => void): () => void {
  onFixups = onModelsChanged;
  api.upkeep?.status().then(set).catch(() => {});
  return api.upkeep?.onStatus((s) => {
    set(s);
    say('Claude Code', s.note);
    say('Codex', s.codex?.note);
  }) ?? (() => {});
}

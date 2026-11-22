// The model menu's and Settings > Models' shared state, window side.
//
// The rules themselves are in lib/model-rules.ts (plain, tested in node) and are re-exported here, so the menu and
// Settings import everything about models from this one file. What this file adds is what needs the window:
//
//   useAllModels(meta)     every model of both makers, kept current as either list changes
//   useSavedModels()       the menu's four rows as you arranged them (localStorage `canopy.models`), kept current
//   arrangeModels(...)     save the four after a drag
//   useChoices()           the composer's saved choices, kept current (lib/choices.ts has no way to follow it otherwise)
//   newChats               set what new chats start with, from Settings: through the composer's own controls, as
//                          Settings always did, so the chips and the open chat never disagree with it; saved
//                          directly when no composer is on screen to ask (Home)
//   useMakerStatus(env)    each maker's status line
//
// Saved like lib/choices.ts: one localStorage key, read once, written whole on every change. Nothing here throws.
import { useMemo, useSyncExternalStore } from 'react';
import type { EnvInfo } from './api';
import { choices, choicesVersion, subscribeChoices, type Choices } from './choices';
import { claudeRows, saveCodex, useModels } from './engines';
import { setting } from './telemetry';
import {
  allModels, effortSettings, makerStatus, pickValue, readSaved, slotsFor,
  type Effort, type MakerStatus, type Model, type SavedModels,
} from './model-rules.ts';
import type { Meta } from './store';
import { useUpkeep } from './upkeep';

export * from './model-rules.ts';

// ---------- the menu's four rows, saved ----------

const KEY = 'canopy.models';
// What an earlier build stored (the switches of the first Settings > Models) is read as it is and left in place: it
// decides the four until you first drag a row, and only then is the new shape written over it (`readSaved`).
let saved: SavedModels = (() => { try { return readSaved(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { return readSaved(null); } })();
const subs = new Set<() => void>();
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

/** What is saved about the menu right now. */
export const savedModels = (): SavedModels => saved;
/** Replace what is saved about the menu. */
export function saveModels(next: SavedModels) {
  saved = readSaved(next);
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* ignore */ }
  for (const fn of subs) fn();
}
/** What is saved about the menu, kept current. */
export function useSavedModels(): SavedModels {
  return useSyncExternalStore(subscribe, savedModels);
}
/** The four were dragged into a new arrangement: `rows` are the four as they now are, `all` is useAllModels' list. */
export function arrangeModels(rows: Model[], all: Model[]) { saveModels(slotsFor(rows, all)); }

// ---------- the lists ----------

/**
 * Every model of both makers. Claude's rows are the chat's own when it has reported them, else the ones main
 * remembers (lib/engines.ts `claudeRows`), with upkeep's newest-version fixups either way.
 */
export function useAllModels(meta: Pick<Meta, 'models'>): Model[] {
  const groups = useModels();
  const upkeep = useUpkeep(); // a fixup learned later changes Claude's rows, so it is one of the things to follow
  return useMemo(() => allModels(claudeRows(meta), groups.openai), [meta.models, groups, upkeep]);
}

// ---------- your choices ----------

/** The composer's saved choices, re-read whenever one is written. The object is the live one: read it, never keep it. */
export function useChoices(): Choices {
  useSyncExternalStore(subscribeChoices, choicesVersion);
  return choices;
}

// Settings changes the composer's choices by asking the composer (controls.tsx listens for `canopy:control`): one
// writer, so the chips, the open chat and Settings always agree. `stay`: a change made in Settings never opens a chat.
// The composer marks the event `handled`. When none did (Home is on screen, or the focused pane is empty) there is
// no chat to switch and no chip to keep in step, so the choice is saved here, by the same rules the composer uses.
type Ask = { key: 'model' | 'effort' | 'ultracode' | 'fast'; value: unknown; engine?: Model['engine']; stay: true; handled?: boolean };
function control(key: Ask['key'], value: unknown, engine?: Model['engine']) {
  const detail: Ask = { key, value, engine, stay: true };
  window.dispatchEvent(new CustomEvent('canopy:control', { detail }));
  if (detail.handled) return;
  const openai = engine === 'codex';
  if (key === 'model') {
    choices.engine = openai ? 'codex' : undefined;
    if (openai) saveCodex({ model: String(value ?? '') || undefined });
    else choices.model = String(value ?? '') || undefined;
  } else if (key === 'effort') {
    if (openai) saveCodex({ effort: String(value ?? '') || undefined });
    else { if (choices.ultracode) choices.ultracode = false; choices.effort = String(value ?? '') || undefined; }
  } else if (key === 'ultracode') {
    // Claude's Ultra: standing orchestration at max effort, as the composer sets it.
    choices.ultracode = !!value;
    if (value) choices.effort = 'max';
  } else if (key === 'fast') {
    if (openai) saveCodex({ fast: !!value });
    else choices.fast = !!value;
  }
}

/** What new chats start with, set from Settings. Each also switches the chat you are in when it is the same maker's. */
export const newChats = {
  /** Start new chats on this model (and so on its maker). */
  setModel(model: Model) {
    // Counted without the model's name (it can be a company's own). A change of maker is counted by Canopy's word for it.
    setting('default_model');
    if ((choices.engine === 'codex') !== (model.engine === 'codex')) setting('default_engine', model.engine);
    control('model', pickValue(model, choices), model.engine);
  },
  /** This maker's effort; `null` puts it back to the model's default. Claude's Ultra is ultracode, OpenAI's is its own level. */
  setEffort(model: Model, level: Effort | null) {
    setting('default_effort', level ?? 'default');
    const s = effortSettings(model, level);
    if (s.ultracode) control('ultracode', true);
    else control('effort', s.effort, model.engine); // for Claude this also turns Ultra off
  },
  /** This maker's Fast. */
  setFast(model: Model, on: boolean) { control('fast', on, model.engine); },
};

// ---------- each maker's status ----------

/** The status line for each maker, Claude's first (Settings > Models). `env` is what Settings is already given. */
export function useMakerStatus(env: Pick<EnvInfo, 'auth'> | null | undefined): MakerStatus[] {
  const groups = useModels();
  return useMemo(() => makerStatus(env?.auth, groups.codex, groups.openai.length), [env?.auth, groups]);
}

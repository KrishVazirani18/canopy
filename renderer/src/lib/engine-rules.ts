// The rules about the two makers' models that need no window: which effort levels a model offers and what they are
// called, where the slider rests when nothing is chosen, which row a typed name means, and how a diff that arrives as
// hunks only (every OpenAI edit) is counted and laid out.
//
// Nothing here imports anything at run time, reads the window, or throws: bad input gives the empty answer. That is
// what lets a plain node test run this file as it is (src/core/test/unit/engine-rules.test.mjs).
import type { CodexModel, Engine } from './api';

export const otherMaker = (engine: Engine): Engine => (engine === 'codex' ? 'claude' : 'codex');

/**
 * The maker a new chat opens on: the one whose model you picked last, as long as the picker still offers it. Once
 * the model list has been read and holds no OpenAI model (Codex is missing, signed out or not answering), a new chat
 * is a Claude chat, like every row the picker shows. Before the list has been read, your last pick stands.
 */
export function newChatEngine(lastPicked: unknown, listRead: boolean, openaiModels: number): Engine {
  return lastPicked === 'codex' && !(listRead && !(openaiModels > 0)) ? 'codex' : 'claude';
}

// ---------- effort ----------

// Short labels for the slider (six stops share ~240px) and full words for the chip and the chat menu.
const EFFORT_SHORT: Record<string, string> = { none: 'None', minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
const EFFORT_NAME: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' };
const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
export const effortShort = (level: string) => EFFORT_SHORT[level] ?? capital(String(level ?? ''));
export const effortName = (level: string) => EFFORT_NAME[level] ?? capital(String(level ?? ''));

/** The effort levels an OpenAI model offers, in its own order. Empty when it has none (or the row is not known). */
export function effortStops(row: Pick<CodexModel, 'supportsEffort' | 'supportedEffortLevels'> | null | undefined): string[] {
  if (!row || row.supportsEffort === false || !Array.isArray(row.supportedEffortLevels)) return [];
  return row.supportedEffortLevels.filter((l) => typeof l === 'string' && l.length > 0);
}

/** A chosen effort, if the model offers it; otherwise nothing (switching to a model without the level unsets it). */
export function keepEffort(row: Parameters<typeof effortStops>[0], effort: string | null | undefined): string | undefined {
  return effort && effortStops(row).includes(effort) ? effort : undefined;
}

/** Where the slider rests when nothing is chosen: what the chat says it runs with, else the model's own default
 *  (Low on some models, not High), else the middle stop. Null when the model has no levels. */
export function restingEffort(row: (Parameters<typeof effortStops>[0] & { defaultEffort?: string | null }) | null | undefined, reported?: string | null): string | null {
  const stops = effortStops(row);
  if (!stops.length) return null;
  if (reported && stops.includes(reported)) return reported;
  if (row?.defaultEffort && stops.includes(row.defaultEffort)) return row.defaultEffort;
  return stops[Math.floor((stops.length - 1) / 2)];
}

// ---------- a model, by the name someone typed ----------

type Named = { value: string; displayName?: string; description?: string };
function findIn<T extends Named>(rows: T[], a: string): T | undefined {
  return rows.find((m) => m.value.toLowerCase() === a)
    ?? rows.find((m) => (m.displayName ?? '').toLowerCase() === a)
    ?? rows.find((m) => (m.description ?? '').toLowerCase().startsWith(a))
    ?? rows.find((m) => (m.displayName ?? m.value).toLowerCase().includes(a));
}
/** `/model <name>`: the chat's own maker is searched first, then the other, so a name both have means the one you are
 *  on. `mine` is false when the hit is the other maker's. No hit: null, and the caller sends the name as typed. */
export function findModel<A extends Named, B extends Named>(arg: string, own: A[], other: B[]): { row: A; mine: true } | { row: B; mine: false } | null {
  const a = String(arg ?? '').trim().toLowerCase();
  if (!a) return null;
  const here = findIn(Array.isArray(own) ? own : [], a);
  if (here) return { row: here, mine: true };
  const there = findIn(Array.isArray(other) ? other : [], a);
  return there ? { row: there, mine: false } : null;
}

// ---------- a diff that is hunks only ----------
// An OpenAI edit arrives as the diff itself: "@@ -1 +1 @@\n-hello\n+goodbye\n", no file header. It is shown and counted
// as it is. Rebuilding it from the two sides joined across hunks would give a two-hunk edit the wrong line numbers.

export type DiffRow = { k: '+' | '-' | ' ' | '@'; t: string };

/** The diff's lines for the Changes tab: a quiet "Line N" marker per hunk, then its rows. Anything before the first
 *  hunk (a file header, if one ever shows up) and the "\ No newline" notes are not content. */
export function diffRows(diff: unknown): DiffRow[] {
  if (typeof diff !== 'string' || !diff) return [];
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: DiffRow[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      out.push({ k: '@', t: m ? `Line ${m[1]}` : 'Change' });
      continue;
    }
    if (!inHunk || line[0] === '\\') continue;
    const c = line[0];
    out.push(c === '+' || c === '-' ? { k: c, t: line.slice(1) } : { k: ' ', t: c === ' ' ? line.slice(1) : line });
  }
  return out;
}

/** Lines added and removed by a hunks-only diff: its "+" and "-" rows, never the "@@", "+++" or "---" lines. */
export function diffStats(diff: unknown): { add: number; del: number } {
  let add = 0, del = 0;
  for (const r of diffRows(diff)) { if (r.k === '+') add++; else if (r.k === '-') del++; }
  return { add, del };
}

// The rules behind the model menu and Settings > Models that need no window:
//
//   allModels(...)        one list of every model of both makers, in one shape (`Model`)
//   modelFamily(...)      which family a model id belongs to and which version it is (Opus, Fable, GPT Sol…)
//   menuRows(...)         the menu's four rows: the default four until you arrange them, then yours
//   dragModel(...)        the four after a row was dragged (within the four, into them, or out of them)
//   slotsFor(...)         what is saved for the four as they are arranged
//   searchModels(...)     the search field: every model of both makers that matches what was typed
//   EFFORT_SCALE and the effort functions: one scale for both makers, the stops each model offers, where the slider
//                         sits, and what a stop means to each maker (Ultra is the only one that differs)
//   chatModel(...), startsWith(...)   the model a chat runs on, and what new chats start with
//   makerStatus(...)      the status line Settings shows for each maker
//
// The menu always has four model rows; every other model is under More models. Zero upkeep is the point of how the
// four are worked out. Until you drag a row nothing is saved, and the four are named by family (Claude's Opus,
// OpenAI's Sol, Claude's Fable, OpenAI's Astra), each as the newest version listed. Once you arrange them, each row
// is saved as the model you put there and still belongs to its family: Opus 5.6 takes Opus 5.5's row on its own. Only
// a model that was already an older version when you put it there stays exactly as it is. A row whose model is not
// offered right now (signed out of Codex for a day) is filled by the next model in line, and is back when its own
// is. Nothing saved is ever pruned.
//
// Nothing here reads the window or throws: bad input gives the empty answer. That is what lets a plain node test run
// this file as it is (src/core/test/unit/model-rules.test.mjs). The one import is written with its `.ts` ending for
// the same reason: node resolves it as written.
import type { ClaudeModel, CodexModel, Engine } from './api';
import { effortName, effortShort } from './engine-rules.ts';

// ---------- makers ----------

/** Who makes a model. The engine that runs it (Claude Code, Codex) is never named on screen; the maker is. */
export type Maker = 'claude' | 'openai';
export const MAKERS: Maker[] = ['claude', 'openai'];
export const MAKER_NAME: Record<Maker, string> = { claude: 'Claude', openai: 'OpenAI' };
export const makerEngine = (maker: Maker): Engine => (maker === 'openai' ? 'codex' : 'claude');
export const engineMaker = (engine: Engine | string | null | undefined): Maker => (engine === 'codex' ? 'openai' : 'claude');

// ---------- effort: one scale for both makers ----------

/** The six stops, in order. A model shows only the ones it offers. */
export const EFFORT_SCALE = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORT_SCALE)[number];
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORT_SCALE as readonly string[]).includes(v);
// Claude Code offers every stop on every model, and rests on High (what the slider has always shown).
const CLAUDE_EFFORTS: Effort[] = [...EFFORT_SCALE];
const CLAUDE_DEFAULT_EFFORT: Effort = 'high';

// ---------- one list of models ----------

/**
 * A model of either maker, as the menu and Settings read it.
 * `key` is what is saved and compared (`claude:opus`, `openai:gpt-6.1-sol`): an id is never read without its maker.
 * `id` is what goes over the wire, exactly as the maker's own list gave it. Claude's stand-in row for "Claude Code
 * has not listed its models yet" has the empty id, which means "Claude Code's own default".
 */
export type Model = {
  key: string; id: string; maker: Maker; engine: Engine;
  /** The name on the row and the chip: "Opus 5.5", "GPT-6.1-Sol". */
  label: string;
  description: string;
  /** The maker's own default model (Claude Code's "Default" row; Codex's default). */
  isDefault: boolean;
  /** The stops of EFFORT_SCALE this model offers, in scale order. Empty: no effort to choose. */
  efforts: Effort[];
  /** Where the model rests when you have chosen no effort. Null: it did not say (the middle stop is used). */
  defaultEffort: Effort | null;
  /** Has a faster tier (the Fast control). Claude: what Claude Code says per model; OpenAI: what Codex says. */
  fast: boolean;
  /** Family and version, for "a newer one replaces the older one". Version null: not known, never replaced. */
  family: string; version: number[] | null;
  /** Claude only: the full model id the row runs today (`claude-opus-5-5`). */
  resolved: string | null;
};

const isPlain = (o: unknown): o is Record<string, unknown> => o !== null && typeof o === 'object' && !Array.isArray(o);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const rowsOf = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]).filter((m) => isPlain(m) && typeof m.value === 'string') : []);
export const modelKey = (maker: Maker, id: string) => `${maker}:${id}`;
/** A saved key back into its maker and id. Null when it is not a key. */
export function parseKey(key: unknown): { maker: Maker; id: string } | null {
  const s = text(key), at = s.indexOf(':');
  const maker = s.slice(0, at);
  return at > 0 && (maker === 'claude' || maker === 'openai') ? { maker, id: s.slice(at + 1) } : null;
}

/** A Claude row's name: "Opus 5.5 · Best for…" → "Opus 5.5"; "Use the default model (currently Opus 5.5)" → "Opus 5.5". */
export function claudeLabel(m: Pick<ClaudeModel, 'value' | 'displayName' | 'description'>): string {
  const d = text(m?.description);
  const cur = d.match(/currently ([^)]+)\)/);
  if (cur) return cur[1];
  const first = d.split(' · ')[0];
  return first && first.length < 24 ? first : (text(m?.displayName) || text(m?.value));
}

// A full Claude id: claude-fable-5-1, claude-opus-5-5-20261001, claude-opus-6, claude-fable-5-1[1m]. The minor is at
// most two digits, so a date is never read as one. (The same reading as src/core/upkeep.mjs.)
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/;
// The older order: claude-3-5-sonnet-20241022.
const CLAUDE_ID_OLD = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?(\[1m\])?$/;
// The names Claude Code's picker uses: opus, sonnet, haiku, fable[1m].
const CLAUDE_ALIAS = /^([a-z]+)(\[1m\])?$/;
// An OpenAI id with one version number in it: gpt-6.1-sol, gpt-6-astra, gpt-5.5, gpt-5.1-codex-max, o3, o4-mini.
const OPENAI_ID = /^([a-z]+(?:-[a-z]+)*?)-?(\d+(?:\.\d+)*)(?:-([a-z][a-z0-9-]*))?$/;

function claudeFull(id: string): { name: string; long: boolean; version: number[] } | null {
  const m = CLAUDE_ID.exec(id);
  if (m) return { name: m[1], long: !!m[4], version: m[3] === undefined ? [Number(m[2])] : [Number(m[2]), Number(m[3])] };
  const o = CLAUDE_ID_OLD.exec(id);
  return o ? { name: o[3], long: !!o[4], version: o[2] === undefined ? [Number(o[1])] : [Number(o[1]), Number(o[2])] } : null;
}

/**
 * The family a model belongs to, and its version when the id (or, for a Claude picker name, the model it runs) says.
 *   claude: `opus` → opus (version from `resolved`), `claude-fable-5-1[1m]` and `fable[1m]` → fable[1m]
 *   openai: `gpt-6.1-sol` → gpt-sol 6.1, `gpt-6-astra` → gpt-astra 6, `gpt-5.5` → gpt 5.5, `o4-mini` → o-mini 4
 * The long-context variant ([1m]) is its own family: Opus and Opus 1M sit side by side, neither replaces the other.
 * An id that fits no pattern is a family of one with no version, so nothing ever replaces it.
 */
export function modelFamily(maker: Maker, id: unknown, resolved?: unknown): { family: string; version: number[] | null } {
  const s = text(id);
  if (maker === 'claude') {
    const full = claudeFull(s);
    if (full) return { family: full.name + (full.long ? '[1m]' : ''), version: full.version };
    const alias = CLAUDE_ALIAS.exec(s);
    if (alias) {
      const runs = claudeFull(text(resolved));
      return { family: s, version: runs && runs.name === alias[1] ? runs.version : null };
    }
    return { family: s, version: null };
  }
  const m = OPENAI_ID.exec(s);
  if (!m) return { family: s, version: null };
  return { family: m[3] ? `${m[1]}-${m[3]}` : m[1], version: m[2].split('.').map(Number) };
}

/** 1 when `a` is the newer version, -1 when `b` is, 0 when they are the same or either is unknown. 6.1 is newer than 6. */
export function compareVersions(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const familyKey = (m: Pick<Model, 'maker' | 'family'>) => `${m.maker}:${m.family}`;
/** The newest model of every family in the list, by `maker:family`. Of two the same, the one listed first. */
function newestOfEach(list: Model[]): Map<string, Model> {
  const newest = new Map<string, Model>();
  for (const m of list) {
    const best = newest.get(familyKey(m));
    if (!best || compareVersions(m.version, best.version) > 0) newest.set(familyKey(m), m);
  }
  return newest;
}
/** The family of a saved key, as `maker:family`. Works for a model that is no longer listed. */
function familyOfKey(key: string): string | null {
  const k = parseKey(key);
  return k ? `${k.maker}:${modelFamily(k.maker, k.id).family}` : null;
}

/**
 * Every model of both makers, Claude's first, each maker's in its own order.
 * `claude` are Claude Code's picker rows (lib/engines.ts `claudeRows`), `openai` the rows read from Codex (empty
 * when Codex is missing or signed out: the list is then Claude's alone).
 *
 * Claude: the "default" row is not a row of its own; the model it runs is marked `isDefault` instead, as the menu has
 * always drawn it. With nothing listed yet there is one row, "Default", with the empty id.
 * OpenAI: a model's stops are the ones of the scale it reports; a level outside the scale is not offered.
 */
export function allModels(claude: unknown, openai: unknown): Model[] {
  const out: Model[] = [];
  const seen = new Set<string>();
  const add = (m: Model) => { if (!seen.has(m.key)) { seen.add(m.key); out.push(m); } };

  const rows = rowsOf<ClaudeModel>(claude);
  const def = rows.find((m) => m.value === 'default');
  const own = rows.filter((m) => m.value !== 'default');
  // Claude Code marks the models that have Fast (true) and leaves the rest unmarked. One that marks none is too old
  // to say, and then every model is taken to have it.
  const fastKnown = rows.some((m) => m.supportsFastMode === true);
  let marked = false;
  for (const m of own) {
    const resolved = text(m.resolvedModel) || null;
    const isDefault = !marked && !!resolved && resolved === text(def?.resolvedModel);
    if (isDefault) marked = true;
    add({
      key: modelKey('claude', m.value), id: m.value, maker: 'claude', engine: 'claude', label: claudeLabel(m), description: text(m.description),
      isDefault, efforts: CLAUDE_EFFORTS, defaultEffort: CLAUDE_DEFAULT_EFFORT, fast: !fastKnown || m.supportsFastMode === true,
      ...modelFamily('claude', m.value, resolved), resolved,
    });
  }
  if (!own.length) {
    add({
      key: modelKey('claude', ''), id: '', maker: 'claude', engine: 'claude', label: 'Default', description: '',
      isDefault: true, efforts: CLAUDE_EFFORTS, defaultEffort: CLAUDE_DEFAULT_EFFORT, fast: true, family: '', version: null, resolved: text(def?.resolvedModel) || null,
    });
  }

  for (const m of rowsOf<CodexModel>(openai)) {
    const levels = m.supportsEffort === false || !Array.isArray(m.supportedEffortLevels) ? [] : m.supportedEffortLevels;
    const efforts = EFFORT_SCALE.filter((e) => levels.includes(e));
    add({
      key: modelKey('openai', m.value), id: m.value, maker: 'openai', engine: 'codex', label: text(m.displayName) || m.value, description: text(m.description),
      isDefault: m.isDefault === true, efforts, defaultEffort: isEffort(m.defaultEffort) && efforts.includes(m.defaultEffort) ? m.defaultEffort : null,
      fast: m.supportsFastMode === true, ...modelFamily('openai', m.value), resolved: null,
    });
  }
  return out;
}

// ---------- the menu's four rows ----------

/** How many model rows the menu has. Never fewer while there are that many models, never more. */
export const MENU_ROWS = 4;

/** Whose model each of the four is before you have arranged them, and the families that come first for each maker.
 *  Together: Opus, GPT Sol, Fable, GPT Astra, each as its newest version. A maker's list that no longer has one of
 *  these families gives the row to its next one (for OpenAI the family of Codex's own default), so this never has to
 *  be kept up for the menu to stay full. */
const DEFAULT_MAKERS: Maker[] = ['claude', 'openai', 'claude', 'openai'];
const FIRST_FAMILIES: Record<Maker, string[]> = { claude: ['opus', 'fable'], openai: ['gpt-sol', 'gpt-astra'] };

/**
 * One of the four rows, as saved: the model that was put there. The row is its family's and shows the family's
 * newest version, unless `exact`: a model that was already an older version when you put it there, kept as itself.
 */
export type Slot = { key: string; exact?: boolean };

/** What is kept about the menu: only what you arranged by hand. Keys, never rows. */
export type SavedModels = {
  /** The four rows in your order, from the first time you dragged one. Empty: the default four. */
  slots: Slot[];
  /**
   * What the switches of the first Settings > Models saved, before the menu had four rows: the models you switched on
   * (`on`) and the rows you switched off (`off`). It decides the four until you arrange them, and is then dropped.
   */
  before: { on: Slot[]; off: string[] } | null;
};
export const NO_SAVED_MODELS: SavedModels = { slots: [], before: null };
const SAVED_MAX = 200;
const keys = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((k): k is string => !!parseKey(k)))].slice(-SAVED_MAX) : []);
function slotsOf(v: unknown, most = SAVED_MAX): Slot[] {
  const out: Slot[] = [];
  for (const o of Array.isArray(v) ? v : []) {
    if (!isPlain(o) || !parseKey(o.key) || out.some((x) => x.key === o.key)) continue;
    out.push(o.exact === true ? { key: o.key as string, exact: true } : { key: o.key as string });
  }
  return out.slice(0, most);
}
/**
 * Whatever was stored, as a SavedModels. Anything unreadable is the empty one.
 * The first Settings > Models saved `{ added, followed, hidden, order }`: a model you switched on while it was its
 * family's newest (`followed`), an older version you switched on (`added`), and a row you switched off (`hidden`).
 * Those are read as `before`. Its `order` was never written by anything, and is not read.
 */
export function readSaved(raw: unknown): SavedModels {
  const o = isPlain(raw) ? raw : {};
  const slots = slotsOf(o.slots, MENU_ROWS);
  if (slots.length) return { slots, before: null };
  const b = isPlain(o.before) ? o.before : null;
  const on = b ? slotsOf(b.on) : slotsOf([...keys(o.followed).map((key) => ({ key })), ...keys(o.added).map((key) => ({ key, exact: true }))]);
  const off = keys(b ? b.off : o.hidden);
  return { slots: [], before: on.length || off.length ? { on, off } : null };
}

// "fable[1m]" is the long-context Fable: for "Claude's Fable row" it counts as Fable.
const plainFamily = (family: string) => family.replace(/\[1m\]$/, '');

/**
 * One model per family (its newest version), in the order they are offered a free row: for each maker the families
 * named in FIRST_FAMILIES, then the family of the maker's own default, then the rest as the maker lists them.
 * Claude's first.
 */
function inLine(list: Model[]): Model[] {
  const newest = newestOfEach(list);
  const heads = list.filter((m) => newest.get(familyKey(m)) === m);
  const out: Model[] = [];
  for (const maker of MAKERS) {
    const own = heads.filter((m) => m.maker === maker);
    const named = FIRST_FAMILIES[maker].map((f) => own.find((m) => plainFamily(m.family) === f)).filter((m): m is Model => !!m);
    const def = list.find((m) => m.maker === maker && m.isDefault);
    out.push(...new Set([...named, ...own.filter((m) => m.family === def?.family), ...own]));
  }
  return out;
}

/**
 * Seat the four. `wants` says what each row should hold: a model, or a maker, meaning "that maker's next model".
 * A model keeps the row it is given. A maker's row gets the first model not yet seated from `lines` (each a list
 * to take from, tried in turn): one of that maker's when the list has any, else the other maker's. That is what
 * keeps four rows on screen when a maker has nothing to offer (Codex missing: four Claude rows).
 */
function seat(wants: (Model | Maker)[], lines: Model[][]): Model[] {
  const rows = wants.slice(0, MENU_ROWS);
  while (rows.length < MENU_ROWS) rows.push(DEFAULT_MAKERS[rows.length]);
  const seated = new Set<Model>();
  // A model named twice keeps its first row; the second is its maker's to fill.
  rows.forEach((r, i) => { if (typeof r === 'string') return; if (seated.has(r)) rows[i] = r.maker; else seated.add(r); });
  const next = (maker: Maker): Model | null => {
    for (const line of lines) {
      const m = line.find((x) => x.maker === maker && !seated.has(x)) ?? line.find((x) => !seated.has(x));
      if (m) return m;
    }
    return null;
  };
  const out: Model[] = [];
  for (const r of rows) {
    const m = typeof r === 'string' ? next(r) : r;
    if (m) { seated.add(m); out.push(m); }
  }
  return out;
}

/**
 * The menu's four rows, in order.
 *
 * Nothing saved: the default four, Claude's first model in line, OpenAI's first, Claude's second, OpenAI's second
 * (Opus, GPT Sol, Fable, GPT Astra today), each the newest version of its family. With no OpenAI models to offer
 * the rows go to Claude's next ones: Opus, Fable, Sonnet, Haiku.
 * Arranged by you (`slots`): each row is the model you put there, as its family's newest version unless it was an
 * older one when you put it there. A row whose model is not listed right now is filled, in place, by the next model
 * in line of the same maker when there is one. Nothing is saved about that, so the row is yours again when its
 * model is back.
 * From the first Settings page (`before`): the models you had switched on keep a row (the last ones), the others
 * are the default four without the rows you had switched off.
 *
 * Fewer than four only when there are fewer than four models in all.
 */
export function menuRows(all: Model[], saved: SavedModels = NO_SAVED_MODELS): Model[] {
  const list = Array.isArray(all) ? all : [];
  const s = readSaved(saved);
  const line = inLine(list);
  const newest = newestOfEach(list);
  const find = (slot: Slot): Model | null => (slot.exact ? list.find((m) => m.key === slot.key) : newest.get(familyOfKey(slot.key) ?? '')) ?? null;
  if (s.slots.length) return seat(s.slots.map((slot) => find(slot) ?? parseKey(slot.key)!.maker), [line, list]);
  if (!s.before) return seat(DEFAULT_MAKERS, [line, list]);
  const on = s.before.on.map(find).filter((m): m is Model => !!m).slice(-MENU_ROWS);
  const off = new Set(s.before.off.map(familyOfKey));
  const kept = (m: Model) => !off.has(familyKey(m));
  // The rows that menu showed by itself: every Claude model and OpenAI's first two families.
  const shown = line.filter((m) => m.maker === 'claude' || line.filter((x) => x.maker === 'openai').indexOf(m) < 2);
  return seat([...DEFAULT_MAKERS.slice(0, MENU_ROWS - on.length), ...on], [shown.filter(kept), line.filter(kept), line, list]);
}

/** The menu, split: its four `rows`, and `more`, every other model in the makers' own order (the More models submenu). */
export function splitMenu(all: Model[], saved: SavedModels = NO_SAVED_MODELS): { rows: Model[]; more: Model[] } {
  const list = Array.isArray(all) ? all : [];
  const rows = menuRows(list, saved);
  return { rows, more: list.filter((m) => !rows.includes(m)) };
}

/** Where a dragged row is let go: on one of the four (`row`, its place from the top), or on another model (`more`, its key). */
export type DropTarget = { row: number } | { more: string };

/**
 * The four after a drag. `rows` are the four as they are, `dragged` the key of the model that was dragged.
 *   - One of the four onto another of the four: it moves there and the rows between shift by one.
 *   - Another model onto one of the four: it takes that row. The model it displaces is no longer one of the four.
 *   - One of the four onto another model: that model takes its row. The dragged one is no longer one of the four.
 * Anything else (let go over nothing, a model that is not one of the four onto another that is not) changes nothing.
 * Always the same number of rows as it was given, never a model twice.
 */
export function dragModel(rows: Model[], all: Model[], dragged: string, onto: DropTarget | null | undefined): Model[] {
  const four = Array.isArray(rows) ? rows : [];
  const list = Array.isArray(all) ? all : [];
  const from = four.findIndex((m) => m.key === dragged);
  if (!isPlain(onto)) return four;
  if ('row' in onto) {
    const to = onto.row;
    if (!Number.isInteger(to) || to < 0 || to >= four.length || to === from) return four;
    const next = [...four];
    if (from >= 0) { next.splice(to, 0, next.splice(from, 1)[0]); return next; }
    const model = list.find((m) => m.key === dragged);
    if (!model) return four;
    next[to] = model;
    return next;
  }
  const other = list.find((m) => m.key === onto.more);
  if (from < 0 || !other || four.includes(other)) return four;
  const next = [...four];
  next[from] = other;
  return next;
}

/**
 * What to save for the four as they are now arranged. Each row is saved as its model; one that is the newest of its
 * family is the family's row from then on (its next version takes it), any other is kept as exactly itself.
 * What the first Settings page saved (`before`) has done its work by now, and is dropped.
 */
export function slotsFor(rows: Model[], all: Model[]): SavedModels {
  const newest = newestOfEach(Array.isArray(all) ? all : []);
  const slots = (Array.isArray(rows) ? rows : []).slice(0, MENU_ROWS).map((m): Slot => (newest.get(familyKey(m)) === m ? { key: m.key } : { key: m.key, exact: true }));
  return { slots, before: null };
}

// ---------- search ----------

const MAKER_WORDS: Record<Maker, string[]> = { claude: ['claude', 'anthropic'], openai: ['openai', 'gpt', 'chatgpt', 'codex'] };
// "GPT-6.1-Sol" → gpt, 6.1, sol. A dot between digits stays, so "5.5" is one word and never matches 5.6.
const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\.(?!\d)|(?<!\d)\./g, ' ').split(' ').filter(Boolean);

// Does `w` start at the beginning of one of these words, running on into the next ones? "gpt6" starts GPT-6.1-Sol
// (gpt, 6.1, sol) and not GPT-5.6-Sol; "6" starts 6.1 and never the 6 inside 5.6.
const startsAt = (parts: string[], w: string) => parts.some((_, i) => parts.slice(i).join('').startsWith(w));

/**
 * The search field. Every word typed has to match the model: the start of a word of its name (best, and words may be
 * run together: "gpt6", "opus5.5"), the same of its id, its maker ("openai", "anthropic"), or the start of a word of
 * its description ("fast"). Best matches first, otherwise the list's own order. Nothing typed: every model.
 */
export function searchModels(all: Model[], query: unknown): Model[] {
  const list = Array.isArray(all) ? all : [];
  const typed = words(text(query));
  if (!typed.length) return list;
  const hits: { m: Model; score: number; i: number }[] = [];
  list.forEach((m, i) => {
    const name = words(m.label), id = words(m.id), about = words(m.description);
    let score = 0;
    for (const w of typed) {
      const s = startsAt(name, w) ? 4
        : startsAt(id, w) ? 3
        : MAKER_WORDS[m.maker].some((x) => x.startsWith(w)) ? 2
        : about.some((x) => x.startsWith(w)) ? 1 : 0;
      if (!s) return;
      score += s;
    }
    hits.push({ m, score, i });
  });
  return hits.sort((a, b) => b.score - a.score || a.i - b.i).map((h) => h.m);
}

// ---------- your picks ----------

/** The saved choices these rules read (the shape of lib/choices.ts). Top-level ones are Claude's; `codex` holds OpenAI's. */
export type Picks = {
  engine?: 'codex'; model?: string; effort?: string; fast?: boolean; ultracode?: boolean;
  codex?: { model?: string; effort?: string; fast?: boolean };
};
const picksOf = (p: Picks | null | undefined): Picks => (isPlain(p) ? p : {});

/**
 * The stop you chose for this model's maker, if the model offers it. Null: nothing chosen (the model's own default).
 * Claude's Ultra is saved as ultracode, not as an effort: this is the one place that reads it back.
 */
export function pickedEffort(model: Pick<Model, 'maker' | 'efforts'> | null | undefined, picks: Picks | null | undefined): Effort | null {
  if (!model) return null;
  const p = picksOf(picks);
  const level = model.maker === 'openai' ? p.codex?.effort : p.ultracode ? 'ultra' : p.effort;
  return isEffort(level) && model.efforts.includes(level) ? level : null;
}

/**
 * Where the slider sits: the stop you chose, else the one the chat says it runs with (OpenAI chats report it), else
 * the model's own default, else the middle stop. Null: the model has no stops, so there is no slider.
 */
export function effortLevel(model: Pick<Model, 'maker' | 'efforts' | 'defaultEffort'> | null | undefined, picks: Picks | null | undefined, reported?: string | null): Effort | null {
  if (!model?.efforts.length) return null;
  const picked = pickedEffort(model, picks);
  if (picked) return picked;
  if (isEffort(reported) && model.efforts.includes(reported)) return reported;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return model.efforts[Math.floor((model.efforts.length - 1) / 2)];
}

/**
 * What a chat is told for a stop of the scale (`null`: back to the model's default).
 * Ultra means the same thing on both makers, the most effort plus handing work to helper agents, and each maker has
 * its own switch for it: Claude Code's is ultracode (at max effort), Codex's is its own `ultra` level.
 * `ultracode` is only in the answer for Claude: it is never sent to an OpenAI chat.
 */
export function effortSettings(model: Pick<Model, 'maker'>, level: Effort | null): { effort: string; ultracode?: boolean } {
  if (model.maker === 'openai') return { effort: level ?? '' };
  return level === 'ultra' ? { effort: 'max', ultracode: true } : { effort: level ?? '', ultracode: false };
}

/**
 * What to save when a stop is chosen on the slider. There is no Reset: the stop marked as the model's own default
 * means "follow the model", so choosing it saves nothing (null) and the model's default moves with the model.
 * A model that names no default has no such stop; every stop on it is a choice.
 * `resting`: where the slider sits while nothing is chosen (leave it out when a level is chosen). An OpenAI chat can
 * rest somewhere else than the model's default (your own Codex setting says High, the model's default is Low):
 * following the model evidently does not give the default stop there, so choosing that stop is a choice like any other.
 */
export function chosenLevel(model: Pick<Model, 'defaultEffort'> | null | undefined, level: Effort, resting?: Effort | null): Effort | null {
  return model?.defaultEffort === level && (resting == null || resting === level) ? null : level;
}

/** Everything the effort slider (effort-slider.tsx) is given for a model, so the menu and Settings draw the same one.
 *  `stops[i]` is the level behind the slider's index i. Null: no slider (fewer than two stops). */
export function effortSlider(model: Pick<Model, 'maker' | 'efforts' | 'defaultEffort'> | null | undefined, picks: Picks | null | undefined, reported?: string | null):
  { stops: Effort[]; labels: string[]; index: number; isDefault: boolean; ultraAt: number; defaultAt: number } | null {
  const level = effortLevel(model, picks, reported);
  if (!model || !level || model.efforts.length < 2) return null;
  return {
    stops: model.efforts, labels: model.efforts.map(effortShort), index: model.efforts.indexOf(level), isDefault: !pickedEffort(model, picks),
    ultraAt: model.efforts.indexOf('ultra'), defaultAt: model.defaultEffort ? model.efforts.indexOf(model.defaultEffort) : -1,
  };
}
/** A stop's full name, for the chip and the chat menu: "Extra High". */
export const effortLabel = (level: Effort): string => effortName(level);

/** Your Fast choice for this model's maker. Null: not chosen (the maker's own setting decides). A model with no
 *  faster tier is never on. */
export function pickedFast(model: Pick<Model, 'maker' | 'fast'> | null | undefined, picks: Picks | null | undefined): boolean | null {
  if (!model) return null;
  const v = model.maker === 'openai' ? picksOf(picks).codex?.fast : picksOf(picks).fast;
  return typeof v === 'boolean' ? v && model.fast : null;
}

/**
 * The value to save when a model row is picked. Claude's default row, picked while no Claude model is chosen, saves
 * nothing ('' is "Claude Code's own default", which follows Claude Code when its default moves); every other pick
 * saves the row's id.
 * `running`: the model the chat on screen runs (`chatModel`). A Claude chat that runs another model than the default
 * (one started elsewhere on Fable) has to be told the default by name, or picking it would change nothing.
 */
export function pickValue(model: Pick<Model, 'maker' | 'id' | 'isDefault' | 'key'>, picks: Picks | null | undefined, running?: Pick<Model, 'maker' | 'key'> | null): string {
  const elsewhere = !!running && running.maker === 'claude' && running.key !== model.key;
  return model.maker === 'claude' && model.isDefault && !picksOf(picks).model && !elsewhere ? '' : model.id;
}

/**
 * The model a chat runs on, for the tick, the logo and the slider's stops. `chat` is the chat's engine and the model
 * it reports (store `meta`).
 * Claude: your pick, else the row that runs the model the chat reports, else Claude Code's default.
 * OpenAI: your pick, else the model the chat reports, else Codex's default when neither is known.
 * Null when the model is not in the lists (a pick that is no longer offered, a list not read yet).
 */
export function chatModel(all: Model[], chat: { engine?: Engine | string | null; model?: string | null } | null | undefined, picks: Picks | null | undefined): Model | null {
  const maker = engineMaker(chat?.engine);
  const rows = (Array.isArray(all) ? all : []).filter((m) => m.maker === maker);
  const p = picksOf(picks);
  const byId = (id: string | null | undefined) => (id ? rows.find((m) => m.id === id) ?? null : null);
  const fallback = () => rows.find((m) => m.isDefault) ?? null;
  if (maker === 'openai') return byId(p.codex?.model) ?? byId(chat?.model) ?? (p.codex?.model || chat?.model ? null : fallback());
  if (p.model) return byId(p.model);
  return (chat?.model ? rows.find((m) => m.resolved === chat.model) : null) ?? fallback();
}

/**
 * What new chats start with: the maker you picked last (Claude when OpenAI has no models to offer), its model, the
 * effort and Fast you chose for that maker. `effort` and `fast` are null where you chose nothing; `level` is where
 * the slider sits either way.
 */
export function startsWith(all: Model[], picks: Picks | null | undefined): { maker: Maker; model: Model | null; effort: Effort | null; level: Effort | null; fast: boolean | null } {
  const list = Array.isArray(all) ? all : [];
  const maker: Maker = picksOf(picks).engine === 'codex' && list.some((m) => m.maker === 'openai') ? 'openai' : 'claude';
  const model = chatModel(list, { engine: makerEngine(maker), model: null }, picks);
  return { maker, model, effort: pickedEffort(model, picks), level: effortLevel(model, picks), fast: pickedFast(model, picks) };
}

// ---------- each maker's status (Settings > Models) ----------

/** Where "Set up OpenAI models" leads: OpenAI's own page on installing Codex and signing in. */
export const OPENAI_SETUP_URL = 'https://developers.openai.com/codex/cli';

/** One maker's line in Settings > Models. `line` is empty while nothing is known yet. `setup` is set when its models
 *  are known not to be there to pick: the label of the one quiet row that says what to do, with `hint` under it.
 *  `signIn`: that row starts Codex's own sign-in here, instead of opening OpenAI's page about setting Codex up. */
export type MakerStatus = {
  maker: Maker; name: string; ready: boolean; line: string; setup: string | null; hint: string | null; signIn?: boolean;
  /** OpenAI only: the model list file Codex is set to, when it is. New models can't arrive while it is. */
  fixedList?: string;
};

/**
 * The status line for each maker, Claude's first. `claude` is Claude Code's sign-in (EnvInfo.auth), `codex` what
 * `models:list` says about Codex (`method` is how it is signed in: `apiKey`, `chatgpt`), `openaiModels` how many
 * OpenAI models are listed.
 *
 * What is not known yet is never said as a fact. Claude: "Signed in" only when Claude Code said so; before the
 * window has heard at all (`claude` missing) the line is empty; a check that did not answer reads "Not signed in",
 * which is how the rest of the window treats it.
 * OpenAI: until main has answered about Codex (`codex` missing) and with no models listed, the line is empty and no
 * setup row is offered. "Set up OpenAI models" only shows once main has said Codex is missing or silent.
 * Codex here but known to have no login that works (`signedIn` false: signed out, or a login OpenAI refused, as
 * its accounts in Settings have it) reads "Not signed in" whether or not models are still listed, and its row signs in.
 * When what OpenAI's chats use is an API key pasted into Canopy and that key needs the user (`signedIn` false with
 * the key's `method`), the line says so and no sign-in is offered: Codex's sign-in would not fix a key, and the
 * key's own row on Settings' Codex page has the way out.
 */
export function makerStatus(
  claude: { loggedIn?: boolean | null; method?: string | null } | null | undefined,
  codex: { installed?: boolean; signedIn?: boolean | null; method?: string | null; fixedList?: string | null } | null | undefined,
  openaiModels = 0,
): MakerStatus[] {
  const withKey = (method: unknown) => /api.?key/i.test(text(method));
  const signed = (method: unknown) => (withKey(method) ? 'Signed in with an API key' : 'Signed in');
  const c = isPlain(claude) ? claude : null;
  const claudeLine: MakerStatus = { maker: 'claude', name: MAKER_NAME.claude, ready: c?.loggedIn === true, line: !c ? '' : c.loggedIn === true ? signed(c.method) : 'Not signed in', setup: null, hint: null };

  const x = isPlain(codex) ? codex : null;
  const openai = (ready: boolean, line: string, hint: string | null = null): MakerStatus =>
    ({ maker: 'openai', name: MAKER_NAME.openai, ready, line, setup: hint ? 'Set up OpenAI models' : null, hint });
  const later = 'Its models show up here on their own.';
  let openaiLine: MakerStatus;
  if (x && x.installed !== false && x.signedIn === false) {
    openaiLine = withKey(x.method) ? openai(false, 'API key needs attention')
      : { ...openai(false, 'Not signed in', openaiModels > 0 ? 'OpenAI’s models work again once Codex is signed in.' : later), setup: 'Sign in to Codex', signIn: true };
  } else if (openaiModels > 0) openaiLine = openai(true, signed(x?.method));
  else if (!x) openaiLine = openai(false, '');
  else if (x.installed === false) openaiLine = openai(false, 'Not set up', `Install Codex and sign in. ${later}`);
  else openaiLine = openai(false, 'Not answering', `Codex is installed but did not list its models. ${later}`);
  const fixed = text(x?.fixedList).trim();
  if (fixed && openaiModels > 0) openaiLine = { ...openaiLine, fixedList: fixed };
  return [claudeLine, openaiLine];
}

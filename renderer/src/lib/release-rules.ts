// New models: the rules behind the sidebar's "GPT-6.2 is out" card and the "New" beside a model in Settings > Models.
// Nothing here reads the window or throws; lib/releases.ts keeps the state and feeds it the lists.
//
//   noticeReleases(state, all, now)   what is new in this list since the last one: a card for each maker that shipped
//   readReleases(raw)                 what was saved, or the empty state for anything else
//   dismissRelease(state, id)         a card put away (× or Try): it never comes back
//   isNew(state, model, now)          does Settings say "New" beside this model (for a week after it arrived)
//   releaseCards(state, all, inMenu)  the cards as the sidebar shows them: words, the model Try opens, newest first
//
// What counts as a release, so a card is news and never noise:
//  - A newer version of a family Canopy has already seen (GPT-6.1-Sol → GPT-6.2-Sol, Opus 5.5 → Opus 5.6).
//  - A family never seen before, but only if it is of the maker's newest generation: GPT-6.2-Terra is news, while a
//    GPT-5.5-Pro that an account switch suddenly lists is not.
//  - Nothing the first time a maker's list is read (a new install, Codex just set up): that list is what there is.
//  - A model with no version in its id is never news (its family has nothing to be newer than).
// Models a maker ships together share one card; one that arrives while that maker's card is still up joins it.
import { MAKERS, MAKER_NAME, compareVersions, type Maker, type Model } from './model-rules.ts';

/** One card: the models it is about (keys, in the maker's own order) and the ones they took the place of (labels). */
export type ReleaseNote = { id: string; maker: Maker; keys: string[]; replaced: string[]; at: number };
export type ReleaseState = {
  /** `maker:family` → the newest version of that family ever listed. */
  newest: Record<string, number[]>;
  /** Makers whose list has been read at least once (until then, nothing is news). */
  known: Maker[];
  /** Cards not put away yet, oldest first. */
  notes: ReleaseNote[];
  /** Model key → when it arrived. Kept a week, for "New" in Settings. */
  arrived: Record<string, number>;
};
export const NO_RELEASES: ReleaseState = Object.freeze({ newest: {}, known: [], notes: [], arrived: {} }) as ReleaseState;

/** How long Settings says "New" beside a model that arrived. */
export const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;

const isPlain = (o: unknown): o is Record<string, unknown> => o !== null && typeof o === 'object' && !Array.isArray(o);
const isVersion = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isFinite(n));
const isMaker = (v: unknown): v is Maker => (MAKERS as unknown[]).includes(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : []);
// The 1M-context variant of a Claude family ships with it: one release, not two.
const baseFamily = (family: string) => family.replace(/\[1m\]$/, '');

/** What was saved, kept only where it has the right shape. Anything else is the empty state. */
export function readReleases(raw: unknown): ReleaseState {
  if (!isPlain(raw)) return { newest: {}, known: [], notes: [], arrived: {} };
  const newest: Record<string, number[]> = {};
  if (isPlain(raw.newest)) for (const [k, v] of Object.entries(raw.newest)) if (isVersion(v)) newest[k] = [...v];
  const known = Array.isArray(raw.known) ? [...new Set(raw.known.filter(isMaker))] : [];
  const notes: ReleaseNote[] = [];
  if (Array.isArray(raw.notes)) {
    for (const n of raw.notes) {
      if (!isPlain(n) || typeof n.id !== 'string' || !isMaker(n.maker) || !Number.isFinite(n.at)) continue;
      const keys = strings(n.keys);
      if (keys.length) notes.push({ id: n.id, maker: n.maker, keys, replaced: strings(n.replaced), at: Number(n.at) });
    }
  }
  const arrived: Record<string, number> = {};
  if (isPlain(raw.arrived)) for (const [k, v] of Object.entries(raw.arrived)) if (Number.isFinite(v)) arrived[k] = Number(v);
  return { newest, known, notes, arrived };
}

/**
 * The state after reading `all` (lib/model-rules.ts `allModels`) at `now`. The same object back when nothing changed,
 * so the caller can tell whether to save. A maker with no versioned models in the list (Codex signed out, Claude Code
 * not listed yet) is skipped: missing is not the same as gone, and nothing it had is forgotten.
 */
export function noticeReleases(state: ReleaseState, all: Model[], now: number): ReleaseState {
  let next: ReleaseState | null = null;
  const edit = () => (next ??= { newest: { ...state.newest }, known: [...state.known], notes: state.notes.map((n) => ({ ...n })), arrived: { ...state.arrived } });

  for (const maker of MAKERS) {
    const mine = (Array.isArray(all) ? all : []).filter((m) => m?.maker === maker && m.id !== '' && isVersion(m.version));
    if (!mine.length) continue;
    // The newest of each family, in the maker's own order.
    const newestOf = new Map<string, Model>();
    for (const m of mine) {
      const fk = `${maker}:${m.family}`;
      const best = newestOf.get(fk);
      if (!best || compareVersions(m.version, best.version) > 0) newestOf.set(fk, m);
    }
    const s = next ?? state;
    if (!s.known.includes(maker)) {
      const n = edit();
      n.known.push(maker);
      for (const [fk, m] of newestOf) n.newest[fk] = [...m.version!];
      continue;
    }
    // The maker's newest generation so far: a family never seen is news only when it is of that generation or later.
    const generation = Math.max(0, ...Object.entries(s.newest).filter(([fk]) => fk.startsWith(`${maker}:`)).map(([, v]) => v[0]));
    const came: Model[] = [];
    const replaced: string[] = [];
    const bases = new Set<string>();
    for (const [fk, m] of newestOf) {
      const had = s.newest[fk];
      if (had && compareVersions(m.version, had) <= 0) continue;
      const n = edit();
      n.newest[fk] = [...m.version!];
      if (!had && m.version![0] < generation) continue; // an older family this list shows for the first time: not news
      const base = baseFamily(m.family);
      if (bases.has(base)) continue;
      bases.add(base);
      came.push(m);
      if (had) {
        // The one it replaces, by its own label when it is still listed. Claude's "opus" moves to the new version and
        // the old one is gone from the list: its name is the new one's with the old version (Opus 5.6 → Opus 5.5).
        const before = mine.find((o) => o.family === m.family && compareVersions(o.version, had) === 0);
        const was = before?.label ?? (m.label.includes(m.version!.join('.')) ? m.label.replace(m.version!.join('.'), had.join('.')) : null);
        if (was) replaced.push(was);
      }
    }
    if (!came.length) continue;
    const n = edit();
    for (const m of came) n.arrived[m.key] = now;
    const open = n.notes.find((x) => x.maker === maker);
    if (open) {
      for (const m of came) if (!open.keys.includes(m.key)) open.keys.push(m.key);
      for (const r of replaced) if (!open.replaced.includes(r)) open.replaced.push(r);
      open.at = now;
    } else {
      n.notes.push({ id: `${maker}:${now}`, maker, keys: came.map((m) => m.key), replaced, at: now });
    }
  }

  // "New" lasts a week.
  const stale = Object.entries((next ?? state).arrived).filter(([, at]) => now - at >= NEW_FOR_MS);
  if (stale.length) { const n = edit(); for (const [k] of stale) delete n.arrived[k]; }
  return next ?? state;
}

/** The state with a card put away. The same object back when there was no such card. */
export function dismissRelease(state: ReleaseState, id: string): ReleaseState {
  if (!state.notes.some((n) => n.id === id)) return state;
  return { ...state, notes: state.notes.filter((n) => n.id !== id) };
}

// Is this the release itself, or an older version under the same name? Claude's `opus` runs whatever is newest, and a
// list read on another account can run an older one: only the version that arrived is news.
const current = (state: ReleaseState, m: Pick<Model, 'maker' | 'family' | 'version'>) =>
  compareVersions(m.version, state.newest[`${m.maker}:${m.family}`]) >= 0;

/** Does Settings say "New" beside this model? For a week after it arrived, while it is the version that arrived. */
export function isNew(state: ReleaseState, model: Pick<Model, 'key' | 'maker' | 'family' | 'version'>, now: number): boolean {
  const at = state.arrived[model.key];
  return Number.isFinite(at) && now - at < NEW_FOR_MS && current(state, model);
}

// ---------- the words ----------

export type ReleaseCard = { id: string; maker: Maker; title: string; body: string; tryKey: string; tryLabel: string; at: number };

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
// The version an OpenAI label carries and the name after it: GPT-6.2-Sol → 6.2, Sol. GPT-5.5 → 5.5, ''.
const OPENAI_LABEL = /^GPT-(\d+(?:\.\d+)*)(?:[- ](.+))?$/i;
// A label without the maker's prefix where the prefix says nothing the card hasn't: GPT-6.1-Sol → 6.1-Sol.
const short = (label: string) => label.replace(/^GPT-/i, '');

/**
 * The cards the sidebar shows, newest first. `inMenu`: the keys of the menu's four rows right now, so the card can
 * say where to find the models. A card whose models are no longer listed (or listed at an older version) is not shown
 * (it stays saved; it is back if they are). Try opens the first of its models that is listed, in the maker's own order.
 */
export function releaseCards(state: ReleaseState, all: Model[], inMenu: ReadonlySet<string>): ReleaseCard[] {
  const byKey = new Map((Array.isArray(all) ? all : []).map((m) => [m.key, m]));
  const cards: ReleaseCard[] = [];
  for (const note of state.notes) {
    const models = note.keys.map((k) => byKey.get(k)).filter((m): m is Model => !!m && current(state, m));
    if (!models.length) continue;
    const labels = models.map((m) => m.label);
    const parts = note.maker === 'openai' ? labels.map((l) => OPENAI_LABEL.exec(l)) : [];
    const oneVersion = parts.length > 1 && parts.every((p) => p && p[2] && p[1] === parts[0]![1]);
    const title = models.length === 1 ? `${labels[0]} is out`
      : oneVersion ? `GPT-${parts[0]![1]} is out`
      : `New ${MAKER_NAME[note.maker]} models`;
    const who = models.length === 1 ? 'It' : oneVersion ? list(parts.map((p) => p![2])) : list(labels);
    const verb = models.length === 1 ? 'is' : 'are';
    const allInMenu = models.every((m) => inMenu.has(m.key));
    const instead = allInMenu && note.replaced.length ? `, in place of ${list(note.replaced.map(short))}` : '';
    const body = allInMenu ? `${who} ${verb} in your model menu now${instead}.`
      : models.some((m) => inMenu.has(m.key)) ? `${who} ${verb} in the model menu.`
      : `${who} ${verb} in the model menu, under More models.`;
    cards.push({ id: note.id, maker: note.maker, title, body, tryKey: models[0].key, tryLabel: labels[0], at: note.at });
  }
  return cards.sort((a, b) => b.at - a.at);
}

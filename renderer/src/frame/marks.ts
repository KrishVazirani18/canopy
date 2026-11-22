// The thinking behind the building blocks that is not drawing: which option a preview shows, what is under a note
// pinned on a design and how to say it, where the next item in a ranking goes. No DOM here, so node tests import
// this file as it is (src/core/test/unit/frame-blocks.test.mjs). Only syntax that can be erased.

/**
 * What a pick's preview shows: the option pointed at (hovered, else focused), else the one picked last, else the
 * recommended one, else the first. Only names that are options count.
 */
export function shownOption(options: string[], s: { hovered?: string | null; focused?: string | null; picked?: string[]; recommended?: string | null }): string | null {
  const has = (x: string | null | undefined): x is string => !!x && options.includes(x);
  if (has(s.hovered)) return s.hovered;
  if (has(s.focused)) return s.focused;
  const last = [...(s.picked ?? [])].reverse().find(has);
  if (last) return last;
  if (has(s.recommended)) return s.recommended;
  return options[0] ?? null;
}

/** Picking `name`: one replaces the pick, several toggles it. */
export function togglePick(picked: string[], name: string, multiple: boolean): string[] {
  if (!multiple) return [name];
  return picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name];
}

/** Words cut to about `max` characters, at a word when one ends near, with an ellipsis. Whitespace is collapsed. */
export function cut(text: string | null | undefined, max = 60): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,.;:–—-]+$/, '')}…`;
}

export type Described = { tag?: string | null; role?: string | null; text?: string | null; selector?: string | null };

/** An element in words a model can find it by: `"Calm software for…" (h1)`, else its selector, else its tag. */
export function describeElement(el: Described | null | undefined): string {
  if (!el) return 'the design';
  const kind = (el.role || el.tag || '').trim().toLowerCase();
  const text = cut(el.text);
  if (text) return kind ? `"${text}" (${kind})` : `"${text}"`;
  if (el.selector) return el.selector;
  return kind ? `the ${kind}` : 'the design';
}

/** A note's subject: a pin names what is under it, a box what it is drawn around. */
export const noteSubject = (kind: 'pin' | 'box', el: Described | null | undefined) => (kind === 'box' ? `Box around ${describeElement(el)}` : describeElement(el));

/** A box around several things names up to three of them: `Box around "Download" (button), "Watch" (button)`. */
export function boxSubject(els: Described[]): string {
  if (els.length <= 1) return noteSubject('box', els[0]);
  const named = els.slice(0, 3).map(describeElement).join(', ');
  return `Box around ${named}${els.length > 3 ? ` and ${els.length - 3} more` : ''}`;
}

type Rect = { x: number; y: number; w: number; h: number };
const within = (e: Rect, b: Rect, share: number) => {
  const a = Math.max(0, e.w) * Math.max(0, e.h);
  if (!a) return false;
  const o = Math.max(0, Math.min(e.x + e.w, b.x + b.w) - Math.max(e.x, b.x)) * Math.max(0, Math.min(e.y + e.h, b.y + b.h) - Math.max(e.y, b.y));
  return o >= a * share;
};

/**
 * The things a box was drawn around: the elements that are (nearly) all inside it and say something, leaving out any
 * that sit inside another of them, top to bottom. A box drawn around two buttons gives the two buttons, or the row
 * that holds them when the row fits in the box too.
 */
export function inBox<T extends Rect & Described>(els: T[] | null | undefined, b: Rect, contains: (outer: T, inner: T) => boolean = (o, i) => within(i, o, 0.98)): T[] {
  const inside = (els ?? []).filter((e) => e && within(e, b, 0.8) && ((e.text ?? '').trim() || e.role));
  // Two that hold each other (the same rect twice) keep the first.
  return inside.filter((e, i) => !inside.some((o, j) => o !== e && contains(o, e) && (!contains(e, o) || j < i))).sort((a, z) => a.y - z.y || a.x - z.x);
}

export type Mapped = Described & { x: number; y: number; w: number; h: number };

const area = (e: Mapped) => Math.max(0, e.w) * Math.max(0, e.h);
const inside = (e: Mapped, x: number, y: number) => x >= e.x && y >= e.y && x <= e.x + e.w && y <= e.y + e.h;

/**
 * The element of a screenshot's map under a point: the smallest one there that says something (text, or a role), else
 * the smallest one there at all. Coordinates are the map's own (CSS px of the picture).
 */
export function elementAt(map: Mapped[] | null | undefined, x: number, y: number): Mapped | null {
  const hits = (map ?? []).filter((e) => e && area(e) > 0 && inside(e, x, y)).sort((a, b) => area(a) - area(b));
  return hits.find((e) => (e.text ?? '').trim() || e.role) ?? hits[0] ?? null;
}

/** Move the item at `from` to `to` (both clamped), returning a new order. */
export function moveItem<T>(order: T[], from: number, to: number): T[] {
  const n = order.length;
  if (from < 0 || from >= n) return order.slice();
  const t = Math.max(0, Math.min(n - 1, to));
  const next = order.slice();
  const [it] = next.splice(from, 1);
  next.splice(t, 0, it);
  return next;
}

/** A remembered order brought up to date with the items there are now: known ones keep their place, new ones go last. */
export function reconcileOrder(saved: string[] | null | undefined, items: string[]): string[] {
  const known = (saved ?? []).filter((x, i, all) => items.includes(x) && all.indexOf(x) === i);
  return [...known, ...items.filter((x) => !known.includes(x))];
}

/** Where on a design a point is, in words: "top left", "middle", "bottom". For a note with nothing named under it. */
export function whereOn(x: number, y: number): string {
  const row = y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : '';
  const col = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : '';
  return [row, col].filter(Boolean).join(' ') || 'middle';
}

/** A fraction kept to 0..1, and rounded so remembered state stays small. */
export const unit = (v: number) => Math.round(Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 10000) / 10000;

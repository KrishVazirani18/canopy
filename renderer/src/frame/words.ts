// The words the building blocks send and show: a pick's message and button, a tune's values, a ranking, notes on a
// design. Plain text work with no DOM, so node tests import this file as it is (src/core/test/unit/frame-blocks.test.mjs).
// Only syntax that can be erased: node reads the TypeScript directly.

/** Put `{choice}` (the picks, joined) and `{count}` into a template. One without either gets the picks after it. */
export function fillPick(template: string | null | undefined, picks: string[]): string {
  const choice = picks.join(', ');
  const t = (template ?? '').trim();
  if (!t) return choice;
  if (!t.includes('{choice}') && !t.includes('{count}')) return `${t} ${choice}`;
  return t.replaceAll('{choice}', choice).replaceAll('{count}', String(picks.length));
}

/** A pick's button. Before anything is picked a template that names the pick has nothing to name, so it asks. */
export function pickButton(template: string | null | undefined, picks: string[], multiple: boolean): string {
  const t = (template ?? '').trim() || (multiple ? 'Use {count}' : 'Use {choice}');
  const names = t.includes('{choice}') || t.includes('{count}');
  if (!picks.length && names) return multiple ? 'Pick some' : 'Pick one';
  return t.replaceAll('{choice}', picks.join(', ')).replaceAll('{count}', String(picks.length));
}

export type TuneControl = {
  /** What the control is called: its label's words, else aria-label, else its name. */
  label: string;
  /** input type, or 'select'. */
  type: string;
  value: string;
  unit?: string | null;
  checked?: boolean;
  /** For a select (or a radio): the chosen option's words, when they say more than its value. */
  text?: string | null;
};

/** What a control sets its CSS variable to: numbers with their unit, a box as 1 or 0, the rest as they are. */
export function cssValue(c: Pick<TuneControl, 'type' | 'value' | 'unit' | 'checked'>): string {
  if (c.type === 'checkbox') return c.checked ? '1' : '0';
  if (c.type === 'range' || c.type === 'number') {
    const v = c.value.trim();
    return v === '' ? '0' : `${v}${c.unit ?? ''}`;
  }
  return c.value;
}

/** A control's value as people say it: "18px", "on", "Serif (ui-serif, Georgia)". */
export function shownValue(c: TuneControl): string {
  if (c.type === 'checkbox') return c.checked ? 'on' : 'off';
  if (c.type === 'range' || c.type === 'number') return `${c.value.trim() || '0'}${c.unit ?? ''}`;
  const text = (c.text ?? '').replace(/\s+/g, ' ').trim();
  if (text && text !== c.value) return c.value && c.value.length <= 40 ? `${text} (${c.value})` : text;
  return c.value;
}

/** "Corner radius 18px, Shadow on" */
export const describeValues = (controls: TuneControl[]) => controls.map((c) => `${cleanLabel(c.label)} ${shownValue(c)}`.trim()).join(', ');

export function fillTune(template: string | null | undefined, controls: TuneControl[]): string {
  const values = describeValues(controls);
  const t = (template ?? '').trim();
  if (!t) return values;
  return t.includes('{values}') ? t.replaceAll('{values}', values) : `${t} ${values}`;
}

/** A label's words with what a control inside it showed (its value, a colon) taken off the end. */
export const cleanLabel = (s: string) => s.replace(/\s+/g, ' ').replace(/[\s:–—-]+$/, '').trim();

/** "1. A\n2. B" */
export const numbered = (items: string[]) => items.map((s, i) => `${i + 1}. ${s}`).join('\n');

/** A ranking into its template. The list starts on a line of its own. Default: "In this order:" and the list. */
export function fillRank(template: string | null | undefined, order: string[]): string {
  const list = numbered(order);
  const t = (template ?? '').trim();
  if (!t) return `In this order:\n${list}`;
  if (!t.includes('{order}')) return `${t}\n${list}`;
  return t.replace(/[ \t]*\{order\}/g, (m, at: number) => (at === 0 || t[at - 1] === '\n' ? list : `\n${list}`));
}

export type Note = { what: string; note: string };

/**
 * Notes on a design, as one message:
 *   Notes on the landing page:
 *   1. "Calm software for…" (h1): one line too long
 * Notes with nothing written are left out.
 */
export function markupMessage(title: string | null | undefined, notes: Note[]): string {
  const kept = notes.filter((n) => n.note.trim());
  const head = `Notes on ${(title ?? '').trim() || 'the design'}:`;
  return [head, ...kept.map((n, i) => `${i + 1}. ${n.what}: ${n.note.trim().replace(/\s*\n\s*/g, ' ')}`)].join('\n');
}

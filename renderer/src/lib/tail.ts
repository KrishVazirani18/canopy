// Keeping the end of a stream of text: what a running command has printed so far.
//
//   appendOutput(prev, chunk, cap)   the output with one more chunk on its end, never longer than `cap`
//   lastLines(text, n)               its last `n` lines, for the few shown under a running step
//
// Contract:
//  - Pure, and nothing here throws: anything that is not text counts as no text. Node runs this file as it is, for
//    the unit tests.
//  - A carriage return takes the line back to its start, as a terminal does: what follows it replaces what the
//    line held, so a progress bar redrawn a hundred times is one line. `\r\n` is an ordinary line break.
//  - A chunk can end anywhere: in the middle of a line, or on a `\r` whose `\n` has not arrived yet. That last `\r`
//    is kept as it is until the next chunk says which of the two it was.
//  - Over the cap the start goes, never the end. What is kept starts on a whole line when the line that was cut
//    ends soon enough (within a tenth of the cap); otherwise it starts mid-line rather than lose more.

/** The most a running step's output is kept at in the window (characters, from the end). */
export const OUTPUT_CAP = 64_000;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One or more lines with every carriage return applied, except one at the very end (see the contract). */
const settle = (s: string) => (s.includes('\r') ? s.replace(/\r\n/g, '\n').replace(/[^\n]*\r(?!$)/g, '') : s);

export function appendOutput(prev: string, chunk: string, cap: number = OUTPUT_CAP): string {
  const before = text(prev);
  const more = text(chunk);
  if (!more) return before;
  // Only the line still being written can change: everything above its start is settled already.
  const cut = before.lastIndexOf('\n') + 1;
  let out = before.slice(0, cut) + settle(before.slice(cut) + more);
  const max = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : OUTPUT_CAP;
  if (out.length > max) {
    out = out.slice(out.length - max);
    const line = out.indexOf('\n');
    if (line >= 0 && line < max / 10) out = out.slice(line + 1);
  }
  return out;
}

export function lastLines(value: string, n: number): string {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (!count) return '';
  // Blank lines at the end (a command usually ends its output with one) are not lines worth showing.
  const lines = settle(text(value)).replace(/\s+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

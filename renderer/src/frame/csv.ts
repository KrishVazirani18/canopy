// Reading the data Claude puts inside <canopy-table> and <canopy-chart>: CSV (or tab-separated) text, and the
// numbers in it. Plain text work, tested in node (src/core/test/unit/frame.test.mjs), so erasable syntax only.

/**
 * CSV text as rows of cells. The first line with content decides the separator: a tab if it has one, else a comma.
 * Quoted cells may hold separators, line breaks and doubled quotes. Blank lines are skipped. With `open` (the text
 * is still being written) a last line that has not ended yet is left out, so a row never shows half typed.
 */
export function parseCsv(text: string, open = false): string[][] {
  let s = text.replace(/\r\n?/g, '\n');
  if (open) { const nl = s.lastIndexOf('\n'); s = nl < 0 ? '' : s.slice(0, nl + 1); }
  const first = s.split('\n').find((l) => l.trim()) ?? '';
  const sep = first.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = () => { row.push(wasQuoted ? cell : cell.trim()); cell = ''; wasQuoted = false; };
  const endRow = () => { endCell(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && !cell.trim()) { quoted = true; wasQuoted = true; cell = ''; }
    else if (c === sep) endCell();
    else if (c === '\n') endRow();
    else cell += c;
  }
  if (cell || row.length) endRow();
  return rows;
}

// Units that change what a number is worth, so "1.2 s" sorts after "900 ms" and "2 MB" after "900 KB".
const SCALE: Record<string, number> = {
  ms: 1, s: 1000, sec: 1000, secs: 1000, m: 60_000, min: 60_000, mins: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3,
  k: 1e3, bn: 1e9,
};
const NUMBER = /^([+\-−–]?)\s*([$€£¥]?)\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([a-zA-Z%×]{0,4})$/;

/**
 * The number a cell stands for, or null if it is not one. Reads what people write: 1,204  $7.12  2.1%  912 ms
 * −3.5  1.2k  4x. Signs may be a real minus. Units scale it within their family (ms/s/min/h, KB/MB/GB, k/M).
 */
export function numberOf(cell: string): number | null {
  const m = NUMBER.exec(cell.trim());
  if (!m) return null;
  const n = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = m[4];
  // "M" is millions and "m" minutes; every other unit is read without regard to case.
  const scale = unit === 'M' ? 1e6 : unit === 'B' && m[2] ? 1e9 : SCALE[unit.toLowerCase()] ?? 1;
  return (m[1] && m[1] !== '+' ? -1 : 1) * n * scale;
}

/** True for a column whose every filled cell is a number (and that has at least one). */
export function isNumeric(cells: string[]): boolean {
  let seen = 0;
  for (const c of cells) {
    if (!c.trim() || c.trim() === '-' || c.trim() === '—') continue;
    if (numberOf(c) === null) return false;
    seen++;
  }
  return seen > 0;
}

/** A number for an axis or a tooltip: 1,204  12.5  0.04, never 12.500000001. */
export function formatNumber(n: number, compact = false): string {
  const abs = Math.abs(n);
  if (compact && abs >= 1000) {
    const [div, suffix] = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : [1e3, 'k'];
    const v = n / div;
    return `${Number(v.toFixed(Math.abs(v) < 10 ? 1 : 0))}${suffix}`;
  }
  const digits = abs >= 100 || Number.isInteger(n) ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Tick values from 0 (or the lowest value, when below 0) up to at least `max`, on round steps. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = max <= lo ? lo + 1 : max;
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v < hi + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

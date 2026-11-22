// <canopy-chart type="bar|line|area">: numbers to compare, drawn the quiet way. Series are ink in three steps of
// gray (88%, 56%, 34%: checked as an ordinal ramp on both surfaces), dashed past the third, and at most one thing
// wears the accent color (highlight="..."). Thin marks, hairline grid, one axis, a legend for two or more series,
// values on hover (a crosshair that snaps to the nearest point; the whole column is the target on a bar chart),
// arrow keys do the same, and "Table" shows the numbers themselves.
// Data: CSV text inside the element; the first column labels each point, every other column is a series.
// Attributes: type, horizontal, stacked, unit, highlight, caption, height.
import { formatNumber, niceTicks, numberOf, parseCsv } from '../csv';
import { CanopyElement, define, esc } from '../element';
import { rt } from '../runtime';
import './table';

const CSS = `
:host { display: block; }
.head { display: flex; align-items: center; gap: 14px; min-height: 20px; margin-bottom: 8px; font-size: 12px; line-height: 16px; letter-spacing: 0; }
.caption { flex: 1; min-width: 0; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 12px; color: var(--color-text-secondary); }
.key { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.key i { flex: none; width: 12px; height: 2px; border-radius: 1px; background: currentColor; }
.key i.block { width: 8px; height: 8px; border-radius: 2px; }
.key i.dashed { background: linear-gradient(90deg, currentColor 0 4px, transparent 4px 6px, currentColor 6px 10px, transparent 10px 12px); }
.toggle { flex: none; height: 20px; padding: 0 6px; border: 0; border-radius: 4px; font-size: 12px; font-weight: 400; color: var(--color-text-tertiary); opacity: 0; transition: opacity 120ms ease-out; }
:host(:hover) .toggle, .toggle:focus-visible, .toggle[aria-pressed="true"] { opacity: 1; }
.toggle:hover { color: var(--color-text-primary); }
.plot { position: relative; outline: none; }
.plot:focus-visible { outline: 1.5px solid var(--color-ring-primary); outline-offset: 4px; border-radius: 4px; }
svg { display: block; width: 100%; overflow: visible; }
.plot svg text { font: 11px var(--font-sans); letter-spacing: 0; fill: var(--color-text-tertiary); font-variant-numeric: tabular-nums; }
.plot svg text.name { font-size: 12px; fill: var(--color-text-secondary); }
.plot svg text.tip { fill: var(--color-text-primary); }
.grid { stroke: var(--color-border-tertiary); stroke-width: 1; shape-rendering: crispEdges; }
.zero { stroke: var(--color-border-secondary); stroke-width: 1; shape-rendering: crispEdges; }
.cross { stroke: var(--color-border-primary); stroke-width: 1; shape-rendering: crispEdges; }
.ring { stroke: var(--color-background-primary); stroke-width: 2; }
.dim { opacity: 0.45; }
.mark { transition: opacity 100ms ease-out; }
.tipbox { position: absolute; top: 0; z-index: 1; min-width: 96px; max-width: 240px; padding: 8px 10px; border: 1px solid var(--color-border-secondary); border-radius: 8px; background: var(--color-background-secondary); font-size: 12px; line-height: 18px; letter-spacing: 0; pointer-events: none; }
.tipbox[hidden] { display: none; }
.tipbox .x { margin-bottom: 2px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tipbox .r { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.tipbox .r i { flex: none; width: 10px; height: 2px; border-radius: 1px; background: currentColor; }
.tipbox .r b { font-weight: 500; color: var(--color-text-primary); font-variant-numeric: tabular-nums; }
.tipbox .r span { min-width: 0; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; }
.empty { display: flex; align-items: center; justify-content: center; color: var(--color-text-tertiary); font-size: 12px; }
`;

// How strongly each series is inked. Three steps read apart on both surfaces; a fourth and fifth reuse the first
// two as dashed lines, and nothing past that is drawn (the guide tells Claude to aggregate first).
// With a highlight, that one thing is full ink and everything else steps back to the lightest; the accent color
// itself is only ever a dot (the end of the highlighted line), which is all the color Canopy allows.
const INK = [88, 56, 34, 88, 56];
const FILL = [88, 56, 34, 20, 70]; // bars cannot be dashed: a fourth fill is a lighter step still
const MAX_SERIES = 5;
const inked = (pct: number) => `color-mix(in oklch, var(--color-text-primary) ${pct}%, var(--color-background-primary))`;

let ruler: CanvasRenderingContext2D | null = null;
function widthOf(text: string, px = 11): number {
  ruler ??= document.createElement('canvas').getContext('2d');
  if (!ruler) return text.length * px * 0.56;
  ruler.font = `${px}px -apple-system, sans-serif`;
  return ruler.measureText(text).width;
}

type Series = { name: string; values: (number | null)[]; color: string; dashed: boolean; hot: boolean };
type View = { table?: boolean };

class CanopyChart extends CanopyElement {
  private width = 0;
  private resize: ResizeObserver;
  private view: View | null = null;
  private drawn = '';
  private at = -1; // the point under the pointer or the arrow keys

  constructor() {
    super(CSS);
    this.resize = new ResizeObserver(() => { const w = Math.floor(this.getBoundingClientRect().width); if (w !== this.width) { this.width = w; this.changed(); } });
  }
  connectedCallback() { super.connectedCallback(); this.resize.observe(this); }
  disconnectedCallback() { super.disconnectedCallback(); this.resize.disconnect(); }

  private value(n: number, compact = false) {
    const unit = this.getAttribute('unit')?.trim() ?? '';
    const text = formatNumber(n, compact);
    if (!unit) return text;
    if (/^[$€£¥]$/.test(unit)) return n < 0 ? `−${unit}${text.replace(/^-/, '')}` : `${unit}${text}`;
    return /^[%×x]$/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
  }

  protected render() {
    this.view ??= this.recall<View>() ?? {};
    const W = this.width || Math.floor(this.getBoundingClientRect().width);
    if (W < 40) return; // not laid out yet
    const data = parseCsv(this.textContent ?? '', rt.streaming);
    const head = data[0] ?? [];
    const rows = data.slice(1).filter((r) => r.length);
    const labels = rows.map((r) => r[0] ?? '');
    const highlight = this.getAttribute('highlight')?.trim().toLowerCase() ?? '';
    const names = head.slice(1, 1 + MAX_SERIES);
    const kind = (['bar', 'line', 'area'].includes(this.getAttribute('type') ?? '') ? this.getAttribute('type') : 'bar') as 'bar' | 'line' | 'area';
    const hotSeries = highlight ? names.findIndex((name) => name.trim().toLowerCase() === highlight) : -1;
    // The highlighted series takes the strongest ink and the rest step down in their own order, so they still read apart.
    const steps = kind === 'bar' ? FILL : INK;
    const rank = (i: number) => (hotSeries < 0 ? i : i === hotSeries ? 0 : i < hotSeries ? i + 1 : i);
    const series: Series[] = names.map((name, i) => ({
      name, values: rows.map((r) => numberOf(r[i + 1] ?? '')), dashed: kind !== 'bar' && rank(i) >= 3, hot: i === hotSeries,
      color: inked(steps[rank(i) % steps.length]),
    }));
    const stacked = this.hasAttribute('stacked') && kind !== 'line' && series.length > 1;
    const sideways = this.hasAttribute('horizontal') && kind === 'bar';
    const caption = this.getAttribute('caption') ?? '';
    const n = labels.length;
    const many = series.length > 1;
    // With one series, highlight names a single label instead: that bar or point wears the accent.
    const hot = !many && highlight ? labels.findIndex((l) => l.trim().toLowerCase() === highlight) : -1;

    let body: string;
    let named = false; // every line carries its name at its end, so a legend would only say it twice
    let hover: { x: (i: number) => number; plotLeft: number; plotRight: number; band: number } | null = null;
    const H = Math.max(120, Math.min(480, Number(this.getAttribute('height')) || 220));
    if (this.view.table) {
      body = `<canopy-table rows="12">${esc((this.textContent ?? '').trim())}</canopy-table>`;
    } else if (!n || !series.length) {
      body = `<div class="empty" style="height:${H}px">${rt.streaming ? '' : 'No data'}</div>`;
    } else if (sideways) {
      body = this.sideways(W, labels, series, stacked, hot);
    } else {
      const drawn = this.upright(W, H, kind, labels, series, stacked, hot);
      body = drawn.svg;
      hover = drawn.hover;
      named = drawn.named;
    }
    const legend = many && !named && !this.view.table ? `<span class="legend">${series.map((s) => `<span class="key" style="color:${s.color}"><i class="${kind === 'bar' ? 'block' : s.dashed ? 'dashed' : ''}"></i><span style="color:var(--color-text-secondary)">${esc(s.name)}</span></span>`).join('')}</span>` : '';
    const header = `<div class="head"><span class="caption">${esc(caption)}</span>${legend}${n ? `<button class="toggle" type="button" aria-pressed="${!!this.view.table}">${this.view.table ? 'Chart' : 'Table'}</button>` : ''}</div>`;
    const html = `${header}<div class="plot"${hover ? ' tabindex="0" role="img"' : ''} aria-label="${esc(caption || 'Chart')}">${body}<div class="tipbox" hidden></div></div>`;
    if (html !== this.drawn) {
      this.drawn = html;
      this.root.innerHTML = html;
      this.at = -1;
      this.root.querySelector('.toggle')?.addEventListener('click', () => { this.view = { table: !this.view?.table }; this.remember(this.view); this.changed(); });
      if (hover) this.interact(hover, labels, series, kind, stacked);
    }
  }

  // ---- upright: bars, lines and areas over a shared x axis ----

  private upright(W: number, H: number, kind: 'bar' | 'line' | 'area', labels: string[], series: Series[], stacked: boolean, hot: number) {
    const n = labels.length;
    const k = series.length;
    const totals = labels.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0));
    const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    const max = Math.max(0, ...(stacked ? totals : all));
    const min = Math.min(0, ...all);
    const ticks = niceTicks(min, max, H < 180 ? 3 : 4);
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const compact = Math.max(Math.abs(lo), Math.abs(hi)) >= 10_000;
    // The axis carries bare numbers (a short sign stays: $, %); the unit in words is said once, in the tooltip.
    const short = /^[$€£¥%×x]$/.test(this.getAttribute('unit')?.trim() ?? '');
    const tickText = ticks.map((t) => (short ? this.value(t, compact) : formatNumber(t, compact)));

    // Lines are named at their ends when there are few and their ends do not crowd each other.
    const top = 8;
    const bottom = 22;
    const plotH = H - top - bottom;
    const y = (v: number) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const ends = kind !== 'bar' && k > 1 && k <= 4 && !stacked
      ? series.map((s) => { const v = s.values[n - 1]; return v === null || v === undefined ? null : y(v); })
      : [];
    const roomy = ends.length > 0 && ends.every((e) => e !== null) && [...(ends as number[])].sort((a, b) => a - b).every((e, i, a) => i === 0 || e - a[i - 1] >= 14);
    const endLabel = roomy ? Math.min(120, Math.max(...series.map((s) => widthOf(s.name, 12))) + 14) : 0;

    const left = Math.ceil(Math.max(...tickText.map((t) => widthOf(t)))) + 10;
    const right = kind === 'bar' ? 4 : Math.max(10, endLabel);
    const plotW = Math.max(40, W - left - right);
    const band = kind === 'bar' ? plotW / n : n > 1 ? plotW / (n - 1) : plotW;
    const x = (i: number) => (kind === 'bar' ? left + band * (i + 0.5) : n > 1 ? left + band * i : left + plotW / 2);

    let g = '';
    ticks.forEach((t, i) => {
      g += `<line class="${t === 0 ? 'zero' : 'grid'}" x1="${left}" x2="${left + plotW}" y1="${y(t)}" y2="${y(t)}"/>`;
      g += `<text x="${left - 8}" y="${y(t) + 3.5}" text-anchor="end">${esc(tickText[i])}</text>`;
    });
    // As many x labels as fit side by side; always the first, and the last when it has room.
    const labelW = Math.max(...labels.map((l) => widthOf(l))) + 14;
    const step = Math.max(1, Math.ceil(labelW / (kind === 'bar' ? band : Math.max(band, 1))));
    labels.forEach((l, i) => {
      if (i % step !== 0 && !(i === n - 1 && (n - 1) % step >= step / 2)) return;
      if (i % step !== 0 && i === n - 1 && kind === 'bar') return;
      const anchor = kind === 'bar' ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      g += `<text x="${x(i)}" y="${H - 6}" text-anchor="${anchor}">${esc(l)}</text>`;
    });

    if (kind === 'bar') {
      // A bar is at most 24px thick, with 2px of surface between neighbors; the rest of its slot is air.
      const slots = stacked ? 1 : k;
      const thick = Math.max(2, Math.min(24, (band * 0.72 - 2 * (slots - 1)) / slots));
      const group = thick * slots + 2 * (slots - 1);
      labels.forEach((_, i) => {
        let marks = '';
        let base = 0;
        series.forEach((s, j) => {
          const v = s.values[i];
          if (v === null || v === 0) return;
          const bx = x(i) - group / 2 + (stacked ? 0 : j * (thick + 2));
          const from = stacked ? base : 0;
          const to = stacked ? base + Math.max(0, v) : v;
          if (stacked) base = to;
          const y0 = y(from);
          const y1 = y(to);
          // Square at the baseline, 4px round at the data end; a stacked segment gives up 2px to the one above.
          const gap = stacked && j < k - 1 && series.slice(j + 1).some((o) => (o.values[i] ?? 0) > 0) ? 2 : 0;
          const tall = Math.max(1, Math.abs(y1 - y0) - gap);
          const r = Math.min(4, thick / 2, tall);
          const round = !stacked || !gap;
          const up = y1 <= y0;
          const yt = up ? y0 - tall : y0;
          const d = !round ? `M${bx} ${yt}h${thick}v${tall}h${-thick}Z`
            : up ? `M${bx} ${y0}V${yt + r}q0 ${-r} ${r} ${-r}h${thick - 2 * r}q${r} 0 ${r} ${r}V${y0}Z`
              : `M${bx} ${y0}V${yt + tall - r}q0 ${r} ${r} ${r}h${thick - 2 * r}q${r} 0 ${r} ${-r}V${y0}Z`;
          marks += `<path d="${d}" fill="${hot < 0 ? s.color : hot === i ? inked(88) : inked(34)}"/>`;
        });
        g += `<g class="mark" data-i="${i}">${marks}</g>`;
      });
    } else {
      const stackBase = labels.map(() => 0);
      series.forEach((s, j) => {
        const pts: [number, number, number][] = [];
        s.values.forEach((v, i) => { if (v !== null) { const b = stacked ? stackBase[i] : 0; pts.push([x(i), y(b + v), y(b)]); if (stacked) stackBase[i] = b + v; } });
        if (!pts.length) return;
        const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
        if (kind === 'area') {
          const back = stacked ? [...pts].reverse().map((p) => `L${p[0].toFixed(1)} ${p[2].toFixed(1)}`).join('') : `L${pts[pts.length - 1][0].toFixed(1)} ${y(0)}L${pts[0][0].toFixed(1)} ${y(0)}`;
          g += `<path d="${line}${back}Z" fill="${s.color}" opacity="${stacked ? 0.16 : 0.1}"/>`;
        }
        g += `<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="5 4"' : ''}/>`;
        const last = pts[pts.length - 1];
        if (pts.length === 1 || j < 4) g += `<circle class="ring" cx="${last[0]}" cy="${last[1]}" r="4" fill="${s.hot ? 'var(--color-accent)' : s.color}"/>`;
        if (roomy) g += `<text class="name" x="${last[0] + 10}" y="${last[1] + 4}">${esc(s.name)}</text>`;
      });
      if (hot >= 0 && series[0].values[hot] !== null) g += `<circle class="ring" cx="${x(hot)}" cy="${y(series[0].values[hot] as number)}" r="4" fill="var(--color-accent)"/>`;
    }
    // What the pointer adds: a hairline at the nearest point and a dot on each line there.
    g += `<line class="cross" y1="${top}" y2="${top + plotH}" visibility="hidden"/>`;
    if (kind !== 'bar') {
      const stackBase = labels.map(() => 0);
      series.forEach((s, j) => {
        g += `<g class="dots" data-s="${j}">${s.values.map((v, i) => { if (v === null) return ''; const b = stacked ? stackBase[i] : 0; if (stacked) stackBase[i] = b + v; return `<circle class="ring" data-i="${i}" cx="${x(i)}" cy="${y(b + v)}" r="4" fill="${s.color}" visibility="hidden"/>`; }).join('')}</g>`;
      });
    }
    return { svg: `<svg viewBox="0 0 ${W} ${H}" height="${H}" aria-hidden="true">${g}</svg>`, hover: { x, plotLeft: left, plotRight: left + plotW, band }, named: roomy };
  }

  // ---- sideways: a ranking, labels down the left, the value at each bar's tip ----

  private sideways(W: number, labels: string[], series: Series[], stacked: boolean, hot: number) {
    const k = series.length;
    const totals = labels.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0));
    const max = Math.max(0, ...(stacked ? totals : series.flatMap((s) => s.values.map((v) => v ?? 0))));
    const tips = labels.map((_, i) => (stacked ? this.value(totals[i]) : k === 1 ? (series[0].values[i] === null ? '' : this.value(series[0].values[i] as number)) : ''));
    const nameW = Math.min(W * 0.38, Math.ceil(Math.max(...labels.map((l) => widthOf(l, 12)))) + 12);
    const tipW = Math.ceil(Math.max(0, ...tips.map((t) => widthOf(t)))) + (tips.some(Boolean) ? 8 : 0);
    const plotW = Math.max(40, W - nameW - tipW - 2);
    const slots = stacked ? 1 : k;
    const thick = slots === 1 ? 16 : Math.max(6, Math.min(12, 28 / slots));
    const rowH = Math.max(28, thick * slots + 2 * (slots - 1) + 12);
    const H = rowH * labels.length;
    const w = (v: number) => (max ? (Math.max(0, v) / max) * plotW : 0);
    let g = `<line class="zero" x1="${nameW}" x2="${nameW}" y1="0" y2="${H}"/>`;
    labels.forEach((label, i) => {
      const cy = rowH * i + rowH / 2;
      let marks = '';
      let base = 0;
      const group = thick * slots + 2 * (slots - 1);
      series.forEach((s, j) => {
        const v = s.values[i];
        if (v === null || v <= 0) return;
        const by = cy - group / 2 + (stacked ? 0 : j * (thick + 2));
        const from = stacked ? base : 0;
        if (stacked) base += v;
        const gap = stacked && j < k - 1 && series.slice(j + 1).some((o) => (o.values[i] ?? 0) > 0) ? 2 : 0;
        const len = Math.max(1, w(v) - gap);
        const bx = nameW + w(from);
        const r = Math.min(4, thick / 2, len);
        const d = gap ? `M${bx} ${by}h${len}v${thick}h${-len}Z` : `M${bx} ${by}h${len - r}q${r} 0 ${r} ${r}v${thick - 2 * r}q0 ${r} ${-r} ${r}h${-(len - r)}Z`;
        marks += `<path d="${d}" fill="${hot < 0 ? s.color : hot === i ? inked(88) : inked(34)}"/>`;
      });
      // A name too long for its column is cut with an ellipsis; the whole of it is in the table.
      let name = label;
      while (name.length > 3 && widthOf(name, 12) > nameW - 12) name = `${name.slice(0, -2).trimEnd()}…`;
      g += `<text class="name" x="${nameW - 10}" y="${cy + 4}" text-anchor="end">${esc(name)}</text><g class="mark" data-i="${i}">${marks}</g>`;
      if (tips[i]) g += `<text class="tip" x="${nameW + w(stacked ? totals[i] : series[0].values[i] ?? 0) + 8}" y="${cy + 4}">${esc(tips[i])}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">${g}</svg>`;
  }

  // ---- pointer and keys ----

  private interact(hover: { x: (i: number) => number; plotLeft: number; plotRight: number; band: number }, labels: string[], series: Series[], kind: string, stacked: boolean) {
    const plot = this.root.querySelector<HTMLElement>('.plot');
    const svg = plot?.querySelector('svg');
    const tip = plot?.querySelector<HTMLElement>('.tipbox');
    const cross = svg?.querySelector<SVGLineElement>('.cross');
    if (!plot || !svg || !tip) return;
    const n = labels.length;
    const show = (i: number) => {
      if (i === this.at) return;
      this.at = i;
      svg.querySelectorAll('.dots circle').forEach((c) => c.setAttribute('visibility', Number(c.getAttribute('data-i')) === i ? 'visible' : 'hidden'));
      svg.querySelectorAll('.mark').forEach((m) => m.classList.toggle('dim', i >= 0 && Number(m.getAttribute('data-i')) !== i));
      if (i < 0) { tip.hidden = true; cross?.setAttribute('visibility', 'hidden'); return; }
      if (cross && kind !== 'bar') { cross.setAttribute('x1', String(hover.x(i))); cross.setAttribute('x2', String(hover.x(i))); cross.setAttribute('visibility', 'visible'); }
      // The value leads and the name follows: here the reader has the series and wants the number.
      const total = stacked ? series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0) : null;
      tip.innerHTML = `<div class="x">${esc(labels[i])}</div>${series.map((s) => (s.values[i] === null ? '' : `<div class="r" style="color:${s.color}">${series.length > 1 ? '<i></i>' : ''}<b>${esc(this.value(s.values[i] as number))}</b>${series.length > 1 ? `<span>${esc(s.name)}</span>` : ''}</div>`)).join('')}${total !== null ? `<div class="r"><b>${esc(this.value(total))}</b><span>Total</span></div>` : ''}`;
      tip.hidden = false;
      const w = tip.offsetWidth;
      const px = hover.x(i);
      const side = px + 14 + w <= plot.clientWidth ? px + 14 : px - 14 - w;
      tip.style.left = `${Math.max(0, Math.min(plot.clientWidth - w, side))}px`;
    };
    const nearest = (clientX: number) => {
      const r = svg.getBoundingClientRect();
      const px = clientX - r.left;
      if (px < hover.plotLeft - hover.band / 2 || px > hover.plotRight + hover.band / 2) return -1;
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(hover.x(i) - px) < Math.abs(hover.x(best) - px)) best = i;
      return best;
    };
    plot.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    plot.addEventListener('pointerleave', () => show(-1));
    plot.addEventListener('blur', () => show(-1));
    plot.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
      e.preventDefault();
      show(e.key === 'Escape' ? -1 : Math.max(0, Math.min(n - 1, this.at < 0 ? (e.key === 'ArrowRight' ? 0 : n - 1) : this.at + (e.key === 'ArrowRight' ? 1 : -1))));
    });
  }
}

define('canopy-chart', CanopyChart);

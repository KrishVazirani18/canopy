// The building blocks a model would get to make visual widgets (as React here, for the mock): pick on anything, a
// preview that follows the pointer, true-size scaling, and the one confirm row every widget ends with. Everything
// else in a widget (its layout, the content's own colors and type) is the model's to write.
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Content laid out at its true size (a 1280×720 slide, a 390×844 phone) and shrunk to fit. Room is kept from the
 *  first frame (aspect-ratio), so nothing jumps while it measures. */
export function Scaled({ w, h, children, className }: { w: number; h: number; children: React.ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!;
    const fit = () => setS(el.clientWidth / w);
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [w]);
  return (
    <div ref={box} className={cn('relative w-full overflow-hidden', className)} style={{ aspectRatio: `${w} / ${h}` }}>
      <div className="absolute top-0 left-0 origin-top-left" style={{ width: w, height: h, transform: `scale(${s})`, visibility: s ? 'visible' : 'hidden' }}>{children}</div>
    </div>
  );
}

export type Opt = { id: string; label: string; hint?: string; rec?: boolean };

/** Pick on anything: what is picked, what the preview shows (pointed at, else picked, else recommended), arrow keys,
 *  and the send that locks it. `many`: several can be picked. */
export function usePick<T extends Opt>(opts: T[], { start, many = false }: { start?: string[]; many?: boolean } = {}) {
  const [picked, setPicked] = useState<string[]>(start ?? []);
  const [hover, setHover] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const shown = hover ?? picked.at(-1) ?? opts.find((o) => o.rec)?.id ?? opts[0].id;
  const step = (d: number) => { if (sent) return; const i = opts.findIndex((o) => o.id === shown); const next = opts[(i + d + opts.length) % opts.length].id; if (many) setHover(next); else { setPicked([next]); setHover(null); } };
  return {
    opts, picked, shown, sent, many,
    is: (id: string) => picked.includes(id),
    opt: (id: string) => opts.find((o) => o.id === id)!,
    pick: (id: string) => { if (sent) return; setPicked((p) => (many ? (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]) : [id])); },
    point: (id: string | null) => { if (!sent) setHover(id); },
    send: () => { if (picked.length) setSent(true); },
    keys: (e: React.KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    },
    labels: () => opts.filter((o) => picked.includes(o.id)).map((o) => o.label),
  };
}
export type Pick = ReturnType<typeof usePick>;

/** Hover and focus point at an option; click picks it. Spread onto any element that stands for one. */
export const choice = (p: Pick, id: string) => ({
  role: p.many ? 'checkbox' : 'radio', 'aria-checked': p.is(id),
  onMouseEnter: () => p.point(id), onFocus: () => p.point(id), onClick: () => p.pick(id),
});

export const Dot = ({ className }: { className?: string }) => <span className={cn('size-1.5 shrink-0 rounded-full bg-brand', className)} />;
export const Mark = ({ on, many = false }: { on: boolean; many?: boolean }) => (
  <span className={cn('flex size-3.5 shrink-0 items-center justify-center border', many ? 'rounded-[4px]' : 'rounded-full', on ? 'border-foreground bg-foreground' : 'border-foreground/30')}>
    {on && (many ? <svg viewBox="0 0 10 10" className="size-2.5 text-background"><path d="M2 5.2 4.2 7.4 8.2 2.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> : <span className="size-1.5 rounded-full bg-background" />)}
  </span>
);

/** An option's own words under its picture: the mark, the label, the recommended dot, the hint. */
export function Caption({ p, o, className }: { p: Pick; o: Opt; className?: string }) {
  return (
    <span className={cn('flex items-start gap-2.5', className)}>
      <span className="mt-[3px]"><Mark on={p.is(o.id)} many={p.many} /></span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-ui text-foreground">{o.label}{o.rec && <Dot />}</span>
        {o.hint && <span className="block truncate text-[12px] text-muted-foreground">{o.hint}</span>}
      </span>
    </span>
  );
}

/** How an option's frame looks: picked, shown by the preview, faded once another was sent. */
export const tone = (p: Pick, id: string, base = 'rounded-lg') => cn(base, 'text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/40',
  p.is(id) ? 'bg-accent ring-1 ring-foreground/40' : id === p.shown && !p.many ? 'bg-accent/50' : 'hover:bg-accent/50', p.sent && !p.is(id) && 'opacity-45');

/** Every option drawn in one cell, only the shown one visible: the preview is as tall as the tallest and never jumps. */
export function Stack({ ids, shown, render }: { ids: string[]; shown: string; render: (id: string) => React.ReactNode }) {
  return (
    <div className="grid">
      {ids.map((id) => <div key={id} className={cn('col-start-1 row-start-1 transition-opacity duration-150', id === shown ? 'opacity-100' : 'pointer-events-none opacity-0')}>{render(id)}</div>)}
    </div>
  );
}

/** The confirm row every widget ends with, and, once sent, the message it sent (shown as yours). */
export function Confirm({ ready, button, message, sent, onSend }: { ready: boolean; button: string; message: string; sent: boolean; onSend: () => void }) {
  return (
    <div className="mt-3 flex min-h-8 items-center justify-end">
      {!sent && <button type="button" disabled={!ready} onClick={onSend} className="h-8 rounded-md bg-foreground px-3 text-small font-medium text-background transition-opacity disabled:opacity-35">{button}</button>}
      {sent && <div className="user-bubble send-in ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2 text-body whitespace-pre-line">{message}</div>}
    </div>
  );
}
/** Confirm for a pick: "Use Night Forest", and the message with the picks in it. */
export function PickConfirm({ p, say, verb = 'Use' }: { p: Pick; say: (labels: string[]) => string; verb?: string }) {
  const labels = p.labels();
  const button = !labels.length ? (p.many ? 'Pick some' : 'Pick one') : p.many ? `${verb} ${labels.length}` : `${verb} ${labels[0]}`;
  return <Confirm ready={!!labels.length} button={button} message={labels.length ? say(labels) : ''} sent={p.sent} onSend={p.send} />;
}

/** Segmented choice: a few words side by side, one on. For a dimension (type, color, device). */
export function Segments<T extends string>({ value, options, onChange, disabled }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg border border-hairline p-0.5">
      {options.map((o) => (
        <button key={o.id} type="button" disabled={disabled} onClick={() => onChange(o.id)}
          className={cn('h-7 rounded-md px-3 text-small transition-colors', value === o.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>{o.label}</button>
      ))}
    </div>
  );
}

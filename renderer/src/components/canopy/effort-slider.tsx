// Effort slider: Low → Max, plus a sixth stop, Ultra (standing multi-agent orchestration).
// Glides between stops, every level marked, click, drag or arrow keys. Only transform and scale animate.
//
// Those six are the one scale both makers share, and the default. A model that offers fewer brings its own stops
// (`labels`, two or more, in scale order), and says which of them, if any, is drawn as Ultra (`ultraAt`; -1 for none).
// `defaultAt` marks the model's own default stop with a small open ring in place of its dot, so it can still be seen
// once you have moved off it (-1 or left out: no mark). lib/models.ts `effortSlider` works all of these out.
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// Short labels: six stops share ~240px, full words ("Extra high") crowd into each other.
const LABELS = ['Low', 'Med', 'High', 'XHigh', 'Max', 'Ultra'];

export function EffortSlider({ index, isDefault, onChange, labels = LABELS, ultraAt = labels === LABELS ? LABELS.length - 1 : -1, defaultAt = -1 }: {
  index: number; isDefault: boolean; onChange: (i: number) => void; labels?: string[]; ultraAt?: number; defaultAt?: number;
}) {
  const LAST = Math.max(1, labels.length - 1);
  const ULTRA = ultraAt;
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null); // 0..1 while dragging

  const fracAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const nearest = (f: number) => Math.round(f * LAST);
  const pos = drag ?? index / LAST;
  const active = drag != null ? nearest(drag) : index;
  const ultra = active === ULTRA && !(isDefault && drag == null);
  const resting = isDefault && drag == null; // model default: drawn quieter until the user picks a level

  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = e.key === 'ArrowRight' ? Math.min(LAST, index + 1)
      : e.key === 'ArrowLeft' ? Math.max(0, index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? LAST
      : null;
    if (next == null) return;
    e.preventDefault();
    if (next !== index || isDefault) onChange(next);
  };

  return (
    <div className="select-none">
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={LAST}
        aria-valuenow={active}
        aria-valuetext={labels[active]}
        className="relative mx-[7px] h-5 rounded-sm"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDrag(fracAt(e.clientX)); }}
        onPointerMove={(e) => { if (drag != null) setDrag(fracAt(e.clientX)); }}
        onPointerUp={(e) => { if (drag != null) { onChange(nearest(fracAt(e.clientX))); setDrag(null); } }}
        onPointerCancel={() => setDrag(null)}
      >
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-muted-foreground/15" />
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full">
          <div className={cn('h-full w-full origin-left', ultra ? 'ultra-fill' : resting ? 'bg-muted-foreground/30' : 'bg-foreground/55',
            drag == null && 'transition-transform duration-200 ease-out-quint')}
            style={{ transform: `scaleX(${pos})` }} />
        </div>
        {labels.map((_, i) => (i === defaultAt ? (
          // The model's default: an open ring, filled with the surface behind it so the track does not show through.
          <span key={i} title="Default" className={cn('absolute top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border bg-popover', i <= active && !resting ? 'border-foreground/70' : 'border-muted-foreground/60')}
            style={{ left: `${(i / LAST) * 100}%` }} />
        ) : (
          <span key={i} className={cn('absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full', i <= active && !resting ? 'bg-foreground/70' : 'bg-muted-foreground/40')}
            style={{ left: `${(i / LAST) * 100}%` }} />
        )))}
        <span className={cn('pointer-events-none absolute inset-0', drag == null && 'transition-transform duration-200 ease-out-quint')}
          style={{ transform: `translateX(${pos * 100}%)` }}>
          <span className={cn('absolute top-1/2 left-0 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-popover shadow-[0_0_0_0.5px_oklch(0.2_0.01_75/0.12),0_1px_2px_oklch(0.2_0.01_75/0.2)] transition-[scale] duration-120',
            ultra ? 'ultra-thumb border-transparent' : resting ? 'border-muted-foreground/40' : 'border-foreground/50',
            drag != null && 'scale-110')} />
        </span>
      </div>
      <div className="relative mx-[7px] mt-1 h-4">
        {labels.map((l, i) => (
          <button key={l} type="button" tabIndex={-1} onClick={() => onChange(i)}
            className={cn('absolute -translate-x-1/2 whitespace-nowrap text-micro',
              i === ULTRA ? 'ultra-text font-medium' : i === active && !resting ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
            style={{ left: `${(i / LAST) * 100}%` }}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

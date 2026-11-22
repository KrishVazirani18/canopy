// A one-line title that never ellipsizes: when it's too long, its right edge fades out, and hovering the
// row (`.chat-row`) scrolls it to the end. It waits 0.35 s, travels at 2 em per second on the curve
// cubic-bezier(.49, .6, .7, 1), and stops at the end with the fade gone. Moving the pointer away snaps it back. The styles are the `.mq` rules in index.css.
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const LEAD = 0.35;     // seconds it holds still before it moves
const SPEED_EM = 2;    // font sizes per second
const CURVE = { x1: 0.49, y1: 0.6, x2: 0.7, y2: 1 };
const STEPS = 32;

// The pause and the curve as one CSS linear() timing function over the whole run.
function scrollStyle(distance: number, pxPerSecond: number): CSSProperties {
  const run = distance / pxPerSecond;
  const total = LEAD + run;
  const stop = (progress: number, t: number) => `${progress.toFixed(4)} ${((t / total) * 100).toFixed(4)}%`;
  const stops = [stop(0, 0)];
  for (let i = 0; i <= STEPS; i++) {
    const a = i / STEPS, o = 1 - a, b1 = 3 * o * o * a, b2 = 3 * o * a * a, b3 = a ** 3;
    stops.push(stop(b1 * CURVE.y1 + b2 * CURVE.y2 + b3, LEAD + run * (b1 * CURVE.x1 + b2 * CURVE.x2 + b3)));
  }
  return { '--mq-duration': `${total.toFixed(3)}s`, '--mq-distance': `${distance}px`, '--mq-timing': `linear(${stops.join(', ')})` } as CSSProperties;
}

export function Marquee({ children, className, contentClassName, title }: { children: ReactNode; className?: string; contentClassName?: string; title?: string }) {
  const view = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState<{ distance: number; speed: number } | null>(null);

  // How far past the edge the title runs. Rechecked whenever the row or the title changes width (the hover
  // controls take room at the right, so the distance can change as the pointer arrives).
  useLayoutEffect(() => {
    const v = view.current, c = content.current;
    if (!v || !c) return;
    const measure = () => {
      const vw = v.getBoundingClientRect().width, cw = c.getBoundingClientRect().width;
      if (vw <= 0 || cw <= vw) { setOver(null); return; }
      const speed = (Number.parseFloat(getComputedStyle(c).fontSize) || 13) * SPEED_EM;
      const distance = cw - vw;
      setOver((p) => (p && p.distance === distance && p.speed === speed ? p : { distance, speed }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(v); ro.observe(c);
    return () => ro.disconnect();
  }, []);

  return (
    <span ref={view} className={cn('mq', className)} title={title}>
      <span className="mq-clip" data-over={over ? '' : undefined} style={over ? scrollStyle(over.distance, over.speed) : undefined}>
        <span className="mq-track" data-scroll={over ? '' : undefined}>
          <span ref={content} className={cn('mq-content', contentClassName)}>{children}</span>
        </span>
      </span>
    </span>
  );
}

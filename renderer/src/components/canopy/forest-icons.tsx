// Forest icons for the working line ("Squirreling away… 12s"): one per group of words, each drawn on a 16×16 grid
// with parts that move on their own (see forest-icons.css). Line art in currentColor, so they take the text's gray.
import './forest-icons.css';
import { useId } from 'react';
import { cn } from '@/lib/utils';

export type ForestKind =
  | 'sprout' | 'leaf' | 'tree' | 'forest' | 'flower' | 'shovel' | 'axe' | 'acorn'
  | 'squirrel' | 'bird' | 'trail' | 'campfire' | 'camp' | 'sun' | 'rain' | 'wind';

// Most are drawn on a 16 grid; the tree, flower and squirrel on a 24 one (finer shapes, Lucide's own drawing).
const FINE = new Set<ForestKind>(['tree', 'flower', 'squirrel']);

const DRAW: Record<ForestKind, React.ReactNode> = {
  sprout: <>
    <path d="M4.5 14.5h7" />
    <path className="fi-sprout-stem" d="M8 14.5V8" />
    <path className="fi-sprout-l" d="M8 10C8 7.6 6.2 6 3.6 6c0 2.4 1.8 4 4.4 4Z" />
    <path className="fi-sprout-r" d="M8 8.5C8 5.6 9.9 3.6 12.8 3.6c0 2.9-1.9 4.9-4.8 4.9Z" />
  </>,
  leaf: <g className="fi-leaf">
    <path d="M3 13C3 7.2 7.2 3 13 3c0 5.8-4.2 10-10 10Z" />
    <path d="M3 13l6.5-6.5" />
  </g>,
  tree: <>
    <path d="M12 19v3" />
    <path className="fi-crown" d="M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z" />
    <path className="fi-p fi-fall" d="M15.5 13.5c0-1.2.8-2 2-2 0 1.2-.8 2-2 2Z" fill="currentColor" strokeWidth={1} />
  </>,
  forest: <>
    <path d="M1 14.5h14" />
    <g className="fi-pine-a"><path d="M5 2.2L1.8 10.5h6.4Z" /><path d="M5 10.5V14" /></g>
    <g className="fi-pine-b"><path d="M11.5 5.2l-2.6 6.3h5.2Z" /><path d="M11.5 11.5v3" /></g>
  </>,
  flower: <>
    <path className="fi-f-stem" d="M12 10v12" />
    <g className="fi-leaves">
      <path d="M12 22c4.2 0 7-1.667 7-5-4.2 0-7 1.667-7 5Z" />
      <path d="M12 22c-4.2 0-7-1.667-7-5 4.2 0 7 1.667 7 5Z" />
    </g>
    <g className="fi-petals">
      <path d="M12 5a3 3 0 1 1 3 3m-3-3a3 3 0 1 0-3 3m3-3v1M9 8a3 3 0 1 0 3 3M9 8h1m5 0a3 3 0 1 1-3 3m3-3h-1m-2 3v-1" />
      <circle cx="12" cy="8" r="2" />
    </g>
  </>,
  shovel: <>
    <path d="M1.5 14.5h7" />
    <g className="fi-shovel">
      <path d="M12.5 2.5L8.2 6.8M11.4 1.4l2.2 2.2" />
      <path d="M8.9 6.1L5.3 7.5 3.4 12.6l5.1-1.9 1.4-3.6Z" />
    </g>
    <circle className="fi-p fi-dirt-a" cx="5.8" cy="12.4" r=".7" fill="currentColor" stroke="none" />
    <circle className="fi-p fi-dirt-b" cx="7" cy="12.8" r=".6" fill="currentColor" stroke="none" />
  </>,
  axe: <>
    <path d="M1.5 15h10M3.5 15v-3.4h5V15" />
    <g className="fi-axe">
      <path d="M14 12.5L7.6 6.8" />
      <path d="M7.6 6.8L5.2 6.3 4.4 9.1l2.6.4Z" />
    </g>
    <circle className="fi-p fi-chip-l" cx="5.3" cy="11.2" r=".6" fill="currentColor" stroke="none" />
    <circle className="fi-p fi-chip-r" cx="6.6" cy="11.2" r=".55" fill="currentColor" stroke="none" />
  </>,
  acorn: <>
    <path d="M3 14.6h10" />
    <g className="fi-acorn">
      <path d="M5 7.6c0 3.2 1.4 5.5 3 6 1.6-.5 3-2.8 3-6" />
      <g className="fi-cap"><path d="M4.4 7.6c0-2.2 1.6-3.6 3.6-3.6s3.6 1.4 3.6 3.6Z" /><path d="M8 4V2.4" /></g>
    </g>
  </>,
  squirrel: <g className="fi-squirrel">
    <path d="M3 17c0 2.8 2.2 5 5 5h10" />
    <path d="M18 6a4 4 0 0 0-4 4 7 7 0 0 0-7 7" />
    <path d="M16 20a3 3 0 0 1 3-3h1a2 2 0 0 0 2-2v-2a4 4 0 0 0-4-4V4" />
    <path d="M15.236 22a3 3 0 0 0-2.2-5" />
    <path d="M18 13h.01" />
    <path className="fi-tail" d="M7 17c0-5 4-5 4-10.5a4.5 4.5 0 1 0-9 0 2.5 2.5 0 0 0 5 0C7 10 3 11 3 17" />
  </g>,
  bird: <g className="fi-bird">
    <g className="fi-peck">
      <path d="M7.2 13.2v1.6M9.2 13v1.8" />
      <path d="M12.3 5.5a1.8 1.8 0 1 0-3.4.9C6.8 7 4.6 8.3 3.2 10.2 4 12.4 6 13.2 8 13.2c2.4 0 4.3-1.6 4.3-4Z" />
      <path d="M3.3 10.2L1 9.5l1.5 1.8" />
      <path d="M12.3 5.1l1.9.5-1.9.5" />
      <circle cx="10.7" cy="5.3" r=".45" fill="currentColor" stroke="none" />
      <path className="fi-wing" d="M5.4 10.6c1.2-1.7 2.9-2.4 4.5-2.3-.4 1.7-1.9 2.8-4.5 2.3Z" />
    </g>
  </g>,
  trail: <g fill="currentColor" stroke="none">
    <g transform="rotate(25 4 13)"><ellipse className="fi-print fi-print-1" cx="4" cy="13" rx=".95" ry="1.45" /></g>
    <g transform="rotate(25 7 10.5)"><ellipse className="fi-print fi-print-2" cx="7" cy="10.5" rx=".95" ry="1.45" /></g>
    <g transform="rotate(25 8.5 7)"><ellipse className="fi-print fi-print-3" cx="8.5" cy="7" rx=".95" ry="1.45" /></g>
    <g transform="rotate(25 11.5 4.5)"><ellipse className="fi-print fi-print-4" cx="11.5" cy="4.5" rx=".95" ry="1.45" /></g>
  </g>,
  campfire: <>
    <path d="M3 14.6l10-2.4M3 12.2l10 2.4" />
    <path className="fi-flame-out" d="M8 2.5c2.5 2.5 3.5 4.2 3.5 6 0 1.9-1.6 3-3.5 3s-3.5-1.1-3.5-3c0-1.5.8-2.5 1.8-3.3.2 1 .7 1.6 1.4 1.8C7.3 6 7.4 4.3 8 2.5Z" />
    <path className="fi-flame-in" d="M8 7.6c1 1 1.4 1.8 1.4 2.5 0 .8-.6 1.2-1.4 1.2s-1.4-.4-1.4-1.2c0-.7.5-1.5 1.4-2.5Z" />
    <circle className="fi-p fi-spark-a" cx="10" cy="4.5" r=".5" fill="currentColor" stroke="none" />
    <circle className="fi-p fi-spark-b" cx="6.2" cy="5" r=".45" fill="currentColor" stroke="none" />
    <circle className="fi-p fi-spark-c" cx="8.6" cy="3" r=".45" fill="currentColor" stroke="none" />
  </>,
  camp: <>
    <path d="M.8 14.2h14.4" />
    <path className="fi-tent" pathLength={1} d="M2 14.2L8 4l6 10.2" />
    <path className="fi-pole" pathLength={1} d="M8 8.5v5.7" />
    <path className="fi-door" d="M8 8.5l2.6 5.7H8" />
    <path className="fi-star" d="M13.5 1.9v3.2M11.9 3.5h3.2" />
  </>,
  sun: <>
    <g className="fi-sun">
      <circle cx="8" cy="8.5" r="2.6" />
      <path className="fi-ray" style={{ animationDelay: '0.00s' }} d="M8.00 4.20L8.00 2.60" />
      <path className="fi-ray" style={{ animationDelay: '0.07s' }} d="M11.04 5.46L12.17 4.33" />
      <path className="fi-ray" style={{ animationDelay: '0.14s' }} d="M12.30 8.50L13.90 8.50" />
      <path className="fi-ray" style={{ animationDelay: '0.21s' }} d="M11.04 11.54L12.17 12.67" />
      <path className="fi-ray" style={{ animationDelay: '0.28s' }} d="M8.00 12.80L8.00 14.40" />
      <path className="fi-ray" style={{ animationDelay: '0.35s' }} d="M4.96 11.54L3.83 12.67" />
      <path className="fi-ray" style={{ animationDelay: '0.42s' }} d="M3.70 8.50L2.10 8.50" />
      <path className="fi-ray" style={{ animationDelay: '0.49s' }} d="M4.96 5.46L3.83 4.33" />
    </g>
  </>,
  rain: <>
    <path d="M4.6 9h6.9a2.5 2.5 0 0 0 .2-5A3.5 3.5 0 0 0 5.1 3.4 2.8 2.8 0 0 0 4.6 9Z" />
    <path className="fi-drop-1" d="M5.6 11l-.4 1.3" />
    <path className="fi-drop-2" d="M8.4 11l-.4 1.3" />
    <path className="fi-drop-3" d="M11.2 11l-.4 1.3" />
    <path className="fi-p fi-ripple-1" d="M3.6 15h2.8" />
    <path className="fi-p fi-ripple-2" d="M6.6 15h2.8" />
    <path className="fi-p fi-ripple-3" d="M9.6 15h2.8" />
  </>,
  wind: <>
    <path className="fi-gust" pathLength={1} d="M1.5 6h8.2A2 2 0 1 0 7.8 3.6" />
    <path className="fi-gust fi-gust-2" pathLength={1} d="M1.5 9.4h10.6a2 2 0 1 1-1.9 2.5" />
    <path className="fi-gust fi-gust-3" pathLength={1} d="M1.5 12.8h5" />
  </>,
};

/** A forest icon at text size. `still` holds it at rest (a finished turn's line). */
export function ForestIcon({ kind, still, className }: { kind: ForestKind; still?: boolean; className?: string }) {
  const clip = useId();
  // The sun rises from behind the horizon: cut off below the line, which is drawn on top.
  const body = kind === 'sun'
    ? <><defs><clipPath id={clip}><rect x="-2" y="-4" width="20" height="17.5" /></clipPath></defs>
        <g clipPath={`url(#${clip})`}>{DRAW.sun}</g><path d="M1 13.5h14" /></>
    : DRAW[kind];
  return (
    <svg viewBox={FINE.has(kind) ? '0 0 24 24' : '0 0 16 16'} fill="none" stroke="currentColor" strokeWidth={FINE.has(kind) ? 1.1 : 0.8} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" className={cn('fi size-3.5 shrink-0 overflow-visible', still && 'fi-still', className)}>
      {body}
    </svg>
  );
}

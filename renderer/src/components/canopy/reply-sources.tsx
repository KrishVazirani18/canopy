// A reply's closing "Sources:" list, folded: the first three links show and the list fades out partway into the
// fourth, so it reads as "there's more". One click opens the rest with a smooth height change. The links render
// through the reply's own markdown (passed in as `render`), so they open the same way as any other link in a reply.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const SHOWN = 3;
const FADE = 40; // px of the folded list that fade out at the bottom
// "Sources:", "**Sources:**", "**Sources**:", "## Sources", "References", alone on its line.
const HEADING = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?(?:sources|references)(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** The reply split at its closing sources list: everything after the last "Sources" heading must be list items (the
 *  last one may still be arriving), or nothing is split and the reply shows as written. */
export function splitSources(text: string): { body: string; items: string[] } | null {
  const lines = text.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (HEADING.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  const rest = lines.slice(at + 1).filter((l) => l.trim());
  if (!rest.length || !rest.every((l) => ITEM.test(l))) return null;
  return { body: lines.slice(0, at).join('\n').trimEnd(), items: rest.map((l) => `- ${l.replace(ITEM, '')}`) };
}

export function ReplySources({ items, render }: { items: string[]; render: (markdown: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The list's full height, and where the fold cuts it: halfway through the first hidden link.
  const [size, setSize] = useState<{ full: number; cut: number } | null>(null);
  const folds = items.length > SHOWN;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !folds) { setSize(null); return; }
    const measure = () => {
      const next = el.querySelectorAll('li')[SHOWN] as HTMLElement | undefined;
      const inner = el.firstElementChild as HTMLElement | null;
      if (!next || !inner) return;
      const top = next.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const full = el.scrollHeight, cut = Math.round(top + next.offsetHeight / 2);
      setSize((s) => (s?.full === full && s.cut === cut ? s : { full, cut }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [folds, items.length]);

  // Links under the fade can't be clicked or tabbed to until the list is open.
  useLayoutEffect(() => {
    box.current?.querySelectorAll('li').forEach((li, i) => li.toggleAttribute('inert', folds && !open && i >= SHOWN));
  });

  const folded = folds && !open;
  return (
    <div className="reply-sources">
      <div className="text-small text-muted-foreground">Sources</div>
      <div ref={box} className="reply-sources-list"
        style={{ height: folds && size ? (open ? size.full : size.cut) : undefined, ['--sources-fade' as string]: `${folded ? FADE : 0}px` }}>
        {render(items.join('\n'))}
      </div>
      {folds && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="mt-1 inline-flex items-center gap-1 text-small text-muted-foreground hover:text-foreground">
          {open ? 'Show less' : `Show ${items.length - SHOWN} more`}
          <ChevronDownIcon className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}

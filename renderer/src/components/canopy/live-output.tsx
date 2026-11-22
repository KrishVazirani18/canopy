// A running command's output, as it prints (the store keeps it on the step: `ToolItem.output`, see lib/tail.ts).
//
//   OutputTail    its last three lines, under a step that is closed: something to watch without opening anything,
//                 the way a running "Thinking" step shows the end of its thought
//   LiveOutput    all that is kept of it, in the block a finished step's result is shown in, for a step that is open
//
// Contract:
//  - Both draw nothing when there is no output. A quick command sends none before its result, a command waiting
//    for approval has none, and a Claude chat's commands never have any (Claude Code sends only elapsed time).
//  - Whoever draws them decides when: only while the step runs. Its result replaces what is shown here.
//  - What is shown is what arrived. Nothing is guessed: Codex itself can lose a command's first line.
//  - LiveOutput stays at the end as more arrives, until the reader scrolls up in it; scrolled back to the end, it
//    follows again. It is plain text: colouring up to 64,000 characters again on every chunk would cost more than
//    it shows.
import { useLayoutEffect, useRef } from 'react';
import { lastLines } from '@/lib/tail';
import { cn } from '@/lib/utils';

const TAIL_LINES = 3;
/** How close to the end still counts as "at the end" (a line and a bit). */
const NEAR_END = 24;

export function OutputTail({ text, className }: { text?: string; className?: string }) {
  const tail = lastLines(text ?? '', TAIL_LINES);
  if (!tail) return null;
  return (
    <div data-output-tail className={cn('min-w-0 font-mono text-small text-faint', className)}>
      {/* One row a line, cut at the edge: a long line never pushes the newest one out of view. */}
      {tail.split('\n').map((line, i) => <div key={i} className="truncate whitespace-pre">{line || ' '}</div>)}
    </div>
  );
}

export function LiveOutput({ text }: { text?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  if (!text?.trim()) return null;
  return (
    <div data-live-output>
      <div className="mb-1.5 text-label text-muted-foreground">Output</div>
      <div className="relative w-full overflow-hidden rounded-lg border bg-background text-foreground">
        <div ref={box} className="relative max-h-80 overflow-auto"
          onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END; }}>
          <pre className="m-0 p-3 text-code"><code className="font-mono">{text}</code></pre>
        </div>
      </div>
    </div>
  );
}

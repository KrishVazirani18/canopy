// Widgets: what Claude's show_widget puts in a reply, drawn by the real frame host (WidgetFrame) and the real page
// inside it. Each example is the widget_code of a real call (see docs/design/interactive-ui-evals.md); "Replay" feeds
// it back in pieces, the way it arrives while Claude writes. An answer sent from a widget shows as your next message.
import { useEffect, useRef, useState } from 'react';
import { WidgetFrame } from '@/components/canopy/widget-frame';
import { MessageResponse } from '@/components/ai-elements/message';
import { EXAMPLES, type Example } from './widget-examples';
import { BLOCK_EXAMPLES } from './widget-block-examples';

export const title = 'Widgets';
export const note = 'Claude’s show_widget: HTML drawn inline as it is written, in a sandboxed frame that looks like Canopy. Every component, streaming, answered, and a broken one.';

/** The code so far, growing the way a stream does (a few dozen characters every tick), from nothing to all of it. */
function useReplay(code: string, run: number) {
  const [upTo, setUpTo] = useState(code.length);
  useEffect(() => {
    if (!run) return;
    setUpTo(0);
    let at = 0;
    const id = setInterval(() => {
      at = Math.min(code.length, at + 24 + Math.floor(Math.random() * 40));
      setUpTo(at);
      if (at >= code.length) clearInterval(id);
    }, 60);
    return () => clearInterval(id);
  }, [code, run]);
  return { code: code.slice(0, upTo), streaming: upTo < code.length };
}

let serial = 0;
function Shown({ ex }: { ex: Example }) {
  const [run, setRun] = useState(0);
  const [sent, setSent] = useState<string[]>([]);
  // A fresh id per replay, so the replayed widget starts with no memory, as a new one would.
  const id = useRef(`mock-${ex.id}`);
  const replay = () => { id.current = `mock-${ex.id}-${++serial}`; setSent([]); setRun((n) => n + 1); };
  const { code, streaming } = useReplay(ex.code, run);
  return (
    <section id={`ex-${ex.id}`} className="group/ex flex flex-col gap-5">
      <div className="user-bubble ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2 text-body">{ex.ask}</div>
      <div className="flex flex-col gap-3.5">
        {ex.before && <div className="prose-reply"><MessageResponse>{ex.before}</MessageResponse></div>}
        <WidgetFrame key={id.current} callId={id.current} title={ex.title} code={code} streaming={streaming} cut={ex.cut && !streaming} live={run > 0}
          onSend={(t) => setSent((s) => [...s, t])} />
        {ex.after && !streaming && <div className="prose-reply"><MessageResponse>{ex.after}</MessageResponse></div>}
        <div className="-mt-1 flex h-6 items-center gap-3 text-small text-faint">
          <span>{ex.kind}</span>
          <button type="button" onClick={replay} className="rounded-sm text-muted-foreground opacity-0 transition-opacity duration-120 hover:text-foreground group-hover/ex:opacity-100 focus-visible:opacity-100">Replay</button>
        </div>
      </div>
      {sent.map((t, i) => <div key={i} className="user-bubble send-in ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2 text-body">{t}</div>)}
    </section>
  );
}

export default function Widgets() {
  return (
    <div className="h-full overflow-y-auto px-10 pt-8 pb-40">
      <div className="mx-auto flex w-full max-w-[var(--col)] flex-col gap-14">
        {[...EXAMPLES, ...BLOCK_EXAMPLES].map((ex) => <Shown key={ex.id} ex={ex} />)}
      </div>
    </div>
  );
}

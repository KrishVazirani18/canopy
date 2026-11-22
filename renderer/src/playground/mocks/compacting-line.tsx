// The live line while Claude condenses a long chat (auto-compact), and the notice left behind once it's done.
// Uses the real CompactingLine from the transcript; the notice text is the store's own rewrite.
import { useEffect, useState } from 'react';
import { CompactingLine } from '@/components/canopy/transcript';
import { rewriteNotice } from '@/lib/store';

export const title = 'Compacting Line';
export const note = 'What a chat shows while Claude condenses its older messages, and the note left after.';

function useSecs(from: number) {
  const [n, setN] = useState(from);
  useEffect(() => { const id = setInterval(() => setN((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  return n;
}

export default function CompactingLineMock() {
  const secs = useSecs(31);
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-10 p-10">
      <section className="flex flex-col gap-3">
        <div className="text-small text-faint">Before</div>
        <div className="flex h-6 items-center gap-2 text-ui tabular-nums">
          <span className="shimmer-text">Summarizing earlier messages</span>
          <span className="text-faint">31s</span>
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <div className="text-small text-faint">While it runs</div>
        <CompactingLine elapsed={secs} />
      </section>
      <section className="flex flex-col gap-3">
        <div className="text-small text-faint">After (the note left in the chat)</div>
        <div className="text-small text-muted-foreground">{rewriteNotice('Conversation compacted')}</div>
      </section>
    </div>
  );
}

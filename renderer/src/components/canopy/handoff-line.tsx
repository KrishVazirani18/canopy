// Where a chat switched maker: "Canopy switched from <model> → <model>", each model with its maker's mark. On your
// side of the column, in the shape of "Canopy requested an update" (it is something done on your behalf), and
// nothing opens: under the hood it is another session, but on screen it is the same chat carrying on.
// The model names were saved at the moment of the switch, so the line still reads right after a model is retired.
import { ArrowRightIcon } from 'lucide-react';
import type { CanopyEvent } from '@/lib/api';
import { Logo } from './logo';
import { MakerLogo } from './maker-logo';

type End = { engine?: unknown; model?: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const makerOf = (end: End | undefined) => (end?.engine === 'codex' ? 'openai' as const : 'claude' as const);

function Model({ end }: { end: End | undefined }) {
  const name = str(end?.model);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <MakerLogo maker={makerOf(end)} className="size-3.5 text-foreground" />
      <span className="truncate text-foreground">{name || (end?.engine === 'codex' ? 'Codex' : 'Claude')}</span>
    </span>
  );
}

export function SwitchLine({ ev }: { ev: CanopyEvent }) {
  const from = ev.from as End | undefined, to = ev.to as End | undefined;
  return (
    <div data-handoff="switch" className="ml-auto flex max-w-[85%] min-w-0 items-center gap-1.5 rounded-2xl bg-secondary px-4 py-2 text-body text-muted-foreground">
      {/* The mark and the word sit together as the sidebar's lockup does (see UpdateRequestBubble). */}
      <span className="flex shrink-0 items-center gap-1.5">
        <Logo className="size-4 shrink-0 -translate-y-px text-brand" />
        <span className="font-brand font-bold tracking-[-0.02em] text-foreground">Canopy</span>
      </span>
      <span className="shrink-0">switched from</span>
      <Model end={from} />
      <ArrowRightIcon aria-hidden className="size-3.5 shrink-0 text-faint" />
      <Model end={to} />
    </div>
  );
}

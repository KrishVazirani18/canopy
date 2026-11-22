// The line a moved chat carries: "Continued from <chat> · <model>" at the top of the chat that was moved into, and
// "Continued in <chat> · <model>" at the end of the chat it was moved on from. Quiet, on the transcript's column.
//
// The chat's name is a link to that chat. The "from" line also folds open (the transcript's fold pattern: a chevron
// on hover) to show exactly what was carried: one sentence saying which model gets it and how big it is, with a
// link that opens the full transcript, then the digest itself as the new model reads it.
// The two model names were saved at the moment of the move, so the line still reads right after a model is retired.
import { useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { api, type CanopyEvent } from '@/lib/api';
import { carriedLine, shownDigest } from '@/lib/move';
import { cn } from '@/lib/utils';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const link = 'min-w-0 truncate rounded-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-foreground/20';

/** `sent`: the chat has had its first message, so what was carried has been given to the model. */
export function HandoffLine({ ev, sent = false }: { ev: CanopyEvent; sent?: boolean }) {
  const [open, setOpen] = useState(false);
  const chat = (ev.chat ?? {}) as { id?: string; title?: string; cwd?: string };
  const title = str(chat.title) || 'Untitled chat';
  const model = str(ev.model);
  const go = () => { if (chat.id && chat.cwd) window.dispatchEvent(new CustomEvent('canopy:open-chat', { detail: { sessionId: chat.id, cwd: chat.cwd } })); };
  const name = <button type="button" onClick={go} title={`Open “${title}”`} className={link}>{title}</button>;

  if (ev.dir !== 'from') {
    return (
      <div data-handoff="to" className="flex h-6 min-w-0 items-center gap-1 text-small text-faint">
        <span className="shrink-0">Continued in</span>{name}{model && <span className="shrink-0">· {model}</span>}
      </div>
    );
  }
  const digest = shownDigest(ev.digest);
  const file = str(ev.file);
  // Nothing to show (its files were cleared away long after): the line stands alone, with no fold.
  if (!digest) {
    return (
      <div data-handoff="from" className="flex h-6 min-w-0 items-center gap-1 text-small text-faint">
        <span className="shrink-0">Continued from</span>{name}{model && <span className="shrink-0">· {model}</span>}
      </div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-handoff="from">
      <div className="group/s flex h-6 w-fit max-w-full min-w-0 items-center gap-1 text-small text-faint">
        <span className="shrink-0">Continued from</span>
        {name}
        <CollapsibleTrigger aria-label={open ? 'Hide what was carried' : 'Show what was carried'}
          className="flex shrink-0 items-center gap-1 rounded-md outline-none hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-foreground/20">
          {model && <span>· {model}</span>}
          <span className={cn('transition-opacity duration-120', !open && 'opacity-0 group-hover/s:opacity-100 group-focus-within/s:opacity-100')}>
            <ChevronRightIcon aria-hidden className={cn('size-3.5 shrink-0 text-faint', open && '[transform:rotate(90deg)]')} />
          </span>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="mt-1.5">
        <p className="mb-2 text-small text-muted-foreground">
          {carriedLine(str(ev.toModel), ev.tokens, sent)}
          {file && <> It can also open <button type="button" onClick={() => { void api.openPath(file); }} className={cn(link, 'inline underline decoration-foreground/25')}>the full transcript</button>.</>}
        </p>
        <div className="ml-[2px] border-l border-hairline pl-[14px] prose-reply prose-compact text-muted-foreground">
          <MessageResponse>{digest}</MessageResponse>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Settings → Claude Code, its accounts: removing a Claude sign-in that was added in Canopy. "Remove…" in its row's menu
// (account-actions.tsx) opens the question asked before anything happens: main has Claude Code sign that one
// account out, deletes its folder and drops it from the list (src/account-folders.mjs). Built like the restart
// question (restart-dialog.tsx).
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { removeProblem, removeQuestion, type AccountChange } from '@/lib/account-rules';
import { api, type Account } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ProviderLogo } from './provider-logo';

const btn = 'flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-ui transition-colors disabled:opacity-60';

/** The question itself. `onDone` runs once the account is gone. `returnFocus`: where focus goes when it closes (the control that opened it). */
export function RemoveAccountDialog({ a, inUse, open, onOpenChange, onDone, returnFocus }: {
  a: Account; inUse: boolean; open: boolean; onOpenChange: (open: boolean) => void; onDone?: () => void; returnFocus?: React.RefObject<HTMLElement | null>;
}) {
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const q = removeQuestion(a, inUse);
  const close = (next: boolean) => { if (removing) return; if (!next) setProblem(null); onOpenChange(next); };
  const remove = async () => {
    setRemoving(true);
    setProblem(null);
    let r: AccountChange | null = null;
    try {
      const folders = a.engine === 'codex' ? api.codexFolders : api.accountFolders;
      r = (await folders?.remove(a.id)) ?? { ok: false, message: 'Restart Canopy to finish setting this up.' };
    }
    catch (err) { r = { ok: false, message: String((err as Error)?.message ?? err) }; }
    setRemoving(false);
    const failed = removeProblem(r);
    if (failed) { setProblem(failed); return; }
    onOpenChange(false);
    onDone?.();
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} style={{ left: 'calc(50% + var(--canopy-sidebar, 0px) / 2)' }} className="w-[440px] max-w-[90vw] gap-0 p-5 sm:max-w-[90vw]"
        onCloseAutoFocus={(e) => { if (returnFocus?.current) { e.preventDefault(); returnFocus.current.focus(); } }}>
        {/* Laid out like a Mac alert, as the other questions about an account are: whose it is, then what happens.
            The mark is only a picture (the row it came from is named for its maker), drawn at 40 in a box of 32
            because the picture carries a margin of its own. */}
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center"><ProviderLogo engine={a.engine} size={40} className="max-w-none" /></span>
          <DialogTitle className="min-w-0 flex-1 text-ui font-semibold text-balance">{q.title}</DialogTitle>
        </div>
        <DialogDescription className="mt-3.5 text-small text-muted-foreground">{q.body}</DialogDescription>
        {/* What went wrong takes the note's place, so the question keeps its size. */}
        <p role={problem ? 'alert' : undefined} className={cn('mt-2 flex min-h-8 gap-2 text-small', problem ? 'text-foreground/80' : 'text-muted-foreground')}>
          {problem && <span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-warn" />}
          <span>{problem ?? q.note}</span>
        </p>
        <div className="mt-5 flex items-center gap-2">
          <button autoFocus className={cn(btn, 'border border-hairline hover:bg-accent')} disabled={removing} onClick={() => close(false)}>Cancel</button>
          <button className={cn(btn, 'ml-auto border border-hairline text-destructive hover:bg-accent')} disabled={removing} onClick={remove}>
            {removing && <Spinner className="size-3.5" />}{removing ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

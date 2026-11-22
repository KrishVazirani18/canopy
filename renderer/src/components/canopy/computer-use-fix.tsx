// Under a Computer Use step that failed for a reason you can fix: one line that says what is missing, and the one
// button that fixes it (lib/computer-use-fix.ts). Quiet, like the step it sits under.
import { api } from '@/lib/api';
import { computerUseFix, computerUseFixes, type ComputerUseFix } from '@/lib/computer-use-fix';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

const button = 'shrink-0 rounded-md border border-hairline px-2 py-0.5 text-small text-foreground transition-colors hover:border-foreground/25';

function FixLine({ fix, className }: { fix: ComputerUseFix; className?: string }) {
  const store = useStore();
  const again = (prompt: string) => { if (store.meta.busy) store.enqueue(prompt, []); else store.dispatch(prompt, []); };
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted-foreground', className)}>
      <span className="min-w-0">{fix.line}</span>
      {fix.kind === 'permission'
        ? api.computerUse && <button type="button" className={button} onClick={() => { api.computerUse?.openPane(fix.pane).catch(() => {}); }}>Open Settings</button>
        : <button type="button" className={button} onClick={() => again(fix.prompt)}>Try again</button>}
    </div>
  );
}

/** Under one failed step's row. */
export function ComputerUseFixLine({ name, result, failed }: { name: string; result?: string; failed: boolean }) {
  const fix = computerUseFix(name, result, failed);
  return fix ? <FixLine fix={fix} className="mb-1.5 ml-[2px] border-l border-hairline pl-[14px]" /> : null;
}

/** Under a folded run of steps (a group, or a finished turn's "Worked for…"), so the fix is in view without opening it. */
export function ComputerUseFixes({ steps, className }: { steps: { name: string; result?: string | null; status?: string }[]; className?: string }) {
  const fixes = computerUseFixes(steps);
  if (!fixes.length) return null;
  return <div className={cn('flex flex-col gap-1', className)}>{fixes.map((f) => <FixLine key={f.line} fix={f} />)}</div>;
}

import { MousePointer2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Small cursor with a click halo while a computer action is actually running. */
export function ComputerUseIcon({ active = false, className }: { active?: boolean; className?: string }) {
  return (
    <span aria-hidden="true" data-active={active || undefined}
      className={cn('computer-use-icon relative inline-flex size-6 shrink-0 items-center justify-center rounded-lg',
        active ? 'bg-brand/10 text-brand' : 'bg-foreground/[0.04] text-muted-foreground', className)}>
      <span className="computer-use-cursor relative z-[1] flex">
        <MousePointer2Icon className="size-3.5 fill-current stroke-[1.5]" />
      </span>
    </span>
  );
}

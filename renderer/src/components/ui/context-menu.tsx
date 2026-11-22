// Right-click menus, styled like the dropdown menus (same surface, items and pop-in).
import * as React from 'react';
import { ContextMenu as P } from 'radix-ui';
import { cn } from '@/lib/utils';

export const ContextMenu = P.Root;
export const ContextMenuTrigger = P.Trigger;

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content className={cn('z-50 min-w-[10rem] overflow-hidden rounded-[10px] border bg-popover p-1 text-popover-foreground elev-pop menu-pop', className)} {...props} />
    </P.Portal>
  );
}
export function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof P.Item>) {
  return (
    <P.Item className={cn("relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-ui outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground", className)} {...props} />
  );
}
export function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof P.Separator>) {
  return <P.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

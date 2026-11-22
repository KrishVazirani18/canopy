// "Update ready": a card in the sidebar's deck above your name (sidebar-cards.tsx), and a small button in the collapsed rail.
// With nothing running, Restart is instant. While any chat is working (on screen or not), restarting would cut it
// off, so the button says it waits, and Canopy restarts by itself once every chat is done.
//
// Two things make an update ready. In the released app: a new Canopy is downloaded (lib/app-update.ts), and the
// restart installs it. From source: an engine file changed, and the restart loads it. The same card serves both; the
// released app's also covers a version that is only offered (automatic updates off, or a copy that cannot replace itself).
import { useEffect, useState } from 'react';
import { ArrowDownToLineIcon, RotateCwIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SidebarCardSpec } from './sidebar-cards';
import { api } from '@/lib/api';
import { appUpdate, useAppUpdate } from '@/lib/app-update';
import { updateCard } from '@/lib/app-update-words';
import { useBusyChats } from '@/lib/chats';
import { useStore } from '@/lib/store';
import { feature } from '@/lib/telemetry';
import { ui, useUi } from '@/lib/ui';
import { cn } from '@/lib/utils';

function useRestart() {
  const { meta } = useStore();
  const { updateWaiting: waiting } = useUi();
  // The chat on screen can be busy a moment before its status says so.
  const busy = Math.max(useBusyChats(), meta.busy ? 1 : 0);
  useEffect(() => { if (waiting && !busy) api.restartApp?.(); }, [waiting, busy]);
  return {
    waiting, busy,
    // Main holds the wait (it restarts once the last chat's turn ends), so a window reload in between keeps it.
    restart: () => { feature('update_toast_clicked'); if (busy) ui.set({ updateWaiting: true }); api.restartApp?.(); },
    cancel: () => { ui.set({ updateWaiting: false }); api.restartCancel?.(); },
  };
}

const finishing = (n: number) => (n > 1 ? `${n} chats finish` : '1 chat finishes');
const working = (n: number) => (n > 1 ? `${n} chats are still working` : '1 chat is still working');
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "Update ready", as a card for the sidebar's deck (sidebar-cards.tsx). It has no ×: it stays until you restart.
 * With chats working, the button waits for them; once it waits, the card says so and the button cancels.
 */
export function useUpdateCard(): SidebarCardSpec | null {
  const { updateReady } = useUi();
  const app = useAppUpdate();
  const { waiting, busy, restart, cancel } = useRestart();
  const [putAway, setPutAway] = useState<string | null>(null); // the version whose "move Canopy" card was closed
  const card = app ? updateCard(app, busy, waiting) : null;
  const shown = updateReady || (!!card && !(card.kind === 'elsewhere' && putAway === app?.available));
  // When the update arrived, for the deck's order (the newest card is in front). Kept while it stays ready.
  const [at, setAt] = useState(0);
  useEffect(() => { setAt(shown ? Date.now() : 0); }, [shown]);
  if (!shown) return null;
  // The released app: a new Canopy is ready, or on offer.
  if (card && app) {
    const ready = card.kind === 'ready';
    return {
      id: 'update', at: at || Date.now(), title: card.title, body: card.body, compact: ready && waiting,
      icon: ready ? <RotateCwIcon className={cn('size-[18px]', waiting && 'animate-spin [animation-duration:2s]')} /> : <ArrowDownToLineIcon className="size-[18px]" />,
      action: {
        label: card.action,
        run: ready ? (waiting ? cancel : restart)
          : card.kind === 'elsewhere' ? () => { if (app.downloadUrl) window.open(app.downloadUrl); }
          : () => { if (app.state === 'idle') void appUpdate.download(); },
      },
      ...(card.kind === 'elsewhere' && { close: () => setPutAway(app.available) }),
    };
  }
  return {
    id: 'update', at: at || Date.now(), compact: waiting,
    icon: <RotateCwIcon className={cn('size-[18px]', waiting && 'animate-spin [animation-duration:2s]')} />,
    title: waiting ? 'Restarting soon' : 'Update ready',
    body: waiting ? `Canopy restarts by itself after ${finishing(busy)}.`
      : busy ? `${capital(working(busy))}. Restart waits for ${busy > 1 ? 'them' : 'it'} to finish.`
      : 'Restart to get the newest Canopy. Your chats pick up where they were.',
    action: waiting ? { label: 'Cancel', run: cancel } : { label: busy ? 'Restart when done' : 'Restart', run: restart },
  };
}

/** Collapsed sidebar: a single restart button with a green dot. */
export function UpdateRailButton() {
  const { updateReady } = useUi();
  const app = useAppUpdate();
  const { waiting, busy, restart } = useRestart();
  if (!updateReady && !(app?.ready && !app.required)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={restart} aria-label="Restart to update"
          className="relative mb-2 flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground">
          <RotateCwIcon className={cn('size-4', waiting && 'animate-spin [animation-duration:2s]')} />
          <span className="absolute top-1 right-2 size-1.5 rounded-full bg-brand shadow-[0_0_6px_var(--brand)]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{waiting ? `Restarting after ${finishing(busy)}` : busy ? 'Update ready · Restart when done' : 'Update ready · Restart'}</TooltipContent>
    </Tooltip>
  );
}

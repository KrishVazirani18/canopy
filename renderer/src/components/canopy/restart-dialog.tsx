// Quitting (⌘Q, closing the window) or Canopy → Restart Canopy while chats are going: asked here, in Canopy's own
// dialog (not a macOS alert). The main process sends app:restart-ask (quit or restart, and each chat with where it
// stands) and waits: wait, now, or cancel.
//
// Asked as a plain question, the chats listed the way the sidebar shows them (Working… in green, Waiting for you),
// one line on what "now" costs, and buttons that fit:
//   something is working  → Cancel · Restart now · Restart when done (default)
//   only waiting for you  → Cancel · Restart (nothing finishes on its own, so "when done" would wait forever)
// Every case is the same size: fixed width, room for three chats (then "and N more"), one-line subtitle and note.
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { feature } from '@/lib/telemetry';
import { cn } from '@/lib/utils';

type Going = { title: string; helpers: number; state?: 'working' | 'waiting' };
type Ask = { kind?: 'quit' | 'restart'; busy: number; names?: Going[] };

const SHOWN = 3;
const btn = 'flex h-8 items-center justify-center rounded-lg px-3.5 text-ui transition-colors';

export function RestartDialog() {
  const [ask, setAsk] = useState<Ask | null>(null);
  // The last question stays rendered while the dialog animates out.
  const [last, setLast] = useState<Ask | null>(null);
  useEffect(() => api.onRestartAsk?.((q) => { setAsk(q); setLast(q); }), []);
  const answer = (choice: 'wait' | 'now' | 'cancel') => {
    if (choice !== 'cancel' && ask?.kind !== 'quit') feature('restart_clicked');
    setAsk(null); api.restartChoice?.(choice);
  };

  const q = ask ?? last;
  const going = q?.names?.length ? q.names : [{ title: 'A chat', helpers: 0, state: 'working' as const }];
  const working = going.filter((g) => g.state !== 'waiting').length;
  const verb = q?.kind === 'quit' ? 'Quit' : 'Restart';
  const ing = verb === 'Quit' ? 'Quitting' : 'Restarting';
  const one = going.length === 1;
  const subtitle = !working
    ? (one ? 'A chat is waiting for you.' : `${going.length} chats are waiting for you.`)
    : one ? 'A chat is still working.' : `${going.length} chats are still going.`;
  const note = !working
    ? `Nothing is lost: ${one ? 'it picks' : 'they pick'} up where you left off.`
    : `${ing} now stops ${one ? 'it' : 'them'} mid-step. ${verb === 'Quit' ? 'Every chat is saved.' : 'Chats reopen either way.'}`;
  const more = going.length - SHOWN;

  return (
    <Dialog open={ask != null} onOpenChange={(o) => { if (!o && ask) answer('cancel'); }}>
      <DialogContent showCloseButton={false} style={{ left: 'calc(50% + var(--canopy-sidebar, 0px) / 2)' }}
        className="w-[440px] max-w-[90vw] gap-0 p-5 sm:max-w-[90vw]">
        <DialogTitle className="text-ui font-semibold">{verb} Canopy?</DialogTitle>
        <p className="mt-1 truncate text-small text-muted-foreground">{subtitle}</p>

        {/* Always three rows tall, so every case is the same size. */}
        <ul className="mt-3 h-[108px] divide-y divide-hairline overflow-hidden">
          {going.slice(0, more > 0 ? SHOWN - 1 : SHOWN).map((g, i) => (
            <li key={i} className="flex h-9 min-w-0 items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-ui">{g.title}</span>
              <span className={cn('shrink-0 text-small', g.state === 'waiting' ? 'text-muted-foreground' : 'working-line font-medium')}>
                {g.state === 'waiting' ? 'Waiting for you' : g.helpers > 0 ? `Working… · ${g.helpers === 1 ? '1 agent' : `${g.helpers} agents`}` : 'Working…'}
              </span>
            </li>
          ))}
          {more > 0 && <li className="flex h-9 items-center text-small text-muted-foreground">and {more + 1} more</li>}
        </ul>

        <DialogDescription className="mt-2 truncate text-small text-muted-foreground" title={note}>{note}</DialogDescription>

        <div className="mt-5 flex items-center gap-2">
          <button className={cn(btn, 'text-muted-foreground hover:text-foreground')} onClick={() => answer('cancel')}>Cancel</button>
          {working > 0 ? (
            <>
              <button className={cn(btn, 'ml-auto border border-hairline hover:bg-accent')} onClick={() => answer('now')}>{verb} now</button>
              <button autoFocus className={cn(btn, 'bg-foreground font-medium text-background hover:opacity-90')} onClick={() => answer('wait')}>{verb} when done</button>
            </>
          ) : (
            <button autoFocus className={cn(btn, 'ml-auto bg-foreground font-medium text-background hover:opacity-90')} onClick={() => answer('now')}>{verb}</button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

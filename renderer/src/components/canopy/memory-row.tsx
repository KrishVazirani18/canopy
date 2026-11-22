// What a chat did to Canopy Memory (the remember and forget tools, src/core/memory-tools.mjs), as one quiet line in
// the conversation: "Saved to memory", what it says, and Undo; or "Removed from memory", which note, and Undo. It
// stays in view when the turn's work folds away, because it is the one step of a turn that outlives the chat: every
// later chat starts out knowing the note, or no longer does.
//
// Undo takes a saved note out again (it waits in memory's trash, so the same line then offers Restore), and puts a
// removed one back. A save that replaced an older note is undone by putting the older wording back; the line says
// what that was when you point at it. The line asks where the note stands when it is drawn, so a chat read again
// later still says the truth (a note since deleted in Settings offers Restore).
import { useEffect, useState } from 'react';
import { BookmarkIcon } from 'lucide-react';
import { api } from '@/lib/api';
import type { ToolItem } from '@/lib/store';
import { cn } from '@/lib/utils';
import { FORGET_TOOL } from './tool-details';

/** What the tools answer with (SAVED_RE and FORGOT_RE in memory-tools.mjs): whether a save was new, and the note's id. */
const SAVED = /^(Saved to|Updated in) memory \[id ([a-z0-9]{4,16})\]/;
const FORGOT = /^Removed from memory \[id ([a-z0-9]{4,16})\]: "(.*?)"\.(?: |$)/;
/** What a save that replaced a note says it replaced, and what a removed note said. */
const REPLACED = / It replaced: "(.*?)"\.(?: |$)/;
const IT_SAID = / It said: "(.*?)"\.(?: |$)/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

type Stand = 'kept' | 'removed' | 'reverted' | 'unknown';

export function MemoryRow({ item, className }: { item: ToolItem; className?: string }) {
  const running = item.status === 'running' || item.status === 'approval';
  const forgot = item.name === FORGET_TOOL;
  const result = item.result ?? '';
  const saved = forgot ? null : SAVED.exec(result);
  const gone = forgot ? FORGOT.exec(result) : null;
  const id = saved?.[2] ?? gone?.[1] ?? null;
  const replaced = saved?.[1] === 'Updated in';
  const before = replaced ? REPLACED.exec(result)?.[1] ?? '' : '';
  const [stand, setStand] = useState<Stand>('unknown');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (!id || typeof api?.memory?.state !== 'function') return;
    api.memory.state(id).then((s) => {
      if (!live || !s || 'error' in s) return;
      setStand(s.note ? 'kept' : s.removed ? 'removed' : 'unknown');
    }, () => {});
    return () => { live = false; };
  }, [id]);

  // A call that was refused (too long, a secret, no such note) is the model's to deal with: nothing changed, so
  // nothing is said.
  if (!running && (item.isError || item.status === 'error' || !id)) return null;
  // The note itself, in the words later chats will be shown: clearer than its title. A removal names the note it removed.
  const said = forgot ? gone?.[2] || str(item.input.note) : str(item.input.note) || str(item.input.title);
  const act = async () => {
    if (!id || busy || !api?.memory) return;
    setBusy(true);
    try {
      if (replaced) { const r = await api.memory.revert(id); if (r && 'note' in r && r.note) setStand(stand === 'reverted' ? 'kept' : 'reverted'); }
      else if (stand === 'removed') { const r = await api.memory.restore(id); if (r && 'note' in r && r.note) setStand('kept'); }
      else { const r = await api.memory.remove(id); if (r && 'ok' in r && r.ok) setStand('removed'); }
    } finally { setBusy(false); }
  };
  // A removal reads the other way round from a save: the note being gone is what the chat did, and Undo brings it back.
  const label = forgot
    ? (running ? 'Forgetting' : stand === 'kept' ? 'Kept in memory' : 'Forgot')
    : (running ? 'Remembering' : stand === 'removed' ? 'Not remembered' : stand === 'reverted' ? 'Put back as it was' : replaced ? 'Updated memory' : 'Remembered');
  const button = forgot ? (stand === 'kept' ? 'Remove' : 'Undo') : stand === 'removed' ? 'Restore' : stand === 'reverted' ? 'Redo' : 'Undo';
  const struck = forgot ? stand !== 'kept' && !running : stand === 'removed' || stand === 'reverted';
  // Pointing at the line says the note in full: what was saved (and what it replaced), or what the removed one said.
  const hint = (forgot ? IT_SAID.exec(result)?.[1] : [str(item.input.note), before && `Before: ${before}`].filter(Boolean).join('\n\n')) || undefined;
  return (
    <div data-memory-row className={cn('flex h-7 min-w-0 items-center gap-2 text-small text-muted-foreground', className)}>
      <BookmarkIcon aria-hidden className={cn('size-3.5 shrink-0 text-faint', running && 'opacity-60')} />
      <span className={cn('shrink-0', running && 'shimmer-text')}>{label}</span>
      {said && <span className={cn('min-w-0 truncate text-foreground/85', struck && 'text-faint line-through decoration-faint/60')} title={hint}>{said}</span>}
      {/* The button comes in once the note is known to be there (or restorable): at the end of the line, so nothing moves. */}
      <button type="button" onClick={act} disabled={busy || stand === 'unknown'} aria-hidden={stand === 'unknown'}
        className={cn('-my-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-muted-foreground transition-opacity duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:outline-none disabled:pointer-events-none',
          stand === 'unknown' ? 'opacity-0' : 'opacity-100')}>
        {button}
      </button>
    </div>
  );
}

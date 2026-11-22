// Moving a chat to the other maker, window side: can this chat move, where to, and the call.
//
// Picking the other maker's model in a chat that has started moves the chat: a new chat of that maker opens in the
// same folder (in the same pane, in Multi mode) and starts with what the old one was about. Main builds what is
// carried from the old chat itself, with no model, and nothing is sent until you send the new chat its first
// message (src/handoffs.mjs). The old chat stays where it was; the two say which continued which (handoff-line.tsx).
//
//   canMove(store)       'ok' | 'busy' | 'no'  (the rules are lib/move-rules.ts, tested in node)
//   moveTarget(store)    the model "Move to …" lands on, and its name
//   moveChat(store, …)   stop a planning turn if one is waiting on its plan, carry the mode, ask the window for the open
//
// What travels besides the conversation: the folder, the permission mode (one of the five both makers have, else
// Ask), the chat's name, and what you had typed in the message box. Nothing here throws.
import { toast } from 'sonner';
import type { OpenOpts } from './api';
import { choices } from './choices';
import { claudeRows, openaiRows } from './engines';
import { allModels, savedModels } from './models';
import { MOVE_BUSY, movable, moveSource, otherEngine, targetFor, type Movable, type MoveTarget } from './move-rules.ts';
import type { Store } from './store';

export { carriedLine, modelLabel, moveItem, moveLine, moveSource, otherEngine, rowWords, shownDigest, type Movable, type MoveTarget } from './move-rules.ts';
export type Move = NonNullable<OpenOpts['move']>;

const SHARED_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const FREE_WAIT_MS = 5000;
const rowsFor = (store: Store) => allModels(claudeRows(store.meta), openaiRows());

/** Can this chat be moved to the other maker right now? */
export function canMove(store: Store): Movable {
  const other = otherEngine(store.meta.engine);
  return movable(store, rowsFor(store).some((m) => m.engine === other));
}

/** The model a move lands on when none was picked (the chat menu's "Move to …"). Null: that maker has none to offer. */
export function moveTarget(store: Store): MoveTarget | null {
  return targetFor(rowsFor(store), otherEngine(store.meta.engine), choices, savedModels());
}

const waitingOnYou = (store: Store) => store.items.some((i) => i.t === 'permission' && !i.resolved);
/** Resolves once the chat is neither working nor waiting on you, or after `ms`: to whether it is free. */
function free(store: Store, ms: number): Promise<boolean> {
  const isFree = () => !store.meta.busy && !waitingOnYou(store);
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const look = () => { if (isFree()) resolve(true); else if (Date.now() > end) resolve(false); else setTimeout(look, 50); };
    look();
  });
}

// What was typed in the old chat's message box, as the composer last saved it (composer.tsx keeps each chat's draft).
function draftOf(sessionId: string | null): string {
  if (!sessionId) return '';
  try { const v = JSON.parse(localStorage.getItem('canopy.drafts') ?? '{}')[`s:${sessionId}`]; return typeof v === 'string' ? v : typeof v?.t === 'string' ? v.t : ''; } catch { return ''; }
}

/**
 * Move this chat to the other maker. The pick itself (which model, and that new chats start on that maker) has been
 * saved by the caller, as for any model row. `toModel` and `fromModel` are the two names on screen right now.
 * Resolves to whether the window was asked for the new chat.
 */
export async function moveChat(store: Store, toModel: string, fromModel: string): Promise<boolean> {
  try {
    const source = moveSource(store);
    if (!source || canMove(store) !== 'ok') { toast(MOVE_BUSY, { id: 'move-busy' }); return false; }
    // Only a plan is waiting, in a turn that is paused on it: the planning turn is stopped first, and the plan
    // travels as "not approved yet". (A plan Canopy itself is showing has no turn behind it: nothing to stop.)
    if (store.meta.busy) {
      await store.interrupt();
      if (!(await free(store, FREE_WAIT_MS))) { toast(MOVE_BUSY, { id: 'move-busy' }); return false; }
    }
    // The mode is shared by both makers and carried as it is, Plan included.
    const mode = store.meta.mode ?? choices.mode ?? 'default';
    choices.mode = SHARED_MODES.includes(mode) ? mode : 'default';
    // What you had typed comes along: put in the new chat's box once that chat is on screen.
    const typed = source.pending ? '' : draftOf(source.id);
    const arrived = () => {
      clearTimeout(giveUp);
      requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(typed.trim() ? new CustomEvent('canopy:prefill', { detail: typed }) : new Event('canopy:focus-composer'))));
    };
    const giveUp = setTimeout(() => window.removeEventListener('canopy:moved', arrived), 20000);
    window.addEventListener('canopy:moved', arrived, { once: true });
    const move: Move = { from: source.id, fromModel: source.model ?? fromModel, toModel };
    window.dispatchEvent(new CustomEvent('canopy:other-maker', { detail: { move } }));
    return true;
  } catch { return false; }
}

// Moving a chat to the other maker: the rules that need no window (lib/move.ts is the part that does).
//
//   moveSource(chat)        which chat a move would carry on from
//   movable(chat, …)        'ok', 'busy' (after this turn) or 'no' (there is nothing to move, or nowhere to move it)
//   targetFor(…)            the model a "Move to …" lands on: your last pick for that maker, else its first menu row
//   rowWords, moveItem, moveLine, carriedLine, tokensLabel     the words, in one place
//
// A chat can be moved once it is saved (it has an id), while nothing is running in it and nothing waits on you.
// One exception: a plan may be waiting. "Plan with one, build with the other" is the move people make most, so a
// chat whose only open question is a plan can move (the planning turn is stopped first, lib/move.ts).
// A chat that was moved here and has had no message yet is not saved, but it is not empty either: moving it again
// moves the chat it came from.
//
// Nothing here reads the window or throws: bad input gives the empty answer. That is what lets a plain node test run
// this file as it is (src/core/test/unit/move-rules.test.mjs). The one import is written with its `.ts` ending for
// the same reason.
import type { Engine } from './api';
import { MAKER_NAME, engineMaker, pickValue, splitMenu, type Model, type Picks, type SavedModels } from './model-rules.ts';

export type Movable = 'ok' | 'busy' | 'no';
/** The parts of a store these rules read. */
export type MoveChat = {
  meta: { sessionId: string | null; busy: boolean; loading?: boolean };
  items: readonly { t: string; resolved?: boolean; ev?: Record<string, unknown> }[];
  cutPending?: boolean;
};
export type MoveSource = { id: string; /** The model's name, when the chat itself does not run it any more (a pending move). */ model: string | null; pending: boolean };
export type MoveTarget = { engine: Engine; /** What picking the row saves and sends. */ value: string; /** Its name on screen. */ label: string };

export const otherEngine = (engine: Engine | string | null | undefined): Engine => (engine === 'codex' ? 'claude' : 'codex');

const itemsOf = (chat: MoveChat | null | undefined) => (Array.isArray(chat?.items) ? chat!.items : []);
/** The "Continued from" line of a chat that was moved here, if it has one. */
const cameFrom = (chat: MoveChat | null | undefined) => itemsOf(chat).find((i) => i?.t === 'handoff' && i.ev?.dir === 'from')?.ev ?? null;

/**
 * The chat a move would carry on from: this one when it is saved; for a chat that was moved here and has had no
 * message yet, the chat it came from (moving it again replaces that move). Null: nothing to carry.
 */
export function moveSource(chat: MoveChat | null | undefined): MoveSource | null {
  const id = chat?.meta?.sessionId;
  if (typeof id === 'string' && id) return { id, model: null, pending: false };
  const from = cameFrom(chat);
  const fromId = (from?.chat as { id?: unknown } | undefined)?.id;
  if (from && !chat?.meta?.busy && typeof fromId === 'string' && fromId) return { id: fromId, model: typeof from.model === 'string' ? from.model : null, pending: true };
  return null;
}

/** The questions waiting on you in this chat. */
const waiting = (chat: MoveChat | null | undefined) => itemsOf(chat).filter((i) => i?.t === 'permission' && !i.resolved);
/** A plan is waiting, and nothing else is. */
export function onlyPlanWaits(chat: MoveChat | null | undefined): boolean {
  const w = waiting(chat);
  return w.length > 0 && w.every((i) => i.ev?.type === 'plan');
}

/**
 * Can this chat be moved right now? `otherHasModels`: the other maker has models to offer.
 *   'ok'    yes
 *   'busy'  not until its turn is over (it is working, or waiting on an approval or a question)
 *   'no'    there is nothing to move (a chat that has not started) or nowhere to move it
 */
export function movable(chat: MoveChat | null | undefined, otherHasModels: boolean): Movable {
  if (!otherHasModels || !chat?.meta) return 'no';
  // Working on its very first message: it has no id to move yet, and will have one after this turn.
  if (!moveSource(chat)) return chat.meta.busy ? 'busy' : 'no';
  if (chat.meta.loading || chat.cutPending) return 'busy';
  const w = waiting(chat);
  if (w.some((i) => i.ev?.type !== 'plan')) return 'busy';
  return chat.meta.busy && !w.length ? 'busy' : 'ok';
}

/**
 * Where "Move to …" lands for the maker `engine`: your last pick for that maker, else the first of that maker's rows
 * in the menu, else its first model. Null when that maker has no models to offer.
 */
export function targetFor(all: Model[], engine: Engine, picks: Picks | null | undefined, saved?: SavedModels): MoveTarget | null {
  const rows = (Array.isArray(all) ? all : []).filter((m) => m?.engine === engine);
  if (!rows.length) return null;
  const picked = engine === 'codex' ? picks?.codex?.model : picks?.model;
  const model = (picked ? rows.find((m) => m.id === picked) : null) ?? splitMenu(all, saved).rows.find((m) => m.engine === engine) ?? rows[0];
  return { engine, value: pickValue(model, picks), label: model.label };
}

/** The name on screen of the model a row's value means, for the "Continued in" line. */
export function modelLabel(all: Model[], engine: Engine, value: string): string {
  const rows = (Array.isArray(all) ? all : []).filter((m) => m?.engine === engine);
  return (rows.find((m) => m.id === value) ?? (value ? null : rows.find((m) => m.isDefault)))?.label ?? (value || 'Default');
}

// ---------- the words ----------

/** Beside the arrow on a row of the other maker, in a chat that has started. */
export const rowWords = (move: Movable | null | undefined): string => (move === 'busy' ? 'After this turn' : move === 'ok' ? 'Move chat' : 'New chat');
/** The chat menu's item. */
export const moveItem = (engine: Engine): string => `Move to ${MAKER_NAME[engineMaker(engine)]}`;
/** Its second line. */
export const moveLine = (label: string, move: Movable): string => (move === 'busy' ? 'Available after this turn' : `Continues in ${label} with this chat’s context`);
export const MOVE_BUSY = 'Wait for this chat to finish, then move it.';

/** "about 3.1k tokens", "about 240 tokens". */
export function tokensLabel(tokens: unknown): string {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  return `about ${n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n} token${n === 1 ? '' : 's'}`;
}
/** The line over what was carried: before the first message it is still to come, after it it has been given. */
export const carriedLine = (model: string, tokens: unknown, sent: boolean): string =>
  `${model || 'The new model'} ${sent ? 'got' : 'gets'} this with your first message, ${tokensLabel(tokens)}.`;

/**
 * The digest as it is shown: without the tags that mark it for the model, and with its plain lines kept as lines
 * (markdown would run "[x] one" and "[ ] two" together into one paragraph; list items and headings are left alone).
 */
export function shownDigest(digest: unknown): string {
  if (typeof digest !== 'string') return '';
  const lines = digest.replace(/^\s*<canopy_handoff>\s*/, '').replace(/\s*<\/canopy_handoff>\s*$/, '').split('\n');
  const plain = (l: string | undefined) => !!l && !/^(\s|#|-|\d+\.|…)/.test(l);
  return lines.map((l, i) => (plain(l) && plain(lines[i + 1]) ? `${l}  ` : l)).join('\n');
}

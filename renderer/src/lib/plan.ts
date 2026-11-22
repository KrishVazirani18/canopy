// The plan card's rules, the same for both makers: is a plan waiting, what Build it and Keep planning do, which
// mode Build it goes back to, and how a chat's events become the one card (live, and when a saved chat is read back).
//
// A plan in the chat is a `permission` item whose `ev.type` is 'plan'. A Claude chat's comes from Claude Code's
// own plan prompt, answered through the engine. An OpenAI chat's is raised by Canopy when a Plan-mode turn ends
// with a plan (`ev.passive`): nothing is owed to the engine, and Build it sends BUILD_WORDS as a turn. No
// component asks which it is: only keepPlanning() here does, to send the words the way that maker takes them.
//
// Contract:
//  - No React and no window: node runs this file as it is (src/core/test/unit/plan-rules.test.mjs).
//  - The frozen words (BUILD_WORDS, how "keep planning" is said to Claude Code) have one copy, in
//    src/core/plan-ready.mjs, which the engine uses too.
//  - Nothing here throws.
import type { Answer, CanopyEvent, ImageAttachment } from './api';
import type { Item, PermissionItem, Store } from './store';
// @ts-expect-error The engine's files are plain .mjs with no types: what is used of this one is typed just below.
import * as planReady from '../../../src/core/plan-ready.mjs';

const ready = planReady as {
  BUILD_WORDS: string;
  planText(text: unknown): string | null;
  taggedPlan(text: unknown): string | null;
  withoutTagged(text: unknown): string;
  planOutcome(result: unknown, isError?: boolean): { outcome: PlanOutcome | null; feedback: string };
};

/** What Build it sends in an OpenAI chat. Never shown as something you typed. */
export const BUILD_WORDS = ready.BUILD_WORDS;

export type PlanOutcome = 'approved' | 'kept';
/** A plan in the chat. `outcome`: how it was answered, once it was (a plan that was withdrawn has none). */
export type PlanItem = PermissionItem & { outcome?: PlanOutcome };

export const isPlan = (it: Item | undefined | null): it is PlanItem => !!it && it.t === 'permission' && it.ev?.type === 'plan';
export const planTextOf = (item: PermissionItem): string => String(item.ev?.input?.plan ?? '');
/** The quiet word on an answered card. A plan that went away unanswered says nothing. */
export const outcomeWord = (item: PlanItem): string => (item.outcome === 'approved' ? 'Approved' : item.outcome === 'kept' ? 'Kept planning' : '');

/** The plan waiting for an answer in this chat (the newest, if a newer one replaced an older), or null. */
export function waitingPlan(items: Item[]): PlanItem | null {
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (isPlan(it) && !it.resolved) return it; }
  return null;
}

// ---------- the mode Build it goes back to ----------

/** The chip's short names (controls.tsx `shortMode`), for "Builds in Ask". */
export const MODE_SHORT: Record<string, string> = { default: 'Ask', acceptEdits: 'Accept Edits', auto: 'Auto', bypassPermissions: 'Full Access' };
const NEW_CHAT = '';
const before = new WeakMap<Store, Map<string, string>>();
const chatKey = (store: Store) => store.meta.sessionId ?? NEW_CHAT;

/** You changed the mode by hand (setMode in controls.tsx): entering Plan remembers where this chat came from. */
export function notePlanMode(store: Store, from: string | null | undefined, to: string): void {
  if (to !== 'plan' || from === 'plan') return;
  let chats = before.get(store);
  if (!chats) before.set(store, chats = new Map());
  chats.set(chatKey(store), from && MODE_SHORT[from] ? from : 'default');
}

/** Full Access was refused in this chat (the engine said so, in the words store.rewriteNotice gives it). */
const bypassRefused = (store: Store) => store.items.some((it) => it.t === 'notice' && it.text.startsWith('Full Access is off'));

/**
 * The mode Build it switches to: the one this chat was in when it last entered Plan, else Ask. A mode that needs
 * Full Access where that was refused is Ask too. (A new chat's note follows it once the chat has its id.)
 */
export function modeAfterPlan(store: Store): string {
  const chats = before.get(store);
  const key = chatKey(store);
  let mode = chats?.get(key);
  if (mode === undefined && key !== NEW_CHAT && chats?.has(NEW_CHAT)) {
    mode = chats.get(NEW_CHAT)!;
    chats.set(key, mode);
    chats.delete(NEW_CHAT);
  }
  if (!mode || !MODE_SHORT[mode]) return 'default';
  return mode === 'bypassPermissions' && bypassRefused(store) ? 'default' : mode;
}

// ---------- answering ----------

function settle(store: Store, item: PlanItem, outcome: PlanOutcome) {
  if (item.outcome === outcome) return;
  item.outcome = outcome;
  item.rev++;
  store.setMeta({}); // redraw: the card reads its outcome
}

/**
 * Build it: approve the plan and leave Plan for modeAfterPlan(). The answer carries the mode for both makers; the
 * chip follows at once. Returns the mode, so the caller can save it as your pick (the next chat must not start in
 * Plan by surprise).
 */
export function buildIt(store: Store, item: PlanItem): string {
  const mode = modeAfterPlan(store);
  settle(store, item, 'approved');
  store.setMeta({ mode });
  const answer: Answer = { action: 'plan-approve', mode };
  void store.respond(item.ev.id, answer);
  return mode;
}

/**
 * You sent a message while a plan waited: that is "keep planning", with those words.
 * True: the words went as the plan's answer (a Claude chat: Claude Code keeps planning in the same turn, and the
 * bubble is drawn here, since nothing else will). False: send the message as usual (an OpenAI chat: it is an
 * ordinary message in Plan mode, and the engine takes the card down as it goes out; or no plan was waiting).
 */
export function keepPlanning(store: Store, text: string, images: ImageAttachment[] = []): boolean {
  const item = waitingPlan(store.items);
  if (!item) return false;
  settle(store, item, 'kept');
  if (item.ev.passive) return false;
  const said = text.trim();
  void store.respond(item.ev.id, { action: 'plan-reject', message: said || 'See the attached image.' });
  // Images cannot travel inside an answer: they follow as a message of their own, folded into the same turn.
  if (images.length) store.dispatch(text, images, true);
  else { store.addUser(text, 0); store.setMeta({ sends: store.meta.sends + 1 }); }
  return true;
}

// ---------- the transcript ----------

const same = (a: string, b: string) => a.trim() === b.trim();

/**
 * Not drawn in a turn that has this plan's card: the reply whose text is the plan (the card says it, not both),
 * and an earlier copy of the same plan (the one read back from a saved chat, when its prompt is still waiting).
 */
export function hiddenBy(it: Item, plan: PlanItem): boolean {
  if (it === plan) return false;
  const text = planTextOf(plan);
  if (it.t === 'assistant') return same(it.text, text) || (!ready.withoutTagged(it.text) && same(ready.taggedPlan(it.text) ?? '', text));
  if (!isPlan(it) || !it.resolved || it.outcome) return false;
  const id = plan.ev.toolUseId;
  return id ? it.ev.toolUseId === id : same(planTextOf(it), text);
}

/** Work that arrives after a turn ended with a plan, with no message of yours in between, is that plan being
 *  built: the same turn carrying on, as it is in a Claude chat (where the plan is approved mid-turn). */
export function buildsOn(turn: Item[], it: Item): boolean {
  return (it.t === 'assistant' || it.t === 'tool' || it.t === 'thinking') && turn.some(isPlan);
}

// ---------- a chat's events, as the one card ----------

/** What the store does with an event that is a plan's own (store.planEvent applies it). */
export type PlanStep = {
  /** The event is dealt with: the store does nothing more with it. */
  handled: boolean;
  /** Close the reply being written first (a step is starting). */
  endLive?: boolean;
  /** Words to show as a reply before the card (what a saved reply said around its plan). */
  reply?: string;
  /** Add an answered card with this plan… */
  plan?: string;
  toolUseId?: string;
  /** …or this one is the card meant. */
  item?: PlanItem;
  outcome?: PlanOutcome;
  /** Your feedback to a kept plan, shown as your message (a saved Claude chat keeps it in the plan's result). */
  feedback?: string;
};

// Claude's plan steps seen live, by step id: the plan each asked to show. Claude Code's prompt normally follows;
// if it never does (the step was allowed without asking), the step's result still becomes a card.
const asked = new WeakMap<Store, Map<string, string>>();
const askedIn = (store: Store) => { let m = asked.get(store); if (!m) asked.set(store, m = new Map()); return m; };

/** The newest plan and the newest reply since your last message. */
function sinceYou(items: Item[]) {
  let plan: PlanItem | null = null;
  let reply: Item | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.t === 'user') break;
    if (!plan && isPlan(it)) plan = it;
    if (!reply && it.t === 'assistant' && it.text.trim()) reply = it;
  }
  return { plan, reply: reply as (Item & { t: 'assistant' }) | null };
}

function planOfStep(items: Item[], id: string): PlanItem | null {
  for (let i = items.length - 1; i >= 0 && i >= items.length - 2000; i--) { const it = items[i]; if (isPlan(it) && it.ev.toolUseId === id) return it; }
  return null;
}

/**
 * Is this event a plan's own, and what becomes of it? Null: it is not, and the store handles it as usual.
 *  - Claude's plan step (a top-level ExitPlanMode) makes no step row. Live, Claude Code's prompt is the card. In a
 *    saved chat the step becomes an answered card, and its result says how it was answered (with your feedback, if
 *    you kept planning, as your message).
 *  - A saved OpenAI chat: a plan item, or a reply holding a marked plan, becomes the same answered card. "Implement
 *    the plan." right after a plan is what Build it sent: not a message of yours, and that plan was approved. Any
 *    other message of yours after a plan kept planning.
 * `history`: the event is read back from a saved chat. `hasStep(id)`: a step with that id has a row.
 */
export function planEventRule(store: Store, ev: CanopyEvent, history: boolean, hasStep: (id: string) => boolean): PlanStep | null {
  try {
    switch (ev.kind) {
      case 'tool-start': {
        if (ev.name !== 'ExitPlanMode' || ev.parent || typeof ev.id !== 'string') return null;
        const plan = String(ev.input?.plan ?? '');
        if (history) return { handled: true, plan, toolUseId: ev.id };
        askedIn(store).set(ev.id, plan);
        return { handled: true, endLive: true };
      }
      case 'tool-result': {
        if (typeof ev.id !== 'string' || hasStep(ev.id)) return null;
        const item = planOfStep(store.items, ev.id);
        const known = askedIn(store).get(ev.id);
        if (!item && known === undefined) return null;
        askedIn(store).delete(ev.id);
        const { outcome, feedback } = ready.planOutcome(ev.content, typeof ev.isError === 'boolean' ? ev.isError : undefined);
        return {
          handled: true, ...(item ? { item } : { plan: known, toolUseId: ev.id }), outcome: outcome ?? undefined,
          feedback: history && outcome === 'kept' && feedback ? feedback : undefined,
        };
      }
      case 'assistant-text': {
        if (!history || ev.parent || typeof ev.text !== 'string') return null;
        if (ev.plan === true) return ev.text.trim() ? { handled: true, plan: ev.text.trim() } : null;
        const tagged = ready.taggedPlan(ev.text);
        return tagged ? { handled: true, reply: ready.withoutTagged(ev.text) || undefined, plan: tagged } : null;
      }
      case 'user-text': {
        if (!history) return null;
        const { plan, reply } = sinceYou(store.items);
        const waiting = plan && !plan.outcome && !plan.ev.toolUseId ? plan : null; // an OpenAI chat's: a Claude plan's result says its own outcome
        if (String(ev.text ?? '').trim() !== BUILD_WORDS) return waiting ? { handled: false, item: waiting, outcome: 'kept' } : null;
        if (store.meta.engine !== 'codex') return null;
        if (waiting) return { handled: true, item: waiting, outcome: 'approved' };
        if (plan) return null; // that plan was answered already: these are your own words
        // The plan was an ordinary reply nobody marked (the usual case): Build it having been pressed says it was one.
        const text = reply ? ready.planText(reply.text) : null;
        return text ? { handled: true, plan: text, outcome: 'approved' } : null;
      }
      default: return null;
    }
  } catch { return null; }
}

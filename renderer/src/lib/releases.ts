// New models, window side: what lib/release-rules.ts decides, kept and fed the lists.
//
//   startReleases()        follow both makers' lists (and read them again every half hour, so a release shows up
//                          without the model menu being opened), and save what is new
//   useReleaseCards()      the sidebar's release cards, newest first, kept current
//   useReleases()          the saved state, kept current (Settings reads "New" from it)
//   tryRelease(card)       Try: a new chat on the model, as if you had picked it in the menu
//   dismissRelease(id)     ×: put the card away for good
//
// Saved like lib/choices.ts: one localStorage key, read once, written whole on every change. Nothing here throws.
import { useMemo, useSyncExternalStore } from 'react';
import { choices } from './choices';
import { claudeRows, loadModels, modelGroups, saveCodex, subscribeModels } from './engines';
import { allModels, menuRows, parseKey } from './model-rules.ts';
import { useAllModels, useSavedModels } from './models';
import { dismissRelease as dismissed, noticeReleases, readReleases, releaseCards, type ReleaseCard, type ReleaseState } from './release-rules.ts';
import { isContent, store } from './store';
import { feature } from './telemetry';

const KEY = 'canopy.releases';
const READ_AGAIN_MS = 30 * 60_000;

let state: ReleaseState = (() => { try { return readReleases(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return readReleases(null); } })();
const subs = new Set<() => void>();
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

function save(next: ReleaseState) {
  if (next === state) return;
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  for (const fn of subs) fn();
}

/** Both makers' models as main last handed them out. Claude's are main's own list, not a chat's: every chat's are the same. */
function check() {
  const g = modelGroups();
  if (!g.read) return; // main has not answered yet: an empty list now means nothing
  save(noticeReleases(state, allModels(claudeRows({ models: [] }), g.openai), Date.now()));
}

/** Start following the lists. Returns the stop, like the window's other start functions. */
export function startReleases(): () => void {
  check();
  const off = subscribeModels(check);
  // Main reads Codex's list again when asked and it is over five minutes old; asking every half hour is what makes a
  // release arrive on its own. Claude Code's list is read again by upkeep whenever Claude Code updates.
  const timer = setInterval(loadModels, READ_AGAIN_MS);
  return () => { off(); clearInterval(timer); };
}

/** The saved state, kept current. */
export function useReleases(): ReleaseState {
  return useSyncExternalStore(subscribe, () => state);
}

/** The release cards, newest first. Their words say whether the models are in the menu's four rows, so they follow the menu too. */
export function useReleaseCards(): ReleaseCard[] {
  const s = useReleases();
  const all = useAllModels({ models: [] });
  const saved = useSavedModels();
  return useMemo(() => releaseCards(s, all, new Set(menuRows(all, saved).map((m) => m.key))), [s, all, saved]);
}

/** ×: the card is put away and never comes back. */
export function dismissRelease(id: string) {
  feature('release_card_dismissed');
  save(dismissed(state, id));
}

/**
 * Try: a new chat on the card's model. The same as picking it in the model menu of a new chat: new chats start on the
 * maker and model you picked last (lib/choices.ts), so that is what is set, then a new chat is opened. When the chat on
 * screen is already a new, untouched one, it is that chat's model that changes, through its own model menu.
 */
export function tryRelease(card: ReleaseCard) {
  feature('release_card_tried');
  save(dismissed(state, card.id));
  const k = parseKey(card.tryKey);
  if (!k) return;
  const engine = k.maker === 'openai' ? 'codex' : 'claude';
  const fresh = !store.meta.sessionId && !store.meta.busy && !store.items.some(isContent);
  if (fresh) {
    // The composer marks the event `handled`. None did (Home is on screen): the new chat is opened below instead.
    const detail = { key: 'model', value: k.id, engine, handled: false };
    window.dispatchEvent(new CustomEvent('canopy:control', { detail }));
    if (detail.handled) { window.dispatchEvent(new Event('canopy:new-session')); return; } // to the front, focused
  }
  if (engine === 'codex') { choices.engine = 'codex'; saveCodex({ model: k.id }); }
  else { choices.engine = undefined; choices.model = k.id; }
  window.dispatchEvent(new Event('canopy:new-session'));
}

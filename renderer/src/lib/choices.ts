// Composer choices the user made explicitly (model, effort, mode, fast, ultracode, code mode).
// Saved across restarts and carried into every new session.
// Anything unset means "use my Claude Code settings", same as the terminal.
//
// Each maker remembers its own picks. The top-level model, effort and fast are Claude's, as they always were, and
// `codex` holds the OpenAI ones (unset there means "use my Codex settings"). The mode is shared: one chip, one meaning.
// `engine` says which maker's model you picked last, so new chats start there; unset means Claude.
// The proxy only sees top-level writes, so `codex` is always replaced whole: choices.codex = { ...choices.codex, effort }.
export type CodexChoices = { model?: string; effort?: string; fast?: boolean };
export type Choices = { model?: string; effort?: string; mode?: string; fast?: boolean; ultracode?: boolean; codeMode?: boolean; engine?: 'codex'; codex?: CodexChoices };
const KEY = 'canopy.choices';
const initial: Choices = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } })();
// Code Mode is Canopy's own, so it has no Claude Code setting to fall back on: unset means on. Benchmarked on real
// connectors (Nov 15): 16–29% cheaper and 2–3× fewer round trips on multi-call work, same answers, a tie otherwise.
// Turning it off is remembered; a Claude Code that can't run it turns it off for you (controls.tsx).
if (initial.codeMode === undefined) initial.codeMode = true;

// Anything that draws from the choices (Settings > Models, the model menu) can follow them: every write counts up
// `choicesVersion` and tells the listeners. See useChoices in lib/models.ts.
const listeners = new Set<() => void>();
let version = 0;
export const choicesVersion = () => version;
export function subscribeChoices(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

export const choices: Choices = new Proxy(initial, {
  set(target, prop, value) {
    (target as Record<string | symbol, unknown>)[prop] = value;
    try { localStorage.setItem(KEY, JSON.stringify(target)); } catch { /* ignore */ }
    version++;
    for (const fn of listeners) fn();
    return true;
  },
});

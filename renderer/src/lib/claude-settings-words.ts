// The words of Settings → Claude Code that are worked out, not written: the headline under "Claude Code", the
// glances that roll the page up (Account, Updates, and Models when Canopy offers a newer model than Claude Code's
// own menu), the rows for those models, and "Not shown yet" as one line. Plain functions of what main sends, with no
// run-time imports and no clock, so node tests them as they are. Nothing here throws.
//
// The Updates glance is the same for both tools: codex-settings-words.ts `updatesGlance`.
//
// Colour follows Settings' one rule: the amber dot (`attention`) is for something that stops Claude Code from doing
// what you asked until you act. The headline alone may carry the green dot (`ready`).
import type { EnvInfo, ModelFixup } from './api';

export type GlanceTone = 'ok' | 'attention' | 'off' | 'busy';
export type GlanceKey = 'account' | 'updates' | 'models';
export type ClaudeGlance = { key: GlanceKey; label: string; value: string; tone: GlanceTone };

/** The account new chats use, as far as the page needs it: its name, and what is wrong with it when something is. */
export type AccountInUse = { label: string; problem: string | null };

/** Who Claude Code runs as. The account in use speaks first; with none, what Claude Code said of its own sign-in
 *  (`auth`), once the accounts have been read (`checking`: not yet, or being asked again). */
export function accountGlance(auth: Pick<NonNullable<EnvInfo['auth']>, 'loggedIn'> | null | undefined, account: AccountInUse | null, checking = false): ClaudeGlance {
  const g = (value: string, tone: GlanceTone): ClaudeGlance => ({ key: 'account', label: 'Account', value, tone });
  if (account?.problem) return g(account.problem, 'attention');
  if (account) return g(account.label || 'Signed in', 'ok');
  if (checking) return g('Checking…', 'busy');
  if (auth?.loggedIn === false) return g('Not signed in', 'attention');
  return auth?.loggedIn === true ? g('Signed in', 'ok') : g('No login found', 'off');
}

/** The model rows Canopy changed: ones Claude Code pins to an older release than their family runs now. */
export const newerModels = (fixups: ModelFixup[]): ModelFixup[] => fixups.filter((f) => f.was !== f.is);

/** Does Canopy offer newer models than Claude Code's own menu. null: it does not, so there is nothing to say. */
export function modelsGlance(fixups: ModelFixup[]): ClaudeGlance | null {
  return newerModels(fixups).length ? { key: 'models', label: 'Models', value: 'Newest offered', tone: 'ok' } : null;
}

/** One changed model, as a row: what it runs in Canopy, and under it what Claude Code's own menu still offers. */
export const fixupLabel = (f: ModelFixup): string => `${f.to.displayName ?? f.to.value} runs ${f.is}`;
export const fixupLine = (f: ModelFixup): string => `Claude Code still offers ${f.was}; Canopy offers the newest`;

/** The one line under "Claude Code": can it run chats, and is it current. `ready` is the only tone with the green
 *  dot. `updates`: the Updates glance. A sign-in nobody could find is said plainly, with no dot: it may still work. */
export function claudeHeadline(account: Pick<ClaudeGlance, 'value' | 'tone'>, updates: { value: string; tone: GlanceTone }): { text: string; tone: 'ready' | 'attention' | 'ok' } {
  if (account.tone === 'busy') return { text: 'Checking…', tone: 'ok' };
  if (account.tone === 'attention') return { text: account.value, tone: 'attention' };
  if (account.tone === 'off') return { text: account.value, tone: 'ok' };
  if (updates.tone === 'attention') return { text: `Ready · ${updates.value.charAt(0).toLowerCase()}${updates.value.slice(1)}`, tone: 'attention' };
  return { text: updates.tone === 'ok' ? 'Ready · up to date' : 'Ready', tone: 'ready' };
}

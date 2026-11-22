// The words of Settings → Codex that are worked out, not written: the headline under "Codex", the glances that roll
// the page up (Account, Computer Use, Updates), and the lines of the Computer Use rows. Plain functions of what main
// sends, with no run-time imports and no clock, so node tests them as they are. Nothing here throws.
//
// Colour follows Settings' one rule: the amber dot (`attention`) is for something that stops Codex from doing what
// you asked until you act. The headline alone may carry the green dot (`ready`).
import type { CodexInfo, ComputerUseStatus } from './api';
import type { ToolUpkeep } from './upkeep-words';

export type GlanceTone = 'ok' | 'attention' | 'off' | 'busy';
export type GlanceKey = 'account' | 'computer-use' | 'updates';
export type CodexGlance = { key: GlanceKey; label: string; value: string; tone: GlanceTone };

/** The account new chats use, as far as the page needs it: its name, and what is wrong with it when something is. */
export type AccountInUse = { label: string; problem: string | null };

/** Who Codex runs as. `codex` null: main has not said yet. An account in use that works speaks for itself, however
 *  Codex's own login stands (a key pasted into Canopy runs without it). */
export function accountGlance(codex: Pick<CodexInfo, 'signedIn'> | null, account: AccountInUse | null): CodexGlance {
  const g = (value: string, tone: GlanceTone): CodexGlance => ({ key: 'account', label: 'Account', value, tone });
  if (account?.problem) return g(account.problem, 'attention');
  if (account) return g(account.label || 'Signed in', 'ok');
  if (!codex) return g('Checking…', 'busy');
  if (codex.signedIn === true) return g('Signed in', 'ok');
  return codex.signedIn === false ? g('Not signed in', 'attention') : g('Not answering', 'attention');
}

/** Is Codex's version looked after. `up` null: main has not looked at it yet. `checking`: "Check Now" was pressed. */
export function updatesGlance(up: ToolUpkeep | null, checking = false): CodexGlance {
  const g = (value: string, tone: GlanceTone): CodexGlance => ({ key: 'updates', label: 'Updates', value, tone });
  if (!up) return g('Checking…', 'busy');
  if (checking || up.doing === 'updating') return g('Checking…', 'busy');
  if (up.lastCheck?.result === 'failed') return g('Couldn’t update', 'attention');
  if (up.behind) return g('Needs an update', 'attention');
  return up.lastCheck ? g('Up to date', 'ok') : g('Not checked yet', 'off');
}

/** Can Codex use this Mac, as far as Codex says. null: there is nothing to show (a main process from before
 *  Computer Use, or one that could not say). undefined: not asked yet. */
export function computerUseGlance(cu: Pick<ComputerUseStatus, 'state'> | null | undefined): CodexGlance | null {
  if (cu === null) return null;
  const g = (value: string, tone: GlanceTone): CodexGlance => ({ key: 'computer-use', label: 'Computer Use', value, tone });
  if (cu === undefined) return g('Checking…', 'busy');
  if (cu.state === 'on') return g('On', 'ok');
  if (cu.state === 'off') return g('Turned off', 'attention');
  return cu.state === 'missing' ? g('Not set up', 'off') : g('Can’t tell', 'off');
}

/** The one line under "Codex": can it run chats, and is it current. `ready` is the only tone with the green dot. */
export function codexHeadline(account: CodexGlance, updates: CodexGlance): { text: string; tone: 'ready' | 'attention' | 'ok' } {
  if (account.tone === 'busy') return { text: 'Checking…', tone: 'ok' };
  if (account.tone === 'attention') return { text: account.value, tone: 'attention' };
  if (updates.tone === 'attention') return { text: `Ready · ${updates.value.charAt(0).toLowerCase()}${updates.value.slice(1)}`, tone: 'attention' };
  return { text: updates.tone === 'ok' ? 'Ready · up to date' : 'Ready', tone: 'ready' };
}

/** The line under "Computer Use": what it is while it is on, else Codex's own words for why it is not. */
export function computerUseLine(cu: Pick<ComputerUseStatus, 'state' | 'line'>): string {
  return cu.state === 'on' ? 'Codex can click and type in the apps on this Mac' : cu.line;
}

/** The line under one Mac permission: what it is for. Only one that Computer Use can do without says so. */
export function permissionLine(p: Pick<ComputerUseStatus['permissions'][number], 'detail' | 'needed'>): string {
  return p.needed ? p.detail : `Optional · ${p.detail.charAt(0).toLowerCase()}${p.detail.slice(1)}`;
}

/** Which apps Codex's own config lets Computer Use touch. `apps` null: Codex did not answer. */
export function appsLine(apps: ComputerUseStatus['apps']): string {
  if (!apps) return 'Codex is not answering';
  const ids = (access: 'allow' | 'deny') => apps.listed.filter((a) => a.access === access).map((a) => a.id);
  if (apps.any) return ids('deny').length ? `Any app except ${ids('deny').join(', ')}` : 'Any app · it asks first, once for each';
  return ids('allow').length ? `Only ${ids('allow').join(', ')}` : 'No apps';
}

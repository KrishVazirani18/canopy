// The words of upkeep, one copy for both tools Canopy looks after (Claude Code and Codex): the status line under
// "Version" on the tool's page in Settings, the hint under the switch, a row of the "Not shown yet" list, and the
// three quiet toasts. Only the tool's name differs between the two.
//
// Plain functions of the status main sends (src/core/upkeep.mjs): no window, no clock of their own unless none is
// given, so node tests them as they are. Nothing here throws.
import type { UpkeepStatus } from './api';

/** The status of one tool: Claude Code's, or Codex's (`UpkeepStatus.codex`). */
export type ToolUpkeep = Omit<UpkeepStatus, 'codex'>;
export type UpkeepNote = NonNullable<UpkeepStatus['note']>;
export type DriftRow = ToolUpkeep['drift'][number];

/** "5 min ago", "2 h ago", then the date. */
export function ago(t: number, now: number = Date.now()): string {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The line under "Version": what Canopy last did about updates. `checking`: "Check now" was just pressed. */
export function upkeepLine(up: ToolUpkeep, checking = false, now: number = Date.now()): string {
  const last = up.lastCheck;
  if (checking || up.doing === 'updating') return 'Checking for updates…';
  if (last?.result === 'failed') return `Couldn’t update: ${last.detail ?? 'unknown error'}`;
  if (up.behind) return `Older than Canopy needs (${up.engineVersion}). ${up.autoUpdate && !up.blockedBy ? 'Updating soon.' : 'Check now to update.'}`;
  if (up.lastUpdate && last && up.lastUpdate.at === last.at) return `Updated from ${up.lastUpdate.from} · ${ago(up.lastUpdate.at, now)}`;
  if (last) return `Up to date · checked ${ago(last.at, now)}`;
  return 'Not checked yet';
}

/** The hint under "Keep … up to date": why updates cannot run on their own, else when they do. */
export const switchHint = (up: ToolUpkeep): string => up.blockedBy ?? 'Updates in the background, only while no chat is working.';

/** Is the switch shown on? Off too when the tool's own settings say not to update it. */
export const switchOn = (up: ToolUpkeep): boolean => up.autoUpdate && !up.blockedBy;

/** One row of "Not shown yet": which tool and version sent it, when, how often. */
export function driftHint(tool: string, d: DriftRow, now: number = Date.now()): string {
  return `${tool} ${d.version ?? '?'} · first seen ${ago(d.at, now)}${d.count > 1 ? ` · ${d.count} times` : ''}`;
}

/** "Not shown yet", as one line: how many things the tool sent that this Canopy skips. */
export function driftLine(tool: string, count: number): string {
  return `${count} ${count === 1 ? 'thing' : 'things'} ${tool} sent that this version of Canopy skips. Nothing is broken.`;
}

/** The toast for something upkeep just did. `good`: it fixed something that was in your way. */
export function upkeepToast(tool: string, n: UpkeepNote): { id: string; title: string; description: string; good: boolean } {
  const key = tool === 'Claude Code' ? '' : `:${tool.toLowerCase()}`;
  if (n.kind === 'drift') return { id: `drift${key}:${n.label}`, title: `${tool} sent something new`, description: `Canopy skipped “${n.label}” for now. It’s listed in Settings → Advanced.`, good: false };
  if (n.kind === 'repaired') return { id: `upkeep${key}`, title: `${tool} updated to ${n.to}`, description: 'It was too old for Canopy. Send your message again.', good: true };
  return { id: `upkeep${key}`, title: `${tool} updated to ${n.to}`, description: 'New chats use it right away.', good: false };
}

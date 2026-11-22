// The words of Canopy's own updates: the line in Settings, the sidebar card, the "Update required" screen and the
// two quiet toasts. Plain functions of the status main sends (src/core/app-update.mjs): no window and no clock of
// their own unless none is given, so node tests them as they are. Nothing here throws.
import type { AppUpdateStatus } from './api';
import { ago } from './upkeep-words.ts'; // with its extension: node runs this file as it is, in the tests

export type UpdateNote = NonNullable<AppUpdateStatus['note']>;

const percent = (s: AppUpdateStatus) => (typeof s.progress === 'number' ? ` ${Math.round(s.progress * 100)}%` : '');
/** Why this copy cannot replace itself, said as what to do about it. */
export const MOVE_HINT = 'Move Canopy to your Applications folder to get updates.';

/** Settings: the line under "Install updates automatically". `checking`: Check for Updates was just pressed. */
export function updateLine(s: AppUpdateStatus, checking = false, now: number = Date.now()): string {
  if (s.state === 'installing') return 'Restarting to update…';
  if (s.state === 'downloading') return `Downloading Canopy ${s.available ?? ''}…${percent(s)}`.replace('  ', ' ');
  if (checking || s.state === 'checking') return 'Checking for updates…';
  if (s.ready) return `Canopy ${s.ready} is ready. Restart to update.`;
  if (s.available && !s.canInstall) return `Canopy ${s.available} is out. ${MOVE_HINT}`;
  if (s.available && s.error && s.lastCheck?.result !== 'failed') return `Couldn’t download Canopy ${s.available}. Canopy tries again later.`;
  if (s.available && s.failed === s.available) return `Canopy ${s.available} didn’t start on this Mac. Check again to retry.`;
  if (s.available) return `Canopy ${s.available} is available.`;
  if (s.lastCheck?.result === 'failed') return `Couldn’t check for updates · ${ago(s.lastCheck.at, now)}`;
  if (s.lastCheck) return `Up to date · checked ${ago(s.lastCheck.at, now)}`;
  return 'Not checked yet';
}

/** Settings: what the button beside the line does now. */
export function updateAction(s: AppUpdateStatus): 'restart' | 'download' | 'check' {
  if (s.ready) return 'restart';
  if (s.available && s.canInstall && s.state === 'idle' && (!s.auto || s.failed === s.available)) return 'download';
  return 'check';
}

const finishing = (n: number) => (n > 1 ? `${n} chats finish` : '1 chat finishes');
const working = (n: number) => (n > 1 ? `${n} chats are still working` : '1 chat is still working');

/**
 * The sidebar card, or null when there is nothing to say. `busy`: chats a restart would cut off. `waiting`: Restart
 * was pressed while chats were working, and Canopy restarts once they finish.
 *   ready        downloaded: Restart to update (it waits for working chats)
 *   offered      automatic updates are off: Download
 *   elsewhere    this copy cannot replace itself: where to get the new one
 */
export function updateCard(s: AppUpdateStatus, busy: number, waiting: boolean): { kind: 'ready' | 'offered' | 'elsewhere'; title: string; body: string; action: string } | null {
  if (!s.supported || s.required) return null; // required has the whole window
  if (s.ready) {
    if (waiting) return { kind: 'ready', title: 'Restarting soon', body: `Canopy restarts by itself after ${finishing(busy)}.`, action: 'Cancel' };
    if (busy) return { kind: 'ready', title: 'Update ready', body: `${working(busy).replace(/^./, (c) => c.toUpperCase())}. Restart waits for ${busy > 1 ? 'them' : 'it'} to finish.`, action: 'Restart when done' };
    return { kind: 'ready', title: 'Update ready', body: `Restart to get Canopy ${s.ready}. Your chats pick up where they were.`, action: 'Restart to update' };
  }
  if (!s.available) return null;
  if (!s.canInstall) return { kind: 'elsewhere', title: `Canopy ${s.available} is out`, body: MOVE_HINT, action: 'Download' };
  if (s.state === 'downloading' && !s.auto) return { kind: 'offered', title: `Canopy ${s.available} is out`, body: 'Downloading. You can keep working.', action: `Downloading…${percent(s)}` };
  if (!s.auto) return { kind: 'offered', title: `Canopy ${s.available} is out`, body: 'Automatic updates are off. Download it when it suits you.', action: 'Download' };
  return null; // on its way in the background: the card comes when it is ready
}

/**
 * The "Update required" screen. `asked`: the button was pressed. `working`: chats that are really working (the update
 * waits for them; a chat that waits for an answer does not hold it up).
 *   button   what the one button says, and whether it can be pressed
 *   line     what is going on, under the button (empty: nothing to say)
 *   escape   true once the update could not be downloaded or installed: "Not now" lets Canopy be used all the same
 */
export function requiredView(s: AppUpdateStatus, asked: boolean, working: number): { message: string; button: string; busy: boolean; line: string; escape: boolean; elsewhere: boolean } {
  const message = s.required?.message ?? '';
  if (!s.canInstall) return { message, button: 'Download Canopy', busy: false, line: 'Open it and drag Canopy into Applications, replacing this one.', escape: true, elsewhere: true };
  if (s.state === 'installing') return { message, button: 'Restarting…', busy: true, line: '', escape: false, elsewhere: false };
  // Until the button is pressed it says what it does: a download already under way in the background is not its news.
  if (s.state === 'downloading' && asked) return { message, button: `Downloading…${percent(s)}`, busy: true, line: 'Canopy restarts when it is ready.', escape: false, elsewhere: false };
  if (asked && s.ready && working > 0) return { message, button: 'Waiting for chats…', busy: true, line: `Canopy restarts after ${finishing(working)}.`, escape: false, elsewhere: false };
  if (asked && s.ready) return { message, button: 'Restarting…', busy: true, line: '', escape: false, elsewhere: false };
  if (asked && s.state === 'checking') return { message, button: 'Checking…', busy: true, line: '', escape: false, elsewhere: false };
  if (s.error && !s.ready) return { message, button: 'Try Again', busy: false, line: 'Couldn’t download the update. Check your connection.', escape: true, elsewhere: false };
  if (s.failed === s.required?.version && !s.ready) return { message, button: 'Try Again', busy: false, line: `Canopy ${s.failed} didn’t start on this Mac.`, escape: true, elsewhere: false };
  return { message, button: 'Update Now', busy: false, line: '', escape: false, elsewhere: false };
}

/** The quiet toast after an update went in, or was taken back out because it did not start. */
export function updateToast(n: UpdateNote): { id: string; title: string; description: string } {
  if (n.kind === 'rolled-back') return { id: 'app-update', title: `Canopy ${n.version} didn’t start`, description: 'You’re back on the version you had. The next update is tried as usual.' };
  return { id: 'app-update', title: `Canopy updated to ${n.version}`, description: 'Your chats are where you left them.' };
}

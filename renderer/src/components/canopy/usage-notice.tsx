// The one word Canopy says about usage stats: a quiet toast, in the usual place, the first time Canopy opens with
// them on. It says what is shared and what never is, and where the switch is (Settings > Privacy).
// OK, Settings, or swiping it away all count as seen, and it is never shown again; closed without any of those, it
// comes back on the next launch. Whether it is due is main's to say (lib/telemetry.ts): never with the switch off,
// and never in a copy of Canopy that can't send anything (an automated run, CANOPY_TELEMETRY=0).
// It comes before anything is sent: main is told the moment it goes up, and holds every stat back until it has been
// answered (and for two minutes after, time enough to reach the switch from "Settings") or has been on screen for
// ten minutes of Canopy being open.
import { toast } from 'sonner';
import { markNoticeShown, noticeOnScreen, subscribeTelemetry, telemetryStatus } from '@/lib/telemetry';
import { noticeDue } from '@/lib/telemetry-rules';
import { ui } from '@/lib/ui';

const ID = 'usage-notice';
const SETTLE_MS = 1500; // shown once the launch logo has gone and the window has settled

/** The notice itself: the surface, width and type of every other toast (ui/sonner.tsx), two plain buttons, no color. */
export function UsageNotice({ onSettings, onOk }: { onSettings: () => void; onOk: () => void }) {
  return (
    <div className="w-[var(--width,356px)] rounded-lg border bg-popover p-4 text-popover-foreground shadow-[0_4px_12px_rgb(0_0_0/0.1)]">
      <div className="text-ui font-medium">Your chats stay on your Mac</div>
      <p className="mt-0.5 text-small text-muted-foreground">
        To get better, Canopy shares only counts, under a random ID for this Mac: which features you use, and how many messages you send in Canopy, Claude Code and Codex. Never what you write, your code or your files.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onSettings}
          className="h-7 rounded-md px-2.5 text-small text-foreground/85 ring-1 ring-hairline transition-colors hover:bg-accent hover:text-foreground">
          Settings
        </button>
        <button type="button" onClick={onOk} className="h-7 rounded-md bg-foreground px-3 text-small font-medium text-background hover:opacity-90">OK</button>
      </div>
    </div>
  );
}

/** Show the notice when it is due (stats on and able to be sent, never seen), and take it down if that stops being
 *  true. Returns the unsubscribe, like the window's other listeners. */
export function startUsageNotice(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let up = false;
  const due = () => noticeDue(telemetryStatus());
  const seen = () => {
    if (!up) return; // a button, the swipe and main's answer can all land here: the first one counts
    up = false;
    markNoticeShown();
    toast.dismiss(ID);
  };
  const show = () => {
    timer = undefined;
    if (!due() || up) return;
    up = true;
    toast.custom(() => <UsageNotice onOk={seen} onSettings={() => { seen(); ui.openSettings('privacy'); }} />, { id: ID, duration: Infinity, onDismiss: seen });
    noticeOnScreen();
  };
  const check = () => {
    if (due()) { if (!up && !timer) timer = setTimeout(show, SETTLE_MS); return; }
    clearTimeout(timer);
    timer = undefined;
    // Turned off in Settings with the notice still up: the switch has been found, so it has been seen.
    seen();
  };
  const off = subscribeTelemetry(check);
  check();
  return () => { off(); clearTimeout(timer); };
}

// Usage stats, window side. Canopy counts which parts of the window get used, so it can get better: names from a
// fixed list and Canopy's own words for a setting, never anything someone typed or read. Every event goes to main
// (src/telemetry), which checks it against the one list of what may leave the Mac and decides whether anything is
// sent at all (the switch in Settings > Privacy, automated runs, a copy with nowhere to send).
//
// Counting never gets in the way: track() can't throw and nothing waits for it. Where main has no usage stats (the
// UI harness, a main process from before them) and in the design Playground, it does nothing.
import { useSyncExternalStore } from 'react';
import { api, type TelemetryEvent, type TelemetryStatus } from './api';
import { readEvents, readStatus, widgetKind, type Feature, type SettingKey, type SettingsPage, type UiEvent } from './telemetry-rules';
import { ui } from './ui';

type Bridge = NonNullable<typeof api.telemetry>;
/** Main's usage stats, when this main has them. (The UI harness answers any name with a function: that is not them.) */
function bridge(): Bridge | null {
  try {
    const t = api?.telemetry;
    return t && typeof t.track === 'function' ? t : null;
  } catch { return null; }
}
/** A call to main that can't throw or reject: `otherwise` is the answer when there is no main to ask or it fails. */
function ask<T>(call: (t: Bridge) => Promise<T> | T, otherwise: T): Promise<T> {
  try {
    const t = bridge();
    return t ? Promise.resolve(call(t)).catch(() => otherwise) : Promise.resolve(otherwise);
  } catch { return Promise.resolve(otherwise); }
}

// ---------- counting ----------

/** Count one thing. Fire and forget: it never throws, and nobody waits for it. */
export function track(event: UiEvent, props: Record<string, string | number | boolean> = {}): void {
  try {
    if (ui.get().view === 'playground') return; // the Playground runs the real components on sample data: not use
    void ask((t) => t.track(event, props), undefined);
  } catch { /* counting never gets in the way */ }
}

/** Something in the window was used. `page`: which Settings page, for `settings_page`. */
export const feature = (name: Feature, page?: SettingsPage) => track('feature_used', page ? { name, page } : { name });

/** A setting was changed. `value` is only ever one of Canopy's own words (a theme, a mode), or on / off for a switch;
 *  a setting whose value could name something of yours (a model) is counted without one. */
export const setting = (key: SettingKey, value?: string | boolean) =>
  track('setting_changed', value === undefined ? { key } : { key, value: typeof value === 'boolean' ? (value ? 'on' : 'off') : value });

/** A connector, skill or plugin was added. Its name goes to main as it is and no further: main sends the name only
 *  when it is on the public list, and "custom" for everything else. */
export const extensionAdded = (type: 'connector' | 'skill' | 'plugin', name: string) => track('extension_added', { type, name });

// A widget is counted once when Claude draws it and once the first time you do something in it, however often the
// chat it is in gets redrawn. Only its kind is counted (lib/telemetry-rules.ts reads it off the HTML).
const widgetsShown = new Set<string>();
const widgetsUsed = new Set<string>();
const first = (seen: Set<string>, id: string) => (seen.has(id) ? false : (seen.add(id), true));
export const widgetShown = (callId: string, code: string) => { if (first(widgetsShown, callId)) track('widget', { kind: widgetKind(code), action: 'shown' }); };
export const widgetUsed = (callId: string, code: string) => { if (first(widgetsUsed, callId)) track('widget', { kind: widgetKind(code), action: 'used' }); };

/** The window's panels, counted as they open. Every way in (a button, a shortcut, a command, the palette) ends in
 *  ui.set, so watching what changed there counts each of them once, whichever way was taken. */
function watchPanels(): () => void {
  let was = ui.get();
  // Which tab of the side panel is on screen, if it is open.
  const panel = (s: typeof was) => (s.inspector ? s.tab : null);
  return ui.subscribe(() => {
    const now = ui.get(), before = was;
    was = now;
    if (now.palette && !before.palette) feature('palette_opened');
    if (now.view === 'home' && before.view !== 'home') feature('home_opened');
    if (now.multi && !before.multi) feature('multi_view_opened');
    if (panel(now) === 'terminal' && panel(before) !== 'terminal') feature('terminal_opened');
    else if (panel(now) && !panel(before)) feature('inspector_opened');
    // The Usage tab, however it came on screen: picked in the open panel, or the tab the panel opened at.
    if (panel(now) === 'usage' && panel(before) !== 'usage') feature('usage_opened');
  });
}

// ---------- where usage stats stand ----------

let status: TelemetryStatus | null = null;
const subs = new Set<() => void>();
function apply(next: TelemetryStatus | null) {
  if (!next) return;
  status = next;
  for (const f of subs) f();
}

/** True when this main has usage stats at all (false in the UI harness and on a main from before them). */
export const telemetryAvailable = () => !!bridge();
export const telemetryStatus = () => status;
export function subscribeTelemetry(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; }

/** Where usage stats stand, kept current: null until main has answered. */
export function useTelemetryStatus(): TelemetryStatus | null {
  return useSyncExternalStore(subscribeTelemetry, telemetryStatus);
}

/** Ask main where usage stats stand now. */
export const refreshTelemetry = (): Promise<void> => ask((t) => t.status(), null).then((s) => apply(readStatus(s)));

/** The switch in Settings > Privacy. It moves at once; main has the last word (off: it stops, drops what was waiting
 *  and sends one last note saying so). */
export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  if (status) apply({ ...status, enabled });
  await ask((t) => t.set({ enabled }), null);
  await refreshTelemetry();
  // Counted only when turned on: turned off, the one thing sent is main's own last note.
  if (enabled && status?.enabled) setting('usage_stats', true);
}

/** The name sent with the stats. Main tidies it (letters, spaces and . ' - only), so what comes back is what is kept. */
export async function setTelemetryName(name: string): Promise<void> {
  await ask((t) => t.set({ name }), null);
  await refreshTelemetry();
}

/** The last events recorded to be sent, newest first. */
export const recentTelemetry = (): Promise<TelemetryEvent[]> => ask((t) => t.recent(), null).then(readEvents);

/** The first-launch notice has been seen: it is not shown again. */
export function markNoticeShown(): void {
  if (status) apply({ ...status, noticeShown: true });
  void ask((t) => t.noticeShown(), null);
}

/** The first-launch notice is on screen now. Main sends nothing until it has been answered, or has been up for ten
 *  minutes of Canopy being open: this is what starts that count. */
export function noticeOnScreen(): void {
  void ask((t) => t.noticeUp?.(), null);
}

/** Read the status, follow main's changes to it, and count the panels as they open. Returns the unsubscribe, like
 *  the window's other listeners. */
export function startTelemetry(): () => void {
  void refreshTelemetry();
  let offStatus: (() => void) | undefined;
  try { offStatus = bridge()?.onStatus((s) => apply(readStatus(s))); } catch { /* an older main: no changes to follow */ }
  const offPanels = watchPanels();
  return () => { try { offStatus?.(); } catch { /* already gone */ } offPanels(); };
}

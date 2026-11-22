// How long Canopy was really in use: minutes with its window in front and the person at the Mac.
//
// Asked once a minute: is the window focused, and has the keyboard or mouse been touched in the last two minutes?
// A yes counts one minute for today (the local calendar day), kept per day in activity.json so the daily summary
// can report yesterday's after a restart. Nothing here knows about Electron: the caller passes the two questions in.
import { jsonFile } from './disk.mjs';

const MINUTE = 60_000;
/** Longer than this without touching the Mac and the person is taken to be away. */
export const IDLE_LIMIT_SECS = 120;
const DAY_MINUTES = 24 * 60;
// What one event may report (the schema's limit for minutes): a Canopy left open over a long holiday says a week.
const REPORT_MAX = 7 * DAY_MINUTES;
// Days kept on disk. The summary only ever asks about the last few; this is room to spare, not a history.
const KEEP_DAYS = 120;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');
/** The local calendar day a moment falls on, as 'YYYY-MM-DD'. */
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {{
 *   file: string,
 *   isFocused?: () => boolean,          // Canopy's window is the one in front
 *   idleSeconds?: () => number,         // since the keyboard or mouse was last touched (powerMonitor.getSystemIdleTime)
 *   now?: () => number, idleLimit?: number,
 *   warn?: (kind: string, err?: unknown) => void,
 * }} opts
 */
export function createActivity({ file, isFocused, idleSeconds, now = Date.now, idleLimit = IDLE_LIMIT_SECS, warn = () => {} }) {
  const disk = jsonFile(file, warn);
  const startedAt = now();
  let days = new Map(); // 'YYYY-MM-DD' -> minutes
  let activeThisLaunch = 0;

  function save() {
    if (days.size > KEEP_DAYS) days = new Map([...days].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-KEEP_DAYS));
    disk.write({ days: Object.fromEntries(days) });
  }

  return {
    /** Read activity.json. Minutes counted before this finished are added to what was on disk. */
    async load() {
      const { status, value } = await disk.read();
      const saved = status === 'ok' && value?.days && typeof value.days === 'object' ? value.days : {};
      for (const [day, n] of Object.entries(saved)) {
        if (!DATE.test(day) || !Number.isFinite(n) || n <= 0) continue;
        days.set(day, Math.min(DAY_MINUTES, Math.round(n) + (days.get(day) ?? 0)));
      }
    },

    /**
     * Call once a minute. Counts the minute when Canopy is in front and the person is there.
     * @returns {string | null} the day it counted for, or null when the minute wasn't an active one
     */
    sample() {
      let active = false;
      try { active = isFocused?.() === true && idleSeconds?.() < idleLimit; } catch { /* can't tell: not counted */ }
      if (!active) return null;
      const day = localDate(now());
      days.set(day, Math.min(DAY_MINUTES, (days.get(day) ?? 0) + 1));
      activeThisLaunch++;
      save();
      return day;
    },

    /** Active minutes on a local day ('YYYY-MM-DD'); 0 for a day nothing is known about. */
    minutes: (date) => (typeof date === 'string' && days.get(date)) || 0,

    /** This launch so far, as `app_closed` reports it: minutes open (by the clock) and minutes in use. */
    session: () => ({
      open_min: Math.min(REPORT_MAX, Math.max(0, Math.round((now() - startedAt) / MINUTE))),
      active_min: Math.min(REPORT_MAX, activeThisLaunch),
    }),

    settled: () => disk.settled(),
  };
}

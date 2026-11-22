// The local dates on which sharing was off, kept so that no day's summary from one of them is ever sent, also after
// sharing has come back on (summary.mjs asks this list before it sends a day).
//
// Kept as stretches, not as dates: [from, to] is every local date from `from` to `to`, both included, and the newest
// stretch has `to: null` while sharing is still off, which covers the days Canopy was not opened at all. A date
// counts as off if sharing was off at any moment of it, so the day it was turned off and the day it came back on
// both do. Dates are all that is written down.
//
// The list is kept in identity.json, written in the same save as the switch it follows (identity.mjs; index.mjs says
// when). It stays small: turning sharing off again on the day it came back on carries the same stretch on, so there
// is at most one new stretch a day, and only the newest OFF_STRETCHES_MAX are kept (a summary never reaches back
// more than a month).

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const OFF_STRETCHES_MAX = 60;

const isDate = (v) => typeof v === 'string' && DATE.test(v);

/**
 * What was saved, as a clean list of stretches, oldest first: a fresh copy, the caller's to change. Anything in it
 * that is not a stretch is left out.
 * @returns {[string, string|null][]}
 */
export function readOffDays(saved) {
  if (!Array.isArray(saved)) return [];
  const list = [];
  for (const s of saved) {
    if (!Array.isArray(s) || !isDate(s[0])) continue;
    if (s[1] === null || (isDate(s[1]) && s[1] >= s[0])) list.push([s[0], s[1]]);
  }
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return list.slice(-OFF_STRETCHES_MAX);
}

/** Sharing is off on `date`, and from here on until `offUntil` says otherwise: the list, with a stretch open. */
export function offFrom(saved, date) {
  const list = readOffDays(saved);
  if (!isDate(date)) return list;
  const last = list.at(-1);
  if (last && last[1] === null) return list;                      // already off
  if (last && last[1] >= date) { last[1] = null; return list; }   // off again on the day it came back on: one stretch
  list.push([date, null]);
  return list.slice(-OFF_STRETCHES_MAX);
}

/** Sharing is back on, on `date`: the open stretch ends with that day (which was partly off, so it is in it). */
export function offUntil(saved, date) {
  const list = readOffDays(saved);
  if (!isDate(date)) return list;
  // More than one open stretch is not something this file writes; if the saved list holds them, they all end here.
  for (const s of list) if (s[1] === null) s[1] = date < s[0] ? s[0] : date; // a clock set back can't end one before it began
  return list;
}

/** Whether sharing was off on `date` (at any moment of it). */
export function wasOff(saved, date) {
  return isDate(date) && readOffDays(saved).some(([from, to]) => date >= from && (to === null || date <= to));
}

// Usage limits, in one shape for both makers: what Claude Code and Codex each say about the plan's rolling windows
// becomes the same short list, and the two notices about a limit are worded here once, for both.
//
//   Limit                        { id, name, usedPercent, resetsAt }
//                                id: 'five_hour' | 'weekly' | 'weekly_opus' | …   name: '5-hour limit'
//                                usedPercent: 0-100, whole   resetsAt: a time in ms, or null when not known
//   limitsFromClaude(usage)      Claude Code's usage answer (Session.usage(), or its raw `rate_limits`)
//   limitsFromCodex(snapshot)    Codex's `account/rateLimits/read` answer, or the `rateLimits` of an update
//   mergeCodex(have, update)     a sparse Codex update laid over the last full snapshot
//   reachedText(limit)           'Usage limit reached (5-hour limit). It resets at 3:10 PM.'
//   nearingText(limit)           'Approaching your usage limit (5-hour limit, 82% used). It resets at 3:10 PM.'
//   limitLine(limit)             '5-hour limit · 42% used · resets 3:10 PM'   (the ring's hover, and Stats)
//
// Contract: pure, no imports, nothing throws. Anything that cannot be read gives the empty answer ([] or ''), so a
// login with no plan limits (an API key on either side) simply has none. The window imports this file as it is.

/** Claude Code's names for its limits (`rateLimitType` on its limit events). */
export const LIMIT_NAMES = Object.freeze({
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  seven_day_overage_included: 'weekly limit',
  overage: 'extra usage limit',
});

/** A window at or past this much is "nearly reached": Codex's nearing notice is said once per window from here. */
export const NEARING_PERCENT = 80;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// A time as ms: seconds on some builds, an ISO string from Claude's usage answer.
function toMs(v) {
  if (finite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}
const percent = (v) => (finite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

/** "at 3:10 PM" today, "on Mon, Nov 17 at 3:10 PM" any other day. '' for a time that cannot be read. */
export function when(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `at ${time}`;
  return `on ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

/** The short form for a row: "3:10 PM" today, "Mon 3:10 PM" this week, "Nov 24" further out. */
function whenShort(at, now = Date.now()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  if (Math.abs(d.getTime() - now) < 6 * 86400000) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const CLAUDE_WINDOWS = [
  ['five_hour', 'five_hour', LIMIT_NAMES.five_hour],
  ['seven_day', 'weekly', LIMIT_NAMES.seven_day],
  ['seven_day_opus', 'weekly_opus', LIMIT_NAMES.seven_day_opus],
  ['seven_day_sonnet', 'weekly_sonnet', LIMIT_NAMES.seven_day_sonnet],
];

/**
 * Claude Code's plan limits. Takes what Session.usage() returns ({ rateLimits }), the raw answer ({ rate_limits }),
 * or the windows object itself. A window with no reading is left out; an API key login has none at all.
 * @returns {{ id: string, name: string, usedPercent: number, resetsAt: number | null }[]}
 */
export function limitsFromClaude(usage) {
  try {
    const r = isObj(usage?.rateLimits) ? usage.rateLimits : isObj(usage?.rate_limits) ? usage.rate_limits : isObj(usage) && !('rateLimits' in usage) && !('rate_limits' in usage) ? usage : null;
    if (!r) return [];
    const out = [];
    const add = (id, name, w) => {
      const used = percent(w?.utilization);
      if (used === null) return;
      out.push({ id, name, usedPercent: used, resetsAt: toMs(w.resets_at) });
    };
    for (const [key, id, name] of CLAUDE_WINDOWS) if (isObj(r[key])) add(id, name, r[key]);
    // Weekly windows of single models, named by Claude Code itself ("Fable"). One the fixed rows already cover is not said twice.
    for (const m of Array.isArray(r.model_scoped) ? r.model_scoped.slice(0, 6) : []) {
      const label = typeof m?.display_name === 'string' ? m.display_name.trim().slice(0, 40) : '';
      if (!label) continue;
      const id = `weekly_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
      if (!out.some((l) => l.id === id)) add(id, `weekly ${label} limit`, m);
    }
    return out;
  } catch { return []; }
}

/** What a Codex window is called, by its length: 300 minutes is the 5-hour limit, 10,080 the weekly one. */
export function windowName(mins) {
  if (!finite(mins) || mins <= 0) return { id: 'usage', name: 'usage limit' };
  if (mins === 300) return { id: 'five_hour', name: LIMIT_NAMES.five_hour };
  if (mins === 10080) return { id: 'weekly', name: LIMIT_NAMES.seven_day };
  if (mins % 1440 === 0) { const n = mins / 1440; return { id: `${n}_day`, name: `${n}-day limit` }; }
  const n = Math.max(1, Math.round(mins / 60));
  return { id: `${n}_hour`, name: `${n}-hour limit` };
}

/**
 * Codex's plan limits: the primary and secondary windows of a rate-limit snapshot. Takes the answer to
 * `account/rateLimits/read` ({ rateLimits }) or a snapshot itself. An API key login has no snapshot: [].
 * @returns {{ id: string, name: string, usedPercent: number, resetsAt: number | null }[]}
 */
export function limitsFromCodex(snapshot) {
  try {
    const s = isObj(snapshot?.rateLimits) ? snapshot.rateLimits : isObj(snapshot) ? snapshot : null;
    if (!s) return [];
    const out = [];
    for (const w of [s.primary, s.secondary]) {
      if (!isObj(w)) continue;
      const used = percent(w.usedPercent);
      if (used === null) continue;
      const { id, name } = windowName(w.windowDurationMins);
      if (!out.some((l) => l.id === id)) out.push({ id, name, usedPercent: used, resetsAt: toMs(w.resetsAt) });
    }
    return out;
  } catch { return []; }
}

/**
 * Codex's updates are sparse: a window or a field it does not mention keeps what the last snapshot said.
 * Returns a new snapshot; either side may be missing.
 */
export function mergeCodex(have, update) {
  const a = isObj(have) ? have : {};
  const b = isObj(update) ? update : {};
  const out = { ...a };
  for (const k of Object.keys(b)) if (b[k] !== null && b[k] !== undefined) out[k] = b[k];
  // The reached flag is not sticky: an update that says nothing is reached clears it.
  if ('rateLimitReachedType' in b) out.rateLimitReachedType = b.rateLimitReachedType ?? null;
  return out;
}

const resetsSentence = (limit) => { const w = limit?.resetsAt ? when(limit.resetsAt) : ''; return w ? ` It resets ${w}.` : ''; };

/** The notice for a limit that is used up. With no name it is just "Usage limit reached." */
export function reachedText(limit) {
  const name = typeof limit?.name === 'string' && limit.name ? limit.name : '';
  return `Usage limit reached${name ? ` (${name})` : ''}.${resetsSentence(limit)}`;
}

/** The notice for a limit that is nearly used up. */
export function nearingText(limit) {
  const name = typeof limit?.name === 'string' && limit.name ? limit.name : '';
  const used = finite(limit?.usedPercent) ? `${Math.round(limit.usedPercent)}% used` : '';
  const detail = [name, used].filter(Boolean).join(', ');
  return `Approaching your usage limit${detail ? ` (${detail})` : ''}.${resetsSentence(limit)}`;
}

/** One limit as a row: "5-hour limit · 42% used · resets 3:10 PM". */
export function limitLine(limit, now = Date.now()) {
  if (!isObj(limit) || typeof limit.name !== 'string' || !limit.name) return '';
  const name = limit.name.charAt(0).toUpperCase() + limit.name.slice(1);
  const used = finite(limit.usedPercent) ? `${Math.round(limit.usedPercent)}% used` : '';
  const resets = limit.resetsAt ? whenShort(limit.resetsAt, now) : '';
  return [name, used, resets && `resets ${resets}`].filter(Boolean).join(' · ');
}

/** The list as it may cross to the window: only well-formed rows, at most eight. */
export function cleanLimits(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((l) => isObj(l) && typeof l.id === 'string' && typeof l.name === 'string' && finite(l.usedPercent))
    .slice(0, 8).map((l) => ({ id: l.id, name: l.name, usedPercent: l.usedPercent, resetsAt: finite(l.resetsAt) ? l.resetsAt : null }));
}

// Usage: for the account in use, how much of its plan's limits is used, or what it has spent when it is billed per
// use. What the Usage tab in the right panel shows.
//
// Only the account in use per maker, ever. Nothing is asked about an account that is not the one in use, nothing is
// kept about one once it stops being it, and two accounts are never shown side by side. And nothing runs on its
// own: every read here is started by the tab being on screen (`read`), by a click (`refresh`), or by a turn ending
// while the tab is on screen. With the tab hidden this file does nothing but fold in limit updates that chats
// receive anyway.
//
//   percentOf(value, scale)        one way to read "how full": Claude Code's limit updates give 0-1, usage() gives 0-100
//   claudePlan(usage)              Claude Code's usage() answer as windows: session, week, per-model, extra usage
//   claudeLimit(report, limit)     one limit update from a chat, folded into the report
//   codexPlan(answer)              Codex's account/rateLimits/read answer as windows
//   codexLimits(report, update)    one (sparse) limit update from a Codex chat, folded in
//   nearLimit(windows)             the window at 90% or more, if any (what may then be offered instead is the
//                                  window's to say, with the accounts list: renderer/src/lib/account-rules.ts)
//   claudeSource / codexSource     how each maker's numbers are read: a running chat first, a helper process else
//   Usage                          the cache, the timing, one read in flight per account, and what the window is told
//
// Windows Canopy has no name for are still drawn, under a name made from their key, and noted as drift, so a new
// one shows up as something to name rather than as something missing. The usage() call itself is experimental: if
// a Claude Code does not have it, the tab says usage is unavailable, and that is noted too.
//
// Nothing here touches Electron, a file or a process: the host hands in the chats, the helpers and the counts.
// Nothing exported throws, and async methods resolve.

export const LIVE_EVERY_MS = 60_000;        // through a chat that is already running
export const PROBE_EVERY_MS = 5 * 60_000;   // through a process started only to ask
export const OPEN_FRESH_MS = 60_000;        // opening the tab asks again when what it has is older than this
export const COUNT_EVERY_MS = 10_000;       // Canopy's own count (read from this Mac, nothing is asked of anyone)
export const AFTER_TURN_MS = 2_000;         // a turn ended on the account: its numbers have just moved
export const HOLD_MS = 60 * 60_000;         // "there is nothing to read here" is not asked again for this long
export const WATCH_LEASE_MS = 90_000;       // the tab counts as on screen for this long after it last asked
export const CLICK_FRESH_MS = 5_000;        // a click on numbers this new changes nothing, so nothing is started for it
export const NEAR_LIMIT = 90;

const ENGINES = ['claude', 'codex'];
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v, max = 80) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- reading "how full" ----------

/**
 * A utilisation as a percentage, 0 to 100, or null when it is not a number. `scale` says what the source gives:
 * 'fraction' (0-1: the raw limit update Claude Code sends during a chat) or 'percent' (0-100: usage(), Codex, and
 * the updates Session hands on, which it has already converted). Never guessed from the value: 1 on a 0-100 scale
 * is one percent, not a full window.
 */
export function percentOf(value, scale) {
  const v = num(value);
  if (v === null || v < 0) return null;
  return Math.min(100, scale === 'fraction' ? v * 100 : v);
}

const whenMs = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
// Codex gives seconds; a limit update from Claude Code may give either.
const secondsMs = (v) => { const n = num(v); return n !== null && n > 0 ? (n < 1e12 ? n * 1000 : n) : null; };

// ---------- Claude ----------

// The windows Claude Code's own /usage screen shows, in its order.
const CLAUDE_WINDOWS = [['five_hour', 'Current session'], ['seven_day', 'This week']];
const CLAUDE_MODEL_WINDOWS = [['seven_day_opus', 'Opus this week'], ['seven_day_sonnet', 'Sonnet this week']];
// In Claude Code's answer but not on its screen: named here, and drawn once it has been used.
const CLAUDE_QUIET = { seven_day_oauth_apps: 'Connected apps this week' };
const CLAUDE_OTHER = new Set(['model_scoped', 'extra_usage']);
const WINDOW_KEY = /^[a-z][a-z0-9_]{0,39}$/;

// { utilization, resets_at } as a window, or null when it is not one or says nothing.
function claudeWindow(key, label, v) {
  if (!isPlain(v)) return null;
  const percent = percentOf(v.utilization, 'percent');
  return percent === null ? null : { key, label, percent, resetsAt: whenMs(v.resets_at) };
}

// A name for a window Canopy has not been taught: "seven_day_haiku" reads "Haiku this week".
function genericLabel(key) {
  const words = (s) => cap(s.split('_').filter(Boolean).join(' '));
  if (key.startsWith('seven_day_') && key.length > 10) return `${words(key.slice(10))} this week`;
  if (key.startsWith('five_hour_') && key.length > 10) return `${words(key.slice(10))} this session`;
  return words(key);
}

// Amounts come in the currency's smallest unit (cents for USD), as Claude Code's own schema says.
function minorUnits(currency) {
  try { return 10 ** new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; }
  catch { return null; } // not a currency this runtime knows: the amounts are left out rather than guessed
}

function claudeExtra(v) {
  if (!isPlain(v)) return null;
  const currency = (str(v.currency, 3) ?? 'USD').toUpperCase();
  const unit = minorUnits(currency);
  const money = (x) => { const n = num(x); return n !== null && n >= 0 && unit ? n / unit : null; };
  return { enabled: v.is_enabled === true, percent: percentOf(v.utilization, 'percent'), used: money(v.used_credits), limit: money(v.monthly_limit), currency };
}

/**
 * Claude Code's usage() answer ({ subscriptionType, rateLimitsAvailable, rateLimits }, as Session.usage() and
 * probeUsage give it) as what the tab draws:
 *   { available: false }    no plan windows here (an API key, a Console login, a cloud provider, or a plan login
 *                           that may not read its profile). Which kind of account it is, is not decided from this.
 *   { available: true, plan, windows: [{ key, label, percent, resetsAt }], extra, unknown: [key] }
 * `plan` is the plan's own name as usage() gives it ('max'): the right one for a label. `unknown` lists the windows
 * drawn under a made-up name.
 */
export function claudePlan(usage) {
  const limits = isPlain(usage) && usage.rateLimitsAvailable !== false && isPlain(usage.rateLimits) ? usage.rateLimits : null;
  if (!limits) return { available: false };
  const windows = [];
  const seen = new Set();
  const add = (w) => { if (w && !seen.has(w.label)) { seen.add(w.label); windows.push(w); } };
  for (const [key, label] of CLAUDE_WINDOWS) add(claudeWindow(key, label, limits[key]));
  // Per-model weeks as the server names them ("Fable"), then the two older fixed ones unless already listed.
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped.slice(0, 12) : []) {
    const model = str(m?.display_name, 40);
    if (model) add(claudeWindow(`model:${model}`, `${model} this week`, m));
  }
  for (const [key, label] of CLAUDE_MODEL_WINDOWS) add(claudeWindow(key, label, limits[key]));
  const named = new Set([...CLAUDE_WINDOWS, ...CLAUDE_MODEL_WINDOWS].map(([k]) => k));
  const unknown = [];
  for (const [key, v] of Object.entries(limits)) {
    if (named.has(key) || CLAUDE_OTHER.has(key) || !WINDOW_KEY.test(key)) continue;
    const w = claudeWindow(key, CLAUDE_QUIET[key] ?? genericLabel(key), v);
    if (!w) continue; // null, or a field that is not a window: nothing to draw and nothing to name
    if (!(key in CLAUDE_QUIET)) unknown.push(key);
    if (w.percent > 0) add(w); // one that has never been used says nothing yet
  }
  const extra = claudeExtra(limits.extra_usage);
  if (!windows.length && !extra) return { available: false }; // an answer with nothing in it is not a report
  return { available: true, plan: str(usage.subscriptionType, 40), windows, extra, unknown: unknown.slice(0, 24) };
}

const CLAUDE_ORDER = [...CLAUDE_WINDOWS, ...CLAUDE_MODEL_WINDOWS].map(([k]) => k);

/**
 * One limit update from a chat (as Session hands it on: `type` names the window, `utilization` is already a
 * percentage, `resetsAt` is in ms) folded into a plan report. The same report comes back when the update says
 * nothing about a window the tab draws.
 */
export function claudeLimit(report, limit) {
  if (!isPlain(report) || !Array.isArray(report.windows) || !isPlain(limit)) return report;
  const at = CLAUDE_ORDER.indexOf(limit.type);
  if (at < 0) return report; // extra usage, or a window this update names that Canopy does not draw
  const key = CLAUDE_ORDER[at];
  const old = report.windows.find((w) => w.key === key) ?? null;
  // Refused for being over this limit: full, whatever the last number was.
  const percent = limit.status === 'rejected' ? 100 : percentOf(limit.utilization, 'percent') ?? old?.percent ?? null;
  if (percent === null) return report;
  const label = [...CLAUDE_WINDOWS, ...CLAUDE_MODEL_WINDOWS][at][1];
  const next = { key, label: old?.label ?? label, percent, resetsAt: secondsMs(limit.resetsAt) ?? old?.resetsAt ?? null };
  if (old && old.percent === next.percent && old.resetsAt === next.resetsAt) return report;
  const windows = old ? report.windows.map((w) => (w === old ? next : w)) : [...report.windows, next];
  if (!old) windows.sort((a, b) => order(a.key) - order(b.key));
  return { ...report, windows };
}
// Where a window sits: session, week, the per-model weeks as the server names them, the two older fixed ones, the rest.
const order = (key) => { const i = CLAUDE_ORDER.indexOf(key); return i >= 0 ? (i < 2 ? i : i + 1) : key.startsWith('model:') ? 2 : 9; };

// ---------- Codex ----------

// A window's name from how long it is. Codex names none of them itself.
function codexLabel(mins, slot) {
  const m = num(mins);
  if (m === null || m <= 0) return slot === 'primary' ? 'Current window' : 'Longer window';
  const days = m / 1440;
  if (m <= 12 * 60) return 'Current window';
  if (days >= 6 && days <= 8) return 'This week';
  if (days >= 28 && days <= 31) return 'This month';
  return Number.isInteger(days) ? `${days}-day window` : `${Math.round(m / 60)}-hour window`;
}

function codexWindows(snapshot, prefix, name) {
  const out = [];
  for (const slot of ['primary', 'secondary']) {
    const w = snapshot[slot];
    const percent = isPlain(w) ? percentOf(w.usedPercent, 'percent') : null;
    if (percent === null) continue;
    const label = codexLabel(w.windowDurationMins, slot);
    out.push({ key: `${prefix}${slot}`, label: name ? `${name} · ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label, percent, resetsAt: secondsMs(w.resetsAt) });
  }
  return out;
}

function codexCredits(c) {
  if (!isPlain(c) || (c.hasCredits !== true && c.unlimited !== true)) return null;
  return { unlimited: c.unlimited === true, balance: str(c.balance, 24) };
}

/**
 * Codex's account/rateLimits/read answer as what the tab draws: { available: false } when it holds no window and
 * no credits, else { available: true, plan, limitId, windows, credits }. The main bucket's two windows come
 * first; any other bucket (a model with limits of its own) follows under its own name, once it has been used.
 */
export function codexPlan(answer) {
  const main = isPlain(answer) && isPlain(answer.rateLimits) ? answer.rateLimits : null;
  if (!main) return { available: false };
  const limitId = str(main.limitId, 60);
  const windows = codexWindows(main, '', null);
  for (const [id, snap] of Object.entries(isPlain(answer.rateLimitsByLimitId) ? answer.rateLimitsByLimitId : {}).slice(0, 12)) {
    if (!isPlain(snap) || id === limitId || !/^[\w.-]{1,60}$/.test(id)) continue;
    windows.push(...codexWindows(snap, `${id}:`, str(snap.limitName, 40) ?? id).filter((w) => w.percent > 0));
  }
  const credits = codexCredits(main.credits);
  if (!windows.length && !credits) return { available: false };
  return { available: true, plan: str(main.planType, 40), limitId, windows, credits };
}

/**
 * One limit update from a Codex chat folded into a plan report. Updates are sparse: what one leaves out (a window,
 * the credits, the plan) stays as it was, as Codex's own protocol asks of its clients.
 */
export function codexLimits(report, update) {
  if (!isPlain(report) || !Array.isArray(report.windows) || !isPlain(update)) return report;
  const id = str(update.limitId, 60);
  const mine = !id || id === report.limitId;
  if (!mine && !/^[\w.-]{1,60}$/.test(id)) return report;
  const fresh = codexWindows(update, mine ? '' : `${id}:`, mine ? null : str(update.limitName, 40) ?? id);
  let windows = report.windows;
  for (const w of fresh) {
    const i = windows.findIndex((x) => x.key === w.key);
    if (i < 0) windows = [...windows, w];
    else if (windows[i].percent !== w.percent || windows[i].resetsAt !== w.resetsAt) windows = windows.map((x, n) => (n === i ? { ...x, percent: w.percent, resetsAt: w.resetsAt ?? x.resetsAt } : x));
  }
  const credits = mine ? codexCredits(update.credits) : null;
  const sameCredits = !credits || JSON.stringify(credits) === JSON.stringify(report.credits ?? null);
  if (windows === report.windows && sameCredits) return report;
  // The main bucket's two windows stay first, whichever arrived when.
  const rank = (key) => (key === 'primary' ? 0 : key === 'secondary' ? 1 : 2);
  if (windows !== report.windows) windows = [...windows].sort((a, b) => rank(a.key) - rank(b.key));
  return { ...report, windows, ...(credits && { credits }) };
}

// ---------- near a limit ----------

/**
 * The window closest to its limit, when it is at 90% or more: { key, label, percent }. Else null. With `now`, a
 * window whose reset time has passed does not count: it has started over since it was read, so what was read
 * says nothing about being near a limit any more.
 */
export function nearLimit(windows, now) {
  let hot = null;
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!(w?.percent >= NEAR_LIMIT) || (hot && w.percent <= hot.percent)) continue;
    if (typeof now === 'number' && typeof w.resetsAt === 'number' && w.resetsAt <= now) continue;
    hot = w;
  }
  return hot ? { key: hot.key, label: hot.label, percent: hot.percent } : null;
}

// ---------- how each maker's numbers are read ----------

const failed = (err, via) => ({ ok: false, code: err?.code === 'timeout' ? 'timeout' : 'failed', via });

/**
 * Claude.
 * @param {{
 *   chat: (accountId: string) => object | null,            a running chat on that account (a Session), or null
 *   probe: (accountId: string) => Promise<object>,         probeUsage on that account's launch environment
 *   dollars: (accountId: string) => Promise<object>,       Canopy's own count (account-spend.mjs)
 *   screen: (accountId: string) => string | null,          the id of the chat on screen, when it runs on that account
 *   chatDollars: (sessionId: string) => Promise<number | null>,   what that chat has cost, as Stats counts it
 * }} host
 */
export function claudeSource({ chat, probe, dollars, screen, chatDollars }) {
  const answer = (usage, via) => {
    const p = claudePlan(usage);
    if (!p.available) return { ok: false, code: 'no-limits', via };
    const { available: _a, unknown, ...report } = p;
    return { ok: true, via, report, unknown };
  };
  return {
    live: (id) => !!chat(id),
    screen,
    // A running chat is asked first: it is already up, and asking costs nothing. Only when there is none (or it
    // could not answer) and `probe` allows is a process started to ask.
    async limits(account, { probe: mayProbe }) {
      const s = chat(account.id);
      let via = 'live';
      try {
        if (s) {
          const r = await s.usageAnswer();
          if (r?.ok) return answer(r.usage, via);
          if (r?.code === 'unsupported') return { ok: false, code: 'unsupported', via };
          if (!mayProbe) return { ok: false, code: r?.code === 'timeout' ? 'timeout' : 'failed', via };
        } else if (!mayProbe) return { ok: false, code: 'skipped', via };
        via = 'probe';
        const r = await probe(account.id);
        return r?.supported === false ? { ok: false, code: 'unsupported', via } : answer(r?.usage, via);
      } catch (err) { return failed(err, via); }
    },
    async count(account) {
      const sums = await dollars(account.id);
      const id = screen(account.id);
      const amount = id ? await chatDollars(id) : null;
      return { ok: true, via: 'count', report: { ...sums, chat: id ? { id, amount: num(amount) ?? 0 } : null } };
    },
  };
}

/**
 * Codex.
 * @param {{
 *   chat: (accountId: string) => object | null,     a running Codex chat (a CodexSession), or null
 *   helper: () => Promise<object>,                  CodexService.rateLimits(): the shared helper process
 *   dollars: (accountId: string) => object,         Canopy's own count, at OpenAI's list prices (account-spend.mjs)
 *   screen: (accountId: string) => string | null,   the id of the chat on screen, when it is a Codex chat
 *   chatDollars: (threadId: string) => ({ amount: number, unpriced: number } | null),   that chat, counted the same way
 * }} host
 */
export function codexSource({ chat, helper, dollars, screen, chatDollars }) {
  const answer = (limits, via) => {
    const p = codexPlan(limits);
    if (!p.available) return { ok: false, code: 'no-limits', via };
    const { available: _a, ...report } = p;
    return { ok: true, via, report, unknown: [] };
  };
  // Codex says no to a login that has no plan to read. That is an answer, not a fault.
  const refused = (r) => r?.code === 'rejected';
  return {
    live: (id) => !!chat(id),
    screen,
    async limits(account, { probe: mayProbe }) {
      const s = chat(account.id);
      let via = 'live';
      try {
        if (s) {
          const r = await s.rateLimits();
          if (r?.ok) return answer(r.limits, via);
          if (refused(r)) return { ok: false, code: 'no-limits', via };
          if (!mayProbe) return { ok: false, code: r?.code === 'timeout' ? 'timeout' : 'failed', via };
        } else if (!mayProbe) return { ok: false, code: 'skipped', via };
        via = 'probe';
        const r = await helper();
        if (r?.ok) return answer(r.limits, via);
        return { ok: false, code: refused(r) ? 'no-limits' : r?.code === 'timeout' ? 'timeout' : 'failed', via };
      } catch (err) { return failed(err, via); }
    },
    async count(account) {
      const id = screen(account.id);
      const c = id ? chatDollars(id) : null;
      return { ok: true, via: 'count', report: { ...dollars(account.id), chat: id ? { id, amount: num(c?.amount) ?? 0, unpriced: num(c?.unpriced) ?? 0 } : null } };
    },
  };
}

// ---------- the tab's state ----------

/** An account that needs the user before anything can be read for it. "Could not check" is not one of them. */
const needsAttention = (a) => a.state !== 'ok' && a.state !== 'unknown' && a.state !== 'checking';
/** What the tab draws for an account: a plan's limits, or what was spent when it is billed per use (either maker). */
const shapeOf = (a) => (a.kind === 'plan' ? 'plan' : 'spend');
// Who an account is, as far as its numbers go: the same id signed in as someone else is a different account.
const whoOf = (a) => [a.kind, a.email ?? '', a.keyHint ?? '', a.via ?? ''].join('|');

// A report as it is kept and sent, field by field: what is saved in state.json can hold nothing else.
function cleanWindows(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list.slice(0, 40) : []) {
    const percent = isPlain(w) ? percentOf(w.percent, 'percent') : null;
    if (percent !== null && str(w.key, 110) && str(w.label, 100)) out.push({ key: str(w.key, 110), label: str(w.label, 100), percent, resetsAt: num(w.resetsAt) });
  }
  return out;
}
function cleanReport(shape, r) {
  if (!isPlain(r)) return null;
  if (shape === 'plan') {
    const e = isPlain(r.extra) ? { enabled: r.extra.enabled === true, percent: percentOf(r.extra.percent, 'percent'), used: num(r.extra.used), limit: num(r.extra.limit), currency: str(r.extra.currency, 3) ?? 'USD' } : null;
    const c = isPlain(r.credits) ? { unlimited: r.credits.unlimited === true, balance: str(r.credits.balance, 24) } : null;
    return { plan: str(r.plan, 40), limitId: str(r.limitId, 60), windows: cleanWindows(r.windows), extra: e, credits: c };
  }
  const size = (x) => Math.max(0, num(x) ?? 0);
  const chat = isPlain(r.chat) && str(r.chat.id, 80) ? { id: str(r.chat.id, 80), amount: size(r.chat.amount), unpriced: size(r.chat.unpriced) } : null;
  // Tokens no price is known for (Codex, a model that is not in the price list): how many, and which models.
  const u = isPlain(r.unpriced) ? r.unpriced : null;
  const models = (Array.isArray(u?.models) ? u.models : []).map((m) => str(m, 80)).filter(Boolean).slice(0, 8);
  const unpriced = u && (size(u.today) || size(u.month)) ? { today: size(u.today), month: size(u.month), models } : null;
  return { unit: 'usd', today: size(r.today), month: size(r.month), since: num(r.since), chat, unpriced };
}

export class Usage {
  /**
   * @param {{
   *   accounts: () => object,                 the registry's view(): { inUse, list, checking }
   *   sources: Record<string, object>,        per engine: see claudeSource and codexSource
   *   load?: () => object | null | undefined, save?: (state: object) => unknown,     state.json's `usage`
   *   onChange?: (view: object) => void,      what the tab shows changed, while it is on screen
   *   onDrift?: (label: string, keys: string[]) => void,
   *   log?: (msg: string) => void, now?: () => number,
   *   timers?: { set: (fn: () => void, ms: number) => unknown, clear: (t: unknown) => void },
   * }} deps
   */
  constructor({ accounts, sources, load, save, onChange, onDrift, log, now, timers } = {}) {
    this.accounts = typeof accounts === 'function' ? accounts : () => null;
    this.sources = {};
    for (const e of ENGINES) if (isPlain(sources?.[e])) this.sources[e] = sources[e];
    this.saveFn = typeof save === 'function' ? save : () => {};
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onDrift = typeof onDrift === 'function' ? onDrift : () => {};
    this.logFn = typeof log === 'function' ? log : () => {};
    this.now = typeof now === 'function' ? now : Date.now;
    this.timers = timers ?? { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (t) => clearTimeout(t) };
    this.loadFn = typeof load === 'function' ? load : () => null;
    this.kept = null;    // the saved reports by engine, read from the host on first use (see `saved`)
    this.slots = {};     // engine -> what is known for the account in use: see #slot
    this.seen = 0;       // when the tab last asked: it is on screen for WATCH_LEASE_MS after that
    this.lastView = null;
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a read */ } }

  // The reports that were saved, read once, on first use. What cannot be read is simply no cache.
  get saved() {
    if (this.kept) return this.kept;
    let s = null;
    try { s = this.loadFn() ?? null; } catch { /* unreadable */ }
    this.kept = isPlain(s?.reports) ? { ...s.reports } : {};
    return this.kept;
  }

  // ---- what the tab calls ----

  /**
   * The tab is on screen: here is what is known, and anything stale is being read again. `open`: the tab was just
   * opened, so what it shows is asked for again once it is a minute old, however it has to be read.
   */
  read({ open = false } = {}) {
    this.seen = this.now();
    for (const { engine, account } of this.#shown()) this.#maybe(engine, account, open === true);
    return this.view();
  }

  /**
   * A click on "Updated…" or Try Again: read now, whatever its age. A read already on its way is not doubled, and
   * numbers read a few seconds ago are not read again (a second click would only start another process).
   */
  refresh(engine) {
    this.seen = this.now();
    for (const x of this.#shown()) {
      if ((engine && x.engine !== engine) || needsAttention(x.account)) continue;
      const slot = this.#slot(x.engine, x.account);
      if (!slot.error && slot.at !== null && this.now() - slot.at < CLICK_FRESH_MS) continue;
      slot.hold = null;
      this.#fetch(x.engine, x.account, { probe: true });
    }
    return this.view();
  }

  /** The tab went away (closed, another tab, the window hidden): nothing more is read until it asks again. */
  watch(on) {
    if (on === true) { this.seen = this.now(); return; }
    this.seen = 0;
    for (const slot of Object.values(this.slots)) this.#untime(slot);
  }

  get watching() { return this.seen > 0 && this.now() - this.seen < WATCH_LEASE_MS; }

  // ---- what chats tell it ----

  /** A turn ended in a chat on `accountId`. If the tab is on screen and shows that account, read again shortly. */
  turnEnded(engine, accountId) {
    try {
      if (!this.watching) return;
      const x = this.#shown().find((s) => s.engine === engine);
      if (!x || x.account.id !== accountId || needsAttention(x.account)) return;
      const slot = this.#slot(engine, x.account);
      this.#untime(slot);
      slot.timer = this.timers.set(() => {
        slot.timer = null;
        if (!this.watching) return;
        const now = this.#shown().find((s) => s.engine === engine);
        // Through the chat that just answered, never through a new process; and if it cannot say, what is shown stays.
        if (now && now.account.id === slot.id && this.slots[engine] === slot) this.#fetch(engine, now.account, { probe: false, quiet: true });
      }, AFTER_TURN_MS);
    } catch (err) { this.log(`turn end: ${err?.message ?? err}`); }
  }

  /**
   * A limit update arrived in a chat on `accountId`: for Claude what Session's onRateLimit hands on, for Codex the
   * update as it came. Folded into the report at once, tab on screen or not. An update for an account that is not
   * the one in use is dropped: nothing is kept about it.
   */
  limit(engine, accountId, update) {
    try {
      const x = this.#shown().find((s) => s.engine === engine);
      if (!x || x.account.id !== accountId || shapeOf(x.account) !== 'plan') return;
      const slot = this.#slot(engine, x.account);
      if (!slot.report) return; // nothing read yet to fold it into: the first read will be newer than this
      const next = engine === 'claude' ? claudeLimit(slot.report, update) : codexLimits(slot.report, update);
      if (next === slot.report) return;
      slot.report = next;
      this.#save();
      this.#emit();
    } catch (err) { this.log(`limit update: ${err?.message ?? err}`); }
  }

  // ---- what the window is shown ----

  /**
   * One section per maker that has an account in use, Claude first:
   *   { engine, account, shape, at, loading, error, … }
   * `account` is the registry's own row. `shape`: 'plan' (windows, extra, credits, near), 'spend' (count:
   * { unit, today, month, since, chat, unpriced? }, in dollars for either maker), or 'attention' (the account needs the user: nothing is
   * read for it). `at`: when the numbers were read, null when there are none yet. `error`: 'unavailable' (could not
   * be read just now), 'unsupported' (this Claude Code cannot say) or 'no-limits' (this login has none to read).
   */
  view() {
    const v = this.#registry();
    const sections = [];
    for (const { engine, account } of this.#shown(v)) {
      const a = { ...account };
      if (needsAttention(a)) { sections.push({ engine, account: a, shape: 'attention', at: null, loading: false, error: null }); continue; }
      const slot = this.#slot(engine, a);
      const shape = shapeOf(a);
      const base = { engine, account: a, shape, at: slot.report ? slot.at : null, loading: !!slot.flying, error: slot.error };
      const r = slot.report;
      if (shape === 'plan') {
        const near = r ? nearLimit(r.windows, this.now()) : null;
        // `near`: the window that is nearly full. Which account may be offered instead, and switching to it, are
        // the window's and the accounts' own (account-rules.ts `limitOffer`, `accounts:use`): never another plan.
        sections.push({ ...base, plan: r?.plan ?? null, windows: r?.windows ?? [], extra: r?.extra ?? null, credits: r?.credits ?? null, near });
      } else {
        // "This chat" is only shown for the chat it was counted for: after a switch the row waits for the new count.
        const on = this.#screen(engine, a.id);
        const chat = r?.chat && r.chat.id === on ? r.chat : null;
        // `unpriced`: tokens with no known price, which are shown as tokens beside the dollars. Absent when there are none.
        const loose = r && (r.unpriced || chat?.unpriced) ? { today: r.unpriced?.today ?? 0, month: r.unpriced?.month ?? 0, chat: chat?.unpriced ?? 0, models: r.unpriced?.models ?? [] } : null;
        sections.push({ ...base, count: r ? { unit: r.unit, today: r.today, month: r.month, since: r.since, chat: chat ? chat.amount : null, ...(loose && { unpriced: loose }) } : null });
      }
    }
    return { sections, checking: v.checking === true };
  }

  // ---- internals ----

  #registry() {
    let v = null;
    try { v = this.accounts(); } catch { v = null; }
    return { inUse: isPlain(v?.inUse) ? v.inUse : {}, list: Array.isArray(v?.list) ? v.list.filter(isPlain) : [], checking: v?.checking === true };
  }

  // The account in use per engine, Claude first. An engine with none has no section.
  #shown(v = this.#registry()) {
    const out = [];
    for (const engine of ENGINES) {
      const id = v.inUse[engine];
      const account = typeof id === 'string' ? v.list.find((a) => a.engine === engine && a.id === id) : null;
      if (account) out.push({ engine, account });
    }
    return out;
  }

  #screen(engine, id) { try { return this.sources[engine]?.screen?.(id) ?? null; } catch { return null; } }

  // What is known for the account in use. One per engine: when another account (or another person on the same
  // login) takes its place, the old one's numbers are let go, in memory and in what is saved.
  #slot(engine, a) {
    const who = whoOf(a);
    let s = this.slots[engine];
    if (s && s.id === a.id && s.who === who) return s;
    if (s) this.#untime(s);
    s = this.slots[engine] = { id: a.id, who, shape: shapeOf(a), report: null, at: null, error: null, tried: null, probed: null, hold: null, flying: null, timer: null };
    const kept = this.saved[engine];
    const report = isPlain(kept) && kept.id === a.id && kept.who === who && kept.shape === s.shape ? cleanReport(s.shape, kept.report) : null;
    if (report && num(kept.at)) { s.report = report; s.at = kept.at; s.tried = kept.at; }
    else if (kept !== undefined) this.#save(); // someone else's numbers: gone from what is saved now, not at the next read
    return s;
  }

  #untime(slot) { if (slot.timer) { this.timers.clear(slot.timer); slot.timer = null; } }

  // Read again if what there is has gone stale. Called only while the tab is on screen.
  #maybe(engine, a, open) {
    const src = this.sources[engine];
    if (!src || needsAttention(a)) return;
    const slot = this.#slot(engine, a);
    if (slot.flying) return;
    const now = this.now();
    const since = (t) => (t === null ? Infinity : now - t);
    if (slot.shape !== 'plan') {
      const moved = (this.#screen(engine, a.id) ?? null) !== (slot.report?.chat?.id ?? null); // another chat is on screen
      if (moved || since(slot.tried) >= COUNT_EVERY_MS) this.#fetch(engine, a, { probe: false });
      return;
    }
    if (slot.hold !== null && now < slot.hold) return;
    let live = false;
    try { live = src.live(a.id) === true; } catch { live = false; }
    const probe = since(slot.probed) >= (open ? OPEN_FRESH_MS : PROBE_EVERY_MS);
    if (since(slot.tried) < (open || live ? LIVE_EVERY_MS : PROBE_EVERY_MS)) return;
    if (!live && !probe) return;
    this.#fetch(engine, a, { probe });
  }

  // One read at a time per account. `probe`: a process may be started to ask. `quiet`: a failure changes nothing.
  #fetch(engine, a, { probe, quiet = false }) {
    const src = this.sources[engine];
    if (!src || needsAttention(a)) return; // nothing is ever read for an account that needs the user first
    const slot = this.#slot(engine, a);
    if (slot.flying) return;
    const started = this.now();
    const run = (async () => {
      try { return (slot.shape === 'plan' ? await src.limits({ ...a }, { probe }) : await src.count({ ...a })) ?? { ok: false, code: 'failed' }; }
      catch (err) { this.log(`${engine}: could not read usage (${err?.message ?? err})`); return { ok: false, code: 'failed' }; }
    })();
    slot.flying = run;
    this.#emit();
    run.then((r) => {
      if (slot.flying !== run) return;
      slot.flying = null;
      try { this.#land(engine, slot, r, started, quiet); } catch (err) { this.log(`${engine}: could not keep what was read (${err?.message ?? err})`); }
      this.#emit();
    });
  }

  // What a read came back with, kept or noted. `started`: when the read began.
  #land(engine, slot, r, started, quiet) {
    if (this.slots[engine] !== slot) return; // another account is in use now: this answer is nobody's
    if (r.via === 'probe') slot.probed = started;
    if (r.ok) {
      const report = cleanReport(slot.shape, r.report);
      if (report) { slot.report = report; slot.at = this.now(); slot.tried = slot.at; slot.error = null; slot.hold = null; this.#save(); }
      for (const key of Array.isArray(r.unknown) ? r.unknown.slice(0, 6) : []) this.#drift(`a name for the usage limit ${key}`, [key]);
    } else if (r.code !== 'skipped' && !quiet) {
      slot.tried = this.now();
      slot.error = r.code === 'unsupported' || r.code === 'no-limits' ? r.code : 'unavailable';
      // Nothing to read here: asking again every minute would only start processes for the same answer.
      if (slot.error !== 'unavailable') slot.hold = slot.tried + HOLD_MS;
      if (r.code === 'unsupported') this.#drift('the usage call (missing from this Claude Code)', []);
      this.log(`${engine}: usage for ${slot.id} is ${slot.error} (${r.code}${r.via ? `, ${r.via}` : ''})`);
    }
  }

  #drift(label, keys) { try { this.onDrift(label, keys); } catch { /* an observer never breaks a read */ } }

  #save() {
    try {
      const reports = {};
      for (const [engine, s] of Object.entries(this.slots)) if (s.report && s.at) reports[engine] = { id: s.id, who: s.who, shape: s.shape, at: s.at, report: s.report };
      this.kept = reports;
      Promise.resolve(this.saveFn({ v: 1, reports: JSON.parse(JSON.stringify(reports)) })).catch((err) => this.log(`save failed: ${err?.message ?? err}`));
    } catch (err) { this.log(`save failed: ${err?.message ?? err}`); }
  }

  // The window hears about a change once, and only while the tab is there to show it.
  #emit() {
    try {
      if (!this.watching) return;
      const view = this.view();
      const json = JSON.stringify(view);
      if (json === this.lastView) return;
      this.lastView = json;
      this.onChange(view);
    } catch { /* an observer never breaks a read */ }
  }
}

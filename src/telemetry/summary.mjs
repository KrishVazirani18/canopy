// The daily summary (`day_summary`): one event per local day saying how many messages this person sent from each
// tool (Canopy, the terminal, the desktop apps, editors, other apps), for Claude Code and for Codex. It is the number
// telemetry exists for: is Canopy becoming where they work. Counted from the history both tools already keep on the
// Mac, so it also covers the days before Canopy was installed (the baseline).
//
// Two parts:
//   summarizeDays()            counts a range of days. Pure: reads history, sends nothing. The reading happens in a
//                              process of its own (summary-child.mjs running summary-scan.mjs), at low priority,
//                              so Canopy never waits on it.
//   createSummaryScheduler()   once a day, sends every finished day that hasn't been sent, in order, and remembers
//                              how far it got, so a restart neither repeats a day nor skips one. Each day's event
//                              has an id of its own, the same every time, so a day sent twice is stored once.
//                              A day on which sharing was off is never sent, however much later the check runs.
//
// Only counts ever leave these functions: no text, no paths, no names. What a message is and how its tool is told
// are described at the top of summary-scan.mjs.
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readOffDays, wasOff } from './off-days.mjs';
import { clean } from './schema.mjs';
import { addDays, cacheTmp, dayStart, defaultChatsDir, isDate, localDate, scan, DEFAULT_BUDGET } from './summary-scan.mjs';

export { addDays, localDate };

const HOUR = 60 * 60_000;
const MAX_RANGE_DAYS = 400;   // one call never counts more days than this
const BASELINE_DAYS = 30;     // the "before Canopy" days sent on the first run
const MAX_CATCH_UP = 30;      // days further back are let go: Claude Code itself deletes history after a month
const MAX_PARTIAL = 6;        // checks to wait for a first scan to finish before sending what there is

const CHILD = new URL('./summary-child.mjs', import.meta.url);
const CHILD_START_MS = 20_000;  // a process that has not said it is up by then is not coming
const CHILD_SLACK_MS = 60_000;  // past its own time budget: listing the files, the last file, saving the cache
const list = (v) => (v == null ? [] : Array.isArray(v) || v instanceof Set ? [...v] : [v]).filter((x) => typeof x === 'string' && x);
const moment = (v) => { const n = typeof v === 'function' ? v() : v instanceof Date ? v.getTime() : v; return Number.isFinite(n) ? n : null; };

/** The call's options as plain data: what the scan is handed, in whichever process it runs. Throws on dates that make no sense. */
function jobOf(o) {
  const { fromDate, toDate } = o;
  if (!isDate(fromDate) || !isDate(toDate)) throw new TypeError('summarizeDays: fromDate and toDate must be YYYY-MM-DD');
  if (fromDate > toDate) throw new RangeError('summarizeDays: fromDate is after toDate');
  if (dayStart(toDate) - dayStart(fromDate) > MAX_RANGE_DAYS * 24 * HOUR) throw new RangeError(`summarizeDays: more than ${MAX_RANGE_DAYS} days`);
  const from = moment(o.canopyBeforeIds?.from), until = moment(o.canopyBeforeIds?.until);
  return {
    claudeDirs: list(o.claudeDirs),
    codexHome: typeof o.codexHome === 'string' && o.codexHome ? o.codexHome : null,
    ids: { claude: list(o.canopySessionIds?.claude), codex: list(o.canopySessionIds?.codex) },
    fromDate, toDate,
    cacheFile: typeof o.cacheFile === 'string' && o.cacheFile ? o.cacheFile : null,
    now: moment(o.now) ?? Date.now(),
    chatsDirs: o.canopyChatsDir === undefined ? [defaultChatsDir()] : list(o.canopyChatsDir),
    window: from !== null && until !== null ? { from, until } : null,
    budget: { bytes: Number.isFinite(o.budget?.bytes) ? o.budget.bytes : DEFAULT_BUDGET.bytes, ms: Number.isFinite(o.budget?.ms) ? o.budget.ms : DEFAULT_BUDGET.ms },
    ...(Number.isInteger(o.chunkBytes) && { chunk: o.chunkBytes }), // tests: a tiny read size, so rows straddle reads
  };
}

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * What the scan's process answered, kept to what a day's counts are: each day through the catalog's own check (a
 * date and whole numbers, under the names `day_summary` lists), the stats as numbers and flags. Whatever else that
 * process might say stops here.
 */
function countsOnly(m) {
  if (!Array.isArray(m?.days)) throw coded('CHILD_ANSWER', 'the summary scan answered with something that is not days');
  const days = m.days.map((d) => clean('day_summary', d)).filter((d) => isDate(d?.date));
  const stats = Object.fromEntries(Object.entries(m.stats && typeof m.stats === 'object' ? m.stats : {}).filter(([, v]) => typeof v === 'boolean' || Number.isFinite(v)));
  return { days, stats: { ...stats, child: true } };
}

/**
 * How the scan's process is started: plain Node, with nothing of this process's own flags. Inside Electron this
 * process is the app itself, so the child is told to run as Node (ELECTRON_RUN_AS_NODE) and, on a Mac, started from
 * the helper app, which has no Dock icon. Electron's own fork() does the same; it is spelled out so nothing depends on it.
 * (It does depend on Electron's `runAsNode` fuse, which is on unless a packaged build turns it off. A build that
 * does must start this file with Electron's utilityProcess instead: with the fuse off, this would open Canopy again.)
 */
function childOptions() {
  const helper = process.versions.electron && process.platform === 'darwin' ? process.helperExecPath : null;
  // The Mac's timezone comes along with the rest of the environment; Node flags someone set for other programs don't.
  const { NODE_OPTIONS: _flags, ...env } = process.env;
  return {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], // it has nothing to print, and nothing of it is read but its answer
    ...(typeof helper === 'string' && existsSync(helper) && { execPath: helper }),
  };
}

/**
 * Runs the scan in a process of its own, at the lowest priority, and ends that process whatever happens: when it has
 * answered, when `signal` says stop (Canopy is quitting), and when it runs past `timeoutMs`. Rejects with code
 * 'CHILD_START' when the process never got going, and with the scan's own error code when the scan failed.
 */
function inChild(job, signal, { module = CHILD, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(coded('ABORT_ERR', 'summary stopped')); return; }
    let child = null, ready = false, done = false, startTimer = null, runTimer = null;
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(startTimer); clearTimeout(runTimer);
      signal?.removeEventListener('abort', onAbort);
      end(child, job.cacheFile);
      settle(value);
    };
    const onAbort = () => finish(reject, coded('ABORT_ERR', 'summary stopped'));
    const notStarted = (why) => finish(reject, coded('CHILD_START', why));
    try { child = childProcess.fork(fileURLToPath(module), [], childOptions()); } catch (err) { reject(coded('CHILD_START', String(err?.message ?? err))); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    // Below everything else on the Mac: the scan takes the processor only when nothing wants it.
    try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* it runs at the usual priority */ }
    startTimer = setTimeout(() => notStarted('the summary process did not start in time'), CHILD_START_MS);
    child.on('message', (m) => {
      if (done) return;
      if (m?.ready === true && !ready) {
        ready = true;
        clearTimeout(startTimer);
        runTimer = setTimeout(() => finish(reject, coded('TIMEOUT', 'the summary scan took too long and was stopped')), timeoutMs);
        // The job goes once the process is listening: sent sooner, it could arrive before anyone is there to take it.
        try { child.send(job, (err) => { if (err) finish(reject, coded('CHILD_SEND', 'the summary process could not be handed its job')); }); }
        catch { finish(reject, coded('CHILD_SEND', 'the summary process could not be handed its job')); }
        return;
      }
      if (!ready) return;
      if (m?.ok === true) { try { finish(resolve, countsOnly(m)); } catch (err) { finish(reject, err); } }
      else finish(reject, coded(typeof m?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(m.code) ? m.code : 'Error', 'the summary scan failed'));
    });
    child.on('error', (err) => (ready ? finish(reject, coded('CHILD_ERROR', 'the summary process failed')) : notStarted(String(err?.message ?? err))));
    child.on('exit', (code, sig) => (ready ? finish(reject, coded('CHILD_EXIT', `the summary process stopped (${sig ?? code})`)) : notStarted(`the summary process did not start (${sig ?? code})`)));
  });
}

/** Ends the scan's process if it is still there, and clears away a cache it was stopped in the middle of writing. */
function end(child, cacheFile) {
  if (!child) return;
  const tidy = () => { if (cacheFile && child.pid) unlink(cacheTmp(cacheFile, child.pid)).catch(() => { /* nothing was left */ }); };
  if (child.exitCode !== null || child.signalCode !== null) { tidy(); return; }
  child.once('exit', tidy);
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Message and chat counts per tool for each local day from `fromDate` to `toDate` (both YYYY-MM-DD, both included,
 * days with nothing included as zeros): an array of `day_summary` props without `baseline` and `canopy_active_min`.
 *
 * @param {object} o
 * @param {string[]} o.claudeDirs  every Claude Code config folder Canopy knows (~/.claude, CLAUDE_CONFIG_DIR, accounts)
 * @param {string} [o.codexHome]  Codex's folder (~/.codex or CODEX_HOME)
 * @param {{claude?: Iterable<string>, codex?: Iterable<string>}} [o.canopySessionIds]  the chats Canopy ran: exact
 * @param {string} o.fromDate
 * @param {string} o.toDate
 * @param {string} [o.cacheFile]  where per-file counts are remembered, so the next call reads only what changed
 * @param {number|(() => number)} [o.now]
 * @param {string|string[]} [o.canopyChatsDir]  Canopy's own chats folder (userData/chats); default: its usual place
 * @param {{from: number, until: number}} [o.canopyBeforeIds]  when Canopy was in use but not yet recording chat ids
 *   (ms): SDK chats from then, outside temp folders, count as Canopy's. Give stable values; they are part of what
 *   the cache is good for. Leave out on an install that recorded ids from its first chat.
 * @param {{bytes?: number, ms?: number}} [o.budget]  how much one call may read before stopping (the rest next call)
 * @param {AbortSignal} [o.signal]  stops the scan (its process is ended at once)
 * @param {boolean|URL} [o.child]  false: scan in this process, in small steps (what happens anyway when no process
 *   can be started). A URL: another module to run as the process (tests).
 * @param {number} [o.timeoutMs]  how long the scan's process may run before it is ended; default: the time budget,
 *   twice over, and a minute
 * @returns {Promise<object[]>} the days, oldest first. `.stats` (not enumerable) says how the scan went;
 *   `.stats.partial` means the budget ran out and a later call will complete the counts; `.stats.child` says it ran
 *   in a process of its own.
 */
export async function summarizeDays(o = {}) {
  const job = jobOf(o);
  let result;
  if (o.child === false) result = await scan({ ...job, inline: true });
  else {
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : job.budget.ms * 2 + CHILD_SLACK_MS;
    try { result = await inChild(job, o.signal, { module: o.child instanceof URL ? o.child : undefined, timeoutMs }); } catch (err) {
      // No process could be started here: the same scan in this one, a small read at a time. Only then: a scan
      // that started and failed, or was stopped, is not tried a second time in Canopy's own process.
      if (err?.code !== 'CHILD_START') throw err;
      result = await scan({ ...job, inline: true });
    }
  }
  return Object.defineProperty(result.days, 'stats', { value: { child: false, ...result.stats }, enumerable: false });
}

const KEY = { cursor: 'summary.lastSentDate', baseline: 'summary.baselineBefore' };

/**
 * The id of one day's `day_summary` event: the same for the same install and day, every time it is made. If Canopy
 * quits between sending a day and writing down that it did, the next launch sends that day again under the same
 * id, and PostHog merges the two: it keeps one of two events that share their id, name, person and day, and a day's
 * summary is always filed under the day it is about (posthog.mjs). The merge runs in the background, usually within
 * minutes; until it has, the day counts twice. Shaped as a UUID (version 8, the one for ids an application makes up
 * itself), which is what an event's id has to be.
 * Null when there is no install id or date to make it from.
 */
export function daySummaryId(installId, date) {
  if (typeof installId !== 'string' || !installId || !isDate(date)) return null;
  const h = createHash('sha256').update(`${installId.toLowerCase()}:${date}:day_summary`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Sends `day_summary` once per finished local day.
 *
 * Each check (shortly after start(), then hourly): every day after the last one sent, up to yesterday, is counted in
 * one scan and sent oldest first, the last sent date saved after each. The very first check sends the 30 days before
 * it, marked `baseline: true` where they are from before Canopy was installed. A check with nothing due costs two
 * reads of `state`. Nothing here throws.
 *
 * Days that are never sent (the marker moves past them as it does past a day that was sent, and they are not counted):
 *   - a day on which sharing was off, at any moment of it (`offDays`). Turning sharing on later does not send them.
 *   - the days from before Canopy (the baseline), once sharing has been off at all. That month goes once, from an
 *     install that has shared since its first run; someone who said no and came back shares from then on.
 *
 * @param {object} o
 * @param {(event: string, props: object, opts?: {id: string}) => void} o.track  Telemetry's track()
 * @param {string|(() => string|null|Promise<string|null>)} [o.installId]  this install's id (Telemetry's
 *   status().installId). With it, each day's event goes out under daySummaryId(), so a day sent twice is stored once.
 * @param {{get(key: string): any, set(key: string, value: any): any}} o.state  persisted by core; may be async
 * @param {(range: {fromDate: string, toDate: string, signal: AbortSignal}) => Promise<object[]>} o.summarize
 *   summarizeDays with the folders and chat ids filled in
 * @param {(date: string) => number|Promise<number>} [o.activeMinutesFor]  minutes Canopy was in front that day
 * @param {() => number} [o.now]
 * @param {number|Date} [o.installedAt]  when Canopy was first run on this Mac; days before it are the baseline.
 *   Default: the day of the first check, right for a new install.
 * @param {() => boolean|Promise<boolean>} [o.enabled]  false: nothing is counted or sent, and those days stay unsent
 * @param {() => unknown} [o.offDays]  the stretches of local dates on which sharing was off: [[from, to | null]]
 *   (Telemetry's offDays()). Asked at every check; if it can't be read, that check sends nothing.
 * @param {(msg: string) => void} [o.log]
 * @returns {{start(): void, stop(): void, runNow(): Promise<{sent: number, partial?: boolean, off?: boolean, error?: string}>}}
 */
export function createSummaryScheduler({ track, state, summarize, installId, activeMinutesFor, now = Date.now, installedAt, enabled, offDays, log, checkEveryMs = HOUR, startDelayMs = 30_000 } = {}) {
  const clock = () => moment(now) ?? Date.now();
  const say = (msg) => { try { log?.(`day summary: ${msg}`); } catch { /* a log that fails is not our problem */ } };
  let timer = null, first = null, running = null, abort = null;
  let stops = 0;          // stop() calls so far: a check that began before one ends without sending
  let partials = 0;
  let sentThrough = null; // the last day dealt with by this process (sent, or left out): holds even when saving it failed
  const dateIn = async (key) => { const v = await state.get(key); return isDate(v) ? v : null; };
  /** This day is dealt with: no later check comes back to it. */
  const done = async (date) => { sentThrough = date; await state.set(KEY.cursor, date); };

  async function check() {
    const began = stops;
    const today = localDate(clock());
    const last = addDays(today, -1); // the newest finished day
    let cursor = await dateIn(KEY.cursor);
    if (sentThrough && (!cursor || sentThrough > cursor)) cursor = sentThrough;

    if (enabled && !(await enabled())) {
      // Off means those days are never reported: the marker moves on without anything being read.
      if (cursor && cursor < last) { await state.set(KEY.cursor, last); sentThrough = last; }
      return { sent: 0, off: true };
    }

    let baselineBefore = await dateIn(KEY.baseline);
    if (!cursor) {
      // The first run: the month before today goes out, and what counts as "before Canopy" is settled once.
      const installed = moment(installedAt);
      baselineBefore = installed !== null && localDate(installed) < today ? localDate(installed) : today;
      cursor = addDays(today, -(BASELINE_DAYS + 1));
      await state.set(KEY.baseline, baselineBefore);
      await state.set(KEY.cursor, cursor);
    }

    let from = addDays(cursor, 1);
    const oldest = addDays(today, -MAX_CATCH_UP);
    if (from < oldest) from = oldest; // away for longer than history is kept: start where it can still be counted
    if (from > last) return { sent: 0 };

    // The days sharing was off, asked afresh each time: it may have been turned off and on again since the last check.
    const off = offDays ? readOffDays(await offDays()) : [];
    const leftOut = (date) => wasOff(off, date) || (off.length > 0 && !!baselineBefore && date < baselineBefore);
    // Days left out at the start need no counting: the marker moves past them, and the scan begins after them.
    let first = from;
    while (first <= last && leftOut(first)) first = addDays(first, 1);
    if (first > from) { await done(addDays(first, -1)); from = first; }
    if (from > last) return { sent: 0 };

    if (stops !== began) return { sent: 0 };
    abort = new AbortController();
    const signal = abort.signal;
    const days = await summarize({ fromDate: from, toDate: last, signal });
    if (stops !== began) return { sent: 0 };
    // A first scan of a lot of history takes more than one go; each go keeps what it read. Wait for it rather
    // than send low numbers, but not forever.
    if (days?.stats?.partial && ++partials < MAX_PARTIAL) return { sent: 0, partial: true };
    partials = 0;

    const byDate = new Map((Array.isArray(days) ? days : []).map((d) => [d?.date, d]));
    let who = null;
    try { who = typeof installId === 'function' ? await installId() : installId; } catch { /* the days go out under ids of their own */ }
    let sent = 0;
    for (let date = from; date <= last && stops === began; date = addDays(date, 1)) {
      if (leftOut(date)) { await done(date); continue; }
      const day = byDate.get(date);
      if (!day) { say(`no counts for ${date}`); break; } // never skip a day: it is tried again at the next check
      const props = { ...day, baseline: !!baselineBefore && date < baselineBefore };
      if (activeMinutesFor) {
        try {
          const min = await activeMinutesFor(date);
          if (Number.isFinite(min) && min >= 0) props.canopy_active_min = Math.min(Math.round(min), 24 * 60);
        } catch { /* the day goes out without it */ }
      }
      const id = daySummaryId(who, date);
      if (id) track('day_summary', props, { id }); else track('day_summary', props);
      sent++;
      await done(date); // if saving fails the loop ends here; sentThrough keeps this run from repeating
    }
    return { sent };
  }

  /** Runs a check now (one at a time: a second call while one runs gets the same answer). */
  function runNow() {
    running ??= check()
      .catch((err) => { say(String(err?.message ?? err).slice(0, 200)); return { sent: 0, error: String(err?.code ?? err?.name ?? 'Error') }; })
      .finally(() => { running = null; abort = null; });
    return running;
  }

  return {
    /** Checks soon (not at once: launch has better things to do), then every hour. */
    start() {
      if (timer) return;
      first = setTimeout(runNow, startDelayMs);
      timer = setInterval(runNow, checkEveryMs);
      first.unref?.(); timer.unref?.();
    },
    /** Stops checking, ends a scan that is running, and keeps a check already under way from sending more. */
    stop() {
      clearTimeout(first); clearInterval(timer);
      first = null; timer = null;
      stops++;
      abort?.abort();
    },
    runNow,
  };
}

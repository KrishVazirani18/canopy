// When to send what is queued, and what each answer means for the events.
//
// One request at a time, oldest events first, a batch per request. An answer of "try later" starts a pause that
// grows with each failure in a row (1, 2, 5, 15 minutes, then an hour), so a PostHog that is down is not hammered
// and a Mac that is offline for a day costs a handful of tries. Events are only ever removed from the queue by an
// answer that says PostHog has them (or will never take them).
//
// A refusal is believed, within limits. "This batch will never be taken" (400) and "this one event can never fit"
// (413 for a batch of one) drop what was refused, and are then followed by the same pause as a failure; and no more
// than `dropsPerHour` events are dropped in any hour (past that a refused batch is kept and tried again later).
// Without both, something that is not PostHog at all (a proxy in the way) answering 400 or 413 to everything would
// empty the whole queue, batch after batch, in seconds. The hour's drops are remembered between launches when the
// caller gives somewhere to keep them (`dropLog`), so quitting and reopening is not a way round.
//
// A key that is not taken (401, 403) drops nothing. The events are fine and the key is the same until the next
// Canopy, so the next try is an hour away, and asking to "send now" does not bring it forward.
//
// Nothing here owns a timer: the caller says when (`tick` once a minute, `poke` after each new event, `flush` on
// demand), which keeps this testable with a fake clock.
import { LIMITS } from './schema.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const BACKOFF_MS = [1 * MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE];
const LONGEST_PAUSE_MS = 60 * MINUTE;
const SHORTEST_PAUSE_MS = 1000;
/** This many events waiting are sent without waiting for the minute to come round. */
export const FLUSH_AT = 50;
// A batch is measured as the queue holds it, with this much left over. What is posted is larger: every event is
// sent with who it is from (posthog.mjs), a few hundred bytes each. That is still well under half a megabyte for
// the fullest batch, where PostHog takes 20 MB a request.
const HEADER_ROOM = 1024;

/**
 * @param {{
 *   queue: { size: number, batch: (count: number, bytes: number) => object[], remove: (ids: string[]) => void },
 *   post: (events: object[], signal: AbortSignal) => Promise<{ result: string, status?: number, retryAfterMs?: number|null, reason?: string }>,   // send.mjs's answers
 *   canSend: () => boolean,              // the switch is on and there is somewhere to send to
 *   isOnline?: () => boolean,
 *   onSent?: (count: number) => void,
 *   note?: (msg: string) => void,        // one line for the log, when sending starts failing and when it works again
 *   now?: () => number, random?: () => number, limits?: { batchEvents: number, batchBytes: number },
 *   dropsPerHour?: number,               // the most events refusals may cost in any hour; default: one full batch
 *   dropLog?: { read: () => unknown, write: (drops: [number, number][]) => void },   // keeps the hour's drops between launches
 * }} deps
 */
export function createFlusher({ queue, post, canSend, isOnline = () => true, onSent = () => {}, note = () => {}, now = Date.now, random = Math.random, limits = LIMITS, dropsPerHour = limits.batchEvents, dropLog }) {
  let running = null;      // the flush in progress; whoever asks meanwhile shares it
  let request = null;      // the request in flight, so it can be cut
  let failures = 0;        // in a row
  let pauseUntil = 0;
  let firm = false;        // the pause is one even "send now" waits out: PostHog asked for it (429), or the key was not taken
  let failing = null;      // what the log was last told is wrong ('key' or 'other'); null while sending works
  let stopped = false;
  let dropped = null;      // [when, how many] for each refusal believed in the last hour; read from dropLog at first use

  const online = () => { try { return isOnline() !== false; } catch { return true; } };

  /** `said`: the log already has a line about this answer (a batch was dropped). */
  function pause(r, said = false) {
    failures++;
    // Jitter: a fifth either way, so every Canopy that saw the same outage does not come back in the same second.
    const step = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] * (0.8 + 0.4 * random());
    const asked = Number.isFinite(r.retryAfterMs) ? r.retryAfterMs : null;
    // A key that was not taken will not be taken a minute from now either: straight to the longest pause.
    const wait = r.result === 'key' ? LONGEST_PAUSE_MS : r.result === 'wait' ? asked ?? step : Math.max(step, asked ?? 0);
    pauseUntil = now() + Math.min(Math.max(wait, SHORTEST_PAUSE_MS), LONGEST_PAUSE_MS);
    firm = r.result === 'wait' || r.result === 'key';
    // Said once per kind of trouble, not once per try.
    const trouble = r.result === 'key' ? 'key' : 'other';
    if (failing !== trouble && !said) {
      note(trouble === 'key'
        ? `PostHog did not take the key (${r.status}): events are kept, and the next try is in an hour`
        : `could not send (${[r.status || null, r.reason].filter(Boolean).join(': ') || 'no answer'}): events are kept and tried again later`);
    }
    failing = trouble;
  }

  /** The drops of the last hour, an earlier launch's included. (One dated after now is from a clock since set back: let go.) */
  function lately() {
    if (!dropped) {
      let kept = null;
      try { kept = dropLog?.read(); } catch { /* nothing remembered */ }
      dropped = (Array.isArray(kept) ? kept : []).filter((d) => Array.isArray(d) && Number.isFinite(d[0]) && Number.isInteger(d[1]) && d[1] > 0).map(([at, n]) => [at, n]);
    }
    const t = now();
    dropped = dropped.filter(([at]) => at > t - HOUR && at <= t);
    return dropped;
  }

  /** Whether `count` more events may be dropped now: refusals cost no more than `dropsPerHour` events in any hour. */
  const mayDrop = (count) => lately().reduce((sum, [, n]) => sum + n, 0) + count <= dropsPerHour;

  function drop(ids, why) {
    queue.remove(ids);
    lately().push([now(), ids.length]);
    try { dropLog?.write(dropped.map(([at, n]) => [at, n])); } catch { /* the limit still holds for this launch */ }
    note(why);
  }

  async function run(force) {
    if (stopped || !canSend() || !queue.size) return;
    if (now() < pauseUntil && (firm || !force)) return;
    if (!online()) return;
    let most = limits.batchEvents;
    while (!stopped && queue.size && canSend()) {
      const events = queue.batch(most, limits.batchBytes - HEADER_ROOM);
      const ids = events.map((e) => e.id);
      request = new AbortController();
      let r;
      try { r = await post(events, request.signal); }
      catch (err) { r = { result: 'retry', status: 0, reason: String(err?.message ?? err) }; }
      request = null;
      if (stopped) return; // turned off or quitting while it was out: the answer no longer changes anything
      if (r.result === 'ok') {
        queue.remove(ids);
        failures = 0;
        if (failing) note('sending works again');
        failing = null;
        most = Math.min(limits.batchEvents, most * 2); // after a split, work back up to full batches
        onSent(events.length);
      } else if (r.result === 'split' && events.length > 1) {
        most = Math.ceil(events.length / 2);
      } else if ((r.result === 'drop' || r.result === 'split') && mayDrop(events.length)) {
        // Refused for good: the batch, or the one event that fits in no request, goes. Then the same pause as after
        // a failure, so that whatever answers this way to everything costs one batch now and not the queue.
        // (A batch with no status was never posted: Canopy's own last check found nothing in it that may be sent.)
        drop(ids, r.result === 'split' ? 'one event was too big for PostHog: dropped'
          : r.status ? `PostHog refused a batch of ${events.length} (${r.status}): dropped, it would be refused again`
            : `a batch of ${events.length} was dropped unsent: ${r.reason || 'it may not be sent'}`);
        pause(r, true);
        return;
      } else {
        // Try later. That includes a key that was not taken, and a refusal past the hour's limit: the events are kept.
        pause(r);
        return;
      }
    }
  }

  const start = (force) => {
    running = run(force).catch((err) => note(`flush failed: ${err?.message ?? err}`)).finally(() => { running = null; });
    return running;
  };

  const flusher = {
    /** The regular try: sends unless a request is out or a pause is on. */
    tick() { return running ?? start(false); },
    /** A new event was queued: enough waiting is a reason to send now. */
    poke() { if (!running && queue.size >= FLUSH_AT) start(false); },
    /**
     * Send what is queued now, after whatever is already in flight. Skips the pause after a failure (one more try
     * is the point of asking), but not one PostHog asked for, nor the one after a key that was not taken.
     */
    flush() { return running ? running.then(() => flusher.flush()) : start(true); },
    /** Stop for good or for now: the request in flight is cut and nothing more is sent until `resume`. */
    stop() { stopped = true; request?.abort(); },
    resume() { stopped = false; },
    get pausedUntil() { return pauseUntil; },
  };
  return flusher;
}

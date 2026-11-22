// One POST of one batch to PostHog, and what the answer means. Never throws: whatever goes wrong comes back as one
// of six answers, which is all the queue needs to decide what happens to the events (src/telemetry/flush.mjs).
//
//   ok     2xx                    PostHog has them
//   drop   400                    the batch itself is wrong: sending it again can't help
//   split  413                    too big: send it in halves
//   wait   429                    slow down (for as long as Retry-After says, when it says)
//   key    401, 403               the key was not taken: nothing is wrong with the events, so they are kept
//   retry  anything else          PostHog or the network is having a bad time: keep the events, try later
//
// These are the answers of PostHog's /batch/ (https://posthog.com/docs/api/capture, and its capture service's own
// list of errors): 200 once the batch is read; 400 for a body it can't read or an event with no name or person;
// 401 for a key that is missing or not a project's; 413 past its size limit (20 MB a request, far above anything
// sent here); 429 when it limits a sender; 503 when it could not store the batch and wants it again. What a 200
// can't say: a project over its monthly quota still answers 200 and keeps nothing, and Canopy can't tell.
//
// A redirect is never followed. PostHog's endpoint does not redirect, so one means something else answered (a
// sign-in page in the way, a host that has moved on), and where it leads may well say 200 to anything: followed,
// that would read as "PostHog has them" and the events would be forgotten.

export const SEND_TIMEOUT_MS = 15_000;

/** Retry-After as milliseconds from now: it is either a number of seconds or a date. Null when it says neither. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function answer(res, now) {
  const status = Number(res?.status);
  if (status >= 200 && status < 300) return { result: 'ok', status };
  if (status === 400) return { result: 'drop', status };
  if (status === 413) return { result: 'split', status };
  // Not about the events: a key PostHog does not know (401), or something in between that lets nobody through
  // (403). A wrong key is put right by the next Canopy, and what waited for it must still be here then.
  if (status === 401 || status === 403) return { result: 'key', status };
  let after = null;
  try { after = retryAfterMs(res?.headers?.get?.('retry-after'), now); } catch { /* no usable header */ }
  return { result: status === 429 ? 'wait' : 'retry', status: Number.isFinite(status) ? status : 0, retryAfterMs: after };
}

/**
 * @param {{
 *   endpoint: string,                     // PostHog's /batch/ (config.mjs)
 *   body: string,                         // the batch as JSON (posthog.mjs)
 *   fetch: typeof globalThis.fetch,
 *   signal?: AbortSignal,                 // aborting it gives up at once (telemetry was turned off, Canopy is quitting)
 *   timeoutMs?: number, now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 * }} opts
 * @returns {Promise<{ result: 'ok'|'drop'|'split'|'wait'|'key'|'retry', status: number, retryAfterMs?: number|null, reason?: string }>}
 */
export async function postBatch({ endpoint, body, fetch, signal, timeoutMs = SEND_TIMEOUT_MS, now = Date.now, timers = globalThis }) {
  if (signal?.aborted) return { result: 'retry', status: 0, reason: 'stopped' };
  const stop = new AbortController();
  let timer = null;
  let why = 'network';
  // The request is raced against this, not just handed the abort signal: a fetch that ignores its signal still
  // can't hold the queue past the timeout.
  const gaveUp = new Promise((resolve) => {
    const give = (reason) => { why = reason; stop.abort(); resolve(null); };
    timer = timers.setTimeout(() => give('timeout'), timeoutMs);
    signal?.addEventListener('abort', () => give('stopped'), { once: true });
  });
  try {
    const request = Promise.resolve()
      // No cookies go with it and none are kept from the answer: the batch is all PostHog is told.
      .then(() => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit', signal: stop.signal }));
    request.catch(() => {}); // if the race is already lost, its late failure is nobody's problem
    const res = await Promise.race([request, gaveUp]);
    if (!res) return { result: 'retry', status: 0, reason: why };
    // The status says it all. The reply's body is not read: let go of it, so the connection is free again.
    try { res.body?.cancel?.()?.catch?.(() => {}); } catch { /* nothing to let go of */ }
    return answer(res, now());
  } catch (err) {
    return { result: 'retry', status: 0, reason: String(err?.name ?? why) };
  } finally {
    timers.clearTimeout(timer);
  }
}

let electronNet = null;
/**
 * How this process reaches the network. Inside Electron: Electron's own fetch, which follows the Mac's proxy
 * settings, and its word on whether the Mac is online. Anywhere else there is no network at all: the key Canopy
 * ships with is the real project's, and a test or a script that forgets to hand in a stand-in for PostHog must not
 * be able to reach it. (Whoever means to send from outside Electron passes its own `fetch` to createTelemetry.)
 * @returns {Promise<{ fetch: typeof globalThis.fetch, isOnline: () => boolean }>}
 */
export async function platformNet() {
  electronNet ??= import('electron')
    .then((m) => { const net = m?.net ?? m?.default?.net; return net && typeof net.fetch === 'function' ? net : null; })
    .catch(() => null);
  const net = await electronNet;
  return {
    fetch: net ? (url, init) => net.fetch(url, init) : () => Promise.reject(new Error('telemetry is only sent from inside Canopy')),
    isOnline: net && typeof net.isOnline === 'function' ? () => net.isOnline() : () => true,
  };
}

// Stand-ins for the telemetry tests (unit/telemetry-*.test.mjs): a folder that cleans up after itself, a clock and
// timers that only move when the test says, and a PostHog that answers what the test tells it to. Nothing here, and
// no test, ever reaches the real PostHog.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clean } from '../../telemetry/schema.mjs';

/** Where the tests' Canopy sends: a host and a key that are nobody's, in place of the ones Canopy ships with. */
export const TEST_HOST = 'https://posthog.test';
export const TEST_KEY = 'phc_test';
export const TEST_URL = `${TEST_HOST}/batch/`;
export const TEST_ENV = Object.freeze({ CANOPY_POSTHOG_HOST: TEST_HOST, CANOPY_POSTHOG_KEY: TEST_KEY });

// What a test leaves: the things to stop, then the folders to remove. One hook per test does both in that order,
// whichever was asked for first. Hooks run in the order they were added, so a folder removed by a hook of its own
// went before whatever was still writing into it had stopped, and the late write brought the folder back.
const leaving = new WeakMap();
function onLeave(t) {
  let left = leaving.get(t);
  if (!left) {
    left = { stops: [], dirs: [] };
    leaving.set(t, left);
    t.after(async () => {
      for (const stop of left.stops.splice(0)) { try { await stop(); } catch { /* the test reports its own failures */ } }
      for (const dir of left.dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });
  }
  return left;
}

/** A fresh folder, removed when the test ends, after everything `stopFirst` named has stopped. */
export function tempDir(t, name = 'canopy-telemetry-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), name));
  onLeave(t).dirs.push(dir);
  return dir;
}

/** Something that writes into a test's folder: stopped, and waited for, before the folder is removed. */
export function stopFirst(t, stop) { onLeave(t).stops.push(stop); }

/** Wait until `check()` is true (real time, for real file and promise work), or fail after `ms`. */
export async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * A clock that stands still until `advance(ms)`, with timers that fire as it passes them.
 * `start` is a local noon by default, so adding minutes never crosses midnight by accident.
 */
export function fakeClock(start = new Date(2026, 10, 16, 12, 0, 0).getTime()) {
  let at = start;
  let nextId = 1;
  const timers = new Map(); // id -> { due, fn }
  return {
    now: () => at,
    set(ms) { at = ms; },
    timers: {
      setTimeout(fn, ms) { const id = nextId++; timers.set(id, { due: at + (Number(ms) || 0), fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    /** How many timers are waiting. */
    get waiting() { return timers.size; },
    /** Move time forward, firing each timer that comes due, in order (those they set too). */
    advance(ms) {
      const end = at + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.due <= end).sort(([, a], [, b]) => a.due - b.due)[0];
        if (!next) break;
        timers.delete(next[0]);
        at = Math.max(at, next[1].due);
        next[1].fn();
      }
      at = end;
    },
  };
}

/**
 * A PostHog event read back as the event Canopy made it from: { id, event, ts, launch_id, props }. Most tests ask
 * what was sent, not how PostHog wants it written (that is unit/telemetry-posthog.test.mjs).
 */
function asTracked(e) {
  const p = e?.properties ?? {};
  return { id: e.uuid, event: e.event, ts: e.timestamp, launch_id: p.launch_id, props: clean(e.event, p) ?? {} };
}

/**
 * A stand-in for PostHog that records every request and answers from a script. `answers`: one entry per request,
 * the last one repeated. An entry is a status (200), `{ status, headers, body }` (a body, given as an object, is
 * sent as JSON, and the answer is then a real Response), 'network' (the fetch rejects), 'hang' (it never answers,
 * until aborted), or a function of the request's events returning any of those.
 *
 * Each request is kept as { url, init, body (parsed), bytes, signal, events }. `events` is what the batch held, in
 * Canopy's own shape, whether the body was PostHog's ({ api_key, batch }) or a test's plain { events }.
 */
export function fakeServer(...answers) {
  const script = answers.length ? [...answers] : [200];
  const server = {
    requests: [],
    /** The name of every event sent so far, in order. */
    get events() { return server.requests.flatMap((r) => r.events.map((e) => e.event)); },
    answer(...next) { script.splice(0, script.length, ...next); },
    fetch(url, init) {
      const body = JSON.parse(init.body);
      const events = Array.isArray(body.batch) ? body.batch.map(asTracked) : body.events ?? [];
      server.requests.push({ url, init, body, bytes: Buffer.byteLength(init.body), signal: init.signal, events });
      let a = script.length > 1 ? script.shift() : script[0];
      if (typeof a === 'function') a = a(events);
      if (a === 'network') return Promise.reject(new TypeError('fetch failed'));
      if (a === 'hang') {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      const { status, headers = {}, body: reply } = typeof a === 'number' ? { status: a } : a;
      if (reply !== undefined) return Promise.resolve(new Response(typeof reply === 'object' && !(reply instanceof ReadableStream) ? JSON.stringify(reply) : reply, { status, headers }));
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return Promise.resolve({ status, headers: { get: (k) => lower[String(k).toLowerCase()] ?? null } });
    },
  };
  return server;
}

/** An envelope as the queue holds it. */
export function envelope(n, props = {}) {
  const hex = n.toString(16).padStart(12, '0');
  return { id: `00000000-0000-4000-8000-${hex}`, event: 'feature_used', ts: new Date(Date.UTC(2026, 10, 16, 12, 0, n % 60)).toISOString(), launch_id: '11111111-1111-4111-8111-111111111111', props: { name: 'chat_new', ...props } };
}

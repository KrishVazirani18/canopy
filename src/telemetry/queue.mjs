// The durable queue: events wait here, in memory and in queue.jsonl, until PostHog has them.
//
// One event per line, appended as it is tracked, so a crash loses at most the line being written (and a line cut
// short is skipped on the next start). The file is rewritten whole only when events leave: sent, or dropped because
// the queue is full. Events leave by id, never by position, so an answer that comes back late (after the queue was
// cleared, or after its oldest events were dropped) removes exactly what it should and nothing else.
//
// What is read back from disk goes through the allowlist again (schema.cleanEnvelope): a line from an older Canopy,
// or one somebody edited, can't carry anything this version wouldn't send.
import { lineFile } from './disk.mjs';
import { cleanEnvelope } from './schema.mjs';

export const QUEUE_MAX_EVENTS = 10_000;
export const QUEUE_MAX_BYTES = 5 * 1024 * 1024;
// A full queue drops its oldest events down to this share of the limit, so the file is rewritten once per few
// hundred events while offline, not once per event.
const KEEP_WHEN_FULL = 0.9;

/**
 * @param {{ file: string, maxEvents?: number, maxBytes?: number, warn?: (kind: string, err?: unknown) => void }} opts
 */
export function createQueue({ file, maxEvents = QUEUE_MAX_EVENTS, maxBytes = QUEUE_MAX_BYTES, warn = () => {} }) {
  let items = []; // { event, line, bytes }, oldest first
  let bytes = 0;
  const disk = lineFile(file, { lines: () => items.map((i) => i.line), warn });

  const item = (event) => {
    const line = JSON.stringify(event);
    return { event, line, bytes: Buffer.byteLength(line) + 1 };
  };

  /** Drop the oldest events while over a limit. Returns how many went. */
  function makeRoom() {
    if (items.length <= maxEvents && bytes <= maxBytes) return 0;
    let n = 0;
    let left = bytes;
    while (n < items.length && (items.length - n > maxEvents * KEEP_WHEN_FULL || left > maxBytes * KEEP_WHEN_FULL)) left -= items[n++].bytes;
    items.splice(0, n);
    bytes = left;
    warn('the telemetry queue is full: its oldest events are dropped');
    return n;
  }

  return {
    /** Read what an earlier run left behind. Events tracked while this was reading stay, after the older ones. */
    async load() {
      const { rows, damaged } = await disk.read();
      const seen = new Set();
      const kept = [];
      let dirty = damaged;
      for (const row of rows) {
        const event = cleanEnvelope(row);
        if (!event || seen.has(event.id)) { dirty = true; continue; }
        seen.add(event.id);
        kept.push(item(event));
      }
      items = [...kept, ...items.filter((i) => !seen.has(i.event.id))];
      bytes = items.reduce((sum, i) => sum + i.bytes, 0);
      if (makeRoom() || dirty) disk.rewrite();
    },

    /** Add one event (already cleaned, with its id and time). */
    add(event) {
      const it = item(event);
      items.push(it);
      bytes += it.bytes;
      if (makeRoom()) disk.rewrite();
      else disk.append(it.line);
    },

    /** The oldest events, at most `maxCount` of them and `maxSize` bytes; always at least one when any wait. */
    batch(maxCount, maxSize) {
      const out = [];
      let size = 0;
      for (const it of items) {
        if (out.length >= maxCount || (out.length && size + it.bytes > maxSize)) break;
        out.push(it.event);
        size += it.bytes;
      }
      return out;
    },

    /** Forget these events (PostHog has them, or refused them for good). Ids no longer here are ignored. */
    remove(ids) {
      const gone = new Set(ids);
      const before = items.length;
      items = items.filter((i) => !gone.has(i.event.id));
      if (items.length === before) return;
      bytes = items.reduce((sum, i) => sum + i.bytes, 0);
      disk.rewrite();
    },

    /** Forget everything and delete the file. */
    clear() {
      items = [];
      bytes = 0;
      disk.rewrite();
    },

    get size() { return items.length; },
    get bytes() { return bytes; },
    /** Resolves once everything asked for so far is on disk (or was tried). */
    settled: () => disk.settled(),
  };
}

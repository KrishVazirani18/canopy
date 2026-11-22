// "See what's sent": the last 200 events exactly as they were recorded (the event, when, and its cleaned props;
// nothing else exists to show), kept across restarts in recent.jsonl. What is read back from disk goes through the
// allowlist again, so the list can only ever show what this version of Canopy would send.
import { ringFile } from './disk.mjs';
import { clean } from './schema.mjs';

export const RECENT_MAX = 200;

/** A row from disk as an entry, or null when it isn't one. */
function entry(row) {
  if (!row || typeof row !== 'object' || typeof row.ts !== 'string' || Number.isNaN(Date.parse(row.ts))) return null;
  const props = clean(row.event, row.props);
  return props ? { event: row.event, ts: row.ts, props } : null;
}

/**
 * @param {{ file: string, max?: number, warn?: (kind: string, err?: unknown) => void }} opts
 */
export function createRecent({ file, max = RECENT_MAX, warn = () => {} }) {
  const ring = ringFile(file, { max, check: entry, warn });
  return {
    load: () => ring.load(),
    /** @param {{ event: string, ts: string, props: object }} e already cleaned */
    add(e) { ring.push({ event: e.event, ts: e.ts, props: e.props }); },
    /** Newest first. Copies: the caller can do what it likes with them. */
    list: () => ring.rows().map((e) => ({ event: e.event, ts: e.ts, props: { ...e.props } })).reverse(),
    settled: () => ring.settled(),
  };
}

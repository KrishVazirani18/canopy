// The plan's usage limits, window side: each limit as the one line the ring's hover and Stats show,
// "5-hour limit · 42% used · resets 3:10 PM".
//
// The wording lives in the engine (src/core/limits.mjs, which imports nothing and does no I/O), so the row here
// and the two limit notices in the chat always name a limit the same way. This file only gives it types.
// Nothing here throws: a limit that cannot be read is an empty line, which the callers leave out.
import type { Limit } from './store';
// @ts-expect-error The engine's files are plain .mjs with no types: what is used of this one is typed below.
import { limitLine as engineLine } from '../../../src/core/limits.mjs';

const line: (limit: Limit, now?: number) => string = engineLine;

/** One limit as a row, or '' when there is nothing to say about it. */
export function limitLine(limit: Limit, now?: number): string {
  try { return line(limit, now) || ''; } catch { return ''; }
}

/** The rows for a chat's limits, in the order the chat reported them. Empty for a login with no plan limits. */
export function limitLines(limits: Limit[] | undefined, now?: number): { id: string; text: string }[] {
  return (Array.isArray(limits) ? limits : []).map((l) => ({ id: l.id, text: limitLine(l, now) })).filter((r) => r.text);
}

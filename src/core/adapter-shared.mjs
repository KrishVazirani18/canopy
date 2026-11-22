// What the two adapters share (adapter.mjs for Claude Code, codex-adapter.mjs for Codex): how much one event may
// carry, the one notice the window knows by its text, and the small helpers that shape text and describe a frame that
// could not be read. The window treats both makers' chats alike, so each of these has one copy here.
// Nothing here throws.

const KB = 1024;
export const TEXT_CAP = 128 * KB;
const TEXT_HEAD = 96 * KB;
const TEXT_TAIL = 32 * KB;
export const IMAGE_MAX = 4;
export const IMAGE_CHARS = 2 * KB * KB;
export const HISTORY_PICTURES = 4;       // tool results of a saved chat that keep their pictures: the latest ones
export const HISTORY_PICTURE_CHARS = 5 * KB * KB; // and how much those may weigh together
export const STRUCTURED_CAP = 256 * KB;
export const RAW_CAP = 8 * KB;
export const NOTICE_CAP = 2000;

export const COMPACTED = 'Conversation compacted'; // frozen: the renderer rewrites this notice by its text

export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// One line, short enough for a status row. The full text travels in its own field.
export function brief(text) {
  const line = String(text ?? '').trim().split('\n', 1)[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export function rawEvent(label, payload) {
  let s;
  try { s = JSON.stringify(payload); } catch { s = undefined; }
  // Whatever goes out must survive IPC, so a payload that cannot be serialized is described, not passed on.
  if (s === undefined) return { kind: 'raw', label, raw: String(payload), truncated: true };
  return s.length > RAW_CAP
    ? { kind: 'raw', label, raw: s.slice(0, RAW_CAP), truncated: true }
    : { kind: 'raw', label, raw: payload };
}

// The renderer rewrites notices that start with these two prefixes into fixed sentences, so text passed through from
// the maker's tool (`maker`: 'Claude Code' or 'Codex') must not collide with them.
export function notice(text, maker) {
  let t = String(text ?? '').replace(ANSI, '').trim();
  if (t.length > NOTICE_CAP) t = `${t.slice(0, NOTICE_CAP)}…`;
  return /^(Rate limited|Auth: )/.test(t) ? `${maker}: ${t}` : t;
}

export function capText(s) {
  if (s.length <= TEXT_CAP) return { text: s, truncated: false };
  let head = TEXT_HEAD;
  let tail = s.length - TEXT_TAIL;
  // Never cut a surrogate pair in half.
  if ((s.charCodeAt(head - 1) & 0xfc00) === 0xd800) head--;
  if ((s.charCodeAt(tail) & 0xfc00) === 0xdc00) tail++;
  return { text: `${s.slice(0, head)}\n\n… [${tail - head} characters not shown] …\n\n${s.slice(tail)}`, truncated: true };
}

// True when `v` would serialize to more than `limit` characters. Stops walking as
// soon as the answer is known, so a huge payload is never stringified just to be measured.
export function exceeds(v, limit) {
  let n = 0;
  const walk = (x, depth) => {
    if (typeof x === 'string') { n += x.length + 2; return; }
    if (x === null || typeof x !== 'object') { n += 8; return; }
    if (depth > 64) { n = limit + 1; return; }
    n += 2;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length && n <= limit; i++) walk(x[i], depth + 1);
      return;
    }
    for (const k of Object.keys(x)) {
      n += k.length + 4;
      walk(x[k], depth + 1);
      if (n > limit) return;
    }
  };
  walk(v, 0);
  return n > limit;
}

// A frame the adapter itself failed on: what went wrong, and the frame as far as it fits.
export function adapterError(err, m) {
  const error = String(err?.stack ?? err).slice(0, 2000);
  let frame;
  try { frame = JSON.stringify(m); } catch { frame = undefined; }
  if (frame === undefined) return [{ kind: 'raw', label: 'adapter-error', raw: { error } }];
  return [{ kind: 'raw', label: 'adapter-error', raw: frame.length > RAW_CAP ? { error, message: frame.slice(0, RAW_CAP), truncated: true } : { error, message: m } }];
}

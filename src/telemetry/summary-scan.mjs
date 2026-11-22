// The daily summary's reader: how many messages someone sent on each day, and from which tool, counted from the
// history Claude Code and Codex already keep on this Mac. Counts only. A row is looked at just long enough to tell
// what kind it is (a message, an interrupt, a reply, a tool result) and is then let go; no text is kept, returned,
// cached or logged.
//
// It runs in a process of its own (summary-child.mjs), so reading gigabytes of transcripts never holds up the window.
// Everything here is plain Node (no Electron), and also runs in Canopy's own process, in small steps, when that
// process can't be started (summary.mjs decides).
//
// What is a message:
//   Claude Code  a `user` row that isn't a tool result, isn't one Claude Code wrote itself (isMeta, a compaction
//                summary, a row copied in by a fork), and is yours: `origin.kind` says "human" when Claude Code
//                recorded it, otherwise the text doesn't open with "<" (command echoes, reminders, notifications).
//                "[Request interrupted…" rows are stops, not messages. A message typed while Claude was still
//                working is saved differently (a `queued_command` attachment) and counts too.
//   Codex        what the person submitted: a `user_message` event (older Codex) or a completed `UserMessage` item
//                (newer). A rollout with neither falls back to user-role response items, minus the context Codex
//                adds itself. `turn_aborted` events are the stops.
//
// Which tool a message came from is decided when the days are added up (see sourceOf), so the cache stays good as
// the list of Canopy's own chats grows.
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { SOURCES } from './schema.mjs';

const CACHE_VERSION = 1;
const MIN = 60_000, DAY = 24 * 60 * MIN;
const LONG_WAIT = 10 * MIN;             // a reply that took longer than this is a long wait
const CHUNK = 256 * 1024;               // read a quarter megabyte at a time: bigger reads are no faster and hold more memory
const CHUNK_INLINE = 128 * 1024;        // smaller steps in Canopy's own process, so no step is felt
const MAX_LINE = 32 * 1024 * 1024;      // a longer row is skipped unread (no message can be this big: the API refuses it)
const MAX_FILE_BYTES = 8 * 2 ** 30;     // one file is never read past this, however an archive unpacks
const MAX_FILES = 50_000;               // the listing stops here
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 6000;               // files remembered in the cache
const MAX_DAYS_PER_FILE = 120;          // days remembered per file (the newest)
const KEEP_DAYS = 40;                   // a file untouched for longer is forgotten; no summary reaches back that far
const SAVE_EVERY = 15_000;              // a long first scan saves what it has, so a quit doesn't lose it
export const DEFAULT_BUDGET = { bytes: 4 * 2 ** 30, ms: 60_000 };
const STOP = Symbol('stop');

const hasZstd = typeof zlib.createZstdDecompress === 'function';

// ---------- Dates (the Mac's own timezone) ----------

const pad = (n) => String(n).padStart(2, '0');
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local date of a moment, as YYYY-MM-DD. */
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A real YYYY-MM-DD date (2026-02-30 is not one). */
export function isDate(s) {
  const m = typeof s === 'string' ? DATE.exec(s) : null;
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3], 12);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

/** The date n days after (or before) a date. Counted at noon, so a clock change never lands on the wrong day. */
export function addDays(date, n) {
  const m = DATE.exec(date);
  return localDate(new Date(+m[1], +m[2] - 1, +m[3] + n, 12).getTime());
}

/** The first moment of a local date. */
export function dayStart(date) {
  const m = DATE.exec(date);
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

// Messages come in runs from the same day, so the last day's bounds answer most lookups without building a Date.
let memoFrom = 1, memoTo = 0, memoDate = '';
function dateOf(ms) {
  if (ms >= memoFrom && ms < memoTo) return memoDate;
  const date = localDate(ms), from = dayStart(date), to = dayStart(addDays(date, 1));
  memoDate = date; memoFrom = from; memoTo = to;
  return date;
}

/** What the cache's days were counted in: a move to another timezone moves messages between days. */
function zoneKey() {
  let name = '';
  try { name = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* the offsets below still tell zones apart */ }
  return `${name}/${new Date(2026, 0, 1).getTimezoneOffset()}/${new Date(2026, 6, 1).getTimezoneOffset()}`;
}

// ---------- Which tool ----------

// Probes and test runs live in temp folders; they aren't anyone's work.
const TEMP = /^\/(?:private|tmp|var\/folders)(?:\/|$)/;
// The same, told from a project folder's name, so a test harness's hundreds of transcripts are never opened.
const TEMP_SLUG = /^-(?:private-)?(?:tmp|var-folders)-/;
const IDE = /vscode|vs-code|vs_code|jetbrains|intellij|cursor|windsurf|zed|xcode|neovim|nvim|emacs|(?:^|[^a-z])ide(?:[^a-z]|$)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Where a Claude Code row was written, from its `entrypoint`: the terminal ('cli'), the desktop app
 * ('claude-desktop'), an editor extension ('claude-vscode'…), or 'open': the SDK and anything unknown, which is
 * Canopy's when Canopy knows the chat and another app's when it doesn't.
 */
function claudeBucket(entrypoint) {
  const e = String(entrypoint ?? '').toLowerCase();
  if (e === 'cli') return 'terminal';
  if (IDE.test(e)) return 'ide';
  if (e.includes('desktop')) return 'desktop';
  return 'open';
}

/** Where a Codex chat was started, from its `originator` (the name the app gave Codex when it connected). */
function codexBucket(originator, source) {
  const o = String(originator ?? '').toLowerCase();
  if (/^canopy(?:[^a-z]|$)/.test(o)) return 'canopy';
  if (IDE.test(o)) return 'ide';
  if (o.includes('desktop') || o.includes('chatgpt') || /^codex[ _-]?app$/.test(o)) return 'app';
  if (/^codex[ _-]?(?:cli|tui|exec)/.test(o)) return 'terminal';
  // Very old rollouts have no originator, only how Codex was started.
  if (!o && (source === 'cli' || source === 'exec')) return 'terminal';
  if (!o && source === 'vscode') return 'ide';
  return 'other';
}

const CLAUDE_SOURCES = { terminal: 'claude_terminal', desktop: 'claude_desktop', ide: 'claude_ide', canopy: 'claude_canopy' };
const CODEX_SOURCES = { canopy: 'codex_canopy', app: 'codex_app', terminal: 'codex_terminal', ide: 'codex_ide', other: 'codex_other' };

/**
 * The source a counted bucket lands in. `known`: the chat's id is one Canopy recorded.
 * Claude Code rows say where they were typed, so a terminal chat later opened in Canopy keeps its terminal messages
 * in the terminal; only rows that came through the SDK ('open') follow Canopy's list. A Codex rollout names its
 * app once, at the top, so a chat Canopy knows is Canopy's as a whole.
 */
function sourceOf(engine, bucket, known) {
  if (engine === 'codex') return known ? 'codex_canopy' : CODEX_SOURCES[bucket] ?? 'codex_other';
  return CLAUDE_SOURCES[bucket] ?? (known ? 'claude_canopy' : 'claude_other');
}

/** What a scan needs to know about Canopy besides its chat ids: its own chats folder, and the stretch before ids. */
function canopyRules({ chatsDirs, window }) {
  const dirs = (chatsDirs ?? []).map((d) => String(d).replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  const hashes = new Map();
  return {
    /** Inside Canopy's own chats folder (where chats with no project run). Mac volumes ignore case; so does this. */
    inChats(cwd) {
      const c = cwd.toLowerCase();
      return dirs.some((d) => c === d || c.startsWith(d + '/'));
    },
    /** Canopy was in use but not yet writing down its chat ids: an SDK chat from then is taken to be Canopy's. */
    beforeIds: (at) => !!window && at >= window.from && at < window.until,
    /** A folder as it is remembered: a short hash, so the cache can count distinct projects without their paths. */
    hash(cwd) {
      let h = hashes.get(cwd);
      if (!h) {
        if (hashes.size > 5000) hashes.clear();
        h = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
        hashes.set(cwd, h);
      }
      return h;
    },
  };
}

// ---------- One file's counts ----------

// A file's days: date -> bucket -> { n, stops, images, waits, projects }. Saved as [n, stops, images, waits, [hash…]].
function recOf(days, date, bucket) {
  let day = days.get(date);
  if (!day) { day = new Map(); days.set(date, day); }
  let rec = day.get(bucket);
  if (!rec) { rec = { n: 0, stops: 0, images: 0, waits: 0, projects: new Set() }; day.set(bucket, rec); }
  return rec;
}

function packDays(days) {
  const out = {};
  for (const date of [...days.keys()].sort().slice(-MAX_DAYS_PER_FILE)) {
    const day = {};
    for (const [bucket, r] of days.get(date)) {
      if (r.n || r.stops || r.images || r.waits) day[bucket] = [r.n, r.stops, r.images, r.waits, [...r.projects]];
    }
    if (Object.keys(day).length) out[date] = day;
  }
  return out;
}

// A row's time is only believed if it is a date someone could have used these tools on: a number where a date
// belongs, or a year 12345, must not become a day.
const EARLIEST = Date.UTC(2015, 0, 1), LATEST = Date.UTC(2100, 0, 1);
function when(v) {
  if (typeof v !== 'string' || v.length < 10 || v.length > 40) return NaN;
  const at = Date.parse(v);
  return at >= EARLIEST && at < LATEST ? at : NaN;
}

/** The time a row ends with. Claude Code writes `timestamp` after the message, so the last one is the row's own. */
function tailTime(text) {
  const i = text.lastIndexOf('"timestamp":"');
  if (i < 0) return NaN;
  const end = text.indexOf('"', i + 13);
  return end < 0 ? NaN : when(text.slice(i + 13, end));
}

/** The time a Codex row starts with. */
function headTime(head) {
  const m = /"timestamp":"([^"]{10,40})"/.exec(head);
  return m ? when(m[1]) : NaN;
}

/** Text and image of a Claude message's content, or null for a tool result. Nothing is kept past the caller. */
function claudeContent(c) {
  if (typeof c === 'string') return { texts: [c], image: false };
  if (!Array.isArray(c)) return null;
  const texts = [];
  let image = false;
  for (const b of c) {
    if (b?.type === 'tool_result') return null;
    if (b?.type === 'image') image = true;
    else if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  return { texts, image };
}

/** Typed by a person, going by the text alone: something that isn't Claude Code's own markup, or a picture. */
const typed = (texts, image) => texts.some((t) => t.trim() !== '' && !t.startsWith('<')) || (image && !texts.some((t) => t.trim() !== ''));

/** Reads one Claude Code transcript, row by row. */
function claudeScanner(rules) {
  const days = new Map();
  let entry = null, cwd = null;   // the last seen, for the rare row that doesn't say
  let pending = null;             // the message whose reply is still being written: { at, rec }
  let replyAt = 0;                // the latest row of that reply

  // A reply is over when the next turn starts; the wait was from the message to the reply's last row.
  const settle = () => {
    if (pending && replyAt - pending.at > LONG_WAIT) pending.rec.waits++;
    pending = null; replyAt = 0;
  };

  // Which bucket a row counts in, or null for a temp folder.
  const place = (r, at) => {
    if (typeof r.entrypoint === 'string') entry = r.entrypoint;
    if (typeof r.cwd === 'string') cwd = r.cwd;
    if (cwd && TEMP.test(cwd)) return null;
    let bucket = claudeBucket(entry);
    const inChats = cwd ? rules.inChats(cwd) : false;
    // Without the chat's id on Canopy's list, two things still say Canopy: its own chats folder, and an SDK chat
    // from the time before Canopy kept a list.
    if (bucket === 'open' && (inChats || (String(entry ?? '').startsWith('sdk') && rules.beforeIds(at)))) bucket = 'canopy';
    // Canopy's chats folder is "no project"; any other folder is one.
    return { bucket, project: cwd && !inChats ? rules.hash(cwd) : null };
  };

  const message = (r, at, image) => {
    settle();
    const where = place(r, at);
    if (!where) return;
    const rec = recOf(days, dateOf(at), where.bucket);
    rec.n++;
    if (image) rec.images++;
    if (where.project) rec.projects.add(where.project);
    pending = { at, rec };
  };

  const userRow = (r) => {
    // Rows Claude Code wrote itself, a helper's rows, and rows a fork copied from another chat (counted there).
    if (r.isMeta || r.isSidechain || r.isCompactSummary || r.isVisibleInTranscriptOnly || r.forkedFrom || r.toolUseResult !== undefined) return;
    const c = claudeContent(r.message?.content);
    if (!c) return;
    const at = when(r.timestamp);
    if (!Number.isFinite(at)) return;
    if (c.texts[0]?.startsWith('[Request interrupted')) {
      settle();
      const where = place(r, at);
      if (where) recOf(days, dateOf(at), where.bucket).stops++;
      return;
    }
    const kind = r.origin?.kind;
    if (kind ? kind === 'human' : typed(c.texts, c.image)) message(r, at, c.image);
    else settle(); // a notification or a command: not yours, but the reply before it is over
  };

  // A message typed while Claude was working is handed to the running turn instead of becoming a `user` row.
  const queuedRow = (r) => {
    const a = r.attachment;
    if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt' || r.isSidechain || r.forkedFrom) return;
    const c = claudeContent(a.prompt);
    if (!c) return;
    const at = when(r.timestamp ?? a.timestamp);
    if (!Number.isFinite(at)) return;
    const kind = a.origin?.kind;
    if (kind ? kind === 'human' : typed(c.texts, c.image)) message(r, at, c.image);
  };

  return {
    line(text, buf, a, b) {
      if (!text.includes('"type":"user"')) {
        if (text.includes('"type":"queued_command"')) {
          let r; try { r = JSON.parse(buf.utf8Slice(a, b)); } catch { return; }
          if (r?.type === 'attachment') queuedRow(r);
        } else if (pending && text.includes('"type":"assistant"') && !text.includes('"isSidechain":true')) {
          // Only the time is needed, so a reply's row (which can be large) is never parsed.
          const at = tailTime(text);
          if (at > replyAt) replyAt = at;
        }
        return;
      }
      // Tool results are most rows and the largest; these keys can't appear unescaped inside something typed.
      if (text.includes('"toolUseResult":') || text.includes('"type":"tool_result"')) return;
      let r; try { r = JSON.parse(buf.utf8Slice(a, b)); } catch { return; }
      if (!r || typeof r !== 'object') return;
      if (r.type === 'user') userRow(r);
      else if (r.type === 'attachment') queuedRow(r);
      else if (r.type === 'assistant' && pending && !r.isSidechain) { const at = when(r.timestamp); if (at > replyAt) replyAt = at; }
    },
    end() { settle(); return { days: packDays(days) }; },
  };
}

/** Reads one Codex rollout, row by row. Codex writes `timestamp`, `type` and the payload's type first, so a row's
 *  first few hundred characters say what it is; only the header and the rows that may be a message are parsed. */
function codexScanner(rules) {
  const days = new Map();     // date -> { a, b, c: [n, images], stops, waits }
  let first = true, id = null, bucket = 'other', project = null;
  let events = false;         // the rollout marks what the person submitted (a or b), so c isn't needed
  let pending = null, replyAt = 0;

  const dayOf = (at) => {
    const date = dateOf(at);
    let d = days.get(date);
    if (!d) { d = { a: [0, 0], b: [0, 0], c: [0, 0], stops: 0, waits: 0 }; days.set(date, d); }
    return d;
  };
  const settle = () => {
    if (pending && replyAt - pending.at > LONG_WAIT) pending.day.waits++;
    pending = null; replyAt = 0;
  };
  const activity = (head) => { if (pending) { const at = headTime(head); if (at > replyAt) replyAt = at; } };

  // The first row says which app started the chat and where. Returns false for a chat that isn't someone's own.
  const header = (r) => {
    const p = r?.type === 'session_meta' ? r.payload : null;
    if (!p || typeof p !== 'object') return true; // no header: the rows are still counted, as "other"
    if (typeof p.id === 'string') id = p.id;
    const origin = String(p.originator ?? '');
    // Helpers a chat spawned, and Claude Code chats Codex imported (counted as Claude Code's already).
    if (p.thread_source === 'subagent' || (p.source && typeof p.source === 'object' && 'subagent' in p.source)) return false;
    if (/claude/i.test(origin)) return false;
    const cwd = typeof p.cwd === 'string' ? p.cwd : null;
    if (cwd && TEMP.test(cwd)) return false;
    bucket = codexBucket(origin, p.source);
    project = cwd && !rules.inChats(cwd) ? rules.hash(cwd) : null;
    return true;
  };

  const prompt = (kind, buf, a, b) => {
    let r; try { r = JSON.parse(buf.utf8Slice(a, b)); } catch { return; }
    const p = r?.payload;
    if (!p || typeof p !== 'object') return;
    const at = when(r.timestamp);
    if (!Number.isFinite(at)) return;
    let ok = false, image = false;
    if (kind === 'a') {
      if (r.type !== 'event_msg' || p.type !== 'user_message') return;
      // Some versions also logged the instructions and context they add as user messages, with a kind of their own.
      if (typeof p.kind === 'string' && p.kind !== 'plain') return;
      image = (Array.isArray(p.images) ? p.images.length : 0) + (Array.isArray(p.local_images) ? p.local_images.length : 0) > 0;
      ok = typed([typeof p.message === 'string' ? p.message : ''], image);
    } else if (kind === 'b') {
      const item = p.item;
      if (r.type !== 'event_msg' || p.type !== 'item_completed' || item?.type !== 'UserMessage' || !Array.isArray(item.content)) return;
      image = item.content.some((x) => typeof x?.type === 'string' && x.type.includes('image'));
      ok = typed(item.content.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).slice(0, 1), image);
    } else {
      if (r.type !== 'response_item' || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return;
      const texts = p.content.filter((x) => x?.type === 'input_text' && typeof x.text === 'string').map((x) => x.text.trimStart());
      // The instructions and environment Codex sends ahead of a chat arrive as one user message; it isn't typed.
      if (texts.some((t) => t.startsWith('<environment_context'))) return;
      image = p.content.some((x) => x?.type === 'input_image');
      ok = texts.some((t) => t !== '' && !t.startsWith('<')) || image;
    }
    // Seeing either event at all means this Codex records what was submitted, typed or not: user-role items are
    // then never the measure.
    if (kind !== 'c') events = true;
    if (!ok) return;
    settle();
    const day = dayOf(at);
    day[kind][0]++;
    if (image) day[kind][1]++;
    pending = { at, day };
  };

  return {
    line(text, buf, a, b) {
      if (first) {
        first = false;
        let r = null; try { r = JSON.parse(buf.utf8Slice(a, b)); } catch { /* not a header: read on */ }
        if (r?.type === 'session_meta') return header(r) ? undefined : STOP;
      }
      const head = text.length > 600 ? text.slice(0, 600) : text;
      if (head.includes('"type":"response_item"')) {
        if (head.includes('"role":"user"')) return prompt('c', buf, a, b);
        if (!head.includes('"role":"developer"')) activity(head);
      } else if (head.includes('"type":"event_msg"')) {
        if (head.includes('"type":"user_message"')) return prompt('a', buf, a, b);
        if (head.includes('"type":"item_completed"')) {
          if (head.includes('"type":"UserMessage"')) return prompt('b', buf, a, b);
          activity(head);
        } else if (head.includes('"type":"turn_aborted"')) {
          const at = headTime(head);
          settle();
          // 'replaced' is a new message taking over a turn; only a stop the person asked for counts.
          if (Number.isFinite(at) && (!text.includes('"reason":"') || text.includes('"reason":"interrupted"'))) dayOf(at).stops++;
        } else if (head.includes('"type":"task_complete"') || head.includes('"type":"turn_complete"') || head.includes('"type":"agent_message"')) activity(head);
      }
      return undefined;
    },
    end() {
      settle();
      const out = new Map();
      for (const [date, d] of days) {
        // Old and new Codex mark a submitted message differently; a day written by both would count twice, so the
        // larger of the two stands.
        const [n, images] = events ? [Math.max(d.a[0], d.b[0]), Math.max(d.a[1], d.b[1])] : d.c;
        const rec = recOf(out, date, bucket);
        rec.n = n; rec.images = images; rec.stops = d.stops; rec.waits = d.waits;
        if (n && project) rec.projects.add(project);
      }
      return { days: packDays(out), id };
    },
  };
}

// ---------- Reading ----------

/** Cuts chunks into rows. A row is handed over as latin1 text (cheap, and enough to tell what it is) with the bytes
 *  it came from, for the few rows that are parsed. A row longer than MAX_LINE is dropped without being held. */
function splitter(onLine, stats) {
  let carry = null, carryLen = 0, dropping = false;
  return {
    push(buf, n) {
      const text = buf.latin1Slice(0, n);
      let pos = 0;
      while (pos < n) {
        const nl = text.indexOf('\n', pos);
        if (nl < 0) {
          // The row runs into the next chunk: keep a copy (the buffer is reused), unless it's already too long.
          if (!dropping) {
            carryLen += n - pos;
            if (carryLen > MAX_LINE) { carry = null; carryLen = 0; dropping = true; stats.longLines++; }
            else (carry ??= []).push(Buffer.from(buf.subarray(pos, n)));
          }
          return undefined;
        }
        let stop;
        if (dropping) dropping = false;
        else if (carry) {
          carry.push(Buffer.from(buf.subarray(pos, nl)));
          const whole = Buffer.concat(carry);
          carry = null; carryLen = 0;
          if (whole.length > MAX_LINE) stats.longLines++;
          else stop = onLine(whole.latin1Slice(0, whole.length), whole, 0, whole.length);
        } else if (nl > pos) stop = onLine(text.slice(pos, nl), buf, pos, nl);
        if (stop === STOP) return STOP;
        pos = nl + 1;
      }
      return undefined;
    },
    /** What's left has no newline yet: a last row, or one still being written (which won't parse and is skipped). */
    end() {
      if (carry && !dropping) { const whole = Buffer.concat(carry); onLine(whole.latin1Slice(0, whole.length), whole, 0, whole.length); }
      carry = null;
    },
  };
}

/**
 * Reads one file and returns its cache entry, or null when it can't be read now (it is tried again next time).
 * Reads only up to the size it had when listed, so a chat being written to is never chased.
 */
async function scanFile(f, rules, stats, chunk) {
  const scanner = f.engine === 'codex' ? codexScanner(rules) : claudeScanner(rules);
  // A row shaped in a way nobody foresaw must cost that row, not the chat.
  const split = splitter((text, buf, a, b) => { try { return scanner.line(text, buf, a, b); } catch { stats.oddRows++; return undefined; } }, stats);
  let failed = false;
  try {
    if (f.zst) {
      // Codex packs chats it is done with. The archive is unpacked as it is read, never to disk.
      const src = createReadStream(f.file, { highWaterMark: chunk });
      const unpack = zlib.createZstdDecompress({ chunkSize: chunk });
      src.on('error', (err) => unpack.destroy(err));
      src.pipe(unpack);
      let read = 0;
      try {
        for await (const part of unpack) {
          read += part.length; stats.bytes += part.length;
          if (split.push(part, part.length) === STOP || read > MAX_FILE_BYTES) break;
        }
      } finally { src.destroy(); unpack.destroy(); }
    } else {
      const fh = await open(f.file, 'r');
      try {
        const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunk, f.s)));
        const end = Math.min(f.s, MAX_FILE_BYTES);
        let pos = 0;
        while (pos < end) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
          if (!bytesRead) break; // the file got shorter under us
          pos += bytesRead; stats.bytes += bytesRead;
          if (split.push(buf, bytesRead) === STOP) break;
        }
      } finally { await fh.close(); }
    }
    split.end();
  } catch {
    stats.errors++;
    // A plain file that failed half way (gone, locked, a disk hiccup) is read again next time. A broken archive
    // will never read better, so what it gave is kept.
    if (!f.zst) return null;
    failed = true;
  }
  const { days, id } = scanner.end();
  stats.scanned++;
  return { m: f.m, s: f.s, e: f.engine, id: String(id ?? f.id).toLowerCase(), d: days, ...(failed && { x: 1 }) };
}

// ---------- Finding the files ----------

async function entries(dir) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } // missing or not ours to read
}

async function listed(file, engine, id, out, zst = false) {
  let st; try { st = await stat(file); } catch { return; }
  if (st.isFile()) out.push({ file, engine, id, m: Math.round(st.mtimeMs), s: st.size, zst });
}

/** Claude Code: <config>/projects/<folder>/<session>.jsonl. Helpers' transcripts sit in sub-folders and are left. */
async function listClaude(dirs, out) {
  const roots = new Set();
  for (const dir of dirs) {
    let root; try { root = await realpath(path.join(dir, 'projects')); } catch { continue; }
    if (roots.has(root)) continue; // two accounts sharing one history are read once
    roots.add(root);
    for (const p of await entries(root)) {
      if (!p.isDirectory() || TEMP_SLUG.test(p.name)) continue;
      for (const f of await entries(path.join(root, p.name))) {
        if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.startsWith('agent-')) continue;
        if (out.length >= MAX_FILES) return;
        await listed(path.join(root, p.name, f.name), 'claude', f.name.slice(0, -6), out);
      }
    }
  }
}

/** Codex: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl (or .jsonl.zst once packed), and archived chats, kept flat. */
async function listCodex(home, toDate, out, stats) {
  if (!home) return;
  const rollouts = async (dir) => {
    const names = (await entries(dir)).filter((f) => f.isFile()).map((f) => f.name);
    const plain = new Set(names.filter((n) => n.endsWith('.jsonl')));
    for (const name of names) {
      const zst = name.endsWith('.jsonl.zst');
      if (!zst && !name.endsWith('.jsonl')) continue;
      if (zst && plain.has(name.slice(0, -4))) continue; // caught mid-packing: the plain one is the whole chat
      if (zst && !hasZstd) { stats.unsupported++; continue; }
      if (out.length >= MAX_FILES) return;
      await listed(path.join(dir, name), 'codex', UUID.exec(name)?.[0] ?? name, out, zst);
    }
  };
  const numbered = async (dir, len) => (await entries(dir)).filter((e) => e.isDirectory() && e.name.length === len && /^\d+$/.test(e.name)).map((e) => e.name);
  const root = path.join(home, 'sessions');
  const last = addDays(toDate, 1); // a chat can't hold messages from before it began (a day's slack for the zone)
  for (const y of await numbered(root, 4)) {
    for (const m of await numbered(path.join(root, y), 2)) {
      for (const d of await numbered(path.join(root, y, m), 2)) {
        if (`${y}-${m}-${d}` <= last) await rollouts(path.join(root, y, m, d));
      }
    }
  }
  await rollouts(path.join(home, 'archived_sessions'));
}

// ---------- The cache ----------

const validEntry = (e) => !!e && typeof e === 'object' && Number.isFinite(e.m) && Number.isFinite(e.s)
  && (e.e === 'claude' || e.e === 'codex') && typeof e.id === 'string' && !!e.d && typeof e.d === 'object' && !Array.isArray(e.d);

/** The cache, or an empty one when it is missing, damaged, too big, or was counted under other rules. */
async function loadCache(file, key) {
  const empty = { v: CACHE_VERSION, key, files: {} };
  if (!file) return empty;
  try {
    if ((await stat(file)).size > MAX_CACHE_BYTES) return empty;
    const c = JSON.parse(await readFile(file, 'utf8'));
    if (c?.v !== CACHE_VERSION || c.key !== key || !c.files || typeof c.files !== 'object' || Array.isArray(c.files)) return empty;
    return { v: CACHE_VERSION, key, files: c.files };
  } catch { return empty; }
}

/** Where a process writes the cache before moving it into place. Named after the process, so summary.mjs can clear
 *  away what a scan it had to stop left half written. */
export const cacheTmp = (file, pid = process.pid) => `${file}.${pid}.tmp`;

/** Written beside itself and moved into place, so a quit mid-write leaves the old cache, never half of a new one. */
async function saveCache(file, cache, stats) {
  if (!file) return;
  const tmp = cacheTmp(file);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, file);
  } catch {
    stats.cacheErrors++;
    try { await unlink(tmp); } catch { /* nothing was written */ }
  }
}

/** Forgets files that are gone or long untouched, and the oldest beyond the cap. */
function prune(cache, existing, now) {
  const horizon = now - KEEP_DAYS * DAY;
  for (const [file, e] of Object.entries(cache.files)) {
    if (!existing.has(file) || !validEntry(e) || e.m < horizon) delete cache.files[file];
  }
  const names = Object.keys(cache.files);
  if (names.length > MAX_ENTRIES) {
    names.sort((a, b) => cache.files[a].m - cache.files[b].m);
    for (const file of names.slice(0, names.length - MAX_ENTRIES)) delete cache.files[file];
  }
}

// ---------- Adding it up ----------

// Whatever the cache holds, what comes out is a count.
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1e7) : 0);

/** The days in range, zeros included, shaped as `day_summary` props (without baseline and active minutes). */
function merge(found, ids, fromDate, toDate) {
  const days = new Map();
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const props = { date };
    for (const s of SOURCES) { props[`msgs_${s}`] = 0; props[`chats_${s}`] = 0; }
    Object.assign(props, { canopy_stops: 0, canopy_images: 0, canopy_long_waits: 0, projects_n: 0 });
    days.set(date, { props, chats: new Map(SOURCES.map((s) => [s, new Set()])), projects: new Set() });
  }
  for (const e of found) {
    const known = ids[e.e].has(e.id);
    for (const [date, buckets] of Object.entries(e.d)) {
      const day = days.get(date);
      if (!day || !buckets || typeof buckets !== 'object') continue;
      for (const [bucket, rec] of Object.entries(buckets)) {
        if (!Array.isArray(rec)) continue;
        const source = sourceOf(e.e, bucket, known);
        const n = count(rec[0]);
        day.props[`msgs_${source}`] += n;
        // A chat is the same chat in every file that holds part of it (Codex splits long ones across files).
        if (n) day.chats.get(source).add(e.id);
        if (source !== 'claude_canopy' && source !== 'codex_canopy') continue;
        day.props.canopy_stops += count(rec[1]);
        day.props.canopy_images += count(rec[2]);
        day.props.canopy_long_waits += count(rec[3]);
        if (n && Array.isArray(rec[4])) for (const h of rec[4]) if (typeof h === 'string') day.projects.add(h);
      }
    }
  }
  return [...days.values()].map(({ props, chats, projects }) => {
    for (const s of SOURCES) props[`chats_${s}`] = chats.get(s).size;
    props.projects_n = projects.size;
    for (const k of Object.keys(props)) if (k !== 'date') props[k] = count(props[k]);
    return props;
  });
}

// ---------- The scan ----------

const idSet = (v) => new Set([...(v ?? [])].filter((x) => typeof x === 'string').map((x) => x.toLowerCase()));

/**
 * Counts the days from `fromDate` to `toDate`. Takes plain data only (it is handed to another process as is):
 * { claudeDirs, codexHome, ids: { claude, codex }, fromDate, toDate, cacheFile, now, chatsDirs, window, budget, inline }.
 * Returns { days, stats }. stats.partial: the budget ran out before every changed file was read; what was read is
 * in the cache, so the next call carries on from there.
 */
export async function scan(job) {
  const started = Date.now();
  memoFrom = 1; memoTo = 0; // the Mac may have changed timezone since the last scan
  const stats = { files: 0, scanned: 0, cached: 0, left: 0, bytes: 0, ms: 0, errors: 0, longLines: 0, oddRows: 0, unsupported: 0, cacheErrors: 0, partial: false };
  const { fromDate, toDate } = job;
  const now = Number.isFinite(job.now) ? job.now : started;
  const budget = { ...DEFAULT_BUDGET, ...job.budget };
  const chunk = Number.isInteger(job.chunk) && job.chunk > 0 ? job.chunk : job.inline ? CHUNK_INLINE : CHUNK;
  const window = job.window && Number.isFinite(job.window.from) && Number.isFinite(job.window.until) && job.window.from < job.window.until
    ? { from: job.window.from, until: job.window.until } : null;
  const chatsDirs = (job.chatsDirs ?? []).filter((d) => typeof d === 'string' && d);
  const rules = canopyRules({ chatsDirs, window });
  // Everything a file's counts depend on besides the file itself. Canopy's chat ids are not here on purpose.
  const key = createHash('sha256').update(JSON.stringify([CACHE_VERSION, zoneKey(), chatsDirs.map((d) => d.toLowerCase()).sort(), window])).digest('hex').slice(0, 16);

  const cache = await loadCache(job.cacheFile, key);
  const all = [];
  await listClaude((job.claudeDirs ?? []).filter((d) => typeof d === 'string' && d), all);
  await listCodex(typeof job.codexHome === 'string' ? job.codexHome : null, toDate, all, stats);
  stats.files = all.length;

  // A row is written no earlier than its own time, so a file last touched before the first day holds nothing from
  // these days and is not opened. Newest first: if the budget runs out, the recent files are the ones done.
  const from = dayStart(fromDate) - MIN;
  const wanted = all.filter((f) => f.m >= from).sort((a, b) => b.m - a.m);
  const found = [];
  let dirty = false, saved = Date.now();
  for (const f of wanted) {
    const hit = cache.files[f.file];
    if (validEntry(hit) && hit.m === f.m && hit.s === f.s) { found.push(hit); stats.cached++; continue; }
    if (stats.bytes >= budget.bytes || Date.now() - started >= budget.ms) { stats.partial = true; stats.left++; continue; }
    const entry = await scanFile(f, rules, stats, chunk);
    if (!entry) continue;
    cache.files[f.file] = entry;
    found.push(entry);
    dirty = true;
    if (Date.now() - saved > SAVE_EVERY) { await saveCache(job.cacheFile, cache, stats); saved = Date.now(); }
  }

  const before = Object.keys(cache.files).length;
  prune(cache, new Set(all.map((f) => f.file)), now);
  if (dirty || Object.keys(cache.files).length !== before) await saveCache(job.cacheFile, cache, stats);

  const days = merge(found, { claude: idSet(job.ids?.claude), codex: idSet(job.ids?.codex) }, fromDate, toDate);
  stats.ms = Date.now() - started;
  return { days, stats };
}

/** Canopy's chats folder when the app doesn't say: where Electron keeps it for an app called Canopy. */
export const defaultChatsDir = () => path.join(os.homedir(), 'Library', 'Application Support', 'Canopy', 'chats');

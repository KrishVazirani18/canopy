// Today at a glance, for the strip at the bottom of Home: in quarter hours, how long Claude was working (any chat,
// its agents included; two at once count once, so a quarter hour never holds more than 15 minutes), what it cost, and
// how many chats. Read from the transcripts Claude Code writes, so it covers the whole day, not just since Canopy
// started; Home's live spans (`extra`) fill in what's running right now, between rows.
//
// Working time from a transcript: from each row to the next, unless the first ended a turn (Claude replied and
// stopped, or you interrupted it). A stretch longer than GAP between two rows isn't counted: that's a wait (an
// approval left open), not work. Cost: each reply priced as in chat-cost.mjs, at the time it landed.
//
// Files are read incrementally and remembered, so a refresh reads only new lines.
//
// Spend per account (the Usage tab, src/account-spend.mjs): the same replies at the same prices, each one handed to
// `attribute(chat, at)` to say whose it was. `dayActivity` buckets today that way; `spendByDay` does it for days
// already over, with a memory of its own (the one above only ever holds today).
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { replyCost } from './chat-cost.mjs';
import { configHome } from './core/env.mjs';

const MIN = 60_000, DAY = 24 * 60 * MIN;
export const SLOT = 15 * MIN;
const GAP = 10 * MIN;
const CHUNK = 8 * 1024 * 1024;
const TEMP = /^-(private-)?(tmp|var-folders)-/; // probes and test runs in temp folders aren't your work
const ENDS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

const files = new Map(); // file -> { size, rest, prev: { at, ends } | null, runs: [from, to][], costs: Map<id, { usd, at }> }

function addRun(runs, from, to) {
  const last = runs[runs.length - 1];
  if (last && from <= last[1]) last[1] = Math.max(last[1], to); else runs.push([from, to]);
}

function rowText(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('') : '';
}

const ROW = /"type":"(user|assistant|api-request)"/;

/** Where to start reading a transcript we haven't seen: rows are in time order, so walk back from the end a chunk at
 *  a time until a row from before `from`, and start at that row. A long chat touched today costs only today's part.
 *  0 if the whole file is newer (or no row can be dated). */
async function startAt(fh, size, from) {
  let end = size, win = CHUNK / 2;
  while (end > 0) {
    const pos = Math.max(0, end - win);
    const buf = Buffer.alloc(end - pos);
    await fh.read(buf, 0, buf.length, pos);
    const text = buf.toString('utf8');
    const first = pos === 0 ? 0 : text.indexOf('\n') + 1; // the line cut off at the chunk's start is read with the next one
    if (pos > 0 && first === 0) { win *= 2; continue; } // one line longer than the window (a pasted image): look wider
    // The chunk's earliest dated row decides: from before `from`, start there; otherwise keep walking back.
    let at = first;
    while (at < text.length) {
      const nl = text.indexOf('\n', at);
      const line = text.slice(at, nl < 0 ? text.length : nl);
      if (ROW.test(line) && line.includes('"timestamp"')) {
        let t = NaN; try { t = Date.parse(JSON.parse(line).timestamp); } catch {}
        if (Number.isFinite(t)) { if (t < from) return pos + Buffer.byteLength(text.slice(0, at)); break; }
      }
      if (nl < 0) break;
      at = nl + 1;
    }
    if (pos === 0) return 0;
    end = pos + Buffer.byteLength(text.slice(0, first));
    win = CHUNK / 2;
  }
  return 0;
}

/** Reads what's new in one transcript. `cache`: where what was read is remembered (Home's, unless the caller has its own). */
async function readFile(file, size, keepFrom, coldFrom = keepFrom, cache = files) {
  let f = cache.get(file);
  if (!f || size < f.size) { f = { size: 0, rest: '', prev: null, runs: [], costs: new Map() }; cache.set(file, f); }
  if (size > f.size) {
    const fh = await open(file, 'r');
    try {
      if (f.size === 0 && size > 1024 * 1024) f.size = await startAt(fh, size, coldFrom);
      while (f.size < size) {
        const len = Math.min(CHUNK, size - f.size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, f.size);
        f.size += len;
        const lines = (f.rest + buf.toString('utf8')).split('\n');
        f.rest = lines.pop() ?? ''; // a half-written last line waits for the next read
        for (const line of lines) {
          if (!line.includes('"timestamp"')) continue;
          if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"api-request"')) continue;
          let r; try { r = JSON.parse(line); } catch { continue; }
          if (r.type !== 'user' && r.type !== 'assistant' && r.type !== 'api-request') continue;
          const at = Date.parse(r.timestamp);
          if (!Number.isFinite(at)) continue;
          if (f.prev && !f.prev.ends && at >= f.prev.at && at - f.prev.at <= GAP) addRun(f.runs, f.prev.at, at);
          const m = r.message;
          const ends = r.type === 'assistant' ? ENDS.has(m?.stop_reason) : r.type === 'user' && rowText(m).startsWith('[Request interrupted');
          f.prev = { at, ends };
          // One reply is logged as several rows (one per block) with the same id; the last one has the final usage.
          if (r.type === 'assistant' && m?.usage) f.costs.set(m.id ?? r.uuid, { usd: replyCost(m.model, m.usage), at });
        }
      }
    } finally { await fh.close(); }
  }
  // Forget what's older than yesterday, so a long-lived chat doesn't pile up.
  if (f.runs.length && f.runs[0][1] < keepFrom) f.runs = f.runs.filter((x) => x[1] >= keepFrom);
  for (const [id, c] of f.costs) if (c.at < keepFrom) f.costs.delete(id);
  return f;
}

async function agentFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await agentFiles(p));
    else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** Every transcript written since `since`: each chat's own file and its agents' files, keyed by the chat. */
async function sources(root, since) {
  const out = []; // { file, size, chat }
  let projects = [];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory() || TEMP.test(p.name)) continue;
    const dir = path.join(root, p.name);
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const chat = e.name.slice(0, -6);
      const file = path.join(dir, e.name);
      let st; try { st = await stat(file); } catch { continue; }
      if (st.mtimeMs >= since) out.push({ file, size: st.size, chat });
      // A chat touched since yesterday may have agents still writing today (a workflow outlives its turn).
      if (st.mtimeMs >= since - DAY) {
        for (const a of await agentFiles(path.join(dir, chat, 'subagents'))) {
          try { const s = await stat(a); if (s.mtimeMs >= since) out.push({ file: a, size: s.size, chat }); } catch {}
        }
      }
    }
  }
  return out;
}

/** Joins overlapping [from, to] stretches. */
function union(runs) {
  const sorted = [...runs].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) { const last = out[out.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}

/**
 * Today, from `since` (local midnight) to `now`: { since, slot, slots: [{ busy, cost, chats }], busy, cost, chats }.
 * busy is in ms; slots run to the next midnight (later ones are empty). extra: [{ chat, from, to }] stretches known
 * to be work that the transcripts may not show yet.
 * attribute: (chat, at) => an account's id, for the reply that landed in that chat at that time. When given, the
 * answer also has `byAccount: { id: dollars }`, which adds up to `cost`: with one account the two are the same number.
 */
export function dayActivity(opts) {
  // One at a time: the reads share one memory of how far each file was read, and Home and the Usage tab both ask.
  const run = () => readDay(opts);
  const mine = reading.then(run, run);
  reading = mine.catch(() => {});
  return mine;
}
let reading = Promise.resolve();

async function readDay({ since, now = Date.now(), configDir = configHome(), extra = [], attribute }) {
  const end = new Date(since); end.setDate(end.getDate() + 1); // next midnight (a DST day has 92 or 100 quarter hours)
  const count = Math.round((end.getTime() - since) / SLOT);
  const slots = Array.from({ length: count }, () => ({ busy: 0, cost: 0, chats: new Set() }));
  const byChat = new Map(); // chat -> runs today
  const clip = (a, b) => [Math.max(a, since), Math.min(b, now)];
  const put = (chat, a, b) => { [a, b] = clip(a, b); if (b > a) { if (!byChat.has(chat)) byChat.set(chat, []); byChat.get(chat).push([a, b]); } };
  let cost = 0;
  const byAccount = typeof attribute === 'function' ? new Map() : null;
  for (const s of await sources(path.join(configDir, 'projects'), since)) {
    // A first read only needs today (and a turn running into it). A file that cannot be read (gone since it was
    // listed, or not ours to open: a transcript `sudo claude` wrote) is left out, and the day is drawn from the rest.
    let f; try { f = await readFile(s.file, s.size, since - DAY, since - GAP); } catch { continue; }
    for (const [a, b] of f.runs) if (b >= since) put(s.chat, a, b);
    for (const c of f.costs.values()) {
      if (c.at < since || c.at > now) continue;
      cost += c.usd;
      if (byAccount) { const id = accountOf(attribute, s.chat, c.at); byAccount.set(id, (byAccount.get(id) ?? 0) + c.usd); }
      const i = Math.floor((c.at - since) / SLOT);
      if (slots[i]) { slots[i].cost += c.usd; slots[i].chats.add(s.chat); }
    }
  }
  for (const x of extra) put(x.chat, x.from, x.to ?? now);
  // Who was working in each quarter hour.
  for (const [chat, runs] of byChat) {
    for (const [a, b] of union(runs)) for (let i = Math.floor((a - since) / SLOT); i < count && since + i * SLOT < b; i++) slots[i]?.chats.add(chat);
  }
  // How long anyone was: every chat's stretches together, so two at once count once.
  let busy = 0;
  for (const [a, b] of union([...byChat.values()].flat())) {
    busy += b - a;
    for (let i = Math.floor((a - since) / SLOT); i < count && since + i * SLOT < b; i++) {
      const s0 = since + i * SLOT;
      slots[i].busy += Math.min(b, s0 + SLOT) - Math.max(a, s0);
    }
  }
  const chats = new Set(slots.flatMap((s) => [...s.chats]));
  return {
    since, slot: SLOT, busy, cost, chats: chats.size, slots: slots.map((s) => ({ busy: s.busy, cost: s.cost, chats: s.chats.size })),
    ...(byAccount && { byAccount: Object.fromEntries(byAccount) }),
  };
}

// Whose reply it was. An `attribute` that cannot say (or throws) leaves it under '', which its caller reads as the
// login Claude Code finds on its own: a reply is never dropped from the count for want of a name.
function accountOf(attribute, chat, at) {
  try { const id = attribute(chat, at); return typeof id === 'string' ? id : ''; } catch { return ''; }
}

const NEVER_READABLE = new Set(['ENOENT', 'EACCES', 'EPERM']);

/** The local calendar day a moment falls on, as 'YYYY-MM-DD'. */
export function dayKey(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * Dollars per local day and account for days that are over: every reply that landed from `from` up to (not
 * including) `to`, priced as `dayActivity` prices today's. { 'YYYY-MM-DD': { accountId: dollars } }, with only the
 * days that had any. Reads the transcripts touched since `from` with a memory of its own, let go of when it is done.
 */
export async function spendByDay({ from, to, configDir = configHome(), attribute }) {
  const out = {};
  if (!(to > from)) return out;
  const cache = new Map();
  for (const s of await sources(path.join(configDir, 'projects'), from)) {
    // A file that is gone or not ours to open is left out for good. Anything else (too many files open, a disk
    // error) may pass: it is thrown, so the caller leaves these days open and reads them again.
    let f;
    try { f = await readFile(s.file, s.size, from - DAY, from - GAP, cache); }
    catch (err) { if (NEVER_READABLE.has(err?.code)) continue; throw err; }
    for (const c of f.costs.values()) {
      if (c.at < from || c.at >= to) continue;
      const day = (out[dayKey(c.at)] ??= {});
      const id = typeof attribute === 'function' ? accountOf(attribute, s.chat, c.at) : '';
      day[id] = (day[id] ?? 0) + c.usd;
    }
    cache.delete(s.file);
  }
  return out;
}

// Moving a chat to the other maker, host side.
//
// A move is, under the hood, a session of the other maker in the same folder that starts with what the chat was
// about. On screen it is one chat: the sessions it ran on make one thread, listed once in the sidebar (by the session
// it runs on now, the head) and shown as one transcript, with "Canopy switched from <model> → <model>" where the
// maker changed. A thread has at most one session of each maker: the first move opens a new one, and every move
// after that goes back to the session that maker already has, which is told what happened while it was away.
//
//   prepare(move, about)     a first move was asked for: read the chat, write the files, keep a pending record
//   back(move, about)        a move back to the session the other maker already has: what it is told, and the link
//   thread(id)               the thread a chat is in: its sessions in order, the switches, and the head (null: none)
//   hidden()                 every chat in a thread except its head: never listed on their own
//   sessionOpts(o)           what the new chat's session is created with (and a reopened moved chat's)
//   bind(key, sid)           the new chat is open: the pending record is that chat's
//   forget(sid)              that chat was let go before its first message: its pending record goes with it
//   onEvent(ev, entry)       the new chat got its id: the record is saved, the chat takes the old one's name, and
//                            the host hears of it (`onMoved`), so the old chat's model can be told should you go back
//   notes(which, events)     a chat's history as its whole thread: each session's part, a switch line between them
//   sessionTitle(row)        a Claude chat's title for the sidebar, never the digest its first message carried
//
// Contract:
//  - Nothing here throws. `prepare` resolves to { ok: true, key } or { ok: false, message }; everything else gives
//    back what it was given when something is wrong.
//  - The files live under `dir` (the app's own data folder), one folder a move: `digest.md` and `transcript.md`,
//    folder 0700, files 0600. The newest 200 folders are kept. Nothing under ~/.claude or ~/.codex is written.
//  - Saved links: state.json key `handoffs`, { [new chat's id]: { from, to, cwd, at, key, tokens, counts } }, the
//    newest 500. A move costs nothing until the new chat's first message: until then its record is only in memory.
//    A move back is saved at once, under `back-<time>-<id>`, with `to.id` (the session gone back to) and `back: true`.
//  - Parts of a thread are told apart by time: a session's events from when the thread switched to it until it
//    switched away. An event with no time goes with the one before it.
import { mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildDigest, exportTranscript, stripHandoff, tokensOf } from './core/handoff.mjs';

const THREAD_CURSOR = 'canopy-thread:';
/** A long chat's "Show earlier" cursor, with where the part already shown begins (`hi`), so the next page fits. */
export const threadCursor = (hi, cursor) => `${THREAD_CURSOR}${hi}:${cursor}`;
/** { hi, cursor } from a cursor threadCursor made; null for any other. */
export function readThreadCursor(c) {
  if (typeof c !== 'string' || !c.startsWith(THREAD_CURSOR)) return null;
  const rest = c.slice(THREAD_CURSOR.length);
  const i = rest.indexOf(':');
  const hi = Number(rest.slice(0, i));
  return i > 0 && Number.isFinite(hi) ? { hi, cursor: rest.slice(i + 1) } : null;
}
import { redact as plainRedact } from './core/redact.mjs';

export const HANDOFF_FOLDERS_MAX = 200;
export const HANDOFF_LINKS_MAX = 500;
export const MOVE_BUSY = 'Wait for this chat to finish, then move it.';
export const MOVE_EMPTY = 'There is nothing in this chat to move yet.';
export const MOVE_FAILED = 'This chat could not be moved.';
// The five modes both makers have: any other (Claude Code's "don't ask") is carried as Ask.
const SHARED_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' ? v : '');
const name = (v, n = 120) => str(v).replace(/\s+/g, ' ').trim().slice(0, n);
const engineName = (e) => (e === 'codex' ? 'codex' : 'claude');

/** What a chat with no name and no first message is listed as. `sessionTitle` answers it for "no title", so whoever
 *  needs to tell "untitled" from a real title compares against this, never against the words. */
export const UNTITLED = 'Untitled chat';

/** A Claude chat's title as the sidebar shows it: its name, else its summary or first message without a digest it carried. */
export function sessionTitle(s) {
  return str(s?.customTitle) || stripHandoff(s?.summary) || stripHandoff(s?.firstPrompt) || UNTITLED;
}

export class Handoffs {
  /**
   * @param {{
   *   load: () => object | null | undefined,        the saved links (state.json's `handoffs`)
   *   save: (links: object) => unknown,
   *   dir: string | (() => string),                 where the folders go
   *   historyOf: (sessionId: string, cwd: string) => Promise<object[]>,     a session's own Canopy events (no thread)
   *   chatOf?: (sessionId: string, cwd: string) => Promise<{ engine?: string, title?: string } | null> | object | null,
   *   gitState?: (cwd: string) => Promise<{ branch?: string | null, status?: string | null } | null>,
   *   rename?: (chat: { id: string, engine: string, cwd: string, sid: string }, title: string) => unknown,
   *   onChange?: () => void,                        a link was saved: the chat lists may be read again
   *   onMoved?: (record: object, id: string) => void,   a move took effect: the new chat `id` got its first message
   *   redact?: (s: string) => string, log?: (msg: string) => void, now?: () => number,
   * }} opts
   */
  constructor({ load, save, dir, historyOf, chatOf, gitState, rename, onChange, onMoved, redact, log, now } = {}) {
    this.load = typeof load === 'function' ? load : () => null;
    this.save = typeof save === 'function' ? save : () => {};
    this.dirOf = typeof dir === 'function' ? dir : () => dir;
    this.historyOf = typeof historyOf === 'function' ? historyOf : async () => [];
    this.chatOf = typeof chatOf === 'function' ? chatOf : async () => null;
    this.gitState = typeof gitState === 'function' ? gitState : async () => null;
    this.rename = typeof rename === 'function' ? rename : () => {};
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onMoved = typeof onMoved === 'function' ? onMoved : () => {};
    this.redact = typeof redact === 'function' ? redact : plainRedact;
    this.log = typeof log === 'function' ? log : () => {};
    this.now = typeof now === 'function' ? now : Date.now;
    this.pending = new Map(); // key -> { record, text, sid }
    this.bySid = new Map();   // the new chat's sid -> key
    this.texts = new Map();   // key -> the digest, once read back from its file
  }

  #links() { const l = this.load(); return isPlain(l) ? l : {}; }
  #folder(key) { return path.join(String(this.dirOf() ?? ''), key); }
  #file(key) { return path.join(this.#folder(key), 'transcript.md'); }

  /**
   * A move was asked for. `move`: { from, fromModel, toModel } from the window (the old chat's id and the two model
   * names as they are on screen). `about`: { cwd, busy, mode, toEngine } from the host.
   * @returns {Promise<{ ok: true, key: string } | { ok: false, message: string }>}
   */
  async prepare(move, about) {
    try {
      const from = str(move?.from);
      const cwd = str(about?.cwd);
      if (!from || !cwd || !this.dirOf()) return { ok: false, message: MOVE_FAILED };
      if (about?.busy) return { ok: false, message: MOVE_BUSY };
      const own = await this.historyOf(from, cwd);
      // A chat that is a thread already carries all of it.
      const events = Array.isArray(own) && this.thread(from) ? await this.notes({ sessionId: from, cwd }, own) : own;
      if (!Array.isArray(events) || !events.some((e) => e?.kind === 'user-text' || e?.kind === 'assistant-text')) {
        // Nothing was said in it, or it could not be read (that is one warning in the list): either way there is nothing to carry.
        return { ok: false, message: Array.isArray(events) && !events.some((e) => e?.kind === 'notice' && e.level === 'warn') ? MOVE_EMPTY : MOVE_FAILED };
      }
      const [chat, git] = await Promise.all([
        Promise.resolve(this.chatOf(from, cwd)).catch(() => null),
        Promise.resolve(this.gitState(cwd)).catch(() => null),
      ]);
      const at = this.now();
      let key = `${at.toString(36)}-${from.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'chat'}`;
      for (let n = 2; this.pending.has(key) || existsSync(this.#folder(key)); n++) key = `${key.split('.')[0]}.${n}`;
      const fromModel = name(move?.fromModel, 80);
      const title = name(chat?.title, 200);
      const mode = SHARED_MODES.has(about?.mode) ? about.mode : 'default';
      const about2 = { fromModel, cwd, file: this.#file(key), mode, branch: git?.branch ?? null, status: git?.branch ? git.status ?? '' : null };
      const digest = buildDigest(events, about2, { redact: this.redact });
      const transcript = exportTranscript(events, { title: title || 'Chat', fromModel, cwd, id: from }, { redact: this.redact });
      const folder = this.#folder(key);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700).catch(() => {});
      await writeFile(path.join(folder, 'digest.md'), `${digest.text}\n`, { mode: 0o600 });
      await writeFile(this.#file(key), transcript, { mode: 0o600 });
      const record = {
        from: { id: from, engine: engineName(chat?.engine), title, model: fromModel },
        to: { engine: engineName(about?.toEngine), model: name(move?.toModel, 80) },
        cwd, at, key, tokens: digest.tokens, counts: digest.counts,
      };
      this.pending.set(key, { record, text: digest.text, sid: null });
      this.texts.set(key, digest.text);
      this.#prune().catch(() => {});
      return { ok: true, key };
    } catch (err) {
      this.log(`handoff: ${err?.message ?? err}`);
      return { ok: false, message: MOVE_FAILED };
    }
  }

  // The newest folders are kept (their names start with the time), and so is any a chat is still waiting to use.
  async #prune() {
    const root = String(this.dirOf() ?? '');
    const names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const extra = names.slice(0, Math.max(0, names.length - HANDOFF_FOLDERS_MAX)).filter((n) => !this.pending.has(n));
    for (const n of extra) { this.texts.delete(n); await rm(path.join(root, n), { recursive: true, force: true }).catch(() => {}); }
  }

  /**
   * What a chat's session is created with, on top of the rest: the digest, the folder of the two files (so opening
   * the transcript never asks) and the old chat's name for a chat being moved into (`o.handoffKey`); what happened
   * while it was away for a session gone back to (`o.handBack`, the text back() gave); the folder alone for a
   * moved chat being reopened (`o.resume`); nothing for any other chat.
   */
  sessionOpts(o) {
    try {
      const p = o?.handoffKey ? this.pending.get(o.handoffKey) : null;
      if (p) return { handoff: { text: p.text }, additionalDirectories: [this.#folder(o.handoffKey)], ...(p.record.from.title && { title: p.record.from.title }) };
      // A session gone back to (back()): what happened while it was away goes with its next message.
      const back = typeof o?.handBack === 'string' && o.handBack ? { handoff: { text: o.handBack, back: true } } : {};
      const link = o?.resume ? this.#links()[o.resume] : null;
      if (link?.key && existsSync(this.#folder(link.key))) return { ...back, additionalDirectories: [this.#folder(link.key)] };
      return back;
    } catch (err) { this.log(`handoff: ${err?.message ?? err}`); }
    return {};
  }

  /** The chat a move opened is `sid`. */
  bind(key, sid) {
    const p = this.pending.get(key);
    if (!p || typeof sid !== 'string' || !sid) return false;
    const before = this.bySid.get(sid);
    if (before && before !== key) this.pending.delete(before);
    p.sid = sid;
    this.bySid.set(sid, key);
    return true;
  }

  /** A chat was closed. If it was moved into and never got a message, its pending record goes with it. */
  forget(sid) {
    const key = this.bySid.get(sid);
    if (!key) return false;
    this.bySid.delete(sid);
    return this.pending.delete(key);
  }

  /**
   * Every chat event passes through. On the new chat's `init` with an id its pending record becomes a saved link, and
   * the chat takes the old chat's name. A chat whose conversation started over under a new id (its first message was
   * edited, or it was gone from disk) keeps its link under the new id.
   */
  onEvent(ev, entry) {
    try {
      if (!isPlain(ev)) return;
      const id = str(ev.sessionId);
      if (ev.kind === 'meta' && id && str(ev.previousSessionId) && (ev.supersedes === ev.previousSessionId || entry?.engine === 'codex')) {
        // Wherever the old id is named (the key of the chat moved into, either end of a link), the new one is.
        const prev = ev.previousSessionId;
        const links = this.#links();
        let changed = false;
        const next = {};
        for (const [k, r] of Object.entries(links)) {
          let key = k, rec = r;
          if (k === prev && !links[id]) { key = id; changed = true; }
          if (isPlain(rec) && rec.from?.id === prev) { rec = { ...rec, from: { ...rec.from, id } }; changed = true; }
          if (isPlain(rec) && rec.to?.id === prev) { rec = { ...rec, to: { ...rec.to, id } }; changed = true; }
          next[key] = rec;
        }
        if (changed) { this.save(next); this.onChange(); }
        return;
      }
      if (ev.kind !== 'init' || !id) return;
      const key = this.bySid.get(ev.sid);
      const p = key ? this.pending.get(key) : null;
      if (!p) return;
      this.pending.delete(key);
      this.bySid.delete(ev.sid);
      const links = Object.entries({ ...this.#links(), [id]: p.record }).sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0)).slice(-HANDOFF_LINKS_MAX);
      this.save(Object.fromEntries(links));
      const title = p.record.from.title;
      if (title) Promise.resolve().then(() => this.rename({ id, engine: p.record.to.engine, cwd: p.record.cwd, sid: ev.sid }, title)).catch((err) => this.log(`handoff: naming the chat failed: ${err?.message ?? err}`));
      this.onChange();
      this.onMoved(p.record, id);
    } catch (err) { this.log(`handoff: ${err?.message ?? err}`); }
  }

  // ---- the thread ----

  // Every link as an edge from one session to the next, oldest first.
  #edges(links = this.#links()) {
    return Object.entries(links)
      .filter(([, r]) => isPlain(r) && str(r.from?.id))
      .map(([key, r]) => ({ key, from: r.from.id, to: str(r.to?.id) || key, at: Number(r.at) || 0, r }))
      .filter((e) => e.to !== e.from)
      .sort((a, b) => a.at - b.at);
  }

  /**
   * The thread the chat `id` is in, or null when it was never moved. `segs`: its sessions in the order they ran,
   * each with when it began (`from`) and ended (`until`), so a session gone back to is there twice. `edges[i]` is
   * the switch between `segs[i]` and `segs[i + 1]`. `head`: the session it runs on now.
   */
  thread(id, edges = this.#edges()) {
    if (!str(id)) return null;
    const ids = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of edges) if (ids.has(e.from) !== ids.has(e.to)) { ids.add(e.from); ids.add(e.to); grew = true; }
    }
    const mine = edges.filter((e) => ids.has(e.from));
    if (!mine.length) return null;
    const segs = [{ id: mine[0].from, engine: engineName(mine[0].r.from?.engine), from: -Infinity, until: mine[0].at, cwd: str(mine[0].r.cwd) }];
    mine.forEach((e, i) => segs.push({ id: e.to, engine: engineName(e.r.to?.engine), from: e.at, until: mine[i + 1]?.at ?? Infinity, cwd: str(e.r.cwd) }));
    return { ids, edges: mine, segs, head: segs.at(-1).id };
  }

  /** Every chat that is in a thread but is not its head: the sidebar and search list the thread once, by its head. */
  hidden() {
    const out = new Set();
    try {
      const edges = this.#edges();
      const seen = new Set();
      for (const e of edges) {
        if (seen.has(e.from)) continue;
        const t = this.thread(e.from, edges);
        for (const id of t?.ids ?? []) { seen.add(id); if (id !== t.head) out.add(id); }
      }
    } catch (err) { this.log(`handoff: ${err?.message ?? err}`); }
    return out;
  }

  // The thread's sessions' events between `lo` and `hi`, in the order they ran, with a switch line between parts.
  // `own`: the events of the session `sessionId`, already read. The rest are read here, once each.
  async #compose(t, sessionId, own, { lo = -Infinity, hi = Infinity } = {}) {
    const read = new Map(sessionId ? [[sessionId, own]] : []);
    const times = new Map();
    for (const s of t.segs) times.set(s.id, (times.get(s.id) ?? 0) + 1);
    const out = [];
    for (const [i, s] of t.segs.entries()) {
      const e = i > 0 ? t.edges[i - 1] : null;
      if (e && e.at >= lo && e.at < hi) out.push(switchLine(e));
      const a = Math.max(s.from, lo), b = Math.min(s.until, hi);
      if (a >= b) continue;
      if (!read.has(s.id)) read.set(s.id, await Promise.resolve(this.historyOf(s.id, s.cwd)).catch(() => []));
      const evs = Array.isArray(read.get(s.id)) ? read.get(s.id) : [];
      // A session that ran once, read whole, is all its part: nothing is told apart by time.
      const whole = times.get(s.id) === 1 && lo === -Infinity && hi === Infinity;
      let at = -Infinity;
      for (const ev of evs) {
        if (!isPlain(ev) || ev.kind === 'earlier' || ev.kind === 'handoff') continue;
        if (typeof ev.at === 'number' && Number.isFinite(ev.at)) at = ev.at;
        if (whole || (at >= a && at < b)) out.push(ev);
      }
    }
    return out;
  }

  /**
   * A move back to the session the other maker already has in this thread. `move`: { from, to, fromModel, toModel }
   * (the session on screen, the one to go back to, the two names on screen). `about`: { cwd, busy, mode }.
   * Resolves to { ok: true, text } with what that session is told when its next message goes (null: nothing
   * happened while it was away), or { ok: false, message }. The link is saved at once. Going straight back from
   * a session nothing was said in takes the switch back instead.
   * @returns {Promise<{ ok: true, text: string | null } | { ok: false, message: string }>}
   */
  async back(move, about) {
    try {
      const from = str(move?.from), to = str(move?.to), cwd = str(about?.cwd);
      if (!from || !to || !cwd) return { ok: false, message: MOVE_FAILED };
      if (from === to) return { ok: true, text: null };
      if (about?.busy) return { ok: false, message: MOVE_BUSY };
      const t = this.thread(from);
      if (!t || !t.ids.has(to)) return { ok: false, message: MOVE_FAILED };
      const links = this.#links();
      const last = t.edges.at(-1);
      if (last && last.from === to && last.to === from) {
        const own = await Promise.resolve(this.historyOf(from, cwd)).catch(() => []);
        if (!(Array.isArray(own) ? own : []).some((e) => e?.kind === 'user-text' && Number(e.at) >= last.at)) {
          const next = { ...links };
          delete next[last.key];
          this.save(next);
          this.onChange();
          return { ok: true, text: null };
        }
      }
      // What happened since the session gone back to last ran.
      const since = [...t.segs].reverse().find((s) => s.id === to)?.until ?? Infinity;
      const events = await this.#compose(t, '', [], { lo: since });
      let text = null;
      if (events.some((e) => e?.kind === 'user-text' || e?.kind === 'assistant-text')) {
        const git = await Promise.resolve(this.gitState(cwd)).catch(() => null);
        const mode = SHARED_MODES.has(about?.mode) ? about.mode : 'default';
        text = buildDigest(events, { fromModel: name(move?.fromModel, 80), cwd, mode, branch: git?.branch ?? null, status: git?.branch ? git.status ?? '' : null, back: true }, { redact: this.redact }).text;
      }
      const at = Math.max(this.now(), (last?.at ?? 0) + 1);
      const fromSeg = t.segs.at(-1);
      const toSeg = t.segs.find((s) => s.id === to);
      const record = {
        from: { id: from, engine: fromSeg?.engine ?? 'claude', title: '', model: name(move?.fromModel, 80) },
        to: { id: to, engine: toSeg?.engine ?? 'claude', model: name(move?.toModel, 80) },
        cwd, at, back: true,
      };
      const all = Object.entries({ ...links, [`back-${at.toString(36)}-${to.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`]: record })
        .sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0)).slice(-HANDOFF_LINKS_MAX);
      this.save(Object.fromEntries(all));
      this.onChange();
      return { ok: true, text };
    } catch (err) {
      this.log(`handoff: ${err?.message ?? err}`);
      return { ok: false, message: MOVE_FAILED };
    }
  }

  async #digest(key) {
    if (this.texts.has(key)) return this.texts.get(key);
    let text = '';
    try { text = (await readFile(path.join(this.#folder(key), 'digest.md'), 'utf8')).trim(); } catch { text = ''; }
    this.texts.set(key, text);
    if (this.texts.size > 50) this.texts.delete(this.texts.keys().next().value);
    return text;
  }

  /**
   * A chat's history as its whole thread: each session's part in the order they ran, with a switch line
   * ({ kind: 'handoff', dir: 'switch' }) where the maker changed. A chat moved here that has had no message yet
   * (`sid`) is its old chat's thread with the switch at the end, marked `pending`. A chat that was never moved is
   * its own events, as they are. A long chat read from its newest turns (led by `{ kind: 'earlier' }`) shows the
   * thread from its first turn shown on, and its cursor says so (threadCursor); a page of earlier turns is given
   * with `hi`, where the part already shown begins.
   * @param {{ sessionId?: string | null, sid?: string | null, cwd?: string | null, hi?: number }} which
   * @param {object[]} events
   * @returns {Promise<object[]>}
   */
  async notes(which, events) {
    const list = Array.isArray(events) ? events : [];
    try {
      const sessionId = str(which?.sessionId);
      const waiting = !sessionId && which?.sid ? this.pending.get(this.bySid.get(which.sid)) : null;
      const base = sessionId || str(waiting?.record?.from?.id);
      const t = base ? this.thread(base) : null;
      let out = list;
      if (t) {
        const own = sessionId ? list : [];
        const marker = own.find((e) => isPlain(e) && e.kind === 'earlier') ?? null;
        const first = marker ? own.find((e) => isPlain(e) && e.kind !== 'earlier' && Number.isFinite(e.at))?.at : undefined;
        const lo = Number.isFinite(first) ? first : -Infinity;
        const hi = Number.isFinite(which?.hi) ? which.hi : Infinity;
        out = await this.#compose(t, sessionId, own, { lo, hi });
        if (marker) out.unshift({ ...marker, cursor: Number.isFinite(first) ? threadCursor(first, marker.cursor) : marker.cursor });
      } else if (waiting) {
        out = await Promise.resolve(this.historyOf(base, waiting.record.cwd)).catch(() => []);
        out = Array.isArray(out) ? out : [];
      }
      if (waiting) out = [...out, switchLine({ from: base, to: '', at: waiting.record.at, r: waiting.record }, true)];
      return out;
    } catch (err) {
      this.log(`handoff: ${err?.message ?? err}`);
      return list;
    }
  }
}

// The line where a thread changed maker: "Canopy switched from <model> → <model>". `pending`: the chat switched to
// has had no message yet (and has no id).
function switchLine(e, pending = false) {
  const r = e.r ?? {};
  return {
    kind: 'handoff', dir: 'switch', at: e.at,
    from: { id: e.from, engine: engineName(r.from?.engine), model: str(r.from?.model) },
    to: { id: e.to || null, engine: engineName(r.to?.engine), model: str(r.to?.model) },
    ...(pending && { pending: true }),
  };
}

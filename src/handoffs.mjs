// Moving a chat to the other maker, host side.
//
// A move is a new chat in the same folder that starts with what the old one was about. This file reads the old
// chat, has core/handoff.mjs build the digest and the transcript (plain code, no model), writes the two files,
// hands the new chat's session its digest, and remembers which chat continued which, so each can say so:
// "Continued from …" at the top of the new chat, "Continued in …" at the end of the old one.
//
//   prepare(move, about)     a move was asked for: read the old chat, write the files, keep a pending record
//   sessionOpts(o)           what the new chat's session is created with (and a reopened moved chat's)
//   bind(key, sid)           the new chat is open: the pending record is that chat's
//   forget(sid)              that chat was let go before its first message: its pending record goes with it
//   onEvent(ev, entry)       the new chat got its id: the record is saved, the chat takes the old one's name, and
//                            the host hears of it (`onMoved`), so the old chat's model can be told should you go back
//   notes(which, events)     a chat's history with its "Continued…" lines
//   sessionTitle(row)        a Claude chat's title for the sidebar, never the digest its first message carried
//
// Contract:
//  - Nothing here throws. `prepare` resolves to { ok: true, key } or { ok: false, message }; everything else gives
//    back what it was given when something is wrong.
//  - The files live under `dir` (the app's own data folder), one folder a move: `digest.md` and `transcript.md`,
//    folder 0700, files 0600. The newest 200 folders are kept. Nothing under ~/.claude or ~/.codex is written.
//  - Saved links: state.json key `handoffs`, { [new chat's id]: { from, to, cwd, at, key, tokens, counts } }, the
//    newest 500. A move costs nothing until the new chat's first message: until then its record is only in memory.
import { mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildDigest, exportTranscript, stripHandoff, tokensOf } from './core/handoff.mjs';
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
   *   historyOf: (sessionId: string, cwd: string) => Promise<object[]>,     a chat's Canopy events
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
      const events = await this.historyOf(from, cwd);
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
   * the transcript never asks) and the old chat's name for a chat being moved into (`o.handoffKey`); the folder
   * alone for a moved chat being reopened (`o.resume`); nothing for any other chat.
   */
  sessionOpts(o) {
    try {
      const p = o?.handoffKey ? this.pending.get(o.handoffKey) : null;
      if (p) return { handoff: { text: p.text }, additionalDirectories: [this.#folder(o.handoffKey)], ...(p.record.from.title && { title: p.record.from.title }) };
      const link = o?.resume ? this.#links()[o.resume] : null;
      if (link?.key && existsSync(this.#folder(link.key))) return { additionalDirectories: [this.#folder(link.key)] };
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
        const links = this.#links();
        const link = links[ev.previousSessionId];
        if (link && !links[id]) { const next = { ...links, [id]: link }; delete next[ev.previousSessionId]; this.save(next); this.onChange(); }
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

  async #digest(key) {
    if (this.texts.has(key)) return this.texts.get(key);
    let text = '';
    try { text = (await readFile(path.join(this.#folder(key), 'digest.md'), 'utf8')).trim(); } catch { text = ''; }
    this.texts.set(key, text);
    if (this.texts.size > 50) this.texts.delete(this.texts.keys().next().value);
    return text;
  }

  /**
   * A chat's history with its "Continued…" lines: a `handoff` event first for a chat that was moved into (saved, or
   * still waiting for its first message: `sid`), and one last for each chat it was moved on to, oldest first.
   * @param {{ sessionId?: string | null, sid?: string | null }} which
   * @param {object[]} events
   * @returns {Promise<object[]>}
   */
  async notes(which, events) {
    const list = Array.isArray(events) ? events : [];
    try {
      const sessionId = str(which?.sessionId);
      const links = this.#links();
      const waiting = !sessionId && which?.sid ? this.pending.get(this.bySid.get(which.sid)) : null;
      const rec = (sessionId && isPlain(links[sessionId]) ? links[sessionId] : null) ?? waiting?.record ?? null;
      const out = [];
      if (rec?.from?.id) {
        const digest = waiting?.text ?? await this.#digest(rec.key);
        out.push({
          kind: 'handoff', dir: 'from', chat: { id: rec.from.id, title: rec.from.title || UNTITLED, cwd: rec.cwd, engine: engineName(rec.from.engine) },
          model: str(rec.from.model), at: rec.at, digest, tokens: digest ? tokensOf(digest) : rec.tokens ?? 0,
          file: existsSync(this.#file(rec.key)) ? this.#file(rec.key) : null, toModel: str(rec.to?.model), counts: rec.counts ?? null,
        });
      }
      out.push(...list);
      if (sessionId) {
        const on = Object.entries(links).filter(([, r]) => isPlain(r) && r.from?.id === sessionId).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
        for (const [id, r] of on) {
          out.push({ kind: 'handoff', dir: 'to', chat: { id, title: r.from.title || UNTITLED, cwd: r.cwd, engine: engineName(r.to?.engine) }, model: str(r.to?.model), at: r.at });
        }
      }
      return out;
    } catch (err) {
      this.log(`handoff: ${err?.message ?? err}`);
      return list;
    }
  }
}

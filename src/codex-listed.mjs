// The Codex chats Canopy did not start: what Codex itself lists (chats from the Codex app, the terminal and other
// app-server clients), kept so the sidebar can show them beside the chats started here.
//
//   LISTED_SOURCES   where a listed chat may have been started. Never a one-shot run or a sub-agent's thread
//   CodexListed      the list (state.json, key `codexListed`), its sidebar rows, and the catch-up with Codex
//
// Which chats are kept, by the chat's own folder:
//   one of your projects                 listed under that project, at the project's own path (Codex can spell a
//                                        folder another way, /private/tmp for /tmp: a project is known by the path
//                                        Canopy has for it and by its real path)
//   under ~/Documents/Codex/             where the Codex app keeps chats with no project: listed under Canopy's own
//                                        no-project list ("Chats"), marked `loose`. The chat still runs in its own
//                                        folder: `folderOf` says which
//   anywhere else                        not listed, exactly as a Claude chat in a folder that is not a project
//
// Contract:
//  - Nothing here throws. `rows`, `has`, `get`, `folderOf` and `titleOf` read memory only; `refresh` resolves to
//    whether the list changed, and a page Codex could not give changes nothing.
//  - The list is saved, so `has(id)` is true for these chats the moment the app starts: it is what says "open this
//    id on Codex", and a chat clicked before the first catch-up must not be opened as a Claude chat.
//  - This is Codex's list, not Canopy's: a chat that leaves it (archived or deleted in Codex) leaves these rows at
//    the next catch-up. There is no evidence rule here, unlike Canopy's own chats (codex-chats.mjs).
//  - A row's second line is the chat's last reply, which the list does not carry. It is asked for behind the list,
//    a few chats a catch-up, newest first, and kept until the chat changes. Until then it is the first message.
//  - Nothing under ~/.codex is read or written: everything goes through the app-server's index (a few ms a page).
//  - Only your project folders are looked at on disk, for their real path. A listed chat's own folder is never
//    touched: looking into Documents, or any folder macOS guards, just to draw the sidebar could put a permission
//    prompt in front of the user.
import { realpath as fsRealpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewOf } from './last-active.mjs';

export const CODEX_LISTED_MAX = 500;
export const LISTED_SOURCES = Object.freeze(['cli', 'vscode', 'appServer']);
export const LINES_PER_REFRESH = 10;  // second lines asked for in one catch-up
const LIST_PAGE = 100;                // Codex hands out at most 100 chats a page, whatever is asked for
const LIST_PAGES = 10;                // how far the catch-up reads: the newest 1,000 chats

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' && v ? v : null);
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const firstLine = (s) => clip(String(s ?? '').split('\n').find((l) => l.trim()) ?? '', 160) || null;
const sameDir = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || path.resolve(a) === path.resolve(b));
const soft = async (fn) => { try { return await fn(); } catch { return null; } };

/** The last thing the model said in a turn (its final answer when it is marked), as one line, or null. */
function replyLine(turn) {
  const said = (Array.isArray(turn?.items) ? turn.items : []).filter((i) => i?.type === 'agentMessage' && typeof i.text === 'string' && i.text.trim());
  const last = said.findLast((i) => i.phase === 'final_answer') ?? said.at(-1);
  return last ? previewOf(last.text) : null; // plain words, as Claude chats get: no ### or **[…](…) in the sidebar
}

export class CodexListed {
  /**
   * @param {{
   *   load: () => object | null | undefined,       the saved list (state.json's `codexListed`)
   *   save: (list: object) => unknown,             save it
   *   service?: object,                            a CodexService (core/codex-host.mjs): listThreads, call
   *   folders?: () => string[],                    your project folders, as Canopy spells them
   *   home?: string | (() => string),              the home folder (default: the user's)
   *   onChange?: () => void,                       the rows changed
   *   realpath?: (p: string) => Promise<string>,   (tests) how a project folder's real path is found
   *   log?: (msg: string) => void, now?: () => number
   * }} opts
   */
  constructor({ load, save, service, folders, home, onChange, realpath, log, now } = {}) {
    this.loadFn = typeof load === 'function' ? load : () => null;
    this.saveFn = typeof save === 'function' ? save : () => {};
    this.service = service ?? null;
    this.foldersFn = typeof folders === 'function' ? folders : () => [];
    this.home = home;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.realpathFn = typeof realpath === 'function' ? realpath : fsRealpath;
    this.logFn = typeof log === 'function' ? log : () => {};
    this.now = typeof now === 'function' ? now : Date.now;
    this.list = null;   // id -> { cwd, dir? | loose?, title, firstLine, lastLine, lineFor, updatedAt, createdAt, source }, read on first use
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a call */ } }

  #entries() {
    if (this.list) return this.list;
    const out = new Map();
    try {
      const raw = this.loadFn();
      if (isPlain(raw)) for (const [id, e] of Object.entries(raw)) if (id && isPlain(e) && str(e.cwd)) out.set(id, { ...e });
    } catch (err) { this.log(`codex listed: could not read the saved list: ${err?.message ?? err}`); }
    this.list = out;
    return out;
  }

  #save() {
    try { Promise.resolve(this.saveFn(Object.fromEntries(this.#entries()))).catch((err) => this.log(`codex listed: save failed: ${err?.message ?? err}`)); }
    catch (err) { this.log(`codex listed: save failed: ${err?.message ?? err}`); }
    try { this.onChange(); } catch { /* an observer never breaks the list */ }
  }

  /** The project folders asked about, without repeats or blanks. */
  folders() {
    try { const got = this.foldersFn(); return [...new Set((Array.isArray(got) ? got : []).filter((d) => typeof d === 'string' && d))]; }
    catch { return []; }
  }

  /** One word for "these folders": the catch-up runs again as soon as it changes (a project was added or removed). */
  foldersKey() { return this.folders().join('\n'); }

  /** Where the Codex app keeps chats that belong to no project. */
  looseRoot() {
    let home = null;
    try { home = typeof this.home === 'function' ? this.home() : this.home; } catch { home = null; }
    return path.join(str(home) ?? os.homedir(), 'Documents', 'Codex');
  }

  /** Is this one of the chats Codex lists? */
  has(id) { return typeof id === 'string' && !!id && this.#entries().has(id); }

  /** What is remembered about one chat (a copy), or null. */
  get(id) { const e = this.has(id) ? this.#entries().get(id) : null; return e ? { ...e } : null; }

  /** The folder a chat with no project runs in (its own, under ~/Documents/Codex), or null for any other chat. */
  folderOf(id) { const e = this.has(id) ? this.#entries().get(id) : null; return e?.loose === true ? str(e.cwd) : null; }

  /** The name on the chat's row, or null. */
  titleOf(id) { const e = this.has(id) ? this.#entries().get(id) : null; return e ? str(e.title) ?? (clip(e.firstLine, 80) || null) : null; }

  /** A chat was renamed in Canopy: the row says so at once (Codex is told by the caller). */
  setTitle(id, title) {
    const e = this.has(id) ? this.#entries().get(id) : null;
    const name = clip(title, 200);
    if (!e || !name || e.title === name) return false;
    e.title = name;
    this.#save();
    return true;
  }

  get size() { return this.#entries().size; }

  /**
   * Sidebar rows for these folders (every folder when none are given), in the shape `sessions:list` returns.
   * `chatsDir` is Canopy's own no-project folder: a `loose` chat is listed there, and only when that folder is
   * asked about. `skip(id)` leaves a chat out (Canopy's own row for the same chat wins).
   */
  rows(dirs, { chatsDir, skip } = {}) {
    const out = [];
    try {
      const want = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d) : null;
      const chats = str(chatsDir);
      for (const [id, e] of this.#entries()) {
        if (typeof skip === 'function' && skip(id) === true) continue;
        let cwd = null;
        // A chat from another app with no project is left out: Recents holds only chats started in Canopy. Continuing
        // one in Canopy makes it Canopy's own (codex-chats.mjs), and then it is listed.
        if (e.loose === true) continue;
        if (str(e.dir)) cwd = want ? want.find((d) => sameDir(d, e.dir)) ?? null : e.dir;
        if (!cwd) continue;
        out.push({
          id, title: str(e.title) ?? (clip(e.firstLine, 80) || 'Untitled chat'), updated: Number.isFinite(e.updatedAt) && e.updatedAt > 0 ? e.updatedAt : this.now(),
          branch: str(e.branch), cwd, preview: str(e.lastLine) ?? str(e.firstLine), engine: 'codex', ...(e.loose === true && { loose: true }),
        });
      }
    } catch (err) { this.log(`codex listed: ${err?.message ?? err}`); }
    return out;
  }

  // Every page of Codex's list for the three sources, newest first. Null when a page could not be read.
  async #listed() {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < LIST_PAGES; page++) {
      const r = await soft(() => this.service.listThreads({ limit: LIST_PAGE, sourceKinds: [...LISTED_SOURCES], ...(cursor && { cursor }) }));
      if (!r?.ok || !Array.isArray(r.threads)) return null;
      seen.push(...r.threads);
      cursor = str(r.nextCursor);
      if (!cursor || !r.threads.length) break;
    }
    return seen;
  }

  /**
   * Catch up with Codex's list, then fill in a few second lines. Resolves to whether the rows changed.
   * `skip(id)`: chats whose second line is not needed (Canopy's own rows have their own).
   */
  async refresh({ skip } = {}) {
    try {
      if (!this.service || typeof this.service.listThreads !== 'function') return false;
      const folders = this.folders();
      const seen = await this.#listed();
      if (!seen) return false;
      // Every way Codex may spell one of your project folders -> the project as Canopy spells it: the path as it is,
      // its real path, and (macOS keeps /tmp, /var and /etc under /private) the real path without that prefix.
      const projects = new Map();
      const spell = (p, d) => { if (!projects.has(p)) projects.set(p, d); };
      for (const d of folders) {
        const plain = path.resolve(d);
        const real = await Promise.resolve().then(() => this.realpathFn(d)).then((r) => str(r) ?? plain, () => plain);
        spell(plain, d); spell(real, d);
        if (real.startsWith('/private/')) spell(real.slice('/private'.length), d);
      }
      const root = path.resolve(this.looseRoot());
      const before = this.#entries();
      const next = new Map();
      for (const t of seen) {
        if (next.size >= CODEX_LISTED_MAX) break;
        const id = str(t?.id);
        if (!id || next.has(id) || !LISTED_SOURCES.includes(t.source) || !str(t.cwd)) continue;
        const at = path.resolve(t.cwd);
        const dir = projects.get(at) ?? null;
        const loose = !dir && (at === root || at.startsWith(root + path.sep));
        if (!dir && !loose) continue;
        const was = before.get(id);
        const updatedAt = Number.isFinite(t.updatedAt) ? t.updatedAt : null;
        next.set(id, {
          cwd: t.cwd, ...(dir ? { dir } : { loose: true }), title: clip(t.title, 200) || null, firstLine: firstLine(t.preview),
          // The last reply is kept, and counts as asked for, until the chat changes.
          lastLine: str(was?.lastLine), lineFor: was && was.lineFor === updatedAt ? was.lineFor : null,
          updatedAt, createdAt: Number.isFinite(t.createdAt) ? t.createdAt : null, branch: str(t.branch), source: t.source,
        });
      }
      let changed = JSON.stringify([...next]) !== JSON.stringify([...before]);
      this.list = next;
      if (changed) this.#save();
      if (await this.#fillLines(skip)) changed = true;
      return changed;
    } catch (err) { this.log(`codex listed: refresh failed: ${err?.message ?? err}`); return false; }
  }

  // The last reply of the newest few chats that have none on record for their current state.
  async #fillLines(skip) {
    if (typeof this.service.call !== 'function') return false;
    const due = [...this.#entries()].filter(([id, e]) => e.lineFor !== e.updatedAt && !(typeof skip === 'function' && skip(id) === true))
      .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0)).slice(0, LINES_PER_REFRESH);
    let changed = false;
    for (const [id, e] of due) {
      const r = await soft(() => this.service.call('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary' }));
      if (!r?.ok) continue; // asked again at the next catch-up
      if (this.#entries().get(id) !== e) continue; // the list moved on while Codex answered
      e.lastLine = replyLine(Array.isArray(r.result?.data) ? r.result.data[0] : null); // none (a stopped turn): the row keeps the first message
      e.lineFor = e.updatedAt;
      changed = true;
    }
    if (changed) this.#save();
    return changed;
  }
}

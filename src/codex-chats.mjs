// Codex chats, host side: what the main process remembers about the Codex chats started in Canopy, and the calls
// it makes for them outside a live chat.
//
//   engineFor(...)      which engine a chat runs on: a saved chat by this list, a new one by the model row picked
//   CodexChats          the list itself (state.json, key `codexChats`), sidebar rows, a transcript's events,
//                       renaming, and the OpenAI half of the model picker. With `listFrom(...)` it also answers
//                       for the chats Codex lists that Canopy did not start (codex-listed.mjs): the Codex app's
//                       and the terminal's
//
// Contract:
//  - Nothing here throws. Methods that ask Codex resolve to a value the caller can use as it is: `history` to a
//    list of events (a failure is one notice in that list; a chat too long to read whole starts with an `earlier`
//    marker that says where its older turns begin), `earlier` to { events } or { error }, `rename` to { ok },
//    `models` to rows (empty when Codex is missing, signed out or not answering).
//  - `rows` and `has` read memory only, so the sidebar never waits on a process. What Codex itself knows (a name
//    given elsewhere, a chat archived or deleted in Codex) is caught up with in the background, at most once a
//    minute (at once when your project folders change), and never while there is nothing to catch up on: no chat
//    of Canopy's own and no list of Codex's to read.
//  - A chat started in Canopy is recorded when its first turn starts, which is when Codex writes it to disk. A chat
//    Codex lists becomes one of Canopy's own the first time it is opened here (its `init`), keeping its name, its
//    place in the sidebar and, for a chat with no project, the folder it runs in. A chat in both lists is shown
//    once, as Canopy's own row. Nothing under ~/.codex is read or written here; everything goes through the
//    app-server.
//  - A chat leaves the rows only on evidence that it is gone (Codex lists it as archived, or says it is not on
//    disk), never because Codex's list happens not to hold it. Even then it is not deleted from the list: it is
//    marked `gone`, and comes back if Codex lists it again.
//  - A chat begun on an API key pasted into Canopy is remembered as such (`account`, the account's id: never a
//    key). Codex keeps a chat on the provider it began on, so that is what says how the chat can be opened again
//    (core/accounts-codex.mjs `chatAccount`). A chat begun on Codex's own login has no such field.
import path from 'node:path';
import { adaptHistory } from './core/codex-adapter.mjs';
import { previewOf } from './last-active.mjs';

export const CODEX_CHATS_MAX = 500;
const LIST_PAGE = 100;                // Codex hands out at most 100 chats a page, whatever is asked for
const LIST_PAGES = 10;                // how far the catch-up reads: the newest 1,000 chats
const REFRESH_EVERY_MS = 60_000;
const GONE_AFTER_MS = 10 * 60_000;    // a chat this new is not judged: Codex may still be writing it down
const READS_PER_REFRESH = 5;          // unlisted chats looked up one by one in a single catch-up
const MODELS_FRESH_MS = 5 * 60_000;
const MODELS_RETRY_MS = 15_000;       // after a failed ask, how soon the next one may go out
const EARLIER_PAGE = 100;             // turns in one "Show earlier" page; a cursor longer than CURSOR_MAX is not one of Codex's
const CURSOR_MAX = 4096;
const MODELS_WAIT_MS = 5_000;         // the first ask is waited for this long, then answered empty and caught up later
// What stands in for Codex's word on who is signed in while a pasted key is in use: OpenAI's models run on that key,
// whatever Codex's own login is doing, so nothing about that login is asked.
const ON_A_KEY = Object.freeze({ ok: true, signedIn: true, requiresAuth: false, account: Object.freeze({ type: 'apiKey' }) });

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' && v ? v : null);
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const sameDir = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || path.resolve(a) === path.resolve(b));
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
/** A call to the helper that can neither throw nor reject: null stands for "Codex could not say". */
const soft = async (fn) => { try { return await fn(); } catch { return null; } };

/**
 * Which engine a chat runs on. A saved chat is whatever it was started as (`has` says whether it is one of
 * Canopy's Codex chats); the hint is ignored. A new chat follows the hint, and falls back to Claude when Codex is
 * not on this Mac or is known to be signed out (`signedIn` false; null, "not asked yet", does not count): a chat
 * that could not run is never opened. The caller tells the window which one it got.
 * @param {{ resume?: string | null, engine?: string, has?: (id: string) => boolean, codexPath?: string | null, signedIn?: boolean | null }} o
 * @returns {'claude' | 'codex'}
 */
export function engineFor({ resume, engine, has, codexPath, signedIn } = {}) {
  try {
    if (resume) return typeof has === 'function' && has(resume) === true ? 'codex' : 'claude';
    return engine === 'codex' && typeof codexPath === 'string' && codexPath && signedIn !== false ? 'codex' : 'claude';
  } catch { return 'claude'; }
}

/** One row of Codex's model list as the window gets it (see codexModelInfo in core/codex-host.mjs). */
function pickerRow(m) {
  if (!isPlain(m) || !str(m.value) || m.hidden === true) return null;
  return {
    value: m.value, displayName: str(m.displayName) ?? m.value, description: typeof m.description === 'string' ? m.description : '',
    engine: 'codex', maker: 'openai',
    supportsEffort: m.supportsEffort === true, supportedEffortLevels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => typeof e === 'string') : [],
    defaultEffort: str(m.defaultEffort), supportsFastMode: m.supportsFastMode === true, isDefault: m.isDefault === true,
  };
}

export class CodexChats {
  /**
   * @param {{
   *   load: () => object | null | undefined,       the saved list (state.json's `codexChats`)
   *   save: (list: object) => unknown,             save it
   *   service?: object,                            a CodexService (core/codex-host.mjs): Codex as it finds itself
   *   keyService?: object,                         a CodexService launched for the account in use, for when that is
   *                                                a pasted key: the models that key is offered come from it
   *   keyInUse?: () => boolean,                    is the account OpenAI's new chats use a key pasted into Canopy?
   *   installed?: () => boolean,                   is Codex on this Mac right now? (default: yes)
   *   onChange?: () => void,                       the sidebar's rows changed
   *   onModels?: (rows: object[]) => void,         the model list changed after it was last handed out
   *   log?: (msg: string) => void, now?: () => number, timings?: object (tests)
   * }} opts
   */
  constructor({ load, save, service, keyService, keyInUse, installed, onChange, onModels, log, now, timings, listed } = {}) {
    this.loadFn = typeof load === 'function' ? load : () => null;
    this.saveFn = typeof save === 'function' ? save : () => {};
    this.service = service ?? null;
    this.keyService = keyService ?? null;
    this.keyInUseFn = typeof keyInUse === 'function' ? keyInUse : () => false;
    this.installedFn = typeof installed === 'function' ? installed : () => true;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onModels = typeof onModels === 'function' ? onModels : () => {};
    this.logFn = typeof log === 'function' ? log : () => {};
    this.now = typeof now === 'function' ? now : Date.now;
    this.t = { refreshEvery: REFRESH_EVERY_MS, goneAfter: GONE_AFTER_MS, modelsFresh: MODELS_FRESH_MS, modelsRetry: MODELS_RETRY_MS, modelsWait: MODELS_WAIT_MS, ...(isPlain(timings) ? timings : {}) };
    this.list = null;            // id -> { cwd, title, preview, createdAt, lastPromptAt, model, account?, gone? }, read on first use
    this.refreshedAt = 0;
    this.refreshing = null;
    this.lastRefresh = null;     // { listed, unlisted }: what the last catch-up saw of Codex's list
    this.onDisk = new Set();     // chats Codex does not list but has: looked up once per run
    this.modelRows = [];         // the rows last handed out
    this.signedIn = null;        // null until Codex has said
    this.signInMethod = null;    // how Codex is signed in ('apiKey', 'chatgpt'), for the status line in Settings; null when signed out or not known
    this.fixedList = null;       // the model list file the user's Codex settings point to (model_catalog_json), or null
    this.modelsAt = 0;           // when the rows were last read successfully
    this.modelsTriedAt = 0;
    this.modelsAsk = null;
    this.modelsEpoch = 0;        // goes up when Codex's login changes: an answer asked for before that is not kept
    this.listed = null;          // the chats Codex lists that Canopy did not start (a CodexListed), when there is one
    this.foldersSeen = null;     // the project folders the last catch-up was for
    if (listed) this.listFrom(listed);
  }

  /**
   * Also answer for the chats Codex itself lists (src/codex-listed.mjs): `has`, `titleOf`, `folderOf`, `rows`
   * and the catch-up then cover them too. A change in that list is a change in the sidebar's rows.
   */
  listFrom(listed) {
    if (!listed || typeof listed.rows !== 'function' || typeof listed.has !== 'function') return this;
    this.listed = listed;
    listed.onChange = () => { try { this.onChange(); } catch { /* an observer never breaks the list */ } };
    return this;
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a call */ } }
  installed() { try { return this.installedFn() === true; } catch { return false; } }

  // ---- the list ----

  #entries() {
    if (this.list) return this.list;
    const out = new Map();
    try {
      const raw = this.loadFn();
      if (isPlain(raw)) for (const [id, e] of Object.entries(raw)) if (id && isPlain(e)) out.set(id, { ...e });
    } catch (err) { this.log(`codex chats: could not read the saved list: ${err?.message ?? err}`); }
    this.list = out;
    return out;
  }

  #save({ quiet = false } = {}) {
    const list = this.#entries();
    // The newest 500, by when you last wrote in them.
    if (list.size > CODEX_CHATS_MAX) {
      const byAge = [...list.entries()].sort((a, b) => this.#updated(b[1]) - this.#updated(a[1]));
      this.list = new Map(byAge.slice(0, CODEX_CHATS_MAX));
    }
    try { Promise.resolve(this.saveFn(Object.fromEntries(this.list))).catch((err) => this.log(`codex chats: save failed: ${err?.message ?? err}`)); }
    catch (err) { this.log(`codex chats: save failed: ${err?.message ?? err}`); }
    if (!quiet) { try { this.onChange(); } catch { /* an observer never breaks the list */ } }
  }

  #updated(e) { return Number.isFinite(e?.lastPromptAt) ? e.lastPromptAt : Number.isFinite(e?.createdAt) ? e.createdAt : 0; }

  /** Is this saved chat a Codex chat: one of Canopy's own, or one Codex lists? */
  has(id) { return this.#own(id) || this.#listedHas(id); }

  #own(id) { return typeof id === 'string' && !!id && this.#entries().has(id); }
  #listedHas(id) { try { return this.listed?.has(id) === true; } catch { return false; } }

  /** Remember who named a chat ('you' or 'canopy'), without changing its name. */
  markNamed(id, by) {
    const e = this.#own(id) ? this.#entries().get(id) : null;
    if (e && e.named !== by) { e.named = by; this.#save({ quiet: true }); }
  }

  /** What Canopy's own list remembers about one chat (a copy), or null: a chat Codex merely lists has no entry yet. */
  get(id) { const e = this.#own(id) ? this.#entries().get(id) : null; return e ? { ...e } : null; }

  /** The chat's name, or null. */
  titleOf(id) {
    const own = str(this.get(id)?.title);
    if (own || this.#own(id)) return own;
    try { return str(this.listed?.titleOf(id)); } catch { return null; }
  }

  /**
   * The folder a chat must run in when that is not the folder it is listed under: a chat from the Codex app with no
   * project is listed under Canopy's own no-project folder and still runs in its own. Null for every other chat
   * (it runs where it is listed).
   */
  folderOf(id) {
    const e = this.get(id);
    if (e) return e.loose === true ? str(e.cwd) : null;
    try { return str(this.listed?.folderOf(id)); } catch { return null; }
  }

  /** The pasted key a chat began on, as an account's id, or null: it began on Codex's own login (or is not known here). */
  accountOf(id) { return str(this.get(id)?.account); }

  get size() { return this.#entries().size; }

  /**
   * Keep the list in step with a Codex chat's events. Call it for Codex chats only.
   * @param {object} ev the event
   * @param {{ sessionId?: string | null, cwd?: string | null, title?: string | null }} [entry] the chat's status entry (src/chats.mjs)
   * @param {{ model?: string | null, cwd?: string, provider?: string | null, accountId?: string | null }} [session]
   *   the live session, for the model in use and, when its process was started on a pasted key's provider, its account
   */
  onEvent(ev, entry, session) {
    try {
      if (!isPlain(ev)) return;
      const list = this.#entries();
      const id = str(ev.sessionId) ?? str(entry?.sessionId);
      const model = str(ev.model) ?? str(session?.model);
      switch (ev.kind) {
        case 'init':
        case 'meta': {
          let changed = false;
          // The chat was gone from disk and carries on as a new one: the old row goes, the new one keeps its name.
          const previous = str(ev.previousSessionId);
          const before = previous && previous !== ev.sessionId ? list.get(previous) : null;
          if (before && !before.gone) { before.gone = true; changed = true; }
          const sid = str(ev.sessionId);
          if (sid && !list.has(sid)) {
            const at = this.now();
            // Begun on a pasted key: remembered, because Codex will only ever open this chat on such a key again.
            const account = str(session?.provider) ? str(session?.accountId) : null;
            // A chat Codex listed (started in the Codex app or the terminal) is opened here for the first time: it
            // keeps its name, its second line and its place in the sidebar, and a chat with no project keeps its folder.
            const from = this.#listedHas(sid) ? this.listed.get(sid) : null;
            list.set(sid, {
              cwd: (from?.loose === true ? str(from.cwd) : null) ?? str(entry?.cwd) ?? str(session?.cwd) ?? str(ev.cwd),
              title: str(before?.title) ?? str(from?.title) ?? (clip(entry?.title ?? from?.firstLine, 80) || null), preview: str(from?.lastLine) ?? str(from?.firstLine),
              createdAt: Number.isFinite(ev.createdAt) && ev.createdAt > 0 ? ev.createdAt : from?.createdAt ?? at,
              lastPromptAt: Number.isFinite(from?.updatedAt) ? from.updatedAt : null, model,
              ...(from?.loose === true && { loose: true }),
              ...(account && { account }),
            });
            changed = true;
          }
          const e = list.get(sid ?? id) ?? null; // a rename's `meta` carries no id: it is the chat the event came from
          // A rename (the chat's `meta {title}`), or the name Codex already has for a chat this list has none for.
          if (e && ev.kind === 'meta' && typeof ev.title === 'string' && ev.title.trim() && e.title !== clip(ev.title, 200)) { e.title = clip(ev.title, 200); changed = true; }
          if (e && ev.kind === 'init' && !str(e.title) && str(ev.name)) { e.title = clip(ev.name, 200); changed = true; }
          if (changed) this.#save();
          break;
        }
        case 'message-start': {
          const e = id ? list.get(id) : null;
          if (!e) break;
          e.lastPromptAt = this.now(); // a turn starts when you send: this is the sidebar's "updated"
          if (!e.title && entry?.title) e.title = clip(entry.title, 80);
          if (e.gone) delete e.gone;
          this.#save();
          break;
        }
        case 'turn-end': {
          const e = id ? list.get(id) : null;
          if (!e) break;
          const preview = previewOf(ev.text); // the reply's first real line, markdown stripped (last-active.mjs)
          if (preview) e.preview = preview;
          if (model) e.model = model;
          if (!e.title && entry?.title) e.title = clip(entry.title, 80);
          this.#save();
          break;
        }
        case 'edit': {
          // A message was edited: the reply the row quotes went with it. The next reply fills the line again.
          const e = id ? list.get(id) : null;
          if (!e || e.preview == null) break;
          e.preview = null;
          this.#save();
          break;
        }
        default: break;
      }
    } catch (err) { this.log(`codex chats: ${err?.message ?? err}`); }
  }

  /**
   * The chat's first message was edited from `was` to `now`. A chat still called after that message (the name a
   * chat goes by until it is given one) is called after the new one from here on. A name you gave it stays, and so
   * does one Canopy made for it (codex-titles.mjs makes that one again from the new first exchange). Resolves to
   * whether the name changed.
   */
  firstMessageEdited(id, was, now) {
    try {
      const e = this.has(id) ? this.#entries().get(id) : null;
      const next = clip(now, 80);
      if (!e || e.named || !next || typeof was !== 'string' || !was.trim() || e.title !== clip(was, 80) || e.title === next) return false;
      e.title = next;
      this.#save();
      return true;
    } catch (err) { this.log(`codex chats: ${err?.message ?? err}`); return false; }
  }

  /**
   * Sidebar rows for these folders (every folder when none are given), in the shape `sessions:list` returns.
   * Memory only. Also starts the background catch-up with Codex when one is due.
   *
   * `chatsDir` is Canopy's own no-project folder. A chat from the Codex app with no project (`loose`) is listed
   * there: its row says that folder, so the window treats it as any other chat under "Chats", and `folderOf` says
   * where it really runs. Chats Codex lists that Canopy did not start follow Canopy's own rows; a chat in both is
   * Canopy's row.
   */
  rows(dirs, { chatsDir } = {}) {
    const out = [];
    try {
      const want = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d) : null;
      const chats = str(chatsDir);
      for (const [id, e] of this.#entries()) {
        if (e.gone) continue;
        const loose = e.loose === true && !!chats;
        const at = loose ? chats : str(e.cwd);
        if (want && !want.some((d) => sameDir(d, at))) continue;
        out.push({
          id, title: str(e.title) ?? 'Untitled chat', updated: this.#updated(e) || this.now(), branch: null,
          cwd: at, preview: str(e.preview), engine: 'codex', ...(loose && { loose: true }),
        });
      }
      if (this.listed) out.push(...this.listed.rows(dirs, { chatsDir: chats, skip: (id) => this.#own(id) }));
      this.refreshSoon();
    } catch (err) { this.log(`codex chats: ${err?.message ?? err}`); }
    return out;
  }

  /**
   * Catch up with what Codex itself knows, unless that was done in the last minute. Never awaited by the sidebar.
   * A change in your project folders does not wait out the minute: the chats of a project just added show up now.
   */
  refreshSoon() {
    if (this.refreshing || !this.service || (!this.#entries().size && !this.listed) || !this.installed()) return;
    let folders = null;
    try { folders = this.listed?.foldersKey() ?? null; } catch { folders = null; }
    if (this.refreshedAt && this.now() - this.refreshedAt < this.t.refreshEvery && folders === this.foldersSeen) return;
    this.foldersSeen = folders;
    this.refreshedAt = this.now();
    this.refreshing = this.refresh().catch((err) => { this.log(`codex chats: refresh failed: ${err?.message ?? err}`); }).finally(() => { this.refreshing = null; });
  }

  // Every page of Codex's own list (its index: a few ms a page), as id -> row. Null when Codex could not say.
  async #listed(opts) {
    const seen = new Map();
    let cursor = null;
    for (let page = 0; page < LIST_PAGES; page++) {
      const r = await soft(() => this.service.listThreads({ limit: LIST_PAGE, ...opts, ...(cursor && { cursor }) }));
      if (!r?.ok || !Array.isArray(r.threads)) return null;
      for (const t of r.threads) if (str(t?.id)) seen.set(t.id, t);
      cursor = str(r.nextCursor);
      if (!cursor || !r.threads.length) break;
    }
    return seen;
  }

  /**
   * Catch up with what Codex knows: Canopy's own chats first, then the chats Codex lists that Canopy did not start
   * (which announce their own changes, see listFrom). Resolves to whether anything in the rows changed.
   */
  async refresh() {
    const own = this.#entries().size ? await this.#catchUp() : false;
    const listed = this.listed ? await soft(() => this.listed.refresh({ skip: (id) => this.#own(id) })) : false;
    return own || listed === true;
  }

  // Canopy's own chats. A chat Codex does not list is not thereby gone: its index can lack a chat that is still on
  // disk (seen on a real Mac). So a chat leaves the rows only on evidence: Codex lists it as archived, or says it is
  // not on disk. Anything else, a failed call included, changes nothing.
  async #catchUp() {
    const seen = await this.#listed({});
    if (!seen) return false;
    const now = this.now();
    let changed = false;
    const unlisted = [];
    for (const [id, e] of this.#entries()) {
      const t = seen.get(id);
      if (t) {
        if (e.gone) { delete e.gone; changed = true; }
        if (!str(e.title) && str(t.title)) { e.title = clip(t.title, 200); changed = true; }
      } else if (!e.gone && now - Math.max(this.#updated(e), e.createdAt ?? 0) > this.t.goneAfter) unlisted.push([id, e]);
    }
    this.lastRefresh = { listed: seen.size, unlisted: unlisted.length };
    if (unlisted.length) {
      const archived = await this.#listed({ archived: true });
      let asked = 0;
      for (const [id, e] of unlisted) {
        if (archived?.has(id)) { e.gone = true; changed = true; continue; }   // archived in Codex
        if (this.onDisk.has(id) || asked >= READS_PER_REFRESH || typeof this.service.readThread !== 'function') continue;
        asked += 1;
        const r = await soft(() => this.service.readThread(id));
        if (r?.ok) this.onDisk.add(id);                                        // there, only not in the index: not asked again
        else if (r?.code === 'not-found') { e.gone = true; changed = true; }  // deleted in Codex
      }
    }
    if (changed) this.#save();
    return changed;
  }

  // ---- one chat ----

  /**
   * A chat's transcript as events. The chat's own live session is asked first (it knows about a turn in flight);
   * otherwise, or if that fails, the shared helper reads it. A failure is one notice in the list.
   * A very long chat is read from its newest turns back, as far as time allowed. When older turns are left, the
   * list starts with `{ kind: 'earlier', cursor, history: true }`: the window's "Show earlier" hands that cursor
   * back (as `before`, or through `earlier()`) and gets the turns just older, a page at a time.
   * @param {string} id
   * @param {{ session?: { history?: (opts?: object) => Promise<{ok: boolean, events?: object[]}> } | null, before?: string }} [opts]
   * @returns {Promise<object[]>}
   */
  async history(id, { session, before } = {}) {
    const notice = (text) => [{ kind: 'notice', level: 'warn', text }];
    if (!str(id)) return [];
    const r = await this.#transcript(id, { session, before });
    if (r.ok) return r.events;
    return notice(r.code === 'not-found' ? r.message : `Could not load history: ${r.message}`);
  }

  /**
   * The turns just older than the ones a transcript holds, for "Show earlier": { events } (led by the `earlier`
   * marker while there are older ones still), or { error }. `cursor` is the one the marker carried. One page is
   * at most EARLIER_PAGE turns, or as many as the time allowed for a read gave. A chat that is not one of
   * Codex's has nothing to page (Claude Code's chats are always read whole): { events: [] }.
   * @returns {Promise<{ events: object[] } | { error: string }>}
   */
  async earlier(id, { session, cursor } = {}) {
    if (!this.has(id)) return { events: [] };
    if (typeof cursor !== 'string' || !cursor || cursor.length > CURSOR_MAX) return { error: 'That is not a place in this chat.' };
    const r = await this.#transcript(id, { session, before: cursor });
    return r.ok ? { events: r.events } : { error: r.message };
  }

  // One read of a chat, newest turns (or the page before `before`): { ok: true, events } or { ok: false, code, message }.
  async #transcript(id, { session, before } = {}) {
    const lead = (events, cursor) => (str(cursor) ? [{ kind: 'earlier', cursor, history: true }, ...events] : events);
    const page = str(before);
    try {
      if (session && typeof session.history === 'function') {
        const live = await Promise.resolve(page ? session.history({ before: page, maxTurns: EARLIER_PAGE }) : session.history()).catch(() => null);
        if (live?.ok && Array.isArray(live.events)) return { ok: true, events: lead(live.events, live.cursor) };
        if (live?.code === 'not-found') return { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' };
      }
      if (!this.service) return { ok: false, code: 'unavailable', message: 'Codex is not available.' };
      const r = await (page ? this.service.turns(id, { cursor: page, maxTurns: EARLIER_PAGE }) : this.service.turns(id));
      if (r?.ok) return { ok: true, events: lead(adaptHistory(Array.isArray(r.turns) ? r.turns : [], { threadId: id }), r.cursor) };
      if (r?.code === 'not-found') return { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' };
      return { ok: false, code: r?.code ?? 'internal', message: r?.message ?? 'Codex did not answer.' };
    } catch (err) { return { ok: false, code: 'internal', message: String(err?.message ?? err) }; }
  }

  /**
   * Name a chat. The list is updated at once; Codex is told through the chat's live session when it has one
   * (its process is the one holding the chat), else through the shared helper. `by`: who named it ('you', or
   * 'canopy' for the name codex-titles.mjs gives), so Canopy never names over a name you gave.
   * @returns {Promise<{ ok: boolean, via?: 'live' | 'service', code?: string, message?: string }>}
   */
  async rename(id, title, session, { by = 'you' } = {}) {
    try {
      const name = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      if (!str(id) || !name) return { ok: false, code: 'invalid-input', message: 'A name is required.' };
      const e = this.#entries().get(id);
      if (e && (e.title !== name || e.named !== by)) { e.title = name; e.named = by; this.#save(); }
      else if (!e) { try { this.listed?.setTitle(id, name); } catch { /* the next catch-up reads the name from Codex */ } }
      if (session && typeof session.rename === 'function' && await Promise.resolve(session.rename(name)).catch(() => false)) return { ok: true, via: 'live' };
      if (!this.service) return { ok: false, code: 'not-running', message: 'Codex is not available.' };
      const r = await this.service.rename(id, name);
      return r?.ok ? { ok: true, via: 'service' } : { ok: false, code: r?.code ?? 'internal', message: r?.message ?? 'Codex did not take the name.' };
    } catch (err) { return { ok: false, code: 'internal', message: String(err?.message ?? err) }; }
  }

  // ---- the model picker ----

  // Is a key pasted into Canopy the account in use? Then its own helper lists the models, when the host gave one.
  #onKey() { try { return this.keyInUseFn() === true; } catch { return false; } }

  /**
   * Is there a login for a new OpenAI chat to start on? True, false, or null when Codex has not said. With a pasted
   * key in use the answer is yes at once, whatever Codex last said of its own login: that is not what the chat
   * would run on. (For `engineFor`, which opens a Claude chat instead of a Codex one that could not run.)
   */
  get canStart() { return this.#onKey() ? true : this.signedIn; }

  async #readModels() {
    this.modelsTriedAt = this.now();
    const epoch = this.modelsEpoch;
    const onKey = this.#onKey();
    const lister = onKey && this.keyService ? this.keyService : this.service;
    const [account, models, fixed] = await Promise.all([onKey ? ON_A_KEY : this.service.account(), lister.models(), onKey ? undefined : this.#fixedList()]);
    if (epoch !== this.modelsEpoch) return false; // the login or the account in use changed meanwhile: this is the old one's answer
    const fixedChanged = fixed !== undefined && fixed !== this.fixedList;
    if (fixed !== undefined) this.fixedList = fixed;
    // Signed out of Codex: no OpenAI rows. (An account the helper could not read is not "signed out".)
    const signedOut = account?.ok === true && !account.signedIn && account.requiresAuth === true;
    if (account?.ok) { this.signedIn = !signedOut; this.signInMethod = signedOut ? null : str(account.account?.type); }
    if (!models?.ok && !signedOut) return false; // Codex did not answer: keep what we had
    const rows = signedOut ? [] : (Array.isArray(models.models) ? models.models : []).map(pickerRow).filter(Boolean);
    const changed = JSON.stringify(rows) !== JSON.stringify(this.modelRows) || fixedChanged;
    this.modelRows = rows;
    this.modelsAt = this.now();
    return changed;
  }

  /**
   * The model list file the user's Codex settings point to (`model_catalog_json`), or null when Codex lists OpenAI's
   * own models. With one set, Codex lists that file's models and nothing newer ever arrives, so Settings says so.
   * Asked through Codex (`config/read`); nothing under ~/.codex is read here. Undefined when Codex could not say:
   * what was known is kept. Not asked while a pasted key is in use: that would start Codex's own process just for this.
   */
  async #fixedList() {
    try {
      if (typeof this.service?.call !== 'function') return undefined;
      const r = await this.service.call('config/read', { includeLayers: false });
      if (r?.ok !== true || !isPlain(r.result?.config)) return undefined;
      const file = r.result.config.model_catalog_json;
      return typeof file === 'string' && file.trim() ? file : null;
    } catch { return undefined; }
  }

  /**
   * Codex was signed in or out, or another account is in use: what was read with the old one is asked for again by
   * the next `models()`. The caller tells the window that the list changed, which is what makes it ask.
   */
  forgetModels() {
    this.modelsEpoch += 1;
    this.modelsAt = 0;
    this.modelsTriedAt = 0;
    this.modelsAsk = null;
  }

  /**
   * The OpenAI rows of the model picker: { openai: CodexModel[], codex: { installed, signedIn, fixedList? } }.
   * `fixedList`: the model list file Codex is set to (see #fixedList), only when there is one.
   * Empty when Codex is missing, signed out or not answering; never an error. The first call asks Codex and waits
   * a few seconds at most. Later calls answer from memory at once and, when the rows are over five minutes old,
   * ask again in the background: `onModels` hears about a list that changed after it was handed out.
   */
  async models() {
    const answer = () => ({
      openai: this.modelRows.map((m) => ({ ...m, supportedEffortLevels: [...m.supportedEffortLevels] })),
      codex: { installed: this.installed(), signedIn: this.signedIn, ...(this.fixedList && { fixedList: this.fixedList }) },
    });
    try {
      if (!this.service || !this.installed()) { this.modelRows = []; this.modelsAt = 0; this.signedIn = null; this.signInMethod = null; return answer(); }
      const now = this.now();
      const fresh = this.modelsAt && now - this.modelsAt < this.t.modelsFresh;
      const mayAsk = !this.modelsTriedAt || now - this.modelsTriedAt >= (this.modelsAt ? this.t.modelsFresh : this.t.modelsRetry);
      if (!fresh && !this.modelsAsk && mayAsk) {
        const first = !this.modelsAt;
        let late = false; // the caller stopped waiting: whatever arrives now has to be announced
        const ask = this.#readModels()
          .then((changed) => { if (changed && (!first || late)) { try { this.onModels(answer().openai); } catch { /* an observer never breaks this */ } } })
          .catch((err) => { this.log(`codex models: ${err?.message ?? err}`); })
          .finally(() => { if (this.modelsAsk === ask) this.modelsAsk = null; });
        this.modelsAsk = ask;
        if (first) { await Promise.race([ask, sleep(this.t.modelsWait)]); late = true; }
      } else if (!this.modelsAt && this.modelsAsk) await Promise.race([this.modelsAsk, sleep(this.t.modelsWait)]);
    } catch (err) { this.log(`codex models: ${err?.message ?? err}`); }
    return answer();
  }
}

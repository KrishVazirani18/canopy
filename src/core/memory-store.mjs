// Canopy Memory's notes: plain Markdown files in one folder, one file per note.
//
// A note is a short fact a chat saved for the chats that come after it ("Uses pnpm, not npm"), whichever maker's
// model runs them. The files are the whole store: there is no database and no index beside them, so the user can
// read, edit or delete a note with any editor, and at this size (200 notes of at most 600 characters) a search is
// a read of the folder. A file:
//
//   ---
//   id: k3f9x2
//   title: Uses pnpm, not npm
//   scope: project                     me: about the user, in every project. project: this project only
//   project: /Users/me/code/site       the project's folder (a project note only): the repo's root, else the chat's folder
//   source: user-said                  user-said: the user told the chat. model-noticed: the chat confirmed it itself
//   engine: claude                     which maker's chat saved it
//   chat: 6a1f…                        that chat's id
//   created: 2026-11-19T10:00:00.000Z
//   updated: 2026-11-19T10:00:00.000Z
//   replaced: Uses yarn.               what the note said before a later save took its place (the last one only)
//   ---
//   Uses pnpm, not npm.
//
//   MemoryStore({ dir })     the folder, or a function that returns it (asked at each use)
//     .all()                 every note, the most recently changed first
//     .get(id)
//     .save(note)            a new note, or the note it repeats or replaces brought up to date: { note, action,
//                            dropped, replaced }, or { error } when it is refused (too long, empty, a secret)
//     .find(words, opts)     the one note a chat means by a title, an id or a few words: { note }, { several }, or {}
//     .edit(id, patch)       the user's own change to a note, from Settings
//     .remove(id)            into the folder's trash, from where restore(id) brings it back
//     .revert(id)            a note that was brought up to date goes back to what it said before (and forth again)
//     .state(id)             where a note stands: { note, removed, previous }
//     .search(query, opts)   the notes that match the words, best first
//     .relevant(project)     what a chat in that project starts with: { me, project }
//     .tell(chat, text)      keep what a chat was told of memory when it started (memory.mjs writes that text)
//     .told(chat)            that text again, while the chat's last turn is under an hour old; undefined after
//   projectOf(cwd)           the project a folder belongs to: its repo's root (a worktree's main checkout), else itself
//
// Contract:
//  - Nothing here throws to its caller: a folder that cannot be read is an empty memory, a file that is not a note
//    is skipped, a write that fails is an { error }.
//  - A save that repeats a note (the same title, or nearly the same words, in the same scope) replaces that note's
//    text instead of adding a second one, and so does a save that names the note it takes the place of (`replaces`:
//    a fact that changed). What it replaced is kept beside the trash, for revert(), and written in the note itself
//    (`replaced`), so the user can always see what a note said before.
//  - Nothing expires on its own. A note goes when the user deletes it, or a chat is told it is wrong and forgets it
//    (remove(), which only moves it to the trash).
//  - The folder never holds more than `limits.notes` notes: one more pushes the least recently changed one into the
//    trash, a note the model noticed before one the user said.
//  - A note that looks like a credential is refused, whatever the model was told (see SECRET), and so is one of a
//    word or two: that is a stand-in, not a fact.
//  - What a chat was told at its start is kept for an hour past its last turn, because that text sits at the start
//    of every request the chat makes: a chat let go for sitting idle and opened again must be told the very same
//    words, or the model re-reads the whole conversation at full price. Past the hour the model's cache of the chat
//    is gone anyway, so the chat is told the notes as they are now.
//  - Only Canopy writes here. Claude Code's and Codex's own memory files are theirs (memory.mjs reads them).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const MEMORY_LIMITS = Object.freeze({
  notes: 200,    // in the folder at once
  text: 600,     // characters of one note
  title: 80,     // characters of its title
  trash: 60,     // files kept in the trash; the oldest go for good beyond that
  replaced: 300, // characters kept of what a note said before it was replaced
  told: 200,     // chats whose opening note is kept (see told())
  toldMs: 60 * 60 * 1000, // and for how long after the chat's last turn: as long as the model's cache of it can last
});
export const SCOPES = Object.freeze(['me', 'project']);
export const SOURCES = Object.freeze(['user-said', 'model-noticed']);
const TRASH = '.trash';
const TOLD = '.told';
const ID_RE = /^[a-z0-9]{4,16}$/;
const CHAT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;

// What is never kept, however it was asked for: the shapes of keys and tokens (as redact.mjs knows them), a private
// key, and "password: hunter2" in so many words. Best effort: it catches what can be recognised.
const SECRET = [
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/, /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api[ _-]?key|secret|token|password|passwd|passphrase|credential)s?\b[^.\n]{0,24}?(?:\bis\b|[:=])\s*["'`]?(?=[^\s"'`]*\d)[^\s"'`]{6,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:?#]+:[^\s/@?#]+@/i,
];
/** Whether a note's words hold what looks like a key, a token or a password. */
export const looksSecret = (text) => SECRET.some((re) => re.test(String(text ?? '')));

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const iso = (ms) => new Date(ms).toISOString();
const when = (v, fallback) => { const t = Date.parse(v); return Number.isFinite(t) ? t : fallback; };

// ---- which project a folder belongs to ----

/**
 * The project a chat's folder belongs to: the root of its git repository, and for a worktree the main checkout, so
 * every worktree and subfolder of one repo shares its notes. Outside a repository, the folder itself.
 */
export function projectOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const start = path.resolve(cwd);
  try {
    for (let dir = start; ; dir = path.dirname(dir)) {
      const git = path.join(dir, '.git');
      if (existsSync(git)) {
        if (statSync(git).isDirectory()) return dir;
        // A worktree's .git is a file: "gitdir: /main/checkout/.git/worktrees/<name>".
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, 'utf8'));
        const at = m ? path.resolve(dir, m[1]) : '';
        const cut = at.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        return cut > 0 ? at.slice(0, cut) : dir;
      }
      if (path.dirname(dir) === dir) break;
    }
  } catch { /* unreadable on the way up: the folder itself */ }
  return start;
}

// ---- words ----

export const STOP = new Set(('a an and are as at be but by do does for from has have how i if in is it its my no not of on or our so that the their them then there ' +
  'these they this to use uses used using was we what when where which who why will with you your user users always never should prefer prefers').split(' '));
/** The words a note is found by: lowercase, no punctuation, no filler, plurals folded. */
export function words(text) {
  const out = [];
  for (const w of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}
// Two titles are the same when they read the same: case and punctuation aside, every word kept ("Fact 1" is not "Fact 2").
const titleKey = (title) => oneLine(title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ') || oneLine(title).toLowerCase();

/** How alike two notes read, 0 to 1: the share of the shorter one's words the other has too. */
export function alike(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  const small = Math.min(A.size, B.size);
  if (small < 3) return 0; // too few words to call two notes the same by their words alone
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  const union = A.size + B.size - both;
  // Nearly the same set of words, or one note wholly inside the other.
  return Math.max(both / union, both / small >= 0.85 ? both / small : 0);
}
const SAME = 0.7;

// ---- a note as a file ----

const FIELDS = ['id', 'title', 'scope', 'project', 'source', 'engine', 'chat', 'created', 'updated', 'replaced'];

/** A note as the text of its file. */
export function formatNote(n) {
  const head = FIELDS.map((k) => {
    const v = k === 'created' || k === 'updated' ? iso(n[k]) : n[k];
    return v === null || v === undefined || v === '' ? null : `${k}: ${oneLine(v)}`;
  }).filter(Boolean);
  return `---\n${head.join('\n')}\n---\n${String(n.text ?? '').trim()}\n`;
}

/**
 * A file's text as a note, or null when it is not one. Forgiving, because the user may have written it: a missing
 * field takes a default (`fallback`: the id from the file's name, its times from the file's own).
 */
export function parseNote(raw, fallback = {}) {
  if (typeof raw !== 'string') return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const head = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) head[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const text = (m ? m[2] : raw).trim();
  if (!text) return null;
  const id = ID_RE.test(head.id ?? '') ? head.id : fallback.id;
  if (!ID_RE.test(id ?? '')) return null;
  const scope = head.scope === 'project' && head.project ? 'project' : 'me';
  const at = Number.isFinite(fallback.at) ? fallback.at : 0;
  const created = when(head.created, at);
  return {
    id, title: clip(oneLine(head.title) || titleFrom(text), MEMORY_LIMITS.title), text, scope,
    project: scope === 'project' ? head.project : null,
    source: SOURCES.includes(head.source) ? head.source : 'user-said', // a note with no word on it was written by hand
    engine: head.engine === 'codex' ? 'codex' : head.engine === 'claude' ? 'claude' : null,
    chat: head.chat || null, created, updated: Math.max(created, when(head.updated, at)),
    replaced: head.replaced ? clip(head.replaced, MEMORY_LIMITS.replaced) : null,
  };
}

/** A title for a note that was given none: its first sentence, in a few words. */
export function titleFrom(text) {
  const first = oneLine(text).split(/(?<=[.!?;:])\s/)[0].replace(/[.!?;:]+$/, '');
  return clip(first, 60);
}

// ---- the store ----

export class MemoryStore {
  /**
   * @param {{ dir: string | (() => string), now?: () => number, limits?: Partial<typeof MEMORY_LIMITS> }} opts
   */
  constructor({ dir, now = () => Date.now(), limits } = {}) {
    this.dirOf = typeof dir === 'function' ? dir : () => dir;
    this.now = now;
    this.limits = { ...MEMORY_LIMITS, ...(isPlain(limits) ? limits : {}) };
  }

  get dir() { return this.dirOf(); }
  file(id, kind = '') { return kind ? path.join(this.dir, TRASH, `${id}${kind === 'prev' ? '.prev' : ''}.md`) : path.join(this.dir, `${id}.md`); }

  read(file, id) {
    try { return parseNote(readFileSync(file, 'utf8'), { id, at: statSync(file).mtimeMs }); } catch { return null; }
  }

  write(file, note) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, formatNote(note), { mode: 0o600 });
    renameSync(tmp, file); // a crash mid-write leaves the note as it was, never half of one
  }

  /** Every note, the most recently changed first. */
  all() {
    let names = [];
    try { names = readdirSync(this.dir); } catch { return []; }
    const notes = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const note = this.read(path.join(this.dir, name), name.slice(0, -3));
      if (note) notes.push(note);
    }
    return notes.sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1));
  }

  get(id) { return ID_RE.test(id ?? '') ? this.read(this.file(id), id) : null; }

  newId(taken) {
    for (;;) {
      const id = BigInt(`0x${randomBytes(5).toString('hex')}`).toString(36).padStart(8, '0').slice(-6);
      if (!taken.has(id) && !existsSync(this.file(id, 'trash'))) return id;
    }
  }

  /**
   * Keep a note. One that repeats a note already there (the same scope, and the same title or nearly the same
   * words) replaces that note's words, and so does one that names the note it takes the place of (`replaces`, that
   * note's id: a fact that changed, in whatever scope the old note was). Anything else is a new note.
   * `replaced` is the note as it was before, when its words changed.
   * @param {{ text: string, title?: string, scope?: 'me' | 'project', project?: string | null, source?: string, engine?: string, chat?: string, replaces?: string }} input
   * @returns {{ note: object, action: 'saved' | 'updated', dropped: object | null, replaced: object | null } | { error: string }}
   */
  save(input) {
    try {
      const i = isPlain(input) ? input : {};
      const text = String(i.text ?? '').replace(/\r\n/g, '\n').trim();
      if (!text) return { error: 'There is nothing in this note. Say the fact to keep, in a sentence.' };
      if (text.length > this.limits.text) return { error: `This note is ${text.length} characters and the most a note holds is ${this.limits.text}. Keep the one fact and what it means next time, and save that.` };
      const given = oneLine(i.title);
      if (looksSecret(text) || looksSecret(given)) return { error: 'This looks like a key, a token or a password, so it was not saved: Canopy memory never keeps secrets. Do not try again with it reworded.' };
      // A word or two is not a fact: a model now and then calls the tool with a stand-in ("placeholder", "test").
      if (text.split(/\s+/).length < 3) return { error: 'This is too short to be a note. Say the fact in a sentence, or do not save anything.' };
      const scope = i.scope === 'project' && i.project ? 'project' : 'me';
      const project = scope === 'project' ? path.resolve(i.project) : null;
      const source = SOURCES.includes(i.source) ? i.source : 'model-noticed';
      const at = this.now();
      const all = this.all();
      const peers = all.filter((n) => n.scope === scope && n.project === project);
      const key = given ? titleKey(given) : '';
      const named = ID_RE.test(i.replaces ?? '') ? all.find((n) => n.id === i.replaces) ?? null : null;
      const old = named
        ?? (key ? peers.find((n) => titleKey(n.title) === key) : null)
        ?? peers.map((n) => ({ n, s: alike(n.text, text) })).filter((x) => x.s >= SAME).sort((a, b) => b.s - a.s)[0]?.n
        ?? null;
      const meta = { source, engine: i.engine === 'codex' ? 'codex' : i.engine === 'claude' ? 'claude' : null, chat: typeof i.chat === 'string' && i.chat ? i.chat : null };
      if (old) {
        // A title the old note took from its own first words would now name what is no longer true.
        const title = given || (old.title === clip(titleFrom(old.text), this.limits.title) ? titleFrom(text) : old.title);
        const changed = old.text !== text;
        const note = {
          ...old, ...meta, scope, project, title: clip(title, this.limits.title), text, updated: Math.max(at, old.updated + 1),
          replaced: changed ? clip(oneLine(old.text), this.limits.replaced) : old.replaced ?? null,
        };
        if (changed || old.title !== note.title || old.scope !== scope || old.project !== project) this.write(this.file(old.id, 'prev'), old); // what revert() goes back to
        this.write(this.file(old.id), note);
        this.sweep();
        return { note, action: 'updated', dropped: null, replaced: changed ? old : null };
      }
      let dropped = null;
      if (all.length >= this.limits.notes) {
        // The oldest goes, a note the model noticed before one the user said. `all` is newest first.
        const oldest = [...all].reverse();
        dropped = oldest.find((n) => n.source === 'model-noticed') ?? oldest[0];
        this.toTrash(dropped.id);
      }
      const note = { id: this.newId(new Set(all.map((n) => n.id))), title: clip(given || titleFrom(text), this.limits.title), text, scope, project, ...meta, created: at, updated: at, replaced: null };
      this.write(this.file(note.id), note);
      if (dropped) this.sweep();
      return { note, action: 'saved', dropped, replaced: null };
    } catch (err) {
      return { error: `The note could not be written (${String(err?.message ?? err).slice(0, 160)}).` };
    }
  }

  /** The user's own change to a note's title or words. It is theirs from then on, whoever saved it first. */
  edit(id, patch) {
    try {
      const old = this.get(id);
      if (!old) return { error: 'That note is gone.' };
      const p = isPlain(patch) ? patch : {};
      const text = typeof p.text === 'string' ? p.text.replace(/\r\n/g, '\n').trim() : old.text;
      if (!text) return { error: 'A note needs some words. Delete it instead to remove it.' };
      if (text.length > this.limits.text) return { error: `A note holds at most ${this.limits.text} characters; this is ${text.length}.` };
      const title = clip(typeof p.title === 'string' && oneLine(p.title) ? oneLine(p.title) : old.title, this.limits.title);
      if (text === old.text && title === old.title) return { note: old };
      const note = { ...old, title, text, source: 'user-said', updated: Math.max(this.now(), old.updated + 1) };
      this.write(this.file(id), note);
      return { note };
    } catch (err) {
      return { error: `The note could not be written (${String(err?.message ?? err).slice(0, 160)}).` };
    }
  }

  toTrash(id) {
    mkdirSync(path.join(this.dir, TRASH), { recursive: true });
    renameSync(this.file(id), this.file(id, 'trash'));
  }

  /** Take a note out of memory. It waits in the trash, so restore(id) can bring it back. */
  remove(id) {
    try {
      const note = this.get(id);
      if (!note) return null;
      this.toTrash(id);
      this.sweep();
      return note;
    } catch { return null; }
  }

  /** Bring a removed note back, as it was. Null when it is not in the trash any more. */
  restore(id) {
    try {
      if (!ID_RE.test(id ?? '') || existsSync(this.file(id))) return this.get(id);
      const note = this.read(this.file(id, 'trash'), id);
      if (!note) return null;
      renameSync(this.file(id, 'trash'), this.file(id));
      return note;
    } catch { return null; }
  }

  /**
   * A note that a save brought up to date goes back to what it said before; what it said since is kept in its
   * place, so a second revert undoes the first. Null when the note has no earlier wording.
   */
  revert(id) {
    try {
      const now = this.get(id);
      const before = ID_RE.test(id ?? '') ? this.read(this.file(id, 'prev'), id) : null;
      if (!now || !before) return null;
      this.write(this.file(id, 'prev'), now);
      this.write(this.file(id), before);
      return before;
    } catch { return null; }
  }

  /** Where a note stands, for the row that offers Undo: there, removed (and still restorable), or with an earlier wording. */
  state(id) {
    if (!ID_RE.test(id ?? '')) return { note: null, removed: false, previous: false };
    const note = this.get(id);
    return { note, removed: !note && existsSync(this.file(id, 'trash')), previous: !!note && existsSync(this.file(id, 'prev')) };
  }

  // The trash holds the newest `limits.trash` files. Never throws.
  sweep() {
    try {
      const dir = path.join(this.dir, TRASH);
      const files = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ f, at: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
      for (const { f } of files.slice(this.limits.trash)) rmSync(path.join(dir, f), { force: true });
    } catch { /* no trash yet */ }
  }

  // ---- what a chat was told ----

  /**
   * Keep what a chat was told of memory when it started ('' for nothing), stamped with now. Called again at the end
   * of each of the chat's turns, which keeps it for another hour. Never throws.
   */
  tell(chat, text) {
    try {
      if (!CHAT_RE.test(chat ?? '') || typeof text !== 'string') return;
      const dir = path.join(this.dir, TOLD);
      const file = path.join(dir, `${chat}.md`);
      const fresh = !existsSync(file);
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, `${this.now()}\n${text}`, { mode: 0o600 });
      renameSync(tmp, file);
      if (!fresh) return;
      // Only the newest chats are kept: an older one opened again is told the notes as they are then.
      const all = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ f, at: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
      for (const { f } of all.slice(this.limits.told)) rmSync(path.join(dir, f), { force: true });
    } catch { /* the chat is then told the notes as they are when it is opened again */ }
  }

  /**
   * What tell() kept for a chat, while it is under `limits.toldMs` old. Undefined when nothing is kept or it is
   * older: the chat is then told the notes as they are now.
   */
  told(chat) {
    try {
      if (!CHAT_RE.test(chat ?? '')) return undefined;
      const raw = readFileSync(path.join(this.dir, TOLD, `${chat}.md`), 'utf8');
      const cut = raw.indexOf('\n');
      const at = Number(raw.slice(0, cut));
      if (cut < 0 || !Number.isFinite(at) || this.now() - at > this.limits.toldMs || this.now() < at) return undefined;
      return raw.slice(cut + 1);
    } catch { return undefined; }
  }

  /** What a chat in `project` starts with: the notes about the user, and that project's. Each newest first. */
  relevant(project) {
    const all = this.all();
    const root = project ? path.resolve(project) : null;
    return { me: all.filter((n) => n.scope === 'me'), project: root ? all.filter((n) => n.scope === 'project' && n.project === root) : [] };
  }

  /**
   * The one note a chat means when it names one to replace or forget: by its id, else by its title, else by words
   * that only one note has all of. Only the notes that chat can see count (about the user, and `project`'s).
   * `{ note }` when there is exactly one, `{ several }` (the candidates, at most 6) when the words fit more than
   * one, `{}` when they fit none. Never a guess: a wrong note replaced or forgotten is worse than being asked again.
   * @param {string} ref
   * @param {{ project?: string | null }} [opts]
   * @returns {{ note?: object, several?: object[] }}
   */
  find(ref, { project = null } = {}) {
    const said = oneLine(ref).replace(/^["'`\[]+|["'`\].]+$/g, '');
    if (!said) return {};
    const { me, project: mine } = this.relevant(project);
    const seen = [...me, ...mine];
    const id = /^(?:id\s+)?([a-z0-9]{4,16})$/i.exec(said)?.[1]?.toLowerCase();
    const byId = id ? seen.find((n) => n.id === id) : null;
    if (byId) return { note: byId };
    const key = titleKey(said);
    const byTitle = seen.filter((n) => titleKey(n.title) === key);
    if (byTitle.length === 1) return { note: byTitle[0] };
    if (byTitle.length > 1) return { several: byTitle.slice(0, 6) };
    // "the note about pnpm": the words that say it is a note are not words of the note.
    const asked = [...new Set(words(said))].filter((w) => !['note', 'memory', 'saved', 'about', 'one', 'rule'].includes(w));
    if (!asked.length) return {};
    const has = (list, q) => list.some((w) => w === q || (q.length >= 4 && w.startsWith(q)) || (w.length >= 4 && q.startsWith(w)));
    const fits = seen.filter((n) => { const mineWords = [...words(n.title), ...words(n.text)]; return asked.every((q) => has(mineWords, q)); });
    if (fits.length === 1) return { note: fits[0] };
    // Several fit: the one whose title alone has every word is the one meant.
    const titled = fits.filter((n) => asked.every((q) => has(words(n.title), q)));
    if (titled.length === 1) return { note: titled[0] };
    return fits.length ? { several: fits.slice(0, 6) } : {};
  }

  /**
   * The notes that match a question's words, best first. A word in the title counts for more than one in the text,
   * and a note about the user or about `project` comes before another project's that matches as well.
   * @param {string} query
   * @param {{ project?: string | null, limit?: number }} [opts]
   */
  search(query, { project = null, limit = 8 } = {}) {
    const asked = [...new Set(words(query))];
    if (!asked.length) return [];
    const root = project ? path.resolve(project) : null;
    const hits = [];
    for (const n of this.all()) {
      const inTitle = words(n.title);
      const inText = words(n.text);
      const where = n.project ? words(path.basename(n.project)) : [];
      let score = 0;
      let found = 0;
      for (const q of asked) {
        const has = (list) => list.some((w) => w === q || (q.length >= 4 && w.startsWith(q)) || (w.length >= 4 && q.startsWith(w)));
        const s = (has(inTitle) ? 3 : 0) + (has(inText) ? 2 : 0) + (has(where) ? 1 : 0);
        if (s) found += 1;
        score += s;
      }
      if (!found) continue;
      // Matching every word asked for beats matching one of them many ways.
      score = score * (found / asked.length) + (n.scope === 'me' || n.project === root ? 1 : 0);
      hits.push({ n, score });
    }
    return hits.sort((a, b) => b.score - a.score || b.n.updated - a.n.updated).slice(0, limit).map((h) => h.n);
  }
}

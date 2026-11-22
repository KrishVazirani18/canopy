// Notes: what the user did in Canopy that the model did not see.
//
// A model knows what its conversation holds. When the user does something in the app that changes what it should
// assume (puts files back the way they were, edits a message so that the replies after it are gone), nothing in the
// conversation says so, and the model carries on from a state that is no longer there: it redoes the work that was
// undone, or trusts what it remembers of a file that has changed since. So each chat keeps one short line about
// every such action, and the lines go to the model with the next message the chat sends.
//
//   noteLine(note, about)            one action as its line: plain, factual, and what follows from it
//   NoteQueue                        a chat's waiting lines: add(), take(id) for the message that carries them,
//                                    settle(id, state) as that message's send moves on
//   noteForClaude / noteForCodex     the block as each engine is handed it
//   isNoteText / stripNote           telling a carried block from the user's own words, so no bubble, search hit or
//                                    digest ever shows one (stripLeads: a moved chat's digest too)
//   escapeNoteTag                    the user's own text can never open or close a block
//
// Both engines use the same queue and the same words. Only how the block travels differs (session.mjs,
// codex-session.mjs): a Claude chat gets it as a first block of the message, inside <system-reminder>, which Claude
// Code and Canopy's history reader both treat as not the user's; a Codex chat gets it as a developer message put
// into the thread just before the turn. Either way it is the way a moved chat's digest already travels (handoff.mjs).
//
// The notes:
//   { kind: 'undo', files }            files were put back as they were, and the conversation still holds the changes
//   { kind: 'edit', files, undone }    a message was edited: everything after it is gone from the conversation, and
//                                      what was changed there in `files` was undone with it, or is still on disk
//   { kind: 'moved', model }           the conversation was carried on in a new chat, on `model` (the other maker's)
//   { kind: 'text', text }             anything else, already in words ("The user …")
// `files`: the files, when they are known. Left out or null: not known. Empty: there were none, and nothing is said.
//
// Contract:
//  - Pure: nothing is imported from node. Nothing here throws; a note that says nothing is not queued.
//  - A note only ever rides with a message. A chat's system prompt and tools are never changed for one.
//  - At most NOTES_MAX lines a message, the newest. The same thing is said once: equal notes are one line, and
//    several undos are one line naming all their files.
//  - Notes live with the chat's session, in memory. A chat that is closed forgets them.
import { stripHandoff } from './handoff.mjs';

export const NOTE_OPEN = '<canopy_note>';
const NOTE_CLOSE = '</canopy_note>';
const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';
/** How many lines one message carries at most. */
export const NOTES_MAX = 4;
const FILES_NAMED = 4;    // files named in one line; the rest are counted
const FILES_KEPT = 200;
const PATH_CAP = 160;
const TEXT_CAP = 400;
const MODEL_CAP = 80;
const SENT_MAX = 64;      // sends whose notes are remembered after they went (see again())
const ENDED = new Set(['cancelled', 'failed', 'lost']);

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' ? v : '');
const oneLine = (s) => str(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…` : s);
// A block's own tags, written inside it by a file's name, would end it early.
const defuse = (s) => str(s).replace(/<(\/?)(canopy_note|canopy_handoff|system-reminder)>/g, '‹$1$2›');

/** The user's own text with the block's tag made harmless, so nothing they type or paste can pass for a note. */
export const escapeNoteTag = (text) => (typeof text === 'string' && text.includes('canopy_note>') ? text.replace(/<(\/?)canopy_note>/g, '‹$1canopy_note›') : text);

// ---- the block, as each engine is handed it ----

/** The block as a Claude chat's message carries it. */
export const noteForClaude = (block) => `${REMINDER_OPEN}\n${str(block)}\n${REMINDER_CLOSE}`;
/** The block as a Codex thread is given it. */
export const noteForCodex = (block) => str(block);

/** True when the text opens with a note block (bare, or inside Claude's wrapper). Text that merely quotes the tag further on is not one. */
export function isNoteText(text) {
  let t = str(text).trimStart();
  if (t.startsWith(REMINDER_OPEN)) t = t.slice(REMINDER_OPEN.length).trimStart();
  return t.startsWith(NOTE_OPEN);
}

/** The text without the note block it opens with. Text that does not open with one comes back as it is; a block cut short is all block. */
export function stripNote(text) {
  const s = str(text);
  if (!isNoteText(s)) return s;
  const end = s.indexOf(NOTE_CLOSE);
  if (end < 0) return '';
  let rest = s.slice(end + NOTE_CLOSE.length);
  const after = rest.trimStart();
  if (s.trimStart().startsWith(REMINDER_OPEN) && after.startsWith(REMINDER_CLOSE)) rest = after.slice(REMINDER_CLOSE.length);
  return rest.replace(/^\s+/, '');
}

/** A message's text without anything Canopy put first for the model only: a moved chat's digest, a note, or both. */
export function stripLeads(text) {
  let s = str(text);
  for (let i = 0; i < 4; i++) {
    const next = stripNote(stripHandoff(s));
    if (next === s) break;
    s = next;
  }
  return s;
}

// ---- the words ----

const shown = (file, cwd) => cut(defuse(oneLine(cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file)), PATH_CAP);

// "a.ts", "a.ts and b.ts", "a.ts, b.ts and c.ts", "a.ts, b.ts, c.ts, d.ts and 3 more files".
function named(files, cwd) {
  const names = files.slice(0, FILES_NAMED).map((f) => shown(f, cwd));
  const more = files.length - names.length;
  if (more > 0) return `${names.join(', ')} and ${more} more file${more === 1 ? '' : 's'}`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

/**
 * One note as the line the model reads, or null for a note that says nothing.
 * @param {object} note
 * @param {{ cwd?: string | null }} [about] the chat's folder: files inside it are named from there
 */
export function noteLine(note, { cwd = null } = {}) {
  const n = clean(note);
  if (!n) return null;
  const files = n.files?.length ? named(n.files, typeof cwd === 'string' && cwd ? cwd.replace(/\/+$/, '') : null) : null;
  switch (n.kind) {
    case 'undo':
      return `The user undid ${files ? `your changes to ${files}` : 'your latest file changes'}. Don't redo them unless the user asks.`;
    case 'edit': {
      const gone = 'The user edited the message below. Your replies to its earlier version, and anything said after them, are no longer in this conversation';
      if (n.undone) return `${gone}, and the ${files ? `changes you made there to ${files}` : 'file changes you made there'} were undone with them. Start from the files as they are now.`;
      return `${gone}, but ${files ? `the changes you made there to ${files} are still on disk` : 'anything you changed on disk there is still changed'}. Read a file again before relying on what you remember of it.`;
    }
    case 'moved':
      return `The user carried this conversation on in another chat${n.model ? ` (${n.model})` : ''}. Work may have been done there since your last reply here: check the files before relying on what you remember of them.`;
    default: return n.text;
  }
}

// A note as the queue keeps it, or null when it says nothing. `files`: null when they are not known.
function clean(note) {
  if (!isObj(note)) return null;
  const files = Array.isArray(note.files) ? [...new Set(note.files.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()))].slice(0, FILES_KEPT) : null;
  switch (note.kind) {
    case 'undo': return files && !files.length ? null : { kind: 'undo', files };
    case 'edit': return files && !files.length ? null : { kind: 'edit', files, undone: note.undone === true };
    case 'moved': return { kind: 'moved', model: cut(defuse(oneLine(note.model)), MODEL_CAP) };
    case 'text': {
      const text = cut(defuse(oneLine(note.text)), TEXT_CAP);
      return text ? { kind: 'text', text } : null;
    }
    default: return null;
  }
}

// The same thing is said once: equal notes are one note, and every undo is one note with all the files.
function fold(notes) {
  const out = [];
  for (const n of notes) {
    const undo = n.kind === 'undo' ? out.find((o) => o.kind === 'undo') : null;
    if (undo) { undo.files = undo.files && n.files ? [...new Set([...undo.files, ...n.files])].slice(0, FILES_KEPT) : null; continue; }
    const key = JSON.stringify(n);
    if (!out.some((o) => JSON.stringify(o) === key)) out.push({ ...n, ...(n.files && { files: [...n.files] }) });
  }
  return out;
}

// ---- a chat's notes ----

export class NoteQueue {
  /** @param {{ cwd?: string | null, max?: number }} [opts] the chat's folder (files inside it are named from there) */
  constructor({ cwd = null, max = NOTES_MAX } = {}) {
    this.cwd = typeof cwd === 'string' && cwd ? cwd : null;
    this.max = Number.isInteger(max) && max > 0 ? max : NOTES_MAX;
    this.waiting = [];        // for the next message, oldest first
    // send id -> { notes, only, unless, sent }: what a message carries. `only`: notes for that message alone.
    // `unless`: notes that are queued if it never starts. `sent`: the model has it.
    this.riding = new Map();
  }

  /** How many notes wait for the next message. */
  get size() { return this.waiting.length; }

  #ride(id) {
    let r = this.riding.get(id);
    if (!r) this.riding.set(id, r = { notes: [], only: [], unless: [], sent: false });
    return r;
  }

  /**
   * Queue a note for the next message. With `only` (a send's id) it is for that message alone: it describes what
   * that very message did (an edit), so it is never handed on to another one.
   * @returns {boolean} false for a note that says nothing
   */
  add(note, { only = null } = {}) {
    const n = clean(note);
    if (!n) return false;
    if (only == null) { this.waiting = fold([...this.waiting, n]); return true; }
    const r = this.#ride(only);
    if (r.sent) return false;
    r.only.push(n);
    return true;
  }

  /** Should the send `id` end without ever starting, `note` is queued: what is true only if that message never went. */
  unless(id, note) {
    const n = clean(note);
    const r = n ? this.#ride(id) : null;
    if (!r || r.sent) return false;
    r.unless.push(n);
    return true;
  }

  /**
   * The block for the send `id` to carry: everything waiting, then what is for that message alone. Null when there
   * is nothing to say. Asked again for the same send (it is being delivered again), it answers the same.
   */
  take(id) {
    const r = this.#ride(id);
    if (r.sent) return null;
    if (this.waiting.length) { r.notes = fold([...r.notes, ...this.waiting]); this.waiting = []; }
    const lines = [...new Set([...r.notes, ...r.only].map((n) => noteLine(n, { cwd: this.cwd })).filter(Boolean))].slice(-this.max);
    if (!lines.length) { if (!r.unless.length) this.riding.delete(id); return null; }
    return `${NOTE_OPEN}\n${lines.join('\n')}\n${NOTE_CLOSE}`;
  }

  /**
   * The send `id` moved on (an outbox state). Started: the model has what it carried. Ended without ever starting:
   * what it carried waits for the next message again, without the notes that were for it alone.
   */
  settle(id, state) {
    const r = this.riding.get(id);
    if (!r) return;
    if (state === 'started' || state === 'completed') {
      if (r.sent) return;
      r.sent = true; r.only = []; r.unless = [];
      if (!r.notes.length) { this.riding.delete(id); return; }
      // Remembered for again(), the newest few.
      let extra = [...this.riding.values()].filter((x) => x.sent).length - SENT_MAX;
      for (const [key, x] of this.riding) { if (extra <= 0) break; if (x.sent) { this.riding.delete(key); extra--; } }
      return;
    }
    if (r.sent || !ENDED.has(state)) return;
    this.riding.delete(id);
    this.waiting = fold([...r.notes, ...r.unless, ...this.waiting]);
  }

  /** The message `id` left the conversation (it was edited away): what the model was told with it is told again. */
  again(id) {
    const r = this.riding.get(id);
    if (!r?.sent) return false;
    this.riding.delete(id);
    this.waiting = fold([...r.notes, ...this.waiting]);
    return true;
  }

  /** The chat was closed, or its conversation started over: nothing is told. */
  clear() { this.waiting = []; this.riding.clear(); }
}

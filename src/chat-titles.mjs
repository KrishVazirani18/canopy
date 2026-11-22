// Better chat names. Claude Code names a chat from your first message alone, so "what up canopy" or "need your help
// with something" becomes the chat's name for good. Once the first real exchange is done (small talk skipped), Canopy
// hands that message and Claude's reply to Claude Code's own titler and saves what it says as the chat's name.
//
// One try per chat. A name you gave the chat yourself is never touched: a chat that has a saved name is skipped, and
// that includes a name Canopy saved, so it never renames twice. If the titler isn't there (it is internal to the
// SDK), the chat simply keeps Claude Code's title.
//
// One exception: when you edit a chat's first message, the name Canopy gave it described the old one. It is worked
// out again from the new first exchange (again()), as long as the name is still Canopy's own from this run.
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { configHome } from './core/env.mjs';

const MAX_USER = 450;
const MAX_REPLY = 520;

// Words that carry no topic. A message made only of these is small talk ("whatuppppp", "what u up to", "hey canopy").
const FILLER = new Set(('hey hi hii hello helo yo sup wassup whatsup whats what up u you ya r are is it how hows doing going ' +
  'good gm morning afternoon evening night there man bro dude lol haha ok okay k thanks thank thx ty to canopy claude im i am ' +
  'just here back again so well').split(' '));

/** Claude Code's markup (reminders, command echoes) dropped; the text of anything else kept. */
export function plain(s) {
  return String(s ?? '')
    .replace(/<([a-z]+(?:-[a-z]+)+)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?[a-z_][\w-]*\b[^>]*>/gi, ' ')
    .replace(/\[(?:Image|Pasted text) #\d+[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ') : '';

/** A greeting or "what are you up to": nothing to name the chat after. */
export function isSmallTalk(text) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/(.)\1{2,}$/, '$1')); // "whatuppppp" -> "whatup"
  return words.every((w) => FILLER.has(w) || /^(what|wass?|wus)s?up+$/.test(w) || /^he+y+$/.test(w) || /^yo+$/.test(w));
}

/**
 * The first real exchange in a saved chat: the first message of yours that isn't small talk, and Claude's last
 * reply to it. Null until that reply exists.
 * @param {Array<{type: string, message?: any, parent_tool_use_id?: string|null}>} messages from getSessionMessages
 * @returns {{user: string, reply: string} | null}
 */
export function firstExchange(messages) {
  let cur = null;
  for (const m of messages ?? []) {
    if (m?.parent_tool_use_id) continue; // a subagent's messages
    const text = plain(textOf(m?.message?.content));
    if (!text) continue;
    if (m.type === 'user') {
      if (text.startsWith('[Request interrupted')) continue;
      if (cur?.reply) break;
      cur = isSmallTalk(text) ? null : { user: text, reply: '' };
    } else if (m.type === 'assistant' && cur) cur.reply = text;
  }
  return cur?.reply ? cur : null;
}

/**
 * Whether the chat has a saved name (a rename, yours or Canopy's), not just Claude Code's automatic title.
 * The SDK can't tell: its `customTitle` falls back to the automatic title. Null when the chat isn't saved yet.
 */
export async function hasSavedName(sessionId, dir, configDir = configHome()) {
  const slug = (d) => path.resolve(d).replace(/[^a-zA-Z0-9]/g, '-');
  const dirs = [dir, await realpath(dir).catch(() => dir)];
  for (const d of new Set(dirs.map(slug))) {
    try { return /"type":\s*"custom-title"/.test(await readFile(path.join(configDir, 'projects', d, `${sessionId}.jsonl`), 'utf8')); }
    catch { /* try the next spelling of the folder */ }
  }
  return null;
}

/**
 * Saves a chat's name. A chat whose Claude Code process is running is told directly: the process keeps the name it
 * knows and writes it back onto the transcript on later turns, which would undo a name written to the file behind
 * its back. Without a live process (or one that can't take it) the name is written to the transcript.
 * @param {{ rename?: (title: string) => Promise<boolean> } | null | undefined} session the chat's live session, if open
 * @param {(sessionId: string, title: string, options?: {dir: string}) => Promise<void>} renameSession writes the transcript
 */
export async function renameChat(session, sessionId, title, dir, renameSession = sdk.renameSession) {
  if (typeof session?.rename === 'function' && await session.rename(title).catch(() => false)) return 'live';
  await renameSession(sessionId, title, dir ? { dir } : undefined);
  return 'file';
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** What the titler reads. */
export const describe = ({ user, reply }) => `User: ${clip(user, MAX_USER)}\nClaude: ${clip(reply, MAX_REPLY)}`;

export class ChatTitler {
  /**
   * @param {{ onTitled?: (sessionId: string, title: string) => void, log?: (msg: string) => void,
   *   api?: { hasSavedName: Function, getSessionMessages: Function, renameSession: Function } }} [opts]
   */
  constructor({ onTitled, log, api } = {}) {
    this.onTitled = onTitled ?? (() => {});
    this.log = log ?? (() => {});
    this.api = api ?? { hasSavedName, getSessionMessages: sdk.getSessionMessages, renameSession: sdk.renameSession, getSessionInfo: sdk.getSessionInfo };
    this.done = new Set();   // chats that were named, or tried once
    this.busy = new Set();
    this.mine = new Map();   // the names Canopy gave in this run: chat -> name
    this.redo = new Set();   // chats whose first message was edited: name them again after their next turn
  }

  /** The chat's first message was edited. If its name is one Canopy gave it, the next turn names it again. */
  again(sessionId) {
    if (!sessionId || !this.mine.has(sessionId)) return;
    this.redo.add(sessionId);
    this.done.delete(sessionId);
  }

  /** The chat still carries the name Canopy gave it (you haven't renamed it since). */
  async stillMine(sessionId, where) {
    const info = await this.api.getSessionInfo?.(sessionId, where);
    return !!info && info.customTitle === this.mine.get(sessionId);
  }

  /**
   * Call when a turn ends. Names the chat once its first real exchange is done.
   * @param {{ generateTitle: (description: string) => Promise<string|null> }} session the live session
   */
  async afterTurn(session, sessionId, cwd) {
    if (!sessionId || !session || this.done.has(sessionId) || this.busy.has(sessionId)) return;
    this.busy.add(sessionId);
    try {
      if (!cwd) return;
      const where = { dir: cwd };
      const redo = this.redo.has(sessionId);
      const named = await this.api.hasSavedName(sessionId, cwd);
      if (named == null) return; // not saved yet
      if (named && !(redo && await this.stillMine(sessionId, where))) { this.redo.delete(sessionId); this.done.add(sessionId); return; }
      const ex = firstExchange(await this.api.getSessionMessages(sessionId, where));
      if (!ex) return; // only small talk so far: try again after the next turn
      this.done.add(sessionId); this.redo.delete(sessionId);
      const title = await session.generateTitle(describe(ex));
      if (!title) return;
      // You named it meanwhile.
      if (redo ? !(await this.stillMine(sessionId, where)) : await this.api.hasSavedName(sessionId, cwd)) return;
      await renameChat(session, sessionId, title, cwd, this.api.renameSession);
      this.mine.set(sessionId, title);
      this.onTitled(sessionId, title);
    } catch (err) {
      this.done.add(sessionId);
      this.log(`chat title: ${err?.message ?? err}`);
    } finally { this.busy.delete(sessionId); }
  }
}

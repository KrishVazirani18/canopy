// One question for a change to several files (Claude chats).
//
// Claude Code asks about each Edit/Write/MultiEdit/NotebookEdit on its own, one after another: these tools are not
// safe to run together, so the second ask only arrives once the first is answered. Left alone that is N cards in a
// row for what the user sees as one change. This file is the part that knows which steps belong together:
//
//   * `StepTracker` watches the model's top-level frames and remembers, per assistant message, which tool calls it
//     holds, what each was given, whether the message is still being written, and which calls have already been
//     asked about or have run.
//   * `inProject`, `projectRoots`, `sameInput` and `plainAsk` are the safety rules, applied by `StepTracker.group`.
//     A call is only ever answered without a card of its own if it was shown in the card, with exactly the input
//     shown, and its own ask is a plain one.
//
// Nothing here talks to Claude Code or the window; session.mjs decides what to do with the answers.

import fs from 'node:fs';
import path from 'node:path';

/** The tools whose asks are grouped: each changes one file. */
export const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** How long a card waits for the rest of the message to be written, so its list is complete. */
export const SETTLE_MS = 6000;

/** How many calls of one message are tracked at most, and how many messages are remembered. */
const MAX_TOOLS = 200;
const MAX_MESSAGES = 8;

/** Folders Claude Code guards with its own safety check: a change inside one is never grouped. */
const GUARDED = new Set(['.git', '.claude', '.vscode', '.idea', '.husky']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The file a file-changing call is about, or null. */
export function changePath(name, input) {
  if (!FILE_TOOLS.has(name) || !isObj(input)) return null;
  const p = name === 'NotebookEdit' ? input.notebook_path : input.file_path;
  return typeof p === 'string' && p ? p : null;
}

/** Key order and spacing must not decide whether two inputs are the same. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const sameInput = (a, b) => canon(a) === canon(b);

/** Is `file` inside `root` (the project folder, as given and with its symlinks resolved), and clear of guarded folders? */
export function inProject(file, roots) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const full = path.resolve(file);
  const inside = roots.some((root) => {
    const rel = path.relative(root, full);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!inside) return false;
  return !full.split(path.sep).some((seg) => GUARDED.has(seg));
}

/** The folders a project path may be written in: the one given and what it really is (macOS /tmp is /private/tmp). */
export function projectRoots(cwd) {
  if (typeof cwd !== 'string' || !cwd) return [];
  const roots = [path.resolve(cwd)];
  try { const real = fs.realpathSync(cwd); if (!roots.includes(real)) roots.push(real); } catch { /* not there: the plain path stands */ }
  return roots;
}

/**
 * An ask with nothing special about it: no rule the user wrote, no hook or safety reason, no outside folder, no
 * demand for care, not a subagent's and not a Code Mode script's. Only this kind of ask is ever answered without a
 * card, and only this kind opens a group.
 */
export function plainAsk(ctx, { nested = false } = {}) {
  const c = ctx ?? {};
  return !nested && !c.agentID && !c.decisionReason && !c.decisionReasonType && !c.matchedAskRule && !c.requiresInteraction
    && !c.defaultToNo && !c.blockedPath && !c.mcpServer;
}

export class StepTracker {
  constructor() {
    /** message id -> { open, tools: Map(toolUseId -> { id, name, input, index, asked, done }), waiters } */
    this.messages = new Map();
    this.current = null;
    /** tool use id -> message id, for the calls still tracked. */
    this.owner = new Map();
  }

  reset() {
    for (const m of this.messages.values()) this.release(m);
    this.messages.clear(); this.owner.clear(); this.current = null;
  }

  message(id) {
    let m = this.messages.get(id);
    if (!m) {
      m = { id, open: false, tools: new Map(), waiters: new Set() };
      this.messages.set(id, m);
      while (this.messages.size > MAX_MESSAGES) {
        const [oldId, old] = this.messages.entries().next().value;
        this.release(old);
        for (const t of old.tools.keys()) this.owner.delete(t);
        this.messages.delete(oldId);
      }
    }
    return m;
  }

  release(m) {
    m.open = false;
    for (const w of [...m.waiters]) w();
    m.waiters.clear();
  }

  track(m, id, name, input) {
    if (typeof id !== 'string' || !id) return;
    let t = m.tools.get(id);
    if (!t) {
      if (m.tools.size >= MAX_TOOLS) return;
      t = { id, name, input: null, index: m.tools.size, asked: false, done: false };
      m.tools.set(id, t);
      this.owner.set(id, m.id);
    }
    t.name = name ?? t.name;
    if (input !== undefined && isObj(input)) t.input = input;
  }

  /** Feed every frame from Claude Code. Only the model's own (top-level) output counts. */
  observe(m) {
    if (!isObj(m) || m.parent_tool_use_id) return;
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'message_start' && typeof e.message?.id === 'string') {
        this.current = this.message(e.message.id);
        this.current.open = true;
      } else if (e?.type === 'content_block_start' && this.current && e.content_block?.type === 'tool_use') {
        // Started, not finished: the call is known but its input is not, so it cannot be listed yet.
        this.track(this.current, e.content_block.id, e.content_block.name, undefined);
      } else if (e?.type === 'message_stop' && this.current) {
        this.release(this.current);
        this.current = null;
      }
    } else if (m.type === 'assistant' && typeof m.message?.id === 'string') {
      const msg = this.message(m.message.id);
      for (const b of Array.isArray(m.message.content) ? m.message.content : []) {
        if (b?.type === 'tool_use') this.track(msg, b.id, b.name, b.input);
      }
    } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) if (b?.type === 'tool_result') this.finish(b.tool_use_id);
    }
  }

  find(id) {
    const mid = this.owner.get(id);
    const msg = mid ? this.messages.get(mid) : null;
    return msg ? { msg, tool: msg.tools.get(id) } : null;
  }

  /** This call's ask has arrived: it is no longer waiting to be asked about. */
  asked(id) { const f = this.find(id); if (f?.tool) f.tool.asked = true; }

  /** This call has run, or been refused: it is not a sibling any more. */
  finish(id) { const f = this.find(id); if (f?.tool) f.tool.done = true; }

  /** Is the message holding this call still being written? */
  writing(id) { return this.find(id)?.msg.open === true; }

  /** Resolves when the message holding `id` has been written in full, `ms` have passed, or `signal` aborts. */
  settled(id, ms, signal) {
    const f = this.find(id);
    if (!f || !f.msg.open || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const msg = f.msg;
      let timer = null;
      const end = () => {
        msg.waiters.delete(end);
        clearTimeout(timer);
        try { signal?.removeEventListener?.('abort', end); } catch { /* not an EventTarget */ }
        resolve();
      };
      msg.waiters.add(end);
      timer = setTimeout(end, ms);
      signal?.addEventListener?.('abort', end, { once: true });
    });
  }

  /**
   * The calls of `id`'s message (`id` itself was given `input`) that one answer should cover along with it: file changes of the same message, fully
   * written, not yet asked about and not yet run, inside the project. In the order the model wrote them, `id` among
   * them. Empty when `id` stands alone.
   */
  group(id, input, roots) {
    const f = this.find(id);
    if (!f?.tool) return [];
    const rows = [...f.msg.tools.values()]
      .map((t) => (t.id === id ? { ...t, input } : t))
      .filter((t) => t.id === id || (!t.asked && !t.done))
      .filter((t) => t.input && changePath(t.name, t.input) && inProject(changePath(t.name, t.input), roots))
      .sort((a, b) => a.index - b.index);
    if (rows.length < 2 || !rows.some((t) => t.id === id)) return [];
    return rows.map((t) => ({ id: t.id, name: t.name, input: t.input }));
  }
}

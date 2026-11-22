// Parallel chats, host side. Wraps core's SessionManager (several live sessions behind one event stream: Claude Code
// chats, and Codex chats through the same surface) with what the window needs:
//   - which chat is on screen (only its events drive the transcript; every event carries `sid`)
//   - a status per chat for the sidebar: working · needs you · done (unread). A plan waiting to be looked over is
//     "needs you" with the line "Plan ready", for both makers; a turn that ends with one is not "done"
//   - Mac notifications when a chat you're not looking at finishes or needs approval
//   - the Dock badge (how many chats need you) and a "still working" count for the quit prompt
//   - the same list, with titles, for the menu bar icon (src/tray.mjs) through onStatus
import path from 'node:path';
import { SessionManager } from './core/manager.mjs';
import { previewOf } from './last-active.mjs';
import { titleCase } from './title-case.mjs';

// What a chat is doing right now, in plain words, for Home ("Editing slack.ts", "Running npm test").
const base = (p) => String(p ?? '').split('/').pop();
function doing(name, input = {}) {
  if (name === 'Bash') return `Running ${clip(String(input.command ?? '').split('&&').pop().trim(), 48) || 'a command'}`;
  if (name === 'Read') return `Reading ${base(input.file_path) || 'a file'}`;
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return `Editing ${base(input.file_path ?? input.notebook_path) || 'a file'}`;
  if (name === 'Grep' || name === 'Glob') return 'Searching the code';
  if (name === 'WebSearch') return 'Searching the web';
  if (name === 'WebFetch') return 'Reading a web page';
  if (name === 'Task' || name === 'Agent') return 'Starting an agent';
  if (name === 'Workflow') return 'Starting a workflow';
  if (name === 'TodoWrite') return 'Updating the to-do list';
  if (name === 'mcp__canopy__run') return clip(input.description, 48) || 'Running a script'; // Code Mode: Claude's own name for the script
  if (name === 'mcp__canopy_chats__read_chat') return 'Reading another chat'; // read_chat (src/core/read-chat.mjs)
  if (name === 'mcp__canopy_look__look') return input.window ? 'Looking at a window' : 'Looking at a page'; // look (src/core/look.mjs)
  if (name === 'mcp__canopy_memory__remember') return 'Saving to memory'; // remember and recall (src/core/memory-tools.mjs)
  if (name === 'mcp__canopy_memory__recall') return 'Checking memory';
  if (name === 'mcp__canopy_memory__forget') return 'Removing from memory';
  if (String(name).startsWith('mcp__')) return `Using ${String(name).split('__')[1] ?? 'a connector'}`;
  return 'Working';
}

// A chat that reported its work with the task tool (src/core/task-tool.mjs) shows that, not its latest step, until the
// work is done: "Creating Website · Writing the page".
const TASK_TOOL = 'mcp__canopy_task__task';
function taskOf(prev, input = {}) {
  if (input.done === true) return null;
  const title = clip(input.title, 40) || prev?.title || '';
  const status = clip(input.status, 60) || prev?.status || '';
  return title || status ? { title, status } : prev ?? null;
}
const taskLine = (t) => [t.title, t.status].filter(Boolean).join(' · ');

/** A GitHub pull request link in a command's output or a reply, if any. */
const prLink = (v) => { const m = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(typeof v === 'string' ? v : JSON.stringify(v ?? '')); return m ? m[0] : null; };

/** A question for you (AskUserQuestion, or an OpenAI chat's question), not an OK or a plan to look over. */
const isQuestion = (ask) => !!ask && ask.kind !== 'plan' && (ask.toolName === 'AskUserQuestion' || ask.kind === 'question');

/** What a waiting chat wants from you, in words ("Wants your OK: npm install"). */
function askLine(ask) {
  if (!ask) return 'Waiting for you';
  // A plan to look over, whoever made it (never the tool's name).
  if (ask.kind === 'plan') return 'Plan ready';
  // A question says what it asks (its title is just the tool's name, AskUserQuestion).
  if (isQuestion(ask)) return ask.question ? `Asked you: ${ask.question}` : 'Asked you something';
  // What a connected tool asks (a form, a sign-in link) and what asks for itself (Computer Use and an app) already
  // say who wants what: "Linear needs a few details", "Computer Use wants to use Google Chrome".
  if (ask.kind === 'elicitation') return ask.title || ask.message || 'A connected tool needs you';
  if (ask.plain && ask.title) return ask.title;
  const what = ask.detail || ask.title || ask.toolName;
  return what ? `Wants your OK: ${what}` : 'Wants your OK';
}

/** What a chat is waiting on you for, as Home and the sidebar keep it. `passive`: a card Canopy raised itself (an
 *  OpenAI chat's plan, a question asked in passing), which waits on after its turn has ended. */
function askOf(ev) {
  return { id: ev.id, title: ev.title || ev.displayName || null, toolName: ev.toolName ?? null, kind: ev.type ?? null, server: ev.server ?? null, message: ev.message ? clip(ev.message, 160) : null, since: Date.now(),
    // A change to several files (an OpenAI chat's) says how many, not just the first one.
    detail: Array.isArray(ev.changes) && ev.changes.length > 1 ? `changes to ${Math.max(ev.changes.length, Number(ev.changeCount) || 0)} files`
      : ev.input ? clip(ev.input.command ?? ev.input.file_path ?? ev.input.url ?? ev.input.description ?? '', 120) : '',
    question: Array.isArray(ev.input?.questions) && ev.input.questions[0]?.question ? clip(ev.input.questions[0].question, 160) : null,
    ...(ev.passive === true && { passive: true }), ...(ev.plain === true && { plain: true }) };
}

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** Which engine runs a session: a Codex session says so, a Claude one says nothing. */
export const engineOf = (session) => (session?.engine === 'codex' ? 'codex' : 'claude');

export class ChatHost {
  /**
   * @param {{ create: (opts: object) => import('./core/session.mjs').Session, send: (channel: string, payload: unknown) => void,
   *   notify?: (n: {title: string, body: string, onClick: () => void}) => void, badge?: (count: number) => void,
   *   isFocused?: () => boolean, isOnScreen?: () => boolean, onEvent?: (ev: object, entry: object) => void, onStatus?: (list: object[]) => void,
   *   onUsed?: (feature: string) => void, maxIdle?: number }} opts
   *   `onUsed`: something of the host's own was used (today: 'notification_clicked'), for usage stats. A name, nothing more.
   */
  constructor({ create, send, notify, badge, isFocused, isOnScreen, onEvent, onStatus, onUsed, maxIdle = 8 }) {
    this.send = send;
    this.notify = notify ?? (() => {});
    this.badge = badge ?? (() => {});
    this.isFocused = isFocused ?? (() => true);
    // The window is open on screen (not hidden or minimized), whether or not it is the app in front.
    this.isOnScreen = isOnScreen ?? this.isFocused;
    this.onEvent = onEvent ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onUsed = onUsed ?? (() => {});
    this.status = new Map(); // sid -> { sid, sessionId, cwd, state, unread, title, last, helpers }
    this.shown = new Set(); // Multi mode: chats in panes, on screen beside (or instead of) the active one
    this.cached = new Set(); // Mounted pane stores, including those hidden when Multi mode is off
    this.queues = new Map(); // sid -> { v, items: [{ id, text, images }], timer }: messages typed while the chat works
    this.queueId = 0;
    this.editing = new Set(); // sids whose message is being edited: the stop in the middle is not the chat going idle
    this.manager = new SessionManager({ maxIdle, create });
    this.manager.on('event', (ev) => this.#event(ev));
    this.manager.on('closed', ({ sid, sessionId }) => {
      this.status.delete(sid);
      this.#dropQueue(sid);
      // A pane's chat was let go (idle too long among many chats): its pane reopens it.
      const wasShown = this.shown.delete(sid);
      if (this.cached.delete(sid) || wasShown) this.send('pane:closed', { sid, sessionId: sessionId ?? null });
      this.#publish();
    });
  }

  /** The session on screen (what the old single `current` was). */
  get current() { return this.manager.active; }
  get activeSid() { return this.manager.activeSid; }

  /**
   * Open or switch to a chat. A chat that's still live (even mid-turn) is reused, never restarted.
   * `extra` goes to `create` with the folder and the chat's id: `{ engine: 'codex' }` asks for a Codex chat.
   * @returns {Promise<{session: object, sid: string, reused: boolean}>}
   */
  async open(cwd, resume, extra = {}) {
    if (resume) await this.manager.whenClosed(resume); // one process per transcript
    const r = this.manager.open({ ...extra, cwd, resume: resume || null });
    const st = this.status.get(r.sid) ?? { sid: r.sid, sessionId: resume || null, cwd, state: 'idle', unread: false, title: null, last: null };
    st.engine = engineOf(r.session);
    st.unread = false; // you're looking at it now
    this.status.set(r.sid, st);
    this.#publish();
    return r;
  }

  /**
   * Multi mode: open a chat into a pane without taking over the main screen (the active chat stays as it was).
   * A chat that's still live is reused. @returns {Promise<{session: object, sid: string, reused: boolean}>}
   */
  async openPane(cwd, resume, extra = {}) {
    if (resume) await this.manager.whenClosed(resume);
    const r = this.manager.open({ ...extra, cwd, resume: resume || null }, { activate: false });
    const st = this.status.get(r.sid) ?? { sid: r.sid, sessionId: resume || null, cwd, state: 'idle', unread: false, title: null, last: null };
    st.engine = engineOf(r.session);
    st.unread = false;
    this.status.set(r.sid, st);
    this.shown.add(r.sid);
    this.cached.add(r.sid);
    this.manager.onScreen = this.cached;
    this.#publish();
    return r;
  }
  /** Which chats the panes show now (events for these reach the window; they never go unread). */
  setShown(sids, cached = sids) {
    this.shown = new Set((sids ?? []).filter((x) => typeof x === 'string'));
    this.cached = new Set([...(cached ?? []).filter((x) => typeof x === 'string'), ...this.shown]);
    this.manager.onScreen = this.cached; // mounted stores stay live, even while the other layout is showing
    let changed = false;
    for (const sid of this.shown) { const e = this.status.get(sid); if (e?.unread) { e.unread = false; changed = true; } }
    if (changed) this.#publish();
  }
  /** On screen: the main chat, or any chat in a pane. */
  #visible(sid) { return sid === this.manager.activeSid || this.shown.has(sid); }
  /**
   * Let go of a chat nobody has used: it never started (no id, no message sent or waiting, nothing asked) and is
   * not the chat on screen. For swapping an empty new chat for one on the other engine without leaving its process
   * behind. `pane`: the chat is the one a pane is giving up, so being shown there does not keep it.
   * @returns {boolean} whether it was closed
   */
  discardIfUntouched(sid, { pane = false } = {}) {
    const s = typeof sid === 'string' ? this.manager.get?.(sid) : null;
    if (!s || s.closed || sid === this.manager.activeSid || (!pane && this.shown.has(sid))) return false;
    const st = this.status.get(sid);
    if (s.sessionId || st?.sessionId || s.busy || (s.pending?.size ?? 0) > 0 || (s.outbox?.size ?? 0) > 0 || this.queues.get(sid)?.items.length) return false;
    this.shown.delete(sid); // let go on purpose: its pane must not be told to reopen it
    this.cached.delete(sid);
    this.manager.close(sid, { graceMs: 1500 }).catch(() => {});
    return true;
  }
  /** A message was sent to a pane's chat (its first message names it until Claude Code does). */
  noteSentTo(sid, text) {
    const entry = this.status.get(sid);
    const t = clip(text, 80);
    if (entry && !entry.title && t) { entry.title = t; this.#publish(); }
  }

  // ---- Message queue: typed while a chat works, sent one at a time when its turn ends ----
  // It lives here, not in the window, so it survives switching chats and still goes out while you look at another one.
  // `v` counts changes: the window ignores an older state that arrives after a newer one.
  #queue(sid) { let q = this.queues.get(sid); if (!q) this.queues.set(sid, q = { v: 0, items: [], timer: null }); return q; }
  #dropQueue(sid) { const q = this.queues.get(sid); if (q?.timer) clearTimeout(q.timer); this.queues.delete(sid); }
  /** What a chat has waiting (for the window's queue row, and for a snapshot when it opens the chat again). */
  queueOf(sid) { const q = this.queues.get(sid); return { queue: q ? q.items.slice() : [], v: q?.v ?? 0 }; }
  /** Queue a message behind the chat's current turn. It goes out on its own once the chat is free. */
  queueAdd(sid, text, images) {
    if (!this.manager.get?.(sid)) return { error: 'This chat isn’t open anymore.' };
    const q = this.#queue(sid);
    q.items.push({ id: ++this.queueId, text, images: images ?? [] });
    q.v++;
    this.noteSentTo(sid, text);
    this.#flushSoon(sid); // the chat may have finished while this was on its way
    return { ok: true, ...this.queueOf(sid) };
  }
  /** Take a message back out. `removed` is false if it already went out. */
  queueRemove(sid, id) {
    const q = this.queues.get(sid);
    const i = q ? q.items.findIndex((x) => x.id === id) : -1;
    if (i < 0) return { ok: true, removed: false, ...this.queueOf(sid) };
    q.items.splice(i, 1);
    q.v++;
    return { ok: true, removed: true, ...this.queueOf(sid) };
  }
  /** Move a waiting message to place `to` (0: it goes out next). `moved` is false if it already went out. */
  queueMove(sid, id, to) {
    const q = this.queues.get(sid);
    const i = q ? q.items.findIndex((x) => x.id === id) : -1;
    if (i < 0) return { ok: true, moved: false, ...this.queueOf(sid) };
    const n = Number.isInteger(to) ? Math.max(0, Math.min(q.items.length - 1, to)) : i;
    if (n !== i) { const [m] = q.items.splice(i, 1); q.items.splice(n, 0, m); q.v++; }
    return { ok: true, moved: true, ...this.queueOf(sid) };
  }
  #flushSoon(sid) {
    const q = this.queues.get(sid);
    if (!q || q.timer || !q.items.length) return;
    q.timer = setTimeout(() => { q.timer = null; this.#flush(sid); }, 120);
  }
  #flush(sid) {
    const q = this.queues.get(sid);
    const s = this.manager.get?.(sid);
    if (!q || !q.items.length || !s || s.closed) return;
    if (s.reportedBusy?.() ?? s.busy) return; // still working: the next busy:false tries again
    if (this.editing.has(sid)) return; // an edit stops the reply and sends the new message: the queue goes after that one
    const next = q.items.shift();
    q.v++;
    const r = s.send(next.text, next.images);
    // The window shows what went out (a chat off screen reads it from its transcript when you come back). `uuid` is
    // the message's id in the conversation, so its bubble can be edited.
    if (this.#visible(sid) || this.cached.has(sid)) this.send('session:event', { sid, kind: 'queue', ...this.queueOf(sid), sent: { ...next, uuid: r?.id ?? null } });
  }

  // ---- Edit and resend ----
  /**
   * Replace one of your messages: it and everything after it leave the conversation, and the new text is answered
   * instead (core's Session.edit for a Claude chat, CodexSession.edit for an OpenAI one). A reply in flight is
   * stopped first. Messages waiting in the queue stay there and go out after the new reply.
   * @param {{ messageId: string, text: string, images?: object[], restoreFiles?: boolean, id?: string }} opts
   */
  async edit(sid, opts) {
    const s = this.manager.get?.(sid);
    if (!s) return { ok: false, code: 'gone', message: 'This chat isn’t open anymore.' };
    // An engine with no way to cut a conversation back says so (the window doesn't offer Edit there).
    if (typeof s.edit !== 'function') return { ok: false, code: 'unsupported', message: 'Messages in this chat can’t be edited yet.' };
    this.editing.add(sid);
    try {
      const r = await s.edit(opts);
      // The first message was replaced. A Claude chat is then a new conversation with no name yet, and an OpenAI
      // chat that is still called after its old first message (`replaced`) would be called after words that are no
      // longer in it. Either way the new message stands in.
      const entry = this.status.get(sid);
      const t = clip(opts?.text, 80);
      const standIn = r?.first && typeof r.replaced === 'string' && !!entry?.title && entry.title === clip(r.replaced, 80);
      if (r?.ok && (r.fresh || standIn) && entry && t) { entry.title = t; this.#publish(); }
      return r;
    } finally {
      this.editing.delete(sid);
      this.#flushSoon(sid); // if the edit failed, nothing else would wake the queue
    }
  }
  /** The files Claude changed since this message (what "also undo" would put back), or null when there are none. */
  async editPreview(sid, messageId) {
    const s = this.manager.get?.(sid);
    if (!s || typeof s.rewindFiles !== 'function') return null;
    const r = await s.rewindFiles(messageId, { dryRun: true });
    return r?.canRewind && r.filesChanged?.length ? { files: r.filesChanged.map(String), insertions: r.insertions ?? 0, deletions: r.deletions ?? 0 } : null;
  }

  /**
   * A chat of this engine whose process is up right now and that passes `test`: the one on screen if it does, else
   * the most recently used. For asking something of a process that is already running (the Usage tab asks a chat
   * how much of the plan is used) rather than starting one to ask. Null when there is none.
   */
  liveOn(engine, test = () => true) {
    const up = (sid) => {
      const s = sid ? this.manager.get?.(sid) : null;
      try { return s && !s.closed && s.q && engineOf(s) === engine && test(s) ? s : null; } catch { return null; }
    };
    const first = up(this.manager.activeSid);
    if (first) return first;
    for (const row of this.manager.list?.() ?? []) { const s = up(row.sid); if (s) return s; }
    return null;
  }

  /** How many chats are busy (for "2 chats are still working. Quit anyway?"). */
  workingCount() { return [...this.status.values()].filter((s) => s.state === 'working' || s.state === 'needs-you' || s.helpers > 0).length; }
  /** What is going on right now, as counts, for telemetry's `live` event: chats open, working and waiting on you, and
   *  what is still running in the background by kind. */
  liveCounts() {
    const open = [...this.status.values()].filter((s) => s.sessionId);
    const work = open.flatMap((s) => s.work ?? []);
    const of = (kind) => work.filter((w) => w.kind === kind).length;
    return {
      chats_open: open.length, chats_working: open.filter((s) => s.state === 'working').length,
      chats_waiting: open.filter((s) => s.state === 'needs-you').length,
      agents: of('agent'), workflows: of('workflow'), commands: of('command'),
    };
  }

  /** Cost and working time this chat's live process has reported (null if it isn't open here). */
  totals(sessionId) {
    const e = [...this.status.values()].find((s) => s.sessionId === sessionId);
    return e ? { cost: e.cost ?? 0, workMs: e.workMs ?? 0 } : null;
  }

  closeAll() { return this.manager.closeAll({ graceMs: 1500 }); }

  /** Remember what the chat was about, for notifications ("Fix sidebar finished") and the menu bar. */
  setTitle(sessionId, title) {
    let changed = false;
    title = titleCase(title); // a name, in Title Case as the chat list shows it (src/title-case.mjs)
    for (const s of this.status.values()) if (s.sessionId === sessionId && title && s.title !== title) { s.title = title; changed = true; }
    if (changed) this.#publish();
  }

  /** A message was sent to the chat on screen. Until Claude Code has named the chat, its first message stands in. */
  noteSent(text) {
    const entry = this.status.get(this.manager.activeSid);
    const t = clip(text, 80);
    if (entry && !entry.title && t) { entry.title = t; this.#publish(); }
  }

  /** Today's timeline for a chat: when it worked and when it waited on you. Closes the open span, opens a new one. */
  #span(entry, kind) {
    const now = Date.now();
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const spans = (entry.spans ?? []).filter((x) => (x.to ?? now) >= day.getTime());
    const open = spans[spans.length - 1];
    if (open && open.to == null) { if (open.kind === kind) return; open.to = now; }
    if (kind) spans.push({ from: now, to: null, kind });
    entry.spans = spans.slice(-60);
  }

  #event(ev) {
    const entry = this.status.get(ev.sid) ?? { sid: ev.sid, sessionId: null, cwd: null, state: 'idle', unread: false, title: null, last: null };
    const active = this.#visible(ev.sid);
    const before = entry.state;
    const helpersBefore = entry.helpers || 0;
    let waits = false; // a turn ended with a card still waiting on you: no "done", no sound, no second notification
    switch (ev.kind) {
      case 'init': if (ev.sessionId) entry.sessionId = ev.sessionId; break;
      case 'meta': if (ev.sessionId) entry.sessionId = ev.sessionId; break;
      case 'busy':
        if (!ev.busy && this.editing.has(ev.sid)) break; // stopped only to be sent the edited message: still working
        if (ev.busy) entry.failed = null;
        if (ev.busy && entry.state !== 'working' && entry.state !== 'needs-you') { entry.turnAt = Date.now(); entry.activity = 'Thinking'; entry.task = null; entry.steps = 0; entry.files = []; entry.pr = null; }
        entry.state = ev.busy ? (entry.state === 'needs-you' ? 'needs-you' : 'working') : entry.state === 'working' ? 'idle' : entry.state;
        if (entry.state !== 'needs-you') this.#span(entry, ev.busy ? 'work' : null);
        break;
      case 'tool-start':
        if (!ev.parent) {
          if (ev.name === TASK_TOOL) entry.task = taskOf(entry.task, ev.input);
          entry.activity = entry.task ? taskLine(entry.task) : doing(ev.name, ev.input);
          entry.steps = (entry.steps || 0) + 1;
          const f = ev.input?.file_path ?? ev.input?.notebook_path;
          if (f && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(ev.name)) { const b = base(f); entry.files = [...new Set([...(entry.files ?? []), b])].slice(0, 12); }
          this.#homeSoon();
        }
        break;
      case 'tool-result': { const u = prLink(ev.content); if (u) entry.pr = u; break; }
      case 'thinking-delta': if (!entry.task && entry.activity !== 'Thinking' && !ev.parent) { entry.activity = 'Thinking'; this.#homeSoon(); } break;
      case 'text-delta': if (!entry.task && entry.activity !== 'Writing a reply' && !ev.parent) { entry.activity = 'Writing a reply'; this.#homeSoon(); } break;
      case 'assistant-text': entry.last = ev.text ?? entry.last; break;
      // A message was edited: the reply the sidebar quotes went with it. The edited message's reply takes its place.
      case 'edit': entry.last = null; break;
      case 'title': if (ev.title && entry.title !== titleCase(ev.title)) { entry.title = titleCase(ev.title); this.#publish(); } break;
      case 'permission':
        entry.state = 'needs-you';
        this.#span(entry, 'wait');
        entry.ask = askOf(ev);
        break;
      case 'permission-resolved': {
        if (entry.ask?.id === ev.id) entry.ask = null;
        const s = this.manager.get?.(ev.sid);
        // Answered mid-turn (every approval, and most questions): the chat carries on working.
        if (!s || s.busy !== false) { entry.state = 'working'; this.#span(entry, 'work'); break; }
        // Answered with no turn running (a plan that was kept, a question skipped after its turn): nothing is
        // working. Another such card may still be waiting; otherwise the chat is simply idle.
        const left = [...(s.pending?.values?.() ?? [])].map((p) => p?.ev).filter((e) => e && e.id !== ev.id).at(-1);
        if (left) { entry.ask ??= askOf(left); entry.state = 'needs-you'; }
        else { entry.state = 'idle'; this.#span(entry, null); }
        break;
      }
      case 'turn-end':
        // The turn left something for you to answer (a plan to look over, a question asked in passing and not
        // yet answered): the chat is waiting on you, not done. That card's own "needs you" is the one thing said.
        if (ev.plan === true || (entry.ask?.passive && !ev.interrupted && !ev.isError)) {
          waits = true;
          if (!ev.plan) entry.state = 'needs-you'; // the question is already up; a plan's card arrives next and says so itself
          entry.activity = null;
          if (ev.text) entry.last = ev.text;
        }
        // The reply an edit cut off is not the chat stopping: the edited message's reply follows at once.
        else if (!(ev.interrupted && this.editing.has(ev.sid))) {
          entry.state = ev.interrupted ? 'idle' : 'done'; if (!active && !ev.interrupted) entry.unread = true;
          if (ev.isError) entry.failed = previewOf(ev.text) ?? 'It hit a problem and stopped.';
          entry.doneAt = Date.now(); entry.stopped = !!ev.interrupted; entry.ask = null; entry.activity = null; this.#span(entry, null);
          if (ev.text) { entry.last = ev.text; entry.pr = prLink(ev.text) ?? entry.pr ?? null; }
        }
        // Cost and working time for every chat, on screen or not (Stats reads them; the renderer only sees the chat on screen).
        if (Number.isFinite(ev.cost)) entry.cost = Math.max(entry.cost ?? 0, ev.cost); // the process's running total
        if (Number.isFinite(ev.durationMs)) entry.workMs = (entry.workMs ?? 0) + ev.durationMs;
        break;
      case 'error':
        if (ev.fatal !== false) entry.state = 'idle';
        // A chat another app has open did not go wrong: its row says where it is open instead (src/codex-held.mjs).
        if ((ev.recoverable === false || ev.fatal) && ev.code !== 'held-elsewhere') entry.failed = previewOf(ev.message) ?? 'It hit a problem and stopped.';
        break;
      case 'tasks': {
        const live = (ev.tasks ?? []).filter((t) => t.status === 'running' || t.status === 'pending');
        entry.helpers = live.length;
        entry.work = live.map((t) => ({ kind: t.taskType === 'local_workflow' || t.workflow ? 'workflow' : t.taskType === 'local_bash' ? 'command' : 'agent', name: clip(t.workflow || t.description || '', 60), id: t.taskId }));
        this.#homeSoon();
        break;
      }
      default: break;
    }
    if (!entry.cwd) entry.cwd = this.manager.get?.(ev.sid)?.cwd ?? null;
    if (!entry.engine) entry.engine = ev.engine === 'codex' ? 'codex' : engineOf(this.manager.get?.(ev.sid));
    this.status.set(ev.sid, entry);

    // Hidden mounted panes keep up too; visibility alone still controls unread state and completion sounds.
    if (active || this.cached.has(ev.sid)) this.send('session:event', ev);
    this.onEvent(ev, entry);
    if (ev.kind === 'busy' && !ev.busy) this.#flushSoon(ev.sid);

    if (entry.state !== before || ev.kind === 'turn-end' || ev.kind === 'init') {
      this.#publish();
      if (!waits) this.#maybeNotify(ev, entry);
      // The window plays the completion sound (its choice lives there). Not for a chat you are looking at: the reply
      // is in front of you. A chat in the background, or any chat while Canopy isn't the app in front, does play it.
      if (ev.kind === 'turn-end' && !waits && !ev.interrupted && !ev.isError && !ev.synthetic && !(active && this.isFocused())) this.send('chats:done', { sid: ev.sid });
    } else if ((entry.helpers || 0) !== helpersBefore) this.#publish(); // the menu bar counts running helpers
    else if (ev.kind === 'permission') this.#publish(); // a second card while one already waits: the line says the newest
  }

  #maybeNotify(ev, entry) {
    // A chat that needs you (an OK for a command, a question, a plan) is stuck until you answer: it notifies whenever
    // Canopy isn't the app in front, even with its window open behind another app. A chat that is done notifies only
    // while Canopy is out of sight (hidden or minimized); with its window open the completion sound says it.
    const name = entry.title || (entry.cwd ? path.basename(entry.cwd) : 'Canopy');
    const open = () => {
      try { this.onUsed('notification_clicked'); } catch { /* counting a click never keeps it from opening the chat */ }
      this.send('chats:focus', { sessionId: entry.sessionId, cwd: entry.cwd });
    };
    if (ev.kind === 'turn-end' && !ev.interrupted) {
      if (!this.isOnScreen()) this.notify({ title: `${clip(name, 60)} is done`, body: clip(entry.last, 140) || 'Finished.', onClick: open });
    }
    // A plan says so in Home's words, for both makers (never "wants to use ExitPlanMode").
    else if (ev.kind === 'permission' && !this.isFocused()) this.notify({ title: `${clip(name, 60)} needs you`, body: clip(ev.type === 'plan' ? 'Canopy has a plan for you to look over.' : ev.title || `Canopy wants to use ${ev.toolName ?? 'a tool'}.`, 140), onClick: open });
  }

  /** Everything Home shows about each chat (one row per chat that has started). */
  home() {
    return [...this.status.values()].filter((s) => s.sessionId).map((s) => ({
      sid: s.sid, sessionId: s.sessionId, cwd: s.cwd, title: s.title, state: s.state, unread: s.unread, active: s.sid === this.manager.activeSid,
      activity: s.activity ?? null, turnAt: s.turnAt ?? null, doneAt: s.doneAt ?? null, stopped: !!s.stopped,
      last: s.last ? clip(String(s.last).split('\n').find((l) => l.trim()) ?? '', 160) : null,
      ask: s.ask ?? null, work: s.work ?? [], helpers: s.helpers || 0,
      steps: s.steps || 0, files: s.files ?? [], pr: s.pr ?? null, spans: s.spans ?? [], engine: s.engine ?? 'claude',
    }));
  }
  #homeTimer = null;
  #homeSoon() { if (this.#homeTimer) return; this.#homeTimer = setTimeout(() => { this.#homeTimer = null; this.send('home:status', this.home()); }, 300); }

  /** Answer a chat's waiting question, or stop it, from Home (any chat, not just the one on screen). */
  respond(sid, id, answer) { return this.manager.get?.(sid)?.respond(id, answer) ?? { ok: false, code: 'gone' }; }
  async stop(sid) { await this.manager.get?.(sid)?.interrupt(); return { ok: true }; }
  /**
   * Something the user did in the app that a chat's model did not see (src/core/notes.mjs: `{ kind: 'undo', files }`,
   * `{ kind: 'text', text: 'The user …' }`). The chat tells its model with the next message it sends, whichever
   * maker runs it. A chat that is not open has nothing to tell: its notes went when it was closed.
   */
  note(sid, note) { return this.manager.get?.(sid)?.note?.(note) ?? { ok: false, code: 'gone', message: 'This chat isn’t open anymore.' }; }
  /** Stop a chat's background work (workflows, agents, commands) by task id. */
  async stopTasks(sid, ids) { const s = this.manager.get?.(sid); if (!s) return { ok: false }; for (const id of ids ?? []) await s.stopTask(id).catch(() => {}); return { ok: true }; }

  /** The sidebar's list, for a window that just (re)loaded: it only hears changes otherwise. */
  statusList() { return this.#list(); }
  #list() {
    // `line`: where it stands in words, for the sidebar's second line: what it's waiting on you for, what went wrong,
    // or the first line of its last reply. (Working says "Working…" on the window side.) `asking`: what it waits on
    // you for is a question, so the row's mark is a "?" instead of a dot.
    return [...this.status.values()].filter((s) => s.sessionId).map((s) => ({
      sid: s.sid, sessionId: s.sessionId, cwd: s.cwd, state: s.state, unread: s.unread, helpers: s.helpers || 0, active: s.sid === this.manager.activeSid,
      failed: !!s.failed, line: s.state === 'needs-you' ? askLine(s.ask) : s.failed ?? previewOf(s.last), engine: s.engine ?? 'claude',
      asking: s.state === 'needs-you' && isQuestion(s.ask),
    }));
  }

  #publish() {
    this.#homeSoon();
    // `helpers`: agents, workflows and commands still running after the reply ended (the chat is still working).
    const list = this.#list();
    this.send('chats:status', list);
    // The Dock badge: chats that need you, went wrong, or replied while you weren't looking.
    this.badge(list.filter((s) => s.state === 'needs-you' || s.failed || s.unread).length);
    this.onStatus([...this.status.values()].map((s) => ({ ...s, active: s.sid === this.manager.activeSid })));
  }
}

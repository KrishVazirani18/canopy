// Engine events for Canopy Telemetry: what a chat did, never what was said in it.
//
// Claude Code chats and Codex chats reach the window through one event stream (src/chats.mjs #event). This follows
// that stream, with one small record per live chat, and turns it into the few events the schema allows:
//   chat_started         a chat got its first message since it was opened: new, picked back up, or forked
//   message_sent         a message went out: how long (a bucket), how many images, queued or not. Never the words.
//   reply_finished       a reply ended: how long it took, which kinds of tool it ran, done / stopped / error
//   permission_answered  a prompt was answered: allow / always / deny, and the kind of tool it was about
//   milestones           first_chat (a chat is open), first_message, first_reply (the core sends each once per install)
//   errors               a chat that crashed or could not start, by Canopy's own code for it and nothing else
// It also tells the core which conversations are Canopy's (noteSession), so the daily summary can tell them from
// the terminal's in the history on disk. The one rule for that is here, under "conversations Canopy ran".
//
// What this file keeps to:
//   - Nothing is read from an event but its kind, flags, ids, tool names and model: never text, input, output or a
//     path. A message's text is measured (its length) and let go; nothing here holds on to it.
//   - Nothing throws into a chat: every entry point is wrapped, and a bug here is reported, not raised.
//   - Constant work per event and no timers. A streaming delta returns at the first line.
//
// Where main.mjs calls in (this file touches neither main nor chats):
//   the chats onEvent callback     onEvent(ev, entry)                          every event of every chat
//   chats.manager 'closed'         onClose(sid)
//   openSession(), pane:open       onOpen({ sid, kind })                       a chat opened fresh, not one reused
//   session:send, pane:send        onSend({ sid, text, images })               once the engine took the message
//   session:queue, pane:queue      onSend({ sid, text, images, queued: true })
//   session:edit, pane:edit        onSend({ sid, text, images })               once the edit went through
//   session/pane/home:respond      onPermissionAnswer({ sid, id, answer })
//   quitting (closeTelemetry)      onQuit()                                    before telemetry's last flush
import { ENGINES, lengthBucket, toolKind } from './schema.mjs';

const MAX_CHATS = 200; // records kept at once. A chat that closes is dropped at once; this only catches a close nobody reported.
const MAX_HELD = 16;   // events of one chat waiting to learn its model
const MAX_ASKS = 32;   // prompts of one chat remembered until they are answered

// The only event kinds read here. Everything else, every streaming delta included, returns at once.
const READ = new Set(['busy', 'init', 'meta', 'message-start', 'tool-start', 'permission', 'turn-end', 'error', 'notice', 'setting']);
const KINDS = new Set(['new', 'resumed', 'forked']);
// The answers that let the thing go ahead once: a question answered and a plan approved are a yes.
const YES = new Set(['allow', 'answers', 'plan-approve', 'elicit-accept']);
// A crash the engine calls recoverable (sending again restarts it) is still a chat that broke under someone.
const CRASHES = new Set(['crashed', 'crash-loop', 'turn-lost', 'timeout']);
// Canopy's own error codes look like this ("crash-loop"). Anything else is not passed on.
const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const NOTHING = Object.freeze({});

const word = (v) => (typeof v === 'string' && v ? v : undefined);
const engineName = (v) => (ENGINES.includes(v) ? v : undefined);
/** How many: of a list, or a count already made. Undefined when it was not said. */
const howMany = (v) => (Array.isArray(v) ? v.length : Number.isInteger(v) && v >= 0 ? v : undefined);
/** Props as they may be tracked: what is not known is left out, never sent as null. */
function known(props) {
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  return props;
}

/**
 * What is reported for a chat that failed: which engine, and Canopy's own code for what happened. Never the engine's
 * sentence, which can quote a folder, stderr, or the message that was being sent.
 */
function failure(engine, ev) {
  const code = typeof ev.code === 'string' && CODE.test(ev.code) ? ev.code : 'unknown';
  const cause = typeof ev.cause === 'string' && CODE.test(ev.cause) && ev.cause !== code ? ev.cause : null;
  const codex = engine === 'codex';
  const err = new Error(`${codex ? 'Codex' : 'Claude Code'} chat failed: ${code}${cause ? ` (${cause})` : ''}`);
  // The code is part of the name so each kind of failure is grouped on its own, however the core fingerprints.
  err.name = `${codex ? 'Codex' : 'Claude'}Chat_${code.replace(/-/g, '_')}`;
  err.stack = `${err.name}: ${err.message}`; // no frames: they would all be this file, and say nothing about the chat
  return err;
}

/**
 * Everything it needs is handed in (main.mjs owns the session manager and the telemetry core):
 *   track(event, props), milestone(step), error(where, err)   the core's own (src/telemetry/index.mjs)
 *   noteSession(engine, sessionId)   a conversation that is Canopy's, for the daily summary (the core's noteCanopySession)
 *   describe(sid)    { engine, model, mode, effort, hasFolder } of a live chat, or null
 *   isVisible(sid)   the chat is on screen: the main chat, or one in a pane
 *   isEditing(sid)   one of its messages is being edited and resent right now (ChatHost.editing)
 *   now()            a clock, for tests
 * Any of them may be missing: what it would have fed is left out, and nothing else changes.
 * @returns {{ onEvent: Function, onOpen: Function, onSend: Function, onPermissionAnswer: Function, onClose: Function, onQuit: Function, size: number }}
 */
export function createEngineTracker(deps) {
  const { track, milestone, error, noteSession, describe, isVisible, isEditing, now } = deps ?? {};
  const clock = typeof now === 'function' ? now : Date.now;
  const records = new Map(); // sid -> what is known of that chat, least recently used first
  const reached = new Set(); // milestones already handed to the core in this run

  /** A bug in here: said once to the core, never raised into the chat that was being followed. */
  function oops(err) { try { error?.('main', err); } catch { /* the reporter itself failed: nothing left to tell */ } }
  function send(event, props) { try { track?.(event, props); } catch (err) { oops(err); } }
  function reach(step) {
    if (reached.has(step)) return;
    reached.add(step);
    try { milestone?.(step); } catch (err) { oops(err); }
  }

  /** What main knows about a live chat. Never throws, and never null. */
  function about(sid) {
    try { const d = typeof describe === 'function' ? describe(sid) : null; return d && typeof d === 'object' ? d : NOTHING; }
    catch (err) { oops(err); return NOTHING; }
  }

  /** The record of one chat, made on first sight. Touching it makes it the most recently used. */
  function chat(sid) {
    let st = records.get(sid);
    if (st) { records.delete(sid); records.set(sid, st); return st; }
    if (records.size >= MAX_CHATS) drop(records.keys().next().value);
    st = {
      engine: null,     // 'claude' | 'codex', once known (a chat never changes engine)
      kind: null,       // how the chat came to be, as onOpen said: new | resumed | forked
      started: false,   // chat_started was sent for the conversation it holds now
      used: false,      // a message went out or a reply ran here: only then can its conversation be one of Canopy's
      sessionId: null,  // the conversation it holds, as the engine last said (null: it has not named one yet)
      began: false,     // that conversation began in Canopy: the chat was opened new, or started over while open
      noted: null,      // the conversation last handed to noteSession
      model: null,      // the model the engine last said it runs: unknown until it says, and again after a change
      held: [],         // [event, props] waiting for the model
      busy: false,      // what the last busy event said
      turn: null,       // the reply in flight: { at, n, tools, model }
      asks: new Map(),  // prompt id -> the kind of tool it is about, until it is answered
    };
    records.set(sid, st);
    return st;
  }

  /** Let go of a chat's record. What it still held goes out first, so a message is counted even if no reply came. */
  function drop(sid) {
    const st = records.get(sid);
    if (!st) return;
    release(st, sid);
    records.delete(sid);
  }

  /** A chat's engine: as its status row says, else as the event says, else as main describes it. */
  function engineOf(st, sid, entry, ev) {
    if (st.engine) return st.engine;
    const said = engineName(entry?.engine) ?? engineName(ev?.engine) ?? engineName(about(sid).engine);
    if (said) st.engine = said;
    return said;
  }

  // ---- the model ----
  // A new chat on the person's own default model does not know which model that is until the engine starts on the
  // first message (seconds later), and neither does a chat whose model was just changed. chat_started and
  // message_sent wait for it rather than go out without one; they never wait past the end of the turn.

  function emit(st, sid, event, props) {
    if (st.model) send(event, { ...props, model: st.model });
    else if (st.held.length < MAX_HELD) st.held.push([event, props]);
    else send(event, known({ ...props, model: word(about(sid).model) }));
  }

  /** Send what was waiting, with the model the engine named, or failing that the one main has for the chat. */
  function release(st, sid) {
    if (!st.held.length) return;
    const model = st.model ?? word(about(sid).model);
    for (const [event, props] of st.held.splice(0)) send(event, known({ ...props, model }));
  }

  function learnModel(st, sid, model) {
    if (typeof model !== 'string' || !model) return;
    st.model = model;
    if (st.turn) st.turn.model = model;
    release(st, sid);
  }

  // ---- conversations Canopy ran ----
  // The daily summary counts messages from the history Claude Code and Codex keep on disk, and needs to know which
  // conversations are Canopy's. This is the one rule, and the one place it is applied (the core only keeps the list):
  //
  //   A conversation is Canopy's once Canopy has sent a message in the chat that holds it, and only when listing
  //   it cannot hand Canopy what was typed somewhere else.
  //
  //   Claude Code   writes down, with every message, where it was typed. A chat begun in the terminal and picked up
  //                 here keeps its terminal messages in the terminal; only what was sent from here becomes Canopy's.
  //                 So any Claude chat written in here is listed, wherever it began.
  //   Codex         names one app for a whole chat, so listing a chat begun in the terminal would turn all of it into
  //                 Canopy's. Only a Codex chat that began here is listed: opened new, or started over while open.
  //
  // A chat that is opened and only read is never listed, on either engine.
  function note(st) {
    if (!st.used || !st.sessionId || st.sessionId === st.noted || !st.engine) return;
    if (st.engine === 'codex' && !st.began) return;
    st.noted = st.sessionId;
    try { noteSession?.(st.engine, st.sessionId); } catch (err) { oops(err); }
  }

  /**
   * Which conversation the chat holds, as the engine just said. One that takes another's place in an open chat began
   * here: after /clear, a first message edited, a branch, or a saved chat that was gone from disk. The engine says so
   * (`previousSessionId`) and names the new one, or null until it has an id.
   */
  function hold(st, ev) {
    const id = word(ev.sessionId) ?? null;
    if (ev.kind === 'meta' && word(ev.previousSessionId)) { st.sessionId = id; st.began = true; return; }
    if (!id || id === st.sessionId) return;
    if (st.sessionId) st.began = true; // another conversation than the one it held, even if nobody said which it replaced
    st.sessionId = id;
  }

  // ---- turns ----

  function begin(st) {
    st.turn = { at: clock(), n: 0, tools: null, model: null };
    st.used = true;
    note(st);
  }

  /** A reply ended. `turn` is null when its start was never seen: the engine's own timing stands in. */
  function finish(st, sid, ev, turn) {
    const ms = turn ? clock() - turn.at : ev.durationMs;
    // To a tenth of a second, as the schema keeps it. A time it would refuse (a clock set back, a Mac asleep for days) is left out.
    const secs = Number.isFinite(ms) && ms >= 0 && ms <= 1e9 ? Math.round(ms / 100) / 10 : undefined;
    const outcome = ev.interrupted ? 'stopped' : ev.isError ? 'error' : 'done';
    let background;
    try { if (typeof isVisible === 'function') background = !isVisible(sid); } catch (err) { oops(err); }
    const props = {
      engine: st.engine ?? undefined,
      model: turn?.model ?? st.model ?? word(about(sid).model),
      secs, tools_n: turn?.n ?? 0, outcome, background,
    };
    if (turn?.tools) for (const kind of Object.keys(turn.tools)) props[`tools_${kind}`] = turn.tools[kind];
    send('reply_finished', known(props));
    if (outcome === 'done') reach('first_reply');
  }

  // ---- entry points ----

  /**
   * Every event of every chat, as src/chats.mjs hands it on (`entry` is the chat's status row there).
   * @param {object} ev @param {object} [entry]
   */
  function onEvent(ev, entry) {
    try {
      if (!ev || !READ.has(ev.kind) || typeof ev.sid !== 'string' || !ev.sid || ev.history) return;
      const sid = ev.sid;
      const st = chat(sid);
      engineOf(st, sid, entry, ev);
      switch (ev.kind) {
        case 'busy':
          if (ev.busy) {
            // Going busy is a turn starting. A turn left open from before (one that never ended) is not this one.
            if (!st.busy || !st.turn) begin(st);
            st.busy = true;
          } else {
            // Idle with a turn still open: it never got a reply (the engine could not start, the send failed).
            st.busy = false;
            st.turn = null;
            release(st, sid);
          }
          break;
        case 'init':
        case 'meta':
          hold(st, ev);
          // Claude Code says `init` as each turn starts, so a message that was waiting behind the last reply starts
          // its turn here. A reopened Codex chat says it once on opening, when nothing is running: that is no turn.
          if (ev.kind === 'init' && st.busy && !st.turn) begin(st);
          note(st);
          learnModel(st, sid, ev.model);
          break;
        case 'message-start':
          if (!st.turn) begin(st);
          learnModel(st, sid, ev.model);
          break;
        case 'tool-start': {
          if (ev.parent) break; // an agent's own tools are its work, not the reply's
          if (!st.turn) begin(st);
          const kind = toolKind(ev.name);
          const tools = st.turn.tools ??= {};
          tools[kind] = (tools[kind] ?? 0) + 1;
          st.turn.n += 1;
          break;
        }
        case 'permission':
          if (ev.id == null) break;
          if (st.asks.size >= MAX_ASKS) st.asks.delete(st.asks.keys().next().value);
          // A form or a sign-in link an MCP server put up is named after the server: it is filed under MCP.
          st.asks.set(ev.id, ev.type === 'elicitation' ? 'mcp' : toolKind(ev.toolName));
          break;
        case 'turn-end': {
          const turn = st.turn;
          st.turn = null;
          release(st, sid); // a message is said before the reply to it
          // Not replies: a turn closed on the engine's behalf (it crashed, or the chat was shut mid-reply), and a
          // slash command Claude Code answered itself (/clear, /context).
          if (ev.synthetic || ev.localCommand) break;
          // A reply cut off so an edited message can be sent is not the person stopping the chat, and not a reply.
          if (ev.interrupted && editing(sid)) break;
          finish(st, sid, ev, turn);
          break;
        }
        case 'error':
          if (ev.fatal === true || ev.recoverable === false || CRASHES.has(ev.code)) {
            try { error?.('engine', failure(st.engine, ev)); } catch (err) { oops(err); }
          }
          break;
        case 'notice':
          // /clear: the same window holds a new conversation from here on, and its first message starts a new chat.
          // It began here, and has no id until the engine's next `init` names it.
          if (ev.code === 'conversation-reset') { st.started = false; st.kind = 'new'; st.sessionId = null; st.began = true; }
          break;
        case 'setting':
          // Until the engine says which model it runs now, the one it named before is the old one.
          if (ev.key === 'model') st.model = null;
          break;
        default: break;
      }
    } catch (err) { oops(err); }
  }

  function editing(sid) {
    try { return typeof isEditing === 'function' && isEditing(sid) === true; } catch (err) { oops(err); return false; }
  }

  /**
   * A chat was opened fresh (not one that was still live), or forked. No event is sent yet: a chat that is opened
   * and never written in is not a chat that started. `kind` is used when its first message goes out. Getting as far
   * as an open chat is the first_chat milestone, though: it tells someone who never typed from someone who never got in.
   * @param {{ sid: string, kind: 'new' | 'resumed' | 'forked' }} o
   */
  function onOpen(o) {
    try {
      const { sid, kind } = o ?? {};
      if (typeof sid !== 'string' || !sid || !KINDS.has(kind)) return;
      const st = chat(sid);
      engineOf(st, sid);
      reach('first_chat');
      // Switching back to a chat already under way is not a new start. A fork is: the same window, another conversation.
      if (st.started && kind !== 'forked') return;
      st.kind = kind;
      st.started = false;
      // A chat opened new holds a conversation that begins here; a saved one opened again may have begun anywhere.
      // (A fork's conversation is marked when the engine names it: until then the chat still holds the one it forked.)
      if (kind !== 'forked') st.began = kind === 'new';
    } catch (err) { oops(err); }
  }

  /**
   * A message went out, or was put in the queue behind the reply in flight (`queued`). The text is only measured.
   * `images` and `files` are lists or counts; `files` is left out of the event when it is not given.
   * @param {{ sid: string, text?: string, images?: unknown[] | number, files?: unknown[] | number, queued?: boolean }} o
   */
  function onSend(o) {
    try {
      const { sid, text, images, files, queued } = o ?? {};
      if (typeof sid !== 'string' || !sid) return;
      const st = chat(sid);
      const d = about(sid);
      const engine = engineOf(st, sid, d);
      st.used = true;
      note(st);
      if (!st.started) {
        st.started = true;
        emit(st, sid, 'chat_started', known({
          engine, mode: word(d.mode), effort: word(d.effort), has_folder: typeof d.hasFolder === 'boolean' ? d.hasFolder : undefined,
          kind: st.kind ?? (st.sessionId ? 'resumed' : 'new'),
        }));
        reach('first_chat');
      }
      emit(st, sid, 'message_sent', known({
        engine, length: lengthBucket(typeof text === 'string' ? text.length : 0),
        images_n: howMany(images) ?? 0, files_n: howMany(files), queued: queued === true,
      }));
      reach('first_message');
    } catch (err) { oops(err); }
  }

  /**
   * A prompt was answered by the person. `id` is the prompt's id (its `permission` event was seen here, so the tool
   * is known, and a second answer to the same prompt is not counted). Without an id, `toolName` says what it was about.
   * Only `answer.action` is read: a reason typed with a "no" stays where it is.
   * @param {{ sid: string, id?: number | string, toolName?: string, answer?: { action?: string } }} o
   */
  function onPermissionAnswer(o) {
    try {
      const { sid, id, toolName, answer } = o ?? {};
      if (typeof sid !== 'string' || !sid) return;
      const st = records.get(sid);
      let kind;
      if (id != null) {
        kind = st?.asks.get(id);
        if (kind === undefined) return; // answered already, or never asked here
        st.asks.delete(id);
      } else kind = toolKind(toolName);
      const action = answer && typeof answer === 'object' ? answer.action : null;
      send('permission_answered', known({
        engine: (st && engineOf(st, sid)) ?? engineName(about(sid).engine),
        tool_kind: kind, answer: action === 'always' ? 'always' : YES.has(action) ? 'allow' : 'deny',
      }));
    } catch (err) { oops(err); }
  }

  /** A chat closed (the manager's `closed`): its record goes, so memory follows the chats that are open. */
  function onClose(sid) {
    try { drop(sid); } catch (err) { oops(err); }
  }

  /**
   * Canopy is quitting. Its chats are still shutting down, and each would report its close after telemetry has sent
   * its last batch; so every record goes now, and what any still held (a message waiting to learn its model) is in
   * that batch.
   */
  function onQuit() {
    try { for (const sid of [...records.keys()]) drop(sid); } catch (err) { oops(err); }
  }

  return {
    onEvent, onOpen, onSend, onPermissionAnswer, onClose, onQuit,
    /** How many chats are being followed (for tests, and a quick look when hunting a leak). */
    get size() { return records.size; },
  };
}

// CodexSession: one Codex conversation, driven through `codex app-server`. The Codex twin of Session
// (session.mjs): the host and the UI use the two the same way and see the same event kinds.
//
// Contract with the host (main process) and the UI:
//  - Every public method is safe to call at any time and never throws. Results
//    are { ok: true, ... } or { ok: false, code, message }.
//  - Everything that happens is reported as an event (see codex-adapter.mjs for the
//    transcript events). Events carry a monotonically increasing `seq`.
//  - Every send is tracked in an outbox until Codex has finished its turn. If the
//    process dies, sends that never started are redelivered after a restart and a
//    turn that was running is reported as lost, never silently re-run.
//  - The process is owned here, one per chat: stop and dispose resolve only once it is gone.
//  - A new chat has no `sessionId` until its first turn starts. Codex writes a chat to disk
//    only then, and the host reads "has an id" as "is a saved chat".
//  - Mode, model, effort and Fast travel with every turn. A model or effort left unset is not sent,
//    which means the user's own Codex settings. The speed is always sent: Fast on, else standard (Canopy has
//    one speed switch, so the user's own tier, Ultrafast say, never applies here). Where a setting has to be sent whole (a mode's sandbox, a
//    collaboration mode's effort), what goes out is what Codex itself reported for this user, never a blank
//    that would overwrite theirs. Nothing under ~/.codex is ever written here.
//  - A process let go on purpose (a forced stop, stop()) leaves nothing in flight behind: a send it had not
//    answered is handed back as failed, never kept waiting and never sent twice.
//  - A chat runs on one account (`accountId`; null: Codex as it finds itself) and keeps it. Its process is started
//    with what the host says that account is launched with (`launch`), at every start; when the host refuses, the
//    chat does not start, and says why. Codex keeps a chat on the model provider it began on, so a chat that comes
//    up on another one than its account's is not run either: it never carries on, unseen, on another login.
//  - Editing a message (edit()) cuts the conversation back a whole turn at a time, with Codex's own thread/revert,
//    under the same thread id. Files are never put back: what Codex changed on disk stays.
//  - What the user did in the app that the model did not see (a message edited so that the replies after it are
//    gone while their changes stay on disk, anything the host hands note()) is told once, with the next message:
//    put into the thread just before the turn that message starts (notes.mjs; see tell()). The instructions the
//    thread started with are never changed for it.
//  - Two cards are raised here without Codex asking (`passive` on the `permission` event; rules in plan-ready.mjs):
//    the plan card, when a Plan-mode turn ends with a plan (its `turn-end` carries `plan: true` and the card
//    follows before the chat says it is free), and the question card, for a question Codex asks in passing.
//    respond() answers them like any card: Build it sets the mode and sends "Implement the plan.".
//  - `/compact`, `/review` and `/goal` sent as a message are run here as Codex's own calls (codex-commands.mjs),
//    never handed to the model as words. One typed while a turn runs waits for that turn to end. Stop also pauses
//    an active goal, or Codex would start the next turn at once.
//  - The chat's agents are threads of their own on the same process (codex-agents.mjs): their steps come out under
//    the Agent row that started them, they are listed as `tasks`, and stopTask() stops one.
//  - contextUsage() also carries the plan's usage limits (limits.mjs): [] under an API key, which has none.
//  - A chat whose host gives it a tool relay (`tools`) has Canopy's own tools, the ones a Claude chat has
//    (codex-tools.mjs): the same ones every time it is opened. Codex is never asked about them; a call that needs the
//    user's yes is put to them here, on the same card as any tool's (see askTool).
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import * as codexAdapter from './codex-adapter.mjs';
import { KEY_PROVIDER } from './accounts-codex.mjs';
import { createAgents } from './codex-agents.mjs';
import { CODEX_COMMANDS, callFor, failedText, goalChange, goalKey, goalSaid, parseCommand, sendFirst } from './codex-commands.mjs';
import { cleanLimits, limitsFromCodex, mergeCodex } from './limits.mjs';
import { CODEX_OVERRIDES, CODEX_TIMEOUTS, CodexProcess, FAST_TIER, codexEnv, listModels, readTurns, shownStderr } from './codex-host.mjs';
import { TIMEOUTS, STABLE_RUN_MS, withTimeout, sleep, backoffMs, RestartBudget, Outbox } from './supervisor.mjs';
import { checkMessage, isPlain } from './send-rules.mjs';
import { CANOPY_FACTS_NEUTRAL } from './facts.mjs';

/** The skill list's size in a Codex chat whose user set none (skillCap). */
export const SKILL_TOKENS = 4000;
import { forCodex, isHandoffText } from './handoff.mjs';
import { NoteQueue, escapeNoteTag, isNoteText, noteForCodex } from './notes.mjs';
import { CANOPY_SERVER } from './tool-registry.mjs';
import { canopyMemoryNote, claudeMemoryNote } from './memory.mjs';
import { toolIcons } from './tool-icons.mjs';

// Helpers owned by other files load softly: one that fails to load takes its own feature with it, never the app's start.
const soft = async (f) => { try { return await import(f); } catch (err) { return { __missing: String(err?.message ?? err) }; } };
const redactMod = await soft('./redact.mjs');
const planMod = await soft('./plan-ready.mjs');
const toolsMod = await soft('./codex-tools.mjs');
const pluginMod = await soft('./plugin.mjs');

export const CODEX_SESSION_TIMEOUTS = Object.freeze({
  init: 30000,                       // initialize
  thread: 90000,                     // thread/start and thread/resume: the user's MCP servers can hold them
  turn: 30000,                       // turn/start and turn/steer
  interrupt: TIMEOUTS.interrupt, stopInterrupt: TIMEOUTS.stopInterrupt, stopWatch: TIMEOUTS.stopWatch,
  set: TIMEOUTS.set, meta: 5000, history: CODEX_TIMEOUTS.history, historyBudget: CODEX_TIMEOUTS.historyBudget,
  revert: 30000,                     // thread/revert: Codex writes the shortened conversation out again
  turnOver: 4000,                    // how long past the stop watch an edit waits for the reply it stopped to be over
  ownRevert: 5000,                   // a `thread/reverted` this soon after this session's own cut is that cut
  secondPress: 600,                  // a second Stop this soon after the first is a double click, not "it is stuck"
  slowStart: TIMEOUTS.slowStart,     // a start still going after this long says so, as a Claude chat does
  compact: 180000,                   // `/compact` that never says it finished: the chat is freed after this long
  agentQuiet: 2000,                  // a running agent that has said nothing for this long is subscribed to
  contextEvery: 1000,                // the ring is told about new token counts at most this often during a turn
  turnEndGrace: 1500,                // after the interrupt that precedes a stop: how long the real turn-end may take to arrive
  restart: null,                     // a fixed restart delay instead of backoffMs() (tests)
});

const EXTENDED_FEATURES = ['tasks', 'tool-stream', 'send-state', 'hooks', 'info', 'elicitation', 'task-stop'];
// Which `extended` feature unlocks each gated event kind (the same gates as Session).
const KIND_GATE = { tasks: 'tasks', 'tool-pending': 'tool-stream', 'tool-input-delta': 'tool-stream', 'send-state': 'send-state' };
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
// Settings that only mean something to Claude Code. Accepted and dropped without a word: a `setting-failed`
// for one of them would be read by the window as "Claude refused this" and change what Claude chats do next.
const CLAUDE_ONLY = new Set(['ultracode', 'codeMode', 'outputStyle', 'agent', 'thinking', 'suggestions', 'fallbackModel', 'maxBudgetUsd', 'maxTurns', 'additionalDirectories']);
const TURN_LOG_MAX = 2000;
const MAX_SEND_ATTEMPTS = 2;
const CLOSED_TURNS_MAX = 64;
const SEND_TURNS_MAX = 2000;
const WORK_TURNS_MAX = 2000;      // turns of this run whose changed files are remembered
const FIND_TURNS_MAX = 5000;      // how far back an edit looks for a message loaded from the saved chat
const FIND_PAGE = 50;
const REPLAY_KINDS = new Set(['message-start', 'text-delta', 'thinking-delta', 'assistant-text', 'thinking', 'tool-start', 'tool-result',
  'tool-progress', 'tool-pending', 'code-call', 'command-output', 'context-note', 'notice', 'task', 'hook', 'status']);
const DELTA_KINDS = new Set(['text-delta', 'thinking-delta']);
// A running command's output (`tool-output`) is never kept chunk by chunk. A window that reloads is given the end
// of what each command still running has printed: this many characters, however long the command has been printing.
const LIVE_TAIL = 8000;
const LIVE_TAILS_MAX = 512;      // commands of one turn remembered (their output, or that they have finished)
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const EFFORT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// The one switch Canopy has for Full Access lives in Claude Code's settings, for both makers' chats.
const BYPASS_NOTICE = 'Full Access is off. Turn on bypass permissions in Claude Code settings first.';
const SLOW_START = 'Codex is taking a long time to start (hooks or MCP servers?).';
const CHAT_GONE = 'That chat is no longer on disk, so Canopy started a new one.';
const API_KEY_BILLING = 'This conversation is billed to an API key, not your ChatGPT plan.';
const NOT_INSTALLED = 'Codex was not found. Install it, or check that `codex` is on your PATH.';
// Codex lets one process write a chat at a time. This is what a chat says when another app has it and the host has
// no words of its own for that (`heldElsewhere`), and how Codex itself says that it refused.
const OPEN_ELSEWHERE = 'This chat is open in another app. Close it there to continue here.';
const ACTIVE_WRITER = /already has an active writer/i;
const NOT_RESPONDING = 'Codex did not respond to Stop, so it was restarted.';
const UNSUPPORTED = Object.freeze({ ok: false, code: 'unsupported', message: 'Not available in this chat yet.' });
// A chat that cannot carry on because of the account it began on (Codex ties a chat to it, see accounts-codex.mjs).
const BEGAN_ON_A_KEY = 'This chat began on an API key added in Canopy, and Codex keeps a chat on the account it began on. Choose an API key in Settings → Accounts, then open the chat again.';
const BEGAN_ON_THE_LOGIN = 'This chat began on Codex’s own login, and Codex keeps a chat on the account it began on. It can’t carry on with an API key.';
const NOT_ON_ITS_KEY = 'Codex did not start this chat on its API key, so nothing was sent. Your Codex settings may choose the model provider.';
const NOT_SAVED = 'That message is not in the saved conversation.';
const STEERED = 'That message went into a reply that was already running, so it can’t be edited on its own.';
const OLD_CODEX = 'This version of Codex can’t edit a message. Update Codex and try again.';

// Canopy's five modes as Codex settings (all five shapes are in fixtures/codex-modes.jsonl). Codex runs freely inside
// its sandbox and asks only to step out of it, so Ask lets reads run and Accept Edits lets in-folder commands run.
// The reviewer is always sent, so leaving Auto really leaves it.
// Bypass is not sent as 'never'. Under 'never' Codex answers every MCP server's question "decline" itself, without
// asking anyone: Computer Use then fails with "Computer Use was not approved to use Google Chrome" and no card can
// help (seen in Codex's own log of a Bypass chat, 0.169.0: no elicitation request ever reached Canopy). So Bypass
// lets Codex ask about everything, and Canopy says yes for the user to what Bypass is there to skip (commands,
// file changes, more access, and Codex's own "may I run this MCP tool?"), at once and without a card (see
// raiseRequest). What is left for the user is what only they can answer: a server's own question (Computer Use and
// an app), a form, a sign-in link, and a tool their Codex config says to ask about every time.
// Checked against a real 0.169.0 app-server: thread/start and thread/settings/update take this shape.
const ASK_ALL = Object.freeze({ granular: Object.freeze({ sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true }) });
const BYPASSED = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
const MODE_WIRE = Object.freeze({
  default: { approvalPolicy: 'on-request', reviewer: 'user', sandbox: 'read-only', collab: 'default' },
  acceptEdits: { approvalPolicy: 'on-request', reviewer: 'user', sandbox: 'workspace-write', collab: 'default' },
  plan: { approvalPolicy: 'on-request', reviewer: 'user', sandbox: 'read-only', collab: 'plan' },
  auto: { approvalPolicy: 'on-request', reviewer: 'auto_review', sandbox: 'workspace-write', collab: 'default' },
  bypassPermissions: { approvalPolicy: ASK_ALL, reviewer: 'user', sandbox: 'danger-full-access', collab: 'default' },
});
// thread/start takes the sandbox as a word; turn/start and thread/settings/update take it as an object. These are
// the plain ones, used only until Codex has said what the user's own look like (see sandboxFor).
const SANDBOX_TYPE = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
const SANDBOX_POLICY = {
  'read-only': () => ({ type: 'readOnly', networkAccess: false }),
  'workspace-write': () => ({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }),
  'danger-full-access': () => ({ type: 'dangerFullAccess' }),
};

// The MCP tools the user's own Codex config says to ask about every time (`approval_mode = "prompt"`, on a tool or
// as its server's default), as `server/tool` and `server/*`.
function promptTools(servers) {
  const out = new Set();
  if (!isPlain(servers)) return out;
  for (const [server, cfg] of Object.entries(servers)) {
    if (!isPlain(cfg)) continue;
    if ((cfg.default_tools_approval_mode ?? cfg.defaultToolsApprovalMode) === 'prompt') out.add(`${server}/*`);
    if (!isPlain(cfg.tools)) continue;
    for (const [tool, t] of Object.entries(cfg.tools)) if (isPlain(t) && (t.approval_mode ?? t.approvalMode) === 'prompt') out.add(`${server}/${tool}`);
  }
  return out;
}
const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
const errText = (err) => String(err?.message ?? err);
const coded = (code, message, extra) => Object.assign(new Error(message), { canopy: { code, message, ...extra } });
const briefly = (rows) => rows.map((e) => ({ id: e.id, text: e.text }));
// What a message carried besides its words (images), as Codex's own input parts: an edit sends them again as they were.
const attachmentsOf = (content) => (Array.isArray(content) ? content.filter((c) => isPlain(c) && typeof c.type === 'string' && c.type !== 'text') : []);
const wordsOf = (content) => (Array.isArray(content) ? content.filter((c) => isPlain(c) && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : '');

let requestSeq = 1_000_000_000;  // permission ids are unique across sessions, and never one a Claude session counts to
let apiKeyNoticeShown = false;   // once per app process

function dirExists(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// A message as Codex's `input`. Images follow the protocol's types; no recording has one yet.
function buildInput(text, images) {
  const input = [];
  // Nothing the user typed or pasted can pass for a note of Canopy's (notes.mjs).
  if (text.trim()) input.push({ type: 'text', text: escapeNoteTag(text), text_elements: [] });
  for (const im of images) input.push({ type: 'image', url: `data:${im.mediaType};base64,${im.data}` });
  return input;
}

function mcpRow(name, p) {
  const status = p.status === 'ready' ? 'connected' : p.status === 'starting' ? 'pending' : 'failed';
  const icons = toolIcons(p);
  return { name, status, error: typeof p.error === 'string' && p.error ? p.error : null, scope: null, source: null, server: null, url: null, transport: null, tools: [], ...(icons.length ? { icons } : {}) };
}

export class CodexSession extends EventEmitter {
  /**
   * @param {object} opts
   *   cwd, codexPath (a path, or a getter read at each start), env (an object, or a getter)
   *   resume            a thread id: this chat already exists on disk
   *   model, permissionMode, effort, fast      the user's choices; unset means their own Codex settings
   *   allowBypass       Full Access may be chosen
   *   extended          true, or a list of features (`send-state`, `hooks`, `elicitation`, …), as Session
   *   handoff           { text }: this chat was moved here from the other maker, and `text` is the old chat's
   *                     digest (handoff.mjs). It goes into the thread once, just before its first turn (see carry())
   *   config, flags     extra -c settings and flags for the process. Both empty in the app (tests and the smoke script use them)
   *   tools             the host's ToolRelay (tool-relay.mjs): this chat gets Canopy's own tools through it
   *   look, otherChats  what those tools work with, as Session takes them: the screenshot backend (look.mjs), and
   *                     where the user's other chats are read from (read-chat.mjs chatSources)
   *   shots             where the screenshots look takes are kept for the chat (shots.mjs createShotStore), as Session
   *   widgetReport      (callId) => Promise<{ errors } | null>: what the window said about drawing a widget, as
   *                     Session takes it. show_widget waits a moment for it (widgets.mjs)
   *   memory            Canopy Memory's notes (memory-store.mjs): shown to the chat when it starts, and what its
   *                     remember, recall and forget tools work with. `memoryBridge: true` adds Claude Code's own
   *                     notes about the user: one maker's notes sent to the other's model, so only on the user's say
   *   spawnFn, timeouts, adapter               test seams
   *   log(level, msg, data), onDrift(label, keys)
   *   onRateLimits(limits)                     every limit update Codex sends, as it came (the transcript only hears of a limit once it is reached)
   *   onAccountUpdated({ authMode })           Codex said its login changed under this chat (`authMode` null: nobody is signed in)
   *   account           the host's name for the account this chat is on (null: Codex as it finds itself)
   *   launch(base, account)                    what Codex is started with for that account: { env, config, provider }
   *                                            (accounts.mjs `launchFor`). `base` is the environment it would get anyway.
   *                                            It throws, with the reason, when the account cannot be launched.
   *                                            Without it, Codex is started as it finds itself.
   *   accountNotice({ provider }, account)     what the chat says about its account when its first turn starts
   *                                            (a string, or nothing), in the words of a host that names accounts
   *   heldElsewhere(threadId, refused)         the sentence to show when another app has this chat open (Codex lets
   *                                            one process write a chat), or nothing. No process is started for such
   *                                            a chat. `refused`: Codex itself just said so, whatever the host knew.
   */
  constructor({
    cwd, codexPath, env, resume = null, model, permissionMode, effort, fast,
    allowBypass = false, extended = false, debug = false, autoRestart = true, appVersion = '0.0.1', title,
    config, flags, spawnFn = spawn, timeouts, log, onDrift, onRateLimits, onAccountUpdated, adapter, handoff, tools, look, shots, otherChats, widgetReport, canopyPlugin, canopyKit, memory, memoryBridge = false,
    account = null, launch, accountNotice, heldElsewhere,
  } = {}) {
    super();
    this.engine = 'codex';
    this.cwd = cwd;
    this.codexPath = codexPath;
    this.env = env;
    this.accountId = typeof account === 'string' && account ? account : null;
    this.launchFn = typeof launch === 'function' ? launch : null;
    this.accountNotice = typeof accountNotice === 'function' ? accountNotice : null;
    this.heldFn = typeof heldElsewhere === 'function' ? heldElsewhere : null;
    this.provider = null;        // the model provider this chat's process was started on, when its account names one
    this.restartWhenIdle = null; // why the process is to be started again once the chat is free (see recycle)
    this.sessionId = typeof resume === 'string' && THREAD_ID_RE.test(resume) ? resume : null;
    this.threadId = this.sessionId;  // the thread this process works on; kept private until its first turn starts
    this.allowBypass = allowBypass === true;
    this.settings = {
      model: typeof model === 'string' && model ? model : undefined,
      effort: typeof effort === 'string' && effort ? effort : undefined,
      fast: typeof fast === 'boolean' ? fast : undefined,
      permissionMode: this.modeAllowed(permissionMode) ? permissionMode : undefined,
    };
    this.title = typeof title === 'string' ? title : undefined;
    // A chat that already exists has had its digest, so a resumed one never carries. `thread`: the thread it went into.
    this.handoff = !this.sessionId && isPlain(handoff) && typeof handoff.text === 'string' && handoff.text ? { text: handoff.text, thread: null } : null;
    this.ext = new Set(extended === true ? EXTENDED_FEATURES : Array.isArray(extended) ? extended : []);
    this.debug = !!debug;
    this.autoRestart = autoRestart !== false;
    this.appVersion = String(appVersion);
    this.config = isPlain(config) ? config : {};
    this.flags = Array.isArray(flags) ? flags : [];
    // Canopy's own skills (plugin.mjs), as the folders Codex is told to look in as well. Found once, so every process
    // of this chat is told the same. `canopyPlugin: false` leaves them out; a path names another plugin folder (tests).
    // Canopy Kit (plugin.mjs): its skills join Canopy's own when the host turns it on (`canopyKit: true`, or a path).
    this.kit = canopyKit ? pluginMod.canopyPlugin?.(typeof canopyKit === 'string' ? canopyKit : pluginMod.kitDir?.()) ?? null : null;
    this.skillRoots = pluginMod.codexSkillRoots?.(canopyPlugin === false ? null : pluginMod.canopyPlugin?.(typeof canopyPlugin === 'string' ? canopyPlugin : undefined), this.kit) ?? [];
    this.spawnFn = spawnFn;
    this.t = { ...CODEX_SESSION_TIMEOUTS, ...(isPlain(timeouts) ? timeouts : {}) };
    this.logFn = typeof log === 'function' ? log : null;
    // Told about every line Codex sends that the adapter does not know (label, top-level keys).
    this.onDrift = typeof onDrift === 'function' ? onDrift : null;
    this.onRateLimits = typeof onRateLimits === 'function' ? onRateLimits : null;
    // Told when Codex says its login changed. The chat does nothing about it itself: the host asks who is signed in.
    this.onAccountUpdated = typeof onAccountUpdated === 'function' ? onAccountUpdated : null;
    this.A = adapter && typeof adapter.createAdapter === 'function' ? adapter : codexAdapter; // injectable, so tests can stub it

    this.mode = this.settings.permissionMode ?? 'default';  // nothing chosen is Ask: the safe one
    this.model = this.settings.model ?? null;               // the model in use: chosen, else what Codex reports
    // One adapter for the life of the chat. It outlives a process restart: it remembers what was already said.
    this.adapter = this.A.createAdapter({
      model: () => this.model,
      unknown: (label, keys) => { try { this.onDrift?.(label, keys); } catch { /* an observer never breaks the chat */ } },
      debug: this.debug,
      toolOutput: true,          // a running command's output reaches the window as it prints (`tool-output`)
    });

    // Canopy's own tools (codex-tools.mjs). None without a relay, or in a build where they cannot load.
    this.lookBackend = look && typeof look === 'object' ? look : null;
    this.shots = typeof shots?.forChat === 'function' ? shots.forChat(() => this.sessionId) : null; // shots.mjs
    this.otherChats = isPlain(otherChats) ? otherChats : null;
    this.widgetReport = typeof widgetReport === 'function' ? widgetReport : null;
    // Canopy Memory (memory-store.mjs): the notes this chat is shown when it starts (developerNote) and saves to with
    // its remember tool. A host that keeps none gives nothing, and like a chat's other tools it is decided once: the
    // host hands a reopened chat what `startedWith.memory` says it began with (chat-tools.mjs). `memoryBridge: true`
    // adds Claude Code's own notes, which are then sent to OpenAI's model: only ever on because the user turned it on.
    this.memoryStore = memory && typeof memory.save === 'function' ? memory : null;
    this.memoryBridge = memoryBridge === true;
    // The user's own words to this chat, as far as this object saw them: what remember checks a note filed as
    // "the user said" against (memory-tools.mjs saidByUser).
    this.heard = [];
    // A thread that already existed was talked to before this object: with only part of what the user wrote, the
    // check is not made, rather than judge a real preference against half the conversation (see `said`).
    this.heardAll = !this.sessionId;
    this.memo = undefined;     // what this chat was told of memory when it started (null: nothing); see developerNote
    this.ownTools = typeof tools?.connect === 'function' && toolsMod.createCodexTools ? toolsMod.createCodexTools({
      relay: tools,
      chat: () => ({ cwd: this.cwd, sessionId: this.sessionId, look: this.lookBackend, shots: this.shots, chats: this.otherChats, widgetReport: this.widgetReport, memory: this.memoryStore, said: () => (this.heardAll ? this.heard : null) }),
      ask: (tool, args, meta) => this.askTool(tool, args, meta),
      free: () => this.mode === 'bypassPermissions',
      log: (level, msg, data) => this.log(level, msg, data),
    }) : null;

    this.proc = null;          // the app-server process of this chat, while there is one
    this.loaded = false;       // the thread is open in that process
    this.opening = null;       // the start in flight, shared by everyone waiting for it
    this.reaps = new Set();    // processes on their way out: a new one waits for them
    this.active = null;        // the turn in flight: { id, started, ids, at, stopAsked, userStopped, interruptSent }
    this.deferred = new Set(); // sends Codex would not fold into the running turn: they start the next one
    this.closedTurns = new Set();
    // Which turn each message of this run went into: send id -> { turnId, first, text, images }. Kept after the turn
    // is over, because that turn is what an edit of the message cuts back to. `first`: the turn started with it.
    this.sendTurns = new Map();
    // What the user did in the app that the model has not been told yet (notes.mjs): it goes with the next message.
    this.notes = new NoteQueue({ cwd });
    // The files each turn of this run changed, oldest turn first: turn id -> Set of paths. What an edit names when
    // it cuts those turns away and their changes stay on disk.
    this.work = new Map();
    this.editing = false;      // an edit is cutting the conversation back: nothing else is handed to Codex meanwhile
    this.revertedAt = 0;       // when this session last asked Codex to cut the conversation back
    this.startResult = null;   // what thread/start answered, for the `init` of a new chat's first turn
    this.initPending = false;
    this.lostSessionId = null;
    this.collab = null;        // the thread's collaboration mode as far as known: 'plan' | 'default' | null (a resumed thread)
    this.actual = { model: null, effort: null, tier: null };   // what Codex says it runs with (`effortSaid`: it has said, even "none")
    this.base = {};            // the user's own model, effort and tier, as the thread opened with them
    this.sent = { model: false, effort: false, tier: false };  // this thread carries a choice of ours for these
    this.sandboxes = {};       // each sandbox as Codex reported it for this user (by its `type`): what a turn resends
    this.ownNote = undefined;  // the user's own developer_instructions, from their config (null: none; undefined: not read yet)
    this.nameTaken = undefined; // the user has an MCP server of their own under the name Canopy's goes by (undefined: not read yet)
    this.askTools = new Set();  // the MCP tools the user's Codex config says to ask about every time (`server/tool`), asked about in Bypass too
    this.models = null;        // this process's own model/list, for checking choices
    this.account = null;
    this.version = null;
    this.startupMs = null;
    this.mcpRows = new Map(); // name -> row (`mcp` itself is the method the host calls)
    this.goal = null;          // the thread's goal as { objective, status }; null for none; undefined: a reopened chat that has not said
    this.goalCmd = null;       // a `/goal` in flight: { said } (its own echo is then not said twice)
    this.rateSnapshot = null;  // Codex's last rate-limit snapshot, with its sparse updates laid over it (not `rateLimits`: that is the method below)
    this.limitsOff = false;    // this login has no plan limits (an API key): not asked again
    this.agents = createAgents();
    this.agentSubs = new Set();  // agents whose lines were asked for (they did not arrive on their own)
    this.agentStops = new Set(); // agents asked to stop before their turn was named
    this.ctxSaidAt = 0;

    this.seq = 0;
    this.busy = false;
    this.state = 'idle';       // starting | running | requires_action | idle
    this.lifecycle = 'new';    // new | starting | ready | stopped | failed | closed
    this.closed = false;
    this.hostStopped = false;
    this.restarts = 0;
    this.spawned = 0;
    this.lastError = null;
    this.lastMeta = null;
    this.pending = new Map();  // permission id -> { id, req, ev, proc }
    this.outbox = new Outbox({ onChange: (e, state) => { this.event({ kind: 'send-state', id: e.id, state }); this.notes.settle(e.id, state); } });
    this.budget = new RestartBudget({ max: 3, windowMs: 60000 });
    this.turn = [];
    this.tails = new Map();    // command id -> { text, seq }: the end of its live output; null once it has finished
    this.timers = {};
    this.setChain = Promise.resolve();
    this.cancelBatch = [];
    this.delta = null;
    this.delivering = false;
    this.again = false;
    this.stopping = null;
    this.noticed = new Set();
  }

  get pid() { return this.proc?.alive ? this.proc.pid : null; }
  // Truthy while a process exists (the host reads it as "started").
  get q() { return this.proc?.alive ? this.proc : null; }
  get backgroundCount() { return 0; }
  get working() { return this.busy || this.pending.size > 0; }
  // What this chat started with, for the host to remember and hand back when the chat is opened again (as Session's):
  // whether it has Canopy Memory. Null until it has a conversation.
  get startedWith() { return this.sessionId ? { memory: !!this.memoryStore } : null; }
  // A Codex chat has no background work, so what the host is told is what is true.
  reportedBusy() { return this.busy; }

  // ---- public API ----

  send(text, images = [], opts = {}) {
    images = images ?? []; opts = opts ?? {};
    const bad = this.checkSend(text, images, opts);
    if (bad) return this.fail(bad.code, bad.message);
    if (this.closed) return this.fail('closed', 'This session was closed.');
    const id = opts.id ?? randomUUID();
    if (this.outbox.has(id)) return this.fail('invalid-input', 'That message was already sent.');
    this.hostStopped = false;
    this.budget.reset();
    this.clearTimer('restart'); // a user action beats any restart backoff
    this.hear(text);
    this.outbox.add(id, buildInput(text, images), text, images.length);
    this.setBusy(true, this.busy ? this.state : 'starting');
    this.withdraw(null, 'kept'); // a new message takes down a waiting plan (it is feedback on it) and a question asked in passing
    this.fire(this.deliver());
    return { ok: true, id };
  }

  // The user wrote this to the chat: a message, or what they typed on a card.
  hear(...texts) {
    for (const t of texts) if (typeof t === 'string' && t.trim()) this.heard.push(t.slice(0, 20_000));
    if (this.heard.length > 200) this.heard.splice(0, this.heard.length - 200);
  }

  /**
   * The host chose another account for new chats. A chat nobody has used yet (no conversation, nothing sent or
   * waiting) is a new chat, so it starts on that account instead; a process already warmed up on the old one is
   * started again. Any other chat keeps the account it started on. Returns whether it moved.
   * @param {string | null} account the host's name for the account (null: Codex as it finds itself)
   */
  moveAccount(account) {
    const next = typeof account === 'string' && account ? account : null;
    if (next === this.accountId || this.closed) return false;
    if (this.sessionId || this.lostSessionId || this.busy || this.outbox.size > 0) return false;
    this.accountId = next;
    // The plan's limits are the account's: what was read on the old one is not shown on the new one, and whether
    // the new one has any is found out again (see loadLimits).
    this.rateSnapshot = null; this.limitsOff = false;
    this.publishMeta({ accountId: next }); // whoever shows this chat goes by its account, so it is told
    if (this.proc || this.opening) this.fire(this.recycle('account'));
    return true;
  }

  /**
   * Start this chat's process again, so that what it was launched with (its account, that account's key) is what
   * holds now. Never mid-turn: a chat at work does it once it is free. With no process there is nothing to do: the
   * next start is a new launch anyway. Resolves to whether a restart was begun.
   */
  async recycle(why) {
    if (this.closed) return false;
    if (!this.proc && !this.opening) return false;
    if (this.busy || this.pending.size) { this.restartWhenIdle = why ?? 'restart'; return false; }
    const starting = this.opening;
    const proc = this.detach();
    this.clearTimer('warm');
    try {
      this.lifecycle = 'stopped';
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'restart', willRestart: true, why });
      await this.reap(proc, 3000);
      await starting?.catch(() => {}); // a start that was in flight was on the old launch: it has ended by now
    } catch (err) { this.log('error', 'recycle failed', { error: errText(err) }); }
    if (this.closed || this.hostStopped) return true;
    // A message sent while the old process was being let go goes to the new one; with none, the chat is warmed up again.
    this.fire(this.outbox.pending().length ? this.deliver() : this.warm());
    return true;
  }

  // Something the user did in the app that the model did not see, as notes.mjs lists them ({ kind: 'undo', files },
  // { kind: 'text', text: 'The user …' }). It is told with the next message this chat sends, once, and forgotten if
  // the chat is closed first.
  note(note) {
    if (this.closed) return { ok: false, code: 'closed', message: 'This session was closed.' };
    return this.notes.add(note) ? { ok: true } : { ok: false, code: 'invalid-input', message: 'That note says nothing.' };
  }

  // Edit and resend: the message `messageId` and everything after it leave the conversation, and `text` is sent in
  // its place. A reply in flight is stopped first (an ordinary Stop, waited for). Codex cuts a conversation back a
  // whole turn at a time (thread/revert: the turn that message started goes, with every later one), where it is,
  // under the same thread id. So:
  //  - a message that was folded into a reply already running (turn/steer) is part of that reply's turn and cannot
  //    go alone: `steered`, and nothing is touched;
  //  - files are never put back: what Codex changed on disk since that message stays as it is.
  //   messageId  this run's own send id, or Codex's id for a message loaded from the saved chat
  //   images     leave out to send the message's own attachments again, unchanged
  //   id         the id the new message gets (the caller's, so its bubble knows it)
  // An `edit` event marks the moment the old turns are gone: everything after it belongs to the new message.
  // The new message tells the model what it can no longer see (notes.mjs): that its replies to the old one are gone
  // and that what they changed on disk is still there. Nothing is said when those replies changed no file (as far
  // as this run saw), or when nothing is left of the conversation to remember them by.
  // Resolves once the conversation is cut and the new message is on its way: { ok, id, fresh: false, first } (and
  // `replaced`, the old words, when known), or { ok: false, code, message }. `first`: nothing is left before the
  // new message. After a failure nothing was cut: the conversation is as it was (a reply that was running stays
  // stopped, and sends Codex had not started on are withdrawn with it, as with any Stop).
  async edit(opts) {
    const { messageId, text, images, id = randomUUID() } = opts ?? {};
    const bad = (code, message) => ({ ok: false, code, message });
    if (this.closed) return bad('closed', 'This session was closed.');
    if (typeof messageId !== 'string' || !messageId || messageId.length > 200) return bad('invalid-input', 'That message cannot be edited.');
    const keep = images == null; // the message's own attachments go out again
    const wrong = this.checkSend(keep && typeof text === 'string' && !text.trim() ? '.' : text, keep ? [] : images, { id });
    if (wrong) return bad(wrong.code, wrong.message);
    if (this.outbox.has(id)) return bad('invalid-input', 'That message was already sent.');
    if (this.editing) return bad('busy', 'This chat is already being edited.');
    this.editing = true; // from here to the new message, nothing else is handed to Codex (deliver() waits)
    try {
      this.hostStopped = false;
      this.budget.reset();
      // Where the message is: still waiting to be handed to Codex, in a turn of this run, or in the saved chat.
      const waiting = this.outbox.get(messageId);
      const unsent = waiting?.state === 'pending';
      let kept = keep && unsent ? attachmentsOf(waiting.msg) : [];
      let replaced = unsent ? waiting.text : null;
      let where = null;
      if (!unsent) {
        where = this.sendTurns.get(messageId) ?? null;
        // Its turn/start has not been answered yet: the turn gets its name while the reply is being stopped.
        const mine = this.active?.ids.includes(messageId) ? this.active : null;
        if (!where && mine) where = { turnId: null, first: mine.opener === messageId, text: waiting?.text ?? '', images: waiting?.images ?? 0 };
        if (!where) {
          if (!this.sessionId) return bad('not-found', NOT_SAVED);
          where = await this.findTurn(await this.open(), { itemId: messageId });
          if (this.closed) return bad('closed', 'This session was closed.');
          if (!where) return bad('not-found', NOT_SAVED);
        }
        if (!where.first) return bad('steered', STEERED);
      }

      // Stop the reply and wait until its turn is really over: Codex then has it saved as stopped. Sends it had not
      // started on are withdrawn with it (they would start the moment it ends); the edited one without a word.
      if (unsent) { this.outbox.mark(messageId, 'cancelled'); this.deferred.delete(messageId); }
      const running = this.active;
      if (running) {
        if (!running.stopAsked) await this.interrupt(); // one already being stopped is only waited for: a second Stop would end the process
        if (!(await this.turnOver(running))) return bad(this.closed ? 'closed' : 'busy', this.closed ? 'This session was closed.' : 'The reply could not be stopped. Try again.');
      } else if (this.busy || this.pending.size) await this.interrupt();
      if (this.closed) return bad('closed', 'This session was closed.');
      if (where && !where.turnId) where = this.sendTurns.get(messageId) ?? null; // null: Codex never started on it, so there is no turn to cut

      let first = false;
      if (where) {
        if (!this.sessionId) return bad('not-found', NOT_SAVED);
        replaced = where.text ?? null;
        const proc = await this.open(); // a stop that had to end the process, or a chat not opened yet
        if (keep && where.content) kept = attachmentsOf(where.content);
        else if (keep && where.images > 0) kept = attachmentsOf((await this.findTurn(proc, { turnId: where.turnId }))?.content);
        if (!text.trim() && !(keep ? kept : images).length) return bad('invalid-input', 'There is nothing to send.');
        await this.revert(proc, where.turnId);
        if (this.closed) return bad('closed', 'This session was closed.');
        const gone = this.forgetFrom(where.turnId);
        first = await this.nothingLeft(proc);
        // What the model is told with the new message. A conversation with nothing left in it remembers nothing
        // that a note could set right.
        if (first) this.notes.clear();
        else {
          for (const sent of gone.sends) this.notes.again(sent); // told with a message that is gone now: told again
          this.notes.add({ kind: 'edit', files: gone.files, undone: false }, { only: id });
        }
      } else {
        if (!text.trim() && !(keep ? kept : images).length) return bad('invalid-input', 'There is nothing to send.');
        first = !this.sessionId; // a chat with no turn yet: the new message is the first thing said in it
      }
      if (this.closed) return bad('closed', 'This session was closed.');

      this.event({ kind: 'edit', id, messageId, fresh: false, text });
      const input = [...buildInput(text, keep ? [] : images), ...kept];
      // Anything sent while the conversation was being cut waits behind the new message, not ahead of it.
      const late = this.outbox.pending();
      for (const e of late) this.outbox.map.delete(e.id);
      this.outbox.add(id, input, text, input.filter((c) => c.type === 'image' || c.type === 'localImage').length);
      for (const e of late) this.outbox.map.set(e.id, e);
      this.clearTimer('restart'); // a user action beats any restart backoff
      this.setBusy(true, this.busy ? this.state : 'starting');
      return { ok: true, id, fresh: false, first, ...(typeof replaced === 'string' && { replaced }) };
    } catch (err) {
      if (this.closed) return bad('closed', 'This session was closed.');
      const c = err?.canopy;
      if (c?.code === 'aborted') return bad('stopped', 'Codex was stopped.');
      if (c) return bad(c.code, c.message);
      this.log('error', 'edit failed', { error: this.redact(errText(err)) });
      return bad('edit', this.redact(errText(err)));
    } finally {
      this.editing = false;
      if (!this.closed) {
        if (this.outbox.pending().length) this.fire(this.deliver()); // the new message, and whatever waited behind it
        else this.settle();
      }
    }
  }

  // Wait until a turn is over: by Codex's own word, or by the stop watch giving up on it and ending the process.
  async turnOver(active) {
    const end = Date.now() + this.t.stopWatch + this.t.turnOver;
    while (this.active === active && !this.closed && Date.now() < end) await sleep(10);
    return this.active !== active && !this.closed;
  }

  // Find a message in the saved chat: the turn it is in, whether that turn started with it, and what it carried.
  // By Codex's own id for the message (a bubble loaded from the saved chat), or by the turn it started (one of this
  // run's sends). Read newest first, a page at a time, in the light view: that one has each turn's first message,
  // the only kind that can be edited. A message not found there is looked for once in the full view, which is what
  // tells "it went into a reply already running" from "it is not in this chat". Null when it is nowhere.
  async findTurn(proc, { itemId = null, turnId = null }) {
    const threadId = this.sessionId;
    if (!threadId) return null;
    const ask = (method, params, o) => proc.request(method, params, o);
    const inTurn = (t) => {
      if (!isPlain(t) || typeof t.id !== 'string') return null;
      const users = (Array.isArray(t.items) ? t.items : []).filter((i) => isPlain(i) && i.type === 'userMessage');
      const at = turnId ? (t.id === turnId ? 0 : -1) : users.findIndex((i) => i.id === itemId);
      if (at < 0) return null;
      const content = users[at]?.content ?? [];
      return { turnId: t.id, first: at === 0, text: wordsOf(content), content, images: attachmentsOf(content).length };
    };
    const startedAt = Date.now();
    let cursor = null;
    try {
      for (let seen = 0; seen < FIND_TURNS_MAX && Date.now() - startedAt <= this.t.historyBudget;) {
        const r = await ask('thread/turns/list', { threadId, itemsView: 'summary', sortDirection: 'desc', limit: FIND_PAGE, ...(cursor && { cursor }) }, { timeoutMs: this.t.history });
        const page = Array.isArray(r?.data) ? r.data : [];
        for (const t of page) { const hit = inTurn(t); if (hit) return hit; }
        seen += page.length;
        cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
        if (!cursor || !page.length) break;
      }
    } catch (err) {
      if (err?.code === 'closed') throw err;
      this.log('warn', 'looking for a message in the saved chat failed; reading the chat whole', { error: this.redact(errText(err)) });
    }
    const { turns } = await readTurns(ask, threadId, { timeoutMs: this.t.history, budgetMs: this.t.historyBudget });
    for (let i = turns.length - 1; i >= 0; i--) { const hit = inTurn(turns[i]); if (hit) return hit; }
    return null;
  }

  // Ask Codex to cut the conversation back to before a turn. Throws what edit() answers with.
  async revert(proc, turnId, retried = false) {
    this.revertedAt = Date.now();
    try { await proc.request('thread/revert', { threadId: this.sessionId, beforeTurnId: turnId }, { timeoutMs: this.t.revert }); }
    catch (err) {
      const said = this.redact(errText(err));
      if (err?.code === 'rpc' && !retried && /thread not (found|loaded)/i.test(said) && this.proc === proc && !this.closed) {
        // The process let go of the thread (it unloads idle ones; "thread not found" is what Codex 0.153 says of a
        // thread it has not open): open it again and ask once more.
        await this.loadThread(proc);
        if (this.closed || this.proc !== proc) throw coded('aborted', 'Codex was stopped.');
        if (!this.sessionId) throw coded('not-found', 'That chat is no longer on disk.');
        return this.revert(proc, turnId, true);
      }
      this.log('warn', 'thread/revert failed', { code: err?.code ?? null, error: said });
      if (err?.code === 'rpc' && (err.rpcCode === -32601 || /method not found|unknown (method|variant)/i.test(said))) throw coded('unsupported', OLD_CODEX);
      if (err?.code === 'timeout') throw coded('edit-failed', 'That message could not be edited: Codex did not answer. Try again.');
      if (err?.code === 'closed') throw coded('edit-failed', 'That message could not be edited: Codex stopped. Try again.');
      throw coded('edit-failed', `That message could not be edited: ${said || 'Codex could not go back to it'}. Nothing was changed.`);
    }
    this.revertedAt = Date.now();
    this.collab = null; // Codex opened the thread again from what is left: the next turn says its mode anew
  }

  // The turn `turnId` and every later one are gone: so are the notes about which message went into them. Answers
  // with what went: the sends, and the files those turns changed (null when the turn is from before this run, so
  // nobody saw what it did).
  forgetFrom(turnId) {
    const sends = [];
    let gone = false;
    for (const [id, t] of this.sendTurns) {
      if (t.turnId === turnId) gone = true;
      if (gone) { this.sendTurns.delete(id); sends.push(id); }
    }
    if (!this.work.has(turnId)) { this.work.clear(); return { sends, files: null }; } // older than every turn of this run
    const files = new Set();
    gone = false;
    for (const [turn, changed] of this.work) {
      if (turn === turnId) gone = true;
      if (gone) { for (const f of changed) files.add(f); this.work.delete(turn); }
    }
    return { sends, files: [...files] };
  }

  // After a cut: is anything left of the conversation? (If not, the new message is the first thing said in it.)
  async nothingLeft(proc) {
    try {
      const r = await proc.request('thread/turns/list', { threadId: this.sessionId, itemsView: 'summary', sortDirection: 'desc', limit: 1 }, { timeoutMs: this.t.meta });
      return Array.isArray(r?.data) && r.data.length === 0;
    } catch { return false; }
  }

  // Start Codex and open the thread now, so the first message is fast and the model is known.
  async warm(opts) {
    const { delayMs = 0 } = opts ?? {};
    if (this.closed) return { ok: false, code: 'closed', message: 'This session was closed.' };
    if (Number.isFinite(delayMs) && delayMs > 0 && !this.q) {
      this.setTimer('warm', delayMs, () => this.fire(this.warm()));
      return { ok: true, scheduled: true };
    }
    this.hostStopped = false;
    this.budget.reset();
    try { await this.open(); }
    catch (err) { return this.openFailed(err, { warm: true }); }
    return { ok: true, startupMs: this.startupMs };
  }

  async interrupt(opts) {
    try {
      const { hard = false } = opts ?? {};
      const proc = this.q;
      const active = this.active;
      if (this.closed || !proc || (!active && !this.pending.size)) {
        // Nothing is running, but sends may be waiting for a start or a restart: Stop cancels those too.
        this.clearTimer('restart');
        this.cancelUnstarted();
        const cancelled = this.announceCancelled();
        if (this.busy && !this.active) this.setBusy(false);
        return { ok: true, idle: true, cancelled, stillQueued: [] };
      }
      if (!active) {
        // A question with no turn behind it: answer it "no" and carry on.
        this.resolvePending({ answer: true });
        return { ok: true, idle: true, cancelled: [], stillQueued: [] };
      }
      if (hard) return await this.forceStop('Stopped.');
      if (active.stopAsked) {
        if (Date.now() - active.stopAsked < this.t.secondPress) return { ok: true, cancelled: [], stillQueued: [] };
        return await this.forceStop('Stopped.'); // a second press: Codex had its chance
      }
      active.stopAsked = Date.now();
      active.userStopped = true;
      this.pauseGoal(proc);
      this.resolvePending({ answer: true });
      this.cancelUnstarted();
      const cancelled = this.announceCancelled();
      this.setTimer('stop', this.t.stopWatch, () => {
        if (this.active === active && !this.closed) this.fire(this.forceStop(NOT_RESPONDING));
      });
      // Stop pressed before Codex named the turn: the request goes out the moment the id arrives.
      if (active.id) await this.sendInterrupt(proc, active);
      return { ok: true, cancelled, stillQueued: [] };
    } catch (err) {
      this.log('error', 'interrupt failed', { error: errText(err) });
      return { ok: false, code: 'internal', message: errText(err) };
    }
  }

  set(key, value) {
    const run = () => this.applySet(key, value).catch((err) => ({ ok: false, code: 'internal', message: errText(err) }));
    const p = this.setChain.then(run, run);
    this.setChain = p;
    return p;
  }

  async configure(patch) {
    const failed = [];
    if (!isPlain(patch)) return { ok: false, code: 'invalid-input', message: 'configure() needs an object.', failed };
    for (const key of Object.keys(patch)) {
      const r = await this.set(key, patch[key]);
      if (!r?.ok) failed.push(key);
    }
    return { ok: failed.length === 0, failed };
  }

  respond(id, answer) {
    if (this.pending.get(id)?.passive) return this.answerPassive(this.pending.get(id), answer); // a card Canopy raised itself: Codex is owed no answer
    const p = this.pending.get(id);
    if (!p) {
      this.event({ kind: 'permission-resolved', id, stale: true });
      return { ok: false, code: 'stale', message: 'That request is no longer waiting for an answer.' };
    }
    if (isPlain(answer)) this.hear(answer.message, ...(isPlain(answer.answers) ? Object.values(answer.answers).flat() : []));
    let reply;
    try { reply = this.A.replyTo(p.req, isPlain(answer) ? answer : {}); }
    catch (err) { this.log('error', 'respond failed', { error: errText(err) }); reply = null; }
    const result = isPlain(reply?.result) ? reply.result : p.req.fallback;
    this.pending.delete(id);
    if (p.proc?.alive) p.proc.respond(p.req.rpcId, result);
    // That answer also ends the turn: the turn-end that follows is the user's doing, not an error.
    if (reply?.stops && this.active) this.active.userStopped = true;
    this.event({ kind: 'permission-resolved', id });
    this.afterPrompt();
    return { ok: true };
  }

  // ---- cards Canopy raises itself (a plan that is ready, a question Codex asked in passing) ----
  // Codex asked nothing with these, so no answer is owed to it: `passive`. They sit in `pending` like any prompt
  // (the chat counts as waiting on you and is not let go as idle), outlive the turn they came from, and go away
  // when answered, when a new message is sent, when a newer plan arrives, or when the mode leaves Plan by hand.

  raise(type, toolName, input, turnId) {
    const id = ++requestSeq;
    const ev = { kind: 'permission', id, type, toolName, input, toolUseId: null, engine: 'codex', passive: true, turnId: turnId ?? null, sessionId: this.sessionId };
    this.pending.set(id, { id, ev, passive: true, req: null, proc: null });
    this.event(ev);
    return id;
  }

  // Take such cards down: all of them, or only those of one type. A plan says why it went (`outcome`), so the
  // window can show it as approved or kept.
  withdraw(only = null, outcome) {
    for (const p of [...this.pending.values()]) {
      if (!p.passive || (only && p.ev.type !== only)) continue;
      this.pending.delete(p.id);
      const why = p.ev.type === 'plan' ? outcome : undefined;
      this.event({ kind: 'permission-resolved', id: p.id, ...(why && { outcome: why }) });
    }
  }

  // The user answered one of them.
  //  - Build it: leave Plan for the mode named (else Ask), then send Codex's own words for "go". The plan is
  //    already in the chat, so it is not sent again.
  //  - Keep planning: the card goes; feedback that came along with the answer is an ordinary message, in Plan mode.
  //  - A question: the answer is the user's next message (folded into the turn if one is running). Skip sends nothing.
  answerPassive(p, answer) {
    try {
      const a = isPlain(answer) ? answer : {};
      this.pending.delete(p.id); // first: neither the mode change nor the send below may take it for a card to withdraw
      let outcome;
      if (p.ev.type === 'plan' && a.action === 'plan-approve') {
        outcome = 'approved';
        const mode = a.mode !== 'plan' && this.modeAllowed(a.mode) ? a.mode : 'default';
        this.fire(this.applySet('permissionMode', mode)); // done by the time it returns: the turn below starts in that mode
        this.send(String(planMod.BUILD_WORDS ?? 'Implement the plan.'));
      } else if (p.ev.type === 'plan' && a.action === 'plan-reject') {
        outcome = 'kept';
        if (typeof a.message === 'string' && a.message.trim()) this.say(a.message.trim());
      } else if (p.ev.type === 'question' && a.action === 'answers') {
        const text = planMod.answerWords?.(p.ev.input?.questions, a.answers) ?? '';
        if (text) this.say(text);
      }
      // After the send, so the chat is already working when the card goes: the host never reads it as idle in between.
      this.event({ kind: 'permission-resolved', id: p.id, ...(outcome && { outcome }) });
      return { ok: true };
    } catch (err) {
      this.log('error', 'answering a card failed', { error: errText(err) });
      return { ok: false, code: 'internal', message: errText(err) };
    }
  }

  // A message sent for the user in their own words (an answer picked on a card). The window draws the messages it
  // sends itself, so this one is said as an event.
  say(text) {
    const r = this.send(text);
    if (r.ok) this.event({ kind: 'user-text', text, images: 0, documents: 0, uuid: r.id, at: Date.now() });
    return r;
  }

  // A turn is ending (`end` is its turn-end, about to go out): does it leave a plan to look over? Only a turn that
  // ran in Plan mode, in a chat still in Plan, with no message already waiting to start the next turn.
  planWaits(end) {
    this.planFound = null;
    // A turn that was stopped or failed leaves nothing to answer: its question goes with it.
    if (end.interrupted || end.isError) this.withdraw('question');
    if (this.closed || this.mode !== 'plan' || this.collab !== 'plan' || this.outbox.pending().length) return false;
    try { this.planFound = planMod.planOf?.([...this.turn, end]) ?? null; } catch { this.planFound = null; }
    return !!this.planFound;
  }

  // Raise the plan card for the turn that just closed. A newer plan takes the place of one still waiting.
  offerPlan(turnId) {
    const plan = this.planFound;
    this.planFound = null;
    if (!plan || this.closed) return;
    this.withdraw('plan');
    this.raise('plan', 'ExitPlanMode', { plan }, turnId);
  }

  // Codex asked something without waiting for the answer (a reply that carries `questions`): the question card
  // says it, so the reply is not also shown as text. False: nothing was raised, and the reply is the reply.
  askInPassing(ev) {
    if (ev.aborted || ev.parent || this.closed || this.active?.stopAsked) return false;
    const input = planMod.questionsFor?.(ev) ?? null;
    if (!input) return false;
    this.raise('question', 'AskUserQuestion', input, ev.turnId);
    return true;
  }

  // How full the context is, for the ring, and the plan's usage limits. Null until Codex has reported token counts.
  contextUsage() { return Promise.resolve(this.contextNow()); }

  contextNow() {
    let u = null;
    try { u = this.adapter.usage?.() ?? null; } catch { u = null; }
    const total = u?.contextTokens;
    const max = u?.contextWindow;
    if (typeof total !== 'number' || typeof max !== 'number' || max <= 0) return null;
    return {
      totalTokens: total, maxTokens: max, percentage: Math.min(100, Math.round((total / max) * 100)), rawMaxTokens: max,
      model: this.model ?? null, autoCompact: false, autoCompactThreshold: null, categories: [],
      limits: this.limits(),
    };
  }

  /** The plan's usage limits as Codex last reported them: [] when it has reported none (an API key has none). */
  limits() { try { return cleanLimits(limitsFromCodex(this.rateSnapshot)); } catch { return []; } }

  /**
   * This chat's transcript so far, as events: { ok: true, events, truncated }. Asked of this chat's own process, the
   * one that knows a turn in flight is in flight. Never read from Codex's files. `truncated`: the chat is longer
   * than was read, and the events start part-way through it; `cursor` is then where its older turns begin (see
   * readTurns), and it is left out when these events reach the chat's first turn.
   * `before` (a cursor from an earlier answer) asks for the turns just older than that answer's instead: a page of
   * the past, with nothing of the turn in flight in it.
   */
  async history(opts) {
    try {
      const { maxTurns = 400, pageSize = 50, before = null } = opts ?? {};
      if (before != null && (typeof before !== 'string' || !before)) return { ok: false, code: 'invalid-input', message: 'That is not a place in this chat.' };
      const proc = this.q;
      const threadId = this.threadId;
      if (!proc || !this.loaded || !threadId) return { ok: false, code: 'not-running', message: 'This chat is not running.' };
      let turns = [];
      let truncated = false;
      let cursor = null;
      if (this.sessionId) { // a chat with no turn yet is not on disk: there is nothing to ask for
        ({ turns, truncated, cursor = null } = await readTurns((method, params, o) => proc.request(method, params, o), threadId, {
          maxTurns, pageSize, cursor: before, timeoutMs: this.t.history, budgetMs: this.t.historyBudget,
        }));
      }
      const active = this.active;
      const events = this.A.adaptHistory(turns, { threadId, inFlight: !before && this.busy });
      // The turn in flight may not be in the list yet: then what this session saw of it stands in.
      if (!before && active && !(active.id && turns.some((t) => t?.id === active.id))) {
        for (const id of active.ids) {
          const e = this.outbox.get(id);
          if (e) events.push({ kind: 'user-text', text: e.text || (e.images === 1 ? '[image]' : `[${e.images} images]`), images: e.images, documents: 0, uuid: e.id, at: e.at, ...(id !== active.opener && { steered: true }) });
        }
        this.flushDelta();
        events.push(...this.turn.map((ev) => ({ ...ev })));
      }
      // What the commands still running have printed so far goes last, after the rows it belongs to.
      if (!before) events.push(...this.liveTails());
      return { ok: true, events, truncated, ...(cursor && { cursor }) };
    } catch (err) {
      const message = this.redact(errText(err));
      if (err?.code === 'rpc' && /no rollout found|thread not loaded|not found/i.test(message)) return { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' };
      return { ok: false, code: err?.code === 'timeout' ? 'timeout' : err?.code === 'closed' ? 'not-running' : 'internal', message };
    }
  }

  // The user's MCP servers as this process started them.
  async mcpStatus() { return [...this.mcpRows.values()].map((r) => ({ ...r })); }

  async rename(title) {
    const name = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const proc = this.q;
    // Before its first turn a chat is not on disk, so there is nothing to name.
    if (!name || !proc || !this.loaded || !this.sessionId) return false;
    try { await proc.request('thread/name/set', { threadId: this.sessionId, name }, { timeoutMs: this.t.set }); return true; }
    catch (err) { this.log('warn', 'rename failed', { error: this.redact(errText(err)) }); return false; }
  }

  /**
   * How much of the plan's limits is used, asked of this chat's own process: { ok: true, limits } with Codex's answer
   * whole, or { ok: false, code } ('not-running', 'rejected' when the login has no plan to read, 'timeout', 'failed').
   * It only reads: no message goes to a model and nothing is used up.
   */
  async rateLimits() {
    const proc = this.q;
    if (!proc || this.closed) return { ok: false, code: 'not-running' };
    try { return { ok: true, limits: await proc.request('account/rateLimits/read', undefined, { timeoutMs: this.t.meta }) }; }
    catch (err) {
      const code = err?.code;
      return { ok: false, code: code === 'rpc' ? 'rejected' : code === 'timeout' ? 'timeout' : code === 'closed' ? 'not-running' : 'failed' };
    }
  }

  // Not in a Codex chat yet. Each answers the way the host already expects from a Session. (rewindFiles: Codex keeps
  // no file checkpoints, so an edit has nothing to offer to undo and the window shows no such line.)
  async generateTitle() { return null; }
  async usage() { return null; }

  /** Stop one of the chat's agents (its task id is its thread's id). The chat's own turn carries on. */
  async stopTask(taskId) {
    try {
      const id = String(taskId ?? '');
      const proc = this.q;
      if (!proc || !this.agents.has(id)) return { ok: false, code: 'not-found', message: 'That agent is no longer running.' };
      const turn = this.agents.turnOf(id);
      if (!turn) {
        // Its turn has not been named yet: the stop goes out the moment it is, and its lines are asked for meanwhile.
        this.agentStops.add(id);
        this.subscribeAgent(proc, id);
        return { ok: true, pending: true };
      }
      await proc.request('turn/interrupt', turn, { timeoutMs: this.t.interrupt });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err?.code === 'timeout' ? 'timeout' : 'internal', message: this.redact(errText(err)) };
    }
  }
  async background() { return { ...UNSUPPORTED }; }
  async mcp() { return { ...UNSUPPORTED }; }
  async reload() { return { ...UNSUPPORTED }; }
  async branch() { return { ...UNSUPPORTED }; }
  async rewindFiles() { return { canRewind: false, error: UNSUPPORTED.message }; }
  trust() { return { ok: true }; }
  unpark() { /* a Codex chat is never parked: it has no terminal view */ }

  // Stop the process but keep the conversation. The next send or warm() starts a new one and resumes the thread.
  stop(opts) {
    const { graceMs = TIMEOUTS.stopGrace } = opts ?? {};
    if (this.closed) return Promise.allSettled([...this.reaps]).then(() => ({ ok: true, exited: true }));
    this.hostStopped = true;
    this.clearTimer('restart'); this.clearTimer('warm');
    if (!this.stopping) {
      this.stopping = this.doStop(graceMs)
        .catch((err) => { this.log('error', 'stop failed', { error: errText(err) }); return { ok: true, exited: !this.q }; })
        .finally(() => { this.stopping = null; });
    }
    return this.stopping;
  }

  close() {
    if (this.closed) return;
    const { proc, turn } = this.shut();
    if (proc) this.fire(this.reap(proc, 3000, () => this.sayStop(proc, turn, 300)));
  }

  /** Close for good. Resolves only once the process is gone. A user's chat is never archived or deleted. */
  async dispose(opts) {
    const { graceMs = 2500 } = opts ?? {};
    try {
      if (!this.closed) {
        const { proc, turn } = this.shut();
        if (proc) await this.reap(proc, graceMs, () => this.sayStop(proc, turn, 1500));
      }
      await Promise.allSettled([...this.reaps]);
    } catch (err) { this.log('error', 'dispose failed', { error: errText(err) }); }
  }

  // Everything a UI needs to redraw after a reload without restarting the process.
  snapshot() {
    this.flushDelta();
    const s = this.settings;
    return {
      sessionId: this.sessionId, busy: this.busy, accountId: this.accountId,
      settings: { model: s.model, effort: s.effort, fast: s.fast, permissionMode: this.mode },
      pending: [...this.pending.values()].map((p) => p.ev),
      meta: this.lastMeta ?? null,
      state: this.busy ? this.state : 'idle', lifecycle: this.lifecycle, seq: this.seq,
      turn: [...this.turn, ...this.liveTails()], outbox: this.outbox.snapshot(),
      tasks: this.agents.tasks(), backgroundTasks: [],
      lastError: this.lastError, restarts: this.restarts, pid: this.pid,
      restricted: false, risky: null, degraded: [],
      model: this.model ?? null, mode: this.mode, engine: 'codex',
    };
  }

  // ---- events ----

  event(ev) {
    if (!ev || this.closed) return;
    if (ev.kind === 'turn-end') this.keepMemo();
    const gate = KIND_GATE[ev.kind];
    if (gate && !this.ext.has(gate)) return;
    if (ev.kind === 'raw' && !this.debug && ev.label !== 'adapter-error') return;
    if (DELTA_KINDS.has(ev.kind)) return this.bufferDelta(ev);
    this.flushDelta();
    this.emitNow(ev);
  }

  // Deltas that arrive in the same tick are merged into one event; anything else flushes them first, so order is kept.
  bufferDelta(ev) {
    const d = this.delta;
    if (d && d.kind === ev.kind && d.parent === ev.parent && d.index === ev.index && d.messageId === ev.messageId && typeof ev.text === 'string') {
      d.text += ev.text;
      return;
    }
    this.flushDelta();
    this.delta = { ...ev };
    if (!this.timers.delta) this.timers.delta = setImmediate(() => { this.timers.delta = null; this.flushDelta(); });
  }

  flushDelta() {
    const d = this.delta;
    if (!d) return;
    this.delta = null;
    if (!this.closed) this.emitNow(d);
  }

  emitNow(ev) {
    ev.seq = ++this.seq;
    this.record(ev);
    this.noteWork(ev);
    if (ev.kind === 'error') this.lastError = { code: ev.code ?? null, message: ev.message, at: Date.now() };
    try { this.emit('event', ev); } catch (err) { this.log('error', 'event listener threw', { error: errText(err) }); }
    // The UI clears its busy flag on every error; say again that work continues.
    if (ev.kind === 'error' && this.busy) this.emitBusy();
  }

  // Live output. The turn log keeps none of it: a command can print for an hour. What is kept is the end of what
  // each command still running has printed (LIVE_TAIL characters), and that a command has finished, so a chunk that
  // comes late is not taken for a command still running. All of it goes when the turn ends.
  noteOutput(ev) {
    if (ev.kind === 'turn-end') { this.tails.clear(); return; }
    if (!this.busy || typeof ev.id !== 'string') return;
    if (ev.kind === 'tool-result') this.tails.set(ev.id, null);
    else if (ev.kind === 'tool-output' && typeof ev.text === 'string' && this.tails.get(ev.id) !== null) {
      this.tails.set(ev.id, { text: ((this.tails.get(ev.id)?.text ?? '') + ev.text).slice(-LIVE_TAIL), seq: ev.seq });
    } else return;
    if (this.tails.size > LIVE_TAILS_MAX) this.tails.delete(this.tails.keys().next().value);
  }

  // One event per command still running: everything kept of its output, in place of what the window may have
  // (`replace`). `seq` is the last chunk in it, so a chunk the window is sent again afterwards is not shown twice.
  liveTails() {
    const out = [];
    for (const [id, tail] of this.tails) if (tail) out.push({ kind: 'tool-output', id, text: tail.text, replace: true, seq: tail.seq });
    return out;
  }

  // Turn log: what a reloaded UI needs to redraw the turn in flight.
  record(ev) {
    this.noteOutput(ev);
    if (ev.kind === 'turn-end') { this.turn = []; return; }
    if (!this.busy || !REPLAY_KINDS.has(ev.kind)) return;
    const last = this.turn[this.turn.length - 1];
    if (DELTA_KINDS.has(ev.kind)) {
      if (last?.kind === ev.kind && last.parent === ev.parent && last.index === ev.index && last.messageId === ev.messageId) { last.text += ev.text; last.seq = ev.seq; return; }
      this.turn.push({ ...ev });
    } else this.turn.push(ev);
    if (this.turn.length > TURN_LOG_MAX) this.turn.splice(0, this.turn.length - TURN_LOG_MAX);
  }

  // The files a turn of this run has changed so far (see `work`), kept from the moment the turn is known.
  workOf(turnId) {
    let files = this.work.get(turnId);
    if (!files) {
      this.work.set(turnId, files = new Set());
      if (this.work.size > WORK_TURNS_MAX) this.work.delete(this.work.keys().next().value);
    }
    return files;
  }

  // A file change that went through, while a turn is in flight, is that turn's.
  noteWork(ev) {
    const turn = this.active?.id;
    if (!turn) return;
    const files = this.workOf(turn);
    const s = ev.kind === 'tool-result' && !ev.isError && isPlain(ev.structured) ? ev.structured : null;
    if (s && 'change' in s && typeof s.path === 'string' && s.path) files.add(s.path);
  }

  fail(code, message, extra = {}) {
    this.event({ kind: 'error', code, message, recoverable: extra.recoverable ?? true, ...extra });
    return { ok: false, code, message };
  }

  noticeOnce(key, ev) {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.event({ kind: 'notice', ...ev });
  }

  // Fire-and-forget work must never surface as an unhandled rejection.
  fire(p) { Promise.resolve(p).catch((err) => this.log('error', 'background work failed', { error: errText(err) })); }

  // A handler called from the pipe: its bug is logged, never thrown into the reader.
  guard(fn) { try { fn(); } catch (err) { this.log('error', 'handling a line from codex failed', { error: String(err?.stack ?? err).slice(0, 800) }); } }

  log(level, msg, data) { try { this.logFn?.(level, msg, data); } catch { /* logging never breaks the session */ } }

  redact(text) {
    if (typeof text !== 'string' || !text) return text ?? '';
    try {
      this.redactor ??= redactMod.makeRedactor?.(this.lastEnv ?? process.env) ?? null;
      return this.redactor ? this.redactor(text) : text;
    } catch { return text; }
  }

  resolve(v) { try { return typeof v === 'function' ? v() : v; } catch { return null; } }

  // ---- busy ----

  setBusy(busy, state) {
    state = busy ? state ?? (this.state !== 'idle' ? this.state : 'running') : 'idle';
    if (this.busy === busy && this.state === state) return;
    this.busy = busy; this.state = state;
    this.emitBusy();
  }

  emitBusy() {
    this.event({ kind: 'busy', busy: this.busy, state: this.busy ? this.state : 'idle', queued: this.outbox.unstarted().length, background: 0 });
  }

  // Clear busy without an event yet, so the error rows that follow do not make the flag flap; announceIdle() reports it.
  dropBusy() {
    if (!this.busy) return false;
    this.busy = false; this.state = 'idle';
    return true;
  }

  announceIdle(changed) { if (changed) this.emitBusy(); }

  // A prompt was answered or went away: back to "running" once none is left.
  afterPrompt() {
    if (this.busy && !this.pending.size && this.state === 'requires_action') this.setBusy(true, this.active?.started === false ? 'starting' : 'running');
  }

  // ---- sending ----

  checkSend(text, images, opts) { return checkMessage(text, images, opts); }

  // Hand the waiting sends to Codex, one at a time and in order, starting the process and the thread if needed.
  // The first starts a turn; the rest are folded into it (turn/steer) once Codex has said the turn started.
  async deliver() {
    if (this.delivering) { this.again = true; return; }
    this.delivering = true;
    try {
      for (;;) {
        this.again = false;
        if (this.closed || this.hostStopped || this.timers.restart) return;
        if (this.editing) return; // the conversation is being cut back: edit() delivers when it is done
        if (!this.outbox.pending().some((e) => !this.deferred.has(e.id))) return;
        let proc;
        try { proc = await this.open(); }
        catch (err) { this.openFailed(err); return; }
        if (this.closed) return;
        if (this.proc !== proc) continue;
        const active = this.active;
        if (active && !active.started) return; // its turn/started (or its failure) delivers the rest
        if (active?.stopAsked) return;         // nothing is folded into a turn being stopped: it starts the next one
        const next = this.outbox.pending().find((e) => !this.deferred.has(e.id)); // picked now: Stop may have cancelled some
        if (!next) return;
        const cmd = this.commandOf(next);
        if (cmd) {
          // A command is never folded into a running turn: it runs when that turn has ended.
          if (active) { this.deferred.add(next.id); continue; }
          await this.runCommand(proc, next, cmd);
          continue;
        }
        if (active) await this.steer(proc, active, next);
        else await this.startTurn(proc, next);
      }
    } catch (err) {
      this.log('error', 'delivery failed', { error: errText(err) });
    } finally {
      this.delivering = false;
      if (this.again && !this.closed) this.fire(this.deliver());
    }
  }

  async startTurn(proc, entry, retried = false) {
    const active = this.active = { id: null, started: false, ids: [entry.id], opener: entry.id, at: Date.now(), threadId: this.threadId, stopAsked: 0, userStopped: false, interruptSent: false };
    if (this.handoff && !(await this.carry(proc, entry, active))) return; // a moved chat's digest goes in ahead of its first turn
    const note = this.hasNote(entry) ? null : this.takeNote(entry.id); // so does what the user did in the app since the last message
    if (note && !(await this.tell(proc, entry, active, note))) return;
    const { params, sent, collab } = this.turnParams(entry.msg);
    this.outbox.mark(entry.id, 'written');
    try {
      const r = await proc.request('turn/start', params, { timeoutMs: this.t.turn });
      // Codex took the settings whatever happened to the turn since (its lines can arrive before this answer does).
      if (this.proc === proc) { this.sent = sent; if (collab) this.collab = collab; }
      if (this.active !== active) return;
      if (typeof r?.turn?.id === 'string' && !active.id) active.id = r.turn.id;
      this.linkSends(active);
      this.outbox.mark(entry.id, 'started');
      this.outbox.dropPayloads();
      if (active.stopAsked) this.fire(this.sendInterrupt(proc, active));
    } catch (err) {
      if (this.active !== active || this.proc !== proc || err?.code === 'closed') return; // the process went away: its exit owns the clean-up
      const text = this.redact(errText(err));
      if (err?.code === 'rpc' && !retried && /thread not loaded/i.test(text)) {
        // The process lost the thread (it unloads idle ones): open it again and try once more.
        this.active = null;
        try {
          await this.loadThread(proc);
          if (this.proc === proc && !this.closed && this.outbox.reopen(entry.id)) return await this.startTurn(proc, entry, true);
        } catch (again) { this.log('warn', 'reopening the thread failed', { error: this.redact(errText(again)) }); }
        if (this.proc !== proc || this.closed) return;
      }
      if (err?.code === 'timeout') {
        // No answer at all: the process is stuck. Ending it lets the crash path redeliver.
        this.log('warn', 'turn/start got no answer; restarting codex');
        proc.kill('SIGKILL');
        return;
      }
      if (this.active === active) this.active = null;
      this.outbox.mark(entry.id, 'failed');
      const held = ACTIVE_WRITER.test(text) ? this.heldText(true) : null; // another app took the chat since it was opened here
      this.event({ kind: 'error', code: held ? 'held-elsewhere' : 'send-failed', recoverable: true, message: held ?? `Codex could not start on that message: ${text}`, prompt: { id: entry.id, text: entry.text } });
      this.settle();
    }
  }

  // Nothing in flight and nothing waiting: the chat is free. A restart that was waiting for that happens now.
  settle() {
    if (!this.busy || this.active || this.outbox.size) return;
    this.setBusy(false);
    if (this.restartWhenIdle) this.fire(this.recycle(this.restartWhenIdle));
  }

  // Note which turn the messages of `active` went into (see sendTurns). The words are kept short: all they are ever
  // used for is to tell whether the chat is still named after its first message when that message is edited.
  linkSends(active, turnId = active?.id) {
    if (!active || typeof turnId !== 'string' || !turnId) return;
    this.workOf(turnId);
    for (const id of active.ids) {
      const known = this.sendTurns.get(id);
      if (known?.turnId === turnId) continue;
      const e = this.outbox.get(id);
      this.sendTurns.delete(id); // a send that went out again after a restart is noted anew, in its new place
      this.sendTurns.set(id, { turnId, first: id === active.opener, text: String(e?.text ?? known?.text ?? '').slice(0, 400), images: e?.images ?? known?.images ?? 0 });
    }
    while (this.sendTurns.size > SEND_TURNS_MAX) this.sendTurns.delete(this.sendTurns.keys().next().value);
  }

  // Sending while a turn runs: Codex folds the message into the running turn.
  async steer(proc, active, entry) {
    if (!active.id) { this.deferred.add(entry.id); return; }
    // Nothing is put into a thread in the middle of a turn: a message folded into one carries the note itself.
    if (!this.hasNote(entry)) this.noteIn(entry, this.takeNote(entry.id));
    this.outbox.mark(entry.id, 'written');
    try {
      await proc.request('turn/steer', { threadId: this.threadId, input: entry.msg, expectedTurnId: active.id }, { timeoutMs: this.t.turn });
      if (this.proc !== proc) return;
      this.outbox.mark(entry.id, 'started');
      this.outbox.dropPayloads();
      if (this.active === active) { active.ids.push(entry.id); this.linkSends(active); }
      else { this.linkSends({ ids: [entry.id], opener: null }, active.id); this.outbox.mark(entry.id, 'completed'); this.settle(); } // the turn took it and has ended since
    } catch (err) {
      // The process went away. One that died is cleaned up after by onExit (the send goes back in line); one let
      // go on purpose has had this send handed back already (failUnanswered).
      if (this.proc !== proc || err?.code === 'closed') return;
      if (err?.code !== 'timeout' && this.outbox.reopen(entry.id)) {
        // Codex would not take it into this turn (the turn just ended, or it is one that cannot be steered):
        // it starts the next turn instead.
        if (this.active === active) this.deferred.add(entry.id);
        return;
      }
      // No answer: it may or may not have been taken, so it is not sent twice.
      this.failSends([entry]);
      this.settle();
    }
  }

  // ---- slash commands ----

  /** The command a waiting message is, or null. A message with pictures is always a message. */
  commandOf(entry) {
    try { return entry.images ? null : parseCommand(entry.text); } catch { return null; }
  }

  // Run `/compact`, `/review` or `/goal` as Codex's own call. `/review` and `/compact` become the chat's turn (this
  // send is its message); `/goal` is answered at once with a notice.
  async runCommand(proc, entry, cmd) {
    const done = (text, level) => {
      this.outbox.mark(entry.id, 'completed');
      if (text) this.event({ kind: 'notice', code: 'command', command: cmd.name, text, ...(level && { level }) });
      this.settle();
    };
    // Before its first turn a chat is not on disk, and these calls need one that is.
    if (!this.sessionId) return done(sendFirst(cmd.name));
    const call = callFor(cmd, this.threadId);
    if (!call) return done(failedText(cmd.name, ''), 'warn');
    let active = null;
    if (call.starts) {
      active = this.active = { id: null, started: false, ids: [entry.id], at: Date.now(), threadId: this.threadId, stopAsked: 0, userStopped: false, interruptSent: false, command: call.about };
      if (call.starts === 'compaction') this.event({ kind: 'status', status: 'compacting' });
    } else this.goalCmd = { said: false };
    this.outbox.mark(entry.id, 'written');
    try {
      const r = await proc.request(call.method, call.params, { timeoutMs: this.t.turn });
      if (this.proc !== proc || this.closed) return;
      if (!active) return done(this.goalAnswer(call.about, r));
      if (this.active !== active) return; // its turn came and went before this answer did
      if (typeof r?.turn?.id === 'string' && !active.id) active.id = r.turn.id;
      this.outbox.mark(entry.id, 'started');
      this.outbox.dropPayloads();
      if (active.stopAsked) this.fire(this.sendInterrupt(proc, active));
      // Compaction says when it is done (a turn of its own, or one line). If it never does, the chat is not left waiting.
      if (call.starts === 'compaction') {
        this.setTimer('command', this.t.compact, () => {
          if (this.active !== active || active.started) return;
          this.log('warn', 'codex never said the compaction finished');
          this.commandDone(active);
        });
      }
    } catch (err) {
      if (this.proc !== proc || err?.code === 'closed') return; // the process went away: its exit owns the clean-up
      if (active && this.active !== active) return;
      if (active) { this.active = null; if (call.starts === 'compaction') this.event({ kind: 'status', status: null }); }
      const why = err?.code === 'timeout' ? 'Codex did not answer.' : this.redact(errText(err));
      this.log('warn', 'a command was refused', { command: cmd.name, error: why });
      done(failedText(cmd.name, why), 'warn');
    } finally {
      if (!active) this.goalCmd = null;
    }
  }

  // What a `/goal` call answered, as the notice to show (null when the goal's own update already said it).
  goalAnswer(about, r) {
    const said = !!this.goalCmd?.said;
    if (about === 'goal-get') { this.goal = goalKey(r?.goal); return goalSaid(r?.goal); }
    if (about === 'goal-clear') {
      const had = !!this.goal;
      this.goal = null;
      return said ? null : r?.cleared === false && !had ? 'No goal set.' : 'Goal cleared.';
    }
    const prev = this.goal ?? null;
    this.goal = goalKey(r?.goal);
    return said ? null : goalChange(prev, this.goal) ?? goalSaid(r?.goal);
  }

  // Codex said the goal changed (or went away: null). Said only when its words or its state changed, never as its
  // token count ticks up, and never for what a reopened chat merely reports it already had.
  onGoal(goal) {
    const prev = this.goal;
    this.goal = goalKey(goal);
    if (prev === undefined && !this.goalCmd) return;
    const text = goalChange(prev ?? null, this.goal);
    if (!text) return;
    if (this.goalCmd) this.goalCmd.said = true;
    this.event({ kind: 'notice', code: 'goal', text });
  }

  // Stop with a goal still active would be undone at once: Codex starts the next turn toward it. So Stop pauses it.
  pauseGoal(proc) {
    if (this.goal?.status !== 'active' || !this.threadId) return;
    this.fire(proc.request('thread/goal/set', { threadId: this.threadId, status: 'paused' }, { timeoutMs: this.t.set }).then(
      (r) => { if (this.proc === proc && !this.closed && isPlain(r?.goal)) this.onGoal(r.goal); },
      (err) => this.log('warn', 'pausing the goal failed', { error: this.redact(errText(err)) }),
    ));
  }

  // A command's own work is over without Codex ever reporting a turn for it: the made-up turn is closed.
  commandDone(active) {
    if (this.active !== active || this.closed) return;
    this.closeTurn(this.madeUpEnd(active, 'completed', null), { synthetic: true });
    if (this.closed) return;
    if (this.outbox.pending().length) { this.setBusy(true, 'starting'); this.fire(this.deliver()); }
    else this.settle();
  }

  // A chat moved here from the other maker: the old chat's digest goes into the thread once, just before its first
  // turn, as model-visible history that is nobody's message (thread/inject_items). If Codex refuses the call, the
  // same text goes as the first block of that turn's input instead (the adapter keeps it out of the bubble either
  // way). A thread lost before its first turn is started again and carries again; a chat that is on disk has had it.
  // Resolves to whether the turn should still start: false when the process or the turn went away meanwhile.
  async carry(proc, entry, active) {
    const h = this.handoff;
    if (this.sessionId) { this.handoff = null; return true; }
    if (!h || h.thread === this.threadId || isHandoffText(entry.msg?.[0]?.text)) return true;
    const text = forCodex(h.text);
    // From here the message is on its way, as it is while turn/start is out: Stop lets the turn start and then stops it.
    this.outbox.mark(entry.id, 'written');
    try {
      await proc.request('thread/inject_items', { threadId: this.threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] }, { timeoutMs: this.t.turn });
      h.thread = this.threadId;
    } catch (err) {
      if (this.proc === proc && err?.code !== 'closed') {
        this.log('warn', 'the digest could not be put into the thread; it goes with the first message', { error: this.redact(errText(err)) });
        entry.msg = [{ type: 'text', text, text_elements: [] }, ...(Array.isArray(entry.msg) ? entry.msg : [])];
      }
    }
    return this.active === active && this.proc === proc && !this.closed;
  }

  // What the user did in the app that the model did not see (notes.mjs: `text` is the block) goes into the thread
  // just before the turn its next message starts, the way a moved chat's digest does: model-visible history that is
  // nobody's message (thread/inject_items). If Codex refuses the call, the same text is the first block of that
  // turn's input instead (the adapter keeps it out of the bubble either way). Resolves to whether the turn should
  // still start: false when the process or the turn went away meanwhile.
  async tell(proc, entry, active, text, retried = false) {
    const here = () => this.active === active && this.proc === proc && !this.closed;
    const thread = this.threadId;
    this.outbox.mark(entry.id, 'written'); // on its way, as while turn/start is out
    try {
      await proc.request('thread/inject_items', { threadId: thread, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] }, { timeoutMs: this.t.turn });
      this.notes.settle(entry.id, 'started'); // the thread has it now, whatever becomes of the turn
    } catch (err) {
      if (this.proc !== proc || err?.code === 'closed') return false; // the process went away: its exit owns the clean-up
      const said = this.redact(errText(err));
      if (err?.code === 'rpc' && !retried && /thread not (found|loaded)/i.test(said) && here()) {
        // The process let go of the thread (it unloads idle ones): open it again and ask once more. (A chat that
        // turns out to be gone from disk carries on in a new one, which has nothing to be told.)
        try { await this.loadThread(proc); } catch (again) { this.log('warn', 'reopening the thread failed', { error: this.redact(errText(again)) }); }
        if (!here()) return false;
        if (this.threadId === thread && this.loaded) return this.tell(proc, entry, active, text, true);
        if (this.threadId !== thread) return true;
      }
      this.log('warn', 'the note could not be put into the thread; it goes with the message', { error: said });
      this.noteIn(entry, text);
    }
    return here();
  }

  // The notes for the message `id` to carry, as the block Codex is handed. Null when there is nothing to tell.
  takeNote(id) {
    const block = this.notes.take(id);
    if (!block) return null;
    this.log('info', 'the model is told what the user did', { id, lines: block.split('\n').length - 2 });
    return noteForCodex(block);
  }

  // Put a note first in a waiting message's input (after a moved chat's digest, which stays first: see carry()).
  noteIn(entry, text) {
    if (!text) return;
    const msg = Array.isArray(entry.msg) ? entry.msg : [];
    const at = isHandoffText(msg[0]?.text) ? 1 : 0;
    entry.msg = [...msg.slice(0, at), { type: 'text', text, text_elements: [] }, ...msg.slice(at)];
  }
  hasNote(entry) { return Array.isArray(entry.msg) && entry.msg.slice(0, 2).some((c) => isNoteText(c?.text)); }

  cancelUnstarted() {
    for (const e of this.outbox.pending()) {
      this.outbox.mark(e.id, 'cancelled');
      this.deferred.delete(e.id);
      this.cancelBatch.push({ id: e.id, text: e.text });
    }
  }

  announceCancelled() {
    const cancelled = this.cancelBatch.splice(0);
    if (cancelled.length) {
      this.event({ kind: 'notice', code: 'send-cancelled', cancelled, text: `Stopped. ${cancelled.length} queued message${cancelled.length > 1 ? 's were' : ' was'} not sent.` });
    }
    return cancelled;
  }

  failSends(entries) {
    for (const e of entries) {
      this.outbox.mark(e.id, 'failed');
      this.deferred.delete(e.id);
      this.event({ kind: 'error', code: 'send-failed', message: 'A message could not be delivered to Codex. Send it again.', recoverable: true, prompt: { id: e.id, text: e.text } });
    }
  }

  // The process was let go on purpose (a forced stop, the host's stop) with a message written to it and not yet
  // answered: one sent into the running turn (turn/steer). Its exit is not this chat's to clean up after any more,
  // so nothing would ever requeue, fail or cancel that send, and the chat would stay busy over it for good. Codex
  // may or may not have taken it, so it is handed back to be sent again, never sent twice.
  failUnanswered() {
    const lost = this.outbox.unacked();
    if (lost.length) this.failSends(lost);
  }

  // ---- settings ----

  modeAllowed(v) { return MODES.has(v) && (v !== 'bypassPermissions' || this.allowBypass === true); }

  rowOf(id) { return (this.models ?? []).find((m) => m.value === id) ?? null; }
  // The model list's row for the model in use, or null while that is not known.
  modelRow() { const id = this.settings.model ?? this.actual.model; return id ? this.rowOf(id) : null; }

  // The tier a turn asks for: 'priority' (Fast on) or null (standard). Canopy has one speed switch, Fast, so a chat
  // where it was never touched runs at standard speed too: the user's own Codex tier (Ultrafast, say) is never used.
  tierFor() {
    if (this.settings.fast !== true) return null;
    return this.modelRow()?.supportsFastMode === false ? null : FAST_TIER; // a model with no faster tier runs at standard speed
  }

  fastState() { return this.tierFor() === null ? 'off' : 'on'; }

  // The effort in use: chosen, else what Codex last said it ran with (which can be "none"), else the user's own as
  // the thread opened.
  effortNow() { return this.settings.effort ?? (this.actual.effortSaid ? this.actual.effort : this.base.effort) ?? null; }

  syncModel() {
    this.model = this.settings.model ?? this.actual.model ?? null;
    if (this.lastMeta) Object.assign(this.lastMeta, { model: this.model, effort: this.effortNow(), fastState: this.fastState() });
  }

  settingFailed(key, value, text, code, message) {
    this.event({ kind: 'notice', level: 'warn', text });
    this.event({ kind: 'setting-failed', key, value });
    return { ok: false, code, message: message ?? text };
  }

  // A choice is recorded, checked against this process's own model list (Codex itself accepts anything), and sent
  // with the next turn. An open thread is also told now, best effort.
  async applySet(key, value) {
    if (this.closed) return { ok: false, code: 'closed', message: 'This session was closed.' };
    if (typeof key === 'string' && CLAUDE_ONLY.has(key)) return { ok: true, applied: 'ignored' };
    const s = this.settings;
    const unset = value == null || value === '';
    const done = { ok: true, applied: 'next-turn' };
    switch (key) {
      case 'permissionMode': {
        if (!MODES.has(value)) return this.settingFailed(key, this.mode, 'Could not change permissionMode: unknown permission mode', 'invalid-input');
        if (!this.modeAllowed(value)) return this.settingFailed(key, this.mode, BYPASS_NOTICE, 'not-allowed');
        s.permissionMode = value;
        this.mode = value;
        if (value !== 'plan') this.withdraw('plan'); // leaving Plan by hand: a plan still waiting is no longer on offer
        if (this.lastMeta) this.lastMeta.mode = value;
        this.event({ kind: 'setting', key, value });
        // Plan-ness travels with the next turn only: switching it installs a note in the chat, so it is not sent for nothing.
        const w = MODE_WIRE[value];
        this.pushSettings({ approvalPolicy: w.approvalPolicy, approvalsReviewer: w.reviewer, sandboxPolicy: this.sandboxFor(w.sandbox) });
        return done;
      }
      case 'model': {
        if (!unset && (typeof value !== 'string' || value.length > 200)) return this.settingFailed(key, s.model, 'Could not change model: it must be a name', 'invalid-input');
        if (!unset && this.models && !this.rowOf(value)) return this.settingFailed(key, s.model, `Could not change model: Codex does not offer "${value}".`, 'invalid-input');
        s.model = unset ? undefined : value;
        this.syncModel();
        this.event({ kind: 'setting', key, value });
        this.dropEffortTheModelLacks();
        if (!unset) this.pushSettings({ model: value }, 'model');
        return done;
      }
      case 'effort': {
        if (!unset && (typeof value !== 'string' || !EFFORT_RE.test(value))) return this.settingFailed(key, s.effort, 'Could not change effort: unknown effort level', 'invalid-input');
        const row = this.modelRow();
        if (!unset && row && !row.supportedEffortLevels.includes(value)) return this.settingFailed(key, s.effort, `Could not change effort: this model does not offer "${value}".`, 'invalid-input');
        s.effort = unset ? undefined : value;
        this.syncModel();
        this.event({ kind: 'setting', key, value });
        if (!unset) this.pushSettings({ effort: value }, 'effort');
        return done;
      }
      case 'fast': {
        if (!unset && typeof value !== 'boolean') return this.settingFailed(key, s.fast, 'Could not change fast: it must be on or off', 'invalid-input');
        if (value === true && this.modelRow()?.supportsFastMode === false) return this.settingFailed(key, s.fast, 'Could not change fast: this model has no faster tier.', 'invalid-input');
        s.fast = unset ? undefined : value;
        this.syncModel();
        this.event({ kind: 'setting', key, value });
        this.pushSettings({ serviceTier: this.tierFor() }, 'tier');
        return done;
      }
      default:
        return this.settingFailed(String(key), undefined, `Could not change ${String(key)}: unknown setting`, 'invalid-input');
    }
  }

  // The chosen effort is not one the model in use offers: back to unset, and say so.
  dropEffortTheModelLacks() {
    const row = this.modelRow();
    if (!this.settings.effort || !row || row.supportedEffortLevels.includes(this.settings.effort)) return;
    this.settings.effort = undefined;
    this.syncModel();
    this.event({ kind: 'setting', key: 'effort', value: '' });
  }

  // The model list is known now: a choice it does not hold is dropped before Codex is asked to run with it.
  checkChoices() {
    if (!this.models) return;
    const s = this.settings;
    if (s.model && !this.rowOf(s.model)) {
      const bad = s.model;
      s.model = undefined;
      this.syncModel();
      this.settingFailed('model', '', `Could not change model: Codex does not offer "${bad}".`, 'invalid-input');
    }
    this.dropEffortTheModelLacks();
  }

  // A mode's sandbox as an object. thread/start takes the word and Codex fills it in from the user's own config
  // (network access, extra writable folders); the object a turn carries replaces all of that. So what is sent is
  // what Codex itself reported for that sandbox: at thread/start, in a settings echo, or in the user's config. The
  // plain built-in one is used only when Codex has said nothing.
  sandboxFor(word) {
    const seen = this.sandboxes[SANDBOX_TYPE[word]];
    if (isPlain(seen)) { try { return structuredClone(seen); } catch { /* not plain data: the built-in one */ } }
    return (SANDBOX_POLICY[word] ?? SANDBOX_POLICY['read-only'])();
  }

  rememberSandbox(policy) {
    if (isPlain(policy) && typeof policy.type === 'string' && Object.values(SANDBOX_TYPE).includes(policy.type)) this.sandboxes[policy.type] = policy;
  }

  // The user's own workspace-write settings, read from their config through the app-server (nothing is opened on
  // disk here). A chat that starts in Ask never sees them otherwise, and Accept Edits would switch their network
  // access off. Best effort: without an answer the built-in sandbox stands.
  // The same answer holds their own developer instructions, which Canopy's note is added to (see developerNote).
  async loadSandbox(proc) {
    if (this.sandboxes.workspaceWrite && this.ownNote !== undefined) return;
    try {
      const r = await proc.request('config/read', { includeLayers: false, cwd: this.cwd }, { timeoutMs: this.t.meta });
      if (this.ownNote === undefined && isPlain(r?.config)) this.ownNote = typeof r.config.developer_instructions === 'string' && r.config.developer_instructions.trim() ? r.config.developer_instructions : null;
      if (isPlain(r?.config)) this.nameTaken = isPlain(r.config.mcp_servers) && Object.hasOwn(r.config.mcp_servers, CANOPY_SERVER);
      if (isPlain(r?.config)) this.askTools = promptTools(r.config.mcp_servers);
      if (isPlain(r?.config)) this.ownSkillCap = r.config.skills?.max_context_tokens !== undefined && r.config.skills?.max_context_tokens !== null;
      const own = r?.config?.sandbox_workspace_write;
      if (!isPlain(own) || this.sandboxes.workspaceWrite) return;
      this.sandboxes.workspaceWrite = {
        type: 'workspaceWrite', writableRoots: Array.isArray(own.writable_roots) ? own.writable_roots.filter((p) => isAbs(p)) : [],
        networkAccess: own.network_access === true, excludeTmpdirEnvVar: own.exclude_tmpdir_env_var === true, excludeSlashTmp: own.exclude_slash_tmp === true,
      };
    } catch (err) { this.log('info', 'codex config read failed', { error: this.redact(errText(err)) }); }
  }

  // The list of skills in every request. Codex fills it with every installed skill's full description: about 11,200
  // tokens in every request with a few plugins installed (measured). Capped at
  // SKILL_TOKENS every skill is still listed with a shorter description (about 4,600 tokens), and Codex picked the
  // right skill for 8 of 8 requests that each called for one, as it did without the cap; a cap of 2,200 cut the
  // descriptions to about 23 characters, too short to trust. Set for the thread only, and only when the user's own
  // config (as Codex answered config/read) has no size of its own: unknown means nothing is set.
  skillCap() { return this.ownSkillCap === false ? { 'skills.max_context_tokens': SKILL_TOKENS } : null; }

  // Canopy's own skills, the same two a Claude chat has (plugin.mjs). Codex is told one more folder to look for
  // skills in, for this process only: nothing is written under ~/.codex, and the user's own skills stay as they are.
  // It is said before the thread opens, which is when Codex lists the skills for the model. A Codex that does not
  // know the call, or refuses it, opens the chat without them.
  async loadSkills(proc) {
    if (!this.skillRoots.length) return;
    try { await proc.request('skills/extraRoots/set', { extraRoots: this.skillRoots }, { timeoutMs: this.t.meta }); }
    catch (err) { this.log('warn', 'codex was not given Canopy\'s skills', { error: this.redact(errText(err)) }); }
  }

  // The facts about Canopy (facts.mjs), as the thread's developer instructions: the place Codex gives a host for a
  // standing note. A thread takes one text there, and it stands in for the user's own `developer_instructions`, so
  // theirs go first and Canopy's after. When their config could not be read nothing is sent: a chat without the note
  // is better than one that silently lost its user's instructions. Read once and kept, so a chat says the same thing
  // every time it is opened.
  //
  // After the facts comes what is remembered (memory.mjs): the index of Canopy Memory's notes about the user and this
  // project, and Claude Code's own notes about them, which Codex never loads itself. Codex's own memory is left to
  // Codex. Like the facts they are read once, when the chat first starts, and kept: a note saved meanwhile is found
  // with the recall tool, and is in the index of the next chat.
  developerNote() {
    if (this.ownNote === undefined) return undefined;
    const facts = this.kit && pluginMod.KIT_NOTE ? `${CANOPY_FACTS_NEUTRAL}\n- ${pluginMod.KIT_NOTE}` : CANOPY_FACTS_NEUTRAL;
    if (this.memo === undefined && !this.memoryStore) this.memo = null;
    if (this.memo === undefined) {
      // A chat opened again within the hour is told what it was told before, word for word (memory-store.mjs told()).
      const kept = this.sessionId ? this.memoryStore.told(this.sessionId) : undefined;
      const env = kept === undefined && this.memoryBridge ? this.resolve(this.env) : null; // where Claude Code keeps its notes
      this.memo = kept !== undefined ? kept || null : [
        canopyMemoryNote({ store: this.memoryStore, cwd: this.cwd, recallName: `mcp__${CANOPY_SERVER}__recall`, forgetName: `mcp__${CANOPY_SERVER}__forget` }),
        this.memoryBridge && claudeMemoryNote(this.cwd, { home: env?.HOME || undefined, configDir: env?.CLAUDE_CONFIG_DIR || undefined }),
      ].filter(Boolean).join('\n\n') || null;
      this.keepMemo();
    }
    return [this.ownNote, facts, this.memo].filter(Boolean).join('\n\n');
  }

  // What this chat was told of memory is kept under its id for an hour past its last turn: said again when the chat
  // gets its id and at the end of every turn.
  keepMemo() {
    if (this.memoryStore && this.memo !== undefined && this.sessionId) this.memoryStore.tell(this.sessionId, this.memo ?? '');
  }

  // Tell an open thread about a changed setting between turns. Best effort: every turn/start carries the full
  // settings anyway, and a turn in flight keeps what it started with.
  pushSettings(patch, sentKey) {
    const proc = this.q;
    if (!proc || !this.loaded || !this.threadId || this.active || this.opening) return;
    this.fire(proc.request('thread/settings/update', { threadId: this.threadId, ...patch }, { timeoutMs: this.t.set }).then(
      () => { if (this.proc === proc && sentKey) this.sent[sentKey] = true; },
      (err) => this.log('warn', 'settings update failed', { error: this.redact(errText(err)) }),
    ));
  }

  // The settings a turn starts with: always the full mode; model, effort and tier only when chosen. A choice that
  // was sent and then unset goes back to what the thread opened with (the user's own), once.
  turnParams(input) {
    const w = MODE_WIRE[this.mode] ?? MODE_WIRE.default;
    const s = this.settings;
    const params = { threadId: this.threadId, input, approvalPolicy: w.approvalPolicy, approvalsReviewer: w.reviewer, sandboxPolicy: this.sandboxFor(w.sandbox) };
    if (s.model) params.model = s.model;
    else if (this.sent.model && this.base.model) params.model = this.base.model;
    if (s.effort) params.effort = s.effort;
    else if (this.sent.effort && this.base.effort) params.effort = this.base.effort;
    const tier = this.tierFor();
    if (tier !== undefined) params.serviceTier = tier;
    else if (this.sent.tier && this.base.tier !== undefined) params.serviceTier = this.base.tier === 'default' ? null : this.base.tier;
    // A new thread starts in default; what a resumed one was left in is not reported, so its first turn says.
    // A collaboration mode carries its own effort, and Codex reads null there as "clear it", not "leave it". So it
    // carries the effort the thread has: the chosen one, else the user's own as the thread opened with it.
    let collab = null;
    const model = params.model ?? this.actual.model ?? this.model;
    if (this.collab !== w.collab && model) {
      collab = w.collab;
      params.collaborationMode = { mode: collab, settings: { model, reasoning_effort: params.effort ?? this.actual.effort ?? this.base.effort ?? null, developer_instructions: null } };
    }
    return { params, sent: { model: !!s.model, effort: !!s.effort, tier: tier !== undefined }, collab };
  }

  // ---- prompts from Codex ----

  onRequest(proc, id, method, params, msg) {
    if (this.proc !== proc || this.closed) { proc.respondError(id, -32603, 'This chat is closing.'); return; }
    this.raiseRequest(proc, id, method, params, msg);
  }

  // Put a request to the user. `proc` is whoever is owed the answer (respond, respondError, alive): the Codex
  // process for a question of Codex's, or what stands in for it when one of Canopy's own tools asks (see askTool).
  raiseRequest(proc, id, method, params, msg) {
    let req = null;
    // One of the chat's agents asking: its card says who asked (`agentId`), as a Claude subagent's does.
    const from = typeof params?.threadId === 'string' && this.threadId && params.threadId !== this.threadId && this.agents.has(params.threadId) ? params.threadId : null;
    const about = from ? { threadId: from, parent: this.agents.rowOf(from) ?? from } : this.threadId ? { threadId: this.threadId } : undefined;
    try { req = this.adapter.request(msg ?? { id, method, params }, about); } catch { req = null; }
    // Not a question for the user. An unanswered request would hang its sender, so it is told no.
    if (!isPlain(req)) { proc.respondError(id, -32601, `Canopy does not answer ${method}.`); return; }
    req.rpcId ??= id;
    const stopping = !!this.active?.stopAsked || (typeof req.turnId === 'string' && this.closedTurns.has(req.turnId));
    // The window has no elicitation card unless the host asked for one (Claude chats raise none either). That is
    // about forms and sign-in links: an MCP tool asking for a yes comes by the same method, but the adapter hands it
    // over as an ordinary tool approval (`type: 'tool'`), and it is always raised.
    if (stopping || (req.type === 'elicitation' && !this.ext.has('elicitation'))) { proc.respond(req.rpcId, req.fallback); return; }
    // Bypass: what Codex asks for itself is a yes, at once (see ASK_ALL). Never a question, a form or a link, never
    // a server asking for itself, never a tool the user's own config says to ask about.
    if (this.mode === 'bypassPermissions' && this.bypasses(req)) {
      let yes = null;
      try { yes = this.A.replyTo(req, { action: 'allow' }); } catch { yes = null; }
      if (isPlain(yes?.result)) { proc.respond(req.rpcId, yes.result); return; }
    }
    const pid = ++requestSeq;
    const ev = { kind: 'permission', id: pid, ...(isPlain(req.base) ? req.base : {}), sessionId: this.sessionId };
    this.pending.set(pid, { id: pid, req, ev, proc });
    this.event(ev);
    if (this.busy) this.setBusy(true, 'requires_action');
  }

  // Is this one of the approvals Bypass answers for the user? Codex's own, about a command, a file change, more
  // access or one of the user's MCP tools.
  bypasses(req) {
    if (req.type !== 'tool') return false;
    if (BYPASSED.has(req.method)) return true;
    if (req.method !== 'mcpServer/elicitation/request' || req.own === true) return false;
    return !this.askTools.has(`${req.server}/${req.tool}`) && !this.askTools.has(`${req.server}/*`);
  }

  // Every open prompt goes away without the user: answered "no" when Codex can still hear it.
  resolvePending({ answer = false } = {}) {
    const open = [...this.pending.values()].filter((p) => !p.passive); // a card Canopy raised itself outlives the turn (see raise)
    if (!open.length) return;
    for (const p of open) {
      this.pending.delete(p.id);
      if (answer && p.proc?.alive) p.proc.respond(p.req.rpcId, p.req.fallback);
      this.event({ kind: 'permission-resolved', id: p.id });
    }
    this.afterPrompt();
  }

  // ---- Canopy's own tools (codex-tools.mjs) ----

  // The `config` this process's thread is opened with so that it has Canopy's tools, or null. What it carries is
  // this process's alone, and stops working when the process is gone.
  // Not when the user has an MCP server of their own under the same name: Codex lays Canopy's entry over theirs key
  // by key, and the mix can be one Codex refuses to open any thread with (checked, 0.169.0: theirs with a `url`
  // gives "url is not supported for stdio"). Theirs is left as it is and the chat goes without Canopy's tools. The
  // same when their config could not be read: a chat without the tools is better than one that cannot start.
  async linkTools(proc) {
    if (!this.ownTools) return null;
    if (this.nameTaken !== false) {
      if (this.nameTaken && !this.noticed.has('own-server')) {
        this.noticed.add('own-server');
        this.log('warn', `the user has an MCP server of their own named ${CANOPY_SERVER}, so Canopy's tools are left out of this chat`);
      }
      return null;
    }
    const link = await this.ownTools.link();
    if (!link) return null;
    proc.exited.then(() => link.close());
    return link.config;
  }

  // One of Canopy's tools needs the user's yes before it runs (a look at a page out on the web, say). Codex asked
  // nothing: it lets Canopy's tools through, and Canopy decides about them itself. The question is put in the words
  // Codex uses for an MCP tool of its own, so it is the same card, answered the same way and taken down with the
  // turn like any other; only the answer goes to the tool instead of to Codex. `meta` is the call as the relay names
  // it. Resolves to 'allow', 'always' (for this chat) or 'deny'. Never rejects.
  askTool(tool, args, meta = {}) {
    return new Promise((resolve) => {
      const signal = meta.signal;
      if (this.closed || !this.q || !this.threadId || signal?.aborted) return resolve('deny');
      let said = false;
      // Stands where the Codex process stands for a question of Codex's own: what the card answers to.
      const asker = { alive: true, respond: (_id, result) => answer(result), respondError: () => answer(null) };
      const answer = (result) => {
        if (said) return;
        said = true;
        asker.alive = false;
        resolve(result?.action !== 'accept' ? 'deny' : result._meta?.persist ? 'always' : 'allow');
      };
      // The call was stopped while its card was up (Stop, or its process went): the card goes with it.
      signal?.addEventListener('abort', () => this.guard(() => {
        for (const p of [...this.pending.values()]) {
          if (p.proc !== asker) continue;
          this.pending.delete(p.id);
          this.event({ kind: 'permission-resolved', id: p.id });
          this.afterPrompt();
        }
        answer(null);
      }), { once: true });
      // A call made by one of the chat's agents is asked about under that agent's name, as Codex's own would be.
      const agent = typeof meta.threadId === 'string' && meta.threadId !== this.threadId && this.agents.has(meta.threadId) ? meta.threadId : null;
      const params = {
        threadId: agent ?? this.threadId, turnId: meta.turnId ?? this.active?.id ?? null,
        serverName: CANOPY_SERVER, mode: 'form', message: null, requestedSchema: { type: 'object', properties: {} },
        // "For this chat" is all Canopy remembers a yes by (see codex-tools.mjs).
        _meta: {
          codex_approval_kind: 'mcp_tool_call', persist: ['session'], tool_name: tool.name, tool_params: args,
          ...(typeof tool.annotations?.title === 'string' && { tool_title: tool.annotations.title }), ...(meta.callId && { call_id: meta.callId }),
        },
      };
      const id = `canopy-tool-${++requestSeq}`;
      this.guard(() => this.raiseRequest(asker, id, 'mcpServer/elicitation/request', params, { id, method: 'mcpServer/elicitation/request', params }));
      if (!said && ![...this.pending.values()].some((p) => p.proc === asker)) answer(null); // it could not be put to anyone
    });
  }

  // ---- starting ----

  /** The process up and the thread open: one start shared by everyone who asks while it runs. */
  open() {
    if (this.closed) return Promise.reject(coded('aborted', 'This session was closed.'));
    // The last process died and its exit has not been dealt with yet: that comes first, so its turn is closed and its
    // sends are back in line before a new process takes over.
    if (this.proc && !this.proc.alive && !this.opening) this.onExit(this.proc);
    if (this.proc?.alive && this.loaded && !this.opening) return Promise.resolve(this.proc);
    if (!this.opening) {
      const p = this.doOpen().finally(() => { if (this.opening === p) this.opening = null; });
      p.catch(() => {});
      this.opening = p;
    }
    return this.opening;
  }

  async doOpen() {
    await Promise.allSettled([...this.reaps]); // one process per chat: the last one is gone first
    const startedAt = Date.now();
    let proc = null;
    this.setTimer('slow', this.t.slowStart, () => {
      if (!this.closed && this.lifecycle === 'starting') this.event({ kind: 'notice', level: 'warn', code: 'slow-start', text: SLOW_START, stderr: this.shownStderr(proc) });
    });
    try {
      const codexPath = this.resolve(this.codexPath);
      if (!isAbs(codexPath)) throw coded('not-installed', NOT_INSTALLED);
      if (!dirExists(this.cwd)) throw coded('cwd-missing', `This folder no longer exists${this.cwd ? `: ${this.cwd}` : '.'}`);
      // Another app has this chat open: Codex would refuse it, so no process is started to be told so.
      const held = this.heldText();
      if (held) throw coded('held-elsewhere', held);
      // What this chat's account is launched with, asked at every start: a key replaced since the last one is
      // the key this process gets. An account that cannot be launched stops the start here, before any process.
      const launch = this.launchOf(codexEnv(this.resolve(this.env)));
      const env = launch.env;
      this.lastEnv = env; this.redactor = null;
      this.provider = launch.provider;
      for (let attempt = 0; ; attempt++) {
        if (this.closed || this.hostStopped) throw coded('aborted', 'Codex was stopped.');
        this.lifecycle = 'starting';
        proc = this.spawnProc(codexPath, env, launch.config);
        try { await proc.ready; break; }
        catch (err) {
          // No answer to the handshake: once more on a new process, then give up.
          if (err?.code !== 'timeout' || attempt > 0 || this.proc !== proc) throw err;
          this.log('warn', 'codex did not answer initialize; trying once more');
          this.detach();
          await this.reap(proc, 0);
        }
      }
      const live = () => { if (this.closed || this.proc !== proc) throw coded('aborted', 'Codex was stopped.'); };
      live();
      await Promise.all([this.loadModels(proc), this.loadAccount(proc), this.loadSandbox(proc), this.loadSkills(proc)]);
      live();
      this.checkChoices();
      await this.loadThread(proc);
      live();
      this.checkChoices(); // the model in use is known now
      this.lifecycle = 'ready';
      this.startupMs = Date.now() - startedAt;
      this.fire(this.loadLimits(proc));
      this.publishMeta({
        engine: 'codex', commands: CODEX_COMMANDS.map((c) => ({ ...c })), mode: this.mode, sessionId: this.sessionId, model: this.model,
        effort: this.effortNow(), fastState: this.fastState(), fastReason: null,
        version: this.version, account: this.account, startupMs: this.startupMs, restricted: false, codeBlocked: null,
      });
      if (!apiKeyNoticeShown && this.account?.type === 'apiKey') {
        apiKeyNoticeShown = true;
        this.noticed.add('api-key-billing');
        this.event({ kind: 'notice', code: 'api-key-billing', text: API_KEY_BILLING });
      }
      return proc;
    } catch (err) {
      const aborted = this.closed || (proc !== null && this.proc !== proc);
      if (proc && this.proc === proc) { this.detach(); this.fire(this.reap(proc, 0)); }
      if (aborted || err?.canopy?.code === 'aborted') throw coded('aborted', 'Codex was stopped.');
      throw this.startError(err, proc);
    } finally {
      this.clearTimer('slow');
    }
  }

  // The sentence for a chat another app has open, or null. `refused`: Codex itself just refused the chat for that,
  // so there is always a sentence, and the host hears of it (it may not have known).
  heldText(refused = false) {
    let said = null;
    try { said = this.sessionId && this.heldFn ? this.heldFn(this.sessionId, refused) : null; } catch { said = null; }
    return typeof said === 'string' && said ? said : refused ? OPEN_ELSEWHERE : null;
  }

  // The end of what a process wrote to its error output, as an error card shows it.
  shownStderr(proc) { return this.redact(shownStderr(proc?.stderr).slice(-1500)); }

  // What this chat's process is started with: its account's environment and settings, as the host launches that
  // account, and the model provider it must then come up on. A host that names no accounts starts Codex as it
  // finds itself: the environment as it is, no setting, and nothing to hold it to.
  launchOf(base) {
    if (!this.launchFn) return { env: base, config: {}, provider: null };
    const l = this.launchFn(base, this.accountId); // throws when the account cannot be launched: the chat says why
    if (!isPlain(l) || !isPlain(l.env)) throw coded('launch-failed', 'Codex could not start: this chat’s account could not be set up.');
    return { env: l.env, config: isPlain(l.config) ? l.config : {}, provider: typeof l.provider === 'string' && l.provider ? l.provider : null };
  }

  spawnProc(codexPath, env, config) {
    const proc = new CodexProcess({
      codexPath, env, cwd: this.cwd, config: { ...CODEX_OVERRIDES, ...this.config, ...(isPlain(config) ? config : {}) }, flags: this.flags, appVersion: this.appVersion,
      spawnFn: this.spawnFn, initTimeoutMs: this.t.init, requestTimeoutMs: this.t.turn,
      onNotification: (method, params, msg) => this.guard(() => this.onLine(proc, method, params, msg)),
      onRequest: (id, method, params, msg) => this.guard(() => this.onRequest(proc, id, method, params, msg)),
      onGarbage: (text, why) => this.log('warn', 'codex wrote a line that is not a message', { why, length: text.length }),
    });
    this.proc = proc;
    this.loaded = false;
    if (this.spawned++ > 0) this.restarts += 1;
    proc.start();
    proc.exited.then(() => this.guard(() => this.onExit(proc)));
    return proc;
  }

  // What a failed start means, as { code, message, retry }. `retry` is a process that died while starting.
  startError(err, proc) {
    if (err?.canopy) return err;
    const exit = proc?.exit ?? null;
    const cause = exit?.error ?? err?.cause ?? null;
    const detail = this.redact(errText(cause ?? err));
    const stderr = this.shownStderr(proc);
    // Codex refused the chat because another app has it open: said in plain words, without its log.
    if (ACTIVE_WRITER.test(detail) || ACTIVE_WRITER.test(stderr)) return coded('held-elsewhere', this.heldText(true));
    if (exit?.failed || err?.code === 'spawn') {
      if (cause?.code === 'ENOENT') return coded('not-installed', NOT_INSTALLED);
      return coded('launch-failed', `Codex could not start: ${detail}`);
    }
    if (err?.code === 'timeout') return coded('timeout', 'Codex could not start: it did not answer in time.', { stderr });
    if (err?.code === 'closed') {
      const how = exit?.signal ? `signal ${exit.signal}` : exit?.code != null ? `exit code ${exit.code}` : null;
      return coded('crashed', `Codex could not start: it stopped while starting${how ? ` (${how})` : ''}.`, { retry: true, stderr });
    }
    return coded('launch-failed', `Codex could not start: ${detail}`, { stderr });
  }

  // A start that failed. With messages waiting and a process that merely died, it is tried again while the budget
  // allows. Otherwise the waiting messages are handed back; from warm() with nothing waiting it is only a notice.
  openFailed(err, { warm = false } = {}) {
    const c = err?.canopy ?? { code: 'launch-failed', message: `Codex could not start: ${this.redact(errText(err))}` };
    if (c.code === 'aborted' || this.closed) return { ok: false, code: this.closed ? 'closed' : 'stopped', message: this.closed ? 'This session was closed.' : 'Codex was stopped.' };
    const result = { ok: false, code: c.code, message: c.message };
    if (c.reported) return result;
    c.reported = true;
    this.log('warn', 'codex could not start', { code: c.code, stderr: c.stderr ?? null });
    const waiting = this.outbox.pending().length > 0;
    if (c.retry && waiting && !this.hostStopped) {
      if (!this.budget.allow()) { this.crashLoop(c.stderr ?? ''); return result; }
      this.lifecycle = 'stopped';
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'exit', willRestart: true });
      this.restartSoon();
      return result;
    }
    this.lifecycle = 'failed';
    const prompts = briefly(this.outbox.closeAll('failed'));
    this.deferred.clear();
    const changed = this.dropBusy();
    // Warming up a chat another app has open says nothing: the window shows that in place of the message box.
    if (warm && !prompts.length) { if (c.code !== 'held-elsewhere') this.event({ kind: 'notice', level: 'warn', code: c.code, text: c.message }); }
    else this.event({ kind: 'error', code: c.code, message: c.message, recoverable: false, prompts, ...(c.stderr && { stderr: c.stderr }) });
    this.announceIdle(changed);
    return result;
  }

  restartSoon() {
    const delayMs = Number.isFinite(this.t.restart) ? this.t.restart : backoffMs(this.budget.attempt);
    this.setTimer('restart', delayMs, () => this.fire(this.deliver()));
    return delayMs;
  }

  async loadModels(proc) {
    if (this.models) return;
    try {
      const rows = await withTimeout(listModels((method, params) => proc.request(method, params, { timeoutMs: this.t.meta }), { includeHidden: true }), this.t.meta, 'model/list');
      if (rows.length) this.models = rows;
    } catch (err) { this.log('warn', 'codex model list failed', { error: this.redact(errText(err)) }); }
  }

  async loadAccount(proc) {
    try {
      const r = await proc.request('account/read', { refreshToken: false }, { timeoutMs: this.t.meta });
      const a = isPlain(r?.account) ? r.account : null;
      this.account = a ? { type: a.type ?? null, email: a.email ?? null, plan: a.planType ?? null } : null;
    } catch (err) { this.log('warn', 'codex account read failed', { error: this.redact(errText(err)) }); }
  }

  // The plan's usage limits, asked once the thread is open and after each turn (updates in between arrive on their
  // own). A login with no plan (an API key) is refused: that is "no limits", said once in the log and never to the user.
  async loadLimits(proc) {
    if (this.limitsOff || this.proc !== proc || !proc.alive) return;
    if (this.account?.type === 'apiKey' || this.provider) {
      // Codex refuses this call under an API key ("chatgpt authentication required"), so it is not made. Nor on a
      // process started for a key pasted into Canopy (`provider`): Codex's own login is not in play there, so
      // there is no plan to ask about, and such a process is asked nothing about an account but who is signed in.
      this.limitsOff = true;
      this.log('info', 'codex reports no usage limits for this login', { account: 'apiKey' });
      return;
    }
    try {
      const r = await proc.request('account/rateLimits/read', undefined, { timeoutMs: this.t.meta });
      if (this.proc === proc && isPlain(r?.rateLimits)) this.rateSnapshot = r.rateLimits;
    } catch (err) {
      if (this.proc !== proc || err?.code === 'closed') return;
      if (err?.code === 'rpc') {
        this.limitsOff = true;
        this.rateSnapshot = null;
        this.log('info', 'codex reports no usage limits for this login', { error: this.redact(errText(err)) });
      }
    }
  }

  // Open the thread in this process: resume a chat that is on disk, start a new one otherwise.
  async loadThread(proc) {
    const w = MODE_WIRE[this.mode] ?? MODE_WIRE.default;
    const s = this.settings;
    const tier = this.tierFor();
    const note = this.developerNote();
    const own = await this.linkTools(proc);
    if (this.closed || this.proc !== proc) return;
    const common = {
      cwd: this.cwd, approvalPolicy: w.approvalPolicy, approvalsReviewer: w.reviewer, sandbox: w.sandbox,
      ...(s.model && { model: s.model }), ...(tier !== undefined && { serviceTier: tier }),
      ...(note && { developerInstructions: note }),
      // The thread's own settings (never the process's flags): Canopy's tools, and the skill list's size (skillCap).
      ...((own || this.skillCap()) && { config: { ...this.skillCap(), ...(own ?? {}) } }),
    };
    let result = null;
    let resumed = false;
    if (this.sessionId) {
      try {
        result = await proc.request('thread/resume', { threadId: this.sessionId, ...common, excludeTurns: true }, { timeoutMs: this.t.thread });
        resumed = true;
      } catch (err) {
        // Codex will not open a chat where the provider it began on is not set up. For Canopy's own provider that
        // means a chat begun on a pasted key, opened by a process that was not started for one.
        if (err?.code === 'rpc' && err.data?.type === 'modelProviderNotConfigured' && err.data.modelProvider === KEY_PROVIDER) throw coded('account-kept', BEGAN_ON_A_KEY);
        if (err?.code !== 'rpc' || !/no rollout found/i.test(errText(err))) throw err;
        if (this.closed || this.proc !== proc) throw err;
        // The chat is gone from disk: carry on in a new one, and say so.
        const previous = this.sessionId;
        this.lostSessionId = previous;
        this.sessionId = null;
        this.threadId = null;
        if (this.lastMeta) this.lastMeta.sessionId = null;
        try { this.adapter.reset?.(); } catch { /* optional */ }
        this.agents.reset();
        this.notes.clear(); this.work.clear(); // the new chat remembers nothing a note could set right
        this.event({ kind: 'notice', level: 'warn', code: 'resume-missing', text: CHAT_GONE });
        this.event({ kind: 'meta', sessionId: null, previousSessionId: previous });
      }
    }
    if (!result) result = await proc.request('thread/start', common, { timeoutMs: this.t.thread });
    if (this.closed || this.proc !== proc) return;
    const thread = isPlain(result?.thread) ? result.thread : {};
    if (typeof thread.id !== 'string' || !thread.id) throw coded('launch-failed', 'Codex could not start: it did not open the conversation.');
    // A process started for a pasted key must have the chat on that key's provider. A saved chat comes up on the
    // provider it began on whatever the process was started for, and that would be Codex's own login: not run.
    const on = typeof result.modelProvider === 'string' && result.modelProvider ? result.modelProvider : null;
    if (this.provider && on && on !== this.provider) throw coded('account-kept', resumed ? BEGAN_ON_THE_LOGIN : NOT_ON_ITS_KEY);
    this.threadId = thread.id;
    if (resumed && this.sessionId !== thread.id) this.sessionId = thread.id;
    this.loaded = true;
    this.collab = resumed ? null : 'default';
    // A new chat has no goal. A reopened one may: until Codex says, it is not known (and its first word on it is not news).
    this.goal = resumed ? undefined : null;
    const reported = (v) => (typeof v === 'string' && v ? v : null);
    this.actual = { model: reported(result.model) ?? reported(thread.model), effort: null, tier: reported(result.serviceTier) };
    // What the thread opened with where Canopy chose nothing is the user's own: the way back from a choice that is later unset.
    this.base = {
      model: s.model ? undefined : this.actual.model ?? undefined,
      effort: reported(result.reasoningEffort) ?? reported(thread.reasoningEffort) ?? undefined,
      tier: tier !== undefined ? undefined : this.actual.tier ?? undefined,
    };
    this.sent = { model: !!s.model, effort: false, tier: tier !== undefined };
    this.version = reported(thread.cliVersion) ?? this.version ?? String(proc.info?.userAgent ?? '').match(/\/(\d+\.\d+\.\d+[^\s(]*)/)?.[1] ?? null;
    this.syncModel();
    this.rememberSandbox(result.sandbox);
    this.startResult = result;
    if (resumed) { this.initPending = false; this.event(this.initOf(result)); }
    else this.initPending = true; // a new chat says `init` when its first turn starts: only then is it on disk
  }

  // `init` says what the chat runs with now. A new chat says it at its first turn, and a model, effort or Fast
  // choice made since it opened is newer than the thread/start answer; a value nobody chose stays as answered.
  initOf(result) {
    let ev = null;
    try {
      const now = { permissionMode: this.mode };
      if (this.model) now.model = this.model;
      const effort = this.effortNow();
      if (effort) now.effort = effort;
      const fast = this.fastState();
      if (fast) now.fastState = fast;
      ev = this.A.initEvent(result, now);
    } catch { ev = null; }
    return isPlain(ev) ? ev : { kind: 'init', sessionId: this.sessionId, engine: 'codex', permissionMode: this.mode };
  }

  publishMeta(patch) {
    this.lastMeta = { ...(this.lastMeta ?? {}), ...patch, kind: 'meta' };
    this.event({ kind: 'meta', ...patch });
  }

  // ---- lines from Codex ----

  onLine(proc, method, params, msg) {
    if (this.proc !== proc || this.closed) return;
    const p = isPlain(params) ? params : {};
    // Another thread on this process: one of this chat's agents (its steps go under its Agent row), or not this chat.
    if (this.threadId && typeof p.threadId === 'string' && p.threadId !== this.threadId) return this.onAgentLine(proc, p.threadId, method, p, msg);
    if (method === 'thread/started' && this.threadId && isPlain(p.thread) && p.thread.id !== this.threadId) {
      if (this.agents.noteThread(p.thread)) this.agentsChanged(proc);
      return;
    }
    // A late line for a turn already closed (deltas after a stop) would open a new streaming row.
    const turnId = typeof p.turnId === 'string' ? p.turnId : typeof p.turn?.id === 'string' ? p.turn.id : null;
    if (turnId && this.closedTurns.has(turnId) && !method.startsWith('thread/')) return;
    switch (method) {
      case 'turn/started': return this.onTurnStarted(proc, p, msg);
      case 'turn/completed': return this.onTurnCompleted(p, msg);
      case 'thread/status/changed': {
        // Never idle on this line: `idle` arrives just before turn/completed, which is what ends the turn.
        const st = isPlain(p.status) ? p.status : {};
        if (this.busy && this.active?.started && st.type === 'active') {
          const waiting = Array.isArray(st.activeFlags) && st.activeFlags.some((f) => f === 'waitingOnApproval' || f === 'waitingOnUserInput');
          this.setBusy(true, waiting || this.pending.size ? 'requires_action' : 'running');
        }
        break;
      }
      case 'thread/settings/updated': {
        // What Codex really runs with.
        const ts = isPlain(p.threadSettings) ? p.threadSettings : {};
        const before = JSON.stringify([this.model, this.lastMeta?.effort ?? null, this.lastMeta?.fastState ?? null]);
        if (typeof ts.model === 'string' && ts.model) this.actual.model = ts.model;
        if ('effort' in ts) { this.actual.effort = typeof ts.effort === 'string' && ts.effort ? ts.effort : null; this.actual.effortSaid = true; }
        this.rememberSandbox(ts.sandboxPolicy);
        if (typeof ts.serviceTier === 'string' && ts.serviceTier) this.actual.tier = ts.serviceTier;
        const cm = ts.collaborationMode?.mode;
        if (cm === 'plan' || cm === 'default') this.collab = cm;
        this.syncModel();
        if (this.lastMeta && before !== JSON.stringify([this.model, this.lastMeta.effort ?? null, this.lastMeta.fastState ?? null])) {
          this.event({ kind: 'meta', engine: 'codex', model: this.model, effort: this.lastMeta.effort ?? null, fastState: this.lastMeta.fastState ?? null });
        }
        break;
      }
      case 'serverRequest/resolved': {
        // Answered elsewhere (the automatic reviewer, the turn ending): the card goes away.
        for (const q of [...this.pending.values()]) {
          if (q.proc !== proc || q.req.rpcId !== p.requestId) continue;
          this.pending.delete(q.id);
          this.event({ kind: 'permission-resolved', id: q.id });
        }
        this.afterPrompt();
        break;
      }
      case 'mcpServer/startupStatus/updated':
        // Canopy's own server is not one of the user's: it is not listed, and one that did not start is only noted.
        if (p.name === CANOPY_SERVER && this.ownTools && this.nameTaken === false) {
          if (p.status === 'failed') this.log('warn', 'Canopy\'s tools did not start in this chat', { error: this.redact(String(p.error ?? '')).slice(0, 400) });
        } else if (typeof p.name === 'string' && p.name) {
          if (this.mcpRows.size >= 200 && !this.mcpRows.has(p.name)) this.mcpRows.clear();
          this.mcpRows.set(p.name, mcpRow(p.name, p));
          const mcp = [...this.mcpRows.values()];
          this.lastMeta = { ...(this.lastMeta ?? {}), mcp };
          this.event({ kind: 'meta', mcp });
        }
        break;
      case 'account/rateLimits/updated':
        // Laid over the last snapshot, for this chat's own context ring and Stats (limits()), and handed as it came to
        // the host's Usage tab, which follows the plan's limits between its own reads. The adapter still gets the line.
        this.rateSnapshot = mergeCodex(this.rateSnapshot, p.rateLimits);
        if (this.onRateLimits && isPlain(p.rateLimits)) { try { this.onRateLimits({ ...p.rateLimits }); } catch (err) { this.log('warn', 'observer failed', { error: errText(err) }); } }
        break;
      case 'thread/reverted':
        // The conversation was cut back. This session's own edit says so itself (`edit`); a cut it did not ask for
        // means whoever shows this chat has to read it again.
        if (!this.editing && Date.now() - this.revertedAt > this.t.ownRevert) this.event({ kind: 'reverted', sessionId: this.sessionId });
        break;
      case 'thread/name/updated': {
        const title = typeof p.threadName === 'string' ? p.threadName.trim() : '';
        if (title) { if (this.lastMeta) this.lastMeta.title = title; this.event({ kind: 'meta', title }); }
        break;
      }
      case 'account/updated':
        try { this.onAccountUpdated?.({ authMode: typeof p.authMode === 'string' && p.authMode ? p.authMode : null }); } catch { /* an observer never breaks the chat */ }
        break;
      case 'thread/goal/updated': this.onGoal(isPlain(p.goal) ? p.goal : null); break;
      // Every reopened chat sends this once: it is news only when a goal was known.
      case 'thread/goal/cleared': this.onGoal(null); break;
      case 'item/started': case 'item/completed':
        if (isPlain(p.item) && (p.item.type === 'collabAgentToolCall' || p.item.type === 'subAgentActivity') && this.agents.noteItem(p.item)) this.agentsChanged(proc);
        break;
      default:
    }
    // `/compact` that Codex runs without reporting a turn for it: the line that says it is done ends the made-up turn.
    const waits = this.active?.command === 'compact' && !this.active.started ? this.active : null;
    this.feed(msg);
    if (waits && (method === 'thread/compacted' || (method === 'item/completed' && p.item?.type === 'contextCompaction'))) this.commandDone(waits);
    if (method === 'thread/tokenUsage/updated') this.sayContext();
  }

  // The ring moves during a long turn too, as a Claude chat's does after each step: at most once a second, and
  // never in a turn's first second (its end reports the same numbers).
  sayContext() {
    const active = this.active;
    if (!active?.started) return;
    const now = Date.now();
    if (now - Math.max(this.ctxSaidAt, active.at) < this.t.contextEvery) return;
    const u = this.contextNow();
    if (!u) return;
    this.ctxSaidAt = now;
    this.event({ kind: 'context', totalTokens: u.totalTokens, maxTokens: u.maxTokens, percentage: u.percentage, limits: u.limits });
  }

  // ---- agents ----

  // A line from another thread. One of this chat's agents: its steps and words go out under its Agent row, and the
  // drawer's list follows it. Anything else is not this chat's and is dropped.
  onAgentLine(proc, id, method, p, msg) {
    if (!this.agents.has(id)) return;
    let changed = this.agents.noteLine(id, method, p);
    // An agent can start agents of its own.
    if ((method === 'item/started' || method === 'item/completed') && isPlain(p.item) && (p.item.type === 'collabAgentToolCall' || p.item.type === 'subAgentActivity')) {
      changed = this.agents.noteItem(p.item) || changed;
    }
    const row = this.agents.rowOf(id);
    if (row) this.feed(msg, null, { threadId: id, parent: row });
    if (method === 'turn/started' && this.agentStops.delete(id)) {
      const turn = this.agents.turnOf(id);
      if (turn) this.fire(proc.request('turn/interrupt', turn, { timeoutMs: this.t.interrupt }).catch((err) => this.log('warn', 'stopping an agent failed', { error: this.redact(errText(err)) })));
    }
    if (changed) this.agentsChanged(proc);
  }

  // The list of agents changed: the drawer is told, and agents that stay silent are asked for their lines.
  agentsChanged(proc) {
    this.emitTasks();
    const running = new Set(this.agents.tasks().filter((t) => t.status === 'running').map((t) => t.taskId));
    for (const id of [...this.agentSubs]) {
      if (running.has(id)) continue;
      this.agentSubs.delete(id);
      this.agentStops.delete(id);
      if (proc?.alive) this.fire(proc.request('thread/unsubscribe', { threadId: id }, { timeoutMs: this.t.set }).catch(() => {}));
    }
    this.watchAgents();
  }

  // While a running agent has said nothing and has not been asked for its lines, look again shortly.
  watchAgents() {
    if (this.timers.agents || !this.agents.quiet(0).some((id) => !this.agentSubs.has(id))) return;
    this.setTimer('agents', this.t.agentQuiet, () => {
      const proc = this.q;
      if (!proc || this.closed) return;
      for (const id of this.agents.quiet(this.t.agentQuiet)) this.subscribeAgent(proc, id);
      this.watchAgents();
    });
  }

  // Whether an agent's lines reach its parent's connection on their own is not known for this Codex (no recording
  // has an agent). One that stays silent is asked for the way Codex's own apps do: by opening its thread here too.
  subscribeAgent(proc, id) {
    if (this.agentSubs.has(id) || !proc?.alive) return;
    this.agentSubs.add(id);
    this.fire(proc.request('thread/resume', { threadId: id, excludeTurns: true }, { timeoutMs: this.t.thread }).catch((err) => {
      this.log('info', 'an agent could not be followed', { error: this.redact(errText(err)) });
    }));
  }

  emitTasks() { this.event({ kind: 'tasks', tasks: this.agents.tasks(), background: [] }); }

  // One line through the adapter, and what it says out as events. `about` is for a line of one of the chat's agents.
  feed(msg, each, about) {
    let events;
    try { events = this.adapter.adapt(msg, about ?? (this.threadId ? { threadId: this.threadId } : undefined)); }
    catch (err) { this.log('error', 'the codex adapter threw', { error: errText(err) }); events = []; }
    for (const ev of Array.isArray(events) ? events : []) {
      if (!isPlain(ev)) continue;
      if (each && each(ev) === false) continue;
      // Hooks run on every chat's first turn. Only one that failed is worth a row, unless the host asked for all.
      if (ev.kind === 'hook' && !this.hookVisible(ev)) continue;
      if (ev.kind === 'assistant-text' && ev.questions && this.askInPassing(ev)) continue; // the question card says it
      this.event(ev);
    }
  }

  hookVisible(ev) {
    if (this.ext.has('hooks')) return true;
    return ev.subtype === 'hook_response' && ev.outcome != null && ev.outcome !== 'completed' && ev.outcome !== 'success';
  }

  onTurnStarted(proc, p, msg) {
    const id = typeof p.turn?.id === 'string' ? p.turn.id : null;
    // A turn this session did not ask for (one that was running when the thread was reopened) is still this chat working.
    const active = this.active ??= { id: null, started: false, ids: [], opener: null, at: Date.now(), threadId: this.threadId, stopAsked: 0, userStopped: false, interruptSent: false };
    if (id) active.id = id;
    active.started = true;
    this.linkSends(active);
    for (const sendId of active.ids) this.outbox.mark(sendId, 'started');
    this.outbox.dropPayloads();
    this.adoptThread();
    this.sayAccount();
    this.setBusy(true, this.pending.size ? 'requires_action' : 'running');
    this.feed(msg);
    if (active.stopAsked) this.fire(this.sendInterrupt(proc, active));
    else this.fire(this.deliver()); // the sends that were waiting for this turn are folded into it
  }

  // The chat has a turn, so it is on disk from here on: it gets the id the host may keep, and says `init`.
  adoptThread() {
    if (!this.sessionId && this.threadId) {
      const previous = this.lostSessionId;
      this.sessionId = this.threadId;
      this.lostSessionId = null;
      if (this.lastMeta) this.lastMeta.sessionId = this.sessionId;
      if (previous) this.event({ kind: 'meta', sessionId: this.sessionId, previousSessionId: previous });
      this.keepMemo();
    }
    if (this.initPending && this.sessionId) {
      this.initPending = false;
      this.event(this.initOf(this.startResult));
    }
  }

  // What a chat says about its account, once, when its first turn starts: a chat that is opened and never used says
  // nothing. The words are the host's, which names accounts, and it has none when nothing changed since the chat
  // before. Left unsaid in a chat that has just said the older line about a key Codex holds itself.
  sayAccount() {
    if (!this.accountNotice || this.noticed.has('account')) return;
    this.noticed.add('account');
    let text = null;
    try { text = this.accountNotice({ provider: this.provider }, this.accountId); }
    catch (err) { this.log('warn', 'observer failed', { error: errText(err) }); }
    if (typeof text === 'string' && text && !this.noticed.has('api-key-billing')) this.event({ kind: 'notice', code: 'account', text });
  }

  onTurnCompleted(p, msg) {
    const id = typeof p.turn?.id === 'string' ? p.turn.id : null;
    const active = this.active;
    if (active?.id && id && active.id !== id) {
      // Not the turn being tracked: say what it says and leave the running one alone.
      this.rememberClosed(id);
      this.feed(msg);
      return;
    }
    this.adoptThread(); // a turn that ended without ever saying it started is still a turn on disk
    this.closeTurn(msg);
    if (this.closed) return;
    if (this.proc) this.fire(this.loadLimits(this.proc));
    // `turn-end` has gone out; only now may the chat say it is free (the host sends its queue on that).
    if (this.outbox.pending().length) { this.setBusy(true, 'starting'); this.fire(this.deliver()); }
    else this.settle();
  }

  // The turn is over, by Codex's own word or by one made up here (crash, forced stop): its rows are closed through
  // the adapter, its sends leave the outbox and no card is left waiting.
  closeTurn(msg, { synthetic = false, mark = 'completed' } = {}) {
    const active = this.active;
    const ids = active ? active.ids.slice() : [];
    const stopped = !!active?.userStopped;
    this.feed(msg, (ev) => {
      if (ev.kind === 'turn-end') {
        ev.sessionId = this.sessionId;
        ev.userUuids = ids;
        ev.userUuid = ids[0] ?? null;
        if (synthetic) ev.synthetic = true;
        if (ev.durationMs == null && active) ev.durationMs = Date.now() - active.at;
        // The user ended this turn (Stop, or a "no" that Codex only offers as "stop"): it is not a failure.
        if (stopped && ev.isError) Object.assign(ev, { subtype: 'interrupted', interrupted: true, isError: false, errors: [], errorCode: null });
        if (this.planWaits(ev)) ev.plan = true; // the plan card follows at once: it, not this, is what the user is told about
      } else if (stopped && ev.kind === 'notice' && ev.code === 'api-error') return false;
      return true;
    });
    this.clearTimer('stop'); this.clearTimer('command');
    const turnId = msg?.params?.turn?.id ?? active?.id;
    if (typeof turnId === 'string') this.rememberClosed(turnId);
    this.linkSends(active, turnId); // before its sends leave the outbox: this turn is what an edit of them cuts back to
    this.active = null;
    this.deferred.clear();
    for (const id of ids) {
      const e = this.outbox.get(id);
      if (!e || (mark === 'lost' && e.state !== 'started')) continue; // a send Codex never took is redelivered, not lost
      this.outbox.mark(id, mark);
    }
    this.resolvePending({ answer: !synthetic });
    this.offerPlan(typeof turnId === 'string' ? turnId : null);
  }

  rememberClosed(id) {
    this.closedTurns.add(id);
    if (this.closedTurns.size > CLOSED_TURNS_MAX) this.closedTurns.delete(this.closedTurns.values().next().value);
  }

  // The line Codex would have sent for a turn that will never get one.
  madeUpEnd(active, status, message) {
    return { method: 'turn/completed', params: { threadId: active.threadId ?? this.threadId, turn: { id: active.id, status, error: message ? { message } : null, items: [] } } };
  }

  // ---- stopping ----

  async sendInterrupt(proc, active) {
    if (active.interruptSent || !active.id || this.active !== active) return;
    active.interruptSent = true;
    try { await proc.request('turn/interrupt', { threadId: active.threadId ?? this.threadId, turnId: active.id }, { timeoutMs: this.t.interrupt }); }
    catch (err) {
      if (this.active !== active || this.proc !== proc || err?.code === 'closed') return;
      if (err?.code === 'timeout') { await this.forceStop(NOT_RESPONDING); return; }
      // Codex said no (the turn may have just ended on its own). The stop watch decides what happens next.
      this.log('warn', 'turn/interrupt was refused', { error: this.redact(errText(err)) });
    }
  }

  // Stop did not work (or was pressed twice): end the process. The next send starts a clean one on the same thread.
  async forceStop(text) {
    const active = this.active;
    const proc = this.detach();
    this.clearTimer('stop');
    try {
      this.resolvePending({ answer: false });
      if (active) this.closeTurn(this.madeUpEnd(active, 'interrupted', null), { synthetic: true });
      this.failUnanswered();
      // An earlier Stop already cancelled what was waiting then. What was typed since is new, and still wanted.
      if (!active?.stopAsked) this.cancelUnstarted();
      const cancelled = this.announceCancelled();
      this.event({ kind: 'notice', code: 'force-stop', text });
      this.lifecycle = 'stopped';
      const waiting = !this.closed && !this.hostStopped && this.outbox.pending().length > 0;
      if (waiting) this.setBusy(true, 'starting'); else this.setBusy(false);
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'force-stop', willRestart: !this.closed && !this.hostStopped });
      const gone = proc ? this.reap(proc, 0) : null;
      if (waiting) this.fire(this.deliver()); // a new process, once the old one is gone, on the same thread
      await gone;
      return { ok: true, forced: true, cancelled, stillQueued: [] };
    } catch (err) {
      this.log('error', 'force stop failed', { error: errText(err) });
      proc?.kill('SIGKILL');
      return { ok: true, forced: true, cancelled: [], stillQueued: [] };
    }
  }

  async doStop(graceMs) {
    const proc = this.proc;
    if (!proc) {
      this.lifecycle = this.lifecycle === 'new' ? 'new' : 'stopped';
      this.cancelUnstarted(); this.announceCancelled();
      if (this.busy) this.setBusy(false);
      return { ok: true, exited: true };
    }
    const active = this.active;
    if (active?.id && proc.alive && this.loaded) {
      active.userStopped = true;
      this.resolvePending({ answer: true });
      try {
        await proc.request('turn/interrupt', { threadId: active.threadId ?? this.threadId, turnId: active.id }, { timeoutMs: this.t.stopInterrupt });
        for (let waited = 0; this.active === active && waited < this.t.turnEndGrace; waited += 20) await sleep(20); // let the real turn-end arrive
      } catch { /* ended below either way */ }
    }
    if (this.proc === proc) this.detach();
    this.resolvePending({ answer: false });
    if (this.active) this.closeTurn(this.madeUpEnd(this.active, 'interrupted', null), { synthetic: true });
    this.failUnanswered();
    this.cancelUnstarted(); this.announceCancelled();
    this.lifecycle = 'stopped';
    this.setBusy(false);
    this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'stop', willRestart: false });
    const exited = await this.reap(proc, graceMs);
    return { ok: true, exited };
  }

  // Shared by close() and dispose(): nothing more is said, nobody is left waiting, and the process is handed back to be ended.
  shut() {
    this.flushDelta();
    this.closed = true;
    this.lifecycle = 'closed';
    this.clearAllTimers();
    this.removeAllListeners();
    for (const p of this.pending.values()) if (p.proc?.alive) p.proc.respond(p.req.rpcId, p.req.fallback);
    this.pending.clear();
    this.outbox.closeAll('cancelled');
    this.notes.clear();
    this.deferred.clear();
    const active = this.active;
    const turn = active?.id ? { threadId: active.threadId ?? this.threadId, turnId: active.id } : null;
    this.active = null;
    this.busy = false; this.state = 'idle';
    return { proc: this.detach(), turn };
  }

  // Ask a closing chat's running turn to stop, so Codex saves it as stopped rather than cut off. Bounded.
  async sayStop(proc, turn, ms) {
    if (!turn || !proc?.alive) return;
    try { await proc.request('turn/interrupt', turn, { timeoutMs: ms }); } catch { /* it is ended next either way */ }
  }

  // Let go of the process: whoever calls this owns ending it and tidying up after it.
  detach() {
    const proc = this.proc;
    this.proc = null;
    this.loaded = false;
    this.collab = null;
    this.sent = { model: false, effort: false, tier: false };
    this.mcpRows.clear();
    this.restartWhenIdle = null; // whatever it was to be restarted for, the next start is a new launch
    // The chat's agents ran on this process: they went with it.
    this.agentSubs.clear(); this.agentStops.clear();
    this.clearTimer('agents');
    if (this.agents.endAll()) this.emitTasks();
    // A chat that never had a turn is not on disk: its thread dies with the process, and the next start makes a new one.
    if (!this.sessionId) { this.threadId = null; this.startResult = null; this.initPending = false; }
    return proc;
  }

  // End a process for good. Resolves once it is gone; a new start waits for every one of these.
  reap(proc, graceMs = 3000, before) {
    if (!proc) return Promise.resolve(true);
    const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 3000;
    const p = Promise.resolve().then(() => before?.()).then(() => proc.shutdown(grace))
      .catch(() => { proc.kill('SIGKILL'); return proc.exited.then(() => true); }) // whatever went wrong, the process does not outlive its chat
      .finally(() => this.reaps.delete(p));
    this.reaps.add(p);
    return p;
  }

  // ---- the process ended on its own ----

  onExit(proc) {
    // A process someone let go of, or one still starting: whoever did that owns the clean-up.
    if (this.proc !== proc || this.opening) return;
    const exit = proc.exit ?? {};
    const active = this.active;
    this.detach();
    if (this.closed) return;
    this.clearTimer('stop');
    const how = exit.signal ? `signal ${exit.signal}` : exit.code != null ? `exit code ${exit.code}` : null;
    const message = `Codex stopped unexpectedly${how ? ` (${how})` : ''}.`;
    const stderr = this.shownStderr(proc);
    const turnLost = !!active && (active.started || active.ids.some((id) => this.outbox.get(id)?.state === 'started'));
    this.log(active || this.outbox.size ? 'warn' : 'info', 'codex process ended', { exitCode: exit.code ?? null, signal: exit.signal ?? null, turnLost, stderr: stderr.slice(-400) });
    if (Date.now() - proc.startedAt > STABLE_RUN_MS) this.budget.reset();
    this.resolvePending({ answer: false });
    // A turn that was running is reported as lost, never run again: its rows are closed and its sends marked lost.
    if (turnLost) this.closeTurn(this.madeUpEnd(active, 'failed', message), { synthetic: true, mark: 'lost' });
    else { this.active = null; this.deferred.clear(); }
    // Sends Codex never started go back to waiting. One that has now been tried twice is handed back instead.
    const exhausted = this.outbox.requeue(MAX_SEND_ATTEMPTS);
    const deliverable = this.outbox.pending().filter((e) => !exhausted.includes(e));
    const wanted = !this.hostStopped && deliverable.length > 0;
    const allowed = wanted && this.budget.allow();
    if (wanted && !allowed) { this.failSends(exhausted); this.crashLoop(stderr); return; }
    if (allowed && !turnLost) this.event({ kind: 'notice', code: 'restarting', text: 'Codex stopped unexpectedly and was restarted.' });
    this.failSends(exhausted);
    this.lifecycle = 'stopped';
    this.event({ kind: 'stopped', sessionId: this.sessionId, reason: turnLost ? 'crash' : 'exit', willRestart: !!allowed, exitCode: exit.code ?? null, signal: exit.signal ?? null });
    if (allowed) { this.setBusy(true, 'starting'); this.restartSoon(); }
    else this.setBusy(false);
  }

  crashLoop(stderr) {
    const prompts = briefly(this.outbox.closeAll('failed'));
    this.deferred.clear();
    this.lifecycle = 'failed';
    const changed = this.dropBusy();
    this.event({ kind: 'error', code: 'crashed', recoverable: true, message: 'Codex keeps stopping. Send a message to try again.', stderr, prompts });
    this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'failed', willRestart: false });
    this.announceIdle(changed);
  }

  // ---- timers ----

  setTimer(name, ms, fn) {
    this.clearTimer(name);
    const t = setTimeout(() => {
      if (this.timers[name] === t) this.timers[name] = null;
      try { fn(); } catch (err) { this.log('error', `timer ${name} failed`, { error: errText(err) }); }
    }, ms);
    t.unref?.();
    this.timers[name] = t;
  }

  clearTimer(name) {
    const t = this.timers[name];
    if (!t) return;
    if (name === 'delta') clearImmediate(t); else clearTimeout(t);
    this.timers[name] = null;
  }

  clearAllTimers() { for (const name of Object.keys(this.timers)) this.clearTimer(name); }
}

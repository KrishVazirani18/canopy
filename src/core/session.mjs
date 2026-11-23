// Session: one Claude Code conversation, driven through the Agent SDK.
//
// Contract with the host (main process) and the UI:
//  - Every public method is safe to call at any time and never throws. Results
//    are { ok: true, ... } or { ok: false, code, message }.
//  - Everything that happens is reported as an event (see adapter.mjs for the
//    transcript events). Events carry a monotonically increasing `seq`.
//  - Busy follows Claude Code's own session state, not a guess from results.
//  - Every send is tracked in an outbox until Claude Code reports it finished.
//    If the process dies, unstarted sends are redelivered after a restart and
//    a turn that was running is reported as lost, never silently re-run.
//  - The process is owned here: stop/dispose resolve only once it is gone.
//  - A chat moved here from the other maker (`handoff`) carries the old chat's digest once: as a hidden first block
//    of the first message that starts the conversation, and again only when that first message is edited.
//  - What the user did in the app that the model did not see (files put back, a message edited so that the replies
//    after it are gone, anything the host hands note()) is told once, as a hidden first block of the next message
//    (notes.mjs). The system prompt and the tools are never changed for it.
import { EventEmitter } from 'node:events';
import { canopyMemoryNote, codexMemoryNote, personalMemoryNote } from './memory.mjs';
import { toolIcons } from './tool-icons.mjs';
import { CANOPY_FACTS } from './facts.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { query, forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import * as adapterMod from './adapter.mjs';
import * as fileApprovals from './file-approvals.mjs';
import { forClaude } from './handoff.mjs';
import { NoteQueue, escapeNoteTag, noteForClaude } from './notes.mjs';
import { TIMEOUTS, STABLE_RUN_MS, withTimeout, sleep, backoffMs, RestartBudget, classify, InputQueue, Outbox } from './supervisor.mjs';
import { checkMessage, isPlain, isUuid } from './send-rules.mjs';
import * as elicitation from './elicitation.mjs';

// Helpers owned by other files load softly: one that fails to load takes its own feature with it, never the app's start.
const soft = async (f) => { try { return await import(f); } catch (err) { return { __missing: String(err?.message ?? err) }; } };
const [envMod, trustMod, redactMod, channelMod, codeMod, widgetsMod, transcriptMod, readChatMod] = await Promise.all([
  soft('./env.mjs'), soft('./trust.mjs'), soft('./redact.mjs'), soft('./control-channel.mjs'), soft('./code-mode.mjs'), soft('./widgets.mjs'),
  soft('./transcript.mjs'), soft('./read-chat.mjs'),
]);
const [lookMod, pluginMod, memoryMod, taskMod] = await Promise.all([soft('./look.mjs'), soft('./plugin.mjs'), soft('./memory-tools.mjs'), soft('./task-tool.mjs')]);

export const CORE_DEGRADED = [!trustMod.folderTrustSync && 'trust', !redactMod.makeRedactor && 'redact', !envMod.scrubEnv && 'env'].filter(Boolean);
// The engine contract's version: tests check it before running against a scratch copy of core (CANOPY_TEST_CORE).
export const CORE_API = 2;
export const EXTENDED_KINDS = new Set(['tasks', 'tool-pending', 'tool-input-delta', 'send-state']);

// Which `extended` feature unlocks each gated event kind.
const KIND_GATE = { tasks: 'tasks', 'tool-pending': 'tool-stream', 'tool-input-delta': 'tool-stream', 'send-state': 'send-state' };
const EXTENDED_FEATURES = ['tasks', 'tool-stream', 'send-state', 'hooks', 'info', 'elicitation', 'task-stop'];

const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const SAFE_START_MODES = new Set(['default', 'plan', 'dontAsk']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const THINKING = new Set(['summarized', 'omitted', 'off']);
// How much of what the user wrote to a chat is kept for remember's check (see `heard`): messages, and characters of one.
const HEARD_MAX = 200;
const HEARD_CHARS = 20_000;
const LIVE_KEYS = new Set(['model', 'permissionMode', 'effort', 'fast', 'ultracode', 'codeMode', 'outputStyle', 'agent']);
const START_KEYS = new Set(['thinking', 'suggestions', 'fallbackModel', 'maxBudgetUsd', 'maxTurns', 'additionalDirectories']);
// How many files of one change travel in its approval card. The rest are counted, not shown.
const CARD_FILES = 40;
const TURN_LOG_MAX = 2000;
const TASKS_MAX = 200;
const MAX_SEND_ATTEMPTS = 2;
const REPLAY_KINDS = new Set(['message-start', 'text-delta', 'thinking-delta', 'assistant-text', 'thinking', 'tool-start', 'tool-result',
  'tool-progress', 'tool-pending', 'tool-input-partial', 'code-call', 'command-output', 'context-note', 'notice', 'task', 'hook', 'status']);
const DELTA_KINDS = new Set(['text-delta', 'thinking-delta']);
const ABORTED = new Set(['aborted_streaming', 'aborted_tools']);
const API_ERROR_CODES = { authentication_failed: 'auth', billing_error: 'billing', rate_limit: 'rate-limit' };
// CLI flags Canopy can live without: an older Claude Code that rejects one is restarted without it.
const OPTIONAL_FLAGS = new Set(['thinking-display', 'include-hook-events']);
// How Claude Code's refusal of a cut begins (the SDK's resumeDropsTurn): what the cut would drop is more than it was told.
const CUT_REFUSED = 'Resume rejected by --resume-drops-turn:';
const CUT_WAIT_MS = 5 * 60000; // an edit's answer is never waited on longer than this
const CHANGED_WAIT_MS = 2500;  // how long an edit waits to hear which files the replies it cuts had changed
const CTX_FRESH_MS = 1500;     // a context reading this new is handed out again instead of asked for
const LIMITS_FRESH_MS = 60_000; // the plan's limits are asked of Claude Code at most this often
const LIMITS_WAIT_MS = 2000;   // and never waited on for longer than this: the last reading stands in
// Host agent variables that must never leak into the child when env.mjs has no scrubEnv yet.
const HOST_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|EXECPATH|SSE_PORT|MESSAGING_.*)|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/;
const DESTINATIONS = {
  session: 'for this session', localSettings: 'for you in this project', projectSettings: 'for everyone in this project',
  userSettings: 'in all your projects', cliArg: 'for this session',
};
const MODE_LABELS = { default: 'ask before edits', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto', dontAsk: "don't ask", bypassPermissions: 'bypass permissions' };
const BYPASS_NOTICE = 'Bypass permissions is not enabled for this session. Turn it on in your Claude Code settings first (the same as the terminal requires).';

const errText = (err) => String(err?.message ?? err);
const clone = (v) => { try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); } };
// The answer to Claude Code's permission question that lets a call go ahead as it was written.
const allowed = (input, ctx) => Promise.resolve({ behavior: 'allow', updatedInput: input ?? {}, ...(ctx.toolUseID && { toolUseID: ctx.toolUseID }) });
const coded = (code, message, extra) => Object.assign(new Error(message), { canopy: { code, message, ...extra } });

let requestSeq = 0;            // permission ids are unique across sessions
let apiKeyNoticeShown = false; // once per app process

function dirExists(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

function buildMsg(id, text, images, opts) {
  text = escapeNoteTag(text); // nothing the user typed or pasted can pass for a note of Canopy's (notes.mjs)
  const blocks = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } }));
  if (blocks.length && text.trim()) blocks.push({ type: 'text', text });
  const msg = {
    type: 'user', uuid: id, session_id: '', origin: { kind: 'human' },
    message: { role: 'user', content: blocks.length ? blocks : text }, parent_tool_use_id: null,
    ...(opts.priority && { priority: opts.priority }),
  };
  return withLead(msg, opts.lead, opts.note);
}

// A lead: a block for the model only, put first in the message, before the images and before the user's words. (A
// moved chat's digest, then what the user did in the app since the last message. Saved with the message, and hidden
// from its bubble by the history reader, adapter.mjs.) Leads that are not there are skipped.
function withLead(msg, ...leads) {
  const first = leads.filter((l) => typeof l === 'string' && l).map((text) => ({ type: 'text', text }));
  if (!first.length) return msg;
  const c = msg.message.content;
  msg.message.content = [...first, ...(Array.isArray(c) ? c : c.trim() ? [{ type: 'text', text: c }] : [])];
  return msg;
}

// A message Claude Code runs as a command (`/compact`): it has to arrive as it was typed, so it carries no note.
const isCommand = (text) => typeof text === 'string' && text.trimStart().startsWith('/');
// The files a rewind names (a dry run does; a real one does not): [] for none, null when it could not say.
const filesOf = (r) => (r?.canRewind && Array.isArray(r.filesChanged) ? r.filesChanged.filter((f) => typeof f === 'string' && f) : null);

// What a saved or waiting message carries besides its words: sent again as it is when the message is edited.
const attachmentsOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'image' || b?.type === 'document') : []);

const toBg = (t) => ({
  taskId: t.task_id, runId: t.run_id ?? null, taskType: t.task_type ?? null, agentType: t.subagent_type ?? null,
  description: t.description ?? '', parentTaskId: t.parent_task_id ?? null,
});

function describeGrant(u) {
  const where = DESTINATIONS[u.destination] ?? 'for this session';
  const rules = (u.rules ?? []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
  switch (u.type) {
    case 'setMode': return `switched to ${MODE_LABELS[u.mode] ?? u.mode} mode ${where}`;
    case 'addRules': return `${u.behavior === 'deny' ? 'always deny' : u.behavior === 'ask' ? 'always ask for' : 'always allow'} ${rules || 'this tool'} ${where}`;
    case 'replaceRules': return `replaced the ${u.behavior} rules with ${rules || 'none'} ${where}`;
    case 'removeRules': return `removed the ${u.behavior} rule ${rules} ${where}`;
    case 'addDirectories': return `allowed access to ${(u.directories ?? []).join(', ')} ${where}`;
    case 'removeDirectories': return `removed access to ${(u.directories ?? []).join(', ')} ${where}`;
    default: return `updated permissions ${where}`;
  }
}

// One limit update, with everything Claude Code sent kept. Times are in ms (some builds send seconds) and
// `utilization` is a percentage: the update gives a 0-1 fraction where usage() gives 0-100, and nothing downstream
// should have to know which it got.
function rateLimitOf(info) {
  const i = isPlain(info) ? info : {};
  const ms = (v) => (typeof v === 'number' && v > 0 ? (v < 1e12 ? v * 1000 : v) : null);
  return {
    ...i, status: i.status ?? null, type: i.rateLimitType ?? null,
    resetsAt: ms(i.resetsAt), overageResetsAt: ms(i.overageResetsAt), utilization: adapterMod.limitPercent?.(i.utilization) ?? null,
  };
}

function mcpRow(m) {
  const cfg = m.config ?? {};
  const withIcons = (value) => { const icons = toolIcons(value); return icons.length ? { icons } : {}; };
  return {
    name: m.name, status: m.status, error: m.error ?? null, scope: m.scope ?? null, source: m.source ?? null,
    server: m.serverInfo ? { name: m.serverInfo.name, version: m.serverInfo.version, ...withIcons(m.serverInfo) } : null,
    ...withIcons(m),
    // config.env and headers can hold secrets and are never forwarded.
    url: typeof cfg.url === 'string' ? cfg.url.replace(/\/\/[^/@]*@/, '//') : null,
    transport: cfg.type ?? (cfg.command ? 'stdio' : null),
    tools: (m.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', readOnly: !!t.annotations?.readOnly, destructive: !!t.annotations?.destructive, ...withIcons(t) })),
  };
}

// The plan's usage limits ride on contextUsage() (limits.mjs: one shape for both makers).
const limitsMod = await soft('./limits.mjs');

function contextShape(u, detail) {
  const out = {
    totalTokens: u.totalTokens, maxTokens: u.maxTokens, percentage: u.percentage, rawMaxTokens: u.rawMaxTokens ?? u.maxTokens,
    model: u.model ?? null, autoCompact: !!u.isAutoCompactEnabled, autoCompactThreshold: u.autoCompactThreshold ?? null,
    categories: u.categories ?? [],
  };
  if (detail === 'full') Object.assign(out, { memoryFiles: u.memoryFiles ?? [], mcpTools: u.mcpTools ?? [], agents: u.agents ?? [], skills: u.skills ?? null, messages: u.messageBreakdown ?? null });
  return out;
}

export class Session extends EventEmitter {
  constructor({
    cwd, claudePath, env, resume = null,
    model, permissionMode, effort, fast, ultracode, codeMode,
    thinking, suggestions = true, fallbackModel, maxBudgetUsd, maxTurns, additionalDirectories, title, handoff,
    allowBypass = false, personalMemory = true, trusted, trustedFolders, extended = false, debug = false, checkpoints = true, autoRestart = true, appVersion = '0.0.1',
    trustEnv,
    settingSources, strictMcpConfig, queryFn = query, log, onDrift, widgetReport, freeBackground, readTranscript, startedWith, otherChats,
    look, shots, canopyPlugin, canopyKit, memory, memoryBridge = false,
    account = null, onAccount, onRateLimit, accountNotice,
  } = {}) {
    super();
    this.cwd = cwd;
    this.personalMemory = personalMemory;
    // Canopy Memory (memory-store.mjs): the notes this chat is shown when it starts, and saves to with its remember
    // tool. A host that keeps none (or whose user turned memory off) gives nothing, and the chat has neither the
    // notes nor the tools. Like Code Mode it is decided for the life of the chat: the host hands a reopened chat
    // what `startedWith.memory` says it began with, whatever the switch says by then (chat-tools.mjs).
    // `memoryBridge: true` adds what Codex has learned about the user (memory.mjs): that is one maker's notes sent
    // to the other maker's model, so it is only ever on because the user turned it on.
    this.memoryStore = memory && typeof memory.save === 'function' ? memory : null;
    this.memoryBridge = memoryBridge === true;
    // The user's own words to this chat, as far as this object saw them: what remember checks a note filed as
    // "the user said" against (memory-tools.mjs saidByUser). The newest HEARD_MAX, each cut at HEARD_CHARS.
    this.heard = [];
    this.claudePath = claudePath;
    this.env = env; // object, or a getter resolved at each start (a getter that fails stops the start: see resolveEnv)
    // The host's name for the login this chat was started on (null: whatever Claude Code finds on its own). It never
    // changes once the chat has a conversation (see moveAccount), and is handed back with what Claude Code reports
    // so the host can compare.
    this.accountId = typeof account === 'string' && account ? account : null;
    // (reported, accountId): the account Claude Code says each new process is on.
    this.onAccount = typeof onAccount === 'function' ? onAccount : null;
    // (reported, accountId) => string | null: a host that names accounts says here what this chat tells you about
    // its own, once, when its first turn starts ("This chat uses Max."), or null for nothing. See apiKeyNotice.
    this.accountNotice = typeof accountNotice === 'function' ? accountNotice : null;
    // (limit, accountId): every limit update Claude Code sends, in full (see rateLimitOf).
    this.onRateLimit = typeof onRateLimit === 'function' ? onRateLimit : null;
    this.sessionId = isUuid(resume) ? resume : null;
    // A chat reopened has said things before this object: what the user wrote is read back from its transcript, so
    // remember's check (memory-tools.mjs saidByUser) knows the whole conversation and not only what comes after.
    // Until that is read back, the check has only part of the conversation, so it is not made (see `said`).
    this.heardAll = !this.sessionId;
    if (this.sessionId) queueMicrotask(() => { void this.hearPast(); });
    this.allowBypass = allowBypass === true;
    // Unset values mean "whatever the user's Claude Code settings say", same as the terminal.
    this.settings = {
      model, effort, fast, ultracode, codeMode, thinking, suggestions, fallbackModel, maxBudgetUsd, maxTurns, additionalDirectories,
      permissionMode: this.modeAllowed(permissionMode) ? permissionMode : undefined,
    };
    // A chat's tools are decided when it starts and never change after that: a tool that comes or goes later changes
    // the start of every request, and Claude re-reads the whole conversation at full price. So Code Mode is a choice
    // for new chats. A new chat is fixed by its first message (post()); one that is being reopened is fixed from the
    // start when the host remembers what it started with (`startedWith: { codeMode }`).
    this.toolsFixed = false;
    if (this.sessionId && typeof startedWith?.codeMode === 'boolean') { this.settings.codeMode = startedWith.codeMode; this.toolsFixed = true; }
    this.title = typeof title === 'string' ? title : undefined;
    // A chat moved here from the other maker: the old chat's digest (handoff.mjs), and `by`, the send that carries
    // it. A chat that already exists has had its digest, so a resumed one never carries, unless it is being gone back
    // to (`back`): then the digest is what happened while it was away (see handBack()).
    this.handoff = (!this.sessionId || handoff?.back === true) && isPlain(handoff) && typeof handoff.text === 'string' && handoff.text ? { text: handoff.text, by: null, back: handoff.back === true } : null;
    this.trusted = trusted === true ? true : trusted === false ? false : undefined;
    // Folders the host app counts as trusted (Canopy: the folders you opened as projects), as a list or a getter read
    // at each start. A chat in one of them, below it or in a worktree of it is trusted, as trust.mjs decides for 'host'.
    this.trustedFolders = typeof trustedFolders === 'function' ? trustedFolders : () => trustedFolders ?? [];
    // A getter for the user's own environment, for a chat launched with a Claude Code folder that is not theirs (a
    // sign-in Canopy keeps in a folder of its own): a folder they trusted in their own Claude Code is trusted there too.
    this.trustEnv = typeof trustEnv === 'function' ? trustEnv : null;
    this.ext = new Set(extended === true ? EXTENDED_FEATURES : Array.isArray(extended) ? extended : []);
    this.debug = !!debug;
    this.checkpoints = checkpoints !== false;
    this.autoRestart = autoRestart !== false;
    this.appVersion = String(appVersion);
    this.settingSources = Array.isArray(settingSources) ? settingSources : undefined;
    this.strictMcpConfig = typeof strictMcpConfig === 'boolean' ? strictMcpConfig : undefined;
    this.queryFn = queryFn;
    this.logFn = typeof log === 'function' ? log : null;
    // Told about every frame Claude Code sends that the adapter does not know (label, top-level keys): see adapter.mjs.
    this.onDrift = typeof onDrift === 'function' ? onDrift : null;
    // The host clears a finished Claude Code background session that still holds this chat (session-busy), so it opens.
    this.freeBackground = typeof freeBackground === 'function' ? freeBackground : null;
    // (toolUseId) => Promise<{ errors: string[] } | null>: what the window says about drawing a widget, if a window is watching.
    this.widgetReport = typeof widgetReport === 'function' ? widgetReport : null;
    // Where the look tool's screenshots come from (look.mjs describes it). Only a host with a screen has one.
    this.lookBackend = look && typeof look === 'object' ? look : null;
    // Where its pictures are kept for the chat, so a widget can show them again (shots.mjs). Known by the chat's id.
    this.shots = typeof shots?.forChat === 'function' ? shots.forChat(() => this.sessionId) : null;
    // Canopy's own plugin (plugin.mjs): the skills every chat is given. Found once, so every process of this chat is
    // handed the same folder. `canopyPlugin: false` leaves it out; a path names another folder (the tests' seam).
    this.plugin = canopyPlugin === false ? null : pluginMod.canopyPlugin?.(typeof canopyPlugin === 'string' ? canopyPlugin : undefined) ?? null;
    // Canopy Kit (plugin.mjs): on only when the host says so (`canopyKit: true`, or a path, the tests' seam), read once
    // when the chat is made, so the chat keeps what it started with.
    this.kit = canopyKit ? pluginMod.canopyPlugin?.(typeof canopyKit === 'string' ? canopyKit : pluginMod.kitDir?.()) ?? null : null;
    // { list, load }: where read_chat finds the user's other chats (read-chat.mjs chatSources). The host's own knows
    // which chats are live and what they are doing; without one, Claude Code's saved chats for this folder are read.
    this.otherChats = isPlain(otherChats) ? otherChats : null;
    // (sessionId) => Promise<rows | null>: the saved conversation's rows, for edit() (the test seam; see transcript.mjs).
    this.readTranscript = typeof readTranscript === 'function' ? readTranscript : (id) => transcriptMod.transcriptRows?.(id, this.cwd, this.lastEnv ?? this.resolveEnv()) ?? null;

    this.mode = null;            // permission mode Claude Code reports (or the one chosen while stopped)
    this.modeExplicit = false;   // the user picked the mode through set() or a plan approval in this Session
    this.model = null;
    this.q = null;               // truthy while a process exists
    this.input = null;
    this.run = null;             // per-process state
    this.gen = 0;
    this.seq = 0;
    this.busy = false;
    this.shownBusy = false;      // what the last busy event said (see reportedBusy)
    this.state = 'idle';         // starting | running | requires_action | idle
    this.cliState = null;
    this.lifecycle = 'new';      // new | starting | ready | stopped | parked | failed | closed
    this.closed = false;
    this.parked = false;
    this.hostStopped = false;
    this.restricted = false;
    this.risky = null;
    this.restarts = 0;
    this.lastError = null;
    this.lastMeta = null;
    this.caps = new Set();
    this.codeAllowed = new Set(); // MCP tools the user said a Code Mode script may always call, for as long as this chat is open

    this.pending = new Map();
    // One question for a change to several files (file-approvals.mjs): what the model's message holds, and the later
    // asks of that message the user has already answered in one card, by tool call id. Both end with the turn.
    this.steps = new fileApprovals.StepTracker();
    this.covered = new Map();
    // What the user did in the app that the model has not been told yet (notes.mjs): it goes with the next message.
    this.notes = new NoteQueue({ cwd });
    this.outbox = new Outbox({ onChange: (e, state) => { this.event({ kind: 'send-state', id: e.id, state }); this.cutWatch(e.id, state); this.leadWatch(e.id, state); this.notes.settle(e.id, state); } });
    this.budget = new RestartBudget({ max: 3, windowMs: 60000 });
    this.turn = [];
    this.tasks = new Map();
    this.bg = [];
    this.timers = {};
    this.holds = 0;
    this.holdWaiters = [];
    this.idleWaiters = [];
    this.setChain = Promise.resolve();
    this.droppedFlags = new Set();
    this.cancelBatch = [];
    this.ctxCache = null;
    this.ctxInflight = {};
    this.delta = null;
    this.turnOpen = false;
    this.turnSendAt = null;
    this.firstDeltaAt = null;
    this.contextTokens = null;
    this.rateLimit = null;
    this.lastApiError = null;
    this.suggestionShown = false;
    this.lastCommandsSig = null;
    this.lostSessionId = null;
    this.wantStart = false;
    this.noticed = new Set();    // once-per-Session notices
    this.cut = null;             // edit(): where the conversation is cut, until the edited message has started (see buildOptions)
    this.cutWait = null;         // resolves edit() once that message started, or the cut was refused
    this.editing = false;
    this.refusedCuts = new Set(); // messages whose checked cut Claude Code refused: the next try is not checked again
    this.superseded = null;      // edit() of the first message: the conversation the next one replaces
    this.memo = undefined;       // the personal memory note this chat started with (null: none); see promptAppend
    this.scheduled = [];         // prompts set to wake this chat later, as Claude Code last said (see onStop)
  }

  get pid() { return this.run?.proc?.pid ?? null; }
  // `background` is the method below (move a running tool to the background), so the count has its own name.
  get backgroundCount() { return this.bg.length; }
  // True while the session must not be closed or restarted behind the user's back.
  get working() { return this.busy || this.bg.length > 0 || this.pending.size > 0; }
  // How many prompts are set to wake this chat later. They only fire while its process is alive, so the manager does
  // not let such a chat go for sitting idle. Without a process there is nothing to keep.
  get scheduledCount() { return this.q ? this.scheduled.length : 0; }
  // The tools this chat started with, for the host to remember and hand back when the chat is reopened; null until
  // its first message has fixed them.
  get startedWith() { return this.toolsFixed ? { codeMode: this.settings.codeMode === true, memory: !!this.memoryStore } : null; }

  // ---- public API ----

  send(text, images = [], opts = {}) {
    images = images ?? []; opts = opts ?? {};
    const bad = this.checkSend(text, images, opts);
    if (bad) return this.fail(bad.code, bad.message);
    if (this.closed) return this.fail('closed', 'This session was closed.');
    if (this.parked) return this.fail('parked', 'This chat is open in the terminal view. Close the terminal to continue here.');
    const id = opts.id ?? randomUUID();
    if (this.outbox.has(id)) return this.fail('invalid-input', 'That message was already sent.');
    return this.post(id, buildMsg(id, text, images, { ...opts, lead: this.takeLead(id), note: this.takeNote(id, text) }), text, images.length);
  }

  // What the user wrote earlier in a reopened chat, read back once from its saved transcript and put before anything
  // heard since. Best effort: a chat with no saved file yet, or one that can't be read, just starts with nothing.
  async hearPast() {
    if (this.heardPast) return;
    this.heardPast = true;
    try {
      const rows = await this.readTranscript(this.sessionId);
      if (!Array.isArray(rows)) return;
      const past = [];
      for (const r of rows) {
        if (r?.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary || r.toolUseResult !== undefined) continue;
        const c = r.message?.content;
        if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) continue;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
        if (t.trim() && !t.trimStart().startsWith('<') && !t.trimStart().startsWith('[Request interrupted')) past.push(t.slice(0, HEARD_CHARS));
      }
      this.heard.unshift(...past);
      if (this.heard.length > HEARD_MAX) this.heard.splice(0, this.heard.length - HEARD_MAX);
      this.heardAll = true;
    } catch { /* nothing read back: the check stays off for this chat rather than judge from half of it */ }
  }

  // The user wrote this to the chat: a message, or what they typed or picked on a card.
  hear(...texts) {
    for (const t of texts) if (typeof t === 'string' && t.trim()) this.heard.push(t.slice(0, HEARD_CHARS));
    if (this.heard.length > HEARD_MAX) this.heard.splice(0, this.heard.length - HEARD_MAX);
  }

  // Something the user did in the app that the model did not see, as notes.mjs lists them ({ kind: 'undo', files },
  // { kind: 'text', text: 'The user …' }). It is told with the next message this chat sends, once, and forgotten if
  // the chat is closed first.
  note(note) {
    if (this.closed) return { ok: false, code: 'closed', message: 'This session was closed.' };
    return this.notes.add(note) ? { ok: true } : { ok: false, code: 'invalid-input', message: 'That note says nothing.' };
  }

  // The notes for the message `id` to carry, as the block Claude is handed. Null when there is nothing to tell, or
  // the message is a command.
  takeNote(id, text) {
    const block = isCommand(text) ? null : this.notes.take(id);
    if (!block) return null;
    this.log('info', 'the model is told what the user did', { id, lines: block.split('\n').length - 2 });
    return noteForClaude(block);
  }

  // The digest for the message `id` to carry, when this is a moved chat whose conversation has not started and no
  // other send carries it already. Null otherwise.
  takeLead(id, again = false) {
    const h = this.handoff;
    if (!h || (!again && (h.by || (this.sessionId && !h.back)))) return null;
    h.by = id;
    return forClaude(h.text);
  }

  /** The chat was gone back to from the other maker: `text` (a digest, handoff.mjs) goes with its next message. */
  handBack(text) {
    if (this.closed || typeof text !== 'string' || !text) return false;
    this.handoff = { text, by: null, back: true };
    return true;
  }

  // The send that carried the digest ended without ever starting (stopped, failed): the next message carries it.
  leadWatch(id, state) {
    const h = this.handoff;
    if (!h || h.by !== id) return;
    if (state === 'started') h.started = true;
    else if (!h.started && (state === 'cancelled' || state === 'failed' || state === 'lost')) h.by = null;
  }

  // Put a built message in the outbox and hand it to Claude Code (send() and edit() both end here).
  post(id, msg, text, images) {
    this.toolsFixed = true; // the conversation has begun: it keeps the tools it has now
    this.hear(text);
    this.hostStopped = false;
    this.budget.reset();
    this.outbox.add(id, msg, text, images);
    this.clearSuggestion();
    this.setBusy(true, this.cliState && this.cliState !== 'idle' ? this.cliState : 'starting');
    const r = this.flush();
    return r?.ok === false ? r : { ok: true, id };
  }

  // Start Claude Code right away (like opening it in Terminal) so commands,
  // models and the real permission mode are known before the first message.
  async warm(opts) {
    const { delayMs = 0 } = opts ?? {};
    if (this.closed) return { ok: false, code: 'closed', message: 'This session was closed.' };
    if (this.parked) return { ok: false, code: 'parked', message: 'This chat is open in the terminal view.' };
    if (delayMs > 0 && !this.q) {
      this.setTimer('warm', delayMs, () => this.fire(this.warm()));
      return { ok: true, scheduled: true };
    }
    this.hostStopped = false;
    this.budget.reset();
    await this.settled();
    if (this.closed || this.parked) return { ok: false, code: this.closed ? 'closed' : 'parked', message: 'This session is not available.' };
    try { this.ensureStarted(); } catch (err) { return this.startFailed(err, { warm: true }); }
    const run = this.run;
    const meta = await this.ensureMeta(run);
    return meta ? { ok: true, startupMs: meta.startupMs ?? null } : { ok: false, code: 'not-ready', message: 'Claude Code did not finish starting.' };
  }

  async interrupt(opts) {
    const { hard = false, keepQueued = false } = opts ?? {};
    const q = this.q;
    if (!q) {
      // Nothing is running, but sends may be waiting for a restart: Stop cancels those too.
      this.clearTimer('restart');
      const cancelled = this.cancelUnstarted();
      this.announceCancelled();
      if (this.busy) this.setBusy(false, 'idle');
      return { ok: true, idle: true, cancelled, stillQueued: [] };
    }
    if (!this.busy && !this.pending.size) return { ok: true, idle: true, cancelled: [], stillQueued: [] };
    // The reply is done and only background work is keeping the chat busy: there is nothing for Stop to end, and it must
    // not touch the workflows, agents or commands (stop those one by one). A forced stop still goes through.
    if (!hard && this.onlyBackground()) return { ok: true, idle: true, background: true, cancelled: [], stillQueued: [] };
    // A second press escalates to restarting Claude Code, which would also kill this chat's workflows, agents and
    // background commands. Stop is for the reply, not the background work: with any of that running, never escalate.
    if (this.interrupting && this.backgroundWork()) return { ok: true, cancelled: [], stillQueued: [] };
    if (hard || this.interrupting) return this.forceStop('Stopped.'); // second press escalates
    this.interrupting = true; this.stopRequested = true;
    try {
      // Claude Code does not stop a script for us: its calls in flight would finish and it could start more.
      this.run?.code?.stopAll();
      const call = q.interrupt(keepQueued ? undefined : { cancelQueued: true });
      this.rejectAllPending('Interrupted by the user.', { interrupt: true });
      const r = await withTimeout(call, TIMEOUTS.interrupt, 'interrupt');
      for (const id of r?.cancelled ?? []) this.cancelEntry(id);
      const cancelled = this.announceCancelled();
      if (this.q === q && this.busy) {
        this.setTimer('stop', TIMEOUTS.stopWatch, () => {
          if (this.q !== q || !this.busy) return;
          // Background work still running: the reply is what Stop was for, so end it here instead of restarting
          // (a restart would kill the workflow too).
          if (this.backgroundWork()) { this.setBusy(false, 'idle'); return; }
          this.fire(this.forceStop('Claude Code did not respond to Stop, so it was restarted.', { responsive: false }));
        });
      }
      return { ok: true, cancelled, stillQueued: r?.still_queued ?? [] };
    } catch (err) {
      this.log('warn', 'interrupt failed', { error: errText(err) });
      if (this.q !== q) return { ok: true, cancelled: this.announceCancelled(), stillQueued: [] };
      return this.forceStop('Claude Code did not respond to Stop, so it was restarted.', { responsive: false });
    } finally { this.interrupting = false; }
  }

  set(key, value) {
    // Settings are applied one at a time, so a choice of tools can still be waiting its turn when the chat's first
    // message arrives (the window opens a chat, tells it your choices one by one, and you may already have sent).
    // It was made before the chat started, so it counts: it is marked here, where it was asked for, and messages
    // wait until it is in place. Otherwise the first request would go out with other tools than the chat keeps.
    const early = key === 'codeMode' && !this.toolsFixed;
    if (early) this.hold();
    const run = () => this.applySet(key, value, early).catch((err) => ({ ok: false, code: 'internal', message: errText(err) }));
    const p = this.setChain.then(run, run);
    this.setChain = p;
    if (early) this.fire(p.finally(() => this.release()));
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
    const p = this.pending.get(id);
    if (!p) {
      this.event({ kind: 'permission-resolved', id, stale: true });
      return { ok: false, code: 'stale', message: 'That request is no longer waiting for an answer.' };
    }
    const a = isPlain(answer) ? answer : {};
    try { this.decide(p, a); }
    catch (err) {
      this.log('error', 'respond failed', { error: errText(err) });
      p.done(p.fallback);
    }
    return { ok: true };
  }

  contextUsage(opts) {
    const detail = opts?.detail === 'full' ? 'full' : 'summary';
    const q = this.q;
    if (!q?.getContextUsage) return Promise.resolve(null);
    const c = this.ctxCache;
    if (detail === 'summary' && c && c.q === q && Date.now() - c.at < CTX_FRESH_MS) return Promise.resolve(c.value);
    const flying = this.ctxInflight[detail];
    if (flying?.q === q) return flying.p;
    const p = (async () => {
      try {
        const limits = this.planLimits(q); // asked alongside, so the ring never waits for it
        const u = await withTimeout(q.getContextUsage({ detail }), detail === 'full' ? TIMEOUTS.ctxFull : TIMEOUTS.ctx, 'contextUsage');
        const value = contextShape(u, detail);
        value.limits = await limits;
        if (detail === 'summary') this.ctxCache = { q, at: Date.now(), value };
        return value;
      } catch { return null; }
      finally { if (this.ctxInflight[detail]?.p === p) delete this.ctxInflight[detail]; }
    })();
    this.ctxInflight[detail] = { q, p };
    return p;
  }

  // The plan's usage limits, for the ring's hover and Stats: [{ id, name, usedPercent, resetsAt }]. Asked of Claude
  // Code at most once a minute, never waited on for more than 2 s, and [] when it cannot say (an API key has none).
  planLimits(q) {
    const kept = this.limitsCache?.q === q ? this.limitsCache : null;
    if (kept && Date.now() - kept.at < LIMITS_FRESH_MS) return Promise.resolve(kept.value);
    const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function' || typeof limitsMod.limitsFromClaude !== 'function') return Promise.resolve([]);
    const last = kept?.value ?? [];
    if (this.limitsInflight?.q !== q) {
      const p = (async () => {
        let value = last;
        try { value = limitsMod.cleanLimits(limitsMod.limitsFromClaude(await withTimeout(fn.call(q, { skipBehaviors: true }), TIMEOUTS.usage, 'usage'))); }
        catch { /* the last reading stands */ }
        this.limitsCache = { q, at: Date.now(), value };
        if (this.limitsInflight?.p === p) this.limitsInflight = null;
        return value;
      })();
      this.limitsInflight = { q, p };
    }
    return Promise.race([this.limitsInflight.p, sleep(LIMITS_WAIT_MS).then(() => last)]);
  }

  async mcpStatus() {
    const q = this.q;
    if (!q?.mcpServerStatus) return [];
    try { return (await withTimeout(q.mcpServerStatus(), TIMEOUTS.mcp, 'mcpStatus')).map(mcpRow); } catch { return []; }
  }

  // toggle: arg = enabled (boolean). reconnect: no arg. set: arg = 'default' | 'auto' | null, a
  // tighten-only permission override for that server. Server configs are never accepted from callers.
  async mcp(action, name, arg) {
    const q = this.q;
    if (!q) return { ok: false, code: 'no-session', message: 'Claude Code is not running.' };
    if (typeof name !== 'string' || !name) return { ok: false, code: 'invalid-input', message: 'An MCP server name is required.' };
    try {
      let extra = {};
      if (action === 'toggle') await withTimeout(q.toggleMcpServer(name, arg !== false), 20000, 'mcp toggle');
      else if (action === 'reconnect') await withTimeout(q.reconnectMcpServer(name), 20000, 'mcp reconnect');
      else if (action === 'set') {
        if (arg !== null && arg !== 'default' && arg !== 'auto') return { ok: false, code: 'invalid-input', message: 'The override must be default, auto or null.' };
        extra = (await withTimeout(q.setMcpPermissionModeOverride(name, arg), 20000, 'mcp set')) ?? {};
      } else return { ok: false, code: 'invalid-input', message: `Unknown MCP action: ${String(action)}` };
      return { ok: true, ...(extra.warning && { warning: extra.warning }), servers: await this.mcpStatus() };
    } catch (err) { return { ok: false, code: err?.code === 'timeout' ? 'timeout' : 'mcp', message: this.redact(errText(err)) }; }
  }

  async usage() {
    const r = await this.usageAnswer();
    return r.ok ? r.usage : null;
  }

  // usage(), saying why when there is no answer: { ok: true, usage } or { ok: false, code }. `code` is 'no-session'
  // (no process to ask), 'unsupported' (this Claude Code has no such call: it is experimental and may go), 'timeout'
  // or 'failed'. Asking sends no message and costs nothing.
  async usageAnswer() {
    const q = this.q;
    if (!q) return { ok: false, code: 'no-session' };
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') return { ok: false, code: 'unsupported' };
    try {
      const r = await withTimeout(fn.call(q, { skipBehaviors: true }), TIMEOUTS.usage, 'usage');
      return { ok: true, usage: { session: r.session ?? null, subscriptionType: r.subscription_type ?? null, rateLimitsAvailable: !!r.rate_limits_available, rateLimits: r.rate_limits ?? null } };
    } catch (err) { return { ok: false, code: err?.code === 'timeout' ? 'timeout' : 'failed' }; }
  }

  // Preview (dryRun) or restore the files Claude changed since the send with this id. Restoring leaves the
  // conversation as it is, so it still holds those changes: with its next message the model is told they were undone
  // (notes.mjs). `note: false` is for a caller that takes the changes out of the conversation too.
  async rewindFiles(id, opts) {
    const dryRun = opts?.dryRun === true;
    if (!isUuid(id)) return { canRewind: false, error: 'That message cannot be restored.' };
    if (!this.checkpoints) return { canRewind: false, error: 'File checkpoints are turned off for this chat.' };
    if (!dryRun && (this.busy || this.pending.size)) return { canRewind: false, error: 'Stop Claude before restoring files.' };
    if (this.closed || this.parked) return { canRewind: false, error: 'This chat is not running.' };
    if (dryRun || opts?.note === false) return this.rewindNow(id, dryRun);
    const files = filesOf(await this.rewindNow(id, true)); // a real rewind does not name the files it put back
    const r = await this.rewindNow(id, false);
    if (r.canRewind) this.notes.add({ kind: 'undo', files });
    return r;
  }

  async rewindNow(id, dryRun, ms = dryRun ? 8000 : 20000) {
    try {
      await this.settled();
      this.ensureStarted();
      const r = await withTimeout(this.q.rewindFiles(id, { dryRun }), ms, 'rewind');
      return r && typeof r === 'object' ? r : { canRewind: false, error: 'Claude Code did not answer.' };
    } catch (err) { return { canRewind: false, error: this.redact(err?.canopy?.message ?? errText(err)) }; }
  }

  // Continue from an earlier point as a new conversation: everything before the
  // message `beforeId` is kept (null keeps everything), and the conversation you
  // were in stays as it was. (Editing a message is edit(): same conversation, cut back.)
  async branch(opts) {
    const { beforeId = null, restoreFiles = false, title } = opts ?? {};
    const bad = (code, message) => ({ ok: false, code, message });
    if (this.closed) return bad('closed', 'This session was closed.');
    if (this.parked) return bad('parked', 'This chat is open in the terminal view.');
    const from = this.sessionId;
    if (!from) return bad('no-session', 'There is no saved conversation to branch from yet.');
    if (beforeId != null && !isUuid(beforeId)) return bad('invalid-input', 'That message cannot be branched from.');
    try {
      if (this.busy || this.pending.size) await this.interrupt();
      await this.waitIdle(5000);
      if (restoreFiles && beforeId) { // before forking: a fork gets new message ids
        const r = await this.rewindFiles(beforeId, { note: false }); // the fork holds none of those changes
        if (!r.canRewind) return bad('rewind', r.error ?? 'The files could not be restored.');
      }
      let upToMessageId;
      let fresh = false;
      if (beforeId) {
        const hist = await getSessionMessages(from, { dir: this.cwd });
        const i = hist.findIndex((m) => m.uuid === beforeId);
        if (i < 0) return bad('not-found', 'That message is not in the saved conversation.');
        if (i === 0) fresh = true; else upToMessageId = hist[i - 1].uuid;
      }
      const forked = fresh ? null : (await forkSession(from, { dir: this.cwd, ...(upToMessageId && { upToMessageId }), ...(title && { title }) })).sessionId;
      await this.stop();
      if (this.closed) return bad('closed', 'This session was closed.');
      this.sessionId = forked;
      this.hostStopped = false;
      this.resetConversation();
      this.publishMeta({ sessionId: forked, previousSessionId: from });
      this.fire(this.warm());
      return { ok: true, sessionId: forked, from };
    } catch (err) { return bad('branch', this.redact(errText(err))); }
  }

  // Edit and resend: the message `messageId` and everything after it leave the conversation, and `text` is sent in
  // its place. A reply in flight is stopped first. The conversation is cut back where it is, under the same session
  // id: Claude Code is started again on it and loads only what came before that message (the SDK's resume with
  // resumeSessionAt). What the cut drops stays in the saved file, on a branch nothing reads again. Only the very
  // first message has nothing before it to load: editing that one starts a new conversation, and the old one is
  // reported as superseded (meta.supersedes) so the host can stop showing it.
  //   images        leave out to send the message's own attachments again, unchanged
  //   restoreFiles  also put back the files Claude changed since that message
  //   id            the uuid the new message gets (the caller's, so its bubble knows it)
  // An `edit` event marks the moment the old turn is gone: everything after it belongs to the new message.
  // The new message tells the model what it can no longer see (notes.mjs): that its replies to the old one are gone,
  // and whether the files they changed were put back or are still as those replies left them. Nothing is said when
  // those replies changed no file, or when nothing is left of the conversation to remember them by.
  // Resolves once Claude Code has taken the new message: { ok, id, fresh, first }, or { ok: false, code, message }.
  // `fresh`: a new conversation was started. `first`: the edited message was the first thing said (with or without
  // a new conversation: one that starts with hook output has rows before its first message, and is cut in place).
  // After a failure nothing was cut: the conversation is as it was (a reply that was running stays stopped).
  async edit(opts) {
    const { messageId, text, images, restoreFiles = false, id = randomUUID() } = opts ?? {};
    const bad = (code, message) => ({ ok: false, code, message });
    const parked = () => bad('parked', 'This chat is open in the terminal view. Close the terminal to continue here.');
    if (this.closed) return bad('closed', 'This session was closed.');
    if (this.parked) return parked();
    if (!transcriptMod.cutPoint) return bad('unsupported', 'Editing a message is not part of this build of Canopy.');
    if (!isUuid(messageId)) return bad('invalid-input', 'That message cannot be edited.');
    const keep = images == null; // the message's own attachments go out again
    const wrong = this.checkSend(keep && typeof text === 'string' && !text.trim() ? '.' : text, keep ? [] : images, { id });
    if (wrong) return bad(wrong.code, wrong.message);
    if (this.outbox.has(id)) return bad('invalid-input', 'That message was already sent.');
    if (this.editing) return bad('busy', 'This chat is already being edited.');
    this.editing = true;
    let held = false;
    let start = false;
    let posted = false;
    try {
      // A message sent a moment ago that Claude Code has not started on may not be saved yet: it is just withdrawn.
      const waiting = this.outbox.get(messageId);
      const unsent = !!waiting && waiting.state !== 'started';
      let blocks = keep ? attachmentsOf(waiting?.msg?.message?.content) : [];
      // An ordinary Stop: sends Claude Code has not started on are withdrawn with the reply, or they would start the
      // moment it ends. (Messages waiting in the host's own queue are the host's to hold back.)
      if (this.busy || this.pending.size) await this.interrupt();
      // The reply has to be over before files are put back or the process goes. Background work alone keeps Claude
      // Code busy without a reply, so that is not waited for.
      if (this.busy) await Promise.race([this.waitIdle(5000), this.waitTurnClosed(5000)]);
      // The files Claude changed since that message, as its checkpoints know them (null: they could not say). Asked
      // while the process that knows is still alive, and never started for: it is only what the note names.
      let changed = null;
      if (!unsent && this.checkpoints && (restoreFiles || this.q)) changed = filesOf(await this.rewindNow(messageId, true, restoreFiles ? undefined : CHANGED_WAIT_MS));
      if (restoreFiles && !unsent) { // while the process that knows the checkpoints is still alive
        const r = await this.rewindNow(messageId, false);
        if (!r.canRewind) return bad('rewind', r.error ?? 'The files could not be restored.');
        // The files are back whatever becomes of the cut. If it never takes effect, the conversation still holds
        // those changes, and the model is told they were undone.
        this.notes.unless(id, { kind: 'undo', files: changed });
      }
      this.hold(); held = true; // from the stop to the cut, nothing else may start Claude Code on this conversation
      await this.stop();
      if (this.closed) return bad('closed', 'This session was closed.');
      if (this.parked) return parked();
      this.hostStopped = false;
      start = 'always'; // whatever happens from here, Claude Code comes back
      // The process is gone, so the saved conversation is final: read where the message sits in it.
      const from = this.sessionId;
      const rows = from ? await this.readTranscript(from) : null;
      const cut = from ? transcriptMod.cutPoint(rows, messageId) : null;
      if (!cut && !unsent) return bad('not-found', 'That message is not in the saved conversation.');
      if (cut?.compacted) return bad('compacted', 'A message from before the conversation was summarized cannot be edited.');
      if (cut && keep) blocks = cut.blocks;
      const imgs = keep ? [] : images;
      if (!text.trim() && !imgs.length && !blocks.length) return bad('invalid-input', 'There is nothing to send.');
      const msg = buildMsg(id, text, imgs, {});
      if (blocks.length) msg.message.content = [...blocks, ...(text.trim() ? [{ type: 'text', text: escapeNoteTag(text) }] : [])];

      const fresh = !!cut && !cut.at;
      // The first message of a moved chat carried the old chat's digest: the message that replaces it carries it again
      // (as does one that replaces a first message withdrawn before Claude Code ever started on it).
      const lead = this.takeLead(id, !!cut?.first);
      // What the model is told with the new message. A conversation with nothing left in it remembers nothing that
      // a note could set right, so its first message carries none (and what was waiting goes once it has started).
      if (cut && !cut.first) {
        // What it was told with a message the cut drops is gone with that message: it is told again.
        for (const r of rows.slice(rows.findIndex((x) => x.uuid === messageId))) this.notes.again(r.uuid);
        // A message Claude Code never started on has no replies to speak of.
        if (!unsent) this.notes.add({ kind: 'edit', files: changed, undone: restoreFiles }, { only: id });
      }
      withLead(msg, lead, cut?.first ? null : this.takeNote(id, text));
      // Claude Code checks a cut that drops one message's turn (resumeDropsTurn) and refuses when more would go than
      // that. A cut that drops several turns can't be checked that way, and one it refused once is not checked again.
      this.cut = { at: cut?.at ?? null, dropsTurn: cut?.at && cut.alone && !this.refusedCuts.has(messageId) ? messageId : null, id, messageId, fresh, first: !!cut?.first, from };
      if (fresh) {
        // Nothing is kept: the next start is a new conversation, which takes this one's place.
        this.superseded = from; this.lostSessionId = from; this.sessionId = null;
        if (this.lastMeta) this.lastMeta.sessionId = null;
      }
      this.resetConversation(); // the helpers and the turn the old process held went with it
      const outcome = new Promise((resolve) => { this.cutWait = resolve; });
      this.setTimer('cut', CUT_WAIT_MS, () => this.cutDone({ ok: true, id, fresh, first: !!cut?.first, pending: true }));
      this.event({ kind: 'edit', id, messageId, fresh, text });
      posted = true;
      const sent = this.post(id, msg, text, imgs.length + blocks.filter((b) => b.type === 'image').length);
      held = false; this.release(true); // starts Claude Code on the cut conversation and hands it the message
      if (sent?.ok === false) { this.cutDone(sent); return sent; }
      return await outcome;
    } catch (err) {
      this.cutDone(null);
      return bad('edit', this.redact(errText(err)));
    } finally {
      if (held) this.release(start);
      this.editing = false;
      if (!posted) this.notes.settle(id, 'failed'); // the new message never went out: what it would have carried waits on
    }
  }

  // The edited message's send moved on: Claude Code started on it (it loaded the cut conversation and took the
  // message), or the send ended without ever starting.
  cutWatch(id, state) {
    const cut = this.cut;
    if (!cut || cut.id !== id) return;
    // Nothing is left of the conversation the waiting notes were about.
    if (cut.first && (state === 'started' || state === 'completed')) this.notes.clear();
    if (state === 'started' || state === 'completed') this.cutDone({ ok: true, id, fresh: cut.fresh, first: cut.first });
    else if (state === 'cancelled' || state === 'failed' || state === 'lost') this.cutDone({ ok: false, code: 'edit-failed', message: 'The edited message could not be sent. The conversation is as it was.' });
  }

  // Disarm the cut and answer edit(). A cut that never took effect leaves the conversation whole, so the session
  // goes back to it (an edit of the first message had already let go of its id).
  cutDone(result) {
    const cut = this.cut;
    this.cut = null;
    this.clearTimer('cut');
    if (cut?.fresh && result?.ok !== true && !this.sessionId) {
      this.sessionId = cut.from; this.superseded = null; this.lostSessionId = null;
      if (this.lastMeta) this.lastMeta.sessionId = cut.from;
      if (this.run) this.fire(this.recycle('edit')); // a process started without the conversation: start it on it
    }
    const done = this.cutWait;
    this.cutWait = null;
    if (result) done?.(result);
  }

  // Claude Code would not start on the conversation cut back the way edit() asked: what the cut drops is more than
  // the one turn it named (the SDK's resumeDropsTurn refusal), or the place to cut could not be loaded. Asking again
  // for the same cut would be refused again, so it is given up: the conversation stays whole, the edited message is
  // not sent, and Claude Code is started again on the conversation as it is.
  cutRefused(run, m) {
    const cut = this.cut;
    const text = (m.errors ?? []).map(String).join('; ');
    const checked = text.includes(CUT_REFUSED);
    if (checked) this.refusedCuts.add(cut.messageId);
    this.log('warn', 'cut refused', { error: this.redact(text) });
    const result = checked
      ? { ok: false, code: 'edit-refused', message: 'That message could not be edited: something else arrived in the conversation while Claude was replying. Nothing was changed.' }
      : { ok: false, code: 'edit-failed', message: `That message could not be edited: ${this.redact(text) || 'Claude Code could not go back to it'}. Nothing was changed.` };
    this.cutDone(result); // before the send is closed, so cutWatch leaves the answer as it is
    this.detach(); this.hold(); // the refused process ends by itself; nothing waits on it
    try {
      this.outbox.mark(cut.id, 'failed');
      this.event({ kind: 'notice', level: 'warn', code: result.code, text: result.message });
      this.lifecycle = 'stopped';
      if (!this.outbox.unstarted().length) this.setBusy(false, 'idle');
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'restart', willRestart: true, why: 'edit' });
    } finally { this.reap(run, 300).finally(() => this.release('always')); }
  }

  async stopTask(taskId) {
    if (!this.q?.stopTask) return { ok: false, code: 'no-session', message: 'Claude Code is not running.' };
    try { await withTimeout(this.q.stopTask(String(taskId)), TIMEOUTS.set, 'stopTask'); return { ok: true }; }
    catch (err) { return { ok: false, code: err?.code === 'timeout' ? 'timeout' : 'task', message: this.redact(errText(err)) }; }
  }

  // Names the chat on the live process. Claude Code keeps the chat's name in memory and writes it back onto the end
  // of the transcript on later turns, so a name written to the file from outside (the SDK's renameSession) is
  // overwritten by the one the process still holds. Telling the process makes the new name the one it keeps. False
  // when the process is gone or this Claude Code can't take it (the caller then writes the file itself).
  async rename(title) {
    const q = this.q;
    const name = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    if (typeof q?.renameSession !== 'function' || !this.sessionId || !name) return false;
    try { await withTimeout(q.renameSession(name, this.sessionId), TIMEOUTS.set, 'rename'); return true; }
    catch (err) { this.log('warn', 'rename failed', { error: this.redact(errText(err)) }); return false; }
  }

  // Claude Code's own chat titler (the small model it names chats with), run on text the host picks. Nothing is
  // saved. Null when the process is gone, this CLI has no titler, or it fails.
  async generateTitle(description) {
    const q = this.q;
    if (typeof q?.generateSessionTitle !== 'function' || typeof description !== 'string' || !description.trim()) return null;
    try {
      const t = await withTimeout(q.generateSessionTitle(description, { persist: false }), 20000, 'title');
      return typeof t === 'string' && t.trim() ? t.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    } catch (err) { this.log('warn', 'title failed', { error: this.redact(errText(err)) }); return null; }
  }

  async background(toolUseId) {
    if (!this.q?.backgroundTasks) return { ok: false, code: 'no-session', message: 'Claude Code is not running.' };
    try { return { ok: true, moved: !!(await withTimeout(this.q.backgroundTasks(toolUseId || undefined), TIMEOUTS.set, 'background')) }; }
    catch (err) { return { ok: false, code: err?.code === 'timeout' ? 'timeout' : 'task', message: this.redact(errText(err)) }; }
  }

  async reload(what) {
    const q = this.q;
    const call = { plugins: 'reloadPlugins', skills: 'reloadSkills', styles: 'reloadOutputStyles' }[what];
    if (!call) return { ok: false, code: 'invalid-input', message: 'reload() takes plugins, skills or styles.' };
    if (!q?.[call]) return { ok: false, code: 'no-session', message: 'Claude Code is not running.' };
    try {
      const r = (await withTimeout(q[call](), 20000, 'reload')) ?? {};
      if (Array.isArray(r.commands)) this.commandsChanged(r.commands);
      const patch = {};
      if (Array.isArray(r.agents)) patch.agents = r.agents;
      const styles = r.available_output_styles ?? r.output_styles ?? r.styles;
      if (Array.isArray(styles)) patch.outputStyles = styles;
      if (Object.keys(patch).length) this.publishMeta(patch);
      return { ok: true, ...patch };
    } catch (err) { return { ok: false, code: err?.code === 'timeout' ? 'timeout' : 'reload', message: this.redact(errText(err)) }; }
  }

  /** The host's trusted folders changed (a project was opened): a chat held back as untrusted that is now trusted
   *  starts again with its project settings, hooks and MCP servers. Returns whether it did. */
  recheckTrust() {
    if (!this.restricted || this.trusted === false) return false;
    if (!this.evalTrust(this.resolveEnv()).trusted) return false;
    this.trust();
    return true;
  }

  // The user accepted this folder: load its project settings, hooks and MCP servers from the next start.
  trust() {
    this.trusted = true;
    if (!this.modeExplicit) this.mode = null; // the restricted start forced a mode; the project's own default applies now
    if (this.run && this.restricted) this.fire(this.recycle('trust'));
    return { ok: true };
  }

  /**
   * The host chose another account for new chats. A chat nobody has used yet (no conversation, nothing sent or
   * waiting) is a new chat, so it starts on that account instead; a process already warmed up on the old one is
   * started again. Any other chat keeps the account it started on. Returns whether it moved.
   * @param {string | null} account the host's name for the login (null: whatever Claude Code finds on its own)
   */
  moveAccount(account) {
    const next = typeof account === 'string' && account ? account : null;
    if (next === this.accountId || this.closed || this.parked) return false;
    if (this.sessionId || this.lostSessionId || this.busy || this.outbox.size > 0) return false;
    this.accountId = next;
    this.publishMeta({ accountId: next }); // whoever shows this chat goes by its account (is it signed out?), so it is told
    if (this.run) this.fire(this.recycle('account'));
    return true;
  }

  // Stop the process but keep the conversation. With park, the session stays
  // down (the terminal view owns the conversation) until unpark().
  stop(opts) {
    const { graceMs = TIMEOUTS.stopGrace, park = false } = opts ?? {};
    this.hostStopped = true;
    if (park) this.parked = true;
    this.clearTimer('restart'); this.clearTimer('warm');
    if (!this.stopping) this.stopping = this.doStop(graceMs).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  unpark() { this.parked = false; if (this.lifecycle === 'parked') this.lifecycle = 'stopped'; }

  close() {
    if (this.closed) return;
    this.flushDelta();
    this.closed = true;
    this.lifecycle = 'closed';
    const run = this.detach();
    this.clearAllTimers();
    this.removeAllListeners();
    this.rejectAllPending('Session closed.');
    this.outbox.closeAll('cancelled');
    this.notes.clear();
    this.busy = false; this.state = 'idle';
    if (run) this.fire(this.reap(run, 3000));
  }

  async dispose(opts) {
    const { graceMs = 2500 } = opts ?? {};
    if (this.closed) return;
    this.flushDelta();
    this.closed = true;
    this.lifecycle = 'closed';
    this.clearAllTimers();
    this.removeAllListeners();
    this.rejectAllPending('Session closed.');
    this.outbox.closeAll('cancelled');
    this.notes.clear();
    const run = this.run;
    const wasBusy = this.busy || this.turnOpen;
    this.busy = false; this.state = 'idle';
    if (run && wasBusy) { try { await withTimeout(run.q.interrupt({ cancelQueued: true }), 1500, 'interrupt'); } catch { /* killed below */ } }
    this.detach();
    if (run) await this.reap(run, graceMs);
  }

  // Everything a UI needs to redraw after a reload without restarting the process.
  snapshot() {
    this.flushDelta();
    const busy = this.reportedBusy();
    return {
      sessionId: this.sessionId, busy, accountId: this.accountId,
      settings: { ...this.settings, permissionMode: this.mode ?? this.settings.permissionMode },
      pending: [...this.pending.values()].map((p) => p.ev),
      meta: this.lastMeta ?? null,
      state: busy ? this.state : 'idle', lifecycle: this.lifecycle, seq: this.seq,
      turn: this.turn.slice(), outbox: this.outbox.snapshot(),
      tasks: this.taskList(), backgroundTasks: this.bg.slice(),
      lastError: this.lastError, restarts: this.restarts, pid: this.pid,
      restricted: this.restricted, risky: this.risky, degraded: CORE_DEGRADED.slice(),
      model: this.model ?? this.settings.model ?? null, mode: this.mode ?? this.settings.permissionMode ?? null,
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
    if (ev.kind === 'error') this.lastError = { code: ev.code ?? null, message: ev.message, at: Date.now() };
    try { this.emit('event', ev); } catch (err) { this.log('error', 'event listener threw', { error: errText(err) }); }
    // The UI clears its busy flag on every error; say again that work continues.
    if (ev.kind === 'error' && this.busy) this.emitBusy();
  }

  // Turn log: what a reloaded UI needs to redraw the turn in flight.
  record(ev) {
    if (ev.kind === 'turn-end') { this.turn = []; return; }
    if (!this.busy || !REPLAY_KINDS.has(ev.kind)) return;
    const last = this.turn[this.turn.length - 1];
    if (DELTA_KINDS.has(ev.kind)) {
      if (last?.kind === ev.kind && last.parent === ev.parent && last.index === ev.index && last.messageId === ev.messageId) { last.text += ev.text; last.seq = ev.seq; return; }
      this.turn.push({ ...ev });
    } else if ((ev.kind === 'tool-progress' || ev.kind === 'tool-input-partial') && last?.kind === ev.kind && last.id === ev.id) {
      // Each one says everything the one before it did: only the latest is worth replaying.
      this.turn[this.turn.length - 1] = ev;
    } else this.turn.push(ev);
    if (this.turn.length > TURN_LOG_MAX) this.turn.splice(0, this.turn.length - TURN_LOG_MAX);
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

  log(level, msg, data) { try { this.logFn?.(level, msg, data); } catch { /* logging never breaks the session */ } }

  redact(text) {
    if (typeof text !== 'string' || !text) return text ?? '';
    try {
      this.redactor ??= redactMod.makeRedactor?.(this.lastEnv ?? process.env) ?? null;
      return this.redactor ? this.redactor(text) : text;
    } catch { return text; }
  }

  // ---- busy ----

  setBusy(busy, state) {
    state = busy ? state ?? (this.state !== 'idle' ? this.state : 'running') : 'idle';
    if (this.busy === busy && this.state === state && this.shownBusy === this.reportedBusy()) return;
    this.busy = busy; this.state = state;
    this.emitBusy();
    if (!busy) {
      for (const w of this.idleWaiters.splice(0)) w();
      if (this.restartWhenIdle) this.fire(this.recycle(this.restartWhenIdle));
    }
  }

  // Claude Code stays 'running' while a workflow, agent or command works in the background, but the chat is free: say
  // idle then, so the host sends new messages straight away (like the terminal) and drops the Stop button. The
  // internal flag stays true until Claude Code itself goes idle.
  reportedBusy() { return this.busy && !this.onlyBackground(); }

  emitBusy() {
    const busy = this.shownBusy = this.reportedBusy();
    this.event({ kind: 'busy', busy, state: busy ? this.state : 'idle', queued: this.outbox.unstarted().length, background: this.bg.length });
  }

  // Background work started or ended, or a turn opened or closed: tell the host if the chat just became free or busy.
  syncBusy() {
    if (this.busy && this.shownBusy !== this.reportedBusy()) this.emitBusy();
  }

  // Clear busy without an event yet, so the error rows that follow do not make the flag flap; announceIdle() reports it.
  dropBusy() {
    if (!this.busy) return false;
    this.busy = false; this.state = 'idle';
    return true;
  }

  announceIdle(changed) {
    if (!changed) return;
    this.restartWhenIdle = null;
    this.emitBusy();
    for (const w of this.idleWaiters.splice(0)) w();
  }

  waitIdle(ms) {
    if (!this.busy) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); resolve(v); };
      const w = () => done(true);
      const t = setTimeout(() => { const i = this.idleWaiters.indexOf(w); if (i >= 0) this.idleWaiters.splice(i, 1); done(false); }, ms);
      t.unref?.();
      this.idleWaiters.push(w);
    });
  }

  // Claude Code says it is idle. Stay busy while sends it has not picked up are still on their way.
  onIdle() {
    this.clearTimer('stop');
    for (const e of this.outbox.started()) this.outbox.mark(e.id, 'completed');
    if (this.turnOpen) this.closeTurn();
    if (this.outbox.unstarted().length) { this.armAckWatch(); return; }
    this.setBusy(false, 'idle');
  }

  armAckWatch() {
    const run = this.run;
    this.setTimer('ack', TIMEOUTS.ack, () => {
      if (this.run !== run || !run) return;
      const stuck = this.outbox.unstarted().filter((e) => e.state !== 'pending');
      const quiet = run.hasStateEvents ? this.cliState === 'idle' : !this.turnOpen;
      if (!stuck.length || !quiet) return;
      // Claude Code went idle without ever taking these sends: the process is lost. Restart and redeliver.
      this.log('warn', 'sends were never picked up; restarting', { ids: stuck.map((e) => e.id) });
      this.fire(this.redeliver(run));
    });
  }

  async redeliver(run) {
    this.detach(); this.hold();
    try {
      this.rejectAllPending('Claude Code stopped.');
      this.requeueUnstarted();
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'exit', willRestart: true });
      await this.reap(run, 1500);
      if (!this.outbox.pending().length) this.setBusy(false, 'idle');
    } catch (err) { this.log('error', 'redelivery failed', { error: errText(err) }); }
    finally { this.release(true); }
  }

  // ---- sending ----

  checkSend(text, images, opts) { return checkMessage(text, images, opts, { priorities: ['now', 'next', 'later'] }); }

  // Hand every pending send to Claude Code, starting it if needed. A user action beats any restart backoff.
  flush() {
    if (this.closed || this.parked) return null;
    if (this.holds) return null; // whoever holds the session starts and flushes when it lets go
    try { this.ensureStarted(); } catch (err) { return this.startFailed(err); }
    const run = this.run;
    for (const e of this.outbox.pending()) {
      if (run.inputDead || !run.input.push(e.msg)) {
        // The pipe to Claude Code is gone. Ending the query makes the supervisor restart and redeliver.
        try { run.q.close?.(); } catch { /* already closed */ }
        return null;
      }
      if (run.coldSend == null) run.coldSend = !run.ready;
      this.outbox.mark(e.id, 'written');
    }
    run.lastFrameAt = Date.now();
    return null;
  }

  cancelEntry(id) {
    const e = this.outbox.get(id);
    if (!e || e.state === 'started') return null;
    this.outbox.mark(id, 'cancelled');
    const row = { id: e.id, text: e.text };
    this.cancelBatch.push(row);
    // Outside a Stop the notice goes out on its own; interrupt() and forceStop() announce their own batch.
    if (!this.interrupting && !this.timers.cancelled) this.setTimer('cancelled', 0, () => this.announceCancelled());
    return row;
  }

  cancelUnstarted() { return this.outbox.unstarted().map((e) => this.cancelEntry(e.id)).filter(Boolean); }

  announceCancelled() {
    this.clearTimer('cancelled');
    const cancelled = this.cancelBatch.splice(0);
    if (cancelled.length) {
      this.event({ kind: 'notice', code: 'send-cancelled', cancelled, text: `Stopped. ${cancelled.length} queued message${cancelled.length > 1 ? 's were' : ' was'} not sent.` });
    }
    return cancelled;
  }

  requeueUnstarted({ count = true } = {}) {
    const exhausted = this.outbox.requeue(count ? MAX_SEND_ATTEMPTS : Infinity);
    this.failSends(exhausted);
    return exhausted;
  }

  clearSuggestion() {
    if (!this.suggestionShown) return;
    this.suggestionShown = false;
    this.event({ kind: 'suggestion', text: '' });
  }

  // ---- settings ----

  modeAllowed(v) { return MODES.has(v) && (v !== 'bypassPermissions' || this.allowBypass === true); }

  checkSetting(key, value) {
    const str = (max = 200) => typeof value === 'string' && value.length <= max;
    const unset = value == null || value === '';
    switch (key) {
      case 'model': case 'fallbackModel': case 'agent': return unset || str() ? null : 'it must be a name';
      case 'outputStyle': return str() && value ? null : 'it must be a style name';
      case 'permissionMode': return MODES.has(value) ? null : 'unknown permission mode';
      case 'effort': return unset || EFFORTS.has(value) ? null : 'unknown effort level';
      case 'fast': case 'ultracode': case 'codeMode': case 'suggestions': return typeof value === 'boolean' || unset ? null : 'it must be on or off';
      case 'thinking': return unset || THINKING.has(value) ? null : 'it must be summarized, omitted or off';
      case 'maxBudgetUsd': return unset || (typeof value === 'number' && Number.isFinite(value) && value > 0) ? null : 'it must be a positive amount';
      case 'maxTurns': return unset || (Number.isInteger(value) && value > 0) ? null : 'it must be a positive whole number';
      case 'additionalDirectories':
        return unset || (Array.isArray(value) && value.length <= 50 && value.every((d) => typeof d === 'string' && d.startsWith('/') && d.length < 4096)) ? null : 'it must be a list of absolute folders';
      default: return 'unknown setting';
    }
  }

  settingFailed(key, value, text, code, message) {
    this.event({ kind: 'notice', level: 'warn', text });
    this.event({ kind: 'setting-failed', key, value });
    return { ok: false, code, message: message ?? text };
  }

  async applySet(key, value, early = false) {
    if (this.closed) return { ok: false, code: 'closed', message: 'This session was closed.' };
    const known = typeof key === 'string' && (LIVE_KEYS.has(key) || START_KEYS.has(key));
    const prev = known ? this.settings[key] : undefined;
    const current = key === 'permissionMode' ? this.mode ?? prev ?? 'default' : prev;
    const why = known ? this.checkSetting(key, value) : 'unknown setting';
    if (why) return this.settingFailed(String(key), current, `Could not change ${String(key)}: ${why}`, 'invalid-input');
    if (key === 'permissionMode' && !this.modeAllowed(value)) return this.settingFailed(key, current, BYPASS_NOTICE, 'not-allowed');
    if (key === 'permissionMode' && value === 'bypassPermissions' && this.restricted && this.q) {
      return this.settingFailed(key, current, 'Could not change permissionMode: this folder is not trusted yet. Trust it first to use bypass permissions.', 'untrusted');
    }

    // A chat that has started keeps the tools it started with (see toolsFixed). The choice is not refused: it is the
    // host's to keep for the chats that come after, and the answer says what this chat has.
    if (key === 'codeMode' && this.toolsFixed && !early) {
      this.event({ kind: 'setting', key, value: prev === true, appliesOn: 'new-chats' });
      return { ok: true, applied: 'new-chats' };
    }

    this.settings[key] = value;
    if (START_KEYS.has(key)) {
      this.event({ kind: 'setting', key, value, appliesOn: 'restart' });
      if (!this.run) return { ok: true, applied: 'next-start' };
      this.fire(this.recycle('setting'));
      return { ok: true, applied: 'restart' };
    }
    const q = this.q;
    const keep = () => {
      if (key === 'permissionMode') this.rememberMode(value, true);
      this.event({ kind: 'setting', key, value, deferred: true });
      return { ok: true, applied: 'next-start' };
    };
    if (!q) return keep();
    try {
      await withTimeout(this.applyLive(q, key, value), TIMEOUTS.set, `set ${key}`);
      if (key === 'permissionMode') this.rememberMode(value, true);
      this.event({ kind: 'setting', key, value });
      return { ok: true, applied: 'live' };
    } catch (err) {
      const msg = this.redact(errText(err));
      // The process went away or did not answer: the value is kept and applies on the next start.
      if (err?.code === 'timeout' || this.q !== q || /Query closed|aborted|terminated/i.test(msg)) return keep();
      this.settings[key] = prev;
      const text = key === 'permissionMode' && value === 'bypassPermissions' ? BYPASS_NOTICE : `Could not change ${key}: ${msg}`;
      return this.settingFailed(key, key === 'permissionMode' ? this.mode : prev, text, 'rejected', msg);
    }
  }

  applyLive(q, key, value) {
    switch (key) {
      case 'model': return q.setModel(value || undefined);
      case 'permissionMode': return q.setPermissionMode(value);
      // effort: null resets to the model default; keep ultracode on across effort changes.
      case 'effort': return q.applyFlagSettings(this.settings.ultracode ? { effortLevel: value || null, ultracode: true } : { effortLevel: value || null });
      case 'fast': return q.applyFlagSettings({ fastMode: !!value });
      case 'ultracode': return q.applyFlagSettings({ ultracode: !!value });
      case 'codeMode': return this.applyCodeMode(q, value === true);
      case 'outputStyle': return q.updateSettings('localSettings', { outputStyle: value });
      case 'agent': return q.applyFlagSettings({ agent: value || null });
      default: return Promise.reject(new Error('unknown setting'));
    }
  }

  modeGranted(mode) {
    this.rememberMode(mode, true);
    this.event({ kind: 'setting', key: 'permissionMode', value: mode, via: 'grant' });
  }

  rememberMode(mode, explicit = false) {
    if (!MODES.has(mode)) return;
    this.mode = mode;
    if (explicit) this.modeExplicit = true;
    if (this.lastMeta) this.lastMeta.mode = mode;
  }

  // ---- code mode ----

  // Why Code Mode cannot run on this process, or null. Until Claude Code has said what it can do, nothing is known against it.
  codeWhyNot(run) {
    if (!codeMod.codeBlocked || !channelMod.controlChannel) return 'Code Mode is not part of this build of Canopy.';
    return codeMod.codeBlocked(run?.ready ? run.caps : null);
  }

  // The note that tells Claude to prefer scripts rides on the server, not in the system prompt: it comes and goes
  // with the tool, so turning Code Mode off never leaves Claude told to use a tool it no longer has.
  codeServer(run) {
    return codeMod.createCodeServer({ instructions: codeMod.CODE_NOTE, run: (args, extra) => this.runCode(run, args, extra) });
  }

  // ---- widgets ----

  // Claude's show_widget and read_me (widgets.mjs): one server for the life of the process, there in every chat.
  // Null when this build cannot offer it.
  widgetServer(run) {
    if (!widgetsMod.createWidgetServer || widgetsMod.WIDGETS_MISSING) return null;
    run.widgets ??= widgetsMod.createWidgetServer({ show: (args, extra) => this.showWidget(args, extra) });
    return run.widgets;
  }

  // The handler of show_widget (widgets.mjs SHOW_WIDGET, the same one a Codex chat's call runs). A widget with a
  // script waits a moment for the window to say how it ran, by the call's tool_use id, and that goes back to Claude.
  async showWidget(args, extra) {
    const id = extra?._meta?.['claudecode/toolUseId'];
    return widgetsMod.SHOW_WIDGET.run(args, { engine: 'claude', callId: typeof id === 'string' ? id : null, widgetReport: this.widgetReport });
  }

  // ---- look ----

  // Claude's look tool (look.mjs): a screenshot of a page or a window, one server for the life of the process.
  // Null when this build cannot offer it, or the host gave nothing to take the screenshots with.
  lookServer(run) {
    if (!this.lookBackend || !lookMod.createLookServer || lookMod.LOOK_MISSING) return null;
    run.look ??= lookMod.createLookServer({ backend: this.lookBackend, shots: this.shots, unasked: (id) => run.unasked?.delete(id) === true });
    return run.look;
  }

  // Whether a look goes ahead without the user being asked: a page on this Mac, or Canopy's own window (localLook).
  // Such a call is noted, and the tool then shows it Canopy's own windows and no other app's: a call that reaches
  // the tool unnoted is one the user said yes to, or one Claude Code never asks about (a chat that runs without
  // asking, a rule that always allows it).
  async freeLook(input, ctx) {
    const run = this.run;
    let own = [];
    try { own = await this.lookBackend.ownWindows(); } catch (err) { this.log('warn', 'listing own windows failed', { error: errText(err) }); }
    if (!run || this.run !== run || !ctx.toolUseID || !lookMod.localLook(input, { own })) return false;
    run.unasked ??= new Set();
    if (run.unasked.size >= 200) run.unasked.clear(); // calls that were allowed and then never ran
    run.unasked.add(ctx.toolUseID);
    return true;
  }

  // ---- other chats ----

  // Claude's read_chat (read-chat.mjs): one server for the life of the process, there in every chat from its first
  // turn. Its tool waits behind tool search, so it costs nothing until Claude asks for it. Null when this build
  // cannot offer it.
  chatsServer(run) {
    if (!readChatMod.createReadChatServer || readChatMod.READ_CHAT_MISSING) return null;
    run.chats ??= readChatMod.createReadChatServer({
      read: (args) => readChatMod.readChat(args, { self: { id: this.sessionId, cwd: this.cwd }, sources: this.otherChats ?? undefined }),
    });
    return run.chats;
  }

  // ---- memory ----

  // Claude's remember, recall and forget (memory-tools.mjs): one server for the life of the process, in every chat of
  // a host that keeps a memory. remember is always in front of Claude (its description decides what is saved); the
  // other two wait behind tool search. Null when the host keeps no memory, or this build cannot offer the tools.
  memoryServer(run) {
    if (!this.memoryStore || !memoryMod.createMemoryServer || memoryMod.MEMORY_MISSING) return null;
    run.memory ??= memoryMod.createMemoryServer({ chat: () => ({ cwd: this.cwd, sessionId: this.sessionId, memory: this.memoryStore, said: () => (this.heardAll ? this.heard : null) }) });
    return run.memory;
  }

  // ---- the task card ----

  // Claude's task (task-tool.mjs): one server for the life of the process, in every chat. Always in front of Claude,
  // since its description is what tells Claude the card exists. Null when this build cannot offer it.
  taskServer(run) {
    if (!taskMod.createTaskServer || taskMod.TASK_MISSING) return null;
    run.task ??= taskMod.createTaskServer();
    return run.task;
  }

  // Every in-process server this process should have. setMcpServers takes the whole set each time, so the servers
  // that are always there are named again whenever Code Mode's comes or goes (leaving one out would remove it).
  servers(run, code) {
    const out = {};
    const widgets = this.widgetServer(run);
    if (widgets) out[widgetsMod.UI_SERVER] = widgets;
    const look = this.lookServer(run);
    if (look) out[lookMod.LOOK_SERVER] = look;
    const chats = this.chatsServer(run);
    if (chats) out[readChatMod.CHATS_SERVER] = chats;
    const memory = this.memoryServer(run);
    if (memory) out[memoryMod.MEMORY_SERVER] = memory;
    const task = this.taskServer(run);
    if (task) out[taskMod.TASK_SERVER] = task;
    if (code) out[codeMod.CODE_SERVER] = this.codeServer(run);
    return out;
  }

  // A tool whose input the window draws while Claude is still writing it.
  streamsInput(name) { return name === widgetsMod.SHOW_TOOL; }

  // The handler of Code Mode's tool, for the process its server was registered on.
  async runCode(run, args, extra) {
    const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true });
    if (this.run !== run || !run.control?.open) return refuse('Claude Code restarted, so this script did not run. Run it again.');
    // The safety gate, checked where the calls are made: a Claude Code that does not advertise check_permissions
    // ignores it and would run every one of the script's calls unchecked.
    if (!codeMod.CODE_CAPS.every((c) => run.caps.has(c))) return refuse(this.codeWhyNot(run) ?? 'Code Mode is not available yet. Call the tools directly.');
    // In Plan mode Claude Code refuses any call of a script's that would have to ask, and tells Claude not to try
    // again. The same call made directly does ask, so say that instead of running a script that cannot finish.
    if ((this.mode ?? this.settings.permissionMode) === 'plan') return refuse('Scripts cannot call tools in Plan mode, so this one did not run. Call the MCP tools directly instead.');
    run.code ??= new codeMod.CodeRuns({
      channel: run.control,
      readFile: (path, o) => run.q.readFile(path, o),
      roots: () => [this.cwd, ...(Array.isArray(this.settings.additionalDirectories) ? this.settings.additionalDirectories.filter((d) => typeof d === 'string' && d.startsWith('/')) : [])],
      emit: (ev) => { if (this.run === run) this.event(ev); },
      // A script's result is words: a look made from one would spend the render and bring back no picture.
      direct: (tool) => (tool === lookMod.LOOK_TOOL ? 'A script cannot bring a screenshot back: it would get the caption and no picture. Call look yourself, once for each picture you need.' : null),
    });
    return run.code.run(args, extra);
  }

  // Add or remove Code Mode's server on the live process. Only a chat that has not started gets here (applySet), or
  // one whose Claude Code turned out unable to run it (syncCodeMode). One change at a time: a toggle can arrive while
  // the start-up check is still applying its own.
  applyCodeMode(q, on) {
    const run = this.run;
    if (!run || run.q !== q) return Promise.resolve();
    const next = (run.codeSync ?? Promise.resolve()).catch(() => {}).then(() => this.setCodeServer(run, on));
    run.codeSync = next;
    // Messages wait while the change is on its way, so the chat's first request already has the tools it will keep
    // (a new chat is opened first and told your choices a moment later). Never for long: once Claude Code has
    // started, a change it does not answer in time stops holding them back.
    this.hold();
    const late = Promise.resolve(run.meta).then(() => sleep(TIMEOUTS.set));
    Promise.race([next.catch(() => {}), late]).finally(() => this.release());
    return next;
  }

  // The payload is the whole set of Canopy's own servers: Code Mode's, or not, beside the widgets server, which
  // stays (servers from settings files and plugins are not touched by it).
  async setCodeServer(run, on) {
    if (this.run !== run || on === run.codeServing) return;
    if (on) {
      await run.meta; // what this Claude Code can do is known once it has answered initialize
      const why = this.codeWhyNot(run);
      if (why) throw new Error(why);
      if (this.run !== run) return;
    }
    // A script still running belongs to the server being taken away: its result would have nowhere to go.
    if (!on) run.code?.stopAll();
    const r = await run.q.setMcpServers(this.servers(run, on));
    const failed = on ? r?.errors?.[codeMod.CODE_SERVER] : null;
    if (failed) throw new Error(String(failed));
    run.codeServing = on;
  }

  // Once Claude Code has said what it can do: take Code Mode away from one that cannot check a script's calls,
  // and bring the process in line with a setting that changed while it was starting.
  async syncCodeMode(run) {
    if (this.run !== run) return;
    const why = this.settings.codeMode === true ? this.codeWhyNot(run) : null;
    if (why) {
      this.settings.codeMode = false;
      this.settingFailed('codeMode', false, `Could not change codeMode: ${why}`, 'unsupported');
    }
    const want = this.settings.codeMode === true;
    if (want === run.codeServing) return;
    try { await withTimeout(this.applyCodeMode(run.q, want), TIMEOUTS.set, 'set codeMode'); }
    catch (err) { this.log('warn', 'code mode sync failed', { error: errText(err) }); }
  }

  // ---- scheduled prompts ----

  // Claude Code's Stop hook, used only to listen. At the end of every reply it says which prompts are set to wake
  // this chat later (CronCreate, ScheduleWakeup, /loop). They live in the chat's process: one let go for sitting idle
  // would silently never run them, so the manager keeps a chat that has any (manager.mjs). The list is kept over a
  // restart of the process, because Claude Code brings the prompts back when the conversation is resumed (checked
  // live, CLI 2.1.325), and it is replaced at the end of the next reply. The answer is always empty: this never
  // changes what Claude does, and a hook of the user's own runs as it always did.
  onStop(run, input) {
    try {
      if (this.run === run && input?.hook_event_name === 'Stop') {
        const jobs = Array.isArray(input.session_crons) ? input.session_crons.filter(isPlain) : [];
        this.scheduled = jobs.map((j) => ({ id: String(j.id ?? ''), schedule: String(j.schedule ?? ''), recurring: j.recurring === true }));
      }
    } catch (err) { this.log('warn', 'reading the scheduled prompts failed', { error: errText(err) }); }
    return Promise.resolve({});
  }

  // ---- permissions ----

  broker(name, input, ctx) {
    ctx = ctx ?? {};
    const yes = () => allowed(input, ctx);
    // Code Mode's own tool never asks: every call its script makes is decided on its own, like the model's.
    if (name === codeMod.CODE_TOOL && this.run?.codeServing) return yes();
    // Showing a widget, or reading how to, never asks: nothing is changed, and the widget is drawn in a sandbox.
    if ((name === widgetsMod.SHOW_TOOL || name === widgetsMod.GUIDE_TOOL) && this.run?.widgets) return yes();
    // An ask with a reason behind it (an ask rule the user wrote, a hook, a safety check) is the user saying "ask
    // me": the two tools below are then asked about like any other. Plan mode is not such a reason: there Claude
    // Code asks about every tool that is not marked read-only and gives the mode as why (checked live, CLI 2.1.325).
    const why = ctx.decisionReasonType;
    const told = !!((why && why !== 'mode') || ctx.matchedAskRule || ctx.requiresInteraction);
    // Looking at a page on this Mac, or at Canopy's own window, never asks: it changes nothing. A page out on the
    // web, a file, or another app's window is asked about like any other tool's call (see localLook).
    if (name === lookMod.LOOK_TOOL && this.run?.look && !told) return this.freeLook(input, ctx).then((free) => (free ? yes() : this.askAbout(name, input, ctx)));
    // Reading the user's other chats in this project never asks: it is read-only, and they are the user's own.
    if (name === readChatMod.READ_CHAT_TOOL && this.run?.chats && !told) return yes();
    // Saving a note, looking one up and taking one out never ask: the notes are the user's own, a save or a removal
    // changes only Canopy's own folder (a removed note waits in its trash), and the window shows each with an Undo.
    if ((name === memoryMod.REMEMBER_TOOL || name === memoryMod.RECALL_TOOL || name === memoryMod.FORGET_TOOL) && this.run?.memory && !told) return yes();
    // Reporting a task never asks: it changes nothing, it only draws the card.
    if (name === taskMod.TASK_TOOL && this.run?.task) return yes();
    return this.askAbout(name, input, ctx);
  }

  // A call that is the user's to decide: put to them, unless they already answered it.
  askAbout(name, input, ctx) {
    const yes = () => allowed(input, ctx);
    // A call made by a script (see code-mode.mjs). Claude Code offers no "always allow" for these, so Canopy keeps its
    // own, but only for a plain ask. One with a reason behind it (an ask rule the user wrote, a hook, a safety check)
    // is put to the user every time, as it is for the model's own call.
    const nested = codeMod.isNestedAsk?.(ctx.toolUseID) === true;
    const sticky = nested && !ctx.decisionReasonType && !ctx.matchedAskRule && !ctx.requiresInteraction;
    if (sticky && this.codeAllowed.has(name)) return yes();
    const code = nested ? this.run?.code : null;
    const claim = code?.claim(name, input) ?? null;
    const type = name === 'AskUserQuestion' ? 'question' : name === 'ExitPlanMode' ? 'plan' : 'tool';
    const suggestions = ctx.suppressAlwaysAllowRule ? [] : clone(ctx.suggestions ?? []);
    const plain = fileApprovals.plainAsk(ctx, { nested });
    const id = ctx.toolUseID;
    if (id) this.steps.asked(id);
    // A change the user already answered in the card for its message: the same call, with the same input, asked in
    // the plain way. Anything else about it (a rule, a safety reason, another folder, a changed input) is a question
    // of its own.
    const covered = id ? this.covered.get(id) : null;
    if (covered) {
      this.covered.delete(id);
      if (plain && covered.name === name && fileApprovals.sameInput(covered.input, input)) {
        const tag = { toolUseID: id, decisionClassification: covered.behavior === 'allow' ? 'user_temporary' : 'user_reject' };
        return Promise.resolve(covered.behavior === 'allow' ? { behavior: 'allow', updatedInput: input ?? {}, ...tag } : { behavior: 'deny', message: covered.message, ...tag });
      }
    }
    const put = (group) => {
      const several = group.length > 1;
      const asked = this.ask({
        type, toolName: name, input,
        hasSuggestions: sticky || suggestions.length > 0, reason: ctx.decisionReason ?? null,
        // A script's call has no row of its own in the transcript: the prompt belongs to the script's.
        blockedPath: ctx.blockedPath ?? null, toolUseId: claim?.run ?? ctx.toolUseID ?? null, agentId: ctx.agentID ?? null,
        suggestions, title: ctx.title ?? null, displayName: ctx.displayName ?? null, description: ctx.description ?? null,
        defaultToNo: !!ctx.defaultToNo, requiresInteraction: !!ctx.requiresInteraction,
        mcpServer: ctx.mcpServer ?? null, matchedAskRule: ctx.matchedAskRule ?? null, ...(nested && { codeMode: true }),
        // One answer covers every file of the change, so the card lists every one of them (as an OpenAI chat's does).
        ...(several && {
          title: `Change ${group.length} files?`, description: `And ${group.length - 1} more ${group.length === 2 ? 'file' : 'files'}.`,
          changes: group.slice(0, CARD_FILES).map((r) => ({ id: r.id, name: r.name, input: r.input })),
          changeCount: group.length, toolUseIds: group.map((r) => r.id),
        }),
      }, { signal: ctx.signal, fallback: { behavior: 'deny', message: 'Cancelled.' }, name, input: input ?? {}, ctx, kind: type, suggestions, sticky, siblings: several ? group.filter((r) => r.id !== id) : null });
      if (!claim) return asked;
      code.waiting(claim, true);
      return asked.then((answer) => { code.waiting(claim, false); return answer; });
    };
    // A plain file change opens a group: the other file changes of the same message that have yet to be asked about.
    // Claude Code asks for the first while the message is still being written, so the card waits (briefly) for the
    // rest to be known.
    if (plain && id && !claim && fileApprovals.FILE_TOOLS.has(name) && this.steps.find(id)) {
      const roots = fileApprovals.projectRoots(this.cwd);
      if (!this.steps.writing(id)) return put(this.steps.group(id, input, roots));
      return this.steps.settled(id, this.settleMs ?? fileApprovals.SETTLE_MS, ctx.signal).then(() => put(this.steps.group(id, input, roots)));
    }
    return put([]);
  }

  // A question from an MCP server in the middle of a turn: a form, a sign-in link or a plain yes/no (elicitation.mjs).
  // The same card an OpenAI chat raises for it, answered in MCP's words: accept (with the form's values), decline,
  // or cancel (also what it gets when the turn is stopped or Claude Code withdraws the question).
  elicit(req, opts) {
    req = isPlain(req) ? req : {};
    const d = elicitation.describe(req);
    return this.ask({
      type: 'elicitation', toolName: req.serverName ?? 'MCP server', input: {},
      server: d.server, message: d.message, mode: d.mode, ask: d.ask, url: d.url, fields: d.fields,
      schema: d.mode === 'form' && isPlain(req.requestedSchema) ? req.requestedSchema : null, elicitationId: d.elicitationId,
      title: d.title, displayName: req.displayName ?? null, description: req.description ?? null,
      hasSuggestions: false, suggestions: [], reason: null, blockedPath: null, toolUseId: null, agentId: null, mcpServer: d.server,
    }, { signal: opts?.signal, fallback: { action: 'cancel' }, name: 'elicitation', input: {}, ctx: {}, kind: 'elicitation', suggestions: [] });
  }

  // One pending question to the user. Always resolves: with the answer, or with
  // `fallback` when Claude Code withdraws the request or the session shuts down.
  ask(base, { signal, fallback, name, input, ctx, kind, suggestions, sticky = false, siblings = null }) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(fallback);
      const id = ++requestSeq;
      let settled = false;
      const onAbort = () => done(fallback, { aborted: true });
      const done = (result, extra) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        try { signal?.removeEventListener?.('abort', onAbort); } catch { /* not an EventTarget */ }
        this.event({ kind: 'permission-resolved', id, ...extra });
        resolve(result);
        if (this.run && !this.run.hasStateEvents && this.busy && !this.pending.size) this.setBusy(true, 'running');
        this.syncBusy(); // an answered question no longer holds the chat busy when only background work remains
      };
      try {
        const ev = { kind: 'permission', id, ...base, sessionId: this.sessionId };
        this.pending.set(id, { id, kind, name, input, ctx, suggestions, fallback, done, ev, sticky, siblings });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        if (this.run && !this.run.hasStateEvents) this.setBusy(true, 'requires_action');
        this.event(ev);
      } catch (err) {
        this.log('error', 'permission request failed', { error: errText(err) });
        settled = true;
        this.pending.delete(id);
        resolve(fallback);
      }
    });
  }

  decide(p, a) {
    const { input, ctx, kind } = p;
    const toolUseID = ctx?.toolUseID;
    const tag = (decisionClassification) => ({ ...(toolUseID && { toolUseID }), decisionClassification });
    const allow = (updatedInput, cls = 'user_temporary', extra) => { p.done({ behavior: 'allow', updatedInput, ...tag(cls), ...extra }); this.cover(p, { behavior: 'allow' }); };
    const deny = (message, stop) => { p.done({ behavior: 'deny', message, ...(stop && { interrupt: true }), ...tag('user_reject') }); this.cover(p, { behavior: 'deny', message }); };
    // What they typed on the card is theirs as much as a message is: feedback, or the answers to a question.
    this.hear(a.message, ...(isPlain(a.answers) ? Object.values(a.answers).flat() : []));

    if (kind === 'elicitation') {
      // A form's values go back as the server asked for them; a form whose fields could not be read takes what was typed.
      const fields = p.ev?.fields;
      const said = elicitation.answerOf(fields, a);
      if (said.action === 'accept' && !(Array.isArray(fields) && fields.length) && isPlain(a.content) && p.ev?.schema) said.content = a.content;
      p.done(said);
      return;
    }
    switch (a.action) {
      case 'allow':
        allow(kind === 'tool' && isPlain(a.input) ? a.input : input);
        break;
      case 'always': {
        if (p.sticky) { this.allowNested(p, allow); break; }
        const grants = this.pickGrants(p, a);
        if (!grants.length) { allow(input); break; }
        allow(input, 'user_permanent', { updatedPermissions: grants });
        const described = grants.map((u) => ({ ...u, text: describeGrant(u) }));
        const mode = grants.filter((u) => u.type === 'setMode').pop()?.mode;
        if (mode) this.modeGranted(mode);
        const text = described.map((g) => g.text).join('; ');
        this.event({ kind: 'notice', code: 'granted', grants: described, text: `Granted: ${text}.` });
        break;
      }
      case 'answers':
        if (kind !== 'question') { allow(input); break; }
        allow({ ...input, answers: this.cleanAnswers(input, a.answers), ...(isPlain(a.annotations) && { annotations: this.cleanAnnotations(input, a.annotations) }) });
        break;
      case 'question-skip':
        this.skipQuestion(p, a.how, allow, deny);
        break;
      case 'plan-approve': {
        const updatedInput = typeof a.plan === 'string' && a.plan !== input.plan ? { ...input, plan: a.plan } : input;
        const mode = a.mode && a.mode !== 'plan' && this.modeAllowed(a.mode) ? a.mode : null;
        // The mode switch rides on the approval itself, so the first tool after the plan already runs in it.
        allow(updatedInput, 'user_temporary', mode ? { updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } : undefined);
        if (mode) this.modeGranted(mode);
        break;
      }
      case 'plan-reject':
        deny(a.message ? `The user wants to keep planning. Feedback: ${String(a.message)}` : 'The user wants to keep planning.', a.stop === true);
        break;
      default:
        if (kind === 'question' && a.stop !== true && !a.message) this.skipQuestion(p, 'dismissed', allow, deny);
        else deny(typeof a.message === 'string' && a.message ? a.message : 'The user denied this action.', a.stop === true);
    }
  }

  // The user answered a card that stood for several file changes: the others are answered the same way when Claude
  // Code gets to them, each only as the exact call (its id, its input) the card showed. Only an answer the user gave
  // does this; a card that is cancelled, interrupted or closed covers nothing.
  cover(p, answer) {
    for (const s of p.siblings ?? []) this.covered.set(s.id, { name: s.name, input: s.input, ...answer });
  }

  // "Always allow" for a call a script made. Claude Code keeps no rule for these (it offers none, and drops one it
  // is handed), so Canopy remembers the tool itself: for scripts only, and only while this chat is open.
  allowNested(p, allow) {
    this.codeAllowed.add(p.name);
    allow(p.input);
    // A script that made the same call several times at once asked several times: one answer covers them all.
    for (const other of [...this.pending.values()]) {
      if (other.sticky && other.name === p.name) other.done({ behavior: 'allow', updatedInput: other.input, ...(other.ctx?.toolUseID && { toolUseID: other.ctx.toolUseID }), decisionClassification: 'user_temporary' });
    }
    this.event({ kind: 'notice', code: 'granted', text: `Granted: always allow ${p.name} from Code Mode scripts in this chat.` });
  }

  // "Always allow" applies what Claude Code offered, as the terminal does. Callers pick by index and never supply rules.
  pickGrants(p, a) {
    let grants = clone(p.suggestions ?? []).filter(isPlain);
    if (Array.isArray(a.pick)) {
      const picks = new Set(a.pick.filter((i) => Number.isInteger(i)));
      grants = grants.filter((_, i) => picks.has(i));
    }
    grants = grants.filter((u) => u.type !== 'setMode' || this.modeAllowed(u.mode));
    if (a.scope === 'session') for (const u of grants) if (u.type === 'addRules' || u.type === 'addDirectories') u.destination = 'session';
    return grants;
  }

  cleanAnswers(input, answers) {
    const asked = new Set((input?.questions ?? []).map((q) => q?.question).filter((s) => typeof s === 'string'));
    const out = {};
    if (!isPlain(answers)) return out;
    for (const [k, v] of Object.entries(answers)) {
      if (!asked.has(k)) continue;
      out[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '');
    }
    return out;
  }

  cleanAnnotations(input, annotations) {
    const asked = new Set((input?.questions ?? []).map((q) => q?.question).filter((s) => typeof s === 'string'));
    const out = {};
    for (const [k, v] of Object.entries(annotations)) if (asked.has(k) && isPlain(v)) out[k] = v;
    return out;
  }

  skipQuestion(p, how, allow, deny) {
    const input = p.input;
    const reason = ['skipped', 'replied_in_chat', 'dismissed'].includes(how) ? how : 'skipped';
    if (this.caps.has('ask_user_question_unanswered_v1')) {
      const annotations = {};
      for (const q of input?.questions ?? []) if (typeof q?.question === 'string') annotations[q.question] = { unanswered: reason };
      allow({ ...input, answers: {}, annotations });
    } else deny('The user chose not to answer. Continue without this answer or ask in chat.');
  }

  rejectAllPending(message, { interrupt = false } = {}) {
    this.covered.clear();
    for (const p of [...this.pending.values()]) {
      if (p.kind === 'elicitation') p.done(p.fallback);
      else p.done({ behavior: 'deny', message, ...(interrupt && { interrupt: true }), ...(p.ctx?.toolUseID && { toolUseID: p.ctx.toolUseID }) });
    }
  }

  // ---- starting ----

  resolveEnv() {
    let base;
    if (typeof this.env === 'function') {
      // The getter decides which login this chat runs on. If it cannot say, nothing is started: falling back to
      // this process's environment would quietly run the chat on a different login.
      try { base = this.env(); }
      catch (err) {
        this.log('error', 'env getter threw', { error: errText(err) });
        if (err?.canopy?.code) throw err;
        throw coded('no-env', `Canopy could not set up this chat's environment (${errText(err)}).`);
      }
      if (!isPlain(base)) throw coded('no-env', "Canopy could not set up this chat's environment.");
    } else base = isPlain(this.env) ? this.env : process.env;
    let env;
    try { env = envMod.scrubEnv?.(base); } catch { env = null; }
    if (!isPlain(env)) {
      env = {};
      for (const [k, v] of Object.entries(base)) if (v != null && !HOST_VARS.test(k)) env[k] = v;
    }
    return {
      // A tool call's input arrives as it is written, not one finished argument at a time: a widget draws while
      // Claude is still writing it instead of appearing all at once (the API's fine-grained tool streaming, which
      // Claude Code turns on by this name). A value the user set themselves, off included, is left alone.
      ...(widgetsMod.createWidgetServer && !widgetsMod.WIDGETS_MISSING && env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING === undefined && { CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1' }),
      ...env,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: `canopy/${this.appVersion}`,
    };
  }

  evalTrust(env) {
    try {
      if (this.trusted === true) return { trusted: true };
      if (this.trusted === false) return { trusted: false, risky: trustMod.projectRisk?.(this.cwd) ?? null };
      // trust.mjs did not load: nothing can be checked, so the folder counts as trusted and the chat says part of the
      // engine is missing (CORE_DEGRADED).
      if (!trustMod.folderTrustSync) return { trusted: true };
      let accepted = [];
      try { accepted = this.trustedFolders() ?? []; } catch { /* no host list: Claude Code's own trust still counts */ }
      const t = trustMod.folderTrustSync(this.cwd, env, { accepted });
      if (t.trusted || !t.risky?.any) return { trusted: true };
      // Claude Code keeps trust per folder of its own, so the account's folder may not have heard yet.
      let own = null;
      try { own = this.trustEnv?.() ?? null; } catch { /* only the chat's own folder counts then */ }
      if (isPlain(own) && (own.CLAUDE_CONFIG_DIR || '') !== (env.CLAUDE_CONFIG_DIR || '') && trustMod.folderTrustSync(this.cwd, own, { accepted }).trusted) return { trusted: true };
      return { trusted: false, risky: t.risky };
    } catch (err) {
      // A trust check that breaks must not silently load an unknown folder's hooks.
      this.log('error', 'trust check failed', { error: errText(err) });
      return { trusted: false, risky: null };
    }
  }

  userPrefs(env) { try { return envMod.readUserPrefsSync?.(env) ?? {}; } catch { return {}; } }

  // Claude Code's own folder for this chat's environment. Undefined when env.mjs cannot say (memory.mjs then uses its default).
  configHome(env) { try { return envMod.configHome?.(env) ?? undefined; } catch { return undefined; } }

  // Tell a host observer something. Observers never break a session.
  tell(fn, ...args) { if (!fn) return; try { fn(...args); } catch (err) { this.log('warn', 'observer failed', { error: errText(err) }); } }

  startMode(restricted) {
    const chosen = this.mode ?? this.settings.permissionMode;
    if (!restricted) return this.modeAllowed(chosen) ? chosen : undefined;
    // Untrusted folder: never inherit an escalating default; only a mode the user picked here survives.
    if (SAFE_START_MODES.has(chosen)) return chosen;
    if (this.modeExplicit && chosen !== 'bypassPermissions' && this.modeAllowed(chosen)) return chosen;
    return 'default';
  }

  // The list of skills Claude is shown in every request gets the room a 200k-context chat gives it (SKILL_BUDGET_CHARS),
  // also on a 1M-context model, where Claude Code would otherwise give it five times that: every skill is still
  // listed, only long descriptions are shortened, as on a standard model. That is about 7,000 tokens less in every
  // request of a 1M chat with a few plugins installed. A size the user, their admin or the project chose is left
  // alone, and a chat whose settings cannot be checked gets Claude Code's own.
  skillBudget(env, sources) {
    let chosen = true;
    try { chosen = envMod.skillBudgetChosen?.(env, this.cwd, { sources }) !== false; } catch { /* unknown: leave it */ }
    return chosen || !envMod.SKILL_BUDGET_CHARS ? env : { ...env, [envMod.SKILL_BUDGET_VAR]: String(envMod.SKILL_BUDGET_CHARS) };
  }

  // What Canopy adds to Claude Code's system prompt: the facts about Canopy (facts.mjs), the same in every chat, then
  // what is remembered (memory.mjs): your home memory, which follows you into every folder, the index of Canopy
  // Memory's notes about you and this project, and what Codex has learned about you. They are read when the chat
  // first starts and kept for as long as the chat is open: a memory saved meanwhile, by this chat or another, would
  // otherwise change the prompt at the next restart of the process, and Claude would re-read the whole conversation
  // at full price (a note saved in this chat is in the conversation already, and recall finds any other). Nothing
  // about the moment (a date, a count, a setting) ever goes in here, for the same reason.
  // It is read from the folder this chat's Claude Code uses, never from this process's own environment: the shell
  // may set CLAUDE_CONFIG_DIR where an app started from the Dock has none, and an account can have a folder of its own.
  promptAppend(env) {
    if (this.memo === undefined) {
      const home = env?.HOME || undefined;
      const shared = this.memoryStore && memoryMod.RECALL_TOOL;
      // A chat opened again within the hour (it was let go for sitting idle, or Canopy was restarted) is told what
      // it was told before, word for word, whatever was saved since: the memory keeps that text (memory-store.mjs).
      const kept = shared && this.sessionId ? this.memoryStore.told(this.sessionId) : undefined;
      this.memo = kept !== undefined ? kept || null : [
        this.personalMemory !== false && personalMemoryNote(this.cwd, { home, configDir: this.configHome(env) }),
        shared && canopyMemoryNote({ store: this.memoryStore, cwd: this.cwd, recallName: memoryMod.RECALL_TOOL, forgetName: memoryMod.FORGET_TOOL }),
        shared && this.memoryBridge && codexMemoryNote(this.cwd, { home, codexHome: env?.CODEX_HOME || undefined }),
      ].filter(Boolean).join('\n\n') || null;
      this.keepMemo();
    }
    const facts = this.kit && pluginMod.KIT_NOTE ? `${CANOPY_FACTS}\n- ${pluginMod.KIT_NOTE}` : CANOPY_FACTS;
    return this.memo ? `${facts}\n\n${this.memo}` : facts;
  }

  // What this chat was told of memory is kept under its id for an hour past its last turn (see promptAppend): said
  // again when the chat gets its id, changes it, and at the end of every turn.
  keepMemo() {
    if (this.memoryStore && this.memo !== undefined && this.sessionId) this.memoryStore.tell(this.sessionId, this.memo ?? '');
  }

  buildOptions(env, restricted, risky, run) {
    const s = this.settings;
    const prefs = this.userPrefs(env);
    const flags = {};
    if (typeof s.fast === 'boolean') flags.fastMode = s.fast;
    if (s.ultracode) flags.ultracode = true;
    if (typeof s.agent === 'string' && s.agent) flags.agent = s.agent;
    if (typeof s.outputStyle === 'string' && s.outputStyle) flags.outputStyle = s.outputStyle;
    // Messages between the user's chats (Claude Code's SendMessage) are left to Claude Code's own rule, on purpose:
    // one is delivered when both chats ask before acting, or both run without asking, and is held when they differ.
    // Setting crossSessionInbound to 'accept' here would deliver every one of them, and a chat that runs without
    // asking would then act on whatever a chat that has just read a web page sends it. A held message is said in the
    // chat (adapter.mjs peerHold); a user who wants them all delivered can say so in their own Claude Code settings.
    const display = THINKING.has(s.thinking) ? s.thinking : prefs.showThinking === false ? 'omitted' : 'summarized';
    const extraArgs = {};
    if (display !== 'off' && !this.droppedFlags.has('thinking-display')) extraArgs['thinking-display'] = display;
    let sources = this.settingSources ?? ['user', 'project', 'local'];
    if (restricted) sources = sources.filter((x) => x === 'user');
    // The prompt cache is left to Claude Code, as in the terminal (five minutes). An hour costs 2x the input price on
    // every token written instead of 1.25x and only pays when a chat is left for 5 to 60 minutes: measured Nov 19 2026
    // it cost up to 17% more than the terminal on continuous work, and any rule that switches a chat to an hour later
    // loses on the chats that stop right after the switch. Canopy is cheaper by sending less instead (skillBudget).
    env = this.skillBudget(env, sources);
    // Code Mode is registered at launch so its tool is there for the first turn, and every later process of the
    // chat registers the same (see toolsFixed). Whether this Claude Code can run it is only known once it has
    // started: syncCodeMode takes it away again if not.
    const code = s.codeMode === true && !this.codeWhyNot(run);
    run.codeServing = code;
    const servers = this.servers(run, code);
    // An edit left a cut: this start loads the conversation only up to it, and Claude Code checks what that drops
    // when it was told (see edit()). It stays in force over restarts until the edited message has started.
    const cut = this.cut?.at && isUuid(this.sessionId) ? this.cut : null;
    run.cut = !!cut;
    const dirs = Array.isArray(s.additionalDirectories) ? s.additionalDirectories.filter((d) => typeof d === 'string' && d.startsWith('/')) : [];
    const opt = {
      pathToClaudeCodeExecutable: this.claudePath,
      cwd: this.cwd,
      env,
      resume: isUuid(this.sessionId) ? this.sessionId : undefined,
      resumeSessionAt: cut?.at,
      resumeDropsTurn: cut?.dropsTurn || undefined,
      model: s.model || undefined,
      permissionMode: this.startMode(restricted),
      allowDangerouslySkipPermissions: (this.allowBypass === true && !restricted) || undefined,
      effort: s.effort || undefined,
      settings: Object.keys(flags).length ? flags : undefined,
      includePartialMessages: true,
      settingSources: sources,
      strictMcpConfig: this.strictMcpConfig ?? ((restricted && risky?.mcpJson && prefs.enableAllProjectMcp) || undefined),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.promptAppend(env) },
      mcpServers: Object.keys(servers).length ? servers : undefined,
      // Canopy's skills are available in untrusted folders too: they belong to the app, not the project.
      plugins: ((list) => (list.length ? list : undefined))(pluginMod.claudePlugins?.(this.plugin, this.kit) ?? []),
      canUseTool: (name, inp, ctx) => this.broker(name, inp, ctx),
      hooks: { Stop: [{ hooks: [(input) => this.onStop(run, input)] }] },
      spawnClaudeCodeProcess: (o) => this.spawnChild(o, run),
      enableFileCheckpointing: this.checkpoints,
      includeHookEvents: !this.droppedFlags.has('include-hook-events') || undefined,
      forwardSubagentText: true,
      promptSuggestions: s.suggestions !== false,
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      thinking: display === 'off' ? { type: 'disabled' } : undefined,
      extraArgs: Object.keys(extraArgs).length ? extraArgs : undefined,
      fallbackModel: s.fallbackModel || undefined,
      maxBudgetUsd: typeof s.maxBudgetUsd === 'number' ? s.maxBudgetUsd : undefined,
      maxTurns: Number.isInteger(s.maxTurns) ? s.maxTurns : undefined,
      additionalDirectories: dirs.length ? dirs : undefined,
      title: this.sessionId ? undefined : this.title,
      agentProgressSummaries: this.ext.has('tasks') || undefined,
      perTaskStopAffordance: this.ext.has('task-stop') || undefined,
      onElicitation: this.ext.has('elicitation') ? (req, o) => this.elicit(req, o) : undefined,
    };
    for (const k of Object.keys(opt)) if (opt[k] === undefined) delete opt[k];
    return opt;
  }

  // Canopy owns the child: the SDK does not read stderr of a custom spawn, and stop/dispose need the exit.
  spawnChild(o, run) {
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const proc = { child, pid: child.pid ?? null, exit: null };
    proc.exited = new Promise((res) => {
      child.once('exit', (code, signal) => { proc.exit = { code, signal }; res(proc.exit); });
      // Only a failed spawn counts as "gone" here. An abort also raises `error`, but that child is still exiting.
      child.on('error', (error) => { if (child.pid == null && !proc.exit) { proc.exit = { code: null, signal: null, failed: true, error }; res(proc.exit); } });
    });
    proc.stderrClosed = new Promise((res) => { child.once('error', res); if (child.stderr) child.stderr.once('close', res); else res(); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => { run.stderr = (run.stderr + d).slice(-8000); }); // must drain, or a chatty child blocks
    child.stdin?.on('error', () => {}); // EPIPE after a crash is reported through the exit path
    run.proc = proc;
    // Canopy's own control requests (a Code Mode script's tool calls) share these pipes with the SDK, which is
    // handed the child with our answers taken out of its stdout: see control-channel.mjs.
    if (!channelMod.controlChannel || !child.stdout || !child.stdin) return child;
    run.control = channelMod.controlChannel(child);
    return run.control.process;
  }

  ensureStarted() {
    if (this.q) return;
    if (this.closed) throw coded('closed', 'This session was closed.');
    this.clearTimer('restart'); this.clearTimer('warm');
    if (!dirExists(this.cwd)) throw coded('cwd-missing', `This folder no longer exists: ${this.cwd}`, { recoverable: false });
    if (!this.claudePath) throw coded('not-installed', 'Claude Code was not found. Install it, or check that `claude` is on your PATH.', { recoverable: false });
    const env = this.resolveEnv();
    this.lastEnv = env; this.redactor = null;
    const trust = this.evalTrust(env);
    const restricted = !trust.trusted;
    const run = {
      gen: ++this.gen, q: null, input: null, proc: null, stderr: '', startedAt: Date.now(), ready: false,
      sawInit: false, startup: null, hasStateEvents: false, sawLifecycle: false, inputDead: false, coldSend: null,
      caps: new Set(), control: null, code: null, codeServing: false, widgets: null,
      turns: 0, turnErrorShown: false, lastResult: null, lastFrameAt: Date.now(), stallPinged: false, meta: null, adapter: null,
    };
    const adapterOpts = {
      debug: this.debug, toolStream: this.ext.has('tool-stream'), verbose: this.ext.has('info'),
      inputStream: (name) => this.streamsInput(name),
      unknown: this.onDrift ? (label, keys) => { try { this.onDrift(label, keys); } catch { /* observers never break a session */ } } : undefined,
    };
    const made = adapterMod.createAdapter?.(adapterOpts);
    run.adapter = made?.adapt ? made : { adapt: (m) => adapterMod.adapt(m, adapterOpts) };
    const input = new InputQueue({ onClose: (why) => { if (why === 'return') run.inputDead = true; } });
    run.input = input;
    let q;
    try { q = this.queryFn({ prompt: input, options: this.buildOptions(env, restricted, trust.risky, run) }); }
    catch (err) { input.close('start-failed'); throw err; }
    run.q = q;
    this.run = run; this.q = q; this.input = input;
    this.restricted = restricted; this.risky = restricted ? trust.risky ?? null : null;
    this.cliState = null;
    this.lifecycle = 'starting';
    if (this.gen > 1) this.restarts += 1;
    if (CORE_DEGRADED.length) this.noticeOnce('core-degraded', { level: 'warn', code: 'core-degraded', missing: CORE_DEGRADED.slice(), text: 'Canopy is running with part of its engine missing. Restart the app to finish the update.' });
    if (restricted) {
      this.noticeOnce('trust-required', {
        level: 'warn', code: 'trust-required', cwd: this.cwd, risky: this.risky,
        text: 'This folder is not trusted yet, so its project settings, hooks, MCP servers and CLAUDE.md are not loaded. Open it once in the terminal view and accept the trust prompt, or open it as a project in Canopy.',
      });
    }
    this.pump(run);
    this.ensureMeta(run);
    this.armStallWatch(run);
  }

  startFailed(err, { warm = false } = {}) {
    const c = err?.canopy ?? classify(err, { cwd: this.cwd, cwdExists: dirExists(this.cwd), sawInit: false });
    const code = c.code === 'unknown' || c.code === 'crashed' ? 'launch-failed' : c.code;
    const detail = this.redact(c.message || errText(err));
    const message = `Claude Code could not start: ${detail}`;
    this.lifecycle = 'failed';
    const prompts = this.outbox.closeAll('failed').map((e) => ({ id: e.id, text: e.text }));
    const changed = this.dropBusy();
    if (warm && !prompts.length) this.event({ kind: 'notice', level: 'warn', code, text: message });
    else this.event({ kind: 'error', code, message, recoverable: c.recoverable !== false && code !== 'launch-failed', prompts });
    this.announceIdle(changed);
    return { ok: false, code, message };
  }

  // Metadata for dropdowns and autocomplete, once per process. Also the start watchdog.
  ensureMeta(run) {
    if (!run) return Promise.resolve(null);
    run.meta ??= (async () => {
      const q = run.q;
      const current = () => this.run === run;
      const slow = setTimeout(() => {
        if (current() && !run.ready) this.event({ kind: 'notice', level: 'warn', code: 'slow-start', text: 'Claude Code is taking a long time to start (hooks or MCP servers?).', stderr: this.redact(run.stderr.slice(-1500)) });
      }, TIMEOUTS.slowStart);
      slow.unref?.();
      let r = null;
      try {
        if (q.initializationResult) r = await withTimeout(q.initializationResult(), TIMEOUTS.init, 'initialize');
      } catch (err) {
        if (err?.code !== 'timeout') return null; // the process is ending; the supervisor reports why
        if (current() && !run.sawInit) { this.startTimedOut(run); return null; }
      } finally { clearTimeout(slow); }
      if (!current()) return null;
      const ask = (fn) => (q[fn] ? withTimeout(q[fn](), TIMEOUTS.meta, fn).catch(() => null) : Promise.resolve(null));
      const [commands, models] = await Promise.all([r?.commands ?? ask('supportedCommands'), r?.models ?? ask('supportedModels')]);
      if (!current()) return null;
      this.markReady(run);
      for (const c of r?.capabilities ?? []) { this.caps.add(c); run.caps.add(c); }
      if (r?.current_permission_mode) this.rememberMode(r.current_permission_mode);
      const acct = r?.account;
      const meta = {
        commands, models, mode: r?.current_permission_mode ?? this.mode ?? null, sessionId: this.sessionId,
        fastState: r?.fast_mode_state ?? null, fastReason: r?.fast_mode_disabled_reason ?? null,
        agents: r?.agents ?? null, outputStyle: r?.output_style ?? null, outputStyles: r?.available_output_styles ?? null,
        capabilities: r?.capabilities ?? (this.caps.size ? [...this.caps] : null), version: r?.claude_code_version ?? null,
        account: acct ? { email: acct.email ?? null, org: acct.organization ?? null, plan: acct.subscriptionType ?? null, provider: acct.apiProvider ?? null, keySource: acct.apiKeySource ?? acct.tokenSource ?? null } : null,
        startupMs: run.readyAt - run.startedAt, restricted: this.restricted, apiKeySource: acct?.apiKeySource ?? null,
        codeBlocked: this.codeWhyNot(run),
      };
      if (Array.isArray(commands)) this.lastCommandsSig = JSON.stringify(commands);
      this.lastMeta = { ...(this.lastMeta ?? {}), ...meta, kind: 'meta', commands: commands ?? this.lastMeta?.commands ?? null, models: models ?? this.lastMeta?.models ?? null };
      this.event({ kind: 'meta', ...meta });
      // Which login this process really came up on, for the host to hold against the one it meant to use.
      if (acct) this.tell(this.onAccount, { ...meta.account, apiKeySource: acct.apiKeySource ?? null, tokenSource: acct.tokenSource ?? null }, this.accountId);
      this.apiKeyNotice(acct?.apiKeySource);
      this.fire(this.syncCodeMode(run));
      // Read-only identity metadata, asynchronously: a slow MCP server must never hold up the chat.
      this.fire(this.mcpStatus().then((mcp) => {
        if (!current()) return;
        this.lastMeta = { ...this.lastMeta, mcp };
        this.event({ kind: 'meta', mcp });
      }));
      return meta;
    })().catch((err) => { this.log('error', 'meta failed', { error: errText(err) }); return null; });
    return run.meta;
  }

  markReady(run) {
    if (run.ready) return;
    run.ready = true; run.readyAt = Date.now();
    if (this.run === run && this.lifecycle === 'starting') this.lifecycle = 'ready';
  }

  // No answer to initialize for two minutes: restart once, then report it.
  startTimedOut(run) {
    const stderr = this.redact(run.stderr.slice(-1500));
    this.detach(); this.hold();
    const again = !this.startRetried;
    this.startRetried = true;
    if (again) this.requeueUnstarted({ count: false });
    else {
      this.lifecycle = 'failed';
      const prompts = this.outbox.closeAll('failed').map((e) => ({ id: e.id, text: e.text }));
      if (this.turnInFlight()) this.syntheticTurnEnd({ subtype: 'crashed', isError: true, interrupted: false, errors: ['Claude Code did not start in time.'] });
      const changed = this.dropBusy();
      this.event({ kind: 'error', code: 'timeout', message: 'Claude Code did not start in time. Check your hooks and MCP servers, then send a message to try again.', recoverable: true, stderr, prompts });
      this.announceIdle(changed);
    }
    this.event({ kind: 'stopped', sessionId: this.sessionId, reason: again ? 'exit' : 'failed', willRestart: again });
    this.reap(run, 0).finally(() => this.release(again));
  }

  // What a chat says about the login it runs on. A host that names accounts says it in its own words, once per
  // chat, when the chat's first turn starts (`turnStarts`): a chat that is opened and never used says nothing.
  // Without such a host, the first chat of a run that Claude Code reports as billed to an API key says so.
  apiKeyNotice(source, turnStarts = false) {
    if (this.accountNotice) {
      if (!turnStarts || this.noticed.has('account')) return;
      this.noticed.add('account');
      let text = null;
      try { text = this.accountNotice({ apiKeySource: source ?? null }, this.accountId); }
      catch (err) { this.log('warn', 'observer failed', { error: errText(err) }); }
      if (typeof text === 'string' && text) this.event({ kind: 'notice', code: 'account', text });
      return;
    }
    if (apiKeyNoticeShown || (source !== 'ANTHROPIC_API_KEY' && source !== 'apiKeyHelper')) return;
    apiKeyNoticeShown = true;
    this.event({ kind: 'notice', code: 'api-key-billing', text: 'This conversation is billed to an API key, not your Claude plan.' });
  }

  publishMeta(patch) {
    this.lastMeta = { ...(this.lastMeta ?? {}), ...patch, kind: 'meta' };
    this.event({ kind: 'meta', ...patch });
  }

  adoptSessionId(id) {
    if (typeof id !== 'string' || !id || id === this.sessionId) return;
    const previous = this.sessionId ?? this.lostSessionId;
    this.sessionId = id;
    this.lostSessionId = null;
    if (this.lastMeta) this.lastMeta.sessionId = id;
    // `supersedes`: the new conversation replaces the old one (its first message was edited), unlike after /clear.
    if (previous) this.event({ kind: 'meta', sessionId: id, previousSessionId: previous, ...(this.superseded === previous && { supersedes: previous }) });
    this.superseded = null;
    this.keepMemo();
  }

  commandsChanged(commands) {
    const sig = JSON.stringify(commands ?? null);
    if (sig === this.lastCommandsSig) return false;
    this.lastCommandsSig = sig;
    if (this.lastMeta) this.lastMeta.commands = commands;
    this.event({ kind: 'commands-changed', commands });
    return true;
  }

  // ---- the frame pump ----

  async pump(run) {
    let err = null;
    try {
      for await (const m of run.q) {
        if (this.run !== run) break;
        try { this.onFrame(m, run); }
        catch (e) { this.event({ kind: 'raw', label: 'adapter-error', raw: { error: errText(e), type: m?.type, subtype: m?.subtype } }); }
      }
    } catch (e) { err = e; }
    await this.onProcessEnd(run, err).catch((e) => this.log('error', 'supervisor failed', { error: errText(e) }));
  }

  onFrame(m, run) {
    if (!m || typeof m !== 'object') return;
    run.lastFrameAt = Date.now(); run.stallPinged = false;
    this.steps.observe(m);
    const sys = m.type === 'system' ? m.subtype : null;

    if (sys === 'session_state_changed') {
      this.adoptSessionId(m.session_id);
      run.hasStateEvents = true; this.cliState = m.state;
      if (m.state === 'idle') this.onIdle(); else this.setBusy(true, m.state);
      return;
    }
    if (sys === 'background_tasks_changed') {
      this.bg = (m.tasks ?? []).filter((t) => !t.ambient).map(toBg);
      this.emitTasks();
      this.syncBusy();
      return;
    }
    if (m.type === 'command_lifecycle') {
      this.adoptSessionId(m.session_id);
      this.onLifecycle(m, run);
      return;
    }
    // A start that carried an edit's cut and failed before any turn: the cut was refused (see cutRefused).
    if (m.type === 'result' && m.is_error && m.num_turns === 0 && !run.sawInit && run.cut && this.cut) { this.cutRefused(run, m); return; }
    // Startup failures are held back and explained by the supervisor once the process has ended.
    if (m.type === 'result' && m.is_error && m.num_turns === 0 && !run.sawInit && !this.turnOpen && !run.startupReleased) {
      run.startup = { reason: m.startup_failure_reason ?? null, text: (m.errors ?? []).join('; ') };
      // The process normally exits right after. If it lives on, this was an ordinary failed turn: show it.
      this.setTimer('startup', 3000, () => {
        if (this.run !== run) return;
        run.startup = null; run.startupReleased = true;
        this.onFrame(m, run);
      });
      return;
    }
    if (m.type === 'conversation_reset') { this.resetConversation(); this.notes.clear(); } // `/clear`: nothing is left for a note to be about
    if (sys === 'init') this.onInit(m, run);
    else if (sys === 'status') {
      if (m.permissionMode) this.rememberMode(m.permissionMode);
      for (const id of m.user_message_uuids ?? []) this.markStarted(id);
    } else if (sys === 'compact_boundary') {
      const post = m.compact_metadata?.post_tokens;
      if (typeof post === 'number') this.contextTokens = post;
      this.ctxCache = null;
    } else if (sys && sys.startsWith('task_')) this.onTask(m);
    else if (sys && sys.startsWith('hook_') && !this.hookVisible(m)) return;
    else if (sys === 'commands_changed') { this.commandsChanged(m.commands); return; }
    else if (m.type === 'rate_limit_event') {
      this.rateLimit = rateLimitOf(m.rate_limit_info);
      this.tell(this.onRateLimit, { ...this.rateLimit }, this.accountId);
    } else if ((m.type === 'assistant' || m.type === 'stream_event') && !m.parent_tool_use_id) {
      // Top-level model output only: a background subagent can talk while the main loop is idle.
      this.turnOpen = true;
      this.syncBusy();
      if (!this.firstDeltaAt) { this.firstDeltaAt = Date.now(); this.outbox.dropPayloads(); }
      if (m.type === 'assistant') {
        const u = m.message?.usage;
        if (u && m.message?.model !== '<synthetic>') {
          this.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        }
        this.lastApiError = m.error ?? null;
      }
    } else if (m.type === 'prompt_suggestion') this.suggestionShown = !!(m.suggestion ?? m.text);
    else if (m.type === 'result') this.onResult(m, run);

    const events = run.adapter.adapt(m) ?? [];
    for (const ev of events) {
      if (ev.kind === 'turn-end') this.finishTurn(ev, m, run);
      else if (ev.kind === 'init' && !run.initSent) { run.initSent = true; ev.first = true; }
      this.event(ev);
    }
    if (m.type === 'conversation_reset' && !events.some((ev) => ev.code === 'conversation-reset')) {
      this.event({ kind: 'notice', code: 'conversation-reset', reset: true, trigger: m.trigger ?? null, at: Date.parse(m.timestamp ?? '') || Date.now(), text: 'Conversation cleared' });
    }
    if (m.type === 'result') this.afterResult(m, run);
  }

  onInit(m, run) {
    this.adoptSessionId(m.session_id);
    run.sawInit = true;
    this.turnOpen = true;
    this.syncBusy();
    this.markReady(run);
    if (m.permissionMode) this.rememberMode(m.permissionMode);
    if (m.model) this.model = m.model;
    for (const c of m.capabilities ?? []) { this.caps.add(c); run.caps.add(c); }
    const ids = m.user_message_uuids ?? [];
    for (const id of ids) this.markStarted(id);
    // A CLI without command lifecycle frames: the turn that starts is the oldest send it was given.
    if (!ids.length && !run.sawLifecycle) {
      const next = this.outbox.all().find((e) => e.state === 'written' || e.state === 'queued');
      if (next) this.markStarted(next.id);
    }
    if (!run.hasStateEvents) this.setBusy(true, 'running');
    this.apiKeyNotice(m.apiKeySource, true);
  }

  onLifecycle(m, run) {
    run.sawLifecycle = true;
    const id = m.command_uuid;
    const e = this.outbox.get(id);
    if (!e) return;
    if (m.state === 'queued') this.outbox.mark(id, 'queued');
    else if (m.state === 'started') this.markStarted(id);
    else if (m.state === 'completed') this.outbox.mark(id, 'completed');
    // `cancelled` closes a started command whose turn was interrupted, and withdraws one that never ran.
    else if (m.state === 'cancelled') { if (e.state === 'started') this.outbox.mark(id, 'completed'); else this.cancelEntry(id); }
  }

  markStarted(id) {
    const e = this.outbox.get(id);
    if (!e || e.state === 'started') return;
    this.turnSendAt ??= e.at;
    this.outbox.mark(id, 'started');
  }

  onResult(m, run) {
    this.adoptSessionId(m.session_id);
    run.turns += 1;
    run.lastResult = m;
    run.turnErrorShown = !!m.is_error || (m.subtype && m.subtype !== 'success');
    if (!run.turnErrorShown) this.budget.reset();
    const ids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
    for (const id of ids) this.outbox.mark(id, 'completed');
    if (!ids.length && !run.sawLifecycle) for (const e of this.outbox.started()) this.outbox.mark(e.id, 'completed');
  }

  // Fill in what only the session knows about the turn that just ended.
  finishTurn(ev, m, run) {
    if (!Array.isArray(ev.errors)) ev.errors = ev.errors == null ? [] : [String(ev.errors)];
    if (ev.interrupted === undefined) {
      const reason = m.terminal_reason;
      ev.interrupted = reason ? ABORTED.has(reason) : !!(this.stopRequested && ev.isError);
    }
    if (ev.interrupted) { ev.isError = false; ev.errors = []; }
    else ev.errors = ev.errors.filter((e) => !String(e).startsWith('[ede_diagnostic]'));
    if (ev.turnCost === undefined) {
      const per = m.model_usage_since_last_result;
      ev.turnCost = isPlain(per) ? Object.values(per).reduce((n, u) => n + (u?.costUSD ?? 0), 0) : null;
    }
    if (ev.userUuids === undefined) ev.userUuids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
    if (ev.sessionId === undefined) ev.sessionId = this.sessionId;
    const local = ev.localCommand ?? m.local_command ?? null;
    ev.contextTokens = local === 'clear' ? 0 : this.contextTokens;
    ev.contextWindow = m.modelUsage?.[this.model]?.contextWindow ?? Object.values(m.modelUsage ?? {}).find((u) => u?.contextWindow)?.contextWindow ?? null;
    ev.sendToFirstDeltaMs = this.turnSendAt && this.firstDeltaAt ? Math.max(0, this.firstDeltaAt - this.turnSendAt) : null;
    ev.coldStart = run.turns === 1 && run.coldSend === true;
    if (ev.isError && !ev.interrupted) {
      const refined = API_ERROR_CODES[this.lastApiError];
      if (refined) ev.errorCode = refined;
      else if (ev.errorCode === undefined) ev.errorCode = null;
      if (ev.errorCode === 'rate-limit' && this.rateLimit?.resetsAt) ev.resetsAt = this.rateLimit.resetsAt;
    } else if (ev.errorCode === undefined) ev.errorCode = null;
    if (ev.isError || ev.interrupted) this.clearSuggestion();
    this.closeTurn();
  }

  closeTurn() {
    this.covered.clear(); this.steps.reset();
    this.turnOpen = false;
    this.stopRequested = false;
    this.turnSendAt = null; this.firstDeltaAt = null;
    this.lastApiError = null;
    this.ctxCache = null;
  }

  afterResult(m, run) {
    this.syncBusy();
    if (run.hasStateEvents) return;
    // No session state frames from this CLI: a result with nothing queued behind it means idle.
    if (m.queued_turn_count > 0) return;
    if (this.outbox.unstarted().length) { this.armAckWatch(); return; }
    this.setBusy(false, 'idle');
  }

  syntheticTurnEnd(fields) {
    this.event({
      kind: 'turn-end', text: '', errors: [], synthetic: true, sessionId: this.sessionId, contextTokens: this.contextTokens, errorCode: null,
      ...(this.turnSendAt && { durationMs: Date.now() - this.turnSendAt }), ...fields,
    });
    this.closeTurn();
  }

  turnInFlight() { return this.turnOpen || this.outbox.started().length > 0; }

  resetConversation() {
    this.rejectAllPending('The conversation was cleared.');
    try { this.run?.adapter?.reset?.(); } catch { /* optional */ }
    this.turn = [];
    this.tasks.clear(); this.bg = [];
    this.contextTokens = null; this.ctxCache = null;
    this.rateLimit = null; this.lastApiError = null;
    this.emitTasks();
  }

  // Without the `hooks` feature only session-level hooks and failures are shown.
  hookVisible(m) {
    if (this.ext.has('hooks')) return true;
    const event = m.hook_event ?? m.hook_event_name;
    if (event === 'SessionStart' || event === 'Setup') return true;
    return m.subtype === 'hook_response' && ((m.outcome != null && m.outcome !== 'success') || (m.exit_code != null && m.exit_code !== 0));
  }

  // ---- tasks ----

  onTask(m) {
    const id = m.task_id;
    if (!id) return;
    const t = this.tasks.get(id) ?? { taskId: id, status: 'running', startedAt: Date.now() };
    if (m.run_id) t.runId = m.run_id;
    if (m.tool_use_id) t.toolUseId = m.tool_use_id;
    if (m.subagent_type) t.agentType = m.subagent_type;
    if (m.task_type) t.taskType = m.task_type;
    if (m.parent_task_id) t.parentTaskId = m.parent_task_id;
    // The name is what the task was started as; later frames carry what it's doing now (kept as `activity`).
    if (typeof m.description === 'string' && m.description) {
      if (m.subtype === 'task_progress' && t.description) t.activity = m.description;
      else if (m.subtype !== 'task_progress' || !t.description) t.description ??= m.description;
    }
    if (m.ambient || m.skip_transcript) t.ambient = true;
    switch (m.subtype) {
      case 'task_started':
        t.status = 'running'; t.backgrounded = !!m.is_backgrounded; t.workflow = m.workflow_name ?? null;
        break;
      case 'task_progress':
        if (m.usage) t.usage = m.usage;
        if (m.last_tool_name) t.lastTool = m.last_tool_name;
        if (m.summary) t.summary = m.summary;
        break;
      case 'task_updated': {
        const p = m.patch ?? {};
        if (p.status) t.status = p.status;
        if (p.description) t.description = p.description;
        if (p.end_time) t.endedAt = p.end_time;
        if (p.error) t.error = p.error;
        if (typeof p.is_backgrounded === 'boolean') t.backgrounded = p.is_backgrounded;
        break;
      }
      case 'task_notification':
        t.status = m.status ?? 'completed'; t.endedAt ??= Date.now();
        if (m.summary) t.summary = m.summary;
        if (m.usage) t.usage = m.usage;
        if (m.output_file) t.outputFile = m.output_file;
        break;
      default: return;
    }
    this.tasks.delete(id); this.tasks.set(id, t); // most recently touched last
    if (this.tasks.size > TASKS_MAX) {
      for (const [k, v] of this.tasks) { if (this.tasks.size <= TASKS_MAX) break; if (v.status !== 'running' && v.status !== 'pending') this.tasks.delete(k); }
    }
    this.emitTasks();
    this.syncBusy();
  }

  /** Busy only because background work is running: no turn, send or question is waiting on anyone. */
  onlyBackground() { return this.busy && !this.turnInFlight() && !this.pending.size && !this.outbox.unstarted().length && this.backgroundWork(); }

  /** Workflows, agents or background commands still running in this chat. */
  backgroundWork() { return [...this.tasks.values()].some((t) => !t.ambient && (t.status === 'running' || t.status === 'pending')); }

  taskList() { return [...this.tasks.values()].filter((t) => !t.ambient).map((t) => ({ ...t })); }

  emitTasks() {
    if (!this.ext.has('tasks')) return;
    this.event({ kind: 'tasks', tasks: this.taskList(), background: this.bg.slice() });
  }

  // ---- stopping ----

  detach() {
    const run = this.run;
    this.run = null; this.q = null; this.input = null;
    for (const t of ['stop', 'ack', 'startup']) this.clearTimer(t);
    if (run?.stallTimer) clearInterval(run.stallTimer);
    try { run?.code?.stopAll(); } catch { /* no script outlives its process */ }
    this.cliState = null;
    return run;
  }

  killProc(proc, signal = 'SIGKILL') {
    if (!proc?.child || proc.exit) return;
    try { proc.child.kill(signal); } catch { /* already gone */ }
  }

  // Close the query and make sure the child is gone: graceful first, SIGKILL after graceMs. Resolves to whether it exited.
  async reap(run, graceMs = 3000) {
    try { run.input?.close('shutdown'); } catch { /* closed */ }
    try { run.q?.close?.(); } catch { /* closed */ }
    const proc = run.proc;
    if (!proc) return true;
    if (proc.exit) return true;
    if (graceMs > 0 && (await Promise.race([proc.exited.then(() => true), sleep(graceMs).then(() => false)]))) return true;
    this.killProc(proc);
    return Promise.race([proc.exited.then(() => true), sleep(2000).then(() => false)]);
  }

  async doStop(graceMs) {
    const run = this.run;
    this.hold();
    try {
      if (!run) {
        this.lifecycle = this.parked ? 'parked' : this.lifecycle === 'new' ? 'new' : 'stopped';
        this.cancelUnstarted(); this.announceCancelled();
        if (this.busy) this.setBusy(false, 'idle');
        return { ok: true, exited: true };
      }
      if ((this.busy || this.turnOpen) && run.q?.interrupt) {
        this.stopRequested = true;
        try {
          await withTimeout(run.q.interrupt({ cancelQueued: true }), TIMEOUTS.stopInterrupt, 'interrupt');
          if (this.run === run && this.turnInFlight()) await this.waitTurnClosed(1500); // let the real interrupted turn-end arrive
        } catch { /* closed below either way */ }
      }
      if (this.run === run) this.detach();
      this.rejectAllPending('Session stopped.');
      if (this.turnInFlight()) this.syntheticTurnEnd({ subtype: 'stopped', isError: false, interrupted: true });
      for (const e of this.outbox.started()) this.outbox.mark(e.id, 'completed');
      this.cancelUnstarted(); this.announceCancelled();
      this.lifecycle = this.parked ? 'parked' : 'stopped';
      this.setBusy(false, 'idle');
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: this.parked ? 'parked' : 'stop', willRestart: false });
      const exited = await this.reap(run, graceMs);
      return { ok: true, exited };
    } catch (err) {
      this.log('error', 'stop failed', { error: errText(err) });
      if (run) this.killProc(run.proc);
      return { ok: true, exited: !run?.proc || !!run.proc.exit };
    } finally { this.release(false); }
  }

  waitTurnClosed(ms) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (!this.turnInFlight() || Date.now() - started >= ms) return resolve();
        const t = setTimeout(tick, 20); t.unref?.();
      };
      tick();
    });
  }

  // Stop did not work (or was pressed twice): kill the process and start a clean one on the same conversation.
  async forceStop(text, { responsive = true } = {}) {
    const run = this.detach();
    this.stopRequested = false;
    this.hold();
    try {
      this.rejectAllPending('Interrupted by the user.', { interrupt: true });
      if (run) {
        try { run.input?.close('force-stop'); } catch { /* closed */ }
        try { run.q?.close?.(); } catch { /* closed */ }
      }
      if (this.turnInFlight()) this.syntheticTurnEnd({ subtype: 'stopped', isError: false, interrupted: true });
      for (const e of this.outbox.started()) this.outbox.mark(e.id, 'completed');
      this.cancelUnstarted();
      const cancelled = this.announceCancelled();
      this.event({ kind: 'notice', code: 'force-stop', text });
      this.setBusy(false, 'idle');
      this.lifecycle = 'stopped';
      const willRestart = !this.closed && !this.parked && !this.hostStopped;
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'force-stop', willRestart });
      if (run) await this.reap(run, responsive ? 300 : 0);
      return { ok: true, forced: true, cancelled, stillQueued: [] };
    } catch (err) {
      this.log('error', 'force stop failed', { error: errText(err) });
      if (run) this.killProc(run.proc);
      return { ok: true, forced: true, cancelled: [], stillQueued: [] };
    } finally { this.release(true); }
  }

  // Restart an idle process so start-time options (trust, thinking, limits) take effect. Never mid-turn.
  async recycle(why) {
    if (this.closed || this.parked) return false;
    const run = this.run;
    if (!run) return false;
    if (this.busy || this.pending.size) { this.restartWhenIdle = why; return false; }
    this.restartWhenIdle = null;
    this.detach(); this.hold();
    try {
      this.lifecycle = 'stopped';
      this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'restart', willRestart: true, why });
      await this.reap(run, 3000);
    } catch (err) { this.log('error', 'recycle failed', { error: errText(err) }); }
    finally { this.release('always'); }
    return true;
  }

  // ---- supervisor ----

  // While held, nothing starts a process: one conversation never has two writers.
  hold() { this.holds += 1; }

  // start: true = restart if automatic restarts are on; 'always' = the process was recycled on purpose.
  release(start = false) {
    if (start) this.wantStart = this.wantStart === 'always' ? 'always' : start;
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds) return;
    for (const w of this.holdWaiters.splice(0)) w();
    const want = this.wantStart;
    this.wantStart = false;
    if (this.closed || this.parked || this.hostStopped) return;
    if (this.outbox.pending().length || want === 'always' || (want && this.autoRestart)) this.startNow();
  }

  settled() { return this.holds ? new Promise((r) => this.holdWaiters.push(r)) : Promise.resolve(); }

  startNow() {
    if (this.closed || this.parked || this.hostStopped || this.holds) return;
    if (!this.q) { try { this.ensureStarted(); } catch (err) { this.startFailed(err); return; } }
    this.flush();
  }

  async onProcessEnd(run, err) {
    try { run.input.close('process-end'); } catch { /* closed */ }
    if (this.run !== run) return; // detached: whoever detached it owns the cleanup
    const wasBusy = this.busy;
    this.detach(); this.hold();
    let start = false;
    try {
      const proc = run.proc;
      if (proc) await Promise.race([proc.stderrClosed, sleep(150)]);
      this.fire(this.reap(run, 3000));
      const exit = proc?.exit ?? (proc ? await Promise.race([proc.exited, sleep(150).then(() => null)]) : null);
      this.rejectAllPending('Claude Code stopped.');
      if (this.closed) return;
      const c = classify(err, {
        stderr: run.stderr, startup: run.startup, sawInit: run.sawInit, cwd: this.cwd, cwdExists: dirExists(this.cwd),
        hadSessionId: !!this.sessionId, lastApiError: this.lastApiError, lastResult: run.lastResult, clean: err == null,
        wasBusy, pendingSends: this.outbox.size, turnErrorShown: run.turnErrorShown, optionalFlags: OPTIONAL_FLAGS,
        exitCode: exit?.code ?? null, signal: exit?.signal ?? null,
      });
      c.message = this.redact(c.message);
      this.log(c.silent ? 'info' : 'warn', 'claude process ended', { code: c.code, exitCode: c.exitCode, signal: c.signal, gen: run.gen });
      if (Date.now() - run.startedAt > STABLE_RUN_MS) this.budget.reset();
      start = await this.recover(run, c);
    } finally { this.release(start); }
  }

  // Decide what happens after the process ended. Returns true when a restart should follow at once.
  async recover(run, c) {
    const stderr = this.redact(run.stderr.slice(-1500));
    if (c.retry === 'fresh' && !this.resumeLost) {
      this.resumeLost = true;
      this.lostSessionId = this.sessionId; this.sessionId = null;
      if (this.lastMeta) this.lastMeta.sessionId = null;
      this.notes.clear(); // the new conversation remembers nothing a note could set right
      this.event({ kind: 'notice', level: 'warn', code: 'resume-missing', text: 'That chat is no longer on disk, so Canopy started a new one.' });
      this.reopenSends();
      return this.restartSoon(0);
    }
    if (c.retry === 'drop-flag' && c.flag && !this.droppedFlags.has(c.flag)) {
      this.droppedFlags.add(c.flag);
      this.reopenSends();
      return this.restartSoon(0);
    }
    // Claude Code won't open a chat that a background session of its own still holds. If that session has finished
    // (only its entry is left), the host clears it and the chat opens; one that is really running is left alone.
    if (c.code === 'session-busy' && this.freeBackground && this.sessionId && !this.triedFree) {
      this.triedFree = true;
      let freed = false;
      try { freed = !!(await this.freeBackground(this.sessionId)); } catch { /* left as is */ }
      if (freed) { this.reopenSends(); return this.restartSoon(0); }
    }
    if (c.retry === 'refind' && !this.refound) {
      this.refound = true;
      let found = null;
      try { found = await envMod.findClaude?.(this.lastEnv ?? process.env); } catch { /* not found */ }
      if (found && found !== this.claudePath) { this.claudePath = found; this.reopenSends(); return this.restartSoon(0); }
    }
    if (c.retry !== 'restart') return this.failHard(run, c, stderr);

    const inFlight = this.turnInFlight();
    const lost = this.outbox.started().map((e) => { this.outbox.mark(e.id, 'lost'); return { id: e.id, text: e.text }; });
    const undelivered = this.outbox.requeue(MAX_SEND_ATTEMPTS);
    const deliverable = () => this.outbox.pending().filter((e) => !undelivered.includes(e));
    const wanted = !this.closed && !this.parked && !this.hostStopped && (this.autoRestart || deliverable().length > 0);
    if (!wanted) undelivered.push(...deliverable());
    const allowed = wanted && this.budget.allow();
    if (wanted && !allowed) return this.crashLoop(stderr, inFlight, c);
    const delayMs = allowed ? backoffMs(this.budget.attempt) : null;
    const redeliver = allowed && deliverable().length > 0;
    const changed = redeliver ? false : this.dropBusy();
    if (inFlight) this.syntheticTurnEnd({ subtype: 'crashed', isError: true, interrupted: false, errors: [c.message] });
    if (inFlight && !c.silent) {
      this.event({
        kind: 'error', code: 'turn-lost', cause: c.code, recoverable: true,
        message: `${c.message} Your conversation is saved. Send a message to continue.`,
        prompt: lost[0] ?? null, prompts: lost, exitCode: c.exitCode, signal: c.signal, stderr,
        attempt: this.budget.attempt, willRetryInMs: delayMs,
      });
    } else if (!c.silent && allowed) {
      this.event({ kind: 'notice', code: 'restarting', text: 'Claude Code stopped unexpectedly and was restarted.' });
    }
    this.failSends(undelivered);
    this.lifecycle = 'stopped';
    this.event({ kind: 'stopped', sessionId: this.sessionId, reason: inFlight ? 'crash' : 'exit', willRestart: !!allowed });
    this.announceIdle(changed);
    if (allowed) this.setTimer('restart', delayMs, () => this.startNow());
    return false;
  }

  failSends(entries) {
    for (const e of entries) {
      this.outbox.mark(e.id, 'failed');
      this.event({ kind: 'error', code: 'send-failed', message: 'A message could not be delivered to Claude Code. Send it again.', recoverable: true, prompt: { id: e.id, text: e.text } });
    }
  }

  // A restart that provably ran nothing (bad resume id, rejected flag): every open send goes back to pending.
  reopenSends() {
    for (const e of this.outbox.all()) if (!this.outbox.reopen(e.id)) this.outbox.mark(e.id, 'lost');
    this.turnOpen = false;
  }

  restartSoon(delayMs) {
    if (this.closed || this.parked || this.hostStopped) return false;
    if (!this.budget.allow()) return this.crashLoop('', false, null);
    if (delayMs > 0) { this.setTimer('restart', delayMs, () => this.startNow()); return false; }
    return true;
  }

  crashLoop(stderr, inFlight, c) {
    const prompts = this.outbox.closeAll('failed').map((e) => ({ id: e.id, text: e.text }));
    this.lifecycle = 'failed';
    const changed = this.dropBusy();
    if (inFlight) this.syntheticTurnEnd({ subtype: 'crashed', isError: true, interrupted: false, errors: [c?.message ?? 'Claude Code stopped.'] });
    this.event({ kind: 'error', code: 'crash-loop', recoverable: true, message: 'Claude Code keeps stopping. Send a message to try again.', stderr, prompts });
    this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'failed', willRestart: false });
    this.announceIdle(changed);
    return false;
  }

  failHard(run, c, stderr) {
    const inFlight = this.turnInFlight();
    const prompts = this.outbox.closeAll('failed').map((e) => ({ id: e.id, text: e.text }));
    this.lifecycle = 'failed';
    const changed = this.dropBusy();
    if (inFlight) this.syntheticTurnEnd({ subtype: 'crashed', isError: true, interrupted: false, errors: [c.message] });
    this.event({
      kind: 'error', code: c.code, message: c.message, recoverable: false, prompts, stderr,
      exitCode: c.exitCode, signal: c.signal, ...(run.startup?.reason && { startupFailure: run.startup.reason }),
    });
    this.event({ kind: 'stopped', sessionId: this.sessionId, reason: 'failed', willRestart: false });
    this.announceIdle(changed);
    return false;
  }

  // Busy but silent for two minutes: check that the process still answers. Never kills a running turn.
  armStallWatch(run) {
    const every = Math.min(15000, Math.max(1000, Math.floor(TIMEOUTS.stall / 8)));
    const t = setInterval(async () => {
      if (this.run !== run) return clearInterval(t);
      if (!this.busy || this.state === 'requires_action' || this.pending.size || run.stallPinged) return;
      if (Date.now() - run.lastFrameAt < TIMEOUTS.stall) return;
      run.stallPinged = true;
      try {
        if (!run.q.mcpServerStatus) return;
        await withTimeout(run.q.mcpServerStatus(), TIMEOUTS.ping, 'ping');
      } catch {
        if (this.run === run && this.busy) this.event({ kind: 'notice', level: 'warn', code: 'stalled', text: 'Claude Code is not responding. Press Stop to restart it.' });
      }
    }, every);
    t.unref?.();
    run.stallTimer = t;
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

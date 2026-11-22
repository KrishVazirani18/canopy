// A scripted stand-in for the `codex app-server --listen stdio://` child, for unit tests. No Codex is started.
//
//   const fake = createFakeCodex({ ...knobs });
//   new CodexSession({ spawnFn: fake.spawnFn, ... })     // or CodexProcess, CodexService
//
// Each spawn gives a fake child (stdin, stdout, stderr, pid, kill, 'exit') that speaks the app-server's wire the way
// the recorded fixtures show it: no "jsonrpc" field, its own request ids counted from 0, `thread/started` after the
// thread/start answer, the settings echo before the turn/start answer, `idle` just before turn/completed.
//
// By default it answers initialize, account/read, config/read, model/list (the recorded list), thread/start, thread/resume,
// turn/start, turn/steer, turn/interrupt, thread/settings/update, thread/turns/list, thread/revert, thread/list,
// thread/read, thread/name/set and thread/archive, and plays a one-word text turn for every turn/start. It also plays
// Codex's own browser sign-in (account/login/start with `type: "chatgpt"`, account/login/cancel) and account/logout:
// a sign-in waits until the test ends it with child.finishLogin(), and nobody is signed in or out of anything real.
//
// It also answers the calls behind the slash commands and the limits, none of which is in a recording (they follow
// the 0.153.4 protocol types): thread/compact/start (a turn of its own with a compaction item, see `compaction`),
// review/start (a turn that enters and leaves review mode and says `review`), thread/goal/set, get and clear (with
// the `thread/goal/updated` and `thread/goal/cleared` lines), account/rateLimits/read (refused under an API key and
// on a provider named at launch, as the real one does), thread/unsubscribe and skills/extraRoots/set (kept as
// fake.skillRoots; 0.169.0 answers {}).
//
// Knobs, all changeable while a test runs (fake.<name> = …):
//   hang          Set of methods that are never answered
//   errors        { method: { code, message, once } | (params, child) => that | null }
//   handlers      { method: (params, child, id) => result | undefined }   undefined falls through to the default
//   holdTurns     a turn starts and then waits: the test ends it (child.playText(), child.completeTurn(), child.die())
//   script        (child, turn) => void   replaces everything after the turn/start answer, turn/started included
//   ignoreInterrupt, ignoreEof, ignoreTerm      the child does not react to Stop, to its input closing, to SIGTERM
//   spawnThrows / spawnError                    the launch fails at once / the way a missing binary does
//   threadId / threadIds, turnIds     the ids it hands out (a replayed recording needs the recorded ones)
//   known                             chats that are "on disk": thread/resume of any other says "no rollout found"
//   turnsOf, listRunning, threads, names      what thread/turns/list, thread/list and thread/read give back
//   reverts                           every thread/revert that was carried out: { threadId, beforeTurnId, dropped }
//   models, modelPageSize, account, mcp, resumeUsage, reply, version
//   codexHome                         the folder a child says it keeps its login in (default: its CODEX_HOME, else /Users/test/.codex)
//   requiresAuth                      what account/read says about needing an OpenAI sign-in (false: a provider of the user's own)
//   loginIds, authUrl                 the ids a sign-in is given, and the address of its page (a string, or (loginId) => string)
//   loginEnds                         a sign-in ends by itself right after its start is answered: { success, error, account }
//   configModel, configEffort, configTier     the user's own Codex settings, reported when a call chooses nothing
//   configSandbox                     the user's own [sandbox_workspace_write] (config/read gives it, and a thread
//                                     opened in workspace-write comes up with it); null when they have none
//   providerOf                        { threadId: provider } for chats "on disk": the model provider each began on
//
// Model providers, as a real app-server was seen to treat them (0.169.0, in a throwaway home with made-up keys):
// a child started with `-c model_provider="x"` (and `-c model_providers.x={…}`) runs on x, says nobody is signed in
// and that no OpenAI sign-in is needed, and has no plan limits to read. A chat stays on the provider it began on:
// resumed where that provider is not set up it is refused (`modelProviderNotConfigured`), asked to change provider it
// is refused, and resumed with nothing said it comes up on its own provider whatever the child runs on. thread/list
// gives the child's own provider's chats unless `modelProviders` says otherwise (an empty list: every provider's).
//   configNote                        the user's own developer_instructions (config/read gives it); null when none
//   configMcp                         the user's own [mcp_servers] (config/read gives it); left out when none
//   compaction                        how thread/compact/start reports its work: 'turn' (a turn of its own, the
//                                     default), 'line' (only the compaction item, no turn) or 'silent' (nothing)
//   review                            the text a review ends with
//   goals                             { threadId: goal } as thread/goal/* keeps them
//   rateLimits                        the snapshot account/rateLimits/read gives a ChatGPT login; null: it is refused
//
// Every line a child was sent is in child.received (and fake.received across children). Nothing here touches disk
// except reading a fixture.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

/** A recorded session as [{ t, dir: 'in' | 'out' | 'note', msg }]. */
export function fixtureLines(name) {
  return fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** What a recorded session answered to the first call of `method`. */
export function recordedResult(name, method) {
  const lines = fixtureLines(name);
  const asked = lines.find((l) => l.dir === 'out' && l.msg.method === method);
  return asked ? lines.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id)?.msg.result ?? null : null;
}

/** The thread and turn a recorded live session ran, for a fake that replays it. */
export function recordedIds(name) {
  const lines = fixtureLines(name);
  const started = lines.find((l) => l.dir === 'in' && l.msg.method === 'turn/started')?.msg.params;
  return { threadId: started?.threadId ?? null, turnId: started?.turn?.id ?? null };
}

let recorded = null;
export const recordedModels = () => (recorded ??= recordedResult('codex-meta', 'model/list')?.data ?? []);

const SANDBOX = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  'danger-full-access': { type: 'dangerFullAccess' },
};
const NOW_S = 1794801559;
let nextPid = 61000;
let nextThread = 1;

const turnOf = (id, status, extra = {}) => ({ id, items: [], itemsView: 'notLoaded', status, error: null, startedAt: NOW_S, completedAt: null, durationMs: null, ...extra });

class FakeChild extends EventEmitter {
  constructor(fake, command, args, options) {
    super();
    this.fake = fake;
    this.command = command; this.args = args; this.options = options;
    this.pid = nextPid++;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.received = [];
    this.exited = null;       // { code, signal } once gone
    this.signals = [];
    this.buf = '';
    this.requestId = 0;       // the server counts its own request ids from 0, so they overlap with the client's
    this.answers = new Map(); // server request id -> resolve
    this.threadId = null;
    this.loaded = false;
    this.settings = null;
    this.turn = null;         // { id, params, inputs }
    this.turnSeq = 0;
    this.login = null;        // the id of the sign-in waiting on the browser, if one is
    // The model provider this child runs on, and the ones it knows: OpenAI's own, and any named on its command line.
    const flags = (Array.isArray(args) ? args : []).filter((a, i) => typeof a === 'string' && args[i - 1] === '-c');
    this.provider = flags.map((f) => f.match(/^model_provider="([^"]+)"$/)?.[1]).find(Boolean) ?? 'openai';
    this.providers = new Set(['openai', ...flags.map((f) => f.match(/^model_providers\.([A-Za-z0-9_-]+)=/)?.[1]).filter(Boolean)]);
    this.threadProvider = null;
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => { this.input(chunk); cb(); },
      final: (cb) => { cb(); if (!fake.ignoreEof) this.exit(0, null); },
    });
  }

  // ---- what tests call ----

  /** Write one line to the client, as the app-server would. */
  send(msg) { if (!this.exited) this.stdout.write(`${JSON.stringify(msg)}\n`); }
  /** Write raw text: half a line, garbage, several lines at once. */
  raw(text) { if (!this.exited) this.stdout.write(text); }
  note(method, params) { this.send({ method, params, emittedAtMs: Date.now() }); }
  /** Ask the client something (an approval, a question). Resolves with the client's whole answer line. */
  ask(method, params) {
    const id = this.requestId++;
    const answer = new Promise((resolve) => this.answers.set(id, resolve));
    this.send({ method, id, params });
    return { id, answer };
  }
  sent(method) { return this.received.filter((m) => m.method === method); }
  die(code = 1, signal = null) { this.exit(code, signal); }

  /**
   * End the sign-in that is waiting, the way Codex does when the browser comes back: `account/login/completed`,
   * and `account/updated` when it worked. From then on account/read answers with `account` (a ChatGPT plan by default).
   */
  finishLogin({ success = true, error = null, account } = {}) {
    const loginId = this.login;
    if (!loginId) return;
    this.login = null;
    if (success) this.fake.account = account ?? { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' };
    this.note('account/login/completed', { loginId, success, error: success ? null : error ?? 'Login was not completed' });
    if (success) this.note('account/updated', { authMode: 'chatgpt', planType: this.fake.account.planType ?? null });
  }

  /** Say the turn started, the way a real turn does right after its turn/start answer. */
  startTurn() {
    const turn = this.turn;
    if (!turn) return;
    this.note('thread/status/changed', { threadId: this.threadId, status: { type: 'active', activeFlags: [] } });
    this.note('turn/started', { threadId: this.threadId, turn: turnOf(turn.id, 'inProgress') });
  }

  userItem(input) {
    const turn = this.turn;
    if (input === turn.params.input) turn.echoed = true;
    const item = { type: 'userMessage', id: `user-${this.pid}-${++this.turnSeq}`, clientId: null, content: input };
    this.note('item/started', { item, threadId: this.threadId, turnId: turn.id, startedAtMs: Date.now() });
    this.note('item/completed', { item, threadId: this.threadId, turnId: turn.id, completedAtMs: Date.now() });
    turn.items.push(item);
  }

  /** Stream a reply. With `open` the text item is left streaming (what a stopped turn looks like). */
  streamText(text = 'OK', { open = false, pieces } = {}) {
    const turn = this.turn;
    if (!turn) return null;
    const id = `msg_${this.pid}_${++this.turnSeq}`;
    const item = { type: 'agentMessage', id, text: '', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
    this.note('item/started', { item, threadId: this.threadId, turnId: turn.id, startedAtMs: Date.now() });
    for (const delta of pieces ?? [text]) this.note('item/agentMessage/delta', { threadId: this.threadId, turnId: turn.id, itemId: id, delta });
    if (!open) {
      const done = { ...item, text };
      this.note('item/completed', { item: done, threadId: this.threadId, turnId: turn.id, completedAtMs: Date.now() });
      turn.items.push(done);
      turn.final = done;
    }
    return id;
  }

  usage(total = 21800, window = 258400) {
    const u = { totalTokens: total, inputTokens: total - 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 };
    this.note('thread/tokenUsage/updated', { threadId: this.threadId, turnId: this.turn?.id ?? null, tokenUsage: { total: u, last: u, modelContextWindow: window } });
  }

  /** The whole default turn: the user's message echoed, a reply, token counts, the end. */
  playText(text = 'OK') {
    const turn = this.turn;
    if (!turn) return;
    if (!turn.echoed) this.userItem(turn.params.input);
    this.streamText(text);
    this.usage();
    this.completeTurn();
  }

  /** The compaction item, started and finished, the way a real compaction reports it. */
  compactionItem(turnId = this.turn?.id ?? null) {
    const item = { type: 'contextCompaction', id: `compact-${this.pid}-${++this.turnSeq}` };
    this.note('item/started', { item, threadId: this.threadId, turnId, startedAtMs: Date.now() });
    this.note('item/completed', { item, threadId: this.threadId, turnId, completedAtMs: Date.now() });
  }

  /** A review, from entering review mode to leaving it with what it found. */
  playReview(text = this.fake.review) {
    const turn = this.turn;
    if (!turn) return;
    const entered = { type: 'enteredReviewMode', id: `review-${this.pid}-${++this.turnSeq}`, review: 'current changes' };
    this.note('item/started', { item: entered, threadId: this.threadId, turnId: turn.id, startedAtMs: Date.now() });
    this.note('item/completed', { item: entered, threadId: this.threadId, turnId: turn.id, completedAtMs: Date.now() });
    const exited = { type: 'exitedReviewMode', id: `review-${this.pid}-${++this.turnSeq}`, review: text };
    this.note('item/started', { item: exited, threadId: this.threadId, turnId: turn.id, startedAtMs: Date.now() });
    this.note('item/completed', { item: exited, threadId: this.threadId, turnId: turn.id, completedAtMs: Date.now() });
    this.usage();
    this.completeTurn();
  }

  goalOf(threadId) { return this.fake.goals[threadId] ?? null; }

  completeTurn(status = 'completed', { error = null } = {}) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    const done = turnOf(turn.id, status, {
      items: status === 'completed' && turn.final ? [turn.final] : [], itemsView: status === 'completed' ? 'summary' : 'notLoaded',
      error, completedAt: NOW_S + 3, durationMs: 3000,
    });
    // What history gives back later: after a stop, only the user's message of that turn survives.
    const saved = { ...done, items: status === 'interrupted' ? turn.items.filter((i) => i.type === 'userMessage') : turn.items.slice(), itemsView: 'full' };
    (this.fake.turnsOf[this.threadId] ??= []).push(saved);
    this.note('thread/status/changed', { threadId: this.threadId, status: { type: 'idle' } });
    this.note('turn/completed', { threadId: this.threadId, turn: done });
  }

  /**
   * Play a recorded session's lines from the app-server, from after its `turn/start` on. A request the recording
   * made of the client (an approval) is made again here, and the lines after it wait for the client's answer.
   */
  async replay(name, { after = 'turn/start' } = {}) {
    const lines = fixtureLines(name);
    const from = lines.findIndex((l) => l.dir === 'out' && l.msg.method === after);
    for (const l of lines.slice(from + 1)) {
      if (this.exited) return;
      if (l.dir !== 'in' || typeof l.msg.method !== 'string') continue; // answers to the recorder's own calls
      if (l.msg.id === undefined) { this.send(l.msg); continue; }
      const answer = new Promise((resolve) => this.answers.set(l.msg.id, resolve));
      this.send(l.msg);
      await answer;
    }
    if (this.turn) { (this.fake.turnsOf[this.threadId] ??= []).push(turnOf(this.turn.id, 'completed', { items: [], itemsView: 'full' })); this.turn = null; }
  }

  // ---- the child process surface ----

  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    if (this.exited) return false;
    if (signal === 'SIGKILL' || !this.fake.ignoreTerm) this.exit(null, signal);
    return true;
  }

  exit(code, signal) {
    if (this.exited) return;
    this.exited = { code, signal };
    for (const resolve of this.answers.values()) resolve(null);
    this.answers.clear();
    // After the lines already written, as a real exit follows the last output.
    setImmediate(() => {
      this.stdout.end(); this.stderr.end();
      this.emit('exit', code, signal);
    });
  }

  // ---- the server ----

  input(chunk) {
    this.buf += chunk.toString('utf8');
    let at;
    while ((at = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.received.push(msg);
      this.fake.received.push(msg);
      if (this.exited) continue;
      if (typeof msg.method === 'string') { if (msg.id !== undefined) this.handle(msg); }
      else { const resolve = this.answers.get(msg.id); this.answers.delete(msg.id); resolve?.(msg); }
    }
  }

  echoSettings() {
    this.note('thread/settings/updated', { threadId: this.threadId, threadSettings: { ...this.settings, activePermissionProfile: null, modelProvider: this.threadProvider ?? 'openai', summary: 'auto', multiAgentMode: 'explicitRequestOnly', personality: 'pragmatic' } });
  }

  applySettings(p) {
    const s = this.settings;
    for (const k of ['approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'model', 'effort']) if (p[k] != null) s[k] = p[k];
    if ('serviceTier' in p) s.serviceTier = p.serviceTier ?? 'default';
    if (p.collaborationMode) {
      s.collaborationMode = p.collaborationMode;
      // A collaboration mode carries its own model and effort, and they win.
      if (p.collaborationMode.settings?.model) s.model = p.collaborationMode.settings.model;
      // Null there clears the effort, as the real app-server does (probed on 0.153.4): it does not mean "leave it".
      if (p.collaborationMode.settings && 'reasoning_effort' in p.collaborationMode.settings) s.effort = p.collaborationMode.settings.reasoning_effort ?? null;
    }
  }

  openThread(id, params, resumed) {
    const fake = this.fake;
    // A new chat begins on the provider this child runs on; a saved one stays on the one it began on.
    const provider = resumed ? fake.providerOf[id] ?? 'openai' : this.provider;
    fake.providerOf[id] = provider;
    this.threadProvider = provider;
    const cwd = params.cwd ?? '/tmp/fake';
    const model = params.model ?? fake.configModel;
    const serviceTier = 'serviceTier' in params ? params.serviceTier ?? 'default' : fake.configTier;
    const own = fake.configSandbox;
    const word = params.sandbox ?? 'workspace-write';
    // The word is filled in from the user's own config, which is where their network access and extra folders live.
    const sandbox = word === 'workspace-write' && own
      ? { type: 'workspaceWrite', writableRoots: own.writable_roots ?? [], networkAccess: own.network_access === true, excludeTmpdirEnvVar: own.exclude_tmpdir_env_var === true, excludeSlashTmp: own.exclude_slash_tmp === true }
      : SANDBOX[word];
    const thread = {
      id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null, preview: resumed ? 'earlier' : '', ephemeral: false,
      historyMode: 'paginated', modelProvider: provider, model, reasoningEffort: fake.configEffort, createdAt: NOW_S, updatedAt: NOW_S, recencyAt: NOW_S,
      status: { type: 'idle' }, path: `/Users/test/.codex/sessions/rollout-${id}.jsonl`, cwd, cliVersion: fake.version, source: 'vscode',
      gitInfo: null, name: fake.names[id] ?? null, turns: [],
    };
    this.threadId = id;
    this.loaded = true;
    this.settings = {
      cwd, approvalPolicy: params.approvalPolicy ?? 'on-request', approvalsReviewer: params.approvalsReviewer ?? 'user', sandboxPolicy: sandbox,
      model, serviceTier, effort: fake.configEffort, collaborationMode: { mode: 'default', settings: { model, reasoning_effort: fake.configEffort, developer_instructions: null } },
    };
    return {
      thread, model, modelProvider: provider, serviceTier, cwd, runtimeWorkspaceRoots: [cwd], instructionSources: [],
      approvalPolicy: this.settings.approvalPolicy, approvalsReviewer: this.settings.approvalsReviewer, sandbox, activePermissionProfile: null,
      reasoningEffort: fake.configEffort, multiAgentMode: 'explicitRequestOnly',
    };
  }

  handle(msg) {
    const fake = this.fake;
    const { id, method } = msg;
    const params = msg.params ?? {};
    if (fake.silent || fake.hang.has(method)) return;
    const ok = (result) => this.send({ id, result });
    const no = (message, code = -32600, data) => this.send({ error: { code, message, ...(data !== undefined && { data }) }, id });
    const own = this.provider === 'openai'; // on Codex's own login, not on a provider named at launch
    let err = fake.errors[method];
    if (typeof err === 'function') err = err(params, this);
    if (err) {
      if (err.once) delete fake.errors[method];
      return no(err.message ?? 'refused', err.code ?? -32600);
    }
    const custom = fake.handlers[method];
    if (typeof custom === 'function') {
      const result = custom(params, this, id);
      if (result !== undefined) return ok(result);
    }
    switch (method) {
      case 'initialize':
        ok({ userAgent: `canopy/${fake.version} (Mac OS 26.0.0; arm64) fake (canopy; ${params.clientInfo?.version ?? '?'})`, codexHome: this.options?.env?.CODEX_HOME || fake.codexHome || '/Users/test/.codex', platformFamily: 'unix', platformOs: 'macos' });
        return this.note('remoteControl/status/changed', { status: 'disabled', serverName: 'Mac', installationId: '00000000-0000-0000-0000-000000000000', environmentId: null });
      // On a provider named at launch Codex's own login is not in play: nobody is signed in, and nobody needs to be.
      case 'account/read': return own ? ok({ account: fake.account, requiresOpenaiAuth: fake.requiresAuth }) : ok({ account: null, requiresOpenaiAuth: false });
      case 'config/read': return ok({ config: { model: fake.configModel, sandbox_mode: null, sandbox_workspace_write: fake.configSandbox ?? null, developer_instructions: fake.configNote ?? null, ...(fake.configMcp && { mcp_servers: fake.configMcp }) }, origins: {} });
      case 'model/list': {
        const all = fake.models.filter((m) => params.includeHidden || !m.hidden);
        if (!fake.modelPageSize) return ok({ data: all, nextCursor: null });
        const from = Number(params.cursor ?? 0);
        const next = from + fake.modelPageSize;
        return ok({ data: all.slice(from, next), nextCursor: next < all.length ? String(next) : null });
      }
      case 'thread/start': {
        const tid = fake.threadIds.shift() ?? fake.threadId ?? `0f000000-0000-7000-8000-${String(nextThread++).padStart(12, '0')}`;
        const result = this.openThread(tid, params, false);
        ok(result);
        this.note('thread/started', { thread: result.thread });
        for (const [name, status, error] of fake.mcp) this.note('mcpServer/startupStatus/updated', { threadId: tid, name, status, error: error ?? null, failureReason: null });
        return;
      }
      case 'thread/resume': {
        if (!fake.known.has(params.threadId)) return no(`no rollout found for thread id ${params.threadId}`);
        const began = fake.providerOf[params.threadId] ?? 'openai';
        if (!this.providers.has(began)) return no(`This chat uses model provider “${began}”, which is no longer configured. Restore this provider’s configuration to continue.`, -32600, { type: 'modelProviderNotConfigured', modelProvider: began });
        if (typeof params.modelProvider === 'string' && params.modelProvider !== began) return no(`failed to load configuration: Cannot change this thread's model provider from \`${began}\` to \`${params.modelProvider}\` on resume.`);
        // A second thread opened on a process that already has one (an agent's, to follow its lines): the first stays
        // the thread this process runs its turns on.
        const mine = this.loaded && this.threadId && this.threadId !== params.threadId ? { threadId: this.threadId, settings: this.settings } : null;
        const result = this.openThread(params.threadId, params, true);
        if (mine) Object.assign(this, mine);
        this.note('thread/status/changed', { threadId: params.threadId, status: { type: 'idle' } });
        ok(result);
        if (fake.resumeUsage) {
          const u = { totalTokens: fake.resumeUsage, inputTokens: fake.resumeUsage - 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 };
          this.note('thread/tokenUsage/updated', { threadId: params.threadId, turnId: 'an-earlier-turn', tokenUsage: { total: u, last: u, modelContextWindow: 258400 } });
        }
        return this.note('thread/goal/cleared', { threadId: params.threadId });
      }
      case 'turn/start': {
        if (!this.loaded || params.threadId !== this.threadId) return no(`thread not loaded: ${params.threadId}`);
        this.applySettings(params);
        this.echoSettings();
        const turn = this.turn = { id: fake.turnIds.shift() ?? `turn-${this.pid}-${++this.turnSeq}`, params, inputs: [params.input], items: [], final: null };
        ok({ turn: turnOf(turn.id, 'inProgress', { startedAt: null }) });
        fake.known.add(this.threadId); // a chat is on disk once it has a turn
        if (typeof fake.script === 'function') { Promise.resolve().then(() => fake.script(this, turn)).catch((e) => { fake.scriptError = e; }); return; }
        this.startTurn();
        if (!fake.holdTurns) this.playText(fake.reply);
        return;
      }
      case 'turn/steer': {
        if (!this.turn || params.expectedTurnId !== this.turn.id) return no('no active turn to steer');
        this.turn.inputs.push(params.input);
        ok({ turnId: this.turn.id });
        if (!this.turn.echoed) this.userItem(this.turn.params.input); // the message the turn started with is always its first
        return this.userItem(params.input);
      }
      case 'turn/interrupt': {
        ok({});
        if (!fake.ignoreInterrupt && this.turn && params.turnId === this.turn.id) this.completeTurn('interrupted');
        return;
      }
      case 'thread/settings/update': {
        if (!this.loaded || params.threadId !== this.threadId) return no(`thread not loaded: ${params.threadId}`);
        this.applySettings(params);
        ok({});
        return this.echoSettings();
      }
      case 'thread/turns/list': {
        const saved = fake.turnsOf[params.threadId];
        if (!saved && !fake.known.has(params.threadId)) return no(`no rollout found for thread id ${params.threadId}`);
        const all = (saved ?? []).slice();
        // A turn still running is in the list only when the test says Codex lists it.
        if (fake.listRunning && this.turn && params.threadId === this.threadId) all.push(turnOf(this.turn.id, 'inProgress', { items: this.turn.items.slice(), itemsView: 'full' }));
        if (params.sortDirection !== 'asc') all.reverse();
        const from = Number(params.cursor ?? 0);
        const next = from + (params.limit ?? 50);
        // The light view (Codex's default) keeps a turn's first message and its last reply, nothing between: a
        // message steered into the turn is only in the full one (seen on 0.153.4).
        const view = (t) => (params.itemsView === 'full' ? t : {
          ...t, itemsView: 'summary',
          items: [t.items.find((i) => i.type === 'userMessage'), t.items.findLast((i) => i.type === 'agentMessage')].filter(Boolean),
        });
        return ok({ data: all.slice(from, next).map(view), nextCursor: next < all.length ? String(next) : null });
      }
      case 'thread/revert': {
        // The turn `beforeTurnId` and every later one leave the saved chat (seen on 0.153.4): a turn still running
        // is ended first, the thread is opened again from what is left, and `thread/reverted` says it happened.
        if (!this.loaded || params.threadId !== this.threadId) return no(`thread not found: ${params.threadId}`);
        if (this.turn) this.completeTurn('interrupted');
        const saved = fake.turnsOf[params.threadId] ?? [];
        const at = saved.findIndex((t) => t.id === params.beforeTurnId);
        if (at < 0) return no(`turn not found: ${params.beforeTurnId}`);
        fake.turnsOf[params.threadId] = saved.slice(0, at);
        fake.reverts.push({ threadId: params.threadId, beforeTurnId: params.beforeTurnId, dropped: saved.slice(at).map((t) => t.id) });
        this.note('thread/status/changed', { threadId: params.threadId, status: { type: 'notLoaded' } });
        this.note('thread/status/changed', { threadId: params.threadId, status: { type: 'idle' } });
        const result = this.openThread(params.threadId, { cwd: this.settings?.cwd }, true);
        ok({ thread: result.thread, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
        return this.note('thread/reverted', { threadId: params.threadId });
      }
      case 'thread/list': {
        const wanted = Array.isArray(params.modelProviders) ? params.modelProviders : [this.provider];
        const listed = wanted.length ? fake.threads.filter((t) => wanted.includes(t.modelProvider ?? 'openai')) : fake.threads;
        return ok({ data: listed.slice(0, params.limit ?? 100), nextCursor: null });
      }
      case 'thread/read': {
        const t = fake.threads.find((x) => x.id === params.threadId);
        return t ? ok({ thread: t }) : no(`thread not loaded: ${params.threadId}`);
      }
      case 'thread/name/set':
        fake.names[params.threadId] = params.name;
        ok({});
        return this.note('thread/name/updated', { threadId: params.threadId, threadName: params.name });
      case 'thread/archive':
        if (!fake.known.delete(params.threadId)) return no(`no rollout found for thread id ${params.threadId}`);
        return ok({});
      case 'account/login/start': {
        // Only Codex's own browser sign-in is played. A test that sees this refusal sent a kind Canopy must never send.
        if (params.type !== 'chatgpt') return no(`the fake plays no "${params.type}" sign-in`);
        const loginId = fake.loginIds.shift() ?? `login-${this.pid}-${++this.turnSeq}`;
        this.login = loginId;
        ok({ type: 'chatgpt', loginId, authUrl: typeof fake.authUrl === 'function' ? fake.authUrl(loginId) : fake.authUrl });
        if (fake.loginEnds) this.finishLogin(fake.loginEnds);
        return;
      }
      case 'account/login/cancel': {
        if (!this.login || this.login !== params.loginId) return ok({ status: 'notFound' });
        ok({ status: 'canceled' });
        return this.finishLogin({ success: false, error: 'Login was not completed' });
      }
      case 'account/logout':
        fake.account = null;
        ok({});
        return this.note('account/updated', { authMode: null, planType: null });
      case 'thread/compact/start': {
        if (!this.loaded || params.threadId !== this.threadId) return no(`thread not loaded: ${params.threadId}`);
        ok({});
        if (fake.compaction === 'silent') return;
        if (fake.compaction === 'line') return this.compactionItem(null);
        this.turn = { id: fake.turnIds.shift() ?? `turn-${this.pid}-${++this.turnSeq}`, params, inputs: [], items: [], final: null, echoed: true };
        this.startTurn();
        this.compactionItem();
        return this.completeTurn();
      }
      case 'review/start': {
        if (!this.loaded || params.threadId !== this.threadId) return no(`thread not loaded: ${params.threadId}`);
        const turn = this.turn = { id: fake.turnIds.shift() ?? `turn-${this.pid}-${++this.turnSeq}`, params, inputs: [], items: [], final: null, echoed: true };
        ok({ turn: turnOf(turn.id, 'inProgress', { startedAt: null }), reviewThreadId: this.threadId });
        this.startTurn();
        if (!fake.holdTurns) this.playReview();
        return;
      }
      case 'thread/goal/get': return ok({ goal: this.goalOf(params.threadId) });
      case 'thread/goal/set': {
        if (!fake.known.has(params.threadId)) return no(`thread not found: ${params.threadId}`);
        const had = this.goalOf(params.threadId);
        if (!had && !params.objective) return no('no goal is set for this thread');
        const goal = {
          threadId: params.threadId, objective: params.objective ?? had.objective, status: params.status ?? had?.status ?? 'active',
          tokenBudget: params.tokenBudget ?? had?.tokenBudget ?? null, tokensUsed: had?.tokensUsed ?? 0, timeUsedSeconds: had?.timeUsedSeconds ?? 0,
          createdAt: had?.createdAt ?? NOW_S, updatedAt: NOW_S,
        };
        fake.goals[params.threadId] = goal;
        ok({ goal });
        return this.note('thread/goal/updated', { threadId: params.threadId, turnId: null, goal });
      }
      case 'thread/goal/clear': {
        const cleared = !!this.goalOf(params.threadId);
        delete fake.goals[params.threadId];
        ok({ cleared });
        if (cleared) this.note('thread/goal/cleared', { threadId: params.threadId });
        return;
      }
      // Only a ChatGPT plan has limits to read, and only on Codex's own login (not on a provider named at launch):
      // anything else is refused, as the real app-server refuses it. With `rateLimits` null the plan's limits cannot
      // be read either, which is what a login OpenAI no longer accepts looks like.
      case 'account/rateLimits/read':
        if (!own || fake.account?.type !== 'chatgpt' || !fake.rateLimits) return no('chatgpt authentication required to read rate limits');
        return ok({ rateLimits: fake.rateLimits, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null });
      case 'thread/unsubscribe': return ok({ status: 'unsubscribed' });
      case 'skills/extraRoots/set': fake.skillRoots = Array.isArray(params.extraRoots) ? [...params.extraRoots] : []; return ok({});
      default: return no(`Method not found: ${method}`, -32601);
    }
  }
}

export function createFakeCodex(script = {}) {
  const fake = {
    children: [], spawns: [], received: [],
    version: '0.153.4',
    hang: new Set(), errors: {}, handlers: {},
    holdTurns: false, script: null, scriptError: null, reply: 'OK',
    ignoreInterrupt: false, ignoreEof: false, ignoreTerm: false, silent: false,
    spawnThrows: null, spawnError: null,
    threadId: null, threadIds: [], turnIds: [], known: new Set(), turnsOf: {}, threads: [], names: {}, listRunning: false, providerOf: {}, reverts: [],
    models: recordedModels(), modelPageSize: 0, account: { type: 'apiKey' }, mcp: [], resumeUsage: 0,
    requiresAuth: true, loginIds: [], loginEnds: null,
    // Shaped like the real one: the part after `?` is what must never reach a log or the window.
    authUrl: (loginId) => `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fake&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=STATE-${loginId}&code_challenge=CHALLENGE-${loginId}`,
    configModel: 'gpt-6.1-sol', configEffort: 'high', configTier: 'ultrafast', configSandbox: null,
    compaction: 'turn', review: 'No problems found.', goals: {},
    rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: NOW_S + 3600 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: NOW_S + 400000 }, credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null },
    ...script,
  };
  fake.hang = new Set(fake.hang);
  fake.known = new Set(fake.known);
  Object.defineProperty(fake, 'last', { get: () => fake.children.at(-1) ?? null });
  /** Every line of this kind sent to any child, oldest first. */
  fake.sent = (method) => fake.received.filter((m) => m.method === method);
  fake.alive = () => fake.children.filter((c) => !c.exited);
  fake.spawnFn = (command, args, options) => {
    fake.spawns.push({ command, args, options });
    if (fake.spawnThrows) throw fake.spawnThrows;
    const child = new FakeChild(fake, command, args, options);
    if (fake.spawnError) {
      // A binary that is not there: no pid, then 'error'. No 'exit' ever follows.
      const error = fake.spawnError;
      child.pid = undefined;
      child.exited = { code: null, signal: null };
      setImmediate(() => child.emit('error', error));
      return child;
    }
    fake.children.push(child);
    return child;
  };
  return fake;
}

// A scripted stand-in for the SDK's query(), used through Session's `queryFn`
// seam. It reads the same input iterable the real SDK reads and answers with
// the frames the real CLI sends, in the order recorded in fixtures/live-*.json
// (CLI 2.1.322), so Session's state machine can be exercised without claude.
//
//   const fake = createFake();
//   const s = new Session({ cwd, claudePath: '/bin/false', env: {}, queryFn: fake.queryFn });
//   s.send('hi');  // -> busy, init, text-delta, assistant-text, turn-end, busy:false
//
// By default every user message becomes one complete turn. A test can slow a
// turn down (`hold`), drive permission prompts (`ask`), kill the process
// (`die`, `end`), make a control request hang (`hang`) or push any frame by
// hand (`emit`).
import { randomUUID } from 'node:crypto';

export const CAPABILITIES = [
  'interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1', 'request_marker_lists_v1',
  'ask_user_question_unanswered_v1',
];

const MODEL = 'claude-haiku-fake';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

export class FakeRun {
  constructor({ prompt, options }, script) {
    this.prompt = prompt;
    this.options = options ?? {};
    this.script = script;
    this.sessionId = this.options.resume ?? randomUUID();
    this.capabilities = script.capabilities ?? CAPABILITIES;
    // Like the CLI, state events are only sent when the host asked for them.
    this.stateEvents = script.stateEvents ?? this.options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1';
    this.lifecycle = this.capabilities.includes('msg_lifecycle_v1');
    this.mode = this.options.permissionMode ?? 'default';
    this.calls = [];            // every control request: { method, args }
    this.received = [];         // user messages read from the input, in order
    this.queue = [];            // read but not started
    this.swallowed = [];        // read after the process died: written into a dead pipe
    this.announced = new Set(); // ids whose `queued` frame was already sent
    this.turns = 0;
    this.closed = false;
    this.inputEnded = false;
    this.state = 'idle';
    this.current = null;        // { msgs, aborted, gate }
    this.out = [];
    this.waiter = null;
    this.finished = null;       // { error } once the frame stream is over
    this.hung = new Set();
    this.holds = [];
    this.costTotal = 0;
    this.abort = new AbortController();
    this.asking = new Set();    // AbortControllers of permission requests in flight
    queueMicrotask(() => this.readInput());
  }

  // ---- the Query surface Session uses ----

  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.out.length) return Promise.resolve({ value: this.out.shift(), done: false });
    if (this.finished) return this.finished.error ? Promise.reject(this.finished.error) : Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  return() { this.finish(); return Promise.resolve({ value: undefined, done: true }); }
  throw(err) { this.finish(err); return Promise.reject(err); }

  close() {
    this.calls.push({ method: 'close', args: [] });
    this.closed = true;
    this.abort.abort();
    this.finish();
  }

  async control(method, args, fallback) {
    this.calls.push({ method, args });
    if (this.finished) throw new Error('Query closed before response received');
    if (this.hung.has(method) || this.hung.has('*')) return new Promise(() => {});
    const custom = this.script.controls?.[method];
    if (custom) return custom.apply(this, args);
    return fallback();
  }

  interrupt(opts) {
    return this.control('interrupt', [opts], () => {
      const cancelled = [];
      if (opts?.cancelQueued) {
        for (const m of this.queue.splice(0)) { cancelled.push(m.uuid); this.life(m.uuid, 'cancelled'); }
      }
      if (this.current) { this.current.aborted = true; this.current.gate.resolve(); }
      for (const ac of this.asking) ac.abort(); // the CLI withdraws a prompt it is no longer waiting on
      return this.capabilities.includes('interrupt_receipt_v1') ? { still_queued: this.queue.map((m) => m.uuid), cancelled } : undefined;
    });
  }
  setPermissionMode(mode) {
    return this.control('setPermissionMode', [mode], () => {
      if (mode === 'bypassPermissions' && !this.options.allowDangerouslySkipPermissions) throw new Error('Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions');
      this.mode = mode;
      this.emit({ type: 'system', subtype: 'status', status: null, permissionMode: mode });
    });
  }
  setModel(model) { return this.control('setModel', [model], () => {}); }
  applyFlagSettings(settings) { return this.control('applyFlagSettings', [settings], () => {}); }
  updateSettings(source, settings) { return this.control('updateSettings', [source, settings], () => {}); }
  setMaxThinkingTokens(n, display) { return this.control('setMaxThinkingTokens', [n, display], () => {}); }
  initializationResult() {
    return this.control('initializationResult', [], () => ({
      commands: [{ name: 'clear', description: 'Clear the conversation', argumentHint: '' }],
      agents: [{ name: 'general-purpose', description: 'General agent' }],
      output_style: 'default', available_output_styles: ['default', 'Explanatory'],
      models: [{ value: 'haiku', displayName: 'Haiku', description: 'Fast' }],
      account: { email: 'tester@example.com', organization: 'Test Org', subscriptionType: 'max', tokenSource: 'claude.ai', apiKeySource: '/login managed key', apiProvider: 'firstParty' },
      pid: 0, session_state: this.state, capabilities: this.capabilities, current_permission_mode: this.mode,
      claude_code_version: '2.1.322', fast_mode_state: 'off',
    }));
  }
  reinitialize() { return this.initializationResult(); }
  supportedCommands() { return this.control('supportedCommands', [], () => [{ name: 'clear', description: 'Clear the conversation', argumentHint: '' }]); }
  supportedModels() { return this.control('supportedModels', [], () => [{ value: 'haiku', displayName: 'Haiku', description: 'Fast' }]); }
  supportedAgents() { return this.control('supportedAgents', [], () => [{ name: 'general-purpose', description: 'General agent' }]); }
  accountInfo() { return this.control('accountInfo', [], () => ({ email: 'tester@example.com', organization: 'Test Org' })); }
  mcpServerStatus() {
    return this.control('mcpServerStatus', [], () => [{
      name: 'demo', status: 'connected', scope: 'user', source: 'user',
      config: { type: 'stdio', command: 'demo-server', env: { DEMO_TOKEN: 'super-secret-token-value' }, headers: { Authorization: 'Bearer abc' } },
      tools: [{ name: 'ping', description: 'Ping', annotations: { readOnly: true } }],
    }]);
  }
  getContextUsage(opts) {
    return this.control('getContextUsage', [opts], () => ({
      categories: [{ id: 'messages', name: 'Messages', tokens: 1200, color: 'blue', kind: 'used' }],
      totalTokens: 1200, maxTokens: 200000, rawMaxTokens: 200000, percentage: 0.6, gridRows: [], model: MODEL,
      memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 180000,
    }));
  }
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts) {
    return this.control('usage', [opts], () => ({ session: { total_cost_usd: this.costTotal, model_usage: {} }, subscription_type: 'max', rate_limits_available: false, rate_limits: null }));
  }
  rewindFiles(id, opts) { return this.control('rewindFiles', [id, opts], () => ({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 })); }
  reconnectMcpServer(name) { return this.control('reconnectMcpServer', [name], () => {}); }
  toggleMcpServer(name, on) { return this.control('toggleMcpServer', [name, on], () => {}); }
  setMcpServers(servers) { return this.control('setMcpServers', [servers], () => ({ added: Object.keys(servers ?? {}), removed: [], errors: {} })); }
  renameSession(title, sessionId) { return this.control('renameSession', [title, sessionId], () => {}); }
  stopTask(id) { return this.control('stopTask', [id], () => {}); }
  backgroundTasks(id) { return this.control('backgroundTasks', [id], () => true); }
  reloadPlugins(o) { return this.control('reloadPlugins', [o], () => ({ commands: [], agents: [], plugins: [], mcpServers: [] })); }
  reloadSkills() { return this.control('reloadSkills', [], () => ({ commands: [] })); }
  reloadOutputStyles() { return this.control('reloadOutputStyles', [], () => ({ output_styles: ['default'] })); }
  readFile() { return this.control('readFile', [], () => null); }
  seedReadState() { return this.control('seedReadState', [], () => {}); }
  streamInput() { return Promise.resolve(); }

  // ---- test controls ----

  // Push one frame. session_id and uuid are filled in like the CLI does.
  emit(frame) {
    if (this.finished) return;
    const m = { session_id: this.sessionId, uuid: randomUUID(), ...frame };
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve({ value: m, done: false }); } else this.out.push(m);
  }

  // The process is gone. `die(err)` makes the frame stream throw (a crash);
  // `end()` finishes it cleanly (the CLI exited by itself).
  die(err = Object.assign(new Error('Claude Code process exited with code 1'), { exitCode: 1 })) { this.finish(err); }
  end() { this.finish(); }

  finish(error) {
    if (this.finished) return;
    this.finished = { error: error ?? null };
    this.abort.abort();
    if (this.current) this.current.gate.resolve();
    for (const h of this.holds.splice(0)) h.resolve();
    if (this.waiter && !this.out.length) { const w = this.waiter; this.waiter = null; error ? w.reject(error) : w.resolve({ value: undefined, done: true }); }
  }

  // Make a control request never answer (`'*'` for all of them).
  hang(method) { this.hung.add(method); return this; }
  unhang(method) { this.hung.delete(method); return this; }

  // The next turn stops after its first delta until the returned function is called.
  hold() {
    const d = deferred();
    this.holds.push(d);
    return () => d.resolve();
  }

  // Ask the host for permission the way the CLI does, and return its answer.
  async ask(name, input, ctx = {}) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    this.abort.signal.addEventListener('abort', onAbort, { once: true });
    this.asking.add(ac);
    this.setState('requires_action');
    // The CLI's frames reach the host before its permission request does.
    await new Promise((r) => setImmediate(r));
    try {
      if (this.finished) return { behavior: 'deny', message: 'The process ended.' };
      return await this.options.canUseTool(name, input, { signal: ac.signal, toolUseID: `toolu_${randomUUID().slice(0, 8)}`, requestId: randomUUID(), ...ctx });
    } finally {
      this.asking.delete(ac);
      this.abort.signal.removeEventListener('abort', onAbort);
      if (!this.finished) this.setState('running');
    }
  }

  // Helpers for a custom `reply`: one streamed text message, or one tool call
  // that goes through the host's permission prompt.
  say(text, marks = {}) {
    const messageId = `msg_${randomUUID().slice(0, 12)}`;
    this.emit({ type: 'stream_event', parent_tool_use_id: null, api_message_id: messageId, event: { type: 'message_start', message: { id: messageId, model: MODEL } }, ...marks });
    this.emit({ type: 'stream_event', parent_tool_use_id: null, api_message_id: messageId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    this.emit({
      type: 'assistant', parent_tool_use_id: null, timestamp: new Date().toISOString(), ...marks,
      message: { id: messageId, model: MODEL, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
    });
  }

  async useTool(name, input, ctx = {}) {
    const id = `toolu_${randomUUID().slice(0, 12)}`;
    this.emit({ type: 'assistant', parent_tool_use_id: null, timestamp: new Date().toISOString(), message: { id: `msg_${id}`, model: MODEL, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const answer = await this.ask(name, input, { toolUseID: id, ...ctx });
    if (this.finished) return answer;
    if (answer?.behavior === 'deny' && answer.interrupt && this.current) this.current.aborted = true;
    for (const u of answer?.updatedPermissions ?? []) if (u.type === 'setMode') { this.mode = u.mode; this.emit({ type: 'system', subtype: 'status', status: null, permissionMode: u.mode }); }
    const denied = answer?.behavior !== 'allow';
    this.emit({
      type: 'user', parent_tool_use_id: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: denied ? (answer?.message ?? 'Denied') : 'done', ...(denied && { is_error: true }) }] },
      ...(!denied && { tool_use_result: { type: 'create', filePath: `${this.options.cwd}/note.txt`, content: 'hi', structuredPatch: [], originalFile: null, userModified: false } }),
    });
    return answer;
  }

  // Startup that fails the way a missing resume id does (V4 in the plan).
  failStartup(text, { reason } = {}) {
    this.startupFailure = true;
    this.emit({
      type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: [text], duration_ms: 1, duration_api_ms: 0, total_cost_usd: 0,
      ...(reason && { startup_failure_reason: reason }),
    });
    setTimeout(() => this.finish(Object.assign(new Error(`Claude Code returned an error result: ${text}`), { errorClass: 'error_result' })), 5);
  }

  // ---- the simulated CLI ----

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (this.stateEvents) this.emit({ type: 'system', subtype: 'session_state_changed', state });
  }

  life(id, state) { if (this.lifecycle && id) this.emit({ type: 'command_lifecycle', command_uuid: id, state }); }

  async readInput() {
    try { this.script.onStart?.(this); } catch (err) { this.finish(err); return; }
    if (this.startupFailure || this.finished) return;
    try {
      this.promptIter = this.prompt[Symbol.asyncIterator]();
      for (;;) {
        const { value, done } = await this.promptIter.next();
        if (done) break;
        if (this.finished) {
          // The SDK reads the message, fails to write it to the dead process and
          // only then releases the input. The message is gone: the host must resend it.
          this.swallowed.push(value);
          try { this.promptIter.return?.(); } catch {}
          break;
        }
        this.received.push(value);
        if (this.script.auto === false) continue;
        this.queue.push(value);
        if (this.current) { this.announced.add(value.uuid); this.life(value.uuid, 'queued'); } else this.drain();
      }
    } catch (err) {
      if (!this.finished) this.finish(err);
      return;
    }
    this.inputEnded = true;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.finished) {
        // The CLI takes everything waiting at the start of a turn as one batch.
        const msgs = this.script.batch === false ? [this.queue.shift()] : this.queue.splice(0);
        await this.turn(msgs);
      }
    } finally {
      this.draining = false;
      if (!this.finished) this.setState('idle');
    }
  }

  init(extra = {}) {
    return {
      type: 'system', subtype: 'init', cwd: this.options.cwd, tools: ['Bash', 'Write'], mcp_servers: [], model: MODEL,
      permissionMode: this.mode, slash_commands: ['clear'], terminal_slash_commands: ['doctor'], apiKeySource: '/login managed key',
      claude_code_version: '2.1.322', output_style: 'default', agents: ['general-purpose'], skills: [], plugins: [],
      capabilities: this.capabilities, memory_paths: {}, messaging_socket_path: '/tmp/fake-messaging.sock', fast_mode_state: 'off', ...extra,
    };
  }

  result(ids, extra = {}) {
    const cost = extra.is_error ? 0 : 0.0005;
    this.costTotal += cost;
    return {
      type: 'result', subtype: 'success', is_error: false, duration_ms: 12, duration_api_ms: 8, num_turns: 1, result: 'ok', stop_reason: 'end_turn',
      total_cost_usd: this.costTotal, terminal_reason: 'completed', permission_denials: [], origin: { kind: 'human' },
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      modelUsage: { [MODEL]: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, costUSD: this.costTotal, contextWindow: 200000 } },
      model_usage_since_last_result: { [MODEL]: { inputTokens: 3, outputTokens: 2, costUSD: cost } },
      queued_turn_count: this.queue.length, fast_mode_state: 'off',
      ...(this.lifecycle && { user_message_uuid: ids[0], user_message_uuids: ids }),
      ...extra,
    };
  }

  // Like the CLI at the end of a reply: the host's Stop hooks hear what is scheduled to wake the session later.
  async stopHooks() {
    const crons = typeof this.script.crons === 'function' ? this.script.crons(this) : this.script.crons;
    for (const matcher of this.options.hooks?.Stop ?? []) {
      for (const hook of matcher.hooks ?? []) {
        try { await hook({ hook_event_name: 'Stop', session_id: this.sessionId, cwd: this.options.cwd, stop_hook_active: false, background_tasks: [], session_crons: crons ?? [] }, undefined, { signal: this.abort.signal }); }
        catch { /* the CLI reports a failed hook and carries on */ }
      }
    }
  }

  async turn(msgs) {
    const ids = msgs.map((m) => m.uuid).filter(Boolean);
    const marks = this.lifecycle ? { user_message_uuids: ids } : {};
    const turn = { msgs, aborted: false, gate: deferred() };
    this.current = turn;
    this.turns++;
    this.setState('running');
    for (const id of ids) { if (!this.announced.has(id)) this.life(id, 'queued'); this.life(id, 'started'); }
    this.emit({ ...this.init(), ...marks });

    const custom = this.script.reply;
    const hold = this.holds.shift();
    const messageId = `msg_${randomUUID().slice(0, 12)}`;
    try {
      if (custom) {
        const handled = await custom.call(this, msgs, this);
        if (handled === false || this.finished) return;
      } else {
        this.emit({ type: 'system', subtype: 'status', status: 'requesting', ...marks });
        this.emit({ type: 'stream_event', parent_tool_use_id: null, api_message_id: messageId, event: { type: 'message_start', message: { id: messageId, model: MODEL } }, ...marks });
        this.emit({ type: 'stream_event', parent_tool_use_id: null, api_message_id: messageId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
        this.emit({ type: 'stream_event', parent_tool_use_id: null, api_message_id: messageId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'o' } } });
        if (hold) await Promise.race([hold.promise, turn.gate.promise]);
        if (this.finished) return;
        if (!turn.aborted) {
          this.emit({ type: 'stream_event', parent_tool_use_id: null, api_message_id: messageId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'k' } } });
          this.emit({
            type: 'assistant', parent_tool_use_id: null, timestamp: new Date().toISOString(), ...marks,
            message: { id: messageId, model: MODEL, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
          });
        }
      }
      if (this.finished) return;
      if (turn.aborted) {
        // Recorded order for an interrupt: aborted assistant, marker, error result, then `cancelled`.
        this.emit({ type: 'assistant', parent_tool_use_id: null, aborted: true, timestamp: new Date().toISOString(), message: { id: messageId, model: MODEL, role: 'assistant', content: [{ type: 'text', text: 'o' }] } });
        this.emit({ type: 'user', parent_tool_use_id: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
        this.emit(this.result(ids, { subtype: 'error_during_execution', is_error: true, result: undefined, stop_reason: null, terminal_reason: 'aborted_streaming', errors: ['[ede_diagnostic] result_type=user last_content_type=text stop_reason=null'] }));
        for (const id of ids) this.life(id, 'cancelled');
      } else {
        await this.stopHooks();
        if (this.finished) return;
        this.emit(this.result(ids, this.script.resultExtra ?? {}));
        for (const id of ids) this.life(id, 'completed');
      }
    } finally {
      this.current = null;
    }
  }
}

// `script` options:
//   auto: false          do not answer user messages (drive everything with emit)
//   batch: false         one turn per message instead of batching what is waiting
//   stateEvents: false   never send session_state_changed (older CLI)
//   capabilities: []     what system/init advertises
//   reply(msgs, run)     replace the body of a turn; return false to end it without a result
//   resultExtra: {}      merged into every successful result frame
//   crons: [] | (run)    what the Stop hook says is scheduled to wake the session (SessionCronSummary rows)
//   controls: { name }   replace a control request's answer
//   onStart(run)         runs once per process before any input is read
export function createFake(script = {}) {
  const runs = [];
  const fake = {
    script,
    runs,
    get current() { return runs.at(-1) ?? null; },
    get starts() { return runs.length; },
    queryFn(params) {
      const run = new FakeRun(params, script);
      runs.push(run);
      return run;
    },
    // Resolves with the nth process (1-based) once Session has started it.
    async run(n = 1, ms = 3000) {
      const end = Date.now() + ms;
      while (runs.length < n) {
        if (Date.now() > end) throw new Error(`the fake was started ${runs.length} time(s), expected ${n}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return runs[n - 1];
    },
  };
  return fake;
}

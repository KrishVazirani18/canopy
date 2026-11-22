// Code Mode: Claude writes one script that makes many tool calls, and only what the script returns goes back
// into the conversation. A chain of ten calls costs one step and a small result instead of ten round trips.
//
// Claude Code's own experimental Code Mode refuses SDK sessions, so this one is Canopy's:
//  - createCodeServer()  an in-process MCP server with one tool, mcp__canopy__run { description, code }.
//  - runScript()         runs the script in a locked-down child (code-runner.mjs): no files, no network, no
//                        processes. Its only way out is a message to this process asking for a helper.
//  - CodeRuns            answers those helpers for one Claude Code process:
//                          mcp()   an mcp_call on the control channel with check_permissions, so Claude Code
//                                  decides it exactly like the model's own call (rules, mode, hooks, prompts)
//                          read()  through Claude Code's Read rules, inside the project folders only
//                          glob() / grep()  built in the sandbox from a folder listing and read()
//                        and reports every call as a `code-call` event, so the UI can show them live.
//  - shapeMcpResult() / formatOutcome()  what the script, and then the model, get back.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const soft = async (f) => { try { return await import(f); } catch (err) { return { __missing: String(err?.message ?? err) }; } };
const [sdk, zod] = await Promise.all([soft('@anthropic-ai/claude-agent-sdk'), soft('zod')]);
let RUNNER = null;
try { RUNNER = readFileSync(new URL('./code-runner.mjs', import.meta.url), 'utf8'); } catch { /* reported by CODE_MISSING */ }

/** What this build lacks to offer Code Mode, or null. */
export const CODE_MISSING = !sdk.createSdkMcpServer || !sdk.tool ? 'sdk' : !zod.z ? 'zod' : !RUNNER ? 'runner' : null;
export const CODE_SERVER = 'canopy';
export const CODE_TOOL = `mcp__${CODE_SERVER}__run`;
// Both must be advertised: a Claude Code without the first ignores check_permissions and would run every call unchecked.
export const CODE_CAPS = ['mcp_call_check_permissions_v1', 'mcp_call_result_not_for_model_v1'];
// Claude Code gives a permission prompt for a script's call an id of its own, with this prefix.
export const NESTED_PREFIX = 'toolu_mcp_call_';
export const RUN_TIMEOUT_MS = 10 * 60_000;
const SERVER_TIMEOUT_MS = 12 * 60 * 60_000;
const READY_MS = 20_000;
export const OUTPUT_LIMIT = 20_000;

const LOG_LIMIT = 5000;     // of the output the model sees
const LOG_KEEP = 64_000;    // kept while the script runs
const MAX_CALLS = 500;
const MAX_PARALLEL = 8;
const MAX_ROWS = 300;
const MAX_FILES = 20_000;
const GREP_FILES = 2000;   // the runner's own limit (code-runner.mjs), repeated here for the tool's description
const READ_BYTES = 1024 * 1024;
const INPUT_PREVIEW = 4000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
const REFUSED = 'The tool did not run: ';
// Claude Code refuses with those words for more than one reason. A refusal that was somebody's decision (the user,
// a rule, a hook, the mode) is a denied call; one for a tool that is not there is a mistake in the script.
const isDenial = (error) => error.startsWith(REFUSED) && /\b(den(y|ied)|permission|approval|not allowed|blocked|hook|plan mode)\b/i.test(error.slice(REFUSED.length));
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SH = '/bin/sh';
// The kernel's limit on the child, for what the host's timer cannot reach: a script in a tight loop never hears
// that Canopy has gone (a crash, a force quit), and without this would spin for good.
const CPU_SECONDS = 15 * 60;
// What the child may read of macOS itself: enough to start (which takes the root folder's own listing too), and
// nothing of the user's.
const SYSTEM_READS = ['/System', '/usr/lib', '/usr/share', '/dev', '/private/var/db/dyld', '/private/var/db/timezone'];

// The folder the runner's own program lives in. In Canopy that is the app bundle (Electron, its frameworks and
// data files). Run by a plain node (development, the tests) it is that node's folder, or all of Homebrew for a
// Homebrew node, which links libraries and reads configuration from its sibling packages.
function programFolder(execPath) {
  let real = execPath;
  try { real = realpathSync(execPath); } catch { /* a missing binary is spawn's to report */ }
  return /^(.+?\.app)\//.exec(real)?.[1] ?? /^(.+?)\/Cellar\//.exec(real)?.[1] ?? path.dirname(real);
}

/**
 * The seatbelt profile for the runner. --permission (in runScript) closes files, child processes and workers in
 * Node's own code; this is the second wall, the kernel's: no network, no signals, no writes, no fork, and no
 * reading outside macOS and the program itself, so a gap in Node's model (node:sqlite was one) opens nothing.
 */
export function sandboxProfile(execPath) {
  const quoted = (p) => `"${p.replace(/[\\"]/g, '\\$&')}"`;
  const reads = [...SYSTEM_READS, programFolder(execPath)].map((p) => `(subpath ${quoted(p)})`).join(' ');
  return `(version 1)(allow default)(deny network*)(deny signal)(deny file-write*)(deny process-fork)(deny file-read-data)(allow file-read-data (literal "/") ${reads})`;
}

const num = (n) => Number(n).toLocaleString('en-US');

export const CODE_NOTE = `Code Mode is on: the user wants multi-call MCP work done through scripts. Whenever a task needs three or more MCP tool calls, MCP calls where one's output feeds the next, or an MCP call whose output you only need part of, write one ${CODE_TOOL} script instead of calling the tools one at a time or in parallel: the intermediate results stay out of your context and the work finishes in one step. A single MCP call, and anything that needs the shell or file edits, still goes through your normal tools. So does a tool whose result is a picture (a screenshot), however many times you call it: a script can only bring back words. So does everything in Plan mode, where scripts do not run.`;

export const TOOL_DESCRIPTION = `Run a JavaScript script that calls MCP tools for you. What the script does stays out of your context: you get back only what it returns, plus anything it logs. Use it to chain, loop over or filter tool calls in one step instead of making them one at a time.

Use it when:
- two or more MCP calls depend on each other (the output of one feeds the next)
- you need the same call many times (a loop, a batch, pagination), even when the calls could run in parallel
- a tool returns far more than you need and you only want a slice of it
Do not use it for a single call (call the tool directly), or for anything that needs the shell, file edits or the network (use your normal tools). Scripts do not run in Plan mode: call the tools directly there.

\`code\` is the body of an async function. Use \`await\`, and \`return\` the final value: JSON-serializable and small, because output over about ${OUTPUT_LIMIT.toLocaleString('en-US')} characters is cut.

Helpers:
- await mcp(tool, args): call an MCP tool by its full name, e.g. mcp('mcp__github__list_issues', { state: 'open' }). Every call goes through the same permission rules and prompts as a call you make yourself. Resolves to the tool's result as a JS value (its structured content, or parsed JSON when the text is JSON, otherwise the text). Throws an Error when the call is denied or fails.
- await read(path): the text of a file in the project (first 1 MB).
- await glob(pattern, { path }?): matching file paths, e.g. glob('src/**/*.ts'). Skips node_modules and .git. Throws when the folder holds more than ${num(MAX_FILES)} files: pass { path } to look in a smaller one.
- await grep(pattern, { path, glob, ignoreCase, limit }?): [{ file, line, text }] for lines matching a regular expression, the first 200 unless you pass limit (1000 at most). Throws when it would have to read more than ${num(GREP_FILES)} files: narrow it with { path } or { glob }.
- console.log(...) or print(...): returned to you with the result. await sleep(ms).
The script runs in a sandbox: no require or import, no filesystem, no network, no shell. Run calls in parallel with Promise.all. Limits: ${MAX_CALLS} tool calls and 10 minutes per run.

Tool schemas still apply, so load a tool's schema first if you do not have it. If you do not know the shape of a tool's result, return a small sample first (Object.keys, or the first item) instead of guessing.

Example (the tool names are made up): total the unread invoices, returning only the summary.
const list = await mcp('mcp__gmail__search_threads', { query: 'is:unread subject:invoice', max_results: 25 });
const threads = await Promise.all(list.threads.map((t) => mcp('mcp__gmail__get_thread', { thread_id: t.id })));
const invoices = threads.map((t) => ({ from: t.messages[0].from, subject: t.subject, amount: /\\$[\\d,.]+/.exec(t.messages[0].body)?.[0] ?? null }));
return { count: invoices.length, invoices: invoices.filter((i) => i.amount) };`;

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const errText = (err) => String(err?.message ?? err);
const toolResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError && { isError: true }) });
const stable = (v) => { try { return JSON.stringify(v ?? {}); } catch { return ''; } };

/** Why Code Mode cannot run on a Claude Code with these capabilities, or null. Pass null while they are not known yet. */
export function codeBlocked(caps) {
  if (CODE_MISSING) return 'Code Mode is not part of this build of Canopy.';
  if (caps && !CODE_CAPS.every((c) => caps.has(c))) return 'This version of Claude Code is too old for Code Mode. Update Claude Code to use it.';
  return null;
}

/** A permission prompt that belongs to a call a script made, not to a call in the transcript. */
export const isNestedAsk = (toolUseId) => typeof toolUseId === 'string' && toolUseId.startsWith(NESTED_PREFIX);

// ---- what comes back ----

const parsed = (text) => {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return text;
  try { return JSON.parse(t); } catch { return text; }
};

/**
 * An mcp_call answer (raw MCP content blocks) as the value a script wants: structured content when the tool
 * gave any, parsed JSON when its one text block is JSON, otherwise the text. Images and other blocks are only
 * named, never carried: their bytes are no use to a script.
 */
export function shapeMcpResult(r) {
  if (!isPlain(r)) return r ?? null;
  if (r.structuredContent != null) return r.structuredContent;
  const content = r.content;
  if (typeof content === 'string') return parsed(content);
  if (!Array.isArray(content)) return r.toolResult ?? null;
  const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  if (texts.length === content.length) return texts.length === 1 ? parsed(texts[0]) : texts.join('\n');
  const other = content.filter((b) => !(b?.type === 'text' && typeof b.text === 'string'))
    .map((b) => ({ type: String(b?.type ?? 'unknown'), mimeType: b?.mimeType ?? b?.resource?.mimeType ?? null }));
  return { text: texts.join('\n'), other };
}

// Logs keep their start and their end (the last lines usually say what went wrong).
function clipLogs(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max / 2);
  return `${text.slice(0, head)}\n[… ${num(text.length - max)} characters of logs not shown …]\n${text.slice(text.length - (max - head))}`;
}

function failure(o, code) {
  if (o.reason !== 'error') return o.error;
  const src = o.line ? String(code).split('\n')[o.line - 1] : null;
  return `The script failed${o.line ? ` at line ${o.line}` : ''}: ${o.error}${src != null ? `\n> ${o.line} | ${src.trim().slice(0, 200)}` : ''}`;
}

/** The text the model gets for one run: logs, then the result (or what went wrong and where), within `limit` characters. */
export function formatOutcome(o, { code = '', calls = 0, limit = OUTPUT_LIMIT } = {}) {
  const parts = [];
  if (!o.ok) parts.push(failure(o, code));
  const logs = clipLogs(String(o.logs ?? '').trimEnd(), Math.min(LOG_LIMIT, Math.floor(limit / 4)));
  if (logs) parts.push(`Logs:\n${logs}`);
  if (o.ok && o.out == null) parts.push('The script returned nothing. `return` a value to get data back.');
  else if (o.ok) {
    const room = Math.max(1000, limit - logs.length);
    const total = Math.max(o.length ?? 0, o.out.length);
    const body = total > room
      ? `${o.out.slice(0, room)}\n[Result truncated: showing the first ${num(room)} of ${num(total)} characters. Return less from the script: filter, slice or summarize before returning.]`
      : o.out;
    parts.push(logs ? `Result:\n${body}` : body);
  }
  parts.push(`(${calls} tool call${calls === 1 ? '' : 's'}, ${o.ms < 1000 ? `${Math.round(o.ms)}ms` : `${(o.ms / 1000).toFixed(1)}s`})`);
  return parts.join('\n\n');
}

// ---- the sandbox ----

/**
 * Run one script in the sandbox. Always resolves, and the child is gone when it does:
 *   { ok: true, out, length, logs, ms }  or  { ok: false, reason: 'error'|'timeout'|'aborted'|'crashed', error, line, logs, ms }
 * `handle(op, args, { quiet, signal })` answers the script's helper calls; its signal aborts when the run is over,
 * however it ended. `step(msg)` hears about the rows the runner reports for glob and grep. `waited()` is how long
 * the run has spent waiting for a person so far: the time limit is on the script's own work. `cpuSeconds` is the
 * processor time the kernel allows the child, whatever becomes of this process.
 */
export function runScript({ code, handle, step, signal, waited = () => 0, timeoutMs = RUN_TIMEOUT_MS, cpuSeconds = CPU_SECONDS, execPath = process.execPath, sandboxExec = existsSync(SANDBOX_EXEC) }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const over = new AbortController();
    let logs = '';
    let stderr = '';
    let child = null;
    let ready = false;
    const finish = (r) => {
      if (over.signal.aborted) return;
      over.abort();
      clearTimeout(timer); clearTimeout(boot);
      signal?.removeEventListener?.('abort', onAbort);
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ line: null, ...r, logs, ms: Date.now() - started });
    };
    const onAbort = () => finish({ ok: false, reason: 'aborted', error: 'The script was stopped before it finished.' });
    const allowed = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minute` : `${Math.round(timeoutMs / 1000)} second`;
    const expire = () => {
      // A permission prompt nobody has answered yet must not cost the script its run.
      const left = timeoutMs - (Date.now() - started - waited());
      if (left > 0) timer = setTimeout(expire, Math.max(left, 1000));
      else finish({ ok: false, reason: 'timeout', error: `The script ran past the ${allowed} limit and was stopped. Do less in one run.` });
    };
    let timer = setTimeout(expire, timeoutMs);
    // A child that is not the runner (an Electron that ignores ELECTRON_RUN_AS_NODE opens as an app) never says ready.
    const boot = setTimeout(() => finish({ ok: false, reason: 'crashed', error: 'The sandbox did not start.' }), READY_MS);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    // No file grants at all: the runner's source travels on the command line, so the child never opens a file.
    // node:sqlite is switched off because it opens files without asking the permission model. The heap limit is on
    // what a script builds in JavaScript (strings, objects, parsed results); a Buffer is outside it, and is bounded
    // only by how long a run may last.
    let cmd = [execPath, '--permission', '--no-experimental-sqlite', '--max-old-space-size=512', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', RUNNER];
    if (sandboxExec) cmd = [SANDBOX_EXEC, '-p', sandboxProfile(execPath), ...cmd];
    // sh sets the CPU limit and then becomes the command, so there is no process in between.
    if (existsSync(SH)) cmd = [SH, '-c', `ulimit -t ${cpuSeconds} 2>/dev/null; exec "$0" "$@"`, ...cmd];
    const opts = { env: { ELECTRON_RUN_AS_NODE: '1', CANOPY_CODE_RUNNER: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], cwd: '/', windowsHide: true };
    try { child = spawn(cmd[0], cmd.slice(1), opts); }
    catch (err) { return finish({ ok: false, reason: 'crashed', error: `The sandbox could not start: ${errText(err)}` }); }

    const reply = (m) => { if (!over.signal.aborted && child.connected) { try { child.send(m); } catch { /* the child is going away */ } } };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('message', (m) => {
      if (over.signal.aborted || !isPlain(m)) return;
      if (m.t === 'ready') { ready = true; clearTimeout(boot); reply({ t: 'run', code: String(code) }); }
      else if (m.t === 'log') { if (logs.length < LOG_KEEP) logs += `${String(m.text).slice(0, 8000)}\n`; }
      else if (m.t === 'step') { try { step?.(m); } catch { /* a row is only display */ } }
      else if (m.t === 'call') {
        Promise.resolve().then(() => handle(String(m.op), m.args, { quiet: m.quiet === true, signal: over.signal }))
          .then((value) => reply({ t: 'reply', id: m.id, value: value ?? null }), (err) => reply({ t: 'reply', id: m.id, error: errText(err) }));
      } else if (m.t === 'done') {
        finish(m.ok === true
          ? { ok: true, out: typeof m.out === 'string' ? m.out : null, length: Number(m.length) || 0 }
          : { ok: false, reason: 'error', error: String(m.error ?? 'The script failed.'), line: Number.isInteger(m.line) ? m.line : null });
      }
    });
    child.once('error', (err) => finish({ ok: false, reason: 'crashed', error: `The sandbox could not start: ${errText(err)}` }));
    child.once('exit', (exitCode, sig) => finish(sig === 'SIGXCPU'
      ? { ok: false, reason: 'timeout', error: 'The script used more processor time than a run is allowed and was stopped. Do less in one run.' }
      : { ok: false, reason: 'crashed', error: `The sandbox ${ready ? 'stopped unexpectedly' : 'could not start'} (${sig ?? `exit ${exitCode}`}).${stderr.trim() ? ` ${stderr.trim().slice(-400)}` : ''}` }));
  });
}

// At most `max` at once; the rest wait their turn.
function limiter(max) {
  let active = 0;
  const queue = [];
  const release = () => { active -= 1; queue.shift()?.(); };
  return () => new Promise((resolve) => {
    const go = () => { active += 1; resolve(release); };
    if (active < max) go(); else queue.push(go);
  });
}

// ---- the scripts running on one Claude Code process ----

export class CodeRuns {
  /**
   * @param {{ channel: ReturnType<import('./control-channel.mjs').controlChannel>,
   *   readFile: (path: string, opts: object) => Promise<{contents: string, truncated?: boolean, lossy?: boolean} | null>,
   *   roots: () => string[], emit: (ev: object) => void, direct?: (tool: string) => string | null,
   *   timeoutMs?: number, execPath?: string, sandboxExec?: boolean }} o
   *   roots: the folders a script may read, the project folder first.
   *   direct: for a tool a script must not call, what to tell the script instead (see mcp()); null for any other.
   */
  constructor({ channel, readFile, roots, emit, direct, timeoutMs, execPath, sandboxExec }) {
    this.channel = channel;
    this.readFile = readFile;
    this.roots = roots;
    this.emit = emit;
    this.direct = typeof direct === 'function' ? direct : () => null;
    this.sandbox = { timeoutMs, execPath, sandboxExec };
    this.jobs = new Set();
  }

  get size() { return this.jobs.size; }

  // The tool handler: run one script, and shape what the model sees of it.
  async run(args, extra) {
    const code = typeof args?.code === 'string' ? args.code : '';
    if (!code.trim()) return toolResult('The script is empty. Pass the body of an async function as `code`.', true);
    const stop = new AbortController();
    const job = {
      id: extra?._meta?.['claudecode/toolUseId'] ?? null, // the transcript's tool call, so the UI knows whose rows these are
      stop, calls: 0, rows: 0, open: new Map(), steps: new Map(), flying: new Map(), gate: limiter(MAX_PARALLEL),
      asking: 0, askedAt: 0, waitedMs: 0, // prompts open now, since when, and the time earlier ones took
    };
    this.jobs.add(job);
    try {
      const signal = extra?.signal ? AbortSignal.any([extra.signal, stop.signal]) : stop.signal;
      const defined = Object.fromEntries(Object.entries(this.sandbox).filter(([, v]) => v !== undefined));
      const outcome = await runScript({
        code, signal, ...defined, handle: (op, a, ctx) => this.handle(job, op, a, ctx), step: (m) => this.step(job, m),
        waited: () => job.waitedMs + (job.asking ? Date.now() - job.askedAt : 0),
      });
      // Calls still open when the run ended were cut off with it.
      for (const id of [...job.open.keys()]) this.close(job, id, 'error', { error: outcome.reason === 'timeout' ? 'Timed out' : 'Stopped' });
      return toolResult(formatOutcome(outcome, { code, calls: job.calls }), !outcome.ok);
    } finally { this.jobs.delete(job); }
  }

  /** The process is going away (or the session is): no script outlives it. */
  stopAll() { for (const job of this.jobs) job.stop.abort(); }

  // A prompt for a script's call cannot be tied to it by id, so it goes to the oldest unasked call of that tool with
  // those arguments (or, if a hook rewrote them, the oldest unasked call of that tool).
  claim(name, input) {
    const key = stable(input);
    let loose = null;
    for (const job of this.jobs) {
      for (const call of job.flying.values()) {
        if (call.asked || call.tool !== name) continue;
        if (stable(call.input) === key) { call.asked = true; return { job, run: job.id, id: call.id }; }
        loose ??= { job, call };
      }
    }
    if (!loose) return null;
    loose.call.asked = true;
    return { job: loose.job, run: loose.job.id, id: loose.call.id };
  }

  /** The claimed call is waiting for the user (or no longer is). The wait is not counted against the script's time limit. */
  waiting(claim, on) {
    const job = claim?.job;
    if (!job) return;
    if (on) { if (job.asking++ === 0) job.askedAt = Date.now(); }
    else if (job.asking > 0 && --job.asking === 0) job.waitedMs += Date.now() - job.askedAt;
    if (job.open.has(claim.id)) this.emit({ kind: 'code-call', run: claim.run, id: claim.id, status: on ? 'approval' : 'running' });
  }

  // ---- rows: one `code-call` event when a call starts and one when it ends ----

  start(job, name, input) {
    if (job.rows >= MAX_ROWS) return null; // the call still runs; it is only not listed
    const id = ++job.rows;
    job.open.set(id, Date.now());
    const preview = stable(input).length <= INPUT_PREVIEW ? input : { note: 'Large input not shown' };
    this.emit({ kind: 'code-call', run: job.id, id, name, input: preview, status: 'running' });
    return id;
  }

  close(job, id, status, extra) {
    const at = job.open.get(id);
    if (at == null) return;
    job.open.delete(id);
    this.emit({ kind: 'code-call', run: job.id, id, status, ms: Date.now() - at, ...extra });
  }

  step(job, m) {
    if (!isPlain(m) || typeof m.id !== 'number') return;
    if (typeof m.ok !== 'boolean') {
      const name = m.op === 'glob' ? 'Glob' : m.op === 'grep' ? 'Grep' : null;
      const id = name && this.start(job, name, { pattern: String(m.label ?? '').slice(0, 300) });
      if (id) job.steps.set(m.id, id);
      return;
    }
    const id = job.steps.get(m.id);
    job.steps.delete(m.id);
    if (id) this.close(job, id, m.ok ? 'ok' : 'error', m.ok ? { note: String(m.note ?? '').slice(0, 80) } : { error: String(m.error ?? '').slice(0, 300) });
  }

  // ---- helpers ----

  async handle(job, op, args, { quiet, signal }) {
    if (signal.aborted) throw new Error('The script was stopped.');
    if (op === 'mcp') return this.mcp(job, args, signal);
    if (op === 'files') return this.files(args);
    if (op !== 'read') throw new Error(`Unknown helper: ${op}`);
    const id = quiet ? null : this.start(job, 'Read', { file_path: String(args?.path ?? '') });
    try {
      const r = await this.read(args);
      this.close(job, id, 'ok');
      return r;
    } catch (err) { this.close(job, id, 'error', { error: errText(err).slice(0, 300) }); throw err; }
  }

  async mcp(job, args, signal) {
    const tool = typeof args?.tool === 'string' ? args.tool : '';
    const input = isPlain(args?.args) ? args.args : {};
    if (!/^mcp__.+__.+/.test(tool)) {
      throw new Error(`mcp() takes a full MCP tool name like mcp__server__tool, not ${JSON.stringify(args?.tool ?? null)}. Built-in tools (Read, Bash, Edit) cannot be called from a script.`);
    }
    if (tool.startsWith(`mcp__${CODE_SERVER}__`)) throw new Error('A script cannot start another script.');
    // A tool whose result only the model can use (a screenshot: a script gets the words about it, never the picture).
    const direct = this.direct(tool);
    if (direct) throw new Error(direct);
    job.calls += 1;
    if (job.calls > MAX_CALLS) throw new Error(`This script has made ${MAX_CALLS} tool calls, and more are refused. Narrow the loop, or split the work across runs.`);
    const id = this.start(job, tool, input);
    const release = await job.gate();
    try {
      if (signal.aborted) throw new Error('The script was stopped.');
      const req = this.channel.request({ subtype: 'mcp_call', tool, arguments: input, check_permissions: true, result_not_for_model: true });
      job.flying.set(req.id, { id, tool, input, asked: false });
      // The run ending (Stop, the time limit, the script returning) withdraws whatever is still in flight.
      const cancel = () => this.channel.cancel(req.id);
      signal.addEventListener('abort', cancel, { once: true });
      let r;
      try { r = await req.answer; } finally { signal.removeEventListener('abort', cancel); job.flying.delete(req.id); }
      // Claude Code's own words go to the script as they are: a refusal says why, a tool error is the tool's text.
      if (!r.ok) throw Object.assign(new Error(r.error), { refused: isDenial(r.error) });
      this.close(job, id, 'ok');
      return shapeMcpResult(r.response);
    } catch (err) {
      // A call cut off by the run ending is closed with the run (see run), which knows why it ended.
      if (!signal.aborted) this.close(job, id, err?.refused ? 'denied' : 'error', { error: errText(err).slice(0, 300) });
      throw err;
    } finally { release(); }
  }

  // A path the script named, as a real path inside one of the folders it may read. Symlinks are resolved first,
  // so a link inside the project cannot point a script outside it.
  async inside(p) {
    if (typeof p !== 'string' || !p) throw new Error('A path is required.');
    const roots = this.roots();
    let real;
    try { real = await fs.realpath(path.resolve(roots[0], p)); } catch { throw new Error(`No such file or folder: ${p}`); }
    for (const root of roots) {
      const r = await fs.realpath(root).catch(() => root);
      if (real === r || real.startsWith(r + path.sep)) return { real, root: r, first: root === roots[0] };
    }
    throw new Error(`${p} is outside this project. A script can only read the project's folders.`);
  }

  async read(args) {
    const { real } = await this.inside(args?.path);
    const r = await this.readFile(real, { maxBytes: READ_BYTES });
    if (!r || typeof r.contents !== 'string') throw new Error(`Could not read ${args.path}: it is not a file, or reading it is not allowed.`);
    return { text: r.contents, truncated: !!r.truncated, lossy: !!r.lossy };
  }

  // Every file under a folder, as paths relative to it. `base` is what to put in front to get a path read() takes:
  // nothing for the project folder itself, a relative folder inside it, an absolute one in another allowed folder.
  async files(args) {
    const { real: dir, root, first } = await this.inside(args?.path ?? '.');
    const base = !first ? dir : dir === root ? '' : path.relative(root, dir);
    const files = [];
    const queue = [''];
    let truncated = false;
    walk: while (queue.length) {
      const rel = queue.shift();
      let entries;
      try { entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { if (!rel) throw new Error(`Not a folder: ${args?.path ?? '.'}`); continue; }
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) queue.push(child); }
        else if (e.isFile()) {
          if (files.length >= MAX_FILES) { truncated = true; break walk; }
          files.push(child);
        }
      }
    }
    return { base: base.split(path.sep).join('/'), files: files.sort(), truncated };
  }
}

// ---- the tool ----

/**
 * The in-process MCP server Claude Code is given while Code Mode is on. A fresh one for every process and every
 * live add. `run(args, extra)` is the tool handler; `instructions` reaches the model as the server's own note.
 */
export function createCodeServer({ run, instructions }) {
  const { z } = zod;
  const tool = sdk.tool('run', TOOL_DESCRIPTION, {
    description: z.string().describe('What this script does, in a few words. The user sees it as the step\'s title, e.g. "Total the unread invoices".'),
    code: z.string().describe('The body of an async JavaScript function. `return` the value you want back.'),
  }, run, { alwaysLoad: true }); // never behind tool search: the model should reach for it without looking it up
  // The time limit is the script's own (runScript). This one only keeps an MCP_TOOL_TIMEOUT in the user's environment
  // from cutting a run short, or a run that is waiting for the user to answer a prompt.
  return sdk.createSdkMcpServer({ name: CODE_SERVER, version: '1.0.0', tools: [tool], timeout: SERVER_TIMEOUT_MS, ...(instructions && { instructions }) });
}

// Re-records the Codex fixtures: real `codex app-server` traffic, one short
// throwaway conversation per scenario, in a scratch git folder under /tmp.
//
//   node src/core/test/codex-record.mjs                  every scenario, then tidy up
//   node src/core/test/codex-record.mjs text resume      only these, in this order
//   node src/core/test/codex-record.mjs --print text     show the traffic instead of writing it
//   node src/core/test/codex-record.mjs --list           name the scenarios
//
// Options: --model <id> (default gpt-6-luna), --effort <level> (default low),
// --max-turns <n> (default 8), --keep-threads (leave the test chats unarchived).
//
// Each scenario gets its own app-server process and writes
// fixtures/codex-<scenario>.jsonl: one JSON object per line.
//   {"dir":"note", ...}              the first line: scenario, Codex version, flags
//   {"t":12,"dir":"out","msg":{…}}   a line Canopy's side wrote (client -> server)
//   {"t":40,"dir":"in","msg":{…}}    a line the app-server wrote (server -> client)
// `t` is milliseconds since the process was spawned. Lines keep the order they
// crossed the pipe, so a fake app-server can replay a file top to bottom.
//
// It talks to the app-server directly, not through Canopy's Codex session, so
// the fixtures stay an independent record of what Codex sends.
//
// Live turns cost real money on the stored OpenAI key, so every turn here is
// tiny, runs at low effort on a small model, and forces the standard service
// tier (the user's own config may say "ultrafast"). A run refuses to start more
// than --max-turns turns. Nothing under ~/.codex is edited: settings go in as
// -c flags and RPC params. The test chats it creates are archived at the end
// through Codex's own `thread/archive` (reversible), so they do not pile up in
// the user's chat list.
//
// Two set-ups:
//   'bare'  the user's Codex with their MCP servers, plugins, apps and memories
//           switched off for this process. Used for every tool scenario, so a
//           test turn can never reach one of the user's connected accounts.
//   'user'  the user's Codex as it is (only tier, notify and memories are
//           overridden). Used where the noise itself is the point.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { FIXTURES, neutralFixture, scrubbedEnv, sleep, within } from './helpers.mjs';
import { buildDigest, forCodex } from '../handoff.mjs';

// CANOPY_REC_SCRATCH: another scratch folder, so two recordings running at the same time never share one.
const SCRATCH = process.env.CANOPY_REC_SCRATCH || '/tmp/canopy-codex-rec';
const WORK = path.join(SCRATCH, 'work');
const STATE = path.join(SCRATCH, 'state.json');
const CLIENT = { name: 'canopy', title: 'Canopy', version: '0.0.1' };

const REQUEST_MS = 30000;
const THREAD_MS = 90000;   // thread/start waits on nothing, but MCP start-up can slow the process
const TURN_MS = 180000;
const ANSWER_DELAY_MS = 250; // so notifications sent while an approval is open are recorded before the answer

// ---- command line ----

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i === -1) return false; argv.splice(i, 1); return true; };
const option = (name, fallback) => { const i = argv.indexOf(name); if (i === -1) return fallback; const [, v] = argv.splice(i, 2); return v ?? fallback; };
const print = flag('--print');
const list = flag('--list');
const keepThreads = flag('--keep-threads');
const MODEL = option('--model', 'gpt-6-luna');
const EFFORT = option('--effort', 'low');
const MAX_TURNS = Number(option('--max-turns', '8'));

// ---- the codex binary and its environment ----

// Variables Codex sets for the commands it runs. A child that inherits them
// (this recorder started from inside a Codex chat) believes it is sandboxed.
const CODEX_HOST_VAR = /^CODEX_(?:SANDBOX.*|THREAD_ID|SESSION_ID|INTERNAL_ORIGINATOR_OVERRIDE)$/;

function codexEnv() {
  const env = scrubbedEnv();
  for (const k of Object.keys(env)) if (CODEX_HOST_VAR.test(k)) delete env[k];
  return env;
}

function findCodexBin(env) {
  const names = [process.env.CANOPY_CODEX_PATH, ...(env.PATH ?? '').split(':').filter((d) => path.isAbsolute(d)).map((d) => path.join(d, 'codex'))].filter(Boolean);
  for (const c of names) {
    try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// Flags every recording process gets: standard speed, no notify program, and
// no memories (so a test chat is neither read from nor written into them).
const BASE_FLAGS = ['-c', 'service_tier="default"', '-c', 'notify=[]', '--disable', 'memories'];

// The bare set-up switches off plugins and apps, then each MCP server that is
// left, by name. Two things learned the hard way: `-c mcp_servers={}` merges
// with the user's table instead of emptying it, and `enabled=false` for a
// server that only a plugin defines stops the app-server from starting
// ("invalid transport"), so the names are read with plugins already off.
function bareFlags(codex, env) {
  const flags = ['--disable', 'plugins', '--disable', 'apps'];
  const r = spawnSync(codex, [...flags, 'mcp', 'list', '--json'], { env, encoding: 'utf8', timeout: 20000 });
  let servers = [];
  try { servers = JSON.parse(r.stdout); } catch {}
  const off = [];
  for (const s of Array.isArray(servers) ? servers : []) {
    if (s?.enabled && /^[A-Za-z0-9_-]+$/.test(s.name ?? '')) off.push('-c', `mcp_servers.${s.name}.enabled=false`);
  }
  return [...flags, ...off];
}

// ---- nothing personal in a committed file ----

const SECRET_KEY = /api[_-]?key|secret|password|passwd|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|credential|cookie/i;
const OPAQUE_KEY = /^(?:encrypted_?content|encryptedContent|signature)$/;
const PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted-key>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<redacted-jwt>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer <redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<redacted-email>'],
];
const LONG = 6000;

// Every secret this machine could leak: the leaves of Codex's stored login and
// any key-like environment value. Held in memory only, never printed.
function knownSecrets(env) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (v.length >= 12) found.add(v); } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  try { walk(JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8'))); } catch {}
  for (const [k, v] of Object.entries(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(k) && typeof v === 'string' && v.length >= 12) found.add(v);
  return [...found].sort((a, b) => b.length - a.length);
}

function makeSanitizer(secrets) {
  const home = os.homedir();
  const name = os.userInfo().username;
  const text = (s) => {
    for (const x of secrets) s = s.split(x).join('<redacted>');
    for (const [re, to] of PATTERNS) s = s.replace(re, to);
    s = s.split(home).join('/Users/test').split(name).join('test');
    return s.length > LONG ? `${s.slice(0, 400)}…[trimmed ${s.length - 400} characters]` : s;
  };
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key && OPAQUE_KEY.test(key)) return v.slice(0, 16);
      if (key && SECRET_KEY.test(key) && v) return '<redacted>';
      if (key === 'installationId') return '00000000-0000-0000-0000-000000000000';
      return text(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x, k)]));
    return v;
  };
  return { value: (v) => walk(v), text };
}

// A last look at the exact bytes about to be written.
function assertClean(body, secrets, label) {
  for (const x of secrets) if (body.includes(x)) throw new Error(`${label} still contains a stored secret; nothing was written`);
  for (const [re] of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(body)) throw new Error(`${label} still matches ${re.source.slice(0, 24)}…; nothing was written`);
  }
  if (body.includes(os.homedir())) throw new Error(`${label} still contains the home folder; nothing was written`);
}

// ---- one app-server process, every line recorded ----

class RpcError extends Error {
  constructor(method, error) { super(`${method}: ${error?.message ?? 'failed'} (${error?.code ?? '?'})`); this.code = error?.code; this.data = error?.data; }
}

const live = new Set(); // our own children, so a signal can take them down

class Wire {
  constructor({ codex, flags, env, answers }) {
    this.codex = codex; this.flags = flags; this.env = env;
    this.answers = answers; // 'accept' | 'decline'
    this.lines = [];        // { t, dir, msg }
    this.inbox = [];        // parsed server -> client messages, in order
    this.pending = new Map();
    this.waiters = new Set();
    this.nextId = 1;
    this.stderr = '';
    this.exited = null;
  }

  start() {
    this.t0 = performance.now();
    this.child = spawn(this.codex, ['app-server', ...this.flags, '--listen', 'stdio://'], { env: this.env, cwd: SCRATCH, stdio: ['pipe', 'pipe', 'pipe'] });
    live.add(this.child);
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.stdin.on('error', () => {});
    this.gone = new Promise((resolve) => {
      const done = (why) => {
        if (this.exited) return;
        this.exited = why;
        live.delete(this.child);
        const err = new Error(`the app-server went away (${why})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        for (const w of [...this.waiters]) w.reject(err);
        resolve();
      };
      this.child.on('error', (err) => done(String(err?.message ?? err)));
      this.child.on('exit', (code, sig) => done(sig ? `signal ${sig}` : `exit ${code}`));
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
  }

  stamp() { return Math.round(performance.now() - this.t0); }

  write(msg) {
    this.lines.push({ t: this.stamp(), dir: 'out', msg });
    try { this.child.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
  }

  onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.lines.push({ t: this.stamp(), dir: 'in', raw: line }); return; }
    this.lines.push({ t: this.stamp(), dir: 'in', msg });
    this.inbox.push(msg);
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p) { if (msg.error) p.reject(new RpcError(p.method, msg.error)); else p.resolve(msg.result); }
    } else if (msg.id !== undefined) {
      const reply = answerFor(this.answers, msg);
      setTimeout(() => this.write({ id: msg.id, ...reply }), ANSWER_DELAY_MS);
    }
    for (const w of [...this.waiters]) w.check(msg);
  }

  request(method, params, ms = REQUEST_MS) {
    if (this.exited) return Promise.reject(new Error(`the app-server went away (${this.exited})`));
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    this.write({ id, method, params });
    return within(done, ms, method).finally(() => this.pending.delete(id));
  }

  notify(method, params) { this.write(params === undefined ? { method } : { method, params }); }

  mark() { return this.inbox.length; }

  // The first server message at or after `from` that passes the test, now or later.
  waitFor(test, { ms = REQUEST_MS, from = 0, label = 'message' } = {}) {
    const hit = this.inbox.slice(from).find(test);
    if (hit) return Promise.resolve(hit);
    if (this.exited) return Promise.reject(new Error(`the app-server went away (${this.exited})`));
    let w;
    const found = new Promise((resolve, reject) => {
      w = { check: (m) => { if (test(m)) resolve(m); }, reject };
      this.waiters.add(w);
    });
    return within(found, ms, label).finally(() => this.waiters.delete(w));
  }

  // Trailing notifications arrive after `turn/completed`; wait for a quiet spell.
  async settle(quiet = 1200, max = 8000) {
    const end = Date.now() + max;
    let seen = this.lines.length, since = Date.now();
    while (Date.now() < end && !this.exited) {
      await sleep(100);
      if (this.lines.length !== seen) { seen = this.lines.length; since = Date.now(); } else if (Date.now() - since >= quiet) return;
    }
  }

  // Ask it to leave (stdin closed), then insist.
  async close() {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch {}
    for (const [sig, ms] of [[null, 5000], ['SIGTERM', 3000], ['SIGKILL', 2000]]) {
      if (sig) { try { this.child.kill(sig); } catch {} }
      await Promise.race([this.gone, sleep(ms)]);
      if (this.exited) return;
    }
  }
}

// What the recorder says to each thing the app-server can ask.
function answerFor(answers, { method, params }) {
  const yes = answers === 'accept';
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: yes ? 'accept' : 'decline' } };
    case 'item/permissions/requestApproval': {
      const asked = params?.permissions ?? {};
      const granted = {};
      if (yes && asked.network) granted.network = asked.network;
      if (yes && asked.fileSystem) granted.fileSystem = asked.fileSystem;
      return { result: { permissions: granted, scope: 'turn' } };
    }
    // A question is not a permission: it always gets its first choice, whatever
    // the scenario does with approvals.
    case 'item/tool/requestUserInput':
      return { result: { answers: Object.fromEntries((params?.questions ?? []).map((q) => [q.id, { answers: [q.options?.[0]?.label ?? 'ok'] }])) } };
    // Never accepted: an elicitation comes from one of the user's own MCP servers.
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null } };
    case 'currentTime/read':
      return { result: { currentTimeAt: Math.floor(Date.now() / 1000) } };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: yes ? 'approved' : { denied: { rejection: 'declined by the fixture recorder' } } } };
    default:
      return { error: { code: -32601, message: `the fixture recorder does not answer ${method}` } };
  }
}

// ---- the scratch folder and what a run remembers ----

function resetWork() {
  if (!WORK.startsWith('/tmp/canopy-codex-rec/')) throw new Error(`refusing to empty ${WORK}`);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'notes.txt'), 'hello\n');
  const git = (...args) => spawnSync('git', args, { cwd: WORK, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Canopy Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'start');
}

// state.json: `threads` is every chat still to archive, `chats` maps a
// scenario to the chat its last recording made, which is what `resume`, `meta`
// and `history` read back. An archived chat can no longer be resumed, so to
// re-record one of those three alone, record `text` with it or pass
// --keep-threads on the run before.
const readState = () => {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  return { threads: Array.isArray(s.threads) ? s.threads : [], chats: s.chats && typeof s.chats === 'object' ? s.chats : {} };
};
const writeState = (s) => { fs.mkdirSync(SCRATCH, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n'); };
let recording = null; // the scenario being recorded
function remember(threadId) {
  const s = readState();
  if (!s.threads.includes(threadId)) s.threads.push(threadId);
  if (recording) s.chats[recording] = threadId;
  writeState(s);
}

// ---- steps the scenarios share ----

let turnsUsed = 0;

async function hello(wire) {
  const info = await wire.request('initialize', { clientInfo: CLIENT, capabilities: { experimentalApi: true } });
  wire.notify('initialized');
  return info;
}

// Ask (Canopy's default mode) unless a scenario says otherwise: read-only
// sandbox, approval on request. `serviceTier: null` means standard speed.
async function startThread(wire, extra = {}) {
  const res = await wire.request('thread/start', { cwd: WORK, model: MODEL, approvalPolicy: 'on-request', sandbox: 'read-only', serviceTier: null, ...extra }, THREAD_MS);
  if (res?.serviceTier && res.serviceTier !== 'default') throw new Error(`the thread came up on the "${res.serviceTier}" tier; refusing to spend on it`);
  remember(res.thread.id);
  return res;
}

const textInput = (text) => [{ type: 'text', text, text_elements: [] }];

// Starts one turn and returns its id; the caller decides how it ends.
async function startTurn(wire, threadId, text, extra = {}) {
  if (turnsUsed >= MAX_TURNS) throw new Error(`the turn budget (${MAX_TURNS}) is spent`);
  turnsUsed++;
  const res = await wire.request('turn/start', { threadId, input: textInput(text), effort: EFFORT, summary: 'auto', serviceTierForTurn: 'default', ...extra });
  return res.turn.id;
}

async function turnEnd(wire, threadId, turnId, from) {
  try {
    const done = await wire.waitFor((m) => m.method === 'turn/completed' && m.params?.turn?.id === turnId, { ms: TURN_MS, from, label: 'turn/completed' });
    await wire.settle();
    return done.params.turn;
  } catch (err) {
    await wire.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => {}); // stop spending
    throw err;
  }
}

async function oneTurn(wire, text, { thread = {}, turn = {} } = {}) {
  await hello(wire);
  const started = await startThread(wire, thread);
  const threadId = started.thread.id;
  const from = wire.mark();
  const turnId = await startTurn(wire, threadId, text, turn);
  const ended = await turnEnd(wire, threadId, turnId, from);
  return { threadId, turnId, ended };
}

// ---- scenarios ----

const SCENARIOS = {
  // A one-line answer, in the user's Codex exactly as Canopy would find it.
  text: {
    about: 'thread/start and a one-line answer, with the user\'s own MCP servers, plugins and hooks live',
    setup: 'user', answers: 'decline', turns: 1,
    run: (wire) => oneTurn(wire, 'Reply with exactly: OK'),
  },

  // What the picker, the sign-in check and the sidebar read. No turn.
  meta: {
    about: 'account/read, model/list, collaborationMode/list, thread/list for the scratch folder, thread/read of the text chat',
    setup: 'bare', answers: 'decline', turns: 0, needsText: true,
    async run(wire, state) {
      await hello(wire);
      await wire.request('account/read', { refreshToken: false });
      await wire.request('model/list', {});
      await wire.request('model/list', { includeHidden: true });
      await wire.request('collaborationMode/list', {});
      await wire.request('thread/list', { cwd: WORK, limit: 20 });
      await wire.request('thread/list', { cwd: WORK, limit: 20, useStateDbOnly: true, sortKey: 'updated_at' }).catch(() => {}); // the quick way: no scan of the rollout files
      await wire.request('thread/read', { threadId: state.chats.text, includeTurns: false });
      await wire.request('thread/read', { threadId: state.chats.text, includeTurns: true });
      await wire.request('thread/read', { threadId: '00000000-0000-7000-8000-000000000000', includeTurns: false }).catch(() => {}); // a chat that does not exist
    },
  },

  'command-approval': {
    about: 'Ask mode: a command that has to leave the read-only sandbox asks first; accepted',
    setup: 'bare', answers: 'accept', turns: 1,
    run: (wire) => oneTurn(wire, 'Run this exact shell command: touch approved.txt\nThen reply with exactly: DONE'),
  },

  'file-change-approval': {
    about: 'Ask mode: an apply_patch edit asks first; accepted',
    setup: 'bare', answers: 'accept', turns: 1,
    run: (wire) => oneTurn(wire, 'Use apply_patch to change the word hello to goodbye in notes.txt. Then reply with exactly: DONE'),
  },

  decline: {
    about: 'Ask mode: the same edit, declined',
    setup: 'bare', answers: 'decline', turns: 1,
    run: (wire) => oneTurn(wire, 'Use apply_patch to change the word hello to goodbye in notes.txt. If that is not allowed, do not try any other way: reply with exactly: DECLINED'),
  },

  interrupt: {
    about: 'a longer answer stopped part-way with turn/interrupt',
    setup: 'bare', answers: 'decline', turns: 1,
    async run(wire) {
      await hello(wire);
      const { thread } = await startThread(wire);
      const from = wire.mark();
      const turnId = await startTurn(wire, thread.id, 'Count from 1 to 300, one number per line, and nothing else.');
      try {
        await wire.waitFor((m) => m.method === 'item/agentMessage/delta', { ms: TURN_MS, from, label: 'the first text delta' });
        await sleep(300);
        await wire.request('turn/interrupt', { threadId: thread.id, turnId });
      } finally {
        await turnEnd(wire, thread.id, turnId, from);
      }
    },
  },

  'read-command': {
    about: 'commands Codex recognises as a read, a search and a file listing (commandActions)',
    setup: 'bare', answers: 'decline', turns: 1,
    run: (wire) => oneTurn(wire, 'Run these three shell commands, one at a time, each as its own command: `cat notes.txt`, then `grep -n hello notes.txt`, then `ls`. Then reply with exactly: DONE'),
  },

  // The prompt also asks for update_plan on purpose: on Codex 0.153.4 the model
  // answers that it has no such tool, which is why no fixture carries
  // turn/plan/updated from an ordinary turn.
  'command-output': {
    about: 'a command slow enough to stream its output (item/commandExecution/outputDelta); the model reports it has no update_plan tool',
    setup: 'bare', answers: 'decline', turns: 1,
    run: (wire) => oneTurn(wire, 'Use your update_plan tool to record a plan with exactly two steps, "Count slowly" and "Report back", the first one in progress. Then run this exact shell command: for i in 1 2 3; do echo line $i; sleep 0.5; done\nThen call update_plan again to mark both steps completed. Then reply with exactly: DONE'),
  },

  // Canopy's Plan mode: Codex's plan collaboration mode on a read-only sandbox.
  plan: {
    about: 'Plan mode: a turn in the plan collaboration mode, with one question back to the user if the model asks it',
    setup: 'bare', answers: 'decline', turns: 1,
    run: (wire) => oneTurn(wire, 'I want a second line added to notes.txt. First ask me exactly one multiple-choice question about which word the new line should say (options: world, there). Then give me your plan in two short steps. Do not make any changes.', {
      turn: { effort: undefined, collaborationMode: { mode: 'plan', settings: { model: MODEL, reasoning_effort: EFFORT, developer_instructions: null } } },
    }),
  },

  // Reopening a chat in a fresh process. No turn.
  resume: {
    about: 'thread/resume of the text chat in a new process (excludeTurns, then thread/turns/list), thread/name/set, and a second resume the deprecated way',
    setup: 'bare', answers: 'decline', turns: 0, needsText: true,
    async run(wire, state) {
      await hello(wire);
      const threadId = state.chats.text;
      const settings = { cwd: WORK, model: MODEL, approvalPolicy: 'on-request', sandbox: 'read-only', serviceTier: null };
      await wire.request('thread/resume', { threadId, ...settings, excludeTurns: true }, THREAD_MS);
      await wire.settle(800, 4000);
      await wire.request('thread/turns/list', { threadId });
      await wire.request('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50 });
      await wire.request('thread/name/set', { threadId, name: 'Canopy fixture chat' });
      await wire.settle(600, 3000);
      await wire.request('thread/read', { threadId, includeTurns: false });
      // The same chat again, already loaded, asking for its whole history at once.
      await wire.request('thread/resume', { threadId, ...settings }, THREAD_MS);
      await wire.settle(600, 3000);
      await wire.request('thread/resume', { threadId: '00000000-0000-7000-8000-000000000000', cwd: WORK }, THREAD_MS).catch(() => {}); // a chat that does not exist
    },
  },

  // What a reopened chat's transcript is rebuilt from. No turn, nothing loaded.
  history: {
    about: 'thread/turns/list (full items, oldest first) for the chat each tool scenario made, read without resuming them',
    setup: 'bare', answers: 'decline', turns: 0,
    async run(wire, state) {
      await hello(wire);
      for (const name of ['command-approval', 'file-change-approval', 'decline', 'interrupt', 'read-command', 'command-output', 'plan']) {
        const threadId = state.chats[name];
        if (!threadId) continue;
        await wire.request('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50 }).catch(() => {});
      }
      const any = state.chats.interrupt ?? state.chats['command-approval'];
      if (any) await wire.request('thread/turns/list', { threadId: any }).catch(() => {}); // the default view, for contrast
    },
  },

  // How Canopy's modes and the picker's switches look on the wire. No turn, and
  // the chats are ephemeral, so nothing is kept.
  modes: {
    about: 'thread/start for Ask, Accept edits, Auto and Full access, then thread/settings/update between turns: mode, model, effort, Fast on and off, Plan, and two values Codex should refuse',
    setup: 'bare', answers: 'decline', turns: 0,
    async run(wire) {
      await hello(wire);
      const start = (extra) => wire.request('thread/start', { cwd: WORK, model: MODEL, serviceTier: null, ephemeral: true, ...extra }, THREAD_MS).catch(() => null);
      const ask = await start({ approvalPolicy: 'on-request', sandbox: 'read-only' });
      await start({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
      await start({ approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' });
      await start({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
      await wire.request('thread/start', { cwd: WORK, ephemeral: true }, THREAD_MS).catch(() => null); // nothing chosen: the user's own defaults (the tier flag aside)
      await wire.settle(600, 3000);
      if (!ask) throw new Error('the Ask chat did not start');
      const threadId = ask.thread.id;
      const change = async (patch) => { await wire.request('thread/settings/update', { threadId, ...patch }).catch(() => {}); await wire.settle(400, 2000); };
      await change({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
      await change({ approvalsReviewer: 'auto_review' });
      await change({ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } });
      await change({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
      await change({ model: 'gpt-6.1-sol', effort: 'medium' });
      await change({ serviceTier: 'priority' });
      await change({ serviceTier: null });
      await change({ collaborationMode: { mode: 'plan', settings: { model: MODEL, reasoning_effort: EFFORT, developer_instructions: null } } });
      await change({ collaborationMode: { mode: 'default', settings: { model: MODEL, reasoning_effort: EFFORT, developer_instructions: null } } });
      await change({ model: 'no-such-model' });
      await change({ effort: 'no-such-effort' });
      await change({ serviceTier: 'no-such-tier' });
    },
  },

  // What opening a chat looks like in the user's Codex, before any turn. No turn.
  startup: {
    about: 'thread/start alone with the user\'s own set-up: MCP start-up, warnings and notices',
    setup: 'user', answers: 'decline', turns: 0,
    async run(wire) {
      await hello(wire);
      await startThread(wire);
      await wire.settle(4000, 45000);
    },
  },

  // What a chat moved here from the other maker starts with (src/core/handoff.mjs, CodexSession.carry): the old
  // chat's digest, put into the thread as a developer message before its first turn. The turn can only be answered
  // from that message; then the chat is read back the three ways Canopy reads one.
  inject: {
    about: 'thread/inject_items (a developer message) before the first turn, a turn answered from it, then thread/turns/list, thread/read and thread/list: is it read, and does it stay out of the user\'s message and the preview',
    setup: 'bare', answers: 'decline', turns: 1,
    async run(wire) {
      await hello(wire);
      const started = await startThread(wire);
      const threadId = started.thread.id;
      const digest = buildDigest([
        { kind: 'user-text', text: 'The code word for this project is TANGERINE. Remember it.' },
        { kind: 'assistant-text', text: 'Noted: the code word is TANGERINE.' },
      ], { fromModel: 'Opus 5.5', cwd: WORK, mode: 'default' }).text;
      await wire.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: forCodex(digest) }] }] });
      const from = wire.mark();
      const turnId = await startTurn(wire, threadId, 'Reply with only the code word.');
      await turnEnd(wire, threadId, turnId, from);
      await wire.request('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50 });
      await wire.request('thread/read', { threadId, includeTurns: false });
      await wire.request('thread/list', { cwd: WORK, limit: 20 });
    },
  },
};

// The free scenarios come last: they read back the chats the live ones made.
const DEFAULT_ORDER = ['text', 'command-approval', 'file-change-approval', 'decline', 'interrupt', 'read-command', 'command-output', 'plan', 'inject', 'resume', 'meta', 'history', 'modes', 'startup'];

// ---- running and writing ----

const describe = ({ dir, msg, raw, t }) => {
  if (raw !== undefined) return `${String(t).padStart(6)} ${dir === 'in' ? '<-' : '->'} (not JSON) ${raw.slice(0, 80)}`;
  const kind = msg.method ? (msg.id !== undefined ? 'request' : 'notify') : msg.error ? 'error' : 'result';
  const bits = [msg.method ?? `#${msg.id}`, kind];
  const p = msg.params ?? {};
  const item = p.item;
  if (item) bits.push(`${item.type}${item.status ? `:${item.status}` : ''}`);
  if (p.turn?.status) bits.push(`turn:${p.turn.status}`);
  if (p.status) bits.push(typeof p.status === 'string' ? p.status : JSON.stringify(p.status));
  if (msg.error) bits.push(JSON.stringify(msg.error).slice(0, 120));
  return `${String(t).padStart(6)} ${dir === 'in' ? '<-' : '->'} ${bits.join(' ')}`;
};

async function record(name, ctx) {
  const sc = SCENARIOS[name];
  const state = readState();
  if (sc.needsText && !state.chats.text) throw new Error(`"${name}" needs the text scenario recorded first`);
  if (sc.turns || !fs.existsSync(WORK)) resetWork();
  recording = name;
  const flags = [...BASE_FLAGS, ...(sc.setup === 'bare' ? ctx.bare : [])];
  const wire = new Wire({ codex: ctx.codex, flags, env: ctx.env, answers: sc.answers });
  wire.start();
  let failure = null;
  try { await sc.run(wire, state); } catch (err) { failure = err; }
  await wire.close();
  fs.writeFileSync(path.join(SCRATCH, `${name}.stderr.log`), wire.stderr);
  const note = { dir: 'note', scenario: name, about: sc.about, codex: ctx.version, model: MODEL, effort: EFFORT, setup: sc.setup, answers: sc.answers, flags: flags.map((f) => ctx.clean.text(f)), recorded: new Date().toISOString().slice(0, 10) };
  const rows = [note, ...wire.lines.map((l) => (l.raw !== undefined ? { ...l, raw: ctx.clean.text(l.raw) } : { ...l, msg: ctx.clean.value(l.msg) }))];
  if (print || failure) {
    console.log(`\n== ${name} (${wire.lines.length} lines${failure ? ', FAILED' : ''})`);
    for (const l of wire.lines) console.log(describe(l));
  }
  if (failure) throw new Error(`${name}: ${failure.message}${wire.stderr ? ` (stderr kept in ${SCRATCH}/${name}.stderr.log)` : ''}`);
  if (print) return;
  const body = neutralFixture(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assertClean(body, ctx.secrets, `codex-${name}.jsonl`);
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, `codex-${name}.jsonl`), body);
  console.log(`recorded codex-${name}.jsonl: ${wire.lines.length} lines`);
}

// Archives the chats earlier runs created, through Codex itself. A chat that
// never had a turn leaves nothing on disk ("no rollout found"), and neither
// does one that is already archived, so both count as nothing to do.
async function tidy(ctx) {
  const state = readState();
  if (!state.threads.length) return;
  const wire = new Wire({ codex: ctx.codex, flags: [...BASE_FLAGS, ...ctx.bare], env: ctx.env, answers: 'decline' });
  wire.start();
  const left = [];
  let archived = 0;
  try {
    await hello(wire);
    for (const threadId of state.threads) {
      try { await wire.request('thread/archive', { threadId }); archived++; } catch (err) { if (!/no rollout found/i.test(err.message)) left.push(threadId); }
    }
  } catch { for (const t of state.threads) if (!left.includes(t)) left.push(t); }
  await wire.close();
  writeState({ ...state, threads: left });
  console.log(`archived ${archived} test chat${archived === 1 ? '' : 's'}${left.length ? `, ${left.length} could not be archived (kept in ${STATE} for the next run)` : ''}`);
}

async function main() {
  if (list) {
    for (const name of DEFAULT_ORDER) console.log(`${name.padEnd(22)} ${SCENARIOS[name].turns ? 'live turn' : 'free     '}  ${SCENARIOS[name].about}`);
    return;
  }
  const wantTidy = argv.includes('tidy');
  const names = argv.filter((a) => a !== 'tidy');
  const all = !names.length && !wantTidy;
  const todo = all ? DEFAULT_ORDER : names;
  const unknown = todo.filter((n) => !SCENARIOS[n]);
  if (unknown.length) throw new Error(`no such scenario: ${unknown.join(', ')} (try --list)`);
  const planned = todo.reduce((n, name) => n + SCENARIOS[name].turns, 0);
  if (planned > MAX_TURNS) throw new Error(`these scenarios need ${planned} live turns, over the budget of ${MAX_TURNS}`);

  const env = codexEnv();
  const codex = findCodexBin(env);
  if (!codex) throw new Error('codex is not installed');
  const version = spawnSync(codex, ['--version'], { env, encoding: 'utf8', timeout: 15000 }).stdout?.trim() || 'unknown';
  const secrets = knownSecrets(env);
  const ctx = { codex, env, version, secrets, clean: makeSanitizer(secrets), bare: bareFlags(codex, env) };
  fs.mkdirSync(SCRATCH, { recursive: true });

  for (const name of todo) await record(name, ctx);
  if (turnsUsed) console.log(`live turns this run: ${turnsUsed}`);
  if ((all || wantTidy) && !keepThreads && !print) await tidy(ctx);
}

const bail = () => { for (const c of live) { try { c.kill('SIGKILL'); } catch {} } };
process.on('exit', bail);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { bail(); process.exit(1); });

let code = 0;
try { await main(); } catch (err) { console.error(`record failed: ${err?.message ?? err}`); code = 1; }
bail();
process.exit(code);

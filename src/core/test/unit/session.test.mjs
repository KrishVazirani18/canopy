// Session's state machine, driven by a scripted fake of the SDK's query()
// (fake-query.mjs): busy, the outbox, permissions, stopping, crash recovery,
// settings, trust. No claude process is started.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { UUID_RE, core, sleep, watch, within } from '../helpers.mjs';

const S = await core('session.mjs');
const T = await core('trust.mjs');
const E = await core('env.mjs');
const F = await core('facts.mjs');
const MEM = await core('memory.mjs');
const missing = S.__missing ? `session.mjs: ${S.__missing}` : (S.CORE_API >= 2 ? false : 'session.mjs is not CORE_API 2');
const noTrust = missing || (typeof T.folderTrustSync === 'function' ? false : 'trust.mjs does not export folderTrustSync');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-session-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BYPASS_NOTICE = 'Bypass permissions is not enabled for this session. Turn it on in your Claude Code settings first (the same as the terminal requires).';
const baseEnv = () => ({ PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });

// A Mac whose admin chose a prompt cache lifetime for everyone: Canopy leaves it alone, so there is nothing to check.
const adminTtl = E.skillBudgetChosen?.({}, null, { sources: [] }) === true; // an admin who set the skill listing's size

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    try { if (typeof s.dispose === 'function') await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); else s.close(); } catch { /* reported by the test itself */ }
  }
});

function make(opts = {}, script = {}) {
  const fake = createFake(script);
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: baseEnv(), trusted: true, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}

const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const turnEnd = (w, from = 0) => w.waitFor('turn-end', { ms: 5000, from });
const settle = (ms = 30) => sleep(ms);
const sendStates = (w, id) => w.all((e) => e.kind === 'send-state' && e.id === id).map((e) => e.state);
const controls = (run, method) => run.calls.filter((c) => c.method === method);

// ---- sending and busy ----

test('one send, one turn: result, busy, order and sequence numbers', { skip: missing }, async () => {
  const { s, fake, w } = make({ extended: ['send-state'] });
  const r = s.send('hello');
  assert.equal(r.ok, true);
  assert.match(r.id, UUID_RE);
  assert.equal(s.busy, true, 'busy is set before send() returns');
  await idle(w);

  const busy = w.of('busy');
  assert.deepEqual([busy[0].busy, busy[0].state], [true, 'starting']);
  assert.equal(busy.filter((e) => e.busy === false).length, 1);
  assert.deepEqual([busy.at(-1).busy, busy.at(-1).state], [false, 'idle']);
  for (const e of busy) assert.ok('queued' in e && 'background' in e);

  const end = w.of('turn-end');
  assert.equal(end.length, 1);
  assert.deepEqual(end[0].userUuids, [r.id]);
  assert.deepEqual([end[0].isError, end[0].interrupted, end[0].subtype], [false, false, 'success']);
  assert.ok(w.indexOf(end[0]) < w.indexOf(busy.at(-1)), 'the turn ends before busy clears');
  assert.equal(w.text(), 'ok');

  const seqs = w.events.map((e) => e.seq);
  assert.ok(seqs.every((n, i) => Number.isInteger(n) && (i === 0 || n > seqs[i - 1])), 'seq increases on every event');
  assert.deepEqual(sendStates(w, r.id), ['pending', 'written', 'queued', 'started', 'completed']);
  assert.deepEqual(s.snapshot().outbox, []);
  assert.equal(fake.starts, 1);
});

test('the message and the process options are what the plan specifies', { skip: missing }, async () => {
  const { s, fake, w } = make({ appVersion: '9.9.9', env: { ...baseEnv(), CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x', NODE_OPTIONS: '--inspect', MY_VAR: 'kept' } });
  const r = s.send('look at this', [{ mediaType: 'image/png', data: 'AAAA' }]);
  await idle(w);
  const run = fake.current;
  const o = run.options;
  assert.deepEqual(run.received[0], {
    type: 'user', uuid: r.id, session_id: '', origin: { kind: 'human' }, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'look at this' }] },
  });
  assert.equal(o.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  assert.equal(o.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS, '1');
  assert.equal(o.env.CLAUDE_AGENT_SDK_CLIENT_APP, 'canopy/9.9.9');
  assert.equal(o.env.MY_VAR, 'kept');
  // The prompt cache is left to Claude Code, as in the terminal: no lifetime is set, as a setting or a variable.
  assert.ok(!('promptCacheTtl' in (o.settings ?? {})));
  assert.ok(!('CLAUDE_CODE_PROMPT_CACHE_TTL' in o.env));
  assert.ok(!('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' in o.env));
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'NODE_OPTIONS']) assert.ok(!(k in o.env), `${k} reached the child`);
  assert.ok(!('sessionId' in o), 'no pre-assigned session id (it breaks attach and resume)');
  assert.ok(!('resume' in o));
  assert.equal(o.cwd, work);
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.enableFileCheckpointing, true);
  assert.equal(o.forwardSubagentText, true);
  assert.equal(o.promptSuggestions, true);
  assert.equal(o.extraArgs?.['thinking-display'], 'summarized');
  assert.deepEqual(o.toolConfig, { askUserQuestion: { previewFormat: 'markdown' } });
  assert.equal(typeof o.canUseTool, 'function');
  assert.equal(typeof o.spawnClaudeCodeProcess, 'function');
  assert.ok(!('allowDangerouslySkipPermissions' in o));
});

test('every chat is told the facts about Canopy, word for word, before the personal memory note', { skip: missing }, async () => {
  // The benchmarked text (see the note at the top of facts.mjs). One changed character re-bills every chat.
  assert.equal(F.CANOPY_FACTS, [
    'You\'re running inside Canopy, a Mac app for working with Claude.',
    '- The user reads your last message first; earlier steps are collapsed. Put everything they need there: the result, what\'s left, what you need from them.',
    '- The user may run several chats at once. If a message seems meant for another chat, ask.',
    '- For unrelated work, you can suggest starting a new chat.',
    '- A shell command in a ```bash block of yours has a Run button: the user can run it in a terminal inside Canopy, in this folder, and what it prints comes back to you. When a step needs a terminal you can\'t use (a sign-in that opens the browser, a command that asks questions), give it that way and say to click Run, instead of asking them to open the Terminal app.',
  ].join('\n'));

  // With no memory to add, and with the memory note switched off, the facts are the whole of it.
  const plain = make();
  await plain.s.warm();
  assert.deepEqual(plain.fake.current.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: F.CANOPY_FACTS });
  const off = make({ personalMemory: false });
  await off.s.warm();
  assert.equal(off.fake.current.options.systemPrompt.append, F.CANOPY_FACTS);

  // With one, the facts come first and the note after, the same bytes in two chats.
  const dir = path.join(home, '.claude', 'projects', MEM.projectSlug(home), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Short replies](short-replies.md)\n');
  try {
    const a = make();
    const b = make();
    await a.s.warm();
    await b.s.warm();
    const append = a.fake.current.options.systemPrompt.append;
    assert.ok(append.startsWith(`${F.CANOPY_FACTS}\n\n# The user's personal memory\n`));
    assert.ok(append.endsWith('- [Short replies](short-replies.md)'));
    assert.equal(b.fake.current.options.systemPrompt.append, append);

    // A memory saved while the chat is open does not change what the chat was told: its next process says the same.
    a.s.send('one');
    await idle(a.w);
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Short replies](short-replies.md)\n- [Likes tables](tables.md)\n');
    await a.s.stop();
    const mark = a.w.mark();
    a.s.send('two');
    await idle(a.w, mark);
    assert.equal(a.fake.starts, 2);
    assert.equal(a.fake.current.options.systemPrompt.append, append);
    // A chat started after that has the new note.
    const later = make();
    await later.s.warm();
    assert.ok(later.fake.current.options.systemPrompt.append.endsWith('- [Likes tables](tables.md)'));
  } finally { fs.rmSync(path.join(home, '.claude', 'projects'), { recursive: true, force: true }); }
});

test('messages between chats are left to Claude Code\'s own rule: Canopy never tells it to accept them all', { skip: missing }, async () => {
  const flags = async (opts) => { const { s, fake } = make(opts); await s.warm(); return fake.current.options.settings ?? {}; };
  // Accepting them all would let a chat that runs without asking act on what any other chat sends it.
  for (const opts of [undefined, { fast: true }, { permissionMode: 'bypassPermissions', allowBypass: true }]) {
    assert.ok(!('crossSessionInbound' in await flags(opts)), JSON.stringify(opts ?? {}));
  }
  // Their own choice is theirs to make, in their own settings file: it is read by Claude Code, not passed on by Canopy.
  const user = path.join(home, '.claude', 'settings.json');
  try {
    fs.writeFileSync(user, JSON.stringify({ crossSessionInbound: 'accept' }));
    assert.ok(!('crossSessionInbound' in await flags()));
  } finally { fs.rmSync(user, { force: true }); }
});

test('the skill listing gets the room a 200k chat gives it, unless someone chose a size', { skip: missing || adminTtl }, async () => {
  const start = async (opts) => { const { s, fake } = make(opts); await s.warm(); return fake.current.options; };
  assert.equal((await start()).env.SLASH_COMMAND_TOOL_CHAR_BUDGET, '8000');
  // Their own variable reaches Claude Code as it is.
  assert.equal((await start({ env: { ...baseEnv(), SLASH_COMMAND_TOOL_CHAR_BUDGET: '50000' } })).env.SLASH_COMMAND_TOOL_CHAR_BUDGET, '50000');
  // A size in their settings: the variable would beat it, so it is not set.
  const user = path.join(home, '.claude', 'settings.json');
  for (const set of [{ skillListingBudgetFraction: 0.05 }, { skillListingMaxDescChars: 4000 }, { env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: '9' } }]) {
    fs.writeFileSync(user, JSON.stringify(set));
    try { assert.ok(!('SLASH_COMMAND_TOOL_CHAR_BUDGET' in (await start()).env), JSON.stringify(set)); } finally { fs.rmSync(user, { force: true }); }
  }
});

test('the prompt cache lifetime is left to Claude Code, as in the terminal', { skip: missing }, async () => {
  const start = async (opts) => { const { s, fake } = make(opts); await s.warm(); return fake.current.options; };
  for (const o of [await start(), await start({ fast: true })]) {
    assert.ok(!('promptCacheTtl' in (o.settings ?? {})));
    assert.ok(!('CLAUDE_CODE_PROMPT_CACHE_TTL' in o.env));
  }
  // The user's own variable reaches Claude Code as it is.
  assert.equal((await start({ env: { ...baseEnv(), CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })).env.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
});

test('the Stop hook only listens: it says which prompts are scheduled to wake the chat', { skip: missing }, async () => {
  const jobs = [{ id: 'a1', schedule: '*/5 * * * *', recurring: true, prompt: 'check the deploy' }, { id: 'b2', schedule: '0 9 1 1 *', recurring: false, prompt: 'say hi' }];
  let now = jobs;
  const { s, fake, w } = make({}, { crons: () => now });
  assert.equal(s.scheduledCount, 0);
  s.send('check the deploy every five minutes');
  await idle(w);
  const stop = fake.current.options.hooks.Stop;
  assert.deepEqual(Object.keys(fake.current.options.hooks), ['Stop'], 'no other hook is registered');
  assert.equal(stop.length, 1);
  assert.equal(s.scheduledCount, 2);
  assert.deepEqual(s.scheduled, [{ id: 'a1', schedule: '*/5 * * * *', recurring: true }, { id: 'b2', schedule: '0 9 1 1 *', recurring: false }], 'the prompts themselves are not kept');
  // It never changes what Claude does, whatever it is handed.
  for (const input of [{ hook_event_name: 'Stop', session_crons: jobs }, { hook_event_name: 'Stop' }, { hook_event_name: 'SubagentStop', session_crons: [] }, null, 'junk']) {
    assert.deepEqual(await stop[0].hooks[0](input, undefined, {}), {});
  }
  assert.equal(s.scheduledCount, 0, 'a Stop that names none (an older Claude Code names nothing at all) means none');

  // Without a process there is nothing to keep alive; Claude Code brings the prompts back with the conversation.
  now = jobs.slice(0, 1);
  const mark = w.mark();
  s.send('again');
  await idle(w, mark);
  assert.equal(s.scheduledCount, 1);
  await s.stop();
  assert.equal(s.scheduledCount, 0);
  const again = w.mark();
  s.send('and again');
  await w.waitFor('text-delta', { ms: 3000, from: again });
  assert.equal(fake.starts, 2);
  assert.equal(s.scheduledCount, 1, 'known again as soon as the chat runs, before its next reply ends');
  await idle(w, again);
  // A hook of an old process says nothing about the chat now.
  await fake.runs[0].options.hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', session_crons: [] });
  assert.equal(s.scheduledCount, 1);
});

test('the environment may be a getter, read again at every start', { skip: missing }, async () => {
  let n = 0;
  const { s, fake, w } = make({ env: () => ({ ...baseEnv(), START: String(++n) }) });
  s.send('one');
  await idle(w);
  await s.stop();
  const mark = w.mark();
  s.send('two');
  await idle(w, mark);
  assert.deepEqual(fake.runs.map((r) => r.options.env.START), ['1', '2']);
});

test('a second send during a turn keeps busy on until both are answered', { skip: missing }, async () => {
  const { s, fake, w } = make({ extended: ['send-state'] });
  const a = s.send('first');
  const release = fake.current.hold();
  await w.waitFor('text-delta', { ms: 3000 });
  const b = s.send('second');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === b.id && e.state === 'queued', { ms: 3000 });
  assert.equal(w.find((e) => e.kind === 'busy' && e.busy === false), null);
  release();
  await idle(w);

  const ends = w.of('turn-end');
  assert.deepEqual(ends.flatMap((e) => e.userUuids).sort(), [a.id, b.id].sort());
  const off = w.all((e) => e.kind === 'busy' && e.busy === false);
  assert.equal(off.length, 1, 'no busy:false between the two turns');
  assert.ok(w.indexOf(off[0]) > w.indexOf(ends.at(-1)));
  assert.equal(fake.starts, 1);
  assert.deepEqual(s.snapshot().outbox, []);
});

test('an older CLI without state or lifecycle frames still gets correct busy', { skip: missing }, async () => {
  const { s, fake, w } = make({ extended: ['send-state'] }, { stateEvents: false, capabilities: [] });
  const a = s.send('first');
  const release = fake.current.hold();
  await w.waitFor('text-delta', { ms: 3000 });
  const b = s.send('second');
  await settle();
  release();
  await idle(w);
  const ends = w.of('turn-end');
  assert.equal(ends.length, 2);
  const off = w.all((e) => e.kind === 'busy' && e.busy === false);
  assert.equal(off.length, 1);
  assert.ok(w.indexOf(off[0]) > w.indexOf(ends[1]));
  assert.equal(sendStates(w, a.id).at(-1), 'completed');
  assert.equal(sendStates(w, b.id).at(-1), 'completed');
  assert.deepEqual(s.snapshot().outbox, []);
});

test('a turn Claude Code starts by itself shows as busy', { skip: missing }, async () => {
  const { s, fake, w } = make();
  await s.warm();
  assert.equal(s.busy, false);
  const mark = w.mark();
  fake.current.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  const on = await w.waitFor((e) => e.kind === 'busy' && e.busy, { ms: 2000, from: mark });
  assert.equal(on.state, 'running');
  fake.current.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await idle(w, mark);
  fake.current.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await settle();
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false, mark).length, 1, 'a repeated idle frame is not a second busy:false');
});

test('invalid sends are refused before anything starts', { skip: missing }, async () => {
  const { s, fake, w } = make();
  const png = { mediaType: 'image/png', data: 'AAAA' };
  const cases = [
    [42, [], {}], [null, [], {}], ['', [], {}], ['   ', [], {}], ['x'.repeat(1024 * 1024 + 1), [], {}],
    ['hi', 'not-a-list', {}], ['hi', Array.from({ length: 21 }, () => png), {}], ['hi', [{ mediaType: 'image/svg+xml', data: 'AAAA' }], {}],
    ['hi', [{ mediaType: 'image/png', data: 'not base64 !!' }], {}], ['hi', [null], {}],
    ['hi', [], { id: 'not-a-uuid' }], ['hi', [], { priority: 'urgent' }],
  ];
  for (const [text, images, opts] of cases) {
    const mark = w.mark();
    const r = s.send(text, images, opts);
    assert.deepEqual([r.ok, r.code], [false, 'invalid-input'], JSON.stringify([String(text).slice(0, 12), opts]));
    assert.equal(typeof r.message, 'string');
    assert.ok(!('error' in r), 'results never use an `error` key');
    const ev = w.find('error', mark);
    assert.deepEqual([ev.code, ev.message], ['invalid-input', r.message]);
  }
  assert.equal(fake.starts, 0);
  assert.equal(s.busy, false);
  const ok = s.send('hi', [], { id: randomUUID(), priority: 'next' });
  assert.equal(ok.ok, true);
  await idle(w);
  assert.equal(fake.current.received[0].priority, 'next');
});

test('an error reported while a turn runs is followed by a fresh busy event', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.send('first');
  const release = fake.current.hold();
  await w.waitFor('text-delta', { ms: 3000 });
  const mark = w.mark();
  assert.equal(s.send(42).ok, false);
  const after = w.events.slice(mark).filter((e) => e.kind === 'error' || e.kind === 'busy');
  assert.deepEqual(after.map((e) => e.kind), ['error', 'busy']);
  assert.equal(after[1].busy, true, 'the renderer clears busy on every error, so core says again that work continues');
  release();
  await idle(w);
});

test('turn-end carries the accounting the UI needs', { skip: missing }, async () => {
  const { s, w } = make();
  s.send('hello');
  const end = await turnEnd(w);
  assert.equal(typeof end.cost, 'number');
  assert.ok(Math.abs(end.turnCost - 0.0005) < 1e-9);
  assert.equal(end.contextTokens, 105);
  assert.equal(end.contextWindow, 200000);
  assert.equal(end.sessionId, s.sessionId);
  assert.equal(end.errorCode ?? null, null);
  assert.deepEqual(end.errors, []);
  assert.equal(end.coldStart, true, 'the first turn was sent before the process was ready');
  await idle(w);
  const mark = w.mark();
  s.send('again');
  const second = await turnEnd(w, mark);
  assert.equal(second.coldStart, false);
});

// ---- startup, meta, snapshot ----

test('warm starts the process once and publishes one full meta per process', { skip: missing }, async () => {
  const { s, fake, w } = make();
  const [a, b] = await Promise.all([s.warm(), s.warm()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(fake.starts, 1);
  s.send('one');
  await idle(w);
  const mark = w.mark();
  s.send('two');
  await idle(w, mark);
  const full = w.all((e) => e.kind === 'meta' && Array.isArray(e.commands));
  assert.equal(full.length, 1);
  const meta = full[0];
  assert.equal(meta.commands[0].name, 'clear');
  assert.equal(meta.models[0].value, 'haiku');
  assert.equal(meta.mode, 'default');
  assert.equal(meta.version, '2.1.322');
  assert.deepEqual([meta.account.email, meta.account.org], ['tester@example.com', 'Test Org']);
  assert.equal(meta.outputStyle, 'default');
  assert.equal(meta.restricted, false);
  assert.ok(Number.isFinite(meta.startupMs));
  assert.deepEqual(w.of('init').map((e) => !!e.first), [true, false]);
  assert.equal(s.snapshot().meta.commands[0].name, 'clear');
  assert.ok(!JSON.stringify(w.events).includes('fake-messaging.sock'), 'the messaging socket path is never forwarded');
});

test('snapshot keeps the old fields and adds the reload state', { skip: missing }, async () => {
  const { s, fake, w } = make({ model: 'haiku' }, { reply: async (_msgs, run) => { await run.useTool('Write', { file_path: '/tmp/a', content: 'x' }); run.say('done'); } });
  const fresh = s.snapshot();
  for (const k of ['sessionId', 'busy', 'settings', 'pending', 'meta', 'state', 'lifecycle', 'seq', 'turn', 'outbox', 'tasks', 'backgroundTasks', 'lastError', 'restarts', 'pid', 'restricted', 'risky', 'degraded', 'model', 'mode']) assert.ok(k in fresh, `snapshot.${k}`);
  assert.deepEqual([fresh.busy, fresh.lifecycle, fresh.sessionId, fresh.pid, fresh.lastError], [false, 'new', null, null, null]);
  assert.ok('permissionMode' in fresh.settings);

  const r = s.send('write it');
  const p = await w.waitFor('permission', { ms: 3000 });
  const mid = s.snapshot();
  assert.equal(mid.busy, true);
  assert.equal(mid.state, 'requires_action');
  assert.deepEqual(mid.pending.map((x) => x.id), [p.id]);
  assert.deepEqual(mid.outbox, [{ id: r.id, text: 'write it', images: 0, state: 'started' }]);
  assert.ok(mid.turn.some((e) => e.kind === 'tool-start'), 'the turn in flight can be redrawn');
  assert.equal(mid.seq, w.events.at(-1).seq);
  assert.match(mid.sessionId, UUID_RE);
  assert.doesNotThrow(() => structuredClone(mid), 'a snapshot can cross IPC');
  s.respond(p.id, { action: 'allow' });
  await idle(w);
  const done = s.snapshot();
  assert.deepEqual([done.busy, done.state, done.turn.length, done.pending.length], [false, 'idle', 0, 0]);
  assert.equal(fake.starts, 1);
});

test('raw events need debug, and gated kinds need extended', { skip: missing }, async () => {
  const quiet = make();
  quiet.s.send('hi');
  await idle(quiet.w);
  quiet.fake.current.emit({ type: 'from_the_future', payload: 1 });
  quiet.fake.current.emit({ type: 'system', subtype: 'from_the_future' });
  await settle();
  assert.equal(quiet.w.of('raw').length, 0);
  for (const kind of S.EXTENDED_KINDS) assert.equal(quiet.w.of(kind).length, 0, `${kind} without extended`);

  const loud = make({ debug: true, extended: true });
  loud.s.send('hi');
  await idle(loud.w);
  loud.fake.current.emit({ type: 'from_the_future', payload: 1 });
  await loud.w.waitFor('raw', { ms: 2000 });
  assert.ok(loud.w.of('send-state').length > 0);
});

test('hook frames: only session hooks and failures unless asked for', { skip: missing }, async () => {
  const hook = (subtype, event, extra = {}) => ({ type: 'system', subtype, hook_id: `h-${event}`, hook_name: event, hook_event: event, ...extra });
  const frames = [
    hook('hook_started', 'PreToolUse'), hook('hook_response', 'PreToolUse', { output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success' }),
    hook('hook_started', 'SessionStart'), hook('hook_response', 'PostToolUse', { output: '', stdout: '', stderr: 'blocked', exit_code: 2, outcome: 'error' }),
  ];
  const plain = make();
  await plain.s.warm();
  for (const m of frames) plain.fake.current.emit(m);
  await settle();
  assert.deepEqual(plain.w.of('hook').map((e) => e.name), ['SessionStart', 'PostToolUse']);
  const all = make({ extended: ['hooks'] });
  await all.s.warm();
  for (const m of frames) all.fake.current.emit(m);
  await settle();
  assert.equal(all.w.of('hook').length, 4);
});

test('an unchanged command list is not announced again', { skip: missing }, async () => {
  const { s, fake, w } = make();
  await s.warm();
  const same = [{ name: 'clear', description: 'Clear the conversation', argumentHint: '' }];
  const more = [...same, { name: 'deploy', description: 'Deploy', argumentHint: '' }];
  for (const commands of [same, more, more]) fake.current.emit({ type: 'system', subtype: 'commands_changed', commands });
  await settle();
  const changed = w.of('commands-changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].commands.length, 2);
  assert.equal(s.snapshot().meta.commands.length, 2);
});

test('tasks and background work are tracked, and published when asked for', { skip: missing }, async () => {
  const { s, fake, w } = make({ extended: ['tasks'] });
  await s.warm();
  fake.current.emit({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_1', description: 'Explore', subagent_type: 'Explore' });
  fake.current.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'Explore' }, { task_id: 'amb', task_type: 'x', description: 'housekeeping', ambient: true }] });
  fake.current.emit({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'Done', output_file: '' });
  await settle();
  const last = w.of('tasks').at(-1);
  assert.deepEqual(last.tasks.map((t) => [t.taskId, t.status]), [['t1', 'completed']]);
  assert.deepEqual(last.background.map((t) => t.taskId), ['t1'], 'ambient tasks are not shown');
  assert.equal(w.of('busy').at(-1)?.background ?? s.snapshot().backgroundTasks.length, 1);
  assert.deepEqual(s.snapshot().tasks.map((t) => t.taskId), ['t1']);
});

test('a shown suggestion is withdrawn when the user sends something else', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.send('one');
  await idle(w);
  fake.current.emit({ type: 'prompt_suggestion', suggestion: 'run the tests' });
  await w.waitFor((e) => e.kind === 'suggestion' && e.text === 'run the tests', { ms: 2000 });
  const mark = w.mark();
  s.send('two');
  assert.deepEqual(w.all('suggestion', mark).map((e) => e.text), ['']);
  await idle(w, mark);
  const again = w.mark();
  s.send('three');
  await idle(w, again);
  assert.equal(w.all('suggestion', again).length, 0, 'nothing to withdraw when none was shown');
});

// ---- permissions ----

const SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
];

// A session whose every turn asks once for `tool` and records the answer the CLI would get.
function asking(tool, input, ctx = {}, opts = {}, script = {}) {
  const answers = [];
  const made = make(opts, { ...script, reply: async (_msgs, run) => { answers.push(await run.useTool(tool, input, ctx)); if (!run.current?.aborted) run.say('done'); } });
  let mark = 0;
  const ask = async (text = 'go') => {
    mark = made.w.mark();
    made.s.send(text);
    return made.w.waitFor('permission', { ms: 3000, from: mark });
  };
  // Resolves when the turn started by the last ask() is over.
  const answered = () => idle(made.w, mark);
  return { ...made, answers, ask, answered };
}

test('a permission request carries what the card needs; Allow returns the input unchanged', { skip: missing }, async () => {
  const input = { file_path: '/tmp/note.txt', content: 'hi' };
  const { s, w, answers, ask, answered } = asking('Write', input, { suggestions: SUGGESTIONS.slice(1, 2), title: 'Create note.txt?', displayName: 'Write', description: 'note.txt', decisionReason: 'default mode', blockedPath: '/tmp/note.txt' });
  const p = await ask();
  assert.deepEqual([p.type, p.toolName, p.hasSuggestions, p.title, p.displayName, p.description, p.reason, p.blockedPath], ['tool', 'Write', true, 'Create note.txt?', 'Write', 'note.txt', 'default mode', '/tmp/note.txt']);
  assert.deepEqual(p.input, input);
  assert.deepEqual(p.suggestions, SUGGESTIONS.slice(1, 2));
  assert.match(p.toolUseId, /^toolu_/);
  assert.equal(p.sessionId, s.sessionId);
  assert.equal(p.defaultToNo, false);
  assert.equal(s.busy, true);
  assert.equal(w.of('busy').at(-1).state, 'requires_action');

  assert.deepEqual(s.respond(p.id, { action: 'allow' }), { ok: true });
  await answered();
  assert.deepEqual(answers[0], { behavior: 'allow', updatedInput: input, toolUseID: p.toolUseId, decisionClassification: 'user_temporary' });
  assert.deepEqual(w.of('permission-resolved').map((e) => e.id), [p.id]);
  assert.equal(w.of('tool-result').length, 1);
});

test('Allow may carry an edited input for a tool, and only a plain object', { skip: missing }, async () => {
  const input = { command: 'rm -rf build' };
  const { s, answers, ask, answered } = asking('Bash', input);
  s.respond((await ask()).id, { action: 'allow', input: { command: 'rm -rf ./build' } });
  await answered();
  s.respond((await ask()).id, { action: 'allow', input: 'rm -rf /' });
  await answered();
  s.respond((await ask()).id, { action: 'allow', input: ['x'] });
  await answered();
  assert.deepEqual(answers.map((a) => a.updatedInput), [{ command: 'rm -rf ./build' }, input, input]);
});

test('Always applies the offered suggestions, says what was granted, and tracks the mode', { skip: missing }, async () => {
  const { s, w, answers, ask, answered } = asking('Bash', { command: 'npm test' }, { suggestions: SUGGESTIONS });
  const p = await ask();
  s.respond(p.id, { action: 'always' });
  await answered();
  const a = answers[0];
  assert.equal(a.behavior, 'allow');
  assert.equal(a.decisionClassification, 'user_permanent');
  assert.deepEqual(a.updatedPermissions, SUGGESTIONS.slice(0, 2), 'the bypass suggestion is dropped: this session may not bypass');
  assert.equal(s.mode, 'acceptEdits');
  const notice = w.find((e) => e.kind === 'notice' && e.code === 'granted');
  assert.ok(notice, 'a notice says what was granted');
  assert.equal(notice.grants.length, 2);
  assert.match(notice.text, /Bash\(npm test:\*\)/);
  assert.match(notice.text, /accept edits/i);
});

test('Always: picks by index, session scope, and never rules from the caller', { skip: missing }, async () => {
  const { s, answers, ask, answered } = asking('Bash', { command: 'npm test' }, { suggestions: SUGGESTIONS });
  s.respond((await ask()).id, { action: 'always', pick: [0], scope: 'session' });
  await answered();
  assert.deepEqual(answers[0].updatedPermissions, [{ ...SUGGESTIONS[0], destination: 'session' }]);

  const evil = { type: 'setMode', mode: 'bypassPermissions', destination: 'session' };
  s.respond((await ask()).id, { action: 'always', pick: [0, 7, -1, 'x'], updatedPermissions: [evil], suggestions: [evil], grants: [evil] });
  await answered();
  assert.deepEqual(answers[1].updatedPermissions, [SUGGESTIONS[0]]);

  s.respond((await ask()).id, { action: 'always', pick: [2] });
  await answered();
  assert.equal(answers[2].behavior, 'allow');
  assert.ok(!answers[2].updatedPermissions?.length, 'picking only the bypass suggestion grants nothing');
  assert.notEqual(s.mode, 'bypassPermissions');
});

test('with bypass allowed for the session, an offered bypass mode can be granted', { skip: missing }, async () => {
  const { s, answers, ask, answered } = asking('Bash', { command: 'x' }, { suggestions: SUGGESTIONS.slice(2) }, { allowBypass: true });
  s.respond((await ask()).id, { action: 'always' });
  await answered();
  assert.deepEqual(answers[0].updatedPermissions, SUGGESTIONS.slice(2));
  assert.equal(s.mode, 'bypassPermissions');
});

test('no Always when Claude Code says not to offer it', { skip: missing }, async () => {
  const { s, w, answers, ask, answered } = asking('Bash', { command: 'x' }, { suggestions: SUGGESTIONS, suppressAlwaysAllowRule: true });
  const p = await ask();
  assert.deepEqual([p.hasSuggestions, p.suggestions], [false, []]);
  s.respond(p.id, { action: 'always' });
  await answered();
  assert.equal(answers[0].behavior, 'allow');
  assert.ok(!answers[0].updatedPermissions?.length);
  assert.equal(w.find((e) => e.kind === 'notice' && e.code === 'granted'), null);
});

test('Deny: message, classification, and stopping only when asked', { skip: missing }, async () => {
  const { s, w, answers, ask, answered } = asking('Bash', { command: 'x' });
  s.respond((await ask()).id, { action: 'deny', message: 'not that one' });
  await answered();
  s.respond((await ask()).id, { action: 'deny' });
  await answered();
  s.respond((await ask()).id, 'garbage');
  await answered();
  s.respond((await ask()).id, { action: 'deny', stop: true });
  await answered();
  assert.deepEqual(answers.map((a) => [a.behavior, a.decisionClassification, !!a.interrupt]), [['deny', 'user_reject', false], ['deny', 'user_reject', false], ['deny', 'user_reject', false], ['deny', 'user_reject', true]]);
  assert.equal(answers[0].message, 'not that one');
  assert.ok(answers[1].message.length > 0, 'a deny always has a message');
  assert.ok(answers.every((a) => /^toolu_/.test(a.toolUseID)));
  assert.equal(w.of('turn-end').at(-1).interrupted, true, 'deny with stop ends the turn as interrupted');
});

test('answering a request that is gone is reported as stale', { skip: missing }, async () => {
  const { s, w, ask, answered } = asking('Bash', { command: 'x' });
  const p = await ask();
  assert.equal(s.respond(p.id, { action: 'allow' }).ok, true);
  const mark = w.mark();
  const again = s.respond(p.id, { action: 'allow' });
  assert.deepEqual([again.ok, again.code], [false, 'stale']);
  const unknown = s.respond(987654321, { action: 'allow' });
  assert.deepEqual([unknown.ok, unknown.code], [false, 'stale']);
  assert.deepEqual(w.all('permission-resolved', mark).map((e) => [e.id, e.stale]), [[p.id, true], [987654321, true]]);
  await answered();
});

test('permission ids are unique across sessions', { skip: missing }, async () => {
  const a = asking('Bash', { command: 'a' });
  const b = asking('Bash', { command: 'b' });
  const [pa, pb] = await Promise.all([a.ask(), b.ask()]);
  assert.notEqual(pa.id, pb.id);
  assert.deepEqual(a.s.respond(pb.id, { action: 'allow' }).code, 'stale', "one session cannot answer another's request");
  a.s.respond(pa.id, { action: 'allow' });
  b.s.respond(pb.id, { action: 'allow' });
  await Promise.all([a.answered(), b.answered()]);
});

test('approving a plan switches the mode in the same answer, with no later control call', { skip: missing }, async () => {
  const { s, fake, answers, ask, answered } = asking('ExitPlanMode', { plan: '1. Write note.txt' }, {}, { permissionMode: 'plan' });
  const p = await ask();
  assert.equal(p.type, 'plan');
  s.respond(p.id, { action: 'plan-approve', mode: 'acceptEdits', plan: '1. Write note.txt\n2. Tell the user' });
  assert.equal(s.mode, 'acceptEdits', 'the mode is recorded before respond() returns');
  await answered();
  await settle(60);
  assert.deepEqual(answers[0], {
    behavior: 'allow', updatedInput: { plan: '1. Write note.txt\n2. Tell the user' }, toolUseID: p.toolUseId, decisionClassification: 'user_temporary',
    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  });
  assert.equal(controls(fake.current, 'setPermissionMode').length, 0);
  assert.equal(s.snapshot().settings.permissionMode, 'acceptEdits');
});

test('plan approval never grants a mode the session may not use, and rejection keeps planning', { skip: missing }, async () => {
  const { s, answers, ask, answered } = asking('ExitPlanMode', { plan: 'P' }, {}, { permissionMode: 'plan' });
  for (const answer of [{ action: 'plan-approve', mode: 'bypassPermissions' }, { action: 'plan-approve' }, { action: 'plan-approve', mode: 'plan' }, { action: 'plan-approve', mode: 'nonsense' }]) {
    s.respond((await ask()).id, answer);
    await answered();
    const a = answers.at(-1);
    assert.equal(a.behavior, 'allow');
    assert.deepEqual(a.updatedInput, { plan: 'P' });
    assert.ok(!a.updatedPermissions, JSON.stringify(answer));
  }
  assert.notEqual(s.mode, 'bypassPermissions');
  s.respond((await ask()).id, { action: 'plan-reject', message: 'add tests first' });
  await answered();
  const rejected = answers.at(-1);
  assert.deepEqual([rejected.behavior, !!rejected.interrupt], ['deny', false]);
  assert.match(rejected.message, /add tests first/);
});

const QUESTION = { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: true }] };

test('question answers: only the questions asked, lists joined', { skip: missing }, async () => {
  const { s, answers, ask, answered } = asking('AskUserQuestion', QUESTION);
  const p = await ask();
  assert.equal(p.type, 'question');
  s.respond(p.id, { action: 'answers', answers: { 'Which color?': ['Red', 'Blue'], 'A question nobody asked': 'x', __proto__: { polluted: true } }, annotations: { 'Which color?': { notes: 'both please' }, Other: { notes: 'x' } } });
  await answered();
  const a = answers[0];
  assert.equal(a.behavior, 'allow');
  assert.deepEqual(a.updatedInput.answers, { 'Which color?': 'Red, Blue' });
  assert.deepEqual(a.updatedInput.questions, QUESTION.questions);
  assert.deepEqual(a.updatedInput.annotations, { 'Which color?': { notes: 'both please' } });
  assert.equal({}.polluted, undefined);
});

test('skipping a question is told to Claude Code as unanswered, not as a denial', { skip: missing }, async () => {
  const modern = asking('AskUserQuestion', QUESTION);
  modern.s.respond((await modern.ask()).id, { action: 'question-skip', how: 'replied_in_chat' });
  await modern.answered();
  modern.s.respond((await modern.ask()).id, { action: 'deny' });
  await modern.answered();
  for (const [a, how] of [[modern.answers[0], 'replied_in_chat'], [modern.answers[1], 'dismissed']]) {
    assert.equal(a.behavior, 'allow');
    assert.deepEqual(a.updatedInput.answers, {});
    assert.deepEqual(a.updatedInput.annotations, { 'Which color?': { unanswered: how } });
  }
  modern.s.respond((await modern.ask()).id, { action: 'deny', stop: true });
  await modern.answered();
  assert.deepEqual([modern.answers[2].behavior, modern.answers[2].interrupt], ['deny', true], 'Stop on a question still stops');

  const older = asking('AskUserQuestion', QUESTION, {}, {}, { capabilities: ['msg_lifecycle_v1'] });
  older.s.respond((await older.ask()).id, { action: 'question-skip' });
  await older.answered();
  assert.equal(older.answers[0].behavior, 'deny');
  assert.match(older.answers[0].message, /chose not to answer/);
});

test('a request Claude Code withdraws resolves itself', { skip: missing }, async () => {
  const { s, fake, w } = make();
  await s.warm();
  const ac = new AbortController();
  const pending = fake.current.options.canUseTool('Bash', { command: 'x' }, { signal: ac.signal, toolUseID: 'toolu_w', requestId: 'r1' });
  const p = await w.waitFor('permission', { ms: 2000 });
  ac.abort();
  const answer = await within(pending, 1000, 'the withdrawn request');
  assert.equal(answer.behavior, 'deny');
  const resolved = w.find('permission-resolved');
  assert.deepEqual([resolved.id, resolved.aborted], [p.id, true]);
  assert.equal(s.snapshot().pending.length, 0);
  assert.equal(s.respond(p.id, { action: 'allow' }).code, 'stale');

  const gone = new AbortController();
  gone.abort();
  const mark = w.mark();
  const instant = await within(fake.current.options.canUseTool('Bash', { command: 'y' }, { signal: gone.signal, toolUseID: 'toolu_g', requestId: 'r2' }), 1000, 'an already-withdrawn request');
  assert.equal(instant.behavior, 'deny');
  assert.equal(w.all('permission', mark).length, 0, 'nothing is shown for a request that was already withdrawn');
});

test('a question from an MCP server is a card when the host asks for them: a form, a link, a yes/no', { skip: missing }, async () => {
  const off = make();
  await off.s.warm();
  assert.equal(off.fake.current.options.onElicitation, undefined, 'without the feature Claude Code answers for itself');

  const { s, fake, w } = make({ extended: ['elicitation'] });
  await s.warm();
  const elicit = (req, signal = new AbortController().signal) => fake.current.options.onElicitation(req, { signal, requestId: 'r' });
  const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string', title: 'Title' }, points: { type: 'integer' }, urgent: { type: 'boolean' }, team: { type: 'string', enum: ['eng', 'ops'] } } };

  const form = elicit({ serverName: 'linear', message: 'New issue', mode: 'form', requestedSchema: schema });
  const card = await w.waitFor('permission', { ms: 2000 });
  assert.deepEqual([card.type, card.ask, card.title, card.message, card.server, card.toolName], ['elicitation', 'form', 'Linear needs a few details', 'New issue', 'linear', 'linear']);
  assert.deepEqual(card.fields.map((f) => [f.key, f.kind, f.required]), [['title', 'text', true], ['points', 'number', false], ['urgent', 'boolean', false], ['team', 'choice', false]]);
  assert.deepEqual(s.respond(card.id, { action: 'elicit-accept', content: { title: 'Fix', points: '5', urgent: true, team: 'nope', extra: 1 } }), { ok: true });
  assert.deepEqual(await within(form, 1000, 'the form'), { action: 'accept', content: { title: 'Fix', points: 5, urgent: true } });
  assert.equal(w.find('permission-resolved').id, card.id);

  let mark = w.mark();
  const link = elicit({ serverName: 'github', message: 'Sign in to GitHub', mode: 'url', url: 'https://github.com/login/device', elicitationId: 'e-1' });
  const second = await w.waitFor('permission', { ms: 2000, from: mark });
  assert.deepEqual([second.ask, second.url, second.title, second.elicitationId, second.fields], ['link', 'https://github.com/login/device', 'Github wants you to open a link', 'e-1', []]);
  s.respond(second.id, { action: 'elicit-accept' });
  assert.deepEqual(await within(link, 1000, 'the link'), { action: 'accept', content: {} });

  mark = w.mark();
  const yesNo = elicit({ serverName: 'docs', message: 'Publish the page?', requestedSchema: { type: 'object', properties: {} }, title: 'Publish to the web' });
  const third = await w.waitFor('permission', { ms: 2000, from: mark });
  assert.deepEqual([third.ask, third.title, third.fields], ['confirm', 'Publish to the web', []]);
  s.respond(third.id, { action: 'elicit-decline' });
  assert.deepEqual(await within(yesNo, 1000, 'the yes/no'), { action: 'decline' });

  mark = w.mark();
  const walked = elicit({ serverName: 'docs', message: 'Name?', requestedSchema: schema });
  const fourth = await w.waitFor('permission', { ms: 2000, from: mark });
  s.respond(fourth.id, { action: 'elicit-cancel' });
  assert.deepEqual(await within(walked, 1000, 'the cancelled form'), { action: 'cancel' });

  // Withdrawn by Claude Code, or still open when the turn is stopped: cancel, and the card goes.
  mark = w.mark();
  const ac = new AbortController();
  const withdrawn = elicit({ serverName: 'docs', message: 'Name?', requestedSchema: schema }, ac.signal);
  await w.waitFor('permission', { ms: 2000, from: mark });
  ac.abort();
  assert.deepEqual(await within(withdrawn, 1000, 'the withdrawn question'), { action: 'cancel' });
  mark = w.mark();
  const open = elicit({ serverName: 'docs', message: 'Name?', requestedSchema: schema });
  await w.waitFor('permission', { ms: 2000, from: mark });
  s.rejectAllPending('Stopped.', { interrupt: true });
  assert.deepEqual(await within(open, 1000, 'the question left open'), { action: 'cancel' });
  assert.equal(s.snapshot().pending.length, 0);
  // A request that cannot be read is still a card that can be turned down, never a throw.
  mark = w.mark();
  const odd = elicit(null);
  const fifth = await w.waitFor('permission', { ms: 2000, from: mark });
  assert.deepEqual([fifth.ask, fifth.title], ['confirm', 'A connected tool needs your OK']);
  s.respond(fifth.id, {});
  assert.deepEqual(await within(odd, 1000, 'the odd one'), { action: 'cancel' });
});

test('pending requests are always resolved when the session shuts down', { skip: missing }, async () => {
  for (const how of ['stop', 'close', 'dispose', 'crash']) {
    const { s, fake, w, answers, ask } = asking('Bash', { command: 'x' });
    await ask();
    const run = fake.current;
    const settledAnswer = (async () => { while (!answers.length) await sleep(5); return answers[0]; })();
    if (how === 'stop') await s.stop();
    else if (how === 'close') s.close();
    else if (how === 'dispose') await s.dispose();
    else run.die();
    const a = await within(settledAnswer, 3000, `the request pending at ${how}`);
    assert.equal(a.behavior, 'deny', how);
    assert.equal(s.snapshot().pending.length, 0, how);
    if (how === 'stop' || how === 'crash') assert.equal(w.of('permission-resolved').length, 1, how);
  }
});

// ---- stopping ----

async function midTurn(opts = {}, script = {}) {
  const made = make({ extended: ['send-state'], ...opts }, script);
  await made.s.warm();
  const release = made.fake.current.hold();
  const first = made.s.send('a long task');
  await made.w.waitFor('text-delta', { ms: 3000 });
  return { ...made, first, release };
}

test('Stop: one interrupted turn, queued sends cancelled and reported', { skip: missing }, async () => {
  const { s, fake, w, first } = await midTurn();
  const queued = s.send('and then this');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === queued.id && e.state === 'queued', { ms: 3000 });
  const r = await s.interrupt();
  assert.equal(r.ok, true);
  assert.deepEqual(r.cancelled, [{ id: queued.id, text: 'and then this' }]);
  assert.deepEqual(r.stillQueued, []);
  await idle(w);
  await settle();

  assert.deepEqual(controls(fake.current, 'interrupt')[0].args, [{ cancelQueued: true }]);
  const ends = w.of('turn-end');
  assert.equal(ends.length, 1);
  assert.deepEqual([ends[0].interrupted, ends[0].isError, ends[0].errors], [true, false, []]);
  assert.deepEqual(ends[0].userUuids, [first.id]);
  const notice = w.find((e) => e.kind === 'notice' && e.code === 'send-cancelled');
  assert.deepEqual(notice.cancelled, [{ id: queued.id, text: 'and then this' }]);
  assert.equal(w.of('error').length, 0);
  assert.ok(!w.events.some((e) => /Request interrupted/.test(e.text ?? '')));
  assert.equal(fake.current.turns, 1, 'the cancelled send never ran');
  assert.equal(sendStates(w, queued.id).at(-1), 'cancelled');
  assert.deepEqual(s.snapshot().outbox, []);
  assert.equal(fake.starts, 1, 'a clean stop does not restart the process');

  const mark = w.mark();
  s.send('next');
  await idle(w, mark);
  assert.equal(w.all('turn-end', mark)[0].interrupted, false, 'the stop flag does not leak into the next turn');
});

test('Stop with nothing running is a no-op', { skip: missing }, async () => {
  const { s, fake } = make();
  assert.deepEqual(await s.interrupt(), { ok: true, idle: true, cancelled: [], stillQueued: [] });
  await s.warm();
  const r = await s.interrupt();
  assert.deepEqual([r.ok, r.idle], [true, true]);
  assert.equal(controls(fake.current, 'interrupt').length, 0);
});

// A workflow keeps Claude Code's state at 'running' after the reply has ended.
async function backgroundOnly(extra = {}) {
  const made = make({ extended: ['tasks'], ...extra }, { stateEvents: true });
  made.s.send('start a workflow');
  await idle(made.w);
  made.fake.current.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  made.fake.current.emit({ type: 'system', subtype: 'task_started', task_id: 'wf1', description: 'Mulching', workflow_name: 'mulch', is_backgrounded: true });
  await settle();
  return made;
}

test('Stop with only background work running leaves it alone', { skip: missing }, async () => {
  const { s, fake } = await backgroundOnly();
  assert.deepEqual([s.busy, s.turnInFlight(), s.backgroundWork()], [true, false, true]);
  const r = await s.interrupt();
  assert.deepEqual([r.ok, r.idle, r.background, r.cancelled], [true, true, true, []]);
  assert.equal(controls(fake.current, 'interrupt').length, 0, 'Claude Code is not told to interrupt');
  assert.equal(fake.starts, 1, 'no restart');
  assert.equal(s.snapshot().tasks[0].status, 'running');
  await s.interrupt();
  assert.equal(fake.starts, 1, 'a second press does not escalate either');
});

test('with only background work running the chat reports idle, so new messages go straight out', { skip: missing }, async () => {
  const { s, fake, w } = await backgroundOnly();
  assert.equal(s.busy, true, 'Claude Code itself is still running');
  const last = w.of('busy').at(-1);
  assert.deepEqual([last.busy, last.state, last.background], [false, 'idle', 0]);
  assert.equal(s.snapshot().tasks[0].status, 'running');

  const mark = w.mark();
  const release = fake.current.hold();
  const turns = fake.current.turns;
  const r = s.send('what is the workflow doing?');
  assert.equal(r.ok, true);
  assert.equal(w.find((e) => e.kind === 'busy' && e.busy === true, mark)?.busy, true, 'busy again as soon as it is sent');
  await w.waitFor('text-delta', { from: mark, ms: 3000 });
  assert.equal(fake.current.turns, turns + 1, 'delivered to Claude Code at once, not held for the workflow');
  assert.equal(s.onlyBackground(), false);
  release();
  await turnEnd(w, mark);
});

test('a background agent counts like a workflow: chat free, its own output does not re-busy it, Stop spares it', { skip: missing }, async () => {
  const { s, fake, w } = make({ extended: ['tasks'] }, { stateEvents: true });
  s.send('start an agent');
  await idle(w);
  const f = fake.current;
  f.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'ag1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Probe' }] });
  f.emit({ type: 'system', subtype: 'task_started', task_id: 'ag1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Probe', is_backgrounded: true, tool_use_id: 'tu1' });
  await settle();
  assert.equal(s.backgroundWork(), true);
  assert.equal(w.of('busy').at(-1).busy, false, 'the chat is free while the agent runs');
  assert.equal(s.snapshot().busy, false, 'a reload sees it free too');
  // The agent talking and working is not the main loop's turn.
  f.emit({ type: 'assistant', parent_tool_use_id: 'tu1', message: { id: 'sub1', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  f.emit({ type: 'system', subtype: 'task_progress', task_id: 'ag1', description: 'Running sleep', last_tool_name: 'Bash' });
  await settle();
  assert.deepEqual([s.turnOpen, s.onlyBackground(), w.of('busy').at(-1).busy], [false, true, false]);
  const r = await s.interrupt();
  assert.deepEqual([r.ok, r.background], [true, true]);
  assert.equal(controls(f, 'interrupt').length, 0);
  assert.equal(fake.starts, 1);
  const mark = w.mark();
  s.send('how is the agent doing?');
  assert.equal(w.find((e) => e.kind === 'busy' && e.busy === true, mark)?.busy, true);
  await turnEnd(w, mark);
  assert.equal(w.of('busy').at(-1).busy, false, 'free again once that reply is done, agent still running');
  assert.equal(s.snapshot().tasks[0].status, 'running');
});

test('background work ending leaves the chat idle once Claude Code reports idle', { skip: missing }, async () => {
  const { s, fake, w } = await backgroundOnly();
  fake.current.emit({ type: 'system', subtype: 'task_notification', task_id: 'wf1', status: 'completed', summary: 'Done' });
  fake.current.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await settle();
  assert.equal(s.busy, false);
  assert.equal(w.of('busy').at(-1).busy, false);
  assert.equal(s.snapshot().tasks[0].status, 'completed');
});

test('Stop still ends a reply that runs next to background work', { skip: missing }, async () => {
  const { s, fake, w } = await backgroundOnly();
  const release = fake.current.hold();
  s.send('and one more thing');
  await w.waitFor('text-delta', { ms: 3000 });
  assert.equal(s.onlyBackground(), false);
  await s.interrupt();
  release();
  assert.equal(controls(fake.current, 'interrupt').length, 1);
  assert.equal(fake.starts, 1, 'the workflow survives a clean stop');
});

test('Claude Code is told Stop may spare background tasks once the host can stop them one by one', { skip: missing }, async () => {
  const on = make({ extended: ['tasks', 'task-stop'] });
  await on.s.warm();
  assert.equal(on.fake.current.options.perTaskStopAffordance, true);
  const off = make({ extended: ['tasks'] });
  await off.s.warm();
  assert.equal(off.fake.current.options.perTaskStopAffordance, undefined);
});

test('Stop keeps queued sends when asked to', { skip: missing }, async () => {
  const { s, fake, w } = await midTurn();
  const queued = s.send('still wanted');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === queued.id && e.state === 'queued', { ms: 3000 });
  const r = await s.interrupt({ keepQueued: true });
  assert.deepEqual([r.cancelled, r.stillQueued], [[], [queued.id]]);
  assert.equal(controls(fake.current, 'interrupt')[0].args[0], undefined);
  await idle(w);
  const ends = w.of('turn-end');
  assert.deepEqual(ends.map((e) => e.interrupted), [true, false]);
  assert.deepEqual(ends[1].userUuids, [queued.id]);
});

test('a second Stop while the first is unanswered forces a restart', { skip: missing, timeout: 15000 }, async () => {
  const { s, fake, w, first } = await midTurn();
  const stuck = fake.current.hang('interrupt');
  const queued = s.send('queued behind the stuck turn');
  await settle();
  const firstPress = s.interrupt();
  const forced = await within(s.interrupt(), 3000, 'the second Stop');
  assert.deepEqual([forced.ok, forced.forced], [true, true]);
  assert.deepEqual(forced.cancelled.map((c) => c.id), [queued.id]);

  const end = w.of('turn-end');
  assert.equal(end.length, 1);
  assert.deepEqual([end[0].synthetic, end[0].interrupted, end[0].isError, end[0].subtype], [true, true, false, 'stopped']);
  const stopped = w.find('stopped');
  assert.deepEqual([stopped.reason, stopped.willRestart], ['force-stop', true]);
  assert.equal(s.busy, false);
  assert.equal(w.of('busy').at(-1).busy, false);
  assert.equal(stuck.closed, true, 'the stuck process was closed');
  assert.ok(w.find((e) => e.kind === 'notice' && e.code === 'send-cancelled'));

  const next = await fake.run(2, 3000);
  assert.equal(next.options.resume, s.sessionId, 'the new process resumes the same conversation');
  const mark = w.mark();
  const again = s.send('are you there?');
  const answered = await turnEnd(w, mark);
  assert.deepEqual(answered.userUuids, [again.id]);
  await idle(w, mark);
  assert.deepEqual(next.received.map((m) => m.uuid), [again.id], 'neither the stopped turn nor the cancelled send was re-run');
  assert.ok(!next.received.some((m) => m.uuid === first.id));
  assert.equal((await within(firstPress, 6000, 'the first Stop')).ok, true);
});

test('a hard Stop does not wait for Claude Code', { skip: missing }, async () => {
  const { s, fake, w } = await midTurn();
  fake.current.hang('interrupt');
  const r = await within(s.interrupt({ hard: true }), 2000, 'hard stop');
  assert.equal(r.forced, true);
  assert.equal(w.find('stopped').reason, 'force-stop');
  assert.equal(s.busy, false);
});

test('stop() ends the turn, reports it, and does not restart by itself', { skip: missing }, async () => {
  const { s, fake, w } = await midTurn();
  const pending = s.stop();
  assert.ok(pending instanceof Promise);
  const r = await within(pending, 8000, 'stop');
  assert.deepEqual([r.ok, r.exited], [true, true]);
  const ends = w.of('turn-end');
  assert.equal(ends.length, 1);
  assert.deepEqual([ends[0].interrupted, ends[0].isError], [true, false]);
  const stopped = w.of('stopped');
  assert.deepEqual(stopped.map((e) => [e.reason, e.willRestart]), [['stop', false]]);
  assert.equal(stopped[0].sessionId, s.sessionId);
  assert.equal(s.busy, false);
  assert.ok(!s.q, 'no process after stop');
  assert.equal(fake.runs[0].closed, true);
  assert.equal(w.of('error').length, 0);
  await sleep(700);
  assert.equal(fake.starts, 1, 'no automatic re-warm after a host stop');
  assert.equal(s.snapshot().lifecycle, 'stopped');

  const mark = w.mark();
  s.send('back again');
  await idle(w, mark);
  assert.equal(fake.starts, 2);
  assert.equal(fake.current.options.resume, s.sessionId);
});

test('stop() is safe before start, twice in a row, and without await', { skip: missing }, async () => {
  const { s, fake } = make();
  assert.equal((await s.stop()).ok, true);
  await s.warm();
  s.stop();
  const again = await s.stop();
  assert.equal(again.ok, true);
  assert.equal(fake.starts, 1);
  assert.ok(!s.q);
});

test('a send that races stop() is answered once or reported as not sent, never dropped', { skip: missing }, async () => {
  const { s, fake, w } = await midTurn();
  const stopping = s.stop();
  const r = s.send('typed while stopping');
  await stopping;
  await sleep(400);
  const answered = w.all((e) => e.kind === 'turn-end' && e.userUuids?.includes(r.id)).length;
  const cancelled = w.all((e) => e.kind === 'notice' && e.code === 'send-cancelled' && e.cancelled.some((c) => c.id === r.id)).length;
  if (r.ok) assert.equal(answered + cancelled, 1, `answered ${answered} time(s), reported cancelled ${cancelled} time(s)`);
  else assert.ok(r.code, 'a refused send says why');
  assert.deepEqual(s.snapshot().outbox, []);
  assert.equal(s.busy, false);
  assert.equal(w.of('busy').at(-1).busy, false);
  assert.ok(fake.runs.filter((run) => !run.finished).length <= 1, 'never two live processes on one conversation');
});

test('q is truthy exactly while a process exists', { skip: missing }, async () => {
  const { s, fake } = make();
  assert.ok(!s.q);
  await s.warm();
  assert.ok(s.q);
  assert.equal(s.closed, false);
  await s.stop();
  assert.ok(!s.q);
  const warming = s.warm();
  assert.ok(typeof warming?.then === 'function', 'warm() may be called without await');
  await warming;
  assert.ok(s.q);
  assert.equal(fake.starts, 2);
});

test('a parked session refuses to run until it is unparked', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.send('hello');
  await idle(w);
  const r = await s.stop({ park: true });
  assert.equal(r.ok, true);
  assert.deepEqual([w.find('stopped').reason, w.find('stopped').willRestart], ['parked', false]);
  assert.equal(s.parked, true);
  assert.equal(s.snapshot().lifecycle, 'parked');

  const mark = w.mark();
  const refused = s.send('while parked');
  assert.deepEqual([refused.ok, refused.code], [false, 'parked']);
  assert.equal(w.find('error', mark).code, 'parked');
  await s.warm();
  await sleep(100);
  assert.equal(fake.starts, 1, 'warm() does nothing while parked');
  assert.equal(s.busy, false);

  s.unpark();
  assert.equal(s.parked, false);
  const after = w.mark();
  assert.equal(s.send('after the terminal closed').ok, true);
  await idle(w, after);
  assert.equal(fake.starts, 2);
  assert.equal(fake.current.options.resume, s.sessionId);
});

test('close() is synchronous and final; dispose() waits for the process', { skip: missing }, async () => {
  const a = await midTurn();
  assert.equal(a.s.close(), undefined);
  assert.equal(a.s.closed, true);
  assert.equal(a.fake.runs[0].closed, true);
  const refused = a.s.send('late');
  assert.deepEqual([refused.ok, refused.code], [false, 'closed']);
  assert.equal(a.s.busy, false);
  assert.doesNotThrow(() => a.s.close());
  assert.equal((await a.s.warm()).ok, false);

  const b = await midTurn();
  const seen = b.w.events.length;
  await within(b.s.dispose(), 5000, 'dispose');
  assert.equal(b.s.closed, true);
  assert.equal(b.fake.runs[0].closed, true);
  await sleep(50);
  assert.equal(b.w.events.length, seen, 'no events after dispose');
  await assert.doesNotReject(b.s.dispose());
});

// ---- crash recovery ----

test('a crash mid-turn is reported once, the turn is not re-run, and the next send resumes', { skip: missing }, async () => {
  const { s, fake, w, first } = await midTurn();
  const sessionId = s.sessionId;
  fake.current.die();
  const stopped = await w.waitFor('stopped', { ms: 3000 });
  assert.deepEqual([stopped.reason, stopped.willRestart], ['crash', true]);

  const end = w.of('turn-end');
  assert.equal(end.length, 1);
  assert.deepEqual([end[0].subtype, end[0].isError, end[0].interrupted, end[0].synthetic, end[0].text], ['crashed', true, false, true, '']);
  assert.equal(end[0].errors.length, 1);
  const errors = w.of('error');
  assert.equal(errors.length, 1, 'exactly one error row');
  const err = errors[0];
  assert.deepEqual([err.code, err.recoverable], ['turn-lost', true]);
  assert.deepEqual(err.prompt, { id: first.id, text: 'a long task' });
  assert.equal(typeof err.message, 'string');
  assert.ok(w.indexOf(end[0]) < w.indexOf(err) && w.indexOf(err) < w.indexOf(stopped));
  assert.equal(s.busy, false);
  assert.equal(w.of('busy').at(-1).busy, false);
  assert.deepEqual(s.snapshot().lastError.code, 'turn-lost');
  assert.deepEqual(s.snapshot().outbox, []);

  const next = await fake.run(2, 3000);
  assert.equal(next.options.resume, sessionId);
  await sleep(80);
  assert.equal(next.received.length, 0, 'the lost turn is never re-run');
  const mark = w.mark();
  const again = s.send('continue');
  const answered = await turnEnd(w, mark);
  assert.deepEqual(answered.userUuids, [again.id]);
  await idle(w, mark);
  assert.equal(s.sessionId, sessionId);
  assert.equal(s.snapshot().restarts, 1);
});

test('a send queued behind a crashed turn is delivered exactly once after the restart', { skip: missing }, async () => {
  const { s, fake, w, first } = await midTurn();
  const queued = s.send('queued and acknowledged');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === queued.id && e.state === 'queued', { ms: 3000 });
  fake.current.die();
  const answered = await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids?.includes(queued.id), { ms: 5000 });
  assert.equal(answered.isError, false);
  await idle(w);

  assert.equal(fake.starts, 2);
  assert.deepEqual(fake.runs[1].received.map((m) => m.uuid), [queued.id]);
  assert.equal(w.all((e) => e.kind === 'turn-end' && e.userUuids?.includes(queued.id)).length, 1);
  assert.deepEqual(w.of('error').map((e) => e.code), ['turn-lost']);
  assert.equal(w.of('error')[0].prompt.id, first.id);
  const crash = w.find('stopped');
  const between = w.events.slice(w.indexOf(crash), w.indexOf(answered));
  assert.ok(!between.some((e) => e.kind === 'busy' && e.busy === false), 'busy stays on while the queued send is redelivered');
  assert.deepEqual(s.snapshot().outbox, []);
});

test('a send written into a dying process is redelivered, exactly once', { skip: missing }, async () => {
  const { s, fake, w } = make({ extended: ['send-state'] });
  s.send('warm up');
  await idle(w);
  const mark = w.mark();
  fake.current.die(Object.assign(new Error('Claude Code process terminated by signal SIGKILL'), { exitCode: null }));
  const r = s.send('sent in the same tick as the crash');
  assert.equal(r.ok, true);
  const answered = await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids?.includes(r.id), { ms: 6000, from: mark });
  assert.equal(answered.isError, false);
  await idle(w, mark);
  assert.equal(fake.runs[0].swallowed.length, 1, 'the first copy went into the dead pipe');
  assert.deepEqual(fake.runs[1].received.map((m) => m.uuid), [r.id]);
  assert.equal(w.all('turn-end', mark).length, 1);
  assert.equal(w.all('error', mark).length, 0, 'nothing was lost, so nothing is reported as an error');
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false, mark).length, 1);
});

test('an idle process that exits is restarted quietly', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.send('hello');
  await idle(w);
  const mark = w.mark();
  fake.current.end();
  const stopped = await w.waitFor('stopped', { ms: 3000, from: mark });
  assert.deepEqual([stopped.reason, stopped.willRestart], ['exit', true]);
  assert.equal(w.all('error', mark).length, 0);
  assert.equal(w.all('turn-end', mark).length, 0);
  assert.ok(w.find((e) => e.kind === 'notice' && e.code === 'restarting', mark));
  const next = await fake.run(2, 3000);
  assert.equal(next.options.resume, s.sessionId);
  assert.equal(s.busy, false);
});

test('autoRestart:false leaves a dead process down until the next send', { skip: missing }, async () => {
  const { s, fake, w } = make({ autoRestart: false });
  s.send('hello');
  await idle(w);
  fake.current.end();
  const stopped = await w.waitFor('stopped', { ms: 3000 });
  assert.equal(stopped.willRestart, false);
  await sleep(900);
  assert.equal(fake.starts, 1);
  const mark = w.mark();
  s.send('wake up');
  await idle(w, mark);
  assert.equal(fake.starts, 2);
});

test('a conversation that is gone from disk starts fresh and still answers the prompt', { skip: missing }, async () => {
  const lost = randomUUID();
  const { s, fake, w } = make({ resume: lost }, { onStart: (run) => { if (run.options.resume) run.failStartup(`No conversation found with session ID: ${run.options.resume}`); } });
  assert.equal(s.sessionId, lost);
  const r = s.send('hello again');
  const answered = await turnEnd(w);
  await idle(w);

  assert.deepEqual(answered.userUuids, [r.id]);
  assert.equal(answered.isError, false);
  assert.equal(w.all((e) => e.kind === 'notice' && e.code === 'resume-missing').length, 1);
  assert.equal(w.of('error').length, 0, 'no error row for a recovered start');
  assert.equal(fake.starts, 2);
  assert.equal(fake.runs[0].options.resume, lost);
  assert.ok(!('resume' in fake.runs[1].options));
  assert.deepEqual(fake.runs[1].received.map((m) => m.uuid), [r.id]);
  assert.notEqual(s.sessionId, lost);
  assert.equal(s.sessionId, fake.runs[1].sessionId);
  assert.ok(w.find((e) => e.kind === 'meta' && e.previousSessionId === lost && e.sessionId === s.sessionId), 'the host is told the id changed');
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false).length, 1);
});

test('a resume id that is not a uuid is ignored', { skip: missing }, async () => {
  const { s, fake, w } = make({ resume: '--dangerously-skip-permissions' });
  assert.equal(s.sessionId, null);
  s.send('hi');
  await idle(w);
  assert.ok(!('resume' in fake.current.options));
});

test('a deleted folder is reported without starting anything', { skip: missing }, async () => {
  const { s, fake, w } = make({ cwd: path.join(root, 'deleted-folder') });
  const r = s.send('hello');
  assert.deepEqual([r.ok, r.code], [false, 'cwd-missing']);
  const err = w.find('error');
  assert.deepEqual([err.code, err.recoverable], ['cwd-missing', false]);
  assert.equal(err.prompts.length, 1);
  assert.equal(err.prompts[0].text, 'hello');
  assert.match(err.message, /^Claude Code could not start: /);
  assert.equal(fake.starts, 0);
  assert.equal(s.busy, false);
  assert.equal(w.of('busy').at(-1).busy, false);
  assert.deepEqual(s.snapshot().outbox, []);
  const warm = await s.warm();
  assert.deepEqual([warm.ok, warm.code], [false, 'cwd-missing']);
});

test('a startup Claude Code refuses is final and explained', { skip: missing }, async () => {
  const { s, fake, w } = make({}, { onStart: (run) => run.failStartup('This conversation is open in another process', { reason: 'session_held_by_background' }) });
  s.send('hello');
  const err = await w.waitFor('error', { ms: 3000 });
  assert.deepEqual([err.code, err.recoverable], ['session-busy', false]);
  assert.equal(err.prompts[0].text, 'hello');
  const stopped = await w.waitFor('stopped', { ms: 2000 });
  assert.deepEqual([stopped.reason, stopped.willRestart], ['failed', false]);
  await sleep(700);
  assert.equal(fake.starts, 1, 'no restart loop for a refusal');
  assert.equal(s.busy, false);
  assert.equal(w.of('turn-end').length, 0, 'the held-back startup result is not shown as a turn');
  assert.equal(s.snapshot().lifecycle, 'failed');
});

// ---- settings ----

test('settings apply live, in order, and report how they were applied', { skip: missing }, async () => {
  const { s, fake, w } = make();
  await s.warm();
  const results = await Promise.all([s.set('model', 'sonnet'), s.set('model', 'opus'), s.set('effort', 'high'), s.set('fast', true), s.set('permissionMode', 'acceptEdits'), s.set('ultracode', true)]);
  assert.ok(results.every((r) => r.ok && r.applied === 'live'), JSON.stringify(results));
  const run = fake.current;
  assert.deepEqual(controls(run, 'setModel').map((c) => c.args[0]), ['sonnet', 'opus']);
  assert.deepEqual(controls(run, 'applyFlagSettings').map((c) => c.args[0]), [{ effortLevel: 'high' }, { fastMode: true }, { ultracode: true }]);
  assert.deepEqual(controls(run, 'setPermissionMode').map((c) => c.args[0]), ['acceptEdits']);
  const settings = w.of('setting');
  assert.deepEqual(settings.map((e) => [e.key, e.value]), [['model', 'sonnet'], ['model', 'opus'], ['effort', 'high'], ['fast', true], ['permissionMode', 'acceptEdits'], ['ultracode', true]]);
  assert.ok(settings.every((e) => !e.deferred));
  assert.equal(s.mode, 'acceptEdits');
  assert.equal(s.settings.model, 'opus');
  assert.equal(s.snapshot().settings.permissionMode, 'acceptEdits');
  assert.equal(s.snapshot().meta.mode, 'acceptEdits');
  await s.set('effort', 'low');
  assert.deepEqual(controls(run, 'applyFlagSettings').at(-1).args[0], { effortLevel: 'low', ultracode: true }, 'ultracode survives an effort change');
});

test('settings chosen while stopped are kept and used at the next start', { skip: missing }, async () => {
  const { s, fake, w } = make();
  const results = [await s.set('model', 'opus'), await s.set('effort', 'high'), await s.set('permissionMode', 'plan'), await s.set('fast', true)];
  assert.ok(results.every((r) => r.ok && r.applied === 'next-start'), JSON.stringify(results));
  assert.ok(w.of('setting').every((e) => e.deferred === true));
  assert.equal(w.of('setting').length, 4);
  assert.equal(fake.starts, 0, 'changing a setting does not start Claude Code');
  assert.equal(s.snapshot().settings.permissionMode, 'plan');
  s.send('hi');
  await idle(w);
  const o = fake.current.options;
  assert.deepEqual([o.model, o.effort, o.permissionMode, o.settings?.fastMode], ['opus', 'high', 'plan', true]);
});

test('the legacy direct write to settings still reaches the start options', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.settings.fast = true;
  s.send('hi');
  await idle(w);
  assert.equal(fake.current.options.settings?.fastMode, true);
});

test('unknown keys and bad values are refused with setting-failed', { skip: missing }, async () => {
  const { s, fake, w } = make({ effort: 'medium' });
  await s.warm();
  for (const [key, value] of [['nonsense', 1], ['__proto__', { polluted: true }], ['constructor', 'x'], ['effort', 'ludicrous'], ['permissionMode', 'root'], ['fast', 'yes'], ['maxTurns', -1], [null, 1]]) {
    const mark = w.mark();
    const r = await s.set(key, value);
    assert.equal(r.ok, false, `${String(key)}=${JSON.stringify(value)}`);
    assert.ok(r.code && r.message);
    assert.equal(w.all('setting-failed', mark).length, 1);
    assert.match(w.find('notice', mark).text, /^Could not change /);
    assert.equal(w.all('setting', mark).length, 0);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(s.settings.effort, 'medium');
  assert.equal(w.find((e) => e.kind === 'setting-failed' && e.key === 'effort').value, 'medium', 'the UI is told the value to go back to');
  assert.equal(fake.current.calls.filter((c) => /^set|^apply/.test(c.method)).length, 0);
});

test('a change Claude Code rejects is rolled back with the frozen notice text', { skip: missing }, async () => {
  const { s, w } = make({ model: 'haiku' }, { controls: { setModel() { throw new Error('model not available on this plan'); } } });
  await s.warm();
  const r = await s.set('model', 'opus');
  assert.equal(r.ok, false);
  assert.equal(w.find('notice').text, 'Could not change model: model not available on this plan');
  assert.deepEqual([w.find('setting-failed').key, w.find('setting-failed').value], ['model', 'haiku']);
  assert.equal(s.settings.model, 'haiku');
});

test('start-time settings restart an idle process, never a running turn', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.send('hi');
  await idle(w);
  const r = await s.set('maxTurns', 5);
  assert.deepEqual([r.ok, r.applied], [true, 'restart']);
  assert.equal(w.find('setting').appliesOn, 'restart');
  const next = await fake.run(2, 3000);
  assert.equal(next.options.maxTurns, 5);
  assert.equal(next.options.resume, s.sessionId);

  await s.warm();
  const release = fake.current.hold();
  const mark = w.mark();
  s.send('long');
  await w.waitFor('text-delta', { ms: 3000, from: mark });
  await s.set('thinking', 'off');
  await sleep(60);
  assert.equal(fake.starts, 2, 'no restart while the turn runs');
  release();
  await idle(w, mark);
  const third = await fake.run(3, 3000);
  assert.deepEqual(third.options.thinking, { type: 'disabled' });
  assert.ok(!third.options.extraArgs?.['thinking-display']);
  assert.equal(w.all('turn-end', mark)[0].isError, false);
});

test('configure applies several keys and names the ones that failed', { skip: missing }, async () => {
  const { s, w } = make();
  const r = await s.configure({ model: 'opus', effort: 'high', bogus: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ['bogus']);
  assert.deepEqual([s.settings.model, s.settings.effort], ['opus', 'high']);
  assert.equal((await s.configure({ fast: true })).ok, true);
  assert.equal((await s.configure('nope')).ok, false);
  assert.ok(w.of('setting').length >= 3);
});

// ---- bypass gate ----

test('bypass is refused everywhere unless the host allowed it', { skip: missing }, async () => {
  const { s, fake, w } = make({ permissionMode: 'bypassPermissions' });
  assert.notEqual(s.settings.permissionMode, 'bypassPermissions', 'the constructor does not accept it');
  const r = await s.set('permissionMode', 'bypassPermissions');
  assert.equal(r.ok, false);
  assert.equal(w.find('notice').text, BYPASS_NOTICE);
  assert.deepEqual([w.find('setting-failed').key, w.find('setting-failed').value], ['permissionMode', 'default']);
  assert.notEqual(s.settings.permissionMode, 'bypassPermissions', 'nothing is stored');
  assert.notEqual(s.mode, 'bypassPermissions');
  assert.equal(fake.starts, 0);

  s.send('hi');
  await idle(w);
  const o = fake.current.options;
  assert.ok(!('allowDangerouslySkipPermissions' in o));
  assert.notEqual(o.permissionMode, 'bypassPermissions');

  const mark = w.mark();
  const live = await s.set('permissionMode', 'bypassPermissions');
  assert.equal(live.ok, false);
  assert.equal(w.find('notice', mark).text, BYPASS_NOTICE);
  assert.equal(w.find('setting-failed', mark).value, 'default');
  assert.equal(controls(fake.current, 'setPermissionMode').length, 0, 'Claude Code is not even asked');
});

test('with allowBypass the flag and the mode are passed through', { skip: missing }, async () => {
  const { s, fake, w } = make({ allowBypass: true, permissionMode: 'bypassPermissions' });
  s.send('hi');
  await idle(w);
  assert.equal(fake.current.options.allowDangerouslySkipPermissions, true);
  assert.equal(fake.current.options.permissionMode, 'bypassPermissions');
  for (const truthy of ['yes', 1, {}]) {
    const other = make({ allowBypass: truthy, permissionMode: 'bypassPermissions' });
    other.s.send('hi');
    await idle(other.w);
    assert.ok(!('allowDangerouslySkipPermissions' in other.fake.current.options), `allowBypass: ${JSON.stringify(truthy)} is not true`);
  }
});

// ---- trust ----

test('an untrusted folder starts restricted, and trust() lifts it', { skip: missing }, async () => {
  const { s, fake, w } = make({ trusted: false, allowBypass: true, permissionMode: 'acceptEdits' });
  s.send('hi');
  await idle(w);
  const o = fake.current.options;
  assert.deepEqual(o.settingSources, ['user']);
  assert.ok(!('allowDangerouslySkipPermissions' in o), 'no bypass in an untrusted folder, whatever the host allows');
  assert.equal(o.permissionMode, 'default', 'an escalating mode the user did not pick here is not inherited');
  const notices = w.all((e) => e.kind === 'notice' && e.code === 'trust-required');
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0].level, notices[0].cwd], ['warn', work]);
  assert.equal(s.restricted, true);
  assert.equal(s.snapshot().restricted, true);
  assert.equal(w.find((e) => e.kind === 'meta' && 'restricted' in e).restricted, true);

  assert.deepEqual(s.trust(), { ok: true });
  const next = await fake.run(2, 3000);
  assert.deepEqual(next.options.settingSources, ['user', 'project', 'local']);
  assert.equal(next.options.allowDangerouslySkipPermissions, true);
  assert.equal(next.options.resume, s.sessionId);
  await s.warm();
  assert.equal(s.snapshot().restricted, false);
  assert.equal(w.all((e) => e.kind === 'notice' && e.code === 'trust-required').length, 1);
});

// A folder with project settings that Claude Code was never told to trust, opened as a project in the host app.
function riskyProject() {
  const dir = fs.mkdtempSync(path.join(root, 'proj-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['WebSearch'] } }));
  return dir;
}

test('a folder the host trusts (an opened project) starts with its project settings', { skip: noTrust }, async () => {
  const dir = riskyProject();
  const { s, fake, w } = make({ cwd: dir, trusted: undefined, trustedFolders: () => [dir] });
  s.send('hi');
  await idle(w);
  assert.deepEqual(fake.current.options.settingSources, ['user', 'project', 'local']);
  assert.equal(s.restricted, false);
  assert.equal(w.all((e) => e.kind === 'notice' && e.code === 'trust-required').length, 0);
});

test('opening the folder as a project lifts a chat already held back (recheckTrust)', { skip: noTrust }, async () => {
  const dir = riskyProject();
  const projects = [];
  const { s, fake, w } = make({ cwd: dir, trusted: undefined, trustedFolders: () => projects });
  s.send('hi');
  await idle(w);
  assert.deepEqual(fake.current.options.settingSources, ['user']);
  assert.equal(s.restricted, true);
  assert.equal(s.recheckTrust(), false, 'nothing changed yet');
  projects.push(dir);
  assert.equal(s.recheckTrust(), true);
  const next = await fake.run(2, 3000);
  assert.deepEqual(next.options.settingSources, ['user', 'project', 'local']);
});

test('restricted: a mode the user picks here is honoured, bypass never', { skip: missing }, async () => {
  const { s, fake, w } = make({ trusted: false, allowBypass: true });
  await s.set('permissionMode', 'acceptEdits');
  s.send('hi');
  await idle(w);
  assert.equal(fake.current.options.permissionMode, 'acceptEdits');
  await s.stop();
  await s.set('permissionMode', 'bypassPermissions');
  const mark = w.mark();
  s.send('again');
  await idle(w, mark);
  assert.notEqual(fake.current.options.permissionMode, 'bypassPermissions');
  assert.ok(!('allowDangerouslySkipPermissions' in fake.current.options));
  for (const mode of ['plan', 'dontAsk']) {
    const other = make({ trusted: false, permissionMode: mode });
    other.s.send('hi');
    await idle(other.w);
    assert.equal(other.fake.current.options.permissionMode, mode, 'a non-escalating mode is kept');
  }
});

test('trust() during a turn waits for the turn to end', { skip: missing }, async () => {
  const { s, fake, w, release } = await midTurn({ trusted: false });
  s.trust();
  await sleep(60);
  assert.equal(fake.starts, 1);
  release();
  await idle(w);
  const next = await fake.run(2, 3000);
  assert.deepEqual(next.options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(w.of('turn-end').map((e) => e.isError), [false]);
});

test('trust is decided automatically from the folder when the host does not say', { skip: noTrust }, async () => {
  const risky = path.join(root, 'risky-project');
  fs.mkdirSync(risky, { recursive: true });
  fs.writeFileSync(path.join(risky, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'true' } } }));
  const plain = path.join(root, 'plain-project');
  fs.mkdirSync(plain, { recursive: true });

  const a = make({ trusted: undefined, cwd: risky });
  a.s.send('hi');
  await idle(a.w);
  assert.deepEqual(a.fake.current.options.settingSources, ['user']);
  assert.equal(a.s.snapshot().restricted, true);
  assert.equal(a.s.snapshot().risky.mcpJson, true);

  const b = make({ trusted: undefined, cwd: plain });
  b.s.send('hi');
  await idle(b.w);
  assert.deepEqual(b.fake.current.options.settingSources, ['user', 'project', 'local'], 'a folder with nothing to load is not restricted');
  assert.equal(b.s.snapshot().restricted, false);

  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ projects: { [fs.realpathSync(risky)]: { hasTrustDialogAccepted: true } } }));
  T.clearTrustCache?.();
  const c = make({ trusted: undefined, cwd: risky });
  c.s.send('hi');
  await idle(c.w);
  assert.deepEqual(c.fake.current.options.settingSources, ['user', 'project', 'local'], "a folder accepted in the terminal is trusted");
  fs.rmSync(path.join(home, '.claude', '.claude.json'), { force: true });
  T.clearTrustCache?.();
});

test('host passthrough: settingSources and strictMcpConfig reach the process', { skip: missing }, async () => {
  const { s, fake, w } = make({ settingSources: [], strictMcpConfig: true });
  s.send('hi');
  await idle(w);
  assert.deepEqual(fake.current.options.settingSources, []);
  assert.equal(fake.current.options.strictMcpConfig, true);
});

// ---- conversation reset and session id ----

test('/clear: the session id follows Claude Code and the reset is announced', { skip: missing }, async () => {
  let previous = null;
  const script = {
    reply: async (msgs, run) => {
      if (msgs[0].message.content !== '/clear') { run.say('ok'); return true; }
      previous = run.sessionId;
      run.emit({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger: 'clear', user_message_uuid: msgs[0].uuid, timestamp: new Date().toISOString() });
      run.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      run.sessionId = randomUUID();
      run.emit(run.init());
      run.emit(run.result([msgs[0].uuid], { num_turns: 0, result: '', local_command: 'clear', terminal_reason: undefined, total_cost_usd: 0, modelUsage: {}, model_usage_since_last_result: {} }));
      run.life(msgs[0].uuid, 'completed');
      return false;
    },
  };
  const { s, fake, w } = make({}, script);
  s.send('remember this');
  await idle(w);
  const before = s.sessionId;
  const mark = w.mark();
  s.send('/clear');
  await idle(w, mark);

  assert.equal(previous, before);
  assert.equal(s.sessionId, fake.current.sessionId);
  assert.notEqual(s.sessionId, before);
  const reset = w.find((e) => e.kind === 'notice' && e.code === 'conversation-reset', mark);
  assert.deepEqual([reset.reset, reset.trigger], [true, 'clear']);
  const meta = w.find((e) => e.kind === 'meta' && e.previousSessionId, mark);
  assert.deepEqual([meta.previousSessionId, meta.sessionId], [before, s.sessionId]);
  assert.equal(s.snapshot().meta.sessionId, s.sessionId);
  const end = w.find('turn-end', mark);
  assert.deepEqual([end.isError, end.interrupted, end.sessionId], [false, false, s.sessionId]);
  assert.equal(fake.starts, 1);

  const after = w.mark();
  s.send('new topic');
  await idle(w, after);
  assert.equal(w.find('turn-end', after).sessionId, s.sessionId);
});

// ---- control calls ----

test('context usage: shape, cache, and one request per detail level', { skip: missing }, async () => {
  const { s, fake, w } = make();
  assert.equal(await s.contextUsage(), null, 'no process, no answer');
  await s.warm();
  const [a, b] = await Promise.all([s.contextUsage(), s.contextUsage()]);
  const c = await s.contextUsage({ detail: 'summary' });
  for (const u of [a, b, c]) assert.deepEqual([u.totalTokens, u.maxTokens, u.percentage, u.rawMaxTokens, u.model, u.autoCompact], [1200, 200000, 0.6, 200000, 'claude-haiku-fake', true]);
  assert.ok(Array.isArray(a.categories));
  assert.deepEqual(controls(fake.current, 'getContextUsage').map((x) => x.args[0]), [{ detail: 'summary' }]);
  const [f1, f2] = await Promise.all([s.contextUsage({ detail: 'full' }), s.contextUsage({ detail: 'full' })]);
  assert.ok('memoryFiles' in f1 && 'mcpTools' in f2);
  assert.equal(controls(fake.current, 'getContextUsage').length, 2);
  s.send('hi');
  await idle(w);
  await s.contextUsage();
  assert.equal(controls(fake.current, 'getContextUsage').length, 3, 'a finished turn invalidates the cache');
  assert.equal(fake.starts, 1);
});

test('context usage never throws', { skip: missing }, async () => {
  const { s } = make({}, { controls: { getContextUsage() { throw new Error('nope'); } } });
  await s.warm();
  assert.equal(await s.contextUsage(), null);
});

test('MCP rows describe servers without leaking their secrets', { skip: missing }, async () => {
  const { s, fake } = make();
  assert.deepEqual(await s.mcpStatus(), []);
  await s.warm();
  const rows = await s.mcpStatus();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].status, rows[0].scope, rows[0].transport], ['demo', 'connected', 'user', 'stdio']);
  assert.deepEqual(rows[0].tools, [{ name: 'ping', description: 'Ping', readOnly: true, destructive: false }]);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('super-secret-token-value') && !text.includes('Bearer abc'));

  const toggled = await s.mcp('toggle', 'demo', false);
  assert.equal(toggled.ok, true);
  assert.deepEqual(controls(fake.current, 'toggleMcpServer')[0].args, ['demo', false]);
  assert.equal(toggled.servers[0].name, 'demo');
  assert.equal((await s.mcp('reconnect', 'demo')).ok, true);
  assert.deepEqual([(await s.mcp('explode', 'demo')).code, (await s.mcp('toggle', '')).code], ['invalid-input', 'invalid-input']);
  const idleSession = make();
  assert.equal((await idleSession.s.mcp('toggle', 'demo', true)).code, 'no-session');
});

test('usage, task controls and reload answer in the documented shapes', { skip: missing }, async () => {
  const { s, fake } = make();
  assert.equal(await s.usage(), null);
  assert.equal((await s.stopTask('t1')).ok, false);
  await s.warm();
  const usage = await s.usage();
  assert.deepEqual(Object.keys(usage).sort(), ['rateLimits', 'rateLimitsAvailable', 'session', 'subscriptionType']);
  assert.equal((await s.stopTask('t1')).ok, true);
  assert.deepEqual(controls(fake.current, 'stopTask')[0].args, ['t1']);
  assert.equal((await s.background('toolu_1')).ok, true);
  assert.equal((await s.reload('skills')).ok, true);
  assert.equal((await s.reload('everything')).code, 'invalid-input');
});

test('rename: tells the live process the chat’s name, and says false when it can’t', { skip: missing }, async () => {
  const { s, fake, w } = make();
  assert.equal(await s.rename('Mine'), false, 'no process yet');
  s.send('hello');
  await idle(w);
  assert.equal(await s.rename('  Other   Changes '), true);
  assert.deepEqual(controls(fake.current, 'renameSession')[0].args, ['Other Changes', s.sessionId]);
  assert.equal(await s.rename('   '), false);
  assert.equal(await s.rename(null), false);
  fake.current.renameSession = () => Promise.reject(new Error('rename_session is not supported in this context'));
  assert.equal(await s.rename('Again'), false, 'a refusal is not an exception');
});

test('rewind: validated, refused mid-turn, and never throws', { skip: missing }, async () => {
  const id = randomUUID();
  const { s, fake, w, release } = await midTurn();
  assert.equal((await s.rewindFiles('not-a-uuid')).canRewind, false);
  const busy = await s.rewindFiles(id);
  assert.deepEqual([busy.canRewind, busy.error], [false, 'Stop Claude before restoring files.']);
  const preview = await s.rewindFiles(id, { dryRun: true });
  assert.equal(preview.canRewind, true, 'a preview is allowed while Claude works');
  assert.deepEqual(controls(fake.current, 'rewindFiles').map((c) => c.args), [[id, { dryRun: true }]]);
  release();
  await idle(w);
  const real = await s.rewindFiles(id);
  assert.deepEqual([real.canRewind, real.insertions, real.deletions], [true, 0, 0]);
  assert.deepEqual(controls(fake.current, 'rewindFiles').at(-1).args, [id, { dryRun: false }]);

  const failing = make({}, { controls: { rewindFiles() { throw new Error('No file checkpoint found for this message'); } } });
  await failing.s.warm();
  const r = await failing.s.rewindFiles(id);
  assert.equal(r.canRewind, false);
  assert.match(r.error, /No file checkpoint/);
  const off = make({ checkpoints: false });
  assert.equal((await off.s.rewindFiles(id)).canRewind, false);
  off.s.send('hi');
  await idle(off.w);
  assert.equal(off.fake.current.options.enableFileCheckpointing, false);
});

test('branch needs a saved conversation', { skip: missing }, async () => {
  const { s } = make();
  const r = await s.branch();
  assert.deepEqual([r.ok, r.code], [false, 'no-session']);
  s.close();
  assert.equal((await s.branch()).ok, false);
});

// ---- edit and resend ----

// The saved conversation as edit() reads it: each message's row names the row it followed (see transcript.mjs).
const userRow = (uuid, parentUuid, content = 'hi', extra = {}) => ({ type: 'user', uuid, parentUuid, origin: { kind: 'human' }, message: { role: 'user', content }, ...extra });
const replyRow = (uuid, parentUuid) => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
// A session whose saved conversation is whatever `rows()` says when edit() asks.
function editable(script = {}, opts = {}) {
  const saved = { rows: () => [] };
  const made = make({ extended: ['send-state'], readTranscript: async () => saved.rows(), ...opts }, script);
  return { ...made, saved };
}
const kindsFrom = (w, from) => w.events.slice(from).filter((e) => !/delta|send-state|message-start|status|init|meta/.test(e.kind)).map((e) => (e.kind === 'busy' ? `busy:${e.busy}` : e.kind));

test('edit mid-reply: the reply is stopped, the conversation is cut back in place, and the new text is sent', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable();
  await s.warm();
  const first = s.send('remember this');
  await idle(w);
  const sessionId = s.sessionId;
  const release = fake.current.hold();
  const second = s.send('a long task');
  await w.waitFor('text-delta', { ms: 3000, from: w.indexOf(w.of('turn-end')[0]) });
  saved.rows = () => [userRow(first.id, null), replyRow('a1', first.id), { type: 'attachment', uuid: 'n1', parentUuid: 'a1' }, userRow(second.id, 'n1'), replyRow('a2', second.id)];

  const from = w.mark();
  const id = randomUUID();
  const r = await s.edit({ messageId: second.id, text: 'a different task', id });
  assert.deepEqual(r, { ok: true, id, fresh: false, first: false });
  release();
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', from)));

  // The old process: stopped politely, asked which files the reply had changed (for the note the new message would
  // carry: none here, so there is no note), then closed. Nothing was rewound.
  const old = fake.runs[0];
  assert.deepEqual(old.calls.map((c) => c.method).filter((m) => ['interrupt', 'rewindFiles', 'close'].includes(m)), ['interrupt', 'rewindFiles', 'close']);
  assert.deepEqual(controls(old, 'rewindFiles').map((c) => c.args), [[second.id, { dryRun: true }]]);
  // The new one: the same conversation, loaded up to the row the message followed, and told which turn goes.
  const next = fake.runs[1];
  assert.equal(fake.starts, 2);
  assert.equal(next.options.resume, sessionId);
  assert.equal(next.options.resumeSessionAt, 'n1');
  assert.equal(next.options.resumeDropsTurn, second.id);
  assert.equal(s.sessionId, sessionId, 'the conversation keeps its id');
  assert.deepEqual(next.received.map((m) => [m.uuid, m.message.content]), [[id, 'a different task']]);
  // In order: the old turn ends as stopped, the process goes, `edit` marks the cut, then the new message's turn.
  assert.deepEqual(kindsFrom(w, from), ['assistant-text', 'turn-end', 'busy:false', 'stopped', 'edit', 'busy:true', 'busy:true', 'assistant-text', 'turn-end', 'busy:false']);
  const [cutOff, answered] = w.all('turn-end', from);
  assert.equal(cutOff.interrupted, true);
  assert.deepEqual(answered.userUuids, [id]);
  const mark = w.find((e) => e.kind === 'edit', from);
  assert.deepEqual([mark.id, mark.messageId, mark.fresh, mark.text], [id, second.id, false, 'a different task']);
  assert.deepEqual(s.snapshot().outbox, []);
  assert.equal(w.of('error').length, 0);

  // Once the edited message has started, the cut is over: a later start loads the conversation as it is.
  await s.stop();
  await s.warm();
  assert.equal(fake.starts, 3);
  assert.equal(fake.current.options.resume, sessionId);
  assert.equal(fake.current.options.resumeSessionAt, undefined);
  assert.equal(fake.current.options.resumeDropsTurn, undefined);
});

test('edit while idle, of an older message: several turns go, so Claude Code is not asked to check the cut', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable();
  const a = s.send('one'); await idle(w);
  const b = s.send('two'); await idle(w, w.mark());
  saved.rows = () => [userRow('u0', null), replyRow('a0', 'u0'), userRow(a.id, 'a0'), replyRow('a1', a.id), userRow(b.id, 'a1'), replyRow('a2', b.id)];
  const r = await s.edit({ messageId: a.id, text: 'one, reworded' });
  assert.equal(r.ok, true);
  assert.match(r.id, UUID_RE);
  const next = fake.runs[1];
  assert.equal(next.options.resumeSessionAt, 'a0');
  assert.equal(next.options.resumeDropsTurn, undefined);
  assert.equal(controls(fake.runs[0], 'interrupt').length, 0, 'nothing was running: nothing to stop');
  assert.deepEqual(next.received.map((m) => m.message.content), ['one, reworded']);
});

test('edit with restoreFiles: files go back while the old process is alive, before the cut', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable();
  const a = s.send('one'); await idle(w);
  const release = fake.current.hold();
  const b = s.send('write a file');
  await w.waitFor('text-delta', { ms: 3000, from: w.indexOf(w.of('turn-end')[0]) });
  saved.rows = () => [userRow(a.id, null), replyRow('a1', a.id), userRow(b.id, 'a1')];
  const r = await s.edit({ messageId: b.id, text: 'do not write it', restoreFiles: true });
  release();
  assert.equal(r.ok, true);
  // (The dry run before it is how the files are known: a real rewind does not name them.)
  const calls = fake.runs[0].calls.filter((c) => ['interrupt', 'rewindFiles', 'close'].includes(c.method));
  assert.deepEqual(calls.map((c) => c.method), ['interrupt', 'rewindFiles', 'rewindFiles', 'close']);
  assert.deepEqual(calls.slice(1, 3).map((c) => c.args), [[b.id, { dryRun: true }], [b.id, { dryRun: false }]]);
  assert.equal(controls(fake.runs[1], 'rewindFiles').length, 0);
});

test('edit with restoreFiles that cannot be done: nothing is cut and the reason comes back', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable({ controls: { rewindFiles() { return { canRewind: false, error: 'No file checkpoint found for this message' }; } } });
  const a = s.send('one'); await idle(w);
  saved.rows = () => [userRow('u0', null), replyRow('a0', 'u0'), userRow(a.id, 'a0')];
  const r = await s.edit({ messageId: a.id, text: 'again', restoreFiles: true });
  assert.deepEqual([r.ok, r.code, r.message], [false, 'rewind', 'No file checkpoint found for this message']);
  assert.equal(fake.starts, 1, 'the process was left alone');
  assert.equal(w.of('edit').length, 0);
  assert.deepEqual(fake.current.received.map((m) => m.message.content), ['one']);
});

test('a cut Claude Code refuses: the conversation stays whole, the message is not sent, and the same cut is never asked for again', { skip: missing }, async () => {
  const refusal = 'Resume rejected by --resume-drops-turn: resuming at a0 would discard entries not attributable to turn X: range contains a user entry not attributable to the declared turn';
  const { s, fake, w, saved } = editable({ onStart(run) { if (run.options.resumeDropsTurn) run.failStartup(refusal); } });
  const a = s.send('one'); await idle(w);
  const sessionId = s.sessionId;
  saved.rows = () => [userRow('u0', null), replyRow('a0', 'u0'), userRow(a.id, 'a0'), replyRow('a1', a.id)];
  const from = w.mark();
  const r = await s.edit({ messageId: a.id, text: 'one, reworded' });
  assert.deepEqual([r.ok, r.code], [false, 'edit-refused']);
  assert.match(r.message, /Nothing was changed/);
  // Claude Code is started again on the conversation as it is: no cut, and the edited message is not handed over.
  const plain = await fake.run(3);
  await w.waitFor((e) => e.kind === 'meta' && Array.isArray(e.commands), { ms: 3000, from: w.indexOf(w.find((e) => e.kind === 'stopped' && e.why === 'edit', from)) });
  await settle(60);
  assert.equal(fake.starts, 3, 'one refused start, one plain start, and no retry of the refused cut');
  assert.equal(fake.runs[1].options.resumeDropsTurn, a.id);
  assert.deepEqual([plain.options.resume, plain.options.resumeSessionAt, plain.options.resumeDropsTurn], [sessionId, undefined, undefined]);
  assert.deepEqual(plain.received, []);
  assert.equal(s.busy, false);
  assert.equal(s.sessionId, sessionId);
  assert.deepEqual(s.snapshot().outbox, []);
  assert.deepEqual(w.all((e) => e.kind === 'notice' && e.code, from).map((e) => e.code), ['edit-refused']);
  assert.equal(w.all('error', from).length, 0, 'not reported as a crash or an undelivered message');
  assert.equal(w.all((e) => e.kind === 'busy' && e.busy === false, from).length, 1);

  // You look at the conversation as it really is and edit again: this time the cut is made without the check.
  const again = await s.edit({ messageId: a.id, text: 'one, reworded' });
  assert.equal(again.ok, true);
  assert.deepEqual([fake.current.options.resumeSessionAt, fake.current.options.resumeDropsTurn], ['a0', undefined]);
  assert.deepEqual(fake.current.received.map((m) => m.message.content), ['one, reworded']);
});

test('a place to cut that Claude Code cannot load fails the edit the same way, with its own words', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable({ onStart(run) { if (run.options.resumeSessionAt) run.failStartup('No message found with message.uuid of: a0'); } });
  const a = s.send('one'); await idle(w);
  const b = s.send('two'); await idle(w, w.mark());
  saved.rows = () => [userRow(a.id, null), replyRow('a0', a.id), userRow(b.id, 'a0')];
  const r = await s.edit({ messageId: b.id, text: 'two, reworded' });
  assert.deepEqual([r.ok, r.code], [false, 'edit-failed']);
  assert.match(r.message, /No message found/);
  const plain = await fake.run(3);
  assert.equal(plain.options.resumeSessionAt, undefined);
  await settle(60);
  assert.deepEqual(plain.received, []);
  assert.equal(s.busy, false);
});

test('edit of the first message: nothing is kept, so a new conversation takes the old one’s place', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable();
  const a = s.send('one'); await idle(w);
  const old = s.sessionId;
  saved.rows = () => [userRow(a.id, null), replyRow('a1', a.id)];
  const from = w.mark();
  const r = await s.edit({ messageId: a.id, text: 'one, reworded' });
  assert.deepEqual([r.ok, r.fresh, r.first], [true, true, true]);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', from)));
  const next = fake.runs[1];
  assert.deepEqual([next.options.resume, next.options.resumeSessionAt, next.options.resumeDropsTurn], [undefined, undefined, undefined]);
  assert.notEqual(s.sessionId, old);
  assert.match(s.sessionId, UUID_RE);
  const moved = w.all((e) => e.kind === 'meta' && e.previousSessionId, from);
  assert.deepEqual(moved.map((e) => [e.sessionId, e.previousSessionId, e.supersedes]), [[s.sessionId, old, old]]);
  assert.equal(w.find((e) => e.kind === 'edit', from).fresh, true);
});

test('edit of the first message that never starts: the session goes back to the conversation it had', { skip: missing }, async () => {
  // The start after the cut dies every time, so the edited message is never taken.
  const { s, fake, w, saved } = editable({ onStart(run) { if (!run.options.resume && fake.starts > 1) run.die(); } });
  const a = s.send('one'); await idle(w);
  const old = s.sessionId;
  saved.rows = () => [userRow(a.id, null), replyRow('a1', a.id)];
  const r = await within(s.edit({ messageId: a.id, text: 'one, reworded' }), 15000, 'edit()');
  assert.deepEqual([r.ok, r.code], [false, 'edit-failed']);
  assert.equal(s.sessionId, old, 'nothing replaced the conversation, so it is still the one');
  assert.equal(w.all((e) => e.kind === 'meta' && e.supersedes).length, 0);
});

test('a start that dies before the edited message is taken is tried again with the same cut', { skip: missing }, async () => {
  let died = false;
  const { s, fake, w, saved } = editable({ onStart(run) { if (run.options.resumeSessionAt && !died) { died = true; run.die(); } } });
  const a = s.send('one'); await idle(w);
  const b = s.send('two'); await idle(w, w.mark());
  saved.rows = () => [userRow(a.id, null), replyRow('a0', a.id), userRow(b.id, 'a0')];
  const r = await within(s.edit({ messageId: b.id, text: 'two, reworded' }), 15000, 'edit()');
  assert.equal(r.ok, true);
  assert.equal(fake.starts, 3);
  assert.deepEqual(fake.runs.slice(1).map((run) => run.options.resumeSessionAt), ['a0', 'a0']);
  assert.deepEqual(fake.current.received.map((m) => m.message.content), ['two, reworded']);
});

test('edit of a message Claude Code had not started on: it is withdrawn and the new text goes out on the conversation as it is', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable();
  const a = s.send('one'); await idle(w);
  const release = fake.current.hold();
  const b = s.send('a long task');
  await w.waitFor('text-delta', { ms: 3000, from: w.indexOf(w.of('turn-end')[0]) });
  const c = s.send('and then this');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === c.id && e.state === 'queued', { ms: 3000 });
  saved.rows = () => [userRow(a.id, null), replyRow('a1', a.id), userRow(b.id, 'a1')]; // c was never saved
  const r = await s.edit({ messageId: c.id, text: 'and then that' });
  release();
  assert.equal(r.ok, true);
  const next = fake.runs[1];
  assert.equal(next.options.resume, s.sessionId);
  assert.equal(next.options.resumeSessionAt, undefined, 'nothing to cut: the message was never part of the conversation');
  assert.deepEqual(next.received.map((m) => m.message.content), ['and then that']);
  assert.ok(sendStates(w, c.id).includes('cancelled'));
});

test('an edited message keeps its attachments, unless it is given others', { skip: missing }, async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const { s, fake, w, saved } = editable();
  const a = s.send('one'); await idle(w);
  saved.rows = () => [userRow('u0', null), replyRow('a0', 'u0'), userRow(a.id, 'a0', [image, { type: 'text', text: 'what is this' }])];
  assert.equal((await s.edit({ messageId: a.id, text: 'what is in this picture' })).ok, true);
  assert.deepEqual(fake.current.received[0].message.content, [image, { type: 'text', text: 'what is in this picture' }]);
  await idle(w, w.indexOf(w.of('edit').at(-1)));
  // The words can go when a picture stays; with nothing at all there is nothing to send.
  const b = fake.current.received[0].uuid;
  saved.rows = () => [userRow('u0', null), replyRow('a0', 'u0'), userRow(b, 'a0', [image, { type: 'text', text: 'what is in this picture' }])];
  assert.equal((await s.edit({ messageId: b, text: '' })).ok, true);
  assert.deepEqual(fake.current.received[0].message.content, [image]);
  await idle(w, w.indexOf(w.of('edit').at(-1)));
  const c = fake.current.received[0].uuid;
  saved.rows = () => [userRow('u0', null), replyRow('a0', 'u0'), userRow(c, 'a0', [image])];
  assert.equal((await s.edit({ messageId: c, text: 'no picture now', images: [] })).ok, true);
  assert.equal(fake.current.received[0].message.content, 'no picture now');
});

test('edit refuses what it cannot do, and brings Claude Code back when it had already stopped it', { skip: missing }, async () => {
  const { s, fake, w, saved } = editable();
  const id = randomUUID();
  assert.equal((await s.edit({ messageId: 'not-a-uuid', text: 'x' })).code, 'invalid-input');
  assert.equal((await s.edit({ messageId: id, text: 5 })).code, 'invalid-input');
  assert.equal((await s.edit({ messageId: id, text: 'x', id: 'nope' })).code, 'invalid-input');
  assert.equal((await s.edit({ messageId: id, text: '   ', images: [] })).code, 'invalid-input');
  assert.equal((await s.edit()).code, 'invalid-input');
  assert.equal((await s.edit({ messageId: id, text: 'x' })).code, 'not-found', 'no saved conversation yet');

  const a = s.send('one'); await idle(w);
  // Not in the saved conversation.
  saved.rows = () => [userRow(a.id, null)];
  const from = w.mark();
  const gone = await s.edit({ messageId: id, text: 'x' });
  assert.deepEqual([gone.ok, gone.code], [false, 'not-found']);
  const back = await fake.run(2);
  assert.deepEqual([back.options.resume, back.options.resumeSessionAt], [s.sessionId, undefined]);
  await w.waitFor((e) => e.kind === 'meta' && Array.isArray(e.commands), { ms: 3000, from });
  assert.deepEqual(back.received, []);
  assert.equal(w.all('edit', from).length, 0);
  // From before the conversation was summarized.
  saved.rows = () => [userRow(a.id, null), { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null }, userRow('u9', 'c1')];
  assert.equal((await s.edit({ messageId: a.id, text: 'x' })).code, 'compacted');
  // Saved with nothing but attachments we no longer have, and no words given.
  saved.rows = () => [userRow('u0', null), userRow(a.id, 'u0')];
  assert.equal((await s.edit({ messageId: a.id, text: '' })).code, 'invalid-input');

  // One edit at a time.
  saved.rows = () => [userRow('u0', null), replyRow('a0', 'u0'), userRow(a.id, 'a0')];
  const [one, two] = await Promise.all([s.edit({ messageId: a.id, text: 'x' }), s.edit({ messageId: a.id, text: 'y' })]);
  assert.deepEqual([one.ok, two.ok, two.code], [true, false, 'busy']);

  await s.stop({ park: true });
  assert.equal((await s.edit({ messageId: a.id, text: 'x' })).code, 'parked');
  s.unpark();
  s.close();
  assert.equal((await s.edit({ messageId: a.id, text: 'x' })).code, 'closed');
});

test('module exports', { skip: missing }, () => {
  assert.equal(typeof S.Session, 'function');
  assert.equal(S.CORE_API, 2);
  assert.ok(Array.isArray(S.CORE_DEGRADED));
  assert.deepEqual([...S.EXTENDED_KINDS].sort(), ['send-state', 'tasks', 'tool-input-delta', 'tool-pending']);
});

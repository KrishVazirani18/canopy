// Live tests: Session against the real claude.
//
//   node src/core/test/run.mjs [--only a,b] [--list] [--keep] [--jobs N] [--strict] [--verbose]
//
// Prints one line per case, `PASS|FAIL|SKIP <name> <ms>ms [- reason]`, then
// `RESULT pass=N fail=N skip=N`. Exits 1 on any FAIL (with --strict also on a
// SKIP of a required case). A case that needs something this copy of the core
// does not have reports SKIP.
//
// Every session uses model haiku, tiny prompts, a folder from a fixed pool
// under /tmp and no user or project settings. Only our own child processes are
// ever signalled, by pid. Everything created is removed at the end.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import {
  CwdPool, Skip, UUID_RE, acquireLock, check, cleanup, core, emptyDir, findClaudeBin, hasKeys, noteSessionId, pidAlive, pidArgs,
  releaseLock, scrubbedEnv, signal, skip, sleep, waitPidGone, watch, within,
} from './helpers.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = value('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const jobs = Math.max(1, Math.min(6, Number(value('--jobs')) || 3));
const verbose = flag('--verbose');

const BYPASS_NOTICE = 'Bypass permissions is not enabled for this session. Turn it on in your Claude Code settings first (the same as the terminal requires).';
const LONG = 'Count from 1 to 400, one number per line, and nothing else.';
const WRITE = (file, text = 'hi') => `Use the Write tool to create the file ${file} containing exactly: ${text}. Then reply with exactly: OK`;

// Every event kind the renderer knows. Anything else needs an `extended` opt-in,
// because the renderer shows an unknown kind as a raw row.
const KNOWN_KINDS = new Set([
  'init', 'meta', 'busy', 'status', 'message-start', 'text-delta', 'thinking-delta', 'assistant-text', 'thinking', 'tool-start', 'tool-result',
  'tool-progress', 'tool-input-partial', 'permission', 'permission-resolved', 'turn-end', 'notice', 'error', 'stopped', 'hook', 'task', 'commands-changed', 'suggestion',
  'raw', 'setting', 'setting-failed', 'user-text', 'context-note', 'command-output', 'edit',
]);
const GATED = { 'send-state': 'send-state', tasks: 'tasks', 'tool-pending': 'tool-stream', 'tool-input-delta': 'tool-stream' };

const sessionMod = await core('session.mjs');
const adapterMod = await core('adapter.mjs');
const historyMod = await core('history.mjs');
const trustMod = await core('trust.mjs');
const sessionsMod = await core('sessions.mjs');

const env = scrubbedEnv();
const claude = findClaudeBin(env);
const pool = new CwdPool();
const live = new Set();          // sessions still open, for the signal handler
const ourPids = new Set();       // every child pid we were told about

// ---- per-case context ----

class Case {
  constructor(name, cwd) {
    this.name = name; this.cwd = cwd; this.realCwd = fs.realpathSync(cwd);
    this.sessions = []; this.env = env; this.claude = claude; this.notes = [];
  }

  // A Session with the test defaults, plus an event recorder.
  open(opts = {}) {
    const s = new sessionMod.Session({
      cwd: this.cwd, claudePath: claude, env, model: 'haiku', settingSources: [], strictMcpConfig: true, trusted: true,
      suggestions: false, extended: ['send-state', 'tasks'], appVersion: 'core-test', ...opts,
    });
    const w = watch(s);
    const remember = () => { const pid = s.pid; if (Number.isInteger(pid)) ourPids.add(pid); };
    s.on('event', remember);
    const extended = opts.extended ?? ['send-state', 'tasks'];
    this.sessions.push({ s, w, allowed: extended === true ? Object.values(GATED) : Array.isArray(extended) ? extended : [] });
    live.add(s);
    return { s, w };
  }

  // Send and wait until that send's turn is over and the session is idle again.
  async turn(s, w, text, { images = [], ms = 90000 } = {}) {
    const from = w.mark();
    const r = s.send(text, images);
    check(r?.ok === true, `send() returned ${JSON.stringify(r)}`);
    const end = await w.waitFor((e) => e.kind === 'turn-end' && (e.userUuids ?? []).includes(r.id), { ms, from, label: `turn-end for "${text.slice(0, 30)}"` });
    await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 20000, from: w.indexOf(end), label: 'busy:false after the turn' });
    return { id: r.id, end, from, text: w.text(from) };
  }

  // Start a turn that keeps streaming, and return once it visibly runs.
  async longTurn(s, w) {
    const from = w.mark();
    const r = s.send(LONG);
    check(r?.ok === true, `send() returned ${JSON.stringify(r)}`);
    await w.waitFor('text-delta', { ms: 60000, from, label: 'the first streamed text' });
    const pid = s.pid;
    check(Number.isInteger(pid) && pidAlive(pid), `expected a live child pid, got ${pid}`);
    return { id: r.id, from, pid };
  }

  note(text) { this.notes.push(text); }

  // Checked after every passing case: no session emitted a kind its host did not opt into.
  checkContract() {
    for (const { w, allowed } of this.sessions) {
      const stray = [...new Set(w.events.map((e) => e.kind))].filter((k) => !KNOWN_KINDS.has(k) && !allowed.includes(GATED[k]));
      check(!stray.length, `event kinds outside the contract: ${stray.join(', ')}`);
      const unnumbered = w.events.filter((e) => !Number.isInteger(e.seq)).length;
      check(!unnumbered, `${unnumbered} event(s) without seq`);
    }
  }

  async dispose() {
    for (const { s, w } of this.sessions.splice(0)) {
      const pid = s.pid;
      try {
        if (typeof s.dispose === 'function') await within(s.dispose({ graceMs: 2000 }), 8000, 'dispose');
        else s.close();
      } catch { try { s.close(); } catch { /* already closed */ } }
      w.stop();
      live.delete(s);
      if (Number.isInteger(pid) && pidAlive(pid)) { signal(pid, 'SIGCONT'); signal(pid, 'SIGKILL'); }
    }
  }
}

const needsCore = () => { if (!(sessionMod.CORE_API >= 2)) skip(sessionMod.__missing ? `session.mjs failed to load: ${sessionMod.__missing}` : 'session.mjs is not CORE_API 2'); };
const needs = (obj, method, what) => { if (typeof obj?.[method] !== 'function') skip(`${what}.${method}() is not there`); };
const noErrors = (w, from = 0) => { const errs = w.all('error', from); check(!errs.length, `unexpected error event: ${errs.map((e) => `${e.code}: ${e.message}`).join(' | ')}`); };
const noRaw = (w) => { const raw = w.of('raw'); check(!raw.length, `raw events leaked: ${raw.map((e) => e.label).join(', ')}`); };
const says = (text, word) => check(String(text).toUpperCase().includes(word.toUpperCase()), `expected the reply to contain ${word}, got ${JSON.stringify(String(text).slice(0, 120))}`);
const history = (sessionId, cwd) => getSessionMessages(sessionId, { dir: cwd });
const userRowsWith = (rows, word) => rows.filter((m) => m.type === 'user' && JSON.stringify(m.message?.content ?? '').includes(word)).length;

// Wait for a permission request of one type; a turn that ends first means the model did not use the tool.
async function permission(w, type, from, ms = 90000) {
  const ev = await w.waitFor((e) => (e.kind === 'permission' && (!type || e.type === type)) || e.kind === 'turn-end', { ms, from, label: `a ${type ?? 'permission'} request` });
  check(ev.kind === 'permission', `the model ended its turn without asking (${type ?? 'tool'}): ${JSON.stringify(w.text(from).slice(0, 100))}`);
  return ev;
}

// ---- cases ----

const cases = [];
// `flaky` cases depend on the model choosing a tool, so they get a second attempt.
const add = (name, opts, run) => cases.push({ name, required: true, flaky: false, ms: 150000, ...opts, run });

add('turn', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const r = s.send('Reply with exactly: PONG');
  check(r.ok === true && UUID_RE.test(r.id), `send() returned ${JSON.stringify(r)}`);
  check(s.busy === true, 'busy must be true as soon as send() returns');
  const end = await w.waitFor('turn-end', { label: 'turn-end' });
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, label: 'busy:false' });

  const busy = w.of('busy');
  check(busy[0].busy === true && busy[0].state === 'starting', `first busy event was ${JSON.stringify(busy[0])}`);
  check(busy.some((e) => e.state === 'running'), 'never saw state "running"');
  check(busy.filter((e) => !e.busy).length === 1, `expected one busy:false, saw ${busy.filter((e) => !e.busy).length}`);
  check(busy.at(-1).state === 'idle', 'the last busy event should be idle');
  check(w.indexOf(end) < w.indexOf(busy.at(-1)), 'busy cleared before the turn ended');

  hasKeys(end, ['subtype', 'isError', 'cost', 'durationMs', 'turns', 'errors', 'text', 'fastState', 'fastReason', 'interrupted', 'turnCost', 'userUuids', 'sessionId', 'contextTokens', 'contextWindow', 'errorCode'], 'turn-end');
  check(end.subtype === 'success' && end.isError === false && end.interrupted === false, `turn-end was ${end.subtype} isError=${end.isError} interrupted=${end.interrupted}`);
  check(end.cost > 0 && end.turnCost > 0 && end.turnCost <= end.cost + 1e-9, `cost=${end.cost} turnCost=${end.turnCost}`);
  check(end.durationMs > 0 && end.turns >= 1, 'duration and turns should be positive');
  check(JSON.stringify(end.userUuids) === JSON.stringify([r.id]), `turn-end.userUuids=${JSON.stringify(end.userUuids)}, expected the send id`);
  check(UUID_RE.test(end.sessionId) && end.sessionId === s.sessionId, 'turn-end.sessionId should be the session id');
  check(end.contextTokens > 0 && end.contextWindow > 0, `contextTokens=${end.contextTokens} contextWindow=${end.contextWindow}`);
  check((end.errorCode ?? null) === null && end.errors.length === 0, 'a clean turn has no error code');
  says(end.text, 'PONG');
  says(w.text(), 'PONG');

  const inits = w.of('init');
  check(inits.length === 1 && inits[0].first === true, 'expected one init with first:true');
  check(/haiku/.test(inits[0].model), `the model was ${inits[0].model}`);
  const final = w.find((e) => e.kind === 'assistant-text' && !e.parent);
  check(final && UUID_RE.test(final.uuid) && Number.isFinite(final.at), 'assistant-text should carry uuid and at');
  const seqs = w.events.map((e) => e.seq);
  check(seqs.every((n, i) => Number.isInteger(n) && (i === 0 || n > seqs[i - 1])), 'seq must increase on every event');
  const states = w.all((e) => e.kind === 'send-state' && e.id === r.id).map((e) => e.state);
  check(states[0] === 'pending' && states.at(-1) === 'completed' && states.includes('started'), `send states were ${states.join(' > ')}`);
  check(s.snapshot().outbox.length === 0, 'the outbox should be empty after the turn');
  noErrors(w); noRaw(w);
  check(!JSON.stringify(w.events).includes('messaging_socket') && !/"messagingSocket/i.test(JSON.stringify(w.events)), 'the messaging socket path was forwarded');
});

add('back-to-back', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const a = s.send('Reply with exactly: ALPHA');
  const b = s.send('Reply with exactly: BRAVO');
  check(a.ok && b.ok && a.id !== b.id, 'both sends should be accepted with different ids');
  const done = new Set();
  await w.waitFor((e) => { if (e.kind === 'turn-end') for (const id of e.userUuids ?? []) done.add(id); return done.has(a.id) && done.has(b.id); }, { label: 'both sends answered' });
  const lastEnd = w.of('turn-end').at(-1);
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, from: w.indexOf(lastEnd), label: 'busy:false' });
  const early = w.events.slice(0, w.indexOf(lastEnd)).filter((e) => e.kind === 'busy' && !e.busy);
  check(early.length === 0, `busy:false was emitted ${early.length} time(s) before the last turn ended`);
  says(w.text(), 'ALPHA'); says(w.text(), 'BRAVO');
  check(w.of('turn-end').every((e) => !e.isError), 'no turn should have failed');
  check(s.snapshot().outbox.length === 0, 'the outbox should be empty');
  noErrors(w); noRaw(w);
});

add('warm-send', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const r = await within(s.warm(), 60000, 'warm()');
  check(r?.ok === true, `warm() returned ${JSON.stringify(r)}`);
  check(Number.isFinite(r.startupMs), 'warm() should report startupMs');
  const pid = s.pid;
  check(pidAlive(pid), 'a process should be running after warm()');
  check(s.busy === false && !w.find((e) => e.kind === 'busy' && e.busy), 'warming must not look busy');
  const meta = w.find((e) => e.kind === 'meta' && Array.isArray(e.commands));
  check(meta && meta.commands.length > 0 && Array.isArray(meta.models) && meta.models.length > 0, 'meta should list commands and models');
  hasKeys(meta, ['mode', 'sessionId', 'fastState', 'agents', 'outputStyle', 'capabilities', 'version', 'account', 'startupMs', 'restricted'], 'meta');
  check(meta.mode === 'default', `the reported mode was ${meta.mode}`);
  check(s.snapshot().lifecycle === 'ready', `lifecycle was ${s.snapshot().lifecycle}`);
  check((await s.warm()).ok === true && s.pid === pid, 'a second warm() must reuse the process');

  const turn = await t.turn(s, w, 'Reply with exactly: WARMED');
  says(turn.text, 'WARMED');
  check(turn.end.coldStart === false, 'a send after warm() is not a cold start');
  check(s.pid === pid, 'the warmed process should have answered');
  check(w.all((e) => e.kind === 'meta' && Array.isArray(e.commands)).length === 1, 'exactly one full meta per process');
  noErrors(w); noRaw(w);
});

add('permission-allow', { flaky: true }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'default' });
  const from = w.mark();
  const r = s.send(WRITE('note.txt'));
  const p = await permission(w, 'tool', from);
  check(p.toolName === 'Write', `the request was for ${p.toolName}`);
  hasKeys(p, ['id', 'input', 'hasSuggestions', 'suggestions', 'reason', 'blockedPath', 'toolUseId', 'agentId', 'sessionId', 'title', 'displayName', 'description', 'defaultToNo'], 'permission');
  check(String(p.input.file_path).endsWith('note.txt'), `file_path was ${p.input.file_path}`);
  check(/^toolu_/.test(p.toolUseId), 'the request should name its tool call');
  check(Array.isArray(p.suggestions) && p.hasSuggestions === p.suggestions.length > 0, 'hasSuggestions should match suggestions');
  check(s.snapshot().pending.some((x) => x.id === p.id), 'the request should be in snapshot().pending');
  check(w.find((e) => e.kind === 'busy' && e.state === 'requires_action'), 'busy should report requires_action while waiting');
  const res = s.respond(p.id, { action: 'allow' });
  check(res?.ok === true, `respond() returned ${JSON.stringify(res)}`);
  const end = await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids.includes(r.id), { from });
  check(!end.isError, 'the turn should succeed');
  check(fs.readFileSync(path.join(t.cwd, 'note.txt'), 'utf8').trim() === 'hi', 'note.txt should contain hi');
  const result = w.find((e) => e.kind === 'tool-result' && e.id === p.toolUseId);
  check(result && !result.isError, 'the Write result should not be an error');
  check(result.structured?.type === 'create', `tool-result.structured was ${JSON.stringify(result.structured)?.slice(0, 80)}`);
  check(w.find((e) => e.kind === 'permission-resolved' && e.id === p.id), 'permission-resolved should follow');
  check(s.respond(p.id, { action: 'allow' })?.code === 'stale', 'a second answer should be stale');
  noRaw(w);
});

add('permission-deny', { flaky: true }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'default' });
  const from = w.mark();
  const r = s.send(`${WRITE('note.txt')}. If you are not allowed to, reply with exactly: DENIED`);
  const p = await permission(w, 'tool', from);
  s.respond(p.id, { action: 'deny', message: 'Not allowed in this test. Do not try again.' });
  const end = await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids.includes(r.id), { from });
  // The model may try once more; every further request is denied too.
  for (const again of w.all((e) => e.kind === 'permission' && e.id !== p.id, from)) s.respond(again.id, { action: 'deny' });
  check(!end.isError && !end.interrupted, 'a plain deny lets the turn continue');
  check(!fs.existsSync(path.join(t.cwd, 'note.txt')), 'the file must not exist');
  const result = w.find((e) => e.kind === 'tool-result' && e.id === p.toolUseId);
  check(result?.isError === true, 'the denied tool call should come back as an error result');
  check(/Not allowed in this test/.test(result.content), 'the deny message should reach Claude');
  noErrors(w); noRaw(w);
});

add('permission-always', { flaky: true }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'default' });
  const from = w.mark();
  const r = s.send(WRITE('a.txt', 'one'));
  const p = await permission(w, 'tool', from);
  check(p.hasSuggestions, 'Claude Code offered no "always" suggestion for Write');
  s.respond(p.id, { action: 'always' });
  await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids.includes(r.id), { from });
  const granted = w.find((e) => e.kind === 'notice' && e.code === 'granted');
  check(granted && Array.isArray(granted.grants) && granted.grants.length > 0 && granted.text, 'a notice should say what was granted');
  t.note(granted.text);
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, from });
  if (p.suggestions.some((u) => u.type === 'setMode')) check(s.mode === p.suggestions.find((u) => u.type === 'setMode').mode, `the granted mode was not tracked (mode=${s.mode})`);

  const second = w.mark();
  const turn = await t.turn(s, w, WRITE('b.txt', 'two'));
  check(w.all('permission', second).length === 0, 'the second Write should not prompt after "always"');
  check(fs.existsSync(path.join(t.cwd, 'a.txt')) && fs.existsSync(path.join(t.cwd, 'b.txt')), 'both files should exist');
  check(!turn.end.isError, 'the second turn should succeed');
  noErrors(w);
});

const ASK = 'Use the AskUserQuestion tool to ask me exactly one question, "Which color?", with the two options "Red" and "Blue". Do not ask in plain text.';

add('question-answers', { flaky: true }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'default' });
  const from = w.mark();
  const r = s.send(`${ASK} After I answer, reply with exactly the color I chose and nothing else.`);
  const p = await permission(w, 'question', from);
  const q = p.input?.questions?.[0]?.question;
  check(typeof q === 'string' && q, 'the question request should carry its questions');
  const res = s.respond(p.id, { action: 'answers', answers: { [q]: 'Blue', 'Not asked': 'x' } });
  check(res?.ok === true, `respond() returned ${JSON.stringify(res)}`);
  const end = await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids.includes(r.id), { from });
  check(!end.isError, 'the turn should succeed');
  const result = w.find((e) => e.kind === 'tool-result' && e.id === p.toolUseId);
  check(result && !result.isError, `the answer was rejected: ${result?.content?.slice(0, 160)}`);
  says(w.text(from), 'Blue');
  noErrors(w); noRaw(w);
});

add('question-skip', { flaky: true }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'default' });
  const from = w.mark();
  const r = s.send(`${ASK} If I do not answer, reply with exactly: NO ANSWER`);
  const p = await permission(w, 'question', from);
  s.respond(p.id, { action: 'question-skip', how: 'skipped' });
  const end = await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids.includes(r.id), { from });
  for (const again of w.all((e) => e.kind === 'permission' && e.id !== p.id, from)) s.respond(again.id, { action: 'question-skip' });
  check(!end.isError && !end.interrupted, 'skipping a question must not fail or stop the turn');
  const result = w.find((e) => e.kind === 'tool-result' && e.id === p.toolUseId);
  check(result, 'the question tool call should get a result');
  const caps = w.find('init')?.capabilities ?? [];
  // With the capability, a skip is an "unanswered" answer the CLI must accept, not a tool error.
  if (caps.includes('ask_user_question_unanswered_v1')) check(!result.isError, `the CLI rejected the unanswered shape: ${result.content.slice(0, 200)}`);
  t.note(`result: ${result.content.slice(0, 80).replace(/\s+/g, ' ')}`);
  noErrors(w); noRaw(w);
});

const PLAN = 'Make a plan to create the file note.txt containing exactly: hi. Do not ask me any questions and do not explore. Call ExitPlanMode with the plan right away. Once I approve it, create the file with the Write tool and reply with exactly: DONE';

add('plan-approve', { flaky: true, ms: 200000 }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'plan' });
  const from = w.mark();
  const r = s.send(PLAN);
  const p = await permission(w, 'plan', from, 120000);
  check(typeof p.input?.plan === 'string' && p.input.plan.length > 0, 'the plan request should carry the plan text');
  check(!fs.existsSync(path.join(t.cwd, 'note.txt')), 'nothing may be written before the plan is approved');
  const afterPlan = w.mark();
  const res = s.respond(p.id, { action: 'plan-approve', mode: 'acceptEdits' });
  check(res?.ok === true, `respond() returned ${JSON.stringify(res)}`);
  check(s.mode === 'acceptEdits', `the mode should switch with the approval, it is ${s.mode}`);
  const end = await w.waitFor((e) => e.kind === 'turn-end' && e.userUuids.includes(r.id), { from, ms: 120000 });
  const prompts = w.all('permission', afterPlan);
  check(prompts.length === 0, `the first tool after approval prompted (${prompts.map((x) => x.toolName).join(', ')}): the mode switch was not atomic`);
  check(!end.isError, 'the turn should succeed');
  check(fs.existsSync(path.join(t.cwd, 'note.txt')), 'note.txt should have been written without a prompt');
  check(s.snapshot().settings.permissionMode === 'acceptEdits', 'snapshot should report the new mode');
  check(w.all((e) => (e.kind === 'status' || e.kind === 'init') && e.permissionMode === 'acceptEdits', afterPlan).length > 0 || s.mode === 'acceptEdits', 'Claude Code should report acceptEdits');
  noErrors(w); noRaw(w);
});

add('plan-reject', { flaky: true, ms: 200000 }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'plan' });
  const from = w.mark();
  const r = s.send(PLAN);
  const p = await permission(w, 'plan', from, 120000);
  s.respond(p.id, { action: 'plan-reject', message: 'Not now. Reply with exactly: KEEPING THE PLAN and stop.' });
  // The model may present a revised plan; a second rejection stops it.
  for (;;) {
    const ev = await w.waitFor((e) => (e.kind === 'permission' && e.id !== p.id && !e.answered) || (e.kind === 'turn-end' && e.userUuids.includes(r.id)), { from, ms: 120000, label: 'the turn to end' });
    if (ev.kind === 'turn-end') break;
    ev.answered = true;
    s.respond(ev.id, ev.type === 'plan' ? { action: 'plan-reject', stop: true } : { action: 'deny', stop: true });
  }
  check(!fs.existsSync(path.join(t.cwd, 'note.txt')), 'a rejected plan must not write the file');
  check(s.mode === 'plan', `the session should still be in plan mode, it is ${s.mode}`);
  noErrors(w); noRaw(w);
});

add('interrupt', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const long = await t.longTurn(s, w);
  const queued = s.send('Reply with exactly: QUEUED-MARKER');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === queued.id && e.state === 'queued', { ms: 15000, label: 'the queued send to be acknowledged' });
  const r = await within(s.interrupt(), 20000, 'interrupt()');
  check(r?.ok === true && !r.forced, `interrupt() returned ${JSON.stringify(r)}`);
  check(r.cancelled.length === 1 && r.cancelled[0].id === queued.id && r.cancelled[0].text === 'Reply with exactly: QUEUED-MARKER', `cancelled was ${JSON.stringify(r.cancelled)}`);
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, label: 'busy:false after Stop' });
  await sleep(1500);

  const ends = w.of('turn-end');
  check(ends.length === 1, `expected one turn-end, saw ${ends.length}`);
  check(ends[0].interrupted === true && ends[0].isError === false && ends[0].errors.length === 0, `the stopped turn was isError=${ends[0].isError} interrupted=${ends[0].interrupted} errors=${JSON.stringify(ends[0].errors)}`);
  check(ends[0].userUuids.includes(long.id), 'the stopped turn should be the long one');
  check(!w.events.some((e) => (e.kind === 'assistant-text' || e.kind === 'text-delta') && /QUEUED-MARKER/.test(e.text)), 'the queued message was answered');
  check(!w.events.some((e) => /Request interrupted/.test(e.text ?? '')), 'the interrupt marker was shown as text');
  const notice = w.find((e) => e.kind === 'notice' && e.code === 'send-cancelled');
  check(notice?.cancelled?.[0]?.id === queued.id, 'a send-cancelled notice should name the queued message');
  check(s.snapshot().outbox.length === 0, 'the outbox should be empty');
  check(s.pid === long.pid && pidAlive(long.pid), 'a clean stop keeps the same process');
  noErrors(w); noRaw(w);

  const next = await t.turn(s, w, 'Reply with exactly: AFTER');
  says(next.text, 'AFTER');
  check(next.end.interrupted === false && !next.end.isError, 'the turn after a stop is a normal turn');
  check(userRowsWith(await history(s.sessionId, t.cwd), 'QUEUED-MARKER') === 0, 'the cancelled message reached the conversation');
});

add('sigstop-interrupt', { ms: 120000 }, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const first = await t.turn(s, w, 'Remember the word PAPAYA. Reply with exactly: OK');
  const sessionId = s.sessionId;
  const long = await t.longTurn(s, w);
  check(signal(long.pid, 'SIGSTOP'), 'could not freeze our own child');
  const t0 = Date.now();
  const r = await within(s.interrupt(), 30000, 'interrupt() on a frozen process');
  const took = Date.now() - t0;
  check(r?.ok === true && r.forced === true, `interrupt() returned ${JSON.stringify(r)}`);
  check(took < 20000, `force-stop took ${took}ms`);
  check(await waitPidGone(long.pid, 8000), 'the frozen process should be gone');
  const end = w.all('turn-end', long.from);
  check(end.length === 1 && end[0].interrupted === true && end[0].isError === false, `expected one interrupted turn-end, got ${JSON.stringify(end.map((e) => [e.subtype, e.interrupted, e.isError]))}`);
  const stopped = w.find('stopped', long.from);
  check(stopped?.reason === 'force-stop', `stopped.reason was ${stopped?.reason}`);
  check(s.busy === false, 'the session should be idle after a force-stop');
  t.note(`forced after ${took}ms`);

  const next = await t.turn(s, w, 'Which word did I ask you to remember? Reply with only that word.');
  says(next.text, 'PAPAYA');
  check(s.sessionId === sessionId, 'the conversation should be the same one');
  check(s.pid !== long.pid && pidAlive(s.pid), 'a new process should be answering');
  check(first.end.sessionId === next.end.sessionId, 'both turns belong to one session');
});

add('stop-midturn', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const long = await t.longTurn(s, w);
  const pending = s.stop();
  check(typeof pending?.then === 'function', 'stop() should return a promise');
  const r = await within(pending, 20000, 'stop()');
  check(!pidAlive(long.pid), 'stop() resolved while the process was still alive');
  check(r?.ok === true && r.exited === true, `stop() returned ${JSON.stringify(r)}`);
  const ends = w.of('turn-end');
  check(ends.length === 1 && ends[0].interrupted === true && ends[0].isError === false, `expected one interrupted turn-end, got ${JSON.stringify(ends.map((e) => [e.subtype, e.interrupted, e.isError]))}`);
  const stopped = w.of('stopped');
  check(stopped.length === 1 && stopped[0].reason === 'stop' && stopped[0].willRestart === false, `stopped events: ${JSON.stringify(stopped.map((e) => [e.reason, e.willRestart]))}`);
  check(s.busy === false && w.of('busy').at(-1).busy === false, 'busy should be off');
  check(!s.q, 'no process handle should remain');
  noErrors(w);
  await sleep(1500);
  check(s.pid == null, 'the session must not restart by itself after stop()');
  const next = await t.turn(s, w, 'Reply with exactly: BACK');
  says(next.text, 'BACK');
});

add('park', {}, async (t) => {
  needsCore();
  needs(sessionMod.Session.prototype, 'unpark', 'Session');
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word BANANA. Reply with exactly: OK');
  const pid = s.pid;
  const r = await within(s.stop({ park: true }), 20000, 'stop({park})');
  check(r?.ok === true && !pidAlive(pid), 'parking should end the process before resolving');
  check(w.find('stopped')?.reason === 'parked', `stopped.reason was ${w.find('stopped')?.reason}`);
  const from = w.mark();
  const refused = s.send('Reply with exactly: NOPE');
  check(refused?.ok === false && refused.code === 'parked', `send() while parked returned ${JSON.stringify(refused)}`);
  await s.warm();
  await sleep(500);
  check(s.pid == null, 'warm() must not start a parked session');
  check(w.find('error', from)?.code === 'parked', 'the refusal should be reported as an error event with code parked');
  s.unpark();
  const next = await t.turn(s, w, 'Which word did I ask you to remember? Reply with only that word.');
  says(next.text, 'BANANA');
});

add('dispose', {}, async (t) => {
  needsCore();
  needs(sessionMod.Session.prototype, 'dispose', 'Session');
  const { s, w } = t.open();
  const long = await t.longTurn(s, w);
  await within(s.dispose(), 15000, 'dispose()');
  check(!pidAlive(long.pid), 'dispose() resolved while the process was still alive');
  check(s.closed === true, 'the session should be closed');
  const refused = s.send('late');
  check(refused?.ok === false && refused.code === 'closed', `send() after dispose returned ${JSON.stringify(refused)}`);
});

add('kill-resume', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word MANGO. Reply with exactly: OK');
  const sessionId = s.sessionId;
  const long = await t.longTurn(s, w);
  check(signal(long.pid, 'SIGKILL'), 'could not kill our own child');
  const stopped = await w.waitFor('stopped', { ms: 20000, from: long.from, label: 'the crash to be noticed' });
  check(stopped.reason === 'crash', `stopped.reason was ${stopped.reason}`);
  const end = w.all('turn-end', long.from);
  check(end.length === 1 && end[0].synthetic === true && end[0].isError === true && end[0].interrupted === false, `expected one synthetic failed turn-end, got ${JSON.stringify(end.map((e) => [e.subtype, e.synthetic, e.isError]))}`);
  const errors = w.all('error', long.from);
  check(errors.length === 1 && errors[0].code === 'turn-lost' && errors[0].recoverable === true, `error events: ${JSON.stringify(errors.map((e) => e.code))}`);
  check(errors[0].prompt?.id === long.id && errors[0].prompt.text === LONG, 'the error should carry the lost prompt');
  check(errors[0].signal === 'SIGKILL', `the error should name the signal, got ${errors[0].signal}`);
  check(s.busy === false, 'busy should be off after the crash');

  const next = await t.turn(s, w, 'Which word did I ask you to remember? Reply with only that word.');
  says(next.text, 'MANGO');
  check(s.sessionId === sessionId, 'the conversation should resume, not restart');
  check(s.pid !== long.pid, 'a new process should be answering');
  check(userRowsWith(await history(sessionId, t.cwd), 'Count from 1 to 400') === 1, 'the lost prompt must not be re-run');
});

add('kill-send-same-tick', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  await t.turn(s, w, 'Reply with exactly: READY');
  const pid = s.pid;
  const from = w.mark();
  signal(pid, 'SIGKILL');
  const r = s.send('Reply with exactly: PHOENIX');
  check(r?.ok === true, `send() returned ${JSON.stringify(r)}`);
  const end = await w.waitFor((e) => e.kind === 'turn-end' && (e.userUuids ?? []).includes(r.id), { ms: 90000, from, label: 'the redelivered send to be answered' });
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, from: w.indexOf(end) });
  await sleep(1500);
  check(!end.isError, 'the redelivered turn should succeed');
  check(w.all((e) => e.kind === 'turn-end' && (e.userUuids ?? []).includes(r.id), from).length === 1, 'the send was answered more than once');
  check(w.all((e) => e.kind === 'assistant-text' && !e.parent && /PHOENIX/.test(e.text), from).length === 1, 'expected exactly one PHOENIX reply');
  check(userRowsWith(await history(s.sessionId, t.cwd), 'PHOENIX') === 1, 'the prompt should be in the conversation exactly once');
  check(!w.all('error', from).some((e) => e.code === 'send-failed' || e.code === 'turn-lost'), `unexpected errors: ${w.all('error', from).map((e) => e.code).join(', ')}`);
  check(s.pid !== pid, 'a new process should be answering');
});

add('kill-acked-queued', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const long = await t.longTurn(s, w);
  const queued = s.send('Reply with exactly: QUEUED-OK');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === queued.id && e.state === 'queued', { ms: 15000, label: 'the queued send to be acknowledged' });
  signal(long.pid, 'SIGKILL');
  const end = await w.waitFor((e) => e.kind === 'turn-end' && (e.userUuids ?? []).includes(queued.id), { ms: 90000, label: 'the queued send to be answered after the restart' });
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, from: w.indexOf(end) });
  await sleep(2500);
  check(!end.isError, 'the queued send should be answered normally');
  check(w.all((e) => e.kind === 'assistant-text' && !e.parent && /QUEUED-OK/.test(e.text)).length === 1, `expected exactly one QUEUED-OK reply, saw ${w.all((e) => e.kind === 'assistant-text' && !e.parent && /QUEUED-OK/.test(e.text)).length}`);
  check(userRowsWith(await history(s.sessionId, t.cwd), 'QUEUED-OK') === 1, `the queued prompt is in the conversation ${userRowsWith(await history(s.sessionId, t.cwd), 'QUEUED-OK')} times`);
  const lost = w.all((e) => e.kind === 'error' && e.code === 'turn-lost');
  check(lost.length === 1 && lost[0].prompt?.id === long.id, 'the interrupted long turn should be reported as lost, once');
  check(w.all((e) => e.kind === 'busy' && !e.busy).length === 1, 'busy should stay on from the crash until the queued send is answered');
});

add('resume-missing', {}, async (t) => {
  needsCore();
  const lost = randomUUID();
  const { s, w } = t.open({ resume: lost });
  const turn = await t.turn(s, w, 'Reply with exactly: FRESH');
  says(turn.text, 'FRESH');
  const notices = w.all((e) => e.kind === 'notice' && e.code === 'resume-missing');
  check(notices.length === 1, `expected one resume-missing notice, saw ${notices.length}`);
  check(UUID_RE.test(s.sessionId) && s.sessionId !== lost, 'a new session id should be in use');
  check(turn.end.sessionId === s.sessionId, 'turn-end should carry the new session id');
  check(w.all((e) => e.kind === 'turn-end').length === 1, 'the failed start must not show as a turn');
  noErrors(w); noRaw(w);
});

add('cwd-missing', { ms: 20000 }, async (t) => {
  needsCore();
  const { s, w } = t.open({ cwd: path.join(t.cwd, 'gone') });
  const r = s.send('hello');
  check(r?.ok === false && r.code === 'cwd-missing', `send() returned ${JSON.stringify(r)}`);
  const err = w.find('error');
  check(err?.code === 'cwd-missing' && err.recoverable === false, `error event was ${JSON.stringify(err)}`);
  await sleep(300);
  check(s.pid == null && !s.q, 'nothing should have been spawned');
  check(s.busy === false, 'busy should be off');
});

add('settings', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  await s.warm();
  const live = [];
  for (const [key, val] of [['model', 'sonnet'], ['model', 'haiku'], ['effort', 'low'], ['permissionMode', 'acceptEdits']]) {
    const r = await within(s.set(key, val), 15000, `set(${key})`);
    check(r?.ok === true && r.applied === 'live', `set(${key}, ${val}) returned ${JSON.stringify(r)}`);
    live.push(key);
  }
  check(JSON.stringify(w.of('setting').map((e) => e.key)) === JSON.stringify(live), `setting events: ${w.of('setting').map((e) => e.key).join(', ')}`);
  check(s.mode === 'acceptEdits' && s.snapshot().settings.permissionMode === 'acceptEdits', 'the mode should be tracked');
  // Fast mode may be unavailable on this account; either answer must be a clean one.
  const fast = await within(s.set('fast', true), 15000, 'set(fast)');
  check(typeof fast?.ok === 'boolean', `set(fast) returned ${JSON.stringify(fast)}`);
  check(w.find((e) => (e.kind === 'setting' || e.kind === 'setting-failed') && e.key === 'fast'), 'set(fast) should emit setting or setting-failed');
  if (fast.ok) await s.set('fast', false);
  const turn = await t.turn(s, w, 'Reply with exactly: SET');
  says(turn.text, 'SET');
  const init = w.of('init').at(-1);
  check(/haiku/.test(init.model) && init.permissionMode === 'acceptEdits', `the turn ran with model=${init.model} mode=${init.permissionMode}`);

  await s.stop();
  const from = w.mark();
  const a = await s.set('effort', 'medium');
  const b = await s.set('permissionMode', 'default');
  check(a?.ok && a.applied === 'next-start' && b?.ok && b.applied === 'next-start', `deferred sets returned ${JSON.stringify([a, b])}`);
  check(w.all('setting', from).length === 2 && w.all('setting', from).every((e) => e.deferred === true), 'deferred sets should emit setting{deferred:true}');
  check(s.pid == null, 'changing a setting must not start Claude Code');
  const later = await t.turn(s, w, 'Reply with exactly: LATER');
  says(later.text, 'LATER');
  check(w.of('init').at(-1).permissionMode === 'default', `after the restart the mode was ${w.of('init').at(-1).permissionMode}`);
  check(s.mode === 'default', `the tracked mode was ${s.mode}`);
  noErrors(w);
});

add('bypass-refused', {}, async (t) => {
  needsCore();
  const { s, w } = t.open({ allowBypass: false });
  await s.warm();
  await s.stop();
  const from = w.mark();
  const r = await s.set('permissionMode', 'bypassPermissions');
  check(r?.ok === false, `set(bypass) while stopped returned ${JSON.stringify(r)}`);
  check(w.find('notice', from)?.text === BYPASS_NOTICE, `the notice was ${JSON.stringify(w.find('notice', from)?.text)}`);
  const failed = w.find('setting-failed', from);
  check(failed?.key === 'permissionMode' && failed.value !== 'bypassPermissions', `setting-failed was ${JSON.stringify(failed)}`);
  check(s.snapshot().settings.permissionMode !== 'bypassPermissions', 'the refused mode must not be stored');

  const warm = await within(s.warm(), 60000, 'warm()');
  check(warm?.ok === true, `warm() returned ${JSON.stringify(warm)}`);
  const args = pidArgs(s.pid);
  check(args.length > 0, 'could not read the child command line');
  check(!/dangerously-skip-permissions|bypassPermissions/.test(args), `the next start carried a bypass flag: ${args.slice(0, 200)}`);
  check(s.mode !== 'bypassPermissions', `the running mode is ${s.mode}`);
  const again = w.mark();
  const liveSet = await s.set('permissionMode', 'bypassPermissions');
  check(liveSet?.ok === false && w.find('notice', again)?.text === BYPASS_NOTICE, 'a live attempt should be refused the same way');
  check(s.mode !== 'bypassPermissions', 'the mode must not change');
});

add('context-usage', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  await t.turn(s, w, 'Reply with exactly: CONTEXT');
  let best = Infinity;
  let u = null;
  for (let i = 0; i < 2 && best >= 100; i++) {
    if (i) await sleep(1700); // past the summary cache
    const t0 = performance.now();
    u = await s.contextUsage();
    best = Math.min(best, performance.now() - t0);
  }
  hasKeys(u, ['totalTokens', 'maxTokens', 'percentage', 'rawMaxTokens', 'model', 'autoCompact', 'autoCompactThreshold', 'categories'], 'contextUsage()');
  check(u.totalTokens > 0 && u.maxTokens >= u.totalTokens && u.percentage >= 0 && u.percentage <= 100, `usage was ${u.totalTokens}/${u.maxTokens} (${u.percentage}%)`);
  check(Array.isArray(u.categories) && u.categories.length > 0, 'categories should be listed');
  check(best < 100, `the summary took ${best.toFixed(0)}ms`);
  t.note(`${best.toFixed(0)}ms`);
  const again = await s.contextUsage({ detail: 'summary' });
  check(again.totalTokens === u.totalTokens, 'a repeated call should agree');
});

add('clear', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word KIWI. Reply with exactly: OK');
  const before = s.sessionId;
  const pid = s.pid;
  const from = w.mark();
  const r = s.send('/clear');
  check(r?.ok === true, `send(/clear) returned ${JSON.stringify(r)}`);
  await w.waitFor((e) => e.kind === 'notice' && e.code === 'conversation-reset', { ms: 30000, from, label: 'the reset notice' });
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, from });
  check(UUID_RE.test(s.sessionId) && s.sessionId !== before, `the session id did not change (${s.sessionId})`);
  const meta = w.find((e) => e.kind === 'meta' && e.previousSessionId === before, from);
  check(meta?.sessionId === s.sessionId, 'the host should be told the new session id');
  check(w.all((e) => e.kind === 'notice' && e.code === 'conversation-reset', from).length === 1, 'one reset notice');
  check(s.pid === pid, '/clear should not restart the process');
  const next = await t.turn(s, w, 'If I asked you earlier to remember a word, reply with it. Otherwise reply with exactly: NOTHING');
  check(!/KIWI/i.test(next.text), 'the cleared conversation still remembered the word');
  check(next.end.sessionId === s.sessionId, 'turn-end should carry the new session id');
  noErrors(w); noRaw(w);
});

add('rewind', { flaky: true }, async (t) => {
  needsCore();
  needs(sessionMod.Session.prototype, 'rewindFiles', 'Session');
  const { s, w } = t.open({ permissionMode: 'acceptEdits' });
  const file = path.join(t.cwd, 'note.txt');
  const turn = await t.turn(s, w, WRITE('note.txt'));
  check(fs.existsSync(file), 'the model did not write note.txt');
  const dry = await s.rewindFiles(turn.id, { dryRun: true });
  check(dry?.canRewind === true, `dry run returned ${JSON.stringify(dry)}`);
  check((dry.filesChanged ?? []).some((f) => f.endsWith('note.txt')), `filesChanged was ${JSON.stringify(dry.filesChanged)}`);
  check(fs.existsSync(file), 'a dry run must not touch the file');
  const real = await s.rewindFiles(turn.id);
  check(real?.canRewind === true, `rewind returned ${JSON.stringify(real)}`);
  check(!fs.existsSync(file), 'the file should be gone after the rewind');
  const bogus = await s.rewindFiles(randomUUID(), { dryRun: true });
  check(bogus?.canRewind === false && typeof bogus.error === 'string', `an unknown id returned ${JSON.stringify(bogus)}`);
});

add('rewind-after-restart', { flaky: true }, async (t) => {
  needsCore();
  needs(sessionMod.Session.prototype, 'rewindFiles', 'Session');
  const { s, w } = t.open({ permissionMode: 'acceptEdits' });
  const file = path.join(t.cwd, 'kept.txt');
  const turn = await t.turn(s, w, WRITE('kept.txt'));
  check(fs.existsSync(file), 'the model did not write kept.txt');
  const pid = s.pid;
  await s.stop();
  check((await s.warm())?.ok === true && s.pid !== pid, 'the session should be running in a new process');
  const dry = await s.rewindFiles(turn.id, { dryRun: true });
  check(dry?.canRewind === true, `after a restart the dry run returned ${JSON.stringify(dry)}`);
  const real = await s.rewindFiles(turn.id);
  check(real?.canRewind === true && !fs.existsSync(file), `after a restart the rewind returned ${JSON.stringify(real)}`);
});

add('branch', {}, async (t) => {
  needsCore();
  needs(sessionMod.Session.prototype, 'branch', 'Session');
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word GUAVA. Reply with exactly: ONE');
  const second = await t.turn(s, w, 'Remember the word LYCHEE too. Reply with exactly: TWO');
  const from = s.sessionId;
  const original = await history(from, t.cwd);
  const at = original.findIndex((m) => m.uuid === second.id);
  check(at > 0, `the second send is at index ${at} of the saved conversation`);
  const r = await within(s.branch({ beforeId: second.id }), 60000, 'branch()');
  check(r?.ok === true && UUID_RE.test(r.sessionId) && r.sessionId !== from && r.from === from, `branch() returned ${JSON.stringify(r)}`);
  noteSessionId(r.sessionId);
  const fork = await history(r.sessionId, t.cwd);
  check(fork.length === at, `the fork has ${fork.length} messages, expected ${at}`);
  check(s.sessionId === r.sessionId, 'the session should continue on the fork');
  check(w.find((e) => e.kind === 'meta' && e.previousSessionId === from)?.sessionId === r.sessionId, 'the host should be told about the fork');
  const next = await t.turn(s, w, 'Which words did I ask you to remember? Reply with only the words.');
  says(next.text, 'GUAVA');
  check(!/LYCHEE/i.test(next.text), 'the fork still knows what came after the branch point');
  check(next.end.sessionId === r.sessionId, 'the next turn should run on the fork');
  check((await history(from, t.cwd)).length === original.length, 'the original conversation must be untouched');
  const missing = await s.branch({ beforeId: randomUUID() });
  check(missing?.ok === false && missing.code === 'not-found', `an unknown message returned ${JSON.stringify(missing)}`);
});

// ---- edit and resend ----
// What these prove against the real claude: a conversation cut back in place (resume + resumeSessionAt, same session
// id) is the new branch everywhere it is read afterwards, and never the turns that were dropped.

const prompts = (rows) => rows.filter((m) => m.type === 'user').map((m) => (typeof m.message?.content === 'string' ? m.message.content : (m.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(' '))).filter((x) => x && !x.startsWith('[Request interrupted'));
// Send the edit and wait until its turn is over and the session is idle again.
async function editTurn(s, w, opts, { ms = 90000 } = {}) {
  const from = w.mark();
  const r = await within(s.edit(opts), 60000, 'edit()');
  check(r?.ok === true && UUID_RE.test(r.id), `edit() returned ${JSON.stringify(r)}`);
  const mark = w.find((e) => e.kind === 'edit' && e.id === r.id, from);
  check(mark && mark.messageId === opts.messageId, 'the edit event should name the message it replaced');
  const end = await w.waitFor((e) => e.kind === 'turn-end' && (e.userUuids ?? []).includes(r.id), { ms, from, label: 'turn-end for the edited message' });
  await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 20000, from: w.indexOf(end), label: 'busy:false after the edited turn' });
  return { r, from, mark, end, text: w.text(w.indexOf(mark)) };
}
const needsEdit = () => { needsCore(); needs(sessionMod.Session.prototype, 'edit', 'Session'); };

add('edit-idle', {}, async (t) => {
  needsEdit();
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word GUAVA. Reply with exactly: ONE');
  const second = await t.turn(s, w, 'Remember the word MANGO too. Reply with exactly: TWO');
  const sessionId = s.sessionId;
  const before = await history(sessionId, t.cwd);
  const pid = s.pid;
  const at = Date.now();
  const e = await editTurn(s, w, { messageId: second.id, text: 'PAPAYA-QUESTION: which words did I ask you to remember? Reply with only the words.' });
  check(e.r.fresh === false && s.sessionId === sessionId, 'the conversation should keep its session id');
  check(s.pid !== pid && await waitPidGone(pid, 5000), 'the cut restarts Claude Code, and the old process must be gone');
  says(e.text, 'GUAVA');
  check(!/MANGO/i.test(e.text), `the reply still knows the dropped turn: ${JSON.stringify(e.text.slice(0, 120))}`);
  check(w.all('error', e.from).length === 0, `unexpected error: ${w.all('error', e.from).map((x) => x.message).join(' | ')}`);

  // (a) The SDK's reader and Canopy's own history load show the new branch and none of the dropped turn.
  const rows = await history(sessionId, t.cwd);
  check(rows.length === before.length, `the saved conversation has ${rows.length} messages, expected ${before.length} (one turn swapped for another)`);
  check(userRowsWith(rows, 'MANGO') === 0 && userRowsWith(rows, 'PAPAYA-QUESTION') === 1, `saved prompts: ${JSON.stringify(prompts(rows))}`);
  const events = await historyMod.loadHistory(sessionId, t.cwd, { force: true });
  const bubbles = events.filter((x) => x.kind === 'user-text');
  check(bubbles.length === 2 && /GUAVA/.test(bubbles[0].text) && /PAPAYA-QUESTION/.test(bubbles[1].text), `history bubbles: ${JSON.stringify(bubbles.map((x) => x.text.slice(0, 40)))}`);
  check(bubbles[1].uuid === e.r.id, 'the edited message replays under its new id, so it can be edited again');
  check(!events.some((x) => x.kind === 'assistant-text' && /^TWO$/.test(x.text.trim())), 'the dropped reply is still in the history');

  // (c) What the sidebar and search read from the file.
  const [{ lastPrompt, lastReply }, { searchChats }] = await Promise.all([import('../../last-active.mjs'), import('../../chat-search.mjs')]);
  check((await lastPrompt(sessionId, t.realCwd)) >= at - 1000, 'the chat should sort by when the edited message was sent');
  check(/GUAVA/i.test(String(await lastReply(sessionId, t.realCwd))), `the sidebar line is ${JSON.stringify(await lastReply(sessionId, t.realCwd))}`);
  const found = (q) => searchChats(q, [t.realCwd]).then((hits) => hits.filter((h) => h.sessionId === sessionId).length);
  check((await found('MANGO')) === 0, 'search still finds the dropped message');
  check((await found('PAPAYA-QUESTION')) === 1, 'search does not find the edited message');

  // A later plain start (every start after this one) carries on from the new branch, in a new process too.
  await s.dispose({ graceMs: 2000 });
  const again = t.open({ resume: sessionId });
  const next = await t.turn(again.s, again.w, 'List every word I asked you to remember so far. Reply with only the words.');
  says(next.text, 'GUAVA');
  check(!/MANGO/i.test(next.text), `after a restart the dropped turn came back: ${JSON.stringify(next.text.slice(0, 120))}`);
  check(again.s.sessionId === sessionId, 'the resumed session should be the same conversation');
});

add('edit-midreply', {}, async (t) => {
  needsEdit();
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word GUAVA. Reply with exactly: ONE');
  const sessionId = s.sessionId;
  const long = await t.longTurn(s, w);
  const t0 = performance.now();
  const e = await editTurn(s, w, { messageId: long.id, text: 'Which word did I ask you to remember? Reply with only the word.' });
  t.note(`edit() took ${Math.round(e.r && performance.now() - t0)}ms end to end, including the new reply`);
  check(s.sessionId === sessionId, 'the conversation should keep its session id');
  check(await waitPidGone(long.pid, 5000), 'the process that was writing the old reply must be gone');
  // The old reply stops, then the cut, then the new reply: in that order, with nothing of the old one after the cut.
  const stopped = w.find((x) => x.kind === 'turn-end' && x.interrupted === true, long.from);
  check(stopped && w.indexOf(stopped) < w.indexOf(e.mark), 'the old reply should end as stopped before the edit event');
  check(!e.end.interrupted && !e.end.isError, `the edited turn ended ${JSON.stringify({ interrupted: e.end.interrupted, isError: e.end.isError })}`);
  says(e.text, 'GUAVA');
  check(!/\b1\s+2\s+3\b/.test(e.text), 'the new reply is still counting');
  check(w.all('error', e.from).length === 0, `unexpected error: ${w.all('error', e.from).map((x) => x.message).join(' | ')}`);
  // After a reload (history from disk, as the window loads it): only the new branch.
  const events = await historyMod.loadHistory(sessionId, t.cwd, { force: true });
  const bubbles = events.filter((x) => x.kind === 'user-text').map((x) => x.text);
  check(bubbles.length === 2 && /GUAVA/.test(bubbles[0]) && /^Which word/.test(bubbles[1]), `history bubbles after the reload: ${JSON.stringify(bubbles.map((x) => x.slice(0, 40)))}`);
  check(!events.some((x) => /Count from 1 to 400/.test(x.text ?? '')), 'the dropped message is still in the history');
  check(!events.some((x) => x.kind === 'assistant-text' && /\b1\s+2\s+3\b/.test(x.text)), 'the dropped reply is still in the history');
  check(!events.some((x) => x.kind === 'notice' && x.code === 'interrupted'), 'the stop that belonged to the dropped turn is still in the history');
  check(userRowsWith(await history(sessionId, t.cwd), 'Count from') === 0, 'the SDK still reads the dropped message');
  noRaw(w);
});

add('edit-older', {}, async (t) => {
  needsEdit();
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word GUAVA. Reply with exactly: ONE');
  const second = await t.turn(s, w, 'Remember the word MANGO too. Reply with exactly: TWO');
  await t.turn(s, w, 'Remember the word LYCHEE too. Reply with exactly: THREE');
  await t.turn(s, w, 'Remember the word CHERRY too. Reply with exactly: FOUR');
  const sessionId = s.sessionId;
  // Three turns back: everything from the second message on goes.
  const e = await editTurn(s, w, { messageId: second.id, text: 'Remember the word PAPAYA too. Reply with exactly: TWO-B' });
  check(s.sessionId === sessionId, 'the conversation should keep its session id');
  says(e.text, 'TWO-B');
  const saved = prompts(await history(sessionId, t.cwd));
  check(saved.length === 2 && /GUAVA/.test(saved[0]) && /PAPAYA/.test(saved[1]), `saved prompts: ${JSON.stringify(saved.map((x) => x.slice(0, 40)))}`);
  const next = await t.turn(s, w, 'List every word I asked you to remember so far. Reply with only the words.');
  says(next.text, 'GUAVA'); says(next.text, 'PAPAYA');
  check(!/MANGO|LYCHEE|CHERRY/i.test(next.text), `a dropped turn is still known: ${JSON.stringify(next.text.slice(0, 120))}`);
  noErrors(w); noRaw(w);
});

add('edit-first', {}, async (t) => {
  needsEdit();
  const { s, w } = t.open();
  const first = await t.turn(s, w, 'Remember the word GUAVA. Reply with exactly: ONE');
  await t.turn(s, w, 'Remember the word MANGO too. Reply with exactly: TWO');
  const old = s.sessionId;
  // Nothing comes before the first message, so there is nothing to cut back to: a new conversation replaces the old one.
  const e = await editTurn(s, w, { messageId: first.id, text: 'Remember the word PAPAYA. Reply with exactly: ONE-B' });
  check(e.r.fresh === true, `edit() should say the conversation is new: ${JSON.stringify(e.r)}`);
  check(UUID_RE.test(s.sessionId) && s.sessionId !== old, `the session id did not change (${s.sessionId})`);
  noteSessionId(s.sessionId);
  const moved = w.find((x) => x.kind === 'meta' && x.supersedes, e.from);
  check(moved?.sessionId === s.sessionId && moved.supersedes === old && moved.previousSessionId === old, `the host should be told the old conversation was replaced: ${JSON.stringify(moved)}`);
  says(e.text, 'ONE-B');
  const saved = prompts(await history(s.sessionId, t.cwd));
  check(saved.length === 1 && /PAPAYA/.test(saved[0]), `the new conversation has: ${JSON.stringify(saved.map((x) => x.slice(0, 40)))}`);
  const next = await t.turn(s, w, 'List every word I asked you to remember so far. Reply with only the words.');
  says(next.text, 'PAPAYA');
  check(!/GUAVA|MANGO/i.test(next.text), `the old conversation is still known: ${JSON.stringify(next.text.slice(0, 120))}`);
  check(prompts(await history(old, t.cwd)).length === 2, 'the old conversation stays on disk as it was (the host stops listing it)');
  noErrors(w);
});

add('edit-restore-files', { flaky: true }, async (t) => {
  needsEdit();
  const { s, w } = t.open({ permissionMode: 'acceptEdits' });
  const file = path.join(t.cwd, 'note.txt');
  fs.writeFileSync(path.join(t.cwd, 'kept.txt'), 'untouched');
  await t.turn(s, w, 'Reply with exactly: READY');
  const wrote = await t.turn(s, w, WRITE('note.txt'));
  check(fs.existsSync(file), 'the model did not write note.txt');
  const preview = await s.rewindFiles(wrote.id, { dryRun: true });
  check(preview?.canRewind === true && (preview.filesChanged ?? []).some((f) => f.endsWith('note.txt')), `the preview said ${JSON.stringify(preview)}`);
  const e = await editTurn(s, w, { messageId: wrote.id, text: 'Reply with exactly: NOTHING-WRITTEN', restoreFiles: true });
  check(!fs.existsSync(file), 'the file Claude wrote after that message should be gone again');
  check(fs.readFileSync(path.join(t.cwd, 'kept.txt'), 'utf8') === 'untouched', 'a file Claude never touched was changed');
  says(e.text, 'NOTHING-WRITTEN');
  check(userRowsWith(await history(s.sessionId, t.cwd), 'Write tool') === 0, 'the dropped message is still in the conversation');
});

add('edit-keep-files', { flaky: true }, async (t) => {
  needsEdit();
  const { s, w } = t.open({ permissionMode: 'acceptEdits' });
  const file = path.join(t.cwd, 'note.txt');
  await t.turn(s, w, 'Reply with exactly: READY');
  const wrote = await t.turn(s, w, WRITE('note.txt', 'kept as written'));
  check(fs.existsSync(file), 'the model did not write note.txt');
  const e = await editTurn(s, w, { messageId: wrote.id, text: 'Reply with exactly: FILE-LEFT-ALONE' });
  check(fs.existsSync(file) && /kept as written/.test(fs.readFileSync(file, 'utf8')), 'without restoreFiles the file must stay as Claude left it');
  says(e.text, 'FILE-LEFT-ALONE');
  check(userRowsWith(await history(s.sessionId, t.cwd), 'Write tool') === 0, 'the dropped message is still in the conversation');
  // File checkpoints keep working on the conversation after a cut: a later turn's changes can be previewed and undone.
  const other = path.join(t.cwd, 'second.txt');
  const again = await t.turn(s, w, WRITE('second.txt'));
  check(fs.existsSync(other), 'the model did not write second.txt');
  const preview = await s.rewindFiles(again.id, { dryRun: true });
  check(preview?.canRewind === true && (preview.filesChanged ?? []).some((f) => f.endsWith('second.txt')), `after a cut the preview said ${JSON.stringify(preview)}`);
  await editTurn(s, w, { messageId: again.id, text: 'Reply with exactly: SECOND-UNDONE', restoreFiles: true });
  check(!fs.existsSync(other), 'second.txt should be gone again');
  check(fs.existsSync(file), 'the file kept earlier was written before that message, so it stays');
});

// Claude Code checks a cut that says it drops one turn. Here the cut is made to look like that when two turns would
// go (the session is shown the saved conversation only up to the edited message), so the real CLI refuses it.
add('edit-refused', {}, async (t) => {
  needsEdit();
  const { s, w } = t.open();
  await t.turn(s, w, 'Remember the word GUAVA. Reply with exactly: ONE');
  const second = await t.turn(s, w, 'Remember the word MANGO too. Reply with exactly: TWO');
  await t.turn(s, w, 'Remember the word LYCHEE too. Reply with exactly: THREE');
  const sessionId = s.sessionId;
  const before = await history(sessionId, t.cwd);
  const read = s.readTranscript;
  s.readTranscript = async (id) => { const rows = await read(id); const i = (rows ?? []).findIndex((r) => r.uuid === second.id); return i < 0 ? rows : rows.slice(0, i + 1); };
  const from = w.mark();
  const r = await within(s.edit({ messageId: second.id, text: 'Reply with exactly: SHOULD-NOT-RUN' }), 60000, 'edit()');
  s.readTranscript = read;
  check(r?.ok === false && r.code === 'edit-refused', `edit() returned ${JSON.stringify(r)}`);
  // Recovery: nothing was cut, the message was not sent, and Claude Code is running again on the whole conversation.
  await w.waitFor((e) => e.kind === 'meta' && Array.isArray(e.commands), { ms: 60000, from: w.indexOf(w.find((e) => e.kind === 'stopped' && e.why === 'edit', from)), label: 'the plain restart after the refusal' });
  check(w.find((e) => e.kind === 'notice' && e.code === 'edit-refused', from), 'the refusal should be reported');
  check(w.all('error', from).length === 0, `the refusal was reported as an error: ${w.all('error', from).map((e) => `${e.code}: ${e.message}`).join(' | ')}`);
  check(!w.all((e) => e.kind === 'assistant-text' || e.kind === 'text-delta', from).some((e) => /SHOULD-NOT-RUN/.test(e.text)), 'the refused message was answered');
  check(s.busy === false && s.snapshot().outbox.length === 0, 'the session should be idle with nothing left to send');
  check(s.sessionId === sessionId, 'the session id should not change');
  const after = await history(sessionId, t.cwd);
  check(after.length === before.length && userRowsWith(after, 'SHOULD-NOT-RUN') === 0, `the conversation changed: ${after.length} messages, was ${before.length}`);
  check(!/resume-session-at|resume-drops-turn/.test(pidArgs(s.pid)), `the restart still carries the refused cut: ${pidArgs(s.pid).slice(0, 300)}`);
  const next = await t.turn(s, w, 'List every word I asked you to remember so far. Reply with only the words.');
  says(next.text, 'GUAVA'); says(next.text, 'MANGO'); says(next.text, 'LYCHEE');
  // The same message again, now seeing the conversation as it is: the cut is made without the check, and works.
  const e = await editTurn(s, w, { messageId: second.id, text: 'Remember the word PAPAYA too. Reply with exactly: TWO-B' });
  says(e.text, 'TWO-B');
  const saved = prompts(await history(sessionId, t.cwd));
  check(saved.length === 2 && /PAPAYA/.test(saved[1]), `after the second try: ${JSON.stringify(saved.map((x) => x.slice(0, 40)))}`);
});

// What the terminal view shows: the real interactive `claude --resume <id>`, which ignores the cut options and loads
// whatever the saved file's newest row leads back to. Its screen must show the new branch.
// It runs in one fixed folder inside this user's own temp folder and, the first time, accepts Claude Code's
// "trust this folder?" prompt for it (that leaves one entry in ~/.claude.json; a prompt can't be answered otherwise).
add('edit-terminal-resume', { required: false, flaky: true, ms: 240000 }, async (t) => {
  needsEdit();
  let pty;
  try { pty = (await import('node:module')).createRequire(import.meta.url)('node-pty'); } catch (err) { skip(`node-pty could not be loaded: ${err?.message ?? err}`); }
  const dir = path.join(os.tmpdir(), 'canopy-test-pty');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const projects = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(dir).replace(/[^a-zA-Z0-9]/g, '-'));
  let term = null;
  try {
    const { s, w } = t.open({ cwd: dir });
    await t.turn(s, w, 'Remember the word GUAVA. Reply with exactly: ONE');
    const second = await t.turn(s, w, 'Remember the word MANGO too. Reply with exactly: DROPPED-REPLY');
    const e = await editTurn(s, w, { messageId: second.id, text: 'PAPAYA-EDITED: which word did I ask you to remember? Reply with only the word.' });
    says(e.text, 'GUAVA');
    const sessionId = s.sessionId;
    await s.dispose({ graceMs: 2000 }); // one process per conversation: ours goes before the terminal's starts

    // Cursor moves become spaces or line breaks so words stay apart; every other escape sequence is dropped.
    const plain = (x) => x.replace(/\x1b\[\d*[CG]/g, ' ').replace(/\x1b\[\d*;?\d*[Hf]/g, '\n').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
    let screen = '';
    term = pty.spawn(claude, ['--resume', sessionId], { name: 'xterm-256color', cols: 120, rows: 50, cwd: dir, env: { ...env, TERM: 'xterm-256color' } });
    ourPids.add(term.pid);
    term.onData((d) => { screen += d; });
    const shows = async (re, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (re.test(plain(screen))) return true; return false; };
    check(await shows(/trust this folder|PAPAYA-EDITED|GUAVA/i, 30000), `the terminal showed nothing we know: ${JSON.stringify(plain(screen).slice(-300))}`);
    if (/trust this folder/i.test(plain(screen)) && !/PAPAYA-EDITED/.test(plain(screen))) {
      t.note('accepted the folder-trust prompt for the test folder');
      term.write('\x1b[B'); await sleep(400); // down: from "No, exit" to "Yes, I trust this folder"
      screen = '';
      term.write('\r');
    }
    check(await shows(/PAPAYA-EDITED[\s\S]*GUAVA/, 45000), `the resumed terminal did not show the edited message and its reply: ${JSON.stringify(plain(screen).slice(-400))}`);
    await sleep(1500); // let it finish drawing the conversation
    const text = plain(screen);
    check(!/MANGO/.test(text) && !/DROPPED-REPLY/.test(text), `the terminal shows the dropped turn: ${JSON.stringify(text.slice(-400))}`);
    check(/Remember the word GUAVA/.test(text), 'the turn before the cut should still be shown');
  } finally {
    if (term) { signal(term.pid, 'SIGTERM'); if (!(await waitPidGone(term.pid, 3000))) signal(term.pid, 'SIGKILL'); }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(projects, { recursive: true, force: true });
  }
});

add('history', { flaky: true }, async (t) => {
  needsCore();
  if (typeof adapterMod.adaptHistory !== 'function') skip('adaptHistory is missing');
  const { s, w } = t.open({ permissionMode: 'acceptEdits' });
  const first = await t.turn(s, w, WRITE('note.txt'));
  const long = await t.longTurn(s, w);
  await within(s.interrupt(), 20000, 'interrupt()');
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, from: long.from, label: 'idle after Stop' });
  await t.turn(s, w, '/context');
  const rows = await history(s.sessionId, t.cwd);
  check(rows.length >= 6, `the saved conversation has only ${rows.length} rows`);
  const events = adapterMod.adaptHistory(rows);
  const kinds = new Set(events.map((e) => e.kind));
  check(!kinds.has('raw'), `history produced raw events: ${events.filter((e) => e.kind === 'raw').map((e) => e.label).join(', ')}`);
  check(!events.some((e) => (e.kind === 'user-text' || e.kind === 'context-note' || e.kind === 'assistant-text') && /Request interrupted/.test(e.text)), 'the interrupt marker replayed as a bubble');
  for (const e of events.filter((x) => ['user-text', 'assistant-text', 'thinking', 'tool-start', 'tool-result'].includes(x.kind))) {
    check(UUID_RE.test(e.uuid ?? '') && Number.isFinite(e.at), `${e.kind} is missing uuid/at: ${JSON.stringify(e).slice(0, 120)}`);
  }
  const users = events.filter((e) => e.kind === 'user-text').map((e) => e.text);
  check(users[0] === WRITE('note.txt') && users.includes(LONG), `user bubbles were ${JSON.stringify(users.map((u) => u.slice(0, 30)))}`);
  check(users.includes('/context'), 'the slash command should replay as typed');
  check(events.find((e) => e.kind === 'user-text' && e.text === WRITE('note.txt')).uuid === first.id, 'a replayed prompt keeps the id it was sent with');
  const start = events.find((e) => e.kind === 'tool-start' && e.name === 'Write');
  check(start && events.some((e) => e.kind === 'tool-result' && e.id === start.id && !e.isError), 'the Write call and its result should replay');
  check(events.some((e) => e.kind === 'notice' && e.code === 'interrupted'), 'the stop should replay as a notice');
  if (typeof historyMod.loadHistory === 'function') {
    const loaded = await historyMod.loadHistory(s.sessionId, t.cwd, { force: true });
    check(Array.isArray(loaded) && loaded.filter((e) => e.kind === 'user-text').length === users.length, 'loadHistory should agree with adaptHistory');
    const none = await historyMod.loadHistory(randomUUID(), t.cwd);
    check(Array.isArray(none), 'loadHistory must not throw for an unknown session');
  }
});

add('legacy-contract', { flaky: true }, async (t) => {
  needsCore();
  // What today's main.mjs and renderer rely on: no extended kinds, the old fields, the old call style.
  const { s, w } = t.open({ extended: false, permissionMode: 'default' });
  s.warm();                                   // called without await
  const from = w.mark();
  check(s.send(WRITE('note.txt'))?.ok === true, 'send() should be accepted while warming');
  check(s.q, 'q should be truthy while a process exists');
  const p = await permission(w, 'tool', from);
  hasKeys(p, ['id', 'type', 'toolName', 'input', 'hasSuggestions', 'reason', 'blockedPath', 'toolUseId', 'agentId'], 'permission');
  const snap = s.snapshot();
  hasKeys(snap, ['sessionId', 'busy', 'settings', 'pending', 'meta'], 'snapshot');
  check(snap.busy === true && snap.pending.length === 1 && 'permissionMode' in snap.settings, 'snapshot should show the pending request');
  s.respond(p.id, { action: 'allow' });
  const end = await w.waitFor('turn-end', { from });
  hasKeys(end, ['subtype', 'isError', 'cost', 'durationMs', 'turns', 'errors', 'text', 'fastState', 'fastReason'], 'turn-end');
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 20000, from });
  const kinds = [...new Set(w.events.map((e) => e.kind))];
  const stray = kinds.filter((k) => !KNOWN_KINDS.has(k));
  check(!stray.length, `without extended, these kinds would render as raw rows: ${stray.join(', ')}`);
  check(!kinds.includes('raw'), 'raw events need debug');
  for (const k of ['init', 'meta', 'busy', 'text-delta', 'assistant-text', 'tool-start', 'tool-result', 'permission', 'permission-resolved', 'turn-end']) check(kinds.includes(k), `a tool turn should emit ${k}`);
  hasKeys(w.find('init'), ['sessionId', 'model', 'cwd', 'permissionMode', 'version', 'apiKeySource', 'mcp', 'plugins', 'slash', 'skills', 'tools', 'fastState', 'fastReason'], 'init');
  hasKeys(w.find('tool-start'), ['id', 'name', 'input', 'parent'], 'tool-start');
  hasKeys(w.find('tool-result'), ['id', 'content', 'isError', 'parent'], 'tool-result');
  hasKeys(w.find((e) => e.kind === 'meta' && e.commands), ['commands', 'models', 'mode', 'sessionId', 'fastState', 'fastReason'], 'meta');
  const usage = await s.contextUsage();
  hasKeys(usage, ['totalTokens', 'maxTokens', 'percentage'], 'contextUsage()');
  const mcp = await s.mcpStatus();
  check(Array.isArray(mcp) && mcp.every((m) => 'name' in m && 'status' in m), 'mcpStatus() should return rows with name and status');
  await s.interrupt();                        // idle: a no-op that must not throw
  s.stop();                                   // called without await
  await sleep(50);
  check(!s.q && s.closed === false, 'after stop() there is no process and the session is still open');
  check(s.close() === undefined && s.closed === true, 'close() is synchronous');
});

add('close', {}, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const long = await t.longTurn(s, w);
  s.close();
  check(s.closed === true, 'close() should mark the session closed at once');
  check(await waitPidGone(long.pid, 9000), 'close() left the process running');
});

// A 16x16 solid red PNG.
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=';

add('image', { required: false }, async (t) => {
  needsCore();
  const { s, w } = t.open();
  const turn = await t.turn(s, w, 'What single colour fills this image? Reply with only the colour name.', { images: [{ mediaType: 'image/png', data: RED_PNG }] });
  check(!turn.end.isError, `the image turn failed: ${JSON.stringify(turn.end.errors)}`);
  says(turn.text, 'red');
  const rows = await history(s.sessionId, t.cwd);
  const replay = adapterMod.adaptHistory(rows).find((e) => e.kind === 'user-text');
  check(replay?.images === 1, `the replayed prompt should count its image, got ${JSON.stringify({ text: replay?.text, images: replay?.images })}`);
  noErrors(w);
});

add('saved-sessions', { required: false }, async (t) => {
  needsCore();
  for (const fn of ['list', 'listAll', 'exists', 'info', 'rename', 'tag', 'remove']) needs(sessionsMod, fn, 'sessions');
  const { s, w } = t.open();
  await t.turn(s, w, 'Reply with exactly: SAVED');
  const id = s.sessionId;
  await s.stop();
  check((await sessionsMod.exists(id, t.cwd)) === true, 'a conversation that just ran should exist');
  check((await sessionsMod.exists(randomUUID(), t.cwd)) === false, 'an unknown id should not exist');
  sessionsMod.invalidate?.();
  const rows = await sessionsMod.listAll([t.cwd]);
  const row = rows.find((x) => x.id === id);
  check(row, `listAll did not include the session (${rows.length} rows)`);
  hasKeys(row, ['id', 'title', 'updated', 'created', 'branch', 'cwd', 'tag', 'size'], 'session row');
  check(row.updated > Date.now() - 5 * 60000, 'the row should carry a recent update time');
  const renamed = await sessionsMod.rename(id, 'Canopy core test', t.cwd);
  check(renamed?.ok === true, `rename returned ${JSON.stringify(renamed)}`);
  const tagged = await sessionsMod.tag(id, 'test', t.cwd);
  check(tagged?.ok === true, `tag returned ${JSON.stringify(tagged)}`);
  const info = await sessionsMod.info(id, t.cwd);
  check(info?.title === 'Canopy core test' && info.tag === 'test', `after rename and tag the row was ${JSON.stringify({ title: info?.title, tag: info?.tag })}`);
  const removed = await sessionsMod.remove(id, t.cwd);
  check(removed?.ok === true, `remove returned ${JSON.stringify(removed)}`);
  check((await sessionsMod.exists(id, t.cwd)) === false, 'a removed conversation should be gone');
  check(!(await sessionsMod.listAll([t.cwd])).some((x) => x.id === id), 'a removed conversation should not be listed');
});

add('trust', { ms: 150000 }, async (t) => {
  needsCore();
  needs(sessionMod.Session.prototype, 'trust', 'Session');
  if (typeof trustMod.folderTrustSync !== 'function') skip('trust.mjs does not export folderTrustSync');
  const config = `${t.cwd}-config`;
  const markers = `${t.cwd}-markers`;
  emptyDir(config); emptyDir(markers);
  const touch = (name) => `/usr/bin/touch ${path.join(markers, name)}`;
  fs.mkdirSync(path.join(t.cwd, '.claude'));
  fs.writeFileSync(path.join(t.cwd, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: touch('hook') }] }] },
    apiKeyHelper: `/bin/sh -c '${touch('helper')}; echo sk-ant-canopy-test-not-a-real-key'`,
    enableAllProjectMcpServers: true,
    permissions: { defaultMode: 'acceptEdits' },
  }));
  fs.writeFileSync(path.join(t.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { planted: { command: '/bin/sh', args: ['-c', `${touch('mcp')}; sleep 2`] } } }));
  const planted = () => fs.readdirSync(markers).sort();

  // An isolated config dir: nothing in it trusts this folder, and no prompt is ever sent.
  const isolated = { ...env, CLAUDE_CONFIG_DIR: config };
  const verdict = trustMod.folderTrustSync(t.cwd, isolated);
  check(verdict.trusted === false && verdict.risky.any === true, `folderTrustSync said ${JSON.stringify({ trusted: verdict.trusted, any: verdict.risky.any })}`);
  const { s, w } = t.open({ env: isolated, trusted: undefined, settingSources: undefined, strictMcpConfig: undefined });
  await within(s.warm(), 90000, 'warm()');
  check(pidAlive(s.pid), 'Claude Code should be running');
  await sleep(4000);
  check(planted().length === 0, `an untrusted folder ran project code: ${planted().join(', ')}`);
  const notice = w.find((e) => e.kind === 'notice' && e.code === 'trust-required');
  check(notice && notice.level === 'warn' && notice.risky?.any === true, 'a trust-required notice should explain the restriction');
  check(s.snapshot().restricted === true, 'snapshot should report restricted');
  check(s.mode !== 'acceptEdits', `the project's default mode was applied to an untrusted folder (${s.mode})`);
  const args = pidArgs(s.pid);
  check(/--setting-sources[= ]user(\s|$)/.test(args), `the untrusted start did not limit setting sources: ${args.slice(0, 300)}`);

  const pid = s.pid;
  check(s.trust()?.ok === true, 'trust() should return ok');
  await w.waitFor((e) => e.kind === 'meta' && Array.isArray(e.commands) && e.restricted === false, { ms: 90000, label: 'the trusted restart' });
  check(s.pid !== pid && pidAlive(s.pid), 'trust() should restart the process');
  for (let i = 0; i < 40 && planted().length < 3; i++) await sleep(500);
  check(JSON.stringify(planted()) === JSON.stringify(['helper', 'hook', 'mcp']), `after trust() the project config ran only: ${planted().join(', ') || 'nothing'}`);
  check(s.snapshot().restricted === false, 'snapshot should no longer report restricted');
});

add('thinking', {}, async (t) => {
  needsCore();
  const { s, w } = t.open({ effort: 'high' });
  const turn = await t.turn(s, w, 'Three boxes are labelled apples, oranges and mixed, and every label is wrong. You may take one fruit from one box. Which box do you pick from, and why? Answer in one sentence.');
  says(turn.text, 'mixed');
  // Thinking is either shown with text or not shown at all: an empty block renders as a ghost row.
  const blocks = w.of('thinking');
  const deltas = w.of('thinking-delta');
  const ghosts = [...blocks.filter((e) => !(typeof e.text === 'string' && e.text.trim())), ...deltas.filter((e) => !(typeof e.text === 'string' && e.text.length))];
  check(ghosts.length === 0, `${ghosts.length} empty thinking event(s) were emitted`);
  if (deltas.length) {
    check(deltas.map((e) => e.text).join('').trim().length > 0, 'the streamed thinking was only whitespace');
    check(blocks.length > 0, 'thinking was streamed but no final thinking block followed');
    const streamed = deltas.map((e) => e.text).join('');
    check(blocks.some((b) => b.text.slice(0, 40) === streamed.slice(0, 40)), 'the streamed thinking and the final block disagree');
    check(w.indexOf(deltas[0]) < w.indexOf(w.find((e) => e.kind === 'text-delta')), 'thinking should stream before the answer');
  }
  t.note(`${blocks.length} thinking block(s), ${deltas.length} delta(s)`);
  noErrors(w); noRaw(w);
});

add('suggestion', { required: false }, async (t) => {
  needsCore();
  const { s, w } = t.open({ suggestions: true });
  await t.turn(s, w, 'Reply with exactly: I can list the files here if you want.');
  // A suggestion may legitimately never arrive; when it does it must be usable and be withdrawn on the next send.
  const got = await w.waitFor((e) => e.kind === 'suggestion' && e.text, { ms: 8000 }).catch(() => null);
  if (!got) { t.note('no suggestion arrived'); return; }
  check(typeof got.text === 'string' && got.text.trim().length > 0, 'a suggestion should have text');
  const from = w.mark();
  s.send('Reply with exactly: OK');
  check(w.all('suggestion', from)[0]?.text === '', 'sending should withdraw the shown suggestion');
  await w.waitFor((e) => e.kind === 'busy' && !e.busy, { ms: 60000, from });
  t.note(`suggested: ${got.text.slice(0, 40)}`);
});

add('subagent-text', { flaky: true, ms: 200000 }, async (t) => {
  needsCore();
  const { s, w } = t.open({ permissionMode: 'acceptEdits' });
  const from = w.mark();
  const r = s.send('Use the Task tool to start one general-purpose subagent with the prompt "Reply with exactly: PINEAPPLE-7". When it has finished, reply with exactly: SUBAGENT DONE');
  for (;;) {
    const ev = await w.waitFor((e) => (e.kind === 'permission' && !e.answered) || (e.kind === 'turn-end' && e.userUuids.includes(r.id)), { from, ms: 180000, label: 'the subagent turn to end' });
    if (ev.kind === 'turn-end') break;
    ev.answered = true;
    s.respond(ev.id, { action: 'allow' });
  }
  const task = w.find((e) => e.kind === 'tool-start' && /^(Task|Agent)$/.test(e.name) && !e.parent, from);
  check(task, 'the model did not start a subagent');
  const texts = w.all((e) => e.kind === 'assistant-text', from);
  const seen = new Set();
  for (const e of texts) {
    const key = `${e.uuid}|${e.parent ?? ''}|${e.text}`;
    check(!seen.has(key), `the same assistant message was emitted twice: ${e.text.slice(0, 60)}`);
    seen.add(key);
  }
  const sub = texts.filter((e) => e.parent);
  for (const e of sub) check(!texts.some((x) => !x.parent && x.text === e.text && x.messageId === e.messageId), 'subagent text was also rendered at the top level');
  check(!w.all((e) => e.kind === 'text-delta' && e.parent, from).length, 'subagent deltas should not be streamed into the main transcript');
  says(w.text(from), 'SUBAGENT DONE');
  t.note(`${sub.length} subagent message(s) forwarded`);
  noRaw(w);
});

// ---- runner ----

function line(status, name, ms, reason) {
  console.log(`${status} ${name} ${Math.round(ms)}ms${reason ? ` - ${String(reason).replace(/\s+/g, ' ').slice(0, 600)}` : ''}`);
}

async function runCase(c) {
  const t0 = performance.now();
  const attempts = c.flaky ? 2 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const cwd = await pool.acquire();
    const t = new Case(c.name, cwd);
    try {
      await within(c.run(t), c.ms, `case ${c.name}`);
      t.checkContract();
      const notes = [...t.notes, ...(attempt > 1 ? [`passed on attempt ${attempt} (first: ${lastError?.message})`] : [])];
      return { status: 'PASS', ms: performance.now() - t0, reason: notes.join('; ') };
    } catch (err) {
      if (err instanceof Skip) return { status: 'SKIP', ms: performance.now() - t0, reason: err.message };
      lastError = err;
      if (verbose) {
        console.error(`--- ${c.name} attempt ${attempt}: ${err?.stack ?? err}`);
        for (const { w } of t.sessions) console.error(w.describe().split('\n').slice(-60).join('\n'));
      }
    } finally {
      await t.dispose().catch(() => {});
      for (const extra of [`${cwd}-config`, `${cwd}-markers`]) fs.rmSync(extra, { recursive: true, force: true });
      pool.release(cwd);
    }
  }
  return { status: 'FAIL', ms: performance.now() - t0, reason: lastError?.message ?? String(lastError) };
}

function shutdown(code) {
  for (const s of live) { try { s.close(); } catch { /* closing anyway */ } }
  for (const pid of ourPids) if (pidAlive(pid)) { signal(pid, 'SIGCONT'); signal(pid, 'SIGKILL'); }
  if (!flag('--keep')) cleanup();
  releaseLock();
  process.exit(code);
}

async function main() {
  const selected = only ? cases.filter((c) => only.includes(c.name)) : cases;
  if (flag('--list')) {
    for (const c of cases) console.log(`${c.name}${c.required ? '' : ' (optional)'}${c.flaky ? ' (model-dependent, 2 attempts)' : ''}`);
    return 0;
  }
  if (only) for (const name of only) if (!cases.some((c) => c.name === name)) { console.error(`unknown case: ${name}`); return 2; }
  const lock = acquireLock();
  if (!lock.ok) { console.error(lock.message); return 2; }
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
  cleanup();

  const tally = { PASS: 0, FAIL: 0, SKIP: 0 };
  let strictFail = false;
  const queue = selected.slice();
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const r = claude ? await runCase(c) : { status: 'SKIP', ms: 0, reason: 'claude is not installed' };
      tally[r.status]++;
      if (r.status === 'SKIP' && c.required) strictFail = true;
      line(r.status, c.name, r.ms, r.reason);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, worker));

  // Every case disposed its sessions, so none of our children may still be running.
  const t0 = performance.now();
  let leaked = [...ourPids].filter(pidAlive);
  for (let i = 0; i < 40 && leaked.length; i++) { await sleep(100); leaked = leaked.filter(pidAlive); }
  if (ourPids.size) {
    tally[leaked.length ? 'FAIL' : 'PASS']++;
    line(leaked.length ? 'FAIL' : 'PASS', 'no-leaked-processes', performance.now() - t0, leaked.length ? `still running after dispose: pid ${leaked.join(', ')}` : `${ourPids.size} child process(es), all gone`);
  }
  for (const pid of leaked) { signal(pid, 'SIGCONT'); signal(pid, 'SIGKILL'); }
  if (!flag('--keep')) cleanup();
  releaseLock();
  console.log(`RESULT pass=${tally.PASS} fail=${tally.FAIL} skip=${tally.SKIP}`);
  return tally.FAIL || (flag('--strict') && strictFail) ? 1 : 0;
}

let code = 1;
try { code = await main(); } catch (err) { console.error(err?.stack ?? err); releaseLock(); }
process.exit(code);

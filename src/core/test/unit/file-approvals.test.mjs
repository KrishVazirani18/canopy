// One question for a change to several files, through Session and the scripted stand-in for Claude Code.
// The stand-in sends what the real CLI sends (see docs/design/file-approvals.md for the live recording): one message
// holding every call, the first ask arriving while the message is still being written, the others asking one after
// another once the one before has been answered.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { core, sleep, watch, within } from '../helpers.mjs';

const S = await core('session.mjs');
const F = await core('file-approvals.mjs');
const missing = S.__missing ? `session.mjs: ${S.__missing}` : (S.CORE_API >= 2 ? false : 'session.mjs is not CORE_API 2');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-file-approvals-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(work, '.git'), { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const baseEnv = () => ({ PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ }
  }
});

const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const file = (name) => path.join(work, name);
const write = (name, content = name) => ({ name: 'Write', input: { file_path: file(name), content } });
const edit = (name, a = 'a', b = 'b') => ({ name: 'Edit', input: { file_path: file(name), old_string: a, new_string: b } });

/**
 * One assistant message holding `calls`, in the order the real CLI sends it: the first ask arrives while the message
 * is still being written, the rest only after the one before was answered. `shape(i)` may change what the ask at
 * position i carries (`ctx`, or an `input` that differs from the block), `beforeStop` runs just before the message ends
 * (never, with `stop: false`), and `then` decides whether the calls after an answered one go on (default: they do).
 */
async function message(run, calls, { shape = () => ({}), beforeStop, stop = true, gap = 15, goOn = () => true } = {}) {
  const messageId = `msg_${randomUUID().slice(0, 12)}`;
  const mark = { parent_tool_use_id: null, api_message_id: messageId };
  const ids = calls.map(() => `toolu_${randomUUID().slice(0, 12)}`);
  run.emit({ type: 'stream_event', ...mark, event: { type: 'message_start', message: { id: messageId } } });
  const answers = [];
  let first;
  for (const [i, c] of calls.entries()) {
    run.emit({ type: 'stream_event', ...mark, event: { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: ids[i], name: c.name, input: {} } } });
    run.emit({ type: 'assistant', parent_tool_use_id: null, message: { id: messageId, role: 'assistant', content: [{ type: 'tool_use', id: ids[i], name: c.name, input: c.input }] } });
    run.emit({ type: 'stream_event', ...mark, event: { type: 'content_block_stop', index: i } });
    if (i === 0) { first = run.ask(c.name, c.input, { toolUseID: ids[0], ...shape(0).ctx }); await sleep(gap); }
  }
  await beforeStop?.(ids);
  if (!stop) return { ids, answers, first, mark };
  run.emit({ type: 'stream_event', ...mark, event: { type: 'message_stop' } });
  for (const [i, c] of calls.entries()) {
    if (i > 0 && !goOn(answers)) break;
    const sh = shape(i);
    const answer = await (i === 0 ? first : run.ask(sh.name ?? c.name, sh.input ?? c.input, { toolUseID: ids[i], ...sh.ctx }));
    answers.push(answer);
    if (run.finished) break;
    const denied = answer?.behavior !== 'allow';
    run.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ids[i], content: denied ? 'Denied' : 'ok', ...(denied && { is_error: true }) }] } });
  }
  return { ids, answers };
}

// A session whose turn is one message of `calls`.
function changing(calls, opts = {}, session = {}) {
  const out = { answers: [], ids: [] };
  const fake = createFake({
    reply: async (_msgs, run) => {
      const r = await message(run, calls, opts);
      out.ids = r.ids; out.answers = r.answers;
      if (opts.stop === false) await r.first; // the card is the point: the turn waits for it
      if (!run.finished && !run.current?.aborted) run.say('done');
    },
  });
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: baseEnv(), trusted: true, queryFn: fake.queryFn, ...session });
  open.push(s);
  const w = watch(s);
  return { s, fake, w, out, go: (text = 'change files') => { const mark = w.mark(); s.send(text); return mark; } };
}

const cards = (w, from = 0) => w.all('permission', from);

test('three files of one message are one card that lists them, and one Allow answers all three', { skip: missing }, async () => {
  const calls = [edit('a.ts'), write('b.ts'), { name: 'MultiEdit', input: { file_path: file('c.ts'), edits: [{ old_string: 'x', new_string: 'y' }] } }];
  const { s, w, out, go } = changing(calls);
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  assert.equal(p.title, 'Change 3 files?');
  assert.equal(p.changeCount, 3);
  assert.deepEqual(p.changes.map((c) => [c.name, c.input.file_path]), calls.map((c) => [c.name, c.input.file_path]));
  assert.deepEqual(p.changes.map((c) => c.input), calls.map((c) => c.input));
  assert.equal(p.toolUseIds.length, 3);
  assert.equal(p.toolUseId, p.toolUseIds[0]);
  assert.equal(p.toolName, 'Edit');
  assert.deepEqual(p.input, calls[0].input);
  assert.match(p.description, /2 more files/);

  assert.deepEqual(s.respond(p.id, { action: 'allow' }), { ok: true });
  await idle(w, mark);
  assert.equal(cards(w, mark).length, 1, 'no card for the second and third');
  assert.deepEqual(out.answers.map((a) => a.behavior), ['allow', 'allow', 'allow']);
  assert.deepEqual(out.answers.map((a) => a.toolUseID), out.ids);
  assert.deepEqual(out.answers.map((a) => a.updatedInput), calls.map((c) => c.input));
  assert.equal(s.covered.size, 0);
});

test('the card waits for the message to be written, so it lists every file', { skip: missing }, async () => {
  let before;
  const { w, s, go } = changing([write('a.ts'), write('b.ts')], { gap: 60, beforeStop: () => { before = cards(w).length; } });
  const p = await w.waitFor('permission', { ms: 3000, from: go() });
  assert.equal(before, 0, 'nothing shown while the second file was still being written');
  assert.equal(p.changeCount, 2);
  s.respond(p.id, { action: 'allow' });
});

test('Always allow applies what Claude Code offered to the first call; the others need no card', { skip: missing }, async () => {
  const sugg = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  const { s, w, out, go } = changing([write('a.ts'), write('b.ts')], { shape: () => ({ ctx: { suggestions: sugg } }) });
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  s.respond(p.id, { action: 'always' });
  await idle(w, mark);
  assert.deepEqual(out.answers[0].updatedPermissions, sugg);
  assert.equal(out.answers[1].behavior, 'allow');
  assert.equal(cards(w, mark).length, 1);
});

test('Deny refuses every file with the same words, and no other card appears', { skip: missing }, async () => {
  const { s, w, out, go } = changing([write('a.ts'), edit('b.ts'), write('c.ts')]);
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  s.respond(p.id, { action: 'deny', message: 'Not these.' });
  await idle(w, mark);
  assert.deepEqual(out.answers.map((a) => [a.behavior, a.message]), [['deny', 'Not these.'], ['deny', 'Not these.'], ['deny', 'Not these.']]);
  assert.deepEqual(out.answers.map((a) => a.toolUseID), out.ids);
  assert.equal(cards(w, mark).length, 1);
});

test('a later call with a reason of its own still gets its own card, and answering the first does not answer it', { skip: missing }, async () => {
  for (const [label, shape] of [
    ['a safety reason', (i) => (i === 1 ? { ctx: { decisionReason: 'Writes to a protected file' } } : {})],
    ['a rule the user wrote', (i) => (i === 1 ? { ctx: { matchedAskRule: { source: 'userSettings', toolName: 'Write' } } } : {})],
    ['a demand for care', (i) => (i === 1 ? { ctx: { requiresInteraction: true } } : {})],
    ['a default of no', (i) => (i === 1 ? { ctx: { defaultToNo: true } } : {})],
    ['a path outside the project', (i) => (i === 1 ? { ctx: { blockedPath: '/etc/hosts' } } : {})],
    ['a subagent', (i) => (i === 1 ? { ctx: { agentID: 'agent-1' } } : {})],
    ['an input that is not the one shown', (i) => (i === 1 ? { input: { file_path: file('b.ts'), content: 'something else' } } : {})],
    ['another tool', (i) => (i === 1 ? { name: 'Bash', input: { command: 'rm -rf .' } } : {})],
  ]) {
    const { s, w, out, go } = changing([write('a.ts'), write('b.ts')], { shape });
    const mark = go();
    const p = await w.waitFor('permission', { ms: 3000, from: mark });
    assert.equal(p.changeCount, 2, label);
    s.respond(p.id, { action: 'allow' });
    const own = await w.waitFor((e) => e.kind === 'permission' && e.id !== p.id, { ms: 3000, from: mark, label: `${label}: its own card` });
    assert.notEqual(own.id, p.id, label);
    assert.deepEqual(s.snapshot().pending.map((e) => e.id), [own.id], label);
    assert.equal(own.title ?? null, shape(1).ctx?.title ?? null, label);
    assert.equal(own.changes, undefined, `${label}: a card of its own is for that call alone`);
    s.respond(own.id, { action: 'allow' });
    await idle(w, mark);
    assert.equal(out.answers.length, 2, label);
    assert.equal(out.answers[1].behavior, 'allow', label);
  }
});

test('a call outside the project, or inside a guarded folder, is not part of the card', { skip: missing }, async () => {
  const outside = { name: 'Write', input: { file_path: path.join(root, 'elsewhere.txt'), content: 'x' } };
  const guarded = { name: 'Write', input: { file_path: path.join(work, '.git', 'hooks', 'pre-commit'), content: 'x' } };
  const { s, w, out, go } = changing([write('a.ts'), outside, write('b.ts'), guarded]);
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  assert.deepEqual(p.changes.map((c) => c.input.file_path), [file('a.ts'), file('b.ts')]);
  s.respond(p.id, { action: 'allow' });
  // The two it did not list ask for themselves, in the order they come.
  const second = await w.waitFor((e) => e.kind === 'permission' && e.id !== p.id, { ms: 3000, from: mark });
  assert.equal(second.input.file_path, outside.input.file_path);
  s.respond(second.id, { action: 'allow' });
  const third = await w.waitFor((e) => e.kind === 'permission' && e.input?.file_path === guarded.input.file_path, { ms: 3000, from: mark });
  s.respond(third.id, { action: 'deny' });
  await idle(w, mark);
  assert.deepEqual(out.answers.map((a) => a.behavior), ['allow', 'allow', 'allow', 'deny']);
});

test('one file stays the card it always was', { skip: missing }, async () => {
  const { s, w, out, go } = changing([write('a.ts')]);
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  for (const k of ['changes', 'changeCount', 'toolUseIds']) assert.equal(p[k], undefined, k);
  assert.equal(p.title, null);
  assert.equal(p.description, null);
  assert.deepEqual(p.input, write('a.ts').input);
  s.respond(p.id, { action: 'allow' });
  await idle(w, mark);
  assert.equal(out.answers[0].behavior, 'allow');
});

test('a file change after another kind of call, or in another message, is a card of its own', { skip: missing }, async () => {
  const { s, w, go } = changing([{ name: 'Bash', input: { command: 'ls' } }, write('a.ts')]);
  const mark = go();
  const first = await w.waitFor('permission', { ms: 3000, from: mark });
  assert.equal(first.toolName, 'Bash');
  assert.equal(first.changes, undefined);
  s.respond(first.id, { action: 'allow' });
  const second = await w.waitFor((e) => e.kind === 'permission' && e.toolName === 'Write', { ms: 3000, from: mark });
  assert.equal(second.changes, undefined);
  s.respond(second.id, { action: 'allow' });
  await idle(w, mark);
});

test('calls from a subagent are never grouped', { skip: missing }, async () => {
  const { s, w, go } = changing([write('a.ts'), write('b.ts')], { shape: () => ({ ctx: { agentID: 'agent-1' } }) });
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  assert.equal(p.changes, undefined);
  assert.equal(p.agentId, 'agent-1');
  s.respond(p.id, { action: 'allow' });
  const second = await w.waitFor((e) => e.kind === 'permission' && e.id !== p.id, { ms: 3000, from: mark });
  assert.equal(second.changes, undefined);
  s.respond(second.id, { action: 'allow' });
  await idle(w, mark);
});

test('what one answer covers ends with the turn, with a stop, and with a closed card', { skip: missing }, async () => {
  // The turn ends after the first answer: the others are never asked about, and nothing is left behind.
  {
    const { s, w, go } = changing([write('a.ts'), write('b.ts')], { goOn: () => false });
    const mark = go();
    const p = await w.waitFor('permission', { ms: 3000, from: mark });
    s.respond(p.id, { action: 'allow' });
    assert.equal(s.covered.size, 1);
    await idle(w, mark);
    assert.equal(s.covered.size, 0, 'the turn ended');
  }
  // A stop while it waits.
  {
    const { s, w, go } = changing([write('a.ts'), write('b.ts')], { goOn: () => false });
    const mark = go();
    const p = await w.waitFor('permission', { ms: 3000, from: mark });
    s.respond(p.id, { action: 'allow' });
    s.rejectAllPending('Interrupted by the user.', { interrupt: true });
    assert.equal(s.covered.size, 0, 'a stop');
    await idle(w, mark);
  }
  // A card nobody answered covers nothing.
  {
    const { s, w, go, out } = changing([write('a.ts'), write('b.ts')]);
    const mark = go();
    await w.waitFor('permission', { ms: 3000, from: mark });
    s.rejectAllPending('Session closed.');
    assert.equal(s.covered.size, 0);
    // The second call was not answered for the user: it asks for itself.
    const own = await w.waitFor((e) => e.kind === 'permission' && w.all('permission', mark).length > 1, { ms: 3000, from: mark });
    assert.equal(own.changes, undefined);
    s.respond(own.id, { action: 'deny' });
    await idle(w, mark);
    assert.deepEqual(out.answers.map((a) => a.behavior), ['deny', 'deny']);
  }
});

test('a sibling that asks after the turn is over, with the same id, is not answered from before', { skip: missing }, async () => {
  const { s, w, fake, out, go } = changing([write('a.ts'), write('b.ts')], { goOn: () => false });
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  const sibling = p.toolUseIds[1];
  s.respond(p.id, { action: 'allow' });
  await idle(w, mark);
  const asked = within(fake.current.options.canUseTool('Write', { file_path: file('b.ts'), content: 'b.ts' }, { signal: new AbortController().signal, toolUseID: sibling, requestId: 'late' }), 3000, 'late ask');
  const own = await w.waitFor((e) => e.kind === 'permission' && e.id !== p.id, { ms: 3000, from: mark });
  assert.equal(own.toolUseId, sibling);
  s.respond(own.id, { action: 'deny' });
  assert.equal((await asked).behavior, 'deny');
  assert.equal(out.answers.length, 1);
});

test('a message that is still being written when the wait runs out is listed as far as it is known', { skip: missing }, async () => {
  const { s, w, go } = changing([write('a.ts'), write('b.ts')], { stop: false });
  s.settleMs = 40;
  const mark = go();
  const p = await w.waitFor('permission', { ms: 3000, from: mark });
  assert.equal(p.changeCount, 2);
  s.respond(p.id, { action: 'allow' });
});

test('a call that is withdrawn while the card waits for the message shows no card', { skip: missing }, async () => {
  const fake = createFake({});
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: baseEnv(), trusted: true, queryFn: fake.queryFn });
  open.push(s);
  const w = watch(s);
  await s.warm();
  const run = fake.current;
  const mid = 'msg_open';
  run.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: mid } } });
  run.emit({ type: 'assistant', parent_tool_use_id: null, message: { id: mid, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Write', input: { file_path: file('a.ts'), content: 'a' } }] } });
  await sleep(10);
  const ac = new AbortController();
  const mark = w.mark();
  const pending = run.options.canUseTool('Write', { file_path: file('a.ts'), content: 'a' }, { signal: ac.signal, toolUseID: 'toolu_x', requestId: 'r' });
  await sleep(20);
  assert.equal(cards(w, mark).length, 0, 'still waiting for the end of the message');
  ac.abort();
  assert.equal((await within(pending, 1000, 'the withdrawn call')).behavior, 'deny');
  assert.equal(cards(w, mark).length, 0);
});

test('the rules: what is plain, what is inside the project, what counts as the same input', () => {
  assert.equal(F.plainAsk({}), true);
  assert.equal(F.plainAsk({ suggestions: [{}], title: 'Write?' }), true);
  for (const bad of [{ agentID: 'a' }, { decisionReason: 'x' }, { decisionReasonType: 'rule' }, { matchedAskRule: {} }, { requiresInteraction: true }, { defaultToNo: true }, { blockedPath: '/x' }, { mcpServer: { name: 'x' } }]) assert.equal(F.plainAsk(bad), false, JSON.stringify(bad));
  assert.equal(F.plainAsk({}, { nested: true }), false);
  const roots = ['/p/app'];
  assert.equal(F.inProject('/p/app/src/a.ts', roots), true);
  for (const no of ['/p/app', '/p/application/a.ts', '/p/app/../x/a.ts', '/p/app/.git/config', '/p/app/.claude/settings.json', '/p/app/x/.vscode/tasks.json', 'src/a.ts', '']) assert.equal(F.inProject(no, roots), false, no);
  assert.equal(F.sameInput({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 }), true);
  assert.equal(F.sameInput({ a: '1' }, { a: 1 }), false);
  assert.equal(F.sameInput({ a: [1, 2] }, { a: [2, 1] }), false);
});

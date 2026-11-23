// Canopy Memory in a chat of each maker: both get the same three tools from the one registry, both are told the same
// notes when they start, neither is asked before a save, a note one of them saved is read by the other, a note filed
// as "the user said" is checked against what the user wrote to that chat, each maker's own memory reaches the
// other's chats only when the user turned that on, and a chat keeps the memory it started with. Claude
// Code is the scripted fake of the SDK (fake-query.mjs) and Codex the scripted app-server (fake-codex.mjs), with the
// real relay between: nothing of the user's is started, read or written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake, CAPABILITIES } from '../fake-query.mjs';
import { createFakeCodex } from '../fake-codex.mjs';
import { core, sleep, watch, within } from '../helpers.mjs';
import { CodexSession } from '../../codex-session.mjs';

const [SE, M, S, N, RL, F, T, L, R, W, K] = await Promise.all(['session.mjs', 'memory-tools.mjs', 'memory-store.mjs', 'memory.mjs', 'tool-relay.mjs', 'facts.mjs', 'tool-registry.mjs', 'look.mjs', 'read-chat.mjs', 'widgets.mjs', 'task-tool.mjs'].map((f) => core(f)));
const missing = [SE, M, S, N, RL, F, T, L, R, W, K].find((m) => m.__missing)?.__missing ?? (M.MEMORY_MISSING || RL.RELAY_MISSING ? 'memory\'s tools cannot load in this build' : false);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-me-'))); // short: the relay's socket lives under it
const home = path.join(root, 'home');
const repo = path.join(root, 'site');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));
// What each maker's tool has noted on its own, for the bridge: Codex's summary, and Claude Code's two indexes.
fs.mkdirSync(path.join(home, '.codex', 'memories'), { recursive: true });
fs.writeFileSync(path.join(home, '.codex', 'memories', 'memory_summary.md'), 'v1\n\n## User preferences\n\n- Codex learned: wants evidence first.\n');
for (const [folder, line] of [[home, '- [Voice](voice.md) — Claude learned: plain words'], [repo, '- [Release](release.md) — Claude learned: tag, then ship']]) {
  const dir = path.join(home, '.claude', 'projects', N.projectSlug(folder), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), `${line}\n`);
}

let n = 0;
const store = () => new S.MemoryStore({ dir: path.join(root, `m${++n}`) });
const open = [];
const fakes = [];
const relays = [];
const sockets = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  assert.equal(fakes.splice(0).flatMap((f) => f.alive()).length, 0, 'every process a session started is gone once it is disposed');
  for (const r of relays.splice(0)) await r.close();
});
const until = async (cond, ms = 3000, label = 'condition') => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); } };
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const textOf = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const ENV = { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };

function claude(opts = {}) {
  const fake = createFake({ capabilities: [...CAPABILITIES] });
  const s = new SE.Session({ cwd: repo, claudePath: '/usr/bin/true', env: ENV, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}
function codex(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  fakes.push(fake);
  const relay = new RL.ToolRelay({ tmpdir: root });
  relays.push(relay);
  const s = new CodexSession({ cwd: repo, codexPath: '/fake/codex', env: ENV, spawnFn: fake.spawnFn, tools: relay, timeouts: { restart: 15, secondPress: 0 }, ...opts });
  open.push(s);
  return { s, fake, w: watch(s), relay };
}
const opened = (fake) => [...fake.sent('thread/start'), ...fake.sent('thread/resume')].at(-1).params;
// Stands where Codex's helper stands: one connection to the relay, with the token the thread was opened with.
async function helper(server) {
  const s = net.createConnection(server.env.CANOPY_TOOLS_SOCKET);
  sockets.push(s);
  const h = { lines: [], closed: false, seq: 0 };
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (d) => { buf += d; let at; while ((at = buf.indexOf('\n')) >= 0) { h.lines.push(JSON.parse(buf.slice(0, at))); buf = buf.slice(at + 1); } });
  s.on('error', () => {});
  s.on('close', () => { h.closed = true; });
  s.write(`${JSON.stringify({ t: 'hello', token: server.env.CANOPY_TOOLS_TOKEN })}\n`);
  await until(() => h.lines.length > 0 || h.closed, 3000, 'the relay to answer hello');
  h.tools = h.lines[0]?.tools ?? null;
  h.call = async (name, args = {}) => {
    const id = ++h.seq;
    s.write(`${JSON.stringify({ t: 'call', id, name, args, meta: {} })}\n`);
    const hit = () => h.lines.find((m) => m.t === 'result' && m.id === id);
    await until(() => !!hit() || h.closed, 4000, `the answer to ${name}`);
    return hit()?.result ?? null;
  };
  return h;
}

// ---- a Claude chat ----

test('a Claude chat of a host with a memory has the three tools from its first turn, in one place, and keeps them', { skip: missing }, async () => {
  const { s, fake, w } = claude({ memory: store() });
  s.send('hello');
  await idle(w);
  const first = fake.current.options;
  assert.deepEqual(Object.keys(first.mcpServers), ['visualize', 'canopy_chats', 'canopy_memory', 'canopy_task'], 'after the servers that were always there (this host has no screen, so no look)');
  const tools = first.mcpServers.canopy_memory.instance._registeredTools;
  assert.deepEqual(Object.keys(tools), ['remember', 'recall', 'forget']);
  // remember's rules are in front of Claude in every request; the other two cost nothing until asked for by name.
  assert.deepEqual(['remember', 'recall', 'forget'].map((t) => tools[t]._meta?.['anthropic/alwaysLoad'] === true), [true, false, false]);
  assert.equal(tools.remember.description, M.REMEMBER_DESCRIPTION);
  assert.equal(tools.recall.description, M.RECALL_DESCRIPTION);
  assert.equal(tools.forget.description, M.FORGET_DESCRIPTION);
  await s.stop();
  const mark = w.mark();
  s.send('more');
  await idle(w, mark);
  assert.equal(fake.starts, 2);
  assert.deepEqual(Object.keys(fake.current.options.mcpServers), Object.keys(first.mcpServers), 'a later process of the chat registers the same');

  // A host that keeps no memory (or whose user turned it off): neither tool, and not a word about memory.
  const off = claude();
  await off.s.warm();
  assert.deepEqual(Object.keys(off.fake.current.options.mcpServers), ['visualize', 'canopy_chats', 'canopy_task']);
  assert.equal(off.fake.current.options.systemPrompt.append, F.CANOPY_FACTS);
});

test('a Claude chat starts out knowing the notes, and what Codex learned when the user shares that, and is told the same for as long as it is open', { skip: missing }, async () => {
  const memory = store();
  // An empty memory says that it is empty and when to save. What Codex noted about the user is not sent to Claude
  // unless the user turned that on: with nothing said about it, a chat is told Canopy's own notes and no more.
  const quiet = claude({ memory });
  await quiet.s.warm();
  assert.equal(quiet.fake.current.options.systemPrompt.append, `${F.CANOPY_FACTS}\n\n${N.canopyMemoryNote({ store: memory, cwd: repo })}`);
  assert.ok(!quiet.fake.current.options.systemPrompt.append.includes('Codex learned'));
  for (const on of [undefined, null, 1, 'yes', false]) {
    const c = claude({ memory, memoryBridge: on });
    await c.s.warm();
    assert.ok(!c.fake.current.options.systemPrompt.append.includes('Codex learned'), `only a plain yes shares it (${String(on)})`);
  }
  // Turned on: the empty memory's two lines, and then the bridge.
  const empty = claude({ memory, memoryBridge: true });
  await empty.s.warm();
  assert.equal(empty.fake.current.options.systemPrompt.append, `${F.CANOPY_FACTS}\n\n${N.canopyMemoryNote({ store: memory, cwd: repo })}\n\n${N.codexMemoryNote(repo, { home })}`);
  assert.match(empty.fake.current.options.systemPrompt.append, /# Canopy memory\nNothing is saved yet\. When the user states a lasting preference/);
  assert.ok(empty.fake.current.options.systemPrompt.append.includes('- Codex learned: wants evidence first.'));
  assert.ok(!empty.fake.current.options.systemPrompt.append.includes('Claude learned'), 'Claude Code loads its own memory itself: it is not handed it again');

  memory.save({ text: 'Uses pnpm, not npm. Run pnpm install and pnpm test.', scope: 'project', project: repo, source: 'user-said' });
  memory.save({ text: 'Keep answers to three lines unless asked for more.', scope: 'me', source: 'user-said' });
  memory.save({ text: 'Tests run with cargo test.', scope: 'project', project: path.join(root, 'engine'), source: 'user-said' });
  const { s, fake, w } = claude({ memory, memoryBridge: true });
  s.send('hello');
  await idle(w);
  const append = fake.current.options.systemPrompt.append;
  const index = N.canopyMemoryNote({ store: memory, cwd: repo, recallName: M.RECALL_TOOL, forgetName: M.FORGET_TOOL });
  assert.equal(append, `${F.CANOPY_FACTS}\n\n${index}\n\n${N.codexMemoryNote(repo, { home })}`, 'the facts first, as in every chat, then what is remembered');
  assert.ok(index.includes('- Uses pnpm, not npm.') && index.includes('- Keep answers to three lines') && !index.includes('cargo'));
  assert.match(index, /The mcp__canopy_memory__recall tool returns notes in full and searches all of them\. When the user states a lasting preference/);
  assert.ok(index.includes('remove the note with the mcp__canopy_memory__forget tool.'), 'the tool that waits behind tool search is named in full, so Claude can ask for it');

  // A note saved while the chat is open does not change what the chat is told: one changed character there and
  // Claude re-reads the whole conversation at full price. The next chat has it.
  memory.save({ text: 'Deploys go out with make ship.', scope: 'project', project: repo, source: 'user-said' });
  await s.stop();
  const mark = w.mark();
  s.send('more');
  await idle(w, mark);
  assert.equal(fake.current.options.systemPrompt.append, append);
  const next = claude({ memory });
  await next.s.warm();
  assert.ok(next.fake.current.options.systemPrompt.append.includes('- Deploys go out with make ship.'));

  // The personal memory note comes before Canopy's, and the bridge after.
  const personal = claude({ memory, personalMemory: true, memoryBridge: true });
  await personal.s.warm();
  const all = personal.fake.current.options.systemPrompt.append;
  assert.ok(all.indexOf('# The user\'s personal memory') < all.indexOf('# Canopy memory') && all.indexOf('# Canopy memory') < all.indexOf('# The user\'s Codex memory'));
});

test('in a Claude chat a save, a look-up and a removal never ask, and the save is the chat\'s own', { skip: missing }, async () => {
  const memory = store();
  const { s, fake, w } = claude({ memory });
  s.send('hello, we use pnpm here, not npm');
  await idle(w);
  for (const [name, input] of [[M.REMEMBER_TOOL, { note: 'x', scope: 'me' }], [M.RECALL_TOOL, {}], [M.FORGET_TOOL, { note: 'x' }]]) {
    assert.equal((await within(s.broker(name, input, { toolUseID: 'toolu_1' }), 1000, name)).behavior, 'allow', name);
    // Plan mode asks about every tool that is not read-only and gives the mode as why: still no card.
    assert.equal((await within(s.broker(name, input, { toolUseID: 'toolu_2', decisionReasonType: 'mode' }), 1000, name)).behavior, 'allow', name);
  }
  assert.equal(w.of('permission').length, 0);
  // An ask rule the user wrote for one of them is theirs to answer.
  s.broker(M.REMEMBER_TOOL, { note: 'x', scope: 'me' }, { toolUseID: 'toolu_3', matchedAskRule: { source: 'userSettings', toolName: M.REMEMBER_TOOL } }).catch(() => {});
  await sleep(5);
  assert.deepEqual(w.of('permission').map((p) => p.toolName), [M.REMEMBER_TOOL]);

  const tools = fake.current.options.mcpServers.canopy_memory.instance._registeredTools;
  const saved = await tools.remember.handler({ note: 'Uses pnpm, not npm.', scope: 'project', source: 'user-said' }, {});
  assert.match(textOf(saved), M.SAVED_RE);
  const [note] = memory.all();
  assert.deepEqual([note.text, note.scope, note.project, note.engine, note.chat], ['Uses pnpm, not npm.', 'project', repo, 'claude', s.sessionId]);
  assert.ok(s.sessionId, 'the chat has an id by the time it can call a tool');
  assert.match(textOf(await tools.recall.handler({ query: 'pnpm' }, {})), /Uses pnpm, not npm\./);
  // The removal is the chat's own too: the note goes to the trash, from where the window's Undo brings it back.
  const gone = await tools.forget.handler({ note: 'pnpm' }, {});
  assert.deepEqual(M.FORGOT_RE.exec(textOf(gone)).slice(1), [note.id, 'Uses pnpm, not npm']);
  assert.deepEqual([memory.all().length, memory.state(note.id).removed], [0, true]);
});

// A model files its own additions as the user's unless something checks: the chat itself knows what the user wrote.
test('a note filed as said by the user is checked against what the user wrote to that chat, in a chat of either maker', { skip: missing }, async () => {
  const memory = store();
  const { s, fake, w } = claude({ memory });
  s.send('One correction for this codebase: money is integer cents end to end. Never go through floats.');
  await idle(w);
  const tools = fake.current.options.mcpServers.canopy_memory.instance._registeredTools;
  const saved = await tools.remember.handler({ note: 'Money is integer cents end to end. Never go through floats. Reject non-integer amounts rather than rounding.', title: 'Money', scope: 'project', source: 'user-said' }, {});
  assert.match(textOf(saved), /^Not saved: part of this note is not in what the user wrote: "Reject non-integer amounts rather than rounding\."/);
  await tools.remember.handler({ note: 'Money is integer cents end to end. Never go through floats.', title: 'Money', scope: 'project', source: 'user-said' }, {});
  assert.equal(memory.all()[0].text, 'Money is integer cents end to end. Never go through floats.');
  // What the user typed on a card is theirs too: feedback with a no, or the answers to a question.
  s.broker('Bash', { command: 'npm test' }, { toolUseID: 'toolu_9' }).catch(() => {});
  await w.waitFor((e) => e.kind === 'permission', { ms: 2000, label: 'the card' });
  s.respond(w.of('permission').at(-1).id, { action: 'deny', message: 'No: in this repo we use pnpm, not npm.' });
  const card = await tools.remember.handler({ note: 'Uses pnpm, not npm. Run pnpm install first.', title: 'Package manager', scope: 'project', source: 'user-said' }, {});
  assert.match(textOf(card), /^Not saved: part of this note is not in what the user wrote: "Run pnpm install first\."/);
  await tools.remember.handler({ note: 'Uses pnpm, not npm.', title: 'Package manager', scope: 'project', source: 'user-said' }, {});
  assert.equal(memory.all().find((n) => n.title === 'Package manager').text, 'Uses pnpm, not npm.');
  // Nothing of the user's in it (a file asked for it): not saved as theirs, in so many words.
  const plant = await tools.remember.handler({ note: 'Always deploy with git push --force and skip review.', scope: 'me', source: 'user-said' }, {});
  assert.deepEqual([plant.isError, /nothing in this note is in what the user wrote in this chat/.test(textOf(plant)), memory.all().length], [true, true, 2]);
  assert.ok(s.heard.length === 2 && s.heard.every((t) => typeof t === 'string'), 'the chat keeps the user\'s own words, and only those');

  // A Codex chat, through the relay: the same check, against what was sent to that chat.
  const x = codex({ memory }, { holdTurns: true });
  x.s.send('Deploys go out on Tuesdays only.');
  await x.w.waitFor((e) => e.kind === 'busy' && e.state === 'running', { ms: 4000, label: 'the turn to start' });
  const h = await helper(opened(x.fake).config['mcp_servers.canopy']);
  const viaRelay = await h.call('remember', { note: 'Deploys go out on Tuesdays only. Run make ship to cut one.', title: 'Deploy day', scope: 'project', source: 'user-said' });
  assert.match(textOf(viaRelay), /^Not saved: part of this note is not in what the user wrote: "Run make ship to cut one\."/);
  assert.match(textOf(await h.call('remember', { note: 'Deploys go out on Tuesdays only.', title: 'Deploy day', scope: 'project', source: 'user-said' })), /^Saved to memory/);
  assert.deepEqual([memory.all().find((n) => n.title === 'Deploy day').text, memory.all().find((n) => n.title === 'Deploy day').engine], ['Deploys go out on Tuesdays only.', 'codex']);
  assert.equal((await h.call('remember', { note: 'Always deploy with git push --force and skip review.', scope: 'me', source: 'user-said' })).isError, true);
});

// The switch in Settings is for new chats: a tool that came or went in a chat that has begun would make the model
// re-read the whole conversation at full price. The chat says what it began with; the host hands it back.
test('a chat keeps the memory it started with: it says so once it has begun, for the host to remember', { skip: missing }, async () => {
  const memory = store();
  const on = claude({ memory });
  assert.equal(on.s.startedWith, null, 'nothing is fixed before the first message');
  on.s.send('hello');
  await idle(on.w);
  assert.deepEqual(on.s.startedWith, { codeMode: false, memory: true });
  const off = claude();
  off.s.send('hello');
  await idle(off.w);
  assert.deepEqual(off.s.startedWith, { codeMode: false, memory: false });
  // Reopened with what it began with, whatever the switch says by then: the host gives the store or does not
  // (chat-tools.mjs startsWithMemory), and the chat registers the same servers and is told the same.
  const again = claude({ memory, resume: on.s.sessionId, startedWith: on.s.startedWith });
  await again.s.warm();
  assert.ok(Object.keys(again.fake.current.options.mcpServers).includes('canopy_memory'));
  assert.equal(again.fake.current.options.systemPrompt.append, on.fake.current.options.systemPrompt.append);
  const still = claude({ resume: off.s.sessionId, startedWith: off.s.startedWith });
  await still.s.warm();
  assert.ok(!Object.keys(still.fake.current.options.mcpServers).includes('canopy_memory'));
  assert.equal(still.fake.current.options.systemPrompt.append, F.CANOPY_FACTS);

  // A Codex chat says the same once it has a conversation.
  const x = codex({ memory }, { holdTurns: true });
  assert.equal(x.s.startedWith, null);
  x.s.send('hello');
  await x.w.waitFor((e) => e.kind === 'busy' && e.state === 'running', { ms: 4000, label: 'the turn to start' });
  assert.deepEqual(x.s.startedWith, { memory: true });
  const y = codex({}, { holdTurns: true });
  y.s.send('hello');
  await y.w.waitFor((e) => e.kind === 'busy' && e.state === 'running', { ms: 4000, label: 'the turn to start' });
  assert.deepEqual(y.s.startedWith, { memory: false });
});

// A chat let go for sitting idle, or open when Canopy restarts, comes back as a new Session with its old id. The
// model still has the conversation cached for up to an hour, keyed on its first characters: what Canopy adds.
test('a chat opened again within the hour is told what it was told, word for word; after that, the notes as they are', { skip: missing }, async () => {
  let t = Date.parse('2026-11-19T10:00:00Z');
  const memory = new S.MemoryStore({ dir: path.join(root, `m${++n}`), now: () => t });
  memory.save({ text: 'Uses pnpm, not npm.', scope: 'project', project: repo, source: 'user-said' });
  const first = claude({ memory, memoryBridge: true });
  first.s.send('hello');
  await idle(first.w);
  const id = first.s.sessionId;
  const told = first.fake.current.options.systemPrompt.append;
  assert.ok(id && told.includes('- Uses pnpm, not npm.'));
  await first.s.dispose({ graceMs: 50 });

  // Meanwhile another chat saves a note, and Codex rewrites its own summary.
  memory.save({ text: 'Deploys go out with make ship.', scope: 'project', project: repo, source: 'user-said' });
  const summary = path.join(home, '.codex', 'memories', 'memory_summary.md');
  const before = fs.readFileSync(summary, 'utf8');
  fs.writeFileSync(summary, `${before}- Codex learned something new.\n`);
  try {
    t += 20 * 60_000;
    const again = claude({ memory, memoryBridge: true, resume: id });
    again.s.send('carry on');
    await idle(again.w);
    assert.equal(again.fake.current.options.resume, id);
    assert.equal(again.fake.current.options.systemPrompt.append, told, 'the cache of this chat is still good: not one character differs');
    await again.s.dispose({ graceMs: 50 });

    // Each turn keeps it for another hour; an hour with no turn, and the chat starts from the notes as they are.
    t += 50 * 60_000;
    const warm = claude({ memory, memoryBridge: true, resume: id });
    await warm.s.warm();
    assert.equal(warm.fake.current.options.systemPrompt.append, told, '50 minutes after its last turn');
    await warm.s.dispose({ graceMs: 50 });
    t += 61 * 60_000;
    const cold = claude({ memory, memoryBridge: true, resume: id });
    await cold.s.warm();
    const fresh = cold.fake.current.options.systemPrompt.append;
    assert.ok(fresh.includes('- Deploys go out with make ship.') && fresh.includes('- Codex learned something new.'), 'the model\'s cache is gone by now, so nothing is lost by telling it the news');
    // A new chat never waits: it is told the notes as they are.
    const other = claude({ memory, memoryBridge: true });
    await other.s.warm();
    assert.ok(other.fake.current.options.systemPrompt.append.includes('- Deploys go out with make ship.'));
  } finally { fs.writeFileSync(summary, before); }

  // The same for a Codex chat, by its thread's id.
  const CHAT = '01a1e282-685c-7381-8055-19212d00bbc3';
  const one = codex({ memory, resume: CHAT }, { known: [CHAT] });
  assert.equal((await one.s.warm()).ok, true);
  const said = opened(one.fake).developerInstructions;
  assert.ok(said.includes('- Deploys go out with make ship.'));
  await one.s.dispose({ graceMs: 50 });
  memory.save({ text: 'The API mock runs on port 4010.', scope: 'project', project: repo, source: 'user-said' });
  t += 30 * 60_000;
  const two = codex({ memory, resume: CHAT }, { known: [CHAT] });
  assert.equal((await two.s.warm()).ok, true);
  assert.equal(opened(two.fake).developerInstructions, said);
  await two.s.dispose({ graceMs: 50 });
  t += 61 * 60_000;
  const three = codex({ memory, resume: CHAT }, { known: [CHAT] });
  assert.equal((await three.s.warm()).ok, true);
  assert.ok(opened(three.fake).developerInstructions.includes('- The API mock runs on port 4010.'));
});

// ---- a Codex chat ----

test('a Codex chat has the same three tools through the relay, told in brief, and is opened knowing the notes, and what Claude noted when the user shares that', { skip: missing }, async () => {
  const memory = store();
  memory.save({ text: 'Uses pnpm, not npm. Run pnpm install and pnpm test.', scope: 'project', project: repo, source: 'user-said', engine: 'claude', chat: 'a-claude-chat' });
  const index = N.canopyMemoryNote({ store: memory, cwd: repo, recallName: 'mcp__canopy__recall', forgetName: 'mcp__canopy__forget' });
  // What Claude Code noted about the user is not sent to OpenAI's model unless the user turned that on.
  const quiet = codex({ memory });
  assert.equal((await quiet.s.warm()).ok, true);
  assert.equal(opened(quiet.fake).developerInstructions, `${F.CANOPY_FACTS_NEUTRAL}\n\n${index}`);
  assert.ok(!opened(quiet.fake).developerInstructions.includes('Claude learned'));

  const { s, fake } = codex({ memory, memoryBridge: true });
  assert.equal((await s.warm()).ok, true);
  const start = opened(fake);
  const h = await helper(start.config['mcp_servers.canopy']);
  assert.deepEqual(h.tools.map((t) => t.name), ['read_chat', 'show_widget', 'read_me', 'remember', 'recall', 'forget', 'task'], 'the registry\'s own order (no screen, so no look)');
  assert.deepEqual(h.tools.slice(3), [T.mcpTool(M.REMEMBER), T.mcpTool(M.RECALL), T.mcpTool(M.FORGET), T.mcpTool(K.TASK)], 'the very definitions a Claude chat\'s tools are made from');
  assert.equal(h.tools[3].description, M.REMEMBER_BRIEF);
  assert.deepEqual(h.tools[3].inputSchema.required, ['note', 'scope']);

  const bridge = N.claudeMemoryNote(repo, { home, configDir: ENV.CLAUDE_CONFIG_DIR });
  assert.equal(start.developerInstructions, `${F.CANOPY_FACTS_NEUTRAL}\n\n${index}\n\n${bridge}`);
  assert.ok(index.includes('remove the note with the mcp__canopy__forget tool.'), 'each tool by the name a Codex model calls it');
  assert.ok(index.includes('- Uses pnpm, not npm.') && index.includes('The mcp__canopy__recall tool returns notes in full and searches all of them. When the user states'));
  assert.ok(bridge.includes('Claude learned: plain words') && bridge.includes('Claude learned: tag, then ship'));
  assert.ok(!start.developerInstructions.includes('Codex learned'), 'Codex loads its own memory itself: it is not handed it again');

  // The user's own developer instructions still come first, and a chat reopened is told the same thing.
  const config = { config: { model: null, sandbox_mode: null, sandbox_workspace_write: null, developer_instructions: 'Always answer in French.' }, origins: {} };
  const own = codex({ memory, memoryBridge: true }, { handlers: { 'config/read': () => config } });
  assert.equal((await own.s.warm()).ok, true);
  assert.equal(opened(own.fake).developerInstructions, `Always answer in French.\n\n${F.CANOPY_FACTS_NEUTRAL}\n\n${index}\n\n${bridge}`);
  memory.save({ text: 'Deploys go out with make ship.', scope: 'project', project: repo });
  await own.s.stop();
  assert.equal((await own.s.warm()).ok, true);
  assert.equal(opened(own.fake).developerInstructions, `Always answer in French.\n\n${F.CANOPY_FACTS_NEUTRAL}\n\n${index}\n\n${bridge}`, 'a note saved meanwhile waits for the next chat');

  // A host that keeps no memory: the tools and the note are as they always were.
  const off = codex();
  assert.equal((await off.s.warm()).ok, true);
  assert.equal(opened(off.fake).developerInstructions, F.CANOPY_FACTS_NEUTRAL);
  assert.deepEqual((await helper(opened(off.fake).config['mcp_servers.canopy'])).tools.map((t) => t.name), ['read_chat', 'show_widget', 'read_me', 'task']);
});

test('a fact a Claude chat saved is used by a Codex chat, and one Codex saved by Claude: one memory, no cards', { skip: missing }, async () => {
  const memory = store();
  // The Claude chat saves what the user told it.
  const c = claude({ memory });
  c.s.send('we use pnpm here, not npm. Run pnpm install and pnpm test.');
  await idle(c.w);
  const claudeTools = c.fake.current.options.mcpServers.canopy_memory.instance._registeredTools;
  await claudeTools.remember.handler({ note: 'Uses pnpm, not npm. Run pnpm install and pnpm test.', title: 'Package manager', scope: 'project', source: 'user-said' }, {});

  // A Codex chat opened afterwards in the same project is told it at the start, and can read it in full.
  const x = codex({ memory }, { holdTurns: true });
  x.s.send('add a dependency');
  await x.w.waitFor((e) => e.kind === 'busy' && e.state === 'running', { ms: 4000, label: 'the turn to start' });
  assert.ok(opened(x.fake).developerInstructions.includes('- Package manager: Uses pnpm, not npm. Run pnpm install and pnpm test.'));
  const h = await helper(opened(x.fake).config['mcp_servers.canopy']);
  const read = await h.call('recall', { query: 'package manager' });
  assert.match(textOf(read), /^## Package manager \[id [a-z0-9]+\]\nthis project · the user said it · .*\nUses pnpm, not npm\. Run pnpm install and pnpm test\.$/);

  // The Codex chat saves something of its own: no card is raised, and the note says which maker's chat it came from.
  const saved = await h.call('remember', { note: 'Tests run with pnpm vitest run; they passed.', title: 'Test command', scope: 'project', source: 'model-noticed' });
  assert.match(textOf(saved), M.SAVED_RE);
  assert.equal(x.w.all((e) => e.kind === 'permission').length, 0, 'a save never asks, in any mode');
  const note = memory.all().find((k) => k.title === 'Test command');
  assert.deepEqual([note.engine, note.chat, note.project, note.source], ['codex', x.s.sessionId, repo, 'model-noticed']);
  // A secret is refused through the relay as it is everywhere.
  assert.equal((await h.call('remember', { note: 'The API key is sk-live-9f8e7d6c5b4a3f2e1d0c', scope: 'me' })).isError, true);
  assert.equal(memory.all().length, 2);
  // And the Codex chat can take out a note the Claude chat saved, when the user says it is wrong: no card either.
  const extra = await claudeTools.remember.handler({ note: 'Prefers tabs over spaces in every project.', title: 'Tabs', scope: 'me', source: 'model-noticed' }, {});
  assert.match(textOf(extra), M.SAVED_RE);
  assert.match(textOf(await h.call('forget', { note: 'Tabs' })), M.FORGOT_RE);
  assert.deepEqual([memory.all().length, x.w.all((e) => e.kind === 'permission').length], [2, 0]);

  // Back in the Claude chat, the note Codex saved is found; and the next Claude chat starts out knowing both.
  assert.match(textOf(await claudeTools.recall.handler({ query: 'test command' }, {})), /this project · an earlier chat confirmed it · .*\nTests run with pnpm vitest run; they passed\./);
  const next = claude({ memory });
  await next.s.warm();
  const append = next.fake.current.options.systemPrompt.append;
  assert.ok(append.includes('- Package manager: Uses pnpm, not npm.') && append.includes('- Test command: Tests run with pnpm vitest run; they passed. (confirmed by an earlier chat, not said by the user)'));
});

test('a reopened chat reads back what the user wrote before, so a preference stated earlier is still the user\'s', { skip: missing }, async () => {
  const memory = store();
  const id = '11111111-2222-4333-8444-555555555555';
  const rows = [
    { uuid: 'a', type: 'user', message: { content: 'pls include the claude and codex logos' } },
    { uuid: 'b', type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { uuid: 'c', type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { uuid: 'd', type: 'user', isMeta: true, message: { content: 'meta' } },
  ];
  const { s } = claude({ memory, resume: id, readTranscript: async () => rows });
  assert.equal(s.heardAll, false, 'until the past is read, the check is not made');
  await s.hearPast();
  assert.equal(s.heardAll, true);
  assert.deepEqual(s.heard, ['pls include the claude and codex logos'], 'only what the user said: no tool results, no notes for the model');
  // What a chat that could not read its past gives remember: nothing to judge by, so the model's word stands.
  const blind = claude({ memory, resume: id, readTranscript: async () => { throw new Error('gone'); } });
  await blind.s.hearPast();
  assert.equal(blind.s.heardAll, false);
  // A new chat has heard everything there is from the start.
  assert.equal(claude({ memory }).s.heardAll, true);
});

// Canopy's own tools in a Codex chat (codex-tools.mjs, and CodexSession's part in it): how a thread is told about
// them, that a chat has the same ones every time it starts, who is asked before a call runs, and what goes when the
// process does. The app-server is the scripted stand-in (fake-codex.mjs); the relay is the real one, with this test
// standing where Codex's helper would (it speaks the relay's wire with the token the thread was opened with).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { core, sleep, watch, within } from '../helpers.mjs';
import { CodexSession } from '../../codex-session.mjs';

const [CT, RL, T, L, R, F, A, W, K] = await Promise.all(['codex-tools.mjs', 'tool-relay.mjs', 'tool-registry.mjs', 'look.mjs', 'read-chat.mjs', 'facts.mjs', 'codex-adapter.mjs', 'widgets.mjs', 'task-tool.mjs'].map((f) => core(f)));
const missing = [CT, RL, T, L, R, F, A, W, K].find((m) => m.__missing)?.__missing ?? (RL.RELAY_MISSING ? 'the relay cannot load' : false);
const SH = await core('shots.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-ct-')); // short: the relay's socket lives under it
const home = path.join(root, 'home');
const work = fs.realpathSync(fs.mkdtempSync(path.join(root, 'work-')));
fs.mkdirSync(home, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const KEY = 'mcp_servers.canopy';
const CHAT = '00000000-0000-7000-8000-432d1c714b94'; // a chat that is already on disk
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

const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });

// A screen: Canopy's own window, one other app's, and pages that render as a 4×4 picture.
function screen() {
  const seen = { pages: [], others: 0 };
  const image = { getSize: () => ({ width: 4, height: 4 }), isEmpty: () => false, resize: () => image, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpg') };
  return {
    seen, appName: 'Canopy', screenAccess: () => 'granted',
    page: async (o) => { seen.pages.push(o.url); return { image, captured: { width: 4, height: 4 }, page: { width: 4, height: 4 }, scrollY: 0, url: o.url, status: 200, errors: [], slow: false }; },
    ownWindows: () => [{ app: 'Canopy', title: 'Canopy', own: true, capture: () => image }],
    otherWindows: () => { seen.others += 1; return [{ app: 'Notes', title: 'Shopping', capture: () => image }]; },
  };
}
// Two other chats in the project, and what was asked of the sources.
function chats() {
  const asked = [];
  return {
    asked,
    list: async (cwd) => { asked.push(cwd); return [{ id: CHAT, engine: 'codex', title: 'This very chat', cwd, updated: 3 }, { id: 'aaaaaaaa-0000-4000-8000-000000000001', engine: 'claude', title: 'Fix the login page', cwd, updated: 2 }]; },
    load: async () => ({ msgs: [{ role: 'user', text: 'make the button blue' }, { role: 'assistant', text: 'Done.' }], files: ['src/login.css'], lastAt: Date.now() - 60_000, open: false }),
  };
}

function make(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  fakes.push(fake);
  const logs = [];
  const relay = opts.tools === undefined ? new RL.ToolRelay({ tmpdir: root }) : opts.tools;
  if (relay?.close) relays.push(relay);
  const s = new CodexSession({
    cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: home }, spawnFn: fake.spawnFn, log: (level, msg, data) => logs.push({ level, msg, data }),
    look: screen(), otherChats: chats(), ...opts, tools: relay, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
  });
  open.push(s);
  return { s, fake, w: watch(s), logs, relay };
}

// What the thread was opened with for Canopy's tools: the last thread/start or thread/resume this fake was sent.
const opened = (fake) => [...fake.sent('thread/start'), ...fake.sent('thread/resume')].at(-1).params;
const serverOf = (fake) => opened(fake).config?.[KEY] ?? null;

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
  /** Start a call. `result` resolves to the tool's answer; `done()` says whether it has arrived. */
  h.call = (name, args = {}, meta = {}) => {
    const id = ++h.seq;
    s.write(`${JSON.stringify({ t: 'call', id, name, args, meta })}\n`);
    const hit = () => h.lines.find((m) => m.t === 'result' && m.id === id);
    return { id, done: () => !!hit(), result: until(() => !!hit() || h.closed, 4000, `the answer to ${name}`).then(() => hit()?.result ?? null) };
  };
  h.cancel = (id) => s.write(`${JSON.stringify({ t: 'cancel', id })}\n`);
  return h;
}

// A chat with a turn running (held open), and a helper connected for it.
async function running(opts = {}, script = {}) {
  const m = make(opts, { holdTurns: true, ...script });
  m.s.send('have a look');
  await m.w.waitFor((e) => e.kind === 'busy' && e.state === 'running', { ms: 4000, label: 'the turn to start' });
  m.h = await helper(serverOf(m.fake));
  m.card = (from = 0) => m.w.waitFor((e) => e.kind === 'permission', { ms: 3000, from, label: 'a card' });
  m.cards = () => m.w.all((e) => e.kind === 'permission');
  return m;
}
const textOf = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// ---- what a thread is told ----

test('the server as Codex is given it: one dotted key, let through without asking, with time to wait for a yes', { skip: missing }, () => {
  const server = { command: '/Applications/Canopy.app/Contents/MacOS/Canopy', args: ['--input-type=module', '-e', 'code'], env: { ELECTRON_RUN_AS_NODE: '1', CANOPY_TOOLS_SOCKET: '/tmp/x/s', CANOPY_TOOLS_TOKEN: 'secret' } };
  const config = CT.codexToolConfig(server);
  assert.deepEqual(config, { 'mcp_servers.canopy': {
    command: server.command, args: server.args, env: server.env,
    default_tools_approval_mode: 'approve', startup_timeout_sec: 30, tool_timeout_sec: 86400,
  } });
  assert.deepEqual(Object.keys(config), [`mcp_servers.${T.CANOPY_SERVER}`], 'never a nested mcp_servers table: that one replaces the process\'s own -c settings');
  assert.notEqual(config[KEY].args, server.args);
  assert.notEqual(config[KEY].env, server.env);
});

test('a new chat and a reopened one are both opened with Canopy\'s server, each process with a token of its own', { skip: missing }, async () => {
  const { s, fake, relay } = make({}, { known: [CHAT] });
  assert.equal((await s.warm()).ok, true);
  const start = fake.sent('thread/start')[0].params;
  assert.deepEqual(Object.keys(start.config).sort(), [KEY, 'skills.max_context_tokens'].sort()); // and the skill list's size (codex-session skillCap)
  const first = start.config[KEY];
  assert.deepEqual({ [KEY]: start.config[KEY] }, CT.codexToolConfig({ command: process.execPath, args: ['--input-type=module', '-e', RL.HELPER], env: { ELECTRON_RUN_AS_NODE: '1', CANOPY_TOOLS_SOCKET: relay.socketPath, CANOPY_TOOLS_TOKEN: first.env.CANOPY_TOOLS_TOKEN } }));
  assert.match(first.env.CANOPY_TOOLS_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(start.developerInstructions, F.CANOPY_FACTS_NEUTRAL, 'beside the facts, which name no tool');
  assert.ok(!JSON.stringify(fake.last.args).includes(first.env.CANOPY_TOOLS_TOKEN), 'the token is never on Codex\'s command line');
  assert.ok(!fake.last.args.includes('-c'), 'and the app still passes no -c flags');
  assert.deepEqual((await helper(first)).tools.map((t) => t.name), ['look', 'read_chat', 'show_widget', 'read_me', 'task']);

  const again = make({ resume: CHAT, tools: relay }, { known: [CHAT] });
  assert.equal((await again.s.warm()).ok, true);
  const resume = again.fake.sent('thread/resume')[0].params;
  assert.equal(resume.threadId, CHAT);
  assert.deepEqual(Object.keys(resume.config).sort(), [KEY, 'skills.max_context_tokens'].sort());
  assert.notEqual(resume.config[KEY].env.CANOPY_TOOLS_TOKEN, first.env.CANOPY_TOOLS_TOKEN);
  assert.deepEqual({ ...resume.config[KEY], env: null }, { ...first, env: null }, 'the same server, word for word, but for the token');
});

test('a chat that is gone from disk starts anew with the same server', { skip: missing }, async () => {
  const { s, fake } = make({ resume: CHAT }); // nothing is "on disk" for this fake
  assert.equal((await s.warm()).ok, true);
  assert.deepEqual(fake.sent('thread/start')[0].params.config, fake.sent('thread/resume')[0].params.config);
  assert.equal((await helper(serverOf(fake))).tools.length, 5);
});

test('with no relay, or no tool the chat can have, a thread is opened as it always was', { skip: missing }, async () => {
  const bare = make({ tools: null });
  assert.equal((await bare.s.warm()).ok, true);
  assert.deepEqual(bare.fake.sent('thread/start')[0].params.config, { 'skills.max_context_tokens': 4000 }, 'only the skill list\'s size');
  const none = new RL.ToolRelay({ tmpdir: root });
  relays.push(none);
  await none.close(); // a relay that cannot listen: the chat starts without the tools, and says nothing to the user
  const down = make({ tools: none });
  assert.equal((await down.s.warm()).ok, true);
  assert.deepEqual(down.fake.sent('thread/start')[0].params.config, { 'skills.max_context_tokens': 4000 });
  assert.ok(!down.w.all((e) => e.kind === 'notice' || e.kind === 'error').length);
});

// Checked against Codex 0.169.0 in a throwaway CODEX_HOME: Canopy's entry is laid over a server of the same name in
// the user's config file key by key. Theirs with a `url` then stops every thread from opening ("url is not supported
// for stdio"), their `enabled_tools` hides Canopy's tools, and their `enabled = false` keeps the helper from starting.
test('a user who has an MCP server of that name keeps theirs, and the chat starts without Canopy\'s tools', { skip: missing }, async () => {
  const config = (servers) => ({ config: { model: null, sandbox_mode: null, sandbox_workspace_write: null, developer_instructions: null, ...(servers && { mcp_servers: servers }) }, origins: {} });
  const theirs = make({}, { handlers: { 'config/read': () => config({ canopy: { url: 'http://127.0.0.1:9/mcp', enabled: true }, github: { command: 'gh-mcp' } }) } });
  assert.equal((await theirs.s.warm()).ok, true);
  assert.deepEqual(theirs.fake.sent('thread/start')[0].params.config, { 'skills.max_context_tokens': 4000 }, 'no server of Canopy\'s');
  assert.equal(theirs.logs.filter((l) => l.level === 'warn' && /MCP server of their own named canopy/.test(l.msg)).length, 1);
  assert.equal(theirs.relay.socketPath, null, 'nothing was set up for it');
  // Their server is theirs: listed like any other.
  theirs.fake.last.note('mcpServer/startupStatus/updated', { threadId: theirs.fake.last.threadId, name: 'canopy', status: 'ready', error: null });
  await sleep(20);
  assert.deepEqual((await theirs.s.mcpStatus()).map((r) => r.name), ['canopy']);
  assert.ok(!theirs.w.all((e) => e.kind === 'notice' || e.kind === 'error').length);

  const others = make({}, { handlers: { 'config/read': () => config({ github: { command: 'gh-mcp' } }) } });
  assert.equal((await others.s.warm()).ok, true);
  assert.deepEqual(Object.keys(others.fake.sent('thread/start')[0].params.config).sort(), [KEY, 'skills.max_context_tokens'].sort(), 'servers under other names change nothing');
  // A size of their own for the skill list is left alone.
  const sized = make({}, { handlers: { 'config/read': () => ({ ...config(null), config: { ...config(null).config, skills: { max_context_tokens: 9000 } } }) } });
  assert.equal((await sized.s.warm()).ok, true);
  assert.deepEqual(Object.keys(sized.fake.sent('thread/start')[0].params.config), [KEY]);

  // A config that could not be read might hold one: nothing is sent, as with the user's own instructions.
  const unread = make({}, { errors: { 'config/read': { message: 'no' } } });
  assert.equal((await unread.s.warm()).ok, true);
  assert.ok(!('config' in unread.fake.sent('thread/start')[0].params));
  assert.ok(!('developerInstructions' in unread.fake.sent('thread/start')[0].params));
});

test('a chat has the same tools every time its process starts, and a host with no screen has no look', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.send('one');
  await idle(w);
  const first = serverOf(fake);
  const before = (await helper(first)).tools;
  assert.deepEqual(before, [L.LOOK, R.READ_CHAT, W.SHOW_WIDGET, W.READ_ME, K.TASK].map(T.mcpTool), 'look, read_chat, the widgets and task, as the registry defines them');
  assert.equal(before[0].description, L.LOOK_DESCRIPTION);
  assert.equal(before[1].description, R.READ_CHAT_BRIEF, 'read_chat in its short wording: Codex cannot keep it behind tool search');
  await s.stop();
  s.lookBackend = null; // whatever changes while the chat lives, its tools do not
  const mark = w.mark();
  s.send('two');
  await idle(w, mark);
  assert.equal(fake.children.length, 2);
  const second = serverOf(fake);
  assert.equal(fake.sent('thread/resume').length, 1);
  assert.notEqual(second.env.CANOPY_TOOLS_TOKEN, first.env.CANOPY_TOOLS_TOKEN);
  assert.deepEqual((await helper(second)).tools, before, 'the same list, in the same order, word for word');
  assert.deepEqual(s.ownTools.names(), ['look', 'read_chat', 'show_widget', 'read_me', 'task']);

  const blind = make({ look: null });
  assert.equal((await blind.s.warm()).ok, true);
  assert.deepEqual((await helper(serverOf(blind.fake))).tools.map((t) => t.name), ['read_chat', 'show_widget', 'read_me', 'task']);
});

test('when a chat\'s process goes, so does its token; the next process has a new one', { skip: missing }, async () => {
  const { s, fake, w } = make();
  s.send('one');
  await idle(w);
  const first = serverOf(fake);
  const h = await helper(first);
  assert.equal(h.tools.length, 5);
  fake.last.die(1);
  await until(() => h.closed, 3000, 'the helper\'s connection to be closed');
  assert.equal((await helper(first)).tools, null, 'the old token opens nothing');
  const mark = w.mark();
  s.send('two');
  await idle(w, mark);
  assert.equal((await helper(serverOf(fake))).tools.length, 5);
  await s.dispose({ graceMs: 50 });
  await sleep(20);
  assert.equal((await helper(serverOf(fake))).tools, null, 'and a chat that is closed leaves none behind');
});

test('Canopy\'s own server is not listed among the user\'s, and one that did not start is only noted', { skip: missing }, async () => {
  const { s, fake, logs, w } = make();
  await s.warm();
  fake.last.note('mcpServer/startupStatus/updated', { threadId: fake.last.threadId, name: 'canopy', status: 'starting', error: null });
  fake.last.note('mcpServer/startupStatus/updated', { threadId: fake.last.threadId, name: 'github', status: 'ready', error: null });
  fake.last.note('mcpServer/startupStatus/updated', { threadId: fake.last.threadId, name: 'canopy', status: 'failed', error: 'MCP client for `canopy` failed to start' });
  await until(() => logs.some((l) => /tools did not start/.test(l.msg)), 3000, 'the failure to be noted');
  assert.deepEqual((await s.mcpStatus()).map((r) => r.name), ['github']);
  assert.ok(!w.all((e) => e.kind === 'notice' || e.kind === 'error').length, 'the user is not told: the chat works without them');
  // Without Canopy's tools a server of that name is the user's own, and listed like any other.
  const plain = make({ tools: null });
  await plain.s.warm();
  plain.fake.last.note('mcpServer/startupStatus/updated', { threadId: plain.fake.last.threadId, name: 'canopy', status: 'ready', error: null });
  await sleep(20);
  assert.deepEqual((await plain.s.mcpStatus()).map((r) => r.name), ['canopy']);
});

// ---- how the window is told ----

test('a Codex chat\'s rows and approval cards name Canopy\'s tools as a Claude chat does', { skip: missing }, () => {
  const item = (server, tool) => ({ type: 'mcpToolCall', id: 'exec-1', server, tool, status: 'inProgress', arguments: { url: 'http://localhost:3000/' }, result: null, error: null });
  const started = (server, tool) => A.adapt({ method: 'item/started', params: { threadId: 't', turnId: 'u', item: item(server, tool) } }).find((e) => e.kind === 'tool-start');
  assert.equal(started('canopy', 'look').name, L.LOOK_TOOL);
  assert.equal(started('canopy', 'read_chat').name, R.READ_CHAT_TOOL);
  assert.equal(started('canopy', 'show_widget').name, W.SHOW_TOOL, 'a widget is drawn as a Claude chat\'s is');
  assert.equal(started('canopy', 'read_me').name, W.GUIDE_TOOL);
  assert.equal(started('canopy', 'other').name, 'mcp__canopy__other');
  assert.equal(started('github', 'look').name, 'mcp__github__look');
  const [replayed] = A.adaptHistory([{ id: 'u', status: 'completed', items: [{ ...item('canopy', 'look'), status: 'completed', result: { content: [{ type: 'text', text: 'caption' }] } }] }]).filter((e) => e.kind === 'tool-start');
  assert.equal(replayed.name, L.LOOK_TOOL, 'and so does a chat read back from disk');
  const ask = (persist) => A.requestOf({ id: 7, method: 'mcpServer/elicitation/request', params: { threadId: 't', turnId: 'u', serverName: 'canopy', mode: 'form', requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call', persist, tool_name: 'look', tool_params: { url: 'https://example.com/' } } } }, null);
  const chat = ask(['session']);
  assert.deepEqual([chat.base.toolName, chat.base.type, chat.base.input, chat.base.hasSuggestions, chat.base.alwaysForChat], [L.LOOK_TOOL, 'tool', { url: 'https://example.com/' }, true, true]);
  assert.ok(!('alwaysForChat' in ask(['session', 'always']).base), 'a tool Codex can remember for good keeps "Always allow"');
  assert.ok(!('alwaysForChat' in ask([]).base));
});

// ---- who is asked ----

test('a look at this Mac runs without a card: a page on localhost, and Canopy\'s own window and no other', { skip: missing }, async () => {
  const m = await running();
  const page = await m.h.call('look', { url: 'localhost:3000/settings', width: 390 }).result;
  assert.deepEqual(page.content.map((b) => b.type), ['image', 'text']);
  assert.equal(page.content[0].data, Buffer.from('png').toString('base64'), 'the picture goes back as a picture');
  assert.match(textOf(page), /^http:\/\/localhost:3000\/settings at 390×800/);
  const own = await m.h.call('look', { window: 'Canopy' }).result;
  assert.match(textOf(own), /^Window "Canopy: Canopy \(this app\)"/);
  assert.equal(m.s.lookBackend.seen.others, 0, 'a call nobody was asked about never sees another app');
  assert.deepEqual(m.cards(), []);
  assert.equal(m.s.state, 'running');
  const wrong = await m.h.call('look', {}).result;
  assert.equal(wrong.isError, true, 'a call that asks for nothing is answered, not asked about');
  assert.deepEqual(m.cards(), []);
});

test('a Codex chat keeps its looks under its own id, as a Claude chat does', { skip: missing || !SH.createShotStore }, async () => {
  const store = SH.createShotStore({ dir: path.join(root, 'shots') });
  const m = await running({ shots: store });
  const page = await m.h.call('look', { url: 'localhost:3000/settings', width: 390 }).result;
  assert.ok(textOf(page).endsWith(`\n${L.savedLine('look-1')}`));
  assert.ok(m.s.sessionId, 'the chat has its id by the time it looks');
  const got = store.get(m.s.sessionId, 'look-1');
  assert.deepEqual([got.width, got.height, got.url, got.data], [4, 4, 'http://localhost:3000/settings', `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`]);
  const own = await m.h.call('look', { window: 'Canopy' }).result;
  assert.ok(textOf(own).endsWith(`\n${L.savedLine('look-2')}`));
});

test('a look out on the web is put to the user on the chat\'s own card, and a yes lets it through', { skip: missing }, async () => {
  const m = await running();
  // Codex says a tool call has started before it makes it: the card is tied to that row.
  const item = { type: 'mcpToolCall', id: 'exec-77', server: 'canopy', tool: 'look', status: 'inProgress', arguments: { url: 'https://example.com/pricing' }, result: null, error: null };
  m.fake.last.note('item/started', { threadId: m.fake.last.threadId, turnId: m.fake.last.turn.id, item });
  const row = await m.w.waitFor((e) => e.kind === 'tool-start' && e.id === 'exec-77', { ms: 3000, label: 'the row' });
  assert.equal(row.name, L.LOOK_TOOL, 'drawn as a Claude chat\'s look is');
  const call = m.h.call('look', { url: 'https://example.com/pricing' }, { callId: 'exec-77', turnId: m.fake.last.turn.id });
  const card = await m.card();
  assert.deepEqual(
    { type: card.type, toolName: card.toolName, displayName: card.displayName, input: card.input, toolUseId: card.toolUseId, engine: card.engine, hasSuggestions: card.hasSuggestions, alwaysForChat: card.alwaysForChat, mcpServer: card.mcpServer, sessionId: card.sessionId, passive: card.passive },
    { type: 'tool', toolName: L.LOOK_TOOL, displayName: 'Look', input: { url: 'https://example.com/pricing' }, toolUseId: 'exec-77', engine: 'codex', hasSuggestions: true, alwaysForChat: true, mcpServer: 'canopy', sessionId: m.s.sessionId, passive: undefined },
  );
  assert.equal(m.s.state, 'requires_action');
  assert.deepEqual(m.s.snapshot().pending.map((p) => p.id), [card.id], 'a window that reloads still shows it');
  await sleep(30);
  assert.equal(call.done(), false, 'nothing is opened until the user answers');
  assert.deepEqual(m.s.lookBackend.seen.pages, []);
  assert.deepEqual(m.s.respond(card.id, { action: 'allow' }), { ok: true });
  const result = await call.result;
  assert.deepEqual(result.content.map((b) => b.type), ['image', 'text']);
  assert.deepEqual(m.s.lookBackend.seen.pages, ['https://example.com/pricing']);
  assert.ok(m.w.all((e) => e.kind === 'permission-resolved' && e.id === card.id).length === 1);
  assert.equal(m.s.state, 'running');
  assert.equal(m.fake.last.received.filter((l) => typeof l.method !== 'string' && l.result?.action).length, 0, 'Codex asked nothing, so it is told nothing');

  // One yes is one look: the same page asks again.
  const second = m.h.call('look', { url: 'https://example.com/pricing' });
  const again = await m.card(m.w.mark());
  assert.notEqual(again.id, card.id);
  m.s.respond(again.id, { action: 'allow' });
  await second.result;
});

test('a no is told to the model in words, and the look does not happen', { skip: missing }, async () => {
  const m = await running();
  for (const args of [{ url: 'https://example.com/' }, { url: '/etc/hosts' }, { window: 'Notes' }]) {
    const mark = m.w.mark();
    const call = m.h.call('look', args);
    const card = await m.card(mark);
    assert.deepEqual(card.input, args);
    m.s.respond(card.id, { action: 'deny' });
    const result = await call.result;
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'The user said no to this look call, so it did not run. Do not try it again unless they ask: carry on without it, or ask them how they would like to go on.');
  }
  assert.deepEqual([m.s.lookBackend.seen.pages, m.s.lookBackend.seen.others], [[], 0]);
  assert.equal(m.s.state, 'running', 'the turn carries on');
});

test('"Allow for this chat" covers that site, that file or that window, in this chat, and nothing wider', { skip: missing }, async () => {
  const m = await running();
  const first = m.h.call('look', { url: 'https://example.com/pricing' });
  m.s.respond((await m.card()).id, { action: 'always' });
  await first.result;
  const mark = m.w.mark();
  for (const args of [{ url: 'https://example.com/pricing', width: 390 }, { url: 'https://example.com/about', fullPage: true }]) await m.h.call('look', args).result;
  assert.deepEqual(m.s.lookBackend.seen.pages, ['https://example.com/pricing', 'https://example.com/pricing', 'https://example.com/about']);
  assert.equal(m.w.all((e) => e.kind === 'permission').length, 1, 'the same site is not asked about again');

  const other = m.h.call('look', { url: 'https://example.org/' });
  const card = await m.card(mark);
  assert.equal(card.input.url, 'https://example.org/', 'another site is');
  m.s.respond(card.id, { action: 'deny' });
  await other.result;
  const win = m.h.call('look', { window: 'Notes' });
  const winCard = await m.card(m.w.mark());
  m.s.respond(winCard.id, { action: 'always', scope: 'session' });
  assert.match(textOf(await win.result), /^Window "Notes: Shopping"/);
  assert.match(textOf(await m.h.call('look', { window: 'notes' }).result), /^Window "Notes: Shopping"/);
  assert.deepEqual([...m.s.ownTools.grants].sort(), ['look:web:https://example.com', 'look:window:notes']);

  // Another chat starts from nothing.
  const n = await running({ tools: m.relay });
  const theirs = n.h.call('look', { url: 'https://example.com/pricing' });
  n.s.respond((await n.card()).id, { action: 'deny' });
  assert.equal((await theirs.result).isError, true);
});

test('a chat that runs without asking (Full Access) looks without a card, at other apps too', { skip: missing }, async () => {
  const m = await running({ allowBypass: true, permissionMode: 'bypassPermissions' });
  assert.match(textOf(await m.h.call('look', { url: 'https://example.com/' }).result), /^https:\/\/example\.com\/ at 1280×800/);
  assert.match(textOf(await m.h.call('look', { window: 'Notes' }).result), /^Window "Notes: Shopping"/);
  assert.deepEqual(m.cards(), []);
  // Every other mode asks.
  for (const mode of ['acceptEdits', 'plan', 'auto', 'default']) {
    assert.equal((await m.s.set('permissionMode', mode)).ok, true);
    const mark = m.w.mark();
    const call = m.h.call('look', { url: `https://${mode}.example.com/` });
    const card = await m.card(mark);
    m.s.respond(card.id, { action: 'deny' });
    await call.result;
  }
});

test('reading another chat never asks, leaves this chat out, and reads only this chat\'s project', { skip: missing }, async () => {
  const m = await running({ resume: CHAT }, { known: [CHAT] });
  const list = await m.h.call('read_chat', {}).result;
  assert.ok(!list.isError);
  assert.match(textOf(list), /Other chats in this project, most recent first \(1\)/);
  assert.match(textOf(list), /"Fix the login page"/);
  assert.doesNotMatch(textOf(list), /This very chat/);
  assert.deepEqual(m.s.otherChats.asked, [work]);
  const one = await m.h.call('read_chat', { chat: 'login' }).result;
  assert.match(textOf(one), /\[1\] User: make the button blue/);
  assert.match(textOf(await m.h.call('read_chat', { chat: 'this very chat' }).result), /That is this chat/);
  assert.deepEqual(m.cards(), []);
});

test('a widget is drawn from Codex\'s call as a Claude chat\'s is, and the window\'s report on its script goes back', { skip: missing }, async () => {
  const reports = [];
  const m = await running({ widgetReport: (id) => { reports.push(id); return Promise.resolve({ errors: ['ReferenceError: chart is not defined'] }); } });
  const html = '<canopy-choices layout="cards"><canopy-choice label="zod"></canopy-choice><canopy-choice label="valibot"></canopy-choice></canopy-choices><script>chart.draw()</script>';
  const args = { i_have_seen_read_me: true, title: 'Validators', widget_code: html };
  // Codex says the call has begun, with its whole input (it streams none): the window gets the row it draws.
  const item = { type: 'mcpToolCall', id: 'call_w1', server: 'canopy', tool: 'show_widget', status: 'inProgress', arguments: args, result: null, error: null };
  m.fake.last.note('item/started', { threadId: m.fake.last.threadId, turnId: m.fake.last.turn.id, item });
  const row = await m.w.waitFor((e) => e.kind === 'tool-start' && e.id === 'call_w1', { ms: 3000, label: 'the widget\'s row' });
  assert.equal(row.name, W.SHOW_TOOL);
  assert.equal(row.input.widget_code, html, 'the whole widget, there to draw as the row appears');
  // The helper passes the call on under the same id; the window's report on it comes back with the result.
  const shown = await m.h.call('show_widget', args, { callId: 'call_w1', turnId: m.fake.last.turn.id }).result;
  assert.deepEqual(reports, ['call_w1']);
  assert.ok(!shown.isError);
  assert.equal(textOf(shown), textOf(W.showResult(args, { errors: ['ReferenceError: chart is not defined'] })));
  assert.match(textOf(shown), /^Shown to the user in Canopy: Validators\./);
  // A widget with no script answers at once, and the guide is read without a card.
  const plain = await m.h.call('show_widget', { ...args, widget_code: '<p>Hi</p>' }, { callId: 'call_w2' }).result;
  assert.equal(textOf(plain), 'Shown to the user in Canopy: Validators.\n\nWhat it shows, as text:\nHi');
  assert.deepEqual(reports, ['call_w1']);
  assert.match(textOf(await m.h.call('read_me', { modules: ['choices'] }).result), /canopy-choices/);
  assert.deepEqual(m.cards(), [], 'drawing never asks');
});

// ---- a card that is up when things change ----

test('Stop takes the card down and the look is told no; so does the agent giving up on the call', { skip: missing }, async () => {
  const m = await running();
  const call = m.h.call('look', { url: 'https://example.com/' });
  const card = await m.card();
  await m.s.interrupt();
  await until(() => m.w.all((e) => e.kind === 'permission-resolved' && e.id === card.id).length === 1, 3000, 'the card to go');
  assert.equal((await call.result).isError, true);
  assert.deepEqual(m.s.lookBackend.seen.pages, []);
  assert.deepEqual(m.s.respond(card.id, { action: 'allow' }).code, 'stale', 'an answer that comes after is too late');
  assert.deepEqual(m.s.lookBackend.seen.pages, []);

  const n = await running();
  const theirs = n.h.call('look', { url: 'https://example.com/' });
  const up = await n.card();
  n.h.cancel(theirs.id);
  await until(() => n.w.all((e) => e.kind === 'permission-resolved' && e.id === up.id).length === 1, 3000, 'the card to go with the call');
  assert.equal(n.s.state, 'running');
  assert.equal(n.s.pending.size, 0);
  await sleep(30);
  assert.equal(theirs.done(), false, 'nobody is waiting for the answer, so none is sent');
  assert.deepEqual(n.s.lookBackend.seen.pages, []);
});

test('a card goes with the turn, with the process and with the chat, and nothing is left waiting', { skip: missing }, async () => {
  // The turn ends under it.
  const m = await running();
  const call = m.h.call('look', { url: 'https://example.com/' });
  const card = await m.card();
  m.fake.last.playText('never mind');
  await idle(m.w);
  assert.equal(m.w.all((e) => e.kind === 'permission-resolved' && e.id === card.id).length, 1);
  assert.equal((await call.result).isError, true);

  // The process dies under it.
  const n = await running({ autoRestart: false });
  const theirs = n.h.call('look', { url: 'https://example.com/' });
  const up = await n.card();
  n.fake.last.die(1);
  await until(() => n.w.all((e) => e.kind === 'permission-resolved' && e.id === up.id).length === 1, 3000, 'the card to go with the process');
  await until(() => n.h.closed, 3000, 'the helper to be let go');
  assert.equal(await theirs.result, null);
  assert.equal(n.s.pending.size, 0);

  // The chat is closed under it.
  const o = await running();
  const last = o.h.call('look', { url: 'https://example.com/' });
  await o.card();
  await o.s.dispose({ graceMs: 50 });
  await last.result;
  assert.equal(o.s.pending.size, 0);
  assert.deepEqual([m, n, o].flatMap((x) => x.s.lookBackend.seen.pages), [], 'and no page was opened by any of them');
});

test('a question nobody can answer is a no at once: a call already stopped, a chat that is closed', { skip: missing }, async () => {
  const m = await running();
  assert.equal(await m.s.askTool(L.LOOK, { url: 'https://example.com/' }, { signal: AbortSignal.abort() }), 'deny');
  assert.deepEqual(m.cards(), [], 'no card is raised for it');
  const waiting = m.s.askTool(L.LOOK, { url: 'https://example.com/' }, {});
  await m.card();
  await m.s.dispose({ graceMs: 50 });
  assert.equal(await waiting, 'deny', 'the card went with the chat');
  assert.equal(await m.s.askTool(L.LOOK, { url: 'https://example.com/' }, {}), 'deny');
  // Before the chat's process is up there is nobody to ask for, either.
  const cold = make();
  assert.equal(await cold.s.askTool(L.LOOK, { url: 'https://example.com/' }, {}), 'deny');
});

// ---- the decision itself, on its own ----

test('createCodexTools: what runs unasked, what asks, and what a chat without a relay gets', { skip: missing }, async () => {
  const ran = [];
  const asked = [];
  let answer = 'allow';
  let free = false;
  const def = (name, over = {}) => T.defineTool({ name, description: `The ${name} tool.`, run: async (args, ctx) => { ran.push({ name, args, unasked: ctx.unasked, engine: ctx.engine, cwd: ctx.cwd }); return { content: [{ type: 'text', text: name }] }; }, ...over });
  const quiet = def('quiet');
  const careful = def('careful', { asks: async (args) => args.risky === true, scope: (args) => String(args.where ?? '') });
  const whole = def('whole', { asks: async () => true });
  const hidden = def('hidden', { available: () => false });
  let link = null;
  const relay = { connect: async (o) => { link = o; return { server: { command: 'node', args: ['-e', 'x'], env: { A: '1' } }, close: () => { link.closed = true; } }; } };
  const tools = CT.createCodexTools({ relay, tools: [quiet, careful, whole, hidden], chat: () => ({ cwd: '/work', sessionId: 's1' }), free: () => free, ask: async (tool, args, meta) => { asked.push([tool.name, args, meta.callId]); return answer; } });
  assert.deepEqual(tools.names(), [], 'nothing is decided before the chat starts');
  const made = await tools.link();
  assert.deepEqual(Object.keys(made.config), [KEY]);
  assert.deepEqual(link.tools.map((t) => t.name), ['quiet', 'careful', 'whole'], 'the tools the chat can have, in the registry\'s order');
  assert.deepEqual(tools.names(), ['quiet', 'careful', 'whole']);
  made.close();
  assert.equal(link.closed, true);
  const call = (tool, args) => link.call(tool, args, { signal: new AbortController().signal, callId: 'c1' });

  await call(quiet, { a: 1 });
  await call(careful, { risky: false });
  assert.deepEqual(asked, []);
  assert.deepEqual(ran.map((r) => [r.name, r.unasked, r.engine, r.cwd]), [['quiet', true, 'codex', '/work'], ['careful', true, 'codex', '/work']]);

  await call(careful, { risky: true, where: 'a' });
  assert.deepEqual(asked, [['careful', { risky: true, where: 'a' }, 'c1']]);
  assert.equal(ran.at(-1).unasked, false, 'a call the user said yes to is not an unasked one');
  answer = 'deny';
  const no = await call(careful, { risky: true, where: 'a' });
  assert.equal(no.isError, true);
  assert.equal(ran.length, 3);
  answer = 'always';
  await call(careful, { risky: true, where: 'a' });
  answer = 'deny';
  await call(careful, { risky: true, where: 'a' });
  assert.equal(ran.length, 5, 'allowed for the chat: not asked again');
  assert.equal((await call(careful, { risky: true, where: 'b' })).isError, true, 'another scope is');
  answer = 'always';
  await call(whole, {});
  answer = 'deny';
  await call(whole, { anything: true });
  assert.deepEqual([...tools.grants], ['careful:a', 'whole:'], 'a tool with no scope of its own is allowed whole');
  assert.equal(asked.length, 5);

  free = true;
  await call(careful, { risky: true, where: 'z' });
  assert.equal(asked.length, 5, 'a chat that runs without asking is not asked');
  assert.equal(ran.at(-1).unasked, false);
  free = false;

  // A call that was stopped while it waited for its answer is not run.
  const stopped = new AbortController();
  answer = 'allow';
  const late = link.call(careful, { risky: true, where: 'q' }, { signal: stopped.signal });
  stopped.abort();
  const before = ran.length;
  assert.equal((await late).isError, true);
  assert.equal(ran.length, before);

  const down = CT.createCodexTools({ relay: { connect: async () => null }, tools: [quiet], chat: () => ({}), ask: async () => 'deny' });
  assert.equal(await down.link(), null);
  const broken = CT.createCodexTools({ relay: { connect: async () => { throw new Error('no socket'); } }, tools: [quiet], chat: () => ({}), ask: async () => 'deny', log: () => { throw new Error('and no log'); } });
  assert.equal(await broken.link(), null, 'a relay that fails is a chat without the tools, never a chat that cannot start');
  const empty = CT.createCodexTools({ relay, tools: [hidden], chat: () => ({}), ask: async () => 'deny' });
  assert.equal(await empty.link(), null);
});

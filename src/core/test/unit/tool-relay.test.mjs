// The tool relay (tool-relay.mjs) and its helper (tool-relay-helper.mjs): the socket and who may speak on it, a
// call from end to end, stopping one, and what is left behind. The helper is started the way an agent starts it
// (the relay's own `server` entry), with this test as the agent on its stdio. Nothing outside the temp folder is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { core, sleep } from '../helpers.mjs';

const [RL, T] = await Promise.all(['tool-relay.mjs', 'tool-registry.mjs'].map((f) => core(f)));
const missing = [RL, T].find((m) => m.__missing)?.__missing ?? (RL.RELAY_MISSING ? `the relay cannot load: ${RL.RELAY_MISSING}` : false);

// A short name, and not the real path behind /var: a socket's path has to fit in 103 bytes.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-rl-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const relays = [];
const children = [];
const sockets = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const c of children.splice(0)) { if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await new Promise((r) => c.once('exit', r)); } }
  for (const r of relays.splice(0)) await r.close();
});

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const tool = (name, run = async (args) => text(`${name}: ${JSON.stringify(args)}`), over = {}) => T.defineTool({ name, description: `The ${name} tool.`, params: { text: { type: 'string', description: 'Words.' } }, run, ...over });
function relay(opts = {}) {
  const logs = [];
  const r = new RL.ToolRelay({ tmpdir: root, log: (level, msg, data) => logs.push({ level, msg, data }), ...opts });
  relays.push(r);
  return { r, logs };
}
const until = async (cond, ms = 3000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

// A connection to the relay's socket, as a helper would make one.
function dial(file) {
  const s = net.createConnection(file);
  sockets.push(s);
  const c = { s, lines: [], closed: false, raw: '' };
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (d) => { c.raw += d; buf += d; let at; while ((at = buf.indexOf('\n')) >= 0) { c.lines.push(JSON.parse(buf.slice(0, at))); buf = buf.slice(at + 1); } });
  s.on('error', () => {});
  s.on('close', () => { c.closed = true; });
  c.send = (m) => s.write(typeof m === 'string' ? m : `${JSON.stringify(m)}\n`);
  c.line = async (pred, label = 'a line') => { await until(() => c.lines.some(pred), 3000, label); return c.lines.find(pred); };
  c.gone = () => until(() => c.closed, 3000, 'the connection to be closed');
  return c;
}
async function hello(file, token) {
  const c = dial(file);
  c.send({ t: 'hello', token });
  await c.line((m) => m.t === 'ready', 'ready');
  return c;
}

// The helper, started as an agent starts it, with this test speaking MCP on its stdio.
function helper(server, env = {}) {
  const child = spawn(server.command, server.args, { env: { PATH: process.env.PATH, ...server.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const h = { child, out: [], stderr: '', raw: '' };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { h.raw += d; buf += d; let at; while ((at = buf.indexOf('\n')) >= 0) { h.out.push(JSON.parse(buf.slice(0, at))); buf = buf.slice(at + 1); } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { h.stderr += d; });
  child.stdin.on('error', () => {});
  h.send = (m) => child.stdin.write(typeof m === 'string' ? m : `${JSON.stringify(m)}\n`);
  h.ask = (id, method, params) => { h.send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) }); return h.answer(id); };
  h.answer = async (id) => { await until(() => h.out.some((m) => m.id === id), 5000, `the answer to ${id}${h.stderr ? ` (stderr: ${h.stderr.slice(-300)})` : ''}`); return h.out.find((m) => m.id === id); };
  h.exit = () => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(child.exitCode) : child.once('exit', (code) => resolve(code))));
  return h;
}

// ---- the socket ----

test('the socket is in a folder of its own that only this user can open, from the first chat on', { skip: missing }, async () => {
  const { r } = relay();
  assert.equal(r.socketPath, null, 'nothing listens until a chat needs it');
  const a = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  const file = r.socketPath;
  assert.equal(a.server.env.CANOPY_TOOLS_SOCKET, file);
  assert.equal(path.basename(file), 's');
  assert.equal(path.dirname(path.dirname(file)), root);
  assert.ok(Buffer.byteLength(file) <= 103, 'short enough for a socket path on macOS');
  const dir = fs.statSync(path.dirname(file));
  assert.equal(dir.mode & 0o777, 0o700, 'the folder is this user\'s alone');
  const sock = fs.statSync(file);
  assert.ok(sock.isSocket());
  assert.equal(sock.mode & 0o077, 0, 'and so is the socket');
  const b = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  assert.equal(b.server.env.CANOPY_TOOLS_SOCKET, file, 'every chat shares the one socket');
  assert.notEqual(a.token, b.token, 'and has a token of its own');
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.equal(fs.readdirSync(root).filter((n) => n.startsWith('canopy-tools-')).length, 1);
});

test('a temp folder too deep for a socket path gives way to /tmp', { skip: missing }, async () => {
  const deep = path.join(root, 'd'.repeat(90));
  fs.mkdirSync(deep);
  const { r } = relay({ tmpdir: deep });
  const link = await r.connect({ tools: [], call: async () => text('x') });
  assert.ok(link.server.env.CANOPY_TOOLS_SOCKET.startsWith('/tmp/canopy-tools-'));
  const c = await hello(r.socketPath, link.token);
  assert.deepEqual(c.lines[0], { t: 'ready', tools: [] });
});

test('what an agent is told to start: this program as Node, the helper as its script, the token only in its environment', { skip: missing }, async () => {
  const { r } = relay({ execPath: '/Applications/Canopy.app/Contents/MacOS/Canopy' });
  const link = await r.connect({ tools: [tool('echo')], call: async () => text('x') });
  assert.equal(link.server.command, '/Applications/Canopy.app/Contents/MacOS/Canopy');
  assert.deepEqual(link.server.args, ['--input-type=module', '-e', RL.HELPER]);
  assert.deepEqual(link.server.env, { ELECTRON_RUN_AS_NODE: '1', CANOPY_TOOLS_SOCKET: r.socketPath, CANOPY_TOOLS_TOKEN: link.token });
  assert.ok(!link.server.args.join(' ').includes(link.token) && !link.server.command.includes(link.token), 'a command line is something any program can read');
  assert.ok(!RL.HELPER.includes(r.socketPath));
  assert.equal((await relay().r.connect({ tools: [], call: async () => text('x') })).server.command, process.execPath, 'by default, the program this runs in');
  assert.equal(await r.connect({ tools: [] }), null, 'a chat with nothing to answer calls with has no link');
});

// ---- who may speak ----

test('a connection that does not say hello with a live token is closed without a word', { skip: missing }, async () => {
  const { r } = relay({ limits: { helloMs: 80 } });
  const calls = [];
  const link = await r.connect({ tools: [tool('echo')], call: (t, args) => { calls.push(args); return t.run(args); } });
  const other = await relay().r.connect({ tools: [], call: async () => text('x') });
  const file = r.socketPath;
  for (const [why, first] of [
    ['a wrong token', { t: 'hello', token: 'f'.repeat(64) }],
    ['another relay\'s token', { t: 'hello', token: other.token }],
    ['no token', { t: 'hello' }],
    ['a token that is not text', { t: 'hello', token: { $ne: null } }],
    ['a call before hello', { t: 'call', id: 1, name: 'echo', args: {} }],
    ['a line that is not JSON', 'GET / HTTP/1.1\r\n\n'],
    ['a line that is not an object', '["hello"]\n'],
    ['the token as bare text', `${link.token}\n`],
  ]) {
    const c = dial(file);
    c.send(first);
    await c.gone();
    assert.equal(c.raw, '', `${why}: nothing is said back`);
  }
  const quiet = dial(file);
  const started = Date.now();
  await quiet.gone();
  assert.ok(Date.now() - started >= 60, 'one that says nothing is given a moment, then dropped');
  assert.equal(quiet.raw, '');
  assert.deepEqual(calls, [], 'and none of them reached a tool');
  const good = await hello(file, link.token);
  assert.equal(good.lines[0].tools[0].name, 'echo', 'the real one still gets in');
});

test('a line that is not a message, or is too long, ends the connection', { skip: missing }, async () => {
  const { r } = relay({ limits: { maxLine: 2000 } });
  const link = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  const a = await hello(r.socketPath, link.token);
  a.send('{"t":"call","id":1,\n');
  await a.gone();
  const b = await hello(r.socketPath, link.token);
  b.send(`{"t":"call","id":1,"name":"echo","args":{"text":"${'x'.repeat(5000)}`); // no end in sight
  await b.gone();
  const c = await hello(r.socketPath, link.token);
  c.send({ t: 'what' });
  await c.gone();
  const d = await hello(r.socketPath, link.token);
  d.send({ t: 'call', name: 'echo', args: {} }); // no id to answer to
  await d.gone();
  const e = await hello(r.socketPath, link.token);
  e.send({ t: 'call', id: 1, name: 'echo', args: { text: 'x'.repeat(1500) } });
  assert.match((await e.line((m) => m.t === 'result')).result.content[0].text, /^echo: /, 'a long line within the limit is fine');
  e.send({ t: 'cancel', id: 99 }); // nothing by that id: nothing happens
  e.send({ t: 'call', id: 2, name: 'echo', args: {} });
  await e.line((m) => m.id === 2);
  assert.equal(e.closed, false);
});

// ---- a call ----

test('a call reaches the chat\'s own handler with the tool, its arguments and what the agent calls it', { skip: missing }, async () => {
  const { r, logs } = relay();
  const seen = [];
  const tools = [tool('echo', undefined, { brief: 'Echo.', annotations: { title: 'Echo', readOnlyHint: true } }), tool('boom', async () => { throw new Error('it broke'); }), tool('nothing', async () => null)];
  const link = await r.connect({ tools, call: (t, args, meta) => { seen.push({ tool: t, args, meta }); return t.run(args); } });
  const c = await hello(r.socketPath, link.token);
  assert.deepEqual(c.lines[0], { t: 'ready', tools: tools.map(T.mcpTool) }, 'the chat\'s tools, in order, as an MCP tools/list');
  assert.equal(c.lines[0].tools[0].description, 'Echo.');

  c.send({ t: 'call', id: 1, name: 'echo', args: { text: 'hi' }, meta: { callId: 'exec-1', threadId: 'thread-1', turnId: 'turn-1', other: 'dropped' } });
  assert.deepEqual(await c.line((m) => m.id === 1), { t: 'result', id: 1, result: text('echo: {"text":"hi"}') });
  assert.equal(seen[0].tool, tools[0]);
  assert.deepEqual(seen[0].args, { text: 'hi' });
  assert.deepEqual({ ...seen[0].meta, signal: null }, { signal: null, callId: 'exec-1', threadId: 'thread-1', turnId: 'turn-1' });
  assert.ok(seen[0].meta.signal instanceof AbortSignal && !seen[0].meta.signal.aborted);

  c.send({ t: 'call', id: 'two', name: 'echo', args: 'not an object', meta: { callId: 'x'.repeat(500), threadId: 7 } });
  await c.line((m) => m.id === 'two');
  assert.deepEqual(seen[1].args, {});
  assert.deepEqual([seen[1].meta.callId, seen[1].meta.threadId, seen[1].meta.turnId], [null, null, null], 'ids that are not short text are left out');

  c.send({ t: 'call', id: 3, name: 'rm_rf', args: {} });
  const none = (await c.line((m) => m.id === 3)).result;
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /no tool named "rm_rf"/);
  c.send({ t: 'call', id: 4, name: 'constructor', args: {} });
  assert.equal((await c.line((m) => m.id === 4)).result.isError, true);

  c.send({ t: 'call', id: 5, name: 'boom', args: {} });
  const broke = (await c.line((m) => m.id === 5)).result;
  assert.equal(broke.isError, true);
  assert.match(broke.content[0].text, /^boom failed: it broke\. Try once more/);
  assert.ok(logs.some((l) => l.level === 'warn' && l.data?.tool === 'boom'));
  c.send({ t: 'call', id: 6, name: 'nothing', args: {} });
  assert.match((await c.line((m) => m.id === 6)).result.content[0].text, /nothing gave no answer/);
  assert.equal(c.closed, false, 'a tool that fails is an answer, not the end of the connection');
  assert.equal(seen.length, 4);
});

test('a call the agent no longer wants is stopped, and so is every call of a connection that goes away', { skip: missing }, async () => {
  const { r } = relay();
  const running = [];
  const wait = tool('wait', (args, ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => resolve(text('stopped'))); }));
  const link = await r.connect({ tools: [wait, tool('echo')], call: (t, args, meta) => { running.push(meta.signal); return t.run(args, { signal: meta.signal }); } });
  const c = await hello(r.socketPath, link.token);
  c.send({ t: 'call', id: 1, name: 'wait', args: {} });
  c.send({ t: 'call', id: 2, name: 'wait', args: {} });
  await until(() => running.length === 2);
  c.send({ t: 'cancel', id: 1 });
  await until(() => running[0].aborted, 3000, 'the first call to be stopped');
  assert.equal(running[1].aborted, false, 'only the one that was named');
  c.send({ t: 'call', id: 3, name: 'echo', args: {} });
  await c.line((m) => m.id === 3);
  assert.ok(!c.lines.some((m) => m.id === 1), 'nothing is sent for a call nobody is waiting on');
  c.send({ t: 'call', id: 2, name: 'echo', args: {} }); // an id still in use: not something a helper does
  await c.gone();
  await until(() => running[1].aborted, 3000, 'the second call to be stopped with its connection');
});

test('letting a process go ends its token at once: its calls stop, its connections close, and no other chat notices', { skip: missing }, async () => {
  const { r } = relay();
  const signals = [];
  const wait = tool('wait', (args, ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => resolve(text('stopped'))); }));
  const mine = await r.connect({ tools: [wait], call: (t, args, meta) => { signals.push(meta.signal); return t.run(args, { signal: meta.signal }); } });
  const theirs = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  const a = await hello(r.socketPath, mine.token);
  const a2 = await hello(r.socketPath, mine.token); // a chat's agent may bring a helper of its own
  const b = await hello(r.socketPath, theirs.token);
  assert.equal(b.lines[0].tools[0].name, 'echo', 'each token gets its own chat\'s tools');
  a.send({ t: 'call', id: 1, name: 'wait', args: {} });
  await until(() => signals.length === 1);
  mine.close();
  mine.close(); // twice is once
  await a.gone();
  await a2.gone();
  assert.equal(signals[0].aborted, true);
  const late = dial(r.socketPath);
  late.send({ t: 'hello', token: mine.token });
  await late.gone();
  assert.equal(late.raw, '', 'the old token opens nothing');
  b.send({ t: 'call', id: 1, name: 'echo', args: { text: 'still here' } });
  assert.match((await b.line((m) => m.id === 1)).result.content[0].text, /still here/);
});

test('a socket swept from the temp folder is opened anew: connected helpers carry on, and every token stays good', { skip: missing }, async () => {
  const { r, logs } = relay();
  const before = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  const first = r.socketPath;
  const old = await hello(first, before.token);
  fs.rmSync(path.dirname(first), { recursive: true, force: true }); // what macOS does to a temp file left alone for days
  const after = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  const second = r.socketPath;
  assert.notEqual(second, first);
  assert.equal(after.server.env.CANOPY_TOOLS_SOCKET, second);
  assert.ok(fs.statSync(second).isSocket());
  assert.ok(logs.some((l) => l.level === 'warn' && /removed from disk/.test(l.msg)));
  old.send({ t: 'call', id: 1, name: 'echo', args: { text: 'still connected' } });
  assert.match((await old.line((m) => m.id === 1)).result.content[0].text, /still connected/);
  assert.equal((await hello(second, after.token)).lines[0].tools.length, 1);
  assert.equal((await hello(second, before.token)).lines[0].tools.length, 1, 'a token outlives the socket it was handed out on');
  await r.close();
  assert.equal(fs.existsSync(path.dirname(second)), false);
  await old.gone();
});

test('closing the relay removes the socket and its folder, and nothing can be linked afterwards', { skip: missing }, async () => {
  const { r } = relay();
  const link = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  const file = r.socketPath;
  const c = await hello(file, link.token);
  const exits = process.listenerCount('exit');
  await r.close();
  await c.gone();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.equal(r.socketPath, null);
  assert.equal(process.listenerCount('exit'), exits - 1, 'its clean-up at exit is taken off again');
  assert.equal(await r.connect({ tools: [tool('echo')], call: async () => text('x') }), null);
  await r.close(); // twice is once
  const refused = dial(file);
  await refused.gone();

  // A relay that never listened leaves nothing, and one that cannot listen says so and gives no link.
  const idle = relay();
  await idle.r.close();
  const broken = relay({ tmpdir: path.join(root, 'not-there'), limits: { maxPath: 4000 } });
  assert.equal(await broken.r.connect({ tools: [], call: async () => text('x') }), null);
  assert.ok(broken.logs.some((l) => l.level === 'warn' && /could not start/.test(l.msg)));

  // What a crash would leave is taken away when the process exits.
  const crashed = relay();
  await crashed.r.connect({ tools: [], call: async () => text('x') });
  const left = crashed.r.socketPath;
  crashed.r.onExit();
  assert.equal(fs.existsSync(path.dirname(left)), false);
});

// ---- the helper, as an agent sees it ----

test('the helper is an MCP server: it shakes hands, lists the chat\'s tools and passes a call through whole', { skip: missing }, async () => {
  const { r } = relay();
  const seen = [];
  const picture = Buffer.alloc(1_200_000, 7).toString('base64'); // a screenshot's worth: several pieces on the wire
  const shot = tool('shot', async () => ({ content: [{ type: 'image', data: picture, mimeType: 'image/png' }, { type: 'text', text: 'A caption, with an é.' }] }), { annotations: { title: 'Shot', openWorldHint: true } });
  const link = await r.connect({ tools: [shot, tool('echo')], call: (t, args, meta) => { seen.push({ name: t.name, args, meta }); return t.run(args); } });
  const h = helper(link.server);

  const init = await h.ask(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'codex-mcp-client', version: '0.169.0' } });
  assert.deepEqual(init, { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'canopy', version: '1.0.0' } } });
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual((await h.ask(1, 'ping')).result, {});
  const list = await h.ask(2, 'tools/list', { _meta: { progressToken: 0 } });
  assert.deepEqual(list.result, { tools: [shot, link.tools.get('echo')].map(T.mcpTool) }, 'the tools come from the app, not from the helper');

  const called = await h.ask(3, 'tools/call', { name: 'shot', arguments: { text: 'now' }, _meta: { callId: 'exec-abc', 'x-codex-turn-metadata': { thread_id: 'thread-1', turn_id: 'turn-1', model: 'gpt' } } });
  assert.deepEqual(called.result.content, [{ type: 'image', data: picture, mimeType: 'image/png' }, { type: 'text', text: 'A caption, with an é.' }], 'the picture arrives byte for byte');
  assert.ok(!('isError' in called.result));
  assert.deepEqual({ ...seen[0], meta: { ...seen[0].meta, signal: null } }, { name: 'shot', args: { text: 'now' }, meta: { signal: null, callId: 'exec-abc', threadId: 'thread-1', turnId: 'turn-1' } });

  const bare = await h.ask(4, 'tools/call', { name: 'echo' });
  assert.deepEqual(bare.result, text('echo: {}'), 'a call with no arguments and no metadata');
  assert.deepEqual([seen[1].meta.callId, seen[1].meta.threadId, seen[1].meta.turnId], [null, null, null]);
  const unknown = await h.ask(5, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.result.isError, true);

  assert.equal((await h.ask(6, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18', 'a version it does not know is answered with the newest it speaks');
  assert.equal((await h.ask(7, 'initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05');
  assert.equal(h.stderr, '');
});

test('the helper ignores what is not a message, refuses what it does not do, and leaves when the agent does', { skip: missing }, async () => {
  const { r } = relay();
  const link = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });
  const h = helper(link.server);
  h.send('this is not JSON\n');
  h.send('{"jsonrpc":"2.0","id":1,\n');
  h.send('[]\n');
  h.send('null\n');
  h.send('\n');
  h.send({ jsonrpc: '2.0', id: 9, result: {} });                        // an answer to nothing it asked
  h.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }); // a notification it has no use for
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 404 } });
  h.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo' } }); // a call with no id cannot be answered
  for (const [id, method] of [[10, 'resources/list'], [11, 'prompts/list'], [12, 'logging/setLevel'], [13, 'tools/delete']]) {
    assert.deepEqual((await h.ask(id, method, {})).error, { code: -32601, message: `Method not found: ${method}` });
  }
  const half = JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'echo', arguments: { text: 'in two pieces' } } });
  h.send(half.slice(0, 30));
  await sleep(30);
  h.send(`${half.slice(30)}\n${JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'ping' })}\n`);
  assert.match((await h.answer(20)).result.content[0].text, /in two pieces/);
  await h.answer(21);
  assert.deepEqual(h.out.map((m) => m.id).sort((a, b) => a - b), [10, 11, 12, 13, 20, 21], 'nothing else was said');
  assert.equal(h.stderr, '');
  h.child.stdin.end();
  assert.equal(await h.exit(), 0, 'its input ending is the agent going away');
  await until(() => r.sockets.size === 0, 3000, 'its connection to close with it');
});

test('the helper passes a cancelled call on, and answers nothing for it', { skip: missing }, async () => {
  const { r } = relay();
  const signals = [];
  const wait = tool('wait', (args, ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => resolve(text('stopped'))); }));
  const link = await r.connect({ tools: [wait, tool('echo')], call: (t, args, meta) => { signals.push(meta.signal); return t.run(args, { signal: meta.signal }); } });
  const h = helper(link.server);
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } });
  await until(() => signals.length === 1, 5000, 'the call to reach the app');
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'turn interrupted' } });
  await until(() => signals[0].aborted, 3000, 'the call to be stopped in the app');
  await h.ask(2, 'tools/call', { name: 'echo', arguments: {} });
  assert.ok(!h.out.some((m) => m.id === 1), 'a cancelled request gets no answer');
});

test('when Canopy cannot be reached, the helper says so in words the model can act on, and tries again next time', { skip: missing }, async () => {
  const { r } = relay();
  const link = await r.connect({ tools: [tool('echo')], call: (t, args) => t.run(args) });

  // A token the app does not know (a helper left over from a process that was let go).
  const stale = helper({ ...link.server, env: { ...link.server.env, CANOPY_TOOLS_TOKEN: '0'.repeat(64) } });
  assert.equal((await stale.ask(0, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'canopy', 'the handshake needs nothing from the app');
  assert.deepEqual((await stale.ask(1, 'tools/list')).error, { code: -32603, message: 'Canopy could not be reached, so its tools are not available.' });
  const refused = (await stale.ask(2, 'tools/call', { name: 'echo', arguments: {} })).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /^Canopy could not be reached, so this tool did not run\. Try once more/);

  // No socket at all, and nothing in the environment.
  const lost = helper({ ...link.server, env: { ...link.server.env, CANOPY_TOOLS_SOCKET: path.join(root, 'gone', 's') } });
  assert.equal((await lost.ask(1, 'tools/call', { name: 'echo', arguments: {} })).result.isError, true);
  const bare = helper({ ...link.server, env: {} });
  assert.equal((await bare.ask(1, 'tools/call', { name: 'echo', arguments: {} })).result.isError, true);
  assert.ok((await bare.ask(2, 'tools/list')).error);

  // The link goes while a call is in flight: that call is answered, and the helper is still there for the next.
  let entered = 0;
  const hang = tool('hang', () => { entered += 1; return new Promise(() => {}); });
  const mine = await r.connect({ tools: [hang], call: (t, args) => t.run(args) });
  const h = helper(mine.server);
  await h.ask(1, 'tools/list');
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hang', arguments: {} } });
  await until(() => entered === 1, 5000, 'the call to reach the app');
  mine.close();
  assert.match((await h.answer(2)).result.content[0].text, /^Canopy could not be reached/);
  assert.match((await h.ask(3, 'tools/call', { name: 'hang', arguments: {} })).result.content[0].text, /^Canopy could not be reached/, 'the next call tries the socket again, and is told no');
  assert.equal(entered, 1);
  assert.equal(h.child.exitCode, null, 'it stays up for as long as the agent does');
});

// codex-host.mjs: finding Codex, its flags and environment, one app-server process, and the shared helper process
// for calls outside a chat. Driven by fake-codex.mjs: no Codex is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex, recordedModels } from '../fake-codex.mjs';
import { sleep, within } from '../helpers.mjs';
import {
  ACCOUNT_CALLS, CODEX_OVERRIDES, CodexProcess, CodexService, FAST_TIER, codexEnv, codexModelInfo, codexVersion, configArgs, findCodex, listModels, readTurns,
} from '../../codex-host.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-host-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) { try { await within(x.close ? x.close({ graceMs: 0 }) : x.shutdown(0), 4000, 'clean-up'); } catch { /* the test reports its own failures */ } }
});
const rejected = async (promise) => { try { await promise; } catch (err) { return err; } assert.fail('expected a rejection'); };
const until = async (cond, ms = 2000, label = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await sleep(5); }
};

function proc(fake, opts = {}) {
  const p = new CodexProcess({ codexPath: '/fake/codex', env: { PATH: '/usr/bin' }, cwd: root, spawnFn: fake.spawnFn, initTimeoutMs: 1000, requestTimeoutMs: 1000, ...opts });
  open.push(p);
  return p;
}
function service(fake, opts = {}) {
  const s = new CodexService({ codexPath: '/fake/codex', env: { PATH: '/usr/bin', HOME: root }, spawnFn: fake.spawnFn, timeouts: { init: 1000, request: 1000, list: 1000, history: 1000 }, ...opts });
  open.push(s);
  return s;
}

// ---- flags ----

test('configArgs writes each setting as a -c flag with a TOML value', () => {
  assert.deepEqual(configArgs({ model: 'gpt-6-luna', 'features.memories': false, retries: 3, ratio: 0.5 }), [
    '-c', 'model="gpt-6-luna"', '-c', 'features.memories=false', '-c', 'retries=3', '-c', 'ratio=0.5',
  ]);
});

test('configArgs quotes strings so nothing in them can end the value or start another', () => {
  const tricky = 'say "hi"\\ then\nnew line\ttab = [x] # not a comment \u007f é 🌲';
  const [, flag] = configArgs({ note: tricky });
  assert.ok(flag.startsWith('note="') && flag.endsWith('"'));
  const body = flag.slice('note='.length);
  assert.equal(JSON.parse(body), tricky, 'the value reads back as the same string');
  assert.ok(!/[\n\r\t\u007f]/.test(body), 'no bare control character: TOML does not allow one in a string');
  assert.ok(!/(^|[^\\])"/.test(body.slice(1, -1)), 'no bare quote inside the string');
  assert.deepEqual(configArgs({ empty: '' }), ['-c', 'empty=""']);
});

test('configArgs writes arrays and tables inline, quoting the keys that need it', () => {
  assert.deepEqual(configArgs({ notify: [] }), ['-c', 'notify=[]']);
  assert.deepEqual(configArgs({ notify: ['say', 'done now'] }), ['-c', 'notify=["say", "done now"]']);
  assert.deepEqual(configArgs({ 'mcp_servers.docs': { command: 'npx', args: ['-y', 'x'], enabled: true, env: { 'A KEY': '1' }, none: {} } }), [
    '-c', 'mcp_servers.docs={ command = "npx", args = ["-y", "x"], enabled = true, env = { "A KEY" = "1" }, none = {} }',
  ]);
});

test('configArgs leaves out keys that are not plain dotted names, and values TOML cannot hold', () => {
  const config = {
    'ok.key-1_x': 1, 'bad key': 1, 'bad=key': 1, '': 1, '.lead': 1, 'trail.': 1, 'a..b': 1, '--flag': 1, 'x;rm': 1,
    undef: undefined, nul: null, fn: () => 1, nan: NaN, inf: Infinity, nested: { deep: undefined }, list: [1, null],
  };
  assert.deepEqual(configArgs(config), ['-c', 'ok.key-1_x=1'], 'a key that starts with a dash could be read as a flag of its own');
  for (const bad of [null, undefined, 'x', 3, [], () => {}]) assert.deepEqual(configArgs(bad), []);
});

test('Canopy forces no Codex setting today: the user\'s notify program is left alone', () => {
  assert.deepEqual(CODEX_OVERRIDES, {});
  assert.ok(Object.isFrozen(CODEX_OVERRIDES));
  const fake = createFakeCodex();
  proc(fake).start();
  assert.deepEqual(fake.spawns[0].args, ['app-server', '--listen', 'stdio://'], 'no -c flag at all');
});

// ---- environment ----

test('codexEnv drops what the host app or a parent agent put there, and keeps the user\'s login', () => {
  const env = codexEnv({
    PATH: '/usr/bin', HOME: '/Users/x', LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'sk-user', CODEX_API_KEY: 'ck-user', CODEX_HOME: '/Users/x/.codex', OPENAI_BASE_URL: 'https://example.test',
    ANTHROPIC_API_KEY: 'theirs-too',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1234', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1',
    npm_config_prefix: '/x', CANOPY_CODEX_PATH: '/x/codex', CANOPY_SECRET: 'no',
    CODEX_THREAD_ID: 'outer', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'x',
    NOT_A_STRING: 5,
  });
  for (const k of ['PATH', 'HOME', 'LANG', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY']) assert.ok(k in env, `${k} is kept`);
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'npm_config_prefix', 'CANOPY_CODEX_PATH', 'CANOPY_SECRET',
    'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'NOT_A_STRING']) assert.ok(!(k in env), `${k} is dropped`);
  assert.equal(env.OPENAI_API_KEY, 'sk-user');
});

test('codexEnv always gives a HOME and never returns the object it was given', () => {
  const base = { PATH: '/usr/bin' };
  const env = codexEnv(base);
  assert.notEqual(env, base);
  assert.equal(env.HOME, os.homedir());
  assert.equal(typeof codexEnv().PATH, 'string', 'no argument means this process\'s own environment');
  assert.doesNotThrow(() => codexEnv('nonsense'));
});

// ---- models ----

test('codexModelInfo turns the recorded model list into picker rows', () => {
  const rows = recordedModels().map(codexModelInfo);
  assert.ok(rows.length >= 5 && rows.every(Boolean));
  const sol = rows.find((r) => r.value === 'gpt-6.1-sol');
  assert.deepEqual(
    { ...sol, efforts: undefined, description: undefined },
    {
      value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: undefined, supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], efforts: undefined, defaultEffort: 'low',
      supportsFastMode: true, serviceTiers: ['priority', 'ultrafast'], isDefault: true, hidden: false, maker: 'openai', engine: 'codex',
    },
  );
  assert.equal(sol.efforts[0].value, 'low');
  assert.equal(typeof sol.efforts[0].description, 'string');
  assert.equal(rows.filter((r) => r.isDefault).length, 1);
  assert.ok(!rows.find((r) => r.value === 'gpt-6-luna').supportedEffortLevels.includes('ultra'), 'each model keeps its own effort stops');
  assert.equal(FAST_TIER, 'priority');
});

test('codexModelInfo reads sparse and odd rows without throwing', () => {
  assert.deepEqual(codexModelInfo({ id: 'm1' }), {
    value: 'm1', displayName: 'm1', description: '', supportsEffort: false, supportedEffortLevels: [], efforts: [], defaultEffort: null,
    supportsFastMode: false, serviceTiers: [], isDefault: false, hidden: false, maker: 'openai', engine: 'codex',
  });
  assert.equal(codexModelInfo({ model: 'm2', supportedReasoningEfforts: ['low', { reasoningEffort: 'high' }, {}, null], serviceTiers: [null, { id: 'priority' }], hidden: true }).supportedEffortLevels.join(), 'low,high');
  for (const bad of [null, undefined, 'x', 3, [], {}, { id: 5 }, { model: '' }]) assert.equal(codexModelInfo(bad), null);
});

test('listModels follows every page', async () => {
  const pages = { '': { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'p2' }, p2: { data: [{ id: 'c' }, 'junk'], nextCursor: null } };
  const asked = [];
  const rows = await listModels(async (method, params) => { asked.push([method, params]); return pages[params.cursor ?? '']; }, { includeHidden: true });
  assert.deepEqual(rows.map((r) => r.value), ['a', 'b', 'c']);
  assert.deepEqual(asked, [['model/list', { includeHidden: true }], ['model/list', { cursor: 'p2', includeHidden: true }]]);
});

// ---- finding codex ----

function fakeBinary(dir, mode = 0o755) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'codex');
  fs.writeFileSync(p, '#!/bin/sh\necho "codex-cli 9.8.7"\n');
  fs.chmodSync(p, mode);
  return p;
}

test('findCodex prefers the override, then PATH in order', async () => {
  const a = fakeBinary(path.join(root, 'find-a'));
  const b = fakeBinary(path.join(root, 'find-b'));
  assert.equal(await findCodex({ PATH: `${path.dirname(a)}:${path.dirname(b)}`, HOME: root }), a);
  assert.equal(await findCodex({ PATH: `${path.dirname(b)}:${path.dirname(a)}`, HOME: root }), b);
  assert.equal(await findCodex({ PATH: path.dirname(a), HOME: root, CANOPY_CODEX_PATH: b }), b, 'the override wins');
  assert.equal(await findCodex({ PATH: path.dirname(a), HOME: root, CANOPY_CODEX_PATH: path.join(root, 'nope') }), a, 'a bad override falls through');
  assert.equal(await findCodex({ PATH: `relative/bin::${path.dirname(a)}`, HOME: root }), a, 'relative and empty PATH entries are skipped');
});

test('findCodex skips a folder anyone can write to, and a binary anyone can write to', async () => {
  const good = fakeBinary(path.join(root, 'find-good'));
  const open = fakeBinary(path.join(root, 'find-open'));
  fs.chmodSync(path.dirname(open), 0o777);
  const loose = fakeBinary(path.join(root, 'find-loose'), 0o757);
  const plain = fakeBinary(path.join(root, 'find-plain'), 0o644);
  const found = await findCodex({ PATH: [open, loose, plain, good].map((p) => path.dirname(p)).join(':'), HOME: root });
  assert.equal(found, good);
  // With nothing safe on PATH the answer is one of the usual install places, or null: never the unsafe ones.
  const none = await findCodex({ PATH: [open, loose, plain].map((p) => path.dirname(p)).join(':'), HOME: root });
  assert.ok(none === null || ![open, loose, plain].includes(none));
  assert.doesNotThrow(() => findCodex(null));
});

test('codexVersion reads the version line, and gives null when it cannot ask', async () => {
  const bin = fakeBinary(path.join(root, 'ver'));
  assert.equal(await codexVersion(bin, { PATH: '/usr/bin:/bin' }, { timeoutMs: 30000 }), '9.8.7');
  assert.equal(await codexVersion(path.join(root, 'missing'), {}), null);
  assert.equal(await codexVersion('relative/codex', {}), null);
  assert.equal(await codexVersion(null, {}), null);
});

// ---- one process ----

test('CodexProcess starts the app-server on stdio and shakes hands', async () => {
  const fake = createFakeCodex();
  const p = proc(fake, { config: { notify: [] }, flags: ['--disable', 'memories', 7], appVersion: '1.2.3' }).start();
  const info = await p.ready;
  assert.match(info.userAgent, /canopy\/0\.153\.4/);
  assert.equal(p.info, info);
  assert.equal(p.alive, true);
  assert.equal(p.pid, fake.last.pid);
  const { command, args, options } = fake.spawns[0];
  assert.equal(command, '/fake/codex');
  assert.deepEqual(args, ['app-server', '--listen', 'stdio://', '-c', 'notify=[]', '--disable', 'memories']);
  assert.equal(options.cwd, root);
  assert.deepEqual(options.env, { PATH: '/usr/bin' });
  assert.deepEqual(fake.last.received, [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'canopy', title: 'Canopy', version: '1.2.3' }, capabilities: { experimentalApi: true } } },
    { method: 'initialized' },
  ]);
  assert.equal(p.start(), p, 'a second start() does nothing');
  assert.equal(fake.spawns.length, 1);
  assert.deepEqual(await p.request('account/read', { refreshToken: false }), { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
});

test('CodexProcess hands notifications and server requests to its owner, whole', async () => {
  const fake = createFakeCodex();
  const notes = [];
  const asked = [];
  const p = proc(fake, { onNotification: (method, params, msg) => notes.push({ method, params, msg }), onRequest: (id, method, params, msg) => asked.push({ id, method, params, msg }) }).start();
  await p.ready;
  await until(() => notes.length === 1);
  assert.equal(notes[0].method, 'remoteControl/status/changed');
  assert.equal(typeof notes[0].msg.emittedAtMs, 'number');
  const q = fake.last.ask('item/tool/requestUserInput', { questions: [] });
  await until(() => asked.length === 1);
  assert.deepEqual([asked[0].id, asked[0].method, asked[0].msg.id], [0, 'item/tool/requestUserInput', 0]);
  p.respond(0, { answers: {} });
  assert.deepEqual(await q.answer, { id: 0, result: { answers: {} } });
  const q2 = fake.last.ask('unknown/thing', {});
  await until(() => asked.length === 2);
  p.respondError(q2.id, -32601, 'no');
  assert.deepEqual((await q2.answer).error, { code: -32601, message: 'no' });
});

test('a launch that fails never throws: ready and every request reject with `spawn`', async () => {
  const thrown = createFakeCodex({ spawnThrows: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) });
  const a = proc(thrown);
  assert.doesNotThrow(() => a.start());
  assert.equal((await rejected(a.ready)).code, 'spawn');
  assert.equal(a.alive, false);
  assert.equal(a.exit.failed, true);
  assert.equal((await within(a.exited, 500, 'exited')).failed, true);
  assert.equal((await rejected(a.request('model/list'))).code, 'spawn');

  const missing = createFakeCodex({ spawnError: Object.assign(new Error('spawn /fake/codex ENOENT'), { code: 'ENOENT' }) });
  const b = proc(missing).start();
  const err = await rejected(b.request('model/list'));
  assert.equal(err.code, 'spawn');
  assert.match(err.message, /could not be launched/);
  assert.equal(b.exit.error.code, 'ENOENT');
  assert.equal(await b.shutdown(0), true, 'nothing to end');
});

test('a request before start() rejects instead of hanging', async () => {
  const p = proc(createFakeCodex());
  assert.equal((await rejected(p.request('model/list'))).code, 'closed');
});

test('initialize that is never answered rejects with `timeout`', async () => {
  const fake = createFakeCodex({ hang: ['initialize'] });
  const p = proc(fake, { initTimeoutMs: 40 }).start();
  assert.equal((await rejected(p.ready)).code, 'timeout');
  assert.equal(p.alive, true, 'the owner decides what to do with a process that does not answer');
});

test('when the process exits, every call still waiting is told, and stderr is kept', async () => {
  const fake = createFakeCodex({ hang: ['thread/list'] });
  const p = proc(fake).start();
  await p.ready;
  const waiting = [p.request('thread/list', {}), p.request('thread/list', {})];
  fake.last.stderr.write('thread panicked: boom\n');
  await sleep(10);
  fake.last.die(101);
  const errs = await Promise.all(waiting.map(rejected));
  assert.deepEqual(errs.map((e) => e.code), ['closed', 'closed']);
  assert.deepEqual(await p.exited, { code: 101, signal: null });
  assert.equal(p.alive, false);
  assert.match(p.stderr, /thread panicked: boom/);
  assert.equal((await rejected(p.request('model/list'))).code, 'closed');
  assert.equal(p.respond(1, {}), false);
});

test('shutdown closes the input first, then SIGTERM, then SIGKILL, and resolves once the process is gone', async () => {
  const polite = createFakeCodex();
  const a = proc(polite).start();
  await a.ready;
  assert.equal(await a.shutdown(500), true);
  assert.deepEqual(polite.last.exited, { code: 0, signal: null }, 'end of input is enough for a healthy app-server');
  assert.deepEqual(polite.last.signals, []);

  const deaf = createFakeCodex({ ignoreEof: true });
  const b = proc(deaf).start();
  await b.ready;
  assert.equal(await b.shutdown(40), true);
  assert.deepEqual(deaf.last.signals, ['SIGTERM']);

  const stuck = createFakeCodex({ ignoreEof: true, ignoreTerm: true });
  const c = proc(stuck).start();
  await c.ready;
  const t = Date.now();
  assert.equal(await c.shutdown(40), true);
  assert.deepEqual(stuck.last.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - t >= 70, 'it waited for each step');
  assert.equal(c.alive, false);

  const now = createFakeCodex({ ignoreEof: true, ignoreTerm: true });
  const d = proc(now).start();
  await d.ready;
  assert.equal(await d.shutdown(0), true);
  assert.deepEqual(now.last.signals, ['SIGKILL'], 'no grace goes straight to SIGKILL');
  assert.equal(await d.shutdown(0), true, 'again is fine');
});

// ---- the shared helper ----

test('CodexService runs many calls on one process', async () => {
  const fake = createFakeCodex({ threads: [{ id: 't1', cwd: '/w', name: ' Named ', preview: 'hello', createdAt: 1794801559, updatedAt: 1794801562, model: 'gpt-6-luna', reasoningEffort: 'low', source: 'vscode', gitInfo: { branch: 'main' } }, { nope: 1 }] });
  const s = service(fake);
  const [models, account, threads] = await Promise.all([s.models(), s.account(), s.listThreads({ cwd: '/w', limit: 20 })]);
  assert.equal(fake.spawns.length, 1, 'one process, not one per call');
  assert.equal(models.ok, true);
  assert.equal(models.models[0].value, 'gpt-6.1-sol');
  assert.deepEqual(account, { ok: true, account: { type: 'apiKey', email: null, plan: null }, signedIn: true, requiresAuth: true });
  assert.deepEqual(threads, {
    ok: true, nextCursor: null,
    threads: [{ id: 't1', cwd: '/w', title: 'Named', preview: 'hello', createdAt: 1794801559000, updatedAt: 1794801562000, model: 'gpt-6-luna', effort: 'low', source: 'vscode', parentId: null, branch: 'main', engine: 'codex' }],
  });
  // The quick list (Codex's index, not a scan of its files), and of every model provider's chats: a chat begun on
  // a key pasted into Canopy is on another provider than the one this process runs on.
  assert.deepEqual(fake.sent('thread/list')[0].params, { cwd: '/w', limit: 20, sortKey: 'updated_at', useStateDbOnly: true, modelProviders: [] });
  await s.listThreads({ repair: true, archived: true });
  assert.deepEqual(fake.sent('thread/list')[1].params, { limit: 100, sortKey: 'updated_at', archived: true, modelProviders: [] });
  assert.equal(fake.spawns.length, 1);
  assert.equal(fake.spawns[0].options.cwd, os.homedir(), 'the helper belongs to no project');
});

test('the helper lists chats of every provider: one begun on a pasted key is there beside Codex’s own', async () => {
  const fake = createFakeCodex({ threads: [{ id: 'own', cwd: '/w' }, { id: 'keyed', cwd: '/w', modelProvider: 'canopy-openai' }] });
  const s = service(fake);
  assert.deepEqual((await s.listThreads()).threads.map((t) => t.id), ['own', 'keyed']);
  // Left to itself Codex lists only the chats of the provider the process runs on (what the fake does too).
  assert.deepEqual((await s.call('thread/list', { limit: 10 })).result.data.map((t) => t.id), ['own']);
});

// ---- a helper started for an account ----

const KEY = 'sk-proj-NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstuvwxyz-9zQx';
const ON_KEY = { 'model_providers.canopy-openai': { name: 'OpenAI', base_url: 'https://api.openai.com/v1', env_key: 'CANOPY_OPENAI_API_KEY', wire_api: 'responses', requires_openai_auth: false }, model_provider: 'canopy-openai' };
const KEY_FLAGS = ['-c', 'model_providers.canopy-openai={ name = "OpenAI", base_url = "https://api.openai.com/v1", env_key = "CANOPY_OPENAI_API_KEY", wire_api = "responses", requires_openai_auth = false }', '-c', 'model_provider="canopy-openai"'];

test('a helper with nothing to launch it for is Codex as it finds itself: the same arguments and the same environment as ever', async () => {
  const env = { PATH: '/usr/bin', HOME: root, OPENAI_API_KEY: 'sk-user', CODEX_HOME: path.join(root, 'codex-home'), CANOPY_OPENAI_API_KEY: 'from-the-shell' };
  const plain = createFakeCodex();
  await service(plain, { env }).account();
  // A launch that names no account (nothing chosen) hands back what it was given: nothing may differ.
  const asked = [];
  const viaLaunch = createFakeCodex();
  await service(viaLaunch, { env, launch: (base) => { asked.push(base); return { env: { ...base }, config: {}, provider: null }; } }).account();
  const nulled = createFakeCodex();
  await service(nulled, { env, launch: () => null }).account();
  for (const fake of [plain, viaLaunch, nulled]) {
    assert.deepEqual(fake.spawns[0].args, ['app-server', '--listen', 'stdio://'], 'no -c flag at all');
    assert.deepEqual(fake.spawns[0].options.env, { PATH: '/usr/bin', HOME: root, OPENAI_API_KEY: 'sk-user', CODEX_HOME: path.join(root, 'codex-home') });
  }
  assert.deepEqual(viaLaunch.spawns[0], plain.spawns[0], 'the whole launch is the same: command, arguments, environment, folder');
  // The base it is given is the environment a Codex process gets anyway: a variable of Canopy's own name in the
  // user's shell has already been dropped, so it can never pass for a pasted key.
  assert.deepEqual(asked, [{ PATH: '/usr/bin', HOME: root, OPENAI_API_KEY: 'sk-user', CODEX_HOME: path.join(root, 'codex-home') }]);
});

test('a helper started for a pasted key gets the key in its environment and its provider on its command line, and nothing else differs', async () => {
  // Signed in to a plan with limits to read (the fake has some by default): the key's process still knows none of it.
  const fake = createFakeCodex({ account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' } });
  const logs = [];
  const s = service(fake, { launch: (base) => ({ env: { ...base, CANOPY_OPENAI_API_KEY: KEY }, config: ON_KEY }), log: (...a) => logs.push(JSON.stringify(a)) });
  const models = await s.models();
  assert.equal(models.ok, true);
  const { command, args, options } = fake.spawns[0];
  assert.equal(command, '/fake/codex');
  assert.deepEqual(args, ['app-server', '--listen', 'stdio://', ...KEY_FLAGS]);
  assert.deepEqual(options.env, { PATH: '/usr/bin', HOME: root, CANOPY_OPENAI_API_KEY: KEY });
  assert.ok(!args.join(' ').includes(KEY), 'the key is never on the command line, where other processes could read it');
  assert.ok(!JSON.stringify(fake.received).includes(KEY), 'and never in a line written to Codex');
  // What such a process says about the account is nothing: Codex's own login is not in play on it.
  assert.deepEqual(await s.account(), { ok: true, account: null, signedIn: false, requiresAuth: false });
  assert.deepEqual([(await s.rateLimits()).ok, (await s.rateLimits()).code], [false, 'rejected']);
  // A one-off question (the name of a chat that is on this key) is answered by this same process, on the key.
  assert.deepEqual(await s.suggestTitle('Name this: fix the login loop'), { ok: true, title: 'OK' });
  assert.equal(fake.spawns.length, 1);
  assert.ok(!logs.join('\n').includes(KEY) && !JSON.stringify(models).includes(KEY));
});

test('what a helper’s Codex says or prints about its key is cut out of every answer and every log line', async () => {
  const fake = createFakeCodex();
  const logs = [];
  const s = service(fake, { launch: (base) => ({ env: { ...base, CANOPY_OPENAI_API_KEY: KEY }, config: ON_KEY }), log: (...a) => logs.push(JSON.stringify(a)), timeouts: { init: 1000, request: 150, list: 150, history: 150 } });
  // A refusal whose words carry the key comes back without it.
  fake.errors['thread/read'] = { message: `request failed: Authorization: Bearer ${KEY} was refused for ${KEY}` };
  const refused = await s.readThread('t1');
  assert.deepEqual([refused.ok, refused.code], [false, 'rejected']);
  assert.ok(refused.message.includes('[redacted]') && !refused.message.includes(KEY), refused.message);
  // A call that gets no answer is logged with what the process last printed: that goes out without the key too.
  fake.last.stderr.write(`debug: provider key ${KEY} loaded\n`);
  await sleep(20);
  fake.hang.add('thread/list');
  assert.equal((await s.listThreads()).code, 'timeout');
  const line = logs.find((l) => l.includes('codex call failed'));
  assert.ok(line && line.includes('[redacted]') && !line.includes(KEY), line);
  assert.ok(!logs.join('\n').includes('NOT-A-REAL-KEY'));
});

test('a helper whose account cannot be launched starts nothing, and says why in the account’s own words', async () => {
  const fake = createFakeCodex();
  const refusal = Object.assign(new Error('The key for Work key could not be read from the Keychain.'), { code: 'account-locked', canopy: { code: 'account-locked', message: 'The key for Work key could not be read from the Keychain.', recoverable: false } });
  let ok = false;
  const s = service(fake, { launch: (base) => { if (!ok) throw refusal; return { env: { ...base, CANOPY_OPENAI_API_KEY: KEY }, config: ON_KEY }; } });
  for (const call of [() => s.models(), () => s.account(), () => s.listThreads(), () => s.call('config/read', {})]) {
    assert.deepEqual(await call(), { ok: false, code: 'account-locked', message: 'The key for Work key could not be read from the Keychain.' });
  }
  assert.equal(fake.spawns.length, 0, 'never on Codex’s own login instead');
  assert.equal(s.active, 0);
  // Readable again: the next call starts it.
  ok = true;
  assert.equal((await s.models()).ok, true);
  assert.equal(fake.spawns.length, 1);
});

test('reset: the process goes now, what was read through it is forgotten, and the next call is a new launch', async () => {
  const fake = createFakeCodex();
  let key = KEY;
  const s = service(fake, { launch: (base) => ({ env: { ...base, CANOPY_OPENAI_API_KEY: key }, config: ON_KEY }) });
  await s.models();
  await s.models();
  assert.deepEqual([fake.spawns.length, fake.sent('model/list').length], [1, 1], 'read once, then from memory');
  // The key was replaced: the process holding the old one is not kept, and neither is what it listed.
  key = `${KEY}-new`;
  const first = fake.children[0];
  await s.reset();
  assert.ok(first.exited, 'reset resolves once the old process is gone');
  assert.equal(s.modelCache, null);
  await s.models();
  assert.deepEqual([fake.spawns.length, fake.sent('model/list').length], [2, 2]);
  assert.equal(fake.spawns[1].options.env.CANOPY_OPENAI_API_KEY, `${KEY}-new`);
  assert.equal(fake.alive().length, 1);
  // With nothing running, and after close, it is still safe to call.
  await s.reset();
  await s.reset();
  assert.equal(fake.alive().length, 0);
  await s.close({ graceMs: 0 });
  await s.reset();
});

test('reset with a call in flight: the call is asked again on the new launch, and answers', async () => {
  const fake = createFakeCodex({ hang: ['model/list'] });
  let key = KEY;
  const s = service(fake, { launch: (base) => ({ env: { ...base, CANOPY_OPENAI_API_KEY: key }, config: ON_KEY }) });
  const asking = s.models({ fresh: true });
  await until(() => fake.sent('model/list').length === 1, 2000, 'the first ask');
  key = `${KEY}-new`;
  fake.hang.delete('model/list');
  await s.reset();
  const r = await asking;
  assert.equal(r.ok, true);
  assert.deepEqual([fake.spawns.length, fake.spawns[1].options.env.CANOPY_OPENAI_API_KEY], [2, `${KEY}-new`]);
});

test('the helper process is shared by count: it lingers after the last call, then goes, and comes back on demand', async () => {
  const fake = createFakeCodex({ hang: ['thread/list'] });
  const s = service(fake, { lingerMs: 200, timeouts: { init: 1000, request: 1000, list: 300, history: 1000 } });
  const slow = s.listThreads();            // held open by the fake
  await s.account();
  assert.equal(s.active, 1, 'one call still in flight');
  await sleep(120);
  assert.equal(fake.last.exited, null, 'a process with a call in flight is never let go');
  assert.equal((await slow).code, 'timeout');
  assert.equal(s.active, 0);
  await sleep(15);
  assert.equal(fake.last.exited, null, 'it lingers for the next call');
  await s.account();                        // a call inside the linger keeps the same process
  assert.equal(fake.spawns.length, 1);
  await until(() => fake.children[0].exited, 1000, 'the idle helper to exit');
  assert.equal((await s.account()).ok, true);
  assert.equal(fake.spawns.length, 2, 'the next call starts a new one');
});

test('a call whose process died under it is tried once more on a new process, and only once', async () => {
  const fake = createFakeCodex();
  let deaths = 1;
  fake.handlers['account/read'] = (params, child) => { if (deaths-- > 0) child.die(1); };
  const s = service(fake);
  assert.equal((await s.account()).ok, true);
  assert.equal(fake.spawns.length, 2);

  deaths = 2;
  const r = await s.account();
  assert.deepEqual([r.ok, r.code], [false, 'not-running']);
  assert.equal(fake.spawns.length, 3, 'one more process, not an endless supply');
  assert.equal((await s.account()).ok, true, 'and the service still works afterwards');
  assert.equal(fake.spawns.length, 4);
});

test('a refusal is not retried, and is reported in plain words', async () => {
  const fake = createFakeCodex({ errors: { 'thread/read': { code: -32600, message: 'thread not loaded: abc' }, 'thread/list': { code: -32000, message: 'index is locked sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' } } });
  const s = service(fake, { redact: (t) => t.replace(/sk-proj-\w+/g, '[redacted]') });
  assert.deepEqual(await s.readThread('abc'), { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' });
  const r = await s.listThreads();
  assert.deepEqual(r, { ok: false, code: 'rejected', message: 'index is locked [redacted]' });
  assert.equal(fake.spawns.length, 1);
  assert.equal(fake.sent('thread/list').length, 1);
});

test('without Codex every call says not-installed and starts nothing; the path is read again each time', async () => {
  const fake = createFakeCodex();
  let installed = null;
  const s = service(fake, { codexPath: () => installed });
  for (const r of [await s.models(), await s.account(), await s.listThreads(), await s.turns('t'), await s.rename('t', 'x'), await s.archive('t'), await s.call('model/list')]) {
    assert.deepEqual([r.ok, r.code], [false, 'not-installed']);
    assert.match(r.message, /Codex was not found/);
  }
  assert.equal(fake.spawns.length, 0);
  assert.equal(s.active, 0);
  installed = '/fake/codex'; // installed while Canopy runs
  assert.equal((await s.account()).ok, true);
  const broken = service(createFakeCodex(), { codexPath: () => { throw new Error('getter bug'); } });
  assert.equal((await broken.account()).code, 'not-installed');
});

test('a launch that fails is reported, not thrown', async () => {
  const s = service(createFakeCodex({ spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }));
  const r = await s.account();
  assert.deepEqual([r.ok, r.code], [false, 'launch-failed']);
  const hung = createFakeCodex({ hang: ['initialize'] });
  const t = service(hung, { timeouts: { init: 40, request: 1000, list: 1000, history: 1000 } });
  assert.equal((await t.account()).code, 'timeout');
  await until(() => hung.children[0].exited, 1000, 'the process that never started to be ended');
});

test('models are cached, and hidden ones are left out unless asked for', async () => {
  const fake = createFakeCodex({ models: [...recordedModels(), { id: 'codex-auto-review', model: 'codex-auto-review', hidden: true }], modelPageSize: 3 });
  const s = service(fake);
  const first = await s.models();
  assert.ok(first.models.length === recordedModels().length && !first.models.some((m) => m.hidden));
  assert.ok(fake.sent('model/list').length >= 3, 'every page was asked for');
  const asked = fake.sent('model/list').length;
  first.models[0].value = 'scribbled';
  const second = await s.models();
  assert.equal(fake.sent('model/list').length, asked, 'the second call is answered from memory');
  assert.equal(second.models[0].value, 'gpt-6.1-sol', 'and a caller cannot scribble on the cache');
  await s.models({ fresh: true });
  assert.ok(fake.sent('model/list').length > asked);
  const all = await s.models({ includeHidden: true });
  assert.ok(all.models.some((m) => m.value === 'codex-auto-review' && m.hidden));
});

test('turns() pages newest first and returns oldest first, every item included', async () => {
  const fake = createFakeCodex();
  fake.turnsOf.chat = [1, 2, 3, 4, 5].map((n) => ({ id: `turn-${n}`, startedAt: 100 + n, status: 'completed', items: [{ type: 'userMessage', id: `u${n}`, content: [] }] }));
  const s = service(fake);
  const r = await s.turns('chat', { pageSize: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.turns.map((t) => t.id), ['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
  assert.equal(r.truncated, false);
  const asked = fake.sent('thread/turns/list').map((m) => m.params);
  assert.equal(asked.length, 3);
  assert.deepEqual(asked[0], { threadId: 'chat', itemsView: 'full', sortDirection: 'desc', limit: 2 });
  assert.deepEqual(asked[1], { threadId: 'chat', itemsView: 'full', sortDirection: 'desc', limit: 2, cursor: '2' });

  const newest = await s.turns('chat', { maxTurns: 3, pageSize: 2 });
  assert.deepEqual(newest.turns.map((t) => t.id), ['turn-3', 'turn-4', 'turn-5'], 'a long chat keeps its newest turns');
  assert.equal(newest.truncated, true);
  assert.deepEqual(await s.turns('gone'), { ok: false, code: 'not-found', message: 'That chat is no longer on disk.' });
});

test('turns() keeps the pages it read when a later one fails, and says the chat is cut short', async () => {
  const fake = createFakeCodex();
  fake.turnsOf.chat = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `turn-${n}`, startedAt: 100 + n, status: 'completed', items: [] }));
  let asked = 0;
  fake.errors['thread/turns/list'] = () => (++asked === 3 ? { message: 'the index is busy' } : null);
  const s = service(fake);
  const r = await s.turns('chat', { pageSize: 2 });
  assert.deepEqual([r.ok, r.truncated, r.turns.map((t) => t.id)], [true, true, ['turn-3', 'turn-4', 'turn-5', 'turn-6']]);

  // A page that never answers costs its time limit once, and the newer turns are still returned.
  const slow = createFakeCodex();
  slow.turnsOf.chat = fake.turnsOf.chat;
  slow.handlers['thread/turns/list'] = () => { slow.hang.add('thread/turns/list'); return undefined; }; // the newest page answers; no later one does
  const t = service(slow, { timeouts: { init: 1000, request: 1000, list: 1000, history: 80 } });
  const cut = await t.turns('chat', { pageSize: 4 });
  assert.deepEqual([cut.ok, cut.truncated, cut.turns.map((x) => x.id)], [true, true, ['turn-3', 'turn-4', 'turn-5', 'turn-6']]);

  // Nothing read at all is still a failure, said plainly.
  const dead = createFakeCodex({ known: ['chat'], hang: ['thread/turns/list'] });
  assert.deepEqual([(await service(dead, { timeouts: { init: 1000, request: 1000, history: 60 } }).turns('chat')).code], ['timeout']);
});

test('readTurns: a page too large to read is asked for again in smaller pages, and time spent caps how far back it goes', async () => {
  const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: `turn-${n}` }));
  const tooLarge = () => Object.assign(new Error('thread/turns/list answered with more than can be read at once'), { code: 'too-large' });
  const pager = (refuse) => {
    const calls = [];
    const ask = async (method, params) => {
      calls.push(params);
      if (refuse(params)) throw tooLarge();
      const newest = all.slice().reverse();
      const from = Number(params.cursor ?? 0);
      const next = from + params.limit;
      return { data: newest.slice(from, next), nextCursor: next < newest.length ? String(next) : null };
    };
    return { ask, calls };
  };
  // Pages of 8 are too much, pages of 2 are fine: every turn still arrives, oldest first.
  const a = pager((p) => p.limit > 2);
  const whole = await readTurns(a.ask, 'chat', { pageSize: 8 });
  assert.deepEqual([whole.truncated, whole.turns.map((t) => t.id)], [false, all.map((t) => t.id)]);
  assert.deepEqual(a.calls.map((p) => p.limit), [8, 2, 2, 2, 2, 2]);
  assert.deepEqual(a.calls.map((p) => p.cursor), [undefined, undefined, '2', '4', '6', '8'], 'the refused page is asked for again from the same place');

  // One turn alone is too large: the newer ones are kept; with nothing read, it is the failure it is.
  const b = pager((p) => Number(p.cursor ?? 0) >= 4);
  const part = await readTurns(b.ask, 'chat', { pageSize: 4 });
  assert.deepEqual([part.truncated, part.turns.map((t) => t.id)], [true, ['turn-7', 'turn-8', 'turn-9', 'turn-10']]);
  assert.deepEqual(b.calls.map((p) => p.limit), [4, 4, 1]);
  assert.equal((await rejected(readTurns(pager(() => true).ask, 'chat', { pageSize: 4 }))).code, 'too-large');

  // Each page takes a while: once the budget is spent no further page is asked for.
  const c = pager(() => false);
  const slowAsk = async (...args) => { await sleep(30); return c.ask(...args); };
  const capped = await readTurns(slowAsk, 'chat', { pageSize: 2, budgetMs: 45 });
  assert.equal(capped.truncated, true);
  assert.equal(c.calls.length, 2, 'the page in flight when time ran out is kept; no third is started');
  assert.deepEqual(capped.turns.map((t) => t.id), ['turn-7', 'turn-8', 'turn-9', 'turn-10']);
  // The newest page is always read, however long it takes.
  const first = await readTurns(slowAsk, 'chat', { pageSize: 10, budgetMs: 1 });
  assert.deepEqual([first.truncated, first.turns.length], [false, 10]);
});

test('rename and archive', async () => {
  const fake = createFakeCodex({ known: ['chat'] });
  const s = service(fake);
  assert.deepEqual(await s.rename('chat', '  A   new\nname  '), { ok: true });
  assert.deepEqual(fake.sent('thread/name/set')[0].params, { threadId: 'chat', name: 'A new name' });
  for (const bad of ['', '   ', null, 7]) assert.equal((await s.rename('chat', bad)).code, 'invalid-input');
  assert.equal(fake.sent('thread/name/set').length, 1);
  assert.deepEqual(await s.archive('chat'), { ok: true, archived: true });
  assert.deepEqual(await s.archive('chat'), { ok: true, archived: false }, 'already put away counts as done');
  assert.deepEqual(await s.archive('never-there'), { ok: true, archived: false });
});

test('the helper answers no to anything Codex asks of it, so nothing hangs', async () => {
  const fake = createFakeCodex();
  const s = service(fake);
  await s.account();
  const q = fake.last.ask('item/commandExecution/requestApproval', { command: 'rm -rf /' });
  const answer = await within(q.answer, 1000, 'the refusal');
  assert.equal(answer.error.code, -32601);
  assert.ok(!('result' in answer), 'it never approves anything');
});

test('close() resolves only once the process is gone, and later calls fail cleanly', async () => {
  const fake = createFakeCodex({ ignoreEof: true });
  const s = service(fake);
  await s.account();
  const child = fake.last;
  const t = Date.now();
  await s.close({ graceMs: 60 });
  assert.ok(child.exited, 'the process has exited by the time close() resolves');
  assert.ok(Date.now() - t >= 50, 'it waited for it');
  assert.deepEqual(child.signals, ['SIGTERM']);
  const r = await s.account();
  assert.deepEqual([r.ok, r.code], [false, 'not-running']);
  assert.equal(fake.spawns.length, 1, 'a closed service starts nothing');
  await s.close(); // twice is fine
});

test('close() with a call in flight ends that call and still waits for the process', async () => {
  const fake = createFakeCodex({ hang: ['thread/list'] });
  const s = service(fake);
  const inFlight = s.listThreads();
  await until(() => fake.sent('thread/list').length === 1);
  await s.close({ graceMs: 0 });
  assert.ok(fake.last.exited);
  assert.equal((await inFlight).ok, false);
});

// ---- what Canopy may ask about an account ----

// A ChatGPT plan's limits as Codex 0.153.4 answers account/rateLimits/read (the shape is its own generated schema's).
const LIMITS = {
  rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1794805200 }, secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1795150800 },
    credits: { hasCredits: false, unlimited: false, balance: null }, individualLimit: null, spendControlReached: null, planType: 'pro', rateLimitReachedType: null },
  rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
};
// Who has them: the fake answers the call for a ChatGPT login only, as Codex does.
const ON_A_PLAN = { account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' }, rateLimits: LIMITS.rateLimits };

test('the helper reads a plan’s limits whole, and a login without a plan is a plain no', async () => {
  const fake = createFakeCodex(ON_A_PLAN);
  const s = service(fake);
  assert.deepEqual(await s.rateLimits(), { ok: true, limits: LIMITS });
  assert.deepEqual(fake.sent('account/rateLimits/read'), [{ id: 2, method: 'account/rateLimits/read' }], 'asked with no parameters, once');
  fake.account = { type: 'apiKey' };
  const r = await s.rateLimits();
  assert.deepEqual([r.ok, r.code], [false, 'rejected']);
  assert.equal(fake.spawns.length, 1, 'a refusal is an answer: the process is kept and nothing is retried');
  const away = service(createFakeCodex(), { codexPath: null });
  assert.deepEqual([(await away.rateLimits()).ok, (await away.rateLimits()).code], [false, 'not-installed']);
});

test('only five account calls ever leave for Codex: who is signed in, how much of the plan is used, and Codex’s own sign-in and sign-out', async () => {
  // One list, and one gate where every request leaves (the sign-in half of it is codex-account.test.mjs).
  assert.deepEqual([...ACCOUNT_CALLS].sort(), ['account/login/cancel', 'account/login/start', 'account/logout', 'account/rateLimits/read', 'account/read']);
  assert.ok(Object.isFrozen(ACCOUNT_CALLS));
  const fake = createFakeCodex(ON_A_PLAN);
  const p = proc(fake).start();
  await p.ready;
  // Everything else under account/ is refused before a byte is written: these spend a user's credits or send mail
  // in their name. Spelled in pieces so this file is not itself a mention of them.
  const NEVER = ['rateLimit' + 'ResetCredit/consume', 'sendAdd' + 'CreditsNudgeEmail', 'usage/read', 'workspaceMessages/read', 'somethingNew'].map((m) => `account/${m}`);
  for (const method of NEVER) {
    const err = await rejected(p.request(method, {}));
    assert.equal(err.code, 'not-allowed', method);
    assert.match(err.message, /^Canopy does not ask Codex for account\//);
  }
  // A sign-in is Codex's own browser sign-in or nothing: with a key, a token or anything beside its one field, it
  // is refused like a call Canopy does not make.
  for (const params of [undefined, {}, { type: 'apiKey', apiKey: 'sk-not-a-real-key' }, { type: 'chatgptAuthTokens' }, { type: 'chatgpt', more: 1 }]) {
    assert.equal((await rejected(p.request('account/login/start', params))).code, 'not-allowed', JSON.stringify(params));
  }
  const s = service(fake);
  // The helper's generic call can make none of them, and cannot sign anyone in or out either: the three calls
  // that change the login have methods of their own, which hold what they start.
  for (const method of [...NEVER, 'account/login/start', 'account/login/cancel', 'account/logout']) {
    const r = await s.call(method, method === 'account/login/start' ? { type: 'chatgpt' } : {});
    assert.deepEqual([r.ok, r.code], [false, 'not-allowed'], `${method} through the helper`);
  }
  assert.deepEqual(fake.received.map((m) => m.method).filter((m) => m?.startsWith('account/')), [], 'none of them was sent');
  assert.equal(fake.spawns.length, 1, 'the helper did not even start a process for them');
  // The two that only read go through, as the Usage tab makes them (the helper's generic call included), and other
  // namespaces are not this rule's business.
  assert.deepEqual((await s.call('account/rateLimits/read')).result, LIMITS);
  assert.equal((await p.request('account/read', { refreshToken: false })).requiresOpenaiAuth, true);
  assert.deepEqual(await p.request('account/rateLimits/read'), LIMITS);
  assert.ok(Array.isArray((await p.request('model/list', { includeHidden: false })).data));
});

// ---- one-off questions (chat names for Codex chats, src/codex-titles.mjs) ----

test('suggestTitle asks in a throwaway, read-only thread at standard speed, with Codex\'s extras left out', async () => {
  const fake = createFakeCodex({ reply: 'Fix Safari login loop' });
  const s = service(fake);
  const r = await s.suggestTitle('Name this: fix the login loop', { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(r, { ok: true, title: 'Fix Safari login loop' });
  const start = fake.sent('thread/start')[0].params;
  assert.equal(start.ephemeral, true, 'nothing is saved in Codex');
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.serviceTier, null, 'standard speed, whatever the user\'s own tier');
  assert.equal(start.model, 'gpt-6-luna');
  assert.ok(start.baseInstructions && start.baseInstructions.length < 200, 'Codex\'s long instructions are replaced');
  assert.deepEqual(start.config.mcp_servers, {});
  assert.equal(start.config.features.skills, false);
  const turn = fake.sent('turn/start')[0].params;
  assert.equal(turn.serviceTier, null);
  assert.equal(turn.effort, 'low');
  assert.equal(turn.input[0].text, 'Name this: fix the login loop');
});

test('suggestTitle with nothing to name asks nothing; a failed turn is an error, not a title', async () => {
  const fake = createFakeCodex();
  const s = service(fake);
  assert.equal((await s.suggestTitle('  ')).ok, false);
  assert.equal(fake.spawns.length, 0);
  fake.reply = '';
  const r = await s.suggestTitle('Name this');
  assert.equal(r.ok, false);
  assert.equal(s.oneOffs.size, 0, 'nothing left waiting');
});

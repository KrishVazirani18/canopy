// Code Mode: the sandbox runner (real child processes, started by this node), what scripts and the model get
// back, the helpers one Claude Code process answers (against a fake control channel), and Session's side of it
// (the toggle, the gate, permission prompts for a script's calls) against the scripted fake of the SDK.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake, CAPABILITIES } from '../fake-query.mjs';
import { core, sleep, watch, within } from '../helpers.mjs';

const M = await core('code-mode.mjs');
const R = await core('code-runner.mjs');
const S = await core('session.mjs');
const missing = M.__missing ? `code-mode.mjs: ${M.__missing}` : R.__missing ? `code-runner.mjs: ${R.__missing}` : M.CODE_MISSING ? `Code Mode cannot load: ${M.CODE_MISSING}` : false;
const noSession = missing || (S.__missing ? `session.mjs: ${S.__missing}` : false);
// Without sandbox-exec (not macOS) the runner falls back to Node's permission model alone, which leaves the network open.
const noSeatbelt = missing || (fs.existsSync('/usr/bin/sandbox-exec') ? false : 'sandbox-exec is not on this machine');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-code-')));
const work = path.join(root, 'work');
const other = path.join(root, 'other');
const outside = path.join(root, 'outside');
const home = path.join(root, 'home');
for (const d of [path.join(work, 'src/deep'), path.join(work, 'node_modules/pkg'), path.join(work, '.git'), other, outside, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, 'notes.txt'), 'first line\nthe needle is here\n');
fs.writeFileSync(path.join(work, 'denied.txt'), 'x');
fs.writeFileSync(path.join(work, 'src/a.ts'), 'export const needle = 1;\n');
fs.writeFileSync(path.join(work, 'src/deep/b.ts'), 'export const hay = 2;\n');
fs.writeFileSync(path.join(work, 'node_modules/pkg/index.js'), 'needle\n');
fs.writeFileSync(path.join(work, '.git/config'), 'needle\n');
fs.writeFileSync(path.join(other, 'extra.md'), '# extra\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const text = (result) => result.content[0].text;
const run = (code, o = {}) => within(M.runScript({ code, handle: async () => null, ...o }), 20000, 'the script');

// ---- what comes back ----

test('an MCP result becomes the value a script wants', { skip: missing }, () => {
  const shape = M.shapeMcpResult;
  assert.deepEqual(shape({ content: [{ type: 'text', text: 'echo:A' }], structuredContent: { echoed: 'A' } }), { echoed: 'A' }, 'structured content wins');
  assert.deepEqual(shape({ content: [{ type: 'text', text: ' {"items":[1,2]} ' }] }), { items: [1, 2] }, 'one text block of JSON is parsed');
  assert.deepEqual(shape({ content: [{ type: 'text', text: '[1,2]' }] }), [1, 2]);
  assert.equal(shape({ content: [{ type: 'text', text: 'slept:5' }] }), 'slept:5', 'plain text stays text');
  assert.equal(shape({ content: [{ type: 'text', text: '{not json' }] }), '{not json');
  assert.equal(shape({ content: [{ type: 'text', text: '42' }] }), '42', 'a bare number is not guessed at');
  assert.equal(shape({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.deepEqual(shape({ content: [{ type: 'text', text: 'see image' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }),
    { text: 'see image', other: [{ type: 'image', mimeType: 'image/png' }] }, 'image bytes are named, not carried');
  assert.equal(shape({ content: '{"a":1}' }).a, 1, 'a legacy string result');
  assert.equal(shape({ content: [] }), '');
  assert.equal(shape(null), null);
});

test('the model gets logs, then the result, and is told exactly what was cut', { skip: missing }, () => {
  const fmt = M.formatOutcome;
  assert.equal(fmt({ ok: true, out: '{"n":1}', length: 7, logs: '', ms: 1234 }, { calls: 3 }), '{"n":1}\n\n(3 tool calls, 1.2s)');
  assert.equal(fmt({ ok: true, out: '"x"', length: 3, logs: 'step 1\nstep 2\n', ms: 40 }, { calls: 1 }), 'Logs:\nstep 1\nstep 2\n\nResult:\n"x"\n\n(1 tool call, 40ms)');
  assert.match(fmt({ ok: true, out: null, length: 0, logs: '', ms: 5 }), /^The script returned nothing\. `return` a value/);

  const big = fmt({ ok: true, out: 'x'.repeat(60_000), length: 60_000, logs: '', ms: 5 });
  assert.match(big, /\[Result truncated: showing the first 20,000 of 60,000 characters\. Return less from the script/);
  assert.ok(big.length < M.OUTPUT_LIMIT + 300, `capped near the limit, got ${big.length}`);
  // The runner already cut what it sent: the note still gives the real size.
  assert.match(fmt({ ok: true, out: 'x'.repeat(30_000), length: 900_000, logs: '', ms: 5 }), /first 20,000 of 900,000 characters/);

  const noisy = fmt({ ok: true, out: '1', length: 1, logs: `start\n${'log line\n'.repeat(5000)}the end`, ms: 5 });
  assert.match(noisy, /^Logs:\nstart\n/);
  assert.match(noisy, /characters of logs not shown …\]/);
  assert.match(noisy, /the end\n\nResult:\n1\n/);
  assert.ok(noisy.length < 6000);
});

test('a failure names the line and shows it', { skip: missing }, () => {
  const code = 'const a = 1;\n  const b = a.missing.deeper;\nreturn b;';
  const out = M.formatOutcome({ ok: false, reason: 'error', error: "TypeError: Cannot read properties of undefined (reading 'deeper')", line: 2, logs: 'got this far\n', ms: 9 }, { code, calls: 0 });
  assert.equal(out, "The script failed at line 2: TypeError: Cannot read properties of undefined (reading 'deeper')\n> 2 | const b = a.missing.deeper;\n\nLogs:\ngot this far\n\n(0 tool calls, 9ms)");
  assert.match(M.formatOutcome({ ok: false, reason: 'error', error: 'Error: x', line: null, logs: '', ms: 1 }), /^The script failed: Error: x\n/);
  assert.match(M.formatOutcome({ ok: false, reason: 'timeout', error: 'The script ran past the 10 minute limit and was stopped.', line: null, logs: '', ms: 1 }), /^The script ran past/);
});

test('globs', { skip: missing }, () => {
  const hit = (glob, p) => R.globToRegExp(glob).test(p);
  assert.ok(hit('src/**/*.ts', 'src/a.ts'));
  assert.ok(hit('src/**/*.ts', 'src/deep/er/b.ts'));
  assert.ok(!hit('src/**/*.ts', 'lib/a.ts'));
  assert.ok(!hit('src/*.ts', 'src/deep/b.ts'), 'one star stays in its folder');
  assert.ok(hit('**/*.{ts,tsx}', 'a/b/c.tsx'));
  assert.ok(hit('**/*.{ts,tsx}', 'c.ts'));
  assert.ok(!hit('**/*.{ts,tsx}', 'c.tsx.bak'));
  assert.ok(hit('file?.[jt]s', 'file1.js'));
  assert.ok(!hit('file?.[!j]s', 'file1.js'));
  assert.ok(hit('./notes.txt', 'notes.txt'));
  assert.ok(!hit('a.b', 'aXb'), 'a dot is a dot');
  assert.ok(hit('docs/**', 'docs/x/y.md'));
});

// ---- the sandbox ----

test('a script runs, awaits its helpers, logs, and returns a value', { skip: missing }, async () => {
  const calls = [];
  const r = await run(`
    const a = await mcp('mcp__e__echo', { text: 'A' });
    console.log('got', a, 1, null);
    print('second line');
    await sleep(5);
    return { a, typeofs: [typeof process, typeof require, typeof fetch] };`, {
    handle: async (op, args, ctx) => { calls.push([op, args, ctx.quiet]); return { echoed: args.args.text }; },
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(r.out), { a: { echoed: 'A' }, typeofs: ['undefined', 'undefined', 'function'] });
  assert.equal(r.logs, 'got {"echoed":"A"} 1 null\nsecond line\n');
  assert.deepEqual(calls, [['mcp', { tool: 'mcp__e__echo', args: { text: 'A' } }, false]]);
  assert.equal(r.length, r.out.length);
});

test('what a script returns: strings as they are, values as JSON, nothing as nothing', { skip: missing }, async () => {
  assert.equal((await run("return 'plain text'")).out, 'plain text');
  assert.equal((await run('return new Map([["k", new Set([1n])]])')).out, '{"k":["1"]}');
  assert.equal((await run('const o = {}; o.self = o; return o')).out, '[object Object]', 'a value JSON cannot hold does not sink the run');
  assert.deepEqual([(await run('1 + 1')).out, (await run('return undefined')).out], [null, null]);
  const big = await run("return 'x'.repeat(900000)");
  assert.deepEqual([big.out.length, big.length], [400000, 900000], 'the runner bounds what it sends and says how much there was');
});

test('errors carry the script line: thrown, syntax, a failed helper, a call nobody awaited', { skip: missing }, async () => {
  const thrown = await run('const a = 1;\nnull.x;\nreturn a;');
  assert.deepEqual([thrown.ok, thrown.reason, thrown.line], [false, 'error', 2]);
  assert.match(thrown.error, /^TypeError: Cannot read properties of null/);

  const syntax = await run('const a = 1;\n\nlet b = ;');
  assert.deepEqual([syntax.reason, syntax.line], ['error', 3]);
  assert.match(syntax.error, /^SyntaxError: /);

  const handle = async () => { throw new Error('The tool did not run: no'); };
  const helper = await run("const ok = 1;\n\n\nawait mcp('mcp__e__boom', {});", { handle });
  assert.deepEqual([helper.reason, helper.line, helper.error], ['error', 4, 'Error: The tool did not run: no'], 'the error points at the call, not at the runner');

  const caught = await run("try { await mcp('mcp__e__boom', {}); } catch (e) { return 'caught: ' + e.message; }", { handle });
  assert.equal(caught.out, 'caught: The tool did not run: no');

  const floating = await run("mcp('mcp__e__boom', {});\nawait sleep(200);\nreturn 1;", { handle });
  assert.deepEqual([floating.ok, floating.line], [false, 1]);
  assert.match(floating.error, /nothing awaiting it/);

  const custom = await run("throw 'just a string'");
  assert.equal(custom.error, 'Thrown: just a string');
});

test('the sandbox has no files, no processes and no way to load code', { skip: missing }, async () => {
  const r = await run(`
    const tries = {};
    const attempt = async (name, fn) => { try { await fn(); tries[name] = 'ALLOWED'; } catch (e) { tries[name] = e.code || e.name; } };
    await attempt('import', () => import('node:fs'));
    await attempt('builtin', () => globalThis.process.getBuiltinModule('node:fs').readFileSync('/etc/hosts'));
    await attempt('write', () => globalThis.process.getBuiltinModule('node:fs').writeFileSync('/tmp/canopy-code-mode-escape', 'x'));
    await attempt('spawn', () => globalThis.process.getBuiltinModule('node:child_process').execSync('echo hi'));
    await attempt('worker', () => new (globalThis.process.getBuiltinModule('node:worker_threads').Worker)('1', { eval: true }));
    // node:sqlite opens files without asking the permission model, so it is not there at all.
    await attempt('sqlite', () => new (globalThis.process.getBuiltinModule('node:sqlite').DatabaseSync)(${JSON.stringify(path.join(outside, 'secret.txt'))}, { readOnly: true }));
    // PWD and SHLVL are the launching shell's own (see runScript), not the host's.
    return { tries, sqlite: typeof globalThis.process.getBuiltinModule('node:sqlite'), env: Object.keys(globalThis.process.env).filter((k) => !k.startsWith('__CF') && !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(k)).sort() };`);
  assert.equal(r.ok, true, r.error);
  const { tries, sqlite, env } = JSON.parse(r.out);
  assert.deepEqual(tries, { import: 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', builtin: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED', sqlite: 'TypeError' });
  assert.equal(sqlite, 'undefined');
  assert.deepEqual(env, ['CANOPY_CODE_RUNNER', 'ELECTRON_RUN_AS_NODE'], 'none of the host environment is inherited');
});

// The kernel's own wall, tried without Node's: a program with every Node permission still reads nothing of the user's.
test('the seatbelt alone keeps the runner out of the user\'s files', { skip: noSeatbelt }, () => {
  const probe = `
    const fs = require('node:fs');
    const out = {};
    const attempt = (name, fn) => { try { fn(); out[name] = 'ALLOWED'; } catch (e) { out[name] = e.code; } };
    attempt('file', () => fs.readFileSync(${JSON.stringify(path.join(outside, 'secret.txt'))}));
    attempt('folder', () => fs.readdirSync(${JSON.stringify(os.homedir())}));
    attempt('sqlite', () => new (require('node:sqlite').DatabaseSync)(${JSON.stringify(path.join(outside, 'secret.txt'))}, { readOnly: true }));
    attempt('write', () => fs.writeFileSync(${JSON.stringify(path.join(outside, 'written.txt'))}, 'x'));
    console.log(JSON.stringify(out));`;
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', M.sandboxProfile(process.execPath), process.execPath, '--disable-warning=ExperimentalWarning', '-e', probe], { encoding: 'utf8', env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { file: 'EPERM', folder: 'EPERM', sqlite: 'ERR_SQLITE_ERROR', write: 'EPERM' });
  // The one folder a runner inside the app may read besides macOS is the app's own bundle.
  assert.match(M.sandboxProfile('/Applications/Canopy.app/Contents/MacOS/Canopy'), /\(deny file-read-data\)\(allow file-read-data .*\(subpath "\/Applications\/Canopy\.app"\)\)$/);
});

test('the sandbox has no network and cannot signal other processes', { skip: noSeatbelt }, async () => {
  const r = await run(`
    const tries = {};
    try { await fetch('https://example.com'); tries.fetch = 'ALLOWED'; } catch (e) { tries.fetch = e.message; }
    try { globalThis.process.kill(${process.pid}, 0); tries.kill = 'ALLOWED'; } catch (e) { tries.kill = e.code; }
    return tries;`);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(r.out), { fetch: 'fetch failed', kill: 'EPERM' });
});

test('a script that never ends is stopped at the time limit, with its logs so far', { skip: missing }, async () => {
  // The limit runs from the call, the sandbox's start included: a busy Mac needs room to reach the script's first line.
  const started = Date.now();
  const r = await run("print('before the loop');\nwhile (true) {}", { timeoutMs: 2000 });
  assert.deepEqual([r.ok, r.reason], [false, 'timeout']);
  assert.match(r.error, /ran past the 2 second limit and was stopped/);
  assert.equal(r.logs, 'before the loop\n');
  assert.ok(Date.now() - started < 5000);

  // Time spent waiting for the user to answer a prompt is not the script's.
  const patient = await run("await sleep(900);\nreturn 'made it';", { timeoutMs: 500, waited: () => 5000 });
  assert.deepEqual([patient.ok, patient.out], [true, 'made it']);
});

// The host's timer dies with the host. This limit is the kernel's, so a spinning script cannot outlive a crashed Canopy.
test('the kernel ends a script that burns more processor time than a run may', { skip: missing || !fs.existsSync('/bin/sh') }, async () => {
  const r = await run('while (true) {}', { cpuSeconds: 1 });
  assert.deepEqual([r.ok, r.reason], [false, 'timeout']);
  assert.match(r.error, /more processor time than a run is allowed/);
  const idle = await run("await sleep(1500);\nreturn 'waiting costs nothing';", { cpuSeconds: 1 });
  assert.deepEqual([idle.ok, idle.out], [true, 'waiting costs nothing']);
});

test('stopping kills the sandbox at once and tells the helpers in flight', { skip: missing }, async () => {
  const ac = new AbortController();
  let helperSignal = null;
  let afterStop = 0;
  const p = run("await mcp('mcp__e__slow', {});\nawait mcp('mcp__e__second', {});\nreturn 'finished';", {
    signal: ac.signal,
    handle: (op, args, ctx) => {
      if (args.tool === 'mcp__e__second') afterStop += 1;
      helperSignal = ctx.signal;
      return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('late')));
    },
  });
  while (!helperSignal) await sleep(10);
  const started = Date.now();
  ac.abort();
  const r = await p;
  assert.deepEqual([r.ok, r.reason, r.error], [false, 'aborted', 'The script was stopped before it finished.']);
  assert.equal(helperSignal.aborted, true, 'the helper is told the run is over, so it can withdraw its call');
  assert.ok(Date.now() - started < 1000);
  await sleep(100);
  assert.equal(afterStop, 0, 'the script did not go on to its next call');

  const already = new AbortController();
  already.abort();
  assert.equal((await run('return 1', { signal: already.signal })).reason, 'aborted');
});

test('a sandbox that cannot start is reported, not thrown', { skip: missing }, async () => {
  const r = await run('return 1', { execPath: path.join(root, 'no-such-binary'), sandboxExec: false });
  assert.deepEqual([r.ok, r.reason], [false, 'crashed']);
  assert.match(r.error, /^The sandbox could not start[ :]/);
});

// ---- the helpers one Claude Code process answers ----

// A control channel that answers from a table: tool name -> response, an Error (an error answer), or a function.
function fakeChannel(tools = {}) {
  const sent = [];
  const cancelled = [];
  const waiting = new Map();
  let n = 0;
  return {
    sent, cancelled, open: true,
    request(request) {
      const id = `canopy-test-${++n}`;
      sent.push({ id, ...request });
      const answer = new Promise((resolve) => {
        waiting.set(id, resolve);
        const t = tools[request.tool];
        if (t === 'hang') return;
        const v = typeof t === 'function' ? t(request.arguments) : t;
        setTimeout(() => resolve(v instanceof Error ? { ok: false, error: v.message } : { ok: true, response: v ?? { content: [{ type: 'text', text: 'ok' }] } }), 5);
      });
      return { id, answer };
    },
    cancel(id) { cancelled.push(id); waiting.get(id)?.({ ok: false, error: 'mcp_call cancelled by client: x' }); },
  };
}

function runs(tools, o = {}) {
  const channel = fakeChannel(tools);
  const events = [];
  const reads = [];
  const code = new M.CodeRuns({
    channel, roots: () => [work, other], emit: (ev) => events.push(ev),
    readFile: async (p, opts) => { reads.push([p, opts]); try { return { contents: fs.readFileSync(p, 'utf8') }; } catch { return null; } },
    ...o,
  });
  const exec = (script, extra) => within(code.run({ description: 'test', code: script }, { _meta: { 'claudecode/toolUseId': 'toolu_run1' }, ...extra }), 20000, 'the run');
  const rows = () => {
    const byId = new Map();
    for (const ev of events) byId.set(ev.id, { ...byId.get(ev.id), ...ev });
    return [...byId.values()];
  };
  return { channel, events, reads, code, exec, rows };
}

test('mcp() is an mcp_call that Claude Code checks like the model\'s own, and each call is reported', { skip: missing }, async () => {
  const { channel, events, exec, code } = runs({ mcp__gmail__search: { content: [{ type: 'text', text: '{"threads":[{"id":"t1"},{"id":"t2"}]}' }] }, mcp__gmail__get: (a) => ({ structuredContent: { id: a.id, subject: `S-${a.id}` } }) });
  const r = await exec(`
    const list = await mcp('mcp__gmail__search', { query: 'invoice' });
    const threads = await Promise.all(list.threads.map((t) => mcp('mcp__gmail__get', { id: t.id })));
    return threads.map((t) => t.subject);`);
  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /^\["S-t1","S-t2"\]\n\n\(3 tool calls, /);
  assert.deepEqual(channel.sent.map(({ id, ...req }) => req), [
    { subtype: 'mcp_call', tool: 'mcp__gmail__search', arguments: { query: 'invoice' }, check_permissions: true, result_not_for_model: true },
    { subtype: 'mcp_call', tool: 'mcp__gmail__get', arguments: { id: 't1' }, check_permissions: true, result_not_for_model: true },
    { subtype: 'mcp_call', tool: 'mcp__gmail__get', arguments: { id: 't2' }, check_permissions: true, result_not_for_model: true },
  ]);
  assert.ok(events.every((ev) => ev.kind === 'code-call' && ev.run === 'toolu_run1'), 'every row names the transcript call it belongs to');
  assert.deepEqual(events.filter((ev) => ev.name).map((ev) => [ev.id, ev.name, ev.input, ev.status]), [
    [1, 'mcp__gmail__search', { query: 'invoice' }, 'running'], [2, 'mcp__gmail__get', { id: 't1' }, 'running'], [3, 'mcp__gmail__get', { id: 't2' }, 'running'],
  ]);
  const ends = events.filter((ev) => !ev.name);
  assert.deepEqual(ends.map((ev) => ev.status), ['ok', 'ok', 'ok']);
  assert.ok(ends.every((ev) => typeof ev.ms === 'number'));
  assert.equal(code.size, 0);
});

test('a refused call throws in the script with Claude Code\'s words, and shows as denied', { skip: missing }, async () => {
  const { exec, rows } = runs({
    mcp__x__blocked: new Error('The tool did not run: The user denied this action.'), mcp__x__broken: new Error('kaboom'),
    mcp__x__planned: new Error('The tool did not run: Permission for this tool use was denied: it requires interactive approval. Cannot call mcp__x__planned while in plan mode.'),
    mcp__x__typo: new Error('The tool did not run: this session has no such tool on that server.'),
  });
  const r = await exec(`
    const out = {};
    for (const t of ['mcp__x__blocked', 'mcp__x__broken', 'mcp__x__planned', 'mcp__x__typo']) { try { await mcp(t); } catch (e) { out[t] = e.message; } }
    return [out.mcp__x__blocked, out.mcp__x__broken];`);
  assert.deepEqual(JSON.parse(text(r).split('\n\n')[0]), ['The tool did not run: The user denied this action.', 'kaboom']);
  // Denied is somebody's decision. A tool that is not there is the script's mistake, and shows as a failure.
  assert.deepEqual(rows().map((row) => [row.name, row.status, row.error.slice(0, 50)]), [
    ['mcp__x__blocked', 'denied', 'The tool did not run: The user denied this action.'], ['mcp__x__broken', 'error', 'kaboom'],
    ['mcp__x__planned', 'denied', 'The tool did not run: Permission for this tool use'], ['mcp__x__typo', 'error', 'The tool did not run: this session has no such too'],
  ]);

  const uncaught = await runs({ mcp__x__blocked: new Error('The tool did not run: plan mode') }).exec("const a = 1;\nawait mcp('mcp__x__blocked');");
  assert.equal(uncaught.isError, true);
  assert.match(text(uncaught), /^The script failed at line 2: Error: The tool did not run: plan mode\n> 2 \| await mcp\('mcp__x__blocked'\);/);
});

test('only MCP tools can be called, and never Code Mode itself', { skip: missing }, async () => {
  const { channel, exec } = runs({});
  const r = await exec(`
    const out = [];
    for (const t of ['Read', 'Bash', 'mcp__nope', '${M.CODE_TOOL}', undefined]) { try { await mcp(t, {}); } catch (e) { out.push(e.message); } }
    return out;`);
  const out = JSON.parse(text(r).split('\n\n')[0]);
  assert.match(out[0], /^mcp\(\) takes a full MCP tool name like mcp__server__tool, not "Read"\. Built-in tools/);
  assert.match(out[1], /not "Bash"/);
  assert.match(out[2], /not "mcp__nope"/);
  assert.equal(out[3], 'A script cannot start another script.');
  assert.match(out[4], /not null/);
  assert.equal(channel.sent.length, 0, 'nothing was sent to Claude Code');
});

test('a tool the host says must be called directly is refused with the host\'s words, before anything is sent', { skip: missing }, async () => {
  const { channel, exec, rows } = runs({}, { direct: (tool) => (tool === 'mcp__canopy_look__look' ? 'Call look yourself.' : null) });
  const r = await exec(`
    let said;
    try { await mcp('mcp__canopy_look__look', { url: 'localhost:3000' }); } catch (e) { said = e.message; }
    return { said, other: await mcp('mcp__x__fine', {}) };`);
  assert.deepEqual(JSON.parse(text(r).split('\n\n')[0]), { said: 'Call look yourself.', other: 'ok' });
  assert.deepEqual(channel.sent.map((c) => c.tool), ['mcp__x__fine'], 'the refused call never reached Claude Code');
  assert.deepEqual(rows().map((c) => c.name).filter(Boolean), ['mcp__x__fine'], 'and shows no step of its own');
});

test('stopping a run withdraws its calls in flight and refuses new ones', { skip: missing }, async () => {
  const { channel, exec, rows, code } = runs({ mcp__x__slow: 'hang' });
  const ac = new AbortController();
  const p = exec("await Promise.all([mcp('mcp__x__slow', { n: 1 }), mcp('mcp__x__slow', { n: 2 })]);\nreturn 'finished';", { signal: ac.signal });
  while (channel.sent.length < 2) await sleep(10);
  assert.equal(code.size, 1);
  ac.abort();
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(text(r), /^The script was stopped before it finished\./);
  assert.deepEqual(channel.cancelled.sort(), channel.sent.map((s) => s.id).sort(), 'a control_cancel_request for each call in flight');
  assert.deepEqual(rows().map((row) => [row.status, row.error]), [['error', 'Stopped'], ['error', 'Stopped']]);

  // stopAll is what the session calls when Stop is pressed or the process goes away.
  const again = runs({ mcp__x__slow: 'hang' });
  const q = again.exec("await mcp('mcp__x__slow');");
  while (again.channel.sent.length < 1) await sleep(10);
  again.code.stopAll();
  assert.match(text(await q), /stopped before it finished/);
  assert.equal(again.channel.cancelled.length, 1);
});

test('a script cannot flood Claude Code: calls run a few at a time and stop at a ceiling', { skip: missing }, async () => {
  let active = 0;
  let peak = 0;
  const channel = fakeChannel({});
  channel.request = (request) => {
    active += 1; peak = Math.max(peak, active);
    return { id: `id-${request.arguments.i}`, answer: sleep(2).then(() => { active -= 1; return { ok: true, response: { structuredContent: request.arguments.i } }; }) };
  };
  const { exec, events } = runs({}, { channel });
  const r = await exec(`
    const done = await Promise.allSettled(Array.from({ length: 520 }, (_, i) => mcp('mcp__x__n', { i })));
    const failed = done.filter((d) => d.status === 'rejected');
    return { ok: done.length - failed.length, failed: failed.length, why: failed[0].reason.message };`);
  const out = JSON.parse(text(r).split('\n\n')[0]);
  assert.deepEqual([out.ok, out.failed], [500, 20]);
  assert.match(out.why, /has made 500 tool calls, and more are refused/);
  assert.ok(peak <= 8, `at most 8 at once, saw ${peak}`);
  assert.equal(events.filter((ev) => ev.name).length, 300, 'the UI is not handed more rows than it can show');
});

test('a prompt for a script\'s call is matched to the oldest unasked call of that tool and input', { skip: missing }, async () => {
  const { channel, exec, events, code } = runs({ mcp__x__send: 'hang' });
  const ac = new AbortController();
  const p = exec("await Promise.all([mcp('mcp__x__send', { to: 'a' }), mcp('mcp__x__send', { to: 'b' }), mcp('mcp__x__send', { to: 'a' })]);", { signal: ac.signal });
  while (channel.sent.length < 3) await sleep(10);
  assert.equal(code.claim('mcp__x__other', {}), null);
  const first = code.claim('mcp__x__send', { to: 'a' });
  const second = code.claim('mcp__x__send', { to: 'a' });
  const third = code.claim('mcp__x__send', { to: 'rewritten by a hook' });
  assert.deepEqual([first.run, first.id, second.id, third.id], ['toolu_run1', 1, 3, 2]);
  assert.equal(code.claim('mcp__x__send', { to: 'a' }), null, 'every call has its prompt');
  code.waiting(first, true);
  code.waiting(first, false);
  assert.deepEqual(events.slice(-2).map((ev) => [ev.id, ev.status]), [[1, 'approval'], [1, 'running']]);
  ac.abort();
  await p;
  const mark = events.length;
  code.waiting(first, true);
  assert.equal(events.length, mark, 'a call that is over is not reopened');
});

test('read() goes through Claude Code\'s Read rules and stays inside the project folders', { skip: missing }, async () => {
  const { exec, reads, rows } = runs({}, {
    readFile: async (p, opts) => { reads.push([p, opts]); return p.endsWith('denied.txt') ? null : { contents: fs.readFileSync(p, 'utf8') }; },
  });
  const r = await exec(`
    const out = {};
    const attempt = async (name, p) => { try { out[name] = await read(p); } catch (e) { out[name] = 'ERR ' + e.message; } };
    await attempt('rel', 'notes.txt');
    await attempt('abs', ${JSON.stringify(path.join(other, 'extra.md'))});
    await attempt('outside', ${JSON.stringify(path.join(outside, 'secret.txt'))});
    await attempt('dotdot', '../outside/secret.txt');
    await attempt('link', 'link.txt');
    await attempt('missing', 'nope.txt');
    await attempt('denied', 'denied.txt');
    return out;`);
  const out = JSON.parse(text(r).split('\n\n')[0]);
  assert.equal(out.rel, 'first line\nthe needle is here\n');
  assert.equal(out.abs, '# extra\n', 'an added folder can be read');
  assert.match(out.outside, /^ERR .*is outside this project/);
  assert.match(out.dotdot, /is outside this project/);
  assert.match(out.link, /is outside this project/, 'a symlink out of the project is not followed');
  assert.equal(out.missing, 'ERR No such file or folder: nope.txt');
  assert.match(out.denied, /^ERR Could not read denied\.txt: .*not allowed/);
  assert.deepEqual(reads.map(([p]) => path.relative(root, p)), ['work/notes.txt', 'other/extra.md', 'work/denied.txt'], 'nothing outside reached Claude Code');
  assert.deepEqual(reads[0][1], { maxBytes: 1024 * 1024 });
  assert.deepEqual(rows().map((row) => [row.name, row.input.file_path, row.status]).slice(0, 3), [['Read', 'notes.txt', 'ok'], ['Read', path.join(other, 'extra.md'), 'ok'], ['Read', path.join(outside, 'secret.txt'), 'error']]);
});

test('glob() and grep() see the project, skip node_modules and .git, and show as one row each', { skip: missing }, async () => {
  const { exec, rows, reads } = runs({});
  const r = await exec(`
    return {
      ts: await glob('src/**/*.ts'),
      any: await glob('*.ts'),
      inSrc: await glob('*.ts', { path: 'src/deep' }),
      added: await glob('**/*', { path: ${JSON.stringify(other)} }),
      all: await glob('**/*'),
      hits: await grep('needle'),
      onlyTs: await grep(/NEEDLE/i, { glob: '*.ts' }),
      limited: (await grep('e', { limit: 1 })).length,
    };`);
  assert.equal(r.isError, undefined, text(r));
  const out = JSON.parse(text(r).split('\n\n')[0]);
  assert.deepEqual(out.ts, ['src/a.ts', 'src/deep/b.ts']);
  assert.deepEqual(out.any, ['src/a.ts', 'src/deep/b.ts'], 'a bare pattern matches at any depth');
  assert.deepEqual(out.inSrc, ['src/deep/b.ts'], 'paths come back ready for read()');
  assert.deepEqual(out.added, [path.join(other, 'extra.md')]);
  assert.deepEqual(out.all, ['denied.txt', 'notes.txt', 'src/a.ts', 'src/deep/b.ts'], 'no node_modules, no .git, no symlinks');
  assert.deepEqual(out.hits, [{ file: 'notes.txt', line: 2, text: 'the needle is here' }, { file: 'src/a.ts', line: 1, text: 'export const needle = 1;' }]);
  assert.deepEqual(out.onlyTs, [{ file: 'src/a.ts', line: 1, text: 'export const needle = 1;' }]);
  assert.equal(out.limited, 1);
  assert.ok(reads.length > 0 && reads.every(([p]) => p.startsWith(work)), 'grep reads through Claude Code, like read()');
  assert.deepEqual(rows().map((row) => [row.name, row.input.pattern, row.status, row.note]), [
    ['Glob', 'src/**/*.ts', 'ok', '2 files'], ['Glob', '*.ts', 'ok', '2 files'], ['Glob', '*.ts', 'ok', '1 file'], ['Glob', '**/*', 'ok', '1 file'],
    ['Glob', '**/*', 'ok', '4 files'], ['Grep', 'needle', 'ok', '2 matches'], ['Grep', 'NEEDLE', 'ok', '1 match'], ['Grep', 'e', 'ok', '1 match'],
  ], 'the reads inside a grep are not rows of their own');
});

test('glob() and grep() refuse a tree too big to go through, instead of answering from part of it', { skip: missing }, async () => {
  const big = path.join(work, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i <= R.GREP_FILES; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(5, '0')}.txt`), i === R.GREP_FILES ? 'the last straw\n' : 'hay\n');
  try {
    const { exec, rows, reads } = runs({});
    const r = await exec(`
      const out = { listed: (await glob('*.txt', { path: 'big' })).length };
      try { out.all = await grep('straw', { path: 'big' }); } catch (e) { out.all = e.message; }
      out.narrowed = await grep('straw', { path: 'big', glob: 'f020*.txt' });
      return out;`);
    assert.equal(r.isError, undefined, text(r));
    const out = JSON.parse(text(r).split('\n\n')[0]);
    assert.equal(out.listed, R.GREP_FILES + 1);
    assert.equal(out.all, 'grep() would have to read 2,001 files, and reads at most 2,000. Narrow it with { path } or { glob }.');
    assert.deepEqual(out.narrowed, [{ file: 'big/f02000.txt', line: 1, text: 'the last straw' }]);
    assert.equal(reads.length, 1, 'the refused search read nothing');
    assert.deepEqual(rows().map((row) => [row.name, row.status]), [['Glob', 'ok'], ['Grep', 'error'], ['Grep', 'ok']]);

    // The listing itself has a ceiling too (20,000 files); past it the host says the list is cut, and the helper throws.
    const cut = runs({});
    cut.code.files = async () => ({ base: '', files: ['a.txt'], truncated: true });
    const t = await cut.exec("return await glob('*.txt');");
    assert.equal(t.isError, true);
    assert.match(text(t), /^The script failed at line 1: Error: There are more than 1 files under the project folder, too many to go through\. Pass \{ path \}/);
    for (const cap of ['20,000', R.GREP_FILES.toLocaleString('en-US')]) assert.ok(M.TOOL_DESCRIPTION.includes(cap), `the tool says its ${cap} limit`);
  } finally { fs.rmSync(big, { recursive: true, force: true }); }
});

test('an empty script is refused without starting a sandbox', { skip: missing }, async () => {
  const { exec, events } = runs({});
  const r = await exec('   ');
  assert.equal(r.isError, true);
  assert.match(text(r), /^The script is empty/);
  assert.equal(events.length, 0);
});

// ---- the gate, the tool and Session's side ----

test('Code Mode is offered only to a Claude Code that checks a script\'s calls', { skip: missing }, () => {
  assert.equal(M.codeBlocked(null), null, 'not known yet is not a no');
  assert.match(M.codeBlocked(new Set()), /too old for Code Mode/, 'a Claude Code that advertises nothing cannot');
  assert.equal(M.codeBlocked(new Set(M.CODE_CAPS)), null);
  assert.match(M.codeBlocked(new Set(['mcp_call_result_not_for_model_v1'])), /too old for Code Mode/);
  assert.match(M.codeBlocked(new Set(CAPABILITIES)), /too old for Code Mode/);
  assert.equal(M.isNestedAsk('toolu_mcp_call_0123456789abcdef0123456789abcdef'), true);
  assert.equal(M.isNestedAsk('toolu_01AbCdEfGhIjKlMnOpQrStUv'), false);
});

test('the server has one always-loaded tool that teaches its own use', { skip: missing }, () => {
  const server = M.createCodeServer({ run: async () => ({ content: [] }), instructions: M.CODE_NOTE });
  assert.deepEqual([server.type, server.name], ['sdk', M.CODE_SERVER]);
  assert.equal(M.CODE_TOOL, 'mcp__canopy__run');
  assert.equal(server.instance.server._instructions, M.CODE_NOTE);
  for (const word of ['await mcp(', 'await read(', 'await glob(', 'await grep(', 'Use it when', 'Do not use it for', 'Plan mode', 'Promise.all', 'Example']) assert.ok(M.TOOL_DESCRIPTION.includes(word), word);
  assert.ok(M.CODE_NOTE.includes(M.CODE_TOOL));
});

const open = [];
afterEach(async () => { for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } } });
const CAN = [...CAPABILITIES, ...(M.CODE_CAPS ?? [])];
function session(opts = {}, script = {}) {
  const fake = createFake(script);
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}
// Canopy's widgets server (widgets.mjs), read_chat's (read-chat.mjs) and task's (task-tool.mjs) are always registered
// and named again in every payload; these tests are about Code Mode's, so they are left out of what they compare.
const mine = (o) => Object.keys(o ?? {}).filter((k) => k !== 'visualize' && k !== 'canopy_chats' && k !== 'canopy_task');
const servers = (run) => run.calls.filter((c) => c.method === 'setMcpServers').map((c) => mine(c.args[0]));

test('started with Code Mode on: the server and the note are there from the first turn', { skip: noSession }, async () => {
  const { s, fake, w } = session({ codeMode: true }, { capabilities: CAN });
  await s.warm();
  const { options } = fake.current;
  assert.deepEqual(mine(options.mcpServers), ['canopy']);
  assert.equal(options.mcpServers.canopy.type, 'sdk');
  // The note comes and goes with the server. In the system prompt it would outlive a toggle off.
  assert.equal(options.mcpServers.canopy.instance.server._instructions, M.CODE_NOTE);
  assert.ok(!options.systemPrompt.append.includes(M.CODE_TOOL));
  assert.equal(w.find('meta').codeBlocked, null);
  await sleep(20);
  assert.deepEqual(servers(fake.current), [], 'nothing to correct once Claude Code has started');
  assert.equal(s.snapshot().settings.codeMode, true);

  const off = session({}, { capabilities: CAN });
  await off.s.warm();
  assert.deepEqual(mine(off.fake.current.options.mcpServers), []);
  assert.equal(off.fake.current.options.systemPrompt.append, options.systemPrompt.append, 'the system prompt is the same with it and without');
});

test('before a chat\'s first message, the toggle adds and removes the server on the live process', { skip: noSession }, async () => {
  const { s, fake, w } = session({}, { capabilities: CAN });
  await s.warm();
  assert.deepEqual(await s.set('codeMode', true), { ok: true, applied: 'live' });
  assert.deepEqual(servers(fake.current), [['canopy']]);
  const added = fake.current.calls.find((c) => c.method === 'setMcpServers').args[0].canopy;
  assert.equal(added.type, 'sdk');
  assert.equal(added.instance.server._instructions, M.CODE_NOTE);
  assert.deepEqual(w.all((e) => e.kind === 'setting' && e.key === 'codeMode').map((e) => e.value), [true]);
  assert.deepEqual(await s.set('codeMode', true), { ok: true, applied: 'live' });
  assert.deepEqual(servers(fake.current), [['canopy']], 'already on: nothing is sent again');
  assert.deepEqual(await s.set('codeMode', false), { ok: true, applied: 'live' });
  assert.deepEqual(servers(fake.current), [['canopy'], []]);
  assert.equal((await s.set('codeMode', 'yes')).code, 'invalid-input');

  // Set before Claude Code runs: kept, and applied at the start.
  const later = session({}, { capabilities: CAN });
  assert.deepEqual(await later.s.set('codeMode', true), { ok: true, applied: 'next-start' });
  await later.s.warm();
  assert.deepEqual(mine(later.fake.current.options.mcpServers), ['canopy']);
});

// A tool that comes or goes after the first request changes the start of every later one: the whole chat is re-read
// at full price. So the tools a chat starts with are the tools it keeps, and the toggle is for the chats after it.
test('a chat that has started keeps its tools: the toggle is for new chats', { skip: noSession }, async () => {
  const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
  for (const [started, toggled] of [[true, false], [false, true]]) {
    const { s, fake, w } = session(started ? { codeMode: true } : {}, { capabilities: CAN });
    await s.warm();
    assert.equal(s.startedWith, null, 'nothing is fixed before the first message');
    s.send('hello');
    await idle(w);
    assert.deepEqual(s.startedWith, { codeMode: started, memory: false }, 'this host keeps no memory, and the chat says that too');

    const mark = w.mark();
    assert.deepEqual(await s.set('codeMode', toggled), { ok: true, applied: 'new-chats' });
    assert.deepEqual(servers(fake.current), [], 'the running process is not touched');
    assert.equal(s.snapshot().settings.codeMode === true, started);
    // The answer says what this chat has, so a switch drawn from it does not show the new choice as this chat's.
    const said = w.find((e) => e.kind === 'setting' && e.key === 'codeMode', mark);
    assert.deepEqual([said.value, said.appliesOn], [started, 'new-chats']);
    assert.equal(w.all((e) => e.kind === 'setting-failed', mark).length, 0, 'and it is not a failure');

    // A later process of the same chat (a restart, a setting that needs one) is given the same tools.
    await s.stop();
    const again = w.mark();
    s.send('more');
    await idle(w, again);
    assert.equal(fake.starts, 2);
    assert.deepEqual(mine(fake.current.options.mcpServers), started ? ['canopy'] : []);
    assert.deepEqual(servers(fake.current), []);
  }
});

test('a reopened chat gets the tools the host remembers it started with, whatever the choice is now', { skip: noSession }, async () => {
  for (const started of [true, false]) {
    const { s, fake } = session({ resume: randomUUID(), startedWith: { codeMode: started } }, { capabilities: CAN });
    assert.deepEqual(s.startedWith, { codeMode: started, memory: false }, 'fixed before it runs');
    assert.deepEqual(await s.set('codeMode', !started), { ok: true, applied: 'new-chats' });
    await s.warm();
    assert.deepEqual(mine(fake.current.options.mcpServers), started ? ['canopy'] : []);
    await sleep(20);
    assert.deepEqual(servers(fake.current), []);
  }
  // Nothing remembered (a chat from before Canopy kept track, or one started in the terminal): the choice as it is
  // when the chat is reopened, fixed by the first message sent here.
  const { s, fake, w } = session({ resume: randomUUID() }, { capabilities: CAN });
  assert.equal(s.startedWith, null);
  assert.deepEqual(await s.set('codeMode', true), { ok: true, applied: 'next-start' });
  s.send('carry on');
  await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, label: 'busy:false' });
  assert.deepEqual(mine(fake.current.options.mcpServers), ['canopy']);
  assert.deepEqual(s.startedWith, { codeMode: true, memory: false });
  // What a new chat is started with is not something to remember for it.
  assert.equal(session({ startedWith: { codeMode: true } }).s.startedWith, null);
});

test('a first message waits for a tool change that is on its way', { skip: noSession }, async () => {
  // A new chat is opened (and Claude Code started) before the window tells it your choices. A message sent in that
  // moment must not reach Claude Code ahead of the tool, or the first request would go out without it.
  let answer;
  const slow = new Promise((resolve) => { answer = resolve; });
  const { s, fake, w } = session({}, { capabilities: CAN, controls: { setMcpServers: async (servers) => { await slow; return { added: Object.keys(servers), removed: [], errors: {} }; } } });
  await s.warm();
  const setting = s.set('codeMode', true);
  await sleep(10);
  assert.equal(servers(fake.current).length, 1, 'the change is on its way');
  const sent = s.send('hello');
  assert.equal(sent.ok, true);
  await sleep(30);
  assert.equal(fake.current.received.length, 0, 'the message is held back');
  assert.equal(s.busy, true);
  answer();
  assert.deepEqual(await setting, { ok: true, applied: 'live' });
  await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, label: 'busy:false' });
  assert.equal(fake.current.received.length, 1);
  assert.equal(fake.starts, 1, 'the same process: nothing was restarted for it');
  assert.equal(w.text(), 'ok');
  assert.deepEqual(s.startedWith, { codeMode: true, memory: false });
});

test('a choice made before the first message counts, even when the message overtakes it', { skip: noSession }, async () => {
  const idle = (w) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, label: 'busy:false' });
  // The window tells a new chat your choices one after another, each waiting for Claude Code's answer, and you may
  // have sent already: Code Mode is still in line behind the model when the message arrives.
  let answer;
  const slow = new Promise((resolve) => { answer = resolve; });
  const { s, fake, w } = session({}, { capabilities: CAN, controls: { setModel: () => slow } });
  await s.warm();
  const model = s.set('model', 'opus');
  const code = s.set('codeMode', true);
  s.send('hello');
  await sleep(30);
  assert.equal(fake.current.received.length, 0, 'the message waits for the tools the chat will keep');
  assert.deepEqual(servers(fake.current), [], 'Code Mode has not had its turn yet');
  answer();
  assert.deepEqual([await model, await code], [{ ok: true, applied: 'live' }, { ok: true, applied: 'live' }]);
  await idle(w);
  assert.deepEqual(servers(fake.current), [['canopy']]);
  assert.equal(fake.current.received.length, 1);
  assert.deepEqual(s.startedWith, { codeMode: true, memory: false });
  assert.equal(fake.starts, 1);

  // The same with nothing running yet: the chat starts with the choice.
  const cold = session({}, { capabilities: CAN });
  const asked = cold.s.set('codeMode', true);
  cold.s.send('hello');
  assert.deepEqual(await asked, { ok: true, applied: 'next-start' });
  await idle(cold.w);
  assert.deepEqual(mine(cold.fake.current.options.mcpServers), ['canopy']);
  assert.deepEqual(servers(cold.fake.current), []);
  // And one made after the message is for the next chat.
  assert.deepEqual(await cold.s.set('codeMode', false), { ok: true, applied: 'new-chats' });
});

test('turning Code Mode off stops a script that is still running', { skip: noSession }, async () => {
  const { s } = session({ codeMode: true }, { capabilities: CAN });
  await s.warm();
  const channel = fakeChannel({ mcp__x__slow: 'hang' });
  s.run.control = channel; // the fake SDK has no pipes: this stands in for Claude Code's
  const running = s.runCode(s.run, { description: 'd', code: "await mcp('mcp__x__slow', {});\nawait mcp('mcp__x__after', {});\nreturn 'finished';" }, {});
  while (channel.sent.length < 1) await sleep(10);
  assert.deepEqual(await s.set('codeMode', false), { ok: true, applied: 'live' });
  const r = await within(running, 2000, 'the stopped script');
  assert.equal(r.isError, true);
  assert.match(text(r), /^The script was stopped before it finished\./);
  assert.equal(channel.cancelled.length, 1, 'its call in flight is withdrawn');
  assert.equal(channel.sent.length, 1, 'and it made no call after that');
});

test('in Plan mode a script is not run: Claude is told to call the tools directly', { skip: noSession }, async () => {
  const { s, w } = session({ codeMode: true }, { capabilities: CAN });
  await s.warm();
  const channel = fakeChannel({});
  s.run.control = channel;
  assert.equal((await s.set('permissionMode', 'plan')).ok, true);
  const refused = await s.runCode(s.run, { description: 'd', code: "return await mcp('mcp__x__y', {});" }, {});
  assert.equal(refused.isError, true);
  assert.equal(text(refused), 'Scripts cannot call tools in Plan mode, so this one did not run. Call the MCP tools directly instead.');
  assert.deepEqual([channel.sent.length, w.of('code-call').length], [0, 0], 'no sandbox, no calls');

  assert.equal((await s.set('permissionMode', 'default')).ok, true);
  const ran = await within(s.runCode(s.run, { description: 'd', code: "return await mcp('mcp__x__y', {});" }, {}), 20000, 'the script');
  assert.equal(ran.isError, undefined, text(ran));
  assert.match(text(ran), /^ok\n\n\(1 tool call, /);
});

test('a Claude Code too old to check a script\'s calls never keeps Code Mode', { skip: noSession }, async () => {
  // Started with it on (what the CLI can do is not known before it starts): taken away as soon as it is.
  const { s, fake, w } = session({ codeMode: true });
  await s.warm();
  assert.ok(fake.current.options.mcpServers.canopy);
  const failed = await w.waitFor('setting-failed', { ms: 2000 });
  assert.deepEqual([failed.key, failed.value], ['codeMode', false]);
  assert.match(w.find((e) => e.kind === 'notice' && /codeMode/.test(e.text)).text, /^Could not change codeMode: This version of Claude Code is too old for Code Mode/);
  assert.match(w.find('meta').codeBlocked, /too old/);
  await sleep(20);
  assert.deepEqual(servers(fake.current), [[]], 'the server is removed');
  assert.equal(s.snapshot().settings.codeMode, false);
  // Even before that, the tool itself refuses: the calls would not be checked.
  const refused = await s.runCode(s.run, { code: 'return 1' }, {});
  assert.equal(refused.isError, true);

  const mark = w.mark();
  const r = await s.set('codeMode', true);
  assert.deepEqual([r.ok, r.code], [false, 'rejected']);
  assert.match(r.message, /too old for Code Mode/);
  assert.equal(w.find('setting-failed', mark).value, false);
  assert.deepEqual(servers(fake.current), [[]]);
});

test('Code Mode\'s own tool never asks; a script\'s call asks once and can be allowed for the chat', { skip: noSession }, async () => {
  const { s, fake, w } = session({ codeMode: true }, { capabilities: CAN });
  await s.warm();
  const ask = (name, input, toolUseID) => fake.current.options.canUseTool(name, input, { signal: new AbortController().signal, toolUseID, requestId: toolUseID, suppressAlwaysAllowRule: true });

  assert.deepEqual(await ask(M.CODE_TOOL, { description: 'd', code: 'return 1' }, 'toolu_run'), { behavior: 'allow', updatedInput: { description: 'd', code: 'return 1' }, toolUseID: 'toolu_run' });
  assert.equal(w.of('permission').length, 0);

  // Three calls of one tool from one script, and one of another: four prompts.
  const answers = [ask('mcp__gmail__send', { to: 'a' }, 'toolu_mcp_call_1'), ask('mcp__gmail__send', { to: 'b' }, 'toolu_mcp_call_2'), ask('mcp__gmail__send', { to: 'c' }, 'toolu_mcp_call_3'), ask('mcp__notion__search', {}, 'toolu_mcp_call_4')];
  await w.waitFor((e) => e.kind === 'permission' && e.toolName === 'mcp__notion__search', { ms: 2000 });
  const prompts = w.of('permission');
  assert.equal(prompts.length, 4);
  assert.ok(prompts.every((p) => p.codeMode === true && p.hasSuggestions === true), 'each can be allowed for the chat');

  s.respond(prompts[0].id, { action: 'always' });
  const [a, b, c] = await within(Promise.all(answers.slice(0, 3)), 1000, 'one answer for all three');
  assert.deepEqual([a.behavior, b.behavior, c.behavior], ['allow', 'allow', 'allow']);
  assert.deepEqual([a.updatedInput, b.updatedInput, c.toolUseID], [{ to: 'a' }, { to: 'b' }, 'toolu_mcp_call_3']);
  assert.equal(s.snapshot().pending.length, 1, 'the other tool still waits');
  assert.match(w.find((e) => e.kind === 'notice' && e.code === 'granted').text, /always allow mcp__gmail__send from Code Mode scripts in this chat/);

  const mark = w.mark();
  assert.equal((await ask('mcp__gmail__send', { to: 'd' }, 'toolu_mcp_call_5')).behavior, 'allow');
  assert.equal(w.of('permission', mark).length, 0, 'remembered: no prompt');
  // The memory is for scripts only: the model's own call to that tool still asks.
  const direct = ask('mcp__gmail__send', { to: 'e' }, 'toolu_direct');
  const p = await w.waitFor('permission', { ms: 2000, from: mark });
  assert.equal(p.codeMode, undefined);
  s.respond(p.id, { action: 'deny' });
  assert.equal((await direct).behavior, 'deny');

  s.respond(prompts[3].id, { action: 'deny' });
  assert.equal((await answers[3]).behavior, 'deny');
});

test('a script\'s call that the user\'s own ask rule (or a hook) put to them is asked every time', { skip: noSession }, async () => {
  const { s, fake, w } = session({ codeMode: true }, { capabilities: CAN });
  await s.warm();
  const ask = (toolUseID, extra) => fake.current.options.canUseTool('mcp__gmail__send', { to: toolUseID }, { signal: new AbortController().signal, toolUseID, requestId: toolUseID, suppressAlwaysAllowRule: true, ...extra });
  const reasons = [{ decisionReasonType: 'rule' }, { decisionReasonType: 'hook' }, { matchedAskRule: { source: 'userSettings', tool_name: 'mcp__gmail__send' } }, { requiresInteraction: true }];
  for (const [i, reason] of reasons.entries()) {
    const mark = w.mark();
    const answer = ask(`toolu_mcp_call_r${i}`, reason);
    const p = await w.waitFor('permission', { ms: 2000, from: mark });
    assert.deepEqual([p.codeMode, p.hasSuggestions], [true, false], 'no "Allow for this chat" on this one');
    // Even an "always" that got through is an allow for this call only.
    s.respond(p.id, { action: 'always' });
    assert.equal((await answer).behavior, 'allow');
  }
  assert.equal(w.all((e) => e.kind === 'notice' && e.code === 'granted').length, 0, 'nothing was remembered');

  // And a tool allowed for the chat on a plain ask is still asked when a rule is behind the prompt.
  const plain = ask('toolu_mcp_call_plain');
  s.respond((await w.waitFor((e) => e.kind === 'permission' && e.hasSuggestions === true, { ms: 2000 })).id, { action: 'always' });
  assert.equal((await plain).behavior, 'allow');
  const mark = w.mark();
  assert.equal((await ask('toolu_mcp_call_again')).behavior, 'allow');
  assert.equal(w.of('permission', mark).length, 0, 'the plain ask is remembered');
  const ruled = ask('toolu_mcp_call_ruled', { decisionReasonType: 'rule' });
  const p = await w.waitFor('permission', { ms: 2000, from: mark });
  s.respond(p.id, { action: 'deny' });
  assert.equal((await ruled).behavior, 'deny');
});

test('without Code Mode a tool that happens to be named like its tool still asks', { skip: noSession }, async () => {
  const { s, fake, w } = session({}, { capabilities: CAN });
  await s.warm();
  const pending = fake.current.options.canUseTool(M.CODE_TOOL, { code: 'x' }, { signal: new AbortController().signal, toolUseID: 'toolu_x', requestId: 'r' });
  const p = await w.waitFor('permission', { ms: 2000 });
  s.respond(p.id, { action: 'deny' });
  assert.equal((await pending).behavior, 'deny');
});

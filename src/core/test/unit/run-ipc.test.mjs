// Run in the chat (src/run-ipc.mjs): a shell block's command, run in a terminal in the chat's folder and under its
// account. The terminal is a fake that records what it was started with; nothing is run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRuns } from '../../../run-ipc.mjs';

function world({ chats = {}, env = () => ({ SHELL: '/bin/zsh', PATH: '/usr/bin' }), folder = '/work/here' } = {}) {
  const handlers = {}, listeners = {}, sent = [], spawned = [];
  const spawn = (file, args, opts) => {
    const p = { file, args, opts, written: [], killed: [], sized: [], data: null, exit: null };
    p.onData = (fn) => { p.data = fn; };
    p.onExit = (fn) => { p.exit = fn; };
    p.write = (d) => p.written.push(d);
    p.resize = (c, r) => p.sized.push([c, r]);
    p.kill = (sig) => p.killed.push(sig);
    spawned.push(p);
    return p;
  };
  const host = registerRuns((ch, fn) => { handlers[ch] = fn; }, {
    on: (ch, fn) => { listeners[ch] = fn; }, send: (ch, x) => sent.push([ch, x]), spawn,
    chat: (sid) => chats[sid] ?? null, env, folder: () => folder,
  });
  return { host, handlers, listeners, sent, spawned };
}

test('a command runs in your shell, in the chat\'s folder, with the chat\'s environment', async () => {
  const seen = [];
  const w = world({ chats: { s1: { cwd: '/repo', engine: 'claude', accountId: 'work' } }, env: (c) => { seen.push(c); return { SHELL: '/bin/bash', HOME: '/h' }; } });
  const r = await w.handlers['run:start']('r1', { sid: 's1', cwd: '/elsewhere', code: 'claude mcp login posthog\n', cols: 90, rows: 10 });
  assert.deepEqual(r, { ok: true });
  const [p] = w.spawned;
  assert.equal(p.file, '/bin/bash');
  assert.deepEqual(p.args, ['-ilc', 'claude mcp login posthog'], 'login and interactive, as Terminal opens it; trailing space trimmed');
  assert.equal(p.opts.cwd, '/repo', 'the chat\'s own folder wins over what the window says');
  assert.deepEqual([p.opts.cols, p.opts.rows], [90, 10]);
  assert.equal(p.opts.env.HOME, '/h');
  assert.equal(p.opts.env.TERM, 'xterm-256color');
  assert.equal(seen[0].accountId, 'work', 'the environment is the chat\'s (its account)');
});

test('what it prints and how it ends reach the window, tagged with the run', async () => {
  const w = world();
  await w.handlers['run:start']('r1', { sid: null, cwd: null, code: 'ls' });
  const [p] = w.spawned;
  assert.equal(p.opts.cwd, '/work/here', 'with no chat yet, the folder on screen');
  p.data('a.txt\r\n');
  w.listeners['run:input']('r1', 'y\r');
  w.listeners['run:resize']('r1', 5000, 1);
  p.exit({ exitCode: 2, signal: 0 });
  assert.deepEqual(w.sent, [['run:data', { id: 'r1', data: 'a.txt\r\n' }], ['run:exit', { id: 'r1', exitCode: 2, signal: null }]]);
  assert.deepEqual(p.written, ['y\r']);
  assert.deepEqual(p.sized, [[400, 2]], 'sizes are kept to something a terminal can be');
  assert.equal(w.host.count, 0);
  w.listeners['run:input']('r1', 'late'); // ended: nothing to type into
  assert.deepEqual(p.written, ['y\r']);
});

test('stop hangs up, and the same id can run again once it has ended', async () => {
  const w = world();
  await w.handlers['run:start']('r1', { code: 'sleep 99' });
  assert.deepEqual(await w.handlers['run:start']('r1', { code: 'sleep 99' }), { error: 'This is already running.' });
  assert.deepEqual(await w.handlers['run:stop']('r1'), { ok: true });
  assert.deepEqual(w.spawned[0].killed, ['SIGHUP']);
  w.spawned[0].exit({ exitCode: 129, signal: 1 });
  assert.deepEqual(w.sent.at(-1), ['run:exit', { id: 'r1', exitCode: 129, signal: 1 }]);
  assert.deepEqual(await w.handlers['run:stop']('r1'), { ok: false });
  assert.deepEqual(await w.handlers['run:start']('r1', { code: 'true' }), { ok: true });
});

test('it refuses what it should not start', async () => {
  const w = world({ folder: null, env: () => { throw new Error('The account this chat uses is no longer in Canopy.'); } });
  assert.match((await w.handlers['run:start']('', { code: 'ls' })).error, /no id/);
  assert.match((await w.handlers['run:start']('a', { code: '   ' })).error, /nothing to run/);
  assert.match((await w.handlers['run:start']('a', { code: 'x'.repeat(20_001) })).error, /too long/);
  assert.match((await w.handlers['run:start']('a', { code: 'ls', cwd: 'relative/dir' })).error, /Open a folder/);
  assert.match((await w.handlers['run:start']('a', { code: 'ls', cwd: '/tmp' })).error, /no longer in Canopy/);
  assert.equal(w.spawned.length, 0);
});

test('a handful at most run at once, and quitting ends them all', async () => {
  const w = world();
  for (let i = 0; i < 8; i++) assert.deepEqual(await w.handlers['run:start'](`r${i}`, { code: 'sleep 9' }), { ok: true });
  assert.match((await w.handlers['run:start']('r9', { code: 'sleep 9' })).error, /already running/);
  w.host.stopAll();
  assert.ok(w.spawned.every((p) => p.killed.includes('SIGHUP')));
  assert.equal(w.host.count, 0);
});

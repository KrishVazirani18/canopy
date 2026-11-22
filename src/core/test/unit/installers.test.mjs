// Installing Claude Code and Codex (src/installers.mjs): which official route is taken, and what a failure says.
// Nothing is installed: the command runner and the PATH check are stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, installCommand, runShell } from '../../../installers.mjs';

const has = (...bins) => async (b) => bins.includes(b);

test('Claude Code uses Anthropic’s installer; Codex prefers Homebrew, then npm, else says what is missing', async () => {
  assert.match((await installCommand('claude', {}, has())).cmd, /claude\.ai\/install\.sh/);
  assert.equal((await installCommand('codex', {}, has('brew', 'npm'))).cmd, 'brew install --cask codex');
  assert.equal((await installCommand('codex', {}, has('npm'))).cmd, 'npm install -g @openai/codex');
  assert.equal(await installCommand('codex', {}, has()), null);
  assert.match((await install('codex', { env: {}, exists: has() })).error, /Homebrew or Node\.js/);
});

test('a run that works is ok; one that fails or times out says so in words', async () => {
  const ran = [];
  const ok = await install('claude', { env: {}, exists: has(), run: async (cmd) => { ran.push(cmd); return { code: 0, tail: '' }; } });
  assert.equal(ok.ok, true);
  assert.match(ran[0], /install\.sh/);
  assert.match((await install('claude', { env: {}, exists: has(), run: async () => ({ code: 1, tail: 'curl: (6)' }) })).error, /connection/);
  assert.match((await install('claude', { env: {}, exists: has(), run: async () => ({ code: -1, tail: '', timedOut: true }) })).error, /too long/);
});

test('runShell runs a real command and keeps the end of its output', async () => {
  const r = await runShell('echo hello; echo oops 1>&2; exit 3', { PATH: process.env.PATH });
  assert.equal(r.code, 3);
  assert.match(r.tail, /hello/);
  assert.match(r.tail, /oops/);
});

test('runShell gives up at its limit, without waiting for what the shell started, and ends all of it', async () => {
  // The shell prints its own pid, which is also its process group; the pipeline behind it would hold the output open for a minute.
  const started = Date.now();
  const r = await runShell('echo $$; sleep 60 | cat', { PATH: process.env.PATH }, { limitMs: 300 });
  assert.deepEqual([r.code, r.timedOut], [-1, true]);
  assert.ok(Date.now() - started < 30000, 'answered at the limit, not when the pipeline ended');
  const group = Number(r.tail.trim().split('\n')[0]);
  assert.ok(Number.isInteger(group) && group > 1, `the shell said its pid: ${r.tail}`);
  const gone = () => { try { process.kill(-group, 0); return false; } catch (err) { return err.code === 'ESRCH'; } };
  for (let i = 0; i < 1000 && !gone(); i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(gone(), 'nothing of the pipeline is left running');
});

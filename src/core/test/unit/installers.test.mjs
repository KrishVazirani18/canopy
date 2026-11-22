// Installing Claude Code and Codex (src/installers.mjs): which official route is taken, and what a failure says.
// Nothing is installed: the command runner, the PATH check and the does-it-run check are stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, installRoutes, runShell } from '../../../installers.mjs';

const has = (...bins) => async (b) => bins.includes(b);
const yes = async () => true, no = async () => false;

test('each tool tries its maker’s installer first, then Homebrew and npm when they are there', async () => {
  const via = async (engine, ...bins) => (await installRoutes(engine, {}, has(...bins))).map((r) => r.via);
  assert.deepEqual(await via('codex'), ['OpenAI’s installer']);
  assert.deepEqual(await via('codex', 'brew', 'npm'), ['OpenAI’s installer', 'Homebrew', 'npm']);
  assert.deepEqual(await via('claude', 'npm'), ['Anthropic’s installer', 'npm']);
  const [codex] = await installRoutes('codex', {}, has());
  assert.match(codex.cmd, /github\.com\/openai\/codex\/releases\/latest\/download\/install\.sh/);
  assert.match(codex.cmd, /CODEX_NON_INTERACTIVE=1/);
  assert.match((await installRoutes('claude', {}, has()))[0].cmd, /claude\.ai\/install\.sh/);
});

test('with no Homebrew and no Node, Codex still installs: OpenAI’s installer needs only curl', async () => {
  const ran = [];
  const r = await install('codex', { env: {}, exists: has(), runs: yes, run: async (cmd) => { ran.push(cmd); return { code: 0, tail: '' }; } });
  assert.deepEqual(r, { ok: true, via: 'OpenAI’s installer' });
  assert.equal(ran.length, 1);
});

test('a failed download is tried again, then the next route; the first that leaves a tool that runs wins', async () => {
  const ran = [];
  const results = [{ code: 22, tail: 'curl: (22) 503' }, { code: 22, tail: 'curl: (22) 503' }, { code: 0, tail: '' }];
  const r = await install('codex', { env: {}, exists: has('brew'), runs: yes, run: async (cmd) => { ran.push(cmd); return results.shift(); } });
  assert.deepEqual(r, { ok: true, via: 'Homebrew' });
  assert.equal(ran.length, 3);
  assert.equal(ran[2], 'brew install --cask codex');
});

test('an installer that says it worked but left nothing that runs does not count', async () => {
  const r = await install('claude', { env: {}, exists: has(), runs: no, run: async () => ({ code: 0, tail: '' }) });
  assert.match(r.error, /connection/);
  assert.match(r.manual, /claude\.ai\/install\.sh/);
});

test('when every route fails it says so in words, and a timeout says it took too long', async () => {
  assert.match((await install('claude', { env: {}, exists: has(), runs: yes, run: async () => ({ code: 1, tail: 'curl: (6)' }) })).error, /connection/);
  assert.match((await install('codex', { env: {}, exists: has(), runs: yes, run: async () => ({ code: -1, tail: '', timedOut: true }) })).error, /too long/);
});

test('a broken download never runs: the script is saved to a file and run only if curl succeeded', async () => {
  const [route] = await installRoutes('claude', {}, has());
  const fake = route.cmd.replace('curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20', 'false').replace('/bin/bash "$f"', 'echo RAN');
  const r = await runShell(fake, { PATH: process.env.PATH });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.tail, /RAN/);
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

// Installing Claude Code and Codex for someone who doesn't have them, with each maker's own installer, so onboarding's
// "Setting Things Up" can get both ready without asking anything. Canopy never ships either tool itself.
//
//   claude   Anthropic's native installer: curl -fsSL https://claude.ai/install.sh | bash
//   codex    OpenAI's published routes: Homebrew's cask when Homebrew is there, else npm's global package
//
// Each runs in the login shell's environment (the PATH the person's own Terminal has), with no prompt to answer, and
// is given up after ten minutes. What comes back is { ok } or { error } in words a person can read, with the last
// lines of output for the log. Nothing here decides *whether* to install: the window asks only for a tool that the
// environment check did not find.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const LIMIT_MS = 10 * 60_000;

/** The command line for a tool, given what's on the PATH. null: there's no route on this Mac (say what's missing). */
export async function installCommand(engine, env, exists = onPath) {
  if (engine === 'claude') return { cmd: 'curl -fsSL https://claude.ai/install.sh | bash', via: 'Anthropic’s installer' };
  if (engine === 'codex') {
    if (await exists('brew', env)) return { cmd: 'brew install --cask codex', via: 'Homebrew' };
    if (await exists('npm', env)) return { cmd: 'npm install -g @openai/codex', via: 'npm' };
    return null;
  }
  return null;
}

async function onPath(bin, env) {
  for (const dir of String(env?.PATH ?? '').split(':').filter(Boolean)) {
    try { await access(path.join(dir, bin), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/**
 * Installs one tool.
 * @param {'claude' | 'codex'} engine
 * @param {{ env: Record<string,string>, log?: (m: string) => void, run?: typeof runShell, exists?: typeof onPath }} deps
 */
export async function install(engine, { env, log = () => {}, run = runShell, exists = onPath }) {
  const how = await installCommand(engine, env, exists);
  if (!how) return { error: engine === 'codex' ? 'Codex needs Homebrew or Node.js to install. Install one, then try again.' : 'Couldn’t find a way to install it.' };
  log(`install ${engine}: ${how.cmd}`);
  const r = await run(how.cmd, env);
  if (r.code === 0) { log(`install ${engine}: done`); return { ok: true, via: how.via }; }
  log(`install ${engine}: failed (${r.timedOut ? 'timed out' : `exit ${r.code}`})\n${r.tail}`);
  return { error: r.timedOut ? 'It took too long. Check your connection and try again.' : 'Couldn’t install it. Check your connection and try again.' };
}

/**
 * Runs a command line in a non-interactive shell with `env`. Never throws, and never takes longer than the limit:
 * the shell leads a process group of its own, so when time is up everything it started (`curl … | bash`, brew, npm)
 * is ended with it, and the answer does not wait for a child that still holds the output open.
 */
export function runShell(cmd, env, { limitMs = LIMIT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', timedOut = false, done = false;
    const finish = (code, tail = out.split('\n').slice(-12).join('\n')) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, tail, timedOut }); };
    let child, timer;
    try { child = spawn('/bin/bash', ['-c', cmd], { env: { ...env, CI: '1', HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (err) { finish(-1, String(err?.message ?? err)); return; }
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const keep = (b) => { out = (out + b.toString()).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref(); // for whatever ignored the first
      finish(-1);
    }, limitMs);
    child.on('error', (err) => finish(-1, String(err?.message ?? err)));
    child.on('close', (code) => finish(code ?? -1));
  });
}

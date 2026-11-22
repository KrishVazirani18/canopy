// Installing Claude Code and Codex for someone who doesn't have them, with each maker's own installer, so onboarding's
// "Setting Things Up" can get both ready without asking anything. Canopy never ships either tool itself.
//
// Each tool has routes, tried in order until one gives a tool that runs:
//
//   claude   1. Anthropic's installer (claude.ai/install.sh): needs nothing but curl, which every Mac has
//            2. Homebrew's cask, when Homebrew is there      3. npm's global package, when npm is there
//   codex    1. OpenAI's installer (install.sh on Codex's GitHub releases): needs nothing but curl. It downloads the
//               build for this Mac (Apple silicon or Intel) and checks it against the release's checksums
//            2. Homebrew's cask, when Homebrew is there      3. npm's global package, when npm is there
//
// A maker's installer is downloaded to a file first (so a broken download can never run half a script), with curl's
// own retries, and is tried twice before moving on. A route only counts once the tool it installed answers
// `--version`: an installer that says it worked but left nothing that runs goes on to the next route. Updates are
// Claude Code's and Codex's own (`claude update`, `codex update`), which know how they were installed.
//
// Each runs in the login shell's environment (the PATH the person's own Terminal has), with no prompt to answer, and
// is given up after ten minutes. What comes back is { ok, via } or { error } in words a person can read, with the last
// lines of output for the log. Nothing here decides *whether* to install: the window asks only for a tool that the
// environment check did not find.
import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIMIT_MS = 10 * 60_000;
const TRIES = 2; // a maker's own installer: once more after a failure, before the next route

/** Download a maker's installer to a file, then run it: a failed download stops with curl's error, never runs. */
const script = (url, envs = '') => `f="$(mktemp -t canopy-install)" || exit 1; `
  + `curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 "${url}" -o "$f" && ${envs}/bin/bash "$f"; r=$?; rm -f "$f"; exit $r`;

const ROUTES = {
  claude: [
    { cmd: script('https://claude.ai/install.sh'), via: 'Anthropic’s installer', tries: TRIES },
    { cmd: 'brew install --cask claude-code', via: 'Homebrew', needs: 'brew' },
    { cmd: 'npm install -g @anthropic-ai/claude-code', via: 'npm', needs: 'npm' },
  ],
  codex: [
    { cmd: script('https://github.com/openai/codex/releases/latest/download/install.sh', 'CODEX_NON_INTERACTIVE=1 '), via: 'OpenAI’s installer', tries: TRIES },
    { cmd: 'brew install --cask codex', via: 'Homebrew', needs: 'brew' },
    { cmd: 'npm install -g @openai/codex', via: 'npm', needs: 'npm' },
  ],
};

/** What a person could run themselves, in Terminal, when every route failed. */
export const MANUAL = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'curl -fsSL https://github.com/openai/codex/releases/latest/download/install.sh | sh',
};

/** The routes this Mac can take for a tool, in order: the maker's installer always, Homebrew and npm when there. */
export async function installRoutes(engine, env, exists = onPath) {
  const all = ROUTES[engine];
  if (!all) return [];
  const out = [];
  for (const r of all) if (!r.needs || await exists(r.needs, env)) out.push(r);
  return out;
}

/** The folders a tool may land in: the PATH, then where each route puts it (installers do not all touch the PATH). */
function searchDirs(env) {
  const dirs = String(env?.PATH ?? '').split(':').filter(Boolean);
  for (const d of [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) if (!dirs.includes(d)) dirs.push(d);
  return dirs;
}

async function onPath(bin, env) {
  for (const dir of String(env?.PATH ?? '').split(':').filter(Boolean)) {
    try { await access(path.join(dir, bin), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** Does the tool now run? Its first copy in `searchDirs` answers `--version`. Never throws. */
export async function toolRuns(engine, env) {
  for (const dir of searchDirs(env)) {
    const bin = path.join(dir, engine);
    try { await access(bin, constants.X_OK); } catch { continue; }
    const ok = await new Promise((resolve) => execFile(bin, ['--version'], { env, timeout: 30_000 }, (err) => resolve(!err)));
    if (ok) return true;
  }
  return false;
}

/**
 * Installs one tool, trying its routes in order until one leaves a tool that runs.
 * @param {'claude' | 'codex'} engine
 * @param {{ env: Record<string,string>, log?: (m: string) => void, run?: typeof runShell, exists?: typeof onPath, runs?: typeof toolRuns }} deps
 */
export async function install(engine, { env, log = () => {}, run = runShell, exists = onPath, runs = toolRuns }) {
  const routes = await installRoutes(engine, env, exists);
  if (!routes.length) return { error: 'Couldn’t find a way to install it.' };
  let timedOut = false;
  for (const how of routes) {
    for (let attempt = 1; attempt <= (how.tries ?? 1); attempt++) {
      log(`install ${engine}: ${how.via}${attempt > 1 ? ` (try ${attempt})` : ''}`);
      const r = await run(how.cmd, env);
      if (r.code === 0 && await runs(engine, env)) { log(`install ${engine}: done, with ${how.via}`); return { ok: true, via: how.via }; }
      timedOut ||= !!r.timedOut;
      log(`install ${engine}: ${how.via} ${r.code === 0 ? 'finished, but the tool does not run' : `failed (${r.timedOut ? 'timed out' : `exit ${r.code}`})`}\n${r.tail}`);
    }
  }
  log(`install ${engine}: every route failed. By hand: ${MANUAL[engine]}`);
  return { error: timedOut ? 'It took too long. Check your connection and try again.' : 'Couldn’t install it. Check your connection and try again.', manual: MANUAL[engine] };
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

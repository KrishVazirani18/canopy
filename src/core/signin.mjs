// Signing in: Claude Code's own `claude auth login`, run as it is in a terminal the user types into.
//
// Canopy has no sign-in field of its own and never holds a login. It starts Claude Code's sign-in, shows its
// terminal, and waits for it to end. What the user types and what Claude Code prints pass straight between the
// window's terminal and the process: nothing here reads, keeps or logs either one. All that is looked at is that
// the process ended, and with which exit code. Who is signed in afterwards comes from asking Claude Code
// (`claude auth status`, through env.mjs), never from the terminal's text.
//
//   TOKEN_VARS             variables that carry a login token: never in a sign-in's environment
//   signInEnv(base, dir)   the environment `claude auth login` runs in
//   signInArgs(opts)       its arguments
//   confirmSignIn(...)     after it exits 0: who Claude Code says is signed in, and that it answered for that folder
//   terminalScript(...)    the same sign-in as a script for Terminal ("Open in Terminal instead")
//   SignIn                 one sign-in at a time: begin, attach a terminal, type, hand to Terminal, cancel
//
// A sign-in is for a login Claude Code keeps itself: the one in its own folder (`dir` null), or one in a folder of
// its own (`dir`). The process is only started once a terminal is attached, so none of its output is ever held.
//
// Contract: nothing here throws or rejects. `begin` answers `{ ok: false, code, message }` instead of starting.
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { LOGIN_VARS, describeAuth, labelFor, launchEnv, sameDir } from './accounts-claude.mjs';
import { authStatus, configHome, scrubEnv } from './env.mjs';

/** Variables that carry a login token. A sign-in is never started with one: it would sign in as that token. */
export const TOKEN_VARS = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
]);

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' && v ? v : null);
const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
const size = (n, fallback) => (Number.isInteger(n) && n >= 2 && n <= 1000 ? n : fallback);
// An address to prefill on the sign-in page. Anything that is not plainly one is left out: it is only a convenience,
// and it must never be read as another option.
const EMAIL = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const emailOf = (v) => (typeof v === 'string' && EMAIL.test(v) ? v : null);
const MAX_INPUT = 64 * 1024; // one write from the window's terminal: a paste, never megabytes

function home() {
  const h = os.homedir();
  return isAbs(h) ? h : os.tmpdir();
}

/**
 * The environment Claude Code's sign-in runs in: the one a sign-in is launched with (accounts-claude.mjs: the base
 * without anything that chooses a login, plus the account's own folder when it has one), and no token variable.
 * @param {Record<string, string>} base the environment Claude Code is launched with
 * @param {string | null} [dir] the account's own folder; null for Claude Code's own
 * @throws the registry's `refuse` error when there is no environment yet, or the folder is missing
 */
export function signInEnv(base, dir = null) {
  const env = launchEnv({ kind: 'plan', dir: dir ?? null }, isPlain(base) ? scrubEnv(base) : base, { name: 'this account' });
  for (const k of TOKEN_VARS) delete env[k];
  return env;
}

/**
 * `claude auth login`'s arguments. `console`: sign in to the Console (billed per use) instead of a Claude plan.
 * `sso`: Claude Code's single sign-on flow. `email`: prefilled on the sign-in page.
 */
export function signInArgs({ console: viaConsole, sso, email } = {}) {
  const args = ['auth', 'login'];
  if (viaConsole === true) args.push('--console');
  if (sso === true) args.push('--sso');
  const address = emailOf(email);
  if (address) args.push('--email', address);
  return args;
}

/**
 * Ask Claude Code who is signed in, after its sign-in exited 0. "Signed in" alone proves nothing (a key in the
 * settings makes any folder look signed in), so the answer must be a sign-in, and for the folder that was signed
 * in to.
 * @returns {Promise<{ ok: true, who: { kind: string, email: string|null, org: string|null, orgId: string|null, plan: string|null } } | { ok: false, code: 'unverified'|'signed-out'|'blocked'|'mismatch' }>}
 */
export async function confirmSignIn({ claudePath, env, dir = null, ask = authStatus } = {}) {
  let auth = null;
  try { auth = await ask(claudePath, env); } catch { auth = null; }
  const a = describeAuth(auth);
  if (a.state === 'unknown') return { ok: false, code: 'unverified' };
  if (a.state !== 'ok') return { ok: false, code: 'signed-out' };
  if (a.kind === 'external') return { ok: false, code: 'blocked' };
  // A folder of its own must be named in the answer. Claude Code's own folder is where it looks when none is
  // given, so there only a different folder in the answer is a mismatch.
  if (a.configDir ? !sameDir(a.configDir, dir ?? configHome(env)) : !!dir) return { ok: false, code: a.configDir ? 'mismatch' : 'unverified' };
  return { ok: true, who: { kind: a.kind, email: a.email, org: a.org, orgId: a.orgId, plan: a.plan } };
}

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * The same sign-in as a shell script, for Terminal. It holds no secret: it clears the login variables Terminal's
 * shell may have, names the account's folder when it has one, and runs Claude Code's own sign-in.
 * @param {{ claudePath: string, base: Record<string, string>, env: Record<string, string>, args: string[] }} o
 *   `env`: the sign-in's environment (`signInEnv`), `base`: what it was built from. Only what differs is written.
 */
export function terminalScript({ claudePath, base, env, args }) {
  const lines = ['#!/bin/sh', "# Canopy wrote this to run Claude Code's own sign-in in Terminal. It can be deleted.", `unset ${LOGIN_VARS.join(' ')}`];
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) {
    if (str(env?.[k]) && env[k] !== base?.[k]) lines.push(`export ${k}=${quote(env[k])}`);
  }
  lines.push(`exec ${[claudePath, ...args].map(quote).join(' ')}`, '');
  return lines.join('\n');
}

// Why a sign-in that ran did not count, in words.
const WHY = {
  failed: 'Sign-in didn’t finish.',
  'signed-out': 'Claude Code says it is still signed out.',
  unverified: 'Canopy couldn’t check the sign-in. Try again in a moment.',
  mismatch: 'Claude Code answered for a different folder.',
  blocked: 'Your Claude Code settings choose the login, so this sign-in isn’t used.',
  'start-failed': 'Claude Code’s sign-in couldn’t start.',
};
const no = (code, message) => ({ ok: false, code, message });

export class SignIn {
  /**
   * @param {{
   *   spawn: (file: string, args: string[], opts: object) => object,   node-pty's `spawn` (a fake in tests)
   *   tool: () => ({ path: string | null, env: object | null }),       where Claude Code is and what it is launched with
   *   account?: (id: string) => object | null,                          a registry entry by id: its kind, folder and email
   *   ask?: typeof authStatus,                                          the test seam for `claude auth status`
   *   onData?: (id: string, data: string) => void,                      the process's output, for the window's terminal only
   *   onState?: (state: object) => void,                                where the sign-in stands (never terminal text)
   *   onSignedIn?: (result: object) => unknown,                         a sign-in was confirmed: update what the host knows
   *   openTerminal?: (script: string) => Promise<{ ok: boolean, message?: string }>,   run a script in Terminal
   *   log?: (msg: string) => void, attachMs?: number, killMs?: number,
   * }} deps
   */
  constructor({ spawn, tool, account, ask = authStatus, onData, onState, onSignedIn, openTerminal, log, attachMs = 20_000, killMs = 1500 } = {}) {
    this.spawnFn = typeof spawn === 'function' ? spawn : null;
    this.tool = typeof tool === 'function' ? tool : () => ({ path: null, env: null });
    this.account = typeof account === 'function' ? account : () => null;
    this.ask = ask;
    this.onData = typeof onData === 'function' ? onData : () => {};
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.onSignedIn = typeof onSignedIn === 'function' ? onSignedIn : null;
    this.openTerminal = typeof openTerminal === 'function' ? openTerminal : null;
    this.logFn = typeof log === 'function' ? log : () => {};
    this.attachMs = attachMs;
    this.killMs = killMs;
    this.run = null; // the one sign-in that is open, or null
    this.exited = new WeakSet(); // processes that have ended: only one still running is ever killed harder
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a sign-in */ } }

  /** Where the open sign-in stands, as the window is told, or null. */
  get state() { return this.run ? this.#view(this.run) : null; }

  /**
   * Open a sign-in. Nothing runs yet: Claude Code's sign-in starts when a terminal is attached (`attach`).
   * `accountId`: an account in the registry, signed in to again. `dir`: an account folder that is not in the
   * registry yet. Neither: the login in Claude Code's own folder. `console`, `sso`, `email`: see `signInArgs`
   * (an account already known supplies its own kind and address).
   * @returns {{ ok: true, id: string, done: Promise<object> } | { ok: false, code: string, message: string }}
   *   `done` resolves when the sign-in is over, never rejects: `{ ok: true, accountId, dir, who }` once Claude Code
   *   confirms it, else `{ ok: false, code, message }` (cancelled, or closed after it failed).
   */
  begin({ accountId = null, dir = null, console: viaConsole, sso, email, label = null } = {}) {
    try {
      if (!this.spawnFn) return no('unavailable', 'Signing in isn’t available here.');
      if (this.run) return no('busy', 'A sign-in is already open.');
      let claudePath = null, base = null;
      try { const t = this.tool() ?? {}; claudePath = str(t.path); base = isPlain(t.env) ? t.env : null; } catch { /* not known */ }
      if (!claudePath) return no('not-installed', 'Claude Code was not found.');
      if (!base) return no('no-env', 'Canopy has not finished checking your setup yet.');

      let known = null;
      if (accountId != null) {
        try { known = typeof accountId === 'string' ? this.account(accountId) : null; } catch { known = null; }
        if (!isPlain(known) || known.engine !== 'claude') return no('account-missing', 'That account is not in Canopy.');
        if (known.kind !== 'plan' && known.kind !== 'console') return no('not-a-sign-in', 'This account doesn’t use a sign-in.');
      } else if (dir != null && !isAbs(dir)) return no('account-missing', 'That account’s folder is missing.');
      const folder = known ? known.dir ?? null : dir ?? null;

      let env;
      try { env = signInEnv(base, folder); }
      catch (err) { return no(str(err?.code) ?? 'no-env', str(err?.canopy?.message) ?? 'Canopy could not set up the sign-in.'); }

      const run = {
        id: randomUUID(), accountId: known ? known.id : null, dir: folder, claudePath, base, env,
        // An account already known is signed in to the way it was; anything else may still choose.
        opts: { console: known ? known.kind === 'console' : viaConsole === true, sso: sso === true, email: emailOf(known?.email) ?? emailOf(email) },
        canSwitch: !known && viaConsole === undefined,
        label: str(label) ?? (known ? str(known.label) ?? labelFor(known) : null),
        phase: 'ready', pty: null, message: null, code: null, who: null, timer: null, resolve: null,
      };
      const done = new Promise((resolve) => { run.resolve = resolve; });
      this.run = run;
      // Nobody is there to show it (no window, or it never opened the sheet): nothing was started, so nothing to stop.
      run.timer = setTimeout(() => { if (this.run === run && run.phase === 'ready') this.#close(run, no('no-window', 'The sign-in couldn’t be shown.')); }, this.attachMs);
      run.timer.unref?.();
      this.log(`sign-in opened (${run.accountId ?? (run.dir ? 'a folder of its own' : 'Claude Code’s own login')})`);
      this.#tell(run);
      return { ok: true, id: run.id, done };
    } catch (err) {
      this.log(`sign-in could not open: ${err?.message ?? err}`);
      return no('failed', 'Canopy could not set up the sign-in.');
    }
  }

  /**
   * A terminal is ready for the sign-in: start Claude Code's sign-in in it (or start it again after one that did
   * not finish). `how.console` switches between a Claude plan and the Console, where the sign-in may still choose.
   * @returns {{ ok: boolean, message?: string }}
   */
  attach(id, cols, rows, how) {
    const run = this.#mine(id);
    if (!run) return { ok: false, message: 'That sign-in is closed.' };
    const switching = run.canSwitch && typeof how?.console === 'boolean' && how.console !== run.opts.console;
    if (switching) run.opts.console = how.console;
    if (run.phase === 'running' && !switching) return { ok: true };
    if (!['ready', 'failed', 'running', 'terminal'].includes(run.phase)) return { ok: false, message: 'That sign-in is already being checked.' };
    clearTimeout(run.timer);
    this.#hangUp(run);
    let pty;
    try {
      pty = this.spawnFn(run.claudePath, signInArgs(run.opts), {
        name: 'xterm-256color', cols: size(cols, 80), rows: size(rows, 24), cwd: home(),
        env: { ...run.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      this.log(`sign-in could not start: ${err?.code ?? err?.name ?? 'error'}`);
      this.#set(run, 'failed', 'start-failed');
      return { ok: false, message: WHY['start-failed'] };
    }
    run.pty = pty;
    // Straight through, both ways. Nothing is kept, counted or looked at.
    try { pty.onData((data) => { if (run.pty === pty && this.run === run) { try { this.onData(run.id, data); } catch { /* the window is gone */ } } }); } catch { /* no output to show */ }
    try { pty.onExit((e) => { this.exited.add(pty); if (run.pty === pty && this.run === run) { run.pty = null; this.#exited(run, e?.exitCode); } }); } catch { /* reported by cancel */ }
    this.log(`sign-in started${run.opts.console ? ' (Console)' : ''}`);
    this.#set(run, 'running');
    return { ok: true };
  }

  /** What the user typed, to Claude Code. Never read here. */
  write(id, data) {
    const run = this.#mine(id);
    if (!run?.pty || run.phase !== 'running' || typeof data !== 'string' || !data || data.length > MAX_INPUT) return;
    try { run.pty.write(data); } catch { /* it is ending */ }
  }

  resize(id, cols, rows) {
    const run = this.#mine(id);
    if (!run?.pty || !size(cols) || !size(rows)) return;
    try { run.pty.resize(cols, rows); } catch { /* it is ending */ }
  }

  /**
   * "Open in Terminal instead": stop the sign-in here and run the same one in Terminal. It stays open, and is
   * checked each time the user comes back (`focused`) or asks (`check`).
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async toTerminal(id) {
    const run = this.#mine(id);
    if (!run || !this.openTerminal || !['ready', 'running', 'failed', 'terminal'].includes(run.phase)) return { ok: false, message: 'Terminal couldn’t be opened.' };
    clearTimeout(run.timer);
    let r = null;
    try { r = await this.openTerminal(terminalScript({ claudePath: run.claudePath, base: run.base, env: run.env, args: signInArgs(run.opts) })); } catch { r = null; }
    if (this.run !== run) return { ok: false, message: 'That sign-in is closed.' };
    if (r?.ok !== true) return { ok: false, message: str(r?.message) ?? 'Terminal couldn’t be opened.' };
    this.#hangUp(run);
    this.log('sign-in handed to Terminal');
    this.#set(run, 'terminal');
    return { ok: true };
  }

  /** Ask Claude Code now whether the sign-in went through (after Terminal, or after a check that could not be made). */
  check(id) {
    const run = this.#mine(id);
    if (!run || (run.phase !== 'terminal' && !(run.phase === 'failed' && run.code === 'unverified'))) return Promise.resolve({ ok: false });
    return this.#confirm(run, run.phase).then(() => ({ ok: true }));
  }

  /** The user came back to the window: a sign-in that went to Terminal is looked at again. */
  focused() { if (this.run?.phase === 'terminal') this.check(this.run.id); }

  /** Close the sign-in: Claude Code's sign-in is stopped if it is running. */
  cancel(id) {
    const run = this.#mine(id);
    if (!run) return { ok: false };
    this.#close(run, run.code ? no(run.code, WHY[run.code] ?? WHY.failed) : no('cancelled', 'The sign-in was cancelled.'));
    return { ok: true };
  }

  /** The window that showed it is gone, or Canopy is quitting. */
  stop() { if (this.run) this.#close(this.run, no('cancelled', 'The sign-in was cancelled.')); }

  // ---- internals ----

  #mine(id) { return this.run && typeof id === 'string' && this.run.id === id ? this.run : null; }

  #view(run) {
    return {
      id: run.id, engine: 'claude', phase: run.phase, account: run.accountId, label: run.label,
      console: run.opts.console, canSwitch: run.canSwitch, code: run.code, message: run.message, who: run.who,
    };
  }

  #tell(run) { try { this.onState(this.#view(run)); } catch { /* the window is gone */ } }

  #set(run, phase, code = null, message = null) {
    run.phase = phase;
    run.code = code;
    run.message = code ? WHY[code] ?? WHY.failed : message;
    this.#tell(run);
  }

  // Stop Claude Code's sign-in without waiting for it: what it says from here on is no longer this run's.
  #hangUp(run) {
    const pty = run.pty;
    run.pty = null;
    if (!pty) return;
    try { pty.kill(); } catch { /* already gone */ }
    const t = setTimeout(() => { if (!this.exited.has(pty)) { try { pty.kill('SIGKILL'); } catch { /* gone */ } } }, this.killMs);
    t.unref?.();
  }

  #exited(run, exitCode) {
    this.log(`sign-in exited (${Number.isInteger(exitCode) ? exitCode : 'no exit code'})`);
    if (exitCode !== 0) { this.#set(run, 'failed', 'failed'); return; }
    this.#confirm(run, 'failed');
  }

  // Claude Code says its sign-in worked: ask it who is signed in. `back`: where the run goes if that is nobody.
  async #confirm(run, back) {
    if (run.checking) return run.checking;
    this.#set(run, 'checking');
    run.checking = (async () => {
      const r = await confirmSignIn({ claudePath: run.claudePath, env: run.env, dir: run.dir, ask: this.ask });
      if (this.run !== run) return;
      if (!r.ok) {
        this.log(`sign-in not confirmed (${r.code})`);
        // In Terminal the user may simply not be done yet: that is not a failure, the sign-in keeps waiting there.
        if (back === 'terminal' && r.code === 'signed-out') this.#set(run, back, null, 'Not signed in yet.');
        else this.#set(run, back, r.code);
        return;
      }
      const result = { ok: true, accountId: run.accountId, dir: run.dir, who: r.who };
      let named = null;
      try { named = await this.onSignedIn?.(result); } catch (err) { this.log(`after sign-in: ${err?.message ?? err}`); }
      if (this.run !== run) return;
      this.log(`sign-in confirmed (${r.who.kind})`);
      run.who = { label: str(named?.label) ?? labelFor(r.who), email: r.who.email };
      this.#close(run, result, 'done');
    })().catch((err) => { this.log(`sign-in check failed: ${err?.message ?? err}`); }).finally(() => { run.checking = null; });
    return run.checking;
  }

  // The sign-in is over: stop what runs, tell the window, answer whoever opened it.
  #close(run, result, phase = 'closed') {
    clearTimeout(run.timer);
    this.#hangUp(run);
    if (this.run === run) this.run = null;
    run.phase = phase;
    run.code = null;
    run.message = null;
    this.#tell(run);
    const resolve = run.resolve;
    run.resolve = null;
    resolve?.(result);
  }
}

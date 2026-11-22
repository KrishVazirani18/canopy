// Signing in again, and noticing a login that is gone: host side.
//
// Two jobs, both thin on purpose (main.mjs only says where things are and calls the hooks this returns):
//
//   1. Noticing. The registry (src/core/accounts.mjs) only changes what it says about a login when the tool itself
//      says so. This file decides when to ask again: when a chat's turn fails to sign in (asked before anything
//      flips, so one refused request never signs anyone out), when you come back to the window, and when the
//      terminal view closes (you may have run /logout there). It also keeps a chat whose login is known to be gone
//      from being started ahead of its first message.
//   2. Signing in. Claude Code's own sign-in, in a terminal in the window (src/core/signin.mjs). Canopy has no
//      sign-in field: the window's terminal and Claude Code talk to each other, and this file only passes the
//      bytes along. Once Claude Code confirms the sign-in, everything that said "signed out" is asked again, and
//      open chats pick the login up.
//
// What the window may ask for: a sign-in for an account already in the registry, or for Claude Code's own login.
// A sign-in into any other folder can only be started from here, in the main process (`signIn({ dir })`).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SignIn } from './core/signin.mjs';

const FOCUS_OK_MS = 10 * 60_000;  // nothing is wrong: coming back to the window asks again only after this long
const FOCUS_BROKEN_MS = 5_000;    // a login needs you: coming back is most likely "I fixed it"
const TURN_EVERY_MS = 10_000;     // one failed turn says so several times: ask once
const START_FRESH_MS = 60_000;    // the check a launch starts with is not repeated for the window's first question
const INIT_WAIT_MS = 3_000;       // the longest the first screen waits to learn whether any login ever worked
const SCRIPT_KEPT_MS = 60_000;    // how long Terminal gets to read the sign-in script before it is deleted

// States in which an account cannot be launched until you do something about it (the registry's own list).
const NEEDS_YOU = new Set(['signed-out', 'expired', 'mismatch', 'missing', 'locked', 'invalid-key', 'blocked']);
// A turn that could not sign in, in each of the ways a chat reports it.
const authTrouble = (ev) => (ev?.kind === 'turn-end' && ev.errorCode === 'auth')
  || (ev?.kind === 'notice' && (ev.code === 'auth' || (ev.code === 'api-error' && ev.apiError === 'authentication_failed')));

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * Wire signing in and the checks around it.
 * @param {(channel: string, fn: Function) => void} handle main's guarded `ipcMain.handle`
 * @param {{
 *   accounts: import('./core/accounts.mjs').Accounts,
 *   claude: () => ({ path: string | null, env: object | null }),   where Claude Code is and what it is launched with
 *   spawn: (file: string, args: string[], opts: object) => object, node-pty's `spawn`
 *   on: (channel: string, fn: Function) => void,                    main's guarded `ipcMain.on` (typing, resizing)
 *   send: (channel: string, ...args: unknown[]) => void,
 *   sessions?: () => ({ all: object[], shown: object[] }),          Claude's open chats, and the ones on screen
 *   ready?: () => unknown,                                          resolves once the launch's environment check is done
 *   auth?: () => ({ loggedIn: boolean | null } | null | undefined), what that check found for Claude Code
 *   recheck?: () => unknown,                                        run the environment check again
 *   openFile?: (file: string) => Promise<string>,                   open a file with its app ('' when it worked)
 *   tmp?: () => string,                                             where temporary files go
 *   onFocus?: (fn: () => void) => void, onPageGone?: (fn: () => void) => void,
 *   log?: (msg: string) => void, now?: () => number,
 *   ask?: Function, initWaitMs?: number,                            test seams: `claude auth status` after a sign-in, and the first screen's wait
 * }} host
 */
export function registerSignIn(handle, { accounts, claude, spawn, on, send, sessions, ready, auth, recheck, openFile, tmp, onFocus, onPageGone, log, now = Date.now, ask, initWaitMs = INIT_WAIT_MS } = {}) {
  const say = (msg) => { try { log?.(msg); } catch { /* logging never breaks a check */ } };
  const chats = () => { try { const c = sessions?.() ?? {}; return { all: c.all ?? [], shown: c.shown ?? [] }; } catch { return { all: [], shown: [] }; } };
  const claudeAccount = (id) => { try { return accounts.get('claude', id ?? null); } catch { return null; } };

  // ---- noticing ----

  // Every Claude account that needs you, by id.
  const troubled = () => new Set(accounts.view().list.filter((a) => a.engine === 'claude' && NEEDS_YOU.has(a.state)).map((a) => a.id));

  /**
   * A login is usable again: the chats on it pick it up. One on screen restarts now (or starts, if it was held
   * back); one in the background is only stopped, and starts on its next message, so they never all start at once.
   * A chat that is working is left to finish.
   */
  function revive(ids) {
    if (!ids.size) return;
    const found = claudeAccount(null)?.id ?? null;
    const { all, shown } = chats();
    for (const s of all) {
      try {
        if (!s || s.closed || s.parked || s.engine === 'codex') continue;
        if (!ids.has(s.accountId ?? found)) continue;
        const onScreen = shown.includes(s);
        if (s.q) { if (onScreen) s.recycle?.('sign-in'); else if (!s.working) s.stop?.(); }
        else if (onScreen && !s.working) s.warm?.();
      } catch (err) { say(`could not restart a chat after sign-in: ${err?.message ?? err}`); }
    }
  }

  /** Ask the tools again, and let chats pick up a login that came back. Never rejects. */
  async function look(why, opts) {
    const before = troubled();
    say(`asking again (${why})`);
    const view = await accounts.refresh(opts);
    const back = new Set(view.list.filter((a) => a.engine === 'claude' && a.state === 'ok' && before.has(a.id)).map((a) => a.id));
    revive(back);
    return view;
  }

  let turnAskedAt = 0;
  /** Every event of every chat passes here: a turn that could not sign in makes Canopy ask Claude Code. */
  function chatEvent(ev, entry) {
    if (entry?.engine === 'codex' || !authTrouble(ev)) return;
    if (now() - turnAskedAt < TURN_EVERY_MS) return;
    turnAskedAt = now();
    look('a chat could not sign in');
  }

  /** May this chat be started ahead of its first message? Not when its login is known to be gone. */
  function canWarm(session) {
    if (!session || session.engine === 'codex') return true;
    const a = claudeAccount(session.accountId);
    if (a) return !NEEDS_YOU.has(a.state);
    // No account is listed for it. A chat on whatever Claude Code finds is still held back when the launch's own
    // check found Claude Code signed out (a login that never worked is not listed, and is just as gone).
    if (session.accountId != null) return true;
    try { return auth?.()?.loggedIn !== false; } catch { return true; }
  }

  function focused() {
    runner.focused();
    let known = false;
    try { known = !!claude?.()?.path; } catch { known = false; }
    if (!known || accounts.checking > 0) return; // nothing to ask yet, or already asking
    const broken = NEEDS_YOU.has(claudeAccount(accounts.pin('claude'))?.state);
    if (now() - (accounts.checkedAt || 0) < (broken ? FOCUS_BROKEN_MS : FOCUS_OK_MS)) return;
    look('back in the window');
  }

  let terminalOpen = false;
  const terminalOpened = () => { terminalOpen = true; };
  /** The terminal view closed: you may have signed in or out there. */
  function terminalClosed() {
    if (!terminalOpen) return;
    terminalOpen = false;
    look('the terminal view closed');
  }

  /**
   * For the window's first screen: has any login ever worked on this Mac? Only when Claude Code is signed out and
   * nothing is known yet does this wait (briefly) for the launch's check, which may be about to find one.
   */
  async function atInit() {
    const ever = () => accounts.view().list.some((a) => accounts.get(a.engine, a.id)?.lastOkAt);
    let out = false;
    try { out = auth?.()?.loggedIn === false; } catch { out = false; }
    if (out && !ever()) await Promise.race([accounts.refresh({ maxAgeMs: START_FRESH_MS }), sleep(initWaitMs)]);
    return { everSignedIn: ever() };
  }

  let asked = false;
  // The window's question at launch: "is anything signed out?" Answered once the launch's own check is in, and
  // `first` only the first time, so the prompt is shown once per launch however often the window reloads.
  handle('signin:start-check', async () => {
    try { await ready?.(); } catch { /* answered with what is known */ }
    const view = await accounts.refresh({ maxAgeMs: START_FRESH_MS });
    const first = !asked;
    asked = true;
    return { first, accounts: view };
  });

  // "Use Console" beside a login that is gone is the accounts' own switch (`accounts:use`, src/account-actions.mjs):
  // there is one way to choose the account new chats use, and it is not here.

  // ---- signing in ----

  const scripts = new Set(); // folders holding a sign-in script for Terminal, until they are deleted
  const forget = (dir) => { scripts.delete(dir); rm(dir, { recursive: true, force: true }).catch(() => {}); };
  /** Run a script in Terminal: written to a folder only this user can read, opened, and deleted a minute later. */
  async function openTerminal(script) {
    if (typeof openFile !== 'function' || typeof tmp !== 'function') return { ok: false, message: 'Terminal couldn’t be opened.' };
    let dir = null;
    try {
      dir = await mkdtemp(path.join(tmp(), 'canopy-signin-'));
      scripts.add(dir);
      const file = path.join(dir, 'Sign in to Claude Code.command');
      await writeFile(file, script, { mode: 0o700 });
      const failed = await openFile(file);
      const t = setTimeout(() => forget(dir), SCRIPT_KEPT_MS);
      t.unref?.();
      if (failed) { say(`Terminal did not open: ${String(failed).slice(0, 200)}`); return { ok: false, message: 'Terminal couldn’t be opened.' }; }
      return { ok: true };
    } catch (err) {
      if (dir) forget(dir);
      say(`Terminal did not open: ${err?.code ?? err?.message ?? err}`);
      return { ok: false, message: 'Terminal couldn’t be opened.' };
    }
  }

  /** Claude Code confirmed a sign-in: everything that said "signed out" is asked again, and chats pick it up. */
  async function signedIn(result) {
    try { await recheck?.(); } catch (err) { say(`environment check after sign-in: ${err?.message ?? err}`); }
    const view = await accounts.refresh();
    // A folder that is not in the registry yet has no chats: whoever asked for the sign-in adds the account.
    const id = result.accountId ?? (result.dir ? null : claudeAccount(null)?.id ?? null);
    if (!id) return null;
    revive(new Set([id]));
    return { label: view.list.find((a) => a.engine === 'claude' && a.id === id)?.label ?? null };
  }

  const runner = new SignIn({
    spawn, tool: claude, account: (id) => accounts.get('claude', id),
    onData: (id, data) => send?.('signin:data', id, data),
    onState: (state) => send?.('signin:state', state),
    onSignedIn: signedIn, openTerminal,
    log: (m) => say(m), ...(typeof ask === 'function' && { ask }),
  });

  // The window names an account it already shows, or none (Claude Code's own login). Never a folder.
  handle('signin:begin', async (o) => {
    if (o?.engine !== 'claude') return { ok: false, code: 'unsupported', message: 'Signing in to that isn’t available here yet.' };
    const r = runner.begin({ accountId: typeof o.accountId === 'string' ? o.accountId : null });
    return r.ok ? { ok: true, id: r.id } : r;
  });
  handle('signin:attach', async (id, cols, rows, how) => runner.attach(id, cols, rows, typeof how?.console === 'boolean' ? { console: how.console } : undefined));
  handle('signin:terminal', async (id) => runner.toTerminal(id));
  handle('signin:check', async (id) => runner.check(id));
  handle('signin:cancel', async (id) => runner.cancel(id));
  on?.('signin:input', (id, data) => runner.write(id, data));
  on?.('signin:resize', (id, cols, rows) => runner.resize(id, cols, rows));

  try { onFocus?.(() => focused()); } catch { /* no window to come back to */ }
  // The page that showed the sign-in is gone (reloaded, crashed): its terminal went with it.
  try { onPageGone?.(() => runner.stop()); } catch { /* nothing to watch */ }

  return {
    /**
     * Start a sign-in from the main process and wait for how it ends. The window shows it on its own.
     * `{ accountId }`: an account in the registry. `{ dir }`: an account folder that is not in it yet.
     * `console`, `sso`, `email`, `label`: see SignIn.begin. Never rejects.
     * @returns {Promise<{ ok: true, accountId: string | null, dir: string | null, who: object } | { ok: false, code: string, message: string }>}
     */
    signIn(opts) { const r = runner.begin(opts); return r.ok ? r.done : Promise.resolve(r); },
    chatEvent, canWarm, focused, terminalOpened, terminalClosed, atInit,
    /** Quitting: a sign-in still running is stopped, and a script left for Terminal is deleted. */
    stop() { runner.stop(); for (const dir of [...scripts]) forget(dir); },
    runner,
  };
}

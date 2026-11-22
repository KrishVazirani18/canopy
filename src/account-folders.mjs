// Accounts in folders of their own, host side: adding a second Claude Code sign-in, removing one, and keeping
// their folders in order so the user never has to look at them.
//
// The folder itself (links, the config copy, deletion) is src/account-home.mjs, and the list of accounts is the
// registry (src/core/accounts.mjs). This file is what happens between the two:
//
//   guard(account, base)   before every launch on an account folder: links put back, connectors and trusted
//                          folders brought in line, and a folder that cannot be used refuses the launch
//   add({ kind })          make a folder, have Claude Code sign in to it, check what it signed in as
//   remove(id)             have Claude Code sign the folder out, delete it, drop the account
//   repair()               at start and after each Claude Code update: every account folder looked over
//   syncAll()              the user's connectors may have changed: bring every account folder in line
//
// Canopy holds no login here either. Signing in is Claude Code's own `claude auth login`, shown as it is by
// whatever the host hands in as `signIn`. Who signed in is what `claude auth status` says afterwards. Signing out is
// Claude Code's own `claude auth logout`, and it is never run without the account's folder named.
//
// Contract: nothing here throws or rejects except `guard`, which throws `refuse(...)` on purpose.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refuse } from './core/accounts.mjs';
import { claudeAccounts, launchEnv } from './core/accounts-claude.mjs';
import { authStatus, configHome } from './core/env.mjs';
import { claudeConfigFiles } from './core/trust.mjs';
import { accountsRoot, create, health, relink, remove as removeFolder, strangers, syncConfig } from './account-home.mjs';

export { accountsRoot };

// Why an account folder cannot be used, as the second half of "Max can’t be used: …".
const WHY = {
  'no-base': 'Claude Code’s own folder is missing',
  'no-history': 'Claude Code has no chat history yet. Start one chat on your main account first',
  outside: 'its folder is not where Canopy keeps accounts',
  'not-a-folder': 'its folder is not a folder anymore',
  failed: 'its folder could not be set up',
};
// Trouble that can pass without anyone touching the account: such a folder is looked at again by itself.
const CAN_PASS = new Set(['no-base', 'no-history', 'failed']);
// Why a sign-in that Claude Code finished was still not added.
const NOT_ADDED = {
  'signed-out': 'Claude Code did not finish signing in, so nothing was added.',
  expired: 'Claude Code did not finish signing in, so nothing was added.',
  mismatch: 'Claude Code answered for a different login, so nothing was added.',
  blocked: 'Your Claude Code settings choose the login, so a second sign-in would never be used.',
  unknown: 'Claude Code did not confirm the sign-in. Try again.',
};

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' && v ? v : null);
const isAbs = (p) => typeof p === 'string' && p.length > 0 && path.isAbsolute(p);
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const no = (code, message, extra) => ({ ok: false, code, message, ...extra });
const there = (p) => { try { lstatSync(p); return true; } catch { return false; } };

// A folder that always exists and carries no project settings: where the sign-out runs.
function neutral() {
  const home = os.homedir();
  try { if (statSync(home).isDirectory()) return home; } catch { /* fall through */ }
  return os.tmpdir();
}

/**
 * Run Claude Code's own sign-out for one account folder. The folder is named in the environment handed in, and
 * nothing is run without it: a sign-out with no folder named would sign the user's own Claude Code out.
 * @param {{ claudePath: string, env: Record<string, string>, dir: string }} o
 * @returns {Promise<{ ok: boolean }>} never rejects
 */
export function runSignOut({ claudePath, env, dir } = {}) {
  return new Promise((resolve) => {
    if (!isAbs(claudePath) || !isAbs(dir) || !isPlain(env) || env.CLAUDE_CONFIG_DIR !== dir) return resolve({ ok: false });
    try {
      const child = execFile(claudePath, ['auth', 'logout'], { env, cwd: neutral(), timeout: 30_000, killSignal: 'SIGKILL', windowsHide: true }, (err) => resolve({ ok: !err }));
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    } catch { resolve({ ok: false }); }
  });
}

export class AccountFolders {
  /**
   * @param {{
   *   accounts: object | (() => object),            the registry (src/core/accounts.mjs), or a getter for it
   *   root: string | (() => string | null),         where account folders are kept (see accountsRoot)
   *   claude: () => ({ path: string | null, env: object | null }),   where Claude Code is and the user's own environment
   *   signIn?: ((o: { dir: string, console: boolean }) => Promise<{ ok: boolean, code?: string, message?: string }>) | null,
   *                                                 shows Claude Code's own `claude auth login` for one folder
   *                                                 (CLAUDE_CONFIG_DIR = dir; `--console` when asked) and resolves
   *                                                 when it ends. Without one, nothing can be added.
   *   inUse?: (id: string) => 'working' | 'idle' | null,   what is running on an account: a chat at work (or the
   *                                                 terminal, or a sign-in), only idle chats, or nothing
   *   stopIdle?: (id: string) => Promise<unknown>,  stop the idle chats on an account (they start again when written to)
   *   onRemoved?: (id: string, was: { active: boolean }) => void,   an account left the list (`active`: it was the one
   *                                                 new chats used, so they are back on the login Claude Code finds)
   *   drift?: (label: string, keys: string[]) => void,     something about Claude Code changed (see upkeep.mjs)
   *   log?: (msg: string) => void,
   *   ask?: typeof authStatus, signOut?: typeof runSignOut,   test seams
   *   retryMs?: number, timers?: { set: Function, clear: Function },
   * }} host
   */
  constructor({ accounts, root, claude, signIn = null, inUse, stopIdle, onRemoved, drift, log, ask = authStatus, signOut = runSignOut, retryMs = 5000, timers } = {}) {
    this.accountsFn = typeof accounts === 'function' ? accounts : () => accounts;
    this.rootFn = typeof root === 'function' ? root : () => root;
    this.claude = typeof claude === 'function' ? claude : () => ({ path: null, env: null });
    this.signIn = typeof signIn === 'function' ? signIn : null;
    this.inUseFn = typeof inUse === 'function' ? inUse : () => null;
    this.stopIdleFn = typeof stopIdle === 'function' ? stopIdle : async () => {};
    this.onRemoved = typeof onRemoved === 'function' ? onRemoved : null;
    this.driftFn = typeof drift === 'function' ? drift : () => {};
    this.logFn = typeof log === 'function' ? log : () => {};
    this.askFn = ask;
    this.signOutFn = signOut;
    this.retryMs = retryMs;
    this.timers = timers ?? { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (t) => clearTimeout(t) };

    this.adding = false;
    this.held = new Set();       // accounts being added or removed: nothing else touches their folder meanwhile
    this.removing = new Set();   // of those, the ones on their way out: nothing is launched on them
    this.pending = new Set();    // accounts whose config is behind the user's, waiting for their chats to finish
    this.troubled = new Set();   // accounts marked because their folder could not be put in order, for a reason that can pass
    this.said = new Map();       // what was last logged about an account, so the same trouble is logged once
    this.timer = null;
    this.stopped = false;
    this.repairs = Promise.resolve();
    this.seenVersion = null;
    // The questions the registry's Claude engine asks, asked here with every `auth status` answer looked over for
    // fields that have gone missing. `plain` asks about a folder as it stands, without putting it in order first.
    const asked = (claudePath, env) => this.#asked(claudePath, env);
    this.engine = claudeAccounts({ tool: this.claude, ask: asked, home: this.guard });
    this.plain = claudeAccounts({ tool: this.claude, ask: asked });
  }

  // ---- before every launch ----

  /**
   * The Claude engine calls this before an account folder is used for anything: a chat, the terminal, a question
   * to Claude Code. Its links are put back (nothing happens when they are in place), its connectors and trusted
   * folders are brought in line if nothing is running on it, and a folder that is not fit to launch on stops the
   * launch. An account never starts with part of the user's setup missing: their settings carry their permissions.
   * @throws a `refuse` error, with `canopy.why`
   */
  guard = (account, base, { name = 'This account' } = {}) => {
    if (!isPlain(account) || !str(account.dir) || !isPlain(base)) return;
    // On its way out: nothing starts on it. Said as a passing state, so a check that runs meanwhile marks nothing.
    if (this.removing.has(account.id)) throw refuse('account-missing', `${name} is being removed.`, { account: account.id, recoverable: true });
    const where = this.#places(base);
    const r = relink({ dir: account.dir, root: where.root, baseHome: where.baseHome });
    this.#linked(account.id, r);
    if (r.code === 'missing') return; // the recipe refuses that itself, as "its folder is missing"
    if (!r.ok) {
      const why = WHY[r.code] ?? WHY.failed;
      throw refuse('account-blocked', `${name} can’t be used: ${why}.`, { account: account.id, why });
    }
    if (!this.held.has(account.id)) this.#sync(account, where);
  };

  // ---- adding ----

  /**
   * Add a Claude sign-in beside the one Claude Code holds: a plan, or a Console sign-in.
   * The account is in the list, signed out, from the moment its folder exists, so a sign-in cut short (Canopy quit)
   * leaves a row the user can sign in to or remove, never a folder nobody knows about. It counts as added only once
   * Claude Code says, for that very folder, who is signed in; the same login twice is taken back.
   * @param {{ kind?: 'plan' | 'console' }} [o]
   * @returns {Promise<{ ok: true, id: string } | { ok: false, code: string, message?: string, existing?: string }>}
   */
  async add({ kind = 'plan' } = {}) {
    if (kind !== 'plan' && kind !== 'console') return no('invalid', 'That is not a kind of sign-in Canopy can add.');
    const { path: claudePath, env } = this.#tool();
    const accounts = this.#accounts();
    const root = this.root;
    if (!claudePath || !env || !accounts || !root) return no('no-env', 'Canopy has not finished checking your setup yet.');
    // Asked first, so that nothing at all is made when there is no way to sign in.
    if (!this.signIn) return no('unavailable', 'Signing in from Canopy is not available yet.');
    if (this.adding) return no('busy', 'Finish the sign-in that is already open first.');
    this.adding = true;
    let account = null;
    let listed = false;
    try {
      const where = this.#places(env);
      const id = this.#newId(accounts, root);
      if (!id) return no('failed', 'Canopy could not make a folder for the account.');
      account = { id, engine: 'claude', kind, dir: path.join(root, id), state: 'signed-out' };
      this.held.add(id);
      const made = create({ dir: account.dir, root, baseHome: where.baseHome });
      if (!made.ok) {
        await removeFolder({ dir: account.dir, root, baseHome: where.baseHome }); // nothing was signed in: only the folder, if one was made
        return no(made.code, `${cap(WHY[made.code] ?? WHY.failed)}.`);
      }
      const added = accounts.add(account);
      if (!added.ok) { await removeFolder({ dir: account.dir, root, baseHome: where.baseHome }); return added; }
      listed = true;
      this.log(`${id}: folder made, signing in (${kind})`);

      let r = null;
      try { r = await this.signIn({ dir: account.dir, console: kind === 'console' }); }
      catch { r = { ok: false, code: 'failed', message: 'Claude Code’s sign-in could not be shown.' }; } // what went wrong inside it is not passed on
      if (r?.ok !== true) {
        await this.#takeBack(account);
        return no(str(r?.code) ?? 'cancelled', str(r?.message) ?? undefined);
      }

      // Claude Code says who is signed in, and must say it for this very folder.
      const v = await this.engine.verify(account);
      if (v?.state !== 'ok') {
        await this.#takeBack(account);
        return no(`not-${v?.state ?? 'unknown'}`, v?.state === 'blocked' && v.why && v.why !== 'your Claude Code settings choose the login' ? `${cap(v.why)}.` : NOT_ADDED[v?.state] ?? NOT_ADDED.unknown);
      }
      const twin = this.#twin(accounts, v, id);
      if (twin) {
        await this.#takeBack(account);
        return no('duplicate', `${twin.name} is already in Canopy.`, { existing: twin.id });
      }
      // Nothing can be running on it yet: it is still listed as signed out.
      this.#sync(account, where, () => true);
      accounts.note(id, v);
      this.log(`${id}: signed in (${v.kind})`);
      return { ok: true, id };
    } catch (err) {
      this.log(`add failed: ${err?.message ?? err}`);
      if (listed) { try { await this.#takeBack(account); } catch { /* it stays listed, signed out, for the user to remove */ } }
      return no('failed', 'Canopy could not add the account.');
    } finally {
      this.adding = false;
      if (account) this.held.delete(account.id);
    }
  }

  // ---- removing ----

  /**
   * Remove an account Canopy keeps in a folder: Claude Code signs that folder out (only that folder), the folder
   * is deleted, and the account leaves the list. Idle chats on it are stopped first; a chat at work is not.
   * What the folder linked to (the user's chats, settings and the rest) is not touched. An account whose saved
   * folder is not one of Canopy's is only forgotten: that folder is left exactly as it is.
   * @returns {Promise<{ ok: true } | { ok: false, code: string, message?: string }>}
   */
  async remove(id) {
    const accounts = this.#accounts();
    const a = accounts ? this.#folderAccounts().find((x) => x.id === id) : null;
    if (!a) return no('not-a-folder-account', 'That account is not one Canopy keeps a sign-in for.');
    const name = this.#name(a.id);
    if (this.held.has(a.id)) return no('busy', `${name} is still being set up.`);
    const working = () => no('working', `A chat is still working on ${name}. Remove it when the chat is done.`);
    if (this.#inUse(a.id) === 'working') return working();
    this.held.add(a.id);
    try {
      try { await this.stopIdleFn(a.id); } catch { /* looked at again just below */ }
      if (this.#inUse(a.id) !== null) return working();
      this.removing.add(a.id); // from here on nothing is launched on it
      const r = await this.#delete(a);
      // A saved folder that is not one of Canopy's (the list was edited, or the home folder moved): the account is
      // only forgotten. Nothing is run against that folder and nothing in it is deleted, whatever it is.
      const foreign = !r.ok && r.code === 'outside';
      if (!r.ok && !foreign) {
        this.log(`${a.id}: not removed (${r.code})`);
        return r.code === 'still-signed-in'
          ? no(r.code, `Claude Code could not sign ${name} out, so it was kept. Try again.`)
          : no(r.code, `Canopy could not delete the folder for ${name}.`);
      }
      const gone = accounts.remove('claude', a.id);
      this.pending.delete(a.id);
      this.troubled.delete(a.id);
      this.said.delete(a.id);
      if (gone?.ok) { try { this.onRemoved?.(a.id, { active: gone.wasActive === true }); } catch { /* a listener never undoes a removal */ } }
      if (foreign) this.log(`${a.id}: forgotten; its folder is not one of Canopy's and was left as it is`);
      else if (r.signedOut !== true) this.log(`${a.id}: removed, though Claude Code did not confirm the sign-out`);
      return { ok: true };
    } catch (err) {
      this.log(`remove failed: ${err?.message ?? err}`);
      return no('failed', `Canopy could not remove ${name}.`);
    } finally {
      this.removing.delete(a.id);
      this.held.delete(a.id);
    }
  }

  // ---- keeping in order ----

  /**
   * Look over every account folder: its links, its connectors and trusted folders, and whether Claude Code still
   * says it is signed in. Run at start and after each Claude Code update; safe at any time. One run at a time.
   * An account whose folder cannot be put in order, or whose sign-in is gone, is marked so in the list.
   * @returns {Promise<{ checked: number }>}
   */
  repair(why = 'check') {
    const run = () => this.#repair(why).catch((err) => { this.log(`repair failed: ${err?.message ?? err}`); return { checked: 0 }; });
    this.repairs = this.repairs.then(run, run);
    return this.repairs;
  }

  async #repair(why) {
    const { path: claudePath, env } = this.#tool();
    const accounts = this.#accounts();
    const list = this.#folderAccounts().filter((a) => !this.held.has(a.id));
    if (!claudePath || !env || !accounts || !list.length) return { checked: 0 };
    const where = this.#places(env);
    // Something in Claude Code's folder that Canopy has never seen: account folders may be going without it.
    const odd = strangers(where.baseHome);
    if (odd.length) this.#drift('accounts: something new in Claude Code’s folder', odd);
    for (const a of list) {
      if (this.held.has(a.id)) continue; // being removed since the list was read
      const before = health({ dir: a.dir, root: where.root, baseHome: where.baseHome });
      if (before.wrong.length) this.log(`${a.id}: ${before.wrong.join(', ')} needed putting back (${why})`);
      const v = await this.engine.verify(a); // puts the folder in order first (see `guard`), then asks Claude Code
      if (this.held.has(a.id)) continue;
      accounts.note(a.id, v);
      // An account marked for trouble that can pass (the user has no chat history yet) comes back by itself.
      const fit = relink({ dir: a.dir, root: where.root, baseHome: where.baseHome });
      if (!fit.ok && CAN_PASS.has(fit.code)) { this.troubled.add(a.id); this.#later(); } else this.troubled.delete(a.id);
    }
    return { checked: list.length };
  }

  /**
   * Claude Code's version, as upkeep reports it. The first one heard (at start) and every change after it (an
   * update, Canopy's or Claude Code's own) sets off a repair.
   */
  onClaudeVersion(version) {
    if (!str(version) || version === this.seenVersion) return;
    const first = this.seenVersion === null;
    this.seenVersion = version;
    this.repair(first ? 'start' : 'update');
  }

  /**
   * The user's connectors or trusted folders may have changed: bring every account folder in line. Where idle
   * chats are in the way they are stopped (they start again on their next message, with the new connectors);
   * an account with a chat at work waits, and is tried again shortly.
   */
  async syncAll() {
    try {
      const { env } = this.#tool();
      if (!env) return;
      const where = this.#places(env);
      for (const a of this.#folderAccounts()) if (!this.held.has(a.id)) this.#sync(a, where);
      await this.#settle();
    } catch (err) { this.log(`sync failed: ${err?.message ?? err}`); }
  }

  /** Stop looking again later (the app is quitting). */
  stop() {
    this.stopped = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }

  // ---- internals ----

  get root() { try { const r = this.rootFn(); return isAbs(r) ? r : null; } catch { return null; } }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a call */ } }
  #drift(label, keys) { try { this.driftFn(label, keys); } catch { /* an observer never breaks a call */ } }
  #accounts() { try { const a = this.accountsFn(); return a && typeof a.entries === 'function' ? a : null; } catch { return null; } }
  #tool() {
    try { const t = this.claude() ?? {}; return { path: str(t.path), env: isPlain(t.env) ? t.env : null }; }
    catch { return { path: null, env: null }; }
  }
  #inUse(id) { try { const u = this.inUseFn(id); return u === 'working' || u === 'idle' ? u : null; } catch { return 'working'; } } // cannot tell: assume the worst
  #occupied(id) { return this.held.has(id) || this.#inUse(id) !== null; }
  #folderAccounts() { try { return (this.#accounts()?.entries('claude') ?? []).filter((a) => str(a.dir)); } catch { return []; } }
  #name(id) { try { return str(this.#accounts()?.view().list.find((a) => a.id === id)?.label) ?? 'this account'; } catch { return 'this account'; } }

  // The user's own Claude Code folder and config file, for the environment an account is launched from.
  #places(base) { return { root: this.root, baseHome: configHome(base), baseConfig: claudeConfigFiles(base) }; }

  #newId(accounts, root) {
    const taken = new Set([...accounts.entries('claude'), ...accounts.entries('codex')].map((a) => a.id));
    for (let i = 0; i < 16; i++) {
      const id = `claude-${randomBytes(4).toString('hex')}`;
      if (!taken.has(id) && !there(path.join(root, id))) return id;
    }
    return null;
  }

  // What a pass over the links found. A copy in a link's place means Claude Code rewrote a shared file whole.
  #linked(id, r) {
    if (r.displaced?.length) this.#drift('accounts: Claude Code replaced a link with its own copy', r.displaced);
    if (r.made?.length && r.made.length < r.linked.length) this.log(`${id}: put back ${r.made.join(', ')}`);
    if (r.ok) this.said.delete(id);
    else if (r.code !== 'missing') this.#sayOnce(id, r.code, `${id}: folder not fit to launch on (${r.code}${r.failed?.length ? `: ${r.failed.join(', ')}` : ''})`);
  }
  #sayOnce(key, what, line) { if (this.said.get(key) !== what) { this.said.set(key, what); this.log(line); } }

  // Bring one account's connectors and trusted folders in line. Quiet: nothing fails for it, and what could not
  // be written because a process is running on the account is tried again once it is free.
  #sync(account, where, idle = () => !this.#occupied(account.id)) {
    const r = syncConfig({ dir: account.dir, root: where.root, baseHome: where.baseHome, baseConfig: where.baseConfig, idle });
    const key = `sync:${account.id}`;
    if (!r.ok) { this.#sayOnce(key, r.code, `${account.id}: connectors not copied (${r.code})`); return r; }
    this.said.delete(key);
    if (r.pending) { this.pending.add(account.id); this.#later(); }
    else {
      this.pending.delete(account.id);
      if (r.changed) this.log(`${account.id}: connectors and trusted folders brought in line`);
    }
    return r;
  }

  // The accounts that are behind: stop what is idle on them, write, and look again later for the rest.
  // And the ones whose folder was in trouble: once it can be put in order, Claude Code is asked and the mark comes off.
  async #settle() {
    for (const id of [...this.pending]) {
      const a = this.#folderAccounts().find((x) => x.id === id);
      const { env } = this.#tool();
      if (!a) { this.pending.delete(id); continue; }
      if (!env || this.held.has(id) || this.#inUse(id) === 'working') continue;
      try { await this.stopIdleFn(id); } catch { /* still occupied then: tried again later */ }
      if (!this.held.has(id)) this.#sync(a, this.#places(env));
    }
    for (const id of [...this.troubled]) {
      const a = this.#folderAccounts().find((x) => x.id === id);
      const { env } = this.#tool();
      if (!a) { this.troubled.delete(id); continue; }
      if (!env || this.held.has(id)) continue;
      const where = this.#places(env);
      if (!relink({ dir: a.dir, root: where.root, baseHome: where.baseHome }).ok) continue; // only looked at: nothing is run
      this.troubled.delete(id);
      this.#accounts()?.note(id, await this.engine.verify(a));
    }
    this.#later();
  }
  #later() {
    if (this.timer || this.stopped || (!this.pending.size && !this.troubled.size)) return;
    this.timer = this.timers.set(() => { this.timer = null; return this.#settle().catch(() => {}); }, this.retryMs);
  }

  // Every `auth status` answer passes through here. A signed-in answer says who and for which folder; one that
  // does not means Claude Code changed what it reports, which is worth knowing before accounts quietly stop matching.
  async #asked(claudePath, env) {
    let a = null;
    try { a = await this.askFn(claudePath, env); } catch { a = { loggedIn: null, method: null, org: null }; } // no answer: never "signed out"
    try {
      if (a?.loggedIn === true && (a.method === 'claude.ai' || a.apiKeySource === '/login managed key')) {
        const gone = [['configDirectory', a.configDir], ['email', a.email], ['orgId', a.orgId]].filter(([, v]) => !v).map(([k]) => k);
        if (gone.length) this.#drift('accounts: the sign-in check left something out', gone);
      } else if (a?.loggedIn === true && !a.method) this.#drift('accounts: the sign-in check left something out', ['authMethod']);
    } catch { /* the answer is passed on either way */ }
    return a;
  }

  // The same login, already in Canopy: the same kind of sign-in, the same email, the same organisation.
  #twin(accounts, v, id) {
    if (!str(v.email)) return null; // nothing to tell them apart by: not called a duplicate on a guess
    const hit = accounts.entries('claude').find((a) => a.id !== id && a.kind === v.kind && sameText(a.email, v.email) && (a.orgId ?? null) === (v.orgId ?? null));
    return hit ? { id: hit.id, name: this.#name(hit.id) } : null;
  }

  // Claude Code's own sign-out, for this folder and no other.
  async #signOut(account) {
    const { path: claudePath, env } = this.#tool();
    if (!claudePath || !env) return { ok: false };
    let launch = null;
    try { launch = launchEnv({ kind: account.kind, dir: account.dir }, env); } catch { return { ok: false }; }
    if (launch.CLAUDE_CONFIG_DIR !== account.dir || account.dir === configHome(env)) return { ok: false };
    try { return await this.signOutFn({ claudePath, env: launch, dir: account.dir }); } catch { return { ok: false }; }
  }
  // After a sign-out: true only when Claude Code still names a sign-in for this very folder.
  async #stillIn(account) {
    const v = await this.plain.verify({ ...account, email: null });
    return v?.state === 'ok' ? true : v?.state === 'signed-out' ? false : null;
  }
  #delete(account) {
    const { env } = this.#tool();
    return removeFolder({
      dir: account.dir, root: this.root, baseHome: env ? configHome(env) : undefined,
      logout: () => this.#signOut(account), stillSignedIn: () => this.#stillIn(account),
    });
  }
  // An account that did not get as far as being signed in and checked: its folder is signed out (the sign-in may
  // have got halfway) and deleted, and it leaves the list. If that cannot be done it stays listed, for the user to remove.
  async #takeBack(account) {
    this.removing.add(account.id);
    try {
      const r = await this.#delete(account);
      if (r.ok) this.#accounts()?.remove('claude', account.id);
      else this.log(`${account.id}: could not be taken back (${r.code})`);
    } finally { this.removing.delete(account.id); }
  }
}

/**
 * Wire account folders and their two IPC calls. The window can ask for a sign-in to be added and for an account
 * Canopy added to be removed; it never sees a folder's path, and no answer carries more than a code and a line of text.
 * @param {(channel: string, fn: Function) => void} handle main's guarded `ipcMain.handle`
 * @param {ConstructorParameters<typeof AccountFolders>[0]} host
 * @returns {AccountFolders}
 */
export function registerAccountFolders(handle, host) {
  const folders = new AccountFolders(host);
  handle('account-folders:add', async (kind) => folders.add({ kind: kind === 'console' ? 'console' : 'plan' }));
  handle('account-folders:remove', async (id) => folders.remove(typeof id === 'string' ? id : ''));
  return folders;
}

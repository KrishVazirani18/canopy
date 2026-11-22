// A second Codex login, added and removed from Settings → Codex: the host's half of src/codex-account-home.mjs.
//
// Codex keeps one login per folder. "Add account → Sign in to Codex" makes a folder of Canopy's own for the new login
// (codex-account-home.mjs `create`), starts a Codex helper pointed at that folder, and runs Codex's own browser
// sign-in there: Codex keeps the login in that folder, and Canopy never sees it. Afterwards Codex is asked who signed
// in. A login that is already in Canopy (the same ChatGPT account, in the same workspace) is not added twice.
//
// Every process for such a login is pointed at its folder for the login and at the user's own Codex folder for the
// index of chats (core/accounts-codex-home.mjs), so its chats are in the one list. `guard` is what the registry asks
// before every launch on such a login: the folder is put in order first, and a folder that kept a chat index of its
// own is not launched on.
//
//   CodexAccountFolders      add / cancel / reopen / remove, the sheet's state (`view`), `guard`, `verify`
//   registerCodexFolders     the window's channels
//
// Rules (each has a test in codex-account-folders.test.mjs):
//  - Nothing is created, changed or read in the user's own Codex folder; its login is never touched.
//  - Codex is asked to sign in only by a helper pointed at the new folder (CodexService `home`): it refuses to ask a
//    process that started anywhere else.
//  - One sign-in at a time. A cancelled or failed sign-in leaves nothing behind: no folder, no row.
//  - Removing signs that folder out through Codex, then clears it; the links to the chats stay while a chat is filed
//    under the folder (codex-account-home.mjs `remove`).
//  - Switching between plan logins is the user's own choice, for new chats; nothing here chooses one.
//
// Contract: nothing exported throws, except `guard`, which throws `refuse(...)` on purpose. Async methods resolve.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { refuse } from './core/accounts.mjs';
import { describeAccount, isFolderLogin, sameLogin } from './core/accounts-codex.mjs';
import { signInAddress } from './core/accounts-codex-login.mjs';
import { create, databases, relink, remove as removeHome } from './codex-account-home.mjs';

const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
const WAIT_MS = 10 * 60_000; // a sign-in left open in the browser this long is given up

/** idle: no sheet. starting, waiting, checking: a sign-in is under way. done, failed: it ended, and the sheet says how. */
export const PHASES = Object.freeze(['idle', 'starting', 'waiting', 'checking', 'done', 'failed']);

export class CodexAccountFolders {
  /**
   * @param {{
   *   accounts: () => object,          the registry (Accounts)
   *   root: () => string | null,       where account folders are kept (account-home.mjs `accountsRoot`)
   *   codexHome: () => Promise<string | null>,   the user's own Codex folder, as their Codex reports it when it starts
   *   service: (dir: string) => object,          a Codex helper for a login kept in `dir` (a CodexService with `home`)
   *   own?: object,                    the helper on Codex's own login: says which chats are filed under a folder
   *   open: (url: string) => unknown,  open an address in the user's browser
   *   onChange?: (view: object) => void, log?: (msg: string) => void, newId?: () => string, waitMs?: number,
   * }} deps
   */
  constructor({ accounts, root, codexHome, service, own, open, onChange, log, newId, waitMs } = {}) {
    this.accounts = accounts;
    this.rootFn = root;
    this.codexHomeFn = codexHome;
    this.serviceFor = service;
    this.own = own ?? null;
    this.openFn = open;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.logFn = typeof log === 'function' ? log : () => {};
    this.newId = typeof newId === 'function' ? newId : () => `codex-${randomBytes(6).toString('hex')}`;
    this.waitMs = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : WAIT_MS;
    this.baseHome = null;   // the user's own Codex folder, once Codex has said
    this.phase = 'idle';
    this.message = null;
    this.flow = null;       // { id, dir, svc, loginId, url, stop } while a sign-in is under way
    this.run = 0;
  }

  log(msg) { try { this.logFn(String(msg)); } catch { /* logging never breaks the flow */ } }
  root() { try { const r = this.rootFn?.(); return isAbs(r) ? r : null; } catch { return null; } }
  reg() { try { return this.accounts?.() ?? null; } catch { return null; } }

  /** What the sheet shows. Never who signed in (the list says that), never the page's address. */
  view() { return { phase: this.phase, message: this.message, busy: !!this.flow }; }
  #set(phase, message = null) { this.phase = phase; this.message = message; try { this.onChange(this.view()); } catch { /* the window is told best-effort */ } }

  /** Find out where the user's own Codex keeps its folder (asked once; Codex says so when it starts). */
  async learnHome() {
    if (this.baseHome) return this.baseHome;
    try { const h = await this.codexHomeFn?.(); if (isAbs(h)) this.baseHome = h; } catch { /* not known yet */ }
    return this.baseHome;
  }

  /**
   * Before every launch on a login kept in a folder of its own (the registry's Codex engine calls this): put the
   * folder in order and say where the user's own Codex keeps its chat index. Synchronous.
   * @throws `refuse(...)` when the folder cannot be launched on. Never hands back a place it is unsure of.
   */
  guard(account) {
    const name = account?.label || 'This account';
    if (!isFolderLogin(account)) throw refuse('account-unsupported', `${name} is not an account Codex can be started on.`);
    if (!this.baseHome) { this.learnHome(); throw refuse('no-env', 'Canopy is still checking where Codex keeps your chats. Try again in a moment.', { recoverable: true }); }
    const root = this.root();
    if (!root) throw refuse('account-missing', `The folder for ${name} is missing.`);
    // A database in the folder means a process ran there without being told where the index is, and kept one of
    // its own: launching again would split this login's chats from the rest.
    if (databases(account.dir).length) throw refuse('account-broken', `${name} kept a separate list of chats. Remove it and sign in again.`);
    const r = relink({ dir: account.dir, root, baseHome: this.baseHome });
    if (!r.ok) {
      if (r.code === 'forked') throw refuse('account-broken', `${name} kept a separate list of chats. Remove it and sign in again.`);
      throw refuse('account-missing', `The folder for ${name} could not be put in order.`);
    }
    return { codexHome: this.baseHome };
  }

  /** How a login in a folder of its own is doing: Codex is asked, for that very folder. */
  async verify(account) {
    if (!isFolderLogin(account)) return { state: 'unknown' };
    const svc = this.#service(account.dir);
    if (!svc) return { state: 'unknown' };
    try {
      const d = describeAccount(await svc.account());
      if (d.state === 'ok') return { state: 'ok', kind: 'plan', email: d.email, plan: d.plan, org: d.org ?? null, orgId: d.orgId ?? null };
      if (d.state === 'signed-out' || d.state === 'none') return { state: 'signed-out' };
      return { state: 'unknown' };
    } catch { return { state: 'unknown' }; }
    finally { svc.close?.().catch?.(() => {}); }
  }

  #service(dir) { try { return this.serviceFor?.(dir) ?? null; } catch { return null; } }

  /**
   * Add a login: a folder of its own, Codex's own browser sign-in into it, then Codex is asked who signed in.
   * Resolves when the sign-in has ended: { ok: true, id } or { ok: false, code, message }.
   */
  async add() {
    if (this.flow) return { ok: false, code: 'busy', message: 'A sign-in is already open.' };
    const reg = this.reg();
    const root = this.root();
    const run = ++this.run;
    const f = { id: null, dir: null, svc: null, loginId: null, url: null, stop: null };
    this.flow = f;
    this.#set('starting');
    const gone = () => run !== this.run || this.flow !== f; // cancelled: whatever cancel left is already cleared
    const CANCELLED = { ok: false, code: 'cancelled', message: null };
    const fail = async (code, message) => { await this.#undo(f); if (!gone()) this.#set('failed', message); return { ok: false, code, message }; };
    if (!reg || !root) return fail('unavailable', 'Codex isn’t ready yet. Try again in a moment.');
    if (!(await this.learnHome())) return fail('unavailable', 'Codex didn’t say where it keeps your chats. Check that it’s installed, then try again.');
    if (gone()) return CANCELLED;

    const id = this.newId();
    const dir = path.join(root, id);
    const made = create({ dir, root, baseHome: this.baseHome });
    if (!made?.ok) { this.log(`codex account folder could not be made (${made?.code ?? 'failed'})`); return fail('failed', 'Canopy couldn’t make a folder for this account.'); }
    f.id = id; f.dir = dir;
    const added = reg.add({ engine: 'codex', id, kind: 'plan', dir, state: 'signed-out' });
    if (!added?.ok) return fail('failed', 'That account could not be added.');
    const svc = this.#service(dir);
    if (!svc) return fail('failed', 'Codex couldn’t be started for this account.');
    f.svc = svc;

    // The end of the sign-in, as Codex tells it.
    const ended = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), this.waitMs);
      timer.unref?.();
      const off = svc.watchAccount?.((ev) => {
        if (ev?.type !== 'login' || (f.loginId && ev.loginId && ev.loginId !== f.loginId)) return;
        clearTimeout(timer); off?.(); resolve(ev);
      });
      f.stop = (why) => { clearTimeout(timer); off?.(); resolve({ [why]: true }); };
    });
    const started = await svc.login({ type: 'chatgpt' });
    if (gone()) { if (started?.ok) await svc.cancelLogin?.(started.loginId); await this.#undo(f); return CANCELLED; }
    if (!started?.ok) return fail(started?.code ?? 'failed', started?.code === 'wrong-home' ? 'Codex didn’t start in this account’s folder, so nothing was signed in.' : 'Codex couldn’t start its sign-in.');
    const url = signInAddress(started.authUrl);
    if (!url) { await svc.cancelLogin?.(started.loginId); return fail('failed', 'Codex gave a sign-in page Canopy won’t open.'); }
    f.loginId = started.loginId ?? null;
    f.url = url;
    try { if ((await this.openFn?.(url)) === false) throw new Error('not opened'); }
    catch { await svc.cancelLogin?.(started.loginId); return fail('failed', 'Your browser didn’t open the sign-in page.'); }
    this.#set('waiting');

    const ev = await ended;
    if (gone()) return CANCELLED;
    if (ev.cancelled) return fail('cancelled', null);
    if (ev.timedOut) { await svc.cancelLogin?.(f.loginId); return fail('failed', 'The sign-in wasn’t finished in time.'); }
    if (ev.success !== true) return fail('failed', 'Codex said the sign-in didn’t work.');

    // Codex saying it worked is not enough: it has to say who signed in, for this folder.
    this.#set('checking');
    const d = describeAccount(await svc.account());
    if (gone()) return CANCELLED;
    if (d.state !== 'ok') return fail('failed', 'Codex didn’t say who signed in. Try again.');
    if (d.kind !== 'plan') { await this.#signOut(svc); return fail('failed', 'That wasn’t a ChatGPT sign-in. Paste an API key instead.'); }
    const twin = reg.entries('codex').find((a) => a.id !== id && sameLogin(a, d));
    if (twin) { await this.#signOut(svc); return fail('duplicate', `${twin.label || d.email} is already in Canopy. In your browser, sign in to a different ChatGPT account first.`); }
    reg.note(id, { state: 'ok', kind: 'plan', email: d.email, plan: d.plan, org: d.org ?? null, orgId: d.orgId ?? null });
    this.log(`codex: added ${id} (plan)`);
    const out = { ok: true, id };
    this.flow = null;
    svc.close?.().catch?.(() => {});
    this.#set('done');
    return out;
  }

  /** Stop the sign-in under way. Nothing it made is kept. */
  async cancel() {
    const f = this.flow;
    if (!f) return { ok: true };
    this.run++;
    f.stop?.('cancelled');
    if (f.svc && f.loginId) { try { await f.svc.cancelLogin?.(f.loginId); } catch { /* it ends with the helper anyway */ } }
    await this.#undo(f);
    this.#set('idle');
    return { ok: true };
  }

  /** Open the sign-in page again, while the sheet waits for it. */
  async reopen() {
    const url = this.phase === 'waiting' ? this.flow?.url : null;
    if (!url) return { ok: false };
    try { await this.openFn?.(url); return { ok: true }; } catch { return { ok: false }; }
  }

  /** The sheet was closed after it ended. */
  dismiss() { if (!this.flow) this.#set('idle'); return { ok: true }; }

  async #signOut(svc) { try { await svc.logout?.(); } catch { /* the folder is cleared next anyway */ } }

  // A sign-in that did not end in an account: its row and its folder go. The folder was just made and holds no
  // chat, so nothing filed under it can be lost.
  async #undo(f = this.flow) {
    if (!f) return;
    if (this.flow === f) this.flow = null;
    f.stop?.('cancelled');
    const reg = this.reg();
    if (f.id && reg) { try { reg.remove('codex', f.id); } catch { /* it was never listed */ } }
    if (f.dir && this.root()) {
      try { await removeHome({ dir: f.dir, root: this.root(), baseHome: this.baseHome, referenced: async () => false }); } catch { /* left for the next look */ }
    }
    try { await f.svc?.close?.(); } catch { /* gone */ }
  }

  /**
   * Remove a login added here: Codex signs that folder out, then the folder is cleared. The links to the chats stay
   * while a chat is filed under it, or while nobody can say. { ok: true } or { ok: false, code, message }.
   */
  async remove(id) {
    const reg = this.reg();
    const a = reg?.get?.('codex', id);
    if (!isFolderLogin(a)) return { ok: false, code: 'account-missing', message: 'That account is not in Canopy.' };
    const root = this.root();
    if (!root) return { ok: false, code: 'unavailable', message: 'Canopy couldn’t find where this account is kept.' };
    await this.learnHome();
    const svc = this.#service(a.dir);
    let r;
    try {
      r = await removeHome({
        dir: a.dir, root, baseHome: this.baseHome ?? undefined,
        logout: async () => (svc ? svc.logout() : { ok: false }),
        stillSignedIn: async () => { if (!svc) return null; const d = describeAccount(await svc.account()); return d.state === 'ok' ? true : d.state === 'unknown' ? null : false; },
        referenced: async () => {
          if (!this.own?.filedUnder) return null;
          const f = await this.own.filedUnder(a.dir);
          return f?.ok ? (f.found || !f.complete) : null;
        },
      });
    } finally { try { await svc?.close?.(); } catch { /* gone */ } }
    if (!r?.ok) {
      const message = r?.code === 'still-signed-in' ? 'Codex is still signed in there. Try again in a moment.' : 'Canopy couldn’t remove this account.';
      return { ok: false, code: r?.code ?? 'failed', message };
    }
    const out = reg.remove('codex', id);
    this.log(`codex: removed ${id}${r.kept ? ' (its chats’ links kept)' : ''}`);
    return out?.ok ? { ok: true } : out;
  }
}

/**
 * The window's channels. `codex-folders:add` resolves when the sign-in has ended; the sheet follows
 * `codex-folders:changed` meanwhile.
 * @param {(channel: string, fn: Function) => void} handle
 * @param {ConstructorParameters<typeof CodexAccountFolders>[0] & { send: (channel: string, payload: unknown) => void }} host
 */
export function registerCodexFolders(handle, { send, ...host } = {}) {
  const folders = new CodexAccountFolders({ ...host, onChange: (view) => send?.('codex-folders:changed', view) });
  handle('codex-folders:add', async () => folders.add());
  handle('codex-folders:cancel', async () => folders.cancel());
  handle('codex-folders:reopen', async () => folders.reopen());
  handle('codex-folders:remove', async (id) => folders.remove(typeof id === 'string' ? id : ''));
  return folders;
}


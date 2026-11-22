// Signing in to Codex from Canopy, and noticing when Codex's login stops working.
//
// Codex keeps one login for this Mac, and Canopy never holds it. What Canopy does is open Codex's own sign-in page
// in the browser, wait, and ask Codex who is signed in afterwards. This file is that flow as a small state machine
// (the sheet the window shows), plus the two signs that a login has gone bad: a chat OpenAI refused, and Codex
// saying its login changed.
//
//   CodexSignIn       the sheet's state (`view`) and what a user can ask for: start, cancel, reopen, dismiss, signOut
//   signInAddress     the address Codex gave for its sign-in page, if it is one Canopy will open
//   refusedTurn, goodReply   the two chat events that say something about the login a chat ran on
//
// All of that is about the login Codex holds. A chat on an API key pasted into Canopy runs on that key instead
// (accounts-codex.mjs), so what such a chat shows says nothing about Codex's login: a turn OpenAI refused there
// puts the key in doubt, and the key's own check with OpenAI settles it (`keyInDoubt`).
//
// The rules, each with a test (accounts-codex-login.test.mjs):
//  - A sign-in is started only when Codex says nobody is signed in, or for a login OpenAI has refused ("Sign in
//    again"). Codex is asked right before. While it holds a working login, nothing is started.
//  - Nobody is signed out except by `signOut`, which the window reaches only through its own confirmation.
//  - The registry's account changes only on Codex's own word (account/read). A refused chat, or a line saying the
//    login changed, makes Canopy ask. Neither changes anything by itself, and not knowing changes nothing.
//  - The address of the sign-in page goes to the browser and nowhere else: not to the window, not to the log.
//
// Contract: nothing here throws, and every async method resolves.
import { DEFAULT_ID, codexStatus, isPastedKey } from './accounts-codex.mjs';

/** idle: no sheet. starting, waiting, checking: a sign-in is under way. done, failed: it ended, and the sheet says how. */
export const PHASES = Object.freeze(['idle', 'starting', 'waiting', 'checking', 'done', 'failed']);
const UNDER_WAY = new Set(['starting', 'waiting', 'checking']);

const TIMINGS = Object.freeze({
  verifyTries: 3, verifyEvery: 400,   // asking Codex who is signed in, once it says the sign-in worked
  settle: 4000,                       // how long the sheet waits for the list of accounts to catch up
  proofEvery: 60000,                  // how often a reply may make Canopy ask Codex again about a login it doubts
});

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** A live chat event that says OpenAI refused the login its turn ran on (the adapter's notice of a refusal, or of a plain 401). */
export const refusedTurn = (ev) => isPlain(ev) && !ev.history && ev.kind === 'notice' && ev.code === 'api-error' && (ev.apiError === 'unauthorized' || ev.apiStatus === 401);
/** A live chat event that says a reply came back: the login its turn ran on works. */
export const goodReply = (ev) => isPlain(ev) && !ev.history && ev.kind === 'turn-end' && ev.isError === false && ev.interrupted !== true && ev.synthetic !== true;

/**
 * The address of Codex's sign-in page as Canopy will open it, or null. Only a plain https address is opened:
 * whatever else a Codex process hands over (a file, a script, another app's scheme) never reaches the system.
 */
export function signInAddress(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 8192) return null;
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

export class CodexSignIn {
  /**
   * @param {{
   *   service: object,              the shared Codex helper (CodexService): login, cancelLogin, logout, watchAccount
   *   engine: object,               the registry's Codex half (codexAccounts): read, known, refused, accepted, left
   *   registry: object,             the registry (Accounts): refresh, view
   *   installed: () => boolean,     is Codex on this Mac?
   *   open: (url: string) => unknown,   open an address in the user's browser (may reject, or answer false)
   *   onChange?: (view: object) => void,   what the sheet shows changed
   *   onLogin?: () => void,         Codex was signed in or out here: what was read with the old login is stale
   *   keyInDoubt?: (id: string) => unknown,   a chat says a pasted key is not as the list has it: have OpenAI asked
   *                                 about that key (src/account-actions.mjs)
   *   redact?: (text: string) => string, log?: (msg: string) => void, now?: () => number, timings?: Partial<typeof TIMINGS>,
   * }} deps
   */
  constructor({ service, engine, registry, installed, open, onChange, onLogin, keyInDoubt, redact, log, now, timings } = {}) {
    this.service = service ?? null;
    this.engine = engine ?? null;
    this.registry = registry ?? null;
    this.installedFn = typeof installed === 'function' ? installed : () => false;
    this.openFn = typeof open === 'function' ? open : null;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onLogin = typeof onLogin === 'function' ? onLogin : () => {};
    this.keyInDoubt = typeof keyInDoubt === 'function' ? keyInDoubt : () => {};
    this.redact = typeof redact === 'function' ? redact : (t) => t;
    this.logFn = typeof log === 'function' ? log : () => {};
    this.now = typeof now === 'function' ? now : Date.now;
    this.t = { ...TIMINGS, ...(isPlain(timings) ? timings : {}) };

    this.phase = 'idle';
    this.message = null;     // one plain sentence, when a sign-in failed
    this.detail = null;      // Codex's own words for the failure, when it gave any
    this.run = 0;            // goes up whenever the sheet's sign-in is called off, so a step in flight can tell
    this.loginId = null;     // the sign-in the sheet is waiting for
    this.url = null;         // its page, kept only to open it again. Never sent to the window, never logged.
    this.again = false;      // it replaces a login OpenAI refused (Codex still answers "signed in" throughout)
    this.leaving = false;    // a sign-out is in flight
    this.provenAt = 0;       // when a reply last made Canopy ask Codex again
    this.rechecking = null;
    this.recheckAgain = false;
    this.lastView = null;
    this.stopWatching = typeof this.service?.watchAccount === 'function' ? this.service.watchAccount((event) => this.#heard(event)) : () => {};
  }

  log(msg) { try { this.logFn(String(msg)); } catch { /* logging never breaks the flow */ } }

  // ---- what the window shows ----

  /** What is known about Codex's login right now, without asking: { installed, signedIn: true | false | null, method }. */
  status() {
    let installed = false;
    try { installed = this.installedFn() === true; } catch { installed = false; }
    if (!installed) return { installed, signedIn: null, method: null };
    try {
      const row = this.registry.view().list.find((a) => a.engine === 'codex' && a.id === DEFAULT_ID) ?? null;
      return { installed, ...codexStatus(row, this.engine.known()) };
    } catch { return { installed, signedIn: null, method: null }; }
  }

  /**
   * The sheet, and whether a sign-in may be offered. Nothing in it names who is signed in (the list of accounts
   * does), and the page's address is not in it.
   * `canSignIn`: Codex is on this Mac and known to have no login that works. `start` still asks Codex first.
   */
  view() {
    const s = this.status();
    const quiet = !UNDER_WAY.has(this.phase) && !this.leaving;
    return {
      phase: this.phase, message: this.message, detail: this.detail,
      installed: s.installed, signedIn: s.signedIn, canSignIn: s.installed && s.signedIn === false && quiet, signingOut: this.leaving,
    };
  }

  /**
   * What `models:list` says about Codex: the registry's word on the sign-in where it has one, else the caller's own.
   * With a key pasted into Canopy in use, OpenAI's new chats run on that key whatever Codex's own login is doing:
   * then the answer is about the key (it can start a chat, or it needs the user).
   */
  describe(codex) {
    const s = this.status();
    const mine = isPlain(codex) ? codex : {};
    const key = s.installed ? this.#keyInUse() : null;
    if (key) return { ...mine, signedIn: key.state === 'ok' || key.state === 'unknown' || key.state === 'checking', method: 'apiKey' };
    return s.signedIn === null ? mine : { ...mine, signedIn: s.signedIn, method: s.method };
  }

  // The account OpenAI's new chats use, when it is a key pasted into Canopy (its row in the list), else null.
  #keyInUse() {
    try {
      const v = this.registry.view();
      const row = v.list.find((a) => a.engine === 'codex' && a.id === v.inUse?.codex) ?? null;
      return isPastedKey(row) ? row : null;
    } catch { return null; }
  }

  // ---- signing in ----

  /**
   * Start a sign-in, if one may be started. Resolves once the browser has been opened (or it is clear it will not
   * be): { ok, code?, ...view }. How it ends arrives through `onChange`.
   */
  async start() {
    try {
      if (UNDER_WAY.has(this.phase)) return { ok: true, ...this.view() }; // the sheet is already up
      if (this.leaving) return { ok: false, code: 'busy', ...this.view() };
      if (!this.status().installed) return { ok: false, code: 'not-installed', ...this.view() };
      const run = ++this.run;
      // Something else took this sign-in over while a step here was waiting: it was called off, or Codex already
      // said how it ended. The answer is then simply how things stand.
      const called = () => run !== this.run;
      const off = () => ({ ok: this.phase !== 'idle' && this.phase !== 'failed', ...(this.phase === 'idle' && { code: 'cancelled' }), ...this.view() });
      this.#forget();
      this.#set('starting');

      // Who is signed in right now? Codex's word, asked this moment: not what the list said a minute ago.
      const found = await this.engine.read();
      if (called()) return off();
      if (found.state === 'unknown') return this.#fail('no-answer', 'Codex did not answer. Try again in a moment.');
      if (found.state === 'none') return this.#fail('not-needed', 'Codex is set up with a provider of its own, so there is no OpenAI sign-in to do.');
      if (found.state === 'ok') {
        // Someone is signed in, and nothing says the login is bad. Nothing is started over a login that works.
        this.log('sign-in: not started, Codex is already signed in');
        await this.#settle();
        if (called()) return off();
        this.#set('done');
        return { ok: true, code: 'signed-in', ...this.view() };
      }
      this.again = found.state !== 'signed-out';

      const r = await this.service.login({ type: 'chatgpt' });
      if (called()) {
        if (r?.ok) this.#quietly(this.service.cancelLogin(r.loginId)); // called off before Codex had named it
        return off();
      }
      if (!r?.ok) {
        this.log(`sign-in: could not start (${r?.code ?? 'no answer'})`);
        return this.#fail(r?.code ?? 'internal', r?.code === 'not-installed' ? 'Codex is not on this Mac.' : 'Codex could not start its sign-in. Try again in a moment.');
      }
      const url = signInAddress(r.authUrl);
      if (!url) {
        this.log('sign-in: Codex gave an address Canopy does not open');
        await this.#quietly(this.service.cancelLogin(r.loginId));
        return this.#fail('bad-address', 'Codex gave a sign-in address Canopy does not open.');
      }
      this.loginId = r.loginId;
      this.url = url;
      let opened = false;
      try { opened = !!this.openFn && (await this.openFn(url)) !== false; } catch { opened = false; }
      if (called()) return off();
      if (!opened) {
        this.log('sign-in: the browser could not be opened');
        await this.#quietly(this.service.cancelLogin(r.loginId));
        return this.#fail('no-browser', 'Canopy could not open your browser.');
      }
      this.log(`sign-in: waiting for the browser${this.again ? ' (signing in again)' : ''}`);
      this.#set('waiting');
      return { ok: true, ...this.view() };
    } catch (err) {
      this.log(`sign-in: ${err?.message ?? err}`);
      return this.#fail('internal', 'The sign-in could not be started.');
    }
  }

  /** Call the sign-in off. Codex is told to drop it; the sheet goes at once. Too late once Codex says it worked. */
  async cancel() {
    try {
      if (this.phase !== 'starting' && this.phase !== 'waiting') return { ok: true, ...this.view() };
      this.run += 1;
      const loginId = this.loginId;
      this.#forget();
      this.#set('idle');
      this.log('sign-in: cancelled');
      await this.#quietly(this.service.cancelLogin(loginId ?? undefined));
    } catch (err) { this.log(`sign-in: ${err?.message ?? err}`); }
    return { ok: true, ...this.view() };
  }

  /** Open the sign-in page again (the tab was closed). Only while the sheet is waiting for it. */
  async reopen() {
    let opened = false;
    try { opened = this.phase === 'waiting' && !!this.url && !!this.openFn && (await this.openFn(this.url)) !== false; } catch { opened = false; }
    return { ok: opened, ...this.view() };
  }

  /** The user has read how it ended: the sheet goes. */
  dismiss() {
    if (this.phase === 'done' || this.phase === 'failed') { this.#forget(); this.#set('idle'); }
    return { ok: true, ...this.view() };
  }

  // ---- signing out ----

  /**
   * Sign Codex out on this Mac, because the user asked for exactly that. Never called for any other reason.
   * Afterwards the account leaves the list: signed out on purpose is not a problem to fix.
   */
  async signOut() {
    if (UNDER_WAY.has(this.phase) || this.leaving) return { ok: false, code: 'busy', message: 'Finish or cancel the sign-in first.' };
    this.leaving = true;
    this.#emit();
    try {
      const r = await this.service.logout();
      if (!r?.ok) {
        this.log(`sign-out: Codex did not sign out (${r?.code ?? 'no answer'})`);
        return { ok: false, code: r?.code ?? 'internal', message: 'Codex could not be signed out. Try again in a moment.' };
      }
      this.log('sign-out: signed out, as asked');
      this.engine.left();
      await this.#settle();
      this.#loginChanged();
      return { ok: true };
    } catch (err) {
      this.log(`sign-out: ${err?.message ?? err}`);
      return { ok: false, code: 'internal', message: 'Codex could not be signed out. Try again in a moment.' };
    } finally { this.leaving = false; this.#emit(); }
  }

  // ---- signs that the login changed or went bad ----

  /**
   * An event of a Codex chat (main hands over every one). Two kinds matter:
   *  - OpenAI refused the login. That is remembered and Codex is asked who is signed in; the list changes on the answer.
   *  - A reply came back while the login was thought to be bad, or gone: Codex is asked again.
   * `account`: the pasted key the chat runs on, as its account's id; null or left out for a chat on Codex's own
   * login. A chat on a key says nothing about that login. There the same two events put the key in doubt (refused
   * while it is listed as working, a reply while it is listed as refused), and OpenAI is asked about the key itself.
   */
  chatEvent(ev, account = null) {
    try {
      if (!isPlain(ev) || ev.history) return;
      if (typeof account === 'string' && account) return void this.#keyChatEvent(ev, account);
      if (refusedTurn(ev)) {
        this.engine.refused();
        this.log('OpenAI refused Codex’s login in a chat: asking Codex who is signed in');
        this.#recheck();
      } else if (goodReply(ev)) {
        const known = this.engine.known();
        if (!known || known.state === 'ok' || known.state === 'none') return;
        if (known.state !== 'signed-out') {
          // The login OpenAI refused has answered: that settles it.
          this.engine.accepted();
          this.#recheck();
          return;
        }
        // Codex says nobody is signed in, yet a chat replied: someone may have signed in elsewhere. But a chat
        // started earlier can go on replying on the login its process has in memory while Codex keeps answering
        // "signed out", so this asking is spaced out rather than done after every reply.
        if (this.provenAt && this.now() - this.provenAt < this.t.proofEvery) return;
        this.provenAt = this.now();
        this.#recheck();
      }
    } catch (err) { this.log(`chat event: ${err?.message ?? err}`); }
  }

  // A chat on a pasted key. Nothing is marked here: the key's own check with OpenAI says how it is.
  #keyChatEvent(ev, id) {
    const refused = refusedTurn(ev);
    if (!refused && !goodReply(ev)) return;
    const state = this.registry.view().list.find((a) => a.engine === 'codex' && a.id === id)?.state ?? null;
    if (refused ? state === 'invalid-key' : state !== 'invalid-key') return; // nothing the list does not already say
    this.log(refused ? 'OpenAI refused a pasted key in a chat: asking OpenAI about the key' : 'a chat on a key listed as refused got a reply: asking OpenAI about the key');
    Promise.resolve().then(() => this.keyInDoubt(id)).catch((err) => this.log(`key check: ${err?.message ?? err}`));
  }

  /**
   * Codex said its login changed (`account/updated`): a chat's process, or the helper's. `authMode` null means it
   * says nobody is signed in. Either way Codex is asked, and the list follows the answer.
   */
  accountUpdated(info) {
    try {
      const signedIn = typeof info?.authMode === 'string' && info.authMode !== '';
      if (UNDER_WAY.has(this.phase)) {
        // While the sheet waits, this can be the first word that the browser finished. Not when signing in again:
        // there Codex answers "signed in" all along, so only its word that this sign-in completed counts.
        if (signedIn && this.phase === 'waiting' && !this.again) this.#verify();
        return;
      }
      if (signedIn) this.engine.accepted(); // a login was put in place: what OpenAI refused before was another one
      this.#recheck();
    } catch (err) { this.log(`account update: ${err?.message ?? err}`); }
  }

  // The helper's own word on the login (CodexService.watchAccount).
  #heard(event) {
    if (!isPlain(event)) return;
    if (event.type === 'updated') return void this.accountUpdated(event);
    if (event.type !== 'login' || !this.loginId || event.loginId !== this.loginId) return; // not the one on the sheet
    if (event.success === true) return void this.#verify();
    // Dropped because Canopy asked: whoever asked has already said what the sheet shows.
    if (event.cancelled || (this.phase !== 'starting' && this.phase !== 'waiting')) return;
    this.run += 1;
    const words = typeof event.error === 'string' ? this.#words(event.error) : null;
    this.log(`sign-in: did not finish (${event.timedOut ? 'left open too long' : event.stopped ? 'Codex stopped' : 'Codex said no'})`);
    if (event.timedOut) this.#fail('timed-out', 'The sign-in page was open for a long time, so Canopy stopped waiting.');
    else if (event.stopped) this.#fail('stopped', 'Codex stopped before the sign-in was finished.');
    else this.#fail('refused', 'The sign-in was not finished.', words);
  }

  // Codex says the sign-in worked. It counts once Codex also says who is signed in.
  async #verify() {
    if (this.phase !== 'starting' && this.phase !== 'waiting') return;
    const run = ++this.run;
    try {
      this.#set('checking');
      this.engine.accepted(); // a completed sign-in replaces whatever was refused before
      let found = { state: 'unknown' };
      for (let i = 0; i < this.t.verifyTries && run === this.run; i++) {
        if (i) await sleep(this.t.verifyEvery);
        found = await this.engine.read();
        if (found.state === 'ok') break;
      }
      if (run !== this.run) return;
      // If Codex's word came some other way than the end of the sign-in, the helper is still held for it: let it go.
      this.#quietly(this.service.cancelLogin(this.loginId ?? undefined));
      if (found.state !== 'ok') {
        this.log(`sign-in: Codex said it worked, but then said ${found.state}`);
        this.#recheck();
        this.#fail('not-signed-in', 'Codex did not finish signing in. Try again.');
        return;
      }
      await this.#settle();
      if (run !== this.run) return;
      this.log(`sign-in: signed in (${found.kind})`);
      this.#forget();
      this.#set('done');
      this.#loginChanged();
    } catch (err) {
      this.log(`sign-in: ${err?.message ?? err}`);
      if (run === this.run) this.#fail('internal', 'Canopy could not check the sign-in.');
    }
  }

  // ---- internals ----

  // Ask every tool who is signed in and fold the answers into the list (Accounts.refresh). One at a time: a sign
  // that arrives while one runs makes it run once more.
  #recheck() {
    if (this.rechecking) { this.recheckAgain = true; return this.rechecking; }
    const loop = async () => {
      do {
        this.recheckAgain = false;
        try { await this.registry.refresh(); } catch (err) { this.log(`recheck: ${err?.message ?? err}`); }
      } while (this.recheckAgain);
    };
    this.rechecking = loop().finally(() => { this.rechecking = null; this.#emit(); });
    return this.rechecking;
  }

  // The same, waited for, but never for long: the sheet does not hang on a slow tool.
  #settle() { return Promise.race([this.#recheck(), sleep(this.t.settle)]); }

  #quietly(promise) { return Promise.resolve(promise).catch(() => {}); }

  // Codex's own words for a failure, fit to show: one line, no secrets the redactor knows, not too long.
  #words(text) {
    let t = '';
    try { t = String(this.redact(String(text)) ?? '').replace(/\s+/g, ' ').trim(); } catch { t = ''; }
    return t ? t.slice(0, 200) : null;
  }

  #forget() {
    this.loginId = null;
    this.url = null;
    this.message = null;
    this.detail = null;
    this.again = false;
  }

  #fail(code, message, detail = null) {
    this.#forget();
    this.message = message;
    this.detail = detail;
    this.#set('failed');
    return { ok: false, code, ...this.view() };
  }

  #set(phase) {
    this.phase = phase;
    this.#emit();
  }

  #loginChanged() { try { this.onLogin(); } catch { /* an observer never breaks the flow */ } }

  // The window hears about a change once, not about every step that changed nothing it shows.
  #emit() {
    try {
      const view = this.view();
      const json = JSON.stringify(view);
      if (json === this.lastView) return;
      this.lastView = json;
      this.onChange(view);
    } catch { /* an observer never breaks the flow */ }
  }
}

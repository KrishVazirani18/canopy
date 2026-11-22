// OpenAI accounts: what Canopy asks Codex about its login, what it remembers of the answers, and how Codex is
// launched for each kind of account.
//
// Codex has one login for this Mac, and it is Codex's. Who is signed in comes from Codex's own answer to
// `account/read`, through the shared helper Canopy already keeps (CodexService.account() in codex-host.mjs).
// Nothing under Codex's own folder is read or written, and this file calls nothing on the app-server itself: it only
// uses what it is handed. Signing in and out are in accounts-codex-login.mjs.
//
// Beside that login, an OpenAI API key pasted into Canopy is an account of its own. Codex takes no key from the
// environment as a login, and signing in with one would replace the login it holds. So a key is never made a
// login: its Codex process is told, on its command line, of a model provider of Canopy's own that reads its key
// from one variable, and that variable is set on that process only (`launchEnv`, `launchConfig`). The key is
// written nowhere: not in Codex's folder, not in its settings. Codex's own login stays exactly as it was, and with
// nothing chosen Codex is launched as it finds itself: the same environment, and no setting of Canopy's.
//
// A second Codex login can be added too: a ChatGPT plan signed in to through Codex's own browser sign-in, into a
// folder of its own that Canopy keeps (src/codex-account-home.mjs). Codex holds that login as it holds its own, in
// that folder, and Canopy never sees it. A process for such an account is pointed at that folder for its login and
// at the user's own Codex folder for its index of chats, so every login keeps its chats in the one index
// (accounts-codex-home.mjs has that recipe). The folder is the host's to look after
// (src/codex-account-folders.mjs): this file only names it, and still opens no file itself.
//
// Codex ties a chat to the provider it began on, for good: a chat begun on Codex's own login cannot carry on on a
// pasted key, nor the other way round. Canopy keeps a chat on the login it began on as well: one begun on a second
// login is not moved to another (`chatAccount`).
//
// Two things Codex's answer cannot say are remembered here, for as long as Canopy runs:
//  - OpenAI refused the login in a chat (`refused`). Codex still holds that login, so it still answers "signed in".
//    The account is then listed as needing a sign-in (`expired`, or `invalid-key` when it is a key) until something
//    shows the login works: a reply, a new sign-in, a different login, or a read of the plan's limits going through.
//  - The user signed Codex out here, on purpose (`left`). The account then leaves the list, instead of staying on
//    it as something to fix.
// Neither outlives the run. The registry saves the account's last state like any other, and the first check of a
// new run corrects it: Codex is asked afresh and its word is taken, until OpenAI refuses the login again.
//
//   describeAccount(answer)   one `account()` answer as an account: who, which kind, signed in or not
//   codexStatus(row, known)   is Codex signed in, and how: for the status line in Settings > Models
//   isPastedKey(account)      is this a key pasted into Canopy (and not a key Codex holds itself)?
//   isFolderLogin(account)    is this a login kept in a folder of its own (and not the one Codex holds itself)?
//   sameLogin(a, b)           are these two the same ChatGPT account?
//   launchEnv / launchConfig  the recipe: what a Codex process gets for an account, in its environment and as settings
//   chatAccount(...)          the account a chat opens on: a new one by what is in use, a saved one by how it began
//   codexAccounts(...)        the engine object the registry works with (see accounts.mjs)
import path from 'node:path';
import { refuse } from './accounts.mjs';
import { folderEnv } from './accounts-codex-home.mjs';

/** The login Codex itself holds. */
export const DEFAULT_ID = 'codex-default';
/** The model provider a pasted key's chats run on. Canopy names it on that process's command line, and nowhere else. */
export const KEY_PROVIDER = 'canopy-openai';
/** The variable that provider reads its key from: set on a pasted key's own Codex process, and on no other. */
export const KEY_VAR = 'CANOPY_OPENAI_API_KEY';
const OPENAI_API = 'https://api.openai.com/v1';

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' && v ? v : null);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One answer from CodexService.account() as an account.
 *   { state: 'unknown' }      Codex did not answer: never the same as signed out
 *   { state: 'signed-out' }   Codex needs a sign-in and has none
 *   { state: 'none' }         nothing is signed in and nothing needs to be (a provider of the user's own): no row
 *   { state: 'ok', kind, via, email, plan }
 * `kind` is `plan` (a ChatGPT plan), `key` (an API key Codex holds) or `external` for a login type Canopy does
 * not know yet, with `via` naming it. A plan in a ChatGPT workspace also says which: `org` (its name) and `orgId`,
 * when Codex gave them. One person can hold a plan of their own and a seat in a workspace under one email.
 */
export function describeAccount(r) {
  if (!isPlain(r) || r.ok !== true) return { state: 'unknown' };
  if (!r.signedIn) return { state: r.requiresAuth === true ? 'signed-out' : 'none' };
  const a = isPlain(r.account) ? r.account : {};
  if (a.type === 'chatgpt') {
    const org = str(a.workspace), orgId = str(a.workspaceId);
    return { state: 'ok', kind: 'plan', via: null, email: str(a.email), plan: str(a.plan), ...(org && { org }), ...(orgId && { orgId }) };
  }
  if (a.type === 'apiKey') return { state: 'ok', kind: 'key', via: null, email: null, plan: null };
  return { state: 'ok', kind: 'external', via: str(a.type) ?? 'environment', email: str(a.email), plan: null };
}

/** What to call an account the user has not named. */
export function labelFor(a) {
  if (a?.kind === 'plan') return a.plan ? `ChatGPT ${cap(a.plan)}` : 'ChatGPT plan';
  if (a?.kind === 'key') return a.keyHint ? `API key ••••${a.keyHint}` : 'API key';
  return 'Codex login';
}

// ---------- how Codex is launched for an account ----------

/** A key pasted into Canopy. Not the login Codex holds itself, which can be a key too: that one is Codex's own. */
export const isPastedKey = (a) => isPlain(a) && a.kind === 'key' && a.id !== DEFAULT_ID;

/** A login kept in a folder of its own: signed in to through Codex, held by Codex in that folder. Not the one Codex holds itself. */
export const isFolderLogin = (a) => isPlain(a) && a.kind === 'plan' && a.id !== DEFAULT_ID && isAbs(a.dir);

/**
 * Are these two the same ChatGPT account: the same email, in the same workspace (or both in none)? Told by the
 * workspace's id when Codex gave one for both, else by its name. With no email on either side there is nothing to
 * tell them apart by, and two logins are never called the same on a guess.
 * @param {{ email?: string | null, org?: string | null, orgId?: string | null } | null | undefined} a
 * @param {{ email?: string | null, org?: string | null, orgId?: string | null } | null | undefined} b
 */
export function sameLogin(a, b) {
  if (!isPlain(a) || !isPlain(b) || !str(a.email) || !sameText(a.email, b.email)) return false;
  if (str(a.orgId) && str(b.orgId)) return a.orgId === b.orgId;
  return str(a.org) && str(b.org) ? sameText(a.org, b.org) : !str(a.org) && !str(b.org);
}

/**
 * The environment Codex is launched with for an account:
 *
 *   nothing chosen (account null)   the base, unchanged: what Canopy has always launched it with
 *   the login Codex holds           the base, unchanged: Codex finds that login by itself
 *   a pasted API key                the base, plus the key in KEY_VAR
 *   a login in a folder of its own  the base, with Codex pointed at that folder for its login and at the user's own
 *                                   Codex folder for its index of chats (accounts-codex-home.mjs `folderEnv`)
 *
 * Always a new object. Throws `refuse(...)` instead of ever handing back another login's environment.
 * `base` is the environment a Codex process would get anyway (codex-host.mjs `codexEnv`, which drops every
 * variable of Canopy's own): the key is added to that, so it reaches this process and no other.
 * @param {object | null} account a registry entry, or null
 * @param {Record<string, string>} base
 * @param {{ key?: string | null, name?: string, codexHome?: string | null }} [opts] `key`: a pasted key's secret,
 *   which is never kept in the registry. `codexHome`: the user's own Codex folder, as their Codex itself reports it
 *   (the host asks: src/codex-account-folders.mjs). A login in a folder of its own is not launched without it.
 */
export function launchEnv(account, base, { key, name = 'This account', codexHome } = {}) {
  if (!isPlain(base)) throw refuse('no-env', 'Canopy has not finished checking your setup yet.', { recoverable: true });
  if (!account || account.id === DEFAULT_ID) return { ...base };
  if (isFolderLogin(account)) {
    // Without the user's own folder to keep its index in, this process would keep one of its own, and its chats
    // would be in no list but its own. So it is not started: nobody looks after this account's folder here.
    if (!isAbs(codexHome)) throw refuse('account-unsupported', `${name} is not an account Codex can be started on.`);
    return folderEnv(account, base, { codexHome, name });
  }
  // Whatever else this is, it is not something Canopy can launch Codex on, and it is never launched on the login
  // Codex holds instead.
  if (!isPastedKey(account)) throw refuse('account-unsupported', `${name} is not an account Codex can be started on.`);
  if (typeof key !== 'string' || !key) throw refuse('account-locked', `The key for ${name} could not be read from the Keychain.`);
  // Like a key exported in a terminal, the commands Codex runs in that chat can read it.
  return { ...base, [KEY_VAR]: key };
}

/**
 * The settings Codex is launched with for an account, as `-c` flags (codex-host.mjs `configArgs`). None, except for
 * a pasted key: a model provider that is OpenAI's own API with the key read from KEY_VAR, and that provider chosen.
 * It needs no login of Codex's (`requires_openai_auth` false), so Codex's own is neither used nor asked for. The
 * user's settings file is not written: these override it for this one process. The key itself is never in them.
 * @param {object | null} account
 * @returns {Record<string, unknown>}
 */
export function launchConfig(account) {
  if (!isPastedKey(account)) return {};
  return {
    [`model_providers.${KEY_PROVIDER}`]: { name: 'OpenAI', base_url: OPENAI_API, env_key: KEY_VAR, wire_api: 'responses', requires_openai_auth: false },
    model_provider: KEY_PROVIDER,
  };
}

/**
 * The account a Codex chat opens on (an id; null: Codex as it finds itself).
 *
 * A new chat takes the account in use. A saved chat cannot: Codex keeps a chat on the provider it began on, and
 * refuses to open it on another. So a chat begun on Codex's own login opens on that login whatever is in use, and
 * a chat begun on a pasted key opens on a pasted key: the one it began on while that is still in Canopy, else the
 * one in use if that is a key. With neither, it is given the account it began on all the same, so the chat says
 * that its account is gone instead of starting on another login.
 *
 * A chat begun on a login kept in a folder of its own opens on that login and no other, for as long as it is in
 * Canopy, and says its account is gone after that. Codex itself would open it on any login. Canopy does not: a
 * chat is never moved from one plan's login to another's.
 * @param {{
 *   saved?: boolean,              the chat has a conversation on disk
 *   began?: string | null,        the account it began on, as Canopy recorded it (null: Codex's own login)
 *   beganOn?: 'login' | null,     what kind that was: 'login' for one kept in a folder of its own, else a pasted key
 *   inUse?: string | null,        the account new chats use (the registry's `pin`)
 *   isKey?: (id: string) => boolean,   is this id a pasted key that is in Canopy now?
 * }} o
 * @returns {string | null}
 */
export function chatAccount({ saved = false, began = null, beganOn = null, inUse = null, isKey } = {}) {
  const key = (id) => { try { return typeof id === 'string' && !!id && isKey?.(id) === true; } catch { return false; } };
  // The login Codex holds is never named: it is "as Codex finds itself". So a chat's account, when it has one, is
  // an account added in Canopy: a pasted key, or a login in a folder of its own.
  const pin = typeof inUse === 'string' && inUse && inUse !== DEFAULT_ID ? inUse : null;
  if (!saved) return pin;
  if (typeof began !== 'string' || !began || began === DEFAULT_ID) return null;
  if (beganOn === 'login') return began;
  if (key(began)) return began;
  return key(pin) ? pin : began;
}

// How a kind of login is named where Codex's own word for it is expected (`models:list` reports the method in Codex's
// words: 'chatgpt' or 'apiKey').
const METHOD = { plan: 'chatgpt', key: 'apiKey' };
const methodOf = (a) => METHOD[a?.kind] ?? str(a?.via);
const fine = (state) => state === 'ok';
const undecided = (state) => state === 'unknown' || state === 'checking';

/**
 * Is Codex signed in, and how: { signedIn: true | false | null, method }. For the status line in Settings > Models.
 * `row` is the registry's account for Codex's login as `Accounts.view()` lists it (or null), `known` what Codex
 * last said in this run (`codexAccounts().known()`).
 *
 * The registry's account answers when there is one. With none, Codex's last word does: signed out, or running on
 * a provider of the user's own (which needs no OpenAI sign-in, so that counts as signed in). `signedIn` is null
 * until Codex has said something in this run: an account saved by the last run is not said as a fact.
 */
export function codexStatus(row, known) {
  if (!isPlain(known)) return { signedIn: null, method: null };
  if (isPlain(row) && !undecided(row.state)) return fine(row.state) ? { signedIn: true, method: methodOf(row) } : { signedIn: false, method: null };
  if (fine(known.state)) return { signedIn: true, method: methodOf(known) };
  if (known.state === 'none') return { signedIn: true, method: null };
  return { signedIn: false, method: null };
}

/**
 * The engine object for Codex (see accounts.mjs), plus what the sign-in flow needs of it.
 * @param {{
 *   account: () => Promise<object>,     CodexService.account()
 *   installed: () => boolean,           is Codex on this Mac?
 *   env: () => object | null,           the environment Codex is launched with
 *   works?: () => Promise<{ok: boolean}>,   CodexService.loginWorks(): did a call that needs the login go through?
 *   checkKey?: (account: object) => Promise<{ state: string, why?: string }>,
 *                                       how a pasted key is checked. The host does it: it alone can read the key
 *   home?: (account: object, base: object, opts?: { name?: string }) => ({ codexHome: string } | void),
 *                                       the host's care of a login's own folder (src/codex-account-folders.mjs).
 *                                       Called before the folder is used: it puts the folder in order, says where
 *                                       the user's own Codex folder is, and throws `refuse(...)` when the folder
 *                                       cannot be launched on. Without it no such login is ever launched.
 *   checkLogin?: (account: object) => Promise<{ state: string, why?: string }>,
 *                                       how a login in a folder of its own is checked: the host asks Codex, for
 *                                       that very folder
 * }} deps
 */
export function codexAccounts({ account, installed, env, works, checkKey, home, checkLogin } = {}) {
  // What Codex last said in this run, and the two things it cannot say itself (see the top of this file).
  const mem = { found: null, refused: null, left: false };
  const who = (f) => `${f.kind}:${f.email ?? ''}`;
  const judged = (f) => (fine(f.state) && mem.refused ? { ...f, state: f.kind === 'key' ? 'invalid-key' : 'expired' } : f);

  // Did a call that needs the login go through? A failure says nothing either way (see CodexService.loginWorks).
  async function proven() {
    try { const r = await works?.(); return isPlain(r) && r.ok === true; } catch { return false; }
  }

  /**
   * Ask Codex who is signed in, and judge the answer by what is remembered. As `describeAccount`, except that a
   * login OpenAI refused comes back `expired` (or `invalid-key`) rather than `ok`. Never rejects.
   */
  async function read() {
    let found;
    try { found = describeAccount(await account?.()); } catch { found = { state: 'unknown' }; }
    if (found.state === 'unknown') return found; // not knowing changes nothing that is remembered
    mem.found = found;
    if (!fine(found.state)) mem.refused = null; // the login that was refused is gone
    else {
      mem.left = false;
      const r = mem.refused;
      if (r) {
        r.who ??= who(found);                         // refused before Codex had said whose login it was
        if (r.who !== who(found)) mem.refused = null; // another login now: the refusal was not about it
        // A plan's login that reads its own limits is one OpenAI takes (unless it was refused again meanwhile).
        else if (found.kind === 'plan' && (await proven()) && mem.refused === r) mem.refused = null;
      }
    }
    return judged(found);
  }

  return {
    ids: [DEFAULT_ID],
    base: () => { try { const e = env?.(); return isPlain(e) ? e : null; } catch { return null; } },
    label: labelFor,
    agrees: () => null,
    asFound: (list) => list.find((a) => a.id === DEFAULT_ID)?.id ?? null,

    // A login in a folder of its own is launched only on a folder the host has put in order, and with the place
    // the host says the user's own Codex keeps its index.
    launchEnv: (chosen, base, opts) => {
      const where = isFolderLogin(chosen) && isPlain(base) && typeof home === 'function' ? home(chosen, base, opts) : null;
      return launchEnv(chosen, base, { ...opts, codexHome: isPlain(where) ? where.codexHome : null });
    },
    launchConfig,
    /** The model provider a chat launched for this account must come up on (null: whichever Codex's own settings name). */
    provider: (chosen) => (isPastedKey(chosen) ? KEY_PROVIDER : null),
    /** The folder a process launched for this account must say it keeps its login in (null: wherever Codex finds its own). */
    home: (chosen) => (isFolderLogin(chosen) ? chosen.dir : null),
    // Choosing the login Codex holds is choosing nothing: "as Codex finds itself" is how that login is launched,
    // and how it was launched before there was anything to choose between.
    choice: (id) => (id === DEFAULT_ID ? null : id),

    /**
     * Ask about one account Canopy added. A pasted key's maker is asked by the host that keeps the key. A login in
     * a folder of its own is asked about by the host that looks after the folder: Codex says who is signed in there.
     */
    async verify(chosen) {
      if (isPastedKey(chosen)) return typeof checkKey === 'function' ? checkKey({ ...chosen }) : { state: 'unknown' };
      if (isFolderLogin(chosen)) return typeof checkLogin === 'function' ? checkLogin({ ...chosen }) : { state: 'unknown' };
      return { state: 'unknown' };
    },

    async detect() {
      let there = false;
      try { there = installed?.() === true; } catch { there = false; }
      if (!there) { mem.found = null; return { known: true, accounts: [] }; } // no Codex on this Mac: nothing to list
      const found = await read();
      if (found.state === 'unknown') return { known: false };
      if (found.state === 'none') return { known: true, accounts: [] };
      // Signed out here, on purpose: the account goes from the list rather than staying on it as a problem.
      if (found.state === 'signed-out' && mem.left) return { known: true, accounts: [] };
      return { known: true, accounts: [{ id: DEFAULT_ID, ...found }] };
    },

    // ---- for the sign-in flow (accounts-codex-login.mjs) ----

    read,
    /** What Codex last said in this run, judged, without asking again: { state, kind, via } or null before it has said. */
    known() {
      if (!mem.found) return null;
      const f = judged(mem.found);
      return { state: f.state, kind: f.kind ?? null, via: f.via ?? null };
    },
    /** OpenAI refused the login in a chat. It stands against the login Codex holds now, not against a later one. */
    refused() { mem.refused = { who: mem.found && fine(mem.found.state) ? who(mem.found) : null }; },
    /** The login works after all: a reply came back, or a sign-in was completed. */
    accepted() { mem.refused = null; },
    /** The user signed Codex out here. Forgotten as soon as Codex says someone is signed in again. */
    left() { mem.left = true; mem.refused = null; },
  };
}

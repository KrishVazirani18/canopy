// Signing in to Codex, the window's rules: what the sheet says in each state, what the row of Codex's own login
// offers, and when the accounts on Settings' Codex page show "Not signed in" for a Codex that has no login. The
// state itself comes from main (src/core/accounts-codex-login.mjs). Plain TypeScript with no run-time imports, so it
// is tested in node as it is.
//
// All of it is about the login Codex holds. An OpenAI key pasted into Canopy is listed beside it and is not a
// sign-in: nothing here is ever offered on its row (what a key's row offers is account-rules.ts `rowOffers`).
//
// The sign-in is Codex's own, in the browser. Nothing here asks for a name, a password or a key, and the page's
// address never reaches the window.
import type { Account, CodexLogin } from './api';

/** The label everywhere a sign-in is offered: the tool being signed in to, not OpenAI's programme for other apps. */
export const SIGN_IN = 'Sign in to Codex';

/**
 * The sheet. `line` is the one sentence under the title, `detail` Codex's own words when a sign-in failed and it
 * gave any, `waiting` the line beside the spinner while a sign-in is under way, `note` a quiet line at the bottom.
 * `signedIn`: it ended well (drawn with a check mark). `cancel`: it can still be called off. `reopen`: the page can
 * be opened again. `close`: the label of the button that puts the sheet away. `retry`: "Try again" is offered.
 */
export type SignInSheet = {
  title: string; line: string; detail: string | null; waiting: string | null; note: string | null;
  signedIn: boolean; cancel: boolean; reopen: boolean; close: string | null; retry: boolean;
};

const KEPT_BY_CODEX = 'Codex keeps the login. Canopy never sees your password.';

/** What the sheet shows for main's state, or null for no sheet. `account` is the OpenAI account in use, if listed. */
export function signInSheet(login: CodexLogin | null | undefined, account?: Pick<Account, 'label' | 'email'> | null): SignInSheet | null {
  if (!login || typeof login.phase !== 'string' || login.phase === 'idle') return null;
  const base = { title: SIGN_IN, detail: null, waiting: null, note: null, signedIn: false, cancel: false, reopen: false, close: null, retry: false };
  switch (login.phase) {
    case 'starting':
      return { ...base, line: 'OpenAI’s sign-in page opens in your browser.', waiting: 'Opening it…', note: KEPT_BY_CODEX, cancel: true };
    case 'waiting':
      return { ...base, line: 'Your browser opened OpenAI’s sign-in page.', waiting: 'Waiting for you to sign in there…', note: KEPT_BY_CODEX, cancel: true, reopen: true };
    case 'checking':
      return { ...base, line: 'Your browser opened OpenAI’s sign-in page.', waiting: 'Checking with Codex…', note: KEPT_BY_CODEX };
    case 'done': {
      // Who it is, as the list of accounts names them. Until the list has caught up, only that it worked.
      const who = account ? [account.label, account.email].filter(Boolean).join(' · ') : '';
      return { ...base, title: 'Signed in to Codex', line: who || 'Codex is signed in on this Mac.', signedIn: true, close: 'Done' };
    }
    case 'failed':
      return { ...base, line: login.message || 'The sign-in was not finished.', detail: login.detail || null, close: 'Close', retry: login.canSignIn === true };
    default: return null;
  }
}

const settled = (a: Pick<Account, 'state'>) => a.state !== 'unknown' && a.state !== 'checking';

/**
 * The sign-in button on the row of Codex's own login: its label, or null for no button. Only a login that needs a
 * sign-in gets one, and only while main says one may be started. One that works never does, and neither does a
 * key pasted into Canopy (`found` false): signing in to Codex would not fix it.
 */
export function rowSignIn(a: Pick<Account, 'engine' | 'state' | 'kind'> & { found?: boolean }, login: CodexLogin | null | undefined): string | null {
  if (a.engine !== 'codex' || a.found === false || a.state === 'ok' || !settled(a) || login?.canSignIn !== true) return null;
  return 'Sign in…'; // the same button Claude's rows have (account-rules `signsIn`): it opens Codex's sign-in sheet
}

/**
 * Is there a sign-in to offer for Codex right now, away from its row (beside a turn OpenAI refused, say)? Its
 * label, or null. The same rule as the row: the login Codex holds needs one, or Codex is here with nobody signed
 * in, and main says a sign-in may be started. `accounts`: the accounts in the list (keys pasted into Canopy are
 * passed over: they are not Codex's login).
 */
export function codexSignIn(accounts: readonly (Pick<Account, 'engine' | 'state' | 'kind'> & { found?: boolean })[] | null | undefined, login: CodexLogin | null | undefined): string | null {
  const own = (accounts ?? []).filter((a) => a.engine === 'codex' && a.found !== false);
  if (own.length) return rowSignIn(own[0], login);
  return showSignedOut(0, login) && login?.canSignIn === true ? SIGN_IN : null;
}

/**
 * Can this account be signed out of from here? The login Codex itself holds, while Codex is on this Mac and no
 * sign-in or sign-out is under way. An account that is already signed out has nothing to sign out of.
 */
export function rowSignOut(a: Pick<Account, 'engine' | 'state' | 'found'>, login: CodexLogin | null | undefined): boolean {
  return a.engine === 'codex' && a.found === true && a.state !== 'signed-out' && settled(a)
    && login?.installed === true && login.phase === 'idle' && login.signingOut !== true;
}

/**
 * The accounts on Settings' Codex page list no login of Codex's own (`accounts`: how many they list; keys pasted
 * into Canopy are not counted). Is that because Codex is here and says nobody is signed in? Then the list shows one
 * row that says so and offers the sign-in. Not when Codex is missing, has not said, or runs on a provider of the
 * user's own.
 */
export function showSignedOut(accounts: number, login: CodexLogin | null | undefined): boolean {
  return accounts === 0 && login?.installed === true && login.signedIn === false;
}

// Signing in to Codex, host side: builds the sign-in flow (src/core/accounts-codex-login.mjs) from what main
// already has, and gives the window its calls. Thin on purpose: main says how to open a browser and what to do
// when Codex's login changed, and hands the flow each Codex chat's events.
//
// The window can ask for a sign-in, call it off, have the page opened again, put the sheet away, and sign out.
// It is never sent the address of the sign-in page, and it cannot sign anyone out without its own confirmation.
import { CodexSignIn } from './core/accounts-codex-login.mjs';

/**
 * Wire the flow and its IPC channels.
 * @param {(channel: string, fn: Function) => void} handle main's guarded `ipcMain.handle`
 * @param {{
 *   accounts: object,             the registry (registerAccounts' return value); its Codex half comes with it
 *   service: object,              the shared Codex helper (CodexService)
 *   installed: () => boolean,     is Codex on this Mac?
 *   open: (url: string) => unknown,   open an address in the user's browser
 *   onLogin?: () => void,         Codex was signed in or out here
 *   keyInDoubt?: (id: string) => unknown,   a chat says a pasted key is not as the list has it (src/account-actions.mjs)
 *   send: (channel: string, payload: unknown) => void,
 *   redact?: (text: string) => string, log?: (msg: string) => void,
 * }} host
 * @returns {CodexSignIn}
 */
export function registerCodexSignIn(handle, { accounts, service, installed, open, onLogin, keyInDoubt, send, redact, log } = {}) {
  // The window hears how the sign-in stands in two ways: a line whenever the sheet changes, and the answer to each
  // call it makes. The two can cross on the way. Each carries a count that goes up with every change, so the window
  // can tell an answer that was overtaken from the newest word.
  let rev = 0;
  const stamped = (reply) => ({ ...reply, rev });
  const signIn = new CodexSignIn({
    service, registry: accounts, engine: accounts?.engines?.codex ?? null, installed, open, onLogin, keyInDoubt, redact, log,
    onChange: (view) => { rev += 1; send?.('accounts:codex', stamped(view)); },
  });
  handle('accounts:codex', async () => stamped(signIn.view()));
  handle('accounts:codex-signin', async () => stamped(await signIn.start()));
  handle('accounts:codex-cancel', async () => stamped(await signIn.cancel()));
  handle('accounts:codex-reopen', async () => stamped(await signIn.reopen()));
  handle('accounts:codex-dismiss', async () => stamped(signIn.dismiss()));
  // Signing out is for a user who said so in the window's own confirmation, which is what sends `true`.
  // Anything else that reaches this channel signs nobody out.
  handle('accounts:codex-signout', async (confirmed) => (confirmed === true
    ? signIn.signOut()
    : { ok: false, code: 'not-confirmed', message: 'Signing out of Codex has to be confirmed.' }));
  return signIn;
}

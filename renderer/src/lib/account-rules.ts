// The window's rules about accounts, in one file, so every place that shows an account agrees with the others.
//
// A maker's accounts in Settings (on its own page: Claude Code, Codex), and what the paste sheet says before it asks
// main anything:
//   isBroken(account)      an account that needs you ("could not check" is not one)
//   rowOffers(...)         what a row offers: Use, the fix for a key that needs you, the ⋯ menu
//   isPastedKey(account)   a key pasted into Canopy (not a login the tool holds itself)
//   keySheetWords(...)     what the paste sheet says for a maker's key
//   removeKeyQuestion(...) what removing a pasted key asks
//   isSignInToken(text)    a Claude sign-in token, refused where it is typed
//   refusal(reply)         a reply from main that did not work, as one line
//
// Near a plan's limit (the Usage tab):
//   perUseAlternatives(...)   the accounts an offer may name: billed per use, never another plan
//   limitOffer(...)           the one account the offer names, or none
//
// A Claude sign-in added in Canopy, kept in a folder of its own (src/account-folders.mjs):
//   isAddedSignIn(account)    which rows are one
//   addProblem / removeProblem(reply)   what to say when adding or removing one did not work
//   removeQuestion(...)       what removing one asks
//   connectorsNote(...)       the line on the Connectors page: connector sign-ins are kept per account
//
// A login that needs you. Used by the prompt at launch, the row above the message box, the notice in a chat, the
// Accounts list and the Usage tab, so all of them say and offer the same thing. These answer for Claude, whose
// chats wait for their account (HOLDS_CHATS), and for a Codex chat on a key pasted into Canopy, which waits for
// that key. A chat on Codex's own login is never held, and when that login needs a sign-in is
// codex-login-rules.ts; the other thing here for Codex is the notice of a turn OpenAI refused (`signInNotice`).
//   signsIn(account)       would signing in again fix it?
//   chatAccount(...)       the account a chat is on, from what main said it was started on
//   troubleFor(...)        that account, when it cannot be used
//   troubles(...)          one per maker, for the prompt at launch
//   promptWords(...)       the prompt's title, sentence and buttons
//   signInNotice(...)      a chat event that means "could not sign in", as a notice with a Sign in… button
//   showsSignIn(...)       whether that button still belongs on a notice
//   authFrom(...)          Claude Code's sign-in as the accounts list has it now, for what only knows the launch's answer
//
// Nothing here reads the window or throws, and the only import is a type: a plain node test runs this file as it
// is (src/core/test/unit/account-rules.test.mjs, account-folders-rules.test.mjs and account-trouble.test.mjs).
import type { Account, AccountsState, Engine } from './api';

// ---------- an account's row in Settings ----------

/** The part of an account these rules look at (see `Account` in api.ts). */
export type RowAccount = { engine: 'claude' | 'codex'; kind: string; state: string; found: boolean; via?: string | null };
export type RowMenuItem = 'rename' | 'replace-key' | 'remove';
export type RowOffer = {
  /** "Use": make this the account new chats start on. */
  use: boolean;
  /** The one thing to do about an account that needs you, when it is a key: paste another, or read it again. */
  fix: 'replace-key' | 'retry' | null;
  /** The ⋯ menu, in order. */
  menu: RowMenuItem[];
};

/**
 * An account that needs you: signed out, or otherwise not usable (the states in which main will not launch it,
 * src/core/accounts.mjs). "Could not check" is not one of them.
 */
export const isBroken = (a: Pick<RowAccount, 'state'>) => a.state !== 'ok' && a.state !== 'unknown' && a.state !== 'checking';

/** A key pasted into Canopy, for either maker. Not a login the tool holds itself, which for Codex can be a key too. */
export const isPastedKey = (a: Pick<RowAccount, 'kind' | 'found'> | null | undefined): boolean => !!a && a.kind === 'key' && !a.found;

/**
 * What one row offers.
 *  - Use: an account that is not the one in use and could start a chat, for either maker (Codex's own login, or
 *    an OpenAI key pasted into Canopy).
 *  - Replace key and Remove: only for a key that was pasted into Canopy. A login the tool itself holds is never
 *    removed here, and a key Codex holds is Codex's.
 *  - Rename: any account.
 * (Sign in…, for a sign-in that is gone, is `signsIn` below: it is the same button wherever the account shows.
 * A sign-in added in Canopy is removed by its own question, `isAddedSignIn` and `removeQuestion` below: it is
 * signed out and its folder deleted, which forgetting a key is not.)
 */
export function rowOffers(a: RowAccount, inUse: boolean): RowOffer {
  const ownKey = isPastedKey(a);
  const menu: RowMenuItem[] = ['rename'];
  if (ownKey) menu.push('replace-key', 'remove');
  return {
    use: !inUse && !isBroken(a),
    fix: !ownKey ? null : a.state === 'invalid-key' ? 'replace-key' : a.state === 'locked' ? 'retry' : null,
    menu,
  };
}

// ---------- near a plan's limit ----------

// What supplies an `external` Claude login when it is a key billed per use. A token is not one: it can be a plan's.
const KEY_SOURCES = ['ANTHROPIC_API_KEY', 'apiKeyHelper'];
const billedPerUse = (a: RowAccount) => a.kind === 'key' || a.kind === 'console'
  || (a.kind === 'external' && a.engine === 'claude' && typeof a.via === 'string' && KEY_SOURCES.includes(a.via));

/**
 * The accounts an offer made near a plan's limit may name: ones billed per use (a pasted API key, a Console
 * sign-in, an API key your environment supplies) that could start a chat and are not the one in use. Never a
 * plan: Canopy does not offer moving from one plan account to another, and never switches by itself. The offer
 * is a button; choosing is the user's click (`chooseAccount`).
 */
export function perUseAlternatives<T extends RowAccount & { id: string }>(list: readonly T[], engine: RowAccount['engine'], inUse: string | null): T[] {
  return list.filter((a) => a.engine === engine && billedPerUse(a) && a.id !== inUse && rowOffers(a, false).use);
}

/**
 * The one account that offer names, or null when there is none: then nothing is offered at all. Only an account
 * known to work, and a pasted key before a key from the environment before a Console sign-in.
 */
export function limitOffer<T extends RowAccount & { id: string }>(list: readonly T[] | null | undefined, engine: RowAccount['engine'], inUse: string | null): T | null {
  const rank = (a: T) => (a.kind === 'key' ? 0 : a.kind === 'external' ? 1 : 2);
  const rows = (Array.isArray(list) ? list : []).filter((a) => !!a && typeof a === 'object');
  const can = perUseAlternatives(rows, engine, inUse).filter((a) => a.state === 'ok');
  return can.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// ---------- a Claude sign-in added in Canopy ----------

/** What main answers when asked to add or remove such an account. `error`: the call itself failed. */
export type AccountChange = { ok?: boolean; id?: string; code?: string; message?: string; existing?: string; error?: string };

/**
 * A Claude sign-in added in Canopy. Claude Code holds it in a folder of its own, so unlike the login Canopy found
 * it can be removed here, and its connector sign-ins are its own.
 */
export const isAddedSignIn = (a: Pick<Account, 'engine' | 'kind' | 'found'> | null | undefined): boolean =>
  !!a && !a.found && (a.engine === 'claude' ? a.kind === 'plan' || a.kind === 'console' : a.engine === 'codex' && a.kind === 'plan');

/**
 * The line to show when adding an account did not work, or null when there is nothing to say: it worked, or the
 * user closed the sign-in themselves.
 */
export function addProblem(r: AccountChange | null | undefined): string | null {
  if (!r) return 'Canopy couldn’t add the account.';
  if (r.ok === true || r.code === 'cancelled') return null;
  return r.message || r.error || 'Canopy couldn’t add the account.';
}

/** Likewise for removing one. */
export function removeProblem(r: AccountChange | null | undefined): string | null {
  if (r?.ok === true) return null;
  return r?.message || r?.error || 'Canopy couldn’t remove the account.';
}

/** The question asked before an account is removed. `inUse`: it is the one new chats start on. */
export function removeQuestion(a: Pick<Account, 'label' | 'email'>, inUse: boolean): { title: string; body: string; note: string } {
  return {
    title: `Remove ${a.label}?`,
    body: `${a.email ?? 'This account'} is signed out here and leaves Canopy. Your other logins are not touched.`,
    note: `Your chats, settings and connectors stay.${inUse ? ' New chats go back to the login Claude Code has.' : ''} A chat open on this account can’t continue on it.`,
  };
}

/**
 * Connector sign-ins are kept per account. On the Connectors page, under the connectors waiting for one: what to
 * say when the account in use is one added in Canopy (its connectors are the user's, its sign-ins start empty).
 * `waiting`: how many connectors need signing in.
 */
export function connectorsNote(inUse: Pick<Account, 'engine' | 'kind' | 'found' | 'label'> | null | undefined, waiting: number): string | undefined {
  if (!inUse || !isAddedSignIn(inUse) || !(waiting > 0)) return undefined;
  return `Connector sign-ins are kept per account. Sign in to ${waiting === 1 ? 'this one' : 'these'} once for ${inUse.label}.`;
}

/** After a sign-in was added: where its connectors stand. */
export const ADDED_NOTE = 'Connectors you signed in to need signing in once more for this account. Settings → Tools shows which.';

// ---------- the paste sheet ----------

/**
 * What the sheet says for a maker's key: its title, the one sentence under it, the field's hint and the quiet line
 * below. `replace`: the sheet gives an account another key. An OpenAI key says what it leaves alone: pasting one
 * into Codex itself would replace Codex's login, and here it does not.
 */
export function keySheetWords(engine: Engine, replace?: { label: string } | null): { title: string; line: string; placeholder: string; note: string } {
  const codex = engine === 'codex';
  const maker = codex ? 'OpenAI' : 'Anthropic';
  return {
    title: replace ? 'Replace key' : 'Paste an API key',
    line: replace ? `Paste another ${maker} API key for ${replace.label}. The one it has now stays until the new one checks out.`
      : codex ? 'An OpenAI API key from the OpenAI Platform. Chats on it are billed per use, and Codex’s own login stays as it is.'
      : 'An Anthropic API key from the Claude Console. Chats on it are billed per use.',
    placeholder: codex ? 'sk-…' : 'sk-ant-api…',
    note: `Canopy checks it with ${maker}, then keeps it in your Keychain. Only its last four characters are shown.`,
  };
}

/**
 * The question asked before a pasted key is removed. `inUse`: it is the one new chats start on. A Codex chat is
 * kept by Codex on the kind of account it began on, so one begun on a key carries on only with a key in use.
 */
export function removeKeyQuestion(a: Pick<Account, 'engine' | 'label'>, inUse: boolean): { title: string; body: string } {
  const codex = a.engine === 'codex';
  return {
    title: `Remove “${a.label}”?`,
    body: [
      'Canopy forgets this key.',
      inUse ? `New chats go back to the login ${codex ? 'Codex' : 'Claude Code'} has.` : '',
      codex ? 'Chats that began on it stop when they next restart, and carry on only with another key in use.' : 'Chats that are open on it stop when they next restart.',
      `The key itself keeps working elsewhere until you delete it ${codex ? 'on the OpenAI Platform' : 'in the Claude Console'}.`,
    ].filter(Boolean).join(' '),
  };
}

/**
 * A Claude sign-in token (what a plan login holds), by its shape. The sheet refuses one where it is typed: it is
 * never sent to main, let alone kept. Main refuses it again (src/core/account-keys.mjs), and is the one that
 * decides what a key is.
 */
export const isSignInToken = (text: string) => /^["'`\s]*sk-ant-(?:oat|ort|sid)/i.test(text);
export const SIGN_IN_TOKEN = 'That is a Claude sign-in token, not an API key. Canopy doesn’t take sign-in tokens. Create an API key in the Claude Console instead.';

/** What a reply from main says when it did not work, as one line a person can read. */
export function refusal(r: { ok?: boolean; message?: string; error?: string } | null | undefined): string | null {
  if (r?.ok === true) return null;
  const text = typeof r?.message === 'string' && r.message ? r.message : null;
  return text ?? 'That didn’t work. Try again.';
}

// ---------- a login that needs you ----------

/**
 * The makers whose every chat waits while its account needs you: asked about once at launch, and held on the
 * message box until it is fixed. Claude only: a chat on a signed-out Claude login can do nothing but fail.
 * A Codex chat on Codex's own login is never held. Codex has one login for the whole Mac and keeps it itself: a
 * chat's process can go on working when Codex says otherwise, and a reply is what clears a login OpenAI once
 * refused (src/core/accounts-codex-login.mjs). Its sign-in is offered where its account shows
 * (codex-login-rules.ts). A Codex chat on a key pasted into Canopy does wait for that key (`holds`).
 */
export const HOLDS_CHATS: readonly Engine[] = ['claude'];
const ENGINES: readonly Engine[] = ['claude', 'codex'];
/**
 * Does a chat on this account wait while the account needs you? Every Claude chat, and a Codex chat on a pasted
 * key: what is said about such a key is its maker's own word on it (or the Keychain's), main will not start a chat
 * on it, and its row in Settings has the way out.
 */
const holds = (a: Pick<Account, 'engine' | 'kind' | 'found'>) => HOLDS_CHATS.includes(a.engine) || isPastedKey(a);
/** What a maker's accounts are called on screen: in the Usage tab (usage-rules.ts), the prompts and a chat's notices. */
export const MAKER: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };

// The states signing in again fixes.
const SIGN_IN_FIXES = new Set<Account['state']>(['signed-out', 'expired', 'mismatch']);

export type Trouble = {
  engine: Engine;
  /** The account that needs you. */
  account: Account;
  /** What the button does: Claude Code's sign-in, or the maker's page in Settings, where the account's own actions are. */
  fix: 'sign-in' | 'settings';
  /** One sentence: "Claude is signed out." */
  line: string;
  /** Another account of the same maker that works, to use instead (for new chats: an open chat keeps its own). */
  other: Account | null;
};

const isState = (s: AccountsState | null | undefined): s is AccountsState => !!s && Array.isArray(s.list);

/** Is this a sign-in Claude Code keeps itself (signin-sheet.tsx shows its `claude auth login`)? A key or an environment's login is not. */
export const takesSignIn = (a: Pick<Account, 'engine' | 'kind'>) => a.engine === 'claude' && (a.kind === 'plan' || a.kind === 'console');

/** Would signing in to Claude Code again fix this account? (For Codex's login: codex-login-rules.ts `rowSignIn`.) */
export const signsIn = (a: Pick<Account, 'engine' | 'kind' | 'state'>) => takesSignIn(a) && SIGN_IN_FIXES.has(a.state);

function lineFor(a: Account): string {
  const maker = MAKER[a.engine];
  switch (a.state) {
    case 'mismatch': return `${maker} is using a different login.`;
    case 'missing': return `The folder for ${a.label} is missing.`;
    case 'locked': return `The key for ${a.label} couldn’t be read from the Keychain.`;
    case 'invalid-key': return `The key for ${a.label} no longer works.`;
    case 'blocked': return `${a.label} can’t be used: ${a.why ?? 'your settings choose the login'}.`;
    default: return `${maker} is signed out.`;
  }
}

/**
 * The account a chat is on. `pin` is what main said the chat was started on (Session's `accountId`): an account's
 * id; null for the login the tool finds on its own, whatever is chosen for new chats; or left out when the window
 * has not been told, which is answered as for a new chat: the account new chats start on.
 */
export function chatAccount(state: AccountsState | null | undefined, engine: Engine, pin?: string | null): Account | null {
  if (!isState(state)) return null;
  const id = typeof pin === 'string' ? pin : pin === null ? state.own?.[engine] : state.inUse?.[engine];
  return (id && state.list.find((a) => a.engine === engine && a.id === id)) || null;
}

/**
 * What stands between a chat and its next message, or null when nothing does. `pin`: the account the chat was
 * started on (see `chatAccount`); left out, the question is about a maker's new chats. Only an account whose
 * chats wait for it is answered for (`holds`): a chat on Codex's own login is left exactly as it was.
 */
export function troubleFor(state: AccountsState | null | undefined, engine: Engine, pin?: string | null): Trouble | null {
  if (!isState(state)) return null;
  const account = chatAccount(state, engine, pin);
  if (!account || !isBroken(account) || !holds(account)) return null;
  return {
    engine, account, fix: signsIn(account) ? 'sign-in' : 'settings', line: lineFor(account),
    other: state.list.find((a) => a.engine === engine && a.id !== account.id && a.state === 'ok') ?? null,
  };
}

/** Every maker whose new chats are held up, Claude first. */
export function troubles(state: AccountsState | null | undefined): Trouble[] {
  return ENGINES.map((engine) => troubleFor(state, engine)).filter((t): t is Trouble => t !== null);
}

/** The prompt at launch: a title, one sentence, and its buttons (`use` only when another account works). */
export function promptWords(t: Trouble): { title: string; body: string; primary: string; use: string | null } {
  const maker = MAKER[t.engine];
  const until = `Until then, ${maker} chats can’t send.`;
  return {
    title: t.account.state === 'mismatch' ? `${maker} is using a different login` : t.fix === 'sign-in' ? `${maker} is signed out` : `${maker} needs attention`,
    body: t.fix === 'sign-in' ? `Your ${t.account.label} account needs signing in again. ${until}` : `${t.line} ${until}`,
    primary: t.fix === 'sign-in' ? 'Sign in…' : 'Open Settings…',
    use: t.other ? `Use ${t.other.label}` : null,
  };
}

/** A notice's button: send a prompt (`prompt`), or open the maker's sign-in (`signIn`). */
export type NoticeAction = { label: string; prompt: string } | { label: string; signIn: Engine };

// How a chat says it could not sign in: the turn's own error, Claude Code's sign-in status, or a start that was
// refused because the chat's account is signed out.
const REFUSED = /^account-(signed-out|expired|mismatch)$/;
const couldNotSignIn = (ev: { code?: unknown; apiError?: unknown }) => ev.code === 'auth'
  || (ev.code === 'api-error' && ev.apiError === 'authentication_failed')
  || (typeof ev.code === 'string' && REFUSED.test(ev.code));

// A Codex chat's turn that OpenAI refused, as its adapter reports it (src/core/codex-adapter.mjs). The same test
// main makes before it asks Codex who is signed in (src/core/accounts-codex-login.mjs).
const codexRefused = (ev: { kind?: unknown; code?: unknown; apiError?: unknown; apiStatus?: unknown }) =>
  ev.kind === 'notice' && ev.code === 'api-error' && (ev.apiError === 'unauthorized' || ev.apiStatus === 401);

/** What a Codex chat on a pasted key says when OpenAI refused its turn. What fixes the key is on its row in Settings. */
export const KEY_REFUSED = 'OpenAI didn’t accept this chat’s API key.';

/**
 * A chat event that means "could not sign in", as the notice to show: its words and its Sign in… button. Null
 * for every other event. A saved chat says it in the past: it is a record of why that turn stopped.
 * A Codex chat keeps Codex's own sentence and gets the button for Codex's sign-in, which is only drawn while
 * Codex's login needs one (account-prompt.tsx `SignInAction`).
 * `pin`: the account the chat is on, as main named it (Meta's `accountId`). Main names a Codex chat's account
 * only when it is a key pasted into Canopy, never for Codex's own login (src/core/accounts-codex.mjs
 * `chatAccount`). Such a chat ran on that key: Codex's sign-in would change nothing for it, so it gets a line
 * about the key and no button.
 */
export function signInNotice(ev: { kind?: unknown; code?: unknown; apiError?: unknown; apiStatus?: unknown; text?: unknown }, engine: Engine, history = false, pin?: string | null): { text: string; action?: NoticeAction } | null {
  if (engine === 'codex') {
    if (!codexRefused(ev) || typeof ev.text !== 'string' || !ev.text) return null;
    if (typeof pin === 'string' && pin) return { text: KEY_REFUSED };
    return { text: ev.text, action: { label: 'Sign in to Codex', signIn: 'codex' } };
  }
  if ((ev.kind !== 'notice' && ev.kind !== 'error') || !couldNotSignIn(ev)) return null;
  const maker = MAKER[engine];
  // Claude Code's own sign-in status carries what went wrong: those words stay.
  const text = ev.kind === 'notice' && ev.code === 'auth' && typeof ev.text === 'string' && ev.text ? ev.text
    : ev.code === 'account-mismatch' ? `${maker} is using a different login.`
    : history ? `${maker} was signed out.` : `${maker} is signed out.`;
  return { text, action: { label: 'Sign in…', signIn: engine } };
}

/**
 * Does a notice's Sign in… button still belong there? While the chat's account needs you, on every such notice.
 * Otherwise only on one from this sitting that no sign-in has answered yet: Claude Code may refuse a login it
 * still reports as signed in, and the button is the way out. `signedInAt`: when a sign-in last went through.
 * `account`: the account the chat is on, when it is known: one that is not a sign-in (a pasted key, a login from
 * the environment) has no sign-in to open, so it never gets the button.
 */
export function showsSignIn(notice: { at: number; hist?: boolean }, trouble: Trouble | null, signedInAt: number | undefined, account?: Pick<Account, 'engine' | 'kind'> | null): boolean {
  if (trouble) return trouble.fix === 'sign-in';
  if (account && !takesSignIn(account)) return false;
  return !notice.hist && notice.at > (signedInAt ?? 0);
}

/**
 * Claude Code's sign-in as the accounts list has it now. `auth` is what the launch's check found, and it is never
 * asked again by the window: once the list knows the account Claude's chats start on, the list is right.
 */
export function authFrom<T extends { loggedIn: boolean | null; method: string | null }>(auth: T | undefined, state: AccountsState | null | undefined): T | undefined {
  const a = chatAccount(state, 'claude');
  if (!a || !auth) return auth;
  if (isBroken(a)) return auth.loggedIn === false ? auth : { ...auth, loggedIn: false };
  if (a.state !== 'ok' || auth.loggedIn === true) return auth;
  return { ...auth, loggedIn: true, method: a.kind === 'plan' ? 'claude.ai' : 'api_key' };
}

// Accounts, window side: the logins Canopy's main process found for each maker (src/core/accounts.mjs), kept
// current, the words a row is described with, and the changes the window may ask for (choose one, paste a key,
// rename, remove). Main decides every one of them; a pasted key goes there once and never comes back.
import { useSyncExternalStore } from 'react';
import { isAddedSignIn, isBroken, refusal } from './account-rules';
import { api, type Account, type AccountReply, type AccountsState, type Engine } from './api';
import { invalidate } from './customize';

let state: AccountsState | null = null;
const subs = new Set<() => void>();

function set(next: AccountsState | { error: string } | null | undefined) {
  if (!next || 'error' in next || !Array.isArray(next.list)) return; // a failed read leaves the last list in place
  // Connector sign-ins are kept per account, and Settings → Connectors is read as the account Claude's new chats
  // use: when that becomes another account, what was read is about the old one.
  const moved = !!state && (state.inUse?.claude ?? null) !== (next.inUse?.claude ?? null);
  state = next;
  for (const f of subs) f();
  if (moved) invalidate('mcp');
}

export function useAccounts(): AccountsState | null {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state);
}

/** The list as it came with the window's first read of the app (app:init), so Settings never opens empty. */
export const seedAccounts = (first: AccountsState | undefined) => set(first);

/** Read the list now and follow main's changes. Returns the unsubscribe, like the window's other listeners. */
export function startAccounts(): () => void {
  api.accounts?.list().then(set).catch(() => {});
  return api.accounts?.onChanged(set) ?? (() => {});
}

/** Ask the tools again. Quiet: the page keeps showing what it has until the answer is in. */
export function refreshAccounts(force = false): Promise<void> {
  return api.accounts?.refresh(force).then(set).catch(() => {}) ?? Promise.resolve();
}

/** The account a maker's new chats start on: the one you chose, else the one the tool finds on its own. */
export function accountInUse(s: AccountsState | null, engine: Engine): Account | null {
  const id = s?.inUse?.[engine];
  return (id && s?.list.find((a) => a.engine === engine && a.id === id)) || null;
}

/** An account that needs you: signed out, or otherwise not usable. "Could not check" is not one of them. */
export const needsAttention = (a: Pick<Account, 'state'>) => isBroken(a);

// ---- changes ----
// Each asks main and answers the same way: done, or one line saying why not. The list itself arrives through
// `accounts:changed`, so nothing here touches it.
export type AccountDone = { ok: true; id?: string } | { ok: false; message: string; code?: string };
async function ask(call: Promise<AccountReply> | undefined): Promise<AccountDone> {
  let r: AccountReply | undefined;
  try { r = await call; } catch { r = undefined; }
  const why = refusal(r);
  return why === null ? { ok: true, id: r?.id } : { ok: false, message: why, code: r?.code };
}
/** Make this the account a maker's new chats start on (null: the login the tool finds). Open chats keep theirs. */
export const chooseAccount = (engine: Engine, id: string | null) => ask(api.accounts?.use?.(engine, id));
/** Add a pasted API key as an account. It is checked first, and adding does not switch to it. */
export const addAccountKey = (engine: Engine, key: string) => ask(api.accounts?.addKey?.(engine, key));
/** Replace a key account's key with another that works. */
export const replaceAccountKey = (engine: Engine, id: string, key: string) => ask(api.accounts?.replaceKey?.(engine, id, key));
/** Name an account (empty: its own name again). */
export const renameAccount = (engine: Engine, id: string, label: string) => ask(api.accounts?.rename?.(engine, id, label));
/** Remove an account that was added in Canopy. */
export const removeAccount = (engine: Engine, id: string) => ask(api.accounts?.remove?.(engine, id));

const TOOL: Record<Engine, string> = { claude: 'Claude Code', codex: 'Codex' };
const PROBLEM: Partial<Record<Account['state'], string>> = {
  'signed-out': 'Signed out', expired: 'Signed out', mismatch: 'Using a different login', missing: 'Its folder is missing',
  locked: 'Keychain is locked', 'invalid-key': 'Key no longer works',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// What in the environment can supply a Claude login without being a cloud provider.
const OWN_KEYS = ['ANTHROPIC_API_KEY', 'apiKeyHelper', 'token'];

/** A row's second line: what is wrong when something is, else who it is, how it is paid for and where it comes from.
 *  Each part starts with a capital ("Billed per use · Added in Canopy"), as the Usage tab's line does. */
export function accountLine(a: Account): string {
  if (a.state === 'blocked') return cap(a.why ?? 'your settings choose the login');
  if (needsAttention(a)) return PROBLEM[a.state] ?? 'Needs attention';
  const tool = TOOL[a.engine];
  // A sign-in added in Canopy was still made through the tool's own sign-in, and says so like the one Canopy found.
  const from = a.found ? null : isAddedSignIn(a) ? `signed in through ${tool}` : 'added in Canopy';
  let how: (string | null)[];
  if (a.kind === 'plan') how = [a.plan ? `${cap(a.plan)} plan` : null, from ?? `signed in through ${tool}`];
  else if (a.kind === 'external' && a.engine === 'claude') {
    how = [a.via && !OWN_KEYS.includes(a.via) ? 'billed by your provider' : 'billed per use',
      a.via === 'apiKeyHelper' ? `set in your ${tool} settings` : 'set in your environment'];
  } else if (a.kind === 'external') how = [`from ${tool}`]; // a kind of login Canopy does not know yet: say only where it is from
  else how = ['billed per use', from ?? `from ${tool}`];
  const rest = how.filter((x): x is string => !!x).map(cap).join(' · ');
  return a.email ? `${a.email} · ${rest}` : rest; // an email leads as it is written
}

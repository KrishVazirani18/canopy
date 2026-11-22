// Accounts, host side: builds the registry (src/core/accounts.mjs) from what each engine knows, and gives the
// window its two calls. Thin on purpose: main.mjs only says where the tools are and where state is kept, and
// uses what this returns at each place it launches a tool (`envFor`). What changes an account (choosing one,
// pasted keys) is in src/account-actions.mjs.
import { Accounts } from './core/accounts.mjs';
import { claudeAccounts } from './core/accounts-claude.mjs';
import { codexAccounts } from './core/accounts-codex.mjs';

// Opening a maker's page in Settings (where its accounts are) asks the tools again, but a page reopened within this
// long shows what it has.
const PAGE_FRESH_MS = 15_000;

/**
 * Wire the registry and its IPC channels. Read-only from the window: it can list and re-check, nothing else.
 * @param {(channel: string, fn: Function) => void} handle main's guarded `ipcMain.handle`
 * @param {{
 *   claude: () => ({ path: string | null, env: object | null }),     where Claude Code is and what it is launched with
 *   claudeHome?: (account: object, base: object, opts?: object) => void,   care of a sign-in's own folder (src/account-folders.mjs)
 *   codex?: { account: () => Promise<object>, installed: () => boolean, env: () => object | null, works?: () => Promise<object> },
 *   load: () => object | null | undefined, save: (state: object) => unknown,   state.json's `accounts`
 *   send: (channel: string, payload: unknown) => void, log?: (msg: string) => void,
 *   keyFor?: (account: object) => string | null,                  a pasted key's secret, for the launch (src/secrets.mjs)
 *   checkKey?: (account: object) => Promise<{ state: string }>,   how a pasted key is doing (src/account-actions.mjs)
 * }} host
 * @returns {Accounts}
 */
export function registerAccounts(handle, { claude, claudeHome, codex, load, save, send, log, keyFor, checkKey } = {}) {
  const accounts = new Accounts({
    engines: { claude: claudeAccounts({ tool: claude, checkKey, home: claudeHome }), ...(codex && { codex: codexAccounts({ ...codex, checkKey }) }) },
    load, save, log, keyFor,
    onChange: (view) => send?.('accounts:changed', view),
  });
  handle('accounts:list', async () => accounts.view());
  handle('accounts:refresh', async (force) => accounts.refresh(force === true ? {} : { maxAgeMs: PAGE_FRESH_MS }));
  return accounts;
}

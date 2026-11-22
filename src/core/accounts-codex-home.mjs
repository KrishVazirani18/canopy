// A second Codex login's launch recipe: how a Codex process is pointed at the folder that login is kept in.
//
// Codex keeps one login per folder, and finds its folder through one variable. A login added in Canopy lives in a
// folder of its own (src/codex-account-home.mjs), so a process for it is started with that variable naming the
// folder. Everything else Codex keeps by folder would then be apart too, its index of chats above all. A second
// variable says where the index is: the user's own Codex folder, the same one their own Codex uses. So a chat begun
// on any login is in the one list, with its name and its turns, whichever login looks.
//
// This is the only place in Canopy that sets either variable. A process started with nothing chosen, for the login
// Codex holds itself, or for a pasted key gets neither: it finds Codex's own folder by itself, as Codex does in a terminal
// (accounts-codex.mjs `launchEnv`, which is what calls this).
//
// All this file looks at on disk is whether the account's folder is there.
import { statSync } from 'node:fs';
import path from 'node:path';
import { refuse } from './accounts.mjs';

/** The variable that names the folder Codex keeps its login in. */
export const HOME_VAR = 'CODEX_HOME';
/** The variable that names where Codex keeps its index of chats (its databases). */
export const INDEX_VAR = 'CODEX_SQLITE_HOME';

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * The environment a Codex process gets for a login kept in a folder of its own: the base, with HOME_VAR naming
 * that folder and INDEX_VAR naming the user's own Codex folder. Always a new object.
 * @param {{ dir: string }} account the account, with its folder
 * @param {Record<string, string>} base the environment a Codex process would get anyway
 * @param {{ codexHome: string, name?: string }} opts `codexHome`: the user's own Codex folder, as their Codex
 *   itself reports it when it starts
 * @throws a `refuse` error when the folder is gone, or when either folder is not named in full. Never hands back
 *   an environment that would start Codex on another login.
 */
export function folderEnv(account, base, { codexHome, name = 'This account' } = {}) {
  if (!isPlain(base)) throw refuse('no-env', 'Canopy has not finished checking your setup yet.', { recoverable: true });
  if (!isPlain(account) || !isAbs(account.dir) || !isAbs(codexHome)) throw refuse('account-unsupported', `${name} is not an account Codex can be started on.`);
  // Looked at on every launch: a folder that is gone must never come to mean "the login Codex holds instead".
  if (!isDir(account.dir)) throw refuse('account-missing', `The folder for ${name} is missing.`);
  const env = { ...base, [HOME_VAR]: account.dir };
  // If the user's environment already says where the index is, theirs stands: their own Codex goes by it too.
  // (A place named in their Codex settings wins over both, and this folder shares those settings.)
  if (typeof base[INDEX_VAR] !== 'string' || !base[INDEX_VAR]) env[INDEX_VAR] = codexHome;
  return env;
}

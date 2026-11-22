// Claude accounts: what Canopy asks Claude Code about its logins, and how each kind of account is launched.
//
// Who is signed in comes from two places only, both Claude Code's own answers: `claude auth status --json`, and
// the account a chat's process reports when it starts. Canopy never opens Claude Code's login files or the
// Keychain entry behind them, and never holds a plan login. This file runs no process of its own (the asking is
// env.mjs's `authStatus`) and reads no file: all it looks at on disk is whether an account's folder is there.
//
//   LOGIN_VARS           the variables that decide which login Claude Code uses
//   withoutLogin(env)    a copy of an environment without them
//   launchEnv(...)       the recipe table: the environment each kind of account is launched with
//   describeAuth(auth)   one `auth status` answer as an account: who, which kind, signed in or not
//   claudeAccounts(...)  the engine object the registry works with (see accounts.mjs)
import { statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { refuse } from './accounts.mjs';
import { authStatus, configHome } from './env.mjs';

/** The sign-in Claude Code holds in its own folder: a plan, or a Console login. */
export const DEFAULT_ID = 'claude-default';
/** Whatever the environment or the settings supply instead: a key in the shell, a key helper, a cloud provider. */
export const ENV_ID = 'claude-env';

// Variables that decide which login Claude Code uses. Launching a chosen sign-in leaves all of them out, so a key
// exported in the shell cannot quietly outrank the account you picked. The proxy ones (base URL, its token, its
// headers) go together: a plan login must never be sent to a proxy. Variables that only tune a cloud provider
// (regions, project ids) stay: without the switch that turns the provider on they do nothing.
export const LOGIN_VARS = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY',
]);
const LOGIN_SET = new Set(LOGIN_VARS);

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' && v ? v : null);
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
// The same folder, however it is spelled (~/.claude may itself be a link).
export function sameDir(a, b) {
  if (!str(a) || !str(b)) return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** A copy of `env` without the variables that choose a login. */
export function withoutLogin(env) {
  const out = {};
  for (const [k, v] of Object.entries(isPlain(env) ? env : {})) if (!LOGIN_SET.has(k)) out[k] = v;
  return out;
}

/**
 * The environment Claude Code is launched with for an account:
 *
 *   nothing chosen (account null)       the base, unchanged: what Canopy has always launched it with
 *   external (shell key, helper, cloud) the base, unchanged: the environment is the account
 *   the sign-in in Claude Code's folder the base without the login variables
 *   a sign-in in a folder of its own    that, plus CLAUDE_CONFIG_DIR and the user's own plugin folder
 *   a pasted API key                    the base without the login variables, plus ANTHROPIC_API_KEY
 *
 * Always a new object. Throws `refuse(...)` instead of ever handing back another login's environment.
 * @param {object | null} account a registry entry, or null
 * @param {Record<string, string>} base
 * @param {{ key?: string | null, name?: string }} [opts] `key`: a pasted key's secret, which is never kept in the registry
 */
export function launchEnv(account, base, { key, name = 'This account' } = {}) {
  if (!isPlain(base)) throw refuse('no-env', 'Canopy has not finished checking your setup yet.', { recoverable: true });
  if (!account || account.kind === 'external') return { ...base };
  const env = withoutLogin(base);
  if (account.kind === 'key') {
    if (typeof key !== 'string' || !key) throw refuse('account-locked', `The key for ${name} could not be read from the Keychain.`);
    // Like a key exported in a terminal, the tools Claude Code runs can read it. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
    // would hide it from them, but is left unset: it also forces the permission mode back to default and pins the
    // command sandbox to the launch folder (Claude Code 2.1.325), which changes how every chat on the key works.
    env.ANTHROPIC_API_KEY = key;
    return env;
  }
  if (account.dir) {
    if (!isDir(account.dir)) throw refuse('account-missing', `The folder for ${name} is missing.`);
    env.CLAUDE_CONFIG_DIR = account.dir;
    // An account folder holds a sign-in, not a second setup: plugins stay the ones in the user's own folder.
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR = str(base.CLAUDE_CODE_PLUGIN_CACHE_DIR) ?? path.join(configHome(base), 'plugins');
  }
  return env;
}

/**
 * One `claude auth status` answer (as env.mjs's authStatus returns it) as an account.
 *   { state: 'unknown' }        Claude Code did not answer: never the same as signed out
 *   { state: 'signed-out' }
 *   { state: 'ok', kind, via, email, org, orgId, plan, configDir }
 * `kind` is `plan` (a Claude subscription), `console` (a Console sign-in, billed per use) or `external`, with
 * `via` saying what supplies the login: 'ANTHROPIC_API_KEY', 'apiKeyHelper', 'token', or the cloud provider.
 */
export function describeAuth(auth) {
  if (!isPlain(auth) || typeof auth.loggedIn !== 'boolean') return { state: 'unknown' };
  if (!auth.loggedIn) return { state: 'signed-out' };
  const who = { email: str(auth.email), org: str(auth.org), orgId: str(auth.orgId), configDir: str(auth.configDir) };
  const provider = str(auth.provider);
  if (provider && provider !== 'firstParty') return { state: 'ok', kind: 'external', via: provider, plan: null, ...who };
  if (auth.method === 'claude.ai') return { state: 'ok', kind: 'plan', via: null, plan: str(auth.subscriptionType), ...who };
  if (auth.method === 'api_key' && auth.apiKeySource === '/login managed key') return { state: 'ok', kind: 'console', via: null, plan: null, ...who };
  const via = auth.method === 'api_key' ? str(auth.apiKeySource) ?? 'ANTHROPIC_API_KEY'
    : auth.method === 'api_key_helper' ? 'apiKeyHelper'
    : auth.method === 'oauth_token' ? 'token'
    : str(auth.method) ?? 'environment';
  return { state: 'ok', kind: 'external', via, plan: null, ...who };
}

const PLANS = { free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
const PROVIDERS = { bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry', gateway: 'Gateway' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What to call an account the user has not named. */
export function labelFor(a) {
  if (a?.kind === 'plan') return a.plan ? PLANS[a.plan.toLowerCase()] ?? cap(a.plan) : 'Claude plan';
  if (a?.kind === 'console') return 'Console';
  if (a?.kind === 'key') return a.keyHint ? `API key ••••${a.keyHint}` : 'API key';
  if (a?.via === 'apiKeyHelper') return 'API key helper';
  if (a?.via === 'token') return 'Access token';
  if (a?.via === 'ANTHROPIC_API_KEY') return 'API key';
  return PROVIDERS[a?.via] ?? 'Cloud provider';
}

/**
 * Does the account a chat's process reported (the SDK's account info) match this one? True, false, or null when
 * it cannot be told. Plan names are not compared: the process and `auth status` word them differently.
 * @param {object} account
 * @param {{ email?: string|null, provider?: string|null, apiKeySource?: string|null, tokenSource?: string|null }} reported
 */
export function agrees(account, reported) {
  if (!isPlain(account) || !isPlain(reported)) return null;
  const provider = str(reported.provider);
  const cloud = !!provider && provider !== 'firstParty';
  const keyed = reported.apiKeySource === 'ANTHROPIC_API_KEY' || reported.apiKeySource === 'apiKeyHelper';
  if (account.kind === 'external') {
    if (account.via === 'ANTHROPIC_API_KEY' || account.via === 'apiKeyHelper') return cloud ? false : reported.apiKeySource ? reported.apiKeySource === account.via : null;
    if (account.via === 'token') return cloud ? false : null;
    return provider ? account.via === provider : null; // a cloud provider
  }
  if (account.kind === 'key') return reported.apiKeySource ? reported.apiKeySource === 'ANTHROPIC_API_KEY' && !cloud : null;
  // A sign-in: a cloud provider or a key in its place means something outranked it.
  if (cloud || keyed) return false;
  if (account.email && str(reported.email)) return sameText(account.email, reported.email);
  return null;
}

/**
 * The engine object for Claude (see accounts.mjs).
 * @param {{
 *   tool: () => ({ path: string | null, env: object | null }), ask?: typeof authStatus,
 *   checkKey?: (account: object) => Promise<{ state: string, why?: string }>,
 *   home?: (account: object, base: object, opts?: { name?: string }) => void,
 * }} deps
 *   `tool`: where Claude Code is and the environment it is launched with. `ask`: the test seam for `authStatus`.
 *   `checkKey`: how a pasted key is checked. The host does it: it alone can read the key (see `keyFor`).
 *   `home`: the host's care of a sign-in's own folder (src/account-folders.mjs). Called before the folder is used;
 *   it puts the folder in order and throws `refuse(...)`, with `canopy.why`, when it cannot. This file still
 *   touches no file itself.
 */
export function claudeAccounts({ tool, ask = authStatus, checkKey, home } = {}) {
  const here = () => {
    try { const t = tool?.() ?? {}; return { claudePath: str(t.path), env: isPlain(t.env) ? t.env : null }; }
    catch { return { claudePath: null, env: null }; }
  };
  const who = ({ kind, via, email, org, orgId, plan }) => ({ kind, via, email, org, orgId, plan });
  const ready = (account, base, opts) => { if (account?.dir && isPlain(base) && typeof home === 'function') home(account, base, opts); };

  return {
    ids: [DEFAULT_ID, ENV_ID],
    base: () => here().env,
    // A sign-in in a folder of its own is launched only on a folder that is in order.
    launchEnv: (account, base, opts) => { ready(account, base, opts); return launchEnv(account, base, opts); },
    label: labelFor,
    agrees,
    // With nothing chosen, an external login is what Claude Code uses whenever there is one: it outranks the sign-in.
    asFound: (list) => (list.find((a) => a.id === ENV_ID) ?? list.find((a) => a.id === DEFAULT_ID))?.id ?? null,

    /**
     * Ask Claude Code what it is signed in with, as it stands. When the environment supplies the login, ask once
     * more without the login variables, to see the sign-in Claude Code itself holds underneath.
     * @param {{ auth?: object }} [hint] an `auth status` answer for the unchanged environment, if the caller has one
     */
    async detect({ auth } = {}) {
      const { claudePath, env } = here();
      if (!claudePath || !env) return { known: false }; // not installed, or not looked for yet: nothing is known either way
      const first = describeAuth(auth ?? await ask(claudePath, env));
      if (first.state === 'unknown') return { known: false };
      if (first.state === 'signed-out') return { known: true, accounts: [{ id: DEFAULT_ID, state: 'signed-out' }] };
      if (first.kind !== 'external') return { known: true, accounts: [{ id: DEFAULT_ID, state: 'ok', ...who(first) }] };
      const accounts = [{ id: ENV_ID, state: 'ok', ...who(first) }];
      const clean = withoutLogin(env);
      // Nothing to leave out: the settings supply the login, and what is underneath cannot be seen from here.
      if (Object.keys(clean).length === Object.keys(env).length) accounts.push({ id: DEFAULT_ID, state: 'unknown' });
      else {
        const second = describeAuth(await ask(claudePath, clean));
        if (second.state === 'ok' && second.kind !== 'external') accounts.push({ id: DEFAULT_ID, state: 'ok', ...who(second) });
        else accounts.push({ id: DEFAULT_ID, state: second.state === 'signed-out' ? 'signed-out' : 'unknown' });
      }
      return { known: true, accounts };
    },

    /**
     * Ask about one account Canopy added. A pasted key is checked with the API, by the host that keeps it. A
     * sign-in kept in a folder of its own is asked about here: "signed in" alone proves nothing (a key in the
     * settings makes any folder look signed in), so the answer must be a sign-in, and for that very folder.
     */
    async verify(account) {
      if (account?.kind === 'key') return typeof checkKey === 'function' ? checkKey({ ...account }) : { state: 'unknown' };
      if (!account?.dir) return { state: 'unknown' };
      const { claudePath, env } = here();
      if (!claudePath || !env) return { state: 'unknown' };
      if (!isDir(account.dir)) return { state: 'missing' };
      try { ready(account, env); }
      catch (err) {
        if (err?.canopy?.recoverable === true) return { state: 'unknown' }; // it will pass by itself: nothing to mark
        return { state: 'blocked', why: str(err?.canopy?.why) ?? 'its folder could not be set up' };
      }
      const a = describeAuth(await ask(claudePath, launchEnv(account, env)));
      if (a.state !== 'ok') return { state: a.state };
      if (a.kind === 'external') return { state: 'blocked', why: 'your Claude Code settings choose the login' };
      if (!sameDir(a.configDir, account.dir)) return { state: 'mismatch', why: 'Claude Code answered for a different folder' };
      if (account.email && a.email && !sameText(account.email, a.email)) return { state: 'mismatch', why: 'a different account is signed in there' };
      return { state: 'ok', ...who(a) };
    },
  };
}

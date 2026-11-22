// signin.mjs: Claude Code's own sign-in, run in a terminal Canopy only watches for the exit of.
// No test here runs `claude auth login`, on any login. The terminal is a fake that records what it was started
// with and what was written to it; where a `claude` is needed to answer `auth status` it is a shell script in a
// throwaway folder, and that script fails the test if it is ever handed anything but `auth status --json`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { core } from '../helpers.mjs';

const S = await core('signin.mjs');
const C = await core('accounts-claude.mjs');
const missing = S.__missing ? `signin.mjs: ${S.__missing}` : C.__missing ? `accounts-claude.mjs: ${C.__missing}` : false;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-signin-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;
const dir = (name = `d${++seq}`) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
function script(file, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, mode);
  return file;
}

// What the login shell might hand the app: every token variable, a proxy, a cloud switch, and what an agent
// session or the app's own runtime leaves behind.
const TOKENS = Object.freeze({
  ANTHROPIC_API_KEY: 'sk-shell-key-0001', ANTHROPIC_AUTH_TOKEN: 'shell-auth-token-0002', CLAUDE_CODE_OAUTH_TOKEN: 'shell-oauth-token-0003',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'shell-refresh-token-0004', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
});
const SHELL = Object.freeze({
  PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8', MY_VAR: 'kept', ...TOKENS,
  ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_CUSTOM_HEADERS: 'X-A: 1', CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1',
});
const CLEAN = Object.freeze({ PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8', MY_VAR: 'kept' });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, label = 'condition') => { for (let i = 0; i < 400; i++) { if (ok()) return; await tick(5); } assert.fail(`timed out waiting for ${label}`); };

// ---- the environment and the arguments ----

test('a sign-in never starts with a token variable, a proxy, a cloud switch or another client’s marks', { skip: missing }, () => {
  const env = S.signInEnv(SHELL);
  assert.deepEqual(env, CLEAN);
  for (const k of S.TOKEN_VARS) assert.ok(!(k in env), `${k} reached the sign-in`);
  for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.ok(!(k in env), `${k} reached the sign-in`);
  assert.deepEqual([...S.TOKEN_VARS].sort(), Object.keys(TOKENS).sort(), 'the five token variables, by name');
  for (const k of S.TOKEN_VARS) assert.ok(C.LOGIN_VARS.includes(k), `${k} is also left out of a chosen sign-in's chats`);
  assert.notEqual(S.signInEnv(CLEAN), CLEAN, 'always a copy');
  assert.equal(SHELL.ANTHROPIC_API_KEY, 'sk-shell-key-0001', 'the base is not changed');
  // The user's own folder for Claude Code is Claude Code's own folder: it stays.
  assert.equal(S.signInEnv({ ...SHELL, CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work' }).CLAUDE_CONFIG_DIR, '/Users/someone/.claude-work');
});

test('an account in a folder of its own signs in to that folder; a missing folder or no environment starts nothing', { skip: missing }, () => {
  const folder = dir();
  const env = S.signInEnv({ ...SHELL, CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work' }, folder);
  assert.equal(env.CLAUDE_CONFIG_DIR, folder);
  assert.equal(env.CLAUDE_CODE_PLUGIN_CACHE_DIR, '/Users/someone/.claude-work/plugins');
  for (const k of S.TOKEN_VARS) assert.ok(!(k in env));
  assert.throws(() => S.signInEnv(SHELL, path.join(root, 'not-there')), (err) => err.code === 'account-missing' && /this account/.test(err.message));
  for (const junk of [null, undefined, 'x', []]) assert.throws(() => S.signInEnv(junk), (err) => err.code === 'no-env');
});

test('the arguments are Claude Code’s own, and an address that is not plainly one is left out', { skip: missing }, () => {
  assert.deepEqual(S.signInArgs(), ['auth', 'login']);
  assert.deepEqual(S.signInArgs({}), ['auth', 'login']);
  assert.deepEqual(S.signInArgs({ console: true }), ['auth', 'login', '--console']);
  assert.deepEqual(S.signInArgs({ console: false, sso: true }), ['auth', 'login', '--sso']);
  assert.deepEqual(S.signInArgs({ console: true, email: 'me@example.com' }), ['auth', 'login', '--console', '--email', 'me@example.com']);
  assert.deepEqual(S.signInArgs({ email: 'first.last+tag@sub.example.co' }), ['auth', 'login', '--email', 'first.last+tag@sub.example.co']);
  // Truthy is not `true`, and nothing that could be read as another option or break out of a script gets through.
  assert.deepEqual(S.signInArgs({ console: 'yes', sso: 1 }), ['auth', 'login']);
  for (const bad of ['--console', '-x@example.com', 'a b@example.com', "me'@example.com", 'me@exa mple.com', 'me@example.com --sso', 'me@', '@example.com', '', 7, null, 'a@b.c\n--sso', `${'a'.repeat(80)}@example.com`]) {
    assert.deepEqual(S.signInArgs({ email: bad }), ['auth', 'login'], `kept ${JSON.stringify(bad)}`);
  }
});

// ---- asking Claude Code afterwards ----

// A `claude` that answers `auth status --json` by the folder it is asked about, and writes down every call.
function fakeClaude() {
  const folder = dir();
  const calls = path.join(folder, 'calls');
  const answer = (fields) => `echo '${JSON.stringify(fields)}'`;
  const bin = script(path.join(folder, 'claude'), [
    `echo "$*" >> '${calls}'`,
    'if [ "$1 $2 $3" != "auth status --json" ]; then echo "only auth status is ever asked" >&2; exit 64; fi',
    'case "$CLAUDE_CONFIG_DIR" in',
    `  *good) ${answer({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'me@example.com', orgId: 'o1', orgName: 'Acme', configDirectory: '__DIR__' }).replace('__DIR__', "'\"$CLAUDE_CONFIG_DIR\"'")} ;;`,
    `  *console) ${answer({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: '/login managed key', email: 'me@example.com', orgId: 'o2', configDirectory: '__DIR__' }).replace('__DIR__', "'\"$CLAUDE_CONFIG_DIR\"'")} ;;`,
    `  *elsewhere) ${answer({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', configDirectory: '/Users/someone/.claude' })} ;;`,
    `  *nofolder) ${answer({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com' })} ;;`,
    `  *helper) ${answer({ loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty', configDirectory: '__DIR__' }).replace('__DIR__', "'\"$CLAUDE_CONFIG_DIR\"'")} ;;`,
    `  *out) ${answer({ loggedIn: false })} ;;`,
    '  *silent) exit 3 ;;',
    `  *) ${answer({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro', email: 'own@example.com', configDirectory: path.join(os.homedir(), '.claude') })} ;;`,
    'esac',
  ].join('\n'));
  const asked = () => { try { return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { bin, asked };
}

test('after exit 0 Claude Code is asked who signed in, and the answer must be a sign-in for that very folder', { skip: missing, timeout: 60000 }, async () => {
  const { bin, asked } = fakeClaude();
  const accounts = dir('accounts');
  const check = (name) => { const d = path.join(accounts, name); fs.mkdirSync(d, { recursive: true }); return S.confirmSignIn({ claudePath: bin, env: S.signInEnv(SHELL, d), dir: d }); };

  assert.deepEqual(await check('good'), { ok: true, who: { kind: 'plan', email: 'me@example.com', org: 'Acme', orgId: 'o1', plan: 'max' } });
  assert.deepEqual(await check('console'), { ok: true, who: { kind: 'console', email: 'me@example.com', org: null, orgId: 'o2', plan: null } });
  assert.deepEqual(await check('elsewhere'), { ok: false, code: 'mismatch' }, 'signed in, but it answered for another folder');
  assert.deepEqual(await check('nofolder'), { ok: false, code: 'unverified' }, 'a folder of its own must be named in the answer');
  assert.deepEqual(await check('helper'), { ok: false, code: 'blocked' }, 'the settings supply the login: that is not this sign-in');
  assert.deepEqual(await check('out'), { ok: false, code: 'signed-out' });
  assert.deepEqual(await check('silent'), { ok: false, code: 'unverified' }, 'no answer is not "signed in", and not "signed out"');

  // Claude Code's own folder: where it looks when no folder is given.
  assert.deepEqual(await S.confirmSignIn({ claudePath: bin, env: S.signInEnv(SHELL) }), { ok: true, who: { kind: 'plan', email: 'own@example.com', org: null, orgId: null, plan: 'pro' } });
  const moved = await S.confirmSignIn({ claudePath: bin, env: S.signInEnv({ ...SHELL, CLAUDE_CONFIG_DIR: path.join(accounts, 'elsewhere') }) });
  assert.deepEqual(moved, { ok: false, code: 'mismatch' }, 'the user’s own folder is checked the same way');
  // An older Claude Code that does not say which folder: its own folder is the only one it could mean.
  assert.equal((await S.confirmSignIn({ claudePath: bin, env: S.signInEnv(SHELL), ask: async () => ({ loggedIn: true, method: 'claude.ai', provider: 'firstParty' }) })).ok, true);
  assert.deepEqual(await S.confirmSignIn({ claudePath: bin, env: CLEAN, ask: async () => { throw new Error('boom'); } }), { ok: false, code: 'unverified' });

  assert.ok(asked().length >= 8 && asked().every((line) => line === 'auth status --json'), 'Claude Code was only ever asked for its status');
  assert.deepEqual(fs.readdirSync(accounts).sort(), ['console', 'elsewhere', 'good', 'helper', 'nofolder', 'out', 'silent'], 'checking creates nothing');
  for (const name of fs.readdirSync(accounts)) assert.deepEqual(fs.readdirSync(path.join(accounts, name)), [], 'and writes nothing into a folder');
});

// ---- the script for Terminal ----

test('the Terminal script clears the login variables, names only the account’s folder, and holds no secret', { skip: missing }, () => {
  const folder = dir("it's here");
  const own = S.terminalScript({ claudePath: '/Users/some one/.local/bin/claude', base: SHELL, env: S.signInEnv(SHELL), args: S.signInArgs({ console: true, email: 'me@example.com' }) });
  const lines = own.split('\n');
  assert.equal(lines[0], '#!/bin/sh');
  assert.ok(lines.includes(`unset ${C.LOGIN_VARS.join(' ')}`));
  assert.equal(lines.at(-2), "exec '/Users/some one/.local/bin/claude' 'auth' 'login' '--console' '--email' 'me@example.com'");
  assert.ok(!/export /.test(own), 'Claude Code’s own folder: nothing to point it at');
  for (const v of Object.values(TOKENS)) assert.ok(!own.includes(v), 'a token value was written into the script');
  assert.ok(!own.includes('proxy.example'));

  const extra = S.terminalScript({ claudePath: '/usr/local/bin/claude', base: SHELL, env: S.signInEnv(SHELL, folder), args: S.signInArgs() });
  assert.ok(extra.includes(`export CLAUDE_CONFIG_DIR='${folder.replace("'", "'\\''")}'`), 'a quote in a path cannot end the string');
  assert.ok(extra.includes(`export CLAUDE_CODE_PLUGIN_CACHE_DIR='${path.join(os.homedir(), '.claude', 'plugins')}'`));
  assert.equal(extra.split('\n').at(-2), "exec '/usr/local/bin/claude' 'auth' 'login'");
});

// ---- the runner, with a terminal that records ----

function fakeTerminal({ fail = false } = {}) {
  const made = [];
  const spawn = (file, args, opts) => {
    if (fail) throw Object.assign(new Error('posix_spawnp failed'), { code: 'ENOENT' });
    const p = {
      file, args, opts, wrote: [], sizes: [], kills: [], data: null, exit: null,
      onData(cb) { p.data = cb; return { dispose() {} }; }, onExit(cb) { p.exit = cb; return { dispose() {} }; },
      write(d) { p.wrote.push(d); }, resize(c, r) { p.sizes.push([c, r]); }, kill(sig) { p.kills.push(sig ?? 'SIGHUP'); },
      says(text) { p.data?.(text); }, ends(exitCode) { p.exit?.({ exitCode, signal: 0 }); },
    };
    made.push(p);
    return p;
  };
  return { spawn, made, get last() { return made.at(-1); } };
}

const PLAN = Object.freeze({ loggedIn: true, method: 'claude.ai', provider: 'firstParty', subscriptionType: 'max', email: 'me@example.com', org: 'Acme', orgId: 'o1' });
const DEFAULT = Object.freeze({ id: 'claude-default', engine: 'claude', kind: 'plan', dir: null, label: null, email: 'me@example.com', plan: 'max', state: 'signed-out' });

function make({ env = SHELL, accounts = [DEFAULT], auth = PLAN, term = fakeTerminal(), ...over } = {}) {
  const states = [], out = [], logs = [], confirmed = [], asked = [], scripts = [];
  const signIn = new S.SignIn({
    spawn: term.spawn, tool: () => ({ path: '/opt/fake/claude', env }),
    account: (id) => accounts.find((a) => a.id === id) ?? null,
    ask: async (claudePath, withEnv) => { asked.push({ claudePath, env: withEnv }); return typeof auth === 'function' ? auth(withEnv) : auth; },
    onData: (id, data) => out.push([id, data]), onState: (s) => states.push(s),
    onSignedIn: (r) => { confirmed.push(r); return over.named; },
    openTerminal: async (text) => { scripts.push(text); return over.terminal ?? { ok: true }; },
    log: (m) => logs.push(m), attachMs: over.attachMs ?? 20_000, killMs: over.killMs ?? 20,
  });
  const phases = () => states.map((s) => s.phase);
  return { signIn, term, states, phases, out, logs, confirmed, asked, scripts };
}

test('a sign-in runs Claude Code’s own command in a terminal, and counts only once Claude Code confirms it', { skip: missing }, async () => {
  const { signIn, term, states, phases, asked, confirmed } = make({ named: { label: 'Max' } });
  const r = signIn.begin({ accountId: 'claude-default' });
  assert.equal(r.ok, true);
  assert.equal(term.made.length, 0, 'nothing runs until a terminal is there to show it');
  assert.deepEqual(states.at(-1), { id: r.id, engine: 'claude', phase: 'ready', account: 'claude-default', label: 'Max', console: false, canSwitch: false, code: null, message: null, who: null });

  assert.deepEqual(signIn.attach(r.id, 96, 20), { ok: true });
  const p = term.last;
  assert.equal(p.file, '/opt/fake/claude');
  assert.deepEqual(p.args, ['auth', 'login', '--email', 'me@example.com'], 'the address it was signed in with is prefilled');
  assert.deepEqual([p.opts.cols, p.opts.rows, p.opts.name, p.opts.cwd], [96, 20, 'xterm-256color', os.homedir()]);
  assert.deepEqual(p.opts.env, { ...CLEAN, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  for (const k of S.TOKEN_VARS) assert.ok(!(k in p.opts.env), `${k} reached the sign-in`);
  assert.equal(signIn.state.phase, 'running');
  assert.deepEqual(signIn.attach(r.id, 96, 20), { ok: true });
  assert.equal(term.made.length, 1, 'attaching twice starts it once');

  p.ends(0);
  assert.equal(signIn.state.phase, 'checking');
  const done = await r.done;
  assert.deepEqual(done, { ok: true, accountId: 'claude-default', dir: null, who: { kind: 'plan', email: 'me@example.com', org: 'Acme', orgId: 'o1', plan: 'max' } });
  assert.deepEqual(asked.map((a) => [a.claudePath, a.env]), [['/opt/fake/claude', CLEAN]], 'asked once, with the sign-in’s own environment');
  assert.deepEqual(confirmed, [done]);
  assert.deepEqual(phases(), ['ready', 'running', 'checking', 'done']);
  assert.deepEqual(states.at(-1).who, { label: 'Max', email: 'me@example.com' });
  assert.equal(signIn.state, null, 'and it is over: another may be opened');
});

test('what is typed and what is printed pass straight through: never logged, kept or reported', { skip: missing }, async () => {
  const { signIn, term, states, out, logs, confirmed } = make();
  const r = signIn.begin({ accountId: 'claude-default' });
  signIn.attach(r.id, 80, 24);
  const typed = 'PASTED-CODE-9f8e7d6c5b4a#state-1234';
  const printed = 'Paste code here if prompted > https://claude.com/cai/oauth/authorize?code=PRINTED-URL-55aa';
  term.last.says(printed);
  signIn.write(r.id, typed);
  signIn.write(r.id, '\r');
  assert.deepEqual(out, [[r.id, printed]], 'the window’s terminal gets exactly what Claude Code printed');
  assert.deepEqual(term.last.wrote, [typed, '\r'], 'and Claude Code gets exactly what was typed');

  term.last.ends(0);
  const done = await r.done;
  // Everything the runner says about the sign-in, to anyone, and everything it still holds.
  const said = JSON.stringify([states, logs, confirmed, done]);
  const held = JSON.stringify(signIn, (key, value) => (typeof value === 'function' ? undefined : value));
  for (const secret of [typed, 'PASTED-CODE', 'PRINTED-URL', 'oauth/authorize']) {
    assert.ok(!said.includes(secret), `"${secret}" was logged or reported`);
    assert.ok(!held.includes(secret), `"${secret}" was kept`);
  }
  assert.ok(!logs.join('\n').includes('me@example.com'), 'the log never names who signed in');
  assert.ok(logs.some((l) => l.includes('exited (0)')), 'the exit is what is watched for');

  // Nothing that is not typing gets in, and nothing after it is over.
  const { signIn: b, term: t2 } = make();
  const again = b.begin({});
  b.write(again.id, 'too early');
  b.attach(again.id, 80, 24);
  for (const junk of [7, null, '', { toString: () => 'x' }, 'x'.repeat(64 * 1024 + 1)]) b.write(again.id, junk);
  b.write('another-id', 'not mine');
  assert.deepEqual(t2.last.wrote, []);
  b.resize(again.id, 120, 40); b.resize(again.id, 0, 40); b.resize(again.id, 120, 5000); b.resize(again.id, '120', 40);
  assert.deepEqual(t2.last.sizes, [[120, 40]]);
  b.cancel(again.id);
  b.write(again.id, 'after it closed');
  assert.deepEqual(t2.last.wrote, []);
});

test('a sign-in that did not finish can be tried again; closing it says why it did not count', { skip: missing }, async () => {
  const { signIn, term, phases, confirmed, asked } = make();
  const r = signIn.begin({ accountId: 'claude-default' });
  signIn.attach(r.id, 80, 24);
  term.last.ends(1);
  assert.deepEqual([signIn.state.phase, signIn.state.code, signIn.state.message], ['failed', 'failed', 'Sign-in didn’t finish.']);
  assert.equal(asked.length, 0, 'a sign-in that failed is not asked about');

  signIn.attach(r.id, 80, 24);
  assert.equal(term.made.length, 2);
  term.made[0].ends(0); // the first one, late: no longer this sign-in's
  assert.equal(signIn.state.phase, 'running');
  term.last.ends(130);
  assert.deepEqual(signIn.cancel(r.id), { ok: true });
  assert.deepEqual(await r.done, { ok: false, code: 'failed', message: 'Sign-in didn’t finish.' });
  assert.deepEqual(phases(), ['ready', 'running', 'failed', 'running', 'failed', 'closed']);
  assert.deepEqual(confirmed, []);
  assert.deepEqual(signIn.cancel(r.id), { ok: false }, 'closed once');
});

test('exit 0 is not enough: signed out, the wrong folder or a login from the settings does not count', { skip: missing }, async () => {
  const folder = dir();
  const cases = [
    [{ loggedIn: false }, 'signed-out', 'Claude Code says it is still signed out.'],
    [{ ...PLAN, configDir: '/Users/someone/.claude' }, 'mismatch', 'Claude Code answered for a different folder.'],
    [{ loggedIn: true, method: 'api_key_helper', provider: 'firstParty', configDir: folder }, 'blocked', 'Your Claude Code settings choose the login, so this sign-in isn’t used.'],
    [{ loggedIn: null }, 'unverified', 'Canopy couldn’t check the sign-in. Try again in a moment.'],
  ];
  for (const [auth, code, message] of cases) {
    const { signIn, term, confirmed } = make({ auth });
    const r = signIn.begin({ dir: folder });
    signIn.attach(r.id, 80, 24);
    assert.equal(term.last.opts.env.CLAUDE_CONFIG_DIR, folder);
    term.last.ends(0);
    await until(() => signIn.state?.phase === 'failed', code);
    assert.deepEqual([signIn.state.code, signIn.state.message], [code, message]);
    assert.deepEqual(confirmed, [], 'nothing is updated for a sign-in that did not count');
    signIn.cancel(r.id);
    assert.deepEqual(await r.done, { ok: false, code, message });
  }

  // "Could not check" can be asked again without signing in again.
  let answers = [{ loggedIn: null }, { ...PLAN, configDir: folder }];
  const { signIn, term, confirmed } = make({ auth: () => answers.shift() });
  const r = signIn.begin({ dir: folder, console: false });
  signIn.attach(r.id, 80, 24);
  term.last.ends(0);
  await until(() => signIn.state?.phase === 'failed');
  await signIn.check(r.id);
  assert.deepEqual(await r.done, { ok: true, accountId: null, dir: folder, who: { kind: 'plan', email: 'me@example.com', org: 'Acme', orgId: 'o1', plan: 'max' } });
  assert.equal(term.made.length, 1);
  assert.equal(confirmed.length, 1);
});

test('cancel stops Claude Code’s sign-in, harder if it does not go; so do a reload and quitting', { skip: missing }, async () => {
  const { signIn, term, phases, asked } = make({ killMs: 15 });
  const r = signIn.begin({});
  signIn.attach(r.id, 80, 24);
  const p = term.last;
  signIn.cancel(r.id);
  assert.deepEqual(p.kills, ['SIGHUP']);
  assert.deepEqual(await r.done, { ok: false, code: 'cancelled', message: 'The sign-in was cancelled.' });
  await tick(40);
  assert.deepEqual(p.kills, ['SIGHUP', 'SIGKILL'], 'it did not exit: it is not left behind');
  p.ends(0);
  await tick(5);
  assert.equal(asked.length, 0, 'a sign-in that was cancelled is never counted, whatever it exits with');
  assert.deepEqual(phases(), ['ready', 'running', 'closed']);

  const b = make({ killMs: 15 });
  const r2 = b.signIn.begin({});
  b.signIn.attach(r2.id, 80, 24);
  b.signIn.stop();
  b.term.last.ends(129);
  await tick(40);
  assert.deepEqual(b.term.last.kills, ['SIGHUP'], 'it went when asked: nothing more is sent');
  assert.deepEqual(await r2.done, { ok: false, code: 'cancelled', message: 'The sign-in was cancelled.' });
  b.signIn.stop(); // nothing open: nothing to do
});

test('one sign-in at a time, and none without a terminal to show it', { skip: missing }, async () => {
  const { signIn, term } = make({ attachMs: 15 });
  const r = signIn.begin({ accountId: 'claude-default' });
  assert.deepEqual(signIn.begin({}), { ok: false, code: 'busy', message: 'A sign-in is already open.' });
  assert.deepEqual(await r.done, { ok: false, code: 'no-window', message: 'The sign-in couldn’t be shown.' });
  assert.equal(term.made.length, 0, 'nobody attached: Claude Code’s sign-in was never started');
  assert.deepEqual(signIn.attach(r.id, 80, 24), { ok: false, message: 'That sign-in is closed.' });
  assert.equal(signIn.begin({}).ok, true, 'and the next one can open');
});

test('only a login Claude Code keeps itself can be signed in to', { skip: missing }, () => {
  const accounts = [
    DEFAULT,
    { id: 'pasted', engine: 'claude', kind: 'key', dir: null, state: 'invalid-key' },
    { id: 'claude-env', engine: 'claude', kind: 'external', dir: null, via: 'ANTHROPIC_API_KEY', state: 'ok' },
    { id: 'codex-default', engine: 'codex', kind: 'plan', dir: null, state: 'signed-out' },
    { id: 'gone', engine: 'claude', kind: 'plan', dir: path.join(root, 'no-such-folder'), state: 'missing' },
  ];
  const refused = (opts, code, env) => {
    const { signIn, term, states } = make({ accounts, ...(env !== undefined && { env }) });
    const r = signIn.begin(opts);
    assert.deepEqual([r.ok, r.code], [false, code], JSON.stringify(opts));
    assert.equal(typeof r.message, 'string');
    assert.deepEqual([term.made.length, states.length, signIn.state], [0, 0, null], 'nothing opened');
  };
  refused({ accountId: 'pasted' }, 'not-a-sign-in');
  refused({ accountId: 'claude-env' }, 'not-a-sign-in');
  refused({ accountId: 'codex-default' }, 'account-missing');
  refused({ accountId: 'nobody' }, 'account-missing');
  refused({ accountId: 7 }, 'account-missing');
  refused({ accountId: 'gone' }, 'account-missing');
  refused({ dir: 'relative/folder' }, 'account-missing');
  refused({ dir: path.join(root, 'no-such-folder') }, 'account-missing');
  refused({}, 'no-env', null);

  const none = new S.SignIn({ tool: () => ({ path: '/opt/fake/claude', env: SHELL }) });
  assert.equal(none.begin({}).code, 'unavailable', 'no terminal to run it in');
  const lost = new S.SignIn({ spawn: fakeTerminal().spawn, tool: () => ({ path: null, env: SHELL }) });
  assert.equal(lost.begin({}).code, 'not-installed');
  const broken = make({ term: fakeTerminal({ fail: true }) });
  const r = broken.signIn.begin({});
  assert.deepEqual(broken.signIn.attach(r.id, 80, 24), { ok: false, message: 'Claude Code’s sign-in couldn’t start.' });
  assert.equal(broken.signIn.state.phase, 'failed');
});

test('a known account signs in the way it was; a new one may choose a plan or the Console', { skip: missing }, () => {
  const console_ = { id: 'claude-default', engine: 'claude', kind: 'console', dir: null, email: 'me@example.com', state: 'signed-out' };
  const a = make({ accounts: [console_] });
  const r = a.signIn.begin({ accountId: 'claude-default', console: false, email: 'other@example.com' });
  assert.deepEqual([a.signIn.state.console, a.signIn.state.canSwitch, a.signIn.state.label], [true, false, 'Console']);
  a.signIn.attach(r.id, 80, 24, { console: false });
  assert.deepEqual(a.term.last.args, ['auth', 'login', '--console', '--email', 'me@example.com'], 'what the window asks for does not change a known account');

  const b = make();
  const fresh = b.signIn.begin({ email: 'new@example.com' });
  assert.deepEqual([b.signIn.state.console, b.signIn.state.canSwitch, b.signIn.state.account, b.signIn.state.label], [false, true, null, null]);
  b.signIn.attach(fresh.id, 80, 24);
  assert.deepEqual(b.term.last.args, ['auth', 'login', '--email', 'new@example.com']);
  b.signIn.attach(fresh.id, 80, 24, { console: true });
  assert.equal(b.term.made.length, 2, 'switching starts Claude Code’s sign-in again');
  assert.deepEqual(b.term.made[0].kills, ['SIGHUP']);
  assert.deepEqual(b.term.last.args, ['auth', 'login', '--console', '--email', 'new@example.com']);
  assert.equal(b.signIn.state.console, true);
  b.signIn.attach(fresh.id, 80, 24, { console: true });
  assert.equal(b.term.made.length, 2, 'already that way');

  // Whoever opens it with the choice made (adding a Console sign-in) has made it.
  const c = make();
  c.signIn.begin({ dir: dir(), console: true, sso: true, label: 'Work' });
  assert.deepEqual([c.signIn.state.console, c.signIn.state.canSwitch, c.signIn.state.label], [true, false, 'Work']);
  c.signIn.attach(c.signIn.state.id, 80, 24, { console: false });
  assert.deepEqual(c.term.last.args, ['auth', 'login', '--console', '--sso']);
});

test('Open in Terminal instead: the sign-in here stops, and Claude Code is asked each time you come back', { skip: missing }, async () => {
  const folder = dir();
  let answers = [{ loggedIn: false }, { ...PLAN, configDir: folder }];
  const { signIn, term, scripts, phases, states, confirmed } = make({ auth: () => answers.shift() });
  const r = signIn.begin({ dir: folder, console: false });
  signIn.attach(r.id, 80, 24);
  assert.deepEqual(await signIn.toTerminal(r.id), { ok: true });
  assert.deepEqual(term.last.kills, ['SIGHUP'], 'two sign-ins never run side by side');
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes(`export CLAUDE_CONFIG_DIR='${folder}'`) && scripts[0].includes("exec '/opt/fake/claude' 'auth' 'login'"));
  for (const v of Object.values(TOKENS)) assert.ok(!scripts[0].includes(v));
  assert.equal(signIn.state.phase, 'terminal');
  term.last.ends(0); // the one that was stopped here: not this sign-in's any more
  assert.equal(signIn.state.phase, 'terminal');

  signIn.focused();
  await until(() => states.at(-1).message === 'Not signed in yet.', 'still waiting');
  assert.equal(signIn.state.phase, 'terminal', 'not signed in yet is not a failure');
  signIn.focused();
  assert.deepEqual(await r.done, { ok: true, accountId: null, dir: folder, who: { kind: 'plan', email: 'me@example.com', org: 'Acme', orgId: 'o1', plan: 'max' } });
  assert.equal(confirmed.length, 1);
  assert.deepEqual(phases(), ['ready', 'running', 'terminal', 'checking', 'terminal', 'checking', 'done']);
  signIn.focused(); // nothing open: nothing asked

  // Terminal would not open: the sign-in here carries on.
  const b = make({ terminal: { ok: false, message: 'No app opens .command files.' } });
  const r2 = b.signIn.begin({});
  b.signIn.attach(r2.id, 80, 24);
  assert.deepEqual(await b.signIn.toTerminal(r2.id), { ok: false, message: 'No app opens .command files.' });
  assert.deepEqual([b.signIn.state.phase, b.term.last.kills.length], ['running', 0]);
  assert.deepEqual(await b.signIn.check(r2.id), { ok: false }, 'nothing to check while it runs here');
  assert.deepEqual(await b.signIn.toTerminal('another-id'), { ok: false, message: 'Terminal couldn’t be opened.' });
});

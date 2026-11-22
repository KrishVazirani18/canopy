// accounts-claude.mjs: the launch recipes, reading `claude auth status`, and finding the logins Claude Code has.
// No test here runs the real claude or touches a real login: where a binary is needed it is a shell script in a
// throwaway folder that answers the way Claude Code 2.1.325 does, and the "account folders" are empty temp folders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CORE, core } from '../helpers.mjs';

const C = await core('accounts-claude.mjs');
const A = await core('accounts.mjs');
const missing = C.__missing ? `accounts-claude.mjs: ${C.__missing}` : A.__missing ? `accounts.mjs: ${A.__missing}` : false;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-accounts-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;
const dir = (name = `d${++seq}`) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
function script(file, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, mode);
  return file;
}

const BASE = Object.freeze({
  PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8', MY_VAR: 'kept', CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work',
  AWS_REGION: 'us-east-1',
});
const LOGIN = Object.freeze({
  ANTHROPIC_API_KEY: 'sk-shell', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_CUSTOM_HEADERS: 'X-A: 1',
  CLAUDE_CODE_OAUTH_TOKEN: 'oat', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ort', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
  CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_USE_GATEWAY: '1',
});
const acct = (over = {}) => ({ id: 'a', engine: 'claude', kind: 'plan', dir: null, label: null, email: 'me@example.com', org: 'Acme', orgId: 'o1', plan: 'max', via: null, keyHint: null, state: 'ok', why: null, ...over });
const refused = (fn, code) => assert.throws(fn, (err) => err.code === code && err.canopy?.code === code);

// ---- recipes ----

test('the recipe table: what each kind of account is launched with', { skip: missing }, () => {
  const base = { ...BASE, ...LOGIN };
  const clean = { ...BASE };
  const folder = dir();

  // Nothing chosen, and an external account: the base as it is, login variables and all.
  assert.deepEqual(C.launchEnv(null, base), base);
  assert.equal(JSON.stringify(C.launchEnv(null, base)), JSON.stringify(base), 'same keys in the same order');
  assert.notEqual(C.launchEnv(null, base), base, 'always a copy');
  assert.deepEqual(C.launchEnv(acct({ kind: 'external', via: 'ANTHROPIC_API_KEY' }), base), base);
  assert.deepEqual(C.launchEnv(acct({ kind: 'external', via: 'bedrock' }), base), base);

  // The sign-in in Claude Code's own folder: the base without anything that chooses a login.
  assert.deepEqual(C.launchEnv(acct(), base), clean);
  assert.deepEqual(C.launchEnv(acct({ kind: 'console' }), base), clean);

  // A sign-in in a folder of its own: that folder, and the user's own plugins.
  assert.deepEqual(C.launchEnv(acct({ dir: folder }), base), { ...clean, CLAUDE_CONFIG_DIR: folder, CLAUDE_CODE_PLUGIN_CACHE_DIR: '/Users/someone/.claude-work/plugins' });
  const { CLAUDE_CONFIG_DIR: _own, ...noHome } = clean;
  assert.equal(C.launchEnv(acct({ dir: folder }), noHome).CLAUDE_CODE_PLUGIN_CACHE_DIR, path.join(os.homedir(), '.claude', 'plugins'));
  assert.equal(C.launchEnv(acct({ dir: folder }), { ...base, CLAUDE_CODE_PLUGIN_CACHE_DIR: '/my/plugins' }).CLAUDE_CODE_PLUGIN_CACHE_DIR, '/my/plugins', "the user's own setting stays");

  // A pasted key: the base without the login variables, plus that key and nothing else.
  assert.deepEqual(C.launchEnv(acct({ kind: 'key' }), base, { key: 'sk-pasted' }), { ...clean, ANTHROPIC_API_KEY: 'sk-pasted' });
  assert.deepEqual(base, { ...BASE, ...LOGIN }, 'the base is never changed');
});

test('a recipe that cannot be met throws; it never hands back another login', { skip: missing }, () => {
  const base = { ...BASE, ...LOGIN };
  refused(() => C.launchEnv(acct({ kind: 'key' }), base), 'account-locked');            // no key to be had
  refused(() => C.launchEnv(acct({ kind: 'key' }), base, { key: '' }), 'account-locked');
  refused(() => C.launchEnv(acct({ dir: path.join(root, 'not-there') }), base), 'account-missing');
  for (const junk of [null, undefined, 'env', 7, []]) {
    refused(() => C.launchEnv(null, junk), 'no-env');
    refused(() => C.launchEnv(acct(), junk), 'no-env');
  }
});

test('every login variable is left out together, and nothing else is', { skip: missing }, () => {
  for (const k of Object.keys(LOGIN)) assert.ok(C.LOGIN_VARS.includes(k), `${k} chooses a login`);
  // The proxy goes as one: a plan login must never be sent to a base URL left behind.
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) assert.ok(C.LOGIN_VARS.includes(k));
  const all = Object.fromEntries(C.LOGIN_VARS.map((k) => [k, 'x']));
  assert.deepEqual(C.withoutLogin({ ...BASE, ...all }), BASE);
  assert.deepEqual(C.withoutLogin(null), {});
  for (const k of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'AWS_REGION', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) assert.ok(!C.LOGIN_VARS.includes(k), k);
});

test('no recipe ever says what client this is: that is Session’s line, and it is always canopy', { skip: missing }, () => {
  const folder = dir();
  const base = { ...BASE, ...LOGIN };
  const launches = [
    C.launchEnv(null, base), C.launchEnv(acct(), base), C.launchEnv(acct({ kind: 'console' }), base), C.launchEnv(acct({ dir: folder }), base),
    C.launchEnv(acct({ kind: 'key' }), base, { key: 'sk-pasted' }), C.launchEnv(acct({ kind: 'external', via: 'vertex' }), base),
  ];
  for (const env of launches) {
    assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in env), 'never claims to be the terminal or another client');
    assert.ok(!('CLAUDE_AGENT_SDK_CLIENT_APP' in env) && !('CLAUDECODE' in env));
    const added = Object.keys(env).filter((k) => !(k in base));
    assert.ok(added.every((k) => ['CLAUDE_CODE_PLUGIN_CACHE_DIR'].includes(k)), `a recipe added ${added.join(', ')}`);
  }
});

// ---- reading `claude auth status` ----

test('describeAuth: each way of being signed in, and the two ways of not knowing', { skip: missing }, () => {
  const d = C.describeAuth;
  assert.deepEqual(d({ loggedIn: null, error: 'timed out' }), { state: 'unknown' });
  for (const junk of [null, undefined, 'x', {}, { loggedIn: 'yes' }]) assert.deepEqual(d(junk), { state: 'unknown' }, 'no answer is never "signed out"');
  assert.deepEqual(d({ loggedIn: false, method: 'none' }), { state: 'signed-out' });
  const who = { email: 'me@example.com', org: 'Acme', orgId: 'o1', configDir: '/Users/someone/.claude' };
  assert.deepEqual(d({ loggedIn: true, method: 'claude.ai', provider: 'firstParty', subscriptionType: 'max', ...who }), { state: 'ok', kind: 'plan', via: null, plan: 'max', ...who });
  assert.deepEqual(d({ loggedIn: true, method: 'api_key', provider: 'firstParty', apiKeySource: '/login managed key', ...who }), { state: 'ok', kind: 'console', via: null, plan: null, ...who });
  const none = { email: null, org: null, orgId: null, configDir: null };
  assert.deepEqual(d({ loggedIn: true, method: 'api_key', provider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }), { state: 'ok', kind: 'external', via: 'ANTHROPIC_API_KEY', plan: null, ...none });
  assert.equal(d({ loggedIn: true, method: 'api_key' }).via, 'ANTHROPIC_API_KEY');
  assert.equal(d({ loggedIn: true, method: 'api_key_helper', provider: 'firstParty' }).via, 'apiKeyHelper');
  assert.equal(d({ loggedIn: true, method: 'oauth_token', provider: 'firstParty' }).via, 'token');
  assert.deepEqual([d({ loggedIn: true, method: 'third_party', provider: 'bedrock' }).kind, d({ loggedIn: true, method: 'third_party', provider: 'bedrock' }).via], ['external', 'bedrock']);
  assert.equal(d({ loggedIn: true, method: 'something_new' }).kind, 'external', 'a method Canopy does not know is left to the environment');
});

test('labels and the reported-account check', { skip: missing }, () => {
  assert.deepEqual(['max', 'pro', 'team', 'ultra', null].map((plan) => C.labelFor(acct({ plan }))), ['Max', 'Pro', 'Team', 'Ultra', 'Claude plan']);
  assert.equal(C.labelFor(acct({ kind: 'console' })), 'Console');
  assert.deepEqual([C.labelFor(acct({ kind: 'key', keyHint: '4f2a' })), C.labelFor(acct({ kind: 'key' }))], ['API key ••••4f2a', 'API key']);
  assert.deepEqual(['ANTHROPIC_API_KEY', 'apiKeyHelper', 'token', 'bedrock', 'vertex', 'mantle'].map((via) => C.labelFor(acct({ kind: 'external', via }))),
    ['API key', 'API key helper', 'Access token', 'Amazon Bedrock', 'Google Vertex AI', 'Cloud provider']);

  const g = C.agrees;
  // A sign-in: the same email agrees; a key or a cloud provider in its place means something outranked it.
  assert.equal(g(acct(), { email: 'ME@example.com', provider: 'firstParty', apiKeySource: 'none', tokenSource: 'claude.ai' }), true);
  assert.equal(g(acct(), { email: 'other@example.com', provider: 'firstParty' }), false);
  assert.equal(g(acct(), { email: 'me@example.com', apiKeySource: 'ANTHROPIC_API_KEY' }), false);
  assert.equal(g(acct(), { email: 'me@example.com', apiKeySource: 'apiKeyHelper' }), false);
  assert.equal(g(acct(), { provider: 'bedrock' }), false);
  assert.equal(g(acct(), { provider: 'firstParty' }), null, 'no email to go by: cannot tell, so nothing is flagged');
  assert.equal(g(acct({ email: null }), { email: 'me@example.com' }), null);
  // The plan's name is worded differently by the process ("Claude Max") and by auth status ("max"): never compared.
  assert.equal(g(acct({ plan: 'max' }), { email: 'me@example.com', plan: 'Claude Max' }), true);
  // External and pasted-key accounts go by what supplied the login.
  assert.equal(g(acct({ kind: 'external', via: 'ANTHROPIC_API_KEY' }), { apiKeySource: 'ANTHROPIC_API_KEY' }), true);
  assert.equal(g(acct({ kind: 'external', via: 'ANTHROPIC_API_KEY' }), { apiKeySource: '/login managed key' }), false);
  assert.equal(g(acct({ kind: 'external', via: 'bedrock' }), { provider: 'bedrock' }), true);
  assert.equal(g(acct({ kind: 'external', via: 'bedrock' }), { provider: 'firstParty' }), false);
  assert.equal(g(acct({ kind: 'external', via: 'bedrock' }), {}), null);
  assert.equal(g(acct({ kind: 'key' }), { apiKeySource: 'ANTHROPIC_API_KEY', provider: 'firstParty' }), true);
  assert.equal(g(acct({ kind: 'key' }), { apiKeySource: '/login managed key' }), false);
  for (const junk of [null, undefined, 'x']) assert.equal(g(acct(), junk), null);
});

// ---- finding the logins, with a stand-in claude ----

// Answers like `claude auth status --json`, and writes one line per run so a test can count the runs.
// With a key in the environment it reports the key; without, the sign-in it "holds" (`stored`).
function fakeClaude(stored, { runs = path.join(dir(), 'runs') } = {}) {
  const key = `{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY","configDirectory":"/Users/someone/.claude"}`;
  const bin = script(path.join(dir(), 'claude'), [
    `echo run >> '${runs}'`,
    `if [ -n "$ANTHROPIC_API_KEY" ]; then echo '${key}'; exit 0; fi`,
    stored,
  ].join('\n'));
  return { bin, count: () => { try { return fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } } };
}
const MAX = `echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"me@example.com","orgId":"o1","orgName":"Acme","subscriptionType":"max","configDirectory":"/Users/someone/.claude","loginExpiresAt":null}'`;
const CONSOLE = `echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"/login managed key","email":"me@example.com","orgId":"o1","orgName":"Acme","configDirectory":"/Users/someone/.claude"}'`;
const SIGNED_OUT = `echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1`;
const ENV = { PATH: '/usr/bin:/bin', HOME: os.homedir() };
const engineFor = (bin, env) => C.claudeAccounts({ tool: () => ({ path: bin, env }) });
const brief = (r) => (r.accounts ?? []).map((a) => [a.id, a.state, a.kind ?? null, a.via ?? null, a.email ?? null]);

test('a Console sign-in, a plan, and signed out: one question, one answer', { skip: missing, timeout: 60000 }, async () => {
  const consoleLogin = fakeClaude(CONSOLE);
  let r = await engineFor(consoleLogin.bin, ENV).detect();
  assert.deepEqual([r.known, brief(r)], [true, [['claude-default', 'ok', 'console', null, 'me@example.com']]]);
  assert.deepEqual([r.accounts[0].org, r.accounts[0].orgId, r.accounts[0].plan], ['Acme', 'o1', null]);
  assert.equal(consoleLogin.count(), 1);

  const plan = fakeClaude(MAX);
  r = await engineFor(plan.bin, ENV).detect();
  assert.deepEqual(brief(r), [['claude-default', 'ok', 'plan', null, 'me@example.com']]);
  assert.equal(r.accounts[0].plan, 'max');

  // Signed out answers with exit code 1 and the JSON all the same.
  r = await engineFor(fakeClaude(SIGNED_OUT).bin, ENV).detect();
  assert.deepEqual([r.known, brief(r)], [true, [['claude-default', 'signed-out', null, null, null]]]);
});

test('an answer the caller already has is used instead of asking again', { skip: missing, timeout: 60000 }, async () => {
  const plan = fakeClaude(MAX);
  const r = await engineFor(plan.bin, ENV).detect({ auth: { loggedIn: true, method: 'api_key', apiKeySource: '/login managed key', email: 'given@example.com' } });
  assert.deepEqual(brief(r), [['claude-default', 'ok', 'console', null, 'given@example.com']]);
  assert.equal(plan.count(), 0);
});

test('a key in the shell outranks the sign-in: both are listed, and the sign-in is found without the key', { skip: missing, timeout: 60000 }, async () => {
  const shell = { ...ENV, ANTHROPIC_API_KEY: 'sk-shell' };
  const both = fakeClaude(MAX);
  let r = await engineFor(both.bin, shell).detect();
  assert.deepEqual(brief(r), [['claude-env', 'ok', 'external', 'ANTHROPIC_API_KEY', null], ['claude-default', 'ok', 'plan', null, 'me@example.com']]);
  assert.equal(both.count(), 2, 'asked as it stands, then once more without the login variables');

  r = await engineFor(fakeClaude(SIGNED_OUT).bin, shell).detect();
  assert.deepEqual(brief(r), [['claude-env', 'ok', 'external', 'ANTHROPIC_API_KEY', null], ['claude-default', 'signed-out', null, null, null]]);

  // A key helper in the settings answers with or without the shell's variables: what is underneath cannot be seen.
  const helper = fakeClaude(`echo '{"loggedIn":true,"authMethod":"api_key_helper","apiProvider":"firstParty"}'`);
  r = await engineFor(helper.bin, ENV).detect();
  assert.deepEqual(brief(r), [['claude-env', 'ok', 'external', 'apiKeyHelper', null], ['claude-default', 'unknown', null, null, null]]);
  assert.equal(helper.count(), 1, 'nothing to leave out, so nothing to ask twice');

  // In the registry: the key is what new chats use, the sign-in is listed beside it.
  const reg = new A.Accounts({ engines: { claude: engineFor(both.bin, shell) } });
  const view = await reg.refresh();
  assert.deepEqual(view.list.map((a) => [a.id, a.label, a.state]), [['claude-default', 'Max', 'ok'], ['claude-env', 'API key', 'ok']]);
  assert.equal(view.inUse.claude, 'claude-env');
  assert.deepEqual(reg.envFor('claude'), shell, 'and nothing chosen still launches exactly as before');
});

test('a claude that does not answer is "not known", never "signed out"', { skip: missing, timeout: 60000 }, async () => {
  const crash = script(path.join(dir(), 'claude'), `echo 'Segmentation fault' >&2; exit 139`);
  assert.deepEqual(await engineFor(crash, ENV).detect(), { known: false });
  assert.deepEqual(await engineFor(null, ENV).detect(), { known: false }, 'not installed');
  assert.deepEqual(await engineFor(crash, null).detect(), { known: false }, 'the environment is not known yet');
  assert.deepEqual(await C.claudeAccounts({ tool: () => { throw new Error('x'); } }).detect(), { known: false });
  // A sign-in the registry knew stays as it was.
  const reg = new A.Accounts({ engines: { claude: engineFor(crash, ENV) }, load: () => ({ active: {}, list: [acct({ id: 'claude-default' })] }) });
  assert.deepEqual((await reg.refresh()).list.map((a) => a.state), ['ok']);
});

test('a sign-in in a folder of its own must be a sign-in, and for that folder', { skip: missing, timeout: 60000 }, async () => {
  const accounts = dir('accounts');
  const at = (name) => dir(path.join('accounts', name));
  const out = (extra) => `echo '{"loggedIn":true,"apiProvider":"firstParty",${extra},"configDirectory":"'"$CLAUDE_CONFIG_DIR"'"}'`;
  // Branches on the folder it is pointed at, as the real one answers per folder.
  const bin = script(path.join(dir(), 'claude'), [
    `if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}'; exit 0; fi`,
    `case "$CLAUDE_CONFIG_DIR" in`,
    `  */good) ${out('"authMethod":"claude.ai","email":"work@example.com","orgId":"o2","orgName":"Work","subscriptionType":"max"')};;`,
    `  */elsewhere) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"work@example.com","configDirectory":"/Users/someone/.claude"}';;`,
    `  */nofolder) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"work@example.com"}';;`,
    `  */helper) ${out('"authMethod":"api_key_helper"')};;`,
    `  */swapped) ${out('"authMethod":"claude.ai","email":"someone-else@example.com"')};;`,
    `  */out) echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1;;`,
    `  */silent) exit 3;;`,
    `  *) ${MAX};;`,
    `esac`,
  ].join('\n'));
  // The shell exports a key: the folder's own sign-in must be asked about without it.
  const eng = engineFor(bin, { ...ENV, ANTHROPIC_API_KEY: 'sk-shell' });
  const check = (name, over = {}) => eng.verify(acct({ id: name, dir: at(name), email: 'work@example.com', ...over }));

  assert.deepEqual(await check('good'), { state: 'ok', kind: 'plan', via: null, email: 'work@example.com', org: 'Work', orgId: 'o2', plan: 'max' });
  assert.equal((await check('elsewhere')).state, 'mismatch', 'signed in, but the answer is about another folder');
  assert.equal((await check('nofolder')).state, 'mismatch', 'an answer that does not say which folder proves nothing');
  assert.deepEqual(await check('helper'), { state: 'blocked', why: 'your Claude Code settings choose the login' });
  assert.equal((await check('swapped')).state, 'mismatch', 'someone else is signed in there now');
  assert.deepEqual(await check('out'), { state: 'signed-out' });
  assert.deepEqual(await check('silent'), { state: 'unknown' });
  assert.deepEqual(await eng.verify(acct({ id: 'gone', dir: path.join(accounts, 'gone') })), { state: 'missing' });
  assert.deepEqual(await eng.verify(acct({ id: 'pasted', kind: 'key' })), { state: 'unknown' }, 'a key is not checked here');
  assert.deepEqual(fs.readdirSync(accounts).sort(), ['elsewhere', 'good', 'helper', 'nofolder', 'out', 'silent', 'swapped'], 'checking creates nothing');
  for (const name of fs.readdirSync(accounts)) assert.deepEqual(fs.readdirSync(path.join(accounts, name)), [], 'and writes nothing into a folder');
});

// ---- honest identity, locked in ----

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'test' && e.name !== 'node_modules') walk(p); }
      else if (/\.(mjs|cjs|js|ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  const src = path.resolve(CORE, '..');
  walk(src);
  const renderer = path.resolve(src, '..', 'renderer', 'src');
  if (fs.existsSync(renderer)) walk(renderer);
  return out.map((file) => ({ file: path.relative(path.resolve(src, '..'), file), text: fs.readFileSync(file, 'utf8') }));
}

test('nothing in the app reads a login where the tools keep it', { skip: missing }, () => {
  // Where Claude Code, Codex and the two desktop apps keep tokens, and the ways of opening a Keychain entry.
  // Identity comes from asking the tools (`claude auth status`, account/read); none of these may appear in shipped code.
  const STORES = [
    /\.credentials\.json/i, /\bauth\.json\b/i, /oauthAccount/, /Claude Code-credentials/i,
    /find-generic-password|find-internet-password|SecItemCopyMatching|\bkeytar\b/i,
    /Application Support\/Claude(?!Code)/, /Application Support\/(com\.openai|ChatGPT|Codex)/i,
    /claudeAiOauth/,
  ];
  const files = sources();
  assert.ok(files.length > 40 && files.some((f) => f.file === path.join('src', 'core', 'accounts-claude.mjs')), 'the scan sees the app');
  // One exception, and only for a name: the Codex account folder keeps a list of the names it must never link (the
  // login file first among them). That list, and the comment above it, are taken out before the file is scanned like
  // any other, so a read of the file anywhere else in it still fails here.
  const scrub = (file, text) => (file === path.join('src', 'codex-account-home.mjs')
    ? text.replace(/\/\/ What else is found in a Codex folder[\s\S]*?\nconst LEFT = \[[\s\S]*?\n\];/, '')
    : text);
  const home = files.find((f) => f.file === path.join('src', 'codex-account-home.mjs'));
  if (home) assert.notEqual(scrub(home.file, home.text), home.text, 'the never-linked list is where the scan expects it');
  for (const { file, text } of files) for (const re of STORES) assert.ok(!re.test(scrub(file, text)), `${file} mentions ${re}`);
});

test('nothing in the app sets CLAUDE_CODE_ENTRYPOINT: Canopy never passes for another client', { skip: missing }, () => {
  // The one place the name may appear is the list of variables stripped from what a chat inherits (env.mjs).
  const named = sources().filter((f) => f.text.includes('CLAUDE_CODE_ENTRYPOINT')).map((f) => f.file);
  assert.deepEqual(named, [path.join('src', 'core', 'env.mjs')]);
  // And the account files run no process and read no file of their own: they can only ask through env.mjs.
  for (const name of ['accounts.mjs', 'accounts-claude.mjs', 'accounts-codex.mjs']) {
    const text = fs.readFileSync(path.join(CORE, name), 'utf8');
    assert.ok(!/child_process|readFile|createReadStream|\bopen\(|\bfetch\(/.test(text), `${name} reads or runs something itself`);
  }
});

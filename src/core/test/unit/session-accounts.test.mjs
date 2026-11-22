// Session launched through the accounts registry, as main.mjs wires it: with no account chosen the environment
// must be exactly what it was before accounts, a chat is always canopy to Claude Code, and a chat whose account
// cannot be used refuses to start rather than run on another login. Driven by the scripted fake of the SDK's
// query() (fake-query.mjs): no claude process is started and no login is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { CORE, core, watch, within } from '../helpers.mjs';

const S = await core('session.mjs');
const A = await core('accounts.mjs');
const C = await core('accounts-claude.mjs');
const missing = S.__missing ? `session.mjs: ${S.__missing}` : false;
// Tests that launch through the registry also need the account files.
const noAccounts = missing || (A.__missing ? `accounts.mjs: ${A.__missing}` : C.__missing ? `accounts-claude.mjs: ${C.__missing}` : false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-session-accounts-'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

// What the login shell might hand the app: a key, a cloud switch and a proxy included, so "unchanged" means all of it.
const SHELL = Object.freeze({
  PATH: '/usr/bin:/bin', HOME: '/Users/someone', LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work',
  ANTHROPIC_API_KEY: 'sk-shell-key', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://proxy.example', MY_VAR: 'kept',
});
// The app's real version, as main.mjs passes it (app.getVersion() reads the same package.json).
const VERSION = JSON.parse(fs.readFileSync(path.resolve(CORE, '..', '..', 'package.json'), 'utf8')).version;

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ }
  }
});
function make(opts = {}, script = {}) {
  const fake = createFake(script);
  const s = new S.Session({ cwd: work, claudePath: '/usr/bin/true', env: { ...SHELL }, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const registry = (env = SHELL, saved = null) => new A.Accounts({ engines: { claude: C.claudeAccounts({ tool: () => ({ path: '/usr/bin/true', env }) }) }, load: () => saved });
const launched = async (opts) => { const { s, fake, w } = make(opts); s.send('hi'); await idle(w); return fake.current.options.env; };

// ---- the launch environment ----

test('with no account chosen, Claude Code is launched with exactly the environment it got before accounts', { skip: noAccounts }, async () => {
  // Before: main handed every chat the shell environment as a fixed object.
  const before = await launched({ env: { ...SHELL }, appVersion: VERSION });
  // Now: a getter through the registry, for the account the chat was started on (none).
  const reg = registry();
  const account = reg.pin('claude');
  const now = await launched({ env: () => reg.envFor('claude', { account }), account, appVersion: VERSION });
  assert.equal(account, null);
  assert.equal(JSON.stringify(now), JSON.stringify(before), 'the same variables, the same values, in the same order');

  // And that environment, spelled out: the shell's, untouched, between the lines Session adds (the skill listing's
  // size last, when nothing this chat reads chose one).
  const streaming = 'CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING' in before ? '"CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING":"1",' : '';
  const skills = 'SLASH_COMMAND_TOOL_CHAR_BUDGET' in before ? ',"SLASH_COMMAND_TOOL_CHAR_BUDGET":"8000"' : '';
  assert.equal(JSON.stringify(now), '{' + streaming
    + '"PATH":"/usr/bin:/bin","HOME":"/Users/someone","LANG":"en_US.UTF-8","CLAUDE_CONFIG_DIR":"/Users/someone/.claude-work",'
    + '"ANTHROPIC_API_KEY":"sk-shell-key","CLAUDE_CODE_USE_BEDROCK":"1","ANTHROPIC_BASE_URL":"https://proxy.example","MY_VAR":"kept",'
    + '"CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS":"1","CLAUDE_CODE_STARTUP_FAILURE_RESULTS":"1",'
    + `"CLAUDE_AGENT_SDK_CLIENT_APP":"canopy/${VERSION}"${skills}}`);
  assert.equal(new S.Session({ cwd: work }).appVersion, '0.0.1', 'a session the app gave no version to says 0.0.1');
});

test('the other places Claude Code is launched get the same unchanged environment', { skip: noAccounts }, () => {
  const reg = registry();
  const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
  same(reg.envFor('claude'), SHELL);                                                                             // clearing a finished background session
  same({ ...reg.envFor('claude', { account: null }), TERM: 'xterm-256color', COLORTERM: 'truecolor' }, { ...SHELL, TERM: 'xterm-256color', COLORTERM: 'truecolor' }); // the terminal view
  const withSettings = { ...SHELL, DISABLE_AUTOUPDATER: '1', ANTHROPIC_API_KEY: 'sk-from-settings' };
  same(reg.envFor('claude', { base: withSettings }), withSettings);                                              // the model probe (shell + settings.json env)
});

test('a chat is always canopy to Claude Code, on any account, and never claims another client', { skip: noAccounts }, async () => {
  const folder = path.join(root, 'account-folder');
  fs.mkdirSync(folder, { recursive: true });
  const entry = (over) => ({ id: 'a', engine: 'claude', kind: 'plan', dir: null, email: 'me@example.com', state: 'ok', ...over });
  const cases = [null, entry({}), entry({ kind: 'console' }), entry({ dir: folder }), entry({ kind: 'external', via: 'bedrock' })];
  // An environment that tries to say otherwise: it does not get to.
  const loud = { ...SHELL, CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-cli/9.9.9', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1' };
  for (const account of cases) {
    const reg = registry(loud, account ? { active: { claude: 'a' }, list: [account] } : null);
    const env = await launched({ env: () => reg.envFor('claude'), account: reg.pin('claude'), appVersion: '3.2.1' });
    assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'canopy/3.2.1', `as ${account?.kind ?? 'nothing chosen'}`);
    assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in env) && !('CLAUDECODE' in env));
    // A chosen sign-in leaves the shell's key, cloud switch and proxy out; nothing chosen and external keep them.
    const kept = !account || account.kind === 'external';
    assert.deepEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL'].map((k) => k in env), [kept, kept, kept]);
    assert.equal(env.CLAUDE_CONFIG_DIR, account?.dir ?? SHELL.CLAUDE_CONFIG_DIR);
  }
});

// ---- failing closed ----

test('an account that cannot be used refuses with its own reason, and after a crash too', { skip: noAccounts }, async () => {
  const entry = { id: 'a', engine: 'claude', kind: 'plan', dir: null, email: 'me@example.com', plan: 'max', state: 'ok' };
  const reg = registry(SHELL, { active: { claude: 'a' }, list: [entry] });
  const account = reg.pin('claude');
  const { s, fake, w } = make({ env: () => reg.envFor('claude', { account }), account });
  s.send('one');
  await idle(w);
  assert.equal(fake.starts, 1);
  assert.ok(!('ANTHROPIC_API_KEY' in fake.current.options.env));

  // Its login goes away while the chat is open (another start reports someone else): the chat does not move on to
  // whatever Claude Code finds; its next start refuses.
  reg.reported('claude', 'a', { email: 'someone-else@example.com' });
  await s.stop();
  const mark = w.mark();
  const r = s.send('two');
  assert.deepEqual([r.ok, r.code, fake.starts], [false, 'account-mismatch', 1]);
  const err = w.find('error', mark);
  assert.equal(err.code, 'account-mismatch');
  assert.equal(err.message, 'Claude Code could not start: Max is using a different login.');
  assert.equal(err.recoverable, false);
  assert.deepEqual(err.prompts.map((p) => p.text), ['two']);
});

// ---- what Claude Code reports ----

test('the registry confirms an account from what a chat reports', { skip: noAccounts }, async () => {
  const entry = { id: 'claude-default', engine: 'claude', kind: 'plan', dir: null, email: 'tester@example.com', plan: 'max', state: 'signed-out' };
  const reg = registry(SHELL, { active: {}, list: [entry] });
  const account = reg.pin('claude');
  const { s, w } = make({ env: () => reg.envFor('claude', { account }), account, onAccount: (reported, id) => reg.reported('claude', id, reported) });
  s.send('hi');
  await idle(w);
  assert.equal(reg.view().list[0].state, 'ok', 'Claude Code started on it, so it is signed in');
});


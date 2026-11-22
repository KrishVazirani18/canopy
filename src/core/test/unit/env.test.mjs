// env.mjs: the environment a session runs in, finding claude, login state, file lists.
// No test here starts the real claude; where a binary is needed it is a shell script
// in a throwaway folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { core, isHostVar } from '../helpers.mjs';

const E = await core('env.mjs');
const missing = E.__missing ? `env.mjs: ${E.__missing}` : false;
const need = (...names) => missing || (names.find((n) => typeof E[n] !== 'function') ? `env.mjs does not export ${names.find((n) => typeof E[n] !== 'function')} yet` : false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-env-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
const dir = (name = `d${++seq}`) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
function script(file, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, mode);
  return file;
}

const AGENT_VARS = {
  CLAUDECODE: '1', CLAUDE_PID: '123', CLAUDE_EFFORT: 'high', CLAUDE_PLUGIN_DATA: '/x', CLAUDE_AGENT_SDK_VERSION: '0.3.0',
  CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_EXECPATH: '/x/claude', CLAUDE_CODE_SSE_PORT: '4000', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s', CLAUDE_CODE_MESSAGING_TOKEN: 't',
};
const HOST_VARS = {
  ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', NODE_OPTIONS: '--inspect', NODE_ENV: 'development', INIT_CWD: '/repo',
  npm_config_user_agent: 'npm', npm_lifecycle_event: 'start', CANOPY_DEV: '1', CANOPY_CAPTURE: '1', __CFBundleIdentifier: 'com.x', ORIGINAL_XDG_CURRENT_DESKTOP: 'x',
};
const USER_VARS = {
  PATH: '/usr/bin:/bin', HOME: '/Users/someone', LANG: 'en_US.UTF-8', ANTHROPIC_API_KEY: 'sk-user-key', CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work',
  CLAUDE_CODE_USE_BEDROCK: '1', CANOPY_CLAUDE_PATH: '/opt/claude', MY_TOOL_TOKEN: 'abc',
};

// ---- scrubEnv ----

test('scrubEnv removes what a parent agent session and the host app inject', { skip: need('scrubEnv') }, () => {
  const out = E.scrubEnv({ ...AGENT_VARS, ...HOST_VARS, ...USER_VARS });
  for (const k of [...Object.keys(AGENT_VARS), ...Object.keys(HOST_VARS)]) assert.ok(!(k in out), `${k} survived`);
  assert.deepEqual(out, USER_VARS);
});

test('scrubEnv returns a copy and tolerates junk', { skip: need('scrubEnv') }, () => {
  const input = { ...USER_VARS, CLAUDECODE: '1' };
  const out = E.scrubEnv(input);
  assert.notEqual(out, input);
  assert.equal(input.CLAUDECODE, '1', 'the input is not modified');
  for (const junk of [undefined, null, 'x', 7]) assert.deepEqual(E.scrubEnv(junk), {});
  assert.deepEqual(E.scrubEnv({ A: undefined, B: 'b' }), { B: 'b' });
});

test("the test helpers' own scrub agrees with core on agent variables", { skip: need('scrubEnv') }, () => {
  for (const k of Object.keys(AGENT_VARS)) assert.ok(isHostVar(k), k);
  for (const k of ['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) assert.ok(!isHostVar(k), k);
});

test('minimalEnv keeps only what a helper command needs', { skip: need('minimalEnv') }, () => {
  const out = E.minimalEnv({ ...USER_VARS, USER: 'someone', TMPDIR: '/tmp/x', LC_ALL: 'C', SECRET_TOKEN: 'nope' });
  assert.deepEqual(Object.keys(out).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'USER']);
  assert.ok(E.minimalEnv({}).PATH, 'a PATH is always present');
});

// ---- shell environment ----

test('marker parsing reads only what is between the marks', { skip: need('parseMarkedEnv') }, () => {
  const mark = '__mark_1234__';
  const noisy = `Welcome back!\nLast login: today\nFAKE=outside\0${mark}PATH=/a:/b\0MULTI=line one\nline two\0EMPTY=\0WITH_EQ=a=b=c\0bad-key=x\0=novalue\0justtext\0_under=1\0${mark}\nprompt> FAKE2=after\0`;
  const vars = E.parseMarkedEnv(noisy, mark);
  assert.deepEqual(vars, { PATH: '/a:/b', MULTI: 'line one\nline two', EMPTY: '', WITH_EQ: 'a=b=c', _under: '1' });
  assert.deepEqual(E.parseMarkedEnv(Buffer.from(noisy), mark), vars, 'a Buffer works too');
});

test('marker parsing reports missing marks instead of guessing', { skip: need('parseMarkedEnv') }, () => {
  assert.equal(E.parseMarkedEnv('PATH=/a\0HOME=/b\0', '__m__'), null);
  assert.equal(E.parseMarkedEnv('__m__PATH=/a\0', '__m__'), null, 'a shell killed before the closing mark');
  assert.deepEqual(E.parseMarkedEnv('__m____m__', '__m__'), {});
});

test('loadShellEnv never hands a session the host agent variables', { skip: need('loadShellEnv', 'scrubEnv'), timeout: 40000 }, async () => {
  const saved = {};
  for (const [k, v] of Object.entries({ ...AGENT_VARS, ELECTRON_RUN_AS_NODE: '1', CANOPY_DEV: '1' })) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const r = await E.loadShellEnv({ force: true });
    assert.equal(typeof r.shellOk, 'boolean');
    assert.ok(r.env && typeof r.env === 'object');
    for (const k of Object.keys(AGENT_VARS)) assert.ok(!(k in r.env), `${k} leaked into the session environment`);
    assert.ok(!('ELECTRON_RUN_AS_NODE' in r.env) && !('CANOPY_DEV' in r.env));
    assert.ok(r.env.PATH.split(':').includes('/usr/bin'));
    assert.ok(r.env.PATH.split(':').includes(path.join(os.homedir(), '.local/bin')), 'the fallback PATH entries are appended');
    assert.ok(r.env.HOME);
    for (const k of ['DISABLE_AUTO_UPDATE', 'ZSH_TMUX_AUTOSTART', 'ZSH_TMUX_AUTOSTARTED']) if (!(k in saved) && process.env[k] === undefined) assert.ok(!(k in r.env), `${k} is a probe helper, not the user's`);
    const again = await E.loadShellEnv();
    assert.deepEqual(again.env, r.env, 'the result is memoized');
    again.env.MUTATED = '1';
    assert.ok(!('MUTATED' in (await E.loadShellEnv()).env), 'callers cannot poison the memo');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await E.loadShellEnv({ force: true }).catch(() => {});
  }
});

// ---- finding claude ----

test('findClaude honours the override, then PATH, and skips unsafe candidates', { skip: need('findClaude') }, async () => {
  const good = script(path.join(dir(), 'claude'), 'echo ok');
  const viaPath = script(path.join(dir(), 'claude'), 'echo ok');
  const worldWritable = script(path.join(dir(), 'claude'), 'echo ok', 0o777);
  const notExecutable = script(path.join(dir(), 'claude'), 'echo ok', 0o644);
  const folder = path.join(dir(), 'claude');
  fs.mkdirSync(folder);
  const real = (p) => fs.realpathSync(p);
  const found = async (env) => { const p = await E.findClaude(env); return p ? real(p) : p; };

  assert.equal(await found({ CANOPY_CLAUDE_PATH: good, PATH: path.dirname(viaPath) }), real(good));
  assert.equal(await found({ PATH: `${path.dirname(viaPath)}:/usr/bin` }), real(viaPath));
  assert.equal(await found({ CANOPY_CLAUDE_PATH: worldWritable, PATH: path.dirname(viaPath) }), real(viaPath), 'a world-writable binary is refused');
  assert.equal(await found({ PATH: `${path.dirname(notExecutable)}:${path.dirname(folder)}:${path.dirname(viaPath)}` }), real(viaPath), 'non-executables and folders are skipped');
  const relative = await found({ PATH: `.:bin:relative/dir:${path.dirname(viaPath)}` });
  assert.equal(relative, real(viaPath), 'relative PATH entries are ignored');
  for (const junk of [undefined, null, {}, { PATH: 7 }]) await assert.doesNotReject(E.findClaude(junk));
});

// ---- login state ----

test('authStatus is tri-state: true, false, or unknown', { skip: need('authStatus'), timeout: 60000 }, async () => {
  const env = { PATH: '/usr/bin:/bin', HOME: os.homedir() };
  const yes = script(path.join(dir(), 'claude'), `echo 'Welcome to the beta { not json'; echo '{"loggedIn":true,"authMethod":"claude.ai","orgName":"Acme"}'`);
  const no = script(path.join(dir(), 'claude'), `echo '{"loggedIn":false}'`);
  const garbage = script(path.join(dir(), 'claude'), `echo 'Segmentation fault' >&2; exit 139`);
  const leaky = script(path.join(dir(), 'claude'), `echo "fatal: bad credentials sk-ant-api03-AbCdEf0123456789_xyz" >&2; exit 1`);

  const a = await E.authStatus(no, env);
  assert.equal(a.loggedIn, false);
  const b = await E.authStatus(garbage, env);
  assert.equal(b.loggedIn, null, 'a crash is "could not check", not "signed out"');
  assert.equal(typeof b.error, 'string');
  const c = await E.authStatus(leaky, env);
  assert.equal(c.loggedIn, null);
  assert.ok(!String(c.error).includes('AbCdEf0123456789'), 'the error detail is redacted');
  const d = await E.authStatus(path.join(root, 'no-such-binary'), env);
  assert.equal(d.loggedIn, null);
  for (const r of [a, b, c, d]) assert.ok('method' in r && 'org' in r);
  const e = await E.authStatus(yes, env).catch(() => null);
  // A banner containing a brace before the JSON is the hard case; either answer must not be "signed out".
  assert.notEqual(e?.loggedIn, false);
});

test('authStatus parses clean and banner-prefixed JSON', { skip: need('authStatus') }, async () => {
  const env = { PATH: '/usr/bin:/bin', HOME: os.homedir() };
  const clean = script(path.join(dir(), 'claude'), `echo '{"loggedIn":true,"authMethod":"claude.ai","orgName":"Acme"}'`);
  const banner = script(path.join(dir(), 'claude'), `echo 'A new version is available.'; echo '{"loggedIn":true,"authMethod":"api_key","orgName":null}'; echo 'done'`);
  assert.deepEqual(await E.authStatus(clean, env).then((r) => [r.loggedIn, r.method, r.org]), [true, 'claude.ai', 'Acme']);
  assert.deepEqual(await E.authStatus(banner, env).then((r) => [r.loggedIn, r.method, r.org]), [true, 'api_key', null]);
});

test('authStatus says which folder and organisation Claude Code answered for', { skip: need('authStatus') }, async () => {
  const env = { PATH: '/usr/bin:/bin', HOME: os.homedir() };
  // The fields of `claude auth status --json` (2.1.325) for a Console sign-in.
  const full = script(path.join(dir(), 'claude'), `echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"/Users/someone/.claude/projects","configDirectory":"/Users/someone/.claude","loginExpiresAt":null,"consoleProfileSignInOffered":true,"apiKeySource":"/login managed key","email":"me@example.com","orgId":"0b1c2d3e","orgName":"Acme"}'`);
  assert.deepEqual(await E.authStatus(full, env), {
    loggedIn: true, method: 'api_key', org: 'Acme', email: 'me@example.com', orgId: '0b1c2d3e', provider: 'firstParty',
    apiKeySource: '/login managed key', subscriptionType: null, configDir: '/Users/someone/.claude', expiresAt: null,
  });
  const bare = script(path.join(dir(), 'claude'), `echo '{"loggedIn":true,"authMethod":"claude.ai","orgName":"Acme"}'`);
  const b = await E.authStatus(bare, env);
  assert.deepEqual([b.configDir, b.orgId], [null, null], 'an older Claude Code that does not say');
});

test('configHome: the folder for an environment, and for the one sessions run in when none is given', { skip: need('configHome', 'loadShellEnv'), timeout: 40000 }, async () => {
  const own = path.join(os.homedir(), '.claude');
  assert.equal(E.configHome({ CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work' }), '/Users/someone/.claude-work');
  assert.equal(E.configHome({ HOME: '/elsewhere' }), own);
  assert.equal(E.configHome({ CLAUDE_CONFIG_DIR: '' }), own);
  for (const junk of [{ CLAUDE_CONFIG_DIR: 7 }, {}]) assert.equal(E.configHome(junk), own);

  // No environment given: the login shell's, once it has been read, not whatever this process happens to hold.
  // (An app started from the Dock has no CLAUDE_CONFIG_DIR of its own even when the shell sets one.)
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'from-the-shell');
  try {
    const shell = await E.loadShellEnv({ force: true });
    const expected = shell.env.CLAUDE_CONFIG_DIR ?? own; // the user's own rc files may set it themselves
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'this-process-only');
    assert.equal(E.configHome(), expected);
    assert.notEqual(E.configHome(), path.join(root, 'this-process-only'));
    assert.equal(E.configHome({ CLAUDE_CONFIG_DIR: '/explicit' }), '/explicit', 'an environment that is given always wins');
    // What reads Claude Code's transcripts looks there too: a chat written under the shell's folder is found
    // with nothing passed in. (Skipped when the user's own rc files point the shell somewhere real.)
    if (expected === path.join(root, 'from-the-shell')) {
      const { lastActive } = await import('../../../last-active.mjs');
      const { chatTotals } = await import('../../../chat-totals.mjs');
      const project = '/Users/someone/app';
      const folder = path.join(expected, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'chat-1.jsonl'), [
        JSON.stringify({ type: 'user', timestamp: '2026-11-16T09:00:00.000Z', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'cost-state', totalCostUSD: 0.25, totalAPIDuration: 1000, totalToolDuration: 500, totalLinesAdded: 3, totalLinesRemoved: 1 }),
      ].join('\n') + '\n');
      assert.equal(await lastActive('chat-1', project), Date.parse('2026-11-16T09:00:00.000Z'));
      assert.deepEqual(await chatTotals('chat-1', project), { cost: 0.25, workMs: 1500, linesAdded: 3, linesRemoved: 1 });
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    await E.loadShellEnv({ force: true }).catch(() => {});
  }
});

test('isSessionId accepts uuids only', { skip: need('isSessionId') }, () => {
  assert.equal(E.isSessionId('9d0f6c1e-7b1a-4c53-9a54-0e2f8d1b2c3d'), true);
  for (const bad of ['', 'latest', '9d0f6c1e7b1a4c539a540e2f8d1b2c3d', '--dangerously-skip-permissions', '9d0f6c1e-7b1a-4c53-9a54-0e2f8d1b2c3d; rm -rf', null, undefined, 7, {}]) assert.equal(E.isSessionId(bad), false, String(bad));
});

// ---- file lists ----

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const gitEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() };

test('listFiles in a git repository: tracked and untracked files, ignores respected', { skip: need('listFiles') || (!hasGit && 'git is not installed') }, async () => {
  const repo = dir();
  execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\nbuild/\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'ünïcode file.js'), 'b');
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'c');
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'out.js'), 'd');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo, env: gitEnv });
  const files = await E.listFiles(repo, gitEnv, { force: true });
  assert.ok(Array.isArray(files));
  assert.ok(files.includes('tracked.txt'));
  assert.ok(files.some((f) => f.normalize('NFC') === 'src/ünïcode file.js'.normalize('NFC')), `non-ASCII names are not quoted: ${files.join(', ')}`);
  assert.ok(!files.includes('ignored.txt') && !files.some((f) => f.startsWith('build/')));
  assert.ok(files.every((f) => typeof f === 'string' && f && !f.includes('\0')));
});

test('listFiles outside git walks the folder and skips dependency folders', { skip: need('listFiles') }, async () => {
  const plain = dir();
  fs.writeFileSync(path.join(plain, 'a.txt'), 'a');
  fs.mkdirSync(path.join(plain, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'sub', 'deep', 'b.txt'), 'b');
  fs.mkdirSync(path.join(plain, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'node_modules', 'pkg', 'index.js'), 'c');
  const files = await E.listFiles(plain, gitEnv, { force: true });
  assert.deepEqual([...files].sort(), ['a.txt', 'sub/deep/b.txt']);
});

test('listFiles refuses folders it should never enumerate', { skip: need('listFiles', 'minimalEnv') }, async () => {
  assert.deepEqual(await E.listFiles(os.homedir(), gitEnv), []);
  assert.deepEqual(await E.listFiles('/', gitEnv), []);
  for (const bad of ['relative/dir', path.join(root, 'missing'), '', null, undefined, 7]) assert.deepEqual(await E.listFiles(bad, gitEnv), [], String(bad));
});

test('gitInfo reports the branch, and nothing for a plain folder', { skip: need('gitInfo') || (!hasGit && 'git is not installed') }, async () => {
  const repo = dir();
  execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo, env: gitEnv });
  const info = await E.gitInfo(repo, gitEnv);
  assert.equal(info.branch, 'trunk');
  const none = await E.gitInfo(dir(), gitEnv);
  assert.ok(!none?.branch);
  await assert.doesNotReject(E.gitInfo('/definitely/not/here', gitEnv));
});

test('gitState reports the branch and what has changed, and null for a plain folder', { skip: need('gitState') || (!hasGit && 'git is not installed') }, async () => {
  const repo = dir();
  execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo, env: gitEnv });
  assert.deepEqual(await E.gitState(repo, gitEnv), { branch: 'trunk', status: '' });
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  assert.deepEqual(await E.gitState(repo, gitEnv), { branch: 'trunk', status: '?? new.txt' });
  assert.equal(await E.gitState(dir(), gitEnv), null);
  for (const bad of ['/definitely/not/here', 'relative/dir', '', null, 7]) assert.equal(await E.gitState(bad, gitEnv), null, String(bad));
});

test('skillBudgetChosen: the variable, or a size in a settings file this chat reads', { skip: need('skillBudgetChosen') }, () => {
  const config = dir();
  const cwd = dir();
  const none = path.join(root, 'no-managed-settings.json');
  const env = { HOME: config, CLAUDE_CONFIG_DIR: config };
  const chosen = (e = env, o = {}) => E.skillBudgetChosen(e, cwd, { managed: none, ...o });
  assert.equal(E.SKILL_BUDGET_VAR, 'SLASH_COMMAND_TOOL_CHAR_BUDGET');
  assert.equal(E.SKILL_BUDGET_CHARS, 8000);
  assert.equal(chosen(), false, 'nothing anywhere');
  assert.equal(chosen({ ...env, SLASH_COMMAND_TOOL_CHAR_BUDGET: '1' }), true);
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ skillListingMaxDescChars: 100 }));
  assert.equal(chosen(), true);
  assert.equal(chosen(env, { sources: ['project'] }), false, 'the user tier is not loaded');
  fs.rmSync(path.join(config, 'settings.json'));
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ skillListingBudgetFraction: 0.02 }));
  assert.equal(chosen(), true);
  assert.equal(chosen(env, { sources: ['user'] }), false, 'an untrusted folder\'s own files do not count');
});

test('fullName answers with something printable', { skip: need('fullName') }, async () => {
  const name = await E.fullName();
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0);
});

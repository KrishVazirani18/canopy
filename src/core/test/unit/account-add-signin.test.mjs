// "Add account → Sign in to Claude Code", end to end in the main process: account-folders.mjs (the folder and the
// list) and signin-ipc.mjs (Claude Code's own sign-in, in the window's terminal) wired to each other the way
// main.mjs wires them, with the real registry and the real Claude engine between them.
//
// Nothing real is involved. "Claude Code" is a shell script in a throwaway folder that answers `auth status` per
// folder and records every call; "the user's Claude Code folder" is a made-up one (account-world.mjs); the
// terminal is a fake that records what it was started with, and "signing in" is the test leaving the mark the
// script reads before it ends that terminal. No real login, folder or config file is read or written, and the
// real `claude` is never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import * as F from '../../../account-folders.mjs';
import { registerSignIn } from '../../../signin-ipc.mjs';
import { ACCOUNT_CONFIG, fakeMac, json, names, put, script } from '../account-world.mjs';
import { core } from '../helpers.mjs';

const A = await core('accounts.mjs');
const C = await core('accounts-claude.mjs');
const missing = A.__missing ? `accounts.mjs: ${A.__missing}` : C.__missing ? `accounts-claude.mjs: ${C.__missing}` : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-account-add-signin-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
assert.ok(tmp.startsWith(os.tmpdir()) && !tmp.includes('.claude') && !tmp.includes('.canopy'));

// Who a folder is signed in as, the way the stand-in claude reads it (a file the stand-in sign-in leaves there).
const WORK = '"authMethod":"claude.ai","email":"work@example.com","orgId":"o-work","orgName":"Work","subscriptionType":"max"';
const WORK_CONSOLE = '"authMethod":"api_key","apiKeySource":"/login managed key","email":"work@example.com","orgId":"o-work","orgName":"Work"';
const DEFAULT = '"authMethod":"api_key","apiKeySource":"/login managed key","email":"me@example.com","orgId":"o-console","orgName":"Acme"';
const TOKENS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES'];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, label = 'condition') => { for (let i = 0; i < 1000; i++) { if (ok()) return; await tick(5); } assert.fail(`timed out waiting for ${label}`); };

// The window's terminal, as far as main sees one: it records what it was started with, and the test ends it.
function fakeTerminal() {
  const made = [];
  const spawn = (file, args, opts) => {
    const p = {
      file, args, opts, wrote: [], kills: [], data: null, exit: null,
      onData(cb) { p.data = cb; }, onExit(cb) { p.exit = cb; },
      write(d) { p.wrote.push(d); }, resize() {}, kill(sig) { p.kills.push(sig ?? 'SIGHUP'); },
      ends(exitCode) { p.exit?.({ exitCode }); },
    };
    made.push(p);
    return p;
  };
  return { spawn, made, get last() { return made.at(-1); } };
}

let seq = 0;
/** One made-up Mac, with account folders, the registry and the sign-in wired as main.mjs wires them. */
function world() {
  const W = fakeMac(path.join(tmp, `w${++seq}`), { configInside: true });
  const calls = path.join(W.w, 'calls');
  // Answers per folder, as the real one does. A sign-out with no account folder named would be the user's own
  // login going: the stand-in writes that down in capitals, and every test checks it never happened.
  const bin = script(path.join(W.w, 'bin', 'claude'), [
    `echo "$1 $2 | \${CLAUDE_CONFIG_DIR:-none}" >> '${calls}'`,
    `if [ "$1 $2" = "auth logout" ]; then`,
    `  if [ -z "$CLAUDE_CONFIG_DIR" ] || [ "$CLAUDE_CONFIG_DIR" = '${W.base}' ]; then echo 'THE DEFAULT LOGIN WAS SIGNED OUT' >> '${calls}'; exit 0; fi`,
    `  rm -f "$CLAUDE_CONFIG_DIR/.who"; exit 0`,
    `fi`,
    `if [ "$1 $2" = "auth login" ]; then echo 'A REAL SIGN-IN WAS RUN' >> '${calls}'; exit 1; fi`,
    `if [ -n "$CLAUDE_CONFIG_DIR" ] && [ "$CLAUDE_CONFIG_DIR" != '${W.base}' ]; then`,
    `  if [ -f "$CLAUDE_CONFIG_DIR/.who" ]; then echo '{"loggedIn":true,"apiProvider":"firstParty",'"$(cat "$CLAUDE_CONFIG_DIR/.who")"',"configDirectory":"'"$CLAUDE_CONFIG_DIR"'"}'; exit 0; fi`,
    `  echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1`,
    `fi`,
    `echo '{"loggedIn":true,"apiProvider":"firstParty",${DEFAULT},"configDirectory":"${W.base}"}'`,
  ].join('\n'));
  const env = Object.freeze({ PATH: '/usr/bin:/bin', HOME: W.home, CLAUDE_CONFIG_DIR: W.base, ANTHROPIC_API_KEY: 'sk-shell-key-0001', CLAUDE_CODE_OAUTH_TOKEN: 'shell-oauth-token-0003' });
  const tool = { path: bin, env };
  const state = {}, logs = [], sent = [], channels = new Map(), uses = {}, removed = [];
  const term = fakeTerminal();
  let reg = null;
  let signIn = null;
  // main.mjs, the Accounts part: the folders first (the registry's Claude engine needs their guard), then the
  // registry, then the sign-in. Each reaches the others only when called.
  const folders = new F.AccountFolders({
    accounts: () => reg, root: W.root, claude: () => tool,
    signIn: ({ dir, console: viaConsole }) => signIn.signIn({ dir, ...(viaConsole === true && { console: true }) }),
    inUse: (id) => (signIn.runner.state?.account === id ? 'working' : uses[id] ?? null),
    stopIdle: async (id) => { if (uses[id] === 'idle') uses[id] = null; },
    onRemoved: (id, was) => removed.push([id, was.active]),
    log: (m) => logs.push(m), timers: { set: (fn) => fn, clear: () => {} },
  });
  reg = new A.Accounts({
    engines: { claude: C.claudeAccounts({ tool: () => tool, home: folders.guard }) },
    load: () => state.accounts ?? null, save: (s) => { state.accounts = JSON.parse(JSON.stringify(s)); }, log: (m) => logs.push(m),
  });
  signIn = registerSignIn((channel, fn) => channels.set(channel, fn), {
    accounts: reg, claude: () => tool, spawn: term.spawn, on: () => {},
    send: (channel, ...args) => sent.push([channel, ...args]),
    sessions: () => ({ all: [], shown: [] }), recheck: async () => {}, tmp: () => W.w, log: (m) => logs.push(m),
  });
  const call = (channel, ...args) => channels.get(channel)(...args);
  const sheets = () => sent.filter(([c]) => c === 'signin:state').map(([, s]) => s);
  // The window's part: the sheet came on screen and its terminal attached, so Claude Code's sign-in starts in it.
  const sheetOpens = async (how) => {
    await until(() => signIn.runner.state?.phase === 'ready', 'the sign-in sheet');
    const run = sheets().findLast((s) => s.phase === 'ready'); // as the window was told
    assert.equal(run.id, signIn.runner.state.id);
    assert.deepEqual(await call('signin:attach', run.id, 80, 24, how), { ok: true });
    return run;
  };
  // The user signed in, in that terminal: Claude Code keeps the login in the folder it was started for, and exits 0.
  const signsInAs = (who) => {
    const dir = term.last.opts.env.CLAUDE_CONFIG_DIR;
    put(path.join(dir, '.who'), who);
    json(path.join(dir, '.claude.json'), ACCOUNT_CONFIG());
    term.last.ends(0);
  };
  const ran = () => { try { return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const row = (id) => reg.view().list.find((a) => a.id === id) ?? null;
  const added = () => reg.entries('claude').filter((a) => a.dir);
  // Canopy runs Claude Code's sign-in only in the window's terminal (the fake one here), and never signs the user's own login out.
  const nothingRealRan = () => { for (const never of ['THE DEFAULT LOGIN', 'A REAL SIGN-IN']) assert.ok(!ran().some((l) => l.includes(never)), never); };
  return { ...W, env, tool, folders, reg, signIn, state, logs, sent, term, uses, removed, call, sheets, sheetOpens, signsInAs, ran, row, added, nothingRealRan };
}

test('Add account → Sign in to Claude Code: a folder, Claude Code’s own sign-in for it in the sheet, and the account is in once Claude Code says who it is', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  assert.deepEqual(W.reg.view().list.map((a) => [a.id, a.kind, a.state]), [['claude-default', 'console', 'ok']]);

  const adding = W.folders.add({ kind: 'plan' });
  const run = await W.sheetOpens();
  // Listed, signed out, from the moment its folder exists: a sign-in cut short leaves a row, never a stray folder.
  const [made] = W.added();
  assert.deepEqual([made.kind, made.state, path.dirname(made.dir), names(W.root)], ['plan', 'signed-out', W.root, [made.id]]);
  // The sheet is told nothing about the account but that it is not a listed one being signed in to again, and
  // may still switch to the Console: which kind it becomes is what Claude Code reports afterwards.
  assert.deepEqual([run.account, run.canSwitch, run.console, run.engine], [null, true, false, 'claude']);
  // Claude Code's own sign-in, for that folder and no other, with no token of the shell's in its environment.
  assert.deepEqual([W.term.made.length, W.term.last.file, W.term.last.args], [1, W.tool.path, ['auth', 'login']]);
  assert.equal(W.term.last.opts.env.CLAUDE_CONFIG_DIR, made.dir);
  for (const k of TOKENS) assert.ok(!(k in W.term.last.opts.env), `${k} reached the sign-in`);
  assert.equal(W.row(made.id).state, 'signed-out');

  W.signsInAs(WORK);
  assert.deepEqual(await adding, { ok: true, id: made.id });
  const a = W.reg.entries('claude').find((x) => x.id === made.id);
  assert.deepEqual([a.state, a.kind, a.email, a.orgId, a.plan], ['ok', 'plan', 'work@example.com', 'o-work', 'max']);
  assert.deepEqual([W.row(made.id).label, W.row(made.id).found], ['Max', false]);
  assert.deepEqual([W.sheets().at(-1).phase, W.sheets().at(-1).who], ['done', { label: 'Max', email: 'work@example.com' }]);
  // Adding never changes which account is in use, and the user's own login is as it was.
  assert.deepEqual([W.reg.pin('claude'), W.reg.view().inUse.claude, W.row('claude-default').state], [null, 'claude-default', 'ok']);
  assert.equal(W.signIn.runner.state, null, 'the sign-in is over');
  // It can be chosen like any other account, and is launched in its own folder.
  assert.deepEqual(W.reg.setActive('claude', made.id), { ok: true });
  const launch = W.reg.envFor('claude');
  assert.equal(launch.CLAUDE_CONFIG_DIR, made.dir);
  for (const k of TOKENS) assert.ok(!(k in launch), `${k} would outrank the sign-in`);
  W.nothingRealRan();
  assert.ok(!JSON.stringify(W.sent).includes(W.root), 'the window is never told a folder');
});

test('the sheet’s own "Use Console instead" decides what the account is: what Claude Code reports, not what was asked for', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  const adding = W.folders.add({ kind: 'plan' });
  await W.sheetOpens({ console: true });
  assert.deepEqual(W.term.last.args, ['auth', 'login', '--console']);
  W.signsInAs(WORK_CONSOLE);
  const r = await adding;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([W.row(r.id).kind, W.row(r.id).label, W.row(r.id).email], ['console', 'Console', 'work@example.com']);
  // Asked for as a Console sign-in from the start: the sheet has nothing left to choose.
  const again = W.folders.add({ kind: 'console' });
  const run = await W.sheetOpens();
  assert.deepEqual([run.canSwitch, run.console, W.term.last.args], [false, true, ['auth', 'login', '--console']]);
  // The same login twice is taken back: its folder is signed out (that folder only) and deleted.
  W.signsInAs(WORK_CONSOLE);
  const twin = await again;
  assert.deepEqual([twin.ok, twin.code, twin.existing], [false, 'duplicate', r.id]);
  assert.deepEqual([W.added().map((a) => a.id), names(W.root)], [[r.id], [r.id]]);
  W.nothingRealRan();
});

test('a sign-in closed half way, or one that fails, leaves nothing behind: no folder, no row, and nobody else signed out', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  // Closed before the terminal ever started.
  let adding = W.folders.add();
  await until(() => W.signIn.runner.state?.phase === 'ready', 'the sign-in sheet');
  await W.call('signin:cancel', W.signIn.runner.state.id);
  let r = await adding;
  assert.deepEqual([r.ok, r.code], [false, 'cancelled']);
  assert.deepEqual([W.added(), names(W.root)], [[], []]);
  // Closed with Claude Code's sign-in running: it is stopped, and the folder goes.
  adding = W.folders.add();
  let run = await W.sheetOpens();
  await W.call('signin:cancel', run.id);
  r = await adding;
  assert.deepEqual([r.ok, r.code, W.term.last.kills.length > 0], [false, 'cancelled', true]);
  assert.deepEqual([W.added(), names(W.root)], [[], []]);
  // Claude Code's sign-in ended badly, and the sheet was then closed.
  adding = W.folders.add();
  run = await W.sheetOpens();
  W.term.last.ends(1);
  await until(() => W.sheets().at(-1).phase === 'failed', 'the failed sign-in');
  assert.equal(W.added().length, 1, 'still listed while the sheet offers another try');
  await W.call('signin:cancel', run.id);
  r = await adding;
  assert.equal(r.ok, false);
  assert.deepEqual([W.added(), names(W.root)], [[], []]);
  // And the next try works.
  adding = W.folders.add();
  await W.sheetOpens();
  W.signsInAs(WORK);
  assert.equal((await adding).ok, true);
  assert.deepEqual(W.reg.view().list.map((a) => [a.kind, a.state]), [['console', 'ok'], ['plan', 'ok']]);
  W.nothingRealRan();
});

test('one sign-in at a time: while a sheet is open nothing is added, and nothing is made for the try that was refused', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  // The user is signing in to Claude Code's own login again.
  const open = await W.call('signin:begin', { engine: 'claude', accountId: 'claude-default' });
  assert.equal(open.ok, true);
  const r = await W.folders.add();
  assert.deepEqual([r.ok, r.code, r.message], [false, 'busy', 'A sign-in is already open.']);
  assert.deepEqual([W.added(), names(W.root)], [[], []]);
  await W.call('signin:cancel', open.id);
  // And the other way round: while an account is being added, a second one is refused before anything is made.
  const adding = W.folders.add();
  await W.sheetOpens();
  assert.equal((await W.folders.add()).code, 'busy');
  assert.equal(names(W.root).length, 1);
  W.signsInAs(WORK);
  assert.equal((await adding).ok, true);
  W.nothingRealRan();
});

test('signing in again to an added account: the same sheet, for its folder, and its folder is left alone meanwhile', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  const adding = W.folders.add();
  await W.sheetOpens();
  W.signsInAs(WORK);
  const { id } = await adding;
  const dir = W.reg.entries('claude').find((a) => a.id === id).dir;
  // Signed out behind Canopy's back (in a terminal): the next look says so, and the row offers the sign-in.
  fs.rmSync(path.join(dir, '.who'));
  await W.reg.refresh();
  assert.equal(W.row(id).state, 'signed-out');

  const open = await W.call('signin:begin', { engine: 'claude', accountId: id, dir: W.outside });
  assert.equal(open.ok, true);
  assert.deepEqual(await W.call('signin:attach', open.id, 80, 24), { ok: true });
  assert.deepEqual([W.term.last.opts.env.CLAUDE_CONFIG_DIR, W.term.last.args], [dir, ['auth', 'login', '--email', 'work@example.com']], 'its own folder, whatever the window names');
  // While Claude Code's sign-in is writing that folder, the account counts as at work: it is not removed, and
  // its config is not rewritten under the sign-in.
  assert.equal(W.signIn.runner.state.account, id);
  const no = await W.folders.remove(id);
  assert.deepEqual([no.ok, no.code], [false, 'working']);
  assert.ok(fs.existsSync(dir));
  put(path.join(dir, '.who'), WORK);
  W.term.last.ends(0);
  await until(() => W.sheets().at(-1).phase === 'done', 'the sign-in to be confirmed');
  assert.equal(W.row(id).state, 'ok');

  // Removing it: only that folder is signed out, and main is told when the account new chats used went with it.
  W.reg.setActive('claude', id);
  assert.deepEqual(await W.folders.remove(id), { ok: true });
  assert.deepEqual([W.removed, W.reg.pin('claude'), W.reg.view().inUse.claude, names(W.root)], [[[id, true]], null, 'claude-default', []]);
  assert.deepEqual(W.ran().filter((l) => l.startsWith('auth logout')), [`auth logout | ${dir}`]);
  W.nothingRealRan();
});

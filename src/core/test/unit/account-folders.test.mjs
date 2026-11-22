// account-folders.mjs: adding a second Claude Code sign-in, removing one, and keeping account folders in order,
// with the registry (accounts.mjs) and the Claude engine (accounts-claude.mjs) wired the way main.mjs wires them.
//
// Nothing real is involved. "Claude Code" is a shell script in a throwaway folder that answers `auth status` per
// folder and records every call; "the user's Claude Code folder" is a made-up one (account-world.mjs); "signing in"
// is a function that leaves the mark the script reads. No real login, folder or config file is read or written,
// and the real `claude` is never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import * as F from '../../../account-folders.mjs';
import { ACCOUNT_CONFIG, SHARED, fakeMac, isLinkTo, json, names, put, read, script, snapshot, stamp } from '../account-world.mjs';
import { CORE, core } from '../helpers.mjs';

const A = await core('accounts.mjs');
const C = await core('accounts-claude.mjs');
const missing = A.__missing ? `accounts.mjs: ${A.__missing}` : C.__missing ? `accounts-claude.mjs: ${C.__missing}` : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-account-folders-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
assert.ok(tmp.startsWith(os.tmpdir()) && !tmp.includes('.claude') && !tmp.includes('.canopy'));

// Who a folder is signed in as, the way the stand-in claude reads it (a file the stand-in sign-in leaves there).
const WORK = '"authMethod":"claude.ai","email":"work@example.com","orgId":"o-work","orgName":"Work","subscriptionType":"max"';
const DEFAULT = '"authMethod":"api_key","apiKeySource":"/login managed key","email":"me@example.com","orgId":"o-console","orgName":"Acme"';

let seq = 0;
/**
 * One made-up Mac with Canopy's account folders wired up. The user's shell names their Claude Code folder
 * (CLAUDE_CONFIG_DIR), which is how every path here stays inside the temp folder.
 */
function world({ fill, signIn = 'given', ...over } = {}) {
  const W = fakeMac(path.join(tmp, `w${++seq}`), { fill, configInside: true });
  const calls = path.join(W.w, 'calls');
  // Answers per folder, as the real one does. A sign-out with no account folder named would be the user's own
  // login going: the stand-in writes that down in capitals, and every test checks it never happened.
  const bin = script(path.join(W.w, 'bin', 'claude'), [
    `echo "$1 $2 | \${CLAUDE_CONFIG_DIR:-none}" >> '${calls}'`,
    `if [ "$1 $2" = "auth logout" ]; then`,
    `  if [ -z "$CLAUDE_CONFIG_DIR" ] || [ "$CLAUDE_CONFIG_DIR" = '${W.base}' ]; then echo 'THE DEFAULT LOGIN WAS SIGNED OUT' >> '${calls}'; exit 0; fi`,
    `  if [ -f "$CLAUDE_CONFIG_DIR/.stuck" ]; then exit 1; fi`,
    `  rm -f "$CLAUDE_CONFIG_DIR/.who"; exit 0`,
    `fi`,
    `if [ -n "$CLAUDE_CONFIG_DIR" ] && [ "$CLAUDE_CONFIG_DIR" != '${W.base}' ]; then`,
    `  if [ -f "$CLAUDE_CONFIG_DIR/.who" ]; then echo '{"loggedIn":true,"apiProvider":"firstParty",'"$(cat "$CLAUDE_CONFIG_DIR/.who")"',"configDirectory":"'"$CLAUDE_CONFIG_DIR"'"}'; exit 0; fi`,
    `  echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1`,
    `fi`,
    `echo '{"loggedIn":true,"apiProvider":"firstParty",${DEFAULT},"configDirectory":"${W.base}"}'`,
  ].join('\n'));
  const env = Object.freeze({ PATH: '/usr/bin:/bin', HOME: W.home, CLAUDE_CONFIG_DIR: W.base, MY_TOOL_TOKEN: 'shell-secret-value' });
  const tool = { path: bin, env };
  const state = {}, logs = [], drifts = [], timers = [], stopped = [], views = [], signIns = [];
  const uses = {};
  // The stand-in for Claude Code's own sign-in, shown by the host: it leaves the folder signed in as `who`.
  const login = { who: WORK, result: { ok: true }, during: null };
  const fakeSignIn = async (o) => {
    signIns.push(o);
    if (login.during) await login.during(o);
    if (login.who) { put(path.join(o.dir, '.who'), login.who); json(path.join(o.dir, '.claude.json'), ACCOUNT_CONFIG()); }
    return login.result;
  };
  let reg = null;
  const folders = new F.AccountFolders({
    accounts: () => reg, root: W.root, claude: () => tool,
    signIn: signIn === 'given' ? fakeSignIn : signIn,
    inUse: (id) => uses[id] ?? null,
    stopIdle: async (id) => { stopped.push(id); if (uses[id] === 'idle') uses[id] = null; },
    drift: (label, keys) => drifts.push([label, keys]), log: (m) => logs.push(m),
    timers: { set: (fn) => { timers.push(fn); return fn; }, clear: () => {} },
    ...over,
  });
  reg = new A.Accounts({
    engines: { claude: C.claudeAccounts({ tool: () => tool, home: folders.guard }) },
    load: () => state.accounts ?? null, save: (s) => { state.accounts = JSON.parse(JSON.stringify(s)); },
    onChange: (v) => views.push(v), log: (m) => logs.push(m),
  });
  const ran = () => { try { return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const row = (id) => reg.view().list.find((a) => a.id === id) ?? null;
  const entry = (id) => reg.entries('claude').find((a) => a.id === id) ?? null;
  return { ...W, env, tool, folders, reg, state, logs, drifts, timers, stopped, views, signIns, uses, login, ran, row, entry };
}
// A world where the user's own login was found, and one account was added and checked.
async function withAccount(opts) {
  const W = world(opts);
  await W.reg.refresh();
  const r = await W.folders.add();
  assert.equal(r.ok, true, JSON.stringify(r));
  return { ...W, id: r.id, dir: W.entry(r.id).dir };
}
const neverSignedOutTheUser = (W) => assert.ok(!W.ran().some((l) => l.includes('THE DEFAULT LOGIN')), 'the user’s own login was signed out');
const refusedWith = (fn, code) => assert.throws(fn, (err) => { assert.equal(err.code, code); assert.equal(err.canopy.code, code); return true; });

// ---- adding ----

test('adding a plan: a folder, Claude Code’s own sign-in for it, and the account is in once Claude Code says who it is', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  assert.deepEqual(W.reg.view().list.map((a) => [a.id, a.kind, a.state]), [['claude-default', 'console', 'ok']]);
  const base = snapshot(W.base);

  let during = null;
  W.login.during = async ({ dir }) => { during = { row: W.reg.view().list.find((a) => a.id !== 'claude-default'), links: names(dir), launch: (() => { try { W.reg.envFor('claude', { account: path.basename(dir) }); return 'launched'; } catch (e) { return e.code; } })() }; };
  const r = await W.folders.add({ kind: 'plan' });
  assert.equal(r.ok, true);
  assert.match(r.id, /^claude-[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(r).sort(), ['id', 'ok'], 'the answer names the account, never its folder');

  // The sign-in was asked for that folder, as a plan, and for nothing else.
  const dir = path.join(W.root, r.id);
  assert.deepEqual(W.signIns, [{ dir, console: false }]);
  // While it was open the account was already listed, signed out, with its folder linked, and could not be launched.
  assert.deepEqual([during.row.id, during.row.state, during.row.kind], [r.id, 'signed-out', 'plan']);
  assert.ok(during.links.includes('projects') && during.links.includes('settings.json'));
  assert.equal(during.launch, 'account-signed-out');

  // Who it is comes from Claude Code's answer for that folder.
  const a = W.entry(r.id);
  assert.deepEqual([a.kind, a.email, a.org, a.orgId, a.plan, a.state, a.dir], ['plan', 'work@example.com', 'Work', 'o-work', 'max', 'ok', dir]);
  assert.deepEqual([W.row(r.id).label, W.row(r.id).found], ['Max', false]);
  assert.ok(!JSON.stringify(W.reg.view()).includes(W.root), 'the window never sees a folder');
  assert.equal(W.reg.pin('claude'), null, 'adding an account does not choose it');

  // The folder holds the links, Claude Code's own sign-in state, and the user's connectors and trusted folders.
  assert.ok(isLinkTo(path.join(dir, 'projects'), path.join(W.base, 'projects')));
  const mine = read(path.join(dir, '.claude.json'));
  assert.deepEqual(Object.keys(mine.mcpServers).sort(), ['files', 'notion']);
  assert.equal(mine.projects['/Users/someone/app'].hasTrustDialogAccepted, true);
  assert.deepEqual(mine.oauthAccount, ACCOUNT_CONFIG().oauthAccount, 'its own login record, not the user’s');

  // The user's own Claude Code folder and login were only ever asked about.
  assert.deepEqual(snapshot(W.base), base);
  assert.ok(W.ran().every((l) => l.startsWith('auth status')), 'no sign-out, no sign-in run by Canopy itself');
  assert.deepEqual(W.ran().filter((l) => l.endsWith(`| ${dir}`)).length >= 1, true, 'the account was checked in its own folder');
  neverSignedOutTheUser(W);
  // Nothing of the launch environment, and no email, reaches the log.
  const everything = JSON.stringify([W.state, W.views]) + W.logs.join('\n');
  assert.ok(!everything.includes('shell-secret-value') && !everything.includes('server-secret'));
  assert.ok(!W.logs.join('\n').includes('work@example.com'), 'the log names accounts by id');

  // It launches with its own folder, and the user's own plugins.
  const launch = W.reg.envFor('claude', { account: r.id });
  assert.equal(launch.CLAUDE_CONFIG_DIR, dir);
  assert.equal(launch.CLAUDE_CODE_PLUGIN_CACHE_DIR, path.join(W.base, 'plugins'));
  assert.deepEqual(W.reg.envFor('claude'), { ...W.env }, 'and with nothing chosen, chats launch exactly as before');
});

test('adding a Console sign-in asks Claude Code for exactly that', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  W.login.who = '"authMethod":"api_key","apiKeySource":"/login managed key","email":"work@example.com","orgId":"o-work-console","orgName":"Work"';
  const r = await W.folders.add({ kind: 'console' });
  assert.equal(r.ok, true);
  assert.deepEqual(W.signIns.map((s) => s.console), [true]);
  assert.deepEqual([W.entry(r.id).kind, W.row(r.id).label], ['console', 'Console']);
  // What Claude Code says it signed in as wins over what was asked for.
  W.login.who = WORK;
  const other = await W.folders.add({ kind: 'console' });
  assert.equal(W.entry(other.id).kind, 'plan');
  for (const junk of ['key', 'external', '', null, 7]) assert.equal((await W.folders.add({ kind: junk })).code, 'invalid');
});

test('with no way to show Claude Code’s sign-in, nothing at all is made', { skip: missing, timeout: 60000 }, async () => {
  const W = world({ signIn: null });
  await W.reg.refresh();
  const before = snapshot(W.w), asked = W.ran().length;
  const r = await W.folders.add();
  assert.deepEqual([r.ok, r.code], [false, 'unavailable']);
  assert.equal(typeof r.message, 'string');
  assert.deepEqual(snapshot(W.w), before, 'no folder, not even the accounts root');
  assert.equal(W.ran().length, asked, 'and Claude Code was not run');
  assert.equal(W.reg.view().list.length, 1);

  // Before the setup check has finished there is nothing to sign in with either.
  const early = world();
  early.tool.env = null;
  assert.equal((await early.folders.add()).code, 'no-env');
  assert.ok(!fs.existsSync(early.root));
});

test('a sign-in that is closed, fails or throws is taken back: folder signed out and deleted, account gone', { skip: missing, timeout: 60000 }, async () => {
  for (const [result, code] of [[{ ok: false, code: 'cancelled' }, 'cancelled'], [{ ok: false }, 'cancelled'], [{ ok: false, code: 'failed', message: 'It did not open.' }, 'failed'], ['throw', 'failed'], [null, 'cancelled'], [{ ok: 'yes' }, 'cancelled']]) {
    const W = world();
    await W.reg.refresh();
    const base = snapshot(W.base);
    W.login.result = result;
    if (result === 'throw') W.login.during = async () => { throw new Error('the sheet crashed with pasted-code-123 in hand'); };
    const r = await W.folders.add();
    assert.deepEqual([r.ok, r.code], [false, code], JSON.stringify(result));
    assert.ok(!JSON.stringify(r).includes('pasted-code-123') && !W.logs.join('\n').includes('pasted-code-123'), 'what broke inside the sign-in is not passed on or logged');
    const dir = W.signIns[0].dir;
    assert.equal(fs.lstatSync(dir, { throwIfNoEntry: false }), undefined, 'its folder is gone');
    assert.deepEqual(names(W.root), []);
    assert.deepEqual(W.reg.view().list.map((a) => a.id), ['claude-default']);
    // The sign-in may have got halfway, so that folder (and only that folder) was signed out before it was deleted.
    assert.deepEqual(W.ran().filter((l) => l.startsWith('auth logout')), [`auth logout | ${dir}`]);
    neverSignedOutTheUser(W);
    assert.deepEqual(snapshot(W.base), base);
    assert.equal((await W.folders.add()).code, code, 'and another try is not blocked');
  }
});

test('the account is added only if Claude Code names a sign-in for that very folder', { skip: missing, timeout: 60000 }, async () => {
  // The sign-in "worked" but the folder holds no login.
  let W = world();
  await W.reg.refresh();
  W.login.who = null;
  let r = await W.folders.add();
  assert.deepEqual([r.ok, r.code], [false, 'not-signed-out']);
  assert.match(r.message, /did not finish signing in/);
  assert.deepEqual([names(W.root), W.reg.view().list.length], [[], 1]);

  // Claude Code answers for some other folder, says a key helper supplies the login, or does not answer.
  const answers = {
    'not-mismatch': { loggedIn: true, method: 'claude.ai', provider: 'firstParty', email: 'work@example.com', orgId: 'o-work', configDir: '/Users/someone/.claude' },
    'not-blocked': { loggedIn: true, method: 'api_key_helper', provider: 'firstParty' },
    'not-unknown': { loggedIn: null, method: null, org: null, error: 'timed out' },
  };
  for (const [code, answer] of Object.entries(answers)) {
    W = world({ ask: async (_bin, env) => (env.CLAUDE_CONFIG_DIR === W.base ? { loggedIn: true, method: 'api_key', apiKeySource: '/login managed key', email: 'me@example.com', orgId: 'o-console', configDir: W.base } : answer) });
    r = await W.folders.add();
    assert.deepEqual([r.ok, r.code], [false, code]);
    assert.equal(typeof r.message, 'string');
    assert.deepEqual(names(W.root), [], `${code}: the folder was taken back`);
    assert.deepEqual(W.reg.entries('claude'), []);
    neverSignedOutTheUser(W);
  }
});

test('a check that breaks outright still leaves nothing half-added', { skip: missing, timeout: 60000 }, async () => {
  // Claude Code cannot be asked at all (the question itself throws): that is "no answer", so nothing is added.
  let W = world({ ask: async () => { throw new Error('spawn failed'); } });
  let r = await W.folders.add();
  assert.deepEqual([r.ok, r.code], [false, 'not-unknown']);
  assert.deepEqual([names(W.root), W.reg.entries('claude')], [[], []]);
  // Something inside the flow itself breaks after the account was listed: it is taken back just the same.
  W = world();
  await W.reg.refresh();
  const note = W.reg.note.bind(W.reg);
  W.reg.note = () => { throw new Error('boom'); };
  r = await W.folders.add();
  assert.deepEqual([r.ok, r.code], [false, 'failed']);
  W.reg.note = note;
  assert.deepEqual([names(W.root), W.reg.view().list.map((a) => a.id)], [[], ['claude-default']]);
  assert.equal((await W.folders.add()).ok, true, 'and the next try works');
  neverSignedOutTheUser(W);
});

test('the same login twice is not added: same kind of sign-in, same email, same organisation', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  const base = snapshot(W.base);
  // Signing in again to the very login Claude Code already holds.
  W.login.who = DEFAULT.replace('me@example.com', 'Me@Example.COM'); // an email is the same however it is capitalised
  let r = await W.folders.add({ kind: 'console' });
  assert.deepEqual([r.ok, r.code, r.existing], [false, 'duplicate', 'claude-default']);
  assert.equal(r.message, 'Console is already in Canopy.');
  const dir = W.signIns[0].dir;
  assert.deepEqual(names(W.root), [], 'the second copy’s folder is gone');
  assert.deepEqual(W.ran().filter((l) => l.startsWith('auth logout')), [`auth logout | ${dir}`], 'and only that folder was signed out');
  neverSignedOutTheUser(W);
  assert.deepEqual(snapshot(W.base), base);
  assert.deepEqual(W.reg.view().list.map((a) => [a.id, a.state]), [['claude-default', 'ok']], 'the login Claude Code holds is as it was');

  // The same email in another organisation, or as another kind of sign-in, is a different account.
  W.login.who = DEFAULT.replace('o-console', 'o-other');
  const otherOrg = await W.folders.add({ kind: 'console' });
  assert.equal(otherOrg.ok, true);
  W.login.who = '"authMethod":"claude.ai","email":"me@example.com","orgId":"o-console","subscriptionType":"pro"';
  const otherKind = await W.folders.add();
  assert.equal(otherKind.ok, true);
  // And each of those, a second time, is a duplicate of the one just added.
  r = await W.folders.add();
  assert.deepEqual([r.code, r.existing], ['duplicate', otherKind.id]);
  assert.deepEqual(names(W.root).sort(), [otherKind.id, otherOrg.id].sort());
  // With no email in Claude Code's answer nothing can be told apart, so nothing is called a duplicate on a guess.
  W.login.who = '"authMethod":"claude.ai","orgId":"o-console","subscriptionType":"pro"';
  assert.equal((await W.folders.add()).ok, true);
  assert.ok(W.drifts.some(([label, keys]) => /sign-in check/.test(label) && keys.includes('email')), 'and the missing field is written down');
});

test('one sign-in at a time, and never without the user’s chat history to link to', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  let second = null;
  W.login.during = async () => { second = await W.folders.add(); };
  const first = await W.folders.add();
  assert.equal(first.ok, true);
  assert.deepEqual([second.ok, second.code], [false, 'busy']);
  assert.equal(W.signIns.length, 1);
  assert.deepEqual(names(W.root), [first.id]);

  const { 'projects/-Users-someone-app/chat-1.jsonl': _chat, ...fill } = SHARED;
  const bare = world({ fill });
  const before = snapshot(bare.w);
  const r = await bare.folders.add();
  assert.deepEqual([r.ok, r.code], [false, 'no-history']);
  assert.match(r.message, /no chat history yet/);
  assert.equal(bare.signIns.length, 0, 'the sign-in is not even shown');
  assert.deepEqual(snapshot(bare.w), before);
});

// ---- before every launch ----

test('every launch on an account puts its folder in order first, and refuses one that cannot be', { skip: missing, timeout: 60000 }, async () => {
  const W = await withAccount();
  const launch = () => W.reg.envFor('claude', { account: W.id });
  const base = snapshot(W.base);

  // A link went missing between launches: it is back before Claude Code starts.
  fs.unlinkSync(path.join(W.dir, 'settings.json'));
  fs.unlinkSync(path.join(W.dir, 'skills'));
  assert.equal(launch().CLAUDE_CONFIG_DIR, W.dir);
  assert.ok(isLinkTo(path.join(W.dir, 'settings.json'), path.join(W.base, 'settings.json')));
  assert.ok(isLinkTo(path.join(W.dir, 'skills'), path.join(W.base, 'skills')));
  assert.ok(W.logs.some((l) => l.includes('put back') && l.includes('settings.json')));

  // Claude Code rewrote the settings whole, leaving its own copy where the link was: the user's settings (and with
  // them their permissions) apply again, and the change is written down as something Claude Code now does.
  fs.unlinkSync(path.join(W.dir, 'settings.json'));
  put(path.join(W.dir, 'settings.json'), '{"permissions":{"allow":["Bash(*)"]}}');
  launch();
  assert.equal(fs.readFileSync(path.join(W.dir, 'settings.json'), 'utf8'), SHARED['settings.json']);
  assert.deepEqual(W.drifts.at(-1), ['accounts: Claude Code replaced a link with its own copy', ['settings.json']]);

  // The user's chat history is gone from their folder: the account would save its chats apart, so it does not start.
  fs.renameSync(path.join(W.base, 'projects'), path.join(W.outside, 'projects'));
  refusedWith(launch, 'account-blocked');
  assert.match((() => { try { launch(); } catch (e) { return e.message; } })(), /^Max can’t be used: Claude Code has no chat history yet/);
  assert.equal(W.logs.filter((l) => l.includes('not fit to launch on')).length, 1, 'said once, not at every try');
  fs.renameSync(path.join(W.outside, 'projects'), path.join(W.base, 'projects'));
  assert.equal(launch().CLAUDE_CONFIG_DIR, W.dir, 'and starts again as soon as it is back');

  // Its folder was deleted behind Canopy's back: refused as missing, and not quietly made again without its sign-in.
  fs.rmSync(W.dir, { recursive: true });
  refusedWith(launch, 'account-missing');
  assert.equal(fs.lstatSync(W.dir, { throwIfNoEntry: false }), undefined);
  assert.deepEqual(snapshot(W.base), { ...base, '.': snapshot(W.base)['.'] }, 'the user’s folder only ever lost and regained what the test moved');
  // Chats with nothing chosen are not held up by any of it.
  assert.deepEqual(W.reg.envFor('claude'), { ...W.env });
});

test('an account whose saved folder is not one of Canopy’s is never launched on, linked into or signed out', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  fs.mkdirSync(path.join(W.outside, 'claude-0a0b0c0d'), { recursive: true });
  // A saved list that was edited by hand (or came from another copy of Canopy): folders that are not under the root.
  for (const [id, dir] of [['claude-aaaa0001', W.base], ['claude-aaaa0002', path.join(W.outside, 'claude-0a0b0c0d')], ['claude-aaaa0003', W.home]]) {
    assert.equal(W.reg.add({ id, engine: 'claude', kind: 'plan', dir, email: 'x@example.com', state: 'ok' }).ok, true);
  }
  const before = snapshot(W.w), asked = W.ran().length;
  const ids = ['claude-aaaa0001', 'claude-aaaa0002', 'claude-aaaa0003'];
  for (const id of ids) {
    refusedWith(() => W.reg.envFor('claude', { account: id }), 'account-blocked');
    assert.match((() => { try { W.reg.envFor('claude', { account: id }); } catch (e) { return e.message; } })(), /not where Canopy keeps accounts/);
  }
  // A repair marks them, so the row says why.
  await W.folders.repair();
  assert.deepEqual(W.reg.view().list.filter((a) => a.id !== 'claude-default').map((a) => [a.state, a.why]), Array(3).fill(['blocked', 'its folder is not where Canopy keeps accounts']));
  assert.equal(W.timers.length, 0, 'a folder in the wrong place does not come right by waiting, so nothing waits on it');
  assert.deepEqual(snapshot(W.w), before, 'no link was made in any of them');
  assert.equal(W.ran().length, asked, 'Claude Code was not run for any of them');
  // Removing one only forgets it: the row can always be got rid of, and that folder is left exactly as it is.
  W.uses['claude-aaaa0001'] = 'idle';
  for (const id of ids) assert.deepEqual(await W.folders.remove(id), { ok: true }, id);
  assert.deepEqual(W.reg.view().list.map((a) => a.id), ['claude-default']);
  assert.deepEqual(snapshot(W.w), before, 'nothing in any of them was deleted: not the user’s Claude Code folder, not their home');
  assert.equal(W.ran().length, asked, 'and Claude Code was never pointed at them to sign anything out');
  assert.ok(W.logs.some((l) => l.includes('claude-aaaa0001: forgotten')));
  neverSignedOutTheUser(W);
});

test('a launch brings the account’s connectors in line when nothing runs on it, and waits when something does', { skip: missing, timeout: 60000 }, async () => {
  const W = await withAccount();
  const file = path.join(W.dir, '.claude.json');
  const launch = () => W.reg.envFor('claude', { account: W.id });
  const addConnector = (name) => { const c = read(W.baseConfig); c.mcpServers[name] = { type: 'http', url: `https://${name}.example` }; json(W.baseConfig, c); };
  const baseStamp = () => stamp(W.baseConfig);

  // The user added a connector in their own setup (in a terminal, say). Nothing runs on the account: the next launch has it.
  addConnector('linear');
  let s = baseStamp();
  launch();
  assert.ok('linear' in read(file).mcpServers);
  assert.equal(baseStamp(), s, 'the user’s config is only read');
  const after = stamp(file);
  launch();
  assert.equal(stamp(file), after, 'in line already: not written again');

  // A chat is at work on the account: its config is Claude Code's to write, so Canopy waits.
  addConnector('sentry');
  W.uses[W.id] = 'working';
  launch();
  assert.ok(!('sentry' in read(file).mcpServers));
  assert.equal(W.timers.length, 1, 'and looks again shortly');
  await W.timers.shift()();
  assert.ok(!('sentry' in read(file).mcpServers), 'still at work: still waiting');
  assert.deepEqual(W.stopped, [], 'a chat at work is never stopped for this');
  assert.equal(W.timers.length, 1);
  // The chat finishes and sits idle: the idle chat is stopped (it starts again on its next message, with the new
  // connector), and the config is written.
  W.uses[W.id] = 'idle';
  await W.timers.shift()();
  assert.deepEqual(W.stopped, [W.id]);
  assert.ok('sentry' in read(file).mcpServers);
  assert.equal(W.timers.length, 0, 'nothing left to wait for');

  // syncAll (after a connector was added or removed in Settings) does the same without waiting for a launch.
  addConnector('figma');
  s = baseStamp();
  W.uses[W.id] = 'idle';
  await W.folders.syncAll();
  assert.ok('figma' in read(file).mcpServers);
  assert.deepEqual(W.stopped, [W.id, W.id]);
  assert.equal(baseStamp(), s);
  // An `inUse` that breaks is taken as "something is running".
  const broken = await withAccount({ inUse: () => { throw new Error('x'); } });
  const c = read(broken.baseConfig); c.mcpServers.late = { command: 'x' }; json(broken.baseConfig, c);
  broken.reg.envFor('claude', { account: broken.id });
  assert.ok(!('late' in read(path.join(broken.dir, '.claude.json')).mcpServers));
});

// ---- removing ----

test('removing an account: its idle chats stop, Claude Code signs that folder out, the folder goes, the account goes', { skip: missing, timeout: 60000 }, async () => {
  const W = await withAccount();
  assert.equal(W.reg.setActive('claude', W.id).ok, true);
  put(path.join(W.outside, 'canary.txt'), 'still here');
  fs.symlinkSync(path.join(W.outside, 'canary.txt'), path.join(W.dir, 'planted-link'));
  put(path.join(W.dir, 'sessions', '1.json'), '{}');
  const base = snapshot(W.base), outside = snapshot(W.outside);
  W.uses[W.id] = 'idle';
  const before = W.ran().length;

  const r = await W.folders.remove(W.id);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(W.stopped, [W.id], 'idle chats on it were stopped first');
  const ran = W.ran().slice(before);
  assert.deepEqual(ran, [`auth logout | ${W.dir}`, `auth status | ${W.dir}`], 'signed out in its own folder, then checked');
  neverSignedOutTheUser(W);
  assert.equal(fs.lstatSync(W.dir, { throwIfNoEntry: false }), undefined);
  assert.deepEqual(names(W.root), []);
  assert.deepEqual(W.reg.view().list.map((a) => a.id), ['claude-default']);
  assert.equal(W.reg.pin('claude'), null, 'new chats go back to the login Claude Code finds');
  assert.deepEqual(W.reg.envFor('claude'), { ...W.env });
  // A chat still open on the removed account refuses its next start instead of moving to another login.
  refusedWith(() => W.reg.envFor('claude', { account: W.id }), 'account-missing');
  // What the folder pointed at is untouched: the user's chats and settings, and the canary.
  assert.deepEqual(snapshot(W.base), base);
  assert.deepEqual(snapshot(W.outside), outside);
  assert.deepEqual(W.state.accounts.list.map((a) => a.id), ['claude-default'], 'and the saved list no longer has it');
});

test('an account is not removed from under a chat at work, and only accounts Canopy keeps a folder for are removed here', { skip: missing, timeout: 60000 }, async () => {
  const W = await withAccount();
  const before = snapshot(W.w), asked = W.ran().length;
  W.uses[W.id] = 'working';
  let r = await W.folders.remove(W.id);
  assert.deepEqual([r.ok, r.code], [false, 'working']);
  assert.equal(r.message, 'A chat is still working on Max. Remove it when the chat is done.');
  assert.deepEqual(W.stopped, []);
  // A chat that started working while the idle ones were being stopped.
  W.uses[W.id] = 'idle';
  const orig = W.folders.stopIdleFn;
  W.folders.stopIdleFn = async (id) => { W.uses[id] = 'working'; };
  r = await W.folders.remove(W.id);
  assert.equal(r.code, 'working');
  W.folders.stopIdleFn = orig;
  // The login Claude Code holds itself, an account that is not there, junk.
  for (const id of ['claude-default', 'claude-env', 'claude-00000000', '', null, undefined, {}]) {
    r = await W.folders.remove(id);
    assert.deepEqual([r.ok, r.code], [false, 'not-a-folder-account'], String(id));
  }
  assert.deepEqual(snapshot(W.w), before, 'nothing was deleted');
  assert.equal(W.ran().length, asked, 'and nothing was run');
  assert.equal(W.entry(W.id).state, 'ok');
  assert.equal(W.reg.envFor('claude', { account: W.id }).CLAUDE_CONFIG_DIR, W.dir, 'the account still launches');
});

test('if Claude Code cannot sign the folder out, the account and its folder stay, and nothing launches on it meanwhile', { skip: missing, timeout: 60000 }, async () => {
  const W = await withAccount();
  put(path.join(W.dir, '.stuck'), ''); // the stand-in's sign-out fails for this folder
  let meanwhile = null;
  const real = W.folders.signOutFn;
  // While it is on its way out: a chat tries to start on it, Settings re-checks every account, and a repair runs.
  W.folders.signOutFn = async (o) => {
    try { W.reg.envFor('claude', { account: W.id }); meanwhile = 'launched'; } catch (e) { meanwhile = e.code; }
    await W.reg.refresh();
    await W.folders.repair();
    return real(o);
  };
  const before = snapshot(W.dir);
  const r = await W.folders.remove(W.id);
  assert.deepEqual([r.ok, r.code], [false, 'still-signed-in']);
  assert.equal(r.message, 'Claude Code could not sign Max out, so it was kept. Try again.');
  assert.equal(meanwhile, 'account-missing', 'while it is on its way out, no chat starts on it');
  assert.deepEqual(snapshot(W.dir), before, 'a folder that still holds a login is not deleted from under it');
  assert.deepEqual([W.entry(W.id).state, W.entry(W.id).why], ['ok', null], 'and the checks that ran meanwhile marked nothing');
  assert.equal(W.reg.envFor('claude', { account: W.id }).CLAUDE_CONFIG_DIR, W.dir, 'and afterwards it works as before');
  neverSignedOutTheUser(W);
  // Sign-out works again: the second try removes it.
  fs.unlinkSync(path.join(W.dir, '.stuck'));
  assert.deepEqual(await W.folders.remove(W.id), { ok: true });
  assert.deepEqual(names(W.root), []);
});

test('the sign-out is Claude Code’s own, and is never run without the account’s folder named', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  const dir = path.join(W.root, 'claude-a1b2c3d4');
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...W.env, CLAUDE_CONFIG_DIR: dir };
  // No folder named, a different folder named, the user's own folder, junk: nothing is run.
  const { CLAUDE_CONFIG_DIR: _own, ...bare } = W.env;
  for (const o of [{ claudePath: W.tool.path, env: bare, dir }, { claudePath: W.tool.path, env: W.env, dir }, { claudePath: W.tool.path, env, dir: W.base },
    { claudePath: W.tool.path, env: { ...env, CLAUDE_CONFIG_DIR: '' }, dir }, { claudePath: 'claude', env, dir }, { claudePath: W.tool.path, env: null, dir }, { claudePath: W.tool.path, env, dir: 'relative' }, {}, undefined]) {
    assert.deepEqual(await F.runSignOut(o), { ok: false });
  }
  assert.deepEqual(W.ran(), [], 'Claude Code was not started once');
  // With the folder named, it is `claude auth logout`, in that folder's environment.
  assert.deepEqual(await F.runSignOut({ claudePath: W.tool.path, env, dir }), { ok: true });
  assert.deepEqual(W.ran(), [`auth logout | ${dir}`]);
  put(path.join(dir, '.stuck'), '');
  assert.deepEqual(await F.runSignOut({ claudePath: W.tool.path, env, dir }), { ok: false }, 'a failed run says so');
  assert.deepEqual(await F.runSignOut({ claudePath: path.join(W.w, 'no-such-claude'), env, dir }), { ok: false });
  neverSignedOutTheUser(W);
});

// ---- keeping in order ----

test('at start and after each Claude Code update, every account folder is looked over', { skip: missing, timeout: 60000 }, async () => {
  const W = await withAccount();
  const second = await (async () => { W.login.who = WORK.replace('work@', 'other@'); const r = await W.folders.add(); return { id: r.id, dir: W.entry(r.id).dir }; })();
  const file = path.join(W.dir, '.claude.json');
  // Since Canopy last ran: a link was lost, the user added a connector, and the second account was signed out elsewhere.
  fs.unlinkSync(path.join(W.dir, 'agents'));
  const c = read(W.baseConfig); c.mcpServers.linear = { command: 'x' }; json(W.baseConfig, c);
  fs.unlinkSync(path.join(second.dir, '.who'));
  const before = W.ran().length;

  // Upkeep reports Claude Code's version when it starts: that is the first look.
  W.folders.onClaudeVersion('2.1.325');
  await W.folders.repairs;
  assert.ok(isLinkTo(path.join(W.dir, 'agents'), path.join(W.base, 'agents')));
  assert.ok('linear' in read(file).mcpServers);
  assert.deepEqual([W.row(W.id).state, W.row(second.id).state], ['ok', 'signed-out'], 'the one whose sign-in is gone needs attention');
  assert.ok(W.logs.some((l) => l.includes(`${W.id}: agents needed putting back (start)`)));
  assert.deepEqual(W.ran().slice(before), [`auth status | ${W.dir}`, `auth status | ${second.dir}`], 'each asked about once, in its own folder');
  refusedWith(() => W.reg.envFor('claude', { account: second.id }), 'account-signed-out');

  // The same version again is not a reason to look again; a new one (an update) is.
  W.folders.onClaudeVersion('2.1.325');
  for (const junk of [null, undefined, '', 7]) W.folders.onClaudeVersion(junk);
  await W.folders.repairs;
  assert.equal(W.ran().length, before + 2);
  put(path.join(second.dir, '.who'), WORK.replace('work@', 'other@')); // signed in again meanwhile
  fs.rmSync(W.dir, { recursive: true });                               // and the first one's folder is gone
  W.folders.onClaudeVersion('2.1.326');
  await W.folders.repairs;
  assert.deepEqual([W.row(W.id).state, W.row(second.id).state], ['missing', 'ok']);
  assert.equal(W.ran().length, before + 3, 'a folder that is not there is not asked about');
  neverSignedOutTheUser(W);
  assert.ok(!W.ran().some((l) => l.startsWith('auth logout')), 'looking never signs anything out');
});

test('what changed in Claude Code is written down: new entries in its folder, and a sign-in check that says less', { skip: missing, timeout: 60000 }, async () => {
  // With no account folders there is nothing to look over, whatever the user keeps in their Claude Code folder.
  const none = world();
  await none.reg.refresh();
  put(path.join(none.base, 'brand-new-thing', 'x'), '');
  const asked = none.ran().length;
  assert.deepEqual(await none.folders.repair(), { checked: 0 });
  assert.deepEqual([none.drifts, none.ran().length], [[], asked]);

  const full = (env) => ({ loggedIn: true, method: 'claude.ai', provider: 'firstParty', email: 'work@example.com', org: 'Work', orgId: 'o-work', subscriptionType: 'max', configDir: env.CLAUDE_CONFIG_DIR });
  let answer = full;
  const W = await withAccount({ ask: async (_bin, env) => answer(env) });
  assert.deepEqual(W.drifts, [], 'a full answer and a folder Canopy knows: nothing to write down');
  fs.mkdirSync(path.join(W.base, 'brand-new-thing'));
  put(path.join(W.base, 'another-new-file.json'), '{}');
  assert.deepEqual(await W.folders.repair(), { checked: 1 });
  assert.deepEqual(W.drifts, [['accounts: something new in Claude Code’s folder', ['another-new-file.json', 'brand-new-thing']]]);
  assert.equal(W.row(W.id).state, 'ok');

  // A newer Claude Code stops saying which folder it answered for: the account can no longer be told to be the
  // right one, so it needs attention, and the missing field is on record.
  W.drifts.length = 0;
  answer = (env) => ({ ...full(env), configDir: null, orgId: null });
  await W.folders.repair('update');
  assert.deepEqual(W.drifts.at(-1), ['accounts: the sign-in check left something out', ['configDirectory', 'orgId']]);
  assert.deepEqual([W.row(W.id).state, W.entry(W.id).why], ['mismatch', 'Claude Code answered for a different folder']);
  // No answer at all is "could not check": nothing is marked and nothing is written down.
  fs.rmSync(path.join(W.base, 'brand-new-thing'), { recursive: true });
  fs.unlinkSync(path.join(W.base, 'another-new-file.json'));
  W.drifts.length = 0;
  answer = full;
  await W.folders.repair();
  assert.equal(W.row(W.id).state, 'ok');
  answer = () => ({ loggedIn: null, method: null, org: null, error: 'timed out' });
  await W.folders.repair();
  assert.deepEqual([W.row(W.id).state, W.drifts], ['ok', []]);
});

test('a repair marks a folder that cannot be put in order, and unmarks it once it can', { skip: missing, timeout: 60000 }, async () => {
  const W = await withAccount();
  fs.renameSync(path.join(W.base, 'projects'), path.join(W.outside, 'projects'));
  const asked = W.ran().length;
  await W.folders.repair();
  assert.deepEqual([W.row(W.id).state, W.row(W.id).why], ['blocked', 'Claude Code has no chat history yet. Start one chat on your main account first']);
  assert.equal(W.ran().length, asked, 'Claude Code is not asked about a folder that is not fit to launch on');
  refusedWith(() => W.reg.envFor('claude', { account: W.id }), 'account-blocked');
  // It is looked at again by itself, without Claude Code being run for it while nothing has changed.
  assert.equal(W.timers.length, 1);
  await W.timers.shift()();
  assert.equal(W.row(W.id).state, 'blocked');
  assert.equal(W.ran().length, asked);
  // The history is back (the user started a chat on their main account): the next look asks Claude Code, once,
  // and the account is usable again with nobody having opened Settings.
  fs.renameSync(path.join(W.outside, 'projects'), path.join(W.base, 'projects'));
  await W.timers.shift()();
  assert.deepEqual([W.row(W.id).state, W.row(W.id).why], ['ok', null]);
  assert.deepEqual(W.ran().slice(asked), [`auth status | ${W.dir}`]);
  assert.equal(W.reg.envFor('claude', { account: W.id }).CLAUDE_CONFIG_DIR, W.dir);
  assert.equal(W.timers.length, 0, 'and nothing is left to look at');
  await W.folders.repair();
  assert.deepEqual([W.row(W.id).state, W.row(W.id).why], ['ok', null]);
  // The registry's own check (opening the Claude Code page of Settings) goes through the same care of the folder.
  fs.unlinkSync(path.join(W.dir, 'commands'));
  await W.reg.refresh();
  assert.ok(isLinkTo(path.join(W.dir, 'commands'), path.join(W.base, 'commands')));
  // Runs do not overlap, and a run that breaks does not stop the next.
  const both = await Promise.all([W.folders.repair(), W.folders.repair()]);
  assert.deepEqual(both, [{ checked: 1 }, { checked: 1 }]);
  W.tool.env = null;
  assert.deepEqual(await W.folders.repair(), { checked: 0 });
});

// ---- the window's calls ----

test('the window gets two calls: add a sign-in, remove an account Canopy added', { skip: missing, timeout: 60000 }, async () => {
  const W = world();
  await W.reg.refresh();
  const channels = new Map();
  const folders = F.registerAccountFolders((channel, fn) => channels.set(channel, fn), {
    accounts: () => W.reg, root: W.root, claude: () => W.tool, signIn: W.folders.signIn, log: (m) => W.logs.push(m),
  });
  assert.ok(folders instanceof F.AccountFolders);
  assert.deepEqual([...channels.keys()].sort(), ['account-folders:add', 'account-folders:remove']);

  const added = await channels.get('account-folders:add')('plan');
  assert.equal(added.ok, true);
  // Anything that is not "console" is a plan sign-in: the window cannot ask for another kind of account here.
  W.login.who = WORK.replace('work@', 'second@');
  assert.equal((await channels.get('account-folders:add')({ kind: 'key', dir: '/etc' })).ok, true);
  assert.deepEqual(W.signIns.map((s) => s.console), [false, false]);
  assert.ok(W.signIns.every((s) => s.dir.startsWith(W.root + path.sep)), 'the folder is Canopy’s choice, never the window’s');
  // No answer carries a folder.
  const answers = [added, await channels.get('account-folders:remove')('claude-default'), await channels.get('account-folders:remove')({ id: added.id }), await channels.get('account-folders:remove')(added.id)];
  assert.deepEqual(answers.map((a) => [a.ok, a.code ?? null]), [[true, null], [false, 'not-a-folder-account'], [false, 'not-a-folder-account'], [true, null]]);
  assert.ok(!JSON.stringify(answers).includes(W.w), 'no path in any answer');
  neverSignedOutTheUser(W);
});

// ---- the registry's part ----

function fakeEngine() {
  return {
    ids: ['own'], base: () => ({ PATH: '/usr/bin' }), detect: async () => ({ known: true, accounts: [{ id: 'own', state: 'ok', kind: 'plan', email: 'me@example.com' }] }),
    launchEnv: (account, base) => ({ ...base, ...(account && { AS: account.id }) }), asFound: (list) => list.find((a) => a.id === 'own')?.id ?? null,
    label: (a) => (a.kind === 'plan' ? 'Max' : 'Account'), agrees: () => null,
  };
}

test('the registry: an account Canopy made can be added, updated from an answer and removed; one the tool holds cannot', { skip: missing }, async () => {
  const saves = [], changes = [];
  let clock = 5_000;
  const reg = new A.Accounts({ engines: { claude: fakeEngine() }, save: (s) => saves.push(JSON.parse(JSON.stringify(s))), onChange: (v) => changes.push(v), now: () => clock });
  await reg.refresh();

  const made = { id: 'claude-a1b2c3d4', engine: 'claude', kind: 'plan', dir: '/tmp/accounts/claude-a1b2c3d4', state: 'signed-out', secret: 'never saved', lastOkAt: 1, addedAt: 1 };
  // One `add` for everything Canopy keeps itself (a pasted key's side of it: accounts-added.test.mjs). A sign-in is
  // listed, signed out, from the moment its folder exists.
  assert.deepEqual(reg.add(made), { ok: true, id: made.id });
  const saved = saves.at(-1).list.find((a) => a.id === made.id);
  assert.deepEqual([saved.dir, saved.state, saved.addedAt, saved.lastOkAt], [made.dir, 'signed-out', 5_000, null]);
  assert.ok(!('secret' in saved), 'only the listed fields are ever saved');
  assert.deepEqual(changes.at(-1).list.map((a) => [a.id, a.found]), [['own', true], [made.id, false]]);
  assert.ok(!JSON.stringify(changes.at(-1)).includes('/tmp/accounts'), 'the window is not told the folder');
  assert.equal(reg.entries('claude').find((a) => a.id === made.id).dir, made.dir, 'the host is');
  reg.entries('claude')[0].email = 'changed'; // copies: changing one changes nothing
  assert.equal(reg.entries('claude')[0].email, 'me@example.com');
  assert.deepEqual(reg.entries('codex'), []);

  // Not twice, not under an id the tool owns, not without a folder of its own (that would be the tool's own login
  // under a second name), not for an engine there is none of, not junk.
  for (const [raw, code] of [[made, 'invalid-account'], [{ ...made, id: 'own' }, 'invalid-account'], [{ ...made, id: 'z', dir: null }, 'invalid-account'], [{ ...made, id: 'x', engine: 'codex' }, 'unknown-engine'],
    [{ ...made, id: 'y', kind: 'nonsense' }, 'invalid-account'], [null, 'unknown-engine'], ['x', 'unknown-engine'], [{}, 'unknown-engine']]) {
    assert.deepEqual([reg.add(raw).ok, reg.add(raw).code], [false, code], JSON.stringify(raw));
  }
  assert.equal(reg.view().list.length, 2);
  // Only a sign-in can start out signed out: a key that has not been checked is simply not known yet.
  assert.equal(reg.add({ id: 'k1', engine: 'claude', kind: 'key', keyHint: 'abcd', state: 'signed-out' }).ok, true);
  assert.equal(reg.entries('claude').find((a) => a.id === 'k1').state, 'unknown');
  assert.deepEqual(reg.remove('claude', 'k1'), { ok: true, wasActive: false });

  // An answer about it: who it is arrives with "ok"; anything else only changes how it is doing.
  clock = 9_000;
  reg.note(made.id, { state: 'ok', kind: 'console', email: 'work@example.com', org: 'Work', orgId: 'o2', plan: null });
  let a = reg.entries('claude').find((x) => x.id === made.id);
  assert.deepEqual([a.state, a.kind, a.email, a.orgId, a.lastOkAt], ['ok', 'console', 'work@example.com', 'o2', 9_000]);
  reg.note(made.id, { state: 'blocked', why: 'its folder could not be set up' });
  a = reg.entries('claude').find((x) => x.id === made.id);
  assert.deepEqual([a.state, a.why, a.email], ['blocked', 'its folder could not be set up', 'work@example.com']);
  // "Could not check" changes nothing, and neither does junk or an account that is not there.
  const before = JSON.stringify(reg.entries('claude'));
  for (const junk of [{ state: 'unknown' }, { state: 'checking' }, { state: 'nonsense' }, null, 'ok', {}]) reg.note(made.id, junk);
  reg.note('not-there', { state: 'ok' });
  assert.equal(JSON.stringify(reg.entries('claude')), before);

  // Removing: the chosen account going means new chats use the login the tool finds; an open chat on it refuses.
  assert.equal(reg.setActive('claude', made.id).ok, true);
  assert.deepEqual(reg.remove('claude', made.id), { ok: true, wasActive: true });
  assert.equal(reg.pin('claude'), null);
  assert.deepEqual(saves.at(-1).list.map((x) => x.id), ['own']);
  assert.deepEqual(saves.at(-1).active, { claude: null, codex: null });
  assert.throws(() => reg.envFor('claude', { account: made.id }), (err) => err.code === 'account-missing');
  assert.deepEqual(reg.envFor('claude'), { PATH: '/usr/bin' });
  assert.deepEqual([reg.remove('claude', made.id).code, reg.remove('claude', 'own').code, reg.remove('claude', null).code, reg.remove('codex', 'own').code], ['account-missing', 'not-removable', 'account-missing', 'account-missing']);
  assert.equal(reg.view().list.length, 1, 'the login the tool holds is never removed here');
});

test('the Claude engine hands a sign-in’s own folder to the host before using it, and nothing else', { skip: missing, timeout: 60000 }, async () => {
  const folder = fs.mkdtempSync(path.join(tmp, 'engine-'));
  const base = { PATH: '/usr/bin:/bin', HOME: os.homedir(), CLAUDE_CONFIG_DIR: path.join(tmp, 'engine-base') };
  const seen = [];
  let refuse = null;
  const home = (account, env, opts) => { seen.push([account.id, env === base || env.PATH === base.PATH, opts?.name ?? null]); if (refuse) throw A.refuse('account-blocked', 'x', { why: refuse }); };
  const eng = C.claudeAccounts({ tool: () => ({ path: '/usr/bin/true', env: base }), home, ask: async (_p, env) => ({ loggedIn: true, method: 'claude.ai', provider: 'firstParty', email: 'w@example.com', configDir: env.CLAUDE_CONFIG_DIR }) });
  const acct = (over = {}) => ({ id: 'a', engine: 'claude', kind: 'plan', dir: null, email: null, ...over });

  // Only an account with a folder of its own; the login in Claude Code's folder, a key and the environment are not its business.
  for (const a of [null, acct(), acct({ kind: 'console' }), acct({ kind: 'external', via: 'bedrock' })]) eng.launchEnv(a, base);
  eng.launchEnv(acct({ kind: 'key' }), base, { key: 'sk-x' });
  assert.deepEqual(seen, []);
  assert.equal(eng.launchEnv(acct({ dir: folder }), base, { name: 'Max' }).CLAUDE_CONFIG_DIR, folder);
  assert.deepEqual(seen, [['a', true, 'Max']]);
  // A folder the host refuses is not launched on, and a check of it says why.
  refuse = 'its folder could not be set up';
  assert.throws(() => eng.launchEnv(acct({ dir: folder }), base), (err) => err.code === 'account-blocked');
  assert.deepEqual(await eng.verify(acct({ dir: folder })), { state: 'blocked', why: 'its folder could not be set up' });
  // A refusal that will pass by itself is "could not check", which marks nothing.
  const passing = C.claudeAccounts({ tool: () => ({ path: '/usr/bin/true', env: base }), home: () => { throw A.refuse('account-missing', 'x', { recoverable: true }); } });
  assert.deepEqual(await passing.verify(acct({ dir: folder })), { state: 'unknown' });
  assert.throws(() => passing.launchEnv(acct({ dir: folder }), base), (err) => err.code === 'account-missing', 'but it is still not launched on');
  refuse = null;
  assert.equal((await eng.verify(acct({ dir: folder }))).state, 'ok');
  // A folder that is not there is "missing" before the host is ever asked; without a host nothing changes.
  seen.length = 0;
  assert.deepEqual(await eng.verify(acct({ dir: path.join(folder, 'gone') })), { state: 'missing' });
  assert.deepEqual(seen, []);
  assert.deepEqual(C.launchEnv(acct({ dir: folder }), base), C.claudeAccounts({ tool: () => ({ path: null, env: base }) }).launchEnv(acct({ dir: folder }), base));
});

// ---- the rules, locked ----

test('the account-folder files hold no login and say nothing about what client this is', () => {
  const src = path.resolve(CORE, '..');
  for (const name of ['account-home.mjs', 'account-folders.mjs']) {
    const text = fs.readFileSync(path.join(src, name), 'utf8');
    // Where the tools keep tokens, and the config key that says who is signed in: never named, so never read.
    for (const re of [/credentials/i, /\bauth\.json\b/i, /oauth/i, /keychain/i, /find-generic-password|keytar/i, /accessToken|refreshToken|apiKey\b/]) assert.ok(!re.test(text), `${name} mentions ${re}`);
    assert.ok(!/CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK_CLIENT_APP|CLAUDECODE/.test(text), `${name} sets a client name`);
    assert.ok(!/auth['", ]+login/.test(text.replace(/`claude auth login`/g, '')), `${name} runs a sign-in itself`);
  }
  // Only account-folders.mjs runs Claude Code, and only to sign a named folder out.
  const home = fs.readFileSync(path.join(src, 'account-home.mjs'), 'utf8');
  assert.ok(!/child_process|execFile|spawn/.test(home), 'the folder file runs nothing');
  const folders = fs.readFileSync(path.join(src, 'account-folders.mjs'), 'utf8');
  assert.deepEqual(folders.match(/execFile\([^)]*\)/g)?.length, 1);
  assert.match(folders, /execFile\(claudePath, \['auth', 'logout'\]/);
});

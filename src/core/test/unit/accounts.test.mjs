// accounts.mjs: the registry of logins and `envFor`, the one builder every launch goes through.
// The engines here are fakes: no tool is asked anything and no login is involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const A = await core('accounts.mjs');
const missing = A.__missing ? `accounts.mjs: ${A.__missing}` : false;

const BASE = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/Users/someone', ANTHROPIC_API_KEY: 'sk-shell-key', CLAUDE_CODE_USE_BEDROCK: '1', MY_VAR: 'kept' });
const WHO = { kind: 'plan', via: null, email: 'me@example.com', org: 'Acme', orgId: 'org-1', plan: 'max' };

// A stand-in engine: one account it "finds" (`own`), a recipe that marks what it launched, and answers a test sets.
function engine(over = {}) {
  const e = {
    ids: ['own'], asked: 0, answer: { known: true, accounts: [{ id: 'own', state: 'ok', ...WHO }] }, env: { ...BASE },
    base() { return this.env; },
    async detect(hint) { this.asked += 1; this.hint = hint; return typeof this.answer === 'function' ? this.answer() : this.answer; },
    launchEnv(account, base, opts) { return account ? { ...base, LAUNCHED_AS: account.id, ...(opts?.key && { KEY: opts.key }) } : { ...base }; },
    asFound: (list) => list.find((a) => a.id === 'own')?.id ?? null,
    label: (a) => (a.kind === 'plan' ? 'Max' : 'Account'),
    agrees: (a, reported) => (reported.email ? reported.email === a.email : null),
    ...over,
  };
  return e;
}
function make(opts = {}) {
  const claude = opts.engine ?? engine();
  const saves = [], changes = [], logs = [];
  let clock = opts.at ?? 1_000_000;
  const reg = new A.Accounts({
    engines: { claude, ...(opts.codex && { codex: opts.codex }) }, load: () => opts.saved ?? null, save: (s) => saves.push(JSON.parse(JSON.stringify(s))),
    onChange: (v) => changes.push(v), log: (m) => logs.push(m), now: () => clock, keyFor: opts.keyFor,
  });
  return { reg, claude, saves, changes, logs, tick: (ms) => { clock += ms; } };
}
const entry = (over = {}) => ({ id: 'own', engine: 'claude', kind: 'plan', dir: null, label: null, ...WHO, keyHint: null, addedAt: 1, lastOkAt: 1, state: 'ok', why: null, ...over });
const refused = (fn, code) => assert.throws(fn, (err) => {
  assert.equal(err.code, code);
  assert.equal(err.canopy.code, code, 'Session reads the code from `canopy`');
  assert.equal(typeof err.canopy.message, 'string');
  return true;
});

// ---- launching ----

test('with nothing chosen, the launch environment is the base, key for key', { skip: missing }, () => {
  const { reg, claude } = make();
  const env = reg.envFor('claude');
  assert.deepEqual(env, BASE);
  assert.equal(JSON.stringify(env), JSON.stringify(BASE), 'same keys in the same order');
  assert.notEqual(env, claude.env, 'a copy: a caller adding TERM must not change the base');
  assert.deepEqual(reg.envFor('claude', { account: null }), BASE);
  assert.equal(reg.pin('claude'), null);
  const other = { PATH: '/x', ONLY: 'here' };
  assert.deepEqual(reg.envFor('claude', { base: other }), other, 'a caller may bring its own base');
});

test('envFor fails closed: it throws a coded error and never hands back another login', { skip: missing }, async () => {
  const { reg, claude } = make({ saved: { active: { claude: 'gone' }, list: [] } });
  refused(() => reg.envFor('codex'), 'unknown-engine');
  refused(() => reg.envFor('nonsense'), 'unknown-engine');
  refused(() => reg.envFor('claude'), 'account-missing');             // the choice points at an account that is not there
  refused(() => reg.envFor('claude', { account: 'nope' }), 'account-missing');
  claude.env = null;
  refused(() => reg.envFor('claude', { account: null }), 'no-env');   // the environment check has not finished
  claude.base = () => { throw new Error('boom'); };
  refused(() => reg.envFor('claude', { account: null }), 'no-env');
});

test('an account that is signed out, mismatched, missing, locked or blocked is never launched', { skip: missing }, () => {
  for (const state of ['signed-out', 'expired', 'mismatch', 'missing', 'locked', 'invalid-key', 'blocked']) {
    const { reg } = make({ saved: { active: { claude: 'own' }, list: [entry({ state, why: state === 'blocked' ? 'your settings choose the login' : null })] } });
    refused(() => reg.envFor('claude'), `account-${state}`);
    assert.match(String((() => { try { reg.envFor('claude'); } catch (e) { return e.message; } })()), /Max/, 'the message names the account');
    assert.deepEqual(reg.envFor('claude', { account: null }), BASE, 'a chat started with nothing chosen is not affected');
  }
  // "Could not check" is not "signed out": such an account still launches.
  const { reg } = make({ saved: { active: { claude: 'own' }, list: [entry({ state: 'unknown' })] } });
  assert.equal(reg.envFor('claude').LAUNCHED_AS, 'own');
});

test('a chat keeps the account it was started on, whatever is chosen later', { skip: missing }, async () => {
  const { reg } = make();
  await reg.refresh();
  const before = reg.pin('claude');                       // a chat opened now
  assert.equal(before, null);
  assert.deepEqual(reg.setActive('claude', 'own'), { ok: true });
  assert.equal(reg.pin('claude'), 'own');                 // a chat opened after the choice
  assert.deepEqual(reg.envFor('claude', { account: before }), BASE, 'the open chat still launches as before');
  assert.equal(reg.envFor('claude', { account: reg.pin('claude') }).LAUNCHED_AS, 'own');
  assert.equal(reg.envFor('claude').LAUNCHED_AS, 'own', 'with no account named, the one in use now');
  assert.equal(reg.setActive('claude', 'nope').ok, false);
  assert.equal(reg.setActive('codex', null).ok, false, 'an engine Canopy has no accounts for');
  assert.deepEqual(reg.setActive('claude', null), { ok: true });
  assert.deepEqual(reg.envFor('claude'), BASE);
});

// ---- finding out ----

test('resolve: the account a chat is really on, whether it was started on one or on whatever the tool finds', { skip: missing }, async () => {
  const { reg } = make({ saved: { active: {}, list: [entry(), entry({ id: 'added', email: 'second@example.com' })] } });
  assert.equal(reg.resolve('claude', 'added'), 'added', 'a chat keeps the account it was started on');
  assert.equal(reg.resolve('claude', null), 'own', 'nothing chosen: the one the tool finds');
  assert.equal(reg.resolve('claude', undefined), 'own');
  assert.equal(reg.resolve('claude', ''), 'own');
  // Choosing another account later does not move a chat that was started with nothing chosen.
  assert.deepEqual([reg.view().own.claude, reg.view().inUse.claude], ['own', 'own'], 'nothing chosen: new chats start on the one the tool finds');
  reg.setActive('claude', 'added');
  assert.deepEqual([reg.pin('claude'), reg.resolve('claude', null), reg.view().inUse.claude], ['added', 'own', 'added']);
  // The window is told both: where new chats start, and what a chat started with nothing chosen is still on.
  assert.deepEqual([reg.view().active.claude, reg.view().own.claude, reg.view().own.codex], ['added', 'own', null]);
  // Not known yet, or an engine Canopy has none of: null, never a guess and never a throw.
  assert.equal(make().reg.resolve('claude', null), null);
  assert.equal(reg.resolve('codex', null), null);
  assert.equal(make({ engine: engine({ asFound: () => { throw new Error('x'); } }) }).reg.resolve('claude', null), null);
});

test('refresh lists what the tool has, says which is in use, and saves it', { skip: missing }, async () => {
  const { reg, claude, saves, changes } = make();
  assert.deepEqual(reg.view().list, []);
  const view = await reg.refresh({ auth: { claude: { loggedIn: true } } });
  assert.deepEqual(claude.hint, { auth: { loggedIn: true } }, 'what the caller already knows is passed on');
  assert.deepEqual(view.list, [{ id: 'own', engine: 'claude', kind: 'plan', label: 'Max', email: 'me@example.com', org: 'Acme', plan: 'max', via: null, keyHint: null, state: 'ok', why: null, found: true }]);
  assert.deepEqual(view.active, { claude: null, codex: null });
  assert.deepEqual(view.inUse, { claude: 'own', codex: null });
  assert.equal(view.checking, false);
  assert.equal(saves.at(-1).list[0].orgId, 'org-1');
  assert.equal(saves.at(-1).list[0].lastOkAt, 1_000_000);
  assert.ok(changes.some((v) => v.checking === true) && changes.at(-1).checking === false, 'the window hears the check start and end');
  for (const v of [view, ...changes]) for (const a of v.list) assert.ok(!('dir' in a) && !('orgId' in a) && !('lastOkAt' in a), 'the window gets no folders or organisation ids');
});

test('signed out keeps who it was; could-not-say changes nothing; gone leaves the list', { skip: missing }, async () => {
  const { reg, claude } = make();
  await reg.refresh();
  claude.answer = { known: true, accounts: [{ id: 'own', state: 'signed-out' }] };
  let v = await reg.refresh();
  assert.deepEqual([v.list[0].state, v.list[0].email, v.list[0].label], ['signed-out', 'me@example.com', 'Max']);
  claude.answer = { known: false };
  v = await reg.refresh();
  assert.equal(v.list[0].state, 'signed-out', 'no answer is never read as an answer');
  claude.answer = { known: true, accounts: [{ id: 'own', state: 'unknown' }] };
  v = await reg.refresh();
  assert.equal(v.list[0].state, 'signed-out');
  claude.answer = { known: true, accounts: [{ id: 'own', state: 'ok', ...WHO, email: 'other@example.com' }] };
  v = await reg.refresh();
  assert.deepEqual([v.list[0].state, v.list[0].email], ['ok', 'other@example.com'], 'signed in again, as someone else');
  claude.answer = { known: true, accounts: [] };
  v = await reg.refresh();
  assert.deepEqual(v.list, []);
  assert.equal(v.inUse.claude, null);
});

test('a login that was never there is not listed as signed out, and an engine speaks only for its own accounts', { skip: missing }, async () => {
  const { reg, claude } = make();
  claude.answer = { known: true, accounts: [{ id: 'own', state: 'signed-out' }, { id: 'someone-elses', state: 'ok', ...WHO }] };
  assert.deepEqual((await reg.refresh()).list, []);
  claude.answer = () => { throw new Error('the tool crashed'); };
  assert.deepEqual((await reg.refresh()).list, [], 'a failing engine is survived');
});

test('the chosen account is never dropped: gone means signed out, and its chats refuse to start', { skip: missing }, async () => {
  const { reg, claude } = make();
  await reg.refresh();
  reg.setActive('claude', 'own');
  claude.answer = { known: true, accounts: [] };
  const v = await reg.refresh();
  assert.deepEqual([v.list.length, v.list[0].state], [1, 'signed-out']);
  refused(() => reg.envFor('claude'), 'account-signed-out');
});

test('refreshes run one at a time, and a recent check is not repeated for a page that reopens', { skip: missing }, async () => {
  const { reg, claude, tick } = make();
  let running = 0, most = 0;
  claude.answer = async () => { running += 1; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); running -= 1; return { known: true, accounts: [{ id: 'own', state: 'ok', ...WHO }] }; };
  await Promise.all([reg.refresh(), reg.refresh(), reg.refresh()]);
  assert.deepEqual([claude.asked, most], [3, 1]);
  await reg.refresh({ maxAgeMs: 15_000 });
  assert.equal(claude.asked, 3, 'checked a moment ago');
  tick(20_000);
  await reg.refresh({ maxAgeMs: 15_000 });
  assert.equal(claude.asked, 4);
  claude.answer = { known: false };
  await reg.refresh();
  await reg.refresh({ maxAgeMs: 15_000 });
  assert.equal(claude.asked, 6, 'a tool that did not answer is asked again, however recent the last try');
});

test('accounts added in Canopy are asked about one by one', { skip: missing }, async () => {
  const asked = [];
  const claude = engine({ verify: async (a) => { asked.push(a.id); return a.id === 'extra' ? { state: 'mismatch', why: 'a different account is signed in there' } : { state: 'unknown' }; } });
  const { reg } = make({ engine: claude, saved: { active: {}, list: [entry(), entry({ id: 'extra', dir: '/accounts/extra' }), entry({ id: 'extra-2', dir: '/accounts/extra-2' })] } });
  const v = await reg.refresh();
  assert.deepEqual(asked, ['extra', 'extra-2'], 'never the ones the tool itself holds');
  assert.deepEqual(v.list.map((a) => [a.id, a.state, a.found]), [['own', 'ok', true], ['extra', 'mismatch', false], ['extra-2', 'ok', false]]);
});

// ---- what a chat's process reports ----

test('a chat start that reports the expected account confirms it; one that cannot be told changes nothing', { skip: missing }, async () => {
  const { reg, claude, saves, tick } = make();
  claude.answer = { known: true, accounts: [{ id: 'own', state: 'ok', ...WHO }] };
  await reg.refresh();
  claude.answer = { known: true, accounts: [{ id: 'own', state: 'signed-out' }] };
  await reg.refresh();
  const asked = claude.asked;
  reg.reported('claude', null, { email: 'me@example.com' });
  assert.equal(reg.view().list[0].state, 'ok', 'Claude Code just started on it');
  const n = saves.length;
  reg.reported('claude', null, { email: 'me@example.com' });
  assert.equal(saves.length, n, 'a second start a moment later is not written down again');
  tick(11 * 60_000);
  reg.reported('claude', null, { email: 'me@example.com' });
  assert.equal(saves.length, n + 1);
  reg.reported('claude', null, { email: null });
  reg.reported('claude', null, null);
  reg.reported('nonsense', null, { email: 'x' });
  assert.equal(claude.asked, asked, 'nothing here asks the tool');
});

test('with nothing chosen, a surprising report makes Canopy ask again instead of flagging anything', { skip: missing }, async () => {
  const { reg, claude } = make();
  await reg.refresh();
  claude.answer = { known: true, accounts: [{ id: 'own', state: 'ok', ...WHO, email: 'new@example.com' }] };
  reg.reported('claude', null, { email: 'new@example.com' });        // signed in as someone else in Terminal since
  reg.reported('claude', null, { email: 'new@example.com' });        // a second chat a moment later
  const v = await reg.refresh({ maxAgeMs: 60_000 });
  assert.deepEqual([v.list[0].state, v.list[0].email], ['ok', 'new@example.com']);
  assert.equal(claude.asked, 2, 'asked once more, not once per chat');
});

test('a chosen account that reports another login is marked, and no further chat starts on it', { skip: missing }, async () => {
  const { reg } = make();
  await reg.refresh();
  reg.setActive('claude', 'own');
  reg.reported('claude', 'own', { email: 'someone-else@example.com' });
  assert.equal(reg.view().list[0].state, 'mismatch');
  refused(() => reg.envFor('claude'), 'account-mismatch');
  reg.reported('claude', 'own', { email: 'me@example.com' });
  assert.equal(reg.view().list[0].state, 'ok');
  assert.doesNotThrow(() => reg.reported('claude', 'not-in-the-list', { email: 'x' }));
});

// ---- nothing secret is kept ----

test('only known fields are read back or written: nothing secret can ride along in state.json', { skip: missing }, async () => {
  const saved = {
    v: 1, active: { claude: 7, codex: { id: 'x' } }, token: 'sk-ant-oat01-SECRET',
    list: [
      entry({ accessToken: 'sk-ant-oat01-SECRET', key: 'sk-ant-api03-SECRET', keyHint: 'sk-ant-api03-SECRET', oauth: { refreshToken: 'SECRET' } }),
      entry({ id: 'own' }),                                  // the same id twice
      entry({ id: 'k', kind: 'key', keyHint: '4f2a' }),
      { id: 'bad-engine', engine: 'gemini', kind: 'plan' }, { id: 'bad-kind', engine: 'claude', kind: 'cookie' }, null, 'junk',
      entry({ id: 'rel', dir: 'relative/folder', state: 'checking' }),
    ],
  };
  const { reg, saves } = make({ saved });
  assert.deepEqual(reg.view().active, { claude: null, codex: null }, 'a choice that is not an id is no choice');
  assert.deepEqual(reg.view().list.map((a) => [a.id, a.keyHint, a.state]), [['own', null, 'ok'], ['k', '4f2a', 'ok'], ['rel', null, 'unknown']]);
  reg.setActive('claude', 'k');
  const text = JSON.stringify(saves.at(-1)) + JSON.stringify(reg.view());
  assert.ok(!text.includes('SECRET'), 'no token, key or unknown field survives a load and a save');
  assert.deepEqual(Object.keys(saves.at(-1)).sort(), ['active', 'list', 'v']);
  assert.deepEqual(Object.keys(saves.at(-1).list[0]).sort(), ['addedAt', 'dir', 'email', 'engine', 'id', 'keyHint', 'kind', 'label', 'lastOkAt', 'org', 'orgId', 'plan', 'state', 'via', 'why']);
  assert.equal(saves.at(-1).list.find((a) => a.id === 'rel').dir, null);
});

test('a pasted key reaches the launch and nothing else: not the saved state, the window, or the log', { skip: missing }, async () => {
  const KEY = 'sk-ant-api03-ONLY-IN-THE-LAUNCH';
  const { reg, saves, changes, logs } = make({ saved: { active: { claude: 'k' }, list: [entry({ id: 'k', kind: 'key', keyHint: 'UNCH' })] }, keyFor: (a) => (a.id === 'k' ? KEY : null) });
  assert.equal(reg.envFor('claude').KEY, KEY);
  await reg.refresh();
  reg.setActive('claude', null);
  reg.setActive('claude', 'k');
  assert.ok(saves.length && changes.length);
  assert.ok(!(JSON.stringify(saves) + JSON.stringify(changes) + JSON.stringify(reg.view()) + logs.join('\n')).includes(KEY));
});

test('the saved registry is read on first use, and an unreadable one starts with nothing chosen', { skip: missing }, () => {
  let reads = 0;
  const reg = new A.Accounts({ engines: { claude: engine() }, load: () => { reads += 1; throw new Error('disk'); } });
  assert.equal(reads, 0, 'building it reads nothing');
  assert.deepEqual(reg.view(), { active: { claude: null, codex: null }, inUse: { claude: null, codex: null }, own: { claude: null, codex: null }, checking: false, list: [] });
  reg.view();
  assert.equal(reads, 1);
  for (const junk of [null, 7, 'x', [], { list: 'x', active: 'y' }]) assert.deepEqual(new A.Accounts({ engines: { claude: engine() }, load: () => junk }).view().list, []);
  assert.doesNotThrow(() => new A.Accounts().view());
});

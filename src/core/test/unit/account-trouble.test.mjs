// The window's rules about a login that needs you (renderer/src/lib/account-rules.ts): which chats it holds up,
// what is said about it, what its one button does, and when a "Sign in…" button belongs on a notice. Then the
// transcript's store (renderer/src/lib/store.ts): a turn that could not sign in becomes one quiet line with that
// button, live and from a saved chat, and a chat knows which account it is on. Then the window's side of a sign-in
// (renderer/src/lib/signin.ts). What an account's row in Settings offers is in account-rules.test.mjs.
//
// The rules file is plain TypeScript with no run-time imports, so node runs it as it is. The store is the real one;
// the few things it expects from a window are stood in for, as in store-edit.test.mjs.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';
import * as R from '../../../../renderer/src/lib/account-rules.ts';

const acct = (over = {}) => ({ id: 'claude-default', engine: 'claude', kind: 'plan', label: 'Max', email: 'me@example.com', org: null, plan: 'max', via: null, keyHint: null, state: 'ok', why: null, found: true, ...over });
const list = (accounts, inUse = {}) => ({ active: { claude: null, codex: null }, inUse: { claude: accounts.find((a) => a.engine === 'claude')?.id ?? null, codex: accounts.find((a) => a.engine === 'codex')?.id ?? null, ...inUse }, checking: false, list: accounts });
// The same once an account has been chosen for new chats: `own` is still the login the tool finds on its own.
const chosen = (accounts, active, own) => ({ ...list(accounts, { claude: active }), active: { claude: active, codex: null }, own: { claude: own, codex: null } });

// ---- what holds a maker's chats up ----

test('a signed-out login holds its maker’s chats up; "could not check" never does', () => {
  const t = R.troubleFor(list([acct({ state: 'signed-out' })]), 'claude');
  assert.deepEqual([t.engine, t.account.id, t.fix, t.line, t.other], ['claude', 'claude-default', 'sign-in', 'Claude is signed out.', null]);
  assert.equal(R.troubleFor(list([acct({ state: 'expired' })]), 'claude').line, 'Claude is signed out.');
  assert.deepEqual([R.troubleFor(list([acct({ state: 'mismatch' })]), 'claude').line, R.troubleFor(list([acct({ state: 'mismatch' })]), 'claude').fix], ['Claude is using a different login.', 'sign-in']);
  assert.equal(R.troubleFor(list([acct({ kind: 'console', label: 'Console', state: 'signed-out' })]), 'claude').fix, 'sign-in');

  for (const state of ['ok', 'unknown', 'checking']) assert.equal(R.troubleFor(list([acct({ state })]), 'claude'), null, state);
  for (const nothing of [null, undefined, {}, { list: 'x' }, list([])]) assert.equal(R.troubleFor(nothing, 'claude'), null);
  // The account in use is what counts: another one being signed out holds nothing up.
  const two = list([acct({ id: 'claude-env', kind: 'external', label: 'API key', via: 'ANTHROPIC_API_KEY' }), acct({ state: 'signed-out' })]);
  assert.equal(R.troubleFor(two, 'claude'), null);
  assert.equal(R.troubleFor(two, 'claude', 'claude-default').line, 'Claude is signed out.', 'unless the chat is on that very account');
  assert.equal(R.troubleFor(two, 'claude', 'not-listed'), null);
});

test('a chat is held up by the account it is on, not by the one new chats start on', () => {
  // You chose the key for new chats; the login Claude Code holds itself is signed out.
  const key = acct({ id: 'claude-key-1', kind: 'key', label: 'API key ••••4f2a', found: false });
  const state = chosen([acct({ state: 'signed-out' }), key], 'claude-key-1', 'claude-default');
  assert.equal(R.troubleFor(state, 'claude'), null, 'a new chat starts on the key: nothing holds it up');
  assert.equal(R.troubleFor(state, 'claude', 'claude-key-1'), null, 'nor a chat that is on the key');
  // A chat started before the choice, with nothing chosen, is still on the login the tool finds on its own.
  const old = R.troubleFor(state, 'claude', null);
  assert.deepEqual([old.account.id, old.fix, old.line, old.other.id], ['claude-default', 'sign-in', 'Claude is signed out.', 'claude-key-1']);
  assert.equal(R.troubleFor(state, 'claude', 'claude-default').account.id, 'claude-default', 'and so is one started on that login by name');
  // The other way round: the key no longer works, and a chat on the tool's own login carries on.
  const broken = chosen([acct(), { ...key, state: 'invalid-key' }], 'claude-key-1', 'claude-default');
  assert.deepEqual([R.troubleFor(broken, 'claude').fix, R.troubleFor(broken, 'claude', null)], ['settings', null]);

  // Which account that is. Not told yet (a chat still opening): as for a new chat.
  assert.deepEqual([R.chatAccount(state, 'claude')?.id, R.chatAccount(state, 'claude', undefined)?.id], ['claude-key-1', 'claude-key-1']);
  assert.deepEqual([R.chatAccount(state, 'claude', null)?.id, R.chatAccount(state, 'claude', 'claude-default')?.id], ['claude-default', 'claude-default']);
  // Nothing the tool finds on its own, an account that is not listed, another maker's, no list at all: no account, never a guess.
  assert.equal(R.chatAccount(chosen([key], 'claude-key-1', null), 'claude', null), null);
  assert.equal(R.chatAccount(list([key]), 'claude', null), null, 'a list that does not say what the tool finds');
  for (const [s, engine, pin] of [[state, 'claude', 'gone'], [state, 'codex', 'claude-default'], [state, 'codex', null], [null, 'claude', null], [{}, 'claude', 'claude-default']]) assert.equal(R.chatAccount(s, engine, pin), null);
  // With nothing chosen the two are the same account, so every chat agrees.
  const plain = { ...list([acct({ state: 'signed-out' })]), own: { claude: 'claude-default', codex: null } };
  assert.deepEqual([R.troubleFor(plain, 'claude').account.id, R.troubleFor(plain, 'claude', null).account.id], ['claude-default', 'claude-default']);
});

test('what signing in cannot fix points at Settings, with its own words', () => {
  const of = (over) => R.troubleFor(list([acct(over)]), 'claude');
  const table = [
    [{ kind: 'key', label: 'API key ••••4f2a', state: 'invalid-key' }, 'The key for API key ••••4f2a no longer works.'],
    [{ kind: 'key', label: 'Work key', state: 'locked' }, 'The key for Work key couldn’t be read from the Keychain.'],
    [{ label: 'Second plan', state: 'missing' }, 'The folder for Second plan is missing.'],
    [{ state: 'blocked', why: 'your Claude Code settings choose the login' }, 'Max can’t be used: your Claude Code settings choose the login.'],
    [{ state: 'blocked' }, 'Max can’t be used: your settings choose the login.'],
    // Signed out, but not a sign-in Claude Code keeps: there is nothing for its sign-in to do.
    [{ kind: 'external', label: 'API key', via: 'ANTHROPIC_API_KEY', state: 'signed-out' }, 'Claude is signed out.'],
  ];
  for (const [over, line] of table) assert.deepEqual([of(over).fix, of(over).line], ['settings', line]);
  for (const [a, yes] of [[acct({ state: 'signed-out' }), true], [acct({ state: 'mismatch', kind: 'console' }), true], [acct({ state: 'ok' }), false], [acct({ state: 'missing' }), false],
    [acct({ state: 'signed-out', kind: 'key' }), false], [acct({ state: 'signed-out', kind: 'external' }), false], [acct({ engine: 'codex', state: 'signed-out' }), false]]) {
    assert.equal(R.signsIn(a), yes, `${a.engine} ${a.kind} ${a.state}`);
  }
});

test('another account of the same maker that works is offered; OpenAI’s chats are left exactly as they were', () => {
  const state = list([
    acct({ id: 'extra', label: 'Max', state: 'signed-out' }), acct({ id: 'also-out', label: 'Pro', state: 'expired' }),
    acct({ id: 'claude-default', kind: 'console', label: 'Console' }), acct({ id: 'codex-default', engine: 'codex', label: 'ChatGPT Plus' }),
  ], { claude: 'extra' });
  assert.equal(R.troubleFor(state, 'claude').other.id, 'claude-default', 'the first one that works, never the other maker’s');
  assert.deepEqual(R.troubles(state).map((t) => [t.engine, t.account.id]), [['claude', 'extra']]);

  // A Codex chat is never held up, and Codex is not asked about at launch: its process can go on working when
  // Codex says otherwise, and a reply is what clears a login OpenAI once refused. Its sign-in is offered where its
  // account shows (codex-login-rules.test.mjs).
  for (const state of ['signed-out', 'expired', 'invalid-key']) {
    const openai = { ...list([acct({ id: 'codex-default', engine: 'codex', label: 'ChatGPT Plus', state })]), own: { claude: null, codex: 'codex-default' } };
    for (const pin of [undefined, null, 'codex-default']) assert.equal(R.troubleFor(openai, 'codex', pin), null, `${state} ${pin}`);
    assert.deepEqual(R.troubles(openai), []);
  }
  assert.deepEqual(R.HOLDS_CHATS, ['claude']);
});

test('a Codex chat on a key pasted into Canopy waits for that key, and only such a chat', () => {
  const own = acct({ id: 'codex-default', engine: 'codex', label: 'ChatGPT Plus' });
  const key = (state) => acct({ id: 'codex-key-1', engine: 'codex', kind: 'key', label: 'API key ••••7Hq2', email: null, plan: null, keyHint: '7Hq2', found: false, state });
  const state = (k, inUse) => ({ ...list([own, k], { codex: inUse }), active: { claude: null, codex: inUse === 'codex-default' ? null : inUse }, own: { claude: null, codex: 'codex-default' } });

  // The key is the account in use and OpenAI no longer takes it: new chats are held, and the prompt at launch asks.
  const broken = state(key('invalid-key'), 'codex-key-1');
  const t = R.troubleFor(broken, 'codex');
  assert.deepEqual([t.engine, t.account.id, t.fix, t.line, t.other.id], ['codex', 'codex-key-1', 'settings', 'The key for API key ••••7Hq2 no longer works.', 'codex-default']);
  assert.deepEqual(R.troubles(broken).map((x) => [x.engine, x.account.id]), [['codex', 'codex-key-1']]);
  assert.deepEqual(R.promptWords(t), {
    title: 'Codex needs attention', body: 'The key for API key ••••7Hq2 no longer works. Until then, Codex chats can’t send.', primary: 'Open Settings…', use: 'Use ChatGPT Plus',
  });
  assert.equal(R.troubleFor(state(key('locked'), 'codex-key-1'), 'codex').line, 'The key for API key ••••7Hq2 couldn’t be read from the Keychain.');
  // A chat goes by its own account: one on the key is held, one on Codex's login (main names no account for it) is not.
  assert.equal(R.troubleFor(broken, 'codex', 'codex-key-1').account.id, 'codex-key-1');
  assert.equal(R.troubleFor(broken, 'codex', null), null);
  // The key is merely listed, broken, while Codex's login is in use: nothing is held.
  const beside = state(key('invalid-key'), 'codex-default');
  assert.deepEqual([R.troubleFor(beside, 'codex'), R.troubles(beside)], [null, []]);
  assert.equal(R.troubleFor(beside, 'codex', 'codex-key-1').account.id, 'codex-key-1', 'but a chat that is on that key still waits for it');
  // "Could not check" holds nothing, and a key that works holds nothing.
  for (const s of ['ok', 'unknown', 'checking']) assert.equal(R.troubleFor(state(key(s), 'codex-key-1'), 'codex'), null, s);
  // Both makers at once: Claude is asked about first.
  const both = { ...broken, list: [acct({ state: 'signed-out' }), ...broken.list], inUse: { claude: 'claude-default', codex: 'codex-key-1' } };
  assert.deepEqual(R.troubles(both).map((x) => x.engine), ['claude', 'codex']);
});

test('a turn OpenAI refused on a pasted key says so about the key, with no button for Codex’s sign-in', () => {
  const refused = { kind: 'notice', level: 'warn', code: 'api-error', apiError: 'httpConnectionFailed', apiStatus: 401, text: 'Could not reach OpenAI. Check your connection and try again.' };
  // Main names a Codex chat's account only when it is a pasted key: such a chat ran on that key.
  assert.deepEqual(R.signInNotice(refused, 'codex', false, 'codex-key-1'), { text: 'OpenAI didn’t accept this chat’s API key.' });
  assert.deepEqual(R.signInNotice(refused, 'codex', true, 'codex-key-1'), { text: 'OpenAI didn’t accept this chat’s API key.' }, 'from a saved chat too');
  assert.equal(R.KEY_REFUSED, 'OpenAI didn’t accept this chat’s API key.');
  // On Codex's own login (no account named, or the window not told yet): as before, Codex's words and its sign-in.
  for (const pin of [null, undefined, '']) assert.deepEqual(R.signInNotice(refused, 'codex', false, pin), { text: refused.text, action: { label: 'Sign in to Codex', signIn: 'codex' } }, String(pin));
  // Anything that is not a refusal says nothing, whichever account.
  assert.equal(R.signInNotice({ ...refused, apiStatus: 500 }, 'codex', false, 'codex-key-1'), null);
  // A Claude chat's account never changes what is said there.
  const failed = { kind: 'notice', level: 'warn', code: 'api-error', apiError: 'authentication_failed', text: 'x' };
  assert.deepEqual(R.signInNotice(failed, 'claude', false, 'claude-key-1'), R.signInNotice(failed, 'claude'));
});

test('the prompt at launch: a title, one sentence, and buttons that fit', () => {
  const out = R.troubleFor(list([acct({ id: 'extra', state: 'signed-out' }), acct({ id: 'claude-default', kind: 'console', label: 'Console' })], { claude: 'extra' }), 'claude');
  assert.deepEqual(R.promptWords(out), { title: 'Claude is signed out', body: 'Your Max account needs signing in again. Until then, Claude chats can’t send.', primary: 'Sign in…', use: 'Use Console' });
  const alone = R.troubleFor(list([acct({ kind: 'console', label: 'Console', state: 'signed-out' })]), 'claude');
  assert.deepEqual(R.promptWords(alone), { title: 'Claude is signed out', body: 'Your Console account needs signing in again. Until then, Claude chats can’t send.', primary: 'Sign in…', use: null });
  assert.equal(R.promptWords(R.troubleFor(list([acct({ state: 'mismatch' })]), 'claude')).title, 'Claude is using a different login');
  const key = R.troubleFor(list([acct({ kind: 'key', label: 'API key', state: 'invalid-key' })]), 'claude');
  assert.deepEqual(R.promptWords(key), { title: 'Claude needs attention', body: 'The key for API key no longer works. Until then, Claude chats can’t send.', primary: 'Open Settings…', use: null });
});

// ---- notices in a chat ----

test('a turn that could not sign in becomes one line with a Sign in… button; nothing else does', () => {
  const button = { label: 'Sign in…', signIn: 'claude' };
  const failed = { kind: 'notice', code: 'api-error', apiError: 'authentication_failed', text: 'You are signed out. Run /login or sign in again.' };
  assert.deepEqual(R.signInNotice(failed, 'claude'), { text: 'Claude is signed out.', action: button });
  assert.deepEqual(R.signInNotice(failed, 'claude', true), { text: 'Claude was signed out.', action: button }, 'a saved chat says it in the past');
  // Claude Code's own sign-in status says what went wrong: its words stay.
  assert.deepEqual(R.signInNotice({ kind: 'notice', code: 'auth', text: 'Sign-in problem: the code expired' }, 'claude'), { text: 'Sign-in problem: the code expired', action: button });
  // The chat did not start because its account is signed out, or is someone else's now.
  assert.deepEqual(R.signInNotice({ kind: 'error', code: 'account-signed-out', message: 'Claude Code could not start: Max is signed out.' }, 'claude'), { text: 'Claude is signed out.', action: button });
  assert.deepEqual(R.signInNotice({ kind: 'notice', code: 'account-expired' }, 'claude'), { text: 'Claude is signed out.', action: button });
  assert.deepEqual(R.signInNotice({ kind: 'error', code: 'account-mismatch' }, 'claude'), { text: 'Claude is using a different login.', action: button });
  // A Codex chat's turn that OpenAI refused, as its adapter reports it: Codex's own sentence stays, and the button
  // is Codex's sign-in (drawn only while Codex's login needs one: codex-login-rules.ts `codexSignIn`).
  const refused = { kind: 'notice', level: 'warn', code: 'api-error', apiError: 'unauthorized', errorCode: 'auth', apiStatus: 401, text: 'Codex could not sign in to OpenAI. Check your Codex login.' };
  const codexButton = { label: 'Sign in to Codex', signIn: 'codex' };
  assert.deepEqual(R.signInNotice(refused, 'codex'), { text: refused.text, action: codexButton });
  assert.deepEqual(R.signInNotice(refused, 'codex', true), { text: refused.text, action: codexButton }, 'from a saved chat too: its words are already a record');
  assert.deepEqual(R.signInNotice({ ...refused, apiError: 'other' }, 'codex'), { text: refused.text, action: codexButton }, 'a plain 401');
  // Nothing else a Codex chat says is a sign-in matter: not a 403, a limit, Claude's shape of the same thing, or a line with no words.
  for (const ev of [{ ...refused, apiError: 'other', apiStatus: 403 }, { ...refused, apiError: 'usageLimitExceeded', apiStatus: 429 }, { ...refused, kind: 'error' }, { ...refused, text: '' }, failed, { kind: 'notice', code: 'auth', text: 'x' }, {}]) {
    assert.equal(R.signInNotice(ev, 'codex'), null, JSON.stringify(ev));
  }
  assert.equal(R.signInNotice(refused, 'claude'), null, 'and Codex’s shape means nothing in a Claude chat');

  for (const ev of [
    { kind: 'notice', code: 'api-error', apiError: 'overloaded' }, { kind: 'notice', code: 'api-error', apiError: 'billing_error' }, { kind: 'notice', code: 'rate-limit' },
    { kind: 'error', code: 'account-missing' }, { kind: 'error', code: 'account-invalid-key' }, { kind: 'error', code: 'crashed' }, { kind: 'notice' }, { kind: 'notice', text: 'Auth: x' },
    { kind: 'turn-end', code: 'auth' }, { kind: 'status', code: 'auth' }, {},
  ]) assert.equal(R.signInNotice(ev, 'claude'), null, JSON.stringify(ev));
});

test('the button stays while the account needs you, and goes once a sign-in has answered it', () => {
  const trouble = R.troubleFor(list([acct({ state: 'signed-out' })]), 'claude');
  const settings = R.troubleFor(list([acct({ kind: 'key', state: 'invalid-key' })]), 'claude');
  // Signed out, as far as Claude Code says: on every such notice, old ones and saved ones included.
  assert.equal(R.showsSignIn({ at: 100 }, trouble, undefined), true);
  assert.equal(R.showsSignIn({ at: 100, hist: true }, trouble, 500), true);
  assert.equal(R.showsSignIn({ at: 100 }, settings, undefined), false, 'what a sign-in cannot fix gets no such button');
  // Claude Code still says it is signed in (it refused the request anyway): the button is the way out, once.
  assert.equal(R.showsSignIn({ at: 100 }, null, undefined), true);
  assert.equal(R.showsSignIn({ at: 100 }, null, 99), true, 'this notice came after the last sign-in');
  assert.equal(R.showsSignIn({ at: 100 }, null, 100), false, 'answered');
  assert.equal(R.showsSignIn({ at: 100 }, null, 500), false);
  assert.equal(R.showsSignIn({ at: 100, hist: true }, null, undefined), false, 'a saved chat’s old failure is not a reason to sign in again');
  // The chat's account, when it is known: only a sign-in Claude Code keeps has a sign-in to open.
  for (const kind of ['plan', 'console']) assert.equal(R.showsSignIn({ at: 100 }, null, undefined, acct({ kind })), true, kind);
  for (const kind of ['key', 'external']) assert.equal(R.showsSignIn({ at: 100 }, null, undefined, acct({ kind })), false, `${kind}: there is no sign-in behind it`);
  assert.equal(R.showsSignIn({ at: 100 }, null, undefined, acct({ engine: 'codex' })), false);
  assert.equal(R.showsSignIn({ at: 100 }, null, undefined, null), true, 'not listed: Claude Code’s own sign-in is the way out');
  assert.equal(R.showsSignIn({ at: 100 }, trouble, undefined, trouble.account), true);
  for (const [a, yes] of [[acct(), true], [acct({ kind: 'console', state: 'signed-out' }), true], [acct({ kind: 'key' }), false], [acct({ kind: 'external' }), false], [acct({ engine: 'codex' }), false]]) assert.equal(R.takesSignIn(a), yes, `${a.engine} ${a.kind}`);
});

test('what the launch said about Claude Code’s sign-in follows the accounts list', () => {
  const launch = { loggedIn: true, method: 'claude.ai', org: 'Acme' };
  const out = { loggedIn: false, method: null, org: null };
  assert.equal(R.authFrom(launch, list([acct()])), launch, 'nothing differs: the very same answer');
  assert.deepEqual(R.authFrom(launch, list([acct({ state: 'signed-out' })])), { loggedIn: false, method: 'claude.ai', org: 'Acme' }, 'signed out since the launch');
  assert.equal(R.authFrom(out, list([acct({ state: 'signed-out' })])), out);
  assert.deepEqual(R.authFrom(out, list([acct()])), { loggedIn: true, method: 'claude.ai', org: null }, 'signed in since the launch');
  assert.deepEqual(R.authFrom(out, list([acct({ kind: 'console', label: 'Console' })])), { loggedIn: true, method: 'api_key', org: null });
  assert.deepEqual(R.authFrom({ loggedIn: null, method: null, org: null }, list([acct()])), { loggedIn: true, method: 'claude.ai', org: null }, 'the launch did not know; the list does');
  // Nothing known about the account Claude's chats start on: the launch's answer stands.
  for (const state of [null, undefined, list([]), list([acct({ state: 'unknown' })]), list([acct({ engine: 'codex', id: 'codex-default' })])]) assert.equal(R.authFrom(out, state), out);
  assert.equal(R.authFrom(undefined, list([acct()])), undefined);
});

// ---- the store ----

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (err) {
      if (specifier.startsWith('.') && !path.extname(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});
const sent = [];
globalThis.window = { canopy: { send: (text) => { sent.push(text); return Promise.resolve({ ok: true }); }, queue: () => Promise.resolve({ ok: true, queue: [], v: 1 }) }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);
const S = await import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/lib/store.ts')).href);
const FAILED = { kind: 'notice', level: 'warn', code: 'api-error', apiError: 'authentication_failed', text: 'You are signed out. Run /login or sign in again.' };
const notices = (store) => store.items.filter((i) => i.t === 'notice').map((i) => [i.text, i.tone, i.action ?? null]);

test('in a chat: the failed turn says "Claude is signed out." once, with the button, and the turn fails as before', () => {
  const store = new S.Store();
  store.dispatch('hello', []);
  store.handle(FAILED);
  store.handle({ kind: 'turn-end', isError: true, errorCode: 'auth', errors: [], text: '' });
  store.handle(FAILED); // the same failure, said again: not stacked
  assert.deepEqual(notices(store), [['Claude is signed out.', 'warn', { label: 'Sign in…', signIn: 'claude' }]]);
  assert.deepEqual(store.items.map((i) => i.t), ['user', 'notice', 'turn']);
  assert.equal(store.items.find((i) => i.t === 'notice').hist, undefined, 'live: the button may show even if Claude Code still reports a login');
  assert.deepEqual(store.meta.lastPrompt?.text, 'hello', 'what you sent can be sent again once you are signed in');

  // Your next message, and it fails again: said again, for that turn.
  store.dispatch('again', []);
  store.handle({ kind: 'notice', level: 'warn', code: 'auth', text: 'Sign-in problem: the code expired' });
  assert.deepEqual(notices(store).at(-1), ['Sign-in problem: the code expired', 'warn', { label: 'Sign in…', signIn: 'claude' }]);
});

test('a saved chat records it in the past, and a chat that was refused before it started gets the same line', () => {
  const saved = new S.Store();
  saved.loadHistory([{ kind: 'user-text', text: 'hello', at: 1000 }, { ...FAILED, at: 2000, history: true }]);
  const old = saved.items.find((i) => i.t === 'notice');
  assert.deepEqual([old.text, old.hist, old.at, old.action], ['Claude was signed out.', true, 2000, { label: 'Sign in…', signIn: 'claude' }]);

  const refused = new S.Store();
  refused.dispatch('hello', []);
  refused.setMeta({ busy: true });
  refused.handle({ kind: 'error', code: 'account-signed-out', message: 'Claude Code could not start: Max is signed out.', recoverable: false, prompts: [{ id: 'x', text: 'hello' }] });
  assert.deepEqual(refused.items.map((i) => i.t), ['user', 'error', 'notice']);
  assert.deepEqual(notices(refused), [['Claude is signed out.', 'warn', { label: 'Sign in…', signIn: 'claude' }]]);
  assert.equal(refused.meta.busy, false);
  assert.equal(refused.meta.lastPrompt.text, 'hello', '"Try again" on the turn sends it once you are signed in');

  // Everything else is as it was: other notices carry no button, other errors no extra line.
  const other = new S.Store();
  other.handle({ kind: 'notice', level: 'warn', code: 'api-error', apiError: 'overloaded', text: 'Claude is overloaded right now.' });
  other.handle({ kind: 'notice', code: 'rate-limit-warning', text: 'Approaching your usage limit.' });
  other.handle({ kind: 'error', code: 'crashed', message: 'Claude Code stopped unexpectedly.' });
  assert.deepEqual(notices(other), [['Claude is overloaded right now.', 'warn', null], ['Approaching your usage limit.', 'info', null]]);
  assert.deepEqual(other.items.map((i) => i.t), ['notice', 'notice', 'error']);
});

test('in a Codex chat on a pasted key: the refused turn says it is the key, once, with nothing to sign in to', () => {
  const refused = { kind: 'notice', level: 'warn', code: 'api-error', apiError: 'httpConnectionFailed', apiStatus: 401, text: 'Could not reach OpenAI. Check your connection and try again.' };
  const store = new S.Store();
  store.setEngine('codex');
  store.setMeta({ accountId: 'codex-key-1' }); // the open reply: main named the chat's account, so it is a pasted key
  store.dispatch('hello', []);
  store.handle(refused);
  store.handle(refused);
  assert.deepEqual(notices(store), [['OpenAI didn’t accept this chat’s API key.', 'warn', null]]);
  // The same turn on Codex's own login keeps Codex's words and the button for its sign-in.
  const own = new S.Store();
  own.setEngine('codex');
  own.setMeta({ accountId: null });
  own.dispatch('hello', []);
  own.handle(refused);
  assert.deepEqual(notices(own), [[refused.text, 'warn', { label: 'Sign in to Codex', signIn: 'codex' }]]);
  // And from a saved chat on the key.
  const saved = new S.Store();
  saved.setEngine('codex');
  saved.setMeta({ accountId: 'codex-key-1' });
  saved.loadHistory([{ kind: 'user-text', text: 'hello', at: 1000 }, { ...refused, at: 2000, history: true }]);
  assert.deepEqual(notices(saved), [['OpenAI didn’t accept this chat’s API key.', 'warn', null]]);
});

test('a chat knows which account it is on: from how it was opened, and when main moves it', () => {
  const store = new S.Store();
  assert.equal(store.meta.accountId, undefined, 'not told yet: it counts as a new chat');
  store.setMeta({ accountId: null }); // the open reply: on the login Claude Code finds on its own
  // Another account was chosen and nobody had used this chat: main moved it, and says so.
  store.handle({ kind: 'meta', accountId: 'claude-key-1' });
  assert.equal(store.meta.accountId, 'claude-key-1');
  // What a starting process reports about itself says nothing about the chat's account, and changes nothing.
  store.handle({ kind: 'meta', commands: [], models: [], sessionId: 's1', account: { email: 'me@example.com' } });
  assert.equal(store.meta.accountId, 'claude-key-1');
  store.handle({ kind: 'meta', accountId: null }); // back to "as Claude Code finds it"
  assert.equal(store.meta.accountId, null);
  store.handle({ kind: 'meta', accountId: 7 });
  assert.equal(store.meta.accountId, null, 'anything that is not a name is the tool’s own login');
  store.reset(); // another chat comes on screen
  assert.equal(store.meta.accountId, undefined);
});

// ---- the sign-in the window follows (renderer/src/lib/signin.ts) ----

// The bridge to main for signing in, as a stand-in: every call is recorded, and main's side is played by the test.
const bridge = { calls: [], startCheck: null, onState: null, begin: { ok: true, id: 'run-1' }, use: { ok: true } };
Object.assign(globalThis.window.canopy, {
  // "Use <account>" is the accounts' own switch (accounts:use): the sign-in bridge has no way to choose one.
  accounts: { list: () => Promise.resolve(null), refresh: () => Promise.resolve(null), onChanged: () => () => {},
    use: (engine, id) => { bridge.calls.push(['accounts.use', engine, id]); return Promise.resolve(bridge.use); } },
  signin: {
    startCheck: () => new Promise((resolve) => { bridge.startCheck = resolve; }),
    onState: (cb) => { bridge.onState = cb; return () => { bridge.onState = null; }; },
    begin: (o) => { bridge.calls.push(['begin', o]); return Promise.resolve(bridge.begin); },
    cancel: (id) => { bridge.calls.push(['cancel', id]); return Promise.resolve({ ok: true }); },
  },
});
const lib = (file) => import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/lib', file)).href);
const W = await lib('signin.ts');
const tick = () => new Promise((r) => setTimeout(r, 0));
const run = (over = {}) => ({ id: 'run-1', engine: 'claude', phase: 'ready', account: 'claude-default', label: 'Max', console: false, canSwitch: false, code: null, message: null, who: null, ...over });

test('the window asks main once at launch, and the prompt is for the maker whose account needs you', async () => {
  const seen = [];
  const read = () => seen.at(-1);
  // Follow the store the way the hook does.
  const off = W.watchSignIn((s) => seen.push(s));
  const stop = W.startSignIn();
  assert.equal(read().asking, null, 'nothing is asked before main has answered');
  bridge.startCheck({ first: true, accounts: list([acct({ state: 'signed-out' })]) });
  await tick();
  assert.equal(read().asking, 'claude');
  W.answerPrompt();
  assert.equal(read().asking, null, 'answered: it does not come back');
  W.answerPrompt();
  assert.equal(read().asking, null);

  // Main says where the sign-in stands; the sheet follows it, and keeps a finished one until it is closed.
  bridge.onState(run());
  assert.deepEqual([read().run.phase, read().signedInAt.claude], ['ready', undefined]);
  bridge.onState(run({ phase: 'running' }));
  bridge.onState(run({ phase: 'done', who: { label: 'Max', email: 'me@example.com' } }));
  assert.equal(read().run.phase, 'done');
  assert.ok(read().signedInAt.claude > 0, 'when it went through is kept, so older notices lose their button');
  bridge.onState({ id: 'another', phase: 'closed' });
  assert.equal(read().run.phase, 'done', 'some other sign-in closing is not this one');
  W.closeSignIn();
  assert.equal(read().run, null);
  assert.deepEqual(bridge.calls, [], 'a finished sign-in has nothing left to stop');

  // Closing one that is still running stops it; main closing it clears the sheet.
  bridge.onState(run({ id: 'run-2', phase: 'running' }));
  W.closeSignIn();
  assert.deepEqual(bridge.calls, [['cancel', 'run-2']]);
  bridge.onState(run({ id: 'run-3', phase: 'running' }));
  bridge.onState({ id: 'run-3', phase: 'closed' });
  assert.equal(read().run, null);
  stop(); off();
});

test('a reloaded window does not ask again, and a sign-in that cannot start says so without opening anything', async () => {
  const seen = [];
  const off = W.watchSignIn((s) => seen.push(s));
  const stop = W.startSignIn();
  bridge.startCheck({ first: false, accounts: list([acct({ state: 'signed-out' })]) });
  await tick();
  assert.equal(seen.at(-1)?.asking ?? null, null, 'main already asked this launch');

  bridge.calls.length = 0;
  await W.openSignIn('claude', { id: 'claude-default' });
  await W.openSignIn('claude');
  assert.deepEqual(bridge.calls, [['begin', { engine: 'claude', accountId: 'claude-default' }], ['begin', { engine: 'claude', accountId: null }]]);
  bridge.begin = { ok: false, code: 'busy', message: 'A sign-in is already open.' };
  await W.openSignIn('claude'); // already open: nothing to say
  bridge.begin = { ok: false, code: 'not-installed', message: 'Claude Code was not found.' };
  await W.openSignIn('claude'); // said in a toast; no sheet opens
  assert.equal(seen.at(-1)?.run ?? null, null);

  // "Use API key" beside a login that is gone: asked of main once, through the accounts' own switch. A refusal is
  // said in a toast; nothing else is tried.
  bridge.calls.length = 0;
  await W.switchTo('claude', { id: 'claude-env', label: 'API key' });
  assert.deepEqual(bridge.calls, [['accounts.use', 'claude', 'claude-env']]);
  bridge.use = { ok: false, code: 'account-signed-out', message: 'Max is signed out.' };
  await W.switchTo('claude', { id: 'extra', label: 'Max' });
  assert.deepEqual(bridge.calls.at(-1), ['accounts.use', 'claude', 'extra']);
  assert.equal(bridge.calls.length, 2);
  stop(); off();
});

test('an account that needs more than a sign-in opens its maker’s own page in Settings, where its accounts are', () => {
  // Settings has no page for accounts: each maker's lead its own page (Claude Code, Codex). App opens Settings at
  // the page a `canopy:settings` event names.
  const opened = [];
  const was = globalThis.window.dispatchEvent;
  globalThis.window.dispatchEvent = (e) => { opened.push([e.type, e.detail]); return true; };
  try { W.openAccounts('claude'); W.openAccounts('codex'); }
  finally { globalThis.window.dispatchEvent = was; }
  assert.deepEqual(opened, [['canopy:settings', 'claude'], ['canopy:settings', 'codex']]);
});

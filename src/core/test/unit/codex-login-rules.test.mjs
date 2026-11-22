// The window's rules for signing in to Codex (renderer/src/lib/codex-login-rules.ts): what the sheet says in each
// state, which row gets a sign-in button and which a way to sign out, and when Settings shows "Not signed in".
// The file is plain TypeScript with no run-time imports, so node runs it as it is: no build, no window, no Codex.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as R from '../../../../renderer/src/lib/codex-login-rules.ts';

const RENDERER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'renderer', 'src');
// Main's state as the window gets it (src/core/accounts-codex-login.mjs `view`).
const login = (over = {}) => ({ phase: 'idle', message: null, detail: null, installed: true, signedIn: false, canSignIn: true, signingOut: false, ...over });
const row = (over = {}) => ({ id: 'codex-default', engine: 'codex', kind: 'plan', label: 'ChatGPT Plus', email: 'me@example.com', org: null, plan: 'plus', via: null, keyHint: null, state: 'ok', why: null, found: true, ...over });

test('the sheet: nothing while idle, then the browser, the wait, the check, and how it ended', () => {
  for (const none of [null, undefined, login(), {}, { phase: 'somethingNew' }, { phase: 7 }]) assert.equal(R.signInSheet(none), null);

  const waiting = R.signInSheet(login({ phase: 'waiting', canSignIn: false }));
  assert.deepEqual(waiting, {
    title: 'Sign in to Codex', line: 'Your browser opened OpenAI’s sign-in page.', detail: null, waiting: 'Waiting for you to sign in there…',
    note: 'Codex keeps the login. Canopy never sees your password.', signedIn: false, cancel: true, reopen: true, close: null, retry: false,
  });
  const starting = R.signInSheet(login({ phase: 'starting', canSignIn: false }));
  assert.deepEqual([starting.title, starting.cancel, starting.reopen, starting.close], ['Sign in to Codex', true, false, null], 'no page to open again until there is one');
  const checking = R.signInSheet(login({ phase: 'checking', canSignIn: false }));
  assert.deepEqual([checking.waiting, checking.cancel, checking.reopen, checking.close], ['Checking with Codex…', false, false, null], 'too late to call off, not yet over');

  // Done: who it is, as the list of accounts names them; until the list has it, only that it worked.
  const done = R.signInSheet(login({ phase: 'done', signedIn: true, canSignIn: false }), row());
  assert.deepEqual(done, {
    title: 'Signed in to Codex', line: 'ChatGPT Plus · me@example.com', detail: null, waiting: null, note: null, signedIn: true, cancel: false, reopen: false, close: 'Done', retry: false,
  });
  assert.equal(R.signInSheet(login({ phase: 'done' }), row({ label: 'API key', email: null })).line, 'API key');
  assert.equal(R.signInSheet(login({ phase: 'done' }), null).line, 'Codex is signed in on this Mac.');

  // Failed: main's sentence, Codex's own words under it, and another try when one may be started.
  const failed = R.signInSheet(login({ phase: 'failed', message: 'The sign-in was not finished.', detail: 'access_denied' }));
  assert.deepEqual([failed.line, failed.detail, failed.close, failed.retry, failed.signedIn, failed.waiting], ['The sign-in was not finished.', 'access_denied', 'Close', true, false, null]);
  const stuck = R.signInSheet(login({ phase: 'failed', message: null, canSignIn: false }));
  assert.deepEqual([stuck.line, stuck.retry], ['The sign-in was not finished.', false], 'no try offered where none may be started (Codex already signed in, or not here)');
});

test('the sheet has nothing to type into and never shows an address', () => {
  // Every state main can be in, with the worst it could carry.
  const states = ['starting', 'waiting', 'checking', 'done', 'failed'].map((phase) => R.signInSheet(login({ phase, message: 'x', detail: 'y' }), row()));
  for (const s of states) {
    assert.deepEqual(Object.keys(s).sort(), ['cancel', 'close', 'detail', 'line', 'note', 'reopen', 'retry', 'signedIn', 'title', 'waiting']);
    assert.ok(!/https?:|:\/\//.test(JSON.stringify(s)), 'no address in the sheet');
  }
  // And the part of the window that draws it has no field at all: the sign-in is Codex's, in the browser.
  const sheet = fs.readFileSync(path.join(RENDERER, 'components', 'canopy', 'codex-signin.tsx'), 'utf8');
  assert.ok(!/<input|<textarea|contentEditable|type="password"/i.test(sheet), 'codex-signin.tsx takes no typed input');
  for (const file of [path.join('components', 'canopy', 'codex-signin.tsx'), path.join('lib', 'codex-login.ts'), path.join('lib', 'codex-login-rules.ts')]) {
    const text = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    assert.ok(!/authUrl|loginId|Sign in with ChatGPT/i.test(text), `${file} knows nothing of the page's address, and uses Codex's name for the sign-in`);
  }
  assert.equal(R.SIGN_IN, 'Sign in to Codex');
});

test('a row gets a sign-in only when its account needs one, and main says one may be started', () => {
  const can = login();
  assert.equal(R.rowSignIn(row({ state: 'signed-out' }), can), 'Sign in…');
  assert.equal(R.rowSignIn(row({ state: 'expired' }), can), 'Sign in…');
  assert.equal(R.rowSignIn(row({ state: 'invalid-key', kind: 'key' }), can), 'Sign in…', 'the same button for every login');
  assert.equal(R.rowSignIn(row({ state: 'expired', kind: 'external' }), can), 'Sign in…');
  // Never on an account that works, or one not known to be broken.
  for (const state of ['ok', 'unknown', 'checking']) assert.equal(R.rowSignIn(row({ state }), can), null, state);
  // Never while main says no: a sign-in under way, a sign-out under way, Codex signed in, nothing known yet.
  for (const no of [login({ canSignIn: false }), login({ phase: 'waiting', canSignIn: false }), null, undefined, {}]) assert.equal(R.rowSignIn(row({ state: 'signed-out' }), no), null);
  // And never on Claude's rows: that sign-in is Claude Code's own.
  assert.equal(R.rowSignIn(row({ engine: 'claude', state: 'signed-out' }), can), null);
  // Nor on a key pasted into Canopy, whatever is wrong with it: signing in to Codex would not fix a key.
  for (const state of ['invalid-key', 'locked', 'blocked', 'signed-out']) assert.equal(R.rowSignIn(row({ id: 'codex-key-1', kind: 'key', found: false, state }), can), null, state);
});

test('signing out is offered for the login Codex holds, and not while anything is under way', () => {
  const idle = login({ signedIn: true, canSignIn: false });
  assert.equal(R.rowSignOut(row(), idle), true);
  assert.equal(R.rowSignOut(row({ kind: 'key', label: 'API key' }), idle), true);
  assert.equal(R.rowSignOut(row({ state: 'expired' }), login()), true, 'a login OpenAI refused can be signed out of too');
  assert.equal(R.rowSignOut(row({ state: 'signed-out' }), login()), false, 'nothing to sign out of');
  for (const state of ['unknown', 'checking']) assert.equal(R.rowSignOut(row({ state }), idle), false, state);
  assert.equal(R.rowSignOut(row({ found: false }), idle), false, 'only the login Codex itself holds');
  assert.equal(R.rowSignOut(row({ engine: 'claude' }), idle), false);
  for (const busy of [login({ phase: 'waiting' }), login({ phase: 'done' }), login({ signingOut: true }), login({ installed: false }), null, undefined]) assert.equal(R.rowSignOut(row(), busy), false);
});

test('"Not signed in" shows only when Codex is here and says nobody is signed in', () => {
  assert.equal(R.showSignedOut(0, login()), true);
  assert.equal(R.showSignedOut(0, login({ phase: 'waiting', canSignIn: false })), true, 'it stays while the sign-in is under way');
  assert.equal(R.showSignedOut(1, login()), false, 'an account is listed: its own row says what is wrong');
  assert.equal(R.showSignedOut(0, login({ installed: false, signedIn: null, canSignIn: false })), false, 'no Codex: no OpenAI group at all');
  assert.equal(R.showSignedOut(0, login({ signedIn: null, canSignIn: false })), false, 'Codex has not said: nothing is claimed');
  assert.equal(R.showSignedOut(0, login({ signedIn: true, canSignIn: false })), false, 'a provider of their own: no OpenAI sign-in to offer');
  for (const none of [null, undefined, {}]) assert.equal(R.showSignedOut(0, none), false);
});

test('a key pasted into Canopy is not Codex’s login: it neither hides "Not signed in" nor gets Codex’s sign-in', () => {
  const can = login();
  const pasted = (state = 'ok') => row({ id: 'codex-key-1', kind: 'key', label: 'API key ••••7Hq2', found: false, state });
  // Codex has nobody signed in and a key is listed: the sign-in is still offered, for Codex's own login.
  assert.equal(R.codexSignIn([pasted()], can), 'Sign in to Codex');
  assert.equal(R.codexSignIn([pasted('invalid-key')], can), 'Sign in to Codex', 'offered because Codex is signed out, not because of the key');
  assert.equal(R.codexSignIn([pasted('invalid-key')], login({ signedIn: true, canSignIn: false })), null, 'a broken key alone never offers Codex’s sign-in');
  // Beside Codex's own login, it is that login the rule goes by, wherever the key stands in the list.
  for (const list of [[pasted('invalid-key'), row({ state: 'ok' })], [row({ state: 'ok' }), pasted('invalid-key')]]) assert.equal(R.codexSignIn(list, can), null);
  for (const list of [[pasted(), row({ state: 'expired' })], [row({ state: 'expired' }), pasted()]]) assert.equal(R.codexSignIn(list, can), 'Sign in…');
  // The page counts Codex's own logins only, so the "Not signed in" row stays with keys listed under it.
  const own = (list) => list.filter((a) => a.found).length;
  assert.equal(R.showSignedOut(own([pasted()]), can), true);
  assert.equal(R.showSignedOut(own([row(), pasted()]), can), false);
  assert.equal(R.rowSignOut(pasted(), login({ signedIn: true, canSignIn: false })), false, 'and there is nothing to sign out of on a key');
});

test('beside a turn OpenAI refused, the sign-in is offered exactly when the row in Settings would offer it', () => {
  const can = login();
  // The account Codex's chats run on needs a sign-in: the row's own label.
  assert.equal(R.codexSignIn([row({ state: 'expired' })], can), 'Sign in…');
  assert.equal(R.codexSignIn([row({ engine: 'claude', id: 'claude-default', state: 'signed-out' }), row({ state: 'invalid-key', kind: 'key' })], can), 'Sign in…', 'Claude’s accounts are not Codex’s business');
  // No account listed, and Codex says nobody is signed in.
  assert.equal(R.codexSignIn([], can), 'Sign in to Codex');
  assert.equal(R.codexSignIn([row({ engine: 'claude', id: 'claude-default' })], can), 'Sign in to Codex');
  for (const none of [null, undefined]) assert.equal(R.codexSignIn(none, can), 'Sign in to Codex');
  // Never for a login that works or is not known to be broken: one refused request signs nobody out.
  for (const state of ['ok', 'unknown', 'checking']) assert.equal(R.codexSignIn([row({ state })], can), null, state);
  // Never while main says no (a sign-in under way, Codex has not said, no Codex, a provider of the user's own).
  for (const no of [login({ canSignIn: false }), login({ phase: 'waiting', canSignIn: false }), login({ installed: false, signedIn: null, canSignIn: false }), login({ signedIn: true, canSignIn: false }), null, undefined, {}]) {
    assert.equal(R.codexSignIn([row({ state: 'expired' })], no), null);
    assert.equal(R.codexSignIn([], no), null);
  }
});

// The window's rules about a Claude sign-in added in Canopy (renderer/src/lib/account-rules.ts): which rows are one,
// what is said when adding or removing one fails, what removing one asks, and the line on the Connectors page.
// The file is plain TypeScript with no run-time imports, so node runs it as it is: no build and no window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as R from '../../../../renderer/src/lib/account-rules.ts';

const row = (over = {}) => ({ id: 'claude-a1b2c3d4', engine: 'claude', kind: 'plan', label: 'Max', email: 'work@example.com', found: false, ...over });

test('an added sign-in is a Claude plan or Console login, or a Codex plan login, that Canopy did not find', () => {
  assert.equal(R.isAddedSignIn(row()), true);
  assert.equal(R.isAddedSignIn(row({ kind: 'console' })), true);
  // The login Claude Code holds itself, a pasted key, and what the environment supplies are not.
  assert.equal(R.isAddedSignIn(row({ found: true })), false);
  assert.equal(R.isAddedSignIn(row({ kind: 'key' })), false);
  assert.equal(R.isAddedSignIn(row({ kind: 'external' })), false);
  // A second Codex login (a ChatGPT plan, in a folder of its own) is one; Codex's own login, and a Codex key, are not.
  assert.equal(R.isAddedSignIn(row({ engine: 'codex' })), true);
  assert.equal(R.isAddedSignIn(row({ engine: 'codex', found: true })), false);
  assert.equal(R.isAddedSignIn(row({ engine: 'codex', kind: 'key' })), false);
  assert.equal(R.isAddedSignIn(row({ engine: 'codex', kind: 'console' })), false);
  for (const junk of [null, undefined]) assert.equal(R.isAddedSignIn(junk), false);
});

test('adding: nothing is said when it worked or the user closed the sign-in; otherwise main’s own words', () => {
  assert.equal(R.addProblem({ ok: true, id: 'claude-a1b2c3d4' }), null);
  assert.equal(R.addProblem({ ok: false, code: 'cancelled' }), null);
  assert.equal(R.addProblem({ ok: false, code: 'cancelled', message: 'closed' }), null);
  assert.equal(R.addProblem({ ok: false, code: 'duplicate', message: 'Console is already in Canopy.' }), 'Console is already in Canopy.');
  assert.equal(R.addProblem({ ok: false, code: 'unavailable', message: 'Signing in from Canopy is not available yet.' }), 'Signing in from Canopy is not available yet.');
  // main's guard caught a throw, or an older main has no such call: still one plain line.
  assert.equal(R.addProblem({ error: 'boom' }), 'boom');
  for (const empty of [{}, { ok: false }, null, undefined]) assert.equal(R.addProblem(empty), 'Canopy couldn’t add the account.');
});

test('removing: asked in plain words, and a failure is said as main said it', () => {
  const q = R.removeQuestion(row(), false);
  assert.equal(q.title, 'Remove Max?');
  assert.equal(q.body, 'work@example.com is signed out here and leaves Canopy. Your other logins are not touched.');
  assert.equal(q.note, 'Your chats, settings and connectors stay. A chat open on this account can’t continue on it.');
  // The account in use: new chats need somewhere to go, and the question says where.
  assert.equal(R.removeQuestion(row(), true).note, 'Your chats, settings and connectors stay. New chats go back to the login Claude Code has. A chat open on this account can’t continue on it.');
  assert.equal(R.removeQuestion(row({ email: null, label: 'Claude plan' }), false).body, 'This account is signed out here and leaves Canopy. Your other logins are not touched.');
  assert.equal(R.removeProblem({ ok: true }), null);
  assert.equal(R.removeProblem({ ok: false, code: 'working', message: 'A chat is still working on Max. Remove it when the chat is done.' }), 'A chat is still working on Max. Remove it when the chat is done.');
  assert.equal(R.removeProblem({ error: 'Not allowed.' }), 'Not allowed.');
  for (const empty of [{}, null, undefined, { ok: false }]) assert.equal(R.removeProblem(empty), 'Canopy couldn’t remove the account.');
});

test('the Connectors page says connector sign-ins are per account only when the account in use was added in Canopy', () => {
  assert.equal(R.connectorsNote(row(), 3), 'Connector sign-ins are kept per account. Sign in to these once for Max.');
  assert.equal(R.connectorsNote(row({ kind: 'console', label: 'Console' }), 1), 'Connector sign-ins are kept per account. Sign in to this one once for Console.');
  // Nothing waiting, or the login Claude Code holds itself (the connectors' sign-ins are where they always were).
  assert.equal(R.connectorsNote(row(), 0), undefined);
  assert.equal(R.connectorsNote(row({ found: true }), 3), undefined);
  assert.equal(R.connectorsNote(row({ kind: 'key' }), 3), undefined);
  for (const junk of [null, undefined]) assert.equal(R.connectorsNote(junk, 3), undefined);
  assert.equal(R.connectorsNote(row(), NaN), undefined);
  assert.match(R.ADDED_NOTE, /Settings → Tools/);
});

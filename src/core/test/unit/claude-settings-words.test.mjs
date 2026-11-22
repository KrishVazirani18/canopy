// The worked-out words of Settings → Claude Code (renderer/src/lib/claude-settings-words.ts): the headline under
// "Claude Code", the glances that roll the page up, the rows for the models Canopy offers newer, and "Not shown yet"
// as one line. The file is plain TypeScript with no run-time imports, so node runs it as it is: no build, no window,
// no Claude Code. (The Updates glance is Codex's too: codex-settings-words.ts, used here as the page uses it.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as W from '../../../../renderer/src/lib/claude-settings-words.ts';
import { updatesGlance } from '../../../../renderer/src/lib/codex-settings-words.ts';

// Main's upkeep of Claude Code as the window gets it (src/core/upkeep.mjs `status`).
const up = (over = {}) => ({
  autoUpdate: true, blockedBy: null, version: '2.5.0', engineVersion: '2.5.0', behind: false, doing: null,
  lastCheck: { at: 1, result: 'current', version: '2.5.0', detail: null, reason: 'schedule' }, lastUpdate: null, fixups: [], drift: [], ...over,
});
// A picker row Claude Code pins to an older release, and the row Canopy offers instead (src/core/upkeep.mjs).
const fixup = (over = {}) => ({ from: 'claude-fable-5-1', was: '5.1', is: '5.2', to: { value: 'fable[1m]', displayName: 'Fable', resolvedModel: 'claude-fable-5-2' }, ...over });
const said = (g) => [g.value, g.tone];

test('the Account glance: the account in use speaks first, then what Claude Code said of its own sign-in', () => {
  assert.deepEqual(W.accountGlance({ loggedIn: true }, { label: 'Claude Max', problem: null }), { key: 'account', label: 'Account', value: 'Claude Max', tone: 'ok' });
  assert.deepEqual(said(W.accountGlance({ loggedIn: true }, { label: '', problem: null })), ['Signed in', 'ok'], 'an account with no name is not shown as nothing');
  // An account that needs you says what is wrong, whatever the launch's check found.
  assert.deepEqual(said(W.accountGlance({ loggedIn: true }, { label: 'Work', problem: 'Signed out' })), ['Signed out', 'attention']);
  // A key pasted into Canopy runs chats whatever Claude Code's own sign-in is.
  assert.deepEqual(said(W.accountGlance({ loggedIn: false }, { label: 'API key ••••4f2a', problem: null })), ['API key ••••4f2a', 'ok']);
  // An account in use is not hidden by the list being asked again.
  assert.deepEqual(said(W.accountGlance({ loggedIn: true }, { label: 'Claude Max', problem: null }, true)), ['Claude Max', 'ok']);
  assert.deepEqual(said(W.accountGlance({ loggedIn: false }, null, true)), ['Checking…', 'busy'], 'the accounts are not in yet');
  assert.deepEqual(said(W.accountGlance({ loggedIn: false }, null)), ['Not signed in', 'attention']);
  assert.deepEqual(said(W.accountGlance({ loggedIn: true }, null)), ['Signed in', 'ok'], 'signed in, before the list of accounts has it');
  assert.deepEqual(said(W.accountGlance({ loggedIn: null }, null)), ['No login found', 'off'], 'Claude Code did not say');
  assert.deepEqual(said(W.accountGlance(undefined, null)), ['No login found', 'off']);
  assert.deepEqual(said(W.accountGlance(null, null)), ['No login found', 'off']);
});

test('the Models glance: only when Canopy offers a newer model than Claude Code’s own menu', () => {
  assert.equal(W.modelsGlance([]), null);
  assert.equal(W.modelsGlance([fixup({ was: '5.2', is: '5.2' })]), null, 'Claude Code’s own pin caught up: nothing was changed');
  assert.deepEqual(W.modelsGlance([fixup()]), { key: 'models', label: 'Models', value: 'Newest offered', tone: 'ok' });
  assert.deepEqual(W.newerModels([fixup(), fixup({ from: 'claude-opus-5-4', was: '5.5', is: '5.5' })]).map((f) => f.from), ['claude-fable-5-1']);
});

test('a changed model as a row: what it runs in Canopy, and what Claude Code still offers', () => {
  assert.equal(W.fixupLabel(fixup()), 'Fable runs 5.2');
  assert.equal(W.fixupLabel(fixup({ to: { value: 'fable[1m]' } })), 'fable[1m] runs 5.2', 'a row with no name of its own goes by its value');
  assert.equal(W.fixupLine(fixup()), 'Claude Code still offers 5.1; Canopy offers the newest');
});

test('the headline: ready with the green dot only when chats can run, and amber says the one thing in the way', () => {
  const head = (auth, account, upkeep, checking) => W.claudeHeadline(W.accountGlance(auth, account), updatesGlance(upkeep, checking));
  const max = { label: 'Claude Max', problem: null };
  assert.deepEqual(head({ loggedIn: true }, max, up()), { text: 'Ready · up to date', tone: 'ready' });
  assert.deepEqual(head({ loggedIn: true }, null, up()), { text: 'Ready · up to date', tone: 'ready' }, 'signed in, before the list of accounts has it');
  assert.deepEqual(head({ loggedIn: true }, max, null), { text: 'Ready', tone: 'ready' }, 'upkeep not in yet');
  assert.deepEqual(head({ loggedIn: true }, max, up(), true), { text: 'Ready', tone: 'ready' }, 'checking for an update does not stop a chat');
  assert.deepEqual(head({ loggedIn: true }, max, up({ lastCheck: null })), { text: 'Ready', tone: 'ready' });
  assert.deepEqual(head({ loggedIn: true }, max, up({ behind: true })), { text: 'Ready · needs an update', tone: 'attention' });
  assert.deepEqual(head({ loggedIn: true }, max, up({ lastCheck: { at: 1, result: 'failed', version: null, detail: null, reason: 'x' } })), { text: 'Ready · couldn’t update', tone: 'attention' });
  assert.deepEqual(head({ loggedIn: false }, null, up()), { text: 'Not signed in', tone: 'attention' });
  assert.deepEqual(head({ loggedIn: true }, { label: 'Work', problem: 'Signed out' }, up()), { text: 'Signed out', tone: 'attention' });
  // Signed out and behind: the sign-in is what stops a chat, so it is the one thing said.
  assert.deepEqual(head({ loggedIn: false }, null, up({ behind: true })), { text: 'Not signed in', tone: 'attention' });
  // Nobody could say who is signed in: said plainly, with no dot of either colour.
  assert.deepEqual(head({ loggedIn: null }, null, up()), { text: 'No login found', tone: 'ok' });
  assert.deepEqual(W.claudeHeadline(W.accountGlance({ loggedIn: false }, null, true), updatesGlance(up())), { text: 'Checking…', tone: 'ok' }, 'no dot while nothing is known');
});

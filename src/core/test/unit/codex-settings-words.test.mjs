// The worked-out words of Settings → Codex (renderer/src/lib/codex-settings-words.ts): the headline under "Codex",
// the glances that roll the page up, and the lines of the Computer Use rows. The file is plain TypeScript with no
// run-time imports, so node runs it as it is: no build, no window, no Codex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as W from '../../../../renderer/src/lib/codex-settings-words.ts';

// Main's upkeep of Codex as the window gets it (src/core/upkeep.mjs `status`).
const up = (over = {}) => ({
  autoUpdate: true, blockedBy: null, version: '0.153.4', engineVersion: '0.153.4', behind: false, doing: null,
  lastCheck: { at: 1, result: 'current', version: '0.153.4', detail: null, reason: 'schedule' }, lastUpdate: null, fixups: [], drift: [], ...over,
});
const said = (g) => [g.value, g.tone];

test('the Account glance: the account in use speaks first, then what Codex says about its own login', () => {
  assert.deepEqual(W.accountGlance(null, null), { key: 'account', label: 'Account', value: 'Checking…', tone: 'busy' }, 'main has not said yet');
  assert.deepEqual(said(W.accountGlance({ signedIn: true }, null)), ['Signed in', 'ok'], 'signed in, before the list of accounts has it');
  assert.deepEqual(said(W.accountGlance({ signedIn: true }, { label: 'ChatGPT Pro', problem: null })), ['ChatGPT Pro', 'ok']);
  assert.deepEqual(said(W.accountGlance({ signedIn: true }, { label: '', problem: null })), ['Signed in', 'ok'], 'an account with no name is not shown as nothing');
  assert.deepEqual(said(W.accountGlance({ signedIn: false }, null)), ['Not signed in', 'attention']);
  assert.deepEqual(said(W.accountGlance({ signedIn: null }, null)), ['Not answering', 'attention']);
  // A key pasted into Canopy runs chats whatever Codex's own login is.
  assert.deepEqual(said(W.accountGlance({ signedIn: false }, { label: 'API key ••••4f2a', problem: null })), ['API key ••••4f2a', 'ok']);
  // An account that needs you says what is wrong, even while Codex itself says it is signed in.
  assert.deepEqual(said(W.accountGlance({ signedIn: true }, { label: 'Work', problem: 'Key no longer works' })), ['Key no longer works', 'attention']);
});

test('the Updates glance: checking, up to date, and the two things that need you', () => {
  assert.deepEqual(W.updatesGlance(null), { key: 'updates', label: 'Updates', value: 'Checking…', tone: 'busy' }, 'main has not looked yet');
  assert.deepEqual(said(W.updatesGlance(up())), ['Up to date', 'ok']);
  assert.deepEqual(said(W.updatesGlance(up({ autoUpdate: false }))), ['Up to date', 'ok'], 'current is current, whoever keeps it so');
  assert.deepEqual(said(W.updatesGlance(up(), true)), ['Checking…', 'busy'], 'Check Now was pressed');
  assert.deepEqual(said(W.updatesGlance(up({ doing: 'updating' }))), ['Checking…', 'busy']);
  assert.deepEqual(said(W.updatesGlance(up({ behind: true, engineVersion: '0.160.0' }))), ['Needs an update', 'attention']);
  assert.deepEqual(said(W.updatesGlance(up({ lastCheck: { at: 1, result: 'failed', version: null, detail: 'offline', reason: 'schedule' } }))), ['Couldn’t update', 'attention']);
  assert.deepEqual(said(W.updatesGlance(up({ behind: true, doing: 'updating' }))), ['Checking…', 'busy'], 'being fixed right now: nothing to do');
  assert.deepEqual(said(W.updatesGlance(up({ lastCheck: null }))), ['Not checked yet', 'off']);
});

test('the Computer Use glance: what Codex says, and no glance when there is nothing to show', () => {
  assert.equal(W.computerUseGlance(null), null, 'a main process from before Computer Use');
  assert.deepEqual(W.computerUseGlance(undefined), { key: 'computer-use', label: 'Computer Use', value: 'Checking…', tone: 'busy' });
  assert.deepEqual(said(W.computerUseGlance({ state: 'on' })), ['On', 'ok']);
  assert.deepEqual(said(W.computerUseGlance({ state: 'off' })), ['Turned off', 'attention']);
  assert.deepEqual(said(W.computerUseGlance({ state: 'missing' })), ['Not set up', 'off'], 'nothing is wrong: Codex installs it on first use');
  assert.deepEqual(said(W.computerUseGlance({ state: 'unknown' })), ['Can’t tell', 'off']);
});

test('the headline: ready with the green dot only when chats can run, and amber says the one thing in the way', () => {
  const head = (codex, account, upkeep, checking) => W.codexHeadline(W.accountGlance(codex, account), W.updatesGlance(upkeep, checking));
  assert.deepEqual(head({ signedIn: true }, null, up()), { text: 'Ready · up to date', tone: 'ready' });
  assert.deepEqual(head({ signedIn: true }, null, null), { text: 'Ready', tone: 'ready' }, 'upkeep not in yet');
  assert.deepEqual(head({ signedIn: true }, null, up(), true), { text: 'Ready', tone: 'ready' }, 'checking for an update does not stop a chat');
  assert.deepEqual(head({ signedIn: true }, null, up({ lastCheck: null })), { text: 'Ready', tone: 'ready' });
  assert.deepEqual(head(null, null, up()), { text: 'Checking…', tone: 'ok' }, 'no dot while nothing is known');
  assert.deepEqual(head({ signedIn: false }, null, up()), { text: 'Not signed in', tone: 'attention' });
  assert.deepEqual(head({ signedIn: null }, null, up()), { text: 'Not answering', tone: 'attention' });
  assert.deepEqual(head({ signedIn: true }, null, up({ behind: true })), { text: 'Ready · needs an update', tone: 'attention' });
  assert.deepEqual(head({ signedIn: true }, null, up({ lastCheck: { at: 1, result: 'failed', version: null, detail: null, reason: 'x' } })), { text: 'Ready · couldn’t update', tone: 'attention' });
  // Signed out and behind: the sign-in is what stops a chat, so it is the one thing said.
  assert.deepEqual(head({ signedIn: false }, null, up({ behind: true })), { text: 'Not signed in', tone: 'attention' });
});

test('the Computer Use rows: what it is while on, Codex’s own words otherwise, and which permission can be skipped', () => {
  assert.equal(W.computerUseLine({ state: 'on', line: 'On' }), 'Codex can click and type in the apps on this Mac');
  assert.equal(W.computerUseLine({ state: 'off', line: 'Turned off in Codex' }), 'Turned off in Codex');
  assert.equal(W.computerUseLine({ state: 'missing', line: 'Not set up yet.' }), 'Not set up yet.');
  assert.equal(W.permissionLine({ detail: 'So it can click and type in your apps', needed: true }), 'So it can click and type in your apps');
  assert.equal(W.permissionLine({ detail: 'Only to send messages you approve', needed: false }), 'Optional · only to send messages you approve');
  assert.equal(W.permissionLine({ detail: '', needed: false }), 'Optional · ', 'nothing to say is not a crash');
});

test('which apps: any, any but some, only some, none, and a Codex that did not answer', () => {
  assert.equal(W.appsLine(null), 'Codex is not answering');
  assert.equal(W.appsLine({ any: true, listed: [] }), 'Any app · it asks first, once for each');
  assert.equal(W.appsLine({ any: true, listed: [{ id: 'com.apple.Safari', access: 'allow' }] }), 'Any app · it asks first, once for each', 'an allowed app adds nothing to "any"');
  assert.equal(W.appsLine({ any: true, listed: [{ id: 'com.apple.Mail', access: 'deny' }, { id: 'com.apple.Notes', access: 'deny' }] }), 'Any app except com.apple.Mail, com.apple.Notes');
  assert.equal(W.appsLine({ any: false, listed: [{ id: 'com.apple.Safari', access: 'allow' }, { id: 'com.apple.Mail', access: 'deny' }] }), 'Only com.apple.Safari');
  assert.equal(W.appsLine({ any: false, listed: [] }), 'No apps');
});

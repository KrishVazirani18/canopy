// The window's rules for the accounts in Settings (renderer/src/lib/account-rules.ts): what a row offers, which accounts
// an offer near a plan's limit may name, what the paste sheet refuses where it is typed, and how a reply from main
// is worded. The file is plain TypeScript with no run-time imports, so node runs it as it is: no build and no
// window. Main's own rule for what a key is (account-keys.mjs) is held beside the window's, so the two cannot drift
// apart. The same file's rules about a login that needs you are in account-trouble.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyShape } from '../../account-keys.mjs';
import * as R from '../../../../renderer/src/lib/account-rules.ts';
import { MAKER as USAGE_MAKER } from '../../../../renderer/src/lib/usage-rules.ts';

const acct = (over = {}) => ({ engine: 'claude', kind: 'console', state: 'ok', found: true, ...over });
const BODY = 'NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstuvwxyz';

test('Use is offered for an account that is not in use and could start a chat, for either maker', () => {
  assert.equal(R.rowOffers(acct(), false).use, true);
  assert.equal(R.rowOffers(acct(), true).use, false, 'the one in use has nothing to switch to');
  assert.equal(R.rowOffers(acct({ state: 'unknown' }), false).use, true, '"could not check" is not "signed out"');
  assert.equal(R.rowOffers(acct({ state: 'checking' }), false).use, true);
  for (const state of ['signed-out', 'expired', 'mismatch', 'missing', 'locked', 'invalid-key', 'blocked']) {
    assert.equal(R.rowOffers(acct({ state }), false).use, false, state);
    assert.equal(R.isBroken({ state }), true, state);
  }
  for (const state of ['ok', 'unknown', 'checking']) assert.equal(R.isBroken({ state }), false, state);
  for (const kind of ['plan', 'console', 'key', 'external']) assert.equal(R.rowOffers(acct({ kind, found: kind !== 'key' }), false).use, true, kind);
  // Codex: its own login (a plan, or a key it holds), and a key pasted into Canopy beside it.
  for (const row of [acct({ engine: 'codex', kind: 'plan' }), acct({ engine: 'codex', kind: 'key', found: true }), acct({ engine: 'codex', kind: 'key', found: false })]) {
    assert.deepEqual([R.rowOffers(row, false).use, R.rowOffers(row, true).use], [true, false], `${row.kind} ${row.found}`);
    for (const state of ['signed-out', 'expired', 'locked', 'invalid-key']) assert.equal(R.rowOffers({ ...row, state }, false).use, false, state);
  }
});

test('only a key pasted into Canopy can be replaced or removed; any account can be renamed', () => {
  assert.deepEqual(R.rowOffers(acct({ kind: 'key', found: false }), false).menu, ['rename', 'replace-key', 'remove']);
  assert.deepEqual(R.rowOffers(acct({ kind: 'key', found: false }), true).menu, ['rename', 'replace-key', 'remove'], 'in use or not');
  assert.deepEqual(R.rowOffers(acct({ engine: 'codex', kind: 'key', found: false }), false).menu, ['rename', 'replace-key', 'remove'], 'an OpenAI key pasted into Canopy, the same');
  assert.deepEqual([R.isPastedKey(acct({ kind: 'key', found: false })), R.isPastedKey(acct({ engine: 'codex', kind: 'key', found: false })), R.isPastedKey(acct({ engine: 'codex', kind: 'key', found: true })), R.isPastedKey(acct({ kind: 'plan', found: false })), R.isPastedKey(null)],
    [true, true, false, false, false]);
  // The logins the tools hold themselves: a plan, a Console sign-in, the environment's, and a key Codex holds.
  for (const own of [acct({ kind: 'plan' }), acct({ kind: 'console' }), acct({ kind: 'external' }), acct({ engine: 'codex', kind: 'key', found: true }), acct({ engine: 'codex', kind: 'plan' })]) {
    for (const inUse of [true, false]) assert.deepEqual(R.rowOffers(own, inUse).menu, ['rename'], `${own.engine} ${own.kind}`);
  }
  // A sign-in in a folder of its own (to come) is not removed by forgetting a key.
  assert.deepEqual(R.rowOffers(acct({ kind: 'plan', found: false }), false).menu, ['rename']);
});

test('a key that needs you offers the one thing that fixes it', () => {
  const key = (state, over = {}) => R.rowOffers(acct({ kind: 'key', found: false, state, ...over }), true);
  assert.equal(key('invalid-key').fix, 'replace-key');
  assert.equal(key('locked').fix, 'retry');
  for (const state of ['ok', 'unknown', 'checking', 'signed-out', 'missing', 'blocked']) assert.equal(key(state).fix, null, state);
  assert.deepEqual([key('invalid-key', { engine: 'codex' }).fix, key('locked', { engine: 'codex' }).fix, key('ok', { engine: 'codex' }).fix], ['replace-key', 'retry', null], 'an OpenAI key, the same');
  // Not for a login the tool holds: fixing a sign-in is the tool's own sign-in, not a paste.
  for (const state of ['invalid-key', 'locked', 'signed-out']) {
    assert.equal(R.rowOffers(acct({ kind: 'console', state }), true).fix, null);
    assert.equal(R.rowOffers(acct({ engine: 'codex', kind: 'key', found: true, state }), true).fix, null);
  }
});

test('an offer near a plan’s limit names only accounts billed per use, never another plan', () => {
  const list = [
    { id: 'max', ...acct({ kind: 'plan' }) }, { id: 'max-2', ...acct({ kind: 'plan', found: false }) },
    { id: 'console', ...acct({ kind: 'console' }) }, { id: 'key', ...acct({ kind: 'key', found: false }) },
    { id: 'bad-key', ...acct({ kind: 'key', found: false, state: 'invalid-key' }) }, { id: 'locked-key', ...acct({ kind: 'key', found: false, state: 'locked' }) },
    { id: 'signed-out-console', ...acct({ kind: 'console', found: false, state: 'signed-out' }) },
    { id: 'env', ...acct({ kind: 'external' }) },
    { id: 'codex-key', ...acct({ engine: 'codex', kind: 'key' }) }, { id: 'codex-plan', ...acct({ engine: 'codex', kind: 'plan' }) },
  ];
  const ids = (engine, inUse) => R.perUseAlternatives(list, engine, inUse).map((a) => a.id);
  assert.deepEqual(ids('claude', 'max'), ['console', 'key'], 'on a plan: the Console sign-in and the key that work');
  assert.deepEqual(ids('claude', 'key'), ['console'], 'not the one in use');
  assert.deepEqual(ids('claude', null), ['console', 'key']);
  assert.ok(!ids('claude', 'max').some((id) => id.startsWith('max')), 'never a plan, whichever plan is in use');
  assert.deepEqual(ids('codex', 'codex-plan'), ['codex-key'], 'near a ChatGPT plan’s limit: an OpenAI key, never Claude’s accounts');
  assert.deepEqual(ids('codex', 'codex-key'), [], 'and never the plan');
  assert.equal(R.limitOffer(list, 'codex', 'codex-plan').id, 'codex-key');
  assert.equal(R.limitOffer(list, 'codex', 'codex-key'), null);
  assert.deepEqual(R.perUseAlternatives([], 'claude', 'max'), []);

  // A login the environment supplies counts only when it is plainly an API key: a token may be a plan's, and a
  // cloud provider is not Anthropic's billing at all.
  const env = (via) => [{ id: 'max', ...acct({ kind: 'plan' }) }, { id: 'env', ...acct({ kind: 'external', via }) }];
  for (const via of ['ANTHROPIC_API_KEY', 'apiKeyHelper']) assert.deepEqual(R.perUseAlternatives(env(via), 'claude', 'max').map((a) => a.id), ['env'], via);
  for (const via of ['token', 'bedrock', 'vertex', 'gateway', null, undefined]) assert.deepEqual(R.perUseAlternatives(env(via), 'claude', 'max'), [], String(via));
  // The one account the offer names (usage.test.mjs holds the rest of it): a pasted key first, and never a plan.
  assert.equal(R.limitOffer(list, 'claude', 'max').id, 'key');
  assert.equal(R.limitOffer(list.filter((a) => a.kind !== 'key'), 'claude', 'max').id, 'console');
  assert.equal(R.limitOffer(list.filter((a) => a.kind === 'plan'), 'claude', 'max'), null);
  for (const inUse of ['max', 'max-2', 'key', 'console', null]) assert.notEqual(R.limitOffer(list, 'claude', inUse)?.kind, 'plan', String(inUse));
});

test('a maker has one name on screen, in Settings and in the Usage tab alike', () => {
  assert.deepEqual(R.MAKER, { claude: 'Claude', codex: 'Codex' });
  assert.deepEqual(R.MAKER, USAGE_MAKER);
});

test('a Claude sign-in token is refused where it is typed, in the words main uses, and nothing else is', () => {
  const tokens = [`sk-ant-oat01-${BODY}`, `sk-ant-ort01-${BODY}`, `sk-ant-sid01-${BODY}`, `SK-ANT-OAT01-${BODY}`, `  sk-ant-oat01-${BODY}`, `"sk-ant-oat01-${BODY}"`, `'sk-ant-ort01-${BODY}`, 'sk-ant-oat'];
  for (const text of tokens) {
    assert.equal(R.isSignInToken(text), true, text);
    assert.equal(keyShape('claude', text).code, 'plan-token', `main agrees about ${text.slice(0, 16)}`);
  }
  assert.equal(R.SIGN_IN_TOKEN, keyShape('claude', `sk-ant-oat01-${BODY}`).message, 'one wording, wherever it is refused');
  // Everything else goes to main, which decides.
  for (const text of [`sk-ant-api03-${BODY}`, `sk-ant-admin01-${BODY}`, 'sk-proj-abc', 'hello', '', ' ', `my token is sk-ant-oat01-${BODY}`]) assert.equal(R.isSignInToken(text), false, text);
});

test('the paste sheet says whose key it takes, and an OpenAI key says what it leaves alone', () => {
  assert.deepEqual(R.keySheetWords('claude'), {
    title: 'Paste an API key', line: 'An Anthropic API key from the Claude Console. Chats on it are billed per use.', placeholder: 'sk-ant-api…',
    note: 'Canopy checks it with Anthropic, then keeps it in your Keychain. Only its last four characters are shown.',
  });
  assert.deepEqual(R.keySheetWords('codex'), {
    title: 'Paste an API key', line: 'An OpenAI API key from the OpenAI Platform. Chats on it are billed per use, and Codex’s own login stays as it is.', placeholder: 'sk-…',
    note: 'Canopy checks it with OpenAI, then keeps it in your Keychain. Only its last four characters are shown.',
  });
  assert.deepEqual([R.keySheetWords('claude', { label: 'Work key' }).title, R.keySheetWords('claude', { label: 'Work key' }).line],
    ['Replace key', 'Paste another Anthropic API key for Work key. The one it has now stays until the new one checks out.']);
  assert.equal(R.keySheetWords('codex', { label: 'API key ••••7Hq2' }).line, 'Paste another OpenAI API key for API key ••••7Hq2. The one it has now stays until the new one checks out.');
  for (const none of [null, undefined]) assert.equal(R.keySheetWords('codex', none).title, 'Paste an API key');
  // The makers are the ones main checks a key with (account-keys.mjs): the sheet never names another.
  assert.match(keyShape('codex', 'hello').message, /OpenAI API key/);
  assert.match(keyShape('claude', 'hello').message, /Anthropic API key/);
});

test('removing a pasted key says what goes and what does not, for either maker', () => {
  assert.deepEqual(R.removeKeyQuestion({ engine: 'claude', label: 'Work key' }, false), {
    title: 'Remove “Work key”?',
    body: 'Canopy forgets this key. Chats that are open on it stop when they next restart. The key itself keeps working elsewhere until you delete it in the Claude Console.',
  });
  assert.equal(R.removeKeyQuestion({ engine: 'claude', label: 'Work key' }, true).body,
    'Canopy forgets this key. New chats go back to the login Claude Code has. Chats that are open on it stop when they next restart. The key itself keeps working elsewhere until you delete it in the Claude Console.');
  // Codex keeps a chat on the kind of account it began on: that is said before the key goes.
  assert.deepEqual(R.removeKeyQuestion({ engine: 'codex', label: 'API key ••••7Hq2' }, true), {
    title: 'Remove “API key ••••7Hq2”?',
    body: 'Canopy forgets this key. New chats go back to the login Codex has. Chats that began on it stop when they next restart, and carry on only with another key in use. The key itself keeps working elsewhere until you delete it on the OpenAI Platform.',
  });
  assert.ok(!R.removeKeyQuestion({ engine: 'codex', label: 'x' }, false).body.includes('New chats go back'));
});

test('a reply that did not work is one line a person can read', () => {
  assert.equal(R.refusal({ ok: true }), null);
  assert.equal(R.refusal({ ok: true, id: 'claude-key-1', message: 'ignored' }), null);
  assert.equal(R.refusal({ ok: false, code: 'rejected', message: 'Anthropic didn’t accept that key.' }), 'Anthropic didn’t accept that key.');
  // Main could not handle the call at all, or did not answer: never its own error text, never nothing.
  for (const r of [{ error: 'TypeError: x is not a function' }, { ok: false }, { ok: false, message: '' }, { ok: false, message: 7 }, {}, null, undefined]) {
    assert.equal(R.refusal(r), 'That didn’t work. Try again.', JSON.stringify(r));
  }
});

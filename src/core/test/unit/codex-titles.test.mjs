// Names for Codex chats (src/codex-titles.mjs). Codex's helper and Canopy's chat list are stand-ins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexTitler, cleanTitle, firstExchange, pickModel, titleHelper, titlePrompt } from '../../../codex-titles.mjs';

const you = (text) => ({ type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] });
const codex = (text) => ({ type: 'agentMessage', text });
const turn = (...items) => ({ items });

test('titlePrompt is Codex\'s own title prompt with the exchange, clipped', () => {
  const p = titlePrompt({ user: 'fix the login loop', reply: 'x'.repeat(2000) });
  assert.match(p, /^Generate a concise, single-line task title of at most \d+ characters/);
  assert.match(p, /Start with an imperative verb/);
  assert.match(p, /User: fix the login loop\nAssistant: x+…$/);
  assert.ok(p.length < 1500);
});

test('cleanTitle keeps the first line and drops quotes, markdown and a full stop', () => {
  assert.equal(cleanTitle('Fix Safari login loop\n'), 'Fix Safari login loop');
  assert.equal(cleanTitle('"**Plan the Q3 launch.**"'), 'Plan the Q3 launch');
  assert.equal(cleanTitle('Title: Clean up imports'), 'Clean up imports');
  assert.equal(cleanTitle('\n\n  '), null);
  assert.equal(cleanTitle(null), null);
});

test('firstExchange skips small talk and pairs the first real ask with the turn\'s last answer', () => {
  const turns = [
    turn(you('hey, how is it going'), codex('Hey! What are we working on?')),
    turn(you('Rename the export button to Download'), codex('Looking at the button.'), codex('Done: the button says Download.')),
  ];
  assert.deepEqual(firstExchange(turns), { user: 'Rename the export button to Download', reply: 'Done: the button says Download.' });
  assert.equal(firstExchange([turn(you('hey'), codex('Hi!'))]), null);
  assert.equal(firstExchange([turn(you('fix it'))]), null, 'no answer yet');
  assert.equal(firstExchange(null), null);
});

test('pickModel prefers a Luna at its lowest effort, else the default model', () => {
  const rows = [
    { value: 'gpt-6.1-sol', isDefault: true, supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'gpt-6-luna', supportedEffortLevels: ['minimal', 'low', 'medium'] },
    { value: 'codex-auto-review', hidden: true },
  ];
  assert.deepEqual(pickModel(rows), { model: 'gpt-6-luna', effort: 'minimal' });
  assert.deepEqual(pickModel(rows.filter((r) => !/luna/.test(r.value))), { model: 'gpt-6.1-sol', effort: 'low' });
  assert.deepEqual(pickModel([]), { model: null, effort: null });
});

function setup({ entry = { title: 'Rename the export button to Download' }, turns, answer = { ok: true, title: 'Rename export button' } } = {}) {
  const list = new Map([['c1', { ...entry }]]);
  const calls = { turns: 0, suggest: [], renamed: [], titled: [] };
  const service = {
    turns: async () => { calls.turns++; return { ok: true, turns: turns ?? [turn(you('Rename the export button to Download'), codex('Done.'))], truncated: false }; },
    models: async () => ({ ok: true, models: [{ value: 'gpt-6-luna', supportedEffortLevels: ['low'] }] }),
    suggestTitle: async (prompt, opts) => { calls.suggest.push({ prompt, opts }); return answer; },
  };
  const chats = { get: (id) => (list.has(id) ? { ...list.get(id) } : null), markNamed: (id, by) => { list.get(id).named = by; } };
  const t = new CodexTitler({
    service, chats, rename: async (id, title) => { calls.renamed.push([id, title]); list.get(id).title = title; },
    onTitled: (id, title) => calls.titled.push([id, title]),
  });
  return { t, list, calls };
}

test('a Codex chat is named once, after its first real exchange, on Luna, and remembered as Canopy\'s name', async () => {
  const { t, list, calls } = setup();
  await t.afterTurn('c1');
  assert.deepEqual(calls.renamed, [['c1', 'Rename export button']]);
  assert.deepEqual(calls.titled, [['c1', 'Rename export button']]);
  assert.deepEqual(calls.suggest[0].opts, { model: 'gpt-6-luna', effort: 'low' });
  assert.equal(list.get('c1').named, 'canopy');
  await t.afterTurn('c1');
  assert.equal(calls.suggest.length, 1, 'one try per chat');
});

test('a chat you named is never renamed: by the list\'s record, or a name that isn\'t the first message', async () => {
  const a = setup({ entry: { title: 'My name', named: 'you' } });
  await a.t.afterTurn('c1');
  assert.equal(a.calls.turns, 0);
  assert.equal(a.calls.suggest.length, 0);
  const b = setup({ entry: { title: 'Chip cleanup' } }); // from before Canopy kept track
  await b.t.afterTurn('c1');
  assert.equal(b.calls.suggest.length, 0);
  assert.equal(b.list.get('c1').named, 'you');
});

test('small talk waits for the next turn; a long old chat and a failed answer are left alone', async () => {
  const s = setup({ entry: { title: 'hey, how is it going' }, turns: [turn(you('hey, how is it going'), codex('Hey!'))] });
  await s.t.afterTurn('c1');
  assert.equal(s.calls.suggest.length, 0);
  assert.equal(s.t.done.has('c1'), false, 'tried again after the next turn');

  const old = setup();
  old.t.service.turns = async () => ({ ok: true, turns: [], truncated: true });
  await old.t.afterTurn('c1');
  assert.equal(old.calls.suggest.length, 0);

  const failed = setup({ answer: { ok: false, code: 'timeout', message: 'Codex did not answer in time.' } });
  await failed.t.afterTurn('c1');
  assert.equal(failed.calls.renamed.length, 0);
  assert.equal(failed.list.get('c1').named, undefined, 'still yours to name, or Canopy\'s next run');
});

test('a chat you rename while its name is being made keeps your name', async () => {
  const { t, list, calls } = setup();
  t.service.suggestTitle = async () => { list.get('c1').named = 'you'; list.get('c1').title = 'Mine'; return { ok: true, title: 'Theirs' }; };
  await t.afterTurn('c1');
  assert.equal(calls.renamed.length, 0);
  assert.equal(list.get('c1').title, 'Mine');
});

// ---- edit and resend: the chat's first message is replaced ----

const AUTH = [turn(you('explain the auth flow'), codex('It starts at the login page.'))];

test('after its first message is edited, a chat Canopy named is named again from the new first exchange; a name you gave stays', async () => {
  const { t, list, calls } = setup();
  await t.afterTurn('c1');
  assert.equal(list.get('c1').named, 'canopy');
  // The first message is edited: the conversation is about something else now.
  t.service.turns = async () => ({ ok: true, turns: AUTH, truncated: false });
  t.service.suggestTitle = async (prompt) => { calls.suggest.push({ prompt }); return { ok: true, title: 'Explain auth flow' }; };
  await t.afterTurn('c1');
  assert.equal(calls.renamed.length, 1, 'never without being told the first message changed');
  t.again('c1');
  await t.afterTurn('c1');
  assert.deepEqual(calls.renamed.at(-1), ['c1', 'Explain auth flow']);
  assert.match(calls.suggest.at(-1).prompt, /User: explain the auth flow\nAssistant: It starts at the login page\./);
  assert.deepEqual([list.get('c1').title, list.get('c1').named], ['Explain auth flow', 'canopy'], 'Canopy\'s old name is not taken for one you gave');
  await t.afterTurn('c1');
  assert.equal(calls.renamed.length, 2, 'once per first message');

  // A name you gave it: nothing is asked, before or after.
  const mine = setup({ entry: { title: 'Mine', named: 'you' } });
  mine.t.again('c1');
  await mine.t.afterTurn('c1');
  assert.deepEqual([mine.calls.turns, mine.calls.suggest.length, mine.list.get('c1').title], [0, 0, 'Mine']);
  // You name it between the edit and the next reply: yours stays.
  const between = setup();
  await between.t.afterTurn('c1');
  between.t.again('c1');
  Object.assign(between.list.get('c1'), { title: 'Mine', named: 'you' });
  await between.t.afterTurn('c1');
  assert.deepEqual([between.calls.renamed.length, between.list.get('c1').title], [1, 'Mine']);
  assert.doesNotThrow(() => { between.t.again(null); between.t.again('nope'); });
});

test('a try under way when the first message is edited is dropped: it may have read the conversation as it was', async () => {
  // Not named yet: the first reply was still being written when its message was edited. The stopped reply's end
  // starts a try, and the edit lands while Codex is being asked for the turns.
  const { t, list, calls } = setup({ entry: { title: 'fix the login loop' } });
  let answerTurns;
  t.service.turns = () => new Promise((resolve) => { answerTurns = () => resolve({ ok: true, turns: AUTH, truncated: false }); });
  const early = t.afterTurn('c1');
  list.get('c1').title = 'explain the auth flow'; // the list follows the new first message (CodexChats.firstMessageEdited)
  t.again('c1');
  answerTurns();
  await early;
  assert.equal(list.get('c1').named, undefined, 'the old stand-in name beside the new first message is not "a name you gave"');
  assert.deepEqual([calls.suggest.length, t.done.has('c1')], [0, false]);
  // The edited message's own turn ends: now the chat is named, from the new exchange.
  t.service.turns = async () => ({ ok: true, turns: AUTH, truncated: false });
  await t.afterTurn('c1');
  assert.equal(calls.renamed.length, 1);
  assert.match(calls.suggest[0].prompt, /User: explain the auth flow/);
  assert.equal(list.get('c1').named, 'canopy');

  // A title that comes back after the edit was made for words that are gone: it is not used, and the next turn tries again.
  const late = setup();
  late.t.service.suggestTitle = async () => { late.t.again('c1'); return { ok: true, title: 'About the old words' }; };
  await late.t.afterTurn('c1');
  assert.deepEqual([late.calls.renamed.length, late.list.get('c1').named, late.t.done.has('c1')], [0, undefined, false]);
});

// ---- which account is asked ----

test('titleHelper: a chat is named on its own account, and on no other', () => {
  const own = { name: 'Codex as it finds itself' }, onKey = { name: 'the helper for the key in use' };
  // Codex's own login (a chat from the Codex app or the terminal too: nothing says it began on a key).
  assert.equal(titleHelper({ began: null, keyInUse: null, own, onKey }), own);
  assert.equal(titleHelper({ began: null, keyInUse: 'codex-key-1', own, onKey }), own, 'whatever new chats use now');
  // A chat begun on a pasted key: through that key's helper, which exists while that key is the one in use.
  assert.equal(titleHelper({ began: 'codex-key-1', keyInUse: 'codex-key-1', own, onKey }), onKey);
  assert.equal(titleHelper({ began: 'codex-key-1', keyInUse: null, own, onKey }), null, 'never on Codex’s own login');
  assert.equal(titleHelper({ began: 'codex-key-1', keyInUse: 'codex-key-2', own, onKey }), null, 'nor on another key');
  assert.equal(titleHelper({ began: 'codex-key-1', keyInUse: 'codex-key-1', own }), null);
  assert.equal(titleHelper(), null);
});

test('the model is asked through the helper for the chat’s account; with none, the chat waits and nothing is asked', async () => {
  const { t, list, calls } = setup();
  const asked = [];
  const keyHelper = {
    models: async () => ({ ok: true, models: [{ value: 'gpt-6-luna', supportedEffortLevels: ['low'] }] }),
    suggestTitle: async (prompt, opts) => { asked.push({ prompt, opts }); return { ok: true, title: 'Rename export button' }; },
  };
  let helper = null; // the chat began on a key that is not the one in use: no helper runs on it
  const seen = [];
  t.helperFor = (id) => { seen.push(id); return helper; };
  await t.afterTurn('c1');
  assert.deepEqual([seen, calls.suggest.length, asked.length, calls.renamed.length, t.done.has('c1')], [['c1'], 0, 0, 0, false]);
  assert.equal(list.get('c1').named, undefined, 'and it is not taken for a name of yours');
  // Its key is in use again: after the next turn it is named, through that key's helper and not through Codex's own.
  helper = keyHelper;
  await t.afterTurn('c1');
  assert.deepEqual([asked.length, calls.suggest.length], [1, 0], 'Codex’s own login was asked nothing');
  assert.deepEqual(asked[0].opts, { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual([calls.renamed, list.get('c1').named], [[['c1', 'Rename export button']], 'canopy']);
  assert.equal(calls.turns, 2, 'the chat itself is read through the one helper that reads: no model is asked for that');
});

// New models (renderer/src/lib/release-rules.ts): what counts as a release, how releases become sidebar cards and
// what they say, "New" in Settings for a week, and what is saved. Plain TypeScript run by node: no window, no Codex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as M from '../../../../renderer/src/lib/model-rules.ts';
import * as R from '../../../../renderer/src/lib/release-rules.ts';

// Claude Code's picker names the version in the description ("Opus 5.6 · Best for…"), as it does today.
const claude = (value, resolved, name) => ({ value, resolvedModel: resolved, displayName: name, description: `${name} ${resolved.replace(/^claude-[a-z]+-/, '').replace('-', '.')} · About it` });
const openai = (value, label) => ({
  value, displayName: label, description: '', engine: 'codex', maker: 'openai',
  supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], defaultEffort: 'low', supportsFastMode: true, isDefault: false,
});
const CLAUDE = [claude('opus', 'claude-opus-5-5', 'Opus'), claude('fable[1m]', 'claude-fable-5-2', 'Fable'), claude('haiku', 'claude-haiku-5-5', 'Haiku')];
const OPENAI = [openai('gpt-6.1-sol', 'GPT-6.1-Sol'), openai('gpt-6-astra', 'GPT-6-Astra'), openai('gpt-5.6-terra', 'GPT-5.6-Terra'), openai('gpt-5.5', 'GPT-5.5')];
const all = (c = CLAUDE, o = OPENAI) => M.allModels(c, o);
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
const seen = (lists = all()) => R.noticeReleases(R.NO_RELEASES, lists, T0);
const menu = (list) => new Set(M.menuRows(list).map((m) => m.key));
const cards = (state, list) => R.releaseCards(state, list, menu(list));
const byKey = (list, key) => list.find((m) => m.key === key);

test('the first list a maker gives is what there is: remembered, no card', () => {
  const s = seen();
  assert.deepEqual(s.notes, []);
  assert.deepEqual(s.known, ['claude', 'openai']);
  assert.deepEqual(s.newest['openai:gpt-sol'], [6, 1]);
  assert.deepEqual(s.newest['claude:opus'], [5, 5]);
  assert.deepEqual(s.arrived, {});
  assert.equal(R.noticeReleases(s, all(), T0 + 1), s, 'the same list again changes nothing (same object back)');
});

test('GPT-6.2-Sol and Astra arrive together: one card, in place of the two they replaced in the menu', () => {
  const later = all(CLAUDE, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), openai('gpt-6.2-astra', 'GPT-6.2-Astra'), ...OPENAI]);
  const s = R.noticeReleases(seen(), later, T0 + DAY);
  assert.equal(s.notes.length, 1);
  assert.deepEqual(s.notes[0].keys, ['openai:gpt-6.2-sol', 'openai:gpt-6.2-astra']);
  const [card] = cards(s, later);
  assert.equal(card.title, 'GPT-6.2 is out');
  assert.equal(card.body, 'Sol and Astra are in your model menu now, in place of 6.1-Sol and 6-Astra.');
  assert.equal(card.tryKey, 'openai:gpt-6.2-sol');
  assert.equal(card.tryLabel, 'GPT-6.2-Sol');
  assert.ok(R.isNew(s, byKey(later, 'openai:gpt-6.2-sol'), T0 + DAY), 'Settings says New');
  assert.ok(!R.isNew(s, byKey(later, 'openai:gpt-6.1-sol'), T0 + DAY));
});

test('Opus 5.6: a single model names itself, and the long-context variant shipping with Fable is one release', () => {
  const c = [claude('opus', 'claude-opus-5-6', 'Opus'), claude('fable[1m]', 'claude-fable-5-2', 'Fable'), claude('haiku', 'claude-haiku-5-5', 'Haiku')];
  const s = R.noticeReleases(seen(), all(c), T0 + DAY);
  const [card] = cards(s, all(c));
  assert.equal(card.title, 'Opus 5.6 is out');
  assert.equal(card.body, 'It is in your model menu now, in place of Opus 5.5.');
  const both = [claude('opus', 'claude-opus-5-5', 'Opus'), claude('fable', 'claude-fable-5-3', 'Fable'), claude('fable[1m]', 'claude-fable-5-3', 'Fable'), claude('haiku', 'claude-haiku-5-5', 'Haiku')];
  const f = R.noticeReleases(seen(), all(both), T0 + DAY);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].keys.length, 1, 'Fable and Fable 1M are one card line');
});

test('a model outside the menu says where it is; a release outside the menu while another is in it says the menu', () => {
  const later = all(CLAUDE, [...OPENAI, openai('gpt-6.1-terra', 'GPT-6.1 Terra')]);
  const s = R.noticeReleases(seen(), later, T0 + DAY);
  assert.deepEqual(cards(s, later).map((c) => [c.title, c.body]), [['GPT-6.1 Terra is out', 'It is in the model menu, under More models.']]);
  const mixed = all(CLAUDE, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), ...OPENAI, openai('gpt-6.1-terra', 'GPT-6.1 Terra')]);
  const m = R.noticeReleases(seen(), mixed, T0 + DAY);
  assert.deepEqual(cards(m, mixed).map((c) => [c.title, c.body]), [['New OpenAI models', 'GPT-6.2-Sol and GPT-6.1 Terra are in the model menu.']]);
});

test('an older family a list shows for the first time (another account) is not news; a new family of the newest generation is', () => {
  const s = R.noticeReleases(seen(), all(CLAUDE, [...OPENAI, openai('gpt-5.5-pro', 'GPT-5.5-Pro')]), T0 + DAY);
  assert.deepEqual(s.notes, []);
  assert.deepEqual(s.newest['openai:gpt-pro'], [5, 5], 'remembered, so a later 5.6-Pro is news');
  const nova = all(CLAUDE, [...OPENAI, openai('gpt-6-nova', 'GPT-6-Nova')]);
  assert.deepEqual(cards(R.noticeReleases(seen(), nova, T0 + DAY), nova).map((c) => c.title), ['GPT-6-Nova is out']);
});

test('a maker missing from a list (Codex signed out) is skipped, and nothing it had is forgotten', () => {
  const s = seen();
  const out = R.noticeReleases(s, all(CLAUDE, []), T0 + DAY);
  assert.equal(out, s);
  const back = R.noticeReleases(out, all(), T0 + 2 * DAY);
  assert.deepEqual(back.notes, [], 'signing back in to the same models is not a release');
});

test('a model that arrives while its maker\'s card is up joins that card; another maker gets its own, newest first', () => {
  const sol = all(CLAUDE, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), ...OPENAI]);
  const one = R.noticeReleases(seen(), sol, T0 + DAY);
  const both = all(CLAUDE, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), openai('gpt-6.2-astra', 'GPT-6.2-Astra'), ...OPENAI]);
  const two = R.noticeReleases(one, both, T0 + DAY + 60_000);
  assert.equal(two.notes.length, 1);
  assert.equal(cards(two, both)[0].title, 'GPT-6.2 is out');
  const opus = [claude('opus', 'claude-opus-5-6', 'Opus'), ...CLAUDE.slice(1)];
  const three = R.noticeReleases(two, all(opus, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), openai('gpt-6.2-astra', 'GPT-6.2-Astra'), ...OPENAI]), T0 + 2 * DAY);
  assert.deepEqual(cards(three, all(opus, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), openai('gpt-6.2-astra', 'GPT-6.2-Astra'), ...OPENAI])).map((c) => c.title), ['Opus 5.6 is out', 'GPT-6.2 is out']);
});

test('put away, a card never comes back; "New" lasts a week', () => {
  const later = all(CLAUDE, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), ...OPENAI]);
  const s = R.noticeReleases(seen(), later, T0);
  const gone = R.dismissRelease(s, s.notes[0].id);
  assert.deepEqual(gone.notes, []);
  assert.equal(R.dismissRelease(gone, 'nope'), gone);
  assert.deepEqual(R.noticeReleases(gone, later, T0 + DAY).notes, []);
  assert.ok(R.isNew(gone, byKey(later, 'openai:gpt-6.2-sol'), T0 + 6 * DAY));
  assert.ok(!R.isNew(gone, byKey(later, 'openai:gpt-6.2-sol'), T0 + 7 * DAY));
  assert.deepEqual(R.noticeReleases(gone, later, T0 + 8 * DAY).arrived, {}, 'forgotten after the week');
});

test('a card whose models are no longer listed is not shown; a model with no version is never news', () => {
  const later = all(CLAUDE, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), ...OPENAI]);
  const s = R.noticeReleases(seen(), later, T0);
  assert.deepEqual(cards(s, all()), []);
  assert.equal(s.notes.length, 1, 'still saved');
  const odd = R.noticeReleases(seen(), all(CLAUDE, [...OPENAI, openai('codex-mini-latest', 'codex-mini-latest')]), T0);
  assert.deepEqual(odd.notes, []);
});

test('what was saved is read back; anything malformed is dropped, not trusted', () => {
  const later = all(CLAUDE, [openai('gpt-6.2-sol', 'GPT-6.2-Sol'), ...OPENAI]);
  const s = R.noticeReleases(seen(), later, T0);
  assert.deepEqual(R.readReleases(JSON.parse(JSON.stringify(s))), s);
  for (const bad of [null, 3, 'x', [], { newest: 1, known: 'claude', notes: {}, arrived: [] }]) assert.deepEqual(R.readReleases(bad), { newest: {}, known: [], notes: [], arrived: {} });
  const mixed = R.readReleases({ newest: { 'openai:gpt-sol': [6, 'x'], 'claude:opus': [5, 5] }, known: ['claude', 'bard', 'claude'], notes: [{ id: 'a', maker: 'openai', keys: [], at: 1 }, { id: 'b', maker: 'openai', keys: ['openai:x'], at: 2 }], arrived: { k: 'soon', j: 5 } });
  assert.deepEqual(mixed, { newest: { 'claude:opus': [5, 5] }, known: ['claude'], notes: [{ id: 'b', maker: 'openai', keys: ['openai:x'], replaced: [], at: 2 }], arrived: { j: 5 } });
});

test('Claude\'s "opus" back on an older version (another account): no "New", and its card waits', () => {
  const c56 = [claude('opus', 'claude-opus-5-6', 'Opus'), ...CLAUDE.slice(1)];
  const s = R.noticeReleases(seen(), all(c56), T0);
  assert.ok(R.isNew(s, byKey(all(c56), 'claude:opus'), T0 + DAY));
  assert.ok(!R.isNew(s, byKey(all(), 'claude:opus'), T0 + DAY), 'opus running 5.5 is not the release');
  assert.deepEqual(cards(s, all()), []);
  assert.equal(R.noticeReleases(s, all(), T0 + DAY).notes.length, 1, 'still saved: back when 5.6 is');
});

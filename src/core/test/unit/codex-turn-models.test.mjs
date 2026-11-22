// Which model ran each turn of a Codex chat (src/codex-turn-models.mjs): noted as turns end, put back on a reopened
// chat's turn ends, kept within bounds, and read back from what was saved. No Codex, no window, no disk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHATS_MAX, CodexTurnModels, TURNS_PER_CHAT } from '../../../codex-turn-models.mjs';

const CHAT = '00000000-0000-7000-8000-432d1c714b94';
function make(saved) {
  const box = { saved, saves: 0, t: 1000 };
  const models = new CodexTurnModels({ load: () => box.saved, save: (all) => { box.saved = JSON.parse(JSON.stringify(all)); box.saves += 1; }, now: () => box.t });
  return { models, box };
}
const end = (turnId, extra = {}) => ({ kind: 'turn-end', turnId, model: null, history: true, ...extra });

test('a turn\'s model is noted when it ends and put back when the chat is read again', () => {
  const { models, box } = make();
  assert.equal(models.note(CHAT, 'turn-1', 'gpt-6.1-sol'), true);
  assert.equal(models.note(CHAT, 'turn-2', 'gpt-6-luna'), true);
  assert.deepEqual(box.saved, { [CHAT]: { at: 1000, turns: [['turn-1', 'gpt-6.1-sol'], ['turn-2', 'gpt-6-luna']] } });
  const events = [{ kind: 'user-text', text: 'hi' }, end('turn-1'), end('turn-2'), end('turn-3')];
  const stamped = models.stamp(CHAT, events);
  assert.deepEqual(stamped.map((e) => e.model), [undefined, 'gpt-6.1-sol', 'gpt-6-luna', null], 'two models in one chat each show on their own turns; an unknown turn names none');
  assert.equal(events[1].model, null, 'the events handed in are not changed');
  assert.equal(stamped[0], events[0]);
  assert.equal(models.modelOf(CHAT, 'turn-2'), 'gpt-6-luna');
  assert.equal(models.modelOf(CHAT, 'nope'), null);
});

test('a turn that already names its model keeps it, and a chat with nothing noted comes back as it was', () => {
  const { models } = make();
  models.note(CHAT, 'turn-1', 'gpt-6.1-sol');
  const live = end('turn-1', { model: 'gpt-6-luna', history: undefined });
  assert.equal(models.stamp(CHAT, [live])[0], live);
  const other = [end('turn-1')];
  assert.equal(models.stamp('another-chat', other), other);
  assert.equal(models.stamp(CHAT, 'not a list'), 'not a list');
});

test('the same turn noted twice is one row; a different model for it replaces the first', () => {
  const { models, box } = make();
  models.note(CHAT, 'turn-1', 'gpt-6.1-sol');
  assert.equal(models.note(CHAT, 'turn-1', 'gpt-6.1-sol'), false);
  assert.equal(box.saves, 1, 'nothing changed, so nothing is saved');
  assert.equal(models.note(CHAT, 'turn-1', 'gpt-6-luna'), true);
  assert.deepEqual(box.saved[CHAT].turns, [['turn-1', 'gpt-6-luna']]);
});

test('what is saved is read back, and anything malformed in it is left out', () => {
  const { models } = make({
    [CHAT]: { at: 5, turns: [['turn-1', 'gpt-6.1-sol'], ['turn-2'], 'x', [3, 'm'], ['turn-3', '']] },
    broken: 'nope', empty: { at: 1, turns: [] }, '': { at: 1, turns: [['a', 'b']] },
  });
  assert.deepEqual(models.read(), { [CHAT]: { at: 5, turns: [['turn-1', 'gpt-6.1-sol']] } });
  assert.equal(models.stamp(CHAT, [end('turn-1')])[0].model, 'gpt-6.1-sol');
  assert.deepEqual(make('garbage').models.read(), {});
  assert.deepEqual(new CodexTurnModels({ load: () => { throw new Error('disk'); } }).read(), {});
});

test('only the newest turns of the newest chats are kept', () => {
  const { models, box } = make();
  for (let i = 0; i < TURNS_PER_CHAT + 5; i++) models.note(CHAT, `turn-${i}`, 'gpt-6.1-sol');
  assert.equal(box.saved[CHAT].turns.length, TURNS_PER_CHAT);
  assert.equal(box.saved[CHAT].turns[0][0], 'turn-5', 'the oldest turns went');
  for (let i = 0; i < CHATS_MAX + 3; i++) { box.t += 1; models.note(`chat-${i}`, 'turn-1', 'gpt-6-luna'); }
  assert.equal(Object.keys(box.saved).length, CHATS_MAX);
  assert.ok(!(CHAT in box.saved), 'the chat touched longest ago went');
  assert.ok(`chat-${CHATS_MAX + 2}` in box.saved);
});

test('nothing here throws: bad input is ignored and a failed save keeps the note in memory', () => {
  const models = new CodexTurnModels({ load: () => null, save: () => { throw new Error('disk full'); } });
  for (const args of [[null, 't', 'm'], [CHAT, null, 'm'], [CHAT, 't', null], [CHAT, 't', 5], [CHAT, '', 'm'], [CHAT, 'x'.repeat(300), 'm']]) assert.equal(models.note(...args), false);
  assert.equal(models.note(CHAT, 'turn-1', 'gpt-6.1-sol'), true);
  assert.equal(models.modelOf(CHAT, 'turn-1'), 'gpt-6.1-sol');
  assert.deepEqual(new CodexTurnModels().stamp(CHAT, [end('turn-1')]).map((e) => e.model), [null]);
  assert.deepEqual(models.stamp(CHAT, [null, 5, { kind: 'turn-end' }, end('turn-1')]).map((e) => e?.model), [undefined, undefined, undefined, 'gpt-6.1-sol']);
});

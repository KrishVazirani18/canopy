// chat-search.mjs: ⌘K's search inside every chat. What an edit took out of a conversation stays in the saved file, but
// it is no longer part of the chat, so it must not be found; and a conversation an edit replaced is not searched at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { searchChats } from '../../../chat-search.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-search-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const configDir = path.join(root, 'config');
const work = path.join(root, 'work');
const folder = path.join(configDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(folder, { recursive: true });

let n = 0;
const at = () => new Date(1760000000000 + ++n * 1000).toISOString();
const user = (uuid, parentUuid, text) => ({ type: 'user', uuid, parentUuid, timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
const reply = (uuid, parentUuid, text) => ({ type: 'assistant', uuid, parentUuid, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const save = (id, rows) => fs.writeFileSync(path.join(folder, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const find = (q, opts) => searchChats(q, [work], { configDir, ...opts });

test('a message that was edited away, and the reply to it, are not found; what replaced them is', async () => {
  // "tangerine" was asked about, then that message was edited to ask about "kumquat" instead.
  save('edited', [
    user('u1', null, 'tell me about citrus fruit'), reply('a1', 'u1', 'Citrus fruit covers many kinds.'),
    user('u2', 'a1', 'what about the tangerine'), reply('a2', 'u2', 'The tangerine is small and sweet.'),
    { type: 'last-prompt', lastPrompt: 'what about the tangerine' },
    user('u2b', 'a1', 'what about the kumquat'), reply('a2b', 'u2b', 'The kumquat is eaten whole.'),
  ]);
  assert.deepEqual(await find('tangerine'), []);
  const hits = await find('kumquat');
  assert.deepEqual(hits.map((h) => [h.sessionId, h.role, h.uuid]), [['edited', 'canopy', 'a2b'], ['edited', 'you', 'u2b']]);
  assert.equal((await find('citrus')).length, 2, 'what came before the edit is still part of the chat');
});

test('a chat that was never edited is searched whole, with or without links between its rows', async () => {
  save('plain', [user('p1', null, 'where is the persimmon'), reply('p2', 'p1', 'The persimmon is on the shelf.')]);
  assert.equal((await find('persimmon')).length, 2);
  // An older transcript: rows with ids but nothing saying what they follow.
  save('old', [
    { type: 'user', uuid: 'o1', timestamp: at(), message: { role: 'user', content: 'find the quince' } },
    { type: 'assistant', uuid: 'o2', parentUuid: 'o1', timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: 'The quince is here.' }] } },
  ]);
  assert.equal((await find('quince')).length, 2);
});

test('a conversation an edit replaced is not searched', async () => {
  save('superseded', [user('s1', null, 'the old first message about durian'), reply('s2', 's1', 'Durian it is.')]);
  assert.equal((await find('durian')).length, 2);
  assert.deepEqual(await find('durian', { skip: new Set(['superseded']) }), []);
  assert.equal((await find('persimmon', { skip: new Set(['superseded']) })).length, 2, 'only that one is left out');
});

test('a message that carried something for the model only is found by its own words, never by that', async () => {
  // What Canopy puts first in a message (core/notes.mjs, core/handoff.mjs): a block of its own, before the words.
  const note = { type: 'text', text: '<system-reminder>\n<canopy_note>\nThe user undid your changes to src/pomelo.ts. Don\'t redo them unless the user asks.\n</canopy_note>\n</system-reminder>' };
  const digest = { type: 'text', text: '<system-reminder>\n<canopy_handoff>\nThis chat continues one about the yuzu.\n</canopy_handoff>\n</system-reminder>' };
  save('noted', [
    user('n1', null, [digest, { type: 'text', text: 'carry on with the satsuma' }]), reply('n2', 'n1', 'On it.'),
    user('n3', 'n2', [note, { type: 'text', text: 'now look at the clementine' }]), reply('n4', 'n3', 'Looking.'),
    user('n5', 'n4', [note]), reply('n6', 'n5', 'Nothing was said.'),
  ]);
  assert.deepEqual((await find('clementine')).map((h) => [h.sessionId, h.role, h.uuid, h.snippet]), [['noted', 'you', 'n3', 'now look at the clementine']]);
  assert.deepEqual((await find('satsuma')).map((h) => [h.uuid, h.snippet]), [['n1', 'carry on with the satsuma']]);
  assert.deepEqual(await find('pomelo'), [], 'the note is not something that was said');
  assert.deepEqual(await find('yuzu'), [], 'nor is a moved chat\'s digest');
});

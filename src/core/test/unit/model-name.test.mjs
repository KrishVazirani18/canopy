// A model id of either maker as the name on screen (renderer/src/lib/model-name.ts): what a finished turn's footer
// says ran it. The file is plain TypeScript with no run-time imports, so node runs it as it is. The OpenAI rows are
// the ones recorded from this Mac's Codex (fixtures/codex-meta.jsonl); Claude's are shaped as Claude Code lists them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexModelInfo } from '../../codex-host.mjs';
import { modelName, shortName } from '../../../../renderer/src/lib/model-name.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
function recordedRows() {
  const all = fs.readFileSync(path.join(FIXTURES, 'codex-meta.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const asked = all.find((l) => l.dir === 'out' && l.msg.method === 'model/list');
  const answer = all.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id);
  return answer.msg.result.data.filter((m) => !m.hidden).map(codexModelInfo);
}
const CLAUDE = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $5/$25 per Mtok' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'fable[1m]', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'A description that is far too long to be the short name of anything at all' },
];
const lists = { claude: CLAUDE, openai: recordedRows() };

test('an OpenAI id is its row\'s display name', () => {
  const row = lists.openai[0];
  assert.ok(row.displayName && row.displayName !== row.value, 'the recording has real display names');
  assert.equal(modelName('codex', row.value, lists), row.displayName);
  for (const m of lists.openai) assert.equal(modelName('codex', m.value, lists), m.displayName);
});

test('a Claude id is the short name of the row it resolves to, as the model chip says it', () => {
  assert.equal(modelName('claude', 'claude-opus-5-5', lists), 'Opus 5.5', 'the named row wins over Default');
  assert.equal(modelName('claude', 'claude-fable-5-2', lists), 'Fable 5.2');
  assert.equal(modelName('claude', 'claude-haiku-5-5', lists), 'Haiku', 'a row with no short description goes by its display name');
  assert.equal(modelName('claude', 'opus', lists), 'Opus 5.5', 'a row\'s own value is found too');
  assert.equal(modelName('claude', 'claude-opus-5-5', { claude: [CLAUDE[0]] }), 'Opus 5.5', 'only Default resolves to it: the name inside its description');
  assert.equal(shortName(CLAUDE[1]), 'Opus 5.5');
  assert.equal(modelName(undefined, 'claude-opus-5-5', lists), 'Opus 5.5', 'a chat that names no engine is a Claude chat');
});

test('an id no row knows is shown as it is; no id is no name', () => {
  assert.equal(modelName('claude', 'claude-opus-4-1', lists), 'claude-opus-4-1');
  assert.equal(modelName('codex', 'gpt-retired', lists), 'gpt-retired');
  assert.equal(modelName('codex', 'claude-opus-5-5', lists), 'claude-opus-5-5', 'an id is only looked up among its own maker\'s rows');
  assert.equal(modelName('claude', lists.openai[0].value, lists), lists.openai[0].value);
  for (const id of [null, undefined, '', '  ', 5, {}]) assert.equal(modelName('claude', id, lists), '');
});

test('missing or malformed lists never throw', () => {
  for (const l of [null, undefined, {}, { claude: null, openai: null }, { claude: [null, 5, {}], openai: 'x' }]) {
    assert.equal(modelName('claude', 'claude-opus-5-5', l), 'claude-opus-5-5');
    assert.equal(modelName('codex', 'gpt-6.1-sol', l), 'gpt-6.1-sol');
  }
});

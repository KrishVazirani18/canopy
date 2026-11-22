// Chat names in Title Case (src/title-case.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleCase } from '../../../title-case.mjs';

test('plain words are capitalized, short joining words stay lowercase inside the name', () => {
  assert.equal(titleCase('Billing page copy'), 'Billing Page Copy');
  assert.equal(titleCase('Postgres vs SQLite for the cache'), 'Postgres vs SQLite for the Cache');
  assert.equal(titleCase('the plan to ship it in'), 'The Plan to Ship It In', 'first and last words are capitalized whatever they are');
  assert.equal(titleCase('export menu multi-step upload'), 'Export Menu Multi-Step Upload');
  assert.equal(titleCase("why it doesn't start"), "Why It Doesn't Start");
});

test("a word with a capital, a digit or a mark in it is someone's exact spelling and is kept", () => {
  assert.equal(titleCase('DARK MODE in Safari'), 'DARK MODE in Safari');
  assert.equal(titleCase('rename readRows in src/main.mjs'), 'Rename readRows in src/main.mjs');
  assert.equal(titleCase('switch to GPT-6.1 and v2 api'), 'Switch to GPT-6.1 and v2 Api');
  assert.equal(titleCase('fix #42 (login)'), 'Fix #42 (login)');
});

test('spacing is kept, and anything that is not a string comes back as it is', () => {
  assert.equal(titleCase('  two  spaces '), '  Two  Spaces ');
  assert.equal(titleCase(''), '');
  assert.equal(titleCase(null), null);
  assert.equal(titleCase(undefined), undefined);
});

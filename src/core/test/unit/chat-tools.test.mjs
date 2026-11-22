// chat-tools.mjs: what each chat started with (Code Mode's tool or not, Canopy Memory or not), remembered so a
// reopened chat is given the same again instead of the choices as they are now.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberTools, startedWith, startsWithMemory } from '../../../chat-tools.mjs';

test('a chat is remembered once its tools are fixed, and handed back as it started', () => {
  let saved;
  // Before its first message a chat has nothing fixed: nothing to save.
  assert.equal(rememberTools(saved, 'a', null), null);
  saved = rememberTools(saved, 'a', { codeMode: true });
  saved = rememberTools(saved, 'b', { codeMode: false }) ?? saved;
  assert.deepEqual(saved, { a: true, b: false });
  assert.deepEqual(startedWith(saved, 'a'), { codeMode: true });
  assert.deepEqual(startedWith(saved, 'b'), { codeMode: false }, 'off is remembered as off, not as unknown');
  // The same again (every later turn of the chat) is not a reason to write the file.
  assert.equal(rememberTools(saved, 'a', { codeMode: true }), null);
  // A chat never recorded takes the choice as it is when it is reopened.
  assert.equal(startedWith(saved, 'c'), undefined);
  assert.equal(startedWith(undefined, 'a'), undefined);
  assert.equal(startedWith(saved, null), undefined);
  assert.equal(startedWith(saved, 'constructor'), undefined, 'only what was saved counts');
});

test('a changed answer replaces the old one, and only the newest chats are kept', () => {
  // Claude Code turned out too old for Code Mode after the chat had started with it: the chat now runs without.
  assert.deepEqual(rememberTools({ a: true, b: true }, 'a', { codeMode: false }), { b: true, a: false });
  let saved = {};
  for (const id of ['a', 'b', 'c', 'd']) saved = rememberTools(saved, id, { codeMode: id !== 'b' }, 3) ?? saved;
  assert.deepEqual(saved, { b: false, c: true, d: true }, 'the oldest is dropped');
  // A file someone edited by hand does not break it.
  assert.deepEqual(rememberTools({ a: 'yes', b: true }, 'c', { codeMode: true }), { b: true, c: true });
  assert.deepEqual(rememberTools([], 'c', { codeMode: true }), { c: true });
  assert.equal(rememberTools({}, '', { codeMode: true }), null);
  assert.equal(rememberTools({}, 'c', {}), null);
});

test('older language-server records preserve Code Mode without restoring or saving removed settings', () => {
  const saved = { a: { codeMode: false, lsp: true }, b: { codeMode: true, lsp: false } };
  assert.deepEqual(startedWith(saved, 'a'), { codeMode: false });
  assert.deepEqual(startedWith(saved, 'b'), { codeMode: true });
  assert.equal(rememberTools(saved, 'a', { codeMode: false }), null, 'the same Code Mode choice needs no write');
  assert.deepEqual(rememberTools(saved, 'a', { codeMode: true, lsp: true }), { b: saved.b, a: true });
  assert.deepEqual(rememberTools(undefined, 'c', { codeMode: false, lsp: true }), { c: false });
  assert.equal(startedWith({ x: { lsp: true } }, 'x'), undefined, 'a broken record is ignored');
});

// Canopy Memory's switch is for new chats, as Code Mode's is: its tools and the notes a chat is told sit at the start
// of every request, so a chat that gained or lost them on being reopened would be re-read at full price.
test('a chat is reopened with the memory it started with, whatever the switch says now', () => {
  let saved;
  saved = rememberTools(saved, 'claude-on', { codeMode: false, memory: true });
  saved = rememberTools(saved, 'claude-off', { codeMode: true, memory: false }) ?? saved;
  saved = rememberTools(saved, 'codex-on', { memory: true }) ?? saved; // a Codex chat has no Code Mode to record
  assert.deepEqual(saved, { 'claude-on': { codeMode: false, memory: true }, 'claude-off': { codeMode: true, memory: false }, 'codex-on': { memory: true } });
  assert.deepEqual(startedWith(saved, 'claude-on'), { codeMode: false, memory: true });
  assert.deepEqual(startedWith(saved, 'codex-on'), { memory: true });
  assert.equal(rememberTools(saved, 'claude-on', { codeMode: false, memory: true }), null, 'the same again is not a reason to write the file');
  // Turned off since: the chat that began with memory keeps it. Turned on since: the chat that began without stays without.
  assert.equal(startsWithMemory(saved, 'claude-on', false), true);
  assert.equal(startsWithMemory(saved, 'codex-on', false), true);
  assert.equal(startsWithMemory(saved, 'claude-off', true), false);
  // A new chat, and a chat nothing is recorded for, take the switch as it is.
  for (const id of [null, undefined, '', 'never-seen']) assert.deepEqual([startsWithMemory(saved, id, true), startsWithMemory(saved, id, false)], [true, false]);
  assert.deepEqual([startsWithMemory(undefined, 'x', true), startsWithMemory({}, 'x', undefined)], [true, false]);
});

test('a chat from before Canopy Memory says nothing about it: it takes the switch as it is, and is recorded from then on', () => {
  const saved = { old: true, older: { codeMode: false, lsp: true } };
  assert.deepEqual(startedWith(saved, 'old'), { codeMode: true });
  assert.deepEqual([startsWithMemory(saved, 'old', true), startsWithMemory(saved, 'old', false), startsWithMemory(saved, 'older', true)], [true, false, true]);
  // Its next turn records what it then had, and Code Mode with it; the other chat's record is left as it was.
  const next = rememberTools(saved, 'old', { codeMode: true, memory: true });
  assert.deepEqual(next, { older: saved.older, old: { codeMode: true, memory: true } });
  assert.equal(startsWithMemory(next, 'old', false), true);
  // Code Mode changing does not lose what is known about memory, and the other way round.
  assert.deepEqual(rememberTools(next, 'old', { codeMode: false, memory: true }).old, { codeMode: false, memory: true });
  assert.deepEqual(rememberTools(next, 'old', { codeMode: true, memory: false }).old, { codeMode: true, memory: false });
  assert.equal(startsWithMemory({ x: { memory: 'yes' } }, 'x', false), false, 'a record that is not on or off is no record');
});

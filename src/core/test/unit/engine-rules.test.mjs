// The window's rules about the two makers' models (renderer/src/lib/engine-rules.ts): effort levels and where the
// slider rests, which row a typed model name means, and how an OpenAI edit's hunks-only diff is counted and laid out.
// The file is plain TypeScript with no run-time imports, so node runs it as it is: no build, no window, no Codex.
// The model rows are the ones recorded from this Mac's Codex (fixtures/codex-meta.jsonl), and the diffs are the ones
// the adapter really emits for the recorded file changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAdapter } from '../../codex-adapter.mjs';
import { codexModelInfo } from '../../codex-host.mjs';
import * as R from '../../../../renderer/src/lib/engine-rules.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const lines = (name) => fs.readFileSync(path.join(FIXTURES, `codex-${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The picker rows main hands the window, built from the recorded model/list exactly as main builds them.
function recordedRows() {
  const all = lines('meta');
  const asked = all.find((l) => l.dir === 'out' && l.msg.method === 'model/list');
  const answer = all.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id);
  return answer.msg.result.data.filter((m) => !m.hidden).map(codexModelInfo);
}

test('the recorded OpenAI rows: each offers its own effort levels, in its own order', () => {
  const rows = recordedRows();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const stops = R.effortStops(row);
    assert.deepEqual(stops, row.supportedEffortLevels, row.value);
    assert.ok(stops.length > 1, `${row.value} has a slider's worth of levels`);
    // Nothing chosen: the knob rests on the model's own default, which is one of its levels.
    assert.equal(R.restingEffort(row), row.defaultEffort, row.value);
    assert.ok(stops.includes(R.restingEffort(row)), row.value);
    // Every level has a short label for the slider and a name for the chip, and neither is the raw id.
    for (const l of stops) { assert.match(R.effortShort(l), /^[A-Z]/); assert.match(R.effortName(l), /^[A-Z]/); }
  }
});

test('effort labels: the known levels by name, anything new capitalised', () => {
  assert.deepEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(R.effortShort), ['None', 'Min', 'Low', 'Med', 'High', 'XHigh', 'Max', 'Ultra']);
  assert.deepEqual(['low', 'medium', 'xhigh', 'ultra'].map(R.effortName), ['Low', 'Medium', 'Extra High', 'Ultra']);
  assert.equal(R.effortShort('turbo'), 'Turbo');
  assert.equal(R.effortName('turbo'), 'Turbo');
  assert.equal(R.effortShort(undefined), '');
});

test('effort: a level the model lacks is not kept, and the knob rests on what the chat runs with when it says', () => {
  const sol = { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' };
  const luna = { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' };
  assert.equal(R.keepEffort(sol, 'ultra'), 'ultra');
  assert.equal(R.keepEffort(luna, 'ultra'), undefined); // switching to a model without the level: back to unset
  assert.equal(R.keepEffort(luna, ''), undefined);
  assert.equal(R.keepEffort(null, 'high'), undefined);
  assert.equal(R.restingEffort(sol), 'low'); // the model's default, not High
  assert.equal(R.restingEffort(sol, 'xhigh'), 'xhigh'); // what the chat reports wins
  assert.equal(R.restingEffort(luna, 'ultra'), 'medium'); // unless the model has no such level
  assert.equal(R.restingEffort({ supportsEffort: true, supportedEffortLevels: ['a', 'b', 'c'], defaultEffort: null }), 'b');
  // No levels at all: nothing to rest on, and no slider.
  assert.deepEqual(R.effortStops({ supportsEffort: false, supportedEffortLevels: ['low'] }), []);
  assert.equal(R.restingEffort({ supportsEffort: false, supportedEffortLevels: ['low'], defaultEffort: 'low' }), null);
  assert.deepEqual(R.effortStops(null), []);
  assert.deepEqual(R.effortStops({ supportsEffort: true, supportedEffortLevels: 'low' }), []);
  assert.equal(R.restingEffort(undefined), null);
});

test('/model: the chat\'s own maker is looked in first, then the other', () => {
  const claude = [
    { value: 'default', displayName: 'Default', description: 'Use the default model (currently Fable 5.2) · best for most work' },
    { value: 'fable', displayName: 'Fable', description: 'Fable 5.2 · Best for everyday work' },
    { value: 'sol', displayName: 'Sol', description: 'A Claude row that shares a name' },
  ];
  const openai = recordedRows();
  const gpt = openai[0];
  // In a Claude chat: a Claude name is Claude's; a name only OpenAI has is the other maker's.
  assert.deepEqual(R.findModel('fable', claude, openai), { row: claude[1], mine: true });
  assert.deepEqual(R.findModel('FABLE 5.2', claude, openai), { row: claude[1], mine: true }); // by what the row says it runs
  assert.deepEqual(R.findModel(gpt.value, claude, openai), { row: gpt, mine: false });
  assert.deepEqual(R.findModel(gpt.displayName.toUpperCase(), claude, openai), { row: gpt, mine: false });
  // A name both makers have means the maker you are on, whichever that is.
  assert.equal(R.findModel('sol', claude, openai).mine, true);
  assert.equal(R.findModel('sol', claude, openai).row, claude[2]);
  const fromGpt = R.findModel('sol', openai, claude);
  assert.equal(fromGpt.mine, true);
  assert.ok(openai.includes(fromGpt.row));
  // Nothing matches: null, and the caller sends the name as typed. Bad input never throws.
  assert.equal(R.findModel('no-such-model', claude, openai), null);
  assert.equal(R.findModel('', claude, openai), null);
  assert.equal(R.findModel(undefined, undefined, null), null);
  assert.equal(R.otherMaker('claude'), 'codex');
  assert.equal(R.otherMaker('codex'), 'claude');
});

test('a hunks-only diff: counted by its + and - rows, laid out with a marker per hunk', () => {
  const two = '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n@@ -40,2 +40,3 @@\n forty\n+forty and a half\n forty-one\n';
  assert.deepEqual(R.diffStats(two), { add: 2, del: 1 });
  const rows = R.diffRows(two);
  // Each hunk keeps its own line number: this is what a diff rebuilt from the two joined sides gets wrong.
  assert.deepEqual(rows.filter((r) => r.k === '@').map((r) => r.t), ['Line 1', 'Line 40']);
  assert.deepEqual(rows.filter((r) => r.k !== '@').map((r) => r.k + r.t), [' one', '-two', '+2', ' three', ' forty', '+forty and a half', ' forty-one']);
  // Content that only looks like a header is still content once a hunk has opened.
  assert.deepEqual(R.diffStats('@@ -1,2 +1,2 @@\n--- old banner\n+++ new banner\n'), { add: 1, del: 1 });
  // A real file header before the first hunk is not counted, and neither is the "no newline" note.
  const headed = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-hello\n\\ No newline at end of file\n+goodbye\n';
  assert.deepEqual(R.diffStats(headed), { add: 1, del: 1 });
  assert.deepEqual(R.diffRows(headed).map((r) => r.k), ['@', '-', '+']);
  // A blank context line some tools write with no leading space.
  assert.deepEqual(R.diffRows('@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n').map((r) => r.k), ['@', ' ', ' ', '-', '+']);
  // Not a diff at all: nothing, never a throw.
  for (const bad of [undefined, null, '', 42, {}, 'just some text', []]) {
    assert.deepEqual(R.diffRows(bad), []);
    assert.deepEqual(R.diffStats(bad), { add: 0, del: 0 });
  }
});

test('the recorded file changes: the diff the adapter hands the window counts as the edit it was', () => {
  for (const name of ['file-change-approval', 'decline']) {
    const adapter = createAdapter({});
    const edits = [];
    for (const l of lines(name)) {
      if (l.dir !== 'in' || !l.msg.method || l.msg.id !== undefined) continue;
      for (const ev of adapter.adapt(l.msg)) if (ev.kind === 'tool-start' && ev.name === 'Edit') edits.push(ev);
    }
    assert.ok(edits.length > 0, `${name}: an edit was recorded`);
    for (const ev of edits) {
      assert.equal(typeof ev.input.diff, 'string', name);
      const { add, del } = R.diffStats(ev.input.diff);
      // The recorded edit swaps one line for another, and the two sides the adapter also sends agree with the count.
      assert.equal(add, ev.input.new_string.split('\n').length, name);
      assert.equal(del, ev.input.old_string.split('\n').length, name);
      assert.equal(R.diffRows(ev.input.diff)[0].k, '@', name);
    }
  }
});

test('a new chat opens on the maker picked last only while the picker still offers that maker', () => {
  assert.equal(R.newChatEngine('codex', false, 0), 'codex', 'before the list has been read, the last pick stands');
  assert.equal(R.newChatEngine('codex', true, 4), 'codex');
  assert.equal(R.newChatEngine('codex', true, 0), 'claude', 'signed out of Codex, or Codex gone: no OpenAI rows, so no OpenAI chat');
  assert.equal(R.newChatEngine('claude', true, 4), 'claude');
  for (const pick of [undefined, null, '', 'gemini', 7]) assert.equal(R.newChatEngine(pick, true, 4), 'claude');
  assert.equal(R.newChatEngine('codex', true, NaN), 'claude');
});

test('Claude Code stops the launch only when it is missing or was never signed in, and a working Codex lets you in', () => {
  assert.equal(R.claudeBlock({ claudePath: null }), 'missing');
  assert.equal(R.claudeBlock({ claudePath: '/bin/claude', auth: { loggedIn: false }, everSignedIn: false }), 'login');
  assert.equal(R.claudeBlock({ claudePath: '/bin/claude', auth: { loggedIn: false }, everSignedIn: true }), null, 'a login that once worked: the app opens and asks in a dialog');
  assert.equal(R.claudeBlock({ claudePath: '/bin/claude', auth: { loggedIn: null } }), null, 'a slow check never locks anyone out');
  assert.equal(R.claudeBlock(null), null);
  assert.equal(R.codexReady({ list: [{ engine: 'codex', state: 'ok' }] }), true, 'signed in to Codex only: a ChatGPT user gets in');
  assert.equal(R.codexReady({ list: [{ engine: 'codex', state: 'checking' }, { engine: 'claude', state: 'ok' }] }), false);
  assert.equal(R.codexReady({ list: [{ engine: 'codex', state: 'signed-out' }] }), false);
  assert.equal(R.codexReady(undefined), false);
});

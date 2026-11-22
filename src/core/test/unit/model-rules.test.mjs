// The rules behind the model menu and Settings > Models (renderer/src/lib/model-rules.ts): the one list of both
// makers' models, families and versions, the menu's four rows (the default four, how they follow new versions without
// anyone doing anything, what a drag does and saves, what the first Settings page saved), the search, the one effort
// scale, what new chats start with, and each maker's status line.
// The file is plain TypeScript, so node runs it as it is: no build, no window, no Codex, no Claude Code.
// The OpenAI rows are the ones recorded from this Mac's Codex (fixtures/codex-meta.jsonl), built exactly as main
// builds them; the Claude rows are Claude Code's picker as Canopy offers it today.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexModelInfo } from '../../codex-host.mjs';
import * as M from '../../../../renderer/src/lib/model-rules.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const lines = (name) => fs.readFileSync(path.join(FIXTURES, `codex-${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function recordedOpenai() {
  const all = lines('meta');
  const asked = all.find((l) => l.dir === 'out' && l.msg.method === 'model/list');
  const answer = all.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id);
  return answer.msg.result.data.filter((m) => !m.hidden).map(codexModelInfo);
}
// Claude Code's picker, after upkeep swapped the pinned Fable row for the name that follows the family.
const CLAUDE = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $5/$25 per Mtok' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'fable[1m]', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers' },
];
const OPENAI = recordedOpenai();
const ALL = M.allModels(CLAUDE, OPENAI);
const labels = (rows) => rows.map((m) => m.label);
const ids = (rows) => rows.map((m) => m.id);
const byKey = (key, all = ALL) => all.find((m) => m.key === key);
// A row Codex might list tomorrow, in the shape main hands the window.
const openaiRow = (value, extra = {}) => ({
  value, displayName: value.replace(/^gpt/, 'GPT').replace(/-([a-z])/g, (_, c) => `-${c.toUpperCase()}`), description: '', engine: 'codex', maker: 'openai',
  supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', supportsFastMode: true, isDefault: false, ...extra,
});

// ---------- one list ----------

test('one list of both makers: Claude first, each in its own order, every row in one shape', () => {
  assert.deepEqual(labels(ALL), ['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5']);
  assert.deepEqual(ALL.map((m) => m.key).slice(0, 5), ['claude:opus', 'claude:fable[1m]', 'claude:sonnet', 'claude:haiku', 'openai:gpt-6.1-sol']);
  for (const m of ALL) {
    assert.equal(m.key, `${m.maker}:${m.id}`);
    assert.equal(m.engine, m.maker === 'openai' ? 'codex' : 'claude');
    assert.equal(M.makerEngine(m.maker), m.engine);
    assert.equal(M.engineMaker(m.engine), m.maker);
    assert.deepEqual(M.parseKey(m.key), { maker: m.maker, id: m.id });
  }
  assert.equal(new Set(ALL.map((m) => m.key)).size, ALL.length, 'no key twice');
});

test('Claude: the "default" row is not a row; the model it runs is marked instead, and only one is', () => {
  assert.deepEqual(ALL.filter((m) => m.maker === 'claude' && m.isDefault).map((m) => m.id), ['opus']);
  assert.equal(byKey('claude:opus').resolved, 'claude-opus-5-5');
  // Two rows that run the default model: the first one is the default.
  const two = M.allModels([...CLAUDE, { value: 'opusplan', resolvedModel: 'claude-opus-5-5', description: 'Opus Plan · Opus to plan, Sonnet to build' }], []);
  assert.deepEqual(two.filter((m) => m.isDefault).map((m) => m.id), ['opus']);
  // Nothing listed yet (Claude Code has not said): one row, Claude Code's own default, with the empty id.
  for (const none of [[], null, undefined, 'nope', [{ value: 'default', resolvedModel: 'claude-opus-5-5', description: 'Use the default model (currently Opus 5.5)' }]]) {
    const rows = M.allModels(none, []);
    assert.deepEqual(rows.map((m) => [m.key, m.label, m.isDefault]), [['claude:', 'Default', true]]);
  }
});

test('OpenAI: Codex\'s own default, name, faster tier and effort levels are carried as they are', () => {
  const sol = byKey('openai:gpt-6.1-sol');
  assert.equal(sol.isDefault, true);
  assert.equal(sol.fast, true);
  assert.deepEqual(ALL.filter((m) => m.maker === 'openai' && m.isDefault).map((m) => m.id), ['gpt-6.1-sol']);
  assert.equal(M.allModels(CLAUDE, [openaiRow('gpt-x', { supportsFastMode: false })]).at(-1).fast, false);
  // Missing or signed out of Codex: the list is Claude's alone.
  assert.deepEqual(labels(M.allModels(CLAUDE, [])), ['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
  // Rows that are not rows are skipped, and nothing throws.
  assert.deepEqual(ids(M.allModels(CLAUDE, [null, 7, {}, { value: 3 }, openaiRow('gpt-9')]).filter((m) => m.maker === 'openai')), ['gpt-9']);
});

test('a Claude row\'s name is the short one the menu has always shown', () => {
  assert.equal(M.claudeLabel(CLAUDE[0]), 'Opus 5.5');
  assert.equal(M.claudeLabel(CLAUDE[2]), 'Fable 5.2');
  assert.equal(M.claudeLabel({ value: 'x', displayName: 'Custom', description: 'A description much too long to be a name for a row' }), 'Custom');
  assert.equal(M.claudeLabel({ value: 'claude-opus-5-5' }), 'claude-opus-5-5');
});

// ---------- families ----------

test('families and versions, on today\'s Claude names and ids', () => {
  const f = (id, resolved) => M.modelFamily('claude', id, resolved);
  assert.deepEqual(f('opus', 'claude-opus-5-5'), { family: 'opus', version: [5, 5] });
  assert.deepEqual(f('fable[1m]', 'claude-fable-5-2'), { family: 'fable[1m]', version: [5, 2] });
  assert.deepEqual(f('haiku', 'claude-haiku-5-5'), { family: 'haiku', version: [5, 5] });
  assert.deepEqual(f('sonnet'), { family: 'sonnet', version: null }, 'a picker name alone says no version');
  // A row pinned to one release is the same family as the name that follows it.
  assert.deepEqual(f('claude-fable-5-1[1m]'), { family: 'fable[1m]', version: [5, 1] });
  assert.deepEqual(f('claude-fable-5-2'), { family: 'fable', version: [5, 2] }, 'the long-context variant is its own family');
  assert.deepEqual(f('claude-opus-5-5-20261001'), { family: 'opus', version: [5, 5] }, 'a date is never a version');
  assert.deepEqual(f('claude-opus-6'), { family: 'opus', version: [6] });
  assert.deepEqual(f('claude-3-5-sonnet-20241022'), { family: 'sonnet', version: [3, 5] });
  // A name that runs another family's model (Opus Plan) takes no version from it.
  assert.deepEqual(f('opusplan', 'claude-opus-5-5'), { family: 'opusplan', version: null });
  assert.deepEqual(f('my custom model'), { family: 'my custom model', version: null });
  assert.deepEqual(f(null), { family: '', version: null });
});

test('families and versions, on every OpenAI id Codex really lists', () => {
  const got = Object.fromEntries(OPENAI.map((m) => [m.value, M.modelFamily('openai', m.value)]));
  assert.deepEqual(got, {
    'gpt-6.1-sol': { family: 'gpt-sol', version: [6, 1] },
    'gpt-6-astra': { family: 'gpt-astra', version: [6] },
    'gpt-6-sol': { family: 'gpt-sol', version: [6] },
    'gpt-6-luna': { family: 'gpt-luna', version: [6] },
    'gpt-5.6-sol': { family: 'gpt-sol', version: [5, 6] },
    'gpt-5.6-terra': { family: 'gpt-terra', version: [5, 6] },
    'gpt-5.6-luna': { family: 'gpt-luna', version: [5, 6] },
    'gpt-5.5': { family: 'gpt', version: [5, 5] },
  });
  const f = (id) => M.modelFamily('openai', id);
  assert.deepEqual(f('gpt-5.1-codex-max'), { family: 'gpt-codex-max', version: [5, 1] });
  assert.deepEqual(f('o3'), { family: 'o', version: [3] });
  assert.deepEqual(f('o4-mini'), { family: 'o-mini', version: [4] });
  // No version to read: a family of one, which nothing ever replaces.
  assert.deepEqual(f('codex-auto-review'), { family: 'codex-auto-review', version: null });
  assert.deepEqual(f('gpt-4o'), { family: 'gpt-4o', version: null });
  assert.deepEqual(f('local-model'), { family: 'local-model', version: null });
});

test('versions compare by number, part by part', () => {
  assert.equal(M.compareVersions([6, 1], [6]), 1, '6.1 is newer than 6');
  assert.equal(M.compareVersions([5, 6], [6]), -1);
  assert.equal(M.compareVersions([5, 10], [5, 9]), 1, 'not by spelling');
  assert.equal(M.compareVersions([6], [6, 0]), 0);
  assert.equal(M.compareVersions(null, [6]), 0, 'unknown is never newer or older');
});

// ---------- the menu's four rows ----------

const NONE = M.NO_SAVED_MODELS;
const four = (all = ALL, saved = NONE) => labels(M.menuRows(all, saved));
/** Drag `dragged` onto a row of the four (a number) or onto another model (its key), and save it, as the window does. */
const drop = (all, saved, dragged, onto) => M.slotsFor(M.dragModel(M.menuRows(all, saved), all, dragged, typeof onto === 'number' ? { row: onto } : { more: onto }), all);
const CLAUDE_ONLY = M.allModels(CLAUDE, []);

test('the default four, by family: Claude\'s Opus, OpenAI\'s Sol, Claude\'s Fable, OpenAI\'s Astra', () => {
  assert.deepEqual(four(), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Astra']);
  const { rows, more } = M.splitMenu(ALL);
  assert.equal(rows.length, M.MENU_ROWS);
  assert.deepEqual(labels(more), ['Sonnet 5.5', 'Haiku 5.5', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5'], 'everything else is under More models, in the makers\' own order');
  assert.equal(rows.length + more.length, ALL.length);
  // The families decide, not the order the makers list their models in.
  const shuffled = M.allModels([CLAUDE[0], CLAUDE[4], CLAUDE[3], CLAUDE[2], CLAUDE[1]], [...OPENAI].reverse());
  assert.deepEqual(four(shuffled), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Astra']);
  // Fable without the long context is Fable too.
  const plainFable = M.allModels(CLAUDE.map((m) => (m.value === 'fable[1m]' ? { ...m, value: 'fable' } : m)), OPENAI);
  assert.deepEqual(four(plainFable), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Astra']);
  // With both Fables listed the row is the first one, and the other does not take a second row ahead of OpenAI's.
  const twoFables = M.allModels([...CLAUDE, { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', description: 'Fable 5.2 short · Most capable' }], OPENAI);
  assert.deepEqual(ids(M.menuRows(twoFables)), ['opus', 'gpt-6.1-sol', 'fable[1m]', 'gpt-6-astra']);
});

test('a newer version takes its family\'s row on its own, and no other row moves', () => {
  // GPT-6.2-Sol is listed while GPT-6.1-Sol is still Codex's default: Sol's row is the newer one already.
  const early = M.allModels(CLAUDE, [openaiRow('gpt-6.2-sol'), ...OPENAI]);
  assert.deepEqual(four(early), ['Opus 5.5', 'GPT-6.2-Sol', 'Fable 5.2', 'GPT-6-Astra']);
  assert.ok(labels(M.splitMenu(early).more).includes('GPT-6.1-Sol'), 'the older one is still there to pick, under More models');
  // Then Codex moves its default, and GPT-7-Astra is listed.
  const next = M.allModels(CLAUDE, [openaiRow('gpt-6.2-sol', { isDefault: true }), openaiRow('gpt-7-astra'), ...OPENAI.map((m) => ({ ...m, isDefault: false }))]);
  assert.deepEqual(four(next), ['Opus 5.5', 'GPT-6.2-Sol', 'Fable 5.2', 'GPT-7-Astra']);
  // Opus 5.6 and Fable 5.3: Claude Code's rows are names that follow their family, so the same rows run the newer models.
  const claude = CLAUDE.map((m) => (m.value === 'fable[1m]' ? { ...m, resolvedModel: 'claude-fable-5-3', description: 'Fable 5.3 · Most capable' }
    : m.value === 'opus' ? { ...m, resolvedModel: 'claude-opus-5-6', description: 'Opus 5.6 · Best for everyday, complex tasks' }
    : m.value === 'default' ? { ...m, resolvedModel: 'claude-opus-5-6', description: 'Use the default model (currently Opus 5.6)' } : m));
  assert.deepEqual(four(M.allModels(claude, OPENAI)), ['Opus 5.6', 'GPT-6.1-Sol', 'Fable 5.3', 'GPT-6-Astra']);
  // A Claude Code that lists full ids: the newest Opus has the row, the older one is under More models.
  const pinned = M.allModels([CLAUDE[0], { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', description: 'Opus 5.5 · Best' }, { value: 'claude-opus-5-6', resolvedModel: 'claude-opus-5-6', description: 'Opus 5.6 · Best' }, ...CLAUDE.slice(2)], OPENAI);
  assert.deepEqual(four(pinned), ['Opus 5.6', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Astra']);
});

test('a family that is not offered: the four are filled from the models that are, never fewer than four', () => {
  // Codex missing or signed out: four Claude rows, and nothing of OpenAI's anywhere.
  assert.deepEqual(four(CLAUDE_ONLY), ['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
  assert.deepEqual(M.splitMenu(CLAUDE_ONLY).more, []);
  assert.ok(M.menuRows(CLAUDE_ONLY).every((m) => m.maker === 'claude'));
  // Codex lists one family only: its newest version has a row, and Claude's next model the other, not an older Sol.
  assert.deepEqual(four(M.allModels(CLAUDE, [openaiRow('gpt-6-sol'), openaiRow('gpt-6.1-sol')])), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'Sonnet 5.5']);
  // Astra is no longer offered: OpenAI's row goes to its next family, in Codex's order.
  assert.deepEqual(four(M.allModels(CLAUDE, OPENAI.filter((m) => m.value !== 'gpt-6-astra'))), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Luna']);
  // Neither named family is offered any more: the family of Codex's own default comes first, wherever it is listed.
  const renamed = M.allModels(CLAUDE, [openaiRow('gpt-7-vega'), openaiRow('gpt-7-nova', { isDefault: true }), openaiRow('gpt-7-lyra')]);
  assert.deepEqual(four(renamed), ['Opus 5.5', 'GPT-7-Nova', 'Fable 5.2', 'GPT-7-Vega']);
  // Claude Code has not listed its models yet: its one stand-in row, and OpenAI's next ones.
  assert.deepEqual(four(M.allModels([], OPENAI)), ['Default', 'GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Luna']);
  // Older versions fill the four before a row is left empty.
  assert.deepEqual(four(M.allModels([], [openaiRow('gpt-6.1-sol'), openaiRow('gpt-6-sol'), openaiRow('gpt-5.6-sol')])), ['Default', 'GPT-6.1-Sol', 'GPT-6-Sol', 'GPT-5.6-Sol']);
  // Fewer than four models in all: the rows there are, and nothing under More models.
  const three = M.allModels(CLAUDE.slice(0, 4), []);
  assert.deepEqual(M.splitMenu(three), { rows: three, more: [] });
  assert.deepEqual(M.menuRows(null), []);
  // Every list of four or more gives exactly four different rows.
  for (const list of [ALL, CLAUDE_ONLY, renamed, M.allModels([], OPENAI)]) {
    const rows = M.menuRows(list);
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows).size, 4);
  }
});

test('dragging within the four reorders them, and the order is kept', () => {
  // Fable (third) to the top: the rows between shift down by one.
  const saved = drop(ALL, NONE, 'claude:fable[1m]', 0);
  assert.deepEqual(saved, { slots: [{ key: 'claude:fable[1m]' }, { key: 'claude:opus' }, { key: 'openai:gpt-6.1-sol' }, { key: 'openai:gpt-6-astra' }], before: null });
  assert.deepEqual(four(ALL, saved), ['Fable 5.2', 'Opus 5.5', 'GPT-6.1-Sol', 'GPT-6-Astra']);
  // The first row to the bottom.
  assert.deepEqual(four(ALL, drop(ALL, saved, 'claude:fable[1m]', 3)), ['Opus 5.5', 'GPT-6.1-Sol', 'GPT-6-Astra', 'Fable 5.2']);
  // The rows under More models are the same either way.
  assert.deepEqual(M.splitMenu(ALL, saved).more, M.splitMenu(ALL).more);
  // What was stored survives a round trip through storage.
  assert.deepEqual(M.readSaved(JSON.parse(JSON.stringify(saved))), saved);
  // Onto its own row, onto no row, or let go over nothing: nothing changes.
  const rows = M.menuRows(ALL);
  assert.equal(M.dragModel(rows, ALL, 'claude:opus', { row: 0 }), rows);
  assert.equal(M.dragModel(rows, ALL, 'claude:opus', { row: 7 }), rows);
  assert.equal(M.dragModel(rows, ALL, 'claude:opus', null), rows);
  assert.equal(M.dragModel(rows, ALL, 'claude:gone', { row: 1 }), rows);
});

test('a model dragged in from More models takes that row, and the one it displaces goes to More models', () => {
  const saved = drop(ALL, NONE, 'openai:gpt-6-luna', 2);
  assert.deepEqual(four(ALL, saved), ['Opus 5.5', 'GPT-6.1-Sol', 'GPT-6-Luna', 'GPT-6-Astra']);
  const more = labels(M.splitMenu(ALL, saved).more);
  assert.ok(more.includes('Fable 5.2') && !more.includes('GPT-6-Luna'));
  assert.deepEqual(more.slice(0, 3), ['Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'], 'in the maker\'s own order, not where the other one was');
  // Still four rows, no model twice, whichever row it is dropped on.
  for (let i = 0; i < 4; i++) {
    const rows = M.menuRows(ALL, drop(ALL, NONE, 'claude:haiku', i));
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows).size, 4);
    assert.equal(rows[i].label, 'Haiku 5.5');
  }
});

test('one of the four dragged onto a model in More models gives it its row', () => {
  const saved = drop(ALL, NONE, 'openai:gpt-6-astra', 'claude:sonnet');
  assert.deepEqual(four(ALL, saved), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'Sonnet 5.5']);
  assert.ok(labels(M.splitMenu(ALL, saved).more).includes('GPT-6-Astra'));
  // A model that is not one of the four, onto another that is not: nothing to do. Nor onto one of the four by its key.
  const rows = M.menuRows(ALL);
  assert.equal(M.dragModel(rows, ALL, 'claude:sonnet', { more: 'claude:haiku' }), rows);
  assert.equal(M.dragModel(rows, ALL, 'claude:opus', { more: 'claude:fable[1m]' }), rows);
  assert.equal(M.dragModel(rows, ALL, 'claude:opus', { more: 'openai:gone' }), rows);
});

test('a row you arranged is its family\'s: the next version takes it. An older version you put there stays itself', () => {
  // Luna, the newest of its family, dragged in: GPT-6.1-Luna takes the row the day it is listed.
  const luna = drop(ALL, NONE, 'openai:gpt-6-luna', 3);
  const newerLuna = M.allModels(CLAUDE, [...OPENAI, openaiRow('gpt-6.1-luna')]);
  assert.deepEqual(four(newerLuna, luna), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6.1-Luna']);
  assert.ok(labels(M.splitMenu(newerLuna, luna).more).includes('GPT-6-Luna'));
  // The rows you only moved follow their families too.
  const next = M.allModels(CLAUDE, [openaiRow('gpt-6.2-sol', { isDefault: true }), ...OPENAI.map((m) => ({ ...m, isDefault: false }))]);
  assert.deepEqual(four(next, luna), ['Opus 5.5', 'GPT-6.2-Sol', 'Fable 5.2', 'GPT-6-Luna']);
  // GPT-5.6-Luna is already an older Luna: dragged in, it is kept as exactly that one, whatever Luna comes next.
  const older = drop(ALL, NONE, 'openai:gpt-5.6-luna', 3);
  assert.deepEqual(older.slots[3], { key: 'openai:gpt-5.6-luna', exact: true });
  assert.deepEqual(four(M.allModels(CLAUDE, [...OPENAI, openaiRow('gpt-7-luna')]), older), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-5.6-Luna']);
  // Both in the four at once: the family's row moves on, the older one stays.
  const both = drop(ALL, older, 'openai:gpt-6-luna', 2);
  assert.deepEqual(four(newerLuna, both), ['Opus 5.5', 'GPT-6.1-Sol', 'GPT-6.1-Luna', 'GPT-5.6-Luna']);
  // A row saved while Claude Code listed a full id is the alias row once upkeep swaps it in.
  const pinnedFable = M.allModels(CLAUDE.map((m) => (m.value === 'fable[1m]' ? { ...m, value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', description: 'Fable 5.1 · Most capable' } : m)), OPENAI);
  const moved = drop(pinnedFable, NONE, 'claude:claude-fable-5-1[1m]', 0);
  assert.deepEqual(four(ALL, moved), ['Fable 5.2', 'Opus 5.5', 'GPT-6.1-Sol', 'GPT-6-Astra']);
});

test('nothing you arranged is lost while a maker\'s models are away, and the four stay full meanwhile', () => {
  const mine = drop(ALL, drop(ALL, NONE, 'openai:gpt-6-luna', 0), 'claude:haiku', 2);
  assert.deepEqual(four(ALL, mine), ['GPT-6-Luna', 'GPT-6.1-Sol', 'Haiku 5.5', 'GPT-6-Astra']);
  // Signed out of Codex: your Claude row keeps its place, and Claude's next models stand in for the others.
  assert.deepEqual(four(CLAUDE_ONLY, mine), ['Opus 5.5', 'Fable 5.2', 'Haiku 5.5', 'Sonnet 5.5']);
  // Signed in again: as you left them. Nothing was saved in between.
  assert.deepEqual(four(ALL, mine), ['GPT-6-Luna', 'GPT-6.1-Sol', 'Haiku 5.5', 'GPT-6-Astra']);
  // A family that is gone for good gives its row to the same maker's next one, in its place.
  assert.deepEqual(four(M.allModels(CLAUDE, OPENAI.filter((m) => !/luna/.test(m.value))), mine), ['GPT-5.6-Terra', 'GPT-6.1-Sol', 'Haiku 5.5', 'GPT-6-Astra']);
  // Dragging while they are away saves the four that are on screen.
  const meanwhile = drop(CLAUDE_ONLY, mine, 'claude:sonnet', 0);
  assert.deepEqual(four(CLAUDE_ONLY, meanwhile), ['Sonnet 5.5', 'Opus 5.5', 'Fable 5.2', 'Haiku 5.5']);
  assert.deepEqual(four(ALL, meanwhile), ['Sonnet 5.5', 'Opus 5.5', 'Fable 5.2', 'Haiku 5.5']);
});

test('what the first Settings page saved (a switch per model) becomes the four', () => {
  // Nothing was ever switched: the default four.
  for (const untouched of [{ added: [], followed: [], hidden: [], order: [] }, {}]) {
    assert.deepEqual(M.readSaved(untouched), NONE);
    assert.deepEqual(four(ALL, untouched), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Astra']);
  }
  // A model you had switched on keeps a row, the last one; the rest are the default four.
  const luna = { added: [], followed: ['openai:gpt-6-luna'], hidden: [], order: [] };
  assert.deepEqual(M.readSaved(luna), { slots: [], before: { on: [{ key: 'openai:gpt-6-luna' }], off: [] } });
  assert.deepEqual(four(ALL, luna), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Luna']);
  // It was switched on as its family's newest, so it still follows the family.
  assert.deepEqual(four(M.allModels(CLAUDE, [...OPENAI, openaiRow('gpt-6.1-luna')]), luna), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6.1-Luna']);
  // An older version you had switched on is kept as itself.
  const older = { added: ['openai:gpt-5.6-luna'], followed: [], hidden: [], order: [] };
  assert.deepEqual(four(M.allModels(CLAUDE, [...OPENAI, openaiRow('gpt-7-luna')]), older), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-5.6-Luna']);
  // Rows you had switched off stay out, and the rows that menu showed fill in before any it did not.
  assert.deepEqual(four(ALL, { hidden: ['openai:gpt-6-astra'] }), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'Sonnet 5.5']);
  assert.deepEqual(four(ALL, { hidden: ['openai:gpt-6.1-sol', 'openai:gpt-6-astra'] }), ['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'], 'no OpenAI rows were wanted');
  assert.deepEqual(four(ALL, { hidden: ['claude:fable[1m]'], followed: ['openai:gpt-6-luna'] }), ['Opus 5.5', 'GPT-6.1-Sol', 'Sonnet 5.5', 'GPT-6-Luna']);
  // Switched off, but there is nothing else to show: four rows all the same.
  assert.equal(M.menuRows(CLAUDE_ONLY, { hidden: ['claude:haiku', 'claude:sonnet'] }).length, 4);
  // More switched on than there are rows: the last four.
  const many = { followed: ['openai:gpt-6-luna', 'openai:gpt-5.6-terra'], added: ['openai:gpt-6-sol', 'openai:gpt-5.6-sol', 'openai:gpt-5.6-luna'] };
  assert.deepEqual(four(ALL, many), ['GPT-5.6-Terra', 'GPT-6-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Luna']);
  // An order that was stored (nothing ever wrote one) does no harm.
  assert.deepEqual(four(ALL, { ...luna, order: ['openai:gpt-6-luna', 'claude:opus'] }), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Luna']);
  // The first drag saves the four as they are, in the new shape, and the old switches are done with.
  const dragged = drop(ALL, luna, 'openai:gpt-6-luna', 0);
  assert.deepEqual(dragged, { slots: [{ key: 'openai:gpt-6-luna' }, { key: 'claude:opus' }, { key: 'openai:gpt-6.1-sol' }, { key: 'claude:fable[1m]' }], before: null });
  // Read again before any drag (the window reads what it has in memory back), it says the same.
  assert.deepEqual(M.readSaved(M.readSaved(luna)), M.readSaved(luna));
  assert.deepEqual(four(ALL, M.readSaved(M.readSaved({ hidden: ['openai:gpt-6-astra'] }))), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'Sonnet 5.5']);
});

test('whatever was stored reads as something usable', () => {
  for (const junk of [null, undefined, 'x', 7, [], { added: 'no', hidden: 3 }, { added: [null, 5, 'nokey', 'gemini:pro'] }, { slots: 'no' }, { slots: [null, 5, 'claude:opus', { key: 'gemini:pro' }, {}] }, { before: 4 }]) {
    assert.deepEqual(M.readSaved(junk), NONE);
    assert.deepEqual(four(ALL, junk), ['Opus 5.5', 'GPT-6.1-Sol', 'Fable 5.2', 'GPT-6-Astra']);
  }
  // Only what is understood is kept: keys of the two makers, each once, four at most, `exact` only when it is true.
  assert.deepEqual(M.readSaved({ slots: [{ key: 'claude:haiku', exact: 'yes', extra: 1 }, { key: 'claude:haiku' }, { key: 'openai:gpt-6-sol', exact: true }, { key: 'x' }, { key: 'claude:opus' }, { key: 'claude:sonnet' }, { key: 'openai:gpt-5.5' }], hidden: ['claude:opus'] }),
    { slots: [{ key: 'claude:haiku' }, { key: 'openai:gpt-6-sol', exact: true }, { key: 'claude:opus' }, { key: 'claude:sonnet' }], before: null });
  assert.deepEqual(M.readSaved({ added: ['openai:gpt-6-luna', 'openai:gpt-6-luna'], followed: ['openai:gpt-6-astra', 7], hidden: ['claude:haiku'], extra: 1 }),
    { slots: [], before: { on: [{ key: 'openai:gpt-6-astra' }, { key: 'openai:gpt-6-luna', exact: true }], off: ['claude:haiku'] } });
  // Fewer rows stored than four (a damaged value): the stored ones first, then the default ones.
  assert.deepEqual(four(ALL, { slots: [{ key: 'claude:haiku' }] }), ['Haiku 5.5', 'GPT-6.1-Sol', 'Opus 5.5', 'GPT-6-Astra']);
  // A model stored twice under two keys of one family is one row.
  assert.deepEqual(four(ALL, { slots: [{ key: 'openai:gpt-6.1-sol' }, { key: 'openai:gpt-6-sol' }, { key: 'claude:opus' }, { key: 'claude:haiku' }] }), ['GPT-6.1-Sol', 'GPT-6-Astra', 'Opus 5.5', 'Haiku 5.5']);
  assert.equal(M.parseKey('claude:').id, '', "Claude Code's own default has the empty id");
  assert.equal(M.parseKey('opus'), null);
  // Claude Code's stand-in row can be arranged like any other, and gives its row to Claude's first model once they are listed.
  const early = M.allModels([], OPENAI);
  assert.deepEqual(four(ALL, drop(early, NONE, 'claude:', 3)), ['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Luna', 'Opus 5.5']);
});

// ---------- search ----------

test('search: every model of both makers, best match first', () => {
  const s = (q) => labels(M.searchModels(ALL, q));
  assert.deepEqual(s(''), labels(ALL), 'nothing typed: every model');
  assert.deepEqual(s('   '), labels(ALL));
  assert.deepEqual(s('opus'), ['Opus 5.5']);
  assert.deepEqual(s('OPUS'), ['Opus 5.5']);
  assert.deepEqual(s('sol'), ['GPT-6.1-Sol', 'GPT-6-Sol', 'GPT-5.6-Sol']);
  assert.deepEqual(s('gpt'), labels(ALL.filter((m) => m.maker === 'openai')));
  assert.deepEqual(s('gpt 6'), ['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna']);
  assert.deepEqual(s('gpt-6.1'), ['GPT-6.1-Sol']);
  assert.deepEqual(s('gpt6'), ['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna'], 'written without the dash');
  assert.deepEqual(s('5.5'), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'GPT-5.5'], '5.5 is one word: never 5.6, never Fable 5.2');
  assert.deepEqual(s('luna 6'), ['GPT-6-Luna'], 'every word has to match, in any order');
  assert.deepEqual(s('fa'), ['Fable 5.2', 'Haiku 5.5', 'GPT-6-Luna', 'GPT-5.6-Luna'], 'the name first, then what it is described as (fastest, fast)');
  assert.deepEqual(s('1m'), ['Fable 5.2'], 'by its id');
  assert.deepEqual(s('zzz'), []);
  assert.deepEqual(M.searchModels(null, 'opus'), []);
  assert.deepEqual(labels(M.searchModels(ALL, null)), labels(ALL));
});

test('search: by maker, under any of the names people use for it', () => {
  const makers = (q) => [...new Set(M.searchModels(ALL, q).map((m) => m.maker))];
  assert.deepEqual(makers('claude'), ['claude']);
  assert.deepEqual(makers('anthropic'), ['claude']);
  assert.deepEqual(makers('openai'), ['openai']);
  assert.deepEqual(makers('codex'), ['openai']);
  assert.equal(M.searchModels(ALL, 'claude').length, 4);
  assert.equal(M.searchModels(ALL, 'openai').length, 8);
  // A name beats a maker: "o" is Opus first, then OpenAI's.
  assert.equal(M.searchModels(ALL, 'o')[0].label, 'Opus 5.5');
});

// ---------- effort ----------

test('one scale for both makers; a model shows only the stops it offers, in scale order', () => {
  assert.deepEqual([...M.EFFORT_SCALE], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  for (const m of ALL.filter((x) => x.maker === 'claude')) {
    assert.deepEqual(m.efforts, [...M.EFFORT_SCALE], `${m.label}: all six, as today`);
    assert.equal(m.defaultEffort, 'high');
  }
  const stops = Object.fromEntries(ALL.filter((x) => x.maker === 'openai').map((m) => [m.id, [m.efforts.join(' '), m.defaultEffort]]));
  assert.deepEqual(stops, {
    'gpt-6.1-sol': ['low medium high xhigh max ultra', 'low'],
    'gpt-6-astra': ['low medium high xhigh max ultra', 'low'],
    'gpt-6-sol': ['low medium high xhigh max ultra', 'medium'],
    'gpt-6-luna': ['low medium high xhigh max', 'medium'],
    'gpt-5.6-sol': ['low medium high xhigh max ultra', 'low'],
    'gpt-5.6-terra': ['low medium high xhigh max ultra', 'medium'],
    'gpt-5.6-luna': ['low medium high xhigh max', 'medium'],
    'gpt-5.5': ['low medium high xhigh', 'medium'],
  });
  // Whatever order a model lists them in, and whatever else it lists, the stops are the scale's.
  const odd = M.allModels([], [openaiRow('gpt-odd', { supportedEffortLevels: ['high', 'minimal', 'low', 'none', 'medium'], defaultEffort: 'minimal' })]).at(-1);
  assert.deepEqual(odd.efforts, ['low', 'medium', 'high']);
  assert.equal(odd.defaultEffort, null, 'a default outside the scale is no default');
  assert.deepEqual(M.allModels([], [openaiRow('gpt-none', { supportsEffort: false })]).at(-1).efforts, []);
});

test('where the slider sits: your pick, else what the chat reports, else the model\'s default, else the middle', () => {
  const sol = byKey('openai:gpt-6.1-sol'), old = byKey('openai:gpt-5.5'), opus = byKey('claude:opus');
  assert.equal(M.effortLevel(sol, {}), 'low', "Sol's own default is Low, not High");
  assert.equal(M.effortLevel(sol, {}, 'xhigh'), 'xhigh', 'the chat says what it runs with');
  assert.equal(M.effortLevel(sol, { codex: { effort: 'max' } }, 'xhigh'), 'max');
  assert.equal(M.effortLevel(sol, { effort: 'max' }), 'low', "Claude's effort is not OpenAI's");
  assert.equal(M.effortLevel(old, { codex: { effort: 'ultra' } }), 'medium', 'a stop the model lacks is not a pick');
  assert.equal(M.pickedEffort(old, { codex: { effort: 'ultra' } }), null);
  assert.equal(M.effortLevel(opus, {}), 'high');
  assert.equal(M.effortLevel(opus, { effort: 'low' }), 'low');
  assert.equal(M.effortLevel(opus, { codex: { effort: 'low' } }), 'high');
  assert.equal(M.effortLevel({ maker: 'openai', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: null }, {}), 'medium', 'no default said: the middle stop');
  assert.equal(M.effortLevel({ maker: 'openai', efforts: [], defaultEffort: null }, {}), null, 'no stops: no slider');
  assert.equal(M.effortLevel(null, {}), null);
});

test('Ultra means the same thing on both and is switched on each maker\'s own way', () => {
  const opus = byKey('claude:opus'), sol = byKey('openai:gpt-6.1-sol');
  // Claude: ultracode, at max effort. Read back as the Ultra stop, whatever the effort says.
  assert.deepEqual(M.effortSettings(opus, 'ultra'), { effort: 'max', ultracode: true });
  assert.equal(M.pickedEffort(opus, { effort: 'max', ultracode: true }), 'ultra');
  assert.equal(M.pickedEffort(opus, { ultracode: true }), 'ultra');
  assert.equal(M.pickedEffort(opus, { effort: 'max' }), 'max');
  assert.deepEqual(M.effortSettings(opus, 'xhigh'), { effort: 'xhigh', ultracode: false }, 'any other stop turns Ultra off');
  assert.deepEqual(M.effortSettings(opus, null), { effort: '', ultracode: false }, 'reset: the model default, Ultra off');
  // OpenAI: Codex's own ultra level. ultracode is Claude Code's and is never in the answer.
  assert.deepEqual(M.effortSettings(sol, 'ultra'), { effort: 'ultra' });
  assert.deepEqual(M.effortSettings(sol, null), { effort: '' });
  assert.equal(M.pickedEffort(sol, { ultracode: true, codex: { effort: 'high' } }), 'high', "Claude's Ultra says nothing about an OpenAI chat");
  assert.equal(M.pickedEffort(sol, { codex: { effort: 'ultra' } }), 'ultra');
  // Every stop round-trips for both makers.
  for (const m of [opus, sol]) for (const level of m.efforts) {
    const s = M.effortSettings(m, level);
    const picks = m.maker === 'openai' ? { codex: { effort: s.effort } } : { effort: s.effort, ultracode: s.ultracode };
    assert.equal(M.pickedEffort(m, picks), level, `${m.label} ${level}`);
  }
});

test('what the slider is given: the model\'s stops, short labels, where Ultra and the default are', () => {
  assert.deepEqual(M.effortSlider(byKey('claude:opus'), {}),
    { stops: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], labels: ['Low', 'Med', 'High', 'XHigh', 'Max', 'Ultra'], index: 2, isDefault: true, ultraAt: 5, defaultAt: 2 });
  assert.deepEqual(M.effortSlider(byKey('claude:opus'), { effort: 'max', ultracode: true }),
    { stops: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], labels: ['Low', 'Med', 'High', 'XHigh', 'Max', 'Ultra'], index: 5, isDefault: false, ultraAt: 5, defaultAt: 2 });
  assert.deepEqual(M.effortSlider(byKey('openai:gpt-6-luna'), { codex: { effort: 'xhigh' } }),
    { stops: ['low', 'medium', 'high', 'xhigh', 'max'], labels: ['Low', 'Med', 'High', 'XHigh', 'Max'], index: 3, isDefault: false, ultraAt: -1, defaultAt: 1 });
  const sol = M.effortSlider(byKey('openai:gpt-6.1-sol'), {}, 'high');
  assert.deepEqual([sol.index, sol.isDefault, sol.defaultAt, sol.ultraAt], [2, true, 0, 5], 'resting on what the chat reports, the default still marked');
  assert.equal(M.effortSlider({ maker: 'openai', efforts: ['high'], defaultEffort: 'high' }, {}), null, 'one stop is not a slider');
  assert.equal(M.effortSlider(null, {}), null);
  assert.equal(M.effortLabel('xhigh'), 'Extra High');
  assert.equal(M.effortLabel('ultra'), 'Ultra');
});

test('no Reset: choosing the stop marked as the model\'s default means follow the model', () => {
  const opus = byKey('claude:opus'), sol = byKey('openai:gpt-6.1-sol');
  assert.equal(M.chosenLevel(opus, 'high'), null, "Claude's default: nothing is saved");
  assert.equal(M.chosenLevel(opus, 'max'), 'max');
  assert.equal(M.chosenLevel(opus, 'ultra'), 'ultra');
  assert.equal(M.chosenLevel(sol, 'low'), null, "this model's own default");
  assert.equal(M.chosenLevel(sol, 'high'), 'high');
  // Nothing chosen, and the slider rests on the default: choosing it is still nothing.
  assert.equal(M.chosenLevel(sol, 'low', 'low'), null);
  // Nothing chosen, yet the chat rests elsewhere (your own Codex setting): the default stop is then a real choice.
  assert.equal(M.chosenLevel(sol, 'low', 'high'), 'low');
  // A model that names no default has no such stop.
  assert.equal(M.chosenLevel({ defaultEffort: null }, 'medium'), 'medium');
  assert.equal(M.chosenLevel(null, 'medium'), 'medium');
  // What the chat is then told: nothing chosen is the empty effort, and for Claude Ultra goes off.
  assert.deepEqual(M.effortSettings(opus, M.chosenLevel(opus, 'high')), { effort: '', ultracode: false });
  assert.deepEqual(M.effortSettings(sol, M.chosenLevel(sol, 'low')), { effort: '' });
});

// ---------- picks, the chat's model, new chats ----------

test('Fast: each maker\'s own choice, and never on for a model with no faster tier', () => {
  const opus = byKey('claude:opus'), sol = byKey('openai:gpt-6.1-sol');
  assert.equal(M.pickedFast(opus, {}), null, 'not chosen: Claude Code\'s own setting decides');
  assert.equal(M.pickedFast(opus, { fast: true, codex: { fast: false } }), true);
  assert.equal(M.pickedFast(sol, { fast: true, codex: { fast: false } }), false);
  assert.equal(M.pickedFast(sol, { fast: true }), null);
  assert.equal(M.pickedFast({ maker: 'openai', fast: false }, { codex: { fast: true } }), false);
});

test('picking Claude\'s default row while nothing is chosen saves nothing; every other pick saves the row', () => {
  const opus = byKey('claude:opus'), sonnet = byKey('claude:sonnet'), sol = byKey('openai:gpt-6.1-sol');
  assert.equal(M.pickValue(opus, {}), '', "stays on Claude Code's own default");
  assert.equal(M.pickValue(opus, { model: 'sonnet' }), 'opus');
  assert.equal(M.pickValue(sonnet, {}), 'sonnet');
  assert.equal(M.pickValue(sol, {}), 'gpt-6.1-sol', "an OpenAI row is always saved, Codex's default included");
});

test('picking the default in a chat that runs another Claude model switches to it by name', () => {
  const opus = byKey('claude:opus'), fable = byKey('claude:fable[1m]'), sol = byKey('openai:gpt-6.1-sol');
  // A chat started elsewhere on Fable, with no pick of yours: the tick is on Fable, and Opus has to be asked for.
  const running = M.chatModel(ALL, { engine: 'claude', model: 'claude-fable-5-2' }, {});
  assert.equal(running, fable, 'the tick is on what the chat runs, not on your default');
  assert.equal(M.pickValue(opus, {}, running), 'opus');
  assert.equal(M.pickValue(opus, {}, opus), '', 'the chat already runs the default: it keeps following it');
  assert.equal(M.pickValue(opus, {}, null), '');
  assert.equal(M.pickValue(opus, {}, sol), '', 'an OpenAI chat runs no Claude model: the default row keeps its plain rule');
  assert.equal(M.pickValue(fable, {}, running), 'fable[1m]');
});

test('Claude: Fast is per model, going by what Claude Code marks; one that marks none greys nothing', () => {
  const marked = CLAUDE.map((m) => (['default', 'opus', 'fable[1m]'].includes(m.value) ? { ...m, supportsFastMode: true } : m));
  const fast = (rows) => Object.fromEntries(M.allModels(rows, OPENAI).filter((m) => m.maker === 'claude').map((m) => [m.id, m.fast]));
  assert.deepEqual(fast(marked), { opus: true, 'fable[1m]': true, sonnet: false, haiku: false });
  assert.deepEqual(fast(CLAUDE), { opus: true, 'fable[1m]': true, sonnet: true, haiku: true }, 'an older Claude Code says nothing: nothing is greyed');
  assert.equal(M.allModels([], []).at(0).fast, true, 'nothing listed yet');
  // Your Fast choice is kept, and reads as off on a model without it.
  const haiku = M.allModels(marked, OPENAI).find((m) => m.id === 'haiku');
  assert.equal(M.pickedFast(haiku, { fast: true }), false);
});

test('the model a chat runs on', () => {
  const run = (chat, picks) => M.chatModel(ALL, chat, picks)?.label ?? null;
  // Claude: your pick, else the row that runs the model the chat reports, else Claude Code's default.
  assert.equal(run({ engine: 'claude', model: null }, {}), 'Opus 5.5');
  assert.equal(run({ engine: 'claude', model: 'claude-sonnet-5-5' }, {}), 'Sonnet 5.5');
  assert.equal(run({ engine: 'claude', model: 'claude-sonnet-5-5' }, { model: 'haiku' }), 'Haiku 5.5');
  assert.equal(run({ engine: 'claude', model: 'claude-something-9' }, {}), 'Opus 5.5');
  assert.equal(run({ engine: 'claude', model: null }, { model: 'gone' }), null, 'a pick that is no longer offered');
  assert.equal(run({ engine: 'claude', model: null }, { codex: { model: 'gpt-6-luna' } }), 'Opus 5.5', "OpenAI's pick is not Claude's");
  // OpenAI: your pick, else the model the chat reports, else Codex's default when neither is known.
  assert.equal(run({ engine: 'codex', model: null }, {}), 'GPT-6.1-Sol');
  assert.equal(run({ engine: 'codex', model: 'gpt-6-luna' }, {}), 'GPT-6-Luna');
  assert.equal(run({ engine: 'codex', model: 'gpt-6-luna' }, { codex: { model: 'gpt-6-astra' } }), 'GPT-6-Astra');
  assert.equal(run({ engine: 'codex', model: 'gpt-unlisted' }, {}), null, 'never a guess at another model');
  assert.equal(run({ engine: 'codex', model: null }, { model: 'sonnet' }), 'GPT-6.1-Sol');
  // Claude Code has not listed its models: its own default.
  assert.equal(M.chatModel(M.allModels([], []), { engine: 'claude' }, {}).key, 'claude:');
  assert.equal(M.chatModel(null, null, null), null);
});

test('what new chats start with', () => {
  const start = (picks, all = ALL) => { const s = M.startsWith(all, picks); return [s.maker, s.model?.label ?? null, s.effort, s.level, s.fast]; };
  assert.deepEqual(start({}), ['claude', 'Opus 5.5', null, 'high', null], 'nothing chosen: Claude Code\'s default, resting on High');
  assert.deepEqual(start({ model: 'fable[1m]', effort: 'max', ultracode: true, fast: true }), ['claude', 'Fable 5.2', 'ultra', 'ultra', true]);
  assert.deepEqual(start({ engine: 'codex' }), ['openai', 'GPT-6.1-Sol', null, 'low', null], "an OpenAI start with nothing else chosen: Codex's default and its default effort");
  assert.deepEqual(start({ engine: 'codex', model: 'sonnet', effort: 'max', codex: { model: 'gpt-6-luna', effort: 'xhigh', fast: true } }), ['openai', 'GPT-6-Luna', 'xhigh', 'xhigh', true]);
  // Signed out of Codex: new chats are Claude chats again, with Claude's own choices.
  assert.deepEqual(start({ engine: 'codex', model: 'sonnet', codex: { model: 'gpt-6-luna' } }, M.allModels(CLAUDE, [])), ['claude', 'Sonnet 5.5', null, 'high', null]);
  assert.deepEqual(start(null), ['claude', 'Opus 5.5', null, 'high', null]);
});

// ---------- status ----------

test('each maker\'s status line', () => {
  const line = (...a) => M.makerStatus(...a).map((s) => `${s.name} · ${s.line}`);
  assert.deepEqual(line({ loggedIn: true, method: 'claude.ai' }, { installed: true, signedIn: true, method: 'apiKey' }, 8), ['Claude · Signed in', 'OpenAI · Signed in with an API key']);
  assert.deepEqual(line({ loggedIn: true, method: 'api_key' }, { installed: true, signedIn: true, method: 'chatgpt' }, 8), ['Claude · Signed in with an API key', 'OpenAI · Signed in']);
  assert.deepEqual(line({ loggedIn: false }, { installed: false, signedIn: null }, 0), ['Claude · Not signed in', 'OpenAI · Not set up']);
  const ready = M.makerStatus({ loggedIn: true }, { installed: true, signedIn: true, method: 'apiKey' }, 8);
  assert.deepEqual(ready.map((s) => [s.maker, s.ready, s.setup, s.hint]), [['claude', true, null, null], ['openai', true, null, null]]);
});

test('what is not known yet is not said as a fact', () => {
  const claude = (auth) => M.makerStatus(auth, { installed: true, signedIn: true }, 8)[0];
  // The window has not heard about Claude Code's sign-in yet: no line.
  assert.deepEqual([claude(null).line, claude(undefined).line, claude(null).ready], ['', '', false]);
  // The check did not answer: read as the rest of the window reads it.
  assert.deepEqual([claude({ loggedIn: null, method: null }).line, claude({ loggedIn: null }).ready], ['Not signed in', false]);
  assert.equal(claude({}).line, 'Not signed in');
  // Main has not answered about Codex yet: no line and no setup row, even though no model is listed.
  for (const unknown of [null, undefined]) {
    assert.deepEqual(M.makerStatus({ loggedIn: true }, unknown, 0)[1], { maker: 'openai', name: 'OpenAI', ready: false, line: '', setup: null, hint: null });
  }
});

test('OpenAI missing or signed out: one quiet row that says what to do, never an error', () => {
  const openai = (codex, n = 0) => M.makerStatus({ loggedIn: true }, codex, n)[1];
  assert.deepEqual(openai({ installed: false, signedIn: null }),
    { maker: 'openai', name: 'OpenAI', ready: false, line: 'Not set up', setup: 'Set up OpenAI models', hint: 'Install Codex and sign in. Its models show up here on their own.' });
  // Codex is here with nobody signed in: the row signs in to Codex, rather than opening OpenAI's page about setting it up.
  assert.deepEqual(openai({ installed: true, signedIn: false }),
    { maker: 'openai', name: 'OpenAI', ready: false, line: 'Not signed in', setup: 'Sign in to Codex', hint: 'Its models show up here on their own.', signIn: true });
  // A login OpenAI refused: Accounts says "signed out" while Codex still lists models. The line agrees with Accounts.
  assert.deepEqual(openai({ installed: true, signedIn: false, method: null }, 8),
    { maker: 'openai', name: 'OpenAI', ready: false, line: 'Not signed in', setup: 'Sign in to Codex', hint: 'OpenAI’s models work again once Codex is signed in.', signIn: true });
  for (const fine of [openai({ installed: false, signedIn: null }), openai({ installed: true, signedIn: null }), openai({ installed: true, signedIn: true }, 3), openai({ installed: false, signedIn: false })]) {
    assert.ok(!fine.signIn, 'a sign-in is offered only when Codex is here and known to have no login that works');
  }
  assert.equal(openai({ installed: true, signedIn: null }).line, 'Not answering');
  // A key pasted into Canopy is what OpenAI's chats use, and it needs you: the line says that, with or without
  // models listed, and Codex's sign-in is not offered for it (the key's row on Settings' Codex page has the way out).
  for (const n of [0, 8]) assert.deepEqual(openai({ installed: true, signedIn: false, method: 'apiKey' }, n), { maker: 'openai', name: 'OpenAI', ready: false, line: 'API key needs attention', setup: null, hint: null });
  assert.deepEqual([openai({ installed: true, signedIn: true, method: 'apiKey' }, 8).line, openai({ installed: true, signedIn: true, method: 'apiKey' }, 8).ready], ['Signed in with an API key', true], 'a pasted key that works reads like any key');
  assert.equal(openai({ installed: true, signedIn: true, method: 'apiKey' }).setup, 'Set up OpenAI models', 'signed in but nothing listed: still nothing to pick');
  assert.equal(openai(undefined).setup, null, 'main has not answered yet: nothing is offered');
  // Models listed means ready, whatever else is or is not known (Codex on its own provider has no OpenAI sign-in).
  assert.deepEqual([openai({ installed: true, signedIn: true, method: null }, 1).ready, openai({ installed: true, signedIn: true, method: null }, 1).line], [true, 'Signed in']);
  assert.match(M.OPENAI_SETUP_URL, /^https:\/\//);
});

test('OpenAI on a fixed model list (model_catalog_json): the status carries the file, only while its models are listed', () => {
  const openai = (codex, n) => M.makerStatus({ loggedIn: true }, codex, n)[1];
  assert.equal(openai({ installed: true, signedIn: true, fixedList: '/Users/test/.codex/list.json' }, 8).fixedList, '/Users/test/.codex/list.json');
  assert.equal(openai({ installed: true, signedIn: true, fixedList: '  ' }, 8).fixedList, undefined);
  assert.equal(openai({ installed: true, signedIn: true }, 8).fixedList, undefined);
  assert.equal(openai({ installed: true, signedIn: false, fixedList: '/x.json' }, 0).fixedList, undefined, 'signed out: signing in is what to say');
});

// The widget frame's building blocks (renderer/src/frame/components: pick, tune, rank, markup) send messages and make
// small decisions that are plain text work: the words a pick or a tune sends, a ranking, notes on a design and what
// each one names, which option a preview shows. Those parts live in words.ts and marks.ts, touch no DOM, and node
// reads their TypeScript directly.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

const frame = (file) => import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/frame', file)).href);
const W = await frame('words.ts');
const M = await frame('marks.ts');

// ---- pick ----

test('a pick fills {choice} and {count}, and a template without either gets the picks after it', () => {
  assert.equal(W.fillPick('Go with {choice} for the title slide', ['Night Forest']), 'Go with Night Forest for the title slide');
  assert.equal(W.fillPick('Keep {count}: {choice}', ['Welcome', 'Sign In']), 'Keep 2: Welcome, Sign In');
  assert.equal(W.fillPick('', ['A', 'B']), 'A, B');
  assert.equal(W.fillPick(null, ['A']), 'A');
  assert.equal(W.fillPick('Use the brand', ['Forest']), 'Use the brand Forest');
});

test("a pick's button asks for a pick until there is one, then names it", () => {
  assert.equal(W.pickButton('Use {choice}', [], false), 'Pick one');
  assert.equal(W.pickButton(null, [], true), 'Pick some');
  assert.equal(W.pickButton(null, ['Leaf'], false), 'Use Leaf');
  assert.equal(W.pickButton(null, ['A', 'B', 'C'], true), 'Use 3');
  assert.equal(W.pickButton('Keep {count}', ['A', 'B'], true), 'Keep 2');
  assert.equal(W.pickButton('Send', [], false), 'Send');
});

test('the preview shows what is pointed at, else what is picked, else the recommended one, else the first', () => {
  const opts = ['Editorial', 'Night Forest', 'Product First'];
  assert.equal(M.shownOption(opts, {}), 'Editorial');
  assert.equal(M.shownOption(opts, { recommended: 'Night Forest' }), 'Night Forest');
  assert.equal(M.shownOption(opts, { recommended: 'Night Forest', picked: ['Product First'] }), 'Product First');
  assert.equal(M.shownOption(opts, { picked: ['Editorial', 'Product First'] }), 'Product First');
  assert.equal(M.shownOption(opts, { focused: 'Editorial', picked: ['Product First'] }), 'Editorial');
  assert.equal(M.shownOption(opts, { hovered: 'Night Forest', focused: 'Editorial' }), 'Night Forest');
  assert.equal(M.shownOption(opts, { hovered: 'Gone', picked: ['Also gone'] }), 'Editorial');
  assert.equal(M.shownOption([], {}), null);
});

test('picking replaces one pick, and toggles among several', () => {
  assert.deepEqual(M.togglePick(['A'], 'B', false), ['B']);
  assert.deepEqual(M.togglePick(['A'], 'B', true), ['A', 'B']);
  assert.deepEqual(M.togglePick(['A', 'B'], 'A', true), ['B']);
});

// ---- tune ----

test('a tune sets numbers with their unit, a box as 1 or 0, the rest as written', () => {
  assert.equal(W.cssValue({ type: 'range', value: '18', unit: 'px' }), '18px');
  assert.equal(W.cssValue({ type: 'number', value: '1.5', unit: 'rem' }), '1.5rem');
  assert.equal(W.cssValue({ type: 'range', value: '0.4' }), '0.4');
  assert.equal(W.cssValue({ type: 'checkbox', value: 'on', checked: true }), '1');
  assert.equal(W.cssValue({ type: 'checkbox', value: 'on', checked: false }), '0');
  assert.equal(W.cssValue({ type: 'color', value: '#4fae7c' }), '#4fae7c');
  assert.equal(W.cssValue({ type: 'select', value: 'ui-serif, Georgia' }), 'ui-serif, Georgia');
});

test('a tune says its values the way people do', () => {
  const values = [
    { label: 'Corner radius', type: 'range', value: '18', unit: 'px' },
    { label: 'Shadow', type: 'checkbox', value: 'on', checked: true },
    { label: 'Type:', type: 'select', value: 'ui-serif, Georgia', text: 'Serif' },
    { label: 'Accent', type: 'color', value: '#4fae7c' },
    { label: 'Density', type: 'select', value: 'Compact', text: 'Compact' },
  ];
  assert.equal(W.describeValues(values), 'Corner radius 18px, Shadow on, Type Serif (ui-serif, Georgia), Accent #4fae7c, Density Compact');
  assert.equal(W.fillTune('Set the chat cards to {values}', values.slice(0, 2)), 'Set the chat cards to Corner radius 18px, Shadow on');
  assert.equal(W.fillTune(null, values.slice(0, 1)), 'Corner radius 18px');
  assert.equal(W.fillTune('Use', values.slice(0, 1)), 'Use Corner radius 18px');
  // A long value behind short words is not repeated.
  assert.equal(W.shownValue({ label: 'Font', type: 'select', value: 'x'.repeat(60), text: 'Long one' }), 'Long one');
});

// ---- rank ----

test('a ranking is a numbered list on lines of its own', () => {
  assert.equal(W.fillRank(null, ['Widgets', 'Codex']), 'In this order:\n1. Widgets\n2. Codex');
  assert.equal(W.fillRank('Do them in this order: {order}', ['A', 'B']), 'Do them in this order:\n1. A\n2. B');
  assert.equal(W.fillRank('Do them in this order:\n{order}', ['A', 'B']), 'Do them in this order:\n1. A\n2. B');
  assert.equal(W.fillRank('{order}', ['A']), '1. A');
  assert.equal(W.fillRank('Ranked', ['A', 'B']), 'Ranked\n1. A\n2. B');
});

test('moving an item, and a remembered order meeting the items there are now', () => {
  assert.deepEqual(M.moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(M.moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(M.moveItem(['a', 'b', 'c'], 1, 9), ['a', 'c', 'b']);
  assert.deepEqual(M.moveItem(['a', 'b'], 5, 0), ['a', 'b']);
  assert.deepEqual(M.reconcileOrder(['c', 'a', 'gone', 'a'], ['a', 'b', 'c']), ['c', 'a', 'b']);
  assert.deepEqual(M.reconcileOrder(null, ['a', 'b']), ['a', 'b']);
});

// ---- markup ----

test('words are cut short at a word, with an ellipsis', () => {
  assert.equal(M.cut('Short'), 'Short');
  assert.equal(M.cut('  many   spaces\n here '), 'many spaces here');
  const long = 'Calm software for people who build with AI, every single day of the week and then some';
  const c = M.cut(long);
  assert.ok(c.length <= 61, c);
  assert.ok(c.endsWith('…'));
  assert.ok(long.startsWith(c.slice(0, -1)));
  assert.equal(M.cut('x'.repeat(100), 10), `${'x'.repeat(10)}…`);
});

test('an element is named by its words and its role or tag', () => {
  assert.equal(M.describeElement({ tag: 'h1', text: 'Calm software for people who build with AI' }), '"Calm software for people who build with AI" (h1)');
  assert.equal(M.describeElement({ tag: 'div', role: 'button', text: 'Download' }), '"Download" (button)');
  assert.equal(M.describeElement({ tag: 'img', selector: 'header > img.logo' }), 'header > img.logo');
  assert.equal(M.describeElement({ tag: 'section' }), 'the section');
  assert.equal(M.describeElement(null), 'the design');
  assert.equal(M.noteSubject('box', { tag: 'div', text: 'Download for Mac Watch the tour' }), 'Box around "Download for Mac Watch the tour" (div)');
  assert.equal(M.noteSubject('pin', { tag: 'span', text: 'Pricing' }), '"Pricing" (span)');
});

test("a screenshot's map gives the smallest element that says something under a point", () => {
  const map = [
    { x: 0, y: 0, w: 1280, h: 800, tag: 'body', text: 'Everything on the page' },
    { x: 100, y: 150, w: 900, h: 200, tag: 'h1', text: 'Calm software for people who build with AI' },
    { x: 100, y: 150, w: 300, h: 90, tag: 'span', text: '' },
    { x: 100, y: 400, w: 200, h: 50, tag: 'a', role: 'button', text: 'Download for Mac' },
    { x: 320, y: 400, w: 200, h: 50, tag: 'a', role: 'button', text: 'Watch the tour' },
    { x: 90, y: 390, w: 440, h: 70, tag: 'div', text: 'Download for Mac Watch the tour' },
  ];
  assert.equal(M.elementAt(map, 200, 200).tag, 'h1');
  assert.equal(M.elementAt(map, 150, 420).text, 'Download for Mac');
  assert.equal(M.elementAt(map, 1200, 700).tag, 'body');
  assert.equal(M.elementAt(map, 5000, 5000), null);
  assert.equal(M.elementAt([], 1, 1), null);
});

test('a box names what it was drawn around: the outermost things inside it', () => {
  const buttons = [
    { x: 100, y: 400, w: 200, h: 50, tag: 'a', role: 'button', text: 'Download for Mac' },
    { x: 320, y: 400, w: 200, h: 50, tag: 'button', text: 'Watch the tour' },
    { x: 110, y: 410, w: 20, h: 20, tag: 'svg', text: '' },
  ];
  const row = { x: 90, y: 390, w: 440, h: 70, tag: 'div', text: 'Download for Mac Watch the tour' };
  const page = { x: 0, y: 0, w: 1280, h: 800, tag: 'main', text: 'Everything' };
  // The row fits in the box: it is named, not the buttons in it.
  assert.deepEqual(M.inBox([page, row, ...buttons], { x: 85, y: 385, w: 450, h: 80 }).map((e) => e.tag), ['div']);
  // A box drawn tighter than the row holds the two buttons.
  const two = M.inBox([page, row, ...buttons], { x: 98, y: 398, w: 424, h: 54 });
  assert.deepEqual(two.map((e) => e.text), ['Download for Mac', 'Watch the tour']);
  assert.equal(M.boxSubject(two), 'Box around "Download for Mac" (button), "Watch the tour" (button)');
  // Nothing whole inside it.
  assert.deepEqual(M.inBox([page, row, ...buttons], { x: 110, y: 405, w: 100, h: 30 }), []);
  // The same rect twice is one thing.
  assert.equal(M.inBox([buttons[0], { ...buttons[0] }], { x: 0, y: 0, w: 999, h: 999 }).length, 1);
  assert.equal(M.boxSubject([{ tag: 'p', text: 'a' }, { tag: 'p', text: 'b' }, { tag: 'p', text: 'c' }, { tag: 'p', text: 'd' }]), 'Box around "a" (p), "b" (p), "c" (p) and 1 more');
  assert.equal(M.boxSubject([]), 'Box around the design');
});

test('notes on a design become one message, numbered, without the empty ones', () => {
  const text = W.markupMessage('the landing page', [
    { what: '"Calm software for…" (h1)', note: 'one line too long' },
    { what: 'The top right of the design', note: '   ' },
    { what: 'Box around "Download for Mac Watch the tour" (div)', note: 'too close\ntogether' },
  ]);
  assert.equal(text, 'Notes on the landing page:\n1. "Calm software for…" (h1): one line too long\n2. Box around "Download for Mac Watch the tour" (div): too close together');
  assert.equal(W.markupMessage('', [{ what: 'x', note: 'y' }]), 'Notes on the design:\n1. x: y');
});

test('a point on a design in words, and fractions kept small', () => {
  assert.equal(M.whereOn(0.1, 0.1), 'top left');
  assert.equal(M.whereOn(0.5, 0.5), 'middle');
  assert.equal(M.whereOn(0.9, 0.5), 'right');
  assert.equal(M.whereOn(0.5, 0.95), 'bottom');
  assert.equal(M.unit(0.123456789), 0.1235);
  assert.equal(M.unit(-1), 0);
  assert.equal(M.unit(3), 1);
  assert.equal(M.unit(NaN), 0);
});

// The widget frame's text work (renderer/src/frame): cutting HTML that is still being written back to what can be
// drawn, reading CSV and the numbers in it, and working out a diff. These files run in the window; the parts tested
// here touch no DOM, and node reads their TypeScript directly.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

const frame = (file) => import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/frame', file)).href);
const [S, C, D] = await Promise.all([frame('stream.ts'), frame('csv.ts'), frame('diff.ts')]);

// ---- safePrefix ----

test('whole HTML is left as it is', () => {
  for (const html of [
    '', 'plain text', '<p>Hello</p>', '<div class="a" data-x=\'1 > 0\'><b>x</b></div>', 'a < b and c > d', '5 <= 6 &amp; 7',
    '<style>.a{color:red}</style><p>x</p><script>if (a < b) { go("</p>"); }</script>', '<!-- note --><p>x</p>',
    '<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>', '<textarea>a < b</textarea><p>after</p>', '<br/><img alt="a>b"/>',
  ]) assert.equal(S.safePrefix(html), html, html);
});

test('every prefix of a widget is drawable: never half a tag, an entity, a style rule or a script', () => {
  const html = `<style>
.card { padding: 12px; border: 1px solid var(--color-border-tertiary); }
.card h3 { margin: 0 0 4px; }
@media (max-width: 400px) { .card { padding: 8px; } }
</style>
<div class="card" title="a > b">
  <h3>Caf&eacute; &amp; bar &#8212; totals</h3>
  <p>1 < 2 and <a href="https://example.com/?a=1&amp;b=2">a link</a></p>
  <canopy-table caption="x">
A,B
1,2
</canopy-table>
  <!-- a comment with <tags> inside -->
  <svg viewBox="0 0 10 10"><text x="1">hi</text></svg>
</div>
<script>
const el = document.querySelector('.card');
if (1 < 2) el.innerHTML = '<b>done</b>';
</script>`;
  let last = '';
  for (let i = 0; i <= html.length; i++) {
    const out = S.safePrefix(html.slice(0, i));
    assert.ok(html.startsWith(out), `at ${i}: the result is a prefix`);
    assert.ok(out.length >= last.length, `at ${i}: it only grows`);
    last = out;
    // No tag left open at the end.
    const lt = out.lastIndexOf('<');
    if (lt >= 0 && !out.slice(lt).startsWith('<style')) assert.ok(out.indexOf('>', lt) > 0 || !/^<[a-zA-Z/!]/.test(out.slice(lt)), `at ${i}: ends inside a tag: ${JSON.stringify(out.slice(-30))}`);
    // No entity left half written.
    assert.ok(!/&#?[a-zA-Z0-9]*$/.test(out), `at ${i}: ends inside an entity: ${JSON.stringify(out.slice(-12))}`);
    // A script is all there or not there at all.
    assert.ok(!out.includes('<script') || out.includes('</script>'), `at ${i}: half a script`);
    // A style block that is still open holds only whole rules.
    const open = out.lastIndexOf('<style>');
    if (open >= 0 && !out.includes('</style>')) assert.ok(out.endsWith('}'), `at ${i}: half a style rule: ${JSON.stringify(out.slice(-30))}`);
    // A comment is whole or absent.
    assert.ok(!out.includes('<!--') || out.includes('-->'), `at ${i}: half a comment`);
  }
  assert.equal(S.safePrefix(html), html);
});

test('what is held back, and what is not', () => {
  assert.equal(S.safePrefix('<p>Hello <b cla'), '<p>Hello ');
  assert.equal(S.safePrefix('<p>Hello <'), '<p>Hello ');
  assert.equal(S.safePrefix('<p>Fish &am'), '<p>Fish ');
  assert.equal(S.safePrefix('<p>Fish &amp'), '<p>Fish ');
  assert.equal(S.safePrefix('<p>Fish &amp;'), '<p>Fish &amp;');
  assert.equal(S.safePrefix('<p>AT&T rocks'), '<p>AT&T rocks', 'an ampersand long past is text');
  assert.equal(S.safePrefix('<p>1 < 2'), '<p>1 < 2', 'a "<" that starts no tag is text');
  assert.equal(S.safePrefix('<style>.a{color:red}.b{opacity:0'), '<style>.a{color:red}');
  assert.equal(S.safePrefix('<style>.a{col'), '', 'no whole rule yet: no style block at all');
  assert.equal(S.safePrefix('<p>x</p><style>.a{}</sty'), '<p>x</p><style>.a{}');
  assert.equal(S.safePrefix('<p>x</p><script>const a = "<p>";'), '<p>x</p>');
  assert.equal(S.safePrefix('<p>x</p><script>go()</scr'), '<p>x</p>');
  assert.equal(S.safePrefix('<p>x</p><SCRIPT>go()</SCRIPT><p>y'), '<p>x</p><SCRIPT>go()</SCRIPT><p>y');
  assert.equal(S.safePrefix('<p>x</p><!-- half'), '<p>x</p>');
  assert.equal(S.safePrefix('<a href="x>y" title=\'it'), '');
  assert.equal(S.safePrefix('<textarea>draft <b'), '<textarea>draft <b', 'a textarea\'s content is text');
  assert.equal(S.safePrefix('<canopy-table>\nA,B\n1,'), '<canopy-table>\nA,B\n1,');
});

// ---- CSV and numbers ----

test('CSV reads the way people write it', () => {
  assert.deepEqual(C.parseCsv('A,B\n1,2\n'), [['A', 'B'], ['1', '2']]);
  assert.deepEqual(C.parseCsv('\n  Name , Note \n"Smith, J","said ""hi"""\n\nlast,\n'), [['Name', 'Note'], ['Smith, J', 'said "hi"'], ['last', '']]);
  assert.deepEqual(C.parseCsv('A\tB\n1,5\t2\r\n3\t4'), [['A', 'B'], ['1,5', '2'], ['3', '4']], 'tabs when the first line has one');
  assert.deepEqual(C.parseCsv('A,B\n"two\nlines",2'), [['A', 'B'], ['two\nlines', '2']]);
  assert.deepEqual(C.parseCsv('A,B\n" padded ",2'), [['A', 'B'], [' padded ', '2']], 'quotes keep their spaces');
  assert.deepEqual(C.parseCsv(''), []);
  // Still being written: the line in progress is left out.
  assert.deepEqual(C.parseCsv('A,B\n1,2\n3,', true), [['A', 'B'], ['1', '2']]);
  assert.deepEqual(C.parseCsv('A,B', true), []);
  assert.deepEqual(C.parseCsv('A,B\n1,2\n', true), [['A', 'B'], ['1', '2']]);
});

test('numbers are found under their dress, and scaled by their unit', () => {
  const n = C.numberOf;
  assert.deepEqual(['42', '1,204', '$7.12', '2.1%', '912 ms', '-3.5', '−3.5', '+4', '.5', '1,830,400', '€1,200.50'].map(n), [42, 1204, 7.12, 2.1, 912, -3.5, -3.5, 4, 0.5, 1830400, 1200.5]);
  assert.ok(n('1.2 s') > n('900 ms'));
  assert.ok(n('2 MB') > n('900 KB'));
  assert.ok(n('1.2k') > n('900'));
  assert.ok(n('3 M') > n('900 k') && n('2 min') < n('1 h'), 'M is millions, m is minutes');
  assert.ok(n('$2B') > n('$900M'));
  assert.deepEqual(['', 'abc', '12 apples', 'v1.2.3', '1-2', '2026-11-15', 'Opus 5.5', '12:30'].map(n), Array(8).fill(null));
  assert.equal(C.isNumeric(['1', '', '2.5%', '—']), true);
  assert.equal(C.isNumeric(['1', 'n/a']), false);
  assert.equal(C.isNumeric(['', '']), false, 'a column of nothing is not a column of numbers');
});

test('numbers are written for reading, and axes land on round steps', () => {
  assert.deepEqual([1204, 12.5, 0.042, 1234.56, 99.5, 0].map((v) => C.formatNumber(v)), ['1,204', '12.5', '0.042', '1,235', '99.5', '0']);
  assert.deepEqual([1200, 15300, 2_500_000, 999, 1_000_000_000].map((v) => C.formatNumber(v, true)), ['1.2k', '15k', '2.5M', '999', '1B']);
  assert.deepEqual(C.niceTicks(0, 2790), [0, 1000, 2000, 3000]);
  assert.deepEqual(C.niceTicks(0, 97), [0, 25, 50, 75, 100]);
  assert.deepEqual(C.niceTicks(0, 0.9), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(C.niceTicks(-40, 80, 3), [-50, 0, 50, 100]);
  assert.deepEqual(C.niceTicks(0, 0), [0, 0.25, 0.5, 0.75, 1], 'no data still gets an axis');
  assert.ok(C.niceTicks(120, 180)[0] === 0, 'bars and areas are measured from zero');
});

// ---- diff ----

const kinds = (lines) => lines.map((l) => `${l.k}${l.t}`);

test('a diff keeps what is the same and pairs what changed, removals first', () => {
  assert.deepEqual(kinds(D.diffLines('a\nb\nc', 'a\nB\nc')), [' a', '-b', '+B', ' c']);
  assert.deepEqual(kinds(D.diffLines('a\nb', 'a\nb\nc\nd')), [' a', ' b', '+c', '+d']);
  assert.deepEqual(kinds(D.diffLines('a\nb\nc\nd', 'a\nd')), [' a', '-b', '-c', ' d']);
  assert.deepEqual(kinds(D.diffLines('', 'new')), ['+new']);
  assert.deepEqual(kinds(D.diffLines('old', '')), ['-old']);
  assert.deepEqual(kinds(D.diffLines('same', 'same')), [' same']);
  assert.deepEqual(kinds(D.diffLines('x\ny', 'p\nq')), ['-x', '-y', '+p', '+q']);
  const lines = D.diffLines('one\ntwo\nthree', 'one\n2\nthree\nfour');
  assert.deepEqual(lines.map((l) => [l.a ?? null, l.b ?? null]), [[1, 1], [2, null], [null, 2], [3, 3], [null, 4]], 'each line knows where it sits in both texts');
});

test('two long texts with little in common are shown whole rather than compared forever', () => {
  const a = Array.from({ length: 1600 }, (_, i) => `old ${i}`).join('\n');
  const b = Array.from({ length: 1600 }, (_, i) => `new ${i}`).join('\n');
  const t0 = performance.now();
  const lines = D.diffLines(a, b);
  assert.ok(performance.now() - t0 < 500);
  assert.equal(lines.filter((l) => l.k === '-').length, 1600);
  assert.equal(lines.filter((l) => l.k === '+').length, 1600);
});

test('a unified diff is recognized and read as it is', () => {
  const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,3 +3,4 @@\n keep\n-gone\n+here\n+more\n';
  assert.equal(D.isUnified(text), true);
  assert.equal(D.isUnified('- a list item\n- another'), true, 'reads as removals; two <pre> blocks is how to avoid the doubt');
  assert.equal(D.isUnified('just some\nplain text'), false);
  assert.equal(D.isUnified('+only one line'), false);
  const lines = D.parseUnified(text);
  assert.deepEqual(kinds(lines), [' keep', '-gone', '+here', '+more']);
  assert.deepEqual(lines.map((l) => [l.a ?? null, l.b ?? null]), [[3, 3], [4, null], [null, 4], [null, 5]]);
});

test('context is kept around changes, and the unchanged middle is left out', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const b = a.slice(); b[2] = 'changed 3'; b[25] = 'changed 26';
  const runs = D.hunks(D.diffLines(a.join('\n'), b.join('\n')), 2);
  assert.equal(runs.length, 2);
  assert.deepEqual(kinds(runs[0].lines), [' line 1', ' line 2', '-line 3', '+changed 3', ' line 4', ' line 5']);
  assert.deepEqual([runs[0].at, runs[1].at], [1, 24]);
  assert.deepEqual(D.hunks(D.diffLines('a\nb', 'a\nb')), [], 'nothing changed: nothing to show');
});

test('prose is compared word by word, and a reworded stretch reads as one change', () => {
  const text = (pieces) => pieces.map((p) => (p.k === '-' ? `[-${p.t}-]` : p.k === '+' ? `{+${p.t}+}` : p.t)).join('');
  const d = D.diffWords('Please try again later or contact support if the problem persists.', 'Please try again, or contact support if it keeps happening.');
  assert.equal(text(d.pieces), 'Please try again[- later-]{+,+} or contact support if [-the problem persists-]{+it keeps happening+}.');
  assert.ok(d.same > 0.5 && d.same < 1);
  assert.equal(text(D.diffWords('Starter: $9 per month', 'Starter: $12 per month').pieces), 'Starter: $[-9-]{+12+} per month');
  assert.equal(text(D.diffWords('same words', 'same words').pieces), 'same words');
  assert.equal(D.diffWords('same words', 'same words').same, 1);
  assert.equal(text(D.diffWords('', 'all new').pieces), '{+all new+}');
  assert.equal(text(D.diffWords('all old', '').pieces), '[-all old-]');
  assert.ok(D.diffWords('Starter costs nine dollars', 'Cancel any time you like').same < 0.3, 'different sentences have little in common');
  // Put back together, the pieces are the two texts.
  const pair = ['The quick brown fox jumps over the lazy dog.', 'A quick red fox leapt over one very lazy dog!'];
  const p = D.diffWords(pair[0], pair[1]).pieces;
  assert.equal(p.filter((x) => x.k !== '+').map((x) => x.t).join(''), pair[0]);
  assert.equal(p.filter((x) => x.k !== '-').map((x) => x.t).join(''), pair[1]);
});

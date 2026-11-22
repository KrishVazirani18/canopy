// A running command's output as the window keeps it (renderer/src/lib/tail.ts): a chunk added to the end, the cap
// taken from the start, a carriage return redrawing its line, a chunk that stops mid-line, and the last few lines
// shown under the step. The file is plain TypeScript, so node runs it as it is: no build and no window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as T from '../../../../renderer/src/lib/tail.ts';

test('a chunk goes on the end, and an empty one changes nothing', () => {
  assert.equal(T.appendOutput('', 'line 2\n', 100), 'line 2\n');
  assert.equal(T.appendOutput('line 2\n', 'line 3\n', 100), 'line 2\nline 3\n');
  assert.equal(T.appendOutput('kept', '', 100), 'kept');
});

test('what is not text counts as no text, and nothing throws', () => {
  assert.equal(T.appendOutput(undefined, 'a', 100), 'a');
  assert.equal(T.appendOutput('a', null, 100), 'a');
  assert.equal(T.appendOutput('a', 5, 100), 'a');
  assert.equal(T.appendOutput({}, [], 100), '');
  assert.equal(T.lastLines(undefined, 3), '');
  assert.equal(T.lastLines('a\nb', 0), '');
  assert.equal(T.lastLines('a\nb', NaN), '');
});

test('over the cap the start goes, never the end', () => {
  const out = T.appendOutput('0123456789', 'abcdefghij', 12);
  assert.equal(out, '89abcdefghij');
  assert.equal(T.appendOutput('x'.repeat(50), 'THE END', 20).endsWith('THE END'), true);
  assert.equal(T.appendOutput('x'.repeat(50), 'THE END', 20).length, 20);
});

test('what is kept starts on a whole line when the cut line ends soon', () => {
  // The cap falls two characters into "bbbb": the rest of that line goes too, so the first line shown is a whole one.
  const lines = 'aaaa\nbbbb\n' + 'c'.repeat(60) + '\n';
  assert.equal(T.appendOutput(lines, 'last\n', 69), 'c'.repeat(60) + '\nlast\n');
  // A cut line that runs on for longer than a tenth of the cap is kept from where the cap fell.
  const long = T.appendOutput('y'.repeat(100) + '\nend\n', 'z\n', 50);
  assert.equal(long.length, 50);
  assert.equal(long.startsWith('yyyy'), true);
});

test('the cap falls back to the default when it is not a real one', () => {
  assert.equal(T.OUTPUT_CAP, 64_000);
  const big = 'x'.repeat(T.OUTPUT_CAP + 500);
  for (const cap of [0, -1, NaN, Infinity, undefined]) assert.equal(T.appendOutput('', big, cap).length, T.OUTPUT_CAP);
});

test('a carriage return redraws its line: a progress bar is one line, not a hundred', () => {
  let out = 'Downloading\n';
  for (let i = 1; i <= 100; i++) out = T.appendOutput(out, `\r${i}%`, 1000);
  assert.equal(out, 'Downloading\n100%');
  assert.equal(T.appendOutput(out, '\ndone\n', 1000), 'Downloading\n100%\ndone\n');
  // Several redraws inside one chunk, and lines above the one being redrawn are left alone.
  assert.equal(T.appendOutput('first\n', 'a\rbb\rccc\nnext', 1000), 'first\nccc\nnext');
});

test('a Windows line ending is a line break, even when it is split between two chunks', () => {
  assert.equal(T.appendOutput('', 'one\r\ntwo\r\n', 1000), 'one\ntwo\n');
  const half = T.appendOutput('', 'one\r', 1000);
  assert.equal(half, 'one\r');                                   // not known yet: a line break, or a redraw
  assert.equal(T.appendOutput(half, '\ntwo', 1000), 'one\ntwo'); // it was a line break
  assert.equal(T.appendOutput(half, 'ONE', 1000), 'ONE');        // it was a redraw
});

test('a chunk that ends mid-line is finished by the next one', () => {
  const a = T.appendOutput('', 'compil', 1000);
  assert.equal(a, 'compil');
  const b = T.appendOutput(a, 'ing 3 files\nlink', 1000);
  assert.equal(b, 'compiling 3 files\nlink');
  assert.equal(T.lastLines(b, 3), 'compiling 3 files\nlink');
});

test('the last three lines, without the blank lines a command ends on', () => {
  assert.equal(T.lastLines('1\n2\n3\n4\n5\n', 3), '3\n4\n5');
  assert.equal(T.lastLines('1\n2\n3\n4\n5\n\n\n  \n', 3), '3\n4\n5');
  assert.equal(T.lastLines('only\n', 3), 'only');
  assert.equal(T.lastLines('', 3), '');
  assert.equal(T.lastLines('\n\n\n', 3), '');
  // A blank line between two lines of output is a line.
  assert.equal(T.lastLines('a\n\nb\n', 3), 'a\n\nb');
});

test('the last lines of a progress bar are what it shows now', () => {
  assert.equal(T.lastLines('start\n10%\r20%\r30%', 3), 'start\n30%');
  assert.equal(T.lastLines('start\n30%\r', 3), 'start\n30%');
});

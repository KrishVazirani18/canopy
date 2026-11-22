// LaTeX's own math delimiters, \( … \) and \[ … \], become the dollar math the reply renderer draws
// (renderer/src/lib/math-delimiters.ts). Codex writes them; markdown alone showed them as "(x_{\mathrm{max}})".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMath } from '../../../../renderer/src/lib/math-delimiters.ts';

test('inline \\( … \\) becomes $$ … $$, and single dollars stay prices', () => {
  assert.equal(normalizeMath('Let \\(x_{\\mathrm{max}}\\) be the largest \\(x\\). It costs $5.'), 'Let $$x_{\\mathrm{max}}$$ be the largest $$x$$. It costs $5.');
});

test('\\[ … \\] on its own line is a display block, at the line indent inside a list', () => {
  assert.equal(normalizeMath('Display:\n\\[\nA = \\{x\\}\n\\]\nafter'), 'Display:\n$$\nA = \\{x\\}\n$$\nafter');
  assert.equal(normalizeMath('- item\n  \\[x^2\\] tail'), '- item\n  $$\n  x^2\n  $$\n   tail');
  // In the middle of a sentence it stays inline.
  assert.equal(normalizeMath('so \\[x+1\\] here'), 'so $$x+1$$ here');
});

test('code is left exactly as written, and an unclosed delimiter (still streaming) is left alone', () => {
  const code = 'run `\\(not math\\)` and\n```\n\\[still code\\]\n```\n';
  assert.equal(normalizeMath(code + '\\(yes\\)'), code + '$$yes$$');
  assert.equal(normalizeMath('```tex\n\\(open fence'), '```tex\n\\(open fence');
  assert.equal(normalizeMath('unclosed \\( streaming'), 'unclosed \\( streaming');
  assert.equal(normalizeMath('a blank line ends it \\(x\n\ny\\)'), 'a blank line ends it \\(x\n\ny\\)');
});

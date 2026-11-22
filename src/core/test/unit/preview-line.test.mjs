// A sidebar row's second line as plain words and math (renderer/src/lib/preview-line.ts). Codex lines used to show
// "### (a) \(x_{\mathrm{max}}\)" and "Opened **[the report at page 24](htt…" as written.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewParts } from '../../../../renderer/src/lib/preview-line.ts';

test('math in \\( \\), \\[ \\] and $$ $$ comes out as math; prices stay words', () => {
  assert.deepEqual(previewParts('### (a) \\(x_{\\mathrm{max}}\\)'), [{ text: '(a) ' }, { tex: 'x_{\\mathrm{max}}' }]);
  assert.deepEqual(previewParts('so $$x^2$$ and \\[y\\] cost $5'), [{ text: 'so ' }, { tex: 'x^2' }, { text: ' and ' }, { tex: 'y' }, { text: ' cost $5' }]);
  assert.deepEqual(previewParts('unclosed \\(x_{\\mathrm{m…'), [{ text: 'unclosed \\(x_{\\mathrm{m…' }]);
});

test('markdown marks come off, including a link cut off mid-address', () => {
  assert.deepEqual(previewParts('Opened **[the report at page 24](https://docs.example.com/fi…'), [{ text: 'Opened the report at page 24' }]);
  assert.deepEqual(previewParts('- `readRows` is [here](https://x.y/z).'), [{ text: 'readRows is here.' }]);
  assert.deepEqual(previewParts('Working…'), [{ text: 'Working…' }]);
});

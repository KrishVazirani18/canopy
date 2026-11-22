// core/codex-prices.mjs: OpenAI's list prices for the models Codex runs, and what a turn's tokens cost at them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_PRICES_SOURCE, codexCost, codexRates } from '../../codex-prices.mjs';

const NOV = Date.UTC(2026, 10, 17);
const M = 1_000_000;

test('list prices per million tokens, by model and by speed', () => {
  assert.deepEqual(codexRates('gpt-6.1-sol', null, NOV), { input: 2, cached: 0.1, write: 2.5, output: 10 });
  assert.deepEqual(codexRates('gpt-6.1-sol', 'default', NOV), codexRates('gpt-6.1-sol', null, NOV), 'Codex’s word for standard speed');
  assert.deepEqual(codexRates('gpt-6.1-sol', 'priority', NOV), { input: 4, cached: 0.2, write: 5, output: 20 }, 'Fast is twice Standard');
  const ultra = codexRates('gpt-6.1-sol', 'ultrafast', NOV);
  assert.deepEqual([ultra.input, +ultra.cached.toFixed(6), ultra.write, ultra.output], [12, 0.6, 15, 60], 'Ultrafast is six times Standard');
  assert.deepEqual(codexRates('gpt-6.1-sol', 'flex', NOV), { input: 1, cached: 0.05, write: 1.25, output: 5 });
  assert.deepEqual(codexRates('gpt-6-astra', null, NOV), { input: 10, cached: 1, write: 12.5, output: 50 });
  assert.deepEqual(codexRates('gpt-5.5', 'priority', NOV), { input: 12.5, cached: 1.25, write: 12.5, output: 75 }, 'gpt-5.5: Fast is 2.5x, and a cache write is input');
  const standard = (m) => { const r = codexRates(m, null, NOV); return [r.input, r.cached, r.output]; };
  assert.deepEqual(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'].map(standard),
    [[8, 0.4, 40], [2, 0.1, 10], [1, 0.05, 5], [2, 0.2, 10], [0.1, 0.01, 0.5], [4, 0.4, 20], [2, 0.2, 12], [0.2, 0.02, 1.2], [5, 0.5, 30]]);
  // Ultrafast on the gpt-6.2 models: three times Standard through February 2027, six times after.
  assert.deepEqual([Date.UTC(2027, 1, 28, 12), Date.UTC(2027, 2, 1, 12)].map((at) => codexRates('gpt-6.2-sol', 'ultrafast', at).input), [6, 12]);
  assert.equal(codexRates('gpt-6.1-sol-2026-10-01', null, NOV).input, 2, 'a dated snapshot costs what its model does');
  assert.match(CODEX_PRICES_SOURCE.url, /^https:\/\/developers\.openai\.com\//);
});

test('no price is ever guessed: an unknown model, or a speed OpenAI lists no price for, has none', () => {
  for (const model of ['gpt-7-nova', 'gpt-6.1-sol-mini', 'gpt-6', 'gpt-6.1', 'o9', '', null, undefined, 7, 'constructor', '__proto__']) {
    assert.equal(codexRates(model, null, NOV), null, String(model));
    assert.equal(codexCost(model, null, [M, M, M, M], NOV), null, String(model));
  }
  assert.equal(codexRates('gpt-6-sol', 'ultrafast', NOV), null, 'gpt-6-sol has no Ultrafast price');
  assert.equal(codexRates('gpt-6.2-sol', 'flex', NOV), null);
  assert.equal(codexRates('gpt-6.1-sol', 'warp', NOV), null);
  assert.equal(codexRates('gpt-6.1-sol', 'toString', NOV), null);
  assert.equal(codexCost('gpt-6.1-sol', null, null, NOV), null);
});

test('a turn’s cost: input, cached input, cache writes and output each at their own price', () => {
  assert.equal(codexCost('gpt-6.1-sol', null, [M, 0, 0, 0], NOV), 2);
  assert.equal(codexCost('gpt-6.1-sol', null, [0, M, 0, 0], NOV), 0.1);
  assert.equal(codexCost('gpt-6.1-sol', null, [0, 0, M, 0], NOV), 2.5);
  assert.equal(codexCost('gpt-6.1-sol', null, [0, 0, 0, M], NOV), 10, 'output, with its reasoning in it');
  assert.equal(codexCost('gpt-6.1-sol', 'priority', [M, M, M, M], NOV), 29.2);
  assert.equal(codexCost('gpt-6.1-sol', null, [-5, NaN, 'x', undefined], NOV), 0, 'what is not a count is nothing');
  // A long chat with Fast on, nearly all of it read from the cache.
  assert.equal(+codexCost('gpt-6.1-sol', 'priority', [4_000, 17_656_211, 625_432, 75_615], NOV).toFixed(2), 8.19);
});

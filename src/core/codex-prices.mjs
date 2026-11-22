// OpenAI's list prices for the models Codex runs, so a Codex account billed per use reads in dollars like a Claude
// one does. Codex itself has no price to give: for an API key its app-server answers its usage call with
// "chatgpt authentication required", and `model/list` and `modelProvider/capabilities/read` carry no prices
// (checked on codex-cli 0.169.0). So the table is kept here, in this one file, and refreshed with Canopy.
//
// Source: https://developers.openai.com/api/docs/pricing (the page platform.openai.com/docs/pricing leads to),
// read 2026-11-17. Dollars per million tokens, Standard processing, short context:
//
//   model            input   cached input   output
//   gpt-6.2-astra     8.00       0.40        40.00
//   gpt-6.2-sol       2.00       0.10        10.00
//   gpt-6.1-sol       2.00       0.10        10.00
//   gpt-6.1-terra     1.00       0.05         5.00
//   gpt-6-astra      10.00       1.00        50.00
//   gpt-6-sol         2.00       0.20        10.00
//   gpt-6-luna        0.10       0.01         0.50
//   gpt-5.6-sol       4.00       0.40        20.00   (a promotional price, "available until November 30, 2026")
//   gpt-5.6-terra     2.00       0.20        12.00
//   gpt-5.6-luna      0.20       0.02         1.20
//   gpt-5.5           5.00       0.50        30.00
//
// The other tiers are multiples of Standard on that page, each listed only for some models:
//   Fast (Codex calls it `priority`): 2x, and 2.5x for gpt-5.5.   Flex: half.
//   Ultrafast: 6x for gpt-6-astra and gpt-6.1-sol; for the gpt-6.2 models 3x through February 28, 2027, then 6x.
// Input written to the cache is the "30m write" column, 1.25x the input price (gpt-5.5 lists none: it is input).
// Reasoning is output: OpenAI counts it inside the output tokens, and it is billed at the output price.
//
// What this cannot know, and so does not price: a long-context request (over 272K input tokens costs more; the
// window Codex gives gpt-6.1-sol is 258K, under that), a 12-hour cache write (2.5x input; a turn does not say which
// it was), and any discount on the account. The figure is these list prices times the tokens Codex reported, no more.
//
// A model or a tier that is not in the table has no price here: `codexCost` answers null, and its tokens are
// shown as tokens. A wrong price is never guessed from a model's name.

const FAST = 'priority', ULTRAFAST = 'ultrafast', FLEX = 'flex';
const PROMO_ENDS = Date.UTC(2027, 2, 1, 8); // March 1, 2027, midnight Pacific
const promo = (at) => (at < PROMO_ENDS ? 3 : 6);

const row = (input, cached, output, tiers, write = 1.25) => ({ input, cached, output, write: input * write, tiers });
const PRICES = {
  'gpt-6.2-astra': row(8, 0.4, 40, { [FAST]: 2, [ULTRAFAST]: promo }),
  'gpt-6.2-sol': row(2, 0.1, 10, { [FAST]: 2, [ULTRAFAST]: promo }),
  'gpt-6.1-sol': row(2, 0.1, 10, { [FAST]: 2, [ULTRAFAST]: 6, [FLEX]: 0.5 }),
  'gpt-6.1-terra': row(1, 0.05, 5, { [FAST]: 2, [FLEX]: 0.5 }),
  'gpt-6-astra': row(10, 1, 50, { [FAST]: 2, [ULTRAFAST]: 6, [FLEX]: 0.5 }),
  'gpt-6-sol': row(2, 0.2, 10, { [FAST]: 2, [FLEX]: 0.5 }),
  'gpt-6-luna': row(0.1, 0.01, 0.5, { [FAST]: 2, [FLEX]: 0.5 }),
  'gpt-5.6-sol': row(4, 0.4, 20, { [FAST]: 2, [FLEX]: 0.5 }),
  'gpt-5.6-terra': row(2, 0.2, 12, { [FAST]: 2, [FLEX]: 0.5 }),
  'gpt-5.6-luna': row(0.2, 0.02, 1.2, { [FAST]: 2, [FLEX]: 0.5 }),
  'gpt-5.5': row(5, 0.5, 30, { [FAST]: 2.5, [FLEX]: 0.5 }, 1),
};

/** Where the prices are from, and when they were read. */
export const CODEX_PRICES_SOURCE = { url: 'https://developers.openai.com/api/docs/pricing', read: '2026-11-17' };

const DATED = /^-\d{4}-\d{2}-\d{2}$/; // a dated snapshot of a model costs what the model does
function priceRow(model) {
  if (typeof model !== 'string' || !model) return null;
  if (Object.hasOwn(PRICES, model)) return PRICES[model];
  for (const [name, p] of Object.entries(PRICES)) if (model.startsWith(name) && DATED.test(model.slice(name.length))) return p;
  return null;
}

/**
 * Dollars per million tokens for a model at a tier: { input, cached, write, output }, or null when the page lists
 * no price for it. `tier` is Codex's own word: null or 'default' (Standard), 'priority' (Fast), 'ultrafast', 'flex'.
 */
export function codexRates(model, tier, at = Date.now()) {
  const p = priceRow(model);
  if (!p) return null;
  let times = 1;
  if (tier !== null && tier !== undefined && tier !== '' && tier !== 'default') {
    const t = Object.hasOwn(p.tiers, tier) ? p.tiers[tier] : null;
    if (t === null) return null;
    times = typeof t === 'function' ? t(at) : t;
  }
  return { input: p.input * times, cached: p.cached * times, write: p.write * times, output: p.output * times };
}

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * What a turn's tokens cost at list price, in dollars, or null when the model or the tier has no known price.
 * `use`: [input, cached input, input written to the cache, output], each counted once (the input is what was
 * neither read from the cache nor written to it; the output has the reasoning in it).
 */
export function codexCost(model, tier, use, at = Date.now()) {
  const r = codexRates(model, tier, at);
  if (!r || !Array.isArray(use)) return null;
  return (count(use[0]) * r.input + count(use[1]) * r.cached + count(use[2]) * r.write + count(use[3]) * r.output) / 1e6;
}

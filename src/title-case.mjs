// Chat names in Title Case, as macOS shows window and document names. Claude Code and Codex name chats in sentence
// case ("Billing page copy"); the window shows "Billing Page Copy".
//
// Only plain lowercase words change. A word with a capital, a digit or any other mark in it is someone's exact
// spelling (GitHub, readRows, GPT-6.1, v2, src/main.mjs) and stays as it is. Short joining words (a, of, in, vs…)
// stay lowercase unless they open or close the name. A hyphenated word is cased part by part (Multi-Step).

const SMALL = new Set('a an and as at but by for from if in into nor of on onto or per so than the to up via vs with yet'.split(' '));
const PLAIN = /^[a-z][a-z'’]*$/;

/** "Billing page copy" → "Billing Page Copy". Anything that is not a string comes back as it is. */
export function titleCase(title) {
  if (typeof title !== 'string') return title;
  const words = title.split(/(\s+)/);
  const real = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter((i) => i >= 0);
  const first = real[0], last = real.at(-1);
  return words.map((w, i) => {
    if (!/\S/.test(w)) return w;
    if (SMALL.has(w) && i !== first && i !== last) return w;
    return w.split('-').map((part) => (PLAIN.test(part) ? part[0].toUpperCase() + part.slice(1) : part)).join('-');
  }).join('');
}

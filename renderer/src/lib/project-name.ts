// A project's name as Canopy shows it: its folder's name in Title Case, like the chat names (src/title-case.mjs).
// "canopy" → "Canopy", "canopy-ship-site" → "Canopy-Ship-Site". A part with a capital or digit in it (MyApp, v2)
// is spelled as it is. Only for showing: the folder itself is never renamed, and paths are never cased.
const PLAIN = /^[a-z][a-z'’]*$/;

/** "/Users/sam/code/canopy" → "Canopy". */
export function projectName(dir: string | null | undefined): string {
  const base = String(dir ?? '').replace(/\/+$/, '').split('/').pop() || String(dir ?? '');
  return base.split(/([-_ ]+)/).map((p) => (PLAIN.test(p) ? p[0].toUpperCase() + p.slice(1) : p)).join('');
}

import { toolIcons, type ToolIcon } from '../../../src/core/tool-icons.mjs';
export { toolIcons, type ToolIcon };

export type ToolBrand = { key: string; icons: ToolIcon[] };
export type ToolBrands = Record<string, ToolIcon[]>;
export const brandKey = (s: string) => s.toLowerCase().replace(/^plugin_[^_]+_/, '').replace(/[^a-z0-9]/g, '');

/** Learn logos only from server/tool identities and app catalog entries, never avatars or arbitrary image URLs. */
export function catalogBrands(value: unknown, server = ''): ToolBrand[] {
  const out: ToolBrand[] = [];
  let budget = 1200;
  function visit(v: unknown, depth: number) {
    if (--budget < 0 || depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const row of v.slice(0, 200)) visit(row, depth + 1); return; }
    const row = v as Record<string, unknown>;
    const icons = toolIcons(row);
    const identity = typeof row.slug === 'string' ? row.slug : typeof row.name === 'string' ? row.name : '';
    if (icons.length && identity) {
      out.push({ key: brandKey(identity), icons });
      if (server) out.push({ key: brandKey(`mcp__${server}__${identity}`), icons });
    }
    // These are provider/catalog envelopes, not unrestricted walks through a user's documents or messages.
    for (const key of ['data', 'items', 'toolkits', 'apps', 'tools', 'mcp', 'servers', 'results', 'response', 'response_data', 'toolkit', 'serverInfo']) visit(row[key], depth + 1);
    if (Array.isArray(row.content)) for (const part of row.content.slice(0, 20)) {
      if (part?.type === 'text') parse(part.text, depth + 1);
    }
  }
  function parse(text: unknown, depth: number) {
    if (typeof text !== 'string' || text.length > 1_000_000 || !/^\s*[[{]/.test(text)) return;
    try { visit(JSON.parse(text), depth); } catch { /* ordinary tool output */ }
  }
  if (typeof value === 'string') parse(value, 0); else visit(value, 0);
  return out;
}

export function chooseIcon(icons: ToolIcon[], dark: boolean, failed: string[] = []) {
  const theme = dark ? 'dark' : 'light';
  return icons.filter((i) => !failed.includes(i.src) && (!i.theme || i.theme === theme))
    .sort((a, b) => Number(b.theme === theme) - Number(a.theme === theme))[0]?.src;
}

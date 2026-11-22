// Settings → Customize: typed access to the main-process "customize:*" channels (src/customize.mjs).
import { useSyncExternalStore } from 'react';
// If the running build predates those channels, every call resolves to a friendly "restart" error instead of throwing.
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type McpServer = {
  name: string; label: string; plugin: string | null; target: string;
  transport: 'http' | 'sse' | 'stdio'; status: 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'pending'; detail: string;
};
export type McpSpec = { name: string; target: string; transport?: 'http' | 'sse' | 'stdio'; scope: 'user' | 'project' | 'local'; headers?: string[]; env?: string[] };
export type InstalledPlugin = { id: string; version?: string; scope?: string; enabled: boolean; installPath?: string; lastUpdated?: string };
export type CatalogPlugin = { id: string; name: string; description: string; marketplace: string; installs: number; version?: string };
export type PluginDetails = { text: string; alwaysOnTokens: string | null; skills: string[]; agents: number; hooks: number; mcp: string[] };
export type Marketplace = { name: string; source?: string; repo?: string; url?: string; installLocation?: string };
export type Skill = { name: string; description: string; source: 'user' | 'project' | 'plugin'; plugin: string | null; path: string; invoke: string };

type Bridge = Record<string, (...a: unknown[]) => Promise<unknown>>;
const bridge = () => (window as unknown as { canopy?: { customize?: Bridge } }).canopy?.customize;
const RESTART = { ok: false as const, error: 'Restart Canopy to finish setting this up.' };

async function call<T>(fn: string, ...args: unknown[]): Promise<Result<T>> {
  const b = bridge();
  if (!b?.[fn]) return RESTART;
  try {
    const r = (await b[fn](...args)) as { ok?: boolean; error?: string } | null;
    if (!r) return { ok: false, error: 'No response.' };
    if (r.ok === undefined) return { ok: false, error: r.error || 'Something went wrong.' }; // main's handle() wrapper caught a throw
    return r as Result<T>;
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

export const customize = {
  available: () => !!bridge(),
  mcpList: () => call<{ servers: McpServer[] }>('mcpList'),
  mcpAdd: (spec: McpSpec) => call('mcpAdd', spec),
  mcpRemove: (name: string, scope?: string) => call('mcpRemove', name, scope),
  mcpGet: (name: string) => call<{ text: string }>('mcpGet', name),
  plugins: (available = false) => call<{ installed: InstalledPlugin[]; available: CatalogPlugin[] }>('pluginsList', { available }),
  pluginAction: (action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update', id: string, scope?: string) => call<{ message?: string }>('pluginAction', action, id, scope),
  pluginDetails: (id: string) => call<PluginDetails>('pluginDetails', id),
  marketplaces: () => call<{ list: Marketplace[] }>('marketplaces'),
  marketplaceAdd: (source: string) => call('marketplaceAdd', source),
  skills: () => call<{ skills: Skill[] }>('skillsList'),
  skillRead: (path: string) => call<{ meta: Record<string, string>; body: string }>('skillRead', path),
};

/** "team-wiki" → "Team wiki"; known apps get their real names. */
const NAMES: Record<string, string> = {
  composio: 'Composio', notion: 'Notion', playwright: 'Playwright', context7: 'Context7', supabase: 'Supabase', vercel: 'Vercel',
  slack: 'Slack', github: 'GitHub', linear: 'Linear', sentry: 'Sentry', figma: 'Figma', codex: 'Codex',
};
export const prettyName = (s: string) => NAMES[s.toLowerCase()] ?? (s.charAt(0).toUpperCase() + s.slice(1)).replace(/[-_]/g, ' ');

// ---------- cached resources ----------
// Pages show cached data instantly and refresh quietly in the background (stale-while-revalidate), so
// opening a page never blanks out or jumps. Settings prefetches everything when it opens.

type Entry = { data?: unknown; error?: string; loading: boolean; at?: number };
const cache = new Map<string, Entry>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => { version++; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };

type Fetcher<T> = () => Promise<Result<T>>;
const FETCHERS: Record<string, Fetcher<unknown>> = {};
const MAX_AGE: Record<string, number> = {};

export function defineResource<T>(key: string, fetcher: Fetcher<T>, maxAgeMs = 60_000) {
  FETCHERS[key] = fetcher as Fetcher<unknown>;
  MAX_AGE[key] = maxAgeMs;
}

export async function refresh(key: string, force = false) {
  const e = cache.get(key) ?? { loading: false };
  if (e.loading) return;
  if (!force && e.at && Date.now() - e.at < (MAX_AGE[key] ?? 60_000)) return;
  cache.set(key, { ...e, loading: true }); emit();
  const r = await FETCHERS[key]();
  if (r.ok) cache.set(key, { data: r, loading: false, at: Date.now() });
  else cache.set(key, { ...e, loading: false, error: r.error, at: e.data ? e.at : undefined });
  emit();
  if (redo.delete(key)) await refresh(key, true); // what it was read from changed while it was on its way
}

const redo = new Set<string>();
/**
 * What was read may no longer hold: read it again now. For the Connectors list, which is read as the account new
 * chats use (connector sign-ins are kept per account), when that account changes. A list nobody has read yet is
 * left alone: its first read will be right. One on its way is read again as soon as it lands.
 */
export function invalidate(key: string) {
  const e = cache.get(key);
  if (!e) return;
  if (e.loading) { redo.add(key); return; }
  void refresh(key, true);
}

/** Optimistic local edit; the next refresh replaces it with the truth. */
export function mutate<T>(key: string, fn: (d: T) => T) {
  const e = cache.get(key);
  if (!e?.data) return;
  cache.set(key, { ...e, data: fn(e.data as T) }); emit();
}

export function useResource<T>(key: string): { data?: T; error?: string; loading: boolean; refresh: () => void } {
  useSyncExternalStore(subscribe, () => version);
  const e = cache.get(key);
  if (!e) queueMicrotask(() => refresh(key));
  return { data: e?.data as T | undefined, error: e?.data ? undefined : e?.error, loading: !!e?.loading || !e, refresh: () => refresh(key, true) };
}

defineResource('mcp', async () => {
  const [r, live] = await Promise.all([customize.mcpList(), (window as unknown as { canopy?: { mcpStatus?: () => Promise<unknown> } }).canopy?.mcpStatus?.().catch(() => []) ?? []]);
  if (!r.ok) return r;
  const tools: Record<string, { name: string; description?: string }[]> = {};
  if (Array.isArray(live)) for (const s of live as { name: string; tools?: { name: string; description?: string }[] }[]) if (s.tools?.length) tools[s.name] = s.tools;
  return { ok: true as const, servers: r.servers, tools };
}, 120_000);
defineResource('skills', () => customize.skills(), 60_000);
defineResource('plugins', () => customize.plugins(false), 60_000);
defineResource('catalog', () => customize.plugins(true), 600_000);
defineResource('markets', () => customize.marketplaces(), 300_000);

/** Warm the caches when Settings opens, so the tool pages open instantly. */
export function prefetchTools() { if (customize.available()) { refresh('mcp'); refresh('skills'); refresh('plugins'); refresh('markets'); } }

// Settings → Customize: Connectors (MCP servers), Skills and Plugins.
// Everything goes through Claude Code's own CLI (or reads the folders it reads), so a change made here is the
// same change the terminal sees. Canopy never writes Claude Code's config files itself.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Run `claude <args>`; never throws. Long timeout: installs can clone repos. */
function cli(ctx, args, { cwd, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    if (!ctx.claudePath) return resolve({ ok: false, out: '', err: 'Claude Code is not installed.' });
    try {
      execFile(ctx.claudePath, args, { cwd: cwd || ctx.cwd || os.homedir(), env: ctx.env, timeout, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr || error?.message || '').trim() }));
    } catch (err) { resolve({ ok: false, out: '', err: String(err?.message ?? err) }); } // an argument that is no string
  });
}
// What the window passes ends up as arguments of `claude`. A value that starts with a dash would be read as one of
// its options, so a name or an id is a plain, short string that does not; a scope or a transport is one of these.
const arg = (s) => (typeof s === 'string' && s && s.length <= 200 && !s.startsWith('-') ? s : null);
const SCOPES = new Set(['user', 'project', 'local']);
const TRANSPORTS = new Set(['http', 'sse', 'stdio']);
const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
const isWebUrl = (s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };
const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const clean = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const fail = (r) => ({ ok: false, error: clean(r.err || r.out).split('\n').filter(Boolean).slice(-3).join(' ') || 'Something went wrong.' });

// ---------- Connectors (MCP) ----------
// `claude mcp list` health-checks every configured server, in every scope, including plugin servers:
//   name: target (HTTP) - ✔ Connected  |  ! Needs authentication  |  ✘ Failed to connect
function parseMcpList(text) {
  const out = [];
  for (const raw of clean(text).split('\n')) {
    const m = raw.match(/^(.+?): (.+?)(?: \((HTTP|SSE|stdio)\))?\s+-\s+(.+)$/);
    if (!m) continue;
    const [, name, target, transport, state] = m;
    const status = /connected/i.test(state) ? 'connected' : /auth/i.test(state) ? 'needs-auth' : /disabled/i.test(state) ? 'disabled'
      : /pending|approval|unapproved/i.test(state) ? 'pending' : 'failed';
    const plugin = name.startsWith('plugin:') ? name.split(':')[1] : null;
    out.push({ name, label: plugin ? name.split(':').pop() : name, plugin, target: target.trim(), transport: (transport || 'stdio').toLowerCase(), status, detail: state.replace(/^[✔✘✓✗!×]\s*/, '').trim() });
  }
  return out;
}

async function mcpList(ctx, cwd) {
  const r = await cli(ctx, ['mcp', 'list'], { cwd, timeout: 60_000 });
  if (!r.ok && !r.out) return fail(r);
  return { ok: true, servers: parseMcpList(r.out) };
}

/** spec: { name, target, transport: 'http'|'sse'|'stdio', scope: 'user'|'project'|'local', headers?: string[], env?: string[] } */
async function mcpAdd(ctx, spec, cwd) {
  const name = String(spec?.name || '').trim();
  const target = String(spec?.target || '').trim();
  if (!/^[\w.-]+$/.test(name) || name.startsWith('-')) return { ok: false, error: 'Use letters, numbers, dots, dashes or underscores for the name.' };
  if (!target) return { ok: false, error: 'Add a URL or a command.' };
  const transport = spec.transport || (/^https?:\/\//.test(target) ? 'http' : 'stdio');
  const scope = spec.scope || 'user';
  if (!TRANSPORTS.has(transport) || !SCOPES.has(scope)) return { ok: false, error: 'Canopy can’t add a connector that way.' };
  if (transport !== 'stdio' && !isWebUrl(target)) return { ok: false, error: 'Add a URL that starts with http:// or https://.' };
  const args = ['mcp', 'add', '--transport', transport, '--scope', scope];
  for (const h of strings(spec.headers)) if (h.trim()) args.push('--header', h.trim());
  for (const e of strings(spec.env)) if (e.trim()) args.push('--env', e.trim());
  if (transport === 'stdio') {
    const parts = target.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((p) => p.replace(/^["']|["']$/g, '')) ?? [];
    args.push(name, '--', ...parts);
  } else args.push(name, target);
  const r = await cli(ctx, args, { cwd });
  return r.ok ? { ok: true } : fail(r);
}

async function mcpRemove(ctx, name, scope, cwd) {
  if (!arg(name) || (scope && !SCOPES.has(scope))) return { ok: false, error: 'Unknown connector.' };
  const r = await cli(ctx, ['mcp', 'remove', name, ...(scope ? ['--scope', scope] : [])], { cwd });
  return r.ok ? { ok: true } : fail(r);
}

async function mcpGet(ctx, name, cwd) {
  if (!arg(name)) return { ok: false, error: 'Unknown connector.' };
  const r = await cli(ctx, ['mcp', 'get', name], { cwd, timeout: 30_000 });
  return r.ok ? { ok: true, text: clean(r.out).trim() } : fail(r);
}

// ---------- Plugins ----------
let catalogCache = null; // { at, available } — the full catalog is ~4k entries; refresh at most every 10 minutes

async function pluginList(ctx, { available = false } = {}) {
  if (available && catalogCache && Date.now() - catalogCache.at < 600_000) {
    const r = await cli(ctx, ['plugin', 'list', '--json']);
    return r.ok ? { ok: true, installed: json(r.out, []), available: catalogCache.available } : fail(r);
  }
  const r = await cli(ctx, ['plugin', 'list', '--json', ...(available ? ['--available'] : [])], { timeout: 180_000 });
  if (!r.ok) return fail(r);
  const data = json(r.out, null);
  if (!data) return { ok: false, error: 'Couldn’t read the plugin list.' };
  if (Array.isArray(data)) return { ok: true, installed: data, available: [] };
  catalogCache = { at: Date.now(), available: (data.available || []).map((p) => ({
    id: p.pluginId, name: p.name, description: p.description || '', marketplace: p.marketplaceName, installs: p.installCount || 0, version: p.version,
  })).sort((a, b) => b.installs - a.installs) };
  return { ok: true, installed: data.installed || [], available: catalogCache.available };
}

const PLUGIN_ACTIONS = { install: ['install'], uninstall: ['uninstall'], enable: ['enable'], disable: ['disable'], update: ['update'] };
async function pluginAction(ctx, action, id, scope) {
  if (!PLUGIN_ACTIONS[action] || !arg(id) || !/^[\w.@/-]+$/.test(id) || (scope && !SCOPES.has(scope))) return { ok: false, error: 'Unknown plugin action.' };
  const args = ['plugin', ...PLUGIN_ACTIONS[action], id];
  if (scope && action !== 'update') args.push('--scope', scope);
  const r = await cli(ctx, args, { timeout: 300_000 });
  return r.ok ? { ok: true, message: clean(r.out).trim() } : fail(r);
}

async function pluginDetails(ctx, id) {
  if (!arg(id)) return { ok: false, error: 'Unknown plugin.' };
  const r = await cli(ctx, ['plugin', 'details', id], { timeout: 60_000 });
  if (!r.ok) return fail(r);
  const text = clean(r.out);
  const always = text.match(/Always-on:\s*~?([\d,.]+k?)\s*tok/i)?.[1] ?? null;
  const count = (label) => Number(text.match(new RegExp(`${label} \\((\\d+)\\)`))?.[1] ?? 0);
  const list = (label) => text.match(new RegExp(`${label} \\(\\d+\\)\\s+([^\\n]*)`))?.[1]?.split(/,\s*/).filter((x) => x && !x.startsWith('(')) ?? [];
  return { ok: true, text: text.trim(), alwaysOnTokens: always, skills: list('Skills'), agents: count('Agents'), hooks: count('Hooks'), mcp: list('MCP servers').map((x) => x.split(/\s/)[0]) };
}

async function marketplaces(ctx) {
  const r = await cli(ctx, ['plugin', 'marketplace', 'list', '--json']);
  return r.ok ? { ok: true, list: json(r.out, []) } : fail(r);
}
async function marketplaceAdd(ctx, source) {
  const s = String(source || '').trim();
  if (!s || s.startsWith('-')) return { ok: false, error: 'Paste a GitHub repo (owner/repo), a URL or a folder path.' };
  const r = await cli(ctx, ['plugin', 'marketplace', 'add', s], { timeout: 300_000 });
  catalogCache = null;
  return r.ok ? { ok: true } : fail(r);
}

// ---------- Skills ----------
// The same places Claude Code looks: yours (~/.claude/skills), this project's (.claude/skills), and enabled plugins'.
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  if (m) {
    const lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v === '' || /^[>|][-+]?$/.test(v)) { // YAML block scalar / folded value on the following indented lines
        const block = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
        v = block.join(' ');
      }
      meta[kv[1]] = v.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: m ? md.slice(m[0].length).trim() : md };
}
async function scanSkills(dir, source, plugin) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const { meta } = frontmatter(await readFile(file, 'utf8').catch(() => ''));
    out.push({ name: meta.name || e.name, description: meta.description || '', source, plugin: plugin || null, path: file, invoke: plugin ? `${plugin}:${meta.name || e.name}` : (meta.name || e.name) });
  }
  return out;
}
/** A plugin's skills: the folders its manifest lists (each a skill, or a folder of skills), else ./skills. */
async function pluginSkills(root, plugin) {
  const manifest = json(await readFile(path.join(root, '.claude-plugin/plugin.json'), 'utf8').catch(() => ''), {});
  const listed = Array.isArray(manifest?.skills) ? manifest.skills : typeof manifest?.skills === 'string' ? [manifest.skills] : null;
  if (!listed) return scanSkills(path.join(root, 'skills'), 'plugin', plugin);
  const out = [];
  const base = path.resolve(root);
  for (const rel of listed) {
    if (typeof rel !== 'string') continue;
    const dir = path.resolve(base, rel);
    if (dir !== base && !dir.startsWith(base + path.sep)) continue; // inside the plugin's own folder, never a sibling of it
    if (existsSync(path.join(dir, 'SKILL.md'))) out.push(...await scanSkills(path.dirname(dir), 'plugin', plugin).then((xs) => xs.filter((x) => path.dirname(x.path) === dir)));
    else out.push(...await scanSkills(dir, 'plugin', plugin));
  }
  return out;
}

async function skillsList(ctx, cwd) {
  const home = os.homedir();
  const lists = [scanSkills(path.join(home, '.claude/skills'), 'user')];
  const dir = cwd || ctx.cwd;
  if (dir && dir !== home) lists.push(scanSkills(path.join(dir, '.claude/skills'), 'project'));
  const r = await cli(ctx, ['plugin', 'list', '--json']);
  for (const p of r.ok ? json(r.out, []) : []) {
    if (!p.enabled || !p.installPath) continue;
    lists.push(pluginSkills(p.installPath, String(p.id).split('@')[0]));
  }
  const all = (await Promise.all(lists)).flat();
  return { ok: true, skills: all.sort((a, b) => a.name.localeCompare(b.name)) };
}
async function skillRead(file) {
  const home = os.homedir();
  const full = path.resolve(String(file));
  if (!full.startsWith(home + path.sep) || path.basename(full) !== 'SKILL.md') return { ok: false, error: 'Not a skill file.' };
  const md = await readFile(full, 'utf8').catch(() => null);
  if (md == null) return { ok: false, error: 'Couldn’t read that skill.' };
  const { meta, body } = frontmatter(md);
  return { ok: true, meta, body };
}

/**
 * Wire the IPC channels. `getCtx()` returns { claudePath, env, cwd } at call time: the user's own Claude Code
 * setup, where every change is made.
 * Connector sign-ins are kept per account, so the two calls that show a connector's state may be asked as the
 * account in use: `readCtx()` (async, same shape; default: `getCtx`). `afterWrite()` runs after a connector was
 * added or removed, for the host to bring its account folders in line before the list is read again.
 */
export function registerCustomize(handle, getCtx, { readCtx = getCtx, afterWrite } = {}) {
  const wrote = async (r) => { if (r?.ok) { try { await afterWrite?.(); } catch { /* the change itself went through */ } } return r; };
  handle('customize:mcp:list', async (cwd) => mcpList(await readCtx(), cwd));
  handle('customize:mcp:add', async (spec, cwd) => wrote(await mcpAdd(getCtx(), spec, cwd)));
  handle('customize:mcp:remove', async (name, scope, cwd) => wrote(await mcpRemove(getCtx(), name, scope, cwd)));
  handle('customize:mcp:get', async (name, cwd) => mcpGet(await readCtx(), name, cwd));
  handle('customize:plugins:list', (opts) => pluginList(getCtx(), opts || {}));
  handle('customize:plugins:action', (action, id, scope) => pluginAction(getCtx(), action, id, scope));
  handle('customize:plugins:details', (id) => pluginDetails(getCtx(), id));
  handle('customize:marketplaces:list', () => marketplaces(getCtx()));
  handle('customize:marketplaces:add', (source) => marketplaceAdd(getCtx(), source));
  handle('customize:skills:list', (cwd) => skillsList(getCtx(), cwd));
  handle('customize:skills:read', (file) => skillRead(file));
}

export const _test = { parseMcpList, frontmatter };

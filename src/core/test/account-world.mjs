// A made-up Mac for the account-folder tests: a home with a Claude Code folder, filled with the kinds of entries
// the real one has (a login file, policy files, a session registry, a background service, caches), and that
// folder's config file. Everything is made under a folder the test hands in (a temp folder): nothing here ever
// builds a path from the real home folder, and nothing reads or writes a real Claude Code folder or login.
import fs from 'node:fs';
import path from 'node:path';

export const put = (file, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
export const json = (file, value) => put(file, JSON.stringify(value, null, 2));
export const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const names = (dir) => fs.readdirSync(dir).sort();
export const stamp = (file) => { const st = fs.lstatSync(file); return `${st.ino} ${st.size} ${st.mtimeMs}`; };
export const isLinkTo = (p, to) => fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p) === to;
/** An executable shell script, standing in for `claude`. */
export function script(file, body) {
  put(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// What Claude Code keeps per sign-in or per Mac. None of it may ever be linked into an account folder.
export const PRIVATE = [
  '.credentials.json', '.claude.json', '.config.json', '.last-cleanup', '.last-update-result.json', '.DS_Store',
  'sessions/1234.json', 'daemon/roster.json', 'daemon.log', 'spares/a', 'state/x.json', 'telemetry/1.json',
  'policy-limits.json', 'policy-limits.json.signature.json', 'remote-settings.json', 'remote-settings.json.synced-at',
  'history.jsonl', 'shell-snapshots/snap.sh', 'backups/.claude.json.backup', 'cache/changelog.md', 'plugins/installed_plugins.json',
  'ide/1.lock', 'statsig/cache', 'todos/t.json', 'mcp-needs-auth-cache.json', 'stats-cache.json', 'settings.json.bak', 'session-env/e',
  'paste-cache/p', 'debug/d.txt', 'feedback/f', 'jobs/j',
];
// The user's own setup and data, as a long-time user has it.
export const SHARED = Object.freeze({
  'projects/-Users-someone-app/chat-1.jsonl': '{"type":"user"}\n', 'file-history/chat-1/a@v1': 'hello', 'plans/a-plan.md': '# plan',
  'skills/tidy/SKILL.md': '---\nname: tidy\n---', 'agents/reviewer.md': 'agent', 'commands/ship.md': 'cmd',
  'settings.json': '{"permissions":{"deny":["Bash(rm -rf *)"]}}', 'CLAUDE.md': 'be brief',
});
// The user's Claude Code config: their own login record, counters and caches, and the two things an account
// folder is given a copy of (connectors, and which folders were trusted).
export const USER_CONFIG = () => ({
  numStartups: 41, userID: 'user-id-of-the-default-login',
  oauthAccount: { emailAddress: 'default@example.com', accountUuid: 'acct-default', organizationUuid: 'org-default' },
  cachedChangelog: 'x'.repeat(200), tipsHistory: { a: 1 },
  mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' }, files: { command: 'npx', args: ['-y', 'fs-server'], env: { TOKEN: 'server-secret' } } },
  projects: {
    '/Users/someone/app': { hasTrustDialogAccepted: true, lastCost: 1.5, mcpServers: { local: { command: 'node', args: ['local.js'] } }, history: ['a prompt'] },
    '/Users/someone/untrusted': { hasTrustDialogAccepted: false, lastCost: 0.1 },
    '/Users/someone/plain': { hasTrustDialogAccepted: true },
  },
});
// An account folder's own config, as Claude Code leaves it after a sign-in: its own login record, counters and caches.
export const ACCOUNT_CONFIG = () => ({
  numStartups: 3, userID: 'user-id-of-the-account',
  oauthAccount: { emailAddress: 'work@example.com', accountUuid: 'acct-work', organizationUuid: 'org-work' },
  cachedStatsigGates: { a: true }, tipsHistory: { b: 2 },
  projects: { '/Users/someone/app': { lastCost: 9, history: ['asked on the account'] }, '/Users/someone/only-here': { hasTrustDialogAccepted: true, lastCost: 2 } },
});

/**
 * Make the home under `w`: `<w>/home/.claude` with the user's setup and Claude Code's private entries, and the
 * config file where Claude Code keeps it. `configInside`: the user's shell names the folder (CLAUDE_CONFIG_DIR),
 * so the config file sits inside it; otherwise beside it, as `~/.claude.json`.
 * @returns {{ w: string, home: string, base: string, baseConfig: string, root: string, outside: string }}
 */
export function fakeMac(w, { fill = SHARED, configInside = false } = {}) {
  const home = path.join(w, 'home');
  const base = path.join(home, '.claude');
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, text] of Object.entries(fill)) put(path.join(base, rel), text);
  for (const rel of PRIVATE) put(path.join(base, rel), `private:${rel}`);
  const baseConfig = json(path.join(configInside ? base : home, '.claude.json'), USER_CONFIG());
  const outside = path.join(w, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  return { w, home, base, baseConfig, root: path.join(w, 'canopy', 'accounts'), outside };
}

/**
 * Everything under a folder, as it is: kind, size, when it was last written, which file it is, where a link points
 * and what a file holds. Two equal snapshots mean nothing was created, changed, replaced or deleted in between.
 */
export function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name), r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link -> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[r] = `dir ${st.ino} ${st.mtimeMs}`; walk(p, r); }
      else out[r] = `file ${st.ino} ${st.size} ${st.mtimeMs} ${fs.readFileSync(p, 'utf8')}`;
    }
  };
  out['.'] = `dir ${fs.lstatSync(dir).ino} ${fs.lstatSync(dir).mtimeMs}`;
  walk(dir, '');
  return out;
}

// ---------- Codex ----------
// The same made-up Mac with a Codex folder in it, for the tests of a second Codex login (src/codex-account-home.mjs,
// src/codex-account-folders.mjs). Nothing here names the real home folder or a real Codex folder either.

// What Codex keeps per login or per Mac, and what its app keeps beside that. None of it may ever be linked into an
// account folder. The login file's contents here are made up: no real login has this shape or these words.
export const CODEX_PRIVATE = [
  'auth.json', 'auth.lock', 'auth.json.lock', 'secrets/keys.json', 'session_index.jsonl', 'session_index.jsonl.lock', 'history.jsonl', 'installation_id',
  'models_cache.json', 'cache/x.json', 'log/codex-tui.log', 'tmp/t', '.tmp/t', 'shell_snapshots/s.sh', 'rollout-migrations/m.json', 'plugins/installed.json',
  'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm', 'thread_history_1.sqlite', 'goals_1.sqlite', 'memories_1.sqlite', 'memories_v2_1.sqlite',
  'queue_1.sqlite', 'logs_2.sqlite', 'sqlite/codex.db', '.codex-global-state.json', '.sandbox_migration', '.DS_Store', 'version.json',
  'agents/reviewer.toml', 'hooks.json', 'keybindings.json', 'ipc/sock', 'automations/a.json', 'config.toml.before-something',
];
// The user's own chats, setup and memories, as someone who has used Codex for a while has them.
export const CODEX_SHARED = Object.freeze({
  'sessions/2026/11/16/rollout-2026-11-16T10-00-00-0f000000-0000-7000-8000-000000000001.jsonl': '{"type":"session_meta"}\n',
  'archived_sessions/rollout-2026-10-01T09-00-00-0f000000-0000-7000-8000-000000000002.jsonl': '{"type":"session_meta"}\n',
  'thread-writer-locks/.coordination.lock': '',
  'config.toml': 'approval_policy = "on-request"\n', 'AGENTS.md': 'be brief',
  'mcp-oauth-locks/0a86.lock': '', 'skills/tidy/SKILL.md': '---\nname: tidy\n---', 'rules/default.rules': 'allow git status',
  'memories/MEMORY.md': 'likes tabs', 'memories.lock': '',
});

/**
 * Make the home under `w`: `<w>/home/.codex` with the user's chats and setup and Codex's private entries.
 * `fill`: what of the user's own is there (default: everything in CODEX_SHARED). `bare`: none of Codex's private
 * entries either (a Codex that has never run).
 * @returns {{ w: string, home: string, base: string, root: string, outside: string }}
 */
export function fakeCodexMac(w, { fill = CODEX_SHARED, bare = false } = {}) {
  const home = path.join(w, 'home');
  const base = path.join(home, '.codex');
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, text] of Object.entries(fill)) put(path.join(base, rel), text);
  if (!bare) for (const rel of CODEX_PRIVATE) put(path.join(base, rel), `private:${rel}`);
  const outside = path.join(w, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  return { w, home, base, root: path.join(w, 'canopy', 'accounts'), outside };
}

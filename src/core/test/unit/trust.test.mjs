// trust.mjs: which folders may load their own project settings, hooks and MCP servers.
// Everything runs in throwaway folders with an isolated CLAUDE_CONFIG_DIR, so the
// user's real ~/.claude.json is never read for a verdict and never written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { core } from '../helpers.mjs';

const T = await core('trust.mjs');
const missing = T.__missing ? `trust.mjs: ${T.__missing}` : (typeof T.folderTrustSync === 'function' ? false : 'trust.mjs does not export folderTrustSync');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-trust-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
function sandbox() {
  const base = path.join(root, `case-${++seq}`);
  const config = path.join(base, 'config');
  const cwd = path.join(base, 'work', 'project');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { base, config, cwd, env: { CLAUDE_CONFIG_DIR: config, HOME: os.homedir() } };
}
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const verdict = (cwd, env, opts) => { T.clearTrustCache?.(); return T.folderTrustSync(cwd, env, opts); };

test('an empty folder is untrusted but has nothing risky', { skip: missing }, () => {
  const { cwd, env } = sandbox();
  const t = verdict(cwd, env);
  assert.equal(t.trusted, false);
  assert.equal(t.reason ?? null, null);
  assert.equal(t.risky.any, false);
  assert.deepEqual(t.risky.hookEvents, []);
});

test('a .claude directory or a .mcp.json makes a folder risky', { skip: missing }, () => {
  const a = sandbox();
  fs.mkdirSync(path.join(a.cwd, '.claude'));
  const ra = verdict(a.cwd, a.env).risky;
  assert.deepEqual([ra.any, ra.claudeDir, ra.mcpJson], [true, true, false]);

  const b = sandbox();
  write(path.join(b.cwd, '.mcp.json'), { mcpServers: { evil: { command: 'sh', args: ['-c', 'true'] } } });
  const rb = verdict(b.cwd, b.env).risky;
  assert.deepEqual([rb.any, rb.claudeDir, rb.mcpJson], [true, false, true]);
});

test('a .claude directory holding only worktrees is not risky; anything else beside them still is', { skip: missing }, () => {
  const a = sandbox();
  fs.mkdirSync(path.join(a.cwd, '.claude', 'worktrees', 'feature-x'), { recursive: true });
  const ra = verdict(a.cwd, a.env).risky;
  assert.deepEqual([ra.any, ra.claudeDir], [false, false]);

  const b = sandbox();
  fs.mkdirSync(path.join(b.cwd, '.claude', 'worktrees'), { recursive: true });
  write(path.join(b.cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: [] } });
  const rb = verdict(b.cwd, b.env).risky;
  assert.deepEqual([rb.any, rb.claudeDir, rb.projectSettings], [true, true, true]);
});

test('project settings are described: which files, which hook events', { skip: missing }, () => {
  const { cwd, env } = sandbox();
  write(path.join(cwd, '.claude', 'settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch /tmp/x' }] }], PreToolUse: [{ hooks: [] }] } });
  write(path.join(cwd, '.claude', 'settings.local.json'), { apiKeyHelper: 'echo key' });
  const r = verdict(cwd, env).risky;
  assert.deepEqual([r.any, r.projectSettings, r.localSettings], [true, true, true]);
  assert.ok(r.hookEvents.includes('SessionStart'));
});

test('CLAUDE.md alone is reported but is not a reason to restrict', { skip: missing }, () => {
  const { cwd, env } = sandbox();
  write(path.join(cwd, 'CLAUDE.md'), '# notes');
  const r = verdict(cwd, env).risky;
  assert.equal(r.claudeMd, true);
  assert.equal(r.any, false);
});

test('config in a parent folder counts, up to the repository root and no further', { skip: missing }, () => {
  const a = sandbox();
  fs.mkdirSync(path.join(a.base, 'work', '.claude'));
  assert.equal(verdict(a.cwd, a.env).risky.any, true, 'a parent .claude is loaded for a plain subfolder');

  const b = sandbox();
  fs.mkdirSync(path.join(b.base, 'work', '.claude'));
  fs.mkdirSync(path.join(b.cwd, '.git'));
  assert.equal(verdict(b.cwd, b.env).risky.any, false, 'the walk stops at the folder that holds .git');

  const c = sandbox();
  fs.mkdirSync(path.join(c.cwd, '.git'));
  fs.mkdirSync(path.join(c.cwd, '.claude'));
  const sub = path.join(c.cwd, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(verdict(sub, c.env).risky.any, true, 'the repository root itself is included');
});

test('folders the host recorded are trusted, in any spelling, including their subfolders', { skip: missing }, () => {
  const { cwd, env, base } = sandbox();
  fs.mkdirSync(path.join(cwd, '.claude'));
  assert.equal(verdict(cwd, env).trusted, false);
  const exact = verdict(cwd, env, { accepted: [cwd] });
  assert.deepEqual([exact.trusted, exact.reason], [true, 'host']);
  assert.equal(exact.risky.any, true, 'the risk description is still reported for a trusted folder');
  assert.equal(verdict(cwd, env, { accepted: [fs.realpathSync(cwd)] }).trusted, true, 'realpath spelling');
  assert.equal(verdict(fs.realpathSync(cwd), env, { accepted: [cwd] }).trusted, true, 'the reverse spelling');
  assert.equal(verdict(cwd, env, { accepted: [path.join(base, 'work')] }).trusted, true, 'an accepted ancestor');
  assert.equal(verdict(cwd, env, { accepted: [path.join(base, 'elsewhere')] }).trusted, false);
  assert.equal(verdict(path.join(base, 'work'), env, { accepted: [cwd] }).trusted, false, 'trusting a child does not trust its parent');
});

test("Claude Code's own trust record is honoured, read from the session's config dir", { skip: missing }, () => {
  const { cwd, env, config } = sandbox();
  const file = path.join(config, '.claude.json');
  write(file, { projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true }, '/somewhere/else': { hasTrustDialogAccepted: true } } });
  const yes = verdict(cwd, env);
  assert.deepEqual([yes.trusted, yes.reason], [true, 'claude']);

  write(file, { projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: false } } });
  assert.equal(verdict(cwd, env).trusted, false);
  write(file, { projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: 'true' } } });
  assert.equal(verdict(cwd, env).trusted, false, 'only a real boolean true counts');
});

test('a broken or missing config file means untrusted, never an exception', { skip: missing }, () => {
  const { cwd, env, config } = sandbox();
  assert.equal(verdict(cwd, env).trusted, false);
  write(path.join(config, '.claude.json'), '{ "projects": { "/x": ');
  assert.doesNotThrow(() => verdict(cwd, env));
  assert.equal(verdict(cwd, env).trusted, false);
  write(path.join(config, '.claude.json'), '[]');
  assert.equal(verdict(cwd, env).trusted, false);
});

test('the home folder is trusted and never reported as risky', { skip: missing }, () => {
  const { env } = sandbox();
  const t = verdict(os.homedir(), env);
  assert.deepEqual([t.trusted, t.reason], [true, 'home']);
  assert.equal(t.risky.any, false, "~/.claude is the user's own configuration");
});

test('junk input is untrusted and never throws', { skip: missing }, () => {
  const { env } = sandbox();
  for (const cwd of [undefined, null, '', 'relative/path', 42, {}, '/definitely/not/here', 'x'.repeat(5000)]) {
    let t;
    assert.doesNotThrow(() => { t = verdict(cwd, env); });
    assert.equal(t.trusted, false, String(cwd).slice(0, 30));
    assert.equal(typeof t.risky.any, 'boolean');
  }
  assert.doesNotThrow(() => verdict('/tmp', undefined, undefined));
  assert.doesNotThrow(() => verdict('/tmp', {}, { accepted: [null, 7, 'rel', ''] }));
});

test('trust is read-only: the config file is byte-identical afterwards', { skip: missing }, () => {
  const { cwd, env, config } = sandbox();
  const file = path.join(config, '.claude.json');
  write(file, { projects: { '/x': { hasTrustDialogAccepted: true } }, other: 1 });
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  verdict(cwd, env);
  verdict(cwd, env, { accepted: [cwd] });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(config), ['.claude.json']);
});

test('projectRisk and the async twin agree with the sync verdict', { skip: missing }, async () => {
  const { cwd, env } = sandbox();
  write(path.join(cwd, '.mcp.json'), { mcpServers: {} });
  const sync = verdict(cwd, env, { accepted: [cwd] });
  if (typeof T.projectRisk === 'function') assert.deepEqual(T.projectRisk(cwd, env).mcpJson, true);
  if (typeof T.folderTrust === 'function') {
    const twin = await T.folderTrust(cwd, env, { accepted: [cwd] });
    assert.deepEqual([twin.trusted, twin.reason, twin.risky.any], [sync.trusted, sync.reason, sync.risky.any]);
  }
});

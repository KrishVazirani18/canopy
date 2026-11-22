// Settings > Tools (src/customize.mjs): what `claude mcp list` prints, read into rows; a skill's frontmatter; how what
// a person typed becomes the arguments of `claude mcp add`; and what the window may not pass (a value the CLI would
// read as an option, a file that is no skill). No real claude is run: `claude` is a shell script that writes down
// each argument it was given.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { _test, registerCustomize } from '../../../customize.mjs';
import { script } from '../account-world.mjs';

const { parseMcpList, frontmatter } = _test;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-customize-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- what `claude mcp list` prints ----

test('each line of `claude mcp list` is a connector: its name, where it lives, how it is reached and how it stands', () => {
  const rows = parseMcpList([
    'Checking MCP server health...',
    '',
    'notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected',
    'linear: https://mcp.linear.app/sse (SSE) - ! Needs authentication',
    'files: npx -y @modelcontextprotocol/server-filesystem /tmp - ✘ Failed to connect',
    'plugin:example-plugin:search: node server.js (stdio) - ✔ Connected',
  ].join('\n'));
  assert.deepEqual(rows, [
    { name: 'notion', label: 'notion', plugin: null, target: 'https://mcp.notion.com/mcp', transport: 'http', status: 'connected', detail: 'Connected' },
    { name: 'linear', label: 'linear', plugin: null, target: 'https://mcp.linear.app/sse', transport: 'sse', status: 'needs-auth', detail: 'Needs authentication' },
    { name: 'files', label: 'files', plugin: null, target: 'npx -y @modelcontextprotocol/server-filesystem /tmp', transport: 'stdio', status: 'failed', detail: 'Failed to connect' },
    { name: 'plugin:example-plugin:search', label: 'search', plugin: 'example-plugin', target: 'node server.js', transport: 'stdio', status: 'connected', detail: 'Connected' },
  ]);
});

test('colour codes are dropped, and each way a connector can stand is told apart', () => {
  const status = (state) => parseMcpList(`\x1b[1mone\x1b[0m: https://example.com/mcp (HTTP) - ${state}`)[0];
  assert.deepEqual([status('\x1b[32m✔ Connected\x1b[0m').name, status('\x1b[32m✔ Connected\x1b[0m').status], ['one', 'connected']);
  for (const [state, is] of [
    ['✔ Connected', 'connected'], ['! Needs authentication', 'needs-auth'], ['Disabled', 'disabled'],
    ['Pending approval', 'pending'], ['Unapproved', 'pending'], ['✘ Failed to connect', 'failed'], ['something new', 'failed'],
  ]) assert.equal(status(state).status, is, state);
  assert.deepEqual(parseMcpList('No MCP servers configured.\n'), []);
});

// ---- a skill's frontmatter ----

test('frontmatter: plain values, quoted ones, and a description folded over several lines', () => {
  const { meta, body } = frontmatter([
    '---', 'name: tidy-up', 'description: >-', '  Clears the build folder', '  and says what went.', 'license: "MIT"', '---', '', '# Tidy up', 'Steps.',
  ].join('\n'));
  assert.deepEqual(meta, { name: 'tidy-up', description: 'Clears the build folder and says what went.', license: 'MIT' });
  assert.equal(body, '# Tidy up\nSteps.');
  assert.deepEqual(frontmatter('# No frontmatter\nJust text.'), { meta: {}, body: '# No frontmatter\nJust text.' });
});

// ---- what reaches `claude` ----

function world() {
  const w = fs.mkdtempSync(path.join(tmp, 'w-'));
  const log = path.join(w, 'ran');
  // One argument per line, then a line of its own to end the call.
  const bin = script(path.join(w, 'claude'), `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done; echo '<end>' >> '${log}'`);
  const channels = new Map();
  registerCustomize((channel, fn) => channels.set(channel, fn), () => ({ claudePath: bin, env: { PATH: '/usr/bin:/bin' }, cwd: w }));
  const ran = () => { try { return fs.readFileSync(log, 'utf8').split('<end>\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean)); } catch { return []; } };
  return { call: (channel, ...args) => channels.get(channel)(...args), ran, dir: w };
}

test('adding a connector: a URL is reached over HTTP with its headers, a command is split as a shell would and run with its variables', { timeout: 60000 }, async () => {
  const w = world();
  assert.deepEqual(await w.call('customize:mcp:add', { name: 'linear', target: ' https://mcp.linear.app/mcp ', scope: 'project', headers: ['Authorization: Bearer x', '  ', 7], env: ['IGNORED=1'] }), { ok: true });
  assert.deepEqual(await w.call('customize:mcp:add', { name: 'files', target: 'npx -y "@scope/server files" \'/tmp/my folder\' --flag', env: [' ROOT=/tmp '] }), { ok: true });
  assert.deepEqual(await w.call('customize:mcp:add', { name: 'old', target: 'https://example.com/sse', transport: 'sse' }), { ok: true });
  assert.deepEqual(w.ran(), [
    ['mcp', 'add', '--transport', 'http', '--scope', 'project', '--header', 'Authorization: Bearer x', '--env', 'IGNORED=1', 'linear', 'https://mcp.linear.app/mcp'],
    ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', '--env', 'ROOT=/tmp', 'files', '--', 'npx', '-y', '@scope/server files', '/tmp/my folder', '--flag'],
    ['mcp', 'add', '--transport', 'sse', '--scope', 'user', 'old', 'https://example.com/sse'],
  ]);
});

test('nothing the window passes can become an option of `claude`, and a refusal comes back as words, never thrown', { timeout: 60000 }, async () => {
  const w = world();
  const refused = async (channel, ...args) => { const r = await w.call(channel, ...args); assert.equal(r.ok, false, `${channel} ${JSON.stringify(args)}`); assert.equal(typeof r.error, 'string'); };
  await refused('customize:mcp:add', { name: '-scope', target: 'https://example.com' });
  await refused('customize:mcp:add', { name: 'bad name!', target: 'https://example.com' });
  await refused('customize:mcp:add', { name: 'x', target: '' });
  await refused('customize:mcp:add', { name: 'x', target: 'https://example.com', scope: '--force' });
  await refused('customize:mcp:add', { name: 'x', target: 'https://example.com', transport: '--help' });
  await refused('customize:mcp:add', { name: 'x', target: '--help', transport: 'http' });
  await refused('customize:mcp:add', { name: 'x', target: 'ftp://example.com/mcp', transport: 'sse' });
  await refused('customize:mcp:add', null);
  for (const bad of ['--help', '', null, undefined, 7, {}, 'x'.repeat(201)]) {
    await refused('customize:mcp:remove', bad);
    await refused('customize:mcp:get', bad);
    await refused('customize:plugins:details', bad);
    await refused('customize:plugins:action', 'install', bad);
  }
  await refused('customize:mcp:remove', 'notion', '--force');
  await refused('customize:plugins:action', 'install', 'tool@market', '--force');
  await refused('customize:plugins:action', 'launch', 'tool@market');
  await refused('customize:marketplaces:add', '--help');
  assert.deepEqual(w.ran(), [], 'claude was never run');
  // Names as Claude Code prints them still go through: one with spaces, and a plugin's.
  assert.equal((await w.call('customize:mcp:remove', 'claude.ai Notion', 'user')).ok, true);
  assert.equal((await w.call('customize:mcp:get', 'plugin:example-plugin:search')).ok, true);
  assert.deepEqual(w.ran(), [['mcp', 'remove', 'claude.ai Notion', '--scope', 'user'], ['mcp', 'get', 'plugin:example-plugin:search']]);
});

// ---- reading a skill ----

test('only a file named SKILL.md under the home folder is read as a skill', async (t) => {
  const w = world();
  const home = path.join(w.dir, 'home', 'sam');
  const skill = path.join(home, '.claude', 'skills', 'tidy', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: tidy\n---\nSteps.');
  // A folder beside the home folder whose name merely begins the same way, and a file whose name merely ends the same way.
  const sibling = path.join(w.dir, 'home', 'sam2', 'SKILL.md');
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, 'not yours');
  fs.writeFileSync(path.join(home, 'notSKILL.md'), 'not a skill');
  t.mock.method(os, 'homedir', () => home);
  assert.deepEqual(await w.call('customize:skills:read', skill), { ok: true, meta: { name: 'tidy' }, body: 'Steps.' });
  for (const no of [sibling, path.join(home, 'notSKILL.md'), path.join(home, '.claude', 'settings.json'), '/etc/passwd', path.join(home, '..', 'sam2', 'SKILL.md')]) {
    assert.deepEqual(await w.call('customize:skills:read', no), { ok: false, error: 'Not a skill file.' }, no);
  }
  assert.deepEqual(await w.call('customize:skills:read', path.join(home, 'gone', 'SKILL.md')), { ok: false, error: 'Couldn’t read that skill.' });
});

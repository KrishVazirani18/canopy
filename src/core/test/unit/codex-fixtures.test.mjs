// The recorded fixtures say nothing about the Mac they were recorded on. Before a file is written the recorders give
// neutral names to the MCP servers and plugins it lists, replace every id with a made-up one, and level the versions
// in Codex's user agent (neutralFixture and neutralIds in ../helpers.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, KNOWN_SERVERS, neutralFixture, neutralIds, neutralServerNames, serverNames } from '../helpers.mjs';

const started = (name, status = 'starting', error = null) => JSON.stringify({ t: 1, dir: 'in', msg: { method: 'mcpServer/startupStatus/updated', params: { threadId: 't', name, status, error, failureReason: null } } });

test('a server is renamed everywhere it appears; only Canopy\'s own and Computer Use keep their names', () => {
  const body = [
    JSON.stringify({ dir: 'note', flags: ['-c', 'mcp_servers.team-wiki.enabled=false', '-c', 'mcp_servers.canopy.enabled=false'] }),
    started('qa'),
    started('cua_repl'),
    started('qa', 'failed', 'The qa MCP server is not logged in. Run `codex mcp login qa`.'),
    started('canopy_ui', 'ready'),
  ].join('\n');
  const out = neutralServerNames(body);
  assert.equal(out.split('\n').length, 5, 'no line is added or dropped');
  assert.doesNotMatch(out, /team-wiki|"qa"|login qa/);
  assert.match(out, /mcp_servers\.server_1\.enabled=false/);
  assert.match(out, /The server_2 MCP server is not logged in\. Run `codex mcp login server_2`\./);
  for (const kept of ['mcp_servers.canopy.enabled=false', '"name":"cua_repl"', '"name":"canopy_ui"']) assert.ok(out.includes(kept), kept);
  assert.equal(neutralServerNames(out), out, 'a second pass changes nothing');
  // A file that already has neutral names and gains a server: the new one takes the next number.
  assert.match(neutralServerNames([out, started('wiki')].join('\n')), /"name":"server_3"/);
});

test('a short server name is replaced as a whole word only', () => {
  const body = [started('qa'), JSON.stringify({ t: 2, dir: 'in', msg: { text: 'the qa notes sit beside aqa.txt and qa-old' } })].join('\n');
  assert.ok(neutralServerNames(body).endsWith('"text":"the server_1 notes sit beside aqa.txt and qa-old"}}'));
});

test('an id becomes a made-up one of the same shape, the same one wherever it appears', () => {
  const chat = '01a2b3c4-d5e6-7f80-9a1b-2c3d4e5f6071';
  const body = JSON.stringify({
    threadId: chat, path: `/Users/test/.codex/sessions/2026/11/15/rollout-2026-11-15T22-59-19-${chat}.jsonl`,
    itemId: 'msg_0123456789abcdef0123456789abcdef0123456789abcdef01', command: 'exec-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    reply: 'msg_01AbCdEfGhIjKlMnOpQrStUv', request: 'req_01AbCdEfGhIjKlMnOpQrStUv', tool: 'toolu_01AbCdEfGhIjKlMnOpQrStUv', call: 'call_AbCdEfGhIjKlMnOpQrStUvWx',
    installationId: '00000000-0000-0000-0000-000000000000', capabilities: ['msg_lifecycle_v1'], model: 'gpt-6-luna',
  });
  const out = JSON.parse(neutralIds(body));
  assert.match(out.threadId, /^00000000-0000-7000-8000-[0-9a-f]{12}$/);
  assert.ok(out.path.endsWith(`rollout-2026-11-15T22-59-19-${out.threadId}.jsonl`), 'the chat\'s file is named after the same made-up id');
  assert.match(out.itemId, /^msg_0{38}[0-9a-f]{12}$/);
  assert.match(out.command, /^exec-00000000-0000-4000-8000-[0-9a-f]{12}$/);
  for (const [key, kind] of [['reply', 'msg'], ['request', 'req'], ['tool', 'toolu'], ['call', 'call']]) assert.match(out[key], new RegExp(`^${kind}_0{12}[0-9a-f]{12}$`), key);
  assert.deepEqual([out.installationId, out.capabilities, out.model], ['00000000-0000-0000-0000-000000000000', ['msg_lifecycle_v1'], 'gpt-6-luna'], 'what is not a recorded id is left alone');
  assert.equal(neutralIds(neutralIds(body)), neutralIds(body), 'a second pass changes nothing');
  assert.equal(JSON.parse(neutralIds(JSON.stringify({ again: chat }))).again, out.threadId, 'another file gets the same made-up id for the same chat');
});

test('Codex\'s user agent and the plugins it lists say nothing of the recorder\'s Mac', () => {
  const body = [
    JSON.stringify({ t: 1, dir: 'in', msg: { id: 1, result: { userAgent: 'canopy/0.153.4 (Mac OS 27.1.2; arm64) SomeTerminal/9.9 (canopy; 0.0.1)', codexHome: '/Users/test/.codex' } } }),
    JSON.stringify({ t: 2, dir: 'in', msg: { method: 'hook/started', params: { run: { sourcePath: '/Users/test/.codex/plugins/cache/some-market/some-plugin/3.2.1/hooks/hooks.json' } } } }),
  ].join('\n');
  const out = neutralFixture(body);
  assert.ok(out.includes('"userAgent":"canopy/0.153.4 (Mac OS 26.0.0; arm64) unknown (canopy; 0.0.1)"'), 'Codex\'s own version and the client\'s stay');
  assert.ok(out.includes('/Users/test/.codex/plugins/cache/example-marketplace/example-plugin/1.0.0/hooks/hooks.json'));
  assert.equal(neutralFixture(out), out, 'a second pass changes nothing');
});

test('the committed fixtures are exactly what the recorders would write', () => {
  const codex = fs.readdirSync(FIXTURES).filter((f) => /^codex-.*\.jsonl$/.test(f));
  const claude = fs.readdirSync(FIXTURES).filter((f) => /^live-.*\.json$/.test(f));
  assert.ok(codex.length >= 15 && claude.length >= 6);
  for (const file of codex) {
    const body = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    assert.ok(neutralFixture(body) === body, `${file} holds a server, plugin, id or version the recorder should have replaced`);
    assert.deepEqual(serverNames(body).filter((n) => !KNOWN_SERVERS.has(n) && !/^server_\d+$/.test(n)), [], file);
  }
  for (const file of claude) {
    const body = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    assert.ok(neutralIds(body) === body, `${file} holds an id the recorder should have replaced`);
  }
  // The start-up noise is the point of this one: eleven servers, each said twice.
  assert.equal(serverNames(fs.readFileSync(path.join(FIXTURES, 'codex-startup.jsonl'), 'utf8')).length, 11);
});

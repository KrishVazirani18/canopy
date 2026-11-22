// accounts-ipc.mjs: the registry as main.mjs wires it, and the two calls the window gets.
// `handle` and `send` are stand-ins for main's. Claude Code is a shell script in a throwaway folder that answers
// like `claude auth status --json`; Codex is a function that answers from memory. No real tool is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { registerAccounts } from '../../../accounts-ipc.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-accounts-ipc-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

const ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: os.homedir(), MY_TOOL_TOKEN: 'shell-secret-value' });
const CONSOLE = { loggedIn: true, method: 'api_key', provider: 'firstParty', apiKeySource: '/login managed key', email: 'me@example.com', org: 'Acme', orgId: 'o1', configDir: '/Users/someone/.claude' };

function wire({ codex = true, state = {} } = {}) {
  const folder = path.join(root, `w${++seq}`);
  fs.mkdirSync(folder, { recursive: true });
  const runs = path.join(folder, 'runs');
  const bin = path.join(folder, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\necho run >> '${runs}'\necho '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"/login managed key","email":"me@example.com","orgId":"o1","orgName":"Acme","configDirectory":"/Users/someone/.claude"}'\n`);
  fs.chmodSync(bin, 0o755);
  const channels = new Map(), sent = [], logs = [];
  const tool = { path: bin, env: ENV };
  const accounts = registerAccounts((channel, fn) => channels.set(channel, fn), {
    claude: () => tool,
    ...(codex && { codex: { installed: () => true, env: () => ENV, account: async () => ({ ok: true, signedIn: true, requiresAuth: true, account: { type: 'chatgpt', email: 'me@example.com', plan: 'plus' } }) } }),
    load: () => state.accounts ?? null, save: (s) => { state.accounts = s; },
    send: (channel, payload) => sent.push([channel, payload]), log: (m) => logs.push(m),
  });
  const asked = () => { try { return fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  return { accounts, channels, sent, logs, state, tool, asked };
}

test('the window gets two calls, both read-only, and hears about changes', { timeout: 60000 }, async () => {
  const { accounts, channels, sent, logs, state, asked } = wire();
  assert.deepEqual([...channels.keys()].sort(), ['accounts:list', 'accounts:refresh'], 'nothing that chooses, adds, removes or signs in');
  assert.deepEqual(await channels.get('accounts:list')(), { active: { claude: null, codex: null }, inUse: { claude: null, codex: null }, own: { claude: null, codex: null }, checking: false, list: [] });

  // What the environment check already knows is folded in without asking Claude Code a second time.
  await accounts.refresh({ auth: { claude: CONSOLE } });
  assert.equal(asked(), 0);
  const view = await channels.get('accounts:list')();
  assert.deepEqual(view.list.map((a) => [a.engine, a.id, a.kind, a.label, a.state, a.found]).sort(),
    [['claude', 'claude-default', 'console', 'Console', 'ok', true], ['codex', 'codex-default', 'plan', 'ChatGPT Plus', 'ok', true]]);
  assert.deepEqual(view.inUse, { claude: 'claude-default', codex: 'codex-default' });
  assert.ok(sent.length > 0 && sent.every(([channel]) => channel === 'accounts:changed'));
  assert.deepEqual(sent.at(-1)[1], view);
  assert.equal(state.accounts.v, 1);
  const everything = JSON.stringify([view, sent, state]) + logs.join('\n');
  assert.ok(!everything.includes('shell-secret-value'), 'what is in the launch environment stays there');
  assert.ok(!logs.join('\n').includes('me@example.com'), 'the log names accounts by id, never by email');
});

test('opening the page asks again, but not twice in a row; a forced check always asks', { timeout: 60000 }, async () => {
  const { accounts, channels, asked } = wire();
  await accounts.refresh({ auth: { claude: CONSOLE } });
  const again = await channels.get('accounts:refresh')();
  assert.equal(asked(), 0, 'checked a moment ago');
  assert.equal(again.list.length, 2, 'the reply is the list');
  await channels.get('accounts:refresh')(true);
  assert.equal(asked(), 1);
  await channels.get('accounts:refresh')('true');
  assert.equal(asked(), 1, 'only a real `true` forces');
});

test('without Codex wired there is no OpenAI engine, and Claude launches exactly as its environment stands', () => {
  const { accounts, tool } = wire({ codex: false });
  assert.deepEqual(accounts.envFor('claude'), ENV);
  assert.equal(JSON.stringify(accounts.envFor('claude', { account: accounts.pin('claude') })), JSON.stringify(ENV));
  assert.throws(() => accounts.envFor('codex'), (err) => err.code === 'unknown-engine');
  tool.env = null; // the environment check has not finished: nothing is launched on a guess
  assert.throws(() => accounts.envFor('claude'), (err) => err.code === 'no-env');
});

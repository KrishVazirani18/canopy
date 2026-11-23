import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHROME_INSTRUCTIONS, CHROME_SETUP_HELP, chromeRequest, chromeResponse } from '../../background-chrome.mjs';

const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('background rules override explicit foreground requests and preserve page routing', () => {
  const selection = call('select_page', { pageId: 4, bringToFront: true });
  assert.deepEqual(chromeRequest(selection).params.arguments, { pageId: 4, bringToFront: false });
  assert.equal(selection.params.arguments.bringToFront, true);
  assert.deepEqual(chromeRequest(call('new_page', { url: 'https://example.com', background: false })).params.arguments,
    { url: 'https://example.com', background: true });
  assert.deepEqual(chromeRequest(call('new_page', { url: 'about:blank' })).params.arguments,
    { url: 'about:blank', background: true });
  const click = call('click', { pageId: 12, uid: '2_1' });
  assert.equal(chromeRequest(click), click);
});

test('setup guidance is added to missing connection errors and leaves other outcomes alone', () => {
  const missing = { result: { isError: true, content: [{ type: 'text', text: 'Could not connect to Chrome.' }] } };
  assert.equal(chromeResponse(missing).result.content.at(-1).text, CHROME_SETUP_HELP);
  const error = { result: { isError: true, content: [{ type: 'text', text: 'No page with id 1.' }] } };
  assert.equal(chromeResponse(error), error);
  const picture = { result: { content: [{ type: 'image', data: 'test', mimeType: 'image/png' }] } };
  assert.equal(chromeResponse(picture), picture);
});

// Mock only the lookup for the running Chrome debugging endpoint. Never connect to the
// machine's own profile from a test, even if its owner already enabled remote debugging.
const missingPort = `
  import fs from 'node:fs/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const readFile = fs.readFile;
  fs.readFile = (path, ...args) => String(path).endsWith('/DevToolsActivePort')
    ? Promise.reject(Object.assign(new Error('test browser is not running'), { code: 'ENOENT' })) : readFile(path, ...args);
  syncBuiltinESMExports();
`;

test('pinned MCP starts without Chrome and provides its normal tools and a setup error on demand', { timeout: 20_000 }, async (t) => {
  const entry = fileURLToPath(new URL('../../background-chrome-server.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(missingPort)}`, entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let log = '';
  child.stderr.on('data', (part) => { log += part; });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  async function request(id, method, params) {
    send({ id, method, params });
    for (;;) {
      const line = await lines.next();
      assert.equal(line.done, false, log);
      const message = JSON.parse(line.value);
      if (message.id === id) {
        assert.equal(message.error, undefined, JSON.stringify(message.error));
        return message.result;
      }
    }
  }

  const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(initialized.instructions, CHROME_INSTRUCTIONS);
  assert.equal(initialized.serverInfo.version, '1.13.0');
  send({ method: 'notifications/initialized' });
  const { tools } = await request(2, 'tools/list');
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ['list_pages', 'select_page', 'new_page', 'navigate_page', 'take_snapshot', 'take_screenshot', 'fill', 'click']) assert.ok(byName.has(name), name);
  assert.match(byName.get('list_pages').description, /mentions an open tab/);
  assert.equal(byName.get('new_page').inputSchema.properties.background, undefined);
  assert.equal(byName.get('select_page').inputSchema.properties.bringToFront, undefined);
  assert.ok(byName.get('click').inputSchema.required.includes('pageId'));

  const unavailable = await request(3, 'tools/call', { name: 'list_pages', arguments: {} });
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.content.at(-1).text, CHROME_SETUP_HELP);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});

test('first use waits for setup, shares approval across chats, and asks again after disconnect', async () => {
  const { chromeAccess } = await import('../../background-chrome-access.mjs');
  const { CHROME_CONNECT_PROMPT, CHROME_ALLOW_PROMPT } = await import('../../background-chrome.mjs');
  let ready = false;
  let connects = 0;
  const browser = { connected: true };
  const gate = chromeAccess({ ready: async () => ready, connect: async () => { connects++; return browser; }, intervalMs: 2 });
  const signal = new AbortController().signal;
  const asked = [];
  const one = gate(async (text) => { asked.push(text); return 'accept'; }, signal);
  const two = gate(async () => assert.fail('another chat asked for the same connection'), signal);
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.deepEqual(asked, [CHROME_CONNECT_PROMPT]);
  assert.equal(connects, 0);
  ready = true;
  await Promise.all([one, two]);
  assert.equal(connects, 1);
  await gate(() => assert.fail('asked while connected'), signal);
  browser.connected = false;
  await assert.rejects(gate(async (text) => { asked.push(text); return 'decline'; }, signal), /connection skipped/);
  assert.deepEqual(asked, [CHROME_CONNECT_PROMPT, CHROME_ALLOW_PROMPT]);
  assert.equal(connects, 1);
});

test('stopping setup prevents a late browser connection', async () => {
  const { chromeAccess } = await import('../../background-chrome-access.mjs');
  const gate = chromeAccess({ ready: async () => false, connect: () => assert.fail('connected after Stop'), intervalMs: 2 });
  const stop = new AbortController();
  const waiting = gate(async () => 'accept', stop.signal);
  stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('Chrome uses its own in-chat card while other servers use their usual confirmation', async () => {
  const { describe } = await import('../../elicitation.mjs');
  const { CHROME_CONNECT_PROMPT, CHROME_ALLOW_PROMPT } = await import('../../background-chrome.mjs');
  assert.equal(describe({ serverName: 'canopy_chrome', message: CHROME_CONNECT_PROMPT }).ask, 'chrome-setup');
  assert.equal(describe({ serverName: 'canopy_chrome', message: CHROME_ALLOW_PROMPT }).ask, 'chrome-allow');
  assert.equal(describe({ serverName: 'other', message: CHROME_CONNECT_PROMPT }).ask, 'confirm');
});

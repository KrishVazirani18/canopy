// This process runs the pinned server directly, with no user CLI config or update check.
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromeRequest, chromeResponse } from './background-chrome.mjs';
import { chromeAccess } from './background-chrome-access.mjs';

const require = createRequire(import.meta.url);
const packageRoot = new URL('./out/Default/gen/src/', pathToFileURL(require.resolve('chrome-devtools-mcp/package.json')));
const moduleAt = (name) => import(new URL(name, packageRoot));
await moduleAt('utils/polyfill.js');
const [{ BrowserManager }, { McpServer }, { ServerConfig }, { StdioServerTransport }] = await Promise.all([
  moduleAt('BrowserManager.js'), moduleAt('index.js'), moduleAt('config/ServerConfig.js'), moduleAt('third_party/index.js'),
]);

const config = ServerConfig.create({
  cliArgs: { autoConnect: true, usageStatistics: false, performanceCrux: false, pageIdRouting: true },
  env: {},
});
const browser = new BrowserManager(config, {});
const portFile = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort');
const allowBrowser = chromeAccess({
  ready: async () => {
    try { return /^\d+\r?\n\/devtools\/browser\//.test(await readFile(portFile, 'ascii')); } catch { return false; }
  },
  connect: () => browser.ensureBrowser(),
});

// Each client gets independent MCP state and page selection. Closing a chat does not disconnect Chrome.
const sharedManager = {
  ensureBrowser: () => browser.ensureBrowser(),
  abandonPendingAttempt: () => {},
  close: async () => {},
};

class BackgroundChromeTransport extends StdioServerTransport {
  start() {
    const receive = this.onmessage;
    this.onmessage = (message) => receive?.(chromeRequest(message));
    return super.start();
  }

  send(message) { return super.send(chromeResponse(message)); }
}

async function serve(input, output, interactive) {
  const server = await McpServer.from(config, { browserManager: sharedManager });
  if (interactive) {
    const rpc = server.server.server;
    // Preserve the pinned package's schema validation, result format and cancellation semantics.
    const handler = rpc._requestHandlers.get('tools/call');
    rpc._requestHandlers.set('tools/call', async (request, ctx) => {
      try {
        const signal = ctx.mcpReq.signal;
        await allowBrowser(async (message) => {
          const answer = await rpc.request({ method: 'elicitation/create', params: {
            mode: 'form', message, requestedSchema: { type: 'object', properties: {} },
          } }, { timeout: 120_000, signal, relatedRequestId: ctx.mcpReq.id });
          return answer.action;
        }, signal);
        signal.throwIfAborted();
      } catch (error) {
        return rpc.projectCallToolResult({ isError: true, content: [{ type: 'text', text: error.message }] }, undefined);
      }
      return handler(request, ctx);
    });
  }
  const transport = new BackgroundChromeTransport(input, output);
  input.once('close', () => { void server.close(); });
  await server.connect(transport);
}

const socketPath = process.argv[2];
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 3000).unref();
  await browser.close();
  process.exit(0);
}
process.stdin.once('end', shutdown);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, shutdown);

if (socketPath) {
  const token = Buffer.from(process.env.CANOPY_CHROME_TOKEN || '');
  if (token.length !== 48) throw new Error('Canopy Chrome socket requires its private token.');
  const listener = net.createServer((socket) => {
    socket.on('error', () => {});
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.once('close', () => clearTimeout(deadline));
    const authenticate = () => {
      const provided = socket.read(token.length);
      if (!provided) return;
      clearTimeout(deadline);
      socket.off('readable', authenticate);
      if (!timingSafeEqual(token, provided)) { socket.destroy(); return; }
      void serve(socket, socket, true).then(() => socket.resume(), () => socket.destroy());
    };
    socket.on('readable', authenticate);
  });
  listener.listen(socketPath);
  process.stdin.resume();
} else {
  await serve(process.stdin, process.stdout, false);
}

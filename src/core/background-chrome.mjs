// The same bundled stdio connector for the Claude SDK and Codex app-server.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const CHROME_SERVER = 'canopy_chrome';
export const CHROME_SETUP_URL = 'chrome://inspect/#remote-debugging';
export const CHROME_CONNECT_PROMPT = 'Connect Chrome to use your open tabs.';
export const CHROME_ALLOW_PROMPT = 'Ask Chrome to allow access to your open tabs.';
export const CHROME_INSTRUCTIONS = 'When the user asks you to work in Chrome or mentions an open tab, use list_pages to find it by title or URL. Work in the requested tabs in the background and preserve the user’s active tab and window. Ask only if the choice of tab matters and is unclear.';

export const CHROME_SETUP_HELP = 'Open Google Chrome 144 or later. Turn on “Allow remote debugging for this browser instance” at chrome://inspect/#remote-debugging and click Allow when Chrome asks.';

const require = createRequire(import.meta.url);

export function backgroundChromeServer() {
  if (process.platform !== 'darwin') return null;
  try { require.resolve('chrome-devtools-mcp/package.json'); } catch { return null; }
  return {
    type: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./background-chrome-server.mjs', import.meta.url))],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeout: 300_000,
  };
}

export function backgroundChromeConfig(server) {
  if (!server) return {};
  const { command, args, env } = server;
  return { [`mcp_servers.${CHROME_SERVER}`]: { command, args: [...args], env: { ...env }, startup_timeout_sec: 30, tool_timeout_sec: 300 } };
}

// Keep these choices at the transport boundary so every caller gets the same behavior.
export function chromeRequest(message) {
  if (message?.method !== 'tools/call') return message;
  const { params } = message;
  const defaults = params?.name === 'select_page' ? { bringToFront: false }
    : params?.name === 'new_page' ? { background: true } : null;
  return defaults ? { ...message, params: { ...params, arguments: { ...params.arguments, ...defaults } } } : message;
}

export function chromeResponse(message) {
  const result = message?.result;
  if (result?.serverInfo && result.protocolVersion) {
    return { ...message, result: { ...result, instructions: CHROME_INSTRUCTIONS } };
  }
  if (Array.isArray(result?.tools)) {
    const tools = result.tools.map((tool) => {
      if (tool.name === 'list_pages') return { ...tool, description: `${tool.description} ${CHROME_INSTRUCTIONS}` };
      if (tool.name === 'take_screenshot') return { ...tool, description: `${tool.description} Call this tool directly to receive the image.` };
      const parameter = tool.name === 'select_page' ? 'bringToFront' : tool.name === 'new_page' ? 'background' : null;
      if (!parameter || !tool.inputSchema?.properties) return tool;
      const properties = { ...tool.inputSchema.properties };
      delete properties[parameter];
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    });
    return { ...message, result: { ...result, tools } };
  }
  if (result?.isError && result.content?.some?.((item) => item.type === 'text' && !item.text.includes(CHROME_SETUP_HELP) && /could not connect to chrome|devtoolsactiveport|remote debugging|timed out (?:while )?(?:connecting|get(?:ting)? browser)/i.test(item.text))) {
    return { ...message, result: { ...result, content: [...result.content, { type: 'text', text: CHROME_SETUP_HELP }] } };
  }
  return message;
}

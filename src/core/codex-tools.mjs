// Canopy's tools in a Codex chat.
//
// A Codex chat has the tools a Claude chat has (canopy-tools.mjs), from one MCP server named `canopy` that Codex
// starts for the thread: the relay's helper (tool-relay.mjs). This file is the Codex end of it.
//
//   codexToolConfig(server)   that server as the `config` of thread/start and thread/resume
//   createCodexTools(opts)    one per chat: a token for each of its processes, and the decision about every call
//
// How a thread gets the server. In the `config` of thread/start and thread/resume, under the one dotted key
// `mcp_servers.canopy`, never as a nested `mcp_servers` table: checked against Codex 0.169.0, a nested table there
// replaces what the process was started with (`-c mcp_servers.<name>.enabled=false`, say), and a dotted key is laid
// over it. Nothing under ~/.codex is written, and the token is never on a command line: it rides in the server's
// `env`, which Codex is given over its own input.
//
// Who is asked. Left to itself Codex asks the user before every call of an MCP tool it was told nothing about
// (checked live, 0.169.0: "Allow the … MCP server to run tool …?"), and it has an error of its own for such a tool
// in a chat that never asks. Canopy's tools are told apart call by call instead (a look at localhost is not a look
// at the web), so Codex is told to let them through (`default_tools_approval_mode`; checked live under both
// `on-request` and `never`) and the asking is done here, by the rule a Claude chat's tools are asked by (each
// definition's `asks`, tool-registry.mjs):
//   - a call that needs no yes runs, marked `unasked` (a look then sees this app's own windows and no other);
//   - a chat that runs without asking (Full Access) runs it;
//   - what the user already allowed for this chat runs (the definition's `scope`: one site, one file, one app);
//   - anything else is put to the user on the chat's own approval card (`ask`), and a no is told to the model.
//
// A chat's tools are part of the start of every request it makes, so they are decided once, when its first process
// starts, by what the host can do (a screen, for look) and never by a setting that can change while the chat lives.
import { CANOPY_TOOLS, toolsFor } from './canopy-tools.mjs';
import { CANOPY_SERVER } from './tool-registry.mjs';

/** Codex's own word for "run this server's tools without asking": Canopy asks about them itself. */
export const APPROVE = 'approve';
// How long Codex waits for the helper to come up, and for one call. A call can wait on the user's yes, and Codex
// counts that wait as the tool's own time, so the limit is a day: Stop ends a call that is waiting, a timeout never should.
export const STARTUP_SEC = 30;
export const TOOL_SEC = 24 * 60 * 60;

const errText = (err) => String(err?.message ?? err);
const refused = (tool) => ({
  content: [{ type: 'text', text: `The user said no to this ${tool.name} call, so it did not run. Do not try it again unless they ask: carry on without it, or ask them how they would like to go on.` }],
  isError: true,
});

/**
 * The relay's server (tool-relay.mjs `link.server`) as the `config` of Codex's thread/start and thread/resume.
 * @param {{ command: string, args: string[], env: Record<string, string> }} server
 */
export function codexToolConfig(server) {
  return {
    [`mcp_servers.${CANOPY_SERVER}`]: {
      command: server.command, args: [...server.args], env: { ...server.env },
      default_tools_approval_mode: APPROVE, startup_timeout_sec: STARTUP_SEC, tool_timeout_sec: TOOL_SEC,
    },
  };
}

/**
 * One chat's side of the relay.
 * @param {{
 *   relay: { connect: Function },                      the app's ToolRelay
 *   chat: () => object,                                the chat as a tool sees it: { cwd, sessionId, look, chats, widgetReport } (tool-registry.mjs `ctx`)
 *   ask: (tool: object, args: object, meta: object) => Promise<'allow' | 'always' | 'deny'>,   put one call to the user
 *   free?: () => boolean,                              the chat runs without asking (Full Access)
 *   tools?: object[],                                  the definitions to choose from (canopy-tools.mjs)
 *   log?: (level: string, msg: string, data?: object) => void,
 * }} opts
 */
export function createCodexTools({ relay, chat, ask, free = () => false, tools = CANOPY_TOOLS, log } = {}) {
  const grants = new Set(); // what the user allowed for this chat: "<tool>:<scope>"
  let fixed = null;         // this chat's tools, decided at its first start
  const ctx = () => ({ ...chat(), engine: 'codex' });

  async function call(tool, args, meta) {
    // The call's id is the id of the row the window draws it in (Codex's item id): a widget's report comes back by it.
    const about = { ...ctx(), signal: meta.signal, callId: meta.callId ?? null };
    let unasked = true;
    if (tool.asks && await tool.asks(args, about)) {
      unasked = false;
      const scope = `${tool.name}:${tool.scope ? tool.scope(args) : ''}`;
      if (!free() && !grants.has(scope)) {
        const answer = await ask(tool, args, meta);
        if (answer === 'always') grants.add(scope);
        else if (answer !== 'allow') return refused(tool);
      }
    }
    if (meta.signal?.aborted) return refused(tool); // stopped while it waited: nobody is listening for the answer
    return tool.run(args, { ...about, unasked });
  }

  return {
    /**
     * A process of this chat is about to open its thread. Resolves to { config, close }: what to open the thread
     * with, and what to call when that process is let go. Null when the chat has no tools or the relay is down:
     * the chat then starts as it would without them. Never throws.
     */
    async link() {
      try {
        fixed ??= toolsFor(ctx(), tools);
        if (!fixed.length) return null;
        const link = await relay.connect({ tools: fixed, call });
        return link ? { config: codexToolConfig(link.server), close: link.close } : null;
      } catch (err) {
        try { log?.('warn', 'Canopy\'s tools could not be set up for this chat', { error: errText(err) }); } catch { /* logging never breaks a start */ }
        return null;
      }
    },
    /** The names of this chat's tools, once it has started. */
    names: () => (fixed ?? []).map((t) => t.name),
    grants,
  };
}

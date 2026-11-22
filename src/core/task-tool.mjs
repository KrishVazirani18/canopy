// task: Claude says what a long piece of work is and where it stands, and the window shows it as one small card
// ("Creating Website · Writing the page · 1m 40s") instead of a minute of silence.
//
//  - TASK               the tool, defined once for every engine (tool-registry.mjs): task { title?, status?, done? }
//  - createTaskServer() the in-process MCP server that carries it in a Claude chat. Always in front of Claude: its
//                       description is what tells Claude the card exists and when to use it. A Codex chat gets the
//                       same tool through the relay (tool-relay.mjs).
//
// The tool keeps nothing. Every call is a row in the transcript, and the window draws the card from the turn's
// calls (the latest title and status), so a saved chat shows the same card it showed live.
import { defineTool, sdkTool } from './tool-registry.mjs';

const soft = async (f) => { try { return await import(f); } catch (err) { return { __missing: String(err?.message ?? err) }; } };
const [sdk, zod] = await Promise.all([soft('@anthropic-ai/claude-agent-sdk'), soft('zod')]);

/** What this build lacks to offer the tool, or null. */
export const TASK_MISSING = !sdk.createSdkMcpServer || !sdk.tool ? 'sdk' : !zod.z ? 'zod' : null;
export const TASK_SERVER = 'canopy_task';
export const TASK_TOOL = `mcp__${TASK_SERVER}__task`;

export const TASK_DESCRIPTION = 'Show the user what you are working on, as one small card at the top of your reply in Canopy. ' +
  'Without it the user sees nothing but a spinner for minutes while you think and work. ' +
  'When a request is real work that will take more than a minute (building a page or a deck, a multi-file change, a research pass), make this your first tool call, before loading skills or reading files: ' +
  'a short title and the first stage. Call it again with a new status each time you move to a new stage, ' +
  'and with done: true when the work is finished. Skip it for quick answers and small edits, and for a turn that only gathers options or asks the user to choose: the task starts once the real work does.\n\n' +
  'title: what the work is, 1 to 4 words in Title Case, e.g. "Creating Website", "Fixing Login Bug". Given once; later calls can leave it out.\n' +
  'status: the stage you are on now, a few plain words, e.g. "Gathering references", "Writing the page", "Checking on mobile".';

const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** One call. Nothing is kept: the window reads the call itself. */
export function runTask(args) {
  const a = args ?? {};
  if (!clip(a.title, 60) && !clip(a.status, 120) && a.done !== true) {
    return { content: [{ type: 'text', text: 'Nothing to show: give a title, a status or done: true.' }], isError: true };
  }
  return { content: [{ type: 'text', text: a.done === true ? 'The card shows it as done.' : 'Shown.' }] };
}

/** The tool as every engine gets it. Read-only: it changes nothing, so it runs in Plan mode too and never asks. */
export const TASK = defineTool({
  name: 'task',
  home: TASK_SERVER,
  description: TASK_DESCRIPTION,
  params: {
    title: { type: 'string', description: 'What the work is, 1 to 4 words in Title Case ("Creating Website"). Once, at the start.' },
    status: { type: 'string', description: 'The stage you are on now, a few plain words ("Writing the page").' },
    done: { type: 'boolean', description: 'true when the work is finished.' },
  },
  alwaysLoad: true,
  annotations: { title: 'Task', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  run: (args) => runTask(args),
});

/** The in-process MCP server that carries the tool in a Claude chat. */
export function createTaskServer() {
  return sdk.createSdkMcpServer({ name: TASK_SERVER, version: '1.0.0', tools: [sdkTool(TASK, sdk, zod.z, (args) => TASK.run(args))] });
}

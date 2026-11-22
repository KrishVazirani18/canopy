// Canopy's own tools, each defined once for every engine.
//
// A tool is written down in one place (its name, what the model is told about it, its arguments, how it runs), in
// the file that implements it (look.mjs, read-chat.mjs, memory-tools.mjs). From that one definition it is handed to each engine in the
// form the engine takes, so a Claude chat and a Codex chat can never be given two different tools by the same name:
//   - Claude Code gets it on an in-process server of the Agent SDK      sdkTool()
//   - Codex, and any agent that speaks MCP, gets it from one MCP server named `canopy`: a small helper process that
//     relays every call back to the app (tool-relay.mjs)                mcpTool()
// canopy-tools.mjs lists the tools there are. Nothing in this file imports anything: the Codex adapter reads names
// from it, and it must load in a build where a tool's own file does not.
//
//   defineTool(def)             a definition, checked and frozen
//   zodShape(def, z)            its arguments as the zod shape the Agent SDK's tool() takes
//   inputSchema(def)            the same arguments as JSON Schema, for an MCP tools/list
//   sdkTool(def, sdk, z, run)   the tool as the Agent SDK's tool()
//   mcpTool(def)                the tool as one row of an MCP tools/list
//   claudeName(def), relayedName(def), shownName(server, tool)    what it is called where
//
// A definition:
//   name          what the model calls it
//   home          the in-process server it lives on in a Claude chat. The window knows the tool by that name
//                 (mcp__<home>__<name>) whichever engine called it; a tool with no home is known as mcp__canopy__<name>
//   description   what the model is told. Benchmarked wording: change it only with a new measurement
//   brief         a shorter description for an engine that cannot keep a tool behind tool search, where every word
//                 is paid for in every request. Left out, `description` is what every engine gets
//   params        { [name]: { type: 'string' | 'number' | 'integer' | 'boolean' | 'array', description, positive?, required?,
//                               enum?: string[] (a string that is one of these),
//                               items?: { type: 'string', enum?: string[] } (an array's items: text, or one of these) } }
//   annotations   MCP tool annotations (title, readOnlyHint, destructiveHint, openWorldHint)
//   alwaysLoad    Claude Code only: never behind tool search
//   available(ctx)     whether a chat can have the tool at all (look needs a screen). Left out: always
//   asks(args, ctx)    whether this call needs the user's yes before it runs. Left out: never
//   scope(args)        what "allow for this chat" then covers, as a string. Left out: the whole tool
//   run(args, ctx)     the call itself. Resolves to an MCP tool result ({ content, isError? }) and never throws
//
// `ctx` is the calling chat, the same for every engine:
//   cwd, sessionId, engine      which chat is calling ('claude' | 'codex')
//   callId                      this call's id as the window knows its row (Claude's tool_use id, Codex's item id), or null
//   signal                      aborts when the call is stopped
//   widgetReport                (callId) => Promise<{ errors } | null>: what the window said about drawing a widget, or null
//   look                        the host's screenshot backend (look.mjs), or null
//   shots                       where the chat's screenshots are kept (shots.mjs forChat), or null
//   chats                       where the user's other chats are read from (read-chat.mjs chatSources), or null
//   memory                      Canopy Memory's notes (memory-store.mjs), or null where the host keeps none
//   said()                      the user's own messages in this chat, as far as the host saw them (memory-tools.mjs
//                               checks a note filed as "the user said" against them); left out where it cannot say
//   unasked                     the call went ahead without the user being asked about it

/** The one MCP server an engine other than Claude Code finds Canopy's tools on. */
export const CANOPY_SERVER = 'canopy';

// Where each tool lives in a Claude chat. Kept here, as plain names, so the Codex adapter can name a relayed tool
// the way the window knows it without loading the tool itself. defineTool() refuses a definition that disagrees.
const HOMES = Object.freeze({ look: 'canopy_look', read_chat: 'canopy_chats', show_widget: 'visualize', read_me: 'visualize', remember: 'canopy_memory', recall: 'canopy_memory', forget: 'canopy_memory', task: 'canopy_task' });

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array']);
const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const PARAM_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/**
 * A tool's definition, checked and frozen. Throws on one that is not well formed: a definition is written by hand,
 * once, and a mistake in it should stop the build that made it, not a chat.
 */
export function defineTool(def) {
  const bad = (why) => { throw new TypeError(`tool ${JSON.stringify(def?.name ?? null)}: ${why}`); };
  if (!isPlain(def)) bad('a definition is an object');
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) bad('its name is lowercase letters, digits and _');
  if (typeof def.description !== 'string' || !def.description.trim()) bad('it needs a description');
  if (def.brief !== undefined && (typeof def.brief !== 'string' || !def.brief.trim())) bad('a brief description is text');
  if (typeof def.run !== 'function') bad('it needs run(args, ctx)');
  for (const k of ['available', 'asks', 'scope']) if (def[k] !== undefined && typeof def[k] !== 'function') bad(`${k} is a function`);
  const home = def.home ?? null;
  if ((HOMES[def.name] ?? null) !== home) bad(`its home in a Claude chat is ${JSON.stringify(HOMES[def.name] ?? null)} in tool-registry.mjs, not ${JSON.stringify(home)}`);
  const params = {};
  for (const [key, p] of Object.entries(isPlain(def.params) ? def.params : {})) {
    if (!PARAM_RE.test(key) || !isPlain(p)) bad(`argument ${key} is not well formed`);
    if (!TYPES.has(p.type)) bad(`argument ${key} has no type this file knows`);
    if (typeof p.description !== 'string' || !p.description.trim()) bad(`argument ${key} needs a description`);
    const words = (list) => Array.isArray(list) && list.length && list.every((v) => typeof v === 'string' && v);
    const choices = p.enum === undefined ? null : words(p.enum) && p.type === 'string' ? Object.freeze([...p.enum]) : bad(`argument ${key} lists choices that are not words`);
    // An array holds text, or one of a list of words: all a tool here has needed.
    let items = null;
    if (p.type === 'array') {
      if (!isPlain(p.items) || p.items.type !== 'string') bad(`argument ${key} is an array of text, and says so in items`);
      if (p.positive) bad(`argument ${key} is an array, which cannot be positive`);
      if (p.items.enum !== undefined && !words(p.items.enum)) bad(`argument ${key} lists choices that are not words`);
      items = Object.freeze({ type: 'string', ...(p.items.enum && { enum: Object.freeze([...p.items.enum]) }) });
    } else if (p.items !== undefined) bad(`argument ${key} has items but is not an array`);
    params[key] = Object.freeze({ type: p.type, description: p.description, ...(choices && { enum: choices }), ...(items && { items }), ...(p.positive === true && { positive: true }), ...(p.required === true && { required: true }) });
  }
  return Object.freeze({
    ...def, home, params: Object.freeze(params),
    annotations: Object.freeze({ ...(isPlain(def.annotations) ? def.annotations : {}) }),
    alwaysLoad: def.alwaysLoad === true,
  });
}

// ---- what a tool is called ----

/** The tool's name in a Claude chat, which is also the name the window draws it under. */
export const claudeName = (def) => `mcp__${def.home ?? CANOPY_SERVER}__${def.name}`;
/** Its name where it arrives through the relay (a Codex chat): what that model calls it. */
export const relayedName = (def) => `mcp__${CANOPY_SERVER}__${def.name}`;

/**
 * The name the window knows a relayed tool by: one of Canopy's own is drawn the way a Claude chat's is (a look with
 * its screenshot, a read of another chat as that), so it goes by the Claude chat's name. Null for any other tool.
 */
export function shownName(server, tool) {
  return server === CANOPY_SERVER && typeof tool === 'string' && Object.hasOwn(HOMES, tool) ? `mcp__${HOMES[tool]}__${tool}` : null;
}

// ---- its arguments, in each engine's form ----

function zodOf(p, z) {
  const text = (o) => (o.enum ? z.enum([...o.enum]) : z.string());
  let s = p.type === 'array' ? z.array(text(p.items)) : p.enum ? z.enum([...p.enum]) : p.type === 'string' ? z.string() : p.type === 'boolean' ? z.boolean() : p.type === 'integer' ? z.number().int() : z.number();
  if (p.positive) s = s.positive();
  if (!p.required) s = s.optional();
  return s.describe(p.description);
}

/** The arguments as the zod shape the Agent SDK's tool() takes. `z` is zod's own (the SDK's copy). */
export function zodShape(def, z) {
  return Object.fromEntries(Object.entries(def.params).map(([key, p]) => [key, zodOf(p, z)]));
}

/** The same arguments as JSON Schema: what an MCP client is told the tool takes. */
export function inputSchema(def) {
  const properties = {};
  const required = [];
  for (const [key, p] of Object.entries(def.params)) {
    properties[key] = { type: p.type, ...(p.enum && { enum: [...p.enum] }), ...(p.items && { items: { type: p.items.type, ...(p.items.enum && { enum: [...p.items.enum] }) } }), ...(p.positive && { exclusiveMinimum: 0 }), description: p.description };
    if (p.required) required.push(key);
  }
  return { type: 'object', properties, ...(required.length && { required }), additionalProperties: false };
}

// ---- the tool, in each engine's form ----

/**
 * The tool as the Agent SDK's tool(), for an in-process server. `run(args, extra)` is called for every call and
 * what it returns is the tool's result.
 */
export function sdkTool(def, sdk, z, run) {
  return sdk.tool(def.name, def.description, zodShape(def, z), async (args, extra) => run(args, extra),
    { ...(def.alwaysLoad && { alwaysLoad: true }), annotations: { ...def.annotations } });
}

/** The tool as one row of an MCP tools/list: what the relay's helper tells the agent it has. */
export function mcpTool(def) {
  const { title, ...hints } = def.annotations;
  return {
    name: def.name, ...(typeof title === 'string' && title && { title }),
    description: def.brief ?? def.description, inputSchema: inputSchema(def),
    annotations: { ...(typeof title === 'string' && title && { title }), ...hints },
  };
}

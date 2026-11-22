// Canopy's tools as one definition for every engine (tool-registry.mjs, canopy-tools.mjs): what a definition must
// be, that a Claude chat and a Codex chat are handed the same tool from it, and what the tool is called where.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const [T, C, L, R, M, K] = await Promise.all(['tool-registry.mjs', 'canopy-tools.mjs', 'look.mjs', 'read-chat.mjs', 'memory-tools.mjs', 'task-tool.mjs'].map((f) => core(f)));
const missing = [T, C, L, R, M, K].find((m) => m.__missing)?.__missing ?? false;
const noSdk = missing || (L.LOOK_MISSING || R.READ_CHAT_MISSING || M.MEMORY_MISSING ? 'the Agent SDK cannot load in this build' : false);

const ok = { content: [{ type: 'text', text: 'ok' }] };
const def = (over = {}) => ({ name: 'probe', description: 'A probe.', run: async () => ok, ...over });

test('a definition is checked when it is written, and cannot be changed afterwards', { skip: missing }, () => {
  const t = T.defineTool(def({ params: { text: { type: 'string', description: 'What to say.' }, times: { type: 'integer', positive: true, required: true, description: 'How often.' } }, annotations: { title: 'Probe', readOnlyHint: true } }));
  assert.deepEqual([t.name, t.home, t.alwaysLoad], ['probe', null, false]);
  assert.deepEqual(t.params.times, { type: 'integer', description: 'How often.', positive: true, required: true });
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.params) && Object.isFrozen(t.params.text) && Object.isFrozen(t.annotations));
  for (const [why, bad] of [
    ['no name', def({ name: '' })], ['a name with a dash', def({ name: 'my-tool' })], ['a name in capitals', def({ name: 'Probe' })],
    ['no description', def({ description: ' ' })], ['an empty brief', def({ brief: '' })], ['nothing to run', def({ run: null })],
    ['a type nobody knows', def({ params: { a: { type: 'object', description: 'x' } } })],
    ['an argument with no description', def({ params: { a: { type: 'string' } } })],
    ['choices for a number', def({ params: { a: { type: 'number', description: 'x', enum: ['1'] } } })],
    ['no choices at all', def({ params: { a: { type: 'string', description: 'x', enum: [] } } })],
    ['asks that is not a function', def({ asks: true })],
    ['a home the registry does not know', def({ home: 'canopy_probe' })],
    ['a known tool moved to another home', def({ name: 'look', home: 'canopy' })],
  ]) assert.throws(() => T.defineTool(bad), TypeError, why);
  assert.throws(() => T.defineTool(null), TypeError);
});

test('the arguments are one list, written out as zod for Claude Code and as JSON Schema for MCP', { skip: missing }, () => {
  const t = T.defineTool(def({ params: {
    text: { type: 'string', description: 'What to say.' },
    wide: { type: 'boolean', description: 'Wide or not.' },
    size: { type: 'number', description: 'How big.' },
    times: { type: 'integer', positive: true, required: true, description: 'How often.' },
    how: { type: 'string', enum: ['fast', 'slow'], description: 'Which way.' },
  } }));
  assert.deepEqual(T.inputSchema(t), {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to say.' },
      wide: { type: 'boolean', description: 'Wide or not.' },
      size: { type: 'number', description: 'How big.' },
      times: { type: 'integer', exclusiveMinimum: 0, description: 'How often.' },
      how: { type: 'string', enum: ['fast', 'slow'], description: 'Which way.' },
    },
    required: ['times'], additionalProperties: false,
  });
  assert.deepEqual(T.inputSchema(T.defineTool(def())), { type: 'object', properties: {}, additionalProperties: false }, 'a tool with no arguments');
  // A stand-in for zod that writes down what was asked of it, in order.
  const z = new Proxy({}, { get: (_t, kind) => () => { const calls = [kind]; const s = new Proxy({}, { get: (_s, m) => (m === 'calls' ? calls : (...a) => { calls.push(a.length ? `${m}:${a[0]}` : m); return s; }) }); return s; } });
  const shape = T.zodShape(t, z);
  assert.deepEqual(Object.keys(shape), ['text', 'wide', 'size', 'times', 'how'], 'in the order they were written');
  assert.deepEqual(shape.how.calls, ['enum', 'optional', 'describe:Which way.']);
  assert.deepEqual(shape.text.calls, ['string', 'optional', 'describe:What to say.']);
  assert.deepEqual(shape.wide.calls, ['boolean', 'optional', 'describe:Wide or not.']);
  assert.deepEqual(shape.size.calls, ['number', 'optional', 'describe:How big.']);
  assert.deepEqual(shape.times.calls, ['number', 'int', 'positive', 'describe:How often.'], 'a required argument is not optional');
});

test('an argument can be a list of words, written out the same way for both engines', { skip: missing }, async () => {
  const t = T.defineTool(def({ params: {
    kinds: { type: 'array', items: { type: 'string', enum: ['table', 'chart'] }, required: true, description: 'Which ones.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Any words.' },
  } }));
  assert.deepEqual(t.params.kinds, { type: 'array', description: 'Which ones.', items: { type: 'string', enum: ['table', 'chart'] }, required: true });
  assert.ok(Object.isFrozen(t.params.kinds.items) && Object.isFrozen(t.params.kinds.items.enum));
  assert.deepEqual(T.inputSchema(t), {
    type: 'object',
    properties: {
      kinds: { type: 'array', items: { type: 'string', enum: ['table', 'chart'] }, description: 'Which ones.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Any words.' },
    },
    required: ['kinds'], additionalProperties: false,
  });
  // Real zod: the shape Claude Code is handed says exactly what the JSON Schema says.
  const z = (await import('zod')).z;
  const fromZod = z.toJSONSchema(z.object(T.zodShape(t, z)));
  assert.deepEqual(fromZod.properties, T.inputSchema(t).properties);
  assert.deepEqual(fromZod.required, ['kinds']);
  for (const [why, bad] of [
    ['an array that does not say what it holds', def({ params: { a: { type: 'array', description: 'x' } } })],
    ['an array of numbers', def({ params: { a: { type: 'array', items: { type: 'number' }, description: 'x' } } })],
    ['an array of no choices', def({ params: { a: { type: 'array', items: { type: 'string', enum: [] }, description: 'x' } } })],
    ['a positive array', def({ params: { a: { type: 'array', items: { type: 'string' }, positive: true, description: 'x' } } })],
    ['items on text', def({ params: { a: { type: 'string', items: { type: 'string' }, description: 'x' } } })],
    ['choices on the array itself', def({ params: { a: { type: 'array', items: { type: 'string' }, enum: ['x'], description: 'x' } } })],
  ]) assert.throws(() => T.defineTool(bad), TypeError, why);
});

test('an MCP client is told the short description where there is one, and the same hints', { skip: missing }, () => {
  const long = T.defineTool(def({ annotations: { title: 'Probe', readOnlyHint: true, openWorldHint: false } }));
  assert.deepEqual(T.mcpTool(long), {
    name: 'probe', title: 'Probe', description: 'A probe.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Probe', readOnlyHint: true, openWorldHint: false },
  });
  const brief = T.defineTool(def({ brief: 'Probe.' }));
  assert.equal(T.mcpTool(brief).description, 'Probe.');
  assert.ok(!('title' in T.mcpTool(brief)));
});

test('the Agent SDK is handed the name, the full description, the zod shape and the hints', { skip: missing }, async () => {
  const seen = [];
  const sdk = { tool: (...a) => { seen.push(a); return { made: true }; } };
  const z = { string: () => ({ optional: () => ({ describe: (d) => `string? ${d}` }) }) };
  const t = T.defineTool(def({ brief: 'Short.', alwaysLoad: true, params: { text: { type: 'string', description: 'What.' } }, annotations: { title: 'Probe' } }));
  assert.deepEqual(T.sdkTool(t, sdk, z, async (args, extra) => ({ args, extra })), { made: true });
  const [name, description, shape, handler, extras] = seen[0];
  assert.deepEqual([name, description, shape, extras], ['probe', 'A probe.', { text: 'string? What.' }, { alwaysLoad: true, annotations: { title: 'Probe' } }]);
  assert.deepEqual(await handler({ a: 1 }, { b: 2 }), { args: { a: 1 }, extra: { b: 2 } });
  T.sdkTool(T.defineTool(def()), sdk, z, async () => ok);
  assert.deepEqual(seen[1][4], { annotations: {} }, 'a tool behind tool search says nothing about loading');
});

// ---- the tools there are ----

test('the list: look, read_chat, the widgets, then memory\'s three, then task, each defined once in its own file', { skip: missing }, () => {
  assert.deepEqual(C.CANOPY_TOOLS.map((t) => t.name), ['look', 'read_chat', 'show_widget', 'read_me', 'remember', 'recall', 'forget', 'task']);
  assert.equal(C.CANOPY_TOOLS[0], L.LOOK);
  assert.equal(C.CANOPY_TOOLS[1], R.READ_CHAT);
  assert.deepEqual(C.CANOPY_TOOLS.slice(4), [M.REMEMBER, M.RECALL, M.FORGET, K.TASK]);
  // A chat has only the tools that can work for it: no screen, no look; a host that keeps no memory, none of memory's.
  assert.deepEqual(C.toolsFor({}).map((t) => t.name), ['read_chat', 'show_widget', 'read_me', 'task']);
  assert.deepEqual(C.toolsFor({ look: {}, memory: {} }).map((t) => t.name), ['look', 'read_chat', 'show_widget', 'read_me', 'remember', 'recall', 'forget', 'task']);
  assert.ok(Object.isFrozen(C.CANOPY_TOOLS));
  assert.equal(new Set(C.CANOPY_TOOLS.map((t) => t.name)).size, C.CANOPY_TOOLS.length, 'no two tools share a name');
});

test('a tool goes by its Claude name in the window, whichever engine called it', { skip: missing }, () => {
  assert.equal(T.CANOPY_SERVER, 'canopy');
  assert.equal(T.claudeName(L.LOOK), L.LOOK_TOOL);
  assert.equal(T.claudeName(R.READ_CHAT), R.READ_CHAT_TOOL);
  assert.deepEqual([T.claudeName(M.REMEMBER), T.claudeName(M.RECALL), T.claudeName(M.FORGET)], [M.REMEMBER_TOOL, M.RECALL_TOOL, M.FORGET_TOOL]);
  assert.deepEqual(C.CANOPY_TOOLS.map(T.relayedName), ['mcp__canopy__look', 'mcp__canopy__read_chat', 'mcp__canopy__show_widget', 'mcp__canopy__read_me', 'mcp__canopy__remember', 'mcp__canopy__recall', 'mcp__canopy__forget', 'mcp__canopy__task'], 'what a Codex model calls them');
  for (const t of C.CANOPY_TOOLS) assert.equal(T.shownName(T.CANOPY_SERVER, t.name), T.claudeName(t), `${t.name} is drawn as a Claude chat's is`);
  assert.equal(T.shownName('canopy', 'something_new'), null, 'a tool with no home keeps the name it was called by');
  assert.equal(T.shownName('github', 'look'), null, 'another server\'s tool of the same name is not Canopy\'s');
  assert.equal(T.shownName('canopy', 'constructor'), null);
  const home = T.defineTool(def());
  assert.equal(T.claudeName(home), 'mcp__canopy__probe');
});

// ---- one tool, two engines ----

test('every tool reaches Claude Code and an MCP client as the same tool', { skip: noSdk }, async () => {
  const z = (await import('zod')).z;
  const memory = M.createMemoryServer({ chat: () => ({}) });
  const servers = { look: L.createLookServer({}), read_chat: R.createReadChatServer({ read: async () => ok }), remember: memory, recall: memory, forget: memory };
  for (const t of [L.LOOK, R.READ_CHAT, M.REMEMBER, M.RECALL, M.FORGET]) {
    const claude = servers[t.name].instance._registeredTools[t.name];
    const mcp = T.mcpTool(t);
    assert.ok(claude, `${t.name} is on its Claude server`);
    assert.equal(claude.description, t.description);
    assert.deepEqual(claude.annotations, { ...t.annotations });
    assert.deepEqual(mcp.annotations, { ...t.annotations });
    assert.equal(claude._meta?.['anthropic/alwaysLoad'] === true, t.alwaysLoad);
    // The same arguments, of the same types, described in the same words.
    const theirs = z.toJSONSchema(claude.inputSchema).properties;
    const ours = mcp.inputSchema.properties;
    assert.deepEqual(Object.keys(ours), Object.keys(theirs));
    for (const [key, p] of Object.entries(ours)) assert.deepEqual([p.type, p.description, p.exclusiveMinimum ?? null], [theirs[key].type, theirs[key].description, theirs[key].exclusiveMinimum ?? null], `${t.name}.${key}`);
    assert.deepEqual(mcp.inputSchema.required ?? [], z.toJSONSchema(claude.inputSchema).required ?? []);
  }
  assert.equal(T.mcpTool(L.LOOK).description, L.LOOK_DESCRIPTION, 'look is told in full: it is in front of every model anyway');
  assert.equal(T.mcpTool(R.READ_CHAT).description, R.READ_CHAT_BRIEF, 'read_chat is told in brief where nothing can keep it behind tool search');
  assert.ok(R.READ_CHAT_BRIEF.length < R.READ_CHAT_DESCRIPTION.length / 2);
  assert.equal(T.mcpTool(M.REMEMBER).description, M.REMEMBER_BRIEF, 'remember\'s rules in fewer words, where every word is in every request');
  assert.ok(M.REMEMBER_BRIEF.length < M.REMEMBER_DESCRIPTION.length);
});

test('the same call runs the same handler for both engines', { skip: missing }, async () => {
  // look: the chat's backend, and whether the call went unasked, are handed on as they are for a Claude chat.
  const shots = [];
  const image = { getSize: () => ({ width: 4, height: 4 }), isEmpty: () => false, resize: () => image, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpg') };
  const backend = { appName: 'Canopy', screenAccess: () => 'granted', ownWindows: () => [{ app: 'Canopy', title: 'Canopy', own: true, capture: () => image }], otherWindows: () => { shots.push('others'); return [{ app: 'Notes', title: 'Notes', capture: () => image }]; } };
  const own = await L.LOOK.run({ window: 'Notes' }, { look: backend, unasked: true });
  assert.equal(own.isError, true, 'a call nobody said yes to sees this app\'s own windows only');
  assert.deepEqual(shots, []);
  const asked = await L.LOOK.run({ window: 'Notes' }, { look: backend, unasked: false });
  assert.deepEqual([asked.content[0].type, asked.content[0].mimeType, shots], ['image', 'image/png', ['others']]);
  assert.match((await L.LOOK.run({ url: 'http://localhost:1/' }, { look: null })).content[0].text, /only works inside the Canopy app/);
  // read_chat: the calling chat is the one left out, and only its project is read.
  const listed = [];
  const sources = { list: async (cwd) => { listed.push(cwd); return [{ id: 'me', engine: 'codex', title: 'This one', cwd, updated: 2 }, { id: 'other-chat', engine: 'claude', title: 'The other one', cwd, updated: 1 }]; }, load: async () => ({ msgs: [{ role: 'user', text: 'hello' }], files: [], lastAt: 1, open: false }) };
  const out = await R.READ_CHAT.run({}, { cwd: '/work', sessionId: 'me', chats: sources });
  assert.deepEqual(listed, ['/work']);
  assert.match(out.content[0].text, /The other one/);
  assert.doesNotMatch(out.content[0].text, /This one/);
});

test('which calls ask, and what a yes for the chat then covers', { skip: missing }, async () => {
  const ctx = { look: { ownWindows: () => [{ app: 'Canopy', title: 'Canopy', own: true }] } };
  const asks = (args, c = ctx) => L.LOOK.asks(args, c);
  assert.equal(await asks({ url: 'http://localhost:3000/' }), false);
  assert.equal(await asks({ url: '127.0.0.1:5173' }), false);
  assert.equal(await asks({ window: 'Canopy' }), false);
  assert.equal(await asks({ url: 'https://example.com/' }), true);
  assert.equal(await asks({ url: '/etc/hosts' }), true);
  assert.equal(await asks({ window: 'Safari' }), true);
  assert.equal(await asks({ window: 'Canopy' }, { look: { ownWindows: () => { throw new Error('no'); } } }), true, 'windows that cannot be listed are none to look at unasked');
  assert.equal(await asks({ window: 'Canopy' }, { look: null }), true);
  assert.equal(R.READ_CHAT.asks, undefined, 'reading the user\'s own chats never asks');
  assert.equal(L.LOOK.available({ look: {} }), true);
  assert.equal(L.LOOK.available({ look: null }), false);
  assert.equal(L.LOOK.available(undefined), false);
  assert.deepEqual(C.toolsFor({ look: null }).map((t) => t.name), ['read_chat', 'show_widget', 'read_me', 'task'], 'a host with no screen has no look to offer');
  assert.deepEqual(C.toolsFor({ look: {} }).map((t) => t.name), ['look', 'read_chat', 'show_widget', 'read_me', 'task']);
  const broken = T.defineTool(def({ available: () => { throw new Error('no'); } }));
  assert.deepEqual(C.toolsFor({}, [broken, T.defineTool(def({ name: 'other' }))]).map((t) => t.name), ['other'], 'a tool that cannot say whether it is there is not');

  assert.equal(L.lookScope({ url: 'https://example.com/pricing?x=1' }), 'web:https://example.com');
  assert.equal(L.lookScope({ url: 'https://example.com/', width: 390 }), 'web:https://example.com', 'the same site at another size is the same yes');
  assert.equal(L.lookScope({ url: 'https://example.com:8443/' }), 'web:https://example.com:8443');
  assert.equal(L.lookScope({ url: 'http://example.com/' }), 'web:http://example.com');
  assert.notEqual(L.lookScope({ url: 'https://example.org/' }), L.lookScope({ url: 'https://example.com/' }));
  assert.equal(L.lookScope({ url: '/Users/me/site/index.html' }), 'file:/Users/me/site/index.html');
  assert.equal(L.lookScope({ window: '  Safari ' }), 'window:safari');
  assert.equal(L.lookScope({}), 'look', 'a call that captures nothing has nothing to cover');
  assert.equal(L.LOOK.scope, L.lookScope);
});

// ---- the widgets: one definition, the tools a Claude chat always had ----

const W = await core('widgets.mjs');
const G = await core('widget-guide.mjs');
const noWidgets = missing || W.__missing || G.__missing || W.WIDGETS_MISSING ? 'widgets cannot load in this build' : false;

// show_widget and read_me as a Claude chat was handed them before they were defined once for every engine: written
// out here by hand, word for word, so any change to what Claude Code is told shows up as a failure.
async function widgetToolsBefore() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const server = sdk.createSdkMcpServer({ name: 'visualize', version: '1.0.0', tools: [
    sdk.tool('show_widget', W.SHOW_DESCRIPTION, {
      i_have_seen_read_me: z.boolean().describe('True once read_me\'s answer is in this conversation. If it is not, call read_me first.'),
      title: z.string().describe('A few plain words naming what this shows, e.g. "Usage by model". The user sees it while the widget draws.'),
      widget_code: z.string().describe('The HTML fragment: optional <style>, then markup, then <script>. No <html>, <head> or <body>.'),
    }, async () => ok, { alwaysLoad: true, annotations: { title: 'Show a widget', ...annotations } }),
    sdk.tool('read_me', W.GUIDE_DESCRIPTION, {
      modules: z.array(z.enum(G.GUIDE_MODULES)).describe('What you are about to draw. The basics come with any of them.'),
    }, async () => ok, { alwaysLoad: true, annotations: { title: 'Read the widget guide', ...annotations } }),
  ] });
  return server.instance._registeredTools;
}

test('a Claude chat is handed show_widget and read_me exactly as before', { skip: noWidgets }, async () => {
  const { z } = await import('zod');
  const before = await widgetToolsBefore();
  const now = W.createWidgetServer().instance._registeredTools;
  assert.deepEqual(Object.keys(now), Object.keys(before));
  const seen = (t) => ({ title: t.title, description: t.description, schema: z.toJSONSchema(t.inputSchema), annotations: t.annotations, meta: t._meta, enabled: t.enabled });
  for (const name of Object.keys(before)) assert.deepEqual(seen(now[name]), seen(before[name]), name);
});

test('the widgets reach a Codex chat as the same two tools, drawn under their Claude names', { skip: noWidgets }, async () => {
  assert.deepEqual(C.CANOPY_TOOLS.map((t) => t.name).slice(0, 4), ['look', 'read_chat', 'show_widget', 'read_me']);
  assert.equal(C.CANOPY_TOOLS[2], W.SHOW_WIDGET);
  assert.equal(C.CANOPY_TOOLS[3], W.READ_ME);
  assert.deepEqual([T.claudeName(W.SHOW_WIDGET), T.claudeName(W.READ_ME)], [W.SHOW_TOOL, W.GUIDE_TOOL]);
  assert.equal(T.shownName('canopy', 'show_widget'), 'mcp__visualize__show_widget');
  assert.equal(T.shownName('canopy', 'read_me'), 'mcp__visualize__read_me');
  // Every chat has them, with a screen or without.
  assert.deepEqual(C.toolsFor({ look: null }).map((t) => t.name), ['read_chat', 'show_widget', 'read_me', 'task']);
  const { z } = await import('zod');
  const claude = W.createWidgetServer().instance._registeredTools;
  const rows = Object.fromEntries([W.SHOW_WIDGET, W.READ_ME].map((t) => [t.name, T.mcpTool(t)]));
  assert.deepEqual(rows.read_me.inputSchema, {
    type: 'object',
    properties: { modules: { type: 'array', items: { type: 'string', enum: [...G.GUIDE_MODULES] }, description: 'What you are about to draw. The basics come with any of them.' } },
    required: ['modules'], additionalProperties: false,
  });
  assert.deepEqual(rows.show_widget.inputSchema.required, ['i_have_seen_read_me', 'title', 'widget_code']);
  for (const [name, row] of Object.entries(rows)) {
    const theirs = z.toJSONSchema(claude[name].inputSchema);
    assert.equal(row.description, claude[name].description, `${name}: the full description, as Claude's`);
    assert.deepEqual(row.annotations, claude[name].annotations);
    assert.deepEqual(row.inputSchema.properties, theirs.properties, `${name}: the same arguments`);
    assert.deepEqual(row.inputSchema.required, theirs.required);
  }
  assert.equal(W.SHOW_WIDGET.asks, undefined, 'drawing never asks');
  assert.equal(W.READ_ME.asks, undefined);
});

test('show_widget waits a moment for the window\'s report on a widget with a script, whichever engine called it', { skip: noWidgets }, async () => {
  const asked = [];
  const widgetReport = (id) => { asked.push(id); return Promise.resolve({ errors: ['TypeError: x is undefined'] }); };
  const args = { i_have_seen_read_me: true, title: 'A', widget_code: '<p>Hi</p><script>x.y()</script>' };
  const out = await W.SHOW_WIDGET.run(args, { engine: 'codex', callId: 'call_1', widgetReport });
  assert.deepEqual(asked, ['call_1']);
  assert.match(out.content[0].text, /Its script failed when it ran: TypeError: x is undefined/);
  assert.equal((await W.SHOW_WIDGET.run(args, { engine: 'codex', callId: null, widgetReport })).content[0].text, W.showResult(args).content[0].text, 'no id, nothing to wait for');
  assert.deepEqual(asked, ['call_1']);
  const t0 = Date.now();
  const late = await W.SHOW_WIDGET.run(args, { callId: 'call_2', widgetReport: () => new Promise(() => {}) });
  assert.ok(Date.now() - t0 < W.WIDGET_REPORT_MS + 1000, 'a window that says nothing is not waited on for long');
  assert.equal(late.content[0].text, W.showResult(args).content[0].text);
  const guide = await W.READ_ME.run({ modules: ['chart'] }, {});
  assert.ok(guide.content[0].text.includes('## <canopy-chart>'));
});

// Canopy's own tools together (widgets, look, read_chat, Code Mode) and what Canopy adds to the system prompt, as one
// chat has them: all there at its first turn, in one order, and the same for as long as the chat lives. Each tool's
// own behaviour is in its own file's tests; this is about them side by side. Against the scripted fake of the SDK.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake, CAPABILITIES } from '../fake-query.mjs';
import { core, watch, within } from '../helpers.mjs';

const S = await core('session.mjs');
const [C, W, L, R, F, E] = await Promise.all(['code-mode.mjs', 'widgets.mjs', 'look.mjs', 'read-chat.mjs', 'facts.mjs', 'env.mjs'].map((f) => core(f)));
const missing = [S, C, W, L, R, F, E].find((m) => m.__missing)?.__missing
  ?? (C.CODE_MISSING || W.WIDGETS_MISSING || L.LOOK_MISSING || R.READ_CHAT_MISSING ? 'a tool cannot load in this build' : false);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-tools-')));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const open = [];
afterEach(async () => { for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } } });
// A chat as the app starts one: the host can take screenshots (`look`; it has one window of its own), and Claude Code
// can run scripts.
const SCREEN = { ownWindows: () => [{ app: 'Canopy', title: 'Canopy', own: true }] };
function session(opts = {}) {
  const fake = createFake({ capabilities: [...CAPABILITIES, ...(C.CODE_CAPS ?? [])] });
  const s = new S.Session({ cwd: root, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, personalMemory: false, queryFn: fake.queryFn, look: SCREEN, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const changes = (run) => run.calls.filter((c) => c.method === 'setMcpServers');
const ALWAYS = ['visualize', 'canopy_look', 'canopy_chats', 'canopy_task'];

// The start of every request is the system prompt and the tools. One server more, fewer or in another place, or one
// changed character in what Canopy adds to the prompt, and Claude re-reads the whole chat at full price.
test('a chat has every Canopy tool at its first turn and keeps exactly those, over a toggle and a restart', { skip: missing }, async () => {
  for (const code of [true, false]) {
    const { s, fake, w } = session(code ? { codeMode: true } : {});
    s.send('hello');
    await idle(w);
    const first = fake.current.options;
    assert.deepEqual(Object.keys(first.mcpServers), code ? [...ALWAYS, 'canopy'] : ALWAYS, 'the servers that never go come first, in one order');
    assert.deepEqual(Object.values(first.mcpServers).map((v) => v.type), Object.keys(first.mcpServers).map(() => 'sdk'));
    assert.equal(changes(fake.current).length, 0, 'registered once, when Claude Code starts');

    assert.deepEqual(await s.set('codeMode', !code), { ok: true, applied: 'new-chats' });
    assert.equal(changes(fake.current).length, 0, 'the switch does not reach a chat that has started');

    await s.stop();
    const mark = w.mark();
    s.send('more');
    await idle(w, mark);
    assert.equal(fake.starts, 2);
    const second = fake.current.options;
    assert.deepEqual(Object.keys(second.mcpServers), Object.keys(first.mcpServers), 'a later process of the chat registers the same');
    assert.equal(changes(fake.current).length, 0);
    assert.equal(second.systemPrompt.append, first.systemPrompt.append);
    // The prompt cache lifetime is left to Claude Code, as in the terminal.
    assert.deepEqual([first.settings?.promptCacheTtl, second.settings?.promptCacheTtl], [undefined, undefined]);
    assert.ok(!('CLAUDE_CODE_PROMPT_CACHE_TTL' in second.env));
  }
});

test('what Canopy adds to the system prompt is the facts alone: no tool is named in it, with Code Mode or without', { skip: missing }, async () => {
  const on = session({ codeMode: true });
  const off = session();
  await Promise.all([on.s.warm(), off.s.warm()]);
  const append = on.fake.current.options.systemPrompt.append;
  assert.equal(append, F.CANOPY_FACTS);
  assert.equal(off.fake.current.options.systemPrompt.append, append);
  // Only Code Mode's server has a note of its own, and it rides on the server, so it comes with the tool or not at all.
  const notes = Object.fromEntries(Object.entries(on.fake.current.options.mcpServers).map(([k, v]) => [k, v.instance.server._instructions ?? null]));
  assert.deepEqual(notes, { visualize: null, canopy_look: null, canopy_chats: null, canopy_task: null, canopy: C.CODE_NOTE });
});

test('what is always in front of Claude and what waits behind tool search', { skip: missing }, async () => {
  const { s, fake } = session({ codeMode: true });
  await s.warm();
  const loaded = {};
  for (const [server, v] of Object.entries(fake.current.options.mcpServers)) {
    for (const [name, t] of Object.entries(v.instance._registeredTools)) loaded[`mcp__${server}__${name}`] = t._meta?.['anthropic/alwaysLoad'] === true;
  }
  // read_chat is the one that waits: it is for the odd question about another chat, and costs nothing until asked for.
  assert.deepEqual(loaded, { [W.SHOW_TOOL]: true, [W.GUIDE_TOOL]: true, [L.LOOK_TOOL]: true, [R.READ_CHAT_TOOL]: false, 'mcp__canopy_task__task': true, [C.CODE_TOOL]: true });
});

test('none of Canopy\'s own tools ask in one chat, except a look beyond this Mac and this app, and where the user said to ask', { skip: missing }, async () => {
  const { s, w } = session({ codeMode: true });
  await s.warm();
  const quiet = [[W.SHOW_TOOL, { widget_code: '<p>hi</p>' }], [W.GUIDE_TOOL, {}], [L.LOOK_TOOL, { url: 'http://localhost:5173/' }], [L.LOOK_TOOL, { window: 'Canopy' }], [R.READ_CHAT_TOOL, {}], [C.CODE_TOOL, { code: 'return 1' }]];
  for (const [name, input] of quiet) {
    const answer = await within(s.broker(name, input, { toolUseID: 'toolu_1' }), 1000, name);
    assert.equal(answer.behavior, 'allow', name);
  }
  assert.equal(w.of('permission').length, 0);
  const asked = async (name, input, ctx = {}) => {
    const before = w.of('permission').length;
    s.broker(name, input, { toolUseID: `toolu_${before + 2}`, ...ctx }).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    return w.of('permission').slice(before).map((p) => p.toolName);
  };
  assert.deepEqual(await asked(L.LOOK_TOOL, { url: 'https://example.com/' }), [L.LOOK_TOOL]);
  assert.deepEqual(await asked(L.LOOK_TOOL, { window: '1Password' }), [L.LOOK_TOOL], 'another app\'s window can be showing anything');
  // An ask rule the user wrote for one of them, or a hook of theirs, is not answered for them.
  assert.deepEqual(await asked(L.LOOK_TOOL, { window: 'Canopy' }, { decisionReasonType: 'rule' }), [L.LOOK_TOOL]);
  assert.deepEqual(await asked(R.READ_CHAT_TOOL, {}, { matchedAskRule: { source: 'userSettings', toolName: R.READ_CHAT_TOOL } }), [R.READ_CHAT_TOOL]);
  assert.deepEqual(await asked(R.READ_CHAT_TOOL, {}, { decisionReasonType: 'hook' }), [R.READ_CHAT_TOOL]);
});

// With Code Mode on Claude is told to script three or more MCP calls, and a look at three widths is three. A script
// only brings back words, so the pictures would be lost: the script is told to leave look to Claude.
test('a script cannot look: it is told why, and nothing is rendered', { skip: missing }, async () => {
  const { s } = session({ codeMode: true });
  await s.warm();
  const sent = [];
  // The fake SDK has no pipes: this stands in for Claude Code's side of a script's calls.
  s.run.control = { open: true, cancel() {}, request(req) { sent.push(req.tool); return { id: `t${sent.length}`, answer: Promise.resolve({ ok: true, response: { content: [{ type: 'text', text: 'ok' }] } }) }; } };
  const code = `try { await mcp('${L.LOOK_TOOL}', { url: 'localhost:3000', width: 390 }); } catch (e) { return e.message; }`;
  const r = await within(s.runCode(s.run, { description: 'd', code }, {}), 20000, 'the script');
  assert.match(r.content[0].text, /^A script cannot bring a screenshot back: .* Call look yourself, once for each picture you need\./);
  const picture = await s.runCode(s.run, { description: 'Chrome screenshot', code: "try { await mcp('mcp__canopy_chrome__take_screenshot', { pageId: 1 }); } catch (e) { return e.message; }" }, {});
  assert.match(picture.content[0].text, /Call the Chrome screenshot tool directly/);
  assert.deepEqual(sent, []);
  // Refusing costs a step each time, so the note that asks for scripts says the exception where the rule is given.
  assert.ok(C.CODE_NOTE.includes('So does a tool whose result is a picture (a screenshot), however many times you call it: a script can only bring back words.'));
});

test('Claude adds the background Chrome connector alongside its other servers', { skip: missing }, async () => {
  const chrome = { type: 'stdio', command: '/canopy', args: ['/chrome-server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const { s, fake } = session({ codeMode: true, chrome });
  await s.warm();
  const { mcpServers } = fake.current.options;
  assert.deepEqual(Object.keys(mcpServers), [...ALWAYS, 'canopy', 'canopy_chrome']);
  assert.deepEqual(mcpServers.canopy_chrome, chrome);
});

// widgets.mjs: the two tools Claude draws with, what show_widget says back (a text outline and notes on what will
// not work), the guide, and Session's side of it (always registered, never asks, its input streamed to the window).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake, CAPABILITIES } from '../fake-query.mjs';
import { core, watch, within } from '../helpers.mjs';

const W = await core('widgets.mjs');
const G = await core('widget-guide.mjs');
const M = await core('code-mode.mjs');
const S = await core('session.mjs');
const missing = W.__missing ? `widgets.mjs: ${W.__missing}` : G.__missing ? `widget-guide.mjs: ${G.__missing}` : W.WIDGETS_MISSING ? `widgets cannot load: ${W.WIDGETS_MISSING}` : false;
const noSession = missing || (S.__missing ? `session.mjs: ${S.__missing}` : false);
const text = (result) => result.content[0].text;
const show = (widget_code, extra = {}) => W.showResult({ i_have_seen_read_me: true, title: 'Usage', widget_code, ...extra });

// ---- the outline ----

test('a table is outlined as its first rows and how many more there are', { skip: missing }, () => {
  const rows = Array.from({ length: 20 }, (_, i) => `chat ${i},Opus,${i * 3},${(i * 1.5).toFixed(2)}`).join('\n');
  const out = W.widgetOutline(`<canopy-table caption="usage.csv" sort="Cost desc">\nChat,Model,Turns,Cost\n${rows}\n</canopy-table>`);
  const lines = out.split('\n');
  assert.equal(lines[0], 'usage.csv');
  assert.equal(lines[1], 'Chat | Model | Turns | Cost');
  assert.equal(lines[2], 'chat 0 | Opus | 0 | 0.00');
  assert.equal(lines.at(-1), '… 14 more rows');
  // Quoted cells, tabs, and a plain <table> read the same way.
  assert.match(W.widgetOutline('<canopy-table>\nName,Note\n"Smith, J","said ""hi"""\n</canopy-table>'), /Smith, J \| said "hi"/);
  assert.match(W.widgetOutline('<canopy-table>\nA\tB\n1\t2\n</canopy-table>'), /A \| B\n1 \| 2/);
  assert.match(W.widgetOutline('<canopy-table><table><tr><th>File</th><th>Lines</th></tr><tr><td><code>a.ts</code></td><td>12</td></tr></table></canopy-table>'), /File \| Lines\na\.ts \| 12/);
});

test('charts, stats, choices, tabs and diffs each say what they are', { skip: missing }, () => {
  assert.equal(W.widgetOutline('<canopy-chart type="line" caption="Weekly users">\nWeek,2025\nW1,1200\n</canopy-chart>'), 'Chart (line): Weekly users\nWeek | 2025\nW1 | 1200');
  assert.equal(W.widgetOutline('<div class="grid"><canopy-stat label="p95" value="182 ms" delta="-12%"></canopy-stat><canopy-stat label="Errors" value="0.4%"></canopy-stat></div>'), 'p95: 182 ms (-12%)\nErrors: 0.4%');
  const choices = W.widgetOutline(`<canopy-choices question="Where should history live?" message="Go with {choice}">
    <canopy-choice label="SQLite" hint="A file next to the app" recommended><ul><li>Zero setup</li></ul></canopy-choice>
    <canopy-choice label="Postgres" hint="A server you run"></canopy-choice></canopy-choices>`);
  assert.equal(choices, 'Where should history live?\n- SQLite: A file next to the app\n- Zero setup\n- Postgres: A server you run');
  assert.equal(W.widgetOutline('<canopy-tabs><section label="By model"><p>one</p></section><section title="By day"><p>two</p></section></canopy-tabs>'), 'By model:\none\nBy day:\ntwo');
  assert.equal(W.widgetOutline('<canopy-diff file="pricing.md"><pre>a &lt; b</pre><pre>a &gt; b</pre></canopy-diff>'), 'Before and after: pricing.md');
});

test('plain markup keeps its words and loses its styles, scripts and tags', { skip: missing }, () => {
  const out = W.widgetOutline(`<style>.x{color:red}</style><!-- note -->
    <div class="card"><h3>Notifications</h3><label>When a chat finishes <input type="checkbox"></label>
    <input placeholder="Search"><ul><li>One &amp; two</li><li>Three</li></ul><button>Save</button></div>
    <svg viewBox="0 0 10 10"><rect/><text x="1">Browser</text><text>Edge&nbsp;cache</text></svg>
    <script>const a = '<b>not text</b>'; canopy.send(a)</script>`);
  assert.equal(out, 'Notifications\nWhen a chat finishes\n[Search]\n- One & two\n- Three\nSave\nBrowser\nEdge cache');
  assert.equal(W.widgetOutline(''), '');
  assert.equal(W.widgetOutline(null), '');
  assert.equal(W.widgetOutline('<style>p{margin:0}'), '', 'a style block that never closed');
});

test('a long widget is cut at a line, within the limit', { skip: missing }, () => {
  const out = W.widgetOutline(Array.from({ length: 200 }, (_, i) => `<p>Paragraph number ${i} of the widget</p>`).join(''));
  assert.ok(out.length <= 710, `${out.length} characters`);
  assert.ok(out.endsWith('\n…'));
  assert.ok(out.split('\n').slice(0, -1).every((l) => /^Paragraph number \d+ of the widget$/.test(l)), 'no line is cut in half');
});

// ---- the notes ----

test('a clean widget gets no notes', { skip: missing }, () => {
  for (const html of [
    '<canopy-table>\nA,B\n1,2\n</canopy-table>',
    '<style>.x{color:var(--color-text-secondary);border:1px solid var(--color-border-tertiary)}</style><div class="card x">Hi</div><script>document.querySelector(".x").onclick = () => canopy.send("Go")</script>',
    '<svg viewBox="0 0 680 120"><rect class="box" x="10" y="30" width="150" height="56" rx="8" fill="var(--color-accent)"/></svg>',
    '<button onclick="sendPrompt(\'Pick A\')">A</button>',
    '<p style="color: #888">one written-out color is let through</p>',
  ]) assert.deepEqual(W.lintWidget(html), [], html);
});

test('the visual blocks are outlined by their question and their options, items and controls', { skip: missing }, () => {
  const pick = W.widgetOutline(`<canopy-pick question="Which title slide?" message="Go with {choice}">
    <canopy-preview><canopy-scale for="Night Forest"><div><h1>Canopy</h1></div></canopy-scale></canopy-preview>
    <div class="row"><div option="Night Forest" hint="Dark" recommended><div><div>thumb text</div></div></div><figure option="Editorial">x</figure></div>
  </canopy-pick><p>after it</p>`);
  assert.equal(pick, 'Which title slide?\n- Night Forest: Dark (recommended)\n- Editorial\nafter it', 'previews and thumbnails say nothing the labels do not');
  assert.equal(W.widgetOutline('<canopy-pick multiple><div option="A"></div><div option="B"></div></canopy-pick>'), 'Pick any:\n- A\n- B');
  assert.equal(W.widgetOutline('<canopy-rank><div item="Widgets" hint="this"><b>Widgets</b></div><div item="Site"></div></canopy-rank>'), 'In order:\n- Widgets: this\n- Site');
  assert.equal(W.widgetOutline('<canopy-review ref="look-3" message="x"></canopy-review>'), 'Notes on screenshot look-3');
  assert.match(W.widgetOutline('<canopy-tune><label>Radius <input type="range" name="radius"></label></canopy-tune>'), /^Values to tune:\nRadius/);
});

test('a design being judged may use its own colors; the blocks are checked for what would break them', { skip: missing }, () => {
  const colors = '<div style="background:#0c1712;color:#eef5f0;border-color:#f3eee4">slide</div>';
  assert.deepEqual(W.lintWidget(`<canopy-pick><div option="A">${colors}</div><div option="B">${colors}</div></canopy-pick>`), []);
  assert.ok(W.lintWidget(`<div class="card">${colors}</div>`).some((n) => /colors are written out/.test(n)), 'chrome still keeps to the variables');
  assert.match(W.lintWidget('<canopy-review ref="shot1"></canopy-review>').join(' '), /needs ref="look-N".*\(not "shot1"\)/);
  assert.deepEqual(W.lintWidget('<canopy-shot ref="look-12"></canopy-shot>'), []);
  assert.match(W.lintWidget('<canopy-pick><div option="A"></div></canopy-pick>').join(' '), /two or more elements with option/);
  const notes = W.lintWidget('<canopy-pick><div option="A">a</div><div option="A">b</div><canopy-preview><div for="B"></div></canopy-preview></canopy-pick>').join(' ');
  assert.match(notes, /share a label \("A"\)/);
  assert.match(notes, /for="B" names no option/);
});

test('what will not work in the frame is said in a sentence each', { skip: missing }, () => {
  const note = (html, re) => { const notes = W.lintWidget(html); assert.ok(notes.some((n) => re.test(n)), `${html}\n→ ${JSON.stringify(notes)}`); };
  note('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><canvas></canvas>', /no network.*cdn\.jsdelivr\.net.*<canopy-chart>/);
  note('<link rel="stylesheet" href="//fonts.googleapis.com/css2?family=Inter">', /no network/);
  note('<style>@import url("https://fonts.googleapis.com/css");</style>', /no network/);
  note('<div style="background: url(https://x.test/a.png)"></div>', /no network/);
  note('<img src="https://example.com/a.png">', /no network/);
  note('<script>fetch("/api").then(r => r.json())</script>', /fetch, XMLHttpRequest, WebSocket and import\(\) fail/);
  note('<!doctype html><html><body><p>x</p></body></html>', /a fragment, not a page/);
  note('<canopy-grid><canopy-card>x</canopy-card></canopy-grid>', /There is no <canopy-grid>, <canopy-card>\. The components are: <canopy-table>/);
  note('<form action="/x"><input></form>', /<form> cannot submit/);
  note('<script>alert("hi")</script>', /alert\(\)/);
  note('<script>localStorage.setItem("a", 1)</script>', /canopy\.setState/);
  note('<div style="position:fixed;top:0">x</div>', /position: fixed/);
  note('<iframe srcdoc="x"></iframe>', /<iframe>/);
  note('<style>.a{color:#ff0000}.b{background:rgb(0,0,255)}.c{border-color:#0f0}</style>', /3 colors are written out \(#ff0000, rgb\(, #0f0…\)/);
  // A comment that mentions these is not the thing itself.
  assert.deepEqual(W.lintWidget('<!-- no fetch( here, no <form> --><p>ok</p>'), []);
});

// ---- the result ----

test('the result says what was shown, as text a terminal can read', { skip: missing }, () => {
  const r = show('<canopy-table caption="usage.csv">\nChat,Cost\nSidebar,7.12\n</canopy-table>');
  assert.equal(r.isError, undefined);
  assert.equal(text(r), 'Shown to the user in Canopy: Usage.\n\nWhat it shows, as text:\nusage.csv\nChat | Cost\nSidebar | 7.12');
  // Notes come before the outline, where the model reads first.
  const bad = text(show('<script src="https://cdn.test/x.js"></script><p>Hello</p>'));
  assert.match(bad, /^Shown to the user in Canopy: Usage\.\n\nTo fix:\n- The frame has no network[^\n]+\n\nWhat it shows, as text:\nHello$/);
  // Nothing but a drawing: no outline section at all.
  assert.equal(text(show('<svg viewBox="0 0 10 10"><rect/></svg>')), 'Shown to the user in Canopy: Usage.');
});

test('nothing to draw, or far too much, is an error that says what to do', { skip: missing }, () => {
  for (const code of ['', '   \n', undefined, 42]) {
    const r = show(code);
    assert.equal(r.isError, true);
    assert.match(text(r), /^Nothing was shown: widget_code is empty\./);
  }
  const big = show('x'.repeat(W.HTML_LIMIT + 1));
  assert.equal(big.isError, true);
  assert.match(text(big), /^Nothing was shown: widget_code is 200,001 characters and the limit is 200,000\./);
  assert.equal(show('x'.repeat(W.HTML_LIMIT)).isError, undefined);
  assert.doesNotThrow(() => W.showResult(null));
  assert.doesNotThrow(() => W.showResult({ title: 7, widget_code: '<p>x</p>' }));
});

test('a widget drawn without the guide is still shown, and the model is told to read it', { skip: missing }, () => {
  const r = W.showResult({ i_have_seen_read_me: false, title: 'A', widget_code: '<p>Hello</p>' });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /- You have not read the guide\. Call read_me before the next widget/);
});

test('what the window reported about drawing it reaches the model first', { skip: missing }, () => {
  const r = text(W.showResult({ i_have_seen_read_me: true, title: 'A', widget_code: '<p>Hello</p><script>nope()</script>' }, { errors: ['ReferenceError: nope is not defined (line 1)'] }));
  assert.match(r, /To fix:\n- Its script failed when it ran: ReferenceError: nope is not defined \(line 1\)\. /);
  assert.equal(text(W.showResult({ i_have_seen_read_me: true, title: 'A', widget_code: '<p>Hello</p>' }, { errors: [] })), 'Shown to the user in Canopy: A.\n\nWhat it shows, as text:\nHello');
});

// ---- the guide ----

test('the guide comes by module, basics first, and names what was left out', { skip: missing }, () => {
  const all = G.guideText(G.GUIDE_MODULES);
  const basics = G.guideText([]);
  assert.ok(basics.startsWith('# Writing a widget for Canopy'));
  assert.ok(basics.endsWith(`Other modules, when you need them: ${G.GUIDE_MODULES.join(', ')}.`));
  const chart = G.guideText(['chart', 'nonsense', 'table']);
  assert.ok(chart.indexOf('## <canopy-table>') < chart.indexOf('## <canopy-chart>'), 'a fixed order, whatever was asked first');
  assert.ok(!chart.includes('## <canopy-diff>'));
  assert.ok(chart.endsWith('Other modules, when you need them: choices, diff, mockup, diagram, interactive, pick, compare, tune, markup, rank, motion.'));
  assert.ok(!all.includes('Other modules'));
  assert.doesNotThrow(() => G.guideText(null));
  // What the guide costs, in characters: the basics are read on every first widget, so they stay small.
  assert.ok(basics.length < 5200, `basics are ${basics.length} characters`);
  // Nobody reads all of it: a widget asks for one or two modules. The whole is bounded so no module sprawls.
  assert.ok(all.length < 24000, `the whole guide is ${all.length} characters`);
});

test('every example in the guide passes its own rules', { skip: missing }, () => {
  const all = G.guideText(G.GUIDE_MODULES);
  // Each module's example is the first run of markup lines after its heading.
  const examples = [...all.matchAll(/\n\n((?:<[a-z][^\n]*\n(?:[^\n]+\n)*?)+?)\n- /g)].map((m) => m[1]);
  assert.ok(examples.length >= G.GUIDE_MODULES.length, `found ${examples.length} examples`);
  for (const ex of examples) assert.deepEqual(W.lintWidget(ex), [], ex);
  // Every element the guide names is one the frame has, and the other way round.
  const named = new Set([...all.matchAll(/<(canopy-[a-z]+)/g)].map((m) => m[1]));
  assert.deepEqual([...named].sort(), [...W.COMPONENTS].sort());
});

test('the descriptions say when to draw, when not to, and to read the guide first', { skip: missing }, () => {
  for (const word of ['without being asked', 'Do not use it when', 'Markdown', 'mermaid', 'ask it in words', 'never a Markdown table', 'ASCII art', 'fragment', 'no network', 'read_me', '<canopy-table>', '<canopy-chart>', '<canopy-choices', '<canopy-diff>', 'same title replaces',
    // The moments the user would otherwise be asked in words about something judged by eye (docs/design/visual-widgets.md).
    'judge by eye', '<canopy-pick>', '<canopy-scale>', '<canopy-compare>', '<canopy-tune>', '<canopy-review>', '<canopy-markup>', '<canopy-rank>', '<canopy-pick multiple>', 'playing', 'quick answer']) {
    assert.ok(W.SHOW_DESCRIPTION.includes(word), word);
  }
  assert.ok(W.SHOW_DESCRIPTION.length < 3200, `the description is in every turn's context: ${W.SHOW_DESCRIPTION.length} characters`);
  assert.ok(W.GUIDE_DESCRIPTION.includes('before the first show_widget'));
});

// ---- the server, and Session's side ----

test('the server carries both tools, always loaded and marked read-only', { skip: missing }, async () => {
  const seen = [];
  const server = W.createWidgetServer({ show: (args, extra) => { seen.push([args, extra]); return W.showResult(args); } });
  assert.deepEqual([server.type, server.name], ['sdk', 'visualize']);
  assert.deepEqual([W.SHOW_TOOL, W.GUIDE_TOOL], ['mcp__visualize__show_widget', 'mcp__visualize__read_me']);
  const tools = server.instance._registeredTools;
  assert.deepEqual(Object.keys(tools).sort(), ['read_me', 'show_widget']);
  for (const t of Object.values(tools)) {
    assert.equal(t.annotations.readOnlyHint, true, 'Plan mode lets a read-only tool through');
    assert.equal(t._meta?.['anthropic/alwaysLoad'], true, 'never behind tool search');
  }
  const shown = await tools.show_widget.handler({ i_have_seen_read_me: true, title: 'T', widget_code: '<p>Hi</p>' }, { x: 1 });
  assert.equal(text(shown), 'Shown to the user in Canopy: T.\n\nWhat it shows, as text:\nHi');
  assert.deepEqual(seen[0][1], { x: 1 });
  const guide = await tools.read_me.handler({ modules: ['chart'] }, {});
  assert.ok(text(guide).includes('## <canopy-chart>'));
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-widgets-')));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const open = [];
afterEach(async () => { for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } } });
function session(opts = {}, script = {}) {
  const fake = createFake(script);
  const s = new S.Session({ cwd: root, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}

// read_chat's server (read-chat.mjs) and task's (task-tool.mjs) are always registered too; these tests are about the
// widgets server, so they are left out of what they compare.
const mine = (o) => Object.keys(o ?? {}).filter((k) => k !== 'canopy_chats' && k !== 'canopy_task');

test('every chat has the widgets server from its first turn, with Code Mode or without', { skip: noSession }, async () => {
  const plain = session();
  await plain.s.warm();
  assert.deepEqual(mine(plain.fake.current.options.mcpServers), ['visualize']);
  assert.equal(plain.fake.current.options.mcpServers.visualize.type, 'sdk');

  const CAN = [...CAPABILITIES, ...(M.CODE_CAPS ?? [])];
  const { s, fake } = session({ codeMode: true }, { capabilities: CAN });
  await s.warm();
  assert.deepEqual(mine(fake.current.options.mcpServers), ['visualize', 'canopy']);
  const widgets = fake.current.options.mcpServers.visualize;
  // Turning Code Mode off and on again names the same widgets server each time: leaving it out would remove it.
  await s.set('codeMode', false);
  await s.set('codeMode', true);
  const payloads = fake.current.calls.filter((c) => c.method === 'setMcpServers').map((c) => c.args[0]);
  assert.deepEqual(payloads.map((p) => mine(p)), [['visualize'], ['visualize', 'canopy']]);
  assert.ok(payloads.every((p) => p.visualize === widgets), 'one server for the life of the process');
});

test('showing a widget and reading the guide never ask', { skip: noSession }, async () => {
  const { s, w } = session();
  await s.warm();
  for (const name of [W.SHOW_TOOL, W.GUIDE_TOOL]) {
    const input = { title: 'T', widget_code: '<p>x</p>' };
    const answer = await within(s.broker(name, input, { toolUseID: 'toolu_1' }), 1000, 'the answer');
    assert.deepEqual(answer, { behavior: 'allow', updatedInput: input, toolUseID: 'toolu_1' });
  }
  assert.equal(w.of('permission').length, 0);
});

test('a widget\'s input reaches the window while it is being written', { skip: noSession }, async () => {
  const { s, w } = session();
  await s.warm();
  const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
  const run = s.run;
  s.setBusy(true, 'running'); // a turn is under way: its events are kept for a window that reloads
  s.onFrame(ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_w1', name: W.SHOW_TOOL, input: {} } }), run);
  s.onFrame(ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"Usage","widget_code":"<p>Hel' } }), run);
  const partials = w.of('tool-input-partial');
  assert.deepEqual(partials.map((e) => e.input), [{}, { title: 'Usage', widget_code: '<p>Hel' }]);
  assert.ok(partials.every((e) => e.id === 'toolu_w1' && e.name === W.SHOW_TOOL));
  // Another tool's input is not followed.
  s.onFrame(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_w2', name: 'Write', input: {} } }), run);
  assert.equal(w.of('tool-input-partial').length, 2);
  // A window that reloads mid-stream redraws from the turn log: it holds the latest snapshot, not every one.
  const log = s.snapshot().turn.filter((e) => e.kind === 'tool-input-partial');
  assert.deepEqual(log.map((e) => e.input), [{ title: 'Usage', widget_code: '<p>Hel' }]);
});

test('a widget with a script waits a moment to hear how it ran; one without answers at once', { skip: noSession }, async () => {
  const asked = [];
  const { s } = session({ widgetReport: (id) => { asked.push(id); return Promise.resolve({ errors: ['ReferenceError: nope is not defined (line 1)'] }); } });
  await s.warm();
  const extra = { _meta: { 'claudecode/toolUseId': 'toolu_w9' } };
  const scripted = await s.showWidget({ i_have_seen_read_me: true, title: 'A', widget_code: '<p>Hi</p><script>nope()</script>' }, extra);
  assert.deepEqual(asked, ['toolu_w9']);
  assert.match(text(scripted), /Its script failed when it ran: ReferenceError: nope is not defined \(line 1\)\. .* show the widget again/);
  // Nothing to run, nothing to wait for.
  const plain = await s.showWidget({ i_have_seen_read_me: true, title: 'A', widget_code: '<p>Hi</p>' }, extra);
  assert.deepEqual(asked, ['toolu_w9']);
  assert.equal(text(plain), 'Shown to the user in Canopy: A.\n\nWhat it shows, as text:\nHi');

  // No window answers (the chat is not on screen), or the hook throws: the tool still answers, without the report.
  const quiet = session({ widgetReport: () => new Promise(() => {}) });
  await quiet.s.warm();
  const t0 = Date.now();
  const late = await within(quiet.s.showWidget({ i_have_seen_read_me: true, title: 'A', widget_code: '<p>Hi</p><script>ok()</script>' }, extra), 4000, 'the result');
  assert.ok(Date.now() - t0 < 3000, 'it does not wait for long');
  assert.match(text(late), /^Shown to the user in Canopy: A\./);
  const broken = session({ widgetReport: () => { throw new Error('boom'); } });
  await broken.s.warm();
  assert.match(text(await broken.s.showWidget({ i_have_seen_read_me: true, title: 'A', widget_code: '<script>ok()</script><p>x</p>' }, extra)), /^Shown to the user in Canopy: A\./);
});

test('Claude Code is asked to stream tool input as it is written, unless the user said otherwise', { skip: noSession }, async () => {
  const { s } = session();
  assert.equal(s.resolveEnv().CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, '1');
  const off = new S.Session({ cwd: root, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '0' }, trusted: true });
  open.push(off);
  assert.equal(off.resolveEnv().CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, '0');
});

test('the elements the model is told about are exactly the ones the frame defines', { skip: missing }, async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../../../../renderer/src/frame/components/', import.meta.url));
  const defined = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...readFileSync(dir + f, 'utf8').matchAll(/define\('(canopy-[a-z-]+)'/g)].map((m) => m[1]));
  // Drawn by a block itself, never written by the model (the pick's caption under each option).
  const internal = new Set(['canopy-caption']);
  assert.deepEqual(defined.filter((d) => !internal.has(d)).sort(), [...W.COMPONENTS].sort());
});

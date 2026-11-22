// The Codex tools smoke check: Canopy's own tools (look, read_chat, show_widget, read_me) in a real Codex chat, with no window. Canopy's
// real session, relay and helper against the real `codex` on this Mac. Run by hand, never by `npm test`.
//
//   node scripts/codex-tools-smoke.mjs             the free part: Codex starts the helper for a new chat, lists the
//                                                  tools, and calls each of them itself. No model call, costs nothing
//   node scripts/codex-tools-smoke.mjs --live      plus ONE live turn, in a chat Codex never saves: the model looks at
//                                                  two pages and reads another chat, and says what it saw
//   node scripts/codex-tools-smoke.mjs --reopen    plus ONE live turn (one look) in a chat that IS saved, to see the
//                                                  tools, and the look's picture, come back when it is reopened.
//                                                  That chat is archived at the end
//   node scripts/codex-tools-smoke.mjs --widget    plus ONE live turn, in a chat Codex never saves: the model is asked
//                                                  to compare three libraries, and should draw it with show_widget
//   --live, --reopen and --widget can be given together (one live turn each).
//   --model <id>     default: the first model whose id or description says luna, mini, nano or affordable
//
// Contract (the same as scripts/codex-smoke.mjs, which this borrows its set-up from):
//  - Live turns cost real money on the user's own Codex login, so each is small, at the lowest effort the model has,
//    on the standard tier, on the cheapest model. Never more than two, and none without a cheap model to run them on.
//  - Nothing under ~/.codex is written by this script, and none of the user's chats is listed, read or changed. The
//    --live turn runs in a thread Codex never saves (`ephemeral`: put into this script's thread/start on its way to
//    Codex; the session itself never asks for that). A chat can only be reopened if it was saved, so --reopen saves
//    one, and archives it at the end through Codex's own `thread/archive` (reversible), also after a failure.
//  - Every process gets the recorder's set-up: no notify program, no memories, and the user's plugins, apps and MCP
//    servers off, so a test turn never reaches the user's connected accounts.
//  - Nothing is looked at for real. The screenshots are flat squares of colour made here and the "other chat" is
//    made up, so no page is opened, no window is captured and no transcript of the user's is read. What is real is
//    the whole way there and back: CodexSession, the relay's socket, the helper Codex starts, and Codex itself.
//  - It works in a scratch folder under /tmp and removes it. One line per check, PASS, FAIL or SKIP. Exit code 1
//    when anything failed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CodexSession } from '../src/core/codex-session.mjs';
import { CodexService, codexEnv, codexVersion, findCodex } from '../src/core/codex-host.mjs';
import { ToolRelay } from '../src/core/tool-relay.mjs';
import { CANOPY_SERVER, mcpTool } from '../src/core/tool-registry.mjs';
import { LOOK, LOOK_TOOL } from '../src/core/look.mjs';
import { READ_CHAT, READ_CHAT_TOOL } from '../src/core/read-chat.mjs';
import { READ_ME, SHOW_TOOL, SHOW_WIDGET } from '../src/core/widgets.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i === -1) return false; argv.splice(i, 1); return true; };
const option = (name) => { const i = argv.indexOf(name); if (i === -1) return null; const [, v] = argv.splice(i, 2); return v ?? null; };
const LIVE = flag('--live');
const REOPEN = flag('--reopen');
const WIDGET = flag('--widget');
const MODEL = option('--model');
if (argv.length) { console.error(`unknown argument: ${argv.join(' ')}`); process.exit(2); }

const TURN_MS = 180_000;
const ALL = 'look,read_chat,read_me,show_widget'; // the tools a chat with a screen has, by name, sorted
const KEY = `mcp_servers.${CANOPY_SERVER}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- reporting ----

const results = [];
function report(state, name, detail) { results.push({ state, name }); console.log(`${state}  ${name}${detail ? `  (${detail})` : ''}`); }
const check = (name, ok, detail) => { report(ok ? 'PASS' : 'FAIL', name, detail); return !!ok; };
const skip = (name, why) => report('SKIP', name, why);
const section = (title) => console.log(`\n${title}`);
const brief = (v) => { try { return JSON.stringify(v).slice(0, 220); } catch { return String(v); } };
const until = async (cond, ms, label) => { const end = Date.now() + ms; while (!(await cond())) { if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${label}`); await sleep(25); } };

const TURNS = (LIVE ? 1 : 0) + (REOPEN ? 1 : 0) + (WIDGET ? 1 : 0);
let turnsLeft = TURNS;
function spend(what) { if (turnsLeft <= 0) throw new Error(`refusing to start another live turn (${what}): the cap for this run is used up`); turnsLeft -= 1; }

// ---- what is "looked at": flat squares of colour, and one made-up chat ----

function crc32(buf) { let crc = ~0; for (const b of buf) { let c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); }
function png(side, [r, g, b]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(side * 3).map((_, i) => [r, g, b][i % 3])]);
  const head = Buffer.alloc(13); head.writeUInt32BE(side, 0); head.writeUInt32BE(side, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(side).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const SIDE = 96;
const LOCAL = 'http://localhost:4173/';
const WEB = 'https://example.com/';
const COLOURS = { [LOCAL]: ['red', [255, 0, 0]], [WEB]: ['blue', [0, 0, 255]] };
const FRUIT = 'PAPAYA';
function screen() {
  const pages = [];
  const image = (bytes) => { const im = { getSize: () => ({ width: SIDE, height: SIDE }), isEmpty: () => false, resize: () => im, toPNG: () => bytes, toJPEG: () => bytes }; return im; };
  return {
    pages, appName: 'Canopy', screenAccess: () => 'granted', ownWindows: () => [], otherWindows: () => [],
    page: async ({ url }) => { pages.push(url); return { image: image(png(SIDE, (COLOURS[url] ?? ['grey', [128, 128, 128]])[1])), captured: { width: SIDE, height: SIDE }, page: { width: SIDE, height: SIDE }, scrollY: 0, url, status: 200, errors: [], slow: false }; },
  };
}
const otherChats = {
  list: async (cwd) => [{ id: 'aaaaaaaa-0000-4000-8000-00000000cafe', engine: 'claude', title: `Plan the ${FRUIT} launch`, cwd, updated: Date.now() - 120_000 }],
  load: async () => ({ msgs: [{ role: 'user', text: 'Draft the launch plan.' }, { role: 'assistant', text: 'Drafted in docs/launch.md.' }], files: ['docs/launch.md'], lastAt: Date.now() - 120_000, open: false }),
};

// ---- everything this run started, so it can all be undone ----

const sessions = new Set();
const saved = new Set(); // chats Codex wrote to disk: archived at the end
let relay = null;
let service = null;
let scratch = null;
const tokens = [];
const relayed = []; // every call that reached Canopy through the relay: { tool, callId } as the helper named it

function watch(session) {
  const events = [];
  session.on('event', (ev) => events.push(ev));
  const waitFor = async (pred, { ms = TURN_MS, from = 0, label = 'an event' } = {}) => { await until(() => events.slice(from).some(pred), ms, label); return events.slice(from).find(pred); };
  return { events, waitFor };
}

// The recorder's "bare" set-up (scripts/codex-smoke.mjs): the user's Codex with nothing of theirs a test could reach.
function bareSetup(codexPath, env) {
  const flags = ['--disable', 'memories', '--disable', 'plugins', '--disable', 'apps'];
  const config = { notify: [] };
  const r = spawnSync(codexPath, ['--disable', 'plugins', '--disable', 'apps', 'mcp', 'list', '--json'], { env, encoding: 'utf8', timeout: 20000 });
  let servers = [];
  try { servers = JSON.parse(r.stdout); } catch { /* none readable: none switched off by name */ }
  const off = [];
  for (const s of Array.isArray(servers) ? servers : []) if (s?.enabled && /^[A-Za-z0-9_-]+$/.test(s.name ?? '')) { config[`mcp_servers.${s.name}.enabled`] = false; off.push(s.name); }
  return { config, flags, off };
}

/**
 * A spawn that keeps what crossed the pipe at start-up (the command line, each thread/start and thread/resume and
 * what Codex answered them), and, with `ephemeral`, asks Codex never to save the thread: the one thing this script
 * changes on the way, so that a live turn leaves nothing behind.
 */
function tapped({ ephemeral = false } = {}) {
  const seen = { args: null, opens: [], answers: [] };
  const spawnFn = (cmd, args, opts) => {
    seen.args = args;
    const child = spawn(cmd, args, opts);
    const asked = new Set();
    let buf = '';
    child.stdout?.on('data', (d) => {
      buf += d.toString('utf8');
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        if (!asked.size || !line.includes('"thread"')) continue;
        try { const m = JSON.parse(line); if (asked.has(m.id) && m.result?.thread) { asked.delete(m.id); seen.answers.push(m.result); } } catch { /* not a message */ }
      }
    });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...rest) => {
      let out = data;
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        if (text.includes('"thread/start"') || text.includes('"thread/resume"')) {
          const m = JSON.parse(text);
          if (m.method === 'thread/start' || m.method === 'thread/resume') {
            if (ephemeral && m.method === 'thread/start') { m.params.ephemeral = true; out = `${JSON.stringify(m)}\n`; }
            seen.opens.push({ method: m.method, params: m.params });
            asked.add(m.id);
          }
        }
      } catch { /* the tap never breaks the pipe */ }
      return write(out, ...rest);
    };
    return child;
  };
  return { spawnFn, seen };
}

const textOf = (result) => (Array.isArray(result?.content) ? result.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const picturesOf = (result) => (Array.isArray(result?.content) ? result.content.filter((b) => b?.type === 'image') : []);

async function main() {
  const env = codexEnv(process.env);
  section('Codex on this Mac');
  const codexPath = await findCodex({ ...process.env });
  if (!check('codex is found', !!codexPath, codexPath ?? 'not on PATH')) return;
  const version = await codexVersion(codexPath, process.env);
  check('codex says its version', !!version, version ?? 'no answer');

  scratch = fs.realpathSync(fs.mkdtempSync('/tmp/canopy-codex-tools-smoke-'));
  const bare = bareSetup(codexPath, env);
  relay = new ToolRelay({ log: (level, msg, data) => console.log(`      relay ${level}: ${msg}${data ? ` ${brief(data)}` : ''}`) });
  // Every link the relay hands out, so a helper saying hello can be seen from here.
  const links = [];
  const connect = relay.connect.bind(relay);
  relay.connect = async (o) => {
    const call = (tool, args, meta) => { relayed.push({ tool: tool.name, callId: meta.callId }); return o.call(tool, args, meta); };
    const link = await connect({ ...o, call });
    if (link) links.push(link);
    return link;
  };
  const helloFrom = (link, label) => until(() => link.sockets.size > 0, 20000, label).then(() => true, () => false);

  // ---------- free: a new chat, and the tools as Codex has them ----------
  section('A new chat gets Canopy\'s tools (no model call)');
  const look = screen();
  const tap = tapped();
  const logs = [];
  const s = new CodexSession({ cwd: scratch, codexPath, env, spawnFn: tap.spawnFn, tools: relay, look, otherChats, ...bare, log: (level, msg, data) => logs.push({ level, msg, data }) });
  sessions.add(s);
  const w = watch(s);
  const warmed = await s.warm();
  if (!check('warm() starts the process and opens the chat', warmed.ok === true, warmed.ok ? `${warmed.startupMs} ms` : `${warmed.code}: ${warmed.message}`)) return;
  const start = tap.seen.opens.find((o) => o.method === 'thread/start')?.params;
  const server = start?.config?.[KEY];
  const token = server?.env?.CANOPY_TOOLS_TOKEN ?? '';
  check('the thread is opened with Canopy\'s server under one dotted key', !!server && Object.keys(start.config).join() === KEY && server.default_tools_approval_mode === 'approve', brief({ keys: Object.keys(start?.config ?? {}), command: path.basename(server?.command ?? ''), approval: server?.default_tools_approval_mode, toolTimeout: server?.tool_timeout_sec }));
  check('the token is in the server\'s environment and never on Codex\'s command line', /^[0-9a-f]{64}$/.test(token) && !JSON.stringify(tap.seen.args).includes(token) && !server.args.join(' ').includes(token));
  check('the socket is in a folder of its own that only this user can open', (fs.statSync(path.dirname(relay.socketPath)).mode & 0o777) === 0o700 && fs.statSync(relay.socketPath).isSocket(), relay.socketPath);
  check('Codex starts the helper, and the helper says hello with that token', await helloFrom(links[0], 'the helper to say hello'), `${links[0].sockets.size} connection`);
  const proc = s.q;
  const threadId = s.threadId;
  let listed = null;
  let why = '';
  try { listed = await proc.request('mcpServerStatus/list', { threadId, serverName: CANOPY_SERVER, detail: 'toolsAndAuthOnly' }, { timeoutMs: 20000 }); } catch (err) { why = String(err?.message ?? err); }
  const row = listed?.data?.find((d) => d.name === CANOPY_SERVER) ?? null;
  const tools = row?.tools ?? {};
  check('Codex lists the four tools on it', !!row && Object.keys(tools).sort().join() === ALL, why || brief({ servers: listed?.data?.map((d) => d.name), tools: Object.keys(tools), error: row?.toolsError ?? null }));
  check('each as the registry defines it: look in full, read_chat in its short wording', tools.look?.description === mcpTool(LOOK).description && tools.read_chat?.description === mcpTool(READ_CHAT).description
    && JSON.stringify(Object.keys(tools.look?.inputSchema?.properties ?? {})) === JSON.stringify(Object.keys(LOOK.params)), `${tools.look?.description?.length ?? 0} and ${tools.read_chat?.description?.length ?? 0} characters`);
  check('show_widget and read_me in full, read_me\'s modules a list of words', tools.show_widget?.description === mcpTool(SHOW_WIDGET).description && tools.read_me?.description === mcpTool(READ_ME).description
    && tools.read_me?.inputSchema?.properties?.modules?.type === 'array' && Array.isArray(tools.read_me?.inputSchema?.properties?.modules?.items?.enum), brief(tools.read_me?.inputSchema?.properties?.modules));
  check('the user\'s own MCP servers stayed off: the dotted key did not undo this process\'s settings', (await s.mcpStatus()).length === 0, `${bare.off.length} switched off by name: ${bare.off.join(', ') || 'none'}; listed now: ${(await s.mcpStatus()).map((r) => r.name).join(', ') || 'none'}`);

  // Codex calling the tools itself, on the thread's own connection: the whole way there and back, with no model.
  const callTool = async (tool, args) => { try { return await proc.request('mcpServer/tool/call', { threadId, server: CANOPY_SERVER, tool, arguments: args }, { timeoutMs: 30000 }); } catch (err) { return { failed: String(err?.message ?? err) }; } };
  const local = await callTool('look', { url: LOCAL, width: 390 });
  const pic = picturesOf(local)[0];
  check('a look at localhost comes back through Codex as a picture and a caption, with nobody asked', !local.failed && !local.isError && pic?.mimeType === 'image/png' && Buffer.from(pic.data, 'base64').equals(png(SIDE, COLOURS[LOCAL][1])) && textOf(local).startsWith(`${LOCAL} at 390×800`) && !w.events.some((e) => e.kind === 'permission'),
    local.failed ?? brief({ blocks: local.content?.map((b) => b.type), caption: textOf(local).slice(0, 80) }));
  const mark = w.events.length;
  const web = callTool('look', { url: WEB });
  let card = null;
  try { card = await w.waitFor((e) => e.kind === 'permission', { ms: 15000, from: mark, label: 'the card' }); } catch { /* reported below */ }
  check('a look out on the web raises Canopy\'s own card, and waits', card?.type === 'tool' && card.toolName === LOOK_TOOL && card.input?.url === WEB && card.alwaysForChat === true && card.engine === 'codex' && !look.pages.includes(WEB), brief({ type: card?.type, toolName: card?.toolName, input: card?.input }));
  if (card) s.respond(card.id, { action: 'deny' });
  const refused = await web;
  check('a no reaches Codex as a tool result that says so, and nothing was opened', refused.isError === true && /The user said no to this look call/.test(textOf(refused)) && !look.pages.includes(WEB), refused.failed ?? textOf(refused).slice(0, 90));
  const chatList = await callTool('read_chat', {});
  check('read_chat lists the other chat, with nobody asked', !chatList.failed && !chatList.isError && textOf(chatList).includes(`Plan the ${FRUIT} launch`) && w.events.filter((e) => e.kind === 'permission').length === 1, chatList.failed ?? textOf(chatList).split('\n')[0]);
  // Codex writes a chat to disk at its first turn, and none was made: the file it named for it is not there.
  const rollout = tap.seen.answers[0]?.thread?.path ?? null;
  check('nothing was saved for this chat', s.sessionId === null && (!rollout || !fs.existsSync(rollout)), `no turn was made; its file was ${rollout ? 'named but never written' : 'not named'}`);
  const pid = s.pid;
  await s.dispose({ graceMs: 2000 });
  sessions.delete(s);
  await until(() => links[0].sockets.size === 0, 5000, 'the helper to go').catch(() => {});
  check('when the chat is closed its helper goes, and its token opens nothing', links[0].closed === true && links[0].sockets.size === 0 && relay.linkOf(token) === null, `pid ${pid}`);
  const noted = logs.filter((l) => l.level === 'warn' || l.level === 'error');
  check('nothing went wrong on the way', noted.length === 0, noted.length ? brief(noted[0]) : '');

  if (!TURNS) { console.log('\nNo live turn was made. Pass --live for one turn in a chat Codex never saves, --reopen for one in a chat that is saved and then archived.'); return; }

  // ---------- live ----------
  section('Live turns');
  service = new CodexService({ codexPath, env, config: { notify: [] }, appVersion: '0.0.1' });
  const offered = await service.models();
  const models = offered.ok ? offered.models : [];
  const cheap = MODEL ? models.find((m) => m.value === MODEL) : models.find((m) => /luna|mini|nano|affordable/i.test(`${m.value} ${m.description}`));
  const effort = cheap ? ['low', 'minimal', 'none', 'medium'].find((e) => cheap.supportedEffortLevels?.includes(e)) ?? cheap.supportedEffortLevels?.[0] : undefined;
  if (!check('a cheap model to test with', !!cheap, cheap ? `${cheap.value}, effort ${effort}, standard tier` : MODEL ? `Codex does not offer "${MODEL}"` : 'none of the models says luna, mini, nano or affordable: name one with --model')) return;
  const choices = { model: cheap.value, effort, fast: false, permissionMode: 'default' };
  // The tools Codex has on a thread's own connection, by name.
  const toolsOn = async (session, id) => (await session.q.request('mcpServerStatus/list', { threadId: id, serverName: CANOPY_SERVER, detail: 'toolsAndAuthOnly' }, { timeoutMs: 20000 }).catch(() => null))?.data?.find((d) => d.name === CANOPY_SERVER)?.tools ?? {};

  if (LIVE) await modelUsesThem({ codexPath, env, choices, bare });
  else skip('the model looks, and reads another chat', 'pass --live: one turn in a chat Codex never saves');
  if (WIDGET) await modelDraws({ codexPath, env, choices, bare });
  else skip('the model draws a widget', 'pass --widget: one turn in a chat Codex never saves');
  if (REOPEN) await reopened({ codexPath, env, choices, bare, links, helloFrom, toolsOn });
  else skip('the tools come back when a saved chat is reopened', 'pass --reopen: it needs one chat that is saved (and then archived)');
}

// One turn in a chat Codex never saves: the model looks at two pages and reads another chat, and says what it saw.
async function modelUsesThem({ codexPath, env, choices, bare }) {
  section('The model looks, and reads another chat (a chat Codex never saves)');
  const liveLook = screen();
  const liveTap = tapped({ ephemeral: true });
  const live = new CodexSession({ cwd: scratch, codexPath, env, spawnFn: liveTap.spawnFn, tools: relay, look: liveLook, otherChats, ...choices, ...bare });
  sessions.add(live);
  const lw = watch(live);
  // Its card is answered as a user would: Allow.
  const cards = [];
  live.on('event', (ev) => { if (ev.kind === 'permission') { cards.push(ev); setTimeout(() => live.respond(ev.id, { action: 'allow' }), 300); } });
  spend('tools');
  live.send(`Use your tools in this order, each exactly once: (1) look with url ${LOCAL} (2) look with url ${WEB} (3) read_chat with no arguments. `
    + 'Then reply with exactly three words separated by spaces: the colour that fills the first picture, the colour that fills the second picture, and the fruit named in the other chat\'s title.');
  await lw.waitFor((e) => e.kind === 'busy' && e.busy === false, { label: 'the turn to end' });
  const opened = liveTap.seen.answers[0]?.thread;
  check('the turn ran in a thread Codex does not save', opened?.ephemeral === true && !opened.path, brief({ ephemeral: opened?.ephemeral, path: opened?.path ?? null }));
  const end = lw.events.find((e) => e.kind === 'turn-end');
  check('the turn ended well', end?.subtype === 'success' && end.isError === false, brief({ subtype: end?.subtype, errors: end?.errors }));
  tokens.push(['tools', end?.turnUsage ?? null]);
  const rows = lw.events.filter((e) => e.kind === 'tool-start');
  const looks = rows.filter((e) => e.name === LOOK_TOOL);
  check('the rows are named as a Claude chat\'s are: two looks, one read of another chat', looks.length === 2 && rows.filter((e) => e.name === READ_CHAT_TOOL).length === 1, rows.map((e) => e.name).join(', '));
  const outcomes = lw.events.filter((e) => e.kind === 'tool-result' && looks.some((l) => l.id === e.id));
  check('each look\'s result carries its picture to the window', outcomes.length === 2 && outcomes.every((e) => !e.isError && e.images?.length === 1 && e.images[0].mediaType === 'image/png'), brief(outcomes.map((e) => ({ isError: e.isError, images: e.images?.length, text: String(e.content ?? '').slice(0, 60) }))));
  check('only the look out on the web was asked about, on Canopy\'s card, tied to its row', cards.length === 1 && cards[0].toolName === LOOK_TOOL && cards[0].input?.url === WEB && looks.some((l) => l.id === cards[0].toolUseId), brief(cards.map((c) => ({ toolName: c.toolName, input: c.input, toolUseId: c.toolUseId }))));
  check('both pages were rendered, in order, once the web one was allowed', JSON.stringify(liveLook.pages) === JSON.stringify([LOCAL, WEB]), liveLook.pages.join(', '));
  const reply = lw.events.filter((e) => e.kind === 'assistant-text').at(-1)?.text ?? '';
  const said = reply.toLowerCase();
  check('the model saw both pictures and read the other chat: red, blue, papaya', said.includes('red') && said.includes('blue') && said.includes('papaya'), brief(reply));
  const errors = lw.events.filter((e) => e.kind === 'error' || (e.kind === 'notice' && e.level === 'error') || (e.kind === 'raw' && e.label === 'adapter-error'));
  check('no error, and nothing the adapter did not know', errors.length === 0, errors.length ? brief(errors[0]) : '');
  await live.dispose({ graceMs: 2500 });
  sessions.delete(live);
}

// One turn in a chat Codex never saves, asked the way a user would: the model should draw the comparison, and the
// window's report on it (here, from this script) reaches the call by the id of the row the window draws it in.
async function modelDraws({ codexPath, env, choices, bare }) {
  section('The model draws a widget (a chat Codex never saves)');
  const tap = tapped({ ephemeral: true });
  const asked = [];
  const widgetReport = (id) => { asked.push(id); return Promise.resolve({ errors: [] }); };
  const chat = new CodexSession({ cwd: scratch, codexPath, env, spawnFn: tap.spawnFn, tools: relay, look: screen(), otherChats, widgetReport, ...choices, ...bare });
  sessions.add(chat);
  const cw = watch(chat);
  spend('widget');
  chat.send('compare zod, valibot and arktype in cards I can pick from');
  await cw.waitFor((e) => e.kind === 'busy' && e.busy === false, { label: 'the turn to end' });
  const end = cw.events.find((e) => e.kind === 'turn-end');
  check('the turn ended well', end?.subtype === 'success' && end.isError === false, brief({ subtype: end?.subtype, errors: end?.errors }));
  tokens.push(['widget', end?.turnUsage ?? null]);
  const rows = cw.events.filter((e) => e.kind === 'tool-start');
  const drawn = rows.filter((e) => e.name === SHOW_TOOL);
  console.log(`      reply: ${brief(cw.events.filter((e) => e.kind === 'assistant-text').at(-1)?.text ?? '')}`);
  check('the model called show_widget, and the row is named as a Claude chat\'s is', drawn.length >= 1, rows.map((e) => e.name).join(', ') || 'no tool rows');
  const html = drawn[0]?.input?.widget_code;
  check('the row carries the whole widget as it appears', typeof html === 'string' && html.length > 0, typeof html === 'string' ? `${html.length} characters; ${(html.match(/<canopy-[a-z-]+/g) ?? []).slice(0, 6).join(' ')}` : 'no widget_code');
  const result = cw.events.find((e) => e.kind === 'tool-result' && e.id === drawn[0]?.id);
  check('its result is what show_widget says back', !!result && !result.isError && /^Shown to the user in Canopy/.test(String(result.content ?? '')), brief(String(result?.content ?? '').slice(0, 120)));
  const theirs = relayed.filter((r) => r.tool === 'show_widget');
  check('the call reaches Canopy under the id of the row the window draws it in', drawn.length > 0 && drawn.every((e) => theirs.some((r) => r.callId === e.id)), brief({ rows: drawn.map((e) => e.id), relayed: theirs }));
  const scripted = drawn.filter((e) => /<script\b/i.test(String(e.input?.widget_code ?? '')));
  if (scripted.length) check('the window\'s report is asked for by the row\'s own id', scripted.every((e) => asked.includes(e.id)), brief({ rows: scripted.map((e) => e.id), asked }));
  else skip('the window\'s report is asked for by the row\'s own id', `no widget had a script; asked: ${brief(asked)}`);
  const errors = cw.events.filter((e) => e.kind === 'error' || (e.kind === 'notice' && e.level === 'error') || (e.kind === 'raw' && e.label === 'adapter-error'));
  check('no error, and nothing the adapter did not know', errors.length === 0, errors.length ? brief(errors[0]) : '');
  await chat.dispose({ graceMs: 2500 });
  sessions.delete(chat);
}

// One turn (one look) in a chat that is saved, which is then closed and opened again: the tools are back, word for
// word, and the look's picture is still in the chat's history.
async function reopened({ codexPath, env, choices, bare, links, helloFrom, toolsOn }) {
  section('A saved chat keeps its tools, and its look, when it is reopened');
  const firstTap = tapped();
  const first = new CodexSession({ cwd: scratch, codexPath, env, spawnFn: firstTap.spawnFn, tools: relay, look: screen(), otherChats, ...choices, ...bare });
  sessions.add(first);
  const fw = watch(first);
  first.on('event', (ev) => { if ((ev.kind === 'init' || ev.kind === 'meta') && typeof ev.sessionId === 'string') saved.add(ev.sessionId); });
  spend('reopen');
  first.send(`Call the look tool exactly once, with url ${LOCAL}. Then reply with exactly: OK`);
  await fw.waitFor((e) => e.kind === 'busy' && e.busy === false, { label: 'the turn to end' });
  const id = first.sessionId;
  const firstEnd = fw.events.find((e) => e.kind === 'turn-end');
  tokens.push(['reopen', firstEnd?.turnUsage ?? null]);
  const lookRow = fw.events.find((e) => e.kind === 'tool-start' && e.name === LOOK_TOOL);
  check('a turn with one look, in a chat that is saved, ends well', typeof id === 'string' && firstEnd?.subtype === 'success' && !!lookRow, brief({ id, subtype: firstEnd?.subtype, rows: fw.events.filter((e) => e.kind === 'tool-start').map((e) => e.name) }));
  const toolsBefore = await toolsOn(first, id);
  await first.dispose({ graceMs: 2500 });
  sessions.delete(first);

  const againTap = tapped();
  const again = new CodexSession({ cwd: scratch, codexPath, env, spawnFn: againTap.spawnFn, tools: relay, look: screen(), otherChats, resume: id, ...choices, ...bare });
  sessions.add(again);
  const rewarmed = await again.warm();
  const resume = againTap.seen.opens.find((o) => o.method === 'thread/resume')?.params;
  check('the reopened chat is resumed with Canopy\'s server, under a token of its own', rewarmed.ok === true && resume?.threadId === id && !!resume?.config?.[KEY] && resume.config[KEY].env.CANOPY_TOOLS_TOKEN !== firstTap.seen.opens[0].params.config[KEY].env.CANOPY_TOOLS_TOKEN, rewarmed.ok ? `${rewarmed.startupMs} ms` : `${rewarmed.code}: ${rewarmed.message}`);
  check('Codex starts the helper again for it', await helloFrom(links.at(-1), 'the helper of the reopened chat to say hello'));
  const toolsAfter = await toolsOn(again, id);
  // Codex hands the tools over as a map, in no order of its own: they are compared by name.
  const same = Object.keys(toolsAfter).sort().join() === ALL && Object.keys(toolsAfter).every((name) => JSON.stringify(toolsAfter[name]) === JSON.stringify(toolsBefore[name]));
  check('and it has the same tools, word for word', same, Object.keys(toolsAfter).sort().join(', '));
  const history = await again.history();
  const past = history.ok ? history.events : [];
  const pastLook = past.find((e) => e.kind === 'tool-start' && e.name === LOOK_TOOL);
  const pastShot = past.find((e) => e.kind === 'tool-result' && e.id === pastLook?.id);
  check('its history has the look, under the same name, with its picture', !!pastLook && pastLook.id === lookRow?.id && pastShot?.images?.length === 1 && Buffer.from(pastShot.images[0].data, 'base64').equals(png(SIDE, COLOURS[LOCAL][1])),
    history.ok ? brief({ row: pastLook?.name, images: pastShot?.images?.length, text: String(pastShot?.content ?? '').slice(0, 50) }) : history.message);
  const relook = await again.q.request('mcpServer/tool/call', { threadId: id, server: CANOPY_SERVER, tool: 'look', arguments: { url: LOCAL } }, { timeoutMs: 30000 }).catch((err) => ({ failed: String(err?.message ?? err) }));
  check('a look works in the reopened chat', !relook.failed && !relook.isError && picturesOf(relook).length === 1, relook.failed ?? textOf(relook).slice(0, 60));
  await again.dispose({ graceMs: 2500 });
  sessions.delete(again);
}

// Everything this run started is ended, and the one chat it may have saved is archived, whatever happened above.
async function tidy() {
  section('Tidying up');
  for (const s of sessions) { try { await s.dispose({ graceMs: 1500 }); } catch { /* it is gone either way */ } }
  sessions.clear();
  if (saved.size) {
    service ??= new CodexService({ codexPath: await findCodex({ ...process.env }), env: codexEnv(process.env), config: { notify: [] }, appVersion: '0.0.1' });
    const left = [];
    for (const id of saved) { const r = await service.archive(id); if (!r.ok) left.push(`${id}: ${r.message}`); }
    check(`the ${saved.size === 1 ? 'saved test chat is' : `${saved.size} saved test chats are`} archived`, left.length === 0, left.length ? left.join('; ') : [...saved].join(', '));
  }
  if (service) { await service.close({ graceMs: 1500 }); service = null; }
  if (relay) {
    const dir = relay.socketPath ? path.dirname(relay.socketPath) : null;
    await relay.close();
    if (dir) check('the relay\'s socket and its folder are gone', !fs.existsSync(dir), dir);
  }
  if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* /tmp is cleared anyway */ } }
}

let crashed = null;
try { await main(); } catch (err) { crashed = err; }
try { await tidy(); } catch (err) { crashed ??= err; }
if (crashed) report('FAIL', 'the run finished', String(crashed?.stack ?? crashed).split('\n').slice(0, 3).join(' | '));

const used = tokens.filter(([, u]) => u);
console.log(`\nLive turns made: ${TURNS - turnsLeft}.${used.length ? ` Tokens: ${used.map(([name, u]) => `${name} ${brief(u)}`).join('; ')}` : ''}`);
const failed = results.filter((r) => r.state === 'FAIL');
console.log(`${results.filter((r) => r.state === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.state === 'SKIP').length} skipped.`);
process.exit(failed.length ? 1 : 0);

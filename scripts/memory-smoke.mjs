// The memory smoke check: Canopy Memory in a real Codex chat, with no window. Canopy's real session, relay, helper
// and memory store against the real `codex` on this Mac. Run by hand, never by `npm test`.
//
//   node scripts/memory-smoke.mjs            the free part: a note "a Claude chat saved" is in what the thread is
//                                            opened with, Codex lists remember, recall and forget, and calls each
//                                            itself. No model call, costs nothing
//   node scripts/memory-smoke.mjs --live     plus TWO small live turns in a chat Codex never saves: the model is
//                                            asked something only the note answers, then told a preference, which it
//                                            should save without being asked
//   --model <id>     default: the first model whose id or description says luna, mini, nano or affordable
//
// Contract (the same as scripts/codex-tools-smoke.mjs, which this borrows its set-up from):
//  - Live turns cost real money on the user's own Codex login, so each is small, at the lowest effort the model has,
//    on the standard tier, on the cheapest model. Never more than two, and none without a cheap model to run them on.
//  - Nothing under ~/.codex is written by this script, and none of the user's chats is listed, read or changed. The
//    live turns run in a thread Codex never saves (`ephemeral`).
//  - Every process gets the recorder's set-up: no notify program, Codex's own memories off, and the user's plugins,
//    apps and MCP servers off.
//  - The memory is a folder made here under /tmp, and the bridge to Claude Code's own notes is off: the user's real
//    Canopy memory, ~/.claude and ~/.codex/memories are never read.
//  - One line per check, PASS, FAIL or SKIP. Exit code 1 when anything failed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CodexSession } from '../src/core/codex-session.mjs';
import { CodexService, codexEnv, codexVersion, findCodex } from '../src/core/codex-host.mjs';
import { CANOPY_FACTS_NEUTRAL } from '../src/core/facts.mjs';
import { canopyMemoryNote } from '../src/core/memory.mjs';
import { MemoryStore } from '../src/core/memory-store.mjs';
import { FORGET, FORGET_TOOL, FORGOT_RE, saidByUser, RECALL, RECALL_TOOL, REMEMBER, REMEMBER_TOOL, SAVED_RE } from '../src/core/memory-tools.mjs';
import { ToolRelay } from '../src/core/tool-relay.mjs';
import { CANOPY_SERVER, mcpTool } from '../src/core/tool-registry.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i === -1) return false; argv.splice(i, 1); return true; };
const option = (name) => { const i = argv.indexOf(name); if (i === -1) return null; const [, v] = argv.splice(i, 2); return v ?? null; };
const LIVE = flag('--live');
const MODEL = option('--model');
if (argv.length) { console.error(`unknown argument: ${argv.join(' ')}`); process.exit(2); }

const TURN_MS = 180_000;
const KEY = `mcp_servers.${CANOPY_SERVER}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function report(state, name, detail) { results.push({ state, name }); console.log(`${state}  ${name}${detail ? `  (${detail})` : ''}`); }
const check = (name, ok, detail) => { report(ok ? 'PASS' : 'FAIL', name, detail); return !!ok; };
const skip = (name, why) => report('SKIP', name, why);
const section = (title) => console.log(`\n${title}`);
const brief = (v) => { try { return JSON.stringify(v).slice(0, 240); } catch { return String(v); } };
const until = async (cond, ms, label) => { const end = Date.now() + ms; while (!(await cond())) { if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${label}`); await sleep(25); } };
const textOf = (result) => (Array.isArray(result?.content) ? result.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');

let turnsLeft = LIVE ? 2 : 0;
function spend(what) { if (turnsLeft <= 0) throw new Error(`refusing to start another live turn (${what}): the cap for this run is used up`); turnsLeft -= 1; }

const sessions = new Set();
let relay = null;
let service = null;
let scratch = null;
const tokens = [];

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
  for (const s of Array.isArray(servers) ? servers : []) if (s?.enabled && /^[A-Za-z0-9_-]+$/.test(s.name ?? '')) config[`mcp_servers.${s.name}.enabled`] = false;
  return { config, flags };
}

// A spawn that keeps each thread/start as it crossed the pipe, and, with `ephemeral`, asks Codex never to save the thread.
function tapped({ ephemeral = false } = {}) {
  const seen = { opens: [], answers: [] };
  const spawnFn = (cmd, args, opts) => {
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
        if (text.includes('"thread/start"')) {
          const m = JSON.parse(text);
          if (m.method === 'thread/start') {
            if (ephemeral) { m.params.ephemeral = true; out = `${JSON.stringify(m)}\n`; }
            seen.opens.push(m.params);
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

async function main() {
  const env = codexEnv(process.env);
  section('Codex on this Mac');
  const codexPath = await findCodex({ ...process.env });
  if (!check('codex is found', !!codexPath, codexPath ?? 'not on PATH')) return;
  check('codex says its version', !!(await codexVersion(codexPath, process.env)));

  scratch = fs.realpathSync(fs.mkdtempSync('/tmp/canopy-memory-smoke-'));
  const work = path.join(scratch, 'shop');
  fs.mkdirSync(path.join(work, '.git'), { recursive: true }); // a project of its own, so a project note has somewhere to belong
  fs.writeFileSync(path.join(work, 'README.md'), '# shop\n');
  const memory = new MemoryStore({ dir: path.join(scratch, 'memory') });
  // What a Claude chat in this project saved earlier: the fact a Codex chat should start out knowing.
  const fromClaude = memory.save({ title: 'Package manager', text: 'Uses pnpm, not npm. The everyday test command is pnpm test:unit; never run pnpm test, it hits staging.', scope: 'project', project: work, source: 'user-said', engine: 'claude', chat: 'a-claude-chat' }).note;
  const bare = bareSetup(codexPath, env);
  relay = new ToolRelay({ log: (level, msg, data) => console.log(`      relay ${level}: ${msg}${data ? ` ${brief(data)}` : ''}`) });

  // ---------- free: the note and the tools, as Codex has them ----------
  section('A new Codex chat starts out with the note and the two tools (no model call)');
  const tap = tapped();
  const logs = [];
  const s = new CodexSession({ cwd: work, codexPath, env, spawnFn: tap.spawnFn, tools: relay, memory, memoryBridge: false, ...bare, log: (level, msg, data) => logs.push({ level, msg, data }) });
  sessions.add(s);
  const w = watch(s);
  const warmed = await s.warm();
  if (!check('warm() starts the process and opens the chat', warmed.ok === true, warmed.ok ? `${warmed.startupMs} ms` : `${warmed.code}: ${warmed.message}`)) return;
  const start = tap.seen.opens[0];
  const index = canopyMemoryNote({ store: memory, cwd: work, recallName: `mcp__${CANOPY_SERVER}__recall`, forgetName: `mcp__${CANOPY_SERVER}__forget` });
  check('the thread is opened with the facts and then the note a Claude chat saved', start?.developerInstructions?.endsWith(`${CANOPY_FACTS_NEUTRAL}\n\n${index}`) && index.includes('- Package manager: Uses pnpm, not npm.'), `${index.length} characters of memory`);
  check('nothing of Claude Code\'s own notes or the user\'s real memory is in it', !/Claude Code memory|\.claude\//.test(start?.developerInstructions ?? ''));
  const proc = s.q;
  const threadId = s.threadId;
  let listed = null;
  let why = '';
  try { listed = await proc.request('mcpServerStatus/list', { threadId, serverName: CANOPY_SERVER, detail: 'toolsAndAuthOnly' }, { timeoutMs: 20000 }); } catch (err) { why = String(err?.message ?? err); }
  const tools = listed?.data?.find((d) => d.name === CANOPY_SERVER)?.tools ?? {};
  check('Codex lists remember, recall and forget beside read_chat', Object.keys(tools).sort().join() === 'forget,read_chat,recall,remember', why || Object.keys(tools).join(', '));
  check('each as the registry defines it: remember in its short wording, with note and scope required', tools.remember?.description === mcpTool(REMEMBER).description && tools.recall?.description === mcpTool(RECALL).description
    && tools.forget?.description === mcpTool(FORGET).description && JSON.stringify(tools.remember?.inputSchema?.required) === '["note","scope"]' && JSON.stringify(tools.forget?.inputSchema?.required) === '["note"]',
  `${tools.remember?.description?.length ?? 0}, ${tools.recall?.description?.length ?? 0} and ${tools.forget?.description?.length ?? 0} characters`);

  const callTool = async (tool, args) => { try { return await proc.request('mcpServer/tool/call', { threadId, server: CANOPY_SERVER, tool, arguments: args }, { timeoutMs: 30000 }); } catch (err) { return { failed: String(err?.message ?? err) }; } };
  const read = await callTool('recall', { query: 'package manager' });
  check('recall, called by Codex, returns the Claude chat\'s note in full', !read.failed && !read.isError && textOf(read).includes(fromClaude.text) && /this project · the user said it/.test(textOf(read)), read.failed ?? textOf(read).split('\n')[0]);
  const saved = await callTool('remember', { note: 'Deploys go out with make ship, never by hand.', title: 'Deploys', scope: 'project', source: 'user-said' });
  const id = SAVED_RE.exec(textOf(saved))?.[2];
  const kept = id ? memory.get(id) : null;
  check('remember, called by Codex, writes a note file that says a Codex chat saved it', !!kept && kept.engine === 'codex' && kept.project === work && fs.existsSync(path.join(memory.dir, `${id}.md`)), saved.failed ?? textOf(saved));
  const secret = await callTool('remember', { note: 'The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789', scope: 'me' });
  check('a note that looks like a credential is refused through Codex too', secret.isError === true && /never keeps secrets/.test(textOf(secret)) && memory.all().length === 2, secret.failed ?? textOf(secret).slice(0, 80));
  // A fact that changed takes the old note's place, and a note that is wrong is taken out: both through Codex.
  const day = SAVED_RE.exec(textOf(await callTool('remember', { note: 'Releases are cut on Fridays only.', title: 'Release day', scope: 'project', source: 'model-noticed' })))?.[2];
  const moved = await callTool('remember', { note: 'Releases are cut on Mondays now.', scope: 'project', source: 'model-noticed', replaces: 'Release day' });
  check('remember with `replaces`, called by Codex, puts the new fact in the old note\'s place and records what it said', SAVED_RE.exec(textOf(moved))?.[2] === day && memory.get(day)?.replaced === 'Releases are cut on Fridays only.' && memory.all().length === 3, moved.failed ?? textOf(moved).slice(0, 120));
  const gone = await callTool('forget', { note: 'Release day' });
  check('forget, called by Codex, takes that note out and leaves it restorable', FORGOT_RE.exec(textOf(gone))?.[1] === day && memory.all().length === 2 && memory.state(day).removed === true, gone.failed ?? textOf(gone).slice(0, 120));
  check('nobody was asked about any of it', w.events.filter((e) => e.kind === 'permission').length === 0);
  // The note Codex saved is what a Claude chat opened next would be told.
  check('a Claude chat opened next would start out knowing what Codex saved', canopyMemoryNote({ store: memory, cwd: work }).includes('- Deploys go out with make ship, never by hand.'));
  check('nothing was saved for this chat', s.sessionId === null, 'no turn was made');
  await s.dispose({ graceMs: 2000 });
  sessions.delete(s);
  const noted = logs.filter((l) => l.level === 'warn' || l.level === 'error');
  check('nothing went wrong on the way', noted.length === 0, noted.length ? brief(noted[0]) : '');

  if (!LIVE) { console.log('\nNo live turn was made. Pass --live for two small turns in a chat Codex never saves.'); return; }

  // ---------- live ----------
  section('Live: the model uses the note, then saves one of its own (a chat Codex never saves)');
  service = new CodexService({ codexPath, env, config: { notify: [] }, appVersion: '0.0.1' });
  const offered = await service.models();
  const models = offered.ok ? offered.models : [];
  const cheap = MODEL ? models.find((m) => m.value === MODEL) : models.find((m) => /luna|mini|nano|affordable/i.test(`${m.value} ${m.description}`));
  const effort = cheap ? ['low', 'minimal', 'none', 'medium'].find((e) => cheap.supportedEffortLevels?.includes(e)) ?? cheap.supportedEffortLevels?.[0] : undefined;
  if (!check('a cheap model to test with', !!cheap, cheap ? `${cheap.value}, effort ${effort}, standard tier` : MODEL ? `Codex does not offer "${MODEL}"` : 'none of the models says luna, mini, nano or affordable: name one with --model')) return;
  const liveTap = tapped({ ephemeral: true });
  const live = new CodexSession({ cwd: work, codexPath, env, spawnFn: liveTap.spawnFn, tools: relay, memory, memoryBridge: false, model: cheap.value, effort, fast: false, permissionMode: 'default', ...bare });
  sessions.add(live);
  const lw = watch(live);
  const cards = [];
  live.on('event', (ev) => { if (ev.kind === 'permission') { cards.push(ev); setTimeout(() => live.respond(ev.id, { action: 'deny' }), 200); } });
  const turn = async (what, text) => {
    spend(what);
    const from = lw.events.length;
    live.send(text);
    await lw.waitFor((e) => e.kind === 'busy' && e.busy === false, { from, label: `the ${what} turn to end` });
    const end = lw.events.slice(from).find((e) => e.kind === 'turn-end');
    tokens.push([what, end?.turnUsage ?? null]);
    return { end, events: lw.events.slice(from), reply: lw.events.slice(from).filter((e) => e.kind === 'assistant-text').map((e) => e.text).join('\n') };
  };

  // Nothing in the folder says pnpm: only the note does.
  const one = await turn('use', 'Without running anything: which command should I use to run the tests in this project, and which should I avoid? One line.');
  const opened = liveTap.seen.answers[0]?.thread;
  check('the turn ran in a thread Codex does not save', opened?.ephemeral === true && !opened.path, brief({ ephemeral: opened?.ephemeral, path: opened?.path ?? null }));
  check('the turn ended well', one.end?.subtype === 'success' && one.end.isError === false, brief({ subtype: one.end?.subtype, errors: one.end?.errors }));
  check('the model answers from the note a Claude chat saved: pnpm test:unit, not pnpm test', /pnpm test:unit/.test(one.reply) && /staging|pnpm test\b/.test(one.reply), brief(one.reply));

  const before = memory.all().length;
  const two = await turn('save', 'One more thing for every project of mine: write commit messages in the imperative mood, with no trailing period. That is all for now, no need to do anything else.');
  const rows = two.events.filter((e) => e.kind === 'tool-start');
  check('told a lasting preference, the model saves it without being asked', rows.some((e) => e.name === REMEMBER_TOOL) && memory.all().length > before, `tools: ${rows.map((e) => e.name).join(', ') || 'none'}; reply: ${brief(two.reply)}`);
  const mine = memory.all().filter((n) => n.engine === 'codex' && /imperative/i.test(n.text));
  check('the note is about the user, says they said it, and is drawn in the window as a Claude chat\'s save is', mine.length === 1 && mine[0].scope === 'me' && mine[0].source === 'user-said' && !rows.some((e) => e.name === `mcp__${CANOPY_SERVER}__remember`), brief(mine.map((n) => ({ scope: n.scope, source: n.source, text: n.text }))));
  check('no card was raised for a save, a look-up or a removal', cards.filter((c) => c.toolName === REMEMBER_TOOL || c.toolName === RECALL_TOOL || c.toolName === FORGET_TOOL).length === 0, `${cards.length} cards in all`);
  // The note is the user's own words: the chat kept what they wrote, and remember checked the note against it.
  check('the chat heard both messages, and the note holds nothing the user did not write', live.heard.length === 2 && mine.length === 1 && saidByUser(mine[0].text, live.heard).added.length === 0, brief({ heard: live.heard.length, note: mine[0]?.text }));
  const errors = lw.events.filter((e) => e.kind === 'error' || (e.kind === 'notice' && e.level === 'error') || (e.kind === 'raw' && e.label === 'adapter-error'));
  check('no error, and nothing the adapter did not know', errors.length === 0, errors.length ? brief(errors[0]) : '');
  await live.dispose({ graceMs: 2500 });
  sessions.delete(live);
}

let crashed = null;
try { await main(); } catch (err) { crashed = err; }
for (const s of sessions) { try { await s.dispose({ graceMs: 2000 }); } catch { /* best effort */ } }
try { await service?.close?.(); } catch { /* best effort */ }
try { await relay?.close(); } catch { /* best effort */ }
if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
if (crashed) { console.error(`\nstopped: ${crashed?.stack ?? crashed}`); }
if (tokens.length) console.log(`\ntokens: ${tokens.map(([what, u]) => `${what} ${u ? `${(u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0)} in, ${u.outputTokens ?? 0} out` : 'not reported'}`).join('; ')}`);
const failed = results.filter((r) => r.state === 'FAIL').length;
console.log(`\n${results.filter((r) => r.state === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.state === 'SKIP').length} skipped`);
process.exit(failed || crashed ? 1 : 0);

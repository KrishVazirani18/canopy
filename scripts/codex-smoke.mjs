// The Codex smoke check: Canopy's real Codex session, helper and chat list against the real `codex` on this Mac,
// with no window. Run by hand, never by `npm test`.
//
//   node scripts/codex-smoke.mjs                  the free part only: no model call, costs nothing
//   node scripts/codex-smoke.mjs --live           plus ONE tiny live turn ("Reply with exactly: OK"), then reopening it
//   node scripts/codex-smoke.mjs --live --approval    plus an approval turn, answered Allow (two live turns)
//   node scripts/codex-smoke.mjs --live --all     plus an approval turn and a stopped turn (three live turns)
//   node scripts/codex-smoke.mjs --live --as-product    plus one turn with exactly the app's flags (see below)
//   node scripts/codex-smoke.mjs --live --edit     plus edit and resend, in a chat of its own: an edit while idle, a
//                                                  message steered into a reply (refused), an edit in the middle of
//                                                  that reply, then the first message of the chat reopened from disk
//                                                  (six more live turns, one of them stopped at once)
//   node scripts/codex-smoke.mjs --live --commands    plus `/compact` after the text turn (one more model call), to
//                                                     see what Codex really sends for it; --record <file> keeps
//                                                     those lines as a fixture (sanitised like the recorder's)
//   node scripts/codex-smoke.mjs --fake [--live …]      the same steps against the scripted stand-in: checks this script
//   --model <id>     default: the first model whose id or description says luna, mini, nano or affordable
//
// Contract:
//  - Live turns cost real money on the user's own Codex login, so each one is tiny, at the lowest effort the model
//    has, on the standard tier (Fast off), on the cheapest model. The script refuses to start more turns than the
//    mode allows (1, 2 with --approval, 3 with --all, one more with --as-product, six more with --edit, one more with
//    --commands) and refuses --live when it cannot name a cheap model.
//  - Nothing under ~/.codex is written. Every chat it makes is archived at the end through Codex's own
//    `thread/archive` (reversible), also after a failure. It never answers "always" to an approval (that would make
//    Codex write a rule into the user's files). It stops only the processes it started.
//  - Every process gets the recorder's set-up: no notify program, no memories, and the user's plugins, apps and MCP
//    servers off, so a test turn never pokes the user's Mac or their connected accounts. The one exception is the
//    --as-product turn, which runs with no flags at all, as the app does: the user's notify program runs once.
//  - It works in scratch folders under /tmp and removes them.
//  - One line per check, PASS, FAIL or SKIP, then the tokens used. The exit code is 1 when anything failed.
//
// Not covered here: images in a message (built from the protocol's types; never sent to a real Codex).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSession } from '../src/core/codex-session.mjs';
import { CodexProcess, CodexService, codexEnv, codexVersion, findCodex } from '../src/core/codex-host.mjs';
import { adaptHistory } from '../src/core/codex-adapter.mjs';
import { CodexChats } from '../src/codex-chats.mjs';
import { CodexListed, LISTED_SOURCES } from '../src/codex-listed.mjs';
import { CODEX_MIN_VERSION, codexTooOld, codexUpdatesOff } from '../src/core/codex-upkeep.mjs';
import { neutralFixture } from '../src/core/test/helpers.mjs';

// ---- command line ----

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i === -1) return false; argv.splice(i, 1); return true; };
const option = (name) => { const i = argv.indexOf(name); if (i === -1) return null; const [, v] = argv.splice(i, 2); return v ?? null; };
const LIVE = flag('--live');
const ALL = flag('--all');
const APPROVAL = flag('--approval') || ALL;
const AS_PRODUCT = flag('--as-product');
const EDIT = flag('--edit');
const FAKE = flag('--fake');
const COMMANDS = flag('--commands');
const RECORD = option('--record');
const MODEL = option('--model');
if (argv.length) { console.error(`unknown argument: ${argv.join(' ')}`); process.exit(2); }
if ((APPROVAL || AS_PRODUCT || EDIT || COMMANDS) && !LIVE) { console.error('--approval, --all, --as-product, --edit and --commands need --live'); process.exit(2); }
if (RECORD && (!COMMANDS || FAKE)) { console.error('--record needs --live --commands against the real Codex'); process.exit(2); }

const TURN_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- reporting ----

const results = [];
function report(state, name, detail) {
  results.push({ state, name });
  console.log(`${state}  ${name}${detail ? `  (${detail})` : ''}`);
}
const check = (name, ok, detail) => { report(ok ? 'PASS' : 'FAIL', name, detail); return !!ok; };
const skip = (name, why) => report('SKIP', name, why);
const section = (title) => console.log(`\n${title}`);
const brief = (v) => { try { return JSON.stringify(v).slice(0, 200); } catch { return String(v); } };

// ---- live turns are counted ----

const EDIT_TURNS = 6;
let turnsLeft = !LIVE ? 0 : (ALL ? 3 : APPROVAL ? 2 : 1) + (AS_PRODUCT ? 1 : 0) + (EDIT ? EDIT_TURNS : 0) + (COMMANDS ? 1 : 0);
let turnsMade = 0;     // turns that carry a message of ours: what a chat's history is counted against
let commandsMade = 0;  // model calls that are not a message (a compaction)
function spend(what, { command = false } = {}) {
  if (turnsLeft <= 0) throw new Error(`refusing to start another live turn (${what}): the cap for this run is used up`);
  turnsLeft -= 1;
  if (command) commandsMade += 1; else turnsMade += 1;
}
// A compaction may or may not be a turn of its own in Codex's history: with --commands, one more turn end is allowed.
const turnEndsOk = (n) => (commandsMade ? n >= turnsMade && n <= turnsMade + commandsMade : n === turnsMade);

// ---- the lines that cross the pipe, for --record ----

const tape = [];
const tapedAt = Date.now();
/** A spawn that also keeps every line written to and by the process, as the recorder does: { t, dir, msg }. */
function taped(spawnFn) {
  return (cmd, args, opts) => {
    const child = spawnFn(cmd, args, opts);
    const keep = (dir) => { let buf = ''; return (chunk) => { buf += chunk.toString('utf8'); let at; while ((at = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, at); buf = buf.slice(at + 1); if (!line.trim()) continue; try { tape.push({ t: Date.now() - tapedAt, dir, msg: JSON.parse(line) }); } catch { /* not a message */ } } }; };
    child.stdout?.on('data', keep('in'));
    const out = keep('out');
    const write = child.stdin?.write?.bind(child.stdin);
    if (write) child.stdin.write = (chunk, ...rest) => { try { out(chunk); } catch { /* the tape never breaks the pipe */ } return write(chunk, ...rest); };
    return child;
  };
}
/** The taped lines as a fixture file, with the user's own MCP servers, plugins and ids given neutral ones. Refuses to write anything that still looks like a key or an email address. */
function writeTape(file, lines, note) {
  const home = process.env.HOME ?? '';
  const clean = (v) => {
    if (typeof v === 'string') { let t = home ? v.split(home).join('/Users/test') : v; if (t.length > 6000) t = `${t.slice(0, 400)}… [cut from ${t.length} characters]`; return t; }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'installationId' ? '00000000-0000-0000-0000-000000000000' : clean(x)]));
    return v;
  };
  const text = neutralFixture([JSON.stringify({ dir: 'note', ...note }), ...lines.map((l) => JSON.stringify(clean(l)))].join('\n') + '\n');
  if (/sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text) || (home && text.includes(home))) return 'it still holds something that looks like a key, an email address or the home folder';
  fs.writeFileSync(file, text);
  return null;
}

// ---- everything this run started, so it can all be undone ----

const sessions = new Set();
const threads = new Set();
let service = null;
let scratch = null;
let fake = null;
const tokens = [];

function watch(session) {
  const events = [];
  session.on('event', (ev) => { events.push(ev); if ((ev.kind === 'init' || ev.kind === 'meta') && typeof ev.sessionId === 'string') threads.add(ev.sessionId); });
  const waitFor = async (pred, { ms = TURN_MS, from = 0, label = 'an event' } = {}) => {
    const test = typeof pred === 'string' ? (e) => e.kind === pred : pred;
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.slice(from).find(test);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${label}`);
      await sleep(15);
    }
  };
  return { events, waitFor, kinds: (from = 0) => events.slice(from).map((e) => e.kind) };
}

const pidGone = (pid) => { if (FAKE) return true; try { process.kill(pid, 0); return false; } catch { return true; } };
async function untilGone(pid, ms = 3000) { const end = Date.now() + ms; while (!pidGone(pid) && Date.now() < end) await sleep(25); return pidGone(pid); }

// The stand-in for --fake: the default one-word turn, plus the two turns --all asks for.
async function makeFake() {
  const { createFakeCodex } = await import('../src/core/test/fake-codex.mjs');
  const f = createFakeCodex({});
  f.script = async (child, turn) => {
    const text = turn.params.input.find((i) => i.type === 'text')?.text ?? '';
    child.startTurn();
    child.userItem(turn.params.input);
    if (/touch smoke\.txt/.test(text)) {
      const cwd = child.options?.cwd ?? scratch;
      const item = { type: 'commandExecution', id: 'exec-smoke', command: "/bin/zsh -lc 'touch smoke.txt'", cwd, processId: null, source: 'agent', status: 'inProgress',
        commandActions: [{ type: 'unknown', command: 'touch smoke.txt' }], aggregatedOutput: null, exitCode: null, durationMs: null };
      child.note('thread/status/changed', { threadId: child.threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
      child.note('item/started', { item, threadId: child.threadId, turnId: turn.id, startedAtMs: Date.now() });
      const asked = child.ask('item/commandExecution/requestApproval', {
        kind: 'command', threadId: child.threadId, turnId: turn.id, itemId: item.id, reason: 'This writes a file.', command: item.command, cwd,
        commandActions: item.commandActions, proposedExecpolicyAmendment: ['touch', 'smoke.txt'],
        availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'smoke.txt'] } }, 'cancel'],
      });
      const answer = await asked.answer;
      if (!answer || child.exited) return;
      child.note('serverRequest/resolved', { threadId: child.threadId, requestId: asked.id });
      const ran = answer.result?.decision === 'accept';
      if (ran) fs.writeFileSync(path.join(cwd, 'smoke.txt'), '');
      const done = { ...item, status: ran ? 'completed' : 'declined', exitCode: ran ? 0 : null, durationMs: 4, source: 'unifiedExecStartup' };
      child.note('item/completed', { item: done, threadId: child.threadId, turnId: turn.id, completedAtMs: Date.now() });
      turn.items.push(done);
      child.streamText('DONE');
      child.usage();
      child.completeTurn();
    } else if (/Count from 1/.test(text)) {
      child.streamText('1\n2\n3\n', { open: true, pieces: ['1\n', '2\n', '3\n'] }); // left streaming: Stop ends it
    } else if (/Which words did I ask you to remember/.test(text)) {
      // What a model would say: the words in the turns that are still in the saved chat, and nothing of a dropped one.
      const said = (f.turnsOf[child.threadId] ?? []).flatMap((t) => t.items).filter((i) => i.type === 'userMessage').map((i) => i.content.find((c) => c.type === 'text')?.text ?? '');
      const words = said.map((t) => /Remember the word (\w+)/.exec(t)?.[1]).filter(Boolean);
      child.streamText(words.length ? words.join(', ') : 'NONE');
      child.usage();
      child.completeTurn();
    } else {
      child.streamText('OK');
      child.usage();
      child.completeTurn();
    }
  };
  return f;
}

// The recorder's "bare" set-up, as CodexSession's `config` and `flags`: the user's Codex with nothing of theirs that
// a test turn could reach. Server names are read with plugins already off (see CODEX-FIXTURES.md, "Flags").
function bareSetup(codexPath, env) {
  const flags = ['--disable', 'memories', '--disable', 'plugins', '--disable', 'apps'];
  const config = { notify: [] };
  if (FAKE) return { config, flags };
  const r = spawnSync(codexPath, ['--disable', 'plugins', '--disable', 'apps', 'mcp', 'list', '--json'], { env, encoding: 'utf8', timeout: 20000 });
  let servers = [];
  try { servers = JSON.parse(r.stdout); } catch { /* none readable: none switched off by name */ }
  for (const s of Array.isArray(servers) ? servers : []) if (s?.enabled && /^[A-Za-z0-9_-]+$/.test(s.name ?? '')) config[`mcp_servers.${s.name}.enabled`] = false;
  return { config, flags };
}

const CHEAP = /luna|mini|nano|affordable/i;
const lowestEffort = (row) => ['low', 'minimal', 'none', 'medium'].find((e) => row.supportedEffortLevels?.includes(e)) ?? row.supportedEffortLevels?.[0] ?? undefined;

async function main() {
  const env = codexEnv(process.env);
  let codexPath = '/fake/codex';
  let spawnFn = spawn;
  if (FAKE) { fake = await makeFake(); spawnFn = fake.spawnFn; console.log('Running against the scripted stand-in: no Codex is started.'); }

  // ---------- free: Codex itself ----------
  section('Codex on this Mac');
  if (!FAKE) {
    codexPath = await findCodex({ ...process.env });
    if (!check('codex is found', !!codexPath, codexPath ?? 'not on PATH')) return;
    const version = await codexVersion(codexPath, process.env);
    check('codex says its version', !!version, version ?? 'no answer');
  } else skip('codex is found, and says its version', 'needs the real Codex');

  scratch = fs.realpathSync(fs.mkdtempSync('/tmp/canopy-codex-smoke-'));
  const plain = path.join(scratch, 'plain');
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(plain); fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'hello\n');

  const bare = bareSetup(codexPath, env);
  service = new CodexService({ codexPath, env, config: { notify: [] }, spawnFn, appVersion: '0.0.1' });

  const account = await service.account();
  check('the helper reads the account', account.ok, account.ok ? `${account.account?.type ?? 'no account'}${account.signedIn ? '' : ', signed out'}` : account.message);
  const listed = await service.models();
  const models = listed.ok ? listed.models : [];
  check('the model list has rows, each with effort levels', models.length > 0 && models.every((m) => m.supportedEffortLevels.length > 0), listed.ok ? models.map((m) => m.value).join(', ') : listed.message);
  const again = Date.now();
  await service.models();
  check('a second ask for the models is answered from memory', Date.now() - again < 50, `${Date.now() - again} ms`);

  // What the model picker gets through Canopy's own list (src/codex-chats.mjs), as main wires it.
  const state = { codexChats: undefined };
  const chats = new CodexChats({ load: () => state.codexChats, save: (l) => { state.codexChats = JSON.parse(JSON.stringify(l)); }, service, installed: () => true, timings: { goneAfter: 0 } });
  const picker = await chats.models();
  check('the picker gets the OpenAI rows', picker.openai.length > 0 && picker.openai.every((m) => m.engine === 'codex' && m.maker === 'openai') && picker.codex.signedIn === true,
    picker.openai.map((m) => `${m.displayName}${m.isDefault ? '*' : ''} [${m.supportedEffortLevels.join('/')}; default ${m.defaultEffort}; fast ${m.supportsFastMode}]`).join(' · '));

  const t1 = Date.now();
  const first = await service.listThreads({ limit: 100 });
  const firstMs = Date.now() - t1;
  const t2 = Date.now();
  const second = await service.listThreads({ limit: 100 });
  check('the chat list is read twice, the second time fast', first.ok && second.ok && Date.now() - t2 < 500, `${first.ok ? first.threads.length : '?'} chats, ${firstMs} ms then ${Date.now() - t2} ms`);

  // ---------- free: a chat that opens and closes without a turn ----------
  for (const [label, cwd] of [['a folder that is not a git repo', plain], ['a git repo', repo]]) {
    section(`A chat in ${label} (no turn)`);
    const s = new CodexSession({ cwd, codexPath, env, spawnFn, allowBypass: true, ...bare });
    sessions.add(s);
    const w = watch(s);
    const warmed = await s.warm();
    check('warm() starts the process and opens the chat', warmed.ok === true, warmed.ok ? `${warmed.startupMs} ms` : `${warmed.code}: ${warmed.message}`);
    if (!warmed.ok) continue;
    const meta = w.events.find((e) => e.kind === 'meta');
    check('meta arrives, with the engine, the model in use and the chat\'s three slash commands', meta?.engine === 'codex' && typeof meta.model === 'string' && Array.isArray(meta.commands) && meta.commands.map((c) => c.name).join(' ') === 'compact review goal' && !('models' in meta),
      brief({ model: meta?.model, effort: meta?.effort, fastState: meta?.fastState, version: meta?.version, account: meta?.account?.type }));
    check('a chat with no turn has no id yet', s.sessionId === null && !w.events.some((e) => e.kind === 'init'));
    const pid = s.pid;
    check('its process is alive', Number.isInteger(pid) && (FAKE || !pidGone(pid)), `pid ${pid}`);
    const modes = [];
    for (const mode of ['acceptEdits', 'plan', 'auto', 'bypassPermissions', 'default']) modes.push([mode, (await s.set('permissionMode', mode)).ok]);
    check('all five modes are accepted', modes.every(([, ok]) => ok) && !w.events.some((e) => e.kind === 'setting-failed'), modes.map(([m, ok]) => `${m}${ok ? '' : ' REFUSED'}`).join(', '));
    // Accept Edits resends a whole sandbox with every turn: it has to be the user's own, not a blank one over theirs.
    const sandbox = s.sandboxFor('workspace-write');
    check('Accept Edits has a workspace-write sandbox to send', sandbox?.type === 'workspaceWrite' && typeof sandbox.networkAccess === 'boolean' && Array.isArray(sandbox.writableRoots),
      `${s.sandboxes.workspaceWrite ? 'as Codex reports it for this user' : 'the plain one: Codex reported none'}; network ${sandbox?.networkAccess ? 'on' : 'off'}, ${sandbox?.writableRoots?.length ?? '?'} extra folders`);
    // Canopy's own skills (src/core/plugin.mjs): the chat told its process their folder before the thread opened.
    if (FAKE) skip('Codex lists Canopy\'s two skills for this chat', 'the stand-in has no skills to list');
    else {
      const listed = await s.proc.request('skills/list', { cwds: [cwd] }, { timeoutMs: 15000 }).then((r) => r?.data?.[0]?.skills ?? [], (err) => String(err?.message ?? err));
      const ours = Array.isArray(listed) ? listed.filter((k) => /^canopy:/.test(k.name)) : [];
      check('Codex lists Canopy\'s skill for this chat', ours.map((k) => k.name).sort().join(' ') === 'canopy:canopy' && ours.every((k) => k.enabled),
        Array.isArray(listed) ? `${ours.map((k) => k.name).join(', ') || 'none of them'} among ${listed.length}` : listed);
    }
    const snap = s.snapshot();
    check('the snapshot has what the window redraws from', snap.engine === 'codex' && snap.sessionId === null && snap.busy === false && snap.settings.permissionMode === 'default' && Array.isArray(snap.pending) && Array.isArray(snap.turn));
    const history = await s.history();
    check('history of a chat with no turn is empty, without asking Codex', history.ok === true && history.events.length === 0);
    await s.dispose({ graceMs: 2000 });
    sessions.delete(s);
    check('dispose() resolves once the process is gone', await untilGone(pid), `pid ${pid}`);
    check('nothing was written to disk for it', !threads.size, threads.size ? [...threads].join(', ') : 'no chat id was ever given out');
  }

  // Canopy puts its flags after `--listen stdio://`; the recorder put them before. Both must work.
  section('Flag order');
  if (!FAKE) {
    const reordered = (cmd, args, opts) => spawn(cmd, ['app-server', ...args.slice(3), '--listen', 'stdio://'], opts);
    for (const [label, fn] of [['after --listen (what Canopy does)', spawn], ['before --listen (what the recorder did)', reordered]]) {
      const p = new CodexProcess({ codexPath, env, cwd: plain, config: bare.config, flags: bare.flags, spawnFn: fn });
      p.start();
      let ok = false;
      let why = '';
      try { await p.ready; ok = true; } catch (err) { why = String(err?.message ?? err); }
      await p.shutdown(1500);
      check(`flags ${label}`, ok, why);
    }
  } else skip('flags before and after --listen', 'needs the real Codex');

  // ---------- free (W4): "Show earlier", a saved chat read a page at a time ----------
  // One of the chats already listed above that has more than one turn, read one turn a page. Only turn ids and
  // counts are looked at: nothing a chat says is printed.
  section('Show earlier: a saved chat, a page at a time');
  {
    let paged = null;
    for (const t of (first.ok ? first.threads : []).slice(0, 12)) {
      const newest = await service.turns(t.id, { maxTurns: 1, pageSize: 1 });
      if (newest.ok && newest.cursor && newest.turns.length === 1) { paged = { id: t.id, newest }; break; }
    }
    if (!paged) skip('the page before a cursor', FAKE ? 'the stand-in lists no saved chats' : 'none of the newest 12 chats has more than one turn');
    else {
      const older = await service.turns(paged.id, { maxTurns: 1, pageSize: 1, cursor: paged.newest.cursor });
      check('the page before a cursor is the turn just older', older.ok && older.turns.length === 1 && older.turns[0]?.id !== paged.newest.turns[0]?.id,
        older.ok ? `one turn, then ${older.cursor ? 'a cursor for the next' : 'no cursor: that was the first turn'}` : older.message);
      const bad = await service.turns(paged.id, { maxTurns: 1, pageSize: 1, cursor: 'not-a-cursor' });
      check('a cursor Codex does not know is refused', bad.ok === false, bad.ok ? `${bad.turns.length} turn(s) came back instead` : bad.message);
    }
  }
  // ---------- free: W5, Codex chats from elsewhere and Codex upkeep ----------
  // Reads only: Codex's own list (its index) and its settings, through the helper. `codex update` is never run here:
  // only its help is asked for, to see that the command Canopy relies on is there.
  section('Chats from elsewhere, and upkeep');
  {
    const elsewhere = await service.listThreads({ limit: 100, sourceKinds: [...LISTED_SOURCES] });
    const sources = elsewhere.ok ? [...new Set(elsewhere.threads.map((t) => t.source ?? 'none'))] : [];
    check('Codex lists the chats of its app, the terminal and other clients, and no other kind', elsewhere.ok && sources.every((x) => LISTED_SOURCES.includes(x)),
      elsewhere.ok ? `${elsewhere.threads.length} chats on the first page; sources: ${sources.join(', ') || 'none'}` : elsewhere.message);
    // The list as Canopy keeps it, for the scratch folders (no chat is in them yet) and Codex's own project-less chats.
    const kept = { saves: 0 };
    const listed = new CodexListed({ load: () => null, save: () => { kept.saves += 1; }, service, folders: () => [plain, repo], home: os.homedir() });
    const t3 = Date.now();
    await listed.refresh();
    const rowsElsewhere = listed.rows(undefined, { chatsDir: plain });
    check('Canopy\'s list of them is read, and every row is a chat with no project', rowsElsewhere.every((r) => r.loose === true && r.cwd === plain && r.engine === 'codex' && typeof r.title === 'string' && !!listed.folderOf(r.id)),
      `${rowsElsewhere.length} chats with no project, the last reply read for ${rowsElsewhere.filter((r) => listed.get(r.id)?.lastLine).length} of them so far, ${Date.now() - t3} ms`);
    const config = await service.call('config/read', { includeLayers: false });
    const off = await codexUpdatesOff(service);
    check('Codex says what its settings are, for the user\'s own "do not check for updates"', config.ok && config.result?.config !== null && typeof config.result?.config === 'object',
      config.ok ? `check_for_update_on_startup: ${JSON.stringify(config.result?.config?.check_for_update_on_startup ?? null)}, so updates are ${off ? 'left to the user' : 'Canopy\'s to keep'}` : config.message);
    if (!FAKE) {
      const version = await codexVersion(codexPath, process.env);
      check(`this Codex is not older than Canopy needs (${CODEX_MIN_VERSION})`, !codexTooOld(version), version ?? 'no version');
      const help = spawnSync(codexPath, ['update', '--help'], { env, encoding: 'utf8', timeout: 20000 });
      check('`codex update` is there (only its help was asked for: no update is run)', help.status === 0 && /update/i.test(help.stdout ?? ''), String(help.stdout ?? help.stderr ?? '').trim().split('\n')[0]);
    } else skip('the Codex version and `codex update --help`', 'needs the real Codex');
  }
  // The calls behind /compact, /review, /goal, the usage limits and following an agent: none is in a recording, so
  // each is asked about a chat that does not exist. Codex refusing the chat is fine (and costs nothing: nothing runs);
  // Codex not knowing the call is not. A made-up call first shows what "not known" looks like on this Codex.
  section('The calls behind the slash commands and the limits');
  {
    const p = new CodexProcess({ codexPath, env, cwd: plain, config: bare.config, flags: bare.flags, spawnFn });
    p.start();
    let up = false;
    try { await p.ready; up = true; } catch (err) { check('a process to ask', false, String(err?.message ?? err)); }
    if (up) {
      const nobody = '0f000000-0000-7000-8000-00000000dead';
      const ask = async (method, params) => { try { return { ok: true, result: await p.request(method, params, { timeoutMs: 15000 }) }; } catch (err) { return { ok: false, code: err?.code ?? null, message: String(err?.message ?? err) }; } };
      const madeUp = await ask('thread/noSuchCall/start', { threadId: nobody });
      const unknown = (r) => !r.ok && (r.code === 'timeout' || /method not found|unknown variant|unknown method|not supported yet/i.test(r.message));
      check('a made-up call is refused as not known', unknown(madeUp), brief(madeUp));
      for (const [method, params] of [
        ['thread/compact/start', { threadId: nobody }],
        ['review/start', { threadId: nobody, target: { type: 'uncommittedChanges' }, delivery: 'inline' }],
        ['thread/goal/get', { threadId: nobody }],
        ['thread/goal/set', { threadId: nobody, objective: 'smoke', status: 'paused' }],
        ['thread/goal/clear', { threadId: nobody }],
        ['account/rateLimits/read', undefined],
        ['thread/unsubscribe', { threadId: nobody }],
      ]) {
        const r = await ask(method, params);
        check(`Codex knows ${method}`, !unknown(r), r.ok ? `answered ${brief(r.result)}` : `refused: ${r.message.slice(0, 120)}`);
      }
    }
    await p.shutdown(1500);
  }
  // ---------- free (W1): what a moved chat is given ----------
  // A chat moved here from a Claude chat starts with that chat's digest, put into the thread just before its first
  // turn (CodexSession.carry). The thread here is one Codex never saves, and no turn is started on it.
  section('Moving a chat here (no turn)');
  {
    const p = new CodexProcess({ codexPath, env, cwd: plain, config: bare.config, flags: bare.flags, spawnFn });
    p.start();
    try {
      await p.ready;
      const { buildDigest, forCodex, isHandoffText } = await import('../src/core/handoff.mjs');
      const digest = buildDigest([{ kind: 'user-text', text: 'Rename the helper' }, { kind: 'assistant-text', text: 'Renamed it.' }], { fromModel: 'Opus 5.5', cwd: plain });
      check('the digest of a two-line chat is a small block', isHandoffText(digest.text) && digest.tokens < 200, `${digest.tokens} tokens`);
      if (FAKE) skip('Codex takes the digest into a new thread before its first turn', 'the stand-in has no such call (unit tests cover both answers)');
      else {
        const th = await p.request('thread/start', { ephemeral: true, cwd: plain, sandbox: 'read-only', approvalPolicy: 'never', serviceTier: null });
        const threadId = th?.thread?.id;
        let took = null;
        let why = '';
        try { took = await p.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: forCodex(digest.text) }] }] }); }
        catch (err) { why = String(err?.message ?? err); }
        check('Codex takes the digest into a new thread before its first turn', took !== null, why || 'thread/inject_items answered');
      }
    } catch (err) { check('a process to try the digest on', false, String(err?.message ?? err)); }
    await p.shutdown(1500);
  }

  if (!LIVE) { console.log('\nNo live turn was made. Pass --live for one tiny turn.'); return; }

  // ---------- live ----------
  const cheap = MODEL ? models.find((m) => m.value === MODEL) : models.find((m) => CHEAP.test(m.value) || CHEAP.test(m.description));
  section('Live turns');
  if (!check('a cheap model to test with', !!cheap, cheap ? `${cheap.value}, effort ${lowestEffort(cheap)}, standard tier` : MODEL ? `Codex does not offer "${MODEL}"` : 'none of the models says luna, mini, nano or affordable: name one with --model')) return;
  const choices = { model: cheap.value, effort: lowestEffort(cheap), fast: false, permissionMode: 'default' };
  const entry = { sessionId: null, cwd: repo, title: null }; // the status entry main keeps for the chat (src/chats.mjs)

  const s = new CodexSession({ cwd: repo, codexPath, env, spawnFn: RECORD ? taped(spawnFn) : spawnFn, ...choices, ...bare });
  sessions.add(s);
  const w = watch(s);
  s.on('event', (ev) => { if ((ev.kind === 'init' || ev.kind === 'meta') && ev.sessionId) entry.sessionId = ev.sessionId; chats.onEvent(ev, entry, s); });

  // 1. Text.
  spend('text');
  entry.title = 'Reply with exactly: OK';
  const sent = s.send('Reply with exactly: OK');
  check('send() is accepted at once', sent.ok === true, sent.ok ? '' : `${sent.code}: ${sent.message}`);
  await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { label: 'the text turn to end' });
  const id = s.sessionId;
  const order = w.kinds().filter((k) => ['busy', 'init', 'message-start', 'assistant-text', 'turn-end'].includes(k));
  const at = (pred, last = false) => (last ? w.events.findLastIndex(pred) : w.events.findIndex(pred));
  const steps = [at((e) => e.kind === 'busy' && e.busy === true), at((e) => e.kind === 'init'), at((e) => e.kind === 'message-start'), at((e) => e.kind === 'assistant-text', true), at((e) => e.kind === 'turn-end'), at((e) => e.kind === 'busy' && e.busy === false, true)];
  check('the events of a text turn come in order: busy, init, message-start, the reply, turn-end, idle', steps.every((n, i) => n >= 0 && (i === 0 || n > steps[i - 1])) && w.events.every((e, i) => i === 0 || e.seq > w.events[i - 1].seq), order.join(' '));
  const init = w.events.find((e) => e.kind === 'init');
  check('the chat gets its id when its first turn starts', typeof id === 'string' && init?.sessionId === id && init.engine === 'codex', `${id}; model ${init?.model}, effort ${init?.effort}, tier ${init?.serviceTier}`);
  check('the reply streamed', w.events.some((e) => e.kind === 'text-delta'), `${w.events.filter((e) => e.kind === 'text-delta').length} deltas`);
  const reply = w.events.filter((e) => e.kind === 'assistant-text').at(-1);
  check('the reply is "OK"', reply?.text?.trim() === 'OK', brief(reply?.text));
  const end = w.events.find((e) => e.kind === 'turn-end');
  check('the turn ended well', end?.subtype === 'success' && end.isError === false && end.interrupted === false && end.sessionId === id, brief({ subtype: end?.subtype, durationMs: end?.durationMs, errors: end?.errors }));
  tokens.push(['text', end?.turnUsage ?? null]);
  const errors = w.events.filter((e) => e.kind === 'error' || (e.kind === 'notice' && e.level === 'error') || (e.kind === 'raw' && e.label === 'adapter-error'));
  check('no error, and nothing the adapter did not know', errors.length === 0, errors.length ? brief(errors[0]) : '');
  const usage = await s.contextUsage();
  check('the context ring has numbers', !!usage && usage.totalTokens > 0 && usage.maxTokens > 0, usage ? `${usage.totalTokens} of ${usage.maxTokens} (${usage.percentage}%)` : 'null');
  const wire = w.events.find((e) => e.kind === 'meta' && e.fastState);
  check('the turn ran on the standard tier', (wire?.fastState ?? init?.fastState) === 'off' || init?.serviceTier === 'default', brief({ meta: wire?.fastState, init: init?.serviceTier }));
  const ran = w.events.filter((e) => e.kind === 'meta' && e.effort).at(-1);
  check('the turn ran on the model and effort that were chosen', s.model === choices.model && (ran?.effort ?? null) === (choices.effort ?? null), brief({ model: s.model, effort: ran?.effort ?? null }));

  // The sidebar row, from Canopy's own list.
  const rows = chats.rows([repo]);
  check('the chat is in Canopy\'s list, with a row for the sidebar', rows.length === 1 && rows[0].id === id && rows[0].engine === 'codex' && rows[0].title === 'Reply with exactly: OK' && rows[0].preview === 'OK', brief(rows[0]));
  const indexed = await service.listThreads({ limit: 100 });
  const inIndex = indexed.ok && indexed.threads.some((t) => t.id === id);
  // This is what lets the sidebar trust Codex's list: a chat missing from it was archived or deleted, not merely new.
  if (FAKE) skip('Codex\'s own list has the chat straight after its first turn', 'needs the real Codex');
  else check('Codex\'s own list has the chat straight after its first turn', inIndex, indexed.ok ? `${indexed.threads.length} chats listed` : indexed.message);
  if (FAKE) skip('catching up with Codex keeps the row', 'needs the real Codex');
  else { await chats.refresh(); check('catching up with Codex keeps the row', chats.rows([repo]).length === 1, brief(chats.lastRefresh)); }

  if (APPROVAL) {
    // 2. Approval.
    spend('approval');
    const from = w.events.length;
    s.send('Run this exact shell command: touch smoke.txt. Then reply with exactly: DONE');
    const card = await w.waitFor('permission', { from, label: 'the approval card' });
    check('a command asks first in Ask mode, as a Bash card with the bare command', card.toolName === 'Bash' && card.input?.command === 'touch smoke.txt' && card.engine === 'codex', brief({ toolName: card.toolName, input: card.input, title: card.title }));
    const mid = await s.history();
    const running = mid.ok && mid.events.some((e) => e.kind === 'user-text' && /touch smoke\.txt/.test(e.text ?? ''));
    check('history while the turn waits includes the running turn', running, mid.ok ? `${mid.events.length} events` : mid.message);
    const answered = s.respond(card.id, { action: 'allow' });
    check('Allow is taken', answered.ok === true, brief(answered));
    await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { from, label: 'the approval turn to end' });
    const result = w.events.slice(from).find((e) => e.kind === 'tool-result' && e.id === card.toolUseId);
    check('the command ran and its row has a result', !!result && !result.isError, brief(result));
    check('the file is there', fs.existsSync(path.join(repo, 'smoke.txt')));
    const end2 = w.events.slice(from).find((e) => e.kind === 'turn-end');
    check('the approval turn ended well', end2?.subtype === 'success', brief({ subtype: end2?.subtype, errors: end2?.errors }));
    tokens.push(['approval', end2?.turnUsage ?? null]);
  }

  if (ALL) {
    // 3. Stop.
    spend('stop');
    const from = w.events.length;
    s.send('Count from 1 to 300, one number per line.');
    await w.waitFor('text-delta', { from, label: 'the first words of the count' });
    const pressed = Date.now();
    const stopped = await s.interrupt();
    await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { from, ms: 12000, label: 'the stopped turn to end' });
    const took = Date.now() - pressed;
    const cut = w.events.slice(from).filter((e) => e.kind === 'assistant-text').at(-1);
    const end3 = w.events.slice(from).find((e) => e.kind === 'turn-end');
    check('Stop ends the turn within 8 s, by Codex itself', stopped.ok === true && took < 8000 && !w.events.slice(from).some((e) => e.kind === 'notice' && e.code === 'force-stop'), `${took} ms`);
    check('the text that was streaming is closed as stopped', cut?.aborted === true, brief({ aborted: cut?.aborted, length: cut?.text?.length }));
    check('the turn ends as interrupted, not as an error', end3?.interrupted === true && end3.isError === false, brief({ subtype: end3?.subtype, interrupted: end3?.interrupted }));
    tokens.push(['stop', end3?.turnUsage ?? null]);
  }

  if (COMMANDS) {
    // /compact: Codex's own compaction, not a message to the model. What it sends for it is in no recording.
    section('/compact');
    spend('compact', { command: true });
    const from = w.events.length;
    const taken = tape.length;
    const before = (await s.contextUsage())?.totalTokens ?? null;
    const sentCompact = s.send('/compact');
    check('/compact is accepted', sentCompact.ok === true);
    let freed = true;
    try { await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { from, label: 'the compaction to end' }); } catch (err) { freed = false; check('the chat is free after /compact', false, err.message); }
    const after = w.events.slice(from);
    if (freed) check('the chat is free after /compact', s.busy === false && s.outbox.size === 0, after.map((e) => e.kind).filter((k) => !/delta/.test(k)).join(' ').slice(0, 200));
    check('it says the frozen compaction notice, once', after.filter((e) => e.kind === 'notice' && e.code === 'compacted' && e.text === 'Conversation compacted').length === 1, brief(after.filter((e) => e.kind === 'notice').map((e) => e.text)));
    check('the status line said "summarizing" while it ran', after.some((e) => e.kind === 'status' && e.status === 'compacting'));
    const endC = after.find((e) => e.kind === 'turn-end');
    check('it ends as one turn of the chat, not an error', !!endC && endC.isError === false && after.filter((e) => e.kind === 'turn-end').length === 1, brief({ subtype: endC?.subtype, synthetic: endC?.synthetic ?? false, turnId: endC?.turnId, durationMs: endC?.durationMs }));
    const strange = after.filter((e) => e.kind === 'error' || (e.kind === 'raw' && e.label === 'adapter-error'));
    check('no error, and nothing the adapter did not know', strange.length === 0, strange.length ? brief(strange[0]) : '');
    const now = (await s.contextUsage())?.totalTokens ?? null;
    report('PASS', 'context before and after', `${before} then ${now} tokens`);
    tokens.push(['compact', endC?.turnUsage ?? null]);
    if (RECORD) {
      const why = writeTape(RECORD, tape.slice(taken), { scenario: 'compact', codex: s.version, model: choices.model, setup: 'bare', answers: {}, flags: bare.flags });
      check(`the lines of the compaction are kept in ${path.basename(RECORD)}`, !why, why ?? `${tape.length - taken} lines`);
    }
  }

  // 4. Reopen (free).
  section('Reopening it');
  const liveHistory = await chats.history(id, { session: s });
  check('history of the open chat comes from its own process', turnEndsOk(liveHistory.filter((e) => e.kind === 'turn-end').length), liveHistory.map((e) => e.kind).join(' ').slice(0, 160));
  const named = await chats.rename(id, 'Canopy smoke test', s);
  check('renaming the open chat goes through its process', named.ok && named.via === 'live', brief(named));
  await w.waitFor((e) => e.kind === 'meta' && e.title === 'Canopy smoke test', { ms: 5000, label: 'the rename to come back' }).then(() => check('Codex confirms the name', chats.titleOf(id) === 'Canopy smoke test'), (err) => check('Codex confirms the name', false, err.message));
  const livePid = s.pid;
  await s.dispose({ graceMs: 2500 });
  sessions.delete(s);
  check('the chat\'s process is gone after dispose()', await untilGone(livePid), `pid ${livePid}`);

  const turns = await service.turns(id);
  const past = turns.ok ? adaptHistory(turns.turns, { threadId: id }) : [];
  const users = past.filter((e) => e.kind === 'user-text');
  check('the helper reads the closed chat: every message and every turn end', turns.ok && users.length === turnsMade && turnEndsOk(past.filter((e) => e.kind === 'turn-end').length),
    turns.ok ? past.map((e) => e.kind).join(' ').slice(0, 200) : turns.message);
  check('the first message reads back as it was sent', users[0]?.text === 'Reply with exactly: OK', brief(users[0]?.text));
  if (APPROVAL) check('the command\'s row is in the history, with its result', past.some((e) => e.kind === 'tool-start' && e.name === 'Bash' && e.input?.command === 'touch smoke.txt') && past.some((e) => e.kind === 'tool-result'));
  const viaList = await chats.history(id);
  check('Canopy\'s list hands back the same transcript', JSON.stringify(viaList.map((e) => e.kind)) === JSON.stringify(past.map((e) => e.kind)));
  const renamed = await chats.rename(id, 'Canopy smoke test (closed)');
  check('renaming a closed chat goes through the helper', renamed.ok && renamed.via === 'service', brief(renamed));

  const r = new CodexSession({ cwd: repo, codexPath, env, spawnFn, resume: id, ...choices, ...bare });
  sessions.add(r);
  const rw = watch(r);
  check('a reopened chat has its id from the start', r.sessionId === id);
  const rewarmed = await r.warm();
  const reinit = rw.events.find((e) => e.kind === 'init');
  check('warm() resumes the same chat', rewarmed.ok === true && reinit?.sessionId === id, rewarmed.ok ? `${rewarmed.startupMs} ms; name ${brief(reinit?.name)}` : `${rewarmed.code}: ${rewarmed.message}`);
  const resumed = await r.history();
  check('its history is the same through the resumed process', resumed.ok && resumed.events.filter((e) => e.kind === 'user-text').length === turnsMade, resumed.ok ? `${resumed.events.length} events` : resumed.message);
  await r.dispose({ graceMs: 2500 });
  sessions.delete(r);

  // 5. Edit and resend, in a chat of its own (CodexSession.edit: Codex's thread/revert, then the new message).
  if (EDIT) await editAndResend({ codexPath, env, spawnFn, choices, bare, cwd: plain, chats });

  // 6. One turn exactly as the app runs it: no flags at all, so the user's own set-up, their notify program included.
  if (AS_PRODUCT) {
    section('As the app runs it (no flags)');
    spend('as-product');
    const p = new CodexSession({ cwd: repo, codexPath, env, spawnFn, ...choices });
    sessions.add(p);
    const pw = watch(p);
    p.send('Reply with exactly: OK');
    await pw.waitFor((e) => e.kind === 'busy' && e.busy === false, { label: 'the as-product turn to end' });
    const pend = pw.events.find((e) => e.kind === 'turn-end');
    const ptext = pw.events.filter((e) => e.kind === 'assistant-text').at(-1);
    check('a turn with the user\'s own Codex set-up ends well', pend?.subtype === 'success' && ptext?.text?.trim() === 'OK', brief({ subtype: pend?.subtype, text: ptext?.text, errors: pend?.errors }));
    const shown = pw.events.filter((e) => e.kind === 'hook' || e.kind === 'error' || (e.kind === 'notice' && e.code !== 'api-key-billing'));
    check('none of the user\'s start-up chatter reaches the transcript', shown.length === 0, shown.length ? brief(shown.map((e) => [e.kind, e.code ?? e.text])) : '');
    tokens.push(['as-product', pend?.turnUsage ?? null]);
    await p.dispose({ graceMs: 2500 });
    sessions.delete(p);
  }
}

// Edit and resend against the real Codex. What has to hold after each edit: Codex's own history has the kept turns
// and the new one and nothing of what was dropped, the model answers as if the dropped turns were never said, and
// the chat keeps its id (and, when nothing had to be forced, its process). Six live turns, all tiny:
//   GUAVA, MANGO, [edit MANGO -> PAPAYA], a count (stopped at once by the next edit), [edit the count -> "which
//   words?"], and after reopening the chat from disk [edit GUAVA, found by Codex's own id -> "which words?"].
async function editAndResend({ codexPath, env, spawnFn, choices, bare, cwd, chats }) {
  section('Edit and resend');
  const GUAVA = 'Remember the word GUAVA. Reply with exactly: OK';
  const MANGO = 'Remember the word MANGO. Reply with exactly: OK';
  const PAPAYA = 'Remember the word PAPAYA. Reply with exactly: OK';
  const COUNT = 'Count from 1 to 400, one number per line.';
  const WHICH = 'Which words did I ask you to remember so far? Reply with just the words, nothing else.';
  const NONE = 'Which words did I ask you to remember so far? If there are none, reply with exactly: NONE';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const users = (events) => events.filter((x) => x.kind === 'user-text').map((x) => x.text);
  const shape = (events) => events.filter((x) => ['turn-end', 'edit', 'message-start'].includes(x.kind)).map((x) => (x.kind === 'turn-end' ? `turn-end:${x.subtype}` : x.kind)).join(' ');
  const replyIn = (events) => events.filter((x) => x.kind === 'assistant-text' && !x.aborted).at(-1)?.text ?? '';
  const idleAfter = (w, from, label) => w.waitFor((x) => x.kind === 'busy' && x.busy === false, { from, label });
  const noted = (w) => { for (const end of w.events.filter((x) => x.kind === 'turn-end' && !x.counted)) { end.counted = true; tokens.push(['edit', end.turnUsage ?? null]); } };

  const entry = { sessionId: null, cwd, title: GUAVA }; // the status entry main keeps: a chat goes by its first message
  const wire = (session) => session.on('event', (ev) => { if ((ev.kind === 'init' || ev.kind === 'meta') && ev.sessionId) entry.sessionId = ev.sessionId; chats.onEvent(ev, entry, session); });
  const e = new CodexSession({ cwd, codexPath, env, spawnFn, ...choices, ...bare });
  sessions.add(e);
  const w = watch(e);
  wire(e);
  const say = async (text) => { spend(text.slice(0, 28)); const from = w.events.length; const sent = e.send(text); await idleAfter(w, from, `"${text.slice(0, 28)}…" to be answered`); return sent; };

  await say(GUAVA);
  const mango = await say(MANGO);
  const id = e.sessionId;
  const pid = e.pid;
  check('two turns to edit are in place', typeof id === 'string' && w.events.filter((x) => x.kind === 'turn-end' && x.subtype === 'success').length === 2, id);

  // a. Edit while the chat is idle.
  spend('the edited second message');
  let from = w.events.length;
  const first = await e.edit({ messageId: mango.id, text: PAPAYA });
  check('an edit while idle is taken: same conversation, not its first message, and the old words come back', first.ok === true && first.fresh === false && first.first === false && first.replaced === MANGO, brief(first));
  await idleAfter(w, w.events.length, 'the edited message to be answered');
  let seen = w.events.slice(from);
  check('the mark comes before anything of the new turn', shape(seen) === 'edit message-start turn-end:success', shape(seen));
  const mark = seen.find((x) => x.kind === 'edit');
  check('the mark names the message that went and the one that took its place', mark?.messageId === mango.id && mark.id === first.id && seen.find((x) => x.kind === 'turn-end')?.userUuids?.[0] === first.id, brief(mark));
  let hist = await e.history();
  check('Codex\'s history has the kept turn and the new one, and nothing of the dropped one', hist.ok && same(users(hist.events), [GUAVA, PAPAYA]) && hist.events.filter((x) => x.kind === 'turn-end').length === 2, hist.ok ? brief(users(hist.events)) : hist.message);
  check('same chat, same process', e.sessionId === id && e.pid === pid, `${e.sessionId}, pid ${e.pid}`);

  // b. A reply in flight: a message steered into it cannot be edited alone; the message that started it can.
  spend('the count');
  from = w.events.length;
  const count = e.send(COUNT);
  await w.waitFor('text-delta', { from, label: 'the first numbers of the count' });
  const steered = e.send('After the count, say HELLO.');
  for (const end = Date.now() + 10000; e.outbox.get(steered.id)?.state !== 'started' && Date.now() < end;) await sleep(15);
  const refused = await e.edit({ messageId: steered.id, text: 'After the count, say GOODBYE.' });
  check('a message steered into the running reply is refused, and the reply is left running', refused.ok === false && refused.code === 'steered' && e.busy === true && !w.events.slice(from).some((x) => x.kind === 'turn-end'), brief(refused));
  spend('the edited count');
  const at = w.events.length;
  const pressed = Date.now();
  const second = await e.edit({ messageId: count.id, text: WHICH });
  check('an edit in the middle of a reply is taken', second.ok === true && second.first === false && second.replaced === COUNT, `${Date.now() - pressed} ms: ${brief(second)}`);
  await idleAfter(w, w.events.length, 'the edited message to be answered');
  seen = w.events.slice(at);
  check('the reply is stopped by Codex itself, then the conversation is cut, then the new message starts', shape(seen) === 'turn-end:interrupted edit message-start turn-end:success' && !seen.some((x) => x.kind === 'stopped' || (x.kind === 'notice' && x.code === 'force-stop')) && e.pid === pid, shape(seen));
  const answer = replyIn(seen.slice(seen.findIndex((x) => x.kind === 'edit')));
  check('the model remembers the kept words and not the dropped one', /GUAVA/i.test(answer) && /PAPAYA/i.test(answer) && !/MANGO/i.test(answer) && !/\b17\b/.test(answer), brief(answer));
  hist = await e.history();
  check('history after both edits: three messages, no count and no steered message', hist.ok && same(users(hist.events), [GUAVA, PAPAYA, WHICH]) && hist.events.filter((x) => x.kind === 'turn-end').length === 3, hist.ok ? brief(users(hist.events)) : hist.message);
  let row = chats.rows([cwd]).find((x) => x.id === id);
  check('the sidebar row quotes the reply to the edited message', !!row && /GUAVA/i.test(row.preview ?? '') && row.title === GUAVA, brief(row));
  const errors = w.events.filter((x) => x.kind === 'error' || (x.kind === 'raw' && x.label === 'adapter-error'));
  check('no error, and nothing the adapter did not know', errors.length === 0, errors.length ? brief(errors[0]) : '');
  noted(w);
  await e.dispose({ graceMs: 2500 });
  sessions.delete(e);

  // c. The chat closed and read back from disk: another process sees the cut conversation, and a message is found
  //    by the id Codex itself gave it.
  const turns = await service.turns(id);
  const past = turns.ok ? adaptHistory(turns.turns, { threadId: id }) : [];
  check('a different process reads the same cut conversation from disk', turns.ok && same(users(past), [GUAVA, PAPAYA, WHICH]) && past.filter((x) => x.kind === 'turn-end').length === 3, turns.ok ? brief(users(past)) : turns.message);
  const bubble = past.find((x) => x.kind === 'user-text');
  const r = new CodexSession({ cwd, codexPath, env, spawnFn, resume: id, ...choices, ...bare });
  sessions.add(r);
  const rw = watch(r);
  wire(r);
  spend('the edited first message');
  from = rw.events.length;
  const third = await r.edit({ messageId: bubble?.uuid, text: NONE }); // the chat is not even running: the edit opens it
  check('the first message of a reopened chat is edited by Codex\'s own id for it', third.ok === true && third.fresh === false && third.first === true && third.replaced === GUAVA && bubble?.uuid !== mango.id, brief({ ...third, uuid: bubble?.uuid }));
  await idleAfter(rw, rw.events.length, 'the edited first message to be answered');
  const last = replyIn(rw.events.slice(from));
  check('nothing is left before it: the model has no word to remember', /NONE/.test(last) && !/GUAVA|PAPAYA|MANGO/i.test(last), brief(last));
  hist = await r.history();
  check('the chat is the one new message, under the id it always had', hist.ok && same(users(hist.events), [NONE]) && r.sessionId === id, hist.ok ? brief(users(hist.events)) : hist.message);
  // What main does when the first message was replaced (editChat in src/main.mjs).
  const renamed = chats.firstMessageEdited(id, third.replaced, NONE);
  row = chats.rows([cwd]).find((x) => x.id === id);
  check('the sidebar row is named after the new first message and quotes its reply', renamed === true && row?.title?.startsWith('Which words did I ask you to remember') && /NONE/.test(row.preview ?? ''), brief(row));
  const listed = await service.listThreads({ limit: 100 });
  if (FAKE) skip('Codex\'s own list still has the chat', 'needs the real Codex');
  else check('Codex\'s own list still has the chat', listed.ok && listed.threads.some((t) => t.id === id), listed.ok ? `${listed.threads.length} chats listed` : listed.message);
  noted(rw);
  await r.dispose({ graceMs: 2500 });
  sessions.delete(r);
}

// Everything this run started is ended, and every chat it made is archived, whatever happened above.
async function tidy() {
  section('Tidying up');
  for (const s of sessions) { try { await s.dispose({ graceMs: 1500 }); } catch { /* it is gone either way */ } }
  sessions.clear();
  if (service && threads.size) {
    const left = [];
    for (const id of threads) { const r = await service.archive(id); if (!r.ok) left.push(`${id}: ${r.message}`); }
    check(`the ${threads.size === 1 ? 'test chat is' : `${threads.size} test chats are`} archived`, left.length === 0, left.length ? left.join('; ') : [...threads].join(', '));
    // What the sidebar would do about a chat archived in Codex: leave it out, once Codex's whole list no longer has it.
    if (LIVE && left.length === 0) {
      const state = Object.fromEntries([...threads].map((id) => [id, { cwd: scratch, title: 'smoke', createdAt: 1, lastPromptAt: 2 }]));
      const chats = new CodexChats({ load: () => state, save: () => {}, service, installed: () => true, timings: { goneAfter: 0 } });
      if (FAKE) skip('an archived chat leaves the sidebar', 'needs the real Codex');
      else {
        await chats.refresh();
        check('an archived chat leaves the sidebar', chats.rows().length === 0, `${chats.lastRefresh?.listed ?? '?'} chats in Codex's list, ${chats.lastRefresh?.unlisted ?? '?'} of ours not among them`);
      }
    }
  }
  if (service) { await service.close({ graceMs: 1500 }); service = null; }
  if (fake) check('no stand-in process is left', fake.alive().length === 0);
  if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* /tmp is cleared anyway */ } }
}

let crashed = null;
try { await main(); } catch (err) { crashed = err; }
try { await tidy(); } catch (err) { crashed ??= err; }
if (crashed) report('FAIL', 'the run finished', String(crashed?.stack ?? crashed).split('\n').slice(0, 3).join(' | '));

const used = tokens.filter(([, u]) => u);
console.log(`\nLive turns made: ${turnsMade}${commandsMade ? `, plus ${commandsMade} compaction` : ''}.${used.length ? ` Tokens: ${used.map(([name, u]) => `${name} ${brief(u)}`).join('; ')}` : ''}`);
const failed = results.filter((r) => r.state === 'FAIL');
console.log(`${results.filter((r) => r.state === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.state === 'SKIP').length} skipped.`);
process.exit(failed.length ? 1 : 0);

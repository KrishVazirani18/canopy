// The daily summary (src/telemetry/summary.mjs): messages per day and per tool, counted from Claude Code and Codex
// history, and the scheduler that sends each finished day once. Every transcript here is made up for the test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { createTelemetry } from '../../../telemetry/index.mjs';
import { addDays, createSummaryScheduler, daySummaryId, localDate, summarizeDays } from '../../../telemetry/summary.mjs';
import { clean, cleanEnvelope, SOURCES } from '../../../telemetry/schema.mjs';
import { TEST_ENV, fakeClock, fakeServer, stopFirst, tempDir } from '../telemetry-fakes.mjs';

process.env.TZ = 'UTC'; // local days are UTC days unless a test says otherwise

const CHATS = '/Users/me/Library/Application Support/Canopy/chats'; // Canopy's own folder in these tests
const at = (day, time = '12:00') => `2026-11-${String(day).padStart(2, '0')}T${time}:00.000Z`;
let serial = 0;
const uid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
const PNG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

// ---------- Claude Code rows, shaped like the real ones ----------

const row = (type, ts, { entrypoint = 'cli', cwd = '/Users/me/app', ...more } = {}) =>
  ({ parentUuid: null, isSidechain: false, type, uuid: uid(), timestamp: ts, userType: 'external', ...(entrypoint && { entrypoint }), ...(cwd && { cwd }), version: '2.1.325', gitBranch: 'main', ...more });
/** Something you typed. */
const you = (ts, { text = 'please fix the login page', image = false, origin, ...o } = {}) =>
  row('user', ts, { promptId: uid(), message: { role: 'user', content: image ? [{ type: 'text', text }, PNG] : text }, ...(origin && { origin: { kind: origin } }), ...o });
const toolResult = (ts, o) => row('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, toolUseResult: { stdout: 'ok', stderr: '' }, ...o });
const reply = (ts, o) => row('assistant', ts, { message: { id: uid(), role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] }, requestId: 'req_1', ...o });
const interrupt = (ts, o) => row('user', ts, { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, ...o });
/** Typed while Claude was still working: handed to the running turn. */
const queued = (ts, { image = false, mode = 'prompt', origin = 'human', ...o } = {}) =>
  row('attachment', ts, { attachment: { type: 'queued_command', prompt: image ? [{ type: 'text', text: 'and this one' }, PNG] : 'and this one', source_uuid: uid(), commandMode: mode, origin: { kind: origin }, timestamp: ts }, ...o });

// ---------- Codex rows ----------

const meta = (ts, id, { originator = 'codex_cli_rs', source = 'cli', cwd = '/Users/me/app', ...more } = {}) =>
  ({ timestamp: ts, ordinal: 0, type: 'session_meta', payload: { session_id: id, id, timestamp: ts, cwd, originator, cli_version: '0.166.0', source, model_provider: 'openai', base_instructions: { text: 'You are Codex.' }, ...more } });
const input = (ts, text = 'fix the flaky test', image = false) =>
  ({ timestamp: ts, ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }, ...(image ? [{ type: 'input_text', text: '<image>' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_text', text: '</image>' }] : [])] } });
const item = (ts, text = 'fix the flaky test', image = false) =>
  ({ timestamp: ts, ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item: { type: 'UserMessage', id: 'it', content: [{ type: 'text', text }, ...(image ? [{ type: 'local_image', path: '/Users/me/shot.png' }] : [])] }, completed_at_ms: 1 } });
/** A message as today's Codex saves it: what the model is given, and what the person submitted. */
const said = (ts, text, image) => [input(ts, text, image), item(ts, text, image)];
/** The same from an older Codex. */
const saidOld = (ts, text = 'fix the flaky test') => [input(ts, text), { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: text, images: [] } }];
const context = (ts) => ({ timestamp: ts, ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/me/app' }, { type: 'input_text', text: '<environment_context>\n  <cwd>/Users/me/app</cwd>\n</environment_context>' }] } });
const answer = (ts) => ({ timestamp: ts, ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } });
const aborted = (ts, reason = 'interrupted') => ({ timestamp: ts, ordinal: 4, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'tu', reason } });

// ---------- A made-up Mac ----------

const text = (rows) => rows.flat().map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function mac() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tel-summary-'));
  const claudeDir = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), cacheFile = path.join(root, 'telemetry', 'summary-cache.json');
  return {
    root, claudeDir, codexHome, cacheFile,
    /** A Claude Code chat: <config>/projects/<folder>/<id>.jsonl. Rows get the chat's id, as real ones have. */
    chat(id, rows, { cwd = '/Users/me/app', dir = claudeDir } = {}) {
      const file = path.join(dir, 'projects', slug(cwd), `${id}.jsonl`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text(rows.flat().map((r) => (typeof r === 'string' ? r : { ...r, sessionId: id }))));
      return file;
    },
    /** A Codex chat: <home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (or archived, or packed). */
    rollout(id, rows, { day = '2026/11/10', archived = false, zst = false, part = '' } = {}) {
      const dir = archived ? path.join(codexHome, 'archived_sessions') : path.join(codexHome, 'sessions', ...day.split('/'));
      const file = path.join(dir, `rollout-${day.replace(/\//g, '-')}T09-00-00-${id}${part}.jsonl${zst ? '.zst' : ''}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, zst ? zlib.zstdCompressSync(Buffer.from(text(rows))) : text(rows));
      return file;
    },
    days: (o = {}) => summarizeDays({ claudeDirs: [claudeDir], codexHome, cacheFile, canopyChatsDir: CHATS, fromDate: '2026-11-10', toDate: '2026-11-10', child: false, ...o }),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A day's counts that aren't zero. */
const seen = (day) => Object.fromEntries(Object.entries(day).filter(([k, v]) => k !== 'date' && v !== 0));
const ID = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555', f: '66666666-6666-4666-8666-666666666666', g: '77777777-7777-4777-8777-777777777777', h: '88888888-8888-4888-8888-888888888888' };

async function inZone(zone, fn) {
  process.env.TZ = zone;
  try { return await fn(); } finally { process.env.TZ = 'UTC'; }
}

// ---------- Claude Code ----------

test('Claude Code: each tool is told from where its rows were written, and Canopy from the chats it ran', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10, '09:00')), you(at(10, '09:05'))]);                                            // the terminal
    m.chat(ID.b, [you(at(10, '09:00'), { entrypoint: 'claude-desktop' })]);                               // the desktop app
    m.chat(ID.c, [you(at(10, '09:00'), { entrypoint: 'claude-vscode' })]);                                // an editor
    m.chat(ID.d, [you(at(10, '09:00'), { entrypoint: 'sdk-ts' }), you(at(10, '09:01'), { entrypoint: 'sdk-ts' })]); // a chat Canopy ran
    m.chat(ID.e, [you(at(10, '09:00'), { entrypoint: 'sdk-ts' })]);                                       // some other app on the SDK
    m.chat(ID.f, [you(at(10, '09:00'), { entrypoint: 'sdk-py' }), you(at(10, '09:01'), { entrypoint: 'mcp' }), you(at(10, '09:02'), { entrypoint: 'claude-code-github-action' })]);
    const [day] = await m.days({ canopySessionIds: { claude: new Set([ID.d]), codex: new Set() } });
    assert.deepEqual(seen(day), {
      msgs_claude_terminal: 2, chats_claude_terminal: 1, msgs_claude_desktop: 1, chats_claude_desktop: 1, msgs_claude_ide: 1, chats_claude_ide: 1,
      msgs_claude_canopy: 2, chats_claude_canopy: 1, msgs_claude_other: 4, chats_claude_other: 2, projects_n: 1,
    });
  } finally { m.done(); }
});

test('Claude Code: a chat Canopy never listed is still Canopy\'s in its own chats folder, or from before it kept a list', async () => {
  const m = mac();
  try {
    const loose = `${CHATS.toLowerCase()}`; // dev and packaged builds differ only in the folder's case
    m.chat(ID.a, [you(at(10, '09:00'), { entrypoint: 'sdk-ts', cwd: loose })], { cwd: loose });
    m.chat(ID.b, [you(at(10, '09:00'), { entrypoint: 'sdk-cli', cwd: `${CHATS}/sub` })], { cwd: `${CHATS}/sub` });
    m.chat(ID.c, [you(at(10, '09:00'), { entrypoint: 'sdk-ts' }), you(at(10, '15:00'), { entrypoint: 'sdk-ts' })]); // a project chat, no id
    m.chat(ID.d, [you(at(10, '09:30'))]);                                                                          // the terminal, in the same hours
    const none = { claude: [], codex: [] };
    const [plain] = await m.days({ canopySessionIds: none });
    assert.deepEqual(seen(plain), { msgs_claude_canopy: 2, chats_claude_canopy: 2, msgs_claude_other: 2, chats_claude_other: 1, msgs_claude_terminal: 1, chats_claude_terminal: 1 });
    // Canopy was in use from 08:00 and began recording ids at 12:00: the 09:00 SDK message is its own, the 15:00 one
    // (after ids, and not on the list) is another app's. The terminal is never guessed at.
    const [guessed] = await m.days({ canopySessionIds: none, canopyBeforeIds: { from: Date.parse(at(10, '08:00')), until: Date.parse(at(10, '12:00')) } });
    assert.deepEqual(seen(guessed), { msgs_claude_canopy: 3, chats_claude_canopy: 3, msgs_claude_other: 1, chats_claude_other: 1, msgs_claude_terminal: 1, chats_claude_terminal: 1, projects_n: 1 });
  } finally { m.done(); }
});

test('Claude Code: a terminal chat opened in Canopy later keeps its terminal messages in the terminal', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(9, '10:00')), you(at(10, '10:00')), you(at(10, '11:00'), { entrypoint: 'sdk-ts' })]);
    const days = await m.days({ fromDate: '2026-11-09', canopySessionIds: { claude: [ID.a] } });
    assert.deepEqual(seen(days[0]), { msgs_claude_terminal: 1, chats_claude_terminal: 1 });
    assert.deepEqual(seen(days[1]), { msgs_claude_terminal: 1, chats_claude_terminal: 1, msgs_claude_canopy: 1, chats_claude_canopy: 1, projects_n: 1 });
  } finally { m.done(); }
});

test('Claude Code: only what a person typed is a message', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [
      you(at(10, '09:00')),                                                                   // 1
      toolResult(at(10, '09:01')), reply(at(10, '09:02')),
      you(at(10, '09:03'), { isMeta: true, text: 'Caveat: the messages below were generated by the user' }),
      you(at(10, '09:04'), { text: '<command-name>/compact</command-name>' }),
      you(at(10, '09:05'), { text: '<local-command-stdout>Compacted</local-command-stdout>' }),
      you(at(10, '09:06'), { text: 'This session is being continued from a previous conversation.', isCompactSummary: true }),
      you(at(10, '09:07'), { text: '<task-notification><task-id>t1</task-id></task-notification>', origin: 'task-notification' }),
      you(at(10, '09:08'), { text: 'a helper finished', origin: 'task-notification' }),      // plain text, but not yours
      you(at(10, '09:09'), { text: '<pasted_content id="1">long paste</pasted_content> what is this?', origin: 'human' }), // 2: yours, says Claude Code
      you(at(10, '09:10'), { text: 'a helper\'s own prompt', isSidechain: true }),
      you(at(10, '09:11'), { text: 'copied from the chat this one was forked from', forkedFrom: { sessionId: ID.b, messageUuid: uid() } }),
      queued(at(10, '09:12')),                                                               // 3: typed while Claude worked
      queued(at(10, '09:13'), { mode: 'task-notification', origin: 'task-notification' }),
      row('user', at(10, '09:14'), { message: { role: 'user', content: [PNG] } }),           // 4: a picture alone
      row('user', at(10, '09:15'), { message: { role: 'user', content: [{ type: 'text', text: '<ide_opened_file>src/a.ts</ide_opened_file>' }, { type: 'text', text: 'why does this throw?' }] } }), // 5
      row('user', at(10, '09:16'), { message: { role: 'user', content: '   ' } }),
      interrupt(at(10, '09:17')),
      row('system', at(10, '09:18'), { subtype: 'turn_duration', durationMs: 5 }),
      { type: 'last-prompt', lastPrompt: 'please fix the login page', sessionId: ID.a },
    ]);
    // A helper's transcript sits in a sub-folder (and, in old versions, beside the chat as agent-*.jsonl).
    const sub = path.join(m.claudeDir, 'projects', '-Users-me-app', ID.a, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, 'agent-1.jsonl'), text([you(at(10, '09:20')), you(at(10, '09:21'))]));
    writeFileSync(path.join(m.claudeDir, 'projects', '-Users-me-app', 'agent-abc123.jsonl'), text([you(at(10, '09:22'))]));
    const [day] = await m.days();
    assert.deepEqual(seen(day), { msgs_claude_terminal: 5, chats_claude_terminal: 1 });
  } finally { m.done(); }
});

test('temp folders are test runs, not work: skipped by the row\'s folder and by the project folder\'s name', async () => {
  const m = mac();
  try {
    for (const [id, cwd] of [[ID.a, '/private/tmp/probe'], [ID.b, '/tmp/x'], [ID.c, '/var/folders/ab/T/run-1'], [ID.d, '/private/var/folders/zz/T/harness'], [ID.e, '/private']]) {
      m.chat(id, [you(at(10), { cwd, entrypoint: 'sdk-ts' }), interrupt(at(10, '12:01'), { cwd, entrypoint: 'sdk-ts' })], { cwd });
    }
    // Filed under an ordinary name, but the rows say where it really ran.
    m.chat(ID.f, [you(at(10), { cwd: '/tmp/moved', entrypoint: 'sdk-ts' })], { cwd: '/Users/me/app' });
    // A real project whose name merely starts like one.
    m.chat(ID.g, [you(at(10), { cwd: '/Users/me/tmp-notes' })], { cwd: '/Users/me/tmp-notes' });
    m.rollout(ID.h, [meta(at(10), ID.h, { originator: 'canopy', cwd: '/private/var/folders/zz/T/canopy-test' }), said(at(10, '12:01'))]);
    const [day] = await m.days({ canopySessionIds: { claude: [ID.a, ID.b, ID.c, ID.d, ID.e, ID.f], codex: [ID.h] } });
    assert.deepEqual(seen(day), { msgs_claude_terminal: 1, chats_claude_terminal: 1 });
    assert.equal(day.stats, undefined);
  } finally { m.done(); }
});

test('Canopy chats also count stops, pictures, long waits and projects; other tools\' don\'t', async () => {
  const m = mac();
  try {
    const canopy = { entrypoint: 'sdk-ts' };
    m.chat(ID.a, [
      you(at(10, '09:00'), canopy), reply(at(10, '09:01'), canopy), toolResult(at(10, '09:06'), canopy), reply(at(10, '09:11'), canopy), // 11 minutes: a long wait
      you(at(10, '10:00'), { ...canopy, image: true }), reply(at(10, '10:10'), canopy),                                                  // 10 minutes exactly: not long
      you(at(10, '11:00'), canopy), reply(at(10, '11:02'), canopy),
      you(at(10, '11:30'), { ...canopy, text: '<task-notification>done</task-notification>', origin: 'task-notification' }),            // a helper reports back later:
      reply(at(10, '11:31'), canopy),                                                                                                     // not part of the 11:00 reply
      you(at(10, '12:00'), canopy), reply(at(10, '12:20'), canopy), interrupt(at(10, '12:21'), canopy),                                  // stopped after 20 minutes: long, and a stop
      queued(at(10, '13:00'), { ...canopy, image: true }),
      you(at(10, '14:00'), canopy), reply(at(10, '14:30'), canopy),                                                                       // still the last reply at the end of the file
    ]);
    m.chat(ID.b, [you(at(10, '09:00'), { ...canopy, cwd: '/Users/me/site' }), interrupt(at(10, '09:01'), { ...canopy, cwd: '/Users/me/site' })], { cwd: '/Users/me/site' });
    m.chat(ID.c, [you(at(10, '09:00'), { ...canopy, cwd: CHATS })], { cwd: CHATS });                                                      // no project
    m.chat(ID.d, [you(at(10, '09:00'), { image: true }), reply(at(10, '09:30')), interrupt(at(10, '09:31'))]);                           // the terminal
    const [day] = await m.days({ canopySessionIds: { claude: [ID.a, ID.b, ID.c] } });
    assert.deepEqual(seen(day), {
      msgs_claude_canopy: 8, chats_claude_canopy: 3, msgs_claude_terminal: 1, chats_claude_terminal: 1,
      canopy_stops: 2, canopy_images: 2, canopy_long_waits: 3, projects_n: 2,
    });
  } finally { m.done(); }
});

// ---------- Codex ----------

test('Codex: each app is told from the name it gave Codex, and Canopy also from the chats it ran', async () => {
  const m = mac();
  try {
    const one = (id, o) => m.rollout(id, [meta(at(10, '08:00'), id, o), context(at(10, '08:00')), said(at(10, '09:00'))]);
    one(ID.a, { originator: 'canopy', source: 'vscode' });
    one(ID.b, { originator: 'Codex Desktop', source: 'vscode' });
    one(ID.c, { originator: 'codex_work_desktop', source: 'vscode' });
    one(ID.d, { originator: 'codex_cli_rs' });
    one(ID.e, { originator: 'codex-tui' });
    one(ID.f, { originator: 'codex_exec', source: 'exec' });
    one(ID.g, { originator: 'codex_vscode', source: 'vscode' });
    one(ID.h, { originator: 'codex_sdk_ts', source: 'vscode' });
    one('99999999-9999-4999-8999-999999999999', { originator: 'Codex Desktop', source: 'vscode' });           // resumed in Canopy: on its list
    one('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { originator: 'Codex Desktop', source: { subagent: { thread_spawn: { depth: 1 } } }, thread_source: 'subagent' }); // a helper
    one('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { originator: 'Claude Code', source: 'vscode' });             // a Claude Code chat Codex imported
    one('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { originator: undefined, source: 'cli' });                    // too old to name its app
    const [day] = await m.days({ canopySessionIds: { codex: new Set(['99999999-9999-4999-8999-999999999999']) } });
    assert.deepEqual(seen(day), {
      msgs_codex_canopy: 2, chats_codex_canopy: 2, msgs_codex_app: 2, chats_codex_app: 2, msgs_codex_terminal: 4, chats_codex_terminal: 4,
      msgs_codex_ide: 1, chats_codex_ide: 1, msgs_codex_other: 1, chats_codex_other: 1, projects_n: 1,
    });
  } finally { m.done(); }
});

test('Codex: a message is what the person submitted, in old rollouts and new, never the context Codex adds', async () => {
  const m = mac();
  try {
    // Today's Codex: context first, then messages; a reply to a question and a notification are not messages.
    m.rollout(ID.a, [meta(at(10, '08:00'), ID.a), context(at(10, '08:00')), said(at(10, '09:00')), answer(at(10, '09:01')), said(at(10, '09:05'), 'and the docs', true),
      said(at(10, '09:06'), '<send_user_message_question_reply>yes</send_user_message_question_reply>'), input(at(10, '09:07'), '<subagent_notification>done</subagent_notification>'),
      { timestamp: at(10, '09:08'), ordinal: 9, type: 'compacted', payload: { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the flaky test' }] }] } }]);
    // An older Codex marks it with a user_message event; one written by both kinds isn't counted twice.
    m.rollout(ID.b, [meta(at(10, '08:00'), ID.b), input(at(10, '08:00'), '# AGENTS.md instructions for /Users/me/app'), saidOld(at(10, '09:00')), saidOld(at(10, '09:05')),
      { timestamp: at(10, '09:06'), type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>…</environment_context>', kind: 'environment_context' } }]);
    m.rollout(ID.c, [meta(at(10, '08:00'), ID.c), input(at(10, '09:00')), { timestamp: at(10, '09:00'), type: 'event_msg', payload: { type: 'user_message', message: 'fix the flaky test' } }, item(at(10, '09:00'))]);
    // A rollout with neither marker: user-role items stand in, minus Codex's own.
    m.rollout(ID.d, [meta(at(10, '08:00'), ID.d), context(at(10, '08:00')), input(at(10, '09:00')), input(at(10, '09:01'), '<environment_context>…</environment_context>'), input(at(10, '09:02'), 'look', true)]);
    // No header at all (unreadable first row): still counted, as another app's.
    m.rollout(ID.e, ['{"timestamp":"broken', said(at(10, '09:00'))]);
    // A chat where the only thing "submitted" was a notification: the instructions beside it don't become a message.
    m.rollout(ID.f, [meta(at(10, '08:00'), ID.f), input(at(10, '08:00'), '# AGENTS.md instructions for /Users/me/app'), said(at(10, '09:00'), '<task-notification>done</task-notification>')]);
    const [day] = await m.days();
    assert.deepEqual(seen(day), { msgs_codex_terminal: 7, chats_codex_terminal: 4, msgs_codex_other: 1, chats_codex_other: 1 });
  } finally { m.done(); }
});

test('Codex: Canopy chats count stops, pictures and long waits; archived, packed and split chats are all read', async () => {
  const m = mac();
  try {
    const canopy = { originator: 'canopy', source: 'vscode', cwd: '/Users/me/site' };
    m.rollout(ID.a, [meta(at(10, '08:00'), ID.a, canopy),
      said(at(10, '09:00')), answer(at(10, '09:02')), { timestamp: at(10, '09:30'), ordinal: 5, type: 'event_msg', payload: { type: 'thread_settings_applied' } }, // settings changed later: not the reply
      said(at(10, '10:00'), 'see this', true), answer(at(10, '10:15')),                                                                                              // 15 minutes
      said(at(10, '11:00')), answer(at(10, '11:01')), aborted(at(10, '11:02')), aborted(at(10, '11:03'), 'replaced')]);
    // The same chat continued in a second file (Codex splits long ones): one chat, not two.
    m.rollout(ID.a, [meta(at(10, '13:00'), ID.a, canopy), said(at(10, '13:00'))], { part: '_01a0f000-0000-7000-8000-000000000001' });
    m.rollout(ID.b, [meta(at(10, '08:00'), ID.b, { ...canopy, cwd: `${CHATS}/x` }), said(at(10, '09:00'))], { archived: true });
    m.rollout(ID.c, [meta(at(9, '08:00'), ID.c, { originator: 'Codex Desktop' }), said(at(10, '09:00'), 'hi', true), aborted(at(10, '09:01'))], { day: '2026/11/09', zst: true, archived: true });
    m.rollout(ID.d, [meta(at(9, '08:00'), ID.d, { originator: 'Codex Desktop' }), said(at(10, '09:00'))], { day: '2026/11/09', zst: true });
    // Started after the day asked for: its folder is never opened.
    m.rollout(ID.e, [meta(at(12, '08:00'), ID.e), said(at(10, '09:00'))], { day: '2026/11/12' });
    const [day] = await m.days();
    assert.deepEqual(seen(day), { msgs_codex_canopy: 5, chats_codex_canopy: 2, msgs_codex_app: 2, chats_codex_app: 2, canopy_stops: 1, canopy_images: 1, canopy_long_waits: 1, projects_n: 1 });
  } finally { m.done(); }
});

// ---------- Days ----------

test('a day is the Mac\'s local day: the same messages land on different dates in Los Angeles and Tokyo', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you('2026-11-10T04:30:00.000Z'), you('2026-11-10T15:30:00.000Z'), you('2026-11-11T07:59:59.999Z')]);
    m.rollout(ID.b, [meta('2026-11-10T04:00:00.000Z', ID.b), said('2026-11-10T04:30:00.000Z'), said('2026-11-10T15:30:00.000Z')]);
    const shape = (days) => days.map((d) => `${d.date} ${d.msgs_claude_terminal}/${d.msgs_codex_terminal}`);
    const range = { fromDate: '2026-11-09', toDate: '2026-11-11' };
    // 04:30Z is 20:30 the evening before in Los Angeles; 07:59Z on the 11th is still the 10th there.
    assert.deepEqual(shape(await inZone('America/Los_Angeles', () => m.days(range))), ['2026-11-09 1/1', '2026-11-10 2/1', '2026-11-11 0/0']);
    // In Tokyo 15:30Z is half past midnight on the 11th. (The cache from Los Angeles is not reused: see below.)
    assert.deepEqual(shape(await inZone('Asia/Tokyo', () => m.days(range))), ['2026-11-09 0/0', '2026-11-10 1/1', '2026-11-11 2/1']);
    assert.deepEqual(shape(await m.days(range)), ['2026-11-09 0/0', '2026-11-10 2/2', '2026-11-11 1/0']);
    // The scan's own process sees the Mac's zone too.
    assert.deepEqual(shape(await inZone('Asia/Tokyo', () => m.days({ ...range, child: true }))), ['2026-11-09 0/0', '2026-11-10 1/1', '2026-11-11 2/1']);
  } finally { m.done(); }
});

test('a day with a clock change is still one day, and every day in range comes back, zeros included', async () => {
  const m = mac();
  try {
    // Los Angeles falls back on 2026-11-01: that day runs 07:00Z to 08:00Z the next day, 25 hours.
    m.chat(ID.a, [you('2026-11-01T07:00:00.000Z'), you('2026-11-02T07:59:00.000Z'), you('2026-11-02T08:00:00.000Z')]);
    const days = await inZone('America/Los_Angeles', () => m.days({ fromDate: '2026-10-30', toDate: '2026-11-03' }));
    assert.deepEqual(days.map((d) => `${d.date} ${d.msgs_claude_terminal}`), ['2026-10-30 0', '2026-10-31 0', '2026-11-01 2', '2026-11-02 1', '2026-11-03 0']);
    for (const d of days) {
      assert.equal(Object.keys(d).length, 1 + SOURCES.length * 2 + 4, 'date, messages and chats per source, and four Canopy counts');
      assert.deepEqual(clean('day_summary', d), d, 'nothing here is refused by the list of what may be sent');
    }
    assert.equal(addDays('2026-11-01', 1), '2026-11-02');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // spring forward
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  } finally { m.done(); }
});

// ---------- Rough files ----------

test('damaged rows, rows cut by a read, a row too big to be a message and a half-written last row are stepped over', async () => {
  const m = mac();
  try {
    const good = [you(at(10, '09:00')), you(at(10, '09:10'), { image: true }), you(at(10, '09:20'))];
    const file = m.chat(ID.a, [
      good[0], '', 'not json at all', '{"type":"user","message":{"role":"user","content":"cut off', '\u0000\u0001� binary \u0002', '[1,2,3]', 'null', '"type":"user"',
      you('never', { text: 'a row with no time' }), you(at(10, '09:05'), { text: 'x', timestamp: 12345 }),
      row('user', at(10, '09:06'), { message: null }), row('user', at(10, '09:07'), { message: { role: 'user', content: { odd: true } } }),
      good[1], good[2],
    ]);
    // A row being written as we read: no newline yet, and not whole.
    appendFileSync(file, '{"parentUuid":null,"type":"user","message":{"role":"user","content":"still being wri');
    m.rollout(ID.b, [meta(at(10, '08:00'), ID.b), 'garbage', '{"timestamp":"2026-11-10T09:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":', said(at(10, '09:00')), '{"timestamp":"nope","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"x"}]}}}']);
    writeFileSync(path.join(m.codexHome, 'sessions', '2026', '11', '10', 'rollout-empty.jsonl'), '');
    writeFileSync(path.join(m.codexHome, 'sessions', '2026', '11', '10', 'rollout-broken.jsonl.zst'), 'this is not an archive');
    writeFileSync(path.join(m.claudeDir, 'projects', '-Users-me-app', 'notes.txt'), text([you(at(10))]));
    const want = { msgs_claude_terminal: 3, chats_claude_terminal: 1, msgs_codex_terminal: 1, chats_codex_terminal: 1 };
    const days = await m.days();
    assert.deepEqual(seen(days[0]), want);
    assert.equal(days.stats.errors, 1, 'the broken archive, and nothing else');
    // Read 64 bytes at a time, every row straddles reads; the answer is the same.
    assert.deepEqual(seen((await m.days({ chunkBytes: 64, cacheFile: null }))[0]), want);
    assert.deepEqual(seen((await m.days({ chunkBytes: 1, cacheFile: null }))[0]), want);

    // A row over 32 MB is skipped without being held in memory, and the rows after it still count.
    m.chat(ID.c, [you(at(10, '10:00')), `{"type":"user","message":{"role":"user","content":"${'x'.repeat(33 * 1024 * 1024)}"},"timestamp":"${at(10, '10:01')}"}`, you(at(10, '10:02'))], { cwd: '/Users/me/big' });
    const big = await m.days({ cacheFile: null });
    assert.equal(big[0].msgs_claude_terminal, 5);
    assert.equal(big.stats.longLines, 1);
  } finally { m.done(); }
});

test('folders that are missing, empty or not folders give zeros, and dates that make no sense are refused', async () => {
  const m = mac();
  try {
    writeFileSync(path.join(m.root, 'a-file'), 'x');
    mkdirSync(path.join(m.root, 'empty', 'projects'), { recursive: true });
    const days = await summarizeDays({ claudeDirs: [path.join(m.root, 'nope'), path.join(m.root, 'a-file'), path.join(m.root, 'empty'), null, 7], codexHome: path.join(m.root, 'no-codex'), fromDate: '2026-11-09', toDate: '2026-11-10', child: false });
    assert.deepEqual(days.map((d) => [d.date, seen(d)]), [['2026-11-09', {}], ['2026-11-10', {}]]);
    assert.deepEqual((await summarizeDays({ fromDate: '2026-11-10', toDate: '2026-11-10', child: false })).map(seen), [{}]);
    await assert.rejects(summarizeDays({ fromDate: '2026-11-10', toDate: '2026-11-09' }), RangeError);
    await assert.rejects(summarizeDays({ fromDate: '2026-02-30', toDate: '2026-03-01' }), TypeError);
    await assert.rejects(summarizeDays({ fromDate: '10/11/2026', toDate: '2026-11-10' }), TypeError);
    await assert.rejects(summarizeDays({ fromDate: '2020-01-01', toDate: '2026-11-10' }), RangeError);
    await assert.rejects(summarizeDays({}), TypeError);
  } finally { m.done(); }
});

test('the same history reached through two config folders is counted once', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10))]);
    const second = path.join(m.root, 'account-2');
    mkdirSync(second);
    (await import('node:fs')).symlinkSync(path.join(m.claudeDir, 'projects'), path.join(second, 'projects'));
    const [day] = await m.days({ claudeDirs: [m.claudeDir, second, m.claudeDir] });
    assert.equal(day.msgs_claude_terminal, 1);
  } finally { m.done(); }
});

// ---------- The cache ----------

test('the cache: a second run reads nothing, a changed file is read again, and a damaged cache heals itself', async () => {
  const m = mac();
  try {
    const a = m.chat(ID.a, [you(at(10, '09:00'), { text: 'a secret plan' })]);
    m.chat(ID.b, [you(at(10, '09:00'), { entrypoint: 'sdk-ts', cwd: '/Users/me/Secret Project' })], { cwd: '/Users/me/Secret Project' });
    m.rollout(ID.c, [meta(at(10, '08:00'), ID.c), said(at(10, '09:00'), 'another secret')]);
    const first = await m.days();
    assert.deepEqual([first.stats.scanned, first.stats.cached], [3, 0]);
    const again = await m.days();
    assert.deepEqual([again.stats.scanned, again.stats.cached, again.stats.bytes], [0, 3, 0]);
    assert.deepEqual(again, first);

    // Nothing typed and no folder is in the cache: counts, and a hash where projects are told apart.
    const saved = readFileSync(m.cacheFile, 'utf8');
    assert.ok(!saved.includes('secret') && !saved.includes('Secret Project'), 'the cache holds no text and no project path');
    assert.equal(Object.keys(JSON.parse(saved).files).length, 3, 'one entry per file read');

    // Canopy's list of chats is not part of the cache: the same cached counts land in another source.
    const known = await m.days({ canopySessionIds: { claude: [ID.b] } });
    assert.deepEqual([known.stats.scanned, known[0].msgs_claude_canopy, known[0].msgs_claude_other, known[0].projects_n], [0, 1, 0, 1]);

    // One file grows: only that one is read.
    appendFileSync(a, text([{ ...you(at(10, '09:30')), sessionId: ID.a }]));
    const grown = await m.days();
    assert.deepEqual([grown.stats.scanned, grown.stats.cached, grown[0].msgs_claude_terminal], [1, 2, 2]);

    // Same size, newer time (rewritten in place): read again.
    const later = new Date(Date.now() + 5000);
    utimesSync(a, later, later);
    assert.equal((await m.days()).stats.scanned, 1);

    // A deleted chat leaves the counts and the cache.
    rmSync(a);
    const gone = await m.days();
    assert.equal(gone[0].msgs_claude_terminal, 0);
    assert.ok(!readFileSync(m.cacheFile, 'utf8').includes(ID.a));

    // Damaged in every way a file can be: the scan starts over and writes a good one.
    for (const junk of ['', '{"v":1,"key":', 'null', '[]', '{"v":99,"files":{}}', JSON.stringify({ v: 1, key: JSON.parse(readFileSync(m.cacheFile, 'utf8')).key, files: 'no' })]) {
      writeFileSync(m.cacheFile, junk);
      const healed = await m.days();
      assert.deepEqual([healed.stats.scanned, healed.stats.cached, healed[0].msgs_codex_terminal], [2, 0, 1], JSON.stringify(junk.slice(0, 20)));
    }
    // Entries that aren't what they should be are read again; numbers that aren't counts can't get out.
    const cache = JSON.parse(readFileSync(m.cacheFile, 'utf8'));
    const [f1, f2] = Object.keys(cache.files);
    cache.files[f1] = { m: 'yesterday' };
    cache.files[f2].d = { '2026-11-10': { terminal: [-5, 'x', 1e99, null, 'nope'], canopy: 'what', open: [2.7, 1, 1, 1, [1, 2]] } };
    writeFileSync(m.cacheFile, JSON.stringify(cache));
    const odd = await m.days();
    assert.equal(odd.stats.scanned, 1);
    for (const d of odd) assert.deepEqual(clean('day_summary', d), d);

    // Counted in another timezone: not reused.
    const tokyo = await inZone('Asia/Tokyo', () => m.days());
    assert.equal(tokyo.stats.cached, 0);
    // Different rules for what is Canopy's: not reused either.
    assert.equal((await m.days()).stats.scanned, 2);
    assert.equal((await m.days({ canopyChatsDir: '/somewhere/else' })).stats.cached, 0);
  } finally { m.done(); }
});

test('the cache forgets files untouched for longer than any summary reaches back, and works without a cache file', async () => {
  const m = mac();
  try {
    const a = m.chat(ID.a, [you(at(10))]);
    const day10 = new Date(at(10, '13:00'));
    utimesSync(a, day10, day10);
    const now = Date.parse(at(12));
    assert.equal((await m.days({ now })).stats.scanned, 1);
    assert.ok(readFileSync(m.cacheFile, 'utf8').includes(ID.a));
    // Sixty days on, a summary of that day would still read the file, but the cache has let it go.
    const later = now + 60 * 24 * 3600_000;
    const old = await m.days({ now: () => later });
    assert.deepEqual([old.stats.cached, old[0].msgs_claude_terminal], [1, 1]);
    assert.ok(!readFileSync(m.cacheFile, 'utf8').includes(ID.a));
    // A file last written before the first day asked for can't hold that day's messages: not even opened.
    const skipped = await m.days({ fromDate: '2026-11-11', toDate: '2026-11-12', now });
    assert.deepEqual([skipped.stats.files, skipped.stats.scanned, skipped.stats.cached], [1, 0, 0]);
    // No cache file given, or one that can't be written: the counts are the same, just not remembered.
    assert.equal((await m.days({ cacheFile: null }))[0].msgs_claude_terminal, 1);
    const blocked = await m.days({ cacheFile: path.join(a, 'cannot', 'be', 'here.json') });
    assert.deepEqual([blocked[0].msgs_claude_terminal, blocked.stats.cacheErrors], [1, 1]);
  } finally { m.done(); }
});

test('one run reads only so much: a big first scan is finished over several runs, each keeping what it read', async () => {
  const m = mac();
  try {
    const ids = Object.values(ID);
    ids.forEach((id, i) => {
      const file = m.chat(id, [you(at(10, `09:0${i}`))], { cwd: `/Users/me/p${i}` });
      const when = new Date(Date.parse(at(10, '10:00')) + i * 60_000); // p7 is the newest
      utimesSync(file, when, when);
    });
    const budget = { bytes: 1 }; // any read goes over it, so each run reads exactly one file
    const runs = [];
    for (let i = 0; i < ids.length + 1; i++) {
      const days = await m.days({ budget });
      runs.push([days[0].msgs_claude_terminal, days.stats.scanned, days.stats.partial]);
    }
    assert.deepEqual(runs.slice(0, 3), [[1, 1, true], [2, 1, true], [3, 1, true]]);
    assert.deepEqual(runs.at(-2), [8, 1, false]);
    assert.deepEqual(runs.at(-1), [8, 0, false]);
    // Newest first: after one run on a fresh cache, the file read is the one written last.
    rmSync(m.cacheFile);
    await m.days({ budget });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(m.cacheFile, 'utf8')).files).map((f) => path.basename(path.dirname(f))), ['-Users-me-p7']);
    // Out of time is out of budget too.
    rmSync(m.cacheFile);
    const noTime = await m.days({ budget: { ms: 0 } });
    assert.deepEqual([noTime.stats.scanned, noTime.stats.partial, noTime.stats.left], [0, true, 8]);
  } finally { m.done(); }
});

// ---------- The scan's own process ----------

/** A stand-in for summary-child.mjs: a module written for the test, run as the scan's process. */
function standIn(m, name, code) {
  const file = path.join(m.root, `${name}.mjs`);
  writeFileSync(file, code);
  return pathToFileURL(file);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid) => { for (let i = 0; i < 400 && alive(pid); i++) await new Promise((r) => setTimeout(r, 5)); return !alive(pid); };
const pidIn = async (file) => { for (let i = 0; i < 2000 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 5)); return Number(readFileSync(file, 'utf8')); };

test('by default the scan runs in a process of its own, gives the same answer, and that process is gone afterwards', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10, '09:00')), you(at(10, '09:10'), { entrypoint: 'sdk-ts' })]);
    m.rollout(ID.b, [meta(at(10, '08:00'), ID.b, { originator: 'canopy' }), said(at(10, '09:00'))]);
    m.rollout(ID.c, [meta(at(9, '08:00'), ID.c, { originator: 'Codex Desktop' }), said(at(10, '09:00'))], { day: '2026/11/09', zst: true });
    const ids = { claude: new Set([ID.a]), codex: new Set() };
    const inline = await m.days({ canopySessionIds: ids, cacheFile: null });
    const apart = await m.days({ canopySessionIds: ids, child: undefined, now: () => Date.now() });
    assert.deepEqual(apart, inline);
    assert.deepEqual(seen(apart[0]), { msgs_claude_terminal: 1, chats_claude_terminal: 1, msgs_claude_canopy: 1, chats_claude_canopy: 1, msgs_codex_canopy: 1, chats_codex_canopy: 1, msgs_codex_app: 1, chats_codex_app: 1, projects_n: 1 });
    assert.equal(apart.stats.child, true);
    assert.equal(inline.stats.child, false);
    assert.deepEqual([apart.stats.files, apart.stats.scanned, apart.stats.partial], [3, 3, false], 'how the scan went comes back with it');
    assert.ok(existsSync(m.cacheFile), 'that process wrote the cache');
    assert.deepEqual(readdirSync(path.dirname(m.cacheFile)), ['summary-cache.json'], 'and left nothing half written beside it');
    assert.deepEqual(Object.keys(apart), ['0'], 'stats ride along without being one of the days');
    // The next scan reads the cache that process left, in whichever process it runs.
    assert.equal((await m.days({ canopySessionIds: ids, child: undefined })).stats.cached, 3);
  } finally { m.done(); }
});

test('the scan\'s process runs at the lowest priority and never outlives its scan', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10, '09:00'))]);
    // A stand-in that says who it is and how it was started, then does the real scan.
    const scanAt = pathToFileURL(path.resolve(import.meta.dirname, '../../../telemetry/summary-scan.mjs')).href;
    const told = path.join(m.root, 'told.json');
    const reporting = standIn(m, 'reporting', `
      import os from 'node:os';
      import { writeFileSync } from 'node:fs';
      import { scan } from ${JSON.stringify(scanAt)};
      process.once('message', async (job) => {
        writeFileSync(${JSON.stringify(told)}, JSON.stringify({ pid: process.pid, priority: os.getPriority(), execArgv: process.execArgv, asNode: process.env.ELECTRON_RUN_AS_NODE, flags: process.env.NODE_OPTIONS ?? null, zone: process.env.TZ }));
        const r = await scan(job);
        process.send({ ok: true, days: r.days, stats: r.stats });
        setInterval(() => {}, 1000); // never leaves by itself: it has to be ended
      });
      process.send({ ready: true });
    `);
    const flags = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--no-deprecation'; // set by someone for other programs
    let days;
    try { days = await m.days({ child: reporting }); } finally { if (flags === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = flags; }
    assert.equal(days[0].msgs_claude_terminal, 1);
    const child = JSON.parse(readFileSync(told, 'utf8'));
    assert.equal(child.priority, os.constants.priority.PRIORITY_LOW, 'below everything else on the Mac');
    assert.deepEqual(child.execArgv, [], 'none of this process\'s own flags');
    assert.equal(child.flags, null, 'nor Node flags from the environment');
    assert.equal(child.zone, 'UTC', 'the timezone does come along: a day is the Mac\'s local day');
    assert.equal(child.asNode, '1', 'inside Electron it must start as plain Node, never as a second Canopy');
    assert.notEqual(child.pid, process.pid);
    assert.ok(await gone(child.pid), 'ended once it had answered, though it would have stayed');
  } finally { m.done(); }
});

test('nothing crosses back from the scan\'s process but a date and counts, and an error only by its code', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10, '09:00'))]);
    // A process that answers with more than counts (it never would; this is what the boundary is for).
    const chatty = standIn(m, 'chatty', `
      process.once('message', () => process.send({ ok: true, secret: 'what was typed', days: [
        { date: '2026-11-10', msgs_claude_terminal: 2, msgs_claude_canopy: '7', chats_claude_ide: 1.5, text: 'please fix the login page', cwd: '/Users/me/app', nested: { a: 1 }, projects_n: -3, canopy_stops: 1e12 },
        { date: 'the day I was in /Users/me/app', msgs_claude_terminal: 9 }, 'a day', null, 7,
      ], stats: { files: 1, partial: false, note: '/Users/me/app/secret.txt', deep: { path: '/x' }, ms: 12 } }));
      process.send({ ready: true });
    `);
    const days = await m.days({ child: chatty });
    assert.deepEqual([...days], [{ date: '2026-11-10', msgs_claude_terminal: 2 }]);
    assert.deepEqual(days.stats, { child: true, files: 1, partial: false, ms: 12 });
    await assert.rejects(m.days({ child: standIn(m, 'not-days', `process.once('message', () => process.send({ ok: true, days: 'none' })); process.send({ ready: true });`) }), { code: 'CHILD_ANSWER' });

    // A scan that fails says which kind of failure, never the words (an error's text can name a file).
    const fails = standIn(m, 'fails', `process.once('message', () => process.send({ ok: false, code: 'EACCES', error: "EACCES: permission denied, open '/Users/me/app/secret.txt'" })); process.send({ ready: true });`);
    const err = await m.days({ child: fails }).then(() => null, (e) => e);
    assert.equal(err.code, 'EACCES');
    assert.equal(err.message, 'the summary scan failed');
    assert.ok(!/secret|permission denied/.test(`${err.message} ${err.stack}`), 'the words stayed in that process');
    const odd = standIn(m, 'odd', `process.once('message', () => process.send({ ok: false, code: '/Users/me/app is not a code' })); process.send({ ready: true });`);
    assert.equal((await m.days({ child: odd }).then(() => null, (e) => e)).code, 'Error');

    // The real one, handed a job it can't do (dates that are not dates never get this far in Canopy): it says it is
    // up, then answers with the kind of failure and not one word more.
    const { fork } = await import('node:child_process');
    const real = fork(path.resolve(import.meta.dirname, '../../../telemetry/summary-child.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const said = [];
    const left = new Promise((resolve) => real.once('exit', resolve));
    real.on('message', (msg) => { said.push(msg); if (msg.ready) real.send({ claudeDirs: [m.claudeDir], fromDate: 'the day I was in /Users/me/app', toDate: null }); });
    assert.equal(await left, 1);
    assert.deepEqual(said, [{ ready: true }, { ok: false, code: 'TypeError' }]);
  } finally { m.done(); }
});

test('a process that can\'t start is replaced by a scan in this one; one that starts and then fails is not tried twice', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10, '09:00')), you(at(10, '09:10'), { entrypoint: 'sdk-ts' })]);
    const ids = { claude: new Set([ID.a]), codex: new Set() };
    const inline = await m.days({ canopySessionIds: ids, cacheFile: null });
    // The file is not there (a packaged app that left it out, say), or it dies before saying it is up: the same
    // scan runs in this process instead, in small steps.
    const missing = await m.days({ canopySessionIds: ids, child: new URL('./no-such-child.mjs', import.meta.url), cacheFile: null });
    assert.deepEqual(missing, inline);
    assert.equal(missing.stats.child, false);
    const dies = await m.days({ canopySessionIds: ids, child: standIn(m, 'dies', 'process.exit(3);'), cacheFile: null });
    assert.deepEqual(dies, inline);
    assert.equal(dies.stats.child, false);
    const broken = await m.days({ canopySessionIds: ids, child: standIn(m, 'broken', 'this is not javascript'), cacheFile: null });
    assert.deepEqual(broken, inline);
    // Up, and then gone without an answer: an error, and no second scan in Canopy's own process.
    const crashes = standIn(m, 'crashes', `process.once('message', () => setTimeout(() => { throw new Error('crashed'); }, 5)); process.send({ ready: true });`);
    await assert.rejects(m.days({ child: crashes }), { code: 'CHILD_EXIT' });
    const leaves = standIn(m, 'leaves', `process.once('message', () => process.exit(0)); process.send({ ready: true });`);
    await assert.rejects(m.days({ child: leaves }), { code: 'CHILD_EXIT' });
  } finally { m.done(); }
});

test('a scan is ended at once when it is stopped, and when it takes too long; a cache it was writing is cleared away', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10, '09:00'))]);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(m.days({ child: undefined, signal: stopped.signal }), { code: 'ABORT_ERR' });

    // A process that is up, has its job, is half way through writing the cache, and never finishes.
    const pidFile = path.join(m.root, 'stuck.pid');
    const stuck = standIn(m, 'stuck', `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      process.once('message', (job) => {
        mkdirSync(path.dirname(job.cacheFile), { recursive: true });
        writeFileSync(job.cacheFile + '.' + process.pid + '.tmp', '{"half":');
        writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => {}, 1000);
      });
      process.send({ ready: true });
    `);
    const stopping = new AbortController();
    const run = m.days({ child: stuck, signal: stopping.signal });
    const pid = await pidIn(pidFile);
    assert.ok(alive(pid));
    assert.ok(existsSync(`${m.cacheFile}.${pid}.tmp`));
    stopping.abort(); // Canopy is quitting
    await assert.rejects(run, { code: 'ABORT_ERR' });
    assert.ok(await gone(pid), 'the process was ended, not left reading');
    for (let i = 0; i < 400 && existsSync(`${m.cacheFile}.${pid}.tmp`); i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(readdirSync(path.dirname(m.cacheFile)), [], 'what it had half written is gone');

    // The same process, nobody stopping it: it is ended when its time is up.
    rmSync(pidFile);
    const t0 = Date.now();
    await assert.rejects(m.days({ child: stuck, timeoutMs: 150 }), { code: 'TIMEOUT' });
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(await gone(await pidIn(pidFile)));
    // And the real one with a real budget is not cut short by it.
    assert.equal((await m.days({ child: undefined, timeoutMs: 60_000 }))[0].msgs_claude_terminal, 1);
  } finally { m.done(); }
});

test('the scan\'s process ends with Canopy: when the process that started it is gone, so is it', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(10, '09:00'))]);
    // A stand-in for Canopy: it starts the real child the way summary.mjs does, says the child's pid, and dies
    // without ending it.
    const { fork } = await import('node:child_process');
    const childAt = path.resolve(import.meta.dirname, '../../../telemetry/summary-child.mjs');
    const parentFile = path.join(m.root, 'parent.mjs');
    writeFileSync(parentFile, `
      import { fork } from 'node:child_process';
      const child = fork(${JSON.stringify(childAt)}, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', (msg) => { if (msg.ready) { process.send({ pid: child.pid }); } });
    `);
    const parent = fork(parentFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const { pid } = await new Promise((resolve) => parent.once('message', resolve));
    assert.ok(alive(pid), 'up and waiting for its job');
    parent.kill('SIGKILL'); // Canopy crashed
    assert.ok(await gone(pid), 'it noticed, and left');
  } finally { m.done(); }
});

// ---------- The scheduler ----------

/** What core gives the scheduler: a place to remember, and a track() that records. */
function harness({ today = '2026-11-16', counts = () => ({}), ...opts } = {}) {
  const h = {
    saved: new Map(), sent: [], asked: [], clock: Date.parse(`${today}T15:00:00.000Z`),
    state: { get: (k) => h.saved.get(k), set: (k, v) => { h.saved.set(k, v); } },
    summarize: async ({ fromDate, toDate }) => {
      h.asked.push(`${fromDate}..${toDate}`);
      const days = [];
      for (let d = fromDate; d <= toDate; d = addDays(d, 1)) days.push({ date: d, msgs_claude_terminal: 1, ...counts(d) });
      return days;
    },
    /** A scheduler as a fresh launch would make it, on the same saved state. */
    launch: (more = {}) => createSummaryScheduler({ track: (event, props) => h.sent.push({ event, ...props }), state: h.state, summarize: h.summarize, now: () => h.clock, ...opts, ...more }),
    dates: () => h.sent.map((e) => e.date),
    tomorrow: (n = 1) => { h.clock += n * 24 * 3600_000; },
  };
  return h;
}

test('scheduler: the first run sends the 30 days before today as the baseline, once', async () => {
  const h = harness();
  const s = h.launch();
  assert.deepEqual(await s.runNow(), { sent: 30 });
  assert.deepEqual(h.asked, ['2026-10-17..2026-11-15'], 'one scan for the whole month');
  assert.equal(h.sent.length, 30);
  assert.deepEqual([h.dates()[0], h.dates().at(-1)], ['2026-10-17', '2026-11-15']);
  assert.deepEqual(h.dates(), [...h.dates()].sort(), 'oldest first');
  assert.ok(h.sent.every((e) => e.event === 'day_summary' && e.baseline === true));
  assert.equal(h.saved.get('summary.lastSentDate'), '2026-11-15');
  // Later the same day, and after a restart: nothing more.
  assert.deepEqual(await s.runNow(), { sent: 0 });
  assert.deepEqual(await h.launch().runNow(), { sent: 0 });
  assert.equal(h.sent.length, 30);
  assert.equal(h.asked.length, 1, 'no scan when nothing is due');
});

test('scheduler: each finished day goes out once, days missed while away are caught up in order, and the baseline is not repeated', async () => {
  const h = harness();
  await h.launch().runNow();
  h.sent.length = 0; h.asked.length = 0;

  h.tomorrow(); // the 17th: yesterday (the install day) is finished
  assert.deepEqual(await h.launch().runNow(), { sent: 1 });
  assert.deepEqual(h.sent.map((e) => [e.date, e.baseline]), [['2026-11-16', false]]);

  h.tomorrow(5); // away for five days, back on the 22nd
  const s = h.launch();
  assert.deepEqual(await s.runNow(), { sent: 5 });
  assert.deepEqual(h.dates(), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
  assert.ok(h.sent.every((e) => e.baseline === false));
  assert.deepEqual(h.asked, ['2026-11-16..2026-11-16', '2026-11-17..2026-11-21']);
  // Every hour for the rest of the day, and across restarts: nothing.
  for (let i = 0; i < 5; i++) assert.deepEqual(await (i % 2 ? s : h.launch()).runNow(), { sent: 0 });
  assert.equal(h.sent.length, 6);

  h.tomorrow(90); // away longer than history is kept: only the days that can still be counted
  assert.deepEqual(await h.launch().runNow(), { sent: 30 });
  const today = localDate(h.clock);
  assert.deepEqual([h.dates()[6], h.dates().at(-1)], [addDays(today, -30), addDays(today, -1)]);
  assert.equal(new Set(h.dates()).size, h.sent.length, 'no day twice');
});

test('scheduler: a quit half way through neither repeats a day nor skips one', async () => {
  const h = harness();
  let allowed = 12;
  const set = h.state.set;
  h.state.set = (k, v) => { if (k === 'summary.lastSentDate' && h.sent.length > allowed) throw new Error('disk full'); set(k, v); };
  const s = h.launch();
  // The 13th day is sent but saving that fails: the run ends there.
  assert.deepEqual(await s.runNow(), { sent: 0, error: 'Error' });
  assert.equal(h.sent.length, 13);
  assert.equal(h.saved.get('summary.lastSentDate'), h.dates()[11]);
  // The same launch knows what it sent, so it carries on from the 14th.
  allowed = Infinity;
  assert.deepEqual(await s.runNow(), { sent: 17 });
  assert.equal(new Set(h.dates()).size, 30);
  assert.ok(h.sent.every((e) => e.baseline === true), 'still the baseline: decided once, at the first run');

  // A real quit in the middle (state saved through day 12, nothing after): the next launch starts at day 13.
  const q = harness();
  let quit = false;
  const first = q.launch({ track: (event, props) => { if (q.sent.length === 12) { quit = true; throw new Error('quit'); } q.sent.push({ event, ...props }); } });
  await first.runNow();
  assert.equal(quit, true);
  assert.equal(q.sent.length, 12);
  assert.deepEqual(await q.launch().runNow(), { sent: 18 });
  assert.deepEqual(q.dates(), Array.from({ length: 30 }, (_, i) => addDays('2026-10-17', i)));
  assert.ok(q.sent.every((e) => e.baseline === true));
});

test('scheduler: each day goes out under an id of its own that never changes, so a day sent twice is stored once', async () => {
  const INSTALL = '5b0c8f4e-7a1d-4c2b-9e3f-1d2a3b4c5d6e';
  const id = daySummaryId(INSTALL, '2026-11-15');
  // An id the catalog takes (it has to look like a uuid), the same every time, different for another day or install.
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(cleanEnvelope({ id, event: 'day_summary', ts: '2026-11-16T15:00:00.000Z', launch_id: INSTALL, props: { date: '2026-11-15' } }));
  assert.equal(daySummaryId(INSTALL, '2026-11-15'), id);
  assert.equal(daySummaryId(INSTALL.toUpperCase(), '2026-11-15'), id);
  assert.notEqual(daySummaryId(INSTALL, '2026-11-14'), id);
  assert.notEqual(daySummaryId('6c1d9a5f-8b2e-4d3c-af40-2e3b4c5d6e7f', '2026-11-15'), id);
  for (const [who, date] of [[null, '2026-11-15'], ['', '2026-11-15'], [42, '2026-11-15'], [INSTALL, '2026-02-30'], [INSTALL, 'yesterday'], [INSTALL, null]]) assert.equal(daySummaryId(who, date), null);

  // A quit after a day was sent and before that was written down: the next launch sends the day again, under the
  // same id, so whoever receives the two copies can keep one.
  const h = harness();
  const ids = [];
  const track = (event, props, opts) => { ids.push([props.date, opts?.id]); h.sent.push({ event, ...props }); };
  const set = h.state.set;
  let crash = true;
  h.state.set = (k, v) => { if (crash && k === 'summary.lastSentDate' && v === '2026-10-20') throw new Error('quit before it was saved'); set(k, v); };
  await h.launch({ track, installId: () => INSTALL }).runNow();
  assert.deepEqual(h.dates(), ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
  crash = false;
  await h.launch({ track, installId: INSTALL }).runNow(); // a new launch: it knows the 19th was saved, not the 20th
  assert.equal(h.dates().filter((d) => d === '2026-10-20').length, 2, 'the 20th went out twice');
  const of20 = ids.filter(([date]) => date === '2026-10-20').map(([, i]) => i);
  assert.deepEqual(of20, [daySummaryId(INSTALL, '2026-10-20'), daySummaryId(INSTALL, '2026-10-20')], 'both times under the same id');
  assert.equal(new Set(ids.map(([, i]) => i)).size, 30, 'thirty days, thirty ids');
  for (const [date, i] of ids) assert.equal(i, daySummaryId(INSTALL, date));

  // With no install id to make one from (or one that can't be read), the days still go out, under ids of their own.
  for (const installId of [undefined, null, () => null, () => { throw new Error('not yet'); }, async () => '']) {
    const plain = harness();
    const args = [];
    assert.deepEqual(await plain.launch({ installId, track: (...a) => { args.push(a.length); plain.sent.push({ event: a[0], ...a[1] }); } }).runNow(), { sent: 30 });
    assert.ok(args.every((n) => n === 2));
  }
});

test('scheduler: days before Canopy was installed are the baseline, days since are not', async () => {
  // Telemetry arrives in an update: Canopy has been here since the 10th.
  const h = harness({ installedAt: Date.parse('2026-11-10T18:00:00.000Z') });
  await h.launch().runNow();
  assert.equal(h.sent.length, 30);
  assert.deepEqual(h.sent.filter((e) => !e.baseline).map((e) => e.date), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.equal(h.saved.get('summary.baselineBefore'), '2026-11-10');
  // An install date in the future (a clock that was wrong) can't make today's days a baseline.
  const odd = harness({ installedAt: new Date('2027-01-01T00:00:00.000Z') });
  await odd.launch().runNow();
  odd.tomorrow();
  await odd.launch().runNow();
  assert.deepEqual(odd.sent.at(-1).baseline, false);
});

test('scheduler: a scan still in progress waits rather than sending low numbers, but not forever', async () => {
  const h = harness();
  let partial = 3;
  const summarize = async (range) => Object.defineProperty(await h.summarize(range), 'stats', { value: { partial: partial-- > 0 } });
  const s = h.launch({ summarize });
  for (let i = 0; i < 3; i++) assert.deepEqual(await s.runNow(), { sent: 0, partial: true });
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await s.runNow(), { sent: 30 });

  // A scan that never finishes (history too big for any budget) is sent as it is after six tries.
  const stuck = harness();
  const never = stuck.launch({ summarize: async (range) => Object.defineProperty(await stuck.summarize(range), 'stats', { value: { partial: true } }) });
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await never.runNow()).sent);
  assert.deepEqual(results, [0, 0, 0, 0, 0, 30]);
});

test('scheduler: a scan that fails or comes back short changes nothing and is tried again', async () => {
  const h = harness();
  let mode = 'throw';
  const logged = [];
  const s = h.launch({
    log: (msg) => logged.push(msg),
    summarize: async (range) => {
      if (mode === 'throw') throw Object.assign(new Error('read failed at /Users/me/secret'), { code: 'EIO' });
      const days = await h.summarize(range);
      return mode === 'short' ? days.slice(0, 10).concat(days.slice(11)) : mode === 'junk' ? 'nope' : days;
    },
  });
  assert.deepEqual(await s.runNow(), { sent: 0, error: 'EIO' });
  assert.equal(h.sent.length, 0);
  mode = 'junk';
  assert.deepEqual(await s.runNow(), { sent: 0 });
  mode = 'short'; // the 11th day is missing: the ten before it go, the rest wait
  assert.deepEqual(await s.runNow(), { sent: 10 });
  assert.equal(h.saved.get('summary.lastSentDate'), '2026-10-26');
  mode = 'ok';
  assert.deepEqual(await s.runNow(), { sent: 20 });
  assert.deepEqual(h.dates(), Array.from({ length: 30 }, (_, i) => addDays('2026-10-17', i)));
  assert.ok(logged.length >= 2 && logged.every((l) => l.startsWith('day summary: ')));

  // State that can't be read is not "first run": nothing is sent, rather than the baseline twice.
  const broken = harness();
  await broken.launch().runNow();
  broken.sent.length = 0;
  broken.tomorrow();
  broken.state.get = () => { throw new Error('unreadable'); };
  assert.deepEqual(await broken.launch().runNow(), { sent: 0, error: 'Error' });
  assert.equal(broken.sent.length, 0);
});

test('scheduler: while sharing is off nothing is counted or sent, and those days stay unsent', async () => {
  let on = false;
  const h = harness({ enabled: () => on });
  const s = h.launch();
  assert.deepEqual(await s.runNow(), { sent: 0, off: true });
  assert.deepEqual([h.asked.length, h.sent.length, h.saved.size], [0, 0, 0]);
  on = true; // somewhere to send at last (a server, where there was none): this is the first run
  assert.deepEqual(await s.runNow(), { sent: 30 });
  on = false;
  h.tomorrow(3);
  assert.deepEqual(await h.launch().runNow(), { sent: 0, off: true });
  on = true;
  h.tomorrow();
  h.sent.length = 0; h.asked.length = 0;
  assert.deepEqual(await h.launch().runNow(), { sent: 1 });
  assert.deepEqual(h.dates(), ['2026-11-19'], 'the days it was off are not sent afterwards');
});

// The days sharing was off, as telemetry keeps them (off-days.mjs): stretches of local dates, the last one open
// while it is still off. `off` is that list; the scheduler asks for it at every check.
function sharing(opts = {}) {
  const h = harness({ ...opts, offDays: () => h.off });
  h.off = [];
  return h;
}

test('scheduler: a day on which sharing was off is never sent, however much later it comes back on', async () => {
  const h = sharing();
  // An install that shares from its first run: the month before goes, as ever.
  assert.deepEqual(await h.launch().runNow(), { sent: 30 });
  h.sent.length = 0; h.asked.length = 0;
  // Turned off on the 17th (a day that began with sharing on) and back on on the 20th. No check ran in between:
  // Canopy was closed, so nothing moved the marker.
  h.off = [['2026-11-17', '2026-11-20']];
  h.tomorrow(4); // the 20th, sharing on again
  assert.deepEqual(await h.launch().runNow(), { sent: 1 });
  assert.deepEqual(h.dates(), ['2026-11-16'], 'the last day before it was turned off still goes');
  assert.deepEqual(h.asked, ['2026-11-16..2026-11-19']);
  assert.equal(h.saved.get('summary.lastSentDate'), '2026-11-19', 'the days it was off are dealt with: no check comes back to them');
  h.tomorrow(); // the 21st: yesterday was the day it came back on, off for part of it
  assert.deepEqual(await h.launch().runNow(), { sent: 0 });
  assert.equal(h.saved.get('summary.lastSentDate'), '2026-11-20');
  assert.equal(h.asked.length, 1, 'a day that is left out is not even counted');
  h.tomorrow(); // the 22nd: the 21st was on from start to end
  assert.deepEqual(await h.launch().runNow(), { sent: 1 });
  assert.deepEqual(h.dates(), ['2026-11-16', '2026-11-21']);
  // Months later nothing has changed its mind, across restarts and with the list long since trimmed.
  h.off = [];
  h.tomorrow(3);
  await h.launch().runNow();
  assert.deepEqual(h.dates(), ['2026-11-16', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
});

test('scheduler: days off in the middle of what is due are stepped over, and the days around them go', async () => {
  const h = sharing();
  await h.launch().runNow();
  h.sent.length = 0; h.asked.length = 0;
  h.off = [['2026-11-18', '2026-11-19'], ['2026-11-22', '2026-11-22']];
  h.tomorrow(9); // the 25th: the 16th to the 24th are due
  assert.deepEqual(await h.launch().runNow(), { sent: 6 });
  assert.deepEqual(h.dates(), ['2026-11-16', '2026-11-17', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24']);
  assert.equal(h.saved.get('summary.lastSentDate'), '2026-11-24');
  // A quit in the middle neither sends a left-out day nor loses its place.
  const q = sharing();
  await q.launch().runNow();
  q.sent.length = 0;
  q.off = [['2026-11-18', '2026-11-19']];
  q.tomorrow(6);
  let stop;
  stop = q.launch({ track: (event, props) => { q.sent.push({ event, ...props }); if (props.date === '2026-11-17') stop.stop(); } });
  assert.deepEqual(await stop.runNow(), { sent: 2 });
  assert.equal(q.saved.get('summary.lastSentDate'), '2026-11-17');
  assert.deepEqual(await q.launch().runNow(), { sent: 2 });
  assert.deepEqual(q.dates(), ['2026-11-16', '2026-11-17', '2026-11-20', '2026-11-21']);
});

test('scheduler: sharing turned on for the first time later sends no day it was off, and no month from before Canopy', async () => {
  // Installed on the 10th and switched off the same day, before anything was sent. Back on on the 16th.
  let on = false;
  const h = sharing({ installedAt: Date.parse('2026-11-10T18:00:00.000Z'), enabled: () => on });
  h.off = [['2026-11-10', null]];
  assert.deepEqual(await h.launch().runNow(), { sent: 0, off: true });
  on = true;
  h.off = [['2026-11-10', '2026-11-16']];
  assert.deepEqual(await h.launch().runNow(), { sent: 0 });
  assert.deepEqual([h.sent.length, h.asked.length], [0, 0], 'nothing sent, and nothing read to find that out');
  assert.equal(h.saved.get('summary.lastSentDate'), '2026-11-15');
  h.tomorrow(); // the 17th: the 16th was off until it was turned on
  assert.deepEqual(await h.launch().runNow(), { sent: 0 });
  h.tomorrow(); // the 18th: the first whole day of sharing goes
  assert.deepEqual(await h.launch().runNow(), { sent: 1 });
  assert.deepEqual(h.sent.map((e) => [e.date, e.baseline]), [['2026-11-17', false]]);
  assert.deepEqual(h.asked, ['2026-11-17..2026-11-17']);
});

test('scheduler: once sharing has been off, the days from before Canopy stay out, and the days it was on since still go', async () => {
  // Canopy since the 1st, with nowhere to send yet (so no check has ever sent anything). Off from the 5th to the
  // 7th. On the 16th there is a server, and the first run looks back a month.
  const h = sharing({ installedAt: Date.parse('2026-11-01T18:00:00.000Z') });
  h.off = [['2026-11-05', '2026-11-07']];
  assert.deepEqual(await h.launch().runNow(), { sent: 12 });
  assert.deepEqual(h.dates(), ['01', '02', '03', '04', '08', '09', '10', '11', '12', '13', '14', '15'].map((d) => `2026-11-${d}`));
  assert.ok(h.sent.every((e) => e.baseline === false), 'no day from before Canopy');
  assert.deepEqual(h.asked, ['2026-11-01..2026-11-15'], 'the scan starts where the first day that goes is');
  assert.equal(h.saved.get('summary.baselineBefore'), '2026-11-01');

  // The same install had it never been off: the month before Canopy goes too.
  const never = sharing({ installedAt: Date.parse('2026-11-01T18:00:00.000Z') });
  assert.deepEqual(await never.launch().runNow(), { sent: 30 });
  assert.equal(never.sent.filter((e) => e.baseline).length, 15);

  // A first run that was cut short, then sharing went off and came back: what was left of that month stays out.
  const cut = sharing({ installedAt: Date.parse('2026-11-10T18:00:00.000Z') });
  let stop;
  stop = cut.launch({ track: (event, props) => { cut.sent.push({ event, ...props }); if (cut.sent.length === 5) stop.stop(); } });
  assert.deepEqual(await stop.runNow(), { sent: 5 });
  assert.ok(cut.sent.every((e) => e.baseline === true));
  cut.off = [['2026-11-16', '2026-11-16']];
  cut.sent.length = 0;
  assert.deepEqual(await cut.launch().runNow(), { sent: 6 });
  assert.deepEqual(cut.sent.map((e) => [e.date, e.baseline]), ['10', '11', '12', '13', '14', '15'].map((d) => [`2026-11-${d}`, false]));
});

test('scheduler: a list of off days that says "still off", or can\'t be read, sends nothing', async () => {
  // The switch says on and the list says off since the 12th (they are saved one after the other): the list wins.
  const h = sharing();
  await h.launch().runNow();
  h.sent.length = 0;
  h.off = [['2026-11-12', null]];
  h.tomorrow(5);
  assert.deepEqual(await h.launch().runNow(), { sent: 0 });
  assert.equal(h.sent.length, 0);
  assert.equal(h.saved.get('summary.lastSentDate'), '2026-11-20');
  // Not readable: the check ends there, the marker where it was, and the next check asks again.
  const broken = sharing();
  await broken.launch().runNow();
  broken.sent.length = 0;
  broken.tomorrow(2);
  let fail = true;
  const s = broken.launch({ offDays: async () => { if (fail) throw new Error('unreadable'); return [['2026-11-16', '2026-11-16']]; } });
  assert.deepEqual(await s.runNow(), { sent: 0, error: 'Error' });
  assert.deepEqual([broken.sent.length, broken.saved.get('summary.lastSentDate')], [0, '2026-11-15']);
  fail = false;
  assert.deepEqual(await s.runNow(), { sent: 1 });
  assert.deepEqual(broken.dates(), ['2026-11-17']);
  // A list that is not one (an older file, a damaged one) is no days off: the summary goes on as it would have.
  for (const junk of [undefined, null, 'off', 42, {}, [['yesterday', null]], [[null, null]], [['2026-11-20', '2026-11-10']]]) {
    const j = sharing();
    j.off = junk;
    assert.deepEqual(await j.launch().runNow(), { sent: 30 }, JSON.stringify(junk));
  }
});

// The scheduler on the real Telemetry object, wired as src/main.mjs wires it. Only the counting is made up.
function installed(t, clock) {
  const dir = tempDir(t);
  /** One launch of Canopy on that folder. `days()`: the dates of every day_summary recorded to be sent, ever. */
  return async () => {
    const tel = createTelemetry({ dir, appVersion: '0.0.1', osVersion: '26.1', env: 'prod', now: clock.now, timers: clock.timers, fetch: fakeServer(200).fetch, environ: TEST_ENV });
    await tel.init();
    const asked = [];
    const scheduler = createSummaryScheduler({
      track: tel.track, state: tel.state, now: clock.now, installId: () => tel.status().installId,
      enabled: () => tel.status().sending, offDays: () => tel.offDays(), installedAt: () => Date.parse(tel.firstRunAt()),
      summarize: async ({ fromDate, toDate }) => {
        asked.push(`${fromDate}..${toDate}`);
        const days = [];
        for (let d = fromDate; d <= toDate; d = addDays(d, 1)) days.push({ date: d, msgs_claude_terminal: 3 });
        return days;
      },
    });
    stopFirst(t, () => tel.shutdown({ timeoutMs: 0 }));
    const days = () => tel.recent().filter((e) => e.event === 'day_summary').map((e) => e.props.date).sort();
    return { tel, scheduler, asked, days, quit: () => tel.shutdown({ timeoutMs: 0 }) };
  };
}
const DAY_MS = 24 * 3600_000;

test('with telemetry\'s own switch: switched off on the first day and on again ten days later, nothing from before is ever recorded to be sent', async (t) => {
  const clock = fakeClock(Date.parse('2026-11-10T12:00:00.000Z'));
  const launch = installed(t, clock);
  // The 10th: Canopy's first launch, and sharing switched off before the summary's first check.
  let c = await launch();
  c.tel.setEnabled(false);
  assert.deepEqual(await c.scheduler.runNow(), { sent: 0, off: true });
  await c.quit();
  // The 14th: opened and closed, still off.
  clock.advance(4 * DAY_MS);
  c = await launch();
  assert.deepEqual(await c.scheduler.runNow(), { sent: 0, off: true });
  await c.quit();
  // The 20th: switched on. It used to send the 30 days before, the ten it was off among them.
  clock.advance(6 * DAY_MS);
  c = await launch();
  c.tel.setEnabled(true);
  assert.deepEqual(c.tel.offDays(), [['2026-11-10', '2026-11-20']]);
  assert.deepEqual(await c.scheduler.runNow(), { sent: 0 });
  assert.deepEqual([c.days(), c.asked], [[], []], 'not the days it was off, not the month before Canopy, and none of it read');
  await c.quit();
  // The 21st: yesterday was off until it was switched on.
  clock.advance(DAY_MS);
  c = await launch();
  assert.deepEqual(await c.scheduler.runNow(), { sent: 0 });
  await c.quit();
  // The 22nd: the first whole day of sharing goes, and from here on every day does.
  clock.advance(DAY_MS);
  c = await launch();
  assert.deepEqual(await c.scheduler.runNow(), { sent: 1 });
  clock.advance(2 * DAY_MS);
  assert.deepEqual(await c.scheduler.runNow(), { sent: 2 });
  assert.deepEqual(c.days(), ['2026-11-21', '2026-11-22', '2026-11-23']);
  assert.ok(c.tel.recent().filter((e) => e.event === 'day_summary').every((e) => e.props.baseline === false));
});

test('with telemetry\'s own switch: an install that shares from its first run still sends the month before Canopy, once; a few days off later cost exactly those days', async (t) => {
  const clock = fakeClock(Date.parse('2026-11-10T12:00:00.000Z'));
  const launch = installed(t, clock);
  let c = await launch();
  assert.deepEqual(await c.scheduler.runNow(), { sent: 30 });
  assert.deepEqual([c.days()[0], c.days().at(-1)], ['2026-10-11', '2026-11-09']);
  assert.ok(c.tel.recent().every((e) => e.event !== 'day_summary' || e.props.baseline === true));
  await c.quit();
  // Off on the 12th, on again on the 14th, and Canopy not opened until the 16th.
  clock.advance(2 * DAY_MS);
  c = await launch();
  assert.deepEqual(await c.scheduler.runNow(), { sent: 2 });
  c.tel.setEnabled(false);
  clock.advance(2 * DAY_MS);
  c.tel.setEnabled(true);
  await c.quit();
  clock.advance(2 * DAY_MS);
  c = await launch();
  assert.deepEqual(await c.scheduler.runNow(), { sent: 1 });
  const sent = c.days();
  assert.deepEqual(sent.slice(-3), ['2026-11-10', '2026-11-11', '2026-11-15'], 'the 12th, 13th and 14th are never sent');
  assert.equal(new Set(sent).size, 33);
});

test('scheduler: active minutes come from Canopy\'s own clock, and a day goes out without them if that fails', async () => {
  const h = harness({ activeMinutesFor: async (date) => { if (date === '2026-11-14') throw new Error('no'); return date === '2026-11-15' ? 187.6 : date === '2026-11-13' ? 99999 : date === '2026-11-12' ? NaN : 0; } });
  await h.launch().runNow();
  const by = Object.fromEntries(h.sent.map((e) => [e.date, e.canopy_active_min]));
  assert.deepEqual([by['2026-11-15'], by['2026-11-14'], by['2026-11-13'], by['2026-11-12'], by['2026-11-11']], [188, undefined, 1440, undefined, 0]);
});

test('scheduler: start() checks soon and then on a timer, one check at a time, and stop() ends a scan in progress', async () => {
  const h = harness();
  let release, signalSeen;
  const slow = (range) => new Promise((resolve, reject) => {
    signalSeen = range.signal;
    release = () => h.summarize(range).then(resolve);
    range.signal.addEventListener('abort', () => reject(Object.assign(new Error('summary stopped'), { code: 'ABORT_ERR' })));
  });
  const s = h.launch({ summarize: slow, startDelayMs: 5, checkEveryMs: 20 });
  s.start(); s.start();
  await new Promise((r) => setTimeout(r, 80)); // several timer ticks while the first scan is still running
  assert.equal(typeof release, 'function', 'the first check began');
  const [a, b] = [s.runNow(), s.runNow()];
  assert.equal(a, b, 'a check in progress is shared, not started twice');
  release();
  assert.deepEqual(await a, { sent: 30 });
  assert.equal(h.asked.length, 1);

  h.tomorrow();
  await new Promise((r) => setTimeout(r, 60)); // the timer notices the new day by itself
  assert.equal(signalSeen.aborted, false);
  const running = s.runNow();
  s.stop();
  assert.equal(signalSeen.aborted, true);
  assert.deepEqual(await running, { sent: 0, error: 'ABORT_ERR' });
  assert.equal(h.sent.length, 30);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.sent.length, 30, 'stopped means stopped');

  // Stopped in the instant between a check beginning and its scan: the scan never starts.
  const q = harness();
  const quick = q.launch();
  const begun = quick.runNow();
  quick.stop();
  assert.deepEqual(await begun, { sent: 0 });
  assert.deepEqual([q.asked.length, q.sent.length], [0, 0]);
  // Stopped while days are going out: the one being sent is finished and saved, the rest wait for the next launch.
  const r = harness();
  let mid;
  mid = r.launch({ track: (event, props) => { r.sent.push({ event, ...props }); if (r.sent.length === 4) mid.stop(); } });
  assert.deepEqual(await mid.runNow(), { sent: 4 });
  assert.equal(r.saved.get('summary.lastSentDate'), r.dates()[3]);
  assert.deepEqual(await r.launch().runNow(), { sent: 26 });
  assert.equal(new Set(r.dates()).size, 30);
});

test('end to end: real counts go through the scheduler and pass the list of what may be sent, unchanged', async () => {
  const m = mac();
  try {
    m.chat(ID.a, [you(at(14, '09:00'), { entrypoint: 'sdk-ts', image: true }), reply(at(14, '09:20'), { entrypoint: 'sdk-ts' }), interrupt(at(14, '09:21'), { entrypoint: 'sdk-ts' }), you(at(15, '09:00'), { entrypoint: 'sdk-ts' })]);
    m.chat(ID.b, [you(at(2, '09:00')), you(at(14, '10:00')), you(at(16, '10:00'))]);
    m.rollout(ID.c, [meta(at(15, '08:00'), ID.c, { originator: 'Codex Desktop' }), said(at(15, '09:00'))], { day: '2026/11/15' });
    const sent = [];
    const saved = new Map();
    const scheduler = createSummaryScheduler({
      track: (event, props) => { const c = clean(event, props); assert.deepEqual(c, props, 'clean() drops and changes nothing'); sent.push(props); },
      state: { get: async (k) => saved.get(k), set: async (k, v) => { saved.set(k, v); } },
      summarize: ({ fromDate, toDate, signal }) => summarizeDays({ claudeDirs: [m.claudeDir], codexHome: m.codexHome, canopySessionIds: { claude: new Set([ID.a]), codex: new Set() }, cacheFile: m.cacheFile, canopyChatsDir: CHATS, fromDate, toDate, signal }),
      activeMinutesFor: (date) => (date === '2026-11-14' ? 42 : 0),
      installedAt: Date.parse(at(14, '08:00')),
      now: () => Date.parse(at(16, '15:00')),
    });
    assert.deepEqual(await scheduler.runNow(), { sent: 30 });
    const by = Object.fromEntries(sent.map((d) => [d.date, d]));
    assert.deepEqual(seen(by['2026-11-14']), { msgs_claude_canopy: 1, chats_claude_canopy: 1, msgs_claude_terminal: 1, chats_claude_terminal: 1, canopy_stops: 1, canopy_images: 1, canopy_long_waits: 1, projects_n: 1, canopy_active_min: 42, baseline: false });
    assert.deepEqual(seen(by['2026-11-15']), { msgs_claude_canopy: 1, chats_claude_canopy: 1, msgs_codex_app: 1, chats_codex_app: 1, projects_n: 1, baseline: false });
    assert.deepEqual(seen(by['2026-11-02']), { msgs_claude_terminal: 1, chats_claude_terminal: 1, baseline: true });
    assert.equal(by['2026-11-14'].baseline, false);
    assert.equal(by['2026-11-16'], undefined, 'today isn\'t finished');
    assert.equal(sent.filter((d) => d.baseline).length, 28);
    for (const d of sent) assert.ok(Object.values(d).every((v) => typeof v === 'number' || typeof v === 'boolean' || /^\d{4}-\d\d-\d\d$/.test(v)), 'counts, a flag and a date: nothing else');
  } finally { m.done(); }
});

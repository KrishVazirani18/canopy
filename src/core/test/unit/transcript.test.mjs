// transcript.mjs: reading where a message sits in Claude Code's saved conversation (what an edit cuts back to), and
// which rows the conversation still consists of after a cut. The rows here have the shape Claude Code 2.1.325 writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { core } from '../helpers.mjs';

const T = await core('transcript.mjs');
const missing = T.__missing ?? false;

const user = (uuid, parentUuid, text, extra = {}) => ({ type: 'user', uuid, parentUuid, timestamp: '2026-11-16T10:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra });
const reply = (uuid, parentUuid, text) => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const note = (uuid, parentUuid) => ({ type: 'attachment', uuid, parentUuid, attachment: { type: 'todo_reminder' } });

// Two turns, each ending on a row Claude Code attaches after the reply (what the next message really follows).
const TWO_TURNS = [
  user('u1', null, 'first'), note('n1', 'u1'), reply('a1', 'n1', 'ONE'), note('n2', 'a1'),
  user('u2', 'n2', 'second'), reply('a2', 'u2', 'TWO'),
];

test('rows: only the conversation’s rows are read, in order, and a half-written line is skipped', { skip: missing }, () => {
  const text = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    JSON.stringify(user('u1', null, 'hello')),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'u1' }),
    JSON.stringify(reply('a1', 'u1', 'hi')),
    '{"type":"assistant","uuid":"a2","parentUu',
  ].join('\n');
  assert.deepEqual(T.parseRows(text).map((r) => r.uuid), ['u1', 'a1']);
  assert.deepEqual(T.parseRows(''), []);
  assert.deepEqual(T.parseRows(null), []);
});

test('cut: the place to keep is the row the message followed, not the reply before it', { skip: missing }, () => {
  const cut = T.cutPoint(TWO_TURNS, 'u2');
  assert.equal(cut.at, 'n2', 'the attachment after the reply is the kept turn’s last row');
  assert.equal(cut.alone, true, 'only that message’s turn is dropped');
  assert.equal(cut.compacted, false);
  assert.deepEqual(cut.blocks, []);
  assert.equal(T.cutPoint(TWO_TURNS, 'nope'), null);
  assert.equal(T.cutPoint(null, 'u2'), null);
});

test('cut: the first message has nothing before it', { skip: missing }, () => {
  const cut = T.cutPoint(TWO_TURNS, 'u1');
  assert.equal(cut.at, null);
  assert.equal(cut.first, true);
  assert.equal(cut.alone, false, 'the second message goes too');
  assert.equal(T.cutPoint(TWO_TURNS, 'u2').first, false);
});

test('cut: a conversation that opens with hook output has a place to cut back to before its first message', { skip: missing }, () => {
  // What Claude Code saves when a SessionStart hook ran: its output comes first, and the first message follows it.
  const hook = (uuid, parentUuid) => ({ type: 'attachment', uuid, parentUuid, attachment: { type: 'hook_success' } });
  const rows = [hook('h1', null), hook('h2', 'h1'), user('u1', 'h2', 'first'), reply('a1', 'u1', 'ONE')];
  const cut = T.cutPoint(rows, 'u1');
  assert.deepEqual([cut.at, cut.first, cut.alone], ['h2', true, true], 'still the first message, but cut in place');
});

test('cut: what else was said after the message decides whether it goes alone', { skip: missing }, () => {
  const tail = (...rows) => T.cutPoint([...TWO_TURNS, ...rows], 'u2').alone;
  // Part of the same turn: tool results, notes for the model, the mark an interrupt leaves, an agent's own rows.
  assert.equal(tail({ type: 'user', uuid: 'r1', parentUuid: 'a2', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }), true);
  assert.equal(tail({ type: 'user', uuid: 'r2', parentUuid: 'a2', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }), true);
  assert.equal(tail(user('m1', 'a2', '<system-reminder>x</system-reminder>', { isMeta: true })), true);
  assert.equal(tail(user('i1', 'a2', [{ type: 'text', text: '[Request interrupted by user]' }])), true);
  assert.equal(tail(user('s1', 'a2', 'a subagent prompt', { isSidechain: true })), true);
  // Something else said: another message of yours, or a background task reporting back.
  assert.equal(tail(user('u3', 'a2', 'third')), false);
  assert.equal(tail(user('t1', 'a2', '<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } })), false);
});

test('cut: a message from before a summary is marked, and its attachments come back', { skip: missing }, () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } };
  const rows = [
    user('u1', null, [image, doc, { type: 'text', text: 'look at this' }]), reply('a1', 'u1', 'ok'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a1' },
    user('s1', 'c1', 'This session is being continued', { isCompactSummary: true }),
    user('u2', 's1', 'after'), reply('a2', 'u2', 'yes'),
  ];
  const before = T.cutPoint(rows, 'u1');
  assert.equal(before.compacted, true);
  assert.deepEqual(before.blocks, [image, doc]);
  const afterwards = T.cutPoint(rows, 'u2');
  assert.equal(afterwards.compacted, false);
  assert.equal(afterwards.at, 's1');
});

test('live rows: what an edit cut away is no longer part of the conversation', { skip: missing }, () => {
  // u2 was edited: the conversation was cut back to n2 and u2b took its place. u2 and a2 stay in the file.
  const rows = [...TWO_TURNS, user('u2b', 'n2', 'second, reworded'), reply('a2b', 'u2b', 'TWO-B')];
  const live = T.liveUuids(rows);
  assert.deepEqual([...live].sort(), ['a1', 'a2b', 'n1', 'n2', 'u1', 'u2b']);
  assert.equal(live.has('u2'), false);
  assert.equal(live.has('a2'), false);
});

test('live rows: a summarized conversation still counts what came before the summary; an agent’s rows never lead', { skip: missing }, () => {
  const rows = [
    user('u1', null, 'old'), reply('a1', 'u1', 'old reply'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a1' },
    user('u2', 'c1', 'new'), reply('a2', 'u2', 'new reply'),
    { type: 'assistant', uuid: 'x1', parentUuid: 'x0', isSidechain: true, message: { content: [] } },
  ];
  assert.deepEqual([...T.liveUuids(rows)].sort(), ['a1', 'a2', 'c1', 'u1', 'u2']);
  assert.equal(T.liveUuids([]), null);
  assert.equal(T.liveUuids(null), null);
});

test('the file is found under the folder as given or as the disk spells it, and by id when the folder name differs', { skip: missing }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-transcript-')));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const env = { CLAUDE_CONFIG_DIR: config };
  const work = path.join(root, 'my work');
  fs.mkdirSync(work, { recursive: true });
  const id = '11111111-2222-4333-8444-555555555555';
  const slug = work.replace(/[^a-zA-Z0-9]/g, '-');
  fs.mkdirSync(path.join(config, 'projects', slug), { recursive: true });
  fs.writeFileSync(path.join(config, 'projects', slug, `${id}.jsonl`), `${JSON.stringify(user('u1', null, 'hello'))}\n`);
  assert.equal(await T.transcriptFile(id, work, env), path.join(config, 'projects', slug, `${id}.jsonl`));
  assert.deepEqual((await T.transcriptRows(id, work, env)).map((r) => r.uuid), ['u1']);
  // Through a link to the folder: Claude Code files it under the real path.
  const link = path.join(root, 'link');
  fs.symlinkSync(work, link);
  assert.equal(await T.transcriptFile(id, link, env), path.join(config, 'projects', slug, `${id}.jsonl`));
  // Filed under a name we don't compute (a very long path is shortened): found by its id.
  const other = '99999999-2222-4333-8444-555555555555';
  fs.mkdirSync(path.join(config, 'projects', 'shortened-abc123'), { recursive: true });
  fs.writeFileSync(path.join(config, 'projects', 'shortened-abc123', `${other}.jsonl`), '');
  assert.equal(await T.transcriptFile(other, work, env), path.join(config, 'projects', 'shortened-abc123', `${other}.jsonl`));
  assert.equal(await T.transcriptFile('22222222-2222-4333-8444-555555555555', work, env), null);
  assert.equal(await T.transcriptRows('22222222-2222-4333-8444-555555555555', work, env), null);
  assert.equal(await T.transcriptFile('../../etc/passwd', work, env), null, 'only a session id names a file');
});

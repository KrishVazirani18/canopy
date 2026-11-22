// Chat names from the first real exchange (src/chat-titles.mjs). The SDK and the live session are stand-ins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatTitler, describe, firstExchange, hasSavedName, isSmallTalk, plain, renameChat } from '../../../chat-titles.mjs';

const you = (content) => ({ type: 'user', message: { content }, parent_tool_use_id: null });
const claude = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }, parent_tool_use_id: null });

test('isSmallTalk: greetings and "what are you up to" carry no topic; short real asks do', () => {
  for (const t of ['whatuppppp', 'what up canopy', 'what u up to', 'Hey!', 'heyyy claude', 'yo', 'how are you doing?', 'gm', 'ok thanks'])
    assert.equal(isSmallTalk(t), true, t);
  for (const t of ['How fast r u?', 'is assignment 8 done', 'white play', 'i need to book a call', 'Hey canopy, we are in canopy working for canopy.'])
    assert.equal(isSmallTalk(t), false, t);
});

test('plain: drops Claude Code markup, keeps pasted text', () => {
  assert.equal(plain('<command-name>/model</command-name> <command-args></command-args>'), '');
  assert.equal(plain('fix it <system-reminder>secret</system-reminder> now'), 'fix it now');
  assert.equal(plain('<pasted_content id="a1">Rethink Atlas</pasted_content> thoughts?'), 'Rethink Atlas thoughts?');
  assert.equal(plain('look [Image #1] here'), 'look here');
});

test('firstExchange: skips small talk and pairs the first real ask with Claude’s last reply to it', () => {
  const msgs = [
    you('what up canopy'), claude('Hey! What are we working on?'),
    you('How fast r u?'), claude('Let me check.'), toolResult(), claude('About 2s to first token; fast mode halves it.'),
    you('cool, now fix the sidebar'), claude('Done.'),
  ];
  assert.deepEqual(firstExchange(msgs), { user: 'How fast r u?', reply: 'About 2s to first token; fast mode halves it.' });
});

test('firstExchange: nothing until a real ask has a reply', () => {
  assert.equal(firstExchange([you('whatuppppp'), claude('Not much!')]), null);
  assert.equal(firstExchange([you('build a menu bar icon')]), null);
  assert.equal(firstExchange([]), null);
  // A subagent's messages and interrupted markers don't count.
  const sub = { ...claude('subagent text'), parent_tool_use_id: 'x' };
  assert.equal(firstExchange([you('[Request interrupted by user]'), you('add tests'), sub]), null);
});

test('describe: your message and the reply, clipped', () => {
  const d = describe({ user: 'a'.repeat(1000), reply: 'b'.repeat(1000) });
  assert.ok(d.startsWith('User: aaa') && d.includes('\nClaude: bbb'));
  assert.ok(d.length < 1000);
});

function fake({ named = false, messages, title = 'Response speed and fast mode' } = {}) {
  const calls = { renamed: [], titled: [], described: [] };
  const api = {
    hasSavedName: async () => (typeof named === 'function' ? named() : named),
    getSessionMessages: async () => messages ?? [you('what up canopy'), claude('Hey!'), you('How fast r u?'), claude('Pretty fast.')],
    renameSession: async (id, t, where) => { calls.renamed.push({ id, t, where }); },
  };
  const session = { generateTitle: async (d) => { calls.described.push(d); return title; } };
  const titler = new ChatTitler({ api, onTitled: (id, t) => calls.titled.push({ id, t }) });
  return { titler, session, calls };
}

test('ChatTitler: names the chat once from its first real exchange', async () => {
  const { titler, session, calls } = fake();
  await titler.afterTurn(session, 's1', '/p/canopy');
  assert.deepEqual(calls.renamed, [{ id: 's1', t: 'Response speed and fast mode', where: { dir: '/p/canopy' } }]);
  assert.deepEqual(calls.titled, [{ id: 's1', t: 'Response speed and fast mode' }]);
  assert.match(calls.described[0], /^User: How fast r u\?\nClaude: Pretty fast\.$/);
  await titler.afterTurn(session, 's1', '/p/canopy'); // later turns: never again
  assert.equal(calls.renamed.length, 1);
});

test('ChatTitler: a chat you named (or Canopy already named) is left alone', async () => {
  const { titler, session, calls } = fake({ named: true });
  await titler.afterTurn(session, 's1', '/p');
  assert.equal(calls.described.length, 0);
  assert.equal(calls.renamed.length, 0);
});

test('ChatTitler: you renaming it while the titler runs wins', async () => {
  let n = 0;
  const { titler, session, calls } = fake({ named: () => ++n > 1 });
  await titler.afterTurn(session, 's1', '/p');
  assert.equal(calls.described.length, 1);
  assert.equal(calls.renamed.length, 0);
});

test('ChatTitler: waits through small talk, then names it', async () => {
  const msgs = [you('whatuppppp'), claude('Not much!')];
  const { titler, session, calls } = fake({ messages: msgs });
  await titler.afterTurn(session, 's1', '/p');
  assert.equal(calls.described.length, 0);
  msgs.push(you('find the newest image in Downloads'), claude('It is shot.png from 2pm.'));
  await titler.afterTurn(session, 's1', '/p');
  assert.equal(calls.renamed.length, 1);
});

test('ChatTitler: no titler, an unsaved chat or a failure keeps Claude Code’s title', async () => {
  const none = fake({ title: null });
  await none.titler.afterTurn(none.session, 's1', '/p');
  assert.equal(none.calls.renamed.length, 0);
  const unsaved = fake({ named: null });
  await unsaved.titler.afterTurn(unsaved.session, 's2', '/p');
  assert.equal(unsaved.calls.described.length, 0);
  const broken = fake();
  broken.titler.api.getSessionMessages = async () => { throw new Error('disk'); };
  await broken.titler.afterTurn(broken.session, 's3', '/p'); // doesn't throw
  assert.equal(broken.calls.renamed.length, 0);
  await broken.titler.afterTurn(null, 's4', '/p'); // chat already closed
});

test('hasSavedName: a rename counts, Claude Code’s automatic title doesn’t, a missing chat is null', async () => {
  const config = mkdtempSync(path.join(os.tmpdir(), 'titles-'));
  try {
    const dir = '/p/my app';
    const folder = path.join(config, 'projects', '-p-my-app');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'auto.jsonl'), '{"type":"user"}\n{"type":"ai-title","aiTitle":"Casual greeting"}\n');
    writeFileSync(path.join(folder, 'mine.jsonl'), '{"type":"ai-title","aiTitle":"x"}\n{"type":"custom-title","customTitle":"Mine","sessionId":"mine"}\n');
    assert.equal(await hasSavedName('auto', dir, config), false);
    assert.equal(await hasSavedName('mine', dir, config), true);
    assert.equal(await hasSavedName('gone', dir, config), null);
  } finally { rmSync(config, { recursive: true, force: true }); }
});

test('renameChat: a running chat is told its new name, so it cannot write the old one back', async () => {
  const told = []; const written = [];
  const session = { rename: async (t) => { told.push(t); return true; } };
  const how = await renameChat(session, 's1', 'Mine', '/p', async (...a) => { written.push(a); });
  assert.equal(how, 'live');
  assert.deepEqual(told, ['Mine']);
  assert.equal(written.length, 0);
});

test('renameChat: no live process, or one that can’t take it, writes the transcript instead', async () => {
  const written = [];
  const write = async (...a) => { written.push(a); };
  assert.equal(await renameChat(null, 's1', 'A', '/p', write), 'file');
  assert.equal(await renameChat({ rename: async () => false }, 's2', 'B', '/p', write), 'file');
  assert.equal(await renameChat({ rename: async () => { throw new Error('gone'); } }, 's3', 'C', undefined, write), 'file');
  assert.equal(await renameChat({}, 's4', 'D', '/p', write), 'file'); // an older session object
  assert.deepEqual(written, [['s1', 'A', { dir: '/p' }], ['s2', 'B', { dir: '/p' }], ['s3', 'C', undefined], ['s4', 'D', { dir: '/p' }]]);
});

test('ChatTitler: tells the running chat its name rather than writing behind its back', async () => {
  const { titler, session, calls } = fake();
  const told = [];
  session.rename = async (t) => { told.push(t); return true; };
  await titler.afterTurn(session, 's1', '/p');
  assert.deepEqual(told, ['Response speed and fast mode']);
  assert.equal(calls.renamed.length, 0);
  assert.equal(calls.titled.length, 1);
});

// A chat that Canopy named, then had its first message edited: the saved name is whatever was last written.
function edited() {
  const state = { saved: null, messages: [you('How fast r u?'), claude('Pretty fast.')], next: 'Response speed' };
  const calls = { titled: [] };
  const api = {
    hasSavedName: async () => state.saved != null,
    getSessionMessages: async () => state.messages,
    renameSession: async (_id, t) => { state.saved = t; },
    getSessionInfo: async () => ({ customTitle: state.saved }),
  };
  const session = { generateTitle: async () => state.next };
  const titler = new ChatTitler({ api, onTitled: (id, t) => calls.titled.push({ id, t }) });
  return { titler, session, state, calls };
}

test('ChatTitler: editing the first message names the chat again, from the new first exchange', async () => {
  const { titler, session, state, calls } = edited();
  await titler.afterTurn(session, 's1', '/p');
  assert.equal(state.saved, 'Response speed');
  // The first message is replaced (the window says so once the engine has taken the edit).
  state.messages = [you('Plan the launch email'), claude('Here is a draft.')];
  state.next = 'Launch email draft';
  titler.again('s1');
  await titler.afterTurn(session, 's1', '/p');
  assert.equal(state.saved, 'Launch email draft');
  assert.deepEqual(calls.titled.map((x) => x.t), ['Response speed', 'Launch email draft']);
  await titler.afterTurn(session, 's1', '/p'); // and then it is left alone again
  assert.equal(calls.titled.length, 2);
});

test('ChatTitler: a name you gave is not replaced when the first message is edited', async () => {
  // Renamed by you after Canopy named it.
  const a = edited();
  await a.titler.afterTurn(a.session, 's1', '/p');
  a.state.saved = 'My launch plan';
  a.state.next = 'Something else';
  a.titler.again('s1');
  await a.titler.afterTurn(a.session, 's1', '/p');
  assert.equal(a.state.saved, 'My launch plan');
  assert.equal(a.calls.titled.length, 1);
  // Named before this run (by you or by Canopy: it can no longer tell which), so it is not touched.
  const b = edited();
  b.state.saved = 'From an earlier day';
  b.titler.again('s1');
  await b.titler.afterTurn(b.session, 's1', '/p');
  assert.equal(b.state.saved, 'From an earlier day');
  assert.equal(b.calls.titled.length, 0);
  // Renamed by you while the new name was being worked out.
  const c = edited();
  await c.titler.afterTurn(c.session, 's1', '/p');
  c.titler.again('s1');
  c.session.generateTitle = async () => { c.state.saved = 'Typed meanwhile'; return 'Too late'; };
  await c.titler.afterTurn(c.session, 's1', '/p');
  assert.equal(c.state.saved, 'Typed meanwhile');
  c.titler.again(null); // nothing to do, and nothing thrown
});

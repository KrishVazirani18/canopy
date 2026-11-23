// A Claude chat that was moved here from the other maker (Session's `handoff` option), driven by the scripted
// query(): the old chat's digest goes out once, as a hidden first block of the first message, and a chat that is
// not a moved one sends exactly what it always sent. No claude process is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { Session } from '../../session.mjs';
import { adaptHistory } from '../../adapter.mjs';
import { buildDigest, forClaude, isHandoffText } from '../../handoff.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-session-handoff-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const DIGEST = buildDigest([{ kind: 'user-text', text: 'Rename the helper' }, { kind: 'assistant-text', text: 'Renamed it to readRows.' }], { fromModel: 'GPT-6.1-Sol', cwd: work }).text;
const LEAD = { type: 'text', text: forClaude(DIGEST) };
const IMAGE = { mediaType: 'image/png', data: 'AAAA' };
const IMAGE_BLOCK = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
});
function make(opts = {}, script = {}) {
  const fake = createFake(script);
  const s = new Session({ cwd: work, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const contentOf = (run, i) => run.received[i].message.content;
const userRow = (uuid, parentUuid, content) => ({ type: 'user', uuid, parentUuid, origin: { kind: 'human' }, message: { role: 'user', content } });
const replyRow = (uuid, parentUuid) => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });

test('the first message goes out as the digest block, then the user\'s words; the second has no block', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  const a = s.send('carry on with the callers');
  await idle(w);
  const run = fake.current;
  assert.deepEqual(contentOf(run, 0), [LEAD, { type: 'text', text: 'carry on with the callers' }]);
  assert.equal(run.received[0].uuid, a.id);
  assert.ok(isHandoffText(contentOf(run, 0)[0].text));
  const from = w.mark();
  s.send('and the tests');
  await idle(w, from);
  assert.equal(contentOf(run, 1), 'and the tests', 'the second message is the plain string it always was');
});

test('with images the order is the block, the images, the words', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  s.send('look at this', [IMAGE]);
  await idle(w);
  assert.deepEqual(contentOf(fake.current, 0), [LEAD, IMAGE_BLOCK, { type: 'text', text: 'look at this' }]);
});

test('an image with no words still carries the block first', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  s.send('', [IMAGE]);
  await idle(w);
  assert.deepEqual(contentOf(fake.current, 0), [LEAD, IMAGE_BLOCK]);
});

test('a chat that was not moved sends byte for byte what it always sent', async () => {
  for (const opts of [{}, { handoff: null }, { handoff: {} }, { handoff: { text: '' } }, { handoff: 'text' }]) {
    const { s, fake, w } = make(opts);
    const a = s.send('hello');
    const b = s.send('look', [IMAGE]);
    await idle(w);
    assert.deepEqual(fake.current.received[0], { type: 'user', uuid: a.id, session_id: '', origin: { kind: 'human' }, parent_tool_use_id: null, message: { role: 'user', content: 'hello' } });
    assert.deepEqual(fake.current.received[1].message.content, [IMAGE_BLOCK, { type: 'text', text: 'look' }]);
    assert.equal(b.ok, true);
  }
});

test('a resumed chat never carries one', async () => {
  const { s, fake, w } = make({ resume: '6f1c2c1e-7f0a-4c57-9d49-0d6a8f1f2b11', handoff: { text: DIGEST } });
  assert.equal(s.handoff, null);
  s.send('hello again');
  await idle(w);
  assert.equal(contentOf(fake.current, 0), 'hello again');
});

test('a resumed chat gone back to carries what happened while it was away, once: given at the start or later', async () => {
  const RESUME = '6f1c2c1e-7f0a-4c57-9d49-0d6a8f1f2b11';
  const { s, fake, w } = make({ resume: RESUME, handoff: { text: DIGEST, back: true } });
  s.send('hello again');
  await idle(w);
  assert.deepEqual(contentOf(fake.current, 0), [LEAD, { type: 'text', text: 'hello again' }]);
  let from = w.mark();
  s.send('and then');
  await idle(w, from);
  assert.equal(contentOf(fake.current, 1), 'and then');
  // Gone away and back again while it stays open: told again, with the next message only.
  assert.equal(s.handBack(DIGEST), true);
  from = w.mark();
  s.send('back once more');
  await idle(w, from);
  assert.deepEqual(contentOf(fake.current, 2), [LEAD, { type: 'text', text: 'back once more' }]);
  assert.equal(s.handBack(''), false, 'nothing to tell is not a handback');
});

test('two messages sent before the chat has started: only the first carries the block', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  s.send('one');
  s.send('two');
  await idle(w);
  assert.deepEqual(contentOf(fake.current, 0), [LEAD, { type: 'text', text: 'one' }]);
  assert.equal(contentOf(fake.current, 1), 'two');
});

test('a first message that never reached Claude Code leaves the block for the next one', async () => {
  // The process dies at every start until told otherwise, so the first send is given up as failed.
  let dying = true;
  const { s, fake, w } = make({ handoff: { text: DIGEST }, extended: ['send-state'] }, { onStart(run) { if (dying) run.die(); } });
  const a = s.send('one');
  await w.waitFor((e) => e.kind === 'send-state' && e.id === a.id && ['failed', 'lost', 'cancelled'].includes(e.state), { ms: 15000, label: 'the first send given up' });
  await idle(w);
  assert.equal(s.sessionId, null);
  dying = false;
  const from = w.mark();
  s.send('two');
  await idle(w, from);
  assert.deepEqual(contentOf(fake.current, 0), [LEAD, { type: 'text', text: 'two' }]);
});

test('an edit of the first message starts the conversation over and carries the block again; a later edit does not', async () => {
  const saved = { rows: () => [] };
  const { s, fake, w } = make({ handoff: { text: DIGEST }, extended: ['send-state'], readTranscript: async () => saved.rows() });
  const a = s.send('one'); await idle(w);
  const b = s.send('two'); await idle(w, w.mark());
  saved.rows = () => [userRow(a.id, null, [LEAD, { type: 'text', text: 'one' }]), replyRow('a1', a.id), userRow(b.id, 'a1', 'two'), replyRow('b1', b.id)];

  // The second message: the conversation is cut in place, and it already holds the block.
  let from = w.mark();
  let r = await within(s.edit({ messageId: b.id, text: 'two, reworded' }), 15000, 'edit()');
  assert.deepEqual([r.ok, r.fresh], [true, false]);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', from)));
  assert.equal(contentOf(fake.current, 0), 'two, reworded');

  // The first message: nothing is kept, so the new conversation gets the block with its first message.
  saved.rows = () => [userRow(a.id, null, [LEAD, { type: 'text', text: 'one' }]), replyRow('a1', a.id)];
  from = w.mark();
  r = await within(s.edit({ messageId: a.id, text: 'one, reworded' }), 15000, 'edit()');
  assert.deepEqual([r.ok, r.fresh, r.first], [true, true, true]);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', from)));
  assert.deepEqual(contentOf(fake.current, 0), [LEAD, { type: 'text', text: 'one, reworded' }]);

  // And what is sent after that is plain again.
  from = w.mark();
  s.send('three'); await idle(w, from);
  assert.equal(contentOf(fake.current, 1), 'three');
});

test('an edit of the first message keeps its images: the block, the images, the new words', async () => {
  const saved = { rows: () => [] };
  const { s, fake, w } = make({ handoff: { text: DIGEST }, readTranscript: async () => saved.rows() });
  const a = s.send('look', [IMAGE]); await idle(w);
  saved.rows = () => [userRow(a.id, null, [LEAD, IMAGE_BLOCK, { type: 'text', text: 'look' }]), replyRow('a1', a.id)];
  const from = w.mark();
  const r = await within(s.edit({ messageId: a.id, text: 'look closer' }), 15000, 'edit()');
  assert.equal(r.ok, true);
  await idle(w, w.indexOf(w.find((e) => e.kind === 'edit', from)));
  assert.deepEqual(contentOf(fake.current, 0), [LEAD, IMAGE_BLOCK, { type: 'text', text: 'look closer' }]);
});

test('the saved conversation shows one bubble with only the user\'s words', () => {
  const at = '2026-11-16T10:00:00.000Z';
  const events = adaptHistory([
    { type: 'user', uuid: 'u1', timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content: [LEAD, IMAGE_BLOCK, { type: 'text', text: 'carry on with the callers' }] }, parent_tool_use_id: null },
    { type: 'assistant', uuid: 'a1', timestamp: at, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }] }, parent_tool_use_id: null },
  ]);
  const bubbles = events.filter((e) => e.kind === 'user-text');
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].text, 'carry on with the callers');
  assert.equal(bubbles[0].images, 1);
  assert.ok(!events.some((e) => typeof e.text === 'string' && e.text.includes('canopy_handoff')), 'the block reaches no event');
  // A message that was only the block and an image is still a bubble, of the image.
  const only = adaptHistory([{ type: 'user', uuid: 'u1', timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content: [LEAD, IMAGE_BLOCK] }, parent_tool_use_id: null }]);
  assert.deepEqual(only.filter((e) => e.kind === 'user-text').map((e) => e.text), ['[image]']);
});

test('the block is never echoed live as something the user said', async () => {
  const { s, w } = make({ handoff: { text: DIGEST } });
  s.send('carry on');
  await idle(w);
  await sleep(20);
  assert.ok(!w.events.some((e) => JSON.stringify(e).includes('canopy_handoff')), 'no event of the turn holds the block');
});

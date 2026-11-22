// A Codex chat that was moved here from the other maker (CodexSession's `handoff` option), driven by the scripted
// Codex through its knobs: the old chat's digest goes into the thread once, just before the first turn; refused, it
// rides in that turn's input instead; either way no bubble ever shows it. No Codex is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex, fixtureLines } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { adaptHistory } from '../../codex-adapter.mjs';
import { buildDigest, forCodex, isHandoffText } from '../../handoff.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-handoff-')));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const DIGEST = buildDigest([{ kind: 'user-text', text: 'Rename the helper' }, { kind: 'assistant-text', text: 'Renamed it to readRows.' }], { fromModel: 'Opus 5.5', cwd: work }).text;
const CHAT = '00000000-0000-7000-8000-432d1c714b94'; // a chat that is already on disk
const INJECTED = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: forCodex(DIGEST) }] }];

const open = [];
const fakes = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  const left = fakes.splice(0).flatMap((f) => f.alive());
  assert.equal(left.length, 0, 'every process a session started is gone once it is disposed');
});
function make(opts = {}, script = {}) {
  const fake = createFakeCodex(script);
  fakes.push(fake);
  const logs = [];
  const s = new CodexSession({
    cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: home }, spawnFn: fake.spawnFn, log: (level, msg, data) => logs.push({ level, msg, data }),
    ...opts, timeouts: { restart: 15, secondPress: 0, ...opts.timeouts },
  });
  open.push(s);
  return { s, fake, w: watch(s), logs };
}
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 4000, from, label: 'busy:false' });
const methods = (fake) => fake.received.filter((m) => typeof m.method === 'string').map((m) => m.method);
const sent = (fake, method) => fake.received.filter((m) => m.method === method);
const textsOf = (msg) => msg.params.input.filter((i) => i.type === 'text').map((i) => i.text);
const accept = (fake) => { fake.handlers['thread/inject_items'] = () => ({}); };

test('the digest goes into the thread after thread/start and before turn/start, once', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  accept(fake);
  s.send('carry on with the callers');
  await idle(w);
  const order = methods(fake).filter((m) => ['thread/start', 'thread/inject_items', 'turn/start'].includes(m));
  assert.deepEqual(order, ['thread/start', 'thread/inject_items', 'turn/start']);
  const inject = sent(fake, 'thread/inject_items')[0];
  assert.deepEqual(inject.params, { threadId: s.sessionId, items: INJECTED });
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[0]), ['carry on with the callers'], 'the turn itself is only the user\'s words');

  const from = w.mark();
  s.send('and the tests');
  await idle(w, from);
  assert.equal(sent(fake, 'thread/inject_items').length, 1, 'never a second time');
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[1]), ['and the tests']);
  assert.equal(s.handoff, null, 'let go of once the chat is on disk');
});

test('refused, the digest is the first input block and the turn still starts', async () => {
  const { s, fake, w, logs } = make({ handoff: { text: DIGEST } });
  fake.errors['thread/inject_items'] = { code: -32601, message: 'Method not found: thread/inject_items' };
  s.send('carry on with the callers');
  await idle(w);
  const turn = sent(fake, 'turn/start');
  assert.equal(turn.length, 1);
  assert.deepEqual(textsOf(turn[0]), [forCodex(DIGEST), 'carry on with the callers']);
  assert.ok(logs.some((l) => l.level === 'warn' && /goes with the first message/.test(l.msg)), 'the reason is logged');
  assert.equal(w.text(), 'OK');

  const from = w.mark();
  s.send('and the tests');
  await idle(w, from);
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[1]), ['and the tests'], 'the next message is plain');
  assert.equal(sent(fake, 'thread/inject_items').length, 1);
});

test('a chat that was not moved makes no such call and sends what it always sent', async () => {
  for (const opts of [{}, { handoff: null }, { handoff: {} }, { handoff: { text: '' } }]) {
    const { s, fake, w } = make(opts);
    s.send('hello');
    await idle(w);
    assert.equal(sent(fake, 'thread/inject_items').length, 0);
    assert.deepEqual(textsOf(sent(fake, 'turn/start')[0]), ['hello']);
    assert.equal(s.handoff, null);
  }
});

test('a resumed chat never calls it', async () => {
  const { s, fake, w } = make({ resume: CHAT, handoff: { text: DIGEST } }, { known: new Set([CHAT]) });
  accept(fake);
  assert.equal(s.handoff, null);
  s.send('hello again');
  await idle(w);
  assert.equal(sent(fake, 'thread/inject_items').length, 0);
  assert.deepEqual(textsOf(sent(fake, 'turn/start')[0]), ['hello again']);
});

test('a crash before the turn started carries again on the next start', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  accept(fake);
  let deaths = 1;
  fake.handlers['turn/start'] = (params, child) => { if (deaths-- > 0) child.die(1); };
  s.send('carry on');
  await idle(w);
  assert.equal(fake.children.length, 2, 'a second process took over');
  const injects = sent(fake, 'thread/inject_items');
  assert.equal(injects.length, 2, 'the new thread is given the digest too');
  assert.notEqual(injects[0].params.threadId, injects[1].params.threadId);
  assert.equal(injects[1].params.threadId, s.sessionId);
  assert.deepEqual(injects[1].params.items, INJECTED);
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), ['carry on']);
  assert.equal(w.text(), 'OK');
});

test('a crash during the call itself: the next start carries, and the message is sent once', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  let deaths = 1;
  fake.handlers['thread/inject_items'] = (params, child) => { if (deaths-- > 0) { child.die(1); return undefined; } return {}; };
  s.send('carry on');
  await idle(w);
  assert.equal(fake.children.length, 2);
  const turns = sent(fake, 'turn/start');
  assert.equal(turns.length, 1, 'no turn was started on the process that died');
  assert.deepEqual(textsOf(turns[0]), ['carry on']);
  assert.equal(fake.children[1].sent('thread/inject_items').length, 1);
});

test('refused, then the process dies before the turn starts: the block is not put in twice', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST } });
  fake.errors['thread/inject_items'] = { code: -32600, message: 'no' };
  let deaths = 1;
  fake.handlers['turn/start'] = (params, child) => { if (deaths-- > 0) child.die(1); };
  s.send('carry on');
  await idle(w);
  assert.deepEqual(textsOf(sent(fake, 'turn/start').at(-1)), [forCodex(DIGEST), 'carry on']);
  assert.equal(sent(fake, 'thread/inject_items').length, 1, 'a message that already carries it is not offered again');
});

test('the user bubble never shows the block: live, from the live chat\'s history, and from the saved one, both ways of delivery', async () => {
  for (const refused of [false, true]) {
    const { s, fake, w } = make({ handoff: { text: DIGEST } });
    if (refused) fake.errors['thread/inject_items'] = { code: -32600, message: 'no' }; else accept(fake);
    s.send('carry on with the callers');
    await idle(w);
    await sleep(10);
    assert.ok(!w.events.some((e) => JSON.stringify(e).includes('canopy_handoff')), `no live event holds the block (${refused ? 'refused' : 'accepted'})`);
    const h = await s.history();
    assert.equal(h.ok, true);
    assert.deepEqual(h.events.filter((e) => e.kind === 'user-text').map((e) => e.text), ['carry on with the callers']);
    // What a reopened chat is rebuilt from.
    const saved = adaptHistory(fake.turnsOf[s.sessionId], { threadId: s.sessionId });
    assert.deepEqual(saved.filter((e) => e.kind === 'user-text').map((e) => e.text), ['carry on with the callers']);
    assert.ok(!saved.some((e) => JSON.stringify(e).includes('canopy_handoff')));
  }
});

test('a saved message that is only the block and an image is a bubble of the image', () => {
  const turn = (content) => [{ id: 't1', status: 'completed', items: [{ type: 'userMessage', id: 'u1', content }], itemsView: 'full', startedAt: 1794801559 }];
  const block = { type: 'text', text: forCodex(DIGEST), text_elements: [] };
  const both = adaptHistory(turn([block, { type: 'image', url: 'data:image/png;base64,AAAA' }]), { threadId: 'x' });
  assert.deepEqual(both.filter((e) => e.kind === 'user-text').map((e) => [e.text, e.images]), [['[image]', 1]]);
  const only = adaptHistory(turn([block]), { threadId: 'x' });
  assert.deepEqual(only.filter((e) => e.kind === 'user-text'), [], 'a message that was nothing but the block is no bubble at all');
  // Words that merely mention the tag are the user's own.
  const quoting = adaptHistory(turn([{ type: 'text', text: 'what is <canopy_handoff> for?', text_elements: [] }]), { threadId: 'x' });
  assert.deepEqual(quoting.filter((e) => e.kind === 'user-text').map((e) => e.text), ['what is <canopy_handoff> for?']);
});

test('Stop pressed while the digest is going in: the turn starts and is stopped, as when Stop meets a turn being started', async () => {
  const { s, fake, w } = make({ handoff: { text: DIGEST }, extended: ['send-state'] }, { holdTurns: true });
  fake.hang.add('thread/inject_items'); // answered by hand, below
  const r = s.send('carry on');
  for (let i = 0; i < 400 && sent(fake, 'thread/inject_items').length === 0; i++) await sleep(5);
  assert.equal(sent(fake, 'thread/inject_items').length, 1);
  const stop = s.interrupt();
  fake.children[0].send({ id: sent(fake, 'thread/inject_items')[0].id, result: {} });
  await stop;
  await idle(w);
  assert.equal(sent(fake, 'turn/start').length, 1);
  assert.equal(sent(fake, 'turn/interrupt').length, 1);
  assert.equal(w.find('turn-end').interrupted, true);
  assert.ok(!w.all((e) => e.kind === 'send-state' && e.id === r.id).some((e) => e.state === 'cancelled'), 'the message was on its way, not withdrawn');
  assert.equal(s.busy, false);
});

// ---- what a real Codex does with it (fixtures/codex-inject.jsonl: one live turn on codex-cli 0.153.4) ----

test('recorded: Codex takes the digest before the first turn, the model answers from it, and it never comes back as the user\'s message', () => {
  const lines = fixtureLines('codex-inject');
  const sentAt = (method) => lines.findIndex((l) => l.dir === 'out' && l.msg.method === method);
  const answerTo = (method) => { const asked = lines[sentAt(method)]; return lines.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id)?.msg; };
  assert.ok(sentAt('thread/start') < sentAt('thread/inject_items') && sentAt('thread/inject_items') < sentAt('turn/start'), 'in the order CodexSession.carry sends them');
  const inject = lines[sentAt('thread/inject_items')].msg.params;
  assert.deepEqual(inject.items.map((i) => [i.type, i.role, i.content[0].type]), [['message', 'developer', 'input_text']]);
  assert.ok(isHandoffText(inject.items[0].content[0].text), 'what was injected is a digest as Canopy builds it');
  assert.deepEqual(answerTo('thread/inject_items').result, {}, 'accepted');
  // The turn asked for something only the digest held.
  assert.deepEqual(textsOf(lines[sentAt('turn/start')].msg), ['Reply with only the code word.']);
  const reply = lines.filter((l) => l.dir === 'in' && l.msg.method === 'item/completed').map((l) => l.msg.params.item).find((i) => i.type === 'agentMessage');
  assert.equal(reply.text.trim(), 'TANGERINE', 'the model read the injected message');
  // Read back the way a reopened chat is: the turn holds the user's message and the reply, nothing of the digest.
  const turns = answerTo('thread/turns/list').result.data;
  assert.deepEqual(turns.flatMap((t) => t.items.map((i) => i.type)), ['userMessage', 'agentMessage']);
  const events = adaptHistory(turns, { threadId: lines[sentAt('thread/turns/list')].msg.params.threadId });
  assert.deepEqual(events.filter((e) => e.kind === 'user-text').map((e) => e.text), ['Reply with only the code word.']);
  assert.ok(!JSON.stringify(events).includes('canopy_handoff'));
  // And the chat's preview, in Codex's own list and app, is the user's words.
  assert.equal(answerTo('thread/read').result.thread.preview, 'Reply with only the code word.');
  assert.deepEqual(answerTo('thread/list').result.data.map((t) => t.preview), ['Reply with only the code word.']);
});

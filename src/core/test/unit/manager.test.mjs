// manager.mjs: several live sessions behind one event stream, with idle eviction.
// The first group uses stand-in sessions; the second uses real Sessions on the
// fake query, which is what catches a mismatch between the two modules.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { core, sleep, watch } from '../helpers.mjs';

const M = await core('manager.mjs');
const S = await core('session.mjs');
const missing = M.__missing ? `manager.mjs: ${M.__missing}` : (typeof M.SessionManager === 'function' ? false : 'manager.mjs does not export SessionManager');
const noSession = missing || (S.CORE_API >= 2 ? false : 'session.mjs is not CORE_API 2');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-manager-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

class Stub extends EventEmitter {
  constructor(opts) {
    super();
    this.cwd = opts.cwd; this.sessionId = opts.resume ?? null; this.busy = false; this.closed = false;
    this.pending = new Map(); this.lifecycle = 'ready'; this.disposed = 0;
  }
  async dispose() { this.disposed++; await sleep(5); this.closed = true; }
  close() { this.closed = true; }
}

const stubs = (maxIdle = 2) => {
  const made = [];
  const m = new M.SessionManager({ maxIdle, create: (opts) => { const s = new Stub(opts); made.push(s); return s; } });
  return { m, made };
};

test('open returns a session and a manager id, and makes it active', { skip: missing }, () => {
  const { m, made } = stubs();
  const a = m.open({ cwd: '/work/a' });
  assert.equal(a.session, made[0]);
  assert.equal(typeof a.sid, 'string');
  assert.equal(a.reused, false);
  assert.equal(m.get(a.sid), made[0]);
  assert.equal(m.active.sid, a.sid);
  assert.equal(m.get('nope'), null);
  assert.equal(m.size, 1);
});

test('a live session is reused when the conversation and folder match', { skip: missing }, () => {
  const { m, made } = stubs();
  const id = randomUUID();
  const a = m.open({ cwd: '/work/a', resume: id });
  const again = m.open({ cwd: '/work/a/', resume: id });
  assert.deepEqual([again.sid, again.reused], [a.sid, true]);
  assert.equal(made.length, 1, 'no second process for the same transcript');
  const elsewhere = m.open({ cwd: '/work/b', resume: id });
  assert.equal(elsewhere.reused, false);
  const fresh = m.open({ cwd: '/work/a' });
  assert.equal(fresh.reused, false);
  assert.deepEqual(m.find({ sessionId: id, cwd: '/work/a' }).sid, a.sid);
  assert.equal(m.find({ sessionId: randomUUID() }), null);
  assert.equal(m.find({}), null);
});

test('every event gains the manager id of its session', { skip: missing }, () => {
  const { m, made } = stubs();
  const seen = [];
  m.on('event', (ev) => seen.push(ev));
  const a = m.open({ cwd: '/work/a' });
  const b = m.open({ cwd: '/work/b' });
  const original = { kind: 'text-delta', text: 'x' };
  made[0].emit('event', original);
  made[1].emit('event', { kind: 'busy', busy: true });
  assert.deepEqual(seen.map((e) => [e.kind, e.sid]), [['text-delta', a.sid], ['busy', b.sid]]);
  assert.ok(!('sid' in original), "the session's own event object is not modified");
});

test('idle sessions beyond maxIdle are disposed, least recently used first', { skip: missing }, async () => {
  const { m, made } = stubs(2);
  const opened = [];
  for (let i = 0; i < 5; i++) opened.push(m.open({ cwd: `/work/${i}` }));
  await sleep(30);
  assert.deepEqual(made.map((s) => s.closed), [true, true, false, false, false], 'the two oldest were evicted; two idle plus the active one remain');
  assert.equal(m.size, 3);
  assert.equal(m.active.sid, opened[4].sid);
  assert.equal(m.get(opened[0].sid), null);
});

test('busy sessions and sessions waiting on the user are never evicted', { skip: missing }, async () => {
  const { m, made } = stubs(0);
  m.open({ cwd: '/work/busy' });
  made[0].busy = true;
  m.open({ cwd: '/work/asking' });
  made[1].pending.set(1, {});
  m.open({ cwd: '/work/idle' });
  m.open({ cwd: '/work/active' });
  await sleep(30);
  assert.deepEqual(made.map((s) => s.closed), [false, false, true, false]);
  made[0].busy = false;
  made[0].emit('event', { kind: 'busy', busy: false });
  await sleep(30);
  assert.equal(made[0].closed, true, 'going idle makes a background session evictable');
});

test('sessions the host keeps on screen are never evicted', { skip: missing }, async () => {
  const { m, made } = stubs(0);
  const pane = m.open({ cwd: '/work/pane' });
  m.onScreen.add(pane.sid);
  m.open({ cwd: '/work/idle' });
  m.open({ cwd: '/work/active' });
  await sleep(30);
  assert.deepEqual(made.map((s) => s.closed), [false, true, false], 'the pane stays; the idle one off screen goes');
  m.onScreen.delete(pane.sid);
  m.open({ cwd: '/work/next' });
  await sleep(30);
  assert.equal(made[0].closed, true, 'off screen again, it is evictable like any other');
});

test('a chat with a prompt scheduled to wake it is never evicted, until the prompt is gone', { skip: missing }, async () => {
  const { m, made } = stubs(0);
  const waiting = m.open({ cwd: '/work/reminder' });
  made[0].scheduledCount = 1;
  m.open({ cwd: '/work/idle' });
  m.open({ cwd: '/work/active' });
  for (let i = 0; i < 4; i++) m.open({ cwd: `/work/more-${i}` });
  await sleep(30);
  assert.equal(made[0].closed, false, 'its process holds the prompt: let go, the prompt would never fire');
  assert.equal(made[1].closed, true, 'an idle chat with nothing scheduled goes as before');
  assert.equal(m.get(waiting.sid), made[0]);
  assert.equal(m.list().find((x) => x.sid === waiting.sid).working, false, 'it is idle, not working: it just has to stay');
  // The prompt fired (a turn, then idle again) and nothing is scheduled anymore.
  made[0].scheduledCount = 0;
  made[0].emit('event', { kind: 'busy', busy: false });
  await sleep(30);
  assert.equal(made[0].closed, true, 'evictable like any other from then on');
});

test('close waits for the session, closeAll for all of them', { skip: missing }, async () => {
  const { m, made } = stubs();
  const closed = [];
  m.on('closed', (e) => closed.push(e.reason));
  const a = m.open({ cwd: '/work/a' });
  m.open({ cwd: '/work/b' });
  assert.deepEqual(await m.close(a.sid), { ok: true });
  assert.equal(made[0].closed, true);
  assert.deepEqual(await m.close(a.sid), { ok: false });
  assert.deepEqual(await m.close('nope'), { ok: false });
  await m.closeAll();
  assert.deepEqual(made.map((s) => s.closed), [true, true]);
  assert.equal(m.size, 0);
  assert.equal(m.active, null);
  assert.deepEqual(closed, ['closed', 'closed']);
  assert.ok(made.every((s) => s.disposed === 1), 'each session is disposed exactly once');
});

// The `create` seam is engine-neutral: a host may hand back a Claude session for one chat and a Codex session
// (codex-session.mjs) for the next. Here the Codex one is real, on the scripted stand-in for its app-server.
test('one manager holds a Claude chat and a Codex chat: find, eviction and whenClosed treat them alike', { skip: missing }, async () => {
  const { createFakeCodex } = await import('../fake-codex.mjs');
  const { CodexSession } = await import('../../codex-session.mjs');
  const fake = createFakeCodex({ holdTurns: true });
  const work = fs.mkdtempSync(path.join(root, 'two-engines-'));
  const made = [];
  const m = new M.SessionManager({
    maxIdle: 0,
    create: (o) => {
      const s = o.engine === 'codex'
        ? new CodexSession({ cwd: o.cwd, resume: o.resume, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: root }, spawnFn: fake.spawnFn })
        : new Stub(o);
      made.push(s);
      return s;
    },
  });
  const seen = [];
  const closed = [];
  m.on('event', (ev) => seen.push(ev));
  m.on('closed', (c) => closed.push(c));

  const claudeId = randomUUID();
  const claude = m.open({ cwd: work, resume: claudeId });
  const codex = m.open({ cwd: work, engine: 'codex' });
  assert.equal(made[0] instanceof Stub, true);
  assert.equal(made[1].engine, 'codex');
  await sleep(30);
  assert.equal(made[0].closed, true, 'the idle Claude chat was let go when the Codex chat came to the front');

  // A Codex chat has no id until its first turn starts; from then on it is found like any other.
  assert.equal(codex.session.sessionId, null);
  codex.session.send('hello');
  const end = Date.now() + 3000;
  while (!codex.session.sessionId && Date.now() < end) await sleep(5);
  const id = codex.session.sessionId;
  assert.equal(typeof id, 'string');
  assert.equal(m.find({ sessionId: id, cwd: work }).sid, codex.sid);
  assert.equal(m.open({ cwd: work, resume: id, engine: 'codex' }).reused, true, 'no second process on the same chat');
  assert.equal(seen.filter((e) => e.sid === codex.sid).some((e) => e.kind === 'init' && e.sessionId === id), true);
  assert.deepEqual(m.list().map((e) => [e.sessionId, e.working]), [[id, true]]);

  // Working: another chat in front does not evict it. Idle: it does, and whenClosed waits for its process.
  const other = m.open({ cwd: work });
  await sleep(30);
  assert.equal(codex.session.closed, false, 'a Codex chat mid-turn is never evicted');
  assert.equal(fake.alive().length, 1);
  fake.last.playText('done');
  while (m.get(codex.sid) && Date.now() < end) await sleep(5); // let go the moment it went idle
  assert.equal(m.get(codex.sid), null, 'going idle in the background makes it evictable');
  await m.whenClosed(id);
  assert.equal(codex.session.closed, true);
  assert.equal(fake.alive().length, 0, 'its process is gone by the time whenClosed resolves');
  assert.deepEqual(closed.find((c) => c.sid === codex.sid), { sid: codex.sid, sessionId: id, reason: 'evicted' });
  assert.equal(m.find({ sessionId: id }), null);
  assert.equal(m.active.sid, other.sid);
  assert.equal(claude.reused, false);
  await m.closeAll();
});

test('with real sessions: idle ones are evicted, a working one is kept, events carry sid', { skip: noSession }, async () => {
  const fakes = [];
  const m = new M.SessionManager({
    maxIdle: 1,
    create: (opts) => {
      const fake = createFake();
      fakes.push(fake);
      return new S.Session({ claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: root, CLAUDE_CONFIG_DIR: root }, trusted: true, queryFn: fake.queryFn, ...opts });
    },
  });
  const events = [];
  m.on('event', (ev) => events.push(ev));
  const dirs = ['a', 'b', 'c', 'd'].map((n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d; });

  const first = m.open({ cwd: dirs[0] });
  const w = watch(first.session);
  first.session.send('hello');
  await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000 });
  assert.ok(events.length > 0 && events.every((e) => e.sid === first.sid));
  assert.equal(m.list()[0].working, false, 'an idle session with no background work is not "working"');

  const again = m.open({ cwd: dirs[0], resume: first.session.sessionId });
  assert.deepEqual([again.reused, again.sid], [true, first.sid]);

  const second = m.open({ cwd: dirs[1] });
  const third = m.open({ cwd: dirs[2] });
  const fourth = m.open({ cwd: dirs[3] });
  await sleep(300);
  assert.equal(first.session.closed, true, 'the least recently used idle session is disposed');
  assert.equal(second.session.closed, true);
  assert.equal(third.session.closed, false);
  assert.equal(fourth.session.closed, false);
  assert.equal(m.size, 2);
  assert.equal(fakes[0].runs[0].closed, true, 'its process was closed');

  // A session in the middle of a turn survives any number of newer ones.
  const w3 = watch(third.session);
  third.session.send('long');
  const release = fakes[2].current.hold();
  await w3.waitFor('text-delta', { ms: 3000 });
  m.open({ cwd: dirs[0] });
  m.open({ cwd: dirs[1] });
  await sleep(100);
  assert.equal(third.session.closed, false, 'a busy session is never evicted');
  release();
  await m.closeAll({ graceMs: 100 });
  assert.equal(m.size, 0);
});

test('with real sessions: a reminder Claude set keeps its chat alive while newer chats come and go', { skip: noSession }, async () => {
  const reminder = [{ id: '52e1447c', schedule: '0 9 1 1 *', recurring: false, prompt: 'say hi' }];
  let scheduled = reminder;
  const m = new M.SessionManager({
    maxIdle: 0,
    create: (opts) => {
      // Only the first chat has anything scheduled; the Stop hook of each turn says what is.
      const fake = createFake({ crons: () => (opts.cwd.endsWith('/r0') ? scheduled : []) });
      return new S.Session({ claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: root, CLAUDE_CONFIG_DIR: root }, trusted: true, queryFn: fake.queryFn, ...opts });
    },
  });
  const dirs = ['r0', 'r1', 'r2', 'r3'].map((n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d; });
  const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from });

  const first = m.open({ cwd: dirs[0] });
  const w = watch(first.session);
  first.session.send('remind me on new year\'s day');
  await idle(w);
  assert.equal(first.session.scheduledCount, 1);
  const plain = m.open({ cwd: dirs[1] });
  const w1 = watch(plain.session);
  plain.session.send('hello');
  await idle(w1);
  m.open({ cwd: dirs[2] });
  m.open({ cwd: dirs[3] });
  await sleep(200);
  assert.equal(plain.session.closed, true, 'an idle chat with nothing scheduled is let go');
  assert.equal(first.session.closed, false, 'the one with the reminder is kept');

  // The reminder fires, or Claude deletes it: at the end of that turn nothing is scheduled, and the chat can go.
  scheduled = [];
  const mark = w.mark();
  first.session.send('never mind, cancel it');
  await idle(w, mark);
  assert.equal(first.session.scheduledCount, 0);
  await sleep(200);
  assert.equal(first.session.closed, true);
  await m.closeAll({ graceMs: 100 });
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { ChatHost } from '../../../chats.mjs';

class Stub extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, { cwd: opts.cwd, sessionId: opts.resume, busy: false, pending: new Map(), lifecycle: 'ready' }); }
  send(text) { return { id: text }; }
  async dispose() {}
}

async function setup(t) {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const sent = [];
  const host = new ChatHost({ create: (o) => new Stub(o), send: (channel, payload) => sent.push({ channel, payload }), maxIdle: 0 });
  await host.open('/main', 'main');
  const pane = await host.openPane('/pane', 'pane');
  host.setShown([], [pane.sid]); // Multi mode off; its mounted store still needs events
  return { host, pane, sent };
}

test('a hidden cached pane stays synchronized without marking its reply read or suppressing its sound', async (t) => {
  const { host, pane, sent } = await setup(t);
  pane.session.emit('event', { kind: 'text-delta', text: 'still working' });
  pane.session.emit('event', { kind: 'turn-end', text: 'finished' });
  assert.deepEqual(sent.filter((e) => e.channel === 'session:event').map((e) => e.payload.kind), ['text-delta', 'turn-end']);
  assert.equal(host.statusList().find((s) => s.sid === pane.sid).unread, true);
  assert.ok(sent.some((e) => e.channel === 'chats:done' && e.payload.sid === pane.sid));
  host.setShown([pane.sid], [pane.sid]);
  assert.equal(host.statusList().find((s) => s.sid === pane.sid).unread, false);
});

test('cached panes stay live across mode switches and can be released when their pane closes', async (t) => {
  const { host, pane, sent } = await setup(t);
  for (let i = 0; i < 10; i++) host.setShown(i % 2 ? [] : [pane.sid], [pane.sid]);
  await host.open('/another', 'another'); // maxIdle=0: any unprotected idle chat is evicted
  assert.equal(host.manager.get(pane.sid), pane.session);
  assert.equal((await host.openPane('/pane', 'pane')).reused, true);
  host.setShown([]);
  await host.open('/last', 'last');
  await host.manager.whenClosed('pane');
  assert.equal(host.manager.get(pane.sid), null);
  assert.ok(!sent.some((e) => e.channel === 'pane:closed' && e.payload.sid === pane.sid), 'a deliberately released pane must not reopen');
});

test('a queued message sent while its pane is cached reaches that pane store', async (t) => {
  const { host, pane, sent } = await setup(t);
  host.queueAdd(pane.sid, 'next message', []);
  mock.timers.tick(120);
  const event = sent.find((e) => e.channel === 'session:event' && e.payload.kind === 'queue');
  assert.equal(event?.payload.sent.text, 'next message');
  assert.deepEqual(event.payload.queue, []);
});

test('a cached pane is told when its session closes so it can reconnect', async (t) => {
  const { host, pane, sent } = await setup(t);
  await host.manager.close(pane.sid);
  assert.ok(sent.some((e) => e.channel === 'pane:closed' && e.payload.sid === pane.sid));
  assert.equal(host.cached.has(pane.sid), false);
});

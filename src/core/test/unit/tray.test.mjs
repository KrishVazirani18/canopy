// The menu bar icon (src/tray.mjs) and what feeds it (ChatHost's onStatus in src/chats.mjs).
// Electron is a stand-in: these check what the icon and menu say, not how macOS draws them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ANIMATION, MenuBar, menuSections, summarize } from '../../../tray.mjs';
import { ChatHost } from '../../../chats.mjs';

const chat = (o) => ({ sid: o.sessionId ?? 'x', sessionId: 's1', cwd: '/p/canopy', state: 'idle', unread: false, title: null, helpers: 0, ...o });

test('summarize: idle, working, needs you, and when a count shows', () => {
  assert.deepEqual(summarize([]), { icon: 'idle', title: '', needs: 0, working: 0 });
  assert.equal(summarize([chat({ state: 'done' })]).icon, 'idle');
  assert.deepEqual(summarize([chat({ state: 'working' })]), { icon: 'working', title: '', needs: 0, working: 1 });
  const two = summarize([chat({ sessionId: 'a', state: 'working' }), chat({ sessionId: 'b', state: 'idle', helpers: 2 })]);
  assert.deepEqual(two, { icon: 'working', title: '2', needs: 0, working: 2 }); // helpers still running count as busy
  const needs = summarize([chat({ sessionId: 'a', state: 'working' }), chat({ sessionId: 'b', state: 'needs-you' })]);
  assert.equal(needs.icon, 'needs-you');
  assert.equal(needs.title, ''); // one chat needs you: the dot says it
  // A chat Claude Code hasn't started yet (no session id) is not shown or counted.
  assert.equal(summarize([chat({ sessionId: null, state: 'working' })]).icon, 'idle');
});

test('menuSections: only chats worth going back to, most urgent section first', () => {
  const list = [
    chat({ sessionId: 'idle', state: 'idle' }),
    chat({ sessionId: 'read', state: 'done' }),
    chat({ sessionId: 'unread', state: 'done', unread: true }),
    chat({ sessionId: 'work', state: 'working' }),
    chat({ sessionId: 'helpers', state: 'idle', helpers: 2 }),
    chat({ sessionId: 'ask', state: 'needs-you' }),
    chat({ sessionId: null, state: 'working' }),
  ];
  assert.deepEqual(menuSections(list).map((s) => [s.label, s.chats.map((c) => c.sessionId)]),
    [['Needs you', ['ask']], ['Working', ['work', 'helpers']], ['Finished', ['unread']]]);
  assert.deepEqual(menuSections([chat({ state: 'idle' })]), []);
  assert.equal(menuSections(Array.from({ length: 30 }, (_, i) => chat({ sessionId: `s${i}`, state: 'working' })))[0].chats.length, 6);
});

function fakeElectron() {
  const trays = [];
  class Tray extends EventEmitter {
    constructor(image) { super(); this.image = image; this.title = ''; this.popped = []; trays.push(this); }
    setImage(i) { this.image = i; }
    setTitle(t) { this.title = t; }
    setToolTip(t) { this.tip = t; }
    popUpContextMenu(m) { this.popped.push(m); }
    destroy() { this.destroyed = true; }
  }
  return {
    trays, reduceMotion: false,
    Tray,
    Menu: { buildFromTemplate: (t) => ({ items: t }) },
    nativeImage: { createFromPath: (p) => ({ path: p }) },
    systemPreferences: { getAnimationSettings() { return { prefersReducedMotion: this.owner.reduceMotion }; } },
  };
}
function menuBar(calls = []) {
  const electron = fakeElectron();
  electron.systemPreferences.owner = electron;
  const bar = new MenuBar({
    electron, assets: '/a', version: () => '1.2.3',
    onOpenChat: (c) => calls.push(['open', c]), onNewChat: () => calls.push(['new']), onShow: () => calls.push(['show']), onQuit: () => calls.push(['quit']),
  });
  return { bar, tray: electron.trays[0], electron };
}

test('MenuBar: icon follows the chats; the tree animates only while working', async (t) => {
  const { bar, tray } = menuBar();
  t.after(() => bar.destroy());
  assert.equal(tray.image.path, '/a/idleTemplate.png');
  bar.update([chat({ state: 'working' })]);
  assert.equal(tray.image.path, '/a/working-0Template.png');
  assert.ok(bar.timer, 'animating');
  await new Promise((r) => setTimeout(r, 900));
  assert.notEqual(tray.image.path, '/a/working-0Template.png', 'moved to another frame');
  bar.update([chat({ sessionId: 'a', state: 'working' }), chat({ sessionId: 'b', state: 'working' })]);
  assert.equal(tray.title, '2');
  assert.ok(bar.timer, 'still animating: same icon, only the count changed');
  bar.update([chat({ sessionId: 'a', state: 'needs-you' })]);
  assert.equal(tray.image.path, '/a/needs-youTemplate.png');
  assert.equal(bar.timer, null);
  assert.equal(tray.title, '');
  bar.update([]);
  assert.equal(tray.image.path, '/a/idleTemplate.png');
  bar.destroy();
  assert.ok(tray.destroyed);
});

test('MenuBar: grows in from rest, then loops the breath; back from "needs you" it only breathes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { bar, tray } = menuBar();
  t.after(() => bar.destroy());
  const { grow, loop, frameMs } = ANIMATION;
  const frame = () => Number(tray.image.path.match(/working-(\d+)Template/)[1]);
  bar.update([chat({ state: 'working' })]);
  assert.equal(frame(), 0);
  t.mock.timers.tick(frameMs * (grow + loop - 1));
  assert.equal(frame(), grow + loop - 1, 'the last frame');
  t.mock.timers.tick(frameMs);
  assert.equal(frame(), grow, 'wraps to the start of the breath, not the growth');
  bar.update([chat({ state: 'needs-you' })]);
  bar.update([chat({ state: 'working' })]);
  assert.equal(frame(), grow);
});

test('MenuBar: Reduce Motion holds one frame', (t) => {
  const { bar, tray, electron } = menuBar();
  t.after(() => bar.destroy());
  electron.reduceMotion = true;
  bar.update([chat({ state: 'working' })]);
  assert.equal(tray.image.path, `/a/working-${ANIMATION.grow + 18}Template.png`);
  assert.equal(bar.timer, null);
});

test('MenuBar: a quiet menu when nothing needs attention; sections when something does', (t) => {
  const calls = [];
  const { bar, tray } = menuBar(calls);
  t.after(() => bar.destroy());
  const labels = (items) => items.map((i) => (i.type === 'separator' ? '—' : i.type === 'header' ? `[${i.label}]` : i.label));
  bar.update([chat({ state: 'idle', title: 'Old chat' })]);
  assert.deepEqual(labels(bar.template()), ['Open Canopy', 'New Chat', '—', 'Canopy 1.2.3', 'Quit Canopy']);
  bar.update([
    chat({ sessionId: 'a', state: 'working', title: 'Fix the sidebar' }),
    chat({ sessionId: 'b', state: 'needs-you', title: null }),
    chat({ sessionId: 'c', state: 'done', unread: true, title: 'x'.repeat(80) }),
  ]);
  tray.emit('click');
  const items = tray.popped.at(-1).items;
  assert.deepEqual(labels(items).map((l) => l.slice(0, 16)),
    ['Open Canopy', 'New Chat', '—', '[Needs you]', 'New chat', '[Working]', 'Fix the sidebar', '[Finished]', 'xxxxxxxxxxxxxxxx', '—', 'Canopy 1.2.3', 'Quit Canopy']);
  assert.equal(items[8].label.length, 44);
  items[6].click();
  assert.deepEqual(calls.at(-1), ['open', { sessionId: 'a', cwd: '/p/canopy' }]);
  assert.equal(items.find((i) => i.label === 'Canopy 1.2.3').enabled, false);
  for (const label of ['Open Canopy', 'New Chat', 'Quit Canopy']) items.find((i) => i.label === label).click();
  assert.deepEqual(calls.slice(-3), [['show'], ['new'], ['quit']]);
});

// ChatHost feeding the menu bar, with stand-in sessions.
class Stub extends EventEmitter {
  constructor(opts) { super(); this.cwd = opts.cwd; this.sessionId = opts.resume ?? null; this.busy = false; this.closed = false; this.pending = new Map(); this.lifecycle = 'ready'; }
  async dispose() { this.closed = true; }
  close() { this.closed = true; }
}
function host() {
  const lists = [];
  const sessions = [];
  const h = new ChatHost({ create: (o) => { const s = new Stub(o); sessions.push(s); return s; }, send: () => {}, onStatus: (l) => lists.push(l), maxIdle: 8 });
  return { h, lists, sessions, last: () => lists.at(-1) };
}

test('ChatHost onStatus: state and titles reach the menu bar', async () => {
  const { h, sessions, last } = host();
  await h.open('/p/canopy', null);
  const s = sessions[0];
  h.noteSent('  please   fix the sidebar  ');
  s.emit('event', { kind: 'init', sessionId: 'S1' });
  assert.equal(last()[0].title, 'please fix the sidebar');
  assert.equal(last()[0].active, true);
  s.emit('event', { kind: 'busy', busy: true });
  assert.equal(last()[0].state, 'working');
  s.emit('event', { kind: 'permission', title: 'Run ls' });
  assert.equal(last()[0].state, 'needs-you');
  h.noteSent('a second message');
  h.setTitle('S1', 'Sidebar fix');
  assert.equal(last()[0].title, 'Sidebar Fix', "Claude Code's name replaces the first message, in Title Case");
  s.emit('event', { kind: 'turn-end' });
  assert.equal(last()[0].state, 'done');
});

test('ChatHost onStatus: a change in running helpers is reported even when the state is not', async () => {
  const { h, sessions, lists, last } = host();
  await h.open('/p/canopy', null);
  const s = sessions[0];
  s.emit('event', { kind: 'init', sessionId: 'S1' });
  const n = lists.length;
  s.emit('event', { kind: 'tasks', tasks: [{ status: 'running' }, { status: 'completed' }] });
  assert.equal(lists.length, n + 1);
  assert.equal(last()[0].helpers, 1);
  s.emit('event', { kind: 'tasks', tasks: [{ status: 'running' }] });
  assert.equal(lists.length, n + 1, 'same count: nothing new to report');
});

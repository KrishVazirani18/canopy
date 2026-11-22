// The small things telemetry keeps beside the queue: active minutes (activity.mjs), who this install is and whether
// sharing is on (identity.mjs), the "what's sent" list (recent.mjs), the key/value store and chat ids (state.mjs),
// and the days sharing was off (off-days.mjs).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { IDLE_LIMIT_SECS, createActivity, localDate } from '../../../telemetry/activity.mjs';
import { createIdentity } from '../../../telemetry/identity.mjs';
import { OFF_STRETCHES_MAX, offFrom, offUntil, readOffDays, wasOff } from '../../../telemetry/off-days.mjs';
import { RECENT_MAX, createRecent } from '../../../telemetry/recent.mjs';
import { createSessionLog, createState } from '../../../telemetry/state.mjs';
import { fakeClock, tempDir } from '../telemetry-fakes.mjs';

const MIN = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- active minutes ----

test('a minute counts when the window is in front and the person is at the Mac, and only then', async (t) => {
  const clock = fakeClock();
  let focused = true;
  let idle = 0;
  const a = createActivity({ file: path.join(tempDir(t), 'activity.json'), isFocused: () => focused, idleSeconds: () => idle, now: clock.now });
  await a.load();
  const today = localDate(clock.now());
  assert.equal(a.sample(), today);
  idle = IDLE_LIMIT_SECS - 1;
  assert.equal(a.sample(), today);
  idle = IDLE_LIMIT_SECS;
  assert.equal(a.sample(), null, 'two minutes untouched: away');
  idle = 0;
  focused = false;
  assert.equal(a.sample(), null, 'another app is in front');
  assert.equal(a.minutes(today), 2);
  assert.equal(a.minutes('2020-01-01'), 0);
  assert.equal(a.minutes(undefined), 0);
  await a.settled();
});

test('minutes are kept per local day and survive a restart', async (t) => {
  const file = path.join(tempDir(t), 'activity.json');
  const clock = fakeClock(new Date(2026, 10, 16, 23, 58).getTime());
  const a = createActivity({ file, isFocused: () => true, idleSeconds: () => 0, now: clock.now });
  await a.load();
  for (let i = 0; i < 4; i++) { a.sample(); clock.advance(MIN); } // 23:58, 23:59, 00:00, 00:01
  assert.equal(a.minutes('2026-11-16'), 2);
  assert.equal(a.minutes('2026-11-17'), 2);
  await a.settled();

  const b = createActivity({ file, isFocused: () => true, idleSeconds: () => 0, now: clock.now });
  b.sample(); // counted before the file is read: added to it, not lost
  await b.load();
  assert.equal(b.minutes('2026-11-16'), 2);
  assert.equal(b.minutes('2026-11-17'), 3);
});

test('this launch reports minutes open by the clock and minutes in use, never more than the schema takes', async (t) => {
  const clock = fakeClock();
  let focused = true;
  const a = createActivity({ file: path.join(tempDir(t), 'activity.json'), isFocused: () => focused, idleSeconds: () => 0, now: clock.now });
  for (let i = 0; i < 10; i++) { clock.advance(MIN); focused = i < 4; a.sample(); }
  assert.deepEqual(a.session(), { open_min: 10, active_min: 4 });
  clock.advance(30 * 24 * 60 * MIN); // left open over a month
  assert.equal(a.session().open_min, 10080);
  await a.settled();
});

test('questions that throw or answer nonsense, and a damaged file, count nothing and break nothing', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'activity.json');
  writeFileSync(file, '{"days": {"2026-11-16": 7, "not-a-date": 5, "2026-11-15": -3, "2026-11-14": "many", "2026-11-13": 99999}');
  const broken = createActivity({ file, isFocused: () => { throw new Error('no window'); }, idleSeconds: () => 0 });
  await broken.load();
  assert.equal(broken.sample(), null);
  assert.equal(broken.minutes('2026-11-16'), 0, 'the file was cut short: nothing is read from it');

  writeFileSync(file, '{"days": {"2026-11-16": 7, "not-a-date": 5, "2026-11-15": -3, "2026-11-14": "many", "2026-11-13": 99999}}');
  const odd = createActivity({ file, isFocused: () => true, idleSeconds: () => NaN });
  await odd.load();
  assert.equal(odd.sample(), null);
  assert.equal(odd.minutes('2026-11-16'), 7);
  assert.equal(odd.minutes('not-a-date'), 0);
  assert.equal(odd.minutes('2026-11-15'), 0);
  assert.equal(odd.minutes('2026-11-14'), 0);
  assert.equal(odd.minutes('2026-11-13'), 1440, 'a day has no more minutes than a day');
  assert.equal(createActivity({ file }).sample(), null, 'with no way to ask, nothing is counted');
});

// ---- identity ----

test('a first run makes an identity: on, notice not yet shown, and it is the same one after a restart', async (t) => {
  const dir = tempDir(t);
  const a = createIdentity({ dir });
  assert.equal(a.enabled, false, 'nothing is on before the file is read');
  assert.equal(a.noticeShown, true, 'and no notice is due');
  assert.equal(await a.load(), true);
  assert.match(a.installId, UUID);
  assert.equal(a.enabled, true);
  assert.equal(a.noticeShown, false);
  assert.equal(a.firstRun, true);
  assert.equal(a.name, null);
  await a.settled();

  const b = createIdentity({ dir });
  assert.equal(await b.load(), true);
  assert.equal(b.installId, a.installId);
  assert.equal(b.firstRun, false);
  assert.equal(b.firstRunAt, a.firstRunAt);
});

test('the switch, the name, the notice and the steps reached are all kept', async (t) => {
  const dir = tempDir(t);
  const a = createIdentity({ dir });
  await a.load();
  a.setName('Jane Doe');
  a.markNoticeShown();
  a.reach('claude_found', '2026-11-16T12:00:00.000Z');
  a.reach('claude_found', '2027-01-01T00:00:00.000Z'); // the first time is the one that counts
  a.setEnabled(false);
  await a.settled();

  const b = createIdentity({ dir });
  await b.load();
  assert.equal(b.enabled, false);
  assert.equal(b.name, 'Jane Doe');
  assert.equal(b.noticeShown, true);
  assert.equal(b.reached('claude_found'), true);
  assert.equal(b.reached('first_chat'), false);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8')).milestones.claude_found, '2026-11-16T12:00:00.000Z');
  b.setName('');
  await b.settled();
  const c = createIdentity({ dir });
  await c.load();
  assert.equal(c.name, '', 'a name cleared on purpose stays cleared');
});

test('how long the notice has been on screen is kept and adds up, until it is answered', async (t) => {
  const dir = tempDir(t);
  const a = createIdentity({ dir });
  assert.equal(a.noticeMs, 0, 'nothing before the file is read');
  a.addNoticeTime(60_000);
  assert.equal(a.noticeMs, 0);
  await a.load();
  assert.equal(a.noticeMs, 0);
  a.addNoticeTime(60_000);
  a.addNoticeTime(58_500);
  for (const odd of [0, -5, NaN, Infinity, '60000', null, undefined]) a.addNoticeTime(odd);
  assert.equal(a.noticeMs, 118_500);
  await a.settled();
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8')).notice_ms, 118_500);

  const b = createIdentity({ dir });
  await b.load();
  assert.equal(b.noticeMs, 118_500, 'the next launch goes on from there');
  b.addNoticeTime(1500);
  b.markNoticeShown();
  b.addNoticeTime(60_000); // answered: there is no notice on screen to count
  assert.equal(b.noticeMs, 120_000);
  await b.settled();

  // A file that says something else in that place is a notice not yet read at all.
  for (const junk of ['600000', -1, null, {}, [600000], true]) {
    const odd = tempDir(t);
    writeFileSync(path.join(odd, 'identity.json'), JSON.stringify({ install_id: a.installId, enabled: true, notice_shown: false, notice_ms: junk }));
    const c = createIdentity({ dir: odd });
    await c.load();
    assert.equal(c.noticeMs, 0, JSON.stringify(junk));
  }
  // An install from before this was kept has none.
  const old = tempDir(t);
  writeFileSync(path.join(old, 'identity.json'), JSON.stringify({ install_id: a.installId, enabled: true, notice_shown: true }));
  const d = createIdentity({ dir: old });
  await d.load();
  assert.deepEqual([d.noticeShown, d.noticeMs], [true, 0]);
});

test('the days sharing was off are kept in the identity file, in the same save as the switch', async (t) => {
  const dir = tempDir(t);
  const a = createIdentity({ dir });
  a.noteSharing(true, '2026-11-10'); // before the file is read there is nothing to keep it in
  assert.deepEqual(a.offDays, []);
  await a.load();
  assert.deepEqual(a.offDays, []);
  a.noteSharing(false, '2026-11-10'); // on, and nothing open: nothing to write
  a.setEnabled(false);
  a.noteSharing(true, '2026-11-12');
  await a.settled();
  const saved = JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8'));
  assert.deepEqual([saved.enabled, saved.off_days], [false, [['2026-11-12', null]]]);
  const mine = a.offDays;
  mine.push(['2026-01-01', null]);
  assert.deepEqual(a.offDays, [['2026-11-12', null]], 'what is handed out is a copy');

  const b = createIdentity({ dir });
  await b.load();
  assert.deepEqual(b.offDays, [['2026-11-12', null]]);
  b.setEnabled(true);
  b.noteSharing(false, '2026-11-15');
  b.noteSharing(false, '2026-11-16'); // said again: it ended when it ended
  await b.settled();
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8')).off_days, [['2026-11-12', '2026-11-15']]);
  // A list in the file that is not one is no days off; the rest of the identity is untouched by it.
  for (const junk of ['x', 42, {}, [['yesterday', null]], null]) {
    writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ ...saved, enabled: true, off_days: junk }));
    const c = createIdentity({ dir });
    assert.equal(await c.load(), true);
    assert.deepEqual([c.installId, c.offDays], [a.installId, []], JSON.stringify(junk));
  }
});

test('off survives a damaged identity file: sharing does not quietly come back on', async (t) => {
  const dir = tempDir(t);
  const a = createIdentity({ dir });
  await a.load();
  a.setEnabled(false);
  await a.settled();
  assert.equal(existsSync(path.join(dir, 'opted-out')), true);

  writeFileSync(path.join(dir, 'identity.json'), '{"install_id": "');
  const b = createIdentity({ dir });
  assert.equal(await b.load(), true);
  assert.equal(b.enabled, false);
  assert.equal(b.noticeShown, true, 'someone who turned it off has seen the notice');
  assert.equal(b.firstRun, false);
  assert.notEqual(b.installId, a.installId, 'the old id is gone with the file');

  // Turning it back on is the person's to do, and it sticks.
  b.setEnabled(true);
  await b.settled();
  assert.equal(existsSync(path.join(dir, 'opted-out')), false);
  const c = createIdentity({ dir });
  await c.load();
  assert.equal(c.enabled, true);
});

test('either record saying off means off', async (t) => {
  const dir = tempDir(t);
  const a = createIdentity({ dir });
  await a.load();
  await a.settled();
  writeFileSync(path.join(dir, 'opted-out'), 'left behind by a crash\n'); // identity.json still says on
  const b = createIdentity({ dir });
  await b.load();
  assert.equal(b.enabled, false);
  await b.settled();
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8')).enabled, false, 'and the file is brought in line');
});

test('flipping the switch quickly ends where the last flip left it', async (t) => {
  const dir = tempDir(t);
  const a = createIdentity({ dir });
  await a.load();
  a.setEnabled(false); a.setEnabled(true); a.setEnabled(false); a.setEnabled(true); a.setEnabled(false);
  await a.settled();
  assert.equal(existsSync(path.join(dir, 'opted-out')), true);
  a.setEnabled(true); a.setEnabled(false); a.setEnabled(true);
  await a.settled();
  assert.equal(existsSync(path.join(dir, 'opted-out')), false);
  const b = createIdentity({ dir });
  await b.load();
  assert.equal(b.enabled, true);
});

test('a damaged file without the off record starts a new identity, on, with the notice due again', async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'identity.json'), 'not json at all');
  const a = createIdentity({ dir });
  assert.equal(await a.load(), true);
  assert.equal(a.enabled, true);
  assert.equal(a.noticeShown, false);
  assert.equal(a.firstRun, false, 'a damaged file is not a first run');
  for (const bad of ['{"install_id": 42}', '[]', 'null', '{"install_id": "not-a-uuid", "enabled": true}']) {
    writeFileSync(path.join(dir, 'identity.json'), bad);
    const again = createIdentity({ dir });
    assert.equal(await again.load(), true, bad);
    assert.match(again.installId, UUID);
  }
});

test('an identity that can\'t be kept is no identity: telemetry stays off rather than be a new person every launch', async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'blocked'), '');
  const warned = [];
  const a = createIdentity({ dir: path.join(dir, 'blocked'), warn: (kind) => warned.push(kind) });
  assert.equal(await a.load(), false);
  assert.equal(a.installId, null);
  assert.equal(a.enabled, false);
  assert.equal(a.firstRun, false);
  a.setEnabled(true); a.setName('x'); a.markNoticeShown(); a.reach('first_chat', 'now'); // all quietly nothing
  assert.equal(a.enabled, false);
  assert.ok(warned.some((w) => /stays off/.test(w)), warned.join(' | '));
});

test('a file the disk won\'t give up is left alone, and telemetry stays off for the launch', async (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, 'identity.json')); // reading a folder as a file fails, and not with "no such file"
  const a = createIdentity({ dir });
  assert.equal(await a.load(), false);
  assert.equal(a.enabled, false);
  assert.equal(existsSync(path.join(dir, 'identity.json')), true);
});

test('milestones in the file that are not real steps are ignored', async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
    install_id: '22222222-2222-4222-8222-222222222222', enabled: true, notice_shown: 'yes', first_run_at: 'long ago',
    milestones: { first_chat: '2026-11-16T12:00:00.000Z', made_up: '2026-11-16T12:00:00.000Z', first_reply: true },
  }));
  const a = createIdentity({ dir });
  await a.load();
  assert.equal(a.reached('first_chat'), true);
  assert.equal(a.reached('made_up'), false);
  assert.equal(a.reached('first_reply'), false);
  assert.equal(a.noticeShown, false, 'only a real true counts');
  assert.ok(!Number.isNaN(Date.parse(a.firstRunAt)), 'a first-run time that is not a time is replaced');
});

// ---- what's sent ----

const entry = (n) => ({ event: 'feature_used', ts: new Date(Date.UTC(2026, 10, 16, 12, 0, 0) + n * 1000).toISOString(), props: { name: 'chat_new' } });

test('the list holds the last 200 events, newest first, across restarts', async (t) => {
  const file = path.join(tempDir(t), 'recent.jsonl');
  const a = createRecent({ file });
  await a.load();
  for (let n = 1; n <= 430; n++) a.add(entry(n));
  assert.equal(RECENT_MAX, 200);
  assert.equal(a.list().length, 200);
  assert.equal(a.list()[0].ts, entry(430).ts);
  assert.equal(a.list().at(-1).ts, entry(231).ts);
  await a.settled();
  assert.ok(readFileSync(file, 'utf8').split('\n').filter(Boolean).length <= 250, 'the file does not grow without end');

  const b = createRecent({ file });
  await b.load();
  assert.deepEqual(b.list(), a.list());
  b.add(entry(431));
  assert.equal(b.list()[0].ts, entry(431).ts);
  assert.equal(b.list().length, 200);
});

test('the list shows only what this version would send, whatever the file holds, and hands out copies', async (t) => {
  const file = path.join(tempDir(t), 'recent.jsonl');
  writeFileSync(file, [
    JSON.stringify({ event: 'feature_used', ts: entry(1).ts, props: { name: 'chat_new', title: 'My secret chat' }, id: 'x', extra: 1 }),
    JSON.stringify({ event: 'made_up', ts: entry(2).ts, props: {} }),
    JSON.stringify({ event: 'app_closed', ts: 'not a time', props: {} }),
    '{"event": "app_cl',
  ].join('\n'));
  const r = createRecent({ file });
  await r.load();
  assert.deepEqual(r.list(), [{ event: 'feature_used', ts: entry(1).ts, props: { name: 'chat_new' } }]);
  r.list()[0].props.name = 'changed by the caller';
  assert.equal(r.list()[0].props.name, 'chat_new');
  await r.settled();
});

// ---- the key/value store ----

test('values are answered from memory at once and are there after a restart', async (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const a = createState({ file });
  await a.load();
  assert.equal(a.get('summary.lastDate'), undefined);
  a.set('summary.lastDate', '2026-11-15');
  a.set('summary.baselineSent', true);
  a.set('n', 3);
  a.set('list', [1, { two: 2 }]);
  assert.equal(a.get('summary.lastDate'), '2026-11-15');
  await a.settled();

  const b = createState({ file });
  await b.load();
  assert.equal(b.get('summary.lastDate'), '2026-11-15');
  assert.equal(b.get('summary.baselineSent'), true);
  assert.deepEqual(b.get('list'), [1, { two: 2 }]);
  b.set('n', undefined);
  await b.settled();
  const c = createState({ file });
  await c.load();
  assert.equal(c.get('n'), undefined, 'setting undefined forgets the key');
});

test('odd keys and values are refused quietly; a value set before the file is read wins over the file', async (t) => {
  const file = path.join(tempDir(t), 'state.json');
  writeFileSync(file, JSON.stringify({ kept: 'from disk', both: 'from disk', __proto__: { polluted: true } }));
  const s = createState({ file });
  s.set('both', 'set first');
  await s.load();
  assert.equal(s.get('kept'), 'from disk');
  assert.equal(s.get('both'), 'set first');
  assert.equal({}.polluted, undefined);
  assert.equal(s.get('constructor'), undefined);
  assert.equal(s.get('toString'), undefined);
  const loop = {}; loop.self = loop;
  for (const [key, value] of [['', 1], [42, 1], [null, 1], ['x'.repeat(101), 1], ['loop', loop], ['fn', () => {}]]) s.set(key, value);
  assert.equal(s.get('loop'), undefined);
  assert.equal(s.get('fn'), undefined);
  const mine = { a: 1 };
  s.set('copy', mine);
  mine.a = 2;
  assert.equal(s.get('copy').a, 1, 'what is kept is a copy');
  await s.settled();
  for (const bad of ['[1,2]', 'nope', '"text"']) {
    writeFileSync(file, bad);
    const again = createState({ file });
    await again.load();
    assert.equal(again.get('kept'), undefined);
  }
});

// ---- the chats Canopy started ----

const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('chat ids are remembered per engine, once each, across restarts', async (t) => {
  const file = path.join(tempDir(t), 'sessions.jsonl');
  const a = createSessionLog({ file });
  await a.load();
  assert.equal(a.note('claude', sid(1)), true);
  assert.equal(a.note('claude', sid(1)), false);
  assert.equal(a.note('codex', sid(2)), true);
  assert.equal(a.note('codex', sid(1)), true, 'the same id under the other engine is another chat');
  await a.settled();

  const b = createSessionLog({ file });
  await b.load();
  assert.deepEqual([...b.sets().claude], [sid(1)]);
  assert.deepEqual([...b.sets().codex].sort(), [sid(1), sid(2)]);
  assert.equal(b.note('claude', sid(1)), false, 'known from the file');
  b.sets().claude.add('mine to change');
  assert.equal(b.sets().claude.size, 1, 'the sets are the caller\'s own');
});

test('only the newest ids are kept, and only things shaped like ids are written down', async (t) => {
  const file = path.join(tempDir(t), 'sessions.jsonl');
  const a = createSessionLog({ file, max: 100 });
  await a.load();
  for (let n = 1; n <= 260; n++) a.note(n % 2 ? 'claude' : 'codex', sid(n));
  const { claude, codex } = a.sets();
  assert.equal(claude.size + codex.size, 100);
  assert.ok(claude.has(sid(259)) && codex.has(sid(260)) && !claude.has(sid(1)));
  for (const [engine, id] of [['gemini', sid(1)], ['claude', '/Users/jane/Acme Rocket'], ['claude', 'short'], ['claude', null], ['claude', 'has spaces in it here'], [null, sid(5)]]) {
    assert.equal(a.note(engine, id), false, `${engine} ${id}`);
  }
  await a.settled();
  assert.ok(readFileSync(file, 'utf8').split('\n').filter(Boolean).length <= 150);
  assert.ok(!readFileSync(file, 'utf8').includes('Acme'));

  writeFileSync(file, `${JSON.stringify(['claude', sid(7)])}\n${JSON.stringify(['claude', '../../etc/passwd'])}\n${JSON.stringify({ engine: 'claude' })}\nnot json\n`);
  const b = createSessionLog({ file });
  await b.load();
  assert.deepEqual([...b.sets().claude], [sid(7)]);
});

// ---- the days sharing was off ----

const day = (n) => `2026-11-${String(n).padStart(2, '0')}`;

test('the days sharing was off are kept as stretches: every day from the one it went off to the one it came back, both included', () => {
  let list = offFrom(undefined, day(10));
  assert.deepEqual(list, [[day(10), null]]);
  // Still off: every day from then on is an off day, whether Canopy was opened on it or not.
  for (const n of [10, 11, 15, 30]) assert.equal(wasOff(list, day(n)), true, day(n));
  assert.equal(wasOff(list, '2027-03-01'), true);
  assert.equal(wasOff(list, day(9)), false, 'the day before it went off was a day of sharing');
  list = offUntil(list, day(14));
  assert.deepEqual(list, [[day(10), day(14)]]);
  assert.deepEqual([9, 10, 12, 14, 15].map((n) => wasOff(list, day(n))), [false, true, true, true, false], 'the day it came back on was off for part of it: it counts');
  // Off and on again within one day is that one day.
  assert.deepEqual(offUntil(offFrom([], day(20)), day(20)), [[day(20), day(20)]]);
  // Later stretches are added after it; the list is plain JSON and reads back the same.
  list = offUntil(offFrom(list, day(20)), day(21));
  assert.deepEqual(list, [[day(10), day(14)], [day(20), day(21)]]);
  assert.deepEqual(readOffDays(JSON.parse(JSON.stringify(list))), list);
  assert.deepEqual([14, 15, 19, 20, 21, 22].map((n) => wasOff(list, day(n))), [true, false, false, true, true, false]);
});

test('saying the same thing twice changes nothing, and off again on the day it came back on is one stretch', () => {
  const off = offFrom([], day(10));
  assert.deepEqual(offFrom(off, day(10)), off);
  assert.deepEqual(offFrom(off, day(12)), off, 'already off: the stretch began when it began');
  assert.deepEqual(offUntil([], day(10)), [], 'on with nothing open: nothing to end');
  const back = offUntil(off, day(12));
  assert.deepEqual(offUntil(back, day(15)), back, 'on, and already on');
  assert.deepEqual(offFrom(back, day(12)), [[day(10), null]], 'off again the same day: the same stretch goes on');
  assert.deepEqual(offUntil(offFrom(back, day(12)), day(13)), [[day(10), day(13)]]);
  assert.deepEqual(offFrom(back, day(13)), [[day(10), day(12)], [day(13), null]], 'the next day is a stretch of its own');
  // A clock that was set back can't end a stretch before it began, or start one in the middle of the last.
  assert.deepEqual(offUntil(off, day(3)), [[day(10), day(10)]]);
  assert.deepEqual(offFrom(back, day(11)), [[day(10), null]]);
  // Nothing is changed in place: each answer is a list of its own.
  const before = JSON.stringify(back);
  offFrom(back, day(12)); offUntil(off, day(20));
  assert.equal(JSON.stringify(back), before);
  assert.deepEqual(off, [[day(10), null]]);
});

test('only the newest stretches are kept, and a saved list that is not one reads as no days off', () => {
  let list = [];
  for (let n = 0; n < OFF_STRETCHES_MAX + 15; n++) {
    const d = new Date(2026, 0, 1 + n * 2, 12);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    list = offUntil(offFrom(list, date), date);
  }
  assert.equal(list.length, OFF_STRETCHES_MAX);
  assert.ok(OFF_STRETCHES_MAX >= 31, 'room for a stretch a day over the month a summary reaches back');
  assert.equal(wasOff(list, list.at(-1)[0]), true);
  assert.equal(wasOff(list, '2026-01-01'), false, 'the oldest were let go');
  for (const junk of [undefined, null, '', 'off', 42, {}, [], [[]], [['2026-11-10']], [[day(10), day(9)]], [[day(10), 'tomorrow']], [['10/11/2026', null]], [[null, null]], [[20261110, null]], [{ from: day(10) }]]) {
    assert.deepEqual(readOffDays(junk), [], JSON.stringify(junk));
    assert.equal(wasOff(junk, day(10)), false);
    assert.deepEqual(offUntil(junk, day(10)), []);
    assert.deepEqual(offFrom(junk, day(10)), [[day(10), null]]);
  }
  // What is good in a damaged list is kept, in order; a date that is not one is never an off day and changes nothing.
  assert.deepEqual(readOffDays([[day(20), null], 'x', [day(10), day(12)], [day(15), day(14)]]), [[day(10), day(12)], [day(20), null]]);
  for (const notADate of [undefined, null, '', 'today', 20261110, '2026-11-1']) {
    assert.equal(wasOff([[day(10), null]], notADate), false);
    assert.deepEqual(offFrom([], notADate), []);
    assert.deepEqual(offUntil([[day(10), null]], notADate), [[day(10), null]]);
  }
  // Two open stretches is not something this file writes; if a list holds them, both count, and both end together.
  assert.equal(wasOff([[day(5), null], [day(20), null]], day(7)), true);
  assert.deepEqual(offUntil([[day(5), null], [day(20), null]], day(22)), [[day(5), day(22)], [day(20), day(22)]]);
});

// The Telemetry object (src/telemetry/index.mjs) as the rest of Canopy uses it: what is sent and when, the switch,
// the outside switches that keep anything from leaving, milestones, and that nothing it does can throw or hang.
// PostHog, the clock and the timers are fakes; the files are real, in a temp folder. Every Canopy here is pointed
// at a host and a key that are nobody's (TEST_ENV), never the ones Canopy ships with.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { WINDOW_EVENTS, createTelemetry } from '../../../telemetry/index.mjs';
import { BUILT_IN } from '../../../build-config.mjs';
import { POSTHOG_HOST, POSTHOG_KEY, resolveConfig } from '../../../telemetry/config.mjs';
import { LIMITS, clean } from '../../../telemetry/schema.mjs';
import { TEST_ENV, TEST_KEY, TEST_URL, fakeClock, fakeServer, stopFirst, tempDir, until } from '../telemetry-fakes.mjs';

// No key: this copy of Canopy has nowhere to send (as one built without a key would).
const NO_KEY = { CANOPY_POSTHOG_KEY: '' };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A telemetry in a temp folder, with a fake PostHog, clock and timers. `environ` replaces process.env.
 * The first-launch notice has been answered, and the wait after an answer is over, unless `answered: false`: a new
 * install sends nothing until then, and that wait has its own tests ("the notice comes first").
 */
function make(t, { dir = tempDir(t), server = fakeServer(200), clock = fakeClock(), environ = TEST_ENV, answered = true, ...opts } = {}) {
  const logs = [];
  const tel = createTelemetry({
    dir, appVersion: '0.0.1', osVersion: '26.1', env: 'prod', defaultName: 'Jane Doe', log: (m) => logs.push(m),
    fetch: server.fetch, now: clock.now, timers: clock.timers, random: () => 0.5, environ, answeredWaitMs: 0, ...opts,
  });
  if (answered) tel.markNoticeShown(); // taken up, in its turn, once the files are read
  stopFirst(t, () => tel.shutdown({ timeoutMs: 0 }));
  return { tel, dir, server, clock, logs };
}
async function ready(t, opts) {
  const made = make(t, opts);
  await made.tel.init();
  return made;
}
const queueLines = (dir) => (existsSync(path.join(dir, 'queue.jsonl')) ? readFileSync(path.join(dir, 'queue.jsonl'), 'utf8').split('\n').filter(Boolean) : []);

// ---- recording and sending ----

test('a tracked event is cleaned, stamped, queued on disk and sent to PostHog with who is sending', async (t) => {
  const { tel, dir, server, clock } = await ready(t);
  tel.track('feature_used', { name: 'chat_new', title: 'My secret chat' });
  assert.equal(tel.status().queued, 1);
  await tel.flush();
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, TEST_URL);
  const body = server.requests[0].body;
  assert.deepEqual(Object.keys(body), ['api_key', 'batch'], 'the key and the events: no sent_at, nothing else');
  assert.equal(body.api_key, TEST_KEY);
  const [e] = body.batch;
  const installId = tel.status().installId;
  assert.match(installId, UUID);
  assert.match(e.uuid, UUID);
  assert.match(e.properties.launch_id, UUID);
  const at = new Date(clock.now()).toISOString();
  // Exactly this, and no key more: the event's one prop, who sent it, and the words that tell PostHog to work out
  // no location and to keep one person per install.
  assert.deepEqual(e, {
    event: 'feature_used', distinct_id: installId, uuid: e.uuid, timestamp: at,
    properties: {
      name: 'chat_new',
      env: 'prod', app_version: '0.0.1', os_version: '26.1', launch_id: e.properties.launch_id, schema: 1,
      distinct_id: installId,
      $geoip_disable: true,
      $process_person_profile: true,
      $set: { env: 'prod', app_version: '0.0.1', os_version: '26.1', name: 'Jane Doe' },
      $set_once: { first_seen: at },
    },
  });
  assert.ok(!server.requests[0].init.body.includes('secret'), 'what was not in the catalog never left');
  assert.equal(tel.status().queued, 0);
  assert.equal(tel.status().lastSentAt, at);
  await until(() => queueLines(dir).length === 0);
});

test('every event of every batch says no location, and the catalog is the only source of its props', async (t) => {
  const { tel, server } = await ready(t);
  tel.track('app_opened', { os_version: '26.1', arch: 'arm64', claude_found: true, first_run: true });
  tel.milestone('first_chat');
  tel.error('main', new Error('boom'));
  tel.track('day_summary', { date: '2026-11-15', baseline: false, msgs_claude_canopy: 4 });
  tel.track('app_closed', { open_min: 3, active_min: 2 });
  await tel.shutdown();
  const sent = server.requests.flatMap((r) => r.body.batch);
  assert.deepEqual(sent.map((e) => e.event), ['app_opened', 'milestone', 'error', 'day_summary', 'app_closed']);
  const OURS = ['env', 'app_version', 'os_version', 'launch_id', 'schema', 'distinct_id', '$geoip_disable', '$process_person_profile', '$set', '$set_once'];
  for (const e of sent) {
    assert.equal(e.properties.$geoip_disable, true, e.event);
    assert.equal(e.properties.$process_person_profile, true, e.event);
    assert.ok(!('$ip' in e.properties) && !('sent_at' in e));
    // Take away what the mapping adds, and what is left is what the catalog lets that event carry.
    const rest = Object.fromEntries(Object.entries(e.properties).filter(([k]) => !OURS.includes(k) || (k === 'os_version' && e.event === 'app_opened')));
    assert.deepEqual(rest, clean(e.event, rest), e.event);
  }
});

test('an event can be given its id, so the same event sent twice is stored once; an id that is not a uuid is not used', async (t) => {
  const { tel, server, logs } = await ready(t);
  const day = { date: '2026-11-15', baseline: false, msgs_claude_canopy: 4 };
  const given = '3f2a9c1e-7b4d-8e21-9a6c-0d5e4f3b2a19';
  tel.track('day_summary', day, { id: given });
  tel.track('day_summary', day, { id: given }); // after a quit in the wrong instant, the next launch says it again
  tel.track('day_summary', { ...day, date: '2026-11-14' });
  // Not ids: each of these events still goes out, under an id of its own.
  const bad = ['not-a-uuid', given.toUpperCase(), `${given} `, `${given}\n`, '', 42, null, {}, ['x'], '../../etc/passwd'];
  for (const id of bad) tel.track('feature_used', { name: 'chat_new' }, { id });
  for (const opts of [null, undefined, 'x', 7, []]) tel.track('feature_used', { name: 'chat_new' }, opts);
  await tel.flush();
  const events = server.requests.flatMap((r) => r.events);
  assert.deepEqual(events.slice(0, 2).map((e) => e.id), [given, given], 'the id it was given, both times');
  assert.deepEqual(events.slice(0, 2).map((e) => e.props), [day, day]);
  // PostHog keeps one of two events only when their id, name, person and UTC day all match: a day's summary is
  // filed under the day it is about, so the two copies match whenever each was sent.
  const [one, two] = server.requests.flatMap((r) => r.body.batch);
  assert.deepEqual([one.uuid, one.event, one.distinct_id, one.timestamp], [two.uuid, two.event, two.distinct_id, two.timestamp]);
  assert.equal(one.timestamp, '2026-11-15T12:00:00.000Z');
  const own = events.slice(2).map((e) => e.id);
  assert.equal(own.length, 1 + bad.length + 5);
  for (const id of own) assert.match(id, UUID);
  assert.equal(new Set(own).size, own.length, 'ids of their own, all different');
  assert.ok(!own.includes(given));
  assert.equal(logs.filter((l) => /an id that is not a uuid/.test(l)).length, 1, 'said once, not once per event');
});

test('an event that is not in the schema is dropped, and said once when running from source', async (t) => {
  const { tel, server, logs } = await ready(t, { env: 'dev' });
  tel.track('chat_text', { text: 'hello' });
  tel.track('chat_text', { text: 'again' });
  tel.track({ toString: () => 'app_opened' }, {});
  tel.track(undefined);
  await tel.flush();
  assert.equal(server.requests.length, 0);
  assert.equal(tel.recent().length, 0);
  assert.equal(logs.filter((l) => /not in the schema: chat_text/.test(l)).length, 1);
});

test('the window may send its own four kinds of event and no other, and can never give one an id', async (t) => {
  const { tel, server, logs } = await ready(t, { env: 'dev' });
  // What the window legitimately counts.
  tel.trackFromWindow('feature_used', { name: 'chat_new' });
  tel.trackFromWindow('setting_changed', { key: 'theme', value: 'dark' });
  tel.trackFromWindow('widget', { kind: 'chart', action: 'shown' });
  tel.trackFromWindow('extension_added', { type: 'connector', name: 'acme-internal-billing' });
  // What only main may say. Each of these is in the schema, so track() would take it: the window's way in does not.
  const given = '3f2a9c1e-7b4d-8e21-9a6c-0d5e4f3b2a19';
  const notTheWindows = [
    ['error', { where: 'ui', type: 'Error', fingerprint: '0123456789abcdef', message: 'the plan for the merger is ready', count: 1 }],
    ['day_summary', { date: '2026-11-15', msgs_claude_terminal: 9999 }],
    ['milestone', { step: 'first_reply' }],
    ['app_opened', { first_run: true }], ['app_closed', { open_min: 5 }],
    ['chat_started', { engine: 'claude', mode: 'a-word-of-the-windows-own' }], ['message_sent', { engine: 'claude' }],
    ['reply_finished', { engine: 'claude', outcome: 'done' }], ['permission_answered', { answer: 'allow' }],
    ['upkeep', { action: 'update', result: 'updated' }],
    ['telemetry_off', {}], ['telemetry_on', {}],
  ];
  for (const [event, props] of notTheWindows) { tel.trackFromWindow(event, props); tel.trackFromWindow(event, props, { id: given }); }
  tel.trackFromWindow('error', {}); // said in the log once, however often it is tried
  for (const junk of [undefined, null, 42, {}, ['feature_used'], { toString: () => 'feature_used' }]) tel.trackFromWindow(junk, { name: 'chat_new' });
  // A third argument is not the window's to give: the event still goes, under an id of its own.
  tel.trackFromWindow('feature_used', { name: 'home_opened' }, { id: given });
  await tel.flush();

  const events = server.requests.flatMap((r) => r.events);
  assert.deepEqual(events.map((e) => [e.event, e.props]), [
    ['feature_used', { name: 'chat_new' }],
    ['setting_changed', { key: 'theme', value: 'dark' }],
    ['widget', { kind: 'chart', action: 'shown' }],
    ['extension_added', { type: 'connector', name: 'custom' }],
    ['feature_used', { name: 'home_opened' }],
  ]);
  assert.ok(!events.some((e) => e.id === given));
  assert.deepEqual(tel.recent().map((e) => e.event).sort(), events.map((e) => e.event).sort(), 'nor is anything else listed as sent');
  assert.equal(logs.filter((l) => /the window may not send: error/.test(l)).length, 1);
  // The list itself: the four, and each one an event the schema has.
  assert.deepEqual([...WINDOW_EVENTS].sort(), ['extension_added', 'feature_used', 'setting_changed', 'widget']);
  assert.ok(Object.isFrozen(WINDOW_EVENTS));
});

test('events tracked before init has finished wait and go out in order, with the time they happened', async (t) => {
  const { tel, server, clock } = make(t);
  const at = new Date(clock.now()).toISOString();
  tel.track('app_opened', { claude_found: true });
  tel.milestone('claude_found');
  tel.error('main', new Error('early trouble'));
  assert.equal(tel.status().enabled, false, 'nothing is known yet');
  assert.equal(tel.status().noticeShown, true);
  clock.advance(5000);
  await tel.init();
  await tel.flush();
  assert.deepEqual(server.events, ['app_opened', 'milestone', 'error']);
  assert.equal(server.requests[0].events[0].ts, at);
});

test('queued events survive a restart and are sent by the next launch, under the same install id', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir, server: fakeServer('network') });
  a.tel.track('feature_used', { name: 'chat_new' });
  a.tel.track('feature_used', { name: 'home_opened' });
  await a.tel.flush();
  assert.equal(a.tel.status().queued, 2);
  await a.tel.shutdown({ timeoutMs: 200 });
  assert.equal(queueLines(dir).length, 2);

  const b = await ready(t, { dir });
  assert.equal(b.tel.status().queued, 2);
  assert.equal(b.tel.status().installId, a.tel.status().installId);
  await b.tel.flush();
  assert.deepEqual(b.server.requests[0].events.map((e) => e.props.name), ['chat_new', 'home_opened']);
  assert.equal(b.server.requests[0].body.batch[0].distinct_id, a.tel.status().installId);
  const ids = a.server.requests[0].events.map((e) => e.id);
  assert.deepEqual(b.server.requests[0].events.map((e) => e.id), ids, 'the same ids, so PostHog counts a retry once');
});

test('a queue file with damaged lines costs only those lines', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir, server: fakeServer('network') });
  a.tel.track('feature_used', { name: 'chat_new' });
  await a.tel.shutdown({ timeoutMs: 200 });
  const good = queueLines(dir)[0];
  writeFileSync(path.join(dir, 'queue.jsonl'), `{"id": "half\n${good}\nnot json\n${good.slice(0, 30)}`);
  const b = await ready(t, { dir });
  assert.equal(b.tel.status().queued, 1);
  await b.tel.flush();
  assert.deepEqual(b.server.events, ['feature_used']);
});

test('the queue is sent every minute, and at once when 50 events are waiting', async (t) => {
  const { tel, server, clock } = await ready(t);
  tel.track('feature_used', { name: 'chat_new' });
  await tick();
  assert.equal(server.requests.length, 0, 'one event waits for the minute');
  clock.advance(MIN);
  await until(() => server.requests.length === 1);
  await until(() => tel.status().queued === 0);

  for (let i = 0; i < 49; i++) tel.track('feature_used', { name: 'chat_new' });
  await tick();
  assert.equal(server.requests.length, 1);
  tel.track('feature_used', { name: 'chat_new' });
  await until(() => server.requests.length === 2);
  assert.equal(server.requests[1].events.length, 50);
});

test('batches never exceed the limits, however much is queued', async (t) => {
  const { tel, server } = await ready(t, { server: fakeServer('network', 200) });
  for (let i = 0; i < 450; i++) tel.track('error', { where: 'main', fingerprint: '0123456789abcdef', type: 'Error', message: `m ${'x'.repeat(190)}`, count: 1 });
  await until(() => server.requests.length === 1); // the try at 50 fails; the rest pile up
  await tel.flush();
  const sizes = server.requests.slice(1).map((r) => r.events.length);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 450);
  assert.ok(sizes.every((n) => n <= LIMITS.batchEvents), sizes.join(','));
  assert.ok(server.requests.every((r) => r.bytes <= LIMITS.batchBytes));
});

test('a server that is down costs a try a minute at first, then fewer; the events are kept and go when it is back', async (t) => {
  const { tel, server, clock, logs } = await ready(t, { server: fakeServer(503, 503, 503, 200) });
  tel.track('feature_used', { name: 'chat_new' });
  const tries = [];
  for (let minute = 1; minute <= 9; minute++) {
    clock.advance(MIN);
    await tick(); await tick(); await tick();
    tries.push(server.requests.length);
  }
  // Tries at minute 1, 2 (after a 1 minute pause), 4 (after 2) and 9 (after 5), which succeeds.
  assert.deepEqual(tries, [1, 2, 2, 3, 3, 3, 3, 3, 4]);
  await until(() => tel.status().queued === 0);
  assert.equal(logs.filter((l) => /could not send/.test(l)).length, 1);
  assert.equal(logs.filter((l) => /works again/.test(l)).length, 1);
});

test('what each answer from PostHog means for the events that were sent', async (t) => {
  const cases = [
    // [what PostHog answers, events still queued out of 3, what the log says]
    [200, 0, null],
    [400, 0, /PostHog refused a batch of 3 \(400\): dropped/],
    [401, 3, /PostHog did not take the key \(401\): events are kept/],
    [403, 3, /PostHog did not take the key \(403\): events are kept/],
    [413, 2, /one event was too big for PostHog: dropped/],
    [429, 3, /could not send \(429\): events are kept/],
    [500, 3, /could not send \(500\): events are kept/],
    [503, 3, /could not send \(503\): events are kept/],
    [404, 3, /could not send \(404\): events are kept/],
    ['network', 3, /could not send \(TypeError\): events are kept/],
  ];
  for (const [answer, left, said] of cases) {
    const { tel, dir, server, logs } = await ready(t, { server: fakeServer(answer) });
    for (const name of ['chat_new', 'home_opened', 'palette_opened']) tel.track('feature_used', { name });
    await tel.flush();
    assert.equal(tel.status().queued, left, `${answer}: queued`);
    assert.equal(tel.status().lastSentAt === null, answer !== 200, `${answer}: "last sent" moves only when PostHog has them`);
    if (said) assert.ok(logs.some((l) => said.test(l)), `${answer}: ${logs.join(' | ')}`);
    else assert.deepEqual(logs, []);
    // What is kept is on disk, for the next launch.
    await until(() => queueLines(dir).length === left);
    assert.ok(server.requests.every((r) => r.url === TEST_URL && r.body.api_key === TEST_KEY));
  }
});

test('offline, nothing is tried; the events wait', async (t) => {
  let online = false;
  const { tel, server, clock } = await ready(t, { isOnline: () => online });
  tel.track('feature_used', { name: 'chat_new' });
  clock.advance(MIN);
  await tel.flush();
  assert.equal(server.requests.length, 0);
  assert.equal(tel.status().queued, 1);
  online = true;
  await tel.flush();
  assert.equal(tel.status().queued, 0);
});

test('something that refuses everything costs one batch an hour, a relaunch included; a key that is not taken costs nothing', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const a = await ready(t, { dir, clock, server: fakeServer(400) });
  for (let i = 0; i < 200; i++) a.tel.track('feature_used', { name: 'chat_new' });
  await a.tel.flush();
  for (let i = 0; i < 250; i++) a.tel.track('feature_used', { name: 'home_opened' });
  assert.equal(a.server.requests.flatMap((r) => r.events).length, 200);
  assert.equal(a.tel.status().queued, 250, 'a full batch\'s worth was refused, and dropped: the hour\'s limit');
  clock.advance(10 * MIN);
  await a.tel.flush();
  assert.equal(a.tel.status().queued, 250, 'the next refusal within the hour drops nothing');
  await a.tel.shutdown();
  assert.equal(a.tel.status().queued, 250, 'nor does the try at quit');
  assert.equal(queueLines(dir).length, 250);

  clock.advance(5 * MIN);
  const b = await ready(t, { dir, clock, server: fakeServer(400) });
  clock.advance(MIN);
  await b.tel.flush();
  assert.ok(b.server.requests.length >= 1);
  assert.equal(b.tel.status().queued, 250, 'the launch after remembers the hour\'s batch was spent');
  clock.advance(60 * MIN);
  await b.tel.flush();
  assert.equal(b.tel.status().queued, 50, 'an hour on, one more');
  await b.tel.shutdown();

  // PostHog does not take the key (401): nothing is wrong with the events. Everything is kept, an hour at a time,
  // and "send now" (as at quit) is not one more try.
  const wrong = await ready(t, { server: fakeServer(401, 401, 200) });
  for (let i = 0; i < 60; i++) wrong.tel.track('feature_used', { name: 'chat_new' });
  await until(() => wrong.server.requests.length === 1);
  await tick(); await tick();
  assert.equal(wrong.tel.status().queued, 60);
  assert.ok(wrong.logs.some((l) => /PostHog did not take the key \(401\): events are kept/.test(l)), wrong.logs.join(' | '));
  await wrong.tel.flush();
  const minutes = async (n) => { for (let i = 0; i < n; i++) { wrong.clock.advance(MIN); await tick(); } };
  await minutes(59);
  assert.equal(wrong.server.requests.length, 1, 'no try before the hour is up');
  await minutes(2);
  await until(() => wrong.server.requests.length === 2);
  await tick(); await tick();
  assert.equal(wrong.tel.status().queued, 60, 'still refused, still kept');
  await minutes(61); // a Canopy with the right key would be a new launch; here PostHog comes round
  await until(() => wrong.tel.status().queued === 0);
  assert.equal(wrong.server.requests[2].events.length, 60);
});

// ---- nothing leaves when it must not ----

test('an automated run (CANOPY_USER_DATA) never sends: events show in "what\'s sent" and go nowhere', async (t) => {
  const { tel, dir, server, clock } = await ready(t, { environ: { ...TEST_ENV, CANOPY_USER_DATA: '/tmp/harness' } });
  for (let i = 0; i < 60; i++) tel.track('feature_used', { name: 'chat_new' });
  tel.milestone('first_chat');
  tel.error('main', new Error('boom'));
  clock.advance(5 * MIN);
  await tel.flush();
  tel.setEnabled(false);
  await tick();
  await tel.shutdown();
  assert.equal(server.requests.length, 0);
  assert.equal(queueLines(dir).length, 0, 'nothing is even queued');
  assert.equal(tel.recent().length, 63, 'but all of it can be looked at (the goodbye included)');
  assert.deepEqual({ blocked: tel.status().blocked, sending: tel.status().sending, endpoint: tel.status().endpoint, queued: tel.status().queued }, { blocked: 'automated', sending: false, endpoint: true, queued: 0 });
});

test('CANOPY_TELEMETRY=0 never sends, however it is spelled', async (t) => {
  for (const value of ['0', 'false', 'off', 'OFF', ' no ']) {
    const { tel, server, clock } = await ready(t, { environ: { ...TEST_ENV, CANOPY_TELEMETRY: value } });
    tel.track('feature_used', { name: 'chat_new' });
    clock.advance(2 * MIN);
    await tel.flush();
    await tel.shutdown();
    assert.equal(server.requests.length, 0, value);
    assert.equal(tel.status().blocked, 'env');
  }
  const on = await ready(t, { environ: { ...TEST_ENV, CANOPY_TELEMETRY: '1' } });
  assert.equal(on.tel.status().blocked, null);
  assert.equal(on.tel.status().sending, true);
});

test('with no key nothing is sent or queued; nor with a host that can\'t be used', async (t) => {
  const nowhere = [
    NO_KEY, { ...TEST_ENV, CANOPY_POSTHOG_KEY: '   ' }, { ...TEST_ENV, CANOPY_POSTHOG_KEY: 'two words' }, { ...TEST_ENV, CANOPY_POSTHOG_KEY: 'phc_a\nphc_b' },
    { ...TEST_ENV, CANOPY_POSTHOG_HOST: '' }, { ...TEST_ENV, CANOPY_POSTHOG_HOST: 'not a url' }, { ...TEST_ENV, CANOPY_POSTHOG_HOST: 'http://collector.example.com' },
    { ...TEST_ENV, CANOPY_POSTHOG_HOST: 'file:///etc/passwd' },
    // One of the two named and wrong is "nowhere", never "the real one after all".
    { CANOPY_POSTHOG_KEY: '' }, { CANOPY_POSTHOG_HOST: 'not a url' },
  ];
  for (const environ of nowhere) {
    const { tel, dir, server, clock } = await ready(t, { environ });
    tel.track('feature_used', { name: 'chat_new' });
    clock.advance(2 * MIN);
    await tel.flush();
    await tel.shutdown();
    assert.equal(server.requests.length, 0, JSON.stringify(environ));
    assert.equal(queueLines(dir).length, 0);
    assert.deepEqual({ endpoint: tel.status().endpoint, sending: tel.status().sending }, { endpoint: false, sending: false }, JSON.stringify(environ));
    assert.equal(tel.recent().length, 1);
  }
  const local = await ready(t, { environ: { ...TEST_ENV, CANOPY_POSTHOG_HOST: 'http://127.0.0.1:8010' } });
  assert.equal(local.tel.status().endpoint, true, 'plain http is fine to this Mac itself (a test server)');
});

test('where Canopy sends: the key and host it was built with, unless the environment names others', () => {
  // An official build is given a project key (the kind made to ship in apps) and sends to PostHog Cloud (US) unless
  // it names another host. A copy built from source is given neither, and sends nowhere.
  const official = { key: 'phc_built', host: 'https://us.i.posthog.com' };
  assert.deepEqual(resolveConfig({}, official), { endpoint: 'https://us.i.posthog.com/batch/', key: 'phc_built', blocked: null });
  assert.deepEqual(resolveConfig({}, { key: '', host: 'https://us.i.posthog.com' }), { endpoint: '', key: '', blocked: null }, 'no key: nowhere');
  // With nothing handed in, it is this copy's own: what src/build-config.mjs found for it, and PostHog's US cloud by default.
  assert.equal(POSTHOG_KEY, BUILT_IN.posthogKey);
  assert.equal(POSTHOG_HOST, BUILT_IN.posthogHost || 'https://us.i.posthog.com');
  assert.deepEqual(resolveConfig({}), resolveConfig({}, { key: POSTHOG_KEY, host: POSTHOG_HOST }));
  assert.deepEqual(resolveConfig(TEST_ENV), { endpoint: TEST_URL, key: TEST_KEY, blocked: null });
  // Each can be named alone; a host is taken with or without its slash, and with a path in front (a proxy).
  assert.deepEqual(resolveConfig({ CANOPY_POSTHOG_HOST: 'https://eu.i.posthog.com/' }, official), { endpoint: 'https://eu.i.posthog.com/batch/', key: 'phc_built', blocked: null });
  assert.deepEqual(resolveConfig({ CANOPY_POSTHOG_KEY: 'phc_mine' }, { key: '', host: 'https://us.i.posthog.com' }), { endpoint: 'https://us.i.posthog.com/batch/', key: 'phc_mine', blocked: null }, 'a build of one\'s own, pointed at a project of one\'s own');
  assert.equal(resolveConfig({ ...TEST_ENV, CANOPY_POSTHOG_HOST: ' https://example.com/ingest// ' }).endpoint, 'https://example.com/ingest/batch/');
  assert.equal(resolveConfig({ ...TEST_ENV, CANOPY_POSTHOG_KEY: ' phc_mine ' }).key, 'phc_mine');
  // Nothing of a sign-in or a query rides along in the address.
  assert.equal(resolveConfig({ ...TEST_ENV, CANOPY_POSTHOG_HOST: 'https://user:pass@example.com/?token=1#x' }).endpoint, 'https://example.com/batch/');
  // The outside switches are said beside it, whatever the key.
  assert.equal(resolveConfig({ CANOPY_USER_DATA: '/tmp/harness' }).blocked, 'automated');
  assert.equal(resolveConfig({ ...NO_KEY, CANOPY_TELEMETRY: '0' }).blocked, 'env');
  for (const junk of [null, undefined, 'x', 42]) assert.equal(typeof resolveConfig(junk).endpoint, 'string');
});

test('events queued by an earlier launch are neither sent nor thrown away by a launch that may not send', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir, server: fakeServer('network') });
  a.tel.track('feature_used', { name: 'chat_new' });
  await a.tel.shutdown({ timeoutMs: 200 });
  const b = await ready(t, { dir, environ: { ...TEST_ENV, CANOPY_TELEMETRY: '0' } });
  await b.tel.flush();
  await b.tel.shutdown();
  assert.equal(b.server.requests.length, 0);
  assert.equal(queueLines(dir).length, 1);
});

// ---- the notice comes first ----
// A new install sends nothing until the first-launch notice has been answered, or has been on screen for ten minutes
// of Canopy being open. These installs are new: `answered: false`, and the real two-minute wait after an answer.

const fresh = { answered: false, answeredWaitMs: undefined };
const READ = 10 * MIN;      // on screen this long, unanswered, and events go
const ANSWERED = 2 * MIN;   // after an answer, this long before the first batch
const identityOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8'));

test('a new install sends nothing while the notice is unanswered: not at the minute, not at 50 events, not when asked, not at quit', async (t) => {
  const { tel, dir, server, clock } = await ready(t, fresh);
  assert.equal(tel.status().noticeShown, false);
  tel.noticeOnScreen();
  tel.track('app_opened', { first_run: true });
  tel.milestone('claude_found');
  for (let i = 0; i < 60; i++) tel.track('day_summary', { date: '2026-11-15', baseline: true }); // the month before, counted 30 s in
  await tick();
  clock.advance(MIN); // where the first batch used to go
  await tel.flush();
  for (let minute = 2; minute <= 9; minute++) { clock.advance(MIN); await tick(); }
  tel.track('feature_used', { name: 'chat_new' });
  await tel.flush();
  assert.equal(server.requests.length, 0, 'nine minutes in, nothing has left');
  assert.equal(tel.status().queued, 63, 'it all waits');
  assert.deepEqual({ sending: tel.status().sending, enabled: tel.status().enabled }, { sending: true, enabled: true }, 'sharing is on: it is only the first batch that waits');
  assert.equal(tel.recent().length, 63, 'and it can all be looked at meanwhile');
  await tel.shutdown();
  assert.equal(server.requests.length, 0, 'quitting sends nothing either');
  assert.equal(queueLines(dir).length, 63, 'it is kept for the launch after');
});

test('unanswered, the notice has to have been on screen for ten minutes of Canopy being open; then what waited goes', async (t) => {
  const { tel, server, clock } = await ready(t, fresh);
  tel.track('app_opened', { first_run: true });
  clock.advance(1500); // the window settles, then puts the notice up
  tel.noticeOnScreen();
  tel.noticeOnScreen(); // said again (the window reloaded): the count does not start over
  const sentAfter = [];
  for (let minute = 1; minute <= 12; minute++) {
    clock.advance(minute === 1 ? MIN - 1500 : MIN);
    await tick(); await tick(); await tick();
    sentAfter.push(server.requests.length);
  }
  // At the tenth minute it has been up for 9 min 58.5 s: not yet. The minute after, it has.
  assert.deepEqual(sentAfter, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(server.events, ['app_opened']);
  assert.equal(tel.status().noticeShown, false, 'the notice is still owed an answer, and stays up');
  // From here on this install sends like any other.
  tel.track('feature_used', { name: 'chat_new' });
  clock.advance(MIN);
  await until(() => server.requests.length === 2);
  // Answered at last: nothing waits on that any more, so nothing is held back for it.
  tel.markNoticeShown();
  tel.track('feature_used', { name: 'home_opened' });
  await tel.flush();
  assert.equal(server.requests.length, 3);
});

test('the notice counts only while it is on screen: never before the window says so, and a Mac asleep was showing it to nobody', async (t) => {
  // The window never says the notice is up (it failed to load, say): Canopy open all day sends nothing.
  const unseen = await ready(t, fresh);
  unseen.tel.track('app_opened', {});
  unseen.clock.advance(24 * 60 * MIN);
  await unseen.tel.flush();
  assert.equal(unseen.server.requests.length, 0);
  assert.equal(identityOf(unseen.dir).notice_ms, 0);

  // Up for three minutes, then the Mac sleeps for eight hours with Canopy open.
  const { tel, dir, server, clock } = await ready(t, fresh);
  tel.track('app_opened', {});
  tel.noticeOnScreen();
  clock.advance(3 * MIN);
  clock.set(clock.now() + 8 * 60 * MIN); // no timer fired while it slept
  clock.advance(0);                      // awake: the minute timer, long overdue, fires once
  await tel.flush();
  assert.equal(server.requests.length, 0, 'eight hours asleep are one more minute, not ten');
  await until(() => identityOf(dir).notice_ms === 4 * MIN);
  clock.advance(5 * MIN);
  await tel.flush();
  assert.equal(server.requests.length, 0, 'nine minutes');
  clock.advance(MIN);
  await until(() => server.requests.length === 1);
});

test('the ten minutes add up over launches, and each launch counts only from when its own window shows the notice', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const a = await ready(t, { ...fresh, dir, clock });
  a.tel.track('app_opened', { first_run: true });
  a.tel.noticeOnScreen();
  clock.advance(4 * MIN + 30_000);
  await a.tel.shutdown();
  assert.equal(identityOf(dir).notice_ms, 4 * MIN + 30_000, 'the half minute before quitting counts too');
  assert.equal(identityOf(dir).notice_shown, false);
  assert.equal(a.server.requests.length, 0);

  clock.advance(3 * DAY); // closed for three days: none of that is time on screen
  const b = await ready(t, { ...fresh, dir, clock });
  assert.equal(b.tel.status().queued, 2, 'what the first launch recorded is still waiting, with this launch\'s "came back on a later day"');
  clock.advance(20 * MIN); // open, but this window has not shown the notice yet
  await b.tel.flush();
  assert.equal(b.server.requests.length, 0);
  b.tel.noticeOnScreen();
  clock.advance(5 * MIN);
  await b.tel.flush();
  assert.equal(b.server.requests.length, 0, '4.5 + 5 minutes');
  clock.advance(MIN);
  await until(() => b.server.requests.length === 1);
  assert.deepEqual(b.server.events, ['app_opened', 'milestone'], 'the first launch\'s own event, sent by the second');
  await b.tel.shutdown();

  // Read for long enough once, it never waits again, though the notice is still unanswered.
  const c = await ready(t, { ...fresh, dir, clock });
  assert.equal(c.tel.status().noticeShown, false);
  c.tel.track('feature_used', { name: 'chat_new' });
  clock.advance(MIN);
  await until(() => c.server.requests.length === 1);
});

test('answered (OK, Settings, swiped away): what waited goes two minutes later, never with the click', async (t) => {
  const { tel, server, clock } = await ready(t, fresh);
  tel.noticeOnScreen();
  // A first launch: more than 50 events are already waiting when the answer comes.
  tel.track('app_opened', { first_run: true });
  for (let i = 0; i < 60; i++) tel.track('feature_used', { name: 'chat_new' });
  clock.advance(30_000);
  tel.markNoticeShown(); // "Settings" was clicked...
  assert.equal(tel.status().noticeShown, true);
  tel.track('feature_used', { name: 'settings_opened' }); // ...and Settings opening is itself an event
  tel.track('feature_used', { name: 'settings_page', page: 'privacy' });
  await tick();
  await tel.flush();
  assert.equal(server.requests.length, 0, 'the click sends nothing, however much is waiting');
  clock.advance(ANSWERED - 1);
  await tel.flush();
  assert.equal(server.requests.length, 0, 'nor does anything in the two minutes after it');
  clock.advance(1);
  await tel.flush();
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].events.length, 63);
  assert.equal(server.events[0], 'app_opened');
  assert.equal(tel.status().queued, 0);
});

test('sharing switched off before the notice is answered, or in the two minutes after: nothing is ever sent, not even the goodbye', async (t) => {
  // Found the switch on their own (Settings > Privacy), the notice still up.
  const a = await ready(t, fresh);
  a.tel.noticeOnScreen();
  a.tel.track('app_opened', { first_run: true });
  for (let i = 0; i < 60; i++) a.tel.track('feature_used', { name: 'chat_new' });
  a.clock.advance(3 * MIN);
  await until(() => queueLines(a.dir).length === 61);
  a.tel.setEnabled(false);
  a.tel.markNoticeShown(); // the window takes the notice down: the switch has been found
  a.clock.advance(60 * MIN);
  await a.tel.flush();
  await a.tel.shutdown();
  assert.equal(a.server.requests.length, 0, 'not one request');
  assert.equal(a.tel.status().queued, 0, 'the queue was emptied as usual');
  await until(() => !existsSync(path.join(a.dir, 'queue.jsonl')));
  assert.equal(a.tel.recent()[0].event, 'telemetry_off');

  // Clicked "Settings" on the notice and switched it off there, forty seconds later.
  const b = await ready(t, fresh);
  b.tel.noticeOnScreen();
  b.tel.track('app_opened', { first_run: true });
  b.clock.advance(20_000);
  b.tel.markNoticeShown();
  b.clock.advance(40_000);
  b.tel.setEnabled(false);
  b.clock.advance(60 * MIN);
  await b.tel.flush();
  await b.tel.shutdown();
  assert.equal(b.server.requests.length, 0);

  // Switched back on days later: one telemetry_on, and from then on events flow. Nothing from before comes back.
  const dir = tempDir(t);
  const clock = fakeClock();
  const c = await ready(t, { ...fresh, dir, clock });
  c.tel.noticeOnScreen();
  c.tel.track('app_opened', { first_run: true });
  c.tel.setEnabled(false);
  c.tel.markNoticeShown();
  await c.tel.shutdown();
  clock.advance(3 * DAY);
  const d = await ready(t, { ...fresh, dir, clock });
  d.tel.setEnabled(true);
  d.tel.track('feature_used', { name: 'chat_new' });
  clock.advance(MIN);
  await until(() => d.server.requests.length === 1);
  assert.deepEqual(d.server.events, ['telemetry_on', 'feature_used']);
  assert.equal(c.server.requests.length, 0);
});

test('once events may leave, switching off sends its one goodbye as before; so does an install whose notice was answered in an earlier launch', async (t) => {
  // Answered, and the two minutes are over.
  const a = await ready(t, fresh);
  a.tel.noticeOnScreen();
  a.tel.markNoticeShown();
  a.clock.advance(ANSWERED);
  a.tel.track('feature_used', { name: 'chat_new' });
  a.tel.setEnabled(false);
  await until(() => a.server.requests.length === 1);
  assert.deepEqual(a.server.events, ['telemetry_off']);
  // Read for ten minutes, never answered.
  const b = await ready(t, fresh);
  b.tel.noticeOnScreen();
  b.clock.advance(READ + MIN);
  b.tel.setEnabled(false);
  await until(() => b.server.requests.length === 1);
  assert.deepEqual(b.server.events, ['telemetry_off']);

  // An install from before this wait, its notice answered then: the first minute sends, as it always did.
  const dir = tempDir(t);
  const clock = fakeClock();
  const first = await ready(t, { ...fresh, dir, clock });
  first.tel.markNoticeShown();
  await first.tel.shutdown();
  assert.deepEqual([identityOf(dir).notice_shown, identityOf(dir).notice_ms], [true, 0]);
  clock.advance(DAY);
  const later = await ready(t, { ...fresh, dir, clock });
  assert.equal(later.tel.status().noticeShown, true);
  later.tel.track('app_opened', {});
  await tick();
  assert.equal(later.server.requests.length, 0, 'one event waits for the minute');
  clock.advance(MIN);
  await until(() => later.server.requests.length === 1);
  for (let i = 0; i < 50; i++) later.tel.track('feature_used', { name: 'chat_new' });
  await until(() => later.server.requests.length === 2); // and 50 waiting go at once
  later.tel.noticeOnScreen(); // a window that says so anyway changes nothing
  assert.equal(identityOf(dir).notice_ms, 0);
});

test('a copy that can\'t send is as it was: nothing waits, the notice is not counted, and what it would send can be looked at', async (t) => {
  for (const environ of [{ ...TEST_ENV, CANOPY_USER_DATA: '/tmp/harness' }, { ...TEST_ENV, CANOPY_TELEMETRY: '0' }]) {
    const { tel, dir, server, clock } = await ready(t, { ...fresh, environ });
    tel.noticeOnScreen(); // the window does not show it here; a call all the same
    tel.track('app_opened', {});
    clock.advance(30 * MIN);
    tel.markNoticeShown();
    clock.advance(30 * MIN);
    await tel.flush();
    await tel.shutdown();
    assert.equal(server.requests.length, 0, JSON.stringify(environ));
    assert.equal(queueLines(dir).length, 0, 'nothing is queued');
    assert.equal(tel.recent().length, 1);
    assert.equal(identityOf(dir).notice_ms, 0);
  }
  // With nowhere to send yet the notice is shown all the same, and its time on screen counts: by the time there
  // is somewhere, the person has had their ten minutes.
  const dir = tempDir(t);
  const clock = fakeClock();
  const before = await ready(t, { ...fresh, dir, clock, environ: NO_KEY });
  before.tel.noticeOnScreen();
  before.tel.track('app_opened', {});
  clock.advance(12 * MIN);
  await before.tel.shutdown();
  assert.equal(queueLines(dir).length, 0);
  assert.ok(identityOf(dir).notice_ms >= READ);
  const after = await ready(t, { ...fresh, dir, clock });
  after.tel.track('app_opened', {});
  clock.advance(MIN);
  await until(() => after.server.requests.length === 1);
});

test('the wait is on the notice alone: telemetry that is off, stopped or given nonsense is not moved by it', async (t) => {
  const { tel, dir, clock } = await ready(t, fresh);
  for (const odd of [undefined, null, 42, 'now', {}]) tel.noticeOnScreen(odd);
  clock.advance(2 * MIN);
  await until(() => identityOf(dir).notice_ms === 2 * MIN);
  tel.setEnabled(false);
  clock.advance(5 * MIN);
  tel.noticeOnScreen(); // off: the notice is not owed, and nothing is counted
  tel.setEnabled(true);
  clock.advance(5 * MIN);
  await tel.shutdown();
  assert.equal(identityOf(dir).notice_ms, 2 * MIN, 'what was counted before it went off, and no more');
  tel.noticeOnScreen();
  tel.markNoticeShown();
  assert.equal(clock.waiting, 0);
  // Before the files are read, and with no folder at all: nothing throws, nothing is counted.
  const early = make(t, fresh);
  early.tel.noticeOnScreen();
  await early.tel.init();
  early.clock.advance(MIN);
  await until(() => identityOf(early.dir).notice_ms === MIN);
  const none = createTelemetry({});
  none.noticeOnScreen();
  await none.init();
  none.noticeOnScreen();
  await none.shutdown();
});

// ---- the switch ----

test('off: exactly one telemetry_off is sent, the queue is deleted, and nothing is recorded after', async (t) => {
  const { tel, dir, server, clock } = await ready(t);
  for (let i = 0; i < 5; i++) tel.track('feature_used', { name: 'chat_new' });
  await until(() => queueLines(dir).length === 5);
  tel.setEnabled(false);
  tel.setEnabled(false); // a second click changes nothing
  await until(() => server.requests.length === 1);
  assert.deepEqual(server.events, ['telemetry_off'], 'the goodbye, and none of what was queued');
  assert.equal(tel.status().enabled, false);
  assert.equal(tel.status().queued, 0);
  await until(() => !existsSync(path.join(dir, 'queue.jsonl')));

  const before = tel.recent().length;
  tel.track('feature_used', { name: 'chat_new' });
  tel.track('telemetry_off', {});
  tel.milestone('first_chat');
  tel.error('main', new Error('boom'));
  tel.noteCanopySession('claude', '00000000-0000-4000-8000-000000000001');
  clock.advance(10 * MIN);
  await tel.flush();
  await tick();
  assert.equal(server.requests.length, 1, 'still exactly one request, ever');
  assert.equal(tel.recent().length, before);
  assert.equal(tel.recent()[0].event, 'telemetry_off');
  assert.equal(tel.canopySessions().claude.size, 0);
  assert.equal(clock.waiting, 0, 'no timer is left running');
});

test('off cuts a request that is in flight, and its events are not sent later', async (t) => {
  const { tel, server } = await ready(t, { server: fakeServer('hang', 200) });
  for (let i = 0; i < 3; i++) tel.track('feature_used', { name: 'chat_new' });
  const flushing = tel.flush();
  await until(() => server.requests.length === 1);
  tel.setEnabled(false);
  await flushing;
  assert.equal(server.requests[0].signal.aborted, true);
  await until(() => server.requests.length === 2);
  assert.deepEqual(server.requests[1].events.map((e) => e.event), ['telemetry_off']);
});

test('a telemetry_off that can\'t be delivered is not kept: off means nothing waits to be sent', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir, server: fakeServer('network') });
  a.tel.track('feature_used', { name: 'chat_new' });
  a.tel.setEnabled(false);
  await until(() => a.server.requests.length === 1);
  await a.tel.shutdown();
  assert.equal(a.server.requests.length, 1, 'one try');
  assert.equal(queueLines(dir).length, 0);

  const b = await ready(t, { dir });
  assert.equal(b.tel.status().enabled, false, 'still off after a restart');
  b.tel.track('feature_used', { name: 'chat_new' });
  b.clock.advance(5 * MIN);
  await b.tel.flush();
  await b.tel.shutdown();
  assert.equal(b.server.requests.length, 0);
});

test('on again: one telemetry_on, the same install id, and events flow', async (t) => {
  const { tel, server } = await ready(t);
  const id = tel.status().installId;
  tel.setEnabled(false);
  await until(() => server.requests.length === 1);
  tel.setEnabled(true);
  tel.setEnabled(true);
  tel.track('telemetry_on', {}); // only the switch says this
  tel.track('feature_used', { name: 'chat_new' });
  await tel.flush();
  assert.deepEqual(server.events, ['telemetry_off', 'telemetry_on', 'feature_used']);
  assert.equal(server.requests[1].body.batch[0].distinct_id, id);
  assert.equal(tel.status().enabled, true);
});

test('a queue left behind by a crash in the middle of switching off is deleted, not sent', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir, server: fakeServer('network') });
  a.tel.track('feature_used', { name: 'chat_new' });
  await a.tel.shutdown({ timeoutMs: 200 });
  const line = queueLines(dir)[0];
  const id = JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8'));
  writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ ...id, enabled: false })); // the switch was saved...
  writeFileSync(path.join(dir, 'queue.jsonl'), `${line}\n`);                                 // ...the queue was not yet emptied
  const b = await ready(t, { dir });
  assert.equal(b.tel.status().queued, 0);
  await b.tel.shutdown();
  assert.equal(b.server.requests.length, 0);
  assert.equal(queueLines(dir).length, 0);
});

test('setting non-booleans on the switch does nothing', async (t) => {
  const { tel, server } = await ready(t);
  for (const odd of [0, 'false', null, undefined, {}]) tel.setEnabled(odd);
  await tick();
  assert.equal(tel.status().enabled, true);
  assert.equal(server.requests.length, 0);
});

// ---- milestones ----

test('a milestone is sent once per install, however often it is reached, and not again after a restart', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir });
  for (let i = 0; i < 5; i++) a.tel.milestone('first_chat');
  a.tel.milestone('first_message');
  a.tel.milestone('not_a_step');
  a.tel.milestone(undefined);
  await a.tel.flush();
  assert.deepEqual(a.server.requests[0].events.map((e) => e.props.step), ['first_chat', 'first_message']);
  await a.tel.shutdown();

  const b = await ready(t, { dir });
  b.tel.milestone('first_chat');
  b.tel.milestone('first_reply');
  await b.tel.flush();
  assert.deepEqual(b.server.requests[0].events.map((e) => e.props.step), ['first_reply']);
});

test('a step reached while there was nowhere to send it is reported by a later launch that has somewhere', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir, environ: NO_KEY });
  a.tel.milestone('claude_found');
  a.tel.milestone('claude_found');
  assert.equal(a.tel.recent().filter((e) => e.event === 'milestone').length, 1, 'shown once in the list all the same');
  await a.tel.shutdown();
  const b = await ready(t, { dir });
  b.tel.milestone('claude_found');
  await b.tel.flush();
  assert.deepEqual(b.server.requests[0].events.map((e) => e.props.step), ['claude_found']);
});

test('second_day: opening Canopy on a later local date than the first run, once', async (t) => {
  const dir = tempDir(t);
  const first = new Date(2026, 10, 16, 23, 30).getTime();
  const a = await ready(t, { dir, clock: fakeClock(first) });
  assert.equal(a.tel.status().firstRun, true);
  await a.tel.flush();
  assert.deepEqual(a.server.events, [], 'not on the day it was installed');
  await a.tel.shutdown();

  const sameDay = await ready(t, { dir, clock: fakeClock(first + 20 * MIN) });
  assert.equal(sameDay.tel.status().firstRun, false);
  await sameDay.tel.flush();
  assert.deepEqual(sameDay.server.events, []);
  await sameDay.tel.shutdown();

  // 00:10 the next morning: forty minutes later, but a later date.
  const nextDay = await ready(t, { dir, clock: fakeClock(first + 40 * MIN) });
  await nextDay.tel.flush();
  assert.deepEqual(nextDay.server.requests[0].events.map((e) => [e.event, e.props.step]), [['milestone', 'second_day']]);
  await nextDay.tel.shutdown();

  const later = await ready(t, { dir, clock: fakeClock(first + 5 * DAY) });
  await later.tel.flush();
  assert.deepEqual(later.server.events, [], 'only once');
});

test('second_day also counts a Canopy that was simply left open and used the next day', async (t) => {
  let focused = false;
  const { tel, server, clock } = await ready(t, { clock: fakeClock(new Date(2026, 10, 16, 23, 58).getTime()), isFocused: () => focused, idleSeconds: () => 0 });
  clock.advance(5 * MIN); // past midnight, but nobody is there
  await tel.flush();
  assert.deepEqual(server.events, []);
  focused = true;
  clock.advance(MIN);
  await tel.flush();
  assert.deepEqual(server.requests.at(-1).events.map((e) => e.props.step), ['second_day']);
});

// ---- errors, active minutes, chat ids, state ----

test('the same error many times is one event now and one count at quit', async (t) => {
  const { tel, server } = await ready(t);
  for (let i = 0; i < 30; i++) tel.error('main', new Error(`could not read /Users/jane/Acme Rocket/notes ${i}.txt`));
  await tel.flush();
  const [first] = server.requests[0].events;
  assert.equal(server.requests[0].events.length, 1);
  assert.deepEqual({ event: first.event, where: first.props.where, type: first.props.type, count: first.props.count }, { event: 'error', where: 'main', type: 'Error', count: 1 });
  assert.ok(!JSON.stringify(server.requests).includes('jane') && !JSON.stringify(server.requests).includes('Rocket'));
  await tel.shutdown();
  const last = server.requests.at(-1).events;
  assert.equal(last.length, 1);
  assert.equal(last[0].props.count, 29);
  assert.equal(last[0].props.fingerprint, first.props.fingerprint);
});

test('app_closed is the last event of a launch: counts still held back go out before it', async (t) => {
  const { tel, server } = await ready(t);
  for (let i = 0; i < 5; i++) tel.error('main', new Error('it broke'));
  tel.track('feature_used', { name: 'chat_new' });
  tel.track('app_closed', { open_min: 3, active_min: 1 });
  await tel.shutdown();
  const sent = server.requests.flatMap((r) => r.events);
  assert.deepEqual(sent.map((e) => [e.event, e.props.count ?? null]), [['error', 1], ['feature_used', null], ['error', 4], ['app_closed', null]]);
});

test('folders the app knows about never appear in an error, even with spaces at the end of the path', async (t) => {
  const { tel, server } = await ready(t, { localPaths: () => ['/Users/jane', '/Users/jane/Acme Rocket Launch'] });
  tel.error('main', new Error('spawn failed in /Users/jane/Acme Rocket Launch with code 1'));
  await tel.flush();
  assert.equal(server.requests[0].events[0].props.message, 'spawn failed in <path> with code 1');
});

test('active minutes are counted once a minute while Canopy is in front, and reported for the launch', async (t) => {
  let focused = true;
  const clock = fakeClock(new Date(2026, 10, 16, 12, 0).getTime());
  const { tel } = await ready(t, { clock, isFocused: () => focused, idleSeconds: () => 5 });
  clock.advance(3 * MIN);
  focused = false;
  clock.advance(4 * MIN);
  assert.equal(tel.activeMinutes('2026-11-16'), 3);
  assert.equal(tel.activeMinutes('2026-11-15'), 0);
  assert.deepEqual(tel.sessionMinutes(), { open_min: 7, active_min: 3 });
});

test('the conversations that are Canopy\'s are remembered across restarts', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir });
  a.tel.noteCanopySession('claude', '00000000-0000-4000-8000-000000000001');
  a.tel.noteCanopySession('codex', '00000000-0000-4000-8000-000000000002');
  a.tel.noteCanopySession('claude', '/Users/jane/not an id');
  await a.tel.shutdown();
  const b = await ready(t, { dir });
  assert.deepEqual([...b.tel.canopySessions().claude], ['00000000-0000-4000-8000-000000000001']);
  assert.deepEqual([...b.tel.canopySessions().codex], ['00000000-0000-4000-8000-000000000002']);
});

test('when the list of Canopy\'s conversations began, and when the install first ran, are written down once and kept', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const first = make(t, { dir, clock });
  assert.equal(first.tel.firstRunAt(), null, 'not known before the files are read');
  assert.equal(first.tel.canopySessionsSince(), null);
  await first.tel.init();
  const began = new Date(clock.now()).toISOString();
  assert.equal(first.tel.firstRunAt(), began);
  assert.equal(first.tel.canopySessionsSince(), began, 'the list is kept from the first launch that has the switch on');
  clock.advance(3 * DAY);
  first.tel.noteCanopySession('claude', '00000000-0000-4000-8000-000000000001');
  assert.equal(first.tel.canopySessionsSince(), began, 'a chat noted later does not move it');
  await first.tel.shutdown();
  // Days later, another launch: both still say the first day.
  clock.advance(5 * DAY);
  const later = await ready(t, { dir, clock });
  assert.equal(later.tel.firstRunAt(), began);
  assert.equal(later.tel.canopySessionsSince(), began);
  later.tel.setEnabled(false);
  later.tel.setEnabled(true);
  assert.equal(later.tel.canopySessionsSince(), began, 'off and on again does not move it either');
});

test('an install that starts with sharing off keeps no list, until the switch is turned on', async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'opted-out'), ''); // said no before this launch (the marker a damaged identity can't undo)
  const clock = fakeClock();
  const { tel } = await ready(t, { dir, clock });
  assert.equal(tel.status().enabled, false);
  tel.noteCanopySession('claude', '00000000-0000-4000-8000-000000000001');
  assert.equal(tel.canopySessionsSince(), null);
  assert.equal(tel.canopySessions().claude.size, 0);
  clock.advance(2 * DAY);
  tel.setEnabled(true);
  assert.equal(tel.canopySessionsSince(), new Date(clock.now()).toISOString(), 'from the moment it is on');
});

test('the days sharing was off are written down as the switch moves, and kept: from the day it went off to the day it came back', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock(new Date(2026, 10, 10, 12, 0).getTime());
  const fresh = make(t, { dir, clock });
  assert.deepEqual(fresh.tel.offDays(), [], 'nothing is known before the files are read');
  await fresh.tel.init();
  assert.deepEqual(fresh.tel.offDays(), [], 'an install that shares has no days off');
  await fresh.tel.shutdown();
  assert.deepEqual(identityOf(dir).off_days, []);

  clock.advance(2 * DAY); // the 12th
  const a = await ready(t, { dir, clock });
  a.tel.setEnabled(false);
  assert.deepEqual(a.tel.offDays(), [['2026-11-12', null]]);
  a.tel.setEnabled(false);
  await a.tel.shutdown();

  clock.advance(3 * DAY); // the 15th: opened and closed, still off
  const b = await ready(t, { dir, clock });
  assert.deepEqual(b.tel.offDays(), [['2026-11-12', null]], 'kept across a restart, and still open');
  await b.tel.shutdown();

  clock.advance(2 * DAY); // the 17th: back on
  const c = await ready(t, { dir, clock });
  c.tel.setEnabled(true);
  assert.deepEqual(c.tel.offDays(), [['2026-11-12', '2026-11-17']], 'the days Canopy was closed in between are in it');
  c.tel.setEnabled(false);
  c.tel.setEnabled(true);
  assert.deepEqual(c.tel.offDays(), [['2026-11-12', '2026-11-17']], 'off and on again the same day: the same stretch');
  const mine = c.tel.offDays();
  mine.push(['2026-01-01', null]);
  assert.equal(c.tel.offDays().length, 1, 'what is handed out is a copy');
  await c.tel.shutdown();

  clock.advance(5 * DAY); // the 22nd
  const d = await ready(t, { dir, clock });
  d.tel.setEnabled(false);
  clock.advance(DAY); // left open over midnight, turned on the 23rd
  d.tel.setEnabled(true);
  assert.deepEqual(d.tel.offDays(), [['2026-11-12', '2026-11-17'], ['2026-11-22', '2026-11-23']]);
  await d.tel.shutdown();
  // Kept beside the switch itself, in the one file, so the two are always saved together. Dates, and nothing else.
  assert.deepEqual(identityOf(dir).off_days, [['2026-11-12', '2026-11-17'], ['2026-11-22', '2026-11-23']]);
  // None of it was sent anywhere: the list is this Mac's own.
  for (const { server } of [a, b, c, d]) assert.ok(!/off_days|offDays/.test(JSON.stringify(server.requests)));
});

test('a launch that finds sharing off, or is told no from outside (CANOPY_TELEMETRY=0), counts its day as off; the next one that may share ends the stretch', async (t) => {
  // Off from before the first launch (the marker a damaged identity can't undo).
  const dirA = tempDir(t);
  writeFileSync(path.join(dirA, 'opted-out'), '');
  const clockA = fakeClock(new Date(2026, 10, 10, 12, 0).getTime());
  const off = await ready(t, { dir: dirA, clock: clockA });
  assert.deepEqual(off.tel.offDays(), [['2026-11-10', null]]);
  await off.tel.shutdown();

  // The person's own no, said in the environment: the switch is on, and these days are still days of not sharing.
  const dir = tempDir(t);
  const clock = fakeClock(new Date(2026, 10, 10, 12, 0).getTime());
  const said = await ready(t, { dir, clock, environ: { ...TEST_ENV, CANOPY_TELEMETRY: '0' } });
  assert.equal(said.tel.status().enabled, true);
  assert.deepEqual(said.tel.offDays(), [['2026-11-10', null]]);
  await said.tel.shutdown();
  clock.advance(3 * DAY);
  const free = await ready(t, { dir, clock });
  assert.deepEqual(free.tel.offDays(), [['2026-11-10', '2026-11-13']]);
  await free.tel.shutdown();

  // Nowhere to send yet, and an automated run in its own folder: neither is the person saying no.
  for (const environ of [NO_KEY, { ...TEST_ENV, CANOPY_USER_DATA: '/tmp/harness' }]) {
    const other = await ready(t, { environ });
    assert.deepEqual(other.tel.offDays(), [], JSON.stringify(environ));
  }
  // The switch and the list are one save, so a crash can't leave them apart. A file that has them apart all the
  // same (someone edited it, or it has no list at all) is squared with its switch by the launch that finds it: off
  // with no open stretch opens one that day; on with one left open ends it that day.
  const dirB = tempDir(t);
  const clockB = fakeClock(new Date(2026, 10, 10, 12, 0).getTime());
  const first = await ready(t, { dir: dirB, clock: clockB });
  first.tel.setEnabled(false);
  await first.tel.shutdown();
  assert.deepEqual([identityOf(dirB).enabled, identityOf(dirB).off_days], [false, [['2026-11-10', null]]]);
  writeFileSync(path.join(dirB, 'identity.json'), JSON.stringify({ ...identityOf(dirB), off_days: undefined }));
  clockB.advance(2 * DAY);
  const second = await ready(t, { dir: dirB, clock: clockB });
  assert.deepEqual(second.tel.offDays(), [['2026-11-12', null]]);
  await second.tel.shutdown();
  writeFileSync(path.join(dirB, 'identity.json'), JSON.stringify({ ...identityOf(dirB), enabled: true }));
  rmSync(path.join(dirB, 'opted-out'), { force: true });
  clockB.advance(2 * DAY);
  const third = await ready(t, { dir: dirB, clock: clockB });
  assert.equal(third.tel.status().enabled, true);
  assert.deepEqual(third.tel.offDays(), [['2026-11-12', '2026-11-14']]);
});

test('the key/value store keeps what the summary scheduler puts in it', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir });
  a.tel.state.set('summary.lastDate', '2026-11-15');
  assert.equal(a.tel.state.get('summary.lastDate'), '2026-11-15');
  await a.tel.shutdown();
  const b = await ready(t, { dir });
  assert.equal(b.tel.state.get('summary.lastDate'), '2026-11-15');
  assert.equal(b.tel.state.get('never set'), undefined);
});

// ---- what Settings reads ----

test('status says what the Settings page needs, and listeners hear each change once', async (t) => {
  const { tel, clock } = make(t, { answered: false });
  const heard = [];
  const stop = tel.onStatus((s) => heard.push(s));
  await tel.init();
  assert.equal(heard.length, 1);
  assert.deepEqual(Object.keys(heard[0]).sort(), ['blocked', 'enabled', 'endpoint', 'firstRun', 'installId', 'lastSentAt', 'name', 'noticeShown', 'queued', 'sending']);
  assert.deepEqual({ ...heard[0], installId: null }, { enabled: true, name: 'Jane Doe', installId: null, endpoint: true, queued: 0, lastSentAt: null, noticeShown: false, firstRun: true, blocked: null, sending: true });

  tel.markNoticeShown();
  tel.markNoticeShown();
  assert.equal(heard.length, 2);
  assert.equal(heard[1].noticeShown, true);
  tel.setName('  Dr. Jane O\'Neil <jane@example.com>  ');
  assert.equal(heard.at(-1).name, "Dr. Jane O'Neil janeexample.com");
  tel.setName('');
  assert.equal(heard.at(-1).name, '', 'a cleared name is sent as no name, not as the Mac\'s');
  tel.setName(42);
  const n = heard.length;

  for (let i = 0; i < 20; i++) tel.track('feature_used', { name: 'chat_new' });
  assert.equal(heard.length, n, 'a burst of events is not a burst of updates');
  clock.advance(300);
  assert.equal(heard.length, n + 1);
  assert.equal(heard.at(-1).queued, 20);

  stop();
  tel.setEnabled(false);
  assert.equal(heard.length, n + 1, 'a listener that left hears nothing more');
  assert.equal(tel.onStatus('not a function')(), undefined);
});

test('a listener that throws does not stop the others or the change', async (t) => {
  const { tel } = await ready(t, { answered: false });
  const heard = [];
  tel.onStatus(() => { throw new Error('bad listener'); });
  tel.onStatus((s) => heard.push(s));
  tel.markNoticeShown();
  assert.equal(heard.length, 1);
  assert.equal(tel.status().noticeShown, true);
});

test('the name is the person\'s once they set one, and survives a restart; the Mac\'s name is never saved', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir, defaultName: async () => 'Jane Doe' });
  await until(() => a.tel.status().name === 'Jane Doe');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8')).name, null);
  a.tel.setName('JD');
  await a.tel.shutdown();
  const b = await ready(t, { dir, defaultName: 'Somebody Else' });
  assert.equal(b.tel.status().name, 'JD');
  b.tel.track('feature_used', { name: 'chat_new' });
  await b.tel.flush();
  assert.equal(b.server.requests[0].body.batch[0].properties.$set.name, 'JD');
});

test('a Mac that is slow, or fails, to say whose it is does not hold events back for long', async (t) => {
  const never = await ready(t, { defaultName: () => new Promise(() => {}) });
  never.tel.track('feature_used', { name: 'chat_new' });
  const flushing = never.tel.flush();
  await tick();
  assert.equal(never.server.requests.length, 0, 'sending waits for the name...');
  never.clock.advance(3000);
  await flushing;
  const nameless = (server) => { const p = server.requests[0].body.batch[0].properties; return !('name' in p.$set) && p.$unset?.[0] === 'name'; };
  assert.ok(nameless(never.server), '...but only for three seconds, and then with no name');

  const fails = await ready(t, { defaultName: () => { throw new Error('no such user'); } });
  fails.tel.track('feature_used', { name: 'chat_new' });
  await fails.tel.flush();
  assert.ok(nameless(fails.server));
});

test('"what\'s sent" lists the newest 200 events, newest first, cleaned, and keeps them across restarts', async (t) => {
  const dir = tempDir(t);
  const a = await ready(t, { dir });
  for (let i = 0; i < 205; i++) { a.clock.advance(1000); a.tel.track('feature_used', { name: i % 2 ? 'chat_new' : 'home_opened', title: 'secret' }); }
  const list = a.tel.recent();
  assert.equal(list.length, 200);
  assert.deepEqual(Object.keys(list[0]).sort(), ['event', 'props', 'ts']);
  assert.deepEqual(list[0].props, { name: 'home_opened' });
  assert.ok(list[0].ts > list[1].ts);
  await a.tel.shutdown();
  const b = await ready(t, { dir });
  assert.deepEqual(b.tel.recent(), list);
});

// ---- quitting ----

test('shutdown sends what is queued, then nothing more happens', async (t) => {
  const { tel, server, clock } = await ready(t);
  tel.track('app_closed', { open_min: 12, active_min: 5 });
  await tel.shutdown();
  assert.deepEqual(server.events, ['app_closed']);
  tel.track('feature_used', { name: 'chat_new' });
  tel.milestone('first_chat');
  tel.error('main', new Error('late'));
  tel.setEnabled(false);
  tel.setName('Late');
  clock.advance(10 * MIN);
  await tel.flush();
  await tel.shutdown();
  assert.equal(server.requests.length, 1);
  assert.equal(clock.waiting, 0, 'no timer left behind');
});

test('over a real connection, to a stand-in for PostHog on this Mac: one JSON POST to /batch/ that PostHog would take', async (t) => {
  // Everything else here hands Canopy a pretend fetch. This one request is made by Node's own, to a server on this
  // Mac, so what is checked is what really goes over the wire.
  const got = [];
  const web = http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8').on('data', (c) => { text += c; }).on('end', () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(text) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":1}');
    });
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => web.close(resolve)));
  const dir = tempDir(t);
  const tel = createTelemetry({
    dir, appVersion: '0.0.1', osVersion: '26.1', env: 'prod', defaultName: 'Jane Doe', fetch: globalThis.fetch, answeredWaitMs: 0,
    environ: { CANOPY_POSTHOG_HOST: `http://127.0.0.1:${web.address().port}`, CANOPY_POSTHOG_KEY: TEST_KEY },
  });
  // Real timers here, so a limit of 0 would return before the last writes had landed: this one waits for them.
  stopFirst(t, () => tel.shutdown({ timeoutMs: 2000 }));
  await tel.init();
  tel.markNoticeShown();
  tel.track('app_opened', { arch: 'arm64', claude_found: true, first_run: true });
  tel.track('feature_used', { name: 'chat_new' });
  await tel.flush();
  assert.equal(got.length, 1);
  const [req] = got;
  assert.deepEqual([req.method, req.url, req.headers['content-type']], ['POST', '/batch/', 'application/json']);
  assert.equal(req.headers.cookie, undefined);
  assert.equal(req.body.api_key, TEST_KEY);
  assert.deepEqual(req.body.batch.map((e) => e.event), ['app_opened', 'feature_used']);
  // What PostHog asks of every event (https://posthog.com/docs/api/capture): a name, a person, and here a uuid
  // and a time it can read too.
  for (const e of req.body.batch) {
    assert.ok(e.event && e.distinct_id === tel.status().installId && UUID.test(e.uuid));
    assert.equal(new Date(e.timestamp).toISOString(), e.timestamp);
    assert.equal(e.properties.$geoip_disable, true);
  }
  assert.equal(tel.status().queued, 0, 'and its 200 is taken as PostHog having them');
});

test('shutdown is bounded: a server that never answers holds the quit for the timeout and no longer', async (t) => {
  const dir = tempDir(t);
  // Real timers here: this is about real waiting.
  const server = fakeServer('hang');
  const tel = createTelemetry({ dir, appVersion: '0.0.1', osVersion: '26.1', env: 'prod', fetch: server.fetch, environ: TEST_ENV, answeredWaitMs: 0 });
  await tel.init();
  tel.markNoticeShown();
  tel.track('app_closed', { open_min: 1 });
  const t0 = Date.now();
  await tel.shutdown({ timeoutMs: 150 });
  const took = Date.now() - t0;
  assert.ok(took >= 140 && took < 1000, `took ${took} ms`);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].signal.aborted, true, 'the request is cut');
  assert.equal(queueLines(dir).length, 1, 'and the event is still on disk for the next launch');
});

test('shutdown with nothing to send, or before init has finished, returns at once', async (t) => {
  const idle = await ready(t);
  let t0 = Date.now();
  await idle.tel.shutdown();
  assert.ok(Date.now() - t0 < 200);

  const early = make(t);
  early.tel.track('app_opened', {});
  const loading = early.tel.init();
  t0 = Date.now();
  await early.tel.shutdown();
  assert.ok(Date.now() - t0 < 200);
  await loading;
  assert.equal(early.server.requests.length, 0);
  assert.equal(early.clock.waiting, 0, 'a load that finishes after the quit starts no timer');
});

// ---- it can't break Canopy ----

test('nothing throws, whatever is passed in', async (t) => {
  const { tel } = await ready(t);
  const loop = {}; loop.self = loop;
  const odd = [undefined, null, 0, NaN, '', 'x'.repeat(100_000), [], {}, loop, () => {}, Symbol('s'), 10n, new Error('e'), new Proxy({}, { get() { throw new Error('trap'); } })];
  for (const a of odd) {
    for (const b of odd) {
      tel.track(a, b);
      tel.track('feature_used', a, b);
      tel.trackFromWindow(a, b);
      tel.trackFromWindow('feature_used', a, b);
      tel.error(a, b);
      tel.noteCanopySession(a, b);
      tel.state.set(a, b);
      tel.shutdown.length; // (no call: shutdown is tested above)
    }
    tel.milestone(a);
    tel.setEnabled(a);
    tel.setName(a);
    tel.activeMinutes(a);
    tel.state.get(a);
    tel.onStatus(a);
  }
  assert.equal(typeof tel.status().enabled, 'boolean');
  assert.ok(Array.isArray(tel.recent()));
  await tel.flush();
  await tel.shutdown({ timeoutMs: 'soon' });
  await tel.shutdown(null);
});

test('options that make no sense give a telemetry that does nothing, quietly', async () => {
  for (const opts of [undefined, null, {}, { dir: 42 }, { dir: 'relative/folder' }, { dir: '' }, 'nonsense']) {
    const tel = createTelemetry(opts);
    await tel.init();
    tel.track('feature_used', { name: 'chat_new' });
    tel.milestone('first_chat');
    tel.setEnabled(true);
    assert.equal(tel.status().enabled, false);
    assert.equal(tel.status().installId, null);
    assert.deepEqual(tel.recent(), []);
    assert.equal(tel.canopySessions().claude.size, 0);
    assert.equal(tel.canopySessionsSince(), null);
    assert.equal(tel.firstRunAt(), null);
    await tel.flush();
    await tel.shutdown();
  }
});

test('a folder that can\'t be written leaves telemetry off, and Canopy untouched', async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'blocked'), '');
  const { tel, server, logs } = await ready(t, { dir: path.join(dir, 'blocked', 'telemetry') });
  tel.track('feature_used', { name: 'chat_new' });
  tel.setEnabled(true);
  await tel.flush();
  await tel.shutdown();
  assert.equal(tel.status().enabled, false);
  assert.equal(server.requests.length, 0);
  assert.ok(logs.length >= 1 && logs.length <= 8, `the trouble is said, and not over and over: ${logs.length} lines`);
});

test('a log function that throws, and a fetch that throws, change nothing', async (t) => {
  const { tel } = await ready(t, { log: () => { throw new Error('log is broken'); }, fetch: () => { throw new Error('fetch is broken'); }, env: 'dev' });
  tel.track('not_an_event', {});
  tel.track('feature_used', { name: 'chat_new' });
  await tel.flush();
  assert.equal(tel.status().queued, 1, 'kept for a better day');
  await tel.shutdown();
});

test('init can be called many times and loads once', async (t) => {
  const { tel, server } = make(t);
  await Promise.all([tel.init(), tel.init(), tel.init()]);
  const id = tel.status().installId;
  await tel.init();
  assert.equal(tel.status().installId, id);
  tel.track('feature_used', { name: 'chat_new' });
  await tel.flush();
  assert.equal(server.events.length, 1);
});

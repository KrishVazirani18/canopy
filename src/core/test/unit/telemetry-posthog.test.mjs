// How a Canopy event is written for PostHog (src/telemetry/posthog.mjs): the one mapping Canopy uses when it sends
// its events there itself, and the server kept for later uses a copy of. Nothing here sends anything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HOST, batchUrl, toPostHogBatch, toPostHogEvent } from '../../../telemetry/posthog.mjs';
import { EVENTS, cleanBatch } from '../../../telemetry/schema.mjs';
import { daySummaryId } from '../../../telemetry/summary.mjs';

const INSTALL = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PERSON = { name: 'Ada Lovelace', env: 'prod', app_version: '0.0.1', os_version: '26.1', first_seen: '2026-11-01T08:00:00.000Z' };
const event = (over = {}) => ({ id: uuid(1), install_id: INSTALL, event: 'reply_finished', ts: '2026-11-16T11:59:00.000Z', launch_id: uuid(900), env: 'prod', app_version: '0.0.1', os_version: '26.1', schema: 1, props: { engine: 'codex', secs: 12.5, outcome: 'done' }, ...over });

test('an event becomes a PostHog event: the install id is the person, the event id is the uuid', () => {
  assert.deepEqual(toPostHogEvent(event(), PERSON), {
    event: 'reply_finished',
    distinct_id: INSTALL,
    uuid: uuid(1),
    timestamp: '2026-11-16T11:59:00.000Z',
    properties: {
      engine: 'codex', secs: 12.5, outcome: 'done',
      env: 'prod', app_version: '0.0.1', os_version: '26.1', launch_id: uuid(900), schema: 1,
      distinct_id: INSTALL,
      $geoip_disable: true,
      $process_person_profile: true,
      $set: { env: 'prod', app_version: '0.0.1', os_version: '26.1', name: 'Ada Lovelace' },
      $set_once: { first_seen: '2026-11-01T08:00:00.000Z' },
    },
  });
});

test("a prop can never replace the person, the uuid, the person's properties, or the word that says no location", () => {
  const props = { distinct_id: 'someone-else', $set: { name: 'Mallory' }, $set_once: { first_seen: 'never' }, $unset: ['env'], $geoip_disable: false, $process_person_profile: false, os_version: '25.0' };
  const out = toPostHogEvent(event({ event: 'app_opened', env: 'dev', app_version: '0.0.2', props }), { ...PERSON, name: '', env: 'dev', app_version: '0.0.2' });
  assert.equal(out.distinct_id, INSTALL);
  assert.equal(out.properties.distinct_id, INSTALL);
  assert.equal(out.properties.$geoip_disable, true);
  assert.equal(out.properties.$process_person_profile, true);
  assert.equal(out.properties.os_version, '26.1', "the batch's version wins over a prop of the same name");
  assert.deepEqual(out.properties.$set, { env: 'dev', app_version: '0.0.2', os_version: '26.1' }, 'no name when none is shared');
  assert.deepEqual(out.properties.$unset, ['name'], 'and a name PostHog already has is removed');
  assert.deepEqual(out.properties.$set_once, { first_seen: '2026-11-01T08:00:00.000Z' });
});

test('the timestamp is the same text for the same instant, however it was written down; no sent_at goes with it', () => {
  for (const ts of ['2026-11-10T09:00:00+00:00', '2026-11-10T09:00:00.000Z', '2026-11-10T04:00:00-05:00', '2026-11-10T09:00:00.000000+00:00']) {
    const out = toPostHogEvent(event({ ts }), PERSON);
    assert.equal(out.timestamp, '2026-11-10T09:00:00.000Z', ts);
    assert.ok(!('sent_at' in out) && !('sent_at' in out.properties));
  }
});

test("a day's summary is filed under the day it is about, so two copies sent days apart are one event to PostHog", () => {
  // PostHog merges two events that share uuid, name, person and the UTC day of their timestamp, and only those.
  const id = daySummaryId(INSTALL, '2026-11-15');
  const day = (ts, launch) => toPostHogEvent(event({ id, event: 'day_summary', ts, launch_id: uuid(launch), props: { date: '2026-11-15', baseline: false, msgs_claude_canopy: 4 } }), PERSON);
  // Sent the morning after; then again by a launch three days on (Canopy quit before writing down the first).
  const first = day('2026-11-16T13:05:00.000Z', 900);
  const again = day('2026-11-19T02:30:00.000Z', 901);
  assert.equal(first.timestamp, '2026-11-15T12:00:00.000Z', 'noon UTC of the day itself');
  assert.deepEqual([again.uuid, again.event, again.distinct_id, again.timestamp], [first.uuid, first.event, first.distinct_id, first.timestamp]);
  assert.equal(first.properties.date, '2026-11-15', 'and the day stays in the event, where the charts read it');
  // Whatever the Mac's clock or timezone said when it was sent: the date is the only thing read.
  assert.equal(day('1999-01-01T00:00:00.000Z', 900).timestamp, first.timestamp);
  // A summary with no usable date is filed like any other event, when it happened. So is every other event.
  const at = '2026-11-16T13:05:00.000Z';
  for (const date of [undefined, null, '', 'yesterday', '2026-11', '2026-13-45', 20261115]) {
    assert.equal(toPostHogEvent(event({ event: 'day_summary', ts: at, props: { date } }), PERSON).timestamp, at, String(date));
  }
  assert.equal(toPostHogEvent(event({ event: 'app_opened', ts: at, props: { date: '2026-11-15' } }), PERSON).timestamp, at);
});

test('first_seen is said once known, and left out (never sent broken) when it is not', () => {
  assert.deepEqual(toPostHogEvent(event(), { ...PERSON, first_seen: '2026-11-01T08:00:00.123456+00:00' }).properties.$set_once, { first_seen: '2026-11-01T08:00:00.123Z' });
  for (const first_seen of [undefined, null, '', 'never', {}]) {
    const out = toPostHogEvent(event(), { ...PERSON, first_seen });
    assert.ok(!('$set_once' in out.properties), String(first_seen));
    assert.equal(out.properties.$geoip_disable, true);
  }
});

test('where a batch is posted: /batch/ on the host, US unless told otherwise', () => {
  assert.equal(DEFAULT_HOST, 'https://us.i.posthog.com');
  assert.equal(batchUrl(), 'https://us.i.posthog.com/batch/');
  assert.equal(batchUrl(''), 'https://us.i.posthog.com/batch/');
  assert.equal(batchUrl('https://eu.i.posthog.com'), 'https://eu.i.posthog.com/batch/');
  assert.equal(batchUrl('https://eu.i.posthog.com///'), 'https://eu.i.posthog.com/batch/');
  assert.equal(batchUrl('http://127.0.0.1:8010/ingest/'), 'http://127.0.0.1:8010/ingest/batch/');
});

test('a batch the catalog has passed becomes the body of one request: the key, and every event with who sent it', () => {
  // As Canopy builds it (src/telemetry/index.mjs): its own batch, through cleanBatch, then written for PostHog.
  const mine = {
    install_id: INSTALL, name: 'Ada  Lovelace (42)\n', env: 'prod', app_version: '0.0.1', os_version: '26.1', schema: 1, sent_at: '2026-11-16T12:00:00.000Z',
    events: [
      { id: uuid(1), event: 'feature_used', ts: '2026-11-16T11:59:00.000Z', launch_id: uuid(900), props: { name: 'chat_new', title: 'My secret chat' } },
      { id: uuid(2), event: 'chat_text', ts: '2026-11-16T11:59:01.000Z', launch_id: uuid(900), props: { text: 'hello' } },
      { id: 'not-a-uuid', event: 'feature_used', ts: '2026-11-16T11:59:02.000Z', launch_id: uuid(900), props: { name: 'chat_new' } },
      { id: uuid(4), event: 'error', ts: '2026-11-16T11:59:03.000Z', launch_id: uuid(900), props: { where: 'main', fingerprint: '0123456789abcdef', type: 'Error', message: 'ENOENT: no such file /Users/ada/Secret Plans/q3.txt', count: 1 } },
    ],
  };
  const checked = cleanBatch(mine);
  assert.equal(checked.dropped, 2, 'an event the catalog does not list and one with a bad id never reach the mapping');
  const body = toPostHogBatch('phc_test', checked.header, checked.events, '2026-11-01T08:00:00.000Z');
  assert.deepEqual(Object.keys(body), ['api_key', 'batch']);
  assert.equal(body.api_key, 'phc_test');
  assert.deepEqual(body.batch.map((e) => [e.event, e.uuid, e.distinct_id]), [['feature_used', uuid(1), INSTALL], ['error', uuid(4), INSTALL]]);
  const text = JSON.stringify(body);
  for (const secret of ['secret', 'Secret', '/Users/ada', 'q3.txt', 'hello']) assert.ok(!text.includes(secret), secret);
  assert.equal(body.batch[0].properties.$set.name, 'Ada Lovelace', 'the name as the catalog cleans it');
  assert.deepEqual(body.batch[0].properties.$set_once, { first_seen: '2026-11-01T08:00:00.000Z' });
  for (const e of body.batch) assert.deepEqual([e.properties.$geoip_disable, e.properties.$process_person_profile, e.properties.schema], [true, true, 1]);
});

test("none of the catalog's own props is one of PostHog's words, so the mapping never has to choose between them", () => {
  // The mapping's own keys win over a prop of the same name. Only one name is shared, on purpose (os_version, the
  // same thing said twice). A catalog prop called distinct_id, uuid, or anything starting with $ would be lost.
  const mine = ['env', 'app_version', 'launch_id', 'schema', 'distinct_id', 'uuid', 'timestamp', 'event'];
  for (const [name, spec] of Object.entries(EVENTS)) {
    for (const prop of Object.keys(spec)) {
      assert.ok(!prop.startsWith('$'), `${name}.${prop}`);
      assert.ok(!mine.includes(prop), `${name}.${prop}`);
    }
  }
});

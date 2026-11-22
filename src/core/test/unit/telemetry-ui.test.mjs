// Usage stats, the window's side (renderer/src/lib/telemetry-rules.ts): the names the window counts are all on the
// one list of what may leave the Mac (src/telemetry/schema.mjs), so main never drops one without a word; a widget is
// counted by its kind and nothing else; main's answers are read without trusting their shape; and every event has
// its name in plain words for "See what's sent".
// The file is plain TypeScript, so node runs it as it is: no build, no window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as S from '../../../telemetry/schema.mjs';
import { WINDOW_EVENTS } from '../../../telemetry/index.mjs';
import * as R from '../../../../renderer/src/lib/telemetry-rules.ts';
import * as M from '../../../../renderer/src/lib/model-rules.ts';

// ---- the names the window sends ----

test('every feature, settings page, setting and widget kind the window counts is on main’s list', () => {
  for (const name of R.UI_FEATURES) assert.ok(S.FEATURES.includes(name), `feature ${name} is not in schema FEATURES`);
  for (const page of R.UI_SETTINGS_PAGES) assert.ok(S.SETTINGS_PAGES.includes(page), `page ${page} is not in schema SETTINGS_PAGES`);
  for (const key of R.UI_SETTING_KEYS) assert.ok(S.SETTING_KEYS.includes(key), `setting ${key} is not in schema SETTING_KEYS`);
  for (const kind of R.UI_WIDGET_KINDS) assert.ok(S.WIDGET_KINDS.includes(kind), `widget kind ${kind} is not in schema WIDGET_KINDS`);
});

test('the events the window sends are exactly the ones main takes from it', () => {
  assert.deepEqual([...R.UI_EVENTS].sort(), [...WINDOW_EVENTS].sort());
  for (const event of R.UI_EVENTS) assert.ok(Object.hasOwn(S.EVENTS, event), `${event} is not in the schema`);
});

test('no name is listed twice', () => {
  for (const list of [R.UI_FEATURES, R.UI_SETTINGS_PAGES, R.UI_SETTING_KEYS, R.UI_WIDGET_KINDS]) assert.equal(new Set(list).size, list.length);
});

test('what the window sends comes through main’s check whole', () => {
  for (const name of R.UI_FEATURES) assert.deepEqual(S.clean('feature_used', { name }), { name });
  for (const page of R.UI_SETTINGS_PAGES) assert.deepEqual(S.clean('feature_used', { name: 'settings_page', page }), { name: 'settings_page', page });
  for (const kind of R.UI_WIDGET_KINDS) for (const action of ['shown', 'used']) assert.deepEqual(S.clean('widget', { kind, action }), { kind, action });
  // The values the window gives each setting, where it gives one: Appearance's themes, the Permissions menu's modes
  // (controls.tsx MODES), the sounds (lib/sound.ts), the effort slider's stops or "default" (lib/models.ts), a maker's
  // engine, and on or off for a switch (lib/telemetry.ts `setting`).
  const given = {
    theme: ['system', 'light', 'dark'],
    default_mode: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    default_engine: ['claude', 'codex'],
    default_model: [],
    default_effort: [...M.EFFORT_SCALE, 'default'],
    sound: ['chime', 'bell', 'tick', 'none'],
    auto_update: ['on', 'off'], code_mode: ['on', 'off'], canopy_kit: ['on', 'off'], usage_stats: ['on', 'off'],
  };
  assert.deepEqual(Object.keys(given).sort(), [...R.UI_SETTING_KEYS].sort(), 'every setting the window counts is tried here');
  for (const key of R.UI_SETTING_KEYS) {
    assert.deepEqual(S.clean('setting_changed', { key }), { key });
    for (const value of given[key]) assert.deepEqual(S.clean('setting_changed', { key, value }), { key, value }, `${key}: ${value}`);
  }
});

test('a connector’s own name never gets past main: only a public name, or "custom"', () => {
  assert.deepEqual(S.clean('extension_added', { type: 'connector', name: 'acme-internal-billing' }), { type: 'connector', name: 'custom' });
  assert.deepEqual(S.clean('extension_added', { type: 'plugin', name: 'superpowers' }), { type: 'plugin', name: 'superpowers' });
});

// ---- widgets ----

test('a widget is named by the Canopy component that leads it', () => {
  assert.equal(R.widgetKind('<canopy-table>a,b\n1,2</canopy-table>'), 'table');
  assert.equal(R.widgetKind('<canopy-stat label="Open" value="4"></canopy-stat><canopy-chart type="bar">x,y\n1,2</canopy-chart>'), 'chart');
  assert.equal(R.widgetKind('<canopy-stat label="Open" value="4"></canopy-stat>'), 'stat');
  assert.equal(R.widgetKind('<canopy-choices layout="cards"><canopy-choice value="a">A</canopy-choice></canopy-choices>'), 'choices');
  assert.equal(R.widgetKind('<canopy-diff>- a\n+ b</canopy-diff>'), 'diff');
  assert.equal(R.widgetKind('<canopy-tabs><section title="One"><canopy-table>a\n1</canopy-table></section></canopy-tabs>'), 'tabs');
  assert.equal(R.widgetKind('<CANOPY-TABLE\n  sortable>a\n1</CANOPY-TABLE>'), 'table');
  // A component leads even when a script is there to drive it.
  assert.equal(R.widgetKind('<canopy-chart id="c"></canopy-chart><script>tick()</script>'), 'chart');
});

test('plain HTML is interactive when it runs code, a diagram when it draws, else html', () => {
  assert.equal(R.widgetKind('<input type="range" id="n"><script>n.oninput = draw</script>'), 'interactive');
  assert.equal(R.widgetKind('<script type="module">go()</script><p>x</p>'), 'interactive');
  assert.equal(R.widgetKind('<button onclick="canopy.send(\'yes\')">Yes</button>'), 'interactive');
  assert.equal(R.widgetKind('<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>'), 'diagram');
  assert.equal(R.widgetKind('<div class="card"><h3>Sign in</h3><p>Welcome back</p></div>'), 'html');
  // A block of data is not code, and the word "onclick" in a sentence is not a handler.
  assert.equal(R.widgetKind('<script type="application/json">{"a":1}</script><p>x</p>'), 'html');
  assert.equal(R.widgetKind('<p>Set onclick = handler in your code</p>'), 'html');
});

test('nothing to read is "other", and no input throws', () => {
  for (const junk of [undefined, null, '', '   ', 0, {}, [], 42]) assert.equal(R.widgetKind(junk), 'other');
  assert.ok(R.UI_WIDGET_KINDS.includes(R.widgetKind('<<<>>><script')));
});

// ---- reading main's answers ----

test('a status is read field by field, and anything else is no status', () => {
  const s = R.readStatus({ enabled: true, name: 'Sam Rivera', installId: 'abc', endpoint: true, queued: 3, lastSentAt: '2026-11-16T10:00:00.000Z', noticeShown: true, blocked: null, sending: true, extra: 1 });
  assert.deepEqual(s, { enabled: true, name: 'Sam Rivera', installId: 'abc', endpoint: true, queued: 3, lastSentAt: Date.parse('2026-11-16T10:00:00.000Z'), noticeShown: true, blocked: null, sending: true });
  assert.equal(R.readStatus({ enabled: false, lastSentAt: 1700000000000 }).lastSentAt, 1700000000000);
  for (const junk of [undefined, null, 0, '', 'on', [], {}, { enabled: 'yes' }, async () => null]) assert.equal(R.readStatus(junk), null);
});

test('a status that leaves fields out is read on the safe side: the notice is still owed, nothing is waiting', () => {
  assert.deepEqual(R.readStatus({ enabled: true }), { enabled: true, name: '', installId: '', endpoint: false, queued: 0, lastSentAt: null, noticeShown: false, blocked: null, sending: false });
  assert.equal(R.readStatus({ enabled: true, sending: 'yes' }).sending, false);
  // Blocked is read the other way round: any word there means nothing is sent, even one this window does not know.
  assert.deepEqual(['automated', 'env', 'something-new', '', null, undefined, true, 1].map((blocked) => R.readStatus({ enabled: true, blocked }).blocked), ['automated', 'env', 'something-new', null, null, null, null, null]);
  assert.equal(R.readStatus({ enabled: true, noticeShown: 'yes' }).noticeShown, false);
  assert.equal(R.readStatus({ enabled: true, queued: -4, lastSentAt: 'not a date' }).queued, 0);
  assert.equal(R.readStatus({ enabled: true, lastSentAt: 'not a date' }).lastSentAt, null);
});

test('the first-launch notice is owed only when stats are on, can be sent from this copy, and it was never seen', () => {
  // main's status exactly as src/telemetry/index.mjs words it, read the way the window reads it.
  const main = (over = {}) => R.readStatus({ enabled: true, name: '', installId: 'abc', endpoint: true, queued: 0, lastSentAt: null, noticeShown: false, firstRun: true, blocked: null, sending: true, ...over });
  assert.equal(R.noticeDue(main()), true, 'a first launch');
  assert.equal(R.noticeDue(main({ noticeShown: true })), false, 'seen once is seen');
  assert.equal(R.noticeDue(main({ enabled: false, sending: false })), false, 'switched off');
  // Nothing can be sent from this copy, whatever the switch says: an automated run, or CANOPY_TELEMETRY=0.
  assert.equal(R.noticeDue(main({ blocked: 'automated', sending: false })), false);
  assert.equal(R.noticeDue(main({ blocked: 'env', sending: false })), false);
  assert.equal(R.noticeDue(main({ blocked: 'a reason from a newer main', sending: false })), false);
  // No server to send to yet: people still hear of the stats before the first one goes, so it shows.
  assert.equal(R.noticeDue(main({ endpoint: false, sending: false })), true);
  // Before main has answered, and a main that has no usage stats: nothing to say.
  assert.equal(R.noticeDue(null), false);
  assert.equal(R.noticeDue(undefined), false);
  assert.equal(R.noticeDue(R.readStatus({})), false);
});

test('recent events keep their order, their time as ms, and only plain values', () => {
  const list = R.readEvents([
    { event: 'message_sent', ts: '2026-11-16T10:00:00.000Z', props: { engine: 'claude', images_n: 1, queued: false, nested: { a: 1 }, none: null } },
    null, 'x', { ts: 1 }, { event: '' },
    { event: 'telemetry_off', ts: 1700000000000 },
    { event: 'app_closed', props: ['not', 'props'] },
  ]);
  assert.deepEqual(list, [
    { event: 'message_sent', ts: Date.parse('2026-11-16T10:00:00.000Z'), props: { engine: 'claude', images_n: 1, queued: false } },
    { event: 'telemetry_off', ts: 1700000000000, props: {} },
    { event: 'app_closed', ts: null, props: {} },
  ]);
  for (const junk of [undefined, null, {}, 'events', 7]) assert.deepEqual(R.readEvents(junk), []);
  assert.equal(R.readEvents(Array.from({ length: 500 }, () => ({ event: 'app_opened' }))).length, 200);
});

// ---- "See what's sent", in words ----

test('every event main can send has its name in plain words', () => {
  for (const event of Object.keys(S.EVENTS)) {
    assert.ok(Object.hasOwn(R.EVENT_TITLES, event), `${event} has no wording of its own`);
    const title = R.eventTitle({ event, props: {} });
    assert.ok(title && !title.includes('_'), `${event} reads as "${title}"`);
  }
  // And none for an event main no longer has.
  for (const event of Object.keys(R.EVENT_TITLES)) assert.ok(Object.hasOwn(S.EVENTS, event), `${event} is worded but is not an event`);
});

test('an event is worded by what it was', () => {
  assert.equal(R.eventTitle({ event: 'widget', props: { kind: 'table', action: 'shown' } }), 'Widget shown');
  assert.equal(R.eventTitle({ event: 'widget', props: { kind: 'table', action: 'used' } }), 'Widget used');
  assert.equal(R.eventTitle({ event: 'extension_added', props: { type: 'plugin', name: 'custom' } }), 'Plugin added');
  assert.equal(R.eventTitle({ event: 'upkeep', props: { action: 'check', result: 'current' } }), 'Claude Code update check');
  assert.equal(R.eventTitle({ event: 'telemetry_off', props: {} }), 'Usage stats turned off');
  // One the window has no words for yet still reads as words, and junk reads as something.
  assert.equal(R.eventTitle({ event: 'new_thing_done', props: {} }), 'New thing done');
  for (const junk of [undefined, null, {}, { event: 7 }, { event: 'constructor' }]) assert.equal(typeof R.eventTitle(junk), 'string');
  assert.equal(R.eventTitle({ event: 'constructor', props: {} }), 'Constructor');
});

test('props are shown exactly as they were sent', () => {
  assert.deepEqual(R.eventProps({ props: { engine: 'claude', images_n: 0, queued: false, secs: 42.5 } }), ['engine: claude', 'images_n: 0', 'queued: false', 'secs: 42.5']);
  assert.deepEqual(R.eventProps({ props: {} }), []);
  assert.deepEqual(R.eventProps({}), []);
});

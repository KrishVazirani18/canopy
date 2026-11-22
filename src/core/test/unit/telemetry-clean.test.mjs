// schema.mjs as the client relies on it: clean() lets through only what the catalog lists, and scrubText() takes
// everything personal out of the one piece of free text an event may carry (an error's first line).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { EFFORTS, EVENTS, LIMITS, MODES, SCHEMA_VERSION, SETTING_KEYS, SETTING_VALUES, SUPPORTED_SCHEMAS, clean, cleanBatch, cleanEnvelope, publicModel, scrubText } from '../../../telemetry/schema.mjs';

// ---- clean ----

test('an event that is not in the catalog is refused, whatever it carries', () => {
  assert.equal(clean('chat_text', { text: 'hello' }), null);
  assert.equal(clean('constructor', {}), null);
  assert.equal(clean('__proto__', {}), null);
  assert.equal(clean(undefined, {}), null);
  assert.equal(clean(Symbol('app_opened'), {}), null);
});

test('unknown props and values of the wrong kind are dropped, the rest of the event is kept', () => {
  const props = clean('message_sent', {
    engine: 'claude', model: 'claude-opus-5-5', length: 'short', images_n: 2, files_n: 0, queued: false,
    text: 'what I typed', cwd: '/Users/me/secret-project', title: 'My chat',
  });
  assert.deepEqual(props, { engine: 'claude', model: 'claude-opus-5-5', length: 'short', images_n: 2, files_n: 0, queued: false });
  // A path where a count belongs, a sentence where an enum belongs, a number where a switch belongs: all dropped.
  assert.deepEqual(clean('message_sent', { engine: 'gemini', images_n: '/Users/me/x.png', files_n: -1, queued: 1, length: 'a very long message' }), {});
  assert.deepEqual(clean('feature_used', { name: 'my-private-feature' }), {});
  assert.deepEqual(clean('setting_changed', { key: 'theme', value: 'dark mode please, and my name is Jane' }), { key: 'theme' });
});

test('props that are not a plain object clean to nothing, and nothing throws', () => {
  for (const props of [null, undefined, 'engine=claude', 42, ['claude'], () => {}]) assert.deepEqual(clean('app_closed', props), {});
  assert.deepEqual(clean('app_closed', { open_min: Infinity, active_min: NaN }), {});
  assert.deepEqual(clean('app_closed', { open_min: 12.4, active_min: 999999 }), { open_min: 12 });
});

test('a model that is not a public model name is sent as "other", an extension that is not public as "custom"', () => {
  assert.deepEqual(clean('chat_started', { model: 'acme-internal-finetune-7' }), { model: 'other' });
  assert.deepEqual(clean('chat_started', { model: 'gpt-5.5-codex' }), { model: 'gpt-5.5-codex' });
  assert.deepEqual(clean('extension_added', { type: 'connector', name: 'acme-payroll' }), { type: 'connector', name: 'custom' });
  assert.deepEqual(clean('extension_added', { type: 'connector', name: 'GitHub' }), { type: 'connector', name: 'github' });
});

// ---- words: a mode, an effort level, a setting's value ----

// Things that would fit "a short identifier" and are not Canopy's words: a company, a project, a person, a model.
const NOT_OURS = ['acme', 'acme-prod', 'project-x', 'jane', 'Jane.Doe', 'gpt-5.5', 'internal_v2', 'a', 'x1', 'true', '1', 'DEFAULT', 'Plan', ' plan', 'plan ', 'plan\n', 'default,plan', ''];
const NOT_WORDS = [null, undefined, 0, 1, true, false, {}, [], ['plan'], { toString: () => 'plan' }];

test('a chat\'s mode and effort are one of the engines\' own words, or not said', () => {
  // The modes Claude Code and Codex chats can be in (src/core/session.mjs and codex-session.mjs MODES), and the
  // effort levels (Claude Code's five; Codex's own list adds none, minimal and ultra).
  assert.deepEqual(MODES, ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
  assert.deepEqual(EFFORTS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  for (const mode of MODES) assert.deepEqual(clean('chat_started', { mode }), { mode });
  for (const effort of EFFORTS) assert.deepEqual(clean('chat_started', { effort }), { effort });
  for (const word of [...NOT_OURS, ...NOT_WORDS]) {
    assert.deepEqual(clean('chat_started', { engine: 'codex', mode: word, effort: word, kind: 'new' }), { engine: 'codex', kind: 'new' }, JSON.stringify(word));
  }
  // A word of the other list is not one of this list's.
  assert.deepEqual(clean('chat_started', { mode: 'high', effort: 'plan' }), {});
  // 'manual' is how a settings file may spell the default mode; it is not what a chat is in.
  assert.deepEqual(clean('chat_started', { mode: 'manual' }), {});
});

test('a setting\'s value is one of the words of its own key, and of no other key', () => {
  const onOff = ['on', 'off'];
  const words = {
    theme: ['light', 'dark', 'system'],
    default_mode: MODES,
    default_engine: ['claude', 'codex'],
    default_model: [],
    default_effort: [...EFFORTS, 'default'],
    sound: ['chime', 'bell', 'tick', 'none'],
    notifications: onOff, auto_update: onOff, code_mode: onOff, canopy_kit: onOff, usage_stats: onOff,
    ui_size: ['50', '80', '90', '100', '110', '150', '199', '200'],
  };
  assert.deepEqual(Object.keys(words).sort(), [...SETTING_KEYS].sort(), 'every key has its list here');
  assert.deepEqual(Object.keys(SETTING_VALUES), SETTING_KEYS);
  const every = [...new Set(Object.values(words).flat())];
  for (const key of SETTING_KEYS) {
    assert.deepEqual(clean('setting_changed', { key }), { key }, `${key} alone`);
    for (const value of every) {
      const kept = words[key].includes(value);
      assert.deepEqual(clean('setting_changed', { key, value }), kept ? { key, value } : { key }, `${key}: ${value}`);
    }
    for (const value of [...NOT_OURS, ...NOT_WORDS]) assert.deepEqual(clean('setting_changed', { key, value }), { key }, `${key}: ${JSON.stringify(value)}`);
  }
  // A model is never a setting's value, whichever model it is.
  for (const value of ['opus', 'gpt-6.1-sol', 'other', 'default', 'acme-prod']) assert.deepEqual(clean('setting_changed', { key: 'default_model', value }), { key: 'default_model' });
  // The window's size: a whole number from 50 to 200, written the plain way.
  for (const value of ['49', '201', '0', '5', '1000', '100.0', '1e2', '+100', '-100', '0100', '100%', ' 100', 'big', 100, 99.5]) {
    assert.deepEqual(clean('setting_changed', { key: 'ui_size', value }), { key: 'ui_size' }, JSON.stringify(value));
  }
  // With no key, or a key that is not a setting, there is no list for a value to be on.
  for (const key of [undefined, null, 'acme', 'constructor', '__proto__', 'toString', 42, ['theme'], { toString: () => 'theme' }]) {
    for (const value of ['on', 'dark', '100', 'plan']) assert.deepEqual(clean('setting_changed', { key, value }), {}, `${String(JSON.stringify(key))}: ${value}`);
  }
  assert.deepEqual(clean('setting_changed', { value: 'dark' }), {});
});

test('no prop anywhere takes a free word: every one is a list, a number, a switch, or a kind with rules of its own', () => {
  const kinds = new Set(['bool', 'count', 'secs', 'minutes', 'version', 'model', 'date', 'hex16', 'errtype', 'errtext', 'extension']);
  for (const [event, spec] of Object.entries(EVENTS)) {
    for (const [key, kind] of Object.entries(spec)) {
      if (Array.isArray(kind)) { assert.ok(kind.length > 0 && kind.every((w) => typeof w === 'string' && w), `${event}.${key}`); continue; }
      if (typeof kind === 'function') { assert.equal(`${event}.${key}`, 'setting_changed.value', 'the one value whose list depends on another prop'); continue; }
      assert.ok(kinds.has(kind), `${event}.${key} is a ${kind}`);
    }
  }
  // What a short identifier used to let through.
  assert.deepEqual(clean('chat_started', { mode: 'acme-prod', effort: 'project-x' }), {});
  assert.deepEqual(clean('setting_changed', { key: 'theme', value: 'acme-prod' }), { key: 'theme' });
});

// ---- model ids ----

// The models Codex listed on this Mac, as recorded (fixtures/codex-meta.jsonl: what the model menu's tests run on).
function recordedCodexModels() {
  const lines = fs.readFileSync(new URL('../fixtures/codex-meta.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const asked = lines.find((l) => l.dir === 'out' && l.msg.method === 'model/list');
  return lines.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id).msg.result.data;
}

test('a model is named when its id is one the maker publishes: every id Canopy meets today, and the older public ones', () => {
  const sent = (model) => clean('chat_started', { model }).model;
  // Claude Code's picker as Canopy offers it, and the full ids those names run (and ran).
  const claude = ['default', 'opus', 'sonnet', 'haiku', 'fable', 'fable[1m]', 'opus[1m]', 'sonnet[1m]', 'best', 'opusplan',
    'claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-fable-5-2[1m]',
    'claude-opus-5-6', 'claude-opus-6', 'claude-opus-6-1', 'claude-opus-5-5-20261001', 'claude-opus-6-20270115', 'claude-opus-5-5-20261001[1m]',
    'claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-latest', 'claude-3-opus-20240229'];
  // What Codex lists here (the recording), and OpenAI's other public shapes.
  const listed = recordedCodexModels().filter((m) => !m.hidden).map((m) => m.model);
  assert.deepEqual([...listed].sort(), ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'], 'the recording is the list this test thinks it is');
  const openai = [...listed, 'gpt-6.1-luna', 'gpt-6.2-sol', 'gpt-7', 'gpt-7-luna', 'gpt-5.5-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro',
    'gpt-5.2-max', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-5-2025-08-07', 'gpt-4o-2024-08-06', 'gpt-5.5-codex-2026-03-01', 'o1', 'o3', 'o3-mini', 'o3-pro', 'o4-mini', 'o4-mini-2025-04-16', 'codex-mini-latest'];
  for (const id of [...claude, ...openai]) {
    assert.equal(sent(id), id, id);
    assert.equal(publicModel(id), id);
    assert.equal(publicModel(publicModel(id)), id, 'the server checks it again, and gets the same word');
  }
  // The same on every event that carries a model.
  for (const event of ['chat_started', 'message_sent', 'reply_finished']) assert.deepEqual(clean(event, { model: 'gpt-6.1-sol' }), { model: 'gpt-6.1-sol' });
  // Capitals are not part of a name.
  assert.equal(sent('Opus'), 'opus');
  assert.equal(sent('GPT-6.1-Sol'), 'gpt-6.1-sol');
});

test('a Claude model run through Bedrock or Vertex is named by its bare id, the cloud\'s wrapping taken off', () => {
  const cases = [
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'claude-opus-4-1-20250805'],
    ['eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5-20250929'],
    ['global.anthropic.claude-opus-5-5-20261001-v2:0', 'claude-opus-5-5-20261001'],
    ['apac.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
    ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude-3-5-sonnet-20241022'],
    ['anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['us.anthropic.claude-fable-5-2-20261101-v1:0[1m]', 'claude-fable-5-2-20261101[1m]'],
    ['claude-opus-4-1@20250805', 'claude-opus-4-1-20250805'],
    ['claude-sonnet-4-5@20250929[1m]', 'claude-sonnet-4-5-20250929[1m]'],
  ];
  for (const [id, bare] of cases) {
    assert.equal(publicModel(id), bare, id);
    assert.equal(publicModel(bare), bare);
    assert.deepEqual(clean('reply_finished', { model: id }), { model: bare });
  }
  // Wrapping that names an account, a region of one's own or a profile is not a public id.
  for (const id of ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-20261001-v1:0', 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/acme-prod',
    'acme.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5-acme-v1:0', 'us.acme.claude-opus-5-5', 'projects/acme-prod/locations/us-east5/publishers/anthropic/models/claude-opus-5-5', 'claude-opus-5-5@acme']) {
    assert.equal(publicModel(id), 'other', id);
  }
});

test('a model named by a company, a gateway or a fine-tune is "other": nothing but the public id passes, and nothing may follow one', () => {
  const private_ = [
    // a company's deployments: its own name on a public one
    'gpt-4o-acme-prod', 'gpt-5.5-acme', 'gpt-5.5-codex-acme', 'gpt-5.1-codex-max-acme-eu', 'gpt-6.1-sol-acme', 'acme-gpt-5.5', 'gpt-acme', 'gpt-5.5-prod', 'gpt-5.5_acme', 'gpt-5.5.acme',
    'o3-acme', 'o4-mini-acme-internal', 'codex-acme', 'codex-mini-latest-acme', 'claude-acme-prod', 'claude-opus-5-5-acme', 'claude-acme-5', 'claude-internal-2', 'claude-opus-acme', 'acme-claude-opus-5-5',
    'opus-acme', 'default-acme', 'best-of-acme', 'fable[acme]', 'claude-opus-5-5[acme]', 'opus[2m]',
    // fine-tunes, gateways, other makers, local models
    'ft:gpt-5.5:acme-corp::8abc123', 'ft:gpt-4o-mini-2024-07-18:acme::A1b2C3', 'acme/gpt-5.5', 'openrouter/anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5', 'azure/gpt-5.5', 'bedrock/claude-opus-5-5',
    'acme-internal-finetune-7', 'my-deployment', 'gemini-3-pro', 'llama-4-70b', 'mistral-large', 'qwen3-coder', 'deepseek-r2', 'local', 'custom',
    // near misses: a shape that is almost one
    'gpt', 'gpt-', 'gpt-5.', 'gpt-555', 'gpt-5.5.5', 'gpt-5-turbo', 'gpt-five', 'o', 'o33', 'o3-max', 'claude', 'claude-opus', 'claude-opus-', 'claude-opus-5-5-5', 'claude-opus-555', 'claude-opus-5-5-2026', 'claude-opus-5.5',
    'claude-5', 'claude-instant-1', 'claude-opus-5-5 ', ' opus', 'opus\n', 'opus\nacme', 'gpt-5.5\u0000acme', 'codex', 'codex-auto-review', 'other', '<synthetic>', 'no-such-model', 'claude-haiku-fake',
    // text that is not an id at all
    'what I typed', '/Users/jane/Acme Rocket/model.bin', 'https://models.acme.com/v1', 'jane@example.com', 'sk-ant-api03-AbCdEf0123456789', `gpt-5.5${'-codex'.repeat(40)}`, `claude-opus-${'5'.repeat(200)}`,
  ];
  for (const id of private_) {
    assert.equal(publicModel(id), 'other', JSON.stringify(id));
    assert.deepEqual(clean('message_sent', { model: id }), { model: 'other' });
  }
  // Not a string, or nothing: no model at all is said, rather than "other".
  for (const id of ['', null, undefined, 42, {}, ['opus'], true]) {
    assert.deepEqual(clean('message_sent', { model: id }), {});
    assert.equal(publicModel(id), 'other');
  }
});

test('an error keeps its shape and loses what is personal in its text', () => {
  const props = clean('error', { where: 'main', fingerprint: '0123456789abcdef', type: 'TypeError', message: 'Cannot open /Users/jane/Acme Rocket/app.ts', count: 3, stack: 'at /Users/jane/x.js' });
  assert.deepEqual(props, { where: 'main', fingerprint: '0123456789abcdef', type: 'TypeError', message: 'Cannot open <path>', count: 3 });
  assert.deepEqual(clean('error', { fingerprint: 'not-hex', type: 'has spaces', message: '' }), {});
});

test('an envelope needs an id, a launch id and a time; a batch needs an install id, the schema and events', () => {
  const e = { id: '00000000-0000-4000-8000-000000000001', launch_id: '11111111-1111-4111-8111-111111111111', ts: '2026-11-16T12:00:00.000Z', event: 'app_closed', props: { open_min: 5, note: 'x' } };
  assert.deepEqual(cleanEnvelope(e), { ...e, props: { open_min: 5 } });
  assert.equal(cleanEnvelope({ ...e, id: 'nope' }), null);
  assert.equal(cleanEnvelope({ ...e, ts: 'yesterday' }), null);
  assert.equal(cleanEnvelope({ ...e, event: 'made_up' }), null);
  const body = { install_id: '22222222-2222-4222-8222-222222222222', name: 'Jane <jane@example.com> 555-1234', schema: 1, env: 'dev', app_version: '0.0.1', os_version: '26.1', sent_at: e.ts, events: [e, { ...e, id: 'bad' }] };
  const batch = cleanBatch(body);
  assert.equal(batch.header.name, 'Jane janeexample.com -');
  assert.equal(batch.events.length, 1);
  assert.equal(batch.dropped, 1);
  assert.equal(cleanBatch({ ...body, schema: 2 }).header, null);
  assert.equal(cleanBatch({ ...body, events: new Array(LIMITS.batchEvents + 1).fill(e) }).header, null);
});

test('a batch is taken at the server\'s own schema version and at every older one it still lists, and keeps the version it was sent with', () => {
  const e = { id: '00000000-0000-4000-8000-000000000001', launch_id: '11111111-1111-4111-8111-111111111111', ts: '2026-11-16T12:00:00.000Z', event: 'app_closed', props: { open_min: 5 } };
  const body = { install_id: '22222222-2222-4222-8222-222222222222', name: 'Jane', env: 'prod', app_version: '0.0.1', os_version: '26.1', sent_at: e.ts, events: [e] };
  assert.ok(SUPPORTED_SCHEMAS.includes(SCHEMA_VERSION), 'the version Canopy sends is one the server takes');
  assert.equal(cleanBatch({ ...body, schema: SCHEMA_VERSION }).header.schema, SCHEMA_VERSION);
  // A version nobody listed, a version that only looks like one, and none at all.
  for (const schema of [0, 2, 99, '1', 1.5, null, undefined, [1], true]) assert.equal(cleanBatch({ ...body, schema }).header, null, `schema ${JSON.stringify(schema)}`);
  // The server has moved on and still lists an older version: that Canopy's batches are taken, and stored as the
  // version they said, not as the server's.
  const older = SCHEMA_VERSION + 6;
  SUPPORTED_SCHEMAS.push(older);
  try {
    const batch = cleanBatch({ ...body, schema: older });
    assert.equal(batch.header.schema, older);
    assert.deepEqual(batch.events, [e]);
    assert.equal(cleanBatch({ ...body, schema: SCHEMA_VERSION }).header.schema, SCHEMA_VERSION);
  } finally { SUPPORTED_SCHEMAS.pop(); }
  assert.equal(cleanBatch({ ...body, schema: older }).header, null);
});

// ---- scrubText ----

const scrubbed = (text, ...secrets) => {
  const out = scrubText(text);
  for (const s of secrets) assert.ok(!out.includes(s), `"${s}" survived in: ${out}`);
  assert.equal(scrubText(out), out, `scrubbing twice changed it: ${out}`);
  return out;
};

test('paths go: quoted or not, absolute or relative, with spaces in a folder name', () => {
  assert.equal(scrubbed("ENOENT: no such file or directory, open '/Users/jane/My Side Projects/x/notes.txt'", 'jane', 'Side', 'Projects', 'notes'), 'ENOENT: no such file or directory, open <q>');
  assert.equal(scrubbed('spawn /Users/jane/My Side Projects/x/bin ENOENT', 'jane', 'My Side', 'Side Projects', 'bin'), 'spawn <path> ENOENT');
  assert.equal(scrubbed('Cannot open /Users/jane/Acme Secret Project/src/index.ts for reading', 'jane', 'Acme', 'Secret', 'Project', 'index'), 'Cannot open <path> for reading');
  assert.equal(scrubbed('cwd ~/Projects/Acme Rocket/app is gone', 'Projects', 'Acme', 'Rocket'), 'cwd <path> is gone');
  assert.equal(scrubbed('failed in acme-rocket/src/index.ts at line 12', 'acme-rocket', 'index'), 'failed in <path> at line 12');
  assert.equal(scrubbed('cannot copy /Users/jane/a.txt to /Volumes/Backup Disk/a.txt', 'jane', 'Backup', 'Disk'), 'cannot copy <path>');
  assert.equal(scrubbed('C:\\Users\\jane\\notes.txt not found', 'jane', 'notes'), '<path> not found');
});

test('URLs, emails and people at machines go', () => {
  assert.equal(scrubbed('request to https://api.acme.com/v1/things?key=abc123 failed, reason: socket hang up', 'acme', 'abc123'), 'request to <url> failed, reason: socket hang up');
  assert.equal(scrubbed('file:///Users/jane/My%20Side%20Projects/x.js:12:3 broke', 'jane', 'Side'), '<url> broke');
  assert.equal(scrubbed('mail to jane.doe+work@mail.example.org bounced', 'jane', 'example'), 'mail to <email> bounced');
  assert.equal(scrubbed('Permission denied (publickey) for jane@buildbox', 'jane', 'buildbox'), 'Permission denied (publickey) for <email>');
  assert.equal(scrubbed('git@github.com:Acme/secret-repo.git not found', 'Acme', 'secret-repo'), '<email>:<path> not found');
});

test('machines go: IP addresses, host names, whatever follows a network error code', () => {
  assert.equal(scrubbed('getaddrinfo ENOTFOUND git.acme-internal.corp', 'acme'), 'getaddrinfo ENOTFOUND <host>');
  assert.equal(scrubbed('getaddrinfo ENOTFOUND buildbox', 'buildbox'), 'getaddrinfo ENOTFOUND <host>');
  assert.equal(scrubbed('connect ECONNREFUSED 10.1.2.3:8443', '10.1'), 'connect ECONNREFUSED <host>');
  assert.equal(scrubbed('upstream 192.168.1.20 timed out', '192.168'), 'upstream <ip> timed out');
  assert.equal(scrubbed('Janes-MacBook-Pro.local refused the connection', 'Janes'), '<host> refused the connection');
  assert.equal(scrubbed("Host: build.acme.com. is not in the cert's altnames", 'acme'), "Host: <host>. is not in the cert's altnames");
});

test('keys and tokens go, by shape and by what they are called', () => {
  assert.equal(scrubbed('key sk-ant-api03-AbCdEf0123456789_xyzABCDEF was rejected', 'AbCdEf'), 'key <secret> was rejected');
  // GitHub's documentation token, written in two pieces so a secret scanner does not take this file for a leak.
  assert.equal(scrubbed(`bad token ${'ghp_' + '16C7e42F292c6912E7710c838347Ae178B4a'}`, '16C7e42F'), 'bad token <secret>');
  assert.equal(scrubbed('aws key AKIAIOSFODNN7EXAMPLE is not valid', 'AKIA'), 'aws key <secret> is not valid');
  assert.equal(scrubbed('Authorization: Bearer abc12345 was refused', 'abc12345'), 'Authorization: Bearer <secret> was refused');
  assert.equal(scrubbed('login failed: password=hunter2', 'hunter2'), 'login failed: password=<secret>');
  assert.equal(scrubbed('api_key: "sk-short" is wrong', 'sk-short'), 'api_key: <q> is wrong');
  assert.equal(scrubbed('session 550e8400-e29b-41d4-a716-446655440000 is gone', '550e8400'), 'session <secret> is gone');
  assert.equal(scrubbed('digest 9f86d081884c7d659a2feaa0c55ad015 does not match', '9f86d081'), 'digest <secret> does not match');
  assert.equal(scrubbed('card 4111111111111111 declined', '4111'), 'card <hex> declined');
  assert.equal(scrubbed('process 4815162342 exited', '4815'), 'process <n> exited');
});

test('quoted text goes: straight quotes, curly quotes, and a quote the line was cut inside', () => {
  assert.equal(scrubbed('Unexpected token \'h\', "hello wor"... is not valid JSON', 'hello'), 'Unexpected token <q>, <q>... is not valid JSON');
  assert.equal(scrubbed("Cannot read properties of undefined (reading 'title')"), 'Cannot read properties of undefined (reading <q>)');
  assert.equal(scrubbed('The file “Q4 Board Deck.key” couldn’t be opened', 'Board'), 'The file <q> couldn’t be opened');
  assert.equal(scrubbed("Cannot find module 'left-pad", 'left-pad'), 'Cannot find module <q>');
  // An apostrophe inside a word is not a quote: it must not pair with the real one and leave the name outside.
  assert.equal(scrubbed("the user's file 'payroll.xlsx' is missing", 'payroll'), "the user's file <q> is missing");
});

test('only the first line is kept, cut to the limit, and an ordinary error stays readable', () => {
  assert.equal(scrubText('first line\n    at secret (/Users/jane/x.js:1:1)'), 'first line');
  assert.equal(scrubText(`${'word '.repeat(100)}`), `${'word '.repeat(39)}word`, 'cut at 200 characters, and no space left hanging');
  assert.equal(scrubText('x'.repeat(500)).length, 200);
  // A line ends however it was written: an old Mac's return, a Unicode line break.
  for (const end of ['\r\n', '\r', '\u2028', '\u2029']) assert.equal(scrubText(`first line${end}second line with a secret`), 'first line');
  assert.equal(scrubText('x.map is not a function'), 'x.map is not a function');
  assert.equal(scrubText('Maximum call stack size exceeded'), 'Maximum call stack size exceeded');
  assert.equal(scrubText('Claude Code process exited with code 1'), 'Claude Code process exited with code 1');
  assert.equal(scrubText(null), '');
  assert.equal(scrubText({ toString: () => 'object text' }), 'object text');
});

test('a name keeps letters, spaces and . \' - and nothing else', () => {
  assert.equal(scrubText('  Jane   O\'Neil-Smith Jr.  ', 80, { name: true }), "Jane O'Neil-Smith Jr.");
  assert.equal(scrubText('jane@example.com /Users/jane 555-1234', 80, { name: true }), 'janeexample.com Usersjane -');
  assert.equal(scrubText('Zoë Müller', 80, { name: true }), 'Zoë Müller');
  assert.equal(scrubText('x'.repeat(200), 80, { name: true }).length, 80);
});

// What a database refuses in text: a control character (NUL most of all) and half of a surrogate pair.
const NOT_TEXT = /[\p{Cc}\p{Cs}]/u;
const isText = (s) => !NOT_TEXT.test(s) && s === s.toWellFormed();

test('what comes out is text: no NUL, no control characters, no escape codes', () => {
  assert.equal(scrubText('could not\tread\u0000 the\u0007 file\u007f\u0085 at all\u009f'), 'could not read the file at all');
  assert.equal(scrubText('\u001b[31mError\u001b[0m: it broke'), '[31mError[0m: it broke');
  // Taken out before the other rules, so something hidden inside a key does not let its two halves through.
  assert.equal(scrubbed('key sk-ant-api03-AbCdEf\u00000123456789_xyzABCDEF was rejected', 'AbCdEf', '0123456789'), 'key <secret> was rejected');
  assert.equal(scrubbed('open /Users/jane/Acme\u0000Rocket/app.ts failed', 'jane', 'Acme', 'Rocket'), 'open <path> failed');
  const every = Array.from({ length: 0xa0 }, (_, i) => String.fromCharCode(i)).filter((c) => !/[\n\r]/.test(c)).join('x');
  assert.ok(isText(scrubText(every, 1000)), 'every control character there is');
  assert.ok(isText(scrubText(every, 80, { name: true })));
  assert.equal(scrubText('Jane\u0000 \u001bDoe\u0007', 80, { name: true }), 'Jane Doe');
  // Through the catalog too: an error's text and a batch's name are the two places free text goes.
  assert.deepEqual(clean('error', { message: 'bad \u0000 byte \ud83d in it' }), { message: 'bad byte in it' });
});

test('a character is never cut in half: not by the limit, not by the cap on what is read, not on the way in', () => {
  const pair = '\u{1F600}'; // one character, two units of a JS string
  // The limit falls in the middle of a pair: it counts characters, so the whole of each one is kept.
  for (const lead of ['', 'a', 'ab']) {
    const out = scrubText(lead + pair.repeat(300));
    assert.ok(isText(out), `cut inside a pair after "${lead}"`);
    assert.equal(Array.from(out).length, 200);
    assert.equal(scrubText(out), out, 'and scrubbing it again changes nothing');
  }
  assert.equal(scrubText(`${'z'.repeat(199)}${pair}`), `${'z'.repeat(199)}${pair}`, '200 characters are 200 characters, whatever they are made of');
  assert.equal(scrubText(`${'z'.repeat(200)}${pair}`), 'z'.repeat(200));
  // The cap on how much of a huge line is read (2000 units) falls inside a pair too.
  assert.ok(isText(scrubText(`a${pair.repeat(2000)}`, 5000)));
  // Halves that arrive alone (text someone else already cut) are dropped; whole characters around them stay.
  assert.equal(scrubText(`broken \ud83d half and \ude00 half, whole ${pair}`), `broken half and half, whole ${pair}`);
  assert.equal(scrubText('\ud83d'), '');
  // A name, the same: rare letters are two units each (this one is a real family name).
  const rare = '\u{20BB7}';
  assert.equal(scrubText(`${rare}野家`, 80, { name: true }), `${rare}野家`);
  for (const lead of ['', 'a']) {
    const name = scrubText(lead + rare.repeat(100), 80, { name: true });
    assert.ok(isText(name));
    assert.equal(Array.from(name).length, 80);
  }
  assert.equal(scrubText(`Jane \ud83d Doe \udc00`, 80, { name: true }), 'Jane Doe');
  assert.equal(scrubText(`${'ab '.repeat(40)}`, 80, { name: true }), `${'ab '.repeat(26)}ab`, 'a name cut at a space does not end in one');
  // A batch header's name goes through the same cut.
  const e = { id: '00000000-0000-4000-8000-000000000001', launch_id: '11111111-1111-4111-8111-111111111111', ts: '2026-11-16T12:00:00.000Z', event: 'app_closed', props: {} };
  const header = cleanBatch({ install_id: '22222222-2222-4222-8222-222222222222', schema: SCHEMA_VERSION, name: `a${rare.repeat(200)}\u0000`, events: [e] }).header;
  assert.ok(isText(header.name));
  assert.equal(Array.from(header.name).length, LIMITS.nameChars);
});

/**
 * What `fn` does to strings, as [method, length of the string it was done to]: every String method called, and
 * every pattern run over a string (replace, split, match, test and exec all end in RegExp's own methods).
 */
function stringWork(fn) {
  const seen = [];
  const undo = [];
  const watch = (proto, key, lengthOf) => {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (typeof d?.value !== 'function') return;
    const real = d.value;
    Object.defineProperty(proto, key, { ...d, value(...args) { const n = lengthOf(this, args); if (n !== null) seen.push([String(key), n]); return real.apply(this, args); } });
    undo.push(() => Object.defineProperty(proto, key, d));
  };
  for (const key of Reflect.ownKeys(String.prototype)) if (key !== 'constructor') watch(String.prototype, key, (self) => (typeof self === 'string' ? self.length : null));
  for (const key of [Symbol.replace, Symbol.split, Symbol.match, Symbol.matchAll, Symbol.search, 'exec', 'test']) watch(RegExp.prototype, key, (_self, [text]) => (typeof text === 'string' ? text.length : null));
  try { fn(); } finally { for (const put of undo.reverse()) put(); }
  return seen;
}

test('a huge line costs what a short one does: only its start is ever read (the server scrubs text it did not write)', () => {
  // No clock in this test (a busy Mac would fail it): what is checked is the work itself. The one thing done to the
  // whole of a huge text is cutting its start off, and from there on scrubbing it is, step for step, scrubbing a
  // line that is only that start.
  const READ = 2000; // what scrubText reads of a text (SCRUB_INPUT_MAX)
  const huge = ['a'.repeat(400_000), '/a'.repeat(200_000), 'a1-'.repeat(130_000), '"'.repeat(400_000), '<path> x '.repeat(40_000), 'a.b@'.repeat(100_000),
    '\u0000'.repeat(400_000), '\u{1F600}'.repeat(200_000), '\n'.repeat(400_000), `${'word '.repeat(80_000)}\n${'/Users/jane/x '.repeat(20_000)}`];
  for (const big of huge) {
    for (const [limit, args] of [[400, []], [160, [80, { name: true }]]]) {
      let out, same;
      const work = stringWork(() => { out = scrubText(big, ...args); });
      const start = big.slice(0, READ);
      const short = stringWork(() => { same = scrubText(start, ...args); });
      assert.ok(short.length > 1, 'the rules were seen running');
      // A rule may make a line longer (a two-letter path becomes <path>), never by much: four times is room to spare.
      // (How many, and the first few: a rule let loose on the whole text is seen once for every match it finds.)
      const whole = work.filter(([, n]) => n > READ * 4);
      assert.deepEqual([whole.length, ...whole.slice(0, 3)], [1, ['slice', big.length]], 'nothing but the cut ever touches the whole text');
      assert.deepEqual([work[0], short[0]], [['slice', big.length], ['slice', READ]]);
      assert.equal(work.length, short.length);
      assert.deepEqual(work.slice(1), short.slice(1), 'the same work as for its first 2000 characters alone');
      assert.equal(out, same);
      assert.ok(out.length <= limit);
    }
  }
});

test('the check above can see: a rule run over a whole long text is noticed, however it is run, and String is left as it was', () => {
  const long = 'x'.repeat(9000);
  const seen = (fn) => stringWork(fn).some(([, n]) => n === long.length);
  const replace = String.prototype.replace, exec = RegExp.prototype.exec, split = RegExp.prototype[Symbol.split];
  for (const fn of [() => long.replace(/y/g, ''), () => long.split(/y/), () => /y/.test(long), () => /y/.exec(long), () => long.match(/y/), () => long.trim(), () => Array.from(long), () => [...long], () => long.normalize()]) {
    assert.ok(seen(fn), String(fn));
  }
  assert.deepEqual(stringWork(() => long.slice(0, 10).replace(/y/g, '')).filter(([, n]) => n === long.length), [['slice', long.length]], 'what is done to a piece of it is not');
  assert.deepEqual(stringWork(() => {}), []);
  assert.throws(() => stringWork(() => { throw new Error('inside'); }), /inside/);
  assert.deepEqual([String.prototype.replace, RegExp.prototype.exec, RegExp.prototype[Symbol.split]], [replace, exec, split], 'everything is put back, after a throw too');
});

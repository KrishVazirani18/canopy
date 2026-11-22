// account-keys.mjs: which pasted text is a key Canopy may keep, and the one request that checks a key.
// `fetch` is a stand-in that records what it was asked and answers from the test: nothing here reaches Anthropic
// or OpenAI, and every "key" is made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const K = await core('account-keys.mjs');
const missing = K.__missing ? `account-keys.mjs: ${K.__missing}` : false;

const BODY = 'NOT-A-REAL-KEY-0123456789abcdefghijklmnopqrstuvwxyz';
const KEY = `sk-ant-api03-${BODY}-4f2a`;

// ---- shape ----

test('an Anthropic API key is taken as it is, and only its last four characters are a hint', { skip: missing }, () => {
  assert.deepEqual(K.keyShape('claude', KEY), { ok: true, key: KEY, hint: '4f2a' });
  for (const pasted of [`  ${KEY}\n`, `"${KEY}"`, `'${KEY}'`, `\`${KEY}\``, ` "${KEY}" \r\n`, `"${KEY}`, `${KEY}'`]) {
    assert.deepEqual(K.keyShape('claude', pasted), { ok: true, key: KEY, hint: '4f2a' }, JSON.stringify(pasted));
  }
  assert.equal(K.keyShape('claude', `sk-ant-api04-${BODY}_x-Y9`).hint, 'x-Y9', 'a later key version, and every character a key may have');
});

test('a Claude sign-in token is refused by its shape: Canopy never holds a plan login', { skip: missing }, () => {
  for (const token of [`sk-ant-oat01-${BODY}`, `sk-ant-ort01-${BODY}`, `sk-ant-sid01-${BODY}`, `SK-ANT-OAT01-${BODY}`, `  "sk-ant-oat01-${BODY}"  `, `'sk-ant-ort01-${BODY}`, 'sk-ant-oat']) {
    const r = K.keyShape('claude', token);
    assert.deepEqual([r.ok, r.code], [false, 'plan-token'], token);
    assert.match(r.message, /sign-in token/);
    assert.ok(!('key' in r) && !('hint' in r));
  }
});

test('an Admin key, something that is not a key, and nothing at all are each refused with their own reason', { skip: missing }, () => {
  const admin = K.keyShape('claude', `sk-ant-admin01-${BODY}`);
  assert.deepEqual([admin.ok, admin.code], [false, 'admin-key']);
  assert.match(admin.message, /Admin API key/);
  const notKeys = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 'sk-abcdefghijklmnopqrstuvwxyz', `sk-ant-${BODY}`, `sk-ant-api03-${BODY} extra`, `sk-ant-api03-${BODY}\nsecond-line`,
    `ANTHROPIC_API_KEY=${KEY}`, 'sk-ant-api03-short', `sk-ant-api3-${BODY}`, `sk-ant-api03-${BODY}!`, `sk-ant-api03-${'a'.repeat(600)}`, 'hello', `x${KEY}`,
  ];
  for (const text of notKeys) assert.deepEqual([K.keyShape('claude', text).ok, K.keyShape('claude', text).code], [false, 'not-a-key'], text);
  for (const nothing of ['', '   ', '\n', '""', null, undefined, 7, { key: KEY }, [KEY]]) assert.equal(K.keyShape('claude', nothing).code, 'empty', String(nothing));
  // No answer repeats what was pasted, whatever it was.
  for (const text of [...notKeys, `sk-ant-oat01-${BODY}`, `sk-ant-admin01-${BODY}`]) assert.ok(!K.keyShape('claude', text).message.includes(BODY));
});

// ---- OpenAI keys, for Codex ----

const OPENAI = `sk-proj-${BODY}_T3BlbkFJ-x9Zq`;
const OPENAI_KEYS = [OPENAI, `sk-${'a1B2'.repeat(12)}`, `sk-svcacct-${BODY}-7Hq2`, `sk-None-${BODY}`];

test('an OpenAI API key is taken for Codex as it is: a project key, a service account’s, an older one', { skip: missing }, () => {
  assert.deepEqual(K.keyShape('codex', OPENAI), { ok: true, key: OPENAI, hint: '-x9Zq'.slice(-4) });
  for (const key of OPENAI_KEYS) assert.deepEqual(K.keyShape('codex', key), { ok: true, key, hint: key.slice(-4) }, key.slice(0, 12));
  for (const pasted of [`  ${OPENAI}\n`, `"${OPENAI}"`, `'${OPENAI}'`, `\`${OPENAI}\``, ` "${OPENAI}" \r\n`, `"${OPENAI}`, `${OPENAI}'`]) {
    assert.deepEqual(K.keyShape('codex', pasted), { ok: true, key: OPENAI, hint: OPENAI.slice(-4) }, JSON.stringify(pasted));
  }
});

test('what is not an OpenAI API key is refused for Codex, each with its own reason, and never repeated back', { skip: missing }, () => {
  // The other maker's key says where it goes: it is a key, only not one Codex can run on.
  const claudes = K.keyShape('codex', KEY);
  assert.deepEqual([claudes.ok, claudes.code], [false, 'wrong-maker']);
  assert.match(claudes.message, /Anthropic API key.*under Claude/);
  assert.equal(K.keyShape('codex', `sk-ant-oat01-${BODY}`).code, 'wrong-maker', 'nothing of Claude’s is a key for Codex');
  // What a ChatGPT sign-in holds is not a key, and never Canopy's to hold.
  const token = K.keyShape('codex', `eyJhbGciOiJSUzI1NiIs.${BODY}.${BODY}`);
  assert.deepEqual([token.ok, token.code], [false, 'plan-token']);
  assert.match(token.message, /sign-in token/);
  const admin = K.keyShape('codex', `sk-admin-${BODY}`);
  assert.deepEqual([admin.ok, admin.code], [false, 'admin-key']);
  const notKeys = [
    'hello', 'sk-', 'sk-short', 'sk-abc def ghi jkl mno pqr stu', `OPENAI_API_KEY=${OPENAI}`, `${OPENAI} extra`, `${OPENAI}\nsecond-line`, `x${OPENAI}`,
    `sk-${'a'.repeat(600)}`, `${OPENAI}!`, `pk-${BODY}`, 'sk--abcdefghijklmnopqrstuvwxyz', `Bearer ${OPENAI}`,
  ];
  for (const text of notKeys) assert.deepEqual([K.keyShape('codex', text).ok, K.keyShape('codex', text).code], [false, 'not-a-key'], text.slice(0, 24));
  for (const nothing of ['', '   ', '\n', '""', null, undefined, 7, { key: OPENAI }, [OPENAI]]) assert.equal(K.keyShape('codex', nothing).code, 'empty', String(nothing));
  for (const text of [...notKeys, KEY, `sk-admin-${BODY}`, `eyJhbGciOiJSUzI1NiIs.${BODY}.${BODY}`]) {
    const r = K.keyShape('codex', text);
    assert.ok(!r.message.includes(BODY) && !('key' in r) && !('hint' in r), text.slice(0, 24));
  }
  // An OpenAI key is not one for Claude, and the other way round: each maker's sheet takes its own.
  for (const key of OPENAI_KEYS) assert.equal(K.keyShape('claude', key).code, 'not-a-key');
  // A maker Canopy has no accounts for takes nothing.
  for (const engine of ['gemini', '', null, undefined, 7, {}, 'constructor', '__proto__', 'toString']) assert.equal(K.keyShape(engine, OPENAI).code, 'unsupported', String(engine));
});

// ---- the check ----

function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const a = typeof answer === 'function' ? await answer(url, init) : answer;
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetch, calls };
}
const response = (status) => {
  const r = { status, bodyRead: false, cancelled: false, body: { cancel: async () => { r.cancelled = true; } } };
  for (const read of ['text', 'json', 'arrayBuffer']) r[read] = async () => { r.bodyRead = true; return '{"error":{"type":"authentication_error"}}'; };
  return r;
};

test('the check is one GET to Anthropic that lists models, with the key in its header and nowhere else', { skip: missing }, async () => {
  const ok = response(200);
  const { fetch, calls } = fakeFetch(ok);
  assert.deepEqual(await K.checkKey(KEY, { fetch }), { ok: true });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/models?limit=1');
  assert.equal(K.CHECK_URL, url);
  assert.ok(!url.includes(KEY), 'never in the address');
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined, 'no prompt, nothing billed');
  assert.deepEqual(init.headers, { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', accept: 'application/json' });
  assert.equal(init.redirect, 'error', 'a redirect would carry the key to another address');
  assert.equal(init.credentials, 'omit');
  assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted);
  assert.deepEqual([ok.bodyRead, ok.cancelled], [false, true], 'the answer is let go unread');
});

test('a key Anthropic refuses is "rejected"; no usable answer is "unreachable" and says nothing about the key', { skip: missing }, async () => {
  for (const status of [401, 403]) {
    const r = await K.checkKey(KEY, fakeFetch(response(status)));
    assert.deepEqual([r.ok, r.code], [false, 'rejected'], String(status));
  }
  const noAnswer = [
    response(429), response(500), response(529), response(404), response(302), response(204), {}, null, undefined,
    new TypeError('fetch failed'), Object.assign(new Error(`getaddrinfo ENOTFOUND api.anthropic.com ${KEY}`), { code: 'ENOTFOUND' }),
  ];
  for (const answer of noAnswer) {
    const r = await K.checkKey(KEY, fakeFetch(answer));
    assert.deepEqual([r.ok, r.code], [false, 'unreachable'], String(answer?.status ?? answer));
    assert.ok(!JSON.stringify(r).includes(KEY) && !JSON.stringify(r).includes('ENOTFOUND'), 'an error is never passed on in its own words');
  }
  // Nothing to check with, or nothing to check: no request is made.
  const { fetch, calls } = fakeFetch(response(200));
  for (const key of ['', null, undefined, 7]) assert.equal((await K.checkKey(key, { fetch })).code, 'unreachable');
  assert.equal((await K.checkKey(KEY, { fetch: null })).code, 'unreachable');
  assert.equal(calls.length, 0);
});

test('an OpenAI key is checked with one GET to OpenAI that lists models, the key in its header and nowhere else', { skip: missing }, async () => {
  const ok = response(200);
  const { fetch, calls } = fakeFetch(ok);
  assert.deepEqual(await K.checkKey(OPENAI, { engine: 'codex', fetch }), { ok: true });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/models');
  assert.equal(K.OPENAI_CHECK_URL, url);
  assert.ok(!url.includes(OPENAI), 'never in the address');
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined, 'no prompt, nothing billed');
  assert.deepEqual(init.headers, { authorization: `Bearer ${OPENAI}`, accept: 'application/json' });
  assert.equal(init.redirect, 'error', 'a redirect would carry the key to another address');
  assert.equal(init.credentials, 'omit');
  assert.deepEqual([ok.bodyRead, ok.cancelled], [false, true], 'an answer that says yes is let go unread');
  // Each maker's key goes to its own maker, and to no one else.
  const claude = fakeFetch(response(200));
  await K.checkKey(KEY, { fetch: claude.fetch });
  await K.checkKey(KEY, { engine: 'claude', fetch: claude.fetch });
  assert.deepEqual(claude.calls.map((c) => new URL(c.url).host), ['api.anthropic.com', 'api.anthropic.com']);
  // An engine there is no maker for: nothing is sent anywhere.
  const none = fakeFetch(response(200));
  for (const engine of ['gemini', '', null, 7, 'constructor', '__proto__']) assert.equal((await K.checkKey(OPENAI, { engine, fetch: none.fetch })).code, 'unreachable', String(engine));
  assert.equal(none.calls.length, 0);
});

// An answer whose words are OpenAI's own: what it says when it does not know a key, and when it knows it but the key
// may not list models. The masked key in the first is the form OpenAI itself writes.
const said = (status, message) => {
  const r = response(status);
  for (const read of ['text', 'json']) r[read] = async () => { r.bodyRead = true; return JSON.stringify({ error: { message, type: 'invalid_request_error', code: status === 401 ? 'invalid_api_key' : null } }); };
  return r;
};

test('OpenAI: a key it does not know is "rejected"; one it knows but limits is taken; no usable answer says nothing', { skip: missing }, async () => {
  const unknown = await K.checkKey(OPENAI, { engine: 'codex', fetch: fakeFetch(said(401, 'Incorrect API key provided: sk-proj-********x9Zq. You can find your API key at https://platform.openai.com/account/api-keys.')).fetch });
  assert.deepEqual([unknown.ok, unknown.code], [false, 'rejected']);
  assert.match(unknown.message, /^OpenAI didn’t accept that key/);
  assert.ok(!unknown.message.includes('sk-proj') && !unknown.message.includes('platform.openai.com'), 'OpenAI’s own words are never passed on');
  // A 401 with nothing readable in it is still a no.
  for (const bare of [response(401), { status: 401 }, { status: 401, text: async () => 'not json' }, { status: 401, text: async () => { throw new Error('reset'); } }]) {
    assert.equal((await K.checkKey(OPENAI, { engine: 'codex', fetch: fakeFetch(bare).fetch })).code, 'rejected');
  }
  // A key OpenAI knows, limited to some calls: listing models is refused, which says nothing against the key.
  const limited = 'You have insufficient permissions for this operation. Missing scopes: api.model.read. Check that you have the correct role in your organization.';
  for (const answer of [said(401, limited), said(403, limited), response(403), said(403, 'Country, region, or territory not supported')]) {
    assert.deepEqual(await K.checkKey(OPENAI, { engine: 'codex', fetch: fakeFetch(answer).fetch }), { ok: true }, String(answer.status));
  }
  const noAnswer = [
    response(429), response(500), response(503), response(404), response(302), response(204), {}, null, undefined,
    new TypeError('fetch failed'), Object.assign(new Error(`getaddrinfo ENOTFOUND api.openai.com ${OPENAI}`), { code: 'ENOTFOUND' }),
  ];
  for (const answer of noAnswer) {
    const r = await K.checkKey(OPENAI, { engine: 'codex', fetch: fakeFetch(answer).fetch });
    assert.deepEqual([r.ok, r.code], [false, 'unreachable'], String(answer?.status ?? answer));
    assert.match(r.message, /couldn’t reach OpenAI/);
    assert.ok(!JSON.stringify(r).includes(OPENAI) && !JSON.stringify(r).includes('ENOTFOUND'), 'an error is never passed on in its own words');
  }
  // Anthropic's check is as it was: a 403 there is a no, and its answer is never read.
  const anthropic = response(403);
  assert.equal((await K.checkKey(KEY, { fetch: fakeFetch(anthropic).fetch })).code, 'rejected');
  assert.equal(anthropic.bodyRead, false);
});

test('a check that never answers is given up on, and the request is cancelled', { skip: missing, timeout: 10000 }, async () => {
  let signal = null;
  const hung = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
  }));
  const started = Date.now();
  const r = await K.checkKey(KEY, { fetch: hung.fetch, timeoutMs: 40 });
  assert.deepEqual([r.ok, r.code], [false, 'unreachable']);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 5000);
  // An answer in time leaves the request alone: the timer is cleared, nothing is aborted afterwards.
  let quick = null;
  await K.checkKey(KEY, { fetch: async (_url, init) => { quick = init.signal; return response(200); }, timeoutMs: 40 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(quick.aborted, false);
});

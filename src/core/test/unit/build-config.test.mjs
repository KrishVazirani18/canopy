// src/build-config.mjs: what an official build is given (where stats go, where Canopy's own sign-in lives) and a
// copy built from source is not. Nothing here reads the real file: each case hands in its own text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILT_IN, accountService, readBuildFile } from '../../../build-config.mjs';

const NONE = { posthogKey: '', posthogHost: '', supabaseUrl: '', supabaseKey: '' };
const FULL = { posthogKey: 'phc_built', posthogHost: 'https://eu.i.posthog.com', supabaseUrl: 'https://project.example.org', supabaseKey: 'sb_publishable_built' };

test('no file, or a file that is not what it should be, is a copy with nothing configured', () => {
  assert.deepEqual(readBuildFile(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }), NONE);
  for (const text of ['', 'not json', '[]', 'null', '"a string"', '42']) assert.deepEqual(readBuildFile(() => text), NONE, text);
});

test('the file gives four strings: trimmed, and anything else in it is left out', () => {
  assert.deepEqual(readBuildFile(() => JSON.stringify(FULL)), FULL);
  assert.deepEqual(readBuildFile(() => JSON.stringify({ posthogKey: '  phc_built\n', supabaseUrl: 7, supabaseKey: null, posthogHost: { a: 1 }, extra: 'x' })), { ...NONE, posthogKey: 'phc_built' });
  assert.deepEqual(readBuildFile(() => JSON.stringify({ posthogKey: 'k'.repeat(501) })), NONE, 'a value far too long to be one is not one');
});

test('this copy\'s own values are four strings, whatever was or was not written for it', () => {
  assert.deepEqual(Object.keys(BUILT_IN).sort(), Object.keys(NONE).sort());
  for (const v of Object.values(BUILT_IN)) assert.equal(typeof v, 'string');
  assert.ok(Object.isFrozen(BUILT_IN));
});

test('the sign-in is the build\'s, both halves or neither', () => {
  assert.deepEqual(accountService({}, FULL), { url: 'https://project.example.org', key: 'sb_publishable_built' });
  assert.deepEqual(accountService({}, NONE), { url: '', key: '' }, 'a copy built from source has no account');
  assert.deepEqual(accountService({}, { ...FULL, supabaseKey: '' }), { url: '', key: '' });
  assert.deepEqual(accountService({}, { ...FULL, supabaseUrl: '' }), { url: '', key: '' });
  assert.deepEqual(accountService({}, { ...FULL, supabaseUrl: 'https://project.example.org/some/path?x=1' }).url, 'https://project.example.org', 'only where it lives, nothing after it');
});

test('a variable replaces the built-in value whatever it holds: set wrong, it means no sign-in', () => {
  const mine = { CANOPY_SUPABASE_URL: ' https://mine.example.org/ ', CANOPY_SUPABASE_KEY: ' sb_publishable_mine ' };
  assert.deepEqual(accountService(mine, NONE), { url: 'https://mine.example.org', key: 'sb_publishable_mine' });
  assert.deepEqual(accountService(mine, FULL), { url: 'https://mine.example.org', key: 'sb_publishable_mine' });
  assert.deepEqual(accountService({ CANOPY_SUPABASE_URL: 'http://127.0.0.1:54321', CANOPY_SUPABASE_KEY: 'local' }, NONE).url, 'http://127.0.0.1:54321', 'plain http is fine to this Mac itself');
  for (const environ of [
    { CANOPY_SUPABASE_URL: '' }, { CANOPY_SUPABASE_KEY: '' }, { CANOPY_SUPABASE_URL: 'not a url' }, { CANOPY_SUPABASE_URL: 'http://project.example.org' },
    { CANOPY_SUPABASE_URL: 'file:///etc/passwd' }, { CANOPY_SUPABASE_KEY: 'two words' }, { CANOPY_SUPABASE_KEY: 'a\nb' },
  ]) assert.deepEqual(accountService(environ, FULL), { url: '', key: '' }, JSON.stringify(environ));
  assert.deepEqual(accountService(null, FULL), { url: FULL.supabaseUrl, key: FULL.supabaseKey });
});

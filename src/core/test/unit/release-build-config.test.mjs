// scripts/release.mjs: an official release carries the project's sign-in and stats, or stops; the values are in
// place only around the build, so the tests always run without them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadBuildConfig, placeBuildConfig } from '../../../../scripts/release.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-build-config-'));
const FULL = { posthogKey: 'phc_test', posthogHost: 'https://us.i.posthog.com', supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_test' };

test('the values come from the file CANOPY_BUILD_CONFIG names, or one already in place', () => {
  const d = dir(), source = path.join(d, 'keys.json'), target = path.join(d, 'build-config.json');
  fs.writeFileSync(source, JSON.stringify(FULL));
  assert.deepEqual(loadBuildConfig({ source, target }), FULL);
  fs.writeFileSync(target, JSON.stringify(FULL));
  assert.deepEqual(loadBuildConfig({ source: null, target }), FULL);
});

test('with no values, an official release stops and says how to give them', () => {
  assert.throws(() => loadBuildConfig({ source: null, target: path.join(dir(), 'build-config.json') }), /CANOPY_BUILD_CONFIG/);
});

test('a file missing one of the four stops it too, naming what is missing', () => {
  const d = dir(), source = path.join(d, 'keys.json');
  fs.writeFileSync(source, JSON.stringify({ ...FULL, supabaseKey: '' }));
  assert.throws(() => loadBuildConfig({ source, target: path.join(d, 'build-config.json') }), /missing supabaseKey/);
});

test('--unofficial needs no values', () => {
  assert.equal(loadBuildConfig({ unofficial: true, source: '/nowhere' }), null);
});

test('the values are in place only for the build, then things are as they were', () => {
  const d = dir(), target = path.join(d, 'build-config.json');
  const restore = placeBuildConfig(FULL, target);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), FULL);
  restore();
  assert.equal(fs.existsSync(target), false);
  fs.writeFileSync(target, 'old');
  const back = placeBuildConfig(null, target);
  assert.equal(fs.existsSync(target), false);
  back();
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
});

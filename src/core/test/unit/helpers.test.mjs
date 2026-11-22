// The test helpers' own rule: a core module that is missing or does not load fails the run. It used to come back as
// a reason to skip, so a broken module showed as a list of skipped tests and a run that passed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE, core } from '../helpers.mjs';

const HELPERS = pathToFileURL(path.join(HERE, 'helpers.mjs')).href;
// A child of this run must not think it is one of the runner's own test files, nor inherit a scratch core.
const childEnv = (extra = {}) => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.CANOPY_TEST_CORE; return { ...env, ...extra }; };
const scratch = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-helpers-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('a core module that is not there is an error, and one that is there loads', { skip: process.env.CANOPY_TEST_CORE ? 'run against a scratch core' : false }, async () => {
  await assert.rejects(core('no-such-module.mjs'), /src\/core\/no-such-module\.mjs did not load: no-such-module\.mjs does not exist/);
  assert.equal(typeof (await core('redact.mjs')).makeRedactor, 'function');
});

test('a test file whose module does not load fails the run instead of skipping', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'broken.test.mjs');
  fs.writeFileSync(file, [
    `import { test } from 'node:test';`,
    `import { core } from ${JSON.stringify(HELPERS)};`,
    `const X = await core('no-such-module.mjs');`,
    `test('never reached', { skip: X.__missing }, () => {});`,
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--test', file], { env: childEnv(), encoding: 'utf8', timeout: 30000 });
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stdout, /fail 1/);
  assert.doesNotMatch(run.stdout, /skipped [1-9]/);
});

test('against a scratch copy (CANOPY_TEST_CORE) a missing or broken module comes back as a reason to skip', (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'broken.mjs'), 'export const x = ;\n');
  fs.writeFileSync(path.join(dir, 'fine.mjs'), 'export const x = 1;\n');
  const script = `import { core } from ${JSON.stringify(HELPERS)}; const [a, b, c] = await Promise.all(['absent.mjs', 'broken.mjs', 'fine.mjs'].map(core)); console.log(JSON.stringify([a.__missing, typeof b.__missing, c.x]));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv({ CANOPY_TEST_CORE: dir }), encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['absent.mjs does not exist', 'string', 1]);
});

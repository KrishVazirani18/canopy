// A command that only waits (renderer/src/lib/wait.ts): its length read from the sleep at its start, so the agents
// drawer can count it down; anything else is not a wait. The file is plain TypeScript, so node runs it as it is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, waitMs } from '../../../../renderer/src/lib/wait.ts';

test('a sleep at the start is a wait, in any unit, followed by anything', () => {
  assert.equal(waitMs('sleep 300'), 300_000);
  assert.equal(waitMs('  sleep 5m'), 300_000);
  assert.equal(waitMs('sleep 1m 30s'), 90_000);
  assert.equal(waitMs('sleep 1.5h'), 5_400_000);
  assert.equal(waitMs('sleep 270 && echo done'), 270_000);
  assert.equal(waitMs('sleep 60; curl -s localhost'), 60_000);
  assert.equal(waitMs('sleep 10\ngit status'), 10_000);
});

test('anything else is not a wait', () => {
  assert.equal(waitMs('npm test'), null);
  assert.equal(waitMs('cd x && sleep 30'), null);
  assert.equal(waitMs('sleep $N'), null);
  assert.equal(waitMs('sleep 0'), null);
  assert.equal(waitMs('sleepy 30'), null);
  assert.equal(waitMs(undefined), null);
});

test('the clock reads minutes and seconds, hours when it needs them', () => {
  assert.equal(clock(245_000), '4:05');
  assert.equal(clock(3_727_000), '1:02:07');
  assert.equal(clock(-5), '0:00');
  assert.equal(clock(400), '0:01');
});

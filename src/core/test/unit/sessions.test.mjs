// sessions.mjs and history.mjs: the read side of saved conversations. These
// cases only check the guard rails (bad input never throws, nothing is found
// for ids that do not exist); the live suite covers real transcripts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { core } from '../helpers.mjs';

const X = await core('sessions.mjs');
const H = await core('history.mjs');
const noSessions = X.__missing ? `sessions.mjs: ${X.__missing}` : (typeof X.listAll === 'function' ? false : 'sessions.mjs does not export listAll');
const noHistory = H.__missing ? `history.mjs: ${H.__missing}` : (typeof H.loadHistory === 'function' ? false : 'history.mjs does not export loadHistory');

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-sessions-'));
after(() => fs.rmSync(empty, { recursive: true, force: true }));

test('listing a folder with no conversations is empty, and bad folders are ignored', { skip: noSessions }, async () => {
  assert.deepEqual(await X.list(empty), []);
  assert.deepEqual(await X.listAll([empty, empty]), []);
  for (const bad of [undefined, null, [], [null, 7, '', 'relative/dir'], 'relative/dir', 42]) assert.deepEqual(await X.listAll(bad), [], JSON.stringify(bad));
  assert.deepEqual(await X.list('relative/dir'), []);
});

test('lookups for ids that are not sessions answer no, never throw', { skip: noSessions }, async () => {
  for (const id of [randomUUID(), 'latest', '', null, undefined, '--help', '../../etc/passwd', 7]) {
    assert.equal(await X.exists(id, empty), false, String(id));
    assert.equal(await X.info(id, empty), null, String(id));
  }
  assert.equal(await X.exists(randomUUID(), 'relative/dir'), false);
});

test('changes to ids that are not sessions fail with a code, never throw', { skip: noSessions }, async () => {
  const calls = [
    () => X.rename('not-an-id', 'title', empty), () => X.tag('not-an-id', 'x', empty), () => X.remove('not-an-id', empty), () => X.fork('not-an-id', empty),
    () => X.rename(randomUUID(), 'title', 'relative/dir'), () => X.remove(randomUUID(), empty), () => X.fork(randomUUID(), empty), () => X.rename(randomUUID(), 'title', empty),
  ];
  for (const call of calls) {
    const r = await call();
    assert.equal(r.ok, false);
    assert.equal(typeof r.code, 'string');
    assert.equal(typeof r.message, 'string');
    assert.ok(!('error' in r), 'results never use an `error` key');
  }
  assert.doesNotThrow(() => X.invalidate());
  assert.doesNotThrow(() => X.invalidate(empty));
});

test('loadHistory answers with events or one notice, never an exception', { skip: noHistory }, async () => {
  for (const id of ['not-an-id', '', null, undefined, 7]) assert.deepEqual(await H.loadHistory(id, empty), [], String(id));
  const unknown = await H.loadHistory(randomUUID(), empty);
  assert.ok(Array.isArray(unknown));
  assert.ok(unknown.every((e) => e.kind === 'notice'), 'an unreadable session is at most a notice');
  const [a, b] = await Promise.all([H.loadHistory(randomUUID(), empty), H.loadHistory(randomUUID(), 'relative/dir')]);
  assert.ok(Array.isArray(a) && Array.isArray(b));
  assert.doesNotThrow(() => H.clearHistoryCache());
});

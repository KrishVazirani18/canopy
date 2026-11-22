// The durable queue (src/telemetry/queue.mjs) and the file helpers under it (disk.mjs): events survive a restart
// and a crash mid-write, a damaged file costs only its damaged lines, and a full queue drops its oldest events.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { jsonFile, lineFile, readJson, ringFile } from '../../../telemetry/disk.mjs';
import { createQueue } from '../../../telemetry/queue.mjs';
import { envelope, tempDir } from '../telemetry-fakes.mjs';

const ids = (events) => events.map((e) => e.id);
const linesOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);

async function opened(file, opts = {}) {
  const q = createQueue({ file, ...opts });
  await q.load();
  return q;
}

test('events are on disk as soon as they are added, and a new start finds them in order', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  const q = await opened(file);
  for (let i = 1; i <= 5; i++) q.add(envelope(i));
  await q.settled();
  assert.equal(linesOf(file).length, 5);

  const again = await opened(file);
  assert.equal(again.size, 5);
  assert.deepEqual(ids(again.batch(10, 1e9)), [1, 2, 3, 4, 5].map((i) => envelope(i).id));
});

test('events leave by id: what the server took is gone after a restart, the rest stays', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  const q = await opened(file);
  for (let i = 1; i <= 4; i++) q.add(envelope(i));
  q.remove([envelope(1).id, envelope(3).id, 'an-id-that-is-not-here']);
  await q.settled();
  const again = await opened(file);
  assert.deepEqual(ids(again.batch(10, 1e9)), [envelope(2).id, envelope(4).id]);

  again.remove(ids(again.batch(10, 1e9)));
  await again.settled();
  assert.equal(existsSync(file), false, 'an empty queue leaves no file');
});

test('a line cut short by a crash and lines that are not events are skipped; the file is made whole again', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  const good = [envelope(1), envelope(2), envelope(3)];
  writeFileSync(file, [
    JSON.stringify(good[0]),
    '{"id": "half a li',                                        // garbage in the middle
    JSON.stringify(good[1]),
    JSON.stringify({ ...envelope(9), event: 'not_in_schema' }), // an event this version would not send
    JSON.stringify({ ...envelope(8), id: 'not-a-uuid' }),
    JSON.stringify(good[1]),                                    // the same event twice
    '',
    'null',
    JSON.stringify(good[2]).slice(0, 40),                       // the crash: no newline, half an event
  ].join('\n'));
  const q = await opened(file);
  assert.deepEqual(ids(q.batch(10, 1e9)), [good[0].id, good[1].id]);

  // The next event must land on a line of its own, not glued to the half line.
  q.add(envelope(4));
  await q.settled();
  assert.deepEqual(linesOf(file).map((l) => JSON.parse(l).id), [good[0].id, good[1].id, envelope(4).id]);
});

test('what is read back goes through the allowlist again: props this version would not send are dropped', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  writeFileSync(file, `${JSON.stringify(envelope(1, { title: 'My secret chat', page: 'privacy' }))}\n`);
  const q = await opened(file);
  assert.deepEqual(q.batch(1, 1e9)[0].props, { name: 'chat_new', page: 'privacy' });
});

test('a file that is not text at all is treated as empty and replaced', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  writeFileSync(file, Buffer.from([0, 159, 146, 150, 255, 10, 0, 0]));
  const q = await opened(file);
  assert.equal(q.size, 0);
  q.add(envelope(1));
  await q.settled();
  assert.equal((await opened(file)).size, 1);
});

test('a full queue drops its oldest events, by count', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  const warned = [];
  const q = await opened(file, { maxEvents: 100, warn: (kind) => warned.push(kind) });
  for (let i = 1; i <= 101; i++) q.add(envelope(i));
  assert.equal(q.size, 90, 'down to nine tenths, so the file is not rewritten for every event after that');
  assert.equal(q.batch(1, 1e9)[0].id, envelope(12).id);
  assert.equal(warned.length, 1);
  for (let i = 102; i <= 111; i++) q.add(envelope(i));
  assert.equal(q.size, 100, 'room again until the limit is passed');
  await q.settled();
  assert.equal((await opened(file, { maxEvents: 100 })).size, 100);
});

test('a full queue drops its oldest events, by size', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  const one = Buffer.byteLength(JSON.stringify(envelope(1))) + 1;
  const q = await opened(file, { maxBytes: one * 10 });
  for (let i = 1; i <= 11; i++) q.add(envelope(i));
  assert.ok(q.bytes <= one * 9, `${q.bytes} bytes kept`);
  assert.equal(q.batch(100, 1e9).at(-1).id, envelope(11).id, 'the newest is always kept');
  await q.settled();
  assert.ok(readFileSync(file).length <= one * 10);
});

test('a queue left over the limit by an older version is trimmed when it is read', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  writeFileSync(file, `${Array.from({ length: 50 }, (_, i) => JSON.stringify(envelope(i + 1))).join('\n')}\n`);
  const q = await opened(file, { maxEvents: 20 });
  assert.equal(q.size, 18);
  await q.settled();
  assert.equal(linesOf(file).length, 18);
});

test('a batch is the oldest events, within the count and the size asked for, and never empty when events wait', async (t) => {
  const q = await opened(path.join(tempDir(t), 'queue.jsonl'));
  for (let i = 1; i <= 10; i++) q.add(envelope(i));
  const one = Buffer.byteLength(JSON.stringify(envelope(1))) + 1;
  assert.equal(q.batch(3, 1e9).length, 3);
  assert.equal(q.batch(100, one * 4).length, 4);
  assert.equal(q.batch(100, 1).length, 1, 'one event too big for the size still goes, alone');
  assert.deepEqual(q.batch(0, 1e9), []);
  await q.settled();
});

test('clear forgets everything and deletes the file; events added after it are kept', async (t) => {
  const file = path.join(tempDir(t), 'queue.jsonl');
  const q = await opened(file);
  for (let i = 1; i <= 3; i++) q.add(envelope(i));
  q.clear();
  await q.settled();
  assert.equal(q.size, 0);
  assert.equal(existsSync(file), false);
  q.add(envelope(4));
  await q.settled();
  assert.deepEqual(ids((await opened(file)).batch(10, 1e9)), [envelope(4).id]);
});

test('a disk that refuses writes never throws: events stay in memory, the trouble is said once, and the file catches up', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'blocked', 'queue.jsonl');
  writeFileSync(path.join(dir, 'blocked'), 'a file where the folder should be');
  const warned = [];
  const q = createQueue({ file, warn: (kind) => warned.push(kind) });
  await q.load();
  for (let i = 1; i <= 3; i++) { q.add(envelope(i)); await q.settled(); }
  assert.equal(q.size, 3);
  assert.ok(warned.length >= 1 && warned.every((w) => /queue\.jsonl/.test(w)), warned.join(' | '));

  // The disk works again: the next write puts everything memory holds on it, not just the newest line.
  rmSync(path.join(dir, 'blocked'));
  mkdirSync(path.join(dir, 'blocked'));
  q.add(envelope(4));
  await q.settled();
  assert.equal(linesOf(file).length, 4);
});

// ---- the helpers under it ----

test('a JSON file tells a first run from a damaged file, and saves whole or not at all', async (t) => {
  const file = path.join(tempDir(t), 'deep', 'thing.json');
  assert.equal((await readJson(file)).status, 'missing');
  const f = jsonFile(file);
  const value = { n: 1 };
  f.write(value);
  value.n = 2; // saved when its turn comes, so the newest state is what lands
  assert.equal(await f.write(value), true);
  assert.deepEqual(await readJson(file), { status: 'ok', value: { n: 2 } });
  assert.equal(existsSync(`${file}.tmp`), false, 'the temp file was renamed into place');
  writeFileSync(file, '{"n": ');
  assert.equal((await readJson(file)).status, 'corrupt');
  assert.equal((await readJson(path.dirname(file))).status, 'unreadable'); // a folder is not a file to read
});

test('a failed save is reported, resolves false, and the next save works', async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'blocked'), '');
  const warned = [];
  const f = jsonFile(path.join(dir, 'blocked', 'thing.json'), (kind) => warned.push(kind));
  assert.equal(await f.write({ a: 1 }), false);
  assert.equal(warned.length, 1);
  const ok = jsonFile(path.join(dir, 'thing.json'));
  assert.equal(await ok.write({ a: 1 }), true);
});

test('a lines file appends in order and is replaced whole when asked', async (t) => {
  const file = path.join(tempDir(t), 'lines.jsonl');
  let memory = [];
  const f = lineFile(file, { lines: () => memory });
  for (const n of [1, 2, 3]) { memory.push(JSON.stringify({ n })); f.append(memory.at(-1)); }
  await f.settled();
  assert.deepEqual((await f.read()).rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  memory = memory.slice(2);
  f.rewrite();
  memory.push(JSON.stringify({ n: 4 }));
  f.append(memory.at(-1)); // asked for after the rewrite, before it ran: it must appear once, not twice
  await f.settled();
  assert.deepEqual(await f.read(), { rows: [{ n: 3 }, { n: 4 }], damaged: false });
  appendFileSync(file, '{"n":');
  assert.equal((await f.read()).damaged, true);
});

test('a bounded list keeps its newest rows in memory and trims the file now and then', async (t) => {
  const file = path.join(tempDir(t), 'ring.jsonl');
  const ring = ringFile(file, { max: 100 });
  await ring.load();
  for (let n = 1; n <= 260; n++) ring.push({ n });
  await ring.settled();
  assert.equal(ring.rows().length, 100);
  assert.equal(ring.rows()[0].n, 161);
  assert.ok(linesOf(file).length <= 150, `${linesOf(file).length} lines on disk`);

  const again = ringFile(file, { max: 100, check: (row) => (row.n % 2 ? row : null) });
  await again.load();
  assert.ok(again.rows().every((r) => r.n % 2 === 1), 'rows the check refuses are dropped');
  assert.equal(again.rows().at(-1).n, 259);
});

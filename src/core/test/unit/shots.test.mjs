// shots.mjs: the pictures look takes, kept per chat under look-1, look-2, … (the newest 40, on disk, so a reopened
// chat still finds them), one chat's side of it before and after the chat has an id, and the element map as kept.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { core } from '../helpers.mjs';

const SH = await core('shots.mjs');
const missing = SH.__missing ? `shots.mjs: ${SH.__missing}` : false;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-shots-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(root, `store-${++n}`);
const A = '11111111-2222-4333-8444-555555555555';
const B = '99999999-2222-4333-8444-555555555555';
const shot = (o = {}) => ({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), width: 390, height: 800, url: 'http://localhost:3000/', ...o });

test('refs are numbered per chat, and a chat only ever sees its own', { skip: missing }, () => {
  const store = SH.createShotStore({ dir: freshDir() });
  assert.equal(store.put(A, shot()), 'look-1');
  assert.equal(store.put(A, shot()), 'look-2');
  assert.equal(store.put(B, shot()), 'look-1', 'another chat counts from one');
  const got = store.get(A, 'look-2');
  assert.equal(got.data, `data:image/jpeg;base64,${shot().jpeg.toString('base64')}`);
  assert.deepEqual([got.width, got.height, got.url, got.elements], [390, 800, 'http://localhost:3000/', []]);
  assert.equal(typeof got.capturedAt, 'number');
  assert.equal(store.get(B, 'look-2'), null, 'not another chat\'s');
  assert.equal(store.get(A, 'look-9'), null);
  assert.deepEqual(store.refs(A), ['look-1', 'look-2']);
});

test('a ref is look-<number> and a chat is a plain name: nothing else reaches the disk', { skip: missing }, () => {
  const dir = freshDir();
  const store = SH.createShotStore({ dir });
  store.put(A, shot());
  for (const ref of ['look-1.jpg', '../look-1', 'look-', 'look-1234567', 'LOOK-1', 'look-1/x', null, 1]) {
    assert.equal(SH.isShotRef(ref), false, String(ref));
    assert.equal(store.get(A, ref), null, String(ref));
  }
  assert.equal(SH.isShotRef('look-123456'), true);
  for (const chat of ['..', '../x', 'a/b', '', '.hidden', null, `${A}/..`]) {
    assert.equal(store.put(chat, shot()), null, String(chat));
    assert.equal(store.get(chat, 'look-1'), null, String(chat));
  }
  assert.deepEqual(fs.readdirSync(dir), [A]);
});

test('a shot that cannot be kept is not, and nothing throws', { skip: missing }, () => {
  const store = SH.createShotStore({ dir: freshDir() });
  assert.equal(store.put(A, shot({ jpeg: Buffer.alloc(0) })), null);
  assert.equal(store.put(A, shot({ width: 0 })), null);
  assert.equal(store.put(A, null), null);
  const logged = [];
  const broken = SH.createShotStore({ dir: freshDir(), log: (m) => logged.push(m), fs: { ...fs, writeFileSync: () => { throw new Error('disk full'); } } });
  assert.equal(broken.put(A, shot()), null);
  assert.match(logged[0], /disk full/);
  assert.equal(broken.get(A, 'look-1'), null);
});

test('only the newest 40 are kept; refs are never used twice', { skip: missing }, () => {
  const dir = freshDir();
  const store = SH.createShotStore({ dir });
  for (let i = 1; i <= 45; i++) assert.equal(store.put(A, shot({ width: i })), `look-${i}`);
  assert.equal(store.get(A, 'look-5'), null);
  assert.equal(store.get(A, 'look-6').width, 6);
  assert.equal(store.refs(A).length, 40);
  assert.equal(fs.readdirSync(path.join(dir, A)).length, 80, 'a picture and its JSON each');
  assert.equal(store.put(A, shot()), 'look-46');
});

test('after a restart a chat still finds its shots, and counts on from them', { skip: missing }, () => {
  const dir = freshDir();
  const elements = [{ x: 10, y: 20, w: 100, h: 30, tag: 'button', role: null, text: 'Save', selector: '#save' }];
  const before = SH.createShotStore({ dir });
  before.put(A, shot());
  before.put(A, shot({ elements, capturedAt: 1234 }));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, A, 'look-2.json'), 'utf8'));
  assert.deepEqual(meta, { width: 390, height: 800, url: 'http://localhost:3000/', capturedAt: 1234, elements });

  const after = SH.createShotStore({ dir });
  assert.deepEqual(after.get(A, 'look-2').elements, elements);
  assert.equal(after.get(A, 'look-2').capturedAt, 1234);
  assert.equal(after.put(A, shot()), 'look-3');
  // A picture whose JSON never got written (the app quit in between) is not a shot.
  fs.writeFileSync(path.join(dir, A, 'look-9.jpg'), 'x');
  assert.equal(SH.createShotStore({ dir }).put(A, shot()), 'look-4');
});

test('a chat\'s side: kept under its own name until it has an id, then moved to the id', { skip: missing }, () => {
  const dir = freshDir();
  const store = SH.createShotStore({ dir });
  let id = null;
  const mine = store.forChat(() => id);
  assert.equal(mine.put(shot()), 'look-1');
  assert.equal(mine.put(shot()), 'look-2');
  id = A;
  assert.equal(mine.put(shot()), 'look-3', 'it counts on');
  assert.deepEqual(store.refs(A), ['look-1', 'look-2', 'look-3']);
  assert.ok(store.get(A, 'look-1'), 'what it took before it had an id is found by the id');
  assert.deepEqual(fs.readdirSync(dir), [A], 'nothing left under the old name');

  // Its id changes (an edited first message, a fork): the new conversation keeps the refs it already holds.
  id = B;
  assert.equal(mine.put(shot()), 'look-4');
  assert.deepEqual(store.refs(B), ['look-1', 'look-2', 'look-3', 'look-4']);
  assert.deepEqual(store.refs(A), ['look-1', 'look-2', 'look-3'], 'the old one keeps its own');

  // A chat reopened under its id is its id from the start.
  const reopened = SH.createShotStore({ dir }).forChat(() => A);
  assert.equal(reopened.put(shot()), 'look-4');
  assert.equal(reopened.get('look-1').width, 390);
});

test('a chat\'s shots can be removed; past too many chats, the oldest go', { skip: missing }, () => {
  const dir = freshDir();
  const store = SH.createShotStore({ dir });
  store.put(A, shot());
  store.forget(A);
  assert.equal(store.get(A, 'look-1'), null);
  assert.deepEqual(fs.readdirSync(dir), []);

  const crowded = freshDir();
  const first = SH.createShotStore({ dir: crowded });
  for (const k of ['c1', 'c2', 'c3']) first.put(k, shot());
  const past = new Date(Date.now() - 86_400_000);
  fs.utimesSync(path.join(crowded, 'c1'), past, past);
  const later = SH.createShotStore({ dir: crowded, maxChats: 3 });
  later.put('c4', shot());
  assert.deepEqual(fs.readdirSync(crowded).sort(), ['c2', 'c3', 'c4']);
});

test('cleanElements: inside the picture, whole pixels, short words, at most 400', { skip: missing }, () => {
  const size = { width: 400, height: 300 };
  const long = 'word '.repeat(40);
  const out = SH.cleanElements([
    { x: 10.4, y: 20.6, w: 100.2, h: 30, tag: 'BUTTON', role: 'button', text: '  Save\n  changes ', selector: '#save' },
    { x: -50, y: 280, w: 100, h: 50, tag: 'div', text: long, selector: 'x'.repeat(300) },
    { x: 500, y: 10, w: 10, h: 10, tag: 'p' },           // outside
    { x: 10, y: 10, w: 0, h: 10, tag: 'p' },             // no size
    { x: 10, y: 10, w: 10, h: 10, tag: '<img onerror>' }, // not a tag
    { x: '1', y: 2, w: 3, h: 4, tag: 'p' },              // not numbers
    null,
  ], size);
  assert.deepEqual(out[0], { x: 10, y: 21, w: 101, h: 30, tag: 'button', role: 'button', text: 'Save changes', selector: '#save' });
  assert.deepEqual([out[1].x, out[1].y, out[1].w, out[1].h], [0, 280, 50, 20], 'cut to the picture');
  assert.equal(out[1].text.length, 80);
  assert.ok(out[1].text.endsWith('…'));
  assert.equal(out[1].selector.length, 120);
  assert.equal(out[1].role, null);
  assert.equal(out.length, 2);
  const many = Array.from({ length: 500 }, (_, i) => ({ x: 0, y: 0, w: 5, h: 5, tag: 'li', text: String(i) }));
  assert.equal(SH.cleanElements(many, size).length, 400);
  assert.deepEqual(SH.cleanElements('nope', size), []);
});

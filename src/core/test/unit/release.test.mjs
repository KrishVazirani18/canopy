// Making a release (scripts/release.mjs), the disk image's window (scripts/lib/ds-store.mjs, scripts/make-dmg.mjs)
// and the words the window uses for Canopy's own updates (renderer/src/lib/app-update-words.ts). Nothing here builds,
// signs, mounts or publishes anything.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parseFeed, judge } from '../../app-update.mjs';
import * as info from '../../../app-info.mjs';
import { draftNotes, makeFeed, nextVersion } from '../../../../scripts/release.mjs';
import { notaryArgs } from '../../../../scripts/build-app.mjs';
import { LAYOUT } from '../../../../scripts/make-dmg.mjs';
import { aliasFor, binaryPlist, dsStore, windowStore } from '../../../../scripts/lib/ds-store.mjs';
import * as W from '../../../../renderer/src/lib/app-update-words.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-release-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mac = process.platform === 'darwin';

// ---- versions, notes, the feed ----

test('the next version is one step up, or exactly the one named', () => {
  assert.equal(nextVersion('0.0.1', 'patch'), '0.0.2');
  assert.equal(nextVersion('0.0.1', 'minor'), '0.1.0');
  assert.equal(nextVersion('0.9.4', 'major'), '1.0.0');
  assert.equal(nextVersion('0.1.9', 'patch'), '0.1.10');
  assert.equal(nextVersion('0.0.1', '0.1.0'), '0.1.0');
  assert.equal(nextVersion('0.0.1', 'huge'), null);
  assert.equal(nextVersion('0.0.1', '1.0'), null);
});

test('release notes are what changed for a person, in plain groups', () => {
  const notes = draftNotes([
    'feat(chat): a task card opens and closes smoothly', 'fix: opening a link asks one plain question.', 'perf(engine): smaller skill lists for Claude and Codex chats',
    'chore: bump deps', 'docs: releasing', 'release: v0.1.0', 'refactor(core): split the session', 'test: more', 'Merge branch x', 'feat!: a new sidebar',
  ]);
  assert.equal(notes, 'New\n- A task card opens and closes smoothly\n- A new sidebar\n\nFixed\n- Opening a link asks one plain question\n\nFaster\n- Smaller skill lists for Claude and Codex chats');
  assert.equal(draftNotes(['chore: tidy', 'docs: x']), 'Small fixes and improvements.');
});

test('a release\'s feed is one the app accepts, and points at that release\'s own zip', () => {
  const zip = { sha256: 'a'.repeat(64), size: 123456 };
  const feed = makeFeed({ version: '0.1.1', notes: 'Fixed\n- A thing', zip, required: undefined, previous: null });
  assert.equal(feed.zipUrl, `https://github.com/${info.RELEASE_REPO}/releases/download/v0.1.1/Canopy-0.1.1-mac.zip`);
  assert.equal(feed.minVersion, null);
  const read = parseFeed(JSON.stringify(feed));
  assert.equal(read.version, '0.1.1');
  assert.equal(read.zipSha256, zip.sha256);
  assert.equal(read.zipSize, zip.size);
  assert.deepEqual(judge('0.1.0', read), { newer: true, required: false });
});

test('--required makes this version the oldest allowed, and later releases keep that floor', () => {
  const zip = { sha256: 'b'.repeat(64), size: 1 };
  const required = makeFeed({ version: '0.1.2', notes: '', zip, required: 'This update fixes sign-in. Restart to continue.', previous: parseFeed(JSON.stringify(makeFeed({ version: '0.1.1', notes: '', zip, previous: null }))) });
  assert.equal(required.minVersion, '0.1.2');
  assert.equal(required.minMessage, 'This update fixes sign-in. Restart to continue.');
  assert.deepEqual(judge('0.1.0', parseFeed(JSON.stringify(required))), { newer: true, required: true });
  assert.deepEqual(judge('0.1.2', parseFeed(JSON.stringify(required))), { newer: false, required: false });

  // The next, ordinary release: someone still on 0.1.0 is still required to update; someone on 0.1.2 is not.
  const next = makeFeed({ version: '0.1.3', notes: '', zip, previous: parseFeed(JSON.stringify(required)) });
  assert.equal(next.minVersion, '0.1.2');
  assert.equal(next.minMessage, 'This update fixes sign-in. Restart to continue.');
  assert.deepEqual(judge('0.1.0', parseFeed(JSON.stringify(next))), { newer: true, required: true });
  assert.deepEqual(judge('0.1.2', parseFeed(JSON.stringify(next))), { newer: true, required: false });

  // A later required release raises the floor and replaces the words.
  const again = makeFeed({ version: '0.2.0', notes: '', zip, required: 'Canopy 0.2 is needed from here on.', previous: parseFeed(JSON.stringify(next)) });
  assert.equal(again.minVersion, '0.2.0');
  assert.equal(again.minMessage, 'Canopy 0.2 is needed from here on.');
});

test('the one download link never changes: the newest release\'s Canopy.dmg', () => {
  assert.equal(info.DMG_NAME, 'Canopy.dmg');
  assert.equal(info.downloadUrl(), 'https://github.com/KrishVazirani18/canopy/releases/latest/download/Canopy.dmg');
  assert.equal(info.APP_ID, 'io.github.krishvazirani18.canopy');
  assert.equal(info.DEV_APP_ID, 'io.github.krishvazirani18.canopy.dev');
  assert.match(fs.readFileSync(new URL('../../../../scripts/brand-dev.mjs', import.meta.url), 'utf8'), /BUNDLE_ID = DEV_APP_ID/, 'a run from source is branded with the dev id');
});

test('signing is switched on by the environment alone', () => {
  assert.equal(notaryArgs({}), null);
  assert.deepEqual(notaryArgs({ APPLE_KEYCHAIN_PROFILE: 'canopy' }), ['--keychain-profile', 'canopy']);
  assert.deepEqual(notaryArgs({ APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T' }), ['--apple-id', 'a@b.c', '--password', 'p', '--team-id', 'T']);
  assert.deepEqual(notaryArgs({ APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' }), ['--key', '/k.p8', '--key-id', 'K', '--issuer', 'I']);
  assert.equal(notaryArgs({ APPLE_ID: 'a@b.c' }), null, 'half a set of credentials is none');
});

// ---- the disk image's window ----

/** Reads a .DS_Store back the way Finder would find its records: header, allocator table, DSDB, one leaf. */
function readStore(buf) {
  assert.equal(buf.readUInt32BE(0), 1);
  assert.equal(buf.toString('latin1', 4, 8), 'Bud1');
  const table = buf.readUInt32BE(8);
  assert.equal(buf.readUInt32BE(16), table, 'the table\'s offset is written twice');
  const at = (offset) => 4 + offset;
  const count = buf.readUInt32BE(at(table));
  const addresses = Array.from({ length: count }, (_, i) => buf.readUInt32BE(at(table) + 8 + i * 4));
  const block = (n) => ({ offset: addresses[n] & ~0x1f, size: 2 ** (addresses[n] & 0x1f) });
  assert.equal(block(0).offset, table, 'block 0 is the table itself');
  let p = at(table) + 8 + 256 * 4;
  assert.equal(buf.readUInt32BE(p), 1); p += 4;
  assert.equal(buf.toString('latin1', p + 1, p + 1 + buf[p]), 'DSDB'); p += 1 + buf[p];
  const dsdb = at(block(buf.readUInt32BE(p)).offset);
  const [root, levels, records, nodes, page] = [0, 4, 8, 12, 16].map((o) => buf.readUInt32BE(dsdb + o));
  assert.deepEqual([levels, nodes, page], [0, 1, 4096]);
  let q = at(block(root).offset);
  assert.equal(buf.readUInt32BE(q), 0, 'a leaf');
  assert.equal(buf.readUInt32BE(q + 4), records);
  q += 8;
  const out = [];
  for (let i = 0; i < records; i++) {
    const len = buf.readUInt32BE(q); q += 4;
    const name = Buffer.from(buf.subarray(q, q + len * 2)).swap16().toString('utf16le'); q += len * 2;
    const key = buf.toString('latin1', q, q + 4), type = buf.toString('latin1', q + 4, q + 8); q += 8;
    let value;
    if (type === 'blob') { const n = buf.readUInt32BE(q); value = buf.subarray(q + 4, q + 4 + n); q += 4 + n; }
    else if (type === 'long') { value = buf.readUInt32BE(q); q += 4; }
    else { value = buf.toString('latin1', q, q + 4); q += 4; }
    out.push({ name, key, type, value });
  }
  assert.ok(q <= at(block(root).offset) + block(root).size, 'the records fit their block');
  return out;
}

test('the .DS_Store reads back: a header, a table, and the records in the order Finder keeps them', () => {
  const store = dsStore([
    { name: 'Canopy.app', key: 'Iloc', type: 'blob', value: Buffer.alloc(16, 1) },
    { name: '.', key: 'vSrn', type: 'long', value: 1 },
    { name: 'Applications', key: 'Iloc', type: 'blob', value: Buffer.alloc(16, 2) },
    { name: '.', key: 'icvl', type: 'type', value: 'icnv' },
  ]);
  assert.equal(store.length, 4 + 8192);
  assert.deepEqual(readStore(store).map((r) => `${r.name} ${r.key}`), ['. icvl', '. vSrn', 'Applications Iloc', 'Canopy.app Iloc']);
});

test('the window is the approved one: 640 wide, 400 under the title bar, icons level, the app on the left', { skip: !mac }, () => {
  const folder = path.join(tmp, 'volume', '.background');
  fs.mkdirSync(folder, { recursive: true });
  const picture = path.join(folder, 'background.tiff');
  fs.writeFileSync(picture, 'x');
  const alias = aliasFor(picture, path.join(tmp, 'volume'), 'Canopy');
  const records = readStore(windowStore({
    window: { x: 200, y: 120, width: LAYOUT.width, height: LAYOUT.height + LAYOUT.titleBar }, iconSize: LAYOUT.iconSize, textSize: LAYOUT.textSize, backgroundAlias: alias,
    icons: [{ name: 'Canopy.app', ...LAYOUT.app }, { name: 'Applications', ...LAYOUT.applications }],
  }));
  const of = (name, key) => records.find((r) => r.name === name && r.key === key)?.value;
  assert.deepEqual([LAYOUT.width, LAYOUT.height, LAYOUT.iconSize, LAYOUT.textSize], [640, 400, 128, 13]);

  const win = execFileSync('/usr/bin/plutil', ['-p', '-'], { input: of('.', 'bwsp') }).toString();
  assert.match(win, /"WindowBounds" => "\{\{200, 120\}, \{640, 432\}\}"/);
  for (const off of ['ShowToolbar', 'ShowSidebar', 'ShowStatusBar', 'ShowPathbar', 'ShowTabView']) assert.match(win, new RegExp(`"${off}" => (0|false)`), `${off} is off`);

  const view = execFileSync('/usr/bin/plutil', ['-p', '-'], { input: of('.', 'icvp') }).toString();
  assert.match(view, /"iconSize" => 128/);
  assert.match(view, /"textSize" => 13/);
  assert.match(view, /"backgroundType" => 2/, 'a picture');
  assert.match(view, /"arrangeBy" => "none"/, 'icons stay where they are put');
  assert.equal(of('.', 'icvl'), 'icnv', 'icon view');

  const place = (name) => { const v = of(name, 'Iloc'); return [v.readUInt32BE(0), v.readUInt32BE(4)]; };
  assert.deepEqual(place('Canopy.app'), [150, 168]);
  assert.deepEqual(place('Applications'), [490, 168]);
  assert.equal(place('Canopy.app')[0] + place('Applications')[0], 640, 'the two sit the same distance from the middle');
});

test('the background\'s alias names the file by volume, folder and path', { skip: !mac }, () => {
  const folder = path.join(tmp, 'vol2', '.background');
  fs.mkdirSync(folder, { recursive: true });
  const picture = path.join(folder, 'background.tiff');
  fs.writeFileSync(picture, 'x');
  const alias = aliasFor(picture, path.join(tmp, 'vol2'), 'Canopy');
  assert.equal(alias.readUInt16BE(4), alias.length, 'its own length is written in it');
  assert.equal(alias.readUInt16BE(6), 2, 'version 2');
  assert.equal(alias.toString('utf8', 11, 11 + alias[10]), 'Canopy', 'the volume');
  assert.equal(alias.toString('utf8', 51, 51 + alias[50]), 'background.tiff', 'the file');
  const text = alias.toString('latin1');
  for (const part of ['.background', 'Canopy:.background:background.tiff', '/.background/background.tiff', '/Volumes/Canopy']) assert.ok(text.includes(part), part);
  assert.equal(alias.readUInt16BE(alias.length - 4), 0xffff, 'and it ends with the end mark');
});

test('a plist is written in the binary form Finder keeps', { skip: !mac }, () => {
  const b = binaryPlist({ a: true, n: 3, r: { real: 128 }, s: 'x & y', d: Buffer.from('hi') });
  assert.equal(b.toString('latin1', 0, 6), 'bplist');
  const back = execFileSync('/usr/bin/plutil', ['-p', '-'], { input: b }).toString();
  assert.match(back, /"s" => "x & y"/);
  assert.match(back, /"r" => 128/);
});

// ---- the window's words ----

const status = (o = {}) => ({ supported: true, off: null, current: '0.1.0', auto: true, state: 'idle', progress: null, available: null, ready: null, required: null, error: null, failed: null, canInstall: true, lastCheck: null, downloadUrl: info.downloadUrl(), ...o });
const NOW = 1_800_000_000_000;

test('Settings says where updates stand in one line', () => {
  assert.equal(W.updateLine(status(), false, NOW), 'Not checked yet');
  assert.equal(W.updateLine(status({ lastCheck: { at: NOW - 5 * 60_000, result: 'current' } }), false, NOW), 'Up to date · checked 5 min ago');
  assert.equal(W.updateLine(status({ lastCheck: { at: NOW - 5 * 60_000, result: 'failed' }, error: 'OFFLINE' }), false, NOW), 'Couldn’t check for updates · 5 min ago');
  assert.equal(W.updateLine(status(), true, NOW), 'Checking for updates…');
  assert.equal(W.updateLine(status({ state: 'downloading', available: '0.1.1', progress: 0.42 }), false, NOW), 'Downloading Canopy 0.1.1… 42%');
  assert.equal(W.updateLine(status({ available: '0.1.1', ready: '0.1.1' }), false, NOW), 'Canopy 0.1.1 is ready. Restart to update.');
  assert.equal(W.updateLine(status({ available: '0.1.1', auto: false }), false, NOW), 'Canopy 0.1.1 is available.');
  assert.equal(W.updateLine(status({ available: '0.1.1', canInstall: false }), false, NOW), 'Canopy 0.1.1 is out. Move Canopy to your Applications folder to get updates.');
  assert.equal(W.updateLine(status({ available: '0.1.1', failed: '0.1.1' }), false, NOW), 'Canopy 0.1.1 didn’t start on this Mac. Check again to retry.');
  assert.equal(W.updateLine(status({ available: '0.1.1', error: 'WRONG_CHECKSUM', lastCheck: { at: NOW, result: 'available' } }), false, NOW), 'Couldn’t download Canopy 0.1.1. Canopy tries again later.');
  assert.equal(W.updateLine(status({ state: 'installing', ready: '0.1.1' }), false, NOW), 'Restarting to update…');
});

test('the button beside it does the one useful thing', () => {
  assert.equal(W.updateAction(status()), 'check');
  assert.equal(W.updateAction(status({ available: '0.1.1', ready: '0.1.1' })), 'restart');
  assert.equal(W.updateAction(status({ available: '0.1.1', auto: false })), 'download');
  assert.equal(W.updateAction(status({ available: '0.1.1' })), 'check', 'on its way by itself');
  assert.equal(W.updateAction(status({ available: '0.1.1', failed: '0.1.1' })), 'download');
  assert.equal(W.updateAction(status({ available: '0.1.1', auto: false, canInstall: false })), 'check');
});

test('the card: Restart to update when it is ready, and it waits for chats that are working', () => {
  assert.equal(W.updateCard(status(), 0, false), null);
  assert.equal(W.updateCard(status({ available: '0.1.1' }), 0, false), null, 'nothing is said while it downloads by itself');
  assert.deepEqual(W.updateCard(status({ available: '0.1.1', ready: '0.1.1' }), 0, false), { kind: 'ready', title: 'Update ready', body: 'Restart to get Canopy 0.1.1. Your chats pick up where they were.', action: 'Restart to update' });
  assert.deepEqual(W.updateCard(status({ available: '0.1.1', ready: '0.1.1' }), 2, false), { kind: 'ready', title: 'Update ready', body: '2 chats are still working. Restart waits for them to finish.', action: 'Restart when done' });
  assert.deepEqual(W.updateCard(status({ available: '0.1.1', ready: '0.1.1' }), 1, true), { kind: 'ready', title: 'Restarting soon', body: 'Canopy restarts by itself after 1 chat finishes.', action: 'Cancel' });
  assert.equal(W.updateCard(status({ available: '0.1.1', auto: false }), 0, false).action, 'Download');
  assert.equal(W.updateCard(status({ available: '0.1.1', auto: false, state: 'downloading', progress: 0.5 }), 0, false).action, 'Downloading… 50%');
  assert.equal(W.updateCard(status({ available: '0.1.1', canInstall: false }), 0, false).kind, 'elsewhere');
  assert.equal(W.updateCard(status({ supported: false, off: 'source', available: '0.1.1', ready: '0.1.1' }), 0, false), null, 'never from source');
  assert.equal(W.updateCard(status({ available: '0.1.2', ready: '0.1.2', required: { version: '0.1.2', message: 'm' } }), 0, false), null, 'a required update has the whole window instead');
});

test('Update required: the release\'s words, one button, and a way out only when the update cannot be had', () => {
  const required = { version: '0.1.2', message: 'This update fixes sign-in. Restart to continue.' };
  const s = (o) => status({ available: '0.1.2', required, ...o });
  let v = W.requiredView(s({ ready: '0.1.2' }), false, 0);
  assert.deepEqual([v.message, v.button, v.busy, v.escape], [required.message, 'Update Now', false, false]);
  v = W.requiredView(s({ state: 'downloading', progress: 0.42 }), false, 0);
  assert.deepEqual([v.button, v.busy, v.line], ['Update Now', false, ''], 'a download already going on in the background changes nothing until the button is pressed');
  v = W.requiredView(s({ state: 'downloading', progress: 0.42 }), true, 0);
  assert.deepEqual([v.button, v.busy, v.line, v.escape], ['Downloading… 42%', true, 'Canopy restarts when it is ready.', false]);
  v = W.requiredView(s({ ready: '0.1.2' }), true, 2);
  assert.deepEqual([v.button, v.busy, v.line], ['Waiting for chats…', true, 'Canopy restarts after 2 chats finish.'], 'working chats are waited for');
  v = W.requiredView(s({ ready: '0.1.2', state: 'installing' }), true, 0);
  assert.deepEqual([v.button, v.busy], ['Restarting…', true]);
  v = W.requiredView(s({ error: 'OFFLINE' }), true, 0);
  assert.deepEqual([v.button, v.busy, v.escape], ['Try Again', false, true], 'a download that failed never leaves the app blocked');
  v = W.requiredView(s({ failed: '0.1.2' }), false, 0);
  assert.deepEqual([v.button, v.escape], ['Try Again', true]);
  v = W.requiredView(s({ canInstall: false }), false, 0);
  assert.deepEqual([v.button, v.elsewhere, v.escape], ['Download Canopy', true, true]);
});

test('the two toasts', () => {
  assert.equal(W.updateToast({ kind: 'updated', version: '0.1.1' }).title, 'Canopy updated to 0.1.1');
  assert.equal(W.updateToast({ kind: 'rolled-back', version: '0.1.2' }).title, 'Canopy 0.1.2 didn’t start');
});

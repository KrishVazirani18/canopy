// Canopy's own updater (src/core/app-update.mjs): what a feed means, what is downloaded and when, what is refused,
// and what "required" may and may not do. Nothing here goes online or touches an app: fetch, the commands (ditto,
// plutil, codesign) and the helper are stand-ins, and files live in a temp folder that is removed afterwards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { AppUpdater, REQUIRED_MESSAGE, SWAP_HELPER, installProblem, judge, localFeed, parseFeed, removeTree } from '../../app-update.mjs';
import * as info from '../../../app-info.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-update-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ZIP = Buffer.from('not really a zip, but its bytes are what gets hashed');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const FEED_URL = 'https://github.com/o/r/releases/latest/download/latest.json';
const feedOf = (o = {}) => ({ version: '0.1.1', notes: 'Fixes.', zipUrl: 'https://github.com/o/r/releases/download/v0.1.1/Canopy-0.1.1-mac.zip', zipSha256: sha(ZIP), zipSize: ZIP.length, minVersion: null, minMessage: null, ...o });

/** An updater in a folder of its own, with everything outside it faked. `world` is what the fakes answer with. */
function make(o = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'u-'));
  const world = {
    feed: feedOf(), zip: ZIP, offline: false, feedStatus: 200, zipStatus: 200,
    bundleId: info.APP_ID, version: null, sealed: true, teams: {}, // teams: app path -> team id
    fetched: [], ran: [], helpers: [], saved: null, changes: [], notes: [],
    ...o.world,
  };
  const appPath = path.join(dir, 'Applications', 'Canopy.app');
  fs.mkdirSync(appPath, { recursive: true });
  const updater = new AppUpdater({
    current: '0.1.0', bundleId: info.APP_ID, feedUrl: FEED_URL, dir: path.join(dir, 'updates'), appPath, downloadUrl: info.downloadUrl(),
    fetch: async (url) => {
      world.fetched.push(String(url));
      if (world.offline) throw new TypeError('fetch failed');
      if (String(url) === FEED_URL || String(url).endsWith('/latest.json')) return new Response(typeof world.feed === 'string' ? world.feed : JSON.stringify(world.feed), { status: world.feedStatus });
      return new Response(world.zip, { status: world.zipStatus, headers: { 'content-length': String(world.zip.length) } });
    },
    run: async (cmd, args) => {
      world.ran.push([path.basename(cmd), ...args].join(' '));
      if (cmd.endsWith('ditto')) { fs.mkdirSync(path.join(args[3], 'Canopy.app', 'Contents'), { recursive: true }); fs.writeFileSync(path.join(args[3], 'Canopy.app', 'Contents', 'Info.plist'), 'x'); return { ok: true, stdout: '', stderr: '' }; }
      if (cmd.endsWith('plutil')) return { ok: true, stdout: `${args[1] === 'CFBundleIdentifier' ? world.bundleId : world.version ?? world.feed.version}\n`, stderr: '' };
      if (cmd === '/bin/rm') { assert.equal(args[0], '-rf'); fs.rmSync(args[1], { recursive: true, force: true }); return { ok: true, stdout: '', stderr: '' }; }
      if (cmd.endsWith('codesign') && args[0] === '--verify') return { ok: world.sealed, stdout: '', stderr: '' };
      if (cmd.endsWith('codesign')) return { ok: true, stdout: '', stderr: `Identifier=x\nTeamIdentifier=${world.teams[args.at(-1)] ?? 'not set'}\n` };
      return { ok: true, stdout: '', stderr: '' };
    },
    startHelper: (args, opts) => { world.helpers.push({ args, opts }); return true; },
    load: () => world.saved, save: (s) => { world.saved = structuredClone(s); },
    onChange: (status, note) => { world.changes.push(status); if (note) world.notes.push(note); },
    ...o.opts,
  });
  return { updater, world, dir, appPath };
}

// ---- the feed ----

test('a feed is the newest version, its zip and checksum, and the oldest version still allowed', () => {
  const f = parseFeed(JSON.stringify(feedOf({ minVersion: '0.1.1', minMessage: ' This update fixes sign-in.\nRestart to continue. ' })));
  assert.equal(f.version, '0.1.1');
  assert.equal(f.zipUrl, 'https://github.com/o/r/releases/download/v0.1.1/Canopy-0.1.1-mac.zip');
  assert.equal(f.zipSha256, sha(ZIP));
  assert.equal(f.zipSize, ZIP.length);
  assert.equal(f.minVersion, '0.1.1');
  assert.equal(f.minMessage, 'This update fixes sign-in. Restart to continue.', 'the words are shown as one plain line');
  assert.equal(parseFeed(JSON.stringify(feedOf())).minVersion, null);
});

test('what is not a feed is refused whole', () => {
  for (const bad of ['', 'not json', '[]', 'null', JSON.stringify({ version: '0.1.1' }),
    JSON.stringify(feedOf({ version: '1.0' })), JSON.stringify(feedOf({ version: '0.1.1-beta' })), JSON.stringify(feedOf({ zipSha256: 'abc' })),
    JSON.stringify(feedOf({ zipUrl: 'http://github.com/o/r/x.zip' })), JSON.stringify(feedOf({ zipUrl: 'file:///tmp/x.zip' })), JSON.stringify(feedOf({ zipUrl: 5 }))]) {
    assert.equal(parseFeed(bad), null, bad.slice(0, 60));
  }
  assert.equal(parseFeed(JSON.stringify(feedOf({ zipSha256: sha(ZIP).toUpperCase() }))).zipSha256, sha(ZIP), 'a checksum in capitals is the same checksum');
  assert.equal(parseFeed(JSON.stringify(feedOf({ zipSize: -5 }))).zipSize, null);
  assert.equal(parseFeed(JSON.stringify(feedOf({ minVersion: '9.9.9' }))).minVersion, '0.1.1', 'a floor above the newest version asks for the newest version');
});

test('a feed under test takes its zip from the folder the feed is in', () => {
  const f = parseFeed(JSON.stringify(feedOf()), { feedUrl: 'http://127.0.0.1:8765/latest.json', sameFolder: true });
  assert.equal(f.zipUrl, 'http://127.0.0.1:8765/Canopy-0.1.1-mac.zip');
  assert.equal(localFeed('http://127.0.0.1:8765/latest.json'), 'http://127.0.0.1:8765/latest.json');
  assert.equal(localFeed('http://localhost:9/latest.json'), 'http://localhost:9/latest.json');
  for (const no of [undefined, '', 'https://example.com/latest.json', 'http://10.0.0.5/latest.json', 'file:///tmp/latest.json', 'nonsense']) assert.equal(localFeed(no), null, String(no));
});

test('newer and required are judged against the running version', () => {
  assert.deepEqual(judge('0.1.0', feedOf()), { newer: true, required: false });
  assert.deepEqual(judge('0.1.1', feedOf()), { newer: false, required: false });
  assert.deepEqual(judge('0.2.0', feedOf()), { newer: false, required: false }, 'a newer build than the feed is left alone');
  assert.deepEqual(judge('0.1.0', feedOf({ version: '0.1.2', minVersion: '0.1.2' })), { newer: true, required: true });
  assert.deepEqual(judge('0.1.1', feedOf({ version: '0.1.3', minVersion: '0.1.1' })), { newer: true, required: false }, 'at the floor is allowed');
  assert.deepEqual(judge('0.1.2', feedOf({ version: '0.1.2', minVersion: '0.1.2' })), { newer: false, required: false });
  assert.deepEqual(judge('0.9.0', feedOf({ version: '0.10.0', minVersion: '0.10.0' })), { newer: true, required: true }, 'numbers, not text: 0.10 is after 0.9');
});

test('the addresses all come from one place', () => {
  assert.equal(info.downloadUrl(), `https://github.com/${info.RELEASE_REPO}/releases/latest/download/Canopy.dmg`);
  assert.equal(info.feedUrl(), `https://github.com/${info.RELEASE_REPO}/releases/latest/download/latest.json`);
  assert.equal(info.zipUrl('0.1.1'), `https://github.com/${info.RELEASE_REPO}/releases/download/v0.1.1/Canopy-0.1.1-mac.zip`);
  assert.equal(info.DEV_APP_ID, `${info.APP_ID}.dev`);
  assert.ok(parseFeed(JSON.stringify(feedOf({ zipUrl: info.zipUrl('0.1.1') }))), 'a release\'s own zip address is one the app accepts');
});

// ---- where Canopy can replace itself ----

test('a copy opened from the disk image, or in a folder it may not change, cannot replace itself', () => {
  const ok = () => {};
  const no = () => { throw new Error('EACCES'); };
  assert.equal(installProblem('/Applications/Canopy.app', ok), null);
  assert.equal(installProblem('/private/var/folders/xx/T/AppTranslocation/ABC/d/Canopy.app', ok), 'location');
  assert.equal(installProblem('/Volumes/Canopy/Canopy.app', no), 'location');
  assert.equal(installProblem('/Applications/Canopy', ok), 'location');
  assert.equal(installProblem(undefined, ok), 'location');
});

// ---- checking and downloading ----

test('a newer version is downloaded, checked and made ready; the feed is all that is fetched besides the zip', async () => {
  const { updater, world, appPath } = make();
  const s = await updater.check();
  assert.equal(s.available, '0.1.1');
  assert.equal(s.ready, '0.1.1');
  assert.equal(s.required, null);
  assert.equal(s.state, 'idle');
  assert.equal(s.error, null);
  assert.deepEqual(world.fetched, [FEED_URL, 'https://github.com/o/r/releases/download/v0.1.1/Canopy-0.1.1-mac.zip']);
  const staged = path.join(updater.dir, '0.1.1', 'app', 'Canopy.app');
  assert.ok(world.ran.some((c) => c.startsWith('ditto -x -k ')), 'unpacked with ditto');
  assert.ok(world.ran.includes(`xattr -dr com.apple.quarantine ${staged}`), 'quarantine is taken off');
  assert.ok(world.ran.includes(`codesign --verify --deep --strict ${staged}`), 'the app is checked to be intact');
  assert.ok(world.ran.some((c) => c.startsWith('plutil -extract CFBundleIdentifier')) && world.ran.some((c) => c.startsWith('plutil -extract CFBundleShortVersionString')));
  assert.ok(!fs.existsSync(path.join(updater.dir, '0.1.1', 'update.zip')), 'the zip is not kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(updater.dir, '0.1.1', 'ready.json'), 'utf8')).version, '0.1.1');
  assert.ok(world.changes.some((c) => c.state === 'downloading'), 'the window heard it was downloading');
  assert.equal(world.saved.lastCheck.result, 'available');
  assert.ok(fs.existsSync(appPath), 'the installed app is not touched by a download');

  // A second check finds it ready and downloads nothing more.
  world.fetched.length = 0;
  await updater.check();
  assert.deepEqual(world.fetched, [FEED_URL]);
});

test('nothing newer: nothing is downloaded', async () => {
  const { updater, world } = make({ world: { feed: feedOf({ version: '0.1.0' }) } });
  const s = await updater.check();
  assert.equal(s.available, null);
  assert.equal(s.ready, null);
  assert.equal(s.lastCheck.result, 'current');
  assert.deepEqual(world.fetched, [FEED_URL]);
});

test('a download that is not what the feed promised is refused and thrown away', async () => {
  const cases = [
    [{ zip: Buffer.from('tampered with') }, 'WRONG_SIZE'],
    [{ zip: Buffer.from(ZIP.toString().replace('zip', 'zap')) }, 'WRONG_CHECKSUM'],
    [{ zipStatus: 404 }, 'DOWNLOAD_HTTP'],
    [{ bundleId: 'com.someone.else' }, 'NOT_CANOPY'],
    [{ version: '0.0.9' }, 'WRONG_VERSION'],
    [{ sealed: false }, 'BROKEN'],
  ];
  for (const [worldPatch, code] of cases) {
    const { updater } = make({ world: worldPatch });
    const s = await updater.check();
    assert.equal(s.error, code, code);
    assert.equal(s.ready, null, code);
    assert.equal(s.state, 'idle', code);
    assert.ok(!fs.existsSync(path.join(updater.dir, '0.1.1')), `${code}: nothing of it is left on disk`);
  }
});

test('a zip larger than the limit is never taken in', async () => {
  const { updater } = make({ world: { feed: feedOf({ zipSize: null }) }, opts: { maxZipBytes: 10 } });
  assert.equal((await updater.check()).error, 'TOO_BIG');
});

test('a Canopy signed by a team only takes an update signed by the same team', async () => {
  let m = make();
  m.world.teams = { [m.appPath]: 'TEAM123456', [path.join(m.updater.dir, '0.1.1', 'app', 'Canopy.app')]: 'OTHER00000' };
  assert.equal((await m.updater.check()).error, 'OTHER_SIGNER');
  m = make();
  m.world.teams = { [m.appPath]: 'TEAM123456' }; // the new one is not signed by a team at all
  assert.equal((await m.updater.check()).error, 'OTHER_SIGNER');
  m = make();
  m.world.teams = { [m.appPath]: 'TEAM123456', [path.join(m.updater.dir, '0.1.1', 'app', 'Canopy.app')]: 'TEAM123456' };
  assert.equal((await m.updater.check()).ready, '0.1.1');
  m = make(); // neither is signed by a team (today's builds): the checksum and the seal are what count
  assert.equal((await m.updater.check()).ready, '0.1.1');
});

// ---- required ----

test('a version below the floor is told the update is required, with the release\'s own words', async () => {
  const { updater } = make({ world: { feed: feedOf({ version: '0.1.2', minVersion: '0.1.2', minMessage: 'This update fixes sign-in. Restart to continue.' }) } });
  const s = await updater.check();
  assert.deepEqual(s.required, { version: '0.1.2', message: 'This update fixes sign-in. Restart to continue.' });
  assert.equal(s.ready, '0.1.2', 'and it is downloaded at once');
  const plain = make({ world: { feed: feedOf({ version: '0.1.2', minVersion: '0.1.2' }) } });
  assert.equal((await plain.updater.check()).required.message, REQUIRED_MESSAGE);
});

test('offline, or a feed that cannot be read, never requires anything and never blocks', async () => {
  for (const patch of [{ offline: true }, { feedStatus: 404 }, { feedStatus: 500 }, { feed: 'garbage' }, { feed: { version: 'x' } }]) {
    const { updater, world } = make({ world: patch });
    const s = await updater.check();
    assert.equal(s.required, null, JSON.stringify(patch));
    assert.equal(s.ready, null);
    assert.equal(s.state, 'idle');
    assert.ok(['OFFLINE', 'NO_FEED', 'FEED_HTTP', 'BAD_FEED'].includes(s.error), s.error);
    assert.equal(world.saved.lastCheck.result, 'failed');
  }
});

test('required comes off again when a later feed no longer asks for it, and stays through a check that fails', async () => {
  const { updater, world } = make({ world: { feed: feedOf({ version: '0.1.2', minVersion: '0.1.2' }) }, opts: { access: () => { throw new Error('read-only'); } } });
  assert.ok((await updater.check()).required);
  world.offline = true;
  assert.ok((await updater.check()).required, 'what a feed said in this run holds while the next one cannot be read');
  world.offline = false; world.feed = feedOf({ version: '0.1.2' });
  assert.equal((await updater.check()).required, null);
});

// ---- the switch ----

test('with automatic updates off a newer version is only offered, until it is asked for', async () => {
  const { updater, world } = make({ world: { saved: { auto: false } } });
  let s = await updater.check();
  assert.equal(s.auto, false);
  assert.equal(s.available, '0.1.1');
  assert.equal(s.ready, null);
  assert.deepEqual(world.fetched, [FEED_URL]);
  s = await updater.check({ manual: true }); // Check for Updates looks, and still leaves it
  assert.equal(s.ready, null);
  s = await updater.check({ download: true });
  assert.equal(s.ready, '0.1.1');
  assert.equal(updater.installsOnQuit, false, 'and quitting does not install it behind your back');
});

test('the switch is remembered, and turning it on fetches what was only offered', async () => {
  const { updater, world } = make({ world: { saved: { auto: false } } });
  await updater.check();
  assert.equal(updater.setAuto(true).auto, true);
  assert.equal(world.saved.auto, true);
  await updater.busy;
  assert.equal(updater.status().ready, '0.1.1');
  updater.setAuto(false);
  assert.equal(world.saved.auto, false);
});

// ---- installing ----

test('installing hands the helper the app, the new copy and where the old one is kept, and nothing else', async () => {
  const { updater, world, appPath } = make();
  assert.equal(updater.install({ relaunch: true }), false, 'nothing is ready yet');
  await updater.check();
  assert.equal(updater.installsOnQuit, true);
  assert.equal(updater.install({ relaunch: true, pid: 4242 }), true);
  assert.deepEqual(world.helpers[0].args, ['4242', appPath, path.join(updater.dir, '0.1.1', 'app', 'Canopy.app'), path.join(updater.dir, 'previous', 'Canopy.app'),
    path.join(updater.dir, 'started.json'), path.join(updater.dir, 'result.json'), '0.1.1', '1']);
  assert.equal(world.helpers[0].opts.logFile, path.join(updater.dir, 'swap.log'));
  assert.equal(updater.status().state, 'installing');
  assert.equal(updater.install({ relaunch: false }), false, 'only once');
  assert.equal(updater.installsOnQuit, false);
  assert.equal((await updater.check()).state, 'installing', 'and no check runs while it installs');
});

test('quitting installs without opening Canopy again', async () => {
  const { updater, world } = make();
  await updater.check();
  assert.equal(updater.install({ relaunch: false, pid: 7 }), true);
  assert.equal(world.helpers[0].args.at(-1), '0');
});

test('a copy that cannot replace itself downloads nothing, and still hears that an update is required', async () => {
  const { updater, world } = make({ world: { feed: feedOf({ version: '0.1.2', minVersion: '0.1.2' }) }, opts: { access: () => { throw new Error('read-only'); } } });
  const s = await updater.check({ download: true });
  assert.equal(s.canInstall, false);
  assert.equal(s.available, '0.1.2');
  assert.ok(s.required);
  assert.equal(s.ready, null);
  assert.deepEqual(world.fetched, [FEED_URL]);
  assert.equal(s.downloadUrl, info.downloadUrl(), 'the window can send them to the download instead');
  assert.equal(updater.install({ relaunch: true }), false);
});

// ---- after an install ----

test('a Canopy that started says so, reports the update, and lets the previous version go', async () => {
  const { updater, world } = make({ opts: { current: '0.1.1' } });
  fs.mkdirSync(path.join(updater.dir, 'previous', 'Canopy.app'), { recursive: true });
  fs.writeFileSync(path.join(updater.dir, 'result.json'), JSON.stringify({ ok: true, version: '0.1.1', reason: 'installed', at: 1 }));
  await updater.confirmStarted();
  assert.equal(JSON.parse(fs.readFileSync(path.join(updater.dir, 'started.json'), 'utf8')).version, '0.1.1');
  assert.ok(fs.readFileSync(path.join(updater.dir, 'started.json'), 'utf8').includes('"version":"0.1.1"'), 'in the shape the helper looks for');
  assert.deepEqual(world.notes, [{ kind: 'updated', version: '0.1.1' }]);
  assert.ok(!fs.existsSync(path.join(updater.dir, 'previous')));
  assert.ok(!fs.existsSync(path.join(updater.dir, 'result.json')), 'said once');
});

test('a version that did not start is not downloaded again by itself, only when asked', async () => {
  const { updater, world } = make();
  fs.mkdirSync(updater.dir, { recursive: true });
  fs.writeFileSync(path.join(updater.dir, 'result.json'), JSON.stringify({ ok: false, version: '0.1.1', reason: 'did-not-start', at: 1 }));
  await updater.confirmStarted();
  assert.deepEqual(world.notes, [{ kind: 'rolled-back', version: '0.1.1' }]);
  assert.equal(world.saved.failed.version, '0.1.1');
  let s = await updater.check();
  assert.equal(s.failed, '0.1.1');
  assert.equal(s.available, '0.1.1');
  assert.equal(s.ready, null, 'not on its own');
  world.feed = feedOf({ version: '0.1.2', zipUrl: 'https://github.com/o/r/releases/download/v0.1.2/Canopy-0.1.2-mac.zip' });
  s = await updater.check();
  assert.equal(s.ready, '0.1.2', 'the next version is taken as usual');
  const again = make({ world: { saved: { failed: { version: '0.1.1', at: 1 } } } });
  assert.equal((await again.updater.check({ manual: true })).ready, '0.1.1', 'Check for Updates tries it again');
});

test('an install that was never carried out is not held against the version', async () => {
  const { updater, world } = make();
  fs.mkdirSync(updater.dir, { recursive: true });
  fs.writeFileSync(path.join(updater.dir, 'result.json'), JSON.stringify({ ok: false, version: '0.1.1', reason: 'still-running', at: 1 }));
  await updater.confirmStarted();
  assert.deepEqual(world.notes, []);
  assert.equal(updater.status().failed, null);
});

test('at start, a download that is ready is kept and everything older or unfinished is cleared away', async () => {
  const { updater } = make();
  const stage = (v, ready) => {
    fs.mkdirSync(path.join(updater.dir, v, 'app', 'Canopy.app', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(updater.dir, v, 'app', 'Canopy.app', 'Contents', 'Info.plist'), 'x');
    if (ready) fs.writeFileSync(path.join(updater.dir, v, 'ready.json'), JSON.stringify({ version: v }));
  };
  stage('0.0.9', true); stage('0.1.0', true); stage('0.1.1', true); stage('0.1.2', false);
  await updater.start();
  updater.stop();
  assert.equal(updater.status().ready, '0.1.1');
  assert.deepEqual(fs.readdirSync(updater.dir).sort(), ['0.1.1']);
});

test('folders are cleared by /bin/rm, and only ever inside the updates folder', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'rm-'));
  const inside = path.join(dir, 'updates', '0.1.1', 'app', 'Canopy.app', 'Contents', 'Resources');
  fs.mkdirSync(inside, { recursive: true });
  fs.writeFileSync(path.join(inside, 'app.asar'), 'Electron reads a file of this name as a folder');
  const ran = [];
  const realRm = async (cmd, args) => { ran.push([cmd, ...args].join(' ')); fs.rmSync(args[1], { recursive: true, force: true }); return { ok: true }; };
  assert.equal(await removeTree(path.join(dir, 'updates', '0.1.1'), path.join(dir, 'updates'), realRm), true);
  assert.deepEqual(ran, [`/bin/rm -rf ${path.join(dir, 'updates', '0.1.1')}`], 'not Node\'s fs: inside Electron that fails on an app');
  for (const outside of [dir, path.join(dir, 'updates'), path.join(dir, 'updates', '..', 'elsewhere'), '/', os.homedir()]) {
    ran.length = 0;
    assert.equal(await removeTree(outside, path.join(dir, 'updates'), realRm), false, outside);
    assert.deepEqual(ran, [], `${outside} is never touched`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'updates')));
});

// ---- copies that never update ----

test('from source and in an automated run the updater does nothing at all', async () => {
  for (const off of ['source', 'automated', 'platform']) {
    const { updater, world } = make({ opts: { off } });
    await updater.start();
    const s = await updater.check({ manual: true, download: true });
    assert.equal(s.supported, false);
    assert.equal(s.off, off);
    assert.equal(updater.install({ relaunch: true }), false);
    assert.equal(updater.installsOnQuit, false);
    await updater.confirmStarted();
    assert.deepEqual(world.fetched, []);
    assert.ok(!fs.existsSync(updater.dir), 'not even a folder');
  }
});

// ---- the helper ----

test('the helper is a plain shell script that waits, swaps by renaming, and puts the old app back if the new one does not start', () => {
  assert.ok(SWAP_HELPER.startsWith('#!/bin/sh'));
  assert.match(SWAP_HELPER, /kill -0 "\$PID"/, 'it waits for Canopy to exit');
  assert.match(SWAP_HELPER, /mv "\$TARGET" "\$PREVIOUS"/);
  assert.match(SWAP_HELPER, /mv "\$STAGED" "\$TARGET"/);
  assert.match(SWAP_HELPER, /mv "\$PREVIOUS" "\$TARGET"/, 'the way back');
  assert.doesNotMatch(SWAP_HELPER, /\bcurl\b|\bsudo\b|\brm -rf \/(?!\S)/, 'it downloads nothing and asks for no password');
});

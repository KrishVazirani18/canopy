// Canopy's own updater: keeps the app itself current, the way upkeep.mjs keeps Claude Code current.
//
// Electron's built-in updater needs an Apple Developer ID signature. Canopy ships without one for now, so this does
// the same job with plain files:
//
//   feed      one small JSON file on the newest GitHub release (latest.json):
//               { version, notes, zipUrl, zipSha256, zipSize, minVersion, minMessage }
//             the newest version, where its zip is and what the zip must hash to, and the oldest version that may
//             still be used (minVersion, with the words to show for it: minMessage).
//   check     a minute after launch, then every four hours. A newer version is downloaded in the background.
//   stage     the zip is checked against the feed's SHA-256 and size and unpacked with ditto into Canopy's own data
//             folder. The app inside must be Canopy (its bundle id), be the version the feed named, and be intact
//             (codesign --verify). When the running Canopy is signed by a developer team, the new one must be signed
//             by the same team.
//   install   on "Restart to update", or when Canopy is next quit: a small shell helper (app-update-swap.sh) waits
//             for Canopy to exit, renames the old app aside and the new one into its place, and opens it again. The
//             old app is kept until the new one has started; if it does not start, the old one is put back.
//   required  a running version older than minVersion shows "Update required" until the update is installed. Only a
//             feed read in this run can say so: offline, or a feed that cannot be read, never blocks anything.
//
// Nothing here touches Electron: the host says how to fetch, where files go and how to report. Nothing exported throws.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, closeSync, constants, createWriteStream, existsSync, openSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from './upkeep.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const FIRST_CHECK_MS = MINUTE;
export const CHECK_EVERY_MS = 4 * HOUR;
/** No zip larger than this is ever downloaded (the universal app is about a quarter of it). */
export const MAX_ZIP_BYTES = 1024 ** 3;
const MAX_FEED_BYTES = 64 * 1024;
const FEED_TIMEOUT_MS = 20_000;
const STALL_MS = 60_000; // a download that sends nothing for this long is given up
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** What "Update required" says when the release gave no words of its own. */
export const REQUIRED_MESSAGE = 'This version of Canopy can no longer be used. Update to continue.';

let helper = null;
try { helper = readFileSync(new URL('./app-update-swap.sh', import.meta.url), 'utf8'); } catch { /* reported by install() */ }
/** The helper's source. It travels as an argument to /bin/sh, so it runs the same from a source tree and from inside an app bundle. */
export const SWAP_HELPER = helper;

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const coded = (code, message = code) => Object.assign(new Error(message), { code });
const codeOf = (err) => (typeof err?.code === 'string' && /^[A-Z_]{2,40}$/.test(err.code) ? err.code : 'FAILED');
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * The feed, read and checked: null when it is not one. `sameFolder` (a feed under test): the zip is taken from the
 * folder the feed is in, whatever address the feed gives, so a folder of release files can be served as it is.
 */
export function parseFeed(text, { feedUrl, sameFolder = false } = {}) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return null; }
  if (!isPlain(j) || typeof j.version !== 'string' || !VERSION.test(j.version) || typeof j.zipUrl !== 'string') return null;
  const zipSha256 = typeof j.zipSha256 === 'string' ? j.zipSha256.toLowerCase() : '';
  if (!SHA256.test(zipSha256)) return null;
  let zip;
  try {
    zip = new URL(j.zipUrl, feedUrl);
    if (sameFolder) zip = new URL(path.posix.basename(zip.pathname), feedUrl);
    else if (zip.protocol !== 'https:') return null;
  } catch { return null; }
  // A floor above the newest version could never be met: the newest version is as far as "required" can ask.
  let minVersion = typeof j.minVersion === 'string' && VERSION.test(j.minVersion) ? j.minVersion : null;
  if (minVersion && compareVersions(minVersion, j.version) === 1) minVersion = j.version;
  return {
    version: j.version, notes: typeof j.notes === 'string' ? j.notes.slice(0, 4000) : '', zipUrl: zip.href, zipSha256,
    zipSize: Number.isSafeInteger(j.zipSize) && j.zipSize > 0 ? j.zipSize : null,
    minVersion, minMessage: minVersion ? oneLine(j.minMessage, 300) : '',
  };
}

/** What a feed means for the running version: is there a newer one, and may this one still be used. */
export function judge(current, feed) {
  const newer = compareVersions(feed?.version, current) === 1;
  return { newer, required: newer && !!feed.minVersion && compareVersions(current, feed.minVersion) === -1 };
}

/**
 * Why Canopy cannot replace itself where it is, or null when it can: 'location' for a copy opened straight from the
 * disk image or from Downloads (macOS runs those from a read-only place), and for a folder this user may not change.
 */
export function installProblem(appPath, access = accessSync) {
  if (typeof appPath !== 'string' || !appPath.endsWith('.app') || appPath.includes('/AppTranslocation/')) return 'location';
  try { access(path.dirname(appPath), constants.W_OK); access(appPath, constants.W_OK); } catch { return 'location'; }
  return null;
}

/** A test feed is only ever taken from this Mac: http://127.0.0.1:8765/latest.json. Anything else is not a test feed. */
export function localFeed(url) {
  try {
    const u = new URL(String(url ?? ''));
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

/** Runs a command and answers { ok, stdout, stderr }: never rejects. */
function run(cmd, args, { timeoutMs = MINUTE } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

/**
 * Removes a folder that may hold an app. Done by /bin/rm, never by Node's fs: inside Electron, fs takes every app.asar
 * for a folder it can look into but not empty, so removing a folder with an app in it fails there (and only there).
 * Only ever something inside `within`. Answers whether it is gone.
 */
export async function removeTree(target, within, runFn = run) {
  const inside = path.relative(path.resolve(within), path.resolve(target));
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return false;
  await runFn('/bin/rm', ['-rf', path.resolve(target)], { timeoutMs: 5 * MINUTE });
  return !existsSync(target);
}

/** Starts the helper on its own, so it outlives Canopy: its output goes to `logFile`. */
function startHelper(args, { logFile, env = process.env } = {}) {
  let out = 'ignore';
  try { out = openSync(logFile, 'a'); } catch { /* it runs without a log */ }
  try {
    const child = spawn('/bin/sh', ['-c', SWAP_HELPER, 'canopy-update', ...args], { detached: true, stdio: ['ignore', out, out], env });
    child.unref();
    return true;
  } catch { return false; }
  finally { if (typeof out === 'number') { try { closeSync(out); } catch { /* already closed */ } } }
}

/**
 * @param {object} o
 * @param {string} o.current      the running version ("0.1.0")
 * @param {string} o.bundleId     what the new app's bundle id must be
 * @param {string} o.feedUrl      where latest.json is
 * @param {boolean} [o.sameFolder] a feed under test: the zip comes from the folder the feed is in
 * @param {string} o.dir          where downloads are kept and unpacked (userData/updates)
 * @param {string} o.appPath      the app to replace (/Applications/Canopy.app)
 * @param {string} [o.downloadUrl] where a person can download Canopy by hand, for a copy that cannot replace itself
 * @param {typeof fetch} o.fetch
 * @param {'source'|'automated'|'platform'|null} [o.off]  why this copy never updates itself; null: it does
 * @param {() => object|null} [o.load]  what was saved: { auto, failed, lastCheck }
 * @param {(s: object) => void} [o.save]
 * @param {(status: object, note?: object) => void} [o.onChange]  note: { kind: 'updated' | 'rolled-back', version }
 * @param {(msg: string) => void} [o.log]
 */
export class AppUpdater {
  constructor(o = {}) {
    this.current = o.current; this.bundleId = o.bundleId; this.feedUrl = o.feedUrl; this.sameFolder = o.sameFolder === true;
    this.dir = o.dir; this.appPath = o.appPath; this.downloadUrl = o.downloadUrl ?? null;
    this.fetch = o.fetch; this.run = o.run ?? run; this.startHelper = o.startHelper ?? startHelper;
    this.load = o.load ?? (() => null); this.save = o.save ?? (() => {});
    this.onChange = o.onChange ?? (() => {}); this.log = o.log ?? (() => {}); this.now = o.now ?? Date.now;
    this.firstCheckMs = o.firstCheckMs ?? FIRST_CHECK_MS; this.checkEveryMs = o.checkEveryMs ?? CHECK_EVERY_MS;
    this.maxZipBytes = o.maxZipBytes ?? MAX_ZIP_BYTES; this.stallMs = o.stallMs ?? STALL_MS;
    this.off = o.off ?? null;
    let saved = null;
    try { saved = this.load(); } catch { /* start as new */ }
    this.auto = saved?.auto !== false;
    this.failed = isPlain(saved?.failed) && VERSION.test(saved.failed.version) ? { version: saved.failed.version, at: Number(saved.failed.at) || 0 } : null;
    this.lastCheck = isPlain(saved?.lastCheck) && Number.isFinite(saved.lastCheck.at) ? { at: saved.lastCheck.at, result: String(saved.lastCheck.result) } : null;
    this.state = 'idle'; this.progress = null; this.available = null; this.ready = null; this.required = null; this.error = null;
    this.feed = null; this.problem = this.off ? null : installProblem(this.appPath, o.access);
    this.busy = null; this.abort = null; this.timers = []; this.stopped = false; this.installing = false;
  }

  /** Everything the window shows about updates. */
  status() {
    return {
      supported: !this.off, off: this.off, current: this.current, auto: this.auto,
      state: this.state,             // 'idle' | 'checking' | 'downloading' | 'installing'
      progress: this.progress,       // 0 to 1 while downloading, else null
      available: this.available,     // a newer version the feed named
      ready: this.ready,             // the version unpacked and waiting for a restart
      required: this.required,       // { version, message } while this version may not be used
      error: this.error,             // why the last check or download failed, as a code
      failed: this.failed?.version ?? null, // a version that was installed and did not start
      canInstall: !this.problem,     // false: this copy cannot replace itself where it is
      lastCheck: this.lastCheck,     // { at, result: 'current' | 'available' | 'failed' }
      downloadUrl: this.downloadUrl,
    };
  }

  #persist() { try { this.save({ auto: this.auto, failed: this.failed, lastCheck: this.lastCheck }); } catch { /* kept in memory */ } }
  #set(patch, note) { Object.assign(this, patch); try { this.onChange(this.status(), note); } catch { /* the window is gone */ } }
  #stage(version) { return path.join(this.dir, version); }
  #remove(target) { return removeTree(target, this.dir, this.run); }
  #stagedApp(version) { return path.join(this.#stage(version), 'app', path.basename(this.appPath)); }
  get previousApp() { return path.join(this.dir, 'previous', path.basename(this.appPath ?? 'Canopy.app')); }
  get startedFile() { return path.join(this.dir, 'started.json'); }
  get resultFile() { return path.join(this.dir, 'result.json'); }

  /** Looks at what an earlier run left, then checks a minute from now and every four hours. */
  async start() {
    if (this.off || this.stopped || this.timers.length) return;
    await this.#tidy();
    if (this.stopped) return;
    const first = setTimeout(() => { this.check(); }, this.firstCheckMs);
    const every = setInterval(() => { this.check(); }, this.checkEveryMs);
    first.unref?.(); every.unref?.();
    this.timers = [first, every];
  }

  /** Stops checking and gives up a download under way (what it had is thrown away at the next start). */
  stop() {
    this.stopped = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this.abort?.abort();
  }

  /** Downloads from an earlier run: one that is ready and newer than this version is kept, the rest is cleared away. */
  async #tidy() {
    let ready = null;
    try {
      for (const e of await fs.readdir(this.dir, { withFileTypes: true })) {
        if (!e.isDirectory() || !VERSION.test(e.name)) continue;
        let ok = false;
        try {
          const mark = JSON.parse(await fs.readFile(path.join(this.#stage(e.name), 'ready.json'), 'utf8'));
          ok = mark?.version === e.name && compareVersions(e.name, this.current) === 1 && existsSync(path.join(this.#stagedApp(e.name), 'Contents', 'Info.plist'));
        } catch { /* a download that never finished */ }
        if (ok && (!ready || compareVersions(e.name, ready) === 1)) ready = e.name;
      }
      for (const e of await fs.readdir(this.dir, { withFileTypes: true })) {
        if (e.isDirectory() && VERSION.test(e.name) && e.name !== ready) await this.#remove(this.#stage(e.name));
      }
    } catch { /* no updates folder yet */ }
    if (ready) { this.log(`${ready} is downloaded and ready`); this.#set({ ready, available: ready }); }
  }

  /**
   * This Canopy got as far as showing its window. Says so where the helper is watching, reads what the helper left
   * about the last install, and lets the previous version go: it was only kept in case this one did not start.
   */
  async confirmStarted() {
    if (this.off) return;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.startedFile, JSON.stringify({ version: this.current, pid: process.pid, at: this.now() }));
    } catch (err) { this.log(`could not write started.json: ${err?.message ?? err}`); }
    let result = null;
    try { result = JSON.parse(await fs.readFile(this.resultFile, 'utf8')); } catch { /* no install since the last start */ }
    await fs.rm(this.resultFile, { force: true }).catch(() => {});
    if (isPlain(result) && VERSION.test(result.version)) {
      const reason = oneLine(result.reason, 40);
      if (result.ok === true && result.version === this.current) {
        this.log(`updated to ${this.current}`);
        if (this.failed) { this.failed = null; this.#persist(); }
        this.#set({}, { kind: 'updated', version: this.current });
      } else if (result.ok === false && ['could-not-open', 'quit-on-start', 'did-not-start'].includes(reason)) {
        // The new version was put in place and did not start: it is not tried again by itself.
        this.log(`${result.version} did not start (${reason}): back on ${this.current}`);
        this.failed = { version: result.version, at: this.now() };
        this.#persist();
        this.#set({}, { kind: 'rolled-back', version: result.version });
      } else if (result.ok === false) this.log(`the update to ${result.version} was not installed (${reason})`);
    }
    // The version before this one was kept only in case this one did not start.
    if (existsSync(path.dirname(this.previousApp))) await this.#remove(path.dirname(this.previousApp));
  }

  /** Turns "Install updates automatically" on or off. */
  setAuto(on) {
    this.auto = on === true;
    this.#persist();
    this.#set({});
    if (this.auto && this.available && this.ready !== this.available) this.check();
    return this.status();
  }

  /**
   * Reads the feed, and downloads a newer version when updates install automatically, when the update is required,
   * or when asked to (`download`). One at a time: a call while one runs gets the same answer.
   * @param {{manual?: boolean, download?: boolean}} [opts]  manual: a person asked, so a version that failed before is tried again
   */
  check(opts = {}) {
    if (this.off || this.stopped || this.installing) return Promise.resolve(this.status());
    this.busy ??= this.#check(opts)
      .catch((err) => { this.log(`check failed: ${err?.message ?? err}`); this.#set({ state: 'idle', progress: null, error: codeOf(err) }); })
      .finally(() => { this.busy = null; this.abort = null; })
      .then(() => this.status());
    return this.busy;
  }

  async #check({ manual = false, download = false }) {
    this.abort = new AbortController();
    this.#set({ state: 'checking', error: null });
    let feed;
    try { feed = await this.#readFeed(this.abort.signal); } catch (err) {
      // Offline, or no feed to read: nothing changes, and nothing is required because of it.
      this.lastCheck = { at: this.now(), result: 'failed' };
      this.#persist();
      this.log(`the feed could not be read (${codeOf(err)})`);
      this.#set({ state: 'idle', error: codeOf(err) });
      return;
    }
    this.feed = feed;
    const { newer, required } = judge(this.current, feed);
    this.lastCheck = { at: this.now(), result: newer ? 'available' : 'current' };
    this.#persist();
    this.#set({ available: newer ? feed.version : null, required: required ? { version: feed.version, message: feed.minMessage || REQUIRED_MESSAGE } : null });
    if (!newer || this.ready === feed.version) { this.#set({ state: 'idle' }); return; }
    const failedBefore = this.failed?.version === feed.version;
    const wanted = (download || manual) ? (download || this.auto || required) : (this.auto || required) && !failedBefore;
    if (!wanted || this.problem) { this.#set({ state: 'idle' }); return; }
    try {
      await this.#download(feed, this.abort.signal);
      this.log(`${feed.version} is downloaded and ready`);
      this.#set({ state: 'idle', progress: null, ready: feed.version });
    } catch (err) {
      await this.#remove(this.#stage(feed.version));
      throw err;
    }
  }

  async #readFeed(signal) {
    const timer = setTimeout(() => this.abort?.abort(), FEED_TIMEOUT_MS);
    try {
      const res = await this.fetch(this.feedUrl, { signal, cache: 'no-store', redirect: 'follow' });
      if (!res.ok) throw coded(res.status === 404 ? 'NO_FEED' : 'FEED_HTTP');
      const text = await res.text();
      if (text.length > MAX_FEED_BYTES) throw coded('BAD_FEED');
      const feed = parseFeed(text, { feedUrl: this.feedUrl, sameFolder: this.sameFolder });
      if (!feed) throw coded('BAD_FEED');
      return feed;
    } catch (err) {
      throw typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err : coded('OFFLINE', String(err?.message ?? err));
    } finally { clearTimeout(timer); }
  }

  /** Downloads the zip, checks it, unpacks it and checks the app inside. Throws with a code when any of it is not right. */
  async #download(feed, signal) {
    const stage = this.#stage(feed.version);
    if (existsSync(stage)) await this.#remove(stage);
    await fs.mkdir(path.join(stage, 'app'), { recursive: true });
    const zip = path.join(stage, 'update.zip');
    this.#set({ state: 'downloading', progress: 0 });

    let res;
    try { res = await this.fetch(feed.zipUrl, { signal, cache: 'no-store', redirect: 'follow' }); } catch (err) { throw coded('OFFLINE', String(err?.message ?? err)); }
    if (!res.ok || !res.body) throw coded('DOWNLOAD_HTTP');
    const announced = Number(res.headers?.get?.('content-length')) || 0;
    const limit = Math.min(this.maxZipBytes, feed.zipSize ?? this.maxZipBytes);
    if (announced > limit) throw coded('TOO_BIG');
    const total = feed.zipSize ?? (announced || null);

    const hash = createHash('sha256');
    const file = createWriteStream(zip);
    const reader = res.body.getReader();
    let got = 0, said = 0, stall = null, stalled = false;
    try {
      for (;;) {
        clearTimeout(stall);
        stall = setTimeout(() => { stalled = true; this.abort?.abort(); }, this.stallMs);
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        if (got > limit) throw coded('TOO_BIG');
        hash.update(value);
        if (!file.write(value)) await once(file, 'drain');
        if (total && this.now() - said > 250) { said = this.now(); this.#set({ progress: Math.min(0.99, got / total) }); }
      }
    } catch (err) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) && err.code !== 'ABORT_ERR' ? err : coded(signal.aborted && !stalled ? 'STOPPED' : 'OFFLINE', String(err?.message ?? err));
    } finally {
      clearTimeout(stall);
      await new Promise((resolve) => file.end(resolve));
    }
    if (feed.zipSize && got !== feed.zipSize) throw coded('WRONG_SIZE');
    if (hash.digest('hex') !== feed.zipSha256) throw coded('WRONG_CHECKSUM');
    this.#set({ progress: 0.99 });

    const unzip = await this.run('/usr/bin/ditto', ['-x', '-k', zip, path.join(stage, 'app')], { timeoutMs: 10 * MINUTE });
    if (!unzip.ok) throw coded('UNPACK');
    await fs.rm(zip, { force: true });
    const app = this.#stagedApp(feed.version);
    // Nothing Canopy downloads itself is quarantined, but a proxy or a tool in between may have marked it.
    await this.run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]);
    await this.#verify(app, feed);
    await fs.writeFile(path.join(stage, 'ready.json'), JSON.stringify({ version: feed.version, sha256: feed.zipSha256, at: this.now() }));
  }

  async #verify(app, feed) {
    const plist = path.join(app, 'Contents', 'Info.plist');
    const read = async (key) => { const r = await this.run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]); return r.ok ? r.stdout.trim() : null; };
    if (await read('CFBundleIdentifier') !== this.bundleId) throw coded('NOT_CANOPY');
    if (await read('CFBundleShortVersionString') !== feed.version) throw coded('WRONG_VERSION');
    const seal = await this.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeoutMs: 10 * MINUTE });
    if (!seal.ok) throw coded('BROKEN');
    // A Canopy signed by a developer team only ever replaces itself with one signed by the same team.
    const mine = await this.#team(this.appPath);
    if (mine && await this.#team(app) !== mine) throw coded('OTHER_SIGNER');
  }

  /** The developer team that signed an app, or null (not signed, or signed without one). */
  async #team(app) {
    const r = await this.run('/usr/bin/codesign', ['-dv', '--verbose=2', app]);
    const m = /^TeamIdentifier=(\S+)$/m.exec(`${r.stdout}\n${r.stderr}`);
    return m && m[1] !== 'not' ? m[1] : null;
  }

  /** True when quitting now should install what is ready: updates install automatically, and something is ready. */
  get installsOnQuit() { return !this.off && this.auto && !!this.ready && !this.problem && !this.installing; }

  /**
   * Starts the helper that replaces the app once this process has exited. The caller then quits. False when there is
   * nothing to install, or it cannot be installed here.
   * @param {{relaunch: boolean, pid?: number, env?: object}} o  relaunch: open the new Canopy afterwards
   */
  install({ relaunch, pid = process.pid, env } = {}) {
    if (this.off || !this.ready || this.problem || this.installing || !SWAP_HELPER) return false;
    const staged = this.#stagedApp(this.ready);
    if (!existsSync(path.join(staged, 'Contents', 'Info.plist'))) { this.#set({ ready: null }); return false; }
    const args = [String(pid), this.appPath, staged, this.previousApp, this.startedFile, this.resultFile, this.ready, relaunch ? '1' : '0'];
    if (!this.startHelper(args, { logFile: path.join(this.dir, 'swap.log'), env })) return false;
    this.log(`installing ${this.ready} (${relaunch ? 'restart' : 'on quit'})`);
    this.installing = true;
    this.abort?.abort();
    this.#set({ state: 'installing' });
    return true;
  }
}

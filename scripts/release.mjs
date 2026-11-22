// Makes a release of Canopy, start to finish (docs/RELEASING.md has the steps in plain words):
//
//   npm run release -- patch                       0.1.0 -> 0.1.1 (or: minor, major, or a version like 0.2.0)
//   npm run release -- patch --required "This update fixes sign-in. Restart to continue."
//                                                  the same, and every older Canopy must take it before it can be used
//   npm run release -- patch --dry-run             builds everything and publishes nothing: no commit, no tag, nothing online
//
// What it does, in order:
//   1. checks that a release can be made (a clean tree, room on the disk, and, unless --dry-run, gh signed in and a
//      public repository to publish to)
//   2. runs the tests
//   3. builds Canopy.app for that version and has the app check itself (src/selftest.mjs)
//   4. makes the three files of a release in dist/release:
//        Canopy.dmg              what people download. Always this name, so one link always gets the newest
//        Canopy-<v>-mac.zip      what a running Canopy updates itself from
//        latest.json             the update feed: the version, the zip's address, size and SHA-256, and the oldest
//                                version still allowed (minVersion). With --required that is this version; otherwise
//                                it is carried over from the release before, so a required update stays required
//   5. drafts the release notes from the commits since the last release (RELEASE_NOTES.md; --notes-file to use your own)
//   6. unless --dry-run: writes the version into package.json, commits and tags it, and publishes the release with gh
//
// Other options: --arch arm64 (Apple silicon only), --out <folder>, --skip-tests, --previous-feed <file or address>
// (where to read the release before from; the default is the published feed).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMG_NAME, FEED_NAME, PRODUCT_NAME, RELEASE_REPO, downloadUrl, feedUrl, zipName, zipUrl } from '../src/app-info.mjs';
import { parseFeed } from '../src/core/app-update.mjs';
import { compareVersions } from '../src/core/upkeep.mjs';
import { buildApp } from './build-app.mjs';
import { makeDmg } from './make-dmg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+\.\d+\.\d+$/;
const NEEDS_GB = 3; // the two halves of a universal app, the app, the zip and the disk image, all at once
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts }).toString().trim();
const attempt = (cmd, args, opts) => { try { return { ok: true, out: sh(cmd, args, opts) }; } catch (err) { return { ok: false, out: `${err?.stdout ?? ''}${err?.stderr ?? ''}`.trim() || String(err?.message ?? err) }; } };
const log = (m) => console.log(m);
const step = (m) => console.log(`\n${m}`);
/** A path as short as it can be said: from here when it is under here, else in full. */
const shown = (p) => { const rel = path.relative(process.cwd(), p); return rel && !rel.startsWith('..') ? rel : p; };

/** 0.1.0 + patch -> 0.1.1. A full version is taken as it is. */
export function nextVersion(current, how) {
  if (VERSION.test(how)) return how;
  const [major, minor, patch] = current.split('.').map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  return null;
}

/**
 * Release notes from commit subjects, in plain words: what is new, what was fixed, what got faster. Commits that
 * change nothing a person would notice (chores, docs, tests, refactors, the release commits themselves) are left out.
 */
export function draftNotes(subjects) {
  const groups = { New: [], Fixed: [], Faster: [] };
  for (const subject of subjects) {
    const m = /^(feat|fix|perf)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject.trim());
    if (!m) continue;
    const text = m[2].replace(/^./, (c) => c.toUpperCase()).replace(/\.$/, '');
    groups[m[1] === 'feat' ? 'New' : m[1] === 'fix' ? 'Fixed' : 'Faster'].push(text);
  }
  const parts = Object.entries(groups).filter(([, lines]) => lines.length).map(([title, lines]) => `${title}\n${lines.map((l) => `- ${l}`).join('\n')}`);
  return parts.join('\n\n') || 'Small fixes and improvements.';
}

/** The feed for a release. `previous`: the feed of the release before (or null), whose floor is carried over. */
export function makeFeed({ version, notes, zip, required, previous, repo }) {
  const floor = required ? { minVersion: version, minMessage: required }
    : previous?.minVersion ? { minVersion: previous.minVersion, minMessage: previous.minMessage || null }
    : { minVersion: null, minMessage: null };
  return { version, notes: notes.slice(0, 4000), zipUrl: zipUrl(version, repo), zipSha256: zip.sha256, zipSize: zip.size, ...floor, publishedAt: new Date().toISOString() };
}

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

/** The feed of the release before this one: from a file, an address, or what is published now. Null when there is none. */
async function previousFeed(from, { dryRun }) {
  const where = from ?? feedUrl();
  try {
    let text;
    if (/^https?:/.test(where)) {
      const res = await fetch(where, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null; // nothing published yet
      if (!res.ok) throw new Error(`${where} answered ${res.status}`);
      text = await res.text();
    } else text = fs.readFileSync(path.resolve(where), 'utf8');
    const feed = parseFeed(text, { feedUrl: /^https?:/.test(where) ? where : 'https://localhost/', sameFolder: !/^https:/.test(where) });
    if (!feed) throw new Error(`${where} is not a feed`);
    return feed;
  } catch (err) {
    // Not knowing the release before could drop a required update's floor: only a dry run goes on without it.
    if (!dryRun) throw new Error(`The feed of the release before could not be read (${err?.message ?? err}). Try again, or name it with --previous-feed.`);
    log(`  (the feed of the release before could not be read: ${err?.message ?? err}. A dry run goes on without it.)`);
    return null;
  }
}

/** Runs the built app's check of itself. Throws with what failed. */
async function selfTest(app) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-selftest-'));
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(path.join(app, 'Contents', 'MacOS', PRODUCT_NAME), [], { env: { ...process.env, CANOPY_USER_DATA: data, CANOPY_SELFTEST: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the app did not finish checking itself within three minutes')); }, 180_000);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', () => { clearTimeout(timer); resolve(text); });
    });
    let report;
    try { report = JSON.parse(out.slice(out.indexOf('{'))); } catch { throw new Error('the app started but did not report (it may have crashed on the way up)'); }
    const failed = report.checks.filter((c) => !c.ok);
    if (failed.length) throw new Error(failed.map((c) => `${c.name}: ${c.detail}`).join('\n  '));
    return report;
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
}

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const option = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const valued = ['--required', '--notes-file', '--arch', '--out', '--previous-feed'];
  const how = argv.find((a, i) => !a.startsWith('--') && !valued.includes(argv[i - 1]));
  const dryRun = flag('--dry-run');
  const required = option('--required')?.replace(/\s+/g, ' ').trim();
  const outDir = path.resolve(ROOT, option('--out') ?? path.join('dist', 'release'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = how ? nextVersion(pkg.version, how) : null;
  if (!version) throw new Error('Say which release to make: patch, minor, major, or a version like 0.2.0.\n  npm run release -- patch [--required "message"] [--dry-run]');
  if (flag('--required') && !required) throw new Error('--required needs the words people will read, for example:\n  --required "This update fixes sign-in. Restart to continue."');
  if (required && required.length > 300) throw new Error('The --required message is longer than 300 characters. One or two short sentences.');
  const tag = `v${version}`;
  console.log(`Canopy ${version}${required ? ' (required)' : ''}${dryRun ? ' · dry run: nothing is committed, tagged or published' : ''}`);

  // ---- 1. can a release be made ----
  step('Checking');
  if (process.platform !== 'darwin') throw new Error('Releases are made on a Mac.');
  const free = fs.statfsSync(ROOT);
  const freeGb = (free.bavail * free.bsize) / 1024 ** 3;
  if (freeGb < NEEDS_GB) throw new Error(`Only ${freeGb.toFixed(1)} GB free on this disk. A release needs about ${NEEDS_GB} GB while it builds.`);
  if (compareVersions(version, pkg.version) !== 1 && !dryRun) throw new Error(`${version} is not newer than ${pkg.version}, the version in package.json.`);
  const dirty = sh('git', ['status', '--porcelain']);
  const tagExists = attempt('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok;
  const origin = attempt('git', ['remote', 'get-url', 'origin']).out;
  const originIsReleaseRepo = new RegExp(`[:/]${RELEASE_REPO.replace('/', '\\/')}(\\.git)?$`, 'i').test(origin);
  if (!dryRun) {
    if (dirty) throw new Error('There are changes that are not committed. Commit them (or put them aside) first:\n' + dirty);
    if (tagExists) throw new Error(`The tag ${tag} already exists. Pick the next version.`);
    if (!attempt('gh', ['auth', 'status']).ok) throw new Error('gh is not signed in. Run: gh auth login');
    const repo = attempt('gh', ['repo', 'view', RELEASE_REPO, '--json', 'visibility', '--jq', '.visibility']);
    if (!repo.ok) throw new Error(`${RELEASE_REPO} could not be found on GitHub. Releases are published there (src/app-info.mjs).`);
    if (repo.out !== 'PUBLIC') throw new Error(`${RELEASE_REPO} is ${repo.out.toLowerCase()}. Nobody could download a release from it, and the update feed would not be readable. Releases start once the public repository exists (docs/RELEASING.md, "The launch").`);
    if (attempt('gh', ['release', 'view', tag, '--repo', RELEASE_REPO]).ok) throw new Error(`${RELEASE_REPO} already has a release ${tag}.`);
  } else if (dirty) log('  (there are uncommitted changes: fine for a dry run, a real release refuses)');
  log(`  ${freeGb.toFixed(1)} GB free · publishing to ${RELEASE_REPO}${dryRun ? ' (not today)' : ''}`);

  const previous = await previousFeed(option('--previous-feed'), { dryRun });
  if (previous && compareVersions(version, previous.version) !== 1 && !dryRun) throw new Error(`${version} is not newer than ${previous.version}, which is already published.`);
  log(previous ? `  the release before: ${previous.version}${previous.minVersion ? `, oldest allowed ${previous.minVersion}` : ''}` : '  no release before this one');

  // ---- 2. tests ----
  if (!flag('--skip-tests')) {
    step('Running the tests');
    for (const script of ['typecheck', 'test']) {
      const r = attempt('npm', ['run', '--silent', script]);
      if (!r.ok) throw new Error(`npm run ${script} failed:\n${r.out.split('\n').slice(-30).join('\n')}`);
      log(`  npm run ${script}: passed`);
    }
  }

  // ---- 3. the app ----
  step('Building');
  const built = await buildApp({ version, arch: option('--arch'), log: (m) => log(`  ${m}`) });
  step('The app checks itself');
  const report = await selfTest(built.app);
  log(`  ${report.checks.length} checks passed on ${report.arch} (Electron ${report.electron})`);

  // ---- 4. the files of a release ----
  step('Making the release files');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const zipFile = path.join(outDir, zipName(version));
  sh('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', built.app, zipFile]);
  const zip = { sha256: await sha256(zipFile), size: fs.statSync(zipFile).size };
  log(`  ${path.basename(zipFile)} (${Math.round(zip.size / 1024 / 1024)} MB)`);
  const { dmg } = makeDmg({ app: built.app, out: path.join(outDir, DMG_NAME), log: (m) => log(`  ${m}`) });

  // ---- 5. notes and the feed ----
  const lastTag = attempt('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  const subjects = sh('git', ['log', '--no-merges', '--pretty=%s', ...(lastTag.ok ? [`${lastTag.out}..HEAD`] : ['-n', '200'])]).split('\n').filter(Boolean);
  const notesFile = option('--notes-file');
  const notes = notesFile ? fs.readFileSync(path.resolve(notesFile), 'utf8').trim() : lastTag.ok ? draftNotes(subjects) : 'The first release of Canopy.';
  const feed = makeFeed({ version, notes, zip, required, previous });
  if (!parseFeed(JSON.stringify(feed))) throw new Error('The feed this would publish is not one Canopy accepts. Nothing was published.');
  const feedFile = path.join(outDir, FEED_NAME);
  fs.writeFileSync(feedFile, `${JSON.stringify(feed, null, 2)}\n`);
  // Until Canopy is signed with a Developer ID, the release says how to open it the first time.
  const firstOpen = built.signed === 'adhoc'
    ? '\n\n---\n\nOpening Canopy for the first time: macOS will say it cannot check Canopy for malicious software. Click Done, open System Settings > Privacy & Security, scroll down to "Canopy was blocked" and click Open Anyway. After that Canopy opens normally and keeps itself up to date.'
    : '';
  const body = `${notes}${required ? `\n\nThis update is required: older versions of Canopy ask to update before they can be used.` : ''}${firstOpen}\n`;
  const notesOut = path.join(outDir, 'RELEASE_NOTES.md');
  fs.writeFileSync(notesOut, body);
  step('Release notes');
  log(notes.split('\n').map((l) => `  ${l}`).join('\n'));
  step('The update feed');
  log(JSON.stringify(feed, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));

  // ---- 6. publish ----
  const assets = [dmg, zipFile, feedFile];
  const create = ['release', 'create', tag, ...assets, '--repo', RELEASE_REPO, '--title', `${PRODUCT_NAME} ${version}`, '--notes-file', notesOut, '--latest',
    ...(originIsReleaseRepo ? ['--verify-tag'] : [])];
  if (dryRun) {
    step('Dry run: stopping here');
    log(`  Not done: package.json to ${version}, the commit "release: ${tag}", the tag ${tag}${originIsReleaseRepo ? ', git push' : ''}`);
    log(`  Not run:  gh ${create.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    log(`  The files are in ${shown(outDir)}. To rehearse the update with them, see docs/RELEASING.md ("Rehearse an update").`);
    return;
  }
  step('Publishing');
  sh('npm', ['version', version, '--no-git-tag-version']);
  sh('git', ['commit', '-am', `release: ${tag}`]);
  sh('git', ['tag', tag]);
  log(`  committed and tagged ${tag}`);
  // The tag has to exist where the release is made. When this checkout's origin is the release repository, push the
  // commit and the tag there; otherwise GitHub makes the tag itself on that repository's default branch.
  if (originIsReleaseRepo) { sh('git', ['push', 'origin', 'HEAD']); sh('git', ['push', 'origin', tag]); log('  pushed'); }
  try { sh('gh', create); } catch (err) {
    throw new Error(`The release was built, committed and tagged, but publishing failed:\n${err?.stderr ?? err}\nTo try publishing again:\n  gh ${create.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  }
  log(`  published: https://github.com/${RELEASE_REPO}/releases/tag/${tag}`);
  log(`  download:  ${downloadUrl()}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(`\nNo release was made: ${err?.message ?? err}`); process.exit(1); });
}

// Makes Canopy.dmg: the disk image friends download. Opened, it shows the approved window (assets/dmg/dmg-window.png):
// off-white, Canopy on the left, the Applications folder on the right, an arrow between them and one line under it.
//
//   node scripts/make-dmg.mjs [--app dist/app/Canopy.app] [--out dist/release/Canopy.dmg]
//
// How: an empty, writable image is made and mounted out of sight; the app, a link to /Applications, the background
// picture and the window's layout (.DS_Store, written by scripts/lib/ds-store.mjs) go in; then it is compressed into
// the read-only image that ships. Finder is never asked to do anything, so this runs without a screen.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMG_NAME, PRODUCT_NAME } from '../src/app-info.mjs';
import { aliasFor, windowStore } from './lib/ds-store.mjs';
import { notarize, notaryArgs } from './build-app.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).toString();

/**
 * The window, as approved: 640 x 400 inside, icons 128 with 13-point names, their middles level at y 168 (Finder
 * places an icon by its middle, measured from the top left of the area under the title bar).
 * titleBar is what Finder adds above the 400: 32 points on macOS 26, where this was measured, and 28 on macOS 11 to
 * 15. The background picture is taller than the window, so there the window simply shows 4 points more of plain
 * background under the line of text.
 */
export const LAYOUT = {
  width: 640, height: 400, titleBar: 32, iconSize: 128, textSize: 13,
  app: { x: 150, y: 168 }, applications: { x: 490, y: 168 },
};

const sizeOf = (p) => Number(run('/usr/bin/du', ['-sk', p]).split(/\s/)[0]) * 1024;

/**
 * @param {{app: string, out: string, log?: (m: string) => void}} o
 * @returns {{dmg: string, size: number}}
 */
export function makeDmg({ app, out, log = console.log }) {
  if (!fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) throw new Error(`There is no app at ${app}. Run npm run build:app first.`);
  const appName = path.basename(app);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-dmg-'));
  const sparse = path.join(work, 'canopy.sparseimage'), mount = path.join(work, 'mount');
  let mounted = false;
  try {
    // Room for the app and a little over; the image only takes the space that is used.
    const megabytes = Math.ceil(sizeOf(app) / 1024 / 1024) + 64;
    run('/usr/bin/hdiutil', ['create', '-size', `${megabytes}m`, '-fs', 'HFS+', '-volname', PRODUCT_NAME, '-type', 'SPARSE', sparse]);
    fs.mkdirSync(mount);
    run('/usr/bin/hdiutil', ['attach', sparse, '-mountpoint', mount, '-nobrowse', '-noautoopen', '-owners', 'on']);
    mounted = true;

    log(`Copying ${appName} into the disk image`);
    run('/usr/bin/ditto', [app, path.join(mount, appName)]);
    fs.symlinkSync('/Applications', path.join(mount, 'Applications'));

    // The picture behind the icons: one file holding both sizes, so it is sharp on every screen.
    fs.mkdirSync(path.join(mount, '.background'));
    const picture = path.join(mount, '.background', 'background.tiff');
    run('/usr/bin/tiffutil', ['-cathidpicheck', path.join(ROOT, 'assets', 'dmg', 'background.png'), path.join(ROOT, 'assets', 'dmg', 'background@2x.png'), '-out', picture]);

    fs.writeFileSync(path.join(mount, '.DS_Store'), windowStore({
      window: { x: 200, y: 120, width: LAYOUT.width, height: LAYOUT.height + LAYOUT.titleBar },
      iconSize: LAYOUT.iconSize, textSize: LAYOUT.textSize,
      backgroundAlias: aliasFor(picture, mount, PRODUCT_NAME),
      icons: [{ name: appName, ...LAYOUT.app }, { name: 'Applications', ...LAYOUT.applications }],
    }));

    // The mounted disk shows Canopy's icon instead of a plain white drive: the icon file, and the flag that says "use it".
    fs.copyFileSync(path.join(ROOT, 'assets', 'Canopy.icns'), path.join(mount, '.VolumeIcon.icns'));
    run('/usr/bin/xattr', ['-wx', 'com.apple.FinderInfo', '0000000000000000040000000000000000000000000000000000000000000000', mount]);
    fs.rmSync(path.join(mount, '.fseventsd'), { recursive: true, force: true });

    run('/usr/bin/hdiutil', ['detach', mount]);
    mounted = false;

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    log('Compressing the disk image');
    run('/usr/bin/hdiutil', ['convert', sparse, '-format', 'ULFO', '-o', out]);
  } finally {
    if (mounted) { try { run('/usr/bin/hdiutil', ['detach', mount, '-force']); } catch { /* it was not mounted after all */ } }
    fs.rmSync(work, { recursive: true, force: true });
  }

  // With a Developer ID the image itself is signed and notarized too, so macOS opens it without a warning.
  if (process.env.CANOPY_SIGN_IDENTITY) {
    run('/usr/bin/codesign', ['--force', '--sign', process.env.CANOPY_SIGN_IDENTITY, '--timestamp', out]);
    if (notaryArgs()) { notarize(out, log); run('/usr/bin/xcrun', ['stapler', 'staple', out]); }
  }
  const size = fs.statSync(out).size;
  const rel = path.relative(process.cwd(), out);
  log(`Made ${rel.startsWith('..') ? out : rel} (${Math.round(size / 1024 / 1024)} MB)`);
  return { dmg: out, size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  try {
    makeDmg({ app: path.resolve(option('--app') ?? path.join(ROOT, 'dist', 'app', `${PRODUCT_NAME}.app`)), out: path.resolve(option('--out') ?? path.join(ROOT, 'dist', 'release', DMG_NAME)) });
  } catch (err) { console.error(`\nThe disk image was not made: ${err?.stderr?.toString().trim() || err?.message || err}`); process.exit(1); }
}

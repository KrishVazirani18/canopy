// Dev only: rebrand the Electron bundle that `npm start` runs, so the Dock and
// Cmd+Tab say "Canopy" with our icon instead of "Electron". It runs before every
// `npm start` (prestart) and does nothing once the bundle is branded; `npm run
// brand:dev` runs it by hand. Packaged builds don't need this.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEV_APP_ID } from '../src/app-info.mjs';

// The bundle, its Info.plist and its signature are a Mac's. Anywhere else there is nothing to do.
if (process.platform !== 'darwin') process.exit(0);

const electron = path.resolve('node_modules/electron');
const dist = path.join(electron, 'dist');
const pathTxt = path.join(electron, 'path.txt');
const appDir = path.join(dist, 'Canopy.app');
const plist = path.join(appDir, 'Contents/Info.plist');
const icon = path.resolve('assets/Canopy.icns');
const bundleIcon = path.join(appDir, 'Contents/Resources/electron.icns');
const EXECUTABLE = 'Canopy.app/Contents/MacOS/Canopy';
// Canopy's own bundle ID. macOS grants notification permission per bundle ID, and Electron's shared
// com.github.Electron never got the "Allow notifications?" prompt, so banners were silently dropped.
// Helpers follow Chromium's "<main id>.helper" convention.
const BUNDLE_ID = 'io.github.krishvazirani18.canopy.dev'; // the release app is io.github.krishvazirani18.canopy

const read = (file) => { try { return readFileSync(file); } catch { return null; } };
const plistValue = (key) => { try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// Already done (every start after the first): the executable Electron is told to run is Canopy's, the
// bundle carries Canopy's ID, and its icon is the one in assets.
const branded = () => read(pathTxt)?.toString().trim() === EXECUTABLE && existsSync(path.join(dist, EXECUTABLE))
  && plistValue('CFBundleIdentifier') === BUNDLE_ID && !!read(icon) && read(icon).equals(read(bundleIcon) ?? Buffer.alloc(0));
if (branded()) process.exit(0);

// Electron downloads its binary the first time it is asked for, not when it is installed, so on a fresh
// clone there is no bundle yet. Fetch it the way Electron itself would, then brand it.
const hasBundle = () => existsSync(path.join(dist, 'Electron.app')) || existsSync(appDir);
if (!hasBundle() && existsSync(path.join(electron, 'install.js'))) spawnSync(process.execPath, [path.join(electron, 'install.js')], { stdio: 'inherit' });
if (!hasBundle()) { console.log('Electron bundle not found, skipping'); process.exit(0); }

// The Dock names a running app after its bundle folder, so the bundle itself becomes Canopy.app.
if (existsSync(path.join(dist, 'Electron.app')) && !existsSync(appDir)) renameSync(path.join(dist, 'Electron.app'), appDir);

// macOS names the running process after the executable, and Electron finds its
// helper apps as "<executable> Helper (...)", so rename all of them together.
const macos = path.join(appDir, 'Contents/MacOS');
if (existsSync(path.join(macos, 'Electron'))) renameSync(path.join(macos, 'Electron'), path.join(macos, 'Canopy'));
const fw = path.join(appDir, 'Contents/Frameworks');
for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
  const from = path.join(fw, `Electron Helper${suffix}.app`);
  const to = path.join(fw, `Canopy Helper${suffix}.app`);
  if (!existsSync(from)) continue;
  renameSync(from, to);
  renameSync(path.join(to, 'Contents/MacOS', `Electron Helper${suffix}`), path.join(to, 'Contents/MacOS', `Canopy Helper${suffix}`));
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleName Canopy Helper${suffix}`, path.join(to, 'Contents/Info.plist')]);
}
if (!existsSync(plist)) { console.log('Electron bundle not found, skipping'); process.exit(0); }
// Only now that the renamed executable is there: Electron starts whatever this file names.
if (existsSync(pathTxt)) writeFileSync(pathTxt, EXECUTABLE);

const set = (key, value, file = plist) => {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, file]); }
  catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, file]); }
};
// Canopy's own bundle ID. macOS grants notification permission per bundle ID, and Electron's shared
// com.github.Electron never got the "Allow notifications?" prompt, so banners were silently dropped.
// A run from source is the released app's ID with ".dev" on the end (src/app-info.mjs): a separate app to macOS, so
// the two never share permissions. Helpers follow Chromium's "<main id>.helper" convention.
const BUNDLE_ID = DEV_APP_ID;
set('CFBundleIdentifier', BUNDLE_ID);
for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
  const helper = path.join(fw, `Canopy Helper${suffix}.app/Contents/Info.plist`);
  if (existsSync(helper)) set('CFBundleIdentifier', `${BUNDLE_ID}.helper`, helper);
}
set('CFBundleName', 'Canopy');
set('CFBundleExecutable', 'Canopy');
set('CFBundleDisplayName', 'Canopy');
copyFileSync(icon, bundleIcon);
// Re-sign ad hoc so macOS accepts the modified bundle.
try { execFileSync('codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'ignore' }); } catch { console.log('codesign failed (continuing)'); }
execFileSync('touch', [appDir]);
try {
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', appDir]);
} catch { /* refresh is best-effort */ }
console.log('Dev Electron bundle branded as Canopy');

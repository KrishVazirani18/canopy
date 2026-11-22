// Renders the picture Finder shows behind the icons in Canopy.dmg, from assets/dmg/background.html, at 1x and 2x:
//   node scripts/dmg-background.mjs
// Only needed when the design changes: the two PNGs are kept in the repository, so making a release needs no browser.
// It uses a Chrome that is already on this Mac (Google Chrome, or the one agent-browser or Playwright installed).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'assets', 'dmg');
export const BACKGROUND = { width: 640, height: 520 };

function findChrome() {
  const home = os.homedir();
  const inside = (app) => path.join(app, 'Contents', 'MacOS', path.basename(app, '.app'));
  const newest = (dir, sub) => { try { return fs.readdirSync(dir).sort().reverse().map((d) => path.join(dir, d, sub)).filter((p) => fs.existsSync(p)); } catch { return []; } };
  const found = [
    '/Applications/Google Chrome.app',
    ...newest(path.join(home, '.agent-browser', 'browsers'), 'Google Chrome for Testing.app'),
    ...newest(path.join(home, 'Library', 'Caches', 'ms-playwright'), 'chrome-mac-arm64/Google Chrome for Testing.app'),
  ].find((app) => fs.existsSync(inside(app)));
  if (!found) throw new Error('No Chrome found on this Mac to render with.');
  return inside(found);
}

const chrome = findChrome();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-dmg-bg-'));
try {
  for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
    const out = path.join(DIR, name);
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--force-device-scale-factor=${scale}`,
      `--window-size=${BACKGROUND.width},${BACKGROUND.height}`, `--screenshot=${out}`, pathToFileURL(path.join(DIR, 'background.html')).href], { stdio: 'ignore', timeout: 60_000 });
    console.log(name, execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out]).toString().match(/\d+$/gm).join('x'));
  }
} finally { fs.rmSync(profile, { recursive: true, force: true }); }

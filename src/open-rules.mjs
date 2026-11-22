// What a click in the window may do. Paths and links in a reply are written by a model, so these rules are the guard
// against a reply that gets a person to launch something with one click:
//
//   wouldRun        a clicked path is shown in Finder, never opened, when opening it would run, install or mount it
//   resolveClicked  the full path a path written in a chat means (`~`, and relative to the chat's folder)
//   pictureType     only a real PNG, JPEG, GIF or WebP, told by its bytes, is ever handed to the window as a picture
//   safeExternal    only web and mail links leave the app
//
// No Electron here: main.mjs passes in what only it can ask (the app macOS would open a file with), so node tests the
// rules as they are.
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A click on a path must never run it. These are what macOS launches, installs or mounts rather than
// shows; so is any file whose default app is a terminal (a Unix executable always, and on many Macs
// every .sh). All of them are shown in Finder instead of being opened.
export const LAUNCH = new Set([
  '.app', '.command', '.tool', '.terminal', '.workflow', '.action', '.service', '.pkg', '.mpkg', '.dmg', '.sparseimage', '.sparsebundle', '.iso',
  '.jar', '.scpt', '.scptd', '.applescript', '.shortcut', '.webloc', '.inetloc', '.fileloc', '.url', '.prefpane', '.saver', '.mobileconfig',
]);
export const RUNNER_APP = /^(terminal|iterm2?|warp|ghostty|kitty|alacritty|wezterm|hyper|tabby|rio)$|launcher|installer/i;

/**
 * Whether opening `full` would run it. `st` is its fs.Stats. `defaultAppName(fileUrl)` gives the name of the app
 * macOS would open that file with (Electron's app.getApplicationNameForProtocol); if it cannot say, the file's
 * name and mode decide alone.
 */
export async function wouldRun(full, st, { defaultAppName } = {}) {
  const real = await realpath(full).catch(() => full); // a link is opened as whatever it points to
  if ([full, real].some((p) => LAUNCH.has(path.extname(p).toLowerCase()))) return true;
  if (!st.isFile()) return false;
  if (!path.extname(real) && (st.mode & 0o111)) return true;
  // The name of the app macOS would open this file with.
  try { return RUNNER_APP.test(defaultAppName(pathToFileURL(real).href)); } catch { return false; }
}

/** The full path for a path as a chat wrote it: `~` is the home folder, and anything relative is inside `cwd` (the home folder without one). */
export function resolveClicked(p, cwd, home) {
  const full = String(p).replace(/^~(?=\/|$)/, home);
  return path.isAbsolute(full) ? full : path.resolve(cwd || home, full);
}

/** The picture a file's first bytes say it is ('image/png', 'image/jpeg', 'image/gif', 'image/webp'), or null. Never its name. */
export const pictureType = (b) => (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 ? 'image/png'
  : b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
  : b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) ? 'image/gif'
  : b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : null);

/** A link as it may be handed to the browser, or null: only web and mail links, so a reply cannot hand macOS a
 *  shortcuts://, ssh:// or file:// URL to act on. */
export function safeExternal(url) {
  try {
    const u = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; } // not a URL
}

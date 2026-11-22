// What a click may do (src/open-rules.mjs). Paths and links in a reply are written by a model: these are the rules
// that keep one click from launching something. Real files in a throwaway folder; the "app macOS would open it with"
// is a stand-in, since only Electron can ask.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { LAUNCH, RUNNER_APP, pictureType, resolveClicked, safeExternal, wouldRun } from '../../../open-rules.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-open-rules-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const file = (name, mode = 0o644) => { const p = path.join(root, name); fs.writeFileSync(p, 'x'); fs.chmodSync(p, mode); return p; };
const folder = (name) => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; };
const link = (name, to) => { const p = path.join(root, name); fs.symlinkSync(to, p); return p; };
// The stand-in for macOS: every file opens in TextEdit unless the test says otherwise.
const runs = (p, defaultAppName = () => 'TextEdit') => wouldRun(p, fs.statSync(p), { defaultAppName });

// ---- a clicked path ----

test('what macOS would launch, install or mount is never opened: by its name, in any case, also through a link', async () => {
  assert.equal(await runs(folder('Tool.app')), true, 'an app bundle');
  assert.equal(await runs(file('setup.COMMAND')), true, 'capitals do not hide it');
  assert.equal(await runs(file('Installer.pkg')), true);
  assert.equal(await runs(file('disk.dmg')), true);
  assert.equal(await runs(file('site.webloc')), true);
  assert.equal(await runs(link('notes', folder('Linked.app'))), true, 'a link with a plain name that points at an app');
  assert.equal(await runs(link('readme.txt', file('go.command'))), true, 'a link named .txt that points at a .command');
  for (const ext of ['.app', '.command', '.pkg', '.dmg', '.jar', '.scpt', '.webloc', '.mobileconfig']) assert.ok(LAUNCH.has(ext), ext);
});

test('a file that would open in a terminal is never opened: a Unix executable, or whatever a terminal is the default app for', async () => {
  assert.equal(await runs(file('deploy', 0o755)), true, 'no extension and the execute bit: macOS runs it in Terminal');
  assert.equal(await runs(file('LICENSE', 0o644)), false, 'no extension, not executable: just a file');
  assert.equal(await runs(file('build.sh', 0o644), () => 'Terminal'), true, 'a Mac where .sh opens in Terminal');
  assert.equal(await runs(file('build2.sh', 0o644), () => 'iTerm2'), true);
  assert.equal(await runs(file('build3.sh', 0o644), () => 'Visual Studio Code'), false, 'a Mac where .sh opens in an editor');
  assert.equal(await runs(file('thing.xyz'), () => 'Some Installer'), true);
  for (const app of ['Terminal', 'iTerm', 'iTerm2', 'Warp', 'Ghostty', 'kitty', 'Script Launcher', 'Package Installer']) assert.ok(RUNNER_APP.test(app), app);
  for (const app of ['TextEdit', 'Preview', 'Xcode', 'Terminal Notes']) assert.ok(!RUNNER_APP.test(app), app);
});

test('what only shows is opened: a document, a picture, a folder; and when macOS cannot say which app, the name decides', async () => {
  assert.equal(await runs(file('notes.txt')), false);
  assert.equal(await runs(file('photo.png')), false);
  assert.equal(await runs(folder('src')), false);
  assert.equal(await runs(folder('scripts'), () => 'Terminal'), false, 'a folder opens in Finder whatever its files open with');
  assert.equal(await runs(file('plain.md'), () => { throw new Error('no handler'); }), false);
  assert.equal(await wouldRun(file('other.md'), fs.statSync(path.join(root, 'other.md'))), false, 'nobody to ask');
  assert.equal(await runs(file('run.command'), () => { throw new Error('no handler'); }), true, 'its name is enough');
});

// ---- the path a chat wrote ----

test('a path from a chat: ~ is the home folder, a relative one is inside the chat’s folder, an absolute one is itself', () => {
  const home = '/Users/sam', cwd = '/Users/sam/app';
  assert.equal(resolveClicked('~', cwd, home), '/Users/sam');
  assert.equal(resolveClicked('~/notes/todo.md', cwd, home), '/Users/sam/notes/todo.md');
  assert.equal(resolveClicked('src/main.js', cwd, home), '/Users/sam/app/src/main.js');
  assert.equal(resolveClicked('./src/../README.md', cwd, home), '/Users/sam/app/README.md');
  assert.equal(resolveClicked('/etc/hosts', cwd, home), '/etc/hosts');
  assert.equal(resolveClicked('~ada/file', cwd, home), '/Users/sam/app/~ada/file', 'only a bare ~ is the home folder');
  assert.equal(resolveClicked('notes.md', null, home), '/Users/sam/notes.md', 'no chat folder: the home folder');
  assert.equal(resolveClicked('', cwd, home), cwd);
});

// ---- a picture ----

test('a picture is known by its first bytes, never by its name', () => {
  const bytes = (...b) => Buffer.from(b);
  assert.equal(pictureType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)), 'image/png');
  assert.equal(pictureType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)), 'image/jpeg');
  assert.equal(pictureType(Buffer.from('GIF89a\x01\x00', 'latin1')), 'image/gif');
  assert.equal(pictureType(Buffer.from('GIF87a\x01\x00', 'latin1')), 'image/gif');
  assert.equal(pictureType(Buffer.concat([Buffer.from('RIFF'), bytes(0x24, 0, 0, 0), Buffer.from('WEBPVP8 ')])), 'image/webp');
  // A text file named photo.png, a sound file in the same container as WebP, an SVG, and files too short to tell.
  assert.equal(pictureType(Buffer.from('#!/bin/sh\necho not a picture\n')), null);
  assert.equal(pictureType(Buffer.concat([Buffer.from('RIFF'), bytes(0x24, 0, 0, 0), Buffer.from('WAVEfmt ')])), null);
  assert.equal(pictureType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(pictureType(bytes(0x89, 0x50, 0x4e, 0x47)), null, 'half a PNG signature');
  assert.equal(pictureType(bytes(0xff, 0xd8)), null);
  assert.equal(pictureType(Buffer.alloc(0)), null);
});

// ---- a link ----

test('only web and mail links leave the app', () => {
  assert.equal(safeExternal('https://example.com/docs?page=2#top'), 'https://example.com/docs?page=2#top');
  assert.equal(safeExternal('HTTP://Example.com'), 'http://example.com/');
  assert.equal(safeExternal('mailto:sam@example.com'), 'mailto:sam@example.com');
  for (const no of ['javascript:alert(1)', 'file:///etc/passwd', 'smb://server/share', 'ssh://host', 'shortcuts://run-shortcut?name=x', 'x-apple.systempreferences:com.apple.preference.security',
    'vscode://file/etc/hosts', 'data:text/html,<script>1</script>', 'example.com', '/Applications/Calculator.app', '', null, undefined, 7]) {
    assert.equal(safeExternal(no), null, String(no));
  }
});

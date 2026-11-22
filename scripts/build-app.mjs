// Builds Canopy.app: the app friends install, from this checkout.
//
//   npm run build:app                       builds the UI, then dist/app/Canopy.app (universal: Apple silicon and Intel)
//   node scripts/build-app.mjs --version 0.1.0 --arch arm64 --skip-ui
//
// What goes into the app is collected first, in dist/stage/app, so it can be looked at:
//   src/ (without tests), dist-ui/ (the built window), the icons, resources/ (Canopy's plugins), and only the
//   node_modules the main process uses: the Claude Agent SDK with what it needs, zod and node-pty. Everything the
//   window uses is already inside dist-ui. The SDK's own copy of Claude Code (300 MB per chip) is left out: Canopy
//   runs the Claude Code that is on the Mac.
// Then @electron/packager makes the bundle around Electron, with the app in app.asar. Two folders stay real folders
// beside it (app.asar.unpacked), because programs other than Canopy open them: resources/ (Claude Code and Codex
// read the plugins) and node-pty (macOS loads its binary).
//
// Signing. With no Apple Developer ID the app is signed "ad hoc" (no identity): Apple silicon runs nothing unsigned,
// and an ad hoc signature is the least it accepts. macOS still asks the person to allow the app once (Open Anyway).
// When a Developer ID certificate is in the keychain, name it and the same build signs with it and has Apple
// notarize it; nothing else changes (docs/RELEASING.md):
//   CANOPY_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"
//   and for notarizing, one of:  APPLE_KEYCHAIN_PROFILE  |  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//                                |  APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, PRODUCT_NAME } from '../src/app-info.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts }).toString();

/** What the main process imports from node_modules. A new one has to be named here: the build checks. */
const RUNTIME_PACKAGES = ['@anthropic-ai/claude-agent-sdk', 'zod', 'node-pty'];
/** Never shipped: the SDK's bundled Claude Code, one per platform. */
const LEFT_OUT = /^@anthropic-ai\/claude-agent-sdk-/;
/** Files no running app reads. Licences always stay. */
const isLicence = (name) => /^(licen[cs]e|notice|copying)/i.test(name);
const isDeadWeight = (name) => !isLicence(name) && /(\.map|\.d\.[cm]?ts|\.md|\.markdown|\.tsbuildinfo)$/i.test(name);

/** What macOS shows when a tool running inside Canopy (a command in a chat, the terminal) first asks for one of these. */
const USAGE = {
  AppleEvents: 'A tool running in Canopy wants to control another app.',
  Camera: 'A tool running in Canopy wants to use the camera.',
  Microphone: 'A tool running in Canopy wants to use the microphone.',
  DesktopFolder: 'Canopy and the tools it runs work with files in the folders you open.',
  DocumentsFolder: 'Canopy and the tools it runs work with files in the folders you open.',
  DownloadsFolder: 'Canopy and the tools it runs work with files in the folders you open.',
  NetworkVolumes: 'Canopy and the tools it runs work with files in the folders you open.',
  RemovableVolumes: 'Canopy and the tools it runs work with files in the folders you open.',
  LocalNetwork: 'A tool running in Canopy wants to reach a device on your network.',
  AudioCapture: 'A tool running in Canopy wants to record audio.',
  BluetoothAlways: 'A tool running in Canopy wants to use Bluetooth.',
  BluetoothPeripheral: 'A tool running in Canopy wants to use Bluetooth.',
};

/** Where a package is installed, looking up from the package that asks for it (as Node does). */
function findPackage(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === ROOT || dir === path.dirname(dir)) return null;
  }
}

/** Every package the runtime packages need, as folders relative to the checkout. */
function runtimeClosure() {
  const seen = new Map();
  const walk = (name, from, required) => {
    if (LEFT_OUT.test(name)) return;
    const dir = findPackage(name, from);
    if (!dir) { if (required) throw new Error(`${name} is needed by ${path.relative(ROOT, from) || 'Canopy'} and is not installed. Run npm ci.`); return; }
    if (seen.has(dir)) return;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    seen.set(dir, pkg);
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir, true);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) walk(dep, dir, false);
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) walk(dep, dir, !pkg.peerDependenciesMeta?.[dep]?.optional);
  };
  for (const name of RUNTIME_PACKAGES) walk(name, ROOT, true);
  return [...seen.keys()].map((dir) => path.relative(ROOT, dir)).sort();
}

/** Copies a folder, leaving out nested node_modules (each package is copied on its own) and what `skip` names. */
function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dest = path.join(to, e.name);
    if (e.name === '.DS_Store' || skip(src, e)) continue;
    if (e.isDirectory()) copyDir(src, dest, skip);
    else if (e.isSymbolicLink()) fs.cpSync(fs.realpathSync(src), dest, { recursive: true });
    else if (e.isFile()) fs.copyFileSync(src, dest);
  }
}

/** node-pty: its JavaScript, and its two native files made to run on both chips (or the one asked for). */
function stageNodePty(to, arch) {
  const from = path.join(ROOT, 'node_modules', 'node-pty');
  for (const f of ['package.json', 'LICENSE']) fs.copyFileSync(path.join(from, f), path.join(to, f));
  copyDir(path.join(from, 'lib'), path.join(to, 'lib'), (src, e) => e.isFile() && (isDeadWeight(e.name) || /\.test\.js$/.test(e.name)));
  const out = path.join(to, 'build', 'Release');
  fs.mkdirSync(out, { recursive: true });
  for (const file of ['pty.node', 'spawn-helper']) {
    const slices = (arch === 'universal' ? ['arm64', 'x64'] : [arch]).map((a) => path.join(from, 'prebuilds', `darwin-${a}`, file));
    for (const s of slices) if (!fs.existsSync(s)) throw new Error(`node-pty has no prebuilt ${path.relative(from, s)}. Run npm ci.`);
    if (slices.length === 1) fs.copyFileSync(slices[0], path.join(out, file));
    else run('/usr/bin/lipo', ['-create', ...slices, '-output', path.join(out, file)]);
  }
  fs.chmodSync(path.join(out, 'spawn-helper'), 0o755);
}

/** The package names the main process imports, read from src/ itself (import and require statements, not prose). */
const IMPORTS = [
  /^\s*(?:import|export)\s[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm,   // import x from 'pkg'
  /^\s*\}\s*from\s+['"]([^'"]+)['"]/gm,                          // the last line of a long import
  /^\s*import\s+['"]([^'"]+)['"]/gm,                              // import 'pkg'
  /(?<![.\w])(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g,       // import('pkg'), require('pkg')
];
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/.*)?$/;
function importedPackages(dir) {
  const found = new Set();
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { visit(path.join(d, e.name)); continue; }
      if (!/\.(mjs|cjs)$/.test(e.name)) continue;
      const text = fs.readFileSync(path.join(d, e.name), 'utf8');
      for (const pattern of IMPORTS) {
        for (const [, spec] of text.matchAll(pattern)) {
          if (spec.startsWith('.') || spec.startsWith('node:') || spec === 'electron' || !PACKAGE_NAME.test(spec)) continue;
          found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
        }
      }
    }
  };
  visit(dir);
  return [...found].sort();
}

/** dist/stage/app: exactly what the app will hold. */
function stage(stageDir, { version, arch }) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(stageDir, 'package.json'), `${JSON.stringify({
    name: pkg.name, productName: PRODUCT_NAME, version, description: pkg.description, main: pkg.main, type: pkg.type,
  }, null, 2)}\n`);

  copyDir(path.join(ROOT, 'src'), path.join(stageDir, 'src'), (src) => src === path.join(ROOT, 'src', 'core', 'test'));
  if (!fs.existsSync(path.join(ROOT, 'dist-ui', 'index.html'))) throw new Error('dist-ui is not built. Run npm run build:ui.');
  copyDir(path.join(ROOT, 'dist-ui'), path.join(stageDir, 'dist-ui'));
  fs.mkdirSync(path.join(stageDir, 'assets'));
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(stageDir, 'assets', 'icon.png'));
  copyDir(path.join(ROOT, 'assets', 'tray'), path.join(stageDir, 'assets', 'tray'));
  copyDir(path.join(ROOT, 'resources'), path.join(stageDir, 'resources'));

  for (const rel of runtimeClosure()) {
    const to = path.join(stageDir, rel);
    fs.mkdirSync(to, { recursive: true });
    if (rel === path.join('node_modules', 'node-pty')) stageNodePty(to, arch);
    else copyDir(path.join(ROOT, rel), to, (src, e) => (e.isDirectory() ? e.name === 'node_modules' : isDeadWeight(e.name)));
  }

  // Every package src/ imports must be in the app, or it would start from source and fail once packaged.
  const missing = importedPackages(path.join(stageDir, 'src')).filter((name) => !fs.existsSync(path.join(stageDir, 'node_modules', name, 'package.json')));
  if (missing.length) throw new Error(`src/ imports ${missing.join(', ')}, which the app would not contain. Add ${missing.length > 1 ? 'them' : 'it'} to RUNTIME_PACKAGES in scripts/build-app.mjs.`);
}

/** How notarytool is told who is asking, from the environment; null when nothing is set. */
export function notaryArgs(env = process.env) {
  if (env.APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE];
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  return null;
}

/** Has Apple notarize a zip or disk image and waits for the answer. Throws when Apple says no. */
export function notarize(file, log = console.log) {
  const who = notaryArgs();
  if (!who) throw new Error('No notarization credentials in the environment (see docs/RELEASING.md).');
  log(`Notarizing ${path.basename(file)} (Apple usually answers within a few minutes)`);
  const out = run('/usr/bin/xcrun', ['notarytool', 'submit', file, '--wait', ...who]);
  if (!/status:\s*Accepted/.test(out)) throw new Error(`Apple did not accept ${path.basename(file)}:\n${out}`);
}

/** Signs the finished app: with the named Developer ID (and notarized, when credentials are set), else ad hoc. */
async function signApp(app, log) {
  const identity = process.env.CANOPY_SIGN_IDENTITY;
  if (!identity) {
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
    log('Signed ad hoc (no Developer ID): macOS asks to allow the app once, under Privacy & Security');
  } else {
    const { sign } = await import('@electron/osx-sign');
    // The hardened runtime and Electron's entitlements are osx-sign's defaults: what notarization asks for.
    await sign({ app, identity, platform: 'darwin' });
    log(`Signed as ${identity}`);
    if (notaryArgs()) {
      const zip = `${app}.notarize.zip`;
      run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
      try { notarize(zip, log); } finally { fs.rmSync(zip, { force: true }); }
      run('/usr/bin/xcrun', ['stapler', 'staple', app]);
      log('Notarized, and the ticket is stapled to the app');
    } else log('Not notarized: no credentials in the environment. macOS will still warn about this app.');
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

/**
 * Builds the app and answers where it is.
 * @param {{version?: string, arch?: 'universal'|'arm64'|'x64', outDir?: string, skipUi?: boolean, log?: (m: string) => void}} [o]
 * @returns {Promise<{app: string, version: string, arch: string, signed: 'adhoc'|'developer-id'}>}
 */
export async function buildApp(o = {}) {
  if (process.platform !== 'darwin') throw new Error('Canopy.app is built on a Mac.');
  const log = o.log ?? console.log;
  const version = o.version ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not a version like 0.1.0.`);
  const arch = o.arch ?? 'universal';
  const outDir = path.resolve(o.outDir ?? path.join(ROOT, 'dist'));

  if (!o.skipUi) { log('Building the window (vite build)'); run(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT }); }
  const stageDir = path.join(outDir, 'stage', 'app');
  log('Collecting what goes into the app');
  stage(stageDir, { version, arch });

  const { packager } = await import('@electron/packager');
  const electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  log(`Packaging Canopy ${version} around Electron ${electronVersion} (${arch})`);
  const packDir = path.join(outDir, 'pack');
  fs.rmSync(packDir, { recursive: true, force: true });
  const [made] = await packager({
    dir: stageDir, out: packDir, name: PRODUCT_NAME, platform: 'darwin', arch, electronVersion,
    appVersion: version, buildVersion: version, appBundleId: APP_ID, helperBundleId: `${APP_ID}.helper`,
    appCategoryType: 'public.app-category.developer-tools', appCopyright: `Copyright © ${new Date().getFullYear()} Krish Vazirani`,
    icon: path.join(ROOT, 'assets', 'Canopy.icns'), usageDescription: USAGE,
    // Real folders beside app.asar: programs other than Canopy open them.
    asar: { unpackDir: '{resources,node_modules/node-pty}' },
    prune: false, overwrite: true, quiet: true, derefSymlinks: true,
  });
  const packed = path.join(made, `${PRODUCT_NAME}.app`);

  // Electron's own licence and the licences of everything in Chromium ship inside the app.
  for (const f of ['LICENSE', 'LICENSES.chromium.html']) {
    if (fs.existsSync(path.join(made, f))) fs.copyFileSync(path.join(made, f), path.join(packed, 'Contents', 'Resources', f === 'LICENSE' ? 'LICENSE.electron.txt' : f));
  }

  // Fuses: switches inside Electron's binary that a packaged app sets once (https://www.electronjs.org/docs/latest/tutorial/fuses).
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  await flipFuses(packed, {
    version: FuseVersion.V1,
    // Stays on. Canopy runs its own program as plain Node in three places: Code Mode's sandboxed scripts
    // (core/code-mode.mjs), the helper Codex chats call Canopy's tools through (core/tool-relay.mjs), and the daily
    // usage summary's reader (telemetry/summary.mjs). Off, each of them would open a second Canopy instead.
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS set for other programs must not reach into Canopy
    [FuseV1Options.EnableNodeCliInspectArguments]: false,        // no --inspect: the released app takes no debugger
    [FuseV1Options.OnlyLoadAppFromAsar]: true,                   // only the app that was packaged, never a folder put beside it
  });

  const app = path.join(outDir, 'app', `${PRODUCT_NAME}.app`);
  fs.rmSync(path.dirname(app), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.renameSync(packed, app);
  fs.rmSync(packDir, { recursive: true, force: true });

  await signApp(app, log);
  const rel = path.relative(process.cwd(), app);
  log(`Built ${rel.startsWith('..') ? app : rel}`);
  return { app, version, arch, signed: process.env.CANOPY_SIGN_IDENTITY ? 'developer-id' : 'adhoc' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  buildApp({ version: option('--version'), arch: option('--arch'), outDir: option('--out'), skipUi: argv.includes('--skip-ui') })
    .catch((err) => { console.error(`\nThe build failed: ${err?.message ?? err}`); process.exit(1); });
}

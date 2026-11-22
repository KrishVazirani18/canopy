// The app checking itself once it is packaged: the things that work from source and can quietly stop working inside
// an app bundle. The release script runs this on every build before anything is published (scripts/release.mjs):
//
//   CANOPY_SELFTEST=1 CANOPY_USER_DATA=/tmp/somewhere Canopy.app/Contents/MacOS/Canopy
//
// It only ever runs in an automated copy (CANOPY_USER_DATA: its own data folder, nothing sent anywhere). It prints one
// JSON object, writes the same to selftest.json in that folder, and the app exits 0 when every check passed, 1 when not.
//
//   packaged       this is not a run from source: no dev log, telemetry says "prod", no Reload or developer tools in
//                  the menus, the window cannot open developer tools, and the page's dev-only parts are off
//   window         the built page loaded and drew something
//   terminal       node-pty's native binary loads and runs a command (the terminal, sign-in, Run in the chat)
//   as Node        Canopy's own program runs as plain Node: Code Mode's sandbox, the helper Codex calls Canopy's tools
//                  through, and the daily summary's reader all depend on it (the runAsNode fuse)
//   plugins        Canopy's two plugins are real folders on disk, where Claude Code and Codex can read them
//   update helper  the updater's shell script is readable from inside the bundle, and an old copy of the app can be
//                  cleared away (which Node's own fs cannot do inside Electron)
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { SWAP_HELPER, removeTree } from './core/app-update.mjs';
import { CODE_MISSING, runScript } from './core/code-mode.mjs';
import { canopyPlugin, kitDir } from './core/plugin.mjs';
import { RELAY_MISSING } from './core/tool-relay.mjs';
import { addDays, localDate, summarizeDays } from './telemetry/summary.mjs';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, p, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} took more than ${ms / 1000}s`); })]);
const exec = (cmd, args, opts) => new Promise((resolve) => execFile(cmd, args, { timeout: 20_000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })));

/**
 * @param {object} o  what only main knows: { app, Menu, win, isDev, telemetryEnv, logFile, engineClaude, update }
 * @returns {Promise<number>} the exit code
 */
export async function runSelfTest(o) {
  const checks = [];
  const check = async (name, fn) => {
    try { const detail = await fn(); checks.push({ name, ok: true, ...(detail !== undefined && { detail }) }); }
    catch (err) { checks.push({ name, ok: false, detail: String(err?.message ?? err).slice(0, 400) }); }
  };
  const expect = (cond, what) => { if (!cond) throw new Error(what); };

  await check('not a run from source', () => { expect(o.isDev === false, 'IS_DEV is true'); expect(o.app.getAppPath().endsWith('app.asar'), `the app is at ${o.app.getAppPath()}`); });
  await check('telemetry says prod', () => { expect(o.telemetryEnv === 'prod', `env is ${o.telemetryEnv}`); return o.telemetryEnv; });
  await check('the log is canopy.log', () => { expect(path.basename(o.logFile) === 'canopy.log', path.basename(o.logFile)); return path.basename(o.logFile); });
  await check('no Reload or developer tools in the menus', () => {
    const items = [];
    const walk = (menu) => { for (const i of menu?.items ?? []) { items.push(`${i.role ?? ''} ${i.label ?? ''}`.trim()); walk(i.submenu); } };
    walk(o.Menu.getApplicationMenu());
    const dev = items.filter((s) => /reload|dev ?tools|inspect/i.test(s));
    expect(items.length > 10, 'the menu was not built');
    expect(dev.length === 0, `found: ${dev.join(', ')}`);
    return `${items.length} menu items`;
  });
  await check('developer tools do not open', async () => {
    o.win.webContents.openDevTools({ mode: 'detach' });
    await sleep(600);
    expect(!o.win.webContents.isDevToolsOpened(), 'developer tools opened');
  });
  await check('the window loaded, with its dev-only parts off', async () => {
    const page = await within(15_000, o.win.webContents.executeJavaScript('({ dev: window.canopy?.dev, drawn: document.getElementById("root")?.childElementCount ?? 0, mock: new URLSearchParams(location.search).has("mock") })'), 'the page');
    expect(page.drawn > 0, 'the page drew nothing');
    expect(page.dev === false, `window.canopy.dev is ${page.dev}`);
    return page;
  });
  await check('the terminal runs a command (node-pty)', async () => {
    const pty = require('node-pty');
    const out = await within(10_000, new Promise((resolve, reject) => {
      let text = '';
      const p = pty.spawn('/bin/sh', ['-c', 'echo canopy-pty-ok'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.tmpdir(), env: { PATH: '/usr/bin:/bin' } });
      p.onData((d) => { text += d; });
      p.onExit(({ exitCode }) => (exitCode === 0 ? resolve(text) : reject(new Error(`exit ${exitCode}: ${text}`))));
    }), 'the pty');
    expect(out.includes('canopy-pty-ok'), `it printed ${JSON.stringify(out)}`);
    return `${process.arch}`;
  });
  await check('Canopy runs as plain Node (the runAsNode fuse)', async () => {
    const r = await exec(process.execPath, ['-e', 'process.stdout.write(process.versions.node)'], { env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(r.ok && r.stdout === process.versions.node, `it printed ${JSON.stringify(r.stdout || r.stderr).slice(0, 200)}`);
    return `node ${r.stdout}`;
  });
  await check('Code Mode runs a script in its sandbox', async () => {
    expect(CODE_MISSING === null, `missing: ${CODE_MISSING}`);
    const r = await within(30_000, runScript({ code: 'return 6 * 7', handle: async () => null, timeoutMs: 20_000 }), 'the script');
    expect(r.ok && String(r.out).includes('42'), `it answered ${JSON.stringify(r).slice(0, 300)}`);
  });
  await check('the helper Codex calls Canopy\'s tools through is in the build', () => { expect(RELAY_MISSING === null, `missing: ${RELAY_MISSING}`); });
  await check('the daily summary reads in a process of its own', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-selftest-'));
    try {
      const day = addDays(localDate(Date.now()), -1);
      const days = await within(60_000, summarizeDays({ claudeDirs: [dir], codexHome: dir, canopyChatsDir: [], fromDate: day, toDate: day }), 'the scan');
      expect(days.length === 1, `it counted ${days.length} days`);
      expect(days.stats.child === true, 'it ran inside Canopy\'s own process: the separate one did not start');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  await check('the plugins are real folders on disk', async () => {
    const plugin = canopyPlugin(), kit = canopyPlugin(kitDir());
    expect(plugin?.skills.length > 0, 'resources/canopy-plugin was not found');
    expect(kit?.skills.length > 0, 'resources/canopy-kit was not found');
    // Asked of a program that is not Canopy: only a real folder answers.
    for (const p of [plugin, kit]) expect((await exec('/bin/ls', [path.join(p.skillsDir, p.skills[0], 'SKILL.md')])).ok, `${p.dir} is not readable from outside Canopy`);
    return [...plugin.skills, ...kit.skills].join(', ');
  });
  await check('the Claude Agent SDK is in the build', () => { expect(typeof o.engineClaude === 'string' && o.engineClaude, 'its package.json could not be read'); return `built against Claude Code ${o.engineClaude}`; });
  await check('an old copy of the app can be cleared away', async () => {
    // Inside Electron, Node's fs cannot remove a folder that holds an app.asar: the updater must not depend on it.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-selftest-'));
    try {
      const inside = path.join(dir, 'previous', 'Canopy.app', 'Contents', 'Resources');
      mkdirSync(inside, { recursive: true });
      // Made by another program for the same reason: fs here will not even write a file of this name.
      expect((await exec('/usr/bin/touch', [path.join(inside, 'app.asar')])).ok, 'the stand-in app could not be made');
      expect(await removeTree(path.join(dir, 'previous'), dir), 'it was not removed');
      expect(!existsSync(path.join(dir, 'previous')), 'it is still there');
    } finally { await removeTree(dir, os.tmpdir()); rmSync(dir, { recursive: true, force: true }); }
  });
  await check('the update helper is in the build', () => { expect(typeof SWAP_HELPER === 'string' && SWAP_HELPER.startsWith('#!/bin/sh'), 'app-update-swap.sh could not be read'); return o.update; });

  const failed = checks.filter((c) => !c.ok);
  const report = { ok: failed.length === 0, version: o.app.getVersion(), arch: process.arch, electron: process.versions.electron, checks };
  const text = JSON.stringify(report, null, 2);
  try { writeFileSync(path.join(o.app.getPath('userData'), 'selftest.json'), text); } catch { /* it is printed all the same */ }
  process.stdout.write(`${text}\n`);
  return failed.length ? 1 : 0;
}

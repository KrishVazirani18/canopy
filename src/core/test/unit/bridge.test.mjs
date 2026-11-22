// The bridge between the window and the main process is three lists kept by hand: the channels src/preload.cjs calls,
// the handlers the main process registers, and the `CanopyApi` type the window is compiled against. A name changed in
// one of them fails only when somebody clicks ("No handler registered"). This reads the files as text and holds the
// three to each other. Nothing is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HERE } from '../helpers.mjs';

const SRC = path.resolve(HERE, '..', '..');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
  ? (e.name === 'test' ? [] : files(path.join(dir, e.name)))
  : /\.(mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const preload = fs.readFileSync(path.join(SRC, 'preload.cjs'), 'utf8');
const main = files(SRC).filter((f) => path.basename(f) !== 'preload.cjs').map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const api = fs.readFileSync(path.resolve(SRC, '..', 'renderer', 'src', 'lib', 'api.ts'), 'utf8');
const all = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))].sort();
const missing = (wanted, have) => wanted.filter((c) => !have.includes(c));

// What the window calls and waits on, what it tells without waiting, and what it listens for.
const invoked = all(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g);
const told = all(preload, /ipcRenderer\.send\(\s*'([^']+)'/g);
const heard = all(preload, /\bon\('([^']+)'\)/g);
// What the main process answers (`handle`, main's guarded ipcMain.handle), listens to (`listen`, and the `on` it hands
// its register* modules) and sends.
const handled = all(main, /\bhandle\(\s*'([^']+)'/g);
const listened = all(main, /\b(?:listen|on)\??\.?\(\s*'([^']+)'/g);
const sent = all(main, /\bsend\??\.?\(\s*'([^']+)'/g);

test('the lists are really being read', () => {
  assert.ok(invoked.length > 100 && handled.length > 100, `${invoked.length} channels called, ${handled.length} handled`);
  assert.ok(told.length >= 5 && heard.length >= 20, `${told.length} told, ${heard.length} heard`);
  assert.ok(!/ipcRenderer\.(invoke|send|on)\(\s*[^'\s)]/.test(preload.replace(/ipcRenderer\.on\(channel, h\)/, '')), 'every channel in preload is written out as a plain string');
});

test('every channel the window calls has a handler, and every handler can be reached from the window', () => {
  assert.deepEqual(missing(invoked, handled), [], 'called by preload.cjs, handled nowhere');
  assert.deepEqual(missing(handled, invoked), [], 'handled in the main process, but preload.cjs never calls it');
});

test('everything the window tells the main process is listened to, and everything it listens for is sent', () => {
  assert.deepEqual(missing(told, listened), [], 'sent one-way by preload.cjs, listened to nowhere');
  assert.deepEqual(missing(heard, sent), [], 'preload.cjs listens for it, nothing sends it');
});

test('what preload exposes is what the window’s type says it has', () => {
  const block = (text, from) => { const i = text.indexOf(from); assert.ok(i >= 0, `found: ${from}`); return text.slice(i, text.indexOf('\n}', i)); };
  const exposed = all(block(preload, "contextBridge.exposeInMainWorld('canopy', {"), /^  ([A-Za-z_]\w*):/gm);
  const declared = all(block(api, 'export interface CanopyApi {'), /^  ([A-Za-z_]\w*)\??\s*[(:<]/gm);
  assert.ok(exposed.length > 50 && declared.length > 50, `${exposed.length} exposed, ${declared.length} declared`);
  // `customize` is typed by the one file that calls it (renderer/src/lib/customize.ts), not in CanopyApi.
  assert.deepEqual(missing(exposed, declared), ['customize'], 'exposed by preload.cjs, missing from CanopyApi');
  assert.deepEqual(missing(declared, exposed), [], 'declared in CanopyApi, not exposed by preload.cjs');
});

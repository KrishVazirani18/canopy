// What Settings → Codex says about Computer Use (src/computer-use.mjs), with a stand-in for Codex: nothing is
// started, System Settings is never opened and nothing under ~/.codex is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CODEX_APP_ID, HELPER_APP, PANES, appAccess, createComputerUse, featureOn, summary } from '../../../computer-use.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-computer-use-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function make({ home = path.join(root, 'none'), answers = {} } = {}) {
  const calls = [];
  const opened = [];
  const service = { call: async (method, params) => { calls.push({ method, params }); const a = answers[method]; if (a instanceof Error) throw a; return a === undefined ? { ok: false, message: 'no' } : { ok: true, result: a }; } };
  const cu = createComputerUse({ service, codexHome: () => home, openExternal: async (url) => { opened.push(url); }, openApp: async (id) => { opened.push(`app:${id}`); }, version: async () => '26.1111' });
  return { cu, calls, opened };
}

test('status: the helper app, the feature and the apps, each as Codex says it', async () => {
  const home = path.join(root, 'with');
  fs.mkdirSync(path.join(home, 'computer-use', HELPER_APP, 'Contents'), { recursive: true });
  const on = make({ home, answers: {
    'experimentalFeature/list': { data: [{ name: 'apps', enabled: true }, { name: 'computer_use', enabled: true }], nextCursor: null },
    'config/read': { config: { computer_use: { default_app_access: 'deny', macos: { bundle_ids: { 'com.google.Chrome': 'allow', 'com.apple.Terminal': 'deny', odd: 7 } } } } },
  } });
  const s = await on.cu.status();
  assert.deepEqual([s.installed, s.version, s.on, s.state, s.line], [true, '26.1111', true, 'on', 'On']);
  assert.deepEqual(s.apps, { any: false, listed: [{ id: 'com.google.Chrome', access: 'allow' }, { id: 'com.apple.Terminal', access: 'deny' }] });
  assert.deepEqual(s.permissions.map((p) => [p.key, p.needed]), [['accessibility', true], ['screen', true], ['automation', false]]);
  assert.deepEqual(on.calls.map((c) => c.method).sort(), ['config/read', 'experimentalFeature/list']);

  const off = await make({ home, answers: { 'experimentalFeature/list': { data: [{ name: 'computer_use', enabled: false }] }, 'config/read': { config: {} } } }).cu.status();
  assert.deepEqual([off.on, off.state, off.apps], [false, 'off', { any: true, listed: [] }]);
  const silent = await make({ home }).cu.status();
  assert.deepEqual([silent.installed, silent.on, silent.state, silent.apps], [true, null, 'unknown', null], 'no status is made up when Codex does not answer');
  const missing = await make({ answers: { 'experimentalFeature/list': { data: [{ name: 'computer_use', enabled: true }] } } }).cu.status();
  assert.deepEqual([missing.installed, missing.state], [false, 'missing']);
  const broken = await make({ answers: { 'experimentalFeature/list': new Error('boom'), 'config/read': new Error('boom') } }).cu.status();
  assert.equal(broken.state, 'missing', 'a Codex that throws is one that did not answer');
});

test('the only change is Codex\'s own config call, and only the known panes are opened', async () => {
  const { cu, calls, opened } = make({ answers: { 'config/value/write': { status: 'ok' } } });
  assert.deepEqual(await cu.turnOn(), { ok: true });
  assert.deepEqual(calls, [{ method: 'config/value/write', params: { keyPath: 'features.computer_use', value: true, mergeStrategy: 'upsert' } }]);
  assert.deepEqual(await make().cu.turnOn(), { ok: false });

  assert.deepEqual(await cu.openPane('accessibility'), { ok: true });
  assert.deepEqual(await cu.openPane('screen'), { ok: true });
  for (const key of ['', 'constructor', '__proto__', 'file:///etc/passwd', null]) assert.deepEqual(await cu.openPane(key), { ok: false });
  assert.deepEqual(await cu.openCodexApp(), { ok: true });
  assert.deepEqual(opened, [PANES.accessibility, PANES.screen, `app:${CODEX_APP_ID}`]);
  assert.match(PANES.accessibility, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Accessibility$/);
  assert.match(PANES.screen, /Privacy_ScreenCapture$/);
});

test('the small readers never throw on what is not there', () => {
  assert.deepEqual(appAccess(null), { any: true, listed: [] });
  assert.deepEqual(appAccess({ computer_use: { default_app_access: 'allow', macos: { bundle_ids: null } } }), { any: true, listed: [] });
  assert.equal(featureOn(null), null);
  assert.equal(featureOn([{ name: 'other', enabled: true }]), null);
  assert.equal(summary({ installed: true, on: true }).state, 'on');
  assert.equal(summary({ installed: false, on: false }).state, 'off');
});

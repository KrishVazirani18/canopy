// The line under a Computer Use step that failed for a reason the user can fix (renderer/src/lib/computer-use-fix.ts).
// Plain TypeScript, run by node as it is. The failure texts are Computer Use's own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computerUseFix, computerUseFixes } from '../../../../renderer/src/lib/computer-use-fix.ts';

const DOCS = '\n## Computer Use\n\nControl native apps and browsers on the user’s computer by reading or operating UI.';

test('an app that was not allowed: say which, and offer to ask again', () => {
  const fix = computerUseFix('mcp__cua_repl__js', `Computer Use was not approved to use Google Chrome${DOCS}`, true);
  assert.deepEqual(fix, { kind: 'app', app: 'Google Chrome', line: 'Google Chrome was not allowed. Try again and choose Allow when Canopy asks.', prompt: 'Try that again. I will allow Google Chrome.' });
  assert.equal(computerUseFix('mcp__computer-use__get_app_state', "Computer Use approval denied via MCP elicitation for app 'com.apple.Notes'", true)?.app, 'com.apple.Notes');
  assert.equal(computerUseFix('mcp__plugin_unified_cua_repl__js', "Computer Use permission request canceled for app 'Slack'", true)?.app, 'Slack');
  assert.equal(computerUseFix('mcp__cua_repl__js', 'Computer Use was not approved to record computer audio', true)?.kind, 'app');
});

test('a macOS permission that is missing: the pane to open', () => {
  const pending = computerUseFix('mcp__cua_repl__js', 'Computer Use permissions are still pending. The user has not finished granting Accessibility and Screen Recording permissions in the ChatGPT Computer Use window.', true);
  assert.deepEqual([pending?.kind, pending?.kind === 'permission' && pending.pane], ['permission', 'accessibility']);
  const ax = computerUseFix('mcp__computer-use__click', 'Accessibility error: kAXErrorAPIDisabled', true);
  assert.deepEqual([ax?.kind, ax?.kind === 'permission' && ax.pane], ['permission', 'accessibility']);
});

test('anything else is left as Codex said it', () => {
  assert.equal(computerUseFix('mcp__cua_repl__js', 'Computer Use was not approved to use Google Chrome', false), null, 'a step that did not fail');
  assert.equal(computerUseFix('mcp__slack__send', 'Computer Use was not approved to use Google Chrome', true), null, 'another tool quoting the words');
  assert.equal(computerUseFix('Bash', 'Accessibility error: x', true), null);
  assert.equal(computerUseFix('mcp__cua_repl__js', 'The browser access host is unavailable', true), null);
  assert.equal(computerUseFix('mcp__cua_repl__js', "Computer Use is blocked from using the app 'x' by your organization's policy.", true), null);
  for (const r of [undefined, null, '']) assert.equal(computerUseFix('mcp__cua_repl__js', r, true), null);
});

test('a run of steps shows each fix once, and none that a later Computer Use step got past', () => {
  const denied = { name: 'mcp__cua_repl__js', result: 'Computer Use was not approved to use Google Chrome', status: 'error' };
  const pending = { name: 'mcp__cua_repl__js', result: 'Computer Use permissions are still pending.', status: 'error' };
  const worked = { name: 'mcp__cua_repl__js', result: 'ok', status: 'done' };
  const other = { name: 'Bash', result: 'ok', status: 'done' };
  assert.deepEqual(computerUseFixes([denied, other, denied]).map((f) => f.kind), ['app']);
  assert.deepEqual(computerUseFixes([denied, pending]).map((f) => f.kind), ['app', 'permission']);
  assert.deepEqual(computerUseFixes([denied, worked]), [], 'allowed on the next try: nothing left to fix');
  assert.deepEqual(computerUseFixes([denied, worked, pending]).map((f) => f.kind), ['permission']);
  assert.deepEqual(computerUseFixes([other, { name: 'mcp__cua_repl__js', status: 'running' }]), []);
  assert.deepEqual(computerUseFixes([]), []);
});

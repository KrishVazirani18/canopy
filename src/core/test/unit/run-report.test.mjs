// Run in the chat: the message Claude gets when a command run from a reply ends (renderer/src/lib/run-report.ts),
// and reading it back for the chat's "You ran …" bubble.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

const R = await import(pathToFileURL(path.join(HERE, '..', '..', '..', 'renderer', 'src', 'lib', 'run-report.ts')).href);

test('terminal output reads as the lines a person saw', () => {
  const raw = '\x1b]0;title\x07\x1b[1;32m✓ Done\x1b[0m\r\n'
    + 'Downloading  10%\rDownloading  55%\rDownloading 100%\r\n'
    + 'bell\x07 and \x1b[2Kerase\r\n\r\n\r\n';
  assert.equal(R.plainOutput(raw), '✓ Done\nDownloading 100%\nbell and erase');
  assert.equal(R.plainOutput('\r\n\r\n'), '');
});

test('a report says the command, how it ended and what it printed, and reads back the same', () => {
  const text = R.runReport('claude mcp login posthog\n', 0, 'Opening your browser…\r\n\x1b[32mSigned in to PostHog.\x1b[0m\r\n');
  assert.equal(text, [
    "I ran this in Canopy's terminal (exit code 0):", '', '```sh', 'claude mcp login posthog', '```', '',
    'What it printed:', '', '```text', 'Opening your browser…\nSigned in to PostHog.', '```',
  ].join('\n'));
  assert.deepEqual(R.parseRunReport(text), { code: 'claude mcp login posthog', exitCode: 0, output: 'Opening your browser…\nSigned in to PostHog.' });
});

test('a long output keeps its end, a quiet one says so, and a signal is not an exit code', () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const text = R.runReport('seq 100', 1, long);
  assert.match(text, /\(exit code 1\)/);
  assert.match(text, /the last 60 lines/);
  const back = R.parseRunReport(text);
  assert.equal(back.output.split('\n')[0], 'line 41');
  assert.equal(back.output.split('\n').at(-1), 'line 100');

  const quiet = R.runReport('true', null, '');
  assert.match(quiet, /it ended on a signal/);
  assert.match(quiet, /It printed nothing\./);
  assert.deepEqual(R.parseRunReport(quiet), { code: 'true', exitCode: null, output: '' });
});

test('backticks in the command or the output cannot break the message', () => {
  const text = R.runReport('printf \'```\\n\'', 0, '```\nnot a fence\n```');
  const back = R.parseRunReport(text);
  assert.equal(back.code, 'printf \'```\\n\'');
  assert.equal(back.output, '```\nnot a fence\n```');
});

test('an ordinary message is not a report', () => {
  assert.equal(R.parseRunReport('I ran the tests and they pass'), null);
  assert.equal(R.parseRunReport("I ran this in Canopy's terminal, sort of"), null);
});

test('a block with no language has Run only when it is commands', () => {
  assert.equal(R.plainCommand('security add-generic-password -a canopy -s "Canopy Supabase token" -w\n'), 'security add-generic-password -a canopy -s "Canopy Supabase token" -w');
  assert.equal(R.plainCommand('claude mcp login posthog'), 'claude mcp login posthog');
  assert.equal(R.plainCommand('$ npm install\n$ npm test'), 'npm install\nnpm test', 'a prompt in front is dropped');
  assert.equal(R.plainCommand('cd ~/repo\n# then\n./scripts/setup.sh \\\n  --fast'), 'cd ~/repo\n# then\n./scripts/setup.sh \\\n  --fast');
  assert.equal(R.plainCommand('FOO=1 node app.js'), 'FOO=1 node app.js');
  // Not commands: a tree, a diagram, output, prose, too long.
  assert.equal(R.plainCommand('src/\n├── main.mjs\n└── run-ipc.mjs'), null);
  assert.equal(R.plainCommand('window → run-ipc → pty'), null);
  assert.equal(R.plainCommand('Signed in.\nOpening your browser…'), null);
  assert.equal(R.plainCommand('total 8\ndrwxr-xr-x  3 me  staff'), null);
  assert.equal(R.plainCommand(Array(13).fill('ls').join('\n')), null);
  assert.equal(R.plainCommand('   '), null);
});

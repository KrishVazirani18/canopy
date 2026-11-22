// Which Codex chats another app has open (src/codex-held.mjs), from made-up `lsof` and `ps` output shaped like the
// real thing on a Mac. No process is looked at, nothing under ~/.codex is touched, and no lock is ever asked for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sleep } from '../helpers.mjs';
import { CodexHeld, appOf, heldFrom, heldLine, heldText, parseLsof, parsePs } from '../../../codex-held.mjs';

const DIR = '/Users/test/.codex/thread-writer-locks';
const A = '01a1f000-0000-7000-8000-00000000000a';
const B = '01a1f000-0000-7000-8000-00000000000b';
const C = '01a1f000-0000-7000-8000-00000000000c';
const D = '01a1f000-0000-7000-8000-00000000000d';
const CANOPY = 3000;

// What `lsof -F pn +D <dir>` prints: a process, then each of its files (descriptor, name).
const lsofOf = (...sets) => sets.map(([pid, ...ids]) => `p${pid}\n${ids.map((id, i) => `f${29 + i}\nn${DIR}/${id}.lock`).join('\n')}`).join('\n') + '\n';
// What `ps -axo pid=,ppid=,comm=` prints: right-aligned numbers, then the program's path, spaces and all.
const psOf = (rows) => rows.map(([pid, ppid, comm]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${comm}`).join('\n') + '\n';

const PS = psOf([
  [1, 0, '/sbin/launchd'],
  // The Codex app, through a bridge that sits between it and its Codex (a helper app of the user's own).
  [2000, 1, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'],
  [2001, 2000, '/Users/test/Applications/Some Helper.app/Contents/Resources/codex-bridge'],
  [2002, 2001, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'],
  // Canopy and the Codex it started for a chat of its own.
  [CANOPY, 1, '/Users/test/canopy/node_modules/electron/dist/Canopy.app/Contents/MacOS/Canopy'],
  [3001, CANOPY, '/opt/homebrew/bin/codex'],
  // `codex` typed into Terminal.
  [500, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'],
  [501, 500, 'login'],
  [502, 501, '-zsh'],
  [503, 502, '/opt/homebrew/bin/codex'],
  // An editor's extension: its Codex is started by a helper app inside the editor's bundle.
  [600, 1, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'],
  [601, 600, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'],
  [602, 601, '/Users/test/.vscode/extensions/openai.chatgpt/bin/codex'],
  // Codex in a tmux pane: the trail ends at a shell under tmux's own server, with no app above it.
  [700, 1, 'tmux'],
  [701, 700, '-zsh'],
  [702, 701, 'codex'],
  // A Codex whose parent is gone.
  [800, 1, '/opt/homebrew/bin/codex'],
]);

test('lsof and ps are read as they are printed', () => {
  const holders = parseLsof(lsofOf([2002, B, A], [3001, C]) + `p9\nf3\nn${DIR}/.coordination.lock\nf4\nn/Users/test/.codex/config.toml\n`);
  assert.deepEqual([...holders], [[B, [2002]], [A, [2002]], [C, [3001]]], 'only chats\' own lock files count');
  const procs = parsePs(PS);
  assert.deepEqual(procs.get(2001), { ppid: 2000, comm: '/Users/test/Applications/Some Helper.app/Contents/Resources/codex-bridge' }, 'a path with a space in it is kept whole');
  assert.equal(parseLsof('').size, 0);
  assert.equal(parsePs('garbage\n\n').size, 0);
});

test('a holder is named after the first app you can see above it, past helpers and bridges', () => {
  const procs = parsePs(PS);
  assert.deepEqual(appOf(2002, procs, { ownPid: CANOPY }), { own: false, app: 'the Codex app' }, 'Codex inside ChatGPT.app, started by a bridge inside another app');
  assert.deepEqual(appOf(503, procs, { ownPid: CANOPY }), { own: false, app: 'Terminal' });
  assert.deepEqual(appOf(602, procs, { ownPid: CANOPY }), { own: false, app: 'Visual Studio Code' }, 'the helper app inside the bundle is passed by');
  assert.deepEqual(appOf(702, procs, { ownPid: CANOPY }), { own: false, app: 'a terminal' });
  assert.deepEqual(appOf(800, procs, { ownPid: CANOPY }), { own: false, app: 'another app' });
  assert.deepEqual(appOf(3001, procs, { ownPid: CANOPY }), { own: true, app: null }, 'started by Canopy: not elsewhere');
  assert.deepEqual(appOf(3001, procs, { ownPid: 4242 }), { own: false, app: 'another Canopy window' }, 'started by a Canopy that is not this one');
  assert.equal(appOf(1, procs).app, 'another app');
  assert.equal(appOf(99999, procs).app, 'another app', 'a process nobody listed');
  const loop = parsePs(psOf([[10, 11, 'a'], [11, 10, 'b']]));
  assert.equal(appOf(10, loop).app, 'another app', 'a trail that goes round ends');
});

test('held: another app\'s chats, never Canopy\'s own, never a lock file nobody has open', () => {
  // D's lock file is on disk and no process has it open, so lsof says nothing of it. 4040 ended between the two tools.
  const held = heldFrom({ lsof: lsofOf([2002, B, A], [3001, C], [4040, D]), ps: PS, ownPid: CANOPY });
  assert.deepEqual([...held], [[B, { app: 'the Codex app', pid: 2002 }], [A, { app: 'the Codex app', pid: 2002 }]]);
  // Two processes with one chat's file open: when one of them is Canopy's, the chat is open here.
  assert.equal(heldFrom({ lsof: lsofOf([503, C], [3001, C]), ps: PS, ownPid: CANOPY }).size, 0);
  // Read by something that is not that Canopy, its chat is held too.
  assert.equal(heldFrom({ lsof: lsofOf([3001, C]), ps: PS, ownPid: 4242 }).get(C).app, 'another Canopy window');
  assert.equal(heldFrom({ lsof: 'not lsof', ps: null }).size, 0);
  assert.equal(heldFrom().size, 0);
});

test('the words', () => {
  assert.equal(heldLine('the Codex app'), 'Open in the Codex app');
  assert.equal(heldText('the Codex app'), 'This chat is open in the Codex app. Close it there to continue here.');
  assert.equal(heldText('Terminal'), 'This chat is open in Terminal. Close it there to continue here.');
  assert.equal(heldText(null), 'This chat is open in another app. Close it there to continue here.');
});

// A CodexHeld over made-up tools: `files` is the lock folder, `lsof` and `ps` what the tools print.
function make(world, opts = {}) {
  const calls = [];
  const changes = [];
  const watchers = [];
  const h = new CodexHeld({
    dir: DIR, ownPid: CANOPY, platform: 'darwin',
    installed: () => world.installed !== false,
    list: async () => { if (world.files === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return world.files; },
    run: async (cmd, args) => { calls.push([cmd.split('/').pop(), ...args]); if (world.fail) throw new Error('boom'); return cmd.endsWith('lsof') ? world.lsof : world.ps; },
    watch: (dir, _o, cb) => { if (world.files === null) throw new Error('ENOENT'); const w = { dir, cb, closed: false, close() { w.closed = true; }, on() {} }; watchers.push(w); return w; },
    alive: (pid) => !(world.dead ?? []).includes(pid),
    onChange: (held) => changes.push(held),
    timings: { debounce: 5, tick: 10, recheckEvery: 1000 },
    ...opts,
  });
  return { h, calls, changes, watchers };
}
const lockFiles = (...ids) => ['.coordination.lock', ...ids.map((id) => `${id}.lock`)];

test('one lsof and one ps a read, and the window is told only when something changed', async () => {
  const world = { files: lockFiles(A, B, C, D), lsof: lsofOf([2002, B, A], [3001, C]), ps: PS };
  const { h, calls, changes } = make(world);
  assert.equal(h.by(A), null, 'nothing is known before the first read');
  assert.equal(await h.refresh(), true);
  assert.deepEqual(calls, [['lsof', '-F', 'pn', '-c', 'codex', '-a', '+D', DIR], ['ps', '-axo', 'pid=,ppid=,comm=']]);
  assert.deepEqual(h.by(A), { app: 'the Codex app', pid: 2002 });
  assert.equal(h.by(C), null, 'Canopy\'s own chat');
  assert.equal(h.by(D), null, 'a lock file nobody has open');
  assert.deepEqual(changes, [{
    [B]: { app: 'the Codex app', line: 'Open in the Codex app', text: 'This chat is open in the Codex app. Close it there to continue here.' },
    [A]: { app: 'the Codex app', line: 'Open in the Codex app', text: 'This chat is open in the Codex app. Close it there to continue here.' },
  }]);
  assert.equal(await h.refresh(), false, 'the same again is not a change');
  assert.equal(changes.length, 1);
  // The chat was closed in the Codex app: its lock file stays, and nobody has it open.
  world.lsof = lsofOf([2002, B], [3001, C]);
  assert.equal(await h.refresh(), true);
  assert.equal(h.by(A), null);
  assert.deepEqual(Object.keys(changes.at(-1)), [B]);
  h.stop();
});

test('nothing is run when there is nothing to ask about', async () => {
  for (const world of [{ files: ['.coordination.lock'] }, { files: [] }, { files: null }, { files: lockFiles(A), installed: false }]) {
    const { h, calls, changes } = make({ lsof: lsofOf([2002, A]), ps: PS, ...world });
    assert.equal(await h.refresh(), false);
    assert.deepEqual(calls, [], JSON.stringify(world));
    assert.deepEqual(changes, []);
    h.stop();
  }
  // Not a Mac: no lsof to ask in this way.
  const { h, calls } = make({ files: lockFiles(A), lsof: lsofOf([2002, A]), ps: PS }, { platform: 'linux' });
  await h.refresh();
  assert.deepEqual(calls, []);
  h.stop();
  // Lock files and no holder: lsof is asked, ps is not.
  const quiet = make({ files: lockFiles(A), lsof: '', ps: PS });
  await quiet.h.refresh();
  assert.deepEqual(quiet.calls.map((c) => c[0]), ['lsof']);
  quiet.h.stop();
});

test('a tool that fails changes nothing and throws nothing', async () => {
  const world = { files: lockFiles(A), lsof: lsofOf([2002, A]), ps: PS };
  const { h, changes } = make(world);
  await h.refresh();
  assert.equal(h.by(A).app, 'the Codex app');
  world.fail = true; // the tool throws
  assert.equal(await h.refresh(), false);
  assert.equal(h.by(A).app, 'the Codex app', 'what was known is kept');
  world.fail = false; world.lsof = null; // the tool could not be run, or took too long
  assert.equal(await h.refresh(), false);
  assert.equal(h.by(A).app, 'the Codex app', 'no answer is not "nobody has it"');
  world.lsof = lsofOf([2002, A]);
  assert.equal(changes.length, 1);
  await h.fresh({ maxAgeMs: 0 });
  h.stop();
  assert.equal(await h.refresh(), false, 'stopped: nothing more is read');
});

test('the lock folder is watched, and a burst of changes is one read', async () => {
  const world = { files: lockFiles(A), lsof: '', ps: PS };
  const { h, calls, changes, watchers } = make(world);
  h.start();
  await sleep(30);
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].dir, DIR);
  const before = calls.length;
  world.lsof = lsofOf([2002, A]);
  for (let i = 0; i < 5; i++) watchers[0].cb('rename', `${A}.lock`);
  await sleep(40);
  assert.equal(calls.filter((c) => c[0] === 'lsof').length - before, 1, 'five changes, one read');
  assert.equal(Object.keys(changes.at(-1))[0], A);
  h.stop();
  assert.equal(watchers[0].closed, true);
});

test('a holder that is gone is noticed without anything changing in the folder', async () => {
  const world = { files: lockFiles(A), lsof: lsofOf([2002, A]), ps: PS };
  const { h, changes } = make(world);
  await h.refresh();
  assert.equal(h.by(A).app, 'the Codex app');
  await sleep(35);
  assert.equal(changes.length, 1, 'while its holder lives, nothing is read again');
  world.dead = [2002]; world.lsof = ''; // the Codex app was quit: the lock file stays where it is
  await sleep(50);
  assert.equal(h.by(A), null);
  assert.deepEqual(changes.at(-1), {});
  h.stop();
});

test('asked wide once, every process is asked about from then on', async () => {
  const world = { files: lockFiles(A), lsof: lsofOf([2002, A]), ps: PS };
  const { h, calls } = make(world);
  await h.refresh({ wide: true });
  await h.refresh();
  assert.deepEqual(calls.filter((c) => c[0] === 'lsof'), [['lsof', '-F', 'pn', '+D', DIR], ['lsof', '-F', 'pn', '+D', DIR]]);
  h.stop();
});

test('fresh: a read just done is not done again, and a slow one is not waited for', async () => {
  const world = { files: lockFiles(A), lsof: lsofOf([2002, A]), ps: PS };
  const { h, calls } = make(world);
  await h.fresh();
  await h.fresh();
  assert.equal(calls.filter((c) => c[0] === 'lsof').length, 1);
  const slow = make(world, { run: () => new Promise(() => {}) });
  const at = Date.now();
  await slow.h.fresh({ waitMs: 20 });
  assert.ok(Date.now() - at < 500);
  assert.equal(slow.h.by(A), null);
  slow.h.stop(); h.stop();
});

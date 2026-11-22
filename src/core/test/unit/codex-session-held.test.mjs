// A Codex chat that another app has open (Codex lets one process write a chat at a time): no process is started for
// it, a turn that runs into it says so in one plain sentence, and what Codex wrote to its error output is shown
// without colour codes or its warning about the user's config. Driven by the stand-in app-server: no Codex runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFakeCodex } from '../fake-codex.mjs';
import { sleep, watch, within } from '../helpers.mjs';
import { CodexSession } from '../../codex-session.mjs';
import { shownStderr } from '../../codex-host.mjs';
import { ChatHost } from '../../../chats.mjs';
import { heldText } from '../../../codex-held.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-held-')));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const CHAT = '01a1f000-0000-7000-8000-00000000000a';
const IN_THE_APP = 'This chat is open in the Codex app. Close it there to continue here.';
const ELSEWHERE = 'This chat is open in another app. Close it there to continue here.';
// What Codex 0.169 wrote when it refused the chat, colour codes and all (from a real log).
const E = '\u001b';
const REFUSED = `${E}[2m2026-11-17T17:43:27.690951Z${E}[0m ${E}[31mERROR${E}[0m ${E}[2mcodex_app_server${E}[0m${E}[2m:${E}[0m Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n`
  + '  user (/Users/test/.codex/config.toml): `mcp` is ignored.\n'
  + `${E}[2m2026-11-17T17:43:27.775376Z${E}[0m ${E}[31mERROR${E}[0m ${E}[2mcodex_core::session::session${E}[0m${E}[2m:${E}[0m failed to initialize thread persistence: thread-store conflict: thread ${CHAT} already has an active writer\n`;

const open = [];
const fakes = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 50 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
  assert.equal(fakes.splice(0).flatMap((f) => f.alive()).length, 0, 'every process a session started is gone once it is disposed');
});

function make(opts = {}, script = {}) {
  const fake = createFakeCodex({ known: [CHAT], ...script });
  fakes.push(fake);
  const s = new CodexSession({ cwd: work, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: root }, spawnFn: fake.spawnFn, resume: CHAT, ...opts, timeouts: { restart: 15, ...opts.timeouts } });
  open.push(s);
  return { s, fake, w: watch(s) };
}

test('a chat another app has open: no process is started, warming up says nothing, and a message says where it is open', async () => {
  let held = IN_THE_APP;
  const asked = [];
  const { s, fake, w } = make({ heldElsewhere: (id, refused) => { asked.push([id, refused]); return held; } });
  const warm = await s.warm();
  assert.deepEqual([warm.ok, warm.code, warm.message], [false, 'held-elsewhere', IN_THE_APP]);
  assert.equal(fake.spawns.length, 0, 'no Codex was started to be refused');
  assert.equal(w.all((e) => e.kind === 'notice' || e.kind === 'error').length, 0, 'the window says it in place of the message box');
  assert.deepEqual(asked[0], [CHAT, false]);

  s.send('are you there?');
  const err = await w.waitFor('error', { ms: 2000 });
  assert.equal(err.code, 'held-elsewhere');
  assert.equal(err.message, IN_THE_APP);
  assert.equal(err.stderr, undefined, 'no log under it');
  assert.equal(err.prompts[0].text, 'are you there?', 'the message is handed back');
  assert.equal(fake.spawns.length, 0);
  await w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 2000 });

  // Closed in the other app: the same chat starts here as any other.
  held = null;
  const from = w.events.length;
  s.send('and now?');
  await w.waitFor('turn-end', { ms: 4000, from });
  assert.equal(fake.spawns.length, 1);
  assert.equal(s.sessionId, CHAT);
});

test('a new chat is nobody else\'s: the host is not asked, and it starts', async () => {
  const asked = [];
  const { s, fake } = make({ resume: null, heldElsewhere: (id) => { asked.push(id); return IN_THE_APP; } });
  assert.equal((await s.warm()).ok, true);
  assert.equal(fake.spawns.length, 1);
  assert.deepEqual(asked, []);
});

test('Codex itself refuses the chat (another app took it first): the same plain sentence, not its log', async () => {
  const asked = [];
  const { s, w } = make({ heldElsewhere: (id, refused) => { asked.push([id, refused]); return refused ? heldText(null) : null; } }, {
    errors: { 'thread/resume': (params, child) => { child.stderr.write(REFUSED); return { message: `thread-store conflict: thread ${CHAT} already has an active writer` }; } },
  });
  s.send('hello');
  const err = await w.waitFor('error', { ms: 3000 });
  assert.equal(err.code, 'held-elsewhere');
  assert.equal(err.message, ELSEWHERE);
  assert.equal(err.stderr, undefined);
  assert.deepEqual(asked, [[CHAT, false], [CHAT, true]], 'the host hears that Codex refused, so it can look for who has the chat');
});

test('without a host to ask, a refusal still reads as one sentence', async () => {
  const { s, w } = make({}, { errors: { 'thread/resume': { message: `Failed to create session: thread-store conflict: thread ${CHAT} already has an active writer` } } });
  s.send('hello');
  const err = await w.waitFor('error', { ms: 3000 });
  assert.deepEqual([err.code, err.message, err.stderr], ['held-elsewhere', ELSEWHERE, undefined]);
});

test('any other failed start shows what Codex wrote without colour codes or its config warning', async () => {
  const { s, w } = make({}, {
    errors: { 'thread/resume': (params, child) => { child.stderr.write(REFUSED.replace('already has an active writer', 'is not readable')); return { message: 'could not open the thread' }; } },
  });
  s.send('hello');
  const err = await w.waitFor('error', { ms: 3000 });
  assert.equal(err.code, 'launch-failed');
  assert.equal(err.message, 'Codex could not start: could not open the thread');
  assert.equal(err.stderr.includes(E), false, 'no colour codes');
  assert.doesNotMatch(err.stderr, /unrecognized configuration|config\.toml|is ignored/);
  assert.match(err.stderr, /^2026-11-17T17:43:27\.775376Z ERROR codex_core::session::session: failed to initialize thread persistence: .* is not readable\n?$/);
});

test('shownStderr: colour codes go, the config warning goes with the lines under it, everything else stays', () => {
  assert.equal(shownStderr(REFUSED), `2026-11-17T17:43:27.775376Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread ${CHAT} already has an active writer\n`);
  assert.equal(shownStderr('WARN Codex is ignoring 2 unrecognized configuration settings.\n  user (a): `x` is ignored.\n  user (a): `y` is ignored.\nreal trouble\n  with a detail\n'), 'real trouble\n  with a detail\n');
  assert.equal(shownStderr('plain\n  indented, and not under a warning\n'), 'plain\n  indented, and not under a warning\n');
  assert.equal(shownStderr(undefined), '');
});

test('the sidebar: a chat held elsewhere is not a chat that went wrong', async () => {
  const fake = createFakeCodex({ known: [CHAT] });
  fakes.push(fake);
  const sent = [];
  const host = new ChatHost({
    create: (o) => new CodexSession({ cwd: o.cwd, resume: o.resume, codexPath: '/fake/codex', env: { PATH: '/usr/bin:/bin', HOME: root }, spawnFn: fake.spawnFn, heldElsewhere: () => IN_THE_APP }),
    send: (channel, payload) => sent.push([channel, payload]),
  });
  const { session } = await host.open(work, CHAT, { engine: 'codex' });
  session.send('hello');
  for (let i = 0; i < 200 && !sent.some(([c, p]) => c === 'session:event' && p.kind === 'error'); i++) await sleep(5);
  const row = host.statusList().find((r) => r.sessionId === CHAT);
  assert.equal(row.failed, false, 'no dot for it');
  assert.notEqual(row.line, IN_THE_APP, 'and its line is not an error: the window writes where it is open');
  assert.equal(fake.spawns.length, 0);
  await within(host.closeAll(), 4000, 'close');
});

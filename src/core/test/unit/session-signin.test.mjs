// A signed-out login, a real chat, and the sign-in that brings it back: Session, the accounts registry and
// signin-ipc.mjs together, as main.mjs wires them. Claude Code is the scripted fake of the SDK's query()
// (fake-query.mjs), its sign-in is a terminal that records, and `claude auth status` is a function: no claude
// process is started, nobody is signed in or out, and no login is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake } from '../fake-query.mjs';
import { core, watch, within } from '../helpers.mjs';
import { registerSignIn } from '../../../signin-ipc.mjs';

const S = await core('session.mjs');
const A = await core('accounts.mjs');
const C = await core('accounts-claude.mjs');
const missing = [S, A, C].find((m) => m.__missing)?.__missing ?? false;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-session-signin-'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8' });
const IN = Object.freeze({ loggedIn: true, method: 'claude.ai', provider: 'firstParty', subscriptionType: 'max', email: 'tester@example.com', configDir: path.join(os.homedir(), '.claude') });
const OUT = Object.freeze({ loggedIn: false });
const entry = (over = {}) => ({ id: 'claude-default', engine: 'claude', kind: 'plan', dir: null, email: 'tester@example.com', plan: 'max', lastOkAt: 1, state: 'signed-out', ...over });

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } }
});
const idle = (w, from = 0) => w.waitFor((e) => e.kind === 'busy' && e.busy === false, { ms: 5000, from, label: 'busy:false' });
const until = async (ok, label) => { for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 5)); } assert.fail(`timed out waiting for ${label}`); };

// main.mjs in small: the registry, the sign-in wiring, and chats created the way chatHost().create does.
function app(saved) {
  const box = { answer: OUT };
  const tool = { path: '/usr/bin/true', env: { ...ENV } };
  const ask = async () => box.answer;
  const accounts = new A.Accounts({ engines: { claude: C.claudeAccounts({ tool: () => tool, ask }) }, load: () => saved });
  const channels = new Map(), states = [], ptys = [];
  const shown = [], all = [];
  const signIn = registerSignIn((channel, fn) => channels.set(channel, fn), {
    accounts, claude: () => tool, ask,
    spawn: (file, args, opts) => { const p = { file, args, opts, onData() {}, onExit(cb) { p.exit = cb; }, write() {}, resize() {}, kill() {} }; ptys.push(p); return p; },
    on: () => {}, send: (channel, payload) => { if (channel === 'signin:state') states.push(payload); },
    sessions: () => ({ all, shown }),
  });
  const chat = ({ onScreen = true } = {}) => {
    const fake = createFake({});
    const account = accounts.pin('claude');
    const s = new S.Session({
      cwd: work, claudePath: tool.path, env: () => accounts.envFor('claude', { account }), account, trusted: true, personalMemory: false, queryFn: fake.queryFn,
      onAccount: (reported, id) => accounts.reported('claude', id, reported),
    });
    open.push(s); all.push(s);
    if (onScreen) shown.push(s);
    return { s, fake, w: watch(s) };
  };
  // The whole sign-in, as the window drives it: begin, attach a terminal, Claude Code exits 0 and confirms.
  const signInNow = async (accountId = 'claude-default') => {
    const r = await channels.get('signin:begin')({ engine: 'claude', accountId });
    assert.equal(r.ok, true);
    await channels.get('signin:attach')(r.id, 80, 24);
    box.answer = IN;
    ptys.at(-1).exit({ exitCode: 0 });
    await until(() => states.at(-1)?.phase === 'done', 'the sign-in to be confirmed');
  };
  return { accounts, signIn, chat, signInNow, box, states, ptys };
}

test('a chat on a chosen account that is signed out refuses its start and hands the message back; signed in again, it starts', { skip: missing, timeout: 30000 }, async () => {
  const { accounts, signIn, chat, signInNow } = app({ v: 1, active: { claude: 'claude-default' }, list: [entry()] });
  const { s, fake, w } = chat();
  assert.equal(signIn.canWarm(s), false, 'not started ahead of its first message');

  const mark = w.mark();
  const r = s.send('split the tokenizer');
  assert.deepEqual([r.ok, r.code, fake.starts], [false, 'account-signed-out', 0], 'nothing was launched on another login');
  const err = w.find('error', mark);
  assert.deepEqual([err.code, err.message, err.recoverable], ['account-signed-out', 'Claude Code could not start: Max is signed out.', false]);
  assert.deepEqual(err.prompts.map((p) => p.text), ['split the tokenizer'], 'the message comes back with the refusal');
  assert.equal(s.busy, false);

  await signInNow();
  assert.equal(accounts.get('claude', 'claude-default').state, 'ok');
  await until(() => fake.starts === 1, 'the chat on screen to start on the login');
  const again = w.mark();
  assert.equal(s.send('split the tokenizer').ok, true, 'and the same message goes');
  await idle(w, again);
  assert.equal(fake.starts, 1);
});

test('with nothing chosen a signed-out login is not started early; after the sign-in a running chat restarts and an idle one starts', { skip: missing, timeout: 30000 }, async () => {
  const { accounts, signIn, chat, signInNow } = app({ v: 1, active: { claude: null }, list: [entry({ state: 'ok' })] });
  // Two chats from before the login went: one with its process up, one that never started.
  const live = chat(), fresh = chat(), background = chat({ onScreen: false });
  live.s.send('hello');
  await idle(live.w);
  background.s.send('hello');
  await idle(background.w);
  assert.deepEqual([live.fake.starts, fresh.fake.starts, background.fake.starts], [1, 0, 1]);

  await accounts.refresh(); // Claude Code says it is signed out
  assert.equal(accounts.get('claude').state, 'signed-out');
  assert.equal(signIn.canWarm(fresh.s), false, 'the login Claude Code finds on its own is gone: not started ahead');
  // Nothing was chosen, so Claude Code is still launched as it finds itself: holding a message is the window's job.
  assert.doesNotThrow(() => accounts.envFor('claude', { account: fresh.s.accountId }));

  await signInNow();
  await until(() => live.fake.starts === 2 && fresh.fake.starts === 1, 'the chats on screen to pick the login up');
  assert.ok(!background.s.q, 'the one in the background was only stopped');
  assert.equal(background.fake.starts, 1);
  const mark = background.w.mark();
  assert.equal(background.s.send('and you').ok, true);
  await idle(background.w, mark);
  assert.equal(background.fake.starts, 2, 'it starts again on its next message');
});

// codex-account-home.mjs: the folder a second Codex login lives in. Its links, the databases that must not be in
// it, and its removal.
// Everything happens in throwaway folders: "the user's Codex folder" is a made-up one under the temp folder, filled
// with the kinds of entries the real one has (a login file and its locks, an index of chat names, databases, caches,
// the Codex app's own folders). No real Codex folder or login is read or written, and nothing is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import * as H from '../../../codex-account-home.mjs';
import { CODEX_PRIVATE as PRIVATE, CODEX_SHARED as SHARED, fakeCodexMac, isLinkTo, names, put, snapshot } from '../account-world.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-codex-account-home-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Everything below stays under the temp folder: no path here is built from the home folder.
assert.ok(tmp.startsWith(fs.realpathSync(os.tmpdir())) && !tmp.includes('.codex') && !tmp.includes('.canopy'));

let seq = 0;
function world(opts) {
  const W = fakeCodexMac(path.join(tmp, `w${++seq}`), opts);
  const dir = (id = 'codex-a1b2c3d4') => path.join(W.root, id);
  return { ...W, dir, at: (id) => ({ dir: dir(id), root: W.root, baseHome: W.base }) };
}
const without = (...gone) => Object.fromEntries(Object.entries(SHARED).filter(([rel]) => !gone.some((g) => rel === g || rel.startsWith(`${g}/`))));
const ALL = ['AGENTS.md', 'archived_sessions', 'config.toml', 'mcp-oauth-locks', 'memories', 'memories.lock', 'rules', 'sessions', 'skills', 'thread-writer-locks'];

// ---- where account folders are ----

test('Codex’s account folders are kept where Claude’s are, and a throwaway copy keeps its own', () => {
  assert.equal(H.accountsRoot({ home: '/Users/someone' }), '/Users/someone/.canopy/accounts');
  assert.equal(H.accountsRoot({ home: '/Users/someone', userData: '/tmp/throwaway' }), '/tmp/throwaway/accounts', 'never the real ones');
});

// ---- links ----

test('the allowlist holds the user’s chats, setup and memories: no dotfile, no login file, nothing Codex keeps per login', () => {
  assert.deepEqual([...H.LINKS].sort(), [
    'AGENTS.md', 'archived_sessions', 'config.toml', 'mcp-oauth-locks', 'memories', 'memories.lock', 'memories_extensions', 'memories_v2', 'memories_v2.lock',
    'rules', 'sessions', 'skills', 'thread-writer-locks',
  ]);
  assert.ok(Object.isFrozen(H.LINKS));
  assert.deepEqual([...H.HISTORY], ['sessions', 'archived_sessions']);
  for (const name of H.LINKS) assert.ok(!name.startsWith('.') && !name.includes('/') && !name.includes('\\'), name);
  // The login and what goes with it, by name: never on the list, whatever else changes.
  for (const never of ['auth.json', 'auth.lock', 'auth.json.lock', 'secrets', 'session_index.jsonl', 'history.jsonl', 'installation_id', 'cache', 'log', 'logs', 'plugins', 'models_cache.json', '.credentials.json']) {
    assert.ok(!H.LINKS.includes(never), `${never} must never be linked`);
  }
  // (`mcp-oauth-locks` holds lock files for connector sign-ins, which Codex keeps in the Keychain, not there.)
  assert.ok(!H.LINKS.some((n) => /^auth|secret|token|credential|sqlite/i.test(n)));
  const top = new Set(PRIVATE.map((rel) => rel.split('/')[0]));
  for (const name of H.LINKS) assert.ok(!top.has(name), `${name} is private to a login`);
});

test('a new account folder holds links to the user’s chats and setup, and nothing else', () => {
  const W = world();
  const before = snapshot(W.base);
  const r = H.create(W.at());
  assert.deepEqual([r.ok, r.code], [true, null]);
  const dir = W.dir();
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700, 'the folder is the user’s alone');
  assert.equal(fs.lstatSync(W.root).mode & 0o777, 0o700);

  const made = names(dir);
  for (const name of made) {
    assert.ok(H.LINKS.includes(name), `${name} is not on the list`);
    assert.ok(isLinkTo(path.join(dir, name), path.join(W.base, name)), `${name} is a link to the user's own`);
  }
  assert.deepEqual(made, ALL);
  assert.deepEqual(r.waiting, ['memories_v2', 'memories_extensions', 'memories_v2.lock'], 'what the user does not have yet gets no link');
  assert.deepEqual([...r.linked].sort(), made);
  assert.deepEqual([r.own, r.displaced, r.failed, r.wrong, r.databases], [[], [], [], [], []]);

  // The chats, settings and skills are the user's own files, seen through the links.
  assert.equal(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), SHARED['config.toml']);
  assert.equal(fs.readdirSync(path.join(dir, 'sessions/2026/11/16')).length, 1);
  assert.deepEqual(snapshot(W.base), before, 'nothing was created, changed or deleted in the user’s Codex folder');
});

test('the login file, its locks, the index of chat names, the databases, caches, logs and plugins are never linked', () => {
  const W = world();
  H.create(W.at());
  H.relink(W.at());
  const dir = W.dir();
  for (const rel of PRIVATE) {
    const name = rel.split('/')[0];
    assert.equal(fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }), undefined, `${name} must not be in an account folder`);
  }
  assert.ok(names(dir).every((n) => !n.startsWith('.')), 'no dotfile of any kind');
  for (const name of names(dir)) assert.equal(fs.readlinkSync(path.join(dir, name)), path.join(W.base, name), 'by exact name, to exactly that name');
  // And nothing private can be read through the folder.
  for (const p of ['auth.json', 'auth.lock', 'auth.json.lock', 'secrets', 'session_index.jsonl', 'history.jsonl', 'installation_id', 'state_5.sqlite', 'plugins', 'cache', 'log']) assert.ok(!fs.existsSync(path.join(dir, p)), p);
});

test('linking is idempotent: a second pass changes nothing', () => {
  const W = world();
  H.create(W.at());
  const first = snapshot(W.dir());
  const inodes = names(W.dir()).map((n) => fs.lstatSync(path.join(W.dir(), n)).ino);
  for (let i = 0; i < 3; i++) {
    const r = i === 1 ? H.create(W.at()) : H.relink(W.at());
    assert.equal(r.ok, true);
    assert.deepEqual([r.made, r.displaced, r.failed], [[], [], []], 'nothing was made again');
    assert.equal(r.linked.length, ALL.length);
  }
  assert.deepEqual(snapshot(W.dir()), first);
  assert.deepEqual(names(W.dir()).map((n) => fs.lstatSync(path.join(W.dir(), n)).ino), inodes, 'the links are the very same ones');
  assert.deepEqual([H.health(W.at()).ok, H.health(W.at()).wrong], [true, []]);
});

test('relink puts back what went missing or wrong, inside the account folder only', () => {
  const W = world();
  H.create(W.at());
  const dir = W.dir();
  const canary = put(path.join(W.outside, 'elsewhere', 'keep.md'), 'not Canopy’s');
  fs.unlinkSync(path.join(dir, 'sessions'));                                   // a link was deleted
  fs.unlinkSync(path.join(dir, 'skills'));
  fs.symlinkSync(path.join(W.outside, 'elsewhere'), path.join(dir, 'skills')); // a link points somewhere else
  fs.unlinkSync(path.join(dir, 'thread-writer-locks'));
  fs.mkdirSync(path.join(dir, 'thread-writer-locks'));                         // an empty folder took a link's place
  const before = snapshot(W.base);

  const h = H.health(W.at());
  assert.deepEqual([h.ok, h.code, [...h.wrong].sort()], [false, 'unlinked', ['sessions', 'skills', 'thread-writer-locks']]);
  assert.deepEqual(snapshot(W.base), before, 'looking changes nothing');
  const r = H.relink(W.at());
  assert.equal(r.ok, true);
  assert.deepEqual([...r.made].sort(), ['sessions', 'skills', 'thread-writer-locks']);
  for (const name of r.made) assert.ok(isLinkTo(path.join(dir, name), path.join(W.base, name)), name);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'not Canopy’s', 'what the stray link pointed at is untouched');
  assert.deepEqual(names(path.join(W.outside, 'elsewhere')), ['keep.md']);
  assert.deepEqual(snapshot(W.base), before);
  assert.equal(H.health(W.at()).ok, true);
});

test('without the user’s chats or the writer locks there is nothing to make, and an account that loses them is not fit', () => {
  // A Codex that has never run a chat: no folder is made at all.
  for (const [gone, code] of [['sessions', 'no-history'], ['thread-writer-locks', 'no-locks']]) {
    const W = world({ fill: without(gone) });
    const r = H.create(W.at());
    assert.deepEqual([r.ok, r.code], [false, code]);
    assert.ok(!fs.existsSync(W.root), 'not even the accounts root');
  }
  assert.equal(H.create({ ...world().at(), baseHome: path.join(tmp, 'not-there') }).code, 'no-base');

  // They go missing later: the link is taken away rather than left pointing nowhere (Codex will not open a chat
  // through one), and the folder says why it is not fit. They come back: so does the link.
  for (const [gone, code] of [['sessions', 'no-history'], ['thread-writer-locks', 'no-locks']]) {
    const W = world();
    H.create(W.at());
    fs.renameSync(path.join(W.base, gone), path.join(W.outside, gone));
    assert.deepEqual([H.health(W.at()).ok, H.health(W.at()).code], [false, 'unlinked']);
    const r = H.relink(W.at());
    assert.deepEqual([r.ok, r.code, r.waiting.includes(gone)], [false, code, true]);
    assert.equal(fs.lstatSync(path.join(W.dir(), gone), { throwIfNoEntry: false }), undefined, 'no link to nowhere');
    assert.deepEqual([H.health(W.at()).ok, H.health(W.at()).code], [false, code]);
    fs.renameSync(path.join(W.outside, gone), path.join(W.base, gone));
    assert.equal(H.relink(W.at()).ok, true);
    assert.ok(isLinkTo(path.join(W.dir(), gone), path.join(W.base, gone)));
  }
});

test('the files of the user’s setup and the archive are linked before the user has them; the rest once they do', () => {
  const W = world({ fill: without('archived_sessions', 'config.toml', 'AGENTS.md', 'mcp-oauth-locks', 'skills', 'rules', 'memories', 'memories.lock') });
  const before = snapshot(W.base);
  const r = H.create(W.at());
  assert.equal(r.ok, true);
  const dir = W.dir();
  assert.deepEqual(names(dir), ['AGENTS.md', 'archived_sessions', 'config.toml', 'sessions', 'thread-writer-locks']);
  // They read as "not there", exactly as in the user's own folder: nothing was made for them to point at.
  for (const name of ['AGENTS.md', 'archived_sessions', 'config.toml']) assert.ok(fs.lstatSync(path.join(dir, name)).isSymbolicLink() && !fs.existsSync(path.join(dir, name)), name);
  assert.deepEqual(r.waiting, ['mcp-oauth-locks', 'skills', 'rules', 'memories', 'memories_v2', 'memories_extensions', 'memories.lock', 'memories_v2.lock']);
  assert.deepEqual(snapshot(W.base), before);

  // The user's folder gains them (Codex made its skills folder, a connector was signed in to): linked at the next look.
  put(path.join(W.base, 'skills/tidy/SKILL.md'), 'x');
  put(path.join(W.base, 'mcp-oauth-locks/a.lock'), '');
  put(path.join(W.base, 'memories_v2/MEMORY.md'), 'm');
  put(path.join(W.base, 'memories_v2.lock'), '');
  assert.deepEqual(H.health(W.at()).wrong, ['mcp-oauth-locks', 'skills', 'memories_v2', 'memories_v2.lock']);
  const again = H.relink(W.at());
  assert.deepEqual([again.ok, [...again.made].sort()], [true, ['mcp-oauth-locks', 'memories_v2', 'memories_v2.lock', 'skills']]);
  // And one that goes again is unlinked again, not left dangling.
  fs.rmSync(path.join(W.base, 'skills'), { recursive: true });
  assert.equal(H.relink(W.at()).ok, true);
  assert.equal(fs.lstatSync(path.join(dir, 'skills'), { throwIfNoEntry: false }), undefined);
});

test('a copy Codex made where a link belongs: setup is moved aside for the link, memories stay, chats block the folder', () => {
  const W = world();
  H.create(W.at());
  const dir = W.dir();
  const before = snapshot(W.base);
  // Codex replaced the settings link with a file of its own, and made a skills folder before the link was there.
  fs.unlinkSync(path.join(dir, 'config.toml'));
  put(path.join(dir, 'config.toml'), 'model = "written-here"\n');
  fs.unlinkSync(path.join(dir, 'skills'));
  put(path.join(dir, 'skills/.system/a.md'), 'system skill');
  const r = H.relink(W.at());
  assert.deepEqual([r.ok, [...r.displaced].sort()], [true, ['config.toml', 'skills']]);
  assert.ok(isLinkTo(path.join(dir, 'config.toml'), path.join(W.base, 'config.toml')));
  const kept = names(path.join(dir, '.kept'));
  assert.deepEqual(kept.map((n) => n.split('.')[0]).sort(), ['config', 'skills']);
  assert.equal(fs.readFileSync(path.join(dir, '.kept', kept.find((n) => n.startsWith('config.toml'))), 'utf8'), 'model = "written-here"\n', 'moved aside, never deleted and never merged');
  assert.deepEqual(snapshot(W.base), before, 'the user’s own settings are as they were');

  // Memories the account's chats made while the user had none stay with the account.
  const M = world({ fill: without('memories', 'memories.lock') });
  H.create(M.at());
  put(path.join(M.dir(), 'memories/MEMORY.md'), 'made on this login');
  put(path.join(M.base, 'memories/MEMORY.md'), 'the user’s own, later');
  const m = H.relink(M.at());
  assert.deepEqual([m.ok, m.own, m.displaced], [true, ['memories'], []]);
  assert.equal(fs.readFileSync(path.join(M.dir(), 'memories/MEMORY.md'), 'utf8'), 'made on this login');

  // A real folder of chats where the link belongs is the only copy of those chats: never moved, never linked over,
  // and the folder is not launched on.
  for (const name of ['sessions', 'archived_sessions']) {
    const F = world();
    H.create(F.at());
    fs.unlinkSync(path.join(F.dir(), name));
    const chat = put(path.join(F.dir(), name, '2026/11/17/rollout-x.jsonl'), '{"only":"copy"}');
    const f = H.relink(F.at());
    assert.deepEqual([f.ok, f.code, f.own], [false, 'forked', [name]], name);
    assert.equal(fs.readFileSync(chat, 'utf8'), '{"only":"copy"}');
    assert.ok(!fs.existsSync(path.join(F.dir(), '.kept')), 'nothing was moved aside');
    assert.deepEqual([H.health(F.at()).ok, H.health(F.at()).code], [false, 'forked']);
  }
});

test('a database in an account folder means a launch kept an index of its own: the folder is not fit, and nothing is deleted', () => {
  for (const file of ['state_5.sqlite', 'thread_history_1.sqlite', 'state_6.sqlite-wal', 'goals_1.sqlite-shm', 'New.SQLITE']) {
    const W = world();
    H.create(W.at());
    assert.deepEqual(H.databases(W.dir()), []);
    put(path.join(W.dir(), file), 'SQLite format 3');
    assert.deepEqual(H.databases(W.dir()), [file]);
    for (const look of [H.health, H.relink, H.create]) {
      const r = look(W.at());
      assert.deepEqual([r.ok, r.code, r.databases], [false, 'forked', [file]], `${look.name} ${file}`);
    }
    assert.equal(fs.readFileSync(path.join(W.dir(), file), 'utf8'), 'SQLite format 3', 'left exactly where it is');
    assert.equal(H.relink(W.at()).linked.length, ALL.length, 'the links themselves are still kept right');
  }
  // What merely has the word in its name is not one, and neither is anything deeper in the folder.
  const W = world();
  H.create(W.at());
  for (const rel of ['sqlite-notes.md', 'x.sqlite.bak', '.kept/state_5.sqlite', 'tmp/a.sqlite']) put(path.join(W.dir(), rel), 'x');
  assert.deepEqual([H.databases(W.dir()), H.relink(W.at()).ok], [[], true]);
  assert.deepEqual(H.databases(path.join(tmp, 'not-there')), []);
});

test('strangers: names Codex has started to keep that Canopy does not know, and nothing it does know', () => {
  const W = world();
  assert.deepEqual(H.strangers(W.base), [], 'everything in a folder like today’s is known');
  put(path.join(W.base, 'brand-new-thing/x'), '');
  put(path.join(W.base, 'another.json'), '');
  put(path.join(W.base, '.hidden-new'), '');
  put(path.join(W.base, 'state_9.sqlite'), '');
  put(path.join(W.base, 'auth.json.lock.tmp'), '');
  assert.deepEqual(H.strangers(W.base), ['another.json', 'brand-new-thing']);
  assert.deepEqual(H.strangers(path.join(tmp, 'not-there')), []);
});

test('a folder that is not where Canopy keeps accounts is never linked, looked into or made', () => {
  const W = world();
  H.create(W.at());
  const elsewhere = put(path.join(W.outside, 'x', 'keep.md'), 'keep');
  for (const dir of [W.base, W.home, path.join(W.root, 'claude-a1b2c3d4'), path.join(W.root, 'codex-'), path.join(W.root, 'codex-a1b2c3d4', 'deeper'), path.join(W.outside, 'codex-a1b2c3d4'), `${W.root}/../accounts/CODEX-a1b2c3d4`, 'relative/codex-a1b2c3d4', null]) {
    for (const call of [H.create, H.relink, H.health]) assert.deepEqual([call({ dir, root: W.root, baseHome: W.base }).ok, call({ dir, root: W.root, baseHome: W.base }).code], [false, 'outside'], `${call.name} ${dir}`);
  }
  // A link standing where the folder should be is not a folder, wherever it leads.
  const link = path.join(W.root, 'codex-11112222');
  fs.symlinkSync(path.join(W.outside, 'x'), link);
  for (const call of [H.create, H.relink, H.health]) assert.equal(call({ dir: link, root: W.root, baseHome: W.base }).code, 'not-a-folder');
  assert.deepEqual(names(path.join(W.outside, 'x')), ['keep.md']);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'keep');
  // An accounts root inside the user's Codex folder, or around it, is refused too.
  assert.equal(H.create({ dir: path.join(W.base, 'accounts', 'codex-a1b2c3d4'), root: path.join(W.base, 'accounts'), baseHome: W.base }).code, 'outside');
  assert.equal(H.relink({ dir: W.dir('codex-99998888'), root: W.root, baseHome: W.base }).code, 'missing');
});

// ---- removing ----

// An account folder as it is after some use: Codex's own files beside the links, and a login.
function used(W, id) {
  H.create(W.at(id));
  const dir = W.dir(id);
  put(path.join(dir, 'auth.json'), '{"made-up":"login"}');
  put(path.join(dir, 'installation_id'), 'x');
  put(path.join(dir, '.tmp/a/b'), 'x');
  put(path.join(dir, 'shell_snapshots/s.sh'), 'x');
  put(path.join(dir, 'models_cache.json'), '{}');
  put(path.join(dir, '.kept/config.toml.1'), 'x');
  return dir;
}

test('remove signs the folder out, deletes what it holds, and never follows a link out of it', async () => {
  const W = world();
  const dir = used(W);
  const canary = put(path.join(W.outside, 'precious', 'keep.md'), 'keep');
  fs.symlinkSync(path.join(W.outside, 'precious'), path.join(dir, 'a-link-out'));
  fs.symlinkSync(path.join(W.outside, 'precious'), path.join(dir, '.tmp', 'deep-link-out'));
  const before = snapshot(W.base);
  const order = [];
  const r = await H.remove({
    ...W.at(),
    logout: async (o) => { order.push(['logout', o.dir, fs.existsSync(path.join(dir, 'auth.json'))]); return { ok: true }; },
    stillSignedIn: async (o) => { order.push(['asked', o.dir]); return false; },
    referenced: async (o) => { order.push(['referenced', o.dir, names(dir)]); return false; },
  });
  assert.deepEqual(r, { ok: true, signedOut: true, kept: false });
  assert.deepEqual(order, [['logout', dir, true], ['asked', dir], ['referenced', dir, ['archived_sessions', 'sessions']]], 'signed out first, with its files still there; asked about chats once only the two links are left');
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(snapshot(W.base), before, 'the user’s Codex folder, chats and all, is exactly as it was');
  assert.equal(fs.readFileSync(canary, 'utf8'), 'keep');
  assert.deepEqual(names(path.join(W.outside, 'precious')), ['keep.md'], 'what the links pointed at was never touched');
});

test('the links to the user’s chats stay while a chat is filed under the folder, or nobody can say', async () => {
  for (const [answer, kept] of [[true, true], [null, true], [undefined, true], ['no', true], [new Error('could not ask'), true], [false, false]]) {
    const W = world();
    const dir = used(W);
    const before = snapshot(W.base);
    const r = await H.remove({ ...W.at(), logout: async () => ({ ok: true }), stillSignedIn: async () => false, referenced: async () => { if (answer instanceof Error) throw answer; return answer; } });
    assert.deepEqual(r, { ok: true, signedOut: true, kept }, String(answer));
    if (kept) {
      // What is left is a folder with the two links and nothing else: no login, nothing of Codex's.
      assert.deepEqual(names(dir), ['archived_sessions', 'sessions']);
      for (const name of names(dir)) assert.ok(isLinkTo(path.join(dir, name), path.join(W.base, name)));
      assert.equal(H.isHusk(W.at()), true);
      assert.equal(fs.readdirSync(path.join(dir, 'sessions/2026/11/16')).length, 1, 'a chat filed under this folder is still found through it');
    } else assert.ok(!fs.existsSync(dir));
    assert.deepEqual(snapshot(W.base), before);
  }
  // No way of asking handed in: the links stay.
  const W = world();
  const dir = used(W);
  assert.deepEqual(await H.remove({ ...W.at() }), { ok: true, signedOut: null, kept: true });
  assert.deepEqual(names(dir), ['archived_sessions', 'sessions']);

  // Later, when no chat is filed there any more, what was left is taken away; a folder holding anything else is not.
  assert.deepEqual(await H.dropHusk(W.at()), { ok: true });
  assert.ok(!fs.existsSync(dir));
  const L = world();
  const live = used(L);
  assert.equal(H.isHusk(L.at()), false, 'an account folder in use is not one');
  assert.deepEqual(await H.dropHusk(L.at()), { ok: false });
  assert.ok(fs.existsSync(path.join(live, 'auth.json')));
  for (const dir2 of [L.base, L.root, path.join(L.root, 'claude-a1b2c3d4'), path.join(L.outside, 'codex-a1b2c3d4')]) assert.deepEqual([H.isHusk({ dir: dir2, root: L.root, baseHome: L.base }), (await H.dropHusk({ dir: dir2, root: L.root, baseHome: L.base })).ok], [false, false], dir2);
});

test('a real folder of chats in an account folder is never deleted, even when the account is removed', async () => {
  const W = world();
  const dir = used(W);
  fs.unlinkSync(path.join(dir, 'sessions'));
  const chat = put(path.join(dir, 'sessions/2026/11/17/rollout-only-copy.jsonl'), '{"only":"copy"}');
  const r = await H.remove({ ...W.at(), logout: async () => ({ ok: true }), stillSignedIn: async () => false, referenced: async () => false });
  assert.deepEqual(r, { ok: true, signedOut: true, kept: true });
  assert.equal(fs.readFileSync(chat, 'utf8'), '{"only":"copy"}');
  assert.deepEqual(names(dir), ['archived_sessions', 'sessions'], 'the login and everything else is gone');
  assert.deepEqual([H.isHusk(W.at()), (await H.dropHusk(W.at())).ok], [false, false], 'and it is not taken away later either');
  assert.equal(fs.readFileSync(chat, 'utf8'), '{"only":"copy"}');
  // An empty one holds nothing to keep.
  const E = world();
  const empty = used(E);
  fs.unlinkSync(path.join(empty, 'archived_sessions'));
  fs.mkdirSync(path.join(empty, 'archived_sessions'));
  assert.deepEqual(await H.remove({ ...E.at(), referenced: async () => false }), { ok: true, signedOut: null, kept: false });
  assert.ok(!fs.existsSync(empty));
});

test('a folder Codex still says is signed in is kept whole; one Codex could not be asked about is deleted', async () => {
  const W = world();
  const dir = used(W);
  const before = snapshot(dir);
  assert.deepEqual(await H.remove({ ...W.at(), logout: async () => ({ ok: false }), stillSignedIn: async () => true, referenced: async () => false }), { ok: false, code: 'still-signed-in' });
  assert.deepEqual(snapshot(dir), before, 'nothing in it was touched');
  // The sign-out failed and Codex could not say afterwards: the login file goes with the folder.
  assert.deepEqual(await H.remove({ ...W.at(), logout: async () => { throw new Error('x'); }, stillSignedIn: async () => null, referenced: async () => false }), { ok: true, signedOut: null, kept: false });
  assert.ok(!fs.existsSync(dir));
});

test('remove never deletes outside the accounts root, and never points Codex at a link', async () => {
  const W = world();
  used(W);
  const precious = put(path.join(W.outside, 'precious', 'keep.md'), 'keep');
  let ran = 0;
  const hooks = { logout: async () => { ran += 1; return { ok: true }; }, stillSignedIn: async () => false, referenced: async () => false };
  for (const dir of [W.base, W.home, W.root, path.join(W.root, 'claude-a1b2c3d4'), path.join(W.outside, 'precious'), path.join(W.outside, 'codex-a1b2c3d4'), '/', null]) {
    assert.deepEqual(await H.remove({ dir, root: W.root, baseHome: W.base, ...hooks }), { ok: false, code: 'outside' }, String(dir));
  }
  assert.equal(ran, 0, 'Codex was never asked to sign out of any of them');
  // A link standing where an account folder was: the link goes, what it points at stays, and Codex is not run.
  const link = path.join(W.root, 'codex-11112222');
  fs.symlinkSync(path.join(W.outside, 'precious'), link);
  assert.deepEqual(await H.remove({ dir: link, root: W.root, baseHome: W.base, ...hooks }), { ok: true, signedOut: null, kept: false });
  assert.deepEqual([ran, fs.lstatSync(link, { throwIfNoEntry: false }), fs.readFileSync(precious, 'utf8')], [0, undefined, 'keep']);
  // A folder that is already gone: one is put there for Codex to sign out of (it can keep a login under the path), then removed.
  const gone = W.dir('codex-33334444');
  const seen = [];
  assert.deepEqual(await H.remove({ dir: gone, root: W.root, baseHome: W.base, logout: async (o) => { seen.push(fs.existsSync(o.dir)); return { ok: true }; }, stillSignedIn: async () => false, referenced: async () => false }), { ok: true, signedOut: true, kept: false });
  assert.deepEqual([seen, fs.existsSync(gone)], [[true], false]);
  assert.deepEqual(await H.remove({ dir: gone, root: W.root, baseHome: W.base }), { ok: true, signedOut: null, kept: false }, 'with no way to sign out there is nothing to do');
  // The real root swapped for a link to somewhere else while the folder name stays the same.
  const S = world();
  used(S);
  fs.renameSync(S.root, path.join(S.outside, 'moved-accounts'));
  fs.mkdirSync(path.join(S.outside, 'decoy', 'codex-a1b2c3d4'), { recursive: true });
  put(path.join(S.outside, 'decoy', 'codex-a1b2c3d4', 'keep.md'), 'keep');
  fs.symlinkSync(path.join(S.outside, 'decoy', 'codex-a1b2c3d4'), path.join(path.dirname(S.root), 'accounts-link'));
  assert.equal((await H.remove({ dir: path.join(path.dirname(S.root), 'accounts-link'), root: path.dirname(S.root), baseHome: S.base, ...hooks })).code, 'outside');
  assert.equal(fs.readFileSync(path.join(S.outside, 'decoy', 'codex-a1b2c3d4', 'keep.md'), 'utf8'), 'keep');
});

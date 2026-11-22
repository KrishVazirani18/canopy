// account-home.mjs: the folder a second Claude Code sign-in lives in. Its links, its copy of the user's connectors
// and trusted folders, and its removal.
// Everything happens in throwaway folders: "the user's Claude Code folder" is a made-up one under the temp folder,
// filled with the kinds of entries the real one has (a login file, policy files, a session registry, a background
// service, caches). No real Claude Code folder, config file or login is read or written, and nothing is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import * as H from '../../../account-home.mjs';
import { ACCOUNT_CONFIG as OWN, PRIVATE, SHARED, fakeMac, isLinkTo, json, names, put, read, snapshot, stamp } from '../account-world.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-account-home-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Everything below stays under the temp folder: no path here is built from the home folder.
assert.ok(tmp.startsWith(os.tmpdir()) && !tmp.includes('.claude') && !tmp.includes('.canopy'));

let seq = 0;
// One made-up Mac (see account-world.mjs), with Canopy's accounts root beside it and a folder that is neither
// (where canaries go).
function world(opts) {
  const W = fakeMac(path.join(tmp, `w${++seq}`), opts);
  const dir = (id = 'claude-a1b2c3d4') => path.join(W.root, id);
  return { ...W, dir, at: (id) => ({ dir: dir(id), root: W.root, baseHome: W.base }) };
}

// ---- where account folders are ----

test('account folders are kept under ~/.canopy/accounts, and a throwaway copy keeps its own', () => {
  assert.equal(H.accountsRoot({ home: '/Users/someone' }), '/Users/someone/.canopy/accounts');
  assert.equal(H.accountsRoot({ home: '/Users/someone', userData: '/tmp/throwaway' }), '/tmp/throwaway/accounts', 'never the real ones');
  assert.equal(H.accountsRoot({ home: '/Users/someone', userData: null }), '/Users/someone/.canopy/accounts');
  for (const junk of [undefined, {}, { home: 'relative' }, { home: 7 }]) assert.equal(H.accountsRoot(junk), null);
});

// ---- links ----

test('the allowlist holds only the user’s setup and data: no dotfile, nothing Claude Code keeps per sign-in', () => {
  assert.deepEqual([...H.LINKS].sort(), ['CLAUDE.md', 'agent-memory', 'agents', 'commands', 'file-history', 'keybindings.json', 'output-styles', 'plans', 'projects', 'rules', 'settings.json', 'skills']);
  assert.ok(Object.isFrozen(H.LINKS));
  for (const name of H.LINKS) assert.ok(!name.startsWith('.') && !name.includes('/') && !name.includes('\\'), name);
  const top = new Set(PRIVATE.map((rel) => rel.split('/')[0]));
  for (const name of H.LINKS) assert.ok(!top.has(name), `${name} is private to a sign-in`);
});

test('a new account folder holds links to the user’s setup and data, and nothing else', () => {
  const W = world();
  const before = snapshot(W.base);
  const r = H.create(W.at());
  assert.equal(r.ok, true);
  assert.equal(r.code, null);
  const dir = W.dir();
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700, 'the folder is the user’s alone');
  assert.equal(fs.lstatSync(W.root).mode & 0o777, 0o700);

  // Every entry is one of the allowed names, is a link, and points at the same name in the user's folder.
  const made = names(dir);
  for (const name of made) {
    assert.ok(H.LINKS.includes(name), `${name} is not on the list`);
    assert.ok(isLinkTo(path.join(dir, name), path.join(W.base, name)), `${name} is a link to the user's own`);
  }
  // Folders are linked because the user has them; the three they do not have yet get no link. Files always do.
  assert.deepEqual(made, ['CLAUDE.md', 'agents', 'commands', 'file-history', 'keybindings.json', 'plans', 'projects', 'settings.json', 'skills']);
  assert.deepEqual(r.waiting, ['agent-memory', 'rules', 'output-styles']);
  assert.deepEqual([...r.linked].sort(), made);
  assert.deepEqual([...r.made].sort(), made);
  assert.deepEqual([r.own, r.displaced, r.failed], [[], [], []]);

  // The chats, settings and skills are the user's own files, seen through the links.
  assert.equal(fs.readFileSync(path.join(dir, 'projects/-Users-someone-app/chat-1.jsonl'), 'utf8'), '{"type":"user"}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), SHARED['settings.json']);
  // A file of their setup they do not have yet is linked all the same: it reads as "not there", exactly as in
  // their own folder. A folder they do not have gets nothing, not a link to nowhere.
  assert.ok(!fs.existsSync(path.join(dir, 'keybindings.json')) && fs.lstatSync(path.join(dir, 'keybindings.json')).isSymbolicLink());
  for (const name of r.waiting) assert.equal(fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }), undefined, name);

  assert.deepEqual(snapshot(W.base), before, 'nothing was created, changed or deleted in the user’s Claude Code folder');
});

test('dotfiles, the login file, policy files, sessions, the background service and caches are never linked', () => {
  const W = world();
  H.create(W.at());
  H.relink(W.at());
  const dir = W.dir();
  for (const rel of PRIVATE) {
    const name = rel.split('/')[0];
    assert.equal(fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }), undefined, `${name} must not be in an account folder`);
  }
  assert.ok(names(dir).every((n) => !n.startsWith('.')), 'no dotfile of any kind');
  // Even a dotfile or a private entry that happens to share a listed name's spelling is not followed anywhere:
  // the links are by exact name, to exactly that name.
  for (const name of names(dir)) assert.equal(fs.readlinkSync(path.join(dir, name)), path.join(W.base, name));
  // And nothing private can be read through the folder.
  for (const p of ['.credentials.json', 'sessions', 'daemon', 'spares', 'state', 'telemetry', 'policy-limits.json']) assert.ok(!fs.existsSync(path.join(dir, p)), p);
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
    assert.equal(r.linked.length, 9);
  }
  assert.deepEqual(snapshot(W.dir()), first);
  assert.deepEqual(names(W.dir()).map((n) => fs.lstatSync(path.join(W.dir(), n)).ino), inodes, 'the links are the very same ones');
});

test('relink puts back what went missing or wrong, inside the account folder only', () => {
  const W = world();
  H.create(W.at());
  const dir = W.dir();
  const canary = put(path.join(W.outside, 'elsewhere', 'keep.md'), 'not Canopy’s');

  fs.unlinkSync(path.join(dir, 'skills'));                                    // a link was deleted
  fs.unlinkSync(path.join(dir, 'agents'));
  fs.symlinkSync(path.join(W.outside, 'elsewhere'), path.join(dir, 'agents')); // a link points somewhere else
  fs.unlinkSync(path.join(dir, 'commands'));
  fs.mkdirSync(path.join(dir, 'commands'));                                   // an empty folder took a link's place
  const before = snapshot(W.base);

  assert.deepEqual(H.health(W.at()).wrong.sort(), ['agents', 'commands', 'skills']);
  assert.equal(H.health(W.at()).ok, false);
  const r = H.relink(W.at());
  assert.equal(r.ok, true);
  assert.deepEqual([...r.made].sort(), ['agents', 'commands', 'skills']);
  for (const name of ['skills', 'agents', 'commands']) assert.ok(isLinkTo(path.join(dir, name), path.join(W.base, name)), name);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'not Canopy’s', 'what the stray link pointed at is untouched');
  assert.deepEqual(names(path.join(W.outside, 'elsewhere')), ['keep.md']);
  assert.deepEqual(snapshot(W.base), before);
  assert.equal(H.health(W.at()).ok, true);
});

test('a copy Claude Code made where a link belongs is moved aside, never deleted and never merged', () => {
  const W = world();
  H.create(W.at());
  const dir = W.dir();
  // A whole-file rewrite replaces a link with a real file: the account would run on its own copy of the settings.
  fs.unlinkSync(path.join(dir, 'settings.json'));
  put(path.join(dir, 'settings.json'), '{"permissions":{"allow":["Bash(npm test)"]}}');
  // Chats saved apart, in a real folder where the link to the user's history belongs.
  fs.unlinkSync(path.join(dir, 'projects'));
  put(path.join(dir, 'projects', '-Users-someone-app', 'stray.jsonl'), 'stray chat');
  const before = snapshot(W.base);

  const r = H.relink(W.at());
  assert.equal(r.ok, true);
  assert.deepEqual([...r.displaced].sort(), ['projects', 'settings.json']);
  assert.ok(isLinkTo(path.join(dir, 'settings.json'), path.join(W.base, 'settings.json')));
  assert.ok(isLinkTo(path.join(dir, 'projects'), path.join(W.base, 'projects')));
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), SHARED['settings.json'], 'the user’s own settings apply again');
  const kept = names(path.join(dir, '.kept'));
  assert.equal(kept.length, 2);
  const settings = kept.find((n) => n.startsWith('settings.json.')), projects = kept.find((n) => n.startsWith('projects.'));
  assert.equal(fs.readFileSync(path.join(dir, '.kept', settings), 'utf8'), '{"permissions":{"allow":["Bash(npm test)"]}}');
  assert.equal(fs.readFileSync(path.join(dir, '.kept', projects, '-Users-someone-app', 'stray.jsonl'), 'utf8'), 'stray chat');
  assert.deepEqual(snapshot(W.base), before, 'and nothing of it went into the user’s folder');
  assert.deepEqual(H.relink(W.at()).displaced, [], 'once');
});

test('what chats write is linked once the user has it; a copy the account made meanwhile stays its own', () => {
  const { 'plans/a-plan.md': _plan, 'file-history/chat-1/a@v1': _hist, ...fill } = SHARED;
  const W = world({ fill });
  const r = H.create(W.at());
  const dir = W.dir();
  assert.equal(r.ok, true);
  assert.deepEqual([...r.waiting].sort(), ['agent-memory', 'file-history', 'output-styles', 'plans', 'rules']);
  for (const name of r.waiting) assert.equal(fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }), undefined, `${name}: no link to a folder that is not there`);

  // Claude Code, running on the account, makes its own plans folder and writes into it.
  put(path.join(dir, 'plans', 'made-here.md'), 'a plan');
  // Later the user's own folder gets all three.
  for (const name of ['plans', 'file-history', 'agent-memory']) fs.mkdirSync(path.join(W.base, name));
  const before = snapshot(W.base);
  const again = H.relink(W.at());
  assert.equal(again.ok, true);
  assert.deepEqual([...again.made].sort(), ['agent-memory', 'file-history']);
  assert.deepEqual(again.own, ['plans']);
  assert.equal(fs.readFileSync(path.join(dir, 'plans', 'made-here.md'), 'utf8'), 'a plan', 'left exactly where it was');
  assert.ok(!fs.lstatSync(path.join(dir, 'plans')).isSymbolicLink());
  assert.deepEqual(H.health(W.at()).own, ['plans']);
  assert.equal(H.health(W.at()).ok, true);
  assert.deepEqual(snapshot(W.base), before);

  // The user's folder loses one again: the link that would now point at nothing is taken away, not left to trip Claude Code.
  fs.rmdirSync(path.join(W.base, 'agent-memory'));
  const gone = H.relink(W.at());
  assert.ok(gone.waiting.includes('agent-memory'));
  assert.equal(fs.lstatSync(path.join(dir, 'agent-memory'), { throwIfNoEntry: false }), undefined);
});

test('the user’s setup follows them: a folder they add is linked at the next pass, a file written on the account is theirs', () => {
  const { 'CLAUDE.md': _md, 'skills/tidy/SKILL.md': _skill, ...fill } = SHARED;
  const W = world({ fill });
  const r = H.create(W.at());
  const dir = W.dir();
  assert.equal(r.ok, true, 'a setup folder the user does not have is nothing to wait for');
  assert.ok(r.waiting.includes('skills') && r.waiting.includes('rules'));
  // Claude Code, on the account, saves a memory: through the link it becomes the user's own CLAUDE.md.
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'remember this');
  assert.equal(fs.readFileSync(path.join(W.base, 'CLAUDE.md'), 'utf8'), 'remember this');
  assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink());
  // The user adds skills and rules to their own folder: the next pass (before the next launch) links them.
  put(path.join(W.base, 'skills', 'new', 'SKILL.md'), 'a skill');
  put(path.join(W.base, 'rules', 'style.md'), 'a rule');
  const again = H.relink(W.at());
  assert.deepEqual([...again.made].sort(), ['rules', 'skills']);
  assert.equal(fs.readFileSync(path.join(dir, 'rules', 'style.md'), 'utf8'), 'a rule');
  // A skill made on the account while the user had no skills folder is its own until they have one; then the
  // user's setup is what applies, and the account's copy is kept aside, not lost.
  const W2 = world({ fill });
  H.create(W2.at());
  put(path.join(W2.dir(), 'skills', 'made-here', 'SKILL.md'), 'made on the account');
  assert.ok(H.relink(W2.at()).waiting.includes('skills'));
  assert.equal(fs.readFileSync(path.join(W2.dir(), 'skills', 'made-here', 'SKILL.md'), 'utf8'), 'made on the account');
  put(path.join(W2.base, 'skills', 'theirs', 'SKILL.md'), 'the user’s');
  const before = snapshot(W2.base);
  assert.deepEqual(H.relink(W2.at()).displaced, ['skills']);
  assert.deepEqual(names(path.join(W2.dir(), 'skills')), ['theirs']);
  const kept = names(path.join(W2.dir(), '.kept'))[0];
  assert.equal(fs.readFileSync(path.join(W2.dir(), '.kept', kept, 'made-here', 'SKILL.md'), 'utf8'), 'made on the account');
  assert.deepEqual(snapshot(W2.base), before);
});

test('an account folder is only fit to launch on with the user’s chat history linked', () => {
  const { 'projects/-Users-someone-app/chat-1.jsonl': _chat, ...fill } = SHARED;
  const W = world({ fill });
  const before = snapshot(W.w);
  // Nothing is made at all while the user has no chat history to link to.
  assert.deepEqual([H.create(W.at()).ok, H.create(W.at()).code], [false, 'no-history']);
  assert.deepEqual(snapshot(W.w), before, 'not even the accounts root');

  // A folder that exists, with the history gone from the user's side.
  const W2 = world();
  H.create(W2.at());
  fs.renameSync(path.join(W2.base, 'projects'), path.join(W2.outside, 'projects-moved'));
  const r = H.relink(W2.at());
  assert.deepEqual([r.ok, r.code], [false, 'no-history']);
  assert.ok(r.waiting.includes('projects'));
  assert.equal(H.health(W2.at()).ok, false);
  fs.renameSync(path.join(W2.outside, 'projects-moved'), path.join(W2.base, 'projects'));
  assert.equal(H.relink(W2.at()).ok, true, 'and is fit again as soon as it is back');
});

test('nothing is done to a folder that is not an account folder inside the accounts root', () => {
  const W = world();
  H.create(W.at());
  const everything = snapshot(W.w);
  const refused = (o, code) => {
    for (const fn of [H.create, H.relink, H.health]) {
      const r = fn(o);
      assert.deepEqual([r.ok, r.code], [false, code], `${fn.name} ${JSON.stringify(o)}`);
    }
    assert.deepEqual(snapshot(W.w), everything, `nothing changed for ${JSON.stringify(o)}`);
  };
  // The user's own Claude Code folder, handed in as if it were an account's: never linked into.
  refused({ dir: W.base, root: W.root, baseHome: W.base }, 'outside');
  refused({ dir: W.base, root: path.dirname(W.base), baseHome: W.base }, 'outside');
  // Not directly inside the root, or not named like an account folder.
  refused({ dir: path.join(W.outside, 'claude-a1b2c3d4'), root: W.root, baseHome: W.base }, 'outside');
  refused({ dir: path.join(W.root, 'deeper', 'claude-a1b2c3d4'), root: W.root, baseHome: W.base }, 'outside');
  refused({ dir: path.join(W.root, 'notes'), root: W.root, baseHome: W.base }, 'outside');
  refused({ dir: path.join(W.root, '..', 'accounts', '..', '..', 'outside'), root: W.root, baseHome: W.base }, 'outside');
  refused({ dir: W.root, root: W.root, baseHome: W.base }, 'outside');
  refused({ dir: 'claude-a1b2c3d4', root: W.root, baseHome: W.base }, 'outside');
  for (const junk of [undefined, null, {}, { dir: 7 }]) for (const fn of [H.create, H.relink, H.health]) assert.equal(fn(junk ?? undefined).ok, false);
  // No Claude Code folder to link to.
  refused({ dir: W.dir('claude-ffff0000'), root: W.root, baseHome: path.join(W.home, 'no-such-folder') }, 'no-base');
  refused({ dir: W.dir('claude-ffff0000'), root: W.root, baseHome: undefined }, 'no-base');
});

test('an account folder that is really a link, or sits inside the user’s Claude Code folder, is refused', () => {
  const W = world();
  fs.mkdirSync(W.root, { recursive: true });
  // The "account folder" is a link to the user's own Claude Code folder.
  fs.symlinkSync(W.base, W.dir('claude-11112222'));
  // The accounts root itself is inside the user's Claude Code folder.
  const inner = path.join(W.base, 'canopy-accounts');
  fs.mkdirSync(path.join(inner, 'claude-33334444'), { recursive: true });
  const before = snapshot(W.w);

  for (const fn of [H.relink, H.health, H.create]) {
    assert.deepEqual([fn(W.at('claude-11112222')).ok, fn(W.at('claude-11112222')).code], [false, 'not-a-folder'], fn.name);
    const r = fn({ dir: path.join(inner, 'claude-33334444'), root: inner, baseHome: W.base });
    assert.deepEqual([r.ok, r.code], [false, 'outside'], fn.name);
  }
  assert.equal(H.syncConfig({ dir: W.dir('claude-11112222'), root: W.root, baseHome: W.base, baseConfig: W.baseConfig }).ok, false);
  assert.equal(H.syncConfig({ dir: path.join(inner, 'claude-33334444'), root: inner, baseHome: W.base, baseConfig: W.baseConfig }).ok, false);
  assert.deepEqual(snapshot(W.w), before, 'no link was made inside the user’s folder, and no config written there');
});

test('health only looks', () => {
  const W = world();
  H.create(W.at());
  fs.unlinkSync(path.join(W.dir(), 'skills'));
  const before = snapshot(W.w);
  const h = H.health(W.at());
  assert.deepEqual([h.ok, h.code, h.wrong, h.waiting], [false, 'unlinked', ['skills'], ['agent-memory', 'rules', 'output-styles']]);
  assert.equal(h.linked.length, 8);
  assert.deepEqual(snapshot(W.w), before);
  assert.deepEqual([H.health(W.at('claude-00000000')).ok, H.health(W.at('claude-00000000')).code], [false, 'missing']);
});

test('something new in the user’s Claude Code folder stands out; dotfiles and known housekeeping do not', () => {
  const W = world();
  assert.deepEqual(H.strangers(W.base), [], 'everything Claude Code keeps today is known');
  fs.mkdirSync(path.join(W.base, 'brand-new-thing'));
  put(path.join(W.base, 'notes.md'), 'mine');
  put(path.join(W.base, '.hidden-new'), '');
  put(path.join(W.base, 'settings.json.bak-2'), '');
  put(path.join(W.base, 'daemon.pid'), '');
  assert.deepEqual(H.strangers(W.base), ['brand-new-thing', 'notes.md']);
  for (let i = 0; i < 40; i++) put(path.join(W.base, `extra-${String(i).padStart(2, '0')}`), '');
  assert.equal(H.strangers(W.base).length, 24, 'a long list is cut short');
  assert.deepEqual(H.strangers(path.join(W.base, 'no-such-folder')), []);
  assert.deepEqual(H.strangers(undefined), []);
});

// ---- connectors and trusted folders ----

const without = (config) => {
  const { mcpServers: _m, projects, ...rest } = structuredClone(config);
  const kept = {};
  for (const [p, v] of Object.entries(projects ?? {})) { const { mcpServers: _s, hasTrustDialogAccepted: _t, ...other } = v; kept[p] = other; }
  return { ...rest, projects: kept };
};
function signedIn(W, own = OWN()) {
  H.forgetConfig();
  H.create(W.at());
  const file = path.join(W.dir(), '.claude.json');
  if (own) { json(file, own); fs.chmodSync(file, 0o600); }
  return file;
}
const sync = (W, extra = {}) => H.syncConfig({ dir: W.dir(), root: W.root, baseHome: W.base, baseConfig: W.baseConfig, ...extra });

test('syncConfig copies the user’s connectors and trusted folders, touches no other key, and never writes the user’s file', () => {
  const W = world();
  const file = signedIn(W);
  const baseBytes = fs.readFileSync(W.baseConfig, 'utf8'), baseStamp = stamp(W.baseConfig), baseDir = snapshot(W.base);
  const before = read(file);

  assert.deepEqual(sync(W), { ok: true, changed: true });
  const now = read(file);
  const base = read(W.baseConfig);
  // The connectors, the user's own and each folder's, and which folders were trusted.
  assert.deepEqual(now.mcpServers, base.mcpServers);
  assert.deepEqual(now.projects['/Users/someone/app'].mcpServers, { local: { command: 'node', args: ['local.js'] } });
  assert.equal(now.projects['/Users/someone/app'].hasTrustDialogAccepted, true);
  assert.equal(now.projects['/Users/someone/plain'].hasTrustDialogAccepted, true);
  assert.ok(!('/Users/someone/untrusted' in now.projects), 'a folder the user did not trust is not brought over');
  assert.equal(now.projects['/Users/someone/only-here'].hasTrustDialogAccepted, true, 'trust given on the account itself stays');

  // Nothing else moved: not who is signed in, not counters, not caches, not a folder's history or cost.
  assert.deepEqual(without(now), { ...without(before), projects: { ...without(before).projects, '/Users/someone/plain': {} } });
  assert.deepEqual(Object.keys(now).filter((k) => !(k in before)), ['mcpServers'], 'the only new top-level key');
  assert.deepEqual(now.oauthAccount, before.oauthAccount, 'the account keeps its own login record');
  assert.equal(now.userID, 'user-id-of-the-account');
  const text = fs.readFileSync(file, 'utf8');
  for (const leaked of ['default@example.com', 'acct-default', 'org-default', 'user-id-of-the-default-login', 'cachedChangelog', 'a prompt']) assert.ok(!text.includes(leaked), `${leaked} was copied`);
  assert.equal(now.projects['/Users/someone/app'].lastCost, 9, 'the account’s own numbers, not the user’s');

  // The user's config file is the same file with the same bytes, and nothing appeared beside it or in their folder.
  assert.equal(fs.readFileSync(W.baseConfig, 'utf8'), baseBytes);
  assert.equal(stamp(W.baseConfig), baseStamp, 'not rewritten, not replaced');
  assert.deepEqual(names(W.home), ['.claude', '.claude.json']);
  assert.deepEqual(snapshot(W.base), baseDir);

  // Whole file or nothing, private to the user, and no scraps left behind.
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(names(W.dir()).filter((n) => n.startsWith('.')), ['.canopy-sync.json', '.claude.json']);
  assert.equal(fs.lstatSync(path.join(W.dir(), '.canopy-sync.json')).mode & 0o777, 0o600);
});

test('syncConfig does nothing when nothing differs, however much else the user’s file changed', () => {
  const W = world();
  const file = signedIn(W);
  sync(W);
  const mine = stamp(file), note = stamp(path.join(W.dir(), '.canopy-sync.json'));
  assert.deepEqual(sync(W), { ok: true, changed: false });
  // Claude Code rewrites its config on every launch: counters and caches move, the connectors do not.
  const base = read(W.baseConfig);
  json(W.baseConfig, { ...base, numStartups: 42, cachedChangelog: 'different', oauthAccount: { ...base.oauthAccount, emailAddress: 'renamed@example.com' }, projects: { ...base.projects, '/Users/someone/app': { ...base.projects['/Users/someone/app'], lastCost: 77 } } });
  assert.deepEqual(sync(W), { ok: true, changed: false }, 'compared key by key, never as a whole file');
  assert.equal(stamp(file), mine, 'the account’s file was not rewritten');
  assert.equal(stamp(path.join(W.dir(), '.canopy-sync.json')), note);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('renamed@example.com'));
});

test('syncConfig follows the user: a changed connector changes, a removed one goes, one the account got itself stays', () => {
  const W = world();
  const file = signedIn(W);
  sync(W);
  // On the account, in a terminal, the user added a connector of their own and one to a project.
  const mine = read(file);
  mine.mcpServers.onlyhere = { command: 'mine' };
  mine.projects['/Users/someone/app'].mcpServers.alsohere = { command: 'mine-too' };
  json(file, mine);
  // In their own setup they changed one connector, removed another, added a third, and dropped the project's.
  const base = read(W.baseConfig);
  base.mcpServers.notion.url = 'https://mcp.notion.com/v2';
  delete base.mcpServers.files;
  base.mcpServers.linear = { type: 'http', url: 'https://mcp.linear.app' };
  delete base.projects['/Users/someone/app'].mcpServers;
  base.projects['/Users/someone/plain'].hasTrustDialogAccepted = false; // trust is never taken back by a sync
  json(W.baseConfig, base);

  assert.deepEqual(sync(W), { ok: true, changed: true });
  const now = read(file);
  assert.deepEqual(now.mcpServers, { notion: { type: 'http', url: 'https://mcp.notion.com/v2' }, onlyhere: { command: 'mine' }, linear: { type: 'http', url: 'https://mcp.linear.app' } });
  assert.deepEqual(now.projects['/Users/someone/app'].mcpServers, { alsohere: { command: 'mine-too' } });
  assert.equal(now.projects['/Users/someone/plain'].hasTrustDialogAccepted, true);
  assert.deepEqual(sync(W), { ok: true, changed: false });

  // Same name on both sides: the user's wins, and from then on it is the user's to remove.
  const twice = read(file);
  twice.mcpServers.linear = { command: 'edited-on-the-account' };
  json(file, twice);
  sync(W);
  assert.deepEqual(read(file).mcpServers.linear, { type: 'http', url: 'https://mcp.linear.app' });
  // Every connector gone from the user's setup: only the account's own is left.
  json(W.baseConfig, { ...read(W.baseConfig), mcpServers: {} });
  sync(W);
  assert.deepEqual(read(file).mcpServers, { onlyhere: { command: 'mine' } });
});

test('syncConfig writes only while nothing runs on the account', () => {
  const W = world();
  const file = signedIn(W);
  const before = stamp(file);
  let asked = 0;
  assert.deepEqual(sync(W, { idle: () => { asked += 1; return false; } }), { ok: true, changed: false, pending: true });
  assert.equal(asked, 1);
  assert.equal(stamp(file), before, 'nothing was written under a running process');
  assert.deepEqual(names(W.dir()).filter((n) => n.startsWith('.')), ['.claude.json'], 'not even a note');
  // Anything but a clear "yes, idle" holds the write back.
  for (const answer of [undefined, null, 'yes', 1]) assert.equal(sync(W, { idle: () => answer }).pending, true);
  assert.equal(stamp(file), before);
  assert.deepEqual(sync(W, { idle: () => true }), { ok: true, changed: true });
  // In line already: nothing to write, so nobody needs to be idle.
  assert.deepEqual(sync(W, { idle: () => { throw new Error('not asked'); } }), { ok: true, changed: false });
});

test('a config file that cannot be read is never taken for an empty one, and never rewritten', () => {
  const W = world();
  const file = signedIn(W);
  sync(W);
  const good = fs.readFileSync(file, 'utf8');

  // The user's file torn mid-write, or not an object: the account keeps every connector it has.
  for (const torn of ['{"mcpServers": {"not', '', '[]', 'null']) {
    put(W.baseConfig, torn);
    assert.deepEqual(sync(W), { ok: false, code: 'base-unreadable' }, JSON.stringify(torn));
    assert.equal(fs.readFileSync(file, 'utf8'), good);
    assert.equal(fs.readFileSync(W.baseConfig, 'utf8'), torn, 'and the user’s file is left as found');
  }
  // No config file at all: nothing to copy, nothing taken away.
  fs.unlinkSync(W.baseConfig);
  assert.deepEqual(sync(W), { ok: true, changed: false });
  assert.equal(fs.readFileSync(file, 'utf8'), good);
  assert.ok(!fs.existsSync(W.baseConfig), 'and none is created');

  // The account's own file torn: left alone for Claude Code to finish, not replaced from a bad read.
  json(W.baseConfig, { mcpServers: { fresh: { command: 'x' } } });
  put(file, '{"numStartups": 3, "oauthAcc');
  assert.deepEqual(sync(W), { ok: false, code: 'unreadable' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"numStartups": 3, "oauthAcc');
});

test('an account config that is really a link to the user’s is refused: nothing of theirs is copied or written through', () => {
  const W = world();
  const file = signedIn(W, null);
  fs.symlinkSync(W.baseConfig, file);
  const baseBytes = fs.readFileSync(W.baseConfig, 'utf8'), baseStamp = stamp(W.baseConfig);
  // The user's side changed, so there would be something to write.
  assert.deepEqual(sync(W), { ok: false, code: 'unreadable' });
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.equal(fs.readFileSync(W.baseConfig, 'utf8'), baseBytes);
  assert.equal(stamp(W.baseConfig), baseStamp);
});

test('with no config in the account folder yet, syncConfig makes one that holds only its own keys', () => {
  const W = world();
  const file = signedIn(W, null);
  assert.deepEqual(sync(W), { ok: true, changed: true });
  const now = read(file);
  assert.deepEqual(Object.keys(now).sort(), ['mcpServers', 'projects']);
  assert.deepEqual(Object.keys(now.projects).sort(), ['/Users/someone/app', '/Users/someone/plain']);
  for (const v of Object.values(now.projects)) assert.ok(Object.keys(v).every((k) => k === 'mcpServers' || k === 'hasTrustDialogAccepted'));
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
});

test('the user’s config is found where Claude Code keeps it: the first place that has one', () => {
  const W = world();
  const file = signedIn(W);
  fs.unlinkSync(W.baseConfig);
  const legacy = json(path.join(W.base, '.config.json'), { mcpServers: { old: { command: 'legacy' } }, projects: { relative: { hasTrustDialogAccepted: true } } });
  assert.deepEqual(sync(W, { baseConfig: [W.baseConfig, legacy] }), { ok: true, changed: true });
  assert.deepEqual(read(file).mcpServers, { old: { command: 'legacy' } });
  assert.ok(!('relative' in read(file).projects), 'only real folders');
  // The user's config being this very file (their shell points Claude Code at the account folder): nothing to do.
  assert.deepEqual(sync(W, { baseConfig: [file] }), { ok: true, changed: false });
  // Odd names are data, not code.
  const odd = JSON.parse('{"mcpServers":{"__proto__":{"command":"p"},"constructor":{"command":"c"}}}');
  put(legacy, JSON.stringify(odd));
  sync(W, { baseConfig: legacy });
  const got = read(file).mcpServers;
  assert.deepEqual(Object.keys(got).sort(), ['__proto__', 'constructor']);
  assert.equal(({}).command, undefined);
  for (const junk of [undefined, {}, { dir: W.dir() }, { dir: W.base, root: W.root, baseConfig: legacy }]) assert.equal(H.syncConfig(junk).ok, false);
});

// ---- removing ----

// An account folder as it is after some use: the links, Claude Code's own per-folder state, and (planted) links
// that lead out of the folder, at the top and deeper down.
function used(W, id) {
  H.create(W.at(id));
  const dir = W.dir(id);
  json(path.join(dir, '.claude.json'), OWN());
  put(path.join(dir, 'sessions', '99.json'), '{}');
  put(path.join(dir, 'cache', 'deep', 'deeper', 'x.txt'), 'x');
  put(path.join(dir, 'shell-snapshots', 's.sh'), '#');
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.symlinkSync(path.join(W.outside, 'canary.txt'), path.join(dir, 'link-to-file'));
  fs.symlinkSync(path.join(W.outside, 'canary-dir'), path.join(dir, 'link-to-dir'));
  fs.symlinkSync(path.join(W.outside, 'canary-dir'), path.join(dir, 'cache', 'deep', 'link-to-dir'));
  fs.symlinkSync(W.base, path.join(dir, 'cache', 'link-to-claude'));
  fs.symlinkSync(W.home, path.join(dir, 'link-to-home'));
  fs.symlinkSync(path.join(W.outside, 'nothing-there'), path.join(dir, 'dangling'));
  fs.linkSync(path.join(W.outside, 'canary.txt'), path.join(dir, 'hard-link'));
  return dir;
}
function canaries(W) {
  put(path.join(W.outside, 'canary.txt'), 'still here');
  put(path.join(W.outside, 'canary-dir', 'inner', 'deep.txt'), 'deep and still here');
  put(path.join(W.outside, 'canary-dir', 'top.txt'), 'top');
}

test('remove signs the folder out first, then deletes it without ever following a link out of it', async () => {
  const W = world();
  canaries(W);
  const dir = used(W);
  const other = used(W, 'claude-0ther000');
  const base = snapshot(W.base), outside = snapshot(W.outside), sibling = snapshot(other), home = names(W.home);
  const calls = [];
  const r = await H.remove({
    ...W.at(),
    // When Claude Code is asked to sign out, the folder is still whole: its links and its own state are all there.
    logout: async (o) => { calls.push(['logout', o, names(dir).length, fs.existsSync(path.join(dir, '.claude.json'))]); return { ok: true }; },
    stillSignedIn: async (o) => { calls.push(['check', o]); return false; },
  });
  assert.deepEqual(r, { ok: true, signedOut: true });
  assert.deepEqual(calls.map((c) => c[0]), ['logout', 'check'], 'signed out, then checked, before anything is deleted');
  assert.deepEqual(calls[0][1], { dir });
  assert.ok(calls[0][2] > 15 && calls[0][3] === true);

  assert.equal(fs.lstatSync(dir, { throwIfNoEntry: false }), undefined, 'the account folder is gone');
  assert.deepEqual(names(W.root), ['claude-0ther000'], 'the accounts root and the other account stay');
  assert.deepEqual(snapshot(other), sibling);
  // Every canary outside the folder is exactly as it was: the file, the folder, what is inside it.
  assert.deepEqual(snapshot(W.outside), outside);
  assert.equal(fs.readFileSync(path.join(W.outside, 'canary.txt'), 'utf8'), 'still here');
  assert.equal(fs.readFileSync(path.join(W.outside, 'canary-dir', 'inner', 'deep.txt'), 'utf8'), 'deep and still here');
  // And so is everything the folder linked to: the user's chats, settings, skills, their whole Claude Code folder.
  assert.deepEqual(snapshot(W.base), base);
  assert.deepEqual(names(W.home), home);
  assert.equal(fs.readFileSync(path.join(W.base, 'projects/-Users-someone-app/chat-1.jsonl'), 'utf8'), '{"type":"user"}\n');
});

test('remove keeps the folder when Claude Code still says it is signed in', async () => {
  const W = world();
  canaries(W);
  const dir = used(W);
  const before = snapshot(dir);
  const r = await H.remove({ ...W.at(), logout: async () => ({ ok: false }), stillSignedIn: async () => true });
  assert.deepEqual(r, { ok: false, code: 'still-signed-in' });
  assert.deepEqual(snapshot(dir), before, 'a folder that still holds a login is not deleted from under it');
  // Claude Code could not say, and the sign-out run failed: the folder goes, and the answer says it is not known.
  assert.deepEqual(await H.remove({ ...W.at(), logout: async () => { throw new Error('boom'); }, stillSignedIn: async () => null }), { ok: true, signedOut: null });
  // It could not say, but the sign-out itself ran fine.
  used(W);
  assert.deepEqual(await H.remove({ ...W.at(), logout: async () => ({ ok: true }), stillSignedIn: async () => { throw new Error('x'); } }), { ok: true, signedOut: true });
  // No way to ask Claude Code at all (it is not installed): the folder still goes.
  used(W);
  assert.deepEqual(await H.remove(W.at()), { ok: true, signedOut: null });
});

test('remove never points Claude Code at a link, and never deletes through one', async () => {
  const W = world();
  canaries(W);
  fs.mkdirSync(W.root, { recursive: true });
  const base = snapshot(W.base), outside = snapshot(W.outside);
  let ran = 0;
  const logout = async () => { ran += 1; return { ok: true }; };
  // Where the account's folder should be there is a link to the user's own Claude Code folder. Signing out "there"
  // would sign the user's own login out, so nothing is run, and only the link itself goes.
  for (const target of [W.base, path.join(W.outside, 'canary-dir'), path.join(W.outside, 'canary.txt')]) {
    fs.symlinkSync(target, W.dir());
    assert.deepEqual(await H.remove({ ...W.at(), logout, stillSignedIn: async () => { ran += 1; return false; } }), { ok: true, signedOut: null });
    assert.equal(fs.lstatSync(W.dir(), { throwIfNoEntry: false }), undefined);
  }
  assert.equal(ran, 0, 'Claude Code was never run against a link');
  assert.deepEqual(snapshot(W.base), base);
  assert.deepEqual(snapshot(W.outside), outside);
});

test('remove refuses anything that is not an account folder inside the accounts root', async () => {
  const W = world();
  canaries(W);
  used(W);
  const everything = snapshot(W.w);
  let ran = 0;
  const hooks = { logout: async () => { ran += 1; return { ok: true }; }, stillSignedIn: async () => { ran += 1; return false; } };
  const targets = [
    { dir: W.base, root: W.root },                                   // the user's own Claude Code folder
    { dir: W.base, root: W.home },
    { dir: W.home, root: W.w },
    { dir: W.root, root: W.root },                                   // the accounts root itself
    { dir: W.root, root: path.dirname(W.root) },
    { dir: path.join(W.outside, 'canary-dir'), root: W.outside },    // a folder that is not named like an account's
    { dir: path.join(W.root, 'claude-a1b2c3d4', 'cache'), root: W.root },
    { dir: path.join(W.root, 'claude-a1b2c3d4', '..', '..', '..', 'outside'), root: W.root },
    { dir: 'claude-a1b2c3d4', root: W.root },
    { dir: W.dir() }, {},
  ];
  for (const t of targets) assert.deepEqual(await H.remove({ ...t, baseHome: W.base, ...hooks }), { ok: false, code: 'outside' }, JSON.stringify(t));
  assert.equal(ran, 0, 'and Claude Code is never asked to sign anything out for them');
  assert.deepEqual(snapshot(W.w), everything);

  // An accounts root that resolves into the user's Claude Code folder: refused, whatever the folder is called.
  const inner = path.join(W.base, 'accounts');
  put(path.join(inner, 'claude-55556666', 'x'), 'x');
  const after = snapshot(W.w);
  assert.deepEqual(await H.remove({ dir: path.join(inner, 'claude-55556666'), root: inner, baseHome: W.base, ...hooks }), { ok: false, code: 'outside' });
  assert.equal(ran, 0);
  assert.deepEqual(snapshot(W.w), after);
});

test('removing an account whose folder is already gone still signs it out, and leaves nothing behind', async () => {
  const W = world();
  fs.mkdirSync(W.root, { recursive: true });
  const seen = [];
  const r = await H.remove({ ...W.at(), logout: async ({ dir }) => { seen.push(fs.lstatSync(dir).isDirectory()); return { ok: true }; }, stillSignedIn: async () => false });
  assert.deepEqual(r, { ok: true, signedOut: true });
  assert.deepEqual(seen, [true], 'Claude Code keeps a sign-in by the folder’s path, so it is given a folder to sign out of');
  assert.deepEqual(names(W.root), []);
  // With no way to sign out there is nothing to make a folder for.
  assert.deepEqual(await H.remove(W.at()), { ok: true, signedOut: null });
  assert.deepEqual(names(W.root), []);
});

// Canopy Memory's notes as files (memory-store.mjs): what a note looks like on disk, that a repeat replaces instead
// of piling up, that a fact that changed takes the old one's place and says what it replaced, the caps, what is
// refused, undo, search, which note a chat means by a name, and which project a folder belongs to. Every store here
// lives in a folder of its own under the temp folder; nothing of the user's is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { core } from '../helpers.mjs';

const S = await core('memory-store.mjs');
const missing = S.__missing ?? false;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-memory-store-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
// A store in a new folder, with a clock that moves a second at each look so "newest first" is never a tie.
function store(opts = {}) {
  const dir = path.join(root, `m${++n}`);
  let t = Date.parse('2026-11-19T10:00:00Z');
  return new S.MemoryStore({ dir, now: () => (t += 1000), ...opts });
}
const SITE = '/work/site';
const said = (text, extra = {}) => ({ text, scope: 'project', project: SITE, source: 'user-said', engine: 'claude', chat: 'chat-1', ...extra });

test('a note is one Markdown file with a small header, readable and writable by hand', { skip: missing }, () => {
  const s = store();
  const { note, action, dropped } = s.save(said('Uses pnpm, not npm. Run pnpm install and pnpm test.'));
  assert.deepEqual([action, dropped], ['saved', null]);
  assert.match(note.id, /^[a-z0-9]{6}$/);
  assert.equal(note.title, 'Uses pnpm, not npm', 'a note given no title is named by its first sentence');
  assert.deepEqual(fs.readdirSync(s.dir), [`${note.id}.md`]);
  assert.equal(fs.readFileSync(path.join(s.dir, `${note.id}.md`), 'utf8'), [
    '---', `id: ${note.id}`, 'title: Uses pnpm, not npm', 'scope: project', 'project: /work/site', 'source: user-said', 'engine: claude', 'chat: chat-1',
    'created: 2026-11-19T10:00:01.000Z', 'updated: 2026-11-19T10:00:01.000Z', '---', 'Uses pnpm, not npm. Run pnpm install and pnpm test.', '',
  ].join('\n'));
  assert.deepEqual(s.get(note.id), note, 'what was written is what is read back');
  // A note about the user has no project line.
  const me = s.save({ text: 'Keep answers to three lines.', scope: 'me', source: 'user-said' }).note;
  assert.ok(!fs.readFileSync(path.join(s.dir, `${me.id}.md`), 'utf8').includes('project:'));
  assert.deepEqual([me.scope, me.project, me.engine, me.chat], ['me', null, null, null]);

  // A file the user wrote by hand: no header at all, or half of one. It is theirs, so it reads as something they said.
  fs.writeFileSync(path.join(s.dir, 'byhand.md'), 'I work in Pacific time.\n');
  fs.writeFileSync(path.join(s.dir, 'half1.md'), '---\ntitle: Deploys\nscope: project\nproject: /work/site\n---\nDeploys go out with make ship.\n');
  fs.writeFileSync(path.join(s.dir, 'notes.txt'), 'not a note');
  fs.writeFileSync(path.join(s.dir, 'empty.md'), '---\nid: empty1\n---\n\n');
  fs.writeFileSync(path.join(s.dir, 'Bad Name.md'), 'a file whose name is no id is left alone');
  const byHand = s.get('byhand');
  assert.deepEqual([byHand.title, byHand.text, byHand.scope, byHand.source], ['I work in Pacific time', 'I work in Pacific time.', 'me', 'user-said']);
  assert.deepEqual([s.get('half1').title, s.get('half1').scope, s.get('half1').project], ['Deploys', 'project', '/work/site']);
  assert.deepEqual(s.all().map((x) => x.id).sort(), [note.id, me.id, 'byhand', 'half1'].sort(), 'what is not a note is skipped');
  assert.equal(S.parseNote('---\nid: abcd12\nscope: project\n---\nA project note with no project is about the user.').scope, 'me');
  assert.equal(S.parseNote(null), null);
});

test('nothing throws: a folder that is not there is an empty memory', { skip: missing }, () => {
  const s = new S.MemoryStore({ dir: path.join(root, 'never', 'made') });
  assert.deepEqual(s.all(), []);
  assert.equal(s.get('abc123'), null);
  assert.equal(s.get('../../etc/passwd'), null);
  assert.equal(s.remove('abc123'), null);
  assert.equal(s.restore('abc123'), null);
  assert.equal(s.revert('abc123'), null);
  assert.deepEqual(s.search('anything'), []);
  assert.deepEqual(s.relevant(SITE), { me: [], project: [] });
  assert.deepEqual(s.state('nope!'), { note: null, removed: false, previous: false });
  assert.ok(s.edit('abc123', { text: 'x' }).error);
  // A folder that cannot be made: the save says so, and does not throw.
  const blocked = path.join(root, 'a-file');
  fs.writeFileSync(blocked, '');
  assert.match(new S.MemoryStore({ dir: path.join(blocked, 'memory') }).save({ text: 'A note of three words.', scope: 'me' }).error, /could not be written/);
});

test('a repeat replaces the note it repeats: by its title, or by nearly the same words', { skip: missing }, () => {
  const s = store();
  const first = s.save(said('Uses npm for everything.', { title: 'Package manager' })).note;
  // The same title, written a little differently, with the fact corrected.
  const second = s.save(said('Uses pnpm, not npm. Run pnpm install.', { title: 'package manager.', engine: 'codex', chat: 'chat-2' }));
  assert.equal(second.action, 'updated');
  assert.equal(second.note.id, first.id);
  assert.deepEqual([second.note.text, second.note.engine, second.note.chat, second.note.created], ['Uses pnpm, not npm. Run pnpm install.', 'codex', 'chat-2', first.created]);
  assert.ok(second.note.updated > first.updated);
  assert.equal(s.all().length, 1);

  // No title, nearly the same words: still the same note.
  const t1 = s.save(said('The tests run with pnpm vitest run and take about a minute.')).note;
  const t2 = s.save(said('Tests run with pnpm vitest run; they take about a minute.', { source: 'model-noticed' }));
  assert.deepEqual([t2.action, t2.note.id, t2.note.source], ['updated', t1.id, 'model-noticed']);
  // A different fact that shares a word or two is a note of its own.
  assert.equal(s.save(said('The build runs with pnpm build.')).action, 'saved');
  assert.equal(s.save(said('Deploys go out with make ship, never by hand.')).action, 'saved');
  assert.equal(s.all().length, 4);

  // The same words about another project, or about the user, are another note: a repeat is within one scope.
  assert.equal(s.save(said('Uses pnpm, not npm. Run pnpm install.', { title: 'Package manager', project: '/work/other' })).action, 'saved');
  assert.equal(s.save({ text: 'Uses pnpm, not npm. Run pnpm install.', title: 'Package manager', scope: 'me' }).action, 'saved');
  assert.equal(s.all().length, 6);
  assert.equal(S.alike('Uses pnpm.', 'Uses pnpm.'), 0, 'two words are too few to call two notes the same');
});

test('the caps: a note is short, a title is shorter, and the folder never holds more than its limit', { skip: missing }, () => {
  const s = store({ limits: { notes: 5, trash: 3 } });
  const long = s.save({ text: `${'word '.repeat(120)}x`, scope: 'me' });
  assert.match(long.error, /601 characters and the most a note holds is 600/);
  assert.equal(s.save({ text: 'word '.repeat(120).trim().padEnd(600, 'y'), scope: 'me', title: 'Six hundred', source: 'user-said' }).action, 'saved', 'exactly the cap fits');
  assert.match(s.save({ text: '   ', scope: 'me' }).error, /nothing in this note/);
  // A word or two is a stand-in, not a fact (seen once in 60 measured chats: a note that said "placeholder").
  for (const text of ['placeholder', 'test', 'TODO later']) assert.match(s.save({ text, scope: 'me' }).error, /too short to be a note/, text);
  assert.equal(s.save({ text: 'Has a long title.', title: 'T'.repeat(200), scope: 'me', source: 'user-said' }).note.title.length, 80);

  // Three more fill it: one the model noticed, then two the user said.
  const noticed = s.save({ text: 'The linter is biome, run with pnpm lint.', scope: 'me', source: 'model-noticed' }).note;
  s.save({ text: 'Commit messages are in plain English.', scope: 'me', source: 'user-said' });
  s.save({ text: 'Never push without asking first.', scope: 'me', source: 'user-said' });
  assert.equal(s.all().length, 5);
  // One more: the one the model noticed goes, though two notes are older than it.
  const sixth = s.save({ text: 'Prefers tabs over spaces in Go files.', scope: 'me', source: 'user-said' });
  assert.equal(sixth.dropped.id, noticed.id);
  assert.equal(s.all().length, 5);
  assert.ok(!s.all().some((x) => x.id === noticed.id));
  assert.deepEqual(s.state(noticed.id), { note: null, removed: true, previous: false }, 'it went to the trash, not for good');
  // With only notes the user said left, the least recently changed goes.
  const oldest = s.all().at(-1);
  assert.equal(s.save({ text: 'Works in Pacific time, mornings.', scope: 'me', source: 'user-said' }).dropped.id, oldest.id);
  // Bringing a note up to date drops nothing.
  assert.equal(s.save({ text: 'Never push without asking first, ever.', title: 'Never push without asking first', scope: 'me' }).dropped, null);
  assert.equal(s.all().length, 5);
  // The trash is bounded too.
  for (let i = 0; i < 6; i++) s.save({ text: `Fact number ${i} about quite different things ${'abcdefghij'[i]}${i}xyz.`, scope: 'me', source: 'user-said' });
  assert.ok(fs.readdirSync(path.join(s.dir, '.trash')).length <= 3);
  assert.equal(s.all().length, 5);
});

test('a note that looks like a credential is refused, however it is worded', { skip: missing }, () => {
  const s = store();
  for (const text of [
    'The user\'s API key is sk-live-9f8e7d6c5b4a3f2e1d0c.',
    'OpenAI key: sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'GitHub token ghp_abcdefghijklmnopqrstuvwxyz0123456789 works for the deploy.',
    'The staging password is hunter2!',
    'Database: postgres://admin:s3cretpw@localhost:5432/app',
    'Send Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def with every call',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
  ]) {
    const r = s.save({ text, scope: 'me' });
    assert.match(r.error ?? '', /never keeps secrets/, text);
  }
  assert.match(s.save({ text: 'Deploy key.', title: 'token = abc12345', scope: 'me' }).error, /never keeps secrets/, 'a title is looked at too');
  assert.deepEqual(s.all(), []);
  // Talking about secrets is not a secret.
  for (const text of ['API keys live in 1Password, never in .env files.', 'The auth token is refreshed hourly by the gateway.', 'Never print secrets or passwords in logs.', 'The secret is to keep answers short.'])
    assert.equal(s.save({ text, scope: 'me' }).action, 'saved', text);
});

test('a fact that changed takes the old note\'s place, and the note says what it replaced', { skip: missing }, () => {
  const s = store();
  const old = s.save(said('Uses pnpm, not npm.', { title: 'Package manager' })).note;
  assert.equal(old.replaced, null);
  // Named by its id (the tool finds that from what the model called it): not the same title, not the same words.
  const now = s.save(said('The repo moved to npm last week.', { title: 'Uses npm', replaces: old.id, chat: 'chat-2' }));
  assert.deepEqual([now.action, now.note.id, now.note.title, now.note.text, now.note.replaced], ['updated', old.id, 'Uses npm', 'The repo moved to npm last week.', 'Uses pnpm, not npm.']);
  assert.deepEqual(now.replaced, old, 'the save hands back the note as it was');
  assert.equal(s.all().length, 1, 'one note, not two that disagree');
  // It is written in the note's own file, so the user can read what a note said before with any editor.
  assert.match(fs.readFileSync(path.join(s.dir, `${old.id}.md`), 'utf8'), /\nreplaced: Uses pnpm, not npm\.\n---\nThe repo moved to npm last week\.\n$/);
  assert.deepEqual(s.get(old.id), now.note);
  // Undo puts the old note back whole; the wording that replaced it is kept for a redo.
  assert.deepEqual(s.revert(old.id), old);
  assert.equal(s.revert(old.id).replaced, 'Uses pnpm, not npm.');

  // Replaced again: the note says only the last thing it replaced, cut to a line.
  const long = `Uses bun now. ${'It is faster. '.repeat(40)}`.trim();
  s.save(said(long, { replaces: old.id }));
  const third = s.save(said('Back on pnpm after all.', { replaces: old.id })).note;
  assert.ok(third.replaced.startsWith('Uses bun now. It is faster.') && third.replaced.length === S.MEMORY_LIMITS.replaced && third.replaced.endsWith('…'));
  // A note with no title of its own was named by its first words: the new words name it now.
  const plain = s.save(said('Deploys go out on Tuesdays.')).note;
  assert.equal(s.save(said('Deploys go out daily now.', { replaces: plain.id })).note.title, 'Deploys go out daily now');
  // Across scopes: what was about the user becomes about this project, still one note, and Undo moves it back.
  const me = s.save({ text: 'Sign emails as Sam R. on its own line.', title: 'Email sign-off', scope: 'me', source: 'user-said' }).note;
  const here = s.save(said('In this repo sign emails as The Site Team.', { replaces: me.id })).note;
  assert.deepEqual([here.id, here.scope, here.project, here.title, here.replaced], [me.id, 'project', SITE, 'Email sign-off', 'Sign emails as Sam R. on its own line.']);
  assert.deepEqual([s.revert(me.id).scope, s.get(me.id).project], ['me', null]);
  // The same words saved again replace nothing: there is nothing to record, and what was recorded stays.
  const same = s.save(said('Back on pnpm after all.', { replaces: old.id }));
  assert.deepEqual([same.replaced, same.note.replaced], [null, third.replaced]);
  // A repeat found by its title records what it replaced too; an id that is no note's is a plain save.
  assert.equal(s.save(said('Back on pnpm 10 after all.', { title: 'Uses npm' })).note.replaced, 'Back on pnpm after all.');
  assert.deepEqual([s.save(said('Lint with pnpm lint before a commit.', { replaces: 'zzzzzz' })).action, s.save(said('Format with pnpm format.', { replaces: '../../etc' })).action], ['saved', 'saved']);
  // A note written by hand may carry the line; one without it has replaced nothing.
  fs.writeFileSync(path.join(s.dir, 'byhand.md'), '---\nscope: me\nreplaced: Liked tabs.\n---\nLikes spaces now.\n');
  assert.equal(s.get('byhand').replaced, 'Liked tabs.');
});

test('find: the one note a chat means, by id, by title, or by words only it has; never a guess', { skip: missing }, () => {
  const s = store();
  const pm = s.save(said('Uses pnpm, not npm.', { title: 'Package manager' })).note;
  const tests = s.save(said('Do not run pnpm test here: it hits staging. Use pnpm test:unit.', { title: 'Test command' })).note;
  const sign = s.save({ text: 'Sign emails as Sam R. on its own line.', title: 'Email sign-off', scope: 'me', source: 'user-said' }).note;
  const other = s.save(said('Releases are cut with make ship.', { title: 'Releases', project: '/work/other' })).note;
  const find = (ref, project = SITE) => s.find(ref, { project });
  assert.deepEqual(find(pm.id), { note: pm });
  assert.deepEqual(find(`[id ${tests.id}]`), { note: tests }, 'as recall writes an id');
  assert.deepEqual(find('package manager.'), { note: pm }, 'a title, whatever its case and punctuation');
  assert.deepEqual(find('"Email sign-off"'), { note: sign }, 'a note about the user is every chat\'s');
  assert.deepEqual(find('the note about staging'), { note: tests }, 'words only one note has');
  assert.deepEqual(find('sign emails'), { note: sign });
  // Words two notes have: both are offered, and neither is picked. A title that has them all settles it.
  assert.deepEqual(find('pnpm').several.map((n) => n.id).sort(), [pm.id, tests.id].sort());
  s.save(said('The test command above also needs NODE_ENV=test.', { title: 'Test environment' }));
  assert.deepEqual(find('test command'), { note: tests });
  // Nothing fits, or it is another project's note: nothing is found.
  assert.deepEqual(find('kubernetes'), {});
  assert.deepEqual(find('Releases'), {});
  assert.deepEqual(find(other.id), {});
  assert.deepEqual(find('Releases', '/work/other'), { note: other });
  for (const bad of ['', '   ', null, undefined, 'the note', '??']) assert.deepEqual(find(bad), {});
});

test('undo: a removed note comes back, and a replaced one goes back to what it said', { skip: missing }, () => {
  const s = store();
  const a = s.save(said('Uses npm for everything.', { title: 'Package manager' })).note;
  assert.deepEqual(s.state(a.id), { note: a, removed: false, previous: false });
  assert.deepEqual(s.remove(a.id), a);
  assert.equal(s.get(a.id), null);
  assert.deepEqual(s.all(), []);
  assert.deepEqual(s.state(a.id), { note: null, removed: true, previous: false });
  assert.deepEqual(s.restore(a.id), a);
  assert.deepEqual(s.all(), [a]);
  assert.deepEqual(s.restore(a.id), a, 'restoring a note that is there changes nothing');

  const b = s.save(said('Uses pnpm, not npm.', { title: 'Package manager' })).note;
  assert.equal(s.state(a.id).previous, true);
  assert.equal(s.revert(a.id).text, 'Uses npm for everything.');
  assert.equal(s.get(a.id).text, 'Uses npm for everything.');
  assert.equal(s.revert(a.id).text, b.text, 'a second revert undoes the first');
  assert.equal(s.get(a.id).text, 'Uses pnpm, not npm.');
  assert.equal(s.revert(s.save({ text: 'A brand new note.', scope: 'me' }).note.id), null, 'a note with no earlier wording has nothing to go back to');
});

test('the user\'s own edit: the note is theirs from then on', { skip: missing }, () => {
  const s = store();
  const a = s.save(said('Tests run with pnpm test.', { source: 'model-noticed' })).note;
  const r = s.edit(a.id, { text: 'Tests run with pnpm vitest run.', title: 'Test command' });
  assert.deepEqual([r.note.text, r.note.title, r.note.source, r.note.id, r.note.created], ['Tests run with pnpm vitest run.', 'Test command', 'user-said', a.id, a.created]);
  assert.ok(r.note.updated > a.updated);
  assert.deepEqual(s.get(a.id), r.note);
  assert.deepEqual(s.edit(a.id, {}).note, r.note, 'nothing changed, nothing written');
  assert.match(s.edit(a.id, { text: ' ' }).error, /needs some words/);
  assert.match(s.edit(a.id, { text: 'z'.repeat(700) }).error, /at most 600/);
  assert.match(s.edit('gone00', { text: 'x' }).error, /gone/);
});

test('search: the words asked for, title before text, this project before another', { skip: missing }, () => {
  const s = store();
  const pnpm = s.save(said('Uses pnpm, not npm. Run pnpm install and pnpm test.', { title: 'Package manager' })).note;
  const tests = s.save(said('Tests run with pnpm vitest run; the e2e ones need the dev server up.', { title: 'Running the tests' })).note;
  const other = s.save(said('Tests run with cargo test.', { title: 'Running the tests', project: '/work/engine' })).note;
  const short = s.save({ text: 'Keep answers to three lines unless asked for more.', title: 'Short answers', scope: 'me' }).note;
  const ids = (q, o) => s.search(q, o).map((x) => x.id);
  assert.deepEqual(ids('package manager'), [pnpm.id]);
  assert.deepEqual(ids('how do I run the tests', { project: SITE }), [tests.id, other.id, pnpm.id], 'this project first; a note that only mentions a test last');
  assert.deepEqual(ids('how do I run the tests', { project: '/work/engine' }).slice(0, 2), [other.id, tests.id]);
  assert.deepEqual(ids('answer length'), [short.id], 'a plural finds its singular');
  assert.deepEqual(ids('engine'), [other.id], 'a project is found by its folder\'s name');
  assert.deepEqual(ids('vites'), [tests.id], 'the start of a word is enough');
  assert.deepEqual(ids('kubernetes'), []);
  assert.deepEqual(ids('the and of'), [], 'filler words ask for nothing');
  assert.deepEqual(ids(''), []);
  assert.equal(s.search('tests pnpm answers', { limit: 2 }).length, 2);
  assert.deepEqual(s.relevant(SITE), { me: [short], project: [tests, pnpm] });
  assert.deepEqual(s.relevant(null), { me: [short], project: [] });
});

test('a folder\'s project is its repository: the root for a subfolder, the main checkout for a worktree', { skip: missing }, () => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'feature'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true });
  assert.equal(S.projectOf(repo), repo);
  assert.equal(S.projectOf(path.join(repo, 'packages', 'web')), repo);
  // A worktree: its .git is a file that points into the main checkout.
  const tree = path.join(root, 'repo-feature');
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feature')}\n`);
  assert.equal(S.projectOf(tree), repo);
  assert.equal(S.projectOf(path.join(tree, 'src')), repo);
  // A submodule's .git file points elsewhere: the folder is its own project.
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../repo/.git/modules/sub\n');
  assert.equal(S.projectOf(sub), sub);
  const plain = path.join(root, 'plain', 'folder');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(S.projectOf(plain), plain, 'no repository: the folder itself');
  assert.equal(S.projectOf(''), null);
  assert.equal(S.projectOf(undefined), null);
});

test('what a chat was told is kept for an hour past its last turn, and no longer', { skip: missing }, () => {
  const dir = path.join(root, `m${++n}`);
  let t = Date.parse('2026-11-19T10:00:00Z');
  const s = new S.MemoryStore({ dir, now: () => t, limits: { told: 3 } });
  const chat = '6a1f0c2e-1111-4222-8333-444455556666';
  assert.equal(s.told(chat), undefined, 'nothing kept yet');
  s.tell(chat, '# Canopy memory\n- Uses pnpm, not npm.');
  assert.equal(s.told(chat), '# Canopy memory\n- Uses pnpm, not npm.');
  t += 59 * 60_000;
  assert.equal(s.told(chat), '# Canopy memory\n- Uses pnpm, not npm.', 'still inside the hour');
  s.tell(chat, '# Canopy memory\n- Uses pnpm, not npm.'); // the end of another turn: the hour starts again
  t += 59 * 60_000;
  assert.equal(s.told(chat), '# Canopy memory\n- Uses pnpm, not npm.');
  t += 2 * 60_000;
  assert.equal(s.told(chat), undefined, 'past the hour the model\'s cache is gone, so the chat is told the notes as they are now');
  // A chat that was told nothing is kept as that: it is not then told something on its next start.
  s.tell(chat, '');
  assert.equal(s.told(chat), '');
  // None of this is a note, and none of it is found by a search.
  assert.deepEqual(s.all(), []);
  assert.deepEqual(fs.readdirSync(dir), ['.told']);
  // Only the newest few chats are kept, and a name that could leave the folder is refused.
  for (const id of ['chat-aaaa-0001', 'chat-aaaa-0002', 'chat-aaaa-0003', 'chat-aaaa-0004']) { t += 1000; s.tell(id, id); }
  assert.ok(fs.readdirSync(path.join(dir, '.told')).length <= 3);
  assert.equal(s.told('chat-aaaa-0004'), 'chat-aaaa-0004');
  for (const bad of ['../../../etc/passwd', '', null, 'short', 'has space in it', '.hidden-name']) { s.tell(bad, 'x'); assert.equal(s.told(bad), undefined); }
  s.tell('chat-aaaa-0005', null);
  assert.equal(s.told('chat-aaaa-0005'), undefined);
  assert.ok(fs.readdirSync(path.join(dir, '.told')).every((f) => /^chat-aaaa-000\d\.md$/.test(f) || f === `${chat}.md`));
});

// Canopy Memory where the window meets the engine: the names and the one line of text both sides must agree on.
// The window's files are .tsx and cannot be run here, so they are read (as settings-pages.test.mjs reads them).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { core } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const [M, S] = await Promise.all(['memory-tools.mjs', 'memory-store.mjs'].map((f) => core(f)));
// (What the engines do with the bridge is in memory-engines.test.mjs; here, what the app and the page do.)
const missing = [M, S].find((m) => m.__missing)?.__missing ?? false;

test('the window knows the three tools by the names the engine gives them', { skip: missing }, () => {
  const details = read('renderer/src/components/canopy/tool-details.tsx');
  assert.ok(details.includes(`export const REMEMBER_TOOL = '${M.REMEMBER_TOOL}';`));
  assert.ok(details.includes(`export const RECALL_TOOL = '${M.RECALL_TOOL}';`));
  assert.ok(details.includes(`export const FORGET_TOOL = '${M.FORGET_TOOL}';`));
  // None is a connector: no app mark beside them, and a save is never "Used Canopy memory".
  assert.match(read('renderer/src/components/canopy/tool-logos.tsx'), /const INTERNAL = new Set\(\[[^\]]*FORGET_TOOL,[^\]]*RECALL_TOOL, REMEMBER_TOOL[^\]]*\]\)/);
  // Home says what a chat is doing in words of its own for each.
  const chats = read('src/chats.mjs');
  assert.ok(chats.includes(`if (name === '${M.REMEMBER_TOOL}') return 'Saving to memory';`) && chats.includes(`if (name === '${M.RECALL_TOOL}') return 'Checking memory';`));
  assert.ok(chats.includes(`if (name === '${M.FORGET_TOOL}') return 'Removing from memory';`));
});

test('the Saved to memory row reads the note\'s id out of exactly what remember answers', { skip: missing }, () => {
  const row = read('renderer/src/components/canopy/memory-row.tsx');
  const theirs = /const SAVED = (\/.*\/);/.exec(row)?.[1];
  assert.equal(theirs, String(M.SAVED_RE), 'memory-row.tsx and memory-tools.mjs match one pattern');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'canopy-memory-ui-'));
  try {
    const ctx = { memory: new S.MemoryStore({ dir }), cwd: dir, sessionId: 'c', engine: 'claude' };
    const first = M.remember({ note: 'Uses pnpm, not npm.', title: 'Package manager', scope: 'me' }, ctx).content[0].text;
    const again = M.remember({ note: 'Uses pnpm 10, not npm.', title: 'Package manager', scope: 'me' }, ctx).content[0].text;
    const re = new RegExp(theirs.slice(1, -1));
    assert.deepEqual([re.exec(first)[1], re.exec(again)[1]], ['Saved to', 'Updated in'], 'a new note is undone by removing it, a replaced one by putting the old words back');
    assert.equal(re.exec(first)[2], re.exec(again)[2]);
    assert.equal(re.exec(M.remember({ note: 'The key is sk-live-9f8e7d6c5b4a3f2e1d0c', scope: 'me' }, ctx).content[0].text), null, 'a refused save has no row');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The row stays in view when a turn's work folds away, and is drawn by the row, not as a generic step: a save
  // and a removal alike.
  const transcript = read('renderer/src/components/canopy/transcript.tsx');
  assert.ok(transcript.includes("const isMemory = (it: Item): boolean => it.t === 'tool' && (it.name === REMEMBER_TOOL || it.name === FORGET_TOOL);"));
  assert.match(transcript, /const isShow = .*it\.name === SHOW_TOOL\) \|\| isMemory\(it\)/);
  assert.ok(transcript.includes('if (item.name === REMEMBER_TOOL || item.name === FORGET_TOOL) return <MemoryRow item={item} />;'));
});

test('the row reads a removal, what a save replaced and what a removed note said out of what the tools answer', { skip: missing }, () => {
  const row = read('renderer/src/components/canopy/memory-row.tsx');
  const pattern = (name) => new RegExp(new RegExp(`const ${name} = (\\/.*\\/);`).exec(row)[1].slice(1, -1));
  assert.equal(String(pattern('FORGOT')), String(M.FORGOT_RE), 'memory-row.tsx and memory-tools.mjs match one pattern');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'canopy-memory-ui-'));
  try {
    const ctx = { memory: new S.MemoryStore({ dir }), cwd: dir, sessionId: 'c', engine: 'claude' };
    const text = (r) => r.content[0].text;
    const id = M.SAVED_RE.exec(text(M.remember({ note: 'Sign emails as "Sam R." on its own line.', title: 'Email sign-off', scope: 'me' }, ctx)))[2];
    // A save that replaced a note: the row's hover says what the note said before, quotes and full stops and all.
    const changed = text(M.remember({ note: 'Sign emails as "Samuel Rivera".', scope: 'me', replaces: 'Email sign-off' }, ctx));
    assert.equal(pattern('REPLACED').exec(changed)[1], 'Sign emails as "Sam R." on its own line.');
    assert.equal(pattern('REPLACED').exec(text(M.remember({ note: 'Keep answers to three lines.', scope: 'me' }, ctx))), null, 'a new note replaced nothing');
    // A removal: the note's id (for Undo), its title (what the row says), and what it said (the row's hover).
    const gone = text(M.forget({ note: 'Email sign-off' }, ctx));
    assert.deepEqual(pattern('FORGOT').exec(gone).slice(1), [id, 'Email sign-off']);
    assert.equal(pattern('IT_SAID').exec(gone)[1], 'Sign emails as "Samuel Rivera".');
    assert.equal(pattern('FORGOT').exec(text(M.forget({ note: 'no such note' }, ctx))), null, 'a removal that did not happen has no row');
    // Undo on the row is the store's restore: the note is back as it was, with what it had replaced.
    assert.deepEqual([ctx.memory.state(id).removed, ctx.memory.restore(id).replaced], [true, 'Sign emails as "Sam R." on its own line.']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // A removal reads the other way round from a save, and nothing moves when either is undone: one fixed-height line.
  assert.ok(row.includes("stand === 'kept' ? 'Kept in memory' : 'Forgot'") && row.includes("forgot ? (stand === 'kept' ? 'Remove' : 'Undo')"));
  assert.ok(row.includes("'flex h-7 min-w-0 items-center gap-2 text-small text-muted-foreground'"));
});

test('Settings opens Memory from You, the page\'s cap is the store\'s, and the bridge names every call main answers', { skip: missing }, () => {
  const dialog = read('renderer/src/components/canopy/settings-dialog.tsx');
  assert.ok(dialog.includes("memory: { page: 'memory' }") && dialog.includes("{!opened && section === 'memory' && <MemoryPage />}"));
  assert.match(dialog, /\{ id: 'memory', label: 'Memory',.*words: '[^']*\bmemory\b[^']*\bnotes\b/);
  assert.equal(Number(/const LIMIT = (\d+);/.exec(read('renderer/src/components/canopy/settings/memory-page.tsx'))[1]), S.MEMORY_LIMITS.text);
  const main = read('src/main.mjs');
  const preload = read('src/preload.cjs');
  const answered = [...main.matchAll(/handle\('memory:([a-z]+)'/g)].map((m) => m[1]).sort();
  const asked = [...preload.matchAll(/ipcRenderer\.invoke\('memory:([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(answered, ['bridge', 'edit', 'get', 'list', 'remove', 'restore', 'revert', 'set', 'state']);
  assert.deepEqual(asked, answered);
  // Both makers' chats are handed the one store: a new chat by the switch, a reopened one as it started.
  assert.ok(main.includes('memory: startsWithMemory(loadState().chatTools, o.resume, memoryOn()) ? memory : null, memoryBridge: bridgeOn(),'), 'a Codex chat');
  assert.ok(main.includes('memory: (pinned?.memory ?? memoryOn()) ? memory : null, memoryBridge: bridgeOn(),') && main.includes('const pinned = startedWith(loadState().chatTools, o.resume);'), 'a Claude chat');
  // What each chat started with is recorded for both makers' chats, not Claude's alone.
  assert.match(main, /if \(ev\.kind === 'init' \|\| ev\.kind === 'turn-end'\) \{\n\s+const chatTools = rememberTools\(loadState\(\)\.chatTools, entry\.sessionId, chats\.manager\.get\(ev\.sid\)\?\.startedWith\);/);
  // A note is shown with what it replaced.
  assert.match(main, /const noteView = .*replaced: n\.replaced \?\? null/);
});

// One maker's notes about the user go to the other maker's model only when the user said so.
test('sharing Claude Code\'s and Codex\'s own memory is on unless the user turns it off, and the page says what it sends where', { skip: missing }, () => {
  const main = read('src/main.mjs');
  assert.ok(main.includes('function bridgeOn() { return loadState().memoryBridge !== false; }'), 'only a saved no turns it off: a new install has it on');
  assert.ok(main.includes('function memoryOn() { return loadState().memory !== false; }'), 'Canopy Memory itself is on unless turned off');
  assert.ok(main.includes("handle('memory:bridge', (on) => { saveState({ memoryBridge: on === true });"), 'what the user chose is kept as they chose it');
  const page = read('renderer/src/components/canopy/settings/memory-page.tsx');
  assert.ok(page.includes('const [bridge, setBridge] = useState(true);'), 'the switch is drawn on until main says otherwise');
  // The explanation is on the page whether the switch is on or off, and names both makers.
  assert.ok(page.includes('That sends what Claude Code noted about you to OpenAI and what Codex noted to Anthropic. Turn it off to keep each maker’s notes to itself.'));
  assert.match(page, /<Switch label="Share Claude Code’s and Codex’s own memory with each other" on=\{bridge\} onChange=\{flipBridge\} disabled=\{on !== true\} \/>/, 'one click turns it off');
  assert.ok(page.includes('A chat keeps what it started with, so the switch is for new chats.'));
  // The window's stand-in starts the same way.
  assert.ok(read('scripts/ui-harness.mjs').includes("let memoryBridge = q.get('bridge') !== '0';"));
});

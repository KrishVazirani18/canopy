// Settings' pages, read from the window's source (a .tsx file cannot be run here): which pages there are, what the
// search finds on them, and that everything that opens Settings at a page names one it knows. A page that is renamed or removed while something still opens it would otherwise
// only show up as Settings opening on General.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../renderer/src');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));

// The list in settings-dialog.tsx, one page a line: { id, label, icon, group, words }.
const pages = [...read('components/canopy/settings-dialog.tsx').matchAll(/^\s*\{ id: '([a-z]+)', label: '([^']+)', icon: \w+, group: \d+, words: '([^']*)' \},$/gm)]
  .map((m) => ({ id: m[1], label: m[2], words: m[3] }));
const finds = (page, typed) => `${page.label} ${page.words}`.toLowerCase().includes(typed); // the search's own rule

test('the pages of Settings: six, Advanced set apart; search finds what moved onto them', () => {
  assert.deepEqual(pages.map((p) => [p.id, p.label]), [['you', 'You'], ['memory', 'Memory'], ['chats', 'Chats'], ['accounts', 'Accounts'], ['tools', 'Tools'], ['advanced', 'Advanced']]);
  const found = (typed) => pages.filter((p) => finds(p, typed)).map((p) => p.id);
  // What someone looking for their logins types brings up Accounts (and You, for Canopy's own sign-in).
  for (const typed of ['api key', 'login', 'max', 'chatgpt', 'computer use', 'update']) assert.ok(found(typed).includes('accounts'), typed);
  assert.deepEqual(found('sign out'), ['you']);
  assert.deepEqual(found('usage stats'), ['you']);
  assert.deepEqual(found('theme'), ['chats']);
  assert.deepEqual(found('effort'), ['chats']);
  for (const typed of ['memory', 'notes', 'remember']) assert.deepEqual(found(typed), ['memory'], typed);
  for (const typed of ['connectors', 'skills', 'plugins', 'mcp']) assert.deepEqual(found(typed), ['tools'], typed);
  for (const typed of ['shortcuts', 'code mode', 'canopy kit', 'config', 'versions']) assert.deepEqual(found(typed), ['advanced'], typed);
});

test('everything that opens Settings at a page names a page that exists', () => {
  // A page, or a name Settings knows where to open (OPENS: the parts that moved onto the five pages).
  const opens = read('components/canopy/settings-dialog.tsx').match(/const OPENS[^=]*= \{([\s\S]*?)\n\};/)?.[1] ?? '';
  const ids = new Set([...pages.map((p) => p.id), ...[...opens.matchAll(/(\w+): \{ page:/g)].map((m) => m[1])]);
  const opened = [];
  for (const file of walk(SRC)) {
    if (file.includes(`${path.sep}playground${path.sep}`)) continue; // design mock-ups, with pages of their own
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/openSettings\(([^)]*)\)/g)) {
      const arg = m[1].trim();
      if (!arg || /^section\b/.test(arg)) continue; // Settings as it last was, and the function's own definition
      opened.push([path.relative(SRC, file), arg]);
    }
  }
  assert.ok(opened.length >= 3, `the openers were found (${opened.length})`);
  for (const [file, arg] of opened) {
    // A page by name, or one of two by the maker (lib/signin.ts `openAccounts`).
    const named = [...arg.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `${file}: openSettings(${arg}) names its page in so many words`);
    for (const id of named) assert.ok(ids.has(id), `${file}: openSettings(${arg}) opens "${id}", which is not a page`);
  }
});

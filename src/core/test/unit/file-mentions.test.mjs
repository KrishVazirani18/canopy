// Files attached to a message travel as @mentions and show as cards (renderer/src/lib/file-mentions.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileLabel, mentionOf, splitFiles, withFiles } from '../../../../renderer/src/lib/file-mentions.ts';

const PDF = '/Users/me/Downloads/Quarterly_Report.pdf';
const SPACED = '/Users/me/Downloads/Meeting notes.pdf';

test('a path is mentioned as written, quoted with a space, and from the project when inside it', () => {
  assert.equal(mentionOf(PDF), `@${PDF}`);
  assert.equal(mentionOf(SPACED), `@"${SPACED}"`);
  assert.equal(mentionOf('/p/src/a.ts', '/p'), '@src/a.ts');
});

test('sent, the files are the last paragraph; read back, they come off as files', () => {
  const sent = withFiles('help me out here.', [PDF, SPACED]);
  assert.equal(sent, `help me out here.\n\n@${PDF} @"${SPACED}"`);
  assert.deepEqual(splitFiles(sent), { text: 'help me out here.', files: [PDF, SPACED] });
  assert.deepEqual(splitFiles(withFiles('', [PDF])), { text: '', files: [PDF] });
  // Dropped in before this change: the mentions came first, on their own.
  assert.deepEqual(splitFiles(`@${PDF}\n\nhelp me out here.`), { text: 'help me out here.', files: [PDF] });
});

test('a mention inside a sentence, or "@someone", stays in the words', () => {
  assert.deepEqual(splitFiles('look at @src/a.ts please'), { text: 'look at @src/a.ts please', files: [] });
  assert.deepEqual(splitFiles('thanks\n\n@sam'), { text: 'thanks\n\n@sam', files: [] });
  assert.deepEqual(splitFiles('plain'), { text: 'plain', files: [] });
});

test('a card says the name and the kind', () => {
  assert.deepEqual(fileLabel(SPACED), { name: 'Meeting notes.pdf', kind: 'PDF' });
  assert.deepEqual(fileLabel('/Users/me/Makefile'), { name: 'Makefile', kind: 'File' });
});

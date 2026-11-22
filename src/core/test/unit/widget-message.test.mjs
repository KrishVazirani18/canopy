// What a widget may answer with (renderer/src/components/canopy/widget-message.ts): words, as one text block or a list
// of blocks, and up to four PNG or JPEG pictures of at most 5 MB, which become the message's attachments. Anything
// else refuses the whole answer, so a widget cannot slip something past the host.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

const { readAnswer, base64Bytes, MAX_IMAGE_BYTES } = await import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/components/canopy/widget-message.ts')).href);

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

test('the old single text block still works', () => {
  assert.deepEqual(readAnswer({ role: 'user', content: { type: 'text', text: '  Go with Leaf  ' } }), { text: 'Go with Leaf', images: [] });
});

test('a list of blocks carries words and pictures', () => {
  const r = readAnswer({ role: 'user', content: [{ type: 'text', text: 'Notes on the page:\n1. x: y' }, { type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'image', data: PNG, mimeType: 'IMAGE/JPEG' }] });
  assert.equal(r.text, 'Notes on the page:\n1. x: y');
  assert.deepEqual(r.images, [{ mediaType: 'image/png', data: PNG }, { mediaType: 'image/jpeg', data: PNG }]);
});

test('anything off refuses the whole answer', () => {
  const img = (over) => ({ type: 'image', data: PNG, mimeType: 'image/png', ...over });
  const bad = [
    null,
    { role: 'assistant', content: { type: 'text', text: 'x' } },
    { role: 'user' },
    { role: 'user', content: [] },
    { role: 'user', content: { type: 'text', text: '   ' } },
    { role: 'user', content: [img()] }, // a picture with no words
    { role: 'user', content: [{ type: 'text', text: 'x' }, img({ mimeType: 'image/svg+xml' })] },
    { role: 'user', content: [{ type: 'text', text: 'x' }, img({ mimeType: 'image/gif' })] },
    { role: 'user', content: [{ type: 'text', text: 'x' }, img({ data: 'not base64!' })] },
    { role: 'user', content: [{ type: 'text', text: 'x' }, img({ data: 'data:image/png;base64,' + PNG })] },
    { role: 'user', content: [{ type: 'text', text: 'x' }, img({ data: 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 3) / 3) * 4) })] },
    { role: 'user', content: [{ type: 'text', text: 'x' }, img(), img(), img(), img(), img()] },
    { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'resource', uri: 'file:///etc/passwd' }] },
    { role: 'user', content: [{ type: 'text', text: 42 }] },
  ];
  for (const p of bad) assert.ok('error' in readAnswer(p), JSON.stringify(p)?.slice(0, 120));
  // Four is fine.
  assert.equal(readAnswer({ role: 'user', content: [{ type: 'text', text: 'x' }, img(), img(), img(), img()] }).images.length, 4);
});

test('words are kept to 4000 characters', () => {
  assert.equal(readAnswer({ role: 'user', content: { type: 'text', text: 'a'.repeat(5000) } }).text.length, 4000);
});

test('the size of a picture is read from its base64', () => {
  assert.equal(base64Bytes(Buffer.from('abc').toString('base64')), 3);
  assert.equal(base64Bytes(Buffer.from('abcd').toString('base64')), 4);
  assert.equal(base64Bytes(Buffer.from('abcde').toString('base64')), 5);
});

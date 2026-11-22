// When you last wrote to a chat (src/last-active.mjs): the sidebar's order, so replies and helpers never reorder it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastActive, lastPrompt, lastReply, previewOf } from '../../../last-active.mjs';

const at = (n) => new Date(Date.UTC(2026, 10, 15, 12, 0, n)).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const you = (n, content = 'fix the sidebar') => line({ type: 'user', origin: { kind: 'human' }, timestamp: at(n), message: { role: 'user', content } });
const claude = (n) => line({ type: 'assistant', timestamp: at(n), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
const toolResult = (n) => line({ type: 'user', timestamp: at(n), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const taskNote = (n) => line({ type: 'user', origin: { kind: 'task-notification' }, timestamp: at(n), message: { role: 'user', content: '<task-notification>…</task-notification>' } });
const interrupt = (n) => line({ type: 'user', timestamp: at(n), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
const bookkeeping = () => line({ type: 'last-prompt', lastPrompt: 'fix the sidebar' });

function setup() {
  const config = mkdtempSync(path.join(os.tmpdir(), 'canopy-last-'));
  const dir = '/p/canopy';
  const folder = path.join(config, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 's1.jsonl');
  return { config, dir, file, done: () => rmSync(config, { recursive: true, force: true }) };
}

test('lastPrompt: your last message, not Claude’s replies, tool results, task notifications or interrupts', async () => {
  const t = setup();
  try {
    writeFileSync(t.file, you(1) + claude(2) + toolResult(3) + claude(4) + taskNote(5) + interrupt(6) + bookkeeping());
    assert.equal(await lastPrompt('s1', t.dir, t.config), Date.parse(at(1)));
    assert.equal(await lastActive('s1', t.dir, t.config), Date.parse(at(6))); // the old "any message" time moved on
  } finally { t.done(); }
});

test('lastPrompt: a working chat only moves when you write again (read as the file grows)', async () => {
  const t = setup();
  try {
    writeFileSync(t.file, you(1) + claude(2));
    assert.equal(await lastPrompt('s1', t.dir, t.config), Date.parse(at(1)));
    appendFileSync(t.file, toolResult(3) + claude(4));
    assert.equal(await lastPrompt('s1', t.dir, t.config), Date.parse(at(1)));
    // A line caught mid-write is read again once it's complete.
    const next = you(5, 'and rename too');
    appendFileSync(t.file, next.slice(0, 20));
    assert.equal(await lastPrompt('s1', t.dir, t.config), Date.parse(at(1)));
    appendFileSync(t.file, next.slice(20));
    assert.equal(await lastPrompt('s1', t.dir, t.config), Date.parse(at(5)));
  } finally { t.done(); }
});

test('lastPrompt: finds your message behind long tool output, and in transcripts from before "origin"', async () => {
  const t = setup();
  try {
    const legacy = line({ type: 'user', timestamp: at(1), message: { role: 'user', content: 'old style prompt' } });
    const big = Array.from({ length: 40 }, (_, i) => line({ type: 'user', timestamp: at(2), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(40_000) }] } })).join('');
    writeFileSync(t.file, legacy + big + claude(3));
    assert.equal(await lastPrompt('s1', t.dir, t.config), Date.parse(at(1)));
  } finally { t.done(); }
});

test('lastPrompt: no message of yours yet, or no transcript, is null', async () => {
  const t = setup();
  try {
    assert.equal(await lastPrompt('s1', t.dir, t.config), null);
    writeFileSync(t.file, bookkeeping() + claude(1));
    assert.equal(await lastPrompt('s1', t.dir, t.config), null);
  } finally { t.done(); }
});

const said = (n, text, extra = {}) => line({ type: 'assistant', timestamp: at(n), message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

test('lastReply: Claude’s last reply as one plain line, skipping helpers and tool-only turns', async () => {
  const t = setup();
  try {
    writeFileSync(t.file, you(1) + said(2, '## Fixed\n\nThe **link** opens the draft now.') + said(3, 'helper note', { isSidechain: true })
      + line({ type: 'assistant', timestamp: at(4), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }));
    assert.equal(await lastReply('s1', t.dir, t.config), 'The link opens the draft now.');
    appendFileSync(t.file, said(5, 'Rent is $1,240 with [parking](https://x). The offer ends Friday.'));
    assert.equal(await lastReply('s1', t.dir, t.config), 'Rent is $1,240 with parking. The offer ends Friday.');
  } finally { t.done(); }
});

test('previewOf: first real line, markdown stripped, long lines cut', () => {
  assert.equal(previewOf('```js\ncode\n```'), 'code');
  assert.equal(previewOf('- **Done.** Everyone is in.'), 'Done. Everyone is in.');
  assert.equal(previewOf(''), null);
  assert.equal(previewOf('## Only a heading'), 'Only a heading');
  assert.equal(previewOf('x'.repeat(200)).length, 160);
});

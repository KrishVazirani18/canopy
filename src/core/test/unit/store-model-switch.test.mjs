// "Switched to Fable 5.2": the quiet line a chat shows where its model changed (renderer/src/lib/store.ts). Live, when
// the chat confirms a model you picked; from history, above the message whose reply ran another model than the one
// before. A chat opening on its own model, or picked up running, says nothing.
//
// The store is the real one, with the window stood in for as in store-output-earlier.test.mjs.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

// The renderer imports its own files without an extension (the bundler's way): try `.ts` when a bare path isn't found.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (err) {
      if (specifier.startsWith('.') && !path.extname(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const canopy = {
  send: () => Promise.resolve({ ok: true }), interrupt: () => Promise.resolve(), set: () => Promise.resolve(), respond: () => Promise.resolve(),
  context: () => Promise.resolve(null), queue: () => Promise.resolve({ ok: true, queue: [], v: 1 }), unqueue: () => Promise.resolve({ ok: true, removed: true, queue: [], v: 2 }),
};
globalThis.window = { canopy, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);

const lib = (file) => import(pathToFileURL(path.resolve(HERE, '../../../renderer/src/lib', file)).href).catch((err) => ({ __missing: String(err?.message ?? err) }));
const S = await lib('store.ts');
const missing = S.__missing ?? false;

const ROWS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'fable[1m]', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', description: 'Fable 5.2 · Most capable' },
];
const lines = (s) => s.items.filter((i) => i.t === 'notice').map((i) => i.text);
const said = (s) => s.items.map((i) => (i.t === 'user' ? `you:${i.text}` : i.t === 'assistant' ? `reply:${i.model}` : i.t === 'notice' ? `— ${i.text}` : i.t)).join(' | ');
function chat() {
  const s = new S.Store();
  s.handle({ kind: 'meta', models: ROWS });
  return s;
}

test('a model picked in a chat with a conversation says so, once; the model a chat opens with does not', { skip: missing }, () => {
  const s = chat();
  s.handle({ kind: 'setting', key: 'model', value: '' }); // the chat opened on the default
  assert.deepEqual(lines(s), [], 'nothing to say yet: no conversation');
  s.addUser('hi', 0);
  s.handle({ kind: 'assistant-text', text: 'hello', model: 'claude-opus-5-5' });
  s.handle({ kind: 'setting', key: 'model', value: 'fable[1m]' });
  s.handle({ kind: 'setting', key: 'model', value: 'fable[1m]' }); // said again: nothing changed
  assert.deepEqual(lines(s), ['Switched to Fable 5.2']);
  s.handle({ kind: 'setting', key: 'model', value: '' });
  assert.deepEqual(lines(s), ['Switched to Fable 5.2', 'Switched to Opus 5.5'], 'back to the default, by its name');
});

test('a reopened chat told the model its last reply ran says nothing; told another, it says so', { skip: missing }, () => {
  const s = chat();
  s.loadHistory([{ kind: 'user-text', text: 'hi' }, { kind: 'assistant-text', text: 'hello', model: 'claude-fable-5-2' }]);
  s.handle({ kind: 'setting', key: 'model', value: 'fable[1m]' });
  assert.deepEqual(lines(s), []);
  const t = chat();
  t.loadHistory([{ kind: 'user-text', text: 'hi' }, { kind: 'assistant-text', text: 'hello', model: 'claude-fable-5-2' }]);
  t.handle({ kind: 'setting', key: 'model', value: 'opus' });
  assert.deepEqual(lines(t), ['Switched to Opus 5.5']);
});

test('history shows the switch above the message whose reply ran the other model', { skip: missing }, () => {
  const s = chat();
  s.loadHistory([
    { kind: 'user-text', text: 'one' }, { kind: 'assistant-text', text: 'a', model: 'claude-opus-5-5' },
    { kind: 'user-text', text: 'two' }, { kind: 'assistant-text', text: 'b', model: 'claude-opus-5-5' },
    { kind: 'user-text', text: 'three' }, { kind: 'assistant-text', text: 'c', model: 'claude-fable-5-2' },
  ]);
  assert.equal(said(s), 'you:one | reply:claude-opus-5-5 | you:two | reply:claude-opus-5-5 | — Switched to Fable 5.2 | you:three | reply:claude-fable-5-2');
});

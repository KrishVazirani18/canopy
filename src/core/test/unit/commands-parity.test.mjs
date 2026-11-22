// One `/` command, one meaning, whichever maker runs the chat (renderer/src/lib/commands.ts): every command Canopy
// handles itself is run in a Claude chat and in an OpenAI chat and must do the same thing in both; the commands a
// chat's own session reads (/compact, /review, /goal) pass through in both; and the ones that are Claude Code's own
// screens say one plain sentence in an OpenAI chat instead of opening.
//
// The module is the real one. Node reads its TypeScript as it is; the window's pieces it reaches for (the bridge to
// main, storage, events, toasts, the two controls it calls) are stood in for here and record what was asked of them.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HERE } from '../helpers.mjs';

const LIB = path.resolve(HERE, '../../../renderer/src/lib');
const did = [];
globalThis.__did = did;
const stub = (code) => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Toasts and the two controls are recorded, not drawn.
    if (specifier === 'sonner') return stub('const t = (...a) => globalThis.__did.push(["toast", ...a.slice(0, 1)]); t.error = (...a) => globalThis.__did.push(["toast-error", ...a.slice(0, 1)]); export const toast = t;');
    if (specifier === '@/components/canopy/controls') return stub('export const modelLabel = (meta, v) => v || "Default"; export const setMode = (mode) => globalThis.__did.push(["mode", mode]);');
    if (specifier.startsWith('@/lib/')) return nextResolve(pathToFileURL(path.join(LIB, `${specifier.slice(6)}.ts`)).href, context);
    try { return nextResolve(specifier, context); }
    catch (err) {
      if (specifier.startsWith('.') && !path.extname(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const OPENAI = [
  { value: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: '', engine: 'codex', maker: 'openai', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsFastMode: true, isDefault: true },
  { value: 'gpt-6-luna', displayName: 'GPT-6 Luna', description: '', engine: 'codex', maker: 'openai', supportsEffort: true, supportedEffortLevels: ['low', 'medium'], defaultEffort: 'low', supportsFastMode: false, isDefault: false },
];
const CLAUDE = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers' },
];
globalThis.window = {
  canopy: {
    models: () => Promise.resolve({ claude: CLAUDE, openai: OPENAI, codex: { installed: true, signedIn: true, version: '0.153.4' } }),
    rename: (id, title, cwd) => { did.push(['rename', id, title, cwd]); return Promise.resolve(); },
    context: () => Promise.resolve(null), send: () => Promise.resolve({ ok: true }), set: () => Promise.resolve(),
  },
  addEventListener() {}, removeEventListener() {},
  dispatchEvent(e) { did.push(['event', e.type, e.detail ?? null]); return true; },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);
globalThis.confirm = () => true;

const lib = (file) => import(pathToFileURL(path.join(LIB, file)).href);
const [C, S, E, U] = await Promise.all([lib('commands.ts'), lib('store.ts'), lib('engines.ts'), lib('ui.ts')]);
E.loadModels();
await new Promise((r) => setTimeout(r, 0));

const CHAT = '11111111-2222-4333-8444-555555555555';
function chat(engine) {
  const s = new S.Store();
  s.setEngine(engine);
  s.setMeta({ sessionId: CHAT, model: engine === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', models: engine === 'codex' ? [] : CLAUDE,
    commands: engine === 'codex' ? [{ name: 'compact' }, { name: 'review' }, { name: 'goal' }] : [{ name: 'compact' }, { name: 'review' }, { name: 'init' }] });
  return s;
}
/** Run a typed command in a chat of that maker: whether Canopy handled it, and everything it did. */
async function run(engine, text) {
  const store = chat(engine);
  U.ui.set({ palette: false, tab: 'changes', inspector: false });
  did.length = 0;
  const handled = C.runCommand(text, { cwd: '/w', store });
  await new Promise((r) => setTimeout(r, 5)); // /help prefills on the next tick
  const u = U.ui.get();
  return { handled, did: did.map((d) => JSON.stringify(d)), ui: { palette: u.palette, tab: u.tab, inspector: u.inspector } };
}
beforeEach(() => { did.length = 0; });

test('the commands Canopy runs itself do the same thing in a Claude chat and an OpenAI chat', async () => {
  const same = [
    '/model', '/effort', '/effort status', '/effort low', '/effort auto', '/fast', '/fast on', '/fast off', '/plan', '/plan tidy the importer',
    '/permissions', '/permissions plan', '/permissions ask', '/clear', '/reset', '/new', '/resume', '/rename Importer work', '/rename',
    '/context', '/cost', '/usage', '/stats', '/diff', '/status', '/help', '/theme', '/exit', '/mcp',
  ];
  for (const text of same) {
    const claude = await run('claude', text);
    const codex = await run('codex', text);
    assert.deepEqual(codex, claude, text);
    assert.ok(claude.handled || text.startsWith('/plan '), `${text} is handled by Canopy`);
  }
});

test('each of them really does its job (so "the same" is not "the same nothing")', async () => {
  const has = (r, ...needle) => r.did.some((d) => needle.every((n) => d.includes(n)));
  for (const engine of ['claude', 'codex']) {
    assert.ok(has(await run(engine, '/model'), 'canopy:open-menu', 'model'), 'the model menu opens');
    assert.ok(has(await run(engine, '/effort low'), 'canopy:control', '"key":"effort"', '"value":"low"'));
    assert.ok(has(await run(engine, '/fast on'), 'canopy:control', '"key":"fast"', '"value":true'));
    const plan = await run(engine, '/plan');
    assert.ok(plan.handled && has(plan, 'mode', 'plan'));
    const planned = await run(engine, '/plan tidy the importer');
    assert.equal(planned.handled, false, 'the task after /plan is sent as a message, in Plan mode');
    assert.ok(has(planned, 'mode', 'plan'));
    assert.ok(has(await run(engine, '/permissions ask'), 'mode', 'default'));
    assert.ok(has(await run(engine, '/permissions'), 'canopy:open-menu', 'mode'));
    assert.ok(has(await run(engine, '/clear'), 'canopy:new-session'));
    assert.ok(has(await run(engine, '/rename Importer work'), 'rename', CHAT, 'Importer work'));
    assert.ok(has(await run(engine, '/rename'), 'toast', 'Send a message first, then use /rename <title>.'));
    assert.deepEqual([(await run(engine, '/context')).ui.tab, (await run(engine, '/context')).ui.inspector], ['stats', true]);
    assert.equal((await run(engine, '/diff')).ui.tab, 'changes');
    assert.ok(has(await run(engine, '/status'), 'canopy:chat-menu'));
    assert.ok(has(await run(engine, '/help'), 'canopy:prefill', '/'));
    assert.equal((await run(engine, '/resume')).ui.palette, true);
  }
});

test('/model with a name picks that model for the chat\'s own maker first', async () => {
  const claude = await run('claude', '/model haiku');
  assert.ok(claude.did.some((d) => d.includes('canopy:control') && d.includes('"value":"haiku"') && d.includes('"engine":"claude"')));
  const codex = await run('codex', '/model luna');
  assert.ok(codex.did.some((d) => d.includes('canopy:control') && d.includes('"value":"gpt-6-luna"') && d.includes('"engine":"codex"')));
  assert.ok(codex.did.some((d) => d.includes('Switched to GPT-6 Luna')));
});

test('/effort takes the levels the chat\'s own model has', async () => {
  const bad = await run('codex', '/effort max');
  assert.ok(bad.did.some((d) => d.includes('toast-error') && d.includes('isn’t an effort level on this model')), 'this OpenAI model has no "max"');
  assert.ok((await run('claude', '/effort max')).did.some((d) => d.includes('"key":"effort"') && d.includes('"value":"max"')));
  assert.ok((await run('codex', '/effort high')).did.some((d) => d.includes('"key":"effort"') && d.includes('"value":"high"')));
});

test('/compact, /review and /goal are the chat\'s own to read, in both: Canopy passes them through untouched', async () => {
  for (const text of ['/compact', '/review', '/review branch main', '/goal ship the importer', '/goal']) {
    for (const engine of ['claude', 'codex']) {
      const r = await run(engine, text);
      assert.equal(r.handled, false, `${text} in a ${engine} chat goes out as the message it is`);
      assert.deepEqual(r.did, [], 'and nothing else happens in the window');
    }
  }
});

test('what is Claude Code\'s own says one plain sentence in an OpenAI chat, and still works in a Claude chat', async () => {
  for (const text of ['/config', '/login', '/doctor', '/codemode', '/ultracode', '/effort ultracode']) {
    const codex = await run('codex', text);
    assert.equal(codex.handled, true, text);
    assert.deepEqual(codex.did, [JSON.stringify(['toast', 'That one works in Claude chats.'])], text);
  }
  const config = await run('claude', '/config');
  assert.deepEqual([config.handled, config.ui.tab], [true, 'terminal'], 'a Claude chat opens the real screen in the Terminal tab');
  assert.ok((await run('claude', '/codemode on')).did.some((d) => d.includes('"key":"codeMode"') && d.includes('"value":true')));
  assert.ok((await run('claude', '/ultracode')).did.some((d) => d.includes('"key":"ultracode"')));
});

test('a message that is not a command is never handled here', async () => {
  for (const text of ['hello', 'use /model sol please', '/', '//comment', '/unknown-thing']) {
    for (const engine of ['claude', 'codex']) assert.equal((await run(engine, text)).handled, false, text);
  }
});

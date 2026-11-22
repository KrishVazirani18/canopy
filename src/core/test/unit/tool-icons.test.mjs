import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { toolIcons } from '../../tool-icons.mjs';
import { adapt as claude } from '../../adapter.mjs';
import { createAdapter } from '../../codex-adapter.mjs';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (err) { if (specifier.startsWith('.') && !path.extname(specifier)) return next(`${specifier}.ts`, context); throw err; }
} });
globalThis.window = { canopy: {}, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { Store } = await import('../../../../renderer/src/lib/store.ts');
const { catalogBrands, chooseIcon } = await import('../../../../renderer/src/lib/tool-branding.ts');
const LOGO = 'https://example.com/logo.png';
const OTHER = 'https://example.com/dark.png';
const icons = [{ src: LOGO }];

test('icons accept bounded image URLs and embedded images; reject executable, file, credential and non-image URLs', () => {
  assert.deepEqual(toolIcons({ icons }), icons);
  assert.deepEqual(toolIcons({ meta: { logo: LOGO } }), icons);
  assert.equal(toolIcons({ icons: [{ src: 'data:image/png;base64,AAAA' }] }).length, 1);
  for (const src of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/a', 'data:text/html,<script/>', 'https://user:pass@example.com/logo', 'x'.repeat(256001)]) {
    assert.deepEqual(toolIcons({ icons: [{ src }] }), [], src.slice(0, 40));
  }
  assert.deepEqual(toolIcons({ icons: [{ src: LOGO, mimeType: 'text/html' }] }), []);
  assert.equal(toolIcons({ icons: Array.from({ length: 100 }, () => ({ src: LOGO })) }).length, 8);
});

test('theme variants and broken images fall back without choosing the opposite theme', () => {
  const variants = [{ src: LOGO, theme: 'light' }, { src: OTHER, theme: 'dark' }, { src: 'https://example.com/plain.png' }];
  assert.equal(chooseIcon(variants, true), OTHER);
  assert.equal(chooseIcon(variants, false), LOGO);
  assert.equal(chooseIcon(variants, true, [OTHER]), 'https://example.com/plain.png');
  assert.equal(chooseIcon(variants.slice(0, 2), true, [OTHER]), undefined);
});

test('catalog logos are learned by app identity, without treating user avatars or arbitrary URLs as logos', () => {
  const learned = catalogBrands(JSON.stringify({ data: { toolkits: [{ slug: 'slack', meta: { logo: LOGO } }] }, messages: [{ name: 'User', logo: OTHER }], avatar: OTHER }));
  assert.deepEqual(learned, [{ key: 'slack', icons }]);
  assert.deepEqual(catalogBrands({ tools: [{ name: 'search', icons }] }, 'custom').find((b) => b.key === 'mcpcustomsearch'), { key: 'mcpcustomsearch', icons });
});

test('discovery results update existing chat rows; resetting or opening another pane does not leak branding', () => {
  const store = new Store();
  store.handle({ kind: 'tool-start', id: 'lookup', name: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', input: {} });
  store.handle({ kind: 'tool-result', id: 'lookup', content: JSON.stringify({ toolkits: [{ slug: 'slack', meta: { logo: LOGO } }] }) });
  assert.deepEqual(store.brands.slack, icons);
  assert.equal(store.brandVersion, 1);
  assert.equal(new Store().brands.slack, undefined);
  store.reset();
  assert.equal(store.brands.slack, undefined);
  store.handle({ kind: 'meta', mcp: [{ name: 'custom', server: { name: 'Different public name', icons }, tools: [{ name: 'search', icons }] }] });
  assert.deepEqual(store.brands.custom, icons);
  assert.deepEqual(store.brands.mcpcustomsearch, icons);
});

test('both engine adapters preserve only the image identity fields on tool responses', () => {
  const result = { content: [{ type: 'text', text: 'found' }], _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'custom', icons }, secret: 'not-forwarded' } };
  const a = claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lookup', content: 'found' }] }, tool_use_result: result }).find((e) => e.kind === 'tool-result');
  assert.deepEqual(a.serverIcons, icons);
  assert.equal(a.icons, undefined, 'server branding is distinct from a tool icon');
  const b = createAdapter().adapt({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'mcpToolCall', id: 'lookup', server: 'custom', tool: 'search', arguments: {}, status: 'completed', result } } }).find((e) => e.kind === 'tool-result');
  assert.deepEqual(b.serverIcons, icons);
  assert.equal(b.icons, undefined);
  const store = new Store();
  store.handle({ kind: 'tool-start', id: 'lookup', name: 'mcp__custom__search', input: {} });
  store.handle(b);
  assert.deepEqual(store.brands.custom, icons);
  assert.equal(store.brands.secret, undefined);
});

// partial-json.mjs: reading a tool call's input while it is still being written.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core } from '../helpers.mjs';

const P = await core('partial-json.mjs');
const missing = P.__missing ? `partial-json.mjs: ${P.__missing}` : false;
const parse = (s) => P.parsePartialJson(s);

test('whole JSON reads the same as JSON.parse', { skip: missing }, () => {
  for (const v of [{}, { a: 1 }, { a: 'x', b: [1, 2, { c: null }], d: true, e: false, f: -1.5e3 }, [], [1, 'two', [3]], { 'a b': { 'c"d': 'e\\f\n\té' } }, { emoji: '🌳', html: '<b class="x">&amp;</b>' }]) {
    assert.deepEqual(parse(JSON.stringify(v)), v);
    assert.deepEqual(parse(JSON.stringify(v, null, 2)), v);
  }
});

test('every prefix of a document reads without throwing, and never says more than the whole', { skip: missing }, () => {
  const whole = { title: 'Usage "by" model', html: '<style>.a{color:red}</style>\n<table>\n<tr><td>é 🌳 \\ /</td></tr></table>', n: [1, 22, 333], ok: true, nested: { deep: ['x', { y: 'z' }] } };
  const text = JSON.stringify(whole);
  let last = '';
  for (let i = 0; i <= text.length; i++) {
    let v;
    assert.doesNotThrow(() => { v = parse(text.slice(0, i)); });
    if (v === undefined) continue;
    if (typeof v.title === 'string') assert.ok(whole.title.startsWith(v.title), `title at ${i}`);
    if (typeof v.html === 'string') {
      assert.ok(whole.html.startsWith(v.html), `html at ${i}: ${JSON.stringify(v.html)}`);
      assert.ok(v.html.length >= last.length, 'a string only grows');
      last = v.html;
    }
    if (v.n) assert.deepEqual(v.n, whole.n.slice(0, v.n.length), 'numbers are whole or absent');
  }
  assert.deepEqual(parse(text), whole);
});

test('a string cut mid-way keeps what it has', { skip: missing }, () => {
  assert.deepEqual(parse('{"title":"Model pick'), { title: 'Model pick' });
  assert.deepEqual(parse('{"title":"A","html":"<div class=\\"card\\">Hel'), { title: 'A', html: '<div class="card">Hel' });
  assert.deepEqual(parse('{"title":"A","html":"'), { title: 'A', html: '' });
});

test('half an escape is left out until the rest arrives', { skip: missing }, () => {
  assert.deepEqual(parse('{"a":"line\\'), { a: 'line' });
  assert.deepEqual(parse('{"a":"line\\n'), { a: 'line\n' });
  assert.deepEqual(parse('{"a":"caf\\u00e'), { a: 'caf' });
  assert.deepEqual(parse('{"a":"caf\\u00e9'), { a: 'café' });
  // An emoji written as two escapes: the first half alone is not a character.
  assert.deepEqual(parse('{"a":"tree \\ud83c'), { a: 'tree ' });
  assert.deepEqual(parse('{"a":"tree \\ud83c\\udf33'), { a: 'tree 🌳' });
});

test('what cannot be known yet is left out, not guessed', { skip: missing }, () => {
  assert.deepEqual(parse('{"a":1,"b'), { a: 1 }, 'a key still being written');
  assert.deepEqual(parse('{"a":1,"b"'), { a: 1 }, 'a key with no value');
  assert.deepEqual(parse('{"a":1,"b":'), { a: 1 });
  assert.deepEqual(parse('{"a":1,"b":12'), { a: 1 }, 'a number that may have more digits');
  assert.deepEqual(parse('{"a":1,"b":12,'), { a: 1, b: 12 });
  assert.deepEqual(parse('{"a":1,"b":tr'), { a: 1 });
  assert.deepEqual(parse('{"a":[1,2,{"x":"y"},{"z'), { a: [1, 2, { x: 'y' }, {}] });
  assert.deepEqual(parse('[1,[2,[3'), [1, [2, []]]);
});

test('nothing yet, and nonsense, are handled', { skip: missing }, () => {
  assert.equal(parse(''), undefined);
  assert.equal(parse('   '), undefined);
  assert.equal(parse(undefined), undefined);
  assert.equal(parse(null), undefined);
  assert.deepEqual(parse('{'), {});
  assert.deepEqual(parse('{"a":1}trailing'), { a: 1 });
  assert.deepEqual(parse('{"a":1 ?? "b":2}'), { a: 1 }, 'stops at what it cannot read');
  assert.deepEqual(parse('{"a":"bad \\x escape","b":2}'), { a: 'bad ' });
  assert.doesNotThrow(() => parse('['.repeat(5000)));
});

test('"__proto__" is a member like any other', { skip: missing }, () => {
  const v = parse('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(v), ['__proto__', 'a']);
});

test('a large input is read quickly', { skip: missing }, () => {
  const html = '<tr><td>cell "quoted"</td></tr>\n'.repeat(8000); // ~250 KB
  const text = JSON.stringify({ title: 'Big', html });
  const t0 = performance.now();
  const v = parse(text.slice(0, text.length - 7));
  assert.ok(performance.now() - t0 < 200, 'one read of a quarter megabyte');
  assert.ok(html.startsWith(v.html) && v.html.length > html.length - 16);
});

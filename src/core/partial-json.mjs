// Reading JSON that is still being written. A tool call's input arrives in pieces; this returns what the pieces
// so far say, with whatever is still open closed: a string cut mid-way keeps the text it has, an object keeps the
// members that are complete. Anything that cannot be known yet (a key with no value, half an escape, a number that
// may have more digits) is left out rather than guessed. Never throws; nonsense gives back what was readable before it.
//
//   parsePartialJson('{"title":"Usage","html":"<table><tr><td>4')  →  { title: 'Usage', html: '<table><tr><td>4' }

const END = Symbol('end'); // the text ran out before this value was whole
const PLAIN = /[^"\\]+/y; // a run of string characters that need no decoding
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const MAX_DEPTH = 64;

/**
 * @param {string} text a prefix of a JSON document
 * @returns {unknown} the value so far, or undefined when not even its first character has arrived
 */
export function parsePartialJson(text) {
  const s = typeof text === 'string' ? text : '';
  const n = s.length;
  let i = 0;

  const space = () => { while (i < n) { const c = s.charCodeAt(i); if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break; i++; } };

  // A string, from its opening quote. `whole` is false when the text ended inside it.
  function string() {
    i++;
    let out = '';
    while (i < n) {
      PLAIN.lastIndex = i;
      const run = PLAIN.exec(s);
      if (run) { out += run[0]; i = PLAIN.lastIndex; continue; }
      if (s[i] === '"') { i++; return { value: out, whole: true }; }
      // A backslash: decode the escape if all of it is here, otherwise stop before it.
      const e = s[i + 1];
      if (e === undefined) break;
      if (e === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) { i = n; break; }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if (e in ESCAPES) { out += ESCAPES[e]; i += 2; } else { i = n; break; }
    }
    i = n;
    // Half of a surrogate pair is not a character yet.
    if ((out.charCodeAt(out.length - 1) & 0xfc00) === 0xd800) out = out.slice(0, -1);
    return { value: out, whole: false };
  }

  function literal() {
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (s.startsWith(word, i)) { i += word.length; return v; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    // A number at the very end may still be growing ("12" on its way to "123").
    if (m && NUMBER.lastIndex < n) { i = NUMBER.lastIndex; return Number(m[0]); }
    i = n;
    return END;
  }

  function value(depth) {
    space();
    if (i >= n || depth > MAX_DEPTH) { i = n; return END; }
    const c = s[i];
    if (c === '"') return string().value;
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    return literal();
  }

  function object(depth) {
    i++;
    const out = {};
    for (;;) {
      space();
      if (i >= n) return out;
      if (s[i] === '}') { i++; return out; }
      if (s[i] === ',') { i++; continue; }
      if (s[i] !== '"') { i = n; return out; }
      const key = string();
      if (!key.whole) return out;
      space();
      if (i >= n) return out;
      if (s[i] !== ':') { i = n; return out; }
      i++;
      const v = value(depth + 1);
      if (v === END) return out;
      // "__proto__" as an own member, like JSON.parse, never as the prototype.
      Object.defineProperty(out, key.value, { value: v, enumerable: true, writable: true, configurable: true });
    }
  }

  function array(depth) {
    i++;
    const out = [];
    for (;;) {
      space();
      if (i >= n) return out;
      if (s[i] === ']') { i++; return out; }
      if (s[i] === ',') { i++; continue; }
      const v = value(depth + 1);
      if (v === END) return out;
      out.push(v);
    }
  }

  try {
    const v = value(0);
    return v === END ? undefined : v;
  } catch { return undefined; }
}

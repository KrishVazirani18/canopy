// Drawing HTML that is still being written. Two steps, every time more of it arrives:
//   safePrefix(html)   the longest start of the text that is whole: never half a tag, half an entity, a style rule
//                      still being typed, or a script that has not finished
//   morph(root, html)  make the page match that text by changing only what differs, so what is already on screen
//                      (and every component in it) stays put while the end grows
// safePrefix is plain text work and is tested in node (src/core/test/unit/frame.test.mjs). This file is also loaded
// there, so it uses only syntax that can be erased, and touches the DOM only inside morph.

const RAW = new Set(['script', 'style', 'textarea', 'title']); // their content is text until their own closing tag
const NAME = /[a-zA-Z][^\s/>]*/y;

/** The index just past this tag's `>`, or -1 if the text ends inside the tag. Quotes may hold a `>`. */
function tagEnd(s: string, from: number): number {
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

/** Text up to `end` without a trailing entity that is still being written ("&am"). */
function wholeText(s: string, end: number): number {
  const amp = s.lastIndexOf('&', end - 1);
  if (amp < 0 || end - amp > 12) return end;
  const tail = s.slice(amp, end);
  return /^&#?[a-zA-Z0-9]*$/.test(tail) ? amp : end;
}

/**
 * The start of `html` that can be drawn now. The rest arrives later and is drawn then.
 * A style block shows the rules that are complete; a script is held back until all of it is here.
 */
export function safePrefix(html: string): string {
  const s = html;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return s.slice(0, wholeText(s, n));
    if (s.startsWith('<!--', lt)) {
      const close = s.indexOf('-->', lt + 4);
      if (close < 0) return s.slice(0, wholeText(s, lt));
      i = close + 3;
      continue;
    }
    const next = s[lt + 1];
    if (next === undefined) return s.slice(0, wholeText(s, lt));
    // A "<" that starts nothing (as in "a < b") is text.
    if (!/[a-zA-Z/!?]/.test(next)) { i = lt + 1; continue; }
    const end = tagEnd(s, lt + 1);
    if (end < 0) return s.slice(0, wholeText(s, lt));
    i = end;
    if (next === '/' || next === '!' || next === '?') continue;
    NAME.lastIndex = lt + 1;
    const name = NAME.exec(s)?.[0].toLowerCase() ?? '';
    if (!RAW.has(name) || s[end - 2] === '/') continue;
    // Raw text: find this element's own closing tag.
    const lower = s.slice(end).toLowerCase();
    const closeAt = lower.indexOf(`</${name}`);
    const closeEnd = closeAt < 0 ? -1 : tagEnd(s, end + closeAt + 2);
    if (closeEnd >= 0) { i = closeEnd; continue; }
    if (name === 'script') return s.slice(0, lt);
    if (name === 'style') {
      // Only the rules that have closed: a declaration half typed ("opacity: 0" on its way to "0.8") would flash.
      const body = closeAt < 0 ? s.slice(end) : s.slice(end, end + closeAt);
      const last = body.lastIndexOf('}');
      return last < 0 ? s.slice(0, lt) : s.slice(0, end + last + 1);
    }
    return closeAt < 0 ? s : s.slice(0, end + closeAt);
  }
  return s;
}

// ---- morph ----

const sameKind = (a: Node, b: Node) => a.nodeType === b.nodeType && a.nodeName === b.nodeName
  && (a.nodeType !== 1 || (a as Element).id === (b as Element).id);

function syncAttributes(a: Element, b: Element) {
  for (const { name, value } of Array.from(b.attributes)) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name);
}

/**
 * Make `live`'s children match `next`'s, reusing every node that is still the same kind in the same place.
 * Nodes are moved out of `next` (a parsed fragment), not copied. `added` hears about each element that is new.
 */
export function morphChildren(live: Node, next: Node, added?: (el: Element) => void) {
  let a = live.firstChild;
  let b = next.firstChild;
  while (b) {
    const after = b.nextSibling;
    if (!a) {
      live.appendChild(b);
      if (b.nodeType === 1) added?.(b as Element);
    } else if (sameKind(a, b)) {
      if (a.nodeType === 1) {
        const ea = a as Element;
        const eb = b as Element;
        syncAttributes(ea, eb);
        // A <template>'s content lives beside it, not in it.
        if (ea instanceof HTMLTemplateElement && eb instanceof HTMLTemplateElement) morphChildren(ea.content, eb.content);
        else morphChildren(ea, eb, added);
      } else if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
      a = a.nextSibling;
    } else {
      live.replaceChild(b, a);
      if (b.nodeType === 1) added?.(b as Element);
      a = b.nextSibling;
    }
    b = after;
  }
  while (a) { const gone = a; a = a.nextSibling; live.removeChild(gone); }
}

/** Draw `html` into `root`, keeping what is already there. */
export function morph(root: Element, html: string, added?: (el: Element) => void) {
  const t = document.createElement('template');
  t.innerHTML = html;
  morphChildren(root, t.content, added);
}

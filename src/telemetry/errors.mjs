// Problems, made safe to count. An error becomes four things: where it happened, its type, its first line with
// everything personal scrubbed out, and a fingerprint that is the same every time the same problem happens, on any
// Mac. Then they are grouped: the first time a problem shows up it is reported at once, and after that at most once
// an hour, with how many more times it happened.
//
// The fingerprint is a hash of the type, the scrubbed first line with its numbers evened out, and the top stack
// frame as file:function without its folder. Only the hash is sent: the stack never is.
//
// The window is treated more strictly than the rest. Its job is drawing what people and models wrote, so the
// libraries it uses quote that text when they fail ("parse error at position 12: …"), and no scrubbing can tell
// those words from the error's own. So for an error from the window, the text is sent only when the JavaScript
// engine worded it itself (a TypeError, a ReferenceError…), which is about the code, except for the few messages in
// which the engine prints a value the code was holding: those are cut down to their own words first, wherever the
// error is from (CARRIES_DATA below). Anything else from the window is sent as its type and fingerprint alone.
import { createHash } from 'node:crypto';
import { redact } from '../core/redact.mjs';
import { scrubText } from './schema.mjs';

const HOUR = 3_600_000;
const TEXT_MAX = 200;
const TYPE = /^[A-Za-z_$][A-Za-z0-9_$]{0,59}$/;
// How the window's console words an uncaught error: "Uncaught TypeError: x is not a function",
// "Uncaught (in promise) Error: nope". The part before the message says the type.
const SAID_TYPE = /^(?:Uncaught\s+)?(?:\(in promise\)\s+)?(?:((?:[A-Za-z_$][A-Za-z0-9_$]*)?(?:Error|Exception))\s*:\s*)?/;
const ENGINE_WORDED = new Set(['TypeError', 'ReferenceError', 'RangeError']);
// React's production errors are a number and a link: the number says which, and nothing else in the line is needed.
const REACT_CODE = /^Minified React error #\d+/;
// A literal worth hiding is at least this long: masking "/" or "~" would shred every line. And no longer than a
// path can be.
const HIDE_MIN = 4;
const HIDE_MAX = 1024;
// How much of an error is read. Its text can be megabytes (a payload quoted whole, a page's console line), every
// rule here would walk all of it, and this runs in the main process each time the error happens. The first line is
// looked for at the start, and of that line only this much is scrubbed (twice what scrubText itself reads, of which
// 200 characters are kept).
const HEAD_MAX = 16 * 1024;
const LINE_MAX = 4000;
// Some messages carry, at length and in no shape a scrubber can count on, the very thing that must not be sent. They
// are cut down to their own words before anything else looks at them:
//   - Node words a failed command as "Command failed: " and then the whole command line, every argument included.
//   - The JavaScript engine quotes the text it could not parse (`Unexpected token 'h', ..."ket","pw":hunter2,"x"...
//     is not valid JSON`). That text is somebody's data, and the quote marks JSON is full of leave no pair to find.
//   - The engine's type errors about a property print the value or the key the code was holding, which in Canopy is
//     as often as not what a person or a model wrote (`Cannot use 'in' operator to search for 'type' in ` and then
//     the whole of a message that was taken for an object). Where it puts them in quotes, an apostrophe in the text
//     ends the quote early. This holds for the window too: these are the engine's words, and not about the code.
const CARRIES_DATA = [
  [/\b(Command failed):.*$/, '$1'],
  [/^(Unexpected token) .*$/, '$1'],
  [/^.*( is not valid JSON)$/, '<q>$1'],
  [/\b(Cannot use 'in' operator to search for) .*$/, '$1 <q>'],
  [/\b(Cannot (?:create|assign to read only|delete) property) .*$/, '$1 <q>'],
  [/\b(Cannot (?:add|define) property) .*(, object is not extensible)$/, '$1 <q>$2'],
  [/\b(Cannot redefine property): .*$/, '$1: <q>'],
  [/\((reading|setting) '.*'\)/, '($1 <q>)'],
  [/\b(Object prototype may only be an Object or null): .*$/, '$1'],
  [/\b(Failed to parse URL from) .*$/, '$1 <url>'],
  [/\b(Invalid regular expression): \/.*\/[a-z]*: /, '$1: '], // the pattern: a search someone typed
];
const ownWords = (line) => CARRIES_DATA.reduce((text, [what, kept]) => text.replace(what, kept), line);

/** The first line with something on it, and no more than `max` characters of it. */
const firstLine = (v, max) => (String(v ?? '').slice(0, HEAD_MAX).split(/\r?\n/).find((l) => l.trim()) ?? '').slice(0, max);
const validType = (v) => (typeof v === 'string' && TYPE.test(v) ? v : null);

/** The error's class, when it says one more specific than plain Error. */
function namedType(err) {
  if (!err || typeof err !== 'object') return null;
  const name = validType(err.name);
  if (name && name !== 'Error') return name;
  const made = validType(err.constructor?.name);
  return made && made !== 'Error' && made !== 'Object' ? made : null;
}

/** "file:///Users/a/app/src/main.mjs:12:34" -> "main.mjs". A built file's name carries a hash that changes with every build: dropped. */
function fileName(where) {
  const file = String(where ?? '').replace(/(?::\d+){1,2}$/, '').split(/[\\/]/).pop().split(/[?#]/)[0];
  return file.replace(/-[A-Za-z0-9_-]{8}(?=\.[A-Za-z]+$)/, '');
}

/** The top stack frame as "file:function". Without a stack, the file the window said the error came from. */
function topFrame(err) {
  let stack = typeof err?.stack === 'string' ? err.stack : '';
  // A stack opens with the error's text and ends with its frames: of a huge one only the end is read, from its
  // first whole line (half a frame would name half a file).
  if (stack.length > HEAD_MAX) {
    const end = stack.slice(-HEAD_MAX);
    stack = end.includes('\n') ? end.slice(end.indexOf('\n') + 1) : '';
  }
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:async )?(?:new )?(?:(.+?) \()?(.+?)\)?$/.exec(line);
    if (m) return `${fileName(m[2])}:${(m[1] ?? '').replace(/ \[as [^\]]+\]$/, '')}`;
  }
  return typeof err?.source === 'string' && err.source ? `${fileName(err.source)}:` : '';
}

/** The local strings worth hiding by name (the home folder, a project folder), longest first. */
function hidable(hide) {
  return [...new Set(hide.filter((h) => typeof h === 'string' && h.length >= HIDE_MIN && h.length <= HIDE_MAX))].sort((a, b) => b.length - a.length);
}

/** Replace each of them wherever it appears. */
function hideAll(text, known) {
  let out = text;
  for (const h of known) out = out.split(h).join('<path>');
  return out;
}

/**
 * An error as it may be sent. `err` is an Error, a string, or what the window's console gives:
 * `{ message, source }` (the text, and the file it came from).
 * `hide`: strings this Mac knows are personal (folders), removed by name before the general scrubbing, which can't
 * know where a folder name with spaces in it ends.
 * @returns {{ where: string, type: string, message: string, fingerprint: string }} message is '' when it may not be sent
 */
export function describeError(where, err, { hide = [] } = {}) {
  // Node says which file a failed call was about (err.path, err.dest): those go by name too.
  const known = hidable([...(Array.isArray(hide) ? hide : []), err?.path, err?.dest]);
  // Read far enough past the limit that a name starting inside it is there whole, and so is hidden.
  const room = LINE_MAX + (known[0]?.length ?? 0);
  const raw = firstLine(err && typeof err === 'object' ? err.message ?? '' : err, room);
  const said = SAID_TYPE.exec(raw);
  const type = namedType(err) ?? validType(said[1]) ?? 'Error';
  let shown = hideAll(redact(ownWords(raw.slice(said[0].length))), known);
  // A line that was cut can end part of the way into one of those names, where nothing would know it for one: the
  // end that could hold such a piece goes.
  if (raw.length === room && known.length) shown = shown.slice(0, 1 - known[0].length);
  const text = scrubText(shown, TEXT_MAX);
  // Numbers are evened out, long or short (the scrubber has already turned the long ones into <n>): "after 3 tries"
  // and "after 12 tries" are one problem.
  const shape = text.replace(/<n>|\d+/g, '0');
  const fingerprint = createHash('sha256').update(`${type}\n${shape}\n${topFrame(err)}`).digest('hex').slice(0, 16);
  let message = text;
  if (where === 'ui' && !ENGINE_WORDED.has(type)) message = REACT_CODE.exec(text)?.[0] ?? '';
  return { where, type, message, fingerprint };
}

/**
 * Groups errors by fingerprint and reports each group through `emit(props)` (the props of an `error` event).
 * @param {{
 *   emit: (props: { where: string, type: string, message: string, fingerprint: string, count: number }) => void,
 *   hide?: () => string[], now?: () => number, windowMs?: number,
 *   maxKinds?: number,     // different problems followed at once: past this, new ones wait for the hour to turn
 * }} opts
 */
export function createErrorLog({ emit, hide = () => [], now = Date.now, windowMs = HOUR, maxKinds = 100 }) {
  const kinds = new Map(); // fingerprint -> { props, since: when it was last reported, more: times seen since }
  const report = (k, count) => emit({ ...k.props, count });

  /** Close every hour that has run out: report what piled up in it, forget what stayed quiet. */
  function sweep() {
    const at = now();
    for (const [fingerprint, k] of kinds) {
      if (at - k.since < windowMs) continue;
      if (k.more) { report(k, k.more); k.since = at; k.more = 0; }
      else kinds.delete(fingerprint);
    }
  }

  return {
    /** Something went wrong. Reported now if it is new (or its hour is up), counted otherwise. */
    report(where, err) {
      let known = [];
      try { known = hide() ?? []; } catch { /* nothing extra to hide */ }
      const props = describeError(where, err, { hide: known });
      const at = now();
      const k = kinds.get(props.fingerprint);
      if (k) {
        if (at - k.since < windowMs) { k.more++; return; }
        report(k, k.more + 1);
        k.since = at;
        k.more = 0;
        return;
      }
      if (kinds.size >= maxKinds) sweep();
      if (kinds.size >= maxKinds) return; // a storm of different errors: the first hundred this hour say enough
      kinds.set(props.fingerprint, { props, since: at, more: 0 });
      emit({ ...props, count: 1 });
    },
    sweep,
    /** Report every count still held back, whatever its hour: Canopy is quitting and they would be lost. */
    flush() {
      for (const k of kinds.values()) if (k.more) { report(k, k.more); k.more = 0; }
    },
    clear() { kinds.clear(); },
  };
}

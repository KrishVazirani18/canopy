// Errors as telemetry reports them (src/telemetry/errors.mjs): a type, a scrubbed first line and a fingerprint that
// is the same for the same problem on any Mac; then at most one event per problem per hour, with a count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createErrorLog, describeError } from '../../../telemetry/errors.mjs';
import { clean } from '../../../telemetry/schema.mjs';
import { fakeClock } from '../telemetry-fakes.mjs';

const HOUR = 3_600_000;

/** An error with a stack of our choosing. */
function err(message, { name = 'Error', frame = 'at openChat (file:///Users/jane/My Projects/canopy/src/main.mjs:120:15)', ...extra } = {}) {
  const e = new Error(message);
  e.name = name;
  e.stack = `${name}: ${message}\n    ${frame}\n    at node:internal/process/task_queues:95:5`;
  return Object.assign(e, extra);
}

// ---- describing one error ----

test('an error becomes where, type, a scrubbed first line and a 16-character fingerprint, and nothing else', () => {
  const d = describeError('main', err("ENOENT: no such file or directory, open '/Users/jane/notes.txt'", { name: 'SystemError' }));
  assert.deepEqual(Object.keys(d).sort(), ['fingerprint', 'message', 'type', 'where']);
  assert.equal(d.where, 'main');
  assert.equal(d.type, 'SystemError');
  assert.equal(d.message, 'ENOENT: no such file or directory, open <q>');
  assert.match(d.fingerprint, /^[0-9a-f]{16}$/);
  // It is exactly what the schema lets through.
  assert.deepEqual(clean('error', { ...d, count: 1 }), { ...d, count: 1 });
});

test('the same problem has the same fingerprint whatever the numbers, paths and quoted names in it', () => {
  const a = describeError('main', err("Cannot find module '/Users/jane/app/x.js' after 3 tries (pid 48151)"));
  const b = describeError('main', err("Cannot find module '/Users/omar/Other Folder/y.js' after 12 tries (pid 623)", { frame: 'at openChat (file:///Users/omar/canopy/src/main.mjs:9:1)' }));
  assert.equal(a.fingerprint, b.fingerprint);
});

test('a different type, a different message or a different place in the code is a different problem', () => {
  const base = describeError('main', err('it broke'));
  assert.notEqual(describeError('main', err('it broke', { name: 'TypeError' })).fingerprint, base.fingerprint);
  assert.notEqual(describeError('main', err('it broke badly')).fingerprint, base.fingerprint);
  assert.notEqual(describeError('main', err('it broke', { frame: 'at closeChat (file:///Users/jane/canopy/src/main.mjs:120:15)' })).fingerprint, base.fingerprint);
  assert.notEqual(describeError('main', err('it broke', { frame: 'at openChat (file:///Users/jane/canopy/src/chats.mjs:120:15)' })).fingerprint, base.fingerprint);
});

test('a built file\'s name changes with every build; the fingerprint does not', () => {
  const a = describeError('ui', { message: 'Uncaught TypeError: x is not a function', source: 'file:///Applications/Canopy.app/dist-ui/assets/index-D3kYx9Qa.js' });
  const b = describeError('ui', { message: 'Uncaught TypeError: x is not a function', source: 'file:///Users/jane/canopy/dist-ui/assets/index-Zz81_kQp.js' });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('the stack is never part of what is described', () => {
  const d = describeError('main', err('it broke', { frame: 'at secretFunction (/Users/jane/Acme Rocket/launch-codes.js:1:1)' }));
  const text = JSON.stringify(d);
  for (const word of ['jane', 'Acme', 'Rocket', 'launch-codes', 'secretFunction']) assert.ok(!text.includes(word), word);
});

test('folders this Mac knows about are removed by name, even where no pattern could find their end', () => {
  const hide = ['/Users/jane', '/Users/jane/Acme Rocket Launch'];
  // The folder is the last thing in the path and has spaces: scrubbing alone would leave "Rocket Launch" behind.
  const d = describeError('main', err('spawn failed in /Users/jane/Acme Rocket Launch with code 1'), { hide });
  assert.equal(d.message, 'spawn failed in <path> with code 1');
  const e = describeError('main', err('cannot stat /Users/jane/My Things today'), { hide });
  assert.ok(!e.message.includes('jane'), e.message);
  // Short strings are not hidden by name: masking "/" would shred every line.
  assert.equal(describeError('main', err('a / b'), { hide: ['/', '~', ''] }).message, 'a / b');
});

test('the file a failed call was about (err.path, err.dest) goes by name too', () => {
  const e = err('ENOENT: no such file or directory, rename /Users/jane/Old Name -> /Users/jane/New Name', { path: '/Users/jane/Old Name', dest: '/Users/jane/New Name' });
  const d = describeError('main', e);
  for (const word of ['jane', 'Old', 'Name', 'New']) assert.ok(!d.message.includes(word), `${word} in: ${d.message}`);
});

test('a command that failed is reported without its command line', () => {
  // How Node words it: "Command failed: " and then the program with every argument, a commit message included.
  const failed = Object.assign(err('Command failed: git commit -m fix the login bug for acme\nfatal: not a git repository'), { cmd: 'git commit -m fix the login bug for acme', code: 128 });
  assert.equal(describeError('main', failed).message, 'Command failed');
  // The same when another error carries it along, and when nothing but the text says what it is.
  assert.equal(describeError('main', err('Error invoking remote method: Error: Command failed: npm publish acme-internal --otp 123')).message, 'Error invoking remote method: Error: Command failed');
  assert.equal(describeError('main', 'Uncaught Error: Command failed: open -a Notes merger-plan').message, 'Command failed');
  // Whatever the command was, it is one problem where it happened.
  assert.equal(describeError('main', err('Command failed: git push')).fingerprint, describeError('main', err('Command failed: git pull --rebase')).fingerprint);
});

test('text that would not parse as JSON is never quoted back', () => {
  // The real thing: V8 puts the text around the place it gave up into the message, in quotes of its own, and the
  // quote marks JSON is full of leave no pair for a scrubber to find.
  const parse = (text) => { try { JSON.parse(text); } catch (e) { return e; } throw new Error('that parsed'); };
  const sources = [
    'hello world my secret plan',
    '{"note": hello my secret}',
    '{"name":"Acme Rocket","pw":hunter2,"x":1}',
    '{"msg":"don\'t tell", "k": oops}',
    '{"it\'s": "a \'plan\'", "z": nope nope nope}',
    '{"a":"x","secret":"y","b": no}',
    '{"k":"v", "s": o\nops secret}', // the quoted text runs over the line's end
    '<!DOCTYPE html><title>Acme intranet</title>',
  ];
  for (const source of sources) {
    const e = parse(source);
    const d = describeError('main', e);
    assert.equal(d.type, 'SyntaxError');
    assert.equal(d.message, 'Unexpected token', `${e.message} -> ${d.message}`);
    assert.equal(d.fingerprint, describeError('main', parse(sources[0])).fingerprint, 'one problem, whatever the text was');
  }
  // The short form, which quotes the whole text, and the wording of older engines.
  assert.equal(describeError('main', parse(undefined)).message, '<q> is not valid JSON');
  assert.equal(describeError('main', new SyntaxError('"my plan" for "acme" is not valid JSON')).message, '<q> is not valid JSON');
  assert.equal(describeError('main', 'Uncaught SyntaxError: Unexpected token h in JSON at position 12').message, 'Unexpected token');
  // Errors about JSON that quote nothing say what they said.
  assert.equal(describeError('main', parse('{"a":1')).message, parse('{"a":1').message.replace(/'[^']*'/g, '<q>'));
  assert.equal(describeError('main', parse('')).message, 'Unexpected end of JSON input');
});

test('what the engine says about a value the code was holding is kept, the value is not', async () => {
  // Some of the engine's own messages print a string or a key the code had in hand when it failed. In Canopy that is
  // as often as not something a person or a model wrote: a message taken for an object, a chat's name used as a key.
  const said = "please don't share Bob's plan for the Acme merger before friday";
  const thrown = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('that did not throw'); };
  const frozen = Object.freeze({});
  const errors = {
    "Cannot use <q> operator to search for <q>": thrown(() => 'type' in said),
    "Cannot create property <q>": thrown(() => { said.read = true; }),
    "Cannot assign to read only property <q>": thrown(() => { said[0] = 'P'; }),
    "Cannot read properties of undefined (reading <q>)": thrown(() => undefined[said]),
    "Cannot set properties of null (setting <q>)": thrown(() => { null[said] = 1; }),
    "Cannot add property <q>, object is not extensible": thrown(() => { frozen[said] = 1; }),
    "Cannot define property <q>, object is not extensible": thrown(() => Object.defineProperty(frozen, said, { value: 1 })),
    "Cannot redefine property: <q>": thrown(() => Object.defineProperty(Object.freeze({ [said]: 1 }), said, { value: 2 })),
    "Cannot delete property <q>": thrown(() => { delete Object.freeze({ [said]: 1 })[said]; }),
    "Object prototype may only be an Object or null": thrown(() => Object.setPrototypeOf({}, said)),
    "Failed to parse URL from <url>": await fetch(said).then(() => assert.fail('that fetched'), (e) => e), // refused before any request is made
  };
  const words = ['please', 'don', 'share', 'Bob', 'plan', 'Acme', 'merger', 'before', 'friday'];
  for (const [kept, e] of Object.entries(errors)) {
    assert.equal(e.name, 'TypeError', e.message);
    assert.ok(words.some((w) => e.message.includes(w)), `the engine no longer quotes it: ${e.message}`);
    // From the main process, and from the window, which sends what a TypeError says.
    const main = describeError('main', e);
    const ui = describeError('ui', { message: `Uncaught TypeError: ${e.message}`, source: 'file:///x/index-a1b2c3d4.js' });
    for (const d of [main, ui]) {
      assert.equal(d.message, kept, e.message);
      for (const w of words) assert.ok(!d.message.includes(w), `${w} in: ${d.message}`);
    }
    // One problem, whatever was held.
    const other = new TypeError(e.message.split(said).join('something else entirely'));
    assert.equal(describeError('main', Object.assign(other, { stack: e.stack.split(said).join('something else entirely') })).fingerprint, main.fingerprint);
  }
  // A pattern that would not compile is somebody's search: what was wrong with it is kept, the pattern is not.
  const pattern = describeError('main', thrown(() => new RegExp(`(${said}`)));
  assert.equal(pattern.message, 'Invalid regular expression: Unterminated group');
  assert.equal(pattern.type, 'SyntaxError');
  // The same messages about the code's own names are left as they were.
  assert.equal(describeError('main', thrown(() => undefined.title)).message, 'Cannot read properties of undefined (reading <q>)');
  assert.equal(describeError('main', thrown(() => null.x.y)).message, 'Cannot read properties of null (reading <q>)');
});

test('a huge error costs what a small one does: it is read at its start and its end, never from end to end', () => {
  // An error's text can run to megabytes (a payload quoted whole, one long line from the window's console), and
  // describing it happens in the main process each time. No clock here: what is checked is that the middle is not read.
  const hide = ['/Users/jane/Acme Rocket Launch', ...Array.from({ length: 20 }, (_, i) => `/Users/jane/project-${i}`)];
  // One long line, then the frames.
  const payload = `{"rows":[${'{"file":"/Users/jane/project-3/a.txt","note":"x"},'.repeat(8000)}]}`;
  const d = describeError('main', err(`Could not read the answer ${payload}`), { hide });
  assert.ok(d.message.startsWith('Could not read the answer'), d.message);
  assert.ok(!d.message.includes('jane'), d.message);
  // Its place in the code still tells it apart: the frames are the last lines of the stack.
  assert.notEqual(d.fingerprint, describeError('main', err(`Could not read the answer ${payload}`, { frame: 'at closeChat (file:///x/src/main.mjs:9:1)' }), { hide }).fingerprint);
  // What lies past the part of the line that is read changes nothing.
  assert.equal(d.fingerprint, describeError('main', err(`Could not read the answer ${payload} and a different ending`), { hide }).fingerprint);
  // Many lines instead of one long one: the first is the message, as for any error, and the frames are still found.
  const lines = 'another line of the payload\n'.repeat(4000);
  const many = (middle) => `first line\n${lines}${middle}\n${lines}`;
  assert.equal(describeError('main', err(many('')), { hide }).message, 'first line');
  assert.equal(describeError('main', err(many('')), { hide }).fingerprint, describeError('main', err('first line')).fingerprint);
  assert.notEqual(describeError('main', err(many('')), { hide }).fingerprint, describeError('main', err(many(''), { frame: 'at closeChat (file:///x/src/main.mjs:9:1)' }), { hide }).fingerprint);
  // A line in the middle of the text that only looks like a frame is not taken for the place in the code.
  assert.equal(describeError('main', err(many('    at somewhere (file:///x/quoted.mjs:1:1)')), { hide }).fingerprint, describeError('main', err(many('')), { hide }).fingerprint);
  // From the window, where the page's console hands over one line of any length.
  const ui = describeError('ui', { message: `Uncaught TypeError: ${payload} is not iterable`, source: 'file:///x/index-a1b2c3d4.js' }, { hide });
  assert.equal(ui.type, 'TypeError');
  assert.ok(!ui.message.includes('jane') && ui.message.length <= 200, ui.message);
  // What lies past the part that is read is not looked at, even when all that comes before it scrubs down to a word.
  const folders = '/Users/jane/Acme Rocket Launch '.repeat(200);
  assert.ok(!describeError('main', err(`${folders}and then the rest`), { hide }).message.includes('rest'));
  assert.equal(describeError('main', err(`${folders}and then the rest`), { hide }).fingerprint, describeError('main', err(`${folders}something else entirely`), { hide }).fingerprint);
  // Wherever the reading stops, it never stops half way into a folder this Mac knows: the half would not be hidden.
  for (let lead = 0; lead < 40; lead++) {
    const m = describeError('main', err(`${'x'.repeat(lead)} ${folders}`), { hide }).message;
    for (const word of ['jane', 'Acme', 'Rocket', 'Launch', 'Users']) assert.ok(!m.includes(word), `${word} after ${lead}: ${m}`);
  }
});

test('credentials go even when they are too short to look like one', () => {
  const d = describeError('main', err('request failed: Authorization: Bearer abc12345, x-api-key: k_9f8e7d6c'));
  assert.ok(!d.message.includes('abc12345') && !d.message.includes('k_9f8e7d6c'), d.message);
});

test('only the first line is used', () => {
  const d = describeError('main', err('first line\nthe secret second line'));
  assert.equal(d.message, 'first line');
});

test('anything can be reported: a string, nothing at all, a number, a bare object', () => {
  assert.equal(describeError('main', 'plain words').message, 'plain words');
  assert.equal(describeError('main', 'plain words').type, 'Error');
  for (const odd of [undefined, null, 42, {}, { message: 7 }, [], Symbol.iterator.toString(), Object.create(null)]) {
    const d = describeError('main', odd);
    assert.match(d.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(typeof d.message, 'string');
  }
  class QuotaError extends Error {}
  assert.equal(describeError('main', new QuotaError('full')).type, 'QuotaError');
  assert.equal(describeError('main', Object.assign(new Error('x'), { name: 'not a valid type name!' })).type, 'Error');
});

// ---- the window is treated more strictly ----

test('from the window, text is sent when the JavaScript engine worded it', () => {
  const d = describeError('ui', { message: "Uncaught TypeError: Cannot read properties of undefined (reading 'title')", source: 'file:///x/dist-ui/assets/index-D3kYx9Qa.js' });
  assert.equal(d.type, 'TypeError');
  assert.equal(d.message, 'Cannot read properties of undefined (reading <q>)');
  assert.equal(describeError('ui', { message: 'Uncaught (in promise) ReferenceError: foo is not defined' }).message, 'foo is not defined');
  assert.equal(describeError('ui', { message: 'Uncaught RangeError: Maximum call stack size exceeded' }).message, 'Maximum call stack size exceeded');
});

test('from the window, anything a library worded is sent as type and fingerprint only: it may quote what was on screen', () => {
  const quoting = [
    'KaTeX parse error: Undefined control sequence: \\salary at position 5: my salary is 250k',
    'Uncaught ParseError: KaTeX parse error: Expected EOF, got my private notes at position 3',
    'Uncaught Error: Parse error on line 2: graph TD A[Acme merger plan]',
    'Uncaught SyntaxError: Invalid regular expression: /acme merger(/: Unterminated group',
    'Failed to render message: the quarterly numbers are bad',
    'Warning: Each child in a list should have a unique key',
  ];
  for (const message of quoting) {
    const d = describeError('ui', { message, source: 'file:///x/dist-ui/assets/index-D3kYx9Qa.js' });
    assert.equal(d.message, '', message);
    assert.match(d.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(clean('error', { ...d, count: 1 }).message, undefined);
  }
  assert.equal(describeError('ui', { message: quoting[1] }).type, 'ParseError');
  // The very same text from the main process is an error's first line like any other.
  assert.notEqual(describeError('main', 'Failed to start: the helper exited').message, '');
});

test('from the window, a React production error keeps its number and nothing after it', () => {
  const d = describeError('ui', { message: 'Uncaught Error: Minified React error #310; visit https://react.dev/errors/310?args[]=secret for the full message' });
  assert.equal(d.message, 'Minified React error #310');
});

// ---- grouping ----

function logWith(opts = {}) {
  const clock = fakeClock();
  const sent = [];
  const log = createErrorLog({ emit: (props) => sent.push(props), now: clock.now, ...opts });
  return { clock, sent, log };
}

test('a new problem is reported at once; the same one again within the hour is only counted', () => {
  const { clock, sent, log } = logWith();
  log.report('main', err('it broke'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].count, 1);
  for (let i = 0; i < 40; i++) { clock.advance(60_000); log.report('main', err('it broke')); }
  assert.equal(sent.length, 1);
});

test('when the hour is up, one more event says how many more times it happened', () => {
  const { clock, sent, log } = logWith();
  log.report('main', err('it broke'));
  for (let i = 0; i < 7; i++) log.report('main', err('it broke'));
  clock.advance(HOUR - 1);
  log.sweep();
  assert.equal(sent.length, 1, 'not before the hour is up');
  clock.advance(1);
  log.sweep();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].count, 7);
  assert.equal(sent[1].fingerprint, sent[0].fingerprint);
  log.sweep();
  assert.equal(sent.length, 2, 'and only once');
});

test('a problem that comes back after its hour is reported again, with what was held back', () => {
  const { clock, sent, log } = logWith();
  log.report('main', err('it broke'));
  log.report('main', err('it broke'));
  log.report('main', err('it broke'));
  clock.advance(HOUR + 5);
  log.report('main', err('it broke'));
  assert.deepEqual(sent.map((s) => s.count), [1, 3], 'two held back and the one that just happened');
  log.report('main', err('it broke'));
  assert.equal(sent.length, 2, 'a new hour has started');
});

test('never more than one event per problem per hour, over a long day of the same error', () => {
  const { clock, sent, log } = logWith();
  let occurrences = 0;
  for (let minute = 0; minute < 10 * 60; minute++) {
    log.report('main', err('it broke'));
    occurrences++;
    clock.advance(60_000);
    log.sweep();
  }
  assert.ok(sent.length <= 11, `${sent.length} events in ten hours`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].count >= 1);
  log.flush();
  assert.equal(sent.reduce((n, s) => n + s.count, 0), occurrences, 'and every occurrence is counted exactly once');
});

test('different problems are reported separately', () => {
  const { sent, log } = logWith();
  log.report('main', err('it broke'));
  log.report('main', err('something else broke'));
  log.report('ui', { message: 'Uncaught TypeError: x is not a function' });
  log.report('main', err('it broke'));
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((s) => s.fingerprint)).size, 3);
});

test('at quit, counts still held back are reported so they are not lost', () => {
  const { sent, log } = logWith();
  log.report('main', err('it broke'));
  log.report('main', err('it broke'));
  log.report('main', err('it broke'));
  log.report('main', err('once only'));
  log.flush();
  assert.deepEqual(sent.map((s) => s.count), [1, 1, 2]);
  log.flush();
  assert.equal(sent.length, 3, 'flushing twice reports nothing twice');
});

test('a storm of different errors is capped: the first hundred this hour say enough', () => {
  const { clock, sent, log } = logWith({ maxKinds: 100 });
  for (let i = 0; i < 500; i++) log.report('main', err(`failure in ${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10) % 10]}${'uvwxyzABCD'[Math.floor(i / 100)]} module`));
  assert.equal(sent.length, 100);
  clock.advance(HOUR);
  log.report('main', err('a new one after the hour'));
  assert.equal(sent.length, 101, 'quiet problems are forgotten when the hour turns, making room');
});

test('clear forgets what was held back', () => {
  const { sent, log } = logWith();
  log.report('main', err('it broke'));
  log.report('main', err('it broke'));
  log.clear();
  log.flush();
  assert.equal(sent.length, 1);
});

test('a list of local folders that throws is treated as empty', () => {
  const { sent, log } = logWith({ hide: () => { throw new ReferenceError('not ready yet'); } });
  log.report('main', err('it broke'));
  assert.equal(sent.length, 1);
  const hidden = logWith({ hide: () => ['/Users/jane/Acme Rocket Launch'] });
  hidden.log.report('main', err('cannot open /Users/jane/Acme Rocket Launch'));
  assert.equal(hidden.sent[0].message, 'cannot open <path>');
});

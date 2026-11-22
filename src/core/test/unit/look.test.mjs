// look.mjs: the tool Claude sees a page or a window with (what it accepts, what it sends back, what each failure
// tells Claude to do next), look-capture.mjs's side of it with Electron as a stand-in, and Session's side (there
// from the first turn when the host can take screenshots; never asking about a page on this Mac or Canopy's own
// window, always asking about the web, a file or another app's window).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createFake, CAPABILITIES } from '../fake-query.mjs';
import { core, watch, within } from '../helpers.mjs';
import { createLookCapture, joinWindows, parseWindowList } from '../../../look-capture.mjs';

const L = await core('look.mjs');
const M = await core('code-mode.mjs');
const S = await core('session.mjs');
const SH = await core('shots.mjs');
const missing = L.__missing ? `look.mjs: ${L.__missing}` : L.LOOK_MISSING ? `look cannot load: ${L.LOOK_MISSING}` : false;
const noSession = missing || (S.__missing ? `session.mjs: ${S.__missing}` : false);
const text = (result) => result.content.find((c) => c.type === 'text').text;
const picture = (result) => result.content.find((c) => c.type === 'image');

// An image the way Electron hands one over, with made-up weights: a PNG weighs `png` bytes per pixel, a JPEG
// `jpeg` bytes per pixel at quality 80 and three quarters of that at 60.
function image(width, height, { png = 0.1, jpeg = 0.05, empty = false } = {}) {
  return {
    width, height, resized: null,
    getSize: () => ({ width, height }),
    isEmpty: () => empty,
    resize(o) { const r = image(o.width, o.height, { png, jpeg }); r.resized = { from: [width, height], quality: o.quality }; return r; },
    toPNG: () => Buffer.alloc(Math.round(width * height * png)),
    toJPEG: (q) => Buffer.alloc(Math.round(width * height * jpeg * (q >= 80 ? 1 : 0.75))),
  };
}

// A backend that renders nothing: it answers what it is told to and keeps what it was asked.
function backend(o = {}) {
  const asked = { page: [], other: 0 };
  return {
    asked,
    appName: o.appName ?? 'Canopy',
    async page(opts) {
      asked.page.push(opts);
      if (o.pageError) throw o.pageError;
      const full = opts.fullPage ? Math.min(o.pageSize?.height ?? opts.height, opts.fullHeight) : opts.height;
      return {
        image: o.image ?? image(opts.width, full), captured: { width: opts.width, height: full },
        page: o.pageSize ?? { width: opts.width, height: opts.height }, scrollY: opts.scrollY, url: opts.url, status: 200, errors: [], slow: false, ...o.page,
      };
    },
    ownWindows: () => o.own ?? [],
    otherWindows: async () => { asked.other++; return o.others ?? []; },
    screenAccess: () => o.access ?? 'granted',
  };
}
const win = (app, title, o = {}) => ({ app, title, capture: async () => (o.image === undefined ? image(1440, 900) : o.image), ...(o.own && { own: true }), ...(o.capture && { capture: o.capture }) });

// ---- what it is called, and what it accepts ----

test('the tool keeps the name and the description that were benchmarked', { skip: missing }, () => {
  assert.equal(L.LOOK_TOOL, 'mcp__canopy_look__look');
  assert.equal(L.LOOK_DESCRIPTION, [
    'See what a web page or a Mac app window looks like right now, as a screenshot.',
    'Use it after you change anything visual (CSS, layout, a component, an app\'s UI), before you tell the user it is fixed, and to see a visual bug the user describes. Check the size the user mentioned (width 390 for a phone).',
    'Pass url for a page (localhost works) or window for an app window (app name or window title). Not for reading text, data or APIs: use files, curl or tests for those.',
  ].join('\n'));
});

test('exactly one of url or window', { skip: missing }, async () => {
  for (const args of [{}, null, { url: '  ' }, { url: 'http://localhost:3000/', window: 'Safari' }, { width: 390 }]) {
    assert.throws(() => L.readInput(args), (err) => err instanceof L.LookError && /^Pass exactly one of url or window/.test(err.message));
  }
  const refused = await L.look({}, backend());
  assert.equal(refused.isError, true);
  assert.ok(text(refused).startsWith('Pass exactly one of url or window'));
});

test('an address is read the way people type it, and only pages are opened', { skip: missing }, () => {
  const url = (u) => L.readInput({ url: u }).url;
  assert.equal(url('http://localhost:3000/settings'), 'http://localhost:3000/settings');
  assert.equal(url(' localhost:5173 '), 'http://localhost:5173/');
  assert.equal(url('example.com/pricing'), 'http://example.com/pricing');
  assert.equal(url('/Users/me/my site/index.html'), 'file:///Users/me/my%20site/index.html');
  assert.equal(url('file:///tmp/a.html'), 'file:///tmp/a.html');
  for (const bad of ['javascript:alert(1)', 'about:blank', 'chrome://settings', 'data:text/html,<p>x', 'ftp://example.com/', 'http://']) {
    assert.throws(() => L.readInput({ url: bad }), (err) => err instanceof L.LookError && err.message.includes('is not a page look can open') && err.message.includes('http://localhost:3000/'), bad);
  }
});

test('a size is brought inside what a screen can be; the rest has plain defaults', { skip: missing }, () => {
  assert.deepEqual(L.readInput({ url: 'http://localhost:1/' }), { url: 'http://localhost:1/', width: 1280, height: 800, fullPage: false, scrollY: 0 });
  assert.deepEqual(L.readInput({ url: 'http://localhost:1/', width: 390.4, height: 844, fullPage: true, scrollY: 120.6 }), { url: 'http://localhost:1/', width: 390, height: 844, fullPage: true, scrollY: 121 });
  const odd = L.readInput({ url: 'http://localhost:1/', width: 99999, height: 3, scrollY: -50, fullPage: 'yes' });
  assert.deepEqual([odd.width, odd.height, odd.scrollY, odd.fullPage], [1600, 200, 0, false]);
  assert.deepEqual([L.readInput({ url: 'http://localhost:1/', width: NaN }).width, L.readInput({ url: 'http://localhost:1/', width: '390' }).width], [1280, 1280]);
  // A window takes no size: what comes with it is dropped.
  assert.deepEqual(L.readInput({ window: '  Safari ', width: 390 }), { window: 'Safari' });
});

test('only a page on this Mac, or Canopy\'s own window, goes unasked', { skip: missing }, () => {
  for (const args of [{ url: 'http://localhost:3000/' }, { url: 'localhost:5173' }, { url: 'http://127.0.0.1:8080/x' }, { url: 'http://[::1]:3000/' }, { url: 'http://app.localhost:3000/' }, { url: 'http://0.0.0.0:4000/' }]) {
    assert.equal(L.localLook(args), true, JSON.stringify(args));
  }
  // Out on the web a request carries whatever is in its address; a file is read from the disk. Both are asked about.
  for (const args of [{ url: 'https://example.com/' }, { url: 'http://localhost.example.com/' }, { url: 'http://192.168.1.5:5173/' }, { url: '/etc/hosts' }, { url: 'file:///Users/me/.ssh/id_rsa' }]) {
    assert.equal(L.localLook(args), false, JSON.stringify(args));
  }
  // A call that will only be told what was wrong with it captures nothing, so there is nothing to ask.
  assert.equal(L.localLook({}), true);
  // A window is only free when it is this app's own, named outright: its app name, its title or its label.
  const own = [win('Canopy', 'Fix the Code Mode switch', { own: true })];
  for (const name of ['Canopy', ' canopy ', 'Fix the Code Mode switch', 'Canopy: Fix the Code Mode switch', 'Canopy: Fix the Code Mode switch (this app)']) {
    assert.equal(L.localLook({ window: name }, { own }), true, name);
    assert.equal(L.ownWindowNamed(name, own), true, name);
  }
  // Another app's window can be showing anything (a password manager, the user's mail): asked about. So is part of
  // a name, which could as well mean another app ("Code"), and any window when the host has none of its own.
  for (const name of ['Safari', '1Password', 'Code', 'Can', 'Mode']) assert.equal(L.localLook({ window: name }, { own }), false, name);
  assert.equal(L.localLook({ window: 'Canopy' }), false);
  assert.equal(L.localLook({ window: 'Canopy' }, { own: [] }), false);
  assert.equal(L.ownWindowNamed('', own), false);
});

// ---- the picture ----

test('fitSize: no side over the limit, the shape kept, never larger', { skip: missing }, () => {
  assert.deepEqual(L.fitSize(1280, 800), { width: 1280, height: 800, scale: 1 });
  assert.deepEqual(L.fitSize(2880, 1800), { width: 1600, height: 1000, scale: 1600 / 2880 });
  const tall = L.fitSize(390, 4000);
  assert.deepEqual([tall.width, tall.height], [156, 1600]);
  assert.deepEqual(L.fitSize(100, 50, 1600), { width: 100, height: 50, scale: 1 });
  assert.deepEqual(L.fitSize(0, 0), { width: 1, height: 1, scale: 1 });
});

test('encode: a PNG when it is light, a JPEG when it is not, smaller still when even that is heavy', { skip: missing }, () => {
  const light = L.encode(image(1280, 800));
  assert.deepEqual([light.mimeType, light.width, light.height, light.data.length], ['image/png', 1280, 800, 102400]);

  // A Retina capture of a window: brought to 1600 on its longest side before anything is weighed.
  const retina = L.encode(image(2880, 1800));
  assert.deepEqual([retina.mimeType, retina.width, retina.height], ['image/png', 1600, 1000]);
  assert.deepEqual(retina.from, { width: 2880, height: 1800 });

  // A capture at 2x of a 390-wide page goes out at 1x: `within` is the size of what it shows.
  const twice = L.encode(image(780, 1600), { within: { width: 390, height: 800 } });
  assert.deepEqual([twice.width, twice.height], [390, 800]);

  const heavy = L.encode(image(1280, 800, { png: 2, jpeg: 0.5 }));
  assert.deepEqual([heavy.mimeType, heavy.width, heavy.data.length], ['image/jpeg', 1280, 512000]);
  const heavier = L.encode(image(1280, 800, { png: 2, jpeg: 1 })); // 1 MB at quality 80, 768 KB at 60
  assert.deepEqual([heavier.mimeType, heavier.width, heavier.data.length], ['image/jpeg', 1280, 768000]);
  const wall = L.encode(image(1600, 1600, { png: 4, jpeg: 2 }));
  assert.equal(wall.mimeType, 'image/jpeg');
  assert.ok(wall.data.length <= L.MAX_BYTES && wall.width < 1600 && wall.width === wall.height, `${wall.width}×${wall.height}, ${wall.data.length} bytes`);

  for (const nothing of [image(0, 0), image(800, 600, { empty: true })]) {
    assert.throws(() => L.encode(nothing), (err) => err instanceof L.LookError);
  }
});

// ---- a page ----

test('a page comes back as one picture and one line about it', { skip: missing }, async () => {
  const b = backend();
  const r = await L.look({ url: 'localhost:3000/settings', width: 390 }, b);
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.content.map((c) => c.type), ['image', 'text']);
  assert.deepEqual([picture(r).mimeType, Buffer.from(picture(r).data, 'base64').length], ['image/png', 31200]);
  assert.equal(text(r), 'http://localhost:3000/settings at 390×800, showing the viewport. Page size 390×800. No console errors.');
  const { signal, ...asked } = b.asked.page[0];
  assert.deepEqual(asked, { url: 'http://localhost:3000/settings', width: 390, height: 800, fullPage: false, fullHeight: 4000, scrollY: 0 });
});

test('the line says what a glance would miss: a page too wide, an HTTP error, console errors, a page still loading', { skip: missing }, async () => {
  const wide = await L.look({ url: 'http://localhost:3000/', width: 390, scrollY: 600 }, backend({
    pageSize: { width: 1552, height: 2140 },
    page: { status: 404, errors: ['Uncaught TypeError: x is\n  not a function.', 'second'], slow: true, url: 'http://localhost:3000/login' },
  }));
  assert.equal(text(wide), 'http://localhost:3000/ at 390×800, showing the viewport scrolled to y=600. It went on to http://localhost:3000/login.'
    + ' If this is a sign-in page, look cannot sign in: ask the user to open the page in their browser, then look at that window instead (window: "Safari"). Page size 1552×2140.'
    + ' The page is 1552px wide, wider than the 390px viewport (it scrolls sideways). HTTP 404. The page was still loading when this was taken.'
    + ' 2 console errors, first: Uncaught TypeError: x is not a function.');
});

test('a full page is one picture, made smaller when it is tall, and the line says how to see it closer', { skip: missing }, async () => {
  const short = await L.look({ url: 'http://localhost:3000/', fullPage: true }, backend({ pageSize: { width: 1280, height: 1500 } }));
  assert.equal(text(short), 'http://localhost:3000/ at 1280×800, showing the full page. Page size 1280×1500. No console errors.');

  const tall = await L.look({ url: 'http://localhost:3000/', width: 390, fullPage: true }, backend({ pageSize: { width: 390, height: 3200 } }));
  assert.ok(text(tall).includes('showing the full page. Page size 390×3200.'));
  assert.ok(text(tall).endsWith('The image is scaled down to 195×1600 to fit. Pass scrollY instead of fullPage to see one part at full size.'), text(tall));

  const endless = await L.look({ url: 'http://localhost:3000/', fullPage: true }, backend({ pageSize: { width: 1280, height: 9000 } }));
  assert.ok(text(endless).includes('showing the first 4000px of the full page. Page size 1280×9000.'), text(endless));

  const high = await L.look({ url: 'http://localhost:3000/', height: 2400 }, backend());
  assert.ok(text(high).endsWith('The image is scaled down to 853×1600 to fit. Use a height of 1600 or less to see it at full size.'), text(high));
});

test('a page that cannot be shown says why, and what to do next', { skip: missing }, async () => {
  const failed = async (pageError, url = 'http://localhost:3000/') => {
    const r = await L.look({ url }, backend({ pageError }));
    assert.equal(r.isError, true);
    assert.deepEqual(r.content.map((c) => c.type), ['text'], 'no picture with an error');
    return text(r);
  };
  const load = (reason) => Object.assign(new Error(`${reason} (-1) loading`), { code: 'load', reason });
  assert.equal(await failed(load('ERR_CONNECTION_REFUSED')), 'Could not open http://localhost:3000/: nothing is listening at that address. Start the dev server (or check the port), then look again.');
  assert.ok((await failed(load('ERR_NAME_NOT_RESOLVED'), 'http://nope.invalid/')).endsWith('that host name does not exist. Check the address, then look again.'));
  assert.ok((await failed(load('ERR_FILE_NOT_FOUND'), '/tmp/nope.html')).startsWith('Could not open file:///tmp/nope.html: there is no file at that path.'));
  assert.equal(await failed(load('ERR_SOMETHING_NEW')), 'Could not open http://localhost:3000/: the browser said ERR_SOMETHING_NEW. Check the address and that the server is running, then look again.');
  assert.equal(await failed(Object.assign(new Error('x'), { code: 'timeout' })), 'http://localhost:3000/ did not load in time, so there is no screenshot. Check that the server answers (curl -I http://localhost:3000/), then look again.');
  assert.equal(await failed(Object.assign(new Error('x'), { code: 'download' })), 'http://localhost:3000/ is a download, not a page look can show. Pass the address of a page.');
  assert.equal(await failed(Object.assign(new Error('x'), { code: 'aborted' })), 'The look was stopped before the page was captured.');
  assert.equal(await failed(new Error('Object has been destroyed')), 'Could not take a screenshot of http://localhost:3000/: Object has been destroyed. Try once more; if it fails again, check the page another way and tell the user you could not see it.');
  // A page that drew nothing is an error, never an empty picture passed off as a look.
  const blank = await L.look({ url: 'http://localhost:3000/' }, backend({ image: image(1280, 800, { empty: true }) }));
  assert.deepEqual([blank.isError, text(blank)], [true, 'The screenshot came back empty.']);
});

test('without a backend the tool says it cannot see, and to say so', { skip: missing }, async () => {
  for (const args of [{ url: 'http://localhost:3000/' }, { window: 'Safari' }]) {
    const r = await L.look(args, null);
    assert.equal(r.isError, true);
    assert.equal(text(r), 'look cannot take screenshots here: it only works inside the Canopy app. Check the result another way (a headless browser, a test), and tell the user you could not see it.');
  }
});

// ---- a window ----

test('pickWindow: the closest kind of match wins', { skip: missing }, () => {
  const mail = win('Mail', 'Inbox – 3 messages');
  const safari = win('Safari', 'Mail settings – Apple Support');
  const notes = win('Notes', 'Mail');
  // The whole app name beats part of a title; the whole title ties with it, and a tie between apps is not guessed.
  assert.equal(L.pickWindow('mail', [safari, mail]).hit, mail);
  assert.deepEqual(L.pickWindow('Mail', [safari, mail, notes]).ambiguous, [mail, notes]);
  assert.equal(L.pickWindow('apple support', [safari, mail]).hit, safari);
  assert.equal(L.pickWindow('  INBOX –   3 messages ', [safari, mail]).hit, mail);
  assert.deepEqual(L.pickWindow('Keynote', [safari, mail]), { none: true });
  assert.deepEqual(L.pickWindow('Safari', []), { none: true });
  // Several windows of one app are one answer: the frontmost, with the rest named.
  const a = win('Safari', 'Apple'), b = win('Safari', 'GitHub'), c = win('Safari', 'Docs');
  assert.deepEqual(L.pickWindow('Safari', [mail, a, b, c]), { hit: a, others: [b, c] });
  // Part of a name found in two apps is a question for whoever asked.
  assert.deepEqual(L.pickWindow('settings', [safari, win('System Settings', 'Displays')]).ambiguous.length, 2);
});

test('a name from a list picks exactly that window, this app\'s or another copy\'s', { skip: missing }, () => {
  const mine = win('Canopy', 'Canopy', { own: true });
  const copy = win('Canopy', 'Canopy');
  assert.deepEqual([L.windowLabel(mine), L.windowLabel(copy), L.windowLabel(win('', ''))], ['Canopy: Canopy (this app)', 'Canopy: Canopy', '(untitled)']);
  assert.deepEqual(L.pickWindow('Canopy', [mine, copy]).ambiguous, [mine, copy]);
  assert.equal(L.pickWindow('Canopy: Canopy (this app)', [mine, copy]).hit, mine);
  assert.equal(L.pickWindow('canopy: canopy', [mine, copy]).hit, copy);
  assert.equal(L.pickWindow('Canopy: Canopy', [mine]).hit, mine, 'with no other copy, the plain name is this app');
});

test('Canopy\'s own window needs no permission, and asking for it does not make macOS ask for one', { skip: missing }, async () => {
  const b = backend({ access: 'denied', own: [win('Canopy', 'Canopy', { own: true, image: image(2880, 1800) })] });
  const r = await L.look({ window: 'canopy' }, b);
  assert.equal(r.isError, undefined);
  assert.equal(text(r), 'Window "Canopy: Canopy (this app)", 1600×1000.');
  assert.equal(b.asked.other, 0, 'other apps\' windows were never asked for');
});

test('another app\'s window without Screen Recording permission: the error is the exact steps', { skip: missing }, async () => {
  // The row is named as macOS names it today, with its older name, and the command that opens that page.
  const steps = 'Canopy cannot see the "Safari" window: macOS has not given it screen recording permission, which it needs for other apps\' windows. '
    + 'Ask the user to open System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on older macOS), turn on Canopy, then quit and reopen Canopy. '
    + 'You can open that page of System Settings for them by running: open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture". '
    + 'Until then look still works for web pages (url) and for Canopy\'s own window.';
  // Nothing of that name can be seen. The other windows were asked for: that is what makes macOS show its prompt.
  const unseen = backend({ access: 'denied', own: [win('Canopy', 'Canopy', { own: true })] });
  const r = await L.look({ window: 'Safari' }, unseen);
  assert.deepEqual([r.isError, text(r)], [true, steps]);
  assert.equal(unseen.asked.other, 1);
  // The window is listed but gives no picture.
  for (const blank of [null, image(1440, 900, { empty: true })]) {
    const listed = await L.look({ window: 'Safari' }, backend({ access: 'not-determined', others: [win('Safari', '', { image: blank })] }));
    assert.deepEqual([listed.isError, text(listed)], [true, steps]);
  }
  // The app's name in the steps is the host's own (a dev build is not called Canopy in System Settings).
  const dev = await L.look({ window: 'Safari' }, backend({ access: 'denied', appName: 'Electron' }));
  assert.ok(text(dev).includes('turn on Electron, then quit and reopen Electron'));
});

test('another app\'s window with the permission: found by app or title, the frontmost of several', { skip: missing }, async () => {
  const others = [win('Safari', 'Apple', { image: image(3200, 2000) }), win('Safari', 'GitHub'), win('Mail', 'Inbox')];
  const b = backend({ own: [win('Canopy', 'Canopy', { own: true })], others });
  const safari = await L.look({ window: 'Safari' }, b);
  assert.equal(text(safari), 'Window "Safari: Apple", 1600×1000. It is the frontmost of 2 matching windows; the others: "Safari: GitHub".');
  assert.equal(picture(safari).mimeType, 'image/png');
  assert.equal(text(await L.look({ window: 'inbox' }, b)), 'Window "Mail: Inbox", 1440×900.');
});

test('no such window, or more than one: the error lists what to pass instead', { skip: missing }, async () => {
  const b = backend({ own: [win('Canopy', 'Canopy', { own: true })], others: [win('Canopy', 'Canopy'), win('Safari', 'Apple'), win('Safari', 'Apple'), win('Mail', 'Inbox')] });
  const none = await L.look({ window: 'Simulator' }, b);
  assert.deepEqual([none.isError, text(none)], [true, 'No open window matches "Simulator". The open windows are: "Canopy: Canopy (this app)", "Canopy: Canopy", "Safari: Apple", "Mail: Inbox". '
    + 'Pass one of these as window, or open the app first (a minimized or hidden window cannot be seen).']);
  const two = await L.look({ window: 'Canopy' }, b);
  assert.deepEqual([two.isError, text(two)], [true, '"Canopy" matches 2 windows: "Canopy: Canopy (this app)", "Canopy: Canopy". Pass one of these names, exactly as written, as window.']);
  assert.equal(text(await L.look({ window: 'Canopy: Canopy' }, b)), 'Window "Canopy: Canopy", 1440×900.');

  const many = backend({ others: Array.from({ length: 20 }, (_, i) => win(`App ${i}`, 'Main')) });
  assert.ok(text(await L.look({ window: 'Nope' }, many)).includes('"App 11: Main", and 8 more.'));
  const empty = await L.look({ window: 'Safari' }, backend());
  assert.ok(text(empty).startsWith('No open window matches "Safari", and no windows could be seen at all. Open the app first;'), text(empty));
});

test('a window that will not draw is an error that says to bring it forward', { skip: missing }, async () => {
  const stuck = backend({ own: [win('Canopy', 'Canopy', { own: true, capture: async () => { throw new Error('the window did not draw'); } })] });
  assert.equal(text(await L.look({ window: 'Canopy' }, stuck)), 'Could not capture "Canopy: Canopy (this app)": the window did not draw. Bring the window to the front, then look again.');
  const blank = backend({ others: [win('Safari', 'Apple', { image: null })] });
  const r = await L.look({ window: 'Safari' }, blank);
  assert.deepEqual([r.isError, text(r)], [true, 'The capture of "Safari: Apple" came back empty. Bring the window to the front (not minimized, on this desktop), then look again.']);
});

test('a look nobody was asked about sees this app\'s own windows and no other', { skip: missing }, async () => {
  const b = backend({ own: [win('Canopy', 'Canopy', { own: true })], others: [win('Canopy', 'Canopy'), win('1Password', 'All Items'), win('Mail', 'Inbox')] });
  // Asked about and allowed, "Canopy" is two windows; unasked, it is this app's, and the others are never listed.
  const mine = await L.look({ window: 'Canopy' }, b, { unasked: true });
  assert.equal(text(mine), 'Window "Canopy: Canopy (this app)", 1440×900.');
  // A name that is no window of this app's: nothing is captured, and no other app's window is named in the answer.
  const none = await L.look({ window: '1Password' }, b, { unasked: true });
  assert.deepEqual([none.isError, text(none)], [true, 'No open window matches "1Password". The open windows are: "Canopy: Canopy (this app)". '
    + 'Pass one of these as window, or open the app first (a minimized or hidden window cannot be seen).']);
  assert.equal(b.asked.other, 0, 'other apps\' windows were never asked for');
  // The same call once the user said yes.
  assert.equal(text(await L.look({ window: '1Password' }, b)), 'Window "1Password: All Items", 1440×900.');
});

// ---- the server ----

test('the server carries the one tool, always loaded and never marked read-only', { skip: missing }, async () => {
  const b = backend();
  const server = L.createLookServer({ backend: b });
  assert.deepEqual([server.type, server.name], ['sdk', 'canopy_look']);
  const tools = server.instance._registeredTools;
  assert.deepEqual(Object.keys(tools), ['look']);
  assert.equal(tools.look.description, L.LOOK_DESCRIPTION);
  // Claude Code runs a read-only tool in Plan mode without asking anyone: a look can open any web address or any
  // file, so it must never carry the mark (with it, Plan mode opened https://example.com/ and /etc/hosts unasked).
  assert.ok(!('readOnlyHint' in tools.look.annotations), 'Plan mode must ask before a look out on the web or at a file');
  assert.equal(tools.look.annotations.destructiveHint, false);
  assert.equal(tools.look._meta?.['anthropic/alwaysLoad'], true, 'never behind tool search');
  const r = await tools.look.handler({ url: 'http://localhost:3000/' }, {});
  assert.deepEqual(r.content.map((c) => c.type), ['image', 'text']);
  // A host that is still starting can give its backend later: a function is read at each call.
  let late = null;
  const lazy = L.createLookServer({ backend: () => late }).instance._registeredTools.look;
  assert.ok(text(await lazy.handler({ url: 'http://localhost:3000/' }, {})).startsWith('look cannot take screenshots here'));
  late = b;
  assert.equal((await lazy.handler({ url: 'http://localhost:3000/' }, {})).isError, undefined);
  // The host says which calls it let through without asking; those see its own windows only.
  const seen = [];
  const o = backend({ own: [win('Canopy', 'Canopy', { own: true })], others: [win('Mail', 'Inbox')] });
  const guarded = L.createLookServer({ backend: o, unasked: (id) => { seen.push(id); return id === 'toolu_free'; } }).instance._registeredTools.look;
  assert.equal((await guarded.handler({ window: 'Mail' }, { _meta: { 'claudecode/toolUseId': 'toolu_free' } })).isError, true);
  assert.equal(text(await guarded.handler({ window: 'Mail' }, { _meta: { 'claudecode/toolUseId': 'toolu_asked' } })), 'Window "Mail: Inbox", 1440×900.');
  assert.deepEqual(seen, ['toolu_free', 'toolu_asked']);
});

// ---- shots: every picture is kept for the chat, and the result says under which ref ----

// Where a chat keeps its shots, standing in for shots.mjs forChat(): what it was handed, and the refs it gave.
function keeper(o = {}) {
  const kept = [];
  return { kept, put(shot) { if (o.throws) throw new Error('disk gone'); kept.push(shot); return o.ref ?? `look-${kept.length}`; } };
}

test('a kept picture adds exactly one line to the result, naming its ref', { skip: missing }, async () => {
  assert.equal(L.savedLine('look-3'), 'Saved as shot "look-3": show it in a widget with <canopy-shot ref="look-3"> or <canopy-review ref="look-3">.');
  const els = [{ x: 1, y: 2, w: 3, h: 4, tag: 'h1', text: 'Hi' }];
  const shots = keeper({ ref: 'look-3' });
  const r = await L.look({ url: 'localhost:3000/settings', width: 390 }, backend({ page: { elements: els } }), { shots });
  assert.equal(text(r), `http://localhost:3000/settings at 390×800, showing the viewport. Page size 390×800. No console errors.\n${L.savedLine('look-3')}`);
  assert.equal(picture(r).mimeType, 'image/png', 'what the model sees is unchanged');
  const [kept] = shots.kept;
  assert.deepEqual([kept.width, kept.height, kept.url, kept.elements], [390, 800, 'http://localhost:3000/settings', els]);
  assert.equal(kept.jpeg.length, Math.round(390 * 800 * 0.05), 'a JPEG at quality 80, at the size of what it shows');
  assert.equal(typeof kept.capturedAt, 'number');

  // A full page that came back larger than it shows (a Retina capture) is kept at its CSS size, its map scaled along.
  const big = keeper();
  await L.look({ url: 'http://localhost:3000/', width: 400, height: 300 }, backend({ image: image(800, 600), page: { elements: [{ x: 10, y: 10, w: 20, h: 20, tag: 'p' }] } }), { shots: big });
  assert.deepEqual([big.kept[0].width, big.kept[0].height], [400, 300]);

  // A window: kept at the size it was sent at, with no map.
  const w = keeper();
  const r2 = await L.look({ window: 'Mail' }, backend({ others: [win('Mail', 'Inbox')] }), { shots: w });
  assert.equal(text(r2), `Window "Mail: Inbox", 1440×900.\n${L.savedLine('look-1')}`);
  assert.deepEqual([w.kept[0].width, w.kept[0].height, w.kept[0].elements, w.kept[0].url], [1440, 900, null, null]);
});

test('without a place to keep it, or when keeping fails, the look is just as it was', { skip: missing }, async () => {
  const plain = 'http://localhost:3000/ at 1280×800, showing the viewport. Page size 1280×800. No console errors.';
  assert.equal(text(await L.look({ url: 'http://localhost:3000/' }, backend())), plain);
  assert.equal(text(await L.look({ url: 'http://localhost:3000/' }, backend(), { shots: keeper({ throws: true }) })), plain);
  assert.equal(text(await L.look({ url: 'http://localhost:3000/' }, backend(), { shots: keeper({ ref: '../x' }) })), plain, 'only a real ref is named');
  assert.equal(text(await L.look({ url: 'http://localhost:3000/' }, backend(), { shots: { put: () => null } })), plain);
  const failed = await L.look({ url: 'http://localhost:3000/' }, backend({ pageError: Object.assign(new Error('x'), { code: 'timeout' }) }), { shots: keeper() });
  assert.equal(failed.isError, true);
  assert.ok(!text(failed).includes('Saved as shot'));
});

test('the server and the registry pass the chat\'s shots to the tool', { skip: missing }, async () => {
  const shots = keeper();
  const tool = L.createLookServer({ backend: backend(), shots }).instance._registeredTools.look;
  assert.ok(text(await tool.handler({ url: 'http://localhost:3000/' }, {})).endsWith(L.savedLine('look-1')));
  const r = await L.LOOK.run({ url: 'http://localhost:3000/' }, { look: backend(), shots });
  assert.ok(text(r).endsWith(L.savedLine('look-2')));
});

// ---- look-capture.mjs: the Mac's window list ----

test('the window list is read as rows, and anything else as none', () => {
  assert.deepEqual(parseWindowList('[{"id":12,"app":"Safari","title":"Apple"},{"id":"x","app":"Bad"},null,{"id":13}]\n'), [{ id: 12, app: 'Safari', title: 'Apple' }, { id: 13, app: '', title: '' }]);
  for (const junk of ['', 'execution error: nope', '{"id":1}', undefined]) assert.deepEqual(parseWindowList(junk), []);
});

test('what the capturer saw is joined with the window list: each window with its app, front to back, this app\'s left out', () => {
  const src = (id, name) => ({ id: `window:${id}:0`, name, thumbnail: `picture of ${id}` });
  const rows = [{ id: 30, app: 'Mail', title: 'Inbox' }, { id: 10, app: 'Safari', title: 'Apple' }, { id: 20, app: 'Canopy', title: 'Canopy' }];
  const joined = joinWindows([src(10, 'Apple'), src(20, 'Canopy'), src(99, 'Mystery'), src(30, '')], rows, new Set([20]));
  assert.deepEqual(joined, [
    { app: 'Mail', title: 'Inbox', image: 'picture of 30' },   // the capturer had no title: the list's is used
    { app: 'Safari', title: 'Apple', image: 'picture of 10' },
    { app: '', title: 'Mystery', image: 'picture of 99' },      // not in the list: found by its title, and last
  ]);
});

// Electron, standing in. A window's page loads at once unless `load` says how it fails.
function electron(o = {}) {
  const made = [];
  const calls = { sources: 0, cleared: 0 };
  const session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, clearCache: async () => { calls.cleared++; }, clearStorageData: async () => {} };
  class BrowserWindow {
    static all = [...(o.windows ?? [])];
    static getAllWindows() { return BrowserWindow.all; }
    constructor(opts) {
      this.opts = opts; this.destroyed = false; this.handlers = {};
      const self = this;
      this.webContents = {
        session,
        on(name, fn) { self.handlers[name] = fn; },
        setAudioMuted() {}, setWindowOpenHandler() {}, stop() {}, getURL: () => self.url,
        async loadURL(url) {
          self.url = url;
          o.onLoad?.(self);
          const failure = typeof o.load === 'function' ? o.load(url) : o.load;
          if (failure) throw failure;
          self.handlers['did-navigate']?.({}, url, 200);
          self.handlers['dom-ready']?.();
          self.handlers['console-message']?.({ level: 'error', message: 'boom' });
          self.handlers['console-message']?.({ level: 'info', message: 'hello' });
        },
        async executeJavaScript(code) {
          if (code.includes('collectElements')) { calls.mapped = code; if (o.mapFails) throw new Error('page said no'); return o.elements ?? null; }
          return code.includes('scrollWidth') ? { width: 1500, height: 5000, y: o.scrolled ?? 0 } : null;
        },
        async capturePage() { return image(opts.width, opts.height); },
        debugger: { attach() {}, detach() {}, sendCommand: async (_m, p) => ({ data: Buffer.from(`${p.clip.width}x${p.clip.height}`).toString('base64') }) },
      };
      made.push(this);
      BrowserWindow.all.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; BrowserWindow.all = BrowserWindow.all.filter((w) => w !== this); }
  }
  return {
    made, calls,
    electron: {
      BrowserWindow,
      desktopCapturer: { getSources: async (opts) => { calls.sources++; calls.sourceOpts = opts; return o.sources ?? []; } },
      systemPreferences: { getMediaAccessStatus: () => { if (o.accessThrows) throw new Error('no'); return o.access ?? 'granted'; } },
      nativeImage: { createFromBuffer: (b) => ({ from: b.toString() }) },
    },
  };
}
const appWindow = (id, title) => ({ isDestroyed: () => false, getTitle: () => title, getMediaSourceId: () => `window:${id}:0`, webContents: { capturePage: async () => image(2880, 1800) } });

test('a page is rendered in a window that is never shown, shares nothing with Canopy, and is gone afterwards', async () => {
  const e = electron();
  const capture = createLookCapture({ electron: e.electron, platform: 'darwin', exec: () => {} });
  const r = await capture.page({ url: 'http://localhost:3000/', width: 390, height: 800, fullPage: false, fullHeight: 4000, scrollY: 0 });
  assert.deepEqual([r.captured, r.page, r.status, r.errors, r.slow, r.url], [{ width: 390, height: 800 }, { width: 1500, height: 5000 }, 200, ['boom'], false, 'http://localhost:3000/']);
  assert.deepEqual(r.image.getSize(), { width: 390, height: 800 });
  const [w] = e.made;
  assert.deepEqual([w.opts.show, w.opts.width, w.opts.height, w.opts.focusable], [false, 390, 800, false]);
  const prefs = w.opts.webPreferences;
  assert.deepEqual([prefs.offscreen, prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.disableDialogs, prefs.preload], [true, true, true, false, true, undefined]);
  assert.ok(prefs.partition && !prefs.partition.startsWith('persist:'), 'what a page stores does not outlive the app');
  assert.equal(e.calls.cleared, 1, 'no copy of the page is kept from one look to the next');
  assert.equal(w.destroyed, true);

  // The whole page: captured beyond the window, down to the limit, without resizing it.
  const full = await capture.page({ url: 'http://localhost:3000/', width: 390, height: 800, fullPage: true, fullHeight: 4000, scrollY: 300 });
  assert.deepEqual([full.image, full.captured, full.scrollY], [{ from: '390x4000' }, { width: 390, height: 4000 }, 0]);
  assert.equal(e.made[1].destroyed, true);
});

test('a page brings back its element map, read in the area of the picture; a page that will not say has none', async () => {
  const els = [{ x: 1, y: 2, w: 3, h: 4, tag: 'button', role: null, text: 'Go', selector: '#go' }];
  const e = electron({ elements: els, scrolled: 600 });
  const capture = createLookCapture({ electron: e.electron, platform: 'darwin', exec: () => {} });
  const r = await capture.page({ url: 'http://localhost:3000/', width: 390, height: 800, fullPage: false, fullHeight: 4000, scrollY: 600 });
  assert.deepEqual(r.elements, els);
  assert.match(e.calls.mapped, /\{"top":600,"width":390,"height":800,"max":400\}\)$/, 'the viewport, where it was scrolled to');
  await capture.page({ url: 'http://localhost:3000/', width: 390, height: 800, fullPage: true, fullHeight: 4000, scrollY: 0 });
  assert.match(e.calls.mapped, /\{"top":0,"width":390,"height":4000,"max":400\}\)$/, 'the full page, from its top');

  const logged = [];
  const quiet = createLookCapture({ electron: electron({ mapFails: true }).electron, platform: 'darwin', exec: () => {}, log: (m) => logged.push(m) });
  const r2 = await quiet.page({ url: 'http://localhost:3000/', width: 390, height: 800, fullPage: false, fullHeight: 4000, scrollY: 0 });
  assert.equal(r2.elements, null);
  assert.ok(r2.image, 'the picture is still taken');
  assert.deepEqual(logged, ['look: element map failed: page said no']);
});

test('a page that fails to load is an error with the browser\'s reason, and its window is still closed', async () => {
  const refused = electron({ load: Object.assign(new Error('ERR_CONNECTION_REFUSED (-102) loading'), { code: 'ERR_CONNECTION_REFUSED', errno: -102 }) });
  const capture = createLookCapture({ electron: refused.electron, platform: 'darwin', exec: () => {} });
  await assert.rejects(capture.page({ url: 'http://localhost:1/', width: 1280, height: 800 }), (err) => err.code === 'load' && err.reason === 'ERR_CONNECTION_REFUSED');
  assert.equal(refused.made[0].destroyed, true);
  // Through the tool, that is the sentence Claude reads.
  const said = await L.look({ url: 'http://localhost:1/' }, capture);
  assert.ok(text(said).includes('nothing is listening at that address'), text(said));

  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(capture.page({ url: 'http://localhost:1/', width: 1280, height: 800, signal: stopped.signal }), (err) => err.code === 'aborted');
  assert.equal(refused.made.length, 2, 'a look stopped before it began opens no window');
});

test('pages are rendered one at a time, and their window is never listed as Canopy\'s own', async () => {
  const open = [];
  let capture = null;
  const e = electron({ windows: [appWindow(7, 'Canopy')], onLoad: (w) => { open.push(e.made.filter((x) => !x.destroyed && x !== w).length); assert.deepEqual(capture.ownWindows().map((x) => x.title), ['Canopy']); } });
  capture = createLookCapture({ electron: e.electron, platform: 'darwin', exec: () => {} });
  const all = await Promise.all([390, 768, 1280].map((width) => capture.page({ url: 'http://localhost:3000/', width, height: 800 })));
  assert.deepEqual(all.map((r) => r.captured.width), [390, 768, 1280]);
  assert.deepEqual(open, [0, 0, 0], 'no page loads while another look\'s window is open');
  assert.deepEqual(capture.ownWindows().map((w) => [w.app, w.title, w.own]), [['Canopy', 'Canopy', true]]);
});

test('a look that fails does not hold up the one waiting behind it', async () => {
  const e = electron({ load: (url) => (url.includes('down') ? Object.assign(new Error('refused'), { code: 'ERR_CONNECTION_REFUSED', errno: -102 }) : null) });
  const capture = createLookCapture({ electron: e.electron, platform: 'darwin', exec: () => {} });
  const [bad, good] = await Promise.allSettled([capture.page({ url: 'http://down:1/', width: 1280, height: 800 }), capture.page({ url: 'http://localhost:3000/', width: 390, height: 800 })]);
  assert.deepEqual([bad.status, bad.reason?.code, good.status, good.value?.captured], ['rejected', 'load', 'fulfilled', { width: 390, height: 800 }]);
  assert.ok(e.made.every((w) => w.destroyed));
});

test('other apps\' windows: listed from the window list, and only the chosen one is captured', async () => {
  const sources = [{ id: 'window:10:0', name: 'Apple', thumbnail: 'picture of 10' }, { id: 'window:7:0', name: 'Canopy', thumbnail: 'picture of 7' }];
  const e = electron({ windows: [appWindow(7, 'Canopy')], sources });
  const rows = JSON.stringify([{ id: 10, app: 'Safari', title: 'Apple' }, { id: 7, app: 'Canopy', title: 'Canopy' }, { id: 11, app: 'Mail', title: 'Inbox' }]);
  const ran = [];
  const exec = (cmd, args, opts, done) => { ran.push([cmd, args[0], args[1]]); done(null, rows); };
  const capture = createLookCapture({ electron: e.electron, platform: 'darwin', exec });
  const list = await capture.otherWindows();
  assert.deepEqual(list.map((w) => [w.app, w.title]), [['Safari', 'Apple'], ['Mail', 'Inbox']], 'this app\'s own window is not among the others');
  assert.deepEqual(ran, [['/usr/bin/osascript', '-l', 'JavaScript']]);
  assert.equal(e.calls.sources, 0, 'listing takes no pictures');
  assert.equal(await list[0].capture(), 'picture of 10');
  assert.deepEqual([e.calls.sources, e.calls.sourceOpts.types, e.calls.sourceOpts.thumbnailSize], [1, ['window'], { width: 1600, height: 1600 }]);
  assert.equal(await list[1].capture(), null, 'a window the capturer cannot see gives no picture');
});

test('without the permission, or when the window list fails, the capturer\'s own list is what there is', async () => {
  const sources = [{ id: 'window:10:0', name: 'Apple', thumbnail: 'picture of 10' }];
  const denied = electron({ access: 'denied', sources });
  const logged = [];
  const capture = createLookCapture({ electron: denied.electron, platform: 'darwin', exec: (c, a, o, done) => done(new Error('osascript is gone')), log: (m) => logged.push(m) });
  assert.equal(capture.screenAccess(), 'denied');
  const list = await capture.otherWindows();
  assert.equal(denied.calls.sources, 1, 'the try to capture is what makes macOS ask for the permission');
  assert.deepEqual(list.map((w) => [w.app, w.title]), [['', 'Apple']]);
  assert.equal(await list[0].capture(), 'picture of 10');
  assert.deepEqual(logged, ['look: window list failed: osascript is gone']);

  // Not a Mac: no permission to have, no window list to read.
  const ran = [];
  const linux = createLookCapture({ electron: electron({ access: 'denied', sources }).electron, platform: 'linux', exec: (...a) => ran.push(a) });
  assert.equal(linux.screenAccess(), 'granted');
  assert.deepEqual((await linux.otherWindows()).map((w) => w.title), ['Apple']);
  assert.equal(ran.length, 0);
  assert.equal(createLookCapture({ electron: electron({ accessThrows: true }).electron, platform: 'darwin' }).screenAccess(), 'unknown');
});

// ---- Session's side ----

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-look-')));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const open = [];
afterEach(async () => { for (const s of open.splice(0)) { try { await within(s.dispose({ graceMs: 100 }), 4000, 'dispose'); } catch { /* reported by the test itself */ } } });
function session(opts = {}, script = {}) {
  const fake = createFake(script);
  const s = new S.Session({ cwd: root, claudePath: '/usr/bin/true', env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, trusted: true, personalMemory: false, queryFn: fake.queryFn, ...opts });
  open.push(s);
  return { s, fake, w: watch(s) };
}

test('a chat has look from its first turn when the host can take screenshots, and not otherwise', { skip: noSession }, async () => {
  const plain = session();
  await plain.s.warm();
  assert.ok(!('canopy_look' in plain.fake.current.options.mcpServers), 'plain Node has nothing to look with: no tool that can only fail');

  const CAN = [...CAPABILITIES, ...(M.CODE_CAPS ?? [])];
  const { s, fake } = session({ look: backend(), codeMode: true }, { capabilities: CAN });
  await s.warm();
  // Before Code Mode's server, which comes and goes: look's place among the tools never moves during a chat.
  // (canopy_chats is read_chat's server, read-chat.mjs, and canopy_task is task's, task-tool.mjs: always there too.)
  assert.deepEqual(Object.keys(fake.current.options.mcpServers), ['visualize', 'canopy_look', 'canopy_chats', 'canopy_task', 'canopy']);
  const mine = fake.current.options.mcpServers.canopy_look;
  assert.deepEqual([mine.type, mine.name], ['sdk', 'canopy_look']);
  await s.set('codeMode', false);
  await s.set('codeMode', true);
  const payloads = fake.current.calls.filter((c) => c.method === 'setMcpServers').map((c) => c.args[0]);
  assert.deepEqual(payloads.map((p) => Object.keys(p)), [['visualize', 'canopy_look', 'canopy_chats', 'canopy_task'], ['visualize', 'canopy_look', 'canopy_chats', 'canopy_task', 'canopy']]);
  assert.ok(payloads.every((p) => p.canopy_look === mine), 'one server for the life of the process');
  // The tool reaches the backend the host gave.
  const r = await mine.instance._registeredTools.look.handler({ url: 'http://localhost:3000/' }, {});
  assert.deepEqual(r.content.map((c) => c.type), ['image', 'text']);
});

test('looking at a page on this Mac, or at Canopy\'s own window, never asks; the web, a file, or another app\'s window does', { skip: noSession }, async () => {
  const b = backend({ own: [win('Canopy', 'Canopy', { own: true })], others: [win('Canopy', 'Canopy'), win('1Password', 'All Items')] });
  const { s, w, fake } = session({ look: b });
  await s.warm();
  let n = 0;
  for (const input of [{ url: 'http://localhost:5173/', width: 390 }, { window: 'Canopy' }]) {
    const id = `toolu_${++n}`;
    const answer = await within(s.broker(L.LOOK_TOOL, input, { toolUseID: id }), 1000, 'the answer');
    assert.deepEqual(answer, { behavior: 'allow', updatedInput: input, toolUseID: id });
  }
  assert.equal(w.of('permission').length, 0);
  // The window look that was let through sees Canopy's own window and no other app's: asked about and allowed,
  // the same name would be two windows (another copy of the app is open).
  const tool = fake.current.options.mcpServers.canopy_look.instance._registeredTools.look;
  const call = (input, id) => tool.handler(input, { _meta: { 'claudecode/toolUseId': id } });
  assert.equal(text(await call({ window: 'Canopy' }, 'toolu_2')), 'Window "Canopy: Canopy (this app)", 1440×900.');
  assert.equal(b.asked.other, 0);
  assert.ok(text(await call({ window: 'Canopy' }, 'toolu_allowed_by_the_user')).startsWith('"Canopy" matches 2 windows'));
  // Out on the web, a file, and any window that is not Canopy's own (a password manager, the user's mail).
  let asks = 0;
  for (const input of [{ url: 'https://example.com/?q=secret' }, { url: '/etc/hosts' }, { window: '1Password' }, { window: 'Safari' }, { window: 'Can' }]) {
    s.broker(L.LOOK_TOOL, input, { toolUseID: `toolu_${++n}` }).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const asked = w.of('permission');
    assert.equal(asked.length, ++asks, JSON.stringify(input));
    assert.equal(asked.at(-1).toolName, L.LOOK_TOOL);
  }
  // Plan mode asks about every tool that is not marked read-only, and says the mode is why: a look at this Mac is
  // still free there, and one beyond it is still asked about.
  const planned = await within(s.broker(L.LOOK_TOOL, { url: 'http://localhost:5173/' }, { toolUseID: `toolu_${++n}`, decisionReasonType: 'mode' }), 1000, 'the answer');
  assert.equal(planned.behavior, 'allow');
  s.broker(L.LOOK_TOOL, { url: 'https://example.com/' }, { toolUseID: `toolu_${++n}`, decisionReasonType: 'mode' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.of('permission').length, ++asks);
  // An ask the user set up themselves (a rule, a hook) is put to them even for a look that is otherwise free.
  for (const ctx of [{ decisionReasonType: 'rule' }, { decisionReasonType: 'hook' }, { matchedAskRule: { source: 'userSettings', toolName: L.LOOK_TOOL } }, { requiresInteraction: true }]) {
    s.broker(L.LOOK_TOOL, { url: 'http://localhost:5173/' }, { toolUseID: `toolu_${++n}`, ...ctx }).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.of('permission').length, ++asks, JSON.stringify(ctx));
  }
});

test('a Claude chat keeps its looks under its own id, and a widget finds them there', { skip: noSession || !SH.createShotStore }, async () => {
  const store = SH.createShotStore({ dir: path.join(root, 'shots') });
  const id = '0b5c1f3e-1111-4222-8333-444455556666';
  const { s, fake } = session({ look: backend(), shots: store, resume: id });
  await s.warm();
  const tool = fake.current.options.mcpServers.canopy_look.instance._registeredTools.look;
  const r = await tool.handler({ url: 'http://localhost:3000/' }, {});
  assert.ok(text(r).endsWith(`\n${L.savedLine('look-1')}`));
  const got = store.get(id, 'look-1');
  assert.deepEqual([got.width, got.height, got.url], [1280, 800, 'http://localhost:3000/']);
  assert.ok(got.data.startsWith('data:image/jpeg;base64,'));
  assert.equal(store.get('another-chat', 'look-1'), null);
});

// Where the pictures of Claude's look tool come from (src/core/look.mjs says what is asked of this file).
//
//  - a page: loaded in a window of Electron's own Chromium that is never shown, at the size asked for, and captured
//    once it has loaded and settled. Nothing has to be installed, and localhost works. The window shares nothing
//    with Canopy's: no preload, its own cookie jar, emptied before every look so no picture is of an old copy.
//  - Canopy's own windows: captured from their page, which needs no permission.
//  - other apps' windows: Electron's desktopCapturer, which needs macOS Screen Recording permission. It names a
//    window by its title only and takes seconds (it captures every window to give one), so the windows are found
//    in the Mac's own window list, which also says whose each is, and captured only once one is chosen.
// Electron comes in through createLookCapture, so the rest loads (and is tested) in plain Node.
import { execFile } from 'node:child_process';

const PARTITION = 'look'; // in memory only: nothing a page stores outlives Canopy
const LOAD_MS = 15_000;   // how long a page may take to load
const SETTLE_MS = 300;    // after it has loaded: late layout, fonts, a first effect
const TOTAL_MS = 40_000;  // one look, start to finish, whatever the page does
const SHOT_TRIES = 6;
const THUMB = 1600;       // the longest side of another app's window, as captured (look.mjs sends no more)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coded = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
// "window:1234:0" -> 1234, the number the Mac's window list knows the window by.
const windowNumber = (sourceId) => { const m = /^window:(\d+)/.exec(String(sourceId ?? '')); return m ? Number(m[1]) : null; };

// Runs in the page: wait for its fonts (a moment at most), then a beat for layout to settle.
const SETTLE = `Promise.race([document.fonts ? document.fonts.ready : 0, new Promise((r) => setTimeout(r, 2000))]).then(() => new Promise((r) => setTimeout(r, ${SETTLE_MS})))`;
const MEASURE = '({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, y: Math.round(window.scrollY) })';

/**
 * Runs in the page (handed over as source, so it uses nothing from here): what is where in the picture, for a
 * widget that pins notes on it. Up to `max` visible elements a person would name (headings, buttons, links, fields,
 * images, labels, list items, paragraphs, anything with a role or an aria-label), each as
 * { x, y, w, h, tag, role, text, selector } in CSS px of the picture: the area `top` px down the document, `width`
 * by `height`. A wrapper that is only there to hold others, or anything not drawn, is left out.
 */
export function collectElements({ top = 0, width, height, max = 400 }) {
  const MEANT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'a', 'input', 'select', 'textarea', 'img', 'svg', 'video', 'canvas', 'label', 'li', 'p', 'figcaption', 'blockquote', 'td', 'th', 'summary', 'legend', 'dt', 'dd', 'pre', 'code']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'br', 'option']);
  const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`));
  const simpleClass = (c) => /^[A-Za-z_-][A-Za-z0-9_-]{0,40}$/.test(c);
  function step(el) {
    const tag = el.tagName.toLowerCase();
    const cls = [...el.classList].filter(simpleClass).slice(0, 2).map((c) => `.${c}`).join('');
    const parent = el.parentElement;
    if (!parent) return tag + cls;
    const same = [...parent.children].filter((c) => c.tagName === el.tagName);
    return same.length > 1 ? `${tag}${cls}:nth-of-type(${same.indexOf(el) + 1})` : tag + cls;
  }
  function selectorOf(el) {
    if (el.id && /^[A-Za-z][\w-]{0,60}$/.test(el.id) && document.querySelectorAll(`#${esc(el.id)}`).length === 1) return `#${el.id}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n !== el && n.id && /^[A-Za-z][\w-]{0,60}$/.test(n.id)) { parts.unshift(`#${n.id}`); break; }
      parts.unshift(step(n));
      if (n.tagName === 'BODY') break;
    }
    let sel = parts.join(' > ');
    while (sel.length > 120 && parts.length > 1) { parts.shift(); sel = parts.join(' > '); }
    return sel.length > 120 ? sel.slice(0, 120) : sel;
  }
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
  function textOf(el, tag) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (tag === 'img') return el.getAttribute('alt') || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password') return el.getAttribute('placeholder') || '';
      return el.getAttribute('placeholder') || (['submit', 'button', 'reset'].includes(type) ? el.value : '') || el.getAttribute('name') || '';
    }
    return el.innerText || el.textContent || el.getAttribute('title') || '';
  }
  function meant(el, tag) {
    if (MEANT.has(tag)) return true;
    if (el.getAttribute('role') || el.getAttribute('aria-label')) return true;
    // A leaf that carries words of its own (a span or a div with text and nothing else) is something you would name.
    return el.children.length === 0 ? !!ownText(el) : !!ownText(el) && ownText(el).length > 2;
  }
  const out = [];
  const docTop = window.scrollY;
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  for (let i = 0; i < all.length && out.length < max; i++) {
    const el = all[i];
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || (el.closest && el.closest('svg') && el.closest('svg') !== el)) continue;
    if (!meant(el, tag)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const x = r.left, y = r.top + docTop - top;
    if (x + r.width <= 0 || y + r.height <= 0 || x >= width || y >= height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
    out.push({ x, y, w: r.width, h: r.height, tag, role: el.getAttribute('role') || null, text: clip(textOf(el, tag), 80) || null, selector: selectorOf(el) });
  }
  return out;
}
const elementsScript = (opts) => `(${collectElements.toString()})(${JSON.stringify(opts)})`;

// Every window on screen with the app it belongs to, front to back, as JSON. JavaScript for Automation, which is
// part of macOS; it reads the window list and sends no Apple events, so it asks the user for nothing.
const WINDOW_LIST = `ObjC.import('CoreGraphics');
function run() {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || [];
  const real = (w) => w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 50 && w.kCGWindowBounds.Height > 50;
  return JSON.stringify(list.filter(real).map((w) => ({ id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '' })));
}`;

/** The window list's answer as rows, or [] for anything else. */
export function parseWindowList(stdout) {
  try {
    const rows = JSON.parse(String(stdout ?? '').trim());
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'number').map((r) => ({ id: r.id, app: String(r.app ?? ''), title: String(r.title ?? '') })) : [];
  } catch { return []; }
}

/**
 * What desktopCapturer saw, joined with the window list: other apps' windows, front to back, each with its app and
 * its picture. `sources` are DesktopCapturerSources, `rows` parseWindowList's, `ownIds` the window numbers of this
 * app's own. A window the list does not know keeps its title and goes last.
 */
export function joinWindows(sources, rows, ownIds = new Set()) {
  const order = new Map(rows.map((r, i) => [r.id, { ...r, at: i }]));
  return sources
    .map((s) => ({ s, id: windowNumber(s.id) }))
    .filter(({ id }) => !ownIds.has(id))
    .map(({ s, id }) => { const row = order.get(id); return { app: row?.app ?? '', title: s.name || row?.title || '', image: s.thumbnail, at: row?.at ?? Infinity }; })
    .sort((a, b) => a.at - b.at)
    .map(({ app, title, image }) => ({ app, title, image }));
}

/**
 * The capture backend for look.mjs. `electron` is { BrowserWindow, desktopCapturer, systemPreferences, nativeImage };
 * `appName` is what the app is called in System Settings.
 */
export function createLookCapture({ electron, appName = 'Canopy', platform = process.platform, exec = execFile, log = () => {} } = {}) {
  const { BrowserWindow, desktopCapturer, systemPreferences, nativeImage } = electron;
  const hidden = new Set();      // the windows pages are rendered in: never listed as Canopy's own
  let queue = Promise.resolve(); // one page at a time: they share a cookie jar, which is emptied between them
  let prepared = false;
  let downloads = 0;             // how many times a page turned out to be a download

  const alive = (w) => !w.isDestroyed();
  const ownWindows = () => BrowserWindow.getAllWindows().filter((w) => alive(w) && !hidden.has(w));

  // The hidden window's session: asks for nothing, saves nothing.
  function prepare(session) {
    if (prepared) return;
    prepared = true;
    session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    session.setPermissionCheckHandler(() => false);
    session.on('will-download', (e) => { downloads++; e.preventDefault(); });
  }

  // The picture of what a window shows now. Right after a load, or in a window that is not on screen, there may be
  // no frame to copy yet, so it is asked for a few times. `stayHidden` is for the window that is never shown.
  async function shot(wc, stayHidden = false) {
    let last = null;
    for (let i = 0; i < SHOT_TRIES; i++) {
      try {
        const image = await wc.capturePage(undefined, { stayHidden });
        if (!image.isEmpty()) return image;
      } catch (err) { last = err; }
      await sleep(120);
    }
    throw last ?? new Error('the page drew nothing');
  }

  // The page from its top down to `height`, beyond what the window shows, without resizing the window: resizing
  // would change the layout of anything sized by the viewport (a 100vh hero), and the picture would be of a page
  // nobody sees.
  async function fullShot(wc, width, height) {
    wc.debugger.attach('1.3');
    try {
      const r = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      return nativeImage.createFromBuffer(Buffer.from(r.data, 'base64'));
    } finally { try { wc.debugger.detach(); } catch { /* the window is gone */ } }
  }

  async function render({ url, width, height, fullPage, fullHeight = 4000, scrollY = 0, signal }) {
    if (signal?.aborted) throw coded('aborted', 'stopped');
    const win = new BrowserWindow({
      show: false, width, height, useContentSize: true, frame: false, focusable: false, skipTaskbar: true,
      // Offscreen: the page is drawn at 1x whatever the display, with no window on screen. disableDialogs: an alert()
      // must not put a dialog in front of the user.
      webPreferences: { offscreen: true, partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, backgroundThrottling: false },
    });
    hidden.add(win);
    const wc = win.webContents;
    let onAbort = null;
    let timer = null;
    let loadTimer = null;
    try {
      // Whatever the page does (a script that never ends), the look ends: the window goes, and what waits on it fails.
      const gone = new Promise((_, reject) => {
        onAbort = () => reject(coded('aborted', 'stopped'));
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => reject(coded('timeout', 'took too long')), TOTAL_MS);
      });
      gone.catch(() => {});
      const within = (p) => Promise.race([p, gone]);

      prepare(wc.session);
      wc.setAudioMuted(true);
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      // Each look starts from an empty browser: an old copy from the cache or a service worker would be a picture
      // of something that is no longer there.
      await within(Promise.all([wc.session.clearCache(), wc.session.clearStorageData()]).catch(() => {}));

      const errors = [];
      let status = null;
      let ready = false;
      const downloadsBefore = downloads;
      wc.on('console-message', (e) => { if (e?.level === 'error' && errors.length < 50) errors.push(String(e.message ?? '')); });
      wc.on('did-navigate', (_e, _url, code) => { status = typeof code === 'number' ? code : null; });
      wc.on('dom-ready', () => { ready = true; });

      let slow = false;
      const loading = wc.loadURL(url).then(() => null, (err) => err);
      const failed = await within(Promise.race([loading, new Promise((r) => { loadTimer = setTimeout(() => r('slow'), LOAD_MS); })]));
      if (failed === 'slow') {
        // Still loading (a stream that never closes, an image that never arrives). If there is a page, look at it.
        if (!ready) throw coded('timeout', 'did not load');
        slow = true;
        wc.stop();
      } else if (failed) {
        // A download fails the load a moment before the session hears of the download.
        if (!ready) await within(sleep(100));
        if (downloads > downloadsBefore) throw coded('download', 'a download');
        // -3 is "aborted": the page went somewhere else while loading. What it reached is what is looked at.
        if (!(failed.errno === -3 && ready)) throw coded('load', String(failed.message ?? failed), { reason: failed.code ?? 'ERR_FAILED' });
      }

      await within(wc.executeJavaScript(SETTLE));
      if (scrollY > 0 && !fullPage) {
        await within(wc.executeJavaScript(`window.scrollTo(0, ${Number(scrollY)})`));
        await within(sleep(150));
      }
      const size = await within(wc.executeJavaScript(MEASURE));
      const tall = Math.max(1, Math.min(size.height, fullHeight));
      const image = await within(fullPage ? fullShot(wc, width, tall) : shot(wc, true));
      const captured = { width, height: fullPage ? tall : height };
      // What is where in the picture, read once it is taken. A page that will not say gives a picture without a map.
      const elements = await within(wc.executeJavaScript(elementsScript({ top: fullPage ? 0 : size.y, ...captured, max: 400 })))
        .catch((err) => { if (err?.code) throw err; log(`look: element map failed: ${err?.message ?? err}`); return null; });
      return {
        image, captured, page: { width: size.width, height: size.height },
        scrollY: fullPage ? 0 : size.y, url: wc.getURL(), status, errors, slow, elements: Array.isArray(elements) ? elements : null,
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(loadTimer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      hidden.delete(win);
      if (alive(win)) win.destroy();
    }
  }

  // The app each window on screen belongs to. Without it windows are still found by their titles.
  function windowRows() {
    if (platform !== 'darwin') return Promise.resolve([]);
    return new Promise((resolve) => {
      exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WINDOW_LIST], { timeout: 5000 }, (err, stdout) => {
        if (err) log(`look: window list failed: ${err?.message ?? err}`);
        resolve(err ? [] : parseWindowList(stdout));
      });
    });
  }

  /** macOS Screen Recording permission for this app. Other systems have none to give. */
  function screenAccess() {
    if (platform !== 'darwin') return 'granted';
    try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
  }

  // Every window desktopCapturer can see, each with its picture.
  const sources = () => desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: THUMB, height: THUMB }, fetchWindowIcons: false })
    .catch((err) => { log(`look: window capture failed: ${err?.message ?? err}`); return []; });

  return {
    appName,
    /** Render a page and capture it. One at a time; a second call waits for the first. */
    page(opts) {
      const run = queue.then(() => render(opts));
      queue = run.catch(() => {});
      return run;
    },
    ownWindows() {
      return ownWindows().map((w) => ({
        app: appName, title: w.getTitle() || appName, own: true,
        // A minimized window may never draw: give up rather than wait for it.
        capture: () => Promise.race([shot(w.webContents), sleep(5000).then(() => { throw new Error('the window did not draw'); })]),
      }));
    },
    /** Other apps' windows, front to back. Listing them is quick; `capture()` is what takes the picture. */
    async otherWindows() {
      const ownIds = new Set(ownWindows().map((w) => windowNumber(w.getMediaSourceId())));
      const rows = screenAccess() === 'granted' ? await windowRows() : [];
      if (rows.length) {
        return rows.filter((r) => !ownIds.has(r.id)).map((r) => ({
          app: r.app, title: r.title,
          capture: async () => (await sources()).find((s) => windowNumber(s.id) === r.id)?.thumbnail ?? null,
        }));
      }
      // No list to go by (the permission is missing, or this is not a Mac): the capturer's own. On a Mac without
      // the permission, this first try to capture is also what makes macOS ask the user for it.
      const [seen, names] = await Promise.all([sources(), windowRows()]);
      return joinWindows(seen, names, ownIds).map(({ image, ...w }) => ({ ...w, capture: async () => image }));
    },
    screenAccess,
  };
}

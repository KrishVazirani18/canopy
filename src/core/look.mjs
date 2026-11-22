// Look: Claude sees what a web page or a Mac app window looks like right now, as a screenshot. It is how a visual
// change gets checked before Claude says it is fixed. Measured Nov 16 2026 on Opus 5.5, on six small web-page bugs:
// no render call failed, and runs were 22 to 32% faster and 7 to 10% cheaper than checking with whatever else was on
// the machine.
//
//  - LOOK                the tool, defined once for every engine (tool-registry.mjs). It changes nothing:
//                          look { url | window, width, height, fullPage, scrollY }  one picture and a one-line caption
//  - createLookServer()  the in-process MCP server that carries it in a Claude chat. A Codex chat gets the same
//                        tool through the relay (tool-relay.mjs)
//  - look()              the tool itself: reads the input, asks the backend for the picture, sizes it, captions it
//  - localLook()         which looks never need asking about: a page on this Mac, and the host's own window
//  - lookScope()         what a "yes, for this chat" to one look covers
//  - readInput() / pickWindow() / fitSize() / encode()  its parts, each a plain function
//
// The pixels come from a backend the host gives (Canopy's main process: src/look-capture.mjs, which renders with
// Electron's own Chromium so nothing has to be installed). Nothing in this file needs Electron: plain Node has no
// backend, and the tool says so. What a backend is:
//
//   page({ url, width, height, fullPage, fullHeight, scrollY, signal })
//       -> { image, captured: { width, height }, page: { width, height }, scrollY, url, status, errors, slow, elements }
//          `captured` is the part of the page in the picture and `page` the whole document, both in CSS px;
//          `errors` are the page's console errors; `slow` means it was still loading when the picture was taken;
//          `elements` the page's element map (what is where in the picture, shots.mjs cleanElements), if it made one.
//          A page that cannot be shown throws an Error with `code`: 'load' (with `reason`, Chromium's own name for
//          what went wrong), 'timeout', 'download' or 'aborted'.
//   ownWindows()    -> [{ app, title, own: true, capture() -> image }]   the host's own windows: no permission needed
//   otherWindows()  -> [{ app, title, capture() -> image | null }]       other apps' windows, front to back
//   screenAccess()  -> 'granted' | 'denied' | 'not-determined' | …       macOS Screen Recording permission
//   appName                                                            what the host is called in System Settings
//
// An image is Electron's NativeImage, or anything with its getSize(), isEmpty(), resize(), toPNG() and toJPEG().
//
// Every picture is also kept for the chat (ctx.shots: shots.mjs forChat), so a widget can show it again by its ref;
// the result then ends with savedLine(ref). A host that keeps none gets the result without that line.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineTool, sdkTool } from './tool-registry.mjs';

const soft = async (f) => { try { return await import(f); } catch (err) { return { __missing: String(err?.message ?? err) }; } };
const [sdk, zod] = await Promise.all([soft('@anthropic-ai/claude-agent-sdk'), soft('zod')]);

/** What this build lacks to offer the tool, or null. */
export const LOOK_MISSING = !sdk.createSdkMcpServer || !sdk.tool ? 'sdk' : !zod.z ? 'zod' : null;
export const LOOK_SERVER = 'canopy_look';
export const LOOK_TOOL = `mcp__${LOOK_SERVER}__look`;

// The wording that was benchmarked. Change it only with a new measurement.
export const LOOK_DESCRIPTION = `See what a web page or a Mac app window looks like right now, as a screenshot.
Use it after you change anything visual (CSS, layout, a component, an app's UI), before you tell the user it is fixed, and to see a visual bug the user describes. Check the size the user mentioned (width 390 for a phone).
Pass url for a page (localhost works) or window for an app window (app name or window title). Not for reading text, data or APIs: use files, curl or tests for those.`;

/** The longest side of a picture, in px. The model is shown nothing finer, so more would only cost more. */
export const MAX_SIDE = 1600;
/** The most a picture may weigh. Under it a PNG is sent as it is; over it, a JPEG. */
export const MAX_BYTES = 900_000;
/** How much of a scrolling page a full-page picture takes, in CSS px. */
export const FULL_HEIGHT = 4000;
const VIEW = { width: 1280, height: 800 };
const WIDTHS = [240, 1600];
const HEIGHTS = [200, 2400];
const SHOWN_WINDOWS = 12;

/** A failure the model can act on: the message says what went wrong and what to do next. */
export class LookError extends Error {}
const fail = (message) => { throw new LookError(message); };
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
const clamp = (n, [lo, hi]) => Math.min(Math.max(Math.round(n), lo), hi);
const fold = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// ---- the input ----

// "localhost:3000" and "/Users/me/site/index.html" are what people type; both are made into a URL. Only pages are
// looked at: http, https and files.
function readUrl(raw) {
  let s = raw.trim();
  if (s.startsWith('/')) s = pathToFileURL(s).href;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u = null;
  try { u = new URL(s); } catch { /* said below */ }
  if (!u || !['http:', 'https:', 'file:'].includes(u.protocol) || (u.protocol !== 'file:' && !u.hostname)) {
    fail(`"${raw.trim().slice(0, 200)}" is not a page look can open. Pass a full http or https URL, for example http://localhost:3000/.`);
  }
  return u.href;
}

/**
 * What a call asks for, checked: { url, width, height, fullPage, scrollY } or { window }. Throws a LookError.
 * A size outside what a screen can be is brought inside it rather than refused; the caption says the size used.
 */
export function readInput(args) {
  const a = args !== null && typeof args === 'object' ? args : {};
  const url = typeof a.url === 'string' && a.url.trim() ? a.url : null;
  const win = typeof a.window === 'string' && a.window.trim() ? a.window.trim() : null;
  if (!url === !win) fail('Pass exactly one of url or window: url for a web page (http://localhost:3000/), window for an app window (an app name or a window title).');
  if (win) return { window: win.slice(0, 200) };
  const size = (v, range, def) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, range) : def);
  return {
    url: readUrl(url),
    width: size(a.width, WIDTHS, VIEW.width),
    height: size(a.height, HEIGHTS, VIEW.height),
    fullPage: a.fullPage === true,
    scrollY: typeof a.scrollY === 'number' && a.scrollY > 0 ? Math.round(a.scrollY) : 0,
  };
}

const LOOPBACK = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i;

/**
 * True for a call that never needs asking about: a page on this Mac (localhost), or one of the host's own windows
 * (`own`: backend.ownWindows()), named outright. Everything else is asked about the way Claude Code asks before it
 * fetches a page or reads outside the project: a page anywhere else is a request sent out to the web with whatever
 * is in its address, a file is read from the disk, and another app's window can be showing anything (a password
 * manager, the user's mail).
 * Only the address of the page is checked. What a localhost page loads from other hosts (fonts, scripts, its API)
 * is fetched, as it is in the user's own browser: without it the picture would not be of the page they see.
 */
export function localLook(args, { own = [] } = {}) {
  let input = null;
  try { input = readInput(args); } catch { return true; } // nothing is captured: the tool only answers with what was wrong
  if (input.window) return ownWindowNamed(input.window, own);
  const u = new URL(input.url);
  return u.protocol !== 'file:' && LOOPBACK.test(u.hostname);
}

/**
 * What the user's "yes, for this chat" to one look covers, for an engine where Canopy keeps that answer itself (a
 * Codex chat: codex-session.mjs). No wider than what they were shown: the site a page is on, the one file, or the
 * window as it was named. Another site, file or app is asked about again.
 */
export function lookScope(args) {
  let input = null;
  try { input = readInput(args); } catch { return 'look'; } // nothing is captured, so nothing is asked about
  if (input.window) return `window:${fold(input.window)}`;
  const u = new URL(input.url);
  return u.protocol === 'file:' ? `file:${fileURLToPath(u)}` : `web:${u.origin}`;
}

// ---- the picture ----

/** The size a width × height picture is sent at: no side over `max`, the shape kept, never made larger. */
export function fitSize(width, height, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * An image as the bytes to send: no side over `maxSide` (nor over `within`, the CSS size of what it shows, so a
 * Retina capture goes out at 1x), a PNG when that is under `maxBytes`, otherwise a JPEG, made smaller until it is.
 * @returns {{ data: Buffer, mimeType: string, width: number, height: number, from: { width: number, height: number } }}
 */
export function encode(image, { maxSide = MAX_SIDE, maxBytes = MAX_BYTES, within = null } = {}) {
  const from = image.getSize();
  if (image.isEmpty?.() || !(from.width > 0) || !(from.height > 0)) fail('The screenshot came back empty.');
  const cap = within ? Math.min(maxSide, Math.max(within.width, within.height)) : maxSide;
  let size = fitSize(from.width, from.height, cap);
  const sized = (s) => (s.width === from.width && s.height === from.height ? image : image.resize({ width: s.width, height: s.height, quality: 'best' }));
  let img = sized(size);
  const out = (data, mimeType) => ({ data, mimeType, width: size.width, height: size.height, from });
  const png = img.toPNG();
  if (png.length <= maxBytes) return out(png, 'image/png');
  let jpeg = img.toJPEG(80);
  if (jpeg.length > maxBytes) jpeg = img.toJPEG(60);
  // A picture this heavy at this size is rare (a photo wall); a smaller one is still a look.
  for (let i = 0; i < 4 && jpeg.length > maxBytes; i++) {
    size = fitSize(size.width, size.height, Math.round(Math.max(size.width, size.height) * 0.75));
    img = sized(size);
    jpeg = img.toJPEG(60);
  }
  return out(jpeg, 'image/jpeg');
}

// ---- a page ----

const LOAD_REASONS = {
  ERR_CONNECTION_REFUSED: 'nothing is listening at that address. Start the dev server (or check the port), then look again.',
  ERR_UNSAFE_PORT: 'the browser refuses to open that port. Serve the page on another port, then look again.',
  ERR_NAME_NOT_RESOLVED: 'that host name does not exist. Check the address, then look again.',
  ERR_INTERNET_DISCONNECTED: 'this Mac is offline. A page on localhost still works.',
  ERR_FILE_NOT_FOUND: 'there is no file at that path. Check the path, then look again.',
  ERR_CERT_AUTHORITY_INVALID: 'its certificate is not trusted. Use the http address of the dev server, then look again.',
};

function pageError(err, url) {
  if (err instanceof LookError) return err;
  const code = err?.code;
  if (code === 'aborted') return new LookError('The look was stopped before the page was captured.');
  if (code === 'timeout') return new LookError(`${url} did not load in time, so there is no screenshot. Check that the server answers (curl -I ${url}), then look again.`);
  if (code === 'download') return new LookError(`${url} is a download, not a page look can show. Pass the address of a page.`);
  if (code === 'load') {
    const reason = String(err.reason ?? 'ERR_FAILED');
    return new LookError(`Could not open ${url}: ${LOAD_REASONS[reason] ?? `the browser said ${reason}. Check the address and that the server is running, then look again.`}`);
  }
  return new LookError(`Could not take a screenshot of ${url}: ${String(err?.message ?? err).slice(0, 300)}. Try once more; if it fails again, check the page another way and tell the user you could not see it.`);
}

/** The line a result ends with once its picture is kept as a shot. */
export const savedLine = (ref) => `Saved as shot "${ref}": show it in a widget with <canopy-shot ref="${ref}"> or <canopy-review ref="${ref}">.`;

/** The longest side a kept shot may have: a full-page look is FULL_HEIGHT tall at most. */
const SHOT_SIDE = FULL_HEIGHT;

// A picture as a shot is kept: a JPEG (quality 80) at `size`, the CSS size of what it shows, so its element map
// lines up with it pixel for pixel. Never larger than the image itself.
function shotOf(image, size) {
  const from = image.getSize();
  const fit = fitSize(Math.min(size.width, from.width), Math.min(size.height, from.height), SHOT_SIDE);
  const img = fit.width === from.width && fit.height === from.height ? image : image.resize({ width: fit.width, height: fit.height, quality: 'best' });
  return { jpeg: img.toJPEG(80), width: fit.width, height: fit.height, scale: fit.width / Math.max(1, size.width) };
}

// Keeps the picture for the chat; the ref it is kept under, or null. Never throws: a look that worked still works.
function keep(shots, image, size, { url = null, elements = null } = {}) {
  if (!shots || typeof shots.put !== 'function') return null;
  try {
    const s = shotOf(image, size);
    // An element map is in CSS px of what was captured; a shot made smaller has it scaled to match.
    const els = Array.isArray(elements) && s.scale !== 1
      ? elements.map((e) => (e && typeof e === 'object' ? { ...e, x: e.x * s.scale, y: e.y * s.scale, w: e.w * s.scale, h: e.h * s.scale } : e))
      : elements;
    const ref = shots.put({ jpeg: s.jpeg, width: s.width, height: s.height, url, elements: els, capturedAt: Date.now() });
    return typeof ref === 'string' && /^look-\d{1,6}$/.test(ref) ? ref : null;
  } catch { return null; }
}

async function lookPage(input, backend, signal) {
  const { url, width, height, fullPage, scrollY } = input;
  let r;
  try { r = await backend.page({ url, width, height, fullPage, fullHeight: FULL_HEIGHT, scrollY, signal }); }
  catch (err) { throw pageError(err, url); }
  const page = r.page ?? { width, height };
  const captured = r.captured ?? { width, height };
  const pic = encode(r.image, { within: captured });
  const at = r.scrollY > 0 ? ` scrolled to y=${r.scrollY}` : '';
  const what = !fullPage ? `the viewport${at}` : page.height > captured.height ? `the first ${captured.height}px of the full page` : 'the full page';
  const errors = Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === 'string' && e) : [];
  const parts = [
    `${url} at ${width}×${height}, showing ${what}.`,
    // Where a page that needs a login ends up. Nothing here can sign in (each look starts from an empty browser),
    // so say what does work rather than leave Claude to report on a login screen or try again.
    r.url && r.url !== url ? ` It went on to ${r.url}. If this is a sign-in page, look cannot sign in: ask the user to open the page in their browser, then look at that window instead (window: "Safari").` : '',
    ` Page size ${page.width}×${page.height}.`,
    page.width > width ? ` The page is ${page.width}px wide, wider than the ${width}px viewport (it scrolls sideways).` : '',
    typeof r.status === 'number' && r.status >= 400 ? ` HTTP ${r.status}.` : '',
    r.slow ? ' The page was still loading when this was taken.' : '',
    errors.length ? ` ${errors.length} console error${errors.length === 1 ? '' : 's'}, first: ${errors[0].replace(/\s+/g, ' ').trim().slice(0, 160).replace(/\.$/, '')}.` : ' No console errors.',
    // A tall capture is made smaller to fit, and small text in it may not be readable: say how to see it at full size.
    pic.width < captured.width ? ` The image is scaled down to ${pic.width}×${pic.height} to fit. ${fullPage ? 'Pass scrollY instead of fullPage to see one part' : `Use a height of ${MAX_SIDE} or less to see it`} at full size.` : '',
  ];
  return { pic, caption: parts.join(''), shot: { image: r.image, size: captured, url: r.url || url, elements: r.elements ?? null } };
}

// ---- a window ----

/** How a window is named in a list, and the name that picks exactly it: "Safari: Apple", "Canopy: Canopy (this app)". */
export const windowLabel = (w) => `${w.app ? `${w.app}: ` : ''}${w.title || '(untitled)'}${w.own ? ' (this app)' : ''}`;

// How closely a window fits a name (already folded): 0 its full label, 1 its whole app name or title, 2 part of
// either, 3 not at all.
function tier(q, w) {
  const app = fold(w.app), title = fold(w.title);
  if (fold(windowLabel(w)) === q) return 0;
  if (app === q || title === q || `${app}: ${title}` === q) return 1;
  if ((app && app.includes(q)) || (title && title.includes(q))) return 2;
  return 3;
}

/**
 * True when a name is one of the host's own windows outright: its app name, its title or its label, not a part of
 * one. That is the window look that is never asked about, and it only ever sees those windows (see lookWindow).
 * A part of a name could as well mean another app ("Code"), so it is asked about like any other window.
 */
export function ownWindowNamed(query, own) {
  const q = fold(query);
  return !!q && (Array.isArray(own) ? own : []).some((w) => tier(q, w) < 2);
}

/**
 * The window a name means, among `windows` (front to back). The closest kind of match wins: the full label, then
 * the whole app name or title, then part of either. Several windows of one app are one answer, the frontmost (with
 * the rest as `others`); windows of different apps are not, and come back as `ambiguous` for the model to choose.
 * @returns {{ hit: object, others: object[] } | { ambiguous: object[] } | { none: true }}
 */
export function pickWindow(query, windows) {
  const q = fold(query);
  const ranked = windows.map((w) => ({ w, t: tier(q, w) })).filter((x) => x.t < 3);
  if (!q || !ranked.length) return { none: true };
  const best = Math.min(...ranked.map((x) => x.t));
  const found = ranked.filter((x) => x.t === best).map((x) => x.w);
  const [first, ...rest] = found;
  const together = rest.every((w) => fold(w.app) === fold(first.app) && !!w.own === !!first.own);
  return together ? { hit: first, others: rest } : { ambiguous: found };
}

const listed = (windows) => {
  const names = [...new Set(windows.map(windowLabel))];
  return `${names.slice(0, SHOWN_WINDOWS).map((n) => `"${n}"`).join(', ')}${names.length > SHOWN_WINDOWS ? `, and ${names.length - SHOWN_WINDOWS} more` : ''}`;
};

// The row is named as System Settings names it today; older versions of macOS call it Screen Recording.
const ACCESS_PANE = 'System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on older macOS)';
const OPEN_PANE = 'open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"';
const needsAccess = (app, query) => `${app} cannot see the "${query}" window: macOS has not given it screen recording permission, which it needs for other apps' windows. `
  + `Ask the user to open ${ACCESS_PANE}, turn on ${app}, then quit and reopen ${app}. You can open that page of System Settings for them by running: ${OPEN_PANE}. `
  + `Until then look still works for web pages (url) and for ${app}'s own window.`;

// `unasked`: the call was let through without asking the user (see localLook), so it sees this app's own windows and
// no other: what is on screen in another app is never captured, or even listed, on a call nobody said yes to.
async function lookWindow({ window: query }, backend, { unasked = false } = {}) {
  const app = backend.appName || 'Canopy';
  const own = await backend.ownWindows();
  const granted = (await backend.screenAccess()) === 'granted';
  // Without the permission, asking for the other apps' windows makes macOS show its prompt, so they are only asked
  // for when the name is not one of this app's own windows.
  const ownOnly = unasked || (!granted && !pickWindow(query, own).none);
  const others = ownOnly ? [] : await backend.otherWindows();
  const windows = [...own, ...others];
  const picked = pickWindow(query, windows);
  if (picked.none) {
    if (!granted && !unasked) fail(needsAccess(app, query));
    fail(windows.length
      ? `No open window matches "${query}". The open windows are: ${listed(windows)}. Pass one of these as window, or open the app first (a minimized or hidden window cannot be seen).`
      : `No open window matches "${query}", and no windows could be seen at all. Open the app first; if it is open, ${app} may have lost its screen recording permission (${ACCESS_PANE}).`);
  }
  if (picked.ambiguous) fail(`"${query}" matches ${picked.ambiguous.length} windows: ${listed(picked.ambiguous)}. Pass one of these names, exactly as written, as window.`);
  const w = picked.hit;
  const name = windowLabel(w);
  let image = null;
  try { image = await w.capture(); }
  catch (err) { fail(`Could not capture "${name}": ${String(err?.message ?? err).slice(0, 200)}. Bring the window to the front, then look again.`); }
  if (!image || image.isEmpty?.() || !(image.getSize().width > 0)) {
    // Another app's window that is there but gives no picture is what a missing permission looks like.
    if (!w.own && !granted) fail(needsAccess(app, query));
    fail(`The capture of "${name}" came back empty. Bring the window to the front (not minimized, on this desktop), then look again.`);
  }
  const pic = encode(image);
  const more = picked.others.length ? ` It is the frontmost of ${picked.others.length + 1} matching windows; the others: ${listed(picked.others)}.` : '';
  return { pic, caption: `Window "${name}", ${pic.width}×${pic.height}.${more}`, shot: { image, size: { width: pic.width, height: pic.height }, url: null, elements: null } };
}

// ---- the tool ----

/**
 * One look call: an MCP result with the picture and a one-line caption, or an error that ends with what to do next.
 * `backend` is described at the top of this file; without one nothing can be captured, and the result says so.
 */
export async function look(args, backend, { signal, unasked = false, shots = null } = {}) {
  try {
    const input = readInput(args);
    if (!backend) fail('look cannot take screenshots here: it only works inside the Canopy app. Check the result another way (a headless browser, a test), and tell the user you could not see it.');
    const { pic, caption, shot } = input.window ? await lookWindow(input, backend, { unasked }) : await lookPage(input, backend, signal);
    const ref = keep(shots, shot.image, shot.size, shot);
    return { content: [{ type: 'image', data: pic.data.toString('base64'), mimeType: pic.mimeType }, { type: 'text', text: ref ? `${caption}\n${savedLine(ref)}` : caption }] };
  } catch (err) {
    if (err instanceof LookError) return toolError(err.message);
    return toolError(`Could not take the screenshot: ${String(err?.message ?? err).slice(0, 300)}. Try once more; if it fails again, check the result another way and tell the user you could not see it.`);
  }
}

/**
 * The tool as every engine gets it (tool-registry.mjs). Never marked read-only, though it changes nothing: Claude
 * Code runs a read-only tool in Plan mode without asking anyone, and a look can open any address on the web or any
 * file on the disk, which must be asked about (checked live, CLI 2.1.325: with the mark, Plan mode opened
 * https://example.com/ and /etc/hosts unasked). A page can be anywhere on the web, hence openWorldHint.
 */
export const LOOK = defineTool({
  name: 'look',
  home: LOOK_SERVER,
  description: LOOK_DESCRIPTION,
  params: {
    url: { type: 'string', description: 'Page to render, e.g. http://localhost:3000/settings' },
    window: { type: 'string', description: 'App name or window title, e.g. "Canopy" or "Simulator"' },
    width: { type: 'number', description: 'Viewport width in px for url (default 1280; 390 for a phone)' },
    height: { type: 'number', description: 'Viewport height in px for url (default 800)' },
    fullPage: { type: 'boolean', description: 'Capture the whole scrolling page instead of the viewport (url only)' },
    scrollY: { type: 'number', description: 'Scroll to this y before capturing (url only)' },
  },
  alwaysLoad: true,
  annotations: { title: 'Look', destructiveHint: false, openWorldHint: true },
  // Only a host with a screen can take the picture.
  available: (ctx) => !!ctx?.look,
  // The rule every engine asks by (see localLook). A host whose windows cannot be listed has none to look at unasked.
  asks: async (args, ctx) => {
    let own = [];
    try { own = await ctx.look.ownWindows(); } catch { /* none, so a window is asked about */ }
    return !localLook(args, { own });
  },
  scope: lookScope,
  run: (args, ctx) => look(args, ctx?.look ?? null, { signal: ctx?.signal, unasked: ctx?.unasked === true, shots: ctx?.shots ?? null }),
});

/**
 * The in-process MCP server that carries the tool in a Claude chat. One per Claude Code process. `backend` is the
 * capture backend, or a function that returns it (read at each call, so a host that is still starting can give it
 * later). `unasked(toolUseId)` says whether the host let that call through without asking the user (see localLook);
 * such a call sees the host's own windows only. `shots` is where the chat's pictures are kept (shots.mjs forChat), or null.
 */
export function createLookServer({ backend = null, unasked = () => false, shots = null } = {}) {
  const get = typeof backend === 'function' ? backend : () => backend;
  const tool = sdkTool(LOOK, sdk, zod.z, (args, extra) => LOOK.run(args, { look: get(), shots, signal: extra?.signal, unasked: unasked(extra?._meta?.['claudecode/toolUseId']) === true }));
  return sdk.createSdkMcpServer({ name: LOOK_SERVER, version: '1.0.0', tools: [tool] });
}

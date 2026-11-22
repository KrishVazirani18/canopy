// The widget frame's own page: what runs inside the sandboxed iframe when Claude shows a widget.
// To the host it is an MCP App like any other (SEP-1865). Its tool input is { title, widget_code }, which it draws:
// as it arrives while Claude is still writing, then whole, and only then does it run the widget's scripts.
// It carries Canopy's look (base.css), the components (./components), and the small `canopy` object scripts use.
// The frame has no network and no origin; everything that leaves goes through ./rpc to the host, which decides.
import base from './base.css?inline';
import blocks from './blocks.css?inline';
import { notify, on, request } from './rpc';
import { rt } from './runtime';
import { morph, safePrefix } from './stream';
import './components/table';
import './components/chart';
import './components/choices';
import './components/diff';
import './components/stat';
import './components/tabs';
import './components/scale';
import './components/pick';
import './components/compare';
import './components/tune';
import './components/shot';
import './components/markup';
import './components/rank';

type Json = Record<string, unknown>;
const doc = document.documentElement;
const root = document.getElementById('root') as HTMLElement;

const sheet = new CSSStyleSheet();
sheet.replaceSync(base);
// The building blocks' default look for what is in the widget's own DOM (options, a preview's stack). Weightless.
const blockSheet = new CSSStyleSheet();
blockSheet.replaceSync(blocks);
document.adoptedStyleSheets = [sheet, blockSheet];

// ---- the host's look ----

function applyContext(ctx: Json | undefined) {
  if (!ctx) return;
  const theme = ctx.theme === 'dark' || ctx.theme === 'light' ? ctx.theme : null;
  if (theme) { doc.dataset.theme = theme; doc.style.colorScheme = theme; }
  const vars = (ctx.styles as { variables?: Record<string, string | undefined> } | undefined)?.variables;
  if (vars) for (const [k, v] of Object.entries(vars)) if (k.startsWith('--') && typeof v === 'string') doc.style.setProperty(k, v);
  if (theme || vars) window.dispatchEvent(new Event('canopy:theme'));
}

// ---- size: the frame is as tall as its content ----

let sized = 0;
let measuring = 0;
function measure() {
  if (measuring) return;
  measuring = requestAnimationFrame(() => {
    measuring = 0;
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height === sized) return;
    sized = height;
    notify('ui/notifications/size-changed', { width: Math.ceil(doc.clientWidth), height });
  });
}
new ResizeObserver(measure).observe(document.body);

// ---- drawing ----

let ran = false;      // the widget's scripts run once
let revealed = false;

// A new piece of a widget that is being written eases in, so it reads as growing, not popping.
const ease = (el: Element) => { el.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }); };

// HTML arrives in order, so what is still being written is the newest element and everything around it: the deepest
// last element and its ancestors. They get data-writing, so a slide, an option or a preview that is half there can
// show a shimmer in its place instead of half a design (blocks.css, scale.ts). Cleared once the widget is whole.
let writing: Element[] = [];
function markWriting(whole: boolean) {
  const next: Element[] = [];
  if (!whole) for (let el = root.lastElementChild; el; el = el.lastElementChild) next.push(el);
  for (const el of writing) if (!next.includes(el)) el.removeAttribute('data-writing');
  for (const el of next) if (!el.hasAttribute('data-writing')) el.setAttribute('data-writing', '');
  writing = next;
}

function draw(code: unknown, whole: boolean) {
  const html = typeof code === 'string' ? code : '';
  rt.streaming = !whole;
  doc.toggleAttribute('data-streaming', !whole);
  morph(root, whole ? html : safePrefix(html), !whole && !rt.restored ? ease : undefined);
  markWriting(whole);
  if (whole && !ran) {
    ran = true;
    const restored = restoreControls();
    runScripts();
    replay(restored);
    // A moment for anything the scripts started to fail, then say how it went. The host passes a failure on to
    // Claude, who can then fix the widget in the same turn.
    setTimeout(() => notify('canopy/drawn', { errors: [...failures] }), 60);
  }
  rt.changed();
  reveal();
  measure();
}

// Held invisible until there is something to see in the right font, then shown at once: no flash of fallback type.
function reveal() {
  if (revealed) return;
  revealed = true;
  const show = () => { document.body.dataset.ready = ''; measure(); };
  Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 400))]).then(show, show);
}

// Scripts written into the page as text never run on their own. Each is replaced by a fresh copy, in order, which does.
function runScripts() {
  for (const old of Array.from(root.querySelectorAll('script'))) {
    const type = (old.getAttribute('type') ?? '').trim().toLowerCase();
    if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) continue; // data, not code
    if (old.hasAttribute('src')) { report(`A script from ${old.getAttribute('src')} was not loaded: the frame has no network.`, 'warning'); continue; }
    const s = document.createElement('script');
    for (const a of Array.from(old.attributes)) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
}

// ---- what the widget remembers ----

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const controls = () => Array.from(root.querySelectorAll<Control>('input, select, textarea')).filter((c) => !['file', 'password', 'hidden', 'button', 'submit'].includes(c.type));
const controlKey = (c: Control, i: number) => (c.id ? `#${c.id}` : c.getAttribute('name') ? `${c.getAttribute('name')}${c.type === 'radio' ? `=${c.value}` : ''}` : `${c.localName}:${i}`);
const ticks = (c: Control): c is HTMLInputElement => c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio');

/** Put the controls back the way the user left them. Returns the ones that changed. */
function restoreControls(): Control[] {
  const saved = rt.saved.f;
  if (!saved) return [];
  const changed: Control[] = [];
  controls().forEach((c, i) => {
    const v = saved[controlKey(c, i)];
    if (v === undefined) return;
    if (ticks(c)) { if (typeof v === 'boolean' && c.checked !== v) { c.checked = v; changed.push(c); } }
    else if (typeof v === 'string' && c.value !== v) { c.value = v; changed.push(c); }
  });
  return changed;
}
// The widget's script has now attached its listeners: tell it about the restored values the way a user's change would.
function replay(changed: Control[]) {
  for (const c of changed) { c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); }
}
function rememberControl(e: Event) {
  const c = e.target;
  if (!(c instanceof HTMLInputElement || c instanceof HTMLSelectElement || c instanceof HTMLTextAreaElement) || !root.contains(c)) return;
  const all = controls();
  const i = all.indexOf(c);
  if (i < 0) return;
  const f = (rt.saved.f ??= {});
  // Picking one radio button unpicks the others of its name.
  if (c instanceof HTMLInputElement && c.type === 'radio') all.forEach((o, j) => { if (o instanceof HTMLInputElement && o.type === 'radio' && o.name === c.name) f[controlKey(o, j)] = o.checked; });
  else f[controlKey(c, i)] = ticks(c) ? c.checked : c.value;
  rt.save();
}
document.addEventListener('input', rememberControl, true);
document.addEventListener('change', rememberControl, true);

// ---- what scripts get ----

const api = {
  /** Send `text` to Claude as the user's next message. Only works from a click or a key press. */
  send: (text: string) => rt.send(text),
  /** What this widget saved with setState, or {}. */
  get state(): Json { return { ...(rt.saved.u ?? {}) }; },
  /** Remember these values with the chat. */
  setState(patch: Json) { if (patch && typeof patch === 'object') { rt.saved.u = { ...(rt.saved.u ?? {}), ...patch }; rt.save(); } },
  get theme() { return doc.dataset.theme ?? 'light'; },
};
Object.defineProperty(window, 'canopy', { value: Object.freeze(api) });
// The name claude.ai gives the same thing, so a widget written from that habit still answers back.
Object.defineProperty(window, 'sendPrompt', { value: (text: string) => rt.send(text) });

// ---- links, errors ----

// A link never navigates the frame: web links are handed to the host, which asks before opening the browser.
document.addEventListener('click', (e) => {
  const a = e.composedPath().find((n): n is HTMLAnchorElement | SVGAElement => n instanceof HTMLAnchorElement || n instanceof SVGAElement);
  if (!a) return;
  const href = a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '';
  e.preventDefault();
  if (href.startsWith('#')) { document.getElementById(href.slice(1))?.scrollIntoView({ block: 'nearest' }); return; }
  if (/^(https?:|mailto:)/i.test(href)) request('ui/open-link', { url: href }).catch(() => {});
}, true);

const reported = new Set<string>();
const failures: string[] = []; // what the widget's own scripts threw
function report(message: string, level: 'error' | 'warning' = 'error') {
  const text = message.slice(0, 300);
  if (reported.has(text) || reported.size >= 8) return;
  reported.add(text);
  if (level === 'error') failures.push(text);
  notify('notifications/message', { level, logger: 'widget', data: text });
}
window.addEventListener('error', (e) => {
  if (/ResizeObserver loop/i.test(e.message)) return;
  report(`${e.message}${e.lineno ? ` (line ${e.lineno})` : ''}`);
});
window.addEventListener('unhandledrejection', (e) => report(String((e.reason as Error | undefined)?.message ?? e.reason)));
document.addEventListener('securitypolicyviolation', (e) => {
  const what = e.blockedURI && !['inline', 'eval', 'data', 'blob'].includes(e.blockedURI) ? e.blockedURI : e.violatedDirective;
  report(`Blocked: ${what}. The frame has no network.`, 'warning');
});

// ---- start ----

const title = (p: Json) => { const t = (p.arguments as Json | undefined)?.title; if (typeof t === 'string') rt.title = t.trim().slice(0, 200); };
on('ui/notifications/tool-input-partial', (p) => { title(p); if (!ran) draw((p.arguments as Json | undefined)?.widget_code, false); });
on('ui/notifications/tool-input', (p) => { title(p); draw((p.arguments as Json | undefined)?.widget_code, true); });
// Claude was stopped mid-widget: what arrived stays as it is, and its scripts, which never finished arriving, do not run.
on('ui/notifications/tool-cancelled', () => { rt.streaming = false; doc.removeAttribute('data-streaming'); rt.changed(); reveal(); measure(); });
on('ui/notifications/host-context-changed', applyContext);

request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'canopy-widget', version: '1' }, appCapabilities: { availableDisplayModes: ['inline'] } })
  .then((res) => {
    applyContext(res.hostContext as Json | undefined);
    const mine = (res._meta as Json | undefined)?.['canopy/widget'] as { state?: typeof rt.saved; restored?: boolean } | undefined;
    if (mine?.state && typeof mine.state === 'object') rt.saved = mine.state;
    rt.restored = mine?.restored === true;
    notify('ui/notifications/initialized');
  })
  .catch((err) => report(`The frame could not start: ${String((err as Error)?.message ?? err)}`));

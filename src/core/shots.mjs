// Shots: every picture the look tool takes, kept for the chat that took it, so a widget can show it again by name
// (docs/design/visual-widgets.md, "Screenshots: look → shot store → frame").
//
//  - createShotStore({ dir })   one for the app. Each chat's pictures are numbered look-1, look-2, … and the newest
//                               40 are kept, on disk under `<dir>/<chat>/` (look-N.jpg and look-N.json: width, height,
//                               url, capturedAt, elements), so a chat reopened after a restart still finds them.
//      .put(chat, shot)         keep one: { jpeg: Buffer, width, height, url?, elements?, capturedAt? } -> 'look-N' | null
//      .get(chat, ref)          one of that chat's: { data: 'data:image/jpeg;base64,…', width, height, url, elements,
//                               capturedAt } | null. Only ever a ref of that chat
//      .refs(chat)              the refs a chat has, oldest first
//      .alias(from, to)         a chat that was known as `from` is now `to`: its shots go along (see forChat)
//      .forget(chat)            a chat's shots are removed
//      .forChat(key)            one chat's side, what look is handed as ctx.shots: { put(shot) -> ref | null }.
//                               `key()` says what the chat is called now (its sessionId). Until it has one, its shots
//                               are kept under a name of the handle's own and moved to the id once it arrives; when
//                               the id changes (an edited first message, a fork), the shots are copied to the new id
//                               if it has none, so the refs the conversation already holds keep working.
//  - cleanElements(list, size)  an element map as it is kept: well formed, inside the picture, at most 400
//  - isShotRef(ref)             'look-<1-6 digits>'
//
// Plain Node, no Electron: the JPEG is made by whoever took the picture. Nothing here throws to its caller; a disk
// that refuses is logged and the shot is not kept.
import realFs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_SHOTS = 40;
export const MAX_ELEMENTS = 400;
/** The most chats whose shots stay on disk; the ones touched longest ago go first. */
export const MAX_CHATS = 300;
const SHOT_RE = /^look-(\d{1,6})$/;
const FILE_RE = /^look-(\d{1,6})\.json$/;
// A chat's folder name: a sessionId (a UUID, a Codex thread id) or a handle's own name. Never a path.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_TEXT = 80;
const MAX_SELECTOR = 120;

export const isShotRef = (ref) => typeof ref === 'string' && SHOT_RE.test(ref);
const isKey = (k) => typeof k === 'string' && KEY_RE.test(k) && !k.includes('..');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null;
};

/**
 * An element map as it is kept: each `{ x, y, w, h, tag, role, text, selector }` in CSS px of the picture, cut to
 * the part inside it (`size`: the picture's width and height), whole pixels, nothing empty, at most 400.
 */
export function cleanElements(list, { width, height } = {}) {
  if (!Array.isArray(list)) return [];
  const W = num(width) ?? Infinity, H = num(height) ?? Infinity;
  const out = [];
  for (const e of list) {
    if (out.length >= MAX_ELEMENTS) break;
    if (!e || typeof e !== 'object') continue;
    const x = num(e.x), y = num(e.y), w = num(e.w), h = num(e.h);
    const tag = typeof e.tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/i.test(e.tag) ? e.tag.toLowerCase() : null;
    if (x === null || y === null || w === null || h === null || !tag) continue;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
    if (!(x1 - x0 >= 1 && y1 - y0 >= 1)) continue;
    const rx = Math.round(x0), ry = Math.round(y0);
    out.push({
      x: rx, y: ry, w: Math.max(1, Math.round(x1) - rx), h: Math.max(1, Math.round(y1) - ry), tag,
      role: str(e.role, 40), text: str(e.text, MAX_TEXT), selector: str(e.selector, MAX_SELECTOR),
    });
  }
  return out;
}

/**
 * @param {{ dir: string | (() => string), fs?: typeof realFs, max?: number, maxChats?: number,
 *           log?: (msg: string) => void, now?: () => number }} opts
 */
export function createShotStore({ dir, fs = realFs, max = MAX_SHOTS, maxChats = MAX_CHATS, log = () => {}, now = Date.now } = {}) {
  const root = () => (typeof dir === 'function' ? dir() : dir);
  const chats = new Map(); // key -> { next, refs: number[] (oldest first) }
  let pruned = false;
  const say = (msg, err) => { try { log(`shots: ${msg}${err ? `: ${err?.message ?? err}` : ''}`); } catch { /* logging never breaks a look */ } };
  const folder = (key) => path.join(root(), key);
  const file = (key, n, ext) => path.join(folder(key), `look-${n}.${ext}`);

  // A chat as it stands on disk, read once. Only a shot whose JSON was written is one (it is written last).
  function chat(key) {
    let c = chats.get(key);
    if (c) return c;
    let names = [];
    try { names = fs.readdirSync(folder(key)); } catch { /* none yet */ }
    const refs = names.map((n) => FILE_RE.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
    c = { next: (refs.at(-1) ?? 0) + 1, refs };
    chats.set(key, c);
    return c;
  }

  const removeShot = (key, n) => {
    for (const ext of ['json', 'jpg']) { try { fs.rmSync(file(key, n, ext), { force: true }); } catch (err) { say(`removing look-${n} failed`, err); } }
  };

  // Chats nobody has opened for longest go once there are too many on disk. Once per run, at the first shot.
  function prune(keep) {
    if (pruned) return;
    pruned = true;
    try {
      const all = fs.readdirSync(root()).filter(isKey).filter((k) => k !== keep);
      if (all.length < maxChats) return;
      const aged = all.map((k) => { try { return { k, t: fs.statSync(folder(k)).mtimeMs }; } catch { return { k, t: 0 }; } }).sort((a, b) => a.t - b.t);
      for (const { k } of aged.slice(0, all.length - maxChats + 1)) forget(k);
    } catch { /* nothing kept yet */ }
  }

  function put(key, shot) {
    try {
      if (!isKey(key) || !shot || !Buffer.isBuffer(shot.jpeg) || !shot.jpeg.length) return null;
      const width = Math.round(num(shot.width) ?? 0), height = Math.round(num(shot.height) ?? 0);
      if (!(width > 0 && height > 0)) return null;
      prune(key);
      const c = chat(key);
      const n = c.next;
      fs.mkdirSync(folder(key), { recursive: true });
      const meta = {
        width, height, url: typeof shot.url === 'string' ? shot.url.slice(0, 2000) : null,
        capturedAt: num(shot.capturedAt) ?? now(), elements: cleanElements(shot.elements, { width, height }),
      };
      fs.writeFileSync(file(key, n, 'jpg'), shot.jpeg);
      fs.writeFileSync(file(key, n, 'json'), JSON.stringify(meta));
      c.next = n + 1;
      c.refs.push(n);
      while (c.refs.length > max) removeShot(key, c.refs.shift());
      return `look-${n}`;
    } catch (err) { say('keeping a shot failed', err); return null; }
  }

  function get(key, ref) {
    try {
      const m = isKey(key) && typeof ref === 'string' ? SHOT_RE.exec(ref) : null;
      if (!m) return null;
      const n = Number(m[1]);
      const meta = JSON.parse(fs.readFileSync(file(key, n, 'json'), 'utf8'));
      const jpeg = fs.readFileSync(file(key, n, 'jpg'));
      if (!jpeg.length || !(meta?.width > 0) || !(meta?.height > 0)) return null;
      return {
        data: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width: meta.width, height: meta.height,
        url: typeof meta.url === 'string' ? meta.url : null, capturedAt: num(meta.capturedAt), elements: Array.isArray(meta.elements) ? meta.elements : [],
      };
    } catch { return null; }
  }

  const refs = (key) => { try { return isKey(key) ? chat(key).refs.map((n) => `look-${n}`) : []; } catch { return []; } };

  function forget(key) {
    try {
      if (!isKey(key)) return;
      chats.delete(key);
      fs.rmSync(folder(key), { recursive: true, force: true });
    } catch (err) { say('removing a chat\'s shots failed', err); }
  }

  /** `from`'s shots, under `to` as well (or only, with `move`). Only into a chat that has none: refs never collide. */
  function alias(from, to, { move = false } = {}) {
    try {
      if (!isKey(from) || !isKey(to) || from === to) return false;
      const a = chat(from), b = chat(to);
      if (!a.refs.length || b.refs.length) return false;
      fs.mkdirSync(folder(to), { recursive: true });
      for (const n of a.refs) {
        for (const ext of ['jpg', 'json']) {
          if (move) fs.renameSync(file(from, n, ext), file(to, n, ext));
          else fs.copyFileSync(file(from, n, ext), file(to, n, ext));
        }
      }
      chats.set(to, { next: Math.max(a.next, b.next), refs: [...a.refs] });
      if (move) forget(from);
      return true;
    } catch (err) { say('moving a chat\'s shots failed', err); return false; }
  }

  function forChat(key) {
    const named = typeof key === 'function' ? key : () => key;
    const own = `new-${randomUUID()}`; // the chat's name until it has an id
    let last = null;                   // the name its shots were last kept under
    const current = () => {
      let id = null;
      try { id = named(); } catch { /* no id yet */ }
      const now = isKey(id) ? id : own;
      if (last && last !== now) alias(last, now, { move: last === own });
      last = now;
      return now;
    };
    return {
      put: (shot) => put(current(), shot),
      get: (ref) => get(current(), ref),
      key: current,
    };
  }

  return { put, get, refs, alias, forget, forChat };
}

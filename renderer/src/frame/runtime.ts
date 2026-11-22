// What the frame's parts share: whether the widget is still arriving, what it has remembered, and the way out
// (answering back). The page (main.ts) owns the bridge and fills this in; components only read and write here.
import { notify, request } from './rpc';

export type ShotImage = { data: string; mimeType: string };
/** A screenshot the `look` tool took in this chat, as the host hands it over. */
export type Shot = {
  data: string; width: number; height: number; url?: string | null;
  elements?: { x: number; y: number; w: number; h: number; tag: string; role?: string | null; text?: string | null; selector?: string | null }[];
};
const shots = new Map<string, Promise<Shot | null>>();

type Saved = { c?: Record<string, unknown>; f?: Record<string, string | boolean>; u?: Record<string, unknown>; sent?: string };
const STATE_LIMIT = 8000; // characters of JSON: a widget remembers choices, not data

const watchers = new Set<() => void>();
let saveTimer = 0;

export const rt = {
  /** The widget's HTML is still being written: components leave out what is not whole yet. */
  streaming: false,
  /** Loaded from a saved chat, or drawn live. A live widget eases in; a saved one is simply there. */
  restored: false,
  /** The widget's title, as Claude gave it (what notes on a design say they are on, when nothing better is known). */
  title: '',
  /** What this widget remembered: `c` per component, `f` form controls, `u` the script's own (canopy.state). */
  saved: {} as Saved,

  /** Told when `streaming` or what was sent changes, so a component can draw itself again. */
  watch(fn: () => void) { watchers.add(fn); return () => { watchers.delete(fn); }; },
  changed() { for (const fn of watchers) { try { fn(); } catch (err) { console.error(err); } } },

  get<T>(key: string): T | undefined { return rt.saved.c?.[key] as T | undefined; },
  set(key: string, value: unknown) { (rt.saved.c ??= {})[key] = value; rt.save(); },
  /** Hand the host what to remember, soon. Too much to keep is not kept at all. */
  save() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      let json = '';
      try { json = JSON.stringify(rt.saved); } catch { return; }
      // `touched`: you have clicked or typed in this widget (the host counts a widget as used on that, not on state
      // a script saved by itself, or on a saved widget's controls being put back).
      if (json.length <= STATE_LIMIT) notify('canopy/state', { state: JSON.parse(json), touched: navigator.userActivation?.hasBeenActive === true });
    }, 150);
  },

  /**
   * Answer back: `text` becomes the user's next message. Only while the user is acting (a click, a key): a widget
   * cannot speak for them on its own. Resolves true once the host has taken it.
   */
  async send(text: string, images: ShotImage[] = []): Promise<boolean> {
    const t = String(text ?? '').trim();
    if (!t) return false;
    if (!navigator.userActivation?.isActive) { notify('notifications/message', { level: 'warning', logger: 'widget', data: 'An answer was not sent: it did not come from a click.' }); return false; }
    // Words alone go as one text block, as they always have; with pictures, as a list of blocks.
    const content = images.length ? [{ type: 'text', text: t }, ...images.map((im) => ({ type: 'image', data: im.data, mimeType: im.mimeType }))] : { type: 'text', text: t };
    try {
      await request('ui/message', { role: 'user', content }, 30_000);
      rt.saved.sent = t;
      rt.save();
      rt.changed();
      return true;
    } catch { return false; }
  },
};

/**
 * A screenshot by its ref ("look-3"), asked of the host once per frame and shared by everything that shows it.
 * Null when the host has none to give (another chat's, too old, not a picture at all).
 */
export function shot(ref: string): Promise<Shot | null> {
  let p = shots.get(ref);
  if (!p) {
    p = request('canopy/shot', { ref }, 15_000).then((r) => {
      const s = r as Partial<Shot>;
      const ok = typeof s.data === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(s.data) && Number(s.width) > 0 && Number(s.height) > 0;
      return ok ? { data: s.data as string, width: Number(s.width), height: Number(s.height), url: typeof s.url === 'string' ? s.url : null, elements: Array.isArray(s.elements) ? s.elements : [] } : null;
    }, () => null);
    shots.set(ref, p);
  }
  return p;
}

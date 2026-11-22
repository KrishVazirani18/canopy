// The menu bar icon. At a glance: the Canopy mark when nothing is running, the tree growing tier by tier
// while Claude works (with a count once more than one chat is busy), and a dot when a chat needs you.
// Click it for a short native menu: open Canopy, start a chat, and the chats worth going back to
// (needing you, working, finished and unread). The icons are template images from scripts/render-icon.mjs,
// so macOS tints them to match the bar. Fed by ChatHost's onStatus (src/chats.mjs). Electron comes in
// through the constructor, so the rest loads (and is tested) in plain Node.
import path from 'node:path';

/** The working animation, rendered by scripts/render-icon.mjs as working-0… It is the loading logo's (.grow in
 *  renderer/src/index.css): the tiers grow in from the trunk, then breathe in a wave. Frames 0…grow-1 play once,
 *  when work starts from idle; the next `loop` frames repeat. One frame is a 32nd of the 2.6 s breath. */
export const ANIMATION = { frameMs: 2600 / 32, grow: 15, loop: 32 };
const STILL_FRAME = ANIMATION.grow + 18; // Reduce Motion: one moment of the breath (the trunk end dimmed), held
const MAX_PER_SECTION = 6;
// The menu lists only chats worth going back to, in sections. Idle chats are left out: the window has those.
const SECTIONS = [['needs-you', 'Needs you'], ['working', 'Working'], ['done', 'Finished']];

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const busy = (c) => c.state === 'working' || c.state === 'needs-you' || (c.helpers || 0) > 0;

/** What the icon shows for a status list: which picture, and the text beside it. Pure, for tests. */
export function summarize(list) {
  const chats = list.filter((c) => c.sessionId);
  const needs = chats.filter((c) => c.state === 'needs-you').length;
  const working = chats.filter(busy).length;
  const icon = needs ? 'needs-you' : working ? 'working' : 'idle';
  // A count only once there is more than one: a single busy chat is what the moving tree already says.
  const count = needs ? needs : working;
  return { icon, title: count > 1 ? String(count) : '', needs, working };
}

/** Which section a chat belongs in, or null to leave it out. A chat with helpers still running counts as working. */
export function section(c) {
  if (!c.sessionId) return null;
  if (c.state === 'needs-you') return 'needs-you';
  if (busy(c)) return 'working';
  if (c.state === 'done' && c.unread) return 'done';
  return null;
}

/** The menu's chat sections, in order, each with its chats: [{ key, label, chats }]. Empty sections are dropped. */
export function menuSections(list) {
  return SECTIONS.map(([key, label]) => ({ key, label, chats: list.filter((c) => section(c) === key).slice(0, MAX_PER_SECTION) }))
    .filter((s) => s.chats.length);
}

export class MenuBar {
  /**
   * @param {{ electron: { Menu: any, Tray: any, nativeImage: any, systemPreferences: any }, assets: string,
   *   version?: () => string, onOpenChat: (c: {sessionId: string, cwd: string}) => void,
   *   onNewChat: () => void, onShow: () => void, onQuit: () => void, log?: (msg: string) => void }} opts
   */
  constructor({ electron, assets, version, onOpenChat, onNewChat, onShow, onQuit, log }) {
    const { Tray, nativeImage } = electron;
    Object.assign(this, { electron, version: version ?? (() => ''), onOpenChat, onNewChat, onShow, onQuit, log: log ?? (() => {}) });
    const img = (name) => nativeImage.createFromPath(path.join(assets, `${name}Template.png`)); // picks up @2x and the template flag
    this.icons = { idle: img('idle'), 'needs-you': img('needs-you'), working: Array.from({ length: ANIMATION.grow + ANIMATION.loop }, (_, i) => img(`working-${i}`)) };
    this.list = [];
    this.shown = null;   // { icon, title } on screen now, so unchanged updates cost nothing
    this.frame = 0;
    this.timer = null;
    this.tray = new Tray(this.icons.idle);
    this.tray.setToolTip('Canopy');
    // No fixed context menu: it is built when opened, from the latest list.
    const open = () => { try { this.tray.popUpContextMenu(this.#menu()); } catch (err) { this.log(`menu bar: ${err?.message ?? err}`); } };
    this.tray.on('click', open);
    this.tray.on('right-click', open);
  }

  update(list) {
    this.list = list;
    const { icon, title } = summarize(list);
    if (title !== this.shown?.title) this.tray.setTitle(title, { fontType: 'monospacedDigit' });
    if (icon !== this.shown?.icon) {
      clearInterval(this.timer);
      this.timer = null;
      // Reduce Motion: hold one frame instead of animating.
      const still = this.electron.systemPreferences.getAnimationSettings?.().prefersReducedMotion;
      if (icon === 'working' && !still) {
        // Grow in only when work starts from rest; back from "needs you", the tree is already up: just breathe.
        const { grow, loop, frameMs } = ANIMATION;
        this.frame = this.shown?.icon === 'needs-you' ? grow : 0;
        this.tray.setImage(this.icons.working[this.frame]);
        this.timer = setInterval(() => {
          this.frame = this.frame + 1 < grow + loop ? this.frame + 1 : grow;
          this.tray.setImage(this.icons.working[this.frame]);
        }, frameMs);
      } else this.tray.setImage(icon === 'working' ? this.icons.working[STILL_FRAME] : this.icons[icon]);
    }
    this.tray.setToolTip(icon === 'needs-you' ? 'Canopy: a chat needs you' : icon === 'working' ? 'Canopy: working' : 'Canopy');
    this.shown = { icon, title };
  }

  #menu() { return this.electron.Menu.buildFromTemplate(this.template()); }

  /** The menu as a template (exposed for tests). */
  template() {
    const chats = menuSections(this.list).flatMap((sec) => [
      { type: 'header', label: sec.label },
      ...sec.chats.map((c) => ({ label: clip(c.title || 'New chat', 44), click: () => this.onOpenChat({ sessionId: c.sessionId, cwd: c.cwd }) })),
    ]);
    return [
      { label: 'Open Canopy', click: () => this.onShow() },
      { label: 'New Chat', click: () => this.onNewChat() },
      ...(chats.length ? [{ type: 'separator' }, ...chats] : []),
      { type: 'separator' },
      ...(this.version() ? [{ label: `Canopy ${this.version()}`, enabled: false }] : []),
      { label: 'Quit Canopy', click: () => this.onQuit() },
    ];
  }

  destroy() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.tray.destroy(); } catch {}
  }
}

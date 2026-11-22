// The base of every Canopy component. A component keeps what Claude wrote (its children and attributes) as its data
// and draws itself in its own shadow root, so the page can keep morphing the data underneath while it streams and
// nothing drawn is lost; Claude's CSS cannot reach inside, and the component's cannot leak out.
import { rt } from './runtime';
import base from './base.css?inline';

let sheet: CSSStyleSheet | null = null;
/** Canopy's element styles (buttons, inputs, text), shared by every shadow root. */
function baseSheet() {
  if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(base); }
  return sheet;
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export abstract class CanopyElement extends HTMLElement {
  protected root: ShadowRoot;
  private observer: MutationObserver;
  private frame = 0;
  private unwatch: (() => void) | null = null;

  constructor(css: string) {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const own = new CSSStyleSheet();
    own.replaceSync(css);
    this.root.adoptedStyleSheets = [baseSheet(), own];
    this.observer = new MutationObserver(() => this.changed());
  }

  connectedCallback() {
    this.observer.observe(this, { childList: true, subtree: true, characterData: true, attributes: true });
    this.unwatch = rt.watch(() => this.changed());
    this.draw();
  }

  disconnectedCallback() {
    this.observer.disconnect();
    this.unwatch?.();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** The data changed (more of it arrived, a script set an attribute): draw again, once, on the next frame. */
  protected changed() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  private draw() {
    try { this.render(); } catch (err) { console.error(err); }
  }

  /** Read the children and attributes, and draw into `this.root`. Called often: keep what the user has touched. */
  protected abstract render(): void;

  /** Where this component's remembered state lives: its id, or its place among its kind. */
  protected get key(): string {
    if (this.id) return `#${this.id}`;
    const tag = this.localName;
    return `${tag}:${Array.from(document.querySelectorAll(tag)).indexOf(this)}`;
  }
  protected recall<T>(): T | undefined { return rt.get<T>(this.key); }
  protected remember(value: unknown) { rt.set(this.key, value); }

  /** This component's own text, without the text of elements inside it. */
  protected ownText(): string {
    let out = '';
    for (const n of Array.from(this.childNodes)) if (n.nodeType === 3) out += n.nodeValue;
    return out;
  }
}

/** Set an attribute only when it would change: a component watches its own subtree, and setting the same value
 *  again still counts as a change, which would have it redraw forever. */
export function setAttr(el: Element, name: string, value: string) { if (el.getAttribute(name) !== value) el.setAttribute(name, value); }

export const define = (name: string, ctor: CustomElementConstructor) => { if (!customElements.get(name)) customElements.define(name, ctor); };

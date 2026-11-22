// Dragging a model row to arrange the menu's four rows. The model menu (model-menu.tsx) and Settings > Models
// (settings-models.tsx) both use this, so a row moves the same way in both.
//
// What a drag can do is one rule, lib/model-rules.ts `dragModel`:
//   - one of the four onto another of the four: it moves there, and the rows between shift by one
//   - another model onto one of the four: it takes that row, and the model it displaces leaves the four
//   - one of the four onto another model: that model takes its row
//
// Rows are marked in the page, not registered here:
//   data-model-row="2"                  one of the four, by its place from the top
//   data-model-more="openai:gpt-6-luna" any other model, by its key
//   data-model-top                      anything above the four that should count as their first row (the search field)
//
// A press on a row only arms the drag. It starts once the pointer has moved a few pixels, so a click stays a click.
// While it lasts:
//   - `rows` is the four as they would be if the pointer were let go now, so the list shows where the row will land
//   - the model's mark and name follow the pointer, just off it so the row pointed at stays in view, and the row
//     itself is drawn faint in its new place
//   - a shield covers the window. Nothing under it hears the pointer, which keeps the menu's focus still. What the
//     pointer is over is read from the page instead (`elementsFromPoint`, which sees through the shield).
//   - a list that scrolls (Settings) scrolls when the pointer is near its top or bottom edge
//   - Esc puts everything back, and does not close the menu. The shield stays until the button is let go, so that
//     letting go over a row is not taken for a pick of that row
// Letting go saves the four through `onArrange`, when they changed.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ModelLogo } from './maker-logo';
import { dragModel, type DropTarget, type Model } from '@/lib/models';
import { cn } from '@/lib/utils';

/** How far the pointer moves before a press becomes a drag. */
const START = 4;
/** How near a scrolling list's edge the pointer has to be for the list to scroll, and how far it scrolls per frame. */
const EDGE = 40, STEP = 10;

/** How far off the pointer the model's name and drop hint are carried. */
const CARRY = { x: 12, y: 10 };

/** `off`: given up with Esc while the button is still down. Nothing is shown as dragged any more. */
type Drag = { model: Model; x: number; y: number; onto: DropTarget | null; off?: boolean };

export type ModelDrag = {
  /** The four to draw: as they would be if the drag ended now. The rows handed in when nothing is being dragged. */
  rows: Model[];
  /** The key of the model being dragged. Its row is drawn faint. */
  dragging: string | null;
  /** The key of a row that will be replaced by the drop (in the four, or under More models). */
  onto: string | null;
  /** What a row that can be dragged is given. */
  grab: (model: Model) => { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void };
  /** A drag ended a moment ago: the click that may follow it is not a pick. */
  justDragged: () => boolean;
  /** The shield and the name that follows the pointer. Draw it once, anywhere. */
  layer: React.ReactNode;
};

/** What is under a point, topmost first, without the drag's own layer. */
const under = (x: number, y: number): Element[] => document.elementsFromPoint(x, y).filter((el) => !el.closest('[data-model-drag]'));

/** The row a point is on, as a place to drop. */
function dropAt(els: Element[]): DropTarget | null {
  for (const el of els) {
    const row = el.closest<HTMLElement>('[data-model-row]');
    if (row) return { row: Number(row.dataset.modelRow) };
    const more = el.closest<HTMLElement>('[data-model-more]');
    if (more?.dataset.modelMore) return { more: more.dataset.modelMore };
    if (el.closest('[data-model-top]')) return { row: 0 };
  }
  return null;
}

/** The nearest thing around a row that scrolls up and down, if any does. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const flow = getComputedStyle(p).overflowY;
    if ((flow === 'auto' || flow === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

export function useModelDrag({ rows, all, onArrange, onOver, onEnd }: {
  /** The four as they are saved now. */
  rows: Model[];
  /** Every model of both makers. */
  all: Model[];
  /** The drag ended and the four changed: these are the four now. */
  onArrange: (rows: Model[]) => void;
  /** Called as the pointer moves, so a row held over More models can open its submenu. */
  onOver?: (under: Element[], inFour: boolean) => void;
  /** The drag is over (let go, or given up), with the elements under its final position. */
  onEnd?: (under: Element[]) => void;
}): ModelDrag {
  const [drag, setDrag] = useState<Drag | null>(null);
  // The listeners below live for one press and must read what is current, not what was when it began.
  const now = useRef({ rows, all, onArrange, onOver, onEnd });
  now.current = { rows, all, onArrange, onOver, onEnd };
  const ended = useRef(0);
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []); // the menu closed under a press

  const grab = (model: Model) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !e.isPrimary || release.current) return;
      const pointer = e.pointerId;
      const from = { x: e.clientX, y: e.clientY };
      const scroller = scrollerOf(e.currentTarget);
      let cur: Drag | null = null;
      let frame = 0;

      const look = (x: number, y: number) => {
        const els = under(x, y);
        cur = { ...cur!, x, y, onto: dropAt(els) };
        setDrag(cur);
        now.current.onOver?.(els, now.current.rows.some((m) => m.key === model.key));
      };
      // Near the top or bottom edge of a list that scrolls, it scrolls, and what is under the pointer is read again.
      const scroll = () => {
        frame = 0;
        if (!cur || cur.off) return;
        // Follow the list under the pointer when a drag crosses into another scrolling panel.
        const els = under(cur.x, cur.y);
        const target = els.find((el) => el.matches('[data-model-row], [data-model-more]'));
        const list = (target instanceof HTMLElement && scrollerOf(target)) || scroller;
        if (!list) return;
        const r = list.getBoundingClientRect();
        if (cur.x < r.left || cur.x > r.right || cur.y < r.top - EDGE || cur.y > r.bottom + EDGE) return;
        const by = cur.y < r.top + EDGE ? -STEP : cur.y > r.bottom - EDGE ? STEP : 0;
        const before = list.scrollTop;
        if (by) list.scrollTop += by;
        if (list.scrollTop !== before) { look(cur.x, cur.y); frame = requestAnimationFrame(scroll); }
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointer || cur?.off) return;
        if (!cur) {
          if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < START) return;
          window.getSelection()?.removeAllRanges();
          cur = { model, x: ev.clientX, y: ev.clientY, onto: null };
        }
        ev.preventDefault();
        look(ev.clientX, ev.clientY);
        if (!frame) frame = requestAnimationFrame(scroll);
      };
      const finish = (keep: boolean) => {
        release.current?.();
        if (!cur) return;
        const { rows: four, all: list, onArrange: save, onEnd: done } = now.current;
        const next = dragModel(four, list, model.key, cur.onto);
        const els = under(cur.x, cur.y);
        keep &&= !cur.off;
        cur = null;
        ended.current = performance.now();
        setDrag(null);
        if (keep && next.some((m, i) => m !== four[i])) save(next);
        done?.(els);
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointer) return;
        if (cur && !cur.off) look(ev.clientX, ev.clientY);
        finish(true);
      };
      const cancel = (ev: PointerEvent | Event) => { if (!('pointerId' in ev) || ev.pointerId === pointer) finish(false); };
      // Esc gives the drag up. It is stopped here, on its way down, so the menu does not also close.
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || !cur) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        cur = { ...cur, onto: null, off: true };
        setDrag(cur);
      };
      release.current = () => {
        release.current = null;
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancel, true);
        window.removeEventListener('blur', cancel);
        window.removeEventListener('keydown', key, true);
      };
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('blur', cancel);
      window.addEventListener('keydown', key, true);
    },
  });

  const inFour = !!drag && rows.some((m) => m.key === drag.model.key);
  const more = drag?.onto && 'more' in drag.onto ? drag.onto.more : null;
  const replaced = drag?.onto && !inFour && 'row' in drag.onto ? rows[drag.onto.row] : null;
  const next = drag ? dragModel(rows, all, drag.model.key, drag.onto) : rows;
  const changed = next.some((m, i) => m !== rows[i]);
  const hint = !drag?.onto ? 'Release to cancel'
    : replaced ? `Replace ${replaced.label}`
    : inFour && more ? `Swap with ${all.find((m) => m.key === more)?.label ?? 'model'}`
    : changed ? 'Release to reorder' : inFour ? 'Drag to reorder' : 'Drop onto a model above';
  return {
    rows: next,
    dragging: drag && !drag.off ? drag.model.key : null,
    onto: replaced?.key ?? (inFour && more && !rows.some((m) => m.key === more) ? more : null),
    grab,
    justDragged: () => performance.now() - ended.current < 300,
    // On the page itself, above every menu and dialog. An open menu or dialog switches the pointer off for everything
    // outside it, so the shield switches it back on for itself.
    layer: drag && createPortal(
      <div data-model-drag aria-hidden className={cn('fixed inset-0 z-[200] select-none', !drag.off && 'cursor-grabbing')} style={{ pointerEvents: 'auto' }}>
        {!drag.off && (
          <div className="pointer-events-none absolute max-w-[240px] rounded-lg border bg-popover px-3 py-2 text-ui text-popover-foreground elev-pop"
            style={{ left: Math.max(8, Math.min(drag.x + CARRY.x, window.innerWidth - 248)), top: Math.max(8, Math.min(drag.y + CARRY.y, window.innerHeight - 72)) }}>
            <div className="flex items-center gap-2"><ModelLogo model={drag.model} className="text-foreground" /><span className="truncate">{drag.model.label}</span></div>
            <div className="mt-1 text-micro text-muted-foreground">{hint}</div>
          </div>
        )}
      </div>,
      document.body,
    ),
  };
}

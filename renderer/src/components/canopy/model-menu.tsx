// The model menu that opens from the composer's model chip.
//
// Top to bottom: a search field, four model rows, "More models" for the rest, and one block with the effort slider
// and Fast side by side (EffortFast below; controls.tsx owns what they set).
//
//   - Always four model rows (fewer only when there are fewer than four models). Which four, and in what order, is
//     lib/models.ts `menuRows`: Opus, GPT Sol, Fable and GPT Astra until you arrange them yourself.
//   - Every row carries its maker's mark. The model the chat runs on has the tick; when that model is not one of
//     the four, the tick is on "More models" and on its row in there. Picking a model never changes the four.
//   - Once the chat has started, a row of the other maker has a small arrow instead: picking it moves the chat
//     there (a new chat in the same folder that carries on from this one, which stays as it is). "Move chat" is
//     written beside the arrow only while the row is highlighted. It is on the name's own line, so no row changes
//     height: the menu opens upwards from the chip, and a row that grew would move every row above it while you
//     were aiming at one. Two words, so the longest name still fits beside it. While the chat is working or waiting
//     on you those rows are dimmed and cannot be picked, and the words read "After this turn".
//   - The search looks through every model of both makers. While something is typed the rows and "More models" give
//     way to one flat list of what matches.
//   - "More models" opens on the right on hover, with room reserved for it, the rest grouped by maker, and "Edit models…"
//     (Settings > Models) at its foot. With nothing left over there is no submenu, and "Edit models…" is a row here.
//   - Rows are arranged by dragging (model-drag.tsx): a row of the four up or down, a model from More models onto
//     one of the four to take its place, or one of the four onto a model in More models to give its place away. A
//     grip on the left starts the drag; clicking the name still selects the model. While a row is dragged the four
//     show where it will land,
//     and "More models" stays open (or opens when the row is held over it): Radix would close it the moment the
//     pointer left, so its open state is kept here for as long as the drag lasts. There is nothing to drag while
//     searching.
//
// This is Radix's menu, so hover, the arrow keys, Enter, Esc and the submenu are its own. What Radix has no notion of
// is a text field inside a menu, and the five places below that deal with it are marked "the field":
//   1. keys typed in the field stay in the field (the menu's typeahead would jump to a row instead);
//   2. a letter typed anywhere else in the menu goes to the field (hovering a row moves the focus onto that row);
//   3. the field has the focus when the menu opens, so you can type at once;
//   4. Down from the field goes to the first row, and Up from the first row goes back to the field;
//   5. whenever no row is highlighted the focus is in the field, so its caret shows where typing goes.
// No key arranges the rows, and no new shortcut opens or drives the menu.
//
// A click on the field also has to reach it. Opened from a composer low in a short window, the top of the menu lies
// over the title bar, and Electron hands a click inside that drag region to the window whatever is drawn over it:
// index.css marks every floating layer no-drag for this.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRightIcon, CheckIcon, GripVerticalIcon, SearchIcon } from 'lucide-react';
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { EffortSlider } from './effort-slider';
import { ModelLogo } from './maker-logo';
import { useModelDrag } from './model-drag';
import type { Engine } from '@/lib/api';
import { MAKERS, MAKER_NAME, arrangeModels, searchModels, splitMenu, useSavedModels, type Effort, type Model, type SavedModels, type effortSlider } from '@/lib/models';
import { rowWords, type Movable } from '@/lib/move-rules';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';

// Reserve the submenu's width and gap from the outset, so it always fits on the right without a hover-time jump.
const MORE_WIDTH = 240;
const MORE_GAP = 9;
const MENU_INSET = 8;
const MENU_PADDING = { top: MENU_INSET, bottom: MENU_INSET, left: MENU_INSET, right: MENU_INSET + MORE_WIDTH + MORE_GAP };

export function ModelMenu({ open, all, active, engine, started, move, onPick, onClose, saved: given, onArrange, onEdit, children }: {
  open: boolean;
  /** Every model of both makers (lib/models.ts `useAllModels`). */
  all: Model[];
  /** The model the chat runs on: it has the tick. Null when it is not in the lists. */
  active: Model | null;
  /** The maker the chat runs on. */
  engine: Engine;
  /** The chat has a conversation in it, so a row of the other maker opens a new chat. */
  started: boolean;
  /** What picking the other maker's row does to that conversation: 'ok' moves the chat there, 'busy' is not until
   *  its turn is over (the rows are dimmed and cannot be picked). Left out: the row opens a new chat. */
  move?: Movable;
  /** A row was picked. The menu closes itself. */
  onPick: (model: Model) => void;
  onClose: () => void;
  /** The four as arranged, and what to do when they are dragged and when "Edit models…" is picked. Left out: what is
   *  saved on this Mac, saved again, and Settings > Models. (The Playground hands in its own, so nothing real moves.) */
  saved?: SavedModels;
  onArrange?: (rows: Model[]) => void;
  onEdit?: () => void;
  /** The effort and Fast block. */
  children: React.ReactNode;
}) {
  const stored = useSavedModels();
  const saved = given ?? stored;
  const { rows, more } = useMemo(() => splitMenu(all, saved), [all, saved]);

  const [typed, setTyped] = useState('');
  const [inField, setInField] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Something to search for: a letter or a digit. A stray dash or space leaves the menu as it is.
  const searching = /[a-z0-9]/i.test(typed);
  const found = useMemo(() => (searching ? searchModels(all, typed) : []), [searching, all, typed]);

  // "More models" is open when Radix says so (hover, the arrow keys), and for as long as a row is being dragged.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreList = useRef<HTMLDivElement>(null);
  const drag = useModelDrag({
    rows, all,
    onArrange: (next) => (onArrange ? onArrange(next) : arrangeModels(next, all)),
    // One of the four held over "More models": it opens, so the row can be let go on a model in there.
    onOver: (under, inFour) => { if (inFour && under.some((el) => el.closest('[data-more-trigger]'))) setMoreOpen(true); },
    // Let go: "More models" stays open only with the pointer still on it. The focus goes back where keys are heard
    // (the shield took it off the row), into the submenu when that stays, else to the field.
    onEnd: (under) => {
      const stay = under.some((el) => el.closest('[data-more-trigger], [data-more-list]'));
      setMoreOpen(stay);
      requestAnimationFrame(() => (stay ? moreList.current : field.current)?.focus({ preventScroll: true }));
    },
  });
  const dragging = drag.dragging !== null;

  // The field (3): Radix puts the focus on the menu itself as it opens (handed on at once, see 5), and then on its
  // first row when it was opened from the keyboard. Both happen as it mounts, so the field takes the focus one frame
  // later. What was typed is forgotten when the menu closes.
  useEffect(() => {
    if (!open) { setTyped(''); setMoreOpen(false); return; }
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => { if (searching) setMoreOpen(false); }, [searching]);

  // The menu opens upwards from the chip, so a list that got shorter with every letter would move the field you are
  // typing in. While you search, the list keeps the height it had before: matches fill it from the top.
  const list = useRef<HTMLDivElement>(null);
  const [rest, setRest] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) setRest(null);
    else if (!searching && list.current) setRest(list.current.offsetHeight);
  });

  const firstRow = () => content.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])') ?? null;
  /** A row of the other maker while the chat cannot be moved yet: shown, dimmed, not to be picked. */
  const blocked = (m: Model) => started && move === 'busy' && m.engine !== engine;

  // The field (1): its keys are its own. Down leaves for the first row, Enter picks the first match, and Tab does
  // nothing (a menu is not tabbed through). Esc is not stopped: Radix listens for it on the document.
  const onFieldKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); firstRow()?.focus(); }
    else if (e.key === 'Tab') e.preventDefault();
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (found[0] && !blocked(found[0])) { onPick(found[0]); onClose(); }
    }
  };

  // The field (2): a letter, digit or punctuation mark typed with the focus on a row, on the menu or in the submenu
  // is added to the search, and the field has the focus from then on. Backspace takes one away. Preventing the
  // default is what keeps Radix's typeahead out of it (it skips a key that was default-prevented), and is also how
  // the same key, bubbling up from the submenu to the menu, is told apart from a new one. Space is left alone: on a
  // row it picks the row.
  const typeToSearch = (e: React.KeyboardEvent) => {
    if (e.target === field.current || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const letter = e.key.length === 1 && e.key !== ' ';
    if (!e.defaultPrevented && (letter || (e.key === 'Backspace' && typed))) {
      e.preventDefault();
      setTyped((t) => (letter ? t + e.key : t.slice(0, -1)));
      field.current?.focus();
    }
  };
  // The field (4): Up on the first row has nowhere to go in Radix (the menu does not loop), so it goes to the field.
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' && e.target === firstRow()) { e.preventDefault(); field.current?.focus(); return; }
    typeToSearch(e);
  };
  // The field (5): Radix parks the focus on the menu itself whenever no row is highlighted: as it opens, each time the
  // pointer leaves a row (for the field, the effort block or out of the menu), and on a click that lands on nothing.
  // There the field would have no caret, though typing still went to it. So a focus parked on the menu is handed on.
  const onMenuFocus = (e: React.FocusEvent) => {
    if (e.target === e.currentTarget) field.current?.focus({ preventScroll: true });
  };

  /**
   * One model. `at`: its place among the four, `'more'` under More models, or `'found'` in the search results (which
   * cannot be dragged). `first`: the match Enter would pick, drawn highlighted while the typing is still in the field.
   */
  const row = (m: Model, at: number | 'more' | 'found', first = false) => {
    const on = m.key === active?.key;
    const opens = started && m.engine !== engine;
    const held = blocked(m);
    const place = at === 'found' ? null : at === 'more' ? { 'data-model-more': m.key } : { 'data-model-row': at };
    return (
      <DropdownMenuItem key={m.key} {...place} data-model-key={m.key} aria-disabled={held || undefined}
        // The click that ends a drag is not a pick, and neither is one on a row that cannot be picked yet (the menu stays open).
        onSelect={(e) => { if (held || drag.justDragged()) e.preventDefault(); else onPick(m); }}
        className={cn('group', held && 'text-muted-foreground [&>:not([data-says])]:opacity-50', (first || drag.onto === m.key) && 'bg-accent text-accent-foreground',
          drag.dragging === m.key && 'bg-accent/50 ring-1 ring-inset ring-foreground/25 [&>*]:opacity-35')}>
        {place && <span {...drag.grab(m)} data-model-handle title="Drag to arrange models"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="flex size-3.5 shrink-0 touch-none cursor-grab items-center justify-center text-faint opacity-50 hover:text-foreground active:cursor-grabbing group-data-[highlighted]:opacity-100">
          <GripVerticalIcon aria-hidden className="size-3.5" />
        </span>}
        <ModelLogo model={m} className={cn(on && 'text-foreground')} />
        <span className={cn('min-w-0 flex-1 truncate', on && 'font-medium')}>
          {m.label}
          {/* "Default" gives way to the words beside the arrow while they show: the two do not fit side by side. */}
          {m.maker === 'claude' && m.isDefault && m.id !== '' && <span className={cn('ml-1.5 text-small font-normal text-faint', opens && (first ? 'hidden' : 'group-data-[highlighted]:hidden'))}>Default</span>}
        </span>
        {opens && <span data-says className={cn('shrink-0 text-micro text-muted-foreground', first ? 'block' : 'hidden group-data-[highlighted]:block')}>{rowWords(move)}</span>}
        {on ? <CheckIcon className="size-3.5 text-foreground" /> : opens && <ArrowUpRightIcon className="size-3.5 text-faint" />}
      </DropdownMenuItem>
    );
  };
  /** "Edit models…": the quiet last row under More models, or, with nothing under More models, a row in its place. */
  const edit = (foot: boolean) => (
    <DropdownMenuItem onSelect={() => (onEdit ? onEdit() : ui.openSettings('models'))} className={cn('text-muted-foreground', foot && 'text-small')}>Edit models…</DropdownMenuItem>
  );

  return (
    // The height is never held under what the menu needs with its list at its shortest (212px). A menu is otherwise
    // held to the room on the side it opened on, and Radix decides the side by the height it finds: held to a
    // sliver once (the window passing through an odd size), it would find that the sliver fits and stay one.
    <DropdownMenuContent ref={content} side="top" align="end" sideOffset={8} sticky="always" collisionPadding={more.length > 0 ? MENU_PADDING : MENU_INSET} className="max-h-[max(212px,var(--radix-dropdown-menu-content-available-height))] w-64"
      onCloseAutoFocus={(e) => e.preventDefault()} onKeyDown={onMenuKey} onFocus={onMenuFocus}>
      {/* A row dragged up past the first row lands first. */}
      <div data-model-top className="flow-root">
        <label className="flex h-8 items-center gap-2 px-2">
          <SearchIcon className="size-3.5 shrink-0 text-faint" />
          <input ref={field} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={onFieldKey}
            onFocus={() => setInField(true)} onBlur={() => setInField(false)}
            placeholder="Search models" aria-label="Search models" autoComplete="off" autoCorrect="off" spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-ui outline-hidden placeholder:text-faint" />
        </label>
        <DropdownMenuSeparator />
      </div>
      <div ref={list}>
        {/* Four rows need no scrolling. The matches of a search can be more: they scroll here, and in a short window
            so do the four, so the search, effort and Fast stay in reach. */}
        <div data-model-scroll style={searching && rest ? { height: rest } : undefined}
          className="max-h-[max(4rem,calc(var(--radix-dropdown-menu-content-available-height)_-_10rem))] overflow-y-auto overscroll-contain">
          {searching
            ? found.length ? found.map((m, i) => row(m, 'found', i === 0 && inField)) : <div className="px-2 py-1.5 text-small text-faint">No models match</div>
            : drag.rows.map((m, i) => row(m, i))}
        </div>
        {!searching && (more.length > 0 ? (
          <DropdownMenuSub open={moreOpen} onOpenChange={(next) => { if (!dragging) setMoreOpen(next); }}>
            <DropdownMenuSubTrigger data-more-trigger className="text-muted-foreground">
              <span className="flex-1">More models</span>
              {/* The chat runs on a model that is not one of the four: this is where its tick is. */}
              {active && !drag.rows.includes(active) && <CheckIcon className="size-3.5 text-foreground" />}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent ref={moreList} data-more-list sideOffset={MORE_GAP} alignOffset={-5} collisionPadding={8} className="w-60" onKeyDown={typeToSearch}>
                {/* These rows stay where they are while a row is dragged: only the four show where it will land. */}
                {MAKERS.map((maker) => {
                  const own = more.filter((m) => m.maker === maker);
                  return own.length > 0 && (
                    <Fragment key={maker}>
                      <DropdownMenuLabel>{MAKER_NAME[maker]}</DropdownMenuLabel>
                      {own.map((m) => row(m, 'more'))}
                    </Fragment>
                  );
                })}
                <DropdownMenuSeparator />
                {edit(true)}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        ) : edit(false))}
      </div>
      <DropdownMenuSeparator />
      {/* The slider's own keys (the arrows, Home, End) stay with it; a letter typed there still goes to the search. */}
      <div onKeyDown={(e) => { typeToSearch(e); e.stopPropagation(); }}>{children}</div>
      {drag.layer}
    </DropdownMenuContent>
  );
}

/** The composer's small switch, drawn only: the button around it is what is clicked. Track 32×18, knob 14 with a 2px
 *  inset; only the knob moves (transform), the track colour snaps. */
function Toggle({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cn('flex h-[18px] w-8 shrink-0 items-center rounded-full p-[2px]', on ? 'bg-foreground' : 'bg-foreground/15')}>
      <span className={cn('size-3.5 rounded-full transition-transform duration-160 ease-drawer',
        on ? 'translate-x-3.5 bg-background shadow-[0_1px_2px_oklch(0_0_0/0.25)]' : 'bg-card shadow-[0_0_0_0.5px_oklch(0_0_0/0.12),0_1px_2px_oklch(0_0_0/0.2)]')} />
    </span>
  );
}

/**
 * Effort and Fast, in one block at the foot of the menu: the slider, and Fast beside it in the slider's own two
 * lines (the control above, its name under it). No heading and no Reset: the stop with the ring is the model's own
 * default, and choosing it means "follow the model" (lib/models.ts `chosenLevel`).
 * A model with fewer than two stops has no slider (`slider` is null): Fast is then one plain row.
 */
export function EffortFast({ slider, onLevel, fast }: {
  /** What lib/models.ts `effortSlider` gives for the model: its stops, where it sits, where Ultra and its default are. */
  slider: ReturnType<typeof effortSlider>;
  /** A stop was chosen. */
  onLevel: (level: Effort) => void;
  /** Fast. `on` is how it is drawn; `title` says why it cannot be changed when `disabled`. */
  fast: { on: boolean; disabled?: boolean; pending?: boolean; title: string; onChange: (on: boolean) => void };
}) {
  const control = fast.pending ? <Spinner className="size-3" /> : <Toggle on={fast.on} />;
  const press = { type: 'button' as const, role: 'switch', 'aria-checked': fast.on, disabled: fast.disabled, title: fast.title, onClick: () => fast.onChange(!fast.on) };
  if (!slider) {
    return (
      <button {...press} className="flex h-8 w-full items-center gap-2 px-2 text-ui disabled:opacity-40">
        <span className="flex-1 text-left">Fast</span>
        {control}
      </button>
    );
  }
  return (
    <div className="flex items-start gap-4 px-2 pt-2 pb-1.5">
      <div className="min-w-0 flex-1">
        <EffortSlider labels={slider.labels} index={slider.index} isDefault={slider.isDefault} ultraAt={slider.ultraAt} defaultAt={slider.defaultAt}
          onChange={(i) => { if (slider.stops[i]) onLevel(slider.stops[i]); }} />
      </div>
      <button {...press} className="group flex shrink-0 flex-col items-center disabled:opacity-40">
        <span className="flex h-5 w-8 items-center justify-center">{control}</span>
        <span className={cn('mt-1 h-4 text-micro', fast.on ? 'font-medium text-foreground' : 'text-muted-foreground group-enabled:group-hover:text-foreground')}>Fast</span>
      </button>
    </div>
  );
}

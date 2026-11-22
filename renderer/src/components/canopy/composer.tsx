// Message box with the session controls in its bottom row.
// Enter sends, Shift+Enter newline, Esc stops, Esc Esc steers, Shift+Tab cycles permission mode, Tab accepts the suggestion,
// "/" commands and skills, "@" files, paste or drop images and files (a PDF… shows as a card, sent as an @mention).
import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CornerDownRightIcon, ArrowUpIcon, GripVerticalIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Kbd } from '@/components/ui/kbd';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, type ImageAttachment } from '@/lib/api';
import { runCommand } from '@/lib/commands';
import { draftAttachments } from '@/lib/draft-attachments';
import { splitFiles, withFiles } from '@/lib/file-mentions';
import { FileCard } from './file-card';
import { StoreContext, useStore, type PermissionItem, type QueuedMessage, type Store } from '@/lib/store';
import { feature } from '@/lib/telemetry';
import { ui } from '@/lib/ui';
import { usePane } from '@/lib/pane';
import { useHeld } from '@/lib/held';
import { isPlan, keepPlanning } from '@/lib/plan';
import { useChatTrouble } from '@/lib/signin';
import { cn } from '@/lib/utils';
import { AccountBlocker } from './account-prompt';
import { ContextRing, Controls, MODES, setMode } from './controls';
import { PermissionCard } from './permission-card';
import { Reveal } from './reveal';
import { ImageViewer } from './message-images';
import { AgentsDrawer } from './agents-drawer';

/** Keys pressed while an IME is composing (Japanese, Chinese, Korean) belong to its candidate window, not to us.
 *  229 covers the keydowns that start and commit a composition, where isComposing is not set. */
const composing = (e: React.KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

// When you switch permission mode, a small card docks on top of the composer (like an attachment) saying what the
// mode means, for 10 seconds. A line along its bottom drains as the time runs out; hovering pauses it.
// Only the modes that need explaining. Ask Before Edits and Accept Edits say what they do.
const MODE_TEXT: Record<string, string> = {
  plan: 'Plan Mode. Canopy reads and plans, and changes nothing until you approve.',
  auto: 'Auto Mode. Safe actions run on their own; risky ones still ask.',
  bypassPermissions: 'Full Access. Everything runs without asking.',
};
function ModeNotice({ mode }: { mode: string | null }) {
  const store = useContext(StoreContext);
  const [shown, setShown] = useState<{ mode: string; n: number } | null>(null);
  // Only a mode you picked shows its card (setMode in controls.tsx says so). Not the mode a chat opens in, nor your
  // saved choice put back as a chat opens or comes on screen: that is a change of mode too, and showed the card on
  // every chat you switched to.
  useEffect(() => {
    const picked = (e: Event) => {
      const d = (e as CustomEvent<{ store: Store; mode: string }>).detail;
      if (d?.store !== store) return;
      if (MODE_TEXT[d.mode]) setShown((s) => ({ mode: d.mode, n: (s?.n ?? 0) + 1 }));
      else setShown(null);
    };
    window.addEventListener('canopy:mode-picked', picked);
    return () => window.removeEventListener('canopy:mode-picked', picked);
  }, [store]);
  // Any later change ends a card that no longer describes the mode (a mode Claude Code refused goes back to the one
  // before, another chat came on screen), so the card never stays on the wrong mode.
  useEffect(() => { if (shown && mode !== shown.mode) setShown(null); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = MODES.find((x) => x.value === shown?.mode);
  const risky = shown?.mode === 'auto' || shown?.mode === 'bypassPermissions';
  return (
    <Reveal show={!!shown} appear from="bottom" duration={220}>
      {shown && m && (
        // Docked to the composer: a tab flush on its top edge (no gap, no bottom border), slightly inset, so the two read as one piece.
        <div className="group/mn mx-4 -mb-px">
          <div key={shown.n} className="relative flex items-center gap-2.5 overflow-hidden rounded-t-[14px] border border-b-0 border-black/[0.06] bg-card py-2 pr-2 pl-3.5 text-small dark:border-white/[0.07] dark:bg-[oklch(0.27_0_0)]">
            <m.icon className={cn('size-3.5 shrink-0', risky ? 'text-warn' : 'text-muted-foreground')} />
            <span className="min-w-0 flex-1 text-foreground/90">{MODE_TEXT[shown.mode]}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setShown(null)} className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:text-foreground">
              <XIcon className="size-3" />
            </button>
            <span aria-hidden onAnimationEnd={() => setShown(null)}
              className="mode-drain absolute inset-x-0 bottom-0 h-[2px] origin-left bg-foreground/30 group-hover/mn:[animation-play-state:paused]" />
          </div>
        </div>
      )}
    </Reveal>
  );
}

/** How quickly a second Esc has to follow the first to steer instead of stop. */
const ESC_DOUBLE_MS = 400;

/** Takes a queued message out of the queue and puts it back in the composer, text and images, to edit and send again. */
const editQueued = (q: QueuedMessage, store: Store) => {
  // Only if it was still waiting: one that already went out is in the transcript, not a draft to edit.
  store.unqueue(q.id).then((was) => { if (was) window.dispatchEvent(new CustomEvent<QueuedMessage>('canopy:edit-queued', { detail: q })); });
};

/** `grab`: with two or more waiting, the row's arrow turns into a grip under the pointer, and dragging it puts the
 *  messages in the order they go out. `dragging`: this is the row being moved. */
function QueuedRow({ q, busy, grab, dragging }: { q: QueuedMessage; busy: boolean; grab?: (e: React.PointerEvent) => void; dragging?: boolean }) {
  const store = useStore();
  const imgs = `${q.images.length} image${q.images.length > 1 ? 's' : ''}`;
  return (
    <div className={cn('group/q flex h-9 items-center gap-2 border-t border-hairline px-3 text-ui', dragging && 'bg-accent')}>
      {grab ? (
        <span onPointerDown={grab} title="Drag to change the order" aria-label="Drag to change the order"
          className="flex size-3.5 shrink-0 touch-none cursor-grab items-center justify-center text-faint hover:text-foreground active:cursor-grabbing">
          <CornerDownRightIcon className={cn('size-3.5', dragging ? 'hidden' : 'group-hover/q:hidden')} />
          <GripVerticalIcon className={cn('size-3.5', dragging ? 'block' : 'hidden group-hover/q:block')} />
        </span>
      ) : <CornerDownRightIcon className="size-3.5 shrink-0 text-faint" />}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={() => editQueued(q, store)}
            className="flex h-7 min-w-0 flex-1 items-center rounded-md px-1.5 text-left hover:bg-accent">
            <span className="truncate">{q.text || imgs}</span>
            {q.images.length > 0 && q.text && <span className="ml-1.5 shrink-0 text-small text-muted-foreground">+{imgs}</span>}
          </button>
        </TooltipTrigger>
        <TooltipContent>Edit in the message box</TooltipContent>
      </Tooltip>
      {busy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => store.steerQueued(q.id)}
              className="chip flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-small text-muted-foreground hover:bg-accent hover:text-foreground">
              <ArrowUpIcon className="size-3" />Steer
            </button>
          </TooltipTrigger>
          <TooltipContent>Send into the current turn now</TooltipContent>
        </Tooltip>
      )}
      <button type="button" aria-label="Remove from queue" onClick={() => store.unqueue(q.id)}
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground">
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** Approvals and questions rise out of the composer and fold back into it once answered.
 *  Each card keeps rendering through its exit (Reveal animates real height both ways). */
function AskTray({ pending }: { pending: PermissionItem[] }) {
  const [seen, setSeen] = useState<PermissionItem[]>(pending);
  useEffect(() => {
    setSeen((prev) => [...prev.filter((p) => !pending.some((q) => q.key === p.key)), ...pending]
      .sort((a, b) => a.at - b.at));
    const t = setTimeout(() => setSeen((prev) => prev.filter((p) => pending.some((q) => q.key === p.key))), 400);
    return () => clearTimeout(t);
  }, [pending]);
  if (!seen.length) return null;
  return (
    <div className="flex max-h-[55vh] flex-col overflow-y-auto">
      {seen.map((p) => (
        <Reveal key={p.key} show={pending.some((q) => q.key === p.key)} from="bottom" duration={300} appear>
          <div className="pb-3"><PermissionCard item={p} /></div>
        </Reveal>
      ))}
    </div>
  );
}

/** Messages waiting for the turn to end, docked on the composer's top edge. The tray and its rows fold in and out
 *  (Reveal animates real height), so queuing and draining never jump the transcript. */
const QueueTray = memo(function QueueTray({ queue, busy }: { queue: QueuedMessage[]; busy: boolean }) {
  const store = useStore();
  const open = queue.length > 0;
  // While the tray folds away it keeps the rows it held last: they ride out with it.
  const held = useRef(queue);
  if (open) held.current = queue;
  // A row being dragged shows at the place it would land; the rest close up around it.
  const [drag, setDrag] = useState<{ id: number; to: number } | null>(null);
  const live = (() => {
    const list = held.current;
    const i = drag ? list.findIndex((q) => q.id === drag.id) : -1;
    if (!drag || i < 0) return list;
    const out = list.slice(); const [m] = out.splice(i, 1); out.splice(drag.to, 0, m); return out;
  })();
  // Rows that left a tray that stays open keep rendering through their own exit, like the cards in AskTray, in the
  // place they had.
  const [seen, setSeen] = useState(held.current);
  const rows = live.slice();
  seen.forEach((s, i) => { if (!live.some((q) => q.id === s.id)) rows.splice(Math.min(i, rows.length), 0, s); });
  const listRef = useRef<HTMLDivElement>(null);
  // Every row is one height, so where the pointer is says the place: the rows' places are read once, as the drag starts.
  const grab = (id: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !listRef.current) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const from = held.current.findIndex((q) => q.id === id);
    const mids = [...listRef.current.querySelectorAll<HTMLElement>('[data-queued]')].map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
    let to = from;
    setDrag({ id, to });
    const move = (ev: PointerEvent) => {
      const at = mids.findIndex((m) => ev.clientY < m);
      const next = at < 0 ? mids.length - 1 : at;
      if (next !== to) { to = next; setDrag({ id, to }); }
    };
    const end = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
      setDrag(null);
      if (to !== from) void store.moveQueued(id, to);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  };
  useEffect(() => {
    if (seen === queue) return; // just mounted: nothing has left yet
    setSeen(rows);
    const t = setTimeout(() => { if (!queue.length) held.current = queue; setSeen(queue); }, 260);
    return () => clearTimeout(t);
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Reveal show={open} from="bottom" duration={200}>
      <div inert={!open} className="mx-4 -mb-px overflow-hidden rounded-t-xl border border-b-0 bg-muted">
        <div className="flex h-7 items-center px-3 text-small text-muted-foreground">
          {busy ? 'Sends when Canopy finishes' : 'Sending next'}
        </div>
        <div ref={listRef} className="max-h-[30vh] overflow-y-auto">
          {rows.map((q) => (
            // A row that joins an open tray folds in; the rows a tray opens with arrive with the tray itself.
            <Reveal key={q.id} show={live.includes(q)} from="bottom" duration={200} appear={seen.length > 0 && !seen.some((s) => s.id === q.id)}>
              <div data-queued={live.includes(q) || undefined}>
                <QueuedRow q={q} busy={busy} grab={held.current.length > 1 && open ? grab(q.id) : undefined} dragging={drag?.id === q.id} />
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Reveal>
  );
});

type AcItem = { label: string; desc: string; insert: string };
// Canopy's own commands (lib/commands.ts), listed in the "/" menu beside the chat's own (Claude Code's, or the ones
// an OpenAI chat reports: /compact, /review, /goal). Code Mode is Claude Code's, so only a Claude chat lists it.
const OWN_COMMANDS = [{ name: 'codemode', description: 'Turn Code Mode on or off for new chats: many tool calls from one script', argumentHint: '[on|off]' }];
type Ac = { items: AcItem[]; sel: number; start: number; end: number };
const MENU_MAX = 288; // the menu's tallest, in px (was max-h-72)

/** "/" commands and "@" files, floating above the composer. Focus stays in the textarea, which points at the
 *  highlighted row through aria-activedescendant; rows are picked on mousedown so they never take focus. */
function AcMenu({ id, ac, onPick, onHover }: { id: string; ac: Ac; onPick: (i: number) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  // Chromium also fires pointer events when rows appear or scroll under a resting pointer. Only a pointer that
  // really moved may take the selection, so the first event after opening just records where it is.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hovered = useRef(-1);

  // Keep the keyboard selection in view. A hovered row is already under the pointer, so it never scrolls.
  // Scrolls the list itself: scrollIntoView would also shift any clipped ancestor.
  useLayoutEffect(() => {
    const byPointer = hovered.current === ac.sel;
    hovered.current = -1;
    const el = list.current;
    const row = el?.children[ac.sel] as HTMLElement | undefined;
    if (byPointer || !el || !row) return;
    const top = row.offsetTop - 4, bottom = row.offsetTop + row.offsetHeight + 4; // keep the list's p-1 around it
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [ac]);

  // Opens above the box, unless there isn't room: in a new chat the box sits mid-window, and a full list above it ran
  // under the title bar with its first rows cut off. Room is measured inside every ancestor that clips (the pane,
  // the window), then the menu takes the side with more of it and is never taller than that side allows.
  const [fit, setFit] = useState<{ side: 'top' | 'bottom'; max: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = list.current;
      const box = el?.offsetParent;
      if (!el || !box) return;
      let top = 0, bottom = window.innerHeight;
      for (let a = box.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
        const r = a.getBoundingClientRect();
        top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom);
      }
      const r = box.getBoundingClientRect();
      const above = r.top - top - 16, below = bottom - r.bottom - 16; // mb-2 / mt-2 and a margin at the edge
      const want = Math.min(MENU_MAX, el.scrollHeight + 2); // + its border
      const side = above >= want || above >= below ? 'top' : 'bottom';
      const max = Math.max(64, Math.min(MENU_MAX, side === 'top' ? above : below));
      setFit((f) => (f && f.side === side && f.max === max ? f : { side, max }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ac.items.length]);

  return (
    <div ref={list} id={id} role="listbox" aria-label="Suggestions" data-side={fit?.side ?? 'top'} onMouseDown={(e) => e.preventDefault()}
      style={{ maxHeight: fit?.max ?? MENU_MAX }}
      className={cn('menu-pop absolute inset-x-0 z-20 cursor-default overflow-y-auto rounded-[10px] border bg-popover p-1 elev-pop',
        fit?.side === 'bottom' ? 'top-full mt-2 origin-top' : 'bottom-full mb-2 origin-bottom')}>
      {ac.items.map((it, i) => (
        <button key={it.label} id={`${id}-${i}`} type="button" role="option" aria-selected={i === ac.sel} tabIndex={-1}
          onMouseDown={(e) => { if (e.button === 0) onPick(i); }}
          onPointerMove={(e) => {
            const was = pointer.current;
            if (was && was.x === e.clientX && was.y === e.clientY) return;
            pointer.current = { x: e.clientX, y: e.clientY };
            if (was && i !== ac.sel) { hovered.current = i; onHover(i); }
          }}
          className={cn('flex h-8 w-full items-center gap-3 rounded-md px-4 text-left', i === ac.sel && 'bg-accent')}>
          <span className="shrink-0 font-mono text-code">{it.label}</span>
          {it.desc && <span className="truncate text-small text-muted-foreground">{it.desc}</span>}
        </button>
      ))}
    </div>
  );
}

// Thumbnail URL and list key for an attachment, made once. Rebuilding a data: URL from megabytes of base64 on
// every render (each keystroke, each streamed frame) made typing stutter. Dropped and pasted files get an object
// URL; picker results only arrive as base64, so theirs is a data URL built on first use. Kept beside the
// attachment, not on it: the attachment itself goes to the engine as is.
const previews = new WeakMap<ImageAttachment, { id: string; url: string }>();
let previewSeq = 0;
function previewOf(im: ImageAttachment, file?: File) {
  let p = previews.get(im);
  if (!p) previews.set(im, p = { id: `img-${++previewSeq}`, url: file ? URL.createObjectURL(file) : `data:${im.mediaType};base64,${im.data}` });
  return p;
}
/** Lets go of the previews once their attachments leave the composer (removed, sent, or the draft is gone). */
function release(ims: ImageAttachment[]) {
  for (const im of ims) {
    const url = previews.get(im)?.url;
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    previews.delete(im);
  }
}

/** One attached image. Memo'd with stable props, so typing and streaming never re-render it. */
const Thumb = memo(function Thumb({ im, label, onRemove, onOpen }: { im: ImageAttachment; label: string; onRemove: (im: ImageAttachment) => void; onOpen: () => void }) {
  return (
    <div role="button" tabIndex={0} aria-label={`View ${label}`} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="group relative size-20 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted enter-fade [animation-duration:160ms]">
      <img src={previewOf(im).url} className="size-full object-cover" alt={label} decoding="async" draggable={false} />
      <button type="button" aria-label={`Remove ${label}`} onClick={(e) => { e.stopPropagation(); onRemove(im); }}
        className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity duration-120 ease-out hover:bg-black/85 group-hover:opacity-100 focus-visible:opacity-100">
        <XIcon className="size-3" />
      </button>
    </div>
  );
});

// Long pastes become a card instead of flooding the box, like Claude Code's "[Pasted text +42 lines]" and ChatGPT's
// pasted-text attachment. On send, the text goes to Claude in full, after what you typed.
const PASTE_CHARS = 1000;
// What can attach as a picture: the kinds Claude and Codex take, under the size main's + uses (src/main.mjs). Anything
// else, an SVG or HEIC or a huge PNG, is mentioned by its path instead.
const DROP_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_DROP_IMAGE = Math.floor(5 * 1024 * 1024 * 3 / 4);
const PASTE_LINES = 12;
export type Paste = { id: string; text: string };
let pasteSeq = 0;
const newPaste = (text: string): Paste => ({ id: `paste-${Date.now().toString(36)}-${++pasteSeq}`, text });
const linesOf = (t: string) => t.split('\n').length;

/** Pasted text kept with each chat's draft (same day-long expiry as typed drafts). Very large pastes aren't saved. */
const draftPastes = (() => {
  const KEY = 'canopy.draft-pastes';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const MAX_SAVED = 1_000_000; // characters across all drafts; localStorage is small
  let map: Record<string, { p: string[]; at: number }> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const now = Date.now();
    for (const [k, v] of Object.entries(raw as typeof map)) if (Array.isArray(v?.p) && now - v.at < MAX_AGE) map[k] = v;
  } catch { map = {}; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => {
    const size = Object.values(map).reduce((n, v) => n + v.p.reduce((m, t) => m + t.length, 0), 0);
    try { if (size <= MAX_SAVED) localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* full */ }
  }, 300); };
  return {
    get: (k: string): Paste[] => (map[k]?.p ?? []).map(newPaste),
    set: (k: string, ps: Paste[]) => { if (ps.length) map[k] = { p: ps.map((x) => x.text), at: Date.now() }; else if (map[k]) delete map[k]; else return; save(); },
  };
})();

/** Files attached to each chat's draft, by path (same day-long expiry as typed drafts). */
const draftFiles = (() => {
  const KEY = 'canopy.draft-files';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  let map: Record<string, { f: string[]; at: number }> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const now = Date.now();
    for (const [k, v] of Object.entries(raw as typeof map)) if (Array.isArray(v?.f) && now - v.at < MAX_AGE) map[k] = v;
  } catch { map = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* full */ } };
  return {
    get: (k: string): string[] => [...(map[k]?.f ?? [])],
    set: (k: string, fs: string[]) => { if (fs.length) map[k] = { f: fs, at: Date.now() }; else if (map[k]) delete map[k]; else return; save(); },
  };
})();

/** One long paste, as a card beside the image thumbnails: its first lines, and how long it is. Click to read it. */
function PasteCard({ paste, onRemove, onOpen }: { paste: Paste; onRemove: () => void; onOpen: () => void }) {
  const n = linesOf(paste.text);
  return (
    <div role="button" tabIndex={0} aria-label="View pasted text" onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{ width: 184 }} className="group relative flex h-20 min-w-0 shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-muted/60 px-2.5 pt-2 pb-1.5 text-left enter-fade [animation-duration:160ms] hover:bg-muted">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden font-mono whitespace-pre text-muted-foreground" style={{ fontSize: 10, lineHeight: '13px' }}>{paste.text.slice(0, 300)}</div>
      <span className="mt-1 shrink-0 text-[11px] font-medium text-faint">Pasted · {n > 1 ? `${n.toLocaleString()} lines` : `${paste.text.length.toLocaleString()} chars`}</span>
      <button type="button" aria-label="Remove pasted text" onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity duration-120 ease-out hover:bg-black/85 group-hover:opacity-100 focus-visible:opacity-100">
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/** The full pasted text, centered on the window. "Edit in message" puts it back into the box as plain text. */
function PasteViewer({ paste, onClose, onInline }: { paste: Paste | null; onClose: () => void; onInline: (p: Paste) => void }) {
  return (
    <Dialog open={!!paste} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent style={{ width: 'min(760px, 90vw)', maxWidth: 'none' }} className="flex max-h-[80vh] flex-col gap-3 p-5">
        <DialogTitle className="text-ui font-semibold">Pasted text <span className="ml-1 font-normal text-faint">{paste ? `${linesOf(paste.text).toLocaleString()} lines · ${paste.text.length.toLocaleString()} characters` : ''}</span></DialogTitle>
        <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-hairline bg-background/60 p-3 font-mono text-code leading-relaxed whitespace-pre-wrap break-words text-foreground/85">{paste?.text}</pre>
        <div className="flex justify-end">
          <button type="button" onClick={() => paste && onInline(paste)} className="h-8 rounded-full px-3.5 text-small font-medium text-muted-foreground hover:bg-accent hover:text-foreground">Edit in message</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// FLIP hand-off: the hero composer records where it was when it sent, and the docked composer that mounts
// next slides up from there (transform only). A rect older than 1.5s means the screen never switched; ignore it.
let heroRect: DOMRect | null = null;
let heroAt = 0;

/** Unsent drafts per chat, saved across restarts (localStorage, written at most every 300ms). */
const drafts = (() => {
  // Each draft remembers when it was last edited; ones untouched for a day are dropped when Canopy opens, so
  // abandoned drafts don't pile up. (Older saves were plain strings: they count as fresh.)
  const KEY = 'canopy.drafts';
  const MAX_AGE = 24 * 60 * 60 * 1000; // a day
  type Entry = { t: string; at: number };
  let map: Record<string, Entry> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string | Entry>;
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      const e = typeof v === 'string' ? { t: v, at: now } : v;
      if (e?.t && now - e.at < MAX_AGE) map[k] = e;
    }
  } catch { map = {}; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* full */ } }, 300); };
  save(); // write back without the expired ones
  return {
    get: (k: string) => map[k]?.t ?? '',
    set: (k: string, v: string) => { if ((map[k]?.t ?? '') === v) return; if (v) map[k] = { t: v, at: Date.now() }; else delete map[k]; save(); },
  };
})();

// Everything you've sent from Canopy, newest first (the last 200), for Up-arrow recall across chats.
const SENT_KEY = 'canopy.sent';
function sentPrompts(): string[] {
  try { const v = JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function rememberPrompt(text: string) {
  const t = text.trim();
  if (!t) return;
  try { localStorage.setItem(SENT_KEY, JSON.stringify([t, ...sentPrompts().filter((x) => x !== t)].slice(0, 200))); } catch { /* full: skip */ }
}

export function Composer({ files, hero = false, placeholder, cwd }: { files: string[] | null; hero?: boolean; placeholder?: string; cwd?: string | null }) {
  const store = useStore();
  const { meta, items } = store;
  // Multi mode: only the focused pane's box takes window-wide keys and events (Esc Esc, prefill, focus requests).
  const pane = usePane();
  const focusedRef = useRef(pane.focused);
  focusedRef.current = pane.focused;
  // Each chat keeps its own draft (and it survives restarts): switching chats swaps what's in the box.
  const draftKey = meta.sessionId ? `s:${meta.sessionId}` : `new:${cwd ?? ''}`;
  const [text, setText] = useState(() => drafts.get(draftKey));
  const [pastes, setPastes] = useState<Paste[]>(() => draftPastes.get(draftKey));
  const [reading, setReading] = useState<Paste | null>(null);
  useEffect(() => { draftPastes.set(keyRef.current, pastes); }, [pastes]); // eslint-disable-line react-hooks/exhaustive-deps
  // Attached files (a PDF, a spreadsheet…), by path: cards in the box, @mentions once sent (lib/file-mentions).
  const [fileCards, setFileCards] = useState<string[]>(() => draftFiles.get(draftKey));
  useEffect(() => { draftFiles.set(keyRef.current, fileCards); }, [fileCards]); // eslint-disable-line react-hooks/exhaustive-deps
  const attachFiles = (paths: string[]) => { if (paths.length) setFileCards((cur) => [...cur, ...paths.filter((p) => !cur.includes(p))]); };
  const keyRef = useRef(draftKey);
  // Attached images are part of the draft too, kept in IndexedDB (they can be megabytes). They load async, so a
  // key's images are only saved once its load has landed (loadedKey): saving the empty box first would wipe them.
  // Each load gets a number; a newer load, a chat switch or a send makes a late one stale, so it never lands on top
  // of what's in the box now. Anything attached while a load was in flight stays, after the saved images.
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const loadedKey = useRef<string | null>(null);
  const loadSeq = useRef(0);
  const loadImages = useCallback((from: string, to: string) => {
    const seq = ++loadSeq.current;
    void draftAttachments.get(from).then((saved) => {
      if (seq !== loadSeq.current || keyRef.current !== to) return;
      if (from !== to) void draftAttachments.delete(from); // carried over to the chat's real key
      loadedKey.current = to;
      for (const im of saved) previewOf(im);
      setImages((cur) => [...saved, ...cur]); // always a new list, so the save below runs for the merged result
    });
  }, []);
  useEffect(() => { loadImages(keyRef.current, keyRef.current); }, [loadImages]);
  useEffect(() => {
    if (keyRef.current === draftKey) return;
    // A new chat that just got its id keeps what's typed and attached (it's the same chat); anything else loads its own draft.
    const prev = keyRef.current;
    const sameChat = prev.startsWith('new:') && draftKey.startsWith('s:');
    keyRef.current = draftKey;
    if (sameChat) {
      drafts.set(draftKey, text);
      draftPastes.set(draftKey, pastes);
      draftPastes.set(prev, []);
      draftFiles.set(draftKey, fileCards);
      draftFiles.set(prev, []);
      if (loadedKey.current === prev) {
        ++loadSeq.current;
        loadedKey.current = draftKey;
        void draftAttachments.set(draftKey, images);
        void draftAttachments.delete(prev);
      } else loadImages(prev, draftKey);
    } else {
      setText(drafts.get(draftKey));
      setPastes(draftPastes.get(draftKey));
      setFileCards(draftFiles.get(draftKey));
      release(images);
      setImages([]);
      loadedKey.current = null;
      loadImages(draftKey, draftKey);
    }
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { drafts.set(keyRef.current, text); }, [text]);
  useEffect(() => {
    if (loadedKey.current === keyRef.current) void draftAttachments.set(keyRef.current, images);
  }, [images]);
  const [ac, setAc] = useState<Ac | null>(null);
  const [drag, setDrag] = useState(false);
  const [stopTip, setStopTip] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null); // an attached image open full size
  // While Claude works: Esc stops it. Esc Esc (a quick double press) steers instead: what's in the box, or else the
  // next queued message, goes into the running turn now. With nothing to steer, one Esc stops at once; otherwise
  // the stop waits out the double-press window. Works wherever focus is; menus, dialogs and the terminal keep their own Esc.
  const steerRef = useRef<(() => void) | null>(null); // set each render, once send() exists: null when there's nothing to steer
  useEffect(() => {
    if (!meta.busy) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat || !focusedRef.current) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return;
      if ((e.target as HTMLElement | null)?.closest('.xterm')) return;
      if (ui.get().inspector) return; // the right panel is open: Esc closes it (App.tsx), it doesn't stop Claude
      e.preventDefault();
      if (timer) { clearTimeout(timer); timer = undefined; steerRef.current?.(); return; }
      if (!steerRef.current) { store.interrupt(); return; }
      timer = setTimeout(() => { timer = undefined; store.interrupt(); }, ESC_DOUBLE_MS);
    };
    window.addEventListener('keydown', on);
    return () => { window.removeEventListener('keydown', on); clearTimeout(timer); };
  }, [meta.busy]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const under = useRef<HTMLDivElement>(null); // draws the text when a command at the start is shown in bold
  // The command the message starts with, if it is one Canopy or Claude Code knows (shown in bold).
  const cmdMatch = /^\/([\w:-]+)/.exec(text);
  const cmd = cmdMatch && [...meta.commands, ...OWN_COMMANDS].some((c) => c.name.toLowerCase() === cmdMatch[1].toLowerCase()) ? cmdMatch[0] : null;
  const hist = useRef<{ list: string[]; at: number; draft: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const depth = useRef(0); // dragenter/dragleave fire for every child; count them so the outline doesn't flicker
  const acId = useId();
  const pending = items.filter((i): i is PermissionItem => i.t === 'permission' && !i.resolved);

  const removeImage = useCallback((im: ImageAttachment) => { release([im]); setImages((x) => x.filter((y) => y !== im)); }, []);
  const attached = useRef(images);
  attached.current = images;
  useEffect(() => () => release(attached.current), []); // a draft that goes away with its images still attached

  // The same chat can have a cached composer in the other layout. Pick up edits made there when returning.
  const previousPane = useRef({ focused: pane.focused, draftKey });
  useEffect(() => {
    const previous = previousPane.current;
    previousPane.current = { focused: pane.focused, draftKey };
    if (!pane.focused || previous.focused || previous.draftKey !== draftKey) return;
    setText(drafts.get(draftKey));
    setPastes(draftPastes.get(draftKey));
    setFileCards(draftFiles.get(draftKey));
    setAc(null);
    hist.current = null;
    release(attached.current);
    loadedKey.current = null;
    setImages([]);
    loadImages(draftKey, draftKey);
  }, [pane.focused, draftKey, loadImages]);

  useEffect(() => { if (focusedRef.current) ta.current?.focus(); }, [meta.sessionId]);
  // A pane that gets focus puts the cursor in its box (unless you clicked into something else in it).
  useEffect(() => {
    if (!pane.multi || !pane.focused) return;
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body || !box.current?.closest('[data-pane]')?.contains(a)) ta.current?.focus({ preventScroll: true });
  }, [pane.multi, pane.focused]);
  useEffect(() => {
    const onFocus = () => { if (focusedRef.current) ta.current?.focus(); };
    const onPrefill = (e: Event) => { if (!focusedRef.current) return; const t = (e as CustomEvent<string>).detail; setText(t); updateAcRef.current(t, t.length); ta.current?.focus(); };
    // A queued message taken back to edit: it goes first, and anything already typed or attached stays after it.
    const onEditQueued = (e: Event) => {
      if (!focusedRef.current) return;
      const q = (e as CustomEvent<QueuedMessage>).detail;
      const back = splitFiles(q.text);
      const end = back.text.length;
      hist.current = null;
      setText((cur) => (cur.trim() ? `${back.text}\n\n${cur}` : back.text));
      attachFiles(back.files);
      if (q.images.length) setImages((cur) => [...q.images, ...cur]);
      setAc(null);
      requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(end, end); });
    };
    window.addEventListener('canopy:focus-composer', onFocus);
    window.addEventListener('canopy:prefill', onPrefill);
    window.addEventListener('canopy:edit-queued', onEditQueued);
    return () => {
      window.removeEventListener('canopy:focus-composer', onFocus); window.removeEventListener('canopy:prefill', onPrefill);
      window.removeEventListener('canopy:edit-queued', onEditQueued);
    };
  }, []);

  useLayoutEffect(() => {
    if (hero || !heroRect || !box.current) return;
    const from = heroRect; heroRect = null;
    if (performance.now() - heroAt > 1500) return;
    const dy = from.top - box.current.getBoundingClientRect().top;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(dy) < 2) return;
    box.current.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.32,0.72,0,1)' });
  }, []);

  const hasContent = text.trim().length > 0 || images.length > 0 || pastes.length > 0 || fileCards.length > 0;
  const stopMode = meta.busy && !hasContent;
  // This chat's account needs you (signed out, say): the row above the box says so, and nothing is sent meanwhile.
  const blocked = !!useChatTrouble().trouble;
  const held = blocked && !text.trim().startsWith('/'); // a command of Canopy's own (/login, /model…) still runs
  // Another app has this chat open (lib/held): it can be read here, and one line stands where the box would be.
  const elsewhere = useHeld(meta.engine === 'codex' ? meta.sessionId : null);
  const showSuggestion = !!meta.suggestion && !text && pending.length === 0;
  // A plan is waiting in the chat (its card is there, not in the tray): what you send now is your feedback on it.
  const planWaits = pending.some(isPlan);
  const ph = showSuggestion ? meta.suggestion! : planWaits ? 'What should change?' : placeholder ?? (meta.busy ? 'Add a follow-up' : items.some((i) => i.t === 'user') ? 'Reply to Canopy' : 'Ask anything');

  // While Claude works, sending queues the message for after the turn. Steering is a button on the queued row.
  /** Enter sends (queued while Claude works). ⌘Enter while Claude works steers: it goes in right now, mid-turn. */
  function send(steer = false) {
    if (!hasContent) return;
    if (held) return; // what you typed stays, and goes once the account works again
    rememberPrompt(text);
    hist.current = null;
    // Interactive Claude Code commands (/model, /config…) are handled natively instead of being sent.
    if (text.trim().startsWith('/') && runCommand(text, { cwd: cwd ?? null, store })) {
      feature('slash_command');
      setText(''); setAc(null);
      return;
    }
    if (blocked) return; // not one of Canopy's own after all: it would go to Claude Code, so it waits too
    if (cmd) feature('slash_command');
    const typed = /^\/plan\s+/i.test(text.trim()) ? text.trim().replace(/^\/plan\s+/i, '') : text;
    // Long pastes go in full, after what you typed (what you typed usually introduces them: "fix this:").
    // Attached files go last, as one paragraph of @mentions: Claude Code and Codex read them from disk.
    const outgoing = withFiles([typed.trim() ? typed : '', ...pastes.map((p) => p.text)].filter(Boolean).join('\n\n'), fileCards, cwd);
    if (hero) { heroRect = box.current?.getBoundingClientRect() ?? null; heroAt = performance.now(); }
    // A plan was waiting: these words keep planning. In a Claude chat they went as the plan's answer (nothing more to send).
    if (keepPlanning(store, outgoing, images)) { /* sent */ }
    else if (steer && meta.busy) store.dispatch(outgoing, images, true);
    else if (meta.busy || meta.queue.length) store.enqueue(outgoing, images);
    else store.dispatch(outgoing, images);
    release(images);
    // Sent: the stored images go too, and a load still in flight for this chat must not bring them back.
    ++loadSeq.current;
    loadedKey.current = keyRef.current;
    void draftAttachments.delete(keyRef.current);
    setText(''); setImages([]); setPastes([]); setFileCards([]); setAc(null);
  }

  steerRef.current = hasContent ? () => send(true) : meta.queue[0] ? () => void store.steerQueued(meta.queue[0].id) : null;

  function updateAc(value: string, pos: number) {
    const before = value.slice(0, pos);
    const slash = before.match(/^\/(\S*)$/);
    const at = before.match(/(^|\s)@(\S*)$/);
    let list: AcItem[] = [];
    let start = 0;
    if (slash) {
      const q = slash[1].toLowerCase();
      // The chat's own commands, whichever maker runs it. Canopy's own are Claude Code features so far: an OpenAI chat lists none of them.
      list = [...meta.commands, ...(meta.engine === 'codex' ? [] : OWN_COMMANDS.filter((c) => !meta.commands.some((m) => m.name === c.name)))]
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q) || a.name.length - b.name.length)
        .slice(0, 60)
        .map((c) => ({ label: `/${c.name}`, desc: c.description || c.argumentHint || '', insert: `/${c.name} ` }));
    } else if (at && files) {
      const q = at[2].toLowerCase();
      start = pos - at[2].length - 1;
      list = files.filter((f) => f.toLowerCase().includes(q)).sort((a, b) => a.length - b.length).slice(0, 60)
        .map((f) => ({ label: f, desc: '', insert: `@${f} ` }));
    }
    setAc(list.length ? { items: list, sel: 0, start, end: pos } : null);
  }

  const updateAcRef = useRef(updateAc);
  updateAcRef.current = updateAc; // the prefill listener is registered once; always use the latest commands/files

  function pick(i: number) {
    if (!ac) return;
    const it = ac.items[i];
    if (it.insert.startsWith('@')) feature('file_mentioned');
    const next = text.slice(0, ac.start) + it.insert + text.slice(ac.end);
    setText(next); setAc(null);
    const p = ac.start + it.insert.length;
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(p, p); });
  }

  /** Up/Down through what you sent before, like the terminal: this chat's messages first (newest first), then the
   *  rest of what you've sent in Canopy. Up only when the caret is on the first line, Down only on the last, so moving
   *  around a multi-line message still works. Down past the newest brings back what you were typing. */
  function browse(dir: -1 | 1, e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || el.selectionStart !== el.selectionEnd) return false;
    if (dir === -1 && text.slice(0, el.selectionStart).includes('\n')) return false;
    if (dir === 1 && (!hist.current || text.slice(el.selectionEnd).includes('\n'))) return false;
    if (!hist.current) {
      const mine = items.filter((i): i is Extract<typeof i, { t: 'user' }> => i.t === 'user').map((i) => i.text.trim()).filter(Boolean).reverse();
      const list = [...new Set([...mine, ...sentPrompts()])];
      if (!list.length) return false;
      hist.current = { list, at: -1, draft: text };
    }
    const h = hist.current;
    const at = h.at - dir; // Up goes further back (higher index)
    if (at >= h.list.length) return true; // the oldest: stay
    e.preventDefault();
    h.at = at;
    const next = at < 0 ? h.draft : h.list[at];
    if (at < 0) hist.current = null;
    setText(next);
    // Like the terminal: the caret lands at the end of the recalled message.
    requestAnimationFrame(() => { const t = ta.current; if (t) t.setSelectionRange(next.length, next.length); });
    return true;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (composing(e)) return;
    if (!ac && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && browse(e.key === 'ArrowUp' ? -1 : 1, e)) return;
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAc({ ...ac, sel: (ac.sel + 1) % ac.items.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAc({ ...ac, sel: (ac.sel - 1 + ac.items.length) % ac.items.length }); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        // Enter on an exact match runs it right away (like Claude Code), otherwise complete it.
        if (e.key === 'Enter' && text.trim() === ac.items[ac.sel].insert.trim()) { setAc(null); send(); } else pick(ac.sel);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setAc(null); return; }
    }
    if (e.key === 'Tab' && !e.shiftKey && showSuggestion) { e.preventDefault(); setText(meta.suggestion!); store.setMeta({ suggestion: null }); return; }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const cycle = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
      const i = cycle.indexOf(meta.mode ?? 'default');
      setMode(cycle[(i + 1) % cycle.length], store);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.metaKey || e.ctrlKey); }
    // Esc while working is handled window-wide (Esc stops, Esc Esc steers), above.
  }

  // Images attach as pictures. Any other file (a PDF, a spreadsheet, a folder…) attaches as a card, and goes as an
  // @mention of its path so Claude or Codex reads it from disk, as with +. A picture too big to attach is a card too.
  /** `how`: dropped on the box or copied in Finder (an attachment added), or a picture pasted into it. */
  function addFiles(list: FileList | File[], how: 'attachment_added' | 'image_pasted' = 'attachment_added') {
    const all = Array.from(list);
    const isImage = (f: File) => DROP_IMAGE_TYPES.has(f.type) && f.size <= MAX_DROP_IMAGE;
    const paths = all.filter((f) => !isImage(f)).map((f) => api.pathForFile?.(f) ?? null);
    if (paths.some((p) => !p)) toast('Some of those can only be added with +.');
    const found = paths.filter((p): p is string => !!p);
    if (found.length || all.some(isImage)) feature(how); // once per drop or paste, and only when something was attached
    attachFiles(found);
    for (const f of all) {
      if (!isImage(f)) continue;
      const r = new FileReader();
      r.onload = () => {
        const im: ImageAttachment = { mediaType: f.type, data: String(r.result).split(',')[1] };
        if (f.name && f.name !== 'image.png') im.name = f.name; // a pasted bitmap has no name of its own; its thumbnail labels it
        previewOf(im, f);
        setImages((cur) => [...cur, im]);
      };
      r.readAsDataURL(f);
    }
  }

  // Files can be dropped anywhere in the window, not only on the box: the chat's own pane takes them (with two chats
  // side by side, the one under the pointer), and elsewhere (the sidebar, the title bar) the chat in focus does. While
  // files are dragged over the window, the box that will take them shows a dashed outline. Dragging rows in the sidebar
  // carries no files and is left alone.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const mine = (e: DragEvent) => {
      const at = (e.target as Element | null)?.closest?.('[data-pane]');
      const own = box.current?.closest('[data-pane]');
      return at && own ? at === own : focusedRef.current;
    };
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current++; setDrag(mine(e)); };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // without it the drop would open the file in place of Canopy
      const m = mine(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = m ? 'copy' : 'none';
      setDrag(m);
    };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth.current <= 0) { depth.current = 0; setDrag(false); } };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDrag(false);
      if (mine(e) && e.dataTransfer) { addFilesRef.current(e.dataTransfer.files); ta.current?.focus(); }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop);
    };
  }, []);

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Files copied in Finder that are not pictures (a PDF…) paste as mentions, as they drop.
    const others = Array.from(e.clipboardData.files).filter((f) => !DROP_IMAGE_TYPES.has(f.type));
    const otherPaths = others.map((f) => api.pathForFile?.(f) ?? null).filter((p): p is string => !!p);
    if (otherPaths.length) { e.preventDefault(); addFiles(Array.from(e.clipboardData.files)); return; }
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) {
      // A long paste becomes a card. Short ones go in as text, as usual.
      const t = e.clipboardData.getData('text/plain');
      if (t.length >= PASTE_CHARS || linesOf(t) >= PASTE_LINES) {
        e.preventDefault();
        setPastes((cur) => [...cur, newPaste(t)]);
      }
      return;
    }
    // Editors and spreadsheets (Word, Excel…) put a rendered picture beside the text they copy: rich text with an
    // image is a text paste. Plain text alone beside an image is only its label (Finder's file name, Safari's image
    // address), so that one attaches the picture.
    const rich = e.clipboardData.types.some((t) => t === 'text/html' || t === 'text/rtf');
    if (rich && e.clipboardData.getData('text/plain').trim()) return;
    e.preventDefault();
    addFiles(imgs, 'image_pasted');
  }

  // Open in another app: nothing can be sent from here until it is closed there, so there is no box, only why.
  // Main says when that changes (lib/held), and the box comes back by itself, with whatever was typed in it.
  if (elsewhere && !hero) {
    return (
      <div data-pad className="mx-auto w-full max-w-[calc(var(--col)+80px)] px-10 pb-5">
        <p role="status" data-held className="flex min-h-11 items-center justify-center text-center text-ui text-muted-foreground">{elsewhere.text}</p>
      </div>
    );
  }
  // Multi mode: a pane is small, so its box is one line (add, the words, mode, model, send) that grows only as you
  // write more than a line. One chat on screen keeps the roomy box, with its controls on a row of their own.
  const compact = pane.multi && !hero;
  const fieldSize = compact ? 'max-h-48 min-h-12 px-1.5 py-3' : cn('max-h-72 px-5 pt-5 pb-3', hero ? 'min-h-[104px]' : 'min-h-[88px]');
  const field = (
    <div className={cn('relative', compact && 'min-w-0 flex-1')}>
      {/* A command at the start (/goal, /model…) shows in bold. A textarea can't style part of its text, so the words
          are drawn by this layer underneath (same box, wrapping and scroll) while the textarea's own text goes
          clear; the bold is a stroke, not a heavier weight, so no letter moves and the cursor stays where it is. */}
      {cmd && (
        <div ref={under} aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap text-body text-foreground [overflow-wrap:break-word] [scrollbar-gutter:stable]', fieldSize)}>
          <span className="[-webkit-text-stroke:0.04em_currentColor]">{cmd}</span>{text.slice(cmd.length)}{'\u200b'}
        </div>
      )}
      <textarea
        ref={ta}
        onScroll={(e) => { if (under.current) under.current.scrollTop = e.currentTarget.scrollTop; }}
        value={text}
        rows={1}
        aria-autocomplete="list"
        aria-controls={ac ? acId : undefined}
        aria-activedescendant={ac ? `${acId}-${ac.sel}` : undefined}
        onChange={(e) => { hist.current = null; setText(e.target.value); updateAc(e.target.value, e.target.selectionStart); }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        // Focus went elsewhere in the window, so the menu goes too. Switching apps leaves focus here: it stays.
        onBlur={(e) => { if (document.activeElement !== e.currentTarget) setAc(null); }}
        placeholder={ph}
        className={cn('relative field-sizing-content block w-full resize-none overflow-y-auto bg-transparent text-body outline-none placeholder:text-faint [scrollbar-gutter:stable]',
          fieldSize, cmd && 'text-transparent caret-foreground selection:bg-foreground/20')}
      />
      {/* A suggestion (Claude Code's guess at your next message) shows as the placeholder; Tab still fills it in. */}
    </div>
  );
  const addButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="Add files or images" onMouseDown={(e) => e.preventDefault()} onClick={async () => {
            const r = await api.pickFiles(cwd ?? undefined);
            if (r.images?.length || r.paths?.length) feature('attachment_added');
            if (r.images?.length) setImages((im) => [...im, ...r.images]);
            attachFiles(r.paths ?? []);
            ta.current?.focus();
          }}
          className="chip press flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
          <PlusIcon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Add files or images</TooltipContent>
    </Tooltip>
  );
  const sendButton = (
    <>
      {/* One stable button so the icon can swap in place; its tooltip only ever opens in stop mode. */}
      <Tooltip open={stopMode && stopTip} onOpenChange={setStopTip}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn('press ml-1 flex size-8 shrink-0 items-center justify-center rounded-full',
              stopMode ? 'bg-foreground text-background hover:bg-foreground/85'
                : hasContent && !held ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-foreground/[0.06] text-faint')}
            disabled={stopMode ? false : !hasContent || held}
            onClick={() => (stopMode ? store.interrupt() : send())}
            aria-label={stopMode ? 'Stop' : meta.busy ? 'Send after this turn' : 'Send'}>
            <span key={stopMode ? 's' : 'a'} className="swap-in">
              {stopMode ? <SquareIcon className="size-3 fill-current" /> : <ArrowUpIcon className="size-4" />}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Stop <Kbd>Esc</Kbd></TooltipContent>
      </Tooltip>
    </>
  );
  // Centre on the reading column, with the box extending 16px past the transcript on either side.
  return (
    <div data-pad className={cn('mx-auto w-full max-w-[calc(var(--col)+80px)] shrink-0 px-6', compact ? 'pb-4' : !hero && 'pb-6')}>
      {/* Approvals first, so the queue always sits directly on the composer it is docked to. */}
      <AskTray pending={pending.filter((p) => !isPlan(p))} />
      <QueueTray queue={meta.queue} busy={meta.busy} />
      <AccountBlocker />
      <ModeNotice mode={meta.mode} />
      <div
        ref={box}
        data-drag={drag || undefined}
        className={cn('composer-box relative z-[1] cursor-text rounded-[22px] border border-black/[0.06] bg-card shadow-[0_6px_28px_-6px_rgb(0_0_0/0.10)] has-[textarea:focus]:shadow-[0_8px_32px_-6px_rgb(0_0_0/0.14)]',
          'dark:border-white/[0.07] dark:bg-[oklch(0.27_0_0)] dark:shadow-[0_8px_30px_-8px_rgb(0_0_0/0.5)]')}
        onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); ta.current?.focus(); } }}
      >
        {ac && <AcMenu id={acId} ac={ac} onPick={pick} onHover={(i) => setAc((a) => (a && a.sel !== i ? { ...a, sel: i } : a))} />}
        {(images.length > 0 || pastes.length > 0 || fileCards.length > 0) && (
          <div className="flex flex-wrap items-start gap-2 px-5 pt-5">
            <ImageViewer srcs={images.map((im) => previewOf(im).url)} index={viewing != null && viewing < images.length ? viewing : null} onIndex={setViewing} />
            {images.map((im, i) => <Thumb key={previewOf(im).id} im={im} label={im.name ?? `Pasted image ${i + 1}`} onRemove={removeImage} onOpen={() => setViewing(i)} />)}
            {fileCards.map((f) => <FileCard key={f} path={f} cwd={cwd} onRemove={() => setFileCards((cur) => cur.filter((x) => x !== f))} />)}
            {pastes.map((p) => <PasteCard key={p.id} paste={p} onOpen={() => setReading(p)} onRemove={() => setPastes((cur) => cur.filter((x) => x.id !== p.id))} />)}
          </div>
        )}
        <PasteViewer paste={reading} onClose={() => setReading(null)} onInline={(p) => {
          setReading(null);
          setPastes((cur) => cur.filter((x) => x.id !== p.id));
          setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${p.text}` : p.text));
          requestAnimationFrame(() => ta.current?.focus());
        }} />
        {compact ? (
          <div className="@container/box flex cursor-default items-end gap-1 px-2">
            <div className="flex h-12 shrink-0 items-center">{addButton}</div>
            {field}
            <div className="flex h-12 shrink-0 items-center gap-1">
              <Controls part="mode" />
              <ContextRing pct={meta.ctx} used={meta.ctxTokens} max={meta.ctxMax} />
              <Controls part="model" />
              {sendButton}
            </div>
          </div>
        ) : (
          <>
            {field}
            <div className="flex h-13 cursor-default items-center gap-1 px-3 pb-3">
              {addButton}
              <Controls part="mode" />
              <div className="flex-1" />
              <ContextRing pct={meta.ctx} used={meta.ctxTokens} max={meta.ctxMax} />
              <Controls part="model" />
              {sendButton}
            </div>
          </>
        )}
      </div>
      {/* This chat's agents and background commands: a drawer tucked under the box. */}
      <AgentsDrawer />
    </div>
  );
}

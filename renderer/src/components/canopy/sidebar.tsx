// Left sidebar: one layer, always laid out at 264px; App's wrapper animates its width between 264 and the 56px rail
// and clips it. Nothing moves: the logo, New Chat / Search icons and the avatar sit on the rail's centre line in both
// states, so collapsing just wipes the labels away (they fade first) and expanding reveals them (they fade in last).
// The scrolling list (projects, chats, recents) can't fit a rail, so a small rail block (add project, project
// folders) cross-fades in over it when collapsed. Timings live in index.css (.sb-label, .sb-edge, .sb-rail).
//
// Geometry: icon centre x 28 · label column x 48 · right content edge 16px from the sidebar edge.
import { setDraggedChat } from '@/lib/chat-drag';
import { useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import { ArchiveIcon, ArrowDownUpIcon, ArchiveRestoreIcon, HouseIcon, CircleDotIcon, CircleIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, GitBranchIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, SearchIcon, SettingsIcon, SquarePenIcon, XIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SessionSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useChatMark } from './chat-status';
import { Marquee } from './marquee';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { archive, unarchive, useArchived } from '@/lib/archive';
import { markRead, markUnread, useMarkedUnread } from '@/lib/unread';
import { useChatList, useChatStatus } from '@/lib/chats';
import { useHeld } from '@/lib/held';
import { pin, setPinnedOrder, unpin, usePinned } from '@/lib/pins';
import { arrange, clearChatOrder, setChatOrder, useChatOrders } from '@/lib/chat-order';
import { feature } from '@/lib/telemetry';
import { UpdateRailButton } from './update-toast';
import { SidebarCards } from './sidebar-cards';
import { Logo } from './logo';
import { previewParts } from '@/lib/preview-line';
import { Reveal } from './reveal';
import { Wordmark } from './wordmark';
import { projectName } from '@/lib/project-name';

import type { Project } from '@/lib/projects';

export type { Project };
export const SIDEBAR_FULL = 264;
export const SIDEBAR_RAIL = 56;

const PROJECT_CHATS = 5;
const RECENTS = 15;

type Props = {
  projects: Project[]; chats: Project | null; activeId: string | null; activeDir: string | null; account: { name: string; photo?: string | null }; healthy: boolean;
  collapsed: boolean;
  home: boolean; onHome: () => void;
  onNew: (dir?: string) => void; onSearch: () => void; onOpen: (dir: string, id: string) => void;
  onAddProject: () => void; onRemoveProject: (dir: string) => void; onReorderProjects?: (dirs: string[]) => void; onSettings: () => void;
};

const row = 'sb-row flex h-8 w-full items-center gap-3 rounded-md pr-2 pl-3 text-left text-ui text-foreground hover:bg-sidebar-hover';
/** "now", "5m", "3h", "Tue", "Nov 3": how long ago a chat was last active, short enough for a sidebar row. */
function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = new Date(t);
  return s < 6 * 86400 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const FOLDED_KEY = 'canopy.sidebar.folded';
const chatRow = 'relative flex h-9 w-full items-center overflow-hidden rounded-md px-2.5 text-left text-[14px] leading-5 text-foreground hover:bg-sidebar-hover';
const chatRow2 = 'relative flex w-full flex-col overflow-hidden rounded-md px-2.5 py-1.5 text-left text-foreground hover:bg-sidebar-hover';
/** Chat rows show only the title, one line at the project rows' height (36px, 14px text), and a working chat's title
 *  carries the green shimmer. Set true for a second line under each title, saying what the chat last did. */
const SECOND_LINE = false;
const chatRow1 = 'relative flex h-9 w-full flex-col justify-center overflow-hidden rounded-md px-2.5 text-left text-foreground hover:bg-sidebar-hover';
const moreToggle = 'flex h-8 items-center rounded-md px-2 text-small text-muted-foreground hover:text-foreground';
const hoverBtn = 'flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-hover hover:text-foreground';

const dirName = (dir: string) => projectName(dir);

function Avatar({ name, photo, healthy }: { name: string; photo?: string | null; healthy: boolean }) {
  const initials = (name || 'You').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  return (
    <span className="relative flex size-7 shrink-0">
      {/* The mask cuts a 1.5px moat around the health dot, so it reads on any sidebar tint (incl. vibrancy). */}
      {/* Your Google photo when you're signed in to Canopy; otherwise initials on Canopy's own green, flat (index.css .avatar-green). */}
      {photo
        ? <img src={photo} alt="" aria-hidden className={cn('size-7 shrink-0 rounded-full object-cover', !healthy && '[mask:radial-gradient(circle_at_calc(100%-3px)_calc(100%-3px),transparent_5.5px,#000_6px)]')} />
        : <span aria-hidden className={cn('avatar-green relative flex size-7 shrink-0 items-center justify-center rounded-full text-micro font-semibold tracking-[0.02em]', !healthy && '[mask:radial-gradient(circle_at_calc(100%-3px)_calc(100%-3px),transparent_5.5px,#000_6px)]')}>
            {initials}
          </span>}
      {!healthy && <span role="img" aria-label="Claude Code needs attention" className="absolute -right-px -bottom-px size-2 rounded-full bg-warn" />}
    </span>
  );
}

function HoverAction({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick} aria-label={label} className={cn(hoverBtn, className)}>{children}</button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type GitInfo = { branch: string | null; repo?: string | null };
/** How long a repo/branch answer counts as current: hover, focus and open inside this window share one lookup. */
const GIT_FRESH = 2000;

/** "…" on a project row: a card with what the project is, plus actions. */
function ProjectMenu({ dir, name, chats, git, open, onOpenChange, onNew, onRemove, onAutoSort }: { dir: string; name: string; chats: number; git: GitInfo | null; open: boolean; onOpenChange: (open: boolean) => void; onNew: () => void; onRemove: () => void; onAutoSort?: () => void }) {
  const home = (window as unknown as { __home?: string }).__home;
  const short = home && dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Lit from `open`, not data-[state=open]: the Tooltip trigger around this button overwrites its data-state. */}
          <DropdownMenuTrigger aria-label="Project options" className={cn(hoverBtn, open && 'bg-sidebar-hover text-foreground')}><MoreHorizontalIcon className="size-3.5" /></DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Project options</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={10} className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-1 text-ui font-medium"><FolderIcon className="size-4 text-muted-foreground" /><span className="truncate">{name}</span></div>
        <div className="flex items-center gap-2.5 px-2 py-1 text-small text-muted-foreground"><MessageSquareIcon className="size-4" />{chats === 1 ? '1 chat' : `${chats} chats`}</div>
        <DropdownMenuSeparator />
        {git?.repo && <div className="flex items-center gap-2.5 px-2 py-1 text-small text-muted-foreground"><GitBranchIcon className="size-4 shrink-0" /><span className="truncate">{git.repo}{git.branch ? ` · ${git.branch}` : ''}</span></div>}
        {git && !git.repo && git.branch && <div className="flex items-center gap-2.5 px-2 py-1 text-small text-muted-foreground"><GitBranchIcon className="size-4 shrink-0" /><span className="truncate">{git.branch}</span></div>}
        <DropdownMenuItem onSelect={() => { feature('reveal_in_finder'); api.reveal(dir); }} title={dir}><FolderOpenIcon /><span className="truncate">{short}</span></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onNew}><SquarePenIcon />New chat in {name}</DropdownMenuItem>
        {onAutoSort && <DropdownMenuItem onSelect={onAutoSort}><ArrowDownUpIcon />Sort by last message</DropdownMenuItem>}
        <DropdownMenuItem onSelect={onRemove}><XIcon />Remove from sidebar</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A project's header row: the fold toggle, plus "…" and new-chat controls that show on hover, on focus, and for as long as the menu is open. */
function ProjectRow({ dir, name, chats, open, active, alert, onToggle, onNew, onRemove, onAutoSort }: { dir: string; name: string; chats: number; open: boolean; active: boolean; alert?: boolean; onToggle: () => void; onNew: () => void; onRemove: () => void; onAutoSort?: () => void }) {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const asked = useRef(0);
  // Repo and branch for the menu. Looked up when the pointer or focus reaches the row, so the menu opens at its final
  // height instead of growing a row mid pop-in, and again on every open, so the branch shown is current. The last
  // answer stays up while a newer one loads, and only the newest lookup may write.
  const loadGit = () => {
    const at = Date.now();
    if (at - asked.current < GIT_FRESH) return;
    asked.current = at;
    api.gitInfo(dir).then((g) => { if (asked.current === at) setGit(g); }).catch(() => {});
  };
  const Icon = open ? FolderOpenIcon : FolderIcon;
  // An open menu sets pointer-events:none on <body> and takes focus, so the row loses :hover and :focus-within the
  // moment it opens. data-menu-open holds the hovered look, so the menu stays anchored to a visible "…".
  return (
    <div data-menu-open={menuOpen || undefined} onPointerEnter={loadGit} onFocus={loadGit}
      className="group relative flex h-9 items-center rounded-md hover:bg-sidebar-hover data-[menu-open]:bg-sidebar-hover">
      <button onClick={onToggle} aria-expanded={open}
        className="flex h-9 min-w-0 flex-1 items-center gap-3 pr-2 pl-3 text-left text-[14px] leading-5 group-hover:pr-16 group-focus-within:pr-16 group-data-[menu-open]:pr-16">
        <Icon className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {/* Folded with a chat inside that needs you: the same green dot, so nothing hides in a folder. */}
        {alert && <span role="img" aria-label="A chat in here needs you" className="mr-1.5 size-2 shrink-0 rounded-full bg-brand group-hover:hidden group-focus-within:hidden group-data-[menu-open]:hidden" />}
      </button>
      <div className="absolute inset-y-0 right-[3px] flex items-center gap-0.5 rounded-r-md opacity-0 transition-opacity duration-120 ease-out group-hover:opacity-100 group-focus-within:opacity-100 group-data-[menu-open]:opacity-100">
        <ProjectMenu dir={dir} name={name} chats={chats} git={git} open={menuOpen} onOpenChange={(o) => { setMenuOpen(o); if (o) loadGit(); }} onNew={onNew} onRemove={onRemove} onAutoSort={onAutoSort} />
        {/* The menu opens over this button, so it steps out while the menu is up: no sliver of it at the menu's edge. */}
        <HoverAction label={`New chat in ${name}`} onClick={onNew} className="group-data-[menu-open]:invisible"><SquarePenIcon className="size-3.5" /></HoverAction>
      </div>
    </div>
  );
}

function RailBtn({ label, kbd, active, onClick, children }: { label: string; kbd?: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick} aria-label={label} className={cn('flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', active && 'bg-sidebar-accent text-foreground')}>{children}</button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}{kbd && <Kbd>{kbd}</Kbd>}</TooltipContent>
    </Tooltip>
  );
}

/** Right-click on a chat: Pin, Rename, mark read or unread, and Archive (hides it from the sidebar, nothing is deleted) or Unarchive. */
function ChatMenu({ id, archived, pinned, onRename, children }: { id: string; archived?: boolean; pinned?: boolean; onRename: () => void; children: React.ReactNode }) {
  const marked = useMarkedUnread();
  const s = useChatStatus(id);
  const unread = marked.has(id) || !!s?.unread;
  // Rename starts once the menu has fully closed: until then it holds focus and would pull it out of the title field.
  const renameNext = useRef(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => { if (!renameNext.current) return; renameNext.current = false; e.preventDefault(); onRename(); }}>
        {!archived && (pinned
          ? <ContextMenuItem onSelect={() => unpin(id)}><PinOffIcon />Unpin</ContextMenuItem>
          : <ContextMenuItem onSelect={() => pin(id)}><PinIcon />Pin</ContextMenuItem>)}
        <ContextMenuItem onSelect={() => { renameNext.current = true; }}><PencilIcon />Rename</ContextMenuItem>
        {!archived && (unread
          ? <ContextMenuItem onSelect={() => markRead(id)}><CircleIcon />Mark as read</ContextMenuItem>
          : <ContextMenuItem onSelect={() => markUnread(id)}><CircleDotIcon />Mark as unread</ContextMenuItem>)}
        {archived
          ? <ContextMenuItem onSelect={() => unarchive(id)}><ArchiveRestoreIcon />Unarchive</ContextMenuItem>
          : <ContextMenuItem onSelect={() => archive(id)}><ArchiveIcon />Archive</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A chat in the sidebar: its title, and under it where it stands in words (working, what it waits on you for, what
 *  went wrong, or the first line of its last reply). Hover a cut-off line to read all of it. Color is kept for one
 *  thing: a green dot when the chat needs you or went wrong (a green "?" when what it needs is an answer to a
 *  question). Unread is a bold title and a small gray dot.
 *  A Codex chat that another app has open (lib/held) is a little faded and says where it is open: it can be read
 *  here but not carried on, so it has no dot, whatever a start that was refused left behind. */
// Extra props and the ref go to the button: the right-click menu (ContextMenuTrigger asChild) attaches through them.
function ChatRow({ s, title, active, time, onOpen, className, ...rest }: { s: SessionSummary; title: string; active: boolean; time?: string; onOpen: () => void } & React.ComponentProps<'button'>) {
  const mark = useChatMark(s.id);
  const st = useChatStatus(s.id);
  const elsewhere = useHeld(s.id);
  const looks = !elsewhere && (mark === 'needs' || !!st?.failed);
  // Unread also while it's still working: a reply that landed while its workflow or agents keep going gets the dot
  // (the line keeps saying Working…).
  const markedUnread = useMarkedUnread();
  const unread = !elsewhere && (mark === 'unread' || (mark === 'working' && (!!st?.unread || markedUnread.has(s.id))));
  const working = mark === 'working' && !elsewhere;
  const line = elsewhere ? elsewhere.line : working ? 'Working…' : st?.line ?? s.preview ?? 'No reply yet';
  const lineRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const lineEl = (
    <span ref={lineRef} onPointerEnter={() => { const el = lineRef.current; setCut(!!el && el.scrollWidth > el.clientWidth); }}
      className={cn('mt-0.5 block w-full truncate text-small leading-[18px]', working ? 'working-line font-medium' : unread ? 'text-foreground/75' : 'text-muted-foreground')}><PreviewText line={line} /></span>
  );
  return (
    <button {...rest} onClick={onOpen} aria-current={active ? 'page' : undefined} className={cn('chat-row', SECOND_LINE ? chatRow2 : chatRow1, active && 'bg-sidebar-accent', className)} data-glide={s.id}>
      <span className={cn('flex w-full min-w-0 items-center', elsewhere && 'opacity-55')}>
        {/* A long title fades at the edge and scrolls to its end on hover (Marquee, keyed off .chat-row). */}
        <Marquee className="min-w-0 flex-1 text-[14px] leading-5" contentClassName={cn(unread ? 'font-semibold' : 'font-normal', !SECOND_LINE && working && 'working-line font-medium')}>{title}</Marquee>
        {looks && st?.asking && !st.failed ? <span role="img" aria-label="Asked you a question" title="Asked you a question" className="ml-2 w-2 shrink-0 text-center text-[13px] leading-none font-semibold text-brand">?</span>
          : looks ? <span role="img" aria-label={st?.failed ? 'Went wrong' : 'Needs you'} title={st?.failed ? 'Went wrong' : 'Needs you'} className="ml-2 size-2 shrink-0 rounded-full bg-brand" />
          : unread ? <span role="img" aria-label="Unread" title="Unread" className="ml-2 size-1.5 shrink-0 rounded-full bg-foreground/55" /> : null}
        {time && <span className="ml-2 shrink-0 text-small tabular-nums text-faint" title={`You last wrote ${new Date(s.updated).toLocaleString()}`}>{time}</span>}
      </span>
      {!SECOND_LINE ? null : cut ? (
        <Tooltip>
          <TooltipTrigger asChild>{lineEl}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-72"><PreviewText line={line} /></TooltipContent>
        </Tooltip>
      ) : lineEl}
    </button>
  );
}

/** A row's second line as plain words, with any math in it drawn by KaTeX (lib/preview-line). */
function PreviewText({ line }: { line: string }) {
  const parts = useMemo(() => previewParts(line).map((p) =>
    'tex' in p ? { html: katex.renderToString(p.tex, { throwOnError: false, output: 'html' }) } : p), [line]);
  return <>{parts.map((p, i) => 'html' in p ? <span key={i} className="preview-math" dangerouslySetInnerHTML={{ __html: p.html }} /> : p.text)}</>;
}

/** A chat row being renamed, in place: Enter or clicking away saves, Esc keeps the old name. */
function RenameRow({ title, onDone }: { title: string; onDone: (next: string | null) => void }) {
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  // Enter saves, then the input unmounts and blurs: the ref makes sure that only saves once.
  const done = useRef(false);
  const finish = (next: string | null) => { if (done.current) return; done.current = true; onDone(next); };
  const commit = () => { const t = draft.trim(); finish(t && t !== title ? t : null); };
  // Focused after the menu has closed and let go of focus.
  useEffect(() => { const r = requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); return () => cancelAnimationFrame(r); }, []);
  return (
    <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') finish(null); }}
      maxLength={120} spellCheck={false} aria-label="Chat title"
      className={cn(chatRow, 'bg-background ring-1 ring-foreground/20 outline-none hover:bg-background')} />
  );
}

/** Where a dragged project or chat will land: a thin line above (or below) a row. */
function DropLine({ top }: { top?: boolean }) {
  return <span aria-hidden className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-foreground/60', top ? '-top-px' : '-bottom-px')} />;
}

export function Sidebar(props: Props) {
  const { projects, chats, activeId, activeDir, account, healthy, collapsed, home, onHome, onNew, onSearch, onOpen, onAddProject, onRemoveProject, onReorderProjects, onSettings } = props;
  const [listScrolled, setListScrolled] = useState(false);
  // Which projects you folded, kept across restarts and reloads (open is the default, so only closed ones are stored).
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try { return Object.fromEntries((JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]).map((d) => [d, false])); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify(Object.keys(expanded).filter((d) => expanded[d] === false))); } catch { /* full: skip */ }
  }, [expanded]);
  const [moreIn, setMoreIn] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const archivedIds = useArchived();
  const pinnedIds = usePinned();
  const statuses = useChatList();
  const looking = new Set(statuses.filter((c) => c.state === 'needs-you' || c.failed).map((c) => c.sessionId));
  const markedForBadge = useMarkedUnread();
  // Dragging, within a list only: a project among the projects, a chat among the chats of its own list (Pinned, a
  // project's, or Recents). A list of chats sorts itself by your last message until you drag in it; then it keeps your
  // order (lib/chat-order). Dragging never pins: pinning is the right-click menu.
  // Lists: 'projects', 'pinned', or 'c:<folder>' (a project's chats; Recents is the chats folder's).
  const [drag, setDrag] = useState<{ list: string; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<{ list: string; index: number } | null>(null);
  const chatOrders = useChatOrders();
  const endDrag = () => { setDrag(null); setDropAt(null); };
  // A chat (`dir` given) also carries itself out of the sidebar: onto the chat area or a pane it opens there (chat-drag.ts).
  const dragFrom = (list: string, id: string, dir?: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id);
      if (dir) setDraggedChat(e.dataTransfer, { dir, id });
      setDrag({ list, id });
    },
    onDragEnd: endDrag,
  });
  /** A drop target in a list: the line goes above or below the row, whichever half the pointer is over. */
  const dropOn = (list: string, index: number) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag || drag.list !== list) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const at = e.clientY < r.top + r.height / 2 ? index : index + 1;
      if (dropAt?.list !== list || dropAt.index !== at) setDropAt({ list, index: at });
    },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); finishDrop(); },
  });
  const moved = (order: string[], id: string, at: number) => {
    const from = order.indexOf(id);
    const rest = order.filter((x) => x !== id);
    rest.splice(from !== -1 && from < at ? at - 1 : at, 0, id);
    return rest;
  };
  // What each list of chats shows now, top first (a drop is placed against it).
  const shownIn = useRef<Record<string, string[]>>({});
  const finishDrop = () => {
    if (drag && dropAt && drag.list === dropAt.list) {
      if (dropAt.list === 'projects') onReorderProjects?.(moved(projects.map((p) => p.dir), drag.id, dropAt.index));
      else if (dropAt.list === 'pinned') setPinnedOrder(moved(pinnedIds.filter((id) => all.some((r) => r.id === id)), drag.id, dropAt.index));
      else setChatOrder(dropAt.list, moved(shownIn.current[dropAt.list] ?? [], drag.id, dropAt.index));
    }
    endDrag();
  };
  const lineAt = (list: string, index: number) => dropAt?.list === list && dropAt.index === index;
  // Renaming: which row is a text field ("<list>:<chat id>": a chat can be in its project and in Recents at once, and
  // only the row you right-clicked edits), and new names shown right away (until the list catches up).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamed, setRenamed] = useState<Record<string, { from: string; to: string }>>({});
  const titleOf = (id: string, title: string) => (renamed[id]?.from === title ? renamed[id].to : title);
  const rename = (id: string, dir: string, title: string, next: string | null) => {
    setRenaming(null);
    if (!next) return;
    feature('chat_renamed');
    setRenamed((m) => ({ ...m, [id]: { from: title, to: next } }));
    api.rename(id, next, dir).then(() => window.dispatchEvent(new Event('canopy:sessions-changed'))).catch(() => {
      setRenamed((m) => { const { [id]: _, ...rest } = m; return rest; });
    });
  };
  // Opening a chat reads it.
  useEffect(() => { if (activeId) markRead(activeId); }, [activeId]);

  const all = [
    ...(chats?.sessions ?? []).map((x) => ({ ...x, dir: chats!.dir })),
    ...projects.flatMap((p) => p.sessions.map((x) => ({ ...x, dir: p.dir }))),
  ].sort((a, b) => b.updated - a.updated);
  // The Dock badge counts what this sidebar shows: chats waiting on you, and unread chats you haven't opened (one
  // count each, archived ones left out). A failed chat you've already looked at doesn't keep it up.
  const badge = (() => {
    const ids = new Set([...all.map((r) => r.id), ...statuses.map((c) => c.sessionId)]);
    let n = 0;
    for (const id of ids) {
      if (archivedIds.has(id)) continue;
      const st = statuses.find((c) => c.sessionId === id);
      if (st?.state === 'needs-you' || (id !== activeId && (st?.unread || markedForBadge.has(id)))) n++;
    }
    return n;
  })();
  useEffect(() => { api.setBadge?.(badge); }, [badge]);
  // Pinned chats sit at the top and nowhere else; a chat in a project shows only under it, so Recents keeps the rest.
  const pinnedList = pinnedIds.map((id) => all.find((r) => r.id === id)).filter((r): r is (typeof all)[number] => !!r && !archivedIds.has(r.id));
  const away = (id: string) => archivedIds.has(id) || pinnedIds.includes(id);
  const recentsKey = `c:${chats?.dir ?? ''}`;
  const recents = arrange(all.filter((r) => r.dir === chats?.dir && !away(r.id)), chatOrders[recentsKey]);
  shownIn.current[recentsKey] = recents.map((r) => r.id);
  const archived = all.filter((r) => archivedIds.has(r.id));
  const live = (list: SessionSummary[]) => list.filter((x) => !away(x.id));

  // The logo's hover breeze plays all the way through once, even if the pointer moves on mid-way.
  const [swaying, setSwaying] = useState(false);
  const swayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const breeze = () => {
    if (swayTimer.current) return;
    setSwaying(true);
    swayTimer.current = setTimeout(() => { setSwaying(false); swayTimer.current = undefined; }, 1050);
  };
  useEffect(() => () => clearTimeout(swayTimer.current), []);

  // Tooltips only matter on the rail, where the labels are hidden.
  const tip = collapsed ? undefined : false;

  return (
    <aside data-collapsed={collapsed || undefined} className="absolute inset-y-0 left-0 z-20 flex flex-col overflow-hidden bg-sidebar text-sidebar-foreground" style={{ width: SIDEBAR_FULL }}>
      <div onMouseEnter={breeze} data-breeze={swaying || undefined} className="logo-breeze flex h-14 shrink-0 items-center gap-1.5 pl-[17px]">
        {/* wordmark: mark then word (drawn, at a size off the type scale on purpose). The mark is the rail's logo too.
            Hover: a breeze through the canopy (index.css), played through once per hover. */}
        <Logo className="size-[22px] shrink-0 translate-y-[-1px] text-brand" />
        <Wordmark className="sb-label text-[21px] leading-none" tracking={-0.03} />
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        <Tooltip open={tip}>
          <TooltipTrigger asChild>
            <button onClick={onHome} aria-label="Home" aria-current={home ? 'page' : undefined} className={cn(row, home && 'bg-sidebar-accent')}>
              <HouseIcon className="size-4 shrink-0 text-muted-foreground" /><span className="sb-label flex-1">Home</span><Kbd className="sb-edge">⌘0</Kbd>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Home<Kbd>⌘0</Kbd></TooltipContent>
        </Tooltip>
        <Tooltip open={tip}>
          <TooltipTrigger asChild>
            <button onClick={() => onNew(chats?.dir)} aria-label="New Chat" className={row}>
              <SquarePenIcon className="size-4 shrink-0 text-muted-foreground" /><span className="sb-label flex-1">New Chat</span><Kbd className="sb-edge">⌘N</Kbd>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">New Chat<Kbd>⌘N</Kbd></TooltipContent>
        </Tooltip>
        <Tooltip open={tip}>
          <TooltipTrigger asChild>
            <button onClick={() => { feature('sidebar_search'); onSearch(); }} aria-label="Search" className={row}>
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" /><span className="sb-label flex-1">Search</span><Kbd className="sb-edge">⌘K</Kbd>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Search<Kbd>⌘K</Kbd></TooltipContent>
        </Tooltip>
      </nav>

      {/* Scrolled, the chats would slide right up under Search: a hairline marks the edge and they fade out a little
          below it. At the top of the list neither shows, and the first heading's gap (8 + 1 + 15) is the 24px it always was. */}
      <div className={cn('relative mt-2 flex min-h-0 flex-1 flex-col border-t transition-colors', listScrolled ? 'border-sidebar-border' : 'border-transparent')}>
        <div inert={collapsed} onScroll={(e) => setListScrolled(e.currentTarget.scrollTop > 0)} className={cn('sb-label min-h-0 flex-1 overflow-y-auto pb-3 [&>:first-child]:mt-[15px]', listScrolled && 'list-fade-top')}>
          {pinnedList.length > 0 && (
            <>
              <div data-glide="pinned-head" className="mt-6 mb-0.5 flex h-8 items-center px-5 text-label text-muted-foreground">Pinned</div>
              <div className="flex flex-col gap-0.5 px-2">
                {pinnedList.map((r, i) => renaming === `n:${r.id}` ? (
                  <RenameRow key={r.id} title={titleOf(r.id, r.title)} onDone={(t) => rename(r.id, r.dir, r.title, t)} />
                ) : (
                  <div key={r.id} className="relative" {...dropOn('pinned', i)}>
                    {lineAt('pinned', i) && <DropLine top />}
                    <ChatMenu id={r.id} pinned onRename={() => setRenaming(`n:${r.id}`)}>
                      <ChatRow s={r} title={titleOf(r.id, r.title)} active={r.id === activeId} time={ago(r.updated)} onOpen={() => onOpen(r.dir, r.id)} {...dragFrom('pinned', r.id, r.dir)} />
                    </ChatMenu>
                    {i === pinnedList.length - 1 && lineAt('pinned', i + 1) && <DropLine />}
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="mt-6 mb-0.5 flex h-8 items-center pr-[11px] pl-5">
            <span className="text-label text-muted-foreground">Projects</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onAddProject} aria-label="Add project…" className={cn('sb-edge ml-auto', hoverBtn)}><FolderPlusIcon className="size-3.5" /></button>
              </TooltipTrigger>
              <TooltipContent>Add project…</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex flex-col gap-0.5 px-2">
            {projects.length === 0 && (
              <button onClick={onAddProject} className={cn(row, 'text-muted-foreground hover:text-foreground')}><FolderPlusIcon className="size-4" />Add a project…</button>
            )}
            {projects.map((p) => {
              const name = dirName(p.dir);
              const open = expanded[p.dir] ?? true; // open by default
              const more = !!moreIn[p.dir];
              const key = `c:${p.dir}`;
              const sessions = arrange(live(p.sessions), chatOrders[key]);
              shownIn.current[key] = sessions.map((x) => x.id);
              const hidden = sessions.length - PROJECT_CHATS;
              // At most five, newest first; the chat you're in always stays in view (it takes the fifth slot if it's older).
              const top = sessions.slice(0, PROJECT_CHATS);
              const current = sessions.find((x) => x.id === activeId);
              const shown = more ? sessions : current && !top.includes(current) ? [...top.slice(0, PROJECT_CHATS - 1), current] : top;
              return (
                <div key={p.dir} className="relative" {...dropOn('projects', projects.indexOf(p))}>
                  {lineAt('projects', projects.indexOf(p)) && <DropLine top />}
                  {projects.indexOf(p) === projects.length - 1 && lineAt('projects', projects.length) && <DropLine />}
                  <div {...dragFrom('projects', p.dir)}>
                  <ProjectRow dir={p.dir} name={name} chats={sessions.length} open={open} active={p.dir === activeDir} alert={!open && sessions.some((x) => looking.has(x.id))}
                    onToggle={() => setExpanded({ ...expanded, [p.dir]: !open })} onNew={() => onNew(p.dir)} onRemove={() => { feature('project_removed'); onRemoveProject(p.dir); }}
                    onAutoSort={chatOrders[key] ? () => clearChatOrder(key) : undefined} />
                  </div>
                  <Reveal show={open}>
                    <div className="mt-0.5 mb-1 ml-[20px] flex flex-col gap-0.5 border-l border-hairline pl-3">
                      {shown.map((ss) => {
                        const active = ss.id === activeId;
                        const i = sessions.indexOf(ss);
                        if (renaming === `p:${ss.id}`) return <RenameRow key={ss.id} title={titleOf(ss.id, ss.title)} onDone={(t) => rename(ss.id, p.dir, ss.title, t)} />;
                        return (
                          <div key={ss.id} className="relative" {...dropOn(key, i)}>
                            {lineAt(key, i) && <DropLine top />}
                            <ChatMenu id={ss.id} onRename={() => setRenaming(`p:${ss.id}`)}>
                              <ChatRow s={ss} title={titleOf(ss.id, ss.title)} active={active} onOpen={() => onOpen(p.dir, ss.id)} {...dragFrom(key, ss.id, p.dir)} />
                            </ChatMenu>
                            {lineAt(key, i + 1) && ss === shown[shown.length - 1] && <DropLine />}
                          </div>
                        );
                      })}
                      {hidden > 0 && (
                        <button onClick={() => setMoreIn({ ...moreIn, [p.dir]: !more })} className={moreToggle}>{more ? 'Show less' : `Show ${hidden} more`}</button>
                      )}
                      {sessions.length === 0 && <p className="flex h-8 items-center px-2 text-small text-faint">No chats</p>}
                    </div>
                  </Reveal>
                </div>
              );
            })}
          </div>

          <div className="mt-6 mb-0.5 flex h-8 items-center px-5 text-label text-muted-foreground">Recents</div>
          {recents.length === 0 ? (
            <p className="flex h-8 items-center px-5 text-small text-muted-foreground">Chats you start show up here</p>
          ) : (
            <div className="flex flex-col gap-0.5 px-2">
              {recents.slice(0, showAll ? undefined : RECENTS).map((r, i, list) => {
                const active = r.id === activeId;
                if (renaming === `r:${r.id}`) return <RenameRow key={r.id} title={titleOf(r.id, r.title)} onDone={(t) => rename(r.id, r.dir, r.title, t)} />;
                return (
                  <div key={r.id} className="relative" {...dropOn(recentsKey, i)}>
                    {lineAt(recentsKey, i) && <DropLine top />}
                    <ChatMenu id={r.id} onRename={() => setRenaming(`r:${r.id}`)}>
                      <ChatRow s={r} title={titleOf(r.id, r.title)} active={active} time={ago(r.updated)} onOpen={() => onOpen(r.dir, r.id)} {...dragFrom(recentsKey, r.id, r.dir)} />
                    </ChatMenu>
                    {i === list.length - 1 && lineAt(recentsKey, i + 1) && <DropLine />}
                  </div>
                );
              })}
              {recents.length > RECENTS && (
                <button onClick={() => setShowAll(!showAll)} className={moreToggle}>{showAll ? 'Show less' : `Show ${recents.length - RECENTS} more`}</button>
              )}
            </div>
          )}

          {archived.length > 0 && (
            <div className="mt-4 px-2">
              <button onClick={() => setShowArchived(!showArchived)} className={cn(moreToggle, 'gap-1.5')}>
                <ArchiveIcon className="size-3.5" />Archived · {archived.length}
              </button>
              <Reveal show={showArchived}>
                <div className="flex flex-col gap-0.5">
                  {archived.map((r) => renaming === `a:${r.id}` ? (
                    <RenameRow key={r.id} title={titleOf(r.id, r.title)} onDone={(t) => rename(r.id, r.dir, r.title, t)} />
                  ) : (
                    <ChatMenu key={r.id} id={r.id} archived onRename={() => setRenaming(`a:${r.id}`)}>
                      <button onClick={() => onOpen(r.dir, r.id)} aria-current={r.id === activeId ? 'page' : undefined}
                        className={cn(chatRow, 'text-muted-foreground', r.id === activeId && 'bg-sidebar-accent')}>
                        <span className="min-w-0 flex-1 truncate">{titleOf(r.id, r.title)}</span>
                        <span className="ml-2 shrink-0 text-micro tabular-nums text-faint">{ago(r.updated)}</span>
                      </button>
                    </ChatMenu>
                  ))}
                </div>
              </Reveal>
            </div>
          )}
        </div>

      </div>

      <div inert={collapsed} className="sb-label"><SidebarCards /></div>
      {/* Rail block: what of the list fits 56px. Starts where the list does (the divider sits where "Projects" was) and runs
        down to the footer, past the full sidebar's cards, so the restart button sits right above the avatar. */}
      <div inert={!collapsed} className="sb-rail absolute top-[156px] bottom-14 left-0 flex flex-col items-center" style={{ width: SIDEBAR_RAIL }}>
        <div className="flex h-6 shrink-0 items-center"><div className="h-px w-6 bg-sidebar-border" /></div>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <RailBtn label="Add project…" onClick={onAddProject}><FolderPlusIcon className="size-4" /></RailBtn>
          {projects.map((p) => (
            <RailBtn key={p.dir} label={`New chat in ${dirName(p.dir)}`} active={p.dir === activeDir} onClick={() => onNew(p.dir)}>
              <FolderIcon className="size-4" />
            </RailBtn>
          ))}
        </div>
        <UpdateRailButton />
      </div>

      <div className="flex h-14 shrink-0 items-center border-t border-sidebar-border px-2">
        <Tooltip open={tip}>
          <TooltipTrigger asChild>
            <button onClick={onSettings} aria-label="Settings" className="sb-row flex h-10 w-full items-center gap-3 rounded-md pr-2 pl-1.5 text-left hover:bg-sidebar-hover">
              <Avatar name={account.name} photo={account.photo} healthy={healthy} />
              <span className="sb-label min-w-0 flex-1 truncate text-ui">{account.name || 'You'}</span>
              <SettingsIcon className="sb-edge size-4 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}

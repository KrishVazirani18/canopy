// Full-width window toolbar: traffic lights + sidebar toggle on the left,
// the chat title centred over <main>, the panel toggle on the right. Sidebar and content sit below it,
// so the window buttons never collide with anything.
// The title box always starts at the rail edge and is shifted on the `translate` property (GPU, no
// re-layout) by half the sidebar delta, in sync with App's 240ms curtain. The inspector is an overlay,
// so it never moves the title.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRightLeftIcon, BarChart3Icon, CheckIcon, ChevronDownIcon, CopyIcon, FolderPlusIcon, LayoutGridIcon, PanelLeftIcon, PanelRightIcon, PencilIcon, PlusIcon, SquareTerminalIcon } from 'lucide-react';
import { MAX_PANES, useMultiInfo } from './multi-view';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useStore } from '@/lib/store';
import { useModels } from '@/lib/engines';
import { canMove, moveItem, moveLine, moveTarget } from '@/lib/move';
import { feature } from '@/lib/telemetry';
import { chatRuns } from './controls';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ui, useUi } from '@/lib/ui';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { SIDEBAR_FULL, SIDEBAR_RAIL } from './sidebar';
import { projectName } from '@/lib/project-name';

function IconBtn({ label, kbd, active, onClick, children }: { label: string; kbd?: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick} aria-label={label} className={cn('relative z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground [-webkit-app-region:no-drag]', active && 'text-foreground')}>{children}</button>
      </TooltipTrigger>
      <TooltipContent>{label}{kbd && <Kbd>{kbd}</Kbd>}</TooltipContent>
    </Tooltip>
  );
}


/** What the project name at the top can switch to: your projects, no project, or a new one. */
export type ProjectMenu = { dirs: string[]; current: string | null; chatsDir: string | null; empty: boolean; onPick: (dir: string) => void; onAdd: () => void };
const dirName = (d: string) => projectName(d);

/** Click the project name: pick another project. A new chat moves there; a chat with messages can't move, so the
 *  menu says "New chat in" and starts one there instead. */
function ProjectSwitch({ name, menu }: { name: string; menu: ProjectMenu }) {
  const here = (d: string) => d === menu.current;
  // The folder an untouched chat is already in is not a pick.
  const pick = (d: string) => { if (menu.empty && here(d)) return; feature('folder_picked'); menu.onPick(d); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Switch project"
        className="flex h-7 shrink-0 items-center rounded-md px-1.5 text-muted-foreground outline-none hover:bg-sidebar-hover hover:text-foreground data-[state=open]:bg-sidebar-hover data-[state=open]:text-foreground [-webkit-app-region:no-drag]">
        {/* No arrow: it would hold space even when hidden and push the › away. Hovering lights the name instead. */}
        <span className="max-w-[16rem] truncate">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" sideOffset={6} className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
        {!menu.empty && <DropdownMenuLabel className="text-small font-normal text-muted-foreground">New chat in</DropdownMenuLabel>}
        {menu.dirs.map((d) => (
          <DropdownMenuItem key={d} onSelect={() => pick(d)} title={d}>
            <span className="min-w-0 flex-1 truncate">{dirName(d)}</span>
            {menu.empty && here(d) && <CheckIcon className="size-3.5 text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
        {menu.chatsDir && (
          <DropdownMenuItem onSelect={() => pick(menu.chatsDir!)}>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">No project</span>
            {menu.empty && here(menu.chatsDir) && <CheckIcon className="size-3.5 text-muted-foreground" />}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={menu.onAdd}><FolderPlusIcon />Add project…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Chat menu: the chat's name and what's running it, then the actions. Context, cost and time live in Stats. Anything not known yet is simply left out, never shown as a dash.
// "Move to OpenAI" / "Move to Claude" carries the chat to the other maker (lib/move.ts), on your last pick for that
// maker. It is the same as picking that model's row under the message box, which is what it asks the composer to do.
function ChatMenu({ title, project, onRename, disabled }: { title: string; project: string | null; onRename: () => void; disabled?: boolean }) {
  const store = useStore();
  const { meta } = store;
  const runs = chatRuns(meta); // the chat's own maker: its model and its effort, as on the composer's chip
  useModels(); // the other maker's rows may arrive after this menu was first drawn
  const to = disabled ? null : moveTarget(store);
  const movable = to ? canMove(store) : 'no';
  const [open, setOpen] = useState(false);
  // /context, /cost, /status and the context ring open this menu.
  useEffect(() => { const on = () => { if (!disabled) setOpen(true); }; window.addEventListener('canopy:chat-menu', on); return () => window.removeEventListener('canopy:chat-menu', on); }, [disabled]);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* The same element whether or not the chat can be renamed yet; only the words crossfade when the name changes. */}
      <DropdownMenuTrigger disabled={disabled} aria-label="Chat details"
        className="flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 font-medium text-foreground outline-none enabled:hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover disabled:cursor-default [-webkit-app-region:no-drag] disabled:[-webkit-app-region:drag]">
        <span key={title} className="truncate enter-fade [animation-duration:220ms]">{title}</span>
        <ChevronDownIcon className={cn('size-3 shrink-0 opacity-50 transition-opacity duration-200', disabled && 'opacity-0')} />
      </DropdownMenuTrigger>
      {/* Wide enough for the longest second line ("Continues in GPT-6.1-Sol with this chat’s context"). */}
      <DropdownMenuContent align="center" sideOffset={6} className="w-80 p-1.5" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="px-2 pt-1.5 pb-2">
          <div className="truncate text-ui font-medium">{title}</div>
          <div className="mt-0.5 truncate text-small text-muted-foreground">
            {runs.model}{runs.effort ? ` · ${runs.effort}` : ''}{project ? ` · ${project}` : ''}
          </div>
        </div>
        <DropdownMenuSeparator />
        {/* Menu items in Title Case, as macOS menus are; the gray second lines stay sentences. Grouped: the chat itself,
            looking into it, moving it. */}
        <DropdownMenuItem onSelect={() => setTimeout(onRename, 0)}><PencilIcon />Rename</DropdownMenuItem>
        {meta.sessionId && <DropdownMenuItem onSelect={() => { void navigator.clipboard.writeText(meta.sessionId!).then(() => toast('Chat ID copied', { id: 'chat-id' })); }}><CopyIcon />Copy Chat ID</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => ui.openTab('stats')}><BarChart3Icon />Stats</DropdownMenuItem>
        {/* The terminal is Claude Code's own: an OpenAI chat has none to open. */}
        {meta.engine !== 'codex' && <DropdownMenuItem onSelect={() => ui.openTab('terminal')}><SquareTerminalIcon />Open in Terminal<DropdownMenuShortcut>⌘J</DropdownMenuShortcut></DropdownMenuItem>}
        {to && movable !== 'no' && <DropdownMenuSeparator />}
        {to && movable !== 'no' && (
          <DropdownMenuItem disabled={movable === 'busy'} className="items-start"
            onSelect={() => { feature('engine_changed'); window.dispatchEvent(new CustomEvent('canopy:control', { detail: { key: 'model', value: to.value, engine: to.engine } })); }}>
            <ArrowRightLeftIcon className="mt-0.5" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block">{moveItem(to.engine)}</span>
              <span className="block truncate text-micro text-muted-foreground">{moveLine(to.label, movable)}</span>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `naming`: a new chat whose real name hasn't come yet: a spinner stands in for the title (not your long first message). */
export function TitleBar({ title, project, onRename, onToggleMulti, naming, projects }: { title: string; project: string | null; onRename?: (t: string) => void; onToggleMulti?: () => void; naming?: boolean; projects?: ProjectMenu }) {
  const { sidebar, inspector, view, multi: multiOn } = useUi();
  const multi = multiOn && view === 'chat';
  const panes = useMultiInfo();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  // Enter commits, then the input unmounts and blurs: the ref makes sure that only renames once.
  const editingRef = useRef(false);
  useEffect(() => { setDraft(title); }, [title]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const start = () => { if (!onRename) return; setDraft(title); editingRef.current = true; setEditing(true); };
  const commit = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) { feature('chat_renamed'); onRename?.(next); }
    else setDraft(title);
  };
  const cancel = () => { editingRef.current = false; setDraft(title); setEditing(false); };

  return (
    <header className="relative flex h-11 shrink-0 items-center border-b bg-sidebar pr-[10px] pl-[84px] [-webkit-app-region:drag]">
      <IconBtn label={sidebar ? 'Hide sidebar' : 'Show sidebar'} kbd="⌘B" onClick={() => ui.set({ sidebar: !sidebar })}><PanelLeftIcon className="size-4" /></IconBtn>
      {/* IMPORTANT: this strip must never overlap the sidebar toggle (x 84–112). It inherits the header's
          window-drag region, and Electron drag regions swallow clicks even with pointer-events:none.
          Collapsed, it starts at 128 and pads the right by 52 so the title stays centred over <main> (76→W). */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-center px-16 text-ui transition-[left,padding] duration-260 ease-pane motion-reduce:transition-none"
        style={sidebar ? { left: SIDEBAR_FULL } : { left: 128, paddingRight: 64 + (128 - SIDEBAR_RAIL) }}>
        <div className="pointer-events-auto flex min-w-0 max-w-[calc(100%-188px)] items-center gap-1.5">
          {/* The project: a menu to switch it when there is one to show (a new chat outside a project offers it too). */}
          {projects && (project || projects.empty) ? <ProjectSwitch name={project ?? 'No project'} menu={projects} />
            : project && <span className="shrink-0 px-1.5 text-muted-foreground">{project}</span>}
          {(project || (projects && projects.empty)) && title && <span className="text-faint">›</span>}
          {naming && !editing ? (
            <span aria-label="Naming this chat" title="Naming this chat…" className="flex h-7 items-center px-1.5"><Spinner className="size-3.5 text-muted-foreground" /></span>
          ) : editing ? (
            <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
              maxLength={120} spellCheck={false} aria-label="Chat title"
              className="h-7 w-[min(20rem,100%)] rounded-md bg-background px-1.5 text-center text-ui font-medium ring-1 ring-foreground/20 outline-none [-webkit-app-region:no-drag]" />
          ) : (
            // A new chat can't be renamed yet: same element, just disabled (no menu, the window drags from it).
            <ChatMenu title={title} project={project} onRename={start} disabled={!onRename} />
          )}
        </div>
      </div>
      <div className="flex-1" />
      {/* The side panel is about a chat (Stats, Changes, Terminal): not on Home or in the Playground. */}
      {multi && (
        <button type="button" onClick={() => window.dispatchEvent(new Event('canopy:pane-add'))} disabled={panes.count >= MAX_PANES}
          title={panes.count >= MAX_PANES ? 'Four panes is the most' : 'Add a pane (⌘D)'}
          className="relative z-10 mr-1 flex h-7 items-center gap-1 rounded-md px-2 text-small text-muted-foreground hover:bg-sidebar-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-35 [-webkit-app-region:no-drag]">
          <PlusIcon className="size-3.5" />Pane
        </button>
      )}
      {view === 'chat' && onToggleMulti && <IconBtn label={multi ? 'Leave Multi mode' : 'Multi mode: chats side by side'} kbd="⌘⇧M" active={multi} onClick={onToggleMulti}><LayoutGridIcon className="size-4" /></IconBtn>}
      {view === 'chat' && !multi && <IconBtn label={inspector ? 'Hide panel' : 'Show panel'} kbd="⌘I" active={inspector} onClick={() => ui.set({ inspector: !inspector })}><PanelRightIcon className="size-4" /></IconBtn>}
    </header>
  );
}

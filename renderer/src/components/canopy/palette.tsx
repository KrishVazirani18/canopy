// ⌘K: search everything. Empty, it's a calm start: recent chats and a few places to go. Typing searches chat titles,
// then what was actually said inside every chat (with the line and your words highlighted), then actions, modes and
// projects, each only when your words match. Opening a mention jumps to that message in its chat.
import { useEffect, useMemo, useState } from 'react';
import { CheckIcon, FolderIcon, FolderPlusIcon, HouseIcon, MessageSquareIcon, PaletteIcon, PanelLeftIcon, PanelRightIcon, SettingsIcon, SquarePenIcon, SquareTerminalIcon, TextQuoteIcon } from 'lucide-react';
import { Command as CommandPrimitive } from 'cmdk';
import { Bolt, Braces } from './controls';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { choices } from '@/lib/choices';
import { store, useStore } from '@/lib/store';
import { feature, setting } from '@/lib/telemetry';
import { ui, useUi } from '@/lib/ui';
import { cn } from '@/lib/utils';
import { MODES, setMode } from './controls';
import type { Project } from './sidebar';
import { projectName as folderName } from '@/lib/project-name';

type Mention = Awaited<ReturnType<NonNullable<typeof api.searchChats>>>[number];

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = new Date(t);
  return s < 6 * 86400 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Text with the matched words lit. */
function Lit({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let i = 0, k = 0;
  const low = text.toLowerCase();
  while (i < text.length) {
    const at = low.indexOf(q, i);
    if (at < 0) { out.push(text.slice(i)); break; }
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark key={k++} className="rounded-[3px] bg-brand/25 px-px text-foreground">{text.slice(at, at + q.length)}</mark>);
    i = at + q.length;
  }
  return <>{out}</>;
}

const item = 'flex cursor-default items-center gap-3 rounded-lg px-3 text-ui text-foreground/90 outline-none select-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
const heading = '[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-8 [&_[cmdk-group-heading]]:items-end [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-normal [&_[cmdk-group-heading]]:text-muted-foreground';
const Key = ({ children }: { children: React.ReactNode }) => <kbd className="kbd rounded bg-foreground/[0.06] px-1.5 py-0.5 text-micro">{children}</kbd>;

export function Palette({ projects, chatsDir, onNew, onOpen, onAddProject, onSettings }: {
  projects: Project[]; chatsDir?: string | null; onNew: (dir?: string) => void; onOpen: (dir: string, id: string) => void; onAddProject: () => void; onSettings: () => void;
}) {
  const { palette, sidebar, inspector } = useUi();
  const { meta } = useStore();
  const [q, setQ] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [looking, setLooking] = useState(false);
  const close = () => ui.set({ palette: false });
  const run = (fn: () => void) => () => { close(); fn(); };
  useEffect(() => { if (!palette) { setQ(''); setMentions([]); } }, [palette]);

  const isChats = (dir: string) => (chatsDir ? dir === chatsDir : dir.endsWith('/chats'));
  const named = projects.filter((p) => !isChats(p.dir));
  const sessions = useMemo(() => projects.flatMap((p) => p.sessions.map((s) => ({ ...s, dir: p.dir }))).sort((a, b) => b.updated - a.updated), [projects]);
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? 'Chat';
  const projectName = (dir: string) => (isChats(dir) ? '' : folderName(dir));
  const fastOn = meta.fastPref ?? (meta.fastState === 'on' || meta.fastState === 'cooldown');
  const codeOn = !!choices.codeMode; // your choice for new chats
  const codex = meta.engine === 'codex'; // an OpenAI chat: no Claude Code terminal, no Code Mode, and its own Fast

  // What was said inside chats: asked after a short pause in typing.
  const query = q.trim();
  useEffect(() => {
    if (query.length < 2 || !api.searchChats) { setMentions([]); setLooking(false); return; }
    setLooking(true);
    let live = true;
    const id = setTimeout(() => api.searchChats!(query).then((r) => { if (live) { setMentions(r ?? []); setLooking(false); } }).catch(() => { if (live) setLooking(false); }), 160);
    return () => { live = false; clearTimeout(id); };
  }, [query]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const has = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const titleHits = query ? sessions.filter((s) => has(`${s.title} ${projectName(s.dir)}`)).slice(0, 6) : sessions.slice(0, 6);
  const mentionHits = mentions.slice(0, 12);

  type Act = { id: string; label: string; icon: React.ReactNode; kbd?: string; keys?: string; run: () => void };
  const actions: Act[] = [
    { id: 'new', label: 'New chat', icon: <SquarePenIcon />, kbd: '⌘N', run: () => onNew() },
    { id: 'home', label: 'Home', icon: <HouseIcon />, kbd: '⌘0', run: () => ui.set({ view: 'home' }) },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon />, kbd: '⌘,', run: onSettings },
    { id: 'project', label: 'Add project…', icon: <FolderPlusIcon />, keys: 'folder open', run: onAddProject },
    { id: 'sidebar', label: sidebar ? 'Hide sidebar' : 'Show sidebar', icon: <PanelLeftIcon />, kbd: '⌘B', run: () => ui.set({ sidebar: !ui.get().sidebar }) },
    { id: 'panel', label: inspector ? 'Hide panel' : 'Show panel', icon: <PanelRightIcon />, kbd: '⌘I', keys: 'stats changes', run: () => ui.set({ inspector: !ui.get().inspector }) },
    ...(codex ? [] : [{ id: 'terminal', label: 'Open in Terminal', icon: <SquareTerminalIcon />, kbd: '⌘J', run: () => ui.openTab('terminal') }]),
    // An OpenAI chat's Fast goes through the composer's control, which keeps that maker's own choice.
    { id: 'fast', label: fastOn ? 'Turn off fast mode' : 'Turn on fast mode', icon: <Bolt className="h-4 w-auto" />, keys: 'speed', run: () => { const next = !fastOn; if (codex) { window.dispatchEvent(new CustomEvent('canopy:control', { detail: { key: 'fast', value: next } })); return; } choices.fast = next; store.setMeta({ fastState: next ? 'on' : 'off' }); api.set('fast', next); feature('speed_changed'); } },
    ...(codex ? [] : [{ id: 'code', label: codeOn ? 'Turn off Code Mode for new chats' : 'Turn on Code Mode for new chats', icon: <Braces className="h-4 w-auto" />, keys: 'script tools mcp', run: () => { setting('code_mode', !codeOn); window.dispatchEvent(new CustomEvent('canopy:control', { detail: { key: 'codeMode', value: !codeOn } })); } }]),
    // Only when Canopy runs from source.
    ...(api.dev ? [{ id: 'playground', label: 'Design Playground', icon: <PaletteIcon />, kbd: '⌘⇧P', run: () => ui.set({ view: 'playground' }) }] : []),
  ];
  const actionHits = query ? actions.filter((a) => has(`${a.label} ${a.keys ?? ''}`)) : actions.slice(0, 3);
  const modeHits = query ? MODES.filter((m) => has(`${m.label} permission mode`)) : [];
  const projectHits = query ? named.filter((p) => has(`new chat in ${folderName(p.dir)}`)) : [];
  const nothing = query && !titleHits.length && !mentionHits.length && !actionHits.length && !modeHits.length && !projectHits.length;

  const openMention = (m: Mention) => {
    close();
    onOpen(m.cwd, m.sessionId);
    // Once the chat has loaded, scroll to the message and light it up for a moment.
    window.dispatchEvent(new CustomEvent('canopy:find', { detail: { text: m.snippet.replace(/^…|…$/g, '').slice(Math.max(0, m.match.from - 20), m.match.from + m.match.length + 20).trim(), query } }));
  };

  return (
    <Dialog open={palette} onOpenChange={(o) => ui.set({ palette: o })}>
      <DialogContent showCloseButton={false} className="top-[14%] w-[min(640px,92vw)] max-w-none translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search chats, what was said in them, and actions</DialogDescription>
        <CommandPrimitive shouldFilter={false} loop className="flex flex-col">
          <div className="flex h-14 items-center gap-3 border-b border-hairline px-4">
            <svg viewBox="0 0 24 24" className="size-[18px] shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <CommandPrimitive.Input value={q} onValueChange={setQ} autoFocus placeholder="Search chats, messages and actions"
              className="h-full flex-1 bg-transparent text-body outline-none placeholder:text-faint" />
            {looking && <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/50 border-t-transparent" />}
          </div>
          <CommandPrimitive.List className={cn('max-h-[min(460px,60vh)] overflow-y-auto overscroll-contain p-1.5', heading)}>
            {nothing && !looking && <div className="px-3 py-10 text-center text-ui text-faint">Nothing matches “{query}”.</div>}

            {titleHits.length > 0 && (
              <CommandPrimitive.Group heading={query ? 'Chats' : 'Recent'}>
                {titleHits.map((s) => (
                  <CommandPrimitive.Item key={s.id} value={`chat:${s.id}`} onSelect={run(() => onOpen(s.dir, s.id))} className={cn(item, 'h-10')}>
                    <MessageSquareIcon />
                    <span className="min-w-0 flex-1 truncate"><Lit text={s.title} query={query} /></span>
                    {projectName(s.dir) && <span className="shrink-0 text-small text-faint">{projectName(s.dir)}</span>}
                    <span className="w-9 shrink-0 text-right text-micro tabular-nums text-faint">{ago(s.updated)}</span>
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}

            {mentionHits.length > 0 && (
              <CommandPrimitive.Group heading="In your chats">
                {mentionHits.map((m, i) => (
                  <CommandPrimitive.Item key={`${m.sessionId}:${m.uuid ?? i}`} value={`said:${m.sessionId}:${m.uuid ?? i}`} onSelect={() => openMention(m)} className={cn(item, 'items-start py-2.5')}>
                    <TextQuoteIcon className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-ui leading-snug text-foreground/85"><Lit text={m.snippet} query={query} /></div>
                      <div className="mt-1 truncate text-small text-faint">{m.role === 'you' ? 'You' : 'Canopy'} in {titleOf(m.sessionId)}{projectName(m.cwd) ? ` · ${projectName(m.cwd)}` : ''}</div>
                    </div>
                    <span className="mt-0.5 w-9 shrink-0 text-right text-micro tabular-nums text-faint">{m.at ? ago(m.at) : ''}</span>
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}

            {actionHits.length > 0 && (
              <CommandPrimitive.Group heading={query ? 'Actions' : 'Go to'}>
                {actionHits.map((a) => (
                  <CommandPrimitive.Item key={a.id} value={`act:${a.id}`} onSelect={run(a.run)} className={cn(item, 'h-10')}>
                    {a.icon}<span className="flex-1"><Lit text={a.label} query={query} /></span>
                    {a.kbd && <span className="kbd text-small text-faint">{a.kbd}</span>}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}

            {modeHits.length > 0 && (
              <CommandPrimitive.Group heading="Permissions">
                {modeHits.map((m) => (
                  <CommandPrimitive.Item key={m.value} value={`mode:${m.value}`} onSelect={run(() => setMode(m.value))} className={cn(item, 'h-10')}>
                    <m.icon /><span className="flex-1">{m.label}</span>{meta.mode === m.value && <CheckIcon />}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}

            {projectHits.length > 0 && (
              <CommandPrimitive.Group heading="Projects">
                {projectHits.map((p) => (
                  <CommandPrimitive.Item key={p.dir} value={`proj:${p.dir}`} onSelect={run(() => onNew(p.dir))} className={cn(item, 'h-10')}>
                    <FolderIcon /><span className="flex-1">New chat in {folderName(p.dir)}</span>
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}
          </CommandPrimitive.List>
          <div className="flex h-9 items-center gap-4 border-t border-hairline px-4 text-micro text-faint">
            <span className="flex items-center gap-1.5"><Key>↑</Key><Key>↓</Key>to move</span>
            <span className="flex items-center gap-1.5"><Key>↵</Key>to open</span>
            <span className="flex items-center gap-1.5"><Key>esc</Key>to close</span>
            {!api.searchChats && query.length > 1 && <span className="ml-auto text-warn">Restart Canopy to search inside chats</span>}
          </div>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

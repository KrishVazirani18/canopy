// Settings: a proper settings window, in the shape of macOS System Settings. On the left a search field and the list of
// pages (groups set apart by space, not labels); on the right the page. Everything applies at once; there's no Save.
//
// Every page is made of the same pieces (settings/kit.tsx): it draws its own header through <Page> (‹ back on a page
// opened from a list, the title, its actions, close), an optional toolbar, then sections of rows. Five pages
// (settings/pages.tsx), Advanced set apart at the bottom; Privacy, the model menu and shortcuts open from a row.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkIcon, CircleUserRoundIcon, LayersIcon, MessageSquareIcon, SearchIcon, SlidersHorizontalIcon, WrenchIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { EnvInfo } from '@/lib/api';
import { prefetchTools } from '@/lib/customize';
import { feature } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import { ModelsPage } from './settings-models';
import { Shortcuts } from './settings/app-pages';
import { AccountsPage, AdvancedPage, ChatsPage, Opened, ToolsPage, YouPage, type ToolTab } from './settings/pages';
import { SettingsNav } from './settings/kit';
import { MemoryPage } from './settings/memory-page';
import { Privacy } from './settings/privacy-page';

type Icon = (p: { className?: string }) => React.ReactNode;

// `id`s are also how a page is counted (lib/telemetry-rules.ts lists them). `words` are what the search finds a page
// by: everything that is on it, including the parts that open from it.
type Section = 'you' | 'memory' | 'chats' | 'accounts' | 'tools' | 'advanced';
const PAGES: { id: Section; label: string; icon: Icon; group: number; words: string }[] = [
  { id: 'you', label: 'You', icon: CircleUserRoundIcon, group: 0, words: 'canopy account profile google sign in sign out log out delete email name photo privacy usage stats statistics analytics telemetry tracking data sharing share sent' },
  { id: 'memory', label: 'Memory', icon: BookmarkIcon, group: 0, words: 'memory remember remembers notes preferences forget saved learned share claude code codex' },
  { id: 'chats', label: 'Chats', icon: MessageSquareIcon, group: 0, words: 'new chats default model effort fast mode permissions mode ask accept edits plan auto full access bypass sound notifications chime bell tick theme appearance dark light system colors' },
  { id: 'accounts', label: 'Accounts', icon: LayersIcon, group: 0, words: 'claude code codex openai chatgpt anthropic account accounts api key login sign in plan max pro plus console usage update updates version computer use accessibility screen recording automation permissions' },
  { id: 'tools', label: 'Tools', icon: WrenchIcon, group: 0, words: 'connectors mcp servers integrations apps skills commands slash plugins marketplace marketplaces extensions install' },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontalIcon, group: 1, words: 'model menu models order keyboard shortcuts keys hotkeys code mode canopy kit install path config folder settings file terminal versions version about log affiliated' },
];
// Where Settings opens for what other parts of Canopy ask for ("Edit models…" the model menu, /mcp connectors, the
// usage stats notice Privacy, an account that needs you Accounts).
type Opened = 'privacy' | 'models' | 'shortcuts';
const OPENS: Record<string, { page: Section; open?: Opened; tab?: ToolTab }> = {
  you: { page: 'you' }, chats: { page: 'chats' }, accounts: { page: 'accounts' }, tools: { page: 'tools' }, advanced: { page: 'advanced' },
  general: { page: 'chats' }, appearance: { page: 'chats' }, claude: { page: 'accounts' }, codex: { page: 'accounts' }, about: { page: 'advanced' },
  privacy: { page: 'you', open: 'privacy' }, memory: { page: 'memory' }, models: { page: 'advanced', open: 'models' }, shortcuts: { page: 'advanced', open: 'shortcuts' },
  connectors: { page: 'tools', tab: 'connectors' }, skills: { page: 'tools', tab: 'skills' }, plugins: { page: 'tools', tab: 'plugins' },
};
const where = (s: string | undefined) => (s && OPENS[s]) || { page: 'you' as Section };

export function SettingsDialog({ open, onOpenChange, env, initial }: { open: boolean; onOpenChange: (o: boolean) => void; env: EnvInfo | null; initial?: string }) {
  const [section, setSectionRaw] = useState<Section>('you');
  const [opened, setOpened] = useState<Opened | null>(null); // a page opened from a row of this one
  const [tab, setTab] = useState<ToolTab>('connectors');
  const setSection = (s: Section) => { setSectionRaw(s); setOpened(null); };
  const [query, setQuery] = useState('');
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const w = where(initial);
    setSectionRaw(w.page); setOpened(w.open ?? null); if (w.tab) setTab(w.tab);
    setQuery(''); prefetchTools();
  }, [open, initial]);
  const close = () => onOpenChange(false);
  useEffect(() => { if (open) feature('settings_opened'); }, [open]);
  // A page counts once it has been on screen for a moment: arrowing down the list, or a search passing over pages,
  // is not a visit to each of them.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => feature('settings_page', opened ?? (section === 'tools' ? tab : section)), 600);
    return () => clearTimeout(t);
  }, [open, section, opened, tab]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? PAGES.filter((p) => `${p.label} ${p.words}`.toLowerCase().includes(q)) : PAGES;
  }, [query]);
  // Searching moves to the first page that matches, so the page on the right always belongs to the list on the left.
  useEffect(() => { if (shown.length && !shown.some((p) => p.id === section)) setSection(shown[0].id); }, [shown, section]);

  // ↑ and ↓ move through the list, from the search field or the list itself, as in System Settings.
  const step = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = shown.findIndex((p) => p.id === section);
    const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    setSection(next.id);
    if (!(e.target instanceof HTMLInputElement)) nav.current?.querySelector<HTMLElement>(`[data-section="${next.id}"]`)?.focus();
  };
  // The focus starts on the page Settings opens at, not on the search field or the first page: opened from the model
  // menu's "Edit models…", a focus ring on General beside a selected Models reads as two things chosen at once.
  const focusOpened = (e: Event) => {
    const button = nav.current?.querySelector<HTMLElement>(`[data-section="${where(initial).page}"]`);
    if (button) { e.preventDefault(); button.focus(); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={focusOpened} className="flex h-[min(720px,88vh)] w-[min(1080px,94vw)] max-w-none gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Canopy settings</DialogDescription>
        <SettingsNav.Provider value={{ close }}>
          <nav ref={nav} onKeyDown={step} aria-label="Settings" className="flex w-56 shrink-0 flex-col border-r border-hairline bg-sidebar">
            <div className="px-3 pt-3.5 pb-3">
              <label className="relative block">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search settings"
                  onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                  className="h-8 w-full rounded-lg border border-hairline bg-background/70 pr-2.5 pl-8 text-ui outline-none placeholder:text-faint focus:border-foreground/25 focus:bg-background" />
              </label>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-3 pb-3">
              {shown.map((p, i) => (
                <Fragment key={p.id}>
                  {/* Advanced stands apart, at the bottom of the list */}
                  {i > 0 && shown[i - 1].group !== p.group && <div className="min-h-3 flex-1" />}
                  <button data-section={p.id} onClick={() => setSection(p.id)} aria-current={section === p.id ? 'page' : undefined}
                    className={cn('flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-ui outline-none transition-colors focus-visible:ring-1 focus-visible:ring-foreground/25',
                      section === p.id ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:bg-sidebar-hover hover:text-foreground')}>
                    <p.icon className="size-4 shrink-0" />{p.label}
                  </button>
                </Fragment>
              ))}
              {!shown.length && <p className="px-2 py-1.5 text-small text-faint">No results</p>}
            </div>
          </nav>
          {/* Keyed by page: switching pages starts each fresh (its list, not an item it had open). */}
          <div key={section} className="min-w-0 flex-1">
            {opened === 'privacy' && <Opened back={{ label: 'You', onClick: () => setOpened(null) }}><Privacy /></Opened>}
            {opened === 'models' && <Opened back={{ label: 'Advanced', onClick: () => setOpened(null) }}><ModelsPage env={env} part="menu" /></Opened>}
            {opened === 'shortcuts' && <Opened back={{ label: 'Advanced', onClick: () => setOpened(null) }}><Shortcuts /></Opened>}
            {!opened && section === 'you' && <YouPage go={setOpened} />}
            {!opened && section === 'memory' && <MemoryPage />}
            {!opened && section === 'chats' && <ChatsPage env={env} />}
            {!opened && section === 'accounts' && <AccountsPage env={env} close={close} />}
            {!opened && section === 'tools' && <ToolsPage tab={tab} setTab={setTab} close={close} />}
            {!opened && section === 'advanced' && <AdvancedPage env={env} close={close} go={setOpened} />}
          </div>
        </SettingsNav.Provider>
      </DialogContent>
    </Dialog>
  );
}

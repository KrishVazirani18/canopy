// Settings kit: the one set of building blocks every Settings page is made of, so no two pages can drift apart.
//
// Every page has the same anatomy, top to bottom:
//   Page        the header (‹ back when it's a drill-in page, the title, the page's actions, close), an optional
//               toolbar under it (search, a filter, a tab switch), then the page's sections in one centered column.
//               The header's line shows only once the page scrolls.
//   Identity    the top of a page about one thing (Claude Code, Codex, a connector, a plugin, a skill, Canopy itself):
//               its mark, its name, one status line, and its actions. Glances, under it in the same card, roll the
//               page up into a few words each (Account, Updates…); one with somewhere to go jumps to its section.
//   Section     a titled card of rows, with an optional count beside the title and one optional line under it.
//   Row         what leads it (optional: an icon on a Tile, or a mark), a name, one line of detail, and on the right
//               a control, a status, or what says the row opens something: a chevron for a page of Settings, a word
//               and ↗ for something outside Canopy (System Settings, the Finder, the browser), ⌄ for more in place.
//   Tile        the rounded square a row's icon sits on, as in macOS's own settings: an ink line icon on a quiet
//               tile. (TileColor draws them in macOS's system colours instead; only the Playground turns it on.)
//   Status      neutral text. Only something that needs you gets color: one small amber dot. A page's own headline
//               may say all is well with one small green dot (`ready`).
//   Controls    Switch, Select (a pop-up menu), Segmented (a few views of one page), Button, IconButton, SearchField,
//               Field (a form input with its label), Value (a read-only value, click to copy).
//   States      Loading (placeholder rows), Problem (what went wrong, Try Again), Empty (one quiet line), ShowAll.
//
// Copy rules: no intro paragraphs; a row's detail is one line; a section's footer is one sentence. Buttons are
// title case ("Add Connector"); everything else is sentence case.
import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react';
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, RefreshCwIcon, SearchIcon, XIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

// ---------- the window's context ----------

/** How the page being drawn sits in the window. Settings has five pages; some show an older page's parts inside them:
 *  `embed`   the page is part of a bigger one: its header is the bigger page's, so only its sections are drawn
 *  `back`    the page was opened from another one (Privacy from You, the model menu from Advanced): ‹ goes back
 *  `title`, `toolbar`   the bigger page's title, and a tab switch above the page's own toolbar (Tools) */
export type Frame = { embed?: boolean; back?: { label: string; onClick: () => void }; title?: string; toolbar?: React.ReactNode };
export const PageFrame = createContext<Frame>({});

export type Nav = { close: () => void };
export const SettingsNav = createContext<Nav>({ close: () => {} });

/** A list page and the one item opened from it. Going back slides the other way. */
export function useDrill<T>() {
  const [open, setOpen] = useState<T | null>(null);
  const [dir, setDir] = useState<'in' | 'back' | undefined>(undefined);
  return { open, dir, go: (item: T) => { setDir('in'); setOpen(item); }, back: () => { setDir('back'); setOpen(null); } };
}

// ---------- page ----------

export function Page({ title, back, actions, toolbar, dir, children }: {
  title: string;
  /** A drill-in page: where ‹ goes back to. */
  back?: { label: string; onClick: () => void };
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  dir?: 'in' | 'back';
  children: React.ReactNode;
}) {
  const { close } = useContext(SettingsNav);
  const frame = useContext(PageFrame);
  const [scrolled, setScrolled] = useState(false);
  // A drill-in page keeps its own title and way back; the page itself takes the frame's.
  const own = !back;
  if (own && frame.title) title = frame.title;
  back ??= frame.back;
  if (own && frame.toolbar) toolbar = <>{frame.toolbar}{toolbar && <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">{toolbar}</div>}</>;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo({ top: 0 }); setScrolled(false); }, [title]);
  const column = 'mx-auto w-full max-w-2xl';
  if (frame.embed && own) return <div className="space-y-7">{children}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('relative shrink-0 border-b px-10 transition-colors', scrolled ? 'border-hairline' : 'border-transparent')}>
        <header className={cn(column, 'flex h-14 items-center gap-2')}>
          {back && (
            <button onClick={back.onClick} aria-label={`Back to ${back.label}`} title={back.label}
              className="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <ChevronLeftIcon className="size-4.5" />
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-title">{title}</h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        {/* Close sits in the window's corner; the page's own actions line up with the column's edge. */}
        <button onClick={close} aria-label="Close settings"
          className="absolute top-3.5 right-4 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <XIcon className="size-4" />
        </button>
        {toolbar && <div className={cn(column, 'flex items-center gap-2 pb-4')}>{toolbar}</div>}
      </div>
      <div ref={body} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)} className="min-h-0 flex-1 overflow-y-auto px-10 pt-2 pb-12">
        <div key={title} className={cn(column, 'space-y-7', dir === 'in' ? 'slide-in' : dir === 'back' ? 'slide-back' : 'enter-fade')}>{children}</div>
      </div>
    </div>
  );
}

// ---------- a tool's heading (on Accounts) ----------

/** One tool's heading on a page that has several: its mark, its name, and on the right how it stands (version). */
export function ToolHead({ mark, name, aside }: { mark: React.ReactNode; name: string; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <span className="flex size-5 items-center justify-center [&_svg]:size-4">{mark}</span>
      <h3 className="text-ui font-semibold">{name}</h3>
      {aside && <div className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-small text-muted-foreground">{aside}</div>}
    </div>
  );
}

// ---------- identity ----------

export function Identity({ mark, title, detail, actions, children }: {
  mark: React.ReactNode; title: React.ReactNode; detail?: React.ReactNode; actions?: React.ReactNode;
  /** Under the header, in the same card: the page's Glances. */
  children?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-card/50">
      <div className="flex items-center gap-4 p-4">
        {mark}
        <div className="min-w-0 flex-1">
          <div className="truncate text-heading">{title}</div>
          {detail && <div className="flex min-w-0 items-center gap-1.5 truncate text-small text-muted-foreground">{detail}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="border-t border-hairline">{children}</div>}
    </div>
  );
}

/** One thing a page says about itself at a glance. `busy`: being worked out or done right now. */
export type Glance = { label: string; value: string; tone?: Tone | 'busy'; onClick?: () => void };
/** A page rolled up, under its Identity: each glance is a name and where it stands, in a word or two. One with
 *  `onClick` goes to its section. A check for what is fine, the amber dot for what needs you. */
export function Glances({ items }: { items: Glance[] }) {
  if (!items.length) return null;
  const cell = 'min-w-0 px-4 py-2.5 text-left';
  return (
    <div className="grid divide-x divide-hairline" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((g) => {
        const body = (
          <>
            <span className="block truncate text-small text-muted-foreground">{g.label}</span>
            <span className={cn('mt-0.5 flex min-w-0 items-center gap-1.5 text-ui', g.tone === 'off' || g.tone === 'busy' ? 'text-muted-foreground' : 'text-foreground')}>
              {g.tone === 'attention' ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
                : g.tone === 'busy' ? <Spinner className="size-3 shrink-0" />
                : g.tone === 'off' ? null
                : <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2.25} />}
              <span className="truncate">{g.value}</span>
            </span>
          </>
        );
        return g.onClick
          ? <button key={g.label} type="button" onClick={g.onClick} className={cn(cell, 'transition-colors duration-100 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none')}>{body}</button>
          : <div key={g.label} className={cell}>{body}</div>;
      })}
    </div>
  );
}

/** The square a thing is shown by: its logo or icon, or the first letter of its name. */
export function Mark({ name, icon, size = 'sm' }: { name?: string; icon?: React.ReactNode; size?: 'sm' | 'lg' }) {
  const letter = (name ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '·';
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center justify-center border border-hairline bg-background font-semibold text-muted-foreground',
      size === 'lg' ? 'size-11 rounded-[11px] text-[16px] [&>svg]:size-5' : 'size-7 rounded-[7px] text-small [&>svg]:size-3.5')}>
      {icon ?? letter}
    </span>
  );
}

/** The colours a tile takes when tiles are drawn in colour: macOS's own system colours, light and dark. */
export type Tint = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'gray';
const TINT: Record<Tint, string> = {
  blue: 'bg-[#007aff] dark:bg-[#0a84ff]', green: 'bg-[#34c759] dark:bg-[#30d158]', orange: 'bg-[#ff9500] dark:bg-[#ff9f0a]',
  red: 'bg-[#ff3b30] dark:bg-[#ff453a]', purple: 'bg-[#af52de] dark:bg-[#bf5af2]', gray: 'bg-[#8e8e93] dark:bg-[#636366]',
};
/** Are tiles drawn in colour? No, anywhere in Canopy: colour is kept for the one small thing that needs you. The
 *  Playground turns it on for one copy of a page, to set the two looks side by side. */
export const TileColor = createContext(false);

/** The rounded square a row's icon sits on: an ink line icon on a quiet tile, the size of an account's mark. */
export function Tile({ icon, tint }: { icon: React.ReactNode; tint?: Tint }) {
  const color = useContext(TileColor) && tint ? TINT[tint] : null;
  return (
    <span aria-hidden className={cn('flex size-8 shrink-0 items-center justify-center rounded-[7px] [&>svg]:size-4 [&>svg]:stroke-[1.75]',
      color ? cn(color, 'text-white shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.22)]') : 'bg-foreground/[0.05] text-foreground/80')}>
      {icon}
    </span>
  );
}

// ---------- section and row ----------

export function Section({ id, title, count, aside, footer, children }: {
  /** For a link from elsewhere on the page (a glance): where to scroll to. */
  id?: string; title?: string; count?: number | string; aside?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-3 space-y-2">
      {(title || aside) && (
        <div className="flex min-h-5 items-end gap-2 px-1">
          {title && <h3 className="text-label text-muted-foreground">{title}</h3>}
          {count != null && <span className="text-small text-faint tabular-nums">{count}</span>}
          {aside && <div className="ml-auto flex items-center gap-3">{aside}</div>}
        </div>
      )}
      <div className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-card/50">{children}</div>
      {footer && <p className="px-1 text-small text-faint">{footer}</p>}
    </section>
  );
}

/** What a row you can click does, said at its right edge: `page` opens a page of Settings (›), `outside` opens
 *  something that is not Canopy (↗, after `action` when the row gives one), `more` and `less` unfold it in place. */
export type Opens = 'page' | 'outside' | 'more' | 'less';

export function Row({ lead, icon, tint, label, detail, children, onClick, opens = 'page', action, muted, title }: {
  lead?: React.ReactNode;
  /** A line icon, drawn on a Tile. `tint`: the tile's colour where tiles are drawn in colour (TileColor). */
  icon?: React.ReactNode; tint?: Tint;
  label: React.ReactNode; detail?: React.ReactNode; children?: React.ReactNode;
  onClick?: () => void; opens?: Opens;
  /** With `opens="outside"`: what clicking does, in a word or two ("Open", "Show in Finder"). */
  action?: string;
  muted?: boolean; title?: string;
}) {
  const body = (
    <>
      {icon ? <Tile icon={icon} tint={tint} /> : lead}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-ui', muted && 'text-muted-foreground')}>{label}</div>
        {detail && <div className="flex min-w-0 items-center gap-1.5 truncate text-small text-muted-foreground">{detail}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>{children}</div>}
      {onClick && (opens === 'outside' ? (
        <span className="flex shrink-0 items-center gap-1 text-small text-muted-foreground transition-colors group-hover/row:text-foreground group-focus-visible/row:text-foreground">
          {action}<ArrowUpRightIcon className="size-3.5 text-faint" />
        </span>
      ) : opens === 'page' ? <ChevronRightIcon className="size-4 shrink-0 text-faint" />
        : <ChevronDownIcon className={cn('size-4 shrink-0 text-faint transition-transform duration-150', opens === 'less' && 'rotate-180')} />)}
    </>
  );
  // A row led by a tile is as tall as one with two lines of words, whatever it says: the tiles keep one rhythm.
  const cls = cn('flex w-full items-center gap-3 px-4 py-2.5 text-left', icon ? 'min-h-14' : 'min-h-12');
  return onClick
    ? <div role="button" tabIndex={0} title={title} onClick={onClick} aria-expanded={opens === 'more' ? false : opens === 'less' ? true : undefined}
        onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
        className={cn(cls, 'group/row cursor-default transition-colors duration-100 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none')}>{body}</div>
    : <div className={cls} title={title}>{body}</div>;
}

/** A label on the left and its value on the right (Address, Version…). */
export function Pair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-4 px-4 py-2 text-ui">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className="ml-auto flex min-w-0 justify-end text-right">{children}</div>
    </div>
  );
}

// ---------- status ----------

export type Tone = 'ok' | 'attention' | 'off';
/** Neutral text; something that needs you gets one amber dot. `ready`: a page's headline saying all is well, with
 *  one green dot (once on a page, never on a row). Words too long for where they are end in an ellipsis. */
export function Status({ tone = 'ok', children }: { tone?: Tone | 'ready'; children: React.ReactNode }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5 text-small', tone === 'off' ? 'text-faint' : tone === 'attention' ? 'text-foreground/85' : 'text-muted-foreground')}>
      {(tone === 'attention' || tone === 'ready') && <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', tone === 'ready' ? 'bg-brand' : 'bg-warn')} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

// ---------- controls ----------

/** The look of a button and of a pop-up menu's button. For a button that has to be its own element (one a menu or a
 *  tooltip is hung on, one with a name of its own for a screen reader); everything else uses Button. */
export const control = 'flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-background px-2.5 text-small text-foreground transition-colors hover:border-foreground/25 data-[state=open]:border-foreground/30 disabled:pointer-events-none disabled:opacity-50';

export function Button({ children, onClick, disabled, busy, primary }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; busy?: boolean; primary?: boolean }) {
  // `primary` only for the one button that submits a form (Add Connector). Everything else is plain.
  return (
    <button onClick={onClick} disabled={disabled || busy}
      className={cn(control, primary && 'border-transparent bg-foreground font-medium text-background hover:border-transparent hover:opacity-90')}>
      {busy && <Spinner className="size-3" />}{children}
    </button>
  );
}

export function IconButton({ label, onClick, children, disabled }: { label: string; onClick?: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} disabled={disabled}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&>svg]:size-3.5">
      {children}
    </button>
  );
}

export function Refresh({ busy, onClick }: { busy?: boolean; onClick?: () => void }) {
  return <IconButton label="Check Again" onClick={onClick} disabled={busy}><RefreshCwIcon className={cn(busy && 'animate-spin')} /></IconButton>;
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={cn('flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-50', on ? 'bg-foreground' : 'bg-muted-foreground/30')}>
      <span className={cn('size-[18px] rounded-full bg-background shadow transition-transform duration-200 ease-drawer', on && 'translate-x-4')} />
    </button>
  );
}

/** One choice in a Select. `heading` starts a titled group; `separatorBefore` starts an untitled one. */
export type Option<T extends string> = { value: T; label: string; detail?: string; lead?: React.ReactNode; heading?: string; separatorBefore?: boolean };
/** A pop-up menu: the choice on the button, every option with a check by the chosen one. */
export function Select<T extends string>({ value, options, onChange, label, width = 'w-56', lead }: {
  value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; width?: string; lead?: React.ReactNode;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={label} className={control}>
        {lead ?? current?.lead}<span className="max-w-48 truncate">{current?.label ?? label}</span><ChevronDownIcon className="size-3.5 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={width}>
        {options.map((o, i) => (
          <Fragment key={o.value}>
            {i > 0 && (o.heading || o.separatorBefore) && <DropdownMenuSeparator />}
            {o.heading && <DropdownMenuLabel>{o.heading}</DropdownMenuLabel>}
            <DropdownMenuItem onSelect={() => onChange(o.value)} className="items-start gap-2 py-1.5">
              {o.lead && <span className="mt-0.5 shrink-0">{o.lead}</span>}
              <span className="min-w-0 flex-1 leading-tight">
                <span className={cn('block truncate', o.value === value && 'font-medium')}>{o.label}</span>
                {o.detail && <span className="mt-0.5 block text-small text-muted-foreground">{o.detail}</span>}
              </span>
              <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0', o.value !== value && 'invisible')} />
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A few views of one page (Installed, Browse, Marketplaces). */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex h-8 shrink-0 rounded-lg bg-muted p-0.5 text-small">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('rounded-md px-3 transition-colors', value === o.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{o.label}</button>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block min-w-0 flex-1">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }}
        className="h-8 w-full rounded-lg border border-hairline bg-background pr-3 pl-8 text-ui outline-none placeholder:text-faint focus:border-foreground/30" />
    </label>
  );
}

export const input = 'h-9 w-full rounded-lg border border-hairline bg-background px-3 text-ui outline-none placeholder:text-faint focus:border-foreground/30';
/** A form input with its label above it. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block px-4 py-3"><span className="mb-1.5 block text-small text-muted-foreground">{label}</span>{children}</label>;
}

/** A value you only read (a path, an address, a version). Click to copy. */
export function Value({ text, shown, mono = true }: { text: string; shown?: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <button onClick={copy} title="Copy" className={cn('group flex max-w-80 min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground', mono ? 'font-mono text-code' : 'text-small')}>
      <span className="truncate">{copied ? 'Copied' : shown ?? text}</span>
      {copied ? <CheckIcon className="size-3.5 shrink-0" /> : <CopyIcon className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />}
    </button>
  );
}

// ---------- states ----------

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <Section>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="flex h-12 items-center gap-3 px-4">
          <span className="size-7 shrink-0 animate-pulse rounded-[7px] bg-muted" />
          <span className="flex-1 space-y-1.5">
            <span className="block h-2.5 animate-pulse rounded bg-muted" style={{ width: `${30 + ((i * 37) % 35)}%` }} />
            <span className="block h-2 w-1/2 animate-pulse rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </Section>
  );
}

export function Problem({ children, onRetry }: { children: React.ReactNode; onRetry?: () => void }) {
  return (
    <Section>
      <Row label={children} lead={<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />}>
        {onRetry && <Button onClick={onRetry}>Try Again</Button>}
      </Row>
    </Section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <Section><p className="px-4 py-7 text-center text-small text-faint">{children}</p></Section>;
}

/** The last row of a long section. */
export function ShowAll({ open, count, onClick }: { open: boolean; count: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex h-10 w-full items-center px-4 text-small text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground">
      {open ? 'Show Fewer' : `Show All ${count}`}
    </button>
  );
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

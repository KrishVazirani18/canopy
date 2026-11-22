// Right panel: Stats (the basics), Changes (what this chat edited, with the branch it's on), Usage (the account in
// use: its plan's limits, or what it has spent; usage-panel.tsx) and Terminal. Everything else lives where you already look: model, effort and mode on the composer chips; context,
// cost and the chat ID in the chat menu (click the title); connectors in Settings.
import { memo, useEffect, useMemo, useState } from 'react';
import { BarChart3Icon, ChevronRightIcon, FileDiffIcon, GaugeIcon, GitBranchIcon, SquareTerminalIcon, XIcon } from 'lucide-react';
import { Reveal } from './reveal';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, type EnvInfo } from '@/lib/api';
import { useEngine, useStore, type Item, type ToolItem } from '@/lib/store';
import { ui, useUi, type InspectorTab } from '@/lib/ui';
import { cn } from '@/lib/utils';
import { TerminalPane } from './terminal-view';
import { UsagePanel } from './usage-panel';
import { ContextMeter, chatFacts, useChatTotals } from './chat-vitals';
import { structuredPatch } from 'diff';
import { EDIT_TOOLS, editStats } from './tool-details';
import { diffRows } from '@/lib/engine-rules';

/** Edits that landed, at any depth (subagents included). Running, waiting-for-approval and failed
 *  edits are not changes yet. */
function collectEdits(items: Item[], out: ToolItem[] = []) {
  for (const it of items) {
    if (it.t !== 'tool') continue;
    if (EDIT_TOOLS.has(it.name) && it.status === 'done') out.push(it);
    if (it.children.length) collectEdits(it.children, out);
  }
  return out;
}

type FileChange = { add: number; del: number; edits: ToolItem[] };
/** Landed edits grouped by file, in the order each file was first changed. */
function changedFiles(items: Item[]): [string, FileChange][] {
  const m = new Map<string, FileChange>();
  for (const e of collectEdits(items)) {
    const s = editStats(e.name, e.input);
    if (!s) continue;
    const cur = m.get(s.file);
    if (cur) { cur.add += s.add; cur.del += s.del; cur.edits.push(e); }
    else m.set(s.file, { add: s.add, del: s.del, edits: [e] });
  }
  return [...m];
}

/** A cheap signature of the conversation's shape. The store mutates items in place and bumps `rev`
 *  on an item and its ancestors, so the top-level tool revs move whenever a tool at any depth starts,
 *  finishes, fails or gains a child, while `items` itself only changes identity on a top-level push.
 *  Streaming text bumps nothing but its own item. Work memoised on [items, structureRev(items)]
 *  therefore re-runs when the shape changes and skips every text frame. */
function structureRev(items: Item[]) {
  let n = 0;
  for (const it of items) if (it.t === 'tool') n += it.rev;
  return n;
}

/** Stats: the chat menu's view, given room. How full the chat is, then what it has done, in plain lines. */
function Stats() {
  const { meta, items } = useStore();
  const rev = structureRev(items);
  // Items are mutated in place: `rev` is what says their contents moved.
  const files = useMemo(() => changedFiles(items), [items, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  let add = 0, del = 0;
  for (const [, f] of files) { add += f.add; del += f.del; }
  const totals = useChatTotals();
  const facts = chatFacts(totals, items.filter((i) => i.t === 'user').length, { n: files.length, add, del });
  const hasCtx = meta.ctxTokens != null && !!meta.ctxMax;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <ContextMeter />
      {facts.length > 0 && (
        <ul className={cn('space-y-2 text-ui text-muted-foreground [&_b]:font-medium [&_b]:text-foreground [&_b]:tabular-nums', hasCtx && 'mt-6')}>
          {facts.map((f) => <li key={f.key}>{f.text}</li>)}
        </ul>
      )}
      {!hasCtx && !facts.length && <p className="text-ui text-faint">Nothing yet. This fills in as Canopy works.</p>}
    </div>
  );
}

const sameEdits = (a: ToolItem[], b: ToolItem[]) => a === b || (a.length === b.length && a.every((e, i) => e.key === b[i].key));

/** One changed file. A landed edit never changes again, so the same edit keys mean the same counts
 *  and the same diffs: regrouping the chat re-renders only the files that gained an edit. */
const ChangedFile = memo(function ChangedFile({ file, add, del, edits, defaultOpen }: { file: string; add: number; del: number; edits: ToolItem[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const parts = file.split('/');
  return (
    <div className="mb-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui hover:bg-accent', open && 'bg-accent/60')}>
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate">{parts.at(-1)}<span className="ml-1.5 text-small text-faint">{parts.slice(-3, -1).join('/')}</span></span>
        <span className="w-9 shrink-0 text-right text-small tabular-nums text-good">+{add}</span>
        <span className="w-9 shrink-0 text-right text-small tabular-nums text-destructive">{del > 0 ? `−${del}` : ''}</span>
      </button>
      <Reveal show={open}>
        <div className="space-y-2 px-1 pt-1.5 pb-2">{edits.map((e) => <CompactDiff key={e.key} name={e.name} input={e.input} />)}</div>
      </Reveal>
    </div>
  );
}, (a, b) => a.file === b.file && a.defaultOpen === b.defaultOpen && sameEdits(a.edits, b.edits));

function Changes({ cwd }: { cwd: string }) {
  const { items } = useStore();
  const { focusFile } = useUi();
  const rev = structureRev(items);
  // Items are mutated in place: `rev` is what says a subagent's edit arrived or an edit finished or failed.
  const files = useMemo(() => changedFiles(items), [items, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let current = true; // a slow answer for the previous folder must not overwrite this one
    api.gitInfo(cwd).then((g) => { if (current) setBranch(g?.branch ?? null); }).catch(() => { if (current) setBranch(null); });
    return () => { current = false; };
  }, [cwd, files.length]);
  let add = 0, del = 0;
  for (const [, f] of files) { add += f.add; del += f.del; }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-4 text-small text-muted-foreground">
        {branch && <><GitBranchIcon className="size-3.5 shrink-0" /><code className="min-w-0 truncate font-mono text-code text-foreground/85">{branch}</code></>}
        <span className="ml-auto shrink-0 tabular-nums">
          {files.length ? <>{files.length} file{files.length === 1 ? '' : 's'} <span className="ml-1 text-good">+{add}</span> <span className="text-destructive">−{del}</span></> : 'No changes yet'}
        </span>
      </div>
      {files.length
        ? <div className="min-h-0 flex-1 overflow-y-auto p-2">{files.map(([f, x]) => <ChangedFile key={f} file={f} add={x.add} del={x.del} edits={x.edits} defaultOpen={!!focusFile && f === focusFile} />)}</div>
        : <p className="p-4 text-ui text-muted-foreground">Files this chat edits show up here, with their diffs.</p>}
    </div>
  );
}

type DiffLine = { k: '+' | '-' | ' ' | '@'; t: string };
const DIFF_LIMIT = 40;
const text = (v: unknown) => (typeof v === 'string' ? v : '');

function diffLines(name: string, input: Record<string, unknown>): DiffLine[] {
  if (name === 'Write') return text(input.content).split('\n').map((t): DiffLine => ({ k: '+', t }));
  // An OpenAI edit carries its own diff (hunks only): shown as it came, not rebuilt from its two sides.
  if (name === 'Edit' && text(input.diff).trim()) return diffRows(input.diff);
  const file = text(input.file_path);
  const pairs: { old_string?: unknown; new_string?: unknown }[] = name === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []) : name === 'Edit' ? [input] : [];
  const lines: DiffLine[] = [];
  for (const e of pairs) {
    for (const h of structuredPatch(file, file, text(e?.old_string), text(e?.new_string), '', '', { context: 2 }).hunks) {
      lines.push({ k: '@', t: `Line ${h.newStart}` });
      for (const l of h.lines) {
        if (l[0] === '\\') continue; // "\ No newline at end of file": true of every snippet, and not a change
        lines.push({ k: l[0] === '+' || l[0] === '-' ? l[0] : ' ', t: l.slice(1) });
      }
    }
  }
  return lines;
}

/** Dense, readable diff: small mono, wrapped lines (no sideways scrolling), +/− tinted rows,
 *  quiet hunk markers. New files show the first lines with "Show all". Memoised on the tool call's
 *  name and its input object (which the store never replaces), so an open diff is computed once. */
const CompactDiff = memo(function CompactDiff({ name, input }: { name: string; input: Record<string, unknown> }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => diffLines(name, input), [name, input]);
  const shown = all ? lines : lines.slice(0, DIFF_LIMIT);
  return (
    <div className="overflow-hidden rounded-md border border-hairline font-mono text-[11px] leading-[17px]">
      {name === 'Write' && <div className="border-b border-hairline px-2.5 py-1 font-sans text-micro text-muted-foreground">New file · {lines.length} lines</div>}
      {shown.map((l, i) => l.k === '@'
        ? <div key={i} className="bg-muted/50 px-2.5 py-0.5 font-sans text-micro text-faint">{l.t}</div>
        : (
          <div key={i} className={cn('flex gap-2 px-2.5', l.k === '+' && 'bg-good/10', l.k === '-' && 'bg-destructive/10')}>
            <span className={cn('w-2 shrink-0 select-none', l.k === '+' ? 'text-good' : l.k === '-' ? 'text-destructive' : 'text-faint')}>{l.k === ' ' ? '' : l.k === '-' ? '−' : '+'}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground/85">{l.t || ' '}</span>
          </div>
        ))}
      {lines.length > DIFF_LIMIT && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-hairline py-1 font-sans text-micro text-muted-foreground hover:bg-accent hover:text-foreground">
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
});

// Three tabs, words only. The terminal isn't a tab: the button next to the chat title (⌘J) opens it here on its own.
const TABS: { id: InspectorTab; label: string; icon: typeof XIcon }[] = [
  { id: 'stats', label: 'Stats', icon: BarChart3Icon }, { id: 'changes', label: 'Changes', icon: FileDiffIcon }, { id: 'usage', label: 'Usage', icon: GaugeIcon },
];
const tabId = (id: InspectorTab) => `inspector-tab-${id}`;
const PANEL_ID = 'inspector-panel';

export function Inspector({ cwd, onTerminalDone }: { cwd: string; env?: EnvInfo | null; onTerminalDone: (sessionId: string | null) => void }) {
  const { tab: saved } = useUi();
  // The terminal is Claude Code's own: an OpenAI chat has none, so the panel shows Changes instead.
  const noTerminal = useEngine() === 'codex';
  const tab: InspectorTab = (saved === 'terminal' && !noTerminal) || saved === 'stats' || saved === 'usage' ? saved : 'changes';
  // One tab stop for the strip: the arrow keys (and Home / End) move between tabs and select as they go.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const i = TABS.findIndex((t) => t.id === tab);
    const last = TABS.length - 1;
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i <= 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    ui.set({ tab: TABS[next].id });
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <aside className="flex h-full w-full flex-col bg-sidebar-solid">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        {tab === 'terminal' ? (
          <div className="flex min-w-0 items-center gap-2 px-1.5 text-small text-foreground"><SquareTerminalIcon className="size-3.5 text-muted-foreground" />Terminal</div>
        ) : (
        <div role="tablist" aria-label="Panel" onKeyDown={onTabKey} className="flex min-w-0 items-center gap-0.5">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={tabId(t.id)} aria-selected={tab === t.id} aria-controls={PANEL_ID} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => ui.set({ tab: t.id })}
              className={cn('flex h-7 items-center rounded-md px-2.5 text-small transition-colors duration-100', tab === t.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {t.label}
            </button>
          ))}
        </div>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => ui.set({ inspector: false })} aria-label="Close panel"
              className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <XIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close panel<Kbd>⌘I</Kbd></TooltipContent>
        </Tooltip>
      </div>
      <div role="tabpanel" id={PANEL_ID} aria-labelledby={tabId(tab)} className="flex min-h-0 flex-1 flex-col">
        {tab === 'stats' && <Stats />}
        {tab === 'changes' && <Changes cwd={cwd} />}
        {tab === 'usage' && <UsagePanel />}
        {tab === 'terminal' && <TerminalPane onDone={onTerminalDone} />}
      </div>
    </aside>
  );
}

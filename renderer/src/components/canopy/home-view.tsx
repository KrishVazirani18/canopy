// Home: the control panel for everything Canopy is doing, across every chat and project.
// The board reads left to right: Needs you (answer right on the card), Working (what each chat is doing now), Done today
// (what you got: an answer, changed files, a pull request). Docked under it is today, like GitHub's contribution graph
// for one day: a row of quarter hours, darker where Claude worked more, under a sentence with the day's working time
// and cost.
// Colour is state, never decoration: amber = needs you, green = finished or now, everything else is grey.
// The three columns are always there, side by side; an empty one rests with a quiet line in its own space.
import { workflowProgress } from '@/lib/workflow-progress';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRightIcon, CheckIcon, SquareIcon, FileDiffIcon, GitPullRequestIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, type HomeDay, type SessionSummary } from '@/lib/api';
import { chats as chatStatus, useChatStatus } from '@/lib/chats';
import { homeAvailable, homeRespond, homeStop, homeStopTasks, useHome, useHomeDay, type HomeAsk, type HomeChat } from '@/lib/home';
import { useStore } from '@/lib/store';
import { useMarkedUnread } from '@/lib/unread';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';
import { projectName } from '@/lib/project-name';

type Recent = SessionSummary & { dir: string };
type Hot = { hot: string | null }; // the chat under the pointer (see HomeView): its card lights up

const MIN = 60_000, HOUR = 60 * MIN;
const projectOf = (cwd: string | null, chatsDir: string | null) => (!cwd ? '' : cwd === chatsDir ? 'No project' : projectName(cwd));
const greeting = (d = new Date()) => (d.getHours() < 5 ? 'Good evening' : d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "2:41 PM" */
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** How long something took or has been going: "45 sec", "6 min", "1 hr 12 min". */
function lasted(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${Math.floor(m / 60)} hr`;
}
/** A reply's first line as plain words: no Markdown marks. */
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/^\s*(#+|[-*>])\s+/, '');
// Small counts read as words in a sentence ("Two chats are working").
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n: number) => WORDS[n] ?? String(n);

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  return now;
}

const open = (sessionId: string, cwd: string | null) => {
  ui.set({ view: 'chat' });
  if (cwd) window.dispatchEvent(new CustomEvent('canopy:open-chat', { detail: { sessionId, cwd } }));
};
/** A card, row or track that opens its chat: click, Enter or Space (but not from a button inside it).
 *  data-chat is how Home knows which chat the pointer is over. */
const opens = (sessionId: string, cwd: string | null) => ({
  role: 'button' as const, tabIndex: 0, 'data-chat': sessionId,
  onClick: () => open(sessionId, cwd),
  onKeyDown: (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(sessionId, cwd); } },
});

/** The same thin turning ring the sidebar and the message box use for "working". Always beside words that say so. */
const Ring = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn('size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/60 border-t-transparent [animation-duration:900ms]', className)} />
);

// ---------- the clock ----------

/** Top right of Home: one desk-calendar block, the time and the date side by side under a shared binding strip.
 *  The colon ticks with the seconds; while you scrub the timeline the time shows that moment in brand green and holds still. */
function DeskClock({ t, live }: { t: number; live: boolean }) {
  const d = new Date(t);
  const [hm, half = ''] = clock(t).split(/\s+/); // "4:51", "PM"
  const [hh, mm] = hm.split(':');
  const zone = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? '';
  const full = `${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · ${clock(t)}`;
  const cell = 'flex flex-col items-center px-3';
  const strip = 'flex h-[15px] items-center text-[8.5px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase';
  const big = 'mt-[5px] text-[19px] leading-[20px] font-semibold tracking-[-0.03em] tabular-nums';
  const under = 'mt-px text-[8.5px] leading-[10px] font-medium tracking-[0.08em] text-faint uppercase';
  return (
    <div role="img" title={full} aria-label={full}
      className="enter-fade relative flex h-[54px] shrink-0 overflow-hidden rounded-[10px] border border-foreground/[0.1] bg-gradient-to-b from-card to-background shadow-[inset_0_1px_0_rgb(255_255_255/0.04),0_1px_2px_rgb(0_0_0/0.2)]">
      {/* the binding strip runs across both */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-[15px] border-b border-foreground/[0.06] bg-foreground/[0.05]" />
      <div className={cell}>
        <span className={cn(strip, 'relative')}>{half || (live ? 'Now' : 'Then')}</span>
        <span className={cn(big, !live && 'text-brand')}>
          {hh}<span className={cn('mx-px inline-block -translate-y-px transition-opacity duration-300', live && d.getSeconds() % 2 && 'opacity-30')}>:</span>{mm}
        </span>
        <span className={under}>{zone}</span>
      </div>
      <span aria-hidden className="relative mt-[15px] w-px bg-foreground/[0.07]" />
      <div className={cell}>
        <span className={cn(strip, 'relative')}>{d.toLocaleDateString([], { month: 'short' })}</span>
        <span className={big}>{d.getDate()}</span>
        <span className={under}>{d.toLocaleDateString([], { weekday: 'short' })}</span>
      </div>
    </div>
  );
}

// ---------- the board ----------

/** A column's mark is the sidebar's own status mark for that state, so one vocabulary runs through the app
 *  (and the timeline below needs no legend). With nothing in the column it rests as a faint outline. */
function Mark({ kind, on }: { kind: 'needs' | 'working' | 'done'; on: boolean }) {
  return (
    <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
      {kind === 'working'
        ? (on ? <Ring /> : <span className="size-3 rounded-full border-[1.5px] border-foreground/15" />)
        : <span className={cn('size-2 rounded-full', !on ? 'border-[1.5px] border-foreground/15' : kind === 'needs' ? 'home-ask bg-warn' : 'bg-good')} />}
    </span>
  );
}

function Column({ kind, title, count, empty, className, children }: { kind: 'needs' | 'working' | 'done'; title: string; count: number; empty: string; className?: string; children?: React.ReactNode }) {
  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col', className)} aria-label={`${title}: ${count}`}>
      <header className="flex h-7 shrink-0 items-center gap-2.5 border-b border-hairline pb-2">
        <Mark kind={kind} on={count > 0} />
        <h2 className={cn('text-ui font-semibold transition-colors duration-300', !count && 'text-muted-foreground')}>{title}</h2>
        {count > 0 && <span key={count} className="roll-in ml-auto text-small tabular-nums text-faint">{count}</span>}
      </header>
      {/* Side by side, each column scrolls on its own under its title, with no scrollbar showing (stacked, the page scrolls as one). */}
      {count ? <div className="min-h-0 flex-1 pb-4 @[760px]:overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div> : (
        <div className="enter-fade flex min-h-[132px] flex-col items-center justify-center gap-2.5 text-center">
          <Mark kind={kind} on={false} />
          <p className="max-w-[220px] text-small text-faint">{empty}</p>
        </div>
      )}
    </section>
  );
}

const cardBase = 'group/card relative cursor-pointer rounded-xl border bg-card p-4 enter-up [--rise:8px] transition-[border-color] duration-200';
/** The top line every card and row shares: where it is on the left, when on the right. */
const eyebrow = 'flex min-h-4 items-center gap-3 text-small text-faint';
const cardTitle = 'mt-1 line-clamp-2 text-heading leading-[22px] text-pretty';

/** What Canopy is asking, as one plain question. */
function askLine(a: HomeAsk | null) {
  if (!a) return 'Canopy is waiting for you.';
  if (a.kind === 'question') return 'Canopy has a question for you.';
  if (a.kind === 'plan') return 'Canopy has a plan for you to look over.';
  if (a.kind === 'elicitation') return a.title || a.message || `${a.toolName ?? 'A connected tool'} needs a few details from you.`;
  if (a.title) return a.title.replace(/\bClaude\b/g, 'Canopy');
  const t = a.toolName ?? '';
  if (t === 'Bash') return 'Can Canopy run this command?';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(t)) return 'Can Canopy change this file?';
  if (t === 'Read') return 'Can Canopy read this file?';
  if (t === 'WebFetch') return 'Can Canopy open this page?';
  if (t === 'WebSearch') return 'Can Canopy search the web for this?';
  if (t.startsWith('mcp__')) return `Can Canopy use ${t.split('__')[1]}?`;
  return t ? `Can Canopy use ${t}?` : 'Can Canopy go ahead?';
}

type CardProps = { c: HomeChat; title: string; project: string; now: number; i: number } & Hot;

/** Every column is one grouped panel of rows, and every row has the same shape: a status icon, the title, a quiet
 *  "project · when" line, then whatever that state needs (the question and its answer buttons; what it's doing). */
// Every row is the same height (the tallest kind: a finished chat with its result and chips), so the columns line up.
function RowShell({ id, cwd, lit, i, icon, title, meta, children }: { id: string; cwd: string | null; lit: boolean; i: number; icon: React.ReactNode; title: string; meta: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div {...opens(id, cwd)} style={{ animationDelay: `${60 + Math.min(i, 8) * 35}ms` }}
      className={cn('group/row relative flex min-h-[122px] cursor-pointer gap-3 px-4 py-3 enter-up [--rise:6px] transition-colors duration-150 hover:bg-foreground/[0.035]', lit && 'bg-foreground/[0.035]')}>
      <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate pr-8 text-ui font-medium">{title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-small text-faint tabular-nums">{meta}</div>
        {children}
      </div>
    </div>
  );
}
const iconBadge = (tone: 'warn' | 'good' | 'quiet') => cn('flex size-[18px] items-center justify-center rounded-full', tone === 'warn' ? 'bg-warn/[0.16] text-warn' : tone === 'good' ? 'bg-good/[0.14] text-good' : 'bg-foreground/[0.07] text-faint');

function NeedCard({ c, title, project, now, i, hot }: CardProps) {
  const a = c.ask;
  const tool = a?.kind === 'tool';
  // Your answer shows at once; the row leaves when the chat moves on. If it's still here after a while, ask again.
  const [sent, setSent] = useState<'allow' | 'deny' | null>(null);
  useEffect(() => { if (!sent) return; const id = setTimeout(() => setSent(null), 8000); return () => clearTimeout(id); }, [sent]);
  const answer = (action: 'allow' | 'deny') => { if (!a) return; setSent(action); homeRespond(c.sid, a.id, { action }); };
  const waited = !a ? 'waiting' : now - a.since >= MIN ? `waiting ${lasted(now - a.since)}` : 'just asked';
  return (
    <RowShell id={c.sessionId} cwd={c.cwd} lit={hot === c.sessionId} i={i} title={title}
      icon={<span className={iconBadge('warn')}><span className="home-ask size-1.5 rounded-full bg-warn" /></span>}
      meta={<><span className="truncate">{project}</span><span className="shrink-0 text-warn">· {waited}</span></>}>
      <p className="mt-2 text-small text-muted-foreground">{askLine(a)}</p>
      {tool && a?.detail && (
        <code className="mt-1.5 line-clamp-3 block rounded-md bg-[var(--code-bg)] px-2.5 py-1.5 font-mono text-code [overflow-wrap:anywhere] text-foreground/90" onClick={(e) => e.stopPropagation()}>
          {a.toolName === 'Bash' && <span className="text-faint select-none">$ </span>}{a.detail.replace(/^\/Users\/[^/]+/, '~')}
        </code>
      )}
      <div className="mt-2.5 flex h-7 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {sent ? (
          <span className="enter-fade flex items-center gap-2 text-small text-muted-foreground"><Ring className="size-2.5" />{sent === 'allow' ? 'Allowed. Canopy is carrying on.' : 'Skipped. Canopy is carrying on without it.'}</span>
        ) : tool && a ? (
          <>
            <Button size="sm" className="h-7 min-w-[72px] rounded-md" onClick={() => answer('allow')}>Allow</Button>
            <Button size="sm" variant="secondary" className="h-7 min-w-[72px] rounded-md" onClick={() => answer('deny')}>Not now</Button>
          </>
        ) : (
          <Button size="sm" className="h-7 rounded-md" onClick={() => open(c.sessionId, c.cwd)}>{a?.kind === 'plan' ? 'Look over the plan' : a?.kind === 'question' ? 'Answer in the chat' : 'Open the chat'}</Button>
        )}
      </div>
    </RowShell>
  );
}

type Agent = { key: string; label: string; phase: string | null; done: boolean };
/** A chat's workflow agents, from Claude Code's journal; refreshed while it runs. */
function useTeam(c: HomeChat, on: boolean) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [phases, setPhases] = useState<string[]>([]);
  useEffect(() => {
    if (!on || !api.workflowAgents) return;
    let live = true;
    const load = () => api.workflowAgents!(c.cwd, c.sessionId).then((r) => { if (live && r) { setAgents(r.agents); setPhases(r.phases ?? []); } }).catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => { live = false; clearInterval(id); };
  }, [on, c.cwd, c.sessionId]);
  return { agents, phases };
}
/** "scout:third-party" → "third party" */
const agentName = (label: string) => label.replace(/^[^:]+:\s*/, '').replace(/[-_:]/g, ' ');
const listed = (names: string[]) => (names.length <= 1 ? names.join('') : names.length === 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`);

function StopOnHover({ onStop, confirm }: { onStop: () => void; confirm: boolean }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (!asking) return; const id = setTimeout(() => setAsking(false), 3000); return () => clearTimeout(id); }, [asking]);
  return (
    <button type="button" aria-label={asking ? 'Stop: click again to confirm' : 'Stop'} title={confirm ? 'Stop this workflow' : 'Stop this reply (workflows keep running)'}
      onClick={(e) => { e.stopPropagation(); if (confirm && !asking) { setAsking(true); return; } setAsking(false); onStop(); }}
      className={cn('press absolute top-3 right-3 flex h-7 items-center justify-center gap-1.5 rounded-full transition-[opacity,background-color,color] duration-150 focus-visible:opacity-100',
        asking ? 'bg-destructive/90 px-2.5 text-small font-medium text-white opacity-100' : 'w-7 bg-foreground/[0.08] text-foreground/80 opacity-0 group-hover/row:opacity-100 hover:bg-foreground hover:text-background')}>
      <SquareIcon className="size-2.5 fill-current" />{asking && 'Stop?'}
    </button>
  );
}

function WorkCard({ c, title, project, now, i, hot }: CardProps) {
  const replying = c.state === 'working';
  const workflow = c.work.some((w) => w.kind === 'workflow');
  const { agents: team, phases } = useTeam(c, workflow);
  const progress = workflow ? workflowProgress(team, phases, true) : null;
  const others = c.work.filter((w) => w.kind !== 'workflow');
  const line = replying ? (c.activity ?? 'Working')
    : workflow ? 'Running a workflow'
    : c.helpers === 1 ? (others[0]?.kind === 'command' ? 'Running a command' : 'An agent is working')
    : `${word(c.helpers)} agents and commands are running`;
  const going = team?.filter((a) => !a.done) ?? [];
  const ids = c.work.map((w) => w.id).filter((x): x is string => !!x);
  return (
    <RowShell id={c.sessionId} cwd={c.cwd} lit={hot === c.sessionId} i={i} title={title}
      icon={<Ring className="size-3" />}
      meta={<>
        <span className="truncate">{project}{replying && c.turnAt ? ` · ${lasted(now - c.turnAt)}` : ''}{replying && c.steps ? ` · ${c.steps} ${c.steps === 1 ? 'step' : 'steps'}` : ''}</span>
      </>}>
      {/* The message box's stop button (round, filled square), shown on hover. A reply stops at once; background work
          (a workflow, agents) asks first, since stopping it throws that work away. */}
      {(replying || ids.length > 0) && <StopOnHover onStop={() => (replying ? homeStop(c.sid) : homeStopTasks(c.sid, ids))} confirm={!replying} />}
      <div className="mt-2 flex min-w-0 items-center text-small">
        <span key={line} className="roll-in min-w-0 truncate"><span className="shimmer-text">{line}</span></span>
      </div>
      {workflow && team && team.length > 0 && (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-small text-faint">
          <span className="flex shrink-0 gap-[3px]">{team.slice(0, 16).map((a) => <i key={a.key} className={cn('wf-run', a.done ? 'done' : 'live')} />)}</span>
          <span className="truncate tabular-nums">{progress ? `~${progress.pct}% · ${progress.phase}${progress.count > 1 ? ` ${progress.index}/${progress.count}` : ''}` : `${team.filter((a) => a.done).length} of ${team.length} done`}{going.length ? ` · ${listed(going.map((a) => agentName(a.label)))}` : ''}</span>
        </div>
      )}
      {!workflow && !replying && others.length > 0 && <div className="mt-1.5 truncate text-small text-faint">{others.map((o) => o.name).filter(Boolean).join(', ')}</div>}
    </RowShell>
  );
}

/** Something that finished today: a live chat with its result, or an earlier chat we only know the name of. */
type Done = { id: string; cwd: string | null; title: string; project: string; at: number; unread?: boolean; stopped?: boolean; last?: string | null; files?: string[]; pr?: string | null };

/** A finished chat: a card like the others, a step quieter, with what you got. */
function DoneRow({ d, i, hot }: { d: Done; i: number } & Hot) {
  const files = d.files ?? [];
  const prNumber = d.pr ? /\/pull\/(\d+)/.exec(d.pr)?.[1] : null;
  const lit = hot === d.id;
  return (
    <div {...opens(d.id, d.cwd)} style={{ animationDelay: `${120 + Math.min(i, 8) * 35}ms` }}
      className={cn('group/row relative flex min-h-[122px] cursor-pointer gap-3 px-4 py-3 enter-up [--rise:6px] transition-colors duration-150 hover:bg-foreground/[0.035]', lit && 'bg-foreground/[0.035]')}>
      <span className={cn('mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full', d.stopped ? 'bg-foreground/[0.07] text-faint' : 'bg-good/[0.14] text-good')}>
        {d.stopped ? <span className="size-1.5 rounded-[1px] bg-current" /> : <CheckIcon className="size-3" strokeWidth={2.75} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium">{d.title}</span>
        </div>
        <div className="mt-0.5 truncate text-small text-faint tabular-nums">{d.project}{d.stopped ? ' · stopped' : ''} · {clock(d.at)}</div>
        {d.last && !d.stopped && <p className="mt-1.5 line-clamp-2 text-small text-muted-foreground">{plain(d.last)}</p>}
        {(d.pr || files.length > 0) && (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted-foreground">
            {d.pr && (
              <button type="button" onClick={(e) => { e.stopPropagation(); window.open(d.pr!, '_blank'); }} className="flex items-center gap-1.5 hover:text-foreground">
                <GitPullRequestIcon className="size-3.5 shrink-0" />{prNumber ? `Pull request #${prNumber}` : 'Pull request'}<ArrowUpRightIcon className="size-3 shrink-0 text-faint" />
              </button>
            )}
            {files.length > 0 && <span className="flex min-w-0 items-center gap-1.5" title={files.join(', ')}><FileDiffIcon className="size-3.5 shrink-0" />{files.length === 1 ? '1 file changed' : `${files.length} files changed`}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** A card for a moment in the past (while scrubbing): read-only, with what it was doing then. */
function PastCard({ c, title, project, kind, since, i }: { c: HomeChat; title: string; project: string; kind: 'needs' | 'working'; since: number; i: number }) {
  return (
    <div {...opens(c.sessionId, c.cwd)} style={{ animationDelay: `${i * 30}ms` }}
      className={cn(cardBase, 'hover:border-foreground/20', kind === 'needs' ? 'border-warn/30' : 'border-hairline')}>
      <div className={eyebrow}><span className="truncate">{project}</span></div>
      <div className={cardTitle}>{title}</div>
      <p className={cn('mt-2.5 text-ui', kind === 'needs' ? 'text-warn/90' : 'text-muted-foreground')}>
        {kind === 'needs' ? `Waiting for you since ${clock(since)}` : `Working since ${clock(since)}`}
      </p>
    </div>
  );
}

// ---------- today ----------

/** A quarter hour's shade: how much of it Canopy was working, in GitHub's five steps (none, a little … all of it). */
const level = (busy: number, len: number) => { const r = busy / len; return r <= 0 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.8 ? 3 : 4; };
const SHADE = [6, 20, 38, 60, 85]; // % of the text colour: quiet grey, darker where Canopy worked more
const shade = (l: number, future = false) => ({ background: `color-mix(in oklch, var(--foreground) ${future ? 2.5 : SHADE[l]}%, transparent)` });
const money = (n: number) => `$${n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
const hourName = (h: number) => (h % 24 === 0 ? '12 AM' : h === 12 ? 'Noon' : h < 12 ? `${h} AM` : `${h - 12} PM`);

/** Today, docked under the board like GitHub's contribution graph for one day: a row of quarter hours, darker where
 *  Canopy worked more, under one sentence with the day's working time and cost. Point at it to read a quarter hour.
 *  It's also a scrubber: press and drag (or click) and the board above shows that moment; drag to the end, or press
 *  Back to now, and it's live again. */
function Today({ day: got, now, scrub, onScrub }: { day: HomeDay | null | false; now: number; scrub: number | null; onScrub: (t: number | null) => void }) {
  const day = got || null;
  const since = day?.since ?? startOfToday(), len = day?.slot ?? 15 * MIN;
  const count = day?.slots.length ?? 96, span = count * len;
  const grid = useRef<HTMLDivElement>(null);
  const [probe, setProbe] = useState<number | null>(null); // where the pointer is, 0–1 across the strip
  const [dragging, setDragging] = useState(false);
  const fracAt = (x: number) => { const r = grid.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)); };
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - since) / span) * 100))}%`;
  // A moment on the strip; at or past now (the last half minute too) means live.
  const seek = (f: number) => { const t = since + f * span; onScrub(t >= now - 30_000 ? null : t); };
  const down = (e: React.PointerEvent) => {
    if (!day) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true); seek(fracAt(e.clientX));
  };
  const move = (e: React.PointerEvent) => { const f = fracAt(e.clientX); setProbe(f); if (dragging) seek(f); };
  const up = () => setDragging(false);
  // What the label over the strip says: the quarter hour under the pointer (while dragging, the moment shown).
  const i = probe == null ? -1 : Math.min(count - 1, Math.floor(probe * count));
  const a = since + i * len, s = day?.slots[i];
  const label = i < 0 || !day ? null
    : a > now ? 'Later today'
      : <>{dragging ? clock(scrub ?? now) : `${clock(a)} – ${clock(Math.min(a + len, now))}`}<span className="text-faint tabular-nums">{s?.busy ? `Canopy worked ${lasted(s.busy)}${s.chats > 1 ? ` in ${s.chats} chats` : ''}, ${money(s.cost)}` : 'Nothing'}</span></>;
  return (
    <div className="sticky bottom-0 z-10 shrink-0 border-t border-hairline bg-background before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:mb-px before:h-8 before:bg-gradient-to-t before:from-background before:to-transparent">
      <div className="mx-auto w-full max-w-[1160px] px-6 pt-3 pb-4 @[760px]:px-10">
        {/* Baseline-aligned for the label and the sentence; what sits at the right (the legend, or "Back to now" while you
            scrub) is centred instead, so swapping one for the other never moves the line. */}
        <div className="flex min-h-6 items-baseline gap-4">
          <h2 className="shrink-0 text-label text-muted-foreground">Today</h2>
          <p className="min-w-0 flex-1 truncate text-ui text-muted-foreground tabular-nums">
            {got === false ? 'Restart Canopy to see today here.' : !day ? ''
              : !day.busy ? 'Canopy hasn’t worked yet today.'
                : <>Canopy worked <span className="font-medium text-foreground">{lasted(day.busy)}</span> across {day.chats} {day.chats === 1 ? 'chat' : 'chats'}. It cost <span className="font-medium text-foreground">{money(day.cost)}</span>.</>}
          </p>
          {scrub != null
            ? <button type="button" onClick={() => onScrub(null)} className="h-6 shrink-0 self-center rounded-md px-2 text-small text-muted-foreground hover:bg-accent hover:text-foreground">Back to now</button>
            : <span aria-hidden className="hidden shrink-0 items-center gap-1 self-center text-micro text-faint @[760px]:flex">Less{[0, 1, 2, 3, 4].map((l) => <span key={l} className="size-2.5 rounded-[2px]" style={shade(l)} />)}More</span>}
        </div>
        <div className={cn('relative mt-2.5 select-none', day && (dragging ? 'cursor-grabbing' : 'cursor-ew-resize'))}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => { if (!dragging) setProbe(null); }}>
          <div ref={grid} className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
            {Array.from({ length: count }, (_, k) => {
              const at = since + k * len, future = at > now;
              return <span key={k} className={cn('h-6 rounded-[3px]', at <= now && now < at + len && 'ring-1 ring-brand', k === i && !dragging && at <= now && 'ring-1 ring-foreground/40')}
                style={shade(day?.slots[k] ? level(day.slots[k].busy, len) : 0, future)} />;
            })}
          </div>
          {/* the moment the board is showing: a playhead, and what came after it set back */}
          {scrub != null && (
            <>
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 bg-background/60" style={{ left: pct(scrub) }} />
              <span aria-hidden className={cn('pointer-events-none absolute -inset-y-1 w-px bg-brand', !dragging && 'transition-[left] duration-200 ease-out')} style={{ left: pct(scrub) }}>
                <span className="absolute -top-0.5 left-1/2 size-[7px] -translate-x-1/2 rounded-full bg-brand ring-2 ring-background" />
              </span>
            </>
          )}
          {label && (
            <span className="pointer-events-none absolute bottom-full mb-2 flex min-h-6 -translate-x-1/2 items-center gap-2 rounded-md border bg-popover px-2 py-1 text-small whitespace-nowrap text-popover-foreground elev-pop"
              style={{ left: `clamp(150px, ${(probe ?? 0) * 100}%, calc(100% - 150px))` }}>
              {label}
            </span>
          )}
        </div>
        <div className="relative mt-1.5 h-4 text-micro text-faint">
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => <span key={h} className="absolute" style={{ left: `${((h * HOUR) / span) * 100}%` }}>{hourName(h)}</span>)}
        </div>
      </div>
    </div>
  );
}

// ---------- the page ----------


export function HomeView({ recents, chatsDir, userName, sample }: { recents: Recent[]; chatsDir: string | null; userName: string; sample?: HomeChat[] }) {
  const realLive = useHome();
  const marked = useMarkedUnread();
  const live = sample ?? realLive; // the Playground passes sample chats
  const now = useNow();
  const day = useHomeDay();
  const { meta } = useStore();
  useChatStatus(null); // re-render when the sidebar's chat statuses change
  // The chat under the pointer, from data-chat on whatever it's over: one listener for the whole page, so a card that
  // leaves while you point at it can't stay lit.
  const [hot, setHot] = useState<string | null>(null);
  const point = (e: React.MouseEvent) => setHot((e.target as HTMLElement).closest<HTMLElement>('[data-chat]')?.dataset.chat ?? null);
  const [allDone, setAllDone] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null); // a moment earlier today the board is showing (null = live)
  // Until Canopy restarts onto Home's live feed, fall back on what the sidebar knows, so a running chat is never Done.
  const fromSidebar: HomeChat[] = sample ? [] : chatStatus.all().filter((s) => !(live ?? []).some((l) => l.sessionId === s.sessionId)).map((s) => {
    const mine = s.sessionId === meta.sessionId;
    const running = (s.helpers ?? 0) + (mine ? meta.tasks.filter((t) => t.status === 'running' || t.status === 'pending').length : 0);
    const state = mine && meta.busy ? 'working' : s.state;
    return { sid: s.sid, sessionId: s.sessionId, cwd: s.cwd, title: null, state, unread: s.unread, active: s.active, activity: state === 'working' ? 'Working' : null,
      turnAt: null, doneAt: null, stopped: false, last: null, ask: null, work: [], helpers: running };
  });
  const list = [...(live ?? []), ...fromSidebar];
  const titleOf = (c: HomeChat) => c.title || recents.find((r) => r.id === c.sessionId)?.title || projectOf(c.cwd, chatsDir) || 'Chat';

  const needs = list.filter((c) => c.state === 'needs-you').sort((a, b) => (a.ask?.since ?? 0) - (b.ask?.since ?? 0));
  const working = list.filter((c) => c.state === 'working' || (c.state !== 'needs-you' && c.helpers > 0));
  const busy = new Set([...needs, ...working].map((c) => c.sessionId));
  const today = startOfToday();
  const seen = new Set(list.filter((c) => busy.has(c.sessionId) || (c.doneAt && c.doneAt >= today)).map((c) => c.sessionId));
  // Chats that finished earlier today without live data (before a restart, say): we know the name and the time.
  const earlier = recents.filter((r) => !seen.has(r.id) && r.updated >= today).slice(0, 12);
  const done: Done[] = [
    ...list.filter((c) => !busy.has(c.sessionId) && c.doneAt && c.doneAt >= today)
      .map((c) => ({ id: c.sessionId, cwd: c.cwd, title: titleOf(c), project: projectOf(c.cwd, chatsDir), at: c.doneAt!, unread: c.unread, stopped: c.stopped, last: c.last, files: c.files, pr: c.pr })),
    ...earlier.map((r) => ({ id: r.id, cwd: r.dir, title: r.title, project: projectOf(r.dir, chatsDir), at: r.updated })),
  ].sort((a, b) => b.at - a.at);
  // Finished: an inbox of chats that finished and you haven't opened yet (or marked unread). Opening one clears it.
  const finished = done.filter((x) => x.unread || marked.has(x.id));

  // Scrubbing: the board at that moment, from each chat's spans (what covered it) and when things finished.
  const past = scrub == null ? null : (() => {
    const T = scrub;
    const needsP: { c: HomeChat; since: number }[] = [], workP: { c: HomeChat; since: number }[] = [];
    for (const c of list) {
      const x = (c.spans ?? []).find((y) => y.from <= T && (y.to ?? now) > T);
      if (x?.kind === 'wait') needsP.push({ c, since: x.from }); else if (x) workP.push({ c, since: x.from });
    }
    const busyP = new Set([...needsP, ...workP].map((x) => x.c.sessionId));
    const doneP = done.filter((x) => x.at <= T && !busyP.has(x.id));
    return { needsP, workP, doneP };
  })();
  const n = past ? past.needsP.length : needs.length, w = past ? past.workP.length : working.length, d = past ? past.doneP.length : finished.length;
  const first = (userName || '').split(/\s+/)[0];
  const SHOWN = 6;
  const doneNow = past ? past.doneP : finished;
  const shown = allDone ? doneNow : doneNow.slice(0, SHOWN);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden" onMouseOver={point} onMouseLeave={() => setHot(null)}>
      {/* The greeting, the column titles and the timeline stay put; the columns scroll. */}
      <div className="mx-auto flex min-h-0 w-full max-w-[1160px] flex-1 flex-col overflow-y-auto px-6 pt-9 pb-6 @[760px]:overflow-hidden @[760px]:px-10">
        <header className="enter-up flex shrink-0 items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">
              {greeting(new Date(now))}{first ? <>, <span className="text-brand">{first}</span></> : ''}
            </h1>
            {/* Always takes its line, so scrubbing the strip (Showing …) never moves the board. */}
            <p className="mt-1 h-5 text-ui text-faint tabular-nums">
              {scrub != null && <span className="text-brand">Showing {clock(scrub)}</span>}
              {!sample && !homeAvailable() && <span className={cn('text-warn', scrub != null && 'ml-2')}>Restart Canopy to see live chats here</span>}
            </p>
          </div>
          <DeskClock t={scrub ?? now} live={scrub == null} />
        </header>

        <div className="mt-7 grid grid-cols-1 gap-x-8 gap-y-9 @[760px]:min-h-0 @[760px]:flex-1 @[760px]:grid-cols-3 @[760px]:grid-rows-[minmax(0,1fr)]">
          {(
            <Column kind="needs" title="Needs You" count={n} empty="Nothing waiting on you. Approvals and questions land here.">
              <div className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-card/40">
                {past ? past.needsP.map(({ c, since }, i) => <PastCard key={c.sid} c={c} kind="needs" since={since} i={i} title={titleOf(c)} project={projectOf(c.cwd, chatsDir)} />)
                  : needs.map((c, i) => <NeedCard key={`${c.sid}:${c.ask?.id ?? ''}`} c={c} i={i} title={titleOf(c)} project={projectOf(c.cwd, chatsDir)} now={now} hot={hot} />)}
              </div>
            </Column>
          )}
          {(
            <Column kind="working" title="Working" count={w} empty="Nothing running. Each chat shows here while it works.">
              <div className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-card/40">
                {past ? past.workP.map(({ c, since }, i) => <PastCard key={c.sid} c={c} kind="working" since={since} i={i} title={titleOf(c)} project={projectOf(c.cwd, chatsDir)} />)
                  : working.map((c, i) => <WorkCard key={c.sid} c={c} i={i} title={titleOf(c)} project={projectOf(c.cwd, chatsDir)} now={now} hot={hot} />)}
              </div>
            </Column>
          )}
          <Column kind="done" title="Finished" count={d} empty="You're all caught up. Chats that finish while you're away land here until you open them.">
            <div className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-card/40">
              {shown.map((x, i) => <DoneRow key={x.id} d={x} i={i} hot={hot} />)}
            </div>
            {d > SHOWN && (
              <button type="button" onClick={() => setAllDone(!allDone)} className="mt-1 flex h-8 items-center self-start text-small text-muted-foreground hover:text-foreground">
                {allDone ? 'Show fewer' : `Show ${d - SHOWN} more`}
              </button>
            )}
          </Column>
        </div>
      </div>
      <Today day={day} now={now} scrub={scrub} onScrub={setScrub} />
    </div>
  );
}

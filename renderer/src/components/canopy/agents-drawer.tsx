// The agents drawer: tucked under the message box, belongs to this chat. Shows Claude's agents and background
// commands while they run (live note, steps, time, Stop), their results when they finish, then slides away.
// Closed it's one line peeking out from under the box; click to pull it open.
import { workflowProgress } from '@/lib/workflow-progress';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, SquareIcon, XIcon } from 'lucide-react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { UPDATE_PROMPT } from '@/lib/request-updates';
import { StoreContext, useStore, type Item, type TaskInfo } from '@/lib/store';
import { feature } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import { clock as waitClock, waitMs } from '@/lib/wait';
import { Reveal } from './reveal';

// Pop-ups about the chat center over the chat, not the whole window (the sidebar's width is --canopy-sidebar).
const OVER_CHAT = { left: 'calc(50% + var(--canopy-sidebar, 0px) / 2)' } as const;
const RUNNING = new Set(['running', 'pending']);
const LINGER_MS = 10_000; // finished work stays this long *while you can see it*, then the drawer lets go of it
const COMMAND_LINGER_MS = 1_000; // a finished command has nothing to read: it leaves after a second
const lingerOf = (t: TaskInfo) => (isCommand(t) ? COMMAND_LINGER_MS : LINGER_MS);

const isCommand = (t: TaskInfo) => t.taskType === 'local_bash';
/** What kind of background work it is, in Claude Code's own terms. */
type Kind = 'agent' | 'workflow' | 'command' | 'app task' | 'watcher';
const kindOf = (t: TaskInfo): Kind => (t.taskType === 'local_workflow' || t.workflow ? 'workflow' : t.taskType === 'local_bash' ? 'command'
  : t.taskType === 'mcp_task' ? 'app task' : t.taskType === 'monitor' ? 'watcher' : 'agent');
const plural = (n: number, k: Kind) => `${n} ${k}${n === 1 ? '' : k === 'watcher' ? 'es' : 's'}`;
const nameOf = (t: TaskInfo) => (t.description || (isCommand(t) ? 'Command' : 'Agent')).replace(/\s+/g, ' ').trim();
function fmt(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const TOOL_WORDS: Record<string, string> = {
  WebSearch: 'searching the web', WebFetch: 'reading a web page', Read: 'reading files', Grep: 'searching the code', Glob: 'finding files',
  Bash: 'running a command', Edit: 'editing files', Write: 'writing a file', Task: 'starting an agent', Agent: 'starting an agent', TodoWrite: 'planning',
};
/** What it's doing right now, in words: the agent's own progress note if there is one, else its last tool. */
function noteOf(t: TaskInfo) {
  if (t.summary && RUNNING.has(t.status)) return t.summary.split('\n')[0];
  if (t.activity && t.activity.trim() !== (t.description ?? '').trim()) return t.activity.charAt(0).toLowerCase() + t.activity.slice(1);
  if (t.lastTool) return TOOL_WORDS[t.lastTool] ?? (t.lastTool.startsWith('mcp__') ? `using ${t.lastTool.split('__')[1]}` : 'working');
  return isCommand(t) ? 'running' : 'getting started';
}
/** A running command that is only a timer ("sleep 300"): how long it waits and how far along it is; else null. */
function timerOf(t: TaskInfo, items: Item[], now: number) {
  if (!isCommand(t) || !RUNNING.has(t.status) || !t.toolUseId || !t.startedAt) return null;
  let total: number | null = null;
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (it.t === 'tool' && it.id === t.toolUseId) { total = waitMs(it.input?.command); break; } }
  if (!total) return null;
  const done = Math.min(1, Math.max(0, (now - t.startedAt) / total));
  return { done, left: waitClock(total - (now - t.startedAt)) };
}
/** A thin bar that fills as a timer runs. */
function TimerBar({ done, className }: { done: number; className?: string }) {
  return (
    <span aria-hidden className={cn('relative block h-[3px] overflow-hidden rounded-full bg-foreground/10', className)}>
      <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/45 transition-[width] duration-1000 ease-linear" style={{ width: `${done * 100}%` }} />
    </span>
  );
}
const elapsed = (t: TaskInfo, now: number) => (t.usage?.duration_ms ?? ((t.endedAt ?? now) - (t.startedAt ?? now)));

/** A calm, thin ring that turns: "working", without the blink of a pulsing dot. */
function Spin({ className }: { className?: string }) {
  return <span aria-label="Working" role="img" className={cn('inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-60 [animation-duration:1.1s]', className)} />;
}

/** Stop, asked inline: the first click turns ■ into "Stop?", a second click within 3s stops it. */
function StopButton({ name, onStop }: { name: string; onStop: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (!asking) return; const id = setTimeout(() => setAsking(false), 3000); return () => clearTimeout(id); }, [asking]);
  return asking
    ? <button type="button" onClick={() => { setAsking(false); onStop(); }} className="h-5 shrink-0 rounded-md bg-destructive/15 px-1.5 text-micro font-medium text-destructive hover:bg-destructive/25">Stop?</button>
    : <button type="button" aria-label={`Stop ${name}`} title="Stop" onClick={() => setAsking(true)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground"><SquareIcon className="size-2.5 fill-current" /></button>;
}

/** `value`, but changing at most once every `ms`: a live note you can read, not one that flickers with every step. */
function useSteady<T>(value: T, ms: number) {
  const [shown, setShown] = useState(value);
  const at = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = Math.max(0, at.current + ms - Date.now());
    const id = setTimeout(() => { at.current = Date.now(); setShown(value); }, wait);
    return () => clearTimeout(id);
  }, [value, shown, ms]);
  return shown;
}

function useNow(on: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!on) return; const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [on, ms]);
  return now;
}

/** "Request Updates": asks the chat where its running agents and workflows stand. After a click it reads "Asked"
 *  for a few seconds, so one click sends one question. */
function RequestUpdate({ onAsk }: { onAsk: () => void }) {
  const [asked, setAsked] = useState(false);
  useEffect(() => { if (!asked) return; const id = setTimeout(() => setAsked(false), 4000); return () => clearTimeout(id); }, [asked]);
  return (
    <button type="button" disabled={asked} onClick={() => { setAsked(true); onAsk(); }}
      className="h-5 shrink-0 rounded px-1.5 bg-good/10 text-small leading-5 text-good transition-colors hover:bg-good/20 disabled:pointer-events-none disabled:bg-transparent disabled:text-faint">
      {asked ? 'Asked' : 'Request Updates'}
    </button>
  );
}

export function AgentsDrawer() {
  const store = useStore();
  const { meta } = store;
  // Mid-reply, the question folds into the reply under way (as a message typed then does); waiting in the queue,
  // its answer could come after the agents were done.
  const requestUpdate = () => store.dispatch(UPDATE_PROMPT, [], meta.busy);
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<TaskInfo | null>(null);
  const [agentOpen, setAgentOpen] = useState<string | null>(null); // the agent whose card is open (its task id)
  const live = meta.tasks.some((t) => RUNNING.has(t.status));
  // Tick fast while a command is finishing, so its one second ends on time.
  const fresh = meta.tasks.some((t) => isCommand(t) && !RUNNING.has(t.status) && t.endedAt && Date.now() - t.endedAt < 3000);
  const now = useNow(true, fresh ? 200 : 1000);
  const [hover, setHover] = useState(false);
  // Finished work lingers for LINGER_MS of time you could actually see it: the clock only runs while Canopy is the
  // front window, and not at all while the drawer is open or under the pointer. `seen` = how long each one has been on show.
  const seen = useRef(new Map<string, number>());
  const last = useRef(now);
  const away = !document.hasFocus() || document.hidden;
  const holding = open || hover || away;
  const dt = now - last.current; last.current = now;
  for (const t of meta.tasks) {
    if (RUNNING.has(t.status)) { seen.current.delete(t.taskId); continue; }
    // Finished well before you got here (opening an older chat): nothing to linger for.
    if (!seen.current.has(t.taskId) && t.endedAt && now - t.endedAt > 60_000) { seen.current.set(t.taskId, lingerOf(t)); continue; }
    // A finished command has nothing to read, so its clock keeps running with the drawer open or hovered; it only
    // waits while Canopy isn't in front. Agents and workflows hold, so you can read what they found.
    const held = isCommand(t) ? away : holding;
    if (!held) seen.current.set(t.taskId, (seen.current.get(t.taskId) ?? 0) + Math.min(dt, 1500));
    else if (!seen.current.has(t.taskId)) seen.current.set(t.taskId, 0);
  }
  const shown = useMemo(() => meta.tasks.filter((t) => RUNNING.has(t.status) || (seen.current.get(t.taskId) ?? 0) < lingerOf(t)), [meta.tasks, now]); // eslint-disable-line react-hooks/exhaustive-deps
  // How much of its 10 seconds each finished item has left (1 → 0); drives the draining lines.
  const left = (t: TaskInfo) => Math.max(0, 1 - (seen.current.get(t.taskId) ?? 0) / lingerOf(t));
  const drawerLeft = live ? null : Math.max(0, ...shown.map(left));
  // The closed line holds still. One thing running: its name and what it's doing (the note changes at most every 5s).
  // Several: just their names, in the order they started; what each is doing is one click away, in the open drawer.
  const runningList = shown.filter((t) => RUNNING.has(t.status)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  useEffect(() => { if (!shown.length) setOpen(false); }, [shown.length]);
  useEffect(() => { if (open) feature('agents_drawer_opened'); }, [open]); // it only ever opens by a click

  const agents = shown.filter((t) => !isCommand(t));
  const commands = shown.filter(isCommand);
  const focus = runningList.length === 1 ? runningList[0] : undefined;
  const focusNote = useSteady(focus && !isCommand(focus) ? noteOf(focus) : '', 5000);
  const names = runningList.length > 1 ? runningList.map(nameOf).join(', ') : '';
  // "Request Updates" shows while an agent or workflow runs (a command alone has nothing to report).
  const asking = runningList.some((t) => !isCommand(t));
  // One timer running on its own: the closed line counts it down with a bar, in place of "1 command".
  const focusTimer = focus && !agents.length ? timerOf(focus, store.items, now) : null;

  return (
    <Reveal show={shown.length > 0} duration={240}>
      <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className="mx-4 -mt-3 overflow-hidden rounded-b-[14px] border border-t-0 border-black/[0.06] bg-card/70 pt-3 text-small dark:border-white/[0.07] dark:bg-[oklch(0.235_0_0)]">
        {/* the edge: one line, always */}
        <div className="relative flex min-w-0 items-center gap-0.5 pr-1.5">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className={cn('flex h-8 min-w-0 flex-1 items-center gap-2 pl-3.5 text-left text-muted-foreground hover:text-foreground', asking ? 'pr-3' : 'pr-2')}>
          {live ? <Spin /> : <span className="shrink-0 text-good">✓</span>}
          {(() => {
            const kinds = (['workflow', 'agent', 'app task', 'watcher'] as Kind[]).map((k) => [k, shown.filter((t) => kindOf(t) === k)] as const).filter(([, l]) => l.length);
            if (!kinds.length) return null;
            const all = kinds.flatMap(([, l]) => l);
            const n = (st: string) => all.filter((a) => a.status === st).length;
            const parts = [n('completed') && (live || n('completed') < all.length) ? `${n('completed')} done` : !live && n('completed') === all.length ? 'done' : null,
              n('stopped') ? `${n('stopped')} stopped` : null, n('failed') ? `${n('failed')} failed` : null].filter(Boolean);
            return (
              <span className="shrink-0 text-foreground/85">
                {kinds.map(([k, l]) => plural(l.length, k)).join(' · ')}
                {parts.length ? <span className="text-muted-foreground"> · {parts.join(' · ')}</span> : null}
              </span>
            );
          })()}
          {focus && !open && (
            <span key={focus.taskId} className="min-w-0 truncate text-faint enter-fade [animation-duration:240ms]">
              {isCommand(focus) || !focusNote ? nameOf(focus) : <>{nameOf(focus)}: <span key={focusNote} className="shimmer-text enter-fade [animation-duration:400ms]">{focusNote}</span></>}
            </span>
          )}
          {names && !open && <span className="min-w-0 truncate text-faint" title={names}>{names}</span>}
          {focusTimer && !open && (
            <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-faint tabular-nums">
              <TimerBar done={focusTimer.done} className="w-16" />
              <span>{focusTimer.left} left</span>
            </span>
          )}
          {commands.length > 0 && !(focusTimer && !open) && (
            <span className="flex shrink-0 items-center gap-1.5 text-faint">
              {agents.length > 0 && <span>·</span>}
              {agents.length > 0 && <span className={cn('size-1.5 rounded-full', commands.some((c) => RUNNING.has(c.status)) ? 'bg-good' : 'bg-muted-foreground/40')} />}
              <span className={cn(!agents.length && 'text-foreground/85')}>{commands.length === 1 ? (agents.length ? 'a command' : '1 command') : `${commands.length} commands`}</span>
            </span>
          )}
          {/* Open: ⌃ tucks it back under the box. Closed: ⌄ pulls it out. */}
          {!asking && <ChevronDownIcon className={cn(focusTimer && !open ? 'ml-1.5' : 'ml-auto', 'size-3.5 shrink-0 text-faint transition-transform duration-200', open && 'rotate-180')} />}
        </button>
        {asking && <RequestUpdate onAsk={requestUpdate} />}
        {asking && (
          <button type="button" onClick={() => setOpen(!open)} aria-label={open ? 'Hide agents' : 'Show agents'}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:text-foreground">
            <ChevronDownIcon className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
          </button>
        )}
        {drawerLeft != null && shown.length > 0 && <Drain left={drawerLeft} />}
        </div>

        {/* pulled open: one row per agent or command */}
        <Reveal show={open} duration={220}>
          <div className="max-h-[40vh] overflow-y-auto border-t border-hairline">
            {shown.map((t) => {
              if (kindOf(t) === 'workflow') return <WorkflowCard key={t.taskId} t={t} now={now} onRead={() => setReading(t)} />;
              const running = RUNNING.has(t.status);
              const failed = t.status === 'failed';
              const steps = t.usage?.tool_uses;
              const timer = timerOf(t, store.items, now);
              return (
                // An agent opens its card (like a workflow): click anywhere on the row but its buttons.
                <div key={t.taskId} className={cn('relative border-b border-hairline px-3.5 py-2 last:border-b-0', !isCommand(t) && 'cursor-pointer hover:bg-accent/30')}
                  role={!isCommand(t) ? 'button' : undefined} tabIndex={!isCommand(t) ? 0 : undefined} title={!isCommand(t) ? 'Open agent' : undefined}
                  onClick={!isCommand(t) ? (e) => { if (!(e.target as HTMLElement).closest('button')) setAgentOpen(t.taskId); } : undefined}
                  onKeyDown={!isCommand(t) ? (e) => { if (e.key === 'Enter') setAgentOpen(t.taskId); } : undefined}>
                  {!running && live && <Drain left={left(t)} />}
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex w-3 shrink-0 justify-center">
                      {running ? (isCommand(t) ? <span className="size-1.5 rounded-full bg-good" /> : <Spin />) : failed ? <span className="text-destructive">✕</span> : t.status === 'stopped' ? <span className="text-faint">■</span> : <span className="text-good">✓</span>}
                    </span>
                    {kindOf(t) !== 'agent' && kindOf(t) !== 'command' && (
                      <span className="shrink-0 rounded border border-hairline px-1 text-micro text-muted-foreground">{kindOf(t)}{t.workflow ? ` · ${t.workflow}` : ''}</span>
                    )}
                    <span className="min-w-0 truncate text-foreground/90">{nameOf(t)}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-faint">{timer ? `${timer.left} left` : fmt(elapsed(t, now))}</span>
                    {running && <StopButton name={`${kindOf(t)} ${nameOf(t)}`} onStop={() => store.stopTask(t.taskId)} />}
                  </div>
                  <div className="mt-0.5 ml-5 min-w-0 text-faint">
                    {timer ? (
                      <TimerBar done={timer.done} className="my-1.5" />
                    ) : running ? (
                      <span className="block truncate"><span className={cn(!isCommand(t) && 'shimmer-text')}>{noteOf(t)}</span>{steps ? ` · ${steps} step${steps === 1 ? '' : 's'}` : ''}</span>
                    ) : failed ? (
                      <span className="text-destructive/80">{t.error || 'It hit a problem and stopped.'}</span>
                    ) : t.status === 'stopped' ? (
                      <span>Stopped</span>
                    ) : isCommand(t) ? (
                      <span>{(() => { const code = t.summary?.match(/exit(?:ed)?(?: with)?(?: code)?\s*(\d+)/i)?.[1]; return code == null ? 'Finished' : code === '0' ? 'Finished' : `Exited with code ${code}`; })()}</span>
                    ) : t.summary && t.summary.trim() !== nameOf(t) ? (
                      <button type="button" onClick={() => setReading(t)} className="block w-full truncate text-left hover:text-foreground">
                        {t.summary.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '')} <span className="text-muted-foreground">· Read</span>
                      </button>
                    ) : <span>Done</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Reveal>
      </div>
      <AgentReport task={reading} onClose={() => setReading(null)} />
      {(() => { const a = meta.tasks.find((x) => x.taskId === agentOpen); return a ? <AgentDetail t={a} now={now} onClose={() => setAgentOpen(null)} /> : null; })()}
    </Reveal>
  );
}

/** A hairline that drains as a finished item's time runs out (like the mode notice's line). It moves in step with
 *  the visible-time clock, so it stops whenever the countdown is held. */
function Drain({ left }: { left: number }) {
  return <span aria-hidden className="pointer-events-none absolute bottom-0 left-0 h-[2px] bg-foreground/25 transition-[width] duration-1000 ease-linear" style={{ width: `${left * 100}%` }} />;
}

type WfAgent = { key: string; label: string; phase: string | null; done: boolean; model?: string | null; agentId?: string; result?: string; steps?: number; tool?: string | null; detail?: string; startedAt?: number | null; lastAt?: number | null };
/** claude-fable-5-2 → "Fable 5.2". */
const modelName = (id: string) => { const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id); return m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id; };
/** The models a workflow's agents ran on, e.g. "Fable 5.2" or "Fable 5.2 + Haiku 5.5". */
const modelsOf = (agents: WfAgent[] | null) => [...new Set((agents ?? []).map((a) => a.model).filter(Boolean).map((m) => modelName(m!)))].join(' + ');
/** "scout:anthropic" → "anthropic"; the phase is shown separately. */
const agentName = (label: string) => label.replace(/^[^:]+:\s*/, '').replace(/[-_]/g, ' ');

/** The agents inside a workflow, from Claude Code's journal for it; refreshed every 2s while the workflow runs. */
function useWorkflowAgents(running: boolean) {
  // The main store asks about the chat on screen; a pane's store names its own chat and folder.
  const store = useContext(StoreContext);
  const [agents, setAgents] = useState<WfAgent[] | null>(null);
  const [declared, setDeclared] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(!api.workflowAgents);
  useEffect(() => {
    let alive = true;
    // Until Canopy restarts after an update, the back end may not know this request yet: say so, keep the counts.
    const load = () => api.workflowAgents?.(store.sid ? store.cwd : null, store.sid ? store.meta.sessionId : null).then((r) => { if (alive && r) { setAgents(r.agents); setDeclared(r.phases ?? []); setUnavailable(false); } }).catch(() => { if (alive) setUnavailable(true); });
    load();
    if (!running) return () => { alive = false; };
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [running]);
  return { agents, declared, unavailable };
}

/** Group a workflow's agents by phase, in the order phases first appear. */
function byPhase(agents: WfAgent[] | null) {
  const m = new Map<string, WfAgent[]>();
  for (const a of agents ?? []) { const k = a.phase ?? 'Agents'; m.set(k, [...(m.get(k) ?? []), a]); }
  return [...m];
}

/** A workflow is a team at work, so it gets its own card. Kept to two lines: what it is, and where it's at right now.
 *  Everything else (every agent, their output) lives in the detail view the card opens. */
function WorkflowCard({ t, now, onRead }: { t: TaskInfo; now: number; onRead: () => void }) {
  const store = useContext(StoreContext);
  const running = RUNNING.has(t.status);
  const [detail, setDetail] = useState(false);
  const { agents, declared } = useWorkflowAgents(running);
  const name = shortName(t);
  const w = readWorkflow(agents, declared, running, elapsed(t, now), now);
  const state: RingState = running ? 'running' : t.status === 'failed' || t.status === 'stopped' ? 'stopped' : 'done';
  const report = !running && t.summary && !/^dynamic workflow .* completed\.?$/i.test(t.summary.trim()) ? t.summary.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') : null;
  // One row: a small ring for how far along, the name, one line for where it stands, and the time.
  return (
    <div className="border-b border-hairline p-1.5 last:border-b-0">
      <div role="button" tabIndex={0} onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) setDetail(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(true); } }}
        className="group flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 outline-none transition-colors hover:bg-accent/30 focus-visible:ring-1 focus-visible:ring-foreground/20" title="Open workflow">
        <WorkflowRing pct={w.pct} state={state} leftMin={null} elapsedMs={0} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui text-foreground">{name}</div>
          <div className="truncate text-small text-muted-foreground">
            {running ? whereItStands(w)
              : t.status === 'failed' ? (t.error || 'It hit a problem and stopped.')
              : t.status === 'stopped' ? 'Stopped'
              : report ? <button type="button" onClick={onRead} className="max-w-full truncate text-left hover:text-foreground">{report} · Read</button>
              : `Done${agents?.length ? ` · ${agents.length} agents` : ''}`}
          </div>
        </div>
        {/* Running: how far along and the time left (the same estimate as the ring), else the time so far. */}
        <span className="shrink-0 text-small tabular-nums text-faint" title={running ? `${fmt(elapsed(t, now))} so far` : undefined}>
          {running ? [`${w.pct}%`, w.leftMin != null ? `${w.leftMin < 1 ? '<1' : w.leftMin} min left` : `${fmt(elapsed(t, now))} so far`].join(' · ') : fmt(elapsed(t, now))}
        </span>
        {running && <StopButton name={`workflow ${name}`} onStop={() => store.stopTask(t.taskId)} />}
        <ChevronRightIcon className="size-3.5 shrink-0 text-faint transition-colors group-hover:text-foreground" />
      </div>
      <WorkflowDetail t={t} now={now} open={detail} onClose={() => setDetail(false)} />
    </div>
  );
}

/** Pretty an agent's output: Markdown as Markdown, structured data as indented JSON. */
function AgentOutput({ text }: { text: string }) {
  const t = text.trim();
  const isJson = /^[[{]/.test(t);
  return isJson
    ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-background/60 p-3 font-mono text-code leading-relaxed text-muted-foreground">{t}</pre>
    : <div className="prose-reply prose-compact max-h-80 overflow-y-auto"><MessageResponse>{t}</MessageResponse></div>;
}

const TOOL_VERB: Record<string, string> = { WebSearch: 'Searching', WebFetch: 'Reading', Read: 'Reading', Grep: 'Searching code', Glob: 'Finding files', Bash: 'Running', Edit: 'Editing', Write: 'Writing', Task: 'Starting an agent', Agent: 'Starting an agent' };
/** One agent's line: what it's on right now, or how much it did. */
function agentLine(a: WfAgent, running: boolean, now: number) {
  const took = a.startedAt ? fmt(((a.done || !running ? a.lastAt : now) ?? now) - a.startedAt) : null;
  if (!a.done && running) {
    const verb = a.tool ? (TOOL_VERB[a.tool] ?? (a.tool.startsWith('mcp__') ? `Using ${a.tool.split('__')[1]}` : 'Working')) : 'Starting';
    return [a.detail ? `${verb}: ${a.detail}` : verb, [a.steps ? `${a.steps} steps` : null, took].filter(Boolean).join(' · ')];
  }
  return [null, [a.steps ? `${a.steps} steps` : null, took].filter(Boolean).join(' · ')];
}

/** A workflow, in detail: what it is, then its phases and every agent, live, like Claude Code's own view.
 *  Click an agent to open it up (what it's doing in full, its output). */
/** Canopy's own reading of a workflow, worked out in code (no model): how far along, time left, the phase in words,
 *  the phases as a track, and any agent that's been on one step for 10+ minutes. */
function readWorkflow(agents: WfAgent[] | null, declared: string[], running: boolean, elapsedMs: number, now: number) {
  const list = agents ?? [];
  const phases = [...declared];
  for (const a of list) { const k = a.phase ?? 'Agents'; if (!phases.includes(k)) phases.push(k); }
  const of = (p: string) => list.filter((a) => (a.phase ?? 'Agents') === p);
  const prog = workflowProgress(list, declared, running);
  const pct = prog?.pct ?? (running ? 0 : 100);
  const at = prog ? prog.index - 1 : 0;
  const done = list.filter((a) => a.done).length;
  // Time left, from how fast it has gone so far; only once there's enough behind it to mean something.
  const leftMin = running && pct >= 12 && done >= 2 ? Math.max(0, Math.round((elapsedMs * (100 - pct)) / pct / 60000)) : null;
  // The longest-running step among agents still working, if it's been 10 minutes or more.
  const long = running ? list.filter((a) => !a.done && a.lastAt && now - a.lastAt >= 10 * 60000).sort((a, b) => (a.lastAt ?? 0) - (b.lastAt ?? 0))[0] : undefined;
  return { phases, of, pct, at, done, total: list.length, leftMin, long };
}

/** A workflow's short name ("release-checks"), not the task's full description. */
const shortName = (t: TaskInfo) => (t.workflow && t.workflow !== t.description ? t.workflow : nameOf(t));
/** Where a running workflow stands, in one line: "Plan · step 1 of 6 · 1 of 2 agents done". */
function whereItStands(w: ReturnType<typeof readWorkflow>) {
  const phase = w.phases[w.at];
  if (!phase) return 'Starting';
  const xs = w.of(phase);
  return [phase, w.phases.length > 1 ? `step ${w.at + 1} of ${w.phases.length}` : null, xs.length ? `${xs.filter((a) => a.done).length} of ${xs.length} agents done` : 'starting its agents'].filter(Boolean).join(' · ');
}
const ONE_STEP: Record<string, string> = { Bash: 'running one command', WebFetch: 'reading one page', WebSearch: 'on one search', Read: 'reading one file', Edit: 'on one edit', Write: 'writing one file' };
/** "The plan agent has been running one command for 2h 19m." */
const longStepLine = (a: WfAgent, now: number) => `The ${agentName(a.label)} agent has been ${ONE_STEP[a.tool ?? ''] ?? 'on one step'} for ${fmt(now - (a.lastAt ?? now))}.`;
type RingState = 'running' | 'done' | 'stopped';

// Time so far: "0:43", "9:14", then "3h 10m" (a stopwatch past an hour is hard to read).
const clock = (ms: number) => { const s = Math.floor(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60000))} min`;

/** How far along, with time left (or, before there's an estimate, time so far) in the middle. */
function WorkflowRing({ pct, state, leftMin, elapsedMs, size = 'lg' }: { pct: number; state: RingState; leftMin: number | null; elapsedMs: number; size?: 'lg' | 'sm' }) {
  const R = 52, C = 2 * Math.PI * R;
  const sm = size === 'sm';
  // Just the fill: how far along. A sliver while it starts, so a running ring is never empty.
  const fill = state === 'done' ? 1 : Math.min(1, Math.max(state === 'running' ? 0.03 : 0, pct / 100));
  return (
    <div className={cn('relative shrink-0', sm ? 'size-7' : 'size-[132px]')}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth={sm ? 14 : 7} className="stroke-foreground/10" />
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth={sm ? 14 : 7} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - fill)}
          className={cn('transition-[stroke-dashoffset] duration-700 ease-out', state === 'stopped' ? 'stroke-foreground/35' : 'stroke-brand')} />
      </svg>
      {!sm && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {state === 'done' ? <><CheckIcon className="size-6 text-brand" /><span className="mt-1 text-small text-muted-foreground">{minutes(elapsedMs)}</span></>
          : state === 'stopped' ? <><SquareIcon className="size-4 fill-current text-muted-foreground" /><span className="mt-1.5 text-small text-muted-foreground">Stopped</span></>
          : leftMin != null ? <><span className="text-[26px] leading-none font-semibold tabular-nums">{leftMin < 1 ? '<1' : leftMin}</span><span className="mt-1 text-small text-muted-foreground">min left</span></>
          : <><span className="text-[22px] leading-none font-semibold tabular-nums">{clock(elapsedMs)}</span><span className="mt-1 text-small text-muted-foreground">so far</span></>}
      </div>}
    </div>
  );
}

/** A workflow: simple first (Canopy's reading of where it stands), with today's full view under "Show details":
 *  what it is, then its phases and every agent, live, like Claude Code's own view. Click an agent to open it up. */
function WorkflowDetail({ t, now, open, onClose }: { t: TaskInfo; now: number; open: boolean; onClose: () => void }) {
  const store = useStore();
  const running = RUNNING.has(t.status);
  const { agents, declared, unavailable } = useWorkflowAgents(open && running);
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [full, setFull] = useState(false);
  const phases = useMemo(() => byPhase(agents), [agents]);
  const toggle = (k: string) => setShown((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // Claude Code's own summary is often just "Dynamic workflow … completed": only a real report earns a section.
  const report = !running && t.summary && !/^dynamic workflow .* completed\.?$/i.test(t.summary.trim()) ? t.summary : null;
  const iconBtn = 'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground';
  const took = elapsed(t, now);
  const w = readWorkflow(agents, declared, running, took, now);
  const state: RingState = running ? 'running' : t.status === 'failed' || t.status === 'stopped' ? 'stopped' : 'done';
  const phase = w.phases[w.at];
  const inPhase = phase ? w.of(phase) : [];
  const head = state === 'done' ? 'Done' : state === 'stopped' ? `${t.status === 'failed' ? 'Failed' : 'Stopped'}${phase ? ` during ${phase.toLowerCase()}` : ''}` : phase ?? 'Starting';
  const sub = state === 'done' ? `${w.total} agents in ${minutes(took)}.`
    : state === 'stopped' ? `${w.done} of ${w.total} agents had finished.`
    : `Step ${w.at + 1} of ${Math.max(1, w.phases.length)} · ${inPhase.length ? `${inPhase.filter((a) => a.done).length} of ${inPhase.length} agents done` : 'starting its agents'}.`;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setFull(false); onClose(); } }}>
      <DialogContent showCloseButton={false} style={OVER_CHAT}
        className={cn('flex max-h-[82vh] max-w-none flex-col gap-0 overflow-hidden p-0 transition-[width] duration-300 sm:max-w-none',
          full ? 'w-[min(880px,calc(100vw-var(--canopy-sidebar,0px)-48px))]' : 'w-[min(540px,calc(100vw-var(--canopy-sidebar,0px)-48px))]')}>
        <div className="flex items-start gap-3 px-6 pt-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-small text-muted-foreground">
              <span>Workflow</span>
              {/* The running time, unless the ring's centre is already showing it. */}
              {!(state === 'running' && w.leftMin == null) && <><span className="text-faint">·</span><span className="flex items-center gap-1 tabular-nums"><ClockIcon className="size-3" />{clock(took)}</span></>}
              {full && modelsOf(agents) && <><span className="text-faint">·</span><span>{modelsOf(agents)}</span></>}
            </div>
            <DialogTitle className="mt-1 truncate text-body font-medium leading-snug">{shortName(t)}</DialogTitle>
            {shortName(t) !== nameOf(t) && <p className="mt-0.5 truncate text-small text-faint" title={nameOf(t)}>{nameOf(t)}</p>}
            <DialogDescription className="sr-only">{head}. {sub}</DialogDescription>
          </div>
          <button type="button" onClick={() => { setFull(false); onClose(); }} aria-label="Close" className={iconBtn}><XIcon className="size-4" /></button>
        </div>

        {/* Simple: where it stands, at a glance. */}
        <div className="px-6 pt-5 pb-1">
          <div className="flex items-center gap-6">
            <WorkflowRing pct={w.pct} state={state} leftMin={w.leftMin} elapsedMs={took} />
            <div className="min-w-0 flex-1">
              <div className="text-ui font-medium">{head}</div>
              <p className="mt-0.5 text-small text-muted-foreground">{sub}</p>
              {w.phases.length > 0 && (
                <div className="mt-4 flex gap-1.5">
                  {w.phases.map((p, i) => {
                    const xs = w.of(p);
                    const frac = xs.length ? xs.filter((a) => a.done).length / xs.length : 0;
                    const isDone = state === 'done' || i < w.at;
                    const isNow = state === 'running' && i === w.at;
                    return (
                      <div key={p} className="min-w-0 flex-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                          <div className={cn('h-full rounded-full transition-[width] duration-700', isDone ? 'bg-foreground/45' : isNow ? 'bg-brand' : 'bg-transparent')} style={{ width: isDone ? '100%' : isNow ? `${Math.max(6, frac * 100)}%` : '0%' }} />
                        </div>
                        <div className={cn('mt-1.5 truncate text-small', isNow ? 'text-foreground' : 'text-muted-foreground')}>{isDone && <CheckIcon className="mr-1 inline size-3 -translate-y-px" />}{p}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          {w.long && <p className="mt-4 rounded-lg bg-foreground/[0.04] px-3 py-2 text-small text-muted-foreground">{longStepLine(w.long, now)}</p>}
          <div className="mt-5 mb-4 flex items-center gap-2">
            <button type="button" onClick={() => setFull(!full)} aria-expanded={full}
              className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-ui text-muted-foreground hover:bg-accent hover:text-foreground">
              {full ? 'Hide details' : 'Show details'}<ChevronDownIcon className={cn('size-3.5 transition-transform', full && 'rotate-180')} />
            </button>
            {running && <button type="button" onClick={() => store.stopTask(t.taskId)} className="ml-auto flex h-8 items-center rounded-lg border border-hairline px-3 text-ui hover:bg-accent">Stop</button>}
            {!running && report && !full && <button type="button" onClick={() => setFull(true)} className="ml-auto flex h-8 items-center rounded-lg bg-foreground px-3 text-ui font-medium text-background hover:opacity-90">Read the report</button>}
          </div>
        </div>

        {full && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-hairline px-6 py-5">
          {report && <div className="prose-reply prose-compact mb-6 text-muted-foreground"><MessageResponse>{report}</MessageResponse></div>}
          {!agents ? (
            <p className="py-8 text-center text-small text-faint">{unavailable ? 'Restart Canopy to see this workflow’s agents.' : 'Loading the agents…'}</p>
          ) : phases.map(([phase, list]) => {
            const n = list.filter((x) => x.done).length;
            return (
              <section key={phase} className="mb-6 last:mb-0">
                <div className="mb-2 flex items-center gap-2 text-ui">
                  <span className={cn('flex w-4 justify-center', n === list.length ? 'text-good' : 'text-muted-foreground')}>{n === list.length ? '✓' : running ? <Spin /> : '–'}</span>
                  <span className="font-medium">{phase}</span>
                  <span className="tabular-nums text-small text-faint">{n} of {list.length} done</span>
                </div>
                <div className="ml-[7px] flex flex-col gap-1 border-l border-hairline pl-4">
                  {list.map((x, i) => {
                    const [doing, meta] = agentLine(x, running, now);
                    const isOpen = shown.has(x.key);
                    return (
                      <div key={x.key} className={cn('rounded-lg transition-colors', isOpen ? 'bg-accent/30' : 'hover:bg-accent/20')}>
                        <button type="button" onClick={() => toggle(x.key)} aria-expanded={isOpen}
                          className="flex w-full min-w-0 items-center gap-2.5 px-2.5 py-2 text-left text-ui">
                          <span className="flex w-3.5 shrink-0 justify-center">{x.done ? <span className="text-good">✓</span> : running ? <Spin className="size-3" /> : <span className="text-faint">–</span>}</span>
                          <span className="shrink-0 tabular-nums text-faint">{i + 1}.</span>
                          <span className="shrink-0 text-foreground">{agentName(x.label)}</span>
                          {doing && !isOpen && <span className="min-w-0 truncate text-small text-faint"><span className="shimmer-text">{doing}</span></span>}
                          <span className="ml-auto shrink-0 pl-3 text-small tabular-nums text-faint">{meta}</span>
                          <ChevronRightIcon className={cn('size-3.5 shrink-0 text-faint transition-transform duration-150', isOpen && 'rotate-90')} />
                        </button>
                        {isOpen && (
                          <div className="px-2.5 pb-3 pl-[46px] text-small">
                            {doing && <p className="mb-2 break-words text-muted-foreground"><span className="shimmer-text">{doing}</span></p>}
                            {x.result ? <AgentOutput text={x.result} />
                              : <p className="text-faint">{running && !x.done ? 'Its output shows here when it finishes.' : 'No output.'}</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** An agent's full report, in a proper reading view over the chat. */
/** A background agent's steps in words, refreshed every 2s while it runs (the agent's id is its task's id). */
function useAgentSteps(agentId: string, running: boolean) {
  const store = useContext(StoreContext);
  const [data, setData] = useState<Awaited<ReturnType<NonNullable<typeof api.agentSteps>>>>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.agentSteps?.(store.sid ? store.cwd : null, store.sid ? store.meta.sessionId : null, agentId).then((r) => { if (alive) setData(r ?? null); }).catch(() => {});
    load();
    if (!running) return () => { alive = false; };
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [agentId, running]); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}
const ago = (at: number | null, now: number) => { if (!at) return ''; const s = Math.max(0, Math.round((now - at) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };

/** An agent, simple first: what it's doing now and its last few steps in words; "Show all steps" widens it to every
 *  step and its report. Stop while it runs; Read the report once it's done. */
function AgentDetail({ t, now, onClose }: { t: TaskInfo; now: number; onClose: () => void }) {
  const store = useStore();
  const running = RUNNING.has(t.status);
  const data = useAgentSteps(t.taskId, running);
  const [full, setFull] = useState(false);
  const steps = data?.total ?? t.usage?.tool_uses ?? 0;
  const took = elapsed(t, now);
  const report = !running ? (t.summary && t.summary.trim() !== nameOf(t) ? t.summary : data?.result ?? null) : null;
  const recent = [...(data?.steps ?? [])].reverse();
  const iconBtn = 'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground';
  const head = running ? null : t.status === 'failed' ? (t.error || 'It hit a problem and stopped.') : t.status === 'stopped' ? 'Stopped' : `Done · ${steps} step${steps === 1 ? '' : 's'} in ${fmt(took)}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false} style={OVER_CHAT}
        className={cn('flex max-h-[82vh] max-w-none flex-col gap-0 overflow-hidden p-0 transition-[width] duration-300 sm:max-w-none',
          full ? 'w-[min(760px,calc(100vw-var(--canopy-sidebar,0px)-48px))]' : 'w-[min(540px,calc(100vw-var(--canopy-sidebar,0px)-48px))]')}>
        <div className="flex items-start gap-3 px-6 pt-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-small text-muted-foreground">
              <span>Agent</span><span className="text-faint">·</span>
              <span className="flex items-center gap-1 tabular-nums"><ClockIcon className="size-3" />{fmt(took)}</span>
            </div>
            <DialogTitle className="mt-1 truncate text-body font-medium leading-snug">{nameOf(t)}</DialogTitle>
            <DialogDescription className="sr-only">{running ? noteOf(t) : head}</DialogDescription>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={iconBtn}><XIcon className="size-4" /></button>
        </div>

        <div className="px-6 pt-4 pb-1">
          {running ? (
            <p className="text-ui"><span className="working-line font-medium">Now: {noteOf(t)}</span><span className="ml-2 text-small text-faint tabular-nums">{steps ? `${steps} step${steps === 1 ? '' : 's'} · ` : ''}{fmt(took)}</span></p>
          ) : <p className={cn('text-ui', t.status === 'failed' ? 'text-destructive/90' : 'text-foreground')}>{head}</p>}

          {!full && recent.length > 0 && (
            <ol className="mt-3 flex flex-col">
              {recent.slice(0, 5).map((x, i) => (
                <li key={i} className="flex min-w-0 items-baseline gap-3 border-b border-hairline py-1.5 text-small last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={x.text}>{x.text}</span>
                  <span className="shrink-0 tabular-nums text-faint">{ago(x.at, now)}</span>
                </li>
              ))}
            </ol>
          )}
          {!full && !data && <p className="mt-3 text-small text-faint">Reading its steps…</p>}

          <div className="mt-4 mb-4 flex items-center gap-2">
            {(recent.length > 5 || report) && (
              <button type="button" onClick={() => setFull(!full)} aria-expanded={full}
                className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-ui text-muted-foreground hover:bg-accent hover:text-foreground">
                {full ? 'Show less' : 'Show all steps'}<ChevronDownIcon className={cn('size-3.5 transition-transform', full && 'rotate-180')} />
              </button>
            )}
            {running && <button type="button" onClick={() => store.stopTask(t.taskId)} className="ml-auto flex h-8 items-center rounded-lg border border-hairline px-3 text-ui hover:bg-accent">Stop</button>}
            {report && !full && <button type="button" onClick={() => setFull(true)} className="ml-auto flex h-8 items-center rounded-lg bg-foreground px-3 text-ui font-medium text-background hover:opacity-90">Read the report</button>}
          </div>
        </div>

        {full && (
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-hairline px-6 py-5">
            {report && <div className="prose-reply prose-compact mb-6 text-muted-foreground"><MessageResponse>{report}</MessageResponse></div>}
            <div className="mb-2 text-label text-muted-foreground">{recent.length < steps ? `Latest ${recent.length} of ${steps} steps` : `All steps · ${steps}`}</div>
            <ol className="flex flex-col">
              {recent.map((x, i) => (
                <li key={i} className="flex min-w-0 items-baseline gap-3 py-1 text-small">
                  <span className="w-8 shrink-0 text-right tabular-nums text-faint">{recent.length - i}.</span>
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">{x.text}</span>
                  <span className="shrink-0 tabular-nums text-faint">{ago(x.at, now)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AgentReport({ task, onClose }: { task: TaskInfo | null; onClose: () => void }) {
  const steps = task?.usage?.tool_uses;
  const ms = task?.usage?.duration_ms ?? (task?.endedAt && task?.startedAt ? task.endedAt - task.startedAt : 0);
  return (
    <Dialog open={!!task} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={OVER_CHAT} className="flex max-h-[80vh] w-[min(760px,calc(100vw-var(--canopy-sidebar,0px)-48px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="border-b border-hairline px-6 py-4">
          <DialogTitle className="text-title">{task ? nameOf(task) : ''}</DialogTitle>
          <DialogDescription className="mt-0.5 text-small text-muted-foreground">
            {task ? kindOf(task).replace(/^./, (c) => c.toUpperCase()) : 'Agent'} report{ms ? ` · ${fmt(ms)}` : ''}{steps ? ` · ${steps} steps` : ''}
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="prose-reply"><MessageResponse>{task?.summary ?? ''}</MessageResponse></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

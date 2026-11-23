// The conversation, organized into turns, read like the terminal:
//   your message → Claude's messages and its tool work in order, live → once done, all of that folds into
//   "Worked for Ns" above the final answer → changed-file card.
import { Fragment, createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AlertTriangleIcon, ChevronRightIcon, CornerDownRightIcon, FileDiffIcon, CopyIcon, CheckIcon, MessageCircleQuestionIcon, PencilIcon, RotateCcwIcon, SquareTerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { MessageResponse } from '@/components/ai-elements/message';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { api, type ImageAttachment } from '@/lib/api';
import { widgetMemory } from '@/lib/widget-state';
import { COMPACTING_STATUS, StoreContext, useStore, type Store, type AssistantItem, type CodeCall, type ErrorItem, type HandoffItem, type Item, type ThinkingItem, type ToolItem, type TurnItem, type UserItem } from '@/lib/store';
import { feature } from '@/lib/telemetry';
import { ui, useUi } from '@/lib/ui';
import { backgroundCount, editBlocked, filesLabel } from '@/lib/edit';
import { useSmoothText } from '@/lib/smooth-text';
import { cn } from '@/lib/utils';
import { computerUseAction, isComputerUse } from '@/lib/computer-use';
import { isUpdateRequest } from '@/lib/request-updates';
import { parseRunReport, type RunReport } from '@/lib/run-report';
import { RunnableReplies } from './run-block';
import { usePane } from '@/lib/pane';
import { useHeld } from '@/lib/held';
import { buildsOn, hiddenBy, isPlan, waitingPlan } from '@/lib/plan';
import { useModelName } from '@/lib/turn-model';
import { SignInAction } from './account-prompt';
import { MessageImages } from './message-images';
import { FileCard } from './file-card';
import { splitFiles } from '@/lib/file-mentions';
import { PlanCard } from './plan-card';
import { WidgetFrame } from './widget-frame';
import { LiveOutput, OutputTail } from './live-output';
import { Logo } from './logo';
import { Reveal } from './reveal';
import { SwitchLine } from './handoff-line';
import { ComputerUseIcon } from './computer-use-icon';
import { ForestIcon, type ForestKind } from './forest-icons';
import { InTaskCard, ToolLogos } from './tool-logos';
import { CODE_TOOL, EDIT_TOOLS, FORGET_TOOL, GUIDE_TOOL, LOOK_TOOL, READ_CHAT_TOOL, RECALL_TOOL, REMEMBER_TOOL, SHOW_TOOL, TASK_TOOL, ToolInputView, ToolResultView, clip, codeTitle, editStats, isImageView, mcpInfo, toolActivity, toolSummary, toolTitle } from './tool-details';
import { ComputerUseFixLine, ComputerUseFixes } from './computer-use-fix';
import { ReceivedText, SentText, isSentText } from './chat-text';
import { Wordmark } from './wordmark';
import { MemoryRow } from './memory-row';

// ---------- turn model ----------
// `all` is the turn in the order it happened; `work` and `answer` are the two halves it is shown as.
/** `before`: where the chat switched maker just before this turn ("Canopy switched from … → …", handoff-line.tsx). */
type Turn = { key: string; user?: UserItem; all: Item[]; work: Item[]; answer: Item[]; end?: TurnItem; edits: ToolItem[]; startedAt: number; before?: HandoffItem[] };

/** Claude said something: assistant text that isn't an empty block. */
const isSaid = (it: Item): it is AssistantItem => it.t === 'assistant' && !!it.text.trim();
/** A widget Claude showed (show_widget): part of what it said, drawn where it said it, never folded into the work. */
// A plan's card stays in view the same way, and so does a message this chat sent another one: it's something Claude said.
// So does a note saved to memory or taken out of it: that outlives the chat, so its line (with Undo) is never folded
// away with the work.
const isMemory = (it: Item): boolean => it.t === 'tool' && (it.name === REMEMBER_TOOL || it.name === FORGET_TOOL);
const isShow = (it: Item): boolean => (it.t === 'tool' && it.name === SHOW_TOOL) || isMemory(it) || isPlan(it) || isSentText(it);
/** Reading the widget guide is plumbing: it gets no line of its own and is not what a turn "worked" on. So is
 *  reporting a task: its calls are drawn together as the turn's one card (TaskCard), never as rows. */
const isGuide = (it: Item): boolean => it.t === 'tool' && (it.name === GUIDE_TOOL || it.name === TASK_TOOL);
const isStep = (it: Item): it is ToolItem | ThinkingItem => (it.t === 'tool' && !isShow(it) && !isGuide(it)) || it.t === 'thinking';
function lastOf<T extends Item>(items: Item[], is: (it: Item) => it is T): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (is(it)) return it; }
  return undefined;
}

// A widget shown again under the same title in the same reply is the same widget, corrected: only the newest one that
// has fully arrived is drawn, in the place the first one took. So a fix replaces a mistake instead of piling under
// it, and while the fix is still being written the earlier one stays up.
const tookPlaceOf = new WeakMap<Item, string>(); // the widget drawn -> the id of the one whose place (and size) it has
// "Usage by chat (corrected)" is still "Usage by chat": a note in brackets at the end is not part of the name.
const widgetTitle = (it: Item) => (it.t === 'tool' ? String(it.input?.title ?? '').replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim().toLowerCase() : '');
function settleWidgets(all: Item[]): Item[] {
  const groups = new Map<string, ToolItem[]>();
  for (const it of all) {
    const title = isShow(it) && !isMemory(it) ? widgetTitle(it) : ''; // a saved note has a title too, and is no widget
    if (!title) continue;
    const g = groups.get(title);
    if (g) g.push(it as ToolItem); else groups.set(title, [it as ToolItem]);
  }
  const drop = new Set<Item>();
  const swap = new Map<Item, ToolItem>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const best = [...g].reverse().find((w) => !w.streaming && !w.isError) ?? g[0];
    for (const w of g) if (w !== g[0]) drop.add(w);
    if (best !== g[0]) { swap.set(g[0], best); tookPlaceOf.set(best, g[0].id); }
  }
  return drop.size ? all.filter((it) => !drop.has(it)).map((it) => swap.get(it) ?? it) : all;
}

/** The chat's turns. `tail` gets the switch lines that no turn follows yet (a switch with no message since). */
function toTurns(items: Item[], tail: HandoffItem[] = []): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let switched: HandoffItem[] = [];
  const start = (user?: UserItem, key?: string) => {
    cur = { key: key ?? `t${turns.length}`, user, all: [], work: [], answer: [], edits: [], startedAt: user?.at ?? Date.now(), ...(switched.length && { before: switched }) };
    switched = [];
    turns.push(cur);
    return cur;
  };
  for (const it of items) {
    // Where the chat switched maker: drawn above the next turn, which it starts (a switch is never mid-turn).
    if (it.t === 'handoff') { if (it.ev.dir === 'switch') { switched.push(it); cur = null; } continue; }
    // A message sent while Claude works goes into the running turn: the turn carries on (its work stays in view, no
    // "Done" yet) and the message sits where it was sent. Any other message starts a turn.
    if (it.t === 'user') {
      const running = cur as Turn | null; // assigned in start(), which TypeScript can't see from here
      if (it.steered && running && !running.end) running.all.push(it); else start(it, it.key);
      continue;
    }
    if (!cur && (it.t === 'raw' || it.t === 'turn')) continue; // startup hook output before any message
    // start() assigns `cur`, so remember whether this item opened the turn before calling it.
    // (Checking `!cur` afterwards is always false, which left startedAt at Date.now() on every render.)
    const opened = !cur;
    const t: Turn = cur ?? start(undefined, `t-${it.key}`);
    if (opened) t.startedAt = it.at;
    if (it.t === 'permission' && !isPlan(it)) continue; // pending ones dock at the composer; answered ones are noise. A plan's card is in the chat
    if (isPlan(it)) t.all = t.all.filter((x) => !hiddenBy(x, it)); // the card says the plan: not the reply too
    if (it.t === 'turn') {
      t.end = it;
      // The turn ended before Claude took in a message steered into it (nothing came after it): Claude Code runs that
      // message as the next turn, so that is where it goes.
      const steer = t.all.at(-1);
      if (steer?.t === 'user') { t.all.pop(); start(steer, steer.key); }
      continue;
    }
    if (t.end && buildsOn(t.all, it)) t.end = undefined; // Build it: the building is the plan's own turn carrying on
    t.all.push(it);
  }
  // Work = everything up to the last tool call or thinking block. The answer is what follows.
  // Hook output ("raw") never moves that boundary, otherwise a hook that runs after the reply
  // would fold the reply away.
  for (const t of turns) {
    t.all = settleWidgets(t.all);
    const all = t.all;
    let last = -1;
    all.forEach((it, i) => { if (isStep(it)) last = i; });
    const head = all.slice(0, last + 1);
    const tail = all.slice(last + 1);
    t.work = [...head.filter((it) => it.t !== 'error' && it.t !== 'notice'), ...tail.filter((it) => it.t === 'raw')];
    // An empty text block (its first words haven't landed yet) is nothing to show: it would only add a gap.
    t.answer = [...head.filter((it) => it.t === 'error' || it.t === 'notice'), ...tail.filter((it) => it.t !== 'raw' && (it.t !== 'assistant' || isSaid(it)))];
    t.edits = t.work.filter((it): it is ToolItem => it.t === 'tool' && EDIT_TOOLS.has(it.name) && it.status !== 'error');
  }
  tail.push(...switched);
  return turns;
}

// ---------- fold anatomy ----------
// Every fold is the same: text, then a trailing chevron that turns a quarter when open.
// The rotation is written as `transform` (not Tailwind's `rotate`) so the shared 160ms
// transform transition on collapsible-trigger SVGs in index.css applies to it.
function Chevron({ group }: { group: 's' | 'r' | 'w' | 'n' }) {
  const open = {
    s: 'group-data-[state=open]/s:[transform:rotate(90deg)]',
    r: 'group-data-[state=open]/r:[transform:rotate(90deg)]',
    w: 'group-data-[state=open]/w:[transform:rotate(90deg)]',
    n: 'group-data-[state=open]/n:[transform:rotate(90deg)]',
  }[group];
  return <ChevronRightIcon aria-hidden className={cn('size-3.5 shrink-0 text-faint', open)} />;
}

// ---------- fold memory ----------
// What you've opened or closed (steps, grouped runs), by key, for the life of the chat. Rows remount all the time:
// Radix unmounts a closed fold's content, and a run regroups under a summary line when its second step starts.
// Without this, every remount would collapse what you had open.
const Folds = createContext(new Map<string, boolean>());
function useFold(key: string, initial: boolean) {
  const folds = useContext(Folds);
  const [open, setOpen] = useState(() => folds.get(key) ?? initial);
  // useContext underneath, so always called; outside a Conversation there's simply nothing to pin.
  let stick: ReturnType<typeof useStickToBottomContext> | null = null;
  try { stick = useStickToBottomContext(); } catch { /* not in a Conversation */ }
  // Opening a fold near the bottom used to scroll the whole chat up (the view is pinned to the bottom), so the line
  // you clicked slid out from under the pointer. Now the clicked line stays exactly where it is and the fold opens
  // downward: unpin, render the change at once, then undo whatever shift the browser made.
  const set = (next: boolean) => {
    const el = document.activeElement as HTMLElement | null;
    const sc = stick?.scrollRef.current ?? null;
    const before = el && sc?.contains(el) ? el.getBoundingClientRect().top : null;
    stick?.stopScroll();
    folds.set(key, next);
    flushSync(() => setOpen(next));
    if (before != null && sc && el) { const d = el.getBoundingClientRect().top - before; if (Math.abs(d) > 0.5) sc.scrollTop += d; }
  };
  return [open, set] as const;
}
/** Agents open themselves while they run, so you can watch their steps. */
const autoOpen = (_it: Item) => false; // nothing opens itself: a helper agent's steps are one click away

// ---------- pieces ----------
// The work timeline reads like the terminal, but calmer: one line per step with an icon, Claude's own notes in
// readable text between them, thinking shown live while it happens. Chevrons only appear on hover.
const hoverChevron = (g: 's') => <span className="opacity-0 transition-opacity duration-120 group-hover/s:opacity-100 group-data-[state=open]/s:opacity-100"><Chevron group={g} /></span>;
const stepRow = 'group/s relative flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/20';
// The line between two messages: small and quiet, like a footnote, so Claude's own words lead.
const workLine = 'group/s relative flex h-6 w-fit max-w-full min-w-0 items-center gap-1 rounded-md text-left text-small text-faint outline-none hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-foreground/20';
/** The last few lines of live thinking, so you can watch it without opening anything. */
const thinkingTail = (t: string) => { const x = t.trim(); return x.length > 320 ? '…' + x.slice(-320) : x; };

const StepRow = memo(function StepRow({ item }: { item: Item; rev: number }) {
  const [open, setFold] = useFold(item.key, autoOpen(item));
  const setOpen = (next: boolean) => { if (next && item.t === 'tool') feature('tool_details_opened'); setFold(next); };
  if (item.t === 'assistant') {
    return item.text.trim() ? <div className="prose-reply py-0.5"><MessageResponse>{item.text}</MessageResponse></div> : null;
  }
  if (item.t === 'raw') return null; // hook output is noise
  if (item.t === 'thinking') {
    if (item.streaming) {
      return (
        <div className="flex min-w-0 py-1">
          <div className="min-w-0">
            <span className="shimmer-text text-ui">Thinking</span>
            {item.text.trim() && <p className="mt-0.5 line-clamp-3 text-small text-faint">{thinkingTail(item.text)}</p>}
          </div>
        </div>
      );
    }
    if (!item.text.trim()) return null; // nothing to open
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className={stepRow}>
          Thought{hoverChevron('s')}
        </CollapsibleTrigger>
        <CollapsibleContent className="ml-[2px] border-l border-hairline pl-[14px] prose-reply prose-compact text-muted-foreground">
          <MessageResponse>{item.text}</MessageResponse>
        </CollapsibleContent>
      </Collapsible>
    );
  }
  if (item.t !== 'tool') return null;
  const running = item.status === 'running' || item.status === 'approval';
  const computer = isComputerUse(item.name);
  if (item.name === CODE_TOOL) return <CodeStep item={item} open={open} setOpen={setOpen} />;
  if (item.name === SHOW_TOOL) return <Widget item={item} />;
  if (item.name === REMEMBER_TOOL || item.name === FORGET_TOOL) return <MemoryRow item={item} />;
  if (isSentText(item)) return <SentText item={item} className="my-1" />;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={stepRow}>
        {computer && <ComputerUseIcon active={item.status === 'running'} className="size-5 rounded-md" />}
        {!computer && <ToolLogos tools={[item]} className="mr-1" />}
        <span className={cn('shrink-0', item.status === 'error' ? 'text-destructive' : running ? 'shimmer-text' : 'text-foreground/80')}>{toolTitle(item.name, item.input)}</span>
        {/* Computer Use and an image's name read as words, not as code. */}
        {computer || isImageView(item.name, item.input) ? <span className="min-w-0 truncate text-small text-faint">{toolSummary(item.name, item.input)}</span>
          : <code className="min-w-0 truncate font-mono text-code text-faint">{toolSummary(item.name, item.input)}</code>}
        {hoverChevron('s')}
        {item.status === 'approval' && <span className="ml-1 shrink-0 text-small text-warn">Waiting for you</span>}
        {item.status === 'error' && <span className="ml-1 shrink-0 text-small text-destructive">Failed</span>}
      </CollapsibleTrigger>
      {/* A command that prints while it runs: its last lines under the closed row, all of it in the open one. */}
      {running && !open && <OutputTail text={item.output} className="mb-1" />}
      {/* Computer Use stopped by something you can fix (a macOS permission, an app that was not allowed): say so, with the fix. */}
      {item.status === 'error' && <ComputerUseFixLine name={item.name} result={item.result} failed />}
      <CollapsibleContent className="mt-1 mb-2 ml-[2px] flex flex-col gap-2 border-l border-hairline pl-[30px]">
        <ToolInputView name={item.name} input={item.input} />
        {item.children.length > 0 && <div className="flex flex-col">{item.children.map((c) => <StepRow key={c.key} item={c} rev={c.rev} />)}</div>}
        {running && <LiveOutput text={item.output} />}
        <ToolResultView name={item.name} input={item.input} result={item.result} isError={item.isError} images={item.images} />
      </CollapsibleContent>
    </Collapsible>
  );
}, (a, b) => a.item === b.item && a.rev === b.rev);

// ---------- widgets ----------
// Something Claude showed: drawn in place by the frame host, from the first word of its HTML. What it answers goes to
// Claude as your next message, the way the message box would send it: now, or behind the turn that is running.
// In the reply to Request Updates it is shown whole instead: a skeleton until all of it has arrived (WholeWidgets).
const WholeWidgets = createContext(false);
function Widget({ item }: { item: ToolItem }) {
  const store = useContext(StoreContext);
  const whole = useContext(WholeWidgets);
  const code = typeof item.input?.widget_code === 'string' ? item.input.widget_code : '';
  const title = typeof item.input?.title === 'string' ? item.input.title : '';
  // Refused before anything was drawn (empty, or far too large): one quiet line, like any step that failed.
  if (item.isError && !item.streaming) {
    return <div className="flex h-6 items-center gap-2 text-small text-faint"><span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" /><span className="truncate">Couldn’t draw {title || 'this'}</span></div>;
  }
  // Nothing to draw until its first HTML arrives (the title is written first): the status line says it is being drawn.
  if (!code) return null;
  // Pictures a widget sends (notes drawn on a screenshot) go with the words, exactly as if pasted.
  const send = (text: string, images: ImageAttachment[]) => { if (store.meta.busy || store.meta.queue.length) store.enqueue(text, images); else store.dispatch(text, images); };
  // Tell the engine how drawing it went, so a script that failed is something Claude hears about and can fix.
  const drawn = item.hist ? undefined : (report: { errors: string[] }) => { api.widgetReport?.(item.id, report); };
  return <WidgetFrame key={item.id} callId={item.id} title={title} code={code} streaming={!!item.streaming} cut={item.cut} live={!item.hist}
    reserve={widgetMemory.get(tookPlaceOf.get(item) ?? '')?.h} onSend={send} onDrawn={drawn} whole={whole} sessionId={store.meta.sessionId} />;
}

// ---------- Code Mode ----------
// One step for the whole script: Claude's own name for it as the title, the calls it made as quiet rows (live while it
// runs), the script itself one more click away, then what it handed back.
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
/** "5 calls · 1 denied" for a script's step. A saved chat keeps no calls, so it says how long the script is. */
function codeSummary(item: ToolItem) {
  const calls = item.calls ?? [];
  if (!calls.length) return plural(String(item.input.code ?? '').split('\n').length, 'line');
  const denied = calls.filter((c) => c.status === 'denied').length;
  const failed = calls.filter((c) => c.status === 'error').length;
  return [plural(calls.length, 'call'), denied ? `${denied} denied` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
}

function CodeCallRow({ call, live }: { call: CodeCall; live: boolean }) {
  // A call still open on a script that is over was cut off with it.
  const status = !live && (call.status === 'running' || call.status === 'approval') ? 'error' : call.status;
  const busy = status === 'running' || status === 'approval';
  // A call that did not go through says why in place of its arguments: the reason is what the reader is after.
  const why = (status === 'denied' || status === 'error') && call.error && call.error !== 'Stopped' && call.error !== 'Timed out' ? call.error.replace(/^The tool did not run: /, '') : '';
  const summary = why || toolSummary(call.name, call.input);
  return (
    <div className="flex h-6 min-w-0 items-center gap-2 text-small" title={call.error}>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {isComputerUse(call.name) ? <ComputerUseIcon active={status === 'running'} className="size-4 rounded-sm [&_svg]:size-3" /> : call.name.startsWith('mcp__') ? <ToolLogos tools={[call]} /> : busy ? <span className="live-dot" />
          : <span className={cn('size-1.5 rounded-full', status === 'ok' ? 'bg-muted-foreground/40' : status === 'denied' ? 'bg-warn' : 'bg-destructive')} />}
      </span>
      <span className={cn('shrink-0', busy ? 'shimmer-text' : status === 'ok' ? 'text-foreground/80' : 'text-muted-foreground')}>{toolTitle(call.name, call.input)}</span>
      {summary && (why ? <span className="min-w-0 truncate text-faint">{summary}</span> : <code className="min-w-0 truncate font-mono text-code text-faint">{summary}</code>)}
      <span className={cn('ml-auto shrink-0 pl-2 tabular-nums', status === 'approval' || status === 'denied' ? 'text-warn' : status === 'error' ? 'text-destructive' : 'text-faint')}>
        {status === 'approval' ? 'Waiting for you' : status === 'denied' ? 'Denied' : status === 'error' ? (call.error === 'Stopped' ? 'Stopped' : call.error === 'Timed out' ? 'Timed out' : 'Failed')
          : status === 'ok' ? [call.note, call.ms != null && took(call.ms)].filter(Boolean).join(' · ') : ''}
      </span>
    </div>
  );
}

function CodeStep({ item, open, setOpen }: { item: ToolItem; open: boolean; setOpen: (next: boolean) => void }) {
  const [script, setScript] = useFold(`${item.key}-script`, false);
  const running = item.status === 'running' || item.status === 'approval';
  const calls = item.calls ?? [];
  // The newest calls are at the bottom of a list that scrolls: while the script runs they stay in view, unless the
  // reader has scrolled up to look at an earlier one.
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && running && follow.current) el.scrollTop = el.scrollHeight;
  }, [calls.length, open, running]);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={stepRow}>
        <span className={cn('min-w-0 shrink truncate', item.status === 'error' ? 'text-destructive' : running ? 'shimmer-text' : 'text-foreground/80')}>{codeTitle(item.input)}</span>
        <span className="shrink-0 text-small text-faint">{codeSummary(item)}</span>
        {hoverChevron('s')}
        {item.status === 'approval' && <span className="ml-1 shrink-0 text-small text-warn">Waiting for you</span>}
        {item.status === 'error' && <span className="ml-1 shrink-0 text-small text-destructive">Failed</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 mb-2 ml-[2px] flex flex-col gap-2 border-l border-hairline pl-[30px]">
        {calls.length > 0 && (
          <div ref={list} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }} className="flex max-h-64 flex-col overflow-y-auto">
            {calls.map((c) => <CodeCallRow key={c.id} call={c} live={running} />)}
          </div>
        )}
        <Collapsible open={script} onOpenChange={setScript}>
          <CollapsibleTrigger className={workLine}>Script<Chevron group="s" /></CollapsibleTrigger>
          <CollapsibleContent className="mt-1"><ToolInputView name={item.name} input={item.input} /></CollapsibleContent>
        </Collapsible>
        <ToolResultView name={item.name} input={item.input} result={item.result} isError={item.isError} />
      </CollapsibleContent>
    </Collapsible>
  );
}

// read_chat in a summary line: reading one chat, or listing them. Never "Used Canopy chats": it is not a connector.
const chatKind = (t: ToolItem) => (typeof t.input.chat === 'string' && t.input.chat.trim() ? 'chat' : 'chats');

/** "a", "a and b", "a, b, and c". */
const list = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs.at(-1)}`);

/** "Thought, ran 2 commands and 2 agents": everything Claude did between two of its messages, in one plain line. */
function workSummary(items: Work[]) {
  const c: Record<string, number> = {};
  const apps: string[] = [];
  for (const t of items) {
    if (t.t !== 'tool') continue;
    const n = t.name;
    const k = n === 'Bash' ? 'command' : isImageView(n, t.input) ? 'image' : n === 'Read' ? 'read' : EDIT_TOOLS.has(n) || n === 'NotebookEdit' ? 'edit'
      : n === 'Grep' || n === 'Glob' ? 'search' : n === 'WebSearch' ? 'web' : n === 'WebFetch' ? 'page'
      : n === 'Task' || n === 'Agent' ? 'agent' : n === 'TodoWrite' ? 'todo' : n === CODE_TOOL ? 'script' : n === LOOK_TOOL ? 'look' : n === READ_CHAT_TOOL ? chatKind(t) : n === RECALL_TOOL ? 'recall' : n.startsWith('mcp__') ? 'app' : 'other';
    if (k === 'app') { const a = mcpInfo(n, t.input).app; if (!apps.includes(a)) apps.push(a); }
    c[k] = (c[k] ?? 0) + 1;
  }
  const many = (k: string, one: string, plural: string) => (c[k] === 1 ? one : `${c[k]} ${plural}`);
  // "ran": commands, agents and scripts read as one phrase ("ran 2 commands and an agent").
  const ran = [c.command && many('command', 'a command', 'commands'), c.agent && many('agent', 'an agent', 'agents'), c.script && many('script', 'a script', 'scripts')].filter(Boolean) as string[];
  const parts = [
    items.some((i) => i.t === 'thinking') ? 'thought' : null,
    c.read ? `read ${many('read', 'a file', 'files')}` : null,
    c.image ? `viewed ${many('image', 'an image', 'images')}` : null,
    c.search ? `searched ${c.search === 1 ? 'the code' : `${c.search} times`}` : null,
    c.edit ? `edited ${many('edit', 'a file', 'files')}` : null,
    ran.length ? `ran ${ran.join(' and ')}` : null,
    apps.length ? `used ${list(apps)}` : null,
    c.web ? 'searched the web' : null,
    c.page ? `read ${many('page', 'a web page', 'web pages')}` : null,
    c.todo ? 'updated the to-do list' : null,
    c.look ? `took ${many('look', 'a screenshot', 'screenshots')}` : null,
    c.chat ? `read ${many('chat', 'another chat', 'other chats')}` : c.chats ? 'listed your other chats' : null,
    c.recall ? 'checked memory' : null,
    c.other ? (c.other === 1 ? 'one more step' : `${c.other} more steps`) : null,
  ].filter(Boolean) as string[];
  const text = list(parts.length ? parts : ['worked']);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const WorkRun = memo(function WorkRun({ id, items }: { id: string; items: Work[]; revs: string }) {
  // A single step shows what it actually did; anything more is one summary line with the steps inside.
  return <WorkGroup id={id} items={items} />;
}, (a, b) => a.revs === b.revs);

function WorkGroup({ id, items }: { id: string; items: Work[] }) {
  const [open, setOpen] = useFold(id, false);
  const tools = items.filter((i): i is ToolItem => i.t === 'tool');
  const failed = tools.filter((t) => t.status === 'error').length;
  const last = items[items.length - 1];
  const thinking = last.t === 'thinking' && last.streaming;
  const running = thinking || tools.some((t) => t.status === 'running' || t.status === 'approval');
  // While a step runs, say what it's doing now, in the present tense ("Running: Test both calls"), not "Ran a command".
  const now = [...tools].reverse().find((t) => t.status === 'running' || t.status === 'approval');
  const computer = now ? isComputerUse(now.name) : tools.length > 0 && tools.every((t) => isComputerUse(t.name));
  const computerWaiting = computer && tools.some((t) => t.status === 'approval');
  useTicker(computer && !!now, now?.at ?? 0);
  const desc = now?.name === 'Bash' && typeof now.input?.description === 'string' ? now.input.description.trim() : '';
  // A script says how far it has got: a count is calmer than the names of calls that each take milliseconds.
  const made = now?.name === CODE_TOOL && now.calls?.length ? ` · ${plural(now.calls.length, 'call')}` : '';
  const label = now ? (desc ? `Running: ${desc}` : toolActivity(now.name, (now.input ?? {}) as Record<string, unknown>) + made)
    : workSummary(items);
  // A thought still being written, and nothing else yet: the status line under the turn already says Claude is at
  // it, so a "Thinking" line above it would say it twice. It joins the summary ("Thought, ran…") once it's done.
  if (thinking && items.length === 1) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(workLine, computer && 'h-9 gap-2 pr-1')}>
        {/* No live dot in the margin: the line shimmers while it runs, and the status line under it is the live mark. */}
        {computer && <ComputerUseIcon active={!!now && !computerWaiting} />}
        {!computer && <ToolLogos tools={now ? [now] : tools} className="mr-1" />}
        <span className={cn('truncate', computer ? 'shrink-0 font-medium text-foreground/80' : running && 'shimmer-text')}>{computer ? 'Computer Use' : label}</span>
        {computer && <span className="truncate text-faint">{computerWaiting ? 'Waiting for you' : now ? computerUseAction(now.name, now.input) : plural(tools.length, 'step')}</span>}
        {computer && now && <span className="shrink-0 text-faint tabular-nums">{fmt(Math.max(0, Math.floor((Date.now() - now.at) / 1000)))}</span>}
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
        <Chevron group="s" />
      </CollapsibleTrigger>
      {/* The command running now, when it prints as it goes: its last lines, without opening anything. */}
      {!open && now?.status === 'running' && <OutputTail text={now.output} />}
      {/* Computer Use stopped by something you can fix: said here too, so it is in view without opening the steps. */}
      {!open && failed > 0 && <ComputerUseFixes steps={tools} className="mt-1 mb-1" />}
      <CollapsibleContent className="mt-1 mb-1 ml-[2px] flex flex-col border-l border-hairline pl-[18px]">
        {/* One level only: thoughts show their text right here, steps are rows you can open. */}
        {items.map((t) => t.t === 'thinking'
          ? <ThoughtText key={t.key} item={t} />
          : <StepRow key={t.key} item={t} rev={t.rev} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThoughtText({ item }: { item: ThinkingItem }) {
  if (!item.text.trim()) return null;
  return (
    <div className="prose-reply prose-compact py-1 text-muted-foreground">
      <MessageResponse>{item.streaming ? thinkingTail(item.text) : item.text}</MessageResponse>
    </div>
  );
}

// ---------- the turn, like the terminal ----------
// While Claude works, everything in the order it happened: its messages as ordinary chat text, the tool work
// between them as one quiet line each ("Ran 2 commands, read a file"), thinking only as the live status line at the
// bottom. When the turn ends, everything before the final answer folds into "Worked for 28s" (see WorkedFold).
type Work = ToolItem | ThinkingItem;
type Seg = { kind: 'said'; item: AssistantItem } | { kind: 'work'; key: string; items: Work[] } | { kind: 'steer'; item: UserItem } | { kind: 'other'; item: Item };
function segments(all: Item[]): Seg[] {
  const out: Seg[] = [];
  for (const it of all) {
    const last = out[out.length - 1];
    if (isShow(it)) { out.push({ kind: 'other', item: it }); continue; }
    if (isGuide(it)) continue;
    if (it.t === 'tool' || (it.t === 'thinking' && (it.streaming || it.text.trim()))) {
      if (last?.kind === 'work') last.items.push(it); else out.push({ kind: 'work', key: `w-${it.key}`, items: [it] });
    } else if (it.t === 'thinking' || it.t === 'raw') continue; // empty thinking / hook output: nothing to show
    else if (it.t === 'assistant') { if (isSaid(it)) out.push({ kind: 'said', item: it }); }
    else if (it.t === 'user') out.push({ kind: 'steer', item: it }); // the turn's own message is drawn above it, not in it
    else out.push({ kind: 'other', item: it });
  }
  return out;
}

/** 42s, 3m 07s → "3m 7s", 1h 4m. */
function fmt(n: number) {
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`;
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
}

/** Re-render once a second, on the second boundary of `startedAt`, so the clock never skips or stalls. */
function useTicker(on: boolean, startedAt: number) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    let id: ReturnType<typeof setTimeout>;
    const arm = () => { id = setTimeout(tick, 1000 - ((Date.now() - startedAt) % 1000) + 8); };
    const tick = () => { set((n) => n + 1); arm(); };
    arm();
    return () => clearTimeout(id);
  }, [on, startedAt]);
}

/** Hold each value on screen for at least `ms`, then jump to the latest, so fast tool calls don't flicker. */
function useDwell<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const since = useRef(Date.now());
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const apply = () => { since.current = Date.now(); setShown(value); };
    const wait = ms - (Date.now() - since.current);
    if (wait <= 0) { apply(); return; }
    const id = setTimeout(apply, wait);
    return () => clearTimeout(id);
  }, [value, shown, ms]);
  return shown;
}

// The word for "working", picked per turn like the terminal's spinner ("Crunching… 13s", then "Sautéed for 45s").
// Canopy's own list, all trees and forest, each with the forest icon that acts it out (grouped by icon). One per
// turn, so it never flickers mid-turn: the same turn always gets the same word (seeded by the turn), live and in history.
const VERBS: [string, string, ForestKind][] = [
  ['Sprouting', 'Sprouted', 'sprout'], ['Germinating', 'Germinated', 'sprout'], ['Unfurling', 'Unfurled', 'sprout'],
  ['Budding', 'Budded', 'sprout'], ['Sowing', 'Sowed', 'sprout'], ['Leafing out', 'Leafed out', 'sprout'],
  ['Greening', 'Greened', 'sprout'], ['Seeding', 'Seeded', 'sprout'], ['Reseeding', 'Reseeded', 'sprout'],
  ['Repotting', 'Repotted', 'sprout'], ['Seeding the meadow', 'Seeded the meadow', 'sprout'],
  ['Scattering seeds', 'Scattered seeds', 'sprout'], ['Thawing', 'Thawed', 'sprout'],
  ['Budding out', 'Budded out', 'sprout'], ['Fern-gazing', 'Fern-gazed', 'sprout'],
  ['Unrolling fiddleheads', 'Unrolled fiddleheads', 'sprout'],
  ['Leafing through', 'Leafed through', 'leaf'], ['Rustling', 'Rustled', 'leaf'], ['Swaying', 'Swayed', 'leaf'],
  ['Raking leaves', 'Raked leaves', 'leaf'], ['Basking in dappled light', 'Basked in dappled light', 'leaf'],
  ['Dappling', 'Dappled', 'leaf'], ['Whispering', 'Whispered', 'leaf'], ['Murmuring', 'Murmured', 'leaf'],
  ['Fluttering', 'Fluttered', 'leaf'], ['Leaf-peeping', 'Leaf-peeped', 'leaf'],
  ['Turning gold', 'Turned gold', 'leaf'], ['Changing color', 'Changed color', 'leaf'],
  ['Branching out', 'Branched out', 'tree'], ['Taking root', 'Took root', 'tree'], ['Ripening', 'Ripened', 'tree'],
  ['Rooting around', 'Rooted around', 'tree'], ['Growing rings', 'Grew rings', 'tree'],
  ['Tapping the maples', 'Tapped the maples', 'tree'], ['Tapping sap', 'Tapped sap', 'tree'],
  ['Boiling sap', 'Boiled sap', 'tree'], ['Sugaring', 'Sugared', 'tree'], ['Fruiting', 'Fruited', 'tree'],
  ['Creaking', 'Creaked', 'tree'], ['Shedding bark', 'Shed bark', 'tree'],
  ['Wintering over', 'Wintered over', 'tree'], ['Spreading roots', 'Spread roots', 'tree'],
  ['Deepening roots', 'Deepened roots', 'tree'], ['Reaching skyward', 'Reached skyward', 'tree'],
  ['Thickening the trunk', 'Thickened the trunk', 'tree'], ['Adding a ring', 'Added a ring', 'tree'],
  ['Knotting', 'Knotted', 'tree'], ['Gnarling', 'Gnarled', 'tree'],
  ['Networking the roots', 'Networked the roots', 'tree'], ['Trading nutrients', 'Traded nutrients', 'tree'],
  ['Canopying', 'Canopied', 'tree'], ['Shading', 'Shaded', 'tree'], ['Sheltering', 'Sheltered', 'tree'],
  ['Counting rings', 'Counted rings', 'tree'], ['Reading the bark', 'Read the bark', 'tree'],
  ['Tree-hugging', 'Tree-hugged', 'tree'],
  ['Foraging', 'Foraged', 'forest'], ['Wandering the woods', 'Wandered the woods', 'forest'],
  ['Gathering moss', 'Gathered moss', 'forest'], ['Thinning the stand', 'Thinned the stand', 'forest'],
  ['Roaming the grove', 'Roamed the grove', 'forest'],
  ['Exploring the understory', 'Explored the understory', 'forest'], ['Picking berries', 'Picked berries', 'forest'],
  ['Hunting mushrooms', 'Hunted mushrooms', 'forest'], ['Spreading spores', 'Spread spores', 'forest'],
  ['Overgrowing', 'Overgrew', 'forest'], ['Rewilding', 'Rewilded', 'forest'],
  ['Reforesting', 'Reforested', 'forest'], ['Afforesting', 'Afforested', 'forest'],
  ['Underplanting', 'Underplanted', 'forest'], ['Mossing over', 'Mossed over', 'forest'],
  ['Forest bathing', 'Forest bathed', 'forest'], ['Wandering the thicket', 'Wandered the thicket', 'forest'],
  ['Blossoming', 'Blossomed', 'flower'], ['Grafting', 'Grafted', 'flower'], ['Pollinating', 'Pollinated', 'flower'],
  ['Flowering', 'Flowered', 'flower'], ['Espaliering', 'Espaliered', 'flower'], ['Twining', 'Twined', 'flower'],
  ['Climbing the trellis', 'Climbed the trellis', 'flower'], ['Vining', 'Vined', 'flower'],
  ['Creeping', 'Crept', 'flower'],
  ['Composting', 'Composted', 'shovel'], ['Pruning', 'Pruned', 'shovel'], ['Mulching', 'Mulched', 'shovel'],
  ['Planting', 'Planted', 'shovel'], ['Tending', 'Tended', 'shovel'], ['Transplanting', 'Transplanted', 'shovel'],
  ['Watering', 'Watered', 'shovel'], ['Weeding', 'Weeded', 'shovel'], ['Hedging', 'Hedged', 'shovel'],
  ['Coppicing', 'Coppiced', 'shovel'], ['Pollarding', 'Pollarded', 'shovel'],
  ['Feeding the soil', 'Fed the soil', 'shovel'], ['Tilling', 'Tilled', 'shovel'], ['Aerating', 'Aerated', 'shovel'],
  ['Turning the compost', 'Turned the compost', 'shovel'],
  ['Whittling', 'Whittled', 'axe'], ['Building a treehouse', 'Built a treehouse', 'axe'],
  ['Chopping kindling', 'Chopped kindling', 'axe'], ['Stacking firewood', 'Stacked firewood', 'axe'],
  ['Splitting logs', 'Split logs', 'axe'], ['Sawing', 'Sawed', 'axe'], ['Carving', 'Carved', 'axe'],
  ['Sanding', 'Sanded', 'axe'], ['Seasoning the timber', 'Seasoned the timber', 'axe'],
  ['Nursing a log', 'Nursed a log', 'axe'], ['Hollowing', 'Hollowed', 'axe'],
  ['Gathering acorns', 'Gathered acorns', 'acorn'], ['Collecting pinecones', 'Collected pinecones', 'acorn'],
  ['Gathering chestnuts', 'Gathered chestnuts', 'acorn'], ['Squirreling away', 'Squirreled away', 'acorn'],
  ['Stashing acorns', 'Stashed acorns', 'acorn'],
  ['Climbing', 'Climbed', 'squirrel'], ['Scaling the trunk', 'Scaled the trunk', 'squirrel'],
  ['Shimmying up', 'Shimmied up', 'squirrel'], ['Burrowing', 'Burrowed', 'squirrel'],
  ['Nesting', 'Nested', 'bird'], ['Perching', 'Perched', 'bird'], ['Birdwatching', 'Birdwatched', 'bird'],
  ['Bushwhacking', 'Bushwhacked', 'trail'], ['Trailblazing', 'Trailblazed', 'trail'],
  ['Clearing a path', 'Cleared a path', 'trail'], ['Blazing a trail', 'Blazed a trail', 'trail'],
  ['Hiking', 'Hiked', 'trail'], ['Rambling', 'Rambled', 'trail'],
  ['Tracking deer trails', 'Tracked deer trails', 'trail'], ['Following the creek', 'Followed the creek', 'trail'],
  ['Crossing the brook', 'Crossed the brook', 'trail'],
  ['Kindling a campfire', 'Kindled a campfire', 'campfire'],
  ['Toasting marshmallows', 'Toasted marshmallows', 'campfire'],
  ['Camping out', 'Camped out', 'camp'], ['Pitching a tent', 'Pitched a tent', 'camp'],
  ['Stargazing through the leaves', 'Stargazed through the leaves', 'camp'],
  ['Photosynthesizing', 'Photosynthesized', 'sun'], ['Soaking up sun', 'Soaked up sun', 'sun'],
  ['Stretching toward the sun', 'Stretched toward the sun', 'sun'],
  ['Drinking the rain', 'Drank the rain', 'rain'], ['Weathering the storm', 'Weathered the storm', 'rain'],
  ['Catching the breeze', 'Caught the breeze', 'wind'], ['Bending in the wind', 'Bent in the wind', 'wind'],
];
function verbFor(turn: Turn) {
  const seed = `${turn.user?.key ?? turn.key}:${turn.startedAt}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return VERBS[Math.abs(h) % VERBS.length];
}

/** The live line while Claude condenses a long chat. It can take a minute and the turn would look stuck, so it says
 *  in plain words what is happening and that the chat carries on. */
export function CompactingLine({ elapsed }: { elapsed: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 enter-fade [animation-duration:160ms]">
      <div className="flex h-6 min-w-0 items-center gap-2 text-ui tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          <Logo className="breathe size-3.5 shrink-0 text-brand" />
          <span className="shimmer-text truncate">{COMPACTING_STATUS}</span>
        </span>
        <span className="shrink-0 text-faint">{fmt(elapsed)}</span>
      </div>
      <p className="pl-5 text-small text-faint">
        This chat got long, so Canopy is condensing the older messages into a short summary Claude can remember. It picks up right where it left off.
      </p>
    </div>
  );
}

/** The live line at the bottom of a working turn: what Claude is doing right now, and for how long. */
function StatusLine({ turn, status }: { turn: Turn; status: string }) {
  const current = lastOf(turn.all, (it): it is ToolItem | ThinkingItem | AssistantItem => it.t === 'tool' || it.t === 'thinking' || (it.t === 'assistant' && !!it.streaming));
  const computer = current?.t === 'tool' && isComputerUse(current.name) && (current.status === 'running' || current.status === 'approval');
  useTicker(!computer, turn.startedAt);
  // The turn's word and its icon, throughout. What a step is doing is said once, on its own line above ("Running: npm
  // test"); saying it here too read as the same line twice.
  const [idle, , kind] = verbFor(turn);
  const latest = status || idle;
  const what = useDwell(latest, 700);
  const elapsed = Math.max(0, Math.floor((Date.now() - turn.startedAt) / 1000));
  // The active Computer Use row already carries its action and clock; a second status repeats it.
  if (computer) return null;
  // Condensing a long chat can take a minute and the turn looks stuck, so it says what is happening and that it is fine.
  if (what === COMPACTING_STATUS) return <CompactingLine elapsed={elapsed} />;
  return (
    <div className="flex h-6 min-w-0 items-center gap-2 text-ui tabular-nums">
      <span key={what} className="flex min-w-0 items-center gap-1.5 enter-fade [animation-duration:160ms]">
        {what === idle && <ForestIcon kind={kind} className="text-muted-foreground" />}
        <span className="shimmer-text truncate">{what}</span>
      </span>
      <span className="shrink-0 text-faint">{fmt(elapsed)}</span>
    </div>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** How long a finished turn took, and when it finished. History doesn't keep the timing: it's worked out from when
 *  you sent the message and when Claude last wrote. */
function turnTiming(turn: Turn) {
  const hist = !!(turn.user ?? turn.all[0])?.hist;
  let ms = turn.end?.ev.durationMs as number | undefined;
  const lastAt = turn.all.length ? Math.max(...turn.all.map((i) => i.at || 0)) : 0;
  if (!ms && hist && turn.user?.at && lastAt > turn.user.at) ms = lastAt - turn.user.at;
  const doneAt = turn.end && !hist ? turn.end.at : lastAt;
  return { secs: ms ? Math.max(1, Math.round(ms / 1000)) : 0, doneAt };
}

/** The quiet line that closes a finished turn, like the terminal's "Baked for 6s · done 10:59 PM", with each part capitalized
 *  and the model that ran it last ("Baked for 6s · Done 10:59 PM · Opus 5.5").
 *  Under a "Worked for…" fold the duration is already said, so it's just the time and the model.
 *  The model is the turn's own (its end says it; in a saved Claude chat, its last reply does): after a switch, each
 *  turn names the one it ran on. A turn nobody knows the model of names none. */
function DoneLine({ turn, timed = true }: { turn: Turn; timed?: boolean }) {
  const { secs, doneAt } = turnTiming(turn);
  const ran = useModelName(turn.end?.ev.model ?? lastOf(turn.all, isSaid)?.model);
  const [, past, kind] = verbFor(turn);
  const parts = [
    timed && secs ? `${past} for ${fmt(secs)}` : null,
    turn.end?.ev.interrupted ? 'Stopped' : null,
    doneAt ? `Done ${time(doneAt)}` : null,
    ran || null,
  ].filter(Boolean);
  if (!parts.length) return null;
  // The turn's icon leads its word, held still now the work is over.
  const icon = timed && !!secs;
  return (
    <div className={cn('text-small text-faint tabular-nums', icon && 'flex items-center gap-1.5')}>
      {icon && <ForestIcon kind={kind} still className="size-3" />}
      <span>{parts.join(' · ')}</span>
    </div>
  );
}

// ---------- edited files ----------
function ChangeChips({ edits, className }: { edits: ToolItem[]; className?: string }) {
  const byFile = new Map<string, { add: number; del: number }>();
  for (const e of edits) {
    const st = editStats(e.name, e.input);
    if (!st) continue;
    const cur = byFile.get(st.file) ?? { add: 0, del: 0 };
    byFile.set(st.file, { add: cur.add + st.add, del: cur.del + st.del });
  }
  if (!byFile.size) return null;
  const files = [...byFile];
  const add = files.reduce((n, [, x]) => n + x.add, 0);
  const del = files.reduce((n, [, x]) => n + x.del, 0);
  const rel = (f: string) => { const parts = f.split('/'); return { dir: parts.length > 3 ? parts.slice(-3, -1).join('/') + '/' : '', name: parts.at(-1) }; };
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-card', className)}>
      <div className="flex h-14 items-center gap-3 px-4">
        <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-ui">
          <span className="font-medium">Edited {files.length === 1 ? rel(files[0][0]).name : `${files.length} files`}</span>
          <span className="ml-2 text-small tabular-nums">
            <span className="text-good">+{add}</span>
            {del > 0 && <span className="ml-1 text-destructive">−{del}</span>}
          </span>
        </div>
        <button type="button" onClick={() => ui.openTab('changes', { focusFile: files[0][0] })}
          className="flex h-7 shrink-0 items-center rounded-md border px-2.5 text-small font-medium hover:bg-accent">View changes</button>
      </div>
      {files.length > 1 && (
        <div className="divide-y divide-hairline border-t border-hairline">
          {files.map(([f, x]) => (
            <button type="button" key={f} onClick={() => ui.openTab('changes', { focusFile: f })}
              className="flex h-8 w-full items-center gap-2 px-4 text-left text-ui hover:bg-accent">
              <span className="min-w-0 flex-1 truncate"><span className="text-faint">{rel(f).dir}</span>{rel(f).name}</span>
              <span className="w-10 text-right text-small tabular-nums text-good">+{x.add}</span>
              <span className="w-10 text-right text-small tabular-nums text-destructive">{x.del > 0 ? `−${x.del}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- copy ----------
function CopyButton({ text, label, reveal }: { text: string; label: string; reveal: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard.writeText(text);
    feature('message_copied');
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1200);
  };
  return (
    <button type="button" aria-label={label} onClick={copy}
      className={cn('flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground opacity-0 transition-opacity duration-120 ease-out focus-visible:opacity-100', reveal, done && 'opacity-100')}>
      <span key={String(done)} className="swap-in">{done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}</span>
    </button>
  );
}

// Replies (and Claude's messages while it works) type out smoothly instead of arriving in pasted chunks,
// and ease in once as they appear.
function StreamingReply({ item, live }: { item: AssistantItem; live?: boolean }) {
  const { text, typing } = useSmoothText(item.text, !!item.streamed);
  const [entering] = useState(!!live);
  return (
    <div className={cn('prose-reply min-h-6', entering && 'reply-in')}>
      <MessageResponse isAnimating={item.streaming || typing}>{text}</MessageResponse>
    </div>
  );
}

/** Resend the last prompt the way the composer would: behind whatever is running or already queued. */
const tryAgain = (store: Store) => {
  const p = store.meta.lastPrompt;
  if (!p) return;
  const images = p.images as ImageAttachment[];
  if (store.meta.busy || store.meta.queue.length) store.enqueue(p.text, images);
  else store.dispatch(p.text, images);
};

/** A notice's dot says what kind of news it is. */
const NOTICE_DOT = { error: 'bg-destructive', warn: 'bg-warn', good: 'bg-good', info: 'bg-muted-foreground/40' } as const;

/** Wherever a notice says "Canopy", show the real wordmark (the mark + the name, as in the sidebar). */
function withWordmark(text: string): React.ReactNode {
  const parts = text.split(/\bCanopy\b/);
  if (parts.length === 1) return text;
  return parts.flatMap((p, i) => (i === 0 ? [p] : [
    <span key={i} className="mx-0.5 inline-flex translate-y-[1px] items-center gap-1 align-baseline">
      <Logo className="size-3 text-brand" /><Wordmark className="text-muted-foreground" />
    </span>, p]));
}

const AnswerItem = memo(function AnswerItem({ item, live, retry }: { item: Item; rev: number; live?: boolean; retry?: boolean }) {
  const store = useContext(StoreContext); // this chat's store (a Multi mode pane has its own)
  switch (item.t) {
    case 'assistant': return <StreamingReply item={item} live={live} />;
    case 'permission': return isPlan(item) ? <PlanCard item={item} /> : null;
    case 'notice':
      // A notice reads like the work lines: one short, quiet line. A dot marks its tone, and if there's something
      // to do about it, one small button does it.
      return (
        <div className="flex h-6 min-w-0 items-center gap-2 text-small text-faint" title={item.detail}>
          <span className={cn('size-1.5 shrink-0 rounded-full', NOTICE_DOT[item.tone ?? (item.level === 'warn' ? 'warn' : 'info')])} />
          <span className="truncate">{item.brand ? withWordmark(item.text) : item.text}</span>
          {item.action && 'signIn' in item.action && <SignInAction engine={item.action.signIn} notice={item} />}
          {item.action && 'prompt' in item.action && (
            <button type="button" onClick={() => { const a = item.action; if (!a || !('prompt' in a)) return; if (store.meta.busy) store.enqueue(a.prompt, []); else store.dispatch(a.prompt, []); }}
              className="press ml-1 flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-card px-2.5 text-small text-foreground/90 transition-colors duration-150 hover:border-foreground/25 hover:bg-accent hover:text-foreground">
              <RotateCcwIcon className="size-3 text-muted-foreground" />{item.action.label}
            </button>
          )}
        </div>
      );
    case 'cmd':
      return (
        <div className="rounded-lg border bg-card px-4 py-3">
          <div className="mb-2 flex h-4 items-center gap-1.5 text-small text-muted-foreground"><CornerDownRightIcon className="size-3.5" />Command output</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-code">{item.text.trim() || 'No output'}</pre>
        </div>
      );
    case 'note':
      return (
        <Collapsible className="rounded-lg border bg-card">
          <CollapsibleTrigger className="group/n flex h-9 w-full items-center gap-1.5 px-4 text-left text-small text-muted-foreground hover:text-foreground">
            Earlier messages were summarized to free up space
            <Chevron group="n" />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-hairline px-4 py-3 prose-reply prose-compact">
            <MessageResponse>{clip(item.text, 30000)}</MessageResponse>
          </CollapsibleContent>
        </Collapsible>
      );
    case 'error':
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <div className="flex items-center gap-2 text-ui font-medium"><AlertTriangleIcon className="size-4 shrink-0 text-destructive" />This turn didn’t finish</div>
          <p data-selectable className="mt-1 text-ui text-muted-foreground">{item.message}</p>
          <div className="mt-2 flex h-6 items-center gap-3 text-small text-muted-foreground">
            <span>Your chat is saved.</span>
            {retry && <Button size="xs" variant="outline" onClick={() => tryAgain(store)}>Try again</Button>}
          </div>
          {item.stderr && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-code text-muted-foreground">{item.stderr}</pre>}
        </div>
      );
    case 'user': return null;
    default: return <StepRow item={item} rev={item.rev} />;
  }
}, (a, b) => a.item === b.item && a.rev === b.rev && a.retry === b.retry); // `live` is only read as it mounts

// ---------- your message ----------
const CLAMP = 288; // twelve lines of body text (max-h-[288px] below)
// Opening and closing the editor: the bubble eases from one size to the other (the page's own enter curve).
const MORPH_MS = 260;
const MORPH_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Your message. Hover shows the time, Edit and Copy. Edit turns the bubble into a box: change the words, send, and
 *  everything after the message goes while Claude answers the new one (see Store.editFrom). `editable` is false
 *  where that can't work (lib/edit.ts says where).
 *
 *  Going between the two, the bubble doesn't jump: it is measured just before the switch and eased from that size to
 *  its new one, so it reads as the same bubble opening up. Its contents are held at their final width meanwhile
 *  (the growing bubble uncovers them) so the words don't rewrap on every frame. */
export function UserBubble({ user, className, editable = false }: { user: UserItem; className?: string; editable?: boolean }) {
  const store = useContext(StoreContext);
  const [draft, setDraft] = useState<string | null>(null); // null: not editing
  const editing = draft !== null && editable;
  const bubble = useRef<HTMLDivElement>(null);
  const before = useRef<DOMRect | null>(null);
  const switchTo = (next: string | null, refocus = false) => {
    before.current = bubble.current?.getBoundingClientRect() ?? null;
    setDraft(next);
    // Cancelled: the cursor goes back to the message box rather than nowhere.
    if (refocus) requestAnimationFrame(() => window.dispatchEvent(new Event('canopy:focus-composer')));
  };
  // An edit that didn't go through comes back open, with what you had written.
  useEffect(() => {
    if (!editable) return;
    const lost = store.takeLostEdit(user.uuid, user);
    if (lost !== null) switchTo(lost);
  }, [editable, store, user.uuid]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const from = before.current, el = bubble.current;
    before.current = null;
    if (!from || !el) return;
    const to = el.getBoundingClientRect();
    const settle = () => { if (editing) el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); };
    if (reducedMotion() || (Math.abs(from.width - to.width) < 1 && Math.abs(from.height - to.height) < 1)) { settle(); return; }
    const inner = el.querySelector<HTMLElement>('[data-morph]');
    if (inner) { inner.style.width = `${inner.getBoundingClientRect().width}px`; inner.style.flexShrink = '0'; }
    el.style.overflow = 'clip';
    const a = el.animate([
      { width: `${from.width}px`, height: `${from.height}px` },
      { width: `${to.width}px`, height: `${to.height}px` },
    ], { duration: MORPH_MS, easing: MORPH_EASE });
    const done = () => { el.style.overflow = ''; if (inner) { inner.style.width = ''; inner.style.flexShrink = ''; } };
    a.onfinish = () => { done(); settle(); };
    a.oncancel = done;
    return () => a.cancel();
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (editing) return <BubbleEditor user={user} initial={draft} className={className} bubble={bubble} onClose={() => switchTo(null, true)} />;
  return <BubbleView user={user} className={className} bubble={bubble} onEdit={editable ? () => switchTo(user.text) : undefined} />;
}

/** A "Request Updates" question (the agents drawer's button) shows as Canopy asking, not as a message you typed:
 *  "Canopy requested an update", in your message's place and shape. Open it to read the question that was sent.
 *
 *  Opening and closing ease the bubble's width and height together (as editing your message does), from the size it
 *  has on screen, so a click mid-way turns it around without a jump. The question holds its final width meanwhile so
 *  its lines don't rewrap; closing, it leaves the flow (the bubble's new size is the closed one) and fades as the
 *  bubble folds over it. *  `label` and `detail` stand in for the line and what it opens to, for another of Canopy's own messages (a run report). */
export function UpdateRequestBubble({ user, className, label, detail }: { user: UserItem; className?: string; label?: React.ReactNode; detail?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState<{ w: number; top: number } | null>(null); // the question, folding away
  const box = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const before = useRef<DOMRect | null>(null);
  const toggle = () => {
    before.current = box.current?.getBoundingClientRect() ?? null;
    if (open) setLeaving(body.current ? { w: body.current.getBoundingClientRect().width, top: head.current?.offsetHeight ?? 0 } : null);
    else setLeaving(null);
    setOpen(!open);
  };
  useLayoutEffect(() => {
    const from = before.current, el = box.current, t = body.current;
    before.current = null;
    if (!from || !el) return;
    if (reducedMotion()) { setLeaving(null); return; }
    const to = el.getBoundingClientRect();
    if (open && t) { t.style.width = `${t.getBoundingClientRect().width}px`; t.style.flexShrink = '0'; }
    const a = el.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }],
      { duration: MORPH_MS, easing: MORPH_EASE });
    const fade = t?.animate([{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }],
      { duration: open ? MORPH_MS : MORPH_MS * 0.6, easing: 'ease-out', fill: 'forwards' });
    const release = () => { if (t) { t.style.width = ''; t.style.flexShrink = ''; } };
    a.onfinish = () => { release(); if (!open) setLeaving(null); };
    a.oncancel = release;
    return () => { a.cancel(); fade?.cancel(); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={cn('group/u relative ml-auto flex max-w-[85%] flex-col items-end', className)}>
      <div ref={box} className="user-bubble relative max-w-full overflow-hidden rounded-2xl bg-secondary text-body">
        <button ref={head} type="button" aria-expanded={open} onClick={toggle}
          className="flex w-full items-center px-4 py-2 text-left text-muted-foreground hover:text-foreground">
          {/* The mark and the word sit together as the sidebar's lockup does: the mark the size of the text, 6px apart,
              nudged up a pixel to meet the word's cap height. */}
          {label ?? (<>
            <span className="flex shrink-0 items-center gap-1.5">
              <Logo className="size-4 shrink-0 -translate-y-px text-brand" />
              <Wordmark className="text-foreground" twoStorey />
            </span>
            <span className="mr-2 ml-[0.3em] min-w-0">requested an update</span>
          </>)}
          <ChevronRightIcon className={cn('ml-auto size-3.5 shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />
        </button>
        {(open || leaving) && (
          <div className={cn(!open && leaving && 'absolute left-0')} style={!open && leaving ? { top: leaving.top, width: leaving.w } : undefined}>
            <div ref={body} className="whitespace-pre-wrap px-4 pb-3 text-small text-muted-foreground">{detail ?? user.text.trim()}</div>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute top-full right-0 flex h-6 w-max items-center gap-1 whitespace-nowrap text-micro tabular-nums text-faint opacity-0 transition-opacity duration-120 ease-out group-hover/u:opacity-100">
        {user.steered && <span>Steered</span>}
        {!user.hist && <span>{new Date(user.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
      </div>
    </div>
  );
}

/** The bubble as a text box, the same shape and place. Enter sends, Shift+Enter is a new line, Esc cancels: the
 *  message box's own keys. */
function BubbleEditor({ user, initial, className, bubble, onClose }: { user: UserItem; initial: string; className?: string; bubble: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const store = useStore();
  const { meta } = store;
  const [text, setText] = useState(initial);
  const [files, setFiles] = useState<string[]>([]); // what Claude changed since this message
  const [undo, setUndo] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus({ preventScroll: true }); // the bubble scrolls itself into view once it has opened (UserBubble)
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // Looked up as the editor opens, and again every few seconds while Claude is still changing things.
  useEffect(() => {
    if (!user.uuid) return;
    let alive = true;
    const look = () => { store.editPreview(user.uuid!).then((p) => { if (alive) setFiles(p?.files ?? []); }); };
    look();
    const t = meta.busy ? setInterval(look, 4000) : undefined;
    return () => { alive = false; clearInterval(t); };
  }, [store, user.uuid, meta.busy]);
  // Editing cuts the chat back, which restarts Claude Code, and a restart ends its background agents, workflows and
  // commands. So while any are running, the edited text goes in as a new message instead (as the message box sends
  // it: queued behind a reply in progress), and nothing is cut, stopped or undone.
  const asNew = backgroundCount(meta.tasks, meta.busy) > 0;
  const ready = asNew ? !!text.trim() : !!text.trim() || user.images > 0;
  const send = () => {
    if (!ready || !user.uuid) return;
    if (asNew) {
      if (meta.busy || meta.queue.length) store.enqueue(text, []);
      else store.dispatch(text, []);
      onClose();
      return;
    }
    void store.editFrom(user.uuid, text, { restoreFiles: undo && files.length > 0 }).then((r) => {
      if (!r.ok) toast.error('Couldn’t edit that message', { description: r.message });
    });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // an input method is still composing
    // preventDefault also keeps the window's own Esc (stop Claude, close the side panel) out of it.
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  return (
    <div data-editing className={cn('group/u relative ml-auto flex w-full max-w-[85%] flex-col items-end gap-1', className)}>
      {user.thumbs?.length ? <MessageImages images={user.thumbs} className="mb-1" /> : null}
      <div ref={bubble} className="user-bubble flex w-full rounded-2xl bg-secondary px-4 py-2 text-body ring-1 ring-foreground/10">
        <div data-morph className="min-w-0 flex-1">
          <textarea ref={ta} value={text} rows={1} aria-label="Edit message" onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
            className="field-sizing-content block max-h-[45vh] min-h-6 w-full resize-none overflow-y-auto bg-transparent outline-none" />
          <div className="edit-actions mt-1.5 flex h-6 items-center justify-end gap-1.5">
            <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={onClose}>Cancel</Button>
            <Button size="xs" disabled={!ready} onClick={send}>{asNew ? 'Send as New Message' : 'Send'}</Button>
          </div>
        </div>
      </div>
      <Reveal show={asNew} duration={200}>
        <div className="pr-1 text-small text-muted-foreground">Background tasks are running, so this keeps them going and adds your new message.</div>
      </Reveal>
      <Reveal show={!asNew && files.length > 0} duration={200} className="max-w-full">
        <label className="flex max-w-full cursor-default items-center gap-1.5 pr-1 text-small text-muted-foreground" title={files.map((f) => f.split('/').pop()).join('\n')}>
          <input type="checkbox" checked={undo} onChange={(e) => setUndo(e.target.checked)} className="size-3.5 shrink-0 accent-foreground" />
          <span className="truncate">Also undo Claude’s changes to {filesLabel(files)} since this message</span>
        </label>
      </Reveal>
    </div>
  );
}

/** A long paste is clamped to twelve lines so it doesn't push the reply screens away. Copy still copies all of it. */
function BubbleView({ user, className, bubble, onEdit }: { user: UserItem; className?: string; bubble: React.RefObject<HTMLDivElement | null>; onEdit?: () => void }) {
  const store = useContext(StoreContext);
  // Files sent with it (a paragraph of @mentions, lib/file-mentions) show as cards above it, not as paths.
  const { text: words, files } = splitFiles(user.text);
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    // Too short to reach the clamp at any window width: nothing to measure or watch.
    if (!el || (user.text.length < 300 && user.text.split('\n').length < 14)) return;
    // Two lines of slack, so "Show more" always has something worth showing.
    const measure = () => setLong(el.scrollHeight > CLAMP + 48);
    measure();
    const ro = new ResizeObserver(measure); // lines rewrap with the window
    ro.observe(el);
    return () => ro.disconnect();
  }, [user.text]);
  // Shrink-wrap: a wrapped message keeps the full width it was allowed, leaving a gap on the right. Size the bubble
  // to its longest line instead (CSS can't do this on its own). Re-fit when the window changes width.
  useLayoutEffect(() => {
    const el = body.current, b = bubble.current;
    if (!el || !b) return;
    const fit = () => {
      b.style.width = '';
      const r = document.createRange();
      r.selectNodeContents(el);
      const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0);
      if (rects.length < 2) return; // one line: it already fits
      const left = el.getBoundingClientRect().left;
      const longest = Math.max(...rects.map((x) => x.right)) - left;
      const pad = b.offsetWidth - el.clientWidth;
      // Never wider than it was unfitted: the space a line breaks at counts toward that line's width, which pushed
      // full-width messages a few pixels past their column (and made the edit box, which fits it, look shifted).
      b.style.width = `${Math.min(b.offsetWidth, Math.ceil(longest + pad + 1))}px`;
    };
    fit();
    // Re-fit only when the column's width changes (not its height, which our own fit changes), and on the next
    // frame: fitting inside the observer callback is what made the browser report a resize loop.
    const host = b.closest('[data-turns]') ?? b.parentElement?.parentElement;
    let lastW = host?.clientWidth ?? 0, raf = 0;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w === lastW) return;
      lastW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    if (host) ro.observe(host);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [user.text, bubble]);
  const toggle = () => {
    flushSync(() => setExpanded(!expanded));
    // Folded back up, a tall message would leave the view somewhere far below it.
    if (expanded) body.current?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <div className={cn('group/u relative ml-auto flex max-w-[85%] flex-col items-end gap-1', className)}>
      {user.thumbs?.length ? <MessageImages images={user.thumbs} className="mb-1" /> : null}
      {/* A message another of your chats sent here sits where yours do, since Claude answers it the same way: say whose it is. */}
      {user.peer != null && <div className="mr-1 max-w-full truncate text-micro text-faint">{user.peer ? `From another chat · ${user.peer}` : 'From another chat'}</div>}
      {files.length > 0 && <div className="mb-1 flex flex-wrap justify-end gap-2">{files.map((f) => <FileCard key={f} path={f} cwd={store.cwd} />)}</div>}
      {(words.trim() || (!user.thumbs?.length && !files.length)) && <div ref={bubble} className="user-bubble break-words rounded-2xl bg-secondary px-4 py-2 text-body">
        <div data-morph>
          <div ref={body} className={cn('whitespace-pre-wrap', long && !expanded && 'max-h-[288px] overflow-hidden [mask-image:linear-gradient(#000_calc(100%_-_48px),transparent)]')}>{words.trim()}</div>
          {user.images > 0 && !user.thumbs?.length && <div className="mt-1 text-small text-muted-foreground">{user.images} image{user.images === 1 ? '' : 's'}</div>}
        </div>
      </div>}
      {/* Hover row (time, copy) floats just under the bubble: it takes no space, so your message sits as tight
          to the next one as Claude's do. "Show more" for a long message is the only thing that adds a line. */}
      {/* Under a short bubble the row is as wide as its contents, not the bubble: "4:49 PM" never wraps under a "yeah". */}
      <div className={cn('flex items-center whitespace-nowrap', long ? 'h-6 w-full' : 'pointer-events-none absolute top-full right-0 h-6 w-max [&>*]:pointer-events-auto')}>
        {long && (
          <button type="button" aria-expanded={expanded} onClick={toggle} className="ml-4 rounded-sm text-small text-muted-foreground hover:text-foreground">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <div data-hover-row className="-mr-1 ml-auto flex items-center gap-1 text-micro tabular-nums text-faint opacity-0 transition-opacity duration-120 ease-out group-hover/u:opacity-100 group-focus-within/u:opacity-100">
          {user.steered && <span>Steered</span>}
          {!user.hist && <span>{new Date(user.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          {onEdit && (
            <button type="button" aria-label="Edit message" onClick={onEdit}
              className="flex size-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity duration-120 ease-out hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/u:opacity-100">
              <PencilIcon className="size-3.5" />
            </button>
          )}
          <CopyButton text={user.text} label="Copy message" reveal="group-hover/u:opacity-100" />
        </div>
      </div>
    </div>
  );
}

/** What a command you ran from a reply printed, as it went back to Claude (lib/run-report.ts): one folded line,
 *  "You ran claude mcp login posthog", that opens to the output. */
function RunReportBubble({ user, report, className }: { user: UserItem; report: RunReport; className?: string }) {
  const first = report.code.split('\n')[0] + (report.code.includes('\n') ? ' …' : '');
  const how = report.exitCode === 0 ? '' : report.exitCode === null ? 'ended' : `exit ${report.exitCode}`;
  return (
    <UpdateRequestBubble user={user} className={className}
      label={<>
        <SquareTerminalIcon className="size-4 shrink-0 text-faint" />
        <span className="ml-1.5 shrink-0">You ran</span>
        <code className="mr-2 ml-[0.4em] min-w-0 truncate font-mono text-[0.9em] text-foreground">{first}</code>
        {how && <span className="mr-2 shrink-0 tabular-nums">{how}</span>}
      </>}
      detail={report.output
        ? <pre className="m-0 max-h-72 overflow-auto bg-transparent p-0 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap">{report.output}</pre>
        : 'It printed nothing.'} />
  );
}

/** What Claude reported with the task tool this turn (src/core/task-tool.mjs): the latest title and status, when
 *  it started, and when it said it was done. Null when it reported nothing. */
function taskOf(turn: Turn, earlier = '') {
  const calls = turn.all.filter((it): it is ToolItem => it.t === 'tool' && it.name === TASK_TOOL);
  if (!calls.length) return null;
  const word = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  // A later turn of the same work (after you picked a direction) often gives only a status: it keeps the title.
  let title = earlier, status = '', doneAt = 0;
  for (const c of calls) {
    title = word(c.input.title, 60) || title;
    status = word(c.input.status, 120) || status;
    if (c.input.done === true) doneAt = c.at || doneAt;
  }
  if (!title && !status) return null;
  return { title, status, startedAt: calls[0].at || turn.startedAt, doneAt };
}

/** The task card: what the work is and where it stands, "Creating Website · Writing the page  1m 40s", with the
 *  turn's work housed under it (the step lines, the live status) while it runs, and its "Worked for…" fold once it
 *  is over. The status changes in place as Claude moves on, and a short line slides along the bottom while it works.
 *  The answer stays below the card. */
type Task = NonNullable<ReturnType<typeof taskOf>>;
function TaskCard({ task, turn, live, children }: { task: Task; turn: Turn; live: boolean; children?: React.ReactNode }) {
  const working = live && !task.doneAt;
  useTicker(working, task.startedAt);
  const status = useDwell(task.status, 700);
  const [open, setOpen] = useFold(`task-${turn.key}`, false);
  // While it works the card starts open, showing the work; its title row folds it to that one line.
  const [liveOpen, setLiveOpen] = useFold(`task-live-${turn.key}`, true);
  const secs = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000));
  const outcome = working ? status : turn.end?.ev.interrupted && !task.doneAt ? 'Stopped' : 'Done';
  const { secs: took } = turnTiming(turn);
  const head = (
    <>
      <Logo className="size-4 shrink-0 -translate-y-px text-brand" />
      {task.title && <span className="shrink-0 font-medium text-foreground">{task.title}</span>}
      {task.title && outcome && <span className="shrink-0 text-faint">·</span>}
      {outcome && <span key={outcome} className={cn('min-w-0 truncate enter-fade [animation-duration:160ms]', working ? 'shimmer-text' : 'text-muted-foreground')}>{outcome}</span>}
    </>
  );
  return (
    <InTaskCard.Provider value={true}>
      <div data-task className="relative min-w-0 overflow-hidden rounded-xl border border-hairline text-ui">
        {working && children ? (
          <Collapsible open={liveOpen} onOpenChange={setLiveOpen}>
            <CollapsibleTrigger className="group/w flex h-10 w-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-foreground/20">
              {head}
              <Chevron group="w" />
              {secs > 0 && <span className="ml-auto shrink-0 pl-2 text-small tabular-nums text-faint">{fmt(secs)}</span>}
            </CollapsibleTrigger>
            <CollapsibleContent className="task-fold border-t border-hairline"><div className="flex min-w-0 flex-col gap-3.5 px-3 pt-3 pb-3.5">{children}</div></CollapsibleContent>
          </Collapsible>
        ) : working || !children ? (
          <div className="flex h-10 min-w-0 items-center gap-2 px-3">
            {head}
            {working && secs > 0 && <span className="ml-auto shrink-0 pl-2 text-small tabular-nums text-faint">{fmt(secs)}</span>}
          </div>
        ) : (
          // Over: the card is one line, and opening it shows the work as it happened.
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="group/w flex h-10 w-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-foreground/20">
              {head}
              {took > 0 && <span className="shrink-0 text-faint">·</span>}
              {took > 0 && <span className="shrink-0 text-small tabular-nums text-faint">{fmt(took)}</span>}
              <Chevron group="w" />
            </CollapsibleTrigger>
            <CollapsibleContent className="task-fold border-t border-hairline"><div className="flex min-w-0 flex-col gap-3.5 px-3 pt-3 pb-3.5">{children}</div></CollapsibleContent>
          </Collapsible>
        )}
        {/* While it works, a short line slides along the card's bottom edge (the same bar as Home's running agents),
            so a long quiet stretch still reads as moving. Neutral, never a color. */}
        {working && (
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
            <span className="home-run absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-foreground/35 to-transparent" />
          </span>
        )}
      </div>
    </InTaskCard.Provider>
  );
}

/** A finished turn's work, folded into one line over a hairline: "Worked for 5m 51s". Opening it shows the turn as
 *  it happened (Claude's notes, the step lines), with the final answer still below. Closed by default, history too. */
function WorkedFold({ turn, renderSeg }: { turn: Turn; renderSeg: (sg: Seg) => React.ReactNode }) {
  const [open, setOpen] = useFold(`worked-${turn.key}`, false);
  const { secs } = turnTiming(turn);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group/w flex h-8 w-full min-w-0 items-center gap-1 border-b border-hairline text-left text-small text-faint outline-none hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-foreground/20">
        <ToolLogos tools={turn.work.filter((it): it is ToolItem => it.t === 'tool')} className="mr-1" />
        <span className="truncate tabular-nums">{secs ? `Worked for ${fmt(secs)}` : 'Worked'}</span>
        <Chevron group="w" />
      </CollapsibleTrigger>
      {!open && <ComputerUseFixes steps={turn.work.filter((it): it is ToolItem => it.t === 'tool')} className="pt-2" />}
      <CollapsibleContent className="flex flex-col gap-3.5 pt-3.5">
        {segments(turn.work.filter((it) => !isShow(it) && it.t !== 'user')).map(renderSeg)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TurnView({ turn, live, status, retry, asking, editable, taskTitle = '' }: { turn: Turn; live: boolean; status: string; retry: boolean; asking?: boolean; editable?: boolean; taskTitle?: string }) {
  // A turn that ended on a pick or a question for you was asking, not working: it gets no card (the work starts
  // after you answer, in the next turn, which keeps this title).
  const asked = !live && !(turn.end?.ev.interrupted) && turn.all.some((it) => isShow(it) || (it.t === 'tool' && it.name === 'AskUserQuestion'));
  const reported = taskOf(turn, taskTitle);
  const task = reported && !(asked && !reported.doneAt) ? reported : null;
  const hist = !!(turn.user ?? turn.all[0])?.hist;
  // Entrances are for a turn that is new as it mounts. History, and older turns paged back in, stay still.
  const [fresh] = useState(() => !hist && Date.now() - turn.startedAt < 2000);
  const [sending, setSending] = useState(fresh);
  // While Claude works you watch everything as it happens. Once the turn is done, everything up to the
  // final answer folds into one "Worked for 5m 51s" line, so a finished turn reads as your message → its answer.
  // A plan waiting for your answer holds its turn open, whichever maker made it: a Claude chat's turn is paused on
  // it, an OpenAI chat's has ended. Both read the same: the work as it happened, the card, no footer yet.
  const paused = !!waitingPlan(turn.all);
  const folded = !live && !paused && turn.work.some(isStep);
  // A widget Claude showed stays in view when the work folds: it's something it said, not a step. So does a message
  // you steered into the turn: it's yours, and the answer below is to it too.
  const segs = segments(folded ? [...turn.work.filter((it) => isShow(it) || it.t === 'user'), ...turn.answer] : turn.all);
  // "Copy reply" copies what Claude said after its last step: the answer, not its notes along the way.
  const answerText = turn.answer.filter(isSaid).map((a) => a.text).join('\n\n');
  const lastError = retry ? lastOf(turn.answer, (a): a is ErrorItem => a.t === 'error') : undefined;
  const writing = live && segs.at(-1)?.kind === 'said' && (segs.at(-1) as { item: AssistantItem }).item.streaming;
  // Under a task card while it runs: everything up to the last step. What Claude writes after it (the answer, as far
  // as anyone can tell yet) sits below the card, where it stays when the work folds, so nothing jumps at the end.
  const lastWork = segs.reduce((at, sg, i) => (sg.kind === 'work' ? i : at), -1);
  const housed = segs.slice(0, lastWork + 1);
  const renderSeg = (sg: Seg) => sg.kind === 'said'
    ? <AnswerItem key={sg.item.key} item={sg.item} rev={sg.item.rev} live={live} />
    // Your message's usual distance from Claude's (20px) inside the reply's tighter rhythm (14px).
    : sg.kind === 'steer'
      ? sg.item.peer != null
        ? <ReceivedText key={sg.item.key} user={sg.item} className="my-1.5" />
        : <UserBubble key={sg.item.key} user={sg.item} className={cn('my-1.5', !sg.item.hist && Date.now() - sg.item.at < 2000 && 'send-in')} />
    : sg.kind === 'work'
      ? <WorkRun key={sg.key} id={sg.key} items={sg.items} revs={sg.items.map((t) => t.rev).join('.')} />
      : <AnswerItem key={sg.item.key} item={sg.item} rev={sg.item.rev} live={live} retry={sg.item === lastError} />;
  return (
    // One rhythm, like the terminal's blank line. What you see between two things is the gap plus any line-box air:
    // turns 24px (the done line is a 24px row), your message → Claude 20px, between Claude's blocks 14px. Measured
    // on screen these all land at ~30px of visible space, so nothing reads as pulled closer or pushed further.
    <div className={cn('group/turn flex flex-col gap-5', sending && 'turn-in')}
      onAnimationEnd={sending ? (e) => { if ((e.target as Element).classList.contains('send-in')) setSending(false); } : undefined}>
      {/* A message from another of your chats: a text on Claude's side, from that chat, not a bubble of yours. */}
      {turn.user && (turn.user.peer != null
        ? <ReceivedText user={turn.user} />
        : isUpdateRequest(turn.user.text)
        ? <UpdateRequestBubble user={turn.user} className={cn(sending && 'send-in')} />
        : parseRunReport(turn.user.text)
        ? <RunReportBubble user={turn.user} report={parseRunReport(turn.user.text)!} className={cn(sending && 'send-in')} />
        : <UserBubble user={turn.user} className={cn(sending && 'send-in')} editable={editable} />)}
      {/* Claude asked you something mid-reply: what it wrote so far dims (it's a lead-in, not the answer) and a quiet line
          says it's waiting on you. The answer comes after you pick, in this same reply. */}
      <WholeWidgets.Provider value={!!turn.user && isUpdateRequest(turn.user.text)}>
      <div data-reply className={cn('group/a flex flex-col gap-3.5', live && asking && '[&>*:not([data-paused])]:opacity-55 [&>*]:transition-opacity [&>*]:duration-300')}>
        {/* A reported task houses the work: everything while it runs, the "Worked for…" fold once it's over. */}
        {task && (live || paused) ? (
          <TaskCard task={task} turn={turn} live={live}>
            {housed.map(renderSeg)}
            {live && !asking && !writing && !paused && <StatusLine turn={turn} status={status} />}
          </TaskCard>
        ) : task ? (
          <TaskCard task={task} turn={turn} live={false}>{folded ? segments(turn.work.filter((it) => !isShow(it) && it.t !== 'user')).map(renderSeg) : null}</TaskCard>
        ) : folded && <WorkedFold turn={turn} renderSeg={renderSeg} />}
        {(task && (live || paused) ? segs.slice(housed.length) : segs).map(renderSeg)}
        {live && asking ? (
          <div data-paused className="flex h-6 min-w-0 items-center gap-2 text-ui text-muted-foreground enter-fade">
            <MessageCircleQuestionIcon className="size-4 shrink-0" />Waiting for your answer below
          </div>
        ) : live && !task && !writing && !paused && <StatusLine turn={turn} status={status} />}
        {!live && !paused && <ChangeChips edits={turn.edits} className={cn(fresh && 'enter-up [--rise:4px]')} />}
        {!live && !paused && (
          <div className="-mt-1 flex h-6 items-center gap-1.5">
            <DoneLine turn={turn} timed={!folded} />
            {answerText && <CopyButton text={answerText} label="Copy reply" reveal="group-hover/a:opacity-100" />}
          </div>
        )}
      </div>
      </WholeWidgets.Provider>
    </div>
  );
}

// ⌘K opened a chat at something said in it. The request is kept here (opening a chat replaces the transcript, so a
// listener inside it could miss it) and picked up by whichever transcript is on screen, once its history has loaded.
let pendingFind: { text: string; query: string; at: number } | null = null;
const findSubs = new Set<() => void>();
window.addEventListener('canopy:find', (e) => { pendingFind = { ...(e as CustomEvent<{ text: string; query: string }>).detail, at: Date.now() }; findSubs.forEach((f) => f()); });

/** Scrolls to the found words and lights them up for a moment, retrying while the history arrives (up to ~5s). */
function FindInChat() {
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const { focused } = usePane();
  useEffect(() => {
    if (!focused) return; // Multi mode: the jump lands in the pane you're in
    let timer: ReturnType<typeof setTimeout>;
    const go = () => {
      const req = pendingFind;
      if (!req || Date.now() - req.at > 8000) return;
      const want = [req.text, req.query].map((t) => t.toLowerCase().replace(/\s+/g, ' ').trim()).filter((t) => t.length > 1);
      let tries = 0;
      clearTimeout(timer);
      const look = () => {
        const sc = scrollRef.current;
        const blocks = sc ? [...sc.querySelectorAll<HTMLElement>('.prose-reply, .user-bubble')] : [];
        const flat = (el: HTMLElement) => el.innerText.toLowerCase().replace(/\s+/g, ' ');
        const hit = want.map((w) => blocks.find((bl) => flat(bl).includes(w))).find(Boolean);
        if (hit && sc) {
          pendingFind = null;
          stopScroll();
          hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
          hit.classList.remove('find-flash'); void hit.offsetWidth; hit.classList.add('find-flash');
          return;
        }
        if (++tries < 25) timer = setTimeout(look, 200);
      };
      timer = setTimeout(look, 250);
    };
    go();
    findSubs.add(go);
    return () => { findSubs.delete(go); clearTimeout(timer); };
  }, [scrollRef, stopScroll, focused]);
  return null;
}

/** Where you were reading in a chat, so a restart (or coming back to the chat) puts you there instead of the bottom.
 *  Saved as distance from the bottom, so new text arriving meanwhile doesn't shift what you were looking at. */
const SCROLL_KEY = 'canopy.scroll';
function ScrollMemory({ onPlaced }: { onPlaced: () => void }) {
  const { meta, items } = useStore();
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const id = meta.sessionId;
  const restored = useRef(false);
  // Restore once, when this chat's history has arrived.
  // The transcript stays invisible until this is done (onPlaced), so a chat appears where it will stay: never at the
  // top, then the bottom, then your spot.
  useEffect(() => {
    if (restored.current) return;
    if (!id || !items.length) { if (!meta.loading) onPlaced(); return; } // nothing to place (yet)
    restored.current = true;
    let saved: Record<string, number> = {};
    try { saved = JSON.parse(localStorage.getItem(SCROLL_KEY) ?? '{}'); } catch { /* fresh start */ }
    const fromBottom = saved[id];
    let r2 = 0;
    // Two frames: the conversation has laid out and been pinned to the bottom by then.
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => {
      const sc = scrollRef.current;
      if (sc && fromBottom && fromBottom >= 80) { // not at (or near) the bottom: back to where you were
        stopScroll();
        sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - fromBottom);
      }
      onPlaced();
    }); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); onPlaced(); };
  }, [id, items.length > 0, meta.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  // Save as you scroll (settled, not every frame). Only the latest 30 chats are kept.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !id) return;
    let t: ReturnType<typeof setTimeout>;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!sc.getClientRects().length) return; // cached layouts have no scroll geometry while hidden
        let saved: Record<string, number> = {};
        try { saved = JSON.parse(localStorage.getItem(SCROLL_KEY) ?? '{}'); } catch { /* start over */ }
        delete saved[id];
        saved[id] = Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop);
        const keys = Object.keys(saved);
        for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete saved[k];
        try { localStorage.setItem(SCROLL_KEY, JSON.stringify(saved)); } catch { /* full: skip */ }
      }, 250);
    };
    sc.addEventListener('scroll', on, { passive: true });
    return () => { clearTimeout(t); sc.removeEventListener('scroll', on); };
  }, [id, scrollRef]);
  return null;
}

/** When a reply finishes while you're following along at the bottom, take you to where it starts so you read it from
 *  the top (your message's last line stays in view for context). Short replies that already fit on screen stay put,
 *  and if you scrolled away during the turn, nothing moves. */
function ReadFromStart() {
  const { meta } = useStore();
  const { scrollRef, stopScroll, isAtBottom } = useStickToBottomContext();
  const was = useRef(meta.busy);
  const following = useRef(isAtBottom);
  following.current = isAtBottom;
  useEffect(() => {
    const ended = was.current && !meta.busy;
    was.current = meta.busy;
    if (!ended || !following.current) return;
    // Wait for the finished turn to fold its steps away (that changes heights), then measure.
    let r2 = 0;
    const t = setTimeout(() => { r2 = requestAnimationFrame(() => {
      const sc = scrollRef.current;
      const replies = sc?.querySelectorAll<HTMLElement>('[data-reply]');
      const reply = replies?.[replies.length - 1];
      if (!sc || !reply || !following.current) return;
      const top = reply.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      if (reply.offsetHeight < sc.clientHeight - 140) return; // it all fits: nothing to read from the top
      stopScroll();
      sc.scrollTo({ top: Math.max(0, top - 72), behavior: 'smooth' });
    }); }, 120);
    return () => { clearTimeout(t); cancelAnimationFrame(r2); };
  }, [meta.busy]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Sending a message while scrolled up takes you back down to it, and the view follows the reply from there. */
function JumpOnSend() {
  const { meta } = useStore();
  const { scrollToBottom } = useStickToBottomContext();
  const seen = useRef(meta.sends);
  useEffect(() => {
    if (meta.sends === seen.current) return;
    seen.current = meta.sends;
    scrollToBottom(matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');
  }, [meta.sends, scrollToBottom]);
  return null;
}

const PAGE = 40;

// ---------- Show earlier ----------
// One button, in one place, for everything above what is on screen:
//   turns that are loaded but not drawn yet           "Show 40 earlier turns"
//   every loaded turn is drawn, the chat has older    "Show earlier" (a very long OpenAI chat opens from its newest
//   ones still to fetch                               turns; a Claude chat is read whole, so it never gets here)
//   while those are fetched                           "Loading earlier…", not pressable
//   nothing older anywhere                            no button
// A page that could not be fetched leaves the button as it was and says so in a toast. Either way the reader's place
// is kept: what they were looking at is as far from the end of the chat after the turns land as it was before.
function ShowEarlier({ hidden, onShow }: { hidden: number; onShow: (paged: boolean) => void }) {
  const store = useStore();
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const more = Math.min(PAGE, hidden);
  const keepPlace = (change: () => void) => {
    const sc = scrollRef.current;
    const fromEnd = sc ? sc.scrollHeight - sc.scrollTop : 0;
    stopScroll(); // the view is pinned to the end while you follow along: let go, or it would jump there
    flushSync(change);
    if (sc) sc.scrollTop = sc.scrollHeight - fromEnd;
  };
  const load = async () => {
    setLoading(true);
    const landed = await store.loadEarlier();
    if (!alive.current) return; // another chat is on screen now
    // The page is in the store but not drawn yet: draw it here, so the place is measured and put back in one go.
    keepPlace(() => { setLoading(false); if (landed) onShow(true); });
    if (landed === false) toast.error('Couldn’t load earlier messages. Try again.', { id: 'earlier' });
  };
  const button = 'mx-auto flex h-7 items-center rounded-md px-2.5 text-small text-muted-foreground hover:bg-accent hover:text-foreground';
  if (hidden > 0) return <button type="button" onClick={() => keepPlace(() => onShow(false))} className={button}>Show {more} earlier turn{more === 1 ? '' : 's'}</button>;
  if (loading) return <button type="button" disabled className={cn(button, 'gap-1.5 hover:bg-transparent hover:text-muted-foreground')}><Spinner className="size-3" />Loading earlier…</button>;
  if (!store.meta.earlier) return null;
  return <button type="button" onClick={load} className={button}>Show earlier</button>;
}

export function Transcript() {
  const store = useStore();
  const { items, meta } = store;
  // The terminal view has the conversation while it is open (the main chat only: panes have no terminal).
  const { terminalLive } = useUi();
  const { multi } = usePane();
  const elsewhere = useHeld(meta.engine === 'codex' ? meta.sessionId : null);
  // Claude's reply is paused on a question for you (its card waits at the message box).
  const asking = items.some((i) => i.t === 'permission' && !i.resolved && i.ev.type === 'question');
  const [shown, setShown] = useState(PAGE);
  const [folds] = useState(() => new Map<string, boolean>()); // lives and dies with the chat: App keys Transcript by chat
  const [placed, setPlaced] = useState(false); // scrolled to where it opens: only then does it fade in
  const tail: HandoffItem[] = [];
  const turns = toTurns(items, tail);
  const hidden = Math.max(0, turns.length - shown);
  const visible = hidden ? turns.slice(hidden) : turns;
  // One more screenful of turns. After a fetched page (`paged`), that many of its turns on top of the ones that
  // were drawn before it landed; the rest of the page waits behind the same button.
  const drawn = useRef(0);
  const [, setPages] = useState(0); // counted so a page that has just landed is drawn at once, whatever `shown` comes to
  const showMore = (paged: boolean) => { setShown((n) => (paged ? Math.min(n, drawn.current) : n) + PAGE); if (paged) setPages((n) => n + 1); };
  useEffect(() => { drawn.current = turns.length; });
  return (
    <Folds value={folds}>
      <Conversation className={cn('min-h-0', placed ? 'enter-fade [animation-duration:140ms]' : 'opacity-0')} initial="instant" resize={{ damping: 0.82, stiffness: 0.06, mass: 1.1 }}>
        <ScrollMemory onPlaced={() => setPlaced(true)} />
        <FindInChat />
        <ReadFromStart />
        <JumpOnSend />
        {/* overflow-x-clip: whatever is still too wide is cut at the edge, so the chat itself never scrolls sideways. */}
        {/* A shell block in a reply here has Run (run-block.tsx). */}
        <RunnableReplies value={true}>
          <ConversationContent data-pad className="mx-auto w-full max-w-[calc(var(--col)+80px)] gap-6 overflow-x-clip px-10 pt-8 pb-12">
            <ShowEarlier hidden={hidden} onShow={showMore} />
            {visible.map((t, i) => {
              const last = i === visible.length - 1;
              // The latest task title of the turns before this one, for a turn that reports only a status.
              let taskTitle = '';
              for (let j = i - 1; j >= 0 && !taskTitle; j--) taskTitle = taskOf(visible[j])?.title ?? '';
              const live = meta.busy && last && !t.end;
              // "Try again" resends the last prompt, so offer it only on the turn that prompt started, once Claude has stopped.
              // Not while another app has the chat open (lib/held): it would only be refused again.
              const retry = last && !meta.busy && !elsewhere && !!meta.lastPrompt && t.user?.text === meta.lastPrompt.text;
              const editable = !!t.user && !editBlocked(t.user, { wall: store.wall, terminal: terminalLive && !multi, loading: meta.loading || store.cutPending, engine: meta.engine });
              const view = <TurnView key={t.key} turn={t} live={live} status={live ? meta.status : ''} retry={retry} asking={live && asking} editable={editable} taskTitle={taskTitle} />;
              return t.before ? <Fragment key={t.key}>{t.before.map((h) => <SwitchLine key={h.key} ev={h.ev} />)}{view}</Fragment> : view;
            })}
            {tail.map((h) => <SwitchLine key={h.key} ev={h.ev} />)}
          </ConversationContent>
        </RunnableReplies>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-5 bg-linear-to-b from-background to-transparent" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10 bg-linear-to-t from-background to-transparent" />
        <ConversationScrollButton />
      </Conversation>
    </Folds>
  );
}

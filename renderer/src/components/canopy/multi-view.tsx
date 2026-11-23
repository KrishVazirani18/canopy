// Multi mode: up to four live chats side by side, each a full Canopy chat (its own transcript, message box and
// controls), turned on and off from the title bar. Built to use every pixel: panes are split by hairlines, the
// sidebar starts collapsed, and each pane has a slim title bar you drag to move it.
//
// Each pane has its own conversation store bound to its chat's id (sid), provided through StoreContext, so the
// transcript and composer are the same components as the main chat. Main sends events for every chat in a pane
// (pane:shown); each pane keeps the ones with its sid. Only the focused pane takes window-wide keys (PaneContext).
//
// Panes work as split panes do in a terminal: inactive ones dim a touch, a pane can be maximized and restored, and
// the keyboard does it all:
//   ⌘D add a pane · ⌘⇧W close the focused pane · ⌘⇧↩ maximize / restore · double-click a title bar too
//   ⌘] / ⌘[ next / previous pane · ⌘⌥ arrows move focus by direction · ⌘1-4 jump to a pane
// Adding, closing, swapping and maximizing animate: each pane glides to its new place (View Transitions).
// A pane's chat stays mounted through all of it (a swap only changes its place, maximize only hides the others), so
// nothing reloads, scrolls back or loses what's typed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { Maximize2Icon, MessageSquareIcon, Minimize2Icon, PlusIcon, SearchIcon, XIcon } from 'lucide-react';
import { api, type CanopyEvent, type LiveSession, type OpenOpts, type SessionSummary } from '@/lib/api';
import type { Back, Move } from '@/lib/move';
import { toast } from 'sonner';
import { sessionsChanged, useChatStatus } from '@/lib/chats';
import { choices } from '@/lib/choices';
import { applyChoices, expectedEngine } from '@/lib/engines';
import { PaneContext } from '@/lib/pane';
import { carriesChat, draggedChat } from '@/lib/chat-drag';
import { Store, StoreContext, isContent, useStore } from '@/lib/store';
import { feature } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import { Composer } from './composer';
import { EmptyState } from './empty-state';
import { Logo } from './logo';
import { Transcript } from './transcript';
import { projectName } from '@/lib/project-name';

export const MAX_PANES = 4;
// cwd null: an empty pane. `replace`: the chat (sid) this pane held when the other maker's model was picked in it;
// main lets go of that chat if it was never used. `move`: that chat had started, so the new one carries on from it
// (lib/move.ts); kept until the new chat has its id, so a pane that has to open again before then moves again.
type Pane = { key: string; cwd: string | null; sessionId: string | null; epoch: number; replace?: string; move?: Move; back?: Back };
const KEY = 'canopy.multi';
let seq = 0;
const nextKey = () => `p${Date.now().toString(36)}${++seq}`;

/** What Multi mode had open, so turning it back on (or restarting) brings the same panes back. */
function loadPanes(): { panes: Pane[]; focus: string | null } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!v || !Array.isArray(v.panes) || !v.panes.length) return null;
    const panes = (v.panes as Pane[]).slice(0, MAX_PANES).map((p) => ({ key: nextKey(), cwd: p.cwd ?? null, sessionId: p.sessionId ?? null, epoch: 0 }));
    const i = Math.max(0, (v.panes as Pane[]).findIndex((p) => p.key === v.focus));
    return { panes, focus: panes[i]?.key ?? panes[0].key };
  } catch { return null; }
}
function savePanes(panes: Pane[], focus: string | null) {
  try { localStorage.setItem(KEY, JSON.stringify({ panes: panes.map(({ key, cwd, sessionId }) => ({ key, cwd, sessionId })), focus })); } catch { /* full */ }
}

/** The chat on the main screen when Multi mode is turned on: it shows in a pane (focused), next to the panes from
 *  last time. Not set when Canopy starts with Multi mode already on. */
/** `also`: a chat dragged from the sidebar onto the chat area, placed in another pane beside it and focused. */
type Seed = { cwd: string | null; sessionId: string | null; also?: { cwd: string; sessionId: string } };
let seed: Seed | null = null;
export function seedMulti(cwd: string | null, sessionId: string | null, also?: { cwd: string; sessionId: string }) { seed = { cwd, sessionId, also }; }

/** Where a chat goes when it's opened in Multi mode: the focused pane if it's empty, else the first empty pane,
 *  else the focused pane (its chat keeps running). */
function target(panes: Pane[], focus: string | null): Pane | undefined {
  const f = panes.find((p) => p.key === focus);
  return f && !f.cwd ? f : panes.find((p) => !p.cwd) ?? f ?? panes[0];
}

/** The panes Multi mode opens with: the ones from last time, with the chat you were in placed and focused. */
function initial(): { panes: Pane[]; focus: string | null } {
  const from = seed;
  seed = null;
  const saved = loadPanes();
  const blank = (): Pane => ({ key: nextKey(), cwd: null, sessionId: null, epoch: 0 });
  if (!saved) {
    if (!from?.cwd) { const only = blank(); return { panes: [only], focus: only.key }; }
    const first: Pane = { key: nextKey(), cwd: from.cwd, sessionId: from.sessionId, epoch: 0 };
    return withAlso({ panes: [first, blank()], focus: first.key }, from);
  }
  return withAlso(withSeed(saved, from), from);
}

/** The dragged-in chat, beside the one you were in: an empty pane, else a new one, else the pane you're not in. */
function withAlso(state: { panes: Pane[]; focus: string | null }, from: Seed | null) {
  const also = from?.also;
  if (!also) return state;
  const there = state.panes.find((p) => p.sessionId === also.sessionId);
  if (there) return { ...state, focus: there.key };
  const into = state.panes.find((p) => !p.cwd) ?? (state.panes.length < MAX_PANES ? null : state.panes.find((p) => p.key !== state.focus) ?? state.panes[0]);
  if (!into) { const added: Pane = { key: nextKey(), cwd: also.cwd, sessionId: also.sessionId, epoch: 0 }; return { panes: [...state.panes, added], focus: added.key }; }
  return { panes: state.panes.map((p) => (p === into ? { ...p, cwd: also.cwd, sessionId: also.sessionId, epoch: p.epoch + 1 } : p)), focus: into.key };
}

/** Re-entering Multi mode focuses the current chat without replacing the other panes. */
function withSeed(saved: { panes: Pane[]; focus: string | null }, from: typeof seed) {
  if (!from?.cwd || !from.sessionId) return saved; // a new chat you hadn't started: nothing to bring along
  const there = saved.panes.find((p) => p.sessionId === from.sessionId);
  if (there) return { ...saved, focus: there.key };
  const into = saved.panes.find((p) => !p.cwd) ?? (saved.panes.length < MAX_PANES ? null : saved.panes.find((p) => p.key === saved.focus) ?? saved.panes[0]);
  if (!into) { const added: Pane = { key: nextKey(), cwd: from.cwd, sessionId: from.sessionId, epoch: 0 }; return { panes: [...saved.panes, added], focus: added.key }; }
  return { panes: saved.panes.map((p) => (p === into ? { ...p, cwd: from.cwd, sessionId: from.sessionId, epoch: p.epoch + 1 } : p)), focus: into.key };
}

/** Runs a layout change as a View Transition, so panes glide to their new places instead of jumping. */
function animate(change: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished?: Promise<void> } };
  if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { change(); return; }
  document.documentElement.classList.add('mm-vt');
  doc.startViewTransition(() => flushSync(change)).finished?.finally(() => document.documentElement.classList.remove('mm-vt'));
}

// Layout by count. 3 = one wide pane on top and two below, like a terminal split (the first pane spans the row).
const GRID: Record<number, string> = {
  1: 'grid-cols-1 grid-rows-1',
  2: 'grid-cols-2 grid-rows-1',
  3: 'grid-cols-2 grid-rows-2',
  4: 'grid-cols-2 grid-rows-2',
};
/** Where pane i sits (column, row) for a given count, for moving focus with the arrow keys. */
function cell(i: number, n: number): [number, number] {
  if (n === 1) return [0, 0];
  if (n === 2) return [i, 0];
  if (n === 3) return i === 0 ? [0.5, 0] : [i - 1, 1];
  return [i % 2, Math.floor(i / 2)];
}

type Recent = SessionSummary & { dir: string };

/** An empty pane's list of chats to put in it: the latest few, or, once you type, the ones whose name (or project's
 *  name) has every word you typed, as ⌘K finds chats by name. Enter puts the first one here. */
function PutChatHere({ chats, chatsDir, onPick }: { chats: Recent[]; chatsDir: string | null; onPick: (c: Recent) => void }) {
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const project = (dir: string) => (dir === chatsDir ? '' : projectName(dir));
  const hits = (words.length ? chats.filter((c) => { const s = `${c.title} ${project(c.dir)}`.toLowerCase(); return words.every((w) => s.includes(w)); }) : chats).slice(0, 6);
  return (
    <div className="w-full max-w-xs">
      <div className="mb-1.5 px-2 text-small text-faint">Or put a chat here</div>
      <div className="mb-1 flex h-8 items-center gap-2 rounded-md border border-hairline px-2 focus-within:border-foreground/20">
        <SearchIcon className="size-3.5 shrink-0 text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) { e.preventDefault(); onPick(hits[0]); }
            else if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); }
          }}
          className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
      </div>
      {/* Room for the full list kept while you type, so the box doesn't move as the matches thin out. */}
      <div className={cn(words.length > 0 && chats.length >= 6 && 'min-h-48')}>
        {hits.map((c) => (
          <button type="button" key={c.id} onClick={() => onPick(c)}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-foreground/80 hover:bg-accent">
            <MessageSquareIcon className="size-3.5 shrink-0 text-faint" /><span className="truncate">{c.title}</span>
            {words.length > 0 && project(c.dir) && <span className="ml-auto shrink-0 text-small text-faint">{project(c.dir)}</span>}
          </button>
        ))}
        {words.length > 0 && !hits.length && <div className="flex h-8 items-center px-2 text-ui text-faint">No chats match</div>}
      </div>
    </div>
  );
}

const OPEN_FAILED = 'Couldn’t open this chat.';
const EARLY_MAX = 5000; // events held while a pane's chat opens (every chat's: the pane doesn't know its id yet)

// ---------- one pane's chat ----------

type ChatPaneProps = {
  pane: Pane; focused: boolean;
  onSid: (key: string, sid: string | null) => void; onSession: (key: string, sessionId: string) => void;
  /** A move into this pane was refused: the pane goes back to the chat it held. */
  onMoveRefused: (key: string, from: string, message: string) => void;
};

/** A live chat in a pane: opens (or picks up) its chat, keeps the events with its sid, and renders the real chat UI. */
function ChatPane({ pane, focused, onSid, onSession, onMoveRefused }: ChatPaneProps) {
  const store = useMemo(() => new Store(null, pane.cwd, true), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [files, setFiles] = useState<string[] | null>(null);
  const [reopen, setReopen] = useState(0); // main let this chat go (idle too long): open it again
  const replace = useRef(pane.replace); // said once, on this pane's first open

  useEffect(() => {
    const cwd = pane.cwd;
    if (!cwd) return;
    let alive = true;
    // Events can land while the chat opens (a live one mid-reply): hold them until we know our sid, then replay ours.
    const early: CanopyEvent[] = [];
    let ready = false;
    const off = api.onEvent((ev) => {
      if (!ready) { early.push(ev); if (early.length > EARLY_MAX) early.splice(0, early.length - EARLY_MAX); return; }
      if (ev.sid !== store.sid) return;
      store.handle(ev);
      if (ev.kind === 'turn-end') store.fetchContext();
      // A new chat in a pane is listed (and named) once Claude Code has saved it: look again as it starts replying,
      // like the main screen does, instead of only when the reply ends.
      if (ev.kind === 'init' || ev.kind === 'message-start' || ev.kind === 'turn-end') sessionsChanged();
    });
    const offClosed = api.pane?.onClosed(({ sid }) => { if (sid === store.sid) setReopen((n) => n + 1); }) ?? (() => {});
    store.reload = () => setReopen((n) => n + 1); // an edit that didn't go through: show the chat as it is again
    api.listFiles(cwd).then((f) => { if (alive && Array.isArray(f)) setFiles(f); });

    const resume = store.meta.sessionId ?? pane.sessionId;
    store.reset();
    store.opening(); // anything sent meanwhile waits for this chat (never the main screen's)
    // A saved chat keeps the engine it started on; a new one starts on the maker whose model you picked last.
    const asked = expectedEngine(resume);
    store.setEngine(asked);
    store.setMeta({ loading: true, sessionId: resume });
    const move = resume ? undefined : pane.move;
    // Gone back to the session the other maker already has in this chat's thread (lib/move.ts).
    const back = resume && pane.back?.to === resume ? pane.back : undefined;
    const backAsk = back && back.from !== resume ? { from: back.from, fromModel: back.fromModel, toModel: back.toModel } : undefined;
    const ask: OpenOpts = { ...(!resume && asked === 'codex' && { engine: asked }), ...(replace.current && { replace: replace.current }), ...(move && { move }), ...(backAsk && { back: backAsk }) };
    replace.current = undefined;
    (async () => {
      let r: Awaited<ReturnType<NonNullable<typeof api.pane>['open']>>;
      try { r = api.pane ? await api.pane.open(cwd, resume, Object.keys(ask).length ? ask : undefined) : { error: OPEN_FAILED }; }
      catch (err) { r = { error: String((err as Error)?.message ?? err) || OPEN_FAILED }; }
      if (!alive) return;
      if (r?.error && (move || back)) { store.bind(null); ready = true; onMoveRefused(pane.key, (move ?? back)!.from, r.error); return; }
      if (r?.error || !r.sid) { store.bind(null); store.setMeta({ loading: false }); store.addError(r?.error ?? OPEN_FAILED); ready = true; return; }
      store.bind(r.sid);
      onSid(pane.key, r.sid);
      if (r.reused && r.live) {
        // Still running (maybe mid-reply, maybe the chat on the main screen): pick it up exactly where it is.
        const live = r.live as LiveSession & { tasks?: unknown[] };
        const st = live.settings ?? {};
        store.setEngine(r.engine ?? live.engine);
        store.setMeta({ sessionId: live.sessionId, mode: st.permissionMode ?? null, pick: st.model || null, busy: live.busy, fastPref: typeof st.fast === 'boolean' ? st.fast : null, codePref: st.codeMode === true, accountId: live.accountId });
        if (live.meta) store.handle(live.meta);
        store.loadHistory(live.history ?? []);
        for (const ev of live.pending ?? []) store.handle(ev);
        store.setQueue(live.queue, live.queueV);
        if (Array.isArray(live.tasks)) store.setMeta({ tasks: live.tasks as never });
        if (back) applyChoices(store, r.engine ?? live.engine, r.defaults?.mode, null); // it takes the model you picked
      } else {
        // A chat starting here takes your current choices for its maker, like opening one on the main screen.
        store.setMeta({ sessionId: resume, mode: choices.mode ?? r.defaults?.mode ?? null, accountId: r.accountId });
        applyChoices(store, r.engine, r.defaults?.mode, resume && !back ? r.history ?? [] : null);
        store.loadHistory(r.history ?? []);
      }
      // Events that came while it opened, except those its snapshot already covers.
      const seq = r.reused ? (r.live as LiveSession | undefined)?.seq : undefined;
      for (const ev of early) if (ev.sid === r.sid && !(typeof seq === 'number' && typeof ev.seq === 'number' && ev.seq <= seq)) store.handle(ev);
      ready = true;
      store.setMeta({ loading: false });
      store.fetchContext(8);
      if (move || back) window.dispatchEvent(new Event('canopy:moved')); // what you had typed follows you (lib/move.ts)
    })();
    return () => { alive = false; off(); offClosed(); store.reload = null; onSid(pane.key, null); };
  }, [pane.cwd, reopen]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new chat gets its id once Claude Code has saved it: remember it, so the pane comes back to the same chat.
  return (
    <StoreContext.Provider value={store}>
      <PaneContext.Provider value={{ multi: true, focused }}>
        <PaneBody cwd={pane.cwd} files={files} onSession={(id) => onSession(pane.key, id)} />
      </PaneContext.Provider>
    </StoreContext.Provider>
  );
}

function PaneBody({ cwd, files, onSession }: { cwd: string | null; files: string[] | null; onSession: (id: string) => void }) {
  const { meta, items } = useStore();
  useEffect(() => { if (meta.sessionId) onSession(meta.sessionId); }, [meta.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A chat that was moved here opens on its "Continued from" line, not on the empty screen.
  const empty = !items.some(isContent) && !items.some((i) => i.t === 'handoff') && (!meta.loading || !meta.sessionId);
  if (empty) return <EmptyState files={files} cwd={cwd} />;
  if (meta.loading) return (
    <>
      <div className="flex flex-1 items-center justify-center"><div className="enter-fade [animation-delay:300ms] [animation-duration:400ms]"><Logo className="breathe size-7 text-brand" /></div></div>
      <Composer files={files} cwd={cwd} />
    </>
  );
  return <><Transcript /><Composer files={files} cwd={cwd} /></>;
}

/** The pane's title bar: the chat's name and project, and where it stands, the way the sidebar shows it: a green dot
 *  when it needs you or went wrong, "Working…" while it works. Maximize and close float over the right end on hover. */
function PaneTitle({ sessionId, title, project, focused }: { sessionId: string | null; title: string; project: string | null; focused: boolean }) {
  const st = useChatStatus(sessionId);
  const needs = st?.state === 'needs-you' || !!st?.failed;
  const working = !needs && (st?.state === 'working' || (st?.helpers ?? 0) > 0);
  return (
    <>
      <span className={cn('min-w-0 truncate text-ui transition-colors duration-200', focused ? 'text-foreground' : 'text-muted-foreground')}>{title}</span>
      {needs && <span role="img" aria-label={st?.failed ? 'Went wrong' : 'Needs you'} title={st?.failed ? 'Went wrong' : 'Needs you'} className="size-2 shrink-0 rounded-full bg-brand" />}
      {project && <span className="shrink-0 text-small text-faint">{project}</span>}
      {working && <span className="working-line ml-auto shrink-0 text-small font-medium">Working…</span>}
    </>
  );
}

// ---------- the grid ----------

/** `active`: on screen. Hidden panes keep their stores and drafts, but leave window-wide keys alone. */
type MultiViewProps = { sessions: SessionSummary[]; chatsDir: string | null; active: boolean };

export function MultiView({ sessions, chatsDir, active }: MultiViewProps) {
  const [{ panes, focus }, setState] = useState(initial);
  const [max, setMax] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const sids = useRef(new Map<string, string>()); // pane key -> its chat's sid
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; }, [active]);
  useLayoutEffect(() => {
    if (!active || !seed) return;
    const from = seed;
    seed = null;
    setState((saved) => withAlso(withSeed(saved, from), from));
    setMax(null);
  }, [active]);

  const setPanes = useCallback((f: (p: Pane[]) => Pane[]) => setState((s) => ({ ...s, panes: f(s.panes) })), []);
  const setFocus = useCallback((key: string) => setState((s) => (s.focus === key ? s : { ...s, focus: key })), []);
  useEffect(() => { savePanes(panes, focus); }, [panes, focus]);

  // Keep cached chats synchronized without counting them as read while Multi mode is hidden.
  const publish = useCallback(() => {
    const cached = [...sids.current.values()];
    // A renderer update can precede the app restart that loads the new preload/host.
    api.pane?.shown(activeRef.current || api.pane.keepAlive !== true ? cached : [], cached).catch(() => {});
  }, []);
  useEffect(publish, [active, publish]);
  useEffect(() => () => { api.pane?.shown([]).catch(() => {}); }, []);
  const onSid = useCallback((key: string, sid: string | null) => { if (sid) sids.current.set(key, sid); else sids.current.delete(key); publish(); }, [publish]);
  useEffect(() => {
    const keys = new Set(panes.map((p) => p.key));
    for (const k of [...sids.current.keys()]) if (!keys.has(k)) sids.current.delete(k);
    publish();
  }, [panes, publish]);
  const onSession = useCallback((key: string, sessionId: string) => setPanes((ps) => ps.map((p) => (p.key === key && p.sessionId !== sessionId ? { ...p, sessionId, move: undefined, back: undefined } : p))), [setPanes]);

  const titleOf = useCallback((id: string | null) => (id ? sessions.find((s) => s.id === id)?.title ?? null : null), [sessions]);
  const shownIds = new Set(panes.map((p) => p.sessionId).filter(Boolean));
  const recents: Recent[] = sessions.filter((s) => s.cwd && !shownIds.has(s.id)).map((s) => ({ ...s, dir: s.cwd! })).sort((a, b) => b.updated - a.updated);
  const focusIndex = Math.max(0, panes.findIndex((p) => p.key === focus));
  const focusedPane = panes[focusIndex];
  // The folder you were last working in: a new chat started in an empty pane goes there.
  const lastDir = useRef<string | null>(null);
  if (focusedPane?.cwd) lastDir.current = focusedPane.cwd;

  /** Put a chat (or a new one) into a pane. `replace`: the chat the pane held, for main to let go of if it was never
   *  used. `move`: the new chat carries on from that chat. */
  const fill = useCallback((key: string, cwd: string, sessionId: string | null, replace?: string, move?: Move, back?: Back) => animate(() => {
    sids.current.delete(key);
    setPanes((ps) => ps.map((p) => (p.key === key ? { ...p, cwd, sessionId, epoch: p.epoch + 1, replace, move, back } : p)));
    setFocus(key);
  }), [setPanes, setFocus]);
  const onMoveRefused = useCallback((key: string, from: string, message: string) => {
    toast(message, { id: 'move-busy' });
    setPanes((ps) => ps.map((p) => (p.key === key ? { ...p, sessionId: from, epoch: p.epoch + 1, replace: undefined, move: undefined, back: undefined } : p)));
  }, [setPanes]);
  const add = useCallback(() => {
    if (panes.length >= MAX_PANES) return;
    feature('pane_added');
    const key = nextKey();
    animate(() => { setMax(null); setPanes((ps) => [...ps, { key, cwd: null, sessionId: null, epoch: 0 }]); setFocus(key); });
  }, [panes.length, setPanes, setFocus]);
  const close = useCallback((key: string) => {
    if (panes.length <= 1) return;
    feature('pane_closed');
    const i = panes.findIndex((p) => p.key === key);
    const rest = panes.filter((p) => p.key !== key);
    animate(() => {
      setPanes(() => rest);
      setMax((m) => (m === key ? null : m));
      if (focus === key) setFocus(rest[Math.min(i, rest.length - 1)].key); // the neighbour that took its place
    });
  }, [panes, focus, setPanes, setFocus]);
  const toggleMax = useCallback((key: string) => {
    if (panes.length < 2 && !max) return; // one pane already fills the window
    animate(() => { setMax((m) => (m === key ? null : key)); setFocus(key); });
  }, [panes.length, max, setFocus]);
  const swap = useCallback((from: string, to: string) => {
    if (from === to) return;
    animate(() => setPanes((ps) => {
      const n = [...ps]; const a = n.findIndex((p) => p.key === from), b = n.findIndex((p) => p.key === to);
      [n[a], n[b]] = [n[b], n[a]]; return n;
    }));
    setFocus(from);
  }, [setPanes, setFocus]);

  // The sidebar, ⌘K, notifications and ⌘N land in the focused pane while Multi mode is on. A chat that's already
  // in a pane just gets focus there.
  useEffect(() => {
    if (!active) return;
    const onOpen = (e: Event) => {
      const { dir, id } = (e as CustomEvent<{ dir: string; id: string | null }>).detail;
      const there = id ? panes.find((p) => p.sessionId === id) : undefined;
      if (there) { setFocus(there.key); if (max && max !== there.key) toggleMax(there.key); return; }
      const to = target(panes, focus);
      if (!to) return;
      if (max && max !== to.key) setMax(to.key);
      fill(to.key, dir, id);
    };
    const onNew = (e: Event) => {
      const dir = (e as CustomEvent<{ dir?: string }>).detail?.dir ?? lastDir.current ?? chatsDir;
      const to = target(panes, focus);
      if (!dir || !to) return;
      if (max && max !== to.key) setMax(to.key);
      fill(to.key, dir, null);
    };
    window.addEventListener('canopy:pane-open', onOpen);
    window.addEventListener('canopy:pane-new', onNew);
    return () => { window.removeEventListener('canopy:pane-open', onOpen); window.removeEventListener('canopy:pane-new', onNew); };
  }, [active, panes, focus, max, chatsDir, fill, setFocus, toggleMax]);

  // The other maker's model was picked in the pane you are in (controls.tsx): a chat of that maker takes this pane, in
  // the same folder. A chat that had not started is let go of; a started one is moved, and stays one chat on screen:
  // a new session of that maker carries it on (`move`), or the one that maker already has in it (`back`).
  useEffect(() => {
    if (!active) return;
    const on = (e: Event) => {
      const p = panes.find((x) => x.key === focus);
      if (!p?.cwd) return;
      const d = (e as CustomEvent<{ move?: Move; back?: Back } | undefined>).detail;
      if (d?.back) fill(p.key, p.cwd, d.back.to, sids.current.get(p.key), undefined, d.back);
      else fill(p.key, p.cwd, null, sids.current.get(p.key), d?.move);
    };
    window.addEventListener('canopy:other-maker', on);
    return () => window.removeEventListener('canopy:other-maker', on);
  }, [active, panes, focus, fill]);

  // Keyboard, as in a split terminal. ⌘W stays Close Window, as everywhere in Canopy.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const k = e.key.toLowerCase();
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      const go = (i: number) => { stop(); const p = panes[i]; if (!p) return; setFocus(p.key); if (max && max !== p.key) animate(() => setMax(p.key)); };
      if (k === 'd' && !e.shiftKey && !e.altKey) { stop(); add(); return; }
      if (k === 'w' && e.shiftKey) { stop(); close(focus!); return; }
      if (k === 'enter' && e.shiftKey) { stop(); toggleMax(focus!); return; }
      if (k === ']' && !e.shiftKey) return go((focusIndex + 1) % panes.length);
      if (k === '[' && !e.shiftKey) return go((focusIndex - 1 + panes.length) % panes.length);
      if (/^[1-4]$/.test(k) && !e.shiftKey && !e.altKey) return go(+k - 1);
      if (e.altKey && k.startsWith('arrow')) {
        const [x, y] = cell(focusIndex, panes.length);
        const dir = ({ arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] } as Record<string, number[]>)[k];
        if (!dir) return;
        let best = -1, bestD = Infinity;
        panes.forEach((_, i) => {
          const [cx, cy] = cell(i, panes.length); const dx = cx - x, dy = cy - y;
          if ((dir[0] && Math.sign(dx) !== dir[0]) || (dir[1] && Math.sign(dy) !== dir[1])) return;
          const d = Math.abs(dx) + Math.abs(dy); if (d < bestD) { bestD = d; best = i; }
        });
        if (best >= 0) go(best); else stop();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, panes, focus, focusIndex, max, add, close, toggleMax, setFocus]);

  // A drag that ends anywhere (dropped elsewhere, or Esc) takes the drop outline with it.
  useEffect(() => {
    const clear = () => setOverKey(null);
    window.addEventListener('dragend', clear); window.addEventListener('drop', clear);
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear); };
  }, []);
  useEffect(() => { setInfo({ count: panes.length, maximized: !!max, cwd: focusedPane?.cwd ?? null, sessionId: focusedPane?.sessionId ?? null }); }, [panes.length, max, focusedPane?.cwd, focusedPane?.sessionId]);
  useEffect(() => () => setInfo(NO_INFO), []);
  useEffect(() => { if (!active) return; const on = () => add(); window.addEventListener('canopy:pane-add', on); return () => window.removeEventListener('canopy:pane-add', on); }, [active, add]);

  // Panes keep one order in the page (oldest first) and take their place in the grid by CSS `order`: swapping, adding
  // and closing never move a chat's elements, so none of them reloads or jumps back to the top. A maximized pane fills
  // the grid while the others stay mounted, hidden, and carry on.
  const order = new Map(panes.map((p, i) => [p.key, i]));
  const stable = [...panes].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const count = max ? 1 : panes.length;
  return (
    <div className={cn('grid min-h-0 min-w-0 flex-1 gap-px bg-hairline', GRID[count])}>
      {stable.map((p) => {
        const i = order.get(p.key)!;
        const focused = focus === p.key;
        const hidden = !!max && max !== p.key;
        const title = p.cwd ? titleOf(p.sessionId) ?? (p.sessionId ? 'Chat' : 'New chat') : 'Empty pane';
        const project = p.cwd && p.cwd !== chatsDir ? projectName(p.cwd) : null;
        return (
          <section key={p.key} data-pane hidden={hidden} onMouseDownCapture={() => setFocus(p.key)} onFocusCapture={() => setFocus(p.key)}
            style={{ order: i, viewTransitionName: hidden ? undefined : `mm-${p.key}` } as React.CSSProperties}
            // A pane dragged by its header swaps places; a chat dragged from the sidebar goes into the pane it's dropped on.
            onDragOver={(e) => { if (dragKey || carriesChat(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDragEnter={(e) => { if (dragKey || carriesChat(e.dataTransfer)) setOverKey(p.key); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverKey((k) => (k === p.key ? null : k)); }}
            onDrop={(e) => {
              const chat = !dragKey ? draggedChat(e.dataTransfer) : null;
              if (!dragKey && !chat) return;
              e.preventDefault(); setOverKey(null);
              if (dragKey) { swap(dragKey, p.key); setDragKey(null); return; }
              const there = panes.find((x) => x.sessionId === chat!.id);
              if (there) { setFocus(there.key); return; }
              setFocus(p.key);
              fill(p.key, chat!.dir, chat!.id);
            }}
            className={cn('group/pane relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background', hidden && 'hidden', !max && panes.length === 3 && i === 0 && 'col-span-2')}>
            {/* Focus: a thin green line along the top (no space taken). Inactive panes dim a touch. */}
            <span aria-hidden className={cn('pointer-events-none absolute inset-x-0 top-0 z-40 h-[2px] bg-brand transition-opacity duration-200', focused && panes.length > 1 && !max ? 'opacity-80' : 'opacity-0')} />
            <span aria-hidden className={cn('pointer-events-none absolute inset-0 z-30 bg-black transition-opacity duration-200', panes.length > 1 && !max && !focused ? 'opacity-[0.16]' : 'opacity-0')} />
            <span aria-hidden className={cn('pointer-events-none absolute inset-1.5 z-40 rounded-lg border-2 border-dashed border-foreground/25 transition-opacity duration-150', overKey === p.key && (!dragKey || dragKey !== p.key) ? 'opacity-100' : 'opacity-0')} />

            <header draggable={panes.length > 1} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.key); setDragKey(p.key); }}
              onDragEnd={() => { setDragKey(null); setOverKey(null); }} onDoubleClick={() => toggleMax(p.key)}
              className={cn('relative z-20 flex h-8 shrink-0 items-center gap-2 border-b border-hairline bg-background px-3', panes.length > 1 && 'cursor-grab active:cursor-grabbing', dragKey === p.key && 'opacity-50')}>
              {p.cwd ? <PaneTitle sessionId={p.sessionId} title={title} project={project} focused={focused} /> : <span className="text-ui text-muted-foreground">Empty pane</span>}
              <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5 bg-background pl-2 opacity-0 transition-opacity duration-150 group-hover/pane:opacity-100 focus-within:opacity-100">
                {panes.length > 1 && (
                  <button type="button" onClick={() => toggleMax(p.key)} aria-label={max === p.key ? 'Restore' : 'Maximize'} title={max === p.key ? 'Restore (⌘⇧↩)' : 'Maximize (⌘⇧↩)'}
                    className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground">
                    {max === p.key ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
                  </button>
                )}
                {panes.length > 1 && (
                  <button type="button" onClick={() => close(p.key)} aria-label="Close pane" title="Close pane (⌘⇧W) · the chat keeps running"
                    className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"><XIcon className="size-3.5" /></button>
                )}
              </div>
            </header>

            <div className="relative flex min-h-0 flex-1 flex-col">
              {p.cwd ? (
                <ChatPane key={`${p.key}:${p.epoch}`} pane={p} focused={focused && active} onSid={onSid} onSession={onSession} onMoveRefused={onMoveRefused} />
              ) : (
                // An empty pane: start a chat here (in the folder you were working in), or put one that's already going here.
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
                  <button type="button" onClick={() => { const d = lastDir.current ?? chatsDir; if (d) fill(p.key, d, null); }}
                    className="flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-ui font-medium text-background"><PlusIcon className="size-4" />New chat</button>
                  {recents.length > 0 && <PutChatHere chats={recents} chatsDir={chatsDir} onPick={(c) => fill(p.key, c.dir, c.id)} />}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// What the window shows about Multi mode, kept in step with the grid: how many panes, whether one is maximized, and
// the focused pane's chat (the title bar names it, the sidebar highlights it).
type MultiInfo = { count: number; maximized: boolean; cwd: string | null; sessionId: string | null };
const NO_INFO: MultiInfo = { count: 0, maximized: false, cwd: null, sessionId: null };
let info = NO_INFO;
const infoSubs = new Set<() => void>();
function setInfo(next: MultiInfo) {
  if (next.count === info.count && next.maximized === info.maximized && next.cwd === info.cwd && next.sessionId === info.sessionId) return;
  info = next; infoSubs.forEach((f) => f());
}
export function useMultiInfo() {
  return useSyncExternalStore((f) => { infoSubs.add(f); return () => { infoSubs.delete(f); }; }, () => info);
}
/** The focused pane's chat, for when Multi mode is turned off (the main screen shows it). */
export function focusedPaneChat(): { cwd: string | null; sessionId: string | null } | null {
  const v = loadPanes();
  const p = v?.panes.find((x) => x.key === v.focus) ?? v?.panes[0];
  return p?.cwd ? { cwd: p.cwd, sessionId: p.sessionId } : null;
}

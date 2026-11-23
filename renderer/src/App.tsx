import { carriesChat, draggedChat, type DraggedChat } from '@/lib/chat-drag';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AccountPrompt } from '@/components/canopy/account-prompt';
import { Composer } from '@/components/canopy/composer';
import { EmptyState } from '@/components/canopy/empty-state';
import { Inspector } from '@/components/canopy/inspector';
import { RestartDialog } from '@/components/canopy/restart-dialog';
import { UpdateRequired } from '@/components/canopy/update-required';
import { CodexSignInSheet } from '@/components/canopy/codex-signin';
import { HomeView } from '@/components/canopy/home-view';
import { MultiView, focusedPaneChat, seedMulti, useMultiInfo } from '@/components/canopy/multi-view';
import { Logo } from '@/components/canopy/logo';
import { Palette } from '@/components/canopy/palette';
import { SettingsDialog } from '@/components/canopy/settings-dialog';
import { LoadingScreen, SetupScreen, WelcomeScreen, type Problem } from '@/components/canopy/setup-screens';
import { SignInSheet } from '@/components/canopy/signin-sheet';
import { Sidebar, SIDEBAR_FULL, SIDEBAR_RAIL, type Project } from '@/components/canopy/sidebar';
import { TitleBar } from '@/components/canopy/title-bar';
import { Transcript } from '@/components/canopy/transcript';
import { startUsageNotice } from '@/components/canopy/usage-notice';
import { authFrom } from '@/lib/account-rules';
import { seedAccounts, startAccounts, useAccounts } from '@/lib/accounts';
import { useCanopyAccount, useFirstRun } from '@/lib/canopy-account';
import { FirstRun } from '@/components/canopy/first-run/first-run';
import { api, type CanopyEvent, type Engine, type EnvInfo, type LiveSession, type OpenOpts, type SessionSummary } from '@/lib/api';
import { choices } from '@/lib/choices';
import { reorderAs } from '@/lib/chat-order';
import { applyChoices, expectedEngine, rememberEngines, startModels } from '@/lib/engines';
import { startReleases } from '@/lib/releases';
import type { Back, Move } from '@/lib/move';
import { repin } from '@/lib/pins';
import { startSignIn } from '@/lib/signin';
import { isContent, store, useStore, type HandoffItem } from '@/lib/store';
import { feature, startTelemetry } from '@/lib/telemetry';
import { startUpkeep } from '@/lib/upkeep';
import { startAppUpdate } from '@/lib/app-update';
import { ui, useUi } from '@/lib/ui';
import { PaneContext } from '@/lib/pane';
import { usePanelMount } from '@/lib/panel-mount';
import { useAppShortcuts } from '@/lib/app-shortcuts';
import { chats as chatStatus, sessionsChanged } from './lib/chats';
import { heldChats } from './lib/held';
import { playDone } from './lib/sound';
import { cn } from '@/lib/utils';
import { projectName } from '@/lib/project-name';
import { groupProjects } from '@/lib/projects';
import { titleCase } from '../../src/title-case.mjs';

// The design Playground is fetched only when a source run opens it (preload's `dev`).
const Playground = lazy(() => import('@/playground/playground').then((m) => ({ default: m.Playground })));

type View = { name: 'loading' } | { name: 'setup'; problem: Problem; detail?: string } | { name: 'welcome' } | { name: 'main' };

// Engine events flow into the store for the whole lifetime of the window.
// Registered once: a hot reload removes the previous listeners first (otherwise events get handled twice).
const g = window as unknown as { __canopyOff?: (() => void)[] };
g.__canopyOff?.forEach((off) => off());
// Real errors get a toast. Browser housekeeping warnings (a ResizeObserver that settles a frame late) are not problems.
const BENIGN = /ResizeObserver loop|ResizeObserver loop limit exceeded/i;
const onWindowError = (e: ErrorEvent) => {
  if (BENIGN.test(String(e.message))) { e.stopImmediatePropagation?.(); return; }
  toast.error('Canopy ran into a problem', { id: `err:${e.message}`, description: e.message }); // the same error never stacks twice
};
window.addEventListener('error', onWindowError);
// Events for a chat that is still opening wait here, from launch until the first chat is in place and from the start of
// each open until its history is in. Handled any sooner they would land in a transcript that is about to be reset, or
// in the chat you just left. `release` plays the ones that belong after the history, so a notice that arrives while a
// chat loads sits at the end of the conversation, where it happened.
const held: { evs: CanopyEvent[] | null } = { evs: [] };
const HELD_MAX = 5000;
function onChatEvent(ev: CanopyEvent) {
  try {
    if (!chatStatus.isActive(ev as { sid?: string })) return; // another chat, running in the background: the sidebar shows it
    store.handle(ev);
    if (ev.kind === 'turn-end') {
      api.context().then((c) => { if (c) store.noteContext(c); });
      sessionsChanged();
    }
    // A new chat only lists once Claude Code has saved your first message, which is after init: so refresh again
    // when the reply starts, or a long first task would stay out of the sidebar until it finished.
    if (ev.kind === 'init' || ev.kind === 'message-start' || ev.kind === 'tool-start') sessionsChanged();
  } catch (err) { console.error(err); }
}
/** The chat is in place: play what arrived for it meanwhile, except what its snapshot (up to `seq`) already covers. */
function release(sid: string | null | undefined, seq?: number) {
  const evs = held.evs ?? [];
  held.evs = null;
  for (const ev of evs) {
    if (ev.sid && ev.sid !== sid) continue;
    if (typeof seq === 'number' && typeof ev.seq === 'number' && ev.seq <= seq) continue;
    onChatEvent(ev);
  }
}
g.__canopyOff = [
  api.onEvent((ev) => {
    if (!held.evs) return onChatEvent(ev);
    held.evs.push(ev);
    if (held.evs.length > HELD_MAX) held.evs.splice(0, held.evs.length - HELD_MAX);
  }),
  api.onAppError((msg) => toast.error('Canopy ran into a problem', { description: msg.slice(0, 300) })),
  api.onEngineUpdated?.(() => ui.set({ updateReady: true })) ?? (() => {}),
  // A new UI build reloads the window: the Update ready card, and a restart already waiting, come back as main has them.
  (api.restartState?.().then((s) => { if (s) ui.set({ updateReady: !!s.ready || !!s.waiting, updateWaiting: !!s.waiting }); }).catch(() => {}), () => {}),
  api.onChatsStatus?.((list) => chatStatus.set(list)) ?? (() => {}),
  api.onSessionsChanged?.(sessionsChanged) ?? (() => {}),
  api.onQuitPending?.(() => toast('Canopy will quit when your chats finish', {
    id: 'quit-pending', duration: Infinity, action: { label: 'Don’t quit', onClick: () => api.quitCancel?.() },
  })) ?? (() => {}),
  // A reload starts with an empty list: ask for the current one (a long workflow may not change for minutes).
  (api.chatsList?.().then((l) => { if (Array.isArray(l)) chatStatus.set(l as Parameters<typeof chatStatus.set>[0]); }).catch(() => {}), () => {}), // even empty: a restart check runs on it (lib/chats)
  api.onChatsFocus?.((to) => { if (to.cwd) window.dispatchEvent(new CustomEvent('canopy:open-chat', { detail: to })); }) ?? (() => {}),
  // Codex chats another app has open (lib/held): what main knows now, and every change after.
  api.onHeldChats?.((h) => heldChats.set(h)) ?? (() => {}),
  (api.heldChats?.().then((h) => heldChats.set(h)).catch(() => {}), () => {}),
  api.onChatDone?.(() => playDone()) ?? (() => {}),
  // A chat's first message was edited, so its conversation started over under a new id: its pin and its place in
  // your own order go with it (the old id is never listed again).
  api.onEvent((ev) => { if (ev.kind === 'meta' && typeof ev.supersedes === 'string' && typeof ev.sessionId === 'string') { repin(ev.supersedes, ev.sessionId); reorderAs(ev.supersedes, ev.sessionId); sessionsChanged(); } }),
  api.onNewChat?.(() => window.dispatchEvent(new Event('canopy:new-session'))) ?? (() => {}),
  // Claude Code upkeep: model picker fixups, and a quiet word when Canopy updated Claude Code for you.
  startUpkeep(() => store.refreshModels()),
  // Canopy's own updates: what is ready or required, and a quiet word after one went in.
  startAppUpdate(),
  // The model picker's rows for both makers (main keeps them; this follows its "a list changed").
  startModels(),
  // New models: a card in the sidebar when a maker ships one, and "New" beside it in Settings > Models.
  startReleases(),
  // The logins Canopy found for each maker (main keeps them; this follows its changes).
  startAccounts(),
  // A sign-in that is open, and the one question asked at launch: is anything signed out?
  startSignIn(),
  // Usage stats: where they stand, the panels counted as they open, and the one-time notice about them.
  startTelemetry(), startUsageNotice(),
  () => window.removeEventListener('error', onWindowError),
];

// Context usage is available shortly after Claude Code starts; retry briefly until it is. Each chat's last reading is
// kept, so switching back shows its ring at once (then refreshes) instead of the ring blinking out for a moment.
// Kept for the window's life, through reloads too (sessionStorage).
const ctxSeen = new Map<string, { ctx: number; ctxTokens: number; ctxMax: number }>((() => { try { return JSON.parse(sessionStorage.getItem('canopy.ctx') ?? '[]'); } catch { return []; } })());
const keepCtx = () => { try { sessionStorage.setItem('canopy.ctx', JSON.stringify([...ctxSeen].slice(-50))); } catch { /* full: skip */ } };
function ctxFromBefore(sessionId: string | null | undefined) { const v = sessionId ? ctxSeen.get(sessionId) : undefined; if (v) store.setMeta(v); }
function fetchCtx(tries: number) {
  api.context().then((c) => {
    if (c) {
      const v = { ctx: c.percentage, ctxTokens: c.totalTokens, ctxMax: c.maxTokens };
      store.noteContext(c); // the ring, and the plan's limits when the reading carries them
      if (store.meta.sessionId) { ctxSeen.delete(store.meta.sessionId); ctxSeen.set(store.meta.sessionId, v); keepCtx(); }
    }
    else if (tries > 0) setTimeout(() => fetchCtx(tries - 1), 700);
  });
}

export default function App() {
  const [view, setView] = useState<View>({ name: 'loading' });
  const [launchEnv, setEnv] = useState<EnvInfo | null>(null);
  // What the launch's check said about Claude Code's sign-in goes stale the moment you sign in or out. The accounts
  // list is kept current, so wherever the two differ the list is right.
  const accounts = useAccounts();
  // Your Canopy account (Google): its name and photo stand in for the Mac's name and initials wherever you're shown.
  const me = useCanopyAccount();
  const [firstRun, firstRunDone] = useFirstRun();
  const env = useMemo(() => (launchEnv ? { ...launchEnv, auth: authFrom(launchEnv.auth, accounts) } : null), [launchEnv, accounts]);
  const [cwd, setCwd] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [files, setFiles] = useState<string[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAt, setSettingsAt] = useState<string | undefined>();
  useEffect(() => {
    const on = (e: Event) => { setSettingsAt((e as CustomEvent<string | undefined>).detail); setSettingsOpen(true); };
    window.addEventListener('canopy:settings', on);
    return () => window.removeEventListener('canopy:settings', on);
  }, []);
  const { meta, items } = useStore();
  const { sidebar, inspector, view: mainView, multi } = useUi();
  const [multiMounted, setMultiMounted] = useState(multi);
  const [switchingMode, setSwitchingMode] = useState(false);
  useEffect(() => {
    if (!switchingMode) return;
    // Commit the new widths once; animating them rewraps every transcript on every frame.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setSwitchingMode(false)); });
    return () => cancelAnimationFrame(frame);
  }, [switchingMode, multi]);
  const pane = useMultiInfo(); // Multi mode: the focused pane's chat
  // Toasts centre over the conversation, not the whole window (the sidebar takes the left of it).
  // Sheets centre beside the sidebar; during the first run there's no sidebar to make room for.
  useEffect(() => { document.documentElement.style.setProperty('--canopy-sidebar', `${firstRun ? 0 : sidebar ? SIDEBAR_FULL : SIDEBAR_RAIL}px`); }, [sidebar, firstRun]);
  // While the first run is up, sheets opened from it (Claude Code's or Codex's sign-in) wear its look (index.css).
  useEffect(() => { if (firstRun) document.documentElement.dataset.firstRun = ''; else delete document.documentElement.dataset.firstRun; }, [firstRun]);
  const [rechecking, setRechecking] = useState(false);
  // Bumped whenever a different chat is opened. Keys the transcript so its local state (paging,
  // scroll, folds) resets per chat, without remounting when a new chat receives its id mid-turn.
  const [chatEpoch, setChatEpoch] = useState(0);
  const [opening, setOpening] = useState<string | null>(null); // the saved chat being switched to (the sidebar marks it at once)

  // The side panel stays mounted until its slide-out finishes (lib/panel-mount.ts).
  const [panelMounted, panelShown] = usePanelMount(inspector);

  const refresh = useCallback(async () => {
    const [list, projects] = await Promise.all([api.listSessions(), api.listProjects()]);
    // Names in Title Case (main does it too; this covers a main still running from before it learned to).
    if (Array.isArray(list)) { rememberEngines(list); setSessions(list.map((s) => (s.named === false ? s : { ...s, title: titleCase(s.title) }))); }
    if (Array.isArray(projects)) setSaved(projects);
  }, []);
  useEffect(() => {
    const on = () => refresh();
    window.addEventListener('canopy:sessions-changed', on);
    return () => window.removeEventListener('canopy:sessions-changed', on);
  }, [refresh]);

  const chatsDir = env?.chatsDir ?? null;
  const inProject = !!cwd && cwd !== chatsDir;
  const chats: Project | null = useMemo(() => chatsDir
    ? { dir: chatsDir, updated: 0, sessions: sessions.filter((s) => s.cwd === chatsDir).sort((a, b) => b.updated - a.updated) }
    : null, [sessions, chatsDir]);

  const projects: Project[] = useMemo(() => groupProjects(sessions, saved, cwd, chatsDir), [sessions, saved, cwd, chatsDir]);

  // The open that owns the screen: the folder it is in, the maker it was asked for, and whether it failed to come up
  // (asking again is then a retry). A ref, because openSession is a stable callback and would only ever see stale state.
  const here = useRef<{ dir: string; failed: boolean; asked: Engine } | null>(null);

  // `swap`: the other maker's model was picked, so main may let go of the chat that was on screen if it was never used.
  // `move`: it was picked in a started chat, so the new chat carries on from that one (lib/move.ts). The chat you are
  // in stays on screen until the new one is ready, and stays for good if the move is refused.
  const openSession = useCallback(async (dir: string, resumeId: string | null, opts: { force?: boolean; swap?: boolean; move?: Move; back?: Back; stay?: boolean } = {}) => {
    // Opening any chat leaves Home, at the moment the chat is in place (never via the chat you were in before), except
    // the one opened at launch (`stay`): it waits behind Home, which every launch opens on.
    const toChat = () => { if (!opts.stay && ui.get().view !== 'chat') ui.set({ view: 'chat' }); };
    // A saved chat keeps the engine it started on; a new one starts on the maker whose model you picked last.
    const asked = expectedEngine(resumeId);
    // Already in that chat (or still opening it), or on an untouched new chat in that folder: there is nothing
    // to restart, so just put the cursor in the composer. Two cases reopen anyway: `force` (back from the
    // terminal, where the chat moved on without us) and a live terminal (it paused this chat; reopening resumes it).
    const at = here.current;
    if (!opts.force && at?.dir === dir && !at.failed && !ui.get().terminalLive) {
      const m = store.meta;
      if (resumeId ? resumeId === m.sessionId : at.asked === asked && !m.sessionId && !m.busy && !store.items.some(isContent)) {
        toChat();
        requestAnimationFrame(() => window.dispatchEvent(new Event('canopy:focus-composer')));
        return;
      }
    }
    // Parallel chats: switching never stops the chat you leave. It keeps working, and the sidebar shows its state.
    ui.set({ terminalLive: false });
    held.evs = []; // events wait until this chat's conversation is in place
    const mine = { dir, failed: false, asked };
    here.current = mine;
    // Switching to a saved chat: the one you're in stays on screen until the next is ready, then everything (transcript,
    // title, message box) changes in one frame. No blank in between, no controls showing defaults. The sidebar marks
    // the chat you clicked right away. Only an open that takes long (a cold start, a very long chat) shows the loading
    // view meanwhile. A new chat has nothing to wait for: its empty screen shows at once.
    setOpening(resumeId);
    let entered = false;
    const enter = (loading: boolean) => {
      if (entered) return;
      entered = true;
      toChat();
      // A new chat starts with your permission mode: the message box never shows the default for a frame.
      const mode = choices.mode ?? store.meta.mode;
      setCwd((prev) => {
        if (prev !== dir) { setFiles(null); api.listFiles(dir).then((f) => { if (Array.isArray(f)) setFiles(f); }); }
        return dir;
      });
      setView({ name: 'main' });
      setChatEpoch((n) => n + 1);
      store.reset();
      store.setEngine(asked); // the chip shows the right maker while the chat opens; the reply has the last word
      store.setMeta({ loading, sessionId: resumeId, mode });
    };
    const slow = resumeId ? setTimeout(() => { if (here.current === mine) enter(true); }, 220) : undefined;
    if (!resumeId && !opts.move) enter(true);
    const switched = opts.move ?? opts.back; // the other maker's model was picked in a started chat
    const back = resumeId && opts.back && opts.back.from !== resumeId ? { from: opts.back.from, fromModel: opts.back.fromModel, toModel: opts.back.toModel } : undefined;
    const ask: OpenOpts = { ...(!resumeId && asked === 'codex' && { engine: asked }), ...(opts.swap && { replaceEmpty: true }), ...(!resumeId && opts.move && { move: opts.move }), ...(back && { back }) };
    let r: Awaited<ReturnType<typeof api.open>>;
    try { r = await api.open(dir, resumeId, Object.keys(ask).length ? ask : undefined); } catch (err) { r = { error: String((err as Error)?.message ?? err) }; }
    clearTimeout(slow);
    if (here.current !== mine) return; // another chat was opened while this one loaded: the screen is its now
    setOpening(null);
    if (r?.error && switched) {
      // The move was refused (the chat started working meanwhile): nothing was opened, and you are still in the chat
      // you were in. What it said while this was asked is played now.
      here.current = at;
      const evs = held.evs ?? []; held.evs = null;
      for (const ev of evs) onChatEvent(ev);
      toast(r.error, { id: 'move-busy' });
      return;
    }
    if (r?.error) { enter(false); mine.failed = true; held.evs = null; store.setMeta({ loading: false }); store.addError(r.error); return; }
    const sid = (r as { sid?: string }).sid ?? null;
    chatStatus.setActive(sid);
    heldChats.note(resumeId, r.held); // open in another app: said at once, in place of the message box
    // Still running from before (maybe mid-reply): pick it up exactly where it is, with its own settings.
    const live = (r as { reused?: boolean; live?: LiveSession }).reused ? (r as { live?: LiveSession }).live : undefined;
    if (live) {
      toChat(); reattach({ ...live, sid: sid ?? undefined, engine: r.engine ?? live.engine }, asked);
      // Gone back to a session still open: it takes the model you picked, as a new chat would.
      if (opts.back) { applyChoices(store, r.engine ?? live.engine, r.defaults?.mode, null); window.dispatchEvent(new Event('canopy:moved')); }
      return;
    }
    enter(true);
    store.setMeta({ sessionId: resumeId, mode: choices.mode ?? r.defaults?.mode ?? null, accountId: r.accountId });
    ctxFromBefore(resumeId);
    // Your choices for the maker the chat really runs on. A chat gone back to takes the model you just picked.
    applyChoices(store, r.engine, r.defaults?.mode, resumeId && !opts.back ? r.history ?? [] : null);
    store.loadHistory(r.history ?? []);
    store.setMeta({ loading: false }); // only after the conversation is in place: no empty-screen flash
    release(sid); // what the chat said while it opened (its start-up notices) goes after its history
    fetchCtx(8);
    if (switched) window.dispatchEvent(new Event('canopy:moved')); // what you had typed follows you (lib/move.ts)
  }, []);

  const reattach = useCallback((live: LiveSession, asked: Engine = live.engine ?? 'claude') => {
    here.current = { dir: live.cwd, failed: false, asked };
    chatStatus.setActive(live.sid ?? null);
    store.reset();
    store.setEngine(live.engine);
    setChatEpoch((n) => n + 1);
    setCwd(live.cwd); setView({ name: 'main' });
    api.listFiles(live.cwd).then((f) => { if (Array.isArray(f)) setFiles(f); });
    const st = live.settings ?? {};
    store.setMeta({ sessionId: live.sessionId, mode: st.permissionMode ?? null, pick: st.model || null, busy: live.busy, fastPref: typeof st.fast === 'boolean' ? st.fast : null, codePref: st.codeMode === true, accountId: live.accountId });
    ctxFromBefore(live.sessionId);
    if (live.meta) store.handle(live.meta);
    store.loadHistory(live.history ?? []);
    for (const ev of live.pending ?? []) store.handle(ev);
    store.setQueue(live.queue, live.queueV); // what was waiting behind its turn when you left
    const tasks = (live as { tasks?: unknown[] }).tasks;
    if (Array.isArray(tasks)) store.setMeta({ tasks: tasks as never });
    release(live.sid, live.seq);
    fetchCtx(8);
  }, []);
  // An edit that didn't go through puts the chat back as the engine has it (Store.editFrom).
  useEffect(() => {
    store.reload = () => {
      held.evs = []; // what arrives while it loads waits, as in any open
      const back = api.snapshot ?? api.attach;
      back().then((live) => { if (live && !('error' in live)) reattach(live); else held.evs = null; }).catch(() => { held.evs = null; });
    };
    return () => { store.reload = null; };
  }, [reattach]);


  // Runs at launch (the view starts as 'loading') and again from the setup screens, which stay up while it
  // works: no trip back through the loading view. Resolves to the problem still in the way, or null once past setup.
  const boot = useCallback(async (hold = 0): Promise<Problem | null> => {
    // On launch and on ⌘R the Canopy logo stays up for at least `hold` ms, so a reload reads as one calm beat.
    const settle = () => new Promise((r) => setTimeout(r, Math.max(0, hold - performance.now())));
    const info = await api.init();
    setEnv(info);
    (window as unknown as { __home?: string }).__home = (info as { home?: string }).home;
    seedAccounts(info.accounts);
    // Only a definite "signed out" stops here, and only when no login has ever worked on this Mac: then there is
    // nothing to skip to. Otherwise the app opens and asks once, in a dialog you can dismiss (account-prompt.tsx);
    // history, Home, Settings and the other maker's chats all keep working. When Claude Code did not answer in time
    // (loggedIn null) the app opens too: a slow check must not lock a signed-in user out.
    const problem: Problem | null = info?.error ? 'error' : !info.claudePath ? 'missing' : info.auth?.loggedIn === false && !info.everSignedIn ? 'login' : null;
    if (problem) { await settle(); setView({ name: 'setup', problem, detail: info.error }); return problem; }
    refresh();
    const live = await api.attach();
    await settle();
    const start = info.lastFolder ?? info.chatsDir;
    if (live && !('error' in live) && live.cwd) reattach(live);
    else if (start) openSession(start, null, { stay: true });
    else setView({ name: 'welcome' });
    return null;
  }, [reattach, openSession, refresh]);

  useEffect(() => { boot(1000); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Setup screens check again in place: the button spins until the answer is in, one check at a time.
  // `still` is the problem a "Check again" click found unchanged, so the screen can say so.
  const [still, setStill] = useState<Problem | null>(null);
  const check = useRef({ busy: false, at: 0 });
  const recheck = useCallback(async () => {
    if (check.current.busy) return undefined;
    check.current.busy = true;
    setRechecking(true);
    try { await api.recheck(); return await boot(); }
    finally { check.current = { busy: false, at: Date.now() }; setRechecking(false); }
  }, [boot]);

  // Back from Terminal (installed, or signed in): look again without being asked, at most every 2s.
  const onSetup = view.name === 'setup';
  useEffect(() => {
    if (!onSetup) return;
    const onFocus = () => { if (Date.now() - check.current.at >= 2000) recheck(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onSetup, recheck]);

  const addProject = useCallback(async () => {
    (document.activeElement as HTMLElement | null)?.blur(); // no tooltip pops back up when the sheet closes
    const dir = await api.pickFolder();
    if (!dir) return;
    feature('project_added');
    await refresh();
    if (dir !== cwd) openSession(dir, null);
  }, [refresh, openSession, cwd]);

  // Multi mode: opening a chat (sidebar, ⌘K, Home, a notification) or starting one (⌘N, /clear) lands in a pane
  // (an empty one, else the focused one), and from Home it goes back to the panes.
  const inMulti = () => ui.get().multi;
  const openChat = useCallback((dir: string, id: string | null) => {
    if (id && (inMulti() || id !== store.meta.sessionId)) feature('chat_resumed'); // not a click on the chat you are in
    if (inMulti()) { ui.set({ view: 'chat' }); window.dispatchEvent(new CustomEvent('canopy:pane-open', { detail: { dir, id } })); return; }
    openSession(dir, id);
  }, [openSession]);
  const newSession = useCallback((dir?: string) => {
    feature('chat_new');
    if (inMulti()) { ui.set({ view: 'chat' }); window.dispatchEvent(new CustomEvent('canopy:pane-new', { detail: { dir } })); return; }
    const d = dir ?? cwd ?? chatsDir; if (d) openSession(d, null); else addProject();
  }, [cwd, chatsDir, openSession, addProject]);

  // The Multi mode toggle. On: the chat you're in comes along into a pane, the sidebar folds to its rail (it comes
  // back as it was) and the side panel closes. Off: the main screen shows the chat you were in.
  const toggleMulti = useCallback(() => {
    setSwitchingMode(true);
    if (!ui.get().multi) {
      setMultiMounted(true);
      localStorage.setItem('canopy.multi.sidebar', JSON.stringify(ui.get().sidebar));
      if (ui.get().view === 'chat') seedMulti(cwd, store.meta.sessionId);
      ui.set({ multi: true, sidebar: false, inspector: false, view: 'chat' });
      return;
    }
    let side = true; try { side = JSON.parse(localStorage.getItem('canopy.multi.sidebar') ?? 'true'); } catch { /* default */ }
    const to = focusedPaneChat();
    ui.set({ multi: false, sidebar: side });
    if (to?.cwd) openSession(to.cwd, to.sessionId);
  }, [openSession, cwd]);

  // A chat dragged from the sidebar onto the chat area (one chat on screen): Multi mode, with the chat you're in on the
  // left and the dragged one beside it. Onto a pane, Multi mode places it itself (multi-view.tsx).
  const [sideBySide, setSideBySide] = useState(false);
  const dropChat = useCallback((chat: DraggedChat) => {
    setSideBySide(false);
    const here = ui.get().view === 'chat' ? store.meta.sessionId : null;
    if (chat.id === here) return;
    feature('chat_resumed');
    setSwitchingMode(true);
    setMultiMounted(true);
    localStorage.setItem('canopy.multi.sidebar', JSON.stringify(ui.get().sidebar));
    seedMulti(here ? cwd : null, here, { cwd: chat.dir, sessionId: chat.id });
    ui.set({ multi: true, sidebar: false, inspector: false, view: 'chat' });
  }, [cwd]);
  useEffect(() => {
    const clear = () => setSideBySide(false);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  // Projects dragged into a new order: shown at once, then saved.
  const reorderProjects = useCallback((dirs: string[]) => {
    setSaved(dirs);
    api.reorderProjects?.(dirs).then((p) => { if (Array.isArray(p)) setSaved(p); }).catch(() => refresh());
  }, [refresh]);
  const closeProject = useCallback(async (dir: string) => {
    await api.removeProject(dir);
    await refresh();
    if (dir === cwd && chatsDir) openSession(chatsDir, null);
  }, [cwd, chatsDir, refresh, openSession]);

  // The other maker's model was picked (controls.tsx): a chat of that maker, here. A chat that had not started is
  // swapped where it stands, so nothing changes but the chip. A started one is moved: on screen it stays the same chat
  // (one row, one transcript), carried on by a new session of that maker (`move`), or by the one that maker already
  // has in it (`back`). In Multi mode the pane you are in does the same (multi-view.tsx).
  useEffect(() => {
    const on = (e: Event) => {
      if (inMulti() || !cwd) return;
      const d = (e as CustomEvent<{ move?: Move; back?: Back } | undefined>).detail;
      // Back to the session that maker already has in this chat's thread, else a new chat that carries on.
      if (d?.back) openSession(cwd, d.back.to, { force: true, swap: true, back: d.back });
      else openSession(cwd, null, { force: true, swap: true, move: d?.move });
    };
    window.addEventListener('canopy:other-maker', on);
    return () => window.removeEventListener('canopy:other-maker', on);
  }, [cwd, openSession]);

  // A notification was clicked: open that chat (it's still live, so this is instant).
  useEffect(() => {
    const on = (e: Event) => { const to = (e as CustomEvent<{ sessionId: string | null; cwd: string }>).detail; openChat(to.cwd, to.sessionId); };
    window.addEventListener('canopy:open-chat', on);
    return () => window.removeEventListener('canopy:open-chat', on);
  }, [openChat]);

  // A new chat was asked for from elsewhere (/clear, the menu bar's New Chat).
  useEffect(() => {
    const onNew = () => newSession();
    window.addEventListener('canopy:new-session', onNew);
    return () => window.removeEventListener('canopy:new-session', onNew);
  }, [newSession]);

  // Esc closes the right panel first, even while Claude works (the composer leaves Esc alone while the panel is open);
  // with the panel closed, Esc is the stop key again. Menus, dialogs and the terminal keep their own Esc.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !ui.get().inspector) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('.xterm')) return; // Esc belongs to the terminal there
      ui.set({ inspector: false });
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, []);

  // Keyboard shortcuts (lib/app-shortcuts.ts). Only in the app itself: the loading, setup and welcome screens have none.
  const inApp = view.name === 'main';
  useAppShortcuts({ inApp, newSession, toggleMulti, setSettingsOpen });

  // The title bar names the chat you're in: in Multi mode, the focused pane's.
  const inPanes = multi && mainView === 'chat';
  const current = sessions.find((s) => s.id === (inPanes ? pane.sessionId : meta.sessionId));
  // A chat that was moved here from the other maker has the old chat's name from the start (its "Continued from" line).
  const movedFrom = items.find((i): i is HandoffItem => i.t === 'handoff' && i.ev.dir === 'from')?.ev as { chat?: { title?: string } } | undefined;
  // One title change per new chat: "New chat" until Claude Code has named it, then its name (no interim
  // "first words of your message" title that gets replaced a moment later).
  const title = current?.title ?? movedFrom?.chat?.title ?? 'New chat';
  // A new chat's title is your first message until it gets a real name (Claude Code's summary, or Canopy's titler after
  // the first reply). Meanwhile the title bar shows a spinner, not a long prompt. If no name comes within 30 s of the
  // reply ending (the titler skipped it or failed), the first message stands.
  const [nameWait, setNameWait] = useState(true);
  useEffect(() => {
    setNameWait(true);
    if (meta.busy) return;
    const t = setTimeout(() => setNameWait(false), 30_000);
    return () => clearTimeout(t);
  }, [meta.busy, meta.sessionId]);
  const asked = items.filter((i) => i.t === 'user').length;
  // Before the chat is even listed it has no title at all ("New chat"): that wait gets the spinner too.
  const naming = nameWait && asked === 1 && (!current || current.named === false) && !movedFrom;

  let body: React.ReactNode;
  if (view.name === 'loading') {
    body = <LoadingScreen />;
  } else if (view.name === 'setup') {
    const { problem } = view;
    const check = async () => {
      if (rechecking) return;
      setStill(null);
      const left = await recheck();
      setStill(left === problem ? left : null);
    };
    body = <SetupScreen problem={problem} detail={view.detail} rechecking={rechecking} still={still} onCheck={check} />;
  } else if (view.name === 'welcome') {
    body = <WelcomeScreen onPick={addProject} />;
  } else {
    // Only real content counts; startup hook output doesn't. New chats skip the loading state entirely. A chat that
    // was moved here is not an empty one, even before its first message: it opens on its "Continued from" line.
    const empty = !items.some(isContent) && !movedFrom && (!meta.loading || !meta.sessionId);
    const panelOpen = inspector && panelShown && mainView === 'chat' && !multi;
    const showMulti = inPanes;
    const paneProject = pane.cwd && pane.cwd !== chatsDir ? projectName(pane.cwd) : null;
    const barTitle = mainView === 'home' ? 'Home' : showMulti ? (pane.cwd ? current?.title ?? (pane.sessionId ? 'Chat' : 'New chat') : '') : empty ? 'New chat' : title;
    if (mainView === 'playground' && api.dev) body = <div className="flex h-full flex-col"><TitleBar title="Playground" project={null} /><Suspense fallback={null}><Playground /></Suspense></div>;
    else body = (
      <div className="flex h-full flex-col">
        <TitleBar title={barTitle} naming={!showMulti && mainView !== 'home' && !empty && naming} project={mainView === 'home' ? null : showMulti ? paneProject : inProject ? projectName(cwd) : null}
          onRename={mainView !== 'home' && !showMulti && meta.sessionId ? async (t) => { await api.rename(meta.sessionId!, t, cwd ?? undefined); refresh(); } : undefined}
          onToggleMulti={toggleMulti}
          projects={mainView === 'chat' && !showMulti ? { dirs: projects.map((p) => p.dir), current: cwd, chatsDir, empty, onPick: (d) => newSession(d), onAdd: addProject } : undefined} />
        <div className="relative flex min-h-0 flex-1">
          {/* Sidebar collapse = ONE animation: this wrapper's width (it clips the fixed-width aside).
              <main> is flex-1 and fills the rest every frame, so both of its edges stay put and centred
              content glides. Don't replace this with a transform "curtain": <main>'s width changes too,
              so a transform makes centred content jump backwards first (measured frame by frame). */}
          <div className={cn('relative h-full shrink-0 overflow-hidden duration-260 ease-pane motion-reduce:transition-none', switchingMode ? 'transition-none' : 'transition-[width]')} style={{ width: sidebar ? SIDEBAR_FULL : SIDEBAR_RAIL }}>
            <Sidebar collapsed={!sidebar} home={mainView === 'home'} onHome={() => ui.set({ view: 'home' })} projects={projects} chats={chats} activeId={mainView === 'home' ? null : showMulti ? pane.sessionId : opening ?? meta.sessionId} activeDir={showMulti ? (pane.cwd !== chatsDir ? pane.cwd : null) : inProject ? cwd : null} account={{ name: me?.name || env?.userName || '', photo: me?.avatar ?? null }} healthy={!!env?.claudePath && env?.auth?.loggedIn !== false}
              onNew={newSession} onSearch={() => ui.set({ palette: true })} onOpen={(d, id) => openChat(d, id)}
              onAddProject={addProject} onRemoveProject={closeProject} onReorderProjects={reorderProjects} onSettings={() => setSettingsOpen(true)} />
          </div>
          <main className="@container/main relative z-30 flex min-w-0 flex-1 flex-col overflow-hidden border-l border-sidebar-border bg-background [contain:layout_paint]"
            onDragOver={(e) => { if (showMulti || !carriesChat(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!sideBySide) setSideBySide(true); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSideBySide(false); }}
            onDrop={(e) => { if (showMulti) return; const chat = draggedChat(e.dataTransfer); if (!chat) return; e.preventDefault(); dropChat(chat); }}>
            {/* Where a dragged chat will go: the right half, beside the chat you're in. */}
            {sideBySide && !showMulti && (
              <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-50 w-1/2 p-2 enter-fade [animation-duration:120ms]">
                <div className="flex size-full items-center justify-center rounded-lg border-2 border-dashed border-foreground/25 bg-background/70 text-ui text-muted-foreground">Open side by side</div>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Keep both layouts ready: switching modes must not rebuild transcripts or reload chat histories. */}
              {(multi || (multiMounted && api.pane?.keepAlive === true)) && <div data-chat-view="multi" className={cn('flex min-h-0 flex-1 flex-col', !showMulti && 'hidden')} inert={!showMulti}><MultiView sessions={sessions} chatsDir={chatsDir} active={showMulti} /></div>}
              {mainView === 'home' && !showMulti && <HomeView recents={sessions.filter((s) => s.cwd).map((s) => ({ ...s, dir: s.cwd! })).sort((a, b) => b.updated - a.updated)} chatsDir={chatsDir} userName={me?.name || env?.userName || ''} />}
              <div data-chat-view="main" className={cn('flex min-h-0 flex-1 flex-col', (showMulti || mainView === 'home') && 'hidden')} inert={showMulti || mainView === 'home'}>
                <PaneContext.Provider value={{ multi: false, focused: !showMulti && mainView === 'chat' }}>
                  {empty ? <EmptyState files={files} cwd={cwd} />
                  // Opening a saved chat: the mark only fades in if loading is slow (300ms), so a quick one shows no flash.
                  : meta.loading ? <><div className="flex flex-1 items-center justify-center"><div className="enter-fade [animation-delay:300ms] [animation-duration:400ms]"><Logo className="breathe size-8 text-brand" /></div></div><Composer files={files} cwd={cwd} /></>
                  : <><Transcript key={chatEpoch} /><Composer files={files} cwd={cwd} /></>}
                </PaneContext.Provider>
              </div>
            </div>
          </main>
          {/* The right panel slides OVER the chat (the conversation never moves or rewraps) and is the left sidebar's
              width. Contents mount first, then it slides (see panelShown), so building it never lands in the motion. */}
          <div className={cn('absolute top-0 right-0 bottom-0 z-40 border-l border-sidebar-border bg-sidebar-solid shadow-[-12px_0_32px_-16px_rgb(0_0_0/0.35)] transition-transform duration-240 ease-drawer will-change-transform motion-reduce:transition-none',
            panelOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full shadow-none')} style={{ width: SIDEBAR_FULL }} inert={!panelOpen}>
            {cwd && panelMounted && <Inspector cwd={cwd} onTerminalDone={(id) => openSession(cwd, id ?? store.meta.sessionId, { force: true })} />}
          </div>
        </div>
        <Palette projects={chats ? [...projects, chats] : projects} chatsDir={chatsDir} onNew={newSession} onOpen={(d, id) => openChat(d, id)} onAddProject={addProject} onSettings={() => setSettingsOpen(true)} />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={200}>
      {body}
      <RestartDialog />
      <AccountPrompt active={view.name === 'main' && !firstRun} />
      <SignInSheet />
      <SettingsDialog open={settingsOpen} onOpenChange={(o) => { setSettingsOpen(o); if (!o) setSettingsAt(undefined); }} env={env} initial={settingsAt} />
      {/* After Settings, so it opens on top of it: the sign-in is usually asked for from there. */}
      <CodexSignInSheet />
      <Toaster position="top-center" offset={52} />
      {/* over everything: this version may no longer be used (see update-required.tsx) */}
      <UpdateRequired />
      {/* the first run: once, over the app (see useFirstRun) */}
      {firstRun && <FirstRun design={new URLSearchParams(location.search).has('mock')} onDone={firstRunDone} />}
    </TooltipProvider>
  );
}

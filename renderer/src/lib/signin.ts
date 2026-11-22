// Signing in again, window side: the sign-in that is open (main runs it, src/signin-ipc.mjs), the prompt shown once
// per launch, and the calls behind every "Sign in…" button. What a login needs is worked out in account-rules.ts;
// this file only keeps what is on screen.
//
// Canopy has no sign-in field of its own. The sheet (components/canopy/signin-sheet.tsx) is a terminal showing
// Claude Code's own sign-in: what it prints and what you type go between that terminal and Claude Code, and are
// never kept here. Codex's sign-in is Codex's own, in the browser (lib/codex-login.ts): `openSignIn` hands a
// Codex account to it, so whatever offers "Sign in…" calls one function.
import { useContext, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { chooseAccount, seedAccounts, useAccounts } from './accounts';
import { chatAccount, troubleFor, troubles, type Trouble } from './account-rules';
import { api, type Account, type Engine, type SignInState } from './api';
import { signInToCodex } from './codex-login';
import { StoreContext } from './store';
import { ui } from './ui';

type Snapshot = {
  /** The sign-in the sheet shows. It stays after it is done, until the sheet is closed. */
  run: SignInState | null;
  /** The maker the launch prompt is asking about, or null. */
  asking: Engine | null;
  /** When a sign-in last went through, per maker: a notice older than that has been answered. */
  signedInAt: Partial<Record<Engine, number>>;
};

let state: Snapshot = { run: null, asking: null, signedInAt: {} };
const subs = new Set<() => void>();
function set(patch: Partial<Snapshot>) {
  state = { ...state, ...patch };
  for (const f of subs) f();
}

export function useSignIn(): Snapshot {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state);
}
/** The same, outside React: called now and on every change. Returns the unsubscribe. */
export function watchSignIn(cb: (s: Snapshot) => void): () => void {
  const f = () => cb(state);
  subs.add(f);
  f();
  return () => { subs.delete(f); };
}
/** What stands between this maker's new chats and their first message, kept current. Null when nothing does. */
export function useTrouble(engine: Engine): Trouble | null {
  return troubleFor(useAccounts(), engine);
}
/**
 * The same for the chat this part of the screen shows, by the account that chat is on: a chat keeps the account it
 * started on, so one chat can be held up while a new one is not. `account`: the chat's account, when it is listed.
 * `fresh`: nobody has used the chat yet, so it moves when another account is chosen for new chats.
 */
export function useChatTrouble(): { engine: Engine; trouble: Trouble | null; account: Account | null; fresh: boolean } {
  const s = useContext(StoreContext);
  const engine = useSyncExternalStore(s.subscribe, () => s.meta.engine);
  const pin = useSyncExternalStore(s.subscribe, () => s.meta.accountId);
  const fresh = useSyncExternalStore(s.subscribe, () => !s.meta.sessionId && !s.meta.busy);
  const accounts = useAccounts();
  return { engine, trouble: troubleFor(accounts, engine, pin), account: chatAccount(accounts, engine, pin), fresh };
}

// The makers still to ask about at launch. Each is asked once, one dialog at a time. (The prompt itself moves on
// from a maker whose account has been fixed meanwhile: see account-prompt.tsx.)
let toAsk: Engine[] = [];
const askNext = () => set({ asking: toAsk.shift() ?? null });

/** Follow main's sign-in, and ask it the launch's one question. Returns the unsubscribe, like the window's other listeners. */
export function startSignIn(): () => void {
  // Main answers once its own check at launch is in, and says `first` only the first time: a reloaded window
  // does not ask again.
  api.signin?.startCheck().then((r) => {
    if (!r || 'error' in r || !r.accounts) return;
    seedAccounts(r.accounts);
    if (!r.first) return;
    toAsk = troubles(r.accounts).map((t) => t.engine);
    askNext();
  }).catch(() => {});
  return api.signin?.onState((run) => {
    if (run.phase === 'closed') { if (state.run?.id === run.id) set({ run: null }); return; }
    if (run.phase === 'done') set({ run, signedInAt: { ...state.signedInAt, [run.engine]: Date.now() } });
    else set({ run });
  }) ?? (() => {});
}

/** The launch prompt was answered (Sign in…, Use another account, Not now): it does not come back this launch. */
export function answerPrompt() {
  if (state.asking) askNext();
}

/**
 * Open the maker's sign-in: for `account`, or for the login the tool keeps on its own when none is named.
 * The sheet opens when main says the sign-in is ready. Codex has one login and its own sheet (codex-signin.tsx).
 */
export async function openSignIn(engine: Engine, account?: Pick<Account, 'id'> | null) {
  if (engine === 'codex') { await signInToCodex(); return; }
  if (!api.signin) return;
  let r: Awaited<ReturnType<NonNullable<typeof api.signin>['begin']>>;
  try { r = await api.signin.begin({ engine, accountId: account?.id ?? null }); } catch (err) { r = { ok: false, message: String((err as Error)?.message ?? err) }; }
  if (r?.ok || r?.code === 'busy') return; // open, or already open
  toast.error('Couldn’t start the sign-in', { description: r?.message ?? r?.error ?? undefined });
}

/** Close the sheet. A sign-in still running is stopped. */
export function closeSignIn() {
  const run = state.run;
  if (!run) return;
  set({ run: null });
  if (run.phase !== 'done') api.signin?.cancel(run.id).catch(() => {});
}

/**
 * New chats use another account of the same maker: the same switch as "Use" on an account in Settings (main decides,
 * src/account-actions.mjs). An open chat keeps the account it started on; one nobody has used yet moves with the
 * switch, in main, which then says so to the window (the chat's `accountId`).
 */
export async function switchTo(engine: Engine, account: Pick<Account, 'id' | 'label'>) {
  const r = await chooseAccount(engine, account.id);
  if (!r.ok) toast.error(`Couldn’t switch to ${account.label}`, { description: r.message });
}

/**
 * A maker's accounts in Settings, where an account's own actions are: they lead the maker's own page (Claude Code,
 * Codex), so that page is what opens.
 */
export const openAccounts = (engine: Engine) => ui.openSettings(engine === 'codex' ? 'codex' : 'claude');

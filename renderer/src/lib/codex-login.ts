// Signing in to Codex, window side: how the sign-in stands as main says it (src/core/accounts-codex-login.mjs),
// kept current, and the things a user can ask for. Any part of the window that offers the sign-in calls
// `signInToCodex()`; the sheet (components/canopy/codex-signin.tsx) shows itself from this state, wherever it was
// asked for. The rules for what is shown are in lib/codex-login-rules.ts.
//
// Nothing here throws. A call that fails leaves the last state in place and says so in one quiet line.
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api, type CodexLogin, type CodexLoginReply } from './api';

let state: CodexLogin | null = null;
let seen = -1; // main's count for the state on screen (see `rev` in src/accounts-codex-ipc.mjs)
let following = false;
const subs = new Set<() => void>();

// Main's reply carries the state and, beside it, how the call went. Only the state is kept.
function set(r: CodexLoginReply | null | undefined) {
  if (!r || 'error' in r || typeof r.phase !== 'string') return; // a failed read leaves the last state in place
  // An answer main gave before its latest word, arriving after it: what is on screen is newer.
  if (typeof r.rev === 'number') { if (r.rev < seen) return; seen = r.rev; }
  state = {
    phase: r.phase, message: r.message ?? null, detail: r.detail ?? null,
    installed: r.installed === true, signedIn: r.signedIn ?? null, canSignIn: r.canSignIn === true, signingOut: r.signingOut === true,
  };
  for (const f of subs) f();
}
const read = () => { api.codexLogin?.state().then(set).catch(() => {}); };

// Read once and follow main, from the first time anything on screen needs it. Whether Codex is signed in changes
// with the list of accounts (main works it out from there), so it is read again whenever that list changes.
function follow() {
  if (following) return;
  following = true;
  read();
  api.codexLogin?.onChanged(set);
  api.accounts?.onChanged(read);
}

/** How the sign-in to Codex stands, kept current. Null until main has answered (and on a build without it). */
export function useCodexLogin(): CodexLogin | null {
  return useSyncExternalStore((cb) => { follow(); subs.add(cb); return () => { subs.delete(cb); }; }, () => state);
}

const said = (r: { error?: string } | null | undefined, fallback: string) => { if (r?.error) toast(fallback); };

/** Start Codex's own sign-in: main asks Codex who is signed in, then opens OpenAI's page in the browser. The sheet follows. */
export async function signInToCodex(): Promise<void> {
  try {
    const r = await api.codexLogin?.start();
    set(r);
    if (r?.code === 'not-installed') toast('Codex isn’t installed on this Mac.');
    else said(r, 'The sign-in could not be started.');
  } catch { toast('The sign-in could not be started.'); }
}

/** Call the sign-in off. */
export async function cancelCodexSignIn(): Promise<void> {
  try { set(await api.codexLogin?.cancel()); } catch { /* the sheet stays; Cancel can be pressed again */ }
}

/** Open OpenAI's page again, for a tab that was closed. */
export async function reopenCodexSignIn(): Promise<void> {
  try {
    const r = await api.codexLogin?.reopen();
    set(r);
    if (r && !r.ok) toast('The page could not be opened again.');
  } catch { toast('The page could not be opened again.'); }
}

/** Put the sheet away once the sign-in is over. */
export async function dismissCodexSignIn(): Promise<void> {
  try { set(await api.codexLogin?.dismiss()); } catch { /* nothing to do */ }
}

/**
 * Sign Codex out on this Mac. Call it only from the confirmation that says what that means: `true` is that
 * confirmation, and main does nothing without it. Resolves to whether Codex was signed out.
 */
export async function signOutOfCodex(): Promise<boolean> {
  try {
    const r = await api.codexLogin?.signOut(true);
    if (r?.ok) return true;
    toast(r?.message ?? 'Codex could not be signed out.');
  } catch { toast('Codex could not be signed out.'); }
  return false;
}

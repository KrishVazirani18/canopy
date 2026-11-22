// Signing in to Codex, on screen: the sheet, and the confirmation before signing out. (The row that says Codex has
// nobody signed in is with the accounts on the Codex page of Settings, accounts-section.tsx.)
//
// The sheet is drawn once, at the top of the app, and shows itself from main's state (lib/codex-login.ts): whoever
// offers the sign-in only calls `signInToCodex()`. It has no field of its own. The sign-in is Codex's, on OpenAI's
// page in the browser; the sheet says the page is open, waits, and says how it ended. It is built from the same
// parts as Claude Code's sheet (signin-sheet.tsx): the maker's mark over the title and one line, an inset line that
// says what it is waiting on, and the buttons across the bottom.
//
// Signing out is one item in the account row's menu (account-actions.tsx), behind a confirmation that says what
// it means: Codex has one login for this Mac, so it is signed out in the terminal too. The sign-in on a row that
// needs one is the same button every account gets (account-prompt.tsx `RowSignIn`).
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { accountInUse, useAccounts } from '@/lib/accounts';
import { cancelCodexSignIn, dismissCodexSignIn, reopenCodexSignIn, signInToCodex, signOutOfCodex, useCodexLogin } from '@/lib/codex-login';
import { signInSheet } from '@/lib/codex-login-rules';
import { cn } from '@/lib/utils';
import { ProviderLogo } from './provider-logo';
import { SheetTop, sheetBox, sheetLink, sheetPrimary, sheetSecondary, sheetWell } from './signin-sheet';

// The way out of a question, as in Canopy's other small dialogs (restart-dialog.tsx): quiet words on the left.
const quiet = 'flex h-8 items-center justify-center rounded-lg px-3.5 text-ui text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60';

/** The sign-in sheet. Draw it once, above everything else: it is only on screen while a sign-in is, or has just ended. */
export function CodexSignInSheet() {
  const login = useCodexLogin();
  const account = accountInUse(useAccounts(), 'codex');
  const now = useMemo(() => signInSheet(login, account), [login, account?.label, account?.email]);
  // The last sheet stays drawn while the dialog animates out.
  const [last, setLast] = useState(now);
  useEffect(() => { if (now) setLast(now); }, [now]);
  const sheet = now ?? last;
  if (!sheet) return null;

  // While the sign-in is under way the sheet stays put: you come back from the browser by clicking on Canopy, and
  // that click must not call the sign-in off. Escape still cancels, as Cancel does.
  const underWay = !!now && !now.close;
  const close = () => { if (now?.cancel) cancelCodexSignIn(); else if (now?.close) dismissCodexSignIn(); };

  return (
    <Dialog open={!!now} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => { if (underWay) e.preventDefault(); }}
        className={cn(sheetBox, 'w-[420px]')}>
        {/* How it ended is in the words: a check before the title, or the one amber dot before what went wrong. */}
        <SheetTop engine="codex" mark={sheet.signedIn ? 'done' : !sheet.waiting ? 'trouble' : undefined} title={sheet.title}>{sheet.line}</SheetTop>
        {sheet.detail && <p className="mt-2 shrink-0 text-center text-small break-words text-faint">{sheet.detail}</p>}

        {/* Under way: one inset line says what the sheet is waiting on, with the way back to the page beside it. */}
        {sheet.waiting && (
          <div className={cn(sheetWell, 'mt-5 flex min-h-12 shrink-0 items-center gap-2.5 px-3.5 py-2 text-ui text-muted-foreground')}>
            <Spinner className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{sheet.waiting}</span>
            {sheet.reopen && <button className={sheetLink} onClick={() => reopenCodexSignIn()}>Open the page again</button>}
          </div>
        )}
        {sheet.note && <p className="mt-2.5 shrink-0 text-center text-micro text-faint">{sheet.note}</p>}

        {/* The buttons share the sheet's width, as a Mac alert's do: the one Return presses on the right. */}
        <div className="mt-5 flex shrink-0 items-center gap-2">
          {/* Under way, Cancel is always there, so the sheet keeps its size: it only stops working once Codex says it is done. */}
          {sheet.waiting && <button disabled={!sheet.cancel} className={cn(sheetSecondary, 'flex-1')} onClick={() => cancelCodexSignIn()}>Cancel</button>}
          {sheet.close && sheet.retry && <button className={cn(sheetSecondary, 'flex-1')} onClick={() => dismissCodexSignIn()}>{sheet.close}</button>}
          {sheet.retry && <button autoFocus className={cn(sheetPrimary, 'flex-1')} onClick={() => signInToCodex()}>Try again</button>}
          {sheet.close && !sheet.retry && <button autoFocus className={cn(sheetPrimary, 'flex-1')} onClick={() => dismissCodexSignIn()}>{sheet.close}</button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Sign out of Codex…", asked first. `returnTo`: what gets the focus back when the confirmation closes (the row's menu button, while the row is there). */
export function CodexSignOutConfirm({ open, onClose, returnTo }: { open: boolean; onClose: () => void; returnTo: RefObject<HTMLButtonElement | null> }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try { if (await signOutOfCodex()) onClose(); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent showCloseButton={false} onCloseAutoFocus={(e) => { if (returnTo.current) { e.preventDefault(); returnTo.current.focus(); } }}
        className="w-[min(440px,90vw)] max-w-none gap-0 p-5 sm:max-w-none">
        {/* Laid out like a Mac alert, as the other questions about an account are (account-remove.tsx): whose login
            it is, then what happens. The mark is only a picture (the title names Codex), drawn at 40 in a box of 32
            because the picture carries a margin of its own. */}
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center"><ProviderLogo engine="codex" size={40} className="max-w-none" /></span>
          <DialogTitle className="min-w-0 flex-1 text-ui font-semibold">Sign out of Codex?</DialogTitle>
        </div>
        <DialogDescription className="mt-3.5 text-small text-muted-foreground">
          Codex has one login for this Mac, so this signs it out in the terminal too. OpenAI’s models stop working in Canopy until you sign in again.
        </DialogDescription>
        <div className="mt-5 flex items-center gap-2">
          <button autoFocus disabled={busy} className={cn(quiet, '-ml-3.5')} onClick={onClose}>Cancel</button>
          <button disabled={busy} className={cn(sheetPrimary, 'ml-auto gap-1.5')} onClick={signOut}>{busy && <Spinner className="size-3.5" />}{busy ? 'Signing out…' : 'Sign out'}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

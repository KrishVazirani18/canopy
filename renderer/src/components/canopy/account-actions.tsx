// A maker's accounts in Settings (accounts-section.tsx, on the Claude Code and Codex pages): the parts a row is made
// of and the parts you act on. The maker's mark that leads a row, the check on the account in use, "Use" on the
// others, the ⋯ menu (Rename, Replace key, Remove…, and for the login Codex holds, Sign out of Codex…), renaming
// in place, and "Add account" (sign in to Claude Code once more, in a folder of its own, or paste an API key:
// Anthropic's on the Claude Code page, OpenAI's on the Codex page). What a row offers is decided in
// lib/account-rules.ts, and whether it happens is main's to say (src/account-actions.mjs): a refusal comes back as
// one line, shown as a toast.
//
// One account per maker is in use at a time. Choosing another is for new chats; open chats keep the account they
// started on, so nothing here touches a chat.
import { Fragment, useEffect, useRef, useState } from 'react';
import { CheckIcon, KeyRoundIcon, LogInIcon, MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { addProblem, isAddedSignIn, removeKeyQuestion, rowOffers, type AccountChange, type RowMenuItem } from '@/lib/account-rules';
import { chooseAccount, refreshAccounts, removeAccount, renameAccount } from '@/lib/accounts';
import { api, type Account, type Engine } from '@/lib/api';
import { useCodexLogin } from '@/lib/codex-login';
import { rowSignOut } from '@/lib/codex-login-rules';
import { cn } from '@/lib/utils';
import { RemoveAccountDialog } from './account-remove';
import { AddKeySheet, type KeySheet } from './add-key-sheet';
import { CodexSignOutConfirm } from './codex-signin';
import { ProviderLogo } from './provider-logo';
import { control } from './settings/kit';

// A row has the measure of every row in Settings (settings/kit.tsx `Row`: its padding, its gap, the hairlines of
// the section it is in): what leads it (the maker's mark, or the plus of "Add account"), then its words and what
// you act on. Every row of the list is as tall as one with two lines of words, "Add account" too.
// A row is lit, faintly, while the pointer is over it or its menu is open, as a row of Settings that opens
// something is: "Use" shows with it.
const LIT = 'transition-colors duration-100 hover:bg-accent/40 has-[[data-state=open]]:bg-accent/40';
const MEASURE = 'flex min-h-14 w-full items-center gap-3 px-4 py-2.5';
export const ROW = `group ${MEASURE} ${LIT}`;
/** A row's own button ("Use", "Sign in…", "Replace Key…"): Settings' button, as on every other row of the page. */
export const ROW_BTN = control;

/** One row's state: what it offers, choosing it, and whether its name is being changed. Shared by the row's parts. */
export type AccountRowState = ReturnType<typeof useAccountRow>;
export function useAccountRow(a: Account, inUse: boolean) {
  const [choosing, setChoosing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const offers = rowOffers(a, inUse);
  const choose = async () => {
    if (choosing || !offers.use) return;
    setChoosing(true);
    const r = await chooseAccount(a.engine, a.id);
    setChoosing(false);
    if (!r.ok) toast.error(r.message);
  };
  return { a, inUse, offers, choosing, choose, renaming, setRenaming };
}

/**
 * The maker's mark that leads a row. The picture carries a margin of its own (a tenth of its size on every side),
 * so it is drawn at 40 inside a box of 32: the tile itself is 32 and sits on the row's grid. Only a picture: the
 * group is already named for the maker, so a screen reader is not told again on every row.
 */
export function RowMark({ engine }: { engine: Engine }) {
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center">
      <ProviderLogo engine={engine} size={40} className="max-w-none" />
    </span>
  );
}

/** An account's name being changed, in place: Enter or clicking away saves, Esc keeps the old name. */
export function RenameField({ row }: { row: AccountRowState }) {
  const { a, setRenaming } = row;
  const [draft, setDraft] = useState(a.label);
  const input = useRef<HTMLInputElement>(null);
  // Enter saves, then the field unmounts and blurs: the ref makes sure that only saves once.
  const done = useRef(false);
  const finish = (next: string) => {
    if (done.current) return;
    done.current = true;
    setRenaming(false);
    if (next === a.label) return;
    renameAccount(a.engine, a.id, next).then((r) => { if (!r.ok) toast.error(r.message); }); // an empty name puts its own name back
  };
  useEffect(() => {
    // Focused once the menu has closed and let go of focus.
    const frame = requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    // Esc gives up the rename, not Settings: caught before the dialog around it hears the key.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.activeElement !== input.current) return;
      e.preventDefault(); e.stopPropagation();
      done.current = true;
      setRenaming(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey, true); };
  }, [setRenaming]);
  return (
    <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => finish(draft.trim())}
      onKeyDown={(e) => { if (e.key === 'Enter') finish(draft.trim()); }}
      maxLength={80} spellCheck={false} aria-label="Account name"
      className="-mx-1.5 -my-px h-[22px] min-w-0 max-w-80 flex-1 rounded-md bg-card px-1.5 text-ui font-medium outline-none ring-1 ring-foreground/25 dark:bg-background" />
  );
}

/** "Remove…": asked first, in words that say what goes and what does not. */
function RemoveDialog({ a, inUse, open, onClose, returnTo }: { a: Account; inUse: boolean; open: boolean; onClose: () => void; returnTo: React.RefObject<HTMLElement | null> }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    const r = await removeAccount(a.engine, a.id);
    setBusy(false);
    if (!r.ok) toast.error(r.message);
    onClose();
  };
  const dialogBtn = 'flex h-8 items-center justify-center rounded-lg px-3.5 text-ui transition-colors disabled:opacity-50';
  const q = removeKeyQuestion(a, inUse);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent showCloseButton={false} className="w-[440px] max-w-[90vw] gap-0 p-5 sm:max-w-[90vw]"
        onCloseAutoFocus={(e) => { if (returnTo.current?.isConnected) { e.preventDefault(); returnTo.current.focus(); } }}>
        {/* Laid out like a Mac alert, as the other questions about an account are: whose it is, then what happens. */}
        <div className="flex items-center gap-3">
          <RowMark engine={a.engine} />
          <DialogTitle className="min-w-0 flex-1 text-ui font-semibold text-balance">{q.title}</DialogTitle>
        </div>
        <DialogDescription className="mt-3.5 text-small text-muted-foreground">{q.body}</DialogDescription>
        <div className="mt-5 flex items-center gap-2">
          <button autoFocus disabled={busy} className={cn(dialogBtn, 'border border-hairline hover:bg-accent')} onClick={onClose}>Cancel</button>
          <button disabled={busy} className={cn(dialogBtn, 'ml-auto border border-hairline text-destructive hover:bg-accent')} onClick={remove}>Remove</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The end of a row: where it stands ("In use"), what to do about it ("Use", or the fix for a key that needs you), and the ⋯ menu. */
export function RowActions({ row }: { row: AccountRowState }) {
  const { a, inUse, offers } = row;
  const [sheet, setSheet] = useState<KeySheet | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removingSignIn, setRemovingSignIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Two more things a menu can have, each with a question of its own first. A sign-in added in Canopy can be
  // removed: Claude Code signs that one folder out and it is deleted (account-remove.tsx), which forgetting a key
  // is not. And the login Codex holds can be signed out of (codex-login-rules.ts).
  type MenuItem = RowMenuItem | 'remove-sign-in' | 'sign-out';
  const canSignOut = rowSignOut(a, useCodexLogin());
  const menu: MenuItem[] = [...offers.menu, ...(isAddedSignIn(a) ? ['remove-sign-in' as const] : []), ...(canSignOut ? ['sign-out' as const] : [])];
  // What was picked in the menu starts once the menu has fully closed: until then it holds the focus, and would
  // pull it out of the name field or the sheet.
  const picked = useRef<MenuItem | null>(null);
  const more = useRef<HTMLButtonElement>(null);   // the ⋯ button: the focus comes back here when a sheet closes
  const replace = () => setSheet({ engine: a.engine, replace: { id: a.id, label: a.label } });
  const start = (what: MenuItem) => {
    if (what === 'rename') row.setRenaming(true);
    else if (what === 'replace-key') replace();
    else if (what === 'sign-out') setSigningOut(true);
    else if (what === 'remove-sign-in') setRemovingSignIn(true);
    else setRemoving(true);
  };
  const retry = async () => { setRetrying(true); try { await refreshAccounts(true); } finally { setRetrying(false); } };
  const LABEL: Record<MenuItem, string> = { rename: 'Rename', 'replace-key': 'Replace key', remove: 'Remove…', 'remove-sign-in': 'Remove…', 'sign-out': 'Sign out of Codex…' };
  const parting = (item: MenuItem) => item !== 'rename' && item !== 'replace-key'; // what takes away is set apart, below a line
  return (
    <>
      {offers.fix === 'replace-key' ? <button type="button" onClick={replace} className={ROW_BTN}>Replace Key…</button>
        : offers.fix === 'retry' ? <button type="button" onClick={retry} disabled={retrying} className={ROW_BTN}>{retrying ? 'Checking…' : 'Try Again'}</button>
        : inUse ? <span className="flex shrink-0 items-center gap-1 text-small text-muted-foreground"><CheckIcon aria-hidden className="size-3.5 text-foreground" strokeWidth={2.25} />In use</span>
        // Shown while the row is lit, as in the rest of Settings, and whenever the keyboard is in the row. It says
        // whose it is to a screen reader: every other row has a "Use" too.
        : offers.use ? <button type="button" aria-label={`Use ${a.label}`} onClick={row.choose} disabled={row.choosing} className={cn(ROW_BTN, 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[data-state=open]]:opacity-100')}>Use</button>
        : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Pulled out by the space around its dots, so the dots end where a row's button does. */}
          <button ref={more} type="button" aria-label={`More for ${a.label}`}
            className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
            <MoreHorizontalIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40"
          onCloseAutoFocus={(e) => { const what = picked.current; picked.current = null; if (!what) return; e.preventDefault(); start(what); }}>
          {menu.map((item) => (
            <Fragment key={item}>
              {parting(item) && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => { picked.current = item; }}>{LABEL[item]}</DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AddKeySheet sheet={sheet} onClose={() => setSheet(null)} returnTo={more} />
      <RemoveDialog a={a} inUse={inUse} open={removing} onClose={() => setRemoving(false)} returnTo={more} />
      <RemoveAccountDialog a={a} inUse={inUse} open={removingSignIn} onOpenChange={setRemovingSignIn} returnFocus={more} />
      <CodexSignOutConfirm open={signingOut} onClose={() => setSigningOut(false)} returnTo={more} />
    </>
  );
}

/**
 * The last row of a maker's group: add an account, one menu for both ways.
 *  - "Sign in to Claude Code": a second Claude login beside the one Claude Code holds. Main gives the account a
 *    folder of its own and shows Claude Code's own sign-in for it (src/account-folders.mjs, the sheet is
 *    signin-sheet.tsx); Canopy has no sign-in field. The call answers when that sign-in ends, and the new row
 *    arrives with the accounts list.
 *  - "Paste an API key": the sheet with one field (add-key-sheet.tsx).
 * What was picked starts once the menu has fully closed: until then the menu holds the focus.
 */
export function AddAccount({ engine }: { engine: Engine }) {
  const [sheet, setSheet] = useState<KeySheet | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const picked = useRef<'sign-in' | 'key' | null>(null);
  const add = useRef<HTMLButtonElement>(null);
  // Codex's sign-in happens in the browser: the row says where it stands meanwhile ('waiting' offers the page again).
  const [phase, setPhase] = useState<string | null>(null);
  useEffect(() => (engine === 'codex' ? api.codexFolders?.onChanged((v) => setPhase(v.busy ? v.phase : null)) : undefined), [engine]);
  const signIn = async () => {
    if (signingIn) return;
    setSigningIn(true);
    let r: AccountChange | null = null;
    try {
      const folders = engine === 'codex' ? api.codexFolders?.add() : api.accountFolders?.add('plan');
      r = (await folders) ?? { ok: false, message: 'Restart Canopy to finish setting this up.' };
    }
    catch (err) { r = { ok: false, message: String((err as Error)?.message ?? err) }; }
    finally { setSigningIn(false); }
    const problem = addProblem(r);
    if (problem) toast.error(problem);
    else if (r?.ok) toast('Account added');
  };
  // Built like the rows above it: the plus stands where their marks do, on a quiet tile of their size and shape,
  // and the words start where theirs start.
  const row = cn(MEASURE, 'text-left text-ui text-muted-foreground');
  const lead = 'flex size-8 shrink-0 items-center justify-center rounded-[7px] bg-foreground/[0.05]';
  return (
    <div role="listitem" className={cn('group', LIT)}>
      {/* While Claude Code's sign-in is open the row says so, and offers nothing: one sign-in at a time. */}
      {signingIn ? (
        <div className={row}>
          <span className={lead}><Spinner className="size-4" /></span>
          <span className="min-w-0 flex-1 truncate">{engine === 'codex' && phase === 'waiting' ? 'Finish signing in in your browser…' : 'Signing in…'}</span>
          {engine === 'codex' && (
            <span className="mr-4 flex shrink-0 items-center gap-3 text-small">
              {phase === 'waiting' && <button type="button" className="hover:text-foreground" onClick={() => api.codexFolders?.reopen()}>Open the page again</button>}
              <button type="button" className="hover:text-foreground" onClick={() => api.codexFolders?.cancel()}>Cancel</button>
            </span>
          )}
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* The focus ring is drawn inside the row: the card around it would cut one drawn outside. */}
            <button ref={add} type="button" className={cn(row, '-outline-offset-2 group-last:rounded-b-[calc(var(--radius-xl)-1px)] hover:text-foreground focus-visible:text-foreground data-[state=open]:text-foreground')}>
              <span className={lead}><PlusIcon className="size-4" /></span>Add account
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" alignOffset={12} className="w-64"
            onCloseAutoFocus={(e) => {
              const what = picked.current;
              picked.current = null;
              if (!what) return;
              e.preventDefault();
              if (what === 'key') setSheet({ engine }); else signIn();
            }}>
            {/* A second sign-in, in a folder of its own: Claude Code's in a terminal in the window, Codex's in the
                browser. Either way the maker's own sign-in, and it is added beside the login the tool already has. */}
            <DropdownMenuItem onSelect={() => { picked.current = 'sign-in'; }}><LogInIcon className="size-4" />{engine === 'claude' ? 'Sign in to Claude Code' : 'Sign in to Codex'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { picked.current = 'key'; }}><KeyRoundIcon className="size-4" />Paste an API key</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AddKeySheet sheet={sheet} onClose={() => setSheet(null)} returnTo={add} />
    </div>
  );
}

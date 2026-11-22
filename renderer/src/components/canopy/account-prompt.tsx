// A login that needs you, wherever it shows. What is wrong and what the button does come from lib/account-rules.ts,
// so the four places always agree:
//
//   AccountPrompt    once per launch, in Canopy's own dialog (built like restart-dialog.tsx), and skippable: Sign in…,
//                    Use <another account that works>, or Not now. Nothing is locked: history, Home, Settings and the
//                    other maker's chats all keep working.
//   AccountBlocker   after Not now, a row docked on the message box of a chat whose account needs you. Send waits,
//                    what you typed stays.
//                    Both are led by the maker's mark (provider-logo.tsx), the only colour in them besides the one
//                    amber dot. One account at a time: the prompt is about the account new chats start on.
//   SignInAction     the button beside "Claude is signed out." in a chat whose turn could not sign in.
//   RowSignIn        the same button on the account's row in Settings (its maker's page), and in the Usage tab.
//
// The last two are for either maker. A Codex account gets Codex's own sign-in, in the browser (codex-signin.tsx),
// whenever its login needs one (lib/codex-login-rules.ts). Codex's own login never holds its chats; a pasted Codex
// API key that stopped working does, through the same prompt and row as Claude's.
//
// The prompt asks about the account new chats start on. The row and the notice's button go by the account their
// own chat is on: a chat keeps the account it started on, so one chat can be held up while a new one is not.
//
// Sign in… opens Claude Code's own sign-in (signin-sheet.tsx). Canopy never asks for a login itself. "Use <account>"
// is the same switch as "Use" on an account's row in Settings (lib/accounts.ts `chooseAccount`): it is for new chats.
import { useEffect, useRef } from 'react';
import { LogInIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { promptWords, showsSignIn, signsIn, type Trouble } from '@/lib/account-rules';
import { useAccounts } from '@/lib/accounts';
import type { Account, Engine } from '@/lib/api';
import { signInToCodex, useCodexLogin } from '@/lib/codex-login';
import { codexSignIn, rowSignIn } from '@/lib/codex-login-rules';
import { answerPrompt, openAccounts, openSignIn, switchTo, useChatTrouble, useSignIn, useTrouble } from '@/lib/signin';
import { cn } from '@/lib/utils';
import { ProviderLogo } from './provider-logo';
import { Reveal } from './reveal';

/** What a trouble's one button does. */
const fix = (t: Trouble) => (t.fix === 'sign-in' ? openSignIn(t.engine, t.account) : openAccounts(t.engine));

/** Who the account is, as one quiet line: "Max · you@example.com". */
const who = (a: Account) => (a.email && a.email !== a.label ? `${a.label} · ${a.email}` : a.label);

/**
 * The maker's mark, to say whose account it is. Only a picture: the words beside it already name the maker, so it
 * is hidden from a screen reader. The image has an app icon's clear margin around its tile (a tenth of its size):
 * that margin is taken back here, so it is the tile that lines up with the text and keeps the spacing asked for.
 */
function Mark({ engine, size }: { engine: Engine; size: number }) {
  return <span aria-hidden className="block shrink-0" style={{ margin: -Math.round(size / 10) }}><ProviderLogo engine={engine} size={size} /></span>;
}
/** The one dot that says an account needs you (the same dot as on a notice in a chat). */
const Dot = () => <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />;

// The dialog's buttons, the size and shape of restart-dialog.tsx's.
const btn = 'flex h-8 items-center justify-center rounded-lg px-3.5 text-ui transition-colors';

/** `active`: the app is past its start-up screens. The prompt waits for that, however early the answer came. */
export function AccountPrompt({ active }: { active: boolean }) {
  const { asking, run } = useSignIn();
  const found = useTrouble(asking ?? 'claude');
  const trouble = asking ? found : null;
  // Fixed while the question was waiting (signed in from Terminal, say): there is nothing to ask.
  useEffect(() => { if (asking && !trouble) answerPrompt(); }, [asking, trouble]);
  // The last question stays rendered while the dialog animates out. Kept in a ref, like the row's words below: a
  // trouble is a new object on every render, so keeping it in state from an effect rendered again without end.
  const last = useRef<Trouble | null>(null);
  if (trouble) last.current = trouble;

  const t = trouble ?? last.current;
  const words = t ? promptWords(t) : null;
  // The button Return presses. It is focused as the dialog opens, through the dialog's own hook and not `autoFocus`:
  // the dialog puts the focus back where it was when something outside takes it (the message box does, when a
  // chat opens or the window comes forward), but only once it has seen the focus arrive, and `autoFocus` moves it
  // before the dialog is watching. Return then went to the message box behind the question.
  const primary = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={active && !!trouble && !run} onOpenChange={(o) => { if (!o) answerPrompt(); }}>
      <DialogContent showCloseButton={false} style={{ left: 'calc(50% + var(--canopy-sidebar, 0px) / 2)' }}
        onOpenAutoFocus={(e) => { e.preventDefault(); primary.current?.focus(); }}
        className="w-[400px] max-w-[90vw] gap-0 p-5 sm:max-w-[90vw]">
        {/* Laid out like a Mac alert: whose account it is and what happened, one sentence on what it costs, then
            the buttons in a row with the one Return presses on the right. */}
        <div className="flex min-w-0 items-center gap-3">
          {t && <Mark engine={t.engine} size={48} />}
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-ui font-semibold">{words?.title}</DialogTitle>
            {t && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-small text-muted-foreground" title={who(t.account)}>
                <Dot /><span className="truncate">{who(t.account)}</span>
              </p>
            )}
          </div>
        </div>
        <DialogDescription className="mt-3.5 text-small text-balance text-muted-foreground">{words?.body}</DialogDescription>
        {t && words && (
          // In the order they are read and tabbed through, as in restart-dialog.tsx: the way out on the left, the
          // way on (the one Return presses) on the right. Esc is Not now.
          <div className="mt-5 flex min-w-0 items-center gap-2">
            <button className={cn(btn, '-ml-2.5 shrink-0 px-2.5 text-muted-foreground hover:bg-accent hover:text-foreground')} onClick={answerPrompt}>Not now</button>
            {t.other && words.use && (
              <button className={cn(btn, 'ml-auto min-w-0 border border-hairline hover:bg-accent')} title={words.use} onClick={() => { answerPrompt(); switchTo(t.engine, t.other!); }}>
                <span className="truncate">{words.use}</span>
              </button>
            )}
            <button ref={primary} className={cn(btn, 'min-w-20 shrink-0 bg-foreground font-medium text-background hover:opacity-90', !(t.other && words.use) && 'ml-auto')} onClick={() => { answerPrompt(); fix(t); }}>
              {words.primary}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// A small quiet button beside a line in a chat (the same as a notice's other button, transcript.tsx).
const pill = 'press flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-card px-2.5 text-small text-foreground/90 transition-colors duration-150 hover:border-foreground/25 hover:bg-accent hover:text-foreground';
// The row's own buttons: small Mac ones, the way on filled and the other outlined.
const small = 'press flex h-6 items-center justify-center rounded-lg px-2.5 text-small transition-colors duration-150';

/** The row on the message box of a chat whose account needs you. It folds away once the account works again. */
export function AccountBlocker() {
  const { trouble, fresh } = useChatTrouble();
  // While the row folds away it keeps the words it had.
  const held = useRef(trouble);
  if (trouble) held.current = trouble;
  const t = held.current;
  // "Use Console" is for new chats. A chat nobody has used yet moves with it, so there it is the way on; a chat
  // with a conversation keeps its account, and the button would change nothing for it.
  const other = fresh ? t?.other ?? null : null;
  return (
    <Reveal show={!!trouble} from="bottom" duration={200}>
      {t && (
        // Docked to the composer like the mode card: a tab flush on its top edge, with the box's own surface and
        // stroke, so the two read as one piece.
        <div inert={!trouble} className="mx-4 -mb-px">
          <div role="status" className="flex min-h-9 items-center gap-2 rounded-t-[14px] border border-b-0 bg-card py-1.5 pr-1.5 pl-3.5 text-small">
            <Mark engine={t.engine} size={20} />
            <span className="min-w-0 shrink-[8] truncate text-foreground/90" title={t.line}>{t.line}</span>
            {/* The buttons keep to the right. In a narrow pane the account's name gives way first (it starts small
                and takes what room is left, up to its own length), and the sentence only after that. */}
            {other && (
              <button type="button" className={cn(small, 'ml-auto max-w-max min-w-0 grow basis-16 border border-hairline text-foreground/90 hover:border-foreground/25 hover:bg-accent hover:text-foreground')} title={`Use ${other.label}`} onClick={() => switchTo(t.engine, other)}>
                <span className="max-w-48 truncate">Use {other.label}</span>
              </button>
            )}
            <button type="button" className={cn(small, 'shrink-0 bg-foreground font-medium text-background hover:opacity-90', !other && 'ml-auto')} onClick={() => fix(t)}>
              {t.fix === 'sign-in' ? 'Sign in…' : 'Open Settings…'}
            </button>
          </div>
        </div>
      )}
    </Reveal>
  );
}

/** The button beside a "could not sign in" notice in a chat: the sign-in for the account that chat is on. Gone once it works again. */
export function SignInAction({ engine, notice }: { engine: Engine; notice: { at: number; hist?: boolean } }) {
  return engine === 'codex' ? <CodexSignInAction /> : <ClaudeSignInAction notice={notice} />;
}
function ClaudeSignInAction({ notice }: { notice: { at: number; hist?: boolean } }) {
  const { trouble, account } = useChatTrouble();
  const { signedInAt } = useSignIn();
  if (!showsSignIn(notice, trouble, signedInAt.claude, account)) return null;
  return (
    <button type="button" onClick={() => openSignIn('claude', trouble?.account ?? account)} className={cn(pill, 'ml-1')}>
      <LogInIcon className="size-3 text-muted-foreground" />Sign in…
    </button>
  );
}
// Beside a turn OpenAI refused: offered exactly while Codex's login needs a sign-in, as on its row in Settings.
function CodexSignInAction() {
  const label = codexSignIn(useAccounts()?.list, useCodexLogin());
  if (!label) return null;
  return (
    <button type="button" onClick={() => { signInToCodex(); }} className={cn(pill, 'ml-1')}>
      <LogInIcon className="size-3 text-muted-foreground" />{label}
    </button>
  );
}

/**
 * The sign-in that would fix an account, whichever maker's it is: its label and what opens it, or null when there
 * is none to offer. Claude Code's opens in a terminal in the window; Codex's opens in the browser.
 */
export function useAccountSignIn(account: Account): { label: string; open: () => void } | null {
  const login = useCodexLogin();
  if (account.engine === 'codex') {
    const label = rowSignIn(account, login);
    return label ? { label, open: () => { signInToCodex(); } } : null;
  }
  return signsIn(account) ? { label: 'Sign in…', open: () => { openSignIn(account.engine, account); } } : null;
}

/** An account's row in Settings, and the Usage tab: the button on an account that signing in again would fix. */
export function RowSignIn({ account, className }: { account: Account; className?: string }) {
  const signIn = useAccountSignIn(account);
  if (!signIn) return null;
  return <button type="button" onClick={signIn.open} className={className}><LogInIcon className="size-3.5" />{signIn.label}</button>;
}

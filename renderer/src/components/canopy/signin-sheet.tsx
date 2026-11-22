// "Sign in to Claude Code": Claude Code's own sign-in (`claude auth login`), shown as it is.
//
// Canopy has no sign-in field of its own. The box in this sheet is a terminal: what Claude Code prints is drawn in
// it, and what you type or paste goes to Claude Code and nowhere else. Canopy only learns that the sign-in ended,
// then asks Claude Code who is signed in (src/core/signin.mjs). Nothing typed or printed here is kept or logged.
//
// The sign-in starts when the terminal is on screen, never before, so none of its output has to be held.
// "Open in Terminal instead" runs the same sign-in in the Terminal app; Canopy looks again when you come back.
//
// The sheet reads top to bottom like a Mac sign-in: whose sign-in it is (the maker's mark, the title, one line),
// the two things to do, Claude Code's own prompt in a panel of the sheet's colours, and one line that says where it
// stands. Once the sign-in is over, or has gone to Terminal, the panel is gone and the sheet is a small one.
// The parts both makers' sheets are built from are at the top of this file (Codex's sheet: codex-signin.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { CheckIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useAccounts } from '@/lib/accounts';
import { ADDED_NOTE, isAddedSignIn } from '@/lib/account-rules';
import { api, type SignInState } from '@/lib/api';
import { closeSignIn, useSignIn } from '@/lib/signin';
import { cn } from '@/lib/utils';
import { ProviderLogo, type Maker } from './provider-logo';
import { termTheme } from './terminal-view';

// ---------- what both sign-in sheets are built from ----------

// The same buttons as Canopy's other small dialogs (restart-dialog.tsx).
const btn = 'flex h-8 shrink-0 items-center justify-center rounded-lg px-3.5 text-ui transition-colors disabled:opacity-60';
export const sheetPrimary = cn(btn, 'bg-foreground font-medium text-background hover:opacity-90');
export const sheetSecondary = cn(btn, 'border border-hairline text-foreground hover:bg-accent');
/** A quiet action at the end of a line ("Open the page again"): grey words, with room around them to click. The
 *  negative margin gives that room back, so the words line up with what is around them. */
export const sheetLink = '-mx-2 flex h-7 shrink-0 items-center rounded-md px-2 text-small text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60';
/** The sheet itself. The width is the caller's: wide with Claude Code's prompt in it, small otherwise. */
export const sheetBox = 'flex max-h-[calc(100vh-2rem)] max-w-[92vw] flex-col gap-0 px-6 pt-7 pb-5 sm:max-w-[92vw]';
/** An inset panel in the sheet's own colours: Claude Code's prompt, or the line a small sheet waits on. */
export const sheetWell = 'rounded-xl border border-hairline bg-[var(--code-bg)]';

/**
 * The top of a sheet: whose sign-in this is, the title, and what is under it (one line, as the dialog's description).
 * The maker's mark is shown as it is, with nothing drawn over it. `mark` says how the sign-in ended, in the words:
 * `done` is a check before the title, in ink (colour stays with the maker's mark), and the line under it, which
 * then says who signed in, is in ink too. `trouble` is the one amber dot before the line that says it did not work.
 */
export function SheetTop({ engine, title, mark, children }: { engine: Maker; title: string; mark?: 'done' | 'trouble'; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col items-center text-center">
      <ProviderLogo engine={engine} size={56} />
      <DialogTitle className="mt-2.5 flex max-w-full items-center justify-center gap-2 text-title">
        {mark === 'done' && (
          <span aria-hidden className="swap-in size-[18px] shrink-0 items-center justify-center rounded-full bg-foreground text-background">
            <CheckIcon className="size-3" strokeWidth={3} />
          </span>
        )}
        {title}
      </DialogTitle>
      <DialogDescription asChild className={mark ? 'text-foreground' : undefined}>
        <div className="mt-1 max-w-full text-balance">
          {mark === 'trouble' && <span aria-hidden className="mr-2 inline-block size-1.5 -translate-y-0.5 rounded-full bg-warn" />}
          {children}
        </div>
      </DialogDescription>
    </div>
  );
}

/** One thing to do, numbered: a few plain words, and a line of help under them. Goes in an `<ol>`. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-micro font-medium text-muted-foreground tabular-nums">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-ui font-medium">{title}</div>
        <div className="text-small text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

// ---------- Claude Code's sheet ----------

type TermHandle = { start(how?: { console: boolean }): void };

/**
 * The terminal Claude Code's sign-in runs in. `onReady` hands back the one thing the sheet does to it: start again.
 * `live`: the sign-in is running, so there is a prompt to type at (the caret is only drawn then).
 */
function SignInTerminal({ id, live, onReady, onLink }: { id: string; live: boolean; onReady: (t: TermHandle | null) => void; onLink?: (url: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      // xterm measures its cell size once at open: the face must be loaded first or the grid is wrong.
      try { await document.fonts.load('13px "Geist Mono"'); } catch { /* fall back to the system mono */ }
      const el = host.current;
      if (cancelled || !el) return;
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-meta').trim() || '"SF Mono", Menlo, monospace';
      // A size and line to read comfortably, and a caret rather than a block: this terminal only ever shows a few
      // lines and one prompt. The colours are the panel's own (termTheme reads them off the host).
      const term = new Terminal({
        fontFamily, fontSize: 13, lineHeight: 1, cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, cursorInactiveStyle: 'bar',
        minimumContrastRatio: 4.5, theme: termTheme(el),
        // The sign-in address Claude Code prints is a terminal hyperlink. xterm's default asks "this link could be
        // dangerous" and then opens nothing; a click opens it in the browser instead (https only; main's window-open
        // handler sends it to the system browser). Nothing is read from the terminal but the link that was clicked.
        linkHandler: {
          activate: (_e, uri) => { try { if (new URL(uri).protocol === 'https:') window.open(uri); } catch { /* not a link */ } },
          allowNonHttpProtocols: false,
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      try { fit.fit(); } catch { /* ignore */ }
      const mo = new MutationObserver(() => { term.options.theme = termTheme(el); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      // Straight through, both ways: Claude Code's output into the terminal, your typing to Claude Code.
      // The one thing read from what Claude Code prints: the sign-in page's address, so "Open Page Again" can open it
      // (it is the page Claude Code asks you to visit; nothing else is read, nothing is kept).
      let seen = '';
      const offData = api.signin?.onData((from, d) => {
        if (from !== id) return;
        term.write(d);
        if (onLink) {
          seen = (seen + d.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/[\r\n]+/g, ' ')).slice(-4000);
          const m = seen.match(/https:\/\/[^\s"'<>]*oauth\/authorize\?[^\s"'<>]*?state=[A-Za-z0-9_-]+/);
          if (m) onLink(m[0]);
        }
      }) ?? (() => {});
      term.onData((d) => api.signin?.input(id, d));
      term.onResize(({ cols, rows }) => api.signin?.resize(id, cols, rows));
      const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* ignore */ } });
      ro.observe(el);
      const start = (how?: { console: boolean }) => {
        term.reset();
        api.signin?.attach(id, term.cols, term.rows, how).catch(() => {}); // how it went comes back as the sign-in's state
        term.focus();
      };
      start();
      onReady({ start });
      cleanup = () => { onReady(null); offData(); ro.disconnect(); mo.disconnect(); term.dispose(); };
    })();
    return () => { cancelled = true; cleanup(); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    // Part of the sheet, and plainly Claude Code's: its name over its own prompt. The edge darkens while it has the
    // keyboard, as the message box does.
    <div className={cn(sheetWell, 'flex h-[132px] min-h-[124px] shrink flex-col overflow-hidden transition-[border-color] duration-150 focus-within:border-foreground/25')}>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-hairline pr-3 pl-2.5 text-small text-muted-foreground">
        <ProviderLogo engine="claude" size={16} />Claude Code
      </div>
      {/* The space around the text is the terminal's own padding, which FitAddon leaves out of the grid (padding on
          this host it would count as room). The right side is narrower by the 14px xterm keeps for its scrollbar.
          The long address Claude Code prints is drawn as quiet text, not as a block of dashed underlines. */}
      <div ref={host} className={cn(
        'min-h-0 flex-1 bg-inherit text-[color-mix(in_oklch,var(--foreground)_84%,var(--code-bg))]',
        '[&_.xterm]:h-full [&_.xterm]:py-3 [&_.xterm]:pr-0.5 [&_.xterm]:pl-3 [&_.xterm-viewport]:bg-transparent!',
        '[&_.xterm-underline-5]:text-muted-foreground! [&_.xterm-underline-5]:no-underline!',
        !live && '[&_.xterm-cursor]:shadow-none!',
      )} />
    </div>
  );
}

const WITH_PROMPT = 'Claude Code runs its own sign-in here. Canopy never sees your password.';
const IN_TERMINAL = 'The sign-in is open in Terminal. Finish it there; Canopy looks again when you come back.';

export function SignInSheet() {
  const { run } = useSignIn();
  const accounts = useAccounts();
  // The last sign-in stays rendered while the sheet animates out.
  const [last, setLast] = useState<SignInState | null>(null);
  useEffect(() => { if (run) setLast(run); }, [run]);
  const term = useRef<TermHandle | null>(null);
  const [busy, setBusy] = useState(false); // Terminal is being opened, or Claude Code is being asked
  // A sign-in that went to Terminal has no terminal here any more, however it ends.
  const [handed, setHanded] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null); // the sign-in page Claude Code printed (for Open Page Again)
  useEffect(() => { setLink(null); }, [run?.id]);
  useEffect(() => { if (run?.phase === 'terminal') setHanded(run.id); }, [run]);

  const r = run ?? last;
  if (!r) return null;
  const { id, phase } = r;
  const toTerminal = async () => {
    setBusy(true);
    try { const t = await api.signin?.terminal(id); if (t && !t.ok) toast.error(t.message ?? t.error ?? 'Terminal couldn’t be opened.'); }
    catch { toast.error('Terminal couldn’t be opened.'); }
    finally { setBusy(false); }
  };
  const check = async () => { setBusy(true); try { await api.signin?.check(id); } catch { /* the sheet shows where it stands */ } finally { setBusy(false); } };
  const waiting = phase === 'ready' || phase === 'running';
  const done = phase === 'done';
  // Claude Code's prompt is on screen until the sign-in is over, unless it went to Terminal.
  const prompt = phase !== 'terminal' && handed !== id && !done;
  const who = [r.who?.label, r.who?.email].filter(Boolean).join(' · ');
  const trouble = phase === 'failed' || (phase === 'terminal' && !!r.code);
  const turning = waiting || phase === 'checking' || busy || (phase === 'terminal' && !r.message);
  // A sign-in added in Canopy keeps its own connector sign-ins, which start empty: said here once, when it is new.
  // Only when the list has exactly that one account under this address: a second one is the same person twice,
  // which main is about to take back (src/account-folders.mjs).
  const same = done && !r.account && r.who?.email ? accounts?.list.filter((a) => a.engine === 'claude' && a.email === r.who?.email) ?? [] : [];
  const added = same.length === 1 && isAddedSignIn(same[0]);

  // Where it stands, in one line: turning while something is awaited, the amber dot when it did not work.
  // What went wrong is never cut short: it takes a second line (and in the small sheet, as many as it needs).
  const stands = (
    <div className="flex min-w-0 flex-1 items-start gap-2.5 text-ui">
      {turning && <Spinner className="mt-[3px] size-3.5 shrink-0" />}
      {trouble && !busy && <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warn" />}
      <span role="status" className={cn('min-w-0 flex-1 text-pretty', trouble && 'text-foreground')}>
        {waiting ? 'Waiting for you to sign in…' : phase === 'checking' ? 'Checking with Claude Code…' : r.message ?? (phase === 'terminal' ? 'Waiting for you in Terminal…' : '')}
      </span>
    </div>
  );

  // What you can do about it. "Check now" keeps its place while Claude Code is being asked about a sign-in that
  // went to Terminal, so that line does not jump.
  const actions = (
    <>
      {waiting && r.canSwitch && (
        <button type="button" className={sheetLink} onClick={() => term.current?.start({ console: !r.console })}>
          {r.console ? 'Use a Claude plan instead' : 'Use Console instead'}
        </button>
      )}
      {(waiting || phase === 'failed') && <button type="button" disabled={busy} className={sheetLink} onClick={toTerminal}>Open in Terminal instead</button>}
      {phase === 'failed' && (r.code === 'unverified'
        ? <button type="button" disabled={busy} className={sheetPrimary} onClick={check}>Check again</button>
        : <button type="button" className={sheetPrimary} onClick={() => term.current?.start()}>Try again</button>)}
      {(phase === 'terminal' || (phase === 'checking' && !prompt)) && <button type="button" disabled={busy || phase !== 'terminal'} className={sheetSecondary} onClick={check}>Check now</button>}
    </>
  );

  return (
    // Only its own buttons close it: a click outside or Esc in the terminal must not end a sign-in half way.
    <Dialog open={!!run} onOpenChange={(o) => { if (!o) closeSignIn(); }}>
      {/* Centred over the chat, beside the sidebar, and never wider than the room there. */}
      <DialogContent showCloseButton={false} style={{ left: 'calc(50% + var(--canopy-sidebar, 0px) / 2)', maxWidth: 'calc(100vw - var(--canopy-sidebar, 0px) - 2rem)' }}
        className={cn(sheetBox, prompt ? 'w-[620px]' : 'w-[420px]')}
        onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { if ((e.target as HTMLElement | null)?.closest?.('.xterm')) e.preventDefault(); }}>
        {/* The sheet changes size when the prompt leaves it (to Terminal, or signed in): what is in it then comes in
            softly, so the change reads as the next page and not as a jump. */}
        <div key={prompt ? 'prompt' : done ? 'done' : 'terminal'} className="enter-fade flex min-h-0 flex-col">
          {!done && (
            <button type="button" aria-label="Close" onClick={closeSignIn} className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <XIcon className="size-4" />
            </button>
          )}
          <SheetTop engine="claude" mark={done ? 'done' : undefined} title={done ? 'Signed in to Claude Code' : 'Sign in to Claude Code'}>
            {/* Signed in: who it is, as the list of accounts names them ("Max · you@example.com"). */}
            {done ? <div className="truncate" title={who || undefined}>{who || 'Claude Code is signed in.'}</div> : prompt ? WITH_PROMPT : IN_TERMINAL}
          </SheetTop>

          {prompt && (
            <>
              <ol className="mt-5 flex shrink-0 flex-col gap-2.5">
                <Step n={1} title="Approve in your browser">
                  <span className="flex items-center justify-between gap-3">
                    <span>Claude Code opened its sign-in page.</span>
                    {link && <button type="button" className={sheetLink} onClick={() => window.open(link)}>Open Page Again</button>}
                  </span>
                </Step>
                <Step n={2} title="Paste the code here">If the page gives you a code, click the box, paste it, and press Return.</Step>
              </ol>
              <div className="mt-3.5 flex min-h-0 flex-col"><SignInTerminal key={id} id={id} live={waiting} onReady={(t) => { term.current = t; }} onLink={setLink} /></div>
              {/* One line under the prompt: where it stands on the left, what you can do about it on the right. */}
              <div className="mt-3 flex min-h-8 shrink-0 items-center gap-3.5 text-muted-foreground">{stands}{actions}</div>
            </>
          )}

          {/* In Terminal: the small sheet waits on one inset line. */}
          {!prompt && !done && (
            <div className={cn(sheetWell, 'mt-5 flex min-h-12 shrink-0 items-center gap-2.5 py-2 pr-2 pl-3.5 text-muted-foreground')}>{stands}{actions}</div>
          )}

          {done && (
            <>
              {added && <p className="mt-4 shrink-0 text-center text-small text-balance text-muted-foreground">{ADDED_NOTE}</p>}
              <button autoFocus onClick={closeSignIn} className={cn(sheetPrimary, 'mt-5 w-full')}>Done</button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

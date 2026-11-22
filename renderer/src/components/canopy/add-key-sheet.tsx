// The sheet an API key is pasted into: to add it as an account (Settings → Claude Code or Codex → Add account →
// Paste an API key), or to replace the key of an account that has one. For either maker: an Anthropic key on the
// Claude Code page, an OpenAI key on the Codex page, each with its maker's mark and words (lib/account-rules.ts
// `keySheetWords`).
//
// The key is typed into one field, hidden as it is typed, and handed to main once. Main checks it with its maker
// and keeps it in the Keychain; the window never gets it back, and nothing here writes it down: it lives in this
// component until the sheet closes. A Claude sign-in token is refused where it is typed, before it is sent anywhere.
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { isSignInToken, keySheetWords, SIGN_IN_TOKEN } from '@/lib/account-rules';
import { addAccountKey, replaceAccountKey } from '@/lib/accounts';
import type { Engine } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ProviderLogo } from './provider-logo';

const btn = 'flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-ui transition-colors disabled:opacity-50';

/** What the sheet is for: a new key account, or another key for the account named. */
export type KeySheet = { engine: Engine; replace?: { id: string; label: string } };

/** `returnTo`: what gets the focus back when the sheet closes (the control it was opened from). */
export function AddKeySheet({ sheet, onClose, returnTo }: { sheet: KeySheet | null; onClose: () => void; returnTo?: React.RefObject<HTMLElement | null> }) {
  // The last request stays rendered while the sheet animates out.
  const [last, setLast] = useState<KeySheet | null>(sheet);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const open = sheet != null;
  // Opened (or opened for another account): start empty. Closed: the key is dropped at once.
  useEffect(() => { if (sheet) setLast(sheet); setKey(''); setProblem(null); setBusy(false); }, [sheet]);

  const shown = sheet ?? last;
  const replace = shown?.replace;
  const words = keySheetWords(shown?.engine ?? 'claude', replace);
  const typed = key.trim();
  const submit = async () => {
    if (!shown || busy || !typed) return;
    if (isSignInToken(typed)) { setProblem(SIGN_IN_TOKEN); setKey(''); field.current?.focus(); return; }
    setBusy(true); setProblem(null);
    const r = replace ? await replaceAccountKey(shown.engine, replace.id, typed) : await addAccountKey(shown.engine, typed);
    setBusy(false);
    if (r.ok) { setKey(''); onClose(); return; }
    setProblem(r.message);
    // Kept only when trying the same key again makes sense (its maker could not be reached): anything else is retyped.
    if (r.code !== 'unreachable') setKey('');
    field.current?.focus();
  };

  return (
    // While the key is being checked the sheet stays: closing it would not stop main from adding the key.
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent showCloseButton={false} className="w-[420px] max-w-[92vw] gap-0 px-6 pt-7 pb-5 sm:max-w-[92vw]"
        onOpenAutoFocus={(e) => { e.preventDefault(); field.current?.focus(); }}
        onCloseAutoFocus={(e) => { if (returnTo?.current?.isConnected) { e.preventDefault(); returnTo.current.focus(); } }}>
        {/* The other way to add an account is the maker's own sign-in (signin-sheet.tsx), and this sheet is built
            like that one: whose account it is, the title and one sentence, then the one field. */}
        <div className="flex flex-col items-center text-center">
          {shown && <ProviderLogo engine={shown.engine} size={56} />}
          <DialogTitle className="mt-2.5 text-title">{words.title}</DialogTitle>
          <DialogDescription className="mt-1 text-ui text-balance text-muted-foreground">{words.line}</DialogDescription>
        </div>

        <form className="mt-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input ref={field} type="password" value={key} onChange={(e) => { setKey(e.target.value); if (problem) setProblem(null); }}
            disabled={busy} aria-label="API key" aria-invalid={problem ? true : undefined} aria-describedby={problemId}
            placeholder={words.placeholder} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className="h-9 w-full rounded-lg border border-foreground/10 bg-card px-3 font-mono text-code outline-none placeholder:text-faint focus:border-foreground/35 focus:ring-[3px] focus:ring-foreground/[0.07] disabled:opacity-60 dark:bg-background" />
          {/* Room for two lines either way, so the sheet does not jump when something is said. */}
          <p id={problemId} role={problem ? 'alert' : undefined} className={cn('mt-2 flex min-h-8 gap-2 text-small', problem ? 'text-foreground/80' : 'text-faint')}>
            {problem && <span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-warn" />}
            <span>{problem ?? words.note}</span>
          </p>

          {/* Side by side and the same size, the way out first: Return adds the key. */}
          <div className="mt-4 flex items-center gap-2">
            <button type="button" disabled={busy} className={cn(btn, 'flex-1 border border-hairline hover:bg-accent')} onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy || !typed} className={cn(btn, 'flex-1 bg-foreground font-medium text-background hover:opacity-90')}>
              {busy ? <><Spinner className="size-3.5" />Checking…</> : replace ? 'Replace Key' : 'Add Key'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

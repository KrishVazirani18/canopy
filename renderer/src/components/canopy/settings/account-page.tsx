// Settings → Canopy Account: who you're signed in to Canopy as (its own Google sign-in, not Claude Code's or Codex's),
// signing out, and deleting the account. Deleting removes your row from Canopy's list (Supabase) and signs you out
// here; your chats, Claude Code and Codex are not touched. Signed out, the page offers the Google sign-in again. A
// copy built from source has no account at all (src/build-config.mjs), and the page says so.
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { accountBridge, useCanopyAccount } from '@/lib/canopy-account';
import { cn } from '@/lib/utils';
import { Button, Identity, Page, Row, Section } from './kit';

const btn = 'flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-ui transition-colors disabled:opacity-60';

function Photo({ src, name }: { src: string | null; name: string | null }) {
  const initial = (name || '?').trim()[0]?.toUpperCase();
  return src
    ? <img src={src} alt="" className="size-12 shrink-0 rounded-full object-cover" />
    : <span className="avatar-green flex size-12 shrink-0 items-center justify-center rounded-full text-ui font-semibold">{initial}</span>;
}

export function CanopyAccountPage() {
  const me = useCanopyAccount();
  const acct = accountBridge();
  const [busy, setBusy] = useState<'in' | 'out' | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const signIn = async () => {
    if (!acct) return;
    setBusy('in'); setProblem(null);
    const r = await acct.signIn().catch(() => ({ error: 'Couldn’t start sign-in.' }));
    setBusy(null);
    if ('error' in r && r.error !== 'Cancelled.') setProblem(r.error);
  };
  const signOut = async () => { if (!acct) return; setBusy('out'); await acct.signOut().catch(() => {}); setBusy(null); };

  // Main hasn't answered yet: a moment of nothing. No account bridge at all (an older main): the signed-out page.
  if (!me && acct) return <Page title="Canopy Account"><div /></Page>;
  // A copy built from source: there is no Canopy account to sign in to, and the page says so instead of offering one.
  if (me?.available === false) {
    return (
      <Page title="Canopy Account">
        <Identity mark={<Photo src={null} name={null} />} title="No Canopy account" detail="A copy built from source has no account of its own. Claude Code and Codex keep their sign-ins." />
      </Page>
    );
  }
  if (!me?.signedIn) {
    return (
      <Page title="Canopy Account">
        <Identity mark={<Photo src={null} name={null} />} title="Not signed in" detail="Sign in so Canopy knows who you are."
          actions={<Button primary busy={busy === 'in'} onClick={signIn}>{busy === 'in' ? 'Waiting for Google…' : 'Continue with Google'}</Button>} />
        {problem && <p className="mt-3 px-1 text-small text-muted-foreground">{problem}</p>}
      </Page>
    );
  }
  return (
    <Page title="Canopy Account">
      <Identity mark={<Photo src={me.avatar} name={me.name} />} title={me.name ?? me.email ?? 'Signed in'} detail={me.name ? me.email : 'Signed in with Google'}
        actions={<Button busy={busy === 'out'} onClick={signOut}>Sign Out</Button>} />
      <Section title="Your account">
        <Row label="Signed in with Google" detail="Your Canopy account. Claude Code and Codex keep their own sign-ins." />
        <Row label="Delete Account" detail="Removes your name, email and photo from Canopy. Your chats stay on this Mac." onClick={() => setAsking(true)} />
      </Section>
      <DeleteDialog open={asking} onOpenChange={setAsking} />
    </Page>
  );
}

function DeleteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = (next: boolean) => { if (deleting) return; if (!next) setProblem(null); onOpenChange(next); };
  const remove = async () => {
    const acct = accountBridge();
    if (!acct?.deleteAccount) { setProblem('Restart Canopy to finish setting this up.'); return; }
    setDeleting(true); setProblem(null);
    const r = await acct.deleteAccount().catch(() => ({ error: 'Couldn’t delete your account.' }));
    setDeleting(false);
    if ('error' in r) setProblem(r.error); else onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} style={{ left: 'calc(50% + var(--canopy-sidebar, 0px) / 2)' }} className="w-[420px] max-w-[90vw] gap-0 p-5 sm:max-w-[90vw]">
        <DialogTitle className="text-ui font-semibold">Delete your Canopy account?</DialogTitle>
        <DialogDescription className="mt-1.5 text-small text-pretty text-muted-foreground">
          Your name, email and photo are removed from Canopy for good, and you’re signed out here. Your chats, Claude
          Code and Codex stay as they are.
        </DialogDescription>
        {problem && <p className="mt-3 text-small text-foreground">{problem}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={deleting} className={cn(btn, 'border border-hairline text-foreground hover:bg-accent')} onClick={() => close(false)}>Cancel</button>
          <button type="button" disabled={deleting} className={cn(btn, 'bg-destructive font-medium text-white hover:opacity-90')} onClick={remove}>
            {deleting && <Spinner className="size-3.5" />}Delete Account
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

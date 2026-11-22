// The right panel's Usage tab: for the account in use per maker, how much of its plan's limits is used, or what it
// has spent when it is billed per use. One section per maker that has an account, Claude first; a maker with no
// account is not drawn. Only ever the account in use: there is nothing here to compare accounts with.
//
// Quiet on purpose, and in the Stats tab's voice: plain rows, no boxes, the panel's two text sizes. Each maker is
// its small mark and name with the account under them, and both makers are laid out the same: a login billed per use
// reads in dollars whichever maker it is. A window is drawn as the context meter is (chat-vitals.tsx):
// one line, a hairline bar, a faint line. The marks are the only colour; amber only at a limit. The numbers and
// their timing are main's (src/core/usage.mjs); the words are usage-rules.ts. Near a limit, which account may be
// offered instead is the accounts' own rule (account-rules.ts `limitOffer`: one billed per use, never another plan),
// and taking the offer is the same switch as "Use" on an account's row in Settings.
// While this is not on screen nothing is read: it stops asking, and tells main so.
import { Fragment, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Spinner } from '@/components/ui/spinner';
import { limitOffer } from '@/lib/account-rules';
import { chooseAccount, useAccounts } from '@/lib/accounts';
import { api, type UsageSection, type UsageWindow } from '@/lib/api';
import { openAccounts } from '@/lib/signin';
import { StoreContext } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { readUsage, refreshUsage, useUsage, watchUsage } from '@/lib/usage';
import { MAKER, accountLine, ageText, attentionText, barWidth, countNote, countRows, creditsText, extraText, isHot, nearText, offerLabel, percentText, resetText, switchedText } from '@/lib/usage-rules';
import { cn } from '@/lib/utils';
import { RowSignIn, useAccountSignIn } from './account-prompt';
import { ProviderLogo } from './provider-logo';

// The same small button as an account row's in Settings (account-actions.tsx `ROW_BTN`).
const btn = 'flex h-7 w-fit shrink-0 items-center gap-1.5 rounded-lg border border-foreground/10 bg-card px-2.5 text-small font-medium shadow-[0_1px_1px_rgb(0_0_0/0.04)] hover:bg-accent disabled:pointer-events-none disabled:opacity-60 dark:bg-foreground/[0.06] dark:shadow-none dark:hover:bg-foreground/10';
// A name on the left, its number on the right: every row of this tab.
const row = 'flex items-baseline gap-3 text-ui';

const Checking = () => <div className="flex items-center gap-2.5 text-ui text-muted-foreground"><Spinner className="size-3.5" />Checking…</div>;

/** One window, drawn as the context meter is: its name and how full it is, a hairline bar, and when it starts over. */
function Meter({ w, now }: { w: UsageWindow; now: number }) {
  const hot = isHot(w, now);
  const resets = resetText(w.resetsAt, now);
  const percent = percentText(w.percent);
  return (
    <div>
      <div className={row}>
        <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{w.label}</span>
        <span className={cn('ml-auto shrink-0 font-medium tabular-nums', hot ? 'text-warn' : 'text-foreground')}>{percent}</span>
      </div>
      <div role="meter" aria-label={w.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.percent)} aria-valuetext={`${percent} used`}
        className="mt-2 h-[3px] overflow-hidden rounded-full bg-foreground/[0.08]">
        <div className={cn('h-full rounded-full transition-[width] duration-500 ease-out', hot ? 'bg-warn' : 'bg-foreground/55')} style={{ width: `${barWidth(w.percent)}%` }} />
      </div>
      {resets && <p className="mt-1.5 text-small text-faint tabular-nums">{resets}</p>}
    </div>
  );
}

/** A row's value, in the Stats tab's voice ("$1.84 spent"): its numbers stand, and the words with them ("of",
 *  "tokens", a state like "Off") are said quietly. */
function Value({ text }: { text: string }) {
  return (
    <span className="ml-auto min-w-0 truncate text-muted-foreground tabular-nums" title={text}>
      {text.split(' ').map((word, i) => (
        <Fragment key={i}>{i > 0 && ' '}{/\d/.test(word) ? <span className="font-medium text-foreground">{word}</span> : word}</Fragment>
      ))}
    </span>
  );
}

/** A name and its value on one line: extra usage, credits, what was spent. */
function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className={row}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <Value text={value} />
    </div>
  );
}

/** The last read did not work. What there was stays above; this says so, with its age, and offers to try again. */
function Unavailable({ s, now }: { s: UsageSection; now: number }) {
  return (
    <div className="space-y-2.5">
      <p className="text-ui text-muted-foreground">Usage isn’t available right now.</p>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => refreshUsage(s.engine)} disabled={s.loading} className={btn}>{s.loading && <Spinner className="size-3" />}Try Again</button>
        {s.at !== null && <p className="min-w-0 truncate text-small text-faint tabular-nums">{ageText(s.at, now)}</p>}
      </div>
    </div>
  );
}

/** Near a limit, and an account billed per use exists: a quiet offer to use it for new chats. Never taken for you. */
function Offer({ s }: { s: UsageSection }) {
  const [busy, setBusy] = useState(false);
  const accounts = useAccounts();
  const { near } = s;
  // Never another plan, and never the account these numbers are about.
  const offer = near ? limitOffer(accounts?.list, s.engine, s.account.id) : null;
  if (!near || !offer) return null;
  const take = async () => {
    setBusy(true);
    const r = await chooseAccount(s.engine, offer.id); // the list changing brings this tab its new numbers
    setBusy(false);
    const said = switchedText(offer);
    if (r.ok) toast(said.title, { description: said.description });
    else toast.error(r.message);
  };
  return (
    <div className="flex items-center gap-3 text-small">
      <span className="min-w-0 flex-1 text-muted-foreground">{nearText(near)}</span>
      <button type="button" onClick={take} disabled={busy} className={btn}>{offerLabel(offer)}</button>
    </div>
  );
}

/** A plan: a meter per window, extra usage, and how old the numbers are (click to read again). */
function Plan({ s, now }: { s: UsageSection; now: number }) {
  if (s.at === null && !s.error) return <Checking />;
  const read = s.at !== null; // there are numbers, from now or from before
  const credits = read && s.credits ? creditsText(s.credits) : null;
  return (
    <>
      {read && (s.windows ?? []).map((w) => <Meter key={w.key} w={w} now={now} />)}
      {read && s.extra && <Line label="Extra usage" value={extraText(s.extra)} />}
      {credits && <Line label="Credits" value={credits} />}
      {read && <Offer s={s} />}
      {s.error ? <Unavailable s={s} now={now} /> : s.at !== null && (
        <button type="button" onClick={() => refreshUsage(s.engine)} className="group/age flex items-center gap-1.5 rounded-sm text-small text-faint tabular-nums transition-colors hover:text-foreground">
          {ageText(s.at, now)}
          {s.loading ? <Spinner className="size-3" /> : <RefreshCwIcon aria-hidden className="size-3 opacity-0 transition-opacity group-hover/age:opacity-100 group-focus-visible/age:opacity-100" />}
        </button>
      )}
    </>
  );
}

/** Billed per use: Canopy's own count in dollars, Today first (it is always there; "This chat" comes and goes), and
 *  where the numbers come from. The same for either maker. */
function Count({ s, now }: { s: UsageSection; now: number }) {
  if (!s.count && !s.error) return <Checking />;
  return (
    <>
      {s.count && (
        <div>
          <ul className="space-y-2">
            {countRows(s.count).map(([k, v]) => <li key={k}><Line label={k} value={v} /></li>)}
          </ul>
          <p className="mt-2 text-small text-faint">{countNote(s)}</p>
        </div>
      )}
      {s.error && <Unavailable s={s} now={now} />}
    </>
  );
}

/** The account needs you before anything can be read for it: its maker's sign-in when that would fix it, else its
 *  maker's page in Settings, where the accounts are and what else one may need is (a new key, say). */
function Attention({ s }: { s: UsageSection }) {
  const signIn = useAccountSignIn(s.account);
  return (
    <div className="space-y-2.5">
      <p className="text-ui text-muted-foreground">{attentionText(s)}</p>
      {signIn ? <RowSignIn account={s.account} className={btn} />
        : <button type="button" onClick={() => openAccounts(s.engine)} className={btn}>Open Accounts</button>}
    </div>
  );
}

function Section({ s, now }: { s: UsageSection; now: number }) {
  const attention = s.shape === 'attention';
  const line = accountLine(s);
  // A plan's line ends in an address, which is cut short when it is long. Every other line is words ("billed by
  // your provider", what is wrong with the account): those are said in full, on a second line if they must be.
  const cut = s.shape === 'plan';
  return (
    <section className="space-y-5" aria-label={`${MAKER[s.engine]} usage`}>
      <div>
        <div className="flex items-center gap-2 text-ui font-medium">
          {/* The name is beside it, so the mark is not read out a second time. The image keeps a margin of its own:
              drawn at 24 in a box of 20, the mark itself is the 20. */}
          <span aria-hidden className="flex size-5 shrink-0 items-center justify-center"><ProviderLogo engine={s.engine} size={24} className="max-w-none" /></span>
          {MAKER[s.engine]}
        </div>
        {/* What is wrong, when something is, behind the one amber dot. */}
        <div className={cn('mt-1 flex gap-1.5 text-small', attention ? 'text-foreground/80' : 'text-muted-foreground')}>
          {attention && <span role="img" aria-label="Needs attention" className="mt-[5px] size-1.5 shrink-0 rounded-full bg-warn" />}
          <span className={cn('min-w-0', cut ? 'truncate' : '[overflow-wrap:anywhere]')} title={cut ? line : undefined}>{line}</span>
        </div>
      </div>
      {attention ? <Attention s={s} /> : s.shape === 'plan' ? <Plan s={s} now={now} /> : <Count s={s} now={now} />}
    </section>
  );
}

// The window is hidden or minimized: nobody is looking, so nothing is asked.
const usePageHidden = () => useSyncExternalStore(
  (cb) => { document.addEventListener('visibilitychange', cb); return () => document.removeEventListener('visibilitychange', cb); },
  () => document.hidden,
);
/** Which chat is on screen. Changes when another chat is opened, never per streamed frame. */
function useChatOnScreen() {
  const s = useContext(StoreContext);
  return useSyncExternalStore(s.subscribe, () => `${s.meta.engine}:${s.meta.sessionId ?? ''}`);
}
/** The time, moving on while the tab is on screen: ages ("Updated 3 min ago") and reset times read right. */
function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export function UsagePanel() {
  const { inspector, view, multi } = useUi();
  const hidden = usePageHidden();
  // Mounted is not the same as seen: the panel stays mounted behind Home and Multi mode, and in a hidden window.
  const onScreen = inspector && view === 'chat' && !multi && !hidden;
  const usage = useUsage();
  const accounts = useAccounts();
  const chat = useChatOnScreen();
  const now = useNow(onScreen);
  useEffect(() => (onScreen ? watchUsage() : undefined), [onScreen]);
  // Another chat came on screen, or the logins changed: what main sent last may be about something else now.
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) { settled.current = true; return; } // the first ask is watchUsage's
    if (onScreen) readUsage();
  }, [chat, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const sections = usage?.sections ?? [];
  return (
    // The Stats tab's margins. The rows are as wide as the panel allows, measured from the panel itself (cqw) and
    // not from what its scrollbar leaves: the numbers on the right do not shift when the tab starts to scroll.
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        <div className="ml-4 w-[calc(100cqw-2rem)] space-y-6">
          {!api.usage ? <p className="text-ui text-faint">Usage isn’t available right now.</p>
            : !usage || (!sections.length && usage.checking) ? <Checking />
            : !sections.length ? <p className="text-ui text-faint">No account found. Usage shows here once Claude Code or Codex is signed in.</p>
            : sections.map((s, i) => (
              <Fragment key={s.engine}>
                {i > 0 && <div className="border-t border-hairline" />}
                <Section s={s} now={now} />
              </Fragment>
            ))}
        </div>
      </div>
    </div>
  );
}

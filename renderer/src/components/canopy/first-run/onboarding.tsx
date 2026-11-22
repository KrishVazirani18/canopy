// Onboarding, on a plain dark page.
//
// 1. Hello: just the name and one button. The mark grows from its trunk, the name comes in beside it, then
//    "Get Started". Nothing is explained; the screens after it do the work.
// 1b. Your Canopy account: Continue with Google (needed for everyone), on the card.
// 2. Setting things up: Canopy finds Claude Code and Codex, and installs whichever is missing with the maker's own
//    installer. No questions; a short centred list of two rows ticks itself off, then Continue.
// 3. Your accounts: every login Canopy found, under Claude Code and under Codex. One is already picked for each (the
//    one the tool itself uses); a click picks another, or signs in to one more through the tool's own sign-in.
// Then the tour, inside Canopy. Usage stats aren't asked here: they're on by default, told once in the app, with a
// switch in Settings → Privacy (and no names are sent).
//
// Nothing moves once it is on screen: things that arrive later (a button, a progress bar, a changed line) fade in where
// their room was already kept, so the screen never shifts.
//
// Each screen runs off its own clock (`t`, ms since it opened), so any moment can be frozen and checked:
// ?onb=you|setup|accounts opens a screen directly, ?onbt=800 holds it at 0.8 s. ?fail=1 makes the Codex install fail;
// ?acc=none has Codex signed out.
// Reduced motion jumps to the end.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type CanopyAccountView } from '@/lib/api';
import { accountBridge } from '@/lib/canopy-account';
import { accountLine, chooseAccount, useAccounts } from '@/lib/accounts';
import { addProblem } from '@/lib/account-rules';
import { openSignIn } from '@/lib/signin';
import { loadModels } from '@/lib/engines';
import { arrangeModels, useAllModels } from '@/lib/models';
import type { Model as MenuModel } from '@/lib/model-rules';
import { useStore } from '@/lib/store';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';
import { ClaudeLogo, OpenAILogo } from '@/components/canopy/maker-logo';
import { cn } from '@/lib/utils';

// Switches for looking at one screen in the UI harness: ?onb=setup|accounts opens a screen; ?onbt=<ms> freezes its
// clock; ?fail=1, ?acc=none.
const PARAMS = new URLSearchParams(location.search);

// ---------- the clock ----------

const FROZEN = (() => { const v = new URLSearchParams(location.search).get('onbt'); return v != null && v !== '' ? Number(v) : null; })();
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function useClock(run: number) {
  const [t, setT] = useState(FROZEN ?? (still() ? 1e6 : 0));
  const skip = useRef(0);
  useEffect(() => {
    if (FROZEN != null || still()) return;
    let raf = 0; const start = performance.now(); skip.current = 0;
    const tick = (now: number) => { setT(now - start + skip.current); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run]);
  /** Jump to `to` ms if the clock is not there yet (a click skips the opening). */
  const jump = (to: number, now: number) => { if (now < to) skip.current += to - now; };
  return [t, jump] as const;
}
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const backOut = (x: number) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

// ---------- Canopy's mark, grown from its trunk ----------

const TIERS = [
  'M610 383H928Q942 383 940 368C925 300 860 256 785 256H750C676 256 612 300 598 368Q596 383 610 383Z',
  'M510 552H548Q556 552 562 546C580 528 605 515 638 515H898C931 515 956 528 974 546Q980 552 988 552H1028Q1040 552 1040 540C1040 470 975 411 902 411H634C561 411 497 470 497 540Q497 552 510 552Z',
  'M571 632H704C725 632 741 648 741 670V740Q741 751 752 751H784Q795 751 795 740V670C795 648 811 632 833 632H962Q977 632 976 616C970 575 932 542 897 542H640C602 542 565 575 559 616Q557 632 571 632Z',
];
// Each tier grows out of the one below it: the trunk tier first, then the middle, then the top.
const GROW = [[420, 820], [270, 670], [80, 520]] as const; // [start, end] ms, by tier index (0 top … 2 bottom)
function Mark({ t, size, color }: { t: number; size: number; color: string }) {
  return (
    <svg viewBox="468 203 600 600" width={size} height={size} style={{ color, overflow: 'visible' }} aria-label="Canopy">
      {TIERS.map((d, i) => {
        const k = span(t, GROW[i][0], GROW[i][1]);
        const s = mix(0.35, 1, backOut(k));
        // grow from the bottom centre of the tier, rising a little as it does
        const cy = [383, 552, 632][i], cx = 768;
        return (
          <g key={i} style={{ opacity: easeOut(k) }} transform={`translate(${cx} ${cy + (1 - easeOut(k)) * 26}) scale(${s}) translate(${-cx} ${-cy})`}>
            <path d={d} fill="currentColor" />
          </g>
        );
      })}
    </svg>
  );
}

// ---------- 1. Hello ----------

function Hello({ onNext }: { onNext: () => void }) {
  const [run, setRun] = useState(0);
  const [t, jump] = useClock(run);
  const OPENED = 1500; // the opening is over: everything is in place
  const name = easeOut(span(t, 450, 1050));
  const button = easeOut(span(t, 850, 1450));
  return (
    <div className="relative flex h-full w-full items-center justify-center" onClick={() => jump(OPENED, t)}>
      <Replay onClick={() => setRun((n) => n + 1)} />
      <div className="flex flex-col items-center">
        <div className="flex items-center gap-4">
          <Mark t={t} size={56} color="#f2f3f1" />
          <span className="text-[48px] font-semibold tracking-[-0.035em]" style={{ opacity: name, transform: `translateX(${(1 - name) * -6}px)` }}>Canopy</span>
        </div>
        <button className="mt-12 inline-flex h-11 items-center gap-2 rounded-lg bg-white px-5 text-[14.5px] font-medium text-black transition-opacity hover:opacity-90"
          style={{ opacity: button }} onClick={(e) => { e.stopPropagation(); onNext(); }}>
          Get Started <ArrowRightIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

// ---------- the accounts frame ----------
// Your Accounts lays its two makers side by side as two equal columns under a heading, with Continue at the bottom.


/** Scrollbars are hidden throughout onboarding: one that comes and goes as rows slide in takes width and shifts
 *  the card. Everything still scrolls with the trackpad or wheel. */
/** The card both steps sit on: the same size in the same place, the heading at the same spot and Continue at the
 *  same spot inside it, so moving from one step to the next only changes what's in the middle. */
function Page({ t, title, line, children, footer, footerShow }: { t: number; title: string; line: string; children: React.ReactNode; footer: React.ReactNode; footerShow: number }) {
  const card = easeOut(span(t, 0, 450));
  const head = easeOut(span(t, 80, 580));
  const body = easeOut(span(t, 200, 700));
  return (
    <div className="flex h-full w-full overflow-auto px-8 py-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="m-auto flex h-[620px] w-full max-w-[720px] shrink-0 flex-col rounded-[20px] border border-white/[0.08] bg-[#121312]/80 px-10 pb-9 pt-10 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)] backdrop-blur-md"
        style={{ opacity: card, transform: `scale(${mix(0.985, 1, card)})` }}>
        <div style={{ opacity: head, transform: `translateY(${(1 - head) * 6}px)` }}>
          <h1 className="h-[34px] text-[26px] font-semibold leading-[34px] tracking-[-0.025em]">{title}</h1>
          <p className="mt-1.5 h-[22px] text-[14.5px] leading-[22px] text-white/50">{line}</p>
        </div>
        <div className="mt-8 min-h-0" style={{ opacity: body, transform: `translateY(${(1 - body) * 6}px)` }}>{children}</div>
        <div className="mt-auto flex h-11 shrink-0 items-center gap-4 transition-opacity duration-500" style={{ opacity: footerShow, pointerEvents: footerShow > 0.5 ? 'auto' : 'none' }}>{footer}</div>
      </div>
    </div>
  );
}

function PrimaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="inline-flex h-11 items-center gap-2 rounded-lg bg-white px-5 text-[14.5px] font-medium text-black transition-opacity hover:opacity-90" onClick={onClick}>
      {children} <ArrowRightIcon className="size-4" />
    </button>
  );
}

const LOGO = {
  claude: <ClaudeLogo className="size-[18px] text-[#D97757]" />,
  codex: <OpenAILogo className="size-[18px] text-white" />,
};


// ---------- 1b. Your Canopy account ----------
// Right after Hello, on the same card as the steps after it. One button: Continue with Google, which opens Google in
// the browser (Supabase Auth, with the app listening on a local address for the answer). Back in Canopy the row turns
// into who you are, and Continue appears where its room was kept. Needed for everyone: it's how the project knows
// who's using Canopy. Nothing about Claude or Codex: this is Canopy's own account.

// Google's "G", as Google publishes it for sign-in buttons: its own four colours, never recoloured, on the button's
// white. It is Google's mark, used here only to say where the button leads.
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}


function AboutYou({ onNext }: { onNext: () => void }) {
  const [t] = useClock(0);
  const acct = accountBridge(); // missing in the design harness: the button then plays a stand-in sign-in
  const [state, setState] = useState<'idle' | 'waiting' | 'in'>('idle');
  const [me, setMe] = useState<Pick<CanopyAccountView, 'name' | 'email' | 'avatar'>>({ name: null, email: null, avatar: null });
  const [err, setErr] = useState<string | null>(null);
  // Signed in already (a second run, or another window): show who you are straight away.
  useEffect(() => {
    if (!acct) return;
    const take = (v: CanopyAccountView) => { if (v.signedIn) { setMe(v); setState('in'); } };
    acct.get().then((v) => { if (!('error' in v)) take(v); }).catch(() => {});
    return acct.onChanged(take);
  }, [acct]);
  const signIn = async () => {
    setErr(null);
    if (!acct) { setState('waiting'); setTimeout(() => { setMe({ name: 'Alex Rivera', email: 'alex@example.com', avatar: null }); setState('in'); }, 2200); return; }
    if (state === 'waiting') await acct.cancel(); // pressed again: start over (the browser tab may have been closed)
    setState('waiting');
    const r = await acct.signIn();
    if ('error' in r) { setState('idle'); if (r.error !== 'Cancelled.') setErr(r.error); return; }
    setMe(r); setState('in');
  };
  const initial = (me.name || me.email || '?').trim()[0]?.toUpperCase();
  const head = easeOut(span(t, 0, 500)), body = easeOut(span(t, 150, 650));
  // Centred and bare, like Hello: the mark, one line, one button. Signed in, the same spots hold your photo, your
  // name and Continue, so nothing moves.
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex w-[320px] flex-col items-center text-center">
        <div className="flex size-16 items-center justify-center" style={{ opacity: head }}>
          {state === 'in'
            ? (me.avatar
              ? <img src={me.avatar} alt="" className="size-16 rounded-full object-cover" />
              : <span className="flex size-16 items-center justify-center rounded-full bg-white/[0.1] text-[24px] font-medium">{initial}</span>)
            : <Mark t={1e6} size={44} color="#f2f3f1" />}
        </div>
        <h1 className="mt-6 h-[34px] text-[26px] font-semibold leading-[34px] tracking-[-0.025em]" style={{ opacity: head, transform: `translateY(${(1 - head) * 6}px)` }}>
          {state === 'in' ? (me.name ?? 'You’re In') : 'Create Your Account'}
        </h1>
        <p className="mt-1 h-5 truncate text-[13.5px] text-white/45" style={{ opacity: head }}>{state === 'in' ? me.email : ''}</p>
        <div className="mt-7 h-11 w-full" style={{ opacity: body, transform: `translateY(${(1 - body) * 6}px)` }}>
          {state === 'in' ? (
            <button onClick={onNext} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-white text-[14.5px] font-medium text-black transition-opacity hover:opacity-90">
              Continue <ArrowRightIcon className="size-4" />
            </button>
          ) : (
            <button onClick={signIn} className="inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-white text-[14.5px] font-medium text-black transition-opacity hover:opacity-90">
              {state === 'waiting'
                ? <><span className="size-4 animate-spin rounded-full border-[1.5px] border-black/15 border-t-black/70" /> Waiting for Google…</>
                : <><GoogleG className="size-[18px]" /> Continue with Google</>}
            </button>
          )}
        </div>
        {/* only when something went wrong; its room is kept */}
        <p className="mt-3 h-5 text-[12.5px] text-white/60">{state !== 'in' && err ? err : ''}</p>
      </div>
    </div>
  );
}

// ---------- 2. Setting things up ----------

// What the mock plays: Claude Code is already on this Mac; Codex isn't, so Canopy installs it.
type Step = { id: 'claude' | 'codex'; name: string; findAt: number; installAt?: number; doneAt: number; version: string };
const STEPS: Step[] = [
  { id: 'claude', name: 'Claude Code', findAt: 900, doneAt: 900, version: '2.1.325' },
  { id: 'codex', name: 'Codex', findAt: 1300, installAt: 1300, doneAt: 4300, version: '0.98.0' },
];
const FAIL = PARAMS.get('fail') === '1';

function stepState(st: Step, t: number, retriedAt: number | null) {
  if (t < st.findAt) return { kind: 'looking' as const, title: 'Looking…', line: 'Checking your Mac' };
  if (!st.installAt) return { kind: 'done' as const, title: 'Ready', line: `Already on your Mac · ${st.version}` };
  const fails = FAIL && retriedAt == null;
  const from = retriedAt ?? st.installAt, end = from + (st.doneAt - st.installAt);
  if (fails && t >= st.installAt + 1800) return { kind: 'failed' as const, title: 'Couldn’t Install', line: 'Check your connection.' };
  if (t < end) return { kind: 'installing' as const, title: 'Installing…', line: `Not on your Mac yet`, progress: easeInOut(span(t, from, fails ? from + 2600 : end)) };
  return { kind: 'done' as const, title: 'Ready', line: `Installed · ${st.version}` };
}

// The real thing, when main can do it: look for both (a fresh environment check), then install whichever is missing
// with its maker's own installer, one at a time. Null in the design harness, which plays the sample above instead.
type SetupRow = { kind: 'looking' | 'installing' | 'done' | 'failed'; title: string; line: string; progress?: number };
const versionOf = (v: string | null | undefined) => v?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? null;
function useRealSetup(): { rows: Record<'claude' | 'codex', SetupRow>; retry: (e: 'claude' | 'codex') => void } | null {
  const real = typeof api?.recheck === 'function' && typeof api?.setup?.install === 'function';
  const looking: SetupRow = { kind: 'looking', title: 'Looking…', line: 'Checking your Mac' };
  const [rows, setRows] = useState<Record<'claude' | 'codex', SetupRow>>({ claude: looking, codex: looking });
  const set = (e: 'claude' | 'codex', r: SetupRow) => setRows((all) => ({ ...all, [e]: r }));
  const installOne = async (e: 'claude' | 'codex') => {
    set(e, { kind: 'installing', title: 'Installing…', line: 'Not on your Mac yet' });
    const r = await api.setup!.install(e).catch((err) => ({ error: String(err?.message ?? err) }));
    if ('error' in r) { set(e, { kind: 'failed', title: 'Couldn’t Install', line: r.error }); return; }
    const v = versionOf(e === 'claude' ? r.env.version : r.env.codexVersion);
    set(e, { kind: 'done', title: 'Ready', line: v ? `Installed · ${v}` : 'Installed' });
  };
  useEffect(() => {
    if (!real) return;
    let here = true;
    (async () => {
      const env = await api.recheck().catch(() => null);
      if (!here || !env) return;
      const missing: ('claude' | 'codex')[] = [];
      for (const e of ['claude', 'codex'] as const) {
        const found = e === 'claude' ? env.claudePath : env.codexPath;
        const v = versionOf(e === 'claude' ? env.version : env.codexVersion);
        if (found) set(e, { kind: 'done', title: 'Ready', line: v ? `Already on your Mac · ${v}` : 'Already on your Mac' });
        else missing.push(e);
      }
      for (const e of missing) { if (here) await installOne(e); }
    })();
    return () => { here = false; };
  }, [real]); // eslint-disable-line react-hooks/exhaustive-deps
  return real ? { rows, retry: (e) => { void installOne(e); } } : null;
}

function Setup({ onNext }: { onNext: () => void }) {
  const [run, setRun] = useState(0);
  const [t] = useClock(run);
  const [retriedAt, setRetriedAt] = useState<number | null>(null);
  const real = useRealSetup();
  const states: SetupRow[] = real ? STEPS.map((st) => real.rows[st.id]) : STEPS.map((st) => stepState(st, t, retriedAt));
  const allDone = states.every((x) => x.kind === 'done');
  const anyFailed = states.some((x) => x.kind === 'failed');
  const doneAt = Math.max(...STEPS.map((st) => (st.installAt && retriedAt != null ? retriedAt + st.doneAt - st.installAt : st.doneAt)));
  const next = real ? (allDone || anyFailed ? 1 : 0) : easeOut(allDone ? span(t, doneAt + 200, doneAt + 700) : anyFailed ? 1 : 0);
  return (
    <>
      <Replay onClick={() => { setRetriedAt(null); setRun((n) => n + 1); }} />
      <Page t={t} title={allDone ? 'All Set' : 'Setting Things Up'} line={allDone ? 'Claude Code and Codex are ready.' : 'Canopy is getting Claude Code and Codex ready.'}
        footerShow={next} footer={<>
          <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
          {anyFailed && <span className="text-[13px] text-white/40">You can finish this later in Settings.</span>}
        </>}>
        {/* each row a fixed height, the bar and the buttons in room kept for them, so nothing moves as steps tick off */}
        <div className="flex flex-col">
          {STEPS.map((st, i) => {
            const x = states[i];
            return (
              <div key={st.id} className="relative flex h-[74px] items-center gap-3.5 border-t border-white/[0.07] last:border-b">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06]">{LOGO[st.id]}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-medium text-white/90">{st.name}</div>
                  <div className={cn('mt-0.5 truncate text-[13px]', x.kind === 'failed' ? 'text-white/75' : 'text-white/45')}>{x.kind === 'failed' ? (real ? x.line : 'Couldn’t install it. Check your connection.') : x.kind === 'installing' ? 'Installing…' : x.line}</div>
                </div>
                <div className="absolute bottom-[9px] left-[50px] right-0 h-[3px] overflow-hidden rounded-full bg-white/[0.08] transition-opacity duration-300" style={{ opacity: x.kind === 'installing' ? 1 : 0 }}>
                  {/* a real install can't say how far along it is: a short bar sweeps instead */}
                  {x.kind === 'installing' && x.progress == null
                    ? <div className="h-full w-[30%] rounded-full bg-white/70" style={{ transform: `translateX(${((t / 1400) % 1.3 - 0.3) * 333}%)` }} />
                    : <div className="h-full rounded-full bg-white/70" style={{ width: `${8 + (x.kind === 'installing' ? x.progress ?? 0 : 1) * 92}%` }} />}
                </div>
                <span className="flex h-7 w-[84px] shrink-0 items-center justify-end">
                  {x.kind === 'looking' && <span className="size-4 animate-spin rounded-full border-[1.5px] border-white/15 border-t-white/70" />}
                  {x.kind === 'done' && <CheckIcon className="size-[18px] text-white/80" strokeWidth={2.25} />}
                  {x.kind === 'failed' && (
                    <button className="whitespace-nowrap rounded-md bg-white/[0.08] px-2.5 py-1 text-[12.5px] text-white/85 hover:bg-white/[0.12]" onClick={() => (real ? real.retry(STEPS[i].id) : setRetriedAt(t))}>Try Again</button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </Page>
    </>
  );
}

// ---------- 3. Your accounts ----------

// What the mock plays: Claude Code has a plan login and an API key in the terminal; Codex has a ChatGPT login (or,
// with ?acc=none, nobody signed in). Signing in is played as: the tool's own page opens in the browser, then the new
// account appears in the same cell.
type Account = { id: string; title: string; line: string };
type Maker = { id: 'claude' | 'codex'; name: string; found: Account[]; added: Account };
const NONE = PARAMS.get('acc') === 'none';
const MAKERS: Maker[] = [
  { id: 'claude', name: 'Claude Code',
    found: [{ id: 'c-max', title: 'Claude Max', line: 'alex@example.com' }, { id: 'c-key', title: 'API Key', line: 'From your terminal · billed per use' }],
    added: { id: 'c-pro', title: 'Claude Pro', line: 'alex@example.org' } },
  { id: 'codex', name: 'Codex',
    found: NONE ? [] : [{ id: 'x-plus', title: 'ChatGPT Plus', line: 'alex@example.com' }],
    added: { id: 'x-plus', title: 'ChatGPT Plus', line: 'alex@example.com' } },
];
// Both columns have the same number of rows: the most accounts either maker has. A column with fewer leaves its
// cells empty. Signing in to one more is a link under each column, outside the table; the new account takes the
// column's first empty cell, or opens a new row that grows in (and Continue, pinned at the bottom, stays put).
const ROW_H = 64;

function Radio({ on }: { on: boolean }) {
  return (
    <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors duration-200', on ? 'border-white bg-white' : 'border-white/25')}>
      <span className={cn('size-[7px] rounded-full bg-black transition-opacity duration-200', on ? 'opacity-100' : 'opacity-0')} />
    </span>
  );
}

type Choice = { added: boolean; picked: string | null; signing: boolean };

/** A cell that grows in when it is new, and is simply there when the screen opens. */
function Grow({ children, fresh }: { children: React.ReactNode; fresh: boolean }) {
  const [open, setOpen] = useState(!fresh);
  useEffect(() => { if (!open) requestAnimationFrame(() => setOpen(true)); }, [open]);
  return <div className="overflow-hidden transition-[height] duration-300 ease-out" style={{ height: open ? ROW_H : 0 }}>{children}</div>;
}

function Accounts({ onNext }: { onNext: () => void }) {
  const [t] = useClock(0);
  const [picks, setPicks] = useState<Choice[]>(MAKERS.map((m) => ({ added: false, picked: m.found[0]?.id ?? null, signing: false })));
  const set = (i: number, p: Partial<Choice>) => setPicks((all) => all.map((x, j) => (j === i ? { ...x, ...p } : x)));
  // The real logins, when main has them (the same list and calls as Settings → Claude Code / Codex): which one each
  // engine's new chats use is the radio; signing in to another goes through the tool's own sign-in.
  const known = useAccounts();
  const live = typeof api?.accounts?.list === 'function' ? known : null;
  const [problem, setProblem] = useState<(string | null)[]>([null, null]);
  // The Claude or ChatGPT app on this Mac usually means a plan the tool isn't signed in to yet: say so, and offer the
  // tool's own sign-in right here. Only when no plan login is in the list already.
  const [apps, setApps] = useState<{ claude: boolean; chatgpt: boolean }>({ claude: false, chatgpt: false });
  useEffect(() => {
    if (typeof api?.setup?.apps !== 'function') return;
    api.setup.apps().then((r) => { if (!('error' in r)) setApps(r); }).catch(() => {});
  }, []);
  const planHint = (i: number): { title: string; line: string } | null => {
    if (!live) return null;
    const engine = MAKERS[i].id;
    if (live.list.some((a) => a.engine === engine && a.kind === 'plan')) return null;
    if (engine === 'claude' && apps.claude) return { title: 'Use Your Claude Plan', line: 'You have the Claude app. Sign in once to use your plan here.' };
    if (engine === 'codex' && apps.chatgpt) return { title: 'Use Your ChatGPT Plan', line: 'You have the ChatGPT app. Sign in once to use your plan here.' };
    return null;
  };
  const signIn = async (i: number) => {
    if (picks[i].signing) return;
    if (!live) {
      if (picks[i].added) return;
      set(i, { signing: true });
      setTimeout(() => set(i, { signing: false, added: true, picked: MAKERS[i].added.id }), 1800);
      return;
    }
    const engine = MAKERS[i].id;
    setProblem((p) => p.map((x, j) => (j === i ? null : x)));
    if (!live.list.some((a) => a.engine === engine)) { void openSignIn(engine); return; } // nobody signed in: the tool's own sign-in
    set(i, { signing: true });
    let r = null;
    try { r = (await (engine === 'codex' ? api.codexFolders?.add() : api.accountFolders?.add('plan'))) ?? null; } catch { r = null; }
    set(i, { signing: false });
    const why = addProblem(r);
    if (why) setProblem((p) => p.map((x, j) => (j === i ? why : x)));
  };
  const lists: Account[][] = live
    // a sign-in still being added (its folder made, nobody signed in yet) isn't an account to pick: left out here
    ? MAKERS.map((m) => live.list.filter((a) => a.engine === m.id && !(a.found === false && a.state === 'signed-out')).map((a) => ({ id: a.id, title: a.label, line: accountLine(a) })))
    : MAKERS.map((m, i) => (picks[i].added ? [...m.found, m.added] : m.found));
  const pickedOf = (i: number) => (live ? live.inUse[MAKERS[i].id] : picks[i].picked);
  const choose = (i: number, id: string) => (live ? void chooseAccount(MAKERS[i].id, id) : set(i, { picked: id }));
  const firstRows = useRef(Math.max(...lists.map((l) => l.length))); // rows there when the screen opened appear as they are; later ones grow in
  const startRows = firstRows.current;

  // Rows come in one after another as the screen opens, then stay put.
  const appear = (n: number) => { const k = easeOut(span(t, 200 + n * 70, 620 + n * 70)); return { opacity: k, transform: `translateY(${(1 - k) * 8}px)` }; };
  const tile = 'flex w-full items-center gap-3.5 rounded-xl border px-4 text-left transition-[background-color,border-color] duration-200';
  const accountCell = (i: number, a: Account) => {
    const on = pickedOf(i) === a.id;
    return (
      <button className={cn(tile, on ? 'border-white/[0.18] bg-white/[0.06]' : 'border-white/[0.06] bg-white/[0.025] hover:border-white/[0.1] hover:bg-white/[0.045]')}
        style={{ height: 64 }} onClick={() => choose(i, a.id)}>
        <Radio on={on} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-white/90">{a.title}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-white/45">{a.line}</div>
        </div>
      </button>
    );
  };
  const noneCell = (i: number) => (
    <div className={cn(tile, 'border-white/[0.06] bg-white/[0.025]')} style={{ height: 64 }}>
      <span className="size-[18px] shrink-0 rounded-full border border-dashed border-white/20" />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-white/90">Not Signed In</div>
        <div className="mt-0.5 truncate text-[12.5px] text-white/45">{picks[i].signing ? 'Finish in your browser…' : MAKERS[i].id === 'codex' ? 'Use your ChatGPT plan or an API key.' : 'Use your Claude plan or an API key.'}</div>
      </div>
    </div>
  );
  // The add row: one quiet line under each maker. When the maker's plan app is on the Mac it offers that plan
  // ("Use Your ChatGPT Plan", with a short reason); otherwise it signs in to another account. The same row either way,
  // so the two sections read alike.
  const addCell = (i: number) => {
    const hint = planHint(i);
    const busy = picks[i].signing;
    const label = busy ? 'Finish in your browser…' : problem[i] ?? hint?.title ?? (lists[i].length ? 'Sign In to Another Account' : `Sign In to ${MAKERS[i].name}`);
    const why = !busy && !problem[i] && hint ? hint.line.split('.')[0] : null; // "You have the ChatGPT app"
    return (
      <button className="group flex h-11 w-full items-center gap-3.5 rounded-xl px-4 text-left transition-colors hover:bg-white/[0.03] disabled:hover:bg-transparent"
        disabled={busy} onClick={() => signIn(i)}>
        <span className="flex size-[18px] shrink-0 items-center justify-center text-[16px] leading-none text-white/45 transition-colors group-hover:text-white/80">+</span>
        <span className={cn('min-w-0 flex-1 truncate text-[13.5px] transition-colors', problem[i] ? 'text-white/75' : hint && !busy ? 'text-white/80 group-hover:text-white' : 'text-white/45 group-hover:text-white/80')}>
          {label}{why && <span className="text-white/40"> · {why}</span>}
        </span>
        {hint && !busy && <span className="shrink-0 text-[12.5px] font-medium text-white/55 transition-colors group-hover:text-white/90">Sign In</span>}
      </button>
    );
  };

  let n = 0; // the order rows come in
  return (
    <Page t={t} title="Your Accounts" line={live && !lists.some((l) => l.length) ? 'Sign in to Claude Code, Codex or both.' : 'Canopy found these on your Mac. Pick one for each.'}
      footerShow={easeOut(span(t, 450, 950))} footer={<>
        <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
        <span className="text-[13px] text-white/40">You can change these any time in Settings.</span>
      </>}>
      {/* One section per maker, stacked and full width, so each account's whole line fits. The middle scrolls if
          someone has many logins; the heading and Continue stay where they are. */}
      <div className="-mr-2 flex max-h-[380px] flex-col gap-6 overflow-y-auto overflow-x-hidden pr-2 pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent)]">
        {MAKERS.map((m, i) => (
          <section key={m.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1 pb-0.5 text-[13px] font-medium text-white/55" style={appear(n++)}>{LOGO[m.id]}{m.name}</div>
            {(lists[i].length ? lists[i] : [null]).map((a, r) => (
              <div key={a?.id ?? 'none'} style={appear(n++)}><Grow fresh={r >= startRows}>{a ? accountCell(i, a) : noneCell(i)}</Grow></div>
            ))}
            <div style={appear(n++)}>{addCell(i)}</div>
          </section>
        ))}
      </div>
    </Page>
  );
}

// ---------- 5. Your models ----------
// The four in the menu under the message box. On top, the menu itself: four numbered slots. Below, every other model
// the accounts just chosen can use, two to a row. A click on a model puts it in the first empty slot; dragging it
// onto a slot puts it there (what was there goes back below); dragging a slot onto another swaps them; a click on a
// slot, or dragging it back onto the list, empties it. The four start empty. Saved the way Settings → Advanced → Model menu saves
// (arrangeModels), so the two always agree.

const MENU = 4;
const MakerMark = ({ m, size = 16 }: { m: MenuModel; size?: number }) => (
  <span className="flex shrink-0 [&_svg]:size-full" style={{ width: size, height: size }}>
    {m.maker === 'claude' ? <ClaudeLogo className="text-[#D97757]" /> : <OpenAILogo className="text-white" />}
  </span>
);

function Models({ onNext }: { onNext: () => void }) {
  const [t] = useClock(0);
  const { meta } = useStore();
  const all = useAllModels(meta);
  useEffect(() => { loadModels(); }, []); // the accounts may have changed on the screen before: ask for the lists again
  // The four start empty: you fill them.
  const [slots, setSlots] = useState<(string | null)[] | null>(null);
  const cur = slots ?? Array<string | null>(MENU).fill(null);
  const byKey = (k: string | null) => (k ? all.find((m) => m.key === k) ?? null : null);
  const want = Math.min(MENU, all.length);
  const filled = cur.filter(Boolean).length;
  const [over, setOver] = useState<number | null>(null); // the slot something is being dragged over

  const place = (key: string, at: number) => setSlots((p) => {
    const next = [...(p ?? cur)];
    const from = next.indexOf(key);
    if (from >= 0) next[from] = next[at]; // already in the menu: the two swap
    next[at] = key;
    return next;
  });
  const add = (key: string) => setSlots((p) => {
    const next = [...(p ?? cur)];
    const free = next.indexOf(null);
    if (free < 0 || next.includes(key)) return next;
    next[free] = key;
    return next;
  });
  const empty = (at: number) => setSlots((p) => { const next = [...(p ?? cur)]; next[at] = null; return next; });
  const done = () => {
    const rows = cur.map(byKey).filter((m): m is MenuModel => !!m);
    if (rows.length) arrangeModels(rows, all);
    onNext();
  };
  const rest = all.filter((m) => !cur.includes(m.key));
  const appear = (n: number) => { const k = easeOut(span(t, 200 + n * 40, 600 + n * 40)); return { opacity: k, transform: `translateY(${(1 - k) * 6}px)` }; };
  const drag = (key: string) => ({ draggable: true, onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/canopy-model', key); e.dataTransfer.effectAllowed = 'move'; } });

  return (
    <Page t={t} title="Pick Your Models" line="Drag or click four into your menu. They sit under the message box."
      footerShow={easeOut(span(t, 450, 950))} footer={<>
        <button disabled={filled < want} onClick={done}
          className="inline-flex h-11 items-center gap-2 rounded-lg bg-white px-5 text-[14.5px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">
          Start Using Canopy <ArrowRightIcon className="size-4" />
        </button>
        <span className="text-[13px] text-white/40">{filled < want ? `Pick ${want - filled} more.` : 'You can change these any time in Settings.'}</span>
      </>}>
      {/* the menu: four slots */}
      <div className="rounded-2xl border border-white/[0.1] bg-white/[0.03] p-2.5" style={appear(0)}>
        <div className="mb-2 flex items-center justify-between px-1.5 text-[12px] font-medium text-white/45"><span>Your menu</span><span className="tabular-nums">{filled} of {MENU}</span></div>
        <div className="grid grid-cols-4 gap-2">
          {cur.map((k, i) => {
            const m = byKey(k);
            return (
              <div key={i}
                onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragLeave={() => setOver((o) => (o === i ? null : o))}
                onDrop={(e) => { e.preventDefault(); setOver(null); const key = e.dataTransfer.getData('text/canopy-model'); if (key) place(key, i); }}
                className={cn('relative h-[76px] rounded-xl transition-colors duration-150',
                  m ? 'bg-white/[0.07]' : 'border border-dashed border-white/[0.14]', over === i && 'bg-white/[0.12] ring-1 ring-white/30')}>
                <span className={cn('absolute left-2.5 top-2 text-[11px] font-semibold tabular-nums', m ? 'text-white/40' : 'text-white/25')}>{i + 1}</span>
                {m ? (
                  <button {...drag(m.key)} onClick={() => empty(i)} title="Click to take out, or drag it to move or out"
                    className="group flex h-full w-full cursor-grab flex-col items-center justify-center gap-1.5 px-2 active:cursor-grabbing">
                    <MakerMark m={m} size={18} />
                    <span className="max-w-full truncate text-[13px] text-white/90">{m.label}</span>
                    <span aria-hidden className="absolute right-1.5 top-1 flex size-6 items-center justify-center rounded-md text-[18px] leading-none text-white/30 transition-colors group-hover:bg-white/[0.08] group-hover:text-white/80">×</span>
                  </button>
                ) : <span className="flex h-full items-center justify-center text-[12px] text-white/25">Empty</span>}
              </div>
            );
          })}
        </div>
      </div>
      {/* everything else, two to a row */}
      <div className="mt-5 mb-2 px-1 text-[12px] font-medium text-white/45" style={appear(1)}>All models</div>
      {/* dragging a model out of the menu onto this list takes it out */}
      <div onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const key = e.dataTransfer.getData('text/canopy-model'); const at = cur.indexOf(key); if (at >= 0) empty(at); }}
        className="-mr-2 grid max-h-[200px] grid-cols-2 gap-1.5 overflow-y-auto overflow-x-hidden pr-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]">
        {rest.map((m, i) => (
          <button key={m.key} {...drag(m.key)} onClick={() => add(m.key)} disabled={filled >= MENU} style={appear(i + 2)}
            className="flex h-11 cursor-grab items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-white/[0.05] active:cursor-grabbing disabled:cursor-grab disabled:hover:bg-white/[0.03]">
            <MakerMark m={m} size={15} />
            <div className="min-w-0 flex-1 truncate text-[13.5px] text-white/85">{m.label}</div>
            <span className="text-[16px] leading-none text-white/25">+</span>
          </button>
        ))}
        {!all.length && <p className="col-span-2 px-1 py-6 text-[13.5px] text-white/45">Looking for your models…</p>}
      </div>
    </Page>
  );
}

// ---------- backgrounds: ASCII light, in green ----------
// Hello looks up into the canopy: dense across the top, a ragged lower edge where the crowns end, the characters
// being the light that gets through. The steps after it look down at the forest floor: the same light, landed,
// spread wide and flat across the bottom, fainter, slightly blurred so it stays behind the lists. Both step a few
// times a second like a terminal while a slow breeze moves the pattern, and both fill in as the screen opens.

/** A running clock for the backgrounds (held still by ?onbt, like the screens). */
function useTime() {
  const [t, setT] = useState(FROZEN ?? 0);
  useEffect(() => {
    if (FROZEN != null || still()) return;
    let raf = 0; const start = performance.now();
    const tick = (now: number) => { setT(now - start); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}
/** A small seeded random, so every background is the same every time. */
const rand = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/** Smooth 2D value noise, seeded, in [0, 1]. */
function makeNoise(seed: number) {
  const r = rand(seed), N = 256, perm = Array.from({ length: N }, (_, i) => i).sort(() => r() - 0.5), val = Array.from({ length: N }, () => r());
  const at = (x: number, y: number) => val[perm[(perm[x & 255] + (y & 255)) & 255]];
  const sm = (k: number) => k * k * (3 - 2 * k);
  const n2 = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x: number, y: number) => (n2(x, y) * 0.55 + n2(x * 2.1, y * 2.1) * 0.3 + n2(x * 4.3, y * 4.3) * 0.15);
}
const RAMP = ' ·:;+*%';
const GREENS = ['#152419', '#1a2f20', '#203a28', '#274631', '#2f533a', '#386144'];
const sm = (a: number, b: number, v: number) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };

export type Field = 'canopy' | 'floor' | 'spots';

/** Soft spots of light drifting across the whole screen, each on its own slow loop. */
const SPOTS = [
  { x: 0.18, y: 0.28, r: 0.13, ax: 0.10, ay: 0.08, px: 61, py: 47, ph: 0.0 },
  { x: 0.78, y: 0.22, r: 0.11, ax: 0.09, ay: 0.10, px: 53, py: 71, ph: 1.7 },
  { x: 0.62, y: 0.78, r: 0.15, ax: 0.12, ay: 0.07, px: 79, py: 59, ph: 3.1 },
  { x: 0.28, y: 0.74, r: 0.12, ax: 0.08, ay: 0.09, px: 67, py: 83, ph: 4.4 },
  { x: 0.90, y: 0.58, r: 0.10, ax: 0.07, ay: 0.12, px: 89, py: 64, ph: 2.3 },
  { x: 0.06, y: 0.55, r: 0.09, ax: 0.06, ay: 0.11, px: 73, py: 97, ph: 5.2 },
];

export function AsciiLight({ t, field }: { t: number; field: Field }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const noise = useMemo(() => makeNoise(field === 'canopy' ? 5 : 13), [field]);
  const edgeNoise = useMemo(() => makeNoise(9), []);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const fit = () => setSize((s) => (s.W === c.offsetWidth && s.H === c.offsetHeight ? s : { W: c.offsetWidth, H: c.offsetHeight }));
    const ro = new ResizeObserver(fit); ro.observe(c); fit();
    return () => ro.disconnect();
  }, []);
  const step = Math.floor(t / 110); // a terminal's pace, not a video's
  useEffect(() => {
    const c = ref.current; if (!c || !size.W) return;
    const { W, H } = size, dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const CW = 8, CH = 13, cols = Math.ceil(W / CW), rows = Math.ceil(H / CH);
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'top';
    const time = step * 110;
    const grow = easeOut(span(time, 0, 2000));
    const wind = time / (field === 'canopy' ? 7000 : 11000);
    const secs = time / 1000;
    const spots = SPOTS.map((b) => ({
      x: b.x + b.ax * Math.sin((secs / b.px) * Math.PI * 2 + b.ph),
      y: b.y + b.ay * Math.cos((secs / b.py) * Math.PI * 2 + b.ph * 1.3),
      r: b.r * (1 + 0.12 * Math.sin((secs / (b.px * 0.7)) * Math.PI * 2 + b.ph)),
    }));
    for (let j = 0; j < rows; j++) {
      const y = j / rows;
      for (let i = 0; i < cols; i++) {
        const x = i / cols;
        let v: number;
        if (field === 'canopy') {
          // the canopy covers the top; where it ends is a row of rounded crowns
          const edge = 0.42 + 0.1 * edgeNoise(x * 4, 1.5) + 0.12 * Math.pow(Math.abs(x - 0.5) * 2, 1.6);
          const region = sm(edge * grow, edge * grow - 0.22, y);
          if (region <= 0) continue;
          // light through the leaves: openings, and small flecks around them
          const open = sm(0.54, 0.76, noise(x * 9 + wind, y * 6.5 - wind * 0.3));
          const fleck = sm(0.6, 0.8, noise(x * 22 - wind * 1.4, y * 15 + 3)) * 0.5;
          v = (open * 0.8 + fleck) * region;
        } else if (field === 'spots') {
          // blobs: each spot is a soft disc, wobbled by noise so its edge is never a clean circle
          const aspect = W / H;
          let blob = 0;
          for (const b of spots) {
            const dx = (x - b.x) * aspect, dy = y - b.y;
            const d = Math.sqrt(dx * dx + dy * dy) / b.r;
            blob += 1 - sm(0.35, 1.15, d + 0.35 * (noise(x * 7 + wind, y * 7 - wind) - 0.5));
          }
          if (blob <= 0.02) continue;
          const fleck = sm(0.6, 0.82, noise(x * 20 - wind, y * 26 + 5)) * 0.35;
          v = Math.min(1, blob) * (0.7 + fleck) * grow;
        } else {
          // the floor: light pools along the bottom, wide and flat as if seen at an angle, thinning toward the middle
          const top = 1 - 0.5 * grow;
          const region = sm(top, top + 0.35, y) * 0.85;
          if (region <= 0) continue;
          const pool = sm(0.55, 0.78, noise(x * 6 + wind, y * 13 - wind * 0.2));
          const fleck = sm(0.62, 0.82, noise(x * 18 - wind, y * 30 + 5)) * 0.45;
          v = (pool * 0.75 + fleck) * region;
        }
        v = Math.min(0.999, v);
        if (v < 0.1) continue;
        const ch = RAMP[Math.floor(v * RAMP.length)];
        if (ch === ' ') continue;
        g.fillStyle = GREENS[Math.min(GREENS.length - 1, Math.floor(v * GREENS.length))];
        g.fillText(ch, i * CW, j * CH);
      }
    }
  }, [step, size, noise, edgeNoise, field]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" style={{ filter: field !== 'canopy' ? 'blur(1.2px)' : 'blur(0.4px)' }} />;
}

function Backdrop({ field }: { field: Field }) {
  const t = useTime();
  return (
    <div className="pointer-events-none absolute inset-0">
      <AsciiLight t={t} field={field} />
      {/* a soft pool of the page colour in the middle, so the light never touches the words */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse 34% 26% at 50% 50%, rgba(14,15,14,0.85), rgba(14,15,14,0) 100%)' }} />
    </div>
  );
}

// ---------- the flow ----------

/** The design-only controls (Replay, Back to Hello): shown in the Playground and the harness, never on a real first run. */
const Design = createContext(true);

function Replay({ onClick }: { onClick: () => void }) {
  if (!useContext(Design)) return null;
  return (
    <button className="absolute bottom-4 right-5 z-10 rounded-md px-2 py-1 text-[12px] text-white/35 hover:text-white/70"
      onClick={(e) => { e.stopPropagation(); onClick(); }}>Replay</button>
  );
}

const SCREENS = ['hello', 'you', 'setup', 'accounts', 'models'] as const;
type Screen = (typeof SCREENS)[number];
const START: Screen = (SCREENS as readonly string[]).includes(PARAMS.get('onb') ?? '') ? (PARAMS.get('onb') as Screen) : 'hello';

/** `onFinish`: what Continue on the last step does (run on its own, the flow goes round to Hello again). */
export default function Onboarding({ onFinish, design = true }: { onFinish?: () => void; design?: boolean } = {}) {
  const [screen, setScreen] = useState<Screen>(START);
  // A screen leaves by fading out a little upward; the next comes in on its own clock.
  const [leaving, setLeaving] = useState(false);
  const go = (to: Screen) => { setLeaving(true); setTimeout(() => { setScreen(to); setLeaving(false); }, 260); };
  // A copy built from source has no Canopy account (main says so): Hello goes straight on to setting things up.
  const [hasAccount, setHasAccount] = useState(true);
  useEffect(() => { accountBridge()?.get().then((v) => { if (!('error' in v) && v.available === false) setHasAccount(false); }).catch(() => {}); }, []);
  return (
    <Design.Provider value={design}>
    <div className="relative h-full w-full overflow-hidden bg-[#0e0f0e] text-white">
      {/* Hello has its own background; the steps after it share the dappled light. Each fades as the screen changes. */}
      <div className="absolute inset-0 transition-opacity duration-700" style={{ opacity: screen === 'hello' ? 1 : 0 }}><Backdrop field="canopy" /></div>
      <div className="absolute inset-0 transition-opacity duration-700" style={{ opacity: screen === 'hello' ? 0 : 1 }}><Backdrop field="floor" /></div>
      <div key={screen} className="relative h-full w-full transition-[opacity,transform] duration-[260ms] ease-out" style={{ opacity: leaving ? 0 : 1, transform: leaving ? 'translateY(-6px)' : 'none' }}>
        {screen === 'hello' && <Hello onNext={() => go(hasAccount ? 'you' : 'setup')} />}
        {screen === 'you' && <AboutYou onNext={() => go('setup')} />}
        {screen === 'setup' && <Setup onNext={() => go('accounts')} />}
        {screen === 'accounts' && <Accounts onNext={() => go('models')} />}
        {screen === 'models' && <Models onNext={() => (onFinish ? onFinish() : go('hello'))} />}
      </div>
      {design && screen !== 'hello' && (
        <button className="absolute bottom-4 left-5 z-10 rounded-md px-2 py-1 text-[12px] text-white/35 hover:text-white/70" onClick={() => go('hello')}>Back to Hello</button>
      )}
    </div>
    </Design.Provider>
  );
}

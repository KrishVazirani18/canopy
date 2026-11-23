// The product tour: right after onboarding, over the real Canopy window. Five stops, each a spotlight on the real
// thing and one short card beside it; nothing to learn that isn't already on screen.
//   1. the message box     ask for anything
//   2. the model menu      Claude or ChatGPT, picked here
//   3. New Chat            start a few; they all keep working
//   4. Home                the board: what needs you, what's working, what's finished (the tour opens Home for it)
//   5. Needs You           where a chat that asks you something lands; this is where Canopy asks for notifications,
//                          when the reason is in front of you
// Then the tour closes on Home, and a quiet row above your name in the sidebar says usage stats are on (the notice decided for
// telemetry). The spotlight glides between stops; the card fades out and in beside its target and never covers it.
//
// It runs over the app itself: open the UI harness at ?mock=tour (main.tsx draws the app with this on top).
import { useEffect, useRef, useState } from 'react';
import { BarChart3Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { ui } from '@/lib/ui';


/** "Turn On Notifications": Canopy posts its first notification, which is what makes macOS ask (src/main.mjs). The
 *  design harness has no bridge: there the browser's own permission prompt stands in. */
function enableNotifications() {
  if (typeof api?.enableNotifications === 'function') void api.enableNotifications().catch(() => {});
  else void globalThis.Notification?.requestPermission?.();
}

// ---------- finding the real things ----------

const byText = (sel: string, test: (t: string) => boolean) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => test((e.textContent ?? '').trim()));
/** The nearest ancestor that draws its own border (the visible box around a control). */
const boxed = (el: Element | null | undefined) => {
  for (let e = el as HTMLElement | null; e && e !== document.body; e = e.parentElement) if (parseFloat(getComputedStyle(e).borderTopWidth) > 0) return e;
  return el as HTMLElement | null;
};
/** The nearest ancestor whose text holds all of `words`. */
const holding = (el: Element | null | undefined, words: string[]) => {
  for (let e = el as HTMLElement | null; e && e !== document.body; e = e.parentElement) if (words.every((w) => e!.textContent?.includes(w))) return e;
  return null;
};

// side 'inside': low in a big target's own empty space
type Stop = { find: () => Element | null; view: 'chat' | 'home'; side: 'below' | 'right' | 'inside'; title: string; line: string };
const STOPS: Stop[] = [
  { view: 'chat', side: 'below', find: () => boxed(document.querySelector('[data-chat-view="main"] textarea, [data-chat-view="main"] [contenteditable="true"]')),
    title: 'Ask for Anything', line: 'Type what you want done. Claude or ChatGPT works on it, right on your Mac.' },
  // The chip is tagged (controls.tsx): its words vary ("Opus 5.5", or "opus-5-5" before Claude Code has listed its models).
  { view: 'chat', side: 'below', find: () => document.querySelector('[data-chat-view="main"] [data-tour="model"]')
      ?? byText('[data-chat-view="main"] button', (t) => /^(opus|sonnet|haiku|fable|gpt|o\d)/i.test(t)) ?? null,
    title: 'Pick Who Does It', line: 'Switch between Claude and ChatGPT here, any time, even in the middle of a chat.' },
  { view: 'chat', side: 'right', find: () => byText('aside a, aside button, nav a, nav button', (t) => t.startsWith('New Chat')) ?? null,
    title: 'Start a Few at Once', line: 'Each chat keeps working on its own while you start the next one.' },
  { view: 'home', side: 'inside', find: () => holding(byText('div, span, h2, h3', (t) => t === 'Needs You'), ['Needs You', 'Working', 'Finished']),
    title: 'Everything on One Board', line: 'Home shows every chat at once: what needs you, what’s working, and what’s finished.' },
  { view: 'home', side: 'right', find: () => holding(byText('div, span, h2, h3', (t) => t === 'Needs You'), ['Needs You', 'Approvals']),
    title: 'What Needs You Comes First', line: 'When a chat asks you something, it lands here and moves to the top of the sidebar with a dot. Canopy can tell you even when it’s in the background.' },
];
const START = (() => {
  const v = new URLSearchParams(location.search).get('tour');
  if (v === 'done') return STOPS.length;
  const n = Number(v);
  return n >= 1 && n <= STOPS.length ? n - 1 : 0;
})();

// ---------- the tour over the app ----------

type Box = { x: number; y: number; w: number; h: number };
const PAD = 6, CARD_W = 340, GAP = 14;

// How it moves. One loop runs while the tour is up: each frame it finds the stop's target (the app may still be laying
// out, or switching to Home) and moves the spotlight toward it on a spring, writing straight to the element so React
// never re-renders mid-glide. The glide eases in and out over a time that grows a little with the distance, starting
// gently instead of leaping; it always aims at where the target is this frame, so if the app is still settling the
// glide bends toward the new place instead of restarting. The card only appears once the spotlight has landed, placed
// from where it landed; between stops it fades out, moves while invisible, and fades in.
/** A stop whose target can't be found this long is passed over: the tour never leaves the window dimmed with no card. */
const MISSING_MS = 2000;
/** And whatever else goes wrong (a target that never holds still, an error), a stop whose card isn't up this long is
 *  passed over too. The first stop gets longer: the app may still be starting. */
const STUCK_MS = 4000;
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** `onFinished`: the tour is over (done or skipped). `design`: show Replay (the harness), never on a real first run. */
export function TourOverlay({ onFinished, design = true }: { onFinished?: () => void; design?: boolean } = {}) {
  const [at, setAt] = useState(START);
  const [cardOn, setCardOn] = useState(false);
  const [noticeIn, setNoticeIn] = useState(false);
  const [gone, setGone] = useState(false);
  const [shown, setShown] = useState(false); // the dim fades in once, when the tour starts
  const done = at >= STOPS.length;
  const stop = STOPS[Math.min(at, STOPS.length - 1)];
  const spot = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null);
  const cur = useRef<Box | null>(null);
  const dir = useRef<1 | -1>(1); // which way the last move went: a stop that can't be found is passed over that way
  const go = (n: number) => { dir.current = n < at ? -1 : 1; setAt(n); };

  useEffect(() => {
    if (done) { ui.set({ view: 'home' }); return; } // the tour ends on Home, where every launch starts
    setCardOn(false);
    let raf = 0, landedFor = 0, last = performance.now(), placed = false, from: Box | null = null, t0 = 0, dur = 0, missing = 0;
    const began = performance.now();
    const passOver = () => { setAt((n) => (dir.current < 0 && n > 0 ? n - 1 : n + 1)); if (dir.current < 0 && at === 0) dir.current = 1; };
    const frame = (now: number) => {
      if (!placed && now - began > (cur.current ? STUCK_MS : STUCK_MS * 2)) { passOver(); return; }
      try { step(now); } catch { passOver(); return; } // a stop that throws is passed over, never left half-drawn
      raf = requestAnimationFrame(frame);
    };
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      // the app may still be starting (and opening a new chat as it does): keep asking for the stop's view until it holds
      if (ui.get().view !== stop.view) ui.set({ view: stop.view });
      const el = stop.find();
      const r = el?.getBoundingClientRect();
      if (!(r && r.width && r.height)) {
        // Not on screen (yet): wait a moment for the app to lay out, then pass over it rather than hang.
        missing += dt * 1000;
        // The first stop waits longer: the app may still be starting.
        if (missing > (cur.current ? MISSING_MS : MISSING_MS * 3)) throw new Error('missing'); // passed over by frame()
      } else {
        missing = 0;
        const target: Box = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
        if (!cur.current) cur.current = { ...target }; // first stop: start where it is, no flight in from nowhere
        if (!from) { // the glide for this stop starts from wherever the spotlight is now
          from = { ...cur.current }; t0 = now;
          const dist = Math.hypot(target.x - from.x, target.y - from.y) + Math.abs(target.w - from.w) * 0.5 + Math.abs(target.h - from.h) * 0.5;
          dur = dist < 1 ? 1 : Math.min(720, 380 + dist * 0.35);
        }
        const k = ease(Math.min(1, (now - t0) / dur));
        const c = cur.current;
        for (const p of ['x', 'y', 'w', 'h'] as const) c[p] = from[p] + (target[p] - from[p]) * k;
        const still = k >= 1;
        if (spot.current) {
          spot.current.style.transform = `translate(${c.x}px, ${c.y}px)`;
          spot.current.style.width = `${c.w}px`;
          spot.current.style.height = `${c.h}px`;
          spot.current.style.opacity = '1';
        }
        landedFor = still ? landedFor + dt : 0;
        // Landed (and held still a moment): place the card from where the target is, then show it.
        const cd = card.current;
        if (cd && landedFor > 0.06) {
          const W = window.innerWidth, H = window.innerHeight, ch = cd.offsetHeight;
          const clampX = (x: number) => Math.min(W - CARD_W - 16, Math.max(16, x));
          const clampY = (y: number) => Math.min(H - ch - 16, Math.max(16, y));
          const t = target;
          const p = stop.side === 'right' ? { x: t.x + t.w + GAP, y: clampY(t.y - 4) }
            : stop.side === 'inside' ? { x: clampX(t.x + t.w / 2 - CARD_W / 2), y: clampY(t.y + t.h * 0.55) }
            : t.y + t.h + GAP + ch < H - 16 ? { x: clampX(t.x + t.w / 2 - CARD_W / 2), y: t.y + t.h + GAP }
            : { x: clampX(t.x + t.w / 2 - CARD_W / 2), y: clampY(t.y - GAP - ch) };
          cd.style.left = `${p.x}px`; cd.style.top = `${p.y}px`;
          if (!placed) { placed = true; setCardOn(true); }
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }, []);
  useEffect(() => { if (!done) return; onFinished?.(); const id = setTimeout(() => setNoticeIn(true), 450); return () => clearTimeout(id); }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keyboard: Return or → goes on, ← goes back, Esc skips.
  useEffect(() => {
    if (done) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); dir.current = 1; setAt((n) => n + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); dir.current = -1; setAt((n) => Math.max(0, n - 1)); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dir.current = 1; setAt(STOPS.length); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [done]);

  const restart = () => { setNoticeIn(false); setGone(false); cur.current = null; dir.current = 1; setAt(0); };
  if (gone) return design ? <Replay onClick={restart} /> : null;
  const last = at === STOPS.length - 1;

  return (
    <div className="fixed inset-0 z-[100]" style={{ pointerEvents: done ? 'none' : 'auto' }}>
      {/* the spotlight: everything dims but the target. Moved by the loop above, never by React. */}
      <div ref={spot} className="pointer-events-none absolute left-0 top-0 rounded-xl"
        style={{ opacity: 0, boxShadow: `0 0 0 9999px rgba(0,0,0,${done || !shown ? 0 : 0.55}), 0 0 0 1px rgba(255,255,255,${done ? 0 : 0.14})`, transition: 'box-shadow 400ms ease', willChange: 'transform, width, height' }} />
      {!done && (
        <div ref={card} className="absolute left-0 top-0 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-[var(--elev-pop)]"
          style={{ width: CARD_W, opacity: cardOn ? 1 : 0, transform: `translateY(${cardOn ? 0 : 4}px)`, transition: cardOn ? 'opacity 220ms ease, transform 260ms cubic-bezier(0.22,1,0.36,1)' : 'opacity 120ms ease', pointerEvents: cardOn ? 'auto' : 'none' }}>
          <div className="text-[14.5px] font-semibold">{stop.title}</div>
          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">{stop.line}</p>
          <div className="mt-4 flex h-8 items-center gap-1">
            <span className="flex-1 whitespace-nowrap text-[12px] tabular-nums text-faint">{at + 1} of {STOPS.length}</span>
            {at > 0 && !last && <button className="h-8 whitespace-nowrap rounded-md px-2.5 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => go(at - 1)}>Back</button>}
            {!last && <button className="h-8 whitespace-nowrap rounded-md px-2.5 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => go(STOPS.length)}>Skip</button>}
            {last && <button className="h-8 whitespace-nowrap rounded-md px-2.5 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => go(STOPS.length)}>Not Now</button>}
            <button className="ml-1 h-8 whitespace-nowrap rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90" onClick={() => { if (last) enableNotifications(); go(at + 1); }}>
              {last ? 'Turn On Notifications' : 'Next'}
            </button>
          </div>
        </div>
      )}
      {/* the end: usage stats are on, said once, as a quiet row docked above your name in the sidebar (the same shape as
          "Update ready"), rising in */}
      {done && <StatsNotice show={noticeIn} onSettings={() => { ui.openSettings('privacy'); setGone(true); }} onOk={() => setGone(true)} />}
      {design && <Replay onClick={restart} />}
    </div>
  );
}

function StatsNotice({ show, onSettings, onOk }: { show: boolean; onSettings: () => void; onOk: () => void }) {
  // Sits over the bottom of the sidebar, just above the account row, as wide as the sidebar.
  const [at, setAt] = useState<{ left: number; width: number; bottom: number } | null>(null);
  useEffect(() => {
    const place = () => {
      const side = document.querySelector('aside');
      if (!side) return;
      const r = side.getBoundingClientRect();
      const account = [...side.querySelectorAll<HTMLElement>('*')].reverse().find((e) => e.getBoundingClientRect().bottom > r.bottom - 4 && e.getBoundingClientRect().height > 36 && e.getBoundingClientRect().height < 80);
      const top = account?.getBoundingClientRect().top ?? r.bottom - 56;
      setAt({ left: r.left, width: r.width - 1, bottom: window.innerHeight - top });
    };
    place();
    const id = setInterval(place, 250); // the sidebar may still be drawing; keep it lined up
    window.addEventListener('resize', place);
    return () => { clearInterval(id); window.removeEventListener('resize', place); };
  }, []);
  if (!at) return null;
  return (
    <div className="pointer-events-auto absolute border-t border-sidebar-border bg-sidebar px-2 py-2 transition-[opacity,transform] duration-300 ease-out"
      style={{ left: at.left, width: at.width, bottom: at.bottom, opacity: show ? 1 : 0, transform: `translateY(${show ? 0 : 8}px)` }}>
      <div className="flex items-center gap-3 rounded-md py-1 pl-3 pr-1.5">
        <BarChart3Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui text-foreground">Usage stats are on</div>
          <button className="block truncate text-left text-small text-muted-foreground hover:text-foreground" onClick={onSettings}>Never your chats · Settings</button>
        </div>
        <button onClick={onOk} className="h-7 shrink-0 rounded-md px-2.5 text-small text-foreground/85 ring-1 ring-hairline transition-colors hover:bg-sidebar-hover hover:text-foreground">OK</button>
      </div>
    </div>
  );
}

function Replay({ onClick }: { onClick: () => void }) {
  return (
    <button className="pointer-events-auto fixed right-4 top-12 z-[101] rounded-md px-2 py-1 text-[12px] text-muted-foreground/70 hover:text-foreground" onClick={onClick}>
      Replay tour
    </button>
  );
}

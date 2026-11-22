// Compare: two things in the same place. A font against today's with a divider to drag, and copy set in the page it
// will live on, at desktop and phone size, so line breaks and length are judged where they matter.
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Caption, Dot, PickConfirm, Scaled, Segments, Stack, choice, tone, usePick, type Opt } from './kit';

// ---------- fonts ----------
const FONTS: (Opt & { font: string })[] = [
  { id: 'sf', label: 'SF Pro', hint: 'The Mac’s own', font: '-apple-system, "SF Pro Text", system-ui', rec: true },
  { id: 'rounded', label: 'SF Rounded', hint: 'Softer', font: 'ui-rounded, "SF Pro Rounded", system-ui' },
  { id: 'avenir', label: 'Avenir Next', hint: 'Geometric', font: '"Avenir Next", Avenir, system-ui' },
];
const NOW = 'Geist, ui-sans-serif, system-ui';
function Paragraph({ font }: { font: string }) {
  return (
    <div style={{ fontFamily: font }} className="flex h-[200px] flex-col gap-3 bg-card p-5">
      <div className="text-[22px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>Fix the Font Picker</div>
      <p className="text-[15px] leading-[1.6] text-foreground">I moved the restart card into main, so a window reload keeps it. Your three queued messages go out in the order you set.</p>
      <div className="mt-auto flex items-center justify-between rounded-xl border border-hairline px-3 py-2 text-[13px]"><span className="text-faint">Add a follow-up</span><span><span className="text-foreground">Opus 5.5</span> <span className="text-muted-foreground">High</span></span></div>
    </div>
  );
}
export function Fonts() {
  const p = usePick(FONTS, { start: ['sf'] });
  const cand = FONTS.find((f) => f.id === p.shown)!;
  const [at, setAt] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const move = (x: number) => setAt(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)));
    move(e.clientX);
    const mv = (ev: PointerEvent) => move(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  return (
    <div onKeyDown={p.keys}>
      <div className="mb-2 flex items-center gap-1.5" onMouseLeave={() => p.point(null)}>
        {FONTS.map((f) => (
          <button key={f.id} type="button" {...choice(p, f.id)} style={{ fontFamily: f.font }}
            className={cn('flex h-7 items-center gap-1.5 rounded-full border px-3 text-small transition-colors', p.is(f.id) ? 'border-foreground/40 bg-accent text-foreground' : 'border-hairline text-muted-foreground hover:text-foreground', p.sent && !p.is(f.id) && 'opacity-45')}>
            {f.label}{f.rec && <Dot />}
          </button>
        ))}
      </div>
      <div className="mb-1.5 flex justify-between px-1 text-[12px] text-muted-foreground"><span>Now · Geist</span><span>{cand.label}</span></div>
      <div ref={box} onPointerDown={drag} className="relative cursor-ew-resize touch-none overflow-hidden rounded-xl border border-hairline select-none">
        <Paragraph font={cand.font} />
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}><Paragraph font={NOW} /></div>
        <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${at}%` }}>
          <span className="absolute top-1/2 left-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-background text-[10px] text-muted-foreground">⇆</span>
        </div>
      </div>
      <PickConfirm p={p} say={([l]) => `Use ${l} for the interface`} />
    </div>
  );
}

// ---------- copy, in place, at every size ----------
const LINES: (Opt & { head: string; sub: string })[] = [
  { id: 'calm', label: 'Calm', hint: '7 words', head: 'Calm software for people who build with AI.', sub: 'Every Claude Code and Codex chat in one window.', rec: true },
  { id: 'triage', label: 'Triage', hint: '4 words', head: 'Your AI chats, triaged.', sub: 'See what needs you, what’s working, and what’s done.' },
  { id: 'nothing', label: 'Nothing New', hint: '9 words', head: 'Runs the Claude Code you already have. Nothing to learn.', sub: 'Free for Mac. Your subscription, your tokens.' },
];
function Hero({ l, phone }: { l: (typeof LINES)[number]; phone: boolean }) {
  return (
    <div className={cn('flex h-full w-full flex-col', phone ? 'px-7 pt-20' : 'px-[120px] pt-[150px]')} style={{ background: '#0f1a14', color: '#eef5f0' }}>
      <div className={cn('flex items-center justify-between', phone ? 'absolute top-7 right-7 left-7' : 'absolute top-10 right-[120px] left-[120px]')} style={{ color: '#a9c4b3', fontSize: phone ? 15 : 17 }}>
        <span className="font-semibold" style={{ color: '#eef5f0' }}>Canopy</span>{!phone && <span className="flex gap-8"><span>Features</span><span>Pricing</span><span>Docs</span></span>}
      </div>
      <div className="font-semibold" style={{ fontSize: phone ? 40 : 84, lineHeight: 1.04, letterSpacing: '-0.035em', maxWidth: phone ? undefined : 900 }}>{l.head}</div>
      <div className="mt-5" style={{ fontSize: phone ? 17 : 24, lineHeight: 1.45, color: '#a9c4b3', maxWidth: 640 }}>{l.sub}</div>
      <div className="mt-8 flex gap-3"><span className="rounded-full px-6 py-3 font-medium" style={{ background: '#eef5f0', color: '#0f1a14', fontSize: phone ? 15 : 18 }}>Download for Mac</span></div>
    </div>
  );
}
export function Copy() {
  const p = usePick(LINES);
  const [size, setSize] = useState<'desktop' | 'phone'>('desktop');
  const phone = size === 'phone';
  return (
    <div onKeyDown={p.keys}>
      <div className="mb-2 flex items-center justify-between">
        <Segments value={size} onChange={setSize} options={[{ id: 'desktop', label: 'Desktop' }, { id: 'phone', label: 'Phone' }]} />
        <span className="text-[12px] text-muted-foreground">The headline, where it will live</span>
      </div>
      <div className={cn('grid gap-3', phone ? 'grid-cols-[260px_1fr]' : 'grid-cols-1')}>
        <div className={cn('mx-auto w-full overflow-hidden border border-hairline', phone ? 'rounded-[34px] p-1.5' : 'rounded-xl')}>
          <div className={cn('overflow-hidden', phone && 'rounded-[28px]')}>
            <Stack ids={LINES.map((l) => l.id)} shown={p.shown} render={(id) => <Scaled w={phone ? 390 : 1280} h={phone ? 760 : 640}><div className="relative h-full w-full"><Hero l={LINES.find((l) => l.id === id)!} phone={phone} /></div></Scaled>} />
          </div>
        </div>
        <div className={cn('grid gap-2', phone ? 'content-start' : 'grid-cols-3')} onMouseLeave={() => p.point(null)}>
          {LINES.map((l) => (
            <button key={l.id} type="button" {...choice(p, l.id)} className={cn(tone(p, l.id), 'flex flex-col gap-1.5 border border-hairline p-3')}>
              <span className="text-[13px] leading-[1.4] text-foreground">“{l.head}”</span>
              <Caption p={p} o={l} />
            </button>
          ))}
        </div>
      </div>
      <PickConfirm p={p} say={([l]) => `Use the ${l} headline: “${LINES.find((x) => x.label === l)!.head}”`} />
    </div>
  );
}

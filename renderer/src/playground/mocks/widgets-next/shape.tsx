// Shape: more than picking one. Swatches that recolor a live preview, sliders that tune a design and send the
// values, a remix across directions, notes pinned on a design, a ranking, keeping several, and motion that plays.
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { BRANDS } from './pick';
import { Caption, Confirm, PickConfirm, Scaled, Segments, choice, tone, usePick, type Opt } from './kit';

// ---------- colors: swatches recolor a live preview ----------
const COLORS: (Opt & { c: string })[] = [
  { id: 'leaf', label: 'Leaf', hint: 'Today’s green', c: '#4fae7c', rec: true },
  { id: 'sky', label: 'Sky', hint: 'Calm blue', c: '#4a9eff' },
  { id: 'amber', label: 'Amber', hint: 'Reads as a warning', c: '#f0a63a' },
  { id: 'rose', label: 'Rose', hint: 'Warmer, louder', c: '#e5607a' },
  { id: 'violet', label: 'Violet', hint: 'Unusual on a Mac', c: '#9b7bff' },
];
export function Colors() {
  const p = usePick(COLORS);
  const c = COLORS.find((x) => x.id === p.shown)!.c;
  return (
    <div onKeyDown={p.keys} className="grid grid-cols-[1fr_220px] gap-3">
      <div className="flex flex-col gap-1 rounded-xl border border-hairline bg-sidebar p-3">
        <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Needs You</div>
        {[['Fix the Font Picker', 'Waiting on you · 2m', true], ['Launch Deck', 'Asking to run a command', true], ['Usage Telemetry', 'Working', false], ['Sidebar Row Sizing', 'Done · 14m', false]].map(([t, s, on]) => (
          <div key={t as string} className="flex items-center justify-between rounded-lg px-2.5 py-2">
            <div><div className="text-ui text-foreground">{t}</div><div className="text-[12px] text-muted-foreground">{s}</div></div>
            {on && <span className="size-2 rounded-full transition-colors duration-200" style={{ background: c }} />}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1" onMouseLeave={() => p.point(null)}>
        {COLORS.map((x) => (
          <button key={x.id} type="button" {...choice(p, x.id)} className={cn(tone(p, x.id), 'flex items-center gap-3 px-2.5 py-2')}>
            <span className={cn('size-6 shrink-0 rounded-full', p.is(x.id) && 'ring-2 ring-foreground ring-offset-2 ring-offset-background')} style={{ background: x.c }} />
            <span className="min-w-0"><span className="block text-ui">{x.label}</span><span className="block truncate text-[12px] text-muted-foreground">{x.hint}</span></span>
          </button>
        ))}
      </div>
      <div className="col-span-2"><PickConfirm p={p} say={([l]) => `Make the needs-you dot ${l}`} /></div>
    </div>
  );
}

// ---------- tune: sliders on a live preview, the values go back ----------
type Knobs = { radius: number; pad: number; gap: number; shadow: boolean };
const START: Knobs = { radius: 10, pad: 14, gap: 6, shadow: false };
function Slider({ label, value, min, max, unit = 'px', onChange, disabled }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex justify-between text-small"><span className="text-muted-foreground">{label}</span><span className="text-foreground tabular-nums">{value}{unit}</span></span>
      <input type="range" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-foreground" />
    </label>
  );
}
export function Tune() {
  const [k, setK] = useState<Knobs>(START);
  const [sent, setSent] = useState(false);
  const set = (patch: Partial<Knobs>) => setK((x) => ({ ...x, ...patch }));
  const changed = JSON.stringify(k) !== JSON.stringify(START);
  return (
    <div>
      <div className="grid grid-cols-[1fr_230px] gap-3">
        <div className="flex flex-col rounded-xl border border-hairline bg-sidebar p-4" style={{ gap: k.gap }}>
          {[['Fix the Font Picker', 'Waiting on you · 2m'], ['Launch Deck', 'Done · 1h'], ['Usage Telemetry', 'Working']].map(([t, s], i) => (
            <div key={t} className="flex items-center justify-between border border-hairline bg-card transition-all duration-150"
              style={{ borderRadius: k.radius, padding: `${k.pad * 0.7}px ${k.pad}px`, boxShadow: k.shadow ? '0 1px 2px rgba(0,0,0,.25), 0 8px 20px -8px rgba(0,0,0,.45)' : 'none' }}>
              <div><div className="text-ui">{t}</div><div className="text-[12px] text-muted-foreground">{s}</div></div>
              {i === 0 && <span className="size-2 rounded-full bg-brand" />}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-4 rounded-xl border border-hairline p-4">
          <Slider label="Corner radius" value={k.radius} min={0} max={24} onChange={(radius) => set({ radius })} disabled={sent} />
          <Slider label="Padding" value={k.pad} min={8} max={28} onChange={(pad) => set({ pad })} disabled={sent} />
          <Slider label="Space between" value={k.gap} min={0} max={20} onChange={(gap) => set({ gap })} disabled={sent} />
          <label className="flex items-center justify-between text-small"><span className="text-muted-foreground">Shadow</span><input type="checkbox" role="switch" checked={k.shadow} disabled={sent} onChange={(e) => set({ shadow: e.target.checked })} className="accent-foreground" /></label>
          <button type="button" disabled={!changed || sent} onClick={() => setK(START)} className="self-start text-small text-muted-foreground hover:text-foreground disabled:opacity-0">Reset</button>
        </div>
      </div>
      <Confirm ready={changed} button="Use these values" sent={sent} onSend={() => setSent(true)}
        message={`Set the chat cards to radius ${k.radius}px, padding ${k.pad}px, ${k.gap}px between, shadow ${k.shadow ? 'on' : 'off'}`} />
    </div>
  );
}

// ---------- remix: take each part from a different direction ----------
const TYPE = [{ id: 'serif', label: 'Serif', font: 'ui-serif, "New York", Georgia, serif' }, { id: 'grotesk', label: 'Grotesk', font: '-apple-system, system-ui' }, { id: 'rounded', label: 'Rounded', font: 'ui-rounded, system-ui' }] as const;
type TypeId = (typeof TYPE)[number]['id'];
type LayoutId = 'center' | 'split';
export function Remix() {
  const [type, setType] = useState<TypeId>('serif');
  const [color, setColor] = useState<string>('forest');
  const [layout, setLayout] = useState<LayoutId>('split');
  const [sent, setSent] = useState(false);
  const b = BRANDS.find((x) => x.id === color)!;
  const font = TYPE.find((t) => t.id === type)!.font;
  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="flex items-center gap-2 text-small text-muted-foreground">Type <Segments value={type} onChange={setType} disabled={sent} options={TYPE.map((t) => ({ id: t.id, label: t.label }))} /></span>
        <span className="flex items-center gap-2 text-small text-muted-foreground">Colors <Segments value={color} onChange={setColor} disabled={sent} options={BRANDS.map((x) => ({ id: x.id, label: x.label }))} /></span>
        <span className="flex items-center gap-2 text-small text-muted-foreground">Layout <Segments value={layout} onChange={setLayout} disabled={sent} options={[{ id: 'center', label: 'Centered' }, { id: 'split', label: 'Split' }]} /></span>
      </div>
      <div className="overflow-hidden rounded-xl border border-hairline">
        <Scaled w={1280} h={560}>
          <div className={cn('flex h-full w-full gap-16 px-[110px] transition-colors duration-200', layout === 'center' ? 'flex-col items-center justify-center text-center' : 'items-center')} style={{ background: b.bg, color: b.fg, fontFamily: font }}>
            <div className={cn(layout === 'split' && 'flex-1')}>
              <div className="text-[30px] font-semibold" style={{ color: b.accent, letterSpacing: '-0.02em' }}>{b.word}</div>
              <div className="mt-6 text-[76px] leading-[1.04] font-semibold" style={{ letterSpacing: '-0.03em', maxWidth: layout === 'center' ? 900 : undefined }}>Calm software for people who build with AI.</div>
              <div className={cn('mt-9 flex gap-4', layout === 'center' && 'justify-center')}><span className="rounded-full px-7 py-3.5 text-[20px] font-medium" style={{ background: b.accent, color: b.bg }}>Download for Mac</span></div>
            </div>
            {layout === 'split' && <div className="grid w-[380px] grid-cols-2 gap-3">{b.colors.map(([n, c]) => <div key={n} className="h-[120px] rounded-2xl" style={{ background: c, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,.25)' }} />)}</div>}
          </div>
        </Scaled>
      </div>
      <Confirm ready button="Use this mix" sent={sent} onSend={() => setSent(true)}
        message={`Go with ${TYPE.find((t) => t.id === type)!.label.toLowerCase()} type, ${b.label} colors and the ${layout === 'center' ? 'centered' : 'split'} layout`} />
    </div>
  );
}

// ---------- mark up: pin notes on the design itself ----------
type Pin = { x: number; y: number; note: string };
export function Markup() {
  const [pins, setPins] = useState<Pin[]>([{ x: 31, y: 37, note: 'Headline is one line too long' }]);
  const [sent, setSent] = useState(false);
  const add = (e: React.MouseEvent<HTMLDivElement>) => {
    if (sent || (e.target as HTMLElement).closest('[data-pin]')) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPins((ps) => [...ps, { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, note: '' }]);
  };
  const notes = pins.filter((pn) => pn.note.trim());
  return (
    <div>
      <div className="grid grid-cols-[1fr_240px] gap-3">
        <div className="relative cursor-crosshair overflow-hidden rounded-xl border border-hairline" onClick={add}>
          <Scaled w={1280} h={800}>
            <div className="flex h-full w-full flex-col px-[110px] pt-10" style={{ background: '#0f1a14', color: '#eef5f0' }}>
              <div className="flex items-center justify-between text-[17px]" style={{ color: '#a9c4b3' }}><span className="font-semibold" style={{ color: '#eef5f0' }}>Canopy</span><span className="flex gap-8"><span>Features</span><span>Pricing</span><span>Docs</span></span></div>
              <div className="mt-[110px] max-w-[900px] text-[80px] leading-[1.04] font-semibold" style={{ letterSpacing: '-0.035em' }}>Calm software for people who build with AI, every day.</div>
              <div className="mt-6 text-[24px]" style={{ color: '#a9c4b3' }}>Every Claude Code and Codex chat in one window.</div>
              <div className="mt-9 flex gap-3"><span className="rounded-full px-7 py-3.5 text-[19px] font-medium" style={{ background: '#eef5f0', color: '#0f1a14' }}>Download for Mac</span><span className="rounded-full px-7 py-3.5 text-[19px]" style={{ border: '1px solid #3d5a49' }}>Watch the tour</span></div>
              <div className="mt-auto grid grid-cols-3 gap-6 pb-12">{['Triage, not tabs', 'Every account', 'Nothing to learn'].map((t) => <div key={t} className="rounded-2xl p-6 text-[20px]" style={{ background: '#16261d' }}>{t}</div>)}</div>
            </div>
          </Scaled>
          {pins.map((pn, i) => (
            <span key={i} data-pin className="absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background shadow-md ring-2 ring-background" style={{ left: `${pn.x}%`, top: `${pn.y}%` }}>{i + 1}</span>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-small text-muted-foreground">Click the design to add a note there.</div>
          {pins.map((pn, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-semibold text-background">{i + 1}</span>
              <textarea rows={2} value={pn.note} disabled={sent} autoFocus={!pn.note && i === pins.length - 1} placeholder="What should change here?"
                onChange={(e) => setPins((ps) => ps.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                className="min-h-0 flex-1 resize-none rounded-md border border-hairline bg-transparent px-2.5 py-1.5 text-small outline-none focus:border-foreground/40" />
              {!sent && <button type="button" aria-label="Remove note" onClick={() => setPins((ps) => ps.filter((_, j) => j !== i))} className="mt-1.5 text-faint hover:text-foreground">×</button>}
            </div>
          ))}
        </div>
      </div>
      <Confirm ready={notes.length > 0} button={`Send ${notes.length || ''} note${notes.length === 1 ? '' : 's'}`.replace('  ', ' ')} sent={sent} onSend={() => setSent(true)}
        message={`Changes to the landing page:\n${pins.map((pn, i) => (pn.note.trim() ? `${i + 1}. ${describe(pn)}: ${pn.note.trim()}` : '')).filter(Boolean).join('\n')}`} />
    </div>
  );
}
/** Where a pin sits, in words the model can act on (a real widget would send the element under it). */
const describe = (pn: Pin) => (pn.y < 12 ? 'Top bar' : pn.y < 52 ? 'Headline' : pn.y < 75 ? 'Buttons' : 'Feature cards');

// ---------- rank: drag into order ----------
const ITEMS = [
  { id: 'widgets', t: 'Visual widgets', d: 'This: pick, tune, mark up' },
  { id: 'codex', t: 'Widgets in Codex chats', d: 'Same toolkit for OpenAI' },
  { id: 'effort', t: 'Effort per chat', d: 'Like the model now is' },
  { id: 'site', t: 'Download site', d: 'Quiet launch page' },
  { id: 'bench', t: 'Benchmark run', d: 'Terminal-Bench, three tools' },
];
export function Rank() {
  const [order, setOrder] = useState(ITEMS.map((i) => i.id));
  const [drag, setDrag] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const moveTo = (id: string, over: string) => setOrder((o) => { if (id === over) return o; const a = o.filter((x) => x !== id); a.splice(o.indexOf(over), 0, id); return a; });
  return (
    <div>
      <div className="flex flex-col gap-1.5">
        {order.map((id, i) => {
          const it = ITEMS.find((x) => x.id === id)!;
          return (
            <div key={id} draggable={!sent} onDragStart={() => setDrag(id)} onDragEnd={() => setDrag(null)} onDragOver={(e) => { e.preventDefault(); if (drag) moveTo(drag, id); }}
              className={cn('flex items-center gap-3 rounded-lg border border-hairline bg-card px-3 py-2.5 transition-colors', !sent && 'cursor-grab active:cursor-grabbing', drag === id && 'border-foreground/40 bg-accent')}>
              <span className="w-4 text-center text-small text-muted-foreground tabular-nums">{i + 1}</span>
              <svg viewBox="0 0 16 16" className="size-3.5 text-faint"><g fill="currentColor">{[4, 8, 12].map((y) => [6, 10].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.1" />))}</g></svg>
              <div className="min-w-0 flex-1"><div className="text-ui">{it.t}</div><div className="text-[12px] text-muted-foreground">{it.d}</div></div>
            </div>
          );
        })}
      </div>
      <Confirm ready button="Use this order" sent={sent} onSend={() => setSent(true)} message={`Do them in this order:\n${order.map((id, i) => `${i + 1}. ${ITEMS.find((x) => x.id === id)!.t}`).join('\n')}`} />
    </div>
  );
}

// ---------- choose many: keep or cut ----------
const STEPS: (Opt & { draw: () => React.ReactNode })[] = [
  { id: 'welcome', label: 'Welcome', hint: 'The mark and one line', rec: true, draw: () => <div className="flex h-full flex-col items-center justify-center gap-6 bg-background"><div className="flex flex-col items-center gap-2">{[60, 90, 120].map((w) => <div key={w} className="h-5 rounded-full bg-brand/80" style={{ width: w }} />)}</div><div className="text-[44px] font-semibold">Welcome to Canopy</div></div> },
  { id: 'signin', label: 'Sign In', hint: 'Google, one button', rec: true, draw: () => <div className="flex h-full flex-col items-center justify-center gap-6 bg-background"><div className="text-[40px] font-semibold">Sign in</div><div className="rounded-full border border-hairline px-10 py-4 text-[24px]">Continue with Google</div></div> },
  { id: 'tools', label: 'Your Tools', hint: 'Claude Code and Codex found', rec: true, draw: () => <div className="flex h-full flex-col justify-center gap-4 bg-background px-40">{['Claude Code 2.1.328', 'Codex 0.170.0'].map((t) => <div key={t} className="flex items-center justify-between rounded-2xl border border-hairline px-8 py-6 text-[26px]">{t}<span className="text-muted-foreground">Ready</span></div>)}</div> },
  { id: 'folder', label: 'Pick a Folder', hint: 'Where chats start', draw: () => <div className="flex h-full flex-col items-center justify-center gap-6 bg-background"><div className="text-[40px] font-semibold">Pick a project</div><div className="rounded-2xl border border-dashed border-hairline px-24 py-14 text-[24px] text-muted-foreground">Drop a folder here</div></div> },
  { id: 'theme', label: 'Look', hint: 'Light, dark, size', draw: () => <div className="flex h-full items-center justify-center gap-8 bg-background">{['#f4f4f4', '#1b1b1b'].map((c) => <div key={c} className="h-[300px] w-[380px] rounded-2xl border border-hairline" style={{ background: c }} />)}</div> },
  { id: 'tour', label: 'Tour', hint: 'Four stops over the app', draw: () => <div className="relative h-full bg-background"><div className="absolute top-[30%] left-[18%] w-[460px] rounded-2xl border border-hairline bg-card p-8 text-[24px] shadow-xl">This is where chats that need you show up.</div></div> },
];
export function Many() {
  const p = usePick(STEPS, { many: true, start: STEPS.filter((s) => s.rec).map((s) => s.id) });
  return (
    <div onKeyDown={p.keys}>
      <div className="grid grid-cols-3 gap-2.5" onMouseLeave={() => p.point(null)}>
        {STEPS.map((s) => (
          <button key={s.id} type="button" {...choice(p, s.id)} className={cn(tone(p, s.id, 'rounded-xl'), 'flex flex-col gap-2 p-1.5')}>
            <div className={cn('overflow-hidden rounded-md ring-1 ring-hairline transition-opacity', !p.is(s.id) && 'opacity-50')}><Scaled w={1280} h={800}>{s.draw()}</Scaled></div>
            <Caption p={p} o={s} className="px-1 pb-0.5" />
          </button>
        ))}
      </div>
      <PickConfirm p={p} verb="Keep" say={(ls) => `Keep these onboarding screens: ${ls.join(', ')}. Cut the rest.`} />
    </div>
  );
}

// ---------- motion: options that play ----------
const MOTION: (Opt & { anim: string })[] = [
  { id: 'fade', label: 'Fade', hint: '150ms, nothing moves', anim: 'wn-fade 150ms ease-out both' },
  { id: 'rise', label: 'Rise', hint: '8px up, 220ms', anim: 'wn-rise 220ms cubic-bezier(.2,.8,.2,1) both', rec: true },
  { id: 'scale', label: 'Grow', hint: 'From 96%, 200ms', anim: 'wn-scale 200ms cubic-bezier(.2,.8,.2,1) both' },
  { id: 'spring', label: 'Spring', hint: 'Overshoots a little', anim: 'wn-spring 520ms cubic-bezier(.34,1.56,.64,1) both' },
];
const KEYFRAMES = `
@keyframes wn-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes wn-rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes wn-scale { from { opacity: 0; transform: scale(.96) } to { opacity: 1; transform: none } }
@keyframes wn-spring { from { opacity: 0; transform: translateY(18px) scale(.94) } to { opacity: 1; transform: none } }`;
export function Motion() {
  const p = usePick(MOTION);
  const [plays, setPlays] = useState<Record<string, number>>({});
  const play = (id: string) => setPlays((x) => ({ ...x, [id]: (x[id] ?? 0) + 1 }));
  return (
    <div onKeyDown={p.keys}>
      <style>{KEYFRAMES}</style>
      <div className="grid grid-cols-4 gap-2.5" onMouseLeave={() => p.point(null)}>
        {MOTION.map((m) => (
          <button key={m.id} type="button" {...choice(p, m.id)} onMouseEnter={() => { p.point(m.id); play(m.id); }} className={cn(tone(p, m.id, 'rounded-xl'), 'flex flex-col gap-3 border border-hairline p-3')}>
            <div className="flex h-[110px] items-center justify-center rounded-lg bg-sidebar">
              <div key={plays[m.id] ?? 0} className="w-[80%] rounded-lg border border-hairline bg-card px-3 py-2.5" style={{ animation: m.anim }}>
                <div className="text-[12px]">Restart when done</div><div className="text-[11px] text-muted-foreground">Canopy restarts after 2 chats</div>
              </div>
            </div>
            <Caption p={p} o={m} />
          </button>
        ))}
      </div>
      <div className="mt-2 text-[12px] text-faint">Point at one to play it again.</div>
      <PickConfirm p={p} say={([l]) => `Cards should enter with ${l.toLowerCase()}`} />
    </div>
  );
}

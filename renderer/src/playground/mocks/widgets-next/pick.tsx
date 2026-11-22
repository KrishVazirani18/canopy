// Pick: one of a few, judged by eye. Each is laid out for what it shows: a slide large over real thumbnails, brand
// boards side by side, a screen at true size beside a list, an icon in the Dock, a card in a feed, a chart.
import { cn } from '@/lib/utils';
import { Caption, PickConfirm, Scaled, Stack, choice, tone, usePick, type Opt } from './kit';

// ---------- deck ----------
const SERIF = 'ui-serif, "New York", Georgia, serif';
const SLIDES: (Opt & { draw: () => React.ReactNode })[] = [
  { id: 'editorial', label: 'Editorial', hint: 'Warm paper, a serif headline', draw: () => (
    <div className="flex h-full w-full flex-col justify-between p-[88px]" style={{ background: '#f3eee4', color: '#1c1a15' }}>
      <div className="flex justify-between text-[20px] tracking-[0.2em] uppercase" style={{ color: '#7a7264' }}><span>Canopy</span><span>Launch · November 2026</span></div>
      <div>
        <div className="max-w-[1000px] text-[100px] leading-[1.02]" style={{ fontFamily: SERIF, letterSpacing: '-0.02em' }}>Calm software for people who build with AI.</div>
        <div className="mt-8 h-[3px] w-24" style={{ background: '#2f6b4f' }} />
      </div>
    </div>) },
  { id: 'forest', label: 'Night Forest', hint: 'Dark, the mark large', rec: true, draw: () => (
    <div className="flex h-full w-full items-center gap-[96px] px-[120px]" style={{ background: 'radial-gradient(120% 90% at 20% 30%, #183a2a 0%, #0c1712 70%)', color: '#eef5f0' }}>
      <div className="flex flex-col items-center gap-[14px]">{[150, 230, 310].map((w, i) => <div key={w} className="rounded-full" style={{ width: w, height: 56, background: ['#8fd1a8', '#4fae7c', '#2c7a52'][i] }} />)}</div>
      <div>
        <div className="text-[140px] leading-none font-semibold" style={{ letterSpacing: '-0.04em' }}>Canopy</div>
        <div className="mt-6 max-w-[620px] text-[34px] leading-[1.35]" style={{ color: '#a9c4b3' }}>Every Claude Code and Codex chat, calm and in one place.</div>
      </div>
    </div>) },
  { id: 'product', label: 'Product First', hint: 'The app does the talking', draw: () => (
    <div className="flex h-full w-full items-center gap-[64px] px-[96px]" style={{ background: '#121212', color: '#f2f2f2' }}>
      <div className="w-[440px] shrink-0">
        <div className="text-[76px] leading-[1.05] font-semibold" style={{ letterSpacing: '-0.03em' }}>Your chats, triaged.</div>
        <div className="mt-6 text-[28px] leading-[1.4]" style={{ color: '#9a9a9a' }}>See what needs you, what’s working, and what’s done.</div>
      </div>
      <MiniApp />
    </div>) },
];
function MiniApp() {
  return (
    <div className="flex h-[520px] flex-1 overflow-hidden rounded-[22px]" style={{ background: '#1b1b1b', boxShadow: '0 40px 80px -20px rgba(0,0,0,.6), 0 0 0 1px #2a2a2a', color: '#f2f2f2' }}>
      <div className="flex w-[230px] flex-col gap-2 p-5" style={{ background: '#161616', borderRight: '1px solid #262626' }}>
        {[['Fix the Font Picker', 'Waiting on you', true], ['Sidebar Row Sizing', 'Done · 14m', false], ['Usage Telemetry', 'Working', false], ['Launch Deck', 'Done · 1h', false]].map(([t, s, on]) => (
          <div key={t as string} className="rounded-[10px] px-3 py-2.5" style={{ background: on ? '#242424' : undefined }}>
            <div className="flex items-center gap-2 text-[17px]">{t}{on && <span className="size-2 rounded-full" style={{ background: '#4fae7c' }} />}</div>
            <div className="text-[14px]" style={{ color: '#8a8a8a' }}>{s}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-5 p-7">
        <div className="ml-auto rounded-[16px] px-5 py-3 text-[18px]" style={{ background: '#262626' }}>Which font should we use?</div>
        <div className="text-[18px] leading-[1.6]" style={{ color: '#cfcfcf' }}>SF Pro matches the rest of macOS and stays crisp at small sizes. Here are four to compare.</div>
        <div className="mt-auto rounded-[14px] px-4 py-3 text-[16px]" style={{ border: '1px solid #2e2e2e', color: '#6f6f6f' }}>Add a follow-up</div>
      </div>
    </div>
  );
}

export function Deck() {
  const p = usePick(SLIDES);
  return (
    <div onKeyDown={p.keys}>
      <div className="overflow-hidden rounded-xl border border-hairline">
        <Stack ids={SLIDES.map((s) => s.id)} shown={p.shown} render={(id) => <Scaled w={1280} h={720}>{SLIDES.find((s) => s.id === id)!.draw()}</Scaled>} />
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2.5" onMouseLeave={() => p.point(null)}>
        {SLIDES.map((s) => (
          <button key={s.id} type="button" {...choice(p, s.id)} className={cn(tone(p, s.id), 'flex flex-col gap-2 p-1.5')}>
            <div className="overflow-hidden rounded-md ring-1 ring-hairline"><Scaled w={1280} h={720}>{s.draw()}</Scaled></div>
            <Caption p={p} o={s} className="px-1 pb-0.5" />
          </button>
        ))}
      </div>
      <PickConfirm p={p} say={([l]) => `Go with ${l} for the title slide`} />
    </div>
  );
}

// ---------- brand ----------
const BRANDS: (Opt & { font: string; word: string; colors: [string, string][]; bg: string; fg: string; accent: string; sub: string })[] = [
  { id: 'forest', label: 'Forest', hint: 'Green and paper, a serif', font: SERIF, word: 'Canopy', bg: '#f3eee4', fg: '#1c1a15', accent: '#2f6b4f', sub: '#6f685b', rec: true,
    colors: [['Moss', '#2f6b4f'], ['Fern', '#8fb39b'], ['Paper', '#f3eee4'], ['Ink', '#1c1a15']] },
  { id: 'ink', label: 'Ink', hint: 'Black and white, one dot', font: '-apple-system, "SF Pro Display", system-ui', word: 'canopy.', bg: '#0e0e0e', fg: '#f5f5f5', accent: '#f5f5f5', sub: '#8d8d8d',
    colors: [['Black', '#0e0e0e'], ['Graphite', '#3a3a3a'], ['Mist', '#d9d9d9'], ['Signal', '#4fae7c']] },
  { id: 'dawn', label: 'Dawn', hint: 'Warm, rounded, friendly', font: 'ui-rounded, "SF Pro Rounded", system-ui', word: 'Canopy', bg: '#fbf3ea', fg: '#3b2a3a', accent: '#c8553d', sub: '#8a6f68',
    colors: [['Clay', '#c8553d'], ['Honey', '#d9a441'], ['Sand', '#efe3d0'], ['Plum', '#3b2a3a']] },
];
export type BrandDef = (typeof BRANDS)[number];
export { BRANDS };

export function Brand() {
  const p = usePick(BRANDS);
  return (
    <div onKeyDown={p.keys}>
      <div className="grid grid-cols-3 gap-2.5">
        {BRANDS.map((b) => (
          <button key={b.id} type="button" {...choice(p, b.id)}
            className={cn('flex flex-col overflow-hidden rounded-xl border text-left transition-colors', p.is(b.id) ? 'border-foreground/50 ring-1 ring-foreground/40' : 'border-hairline hover:border-foreground/25', p.sent && !p.is(b.id) && 'opacity-45')}>
            <div className="flex flex-col gap-5 p-5" style={{ background: b.bg, color: b.fg, fontFamily: b.font }}>
              <div className="text-[34px] leading-none font-semibold" style={{ letterSpacing: '-0.03em' }}>{b.word}</div>
              <div className="text-[13px] leading-[1.5]" style={{ color: b.sub }}>Calm software for people who build with AI.</div>
              <div className="flex items-center gap-2">
                <span className="rounded-full px-3.5 py-1.5 text-[12px] font-medium" style={{ background: b.accent, color: b.bg }}>Download</span>
                <span className="text-[12px] underline underline-offset-2" style={{ color: b.sub }}>Read more</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {b.colors.map(([n, c]) => <div key={n}><div className="h-9 rounded-md" style={{ background: c, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,.25)' }} /><div className="mt-1 text-[10px]" style={{ color: b.sub }}>{n}</div></div>)}
              </div>
            </div>
            <Caption p={p} o={b} className="border-t border-hairline bg-card px-3.5 py-2.5" />
          </button>
        ))}
      </div>
      <PickConfirm p={p} say={([l]) => `Go with the ${l} brand`} />
    </div>
  );
}

// ---------- screens at true size ----------
const NAV = ['General', 'Models', 'Accounts', 'Usage', 'Privacy'];
function SettingRow({ t, d, on = true }: { t: string; d: string; on?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-hairline py-4">
      <div><div className="text-[17px] text-foreground">{t}</div><div className="text-[14px] text-muted-foreground">{d}</div></div>
      <span className={cn('flex h-[26px] w-[44px] items-center rounded-full p-[3px]', on ? 'justify-end bg-foreground' : 'bg-foreground/20')}><span className="size-5 rounded-full bg-background" /></span>
    </div>
  );
}
const ROWS = <><SettingRow t="Code Mode" d="Many tool calls from one script" /><SettingRow t="Fast replies" d="Same model, answers sooner" on={false} /><SettingRow t="Restart when done" d="Wait for chats before updating" /><SettingRow t="Usage stats" d="Counts only, never your words" /></>;
const SCREENS: (Opt & { draw: () => React.ReactNode })[] = [
  { id: 'sidebar', label: 'Sections on the Left', hint: 'Like System Settings', rec: true, draw: () => (
    <div className="flex h-full w-full bg-background text-foreground">
      <div className="flex w-[260px] flex-col gap-1 border-r border-hairline bg-sidebar p-4 pt-8">{NAV.map((n, i) => <div key={n} className={cn('rounded-lg px-3 py-2 text-[16px]', i === 1 ? 'bg-sidebar-hover text-foreground' : 'text-muted-foreground')}>{n}</div>)}</div>
      <div className="flex-1 px-16 pt-14"><div className="mb-6 text-[30px] font-semibold">Models</div>{ROWS}</div>
    </div>) },
  { id: 'page', label: 'One Long Page', hint: 'Scroll through everything', draw: () => (
    <div className="flex h-full w-full justify-center overflow-hidden bg-background text-foreground">
      <div className="w-[680px] pt-14">
        <div className="mb-2 text-[30px] font-semibold">Settings</div>
        <div className="mb-8 text-[16px] text-muted-foreground">Everything Canopy does, on one page.</div>
        <div className="mb-1 text-[13px] font-medium tracking-wide text-faint uppercase">Models</div>{ROWS}
      </div>
    </div>) },
  { id: 'tabs', label: 'Tabs on Top', hint: 'Fewer clicks, less room', draw: () => (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <div className="flex justify-center gap-2 border-b border-hairline pt-8 pb-4">{NAV.map((n, i) => <div key={n} className={cn('rounded-full px-4 py-1.5 text-[16px]', i === 1 ? 'bg-accent text-foreground' : 'text-muted-foreground')}>{n}</div>)}</div>
      <div className="grid grid-cols-2 gap-5 px-24 pt-10">
        {[['Code Mode', 'On'], ['Fast replies', 'Off'], ['Default model', 'Opus 5.5'], ['Effort', 'High']].map(([t, v]) => <div key={t} className="rounded-2xl border border-hairline bg-card p-6"><div className="text-[15px] text-muted-foreground">{t}</div><div className="mt-1 text-[26px] font-medium">{v}</div></div>)}
      </div>
    </div>) },
];
export function Screens() {
  const p = usePick(SCREENS);
  return (
    <div onKeyDown={p.keys} className="grid grid-cols-[200px_1fr] gap-3">
      <div className="flex flex-col gap-1" onMouseLeave={() => p.point(null)}>
        {SCREENS.map((s) => <button key={s.id} type="button" {...choice(p, s.id)} className={cn(tone(p, s.id), 'px-3 py-2.5')}><Caption p={p} o={s} /></button>)}
      </div>
      <div>
        <div className="overflow-hidden rounded-xl border border-hairline"><Stack ids={SCREENS.map((s) => s.id)} shown={p.shown} render={(id) => <Scaled w={1280} h={800}>{SCREENS.find((s) => s.id === id)!.draw()}</Scaled>} /></div>
        <PickConfirm p={p} say={([l]) => `Go with ${l} for Settings`} />
      </div>
    </div>
  );
}

// ---------- app icon, in the Dock and at every size ----------
const ICONS: (Opt & { draw: (px: number) => React.ReactNode })[] = [
  { id: 'tiers', label: 'Tiers', hint: 'The mark, on deep green', rec: true, draw: (px) => (
    <div className="flex items-center justify-center" style={{ width: px, height: px, borderRadius: px * 0.225, background: 'linear-gradient(160deg, #1f4d36, #0d1f16)', boxShadow: `inset 0 0 0 ${Math.max(1, px / 128)}px rgba(255,255,255,.08)` }}>
      <div className="flex flex-col items-center" style={{ gap: px * 0.045 }}>{[0.32, 0.48, 0.64].map((w, i) => <div key={w} className="rounded-full" style={{ width: px * w, height: px * 0.11, background: ['#8fd1a8', '#4fae7c', '#2c7a52'][i] }} />)}</div>
    </div>) },
  { id: 'leaf', label: 'Leaf', hint: 'One shape, light ground', draw: (px) => (
    <div className="flex items-center justify-center" style={{ width: px, height: px, borderRadius: px * 0.225, background: 'linear-gradient(160deg, #f7f4ec, #e6dfcf)' }}>
      <svg viewBox="0 0 64 64" style={{ width: px * 0.62, height: px * 0.62 }}><path d="M14 50C14 26 30 12 52 12c0 24-14 40-38 38Z" fill="#2f6b4f" /><path d="M16 48 40 24" stroke="#f3eee4" strokeWidth="3" strokeLinecap="round" /></svg>
    </div>) },
  { id: 'mono', label: 'Monogram', hint: 'A lowercase c, glass', draw: (px) => (
    <div className="flex items-center justify-center" style={{ width: px, height: px, borderRadius: px * 0.225, background: 'radial-gradient(90% 90% at 30% 20%, #3a3a3a, #111)', color: '#f2f2f2', fontSize: px * 0.62, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1 }}>
      <span style={{ marginTop: -px * 0.06 }}>c</span>
    </div>) },
];
const DOCK = ['#5ac8fa', '#ff9f0a', '#34c759', '#af52de', '#ff375f'];
export function Icons() {
  const p = usePick(ICONS);
  const icon = ICONS.find((i) => i.id === p.shown)!;
  return (
    <div onKeyDown={p.keys}>
      <div className="flex flex-col items-center gap-6 overflow-hidden rounded-xl border border-hairline px-6 pt-10 pb-6" style={{ background: 'linear-gradient(180deg, #2a3b4f 0%, #4b3d55 60%, #6b4a52 100%)' }}>
        <div className="flex items-end gap-6">
          {[16, 32, 64, 128].map((px) => <div key={px} className="flex flex-col items-center gap-2"><Stack ids={ICONS.map((i) => i.id)} shown={p.shown} render={(id) => ICONS.find((i) => i.id === id)!.draw(px)} /><span className="text-[11px] text-white/60">{px}px</span></div>)}
        </div>
        {/* The Dock, at the size people really see it. */}
        <div className="flex items-end gap-2 rounded-[22px] border border-white/15 bg-white/15 px-3 py-2 backdrop-blur-md">
          {DOCK.slice(0, 3).map((c) => <div key={c} className="size-12 rounded-[11px]" style={{ background: `linear-gradient(160deg, ${c}, color-mix(in oklch, ${c} 60%, black))` }} />)}
          <div className="relative">{icon.draw(48)}<span className="absolute -bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-white/80" /></div>
          {DOCK.slice(3).map((c) => <div key={c} className="size-12 rounded-[11px]" style={{ background: `linear-gradient(160deg, ${c}, color-mix(in oklch, ${c} 60%, black))` }} />)}
        </div>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2" onMouseLeave={() => p.point(null)}>
        {ICONS.map((i) => <button key={i.id} type="button" {...choice(p, i.id)} className={cn(tone(p, i.id), 'flex items-center gap-3 p-2.5')}>{i.draw(36)}<Caption p={p} o={i} /></button>)}
      </div>
      <PickConfirm p={p} say={([l]) => `Use the ${l} app icon`} />
    </div>
  );
}

// ---------- social card, in the feed it will appear in ----------
const CARDS: (Opt & { draw: () => React.ReactNode })[] = [
  { id: 'quote', label: 'Big Line', hint: 'One sentence, huge', rec: true, draw: () => (
    <div className="flex h-full w-full flex-col justify-between p-[72px]" style={{ background: '#0f1a14', color: '#eef5f0' }}>
      <div className="text-[78px] leading-[1.05] font-semibold" style={{ letterSpacing: '-0.03em' }}>Every AI coding chat you run, calm and in one place.</div>
      <div className="flex items-center gap-4 text-[30px]" style={{ color: '#8fd1a8' }}><div className="flex flex-col gap-1.5">{[22, 34, 46].map((w) => <div key={w} className="h-2 rounded-full bg-current" style={{ width: w }} />)}</div>Canopy</div>
    </div>) },
  { id: 'shot', label: 'Screenshot', hint: 'The app, front and center', draw: () => (
    <div className="flex h-full w-full items-end justify-center px-[80px] pt-[70px]" style={{ background: 'linear-gradient(180deg,#e9efe9,#cfdcd2)' }}>
      <div className="h-full w-full overflow-hidden rounded-t-[18px]" style={{ boxShadow: '0 -10px 50px rgba(0,0,0,.25)' }}><div className="flex h-full" style={{ background: '#151515' }}><MiniApp /></div></div>
    </div>) },
  { id: 'stat', label: 'Numbers', hint: 'Proof, not adjectives', draw: () => (
    <div className="grid h-full w-full grid-cols-2 items-center gap-10 p-[80px]" style={{ background: '#f3eee4', color: '#1c1a15' }}>
      <div><div className="text-[150px] leading-none font-semibold" style={{ letterSpacing: '-0.05em', color: '#2f6b4f' }}>13%</div><div className="mt-4 text-[34px]">faster than plain Claude Code</div></div>
      <div className="text-[36px] leading-[1.4]" style={{ fontFamily: SERIF }}>Canopy runs the Claude Code and Codex you already have. Nothing to learn.</div>
    </div>) },
];
export function Social() {
  const p = usePick(CARDS);
  return (
    <div onKeyDown={p.keys} className="grid grid-cols-[1fr_200px] items-start gap-3">
      {/* The post as it will be seen: in a feed, under the text it goes out with. */}
      <div className="rounded-xl border border-hairline bg-background p-4">
        <div className="flex gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#1f4d36] text-[13px] font-semibold text-[#8fd1a8]">C</div>
          <div className="min-w-0 flex-1">
            <div className="text-ui"><span className="font-semibold">Canopy</span> <span className="text-muted-foreground">@canopyapp · 1m</span></div>
            <div className="mt-0.5 text-ui leading-[1.5]">Canopy is out. One calm window for every Claude Code and Codex chat, free for Mac.</div>
            <div className="mt-3 overflow-hidden rounded-2xl border border-hairline"><Stack ids={CARDS.map((c) => c.id)} shown={p.shown} render={(id) => <Scaled w={1200} h={630}>{CARDS.find((c) => c.id === id)!.draw()}</Scaled>} /></div>
            <div className="mt-2.5 flex gap-10 text-[12px] text-muted-foreground"><span>12</span><span>48</span><span>310</span><span>22K</span></div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1" onMouseLeave={() => p.point(null)}>
        {CARDS.map((c) => <button key={c.id} type="button" {...choice(p, c.id)} className={cn(tone(p, c.id), 'flex flex-col gap-2 p-2')}><div className="overflow-hidden rounded-md ring-1 ring-hairline"><Scaled w={1200} h={630}>{c.draw()}</Scaled></div><Caption p={p} o={c} /></button>)}
        <div className="mt-auto"><PickConfirm p={p} say={([l]) => `Use the ${l} card for the launch post`} /></div>
      </div>
    </div>
  );
}

// ---------- the same numbers, three ways ----------
const DAYS = [['Mon', 6], ['Tue', 9], ['Wed', 14], ['Thu', 11], ['Fri', 17], ['Sat', 4], ['Sun', 3]] as const;
const MAX = 17;
const CHARTS: (Opt & { draw: () => React.ReactNode })[] = [
  { id: 'bars', label: 'Bars', hint: 'Compare days', rec: true, draw: () => (
    <div className="flex h-[150px] items-end gap-3 px-1">
      {DAYS.map(([d, n]) => <div key={d} className="flex flex-1 flex-col items-center gap-1.5"><span className="text-[11px] text-muted-foreground tabular-nums">{n}</span><div className="w-full rounded-t-[4px] bg-foreground/70" style={{ height: (n / MAX) * 110 }} /><span className="text-[11px] text-faint">{d}</span></div>)}
    </div>) },
  { id: 'line', label: 'Line', hint: 'See the week’s shape', draw: () => {
    const pts = DAYS.map(([, n], i) => [16 + i * 38, 118 - (n / MAX) * 100] as const);
    return (
      <svg viewBox="0 0 260 150" className="h-[150px] w-full">
        <path d={`M${pts.map(([x, y]) => `${x},${y}`).join(' L')}`} fill="none" stroke="currentColor" strokeOpacity=".75" strokeWidth="2" strokeLinejoin="round" />
        {pts.map(([x, y], i) => <g key={i}><circle cx={x} cy={y} r="3.5" fill="currentColor" /><text x={x} y="146" textAnchor="middle" fontSize="11" fill="currentColor" opacity=".45">{DAYS[i][0]}</text></g>)}
      </svg>);
  } },
  { id: 'grid', label: 'Calendar', hint: 'Busy days stand out', draw: () => (
    <div className="grid h-[150px] grid-cols-7 content-center gap-2">
      {DAYS.map(([d, n]) => <div key={d} className="flex flex-col items-center gap-1.5"><div className="aspect-square w-full rounded-md" style={{ background: `color-mix(in oklch, var(--foreground) ${15 + (n / MAX) * 70}%, transparent)` }} /><span className="text-[11px] text-faint">{d}</span></div>)}
    </div>) },
];
export function Charts() {
  const p = usePick(CHARTS);
  return (
    <div onKeyDown={p.keys}>
      <div className="grid grid-cols-3 gap-2.5" onMouseLeave={() => p.point(null)}>
        {CHARTS.map((c) => (
          <button key={c.id} type="button" {...choice(p, c.id)} className={cn(tone(p, c.id, 'rounded-xl'), 'flex flex-col gap-3 border border-hairline p-3.5')}>
            <div className="text-[12px] text-muted-foreground">Chats this week</div>
            {c.draw()}
            <Caption p={p} o={c} />
          </button>
        ))}
      </div>
      <PickConfirm p={p} say={([l]) => `Show the week as ${l.toLowerCase()} on Home`} />
    </div>
  );
}

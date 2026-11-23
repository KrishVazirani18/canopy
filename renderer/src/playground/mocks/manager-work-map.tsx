// Manager on the work: the canvas is the project itself (its files as a map), and the agents are cursors on it.
// Three ideas in one screen:
//   1. Agents on the work: each Claude Code or Codex chat the manager starts is a cursor on the files it is in.
//   2. The thinking whiteboard: the manager talks (subtitles) and circles parts of the map as it explains the plan.
//   3. Rewind and branch: a timeline you scrub; pause anywhere and branch ("try Codex on the API from here").
// Click a file to point the manager at it. Sample data on a scripted clock: nothing runs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpIcon, GitBranchIcon, MicIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { MakerLogo } from '@/components/canopy/maker-logo';
import type { Maker } from '@/lib/models';
import { cn } from '@/lib/utils';

export const title = 'Manager on the Work';
export const note = 'Agents as cursors on the project, the manager sketching its plan as it talks, and a timeline to rewind and branch.';

// ---- The project, as a map (a 1000×560 space) ----
type F = { id: string; name: string; x: number; y: number; w: number; h: number };
const FOLDERS: { label: string; x: number; y: number; w: number; h: number; files: [string, number][] }[] = [
  { label: 'app', x: 0, y: 0, w: 410, h: 290, files: [['app/settings/team.tsx', 3], ['app/settings/account.tsx', 2], ['app/settings/layout.tsx', 1], ['app/components/Table.tsx', 2], ['app/components/Button.tsx', 1], ['app/pages/home.tsx', 2], ['app/pages/login.tsx', 1]] },
  { label: 'server', x: 420, y: 0, w: 580, h: 290, files: [['server/db/schema.ts', 3], ['server/db/0042_invites.sql', 1], ['server/auth/session.ts', 2], ['server/invites/invites.ts', 3], ['server/invites/routes.ts', 2], ['server/auth/tokens.ts', 2], ['server/mail/mailer.ts', 2], ['server/mail/invite.html', 1], ['server/mail/link.ts', 1]] },
  { label: 'tests', x: 0, y: 300, w: 410, h: 260, files: [['tests/invites.test.ts', 2], ['tests/auth.test.ts', 2], ['tests/mail.test.ts', 1], ['tests/e2e/invite-flow.spec.ts', 2]] },
  { label: 'lib', x: 420, y: 300, w: 580, h: 260, files: [['lib/env.ts', 1], ['lib/log.ts', 1], ['lib/date.ts', 1], ['lib/i18n.ts', 2], ['package.json', 1], ['README.md', 1]] },
];
const FILES: Record<string, F> = {};
for (const d of FOLDERS) {
  const rows = Math.ceil(d.files.length / 3), top = d.y + 30, inner = d.h - 38, rh = inner / rows;
  for (let r = 0; r < rows; r++) {
    const row = d.files.slice(r * 3, r * 3 + 3), sum = row.reduce((a, [, wt]) => a + wt, 0);
    let x = d.x + 8;
    for (const [id, wt] of row) {
      const w = ((d.w - 16 - (row.length - 1) * 6) * wt) / sum;
      FILES[id] = { id, name: id.split('/').pop()!, x, y: top + r * rh, w, h: rh - 6 };
      x += w + 6;
    }
  }
}
const center = (id: string) => { const f = FILES[id]; return { x: f.x + f.w / 2, y: f.y + f.h / 2 }; };

// ---- The script ----
const END = 40, MOVE = 0.9, SPAWN = { x: 500, y: 560 };
type Agent = { id: string; maker: Maker; model: string; from: number; done?: number; ask?: [number, string]; wait?: [number, number]; path: [number, string][] };
const AGENTS: Agent[] = [
  { id: 'api', maker: 'claude', model: 'Opus 5.5 · High', from: 10, done: 37, path: [[10.2, 'server/db/schema.ts'], [14, 'server/db/0042_invites.sql'], [17, 'server/invites/invites.ts'], [31, 'server/auth/tokens.ts']] },
  { id: 'mail', maker: 'openai', model: 'GPT-6.1 Sol · Med', from: 10.6, done: 21, path: [[10.8, 'server/mail/mailer.ts'], [15, 'server/mail/invite.html'], [18, 'server/mail/link.ts']] },
  { id: 'page', maker: 'claude', model: 'Sonnet 5.5 · Low', from: 11, ask: [25, 'Keep the old Members tab?'], path: [[11.2, 'app/settings/layout.tsx'], [15, 'app/settings/team.tsx'], [20, 'app/components/Table.tsx'], [24, 'app/settings/account.tsx']] },
  { id: 'tests', maker: 'openai', model: 'GPT-6 Luna · Fast', from: 11.6, done: 38, wait: [28.6, 31.6], path: [[11.8, 'tests/invites.test.ts'], [18, 'tests/mail.test.ts'], [23, 'tests/e2e/invite-flow.spec.ts'], [27.6, 'server/invites/routes.ts'], [28.6, 'tests/invites.test.ts'], [31.6, 'server/invites/invites.ts']] },
  { id: 'review', maker: 'claude', model: 'Sonnet 5.5 · Med', from: 22, done: 33, path: [[22.2, 'server/mail/link.ts'], [27, 'server/mail/mailer.ts']] },
];
type Line = { t: number; who: 'you' | 'manager'; text: string };
const LINES: Line[] = [
  { t: 0.2, who: 'you', text: 'Add team invites: invite by email, an accept link, and a Team page in Settings.' },
  { t: 3, who: 'manager', text: 'Four parts. The API touches auth, so Opus on high takes the server side.' },
  { t: 6, who: 'manager', text: 'Email is routine: Codex on medium.' },
  { t: 7.8, who: 'manager', text: 'The Team page copies your settings pages, so Sonnet on low.' },
  { t: 9.4, who: 'manager', text: 'Tests run on Codex, fast. Starting all four.' },
  { t: 21.4, who: 'manager', text: 'Email is done. Sending a Sonnet reviewer over it.' },
  { t: 25, who: 'manager', text: 'The Team page has a question for you.' },
  { t: 28, who: 'manager', text: 'Tests, hold on: Opus is still in invites.ts.' },
  { t: 31.4, who: 'manager', text: 'Clear now. Tests, go ahead.' },
  { t: 37.2, who: 'manager', text: 'Server side is done. Waiting on your answer about the Members tab.' },
];
type Sketch = { t: number; files: string[]; label: string; until?: number };
const SKETCHES: Sketch[] = [
  { t: 3.4, files: ['server/db/schema.ts', 'server/invites/routes.ts', 'server/auth/tokens.ts'], label: 'Opus · High' },
  { t: 6.2, files: ['server/mail/mailer.ts', 'server/mail/link.ts'], label: 'Codex · Med' },
  { t: 8, files: ['app/settings/team.tsx', 'app/settings/layout.tsx'], label: 'Sonnet · Low' },
  { t: 9.6, files: ['tests/invites.test.ts', 'tests/e2e/invite-flow.spec.ts'], label: 'Codex · Fast' },
  { t: 28, files: ['server/invites/invites.ts'], label: 'Opus first', until: 31.4 },
];
// The branch: from the moment you branch, Codex takes the API, a little faster.
const BRANCH_LABEL = 'GPT-6.1 Sol on the API';

// ---- Reading the script at a moment ----
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => (v < 0.5 ? 2 * v * v : 1 - (-2 * v + 2) ** 2 / 2);
const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, k: number) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
function posAt(a: Agent, t: number) {
  let from = SPAWN, to = SPAWN, at = a.from;
  for (const [wt, file] of a.path) {
    if (wt > t) break;
    from = lerp(from, to, ease(clamp((wt - at) / MOVE))); to = center(file); at = wt;
  }
  return lerp(from, to, ease(clamp((t - at) / MOVE)));
}
/** The agent as it is on a lane: on the branch, past the branch point, the API is Codex's and runs 1.3× faster. */
function onLane(a: Agent, t: number, branchAt: number | null) {
  if (branchAt === null || a.id !== 'api' || t < branchAt) return { a, t };
  return { a: { ...a, maker: 'openai' as Maker, model: 'GPT-6.1 Sol · High', done: branchAt + (a.done! - branchAt) / 1.3 }, t: branchAt + (t - branchAt) * 1.3 };
}
const mmss = (s: number) => `0:${String(Math.floor(s)).padStart(2, '0')}`;

function sketchPath(files: string[], seed: number) {
  const fs = files.map((id) => FILES[id]);
  const x0 = Math.min(...fs.map((f) => f.x)) - 7, y0 = Math.min(...fs.map((f) => f.y)) - 7;
  const x1 = Math.max(...fs.map((f) => f.x + f.w)) + 7, y1 = Math.max(...fs.map((f) => f.y + f.h)) + 7;
  const pts: string[] = [];
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0 + 14, y0 - 3]];
  corners.forEach(([x, y], i) => {
    const j = Math.sin(seed * 7 + i * 3) * 3;
    pts.push(i === 0 ? `M ${x + 12} ${y + j}` : `Q ${x + j} ${y - j} ${x + (i % 2 ? -1 : 1) * 2} ${y + (i < 2 ? 12 : -12) + j}`);
  });
  return { d: pts.join(' '), x0, y0, x1 };
}

export default function ManagerWorkMap() {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [branchAt, setBranchAt] = useState<number | null>(null);
  const [lane, setLane] = useState<'main' | 'branch'>('main');
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [said, setSaid] = useState<Line[]>([]);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) { last.current = null; return; }
    let raf = 0;
    const step = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setT((x) => { const n = Math.min(END, x + dt); if (n >= END) setPlaying(false); return n; });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const b = lane === 'branch' ? branchAt : null;
  const lines = useMemo(() => {
    const all = [...LINES, ...said];
    if (b !== null) all.push({ t: b + 0.3, who: 'manager', text: `On this branch, ${BRANCH_LABEL}.` });
    return all.sort((x, y) => x.t - y.t);
  }, [said, b]);
  const line = [...lines].reverse().find((l) => l.t <= t);
  const speaking = !!line && line.who === 'manager' && t - line.t < 2.6;

  const agents = AGENTS.filter((a) => t >= a.from).map((raw) => {
    const { a, t: at } = onLane(raw, t, b);
    const p = posAt(a, at);
    const state = a.done && at >= a.done ? 'done' : a.ask && at >= a.ask[0] ? 'ask' : a.wait && at >= a.wait[0] && at < a.wait[1] ? 'wait' : 'work';
    const here = [...a.path].reverse().find(([wt]) => wt + MOVE <= at)?.[1];
    return { a, p, state, here, gone: !!a.done && at >= a.done + 2.5 };
  });
  const edited = new Set<string>();
  for (const raw of AGENTS) { const { a, t: at } = onLane(raw, t, b); for (const [wt, f] of a.path) if (wt + MOVE + 0.6 <= at) edited.add(f); }
  const busy = new Set(agents.filter((x) => x.state !== 'done').map((x) => x.here));

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const go = (x: number) => setT(Math.max(0, Math.min(END, ((x - r.left) / r.width) * END)));
    go(e.clientX); setPlaying(false);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const send = () => {
    const text = draft.trim(); if (!text) return;
    const about = picked ? FILES[picked].name : null;
    setSaid((s) => [...s, { t, who: 'you', text: about ? `${about}: ${text}` : text }, { t: t + 1.2, who: 'manager', text: about ? `Got it. Sending Sonnet to ${about}.` : 'Got it.' }]);
    setDraft(''); setPlaying(true);
  };

  return (
    <div className="flex h-full flex-col">
      <style>{`.mw-bar{animation:mw-bar .9s ease-in-out infinite}@keyframes mw-bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}
        @media (prefers-reduced-motion:reduce){.mw-bar{animation:none}}`}</style>

      {/* The map */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 pt-6 pb-2">
        <div className="relative aspect-[1000/560] h-full max-h-full max-w-full">
          <svg viewBox="0 0 1000 560" className="absolute inset-0 size-full overflow-visible">
            {FOLDERS.map((d) => (
              <g key={d.label}>
                <rect x={d.x} y={d.y} width={d.w} height={d.h} rx={10} fill="var(--muted)" fillOpacity={0.35} stroke="var(--border)" />
                <text x={d.x + 12} y={d.y + 19} fontSize={12} fill="var(--faint)" fontWeight={500}>{d.label}</text>
              </g>
            ))}
            {Object.values(FILES).map((f) => (
              <g key={f.id} onClick={() => setPicked(picked === f.id ? null : f.id)} className="cursor-pointer">
                <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={6}
                  fill={edited.has(f.id) ? 'var(--foreground)' : 'var(--card)'} fillOpacity={edited.has(f.id) ? 0.09 : 1}
                  stroke={picked === f.id ? 'var(--foreground)' : busy.has(f.id) ? 'var(--faint)' : 'var(--border)'} strokeWidth={picked === f.id ? 1.5 : 1}
                  className="transition-[fill,fill-opacity,stroke] duration-500" />
                <text x={f.x + 9} y={f.y + 18} fontSize={11.5} fill="var(--muted-foreground)" className="font-mono">{f.name}</text>
                {edited.has(f.id) && <text x={f.x + 9} y={f.y + 33} fontSize={10.5} fill="var(--faint)">changed</text>}
              </g>
            ))}
            {/* The manager's marker, drawn as it talks */}
            {SKETCHES.map((s, i) => {
              const k = clamp((t - s.t) / 1.1);
              if (k <= 0 || (s.until && t > s.until + 0.6)) return null;
              const gone = s.until ? clamp((t - s.until) / 0.6) : 0;
              const { d, y0, x1 } = sketchPath(s.files, i + 1);
              return (
                <g key={i} opacity={(1 - gone) * (t - s.t > 6 && !s.until ? 0.45 : 0.9)} className="transition-opacity duration-700">
                  <path d={d} pathLength={1} fill="none" stroke="var(--foreground)" strokeWidth={2} strokeLinecap="round" strokeDasharray={1} strokeDashoffset={1 - k} />
                  <text x={x1 - 6} y={y0 + 4} textAnchor="end" fontSize={13} fontWeight={600} fill="var(--foreground)" stroke="var(--background)" strokeWidth={5} paintOrder="stroke" opacity={clamp((k - 0.5) * 2)} style={{ fontFamily: '"Marker Felt", "Comic Sans MS", ui-rounded, sans-serif' }}>{s.label}</text>
                </g>
              );
            })}
          </svg>

          {/* The agents, as cursors on the files they are in */}
          {agents.map(({ a, p, state, gone }) => (
            <div key={a.id} className="pointer-events-none absolute enter-fade transition-opacity duration-700" style={{ opacity: gone ? 0 : 1, left: `${p.x / 10}%`, top: `${(p.y / 560) * 100}%` }}>
              <svg width="16" height="18" viewBox="0 0 16 18" className={cn('-translate-x-px -translate-y-px drop-shadow-sm', state === 'done' && 'opacity-40')}>
                <path d="M1 1 L1 15 L5 11.5 L8 17 L10.5 16 L7.6 10.4 L13 10 Z" fill="var(--foreground)" stroke="var(--background)" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <div className={cn('mt-0.5 ml-3 flex w-max items-center gap-1.5 rounded-full px-2 py-[3px] text-small transition-colors',
                state === 'done' ? 'bg-muted text-faint' : 'bg-foreground text-background')}>
                <MakerLogo maker={a.maker} className="size-3" />
                <span>{a.model}</span>
                {state === 'done' && <span>· Done</span>}
                {state === 'wait' && <span className="opacity-60">· Waiting</span>}
                {state === 'ask' && <span className="size-1.5 rounded-full bg-brand" />}
              </div>
              {state === 'ask' && a.ask && (
                <div className="mt-1 ml-3 w-max max-w-[220px] rounded-xl border border-border bg-card px-3 py-2 text-ui shadow-[0_6px_20px_-8px_rgb(0_0_0/0.25)] enter-fade">{a.ask[1]}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* The manager: subtitles while it talks, and where you talk back */}
      <div className="flex shrink-0 flex-col items-center gap-2 px-8 pb-3">
        <div className="flex h-10 max-w-[720px] items-center gap-2 text-center text-ui">
          {line && <>
            <span className="shrink-0 text-faint">{line.who === 'you' ? 'You' : 'Manager'}</span>
            <span key={line.t + line.text} className="enter-fade text-foreground/90">{line.text}</span>
          </>}
        </div>
        <div className="flex w-full max-w-[640px] items-center gap-2 rounded-full border border-black/[0.06] bg-card py-1.5 pr-1.5 pl-1.5 shadow-[0_6px_28px_-6px_rgb(0_0_0/0.10)] dark:border-white/[0.07] dark:bg-[oklch(0.27_0_0)]">
          <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', speaking ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground')}>
            {speaking
              ? <div className="flex h-3.5 items-center gap-[2px]">{[0, 1, 2, 3].map((i) => <span key={i} className="mw-bar h-full w-[2.5px] rounded-full bg-background" style={{ animationDelay: `${i * 0.12}s` }} />)}</div>
              : <MicIcon className="size-4" />}
          </div>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder={picked ? `Tell the manager about ${FILES[picked].name}` : 'Talk, or type to the manager'}
            className="h-8 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
          <button onClick={send} aria-label="Send" className={cn('flex size-8 shrink-0 items-center justify-center rounded-full transition-colors', draft.trim() ? 'bg-foreground text-background' : 'text-faint')}>
            <ArrowUpIcon className="size-4" />
          </button>
        </div>
      </div>

      {/* The timeline: scrub back, branch from any moment */}
      <div className="flex shrink-0 items-start gap-3 border-t border-hairline px-6 py-3">
        <button onClick={() => { if (t >= END) setT(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'}
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {(['main', 'branch'] as const).filter((l) => l === 'main' || branchAt !== null).map((l) => {
            const from = l === 'branch' ? branchAt! : 0;
            const on = lane === l;
            return (
              <div key={l} className="flex h-6 items-center gap-3">
                <button onClick={() => setLane(l)} className={cn('w-36 shrink-0 truncate text-left text-small', on ? 'text-foreground' : 'text-faint hover:text-muted-foreground')}>
                  {l === 'main' ? 'Main' : BRANCH_LABEL}
                </button>
                <div onPointerDown={(e) => { setLane(l); scrub(e); }} className="relative h-6 flex-1 cursor-pointer">
                  <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-muted" style={{ left: `${(from / END) * 100}%`, right: 0 }} />
                  {on && <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-foreground/40" style={{ left: `${(from / END) * 100}%`, width: `${(Math.max(0, t - from) / END) * 100}%` }} />}
                  {lines.filter((x) => x.who === 'manager' && x.t >= from && (l === 'branch' || !said.includes(x))).map((x, i) => (
                    <span key={i} className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-faint" style={{ left: `${(x.t / END) * 100}%` }} />
                  ))}
                  {on && <span className="absolute top-0 h-6 w-0.5 -translate-x-1/2 rounded-full bg-foreground" style={{ left: `${(t / END) * 100}%` }} />}
                </div>
              </div>
            );
          })}
        </div>
        <span className="mt-1 w-10 shrink-0 text-right text-small text-faint tabular-nums">{mmss(t)}</span>
        <div className="w-44 shrink-0">
          {branchAt === null && !playing && t > 10.5 && t < END - 2 && (
            <button onClick={() => { setBranchAt(t); setLane('branch'); setPlaying(true); }}
              className="flex h-7 w-full items-center gap-1.5 rounded-md border border-border px-2 text-small text-muted-foreground enter-fade hover:bg-accent hover:text-foreground">
              <GitBranchIcon className="size-3.5" />Branch from {mmss(t)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Manager canvas: you talk to one manager chat; it starts Claude Code and Codex chats as workers, picking the maker,
// model and effort for each, and the canvas draws them as cards joined by lines (who started whom, whose work went to
// whom). Click any card to talk to that chat on the right. Cards drag. Sample data only: nothing runs.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, RotateCcwIcon } from 'lucide-react';
import { MakerLogo } from '@/components/canopy/maker-logo';
import type { Maker } from '@/lib/models';
import { cn } from '@/lib/utils';

export const title = 'Manager Canvas';
export const note = 'one manager chat at the top starts Claude Code and Codex workers; the canvas shows them joined by lines. Click a card to chat with it, drag to move.';

type State = 'working' | 'done' | 'needs';
type Node = {
  id: string; maker: Maker; title: string; model: string; effort: string;
  state: State; status: string; x: number; y: number; from?: string; via?: 'started' | 'handoff'; at?: number;
};
type Msg = { from: 'you' | 'agent'; text: string };

const W = 228, H = 84, MW = 264, MH = 96;

const NODES: Node[] = [
  { id: 'mgr', maker: 'claude', title: 'Manager', model: 'Opus 5.5', effort: 'High', state: 'working', status: 'Watching 4 chats', x: 368, y: 16 },
  { id: 'api', maker: 'claude', title: 'Invites schema and API', model: 'Opus 5.5', effort: 'High', state: 'working', status: 'Editing invites.ts', x: 14, y: 190, from: 'mgr', via: 'started' },
  { id: 'mail', maker: 'openai', title: 'Invite email and accept link', model: 'GPT-6.1 Sol', effort: 'Med', state: 'done', status: 'Done · 3 files changed', x: 262, y: 190, from: 'mgr', via: 'started' },
  { id: 'page', maker: 'claude', title: 'Team settings page', model: 'Sonnet 5.5', effort: 'Low', state: 'needs', status: 'Asks: keep the old Members tab?', x: 510, y: 190, from: 'mgr', via: 'started' },
  { id: 'tests', maker: 'openai', title: 'Tests for invites', model: 'GPT-6 Luna', effort: 'Fast', state: 'working', status: 'Running 42 tests', x: 758, y: 190, from: 'mgr', via: 'started' },
  // Started by the manager a few seconds in, once the email work finished: its work is handed to a reviewer.
  { id: 'review', maker: 'claude', title: 'Review the email flow', model: 'Sonnet 5.5', effort: 'Med', state: 'working', status: 'Reading accept-link.ts', x: 262, y: 360, from: 'mail', via: 'handoff', at: 3500 },
];

const CHATS: Record<string, Msg[]> = {
  mgr: [
    { from: 'you', text: 'Add team invites: invite by email, an accept link, and a settings page for it.' },
    { from: 'agent', text: 'Splitting it four ways. The schema and API touch auth, so Opus on high. The email and link are routine, Codex on medium. The settings page copies the existing ones, Sonnet on low is enough. Tests run on Codex fast.' },
    { from: 'agent', text: 'The email work is done. I started a Sonnet chat to review it before it merges.' },
    { from: 'agent', text: 'The settings page is asking whether to keep the old Members tab. Your call.' },
  ],
  api: [{ from: 'agent', text: 'Brief from the manager: add an invites table and three routes (create, accept, revoke). Tokens expire in 7 days.' }, { from: 'agent', text: 'Table and migration are in. Writing the accept route now.' }],
  mail: [{ from: 'agent', text: 'Brief from the manager: send the invite email with a signed accept link, using the existing mailer.' }, { from: 'agent', text: 'Done. Added the template, the signed link helper, and the route that consumes it. 3 files changed.' }],
  page: [{ from: 'agent', text: 'Brief from the manager: a Team page in Settings listing members and pending invites, styled like the other settings pages.' }, { from: 'agent', text: 'There is an older Members tab under Account. Should the new Team page replace it, or keep both?' }],
  tests: [{ from: 'agent', text: 'Brief from the manager: cover create, accept, expiry and revoke. Run the suite when the API lands.' }, { from: 'agent', text: 'Wrote 9 tests. Running the full suite: 42 so far.' }],
  review: [{ from: 'agent', text: 'Brief from the manager: review the email chat\'s 3 changed files for security issues before merge.' }, { from: 'agent', text: 'Checking that the link signature is verified before the invite is accepted.' }],
};

const size = (n: Node) => (n.id === 'mgr' ? { w: MW, h: MH } : { w: W, h: H });

function Edge({ a, b, via, live }: { a: Node; b: Node; via: Node['via']; live: boolean }) {
  const sa = size(a);
  const x1 = a.x + sa.w / 2, y1 = a.y + sa.h, x2 = b.x + size(b).w / 2, y2 = b.y;
  const dy = Math.max(30, (y2 - y1) / 2);
  const d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  return (
    <g className="enter-fade">
      <path d={d} fill="none" stroke="var(--border)" strokeWidth={1.5} strokeDasharray={via === 'handoff' ? '4 4' : undefined} />
      {live && <path d={d} fill="none" stroke="var(--faint)" strokeWidth={1.5} strokeDasharray="2 14" className="mc-flow" />}
      <circle cx={x1} cy={y1} r={3} fill="var(--background)" stroke="var(--faint)" strokeWidth={1.5} />
      <circle cx={x2} cy={y2} r={3} fill="var(--background)" stroke="var(--faint)" strokeWidth={1.5} />
    </g>
  );
}

function Card({ n, on, onPick, onDrag }: { n: Node; on: boolean; onPick: () => void; onDrag: (dx: number, dy: number) => void }) {
  const mgr = n.id === 'mgr';
  const { w, h } = size(n);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return (
    <div
      style={{ left: n.x, top: n.y, width: w, height: h }}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY, moved: false }; }}
      onPointerMove={(e) => {
        const s = start.current; if (!s) return;
        const dx = e.clientX - s.x, dy = e.clientY - s.y;
        if (!s.moved && Math.hypot(dx, dy) < 3) return;
        s.moved = true; s.x = e.clientX; s.y = e.clientY; onDrag(dx, dy);
      }}
      onPointerUp={() => { if (start.current && !start.current.moved) onPick(); start.current = null; }}
      className={cn('absolute flex cursor-pointer select-none flex-col justify-center gap-1 rounded-xl border bg-card px-3.5 enter-fade',
        'shadow-[0_4px_18px_-8px_rgb(0_0_0/0.12)] transition-[border-color,box-shadow] dark:bg-[oklch(0.25_0_0)]',
        on ? 'border-foreground/25 shadow-[0_6px_24px_-8px_rgb(0_0_0/0.2)]' : 'border-border hover:border-foreground/15')}>
      <div className="flex min-w-0 items-center gap-2">
        <MakerLogo maker={n.maker} className="size-3.5 text-foreground/80" />
        <span className={cn('truncate text-ui font-medium', mgr && 'text-[14px]')}>{n.title}</span>
        {n.state === 'needs' && <span role="img" aria-label="Needs you" className="ml-auto size-2 shrink-0 rounded-full bg-brand" />}
      </div>
      <div className="truncate text-small text-faint">{n.maker === 'claude' ? 'Claude Code' : 'Codex'} · {n.model} · {n.effort}</div>
      <div className={cn('truncate text-small', n.state === 'working' ? 'shimmer-text' : n.state === 'needs' ? 'text-foreground' : 'text-muted-foreground')}>{n.status}</div>
    </div>
  );
}

export default function ManagerCanvas() {
  const [nodes, setNodes] = useState(NODES);
  const [sel, setSel] = useState('mgr');
  const [t, setT] = useState(0);
  const [draft, setDraft] = useState('');
  const [chats, setChats] = useState(CHATS);
  const t0 = useRef(Date.now());
  useEffect(() => { const id = setInterval(() => setT(Date.now() - t0.current), 250); return () => clearInterval(id); }, []);

  const shown = nodes.filter((n) => !n.at || t >= n.at);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const cur = byId[sel];
  // Before the reviewer appears, the manager has not yet said it started one.
  const msgs = (chats[sel] ?? []).filter((_, i) => !(sel === 'mgr' && i === 2 && t < 3500));
  const move = (id: string, dx: number, dy: number) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, x: n.x + dx, y: n.y + dy } : n)));
  const send = () => {
    const text = draft.trim(); if (!text) return;
    setChats((c) => ({ ...c, [sel]: [...(c[sel] ?? []), { from: 'you', text }] }));
    setDraft('');
  };
  const replay = () => { t0.current = Date.now(); setT(0); setNodes(NODES); setChats(CHATS); setSel('mgr'); };

  return (
    <div className="flex h-full">
      <style>{`.mc-flow{animation:mc-flow 1.2s linear infinite}@keyframes mc-flow{to{stroke-dashoffset:-16}}@media (prefers-reduced-motion:reduce){.mc-flow{animation:none}}`}</style>
      <div className="relative min-w-0 flex-1 overflow-auto"
        style={{ backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
        <div className="relative" style={{ width: 1000, height: 480, margin: '40px auto' }}>
          <svg className="pointer-events-none absolute inset-0" width={1000} height={480}>
            {shown.filter((n) => n.from).map((n) => (
              <Edge key={n.id} a={byId[n.from!]} b={n} via={n.via} live={n.state === 'working'} />
            ))}
          </svg>
          {shown.map((n) => <Card key={n.id} n={n} on={n.id === sel} onPick={() => setSel(n.id)} onDrag={(dx, dy) => move(n.id, dx, dy)} />)}
        </div>
        <button onClick={replay} className="absolute top-3 left-3 flex h-7 items-center gap-1.5 rounded-md bg-background/80 px-2 text-small text-muted-foreground backdrop-blur hover:text-foreground">
          <RotateCcwIcon className="size-3.5" />Replay
        </button>
      </div>

      <aside className="flex w-[380px] shrink-0 flex-col border-l border-hairline bg-background">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
          <MakerLogo maker={cur.maker} className="size-3.5" />
          <span className="truncate text-ui font-medium">{cur.title}</span>
          <span className="ml-auto shrink-0 text-small text-faint">{cur.model} · {cur.effort}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5">
          {msgs.map((m, i) => m.from === 'you'
            ? <div key={i} className="ml-8 self-end rounded-2xl bg-muted px-3.5 py-2 text-ui">{m.text}</div>
            : <div key={i} className="text-ui leading-relaxed text-foreground/90">{m.text}</div>)}
          {cur.state === 'working' && <div className="shimmer-text text-ui">{cur.status}</div>}
        </div>
        <div className="p-3">
          <div className="flex items-end gap-2 rounded-[22px] border border-black/[0.06] bg-card py-2 pr-2 pl-4 shadow-[0_6px_28px_-6px_rgb(0_0_0/0.10)] dark:border-white/[0.07] dark:bg-[oklch(0.27_0_0)]">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={sel === 'mgr' ? 'Tell the manager…' : `Message ${cur.title}…`}
              className="max-h-32 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-ui outline-none placeholder:text-faint" />
            <button onClick={send} aria-label="Send" className={cn('flex size-8 shrink-0 items-center justify-center rounded-full transition-colors', draft.trim() ? 'bg-foreground text-background' : 'bg-muted text-faint')}>
              <ArrowUpIcon className="size-4" />
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

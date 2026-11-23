// Manager, kept simple. The manager is an ordinary chat. Beside it: the agents it started (one row each: maker, what
// it's on, model, state) and, under the list, the selected agent's work as it happens.
// Sample data on a scripted clock: nothing runs.
import { useEffect, useState } from 'react';
import { ArrowUpIcon, CheckIcon } from 'lucide-react';
import { MakerLogo } from '@/components/canopy/maker-logo';
import type { Maker } from '@/lib/models';
import { cn } from '@/lib/utils';

export const title = 'Manager';
export const note = 'A chat with the manager, the agents it started, and the selected one\'s work live.';

const END = 26;
const span = (t: number, a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));

type Id = 'page' | 'api' | 'tests';
const AGENTS: { id: Id; maker: Maker; job: string; model: string; from: number; done: number }[] = [
  { id: 'page', maker: 'claude', job: 'Team page', model: 'Sonnet 5.5 · Low', from: 2, done: 18 },
  { id: 'api', maker: 'claude', job: 'Invites API', model: 'Opus 5.5 · High', from: 2.3, done: 21 },
  { id: 'tests', maker: 'openai', job: 'Tests', model: 'GPT-6 Luna · Fast', from: 2.6, done: 24 },
];
const SAYS: { t: number; you?: boolean; text: string }[] = [
  { t: 0.3, you: true, text: 'Add team invites: invite by email and a Team page in Settings.' },
  { t: 1.6, text: 'Starting three agents. Opus on the API since it touches auth, Sonnet on the page, Codex on the tests.' },
  { t: 24.5, text: 'All done. 9 files changed, 42 tests passing.' },
];

function TeamPage({ k }: { k: number }) {
  const rows = [['Maya Chen', 'Owner'], ['Sam Ortiz', 'Admin'], ['Priya Nair', 'Member']];
  const show = (at: number) => cn('transition-opacity duration-500', k > at ? 'opacity-100' : 'opacity-0');
  return (
    <div className="flex flex-col gap-3 p-5">
      <div className={cn('text-[15px] font-semibold', show(0.05))}>Team</div>
      {rows.map(([n, r], i) => (
        <div key={n} className={cn('flex justify-between text-ui', show(0.2 + i * 0.15))}><span>{n}</span><span className="text-faint">{r}</span></div>
      ))}
      <div className={cn('mt-1 flex gap-2', show(0.75))}>
        <div className="flex h-8 flex-1 items-center rounded-md border border-border px-2.5 text-small text-faint">name@example.com</div>
        <div className="flex h-8 items-center rounded-md bg-foreground px-3 text-small text-background">Invite</div>
      </div>
    </div>
  );
}

const CODE = [
  "router.post('/invites', requireAdmin, async (req, res) => {",
  '  const { email } = InviteBody.parse(req.body);',
  '  const invite = await db.invites.create({',
  '    teamId: req.team.id, email,',
  '    expiresAt: addDays(new Date(), 7),',
  '  });',
  '  await mailer.send(inviteEmail(invite));',
  '  res.status(201).json(invite);',
  '});',
];
function Code({ k }: { k: number }) {
  return (
    <div className="p-5 font-mono text-[11.5px] leading-[19px] text-foreground/85">
      <div className="mb-2 text-faint">server/invites/routes.ts</div>
      {CODE.slice(0, Math.floor(k * CODE.length)).map((l, i) => <div key={i} className="whitespace-pre">{l}</div>)}
    </div>
  );
}

function Tests({ k }: { k: number }) {
  const n = Math.floor(k * 42);
  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="text-[22px] font-semibold tabular-nums">{n}<span className="text-ui font-normal text-faint"> of 42 passing</span></div>
      <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground/50" style={{ width: `${(n / 42) * 100}%` }} /></div>
    </div>
  );
}

export default function Manager() {
  const [t, setT] = useState(0);
  const [pick, setPick] = useState<Id>('page');
  const [draft, setDraft] = useState('');
  const [mine, setMine] = useState<{ t: number; you?: boolean; text: string }[]>([]);

  useEffect(() => {
    if (t >= END) return;
    const id = setTimeout(() => setT((x) => x + 0.1), 100);
    return () => clearTimeout(id);
  }, [t]);

  const said = [...SAYS, ...mine].filter((m) => m.t <= t).sort((a, b) => a.t - b.t);
  const up = AGENTS.filter((a) => t >= a.from);
  const cur = AGENTS.find((a) => a.id === pick)!;
  const k = span(t, cur.from + 0.5, cur.done);
  const send = () => { if (!draft.trim()) return; setMine((m) => [...m, { t, you: true, text: draft.trim() }]); setDraft(''); };

  return (
    <div className="flex h-full">
      {/* The manager: a normal chat */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[640px] min-h-0 flex-1 flex-col justify-end gap-4 px-6 py-6">
          {said.map((m, i) => m.you
            ? <div key={i} className="ml-16 self-end rounded-2xl bg-muted px-3.5 py-2 text-ui enter-fade">{m.text}</div>
            : <p key={i} className="text-ui leading-relaxed enter-fade">{m.text}</p>)}
        </div>
        <div className="mx-auto w-full max-w-[640px] px-6 pb-5">
          <div className="flex items-center gap-2 rounded-[22px] border border-black/[0.06] bg-card py-1.5 pr-1.5 pl-4 shadow-[0_6px_28px_-6px_rgb(0_0_0/0.10)] dark:border-white/[0.07] dark:bg-[oklch(0.27_0_0)]">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
              placeholder="Talk to the manager" className="h-8 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
            <button onClick={send} aria-label="Send" className={cn('flex size-8 items-center justify-center rounded-full', draft.trim() ? 'bg-foreground text-background' : 'text-faint')}>
              <ArrowUpIcon className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Its agents, and the selected one's work */}
      <aside className="flex w-[400px] shrink-0 flex-col border-l border-hairline">
        <div className="flex flex-col p-2" style={{ minHeight: 8 + AGENTS.length * 52 }}>
          {up.map((a) => {
            const done = t >= a.done;
            return (
              <button key={a.id} onClick={() => setPick(a.id)}
                className={cn('flex h-[52px] items-center gap-3 rounded-lg px-3 text-left enter-fade', pick === a.id ? 'bg-accent' : 'hover:bg-accent/60')}>
                <MakerLogo maker={a.maker} className="size-4" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui font-medium">{a.job}</span>
                  <span className="truncate text-small text-faint">{a.model}</span>
                </span>
                {done ? <CheckIcon className="size-4 text-faint" /> : <span className="shimmer-text text-small">Working</span>}
              </button>
            );
          })}
        </div>
        <div className="mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
          {t >= cur.from && (pick === 'page' ? <TeamPage k={k} /> : pick === 'api' ? <Code k={k} /> : <Tests k={k} />)}
        </div>
      </aside>
    </div>
  );
}

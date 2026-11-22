// How full a chat is and what it has done, in Canopy's voice: short plain lines, no boxes or labels.
// Shared by the chat menu (under the title) and the Stats tab, so the two always read the same.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { limitLines } from '@/lib/limits';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { fmtTok } from './controls';

export const fmtDur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };

/** "5% of context used · 952k left", a hairline bar, and the token count, then the plan's usage limits, one line
 *  each ("5-hour limit · 42% used · resets 3:10 PM"). Nothing until the first reply. */
export function ContextMeter({ className }: { className?: string }) {
  const { meta } = useStore();
  if (meta.ctxTokens == null || !meta.ctxMax) return null;
  const limits = limitLines(meta.limits);
  const pct = Math.min(100, (meta.ctxTokens / meta.ctxMax) * 100);
  const full = pct > 80;
  return (
    <div className={className}>
      <div className="flex items-baseline gap-2 text-ui">
        <span><span className={cn('font-medium tabular-nums', full ? 'text-warn' : 'text-foreground')}>{pct < 1 ? '<1' : Math.round(pct)}%</span> <span className="text-muted-foreground">of context used</span></span>
        <span className="ml-auto text-small text-faint tabular-nums">{fmtTok(Math.max(0, meta.ctxMax - meta.ctxTokens))} left</span>
      </div>
      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-foreground/[0.08]">
        <div className={cn('h-full rounded-full transition-[width] duration-500 ease-out', full ? 'bg-warn' : 'bg-foreground/55')} style={{ width: `${Math.max(1.5, pct)}%` }} />
      </div>
      <p className="mt-1.5 text-small text-faint tabular-nums">
        {full ? 'Getting full. Canopy will summarize older messages soon.' : `${fmtTok(meta.ctxTokens)} of ${fmtTok(meta.ctxMax)} tokens`}
      </p>
      {limits.map((l) => <p key={l.id} className="mt-1 text-small text-faint tabular-nums">{l.text}</p>)}
    </div>
  );
}

/** The chat's whole-life cost and working time. Claude Code keeps running totals in the transcript (they carry over
 *  when a chat is resumed); Canopy's own count only covers this session; the back end also prices every agent the chat
 *  started (workflows can outlive a turn). The largest wins. Re-read after every turn, and every 15s while it's shown,
 *  so agents still running keep adding up. */
export function useChatTotals() {
  const store = useStore();
  const { meta } = store;
  const [file, setFile] = useState<{ cost: number; agentCost?: number; workMs: number } | null>(null);
  const id = meta.sessionId;
  useEffect(() => {
    if (!id) { setFile(null); return; }
    let live = true;
    const read = () => api.chatTotals?.(store.sid ? store.cwd : null, id).then((t) => { if (live) setFile(t ?? null); }).catch(() => {});
    read();
    const timer = setInterval(read, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [id, meta.stats.turns]);
  return { cost: Math.max(file?.cost ?? 0, meta.stats.cost), agentCost: file?.agentCost ?? 0, workMs: Math.max(file?.workMs ?? 0, meta.stats.workMs) };
}

/** What this chat has done, one plain line each, only the ones that are true yet. */
export function chatFacts(stats: { cost: number; agentCost?: number; workMs: number }, messages: number, files?: { n: number; add: number; del: number }) {
  const out: { key: string; text: React.ReactNode }[] = [];
  if (messages) out.push({ key: 'm', text: <><b>{messages}</b> message{messages === 1 ? '' : 's'}</> });
  if (stats.workMs) out.push({ key: 't', text: <>Worked <b>{fmtDur(stats.workMs)}</b></> });
  if (stats.cost) out.push({ key: 'c', text: <><b>${stats.cost.toFixed(2)}</b> spent{stats.agentCost && stats.agentCost >= 0.01 ? <span className="ml-1.5 text-small text-faint">${stats.agentCost.toFixed(2)} by agents</span> : null}</> });
  if (files?.n) out.push({ key: 'f', text: <><b>{files.n}</b> file{files.n === 1 ? '' : 's'} changed <span className="ml-1 text-small"><span className="text-good">+{files.add}</span> <span className="text-destructive">−{files.del}</span></span></> });
  return out;
}

// A chat row's state in the sidebar, shown as ambience rather than badges:
//   working  → the title shimmers, a soft light sweeping across it on a loop
//   needs you → a small amber dot (the one thing that should be unmissable)
//   finished, not seen → a faint green glow rising from the row's right edge
import { useChatStatus } from '@/lib/chats';
import { useMarkedUnread } from '@/lib/unread';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Marquee } from './marquee';

export type ChatMark = 'working' | 'needs' | 'unread' | null;

export function useChatMark(sessionId: string | null | undefined): ChatMark {
  const s = useChatStatus(sessionId);
  const marked = useMarkedUnread();
  const { meta } = useStore();
  // The chat on screen: its own live state is the freshest (the store), so it shows working too. Not while it opens:
  // the store has just been cleared then, and reading it would flash the row from Working… to its last line and back.
  if (sessionId && sessionId === meta.sessionId && !meta.loading) {
    // Waiting on you (a question or an approval) says so here too, not "Working…": its reply is paused on you.
    if (s?.state === 'needs-you') return 'needs';
    const busy = meta.busy || meta.tasks.some((t) => t.status === 'running' || t.status === 'pending');
    return busy || s?.state === 'working' || (s?.helpers ?? 0) > 0 ? 'working' : null;
  }
  if (!s) return sessionId && marked.has(sessionId) ? 'unread' : null;
  if (s.state === 'needs-you') return 'needs';
  // Working: Canopy is replying, or agents / workflows / commands it started are still going.
  if (s.state === 'working' || (s.helpers ?? 0) > 0) return 'working';
  if (s.unread || (sessionId && marked.has(sessionId))) return 'unread';
  return null;
}

/** The title and its state, for a sidebar chat row (the row needs `relative overflow-hidden` for the glow). */
export function ChatRowTitle({ sessionId, title, className }: { sessionId: string; title: string; className?: string }) {
  const mark = useChatMark(sessionId);
  return (
    <>
      {/* Always there, faded in and out: marking read or unread eases instead of popping. */}
      <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-[linear-gradient(to_left,color-mix(in_oklch,var(--good)_22%,transparent),transparent_70%)] transition-opacity duration-700 ease-out',
        mark === 'unread' ? 'opacity-100' : 'opacity-0')} />
      {/* The shimmer sits on the text itself, so it moves with the title when hover scrolls it. */}
      <Marquee className={cn('relative flex-1', className)} title={mark === 'working' ? 'Working' : mark === 'unread' ? 'Finished, not seen yet' : undefined}
        contentClassName={cn('transition-[font-weight,color] duration-500 ease-out', mark === 'working' && 'shimmer-green', mark === 'unread' ? 'font-[550]' : 'font-normal')}>{title}</Marquee>
      {mark === 'needs' && <span role="img" aria-label="Needs you" title="Needs you" className="relative ml-2 size-2 shrink-0 rounded-full bg-warn shadow-[0_0_0_3px_color-mix(in_oklch,var(--warn)_18%,transparent)]" />}
    </>
  );
}

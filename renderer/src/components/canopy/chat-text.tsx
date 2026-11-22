// Messages between your chats, drawn as text messages. Claude Code lets one chat message another (SendMessage); the
// chat that sent it and the chat that got it both show it as a text on Claude's side of the conversation, the way
// a group chat shows someone else's message: the other chat as a contact (a lettered circle), a bubble with a tail
// beside it, and a line above saying who wrote to whom. In the sending chat the
// line above says who it went to and the line under it says whether it got there; in the receiving chat the line
// above says which chat it came from. Your own messages stay on the right, so a message no one typed never looks
// like one you did.
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRightIcon, MessageCircleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StoreContext, type ToolItem, type UserItem } from '@/lib/store';

/** Claude Code's tool for messaging another session. */
export const SEND_TOOL = 'SendMessage';

/** One of Claude's own helpers (an agent it started, addressed by id) is not another chat: that stays an ordinary step. */
const AGENT_ID = /^a[0-9a-f]{6,}$/;

/** A message this chat sent another one (a SendMessage call that carries words; a bare "tell me when it's idle" doesn't). */
export const isSentText = (it: { t: string; name?: string; input?: Record<string, unknown> }): boolean =>
  it.t === 'tool' && it.name === SEND_TOOL && typeof it.input?.message === 'string' && !!it.input.message.trim()
  && !AGENT_ID.test(String(it.input.to ?? '').trim());

/** The chat's name as people read it: "Docs [a1b2c3]" is Docs, and a raw address is just "another chat". */
export function chatName(to: unknown): string {
  const s = typeof to === 'string' ? to.trim().replace(/\s*\[[^\]]*\]$/, '') : '';
  if (!s || /^(uds|bridge|https?):/.test(s) || s.includes('/')) return 'another chat';
  return s === 'main' ? 'the main chat' : s;
}

/** A short fingerprint of a chat's address, made the same way as the engine's (chatKey in src/core/adapter.mjs). */
const chatKey = (addr: string) => { let h = 0x811c9dc5; for (let i = 0; i < addr.length; i++) h = Math.imul(h ^ addr.charCodeAt(i), 0x01000193); return `c${(h >>> 0).toString(36)}`; };

type Delivery = 'sending' | 'delivered' | 'failed';
function delivery(item: ToolItem): Delivery {
  if (item.status === 'running' || item.status === 'approval') return 'sending';
  if (item.isError || item.status === 'error' || /"success"\s*:\s*false/.test(item.result ?? '')) return 'failed';
  return 'delivered';
}
const DELIVERY: Record<Delivery, string> = { sending: 'Sending…', delivered: 'Delivered', failed: 'Not delivered' };

const CLAMP = 240; // ten lines, then "Show more"

/** Who wrote it, as a contact: the other chat's first letter (or a speech bubble when it has no name), or an
 *  outgoing arrow for a message Claude sent from here. */
function Avatar({ name, out }: { name: string; out?: boolean }) {
  const letter = out ? undefined : /^[a-z0-9]/i.exec(name)?.[0]?.toUpperCase();
  return (
    <div aria-hidden className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.09] text-small font-semibold text-foreground/80 ring-1 ring-foreground/[0.06]">
      {out ? <ArrowUpRightIcon className="size-3.5" /> : letter ?? <MessageCircleIcon className="size-3.5" />}
    </div>
  );
}

/** The bubble, Messages-style: round, with a small tail at its lower left pointing to the avatar. */
function TextBubble({ who, out, above, below, text, belowTone, className }: { who: string; out?: boolean; above: React.ReactNode; below?: React.ReactNode; text: string; belowTone?: string; className?: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => { if (body.current) setLong(body.current.scrollHeight > CLAMP + 24); }, [text]);
  return (
    <div className={cn('group/tm flex max-w-[85%] flex-col items-start', className)}>
      <div className="mb-1 ml-[46px] flex max-w-full items-center gap-1.5 truncate text-small text-faint">{above}</div>
      <div className="flex items-end gap-2.5">
        <Avatar name={who} out={out} />
        <div className="chat-text relative rounded-[20px] bg-secondary px-4 py-2.5 text-body shadow-[0_1px_0_rgb(255_255_255/0.04)_inset,0_8px_24px_-12px_rgb(0_0_0/0.5)]">
          <div ref={body} className={cn('user-bubble whitespace-pre-wrap break-words', long && !open && 'overflow-hidden [mask-image:linear-gradient(#000_calc(100%_-_40px),transparent)]')}
            style={long && !open ? { maxHeight: CLAMP } : undefined}>{text.trim()}</div>
          {/* the tail */}
          <svg aria-hidden viewBox="0 0 12 16" className="absolute -left-[5px] bottom-0 h-4 w-3 text-secondary" fill="currentColor"><path d="M12 0v16H0c3.5-1 6-4 6.5-8.5C7 4 8.5 1.5 12 0z" /></svg>
        </div>
      </div>
      {(long || below) && (
        <div className="mt-1 ml-[46px] flex items-center gap-3 text-micro">
          {below && <span className={belowTone ?? 'text-faint'}>{below}</span>}
          {long && <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-sm text-muted-foreground hover:text-foreground">{open ? 'Show less' : 'Show more'}</button>}
        </div>
      )}
    </div>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A message another of your chats sent this one. */
export function ReceivedText({ user, className }: { user: UserItem; className?: string }) {
  const who = user.peer || 'Another chat';
  return (
    <TextBubble className={className} who={user.peer ?? ''} text={user.text}
      above={<><span className="font-medium text-muted-foreground">{who}</span><span>messaged this chat</span>{!user.hist && <span className="opacity-0 transition-opacity group-hover/tm:opacity-100">· {time(user.at)}</span>}</>} />
  );
}

/** A message this chat sent another one. A reply to a chat that wrote here first is sent to its address, not its
 *  name: the name comes from that chat's message, which carries both. */
export function SentText({ item, className }: { item: ToolItem; className?: string }) {
  const store = useContext(StoreContext);
  const d = delivery(item);
  const to = String(item.input.to ?? '').trim();
  let name = chatName(to);
  if (name === 'another chat') {
    for (let i = store.items.length - 1; i >= 0; i--) {
      const it = store.items[i];
      if (it.t === 'user' && it.peer && it.peerAddr === chatKey(to)) { name = it.peer; break; }
    }
  }
  const known = name !== 'another chat';
  return (
    <TextBubble className={className} out who={known ? name : ''} text={String(item.input.message ?? '')}
      above={<><span>Claude messaged</span><span className="font-medium text-muted-foreground">{name}</span></>}
      below={DELIVERY[d]} belowTone={d === 'failed' ? 'text-destructive' : d === 'sending' ? 'shimmer-text text-faint' : 'text-faint'} />
  );
}

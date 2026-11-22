// The cards above your name in the sidebar: every one Canopy shows there ("Update ready", "GPT-6.2 is out", any later
// one) is a SidebarCard, and SidebarCards stacks them.
//
//   One card    a big, plain, floating card: an icon on a small tile, a title, two lines that say what it is about,
//               and one full-width button. Its own rounded border and a soft shadow; nothing tinted. A card that can
//               be put away has × in its corner, shown under the pointer.
//   Several     a deck. The newest is in front; up to two more peek out above it, each a little narrower and dimmer,
//               with "2 more" under the front card. Pointing at the deck (or tabbing into it) fans it out upward, over
//               the list, so every card can be read and used; it folds back when the pointer leaves. Putting the
//               front card away brings the next one forward.
//
// The deck's own height is the front card's plus the peek, so nothing below or above it moves as cards come and go
// behind it; fanned out, the cards float over the list instead of pushing it. Cards are one height for the same reason.
import { useState } from 'react';
import { XIcon } from 'lucide-react';
import { MakerLogo } from './maker-logo';
import { useUpdateCard } from './update-toast';
import { dismissRelease, tryRelease, useReleaseCards } from '@/lib/releases';
import { cn } from '@/lib/utils';

export type SidebarCardSpec = {
  id: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  action: { label: string; run: () => void };
  /** ×: put the card away. Left out: the card stays until what it is about is done (Update ready). */
  close?: () => void;
  /** When it arrived: the newest is in front. */
  at: number;
  /** One slim line instead of the full card: for a card that only says something is under way (Restarting soon). */
  compact?: boolean;
};

const CARD_H = 152;
const COMPACT_H = 44;
const heightOf = (card: SidebarCardSpec) => (card.compact ? COMPACT_H : CARD_H);
const PEEK = 10;        // how much of each card behind shows above the one in front
const SHOWN_BEHIND = 2; // more than two behind still count ("3 more"), but only two show
const GAP = 8;          // between cards fanned out

/** One card, drawn to fill the height the deck gives it. `quiet`: a card behind the front one shows only its edge. */
export function SidebarCard({ card, quiet = false }: { card: SidebarCardSpec; quiet?: boolean }) {
  if (card.compact) return (
    <div title={card.body} className="flex h-full items-center gap-2 rounded-xl border border-hairline bg-card pr-1.5 pl-3 shadow-[0_1px_2px_rgb(0_0_0/0.2),0_6px_16px_-8px_rgb(0_0_0/0.35)]">
      <div inert={quiet} className={cn('flex min-w-0 flex-1 items-center gap-2 transition-opacity duration-200', quiet && 'opacity-0')}>
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{card.icon}</span>
        <span className="min-w-0 flex-1 truncate text-small text-foreground">{card.title}</span>
        <button type="button" onClick={card.action.run}
          className="h-7 shrink-0 rounded-md px-2 text-small text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          {card.action.label}
        </button>
      </div>
    </div>
  );
  return (
    <div className="group/card flex h-full flex-col rounded-2xl border border-hairline bg-card p-3.5 shadow-[0_1px_2px_rgb(0_0_0/0.2),0_10px_24px_-8px_rgb(0_0_0/0.35)]">
      <div inert={quiet} className={cn('flex min-h-0 flex-1 flex-col transition-opacity duration-200', quiet && 'opacity-0')}>
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/80">{card.icon}</span>
          <div className="min-w-0 flex-1 truncate text-[15px] leading-5 font-medium text-foreground">{card.title}</div>
          {card.close && (
            <button type="button" onClick={card.close} aria-label="Dismiss"
              className="-mt-1 -mr-1 flex size-6 shrink-0 items-center justify-center self-start rounded-md text-faint opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground">
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
        <p className="mt-2.5 mb-3 line-clamp-2 shrink-0 text-small leading-[18px] text-muted-foreground">{card.body}</p>
        <button type="button" onClick={card.action.run}
          className="mt-auto h-8 w-full truncate rounded-lg px-2 text-small font-medium text-foreground ring-1 ring-hairline transition-colors hover:bg-accent">
          {card.action.label}
        </button>
      </div>
    </div>
  );
}

/** The deck. Nothing to show: nothing drawn at all. */
export function CardDeck({ cards }: { cards: SidebarCardSpec[] }) {
  const [open, setOpen] = useState(false);
  if (!cards.length) return null;
  const behind = Math.min(cards.length - 1, SHOWN_BEHIND);
  const fanned = open && cards.length > 1;
  return (
    <div role="region" aria-label={cards.length > 1 ? `${cards.length} notices` : cards[0].title}
      className="enter-up relative mx-2 mb-2 [--rise:8px]" style={{ height: heightOf(cards[0]) + behind * PEEK }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      {cards.map((card, i) => {
        const hidden = i > SHOWN_BEHIND && !fanned;
        // Folded: each card sits PEEK px above the one in front of it, 5% narrower and dimmer. Fanned: the heights of
        // the cards in front of it and a gap above each, full size.
        const below = cards.slice(0, i).reduce((sum, c) => sum + heightOf(c) + GAP, 0);
        const y = fanned ? -below : -i * PEEK;
        const scale = fanned ? 1 : 1 - i * 0.05;
        return (
          <div key={card.id} className="absolute inset-x-0 bottom-0 origin-top transition-[transform,opacity] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
            style={{ height: heightOf(card), zIndex: 20 - i, transform: `translateY(${y}px) scale(${scale})`, opacity: hidden ? 0 : fanned || i === 0 ? 1 : 1 - i * 0.25, pointerEvents: hidden ? 'none' : undefined }}>
            <SidebarCard card={card} quiet={!fanned && i > 0} />
          </div>
        );
      })}
      {cards.length > 1 && (
        <span aria-hidden className={cn('pointer-events-none absolute right-3 bottom-0 z-30 translate-y-full pt-0.5 text-micro text-faint transition-opacity', fanned && 'opacity-0')}>
          {cards.length - 1} more
        </span>
      )}
    </div>
  );
}

/** Every card Canopy has for the sidebar right now, newest in front. */
export function SidebarCards() {
  const update = useUpdateCard();
  const releases = useReleaseCards();
  const cards: SidebarCardSpec[] = releases.map((r) => ({
    id: r.id, at: r.at, title: r.title, body: r.body,
    icon: <MakerLogo maker={r.maker} className="size-[18px]" />,
    action: { label: `Try ${r.tryLabel}`, run: () => tryRelease(r) },
    close: () => dismissRelease(r.id),
  }));
  if (update) cards.push(update);
  cards.sort((a, b) => b.at - a.at);
  // "2 more" sits under the deck: room is kept for it only when it shows.
  return <div className={cn(cards.length > 1 && 'pb-3')}><CardDeck cards={cards} /></div>;
}


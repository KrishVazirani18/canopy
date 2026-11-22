// Widgets, Next: what chats could look like once Claude and Codex build visual widgets themselves from Canopy's
// building blocks (widgets-next/kit.tsx: pick on anything, a preview that follows the pointer, true-size scaling, one
// confirm row) and write the content in its own design language. Not only picking one of three: comparing in place,
// tuning with sliders, remixing, notes pinned on a design, ranking, keeping several, motion that plays. Every widget
// ends by sending a plain message the model can act on. A mock, drawn with React; the layouts are the model's.
import { Brand, Charts, Deck, Icons, Screens, Social } from './widgets-next/pick';
import { Copy, Fonts } from './widgets-next/compare';
import { Colors, Many, Markup, Motion, Rank, Remix, Tune } from './widgets-next/shape';

export const title = 'Widgets, Next';
export const note = 'Visual widgets models build from Canopy’s blocks: pick, compare, tune, remix, mark up, rank, keep several, play.';

type Ex = { id: string; ask: string; reply: string; how: string; Body: () => React.ReactNode };
const GROUPS: { name: string; line: string; items: Ex[] }[] = [
  { name: 'Pick', line: 'One of a few, judged by eye, each shown where it will live.', items: [
    { id: 'deck', ask: 'make a title slide for the canopy launch deck, give me a few directions', reply: 'Three directions at full size. Point at a thumbnail to see it large. I’d go with **Night Forest**: the mark carries the slide and it reads from the back of a room.', how: 'Big preview over real thumbnails', Body: Deck },
    { id: 'brand', ask: 'brand directions for the canopy site?', reply: 'Three boards, each with its wordmark, colors, a button and a line of copy, so you judge them whole. **Forest** fits a calm product best.', how: 'Boards side by side, in their own colors and type', Body: Brand },
    { id: 'screens', ask: 'how should the settings page be laid out', reply: 'The same settings in three layouts at true window size. **Sections on the Left** matches System Settings: nothing new to learn.', how: 'List beside a true-size screen', Body: Screens },
    { id: 'icon', ask: 'we need an app icon', reply: 'Each icon in the Dock and at every size macOS draws it, down to 16px where most icons fall apart. **Tiers** stays readable smallest.', how: 'The Dock, and every size', Body: Icons },
    { id: 'social', ask: 'design the card for the launch tweet', reply: 'Three cards, shown in the post they go out with. **Big Line** is the only one you can read while scrolling.', how: 'In the feed it will appear in', Body: Social },
    { id: 'chart', ask: 'how should Home show the week', reply: 'The same seven days three ways. **Bars** compare days at a glance; the line shows the week’s shape.', how: 'The same data, three forms', Body: Charts },
  ] },
  { name: 'Compare', line: 'Two things in the same place, so only the difference moves.', items: [
    { id: 'fonts', ask: 'im not sure i love the font canopy uses, can i pick from a few', reply: 'Drag across the text to compare with what Canopy uses now. **SF Pro** is the Mac’s own and stays crisp at small sizes.', how: 'Before and after, a divider to drag', Body: Fonts },
    { id: 'copy', ask: 'give me headline options for the site', reply: 'Three headlines set in the page itself. Flip to Phone: **Calm** still breaks well at 390px; the long one wraps to five lines.', how: 'In place, at desktop and phone size', Body: Copy },
  ] },
  { name: 'Tune', line: 'Not a list of options: dial it in and send the values.', items: [
    { id: 'colors', ask: 'what color should the needs-you dot be', reply: 'Point at a color to see it on the sidebar. **Leaf** is calm but still stands out; amber reads as a warning.', how: 'Swatches recolor a live preview', Body: Colors },
    { id: 'tune', ask: 'the chat cards feel cramped', reply: 'Dial them in here; the cards change as you drag, and I’ll use exactly what you send.', how: 'Sliders on a live preview', Body: Tune },
  ] },
  { name: 'Remix', line: 'Take each part from a different direction.', items: [
    { id: 'remix', ask: 'i like forest’s colors but dawn’s font', reply: 'Mix them: type, colors and layout each come from any of the three directions.', how: 'One choice per part, one live result', Body: Remix },
  ] },
  { name: 'Mark Up', line: 'Feedback where it applies, not described from memory.', items: [
    { id: 'markup', ask: 'the landing page is close, a few things are off', reply: 'Click anywhere on it to pin a note. I’ll get each note with where it was.', how: 'Notes pinned on the design', Body: Markup },
  ] },
  { name: 'Rank', line: 'Order matters more than one pick.', items: [
    { id: 'rank', ask: 'what should we build next', reply: 'Here’s what’s open. Drag them into the order you want them done.', how: 'Drag into order', Body: Rank },
  ] },
  { name: 'Keep Several', line: 'Many at once: keep these, cut those.', items: [
    { id: 'many', ask: 'onboarding feels long', reply: 'All six screens. The three I’d keep are ticked; change any of them.', how: 'Tick the ones to keep', Body: Many },
  ] },
  { name: 'Play', line: 'Things that move are judged moving.', items: [
    { id: 'motion', ask: 'how should cards appear', reply: 'Four ways in. Point at one to watch it again. **Rise** is quick and quiet; spring is fun once, tiring by the tenth.', how: 'Options that play', Body: Motion },
  ] },
];

const bold = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

export default function WidgetsNext() {
  const jump = (id: string) => document.getElementById(`wn-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="h-full overflow-y-auto px-10 pt-8 pb-40">
      <div className="mx-auto flex w-full max-w-[var(--col)] flex-col gap-14">
        <header className="flex flex-col gap-3">
          <div className="text-[22px] font-semibold">Widgets, next</div>
          <p className="text-ui leading-[1.6] text-muted-foreground">What a chat could look like when Claude or Codex builds the widget itself: Canopy gives the blocks (pick on anything, a preview that follows the pointer, true-size scaling, one confirm row) and the model lays out the rest in the content’s own colors and type. Every widget ends by sending a plain message.</p>
          <nav className="flex flex-wrap gap-1.5">
            {GROUPS.map((g) => <button key={g.name} type="button" onClick={() => jump(g.items[0].id)} className="h-7 rounded-full border border-hairline px-3 text-small text-muted-foreground hover:text-foreground">{g.name} <span className="text-faint">{g.items.length}</span></button>)}
          </nav>
        </header>
        {GROUPS.map((g) => (
          <div key={g.name} className="flex flex-col gap-14">
            <div className="-mb-8 border-t border-hairline pt-5"><div className="text-ui font-medium">{g.name}</div><div className="text-small text-muted-foreground">{g.line}</div></div>
            {g.items.map(({ id, ask, reply, how, Body }) => (
              <section key={id} id={`wn-${id}`} className="flex scroll-mt-6 flex-col gap-5">
                <div className="user-bubble ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2 text-body">{ask}</div>
                <div className="prose-reply" dangerouslySetInnerHTML={{ __html: bold(reply) }} />
                <Body />
                <div className="-mt-2 text-small text-faint">Built by the model · {how}</div>
              </section>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// Working line icons: a small forest icon beside the turn's word ("Squirreling away… 12s"), one per group of words.
// Each icon is drawn for Canopy and moves its own way (components/canopy/forest-icons). Seen here at true size in
// a chat, held still on the finished line, and enlarged so the motion can be judged.
import { useEffect, useState } from 'react';
import { ForestIcon, type ForestKind } from '@/components/canopy/forest-icons';

export const title = 'Working Line Icons';
export const note = 'A forest icon beside the working word, one per group of words, each with its own motion.';

type Group = { kind: ForestKind; name: string; motion: string; words: [string, string][] };
const GROUPS: Group[] = [
  { kind: 'sprout', name: 'Sprout', motion: 'Stem rises, leaves unfold', words: [['Sprouting', 'Sprouted'], ['Germinating', 'Germinated'], ['Unrolling fiddleheads', 'Unrolled fiddleheads']] },
  { kind: 'leaf', name: 'Leaf', motion: 'Falls, zigzagging, fades out', words: [['Rustling', 'Rustled'], ['Leafing through', 'Leafed through'], ['Leaf-peeping', 'Leaf-peeped']] },
  { kind: 'tree', name: 'Tree', motion: 'Shakes, a leaf drops to the ground', words: [['Taking root', 'Took root'], ['Growing rings', 'Grew rings'], ['Branching out', 'Branched out']] },
  { kind: 'forest', name: 'Forest', motion: 'Pines shoot up one after the other', words: [['Wandering the woods', 'Wandered the woods'], ['Forest bathing', 'Forest bathed'], ['Rewilding', 'Rewilded']] },
  { kind: 'flower', name: 'Flower', motion: 'Stem grows, leaves open, bloom spins open', words: [['Blossoming', 'Blossomed'], ['Pollinating', 'Pollinated']] },
  { kind: 'shovel', name: 'Shovel', motion: 'Digs in, throws dirt', words: [['Planting', 'Planted'], ['Mulching', 'Mulched'], ['Turning the compost', 'Turned the compost']] },
  { kind: 'axe', name: 'Axe', motion: 'Swings into the stump, chips fly', words: [['Splitting logs', 'Split logs'], ['Whittling', 'Whittled'], ['Chopping kindling', 'Chopped kindling']] },
  { kind: 'acorn', name: 'Acorn', motion: 'Drops, bounces, cap wobbles', words: [['Gathering acorns', 'Gathered acorns'], ['Squirreling away', 'Squirreled away']] },
  { kind: 'squirrel', name: 'Squirrel', motion: 'Hops in, flicks its tail, hops off', words: [['Burrowing', 'Burrowed'], ['Shimmying up', 'Shimmied up']] },
  { kind: 'bird', name: 'Bird', motion: 'Flies in, lands, pecks, flies off', words: [['Nesting', 'Nested'], ['Perching', 'Perched'], ['Birdwatching', 'Birdwatched']] },
  { kind: 'trail', name: 'Trail', motion: 'Footprints walk up the path', words: [['Bushwhacking', 'Bushwhacked'], ['Trailblazing', 'Trailblazed'], ['Following the creek', 'Followed the creek']] },
  { kind: 'campfire', name: 'Campfire', motion: 'Catches, flares with sparks, dies down', words: [['Kindling a campfire', 'Kindled a campfire'], ['Toasting marshmallows', 'Toasted marshmallows']] },
  { kind: 'camp', name: 'Camp', motion: 'Tent draws itself, door flaps, star pops out', words: [['Camping out', 'Camped out'], ['Pitching a tent', 'Pitched a tent']] },
  { kind: 'sun', name: 'Sun', motion: 'Rises over the horizon, rays shoot out', words: [['Soaking up sun', 'Soaked up sun'], ['Photosynthesizing', 'Photosynthesized']] },
  { kind: 'rain', name: 'Rain', motion: 'Drops fall and ripple where they land', words: [['Drinking the rain', 'Drank the rain'], ['Weathering the storm', 'Weathered the storm']] },
  { kind: 'wind', name: 'Wind', motion: 'Gusts blow through', words: [['Bending in the wind', 'Bent in the wind'], ['Catching the breeze', 'Caught the breeze']] },
];
const ALL = GROUPS.flatMap((g) => g.words.map((w) => ({ kind: g.kind, word: w })));

function useTick(ms: number) {
  const [n, setN] = useState(0);
  useEffect(() => { const id = setInterval(() => setN((x) => x + 1), ms); return () => clearInterval(id); }, [ms]);
  return n;
}
const fmt = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

/** The live line under a working turn: icon, shimmering word, faint clock. A new word every few seconds here, so
 *  every icon comes round; in the app it's one per turn. */
function Live() {
  const i = useTick(3200) % ALL.length;
  const secs = 4 + useTick(1000);
  const { kind, word } = ALL[i];
  return (
    <div className="flex h-6 min-w-0 items-center gap-2 text-ui tabular-nums">
      <span key={i} className="flex min-w-0 items-center gap-1.5 enter-fade [animation-duration:160ms]">
        <ForestIcon kind={kind} className="text-muted-foreground" />
        <span className="shimmer-text truncate">{word[0]}</span>
      </span>
      <span className="shrink-0 text-faint">{fmt(secs)}</span>
    </div>
  );
}

function Done({ g, w, secs }: { g: Group; w: number; secs: string }) {
  return (
    <div className="flex items-center gap-1.5 text-small text-faint tabular-nums">
      <ForestIcon kind={g.kind} still className="size-3" />
      <span>{g.words[w][1]} for {secs} · Done 3:42 PM · Opus 5.5</span>
    </div>
  );
}

const by = (k: ForestKind) => GROUPS.find((g) => g.kind === k)!;

export default function WorkingLineIcons() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[780px] flex-col gap-8 px-6 py-10">
        <section className="flex flex-col gap-3">
          <h2 className="text-small font-medium text-muted-foreground">While Claude works</h2>
          <div className="flex flex-col gap-3 rounded-xl border border-hairline bg-background p-5">
            <div className="flex justify-end"><div className="user-bubble rounded-2xl bg-muted px-3.5 py-2 text-foreground">can we add icons to the working line</div></div>
            <p className="prose-reply text-foreground">Looking at how the status line is drawn first.</p>
            <Live />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-small font-medium text-muted-foreground">When the turn is done, held still</h2>
          <div className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-background p-5">
            <Done g={by('acorn')} w={1} secs="40s" />
            <Done g={by('campfire')} w={1} secs="2m 14s" />
            <Done g={by('trail')} w={0} secs="18s" />
            <Done g={by('axe')} w={0} secs="6s" />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-small font-medium text-muted-foreground">Each icon, enlarged and at true size</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {GROUPS.map((g) => (
              <div key={g.kind} className="flex flex-col gap-3 rounded-xl border border-hairline bg-background p-4">
                <div className="flex items-end justify-between">
                  <ForestIcon kind={g.kind} className="size-12 text-foreground" />
                  <ForestIcon kind={g.kind} className="text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="text-small text-foreground">{g.name}</div>
                  <div className="text-small text-faint">{g.motion}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

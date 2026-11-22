// The plan card: a plan that is ready, drawn in the chat where it was made. One card for both makers, with the
// same look and the same words (the rules are in lib/plan.ts; this file never asks which maker made the plan).
//   Build it        approves the plan and leaves Plan for the mode you were in before it (else Ask).
//   Keep planning   puts the cursor in the message box. What you send there is the feedback.
// Answered, the card stays where it was: dimmed, the plan folded to its first lines, with how it was answered.
import { useContext, useSyncExternalStore } from 'react';
import { MapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MessageResponse } from '@/components/ai-elements/message';
import { choices } from '@/lib/choices';
import { MODE_SHORT, buildIt, modeAfterPlan, outcomeWord, planTextOf, type PlanItem } from '@/lib/plan';
import { StoreContext } from '@/lib/store';
import { AllowButton, Clamp, Shell } from './permission-card';

export function PlanCard({ item }: { item: PlanItem }) {
  const store = useContext(StoreContext); // this chat's store (a Multi mode pane has its own)
  // Follows the store only for the one thing it shows from it, so a reply streaming below never redraws the plan.
  const mode = useSyncExternalStore(store.subscribe, () => modeAfterPlan(store));
  const plan = planTextOf(item);
  if (item.resolved) {
    return (
      <Shell resolved icon={MapIcon} title="Plan" said={outcomeWord(item)}>
        <Clamp more="Show the whole plan">
          <div className="prose-reply prose-compact"><MessageResponse>{plan}</MessageResponse></div>
        </Clamp>
      </Shell>
    );
  }
  return (
    <Shell resolved={false} icon={MapIcon} title="Plan ready">
      <div className="prose-reply prose-compact max-h-[28rem] overflow-y-auto"><MessageResponse>{plan}</MessageResponse></div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* The mode it builds in becomes your pick too, so the next chat does not start in Plan by surprise. */}
        <AllowButton inView onClick={() => { choices.mode = buildIt(store, item); }}>Build it</AllowButton>
        <Button variant="ghost" onClick={() => window.dispatchEvent(new Event('canopy:focus-composer'))}>Keep planning</Button>
        <span className="ml-auto text-small text-faint">Builds in {MODE_SHORT[mode] ?? MODE_SHORT.default}</span>
      </div>
    </Shell>
  );
}

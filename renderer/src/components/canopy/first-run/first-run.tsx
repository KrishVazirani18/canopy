// The first run, over the app: onboarding (Hello, your Canopy account, setting things up, your accounts), then the
// tour on the real window. Shown once: App asks main whether it's behind you (onboarding:get) and tells it when the
// tour is over (onboarding:done). The app is drawn underneath from the start, so it's ready the moment onboarding
// finishes: Continue on the last step fades onboarding away and the tour begins.
import { useState } from 'react';
import { api } from '@/lib/api';
import Onboarding from './onboarding';
import { TourOverlay } from './tour';

// Onboarding sits under Canopy's dialogs (z-50 and up), so a sign-in sheet opened from Your Accounts shows over it.
export function FirstRun({ design = false, onDone }: { design?: boolean; onDone?: () => void }) {
  const [phase, setPhase] = useState<'onboarding' | 'leaving' | 'tour'>('onboarding');
  const finish = () => { setPhase('leaving'); setTimeout(() => setPhase('tour'), 650); };
  const finished = () => { if (typeof api?.onboarding?.done === 'function') void api.onboarding.done(); onDone?.(); };
  return (
    <>
      {phase !== 'tour' && (
        <div className="fixed inset-0 z-[45] transition-opacity duration-[650ms] ease-out" style={{ opacity: phase === 'leaving' ? 0 : 1 }}>
          <Onboarding onFinish={finish} design={design} />
        </div>
      )}
      {phase === 'tour' && <TourOverlay design={design} onFinished={finished} />}
    </>
  );
}

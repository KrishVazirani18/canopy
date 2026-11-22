// New-chat screen: one question and the composer, centred. Nothing else, except a very faint patch of the onboarding's
// ASCII light along the bottom (dark mode only), held behind everything.
// The composer glides (FLIP) from here to the docked position when the first message is sent.
import { useEffect, useState } from 'react';
import { Composer } from './composer';
import { AsciiLight } from './first-run/onboarding';

/** A slow clock for the backdrop: a few steps a second is all it draws, and none when motion is reduced. */
function useSlowTime() {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setT(4000); return; }
    const start = performance.now();
    const id = window.setInterval(() => setT(performance.now() - start), 220);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

export function EmptyState({ files, cwd }: { files: string[] | null; cwd: string | null }) {
  const t = useSlowTime();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center pb-24">
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden overflow-hidden opacity-[0.55] dark:block">
        <AsciiLight t={t} field="spots" />
      </div>
      <h1 className="relative mb-8 px-5 text-center text-display enter-up">What are we working on?</h1>
      <div className="relative z-10 flex w-full flex-col items-center"><Composer files={files} cwd={cwd} hero /></div>
    </div>
  );
}

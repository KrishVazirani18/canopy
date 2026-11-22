// Smoothly reveals / hides content in BOTH directions: height animates via grid rows (0fr ↔ 1fr, no
// measuring), content fades and drifts. Stays mounted through the exit, then unmounts.
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type Phase = 'hidden' | 'entering' | 'shown' | 'leaving';

export function Reveal({ show, children, className, from = 'top', duration = 260, appear = false }: {
  show: boolean; children: React.ReactNode; className?: string; from?: 'top' | 'bottom'; duration?: number;
  /** animate in on first mount too (for things that arrive, like approval cards) */ appear?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(show && !appear ? 'shown' : 'hidden');
  useEffect(() => {
    if (show) {
      if (phase === 'shown' || phase === 'entering') return;
      setPhase('entering');
      // two frames so the 0fr state paints before we transition to 1fr
      let r2 = 0;
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setPhase('shown')); });
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    }
    if (phase === 'hidden' || phase === 'leaving') return;
    setPhase('leaving');
    const t = setTimeout(() => setPhase('hidden'), duration);
    return () => clearTimeout(t);
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'hidden') return null;
  const open = phase === 'shown';
  return (
    <div className={cn('grid motion-reduce:transition-none', className)}
      style={{ gridTemplateRows: open ? '1fr' : '0fr', transition: `grid-template-rows ${duration}ms cubic-bezier(0.32,0.72,0,1)` }}>
      <div className="min-h-0 overflow-hidden">
        <div className="motion-reduce:transition-none" style={{
          opacity: open ? 1 : 0,
          transform: open ? 'none' : `translateY(${from === 'bottom' ? 10 : -6}px) scale(${from === 'bottom' ? 0.985 : 1})`,
          transformOrigin: from === 'bottom' ? '50% 100%' : '50% 0%',
          transition: `opacity ${open ? duration : duration * 0.7}ms ease-out ${open ? 40 : 0}ms, transform ${duration}ms cubic-bezier(0.16,1,0.3,1)`,
        }}>
          {children}
        </div>
      </div>
    </div>
  );
}

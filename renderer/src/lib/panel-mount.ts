// The side panel's mount-and-slide timing.
import { useEffect, useState } from 'react';

/**
 * [mounted, shown] for a panel that slides in and out as `open` changes.
 * Keep the panel mounted until its slide-out finishes, then unmount it (no background polling).
 * Opening: mount the contents first (off-screen), then slide on the next frames, so building the panel never
 * lands inside the animation. Closing: slide first, unmount after. Both directions are the same 240ms motion.
 */
export function usePanelMount(open: boolean): [mounted: boolean, shown: boolean] {
  const [panelMounted, setPanelMounted] = useState(open);
  const [panelShown, setPanelShown] = useState(open);
  useEffect(() => {
    if (open) {
      setPanelMounted(true);
      let r2 = 0;
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setPanelShown(true)); });
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    }
    setPanelShown(false);
    const t = setTimeout(() => setPanelMounted(false), 260);
    return () => clearTimeout(t);
  }, [open]);
  return [panelMounted, panelShown];
}

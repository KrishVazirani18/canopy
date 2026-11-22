// Your Canopy account (Google sign-in), for the window: who you are and your photo, kept current as you sign in or
// out. Never a token. Null until main has answered (or when main has no account to tell: an older main, the harness).
import { useEffect, useState } from 'react';
import { api, type CanopyAccountView } from './api';
import { fromSource } from './ui';

/** The account bridge, if main really has one (an older main, or the design harness's stand-in, may not). */
export const accountBridge = () => { const a = api?.canopyAccount; return a && typeof a.get === 'function' && typeof a.signIn === 'function' ? a : null; };

export function useCanopyAccount(): CanopyAccountView | null {
  const [v, setV] = useState<CanopyAccountView | null>(null);
  useEffect(() => {
    const acct = accountBridge();
    if (!acct) return;
    let here = true;
    acct.get().then((r) => { if (here && !('error' in r)) setV(r); }).catch(() => {});
    const off = acct.onChanged((r) => setV(r));
    return () => { here = false; off(); };
  }, []);
  return v;
}

/** Whether the first run (onboarding, then the tour) should show: ?mock=onboarding always (from source only); otherwise main says. */
export function useFirstRun(): [boolean, () => void] {
  const forced = fromSource && new URLSearchParams(location.search).get('mock') === 'onboarding';
  const [show, setShow] = useState(forced);
  useEffect(() => {
    if (forced) return;
    if (typeof api?.onboarding?.get !== 'function') return;
    api.onboarding.get().then((r) => { if (!('error' in r) && !r.done) setShow(true); }).catch(() => {});
  }, [forced]);
  return [show, () => setShow(false)];
}

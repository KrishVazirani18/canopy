// "Update required": the whole window, when the release feed says this version of Canopy may no longer be used
// (src/core/app-update.mjs: minVersion). One message, in the release's own words, and one button that downloads the
// update if that has not happened yet, installs it and restarts. Chats that are working are waited for; the screen
// says so. It only ever appears after a feed was read in this run, so being offline never brings it up, and when the
// update cannot be downloaded or installed, "Not now" lets Canopy be used all the same.
//
// Laid out like Canopy's other full-window stops (App.tsx: Install Claude Code, Canopy couldn't start): the mark, a
// title, a line or two, one button. Under it, room kept for what is going on and, only when the update cannot be had,
// "Not now", so nothing shifts.
import { useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { appUpdate, useAppUpdate } from '@/lib/app-update';
import { requiredView } from '@/lib/app-update-words';
import { useWorkingChats } from '@/lib/chats';
import { Logo } from './logo';

export function UpdateRequired() {
  const status = useAppUpdate();
  const working = useWorkingChats();
  const [asked, setAsked] = useState(false);      // the button was pressed: install as soon as it can be
  const [notNow, setNotNow] = useState<string | null>(null); // the version "Not now" was said to, after it could not be installed
  const required = status?.required ?? null;
  const open = !!status && !!required && notNow !== required.version;
  if (!status || !required) return null;
  const view = requiredView(status, asked, working);

  const go = () => {
    if (view.elsewhere) { if (status.downloadUrl) window.open(status.downloadUrl); return; }
    setAsked(true);
    void appUpdate.installRequired();
  };
  const later = () => { setAsked(false); setNotNow(required.version); void appUpdate.cancelRequired(); };

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content data-update-required aria-describedby="update-required-message"
          onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-0 z-[100] flex flex-col bg-background outline-none enter-fade">
          <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
          <div className="flex flex-1 items-center justify-center p-6 pb-24">
            <div className="flex w-full max-w-md flex-col items-center text-center">
              <Logo className="mb-5 size-10 text-brand" />
              <DialogPrimitive.Title className="mb-1.5 text-display">Update required</DialogPrimitive.Title>
              <p id="update-required-message" className="text-ui text-muted-foreground">{view.message}</p>
              <Button autoFocus aria-disabled={view.busy || undefined} className="mt-6 min-w-36 aria-disabled:pointer-events-none aria-disabled:opacity-60"
                onClick={() => { if (!view.busy) go(); }}>
                {view.busy && <Spinner className="size-4" />}{view.button}
              </Button>
              {/* Both lines always take their space, so nothing shifts when words appear. */}
              <p role="status" className="mt-3 h-5 text-small text-muted-foreground">{view.line && <span className="enter-fade">{view.line}</span>}</p>
              <p className="mt-1 h-5 text-small">
                {view.escape && <button type="button" onClick={later} className="enter-fade rounded text-muted-foreground hover:text-foreground">Not now</button>}
              </p>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

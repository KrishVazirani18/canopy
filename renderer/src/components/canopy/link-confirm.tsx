// Opening a link from a reply: Canopy's own confirm (Streamdown's linkSafety hook), centered in the window.
// Just the question, the whole link, and Cancel / Open (Enter opens, Esc cancels); a site you trust can be set to
// open without asking.
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { feature } from '@/lib/telemetry';

const KEY = 'canopy.trustedSites';
const trusted = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } };
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Skip the confirm for sites you've chosen to always open. */
export const linkIsTrusted = (url: string) => { const h = hostOf(url); return !!h && trusted().includes(h); };
/** The same question, asked as a link is clicked: a trusted one opens right after, so it is counted as opened here. */
export const opensTrusted = (url: string) => { const ok = linkIsTrusted(url); if (ok) feature('link_opened'); return ok; };

export function LinkConfirm({ isOpen, onClose, onConfirm, url }: { isOpen: boolean; onClose: () => void; onConfirm: () => void; url: string }) {
  const [always, setAlways] = useState(false);
  const host = hostOf(url);
  const open = () => {
    if (always && host) { const t = trusted(); if (!t.includes(host)) localStorage.setItem(KEY, JSON.stringify([...t, host])); }
    feature('link_opened');
    onConfirm(); onClose();
  };
  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false} className="w-[min(380px,90vw)] max-w-none gap-0 p-5 sm:max-w-none">
        <DialogTitle className="text-ui font-medium text-foreground">Open this link?</DialogTitle>
        <DialogDescription className="mt-1.5 line-clamp-3 font-mono text-small break-all text-muted-foreground" title={url}>{url}</DialogDescription>
        <div className="mt-5 flex items-center gap-2">
          {host && (
            <label className="mr-auto flex min-w-0 cursor-pointer items-center gap-2 text-small text-muted-foreground select-none">
              <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="size-3.5 shrink-0 accent-[var(--foreground)]" />
              <span className="truncate">Always open {host}</span>
            </label>
          )}
          <button className="ml-auto h-8 shrink-0 rounded-md px-3 text-small text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>Cancel</button>
          <button autoFocus className="h-8 shrink-0 rounded-md bg-foreground px-3.5 text-small font-medium text-background hover:opacity-90" onClick={open}>Open</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from 'react';
import { ArrowUpIcon, RotateCcwIcon } from 'lucide-react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Shell } from '@/components/canopy/permission-card';
import { UserBubble } from '@/components/canopy/transcript';
import { Button } from '@/components/ui/button';
import type { UserItem } from '@/lib/store';
import chromeLogo from '@/components/canopy/assets/chrome.svg';

export const title = 'Connect Chrome';

type Stage = 'connect' | 'setup' | 'allow' | 'connected' | 'skipped';
const ask: UserItem = {
  t: 'user', key: 'chrome-demo', rev: 0, at: 0, images: 0,
  text: 'I have Gradescope open. What’s due next?',
};

function ChromeMark({ className }: { className?: string }) {
  return <img src={chromeLogo} alt="" className={className} draggable={false} />;
}

export default function ChromeConnectMock() {
  const [enabled, setEnabled] = useState(false);
  const [stage, setStage] = useState<Stage>('connect');
  const pending = stage === 'connect' || stage === 'setup' || stage === 'allow';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-1.5 sm:px-6">
        <label className="flex items-center gap-2 text-small text-muted-foreground">
          <span>Preview</span>
          <select aria-label="Chrome setup scenario" value={enabled ? 'enabled' : 'fresh'} onChange={(event) => {
            setEnabled(event.target.value === 'enabled');
            setStage('connect');
          }} className="h-7 rounded-md border border-hairline bg-background px-2 text-small text-foreground">
            <option value="fresh">Fresh setup</option>
            <option value="enabled">Remote debugging enabled</option>
          </select>
        </label>
        <div className="flex items-center gap-1">
          {stage === 'setup' && <Button size="sm" variant="outline" onClick={() => setStage('allow')}>Simulate setup in Chrome</Button>}
          {stage === 'allow' && <Button size="sm" variant="outline" onClick={() => setStage('connected')}>Simulate Allow in Chrome</Button>}
          <Button size="icon-sm" variant="ghost" aria-label="Replay Chrome connection" title="Replay" onClick={() => setStage('connect')}>
            <RotateCcwIcon />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[calc(var(--col,720px)+80px)] flex-col gap-6 px-6 pt-8 pb-6 sm:px-10">
          <UserBubble user={ask} />
          <div className="prose-reply">
            <MessageResponse>I’ll check your open Gradescope tab.</MessageResponse>
          </div>
          {stage === 'connected' && (
            <>
              <div className="flex items-center gap-2 text-small text-muted-foreground" role="status">
                <ChromeMark className="size-3.5" /> Chrome connected
              </div>
              <div className="prose-reply">
                <MessageResponse>{'**Problem Set 6** is due next, Friday at **11:59 PM ET**.'}</MessageResponse>
              </div>
            </>
          )}
          {stage === 'skipped' && <p className="text-small text-muted-foreground" role="status">Chrome connection skipped.</p>}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[calc(var(--col,720px)+80px)] shrink-0 px-6 pb-5 sm:px-10">
        {pending && (
          <div className="pb-3">
            <Shell resolved={false} icon={ChromeMark} title={stage === 'connect' ? 'Connect Chrome' : stage === 'setup' ? 'Finish setup in Chrome' : 'Allow access in Chrome'}>
              {stage === 'connect' ? (
                <p className="text-ui text-muted-foreground">Use your open Chrome tabs to check what’s due on Gradescope.</p>
              ) : stage === 'setup' ? (
                <div role="status" className="space-y-2 text-ui text-muted-foreground">
                  <p>Turn on <span className="text-foreground">Allow remote debugging for this browser instance</span> in Chrome. Then click <span className="text-foreground">Allow</span> when Chrome asks.</p>
                  <code className="select-all break-all rounded bg-secondary px-1.5 py-0.5 text-small">chrome://inspect/#remote-debugging</code>
                </div>
              ) : (
                <p role="status" className="text-ui text-muted-foreground">Click <span className="text-foreground">Allow</span> in Chrome. This chat will pick up automatically.</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {stage === 'connect' && <Button onClick={() => setStage(enabled ? 'allow' : 'setup')}>Connect Chrome</Button>}
                <Button variant="ghost" className="text-muted-foreground" onClick={() => setStage('skipped')}>{stage === 'connect' ? 'Not now' : 'Cancel'}</Button>
              </div>
            </Shell>
          </div>
        )}
        <div aria-hidden className="rounded-2xl border border-hairline bg-card">
          <p className="min-h-14 px-4 pt-4 text-body text-faint">Message</p>
          <div className="flex justify-end px-2 pb-2"><Button size="icon" disabled tabIndex={-1}><ArrowUpIcon /></Button></div>
        </div>
      </div>
    </div>
  );
}

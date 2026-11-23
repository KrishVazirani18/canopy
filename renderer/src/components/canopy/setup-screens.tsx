// The three screens that fill the window before the app itself is on it: the logo while Canopy starts, what to do
// when Claude Code is missing, signed out or would not start, and the welcome that asks for a first project.
// They are opaque: under native vibrancy the window itself is clear.
import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon, FolderOpenIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Logo } from '@/components/canopy/logo';

/** What stands between Canopy and its first chat. */
export type Problem = 'missing' | 'login' | 'error';

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="h-11 shrink-0 border-b bg-sidebar [-webkit-app-region:drag]" />
      <div className="flex flex-1 items-center justify-center p-6 pb-24">
        <div className="w-full max-w-sm text-center">{children}</div>
      </div>
    </div>
  );
}

// A command to paste into Terminal: selectable by hand, or one click on the copy button.
function CopyCommand({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1200);
  };
  return (
    <div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3 text-left">
      <code data-selectable className="min-w-0 flex-1 truncate font-mono text-code text-foreground">{text}</code>
      <button type="button" aria-label={done ? 'Copied' : 'Copy command'} onClick={copy}
        className="press flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
        <span key={String(done)} className="swap-in">{done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}</span>
      </button>
    </div>
  );
}

/** While Canopy starts. The logo only fades in if startup is slow (250ms), so a fast boot shows no flash at all. */
export function LoadingScreen() {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="h-11 shrink-0 border-b bg-sidebar [-webkit-app-region:drag]" />
      <div className="flex flex-1 items-center justify-center pb-11">
        {/* Continues the logo index.html shows before React loads: same spot, same timing, so it never blinks. */}
        <Logo className="grow size-10 text-brand" style={{ ['--t0' as string]: `-${Math.round(performance.now())}ms` }} />
      </div>
    </div>
  );
}

/** Claude Code is missing, signed out, or would not start. `still`: the problem a "Check again" found unchanged, so
 *  the screen can say so. `onCheck` looks again. */
export function SetupScreen({ problem, detail, rechecking, still, onCheck }: { problem: Problem; detail?: string; rechecking: boolean; still: Problem | null; onCheck: () => void }) {
  const code = 'font-mono text-code text-foreground';
  return (
    <Centered>
      <Logo className="mx-auto mb-6 size-12 text-brand" />
      <h1 className="mb-2 text-display">{problem === 'missing' ? 'Install Claude Code' : problem === 'login' ? 'Sign in to Claude Code' : 'Canopy couldn’t start'}</h1>
      <div className="space-y-3 text-ui text-muted-foreground">
        {problem === 'missing' && (<>
          <p>Canopy needs Claude Code on this Mac. Paste this into Terminal:</p>
          <CopyCommand text="curl -fsSL https://claude.ai/install.sh | bash" />
        </>)}
        {problem === 'login' && (<>
          <p>Paste this into Terminal to open Claude Code:</p>
          <CopyCommand text="claude" />
          <p>Then type <code className={code}>/login</code> and follow the steps. Come back here when you’re signed in.</p>
        </>)}
        {problem === 'error' && <p data-selectable>{detail}</p>}
      </div>
      {/* Focused from the start so Return checks again. aria-disabled, not disabled, while it checks: a
          disabled button drops focus, and Return would stop working after the first try. */}
      <Button autoFocus aria-disabled={rechecking || undefined} className="mt-8 w-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
        onClick={onCheck}>
        {rechecking ? <Spinner className="size-4" /> : <RotateCwIcon />}{problem === 'error' ? 'Try again' : 'Check again'}
      </Button>
      {/* Always takes its line, so nothing shifts when the message appears. */}
      <p role="status" className="mt-3 h-5 text-ui text-muted-foreground">
        {still === problem && <span className="enter-fade">{problem === 'missing' ? 'Still can’t find Claude Code.' : problem === 'login' ? 'Still not signed in.' : 'Still couldn’t start.'}</span>}
      </p>
    </Centered>
  );
}

/** The first launch with no project yet. */
export function WelcomeScreen({ onPick }: { onPick: () => void }) {
  return (
    <Centered>
      <Logo className="mx-auto mb-6 size-12 text-brand" />
      <h1 className="mb-2 text-display">Welcome to Canopy</h1>
      <p className="mb-8 text-ui text-muted-foreground">Canopy runs the Claude Code and Codex you already have. Choose a project to begin.</p>
      <Button className="w-full" size="lg" onClick={onPick}><FolderOpenIcon />Choose a project folder…</Button>
      <p className="mt-4 text-micro text-faint">Not affiliated with Anthropic or OpenAI.</p>
    </Centered>
  );
}

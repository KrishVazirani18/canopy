// If the UI ever crashes while drawing, show a calm screen instead of a blank window, and try again on its own:
// a crash is almost always a build caught half-way (dev) or one bad message, and a reload clears both.
// Your chats are safe either way: they live in Claude Code, not in this window.
import { Component, type ReactNode } from 'react';
import { Logo } from './logo';

const KEY = 'canopy.crash.reload';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error) {
    console.error('[canopy] UI crashed:', error);
    // Retry once on its own; if it crashes again right away, wait for the person instead of looping.
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last > 15_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      this.timer = setTimeout(() => location.reload(), 2500);
    }
  }

  componentWillUnmount() { clearTimeout(this.timer); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background px-10 text-center [-webkit-app-region:drag]">
        <Logo className="breathe size-10 text-brand" />
        <div>
          <div className="text-ui font-medium">Canopy hit a snag drawing this screen</div>
          <div className="mt-1 text-small text-muted-foreground">Your chats are safe. Reloading…</div>
        </div>
        <button onClick={() => location.reload()} className="h-8 rounded-lg border border-hairline px-3 text-small hover:bg-accent [-webkit-app-region:no-drag]">Reload now</button>
        <code data-selectable className="max-w-xl truncate font-mono text-micro text-faint">{String(this.state.error.message || this.state.error)}</code>
      </div>
    );
  }
}

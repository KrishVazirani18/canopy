// Run in the chat: a command in one of Claude's replies is drawn as a command block, a terminal line with a Run
// button. Clicking it runs the command in a real terminal (src/run-ipc.mjs) in the chat's folder, opened in the same
// card under the command, where you can type if it asks something. When it ends by itself, what it printed goes to Claude (lib/runs.ts).
import { createContext, useEffect, useRef, useState } from 'react';
import { useIsCodeFenceIncomplete } from 'streamdown';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { CheckIcon, CopyIcon, PlayIcon, SquareIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';
import { canRun, runKey, resizeRun, startRun, stopRun, typeInto, useRun, watchOutput } from '@/lib/runs';
import { termTheme } from './terminal-view';

/** Shell blocks have Run only where a chat's replies are drawn (not in a preview, not in a handoff line). */
export const RunnableReplies = createContext(false);
export const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh']);

const ROWS = 10;

/** A command block: the command as a terminal line ("$ …"), with Copy and a Run button in the block itself. Run opens
 *  a terminal under the command, in the same card. `command` is what runs (a plain block's "$ " prompts taken off). */
export function RunnableCode({ command }: { code?: string; command: string; language?: string; startLine?: number }) {
  const store = useStore();
  const incomplete = useIsCodeFenceIncomplete();
  const key = runKey(store, command);
  const run = useRun(key);
  const running = run?.status === 'running';
  // The terminal shows once you have run it here, and stays (with what it printed) until you hide it.
  const [open, setOpen] = useState(!!run);
  const [nonce, setNonce] = useState(0); // each click on Run
  const runnable = canRun() && !incomplete && !!command.trim();
  return (
    <div data-run-block className="my-4 overflow-hidden rounded-xl border border-hairline bg-[var(--code-bg)]">
      <div className="flex items-start gap-3 py-2 pr-2 pl-4">
        <CommandLines command={command} />
        <div className="flex shrink-0 items-center gap-1">
          <CopyCommand text={command} />
          {runnable && (
            <button type="button" data-run-button aria-label={running ? 'Stop' : 'Run in Canopy'}
              onClick={() => { if (running) stopRun(key); else { setOpen(true); setNonce((n) => n + 1); } }}
              className="flex h-7 w-[92px] shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 text-small font-medium whitespace-nowrap hover:bg-accent">
              {running ? <SquareIcon aria-hidden className="size-2.5 fill-current" /> : <PlayIcon aria-hidden className="size-3.5" />}
              {running ? 'Stop' : run ? 'Run again' : 'Run'}
            </button>
          )}
        </div>
      </div>
      {open && <RunPanel runKey={key} code={command} nonce={nonce} onHide={() => setOpen(false)} />}
    </div>
  );
}

/** The command as you would see it typed at a prompt: "$ " before each command, a continued line indented under it,
 *  a comment faint. Wraps rather than scrolls sideways. */
function CommandLines({ command }: { command: string }) {
  let continued = false;
  const lines = command.split('\n').map((line, i) => {
    const part = continued;
    continued = /\\\s*$/.test(line);
    const comment = !part && line.trim().startsWith('#');
    return (
      <div key={i} className="flex min-w-0">
        <span aria-hidden className="w-[2ch] shrink-0 select-none text-faint">{part || comment || !line.trim() ? '' : '$'}</span>
        <span className={cn('min-w-0 break-words whitespace-pre-wrap', comment && 'text-faint')}>{line || '\u200b'}</span>
      </div>
    );
  });
  return <div className="min-w-0 flex-1 py-1 font-mono text-[13px] leading-[1.55] text-foreground">{lines}</div>;
}

function CopyCommand({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1200); return () => clearTimeout(t); }, [done]);
  return (
    <button type="button" aria-label="Copy command" title="Copy" onClick={() => { void navigator.clipboard.writeText(text); setDone(true); }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
      {done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

function RunPanel({ runKey: key, code, nonce, onHide }: { runKey: string; code: string; nonce: number; onHide: () => void }) {
  const store = useStore();
  const run = useRun(key);
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const started = useRef(0); // the last click on Run this panel has acted on

  // The terminal: made once for the panel, fed what the run printed so far and everything after.
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      try { await document.fonts.load('12px "Geist Mono"'); } catch { /* the system mono */ }
      const el = host.current;
      if (cancelled || !el) return;
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-meta').trim() || '"SF Mono", Menlo, monospace';
      const term = new Terminal({ fontFamily, fontSize: 12, lineHeight: 1.15, rows: ROWS, cursorBlink: true, minimumContrastRatio: 4.5, theme: termTheme(el), scrollback: 2000 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      const fitCols = () => { try { const d = fit.proposeDimensions(); if (d?.cols) term.resize(d.cols, ROWS); } catch { /* not laid out yet */ } };
      fitCols();
      termRef.current = { term, fit };
      const mo = new MutationObserver(() => { term.options.theme = termTheme(el); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      const ro = new ResizeObserver(fitCols);
      ro.observe(el);
      term.onData((d) => typeInto(key, d));
      term.onResize(({ cols, rows }) => resizeRun(key, cols, rows));
      const watch = watchOutput(key, (d) => term.write(d));
      if (watch.sofar) term.write(watch.sofar);
      cleanup = () => { watch.stop(); ro.disconnect(); mo.disconnect(); term.dispose(); termRef.current = null; };
      start();
    })();
    return () => { cancelled = true; cleanup(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A click on Run: a fresh screen, and the command again.
  function start() {
    const t = termRef.current;
    if (!t || nonce === started.current) return;
    started.current = nonce;
    t.term.reset();
    void startRun(store, code, { cols: t.term.cols, rows: t.term.rows }).then(() => t.term.focus());
  }
  useEffect(start, [nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ended: nothing to type into, so no cursor. A run started again brings it back.
  const live = run?.status === 'running';
  useEffect(() => {
    const t = termRef.current?.term;
    if (!t) return;
    t.options.disableStdin = !live;
    t.options.cursorBlink = live;
    t.write(live ? '\x1b[?25h' : '\x1b[?25l');
  }, [live, run?.id]);

  const folder = store.cwd?.split('/').pop() ?? '';
  const status = !run ? '' : run.status === 'running' ? `Running${folder ? ` in ${folder}` : ''}`
    : run.status === 'error' ? run.error ?? 'It could not start.'
    : run.status === 'stopped' ? 'Stopped'
    : run.exitCode === 0 ? 'Done · sent to Claude'
    : run.exitCode === null ? 'Ended · sent to Claude' : `Exited with code ${run.exitCode} · sent to Claude`;
  return (
    <div className="border-t border-hairline bg-[var(--code-bg)]">
      {/* The padding is on the frame: FitAddon counts the host's own box as room. */}
      <div className="bg-inherit px-3 pt-2.5 pb-1"><div ref={host} className="w-full bg-inherit" /></div>
      <div className="flex h-8 items-center gap-2 border-t border-hairline px-3 text-small text-faint">
        <span className="min-w-0 truncate">{status}</span>
        {run?.status !== 'running' && (
          <button type="button" onClick={onHide} className="ml-auto shrink-0 rounded-sm text-muted-foreground hover:text-foreground">Hide</button>
        )}
      </div>
    </div>
  );
}

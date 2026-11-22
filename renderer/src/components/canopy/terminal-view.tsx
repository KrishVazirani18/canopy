// Terminal tab: the real Claude Code interface for the same session.
// Starting it pauses Canopy's own connection (one driver per session at a time).
import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { SquareTerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { store, useStore } from '@/lib/store';
import { ui, useUi } from '@/lib/ui';

// Per mode: the selection, and the 16 ANSI colours in standard hues, tuned to stay readable on --code-bg
// (darker on light, lighter on dark). Black on dark stays near the background, as programs expect.
const LIGHT: ITheme = {
  selectionBackground: '#e2ddd2',
  black: '#24221f', red: '#b3261e', green: '#17732f', yellow: '#855a00', blue: '#0a5cc9', magenta: '#8238c8', cyan: '#0d6c77', white: '#625d56',
  brightBlack: '#4a4640', brightRed: '#c63328', brightGreen: '#197b35', brightYellow: '#916200', brightBlue: '#1166de', brightMagenta: '#9240dc', brightCyan: '#0f7884', brightWhite: '#6f6a62',
};
const DARK: ITheme = {
  selectionBackground: '#3a3732',
  black: '#2a2825', red: '#f47067', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#cdc9c1',
  brightBlack: '#8b867d', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f7f4ee',
};

// The tokens are oklch and xterm wants #rrggbb: paint the colour onto one pixel and read it back.
let pixel: CanvasRenderingContext2D | null | undefined;
function toHex(color: string): string {
  if (pixel === undefined) {
    pixel = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    if (pixel) pixel.globalCompositeOperation = 'copy';
  }
  if (!pixel) return color;
  pixel.fillStyle = color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// Background and ink are read from the live tokens on the host (--code-bg and the text colour),
// so the terminal is exactly the colour of its frame and reads as part of the panel.
export function termTheme(host: HTMLElement): ITheme {
  const style = getComputedStyle(host);
  const background = toHex(style.backgroundColor);
  const foreground = toHex(style.color);
  return {
    ...(document.documentElement.classList.contains('dark') ? DARK : LIGHT),
    background, foreground, cursor: foreground, cursorAccent: background,
    // Canopy's scrollbar thumb: the ink at 16%, 30% under the pointer.
    scrollbarSliderBackground: `${foreground}29`, scrollbarSliderHoverBackground: `${foreground}4d`, scrollbarSliderActiveBackground: `${foreground}4d`,
  };
}

function Live({ onDone }: { onDone: (sessionId: string | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      // xterm measures its cell size once at open: the face must be loaded first or the grid is wrong.
      try { await document.fonts.load('12px "Geist Mono"'); } catch { /* fall back to the system mono */ }
      const el = host.current;
      if (cancelled || !el) return;
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-meta').trim() || '"SF Mono", Menlo, monospace';
      // lineHeight stays 1: taller rows leave gaps between box-drawing characters, so Claude Code's borders turn dashed.
      // The contrast floor lifts any colour that would vanish on this background, truecolor included.
      const term = new Terminal({ fontFamily, fontSize: 12, lineHeight: 1, cursorBlink: true, minimumContrastRatio: 4.5, theme: termTheme(el) });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      // Fit before Claude Code starts, so it opens at the real size rather than at 80x24 with a resize a moment later.
      try { fit.fit(); } catch { /* ignore */ }
      // Follow light/dark while open.
      const mo = new MutationObserver(() => { term.options.theme = termTheme(el); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      // A slash command routed here (e.g. /config) is typed into Claude Code once its UI has settled:
      // ready = output has gone quiet for 600ms. Later commands are typed immediately.
      let ready = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        const cmd = ui.get().terminalCommand;
        if (!ready || !cmd) return;
        ui.set({ terminalCommand: null });
        api.term.input(cmd);
        setTimeout(() => api.term.input('\r'), 80);
      };
      const offUi = ui.subscribe(flush);
      const offData = api.term.onData((d) => {
        term.write(d);
        if (!ready) { clearTimeout(idle); idle = setTimeout(() => { ready = true; flush(); }, 600); }
      });
      const offExit = api.term.onExit(() => term.write('\r\n\x1b[2m[Claude Code closed]\x1b[0m\r\n'));
      term.onData((d) => api.term.input(d));
      term.onResize(({ cols, rows }) => api.term.resize(cols, rows));
      const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* ignore */ } });
      ro.observe(el);
      api.term.open(term.cols, term.rows).then((r) => {
        if (cancelled) return;
        if (r?.error) term.write(r.error);
        sessionRef.current = r?.sessionId ?? null;
        term.focus();
      });
      cleanup = () => { clearTimeout(idle); offUi(); offData(); offExit(); ro.disconnect(); mo.disconnect(); term.dispose(); };
    })();
    // Closing the view also stops the terminal's Claude Code, so it never runs alongside Canopy's own.
    return () => { cancelled = true; cleanup(); api.term.close(); };
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The padding lives on the frame: FitAddon sizes the grid to the host's box and would count padding as room. */}
      <div className="min-h-0 flex-1 bg-[var(--code-bg)] p-2">
        <div ref={host} className="size-full bg-inherit" />
      </div>
      <div className="flex h-11 shrink-0 items-center justify-between border-t px-3 text-small">
        <span className="text-muted-foreground">This chat, in Claude Code</span>
        <Button size="sm" onClick={async () => { await api.term.close(); ui.set({ terminalLive: false }); onDone(sessionRef.current); }}>
          Back to Canopy
        </Button>
      </div>
    </div>
  );
}

export function TerminalPane({ onDone }: { onDone: (sessionId: string | null) => void }) {
  const { terminalLive } = useUi();
  const { meta } = useStore();
  const [confirming, setConfirming] = useState(false);
  if (terminalLive) return <Live onDone={onDone} />;
  // The warning only stands while Claude is actually still working.
  const warn = confirming && meta.busy;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <SquareTerminalIcon className="size-4 text-muted-foreground" />
      <div className="max-w-64 space-y-1">
        <p className="text-ui">Continue this chat in Claude Code.</p>
        <p className="text-small text-balance text-muted-foreground">For commands like /config and /mcp. Canopy pauses until you come back.</p>
      </div>
      {warn ? (
        <div className="mt-1 flex flex-col items-center gap-2">
          <p className="text-small text-warn">Canopy is still working.</p>
          <Button size="sm" variant="outline" onClick={() => ui.set({ terminalLive: true })}>Stop and open</Button>
        </div>
      ) : (
        <Button size="sm" className="mt-1" onClick={() => {
          if (store.meta.busy) { setConfirming(true); return; }
          ui.set({ terminalLive: true });
        }}>
          Open in Terminal
        </Button>
      )}
    </div>
  );
}

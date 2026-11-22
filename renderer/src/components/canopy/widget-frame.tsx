// The host for UI inside a reply: one sandboxed iframe, spoken to in MCP Apps' own messages (SEP-1865: JSON-RPC 2.0
// over postMessage). What runs inside is an MCP App. For Claude's widgets that is Canopy's own page
// (renderer/src/frame, loaded from lib/widget-doc.ts), which draws the fragment Claude wrote as its tool input.
// This file never looks inside the frame. It only:
//   - answers ui/initialize with Canopy's look, and says again when the theme changes
//   - sends the tool's input as it is written (tool-input-partial), then whole (tool-input)
//   - takes the frame's height, so the reply makes exactly that much room (and remembers it for next time)
//   - takes what leaves the frame and decides: an answer becomes the user's next message, a link goes through
//     Canopy's link confirm, anything else is refused
// The frame is sandbox="allow-scripts" and nothing more: no origin, no network, no navigation, no popups, no forms.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, Code2Icon, CopyIcon } from 'lucide-react';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { widgetShown, widgetUsed } from '@/lib/telemetry';
import { hostVariables, isDark, widgetDocument } from '@/lib/widget-doc';
import { widgetMemory } from '@/lib/widget-state';
import { cn } from '@/lib/utils';
import { api, type ImageAttachment } from '@/lib/api';
import { LinkConfirm, opensTrusted } from './link-confirm';
import { readAnswer } from './widget-message';

/** A screenshot the `look` tool took in a chat, as main hands it over (api.widgetShot, being added to lib/api.ts). */
type Shot = { data: string; width: number; height: number; url?: string | null; elements?: { x: number; y: number; w: number; h: number; tag: string; role?: string | null; text?: string | null; selector?: string | null }[] };
const shots = api as unknown as { widgetShot?: (sessionId: string | null, ref: string) => Promise<Shot | null> };

const PROTOCOL = '2026-01-26';
const MAX_HEIGHT = 1600;       // past this the frame scrolls inside itself
const ANSWER_GAP_MS = 1000;    // a widget answers at most this often
const START_MS = 5000;         // a frame that has not said hello by now is not going to
const EDGE = 2;                // the frame's page pads itself by this much so focus rings are not clipped (frame/page.css)

type Rpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };

/** Canopy's look right now, as the host context an MCP App is given. */
function hostContext() {
  return {
    theme: isDark() ? 'dark' : 'light', styles: { variables: hostVariables() },
    displayMode: 'inline', availableDisplayModes: ['inline'], containerDimensions: { maxHeight: MAX_HEIGHT },
    locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: 'desktop', userAgent: 'canopy',
    deviceCapabilities: { touch: false, hover: true },
  };
}

/** A number that changes whenever Canopy's look does (light/dark, the style, a token), so frames can be told. */
function useLook() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setN((x) => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-style', 'style'] });
    return () => mo.disconnect();
  }, []);
  return n;
}

/** True once the element has come near the screen. Frames far up a long chat are not loaded until then. */
function useNear(ref: React.RefObject<HTMLElement | null>, eager: boolean) {
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true); }, { rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

export type WidgetFrameProps = {
  /** The tool call's id: what this widget's memory (height, state) is kept under. */
  callId: string;
  title: string;
  /** The widget's HTML as far as it has been written. */
  code: string;
  /** More of it is still arriving. */
  streaming: boolean;
  /** Claude was stopped before it finished writing: what arrived is shown as it is, and its scripts do not run. */
  cut?: boolean;
  /** Drawn as it happens, not from a saved chat. */
  live: boolean;
  /** The widget answered: this becomes the user's next message, with any pictures it carried as attachments. */
  onSend?: (text: string, images: ImageAttachment[]) => void;
  /** The chat this widget is in: the only one whose screenshots it may show. */
  sessionId?: string | null;
  /** The whole widget has been drawn and its scripts have run: what went wrong, if anything. Called once. */
  onDrawn?: (report: { errors: string[] }) => void;
  /** The height to hold before this widget has said its own (it took the place of one that tall). */
  reserve?: number;
  /** Shown whole, never half-written: a skeleton stands in until all of it has arrived and the frame has drawn it. */
  whole?: boolean;
  className?: string;
};

export function WidgetFrame({ callId, title, code, streaming, cut, live, onSend, onDrawn, reserve, whole: holdWhole, sessionId, className }: WidgetFrameProps) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [memory] = useState(() => widgetMemory.get(callId));
  const near = useNear(box, live);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState<number | null>(memory?.h ?? reserve ?? null);
  const [problems, setProblems] = useState<string[]>([]);
  const [dead, setDead] = useState(false);
  const [source, setSource] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const look = useLook();
  const send = useRef(onSend);
  send.current = onSend;
  const drawn = useRef(onDrawn);
  drawn.current = onDrawn;
  const lastAnswer = useRef(0);
  const chat = useRef(sessionId ?? null);
  chat.current = sessionId ?? null;
  const latest = useRef(code); // the whole widget, for the listener below (its kind is read off it when it is counted)
  latest.current = code;

  // Built once: the look it starts with is in the page, later changes go by message, so a theme switch never
  // reloads a widget and loses what the user did in it.
  const doc = useMemo(() => (near ? widgetDocument() : ''), [near]);

  const post = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', ...msg }, '*');

  useEffect(() => {
    if (!near) return;
    const reply = (id: Rpc['id'], result: Record<string, unknown>) => post({ id, result });
    const refuse = (id: Rpc['id'], message: string, codeN = -32000) => post({ id, error: { code: codeN, message } });
    const on = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as Rpc | null;
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
      const p = m.params ?? {};
      switch (m.method) {
        case 'ui/initialize':
          reply(m.id, {
            protocolVersion: PROTOCOL, hostInfo: { name: 'canopy', version: '1' },
            hostCapabilities: { openLinks: {}, logging: {} }, hostContext: hostContext(),
            // Canopy's own page also gets back what this widget remembered. A third-party app never sees this key.
            _meta: { 'canopy/widget': { state: widgetMemory.get(callId)?.s ?? null, restored: !live } },
          });
          break;
        case 'ui/notifications/initialized': setReady(true); break;
        case 'ui/notifications/size-changed': {
          const h = Math.max(0, Math.min(MAX_HEIGHT, Math.ceil(Number(p.height) || 0)));
          setHeight(h);
          if (h > 0) widgetMemory.set(callId, { h });
          break;
        }
        case 'ui/message': {
          // Words, and the pictures a widget made (notes drawn on a screenshot): both checked here, see widget-message.ts.
          const answer = readAnswer(p);
          const now = Date.now();
          if ('error' in answer) { refuse(m.id, answer.error); break; }
          if (!send.current || now - lastAnswer.current < ANSWER_GAP_MS) { refuse(m.id, 'Message sending denied'); break; }
          lastAnswer.current = now;
          widgetUsed(callId, latest.current);
          send.current(answer.text, answer.images);
          reply(m.id, {});
          break;
        }
        case 'canopy/shot': {
          // A screenshot `look` took in this chat, by its ref. Only this chat's: main looks it up under this chat's id.
          const ref = typeof p.ref === 'string' ? p.ref.trim() : '';
          if (!/^[\w.-]{1,64}$/.test(ref) || !shots.widgetShot) { refuse(m.id, 'Screenshot not available'); break; }
          const id = m.id;
          shots.widgetShot(chat.current, ref).then(
            (s) => { if (s && typeof s.data === 'string' && s.width > 0 && s.height > 0) reply(id, s as unknown as Record<string, unknown>); else refuse(id, 'Screenshot not available'); },
            () => refuse(id, 'Screenshot not available'),
          );
          break;
        }
        case 'ui/open-link': {
          const url = typeof p.url === 'string' ? p.url : '';
          let ok = false;
          try { ok = ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol); } catch { /* not a URL */ }
          if (!ok) { refuse(m.id, 'Invalid URL'); break; }
          widgetUsed(callId, latest.current);
          if (opensTrusted(url)) window.open(url, '_blank'); else setLink(url);
          reply(m.id, {});
          break;
        }
        case 'canopy/state':
          if (p.state && typeof p.state === 'object') widgetMemory.set(callId, { s: p.state });
          // The frame says whether you had touched it: state it saves by itself (a script's own, a saved widget's
          // controls put back) is not use.
          if (p.touched === true) widgetUsed(callId, latest.current);
          break;
        case 'canopy/drawn': {
          const errors = Array.isArray(p.errors) ? p.errors.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
          if (live) widgetShown(callId, latest.current); // drawn as Claude wrote it, not put back from a saved chat
          drawn.current?.({ errors });
          drawn.current = undefined;
          break;
        }
        case 'notifications/message':
          if (p.level === 'error' && typeof p.data === 'string') setProblems((list) => (list.includes(p.data as string) || list.length >= 5 ? list : [...list, p.data as string]));
          break;
        case 'ping': reply(m.id, {}); break;
        default: if (m.id !== undefined) refuse(m.id, `Method not found: ${m.method}`, -32601);
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [near, callId, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // The input, as far as it has got. Once whole it is sent as the final input exactly once.
  const sentWhole = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const args = { title, widget_code: code };
    if (streaming && holdWhole) return; // nothing is drawn until it is all here
    if (streaming) post({ method: 'ui/notifications/tool-input-partial', params: { arguments: args } });
    else if (cut) {
      post({ method: 'ui/notifications/tool-input-partial', params: { arguments: args } });
      post({ method: 'ui/notifications/tool-cancelled', params: { reason: 'stopped' } });
    } else if (sentWhole.current !== code) {
      sentWhole.current = code;
      post({ method: 'ui/notifications/tool-input', params: { arguments: args } });
    }
  }, [ready, code, streaming, cut, title, holdWhole]); // eslint-disable-line react-hooks/exhaustive-deps

  // The look changed after the frame loaded.
  const firstLook = useRef(look);
  useEffect(() => {
    if (!ready || look === firstLook.current) return;
    post({ method: 'ui/notifications/host-context-changed', params: { theme: isDark() ? 'dark' : 'light', styles: { variables: hostVariables() } } });
  }, [look, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // A frame that never starts, or a finished widget that draws nothing, is not left as a hole in the reply.
  useEffect(() => {
    if (!near || ready) return;
    const t = setTimeout(() => setDead(true), START_MS);
    return () => clearTimeout(t);
  }, [near, ready]);
  const whole = !streaming && !cut;
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    if (!ready || !whole) return;
    const t = setTimeout(() => setEmpty((height ?? 0) <= EDGE * 2 + 2), 1200);
    return () => clearTimeout(t);
  }, [ready, whole, height]);

  // The frame went away (its turn scrolled out of the pages shown): tell it first, as the protocol asks.
  useLayoutEffect(() => () => { post({ id: 'bye', method: 'ui/resource-teardown', params: { reason: 'closed' } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const failed = dead || empty;
  // Held whole: the skeleton stays until the frame has drawn the finished widget and said how tall it is. A widget
  // Claude was stopped in the middle of shows what arrived, as any other does.
  const skeleton = !!holdWhole && !cut && !failed && (streaming || (height ?? 0) <= EDGE * 2 + 2);
  // The space the widget takes before its frame has said how tall it is: what it was last time, or nothing yet
  // for one being written now (it grows as it arrives), or a guess for a saved one never drawn on this Mac.
  const reserved = skeleton ? 0 : height ?? (live ? 0 : 160);
  return (
    <div ref={box} data-widget={callId} className={cn('group/wf relative min-w-0', code && 'mb-7', className)}>
      {skeleton && <WidgetSkeleton />}
      {failed ? (
        <div className="flex h-6 items-center gap-2 text-small text-faint">
          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
          <span className="truncate">Couldn’t draw {title || 'this'}</span>
        </div>
      ) : (
        <iframe ref={frame} title={title || 'Widget'} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={near ? doc : undefined}
          className="block border-0 bg-transparent" tabIndex={0}
          style={{ height: Math.max(reserved, EDGE * 2), width: `calc(100% + ${EDGE * 2}px)`, margin: -EDGE, colorScheme: isDark() ? 'dark' : 'light' }} />
      )}
      {/* The way to see what Claude wrote, like a table's buttons: out of the way until you hover, in a strip of room
          kept under the widget (mb-7 above), so it never sits on the text that follows. */}
      {code && (
        <div className={cn('absolute top-full right-0 z-10 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-120 ease-out group-hover/wf:opacity-100 focus-within:opacity-100',
          (failed || problems.length > 0 || source) && 'opacity-100')}>
          {problems.length > 0 && !failed && <span className="mr-1 text-small text-faint" title={problems.join('\n')}>Part of this didn’t run</span>}
          <SourceButtons code={code} open={source} onToggle={() => setSource(!source)} />
        </div>
      )}
      {source && (
        <div className="mt-7">
          <CodeBlock code={code} language="html" className="text-code [&>div:last-child]:max-h-80" />
        </div>
      )}
      {link && <LinkConfirm isOpen url={link} onClose={() => setLink(null)} onConfirm={() => window.open(link, '_blank')} />}
    </div>
  );
}

/** A card being drawn: a heading, a progress bar and a few step rows, as bars with a shimmer sweeping across them. */
function WidgetSkeleton() {
  const bar = (w: string, h = 'h-2.5') => <div className={cn('skeleton-shimmer rounded-full', h)} style={{ width: w }} />;
  return (
    <div role="status" aria-label="Drawing the update" className="enter-fade space-y-4 rounded-xl border border-hairline p-4">
      <div className="flex items-center justify-between gap-6">
        <div className="flex-1 space-y-2">{bar('38%', 'h-3')}{bar('58%')}</div>
        <div className="w-16 space-y-2">{bar('100%', 'h-3')}{bar('70%')}</div>
      </div>
      {bar('100%', 'h-1.5')}
      <div className="space-y-3 pt-1">
        {['62%', '48%', '55%', '40%'].map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="skeleton-shimmer size-3.5 shrink-0 rounded-full" />
            <div className="flex-1">{bar(w)}</div>
            <div className="w-20">{bar('100%', 'h-1.5')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceButtons({ code, open, onToggle }: { code: string; open: boolean; onToggle: () => void }) {
  const [copied, setCopied] = useState(false);
  const btn = 'flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground';
  return (
    <>
      <button type="button" aria-label={open ? 'Hide source' : 'Show source'} aria-pressed={open} title={open ? 'Hide source' : 'Show source'} onClick={onToggle}
        className={cn(btn, open && 'bg-accent text-foreground')}><Code2Icon className="size-3.5" /></button>
      <button type="button" aria-label="Copy source" title="Copy source" className={btn}
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
        <span key={String(copied)} className="swap-in">{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}</span>
      </button>
    </>
  );
}

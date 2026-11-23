// Approvals: tool permission, Claude's questions, and what a connected tool asks mid-chat (a form, a sign-in link, a
// yes/no), the cards that rise out of the message box. A plan has its own card, in the chat (plan-card.tsx). All of
// them share one Shell.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, ExternalLinkIcon, MessageCircleQuestionIcon, ShieldAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, type Answer } from '@/lib/api';
import { usePane } from '@/lib/pane';
import { useStore } from '@/lib/store';
import type { PermissionItem } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Switch } from './settings/kit';
import { ToolInputView, permTitle, toolSummary } from './tool-details';
import chromeLogo from './assets/chrome.svg';

/** `otherOff`: the question takes one of its choices only (no line to write your own). `secret`: what is typed is
 *  hidden, and never shown again once sent. Both come from an OpenAI chat's questions. */
type Q = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[]; otherOff?: boolean; secret?: boolean };
type Icon = React.ComponentType<{ className?: string }>;

/** The card every approval is drawn in. `said`: the quiet word an answered card shows on the right ("Answered"
 *  unless the card has its own; '' for none). */
export function Shell({ resolved, icon: Icon, title, sub, said = 'Answered', children }: { resolved: boolean; icon: Icon; title: string; sub?: string; said?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-xl border bg-card px-5 py-4', resolved ? 'border-hairline opacity-60 transition-opacity duration-160' : 'border-foreground/25 enter-up [--rise:8px]')}>
      <div className="mb-3 flex min-h-5 items-center gap-2 text-ui font-medium">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{title}</span>
        {resolved && said && <span className="ml-auto text-small font-normal text-faint">{said}</span>}
      </div>
      {sub && <p className="-mt-2 mb-3 text-small text-muted-foreground">{sub}</p>}
      {children}
    </div>
  );
}

const SUBAGENT = 'Requested by a subagent';
const CODE_MODE = 'Asked by a Code Mode script';
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

/** Allow takes focus as the card rises, so Enter approves it. Never from a field with a draft in it:
 *  the keystrokes would be lost, and the next Space or Enter would approve a command nobody read.
 *  preventScroll: the card is mid-rise, and taking focus must not scroll the tray to the button.
 *  The plan card's Build it is the same button with its own word; it sits in the chat, so there it only takes
 *  focus while it is in view (Enter must never build a plan that is scrolled out of sight). */
export function AllowButton({ onClick, children = 'Allow', inView = false }: { onClick: () => void; children?: React.ReactNode; inView?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { focused } = usePane(); // Multi mode: a pane you aren't in never takes the keyboard
  useEffect(() => {
    if (!focused) return;
    const a = document.activeElement;
    const typing = (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) && a.value.trim().length > 0;
    const r = inView ? ref.current?.getBoundingClientRect() : null;
    const seen = !r || (r.bottom > 0 && r.top < window.innerHeight);
    if (!typing && seen) ref.current?.focus({ preventScroll: true });
  }, []);
  return <Button ref={ref} onClick={onClick}>{children}</Button>;
}

/** A long command, edit or file, kept short so Allow and Deny are always in reach: about six lines, long lines
 *  wrapped (no sideways scrolling), the bottom fading out, and "Show full command" to open it all in place. */
export function Clamp({ more, children }: { more: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => { const el = box.current; if (el && !open) setOver(el.scrollHeight > el.clientHeight + 4); }, [children, open]);
  return (
    <div>
      <div ref={box} className={cn('relative [&_div]:!max-h-none [&_div]:!overflow-x-hidden [&_pre]:!whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]',
        open ? 'max-h-[50vh] overflow-y-auto' : 'max-h-[9.5rem] overflow-hidden')}>
        {children}
        {!open && over && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {(over || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 text-small text-muted-foreground hover:text-foreground">{open ? 'Show less' : more}</button>
      )}
    </div>
  );
}
const MORE: Record<string, string> = { Bash: 'Show full command', Edit: 'Show all changes', MultiEdit: 'Show all changes', Write: 'Show the whole file' };

/** One file of a change that touches several (an OpenAI chat's): the row it belongs to and what would happen to it. */
type FileChange = { id?: string; name: string; input: Record<string, unknown> };
/** Every file of a several-file change, or null for any other approval. One Allow covers them all, so all are shown. */
function fileChanges(ev: PermissionItem['ev']): FileChange[] | null {
  if (!Array.isArray(ev.changes) || ev.changes.length < 2) return null;
  const rows = (ev.changes as unknown[]).filter((c): c is FileChange => !!c && typeof (c as FileChange).name === 'string' && typeof (c as FileChange).input === 'object' && (c as FileChange).input !== null);
  return rows.length > 1 ? rows : null;
}

/** The files of one change, each under its own line ("Edit a.ts", "Write b.ts", "Delete .env") with its own diff,
 *  kept short. The list scrolls inside the card, so Allow and Deny stay in reach however many files there are. */
function FileChanges({ changes, total }: { changes: FileChange[]; total: number }) {
  const more = total - changes.length;
  return (
    <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
      {changes.map((c, n) => (
        <div key={c.id ?? n} className="flex min-w-0 flex-col gap-1.5">
          <p className="truncate text-small text-foreground/90" title={typeof c.input.file_path === 'string' ? home(c.input.file_path) : undefined}>{permTitle(c.name, c.input).replace(/\?$/, '')}</p>
          <Clamp more={MORE[c.name] ?? 'Show all'}><ToolInputView name={c.name} input={c.input} /></Clamp>
        </div>
      ))}
      {more > 0 && <p className="text-small text-muted-foreground">And {more} more {more === 1 ? 'file' : 'files'}.</p>}
    </div>
  );
}

export function PermissionCard({ item }: { item: PermissionItem }) {
  const { ev, resolved } = item;
  const store = useStore();
  const respond = (a: Answer) => store.respond(ev.id, a);
  if (ev.type === 'question') return <QuestionCard item={item} respond={respond} />;
  if (ev.type === 'elicitation') return <ElicitationCard item={item} respond={respond} />;
  // Something asking for itself (Computer Use and an app): who wants what, in words, and the same three answers.
  if (ev.plain) {
    const title = typeof ev.title === 'string' && ev.title ? ev.title : permTitle(ev.toolName, (ev.input ?? {}) as Record<string, unknown>);
    const warning = typeof ev.description === 'string' ? ev.description.trim() : '';
    return (
      <Shell resolved={resolved} icon={ShieldAlertIcon} title={title} sub={ev.agentId ? SUBAGENT : undefined}>
        {warning && <p className="text-ui text-foreground/90">{warning}</p>}
        {!resolved && (
          <div className={cn('flex flex-wrap gap-2', warning ? 'mt-4' : 'mt-1')}>
            <AllowButton onClick={() => respond({ action: 'allow' })} />
            {ev.hasSuggestions && <Button variant="outline" onClick={() => respond({ action: 'always' })}>{ev.alwaysForChat ? 'Allow for this chat' : 'Always allow'}</Button>}
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => respond({ action: 'deny' })}>Deny</Button>
          </div>
        )}
      </Shell>
    );
  }

  const input = (ev.input ?? {}) as Record<string, unknown>;
  // A change to several files is one question about all of them, never a card for the first file alone.
  const changes = fileChanges(ev);
  const total = changes ? Math.max(changes.length, Number(ev.changeCount) || 0) : 0;
  return (
    <Shell resolved={resolved} icon={ShieldAlertIcon} title={changes ? `Change ${total} files?` : permTitle(ev.toolName, input)} sub={ev.agentId ? SUBAGENT : ev.codeMode ? CODE_MODE : undefined}>
      <div className="flex flex-col gap-2">
        {/* What it's for, in words, first; then the command itself, kept short. */}
        {ev.toolName === 'Bash' && typeof input.description === 'string' && input.description.trim() && <p className="text-ui text-foreground/90">{input.description}</p>}
        {/* A read or search that is really a shell command (an OpenAI chat's) shows the command being approved. */}
        {changes ? <FileChanges changes={changes} total={total} />
          : ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].includes(ev.toolName) && !input.command
          ? <code className="block truncate font-mono text-code text-muted-foreground">{toolSummary(ev.toolName, input)}</code>
          : <Clamp more={MORE[ev.toolName] ?? 'Show all'}><ToolInputView name={ev.toolName} input={ev.toolName === 'Bash' ? { ...input, description: undefined } : input} /></Clamp>}
        {ev.blockedPath && ev.toolName !== 'Permissions' && <p className="text-small text-muted-foreground">Outside this project: <code className="font-mono">{home(String(ev.blockedPath))}</code></p>}
      </div>
      {!resolved && (
        <div className="mt-4 flex flex-wrap gap-2">
          <AllowButton onClick={() => respond({ action: 'allow' })} />
          {/* A Code Mode script's call: Claude Code keeps no rule for these, so Canopy remembers it for this chat only.
              So is a tool an OpenAI chat can only remember for the chat (`alwaysForChat`), one of Canopy's own among them. */}
          {ev.hasSuggestions && <Button variant="outline" title={Array.isArray(ev.alwaysPrefix) && ev.alwaysPrefix.length ? `Commands that start with ${ev.alwaysPrefix.join(' ')}` : undefined}
            onClick={() => respond({ action: 'always' })}>{ev.codeMode || ev.alwaysForChat ? 'Allow for this chat' : 'Always allow'}</Button>}
          <Button variant="ghost" className="text-destructive hover:text-destructive" title={ev.denyStops ? 'Stops this turn' : undefined} onClick={() => respond({ action: 'deny' })}>Deny</Button>
        </div>
      )}
    </Shell>
  );
}

/** Claude's questions, one at a time like Claude asks them: the question, its choices as full-width rows (text wraps,
 *  nothing runs off the edge), and a line to write your own. Picking a choice moves on to the next question; Back
 *  goes back. Every question sits in the same spot of one grid cell, so the card is as tall as the tallest one and
 *  never changes size while you step through. Answered, it folds down to what you chose. */
export function QuestionCard({ item, respond }: { item: PermissionItem; respond: (a: Answer) => void }) {
  const qs = (Array.isArray(item.ev.input?.questions) ? item.ev.input.questions : []) as Q[];
  const [at, setAt] = useState(0);
  const [values, setValues] = useState(() => qs.map(() => ({ picked: [] as string[], text: '' })));
  const answerOf = (i: number) => [...values[i].picked, values[i].text.trim()].filter(Boolean).join(', ');
  const last = at === qs.length - 1;
  const ready = qs.every((_, i) => answerOf(i));
  const submit = () => {
    if (!ready) return;
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => { answers[q.question] = answerOf(i); });
    respond({ action: 'answers', answers });
  };
  const next = () => { if (!answerOf(at)) return; if (last) submit(); else setAt(at + 1); };
  const set = (i: number, patch: Partial<{ picked: string[]; text: string }>) => setValues((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const pick = (i: number, label: string) => {
    const q = qs[i];
    if (q.multiSelect) {
      setValues((vs) => vs.map((v, j) => (j !== i ? v : { ...v, picked: v.picked.includes(label) ? v.picked.filter((x) => x !== label) : [...v.picked, label] })));
      return;
    }
    set(i, { picked: [label], text: '' });
    if (i < qs.length - 1) setTimeout(() => setAt(i + 1), 160); // a single choice answers it: on to the next one
  };
  const sub = item.ev.agentId ? SUBAGENT : undefined;

  if (item.resolved) {
    return (
      <Shell resolved icon={MessageCircleQuestionIcon} title={qs.length > 1 ? `${qs.length} questions` : 'Question'} sub={sub}>
        <div className="flex flex-col gap-2">
          {qs.map((q, i) => (
            <div key={i} className="min-w-0 text-ui">
              <div className="text-muted-foreground">{q.question}</div>
              {answerOf(i) && <div className="text-foreground">{q.secret ? 'Answered' : answerOf(i)}</div>}
            </div>
          ))}
        </div>
      </Shell>
    );
  }

  return (
    <Shell resolved={false} icon={MessageCircleQuestionIcon} title={qs.length > 1 ? `Question ${at + 1} of ${qs.length}` : 'Canopy has a question'} sub={sub}>
      <div className="grid">
        {qs.map((q, i) => (
          <div key={i} inert={i !== at} aria-hidden={i !== at}
            className={cn('col-start-1 row-start-1 flex min-w-0 flex-col gap-3 transition-[opacity,translate] duration-200 ease-out',
              i === at ? 'opacity-100' : cn('pointer-events-none opacity-0', i < at ? '-translate-x-3' : 'translate-x-3'))}>
            <p className="text-ui font-medium">{q.question}{q.multiSelect && <span className="font-normal text-muted-foreground"> Pick any.</span>}</p>
            <div role={q.multiSelect ? 'group' : 'radiogroup'} className="flex flex-col gap-1.5">
              {(q.options ?? []).map((o) => {
                const on = values[i].picked.includes(o.label);
                return (
                  <button key={o.label} type="button" role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => pick(i, o.label)}
                    className={cn('flex w-full min-w-0 items-start gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors',
                      on ? 'border-foreground/40 bg-accent' : 'border-hairline hover:border-foreground/20 hover:bg-accent/50')}>
                    <span aria-hidden className={cn('mt-[3px] flex size-3.5 shrink-0 items-center justify-center border transition-colors',
                      q.multiSelect ? 'rounded-[4px]' : 'rounded-full', on ? 'border-foreground bg-foreground' : 'border-foreground/30')}>
                      {on && (q.multiSelect ? <CheckIcon className="size-2.5 text-background" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-background" />)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-ui text-foreground">{o.label}</span>
                      {o.description && <span className="text-small text-muted-foreground">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              {/* A question that takes only its choices has no line; with no choices at all there would be no way to answer, so it keeps one. */}
              {!(q.otherOff && (q.options ?? []).length > 0) && (
                <input value={values[i].text} type={q.secret ? 'password' : 'text'} autoComplete="off"
                  placeholder={(q.options ?? []).length ? 'Or write your own answer' : 'Write your answer'}
                  onChange={(e) => set(i, q.multiSelect ? { text: e.target.value } : { text: e.target.value, picked: [] })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } }}
                  className="h-10 w-full min-w-0 rounded-lg border border-hairline bg-transparent px-3.5 text-ui outline-none placeholder:text-faint focus:border-foreground/40" />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        {qs.length > 1 && at > 0 && <Button variant="ghost" onClick={() => setAt(at - 1)}>Back</Button>}
        <Button variant="ghost" className="text-muted-foreground" onClick={() => respond({ action: 'deny', message: 'The user skipped the question.' })}>Skip</Button>
        <Button className="ml-auto" disabled={last ? !ready : !answerOf(at)} onClick={next}>{last ? (qs.length > 1 ? 'Send answers' : 'Send answer') : 'Next'}</Button>
      </div>
    </Shell>
  );
}

/** One field of a form a connected tool sent (src/core/elicitation.mjs makes them from the tool's schema). */
type Field = {
  key: string; label: string; help?: string | null; required?: boolean; kind: 'text' | 'number' | 'boolean' | 'choice' | 'choices';
  default?: unknown; options?: { value: string; label: string }[]; format?: string | null; integer?: boolean;
  min?: number | null; max?: number | null; minLength?: number | null; maxLength?: number | null;
};
type Value = string | boolean | string[];
const INPUT = 'h-10 w-full min-w-0 rounded-lg border border-hairline bg-transparent px-3.5 text-ui outline-none placeholder:text-faint focus:border-foreground/40';
const INPUT_TYPE: Record<string, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };
const startOf = (f: Field): Value => f.kind === 'boolean' ? f.default === true : f.kind === 'choices' ? (Array.isArray(f.default) ? (f.default as string[]) : [])
  : f.default === null || f.default === undefined ? '' : String(f.default);
/** Is this field filled in the way the tool asked? An optional one may be left empty. */
function fieldOk(f: Field, v: Value): boolean {
  if (f.kind === 'boolean') return true;
  if (f.kind === 'choices') return !f.required || (v as string[]).length > 0;
  const t = String(v).trim();
  if (!t) return !f.required;
  if (f.kind === 'number') {
    const n = Number(t);
    return Number.isFinite(n) && (!f.integer || Number.isInteger(n)) && (f.min == null || n >= f.min) && (f.max == null || n <= f.max);
  }
  if (f.kind === 'text') return (f.minLength == null || t.length >= f.minLength) && (f.maxLength == null || t.length <= f.maxLength);
  return true;
}
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
/** In the browser, never in Canopy's own window: main sends every new window there, and only web links (main.mjs). */
const openLink = (url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); };
/** A choice as a row, the way a question's choices are drawn. */
function ChoiceRow({ on, many, label, onClick }: { on: boolean; many: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role={many ? 'checkbox' : 'radio'} aria-checked={on} onClick={onClick}
      className={cn('flex w-full min-w-0 items-center gap-3 rounded-lg border px-3.5 py-2 text-left transition-colors',
        on ? 'border-foreground/40 bg-accent' : 'border-hairline hover:border-foreground/20 hover:bg-accent/50')}>
      <span aria-hidden className={cn('flex size-3.5 shrink-0 items-center justify-center border transition-colors', many ? 'rounded-[4px]' : 'rounded-full', on ? 'border-foreground bg-foreground' : 'border-foreground/30')}>
        {on && (many ? <CheckIcon className="size-2.5 text-background" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-background" />)}
      </span>
      <span className="min-w-0 text-ui text-foreground">{label}</span>
    </button>
  );
}

/** What a connected tool (an MCP server) asks in the middle of a chat. Three shapes, one card: a form (its fields,
 *  Submit / Cancel), a link to open in the browser (Open link, then Done / Cancel), or a plain yes/no (Allow / Deny).
 *  The title says who is asking; their own words are underneath. Enter in a field submits; Esc stops the turn, which
 *  cancels the card, as it does every other. */
const CHROME_SETUP_ADDRESS = 'chrome://inspect/#remote-debugging';

function ChromeMark({ className }: { className?: string }) {
  return <img src={chromeLogo} alt="" className={className} draggable={false} />;
}

export function ChromeConnectionCard({ setup, resolved = false, respond }: { setup: boolean; resolved?: boolean; respond: (answer: Answer) => void }) {
  const [opening, setOpening] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  const [copied, setCopied] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const connect = async () => {
    if (setup) {
      setOpening(true);
      try {
        const opened = await api.backgroundChrome?.openSettings();
        if (!opened) { setShowAddress(true); return; }
      } catch { setShowAddress(true); return; }
      finally { setOpening(false); }
    }
    respond({ action: 'elicit-accept' });
  };
  return (
    <Shell icon={ChromeMark} title="Connect Chrome" resolved={resolved} said={skipped ? 'Skipped' : 'Setup requested'}>
      {!resolved && <>
        <p className="text-ui text-muted-foreground">Let this chat use the Chrome tabs you already have open.</p>
        <p className="mt-2 text-small text-muted-foreground">{setup ? 'In Chrome, turn on remote debugging and click Allow when asked.' : 'Chrome will ask you to allow access.'}</p>
        {showAddress && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-small text-muted-foreground">
          <span>Paste this address into Chrome.</span>
          <code className="select-all break-all rounded bg-secondary px-1.5 py-0.5">{CHROME_SETUP_ADDRESS}</code>
          <Button size="xs" variant="outline" onClick={() => {
            void navigator.clipboard?.writeText(CHROME_SETUP_ADDRESS).then(() => setCopied(true), () => {});
          }}>{copied ? 'Copied' : 'Copy address'}</Button>
        </div>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={opening} onClick={showAddress ? () => respond({ action: 'elicit-accept' }) : connect}>
            {opening ? 'Opening Chrome…' : showAddress ? 'Continue in Chrome' : 'Connect Chrome'}
          </Button>
          <Button variant="ghost" className="text-muted-foreground" disabled={opening} onClick={() => {
            setSkipped(true);
            respond({ action: 'elicit-decline' });
          }}>Not now</Button>
        </div>
      </>}
    </Shell>
  );
}

/** Dispatches Canopy's Chrome setup card and ordinary MCP questions. */
export function ElicitationCard(props: { item: PermissionItem; respond: (a: Answer) => void }) {
  const { item, respond } = props;
  if (item.ev.ask === 'chrome-setup' || item.ev.ask === 'chrome-allow') {
    return <ChromeConnectionCard setup={item.ev.ask === 'chrome-setup'} resolved={item.resolved} respond={respond} />;
  }
  return <OrdinaryElicitationCard {...props} />;
}

function OrdinaryElicitationCard({ item, respond }: { item: PermissionItem; respond: (a: Answer) => void }) {
  const { ev, resolved } = item;
  const fields = (Array.isArray(ev.fields) ? ev.fields : []) as Field[];
  const ask: string = ev.ask ?? (ev.mode === 'url' ? 'link' : fields.length ? 'form' : 'confirm');
  const [values, setValues] = useState<Record<string, Value>>(() => Object.fromEntries(fields.map((f) => [f.key, startOf(f)])));
  const [tried, setTried] = useState(false); // Submit was pressed with something missing: say which
  const [opened, setOpened] = useState(false);
  const [said, setSaid] = useState('');
  const set = (key: string, v: Value) => setValues((vs) => ({ ...vs, [key]: v }));
  const ready = fields.every((f) => fieldOk(f, values[f.key] ?? ''));
  const answer = (a: Answer, word: string) => { setSaid(word); respond(a); };
  const box = useRef<HTMLDivElement>(null);
  // Something is missing: say which, and bring the first one into view (the fields scroll inside the card).
  const submit = () => {
    if (ready) { answer({ action: 'elicit-accept', content: values }, 'Sent'); return; }
    setTried(true);
    requestAnimationFrame(() => box.current?.querySelector('[data-bad]')?.scrollIntoView({ block: 'nearest' }));
  };
  const title = typeof ev.title === 'string' && ev.title ? ev.title : `${ev.server ?? 'A connected tool'} is asking`;
  const message = typeof ev.message === 'string' ? ev.message.trim() : '';
  const url = typeof ev.url === 'string' ? ev.url : '';
  const icon = ask === 'link' ? ExternalLinkIcon : ask === 'form' ? MessageCircleQuestionIcon : ShieldAlertIcon;

  if (resolved) {
    return (
      <Shell resolved icon={icon} title={title} said={said || 'Answered'} sub={ev.agentId ? SUBAGENT : undefined}>
        {message && <p className="text-ui text-muted-foreground">{message}</p>}
      </Shell>
    );
  }
  return (
    <Shell resolved={false} icon={icon} title={title} sub={ev.agentId ? SUBAGENT : undefined}>
      {message && <p className="whitespace-pre-wrap text-ui text-foreground/90 [overflow-wrap:anywhere]">{message}</p>}
      {ask === 'link' && url && <p className="mt-2 truncate text-small text-muted-foreground" title={url}>Opens {hostOf(url)} in your browser.</p>}
      {ask === 'link' && !url && <p className="mt-2 text-small text-muted-foreground">The link it sent is not a web page, so Canopy will not open it.</p>}
      {ask === 'unsupported' && <p className="mt-2 text-small text-muted-foreground">This check can only be done in the ChatGPT app.</p>}
      {ask === 'form' && (
        <div ref={box} className="mt-3 flex max-h-[30vh] flex-col gap-3.5 overflow-y-auto pr-1">
          {fields.map((f, i) => {
            const v = values[f.key] ?? startOf(f);
            const bad = tried && !fieldOk(f, v);
            const id = `elicit-${ev.id}-${i}`;
            const label = <label htmlFor={f.kind === 'boolean' ? undefined : id} className="text-ui font-medium">{f.label}{!f.required && f.kind !== 'boolean' && <span className="font-normal text-faint"> (optional)</span>}</label>;
            const help = f.help && <p className="text-small text-muted-foreground">{f.help}</p>;
            if (f.kind === 'boolean') {
              return (
                <div key={f.key} className="flex min-w-0 items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-0.5">{label}{help}</div>
                  <Switch label={f.label} on={v === true} onChange={(on) => set(f.key, on)} />
                </div>
              );
            }
            const options = f.options ?? [];
            return (
              <div key={f.key} data-bad={bad || undefined} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-col gap-0.5">{label}{help}</div>
                {f.kind === 'choices' ? (
                  <div role="group" className="flex flex-col gap-1.5">
                    {options.map((o) => { const on = (v as string[]).includes(o.value); return <ChoiceRow key={o.value} many on={on} label={o.label} onClick={() => set(f.key, on ? (v as string[]).filter((x) => x !== o.value) : [...(v as string[]), o.value])} />; })}
                  </div>
                ) : f.kind === 'choice' && options.length <= 3 ? (
                  <div role="radiogroup" className="flex flex-col gap-1.5">
                    {options.map((o) => <ChoiceRow key={o.value} many={false} on={v === o.value} label={o.label} onClick={() => set(f.key, o.value)} />)}
                  </div>
                ) : f.kind === 'choice' ? (
                  <Select value={String(v) || undefined} onValueChange={(x) => set(f.key, x)}>
                    <SelectTrigger id={id} className="!h-10 w-full rounded-lg border-hairline bg-transparent px-3.5 text-ui shadow-none dark:bg-transparent dark:hover:bg-transparent"><SelectValue placeholder="Choose one" /></SelectTrigger>
                    <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                  </Select>
                ) : (
                  <input id={id} value={String(v)} autoComplete="off" spellCheck={false}
                    type={f.kind === 'number' ? 'number' : INPUT_TYPE[f.format ?? ''] ?? 'text'} inputMode={f.kind === 'number' ? (f.integer ? 'numeric' : 'decimal') : undefined}
                    min={f.min ?? undefined} max={f.max ?? undefined} step={f.kind === 'number' && !f.integer ? 'any' : undefined} maxLength={f.maxLength ?? undefined}
                    onChange={(e) => set(f.key, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                    className={cn(INPUT, bad && 'border-destructive/60')} />
                )}
                {bad && <p className="text-small text-destructive">{String(v).trim() || f.kind === 'choices' ? 'Check this one.' : 'This one is needed.'}</p>}
              </div>
            );
          })}
        </div>
      )}
      {ask === 'form' ? (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => answer({ action: 'elicit-cancel' }, 'Cancelled')}>Cancel</Button>
          <Button className="ml-auto" onClick={submit}>Submit</Button>
        </div>
      ) : ask === 'link' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {/* The link opens in the browser; the card stays until you say you are done there. */}
          {url && !opened && <AllowButton onClick={() => { openLink(url); setOpened(true); }}>Open link</AllowButton>}
          {(opened || !url) && <AllowButton onClick={() => answer({ action: 'elicit-accept' }, 'Done')}>Done</AllowButton>}
          {url && opened && <Button variant="outline" onClick={() => openLink(url)}>Open again</Button>}
          <Button variant="ghost" className="text-muted-foreground" onClick={() => answer({ action: 'elicit-cancel' }, 'Cancelled')}>Cancel</Button>
        </div>
      ) : ask === 'unsupported' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => answer({ action: 'elicit-decline' }, 'Dismissed')}>Dismiss</Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <AllowButton onClick={() => answer({ action: 'elicit-accept' }, 'Allowed')} />
          <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => answer({ action: 'elicit-decline' }, 'Denied')}>Deny</Button>
        </div>
      )}
    </Shell>
  );
}

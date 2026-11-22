// Settings → Privacy: the usage stats Canopy shares, and the proof of what they are.
//   Usage stats   the switch (off stops at once, and main sends one last note saying so) and the name sent with them.
//   What's sent   what is counted and what never leaves the Mac, in plain words, and "See what's sent": the last
//                 events exactly as main recorded them to be sent, in a list of their own.
// PrivacyView draws the page from what it is given, so the Playground shows the same page on sample data; Privacy is
// the one wired to main (lib/telemetry.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TelemetryEvent, TelemetryStatus } from '@/lib/api';
import { feature, recentTelemetry, refreshTelemetry, setTelemetryEnabled, setTelemetryName, telemetryAvailable, useTelemetryStatus } from '@/lib/telemetry';
import { eventProps, eventTitle } from '@/lib/telemetry-rules';
import { cn } from '@/lib/utils';
import { Empty, Loading, Page, Refresh, Row, Section, Switch, input, useDrill } from './kit';

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
/** When an event happened: the time today, the day too before that. Null for a time that is not one. */
function when(ts: number | null): { short: string; full: string; iso: string } | null {
  const d = new Date(ts ?? NaN);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = d.toDateString() === new Date().toDateString();
  return { short: today ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`, full: d.toLocaleString(), iso: d.toISOString() };
}

// ---------- the page ----------

export type PrivacyProps = {
  status: TelemetryStatus;
  onEnabled: (on: boolean) => void;
  /** Save the name. What main kept comes back in `status.name`. */
  onName: (name: string) => Promise<void> | void;
  /** The last events recorded to be sent, newest first. */
  recent: () => Promise<TelemetryEvent[]>;
  /** "See what's sent" was opened. */
  onSeen?: () => void;
};

export function PrivacyView({ status, onEnabled, onName, recent, onSeen }: PrivacyProps) {
  const nav = useDrill<'sent'>();
  if (nav.open) return <WhatsSent dir={nav.dir} back={nav.back} recent={recent} />;
  return (
    <Page title="Privacy" dir={nav.dir}>
      <Section title="Usage stats">
        <Row label="Share usage stats" detail={!status.enabled ? 'Off. Nothing is sent.' : status.blocked ? blockedLine(status.blocked) : !status.endpoint ? NOWHERE : 'Turning it off sends one last note saying so'}>
          <Switch label="Share usage stats" on={status.enabled} onChange={onEnabled} />
        </Row>
        <Row label="Name" detail="Optional. Sent with your stats and a random ID for this Mac">
          <NameField name={status.name} onSave={onName} />
        </Row>
      </Section>
      <Section title="What’s sent">
        <Lines label="What’s counted">
          Which parts of Canopy you use, the models and versions you run, how long replies take, and the first line of
          any error. Also how many messages you send in Claude Code and Codex outside Canopy, never what they say.
        </Lines>
        <Lines label="What never leaves this Mac">
          What you write and what Claude or Codex reply, your code and files, and the names of your files, folders,
          projects and chats.
        </Lines>
        <Row label="See what’s sent" detail={status.enabled && status.lastSentAt ? `Last sent ${ago(status.lastSentAt)}` : 'Every event, exactly as it is sent'}
          onClick={() => { onSeen?.(); nav.go('sent'); }} />
      </Section>
    </Page>
  );
}

/** The switch is on, and this copy of Canopy was built with nowhere to send to (a copy built from source). */
const NOWHERE = 'On, but nothing is sent from a copy built from source';

/** The switch is on, and something outside Settings keeps this copy of Canopy from sending anything all the same. */
const blockedLine = (why: string) => (why === 'env' ? 'On, but nothing is sent while CANOPY_TELEMETRY is 0' : 'On, but nothing is sent from this test copy');

/** A row whose words run to a second line (a Row keeps its detail to one). */
function Lines({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5">
      <div className="text-ui">{label}</div>
      <p className="text-small text-muted-foreground">{children}</p>
    </div>
  );
}

/** The name, edited in place: Return or clicking away saves, Esc puts back what was there. */
function NameField({ name, onSave }: { name: string; onSave: (name: string) => Promise<void> | void }) {
  const [draft, setDraft] = useState(name);
  const editing = useRef(false);
  const undo = useRef(false);
  const kept = useRef(name);
  kept.current = name;
  // What main kept (it tidies a name) replaces what was typed as soon as it answers, unless you are typing again.
  const settle = () => { if (!editing.current) setDraft(kept.current); };
  useEffect(settle, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => {
    editing.current = false;
    const next = draft.trim();
    if (undo.current || next === name) { undo.current = false; setDraft(name); return; }
    void Promise.resolve(onSave(next)).then(settle, settle);
  };
  return (
    <input value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={() => { editing.current = true; }} onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        // Esc undoes an edit; with nothing to undo it is left alone, and closes Settings as anywhere else.
        if (e.key === 'Escape' && draft !== name) { e.stopPropagation(); undo.current = true; e.currentTarget.blur(); }
      }}
      maxLength={80} spellCheck={false} autoComplete="off" aria-label="Name" placeholder="Your name" className={cn(input, 'h-8 w-56')} />
  );
}

// ---------- See what's sent ----------

function WhatsSent({ dir, back, recent }: { dir?: 'in' | 'back'; back: () => void; recent: () => Promise<TelemetryEvent[]> }) {
  const [events, setEvents] = useState<TelemetryEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  // Only the newest answer is shown, and none once the page has gone.
  const load = useCallback(() => {
    const mine = ++asked.current;
    setBusy(true);
    recent().catch(() => [] as TelemetryEvent[]).then((list) => { if (asked.current === mine) { setEvents(list); setBusy(false); } });
  }, [recent]);
  useEffect(() => { load(); return () => { asked.current = -1; }; }, [load]);
  return (
    <Page title="What’s sent" dir={dir} back={{ label: 'Privacy', onClick: back }} actions={<Refresh busy={busy && !!events} onClick={load} />}>
      {!events ? <Loading rows={5} />
        : !events.length ? <Empty>Nothing yet. What Canopy sends shows up here.</Empty>
        : (
          <Section title="Recent" count={events.length} footer="Newest first. This list is kept on this Mac.">
            {events.map((e, i) => <EventRow key={`${e.ts ?? ''}:${e.event}:${i}`} e={e} />)}
          </Section>
        )}
    </Page>
  );
}

/** One event: its name in plain words, when, and under it exactly what went with it. */
function EventRow({ e }: { e: TelemetryEvent }) {
  const at = when(e.ts);
  const props = eventProps(e);
  return (
    <div className="flex items-start gap-4 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui">{eventTitle(e)}</div>
        {props.length > 0 && <div data-selectable className="text-small break-words text-muted-foreground">{props.join(' · ')}</div>}
      </div>
      {at && <time dateTime={at.iso} title={at.full} className="shrink-0 text-small leading-5 tabular-nums text-faint">{at.short}</time>}
    </div>
  );
}

// ---------- wired to main ----------

export function Privacy() {
  const status = useTelemetryStatus();
  // The numbers on this page (when stats were last sent) move without main saying so: ask as the page opens.
  const [asked, setAsked] = useState(false);
  useEffect(() => { let here = true; void refreshTelemetry().then(() => { if (here) setAsked(true); }); return () => { here = false; }; }, []);
  if (!status) {
    // A main process from before usage stats (the window reloads with new code, main only on a restart).
    return <Page title="Privacy">{telemetryAvailable() && !asked ? <Loading rows={2} /> : <Empty>Restart Canopy to see this.</Empty>}</Page>;
  }
  return (
    <PrivacyView status={status} onEnabled={(on) => void setTelemetryEnabled(on)} onName={setTelemetryName}
      recent={recentTelemetry} onSeen={() => feature('whats_sent_opened')} />
  );
}

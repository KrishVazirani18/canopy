// Settings → Codex → Computer Use: what Codex needs before it can use this Mac, each row with its one action.
//   Computer Use      is it on in Codex (Codex says), with Turn On through Codex's own config when it is off.
//   Apps              which apps Codex's config lets it use. The apps you said "Always allow" to are kept by
//                     Computer Use itself and can only be changed in the Codex app, so the row opens that.
//   Mac permissions   the privacy permissions its helper app needs, each a row that opens its own pane of System
//                     Settings. macOS does not let one app read another's, so no status is claimed for them.
// The data is main's (src/computer-use.mjs); with a main process from before it, the sections are left out. The
// page asks once (`useComputerUse`) and hands the answer to both the sections and its glance at the top.
import { useEffect, useState } from 'react';
import { AppWindowIcon, CircleDotIcon, LockIcon, MousePointerClickIcon, PersonStandingIcon, WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ComputerUsePane, type ComputerUseStatus } from '@/lib/api';
import { appsLine, computerUseLine, permissionLine } from '@/lib/codex-settings-words';
import { Button, Row, Section, Status, type Tint } from './kit';

/** What the sections show and do. `status` undefined: not asked yet; null: nothing to show. */
export type ComputerUse = {
  status: ComputerUseStatus | null | undefined; turning: boolean;
  turnOn: () => void; pane: (key: ComputerUsePane) => void; codexApp: () => void;
};

/** `ask`: is there a Codex to ask (nothing is read for one that is not installed). */
export function useComputerUse(ask = true): ComputerUse {
  const [status, setStatus] = useState<ComputerUseStatus | null | undefined>(undefined);
  const [turning, setTurning] = useState(false);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    const p = api.computerUse?.status();
    if (!p) { setStatus(null); return; }
    p.then((r) => { if (live) setStatus(r ?? null); }).catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [ask]);
  const turnOn = async () => {
    setTurning(true);
    try {
      const r = await api.computerUse?.turnOn();
      if (r?.status) setStatus(r.status);
      if (!r?.ok) toast('Codex didn’t take the change. Turn Computer Use on in the Codex app.');
    } finally { setTurning(false); }
  };
  const pane = async (key: ComputerUsePane) => { const r = await api.computerUse?.openPane(key); if (r && !r.ok) toast('Couldn’t open System Settings'); };
  const codexApp = async () => { const r = await api.computerUse?.openCodexApp(); if (r && !r.ok) toast('Couldn’t open the Codex app'); };
  return { status, turning, turnOn, pane, codexApp };
}

// A permission's picture, after the one macOS's own settings give it.
const PERMISSION: Record<ComputerUsePane, { icon: React.ReactNode; tint: Tint }> = {
  accessibility: { icon: <PersonStandingIcon />, tint: 'blue' },
  screen: { icon: <CircleDotIcon />, tint: 'red' },
  automation: { icon: <WorkflowIcon />, tint: 'gray' },
};
const OTHER = { icon: <LockIcon />, tint: 'gray' as const }; // one a later main names that this window has no picture for

export function ComputerUseSection({ id, cu }: { id?: string; cu: ComputerUse }) {
  const s = cu.status;
  if (s === null) return null;
  if (s === undefined) return <Section id={id} title="Computer Use"><Row icon={<MousePointerClickIcon />} tint="blue" label="Computer Use" detail="Checking…" /></Section>;
  const lead = { icon: <MousePointerClickIcon />, tint: 'blue' as const, label: 'Computer Use', title: s.version ? `Codex Computer Use ${s.version}` : undefined };
  // Not there yet: Codex installs it from its own app, and there is nothing to allow on this Mac until it has.
  if (s.state === 'missing') return (
    <Section id={id} title="Computer Use">
      <Row {...lead} detail={computerUseLine(s)} onClick={cu.codexApp} opens="outside" action="Open Codex" />
    </Section>
  );
  const apps = appsLine(s.apps);
  return (
    <>
      <Section id={id} title="Computer Use" footer="Codex asks in the chat before it uses an app; “Always allow” there is remembered by Codex.">
        <Row {...lead} detail={s.state === 'on' ? computerUseLine(s) : <Status tone={s.state === 'off' ? 'attention' : 'off'}>{computerUseLine(s)}</Status>}>
          {s.state === 'on' && <Status>On</Status>}
          {s.state === 'off' && <Button onClick={cu.turnOn} busy={cu.turning}>Turn On</Button>}
        </Row>
        <Row icon={<AppWindowIcon />} tint="purple" label="Apps it can use" detail={apps} title={apps} onClick={cu.codexApp} opens="outside" action="Change in Codex" />
      </Section>
      <Section title="Mac permissions" footer="In each list, turn on “Codex Computer Use”; macOS doesn’t let Canopy see whether it is on.">
        {s.permissions.map((p) => (
          <Row key={p.key} {...(PERMISSION[p.key] ?? OTHER)} label={p.label} detail={permissionLine(p)} onClick={() => cu.pane(p.key)} opens="outside" action="Open" />
        ))}
      </Section>
    </>
  );
}

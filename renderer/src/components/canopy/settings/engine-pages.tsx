// Settings → About Canopy, and what the pages about the programs Canopy runs share: a path with the home folder
// folded to "~", a tool's version without its name, and opening a file or folder. (Claude Code's page is
// claude-page.tsx, Codex's is codex-page.tsx.)
import { useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, type EnvInfo } from '@/lib/api';
import { appUpdate, useAppUpdate } from '@/lib/app-update';
import { MOVE_HINT, updateAction, updateLine } from '@/lib/app-update-words';
import { useModels } from '@/lib/engines';
import { feature } from '@/lib/telemetry';
import { useUpkeep } from '@/lib/upkeep';
import { Logo } from '../logo';
import { Button, Identity, Page, Pair, Row, Section, Status, Switch } from './kit';

/** "/Users/you/.claude" → "~/.claude". */
export const tilde = (p: string | null | undefined) => (p ?? '').replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
/** Claude Code's version, bare: "2.5.0". `upkeep`: the one Canopy's upkeep knows, current after an update. */
export const claudeVersion = (env: EnvInfo | null, upkeep: string | null | undefined) => upkeep ?? env?.version?.replace(/\s*\(Claude Code\)$/, '') ?? null;
/** Opens a file or folder; says so when it isn't there. */
export async function open(path: string | undefined, what: string, reveal = false) {
  if (!path) return;
  feature(reveal ? 'reveal_in_finder' : 'file_opened');
  const r = reveal ? await api.reveal(path) as { ok?: boolean; missing?: string } : await api.openPath(path);
  if (r && r.ok === false) toast(r.missing ? `There’s no ${what} yet` : `Couldn’t open ${what}`);
}

// ---------- About ----------

export function About({ env }: { env: EnvInfo | null }) {
  const up = useUpkeep();
  const { codex } = useModels();
  const codexVersion = (codex?.version ?? env?.codexVersion)?.replace(/^codex-cli\s*/, '') ?? null;
  const versions: [string, string][] = [
    ['Canopy', env?.appVersion ?? '—'],
    ['Claude Code', claudeVersion(env, up?.version) ?? '—'],
    ...(codex?.installed !== false && codexVersion ? [['Codex', codexVersion] as [string, string]] : []),
  ];
  // Canopy's own updates (src/core/app-update.mjs). Not there at all in a copy that never updates itself (a run from source).
  const update = useAppUpdate();
  const [checking, setChecking] = useState(false); // Check for Updates was pressed
  const check = async () => { setChecking(true); try { await appUpdate.check(); } finally { setChecking(false); } };
  const line = update ? updateLine(update, checking) : '';
  const next = update ? updateAction(update) : 'check';
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(versions.map(([k, v]) => `${k} ${v}`).join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <Page title="About Canopy">
      <Identity mark={<span className="flex size-11 shrink-0 items-center justify-center"><Logo className="size-10 text-brand" /></span>}
        title={<>Canopy {env?.appVersion && <span className="font-normal text-muted-foreground">{env.appVersion}</span>}</>}
        detail="Runs the Claude Code and Codex you already have"
        actions={<Button onClick={copy}>{copied ? 'Copied' : 'Copy Versions'}</Button>} />
      {update?.supported && (
        <Section title="Updates" footer={!update.canInstall ? MOVE_HINT : update.auto ? 'Canopy downloads updates in the background and installs them when you restart or quit.' : 'Canopy tells you when there is an update and leaves the rest to you.'}>
          <Row icon={<RefreshCwIcon />} tint="green" label="Install updates automatically" title={line}
            detail={update.failed && update.failed === update.available && !update.ready ? <Status tone="attention">{line}</Status> : line}>
            {next === 'restart' ? <Button onClick={() => { feature('update_toast_clicked'); api.restartApp?.(); }}>Restart to Update</Button>
              : next === 'download' ? <Button onClick={() => { void appUpdate.download(); }}>Download</Button>
              : <Button onClick={check} busy={checking || update.state !== 'idle'}>Check for Updates</Button>}
            <Switch label="Install updates automatically" on={update.auto} onChange={(on) => { void appUpdate.setAuto(on); }} />
          </Row>
        </Section>
      )}
      <Section title="Versions" footer="Not affiliated with Anthropic or OpenAI.">
        {versions.map(([k, v]) => <Pair key={k} label={k}><span className="font-mono text-code text-muted-foreground">{v}</span></Pair>)}
      </Section>
      {env?.logFile && (
        <Section>
          <Row label="Canopy’s log" detail="What Canopy did and why, for when something goes wrong" onClick={() => open(env.logFile, 'log', true)} />
        </Section>
      )}
    </Page>
  );
}

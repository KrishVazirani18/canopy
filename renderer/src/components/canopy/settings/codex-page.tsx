// Settings → Codex, laid out like a page of macOS's own settings: what you came for first, one row per thing, each
// led by a small icon on a tile, with its control or what it opens at the right.
//   Identity         Codex, its version, one line that says whether it is ready, and the glances that roll the page
//                    up: Account, Computer Use, Updates. A glance jumps to its section.
//   Accounts         who Codex runs as, which account new chats use, adding one (accounts-section.tsx).
//   Computer Use     is it on, which apps, and the Mac permissions it needs (computer-use-section.tsx).
//   Updates          one row: whether Canopy keeps Codex current, how that stands, Check Now.
//   Advanced         where Codex is installed, its own settings file and folder, and "Not shown yet" folded away.
// `Codex` gathers what main knows and `CodexBody` draws it, so the page can be drawn over sample data. The words that are worked out are in lib/codex-settings-words.ts.
import { useRef, useState } from 'react';
import { DownloadIcon, EyeOffIcon, FolderIcon, RefreshCwIcon, SettingsIcon, SquareTerminalIcon } from 'lucide-react';
import { accountInUse, accountLine, needsAttention, useAccounts } from '@/lib/accounts';
import { api, type CodexInfo, type EnvInfo } from '@/lib/api';
import { accountGlance, codexHeadline, computerUseGlance, updatesGlance, type AccountInUse, type GlanceKey } from '@/lib/codex-settings-words';
import { loadModels, useModels } from '@/lib/engines';
import { OPENAI_SETUP_URL } from '@/lib/models';
import { setting } from '@/lib/telemetry';
import { useUpkeep } from '@/lib/upkeep';
import { driftHint, driftLine, switchOn, upkeepLine, type ToolUpkeep } from '@/lib/upkeep-words';
import { CodexAccounts } from '../accounts-section';
import { MakerLogo, OpenAILogo } from '../maker-logo';
import { ComputerUseSection, useComputerUse, type ComputerUse } from './computer-use-section';
import { open, tilde } from './engine-pages';
import { Button, Glances, Identity, Mark, Page, Refresh, Row, Section, Status, Switch, ToolHead, Value } from './kit';

/** Where a glance jumps to: its section's id. */
export const CODEX_SECTION: Record<GlanceKey, string> = { account: 'codex-accounts', 'computer-use': 'codex-computer-use', updates: 'codex-updates' };

/** Everything the page shows. `codex` null: main has not said yet. `upkeep` null: main has not looked at it yet. */
export type CodexPageData = {
  installed: boolean; codex: Pick<CodexInfo, 'signedIn' | 'version'> | null; version: string | null;
  path: string | null; dir: string | null; account: AccountInUse | null; upkeep: ToolUpkeep | null; computerUse: ComputerUse;
  /** `looking`: Check Again is asking main where Codex is. `updating`: Check Now was pressed. */
  looking: boolean; updating: boolean;
};
export type CodexPageActions = {
  lookAgain: () => void; install: () => void; checkUpdate: () => void; setAuto: (on: boolean) => void;
  openConfig: () => void; openFolder: () => void; clearDrift: () => void;
};

const mark = <Mark icon={<MakerLogo maker="openai" />} size="lg" />;

/** The page under its title. `accounts`: the Accounts section, which keeps its own state. */
export function CodexBody({ data: d, act, accounts, part }: { data: CodexPageData; act: CodexPageActions; accounts: React.ReactNode; part?: 'accounts' | 'advanced' }) {
  const root = useRef<HTMLDivElement>(null);
  const [skipped, setSkipped] = useState(false); // is "Not shown yet" unfolded
  if (!d.installed) return part === 'advanced' ? null : (
    <div className="space-y-7">
      {part ? <ToolHead mark={<OpenAILogo className="text-foreground" />} name="Codex" aside={<Status tone="off">Not installed</Status>} />
        : <Identity mark={mark} title="Codex" detail={<Status tone="off">Not installed</Status>} />}
      <Section footer="Once Codex is installed and signed in, OpenAI’s models appear in the model menu.">
        <Row icon={<DownloadIcon />} tint="blue" label="Install Codex" detail="OpenAI’s guide, in your browser" onClick={act.install} opens="outside" action="Open" />
        <Row icon={<RefreshCwIcon />} tint="gray" label="Already installed?" detail="Canopy looks for Codex again">
          <Button onClick={act.lookAgain} busy={d.looking}>Check Again</Button>
        </Row>
      </Section>
      {/* Nothing to run an account on. One already listed (a key pasted before Codex went) can still be removed. */}
      {accounts}
    </div>
  );

  const up = d.upkeep;
  const account = accountGlance(d.codex, d.account);
  const updates = updatesGlance(up, d.updating);
  const head = codexHeadline(account, updates);
  const jump = (key: GlanceKey) => root.current?.querySelector(`#${CODEX_SECTION[key]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const glances = [account, computerUseGlance(d.computerUse.status), updates].filter((g) => g !== null).map((g) => ({ label: g.label, value: g.value, tone: g.tone, onClick: () => jump(g.key) }));
  const version = (up?.version ?? d.version)?.replace(/^codex-cli\s*/, '') ?? null; // upkeep's is current after an update
  const line = up ? upkeepLine(up, d.updating) : 'Checking…';
  const folder = tilde(d.dir) || '~/.codex';
  const drift = up?.drift ?? [];
  return (
    <div ref={root} className="space-y-7">
      {part === 'accounts' && <ToolHead mark={<OpenAILogo className="text-foreground" />} name="Codex" aside={<><Status tone={head.tone}>{[version, head.text].filter(Boolean).join(' · ')}</Status><Refresh busy={d.looking} onClick={act.lookAgain} /></>} />}
      {!part && <Identity mark={mark} title={<>Codex {version && <span className="font-normal text-muted-foreground">{version}</span>}</>}
        detail={<Status tone={head.tone}>{head.text}</Status>} actions={<Refresh busy={d.looking} onClick={act.lookAgain} />}>
        <Glances items={glances} />
      </Identity>}
      {part !== 'advanced' && accounts}
      {part !== 'advanced' && <ComputerUseSection id={CODEX_SECTION['computer-use']} cu={d.computerUse} />}
      {part !== 'advanced' && <Section id={CODEX_SECTION.updates} title={part ? undefined : 'Updates'} footer={up ? up.blockedBy ?? (part ? undefined : 'Canopy updates Codex in the background, only while no chat is working.') : undefined}>
        <Row icon={<RefreshCwIcon />} tint="green" label="Keep Codex up to date" title={line}
          detail={updates.tone === 'attention' ? <Status tone="attention">{line}</Status> : line}>
          {up && <Button onClick={act.checkUpdate} busy={d.updating || up.doing === 'updating'}>Check Now</Button>}
          {up && <Switch label="Keep Codex up to date" on={switchOn(up)} disabled={!!up.blockedBy} onChange={act.setAuto} />}
        </Row>
      </Section>}
      {part !== 'accounts' && <Section title={part ? 'Codex' : 'Advanced'} footer={part ? undefined : 'Canopy uses your Codex setup as it is: config.toml, MCP servers and AGENTS.md.'}>
        <Row icon={<SquareTerminalIcon />} tint="gray" label="Installed at" detail={d.path ? tilde(d.path) : 'Not known'}>
          {d.path && <Value text={d.path} shown="Copy" mono={false} />}
        </Row>
        <Row icon={<SettingsIcon />} tint="gray" label="Settings file" detail={`${folder}/config.toml`} onClick={act.openConfig} opens="outside" action="Open" />
        <Row icon={<FolderIcon />} tint="blue" label="Codex folder" detail={folder} onClick={act.openFolder} opens="outside" action="Show in Finder" />
        {drift.length > 0 && (
          <Row icon={<EyeOffIcon />} tint="gray" label="Not shown yet" detail={driftLine('Codex', drift.length)} title={driftLine('Codex', drift.length)}
            onClick={() => setSkipped((v) => !v)} opens={skipped ? 'less' : 'more'}>
            {skipped && <button type="button" onClick={act.clearDrift} className="text-small text-muted-foreground hover:text-foreground">Clear</button>}
          </Row>
        )}
        {/* Unfolded: one row for each, its words starting where the rows above start theirs. */}
        {skipped && drift.slice().reverse().map((x) => (
          <Row key={`${x.label}@${x.version}`} lead={<span aria-hidden className="size-8 shrink-0" />} label={x.label} detail={driftHint('Codex', x)} />
        ))}
      </Section>}
    </div>
  );
}

export function Codex({ env, part }: { env: EnvInfo | null; part?: 'accounts' | 'advanced' }) {
  const { codex } = useModels();
  const upkeep = useUpkeep()?.codex ?? null; // Canopy's upkeep of Codex, once main has looked at it
  const using = accountInUse(useAccounts(), 'codex');
  const [updating, setUpdating] = useState(false);
  // Where Codex is, as main found it at launch; Check Again asks main to look again (just installed, or moved).
  const [path, setPath] = useState<string | null>(env?.codexPath ?? null);
  const [looking, setLooking] = useState(false);
  const installed = codex ? codex.installed : !!path;
  const computerUse = useComputerUse(installed);
  const dir = env?.codexDir ?? null;
  const act: CodexPageActions = {
    lookAgain: async () => { setLooking(true); try { const e = await api.recheck(); setPath(e?.codexPath ?? null); loadModels(); } finally { setLooking(false); } },
    install: () => { window.open(OPENAI_SETUP_URL); },
    checkUpdate: async () => { setUpdating(true); try { await api.upkeep?.check('codex'); } finally { setUpdating(false); } },
    setAuto: (on) => { setting('auto_update', on); api.upkeep?.setAuto(on, 'codex'); },
    openConfig: () => { open(dir ? `${dir}/config.toml` : undefined, 'config.toml'); },
    openFolder: () => { open(dir ?? undefined, 'Codex folder', true); },
    clearDrift: () => { api.upkeep?.clearDrift('codex'); },
  };
  return (
    <Page title="Codex">
      <CodexBody part={part} act={act} accounts={<CodexAccounts installed={installed} id={CODEX_SECTION.account} />}
        data={{
          installed, codex: codex ?? null, version: codex?.version ?? env?.codexVersion ?? null, path, dir, upkeep, computerUse, looking, updating,
          account: using ? { label: using.label, problem: needsAttention(using) ? accountLine(using) : null } : null,
        }} />
    </Page>
  );
}

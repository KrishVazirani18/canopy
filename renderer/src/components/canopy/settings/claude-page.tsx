// Settings → Claude Code, laid out like Settings → Codex (codex-page.tsx): what you came for first, one row per thing,
// each led by a small icon on a tile, with its control or what it opens at the right.
//   Identity         Claude Code, its version, one line that says whether it is ready, and the glances that roll the
//                    page up: Account, Updates, and Models when Canopy offers a newer model than Claude Code's own
//                    menu does. A glance jumps to its section.
//   Accounts         who Claude Code runs as, which account new chats use, signing in, adding one
//                    (accounts-section.tsx).
//   Updates          one row: whether Canopy keeps Claude Code current, how that stands, Check Now. Under it, the
//                    models Canopy offers newer than Claude Code's menu.
//   Advanced         where Claude Code is installed, its own settings (/config, in the terminal), its folder, and
//                    "Not shown yet" folded away.
// The words that are worked out are in lib/claude-settings-words.ts. Claude Code's upkeep is src/core/upkeep.mjs
// (through lib/upkeep.ts here).
import { useRef, useState } from 'react';
import { EyeOffIcon, FolderIcon, RefreshCwIcon, SettingsIcon, SquareTerminalIcon } from 'lucide-react';
import { accountInUse, accountLine, needsAttention, useAccounts } from '@/lib/accounts';
import { api, type EnvInfo } from '@/lib/api';
import { accountGlance, claudeHeadline, fixupLabel, fixupLine, modelsGlance, newerModels, type ClaudeGlance, type GlanceKey } from '@/lib/claude-settings-words';
import { updatesGlance } from '@/lib/codex-settings-words';
import { claudeChatsOnly } from '@/lib/engines';
import { store } from '@/lib/store';
import { setting } from '@/lib/telemetry';
import { ui } from '@/lib/ui';
import { useUpkeep } from '@/lib/upkeep';
import { driftHint, driftLine, switchOn, upkeepLine } from '@/lib/upkeep-words';
import { ClaudeAccounts } from '../accounts-section';
import { MakerLogo } from '../maker-logo';
import { claudeVersion, open, tilde } from './engine-pages';
import { Button, Glances, Identity, Mark, Page, Row, Section, Status, Switch, ToolHead, Value } from './kit';

/** Where a glance jumps to: its section's id. The models Canopy changed are listed under Updates. */
const SECTION: Record<GlanceKey, string> = { account: 'claude-accounts', updates: 'claude-updates', models: 'claude-updates' };

// A row with no icon of its own, under one that has: its words start where the rows above start theirs.
const indent = <span aria-hidden className="size-8 shrink-0" />;

/** `part`: 'accounts' (on Accounts: who it runs as, and updates) or 'advanced' (where it lives, its own settings). */
export function ClaudeCode({ env, close, part }: { env: EnvInfo | null; close: () => void; part?: 'accounts' | 'advanced' }) {
  const up = useUpkeep(); // Canopy's upkeep of Claude Code, once main has looked at it
  const accounts = useAccounts();
  const using = accountInUse(accounts, 'claude');
  const root = useRef<HTMLDivElement>(null);
  const [checking, setChecking] = useState(false); // Check Now was pressed
  const [skipped, setSkipped] = useState(false); // is "Not shown yet" unfolded

  const account = accountGlance(env?.auth, using ? { label: using.label, problem: needsAttention(using) ? accountLine(using) : null } : null, !accounts || accounts.checking);
  const updates: ClaudeGlance = { ...updatesGlance(up, checking), key: 'updates' }; // the glance both tools share
  const head = claudeHeadline(account, updates);
  const fixups = newerModels(up?.fixups ?? []);
  const jump = (key: GlanceKey) => root.current?.querySelector(`#${SECTION[key]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const glances = [account, updates, modelsGlance(fixups)].filter((g) => g !== null).map((g) => ({ label: g.label, value: g.value, tone: g.tone, onClick: () => jump(g.key) }));
  const version = claudeVersion(env, up?.version); // upkeep's is current after an update
  const line = up ? upkeepLine(up, checking) : 'Checking…';
  const drift = up?.drift ?? [];

  const check = async () => { setChecking(true); try { await api.upkeep?.check(); } finally { setChecking(false); } };
  const terminal = (command: string) => {
    if (claudeChatsOnly(store.meta)) return; // the terminal view is Claude Code's own screen
    close();
    ui.openTab('terminal', { terminalCommand: command, terminalLive: !store.meta.busy });
  };
  return (
    <Page title="Claude Code">
      <div ref={root} className="space-y-7">
        {part === 'accounts' && <ToolHead mark={<MakerLogo maker="claude" className="text-[#D97757]" />} name="Claude Code" aside={<Status tone={head.tone}>{[version, head.text].filter(Boolean).join(' · ')}</Status>} />}
        {!part && <Identity mark={<Mark icon={<MakerLogo maker="claude" />} size="lg" />}
          title={<>Claude Code {version && <span className="font-normal text-muted-foreground">{version}</span>}</>}
          detail={<Status tone={head.tone}>{head.text}</Status>}>
          <Glances items={glances} />
        </Identity>}
        {part !== 'advanced' && <ClaudeAccounts auth={env?.auth} id={SECTION.account} />}
        {part !== 'advanced' && <Section id={SECTION.updates} title={part ? undefined : 'Updates'} footer={up ? up.blockedBy ?? (part ? undefined : 'Canopy updates Claude Code in the background, only while no chat is working.') : undefined}>
          <Row icon={<RefreshCwIcon />} tint="green" label="Keep Claude Code up to date" title={line}
            detail={updates.tone === 'attention' ? <Status tone="attention">{line}</Status> : line}>
            {up && <Button onClick={check} busy={checking || up.doing === 'updating'}>Check Now</Button>}
            {up && <Switch label="Keep Claude Code up to date" on={switchOn(up)} disabled={!!up.blockedBy} onChange={(on) => { setting('auto_update', on); api.upkeep?.setAuto(on); }} />}
          </Row>
          {fixups.map((f) => <Row key={f.from} lead={indent} label={fixupLabel(f)} detail={fixupLine(f)} title={fixupLine(f)} />)}
        </Section>}
        {part !== 'accounts' && <Section title={part ? 'Claude Code' : 'Advanced'} footer={part ? undefined : 'Canopy uses your Claude Code setup as it is: settings, skills, plugins, MCP servers and CLAUDE.md.'}>
          <Row icon={<SquareTerminalIcon />} tint="gray" label="Installed at" detail={env?.claudePath ? tilde(env.claudePath) : 'Not known'}>
            {env?.claudePath && <Value text={env.claudePath} shown="Copy" mono={false} />}
          </Row>
          <Row icon={<SettingsIcon />} tint="gray" label="Claude Code settings" detail="Opens /config in the terminal" onClick={() => terminal('/config')} opens="outside" action="Open" />
          <Row icon={<FolderIcon />} tint="blue" label="Claude Code folder" detail={tilde(env?.claudeDir) || '~/.claude'} onClick={() => { open(env?.claudeDir, 'Claude Code folder', true); }} opens="outside" action="Show in Finder" />
          {drift.length > 0 && (
            <Row icon={<EyeOffIcon />} tint="gray" label="Not shown yet" detail={driftLine('Claude Code', drift.length)} title={driftLine('Claude Code', drift.length)}
              onClick={() => setSkipped((v) => !v)} opens={skipped ? 'less' : 'more'}>
              {skipped && <button type="button" onClick={() => { api.upkeep?.clearDrift(); }} className="text-small text-muted-foreground hover:text-foreground">Clear</button>}
            </Row>
          )}
          {/* Unfolded: one row for each, its words starting where the rows above start theirs. */}
          {skipped && drift.slice().reverse().map((x) => (
            <Row key={`${x.label}@${x.version}`} lead={indent} label={x.label} detail={driftHint('Claude Code', x)} />
          ))}
        </Section>}
      </div>
    </Page>
  );
}

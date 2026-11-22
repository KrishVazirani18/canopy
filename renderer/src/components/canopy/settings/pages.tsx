// Settings' five pages, each made of the parts that used to be pages of their own (they are drawn here with
// PageFrame's `embed`, so their sections join this page under its one header):
//   You        your Canopy account, what Canopy remembers (Memory opens from here), usage stats (Privacy opens from
//              here), deleting the account
//   Chats      what new chats start with (model, effort, Fast), permissions, the finish sound, the theme
//   Accounts   Claude Code and Codex: the account each runs as, Codex's Computer Use, keeping each up to date
//   Tools      connectors, skills and plugins, one tab each (each keeps its own pages for one thing)
//   Advanced   the model menu, keyboard shortcuts, Code Mode and Canopy Kit, where each tool lives, versions and log
import { useEffect, useState } from 'react';
import { BarChart3Icon, KeyboardIcon, ListOrderedIcon } from 'lucide-react';
import type { EnvInfo } from '@/lib/api';
import { feature, refreshTelemetry, setTelemetryEnabled, useTelemetryStatus } from '@/lib/telemetry';
import { ConnectorsPage, PluginsPage, SkillsPage } from '../customize-pages';
import { ModelsPage } from '../settings-models';
import { CanopyAccountPage } from './account-page';
import { Appearance, General } from './app-pages';
import { ClaudeCode } from './claude-page';
import { Codex } from './codex-page';
import { About } from './engine-pages';
import { Page, PageFrame, Row, Section, Segmented, Switch } from './kit';

/** Draws an older page's sections as part of this one. */
const Embed = ({ children }: { children: React.ReactNode }) => <PageFrame.Provider value={{ embed: true }}>{children}</PageFrame.Provider>;

/** A page opened from a row (Privacy, Memory, the model menu, shortcuts): its own page, with ‹ back. */
export type Open = (page: 'privacy' | 'models' | 'shortcuts') => void;

export function YouPage({ go }: { go: Open }) {
  const stats = useTelemetryStatus();
  useEffect(() => { void refreshTelemetry(); }, []);
  return (
    <Page title="You">
      <Embed><CanopyAccountPage /></Embed>
      <Section title="Privacy">
        {stats && (
          <Row icon={<BarChart3Icon />} label="Share usage stats" detail={!stats.enabled ? 'Off. Nothing is sent.' : stats.endpoint ? 'Never your chats, code or files' : 'On, but nothing is sent from a copy built from source'}>
            <Switch label="Share usage stats" on={stats.enabled} onChange={(on) => void setTelemetryEnabled(on)} />
          </Row>
        )}
        <Row label="What’s counted and sent" detail="Every event, exactly as it is sent" onClick={() => { feature('whats_sent_opened'); go('privacy'); }} />
      </Section>
    </Page>
  );
}

export function ChatsPage({ env }: { env: EnvInfo | null }) {
  return (
    <Page title="Chats">
      <Embed>
        <ModelsPage env={env} part="defaults" />
        <General part="chats" />
        <Appearance />
      </Embed>
    </Page>
  );
}

export function AccountsPage({ env, close }: { env: EnvInfo | null; close: () => void }) {
  return (
    <Page title="Accounts">
      <Embed>
        <ClaudeCode env={env} close={close} part="accounts" />
        <Codex env={env} part="accounts" />
      </Embed>
    </Page>
  );
}

export type ToolTab = 'connectors' | 'skills' | 'plugins';
export function ToolsPage({ tab, setTab, close }: { tab: ToolTab; setTab: (t: ToolTab) => void; close: () => void }) {
  const tabs = <Segmented value={tab} onChange={setTab} options={[{ value: 'connectors', label: 'Connectors' }, { value: 'skills', label: 'Skills' }, { value: 'plugins', label: 'Plugins' }]} />;
  // Each tab is its own page, with its own pages for one thing (‹ back to the list); the tabs ride on its toolbar.
  return (
    <PageFrame.Provider value={{ title: 'Tools', toolbar: tabs }}>
      {tab === 'connectors' && <ConnectorsPage close={close} />}
      {tab === 'skills' && <SkillsPage close={close} />}
      {tab === 'plugins' && <PluginsPage />}
    </PageFrame.Provider>
  );
}

export function AdvancedPage({ env, close, go }: { env: EnvInfo | null; close: () => void; go: Open }) {
  return (
    <Page title="Advanced">
      <Section title="Canopy">
        <Row icon={<ListOrderedIcon />} label="Model menu" detail="Which models are in the menu, and in what order" onClick={() => go('models')} />
        <Row icon={<KeyboardIcon />} label="Keyboard shortcuts" detail="Every shortcut, for reference" onClick={() => go('shortcuts')} />
      </Section>
      <Embed>
        <General part="advanced" />
        <ClaudeCode env={env} close={close} part="advanced" />
        <Codex env={env} part="advanced" />
        <About env={env} />
      </Embed>
    </Page>
  );
}

/** A page opened from a row, with ‹ back to where it was opened. */
export function Opened({ back, children }: { back: { label: string; onClick: () => void }; children: React.ReactNode }) {
  return <PageFrame.Provider value={{ back }}>{children}</PageFrame.Provider>;
}

export const useToolTab = () => useState<ToolTab>('connectors');

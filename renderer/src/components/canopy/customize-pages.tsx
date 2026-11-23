// Settings → Connectors (MCP servers), Skills and Plugins. Each is a list page, and clicking a row opens that item's
// own page (‹ back in the header) instead of a split pane. Built from Settings' own pieces (settings/kit.tsx), like
// every page: header with the page's actions, a toolbar (search, a filter, Plugins' views), then sections of rows.
// Data comes from cached resources (lib/customize.ts): instant on open, refreshed quietly in the background.
// Every change goes through Claude Code's own CLI, so the terminal sees it too.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowUpRightIcon, BookOpenIcon, FolderOpenIcon, PlusIcon, SquarePenIcon, StoreIcon } from 'lucide-react';
import { MessageResponse } from '@/components/ai-elements/message';
import { connectorsNote } from '@/lib/account-rules';
import { accountInUse, useAccounts } from '@/lib/accounts';
import { api } from '@/lib/api';
import {
  customize, mutate, prettyName, refresh, useResource,
  type CatalogPlugin, type InstalledPlugin, type Marketplace, type McpServer, type PluginDetails, type Skill,
} from '@/lib/customize';
import { claudeChatsOnly } from '@/lib/engines';
import { store } from '@/lib/store';
import { extensionAdded, feature } from '@/lib/telemetry';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';
import {
  Button, Empty, Field, Identity, Loading, Mark, Page, Pair, Problem, Refresh, Row, SearchField, Section, Segmented, Select,
  ShowAll, Status, Switch, Value, input, plural, useDrill, type Tone,
} from './settings/kit';

const appliesHint = 'Changes apply to new chats.';
const prefill = (text: string) => setTimeout(() => window.dispatchEvent(new CustomEvent('canopy:prefill', { detail: text })), 80);
/** "mcp__github__search_issues" → "Search issues". */
const toolName = (n: string) => { const s = n.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const has = (q: string, ...parts: (string | null | undefined)[]) => !q.trim() || parts.join(' ').toLowerCase().includes(q.trim().toLowerCase());
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ======================================================================================================
// Connectors
// ======================================================================================================

type McpData = { servers: McpServer[]; tools: Record<string, { name: string; description?: string }[]> };
const STATUS: Record<McpServer['status'], { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  'needs-auth': { label: 'Needs sign-in', tone: 'attention' },
  failed: { label: 'Not working', tone: 'attention' },
  disabled: { label: 'Off', tone: 'off' },
  pending: { label: 'Needs approval', tone: 'attention' },
};
const where = (s: McpServer) => (s.plugin ? `from the ${prettyName(s.plugin)} plugin` : s.transport === 'stdio' ? 'runs on this Mac' : 'online service');
const online = (s: McpServer) => s.transport !== 'stdio';

export function ConnectorsPage({ close }: { close: () => void }) {
  const { data, error, loading, refresh: reload } = useResource<McpData>('mcp');
  const [q, setQ] = useState('');
  const nav = useDrill<string>();
  const account = accountInUse(useAccounts(), 'claude'); // connector sign-ins are kept per account
  const servers = useMemo(() => [...(data?.servers ?? [])].sort((a, b) => a.label.localeCompare(b.label)), [data]);
  const toolsOf = (s: McpServer) => data?.tools[s.name] ?? data?.tools[s.label];
  const signIn = (s: McpServer) => {
    if (claudeChatsOnly(store.meta)) return; // signing in happens on Claude Code's own /mcp screen
    close();
    ui.openTab('terminal', { terminalLive: !store.meta.busy, terminalCommand: '/mcp' });
    toast(`Pick ${prettyName(s.label)}, then Authenticate. Your browser opens to sign in.`);
  };

  if (nav.open === '__add') return <AddConnector dir={nav.dir} back={nav.back} onAdded={() => { nav.back(); refresh('mcp', true); }} />;
  const current = nav.open ? servers.find((s) => s.name === nav.open) : null;
  if (current) return <ConnectorPage s={current} tools={toolsOf(current)} dir={nav.dir} back={nav.back} signIn={() => signIn(current)} onRemoved={() => { nav.back(); refresh('mcp', true); }} />;

  const shown = servers.filter((s) => has(q, s.label, s.target));
  const showChrome = typeof api.backgroundChrome?.openSettings === 'function' && has(q, 'Chrome', 'browser');
  // Under the connectors waiting for a sign-in, when the account in use is one added in Canopy: its sign-ins start empty.
  const groups: { title: string; items: McpServer[]; footer?: string }[] = [
    { title: 'Needs you', items: shown.filter((s) => s.status === 'needs-auth' || s.status === 'failed' || s.status === 'pending'),
      footer: connectorsNote(account, shown.filter((s) => s.status === 'needs-auth').length) },
    { title: 'Connected', items: shown.filter((s) => s.status === 'connected') },
    { title: 'Off', items: shown.filter((s) => s.status === 'disabled') },
  ].filter((g) => g.items.length);
  const detail = (s: McpServer) => {
    const tools = toolsOf(s);
    if (s.status === 'connected') return cap([tools ? plural(tools.length, 'tool') : null, where(s)].filter(Boolean).join(' · '));
    if (s.status === 'disabled') return cap(where(s));
    return <Status tone="attention">{s.status === 'needs-auth' ? `Needs sign-in · ${where(s)}` : cap(s.detail || STATUS[s.status].label)}</Status>;
  };
  return (
    <Page title="Connectors" dir={nav.dir}
      actions={<><Refresh busy={loading && !!data} onClick={reload} /><Button onClick={() => nav.go('__add')}><PlusIcon className="size-3.5" />Add Connector</Button></>}
      toolbar={<SearchField value={q} onChange={setQ} placeholder="Search connectors" />}>
      {showChrome && <Section title="Built in" footer="Enable remote debugging in Chrome Settings. When a chat connects, Chrome asks you to approve access.">
        <Row label="Chrome" detail="Use open tabs in the background with Claude Code or Codex" opens="outside" action="Chrome Settings"
          onClick={() => {
            void api.backgroundChrome?.openSettings().then((ok) => {
              if (!ok) toast.error('Couldn’t open Chrome Settings. Open Google Chrome and go to chrome://inspect/#remote-debugging.');
            }, () => toast.error('Couldn’t open Chrome Settings.'));
          }} />
      </Section>}
      {error ? <Problem onRetry={reload}>{error}</Problem>
        : !data ? <Loading />
        : groups.length === 0 && !showChrome ? <Empty>{q ? `No connectors match “${q.trim()}”.` : 'No connectors yet. Add one to give Canopy a new app.'}</Empty>
        : groups.map((g) => (
          <Section key={g.title} title={g.title} count={g.items.length} footer={g.footer}>
            {g.items.map((s) => (
              <Row key={s.name} lead={<Mark name={prettyName(s.label)} />} label={prettyName(s.label)} detail={detail(s)} muted={s.status === 'disabled'} onClick={() => nav.go(s.name)}>
                {s.status === 'needs-auth' && online(s) && <Button onClick={() => signIn(s)}>Sign In</Button>}
              </Row>
            ))}
          </Section>
        ))}
    </Page>
  );
}

const TOOLS_SHOWN = 8;
function ConnectorPage({ s, tools, dir, back, signIn, onRemoved }: {
  s: McpServer; tools?: { name: string; description?: string }[]; dir?: 'in' | 'back'; back: () => void; signIn: () => void; onRemoved: () => void;
}) {
  const st = STATUS[s.status];
  const name = prettyName(s.label);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const remove = async () => {
    if (!confirm(`Remove ${name}? Claude Code stops using it in every chat.`)) return;
    setBusy(true);
    const r = await customize.mcpRemove(s.name);
    setBusy(false);
    if (r.ok) { toast(`Removed ${name}`); onRemoved(); } else toast.error(r.error);
  };
  return (
    <Page title={name} dir={dir} back={{ label: 'Connectors', onClick: back }}>
      <Identity mark={<Mark name={name} size="lg" />} title={name}
        detail={<Status tone={st.tone}>{st.label} · {where(s)}</Status>}
        actions={online(s) && s.status === 'needs-auth' && <Button onClick={signIn}><ArrowUpRightIcon className="size-3.5" />Sign In</Button>} />
      {s.status !== 'connected' && s.status !== 'disabled' && s.status !== 'needs-auth' && s.detail && (
        <Problem>{s.detail}</Problem>
      )}
      <Section title="Details" footer={s.plugin ? `Comes with the ${prettyName(s.plugin)} plugin. Turn the plugin off to turn this off.` : undefined}>
        <Pair label={online(s) ? 'Address' : 'Command'}><Value text={s.target} /></Pair>
        {online(s) && s.status === 'connected' && <Row label="Sign in again" detail="Opens Claude Code’s /mcp screen" onClick={signIn} />}
      </Section>
      <Section title="Tools" count={tools?.length || undefined}>
        {tools?.length ? (
          <>
            {(all ? tools : tools.slice(0, TOOLS_SHOWN)).map((t) => <Row key={t.name} title={t.name} label={toolName(t.name)} detail={t.description} />)}
            {tools.length > TOOLS_SHOWN && <ShowAll open={all} count={tools.length} onClick={() => setAll(!all)} />}
          </>
        ) : <p className="px-4 py-4 text-small text-faint">{s.status === 'connected' ? 'Open a chat to load its tools.' : 'Its tools show up once it’s connected.'}</p>}
      </Section>
      {!s.plugin && (
        <Section>
          <Row label="Remove connector" detail="Claude Code stops using it in every chat"><Button onClick={remove} busy={busy}>Remove…</Button></Row>
        </Section>
      )}
    </Page>
  );
}

function AddConnector({ dir, back, onAdded }: { dir?: 'in' | 'back'; back: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const isUrl = /^https?:\/\//.test(target.trim());
  const submit = async () => {
    setBusy(true);
    const lines = extra.split('\n').map((l) => l.trim()).filter(Boolean);
    const r = await customize.mcpAdd({ name: name.trim(), target: target.trim(), scope, headers: isUrl ? lines : [], env: isUrl ? [] : lines });
    setBusy(false);
    if (r.ok) { extensionAdded('connector', name.trim()); toast(`Added ${name.trim()}`); onAdded(); } else toast.error(r.error);
  };
  return (
    <Page title="Add Connector" dir={dir} back={{ label: 'Connectors', onClick: back }}>
      <Section footer="Paste the address of an online MCP server, or the command that starts one on this Mac. The service’s docs usually list it.">
        <Field label="Name"><input className={input} placeholder="sentry" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Address or command">
          <input className={cn(input, 'font-mono text-code')} placeholder="https://mcp.example.com/mcp" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field label={isUrl ? 'Headers (optional)' : 'Environment variables (optional)'}>
          <textarea className={cn(input, 'h-20 resize-none py-2 font-mono text-code')} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={isUrl ? 'Authorization: Bearer …' : 'API_KEY=…'} />
        </Field>
        <Row label="Available in">
          <Segmented value={scope} onChange={setScope} options={[{ value: 'user', label: 'All my chats' }, { value: 'project', label: 'This project' }]} />
        </Row>
      </Section>
      <div className="flex justify-end gap-2">
        <Button onClick={back}>Cancel</Button>
        <Button primary busy={busy} disabled={!name.trim() || !target.trim()} onClick={submit}>Add Connector</Button>
      </div>
    </Page>
  );
}

// ======================================================================================================
// Skills
// ======================================================================================================

const SKILLS_SHOWN = 6;
const skillSource = (s: Skill) => (s.source === 'plugin' ? `${prettyName(s.plugin!)} plugin` : s.source === 'project' ? 'This project' : 'Your skill');

export function SkillsPage({ close }: { close: () => void }) {
  const { data, error, loading, refresh: reload } = useResource<{ skills: Skill[] }>('skills');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('all');
  const [more, setMore] = useState<Record<string, boolean>>({});
  const nav = useDrill<string>();
  const groups = useMemo(() => {
    const all = data?.skills ?? [];
    const out: { id: string; title: string; items: Skill[] }[] = [];
    const yours = all.filter((s) => s.source === 'user'); if (yours.length) out.push({ id: 'user', title: 'Yours', items: yours });
    const proj = all.filter((s) => s.source === 'project'); if (proj.length) out.push({ id: 'project', title: 'This project', items: proj });
    const by = new Map<string, Skill[]>();
    for (const s of all.filter((x) => x.source === 'plugin')) by.set(s.plugin!, [...(by.get(s.plugin!) ?? []), s]);
    for (const [p, items] of by) out.push({ id: `p:${p}`, title: prettyName(p), items });
    return out;
  }, [data]);
  // A filter for a source that is gone (its plugin was removed) falls back to all.
  const filter = groups.some((g) => g.id === from) ? from : 'all';
  const visible = groups
    .filter((g) => filter === 'all' || g.id === filter)
    .map((g) => ({ ...g, items: g.items.filter((s) => has(q, s.name, s.description)) }))
    .filter((g) => g.items.length);

  const current = nav.open ? data?.skills.find((s) => s.path === nav.open) : null;
  if (current) return <SkillPage skill={current} dir={nav.dir} back={nav.back} close={close} />;

  return (
    <Page title="Skills" dir={nav.dir}
      actions={<><Refresh busy={loading && !!data} onClick={reload} />
        <Button onClick={() => { close(); prefill('Help me create a new Claude Code skill in ~/.claude/skills that '); }}><PlusIcon className="size-3.5" />New Skill</Button></>}
      toolbar={<>
        <SearchField value={q} onChange={setQ} placeholder={data ? `Search ${plural(data.skills.length, 'skill')}` : 'Search skills'} />
        {groups.length > 1 && (
          <Select label="Source" value={filter} onChange={setFrom} width="w-56"
            options={[{ value: 'all', label: 'All sources', detail: plural(data?.skills.length ?? 0, 'skill') },
              ...groups.map((g, i) => ({ value: g.id, label: g.title, detail: plural(g.items.length, 'skill'), separatorBefore: i === 0 }))]} />
        )}
      </>}>
      {error ? <Problem onRetry={reload}>{error}</Problem>
        : !data ? <Loading />
        : visible.length === 0 ? <Empty>{q ? `No skills match “${q.trim()}”.` : 'No skills yet.'}</Empty>
        : visible.map((g) => {
          const open = more[g.id] || !!q.trim() || filter !== 'all';
          return (
            <Section key={g.id} title={g.title} count={g.items.length}>
              {(open ? g.items : g.items.slice(0, SKILLS_SHOWN)).map((s) => (
                <Row key={s.path} label={s.name} detail={s.description || 'No description'} onClick={() => nav.go(s.path)}>
                  <span className="block max-w-56 truncate font-mono text-code text-faint" title={`/${s.invoke}`}>/{s.invoke}</span>
                </Row>
              ))}
              {!open && g.items.length > SKILLS_SHOWN && <ShowAll open={false} count={g.items.length} onClick={() => setMore({ ...more, [g.id]: true })} />}
            </Section>
          );
        })}
    </Page>
  );
}

const bodies = new Map<string, string>();
function SkillPage({ skill, dir, back, close }: { skill: Skill; dir?: 'in' | 'back'; back: () => void; close: () => void }) {
  const [body, setBody] = useState<string | null>(bodies.get(skill.path) ?? null);
  useEffect(() => {
    if (bodies.has(skill.path)) return;
    customize.skillRead(skill.path).then((r) => { const b = r.ok ? r.body : `_${r.error}_`; bodies.set(skill.path, b); setBody(b); });
  }, [skill.path]);
  const link = 'flex items-center gap-1 text-small text-muted-foreground hover:text-foreground';
  return (
    <Page title={skill.name} dir={dir} back={{ label: 'Skills', onClick: back }}>
      <Identity mark={<Mark icon={<BookOpenIcon />} size="lg" />} title={skill.name}
        detail={<>{skillSource(skill)}<span className="text-faint">·</span><span className="truncate font-mono text-code">/{skill.invoke}</span></>}
        actions={<Button onClick={() => { close(); prefill(`/${skill.invoke} `); }}><SquarePenIcon className="size-3.5" />Use in Chat</Button>} />
      {skill.description && <p className="-mt-3 px-1 text-ui text-muted-foreground">{skill.description}</p>}
      <Section title="Instructions" aside={<>
        <button className={link} onClick={() => { feature('file_opened'); api.openPath(skill.path); }}><ArrowUpRightIcon className="size-3.5" />Open in Editor</button>
        <button className={link} onClick={() => { feature('reveal_in_finder'); api.openPath(skill.path, null, true); }}><FolderOpenIcon className="size-3.5" />Show in Finder</button>
      </>}>
        <div className="px-5 py-4">
          {body == null
            ? <div className="space-y-2" aria-hidden>{[90, 75, 85, 60, 80].map((w, i) => <div key={i} className="h-2.5 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />)}</div>
            : <div className="prose-reply prose-compact"><MessageResponse>{body}</MessageResponse></div>}
        </div>
      </Section>
    </Page>
  );
}

// ======================================================================================================
// Plugins
// ======================================================================================================

type PluginView = 'installed' | 'browse' | 'marketplaces';
type PluginAction = 'install' | 'uninstall' | 'enable' | 'disable' | 'update';
const pluginName = (id: string) => prettyName(id.split('@')[0]);

async function runPlugin(action: PluginAction, id: string) {
  const name = pluginName(id);
  if (action === 'enable' || action === 'disable') mutate<{ installed: InstalledPlugin[] }>('plugins', (d) => ({ ...d, installed: d.installed.map((p) => (p.id === id ? { ...p, enabled: action === 'enable' } : p)) }));
  const r = await customize.pluginAction(action, id);
  if (!r.ok) toast.error(r.error);
  else toast({ install: `Installed ${name}`, uninstall: `Uninstalled ${name}`, enable: `Turned on ${name}`, disable: `Turned off ${name}`, update: `${name} is up to date` }[action], { description: appliesHint });
  if (r.ok && action === 'install') extensionAdded('plugin', id.split('@')[0]);
  refresh('plugins', true); refresh('skills', true); refresh('mcp', true);
  return r.ok;
}

export function PluginsPage() {
  const [view, setView] = useState<PluginView>('installed');
  const [q, setQ] = useState('');
  const nav = useDrill<string>();
  const installed = useResource<{ installed: InstalledPlugin[] }>('plugins');
  // The catalog is big and slow to list, so it is only asked for once Browse is open (BrowsePlugins reads it).
  const key = { installed: 'plugins', browse: 'catalog', marketplaces: 'markets' }[view];
  const current = nav.open ? installed.data?.installed.find((p) => p.id === nav.open) : null;
  if (current) return <PluginPage p={current} dir={nav.dir} back={nav.back} />;
  return (
    <Page title="Plugins" dir={nav.dir}
      actions={<Refresh busy={view === 'installed' && installed.loading && !!installed.data} onClick={() => refresh(key, true)} />}
      toolbar={<>
        <Segmented value={view} onChange={(v) => { setView(v); setQ(''); }}
          options={[{ value: 'installed', label: 'Installed' }, { value: 'browse', label: 'Browse' }, { value: 'marketplaces', label: 'Marketplaces' }]} />
        <SearchField value={q} onChange={setQ} placeholder={view === 'installed' ? 'Search installed' : view === 'browse' ? 'Search plugins' : 'Search marketplaces'} />
      </>}>
      {view === 'installed' && <InstalledPlugins res={installed} q={q} open={nav.go} />}
      {view === 'browse' && <BrowsePlugins installed={installed.data?.installed} q={q} />}
      {view === 'marketplaces' && <Marketplaces q={q} />}
    </Page>
  );
}

function InstalledPlugins({ res, q, open }: { res: ReturnType<typeof useResource<{ installed: InstalledPlugin[] }>>; q: string; open: (id: string) => void }) {
  const { data, error, refresh: reload } = res;
  const items = useMemo(() => (data?.installed ?? []).filter((p) => has(q, p.id)).sort((a, b) => a.id.localeCompare(b.id)), [data, q]);
  if (error) return <Problem onRetry={reload}>{error}</Problem>;
  if (!data) return <Loading rows={4} />;
  if (!items.length) return <Empty>{q ? `No installed plugins match “${q.trim()}”.` : 'No plugins yet. Find some in Browse.'}</Empty>;
  return (
    <Section title="Installed" count={`${items.length} · ${items.filter((p) => p.enabled).length} on`} footer={appliesHint}>
      {items.map((p) => {
        const [id, market] = p.id.split('@');
        const name = prettyName(id);
        return (
          <Row key={p.id} lead={<Mark name={name} />} label={name} muted={!p.enabled} onClick={() => open(p.id)}
            detail={[market, p.version ? `v${p.version}` : null].filter(Boolean).join(' · ')}>
            <Switch label={`Turn ${name} on or off`} on={p.enabled} onChange={(v) => runPlugin(v ? 'enable' : 'disable', p.id)} />
          </Row>
        );
      })}
    </Section>
  );
}

const details = new Map<string, PluginDetails>();
function PluginPage({ p, dir, back }: { p: InstalledPlugin; dir?: 'in' | 'back'; back: () => void }) {
  const [d, setD] = useState<PluginDetails | null>(details.get(p.id) ?? null);
  const [busy, setBusy] = useState<PluginAction | null>(null);
  const [, market] = p.id.split('@');
  const name = pluginName(p.id);
  useEffect(() => { if (!details.has(p.id)) customize.pluginDetails(p.id).then((r) => { if (r.ok) { details.set(p.id, r); setD(r); } }); }, [p.id]);
  const act = async (a: PluginAction) => {
    if (a === 'uninstall' && !confirm(`Uninstall ${name}?`)) return;
    setBusy(a); const ok = await runPlugin(a, p.id); setBusy(null);
    if (ok && a === 'uninstall') back();
    if (ok && a === 'update') details.delete(p.id);
  };
  const wait = <span className="inline-block h-3 w-10 animate-pulse rounded bg-muted align-middle" />;
  const includes = !!d && (d.skills.length > 0 || d.mcp.length > 0 || d.hooks > 0 || d.agents > 0);
  return (
    <Page title={name} dir={dir} back={{ label: 'Plugins', onClick: back }}>
      <Identity mark={<Mark name={name} size="lg" />} title={name}
        detail={<Status tone={p.enabled ? 'ok' : 'off'}>{p.enabled ? 'On' : 'Off'}{p.version ? ` · v${p.version}` : ''}</Status>}
        actions={<Switch label={`Turn ${name} on or off`} on={p.enabled} onChange={(v) => runPlugin(v ? 'enable' : 'disable', p.id)} />} />
      <Section title="Details">
        <Pair label="From"><span className="text-muted-foreground">{market}</span></Pair>
        {p.version && <Pair label="Version"><span className="text-muted-foreground">{p.version}</span></Pair>}
        <Pair label="Adds to every chat"><span className="text-muted-foreground">{d ? (d.alwaysOnTokens ? `About ${d.alwaysOnTokens} tokens` : 'Nothing') : wait}</span></Pair>
      </Section>
      {includes && (
        <Section title="Includes">
          {d.skills.map((s) => <Row key={`s:${s}`} lead={<Mark icon={<BookOpenIcon />} />} label={s} detail="Skill"><span className="font-mono text-code text-faint">/{s}</span></Row>)}
          {d.mcp.map((s) => <Row key={`m:${s}`} lead={<Mark name={prettyName(s)} />} label={prettyName(s)} detail="Connector" />)}
          {d.agents > 0 && <Row label={plural(d.agents, 'agent')} detail="Helpers Claude can hand work to" />}
          {d.hooks > 0 && <Row label={plural(d.hooks, 'hook')} detail="Run on Claude Code events" />}
        </Section>
      )}
      <Section footer={appliesHint}>
        <Row label="Updates" detail={p.version ? `Version ${p.version}` : undefined}><Button onClick={() => act('update')} busy={busy === 'update'} disabled={!!busy}>Check for Updates</Button></Row>
        <Row label="Uninstall plugin" detail="Removes its skills and connectors from every chat"><Button onClick={() => act('uninstall')} busy={busy === 'uninstall'} disabled={!!busy}>Uninstall…</Button></Row>
      </Section>
    </Page>
  );
}

const CATALOG_SHOWN = 40;
function BrowsePlugins({ installed, q }: { installed?: InstalledPlugin[]; q: string }) {
  const { data, error, refresh: reload } = useResource<{ installed: InstalledPlugin[]; available: CatalogPlugin[] }>('catalog');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const have = new Set((installed ?? data?.installed ?? []).map((p) => p.id));
  const matches = useMemo(() => (data?.available ?? []).filter((p) => has(q, p.name, p.description)), [data, q]);
  const install = async (id: string) => { setBusy((b) => ({ ...b, [id]: true })); await runPlugin('install', id); setBusy((b) => ({ ...b, [id]: false })); };
  if (error) return <Problem onRetry={reload}>{error}</Problem>;
  if (!data) return <Loading rows={6} />;
  if (!matches.length) return <Empty>No plugins match “{q.trim()}”.</Empty>;
  return (
    <Section title={q.trim() ? 'Matches' : 'Most installed'} count={matches.length.toLocaleString()}
      footer={matches.length > CATALOG_SHOWN ? `Showing ${CATALOG_SHOWN} of ${matches.length.toLocaleString()}. Search to find others.` : undefined}>
      {matches.slice(0, CATALOG_SHOWN).map((p) => (
        <Row key={p.id} lead={<Mark name={prettyName(p.name)} />} label={prettyName(p.name)}
          detail={[p.description, p.installs ? `${p.installs.toLocaleString()} installs` : null].filter(Boolean).join(' · ')}>
          {have.has(p.id) ? <Status>Installed</Status> : <Button onClick={() => install(p.id)} busy={busy[p.id]}>Install</Button>}
        </Row>
      ))}
    </Section>
  );
}

function Marketplaces({ q }: { q: string }) {
  const { data, error, refresh: reload } = useResource<{ list: Marketplace[] }>('markets');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const r = await customize.marketplaceAdd(source.trim());
    setBusy(false);
    if (r.ok) { toast('Marketplace added'); setSource(''); reload(); refresh('catalog', true); } else toast.error(r.error);
  };
  const list = (data?.list ?? []).filter((m) => has(q, m.name, m.repo, m.url));
  return (
    <>
      {error ? <Problem onRetry={reload}>{error}</Problem> : !data ? <Loading rows={3} /> : !list.length ? <Empty>{q ? `No marketplaces match “${q.trim()}”.` : 'No marketplaces yet.'}</Empty> : (
        <Section title="Marketplaces" count={list.length}>
          {list.map((m) => (
            <Row key={m.name} lead={<Mark icon={<StoreIcon />} />} label={m.name}
              detail={<span className="truncate font-mono text-code">{m.repo ?? m.url ?? m.installLocation}</span>} />
          ))}
        </Section>
      )}
      <Section title="Add a marketplace" footer="A GitHub repo that lists plugins, like anthropics/claude-plugins-official.">
        <div className="flex items-center gap-2 px-4 py-3">
          <input className={cn(input, 'h-8 font-mono text-code')} placeholder="owner/repo" value={source}
            onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && source.trim() && !busy && add()} />
          <Button onClick={add} busy={busy} disabled={!source.trim()}>Add</Button>
        </div>
      </Section>
    </>
  );
}

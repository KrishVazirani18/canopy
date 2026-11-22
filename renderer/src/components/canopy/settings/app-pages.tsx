// Settings → General, Appearance and Shortcuts. Models is settings-models.tsx; the tool pages are customize-pages.tsx.
// General writes through the same composer event as the chips under the message box (canopy:control), so the two
// always agree; Appearance is the theme the window applies at launch (index.html's __applyTheme).
import { useEffect, useState } from 'react';
import { PlayIcon } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { MODES, setMode } from '../controls';
import { choices } from '@/lib/choices';
import { SOUNDS, getSound, setSound, testSound, type SoundId } from '@/lib/sound';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { setting } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import { IconButton, Page, Row, Section, Select, Status, Switch } from './kit';

// ---------- General ----------
const send = (key: string, value: unknown) => window.dispatchEvent(new CustomEvent('canopy:control', { detail: { key, value, stay: true } }));

/** `part`: 'chats' is permissions and the finish sound; 'advanced' Code Mode and Canopy Kit. */
export function General({ part }: { part?: 'chats' | 'advanced' } = {}) {
  const { meta } = useStore();
  const [, bump] = useState(0);
  const after = () => setTimeout(() => bump((n) => n + 1));
  const [sound, setSoundState] = useState<SoundId>(getSound);
  // Canopy Kit lives in main (src/core/plugin.mjs): read once here, then each flip is saved there for new chats.
  const [kitOn, setKitOn] = useState<boolean | null>(null);
  useEffect(() => { if (typeof api?.kit?.get !== 'function') { setKitOn(true); return; } api.kit.get().then((r) => setKitOn('on' in r ? r.on : true), () => setKitOn(true)); }, []);
  const flipKit = (v: boolean) => { setKitOn(v); api?.kit?.set(v).then((r) => { if ('on' in r) setKitOn(r.on); }); setting('canopy_kit', v); };
  const codeOn = !!choices.codeMode; // your choice for new chats: a chat that has started keeps what it started with
  const mode = MODES.find((m) => m.value === (choices.mode ?? meta.mode ?? 'default')) ?? MODES[0];
  return (
    <Page title="General">
      <Section title={part === 'chats' ? undefined : 'New chats'}>
        {/* The two modes that run things without asking carry the one small amber dot. */}
        {part !== 'advanced' && <Row label="Permissions" detail={mode.value === 'auto' || mode.value === 'bypassPermissions' ? <Status tone="attention">{mode.hint}</Status> : mode.hint}>
          <Select label="Permissions" value={mode.value} width="w-72" onChange={(v) => { setMode(v); setting('default_mode', v); after(); }}
            options={MODES.map((m, i) => ({ value: m.value, label: m.label, detail: m.hint, separatorBefore: i === 3 }))} />
        </Row>}
        {part !== 'chats' && <><Row label="Code Mode" detail={!codeOn && meta.codeBlocked ? meta.codeBlocked : 'Runs multi-step tool work as one script and reads only the result'}>
          <Switch label="Code Mode" on={codeOn} onChange={(v) => { send('codeMode', v); setting('code_mode', v); after(); }} />
        </Row>
        <Row label="Canopy Kit" detail="Design guidance for pages, apps and decks, used where you leave things open. Your instructions always come first">
          <Switch label="Canopy Kit" on={kitOn ?? true} onChange={flipKit} />
        </Row></>}
      {part !== 'advanced' && <Row label="Sound when a chat finishes" detail={sound === 'none' ? 'Off' : undefined}>
          <IconButton label="Play" onClick={() => testSound(sound)} disabled={sound === 'none'}><PlayIcon /></IconButton>
          <Select label="Sound" value={sound} width="w-40" options={SOUNDS.map((s) => ({ value: s.id, label: s.label }))}
            onChange={(id) => { setSound(id); setSoundState(id); testSound(id); setting('sound', id); }} />
        </Row>}
      </Section>
    </Page>
  );
}

// ---------- Appearance ----------
type Theme = 'system' | 'light' | 'dark';
// Mirror --background / --sidebar / --foreground in index.css (notebook light and dark).
const LIGHT = { bg: '#ffffff', side: '#f7f7f7', fg: '#1f1f1f' };
const DARK = { bg: '#181715', side: '#201f1c', fg: '#e7e3da' };

/** A tiny Canopy window: the sidebar's chats, a message, a reply, the message box. */
function MiniWindow({ c }: { c: typeof LIGHT }) {
  const bar = (w: string, o: number) => <div className="h-[5px] rounded-full" style={{ width: w, background: c.fg, opacity: o }} />;
  return (
    <div className="absolute inset-0 flex" style={{ background: c.bg }}>
      <div className="flex w-[30%] flex-col gap-[7px] px-2 pt-3" style={{ background: c.side }}>{bar('70%', 0.35)}{bar('85%', 0.18)}{bar('60%', 0.18)}{bar('75%', 0.18)}</div>
      <div className="flex flex-1 flex-col px-3 pt-3 pb-2.5">
        <div className="ml-auto h-3 w-[45%] rounded-md" style={{ background: c.fg, opacity: 0.1 }} />
        <div className="mt-2.5 space-y-[5px]">{bar('90%', 0.3)}{bar('70%', 0.3)}</div>
        <div className="mt-auto h-5 rounded-md" style={{ border: `1px solid ${c.fg}`, opacity: 0.28 }} />
      </div>
    </div>
  );
}

export function Appearance() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('canopy.theme') as Theme) || 'system');
  const pick = (t: Theme) => { setTheme(t); localStorage.setItem('canopy.theme', t); (window as unknown as { __applyTheme?: () => void }).__applyTheme?.(); setting('theme', t); };
  const THEMES: { id: Theme; label: string }[] = [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];
  return (
    <Page title="Appearance">
      <Section title="Theme">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-4 p-4">
          {THEMES.map((t) => (
            <button key={t.id} role="radio" aria-checked={theme === t.id} onClick={() => pick(t.id)} className="group text-center outline-none">
              <div className={cn('relative aspect-[16/10] overflow-hidden rounded-lg border border-hairline ring-2 ring-offset-2 ring-offset-card transition-shadow',
                theme === t.id ? 'ring-foreground' : 'ring-transparent group-hover:ring-foreground/15 group-focus-visible:ring-foreground/30')}>
                <MiniWindow c={t.id === 'dark' ? DARK : LIGHT} />
                {t.id === 'system' && <div className="absolute inset-0" style={{ clipPath: 'polygon(55% 0, 100% 0, 100% 100%, 45% 100%)' }}><MiniWindow c={DARK} /></div>}
              </div>
              <div className={cn('mt-2.5 text-small', theme === t.id ? 'text-foreground' : 'text-muted-foreground')}>{t.label}</div>
            </button>
          ))}
        </div>
      </Section>
    </Page>
  );
}

// ---------- Shortcuts ----------
const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  { group: 'Canopy', keys: [['New chat', '⌘N'], ['Search chats and actions', '⌘K'], ['Settings', '⌘,'], ['Show or hide the sidebar', '⌘B'], ['Show or hide the panel', '⌘I'], ['Open terminal', '⌘J'], ['Close the panel', 'Esc']] },
  { group: 'Message box', keys: [['Send', '↵'], ['New line', '⇧↵'], ['Commands and skills', '/'], ['Mention a file', '@'], ['Switch permissions', '⇧⇥']] },
  { group: 'While Claude works', keys: [['Stop', 'Esc'], ['Send now, steering the reply', '⌘↵'], ['Steer with what’s typed or queued', 'Esc Esc']] },
];
const keyParts = (k: string) => k.split(' ').flatMap((chord, i) => [...(i ? [' '] : []), ...chord.split(/(?=[⌘⇧⌥⌃])|(?<=[⌘⇧⌥⌃])/).filter(Boolean)]);

export function Shortcuts() {
  return (
    <Page title="Shortcuts">
      {SHORTCUTS.map((g) => (
        <Section key={g.group} title={g.group}>
          {g.keys.map(([label, keys]) => (
            <Row key={label} label={label}>
              <span className="flex items-center gap-1">{keyParts(keys).map((p, i) => p === ' ' ? <span key={i} className="w-1" /> : <Kbd key={i}>{p}</Kbd>)}</span>
            </Row>
          ))}
        </Section>
      ))}
    </Page>
  );
}

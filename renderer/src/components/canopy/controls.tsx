// Session controls that live in the composer's bottom row: model, effort, fast, mode.
//
// A chat belongs to one maker for life (store `meta.engine`), and the chip shows the model, effort
// and bolt. The menu it opens is model-menu.tsx: a search, four model rows of either maker, the rest under More
// models (only Claude's when there are no OpenAI models to offer), and effort and Fast in one block. Picking a
// model of the same maker switches the chat, live. Picking the other maker's saves the pick and asks the window for
// a chat of that maker in the same folder ('canopy:other-maker'): a chat that has not started changes in place, a
// started one is moved there (lib/move.ts): the new chat carries on from it, and the old one stays as it was.
// Effort is one scale for both makers, and a model shows only the stops it offers (lib/models.ts). Each maker
// remembers its own effort and speed (lib/choices.ts); the permission mode is shared.
import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckIcon, ChevronDownIcon, ShieldAlertIcon, ShieldCheckIcon, MapIcon, PencilIcon, BotIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EffortFast, ModelMenu } from './model-menu';
import type { ClaudeModel, Engine } from '@/lib/api';
import { choices, type CodexChoices } from '@/lib/choices';
import { effortName, keepEffort, restingEffort } from '@/lib/engine-rules';
import { limitLines } from '@/lib/limits';
import { claudeRows, codexLabel, codexRow, loadModels, saveCodex } from '@/lib/engines';
import { allModels, chatModel, chosenLevel, effortSettings, effortSlider, engineMaker, pickValue, useAllModels, type Effort, type Model, type Picks } from '@/lib/models';
import { MOVE_BUSY } from '@/lib/move-rules';
import { canMove, modelLabel as rowLabel, moveChat } from '@/lib/move';
import { store as mainStore, useStore, type Store } from '@/lib/store';
import { feature } from '@/lib/telemetry';
import { usePane } from '@/lib/pane';
import { notePlanMode } from '@/lib/plan';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';

// Colours never tween (design spec §1.4): no transition, and focus comes from the global :focus-visible rule.
const chip = 'chip flex h-8 select-none items-center gap-1.5 rounded-full text-ui text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground';

// Vocabulary follows Claude Code. Menu label, chip label and a one-line hint per mode.
export const MODES = [
  { value: 'default', label: 'Ask Before Edits', hint: 'You approve every edit and command', icon: ShieldCheckIcon },
  { value: 'acceptEdits', label: 'Accept Edits', hint: 'Edits apply, commands still ask', icon: PencilIcon },
  { value: 'plan', label: 'Plan Mode', hint: 'Plans first, changes nothing yet', icon: MapIcon },
  { value: 'auto', label: 'Auto Mode', hint: 'Safe actions run, risky ones ask', icon: BotIcon },
  { value: 'bypassPermissions', label: 'Full Access', hint: 'Everything runs without asking', icon: ShieldAlertIcon },
];
const shortMode: Record<string, string> = { default: 'Ask', acceptEdits: 'Accept Edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Full Access' };
const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
const FAST_REASONS: Record<string, string> = {
  free: 'Not on your plan', preference: 'Off in Claude Code settings', extra_usage_disabled: 'Needs extra usage', network_error: 'Couldn’t check',
  not_first_party: 'Not on this provider', disabled_by_env: 'Off by environment variable', model_not_allowed: 'Not on this model',
  pending: 'Checking…', // shown as a spinner, never as text
  unknown: 'Unavailable',
};

/** Fast: a split bolt, cut in two with a gap like the gaps between the Canopy mark's tiers. */
export function Bolt({ className }: { className?: string }) {
  return (
    <svg viewBox="4 1 16 30" fill="currentColor" className={className} aria-hidden>
      <path d="M17 1.5 H11.5 Q10.6 1.5 10.2 2.3 L5.6 11.6 Q5.2 12.5 6.2 12.5 H10.4 Z" />
      <path d="M5.4 14 H17.8 Q18.8 14 18.2 14.9 L9.4 29.6 Q8.8 30.6 8.9 29.4 L10.6 19.2 H6.2 Q5 19.2 5.5 18.1 Z" />
    </svg>
  );
}

/** Code Mode: a pair of braces, in the bolt's rounded hand. */
export function Braces({ className }: { className?: string }) {
  return (
    <svg viewBox="1 1 22 22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M9 3.5 H8.2 Q5.6 3.5 5.6 6.1 V9.4 Q5.6 12 3 12 Q5.6 12 5.6 14.6 V17.9 Q5.6 20.5 8.2 20.5 H9" />
      <path d="M15 3.5 H15.8 Q18.4 3.5 18.4 6.1 V9.4 Q18.4 12 21 12 Q18.4 12 18.4 14.6 V17.9 Q18.4 20.5 15.8 20.5 H15" />
    </svg>
  );
}

/** Permission mode for a chat (the main one unless a pane's store is given). */
/** You picked a mode (the menu, the palette, a command, the shortcut). Its card shows for this one (composer.tsx). */
export function setMode(v: string, store: Store = mainStore) {
  const from = store.meta.mode;
  notePlanMode(store, from, v); // entering Plan remembers where from: Build it goes back there
  choices.mode = v; store.setMeta({ mode: v }); store.set('permissionMode', v);
  if (from !== v) { feature('mode_changed'); window.dispatchEvent(new CustomEvent('canopy:mode-picked', { detail: { store, mode: v } })); }
}

// A Claude chat on a model the picker does not list (a name typed after /model) still has Claude Code's six effort
// stops. This is the lists' own stand-in row for "Claude, whichever model": it lends the slider those stops.
const ANY_CLAUDE = allModels([], [])[0];

type ModelInfo = ClaudeModel;
// "Opus 5.5 · Best for…" → "Opus 5.5"; "Use the default model (currently Opus 5.5) · …" → "Opus 5.5"
const shortName = (m: ModelInfo) => {
  const d = m.description ?? '';
  const cur = d.match(/currently ([^)]+)\)/);
  if (cur) return cur[1];
  const first = d.split(' · ')[0];
  return first && first.length < 24 ? first : (m.displayName ?? m.value);
};
// A row pinned to one release, read as the alias that follows its family: "claude-fable-5-2[1m]" → "fable[1m]". The
// picker can hold the pinned row for a moment before upkeep swaps it for the alias a chat was told (lib/upkeep.ts).
const aliasOf = (value: string) => { const m = /^claude-([a-z]+)-\d+(?:-\d{1,2})?(?:-\d{8})?(\[1m\])?$/.exec(value); return m ? m[1] + (m[2] ?? '') : null; };
export function modelLabel(meta: ReturnType<typeof useStore>['meta'], chosen?: string) {
  const models = claudeRows(meta);
  if (chosen) {
    const m = models.find((x) => x.value === chosen) ?? models.find((x) => aliasOf(x.value) === chosen);
    if (m) return shortName(m);
    if (!meta.model) return chosen.replace(/\[1m\]$/, '');
  }
  if (meta.model) { const m = models.find((x) => x.resolvedModel === meta.model && x.value !== 'default') ?? models.find((x) => x.resolvedModel === meta.model); if (m) return shortName(m); }
  const def = models.find((x) => x.value === 'default');
  if (def) return shortName(def);
  // An OpenAI chat's model says nothing about which Claude model is the default.
  return meta.model && meta.engine !== 'codex' ? meta.model.replace(/^claude-/, '') : 'Default';
}
/** What runs the chat, as the chip and the chat menu say it: the model's name and the effort, for the chat's own maker.
 *  `ultra`: the effort is drawn as Ultra. An OpenAI model with no effort levels has no `effort`. */
export function chatRuns(meta: ReturnType<typeof useStore>['meta'], claude: { model?: string; effort?: string; ultra?: boolean } = { model: meta.pick ?? undefined, effort: choices.effort, ultra: !!choices.ultracode }, gpt: CodexChoices = choices.codex ?? {}): { model: string; effort: string | null; ultra: boolean } {
  if (meta.engine === 'codex') {
    const row = codexRow(meta, gpt.model);
    const level = keepEffort(row, gpt.effort) ?? restingEffort(row, meta.effort);
    return { model: codexLabel(meta, gpt.model), effort: level ? effortName(level) : null, ultra: level === 'ultra' };
  }
  return { model: modelLabel(meta, claude.model), effort: claude.ultra ? 'Ultra' : EFFORT_LABEL[claude.effort || 'high'] ?? 'High', ultra: !!claude.ultra };
}

export function Controls({ part }: { part: 'model' | 'mode' }) {
  const store = useStore();
  const { meta } = store;
  const { focused } = usePane(); // slash commands drive only the focused pane's controls
  const [effort, setEffort] = useState(choices.effort ?? '');
  const [ultra, setUltra] = useState(!!choices.ultracode);
  // An OpenAI chat: its own models, effort levels and Fast. `gpt` is your OpenAI picks, as model/effort/ultra are Claude's.
  const codex = meta.engine === 'codex';
  // The Claude model is the chat's own (store `meta.pick`): another chat's pick never shows here. Effort, Fast and
  // Ultra are still your choices for every Claude chat.
  const model = codex ? choices.model ?? '' : meta.pick ?? '';
  const setModel = (v: string) => { if (!codex) store.setMeta({ pick: v || null }); };
  const [gpt, setGpt] = useState<CodexChoices>(choices.codex ?? {});
  const row = codex ? codexRow(meta, gpt.model) : null;
  // Both makers' models in one list, and the one this chat runs on: it has the menu's tick and decides the slider's
  // stops. `picks` are this chat's own (what a chat turned down is put back here, see below), in the rules' shape.
  const all = useAllModels(meta);
  const picks: Picks = { model: model || undefined, effort: effort || undefined, ultracode: ultra, codex: gpt };
  const active = chatModel(all, meta, picks);
  const tuned = active ?? (codex ? null : ANY_CLAUDE);
  // Where the slider sits. An OpenAI chat says what it runs with; a Claude chat does not, and rests on High.
  const slider = effortSlider(tuned, picks, codex ? meta.effort : null);

  const failSeen = useRef(meta.settingFailed);
  useEffect(() => {
    const f = meta.settingFailed;
    // An OpenAI pick the chat turned down (a model no longer offered, a level this model lacks) goes back to what the
    // chat kept, and is forgotten, so the next chat does not ask for it again. Once per failure: these controls are
    // rebuilt when a chat gets its first message, and an old failure must not undo a pick made since.
    if (codex) {
      if (f && f !== failSeen.current && (f.key === 'model' || f.key === 'effort')) setGpt(saveCodex({ [f.key]: (f.value as string) || undefined }));
      failSeen.current = f;
      return;
    }
    if (f?.key === 'effort') setEffort((f.value as string) || '');
    // Claude Code can't run Code Mode here: don't carry the choice into every new chat.
    if (f?.key === 'codeMode' && !f.value) choices.codeMode = false;
  }, [meta.settingFailed]);

  const mode = MODES.find((m) => m.value === (meta.mode ?? 'default')) ?? MODES[0];
  const risky = mode.value === 'bypassPermissions' || mode.value === 'auto';
  // The toggle is your choice, never Claude Code's per-request report (which says off/cooldown when Fast briefly
  // can't serve, and used to flip the toggle under you). The bolt dims while Fast is paused or blocked.
  // An OpenAI chat: on is the faster tier, off is standard, and unset is your own Codex setting (which may already be
  // a fast one: then the chat says so and the bolt is lit). A model with no faster tier has no Fast to turn on.
  // Fast is greyed, and the bolt hidden, on a model without it. Your choice is kept for when you switch back.
  // A Claude chat: the model it is on (your pick, else what it runs, else the default) and whether Claude Code says
  // it has Fast (`Model.fast`, lib/model-rules.ts); a pick the picker does not list by name is read by what the chat
  // reports. An OpenAI chat: what Codex says of the model.
  const onModel = codex ? active : active ?? chatModel(all, meta, { ...picks, model: undefined });
  const gptNoFast = codex && row?.supportsFastMode === false;
  const noFast = gptNoFast || (!codex && !!onModel && !onModel.fast);
  const fastOn = codex
    ? !gptNoFast && (meta.fastPref ?? (typeof gpt.fast === 'boolean' ? gpt.fast : meta.fastState === 'on'))
    : meta.fastPref ?? (typeof choices.fast === 'boolean' ? choices.fast : meta.fastState === 'on' || meta.fastState === 'cooldown');
  const fastShown = fastOn && !noFast;
  const fastPaused = fastOn && (meta.fastState === 'cooldown' || (meta.fastState === 'off' && !!meta.fastReason && meta.fastReason !== 'sdk_opt_in_required'));
  const fastPending = meta.fastReason === 'pending';
  const fastBlocked = meta.fastReason && meta.fastReason !== 'sdk_opt_in_required' ? FAST_REASONS[meta.fastReason] ?? meta.fastReason : null;
  const fastTitle = noFast ? `Fast isn't available for ${onModel?.label ?? 'this model'}`
    : fastBlocked && !fastOn ? fastBlocked : fastOn ? 'Fast mode is on' : 'Faster replies, same model';

  // Code Mode is on by default and lives in Settings, not here; /codemode still toggles it through this control.
  // The switch is your choice for new chats. A chat that has started keeps the tools it started with (a tool that
  // comes or goes makes Claude re-read the whole chat at full price), so the switch never shows one chat's own state.
  const codeOn = !!choices.codeMode;
  const codeBlocked = codeOn ? null : meta.codeBlocked;

  // Every setter saves the choice for its maker. It reaches this chat only when the chat is that maker's (`live`):
  // Settings can change the other maker's default from inside any chat, and Ultra's orchestration and Code Mode are
  // Claude Code's, never sent to an OpenAI chat.
  const setFast = (next: boolean) => { if (codex) setGpt(saveCodex({ fast: next })); else choices.fast = next; store.setMeta({ fastPref: next }); store.set('fast', next); };
  // The chat is told too: one that has not started yet takes the choice, a started one answers that it keeps its own.
  const setCode = (next: boolean) => { choices.codeMode = next; store.set('codeMode', next); };
  const setClaudeEffort = (v: string, live = !codex) => { setEffort(v); choices.effort = v || undefined; if (live) store.set('effort', v); };
  const setGptEffort = (v: string, live = codex) => { setGpt(saveCodex({ effort: v || undefined })); if (live) store.set('effort', v); };
  const pickEffort = (v: string) => (codex ? setGptEffort(v) : setClaudeEffort(v));
  /** A Claude model, with no word on whose pick it is (upkeep moving a saved pick to its family's newest): saved, and
   *  applied when this is a Claude chat. It never changes which maker new chats start on. */
  const pickModel = (v: string, from?: string[]) => {
    choices.model = v || undefined;
    if (codex || (from && !from.includes(meta.pick ?? ''))) return; // upkeep's move reaches only a chat on the old row
    setModel(v); store.set('model', v);
  };
  /** You picked a model row. The same maker's switches this chat, live. The other maker's is saved as where new chats
   *  start, and the window is asked for a chat of that maker here: one that has not started changes in place, and a
   *  started one is moved there, carrying what it was about (not while it is working: then nothing is changed).
   *  `stay` (Settings): only the default changes, no chat is opened. `label`: the row's name, when the caller has it. */
  const pick = (engine: Engine, v: string, stay = false, label?: string) => {
    const leaving = engine !== meta.engine && !(stay && store.started);
    const move = leaving ? canMove(store) : 'no';
    if (move === 'busy') { toast(MOVE_BUSY, { id: 'move-busy' }); return; }
    const from = chatRuns(meta, { model, effort, ultra }, gpt).model; // this chat's model, before the pick is saved
    choices.engine = engine === 'codex' ? 'codex' : undefined;
    if (engine === 'codex') setGpt(saveCodex({ model: v || undefined }));
    else choices.model = v || undefined;
    if (engine === meta.engine) { setModel(v); store.set('model', v); }
    else if (move === 'ok') void moveChat(store, label ?? rowLabel(all, engine, v), from);
    else if (leaving) window.dispatchEvent(new Event('canopy:other-maker'));
  };
  const setUltracode = (on: boolean, live = !codex) => {
    setUltra(on); choices.ultracode = on; if (live) store.set('ultracode', on);
    if (on) setClaudeEffort('max', live);
  };
  /** A stop of the scale for this chat (`null`: none, the model's own default). Ultra is the one stop the makers
   *  switch on differently: Claude Code's is standing orchestration at max effort, Codex's its own level. */
  const setLevel = (level: Effort | null) => {
    const s = effortSettings({ maker: engineMaker(meta.engine) }, level);
    if (s.ultracode) { setUltracode(true); return; }
    if (!codex && ultra) setUltracode(false);
    pickEffort(s.effort);
  };
  /** A stop was chosen on the slider. The stop with the ring is the model's own default: choosing it means "follow
   *  the model", which saves nothing (`chosenLevel`). With nothing chosen already, that is nothing to do. */
  const chooseLevel = (level: Effort) => {
    if (!slider) return;
    const next = chosenLevel(tuned, level, slider.isDefault ? slider.stops[slider.index] : null);
    if (next || !slider.isDefault) { feature('effort_changed'); setLevel(next); }
  };

  // Slash commands (/model, /effort, /fast, /permissions…) drive these controls through window events,
  // so the chips always reflect what was set.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = (e: Event) => { if (focused && (e as CustomEvent<string>).detail === part) setOpen(true); };
    const onControl = (e: Event) => {
      if (part !== 'model' || !focused) return;
      // `engine`: whose setting this is (Settings and /model say; nothing said means this chat's maker).
      const detail = (e as CustomEvent<{ key: string; value: unknown; engine?: Engine; stay?: boolean; handled?: boolean; from?: string[] }>).detail;
      const { key, value, engine, stay, from } = detail;
      // Tell the sender a composer took it. With none on screen (Home), Settings saves the choice itself (lib/models.ts).
      detail.handled = true;
      if (key === 'effort' || key === 'ultracode') feature('effort_changed'); else if (key === 'fast') feature('speed_changed');
      const whose = engine ?? meta.engine;
      if (key === 'model') { if (engine) pick(engine, String(value ?? ''), !!stay); else pickModel(String(value ?? ''), from); }
      else if (key === 'effort') {
        if (whose === 'codex') setGptEffort(String(value ?? ''));
        else { if (ultra) setUltracode(false); setClaudeEffort(String(value ?? '')); }
      }
      else if (key === 'fast') {
        if (whose === meta.engine) setFast(value == null ? (codex ? !fastOn : !(meta.fastState === 'on' || meta.fastState === 'cooldown')) : !!value);
        else if (whose === 'codex') setGpt(saveCodex({ fast: !!value }));
        else choices.fast = !!value;
      }
      else if (key === 'ultracode') setUltracode(value == null ? !ultra : !!value);
      else if (key === 'codeMode') { if (!codeBlocked) setCode(value == null ? !codeOn : !!value); }
    };
    window.addEventListener('canopy:open-menu', onOpen);
    window.addEventListener('canopy:control', onControl);
    return () => { window.removeEventListener('canopy:open-menu', onOpen); window.removeEventListener('canopy:control', onControl); };
  });

  // The lists are main's, and cheap to ask for: look again each time the menu opens.
  useEffect(() => { if (open && part === 'model') { loadModels(); feature('model_menu_opened'); } }, [open, part]);

  const runs = chatRuns(meta, { model, effort, ultra }, gpt);
  const modelChip = (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className={cn(chip, 'pr-2 pl-2.5')}>
        <span className="text-foreground">{runs.model}</span>
        {/* A pane's one-line box (composer.tsx) is narrow: the effort word goes first, so the words have room. */}
        {runs.effort && <span key={runs.effort} className={cn('roll-in @max-[640px]/box:hidden', runs.ultra ? 'ultra-text font-medium' : 'text-muted-foreground')}>{runs.effort}</span>}
        {fastShown && (
          <span title={fastPaused ? (meta.fastState === 'cooldown' ? 'Fast is paused after a rate limit and resumes on its own' : `Fast isn't serving: ${fastBlocked ?? 'unavailable'}`) : 'Fast is on'}>
            <Bolt className={cn('h-3.5 w-auto text-foreground transition-opacity', fastPaused && 'opacity-35')} />
          </span>
        )}
        <ChevronDownIcon className="size-3 text-faint" />
      </DropdownMenuTrigger>
      {/* The other maker's rows say what picking them does, once there is a conversation to carry: the chat moves
          there, or cannot until its turn is over (`move`). The tick is on the model the chat runs (`active`), and
          picking your default in a chat that runs another model switches to it (`pickValue`). */}
      <ModelMenu open={open} all={all} active={active} engine={meta.engine} started={open && (store.started || canMove(store) !== 'no')} move={open ? canMove(store) : undefined}
        onPick={(m: Model) => {
          // Counted when the pick does something: a chat that is working can't move to the other maker (`pick` says so).
          const other = m.engine !== meta.engine;
          if (!other || canMove(store) !== 'busy') feature(other ? 'engine_changed' : 'model_changed');
          pick(m.engine, pickValue(m, picks, active), false, m.label);
        }} onClose={() => setOpen(false)}>
        <EffortFast slider={slider} onLevel={chooseLevel}
          fast={{ on: fastShown, disabled: noFast || fastPending || (!!fastBlocked && !fastOn), pending: fastPending, title: fastTitle, onChange: () => { feature('speed_changed'); setFast(!fastOn); } }} />
      </ModelMenu>
    </DropdownMenu>
  );

  // No tooltip on the mode chip (user preference): the menu itself explains each mode.
  const modeChip = (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger title={mode.label} className={cn(chip, 'px-2', risky && 'text-warn hover:bg-warn/10 hover:text-warn data-[state=open]:bg-warn/10 data-[state=open]:text-warn')}>
        <mode.icon className="size-3.5" />
        {/* In a narrow pane only the mode's icon shows; its name is in the menu and the tooltip. */}
        <span key={mode.value} className="roll-in @max-[640px]/box:hidden">{shortMode[mode.value]}</span>
        <ChevronDownIcon className={cn('size-3', risky ? 'opacity-70' : 'text-faint')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel className="flex items-center">
          Permissions<Kbd className="ml-auto normal-case tracking-normal">⇧⇥</Kbd>
        </DropdownMenuLabel>
        {MODES.map((m, i) => {
          const warn = m.value === 'auto' || m.value === 'bypassPermissions';
          const active = mode.value === m.value;
          return (
            <Fragment key={m.value}>
              {i === 3 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => setMode(m.value, store)} className={cn('items-center gap-2.5 py-1.5', active && 'bg-accent/60')}>
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline',
                  warn ? 'bg-warn/10 text-warn' : active ? 'bg-background text-foreground' : 'text-muted-foreground')}>
                  <m.icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className={cn('block truncate', active && 'font-medium')}>{m.label}</span>
                  <span className="block truncate text-micro text-muted-foreground">{m.hint}</span>
                </span>
                {active && <CheckIcon className="size-3.5 shrink-0 text-foreground" />}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return part === 'model' ? modelChip : modeChip;
}

export const fmtTok = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : `${n}`);

/** Small ring showing how full the context window is. Exact numbers on hover; click opens Stats (same as /context). */
export function ContextRing({ pct, used, max }: { pct: number | null; used?: number | null; max?: number | null }) {
  // The plan's usage limits, one line each under the context reading. The ring's colour stays about context only.
  const limits = limitLines(useStore().meta.limits);
  if (pct == null) return null;
  const r = 6.5, c = 2 * Math.PI * r, v = Math.min(100, Math.max(0, pct));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`Context: ${Math.round(v)}% used`} onClick={() => ui.openTab('stats')}
          className="chip flex size-8 items-center justify-center rounded-full hover:bg-accent">
          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 -rotate-90">
            <circle cx="8" cy="8" r={r} className="fill-none stroke-foreground/15 stroke-2" />
            {v > 0 && <circle cx="8" cy="8" r={r} className={cn('fill-none stroke-2', v > 80 ? 'stroke-warn' : 'stroke-muted-foreground')} strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />}
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-center gap-0 text-center">
        <div className="font-medium tabular-nums">{used != null && max ? `${fmtTok(used)} of ${fmtTok(max)} tokens` : 'Context window'}</div>
        <div className="text-muted-foreground tabular-nums">{Math.round(v)}% used{max && used != null ? ` · ${fmtTok(Math.max(0, max - used))} left` : ''}</div>
        {limits.map((l) => <div key={l.id} className="text-muted-foreground tabular-nums">{l.text}</div>)}
      </TooltipContent>
    </Tooltip>
  );
}

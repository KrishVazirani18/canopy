// Settings > Models.
//
//   In the menu            the four model rows of the menu under the message box, in their order. Drag one up or
//                          down to reorder them.
//   More models            every other model, one card per maker, which starts with the maker's mark, its name and
//                          how it is signed in. Drag one onto a row of the four and it takes that row; drag one of
//                          the four down onto a model here and that model takes its row. With OpenAI's models not
//                          there to pick (Codex missing, signed out or not answering), its card is that line and
//                          one quiet row that says what to do.
//   New chats start with   the model, effort and Fast every new chat begins on.
//
// Nothing is worked out here. Which four rows are the menu's, what a drag does and saves, the search, the effort
// stops and the status lines are all lib/models.ts (and lib/model-rules.ts behind it), and the dragging itself is
// model-drag.tsx: the same rules and the same hands the menu uses, so the two cannot disagree. "New chats start
// with" writes through `newChats`, which asks the composer to make the change: it also switches the chat you are in
// when that chat is the same maker's, and the chip under the message box and this page always show the same thing.
//
// Sections, rows, the switch, the menu and the search field are Settings' own (settings/kit.tsx), like every page's.
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRightIcon, GripVerticalIcon, LogInIcon } from 'lucide-react';
import { api, type EnvInfo } from '@/lib/api';
import { signInToCodex } from '@/lib/codex-login';
import { loadModels } from '@/lib/engines';
import {
  MAKERS, MAKER_NAME, OPENAI_SETUP_URL, arrangeModels, chosenLevel, effortSlider, makerEngine, modelKey, newChats, pickedFast, searchModels, splitMenu, startsWith,
  useAllModels, useChoices, useMakerStatus, useSavedModels,
  type Maker, type MakerStatus, type Model, type Picks,
} from '@/lib/models';
import { isNew } from '@/lib/release-rules';
import { useReleases } from '@/lib/releases';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { EffortSlider } from './effort-slider';
import { MakerLogo, ModelLogo } from './maker-logo';
import { useModelDrag, type ModelDrag } from './model-drag';
import { Page, Row, SearchField, Section, Select, Status, Switch } from './settings/kit';

// The marks sit in one narrow column, so a maker's name and its models' names start at the same place.
const markColumn = 'flex w-4 shrink-0 justify-center';

/**
 * One line about a model, under its name. Claude Code's descriptions start with the name and may end with a price
 * ("Opus 5.5 · Best for everyday, complex tasks · $5/$25 per Mtok"): the name is already on the row, and the price
 * is not what you choose a menu row by. Nothing left to say: no line.
 */
function about(model: Model): string {
  const parts = model.description.split(' · ').map((p) => p.trim()).filter((p) => p && p !== model.label && !/\$\d/.test(p));
  return (parts[0] ?? '').replace(/\.$/, '');
}

/**
 * New chats start on a model that is not in the lists (one typed with /model, or one no longer offered). It is still
 * named, as General always named it. A Claude one keeps Claude's usual stops and Fast; an OpenAI one has no stops to
 * show until Codex lists it.
 */
function unlisted(all: Model[], maker: Maker, picks: Picks): Model {
  const id = (maker === 'openai' ? picks.codex?.model : picks.model) ?? '';
  const like = maker === 'claude' ? all.find((m) => m.maker === 'claude') : undefined;
  return {
    key: modelKey(maker, id), id, maker, engine: makerEngine(maker), label: id || 'Default', description: '', isDefault: false,
    efforts: like?.efforts ?? [], defaultEffort: like?.defaultEffort ?? null, fast: true, family: id, version: null, resolved: null,
  };
}

// ---------- in the menu, and more models ----------

/**
 * A model that can be dragged. `at`: its place among the menu's four, or `'more'` for any other model. The four show
 * their grip all the time (they are a list you order); another model shows it under the pointer.
 */
function ModelRow({ model, at, drag, fresh = false }: { model: Model; at: number | 'more'; drag: ModelDrag; fresh?: boolean }) {
  const line = about(model);
  const place = at === 'more' ? { 'data-model-more': model.key } : { 'data-model-row': at };
  return (
    <div {...place} {...drag.grab(model)}
      className={cn('group flex min-h-12 cursor-grab items-center gap-3 px-4 py-2 select-none',
        drag.dragging === model.key && 'bg-accent/50 ring-1 ring-inset ring-foreground/25 [&>*]:opacity-35', drag.onto === model.key && 'bg-accent/70')}>
      <GripVerticalIcon aria-hidden className={cn('size-4 shrink-0 text-faint', at === 'more' && 'opacity-50 group-hover:opacity-100')} />
      <span className={markColumn}><ModelLogo model={model} className="text-muted-foreground" /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui">
          {model.label}{model.maker === 'claude' && model.isDefault && model.id !== '' && <span className="ml-1.5 text-small text-faint">Default</span>}
          {fresh && <span className="ml-1.5 text-small text-faint">New</span>}
        </div>
        {line && <div className="truncate text-small text-muted-foreground">{line}</div>}
      </div>
    </div>
  );
}

/** One maker's section: its models that are not in the menu, how it is signed in beside its title, and when its models
 *  can't be listed, the one row that says how to get them. */
function MakerSection({ status, models, drag, fresh }: { status: MakerStatus; models: Model[]; drag: ModelDrag; fresh: (m: Model) => boolean }) {
  return (
    <Section title={`More ${status.name} models`} count={models.length || undefined}
      aside={status.fixedList ? <Status tone="attention">On a fixed model list</Status> : status.line && <Status tone={status.setup ? 'attention' : 'ok'}>{status.line}</Status>}>
      {/* Codex is set to list a file's models (model_catalog_json): nothing newer can arrive until that changes. The
        file is the user's (another app may have written it), so Canopy shows it and changes nothing. */}
      {status.fixedList && (
        <Row label="New OpenAI models won’t show up" detail="Your Codex settings point to a model list file (model_catalog_json)"
          onClick={() => { void api.reveal(status.fixedList!); }} opens="outside" action="Show file" title={status.fixedList}
          lead={<span className={markColumn}><MakerLogo maker={status.maker} className="size-4 text-muted-foreground" /></span>} />
      )}
      {models.map((m) => <ModelRow key={m.key} model={m} at="more" drag={drag} fresh={fresh(m)} />)}
      {status.setup && (
        // Opens the maker's own page in the browser (main hands every opened window to the browser). The models
        // show up here on their own once Codex lists them, so there is nothing to refresh. With Codex here and
        // nobody signed in, the row starts Codex's own sign-in instead.
        <Row label={status.setup} detail={status.hint} onClick={() => (status.signIn ? signInToCodex() : window.open(OPENAI_SETUP_URL))}
          lead={<span className={markColumn}><MakerLogo maker={status.maker} className="size-4 text-muted-foreground" /></span>}>
          {status.signIn ? <LogInIcon className="size-4 text-muted-foreground" /> : <ArrowUpRightIcon className="size-4 text-muted-foreground" />}
        </Row>
      )}
    </Section>
  );
}

function InTheMenu({ env, all, typed, children }: { env: EnvInfo | null; all: Model[]; typed: string; children?: React.ReactNode }) {
  const saved = useSavedModels();
  const statuses = useMakerStatus(env);
  // "New" beside a model for a week after it arrived (lib/release-rules.ts).
  const releases = useReleases();
  const fresh = (m: Model) => isNew(releases, m, Date.now());
  const { rows, more } = useMemo(() => splitMenu(all, saved), [all, saved]);
  const drag = useModelDrag({ rows, all, onArrange: (next) => arrangeModels(next, all) });
  const searching = typed.trim() !== '';
  // The search decides which of the other models are listed; inside a card they keep the maker's own order.
  const found = useMemo(() => new Set(searchModels(all, typed).map((m) => m.key)), [all, typed]);
  const cards = statuses
    .map((status) => ({ status, models: more.filter((m) => m.maker === status.maker && found.has(m.key)) }))
    // While searching, a card with no match is not drawn. Otherwise a maker has its card even with every one of its
    // models in the menu, or none to offer: it is where its sign-in line and "Set up OpenAI models" are.
    .filter((c) => c.models.length > 0 || (!searching && (!!c.status.setup || !!c.status.line || !!c.status.fixedList)));
  return (
    <>
      {/* The four as they would be if the row being dragged were let go now. */}
      <Section title="In the menu" footer="Drag to reorder, or drag a model from below onto one to swap it in. Newer versions replace older ones on their own.">
        {drag.rows.map((m, i) => <ModelRow key={m.key} model={m} at={i} drag={drag} fresh={fresh(m)} />)}
      </Section>
      {children}
      {/* These rows stay where they are while a row is dragged: only the four above show where it will land. */}
      {cards.map((c) => <MakerSection key={c.status.maker} status={c.status} models={c.models} drag={drag} fresh={fresh} />)}
      {searching && cards.length === 0 && <p className="px-1 text-small text-faint">No models match “{typed.trim()}”</p>}
      {drag.layer}
    </>
  );
}

// ---------- new chats start with ----------

function NewChats({ all }: { all: Model[] }) {
  const { meta } = useStore();
  const choices = useChoices(); // the live object: read off it on every render, never keep it
  const s = startsWith(all, choices);
  const model = s.model ?? unlisted(all, s.maker, choices);
  // Read off `model`, not `s`: a model that is not listed still has the Fast you chose for its maker.
  const fast = pickedFast(model, choices);
  const both = MAKERS.every((maker) => all.some((m) => m.maker === maker));
  // The chat on screen, when it is this maker's: what it runs with stands in for what you have not chosen.
  const sameMaker = (meta.engine === 'codex') === (s.maker === 'openai');
  // An OpenAI chat says which effort it runs with (your own Codex setting, when you chose none here).
  const slider = effortSlider(model, choices, sameMaker && s.maker === 'openai' && meta.model === model.id ? meta.effort : null);
  const fastOn = model.fast && (fast ?? (sameMaker && (meta.fastState === 'on' || (s.maker === 'claude' && meta.fastState === 'cooldown'))));
  return (
    <Section title="New chats start with"
      footer={both ? 'Also switches the chat you’re in. Picking the other maker’s model under the message box moves the chat there.' : 'Also switches the chat you’re in.'}>
      <Row label="Model">
        {/* A model no longer listed (or typed with /model) is still named, so the menu always shows what new chats use. */}
        <Select label="Model" value={model.key} width="w-64" lead={<ModelLogo model={model} className="size-3.5 text-muted-foreground" />}
          onChange={(key) => { const m = all.find((x) => x.key === key); if (m) newChats.setModel(m); }}
          options={[
            ...(s.model ? [] : [{ value: model.key, label: model.label }]),
            ...MAKERS.flatMap((maker) => all.filter((m) => m.maker === maker).map((m, i) => ({
              value: m.key, label: m.label, lead: <ModelLogo model={m} className="size-3.5" />,
              detail: m.maker === 'claude' && m.isDefault && m.id !== '' ? 'Default' : undefined,
              heading: both && i === 0 ? MAKER_NAME[maker] : undefined,
            }))),
          ]} />
      </Row>
      {/* A model brings its own stops; one with a single level or none has no slider to show. As in the menu there
          is no Reset: the stop with the ring is the model's own default, and choosing it follows the model. */}
      {slider && (
        <div className="px-4 pt-3 pb-2">
          <div className="text-ui">Effort</div>
          <div className="mt-1">
            <EffortSlider labels={slider.labels} index={slider.index} isDefault={slider.isDefault} ultraAt={slider.ultraAt} defaultAt={slider.defaultAt}
              onChange={(i) => {
                const level = slider.stops[i];
                if (!level) return;
                const next = chosenLevel(model, level, slider.isDefault ? slider.stops[slider.index] : null);
                if (next || !slider.isDefault) newChats.setEffort(model, next);
              }} />
          </div>
        </div>
      )}
      <Row label="Fast mode" detail={model.fast ? 'Quicker replies from the same model' : `Fast isn’t available for ${model.label}`}>
        <Switch label="Fast mode" on={fastOn} disabled={!model.fast} onChange={(v) => newChats.setFast(model, v)} />
      </Row>
    </Section>
  );
}

// ---------- the page ----------

/** `part`: 'defaults' is what new chats start with (on Chats); 'menu' the menu's models (Advanced → Model menu). */
export function ModelsPage({ env, part }: { env: EnvInfo | null; part?: 'defaults' | 'menu' }) {
  const { meta } = useStore();
  const all = useAllModels(meta);
  // The search finds models outside the menu, to drag one in or see what's there.
  const [typed, setTyped] = useState('');
  // The lists are main's, and cheap to ask for: look again each time the page opens (Codex may have been set up since).
  useEffect(() => { loadModels(); }, []);
  return (
    part === 'defaults' ? <NewChats all={all} /> : (
      <Page title="Model Menu" toolbar={<SearchField value={typed} onChange={setTyped} placeholder="Search models" />}>
        <InTheMenu env={env} all={all} typed={typed}>{part === 'menu' ? null : <NewChats all={all} />}</InTheMenu>
      </Page>
    )
  );
}

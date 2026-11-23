// Turns Canopy events into a conversation model the UI renders.
// Items are mutated in place and carry a `rev` counter; any change bumps the
// item and its ancestors so memoized components re-render precisely.
// Notifications are batched to one per animation frame so streaming is smooth.
import { createContext, useContext, useSyncExternalStore } from 'react';
import { api, type Answer, type CanopyEvent, type EarlierReply, type EditPreview, type EditReply, type EditRequest, type Engine, type ImageAttachment, type QueueReply } from './api';
import { signInNotice, type NoticeAction } from './account-rules';
import { cutItems, isBoundary, passesCut, toolsIn, turnsIn } from './edit';
import { planEventRule, type PlanItem } from './plan';
import { OUTPUT_CAP, appendOutput } from './tail';
import { feature } from './telemetry';
import { applyModelFixups } from './upkeep';
import { claudeRows, openaiRows } from './engines';
import { modelName } from './model-name';
import { brandKey, catalogBrands, toolIcons, type ToolBrand, type ToolBrands, type ToolIcon } from './tool-branding';

export type QueuedMessage = { id: number; text: string; images: ImageAttachment[] };
/** One of the plan's usage limits, in the one shape both makers' chats report (src/core/limits.mjs). */
export type Limit = { id: string; name: string; usedPercent: number; resetsAt: number | null };
/** What a chat says about how full it is: the context reading, and the plan's limits when it knows them. */
export type ContextReading = { totalTokens: number; maxTokens: number; percentage: number; limits?: Limit[] };

type Base = { key: string; rev: number; parent?: ToolItem; hist?: boolean; at: number };
export type UserItem = Base & {
  t: 'user'; text: string; images: number; steered?: boolean; thumbs?: { mediaType: string; data: string }[];
  /** The message's id in the saved conversation: what Edit cuts back to. Without one it can't be edited. */
  uuid?: string;
  /** Not words you typed to Claude: a /command, a ! shell line, or something that spoke in your place. */
  fixed?: boolean;
  /** Another of your chats sent this one the message: that chat's name ('' when it gave none). */
  peer?: string;
  /** A fingerprint of that chat's address (a reply is sent to the address): matches a reply's `to` to the name above. */
  peerAddr?: string;
  /** Its send failed, so it never reached Claude Code. */
  unsent?: boolean;
};
export type AssistantItem = Base & { t: 'assistant'; text: string; model?: string; streaming: boolean; streamed?: boolean };
export type ThinkingItem = Base & { t: 'thinking'; text: string; streaming: boolean };
export type ToolStatus = 'running' | 'approval' | 'done' | 'error';
/** One call a Code Mode script made (an MCP tool, or its own read/glob/grep), as the engine reports it live. */
export type CodeCall = {
  id: number; name: string; input: Record<string, unknown>; status: 'running' | 'approval' | 'ok' | 'denied' | 'error';
  ms?: number; note?: string; error?: string;
  icons?: ToolIcon[];
};
export type ToolItem = Base & {
  t: 'tool'; id: string; name: string; input: Record<string, unknown>;
  status: ToolStatus; result?: string; isError?: boolean; elapsed?: number; children: Item[];
  icons?: ToolIcon[];
  /** Pictures the tool handed back (a look screenshot). A saved chat keeps those of its latest few steps (adapter.mjs) and the words of the rest. */
  images?: { mediaType: string; data: string }[];
  /** Code Mode only: the calls its script has made so far. Live only: a saved chat keeps the script and its result. */
  calls?: CodeCall[];
  /** Its input is still being written (a widget drawing itself): `input` is what has arrived so far. */
  streaming?: boolean;
  /** The turn ended while its input was still being written: `input` is all there will ever be. */
  cut?: boolean;
  /** What a running command has printed so far (the end of it, at most OUTPUT_CAP characters). Only while it runs:
   *  its result replaces it. An OpenAI chat's commands only; Claude Code sends no output until a command is done. */
  output?: string;
  /** The engine's number for the newest chunk in `output`, so one sent again after a chat reopens is not added twice. */
  outputSeq?: number;
};
export type PermissionItem = Base & { t: 'permission'; ev: CanopyEvent; resolved: boolean };
export type TaskInfo = {
  taskId: string; status: 'running' | 'pending' | 'completed' | 'failed' | 'stopped' | string; description?: string; summary?: string;
  taskType?: string; agentType?: string; lastTool?: string; activity?: string; toolUseId?: string; startedAt?: number; endedAt?: number; error?: string;
  backgrounded?: boolean; workflow?: string | null; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
};
export type NoticeItem = Base & { t: 'notice'; text: string; level?: 'warn'; detail?: string;
  /** One button: send a prompt, or open the maker's sign-in (account-rules.ts). */ action?: NoticeAction;
  /** The conversation was summarized or cleared here: messages above it can no longer be edited. */ boundary?: boolean;
  /** The dot's colour: error (red), warn (amber), good (green), info (grey). */ tone?: 'error' | 'warn' | 'good' | 'info';
  /** The sentence is Canopy talking about itself: show the wordmark where it says "Canopy". */ brand?: boolean };
export type ErrorItem = Base & { t: 'error'; message: string; stderr?: string };
export type CmdItem = Base & { t: 'cmd'; text: string };
export type NoteItem = Base & { t: 'note'; text: string };
export type TurnItem = Base & { t: 'turn'; ev: CanopyEvent };
export type RawItem = Base & { t: 'raw'; label: string; raw: unknown };
/** Where a chat switched maker (`ev.dir` 'switch'): "Canopy switched from … → …", drawn above the turn after it, and
 *  a wall no edit reaches past (lib/edit.ts). Not content: see handoff-line.tsx. */
export type HandoffItem = Base & { t: 'handoff'; ev: CanopyEvent };
export type Item = UserItem | AssistantItem | ThinkingItem | ToolItem | PermissionItem | NoticeItem | ErrorItem | CmdItem | NoteItem | TurnItem | RawItem | HandoffItem;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dist<T> = T extends any ? Omit<T, 'key' | 'rev' | 'parent' | 'at'> : never;

export type Meta = {
  busy: boolean; sessionId: string | null; mode: string | null; model: string | null;
  /** The Claude model this chat was told to run (a picker row's value); null: Claude Code's own default. Each chat
   *  has its own: picking a model in one chat never relabels or switches another. */
  pick: string | null;
  /** Which engine runs this chat: from the open reply, and from the chat's own `init` and `meta` when they say.
   *  It decides whose models, effort levels and Fast the composer shows; it is never named on screen. */
  engine: Engine;
  /** The account this chat is on, as main says it: an account's id, or null for the login its tool finds on its own.
   *  Left out until main has said (a chat still opening): it then counts as a new chat (account-rules.ts `chatAccount`).
   *  A chat keeps its account once it has a conversation; one nobody has used yet moves when another is chosen. */
  accountId?: string | null;
  /** An OpenAI chat's effort as it reports it (your pick, else what it runs with). Claude chats do not report one. */
  effort: string | null;
  cost: number | null; ctx: number | null; ctxTokens: number | null; ctxMax: number | null; status: string;
  fastState: string | null; fastReason: string | null; suggestion: string | null;
  /** Your Fast choice (what the toggle shows). fastState is what Claude Code reports per request: on, off, or cooldown. */
  fastPref: boolean | null;
  /** Whether this chat has Code Mode, as the chat itself says (fixed once it has started; the switch shows your
   *  choice for new chats instead), and why Claude Code can't run it here, if it can't. */
  codePref: boolean | null;
  codeBlocked: string | null;
  commands: { name: string; description?: string; argumentHint?: string }[];
  models: { value: string; displayName?: string; description?: string }[];
  lastPrompt: { text: string; images: unknown[] } | null;
  loading: boolean;
  queue: QueuedMessage[];
  stats: { cost: number; workMs: number; turns: number; started: number | null };
  settingFailed: { key: string; value: unknown; n: number } | null;
  /** Agents and background commands in this chat, live (core's task model): the agents drawer. */
  tasks: TaskInfo[];
  /** Counts the messages you sent yourself (not queued ones going out on their own): the transcript jumps to the bottom on each. */
  sends: number;
  /** A very long chat opened from its newest turns: where its older ones begin (what "Show earlier" asks for).
   *  Unset when everything there is has been loaded, which is every Claude chat (they are read whole). */
  earlier?: { cursor: string };
  /** The plan's usage limits as the chat last reported them (the ring's hover, and Stats). Unset until it has; empty
   *  for a login with none (an API key on either side). */
  limits?: Limit[];
};

const emptyMeta = (): Meta => ({
  busy: false, sessionId: null, mode: null, model: null, pick: null, engine: 'claude', effort: null, cost: null, ctx: null, ctxTokens: null, ctxMax: null, status: '',
  fastState: null, fastReason: null, fastPref: null, codePref: null, codeBlocked: null, suggestion: null, commands: [], models: [], lastPrompt: null, settingFailed: null, tasks: [], loading: false, queue: [], sends: 0, stats: { cost: 0, workMs: 0, turns: 0, started: null },
});

// A few engine notices are reworded here, at the one place they enter the UI: the fixed prefixes the adapters keep
// ('Rate limited', 'Auth: '), the frozen compaction notice, and sentences that name a setting by its key or say
// "could not". Everything else an engine says arrives in its final words, the same from either maker's chat.
/** The live status while Claude condenses a long chat ("compacting"). The status line knows it by this text and draws it
 *  with a plain explanation underneath. */
export const COMPACTING_STATUS = 'Making room to keep going';
const SETTING_NOUN: Record<string, string> = { permissionMode: 'permissions', model: 'the model', effort: 'effort', fast: 'fast mode', ultracode: 'Ultra', codeMode: 'Code Mode' };
export function rewriteNotice(text: string): string {
  if (typeof text !== 'string') return text;
  if (text.startsWith('Rate limited')) return 'Rate limited. Retrying shortly.';
  if (text.startsWith('Auth: ')) return 'Claude Code needs you to sign in again.';
  if (text.startsWith('Bypass permissions is not enabled')) return 'Full Access is off for this chat. Turn on bypass permissions in Claude Code settings first.';
  if (text === 'Conversation compacted') return 'Made room to keep going: Claude now remembers the earlier part of this chat as a short summary';
  if (text.startsWith('Interrupt failed')) return 'Couldn’t stop. Try again.';
  let m = text.match(/^Could not change (\w+): ([\s\S]*)$/);
  if (m) return `Couldn’t change ${SETTING_NOUN[m[1]] ?? m[1]}: ${m[2]}`;
  m = text.match(/^(Claude Code|Codex) could not start([\s\S]*)$/);
  if (m) return `${m[1]} couldn’t start${m[2]}`;
  return text;
}

// A turn-end's `cost` is Claude Code's running total for the process, so adding it up per turn
// overcounts. Use the turn's own cost, or failing that the rise in the total since the last turn.
function costOfTurn(ev: CanopyEvent, lastTotal: number): number {
  if (Number.isFinite(ev.turnCost)) return ev.turnCost;
  if (!Number.isFinite(ev.cost)) return 0;
  return ev.cost >= lastTotal ? ev.cost - lastTotal : ev.cost; // a lower total means the process restarted
}

const GONE = 'This chat didn’t open. Close the pane and open it again.';

/** Real conversation content. Startup hook output and notices don't count: a chat with only those is still new. */
/** The steps an approval is about: its own, plus the others one answer covers (`toolUseIds`, several files in one change). */
function askedAbout(ev: CanopyEvent): string[] {
  const ids = Array.isArray(ev.toolUseIds) ? (ev.toolUseIds as unknown[]).filter((id): id is string => typeof id === 'string' && !!id) : [];
  if (typeof ev.toolUseId === 'string' && ev.toolUseId && !ids.includes(ev.toolUseId)) ids.unshift(ev.toolUseId);
  return ids;
}

export const isContent = (i: { t: string }) => i.t === 'user' || i.t === 'assistant' || i.t === 'tool' || i.t === 'permission' || i.t === 'error' || i.t === 'cmd';

export class Store {
  /** Which chat this store shows. The main window's store has none: it follows the chat on screen (main's
   *  `current`). Multi mode gives each pane its own store, bound to its chat's id (sid) and folder. */
  sid: string | null = null;
  cwd: string | null = null;
  /** A pane's store talks only to its own chat: while that chat opens, calls wait for it instead of reaching the
   *  main screen's chat (a message typed into a pane that is still opening goes to that pane's chat). */
  private readonly pane: boolean;
  private opened: Promise<void> = Promise.resolve();
  private markOpened: (() => void) | null = null;
  constructor(sid: string | null = null, cwd: string | null = null, pane = false) { this.sid = sid; this.cwd = cwd; this.pane = pane; }
  /** A pane's chat is (re)opening: calls made meanwhile wait for `bind`. */
  opening() { if (!this.markOpened) this.opened = new Promise((r) => { this.markOpened = r; }); }
  /** The pane's chat is open (or failed to open: null), so the calls that waited go ahead. */
  bind(sid: string | null) { this.sid = sid; this.markOpened?.(); this.markOpened = null; }
  private via<T>(inPane: (sid: string) => Promise<T>, onMain: () => Promise<T>, failed: T): Promise<T> {
    if (!this.pane) return onMain();
    return this.opened.then(() => (this.sid ? inPane(this.sid) : failed));
  }

  // Talking to the chat: the main store goes to the chat on screen, a pane's store to its own chat.
  send(text: string, images: ImageAttachment[], id?: string) { return this.via((sid) => api.pane!.send(sid, text, images, id), () => api.send(text, images, id), { error: GONE }); }
  private edit(opts: EditRequest): Promise<EditReply> {
    const none: EditReply = { ok: false, message: GONE };
    return this.via((sid) => api.pane?.edit?.(sid, opts) ?? Promise.resolve(none), () => api.edit?.(opts) ?? Promise.resolve(none), none);
  }
  /** The files Claude changed since your message `uuid` (what "also undo" would put back), or null. */
  editPreview(uuid: string): Promise<EditPreview> {
    const none = Promise.resolve(null);
    return this.via<EditPreview | { error: string }>((sid) => api.pane?.editPreview?.(sid, uuid) ?? none, () => api.editPreview?.(uuid) ?? none, null)
      .then((p) => (p && 'files' in p ? p : null)).catch(() => null);
  }
  /** Stop the reply. Only ever called because you pressed Stop or Esc. */
  interrupt() { feature('stop_clicked'); return this.via((sid) => api.pane!.interrupt(sid), () => api.interrupt(), undefined); }
  set(key: string, value: unknown) { return this.via((sid) => api.pane!.set(sid, key, value), () => api.set(key, value), undefined); }
  respond(id: number, answer: Answer) { return this.via((sid) => api.pane!.respond(sid, id, answer), () => api.respond(id, answer), undefined); }
  queueAdd(text: string, images: ImageAttachment[]): Promise<QueueReply> { return this.via((sid) => api.pane!.queue(sid, text, images), () => api.queue(text, images), { error: GONE }); }
  queueRemove(id: number): Promise<QueueReply> { return this.via((sid) => api.pane!.unqueue(sid, id), () => api.unqueue(id), { ok: false, removed: false, queue: [], v: 0 }); }
  queueMove(id: number, to: number): Promise<QueueReply> {
    const none: QueueReply = { ok: false, moved: false };
    return this.via((sid) => api.pane!.requeue?.(sid, id, to) ?? Promise.resolve(none), () => api.requeue?.(id, to) ?? Promise.resolve(none), none);
  }
  context() { return this.via((sid) => api.pane!.context(sid), () => api.context(), null); }
  stopTask(taskId: string) { return this.via((sid) => api.pane!.stopTask(sid, taskId), () => api.stopTask?.(taskId) ?? Promise.resolve({ ok: false }), { ok: false }); }
  /** Context usage after a turn (or once it's available after a start: retry briefly). */
  fetchContext(tries = 0) {
    this.context().then((c) => {
      if (c) this.noteContext(c);
      else if (tries > 0) setTimeout(() => this.fetchContext(tries - 1), 700);
    }).catch(() => {});
  }
  /** A reading of how full the chat is: the ring, and the plan's limits when the reading carries them (a reading
   *  without them leaves the last ones in place). */
  noteContext(c: ContextReading) {
    this.setMeta({ ctx: c.percentage, ctxTokens: c.totalTokens, ctxMax: c.maxTokens, ...(Array.isArray(c.limits) && { limits: c.limits }) });
  }

  items: Item[] = [];
  brands: ToolBrands = Object.create(null);
  brandVersion = 0;
  private learnBrands(rows: ToolBrand[]) {
    let changed = false;
    for (const { key, icons } of rows) {
      if (!key || !icons.length || JSON.stringify(this.brands[key]) === JSON.stringify(icons)) continue;
      // One chat's discovered identities stay with that chat, bounded even for a very large catalog.
      if (!Object.hasOwn(this.brands, key) && Object.keys(this.brands).length >= 1000) continue;
      this.brands[key] = icons; changed = true;
    }
    if (changed) { this.brandVersion++; this.notify(); }
  }
  meta: Meta = emptyMeta();
  version = 0;
  private seq = 0;
  private rawModels: Meta['models'] | null = null; // the picker as Claude Code sent it, before upkeep's fixups
  private tools = new Map<string, ToolItem>();
  private taskRows = new Map<string, { text: string }>(); // background-task line per task, updated in place
  private perms = new Map<number, PermissionItem>();
  private live: AssistantItem | null = null;
  private liveThinking: ThinkingItem | null = null;
  private listeners = new Set<() => void>();
  private scheduled = false;
  private replaying = false;
  private replayParents = new Set<ToolItem>(); // tools whose children a history replay is appending to in place
  /** The newest place the conversation was summarized or cleared (that item's number, 0 for none): your messages
   *  above it can't be edited. */
  wall = 0;
  /** The edit you just sent (its new message's id), until the engine's `edit` event: what arrives before that still
   *  belongs to the reply being cut off, and is not shown. */
  private cutting: string | null = null;
  /** An edit is on its way to the engine: no other message can be edited until it has landed. */
  get cutPending() { return this.cutting !== null; }
  /** Counts the chats this store has shown: an answer that arrives for a chat no longer on screen changes nothing here. */
  private shown = 0;
  /** An edit that didn't go through: what you had written, for that message's editor to open with again. The chat is
   *  read again after it, and that can give the message another id (an OpenAI chat's messages carry Canopy's id when
   *  sent and Codex's own when read back). So its place is kept too: which chat, which of your messages (`nth`, 0 for
   *  the first), and what it said. */
  private lostEdit: { uuid: string; text: string; chat: string | null; nth: number; was: string } | null = null;
  /** Puts this chat back on screen as the engine has it. Set by whoever opened the chat (App, a Multi mode pane). */
  reload: (() => void) | null = null;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;

  private notify() {
    if (this.scheduled) return;
    this.scheduled = true;
    // Animation frames pause when the window is hidden; the timer guarantees updates still land.
    // Whichever fires first cancels the other, so no flush leaves a dead frame or timer behind.
    const flush = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      this.scheduled = false;
      this.version++;
      for (const l of this.listeners) l();
    };
    const frame = requestAnimationFrame(flush);
    const timer = setTimeout(flush, 50);
  }

  private touch(item: Item) {
    let cur: Item | undefined = item;
    while (cur) { cur.rev++; cur = cur.parent; }
    this.notify();
  }

  // "Switched to Fable 5.2", a quiet line in the chat where its model changed. Live: when the chat confirms a model you
  // picked. From history: where a reply ran another model than the one before it, just above the message that
  // started it, so a reopened chat says the same.
  private toldModel: string | undefined = undefined; // the model the chat last confirmed being told ('' = its default)
  private ranModel: string | null = null;            // the model the last top-level reply ran
  private modelLabel(id: string): string {
    const engine = this.meta.engine;
    if (!id) return engine === 'codex' ? '' : modelName('claude', 'default', { claude: claudeRows(this.meta) });
    return modelName(engine, id, { claude: claudeRows(this.meta), openai: openaiRows() });
  }
  /** The model id a picked value runs: a row's own, the default row's for '', else the value itself. */
  private resolves(v: string): string {
    if (this.meta.engine === 'codex') return v;
    const rows = claudeRows(this.meta);
    return rows.find((m) => m.value === (v || 'default'))?.resolvedModel ?? v;
  }
  private switchedTo(id: string) { const name = this.modelLabel(id); return name ? `Switched to ${name}` : 'Switched to the default model'; }

  private saidSinceYou(text: string) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.t === 'user') return false;
      if (it.t === 'notice' && it.text === text) return true;
    }
    return false;
  }

  private push<T extends Dist<Item>>(data: T, parentId?: string | null): T & Base {
    const item = { ...data, key: `i${++this.seq}`, rev: 0, at: (this.replaying && this.evAt) || Date.now(), hist: this.replaying || undefined } as unknown as Item;
    const parent = parentId ? this.tools.get(parentId) : undefined;
    if (parent) item.parent = parent;
    else if (isBoundary(item)) this.wall = this.seq;
    if (this.replaying) {
      // A fresh array per event is quadratic over a long chat. Replay appends in place, to arrays
      // nothing has rendered yet; loadHistory bumps revs and notifies once at the end.
      if (!parent) this.items.push(item);
      else {
        if (!this.replayParents.has(parent)) { this.replayParents.add(parent); parent.children = [...parent.children]; }
        parent.children.push(item);
      }
    } else if (parent) { parent.children = [...parent.children, item]; this.touch(parent); }
    else { this.items = [...this.items, item]; this.notify(); }
    return item as unknown as T & Base;
  }

  setMeta(patch: Partial<Meta>) { this.meta = { ...this.meta, ...patch }; this.notify(); }
  /** The chat has started: it is saved, working, or has something in it. Picking the other maker's model in a
   *  started chat opens a new chat; in one that has not started, the chat itself changes maker. */
  get started() { return !!this.meta.sessionId || this.meta.busy || this.items.some(isContent); }
  /** Which engine runs this chat, as the open reply said. An OpenAI chat has none of Claude Code's slash commands,
   *  so the ones kept from the chat before it go now rather than when its own (empty) list arrives. */
  setEngine(engine: Engine | undefined) {
    const next: Engine = engine === 'codex' ? 'codex' : 'claude';
    this.setMeta(next === 'codex' ? { engine: next, commands: [] } : { engine: next });
  }
  /** Upkeep learned something new about the models: offer the picker again with it. */
  refreshModels() { if (this.rawModels) this.setMeta({ models: applyModelFixups(this.rawModels) }); }

  reset() {
    this.items = []; this.tools.clear(); this.perms.clear(); this.taskRows.clear();
    this.brands = Object.create(null); this.brandVersion++;
    this.live = null; this.liveThinking = null;
    this.toldModel = undefined; this.ranModel = null;
    this.wall = 0; this.cutting = null; this.shown++;
    // The queue belongs to the chat and lives in main: a chat that is still live hands it back (setQueue) when it opens.
    const keep = { commands: this.meta.commands, models: this.meta.models };
    this.queueV = 0;
    this.meta = { ...emptyMeta(), ...keep };
    this.notify();
  }

  // ---- Message queue: typed while Claude works, sent one at a time when each turn ends ----
  // Main holds it (src/chats.mjs), per chat, and sends the next message when that chat's turn ends, even if another
  // chat is on screen. `meta.queue` mirrors it for the row above the composer; `queueV` drops states that arrive late.
  private qid = 0;
  private queueV = 0;
  /** Show main's queue (from a snapshot, a reply, or a queue event), unless a newer one is already shown. */
  setQueue(queue: QueuedMessage[] | undefined, v: number | undefined) {
    const n = typeof v === 'number' ? v : 0;
    if (n < this.queueV) return;
    this.queueV = n;
    this.setMeta({ queue: Array.isArray(queue) ? queue : [] });
  }
  /** Queue the message behind Claude's current turn. It shows at once; main's answer then replaces it with the real row. */
  enqueue(text: string, images: ImageAttachment[]) {
    const temp = -(++this.qid);
    feature('message_queued');
    this.setMeta({ queue: [...this.meta.queue, { id: temp, text, images }], sends: this.meta.sends + 1 });
    this.queueAdd(text, images).then((r) => {
      if (r?.error) { this.setMeta({ queue: this.meta.queue.filter((q) => q.id !== temp) }); this.addError(r.error); }
      else this.setQueue(r?.queue, r?.v);
    }).catch(() => this.setMeta({ queue: this.meta.queue.filter((q) => q.id !== temp) }));
  }
  /** Send now. If Claude is mid-turn this steers: Claude Code folds it into the running turn. */
  dispatch(text: string, images: ImageAttachment[], steer = false, byYou = true) {
    this.setMeta({ lastPrompt: { text, images }, suggestion: null, sends: this.meta.sends + (byYou ? 1 : 0) });
    // The message's id is made here and sent along, so its bubble knows which saved message it is (Edit needs that).
    const id = crypto.randomUUID();
    const item = this.addUser(text, images.length, steer, images.map((i) => ({ mediaType: i.mediaType, data: i.data })), id);
    this.send(text, images, id).then((r) => { if (r?.error) { this.addError(r.error); item.unsent = true; this.touch(item); } });
  }

  // ---- Edit and resend ----
  /** Take your message `uuid` and everything after it out of the transcript and put the new message in its place. */
  private applyCut(uuid: string, id: string, text: string): boolean {
    const cut = cutItems(this.items, uuid);
    if (!cut) return false;
    // Whatever the removed items held goes with them: the reply being written, its steps, its open questions.
    this.live = null; this.liveThinking = null;
    this.items = cut.kept;
    this.tools = toolsIn(cut.kept);
    const kept = new Set<unknown>(cut.kept);
    for (const [k, p] of this.perms) if (!kept.has(p)) this.perms.delete(k);
    for (const [k, row] of this.taskRows) if (!kept.has(row)) this.taskRows.delete(k);
    // Turns counts what the transcript shows. Cost and working time stay: that work was done and paid for.
    this.setMeta({ stats: { ...this.meta.stats, turns: turnsIn(cut.kept) }, tasks: [], status: '', suggestion: null });
    this.push({ t: 'user', text, images: cut.user.images, thumbs: cut.user.thumbs, uuid: id });
    return true;
  }
  /**
   * Edit and resend: your message `uuid` and everything after it leave the chat, `text` takes its place, and Claude
   * answers that instead (a reply still being written is stopped). The transcript changes at once; if the engine
   * can't do it, the chat is put back as it was and the message's editor opens again with what you wrote.
   */
  async editFrom(uuid: string, text: string, opts: { restoreFiles?: boolean } = {}): Promise<EditReply> {
    const old = this.items.find((it): it is UserItem => it.t === 'user' && it.uuid === uuid);
    const id = crypto.randomUUID();
    const place = { chat: this.meta.sessionId, nth: old ? this.items.filter((it) => it.t === 'user').indexOf(old) : -1, was: old?.text ?? '' };
    if (!old || !this.applyCut(uuid, id, text)) return { ok: false, message: 'That message can’t be edited.' };
    feature('message_edited');
    this.cutting = id;
    const shown = this.shown;
    // "Try again" resends this message: with its images when all of them are here (history keeps only the first few).
    const images = old.thumbs?.length === old.images ? (old.thumbs as ImageAttachment[]) : [];
    this.setMeta({ busy: true, lastPrompt: { text, images }, sends: this.meta.sends + 1 });
    let r: EditReply;
    try { r = (await this.edit({ messageId: uuid, text, id, restoreFiles: opts.restoreFiles === true })) ?? { ok: false }; }
    catch (err) { r = { ok: false, message: String((err as Error)?.message ?? err) }; }
    if (r.error) r = { ok: false, message: r.error };
    if (this.cutting === id) { this.cutting = null; this.notify(); }
    if (r.ok) return r;
    // Nothing was cut. Keep the words, and show the chat as the engine has it again (unless you have moved on to
    // another chat meanwhile: then this one loads as it is when you come back to it).
    this.lostEdit = { uuid, text, ...place };
    if (this.shown !== shown) return r;
    this.setMeta({ busy: false });
    this.reload?.();
    return r;
  }
  /**
   * What you had written in an edit of message `uuid` that didn't go through (handed over once). `item` is that
   * message's bubble as it is now: when no message carries the id any more (the chat was read again and its messages
   * came back under other ids), the bubble in the same place in the same chat, saying the same thing, is the one.
   */
  takeLostEdit(uuid: string | undefined, item?: UserItem): string | null {
    const lost = this.lostEdit;
    if (!lost || !uuid) return null;
    if (uuid !== lost.uuid) {
      if (!item || lost.nth < 0 || item.text !== lost.was || (lost.chat !== null && this.meta.sessionId !== lost.chat)) return null;
      const mine = this.items.filter((it): it is UserItem => it.t === 'user');
      if (mine[lost.nth] !== item || mine.some((it) => it.uuid === lost.uuid)) return null;
    }
    this.lostEdit = null;
    return lost.text;
  }
  /** Take a message back out of the queue. Resolves false if it had already gone out. */
  async unqueue(id: number): Promise<boolean> {
    this.setMeta({ queue: this.meta.queue.filter((q) => q.id !== id) });
    try {
      const r = await this.queueRemove(id);
      this.setQueue(r?.queue, r?.v);
      return r?.removed !== false;
    } catch { return false; }
  }
  /** Move a waiting message to place `to` (0: it goes out next). Shown at once; main's answer has the last word. */
  async moveQueued(id: number, to: number) {
    const list = this.meta.queue.slice();
    const i = list.findIndex((q) => q.id === id);
    if (i < 0 || i === to) return;
    const [m] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, m);
    this.setMeta({ queue: list });
    try { const r = await this.queueMove(id, to); this.setQueue(r?.queue, r?.v); } catch { /* the next queue state puts it right */ }
  }
  /** Stop the current turn; the queue then sends this message next. */
  async steerQueued(id: number) {
    const q = this.meta.queue.find((x) => x.id === id);
    if (!q) return;
    if (await this.unqueue(id)) this.dispatch(q.text, q.images, this.meta.busy);
  }

  addUser(text: string, images: number, steered = false, thumbs?: { mediaType: string; data: string }[], uuid?: string): UserItem {
    if (!this.meta.stats.started) this.setMeta({ stats: { ...this.meta.stats, started: Date.now() } });
    return this.push({ t: 'user', text, images, steered, thumbs: thumbs?.length ? thumbs : undefined, uuid: uuid || undefined }) as UserItem;
  }
  /** A plan is one card in the chat for both makers (lib/plan.ts has the rules, planEventRule). True: `ev` was a
   *  plan's own event and is dealt with here. Claude's plan step makes no step row; a saved chat's plan comes back
   *  as an answered card; the words Build it sent are not shown as something you typed. */
  planEvent(ev: CanopyEvent, opts: { history?: boolean }): boolean {
    const step = planEventRule(this, ev, !!opts.history, (id) => this.tools.has(id));
    if (!step) return false;
    if (step.endLive) this.endLive();
    if (step.reply) this.push({ t: 'assistant', text: step.reply, streaming: false });
    const item = step.plan !== undefined ? this.addPlan(step.plan, step.toolUseId) : step.item;
    if (item && step.outcome && !item.outcome) { item.outcome = step.outcome; this.touch(item); }
    if (step.feedback) this.push({ t: 'user', text: step.feedback, images: 0 });
    return step.handled;
  }
  /** A plan that has been answered already (one read back from a saved chat), as the card a live one leaves behind. */
  addPlan(plan: string, toolUseId?: string): PlanItem {
    return this.push({ t: 'permission', ev: { kind: 'permission', type: 'plan', toolName: 'ExitPlanMode', input: { plan }, toolUseId: toolUseId ?? null }, resolved: true }) as PlanItem;
  }
  addError(message: string, stderr?: string) { this.push({ t: 'error', message, stderr }); }

  private endLive() {
    if (this.live) { this.live.streaming = false; this.touch(this.live); this.live = null; }
    if (this.liveThinking) { this.liveThinking.streaming = false; this.touch(this.liveThinking); this.liveThinking = null; }
  }

  /** Replay a saved conversation in one batch. */
  loadHistory(events: CanopyEvent[]) {
    this.replaying = true;
    this.items = [...this.items]; // push() appends to this copy in place; the array already rendered is left alone
    try { for (const ev of events) this.handle(ev, { history: true }); }
    finally {
      this.replaying = false;
      for (const parent of this.replayParents) this.touch(parent);
      this.replayParents.clear();
      this.endLive();
      this.notify();
    }
  }

  // ---- Show earlier: the older part of a very long chat, a page at a time ----
  /** Which chat (see `shown`) a page is being fetched for, so one press asks once. */
  private paging: number | null = null;
  /** Earlier pages are numbered below everything on screen, each page a block further down (see `prepend`). */
  private low = 0;
  /**
   * "Show earlier": ask for the turns just older than the ones this chat opened with (`meta.earlier`) and put them
   * in front of what is on screen. Resolves true when a page landed, false when it could not be loaded (nothing
   * changed: the button is there to try again), and null when there was nothing to do: no older part, a page
   * already on its way, or another chat on screen by the time the answer came.
   */
  async loadEarlier(): Promise<boolean | null> {
    const cursor = this.meta.earlier?.cursor;
    const shown = this.shown;
    if (!cursor || this.paging === shown) return null;
    this.paging = shown;
    const { sessionId } = this.meta;
    const none = Promise.resolve(null);
    let r: EarlierReply = null;
    try { r = await this.via<EarlierReply>((sid) => api.pane?.earlier?.(sid, sessionId, this.cwd, cursor) ?? none, () => api.earlier?.(sessionId, this.cwd, cursor) ?? none, null); }
    catch { r = null; }
    if (this.paging === shown) this.paging = null;
    if (this.shown !== shown) return null;
    if (!r || r.error || !Array.isArray(r.events)) return false;
    try { this.prepend(r.events, cursor); } catch { return false; } // an event the store could not read: what was replayed before it is kept
    return true;
  }
  /**
   * A page of older turns, replayed on its own and put in front of what is on screen. Everything on screen keeps
   * its identity (rows, open prompts, the reply being written), so nothing below the page moves or redraws.
   *  - A step that is already on screen is not drawn a second time, whatever the page says about it.
   *  - The page's items are numbered below everything newer ("i-999990"), in order. A message's number is how
   *    Edit knows it is above the place a chat was summarized (edit.ts): numbered this way, a message from an
   *    earlier page always reads as above it, so it is never offered an edit it could not make.
   *  - Of the chat's vitals only the turn count and working time grow. The page's last turn says nothing about now.
   */
  private prepend(events: CanopyEvent[], asked: string) {
    const next = events.find((ev) => ev.kind === 'earlier' && typeof ev.cursor === 'string' && ev.cursor && ev.cursor !== asked);
    const dup = new Set<string>();
    for (const ev of events) if (ev.kind === 'tool-start' && typeof ev.id === 'string' && this.tools.has(ev.id)) dup.add(ev.id);
    const page = events.filter((ev) => ev.kind !== 'earlier'
      && !(typeof ev.kind === 'string' && ev.kind.startsWith('tool-') && dup.has(ev.id)) && !(typeof ev.parent === 'string' && dup.has(ev.parent)));
    const here = { items: this.items, tools: this.tools, perms: this.perms, taskRows: this.taskRows, live: this.live, liveThinking: this.liveThinking, seq: this.seq, wall: this.wall, meta: this.meta };
    this.items = []; this.tools = new Map(); this.perms = new Map(); this.taskRows = new Map(); this.live = null; this.liveThinking = null;
    this.low -= 1_000_000;
    this.seq = this.low;
    this.replaying = true;
    try { for (const ev of page) this.handle(ev, { history: true }); }
    finally {
      this.replaying = false;
      this.replayParents.clear();
      this.endLive();
      const older = this.items;
      const { workMs, turns } = this.meta.stats;
      for (const [id, t] of this.tools) if (!here.tools.has(id)) here.tools.set(id, t);
      for (const [id, p] of this.perms) if (!here.perms.has(id)) here.perms.set(id, p);
      for (const [id, row] of this.taskRows) if (!here.taskRows.has(id)) here.taskRows.set(id, row);
      this.tools = here.tools; this.perms = here.perms; this.taskRows = here.taskRows;
      this.live = here.live; this.liveThinking = here.liveThinking; this.seq = here.seq; this.wall = here.wall;
      // A page that brought nothing, or the same place again, is the end: the button goes rather than ask forever.
      this.meta = { ...here.meta, stats: { ...here.meta.stats, workMs, turns }, earlier: next && older.length ? { cursor: next.cursor } : undefined };
      this.items = [...older, ...here.items];
      this.notify();
    }
  }

  private evAt: number | null = null; // the event's own time (history replays keep when things really happened)
  handle(ev: CanopyEvent, opts: { history?: boolean } = {}) {
    this.evAt = typeof ev.at === 'number' && Number.isFinite(ev.at) ? ev.at : null;
    const m = this.meta;
    // An edit of yours is on its way: until the engine says the old reply is gone, what arrives is that reply ending.
    if (this.cutting && !opts.history) {
      if (ev.kind === 'edit' && ev.id === this.cutting) { this.cutting = null; return; }
      if (!passesCut(ev.kind)) return;
    }
    switch (ev.kind) {
      case 'init':
        this.learnBrands(catalogBrands(ev.mcp));
        this.setMeta({
          sessionId: ev.sessionId, mode: ev.permissionMode ?? m.mode, model: ev.model ?? m.model,
          fastState: ev.fastState ?? m.fastState, fastReason: ev.fastReason ?? m.fastReason,
          commands: m.commands.length ? m.commands : (ev.slash ?? []).map((n: string) => ({ name: n })),
          // Only an OpenAI chat says which engine it is, and what effort it runs with.
          ...(ev.engine === 'codex' && { engine: 'codex' as const, effort: ev.effort ?? m.effort }),
        });
        break;
      case 'meta':
        this.learnBrands(catalogBrands(ev.mcp));
        if (Array.isArray(ev.mcp)) for (const row of ev.mcp) this.learnBrands(catalogBrands(row.tools, row.name));
        this.setMeta({
          commands: Array.isArray(ev.commands) ? ev.commands : m.commands,
          models: Array.isArray(ev.models) ? applyModelFixups(this.rawModels = ev.models) : m.models,
          sessionId: ev.sessionId ?? m.sessionId,
          mode: ev.mode ?? m.mode,
          fastState: ev.fastState ?? m.fastState, fastReason: ev.fastReason ?? m.fastReason,
          codeBlocked: ev.codeBlocked === undefined ? m.codeBlocked : ev.codeBlocked,
          // The chat moved to another account (one nobody had used yet, when another account was chosen).
          ...('accountId' in ev && { accountId: typeof ev.accountId === 'string' ? ev.accountId : null }),
          // An OpenAI chat reports the model and effort it runs with here too (a Claude chat's come with `init`).
          ...(ev.engine === 'codex' && { engine: 'codex' as const, model: ev.model ?? m.model, effort: ev.effort ?? m.effort }),
        });
        break;
      case 'busy':
        this.setMeta({ busy: !!ev.busy, status: ev.busy ? m.status : '' });
        break;
      case 'queue':
        // Main sent the next queued message on its own (the turn ended): show it as yours, without jumping your scroll.
        // A state older than the one already shown (a snapshot's own send) has been shown already.
        if (ev.sent && !opts.history && (typeof ev.v !== 'number' || ev.v > this.queueV)) {
          const images = (ev.sent.images ?? []) as ImageAttachment[];
          this.setMeta({ lastPrompt: { text: ev.sent.text, images }, suggestion: null });
          this.addUser(ev.sent.text, images.length, false, images.map((i) => ({ mediaType: i.mediaType, data: i.data })), typeof ev.sent.uuid === 'string' ? ev.sent.uuid : undefined);
        }
        this.setQueue(ev.queue, ev.v);
        break;
      case 'status':
        this.setMeta({
          status: ev.status === 'compacting' ? COMPACTING_STATUS : ev.status === 'reviewing' ? 'Reviewing' : '',
          mode: ev.permissionMode ?? m.mode,
          fastState: ev.fastState ?? m.fastState, fastReason: ev.fastReason ?? m.fastReason,
        });
        break;
      case 'setting':
        if (ev.key === 'permissionMode') this.setMeta({ mode: ev.value });
        if (ev.key === 'model') {
          const v = typeof ev.value === 'string' ? ev.value : '';
          // Only a change in a chat that has a conversation. Until the chat has confirmed one model (a chat just reopened,
          // or picked up running), a model is news only if it is not the one its last reply ran.
          const news = this.toldModel !== undefined ? v !== this.toldModel : this.resolves(v) !== this.ranModel;
          if (!opts.history && news && this.items.some(isContent)) {
            const text = this.switchedTo(v);
            if (!this.saidSinceYou(text)) this.push({ t: 'notice', text, tone: 'info' });
          }
          this.toldModel = v;
          this.setMeta({ pick: v || null });
        }
        // Claude Code confirmed Fast: show it (a new chat starts with the display reset, so this is what lights the ⚡).
        if (ev.key === 'fast') this.setMeta({ fastPref: !!ev.value });
        if (ev.key === 'codeMode') this.setMeta({ codePref: !!ev.value });
        break;
      case 'setting-failed':
        this.setMeta({
          settingFailed: { key: ev.key, value: ev.value, n: (m.settingFailed?.n ?? 0) + 1 }, mode: ev.key === 'permissionMode' ? ev.value : m.mode,
          codePref: ev.key === 'codeMode' ? !!ev.value : m.codePref,
          // A model the chat turned down: it keeps the one it had.
          pick: ev.key === 'model' ? (typeof ev.value === 'string' && ev.value ? ev.value : null) : m.pick,
        });
        break;
      case 'message-start': break;
      case 'text-delta':
        if (!this.live) this.live = this.push({ t: 'assistant', text: '', streaming: true, streamed: true });
        this.live.text += ev.text; this.touch(this.live);
        break;
      case 'thinking-delta':
        if (!this.liveThinking) this.liveThinking = this.push({ t: 'thinking', text: '', streaming: true });
        this.liveThinking.text += ev.text; this.touch(this.liveThinking);
        break;
      case 'thinking':
        if (!ev.parent && this.liveThinking) {
          this.liveThinking.text = ev.text; this.liveThinking.streaming = false; this.touch(this.liveThinking); this.liveThinking = null;
        } else this.push({ t: 'thinking', text: ev.text, streaming: false }, ev.parent);
        break;
      case 'assistant-text':
        if (this.planEvent(ev, opts)) break;
        if (!ev.parent && typeof ev.model === 'string' && ev.model && ev.model !== '<synthetic>') {
          if (opts.history && this.ranModel && ev.model !== this.ranModel) {
            let at = this.items.length - 1;
            while (at >= 0 && this.items[at].t !== 'user') at--;
            if (at >= 0) {
              const line = this.push({ t: 'notice', text: this.switchedTo(ev.model), tone: 'info' });
              this.items.splice(this.items.indexOf(line), 1);
              this.items.splice(at, 0, line);
            }
          }
          this.ranModel = ev.model;
        }
        if (!ev.parent && this.live) {
          this.live.text = ev.text; this.live.model = ev.model; this.live.streaming = false; this.touch(this.live); this.live = null;
        } else this.push({ t: 'assistant', text: ev.text, model: typeof ev.model === 'string' && ev.model ? ev.model : undefined, streaming: false }, ev.parent);
        break;
      case 'user-text': {
        if (this.planEvent(ev, opts)) break;
        // History carries thumbnails (imageData); the bare "[2 images]" label is only a fallback for when it doesn't.
        const thumbs = Array.isArray(ev.imageData) ? ev.imageData as { mediaType: string; data: string }[] : undefined;
        const n = typeof ev.images === 'number' ? ev.images : 0;
        const text = thumbs?.length && /^\[(\d+ )?images?\]( \[(\d+ )?documents?\])?$/.test(String(ev.text)) ? '' : String(ev.text ?? '');
        this.push({
          t: 'user', text, images: n, thumbs, uuid: typeof ev.uuid === 'string' ? ev.uuid : undefined,
          fixed: ev.command === true || ev.bash === true || !!ev.origin || undefined,
          peer: ev.origin === 'peer' ? String(ev.from ?? '') : undefined,
          peerAddr: ev.origin === 'peer' && typeof ev.fromAddr === 'string' && ev.fromAddr ? ev.fromAddr : undefined,
          // An OpenAI chat's history says which messages went into a reply that was already running.
          steered: ev.steered === true || undefined,
        });
        break;
      }
      // The engine's conversation was cut back by something other than an edit made here: read the chat again.
      case 'reverted': if (!opts.history) this.reload?.(); break;
      case 'edit':
        // The chat was edited from another view of it (a pane beside this one): follow, or reload if we can't.
        if (opts.history || typeof ev.messageId !== 'string' || typeof ev.id !== 'string') break;
        if (this.items.some((it) => it.t === 'user' && it.uuid === ev.id)) break; // our own edit, already shown
        if (this.applyCut(ev.messageId, ev.id, String(ev.text ?? ''))) this.setMeta({ busy: true });
        else this.reload?.();
        break;
      // Only a real compaction summary is worth showing; other echoes ("[Request interrupted by user]", tool notes) are noise.
      case 'context-note': if (String(ev.text).startsWith('This session is being continued')) this.push({ t: 'note', text: ev.text }); break;
      case 'handoff': this.push({ t: 'handoff', ev }); break;
      case 'command-output': this.push({ t: 'cmd', text: ev.text }); break;
      case 'tool-input-partial': {
        // A call whose input the window draws as it is written (a widget). The first of these gives it its place in
        // the reply; each one after carries everything written so far; tool-start then brings the whole input.
        const t = this.tools.get(ev.id);
        if (!t) {
          this.endLive();
          const item = this.push({ t: 'tool', id: ev.id, name: ev.name, input: ev.input ?? {}, status: 'running', children: [], streaming: true }) as ToolItem;
          this.tools.set(ev.id, item);
        } else if (t.streaming) { t.input = ev.input ?? {}; this.touch(t); }
        break;
      }
      case 'tool-start': {
        if (this.planEvent(ev, opts)) break;
        if (!ev.parent) this.endLive();
        const begun = this.tools.get(ev.id);
        if (begun?.streaming) { begun.input = ev.input ?? {}; begun.icons = toolIcons(ev); begun.streaming = false; this.touch(begun); break; }
        const item = this.push({ t: 'tool', id: ev.id, name: ev.name, input: ev.input ?? {}, icons: toolIcons(ev), status: opts.history ? 'done' : 'running', children: [] }, ev.parent) as ToolItem;
        this.tools.set(ev.id, item);
        break;
      }
      case 'tool-result': this.onToolResult(ev, opts); break;
      case 'tool-progress': {
        const t = this.tools.get(ev.id);
        if (t) { t.elapsed = ev.elapsed; this.touch(t); }
        break;
      }
      case 'tool-output': {
        // What a running command printed since the last of these, or with `replace` everything kept of it (a chat
        // reopened while the command runs). Nothing is added once the step has its result or its turn has ended.
        const t = this.tools.get(ev.id);
        if (!t || t.result !== undefined || t.status === 'error' || typeof ev.text !== 'string') break;
        const seq = typeof ev.seq === 'number' ? ev.seq : null;
        if (seq !== null && !ev.replace && t.outputSeq !== undefined && seq <= t.outputSeq) break; // already in what the reopened chat was given
        // A step replayed from a saved chat reads as finished. Output still arriving says it is not.
        if (t.status === 'done') { if (!t.hist) break; t.status = 'running'; }
        t.output = appendOutput(ev.replace ? '' : t.output ?? '', ev.text, OUTPUT_CAP);
        if (seq !== null) t.outputSeq = seq;
        this.touch(t);
        break;
      }
      case 'earlier':
        // A very long chat, opened from its newest turns: where the older ones begin. No row: the button says it.
        this.setMeta({ earlier: typeof ev.cursor === 'string' && ev.cursor ? { cursor: ev.cursor } : undefined });
        break;
      case 'code-call': this.onCodeCall(ev); break;
      case 'permission': this.onPermission(ev); break;
      case 'permission-resolved': this.onPermissionResolved(ev); break;
      case 'turn-end': this.onTurnEnd(ev, opts, m); break;
      // An OpenAI chat says how full it is during a long turn too (a Claude chat is asked after each turn).
      case 'context':
        if (Number.isFinite(ev.totalTokens) && Number.isFinite(ev.maxTokens) && Number.isFinite(ev.percentage)) this.noteContext(ev as unknown as ContextReading);
        break;
      case 'suggestion': this.setMeta({ suggestion: ev.text || null }); break;
      case 'hook':
        if (ev.subtype === 'hook_response' && ev.output) this.push({ t: 'raw', label: `Hook · ${ev.name}`, raw: ev.output });
        break;
      case 'task': this.onTask(ev); break;
      case 'tasks': this.setMeta({ tasks: Array.isArray(ev.tasks) ? ev.tasks as TaskInfo[] : [] }); break;
      case 'commands-changed': if (Array.isArray(ev.commands)) this.setMeta({ commands: ev.commands }); break;
      case 'notice': {
        // The same line again since your last message (a setting re-applied each time the chat opens, a mode cycled
        // past again) is said once, not stacked.
        // A turn that could not sign in says so in Canopy's words, with the way to fix it beside it.
        const signIn = signInNotice(ev, m.engine, opts.history, m.accountId);
        const text = signIn?.text ?? rewriteNotice(ev.text);
        if (this.saidSinceYou(text)) break;
        this.push({
          t: 'notice', text, level: ev.level, tone: ev.level === 'warn' ? 'warn' : 'info', brand: !!ev.brand,
          boundary: ev.code === 'compacted' || ev.code === 'conversation-reset' || undefined,
          ...(signIn?.action && { action: signIn.action }),
        });
        break;
      }
      case 'error': {
        this.endLive();
        this.push({ t: 'error', message: ev.message, stderr: ev.stderr });
        // The chat did not start because its account is signed out: the same line, and the same button, as mid-chat.
        const signIn = signInNotice(ev, m.engine, opts.history, m.accountId);
        if (signIn && !this.saidSinceYou(signIn.text)) this.push({ t: 'notice', text: signIn.text, level: 'warn', tone: 'warn', ...(signIn.action && { action: signIn.action }) });
        this.setMeta({ busy: false });
        break;
      }
      case 'stopped': this.endLive(); break;
      case 'raw': this.push({ t: 'raw', label: ev.label, raw: ev.raw }); break;
      default: this.push({ t: 'raw', label: `Event · ${ev.kind}`, raw: ev });
    }
  }

  /** A step's result: its row closes, with what it gave back and whatever icons it taught. */
  private onToolResult(ev: CanopyEvent, opts: { history?: boolean }) {
    if (this.planEvent(ev, opts)) return;
    const t = this.tools.get(ev.id);
    if (!t) { this.push({ t: 'raw', label: 'Tool output', raw: ev.content }); return; }
    t.output = undefined; // what it printed while it ran: the result is the truth from here on
    t.result = ev.content; t.isError = ev.isError; t.status = ev.isError ? 'error' : 'done';
    const icons = toolIcons(ev);
    if (icons.length) t.icons = icons;
    if (t.name.startsWith('mcp__')) {
      const server = t.name.split('__')[1];
      this.learnBrands([...catalogBrands(ev.structured, server), ...catalogBrands(ev.content, server)]);
      if (icons.length) this.learnBrands([{ key: brandKey(t.name), icons }]);
      const serverIcons = toolIcons({ icons: ev.serverIcons });
      if (serverIcons.length) this.learnBrands([{ key: brandKey(server), icons: serverIcons }]);
    }
    if (Array.isArray(ev.images) && ev.images.length) t.images = ev.images;
    this.touch(t);
  }

  /** One call of a Code Mode script. */
  private onCodeCall(ev: CanopyEvent) {
    // A call made by a Code Mode script: a row under the script's own step. The first event names the call,
    // later ones only move its status.
    // (A Claude Code that stops saying which step a script belongs to: its rows go to the script still running.)
    const t = ev.run ? this.tools.get(ev.run) : [...this.tools.values()].reverse().find((x) => x.name === 'mcp__canopy__run' && (x.status === 'running' || x.status === 'approval'));
    if (!t) return;
    const calls = t.calls ?? [];
    const i = calls.findIndex((c) => c.id === ev.id);
    const patch = Object.fromEntries(['name', 'input', 'status', 'ms', 'note', 'error', 'icons'].filter((k) => ev[k] !== undefined).map((k) => [k, ev[k]])) as Partial<CodeCall>;
    if (i >= 0) t.calls = calls.map((c, j) => (j === i ? { ...c, ...patch } : c));
    else if (typeof patch.name === 'string') t.calls = [...calls, { id: ev.id, input: {}, status: 'running', ...patch } as CodeCall];
    else return;
    this.touch(t);
  }

  /** Something waits on your answer: its card, and every step the answer covers. */
  private onPermission(ev: CanopyEvent) {
    this.endLive();
    // One answer can cover several steps (an OpenAI change to several files): every one of them waits on it.
    for (const id of askedAbout(ev)) {
      const t = this.tools.get(id);
      if (t) { t.status = 'approval'; this.touch(t); }
    }
    const p = this.push({ t: 'permission', ev, resolved: false }) as PermissionItem;
    this.perms.set(ev.id, p);
  }

  /** A prompt was answered: its card folds, and the steps it held go on once none of their prompts is open. */
  private onPermissionResolved(ev: CanopyEvent) {
    const p = this.perms.get(ev.id);
    if (p) {
      if (ev.outcome && !(p as PlanItem).outcome) (p as PlanItem).outcome = ev.outcome; // a plan says how it was answered
      p.resolved = true; this.touch(p);
      for (const id of askedAbout(p.ev)) {
        const t = this.tools.get(id);
        // A Code Mode script can have several prompts open at once: its step waits until the last is answered.
        const more = [...this.perms.values()].some((q) => !q.resolved && askedAbout(q.ev).includes(id));
        if (t && t.status === 'approval' && !more) { t.status = 'running'; this.touch(t); }
      }
    }
  }

  /** A reply is over: steps still open are closed, and the turn's cost and time join the chat's. `m`: the chat as it stood when the event came in. */
  private onTurnEnd(ev: CanopyEvent, opts: { history?: boolean }, m: Meta) {
    this.endLive();
    for (const t of this.tools.values()) {
      if (t.status !== 'running' && t.status !== 'approval') continue;
      t.status = ev.interrupted || ev.isError ? 'error' : 'done';
      if (t.streaming) { t.streaming = false; t.cut = true; } // stopped mid-write: what arrived is all there is
      this.touch(t);
    }
    this.push({ t: 'turn', ev });
    this.setMeta({
      // Each run reports its own duration, and its own cost via costOfTurn; add them up for the chat.
      stats: {
        cost: m.stats.cost + (opts.history ? 0 : costOfTurn(ev, m.cost ?? 0)),
        workMs: m.stats.workMs + (ev.durationMs ?? 0),
        turns: m.stats.turns + 1,
        started: m.stats.started,
      },
      cost: Number.isFinite(ev.cost) ? ev.cost : m.cost, // the process's running total: costOfTurn's baseline, cleared by reset()
      fastState: ev.fastState ?? m.fastState, fastReason: ev.fastReason ?? m.fastReason,
    });
  }

  /** Background work with no row of its own: one line in the chat that updates in place. */
  private onTask(ev: CanopyEvent) {
    // A subagent or step that already has its own row says nothing extra; its row shows it running and done.
    if (ev.toolUseId && this.tools.has(String(ev.toolUseId))) return;
    const fromDrawer = !this.replaying && this.meta.tasks.length > 0; // live: the agents drawer shows it
    // A true background task (no row): one line that updates in place, not a "Started" and a "Finished".
    // Plain words, no internal ids ("(acc638c9ed8149fe0)") and no "agents" jargon.
    const raw = String(ev.description ?? ev.summary ?? '').trim();
    const what = raw.replace(/\s*\((?:[a-f0-9]{8,}|[A-Za-z0-9_-]{16,})\)/g, '').replace(/background agents?/gi, (m) => (/s$/i.test(m) ? 'agents' : 'agent')).trim() || 'a task';
    const sub = String(ev.subtype ?? '');
    const status = String(ev.status ?? '').toLowerCase();
    const id = String(ev.taskId ?? ev.toolUseId ?? what);
    // Claude Code's note after a restart: helpers that were cut off when the app closed.
    const many = what.match(/^(\d+) agents? didn't finish before the previous session ended:\s*(.*?)\.?$/i);
    const one = !many && what.match(/^(?:stopped:\s*)?agent\s+"([^"]+)"\s+didn't finish before the previous session ended\.?$/i);
    const lost = many ?? (one ? ([what, '1', one[1]] as unknown as RegExpMatchArray) : null);
    const names = lost ? lost[2].replace(/"/g, '').split(/,\s*/).filter(Boolean).join(', ') : '';
    const done = sub === 'task_completed' || status === 'completed' || status === 'done';
    const failed = status === 'failed' || status === 'error';
    const stopped = status === 'stopped' || status === 'killed' || status === 'cancelled';
    if (!lost && fromDrawer) return;
    if (lost) {
      // One short line; the names on hover; one button that asks Claude to start them again.
      const single = lost[1] === '1';
      this.push({ t: 'notice', tone: 'error', brand: true, text: `${single ? 'An agent' : `${lost[1]} agents`} stopped when Canopy closed`, detail: names,
        action: { label: 'Run again', prompt: `The ${single ? 'agent' : 'agents'} you started (${names}) stopped when the app closed. Please run ${single ? 'it' : 'them'} again.` } });
      return;
    }
    const text = failed ? `A background task failed: ${what}`
      : stopped ? `Stopped: ${what}`
      : done ? `Finished in the background: ${what}`
      : sub === 'task_notification' ? what
      : `Working in the background: ${what}`;
    const tone = failed || stopped ? 'error' as const : done ? 'good' as const : 'info' as const;
    const row = this.taskRows.get(id) as { text: string; tone?: string } | undefined;
    if (row) { row.text = text; row.tone = tone; this.touch(row as unknown as Item); }
    else { const item = this.push({ t: 'notice', text, tone }); if (item) this.taskRows.set(id, item as { text: string }); }
  }
}

export const store = new Store();

/** The store for the chat this part of the screen shows: the main one, or a Multi mode pane's own. */
export const StoreContext = createContext<Store>(store);

export function useStore() {
  const s = useContext(StoreContext);
  useSyncExternalStore(s.subscribe, s.getVersion);
  return s;
}
/** Which engine runs the chat this part of the screen shows. Re-renders only when that changes, never per streamed frame. */
export function useEngine(): Engine {
  const s = useContext(StoreContext);
  return useSyncExternalStore(s.subscribe, () => s.meta.engine);
}

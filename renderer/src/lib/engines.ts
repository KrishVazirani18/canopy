// The two makers' models, window side: the picker's rows for Claude and for OpenAI, which engine a chat is about to
// open on, and the choices a chat is given once it has opened (yours for the maker it runs on).
//
// Main hands out the rows (`models:list`, cached there) and says when either list changed. They are read once at
// start-up and again each time the model menu opens. Claude's rows are the ones the chat on screen reported when it
// has reported any (exactly what the picker showed before), else the list main kept from the last Claude chat: an
// OpenAI chat never reports them. The OpenAI list is empty when Codex is missing or signed out, and the picker then
// has no second group at all.
//
// A model id is never read on its own: it always travels with the engine of the row or chat it came from.
// Nothing here throws; a failed read leaves the last rows in place.
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api, type ClaudeModel, type CodexInfo, type CodexModel, type Engine, type ModelGroups } from './api';
import { chats } from './chats';
import { choices, type CodexChoices } from './choices';
import { keepEffort, newChatEngine } from './engine-rules';
import { applyModelFixups } from './upkeep';
import type { Meta, Store } from './store';

// `codex`: what main says about Codex itself (installed, signed in and how), null until main has answered.
let groups: { claude: ClaudeModel[]; openai: CodexModel[]; codex: CodexInfo | null } = { claude: [], openai: [], codex: null };
let listRead = false; // main has answered at least once: an empty OpenAI list now means there is none to pick
const subs = new Set<() => void>();
const rows = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]).filter((m) => !!m && typeof (m as { value?: unknown }).value === 'string') : []);

/** Ask main for both lists. Cheap after the first call (main answers from memory), so the menu asks each time it opens. */
export function loadModels() {
  api.models?.().then((g: ModelGroups | null) => {
    if (!g) return;
    groups = { claude: rows<ClaudeModel>(g.claude), openai: rows<CodexModel>(g.openai), codex: g.codex && typeof g.codex === 'object' ? g.codex : null };
    listRead = true;
    for (const f of subs) f();
  }).catch(() => {});
}
/** Read the lists now and follow main's "a list changed". Returns the unsubscribe, like the window's other listeners. */
export function startModels(): () => void {
  loadModels();
  return api.onModelsChanged?.(loadModels) ?? (() => {});
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Hear whenever main hands out the lists again (for lib/releases.ts, which follows them outside React). */
export const subscribeModels = subscribe;
/** Both lists and what is known about Codex as last read, and whether main has answered yet. */
export const modelGroups = () => ({ ...groups, read: listRead });
/** Both lists and what is known about Codex, kept current. */
export function useModels() {
  return useSyncExternalStore(subscribe, () => groups);
}

/** Claude's rows for a chat: its own when it has reported them, else the ones main remembers. */
export function claudeRows(meta: Pick<Meta, 'models'>): ClaudeModel[] {
  return meta.models.length ? (meta.models as ClaudeModel[]) : applyModelFixups(groups.claude);
}
export const openaiRows = (): CodexModel[] => groups.openai;
/** An OpenAI row by its id. */
export const openaiRow = (value: string | null | undefined): CodexModel | null => (value ? groups.openai.find((m) => m.value === value) ?? null : null);
/** The row an OpenAI chat runs on: your pick, else the model it reports, else Codex's own default. */
export function codexRow(meta: Pick<Meta, 'model'>, picked: string | null | undefined = choices.codex?.model): CodexModel | null {
  return openaiRow(picked) ?? openaiRow(meta.model) ?? (picked || meta.model ? null : groups.openai.find((m) => m.isDefault) ?? null);
}
/** The name on the chip for an OpenAI chat. */
export function codexLabel(meta: Pick<Meta, 'model'>, picked: string | null | undefined = choices.codex?.model): string {
  return codexRow(meta, picked)?.displayName ?? (picked || meta.model || 'Default');
}

/** Save an OpenAI pick. An effort the newly picked model does not offer goes back to unset, as the chat itself does. */
export function saveCodex(patch: CodexChoices): CodexChoices {
  const next = { ...choices.codex, ...patch };
  if ('model' in patch && next.effort && openaiRow(next.model) && !keepEffort(openaiRow(next.model), next.effort)) next.effort = undefined;
  choices.codex = next;
  return next;
}

/**
 * The model a saved Claude chat goes on with: the picker row that runs what its last reply ran. '' when that is
 * Claude Code's default (the chat follows the default, as it did), or the conversation says nothing. A model no row
 * runs (retired, or typed after /model) is asked for by its id; a chat that turns it down keeps the default.
 */
function savedModel(store: Store, history: readonly unknown[]): string {
  let id = '';
  for (let i = history.length - 1; i >= 0 && !id; i--) {
    const ev = history[i] as { kind?: unknown; model?: unknown; parent?: unknown } | null;
    if (ev && ev.kind === 'assistant-text' && !ev.parent && typeof ev.model === 'string' && ev.model !== '<synthetic>') id = ev.model;
  }
  if (!id) return '';
  const rows = claudeRows(store.meta);
  if (rows.find((m) => m.value === 'default')?.resolvedModel === id) return '';
  return rows.find((m) => m.resolvedModel === id && m.value !== 'default')?.value ?? id;
}

const SHARED_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

/**
 * A chat just opened (a new one, or a saved one that was not still running): give it your choices for the maker it
 * runs on. `engine` is the one the open reply named, whatever was asked for.
 *
 * A Claude chat gets your Claude choices, except its model: a new chat starts on the one you picked last, and a saved
 * one (`history`: its conversation) goes on with the one it ran. An OpenAI chat gets your OpenAI picks and the shared mode, never
 * Ultra's orchestration or Code Mode, which are Claude Code's. Its mode is always sent: an OpenAI chat starts in Ask
 * until told otherwise, and the chip must not say more than the chat does. Its model goes before its effort, because
 * the chat checks effort against the model, and a level or a faster tier the model lacks is simply not asked for.
 */
export function applyChoices(store: Store, engine: Engine | undefined, defaultMode?: string | null, history?: readonly unknown[] | null) {
  store.setEngine(engine);
  if (engine === 'codex') {
    const c = choices.codex ?? {};
    // Your own choice, else the mode your chats start in, when it is one of the five both makers share.
    const start = choices.mode ?? defaultMode ?? 'default';
    const mode = SHARED_MODES.includes(start) ? start : 'default';
    const row = openaiRow(c.model);
    store.setMeta({ mode });
    store.set('permissionMode', mode);
    if (c.model) store.set('model', c.model);
    if (c.effort && (!row || keepEffort(row, c.effort))) store.set('effort', c.effort);
    if (typeof c.fast === 'boolean' && !(c.fast && row?.supportsFastMode === false)) { store.set('fast', c.fast); store.setMeta({ fastPref: c.fast }); }
    return;
  }
  // A new chat starts on the model you picked last. A saved one goes on with the model it ran (`savedModel`).
  const model = history ? savedModel(store, history) : choices.model ?? '';
  store.setMeta({ pick: model || null });
  if (model) store.set('model', model);
  if (choices.effort) store.set('effort', choices.effort);
  if (choices.mode) store.set('permissionMode', choices.mode);
  if (typeof choices.fast === 'boolean') { store.set('fast', choices.fast); store.setMeta({ fastPref: choices.fast }); }
  if (choices.ultracode) store.set('ultracode', true);
  // A new chat takes the choice. A reopened one keeps the tools it started with, and says so in its answer.
  if (choices.codeMode) store.set('codeMode', true);
}

// ---------- which engine a chat runs on, before it has opened ----------
// The open reply is what counts. Until it comes, this keeps the chip from showing the wrong maker for a moment.
const codexChats = new Set<string>();
/** The chat list as main last sent it: remember which chats run on Codex. */
export function rememberEngines(list: { id: string; engine?: string }[]) {
  for (const s of list) { if (s.engine === 'codex') codexChats.add(s.id); else codexChats.delete(s.id); }
}
/** The engine a chat is about to open on: a saved chat's own, a new chat's from the maker you picked last (while the
 *  picker still has that maker's models: signed out of Codex, new chats are Claude chats again). */
export function expectedEngine(sessionId: string | null): Engine {
  if (!sessionId) return newChatEngine(choices.engine, listRead, groups.openai.length);
  return codexChats.has(sessionId) || chats.get(sessionId)?.engine === 'codex' ? 'codex' : 'claude';
}

/** Things that drive Claude Code's own terminal screens have nothing to drive in an OpenAI chat. True (with a quiet
 *  word) when this chat is one, so the caller stops there. */
export function claudeChatsOnly(meta: Pick<Meta, 'engine'>): boolean {
  if (meta.engine !== 'codex') return false;
  toast('That one works in Claude chats.', { id: 'claude-only' });
  return true;
}

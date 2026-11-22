// Edit and resend, the parts with no window in them (node runs this file as it is, for the unit tests): which of
// your messages can be edited, what an edit takes out of the transcript, and which events still belong to the reply
// an edit has just cut off.
import type { Item, TaskInfo, ToolItem, UserItem } from './store';

/** A message that ran something instead of saying something: "/compact", "/model opus", "! ls". A path is not one. */
export const isCommandText = (text: string) => /^\s*(\/[\w:-]+(\s|$)|!)/.test(text);

/** The conversation was summarized or cleared here: what is above it is no longer the conversation Claude Code holds. */
export const isBoundary = (it: Item) => it.t === 'note' || (it.t === 'notice' && it.boundary === true);

/** An item's place in the transcript: they are numbered as they arrive ("i12"). */
export const itemNumber = (it: Item) => Number(it.key.slice(1)) || 0;

export type EditBlock = 'no-id' | 'unsent' | 'command' | 'nested' | 'boundary' | 'terminal' | 'loading' | 'engine' | 'steered';

/**
 * Why this message has no Edit, or null when it can be edited.
 *   wall      the number of the newest boundary item (0: none): messages above it can't be cut back to
 *   terminal  the chat is open in the terminal view, which owns the conversation for now
 *   loading   the chat is still opening, or another edit is still on its way to the engine
 *   engine    which engine runs the chat. Claude Code cuts a conversation back to any message. An OpenAI (Codex) chat
 *             is cut back a whole turn at a time, so a message you steered into a reply that was already running
 *             can't go on its own. An engine this window doesn't know can't be cut back at all.
 */
export function editBlocked(user: UserItem, ctx: { wall?: number; terminal?: boolean; loading?: boolean; engine?: string } = {}): EditBlock | null {
  const codex = ctx.engine === 'codex';
  if (ctx.engine && ctx.engine !== 'claude' && !codex) return 'engine';
  if (!user.uuid) return 'no-id';            // not a saved message (yet): nothing to cut back to
  if (user.unsent) return 'unsent';          // its send failed
  if (user.parent) return 'nested';          // said inside an agent's or a tool's own conversation
  // "/compact" and "! ls" run something in Claude Code. An OpenAI chat has no such commands: there they are words.
  if (user.fixed || (!codex && isCommandText(user.text))) return 'command';
  if (codex && user.steered) return 'steered'; // part of the turn it went into
  if (ctx.terminal) return 'terminal';
  if (ctx.loading) return 'loading';
  if (itemNumber(user) < (ctx.wall ?? 0)) return 'boundary';
  return null;
}

/** The transcript without your message `uuid` and everything after it, or null when that message isn't in it. */
export function cutItems(items: Item[], uuid: string): { kept: Item[]; cut: Item[]; user: UserItem } | null {
  const at = items.findIndex((it) => it.t === 'user' && it.uuid === uuid);
  if (at < 0) return null;
  return { kept: items.slice(0, at), cut: items.slice(at), user: items[at] as UserItem };
}

/** Every step (tool call) in these items, the ones inside other steps too, by its id. */
export function toolsIn(items: Item[], out = new Map<string, ToolItem>()): Map<string, ToolItem> {
  for (const it of items) {
    if (it.t !== 'tool') continue;
    out.set(it.id, it);
    toolsIn(it.children, out);
  }
  return out;
}

/** How many finished turns these items hold. */
export const turnsIn = (items: Item[]) => items.reduce((n, it) => n + (it.t === 'turn' ? 1 : 0), 0);

// While an edit is on its way, the engine is still closing the reply it cut off: its last words, its "stopped", the
// process going away. None of that belongs under the edited message. These kinds say nothing about a turn, so they
// pass; everything else waits for the engine's `edit` event, after which it all belongs to the new message.
const PASSES = new Set(['meta', 'commands-changed', 'setting', 'setting-failed', 'tasks', 'queue']);
export const passesCut = (kind: string) => PASSES.has(kind);

/**
 * Work that an edit would stop and that you might not expect it to: workflows, agents and commands running in the
 * background. While Claude is replying, an agent it is waiting on is part of the reply, so it doesn't count.
 */
export function backgroundCount(tasks: TaskInfo[], busy: boolean): number {
  return tasks.filter((t) => (t.status === 'running' || t.status === 'pending')
    && (!busy || t.backgrounded === true || !!t.workflow || t.taskType === 'local_workflow')).length;
}

/** "3 files", "notes.txt": what the undo line names. */
export function filesLabel(files: string[]): string {
  if (files.length === 1) return files[0].split('/').pop() || '1 file';
  return `${files.length} files`;
}

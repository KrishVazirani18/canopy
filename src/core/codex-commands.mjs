// The slash commands an OpenAI chat runs itself. In a Claude chat, Claude Code reads `/compact`, `/review` and
// `/goal` out of the message. Codex does not: typed into a turn they would reach the model as plain words. So the
// Codex session reads them here and makes Codex's own call instead of starting a turn.
//
//   CODEX_COMMANDS            the list an OpenAI chat reports (`meta.commands`), so the `/` menu shows them
//   parseCommand(text)        { name, arg } when the whole message is one of them, else null
//   callFor(cmd, threadId)    the Codex call it means: { method, params, starts, about }
//                             starts: 'turn' (the answer names a turn that is now running), 'compaction'
//                             (Codex works on its own and says when it is done) or null (answered at once)
//   sendFirst(name)           what a command says before the chat's first message
//   failedText(name, why)     what a command says when Codex refuses the call
//   goalChange(prev, next)    the notice for a goal that changed (set, paused, resumed, done), or null: a goal whose
//                             words and status are what they were says nothing, however its token count moves
//   goalSaid(goal)            the answer to a bare `/goal`
//   goalKey(goal)             a goal as { objective, status }, the part that is compared
//
// Contract: pure, no imports, nothing throws. A message that is not exactly a command is never one: `/compacted`,
// a command in the middle of a sentence and a message with images all go to the model as they always did.
// None of this is in a recording yet (CODEX-FIXTURES.md): the calls follow the 0.153.4 protocol types.

export const CODEX_COMMANDS = Object.freeze([
  Object.freeze({ name: 'compact', description: 'Summarize earlier messages to free up context', argumentHint: '' }),
  Object.freeze({ name: 'review', description: 'Review your changes', argumentHint: '[branch <name> | commit <sha> | what to look at]' }),
  Object.freeze({ name: 'goal', description: 'Set a goal to keep working toward', argumentHint: '[goal | pause | resume | clear]' }),
]);

const NAMES = new Set(CODEX_COMMANDS.map((c) => c.name));
const COMMAND = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/;
const MAX_ARG = 8000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const oneLine = (s, n = 300) => { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The command a message is, or null. Case and trailing space do not matter; anything else about it does. */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const m = COMMAND.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!NAMES.has(name)) return null;
  return { name, arg: str(m[2]).trim().slice(0, MAX_ARG) };
}

// `/review`, `/review branch main`, `/review commit 1a2b3c4`, `/review look at the error handling`.
function reviewTarget(arg) {
  if (!arg) return { type: 'uncommittedChanges' };
  const branch = /^branch\s+(\S+)$/i.exec(arg);
  if (branch) return { type: 'baseBranch', branch: branch[1] };
  const commit = /^commit\s+([0-9a-fA-F]{4,64})$/i.exec(arg);
  if (commit) return { type: 'commit', sha: commit[1], title: null };
  return { type: 'custom', instructions: arg };
}

/**
 * The Codex call a command means. `about` says which kind of answer to expect: 'compact', 'review', 'goal-set',
 * 'goal-get' or 'goal-clear'. Null for anything that is not a command of this chat.
 */
export function callFor(cmd, threadId) {
  if (!isObj(cmd) || !NAMES.has(cmd.name)) return null;
  const arg = str(cmd.arg).trim();
  switch (cmd.name) {
    case 'compact': return { method: 'thread/compact/start', params: { threadId }, starts: 'compaction', about: 'compact' };
    case 'review': return { method: 'review/start', params: { threadId, target: reviewTarget(arg), delivery: 'inline' }, starts: 'turn', about: 'review' };
    case 'goal': {
      const word = arg.toLowerCase();
      if (!arg) return { method: 'thread/goal/get', params: { threadId }, starts: null, about: 'goal-get' };
      if (word === 'clear') return { method: 'thread/goal/clear', params: { threadId }, starts: null, about: 'goal-clear' };
      if (word === 'pause') return { method: 'thread/goal/set', params: { threadId, status: 'paused' }, starts: null, about: 'goal-set' };
      if (word === 'resume') return { method: 'thread/goal/set', params: { threadId, status: 'active' }, starts: null, about: 'goal-set' };
      return { method: 'thread/goal/set', params: { threadId, objective: arg, status: 'active' }, starts: null, about: 'goal-set' };
    }
    default: return null;
  }
}

/** Before a chat's first message it is not saved yet, and these commands need a saved chat. The words `/rename` uses. */
export const sendFirst = (name) => `Send a message first, then use /${name}.`;

/** Codex refused the call. Its own reason follows, on one line. */
export function failedText(name, why) {
  const reason = oneLine(why, 300);
  return `Couldn’t run /${name}${reason ? `: ${reason}` : '.'}`;
}

/** The part of a goal that is compared: its words and its status. Null for no goal. */
export function goalKey(goal) {
  if (!isObj(goal) || !str(goal.objective).trim()) return null;
  return { objective: str(goal.objective).trim(), status: str(goal.status) || 'active' };
}

const STATUS_SAID = {
  paused: 'Goal paused.',
  blocked: 'Goal blocked: it needs you to carry on.',
  usageLimited: 'Goal paused: a usage limit was reached.',
  budgetLimited: 'Goal paused: it used up its budget.',
  complete: 'Goal reached.',
};

/**
 * What to say when a goal changes from `prev` to `next` (each a goal, a goalKey, or null for none). Null when
 * nothing a person would notice changed: the same words in the same state, or no goal before and none now.
 */
export function goalChange(prev, next) {
  const a = goalKey(prev);
  const b = goalKey(next);
  if (!b) return a ? 'Goal cleared.' : null;
  if (!a || a.objective !== b.objective) {
    const words = oneLine(b.objective);
    return b.status === 'active' ? `Goal set: ${words}` : `Goal set: ${words} (${b.status === 'complete' ? 'reached' : 'paused'})`;
  }
  if (a.status === b.status) return null;
  if (b.status === 'active') return 'Goal resumed.';
  return STATUS_SAID[b.status] ?? 'Goal paused.';
}

/** The answer to a bare `/goal`. */
export function goalSaid(goal) {
  const g = goalKey(goal);
  if (!g) return 'No goal set.';
  const state = g.status === 'active' ? '' : g.status === 'complete' ? ' (reached)' : ' (paused)';
  return `Goal: ${oneLine(g.objective)}${state}`;
}

// Handoff: what a chat carries when it is moved to the other maker (Claude to OpenAI or back).
//
// Two texts, both built by plain code from the old chat's Canopy events (what either adapter's `adaptHistory`
// gives), so one builder serves both directions and no engine's own format is ever read. No model is called.
//
//   buildDigest(events, about)       the short record the new model is given with the user's first message: what was
//                                    asked, where it ended, the plan and to-dos, files changed, commands run,
//                                    decisions, open questions, the state of the folder. At most DIGEST_CHARS
//                                    characters (4,000 tokens), in a fixed section order with a fixed trimming order.
//   exportTranscript(events, about)  the whole old chat as markdown, one "## Turn" per message of the user's, for the
//                                    new model to open or search when it needs a detail the digest left out.
//   forClaude / forCodex             the digest as each engine is handed it
//   isHandoffText / stripHandoff     telling a carried digest from the user's own words, so no bubble, title or
//                                    preview ever shows one
//
// Contract:
//  - Pure: nothing is imported from node, so the window may import this file too. Nothing here throws; bad input
//    gives an empty section, never an error.
//  - The same events and the same `about` always give the same bytes.
//  - Every string that leaves goes through `redact` (pattern rules unless the caller hands in its own).
//  - The first request, the last request and the last reply are never dropped, only cut.
import { redact as plainRedact } from './redact.mjs';

export const HANDOFF_OPEN = '<canopy_handoff>';
const HANDOFF_CLOSE = '</canopy_handoff>';
const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';
/** The digest's size limit. Counted as 4,000 tokens: 3.5 characters a token. */
export const DIGEST_CHARS = 14000;
export const TRANSCRIPT_MAX = 4 * 1024 * 1024;

// What each section may use before the spare room is handed on (characters).
const CAPS = { head: 700, asked: 5000, ended: 3500, plan: 1800, files: 1200, commands: 1000, decisions: 500, open: 300 };
const REQUEST_CAP = 600;        // a request in the middle
const REQUEST_EDGE_CAP = 2000;  // the first request and the last six
const LAST_REQUESTS = 6;
const REPLY_CAP = 2400;
const EARLIER_REPLY_CAP = 500;
const PLAN_CAP = 1200;
const FILES_MAX = 60;
const COMMANDS_MAX = 25;
const COMMAND_CAP = 160;
const STATUS_FILES = 20;
const STEP_OUTPUT_HEAD = 1200;
const STEP_OUTPUT_TAIL = 800;
const DIFF_CAP = 4000;
const DIFF_LINES_MAX = 1500;    // two sides longer than this are counted by their length, not compared line by line

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MODE_NAMES = { default: 'Ask before edits', acceptEdits: 'Accept edits', plan: 'Plan (nothing is changed until a plan is approved)', auto: 'Auto', bypassPermissions: 'Full access' };
// How a step the user said no to reads in its result, in either engine.
const DENIED = /^(The user denied this action|The user doesn't want to proceed|The user doesn’t want to proceed|Not approved, so)/;
const KEPT_PLANNING = 'The user wants to keep planning.';
const BUILD_WORDS = 'Implement the plan.';

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);
/** The token count shown for a text of this length. */
export const tokensOf = (text) => Math.ceil(str(text).length / 3.5);

// The block's own tags, written inside it by a user or a file, would end it early.
const defuse = (s) => str(s).replace(/<(\/?)(canopy_handoff|system-reminder)>/g, '‹$1$2›');
const tidy = (s) => str(s).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const oneLine = (s) => str(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…` : s);
// A long text keeps its start and its end: a reply's conclusion is as often at the bottom as at the top.
function cutMiddle(s, n) {
  if (s.length <= n) return s;
  const head = Math.max(0, Math.floor((n - 3) * 2 / 3));
  const tail = Math.max(0, n - 3 - head);
  return `${s.slice(0, head).trimEnd()}\n…\n${s.slice(s.length - tail).trimStart()}`;
}

// ---------- the block, as each engine is handed it ----------

/** The digest as a Claude chat's first message carries it: a block Claude Code and Canopy's history reader both treat as not the user's. */
export const forClaude = (digest) => `${REMINDER_OPEN}\n${str(digest)}\n${REMINDER_CLOSE}`;
/** The digest as a Codex thread is given it. */
export const forCodex = (digest) => str(digest);

/** True when the text opens with a carried digest (bare, or inside Claude's wrapper). Text that merely quotes the tag further on is not one. */
export function isHandoffText(text) {
  let t = str(text).trimStart();
  if (t.startsWith(REMINDER_OPEN)) t = t.slice(REMINDER_OPEN.length).trimStart();
  return t.startsWith(HANDOFF_OPEN);
}

/**
 * The text without the digest it opens with. Text that does not open with one comes back as it is. A block that was
 * cut short (a title or preview clipped before its closing tag) is all block: nothing is left.
 */
export function stripHandoff(text) {
  const s = str(text);
  if (!isHandoffText(s)) return s;
  const end = s.indexOf(HANDOFF_CLOSE);
  if (end < 0) return '';
  let rest = s.slice(end + HANDOFF_CLOSE.length);
  const after = rest.trimStart();
  if (s.trimStart().startsWith(REMINDER_OPEN) && after.startsWith(REMINDER_CLOSE)) rest = after.slice(REMINDER_CLOSE.length);
  return rest.replace(/^\s+/, '');
}

// ---------- reading the events ----------

/** Lines added and removed going from one text to the other (a minimal line diff, like the Changes tab counts them). */
export function lineChanges(before, after) {
  let a = str(before) === '' ? [] : str(before).split('\n');
  let b = str(after) === '' ? [] : str(after).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  a = a.slice(start, a.length - end); b = b.slice(start, b.length - end);
  if (!a.length || !b.length || a.length > DIFF_LINES_MAX || b.length > DIFF_LINES_MAX) return { add: b.length, del: a.length };
  // The longest common run of lines, one row of the table at a time.
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  const same = prev[b.length];
  return { add: b.length - same, del: a.length - same };
}

// The "+" and "-" rows of a diff that is hunks only (how an OpenAI edit arrives), never its "@@", "+++" or "---" lines.
function diffChanges(diff) {
  let add = 0, del = 0, inHunk = false;
  for (const line of str(diff).split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line[0] === '+') add++; else if (line[0] === '-') del++;
  }
  return { add, del };
}

/** What one edit step did to its file: { file, add, del, wrote, deleted }, or null when it names no file. */
export function editOf(name, input) {
  const i = isObj(input) ? input : {};
  const file = str(i.file_path) || str(i.notebook_path);
  if (!file) return null;
  if (i.deleted === true) return { file, add: 0, del: 0, deleted: true };
  if (name === 'Write') return { file, add: str(i.content).split('\n').length, del: 0, wrote: true };
  if (name === 'MultiEdit') {
    let add = 0, del = 0;
    for (const e of list(i.edits)) { const c = lineChanges(e?.old_string, e?.new_string); add += c.add; del += c.del; }
    return { file, add, del };
  }
  if (name === 'NotebookEdit') return { file, ...lineChanges('', i.new_source) };
  if (typeof i.diff === 'string' && i.diff.trim()) return { file, ...diffChanges(i.diff) };
  return { file, ...lineChanges(i.old_string, i.new_string) };
}

const stepPath = (file, cwd) => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);

/** A step in a few words: "Ran npm test", "Edited src/a.ts (+3 -1)". */
export function stepTitle(name, input, cwd) {
  const i = isObj(input) ? input : {};
  const file = () => stepPath(str(i.file_path) || str(i.notebook_path) || str(i.path), cwd);
  switch (name) {
    case 'Bash': return `Ran ${cut(oneLine(i.command), COMMAND_CAP)}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
      const e = editOf(name, i);
      return e?.deleted ? `Deleted ${file()}` : `Edited ${file()}${e ? ` (+${e.add} -${e.del})` : ''}`;
    }
    case 'Write': return `Wrote ${file()}`;
    case 'Read': return `Read ${file()}`;
    case 'Grep': return `Searched for ${cut(oneLine(i.pattern), 120)}`;
    case 'Glob': return `Looked for files matching ${cut(oneLine(i.pattern), 120)}`;
    case 'WebSearch': return `Searched the web for ${cut(oneLine(i.query), 120)}`;
    case 'WebFetch': return `Fetched ${cut(oneLine(i.url), 200)}`;
    case 'Agent': case 'Task': return `Asked an agent: ${cut(oneLine(i.description) || oneLine(i.prompt), 120)}`;
    case 'TodoWrite': return 'Updated the to-do list';
    case 'ExitPlanMode': return 'Proposed a plan';
    case 'AskUserQuestion': return `Asked: ${cut(oneLine(list(i.questions)[0]?.question), 160)}`;
    default: return `Used ${str(name) || 'a tool'}`;
  }
}

// A step the user said no to, as what was asked for: "run npm publish", "change src/a.ts".
function deniedStep(name, input) {
  const i = isObj(input) ? input : {};
  const file = str(i.file_path) || str(i.notebook_path);
  if (name === 'Bash') return `run ${cut(oneLine(i.command), COMMAND_CAP)}`;
  if (EDIT_TOOLS.has(name) && file) return `${i.deleted === true ? 'delete' : name === 'Write' ? 'write' : 'change'} ${file}`;
  return `use ${str(name) || 'a tool'}`;
}

const isRequest = (ev) => ev.kind === 'user-text' && !ev.parent && !ev.command && !ev.bash && !ev.origin;
const todoLine = (t) => `[${t?.status === 'completed' ? 'x' : t?.status === 'in_progress' ? '~' : ' '}] ${cut(oneLine(t?.content), 200)}`;

// One pass over the events: the chat as the sections need it.
function read(events) {
  const chat = {
    requests: [],      // the user's own messages, oldest first
    finals: [],        // one final reply per turn, oldest first
    todos: null, plan: null,
    tools: new Map(),  // step id -> { name, input, parent, result, isError, declined, done, at }
    steps: [],         // the same rows, in order
    asks: [],          // questions the chat asked: { question, answer }
    denied: [],
    ended: null,       // 'stopped' | { failed: text } | null: how the last turn ended
  };
  let turnTexts = [];   // top-level replies of the turn being read
  let turnFinal = null; // a reply the engine marked as the final answer
  let waiting = [];     // questions asked in a reply (not through a tool) that no message has followed yet
  const closeTurn = () => {
    const last = turnFinal ?? turnTexts.at(-1) ?? null;
    if (last) chat.finals.push(last);
    turnTexts = []; turnFinal = null;
  };
  for (const ev of list(events)) {
    if (!isObj(ev)) continue;
    switch (ev.kind) {
      case 'user-text': {
        if (!isRequest(ev)) break;
        const text = tidy(stripHandoff(ev.text));
        closeTurn();
        chat.ended = null;
        if (chat.plan && chat.plan.state == null && !chat.plan.tool) chat.plan.state = text === BUILD_WORDS ? 'approved' : 'kept';
        for (const q of waiting.splice(0)) q.answer = text;
        if (text && text !== BUILD_WORDS) chat.requests.push({ text, images: Number(ev.images) || 0 });
        break;
      }
      case 'assistant-text': {
        const text = tidy(ev.text);
        if (ev.parent || !text) break;
        if (ev.plan === true) { chat.plan = { text, state: null, tool: null }; }
        const asked = list(ev.questions).filter((q) => isObj(q) && str(q.question).trim());
        for (const q of asked) { const row = { question: oneLine(q.question), answer: null }; chat.asks.push(row); waiting.push(row); }
        if (ev.phase === 'final_answer' && !asked.length) turnFinal = text;
        turnTexts.push(text);
        break;
      }
      case 'tool-start': {
        const id = str(ev.id);
        const row = { id, name: str(ev.name), input: isObj(ev.input) ? ev.input : {}, parent: ev.parent ?? null, result: '', isError: false, declined: false, done: false };
        if (id) chat.tools.set(id, row);
        chat.steps.push(row);
        if (row.name === 'TodoWrite' && Array.isArray(row.input.todos)) chat.todos = row.input.todos.filter(isObj);
        if (row.name === 'ExitPlanMode' && str(row.input.plan).trim()) chat.plan = { text: tidy(row.input.plan), state: null, tool: id };
        if (row.name === 'AskUserQuestion') {
          row.asks = list(row.input.questions).filter((q) => isObj(q) && str(q.question).trim()).map((q) => ({ question: oneLine(q.question), answer: null }));
          chat.asks.push(...row.asks);
        }
        break;
      }
      case 'tool-result': {
        const row = chat.tools.get(str(ev.id));
        if (!row) break;
        row.done = true; row.result = str(ev.content); row.isError = ev.isError === true; row.interrupted = ev.interrupted === true;
        row.declined = ev.declined === true || (row.isError && DENIED.test(row.result.trimStart()));
        if (row.name === 'ExitPlanMode' && chat.plan?.tool === row.id) {
          // Approved, sent back with "keep planning", or never answered (the turn was stopped on it, or it was turned down).
          chat.plan.state = row.result.includes(KEPT_PLANNING) ? 'kept' : row.isError || row.interrupted ? null : 'approved';
        } else if (row.name === 'AskUserQuestion') {
          for (const q of row.asks ?? []) q.answer = row.interrupted || row.isError ? null : answerTo(q.question, row.result);
        } else if (row.declined) chat.denied.push(deniedStep(row.name, row.input));
        break;
      }
      case 'turn-end':
        chat.ended = ev.interrupted === true ? 'stopped' : ev.isError === true ? { failed: oneLine(list(ev.errors).filter((e) => typeof e === 'string').join('; ') || str(ev.text)) } : null;
        break;
      case 'notice':
        if (ev.code === 'interrupted') chat.ended = 'stopped';
        break;
      default: break;
    }
  }
  closeTurn();
  return chat;
}

// The answer a question got, read out of the step's result ("…"Which one?"="The first"…"). The whole result when it reads differently.
function answerTo(question, result) {
  const at = result.indexOf(`"${question}"="`);
  if (at >= 0) {
    const from = at + question.length + 4;
    const end = result.slice(from).search(/"(?:[,.]|\s|$)/);
    if (end >= 0) return oneLine(result.slice(from, from + end));
  }
  return oneLine(result) || null;
}

// ---------- the digest ----------

// "What the user asked", within `room` characters. The first and the last message always stay.
function askedSection(requests, room, keepMiddle) {
  const n = requests.length;
  if (!n) return '';
  const edge = (i) => i === 0 || i >= n - LAST_REQUESTS;
  let caps = requests.map((_, i) => (edge(i) ? REQUEST_EDGE_CAP : REQUEST_CAP));
  let dropped = new Set(keepMiddle ? [] : requests.map((_, i) => i).filter((i) => !edge(i)));
  const render = () => {
    const lines = [];
    let left = 0;
    requests.forEach((r, i) => {
      if (dropped.has(i)) { left++; return; }
      if (left) { lines.push(`… ${left} earlier request${left === 1 ? '' : 's'} left out`); left = 0; }
      const text = cutMiddle(defuse(r.text), caps[i]).replace(/\n/g, '\n   ');
      lines.push(`${i + 1}. ${text}${r.images ? ` [${r.images} image${r.images === 1 ? '' : 's'}, not carried]` : ''}`);
    });
    return `## What the user asked\n${lines.join('\n')}`;
  };
  let out = render();
  const tryDrop = (i) => { if (out.length > room && !dropped.has(i)) { dropped.add(i); out = render(); } };
  // Too long: the middle goes first, oldest first.
  for (let i = 1; i < n - 1; i++) if (!edge(i)) tryDrop(i);
  // Then the last six (but the very last) are cut as short as the middle was, and after that go too, oldest first.
  if (out.length > room) { caps = caps.map((c, i) => (i === 0 || i === n - 1 ? c : REQUEST_CAP)); out = render(); }
  for (let i = 1; i < n - 1; i++) tryDrop(i);
  // Only the first and the last are left: they share what room there is.
  for (let cap = REQUEST_EDGE_CAP / 2; out.length > room && cap > 40; cap = Math.floor(cap / 2)) { caps = caps.map(() => cap); out = render(); }
  return out;
}

function endedSection(finals, room, earlier) {
  if (!finals.length) return '';
  const before = earlier ? finals.slice(-3, -1) : [];
  const render = (cap, each) => {
    const lines = [`## Where it ended`, cutMiddle(defuse(finals.at(-1)), cap)];
    if (before.length && each > 0) lines.push('', 'Before that:', ...before.map((t) => `- ${cut(oneLine(defuse(t)), each)}`));
    return lines.join('\n');
  };
  let out = render(REPLY_CAP, EARLIER_REPLY_CAP);
  if (out.length > room) out = render(REPLY_CAP, 0);
  for (let cap = REPLY_CAP; out.length > room && cap > 80; cap = Math.floor(cap * 0.7)) out = render(cap, 0);
  return out;
}

function planSection(chat, planCap) {
  const lines = [];
  if (chat.todos?.length) lines.push(...chat.todos.slice(0, 40).map(todoLine), ...(chat.todos.length > 40 ? [`and ${chat.todos.length - 40} more`] : []));
  if (chat.plan) {
    const state = chat.plan.state === 'approved' ? 'approved' : chat.plan.state === 'kept' ? 'kept planning' : 'not approved yet';
    if (lines.length) lines.push('');
    lines.push(`The newest plan (${state}):`, cut(defuse(chat.plan.text), planCap));
  }
  return lines.length ? cut(`## Plan and to-dos\n${lines.join('\n')}`, CAPS.plan) : '';
}

/** The files the chat changed, one row a file, in the order each was first touched. */
export function changedFiles(chat, cwd) {
  const files = new Map();
  for (const row of chat.steps) {
    if (!EDIT_TOOLS.has(row.name) || !row.done || row.isError) continue;
    const e = editOf(row.name, row.input);
    if (!e) continue;
    const f = files.get(e.file) ?? { file: e.file, add: 0, del: 0, wrote: false, edited: false, deleted: false };
    f.add += e.add; f.del += e.del;
    f.deleted = !!e.deleted;
    if (e.wrote) f.wrote = true; else if (!e.deleted) f.edited = true;
    files.set(e.file, f);
  }
  return [...files.values()].map((f) => ({ ...f, file: stepPath(f.file, cwd) }));
}

const fileLine = (f) => `- ${defuse(f.file)} (${f.deleted ? 'deleted' : f.wrote && !f.edited ? `written, ${f.add} line${f.add === 1 ? '' : 's'}` : `+${f.add} -${f.del}`})`;

function filesSection(files, max) {
  if (!files.length) return '';
  const render = (n) => `## Files changed\n${[...files.slice(0, n).map(fileLine), ...(files.length > n ? [`- and ${files.length - n} more`] : [])].join('\n')}`;
  let n = Math.min(max, files.length);
  let out = render(n);
  while (out.length > CAPS.files && n > 1) out = render(--n);
  return cut(out, CAPS.files);
}

/** The commands the chat ran, each once (its newest run), oldest first. */
export function commandsRun(chat) {
  const seen = new Map();
  for (const row of chat.steps) {
    if (row.name !== 'Bash') continue;
    const command = oneLine(row.input.command);
    if (!command) continue;
    seen.delete(command); // the newest run is the one that counts, and where it stands in the list
    seen.set(command, { command, failed: row.done && row.isError && !row.declined, declined: row.declined });
  }
  return [...seen.values()].filter((c) => !c.declined);
}

function commandsSection(commands, max) {
  if (!commands.length) return '';
  const render = (n) => `## Commands run\n${commands.slice(-n).map((c) => `- ${cut(defuse(c.command), COMMAND_CAP)}${c.failed ? ' (failed)' : ''}`).join('\n')}`;
  let n = Math.min(max, commands.length);
  let out = render(n);
  while (out.length > CAPS.commands && n > 1) out = render(--n);
  return cut(out, CAPS.commands);
}

function decisionsSection(chat) {
  const lines = [
    ...chat.asks.filter((q) => q.answer).map((q) => `- ${cut(defuse(q.question), 160)} -> ${cut(defuse(q.answer), 160)}`),
    ...[...new Set(chat.denied)].map((d) => `- Not allowed: ${cut(defuse(d), 200)}`),
  ];
  return lines.length ? cut(`## Decisions\n${lines.join('\n')}`, CAPS.decisions) : '';
}

function openSection(chat) {
  const lines = chat.asks.filter((q) => !q.answer).map((q) => `- ${cut(defuse(q.question), 200)}`);
  // The chat's last words were a question to the user.
  const last = chat.finals.at(-1)?.split(/\n\s*\n/).at(-1)?.trim() ?? '';
  if (last.endsWith('?') && !lines.some((l) => l.includes(oneLine(last).slice(0, 60)))) lines.push(`- ${cut(defuse(oneLine(last)), 240)}`);
  return lines.length ? cut(`## Open questions\n${lines.join('\n')}`, CAPS.open) : '';
}

function statusLines(status) {
  const lines = Array.isArray(status) ? status : str(status).split('\n');
  return lines.map((l) => str(l).replace(/\s+$/, '')).filter((l) => l.trim());
}

function headAndState(chat, about) {
  const a = isObj(about) ? about : {};
  const model = oneLine(a.fromModel) || 'another model';
  const file = str(a.file);
  const head = (a.back
    ? `While this chat was away from you, the user carried it on with ${defuse(model)}, and now it is back with you. What follows is Canopy's record of what happened there, put together without a model. Nobody said it to you. Trust the files on disk over this record.`
    : `This chat continues an earlier one that ran on ${defuse(model)}. What follows is Canopy's record of that chat, put together without a model. Nobody said it to you. Trust the files on disk over this record.`)
    + (file ? ` The full transcript is at ${defuse(file)}: open or search it when you need a detail that is not here.` : '');
  const changed = statusLines(a.status);
  const state = (shown) => {
    const first = [];
    if (str(a.cwd)) first.push(`Folder: ${defuse(a.cwd)}.`);
    if (str(a.branch)) first.push(`Branch: ${defuse(oneLine(a.branch))}.`);
    if (a.status != null && str(a.cwd)) {
      first.push(changed.length
        ? `Uncommitted: ${changed.length} file${changed.length === 1 ? '' : 's'}${shown ? ` (${changed.slice(0, shown).map((l) => cut(defuse(oneLine(l)), 120)).join(', ')}${changed.length > shown ? ', …' : ''})` : ''}.`
        : 'Uncommitted: nothing.');
    }
    const second = [];
    if (str(a.mode)) second.push(`Mode: ${MODE_NAMES[a.mode] ?? defuse(oneLine(a.mode))}.`);
    if (chat.ended === 'stopped') second.push('The last turn was stopped.');
    else if (isObj(chat.ended)) second.push(`The last turn failed${chat.ended.failed ? `: ${cut(defuse(chat.ended.failed), 200)}` : '.'}`);
    const lines = [first.join(' '), second.join(' ')].filter(Boolean);
    return lines.length ? `## State\n${lines.join('\n')}` : '';
  };
  let shown = Math.min(STATUS_FILES, changed.length);
  let s = state(shown);
  while (head.length + s.length > CAPS.head && shown > 0) s = state(--shown);
  return { head, state: s };
}

// The trimming order when the whole is still over the limit, each step on top of the one before.
const SQUEEZES = [
  {},
  { commands: 10 },
  { commands: 10, middle: false },
  { commands: 10, middle: false, earlier: false },
  { commands: 10, middle: false, earlier: false, files: 30 },
  { commands: 10, middle: false, earlier: false, files: 30, plan: 300 },
];

/**
 * The digest of a chat, for the model that carries it on.
 * @param {object[]} events the old chat's Canopy events, oldest first
 * @param {{ fromModel?: string, cwd?: string, file?: string, mode?: string, branch?: string | null, status?: string | string[] | null, back?: boolean }} about
 *   `fromModel`: the old model's name on screen. `back`: the record is for a chat gone back to, of what happened
 *   while it was away. `file`: where the full transcript is. `status`: `git status
 *   --porcelain` of the folder (null or left out: not a repo, so nothing is said about it).
 * @param {{ redact?: (s: string) => string }} [opts]
 * @returns {{ text: string, tokens: number, counts: { requests: number, files: number, commands: number } }}
 */
export function buildDigest(events, about, opts) {
  const redact = typeof opts?.redact === 'function' ? opts.redact : plainRedact;
  const counts = { requests: 0, files: 0, commands: 0 };
  let text = `${HANDOFF_OPEN}\n${HANDOFF_CLOSE}`;
  try {
    const chat = read(events);
    const files = changedFiles(chat, str(about?.cwd));
    const commands = commandsRun(chat);
    Object.assign(counts, { requests: chat.requests.length, files: files.length, commands: commands.length });
    const { head, state } = headAndState(chat, about);
    const join = (parts) => `${HANDOFF_OPEN}\n${parts.filter(Boolean).join('\n\n')}\n${HANDOFF_CLOSE}`;
    const build = (sq) => {
      const fixed = [
        planSection(chat, sq.plan ?? PLAN_CAP), filesSection(files, sq.files ?? FILES_MAX), commandsSection(commands, sq.commands ?? COMMANDS_MAX),
        decisionsSection(chat), openSection(chat),
      ];
      // What the short sections leave unused goes to the requests, and what those leave to the last reply.
      const used = join([head, ...fixed, state]).length;
      const room = Math.max(0, DIGEST_CHARS - used - 4);
      const ended0 = endedSection(chat.finals, CAPS.ended, sq.earlier !== false);
      const asked = askedSection(chat.requests, Math.max(200, room - Math.min(ended0.length, CAPS.ended)), sq.middle !== false);
      const ended = endedSection(chat.finals, Math.max(120, room - asked.length), sq.earlier !== false);
      return join([head, asked, ended, ...fixed, state]);
    };
    for (const sq of SQUEEZES) { text = build(sq); if (text.length <= DIGEST_CHARS) break; }
    text = redact(text);
    // Whatever happens, the limit holds: the block is cut and closed again.
    if (text.length > DIGEST_CHARS) text = `${text.slice(0, DIGEST_CHARS - HANDOFF_CLOSE.length - 3).trimEnd()}\n…\n${HANDOFF_CLOSE}`;
  } catch { /* an empty record is still a valid one */ }
  return { text, tokens: tokensOf(text), counts };
}

// ---------- the transcript file ----------

const pad = (n) => String(n).padStart(2, '0');
function stamp(at) {
  const d = new Date(Number(at));
  if (!Number.isFinite(d.getTime()) || !at) return '';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
// A fence longer than any run of backticks inside, so the text cannot close it.
function fenced(text, lang = '') {
  const longest = Math.max(2, ...(str(text).match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}
function cutOutput(text) {
  const t = str(text).replace(/\s+$/, '');
  if (t.length <= STEP_OUTPUT_HEAD + STEP_OUTPUT_TAIL) return t;
  return `${t.slice(0, STEP_OUTPUT_HEAD)}\n… ${t.length - STEP_OUTPUT_HEAD - STEP_OUTPUT_TAIL} characters left out …\n${t.slice(t.length - STEP_OUTPUT_TAIL)}`;
}
function diffOf(name, input) {
  if (typeof input.diff === 'string' && input.diff.trim()) return input.diff.replace(/\s+$/, '');
  const sides = name === 'MultiEdit' ? list(input.edits) : name === 'Write' ? [{ old_string: '', new_string: input.content }] : [input];
  const lines = [];
  for (const s of sides) {
    if (str(s?.old_string)) lines.push(...str(s.old_string).split('\n').map((l) => `-${l}`));
    if (str(s?.new_string)) lines.push(...str(s.new_string).split('\n').map((l) => `+${l}`));
  }
  return lines.join('\n');
}
function stepBody(row) {
  const i = row.input;
  if (EDIT_TOOLS.has(row.name)) {
    const d = diffOf(row.name, i);
    return d ? fenced(d.length > DIFF_CAP ? `${d.slice(0, DIFF_CAP)}\n… ${d.length - DIFF_CAP} characters left out …` : d, 'diff') : '';
  }
  if (row.name === 'TodoWrite') return list(i.todos).filter(isObj).map(todoLine).join('\n');
  if (row.name === 'ExitPlanMode') return tidy(i.plan);
  if (row.name === 'AskUserQuestion') return list(i.questions).filter(isObj).map((q) => `- ${oneLine(q.question)}`).join('\n');
  if (row.name === 'Agent' || row.name === 'Task') return cut(tidy(i.prompt), 1200);
  if (['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(row.name)) return '';
  let json = '';
  try { json = JSON.stringify(i); } catch { json = ''; }
  return json && json !== '{}' ? fenced(cut(json, 600), 'json') : '';
}

/**
 * The whole chat as markdown: one "## Turn <n> · <when>" per message of the user's, "### User", "### Assistant", and
 * one "#### <what the step did>" per step with its output or diff in a fenced block. Thinking is left out, images
 * are counted and not embedded, a step's output is cut to its first 1,200 and last 800 characters and a diff to
 * 4,000. Over 4 MB the output of the earliest steps goes first, and the file says so at the top.
 * @param {object[]} events
 * @param {{ title?: string, fromModel?: string, cwd?: string, id?: string, max?: number }} about
 * @param {{ redact?: (s: string) => string }} [opts]
 * @returns {string}
 */
export function exportTranscript(events, about, opts) {
  const redact = typeof opts?.redact === 'function' ? opts.redact : plainRedact;
  const a = isObj(about) ? about : {};
  const max = Number.isFinite(a.max) && a.max > 0 ? a.max : TRANSCRIPT_MAX;
  try {
    const cwd = str(a.cwd);
    const turns = []; // { head, parts: [{ text, output }] }
    let cur = null;
    let n = 0;
    let said = false; // "### Assistant" is written once per turn
    const tools = new Map();
    const turn = (head) => { cur = { head, parts: [] }; turns.push(cur); said = false; return cur; };
    const add = (text, output = false, row = null) => { const p = { text, output, row }; (cur ?? turn('## Before the first message')).parts.push(p); return p; };
    const assistant = () => { if (!said) { add('### Assistant'); said = true; } };
    for (const ev of list(events)) {
      if (!isObj(ev)) continue;
      if (ev.kind === 'user-text') {
        if (ev.parent) continue;
        const text = tidy(stripHandoff(ev.text));
        const images = Number(ev.images) || 0;
        const note = images ? `(${images} image${images === 1 ? '' : 's'} attached, not included here)` : '';
        if (isRequest(ev)) {
          const when = stamp(ev.at);
          turn(`## Turn ${++n}${when ? ` · ${when}` : ''}`);
          add(['### User', text, note].filter(Boolean).join('\n'));
        } else add([`### User (${ev.command ? 'a command' : ev.bash ? 'a shell line' : 'sent for the user'})`, text, note].filter(Boolean).join('\n'));
        said = false;
      } else if (ev.kind === 'assistant-text') {
        const text = tidy(ev.text);
        if (!text) continue;
        assistant();
        add(ev.parent ? `(an agent) ${text}` : text);
      } else if (ev.kind === 'tool-start') {
        assistant();
        const row = { name: str(ev.name), input: isObj(ev.input) ? ev.input : {}, parent: ev.parent ?? null, title: null, out: null };
        row.title = add(`#### ${ev.parent ? '(an agent) ' : ''}${stepTitle(row.name, row.input, cwd)}`, false, row);
        const body = stepBody(row);
        if (body) add(body, true);
        if (str(ev.id)) tools.set(ev.id, row);
      } else if (ev.kind === 'tool-result') {
        const row = tools.get(str(ev.id));
        if (!row) continue;
        const failed = ev.isError === true;
        if (failed && row.title) row.title.text += ev.interrupted === true ? ' (did not finish)' : ' (failed)';
        const out = cutOutput(ev.content);
        // An edit's result only repeats what its diff shows; a failure is worth its words.
        if (out && (failed || !EDIT_TOOLS.has(row.name)) && row.name !== 'TodoWrite') add(fenced(out), true);
      } else if (ev.kind === 'notice' && (ev.code === 'compacted' || ev.code === 'interrupted')) {
        add(`_${ev.code === 'compacted' ? 'Earlier messages were summarized here.' : 'Stopped by the user.'}_`);
      } else if (ev.kind === 'turn-end' && ev.isError === true) {
        add(`_The turn failed: ${oneLine(list(ev.errors).join('; ') || str(ev.text)) || 'no reason given'}_`);
      }
    }
    const title = oneLine(a.title) || 'Chat';
    const about1 = [a.fromModel && `Ran on ${oneLine(a.fromModel)}`, cwd && `in ${cwd}`, a.id && `chat ${a.id}`].filter(Boolean).join(' · ');
    const render = (note) => [
      `# ${title}`, about1, 'The full record of a chat that was moved to another model, written by Canopy. Search it by "## Turn".', note,
      ...turns.map((t) => [t.head, ...t.parts.filter((p) => !p.gone).map((p) => p.text)].join('\n\n')),
    ].filter(Boolean).join('\n\n') + '\n';
    let out = render('');
    if (out.length > max) {
      // Step output goes first, the oldest turns first; then whole turns, the oldest first.
      const NOTE = '**This chat was too long to keep whole: the output of its earliest steps was left out.**';
      let size = out.length + NOTE.length + 2;
      for (const t of turns) {
        if (size <= max) break;
        for (const p of t.parts) if (p.output && !p.gone) { p.gone = true; size -= p.text.length + 2; }
      }
      out = render(NOTE);
      while (out.length > max && turns.length > 1) { turns.shift(); out = render('**This chat was too long to keep whole: its earliest turns were left out.**'); }
      if (out.length > max) out = out.slice(0, max);
    }
    return redact(out);
  } catch { return `# ${oneLine(a.title) || 'Chat'}\n\nThe transcript could not be written.\n`; }
}

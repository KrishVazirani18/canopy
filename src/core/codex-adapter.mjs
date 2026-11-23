// Codex adapter: translates `codex app-server` lines into Canopy's own event format,
// the same one adapter.mjs produces for Claude Code. The UI only ever sees these
// events, so a Codex chat reuses the transcript, the approval cards and the sidebar.
// If Codex changes its protocol, only this file changes. Nothing here throws and
// nothing here does I/O: a line that cannot be read becomes a `raw` event labelled
// `adapter-error`, and lines the adapter does not know are dropped unless `debug` is set.
//
//   adapt(msg, opts)             one parsed line in, zero or more events out, no memory
//   createAdapter(opts)          one per chat: { adapt, request, reset, usage }, with the
//                                memory a single line lacks (open items, streamed text,
//                                token counts, what was already said). A line of one of the
//                                chat's agents is handed over with `parent` (see opts): it is
//                                read with a memory of its own, and only its steps and words
//                                come out, each marked with the Agent row they belong under.
//   adaptHistory(turns, opts)    replay of a saved chat: the `data` of thread/turns/list
//                                (itemsView "full") or `thread.turns`, in either order
//   requestOf(msg, item, opts)   a server request (approval, question) described for
//                                Canopy's permission card, or null when it is not a
//                                question for the user. `item` is the item it is about.
//   replyTo(request, answer)     Canopy's answer as the result Codex expects:
//                                { result, stops }. `stops` means the answer ends the turn.
//   initEvent(result, extra)     a thread/start or thread/resume result as an `init` event
//
// A line is one JSON object from the pipe. There is no "jsonrpc" field, and server
// requests count their ids from 0, so a request is told from a response by `method`.
// Responses and server requests give [] from adapt: the session owns the RPC layer
// and raises `permission` events itself, with request() and replyTo().
//
// Two prompts are more than they look. A file change is approved as a whole, so its
// card carries every file it touches (`changes`, `toolUseIds`), not only the first.
// And "may I run this MCP tool?" arrives as an MCP elicitation marked
// `_meta.codex_approval_kind: "mcp_tool_call"`: it is described as an ordinary tool
// approval (`type: 'tool'`), never as a form.
//
// opts: {
//   threadId    this chat's thread: lines that name another thread are dropped
//   parent      createAdapter only: the line belongs to an agent of this chat (`threadId` is then the agent's
//               thread) whose work is drawn under the Agent row with this id. Every event that comes out carries
//               `parent` and `agentId`, and the agent's own turn never starts or ends the chat's turn.
//   model       string or () => string: stamped on assistant-text (Codex does not say per message)
//   debug       emit `raw` for unknown lines (capped at 8 KB)
//   unknown     (label, keys) => void: told about every line or item this file does not know, debug or not,
//               so the host can notice Codex changing under it. Gets the keys of the payload, never its content.
//   verbose     also surface deprecation notices, config warnings and known start-up chatter
//   images      true | false: carry tool-result image data (default: live yes; history only for the latest few
//               results that have any, see adaptHistory)
//   toolOutput  emit `tool-output` while a command prints (a kind the renderer has to opt in to)
//   inFlight    adaptHistory only: the last turn is still running, so leave its
//               unfinished tool calls open instead of marking them interrupted
//   now         clock for throttling (tests)
// }
import { stripLeads } from './notes.mjs';

import { NEARING_PERCENT, limitsFromCodex, nearingText, reachedText } from './limits.mjs';
import { shownName } from './tool-registry.mjs';
import { toolIcons } from './tool-icons.mjs';
import { answerOf as elicitAnswer, describe as describeElicitation } from './elicitation.mjs';
import { ANSI, COMPACTED, HISTORY_PICTURES, HISTORY_PICTURE_CHARS, IMAGE_CHARS, IMAGE_MAX, IMAGE_TYPES, NOTICE_CAP, RAW_CAP, STRUCTURED_CAP, TEXT_CAP, adapterError, brief, capText, exceeds, notice, rawEvent } from './adapter-shared.mjs';

const KB = 1024;
const INPUT_CAP = 32 * KB;
const HOOK_CAP = 8 * KB;
const THROTTLE_MS = 100;
const OPEN_MAX = 512;
const SAID_MAX = 64;
const TODO_MAX = 200;
const CHILD_MAX = 64;

const NOT_RUN = 'Not approved, so it did not run.';
const NOT_CHANGED = 'Not approved, so nothing was changed.';

const DATA_URL = /^data:(image\/[a-z+.-]+);base64,/i;
// `/bin/zsh -lc '…'`: Codex wraps every command in a login shell. The user should see what the model typed.
const SHELL_WRAP = /^(?:\S*\/)?(?:zsh|bash|sh|dash|ksh|fish)\s+-[a-z]*c\s+/;

// [error code for turn-end, sentence for the transcript]. No sentence means Codex's own words are shown.
const CODEX_ERRORS = {
  contextWindowExceeded: ['prompt-too-long', 'This chat is too long for the model. Start a new chat to carry on.'],
  usageLimitExceeded: ['rate-limit', 'You reached your usage limit.'],
  rateLimitExceeded: ['rate-limit', 'You hit a rate limit. Try again in a moment.'],
  sessionBudgetExceeded: ['budget', 'This chat reached its spending limit.'],
  serverOverloaded: ['overloaded', 'OpenAI is overloaded right now.'],
  internalServerError: ['overloaded', 'OpenAI had a problem on its side. Try again.'],
  unauthorized: ['auth', 'Codex needs you to sign in again.'],
  httpConnectionFailed: ['api', 'Could not reach OpenAI. Check your connection and try again.'],
  responseStreamConnectionFailed: ['api', 'Could not reach OpenAI. Check your connection and try again.'],
  responseStreamDisconnected: ['api', 'The connection to OpenAI dropped. Try again.'],
  responseTooManyFailedAttempts: ['api', 'OpenAI did not answer after several tries. Try again.'],
  badRequest: ['api', null],
  sandboxError: ['api', null],
  cyberPolicy: ['api', null],
  misalignmentPolicyViolation: ['api', null],
  threadRollbackFailed: ['api', null],
  activeTurnNotSteerable: ['api', null],
  other: ['api', null],
};

// Start-up lines that say nothing about the chat itself. Shown only with `verbose`.
const CHATTER = [/^Skill descriptions were shortened/i];

// Lines that carry nothing for the transcript. The session reads the ones it needs
// (thread status, settings echoes, MCP start-up, resolved requests) from the raw line.
const SILENT = new Set([
  'thread/started', 'thread/status/changed', 'thread/archived', 'thread/deleted', 'thread/unarchived', 'thread/closed',
  'thread/reverted', 'thread/name/updated', 'thread/readState/changed', 'thread/goal/updated', 'thread/goal/cleared', 'thread/queue/changed',
  'thread/project/updated', 'thread/environment/connected', 'thread/environment/disconnected', 'thread/settings/updated',
  'thread/tokenUsage/updated', 'project/changed', 'skills/changed', 'turn/diff/updated', 'turn/moderationMetadata',
  'item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'autoApprovalReview/strictReviewRequired',
  'rawResponseItem/completed', 'rawResponse/completed', 'command/exec/outputDelta', 'process/outputDelta', 'process/exited',
  'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress', 'serverRequest/resolved', 'mcpServer/oauthLogin/completed', 'mcpServer/startupStatus/updated',
  'mcpServer/event/stream/notification', 'account/updated', 'account/login/completed', 'app/list/updated',
  'remoteControl/status/changed', 'externalAgentConfig/import/progress', 'externalAgentConfig/import/completed', 'fs/changed',
  'model/verification', 'modelProvider/authRecoveryStarted', 'modelProvider/authRecoveryCompleted',
  'model/safetyBuffering/updated', 'fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted',
  'windows/worldWritableWarning', 'windowsSandbox/setupCompleted',
]);
const SILENT_PREFIX = 'thread/realtime/';

// Items that are known and have no row of their own.
const SILENT_ITEMS = new Set(['hookPrompt', 'functionCallOutput', 'subAgentActivity', 'sleep']);
// What an agent's line may say in the chat: its steps and its words, under its Agent row. Its turn starting and
// ending, its token counts and its notices are the agent's own business.
const CHILD_KINDS = new Set(['tool-start', 'tool-result', 'tool-output', 'tool-progress', 'assistant-text', 'thinking', 'raw']);
// Items whose details are only complete at the end, so their row starts and finishes together.
const LATE_ITEMS = new Set(['webSearch', 'imageGeneration']);

const PROMPTS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'item/tool/requestUserInput', 'mcpServer/elicitation/request',
]);
// Server requests that are not questions for the user. The session answers them (or refuses) itself.
const OTHER_REQUESTS = new Set([
  'item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read',
  'applyPatchApproval', 'execCommandApproval',
]);

const AGENT_VERBS = {
  spawnAgent: 'Start an agent', sendInput: 'Message an agent', sendMessage: 'Message an agent',
  followupTask: 'Give an agent a follow-up', resumeAgent: 'Resume an agent',
};

// ---- small helpers ----

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);
const strip = (v) => str(v).replace(ANSI, '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Codex gives whole seconds for turns and milliseconds for items.
const ms = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : null);

// A line or item this file does not know. The host hears about it (opts.unknown); the transcript only in debug.
function unknownFrame(opts, label, payload) {
  try { opts?.unknown?.(label, isObj(payload) ? Object.keys(payload).slice(0, 24) : []); } catch { /* observers never break the adapter */ }
  return opts?.debug ? [rawEvent(label, payload)] : [];
}

// Words passed through from Codex, as a notice may carry them (adapter-shared.mjs). Only a string is ever shown.
const noticeText = (text) => notice(str(text), 'Codex');

function modelOf(opts, state) {
  let m = opts?.model;
  if (typeof m === 'function') { try { m = m(); } catch { m = null; } }
  return (typeof m === 'string' && m) || state?.model || null;
}

// Appends to a remembered string without letting it grow past the cap.
function grow(have, more) {
  if (have.length >= TEXT_CAP) return have;
  return have.length + more.length > TEXT_CAP ? have + more.slice(0, TEXT_CAP - have.length) : have + more;
}

// ---- commands ----

// The rest of a command line as one shell word with its quotes removed, or null
// when it is more than one word (then it was not a simple wrapper after all).
function shellWord(rest) {
  let out = '';
  let i = 0;
  const n = rest.length;
  while (i < n) {
    const c = rest[i];
    if (c === "'") {
      const j = rest.indexOf("'", i + 1);
      if (j < 0) return null;
      out += rest.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= n) return null;
        const d = rest[i];
        if (d === '"') { i++; break; }
        if (d === '\\' && i + 1 < n && '"\\$`'.includes(rest[i + 1])) { out += rest[i + 1]; i += 2; }
        else { out += d; i++; }
      }
    } else if (c === '\\') {
      if (i + 1 >= n) return null;
      out += rest[i + 1];
      i += 2;
    } else if (c === ' ' || c === '\t' || c === '\n') return null;
    else { out += c; i++; }
  }
  return out;
}

function bareCommand(command) {
  const s = str(command);
  const m = SHELL_WRAP.exec(s);
  if (!m) return s;
  const word = shellWord(s.slice(m[0].length).trim());
  return word || s;
}

// Codex parses each command into actions. A command that is one read, one search
// or one listing is shown as that; everything else is a command.
function commandTool(src) {
  const actions = list(src?.commandActions).filter(isObj);
  const bare = clip(bareCommand(src?.command), INPUT_CAP);
  if (actions.length !== 1) return { name: 'Bash', input: { command: bare } };
  const a = actions[0];
  const typed = clip(str(a.command) || bare, INPUT_CAP);
  const path = str(a.path);
  if (a.type === 'read' && path) return { name: 'Read', input: { file_path: path, command: typed } };
  if (a.type === 'search') return { name: 'Grep', input: { pattern: str(a.query) || typed, ...(path && { path }), command: typed } };
  if (a.type === 'listFiles') return { name: 'Glob', input: { pattern: path || typed, ...(path && { path }), command: typed } };
  return { name: 'Bash', input: { command: typed } };
}

// ---- file changes ----

// A unified diff split into the text before and the text after. Codex sends hunks
// only (no file header), but a header is skipped if one ever shows up.
function sides(diff) {
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const before = [];
  const after = [];
  let inHunk = false;
  let hunks = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) { inHunk = true; hunks++; continue; }
    if (!inHunk) continue;
    const c = line[0];
    if (c === '-') before.push(line.slice(1));
    else if (c === '+') after.push(line.slice(1));
    else if (c === ' ') { before.push(line.slice(1)); after.push(line.slice(1)); }
    else if (line === '') { before.push(''); after.push(''); }
    // "\ No newline at end of file" and anything else is not content.
  }
  return { hunks, before: before.join('\n'), after: after.join('\n') };
}

// A new or removed file arrives as its plain content. It is read as a diff only when it opens like one.
const HUNKED = /^(?:(?:diff |index |--- |\+\+\+ )[^\n]*\n)*@@ -\d/;

function changeRow(item, change, index) {
  const c = isObj(change) ? change : {};
  const file = str(c.path);
  const kind = isObj(c.kind) ? str(c.kind.type) : str(c.kind);
  const full = str(c.diff);
  const diff = capText(full);
  const id = index === 0 ? item.id : `${item.id}#${index}`;
  const s = kind === 'add' || kind === 'delete' ? (HUNKED.test(full) ? sides(full) : { hunks: 0, before: '', after: '' }) : sides(full);
  let truncated = diff.truncated;
  const fit = (text) => { const t = capText(text); if (t.truncated) truncated = true; return t.text; };
  let name = 'Edit';
  let input;
  if (kind === 'add') {
    name = 'Write';
    input = { file_path: file, content: fit(s.hunks ? s.after : full) };
  } else if (kind === 'delete') {
    input = { file_path: file, old_string: fit(s.hunks ? s.before : full), new_string: '', deleted: true };
  } else {
    const moved = isObj(c.kind) ? str(c.kind.move_path) : '';
    // `diff` is what Codex sent. old_string / new_string are the two sides of it, which is what an Edit row already draws.
    input = { file_path: file, old_string: fit(s.before), new_string: fit(s.after), diff: diff.text, ...(moved && { moved_to: moved }) };
  }
  if (truncated) input.truncated = true;
  return { id, name, input, change: kind || 'update' };
}

// ---- other tools ----

function argsOf(v) {
  if (v == null) return {};
  if (!isObj(v)) return { value: typeof v === 'string' ? clip(v, INPUT_CAP) : v };
  return exceeds(v, STRUCTURED_CAP) ? { truncated: true } : v;
}

function webTool(item) {
  const a = isObj(item.action) ? item.action : {};
  if (a.type === 'openPage' || a.type === 'findInPage') {
    const pattern = str(a.pattern);
    return { name: 'WebFetch', input: { url: str(a.url), ...(pattern && { prompt: pattern }) } };
  }
  const queries = list(a.queries).filter((q) => typeof q === 'string' && q).slice(0, 12);
  const query = str(item.query) || str(a.query) || queries[0] || '';
  return { name: 'WebSearch', input: { query: clip(query, INPUT_CAP), ...(queries.length > 1 && { queries }) } };
}

// An MCP tool's name, as Claude Code writes one. Canopy's own tools reach Codex through one server (tool-relay.mjs)
// and go by the name a Claude chat calls them, so the window draws a look or a read of another chat the same in both.
const mcpName = (server, tool) => shownName(server, tool) ?? `mcp__${server || 'server'}__${tool || 'tool'}`;

// The rows an item draws: [{ id, name, input }]. [] for a known item with no row, null for an item that is not a tool.
function toolRows(item) {
  const id = item.id;
  switch (item.type) {
    case 'commandExecution': return [{ id, ...commandTool(item) }];
    case 'fileChange': return list(item.changes).map((c, i) => changeRow(item, c, i));
    case 'mcpToolCall': return [{ id, name: mcpName(str(item.server), str(item.tool)), input: argsOf(item.arguments) }];
    case 'dynamicToolCall':
      return [{ id, name: item.namespace ? `mcp__${item.namespace}__${str(item.tool) || 'tool'}` : str(item.tool) || 'tool', input: argsOf(item.arguments) }];
    case 'webSearch': return [{ id, ...webTool(item) }];
    // Codex looked at a picture on disk: a Read row marked `image`, which the window names and draws as the picture.
    case 'imageView': return [{ id, name: 'Read', input: { file_path: str(item.path), image: true } }];
    case 'imageGeneration': return [{ id, name: 'ImageGeneration', input: { prompt: clip(str(item.revisedPrompt), INPUT_CAP) } }];
    case 'collabAgentToolCall': {
      // Only the calls that hand an agent some work get a row. Waiting, listing and closing say nothing to the user.
      const prompt = str(item.prompt);
      if (!prompt) return [];
      const model = str(item.model);
      return [{ id, name: 'Agent', input: { description: AGENT_VERBS[item.tool] ?? 'Agent', prompt: clip(prompt, INPUT_CAP), ...(model && { model }) } }];
    }
    default: return null;
  }
}

// A row is found again by its id (its result, its approval card), so an item without one cannot be drawn.
const rowable = (item) => typeof item.id === 'string' && item.id !== '';

const hasStatus = (item) => item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall'
  || item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall';

// MCP content blocks (text, image, resource) as text plus the images worth carrying.
function contentParts(content, keepImages) {
  const lines = [];
  const images = [];
  let omitted = 0;
  let chars = 0;
  const image = (mediaType, data) => {
    lines.push('[image]');
    // Inline data only, and only raster types: a tool result must not make the UI fetch a URL or run SVG.
    const ok = keepImages && typeof data === 'string' && IMAGE_TYPES.has(mediaType) && images.length < IMAGE_MAX && chars + data.length <= IMAGE_CHARS;
    if (ok) { chars += data.length; images.push({ mediaType, data }); } else omitted++;
  };
  for (const b of list(content)) {
    if (b == null) continue;
    if (typeof b === 'string') { lines.push(b); continue; }
    if (!isObj(b)) { lines.push(String(b)); continue; }
    switch (b.type) {
      case 'text': case 'inputText': lines.push(str(b.text)); break;
      case 'image': image(b.mimeType ?? b.mediaType, b.data); break;
      case 'inputImage': {
        const url = str(b.imageUrl);
        const m = DATA_URL.exec(url);
        if (m) image(m[1].toLowerCase(), url.slice(m[0].length));
        else { lines.push('[image]'); omitted++; }
        break;
      }
      case 'audio': case 'inputAudio': lines.push('[audio]'); break;
      case 'resource': {
        const r = isObj(b.resource) ? b.resource : {};
        lines.push(typeof r.text === 'string' ? r.text : `[resource${r.uri ? `: ${r.uri}` : ''}]`);
        break;
      }
      case 'resource_link': lines.push(b.uri ? `${b.name ? `${b.name}\n` : ''}${b.uri}` : '[resource]'); break;
      default: lines.push(`[${typeof b.type === 'string' ? b.type : 'unknown'}]`);
    }
  }
  return { text: lines.join('\n'), images, omitted };
}

function structuredOf(r) {
  if (r == null) return null;
  if (typeof r === 'string') return r.length > STRUCTURED_CAP ? { truncated: true, type: 'text' } : r;
  if (typeof r !== 'object' || !exceeds(r, STRUCTURED_CAP)) return r;
  return { truncated: true, type: r.type ?? null };
}

// What one row of a finished item says: { text, isError, images, omitted, structured, declined }.
function outcome(item, row, ctx) {
  const o = { text: '', isError: false, images: [], omitted: 0, structured: null, declined: false };
  const keepImages = ctx.history ? ctx.opts.images === true || ctx.opts.pictures?.has(item.id) === true : ctx.opts.images !== false;
  const status = str(item.status);
  const why = ctx.state?.reviews.get(item.id);
  const declinedText = (base) => (why ? `${base} The automatic review said: ${why}` : base);
  switch (item.type) {
    case 'commandExecution': {
      const code = typeof item.exitCode === 'number' ? item.exitCode : null;
      // A quick command sends no deltas, and a streamed one may come back with nothing aggregated.
      o.text = strip(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ctx.rec?.out ?? '');
      o.structured = { status: status || null, exitCode: code, durationMs: typeof item.durationMs === 'number' ? item.durationMs : null };
      if (status === 'declined') { o.isError = true; o.declined = true; o.text = o.text.trim() ? o.text : declinedText(NOT_RUN); }
      else if (status === 'failed' || (code !== null && code !== 0)) {
        o.isError = true;
        if (!o.text.trim()) o.text = code !== null ? `Exit code ${code}` : 'The command failed.';
      }
      break;
    }
    case 'fileChange': {
      o.structured = { status: status || null, change: row.change ?? null, path: row.input?.file_path ?? null };
      if (status === 'declined') { o.isError = true; o.declined = true; o.text = declinedText(NOT_CHANGED); }
      else if (status === 'failed') {
        o.isError = true;
        const said = strip(ctx.rec?.note ?? '').trim();
        o.text = said ? `This change could not be made.\n${said}` : 'This change could not be made.';
      } else o.text = row.change === 'add' ? 'File created' : row.change === 'delete' ? 'File deleted' : 'File updated';
      break;
    }
    case 'mcpToolCall': {
      const err = isObj(item.error) ? item.error : null;
      if (err || status === 'failed') { o.isError = true; o.text = str(err?.message) || 'The tool call failed.'; break; }
      const result = isObj(item.result) ? item.result : {};
      const parts = contentParts(result.content, keepImages);
      o.text = parts.text; o.images = parts.images; o.omitted = parts.omitted;
      o.structured = structuredOf(result.structuredContent);
      break;
    }
    case 'dynamicToolCall': {
      const parts = contentParts(item.contentItems, keepImages);
      o.text = parts.text; o.images = parts.images; o.omitted = parts.omitted;
      o.isError = item.success === false || status === 'failed';
      if (o.isError && !o.text.trim()) o.text = 'The tool call failed.';
      break;
    }
    case 'webSearch': {
      const queries = list(item.action?.queries).filter((q) => typeof q === 'string' && q);
      o.text = queries.length > 1 ? queries.join('\n') : '';
      break;
    }
    case 'imageView': o.text = '[image]'; break;
    case 'imageGeneration': {
      if (item.failure != null || status === 'failed') {
        o.isError = true;
        o.text = str(item.failure?.message) || (typeof item.failure === 'string' ? item.failure : '') || 'The image could not be made.';
        break;
      }
      const saved = str(item.savedPath);
      o.text = saved ? `Saved to ${saved}` : '[image]';
      const data = str(item.result);
      if (keepImages && data && data.length <= IMAGE_CHARS && /^[A-Za-z0-9+/]{16}/.test(data)) o.images = [{ mediaType: 'image/png', data }];
      else if (data) o.omitted = 1;
      break;
    }
    case 'collabAgentToolCall':
      o.isError = status === 'failed';
      if (o.isError) o.text = 'The agent could not be reached.';
      break;
    default: break;
  }
  return o;
}

function startEvent(row, item, ctx) {
  const icons = toolIcons(item);
  return { kind: 'tool-start', id: row.id, name: row.name, input: row.input ?? {}, ...common(item, ctx), ...(icons.length ? { icons } : {}) };
}

function resultEvent(row, item, ctx) {
  const o = outcome(item, row, ctx);
  const capped = capText(o.text);
  const ev = {
    kind: 'tool-result', id: row.id, content: capped.text, isError: o.isError, parent: null, uuid: item.id ?? null, at: ctx.at,
    images: o.images, imagesOmitted: o.omitted, truncated: capped.truncated, fullLength: o.text.length,
    structured: o.structured, detached: false,
  };
  if (o.declined) ev.declined = true;
  const raw = item.result ?? item;
  const serverIcons = toolIcons(raw?._meta?.['io.modelcontextprotocol/serverInfo']);
  if (serverIcons.length) ev.serverIcons = serverIcons;
  const icons = toolIcons(raw && typeof raw === 'object' ? { ...raw, _meta: undefined } : null);
  if (icons.length) ev.icons = icons;
  return ev;
}

// A call that never got its result: the turn was stopped, failed, or the app closed.
function interruptedResult(id, start, history) {
  const ev = {
    kind: 'tool-result', id, content: '', isError: true, interrupted: true,
    parent: start?.parent ?? null, uuid: start?.uuid ?? null, at: start?.at ?? null,
    images: [], imagesOmitted: 0, truncated: false, fullLength: 0, structured: null, detached: false,
  };
  if (history) ev.history = true;
  return ev;
}

// ---- items ----

function common(item, ctx) {
  return { parent: null, uuid: item.id ?? null, at: ctx.at, messageId: item.id ?? null, agentId: null, turnId: ctx.turnId ?? null };
}

function inputText(content) {
  const text = [];
  const imageData = [];
  let images = 0;
  for (const c of list(content)) {
    if (!isObj(c)) continue;
    if (c.type === 'text' && typeof c.text === 'string') text.push(c.text);
    else if (c.type === 'image' || c.type === 'localImage') {
      images++;
      // Thumbnails for the prompt bubble (capped so a long history stays light). Only inline data: nothing is fetched or read.
      const url = str(c.url);
      const m = DATA_URL.exec(url);
      if (m && IMAGE_TYPES.has(m[1].toLowerCase()) && imageData.length < 6 && url.length <= 2_000_000) imageData.push({ mediaType: m[1].toLowerCase(), data: url.slice(m[0].length) });
    }
  }
  return { text: text.join('\n'), images, imageData };
}

function userEvents(item, ctx) {
  const { text: sent, images, imageData } = inputText(item.content);
  const text = stripLeads(sent); // a moved chat's digest or a note of Canopy's, when it had to ride in the message, is not the user's words
  if (!text.trim() && !images) return [];
  const ev = { kind: 'user-text', text: text || (images === 1 ? '[image]' : `[${images} images]`), images, documents: 0, uuid: item.id ?? null, at: ctx.at };
  if (imageData.length) ev.imageData = imageData;
  return [ev];
}

function textEvent(item, text, ctx, aborted) {
  const ev = { kind: 'assistant-text', text, model: modelOf(ctx.opts, ctx.state), ...common(item, ctx), aborted, phase: item.phase ?? null };
  if (item.type === 'plan') ev.plan = true;
  // Codex asked without waiting for the answer: the text already lists the choices, and they travel along for a UI that wants them.
  const questions = list(item.questions).filter(isObj).slice(0, 8);
  if (questions.length) {
    ev.questions = questions.map((q) => ({ question: clip(str(q.title), NOTICE_CAP), options: list(q.options).filter((x) => typeof x === 'string').slice(0, 12).map((x) => clip(x, NOTICE_CAP)) }));
  }
  if (ctx.state && !aborted) {
    ctx.state.lastText = text;
    if (item.phase === 'final_answer' && !questions.length) ctx.state.answer = text;
  }
  return ev;
}

// A review's result is the turn's reply. Codex may also send it as an ordinary message: then it is said once.
function reviewEvents(item, ctx) {
  const text = str(item.review);
  const out = ctx.history ? [] : [{ kind: 'status', status: null }];
  if (!text.trim() || ctx.state?.lastText === text) return out;
  out.push(textEvent({ id: item.id, type: 'agentMessage', phase: 'final_answer' }, text, ctx, false));
  return out;
}

function reasoningText(item) {
  const join = (parts) => list(parts).filter((s) => typeof s === 'string' && s.trim()).join('\n\n');
  return join(item.summary) || join(item.content);
}

function compactedEvents(key, ctx, history) {
  if (ctx.state) {
    // One notice per turn: Codex reports a compaction as an item and, on older builds, as a line of its own too.
    if (ctx.state.compactedIn === key) return [];
    ctx.state.compactedIn = key;
  }
  const notice = { kind: 'notice', text: COMPACTED, code: 'compacted', at: ctx.at };
  if (history) { notice.history = true; return [notice]; }
  return [{ kind: 'status', status: null }, notice];
}

// Remembers an item while it is open. Returns null when there is no memory to keep it in.
function open(state, id, type) {
  if (!state || typeof id !== 'string') return null;
  let rec = state.items.get(id);
  if (!rec) {
    if (state.items.size >= OPEN_MAX) state.items.delete(state.items.keys().next().value);
    rec = { type, item: null, text: '', summary: false, started: new Map(), out: '', pending: '', sentAt: -Infinity, note: '' };
    state.items.set(id, rec);
  }
  return rec;
}

function itemStarted(p, ctx) {
  const item = p.item;
  if (!isObj(item)) return unknownFrame(ctx.opts, 'codex/item/unknown', p);
  const rec = open(ctx.state, item.id, item.type);
  if (rec) { rec.type = item.type; rec.item = item; }
  switch (item.type) {
    // Our own prompts are drawn by the UI when sent, so the echo says nothing new.
    case 'userMessage': case 'agentMessage': case 'reasoning': case 'plan': return [];
    case 'contextCompaction': return [{ kind: 'status', status: 'compacting' }];
    // `/review`: the status line says so while it runs. What it found arrives when it leaves review mode.
    case 'enteredReviewMode': return [{ kind: 'status', status: 'reviewing' }];
    case 'exitedReviewMode': return [];
    default: {
      if (SILENT_ITEMS.has(item.type)) return [];
      if (LATE_ITEMS.has(item.type)) return [];
      const rows = toolRows(item);
      if (!rows || !rowable(item)) return unknownFrame(ctx.opts, `codex/item/${item.type ?? 'unknown'}`, item);
      const out = [];
      for (const row of rows) {
        const ev = startEvent(row, item, ctx);
        rec?.started.set(row.id, ev);
        out.push(ev);
      }
      return out;
    }
  }
}

// Whatever a finished item says. `opens` means a row whose start was not reported is
// opened here too (history, a start that was missed). Without it only the result goes
// out, which is all a caller with no memory can safely say.
function itemFinished(item, ctx, opens) {
  switch (item.type) {
    case 'userMessage': return ctx.history ? userEvents(item, ctx) : [];
    case 'agentMessage': case 'plan': {
      const text = str(item.text) || ctx.rec?.text || '';
      return text.trim() ? [textEvent(item, text, ctx, false)] : [];
    }
    case 'reasoning': {
      // Codex opens and closes an empty reasoning item on almost every step.
      const text = reasoningText(item) || (ctx.rec?.text.trim() ? ctx.rec.text : '');
      return text ? [{ kind: 'thinking', text, ...common(item, ctx) }] : [];
    }
    case 'contextCompaction': return compactedEvents(ctx.turnId ?? item.id, ctx, ctx.history);
    case 'enteredReviewMode': return ctx.history ? [] : [{ kind: 'status', status: 'reviewing' }];
    case 'exitedReviewMode': return reviewEvents(item, ctx);
    default: {
      if (SILENT_ITEMS.has(item.type)) return [];
      const rows = toolRows(item);
      if (!rows || !rowable(item)) return unknownFrame(ctx.opts, `codex/item/${item.type ?? 'unknown'}`, item);
      // In a saved chat an item can still be marked as running: its row is opened and left for the caller to close.
      const done = !hasStatus(item) || item.status !== 'inProgress';
      const out = [];
      for (const row of rows) {
        const seen = ctx.rec?.started.has(row.id);
        if (!seen && (opens || LATE_ITEMS.has(item.type))) out.push(startEvent(row, item, ctx));
        if (done) out.push(resultEvent(row, item, ctx));
      }
      return out;
    }
  }
}

function itemCompleted(p, ctx) {
  const item = p.item;
  if (!isObj(item)) return unknownFrame(ctx.opts, 'codex/item/unknown', p);
  const state = ctx.state;
  const rec = state && typeof item.id === 'string' ? state.items.get(item.id) ?? null : null;
  const out = [];
  // The throttle may have held back the last of a command's output.
  if (rec?.pending && ctx.opts.toolOutput) { out.push({ kind: 'tool-output', id: item.id, text: rec.pending }); rec.pending = ''; }
  const events = itemFinished(item, { ...ctx, rec }, !!state);
  out.push(...events);
  if (rec) {
    if (hasStatus(item) && item.status === 'inProgress') {
      // "Completed" but still marked as running: nothing was closed, so the rows stay open for the turn's end to close.
      rec.item = item;
      for (const ev of events) if (ev.kind === 'tool-start') rec.started.set(ev.id, ev);
      return out;
    }
    // A row that was opened but is not among the finished ones (the item changed between its two lines) is closed too.
    const closed = new Set();
    for (const ev of events) if (ev.kind === 'tool-result') closed.add(ev.id);
    for (const [rowId, start] of rec.started) if (!closed.has(rowId)) out.push(interruptedResult(rowId, start, false));
  }
  if (state && typeof item.id === 'string') { state.items.delete(item.id); state.reviews.delete(item.id); }
  return out;
}

// ---- streaming ----

function textDelta(p, ctx) {
  const text = str(p.delta);
  if (!text) return [];
  const rec = open(ctx.state, p.itemId, 'agentMessage');
  if (rec) rec.text = grow(rec.text, text);
  return [{ kind: 'text-delta', text, index: 0, messageId: p.itemId ?? null }];
}

function thinkingDelta(p, ctx, summary) {
  const text = str(p.delta);
  if (!text) return [];
  const rec = open(ctx.state, p.itemId, 'reasoning');
  if (rec) {
    // The summary is what is meant to be read. Raw reasoning is shown only for a model that sends no summary.
    if (summary) rec.summary = true;
    else if (rec.summary) return [];
    rec.text = grow(rec.text, text);
  }
  return [{ kind: 'thinking-delta', text, index: num(summary ? p.summaryIndex : p.contentIndex), messageId: p.itemId ?? null }];
}

// A second summary part starts a new paragraph.
function thinkingBreak(p, ctx) {
  if (!(num(p.summaryIndex) > 0)) return [];
  const rec = open(ctx.state, p.itemId, 'reasoning');
  if (rec) { if (!rec.text) return []; rec.text = grow(rec.text, '\n\n'); }
  return [{ kind: 'thinking-delta', text: '\n\n', index: num(p.summaryIndex), messageId: p.itemId ?? null }];
}

function outputDelta(p, ctx) {
  const text = strip(p.delta);
  if (!text || typeof p.itemId !== 'string') return [];
  const rec = open(ctx.state, p.itemId, 'commandExecution');
  if (!rec) return ctx.opts.toolOutput ? [{ kind: 'tool-output', id: p.itemId, text }] : [];
  rec.out = grow(rec.out, text);
  if (!ctx.opts.toolOutput) return [];
  rec.pending = grow(rec.pending, text);
  const now = ctx.state.now();
  if (now - rec.sentAt < THROTTLE_MS) return [];
  rec.sentAt = now;
  const ev = { kind: 'tool-output', id: p.itemId, text: rec.pending };
  rec.pending = '';
  return [ev];
}

// ---- to-do list ----

// Claude's to-do list reaches the transcript as a TodoWrite row, so Codex's plan does too.
function planEvents(p, ctx) {
  const todos = list(p.plan).filter(isObj).slice(0, TODO_MAX).map((s) => {
    const content = clip(str(s.step), NOTICE_CAP);
    return { content, status: s.status === 'inProgress' ? 'in_progress' : s.status === 'completed' ? 'completed' : 'pending', activeForm: content };
  });
  if (!todos.length) return [];
  const state = ctx.state;
  let n = 0;
  if (state) {
    const key = JSON.stringify(todos);
    if (state.lastPlan === key) return [];
    state.lastPlan = key;
    n = ++state.plans;
  }
  const id = `plan:${p.turnId ?? 'turn'}:${n}`;
  const explanation = clip(str(p.explanation), NOTICE_CAP);
  const shared = { parent: null, uuid: null, at: ctx.at };
  return [
    { kind: 'tool-start', id, name: 'TodoWrite', input: { todos, ...(explanation && { explanation }) }, ...shared, messageId: null, agentId: null, turnId: p.turnId ?? null },
    { kind: 'tool-result', id, content: 'To-do list updated', isError: false, ...shared, images: [], imagesOmitted: 0, truncated: false, fullLength: 18, structured: null, detached: false },
  ];
}

// ---- notices ----

function hookEvents(p, done) {
  const run = isObj(p.run) ? p.run : {};
  const event = str(run.eventName);
  const name = event ? event[0].toUpperCase() + event.slice(1) : 'hook';
  const entries = list(run.entries).filter(isObj);
  const text = (pick) => clip(entries.filter(pick).map((e) => str(e.text)).filter(Boolean).join('\n'), HOOK_CAP);
  return [{
    kind: 'hook', subtype: done ? 'hook_response' : 'hook_started', id: run.id ?? null, event: event ? name : null, name,
    output: text(() => true) || str(run.statusMessage), stderr: text((e) => e.kind === 'error'), exitCode: undefined,
    outcome: done ? run.status ?? null : null,
  }];
}

function errorInfo(error) {
  const info = error?.codexErrorInfo;
  let name = null;
  let http = null;
  if (typeof info === 'string') name = info;
  else if (isObj(info)) {
    name = Object.keys(info)[0] ?? null;
    const status = info[name]?.httpStatusCode;
    if (typeof status === 'number') http = status;
  }
  let code = name ? CODEX_ERRORS[name]?.[0] ?? 'api' : null;
  if (http === 401 || http === 403) code = 'auth';
  else if (http === 429) code = 'rate-limit';
  else if (http !== null && http >= 500) code = 'overloaded';
  return { name, http, code };
}

function errorNotice(error, at, history) {
  const e = isObj(error) ? error : {};
  const info = errorInfo(e);
  const own = noticeText(e.message);
  const ev = {
    kind: 'notice', level: 'warn', code: 'api-error', apiError: info.name, errorCode: info.code, apiStatus: info.http,
    text: (info.name && CODEX_ERRORS[info.name]?.[1]) || own || 'Codex reported an error.', at,
  };
  const detail = noticeText(e.additionalDetails);
  if (detail) ev.detail = detail;
  if (history) ev.history = true;
  return ev;
}

function errorEvents(p, ctx) {
  const e = isObj(p.error) ? p.error : {};
  if (p.willRetry === true) {
    return [{ kind: 'status', status: 'retrying', attempt: null, maxRetries: null, retryDelayMs: null, errorStatus: errorInfo(e).http, error: brief(strip(e.message)) || null }];
  }
  if (ctx.state) ctx.state.errorSaid = true;
  return [errorNotice(e, ctx.at, false)];
}

// Says a thing once per chat process. True when it was already said.
function said(state, key) {
  if (!state) return false;
  if (state.said.has(key)) return true;
  if (state.said.size >= SAID_MAX) state.said.delete(state.said.values().next().value);
  state.said.add(key);
  return false;
}

function warningEvents(p, ctx, extra) {
  const text = noticeText(p.message ?? p.summary);
  if (!text) return [];
  if (!ctx.opts.verbose && (extra.quiet || CHATTER.some((re) => re.test(text)))) return [];
  if (said(ctx.state, `${extra.code}\n${text}`)) return [];
  const ev = { kind: 'notice', text, code: extra.code, at: ctx.at };
  if (extra.level) ev.level = extra.level;
  const details = noticeText(p.details);
  if (details) ev.detail = details;
  return [ev];
}

// A window that is nearly used up is said once: again only when the window itself has moved on (a new reset time).
function nearingEvents(limits, ctx) {
  const out = [];
  for (const l of limits) {
    if (l.usedPercent < NEARING_PERCENT || l.usedPercent >= 100) continue;
    if (said(ctx.state, `near|${l.id}|${l.resetsAt ?? ''}`)) continue;
    out.push({
      kind: 'notice', code: 'rate-limit-warning', resetsAt: l.resetsAt, at: ctx.at,
      rateLimit: { status: 'allowed_warning', rateLimitType: l.id, resetsAt: l.resetsAt, utilization: l.usedPercent / 100 },
      text: nearingText(l),
    });
  }
  return out;
}

// The two limit notices are worded in limits.mjs, the same sentences a Claude chat says.
function rateLimitEvents(p, ctx) {
  const r = isObj(p.rateLimits) ? p.rateLimits : {};
  const limits = limitsFromCodex(r);
  const reached = str(r.rateLimitReachedType);
  if (!reached) { if (ctx.state) ctx.state.rateKey = null; return nearingEvents(limits, ctx); }
  // The limit that is used up is the full window that resets last; with none marked full, no limit is named.
  const full = limits.filter((l) => l.usedPercent >= 100).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0] ?? null;
  const resetsAt = full?.resetsAt ?? limits[0]?.resetsAt ?? null;
  if (ctx.state) {
    const key = `${reached}|${resetsAt ?? ''}`;
    if (ctx.state.rateKey === key) return [];
    ctx.state.rateKey = key;
  }
  const credits = reached.includes('credits');
  return [{
    kind: 'notice', level: 'warn', code: 'rate-limit', resetsAt, at: ctx.at,
    rateLimit: { status: 'rejected', rateLimitType: reached, resetsAt, limitName: r.limitName ?? null },
    text: credits ? 'Your OpenAI workspace is out of credits.' : reachedText({ name: full?.name, resetsAt }),
  }];
}

// ---- turns ----

function claudeShaped(u) {
  if (!isObj(u)) return null;
  const cached = num(u.cachedInputTokens);
  const written = num(u.cacheWriteInputTokens);
  return {
    // OpenAI counts cached and cache-written tokens inside the input; Canopy's usage keeps the three apart.
    inputTokens: Math.max(0, num(u.inputTokens) - cached - written), outputTokens: num(u.outputTokens),
    cacheReadInputTokens: cached, cacheCreationInputTokens: written, thinkingTokens: num(u.reasoningOutputTokens), webSearchRequests: 0,
  };
}

function minus(a, b) {
  if (!isObj(a)) return null;
  const out = {};
  for (const k of Object.keys(a)) out[k] = Math.max(0, num(a[k]) - num(b?.[k]));
  return out;
}

function noteUsage(state, p) {
  const u = p.tokenUsage;
  if (!state || !isObj(u)) return;
  state.usage = { total: isObj(u.total) ? u.total : null, last: isObj(u.last) ? u.last : null, window: typeof u.modelContextWindow === 'number' ? u.modelContextWindow : null };
  // Codex replays the last known counts when a chat is reopened: that is where the next turn starts from, not a model call.
  if (state.turnId) state.calls++;
  else state.base = state.usage.total;
}

function turnEnd(turn, ctx, extra) {
  const status = str(turn.status);
  const interrupted = status === 'interrupted';
  const failed = status === 'failed';
  const error = failed && isObj(turn.error) ? turn.error : null;
  const info = errorInfo(error);
  const message = error ? noticeText(error.message) : '';
  const usage = ctx.state?.usage ?? null;
  const ev = {
    kind: 'turn-end', subtype: interrupted ? 'interrupted' : failed ? 'error' : 'success', isError: failed,
    cost: null, durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null, turns: extra.calls ?? null,
    errors: failed ? [message || 'Codex reported an error.'] : [], text: extra.text ?? '',
    fastState: null, fastReason: null,
    interrupted, turnCost: null, turnUsage: extra.turnUsage ?? null,
    apiMs: null, ttftMs: null, ttftStreamMs: null, timeToRequestMs: null,
    stopReason: null, terminalReason: null, apiStatus: failed ? info.http : null,
    usage: claudeShaped(usage?.last), modelUsage: null,
    denials: [], queued: 0, origin: null,
    userUuid: null, userUuids: [], sessionId: extra.threadId ?? null,
    localCommand: null, startupFailure: null, credentialExpiresAt: null,
    errorCode: failed ? info.code ?? 'api' : null,
    reason: failed && info.code === 'budget' ? 'Stopped: spending limit reached.' : null,
    turnId: turn.id ?? null, startedAt: ms(turn.startedAt), completedAt: ms(turn.completedAt), at: ctx.at,
    contextTokens: usage?.last ? num(usage.last.totalTokens) : null, contextWindow: usage?.window ?? null,
    // Which model ran the turn, for its footer. Codex keeps none per turn, so a saved turn has none here
    // (the host puts back the ones it noted: src/codex-turn-models.mjs).
    model: ctx.history ? null : modelOf(ctx.opts, ctx.state),
  };
  if (ctx.history) ev.history = true;
  return ev;
}

function turnStarted(p, ctx) {
  const turn = isObj(p.turn) ? p.turn : {};
  const state = ctx.state;
  if (state) {
    state.turnId = turn.id ?? null;
    state.calls = 0;
    state.base = state.usage?.total ?? null;
    state.errorSaid = false;
    state.answer = '';
    state.lastText = '';
    state.lastPlan = null;
  }
  return [{ kind: 'message-start', model: modelOf(ctx.opts, state), messageId: turn.id ?? null, turnId: turn.id ?? null }];
}

function turnCompleted(p, ctx) {
  const turn = isObj(p.turn) ? p.turn : {};
  const state = ctx.state;
  const out = [];
  const clean = str(turn.status) === 'completed';
  const extra = { threadId: p.threadId ?? ctx.opts.threadId ?? null };
  if (state) {
    // A stopped turn never closes what was streaming: Codex sends no item/completed for it.
    for (const [id, rec] of state.items) {
      const item = rec.item ?? { id, type: rec.type };
      const c = { ...ctx, rec, turnId: turn.id ?? ctx.turnId };
      if ((rec.type === 'agentMessage' || rec.type === 'plan') && rec.text.trim()) out.push(textEvent(item, rec.text, c, !clean));
      else if (rec.type === 'reasoning' && rec.text.trim()) out.push({ kind: 'thinking', text: rec.text, ...common(item, c) });
      for (const [rowId, start] of rec.started) out.push(interruptedResult(rowId, start, false));
    }
    state.items.clear();
    state.reviews.clear();
    if (str(turn.status) === 'failed' && !state.errorSaid) out.push(errorNotice(turn.error, ctx.at, false));
    const final = list(turn.items).filter((i) => isObj(i) && i.type === 'agentMessage' && typeof i.text === 'string').at(-1);
    extra.text = state.answer || str(final?.text) || state.lastText;
    extra.calls = state.calls;
    extra.turnUsage = state.usage?.total ? claudeShaped(minus(state.usage.total, state.base)) : null;
  } else {
    const final = list(turn.items).filter((i) => isObj(i) && i.type === 'agentMessage' && typeof i.text === 'string').at(-1);
    extra.text = str(final?.text);
  }
  out.push(turnEnd(turn, ctx, extra));
  if (state) {
    state.turnId = null;
    state.calls = 0;
    state.base = state.usage?.total ?? null;
    state.errorSaid = false;
    state.answer = '';
    state.lastText = '';
    state.lastPlan = null;
  }
  return out;
}

// ---- entry points ----

// A line that names a thread other than this chat's (another chat on the same process, or a sub-agent's thread).
function foreign(p, opts) {
  const mine = opts?.threadId;
  if (typeof mine !== 'string' || !mine) return false;
  const theirs = typeof p.threadId === 'string' ? p.threadId : typeof p.thread?.id === 'string' ? p.thread.id : null;
  return theirs !== null && theirs !== mine;
}

function run(m, opts, state) {
  try {
    if (!isObj(m)) return unknownFrame(opts, 'codex/unknown', m);
    const method = typeof m.method === 'string' ? m.method : null;
    if (!method) {
      // A response to one of the session's own calls.
      if ('id' in m && ('result' in m || 'error' in m)) return [];
      return unknownFrame(opts, 'codex/unknown', m);
    }
    const p = isObj(m.params) ? m.params : {};
    if (m.id !== undefined && m.id !== null) {
      // A server request: the session answers it. Only one that nobody knows is worth reporting.
      if (PROMPTS.has(method) || OTHER_REQUESTS.has(method)) return [];
      return unknownFrame(opts, `codex/request/${method}`, p);
    }
    if (foreign(p, opts)) return [];
    const at = ms(p.completedAtMs) ?? ms(p.startedAtMs) ?? ms(m.emittedAtMs) ?? Date.now();
    const ctx = { opts, state, at, turnId: typeof p.turnId === 'string' ? p.turnId : state?.turnId ?? null, history: false, rec: null };
    switch (method) {
      case 'turn/started': return turnStarted(p, ctx);
      case 'turn/completed': return turnCompleted(p, ctx);
      case 'item/started': return itemStarted(p, ctx);
      case 'item/completed': return itemCompleted(p, ctx);
      case 'item/agentMessage/delta': case 'item/plan/delta': return textDelta(p, ctx);
      case 'item/reasoning/summaryTextDelta': return thinkingDelta(p, ctx, true);
      case 'item/reasoning/textDelta': return thinkingDelta(p, ctx, false);
      case 'item/reasoning/summaryPartAdded': return thinkingBreak(p, ctx);
      case 'item/commandExecution/outputDelta': return outputDelta(p, ctx);
      case 'item/fileChange/outputDelta': {
        // apply_patch's own words: the only place a failed edit says why.
        const rec = open(state, p.itemId, 'fileChange');
        if (rec) rec.note = clip(rec.note + str(p.delta), RAW_CAP);
        return [];
      }
      case 'item/autoApprovalReview/completed': {
        // Auto mode's reviewer said no: its reason goes on the row it blocked.
        const review = isObj(p.review) ? p.review : {};
        const why = noticeText(review.rationale);
        if (state && typeof p.targetItemId === 'string' && why && (review.status === 'denied' || review.status === 'aborted' || review.status === 'timedOut')) {
          if (state.reviews.size >= OPEN_MAX) state.reviews.clear();
          state.reviews.set(p.targetItemId, why);
        }
        return [];
      }
      case 'turn/plan/updated': return planEvents(p, ctx);
      case 'thread/tokenUsage/updated': noteUsage(state, p); return [];
      case 'thread/settings/updated':
        if (state && typeof p.threadSettings?.model === 'string' && p.threadSettings.model) state.model = p.threadSettings.model;
        return [];
      case 'thread/compacted': return compactedEvents(ctx.turnId ?? 'thread', ctx, false);
      case 'hook/started': return hookEvents(p, false);
      case 'hook/completed': return hookEvents(p, true);
      case 'error': return errorEvents(p, ctx);
      case 'warning': return warningEvents(p, ctx, { code: 'codex-warning' });
      case 'guardianWarning': return warningEvents(p, ctx, { code: 'auto-review', level: 'warn' });
      // Notes about the user's Codex set-up. They are not about this chat, and Canopy does not ask anyone to edit config files.
      case 'deprecationNotice': case 'configWarning': return warningEvents(p, ctx, { code: 'codex-config', level: 'info', quiet: true });
      case 'model/rerouted': {
        const from = str(p.fromModel);
        const to = str(p.toModel);
        if (!to) return [];
        return [{ kind: 'notice', level: 'warn', code: 'model-rerouted', fromModel: from || null, toModel: to, reason: p.reason ?? null, at,
          text: from ? `This request was answered by ${to} instead of ${from}.` : `This request was answered by ${to}.` }];
      }
      case 'account/rateLimits/updated': return rateLimitEvents(p, ctx);
      default:
        if (SILENT.has(method) || method.startsWith(SILENT_PREFIX)) return [];
        return unknownFrame(opts, `codex/${method}`, p);
    }
  } catch (err) {
    return adapterError(err, m);
  }
}

export function adapt(msg, opts = {}) {
  return run(msg, opts ?? {}, null);
}

// One per chat. Remembers what a single line cannot know: which items are open and
// what they streamed, the token counts, the model, and what was already said.
export function createAdapter(opts = {}) {
  const base = opts ?? {};
  const fresh = () => ({
    now: typeof base.now === 'function' ? base.now : Date.now,
    items: new Map(),      // item id -> { type, item, text, summary, started, out, pending, sentAt, note }
    reviews: new Map(),    // item id -> why the automatic review said no
    said: new Set(),
    model: null,
    turnId: null,
    usage: null,           // { total, last, window } from thread/tokenUsage/updated
    base: null,            // `total` when the running turn started
    calls: 0,
    plans: 0,
    lastPlan: null,
    errorSaid: false,
    answer: '',
    lastText: '',
    compactedIn: null,
    rateKey: null,
  });
  let state = fresh();
  // Each agent of the chat has a memory of its own (keyed by its thread), so its turn, its open items and its token
  // counts never mix with the chat's.
  let children = new Map();
  const childOf = (opts, make) => {
    const id = typeof opts.parent === 'string' && opts.parent && typeof opts.threadId === 'string' && opts.threadId ? opts.threadId : null;
    if (!id) return null;
    let mem = children.get(id) ?? null;
    if (!mem && make) {
      if (children.size >= CHILD_MAX) children.delete(children.keys().next().value);
      mem = fresh();
      children.set(id, mem);
    }
    return { id, state: mem };
  };
  return {
    adapt: (msg, o) => {
      const opts = o ? { ...base, ...o } : base;
      const child = childOf(opts, true);
      if (!child) return run(msg, opts, state);
      const out = [];
      for (const ev of run(msg, opts, child.state)) {
        if (!CHILD_KINDS.has(ev.kind)) continue;
        if (ev.kind !== 'raw') { if (!ev.parent) ev.parent = opts.parent; ev.agentId = child.id; }
        out.push(ev);
      }
      return out;
    },
    // The prompt a server request asks for, with the item it is about looked up from this chat's open items
    // (an agent's request, from that agent's).
    request: (msg, o) => {
      try {
        const opts = o ? { ...base, ...o } : base;
        const child = childOf(opts, false);
        const items = child ? child.state?.items ?? new Map() : state.items;
        const id = msg?.params?.itemId;
        const item = typeof id === 'string' ? items.get(id)?.item ?? null : mcpCallFor(msg?.params, items);
        const r = requestOf(msg, item, opts);
        if (r && child && isObj(r.base)) r.base.agentId = child.id;
        return r;
      } catch { return null; }
    },
    // How full the context is, for the meter: null until Codex has reported it.
    usage: () => {
      const u = state.usage;
      if (!u) return null;
      return { contextTokens: u.last ? num(u.last.totalTokens) : null, contextWindow: u.window, total: claudeShaped(u.total), last: claudeShaped(u.last) };
    },
    reset: () => { state = fresh(); children = new Map(); },
  };
}

// True when a list of turns runs newest to oldest. Start times are whole seconds, so two quick turns can share one:
// then the ids decide (Codex's turn ids are UUIDv7, which sort by time).
function newestFirst(turns) {
  if (turns.length < 2) return false;
  const a = turns[0];
  const b = turns.at(-1);
  if (typeof a.startedAt === 'number' && typeof b.startedAt === 'number' && a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return typeof a.id === 'string' && typeof b.id === 'string' && v7.test(a.id) && v7.test(b.id) && a.id > b.id;
}

// The tool results of a saved chat that keep their pictures: the latest few that have any, as a Claude chat's do
// (adapter.mjs). A chat is redrawn from its saved turns every time it is switched to, so without these the
// screenshot of a look Codex has just taken is gone the moment the user comes back to see it. Only the latest, so a
// long chat stays light to load. `turns` are oldest first.
function latestPictures(turns) {
  const ids = new Set();
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && ids.size < HISTORY_PICTURES; i--) {
    const items = list(turns[i].items);
    for (let j = items.length - 1; j >= 0 && ids.size < HISTORY_PICTURES; j--) {
      const it = items[j];
      if (!isObj(it) || it.type !== 'mcpToolCall' || typeof it.id !== 'string') continue;
      const size = list(it.result?.content).reduce((n, b) => n + (isObj(b) && b.type === 'image' && typeof b.data === 'string' ? b.data.length : 0), 0);
      if (!size) continue;
      if (chars + size > HISTORY_PICTURE_CHARS) return ids;
      chars += size;
      ids.add(it.id);
    }
  }
  return ids;
}

// History replay for a reopened chat. Items carry no time of their own, so each one takes its turn's.
export function adaptHistory(turns, opts = {}) {
  const o = { ...(opts ?? {}), history: true };
  const out = [];
  if (!turns || typeof turns[Symbol.iterator] !== 'function' || typeof turns === 'string') return out;
  let ordered;
  try { ordered = [...turns].filter(isObj); } catch { return out; }
  // thread/turns/list gives the newest turn first unless asked otherwise.
  if (newestFirst(ordered)) ordered.reverse();
  if (o.images === undefined) o.pictures = latestPictures(ordered);
  const openCalls = new Map(); // tool call id -> { start, turn }
  // The replay keeps no chat memory, except that a compaction is said once per turn.
  const state = { compactedIn: null, reviews: new Map(), usage: null, lastText: '' };
  ordered.forEach((turn, index) => {
    const ctx = { opts: o, state, at: ms(turn.startedAt), turnId: typeof turn.id === 'string' ? turn.id : null, history: true, rec: null };
    let answer = '';
    let lastText = '';
    let said = 0; // the user's messages in this turn so far
    for (const item of list(turn.items)) {
      let events;
      try { events = isObj(item) ? itemFinished(item, ctx, true) : []; } catch (err) { events = adapterError(err, item); }
      // Any message after the turn's first went into a reply that was already running (turn/steer). It is part of
      // that turn: Codex cannot cut the conversation back to it alone, so it cannot be edited.
      const steered = isObj(item) && item.type === 'userMessage' && said++ > 0;
      for (const ev of events) {
        if (steered && ev.kind === 'user-text') ev.steered = true;
        if (ev.kind === 'tool-start') openCalls.set(ev.id, { start: ev, turn: index });
        else if (ev.kind === 'tool-result') openCalls.delete(ev.id);
        else if (ev.kind === 'assistant-text') { lastText = ev.text; if (ev.phase === 'final_answer' && !ev.questions) answer = ev.text; }
        out.push(ev);
      }
    }
    const status = str(turn.status);
    // A turn that is still running: its open calls may yet finish, so they wait for the check below.
    if (status === 'inProgress' || !status) return;
    // A call with no saved result never finished (stopped, crashed, app closed). It is closed before its turn ends, as in a live chat.
    for (const [id, { start, turn: owner }] of openCalls) {
      if (owner !== index) continue;
      out.push(interruptedResult(id, start, true));
      openCalls.delete(id);
    }
    try {
      const end = { ...ctx, at: ms(turn.completedAt) ?? ctx.at };
      if (status === 'failed') out.push(errorNotice(turn.error, end.at, true));
      out.push(turnEnd(turn, end, { text: answer || lastText, threadId: o.threadId ?? null }));
    } catch (err) { out.push(...adapterError(err, turn)); }
  });
  // What is left belongs to turns that never ended. Only the last one can really be running, and only when the caller says so.
  const running = ordered.length - 1;
  for (const [id, { start, turn }] of openCalls) {
    if (o.inFlight && turn === running) continue;
    out.push(interruptedResult(id, start, true));
  }
  return out;
}

// ---- requests from Codex ----

const offered = (decisions, name) => !decisions || decisions.some((d) => d === name || (isObj(d) && name in d));

function permissionBase(type, name, input, itemId, extra) {
  return {
    type, toolName: name, input, hasSuggestions: false, reason: null, blockedPath: null, toolUseId: itemId ?? null, agentId: null,
    suggestions: [], title: null, displayName: null, description: null, defaultToNo: false, requiresInteraction: false,
    mcpServer: null, matchedAskRule: null, engine: 'codex', ...extra,
  };
}

function commandRequest(p, item) {
  const { name, input } = commandTool({ command: p.command ?? item?.command, commandActions: p.commandActions ?? item?.commandActions });
  const reason = noticeText(p.reason) || null;
  const host = str(p.networkApprovalContext?.host);
  // The model's own sentence about why it wants this. A Bash card already has a line for it.
  const says = reason ?? (host ? `Wants to reach ${host}.` : null);
  if (name === 'Bash' && says) input.description = says;
  if (p.kind === 'writeStdin') input.stdin = true;
  const decisions = Array.isArray(p.availableDecisions) ? p.availableDecisions : null;
  const proposed = list(p.proposedExecpolicyAmendment).filter((s) => typeof s === 'string');
  const rule = decisions
    ? decisions.find((d) => isObj(d) && isObj(d.acceptWithExecpolicyAmendment)) ?? null
    : proposed.length ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: proposed } } : null;
  const offers = { session: offered(decisions, 'acceptForSession'), rule, decline: offered(decisions, 'decline'), cancel: offered(decisions, 'cancel') };
  const prefix = list(rule?.acceptWithExecpolicyAmendment?.execpolicy_amendment).filter((s) => typeof s === 'string');
  return {
    type: 'tool', name, input, offers,
    base: permissionBase('tool', name, input, p.itemId, {
      hasSuggestions: offers.session || !!rule, reason,
      // What "Always allow" would cover: commands that start with these words.
      ...(prefix.length && { alwaysPrefix: prefix }),
      ...(host && { network: { host, protocol: p.networkApprovalContext?.protocol ?? null } }),
      ...(str(p.cwd) && { cwd: p.cwd }),
      // Codex offers no plain "no" here: the only one left stops the turn (see replyTo), and the card's Deny says so.
      ...(!offers.decline && offers.cancel && { denyStops: true }),
    }),
    fallback: { decision: 'cancel' },
  };
}

// How many files of one change travel in its approval card. The rest are counted, not shown.
const CARD_FILES = 40;

function fileRequest(p, item) {
  const rows = isObj(item) && item.type === 'fileChange' ? toolRows(item) : [];
  const root = str(p.grantRoot);
  const first = rows[0] ?? { name: 'Edit', input: { file_path: root } };
  const input = { ...first.input };
  const files = rows.map((r) => r.input.file_path).filter(Boolean);
  const many = rows.length > 1;
  if (files.length > 1) input.files = files;
  return {
    type: 'tool', name: first.name, input, offers: { session: true, rule: null, decline: true, cancel: true },
    base: permissionBase('tool', first.name, input, p.itemId, {
      hasSuggestions: true, reason: noticeText(p.reason) || null, ...(root && { blockedPath: root }),
      // One answer covers every file of the change, so the card is given every one of them: the row each belongs
      // to (they all wait on this answer) and what would happen to it.
      ...(many && {
        title: `Change ${rows.length} files?`,
        description: `And ${rows.length - 1} more ${rows.length === 2 ? 'file' : 'files'}.`,
        changes: rows.slice(0, CARD_FILES).map((r) => ({ id: r.id, name: r.name, input: r.input })),
        changeCount: rows.length,
        toolUseIds: rows.map((r) => r.id).filter((id) => typeof id === 'string'),
      }),
    }),
    fallback: { decision: 'cancel' },
  };
}

function accessRequest(p) {
  const asked = isObj(p.permissions) ? p.permissions : {};
  const fs = isObj(asked.fileSystem) ? asked.fileSystem : {};
  const paths = (v) => list(v).filter((s) => typeof s === 'string').slice(0, 50);
  const read = paths(fs.read);
  const write = paths(fs.write);
  const network = asked.network?.enabled === true;
  const reason = noticeText(p.reason) || null;
  const input = { ...(reason && { reason }), ...(write.length && { write }), ...(read.length && { read }), ...(network && { network: true }) };
  // What is granted is exactly what was asked for, with the empty parts left out.
  const grant = {};
  if (isObj(asked.network)) grant.network = asked.network;
  if (isObj(asked.fileSystem)) grant.fileSystem = asked.fileSystem;
  return {
    type: 'tool', name: 'Permissions', input, grant,
    base: permissionBase('tool', 'Permissions', input, p.itemId, {
      hasSuggestions: true, reason, title: 'Allow more access?', blockedPath: write[0] ?? read[0] ?? null,
      description: [write.length && 'change files outside this project', read.length && 'read files outside this project', network && 'use the network'].filter(Boolean).join(', ') || null,
    }),
    fallback: { permissions: {}, scope: 'turn' },
  };
}

function questionRequest(p) {
  const ids = {};
  const questions = [];
  for (const q of list(p.questions).filter(isObj).slice(0, 12)) {
    let text = clip(str(q.question) || str(q.header) || 'Question', NOTICE_CAP);
    // Answers come back keyed by the question's words, so two questions cannot share them.
    for (let n = 2; text in ids; n++) text = `${clip(str(q.question) || str(q.header) || 'Question', NOTICE_CAP)} (${n})`;
    ids[text] = str(q.id) || text;
    questions.push({
      question: text, header: clip(str(q.header), 200),
      options: list(q.options).filter(isObj).slice(0, 12).map((o) => ({ label: clip(str(o.label), 500), description: clip(str(o.description), NOTICE_CAP) })),
      multiSelect: false, ...(q.isSecret === true && { secret: true }), ...(q.isOther === false && { otherOff: true }),
    });
  }
  const input = { questions };
  return {
    type: 'question', name: 'AskUserQuestion', input, ids,
    base: permissionBase('question', 'AskUserQuestion', input, p.itemId, { blocking: p.isBlocking !== false }),
    fallback: { answers: {} },
  };
}

const MCP_TOOL_APPROVAL = 'mcp_tool_call';

// The MCP call an elicitation is about: the one its metadata names, else the newest call to that server still open.
function mcpCallFor(p, items) {
  if (!isObj(p) || !items) return null;
  const meta = isObj(p._meta) ? p._meta : {};
  if (meta.codex_approval_kind !== MCP_TOOL_APPROVAL) return null;
  const named = [meta.call_id, meta.callId, meta.tool_call_id].find((v) => typeof v === 'string' && v);
  const byId = named ? items.get(named)?.item : null;
  if (isObj(byId) && byId.type === 'mcpToolCall') return byId;
  let found = null;
  for (const rec of items.values()) {
    const it = rec?.item;
    if (isObj(it) && it.type === 'mcpToolCall' && it.server === p.serverName) found = it;
  }
  return found;
}

const ASKED_TOOL = /\brun tool "([^"]{1,200})"/;

// An MCP tool that needs the user's yes. This Codex asks through an elicitation with an empty form whose `_meta`
// says `codex_approval_kind: "mcp_tool_call"` (not through item/tool/requestUserInput), so it is an ordinary
// tool card: Allow, Always allow where Codex offers to remember it, Deny. Null for any other elicitation.
// No recording holds one yet: the keys are the ones the 0.153.4 binary carries.
//
// Computer Use's "may I use this app?" is one of these, raised by the Computer Use server itself (`cua_repl`, from
// the bundled unified-computer-use plugin) rather than by Codex. Its shape, read from the plugin's own source
// (@oai/sky .../targets/mac/computer-use-policy.js, plugin 26.1111, Codex 0.169.0), never seen live here:
//   mode 'form', an empty form, message `Allow Computer Use to use "Google Chrome"?`, and
//   _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use',
//            persist: ['session', 'always'] (only ['session'] where remembering for good is not allowed),
//            riskLevel, subtitle? (a warning), tool_call_id?, tool_name, tool_params: { app: <bundle id> },
//            tool_params_display: [{ name: 'app', display_name: 'App', value: 'Google Chrome' }] }
// Yes is `accept` (the app is then allowed for this chat); `accept` with `_meta: { persist: 'always' }` is "Always
// allow"; `decline` or `cancel` is what gives "Computer Use was not approved to use Google Chrome". Recording
// computer audio asks the same way (tool_name 'start_audio_recording', persist ['session']).
// Its card says who is asking and for what, with no tool input to read: `plain`.
// One thing no card can fix: with approvalPolicy 'never' Codex answers every MCP server's elicitation "decline"
// itself and never asks (seen in Codex's own log of a Bypass chat), which is why Bypass is not sent as 'never'
// (see MODE_WIRE in codex-session.mjs).
const COMPUTER_USE = 'computer-use';

function mcpToolRequest(p, item) {
  const meta = isObj(p._meta) ? p._meta : null;
  if (!meta || meta.codex_approval_kind !== MCP_TOOL_APPROVAL || p.mode === 'url') return null;
  const call = isObj(item) && item.type === 'mcpToolCall' ? item : null;
  const server = str(p.serverName) || str(call?.server) || 'server';
  const message = noticeText(p.message) || null;
  const tool = str(call?.tool) || str(meta.tool_name) || (message && ASKED_TOOL.exec(message)?.[1]) || str(meta.tool_title) || 'tool';
  const name = mcpName(server, tool);
  const input = argsOf(isObj(meta.tool_params) ? meta.tool_params : call?.arguments);
  // What Codex offers to remember: for this chat, for good, both or neither.
  const persist = (Array.isArray(meta.persist) ? meta.persist : [meta.persist]).filter((v) => v === 'session' || v === 'always');
  const offers = { session: persist.includes('session'), always: persist.includes('always') };
  const title = clip(str(meta.tool_title), 200);
  const about = clip(str(meta.tool_description), NOTICE_CAP);
  // A server asking for itself (Computer Use and an app): the card is the question in plain words, not a tool call.
  const own = str(meta.connector_id) === COMPUTER_USE;
  const who = clip(str(meta.connector_name), 80) || 'Computer Use';
  const shown = own ? list(meta.tool_params_display).find((d) => isObj(d) && d.name === 'app' && str(d.value)) : null;
  // A development build carries the same name as the app it is built from ("Canopy" and Canopy's own dev build):
  // the card says which one, by the bundle id's `.dev` ending, or two cards read as one asked twice.
  const bundle = str(isObj(meta.tool_params) ? meta.tool_params.app : '');
  const named = shown ? clip(str(shown.value), 120) : null;
  const app = named && /\.dev$/i.test(bundle) && !/\bdev\b/i.test(named) ? `${named} (dev)` : named;
  const wants = !own ? null : app ? `${who} wants to use ${app}` : (message && /^Allow (.{1,80}?) to (.{1,200}?)\?$/.exec(message)?.slice(1, 3).join(' wants to ')) || `${who} needs your OK`;
  const warning = own ? clip(noticeText(meta.subtitle), NOTICE_CAP) : '';
  return {
    type: 'tool', name, input, offers, approval: MCP_TOOL_APPROVAL, server, tool, ...(own && { own: true }),
    base: permissionBase('tool', name, input, typeof call?.id === 'string' ? call.id : null, {
      hasSuggestions: offers.session || offers.always, reason: message, mcpServer: server,
      // All there is to remember it by is this chat: the card's second button then says so, not "Always allow".
      ...(offers.session && !offers.always && { alwaysForChat: true }),
      ...(title && { displayName: title }), ...(about && { description: about }),
      ...(own && { plain: true, title: wants, ...(app && { app }), ...(warning && { description: warning }) }),
    }),
    fallback: { action: 'cancel', content: null, _meta: null },
  };
}

// Any other question from an MCP server: a form to fill in, a link to open, or a plain yes/no (elicitation.mjs).
// `openai/form` and `openaiForm` are forms whose schema Codex passes on unread; `openai/userVerification` is a
// check only OpenAI's own apps can complete, so it is a card that can only be turned down.
function elicitationRequest(p) {
  const server = str(p.serverName) || null;
  const verify = p.mode === 'openai/userVerification';
  const d = describeElicitation({
    serverName: server, mode: p.mode === 'url' ? 'url' : 'form', url: p.url, elicitationId: p.elicitationId,
    message: verify ? str(p.description) || str(p.title) : p.message,
    requestedSchema: !verify && isObj(p.requestedSchema) && !exceeds(p.requestedSchema, STRUCTURED_CAP) ? p.requestedSchema : null,
  });
  return {
    type: 'elicitation', name: 'elicitation', input: {}, fields: d.fields,
    base: permissionBase('elicitation', server ?? 'MCP server', {}, null, {
      server, message: d.message, mode: d.mode, ask: verify ? 'unsupported' : d.ask, url: d.url, fields: d.fields, title: d.title,
      schema: d.mode === 'form' && isObj(p.requestedSchema) && !exceeds(p.requestedSchema, STRUCTURED_CAP) ? p.requestedSchema : null,
      elicitationId: p.elicitationId ?? null, mcpServer: server,
    }),
    fallback: { action: 'cancel', content: null, _meta: null },
  };
}

export function requestOf(msg, item, opts = {}) {
  try {
    if (!isObj(msg) || typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) return null;
    const p = isObj(msg.params) ? msg.params : {};
    if (!PROMPTS.has(msg.method)) {
      if (!OTHER_REQUESTS.has(msg.method)) unknownFrame(opts, `codex/request/${msg.method}`, p);
      return null;
    }
    if (foreign(p, opts)) return null;
    const about = isObj(item) ? item : null;
    let r;
    switch (msg.method) {
      case 'item/commandExecution/requestApproval': r = commandRequest(p, about); break;
      case 'item/fileChange/requestApproval': r = fileRequest(p, about); break;
      case 'item/permissions/requestApproval': r = accessRequest(p); break;
      case 'item/tool/requestUserInput': r = questionRequest(p); break;
      default: r = mcpToolRequest(p, about) ?? elicitationRequest(p);
    }
    return {
      rpcId: msg.id, method: msg.method, threadId: p.threadId ?? null, turnId: p.turnId ?? null, itemId: p.itemId ?? null,
      at: ms(p.startedAtMs) ?? Date.now(), ...r,
    };
  } catch {
    return null;
  }
}

const plain = (v) => isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Canopy's answer to a prompt, as the result Codex expects. Never throws: an answer
// that cannot be read is a "no" that lets the turn carry on where Codex allows it.
export function replyTo(request, answer) {
  try {
    const r = isObj(request) ? request : {};
    const a = isObj(answer) ? answer : {};
    const action = str(a.action);
    switch (r.method) {
      case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval': {
        const o = isObj(r.offers) ? r.offers : { session: true, rule: null, decline: true, cancel: true };
        let decision;
        if (action === 'allow') decision = 'accept';
        else if (action === 'always') {
          // "Always allow" is Codex's own rule for commands like this one; "for this chat" is its session grant.
          const rule = plain(o.rule) ? o.rule : null;
          if (a.scope === 'session') decision = o.session ? 'acceptForSession' : rule ?? 'accept';
          else decision = rule ?? (o.session ? 'acceptForSession' : 'accept');
        } else if (a.stop === true) decision = o.cancel || !o.decline ? 'cancel' : 'decline';
        // "No" lets the turn carry on. Where Codex does not offer that, the only "no" left is the one that stops it.
        else decision = o.decline || !o.cancel ? 'decline' : 'cancel';
        return { result: { decision }, stops: decision === 'cancel' };
      }
      case 'item/permissions/requestApproval': {
        if (action !== 'allow' && action !== 'always') return { result: { permissions: {}, scope: 'turn' }, stops: false };
        return { result: { permissions: plain(r.grant) ? r.grant : {}, scope: action === 'always' ? 'session' : 'turn' }, stops: false };
      }
      case 'item/tool/requestUserInput': {
        const answers = {};
        if (action === 'answers' && plain(a.answers) && plain(r.ids)) {
          for (const [question, value] of Object.entries(a.answers)) {
            if (!Object.hasOwn(r.ids, question)) continue;
            const said = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? '').trim()).filter(Boolean);
            if (said.length) answers[r.ids[question]] = { answers: said };
          }
        }
        return { result: { answers }, stops: false };
      }
      case 'mcpServer/elicitation/request': {
        if (r.approval === MCP_TOOL_APPROVAL) {
          // A tool approval in elicitation clothes: yes is `accept` (with what to remember, where that was offered)
          // and no is `decline`. Either way the turn carries on: Codex tells the model the call was refused.
          const o = isObj(r.offers) ? r.offers : {};
          if (action === 'allow') return { result: { action: 'accept', content: {}, _meta: null }, stops: false };
          if (action === 'always') {
            const keep = a.scope === 'session' ? (o.session ? 'session' : o.always ? 'always' : null) : (o.always ? 'always' : o.session ? 'session' : null);
            return { result: { action: 'accept', content: {}, _meta: keep ? { persist: keep } : null }, stops: false };
          }
          return { result: { action: a.stop === true ? 'cancel' : 'decline', content: null, _meta: null }, stops: false };
        }
        // A form's values go back as the server asked for them (numbers as numbers, only the fields it has); a form
        // Canopy could not read the fields of takes what was typed as it is.
        const said = elicitAnswer(r.fields, a);
        if (said.action !== 'accept') return { result: { action: said.action, content: null, _meta: null }, stops: false };
        const content = Array.isArray(r.fields) && r.fields.length ? said.content : plain(a.content) && r.base?.schema ? a.content : {};
        return { result: { action: 'accept', content, _meta: null }, stops: false };
      }
      default:
        return { result: isObj(r.fallback) ? r.fallback : {}, stops: false };
    }
  } catch {
    // Even reading the fallback can fail on a request that is not plain data.
    try { return { result: isObj(request?.fallback) ? request.fallback : {}, stops: false }; } catch { return { result: {}, stops: false }; }
  }
}

// ---- chat start ----

// What a chat opened with, in the shape Claude's `init` has. Fields Codex has no word for stay empty.
export function initEvent(result, extra = {}) {
  const r = isObj(result) ? result : {};
  const thread = isObj(r.thread) ? r.thread : {};
  const tier = r.serviceTier ?? null;
  return {
    kind: 'init', sessionId: thread.id ?? null, model: r.model ?? thread.model ?? null, cwd: r.cwd ?? thread.cwd ?? null,
    permissionMode: null, version: thread.cliVersion ?? null,
    apiKeySource: null, mcp: [], plugins: [], slash: [], skills: [], tools: [],
    // Fast is Codex's priority tier (or better). "default" is the standard one.
    fastState: tier === null ? null : tier === 'default' ? 'off' : 'on', fastReason: null,
    agents: [], outputStyle: null, capabilities: [], terminalCommands: [], pluginErrors: [], memoryPaths: null, userUuids: [],
    engine: 'codex', effort: r.reasoningEffort ?? thread.reasoningEffort ?? null, serviceTier: tier,
    approvalPolicy: r.approvalPolicy ?? null, sandbox: r.sandbox?.type ?? null, reviewer: r.approvalsReviewer ?? null,
    name: thread.name ?? null, createdAt: ms(thread.createdAt),
    ...(isObj(extra) ? extra : {}),
  };
}

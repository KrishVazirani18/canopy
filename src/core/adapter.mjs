// Adapter: translates Claude Agent SDK messages into Canopy's own event format.
// The UI only ever sees these events. If Claude Code changes its stream, only
// this file changes. Nothing here throws: a frame that cannot be read becomes a
// `raw` event labelled `adapter-error`, and frames the adapter does not know are
// dropped unless `debug` is set.
//
//   adapt(m, opts)               one frame in, zero or more events out, no memory
//   createAdapter(opts).adapt    the same, plus per-conversation memory (tool
//                                input streaming, de-duplication, throttling)
//   adaptHistory(rows, opts)     replay of a saved conversation
//
// opts: {
//   history     rows come from getSessionMessages, not from a live stream
//   debug       emit `raw` for unknown frames (capped at 8 KB)
//   unknown     (label, keys) => void: told about every frame or block this file does not know, debug or not,
//               so the host can notice Claude Code changing under it. Gets the frame's top-level keys, never its content.
//   toolStream  emit `tool-pending` and `tool-input-delta` while a tool call streams
//   inputStream (name) => boolean: for these tools, also emit `tool-input-partial` while the call streams: the input
//               as far as it has been written (partial-json.mjs), so the UI can draw a widget as Claude writes it
//   verbose     also surface info-level notices, permission denials, memory recall
//   images      true | false: carry tool-result image data (default: live yes; history only for the latest few
//               results that have any, see adaptHistory)
//   inFlight    adaptHistory only: the last turn is still running, so leave its
//               unanswered tool calls open instead of marking them interrupted
//   now         clock for throttling (tests)
// }

import { parsePartialJson } from './partial-json.mjs';
import { toolIcons } from './tool-icons.mjs';
import { LIMIT_NAMES, nearingText, reachedText } from './limits.mjs';
import { stripNote } from './notes.mjs';
import { ANSI, COMPACTED, HISTORY_PICTURES, HISTORY_PICTURE_CHARS, IMAGE_CHARS, IMAGE_MAX, IMAGE_TYPES, STRUCTURED_CAP, adapterError, brief, capText, exceeds, notice, rawEvent } from './adapter-shared.mjs';

const KB = 1024;
const THROTTLE_MS = 100;
const PARTIAL_MS = 80;            // a streamed input is re-read at most this often: smooth to watch, cheap to send
const PARTIAL_CAP = 512 * KB;     // past this the input is no longer followed live; the finished call still arrives whole

const SYNTHETIC_MODEL = '<synthetic>';
const NO_RESPONSE = 'No response requested.';
const OUTPUT_LIMIT = 'The reply hit the output limit.';

const INTERRUPT = /^\[Request interrupted by user/;
// Sticky, so each match has to start where the previous one ended: a prompt that
// merely mentions one of these tags is never mistaken for command output.
const LOCAL_OUT = /\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/y;
const BASH_OUT = /\s*<bash-(stdout|stderr)>([\s\S]*?)<\/bash-\1>/y;

const TAGS = {};
for (const name of ['command-name', 'command-message', 'command-args', 'bash-input', 'task-id', 'tool-use-id', 'output-file', 'status', 'summary']) {
  TAGS[name] = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
}
const tag = (text, name) => text.match(TAGS[name])?.[1];

const API_ERRORS = {
  authentication_failed: 'You are signed out. Run /login or sign in again.',
  billing_error: 'Billing problem on your account.',
  rate_limit: 'You hit a rate limit. Try again in a moment.',
  overloaded: 'Claude is overloaded right now.',
  model_not_found: 'That model is not available on your account.',
  max_output_tokens: OUTPUT_LIMIT,
};

// Frames that carry nothing for the transcript. Session reads the ones it needs
// (state, background tasks, task model) from the raw stream.
const SILENT_SYSTEM = new Set([
  'session_state_changed', 'background_tasks_changed', 'task_progress', 'task_updated', 'files_persisted',
  'elicitation_complete', 'plugin_install', 'control_request_progress', 'mirror_error', 'worker_shutting_down',
  'ui_invalidate', 'ui_log', 'ui_status',
]);
const SILENT_TYPES = new Set(['command_lifecycle', 'active_goal', 'keep_alive', 'tool_use_summary']);

// ---- small helpers ----

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function timeOf(m) {
  const t = Date.parse(m?.timestamp);
  return Number.isNaN(t) ? null : t;
}

function userUuids(m) {
  if (Array.isArray(m.user_message_uuids)) return m.user_message_uuids;
  return m.user_message_uuid ? [m.user_message_uuid] : [];
}

// A frame or block this file does not know. The host hears about it (opts.unknown); the transcript only in debug.
function unknownFrame(opts, label, payload) {
  try { opts?.unknown?.(label, payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 24) : []); } catch { /* observers never break the adapter */ }
  return opts?.debug ? [rawEvent(label, payload)] : [];
}

// Words passed through from Claude Code, as a notice may carry them (adapter-shared.mjs).
const noticeText = (text) => notice(text, 'Claude Code');

// ---- tool results ----

function resultParts(content, keepImages) {
  if (content == null) return { text: '', images: [], omitted: 0 };
  if (typeof content === 'string') return { text: content, images: [], omitted: 0 };
  if (!Array.isArray(content)) {
    let text;
    try { text = JSON.stringify(content) ?? ''; } catch { text = String(content); }
    return { text, images: [], omitted: 0 };
  }
  const lines = [];
  const images = [];
  let omitted = 0;
  let chars = 0;
  for (const b of content) {
    if (b == null) continue;
    if (typeof b === 'string') { lines.push(b); continue; }
    switch (b.type) {
      case 'text': lines.push(typeof b.text === 'string' ? b.text : ''); break;
      case 'image': {
        lines.push('[image]');
        const src = b.source ?? {};
        // Inline data only, and only raster types: a tool result must not make the UI fetch a URL or run SVG.
        const ok = keepImages && src.type === 'base64' && typeof src.data === 'string' && IMAGE_TYPES.has(src.media_type)
          && images.length < IMAGE_MAX && chars + src.data.length <= IMAGE_CHARS;
        if (ok) { chars += src.data.length; images.push({ mediaType: src.media_type, data: src.data }); }
        else omitted++;
        break;
      }
      case 'tool_reference': lines.push(`[tool: ${b.tool_name ?? b.name ?? 'unknown'}]`); break;
      case 'document': lines.push('[document]'); break;
      default: lines.push(`[${b.type ?? 'unknown'}]`);
    }
  }
  return { text: lines.join('\n'), images, omitted };
}

function structuredOf(r) {
  if (r == null) return null;
  if (typeof r === 'string') return r.length > STRUCTURED_CAP ? { truncated: true, type: 'text' } : r;
  if (typeof r !== 'object' || !exceeds(r, STRUCTURED_CAP)) return r;
  return {
    truncated: true,
    type: r.type ?? null,
    filePath: r.filePath ?? null,
    structuredPatch: r.structuredPatch != null && !exceeds(r.structuredPatch, STRUCTURED_CAP) ? r.structuredPatch : null,
    backgroundTaskId: r.backgroundTaskId ?? null,
  };
}

function resultEvent(id, parts, isError, m, parent, at) {
  const capped = capText(parts.text);
  return {
    kind: 'tool-result', id, content: capped.text, isError, parent, uuid: m.uuid ?? null, at,
    images: parts.images, imagesOmitted: parts.omitted, truncated: capped.truncated, fullLength: parts.text.length,
    structured: null, detached: false,
  };
}

function toolResult(b, m, parent, at, keepImages, single) {
  const ev = resultEvent(b.tool_use_id, resultParts(b.content, keepImages), !!b.is_error, m, parent, at);
  // tool_use_result belongs to the frame, not to a block, so it is only attributable when there is one result.
  const r = single ? m.tool_use_result : undefined;
  const raw = r ?? b;
  const serverIcons = toolIcons(raw?._meta?.['io.modelcontextprotocol/serverInfo']);
  if (serverIcons.length) ev.serverIcons = serverIcons;
  const icons = toolIcons(raw && typeof raw === 'object' ? { ...raw, _meta: undefined } : null);
  if (icons.length) ev.icons = icons;
  if (r === undefined || r === null) return ev;
  ev.structured = structuredOf(r);
  if (typeof r === 'object') {
    // The call returned but its work carries on in the background (backgrounded shell, async agent).
    if (r.backgroundTaskId != null || r.isAsync === true || r.status === 'async_launched') {
      ev.detached = true;
      ev.taskId = r.backgroundTaskId ?? r.agentId ?? null;
    }
    if (r.interrupted === true) ev.interrupted = true;
  }
  return ev;
}

// Results of tools the API ran itself (web search, code execution, remote MCP) arrive inside the assistant message.
function serverResult(b, m, parent, at) {
  const c = b.content;
  let text = '';
  let isError = !!b.is_error;
  if (Array.isArray(c)) {
    text = c.map((x) => (x?.type === 'text' ? (x.text ?? '') : x?.title && x?.url ? `${x.title}\n${x.url}` : x?.url ?? `[${x?.type ?? 'unknown'}]`)).join('\n');
  } else if (c && typeof c === 'object') {
    if (c.error_code) { text = String(c.error_code); isError = true; }
    else if (typeof c.stdout === 'string' || typeof c.stderr === 'string') {
      text = [c.stdout, c.stderr].filter(Boolean).join('\n');
      if (typeof c.return_code === 'number' && c.return_code !== 0) isError = true;
    } else text = resultParts(c, false).text;
  } else if (c != null) text = String(c);
  const ev = resultEvent(b.tool_use_id, { text, images: [], omitted: 0 }, isError, m, parent, at);
  ev.server = true;
  return ev;
}

// ---- user text ----

function outputs(re, text) {
  const out = [];
  re.lastIndex = 0;
  for (let x; (x = re.exec(text));) {
    const body = x[2].replace(ANSI, '');
    const t = body.trim();
    if (t && t !== '(no content)') out.push({ kind: 'command-output', text: body, stream: x[1] });
  }
  re.lastIndex = 0;
  return out;
}

function taskFromText(t, origin) {
  // Scheduled and relayed deliveries share the origin but are plain text, not the XML envelope.
  const summary = t.startsWith('<task-notification>') ? (tag(t, 'summary') ?? '').trim() : t;
  return {
    kind: 'task', subtype: 'task_notification', description: brief(summary), status: tag(t, 'status')?.trim() ?? null,
    taskId: tag(t, 'task-id')?.trim() ?? null, runId: origin?.runId ?? null, toolUseId: tag(t, 'tool-use-id')?.trim() ?? null,
    summary, outputFile: tag(t, 'output-file')?.trim() ?? null, history: true,
  };
}

// Text that Claude Code wrote into the user role on its own behalf. Returns the
// events for it, or null when the text is an ordinary prompt.
function machineText(text, history, origin) {
  const t = text.trimStart();
  if (!t) return [];
  if (INTERRUPT.test(t)) return history ? [{ kind: 'notice', code: 'interrupted', text: 'Stopped', history: true }] : [];
  // Live, the system/task_notification frame already reported it.
  if (origin?.kind === 'task-notification' || t.startsWith('<task-notification>')) return history ? [taskFromText(t, origin)] : [];
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) return outputs(LOCAL_OUT, t);
  if (t.startsWith('<bash-input>')) {
    const cmd = (tag(t, 'bash-input') ?? '').trim();
    const end = t.indexOf('</bash-input>');
    const rest = end < 0 ? [] : outputs(BASH_OUT, t.slice(end + '</bash-input>'.length));
    return cmd ? [{ kind: 'user-text', text: `! ${cmd}`, images: 0, documents: 0, bash: true }, ...rest] : rest;
  }
  if (t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) return outputs(BASH_OUT, t);
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
    let name = (tag(t, 'command-name') ?? '').trim();
    if (!name) {
      const message = (tag(t, 'command-message') ?? '').trim();
      name = message && !message.startsWith('/') ? `/${message}` : message;
    }
    const line = `${name} ${(tag(t, 'command-args') ?? '').trim()}`.trim();
    return line ? [{ kind: 'user-text', text: line, images: 0, documents: 0, command: true }] : [];
  }
  if (t.startsWith('This session is being continued')) return [{ kind: 'context-note', text, compact: true }];
  if (t.startsWith('<system-reminder>') || t.startsWith('<local-command-caveat>')) return [];
  return null;
}

// A message another of the user's chats sent to this one (Claude Code's SendMessage between sessions). It arrives in
// the user role, wrapped in <cross-session-message from="…">, and Claude answers it like a prompt, so the transcript
// shows it where a prompt goes, marked as not typed by the user. `body` is the text without the wrapper when Claude
// Code gives it; `name` is the sender's display name, already cleaned by Claude Code (`from` is an address, never shown).
const PEER_WRAP = /^\s*<cross-session-message\b[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/;
const peerName = (origin) => (typeof origin?.name === 'string' ? origin.name.trim().slice(0, 80) : '');
// Where it came from is a socket address, which never leaves here. A reply is sent to that address, though, so a short
// fingerprint of it goes along: the window fingerprints the reply's address the same way (chatKey in chat-text.tsx)
// and so can show the reply with the name.
export const chatKey = (addr) => { let h = 0x811c9dc5; for (let i = 0; i < addr.length; i++) h = Math.imul(h ^ addr.charCodeAt(i), 0x01000193); return `c${(h >>> 0).toString(36)}`; };
const peerAddr = (origin) => (typeof origin?.from === 'string' && origin.from ? chatKey(origin.from) : '');
function peerText(m) {
  const c = m.message?.content;
  if (typeof m.origin?.body === 'string') return m.origin.body;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
  return PEER_WRAP.exec(text)?.[1] ?? text;
}
// Live: Claude Code echoes it once it is taken up (a replay frame). A second copy of the same message says nothing.
function livePeer(m, state) {
  if (m.parent_tool_use_id) return [];
  if (state && m.uuid) {
    if (state.peers.has(m.uuid)) return [];
    state.peers.add(m.uuid);
  }
  const text = peerText(m);
  if (!text.trim()) return [];
  return stamp([{ kind: 'user-text', text, images: 0, documents: 0, origin: 'peer', from: peerName(m.origin), fromAddr: peerAddr(m.origin) }], m, timeOf(m) ?? Date.now());
}

// A message from another chat that this one did not take: held for an approval, then let through or dropped.
// Claude Code holds one when the two chats are not in the same kind of mode (one asks before acting, the other
// runs without asking), or when a setting of the user's, their admin's or the project's says hold.
const MODE_HOLDS = new Set(['mode-mismatch', 'no-mode-asserted', 'mode-unknown', 'bypass-default']);
function peerHold(m) {
  const who = typeof m.from_name === 'string' && m.from_name.trim() ? ` (${m.from_name.trim().slice(0, 80)})` : '';
  if (m.state === 'held') {
    const why = MODE_HOLDS.has(m.cause)
      ? 'one of the two chats asks before acting and the other runs without asking, so Claude Code wants your approval, and Canopy cannot show that yet. Put both chats in the same mode and send it again.'
      : 'your Claude Code settings hold messages between chats, and Canopy cannot show them for approval yet.';
    return [{ kind: 'notice', level: 'warn', code: 'peer-held', text: `A message from another chat${who} is being held: ${why}` }];
  }
  if (m.state === 'dropped') return [{ kind: 'notice', code: 'peer-dropped', text: `The held message from another chat${who} was not delivered.` }];
  return [];
}

function attachmentLabel(images, documents) {
  const parts = [];
  if (images) parts.push(images === 1 ? '[image]' : `[${images} images]`);
  if (documents) parts.push(documents === 1 ? '[document]' : `[${documents} documents]`);
  return parts.join(' ');
}

function stamp(events, m, at) {
  for (const ev of events) {
    if (ev.uuid == null) ev.uuid = m.uuid ?? null;
    if (ev.at == null) ev.at = at;
  }
  return events;
}

function liveUser(m, opts, state) {
  if (m.origin?.kind === 'peer') return livePeer(m, state);
  const c = m.message?.content;
  const parent = m.parent_tool_use_id ?? null;
  const at = timeOf(m) ?? Date.now();
  const out = [];
  // Our own prompts are drawn by the UI when sent and are not echoed back, so any
  // text that reaches here was written by Claude Code. Subagent prompts are skipped.
  const text = (t) => { if (!parent) out.push(...(machineText(t, false, m.origin) ?? [{ kind: 'context-note', text: t }])); };
  if (typeof c === 'string') text(c);
  else if (Array.isArray(c)) {
    let results = 0;
    for (const b of c) if (b?.type === 'tool_result') results++;
    const keepImages = opts.images !== false;
    for (const b of c) {
      if (b?.type === 'tool_result') out.push(toolResult(b, m, parent, at, keepImages, results === 1));
      else if (b?.type === 'text' && typeof b.text === 'string') text(b.text);
    }
  }
  return stamp(out, m, at);
}

function historyUser(m, opts) {
  const c = m.message?.content;
  const parent = m.parent_tool_use_id ?? null;
  const at = timeOf(m);
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  const out = [];

  if (m.isCompactSummary) {
    const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    out.push({ kind: 'notice', text: COMPACTED, code: 'compacted', history: true }, { kind: 'context-note', text, compact: true });
    return stamp(out, m, at);
  }

  // Rows Claude Code wrote for the model only (skill bodies, caveats) and subagent prompts are never a prompt bubble.
  const hidden = m.is_meta === true || m.isMeta === true || !!parent;
  const origin = m.origin ?? null;
  const prompt = [];
  let images = 0;
  let documents = 0;
  let results = 0;
  const imageData = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_result') { results++; out.push(toolResult(b, m, parent, at, opts.images === true || opts.pictures?.has(b.tool_use_id) === true, false)); }
    else if (b.type === 'text' && typeof b.text === 'string') {
      if (parent) continue;
      // A note of Canopy's for the model (notes.mjs) is a block of its own, which machineText hides. Should Claude
      // Code ever save it joined to the words it came with, only the note goes.
      const text = stripNote(b.text);
      if (text !== b.text && !text.trim()) continue;
      const machine = machineText(text, true, origin);
      if (machine) out.push(...machine);
      else if (!hidden) prompt.push(text);
    } else if (b.type === 'image') {
      images++;
      // Thumbnails for the prompt bubble (capped so a long history stays light).
      const src = b.source;
      if (!parent && src?.type === 'base64' && typeof src.data === 'string' && imageData.length < 6 && src.data.length <= 2_000_000) imageData.push({ mediaType: src.media_type, data: src.data });
    } else if (b.type === 'document') documents++;
  }
  if (!hidden && (prompt.length || (!results && (images || documents)))) {
    const ev = { kind: 'user-text', text: prompt.join('\n') || attachmentLabel(images, documents), images, documents };
    if (imageData.length) ev.imageData = imageData;
    if (origin?.kind && origin.kind !== 'human') ev.origin = origin.kind;
    if (origin?.kind === 'peer') { ev.text = peerText(m); ev.from = peerName(origin); ev.fromAddr = peerAddr(origin); }
    // Sent while Claude was working and taken into that same turn (Claude Code saves it as a queued command). A
    // message that waited for the turn to end is saved as an ordinary prompt instead.
    if (m.isQueuedCommand === true) ev.steered = true;
    out.push(ev);
  }
  if (m.interruptedByShutdown) out.push({ kind: 'notice', code: 'interrupted-shutdown', text: 'Interrupted when the app closed', history: true });
  return stamp(out, m, at);
}

// ---- assistant ----

function apiErrorNotice(error, text, history) {
  const fallback = noticeText(text) || (error ? `API error: ${String(error).replaceAll('_', ' ')}` : 'Claude Code reported an API error.');
  const ev = { kind: 'notice', level: 'warn', code: 'api-error', apiError: error ?? null, text: API_ERRORS[error] ?? fallback };
  if (history) ev.history = true;
  return ev;
}

function commandOutput(body, stream, twin, state) {
  const text = String(body ?? '').replace(ANSI, '');
  const t = text.trim();
  if (!t || t === '(no content)') return [];
  // Some builds report a local command twice (a system frame and an assistant twin).
  if (state) {
    if (state.lastOutput === text) return [];
    state.lastOutput = text;
  }
  const ev = { kind: 'command-output', text, stream };
  if (twin) {
    // The twin is what the terminal shows as an assistant-style reply, so it is usually Markdown.
    ev.markdown = true;
    if (twin.local_command_run?.command) { ev.command = twin.local_command_run.command; ev.args = twin.local_command_run.args ?? ''; }
  }
  return [ev];
}

// Messages Claude Code wrote itself (model "<synthetic>"): local command output,
// API errors, placeholders. The model name is never forwarded.
function syntheticEvents(m, content, common, history, state) {
  const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  if (m.local_command_run || m.local_command_source != null) {
    const stderr = typeof m.local_command_source === 'string' && m.local_command_source.trimStart().startsWith('<local-command-stderr>');
    return commandOutput(text, stderr ? 'stderr' : 'stdout', m, state);
  }
  if (m.error) return [apiErrorNotice(m.error, text, history)];
  const t = text.trim();
  if (!t || t === NO_RESPONSE) return [];
  // Saved rows do not keep the error field; the text is all that is left to tell an error from a reply.
  if (history && /^API Error\b/.test(t)) return [apiErrorNotice(null, text, true)];
  return [{ kind: 'assistant-text', text, ...common, aborted: false, synthetic: true }];
}

// The finished call is here with its whole input: nothing partial is said about it after this.
function inputArrived(state, id) {
  if (!state) return;
  for (const t of state.tools.values()) if (t.id === id) t.started = true;
}

function assistantEvents(m, opts, state, history) {
  const msg = m.message ?? {};
  const at = timeOf(m) ?? (history ? null : Date.now());
  const common = { parent: m.parent_tool_use_id ?? null, uuid: m.uuid ?? null, at, messageId: msg.id ?? null, agentId: m.agent_id ?? null };
  const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
  const out = msg.model === SYNTHETIC_MODEL ? syntheticEvents(m, content, common, history, state) : [];
  // The model of the turn's last reply of its own (not an agent's) is what the turn's footer names.
  if (state && !m.parent_tool_use_id && typeof msg.model === 'string' && msg.model && msg.model !== SYNTHETIC_MODEL) state.turnModel = msg.model;

  if (msg.model !== SYNTHETIC_MODEL) {
    for (const b of content) {
      switch (b?.type) {
        case 'text':
          if (b.text) out.push({ kind: 'assistant-text', text: b.text, model: msg.model, ...common, aborted: m.aborted === true });
          break;
        case 'thinking':
          if (typeof b.thinking === 'string' && b.thinking.trim()) out.push({ kind: 'thinking', text: b.thinking, ...common });
          break;
        case 'tool_use':
          inputArrived(state, b.id);
          out.push({ kind: 'tool-start', id: b.id, name: b.name, input: b.input ?? {}, ...common, ...(toolIcons(b).length ? { icons: toolIcons(b) } : {}) });
          break;
        case 'server_tool_use': case 'mcp_tool_use':
          inputArrived(state, b.id);
          out.push({ kind: 'tool-start', id: b.id, name: b.server_name ? `mcp__${b.server_name}__${b.name}` : b.name, input: b.input ?? {}, ...common, server: true });
          break;
        case 'redacted_thinking':
          break;
        default:
          if (typeof b?.type === 'string' && b.type.endsWith('_tool_result') && b.tool_use_id) out.push(serverResult(b, m, common.parent, at));
          else out.push(...unknownFrame(opts, `assistant/${b?.type ?? 'unknown'}`, b));
      }
    }
    // The stream already said the reply was cut off; do not say it twice.
    if (m.error && !(m.error === 'max_output_tokens' && state?.maxOutput)) out.push(apiErrorNotice(m.error, '', history));
  }

  if (history && m.interruptedByShutdown) out.push({ kind: 'notice', code: 'interrupted-shutdown', text: 'Interrupted when the app closed', history: true });
  return stamp(out, m, at);
}

// ---- stream ----

// A tool the API runs itself is named by its server; the rest carry their full name already.
const toolName = (b) => (b.server_name ? `mcp__${b.server_name}__${b.name}` : b.name);

function wantsInput(opts, name) {
  try { return typeof opts.inputStream === 'function' && opts.inputStream(name) === true; } catch { return false; }
}

// The input of a call still being written, as far as it can be read. Always an object, like a finished call's.
function partialInput(t) {
  const v = parsePartialJson(t.json);
  const input = v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return { kind: 'tool-input-partial', id: t.id, name: t.name, input, bytes: t.bytes, messageId: t.messageId };
}

function streamEvents(m, opts, state) {
  if (m.parent_tool_use_id) return []; // subagent deltas are not forwarded; full messages arrive later
  const e = m.event;
  switch (e?.type) {
    case 'content_block_delta': {
      const d = e.delta;
      const messageId = m.api_message_id ?? state?.messageId ?? null;
      if (d?.type === 'text_delta') return d.text ? [{ kind: 'text-delta', text: d.text, index: e.index, messageId }] : [];
      // With thinking display off the deltas are empty; forwarding them would open an empty thinking item.
      if (d?.type === 'thinking_delta') return d.thinking ? [{ kind: 'thinking-delta', text: d.thinking, index: e.index, messageId }] : [];
      if (d?.type === 'input_json_delta' && state) {
        const t = state.tools.get(e.index);
        if (!t) return [];
        const chunk = typeof d.partial_json === 'string' ? d.partial_json : '';
        t.bytes += chunk.length;
        const now = state.now();
        const out = [];
        if (t.json != null) {
          if (t.json.length + chunk.length > PARTIAL_CAP) t.json = null;
          else {
            t.json += chunk;
            if (t.bytes !== t.partSent && now - t.partAt >= PARTIAL_MS) { t.partSent = t.bytes; t.partAt = now; out.push(partialInput(t)); }
          }
        }
        if (opts.toolStream && t.bytes !== t.sent && now - t.sentAt >= THROTTLE_MS) {
          t.sent = t.bytes; t.sentAt = now;
          out.push({ kind: 'tool-input-delta', id: t.id, bytes: t.bytes });
        }
        return out;
      }
      return [];
    }
    case 'message_start': {
      const messageId = e.message?.id ?? m.api_message_id ?? null;
      if (state) { state.messageId = messageId; state.tools.clear(); state.thinkingAt = -Infinity; }
      return [{ kind: 'message-start', model: e.message?.model, messageId }];
    }
    case 'content_block_start': {
      const b = e.content_block;
      if (!b?.id || (b.type !== 'tool_use' && b.type !== 'server_tool_use' && b.type !== 'mcp_tool_use')) return [];
      const name = toolName(b);
      const follow = !!state && wantsInput(opts, name);
      if (!opts.toolStream && !follow) return [];
      const messageId = m.api_message_id ?? state?.messageId ?? null;
      const t = { id: b.id, name, messageId, bytes: 0, sent: 0, sentAt: -Infinity, json: follow ? '' : null, partSent: 0, partAt: -Infinity, started: false };
      state?.tools.set(e.index, t);
      const out = [];
      if (opts.toolStream) out.push({ kind: 'tool-pending', id: b.id, name: b.name, index: e.index, messageId });
      // Said at once, before any input: the UI gives the widget its place in the reply right away.
      if (follow) out.push(partialInput(t));
      return out;
    }
    case 'content_block_stop': {
      const t = state?.tools.get(e.index);
      if (!t) return [];
      state.tools.delete(e.index);
      const out = [];
      // The throttle may have swallowed the last pieces. The finished call (tool-start) carries the whole input, so
      // this only matters to a Claude Code that sends it after the block has closed.
      if (t.json != null && !t.started && t.partSent !== t.bytes) out.push(partialInput(t));
      // The throttle may have swallowed the last deltas; report the final size once.
      if (opts.toolStream && t.sent !== t.bytes) out.push({ kind: 'tool-input-delta', id: t.id, bytes: t.bytes });
      return out;
    }
    case 'message_delta':
      if (e.delta?.stop_reason !== 'max_tokens') return [];
      if (state) state.maxOutput = true;
      return [{ kind: 'notice', level: 'warn', code: 'max-output', text: OUTPUT_LIMIT, messageId: m.api_message_id ?? state?.messageId ?? null }];
    default:
      return [];
  }
}

// ---- system ----

function systemEvents(m, opts, state) {
  switch (m.subtype) {
    case 'init':
      // Fields are picked one by one: init also carries things the UI must never see (messaging_socket_path).
      return [{
        kind: 'init', sessionId: m.session_id, model: m.model, cwd: m.cwd,
        permissionMode: m.permissionMode, version: m.claude_code_version,
        apiKeySource: m.apiKeySource, mcp: m.mcp_servers ?? [], plugins: m.plugins ?? [],
        slash: m.slash_commands ?? [], skills: m.skills ?? [], tools: m.tools ?? [],
        fastState: m.fast_mode_state ?? null, fastReason: m.fast_mode_disabled_reason ?? null,
        agents: m.agents ?? [], outputStyle: m.output_style ?? null, capabilities: m.capabilities ?? [],
        terminalCommands: m.terminal_slash_commands ?? [], pluginErrors: m.plugin_errors ?? [],
        memoryPaths: m.memory_paths ?? null, userUuids: userUuids(m),
      }];
    case 'status':
      if (state) state.lastStatus = m.status ?? null;
      return [{
        kind: 'status', status: m.status ?? null, permissionMode: m.permissionMode, compactResult: m.compact_result,
        compactError: m.compact_error ?? null, userUuids: userUuids(m),
        fastState: m.fast_mode_state ?? null, fastReason: m.fast_mode_disabled_reason ?? null,
      }];
    case 'compact_boundary': {
      const c = m.compact_metadata ?? {};
      return [{ kind: 'notice', text: COMPACTED, code: 'compacted',
        compact: { trigger: c.trigger ?? null, preTokens: c.pre_tokens ?? null, postTokens: c.post_tokens ?? null, durationMs: c.duration_ms ?? null } }];
    }
    case 'hook_started': case 'hook_progress': case 'hook_response':
      return [{
        kind: 'hook', subtype: m.subtype, id: m.hook_id ?? null, event: m.hook_event ?? null,
        name: m.hook_name ?? m.hook_event ?? 'hook', output: m.output || m.stdout || m.stderr || '',
        stderr: m.stderr ?? '', exitCode: m.exit_code, outcome: m.outcome ?? null,
      }];
    case 'task_started': case 'task_notification':
      if (m.ambient || m.skip_transcript) return [];
      return [{
        // A finished agent's summary is its whole report; the description stays a single line.
        kind: 'task', subtype: m.subtype, description: brief(m.description ?? m.summary), taskId: m.task_id, status: m.status ?? 'running',
        runId: m.run_id ?? null, toolUseId: m.tool_use_id ?? null, taskType: m.task_type ?? null, agentType: m.subagent_type ?? null,
        summary: m.summary ?? null, usage: m.usage ?? null, outputFile: m.output_file ?? null, backgrounded: m.is_backgrounded ?? null,
      }];
    case 'commands_changed':
      return [{ kind: 'commands-changed', commands: m.commands }];
    case 'thinking_tokens': {
      // A thinking status would replace the "summarizing" label while a compaction runs.
      if (state?.lastStatus === 'compacting') return [];
      if (state) {
        const now = state.now();
        if (now - state.thinkingAt < THROTTLE_MS) return [];
        state.thinkingAt = now;
      }
      return [{ kind: 'status', status: 'thinking', thinkingTokens: num(m.estimated_tokens) }];
    }
    case 'api_retry':
      return [{ kind: 'status', status: 'retrying', attempt: m.attempt, maxRetries: m.max_retries, retryDelayMs: m.retry_delay_ms,
        errorStatus: m.error_status ?? null, error: m.error ?? null }];
    case 'informational': {
      const text = noticeText(m.content);
      const stops = !!m.prevent_continuation;
      // Info lines and tips are terminal chatter, unless they explain why the turn stopped.
      if (!text || (!stops && !opts.verbose && (m.level === 'info' || m.level === 'suggestion'))) return [];
      const ev = { kind: 'notice', text, tag: m.tag ?? null, toolUseId: m.tool_use_id ?? null, stops };
      if (m.level === 'warning') ev.level = 'warn';
      else if (m.level === 'info') ev.level = 'info';
      return [ev];
    }
    case 'notification': {
      const text = noticeText(m.text);
      if (!text || (m.priority === 'low' && !opts.verbose)) return [];
      if (state) {
        const key = `${m.key ?? ''}\n${text}`;
        if (state.lastNotification === key) return [];
        state.lastNotification = key;
      }
      const ev = { kind: 'notice', text, key: m.key ?? null };
      if (m.priority === 'high' || m.priority === 'immediate') ev.level = 'warn';
      return [ev];
    }
    case 'local_command_output':
      return commandOutput(m.content, 'stdout', null, state);
    case 'model_refusal_fallback': case 'model_refusal_no_fallback':
      return [{
        kind: 'notice', level: 'warn', code: 'model-refusal', text: noticeText(m.content) || 'Claude declined this request.',
        retracted: m.retracted_message_uuids ?? [], refusedUuid: m.refused_user_message_uuid ?? null,
        originalModel: m.original_model ?? null, fallbackModel: m.fallback_model ?? null,
      }];
    // Claude Code named the chat, or you renamed it: the new name, so the window can show it at once.
    case 'session_title_changed': {
      const title = typeof m.title === 'string' ? m.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      return title ? [{ kind: 'title', title, sessionId: m.session_id ?? null }] : [];
    }
    case 'session_writes_lost':
      return [{ kind: 'notice', level: 'warn', code: 'disk-full', text: 'Disk is full: part of this conversation could not be saved.' }];
    case 'permission_denied': {
      const text = noticeText(m.message);
      return opts.verbose && text ? [{ kind: 'notice', code: 'permission-denied', text, toolName: m.tool_name ?? null, toolUseId: m.tool_use_id ?? null }] : [];
    }
    case 'peer_message_hold': return peerHold(m);
    case 'memory_recall': {
      const n = Array.isArray(m.memories) ? m.memories.length : 0;
      return opts.verbose && n ? [{ kind: 'notice', code: 'memory-recall', text: `Recalled ${n} ${n === 1 ? 'memory' : 'memories'}`, paths: m.memories.map((x) => x?.path).filter(Boolean) }] : [];
    }
    default:
      if (SILENT_SYSTEM.has(m.subtype)) return [];
      return unknownFrame(opts, `system/${m.subtype}`, m);
  }
}

// ---- result ----

function sumUsage(map) {
  if (!map || typeof map !== 'object') return { cost: null, usage: null };
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, webSearchRequests: 0 };
  let cost = 0;
  for (const k of Object.keys(map)) {
    const u = map[k] ?? {};
    cost += num(u.costUSD);
    for (const f of Object.keys(usage)) usage[f] += num(u[f]);
  }
  return { cost, usage };
}

function errorCodeOf(m, terminal, text) {
  if (m.subtype === 'error_max_turns' || terminal === 'max_turns') return 'max-turns';
  if (m.subtype === 'error_max_budget_usd' || terminal === 'budget_exhausted') return 'budget';
  if (terminal === 'prompt_too_long') return 'prompt-too-long';
  const s = m.api_error_status;
  if (s === 401 || s === 403) return 'auth';
  if (s === 429 || terminal === 'blocking_limit') return 'rate-limit';
  if (typeof s === 'number' && s >= 500) return 'overloaded';
  if (terminal === 'stop_hook_prevented' || terminal === 'hook_stopped') return 'hook';
  if (typeof s === 'number' && s >= 400) return /prompt is too long/i.test(text) ? 'prompt-too-long' : 'api';
  if (terminal === 'api_error' || terminal === 'model_error' || terminal === 'image_error') return 'api';
  if (m.is_error && /prompt is too long/i.test(text)) return 'prompt-too-long';
  return null;
}

function resultEvents(m, state) {
  const model = state?.turnModel ?? null;
  if (state) { state.lastOutput = null; state.lastNotification = null; state.maxOutput = false; state.tools.clear(); state.turnModel = null; }
  const terminal = m.terminal_reason ?? null;
  // A turn the user stopped is not a failure, whatever the subtype says.
  const interrupted = terminal === 'aborted_streaming' || terminal === 'aborted_tools';
  const allErrors = Array.isArray(m.errors) ? m.errors.map(String) : m.errors ? [String(m.errors)] : [];
  const errors = interrupted ? [] : allErrors.filter((e) => !e.startsWith('[ede_diagnostic]'));
  const text = typeof m.result === 'string' ? m.result : '';
  const turn = sumUsage(m.model_usage_since_last_result);
  const errorCode = interrupted ? null : errorCodeOf(m, terminal, `${text}\n${errors.join('\n')}`);
  const origin = m.origin && typeof m.origin === 'object' ? { ...m.origin } : null;
  if (origin) delete origin.body;
  return [{
    kind: 'turn-end', subtype: m.subtype, isError: !interrupted && (!!m.is_error || m.subtype !== 'success'),
    cost: m.total_cost_usd, durationMs: m.duration_ms, turns: m.num_turns,
    errors, text,
    fastState: m.fast_mode_state ?? null, fastReason: m.fast_mode_disabled_reason ?? null,
    interrupted, turnCost: turn.cost, turnUsage: turn.usage,
    apiMs: m.duration_api_ms ?? null, ttftMs: m.ttft_ms ?? null, ttftStreamMs: m.ttft_stream_ms ?? null, timeToRequestMs: m.time_to_request_ms ?? null,
    stopReason: m.stop_reason ?? null, terminalReason: terminal, apiStatus: m.api_error_status ?? null,
    usage: m.usage ?? null, modelUsage: m.modelUsage ?? null,
    denials: (m.permission_denials ?? []).map((d) => ({ toolName: d?.tool_name ?? null, toolUseId: d?.tool_use_id ?? null,
      input: d?.tool_input != null && !exceeds(d.tool_input, 4 * KB) ? d.tool_input : null })),
    queued: num(m.queued_turn_count), origin,
    userUuid: m.user_message_uuid ?? null, userUuids: userUuids(m), sessionId: m.session_id ?? null,
    localCommand: m.local_command ?? null, startupFailure: m.startup_failure_reason ?? null,
    credentialExpiresAt: m.credential_expires_at ?? null,
    errorCode,
    reason: errorCode === 'max-turns' ? 'Stopped: turn limit reached.' : errorCode === 'budget' ? 'Stopped: spending limit reached.' : null,
    // Which model ran the turn, for its footer: null when no reply of the turn's own was seen.
    model,
  }];
}

// ---- rate limits, sign-in ----

/**
 * How much of a limit is used, as a percentage (0-100), or null when Claude Code did not say.
 * A limit update gives a 0-1 fraction where `usage()` gives 0-100: everything Canopy keeps is the percentage.
 * A value well above 1 can only be a percentage already.
 */
export function limitPercent(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v <= 1.5 ? v * 100 : v;
}

function rateLimitEvents(m, state) {
  const info = m.rate_limit_info ?? {};
  const ms = (v) => (typeof v === 'number' && v > 0 ? (v < 1e12 ? v * 1000 : v) : null); // seconds on some builds
  const resetsAt = ms(info.resetsAt);
  if (state) {
    // Utilization is left out of the key on purpose: one warning per window, not one per percent.
    const key = `${info.status}|${info.rateLimitType ?? ''}|${resetsAt ?? ''}`;
    if (state.rateKey === key) return [];
    state.rateKey = key;
  }
  if (info.status !== 'rejected' && info.status !== 'allowed_warning') return [];
  const rateLimit = { ...info, resetsAt, overageResetsAt: ms(info.overageResetsAt) };
  // The two sentences are worded in limits.mjs, the one place both makers' limit notices come from.
  const name = LIMIT_NAMES[info.rateLimitType];
  if (info.status === 'rejected') {
    return [{ kind: 'notice', level: 'warn', code: 'rate-limit', rateLimit, resetsAt, text: reachedText({ name, resetsAt }) }];
  }
  const pct = limitPercent(info.utilization);
  const u = pct ? Math.round(pct) : null;
  return [{ kind: 'notice', code: 'rate-limit-warning', rateLimit, resetsAt, text: nearingText({ name, usedPercent: u, resetsAt }) }];
}

function authEvents(m) {
  if (m.error) return [{ kind: 'notice', level: 'warn', code: 'auth', text: `Sign-in problem: ${noticeText(m.error).slice(0, 300)}` }];
  if (m.isAuthenticating) return [{ kind: 'status', status: 'authenticating', output: Array.isArray(m.output) ? m.output.slice(-5).map(String) : [] }];
  return [];
}

// ---- entry points ----

function run(m, opts, state) {
  try {
    switch (m?.type) {
      case 'stream_event': return streamEvents(m, opts, state);
      case 'assistant': return assistantEvents(m, opts, state, !!opts.history);
      case 'user':
        // Replays are Claude Code confirming what the host sent, which the window already shows. The one that is
        // news is a message another chat sent here.
        if (m.isReplay) return !opts.history && m.origin?.kind === 'peer' ? livePeer(m, state) : [];
        return opts.history ? historyUser(m, opts) : liveUser(m, opts, state);
      case 'system': return systemEvents(m, opts, state);
      case 'result': return resultEvents(m, state);
      case 'tool_progress':
        return [{ kind: 'tool-progress', id: m.tool_use_id, name: m.tool_name, elapsed: m.elapsed_time_seconds,
          parent: m.parent_tool_use_id ?? null, taskId: m.task_id ?? null }];
      case 'rate_limit_event': return rateLimitEvents(m, state);
      case 'prompt_suggestion': return [{ kind: 'suggestion', text: m.suggestion ?? m.text ?? '' }];
      case 'auth_status': return authEvents(m);
      case 'conversation_reset':
        if (state) { state.tools.clear(); state.messageId = null; state.lastStatus = null; state.lastOutput = null; state.lastNotification = null; state.maxOutput = false; state.turnModel = null; }
        // session_id on this frame is still the old conversation; the next init carries the new one.
        return [{ kind: 'notice', code: 'conversation-reset', reset: true, trigger: m.trigger ?? null, at: timeOf(m) ?? Date.now(),
          userUuid: m.user_message_uuid ?? null, text: m.trigger === 'plan_mode_exit' ? 'Conversation cleared to start on the plan' : 'Conversation cleared' }];
      default:
        if (SILENT_TYPES.has(m?.type)) return [];
        return unknownFrame(opts, `${m?.type ?? 'unknown'}${m?.subtype ? `/${m.subtype}` : ''}`, m);
    }
  } catch (err) {
    return adapterError(err, m);
  }
}

export function adapt(m, opts = {}) {
  return run(m, opts ?? {}, null);
}

// One per conversation process. Remembers what a single frame cannot know: which
// tool call a streamed input delta belongs to, what was already said, and when.
export function createAdapter(opts = {}) {
  const base = opts ?? {};
  const fresh = () => ({
    now: typeof base.now === 'function' ? base.now : Date.now,
    tools: new Map(),      // stream block index -> { id, name, bytes, sent, sentAt, json, partSent, partAt, started }
    messageId: null,
    lastStatus: null,
    rateKey: null,
    lastOutput: null,
    lastNotification: null,
    maxOutput: false,
    thinkingAt: -Infinity,
    peers: new Set(),      // uuids of messages from other chats already shown
    turnModel: null,       // the model of the running turn's last top-level reply
  });
  let state = fresh();
  return {
    adapt: (m, o) => run(m, o ? { ...base, ...o } : base, state),
    reset: () => { state = fresh(); },
  };
}

// History replay for resumed sessions (SessionMessage has the same core shape).
// The tool results of a saved chat that keep their pictures: the latest few that have any. A chat is redrawn from
// its saved rows every time it is switched to, so without these the screenshot of a look Claude has just taken is
// gone the moment the user comes back to see it. Only the latest, so a long chat stays light to load.
function latestPictures(rows) {
  const ids = new Set();
  let chars = 0;
  for (let i = rows.length - 1; i >= 0 && ids.size < HISTORY_PICTURES; i--) {
    const c = rows[i]?.type === 'user' ? rows[i].message?.content : null;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0 && ids.size < HISTORY_PICTURES; j--) {
      const b = c[j];
      if (b?.type !== 'tool_result' || !Array.isArray(b.content) || typeof b.tool_use_id !== 'string') continue;
      const size = b.content.reduce((n, x) => n + (x?.type === 'image' && x.source?.type === 'base64' && typeof x.source.data === 'string' ? x.source.data.length : 0), 0);
      if (!size) continue;
      if (chars + size > HISTORY_PICTURE_CHARS) return ids;
      chars += size;
      ids.add(b.tool_use_id);
    }
  }
  return ids;
}

export function adaptHistory(messages, opts = {}) {
  const o = { ...(opts ?? {}), history: true };
  const out = [];
  if (!messages || typeof messages[Symbol.iterator] !== 'function') return out;
  if (!Array.isArray(messages)) messages = [...messages];
  if (o.images === undefined) o.pictures = latestPictures(messages);
  const open = new Map(); // tool call id -> { start, turn }
  let turn = 0;
  let model = null;       // the model of the turn's last top-level reply, for a saved turn end that has one
  for (const m of messages) {
    if (!m || m.type === 'system') continue;
    for (const ev of run(m, o, null)) {
      if (ev.kind === 'tool-start') open.set(ev.id, { start: ev, turn });
      else if (ev.kind === 'tool-result') open.delete(ev.id);
      else if (ev.kind === 'user-text' && !ev.parent && !ev.steered) { turn++; model = null; } // a steer is in the running turn
      else if (ev.kind === 'assistant-text' && !ev.parent && typeof ev.model === 'string' && ev.model) model = ev.model;
      else if (ev.kind === 'turn-end') { if (!ev.model) ev.model = model; model = null; }
      out.push(ev);
    }
  }
  // A call with no saved result never finished (stopped, crashed, app closed).
  for (const [id, { start, turn: startedIn }] of open) {
    if (o.inFlight && startedIn === turn) continue;
    out.push({
      kind: 'tool-result', id, content: '', isError: true, interrupted: true, history: true,
      parent: start.parent ?? null, uuid: start.uuid ?? null, at: start.at ?? null,
      images: [], imagesOmitted: 0, truncated: false, fullLength: 0, structured: null, detached: false,
    });
  }
  return out;
}

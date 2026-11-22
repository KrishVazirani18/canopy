// Replaying a saved conversation as Canopy events.
// loadHistory never throws: a failure is one warn notice, so the chat still opens.
import path from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { adaptHistory } from './adapter.mjs';
import { isSessionId } from './env.mjs';

const MAX_CACHED_EVENTS = 50000;
const MAX_IMAGES = 20;
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const dirOpt = (cwd) => (typeof cwd === 'string' && cwd && !cwd.includes('\0') && path.isAbsolute(cwd) ? { dir: cwd } : {});
const pageOpt = (limit, offset) => ({
  ...(Number.isInteger(limit) && limit > 0 && { limit }),
  ...(Number.isInteger(offset) && offset > 0 && { offset }),
});
const failure = (err) => [{ kind: 'notice', level: 'warn', code: 'history-failed', text: `Could not load history: ${err?.message ?? err}` }];

let cache = null;                 // one entry: { key, events }
const inflight = new Map();       // request -> promise

/**
 * A saved session as the events a live one would have produced.
 * The last result is kept and reused while the transcript on disk is unchanged (same modified
 * time and size), so reopening or reloading the same chat does not parse it again.
 * @param {string} sessionId
 * @param {string} cwd the folder the session belongs to
 * @param {{force?: boolean, limit?: number, offset?: number}} [opts]
 * @returns {Promise<object[]>} Canopy events
 */
export function loadHistory(sessionId, cwd, { force = false, limit, offset } = {}) {
  if (!isSessionId(sessionId)) return Promise.resolve([]);
  const request = [sessionId, typeof cwd === 'string' ? cwd : '', limit ?? '', offset ?? ''].join('\0');
  if (!force) { const running = inflight.get(request); if (running) return running.then((events) => events.slice()); }
  const p = (async () => {
    try {
      if (typeof sdk.getSessionMessages !== 'function') throw new Error('This version of the Claude Agent SDK cannot read sessions.');
      const where = dirOpt(cwd);
      const info = typeof sdk.getSessionInfo === 'function' ? await sdk.getSessionInfo(sessionId, where).catch(() => undefined) : undefined;
      const key = info ? `${request}\0${info.lastModified}\0${info.fileSize ?? ''}` : null;
      if (!force && key && cache?.key === key) return cache.events;
      const messages = await sdk.getSessionMessages(sessionId, { ...where, ...pageOpt(limit, offset) });
      const events = adaptHistory(Array.isArray(messages) ? messages : [], { history: true });
      if (key && events.length <= MAX_CACHED_EVENTS) cache = { key, events };
      else if (cache && cache.key.startsWith(`${sessionId}\0`)) cache = null;
      return events;
    } catch (err) { return failure(err); }
  })();
  inflight.set(request, p);
  p.finally(() => { if (inflight.get(request) === p) inflight.delete(request); });
  // Callers get their own array; the events themselves are shared and must be treated as read-only.
  return p.then((events) => events.slice());
}

/** Drop the cached history (for example after a fork or a delete). */
export function clearHistoryCache() { cache = null; }

/** Ids of the subagents that ran inside a session. */
export async function listSubagents(sessionId, cwd) {
  try {
    if (!isSessionId(sessionId) || typeof sdk.listSubagents !== 'function') return [];
    const ids = await sdk.listSubagents(sessionId, dirOpt(cwd));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && AGENT_ID.test(id)) : [];
  } catch { return []; }
}

/**
 * One subagent's own transcript as events, loaded only when the user opens it.
 * @returns {Promise<object[]>}
 */
export async function loadSubagentHistory(sessionId, agentId, cwd, { limit, offset } = {}) {
  if (!isSessionId(sessionId) || typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return [];
  try {
    if (typeof sdk.getSubagentMessages !== 'function') return [];
    const messages = await sdk.getSubagentMessages(sessionId, agentId, { ...dirOpt(cwd), ...pageOpt(limit, offset) });
    // In its own transcript the subagent is the main thread: drop the parent link so its text is shown.
    const rows = (Array.isArray(messages) ? messages : []).map((m) => (m?.parent_tool_use_id ? { ...m, parent_tool_use_id: null } : m));
    return adaptHistory(rows, { history: true, subagent: agentId });
  } catch (err) { return failure(err); }
}

function collectImages(content, out) {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (out.length >= MAX_IMAGES) return;
    if (b?.type === 'image' && b.source?.type === 'base64' && IMAGE_TYPES.has(b.source.media_type)
      && typeof b.source.data === 'string' && b.source.data.length <= MAX_IMAGE_BASE64) {
      out.push({ mediaType: b.source.media_type, data: b.source.data });
    } else if (b?.type === 'tool_result') collectImages(b.content, out);
  }
}

/**
 * The images attached to one saved message (a prompt's attachments or a tool result's
 * screenshots). History events only carry counts; the pixels are fetched here when shown.
 * @param {string} sessionId
 * @param {string} uuid the message's uuid, as found on its history events
 * @returns {Promise<{mediaType: string, data: string}[]>}
 */
export async function loadHistoryImages(sessionId, uuid, cwd) {
  try {
    if (!isSessionId(sessionId) || !isSessionId(uuid) || typeof sdk.getSessionMessages !== 'function') return [];
    const messages = await sdk.getSessionMessages(sessionId, dirOpt(cwd));
    const row = (Array.isArray(messages) ? messages : []).find((m) => m?.uuid === uuid);
    const out = [];
    collectImages(row?.message?.content, out);
    return out;
  } catch { return []; }
}

// What each chat started with, kept so a chat that is reopened later (after a restart of Canopy too) is given the
// same again.
//
// A chat's tools are part of the start of every request it makes. One that comes or goes later makes the model
// re-read the whole conversation at full price, so the two switches that add or remove tools are decided when a chat
// starts and are for new chats from then on: Code Mode (a Claude chat; see `toolsFixed` in core/session.mjs) and
// Canopy Memory (a chat of either maker: remember, recall and forget, and the notes it is told at its start). The
// engine fixes them when the chat begins; this is the host's half: what each chat was fixed at, in state.json
// (chatTools: sessionId -> true | false for Code Mode alone, as older records are, or { codeMode?, memory? }).

const MAX_CHATS = 2000; // the newest are kept; an older chat reopened after that starts with the choices as they are then

// Older records are a plain on/off for Code Mode, and some held a language-server choice too: only what is still a
// choice is read.
const read = (kept) => {
  if (typeof kept === 'boolean') return { codeMode: kept };
  if (!kept || typeof kept !== 'object') return null;
  const out = {};
  if (typeof kept.codeMode === 'boolean') out.codeMode = kept.codeMode;
  if (typeof kept.memory === 'boolean') out.memory = kept.memory;
  return Object.keys(out).length ? out : null;
};
const write = (now) => (now.memory === undefined ? now.codeMode : now);

/**
 * What a chat started with, as Session's `startedWith` option, or undefined when nothing is recorded for it (a chat
 * from before this was kept, or one started in the terminal): it then takes the choices as they are when reopened.
 * A record from before Canopy Memory says nothing about memory, and that chat takes the switch as it is too.
 * @param {Record<string, boolean | {codeMode?: boolean, memory?: boolean}>|undefined} saved state.json's chatTools
 * @returns {{ codeMode?: boolean, memory?: boolean } | undefined}
 */
export function startedWith(saved, sessionId) {
  const kept = sessionId && saved && Object.hasOwn(saved, sessionId) ? saved[sessionId] : undefined;
  return read(kept) ?? undefined;
}

/**
 * Whether a chat is given Canopy Memory: a chat that is being reopened as it started, whatever the switch says
 * now, and any other chat (a new one, or one nothing is recorded for) by the switch.
 * @param {Record<string, unknown>|undefined} saved state.json's chatTools
 * @param {string|null|undefined} sessionId the chat being reopened, if it is one
 * @param {boolean} on the switch in Settings, as it is now
 */
export function startsWithMemory(saved, sessionId, on) {
  return startedWith(saved, sessionId)?.memory ?? on === true;
}

/**
 * The map to save once a chat's tools are fixed, or null when it already says so. The chat moves to the end, and
 * the oldest are dropped beyond `max`.
 * @param {Record<string, boolean | {codeMode?: boolean, memory?: boolean}>|undefined} saved state.json's chatTools
 * @param {{codeMode?: boolean, memory?: boolean}|null|undefined} started the chat's `startedWith` (null until it has begun)
 */
export function rememberTools(saved, sessionId, started, max = MAX_CHATS) {
  const now = read(started);
  if (typeof sessionId !== 'string' || !sessionId || !now) return null;
  const all = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const was = Object.hasOwn(all, sessionId) ? read(all[sessionId]) : null;
  if (was && was.codeMode === now.codeMode && was.memory === now.memory) return null;
  const rest = Object.entries(all).filter(([id, kept]) => id !== sessionId && read(kept));
  return Object.fromEntries([...rest, [sessionId, write(now)]].slice(-max));
}

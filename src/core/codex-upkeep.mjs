// Codex upkeep: what is Codex's own about keeping the user's Codex current. The loop itself (when to check, never
// while a chat is working, a repair at most every 10 minutes, the drift list) is the Upkeep class in upkeep.mjs,
// run a second time with the pieces below.
//
//   CODEX_MIN_VERSION        the oldest Codex this Canopy works with (the one every recording was made on)
//   codexTooOld(version)     is this Codex older than that? An unknown version is not
//   CODEX_TOO_OLD            what a chat that cannot open on it answers
//   updateCodex(...)         run `codex update` and say what happened, judged by the version before and after
//   codexUpdatesOff(service) has the user told Codex not to look for updates?
//   CODEX_UPDATES_OFF        the sentence Settings shows then
//   restartIdleCodex(...)    after an update: let go of every Codex process that is not working
//
// Contract:
//  - Nothing here throws or rejects.
//  - `codex update` is Codex's own command. It knows how Codex was installed and runs the right thing itself
//    (`brew upgrade --cask codex` for a Homebrew install, `npm install -g @openai/codex` for an npm one, and so
//    on), so Canopy never guesses an installer. An install Codex cannot update fails cleanly, with its last line
//    as the reason.
//  - Nothing under ~/.codex is read or written. The user's "do not check for updates" is asked through the
//    app-server (`config/read`).
//  - A process that is working, or waiting on the user, is never stopped here.
import { codexEnv } from './codex-host.mjs';
import { compareVersions, lastLine, runCommand, versionText } from './upkeep.mjs';

export const CODEX_MIN_VERSION = '0.153.4';
export const CODEX_TOO_OLD = 'Codex is too old for this version of Canopy. Canopy is updating it. Try again in a minute.';
export const CODEX_UPDATES_OFF = 'Updates are turned off in your Codex settings.';

const UPDATE_LIMIT_MS = 10 * 60_000; // Homebrew may refresh itself before it upgrades anything
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** Is this Codex older than Canopy needs? False for a version that could not be read: nothing is blocked on a guess. */
export function codexTooOld(version, min = CODEX_MIN_VERSION) {
  return compareVersions(version, min) === -1;
}

/**
 * Run `codex update` and say what happened. Judged by `codex --version` before and after, never by what the
 * command prints: Homebrew can be behind Codex's own newest, and the wording changes between releases.
 * `runFn` is how a command is run (tests always pass one: a real update is never run by a test).
 * @returns {Promise<{result: 'updated'|'current'|'failed', from?: string, to?: string, version?: string|null, detail?: string}>}
 */
export async function updateCodex({ codexPath, env, runFn = runCommand, timeoutMs = UPDATE_LIMIT_MS } = {}) {
  try {
    if (typeof codexPath !== 'string' || !codexPath) return { result: 'failed', version: null, detail: 'Codex is not installed.' };
    const childEnv = codexEnv(isPlain(env) ? env : undefined); // the shell environment Canopy loaded: that is where `brew` is on the PATH
    const version = async () => { const r = await runFn(codexPath, ['--version'], { env: childEnv, timeoutMs: 15_000 }); return r?.ok ? versionText(r.stdout) : null; };
    const before = await version();
    const r = await runFn(codexPath, ['update'], { env: childEnv, timeoutMs });
    const after = await version();
    if (before && after && compareVersions(after, before) === 1) return { result: 'updated', from: before, to: after };
    if (r?.ok) return { result: 'current', version: after ?? before };
    const detail = r?.timedOut ? 'The update took too long and was stopped.' : lastLine(r?.stderr) || lastLine(r?.stdout) || 'Codex did not say why.';
    return { result: 'failed', version: after ?? before, detail };
  } catch (err) { return { result: 'failed', version: null, detail: String(err?.message ?? err).slice(0, 300) }; }
}

/**
 * Has the user told Codex not to look for updates (`check_for_update_on_startup = false` in their Codex settings)?
 * That is their "do not update me", and Canopy keeps to it. Asked through the app-server; false when Codex is
 * missing or cannot say.
 * @param {{ call?: (method: string, params?: object) => Promise<{ok: boolean, result?: object}> } | null} service a CodexService
 */
export async function codexUpdatesOff(service) {
  try {
    if (typeof service?.call !== 'function') return false;
    const r = await service.call('config/read', { includeLayers: false });
    return r?.ok === true && isPlain(r.result?.config) && r.result.config.check_for_update_on_startup === false;
  } catch { return false; }
}

const working = (s) => !!s?.busy || (s?.pending?.size ?? 0) > 0;

/**
 * Codex was updated: every Codex process that is doing nothing is let go, so the next thing it is asked runs on
 * the new Codex. The shared helper is retired unless a call is in flight (it goes a minute after its last call
 * anyway). An idle chat's process is stopped: the conversation is kept and the next message resumes it. A chat
 * that is working, or waiting for an answer, is left exactly as it is.
 * @param {{ service?: { active?: number, retire?: () => unknown } | null, sessions?: () => object[] }} o `sessions`: every open chat's session
 * @returns {Promise<{ retired: boolean, stopped: number }>}
 */
export async function restartIdleCodex({ service, sessions } = {}) {
  const out = { retired: false, stopped: 0 };
  try {
    if (service && typeof service.retire === 'function' && !(service.active > 0)) { await Promise.resolve(service.retire()).catch(() => {}); out.retired = true; }
  } catch { /* it goes on its own a minute after its last call */ }
  let list = [];
  try { const got = typeof sessions === 'function' ? sessions() : []; list = Array.isArray(got) ? got : []; } catch { list = []; }
  for (const s of list) {
    try {
      if (s?.engine !== 'codex' || s.closed || working(s) || typeof s.stop !== 'function') continue;
      Promise.resolve(s.stop()).catch(() => {});
      out.stopped += 1;
    } catch { /* one chat never stops the rest */ }
  }
  return out;
}

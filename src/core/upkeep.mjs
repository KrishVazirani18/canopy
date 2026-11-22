// Claude Code upkeep: the "IT work" of running Claude Code, done by Canopy so you never have to.
//
//   - Keeps Claude Code current: `claude update` in the background, only while no chat is working.
//   - Repairs a Claude Code that is too old for Canopy's engine by updating it, instead of asking you to.
//   - Reads what each model name really runs, from Claude Code itself. Its picker can pin a family to an
//     older release (Fable 5.1 while `fable` already runs 5.2); that row is offered at its newest instead.
//   - Remembers the frames Claude Code sends that Canopy does not understand yet (drift), so a change in
//     Claude Code shows up as a short list to fix, not as something that quietly stopped showing.
//
// The Upkeep class never touches Electron or a process directly: the host injects how to update, probe,
// persist and report. Everything here is unit-testable without claude. Nothing exported throws.
//
// The same class keeps Codex current too: a second instance, given `name: 'Codex'`, Codex's own update command
// and Codex's own "do not update me" (src/core/codex-upkeep.mjs). It has no models to probe. Left unnamed, an
// instance is Claude Code's.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { withTimeout } from './supervisor.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------- versions ----------

/** [major, minor, patch] from "2.1.322 (Claude Code)", or null. */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "2.1.322" from anything parseVersion reads, or null. */
export const versionText = (s) => parseVersion(s)?.join('.') ?? null;

/** -1, 0 or 1; null when either side is not a version. Takes strings or number arrays of any length. */
export function compareVersions(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a);
  const y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// ---------- models ----------

// A full model id: claude-fable-5-1, claude-opus-5-5-20261001, claude-opus-6, claude-opus-6-20270115, claude-fable-5-1[1m].
// The minor is at most two digits, so a date is never read as one. Aliases (opus, fable[1m]) don't match.
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/;

/** { family, version: [major] or [major, minor], long } for a full model id, else null. */
export function modelFamily(id) {
  const m = MODEL_ID.exec(String(id ?? ''));
  if (!m) return null;
  return { family: m[1], version: m[3] === undefined ? [Number(m[2])] : [Number(m[2]), Number(m[3])], long: !!m[4] };
}

/**
 * Picker rows pinned to one release (a full model id where the others are aliases), with the alias that
 * follows the family instead. A family whose alias is already in the picker is left alone.
 */
export function pinnedRows(models) {
  const list = Array.isArray(models) ? models : [];
  const values = new Set(list.map((m) => m?.value));
  const out = [];
  for (const row of list) {
    const f = modelFamily(row?.value);
    if (!f) continue;
    const alias = f.family + (f.long ? '[1m]' : '');
    if (values.has(alias)) continue;
    out.push({ value: row.value, alias, ...f });
  }
  return out;
}

// "Fable 5.1 · Most capable…" -> "Fable 5.2 · Most capable…". Only a whole version number is replaced.
function swapVersion(text, was, is) {
  if (typeof text !== 'string') return text;
  return text.replace(new RegExp(`(^|[^\\d.])${was.replace('.', '\\.')}(?![\\d])`), `$1${is}`);
}

/**
 * Picker rows to replace: each pinned row whose family alias runs the same or a newer release. The same release is
 * swapped too, so a choice saved as the alias keeps its row once Claude Code's own pin catches up (`was === is`).
 * `resolved` maps an alias to the model id Claude Code runs for it (null when it does not know the alias).
 * @returns {{from: string, was: string, is: string, to: {value: string, displayName?: string, description?: string, resolvedModel: string}}[]}
 */
export function modelFixups(models, resolved) {
  const out = [];
  for (const p of pinnedRows(models)) {
    const id = resolved?.[p.alias];
    const now = modelFamily(id);
    const cmp = now && now.family === p.family ? compareVersions(now.version, p.version) : null;
    if (cmp !== 0 && cmp !== 1) continue;
    const row = models.find((m) => m?.value === p.value) ?? {};
    const was = p.version.join('.');
    const is = now.version.join('.');
    out.push({ from: p.value, was, is, to: { ...row, value: p.alias, resolvedModel: id, description: swapVersion(row.description, was, is) } });
  }
  return out;
}

// A prompt stream that never sends anything: the probe only asks control questions.
async function* silent(signal) {
  await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
}

/**
 * Ask Claude Code which models its picker offers, and what each pinned family's alias really runs.
 * Starts one throwaway process with no settings (no hooks, plugins or MCP servers) and never sends a
 * prompt, so nothing is billed and no conversation is saved. Rejects on failure or timeout.
 * @returns {Promise<{cliVersion: string|null, models: object[], resolved: Record<string, string|null>}>}
 */
export async function probeModels({ query, claudePath, env, cwd = os.homedir(), timeoutMs = 45_000 }) {
  const stop = new AbortController();
  let q = null;
  try {
    q = query({ prompt: silent(stop.signal), options: { pathToClaudeCodeExecutable: claudePath, cwd, env, settingSources: [] } });
    const work = (async () => {
      const init = await q.initializationResult();
      const models = Array.isArray(init?.models) ? init.models : await q.supportedModels();
      const resolved = {};
      for (const p of pinnedRows(models)) {
        try { await q.setModel(p.alias); resolved[p.alias] = (await q.getContextUsage())?.model ?? null; }
        catch { resolved[p.alias] = null; } // this Claude Code does not know the alias
      }
      return { cliVersion: versionText(init?.claude_code_version), models, resolved };
    })();
    return await withTimeout(work, timeoutMs, 'model check');
  } finally {
    stop.abort();
    try { q?.close?.(); } catch { /* already gone */ }
  }
}

/**
 * Ask Claude Code how much of a plan's limits is used, when no chat is open to ask through. Like the model check:
 * one throwaway process with no settings (no hooks, plugins or MCP servers) that is never sent a prompt, so nothing
 * is billed and no conversation is saved. `env` decides which login answers; `appVersion` is the name Canopy gives.
 * Resolves to { supported: false } when this Claude Code has no such call (it is experimental and may go), else
 * { supported: true, usage: { subscriptionType, rateLimitsAvailable, rateLimits } } as Session.usage() gives it.
 * Rejects on failure or timeout.
 */
export async function probeUsage({ query, claudePath, env, appVersion, cwd = os.homedir(), timeoutMs = 30_000 }) {
  const stop = new AbortController();
  let q = null;
  try {
    const launch = { ...env, ...(appVersion && { CLAUDE_AGENT_SDK_CLIENT_APP: `canopy/${appVersion}` }) };
    q = query({ prompt: silent(stop.signal), options: { pathToClaudeCodeExecutable: claudePath, cwd, env: launch, settingSources: [] } });
    const work = (async () => {
      await q.initializationResult();
      const ask = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof ask !== 'function') return { supported: false };
      const r = await ask.call(q, { skipBehaviors: true });
      if (!r || typeof r !== 'object') throw new Error('Claude Code gave no usage answer.');
      return { supported: true, usage: { subscriptionType: r.subscription_type ?? null, rateLimitsAvailable: !!r.rate_limits_available, rateLimits: r.rate_limits ?? null } };
    })();
    return await withTimeout(work, timeoutMs, 'usage check');
  } finally {
    stop.abort();
    try { q?.close?.(); } catch { /* already gone */ }
  }
}

// ---------- updating ----------

/** Run one command to its end: { ok, stdout, stderr, timedOut }. Never rejects. */
export function runCommand(cmd, args, { env, cwd = os.homedir(), timeoutMs = 10 * MINUTE } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { env, cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: !!err && (err.killed === true || err.code === 'ETIMEDOUT') });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    } catch (err) { resolve({ ok: false, stdout: '', stderr: String(err?.message ?? err), timedOut: false }); }
  });
}

/** The last line a command printed that says anything, cut to 300 characters. */
export const lastLine = (s) => String(s ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300) ?? '';

/**
 * Run `claude update` and say what happened, judged by the version before and after rather than by
 * the wording of its output (which changes between releases).
 * @returns {Promise<{result: 'updated'|'current'|'failed', from?: string, to?: string, version?: string|null, detail?: string}>}
 */
export async function updateClaude({ claudePath, env, runFn = runCommand }) {
  const version = async () => { const r = await runFn(claudePath, ['--version'], { env, timeoutMs: 15_000 }); return r.ok ? versionText(r.stdout) : null; };
  const before = await version();
  const r = await runFn(claudePath, ['update'], { env });
  const after = await version();
  if (before && after && compareVersions(after, before) === 1) return { result: 'updated', from: before, to: after };
  if (r.ok && /up to date/i.test(r.stdout + r.stderr)) return { result: 'current', version: after ?? before };
  const detail = r.timedOut ? 'The update took too long and was stopped.' : lastLine(r.stderr) || lastLine(r.stdout) || 'Claude Code did not say why.';
  return { result: 'failed', version: after ?? before, detail };
}

// ---------- the upkeep loop ----------

const DRIFT_MAX = 30;
const truthy = (v) => typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
// Claude Code's own ways of saying "don't update me in the background", in its environment or settings.json `env`.
const OPT_OUTS = ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];

export class Upkeep {
  /**
   * @param {{
   *   claude: () => ({path: string|null, env: object|null, version: string|null}),
   *   refreshVersion: () => Promise<string|null>,
   *   isBusy: () => boolean,
   *   load?: () => object|null, save?: (state: object) => void,
   *   update?: (c: {path: string, env: object}) => Promise<object>,
   *   probe?: (c: {path: string, env: object}) => Promise<{cliVersion: string|null, models: object[], resolved: object}>,
   *   engineVersion?: string|null,
   *   name?: string,                       the tool this instance looks after, as people call it (default 'Claude Code')
   *   blocked?: (c: object) => string|null,  that tool's own "do not update me", as a sentence. Given, it is asked
   *                                        instead of Claude Code's environment switches
   *   onChange?: (status: object, note: object|null) => void,
   *   log?: (msg: string) => void,
   *   now?: () => number, timers?: {set: Function, clear: Function},
   *   firstCheckMs?: number, everyMs?: number, retryMs?: number,
   * }} deps
   */
  constructor(deps) {
    this.claude = deps.claude;
    this.refreshVersion = deps.refreshVersion;
    this.isBusy = deps.isBusy ?? (() => false);
    this.saveFn = deps.save ?? (() => {});
    this.updateFn = deps.update ?? ((c) => updateClaude({ claudePath: c.path, env: c.env }));
    this.probeFn = deps.probe ?? null;
    this.name = typeof deps.name === 'string' && deps.name ? deps.name : 'Claude Code';
    this.command = this.name.split(' ')[0].toLowerCase(); // its command, for the log: `claude update`, `codex update`
    this.blockedFn = typeof deps.blocked === 'function' ? deps.blocked : null;
    this.engineVersion = versionText(deps.engineVersion);
    this.onChange = deps.onChange ?? (() => {});
    this.logFn = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (t) => clearTimeout(t) };
    this.firstCheckMs = deps.firstCheckMs ?? 30_000;
    this.everyMs = deps.everyMs ?? 6 * HOUR;
    this.retryMs = deps.retryMs ?? 10 * MINUTE;
    this.scheduled = deps.schedule !== false; // false: never update on a timer (a throwaway test copy), only on Check now

    let saved = null;
    try { saved = deps.load?.() ?? null; } catch { /* unreadable: start fresh */ }
    const s = saved && typeof saved === 'object' ? saved : {};
    this.state = {
      autoUpdate: s.autoUpdate !== false,
      lastCheck: s.lastCheck ?? null,
      lastUpdate: s.lastUpdate ?? null,
      models: s.models && Array.isArray(s.models.fixups) ? s.models : null,
      drift: Array.isArray(s.drift) ? s.drift.slice(-DRIFT_MAX) : [],
    };
    this.doing = null;        // 'updating' | 'checking-models' | null
    this.updating = null;     // the running update, which every caller shares
    this.probing = null;
    this.timer = null;
    this.lastRepairAt = 0;
    this.stopped = false;
  }

  // ---- what the UI shows ----

  status() {
    const c = this.#claude();
    const version = versionText(c.version);
    return {
      autoUpdate: this.state.autoUpdate,
      blockedBy: this.#blockedBy(c),
      version,
      engineVersion: this.engineVersion,
      behind: !!version && !!this.engineVersion && compareVersions(version, this.engineVersion) === -1,
      doing: this.doing,
      lastCheck: this.state.lastCheck,
      lastUpdate: this.state.lastUpdate,
      fixups: this.state.models?.fixups ?? [],
      drift: this.state.drift,
    };
  }

  // ---- lifecycle ----

  /**
   * Check models now, and Claude Code itself soon: right away if it is older than the engine expects.
   * Always announces the status once, so a window that asked before upkeep existed still gets it.
   */
  start() {
    this.stopped = false;
    this.#emit();
    this.ensureModels().catch(() => {});
    this.#schedule(this.status().behind ? 0 : this.firstCheckMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }

  setAutoUpdate(on) {
    this.state.autoUpdate = on === true;
    this.#save();
    this.#emit();
    if (this.state.autoUpdate) this.#schedule(5_000);
  }

  // ---- updating ----

  /**
   * Bring Claude Code up to date. Scheduled runs wait while a chat is working and respect the switch;
   * `force` (Check now, a repair) runs regardless. Concurrent calls share one run.
   * @returns {Promise<{result: 'updated'|'current'|'failed'|'off'|'deferred', from?: string, to?: string, detail?: string}>}
   */
  update({ force = false, reason = 'scheduled' } = {}) {
    if (this.updating) return this.updating;
    const c = this.#claude();
    if (!force && !this.state.autoUpdate) return Promise.resolve({ result: 'off' });
    if (!force && this.#blockedBy(c)) return Promise.resolve({ result: 'off', detail: this.#blockedBy(c) });
    if (!force && this.isBusy()) {
      this.#schedule(this.retryMs);
      return Promise.resolve({ result: 'deferred' });
    }
    if (!c.path) return Promise.resolve({ result: 'failed', detail: `${this.name} is not installed.` });
    this.updating = (async () => {
      this.doing = 'updating';
      this.#emit();
      let r;
      try { r = await this.updateFn({ path: c.path, env: c.env }); }
      catch (err) { r = { result: 'failed', detail: String(err?.message ?? err).slice(0, 300) }; }
      const at = this.now();
      // The installed version moved: by this run, or by Claude Code's own updater since we last looked.
      const seen = r.to ?? r.version ?? null;
      const moved = r.result === 'updated' || (!!seen && seen !== versionText(c.version));
      if (moved) { try { await this.refreshVersion?.(); } catch { /* the next check reads it again */ } }
      if (r.result === 'updated') this.state.lastUpdate = { at, from: r.from, to: r.to };
      this.state.lastCheck = { at, result: r.result, version: r.to ?? r.version ?? versionText(c.version), detail: r.detail ?? null, reason };
      this.logFn(`${this.command} update (${reason}): ${r.result}${r.from ? ` ${r.from} -> ${r.to}` : ''}${r.detail ? ` · ${r.detail}` : ''}`);
      this.doing = null;
      this.#save();
      this.#emit(r.result === 'updated' ? { kind: reason === 'repair' ? 'repaired' : 'updated', from: r.from, to: r.to } : null);
      if (moved) await this.ensureModels({ force: r.result === 'updated' }).catch(() => {});
      return r;
    })().finally(() => { this.updating = null; });
    return this.updating;
  }

  /**
   * A chat could not start because Claude Code is too old: update it now. At most once every 10 minutes,
   * so a Claude Code that stays too old after updating can never loop.
   */
  repair() {
    if (this.updating) return this.updating;
    if (this.now() - this.lastRepairAt < 10 * MINUTE) return Promise.resolve({ result: 'off', detail: 'Already tried updating a moment ago.' });
    this.lastRepairAt = this.now();
    return this.update({ force: true, reason: 'repair' });
  }

  // ---- models ----

  /** Work out the model fixups for the installed Claude Code. Once per version unless forced. */
  ensureModels({ force = false } = {}) {
    // A forced check (a new version) waits for the probe in flight, then probes again if that one was for an older version.
    if (this.probing) return force ? this.probing.then(() => this.ensureModels()) : this.probing;
    const c = this.#claude();
    const version = versionText(c.version);
    if (!this.probeFn || !c.path) return Promise.resolve(this.state.models);
    if (!force && version && this.state.models?.cliVersion === version) return Promise.resolve(this.state.models);
    this.probing = (async () => {
      this.doing ??= 'checking-models';
      try {
        const r = await this.probeFn({ path: c.path, env: c.env });
        const fixups = modelFixups(r.models, r.resolved);
        this.state.models = { cliVersion: r.cliVersion ?? version, fixups, at: this.now() };
        this.logFn(`models for ${this.state.models.cliVersion}: ${fixups.length ? fixups.map((f) => `${f.from} -> ${f.to.value} (${f.is})`).join(', ') : 'picker is current'}`);
        this.#save();
      } catch (err) {
        this.logFn(`model check failed: ${String(err?.message ?? err).slice(0, 300)}`); // keep what we had
      } finally {
        if (this.doing === 'checking-models') this.doing = null;
        this.#emit();
      }
      return this.state.models;
    })().finally(() => { this.probing = null; });
    return this.probing;
  }

  // ---- drift ----

  /**
   * Claude Code sent a frame Canopy does not know. Remembered once per label and Claude Code version
   * (with its top-level keys, never its content). Returns true the first time.
   * `quiet`: listed like the rest, but the window is not told to announce it. For what Canopy noticed about
   * Claude Code's files rather than something a chat was sent.
   */
  recordDrift(label, keys = [], { quiet = false } = {}) {
    if (typeof label !== 'string' || !label) return false;
    const version = versionText(this.#claude().version);
    const hit = this.state.drift.find((d) => d.label === label && d.version === version);
    if (hit) { hit.count = (hit.count ?? 1) + 1; hit.lastAt = this.now(); return false; } // counted in memory: saved with the next change
    const k = Array.isArray(keys) ? keys.filter((x) => typeof x === 'string').slice(0, 24) : [];
    this.state.drift = [...this.state.drift, { label: label.slice(0, 120), keys: k, version, at: this.now(), count: 1 }].slice(-DRIFT_MAX);
    this.logFn(`drift: ${this.name} ${version ?? '?'} sent "${label}" (keys: ${k.join(', ') || 'none'}), which Canopy skips`);
    this.#save();
    this.#emit(quiet === true ? null : { kind: 'drift', label });
    return true;
  }

  clearDrift() {
    this.state.drift = [];
    this.#save();
    this.#emit();
  }

  // ---- internals ----

  #claude() {
    try { const c = this.claude?.() ?? {}; return { path: c.path ?? null, env: c.env ?? null, version: c.version ?? null }; }
    catch { return { path: null, env: null, version: null }; }
  }

  #blockedBy(c) {
    if (this.blockedFn) {
      try { const why = this.blockedFn(c); return typeof why === 'string' && why ? why : null; } catch { return null; }
    }
    const hit = OPT_OUTS.find((k) => truthy(c.env?.[k]));
    return hit ? `${hit} is set in your environment or Claude Code settings.` : null;
  }

  #schedule(ms) {
    if (this.stopped || !this.scheduled) return;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(async () => {
      this.timer = null;
      const r = await this.update({ reason: 'scheduled' }).catch(() => null);
      if (r?.result !== 'deferred') this.#schedule(this.everyMs); // a deferred run already set its own retry
    }, Math.max(0, ms));
  }

  #save() {
    try { this.saveFn({ ...this.state, drift: this.state.drift.map((d) => ({ ...d })) }); } catch { /* the next change saves again */ }
  }

  #emit(note = null) {
    try { this.onChange(this.status(), note); } catch { /* observers never break upkeep */ }
  }
}

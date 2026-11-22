// Accounts: which login each engine's chats are launched with.
//
// An account is a launch recipe, never a login Canopy holds. The tool (Claude Code, Codex) keeps its own sign-in;
// Canopy remembers what the tool said about it (who, which plan) and which account you chose. Nothing chosen
// (`active` null) means "as the tool finds it", which is exactly how Canopy launched it before accounts existed.
//
//   Accounts            the registry: the list, the choice per engine, and `envFor`, the one builder every launch uses
//                       (`launchFor` is the same launch with what the tool is told on its command line beside it)
//   refuse(code, text)  the coded error `envFor` throws: a chat is never launched on a fallback login
//
// Besides the logins a tool holds, the list has the accounts added in Canopy (a pasted API key, a second sign-in
// kept in a folder of its own): `add`, `rename`, `rekeyed`, `note`, `remove`. A key's secret is never here: the
// host keeps it, and hands it over at launch (`keyFor`). A folder is only named here; what is in it is the host's
// to look after (src/account-folders.mjs).
//
// What an engine knows (how to ask its tool, how to build a launch environment) lives in its own file:
// accounts-claude.mjs and accounts-codex.mjs. Each hands the registry:
//
//   ids                 the accounts it finds by asking the tool (Canopy did not add them and never removes them)
//   base()              the environment the tool is launched with when nothing is chosen, or null if not known yet
//   detect(hint)        ask the tool: { known: false } when it could not say, else { known: true, accounts: [...] }
//   verify(account)     ask about one account Canopy added: { state, why?, ...who } (optional)
//   launchEnv(account, base, { key })   the recipe; throws `refuse(...)` when the account cannot be launched
//   launchConfig(account)   settings the tool is launched with for the account, beside its environment (optional:
//                       Codex's `-c` flags for a pasted key; a secret is never among them)
//   provider(account)   what a chat launched for the account must report it runs on, or null (optional)
//   home(account)       the folder a process launched for the account must report it keeps its login in, or null
//                       (optional: a second Codex login's own folder)
//   choice(id)          the id to keep when an account is chosen: null for one that is "as the tool finds it" (optional)
//   asFound(list)       the id of the account the tool uses when nothing is chosen
//   label(account)      what to call an account the user has not named
//   agrees(account, reported)   does the account a chat's process reported match? true, false, or null (cannot tell)
//
// The registry holds no secrets and opens no files. It is saved by the host (state.json's `accounts`), and only
// the fields listed in `entryFrom` are ever written or read back.
//
// Contract: nothing here throws except `envFor` and `launchFor`, which throw on purpose. Async methods resolve,
// never reject.
import path from 'node:path';

export const ENGINES = Object.freeze(['claude', 'codex']);
export const KINDS = Object.freeze(['plan', 'console', 'key', 'external']);
// What can be said about an account. The window shows three things: fine, needs attention, checking.
export const STATES = Object.freeze(['ok', 'checking', 'unknown', 'signed-out', 'expired', 'mismatch', 'missing', 'locked', 'invalid-key', 'blocked']);

// States in which an account must not be launched: the chat would run signed out, or on a different login.
// `unknown` is not one of them: "could not check" is never treated as signed out.
const UNUSABLE = {
  'signed-out': (name) => `${name} is signed out.`,
  expired: (name) => `${name} is signed out.`,
  mismatch: (name) => `${name} is using a different login.`,
  missing: (name) => `The folder for ${name} is missing.`,
  locked: (name) => `The key for ${name} could not be read from the Keychain.`,
  'invalid-key': (name) => `The key for ${name} no longer works.`,
  blocked: (name, why) => `${name} can’t be used: ${why ?? 'your settings choose the login'}.`,
};

const OK_EVERY_MS = 10 * 60_000;   // how often a matching chat start is worth writing down
const NUDGE_EVERY_MS = 60_000;     // how often a surprising chat start may make Canopy ask the tool again

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const str = (v, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
const isAbs = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);

/**
 * The error `envFor` throws. `canopy` is the shape Session reports a failed start with (see session.mjs), so the
 * chat says why it did not start and hands your message back.
 */
export function refuse(code, message, extra) {
  return Object.assign(new Error(message), { code, canopy: { code, message, recoverable: false, ...extra } });
}

// One saved account, field by field. Anything not listed here is dropped, on the way in and on the way out: a
// secret cannot ride along in state.json even by mistake. `keyHint` is at most a key's last four characters.
function entryFrom(raw) {
  if (!isPlain(raw) || !str(raw.id, 80) || !ENGINES.includes(raw.engine) || !KINDS.includes(raw.kind)) return null;
  return {
    id: raw.id.slice(0, 80), engine: raw.engine, kind: raw.kind,
    dir: isAbs(raw.dir) ? raw.dir : null,          // null: the tool's own folder, which Canopy never touches
    label: str(raw.label, 80),                      // null: named after what it is (see the engine's `label`)
    email: str(raw.email), org: str(raw.org), orgId: str(raw.orgId, 80), plan: str(raw.plan, 40),
    via: str(raw.via, 40),                          // an `external` account: what in the environment supplies the login
    keyHint: typeof raw.keyHint === 'string' && /^[\w-]{1,4}$/.test(raw.keyHint) ? raw.keyHint : null,
    addedAt: num(raw.addedAt), lastOkAt: num(raw.lastOkAt),
    state: STATES.includes(raw.state) && raw.state !== 'checking' ? raw.state : 'unknown',
    why: str(raw.why),
  };
}

export class Accounts {
  /**
   * @param {{
   *   engines: Record<string, object>,            what each engine knows (see the top of this file)
   *   load?: () => object | null | undefined,     the saved registry (state.json's `accounts`)
   *   save?: (state: object) => unknown,          save it
   *   keyFor?: (account: object) => string | null,   a pasted key's secret, from wherever the host keeps it
   *   onChange?: (view: object) => void,          the list or a choice changed
   *   log?: (msg: string) => void, now?: () => number,
   * }} deps
   */
  constructor({ engines, load, save, keyFor, onChange, log, now } = {}) {
    this.engines = {};
    for (const e of ENGINES) if (isPlain(engines?.[e])) this.engines[e] = engines[e];
    this.loadFn = typeof load === 'function' ? load : () => null;
    this.saveFn = typeof save === 'function' ? save : () => {};
    this.keyFor = typeof keyFor === 'function' ? keyFor : null;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.logFn = typeof log === 'function' ? log : () => {};
    this.now = typeof now === 'function' ? now : Date.now;

    this.loaded = null;        // { v, active, list }, read from the host on first use (see `state`)
    this.queue = Promise.resolve();
    this.checking = 0;
    this.checkedAt = 0;
    this.unsure = new Set();   // engines whose tool could not answer the last time it was asked
    this.nudgedAt = 0;
    this.lastView = null;
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a call */ } }

  // The saved registry, read once, on first use. What cannot be read starts as nothing chosen and nothing known.
  get state() {
    if (this.loaded) return this.loaded;
    let saved = null;
    try { saved = this.loadFn(); } catch { /* unreadable */ }
    const s = isPlain(saved) ? saved : {};
    const seen = new Set();
    const list = (Array.isArray(s.list) ? s.list : []).map(entryFrom).filter((a) => a && !seen.has(a.id) && seen.add(a.id));
    // A choice is kept even when its account is not in the list: `envFor` then refuses, rather than quietly
    // launching on whatever login the tool finds.
    const active = {};
    for (const e of ENGINES) active[e] = str(s.active?.[e], 80);
    this.loaded = { v: 1, active, list };
    return this.loaded;
  }

  // ---- what the window shows ----

  /**
   * The list and the choices, without what the window has no use for (folders, organisation ids, when it was last
   * checked). `active`: what you chose. `own`: the login the tool finds on its own, whatever is chosen (what a chat
   * started with nothing chosen runs on). `inUse`: the one new chats really start on, which is `active`, else `own`.
   */
  view() {
    const active = {}, inUse = {}, own = {};
    for (const e of ENGINES) {
      active[e] = this.state.active[e] ?? null;
      own[e] = this.#asFound(e);
      inUse[e] = active[e] ?? own[e];
    }
    return {
      active, inUse, own, checking: this.checking > 0,
      list: this.state.list.map((a) => ({
        id: a.id, engine: a.engine, kind: a.kind, label: this.#name(a), email: a.email, org: a.org, plan: a.plan,
        via: a.via, keyHint: a.keyHint, state: a.state, why: a.why,
        found: this.engines[a.engine]?.ids?.includes(a.id) === true, // Canopy found it by asking the tool, and did not add it
      })),
    };
  }

  /** The account an engine's new chats start on: the chosen one's id, or null for "as the tool finds it". */
  pin(engine) { return this.state.active[engine] ?? null; }

  /**
   * The account a chat is really on: the one it was started on (what `pin` gave it), or, for a chat started with
   * nothing chosen, the one the tool finds on its own. Null when that is not known yet.
   */
  resolve(engine, id) { return typeof id === 'string' && id ? id : this.#asFound(engine); }

  /**
   * Which account a chat is on, given the id it was started with (see `pin`; null: the one the tool finds):
   * its real id, its name and its kind, or null when Canopy does not know it.
   * @returns {{id: string, label: string, kind: string} | null}
   */
  named(engine, account) {
    const a = this.#find(engine, account ?? this.#asFound(engine));
    return a ? { id: a.id, label: this.#name(a), kind: a.kind } : null;
  }

  /**
   * One account as the registry holds it, folder and all (a copy), or null. `id` null: the one the tool finds on
   * its own. For the host, which launches things; the window gets `view()`.
   */
  get(engine, id = null) {
    const a = this.#find(engine, id ?? this.#asFound(engine));
    return a ? { ...a } : null;
  }

  /** Every saved field of an engine's accounts, folder included (copies). For the host; the window gets `view`. */
  entries(engine) { return this.state.list.filter((a) => a.engine === engine).map((a) => ({ ...a })); }

  // ---- launching ----

  /**
   * The environment to launch an engine's tool with. The only place a launch environment is built.
   * `account`: an id, null for "as the tool finds it", or left out for the account in use now. A chat passes the
   * one it was started on (see `pin`), so an open chat never moves to another account.
   * `base`: the environment to start from, when the caller has its own (default: the engine's).
   * With nothing chosen the result equals the base, key for key.
   * @throws a `refuse` error when the account cannot be used. Never falls back to another login.
   */
  envFor(engine, { account, base } = {}) {
    const eng = this.engines[engine];
    if (!eng) throw refuse('unknown-engine', `Canopy has no accounts for "${String(engine)}".`);
    let env = base;
    if (env === undefined || env === null) { try { env = eng.base(); } catch { env = null; } }
    if (!isPlain(env)) throw refuse('no-env', 'Canopy has not finished checking your setup yet.', { recoverable: true });
    const id = account === undefined ? this.state.active[engine] : account;
    if (id === null || id === undefined) return eng.launchEnv(null, env);
    const a = this.#find(engine, id);
    if (!a) throw refuse('account-missing', 'The account this chat uses is no longer in Canopy.');
    const name = this.#name(a);
    if (UNUSABLE[a.state]) throw refuse(`account-${a.state}`, UNUSABLE[a.state](name, a.why), { account: a.id });
    let key = null;
    if (a.kind === 'key' && this.keyFor) { try { key = this.keyFor({ ...a }); } catch { key = null; } }
    return eng.launchEnv({ ...a }, env, { key, name });
  }

  /**
   * A whole launch: `envFor`'s environment, and beside it what the engine's tool is told on its command line for
   * that account. Takes what `envFor` takes, and refuses what it refuses.
   *   env        the environment, exactly as `envFor` gives it
   *   config     settings for this one process ({} for every account but a pasted Codex key: see accounts-codex.mjs).
   *              Never a secret: a key travels in the environment only.
   *   provider   what a chat launched this way must report it runs on (null: nothing to hold it to)
   *   home       the folder a process launched this way must report it keeps its login in. Only there for an
   *              account kept in a folder of its own.
   * With nothing chosen: the base, no settings, no provider, and no folder.
   * @returns {{ env: Record<string, string>, config: Record<string, unknown>, provider: string | null, home?: string }}
   * @throws a `refuse` error when the account cannot be used. Never falls back to another login.
   */
  launchFor(engine, { account, base } = {}) {
    const env = this.envFor(engine, { account, base });
    const eng = this.engines[engine];
    const id = account === undefined ? this.state.active[engine] : account;
    const found = id === null || id === undefined ? null : this.#find(engine, id);
    const a = found ? { ...found } : null;
    const config = typeof eng.launchConfig === 'function' ? eng.launchConfig(a) : null;
    const provider = typeof eng.provider === 'function' ? eng.provider(a) : null;
    const home = typeof eng.home === 'function' ? eng.home(a) : null;
    return { env, config: isPlain(config) ? config : {}, provider: str(provider, 80), ...(isAbs(home) && { home }) };
  }

  /**
   * Choose the account an engine's new chats use (null: as the tool finds it). Open chats keep theirs.
   * An account that is simply "as the tool finds it" (the login Codex holds) is kept as nothing chosen.
   * @returns {{ok: boolean, code?: string, message?: string}}
   */
  setActive(engine, id) {
    const eng = this.engines[engine];
    if (!eng) return { ok: false, code: 'unknown-engine', message: `Canopy has no accounts for "${String(engine)}".` };
    if (id !== null && !this.#find(engine, id)) return { ok: false, code: 'account-missing', message: 'That account is not in Canopy.' };
    if (id !== null && typeof eng.choice === 'function') { try { id = eng.choice(id) ?? null; } catch { /* kept as it was asked for */ } }
    if (this.state.active[engine] !== id) {
      this.state.active[engine] = id;
      this.log(`${engine}: new chats use ${id ?? 'the login the tool finds'}`);
      this.#save(); this.#emit();
    }
    return { ok: true };
  }

  // ---- accounts added in Canopy ----

  /**
   * Add an account Canopy keeps itself: a pasted API key (its secret stays with the host, see `keyFor`), or a
   * sign-in in a folder of its own (src/account-folders.mjs).
   * `account`: { id, engine, kind, label?, keyHint?, dir?, state? }. Refused when the id is taken, or is one of
   * the ids the engine uses for the tool's own logins. Adding never changes which account is in use.
   * `state`: 'ok' when it was just checked. A sign-in may also be added 'signed-out': it is listed from the moment
   * its folder exists, before anyone has signed in to it. Anything else is "not known yet".
   * @returns {{ok: true, id: string} | {ok: false, code: string, message: string}}
   */
  add(account) {
    const eng = this.engines[account?.engine];
    if (!eng) return { ok: false, code: 'unknown-engine', message: `Canopy has no accounts for "${String(account?.engine)}".` };
    const state = account.state === 'ok' ? 'ok' : account.state === 'signed-out' && account.kind !== 'key' ? 'signed-out' : 'unknown';
    const made = entryFrom({ ...account, addedAt: this.now(), lastOkAt: state === 'ok' ? this.now() : null, state, why: null });
    // A key has its last four characters and no folder. Anything else needs a folder of its own: without one it
    // would be the tool's own login under a second name.
    const whole = made && (made.kind === 'key' ? !!made.keyHint && !made.dir : made.kind !== 'external' && !!made.dir);
    if (!whole || eng.ids?.includes(made.id) || this.state.list.some((a) => a.id === made.id)) return { ok: false, code: 'invalid-account', message: 'That account could not be added.' };
    this.state.list.push(made);
    this.log(`${made.engine}: added ${made.id} (${made.kind})`);
    this.#save(); this.#emit();
    return { ok: true, id: made.id };
  }

  /**
   * Name an account. An empty name, or the name it has by itself, puts that name back.
   * @returns {{ok: boolean, code?: string, message?: string}}
   */
  rename(engine, id, label) {
    const a = this.#find(engine, id);
    if (!a) return { ok: false, code: 'account-missing', message: 'That account is not in Canopy.' };
    let next = typeof label === 'string' ? str(label.replace(/\s+/g, ' ').trim(), 80) : null;
    if (next && next === this.#name({ ...a, label: null })) next = null;
    if (a.label !== next) { a.label = next; this.#save(); this.#emit(); }
    return { ok: true };
  }

  /** A pasted key was replaced by one that works: its new last four characters, and the account is fine again. */
  rekeyed(engine, id, keyHint) {
    const a = this.#find(engine, id);
    if (!a || a.kind !== 'key') return { ok: false, code: 'account-missing', message: 'That account is not in Canopy.' };
    const i = this.state.list.indexOf(a);
    const next = entryFrom({ ...a, keyHint, state: 'ok', why: null, lastOkAt: this.now() });
    if (!next?.keyHint) return { ok: false, code: 'invalid-account', message: 'That account could not be changed.' };
    this.state.list[i] = next;
    this.log(`${engine}: ${id} has a new key`);
    this.#save(); this.#emit();
    return { ok: true };
  }

  /**
   * Remove an account that was added in Canopy. A login the tool itself holds is never removed here (signing out
   * is the tool's to do). If it was the chosen one, new chats go back to the login the tool finds; a chat still
   * open on it refuses its next start (see `envFor`).
   * @returns {{ok: true, wasActive: boolean} | {ok: false, code: string, message: string}}
   */
  remove(engine, id) {
    const a = this.#find(engine, id);
    if (!a) return { ok: false, code: 'account-missing', message: 'That account is not in Canopy.' };
    if (this.engines[engine]?.ids?.includes(a.id)) return { ok: false, code: 'not-removable', message: 'Canopy didn’t add that login, so it can’t remove it.' };
    this.state.list = this.state.list.filter((x) => x !== a);
    const wasActive = this.state.active[engine] === a.id;
    if (wasActive) this.state.active[engine] = null;
    this.log(`${engine}: removed ${a.id}${wasActive ? '; new chats use the login the tool finds' : ''}`);
    this.#save(); this.#emit();
    return { ok: true, wasActive };
  }

  // ---- finding out ----

  /**
   * Ask every engine's tool what logins it has, and fold the answers into the list. One run at a time.
   * `auth`: answers the caller already has, by engine, so the tool is not asked twice.
   * `maxAgeMs`: skip the asking when everything was checked that recently.
   * @returns {Promise<object>} the view afterwards
   */
  refresh({ auth, maxAgeMs } = {}) {
    const run = async () => {
      try {
        const fresh = maxAgeMs > 0 && this.checkedAt && this.now() - this.checkedAt < maxAgeMs && !this.unsure.size;
        if (fresh) return this.view();
        this.checking += 1;
        this.#emit();
        try {
          await Promise.all(Object.keys(this.engines).map((engine) => this.#ask(engine, auth?.[engine])));
          this.checkedAt = this.now();
        } finally { this.checking -= 1; }
        this.#save(); this.#emit();
      } catch (err) { this.log(`refresh failed: ${err?.message ?? err}`); }
      return this.view();
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async #ask(engine, hint) {
    const eng = this.engines[engine];
    let found = null;
    try { found = await eng.detect({ auth: hint }); } catch (err) { this.log(`${engine}: could not ask (${err?.message ?? err})`); }
    if (found?.known === true) { this.unsure.delete(engine); this.#fold(engine, Array.isArray(found.accounts) ? found.accounts : []); }
    else this.unsure.add(engine);
    // Accounts added in Canopy are asked about one by one.
    if (typeof eng.verify !== 'function') return;
    for (const a of this.state.list.filter((x) => x.engine === engine && !eng.ids.includes(x.id))) {
      let r = null;
      try { r = await eng.verify({ ...a }); } catch (err) { this.log(`${engine}: could not check ${a.id} (${err?.message ?? err})`); }
      if (isPlain(r) && r.state && r.state !== 'unknown') this.#put(a.id, r);
    }
  }

  // What the tool said about the accounts it holds itself. An account it no longer has leaves the list, unless it
  // is the chosen one: that one stays, signed out, so its chats refuse to start instead of moving to another login.
  #fold(engine, answers) {
    const eng = this.engines[engine];
    for (const id of eng.ids) {
      const f = answers.find((x) => isPlain(x) && x.id === id);
      const old = this.#find(engine, id);
      if (!f) {
        if (!old) continue;
        if (this.state.active[engine] === id) this.#put(id, { state: 'signed-out' });
        else { this.state.list = this.state.list.filter((a) => a !== old); this.log(`${engine}: ${id} is gone`); }
      } else if (f.state === 'ok') {
        if (old) this.#put(id, f);
        else {
          const made = entryFrom({ ...f, id, engine, dir: null, label: null, keyHint: null, addedAt: this.now(), lastOkAt: this.now(), state: 'ok', why: null });
          if (made) { this.state.list.push(made); this.log(`${engine}: found ${id} (${made.kind})`); }
        }
      } else if (old && f.state && f.state !== 'unknown') this.#put(id, { state: f.state, why: f.why });
      // `unknown`, or signed out with nothing known before: nothing to add and nothing to change.
    }
  }

  // Update one account from an answer about it. Who it is only changes with an `ok` answer; anything else only
  // changes how it is doing.
  #put(id, r) {
    const i = this.state.list.findIndex((a) => a.id === id);
    if (i < 0 || !STATES.includes(r.state)) return;
    const old = this.state.list[i];
    const who = r.state === 'ok'
      ? { kind: r.kind ?? old.kind, via: r.via ?? null, email: r.email ?? null, org: r.org ?? null, orgId: r.orgId ?? null, plan: r.plan ?? null, lastOkAt: this.now() }
      : {};
    const next = entryFrom({ ...old, ...who, state: r.state, why: r.state === 'ok' ? null : r.why ?? null });
    if (!next) return;
    if (old.state !== next.state) this.log(`${old.engine}: ${id} is ${next.state}`);
    this.state.list[i] = next;
  }

  /**
   * Take an answer about one account into the list: what an engine's `verify` returns. "Could not check" changes
   * nothing, as everywhere else. For the host that looks after accounts kept in folders (src/account-folders.mjs).
   */
  note(id, answer) {
    if (!isPlain(answer) || !STATES.includes(answer.state) || answer.state === 'unknown' || answer.state === 'checking') return;
    this.#put(id, answer);
    this.#save(); this.#emit();
  }

  /**
   * A chat's process said which account it started on. `id` is the account the chat was meant to use (null:
   * whatever the tool finds). A chosen account that reports a different login is marked; with nothing chosen
   * the report simply is the truth, so a surprise only means the tool is asked again.
   */
  reported(engine, id, info) {
    try {
      const eng = this.engines[engine];
      if (!eng || !isPlain(info)) return;
      const a = this.#find(engine, id ?? this.#asFound(engine));
      let says = null;
      try { says = a ? eng.agrees({ ...a }, info) : null; } catch { says = null; }
      if (a && says === true) {
        if (a.state === 'ok' && a.lastOkAt && this.now() - a.lastOkAt < OK_EVERY_MS) return;
        this.#put(a.id, { ...a, state: 'ok' });
        this.#save(); this.#emit();
      } else if (id === null || id === undefined) {
        if ((!a || says === false) && this.now() - this.nudgedAt >= NUDGE_EVERY_MS) { this.nudgedAt = this.now(); this.refresh(); }
      } else if (a && says === false && a.state !== 'mismatch') {
        this.#put(a.id, { state: 'mismatch' });
        this.#save(); this.#emit();
      }
    } catch (err) { this.log(`${engine}: could not use a reported account (${err?.message ?? err})`); }
  }

  // ---- internals ----

  #find(engine, id) { return typeof id === 'string' ? this.state.list.find((a) => a.engine === engine && a.id === id) ?? null : null; }

  #asFound(engine) {
    try { return this.engines[engine]?.asFound(this.state.list.filter((a) => a.engine === engine)) ?? null; } catch { return null; }
  }

  #name(a) {
    if (a.label) return a.label;
    try { return str(this.engines[a.engine]?.label({ ...a }), 80) ?? 'Account'; } catch { return 'Account'; }
  }

  #save() {
    try {
      const out = { v: 1, active: { ...this.state.active }, list: this.state.list.map(entryFrom).filter(Boolean) };
      Promise.resolve(this.saveFn(out)).catch((err) => this.log(`save failed: ${err?.message ?? err}`));
    } catch (err) { this.log(`save failed: ${err?.message ?? err}`); }
  }

  // The window hears about a change once, not about every check that found nothing new.
  #emit() {
    try {
      const view = this.view();
      const json = JSON.stringify(view);
      if (json === this.lastView) return;
      this.lastView = json;
      this.onChange(view);
    } catch { /* an observer never breaks the registry */ }
  }
}

// Accounts, the part that changes things: choosing the account new chats use, and the API keys pasted into Canopy
// (add, replace, check, remove), with renaming beside them. The registry (src/core/accounts.mjs) keeps what is
// known about an account, the vault (src/secrets.mjs) keeps a key's secret, and this file is the only place the
// two meet.
//
// A key is seen here at three moments and nowhere else in Canopy: when it is pasted (it comes from the window
// once, and no reply carries it back), when it is checked with its maker, and when a chat on its account is
// launched (`keyFor`, in the registry). No reply, event, log line or saved state holds it: a reply is `{ ok }` or
// a coded reason, and the registry keeps a key's last four characters.
//
//   accountActions(deps)             use / addKey / replaceKey / rename / remove / verifyKey / keyInDoubt
//   registerAccountActions(handle, deps)   the same, with the window's five calls
//   recheckModels(upkeep)            the model check, again, after the account in use changed
//   moveUnusedChats(sessions, account, engine)   a switch reaches the chats nobody has used yet, and only those
//   restartChatsOn(sessions, account, engine)    a replaced key reaches the chats on its account
//   chatAccountLine(deps)            what a chat says about its account when it starts: "This chat uses Max."
//
// An Anthropic key is an account for Claude's chats, an OpenAI key one for Codex's, each checked with its own
// maker. Neither is ever made a login of the tool's: a Codex key rides in its own process's environment (see
// core/accounts-codex.mjs), and nothing is written into Codex's folder. Nothing here signs anyone in or out of
// anything.
import { randomUUID } from 'node:crypto';
import { checkKey, keyShape } from './core/account-keys.mjs';
import { ENGINES } from './core/accounts.mjs';
import { redact } from './core/redact.mjs';

const fail = (code, message) => ({ ok: false, code, message });
/** Which engine runs a chat: a Codex session says so, a Claude one says nothing (as src/chats.mjs reads it). */
const engineOf = (session) => (session?.engine === 'codex' ? 'codex' : 'claude');
const NOT_HERE = () => fail('account-missing', 'That account is not in Canopy.');
const NO_KEYCHAIN = () => fail('no-keychain', 'Canopy can’t keep a key safely right now: the Keychain isn’t available.');
const NOT_KEPT = () => fail('not-kept', 'Canopy couldn’t save the key on this Mac. Nothing was changed.');

// A key that checked out is not sent to its maker again within this long, however often the accounts are re-read.
const CHECKED_FOR_MS = 5 * 60_000;
// What the key check itself can say about an account, and so may also take back.
const OWN_STATES = ['ok', 'unknown', 'invalid-key', 'locked', 'blocked'];
const OUTRANKED = 'your Claude Code settings choose the login';
// The check that runs with the accounts gives up sooner than a paste does: offline, it should not hold the list up.
const RECHECK_TIMEOUT_MS = 8_000;

/**
 * @param {{
 *   accounts: import('./core/accounts.mjs').Accounts,
 *   secrets: import('./secrets.mjs').Secrets,
 *   fetch?: typeof fetch,                            how a key is checked with its maker (the test seam)
 *   outranked?: (engine: string) => boolean,         the tool's own settings choose its login, over any launch
 *   onSwitch?: (engine: string) => void,             the account an engine's new chats use changed
 *   onRekeyed?: (engine: string, id: string) => void,   an account's key was replaced
 *   log?: (msg: string) => void, now?: () => number, newId?: () => string, recheckTimeoutMs?: number,
 * }} deps
 */
export function accountActions({ accounts, secrets, fetch, outranked, onSwitch, onRekeyed, log, now = Date.now, newId = () => randomUUID().slice(0, 8), recheckTimeoutMs = RECHECK_TIMEOUT_MS } = {}) {
  const checkedAt = new Map();   // account id -> when its key last checked out
  let doubting = null;           // the asking that `keyInDoubt` started, while it runs
  let doubtAgain = false;        // and whether it has to run once more
  // Do the tool's own settings choose its login (a key, a proxy or a cloud switch in their `env`)? Then a pasted
  // key would not be what its chats run on, whatever the launch says. Not knowing counts as no.
  const isOutranked = (engine) => { try { return outranked?.(engine) === true; } catch { return false; } };

  // The log is told what happened to which account (by id), never with what: pasted text is cut out of anything
  // on its way there, and so is whatever looks like a key.
  const say = (msg, pasted) => {
    try {
      let text = String(msg);
      if (typeof pasted === 'string' && pasted.trim().length >= 4) text = text.split(pasted).join('[redacted]').split(pasted.trim()).join('[redacted]');
      log?.(redact(text));
    } catch { /* logging never breaks a call */ }
  };
  const tell = (fn, ...args) => { try { fn?.(...args); } catch (err) { say(`a listener failed: ${err?.message ?? err}`); } };
  // Every call answers, whatever goes wrong inside it: a failure is a coded reply, and what reaches the log has the
  // pasted text cut out. Between two waits a call runs in one go, so each looks again after waiting for the maker.
  const answered = async (what, pasted, fn) => {
    try { return await fn(); }
    catch (err) { say(`${what} failed: ${err?.message ?? err}`, pasted); return fail('failed', 'That didn’t work. Try again.'); }
  };

  // The window names the engine: only the two there are get as far as the registry.
  const rows = (engine) => (ENGINES.includes(engine) ? accounts.view().list.filter((a) => a.engine === engine) : []);
  const keyRow = (engine, id) => (typeof id === 'string' ? rows(engine).find((a) => a.id === id && a.kind === 'key' && !a.found) ?? null : null);
  const keyIds = () => accounts.view().list.filter((a) => a.kind === 'key' && !a.found).map((a) => a.id);
  // Is this very key an account already? Held next to each kept key here, in memory, and nowhere else.
  const holderOf = (engine, key, except) => rows(engine).find((a) => a.kind === 'key' && a.id !== except && secrets.get(a.id) === key) ?? null;
  const ALREADY = (row) => fail('duplicate', `That key is already in Canopy, as ${row.label}.`);
  // An id nothing is kept under yet: a key is never written over another account's.
  const freshId = (engine) => {
    for (let i = 0; i < 8; i += 1) {
      const tail = String(newId()).replace(/[^\w-]/g, '').slice(0, 24);
      const id = `${engine}-key-${tail}`;
      if (tail && !secrets.has(id) && !accounts.view().list.some((a) => a.id === id)) return id;
    }
    return null;
  };

  /**
   * Choose the account an engine's new chats use (null: the login the tool finds). Open chats keep theirs. An
   * account that could not start a chat (signed out, its key unreadable or refused) is not switched to.
   * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
   */
  function use(engine, id) {
    return answered('use', null, () => {
      if (!ENGINES.includes(engine) || (id !== null && !rows(engine).some((a) => a.id === id))) return NOT_HERE();
      const before = accounts.pin(engine);
      if (id !== null) {
        const key = keyRow(engine, id);
        if (key && isOutranked(engine)) return fail('account-blocked', `${key.label} can’t be used: ${OUTRANKED}.`);
        try { accounts.envFor(engine, { account: id }); }
        catch (err) {
          // Not knowing the environment yet says nothing about the account: the choice is still recorded.
          if (err?.code !== 'no-env') return fail(err?.canopy?.code ?? 'account-unusable', err?.canopy?.message ?? 'That account can’t be used right now.');
        }
      }
      const r = accounts.setActive(engine, id);
      if (r.ok && accounts.pin(engine) !== before) tell(onSwitch, engine);
      return r;
    });
  }

  /**
   * Add a pasted API key as an account: its shape, then its maker's word that it works, then the vault, then the
   * list. Refused at the first of those that fails, with nothing kept. Adding does not switch to it.
   * @returns {Promise<{ok: true, id: string} | {ok: false, code: string, message: string}>}
   */
  function addKey(engine, text) {
    return answered('add-key', text, async () => {
      const shape = keyShape(engine, text);
      if (!shape.ok) return shape;
      // Nothing is asked of a maker, and nothing kept, for an engine this registry has no accounts for.
      if (!accounts.engines?.[engine]) return fail('unsupported', 'Canopy doesn’t take API keys for that yet.');
      let same = holderOf(engine, shape.key, null);
      if (same) return ALREADY(same);
      if (!secrets.available()) return NO_KEYCHAIN();
      const answer = await checkKey(shape.key, { engine, fetch });
      if (!answer.ok) return answer;
      same = holderOf(engine, shape.key, null);   // pasted twice: the other paste was added while this one waited
      if (same) return ALREADY(same);
      const id = freshId(engine);
      if (!id || !secrets.set(id, shape.key).ok) return NOT_KEPT();
      const added = accounts.add({ id, engine, kind: 'key', keyHint: shape.hint, state: 'ok' });
      if (!added.ok) { secrets.delete(id); return added; }
      checkedAt.set(id, now());
      secrets.keep(keyIds());   // and no key stays behind for an account that is gone
      if (isOutranked(engine)) accounts.refresh();   // the key is good, but would not be used: the list says so (see verifyKey)
      return { ok: true, id };
    });
  }

  /**
   * Replace an account's key with another that works. The old key stays until the new one is checked and kept.
   * @returns {Promise<{ok: true, id: string} | {ok: false, code: string, message: string}>}
   */
  function replaceKey(engine, id, text) {
    return answered('replace-key', text, async () => {
      if (!keyRow(engine, id)) return NOT_HERE();
      const shape = keyShape(engine, text);
      if (!shape.ok) return shape;
      let same = holderOf(engine, shape.key, id);
      if (same) return ALREADY(same);
      if (!secrets.available()) return NO_KEYCHAIN();
      const answer = await checkKey(shape.key, { engine, fetch });
      if (!answer.ok) return answer;
      if (!keyRow(engine, id)) return NOT_HERE();   // removed while its maker was being asked
      same = holderOf(engine, shape.key, id);
      if (same) return ALREADY(same);
      if (!secrets.set(id, shape.key).ok) return NOT_KEPT();
      const r = accounts.rekeyed(engine, id, shape.hint);
      if (!r.ok) return r;
      checkedAt.set(id, now());
      tell(onRekeyed, engine, id);
      if (isOutranked(engine)) accounts.refresh();   // as for a key just added
      return { ok: true, id };
    });
  }

  /** Name an account (empty: its own name again). @returns {Promise<{ok: boolean, code?: string, message?: string}>} */
  function rename(engine, id, label) {
    return answered('rename', null, () => (ENGINES.includes(engine) ? accounts.rename(engine, id, label) : NOT_HERE()));
  }

  /**
   * Remove a key account: the key is taken off this Mac first, then the account leaves the list. Only accounts
   * added here; a login the tool itself holds is never removed. If it was the one in use, new chats go back to
   * the login the tool finds.
   * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
   */
  function remove(engine, id) {
    return answered('remove', null, () => {
      const row = typeof id === 'string' ? rows(engine).find((a) => a.id === id) ?? null : null;
      if (!row) return NOT_HERE();
      if (row.found) return fail('not-removable', 'Canopy didn’t add that login, so it can’t remove it.');
      if (row.kind !== 'key') return fail('not-removable', 'That account can’t be removed here yet.');
      if (!secrets.delete(id)) return fail('not-removed', 'Canopy couldn’t take the key off this Mac. Nothing was changed.');
      checkedAt.delete(id);
      const r = accounts.remove(engine, id);
      if (!r.ok) return r;
      secrets.keep(keyIds());
      if (r.wasActive) tell(onSwitch, engine);
      return { ok: true };
    });
  }

  /**
   * How a key account is doing, for the registry's check of every account (each engine's `verify`).
   * `blocked`: the tool's own settings choose its login, so the key would not be used. `locked`: the key cannot
   * be read from the Keychain now. `invalid-key`: its maker refuses it. `unknown`: nothing new is known (no
   * answer, or it checked out a moment ago), so nothing changes. Never rejects.
   * @returns {Promise<{state: 'ok' | 'blocked' | 'locked' | 'invalid-key' | 'unknown', why?: string}>}
   */
  async function verifyKey(account) {
    try {
      const id = account?.id;
      if (isOutranked(account?.engine)) return { state: 'blocked', why: OUTRANKED };
      const kept = secrets.read(id);
      if (!kept.ok) { checkedAt.delete(id); return { state: 'locked' }; }
      const last = checkedAt.get(id);
      if (account.state === 'ok' && last !== undefined && now() - last < CHECKED_FOR_MS) return { state: 'unknown' };
      const answer = await checkKey(kept.secret, { engine: account.engine, fetch, timeoutMs: recheckTimeoutMs });
      // Replaced or removed while its maker was being asked: the answer is about a key that is no longer this account's.
      if (secrets.get(id) !== kept.secret) return { state: 'unknown' };
      // A working key says nothing about a problem this check cannot see (a chat that started on another login
      // than the key's): only what the check itself found, or nothing, is cleared by it.
      if (answer.ok) { checkedAt.set(id, now()); return { state: OWN_STATES.includes(account.state) ? 'ok' : 'unknown' }; }
      if (answer.code === 'rejected') { checkedAt.delete(id); return { state: 'invalid-key' }; }
      return { state: 'unknown' };
    } catch (err) { say(`key check failed: ${err?.message ?? err}`); return { state: 'unknown' }; }
  }

  /**
   * Something a chat saw says a key account is not as the list has it: its maker refused a turn on a key listed
   * as working, or a reply came back on one listed as refused. Neither changes anything by itself. The maker is
   * asked about the key now, whatever was known a moment ago, and the list follows that answer. One asking at a
   * time: a sign that arrives while one runs makes it run once more.
   * @returns {Promise<void>} once the list has caught up. Never rejects.
   */
  function keyInDoubt(engine, id) {
    if (!keyRow(engine, id)) return Promise.resolve();
    checkedAt.delete(id);
    if (doubting) { doubtAgain = true; return doubting; }
    const asking = async () => {
      do {
        doubtAgain = false;
        try { await accounts.refresh(); } catch (err) { say(`key check failed: ${err?.message ?? err}`); }
      } while (doubtAgain);
    };
    doubting = asking().finally(() => { doubting = null; });
    return doubting;
  }

  return { use, addKey, replaceKey, rename, remove, verifyKey, keyInDoubt };
}

/**
 * Wire the window's five calls. Each answers `{ ok: true, … }` or `{ ok: false, code, message }`; none answers
 * with a key, and the only call that receives one is the paste itself.
 * @param {(channel: string, fn: Function) => void} handle main's guarded `ipcMain.handle`
 * @param {Parameters<typeof accountActions>[0]} deps
 * @returns {ReturnType<typeof accountActions>}
 */
export function registerAccountActions(handle, deps) {
  const actions = accountActions(deps);
  handle('accounts:use', async (engine, id) => actions.use(engine, id ?? null));
  handle('accounts:add-key', async (engine, key) => actions.addKey(engine, key));
  handle('accounts:replace-key', async (engine, id, key) => actions.replaceKey(engine, id, key));
  handle('accounts:rename', async (engine, id, label) => actions.rename(engine, id, label));
  handle('accounts:remove', async (engine, id) => actions.remove(engine, id));
  return actions;
}

/**
 * Models and Fast can differ by account, so after the account in use changes the model check runs again, whatever
 * it found before. A check already running was asked on the account before: it is let finish, then asked again.
 * @param {{ probing?: Promise<unknown> | null, ensureModels(o: { force: boolean }): Promise<unknown> } | null | undefined} upkeep
 * @returns {Promise<unknown>} what the check found, or null. Never rejects.
 */
export function recheckModels(upkeep) {
  if (!upkeep || typeof upkeep.ensureModels !== 'function') return Promise.resolve(null);
  return Promise.resolve(upkeep.probing).catch(() => null).then(() => upkeep.ensureModels({ force: true })).catch(() => null);
}

/**
 * The account new chats use changed. A chat nobody has used yet is a new chat, so it starts on that account too
 * (Session.moveAccount decides; a chat with a conversation keeps the account it started on, always).
 * @param {Iterable<object>} sessions every open chat
 * @param {string | null} account where new chats start now (the registry's `pin`)
 * @param {'claude' | 'codex'} [engine] whose account changed: only that maker's chats are looked at
 * @returns {number} how many moved
 */
export function moveUnusedChats(sessions, account, engine = 'claude') {
  let moved = 0;
  for (const s of sessions ?? []) {
    try { if (engineOf(s) === engine && typeof s?.moveAccount === 'function' && s.moveAccount(account)) moved += 1; }
    catch { /* one chat's trouble is not another's */ }
  }
  return moved;
}

/**
 * An account's key was replaced. The chats on that account start their process again, at once when idle and
 * after the turn when working, so none goes on holding the key that was replaced. They stay on their account.
 * @param {Iterable<object>} sessions every open chat
 * @param {string} account the account whose key changed
 * @param {'claude' | 'codex'} [engine] whose account it is
 * @returns {number} how many were told
 */
export function restartChatsOn(sessions, account, engine = 'claude') {
  let told = 0;
  if (typeof account !== 'string' || !account) return told;
  for (const s of sessions ?? []) {
    if (engineOf(s) !== engine || s?.accountId !== account || typeof s?.recycle !== 'function') continue;
    told += 1;
    try { Promise.resolve(s.recycle('account')).catch(() => {}); } catch { /* one chat's trouble is not another's */ }
  }
  return told;
}

/**
 * What a chat says about its account when its first turn starts (Session's `accountNotice`): one quiet line,
 * "This chat uses Max.", when that is not the account the chat before it started on. So a switch is said once,
 * in the first chat that runs on the new account, and never again until the next switch.
 *
 * The very first chat has nothing to compare with: it says the line only when it is billed to a key or to
 * something in the environment, which is what the old "billed to an API key" line was for. When Canopy cannot
 * name the chat's login at all, that old line is said instead, once per run, from what Claude Code reported.
 * A Codex chat's first of all says the line only on a key pasted into Canopy (`reported.provider`, the provider
 * its process was launched on): for a key Codex holds itself, its session still says the old line.
 *
 * @param {{
 *   accounts: { named(engine: string, account: string | null): { id: string, label: string, kind: string } | null },
 *   load: () => Record<string, string> | null | undefined,     the account the last chat started on, by engine (state.json)
 *   save: (last: Record<string, string>) => unknown,
 * }} deps
 * @returns {(engine: string, account: string | null, reported?: { apiKeySource?: string | null, provider?: string | null }) => string | null}
 */
export function chatAccountLine({ accounts, load, save } = {}) {
  let billedSaid = false;
  const saved = () => { try { const v = load?.(); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
  return (engine, account, reported) => {
    try {
      const a = accounts.named(engine, account);
      if (!a) {
        const source = reported?.apiKeySource;
        if (billedSaid || (source !== 'ANTHROPIC_API_KEY' && source !== 'apiKeyHelper')) return null;
        billedSaid = true;
        return 'This conversation is billed to an API key, not your Claude plan.';
      }
      const all = saved();
      const last = typeof all[engine] === 'string' ? all[engine] : null;
      if (last === a.id) return null;
      try { save?.({ ...all, [engine]: a.id }); } catch { /* said again next time, at worst */ }
      const quietFirst = engine === 'codex' ? !reported?.provider : a.kind !== 'key' && a.kind !== 'external';
      if (last === null && quietFirst) return null;
      return `This chat uses ${a.label}.`;
    } catch { return null; }
  };
}
